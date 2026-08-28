import { getSupabaseAdmin } from "./supabaseAdmin";
import { getResendClient } from "./resend";
import { getSiteOrigin } from "./siteUrl";
import { GLOA_FROM_HELLO, GLOA_REPLY_TO_SUPPORT } from "./emailSenders";
import {
  buildSubscriptionEndedEmail,
  subscriptionEndedIdempotencyKey,
} from "./email/subscriptionEnded";
import {
  evaluateSubscriptionEndedPreflight,
  subscriptionEndedEventKey,
  SUBSCRIPTION_ENDED_FAMILY,
  type SubscriptionEndedFacts,
} from "./subscriptionEmailDeliveryRules";

/**
 * Tells the customer their subscription has ended (Phase 3H.4).
 *
 * The third and last of migration 035's families, after
 * lib/subscriptionStartedEmail.ts and lib/cancellationConfirmationEmail.ts.
 *
 * ── IT REPORTS. IT DOES NOT TERMINATE. ────────────────────────
 *
 * Nothing here cancels, ends, reactivates or alters a subscription. It
 * cannot: there is no Stripe import in this file, it calls no RPC, and it
 * writes to exactly one table. The only writer of status = 'cancelled' is
 * migration 034's mark_subscription_cancelled, driven by
 * customer.subscription.deleted, and it runs strictly before this does.
 *
 * ══════════════════════════════════════════════════════════════
 * THE CRASH WINDOW IS WHY BOTH TERMINATION RESULTS SEND.
 * ══════════════════════════════════════════════════════════════
 *
 * mark_subscription_cancelled answers 'cancelled' on the first
 * transition and 'already_cancelled' on every later one. Consider:
 *
 *   1. customer.subscription.deleted arrives
 *   2. the local row is durably marked cancelled
 *   3. the process dies before this sender claims anything
 *   4. Stripe redelivers the deletion
 *
 * On step 4 the RPC answers 'already_cancelled', because step 2 genuinely
 * happened. If the sender were gated on the first-transition result
 * alone, the customer would never be told - the one delivery that could
 * have told them is the one that crashed.
 *
 * So BOTH results reach this sender, and the duplicate suppression is the
 * database's job rather than the result word's. That is exactly what
 * migration 035's unique constraint is for: the second call re-issues the
 * same claim, loses it, and sends nothing. 'not_found', 'error' and
 * anything unrecognised prove nothing and must not reach it.
 *
 * ── THE EVENT KEY IS THE SUBSCRIPTION ID, AND THAT IS PROVEN ──
 *
 * 'cancelled' is terminal for a local row, the row can never be
 * reactivated, and it can never be attached to a replacement Stripe
 * subscription. The full argument, with the two migrations it rests on,
 * is on subscriptionEndedEventKey in lib/subscriptionEmailDeliveryRules.ts.
 *
 * ── IT NEVER THROWS ───────────────────────────────────────────
 *
 * The termination is already durable by the time this runs, and
 * handleSubscriptionDeleted has never thrown. A throw here would turn the
 * webhook into a 500 and buy nothing: the redelivery would find the
 * delivery row already claimed and could not re-attempt the send, because
 * re-attempting a 'failed' row needs the status-guarded claim a later
 * phase will build. It would also risk the deletion never being recorded
 * as processed, for the sake of an email.
 *
 * So the outcome is returned as data, the delivery row records 'failed',
 * and the subscription's terminal state, its cancelled_at and every order
 * it produced are untouched.
 */

/** What the caller learns. Never a customer fact, never a provider message. */
export type SubscriptionEndedEmailResult =
  /** Resend accepted it and the row records 'sent'. */
  | "sent"
  /** Not a terminated subscription, or nothing to send it to. Nothing written. */
  | "not-eligible"
  /** Already claimed by some attempt. NOT a claim that it was delivered. */
  | "already-claimed"
  /** The ending is not current after all. Terminal, and Resend was not called. */
  | "superseded"
  /** Attempted and failed. The row records 'failed' and the fact stays owed. */
  | "failed";

/**
 * The subscription columns one ending message is rebuilt from.
 *
 * started_at proves it ran; cancelled_at is the only durable instant that
 * describes the ending itself. cancellation_effective_at is deliberately
 * NOT read: it is a promise written by two other functions, not the
 * event.
 */
const SUBSCRIPTION_COLUMNS =
  "id, customer_type, status, customer_snapshot, started_at, cancelled_at";

type ClaimOutcome =
  | { kind: "claimed"; deliveryId: string }
  | { kind: "taken" }
  | { kind: "error" };

