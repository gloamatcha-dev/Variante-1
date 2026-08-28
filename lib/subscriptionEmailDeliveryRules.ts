/**
 * The rules behind public.subscription_email_deliveries (Phase 3H.2).
 *
 * Pure, and a LEAF: no database, no Stripe, no Resend, no environment
 * read, and no relative import. Every rules module in this repository is
 * built that way - lib/subscriptionCancellationRules.ts,
 * lib/refundConfirmationRules.ts and lib/transactionalEmailRetryRules.ts
 * all import nothing at all - so each one is directly loadable by the
 * focused suites, which import the .ts source rather than a build output.
 *
 * The four launch constants below are therefore MIRRORED rather than
 * imported, exactly as lib/subscriptionInvoiceRules.ts already mirrors
 * them from lib/subscriptionCheckoutRules.ts. They cannot silently drift:
 * tests/subscription-started-email.test.mjs imports both modules and
 * asserts every one of them is equal.
 *
 * Migration 035 is LIVE and IMMUTABLE. This module mirrors its two closed
 * vocabularies rather than inventing a parallel set, and every constant
 * here is checked against the migration text by the focused suite - so a
 * future edit to one that is not made to the other fails a test instead of
 * failing an INSERT in production.
 *
 * ── WHAT THIS PHASE IMPLEMENTS ────────────────────────────────
 *
 * One family: 'subscription_started'. The other two vocabularies exist in
 * the database and are deliberately not implemented here.
 */

/** The launch products. Mirrored from lib/subscriptionInvoiceRules.ts. */
const LAUNCH_SUBSCRIPTION_SKUS: readonly string[] = Object.freeze([
  "GLOA-MATCHA-30G",
  "GLOA-MATCHA-50G",
  "GLOA-MATCHA-100G",
]);

/** Four weeks, billed and delivered. Mirrored from the same module. */
const SUBSCRIPTION_INTERVAL_UNIT = "week";
const SUBSCRIPTION_INTERVAL_COUNT = 4;

/** One package per cycle. Mirrored from the same module. */
const SUBSCRIPTION_QUANTITY = 1;

/** The three families migration 035's CHECK permits. Mirrored, not invented. */
export const SUBSCRIPTION_EMAIL_FAMILIES: readonly string[] = Object.freeze([
  "subscription_started",
  "cancellation_confirmation",
  "subscription_ended",
]);

/** The only family Phase 3H.2 sends. */
export const SUBSCRIPTION_STARTED_FAMILY = "subscription_started";

/** The four statuses migration 035's CHECK permits. There is no 'pending'. */
export const SUBSCRIPTION_EMAIL_STATUSES: readonly string[] = Object.freeze([
  "sending",
  "sent",
  "failed",
  "superseded",
]);

/**
 * The Stripe billing reason that means "the subscription just started".
 *
 * subscription_create is raised once, when the subscription is created and
 * its first invoice is paid. Every later renewal is subscription_cycle and
 * must NOT produce this message: there is deliberately no recurring
 * "Zahlung erfolgreich" email in this system.
 */
export const SUBSCRIPTION_START_BILLING_REASON = "subscription_create";

/**
 * Is this paid invoice the one that started the subscription?
 *
 * The caller must pass the billing reason from the invoice it RE-READ from
 * Stripe, never the webhook payload's embedded copy - the same rule
 * lib/subscriptionInvoiceFulfillment.ts already follows for every other
 * invoice fact.
 */
export function isSubscriptionStartInvoice(billingReason: string | null | undefined): boolean {
  return billingReason === SUBSCRIPTION_START_BILLING_REASON;
}

