import { getSupabaseAdmin } from "./supabaseAdmin";
import { getResendClient } from "./resend";
import { getSiteOrigin } from "./siteUrl";
import { GLOA_FROM_HELLO, GLOA_REPLY_TO_SUPPORT } from "./emailSenders";
import {
  buildCancellationConfirmationEmail,
  cancellationConfirmationIdempotencyKey,
} from "./email/cancellationConfirmation";
// The event key is not imported: it is only ever taken from the preflight
// result, so there is exactly one place that decides what this delivery is
// keyed on and no second caller can derive a key of its own.
import {
  evaluateCancellationConfirmationPreflight,
  CANCELLATION_CONFIRMATION_FAMILY,
  type CancellationConfirmationFacts,
  classifySubscriptionEmailProviderError,
  type SubscriptionEmailProviderOutcome,
} from "./subscriptionEmailDeliveryRules";

/**
 * Tells the customer their subscription cancellation is recorded, and when
 * the subscription ends (Phase 3H.3).
 *
 * The second of migration 035's three families, after
 * lib/subscriptionStartedEmail.ts.
 *
 * ── IT CONFIRMS. IT DOES NOT CANCEL. ──────────────────────────
 *
 * Nothing in this module schedules, applies, changes or undoes a
 * cancellation. It cannot: there is no Stripe import in this file, it
 * calls no RPC, and it writes to exactly one table. Migration 035 grants
 * service_role UPDATE on two columns of that table - status and sent_at -
 * so even the delivery identity it claims is beyond its reach. Every
 * cancellation write happens in lib/subscriptionCancellation.ts through
 * migration 034's SECURITY DEFINER functions, strictly before this runs.
 *
 * ══════════════════════════════════════════════════════════════
 * WHY THE EVENT KEY IS BOTH TIMESTAMPS AND WHY IT IS RE-READ.
 * ══════════════════════════════════════════════════════════════
 *
 * cancellation_effective_at is NOT immutable. Three live writers can move
 * it after the customer first cancels:
 *
 *   schedule_subscription_cancellation        writes the pair, and in its
 *                                             CASE C writes only
 *                                             cancellation_requested_at
 *                                             onto an effective date
 *                                             Stripe already had - which
 *                                             is a NEW pair even though it
 *                                             answers 'already_scheduled'.
 *   apply_deferred_subscription_cancellation  writes
 *                                             cancellation_effective_at =
 *                                             p_cancel_at when a deferred
 *                                             late cancellation is finally
 *                                             applied at the next paid
 *                                             renewal.
 *   sync_subscription_from_stripe             writes whatever Stripe now
 *                                             reports, and nulls BOTH
 *                                             columns on a genuine
 *                                             unscheduling.
 *
 * So a claim keyed on the subscription alone would be wrong twice over: it
 * would suppress the corrected date the customer needs, and it would
 * suppress a genuine second cancellation after an unscheduling. The key is
 * both persisted instants, and it is derived only from values RE-READ from
 * the row after the cancellation write committed - never from the schedule
 * the route calculated before calling the RPC, which is not reliably what
 * landed.
 *
 * ── THE CLAIM IS THE DATABASE'S ───────────────────────────────
 *
 * One INSERT with ON CONFLICT DO NOTHING against migration 035's
 * unique (subscription_id, family, event_key). No select-then-insert
 * decides the race; Postgres does. A default supabase-js upsert would emit
 * ON CONFLICT DO UPDATE, which needs UPDATE privilege on the columns it
 * sets, and migration 035 withholds that on subscription_id, family and
 * event_key precisely so that shape is refused by the database.
 *
 * ── IT NEVER THROWS. THAT IS BINDING HERE. ────────────────────
 *
 * The customer's cancellation is the durable action that matters. Once
 * lib/subscriptionCancellation.ts has scheduled it locally and at Stripe,
 * a mail provider failure must not turn the customer's cancellation into a
 * failure - not in the HTTP response they are waiting on, and not in the
 * webhook that applies a deferred cancellation. So every outcome is
 * returned as data and the cancellation state is untouched.
 *
 * ── AND 'failed' MEANS SOMETHING EXACT (Phase 3H.5B1) ─────────
 *
 * The delivery records 'failed' ONLY when non-acceptance is proven: a
 * refusal before the provider was contacted, or a numeric 4xx from Resend.
 * A lost connection, a timeout, a 5xx or an unrecognised error shape leave
 * the row at 'sending', because the message may already be in the
 * customer's inbox. 'failed' is the one status a future sweep may act on,
 * so it has to mean "safe to send again" and nothing looser.
 */

