import type Stripe from "stripe";

/**
 * When a paid Stripe invoice may become a GLOA fulfillment order
 * (Task 29D-E).
 *
 * A leaf on purpose: type-only imports, no relative value import, no DB,
 * no network, no Stripe client, no clock. Every decision below is
 * therefore directly unit-testable, which matters more here than almost
 * anywhere else in this codebase - this is the module that decides
 * whether a physical package gets sent.
 *
 * The rule the whole task rests on: invoice.paid is the canonical event.
 * Not the browser success page, not checkout.session.completed, not
 * customer.subscription.created, not payment_intent.succeeded. The first
 * invoice and every four-weekly renewal go through exactly the same
 * decision.
 */

/* ── Which invoices become packages ─────────────────────────── */

/**
 * The only billing reasons that describe a normal four-weekly physical
 * delivery.
 *
 *   subscription_create  the first invoice, raised when the subscription
 *                        starts.
 *   subscription_cycle   every renewal after that.
 *
 * Everything else Stripe can produce - manual, subscription_update,
 * subscription_threshold, quote_accept, upcoming,
 * automatic_pending_invoice_item_invoice - is deliberately NOT here. A
 * proration, a mid-cycle modification or a hand-written invoice may be a
 * perfectly real payment, but none of them is evidence that a customer
 * should receive another tin of matcha, and this build has no feature
 * that creates one. An allowlist means a billing reason nobody has
 * thought about yet cannot ship a package by default.
 */
export const FULFILLABLE_BILLING_REASONS: readonly Stripe.Invoice.BillingReason[] = Object.freeze([
  "subscription_create",
  "subscription_cycle",
]);

/** The launch products, mirrored from lib/subscriptionCheckoutRules.ts. */
export const LAUNCH_SUBSCRIPTION_SKUS: readonly string[] = Object.freeze([
  "GLOA-MATCHA-30G",
  "GLOA-MATCHA-50G",
  "GLOA-MATCHA-100G",
]);

export const SUBSCRIPTION_INTERVAL_UNIT = "week";
export const SUBSCRIPTION_INTERVAL_COUNT = 4;

/** One package per cycle. */
export const SUBSCRIPTION_QUANTITY = 1;

/**
 * The local statuses a legitimately paid cycle can arrive in.
 *
 * Taken from migration 022's own allowlist so the two cannot drift: a
 * first payment ('pending'), an ordinary renewal ('active'), or a
 * recovery after a failed one ('past_due', 'unpaid'). A 'cancelled'
 * subscription is NOT revived by a late invoice, and 'paused' is not a
 * launch feature and is never written.
 */
export const FULFILLABLE_SUBSCRIPTION_STATUSES: readonly string[] = Object.freeze([
  "pending",
  "active",
  "past_due",
  "unpaid",
]);

/* ── The Stripe side ────────────────────────────────────────── */

/**
 * The Stripe Subscription an invoice was raised for.
 *
 * Read from `invoice.parent.subscription_details.subscription`, which is
 * where the installed API version (2026-07-29.dahlia) puts it. The old
 * top-level `invoice.subscription` is deliberately not consulted: it is
 * not the accessor for this API version, and quietly falling back to it
 * would make the code's correctness depend on which version an account
 * happens to be pinned to.
 *
 * The value is `string | Subscription`, so both shapes are handled.
 */
export function resolveInvoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  const details = invoice.parent?.subscription_details;
  if (!details) return null;

  const subscription = details.subscription;
  if (typeof subscription === "string") return subscription || null;
  return subscription?.id ?? null;
}

/** Stripe object ids arrive as a string or an expanded object. */
export function idOf(value: string | { id: string } | null | undefined): string | null {
  if (typeof value === "string") return value || null;
  return value?.id ?? null;
}

export type InvoiceFacts = {
  id: string | null;
  currency: string | null;
  status: string | null;
  billingReason: string | null;
  /** The commercial total. See the note in evaluateSubscriptionInvoice. */
  total: number | null;
  customerId: string | null;
  stripeSubscriptionId: string | null;
};

export type FrozenSubscriptionFacts = {
  /** subscriptions.total_gross_cents, frozen at checkout. */
  totalGrossCents: number;
  currency: string;
};

