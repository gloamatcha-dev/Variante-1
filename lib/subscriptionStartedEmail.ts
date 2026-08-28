import { getSupabaseAdmin } from "./supabaseAdmin";
import { getResendClient } from "./resend";
import { getSiteOrigin } from "./siteUrl";
import { GLOA_FROM_HELLO, GLOA_REPLY_TO_SUPPORT } from "./emailSenders";
import {
  buildSubscriptionStartedEmail,
  subscriptionStartedIdempotencyKey,
} from "./email/subscriptionStarted";
import {
  evaluateSubscriptionStartPreflight,
  isSubscriptionStartInvoice,
  subscriptionStartedEventKey,
  SUBSCRIPTION_STARTED_FAMILY,
  type SubscriptionItemFacts,
  type SubscriptionStartFacts,
} from "./subscriptionEmailDeliveryRules";

/**
 * Tells the customer their subscription has started (Phase 3H.2).
 *
 * The first customer-facing message a B2C subscription has ever produced,
 * and the first user of public.subscription_email_deliveries - the
 * server-only table migration 035 created and left empty.
 *
 * ── IT SENDS. IT CHANGES NO SUBSCRIPTION AND NO ORDER. ────────
 *
 * Nothing in this module activates, cancels, prices or ships anything.
 * It cannot: there is no Stripe import in this file, it writes to exactly
 * one table, and migration 035 grants service_role UPDATE on precisely two
 * columns of it - status and sent_at. subscription_id, family and
 * event_key are INSERT-ONLY, and id, created_at and updated_at are
 * writable by nobody. The delivery identity this module claims is one it
 * could not edit even if it tried, which is the property that matters
 * most: a bug in an email module must never be able to restate which
 * message was owed to whom.
 *
 * ── EVERY FACT COMES FROM THE ROW ─────────────────────────────
 *
 * The entry point takes a subscription id and a billing reason. The
 * recipient, the package, the quantity and the cadence are all read back
 * from the durable subscription at send time. Nothing from the Stripe
 * webhook payload reaches the message, and there is deliberately NO
 * recipient parameter, so a caller cannot point this at an arbitrary
 * inbox - the same shape as the three other customer senders.
 *
 * ── THE CLAIM IS THE DATABASE'S, NOT THIS FILE'S ──────────────
 *
 * The first claim is one INSERT with ON CONFLICT DO NOTHING against
 * migration 035's unique (subscription_id, family, event_key). There is no
 * select-then-insert anywhere in this module: two workers racing on the
 * same subscription both issue the same INSERT and Postgres decides, which
 * is the same statement migration 009 makes about stripe_webhook_events
 * and migration 035 repeats about this table.
 *
 * The upsert-with-ignoreDuplicates shape below is the one PostgREST turns
 * into ON CONFLICT DO NOTHING, and it is already the established mechanism
 * in this repository - lib/checkoutAttempts.ts claims a checkout attempt
 * exactly this way. A DEFAULT supabase-js upsert would emit ON CONFLICT DO
 * UPDATE instead, which needs UPDATE privilege on every column it sets;
 * migration 035 withholds UPDATE on subscription_id, family and event_key
 * precisely so that shape is refused by the database rather than by a
 * comment.
 *
 * ── IT NEVER THROWS, AND THAT IS A REASONED DEPARTURE ─────────
 *
 * lib/orderConfirmationEmail.ts and lib/internalOrderNotificationEmail.ts
 * both THROW on a send failure, so the Stripe webhook returns 500, the
 * event is never recorded, and Stripe's redelivery becomes the email's
 * retry schedule. That pattern is correct for them and would be actively
 * harmful here, for three separate reasons:
 *
 *   1. THE REDELIVERY COULD NOT RE-ATTEMPT THE SEND. A failed attempt
 *      leaves a delivery row at 'failed'. The redelivery re-issues the
 *      same first claim, hits the unique constraint, and gets zero rows
 *      back - ALREADY CLAIMED. Re-attempting a 'failed' row needs the
 *      status-guarded UPDATE claim, which Phase 3H.2 deliberately does not
 *      wire. So the 500 would buy nothing at all.
 *
 *   2. IT WOULD DELAY A MANDATORY POST-PAYMENT ACTION. This send sits
 *      immediately before applyDeferredCancellationFromRenewal in the
 *      webhook, which Phase 3C.3 made mandatory precisely because failing
 *      to apply a deferred cancellation charges the customer again 28 days
 *      later. Throwing here would skip it on this delivery and hand a
 *      money-affecting action to a retry schedule for the sake of an
 *      email that cannot be retried that way.
 *
 *   3. IT WOULD RE-RUN THE WHOLE PAID-INVOICE CHAIN. Activation, order
 *      creation and the paid-period record are all idempotent, so the
 *      retries would be harmless - and pointless.
 *
 * So the outcome is returned as data, the delivery row records 'failed',
 * and the order, the payment evidence and the cancellation work are all
 * untouched. 'failed' is the one status a future sweep may key on, which
 * is exactly the durable retry state migration 035 was built to hold.
 */