/** What the caller learns. Never a customer fact, never a provider message. */
export type CancellationConfirmationEmailResult =
  /** Resend accepted it and the row records 'sent'. */
  | "sent"
  /** No cancellation fact to confirm. Nothing was claimed and nothing written. */
  | "not-eligible"
  /** Already claimed by some attempt. NOT a claim that it was delivered. */
  | "already-claimed"
  /** The fact is gone or has moved. The row is terminal and Resend was not called. */
  | "superseded"
  /**
   * The provider was contacted and we CANNOT PROVE what happened.
   *
   * A lost connection, a timeout, a 5xx, an unrecognised error shape, or
   * acceptance whose state write did not land. The message may already be
   * in the customer's inbox, so the delivery stays 'sending' and no
   * automatic retry may resend it. See classifySubscriptionEmailProviderError.
   */
  | "ambiguous"
  /**
   * PROVEN not accepted by the provider, or refused before the provider
   * was ever contacted. The row records 'failed' and the fact stays owed.
   */
  | "failed";

/** The subscription columns one cancellation confirmation is rebuilt from. */
const SUBSCRIPTION_COLUMNS =
  "id, customer_type, status, customer_snapshot, " +
  "cancellation_requested_at, cancellation_effective_at";

type ClaimOutcome =
  | { kind: "claimed"; deliveryId: string }
  | { kind: "taken" }
  | { kind: "error" };

/** Reads back exactly the columns this message is built from. */
async function loadSubscription(
  subscriptionId: string
): Promise<{ ok: true; row: CancellationConfirmationFacts | null } | { ok: false }> {
  const admin = getSupabaseAdmin();
  if (!admin) return { ok: false };

  const { data, error } = await admin
    .from("subscriptions")
    .select(SUBSCRIPTION_COLUMNS)
    .eq("id", subscriptionId)
    .maybeSingle();

  if (error) {
    // GLOA uuid and the provider message only. No recipient, no name.
    console.error(`Cancellation confirmation: load failed for ${subscriptionId}:`, error.message);
    return { ok: false };
  }
  return { ok: true, row: (data as CancellationConfirmationFacts | null) ?? null };
}

/**
 * Atomically claims the right to confirm THIS cancellation.
 *
 * ON CONFLICT DO NOTHING against unique (subscription_id, family,
 * event_key). One row back means this caller won.
 *
 * ══════════════════════════════════════════════════════════════
 * ZERO ROWS BACK DOES NOT MEAN ALREADY SENT.
 * ══════════════════════════════════════════════════════════════
 *
 * The existing row may be 'sending', 'sent', 'failed' or 'superseded', and
 * three of those four mean the customer has NOT received the message. This
 * reports "taken" and the caller reports "already-claimed". In particular a
 * customer pressing cancel twice, which migration 034 answers
 * 'already_scheduled' with zero writes, produces the same key and is
 * correctly suppressed here rather than being called a delivery.
 *
 * Only the four columns migration 035 grants INSERT on are named. id,
 * created_at and updated_at take their database defaults, and sent_at is
 * omitted because a row is born 'sending', where the biconditional CHECK
 * requires it to be NULL.
 */