/** Reads back exactly the columns this message is built from. */
async function loadSubscription(
  subscriptionId: string
): Promise<{ ok: true; row: SubscriptionEndedFacts | null } | { ok: false }> {
  const admin = getSupabaseAdmin();
  if (!admin) return { ok: false };

  const { data, error } = await admin
    .from("subscriptions")
    .select(SUBSCRIPTION_COLUMNS)
    .eq("id", subscriptionId)
    .maybeSingle();

  if (error) {
    console.error(`Subscription ended email: load failed for ${subscriptionId}:`, error.message);
    return { ok: false };
  }
  return { ok: true, row: (data as SubscriptionEndedFacts | null) ?? null };
}

/**
 * Atomically claims the right to announce this subscription's ending.
 *
 * ON CONFLICT DO NOTHING against migration 035's unique
 * (subscription_id, family, event_key). One row back means this caller
 * won and is the only one that may send.
 *
 * ══════════════════════════════════════════════════════════════
 * ZERO ROWS BACK DOES NOT MEAN ALREADY SENT.
 * ══════════════════════════════════════════════════════════════
 *
 * The existing row may be 'sending', 'sent', 'failed' or 'superseded',
 * and three of those four mean the customer has NOT been written to. This
 * reports "taken" and the caller reports "already-claimed". For the
 * canonical deleted-event path that is where it stops: a redelivered
 * deletion must not contact the provider a second time, and re-attempting
 * a 'failed' row belongs to the retry phase under a stricter claim.
 *
 * Only the four columns migration 035 grants INSERT on are named. id,
 * created_at and updated_at take their database defaults, and sent_at is
 * omitted because a row is born 'sending', where the biconditional CHECK
 * requires it to be NULL.
 */
async function claimSubscriptionEnded(
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
        family: SUBSCRIPTION_ENDED_FAMILY,
        event_key: eventKey,
        status: "sending",
      },
      {
        // The conflict target IS migration 035's unique constraint.
        // Without it PostgREST targets the primary key, the constraint
        // raises 23505 instead, and the race guard becomes an error path.
        onConflict: "subscription_id,family,event_key",
        // ON CONFLICT DO NOTHING. Never DO UPDATE: the identity columns
        // are not updatable, by design.
        ignoreDuplicates: true,
      }
    )
    .select("id");

  if (error) {
    console.error(`Subscription ended email: claim failed for ${subscriptionId}:`, error.message);
    return { kind: "error" };
  }

  const claimed = data?.[0]?.id as string | undefined;
  return claimed ? { kind: "claimed", deliveryId: claimed } : { kind: "taken" };
}

/**
 * Records that Resend accepted the message.
 *
 * Deliberately NOT conditional on the row still saying 'sending'.
 * Provider acceptance is already a fact, and suppressing the write would
 * leave a row a later sweep could pick up and send a second time.
 */
async function markSent(deliveryId: string): Promise<void> {
  const admin = getSupabaseAdmin();
  if (!admin) return;
  const { error } = await admin
    .from("subscription_email_deliveries")
    .update({ status: "sent", sent_at: new Date().toISOString() })
    .eq("id", deliveryId);
  if (error) {
    console.error(`Subscription ended email: mark-sent failed for delivery ${deliveryId}:`, error.message);
  }
}

/**
 * Returns a claimed delivery to 'failed' - the one status a future sweep
 * may act on.
 *
 * CONDITIONAL ON STILL BEING 'sending'. Writing 'failed' over a 'sent'
 * row would invite the very duplicate this mechanism prevents.
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
    console.error(`Subscription ended email: mark-failed failed for delivery ${deliveryId}:`, error.message);
  }
}

/**
 * Closes a claimed delivery whose ending is no longer true.
 *
 * UNREACHABLE UNDER THE SUPPORTED LIFECYCLE, and deliberately implemented
 * anyway. 'cancelled' is terminal: activate_subscription_from_invoice
 * refuses any status outside pending/active/past_due/unpaid and raises,
 * so nothing can move a row back out of it. This branch exists so that a
 * future phase which did introduce a reactivation would close a
 * claimed-but-unsent ending instead of mailing a customer that a running
 * subscription had finished.
 *
 * GUARDED TO ('sending', 'failed'), never 'sent'. A message that reached
 * the customer is historical truth.
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
    console.error(`Subscription ended email: mark-superseded failed for delivery ${deliveryId}:`, error.message);
  }
}

/** Where past orders live. Null without SITE_URL. */
function buildAccountUrl(): string | null {
  const origin = getSiteOrigin();
  if (!origin) return null;
  return `${origin}/account/orders`;
}

