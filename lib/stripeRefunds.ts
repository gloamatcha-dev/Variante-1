/**
 * Pure refund evaluation (Task 26A).
 *
 * Leaf module by design - no relative imports, no Stripe SDK import, no
 * DB - so it is directly unit-testable, exactly like lib/stripeFulfillment.ts.
 * Refund objects are accepted structurally rather than as Stripe SDK
 * types, which keeps the decision logic testable with plain literals.
 *
 * The whole point of this module is to turn Stripe's refund list for one
 * payment intent into an ABSOLUTE refunded total. Absolute rather than
 * incremental is what makes refund handling safe under duplicate,
 * retried and out-of-order webhook deliveries: the same list always
 * produces the same answer, so replaying an event can never double-count
 * a refund.
 */

/** Structural shape of the fields we use from a Stripe Refund. */
export type StripeRefundLike = {
  amount?: number | null;
  currency?: string | null;
  status?: string | null;
};

export type RefundSummary =
  | {
      ok: true;
      /** Sum of settled refunds, in cents. Never negative. */
      refundedTotalCents: number;
      /** True when at least one refund exists but has not settled yet. */
      hasPendingRefund: boolean;
    }
  | { ok: false; reason: string };

/**
 * Stripe refund statuses that mean the money has actually gone back.
 * Only these count toward the refunded total.
 */
const SETTLED_STATUSES = ["succeeded"];

/**
 * Statuses that mean a refund is in flight. These deliberately do NOT
 * count toward the refunded amount - the customer is told a refund is
 * being processed, not that they have been refunded.
 */
const PENDING_STATUSES = ["pending", "requires_action"];

/**
 * Statuses that mean nothing is owed back. Ignored entirely, which is
 * what lets a cancelled/failed refund correctly return an order to a
 * plain paid state.
 */
const DEAD_STATUSES = ["failed", "canceled"];

/**
 * Summarises every refund belonging to one payment intent.
 *
 * Fails closed: a currency that does not match the order's, a
 * non-integer or negative amount, or an unrecognised status all refuse
 * the whole summary rather than applying a partially-understood refund
 * state to a real customer's order.
 */
export function summarizeStripeRefunds(
  refunds: StripeRefundLike[],
  expectedCurrency: string
): RefundSummary {
  if (!Array.isArray(refunds)) return { ok: false, reason: "refund list missing" };

  const expected = String(expectedCurrency ?? "").trim().toLowerCase();
  if (!expected) return { ok: false, reason: "expected currency missing" };

  let refundedTotalCents = 0;
  let hasPendingRefund = false;

  for (const refund of refunds) {
    const status = typeof refund?.status === "string" ? refund.status : null;
    if (!status) return { ok: false, reason: "refund status missing" };

    if (DEAD_STATUSES.includes(status)) continue;

    const isSettled = SETTLED_STATUSES.includes(status);
    const isPending = PENDING_STATUSES.includes(status);
    if (!isSettled && !isPending) {
      // An unknown status must never be silently treated as "no refund".
      return { ok: false, reason: `unrecognised refund status: ${status}` };
    }

    const currency = typeof refund?.currency === "string" ? refund.currency.trim().toLowerCase() : null;
    if (!currency) return { ok: false, reason: "refund currency missing" };
    if (currency !== expected) {
      return { ok: false, reason: `refund currency ${currency} does not match order currency ${expected}` };
    }

    const amount = refund?.amount;
    if (typeof amount !== "number" || !Number.isInteger(amount) || amount < 0) {
      return { ok: false, reason: "refund amount is not a non-negative integer" };
    }

    if (isSettled) refundedTotalCents += amount;
    else hasPendingRefund = true;
  }

  return { ok: true, refundedTotalCents, hasPendingRefund };
}

/**
 * Stripe webhook event types this application handles for refunds.
 *
 * Taken from the Stripe SDK pinned in this repo (stripe@22.5.0, API
 * version 2026-07-29.dahlia), not from memory. `refund.*` is the modern
 * refund lifecycle; `charge.refunded` is still emitted when a charge is
 * refunded and is handled too, so a refund issued from the Stripe
 * dashboard is picked up either way. Which of them actually arrives
 * does not matter here: every one of them triggers the same absolute
 * re-read of the payment intent's refunds.
 */
export const REFUND_EVENT_TYPES = [
  "charge.refunded",
  "charge.refund.updated",
  "refund.created",
  "refund.updated",
  "refund.failed",
] as const;

export function isRefundEventType(eventType: string): boolean {
  return (REFUND_EVENT_TYPES as readonly string[]).includes(eventType);
}

/** Structural shape of the event payload fields we read. */
type RefundEventObjectLike = {
  object?: string | null;
  payment_intent?: string | { id?: string | null } | null;
};

/**
 * Extracts the payment intent id a refund event refers to, or null.
 *
 * The id is the only thing ever taken from the webhook payload - every
 * refund amount and status is re-read from Stripe afterwards. A payload
 * that has been tampered with can therefore at most point this at a
 * different payment intent, and the database function then refuses
 * anything that is not exactly one matching, already-paid order.
 */
export function paymentIntentIdFromRefundEvent(eventObject: unknown): string | null {
  const object = eventObject as RefundEventObjectLike | null;
  const paymentIntent = object?.payment_intent;

  if (typeof paymentIntent === "string") {
    const trimmed = paymentIntent.trim();
    return trimmed ? trimmed : null;
  }

  const nested = paymentIntent?.id;
  if (typeof nested === "string") {
    const trimmed = nested.trim();
    return trimmed ? trimmed : null;
  }

  return null;
}