async function claimCancellationConfirmation(
  subscriptionId: string,
  eventKey: string
): Promise<ClaimOutcome> {
  const admin = getSupabaseAdmin();
  if (!admin) return { kind: "error" };

  const { data, error } = await admin
    .from("subscription_email_deliveries")
    .upsert(
      {
        subscription_id: subscriptionId,
        family: CANCELLATION_CONFIRMATION_FAMILY,
        event_key: eventKey,
        status: "sending",
      },
      {
        // The conflict target IS migration 035's unique constraint. Naming
        // it is load-bearing: without it PostgREST targets the primary key,
        // the constraint would raise 23505 instead, and the race guard
        // would become an error path rather than a decision.
        onConflict: "subscription_id,family,event_key",
        // ON CONFLICT DO NOTHING. Never DO UPDATE.
        ignoreDuplicates: true,
      }
    )
    .select("id");

  if (error) {
    console.error(`Cancellation confirmation: claim failed for ${subscriptionId}:`, error.message);
    return { kind: "error" };
  }

  const claimed = data?.[0]?.id as string | undefined;
  return claimed ? { kind: "claimed", deliveryId: claimed } : { kind: "taken" };
}

/**
 * Records that Resend accepted the message.
 *
 * Deliberately NOT conditional on the row still saying 'sending'. Provider
 * acceptance is already a fact, and suppressing the write would leave a row
 * a later sweep could pick up and send a second time.
 */
async function markSent(deliveryId: string): Promise<boolean> {
  const admin = getSupabaseAdmin();
  if (!admin) return false;
  const { error } = await admin
    .from("subscription_email_deliveries")
    .update({ status: "sent", sent_at: new Date().toISOString() })
    .eq("id", deliveryId);
  if (error) {
    console.error(`Cancellation confirmation: mark-sent failed for delivery ${deliveryId}:`, error.message);
    return false;
  }
  return true;
}

/**
 * Returns a claimed delivery to 'failed' - the one status a future sweep
 * may act on.
 *
 * CONDITIONAL ON STILL BEING 'sending'. Writing 'failed' over a 'sent' row
 * would invite the very duplicate this mechanism prevents.
 */
async function markFailed(deliveryId: string): Promise<void> {
  const admin = getSupabaseAdmin();
  if (!admin) return;
  const { error } = await admin
    .from("subscription_email_deliveries")
    .update({ status: "failed", sent_at: null })
    .eq("id", deliveryId)
    .eq("status", "sending");
  if (error) {
    console.error(`Cancellation confirmation: mark-failed failed for delivery ${deliveryId}:`, error.message);
  }
}

/**
 * Closes a claimed delivery whose cancellation is no longer current.
 *
 * This is the family the fourth status was designed for. A confirmation can
 * be claimed for effective date A, fail to send, and then the cancellation
 * is unscheduled or its date moves - leaving a row that must never be sent
 * and must not sit in a work list forever announcing a date that is no
 * longer true.
 *
 * GUARDED TO ('sending', 'failed'), never 'sent'. A message that genuinely
 * reached the customer is historical truth; the new fact gets its own row
 * with its own event key instead.
 */
async function markSuperseded(deliveryId: string): Promise<void> {
  const admin = getSupabaseAdmin();
  if (!admin) return;
  const { error } = await admin
    .from("subscription_email_deliveries")
    .update({ status: "superseded", sent_at: null })
    .eq("id", deliveryId)
    .in("status", ["sending", "failed"]);
  if (error) {
    console.error(`Cancellation confirmation: mark-superseded failed for delivery ${deliveryId}:`, error.message);
  }
}

/** Where the customer manages the subscription. Null without SITE_URL. */
function buildAccountSubscriptionsUrl(): string | null {
  const origin = getSiteOrigin();
  if (!origin) return null;
  return `${origin}/account/subscriptions`;
}