/**
 * The event key for one subscription's start message.
 *
 * IT IS THE LOCAL SUBSCRIPTION ID, and migration 035 proves that is
 * sufficient rather than assuming it: activate_subscription_from_invoice
 * binds stripe_subscription_id once and refuses to revive a cancelled row,
 * and create_pending_subscription is a plain INSERT - so a customer who
 * subscribes again gets a NEW subscriptions.id and correctly a new start
 * message. One local row maps to one Stripe subscription, which raises one
 * subscription_create invoice.
 *
 * NOT the Stripe event id: a redelivery of the same fact carries a
 * different one, which would defeat the guard entirely. NOT the invoice
 * id, the checkout attempt id, the order id, the address or the period end
 * - the first three are per-cycle values and the last two move.
 *
 * Returned as null rather than blank when there is nothing to key on.
 * Migration 035 CHECKs length(btrim(event_key)) > 0, so a blank key is a
 * row the database would refuse; refusing it here means the claim is never
 * attempted with a value that cannot be stored.
 */
export function subscriptionStartedEventKey(subscriptionId: string | null | undefined): string | null {
  const trimmed = (subscriptionId ?? "").trim().toLowerCase();
  return trimmed ? trimmed : null;
}

/** The subscription columns one start message is rebuilt from. */
export type SubscriptionStartFacts = {
  id: string;
  customer_type: string | null;
  status: string;
  customer_snapshot: unknown;
  plan_snapshot: unknown;
};

/** One frozen subscription line, as public.subscription_items holds it. */
export type SubscriptionItemFacts = {
  sku: string | null;
  quantity: number;
};

/**
 * The facts the message is allowed to state, and nothing else.
 *
 * There is deliberately NO next-billing date here. See the note on
 * lib/email/subscriptionStarted.ts.
 */
export type SubscriptionStartContent = {
  /**
   * The frozen plan name, or null when the snapshot carries none.
   *
   * Nullable on purpose: the name is catalog display text and its absence
   * is cosmetic, so it must not be able to withhold a message whose other
   * facts - one package, every four weeks - are complete and true without
   * it.
   */
  packageName: string | null;
  /** Proven from the frozen line, never assumed to be one. */
  quantity: number;
  /** Proven from the frozen plan, never a constant in the template. */
  cadenceWeeks: number;
};

export type SubscriptionStartPreflight =
  /** Every fact still holds. Send exactly this. */
  | { kind: "send"; recipient: string; content: SubscriptionStartContent }
  /**
   * The customer-facing fact is gone and this message must NEVER be sent.
   * Terminal: migration 035's 'superseded'.
   */
  | { kind: "superseded"; reason: string }
  /**
   * The message is still owed but could not be built or delivered now.
   * Migration 035's 'failed' - the one status a later sweep may act on.
   */
  | { kind: "failed"; reason: string };

/**
 * The recipient, read back from the subscription's own frozen snapshot.
 *
 * Never a parameter, never a Stripe payload address, never a query string.
 * lib/shipmentConfirmationEmail.ts, lib/cancellationOutcomeEmail.ts and
 * lib/refundConfirmationEmail.ts all take the address off the durable row
 * for the same reason: a sender with no recipient argument cannot be
 * pointed at an arbitrary inbox, whatever a caller passes it.
 */
export function recipientFromCustomerSnapshot(snapshot: unknown): string | null {
  const customer = (snapshot ?? {}) as { email?: unknown };
  if (typeof customer.email !== "string") return null;
  const trimmed = customer.email.trim();
  return trimmed ? trimmed : null;
}

/** The frozen plan name, when the snapshot carries a usable one. */
function packageNameFromPlanSnapshot(snapshot: unknown): string | null {
  const plan = (snapshot ?? {}) as { name?: unknown };
  if (typeof plan.name !== "string") return null;
  const trimmed = plan.name.trim();
  return trimmed ? trimmed : null;
}