export type InvoiceDecision =
  /** Not our business. Acknowledge and do nothing. */
  | { kind: "ignore"; reason: string }
  /**
   * Ours, but something does not reconcile. No order, no activation, and
   * the event must NOT be marked processed: an operator has to look, and
   * Stripe's retries keep the work reachable in the meantime.
   */
  | { kind: "fail"; reason: string }
  | { kind: "fulfill" };

/**
 * Whether this paid invoice may produce a package.
 *
 * The total comparison uses the invoice's `total`, not `amount_paid`.
 * They are usually equal and for this launch flow always should be -
 * there are no coupons, no discounts, no prorations and no credit
 * balance - but they answer different questions. `total` is what was
 * charged for; `amount_paid` is what the payment mechanics settled, and
 * a credit balance or a partial payment can move it without the
 * commercial terms changing. Fulfillment follows the commercial terms.
 *
 * A mismatch is a hard stop rather than an adjustment. Reshaping the
 * GLOA order to whatever Stripe happened to invoice would silently ship
 * goods on terms nobody agreed to, in whichever direction the difference
 * ran.
 */
export function evaluateSubscriptionInvoice(
  invoice: InvoiceFacts,
  frozen: FrozenSubscriptionFacts
): InvoiceDecision {
  if (!invoice.id) return { kind: "fail", reason: "invoice has no id" };

  // Not a subscription invoice at all: a one-off or hand-written invoice
  // has nothing to do with this flow.
  if (!invoice.stripeSubscriptionId) {
    return { kind: "ignore", reason: "invoice is not attached to a stripe subscription" };
  }

  if (!invoice.billingReason
    || !FULFILLABLE_BILLING_REASONS.includes(invoice.billingReason as Stripe.Invoice.BillingReason)) {
    return { kind: "ignore", reason: `billing reason ${invoice.billingReason ?? "none"} does not describe a delivery cycle` };
  }

  // From here on it IS one of ours, so every remaining problem is a
  // failure to reconcile rather than something to shrug off.
  if (invoice.status !== "paid") {
    return { kind: "fail", reason: `invoice status is ${invoice.status ?? "none"}, not paid` };
  }
  if (!invoice.customerId) {
    return { kind: "fail", reason: "invoice has no customer" };
  }
  if (!invoice.currency || invoice.currency.toUpperCase() !== frozen.currency.toUpperCase()) {
    return { kind: "fail", reason: `invoice currency ${invoice.currency ?? "none"} is not ${frozen.currency}` };
  }
  if (typeof invoice.total !== "number") {
    return { kind: "fail", reason: "invoice has no total" };
  }
  if (invoice.total !== frozen.totalGrossCents) {
    return {
      kind: "fail",
      reason: `invoice total ${invoice.total} does not match the frozen subscription total ${frozen.totalGrossCents}`,
    };
  }

  return { kind: "fulfill" };
}

/**
 * The GLOA subscription this Stripe Subscription belongs to.
 *
 * Correlation is by the metadata Task 29D-D wrote and by nothing else.
 * If it is missing there is no fallback: not the email, not the customer
 * name, not the amount, not the SKU, and above all not "the most recent
 * pending subscription". Every one of those would eventually attach
 * somebody's payment to somebody else's subscription, and the failure
 * would be silent.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function resolveGloaSubscriptionId(metadata: Stripe.Metadata | null | undefined): string | null {
  const value = metadata?.gloa_subscription_id;
  if (typeof value !== "string" || !UUID_RE.test(value)) return null;
  return value;
}

/* ── The local side ─────────────────────────────────────────── */

export type LocalSubscriptionFacts = {
  id: string;
  user_id: string | null;
  status: string;
  currency: string;
  stripe_subscription_id: string | null;
  total_gross_cents: number;
  shipping_gross_cents: number;
  customer_snapshot: unknown;
  shipping_address_snapshot: unknown;
  billing_address_snapshot: unknown;
  plan_snapshot: Record<string, unknown> | null;
  tax_snapshot: unknown;
};

export type LocalSubscriptionItemFacts = {
  sku: string | null;
  quantity: number;
};

export type LocalValidation =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Everything the local subscription must still be before it may ship.
 *
 * Checked against the row rather than assumed from how it was created.
 * A subscription is data: it survives migrations, restores and hand
 * edits, and a corrupted one must fail closed rather than be normalised
 * into something shippable.
 */