/** What the caller learns. Never a customer fact, never a provider message. */
export type SubscriptionStartedEmailResult =
  /** Resend accepted it and the row records 'sent'. */
  | "sent"
  /** Not this invoice's business, or a claim somebody else already holds. */
  | "not-eligible"
  /** Already claimed by some attempt. NOT a claim that it was delivered. */
  | "already-claimed"
  /** The lifecycle fact is gone. The row is terminal and Resend was not called. */
  | "superseded"
  /** Attempted and failed. The row records 'failed' and the fact stays owed. */
  | "failed";

/** The subscription columns one start message is rebuilt from. */
const SUBSCRIPTION_COLUMNS = "id, customer_type, status, customer_snapshot, plan_snapshot";

type ClaimOutcome =
  | { kind: "claimed"; deliveryId: string }
  | { kind: "taken" }
  | { kind: "error" };

/**
 * Atomically claims the right to send this subscription's start message.
 *
 * ON CONFLICT DO NOTHING against unique (subscription_id, family,
 * event_key). One row back means this caller won and is the only one that
 * may send. Zero rows back means ALREADY CLAIMED.
 *
 * ══════════════════════════════════════════════════════════════
 * ZERO ROWS BACK DOES NOT MEAN ALREADY SENT.
 * ══════════════════════════════════════════════════════════════
 *
 * The existing row may be in any of migration 035's four states -
 * 'sending', 'sent', 'failed' or 'superseded' - and three of them mean the
 * customer has NOT received the message. This function therefore reports
 * "taken", and the caller reports "already-claimed". Nothing here calls it
 * "already sent", and nothing may: only the row's own status proves that,
 * and re-attempting a claimed row is the later retry phase's job under a
 * stricter, status-guarded claim.
 *
 * Only the four columns migration 035 grants INSERT on are named. id,
 * created_at and updated_at are left to their database defaults - a
 * column-scoped INSERT still applies the default of every column it does
 * not name - and sent_at is omitted because a row is born 'sending', where
 * the biconditional CHECK requires it to be NULL.
 */
async function claimSubscriptionStartedDelivery(
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
        family: SUBSCRIPTION_STARTED_FAMILY,
        event_key: eventKey,
        status: "sending",
      },
      {
        // The conflict target IS migration 035's unique constraint. Naming
        // it is load-bearing: without it PostgREST targets the primary key
        // instead, the constraint below would raise 23505, and the race
        // guard would become an error path rather than a decision.
        onConflict: "subscription_id,family,event_key",
        // ON CONFLICT DO NOTHING. Never DO UPDATE - see the note above the
        // module: the identity columns are not updatable by design.
        ignoreDuplicates: true,
      }
    )
    .select("id");

  if (error) {
    // Subscription uuid and the provider message only. No recipient, no
    // name, no plan.
    console.error(`Subscription started email: claim failed for ${subscriptionId}:`, error.message);
    return { kind: "error" };
  }

  const claimed = data?.[0]?.id as string | undefined;
  return claimed ? { kind: "claimed", deliveryId: claimed } : { kind: "taken" };
}