/**
 * Confirms one subscription's current cancellation, at most once per
 * persisted (requested_at, effective_at) pair.
 *
 * SAFE TO CALL WHENEVER A CANCELLATION FACT MIGHT HAVE CHANGED. It takes a
 * subscription id and nothing else, decides everything from the durable
 * row, and writes nothing at all when there is no cancellation to confirm.
 * That is what lets every writer in lib/subscriptionCancellation.ts call it
 * without any of them having to know whether the pair actually moved: an
 * unchanged pair produces the same event key and is stopped by the claim, a
 * cleared pair produces no key at all, and only a genuinely new pair
 * reaches the provider.
 *
 * There is NO recipient parameter. The address is read from the
 * subscription's own frozen customer_snapshot at send time, so a
 * browser-supplied, query-string or Stripe-payload address has nowhere to
 * enter.
 */
export async function sendCancellationConfirmationEmailIfNeeded(
  subscriptionId: string
): Promise<CancellationConfirmationEmailResult> {
  if (!subscriptionId) return "not-eligible";

  const admin = getSupabaseAdmin();
  if (!admin) {
    console.error("Cancellation confirmation: SUPABASE_SECRET_KEY is not configured.");
    return "failed";
  }

  // READ ONE. Decides whether anything is owed, and derives the key. This
  // happens before the claim because the key IS the persisted pair - there
  // is nothing to claim until the row has been read.
  const first = await loadSubscription(subscriptionId);
  if (!first.ok) return "failed";

  const eligibility = evaluateCancellationConfirmationPreflight({
    subscription: first.row,
    expectedEventKey: null,
  });

  // Nothing owed: never cancelled, already unscheduled, already ended, or
  // nothing to send it to. No row is created, so a subscription that was
  // never cancelled leaves no trace in the delivery table at all.
  if (eligibility.kind !== "send") {
    return eligibility.kind === "failed" ? "failed" : "not-eligible";
  }

  const eventKey = eligibility.eventKey;

  const claim = await claimCancellationConfirmation(subscriptionId, eventKey);
  if (claim.kind === "error") return "failed";
  if (claim.kind === "taken") return "already-claimed";

  return deliverClaimedCancellationConfirmation(subscriptionId, eventKey, claim.deliveryId);
}

/**
 * Renders and sends a confirmation whose claim has ALREADY been won, and
 * records the outcome on the delivery row.
 *
 * Split out so the retry sweep a later phase will build reuses this exact
 * preflight, this exact send and these exact state writes. Such a sweep
 * must bring its own, stricter claim - 'failed' only - and pass the event
 * key off the row it selected, which is what makes the supersession check
 * below meaningful for a retry rather than only for a live send.
 */