export function validateLocalSubscription(
  subscription: LocalSubscriptionFacts | null | undefined,
  items: LocalSubscriptionItemFacts[]
): LocalValidation {
  if (!subscription) return { ok: false, reason: "local subscription not found" };
  if (!subscription.user_id) return { ok: false, reason: "local subscription has no owner" };

  if (!FULFILLABLE_SUBSCRIPTION_STATUSES.includes(subscription.status)) {
    // A cancelled subscription is not revived by a late invoice, and no
    // status transition is invented here.
    return { ok: false, reason: `local subscription status ${subscription.status} cannot take a paid cycle` };
  }
  if (subscription.currency !== "EUR") {
    return { ok: false, reason: `local subscription currency is ${subscription.currency}` };
  }

  for (const [field, value] of [
    ["customer_snapshot", subscription.customer_snapshot],
    ["shipping_address_snapshot", subscription.shipping_address_snapshot],
    ["billing_address_snapshot", subscription.billing_address_snapshot],
    ["tax_snapshot", subscription.tax_snapshot],
  ] as const) {
    if (!value || typeof value !== "object") {
      return { ok: false, reason: `local subscription has no ${field}` };
    }
  }

  const plan = subscription.plan_snapshot;
  if (!plan || typeof plan !== "object") {
    return { ok: false, reason: "local subscription has no plan snapshot" };
  }
  if (plan.billingIntervalUnit !== SUBSCRIPTION_INTERVAL_UNIT
    || plan.billingIntervalCount !== SUBSCRIPTION_INTERVAL_COUNT) {
    return { ok: false, reason: "frozen plan is not billed every 4 weeks" };
  }
  if (plan.deliveryIntervalUnit !== SUBSCRIPTION_INTERVAL_UNIT
    || plan.deliveryIntervalCount !== SUBSCRIPTION_INTERVAL_COUNT) {
    return { ok: false, reason: "frozen plan does not deliver every 4 weeks" };
  }
  if (plan.discountPercent !== null && plan.discountPercent !== undefined) {
    return { ok: false, reason: "frozen plan carries a discount, which the launch flow does not implement" };
  }
  if (plan.commitmentMonths !== null && plan.commitmentMonths !== undefined) {
    return { ok: false, reason: "frozen plan carries a commitment term" };
  }

  if (items.length !== 1) {
    return { ok: false, reason: `local subscription has ${items.length} items, expected exactly 1` };
  }
  const item = items[0];
  if (item.quantity !== SUBSCRIPTION_QUANTITY) {
    return { ok: false, reason: `local subscription item quantity is ${item.quantity}, expected ${SUBSCRIPTION_QUANTITY}` };
  }
  if (!item.sku || !LAUNCH_SUBSCRIPTION_SKUS.includes(item.sku)) {
    // The empty Metal Case in particular: an accessory must never become
    // a recurring shipment, and a fourth SKU must fail closed rather than
    // ship by omission.
    return { ok: false, reason: `sku ${item.sku ?? "none"} is not a launch subscription product` };
  }

  return { ok: true };
}

/**
 * Whether the local row may adopt this Stripe Subscription id.
 *
 * NULL is the normal invoice-first case: the invoice arrived before
 * checkout.session.completed and this is the first thing that knows the
 * id. An identical id is an ordinary renewal or a redelivery. A
 * DIFFERENT id means two Stripe subscriptions are pointing at one local
 * row, which is never quietly accepted and never overwritten.
 */
export function stripeSubscriptionIdMatches(
  localId: string | null | undefined,
  invoiceSubscriptionId: string
): boolean {
  if (!localId) return true;
  return localId === invoiceSubscriptionId;
}

/**
 * The GLOA user's Stripe Customer must be the one Stripe actually
 * billed, on both the invoice and the subscription.
 *
 * Metadata alone is not proof of ownership: it says which row to look
 * at, not whose money paid. The chain that has to close is
 * subscription.user_id → stripe_customers → the Stripe Subscription's
 * customer → the Invoice's customer.
 */