/**
 * Announces one subscription's ending, at most once.
 *
 * SAFE TO CALL ON EVERY DELIVERY OF customer.subscription.deleted,
 * including redeliveries, and that is the point: it takes a subscription
 * id and nothing else, decides everything from the durable row, and
 * writes nothing at all unless the row is genuinely, terminally
 * cancelled. The duplicate guard is the unique constraint rather than the
 * caller's knowledge of whether this delivery was the first.
 *
 * There is NO recipient parameter. The address is read from the
 * subscription's own frozen customer_snapshot, so a Stripe customer
 * object, a webhook payload, a browser or a query string all have nowhere
 * to enter.
 */
export async function sendSubscriptionEndedEmailIfNeeded(
  subscriptionId: string
): Promise<SubscriptionEndedEmailResult> {
  if (!subscriptionId) return "not-eligible";

  const eventKey = subscriptionEndedEventKey(subscriptionId);
  if (!eventKey) return "not-eligible";

  const admin = getSupabaseAdmin();
  if (!admin) {
    console.error("Subscription ended email: SUPABASE_SECRET_KEY is not configured.");
    return "failed";
  }

  // READ ONE. Decides whether anything is owed, before any row exists to
  // record an outcome against. A subscription that is not terminally
  // cancelled leaves no trace in the delivery table at all.
  const first = await loadSubscription(subscriptionId);
  if (!first.ok) return "failed";

  const eligibility = evaluateSubscriptionEndedPreflight({
    subscription: first.row,
    claimed: false,
  });
  if (eligibility.kind !== "send") {
    return eligibility.kind === "failed" ? "failed" : "not-eligible";
  }

  const claim = await claimSubscriptionEnded(subscriptionId, eventKey);
  if (claim.kind === "error") return "failed";
  if (claim.kind === "taken") return "already-claimed";

  return deliverClaimedSubscriptionEnded(subscriptionId, claim.deliveryId);
}

/**
 * Renders and sends an ending whose claim has ALREADY been won, and
 * records the outcome on the delivery row.
 *
 * Split out so the retry sweep a later phase will build reuses this exact
 * preflight, this exact send and these exact state writes rather than
 * growing a second copy for the recipient, the date and the copy to drift
 * apart in. Such a sweep must bring its own, stricter claim - 'failed'
 * only, never 'sending', 'sent' or 'superseded'.
 */
async function deliverClaimedSubscriptionEnded(
  subscriptionId: string,
  deliveryId: string
): Promise<SubscriptionEndedEmailResult> {
  // READ TWO, AND THIS IS THE AUTHORITATIVE ONE. Re-read after the claim
  // so the facts that reach the customer are the ones true at send time.
  const second = await loadSubscription(subscriptionId);
  if (!second.ok) {
    await markFailed(deliveryId);
    return "failed";
  }

  const preflight = evaluateSubscriptionEndedPreflight({
    subscription: second.row,
    claimed: true,
  });

  if (preflight.kind === "superseded") {
    console.error(
      `Subscription ended email: superseded for ${subscriptionId} - ${preflight.reason}`
    );
    await markSuperseded(deliveryId);
    return "superseded";
  }

  if (preflight.kind === "not-eligible" || preflight.kind === "failed") {
    console.error(
      `Subscription ended email: preflight refused ${subscriptionId} - ${preflight.reason}`
    );
    await markFailed(deliveryId);
    return "failed";
  }

  const resend = getResendClient();
  if (!resend) {
    console.error("Subscription ended email: RESEND_API_KEY is not configured.");
    await markFailed(deliveryId);
    return "failed";
  }

  const { subject, html, text } = buildSubscriptionEndedEmail({
    subscription: {
      // The one durable instant that describes the ending. Written once
      // by migration 034 and never moved, so a retry renders the same
      // date the first attempt would have.
      endedAtIso: preflight.content.endedAtIso,
      accountUrl: buildAccountUrl(),
    },
  });

  // Stable across every redelivery of the deletion and every retry of
  // this row, because it is keyed on the subscription rather than on the
  // Stripe event that happened to carry the news.
  const idempotencyKey = subscriptionEndedIdempotencyKey(subscriptionId);

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
    if (sendError) sendErrorMessage = sendError.message;
  } catch (err) {
    sendErrorMessage = err instanceof Error ? err.message : "unknown error";
  }

  if (sendErrorMessage) {
    // The subscription uuid and the provider's message. Never the
    // recipient and never anything a customer could see.
    console.error(`Subscription ended email: send failed for ${subscriptionId}:`, sendErrorMessage);
    await markFailed(deliveryId);
    return "failed";
  }

  await markSent(deliveryId);
  return "sent";
}