async function deliverClaimedCancellationConfirmation(
  subscriptionId: string,
  eventKey: string,
  deliveryId: string
): Promise<CancellationConfirmationEmailResult> {
  // READ TWO, AND THIS IS THE AUTHORITATIVE ONE. Re-read after the claim so
  // the facts that reach the customer are the ones true at send time. For a
  // live send this usually confirms what read one saw; for a retry minutes
  // or days later it is the whole point.
  const second = await loadSubscription(subscriptionId);
  if (!second.ok) {
    await markFailed(deliveryId);
    return "failed";
  }

  const preflight = evaluateCancellationConfirmationPreflight({
    subscription: second.row,
    // Pinned to the event this row was claimed for. A pair that has moved
    // since - or been cleared entirely - can no longer be described by this
    // delivery.
    expectedEventKey: eventKey,
  });

  if (preflight.kind === "superseded") {
    console.error(
      `Cancellation confirmation: superseded for ${subscriptionId} - ${preflight.reason}`
    );
    await markSuperseded(deliveryId);
    return "superseded";
  }

  if (preflight.kind === "not-eligible" || preflight.kind === "failed") {
    console.error(
      `Cancellation confirmation: preflight refused ${subscriptionId} - ${preflight.reason}`
    );
    await markFailed(deliveryId);
    return "failed";
  }

  const resend = getResendClient();
  if (!resend) {
    console.error("Cancellation confirmation: RESEND_API_KEY is not configured.");
    await markFailed(deliveryId);
    return "failed";
  }

  const { subject, html, text } = buildCancellationConfirmationEmail({
    cancellation: {
      // Straight from the event this delivery represents, so a retry
      // renders the same two dates the first attempt would have.
      requestedAtIso: preflight.content.requestedAtIso,
      effectiveAtIso: preflight.content.effectiveAtIso,
      accountSubscriptionsUrl: buildAccountSubscriptionsUrl(),
    },
  });

  // Keyed on the same value the delivery row's event_key carries, so the
  // provider guard and the database guard cannot disagree about which
  // cancellation this is.
  const idempotencyKey = cancellationConfirmationIdempotencyKey(subscriptionId, eventKey);

  // 'accepted' until the provider says otherwise. The two failure values
  // are the classifier's, and they are NOT interchangeable.
  let outcome: SubscriptionEmailProviderOutcome | "accepted" = "accepted";
  let sendErrorMessage: string | null = null;
  try {
    const { error: sendError } = await resend.emails.send(
      {
        // The established customer transactional convention: the brand
        // voice sends, support takes replies.
        from: GLOA_FROM_HELLO,
        to: preflight.recipient,
        replyTo: GLOA_REPLY_TO_SUPPORT,
        subject,
        html,
        text,
      },
      { idempotencyKey }
    );
    if (sendError) {
      // statusCode is the whole discriminator: a number means Resend
      // answered, null means fetch itself threw and the request may still
      // have landed.
      outcome = classifySubscriptionEmailProviderError(sendError);
      sendErrorMessage = sendError.message;
    }
  } catch (err) {
    // A throw around the call proves nothing about acceptance. The SDK
    // catches its own transport failures, so reaching here at all means
    // something unanticipated happened - which is the least safe moment
    // to guess.
    outcome = "ambiguous";
    sendErrorMessage = err instanceof Error ? err.message : "unknown error";
  }

  // ── AMBIGUOUS: THE ROW STAYS 'sending' ──────────────────────
  //
  // Nothing is written. 'failed' would be a lie we could not take back:
  // it is the one status a retry sweep may act on, and re-sending a
  // message the provider may already have delivered is precisely the
  // duplicate this phase exists to prevent.
  //
  // The row is left for a human. A later phase reports stale 'sending'
  // rows; it must never resend them.
  if (outcome === "ambiguous") {
    // Delivery uuid, family and the provider's short message. No
    // recipient, no name, no customer data.
    console.error(
      `Cancellation confirmation: AMBIGUOUS provider outcome for delivery ${deliveryId} (${CANCELLATION_CONFIRMATION_FAMILY}) - left sending:`,
      sendErrorMessage
    );
    return "ambiguous";
  }

  // ── PROVEN REFUSED: THE ROW MAY RECORD 'failed' ─────────────
  //
  // A 4xx means Resend answered and declined. No message exists, and none
  // can appear later from this attempt, so a future retry cannot duplicate
  // anything.
  if (outcome === "definite_failure") {
    console.error(
      `Cancellation confirmation: send rejected for delivery ${deliveryId} (${CANCELLATION_CONFIRMATION_FAMILY}):`,
      sendErrorMessage
    );
    await markFailed(deliveryId);
    return "failed";
  }

  // ── ACCEPTED ────────────────────────────────────────────────
  //
  // If the durable write does not land, the message is still out there.
  // That is ambiguous, NOT failed, and the row stays 'sending'.
  if (!(await markSent(deliveryId))) {
    console.error(
      `Cancellation confirmation: provider accepted but the sent state did not persist for delivery ${deliveryId} (${CANCELLATION_CONFIRMATION_FAMILY}) - left sending.`
    );
    return "ambiguous";
  }
  return "sent";
}