export function customerChainMatches(input: {
  mappedStripeCustomerId: string | null;
  subscriptionCustomerId: string | null;
  invoiceCustomerId: string | null;
}): boolean {
  const { mappedStripeCustomerId, subscriptionCustomerId, invoiceCustomerId } = input;
  if (!mappedStripeCustomerId || !subscriptionCustomerId || !invoiceCustomerId) return false;
  return mappedStripeCustomerId === subscriptionCustomerId
    && mappedStripeCustomerId === invoiceCustomerId;
}

/* ── Cycle timestamps ───────────────────────────────────────── */

export type SubscriptionPeriod = {
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  /** The next delivery is the next billing boundary. Four weeks, exactly. */
  nextDeliveryAt: string | null;
};

/**
 * The cycle timestamps, taken from Stripe rather than computed.
 *
 * In this API version the period lives on the subscription ITEM, not on
 * the subscription. Nothing here adds "a month" or "28 days" to
 * anything: a locally computed boundary would drift away from the one
 * Stripe actually bills on, and Stripe is the authority on when the next
 * charge happens.
 */
export function resolveSubscriptionPeriod(subscription: Stripe.Subscription): SubscriptionPeriod {
  const item = subscription.items?.data?.[0];
  const toIso = (seconds: number | null | undefined): string | null =>
    typeof seconds === "number" && Number.isFinite(seconds)
      ? new Date(seconds * 1000).toISOString()
      : null;

  const start = toIso(item?.current_period_start);
  const end = toIso(item?.current_period_end);

  return { currentPeriodStart: start, currentPeriodEnd: end, nextDeliveryAt: end };
}

/* ── The period ONE PAID INVOICE actually paid for ───────────── */

/**
 * The service period of a specific paid invoice, or a refusal.
 *
 * Never a partial answer: an invoice whose period cannot be established
 * beyond doubt produces `ok: false`, and the caller must not record a
 * payment proof from it.
 */
export type PaidInvoicePeriodResult =
  | { ok: true; start: string; end: string }
  | { ok: false; reason: string };

/**
 * True when the line is a NON-PRORATION recurring line belonging to
 * exactly this Stripe subscription.
 *
 * Every clause is a way a line could otherwise smuggle in the wrong
 * period:
 *
 *   parent.type                 a one-time invoice item has
 *                               'invoice_item_details' and describes no
 *                               subscription period at all, even when it
 *                               names a subscription.
 *   proration === false         a proration line carries the stub period
 *                               it was computed over, not the cycle that
 *                               was billed. Compared to `false` rather
 *                               than negated, so an absent or
 *                               non-boolean flag is not read as "not a
 *                               proration".
 *   the subscription id         another subscription of the same
 *                               customer must never establish this one's
 *                               paid period. Both places Stripe reports
 *                               it are checked, and if either is present
 *                               and disagrees the line is refused rather
 *                               than accepted on the strength of the
 *                               other.
 */
function lineBelongsToSubscriptionCycle(
  line: Stripe.InvoiceLineItem,
  stripeSubscriptionId: string
): boolean {
  const parent = line.parent;
  if (!parent || parent.type !== "subscription_item_details") return false;

  const details = parent.subscription_item_details;
  if (!details) return false;
  if (details.proration !== false) return false;

  // Stripe reports the owning subscription in two places. Neither is
  // guaranteed present, so at least one must be, and any that IS present
  // must name this subscription.
  const fromDetails = typeof details.subscription === "string" ? details.subscription : null;
  const fromLine = idOf(line.subscription as string | { id: string } | null | undefined);
  if (!fromDetails && !fromLine) return false;
  if (fromDetails && fromDetails !== stripeSubscriptionId) return false;
  if (fromLine && fromLine !== stripeSubscriptionId) return false;

  return true;
}