/**
 * Proves, from the durable row alone, that "Dein Abo ist aktiv" is still
 * a true thing to say - and decides what happens when it is not.
 *
 * ── WHY A CANCELLED SUBSCRIPTION IS SUPERSEDED, NOT FAILED ────
 *
 * These are genuinely different states and migration 035 exists to keep
 * them apart. A subscription that is terminally cancelled by the time this
 * runs will never be started again: mark_subscription_cancelled is the
 * only writer of that status, it is idempotent, and migration 022's
 * activation refuses to revive a cancelled row. Sending a fresh "your
 * subscription is active" message about it would be false, and leaving the
 * row 'failed' would keep re-offering that false message to every future
 * sweep. 'superseded' is the honest third answer, and it is terminal.
 *
 * ── WHY EVERY OTHER REFUSAL IS FAILED ─────────────────────────
 *
 * A missing recipient, an unusable plan snapshot or a status that is
 * neither active nor cancelled are all conditions under which the message
 * is still genuinely OWED - the customer paid and their subscription
 * started. Superseding those would silently drop a message the customer
 * is entitled to. 'failed' keeps the fact owed and is the only status the
 * later retry phase may act on.
 */
export function evaluateSubscriptionStartPreflight(input: {
  subscription: SubscriptionStartFacts | null;
  items: readonly SubscriptionItemFacts[];
}): SubscriptionStartPreflight {
  const { subscription, items } = input;

  if (!subscription) {
    // The row is gone. Migration 035 cascades the delivery row with it, so
    // in practice there is nothing left to record against - but the caller
    // must still not treat "vanished" as "delivered".
    return { kind: "failed", reason: "subscription not found" };
  }

  // TERMINAL, AND THE ONLY SUPERSEDING CONDITION.
  if (subscription.status === "cancelled") {
    return { kind: "superseded", reason: "subscription is terminally cancelled" };
  }

  // The start message describes a running subscription. 'pending' and
  // 'paused' are not that, and neither is permanent, so the fact stays
  // owed rather than being closed off.
  if (subscription.status !== "active") {
    return { kind: "failed", reason: `subscription status ${subscription.status} is not active` };
  }

  // B2C only. Migration 022 CHECKs this column to 'private', so this is a
  // second lock on a door that is already bolted - and the one that would
  // hold if that CHECK were ever widened.
  if (subscription.customer_type !== "private") {
    return { kind: "failed", reason: "subscription is not a private customer subscription" };
  }

  const recipient = recipientFromCustomerSnapshot(subscription.customer_snapshot);
  if (!recipient) {
    return { kind: "failed", reason: "subscription snapshot carries no customer email" };
  }

  const plan = subscription.plan_snapshot;
  if (!plan || typeof plan !== "object") {
    return { kind: "failed", reason: "subscription has no plan snapshot" };
  }

  // THE CADENCE IS PROVEN, NOT ASSERTED. The template is handed a number
  // that came out of the frozen plan, so "Alle 4 Wochen" cannot be printed
  // over a subscription that is billed on some other rhythm. Anything else
  // fails closed rather than rendering a cadence nobody agreed to.
  const planFacts = plan as { billingIntervalUnit?: unknown; billingIntervalCount?: unknown };
  if (planFacts.billingIntervalUnit !== SUBSCRIPTION_INTERVAL_UNIT
    || planFacts.billingIntervalCount !== SUBSCRIPTION_INTERVAL_COUNT) {
    return { kind: "failed", reason: "frozen plan is not billed every 4 weeks" };
  }

  // THE QUANTITY IS PROVEN TOO, off the frozen line rather than off the
  // launch constant, so "1 Packung" is a reading of the subscription and
  // not a promise the template makes on its behalf.
  if (items.length !== 1) {
    return { kind: "failed", reason: `subscription has ${items.length} items, expected exactly 1` };
  }
  const item = items[0];
  if (item.quantity !== SUBSCRIPTION_QUANTITY) {
    return { kind: "failed", reason: `subscription item quantity is ${item.quantity}` };
  }
  if (!item.sku || !LAUNCH_SUBSCRIPTION_SKUS.includes(item.sku)) {
    return { kind: "failed", reason: `sku ${item.sku ?? "none"} is not a launch subscription product` };
  }

  return {
    kind: "send",
    recipient,
    content: {
      packageName: packageNameFromPlanSnapshot(plan),
      quantity: item.quantity,
      cadenceWeeks: SUBSCRIPTION_INTERVAL_COUNT,
    },
  };
}