/**
 * Records that Resend accepted the message.
 *
 * Deliberately NOT conditional on the row still saying 'sending'.
 * Provider acceptance is already a fact by the time this runs, and
 * suppressing the write would leave a row that a later sweep could pick up
 * and send a second time. Migration 035 says the same thing about this
 * exact statement: failing to record 'sent' after acceptance risks a
 * duplicate, so the write is unconditional.
 *
 * status and sent_at are the only two columns named, which is also the
 * only two migration 035 grants UPDATE on. updated_at is stamped by the
 * trigger rather than written here.
 */
async function markSent(deliveryId: string): Promise<void> {
  const admin = getSupabaseAdmin();
  if (!admin) return;
  const { error } = await admin
    .from("subscription_email_deliveries")
    .update({ status: "sent", sent_at: new Date().toISOString() })
    .eq("id", deliveryId);
  if (error) {
    console.error(`Subscription started email: mark-sent failed for delivery ${deliveryId}:`, error.message);
  }
}

/**
 * Returns a claimed delivery to 'failed' - the one status a future sweep
 * may act on.
 *
 * CONDITIONAL ON STILL BEING 'sending', for the reason every other
 * sender's mark-failed is: writing 'failed' over a 'sent' row would invite
 * the very duplicate this mechanism exists to prevent. Migration 035
 * states the same guard.
 *
 * sent_at is written back to null explicitly. The biconditional CHECK
 * requires it, and a row that said 'failed' while carrying a send time
 * would read as delivered to anyone looking at it later.
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
    console.error(`Subscription started email: mark-failed failed for delivery ${deliveryId}:`, error.message);
  }
}

/**
 * Closes a claimed delivery that must never be sent.
 *
 * Reached only when the preflight proves the lifecycle fact is gone - at
 * launch, a subscription that is terminally cancelled by the time this
 * runs. The message was never sent and never will be, and leaving the row
 * 'failed' would re-offer a false "your subscription is active" to every
 * future sweep for the rest of the system's life.
 *
 * GUARDED TO ('sending', 'failed'), never 'sent'. A message that genuinely
 * reached the customer is historical truth and is not rewritten because
 * the world moved on afterwards - migration 035 is explicit that
 * sent -> superseded must never happen.
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
    console.error(`Subscription started email: mark-superseded failed for delivery ${deliveryId}:`, error.message);
  }
}

/** Where the customer manages the subscription. Null without SITE_URL. */
function buildAccountSubscriptionsUrl(): string | null {
  const origin = getSiteOrigin();
  if (!origin) return null;
  return `${origin}/account/subscriptions`;
}

/**
 * Sends the subscription start message for one subscription, at most once,
 * if and only if this paid invoice is the one that started it.
 *
 * MUST be called strictly AFTER the durable order for the first cycle
 * exists and after the internal fulfillment notification has been
 * attempted, and strictly BEFORE the deferred-cancellation step - which is
 * where lib/../webhook/route.ts calls it. It re-reads the subscription for
 * itself rather than trusting anything the caller learned, so calling it
 * too early cannot produce a message about a subscription that is not
 * running: the preflight would refuse.
 *
 * ONLY subscription_create. A renewal is subscription_cycle and returns
 * "not-eligible" without touching the database. The gate lives here, in
 * the tested unit, rather than only at the call site, so it cannot be
 * bypassed by a second caller later.
 */
export async function sendSubscriptionStartedEmailIfNeeded(input: {
  subscriptionId: string;
  billingReason: string | null;
}): Promise<SubscriptionStartedEmailResult> {
  const { subscriptionId, billingReason } = input;

  // A renewal is not a start. No claim, no read, no write.
  if (!isSubscriptionStartInvoice(billingReason)) return "not-eligible";

  const eventKey = subscriptionStartedEventKey(subscriptionId);
  if (!eventKey) return "not-eligible";

  const admin = getSupabaseAdmin();
  if (!admin) {
    console.error("Subscription started email: SUPABASE_SECRET_KEY is not configured.");
    return "failed";
  }

  // THE CLAIM COMES FIRST, before the subscription is read and before any
  // content is built. Winning it is what makes this caller the only one
  // that may contact the provider, so nothing expensive or observable
  // happens ahead of it.
  const claim = await claimSubscriptionStartedDelivery(subscriptionId, eventKey);
  if (claim.kind === "error") return "failed";
  if (claim.kind === "taken") return "already-claimed";

  return deliverClaimedSubscriptionStarted(subscriptionId, claim.deliveryId);
}