/** A Stripe period boundary: a finite, positive, whole-second epoch. */
function periodSecondsAreUsable(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * WHICH PERIOD DID *THIS* INVOICE PAY FOR? (Phase 3C.6)
 *
 * ══════════════════════════════════════════════════════════════
 * WHY THIS IS NOT resolveSubscriptionPeriod
 * ══════════════════════════════════════════════════════════════
 *
 * resolveSubscriptionPeriod answers a different question: what period is
 * the Stripe subscription in RIGHT NOW. That is the correct source for
 * reconciling current_period_start/current_period_end, and it is wrong -
 * dangerously wrong - as payment evidence.
 *
 * An invoice.paid event is not guaranteed to be processed inside the
 * period it belongs to. Stripe redelivers for about three days, a failed
 * handler leaves the event unrecorded, an operator can resend an event
 * from the Dashboard at any later time, and delivery order is not
 * guaranteed. So invoice A, whose service period was P1 to P2, can be
 * processed when the subscription has already advanced to P2 to P3.
 * Reading the subscription then would pair A's id with P3 and claim
 * proof of a payment that has not happened.
 *
 * The service period therefore comes from the INVOICE, which is
 * immutable once finalised, and specifically from its subscription line
 * items - `Stripe.InvoiceLineItem.period`.
 *
 * NOT invoice.period_start / invoice.period_end. The installed SDK
 * documents those two as "the earliest/latest timestamp at which invoice
 * items can be associated with this invoice" and says in as many words:
 * "Use the line item period to get the service period for each price."
 * They are an envelope around the invoice, not the cycle that was
 * bought.
 *
 * ══════════════════════════════════════════════════════════════
 * A GLOA INVOICE HAS MORE THAN ONE RECURRING LINE
 * ══════════════════════════════════════════════════════════════
 *
 * Every subscription bills merchandise AND recurring shipping, so
 * lines.data[0] is not the answer - it is a coin toss between two prices
 * whose order Stripe documents but does not owe us. Both are collected,
 * and because both describe the same four-weekly cycle they must AGREE.
 *
 * If they disagree, this refuses. It does not take the earliest, the
 * latest or the first: a disagreement means the invoice is not the shape
 * this system was built for, and inventing an answer would put a
 * cancellation date on a guess.
 *
 * ══════════════════════════════════════════════════════════════
 * PAGINATION IS A REFUSAL, NOT AN ASSUMPTION
 * ══════════════════════════════════════════════════════════════
 *
 * invoice.lines is an ApiList and carries has_more. The embedded first
 * page is used - a GLOA invoice has two recurring lines and the page
 * holds ten, so it is always complete in practice - but "in practice" is
 * not a proof, so has_more true is refused outright rather than answered
 * from a partial list. A hidden line that disagreed about the period
 * would otherwise be invisible, and the disagreement check above is the
 * whole safety property.
 *
 * FAILING CLOSED COSTS THE CUSTOMER NOTHING HERE. The order for the
 * cycle is created before this is consulted, so the package still ships;
 * what a refusal withholds is only the evidence that would let a
 * deferred cancellation end the subscription, and withholding that means
 * the customer keeps a cycle rather than losing one.
 */
export function resolvePaidInvoiceSubscriptionPeriod(
  invoice: Stripe.Invoice,
  stripeSubscriptionId: string
): PaidInvoicePeriodResult {
  if (!stripeSubscriptionId) {
    return { ok: false, reason: "no stripe subscription to resolve a paid period for" };
  }

  const lines = invoice.lines;
  if (!lines || !Array.isArray(lines.data)) {
    return { ok: false, reason: "invoice carries no line items" };
  }
  if (lines.has_more === true) {
    return { ok: false, reason: "invoice line items are paginated, so the period cannot be proven" };
  }

  const cycleLines = lines.data.filter(line => lineBelongsToSubscriptionCycle(line, stripeSubscriptionId));
  if (cycleLines.length === 0) {
    return {
      ok: false,
      reason: `invoice has no non-proration subscription line for ${stripeSubscriptionId}`,
    };
  }

  // A qualifying line with an unusable period is a REFUSAL, never a
  // line to skip: skipping it would let the remaining lines answer for
  // a cycle one of them disagreed about.
  for (const line of cycleLines) {
    const period = line.period;
    if (!period
      || !periodSecondsAreUsable(period.start)
      || !periodSecondsAreUsable(period.end)
      || period.end <= period.start) {
      return { ok: false, reason: "a subscription line has no usable service period" };
    }
  }

  const start = cycleLines[0].period.start;
  const end = cycleLines[0].period.end;
  for (const line of cycleLines) {
    if (line.period.start !== start || line.period.end !== end) {
      return { ok: false, reason: "subscription lines disagree about the service period" };
    }
  }

  return {
    ok: true,
    start: new Date(start * 1000).toISOString(),
    end: new Date(end * 1000).toISOString(),
  };
}