/**
 * Renders and sends a start message whose claim has ALREADY been won, and
 * records the outcome on the delivery row.
 *
 * Split out so the retry sweep a later phase will build reuses this exact
 * preflight, this exact send and these exact state writes rather than
 * growing a second copy for the recipient, the template and the cadence to
 * drift apart in. Such a sweep must bring its own, stricter claim -
 * 'failed' only, never 'sending', never 'sent' and never 'superseded'.
 */
async function deliverClaimedSubscriptionStarted(
  subscriptionId: string,
  deliveryId: string
): Promise<SubscriptionStartedEmailResult> {
  const admin = getSupabaseAdmin();
  if (!admin) {
    await markFailed(deliveryId);
    return "failed";
  }

  // THE PREFLIGHT READ. Re-read after the claim, so the facts that reach
  // the message are the ones true at send time rather than at claim time.
  const { data, error } = await admin
    .from("subscriptions")
    .select(SUBSCRIPTION_COLUMNS)
    .eq("id", subscriptionId)
    .maybeSingle();

  if (error) {
    console.error(`Subscription started email: load failed for ${subscriptionId}:`, error.message);
    await markFailed(deliveryId);
    return "failed";
  }

  const { data: itemData, error: itemError } = await admin
    .from("subscription_items")
    .select("sku, quantity")
    .eq("subscription_id", subscriptionId);

  if (itemError) {
    console.error(`Subscription started email: item load failed for ${subscriptionId}:`, itemError.message);
    await markFailed(deliveryId);
    return "failed";
  }

  const preflight = evaluateSubscriptionStartPreflight({
    subscription: (data as SubscriptionStartFacts | null) ?? null,
    items: (itemData as SubscriptionItemFacts[] | null) ?? [],
  });

  // THE LIFECYCLE FACT IS GONE. Resend is never contacted, and the row
  // leaves the work list permanently.
  if (preflight.kind === "superseded") {
    console.error(
      `Subscription started email: superseded for ${subscriptionId} - ${preflight.reason}`
    );
    await markSuperseded(deliveryId);
    return "superseded";
  }

  if (preflight.kind === "failed") {
    // Subscription uuid and a reason built from column values only. No
    // recipient, no name, no address.
    console.error(
      `Subscription started email: preflight refused ${subscriptionId} - ${preflight.reason}`
    );
    await markFailed(deliveryId);
    return "failed";
  }

  const resend = getResendClient();
  if (!resend) {
    console.error("Subscription started email: RESEND_API_KEY is not configured.");
    await markFailed(deliveryId);
    return "failed";
  }

  const { subject, html, text } = buildSubscriptionStartedEmail({
    subscription: {
      packageName: preflight.content.packageName,
      quantity: preflight.content.quantity,
      cadenceWeeks: preflight.content.cadenceWeeks,
      accountSubscriptionsUrl: buildAccountSubscriptionsUrl(),
    },
  });

  // The provider-side half of the duplicate guard, keyed on the same value
  // the delivery row's event_key carries, so a webhook redelivery whose
  // state write was lost still cannot become a second inbox message.
  const idempotencyKey = subscriptionStartedIdempotencyKey(subscriptionId);

  let sendErrorMessage: string | null = null;
  try {
    const { error: sendError } = await resend.emails.send(
      {
        // The established customer transactional convention: the brand
        // voice sends, support takes replies. Identical to the order
        // confirmation, the shipment confirmation, the cancellation
        // outcome and the refund confirmation.
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
    // recipient - a failed send is not a reason to put a customer's
    // address into a log line.
    console.error(`Subscription started email: send failed for ${subscriptionId}:`, sendErrorMessage);
    await markFailed(deliveryId);
    return "failed";
  }

  await markSent(deliveryId);
  return "sent";
}
