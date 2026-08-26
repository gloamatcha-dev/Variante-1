/**
 * When a customer is owed a refund confirmation, and when they are not
 * (Phase 2E-A).
 *
 * Pure and leaf: no relative imports, no database, no network, no clock,
 * no environment - the same choice every other rules module in this
 * repository makes, so the eligibility logic is unit-testable rather
 * than only reachable through a live Stripe webhook.
 *
 * ══════════════════════════════════════════════════════════════
 * THE WATERMARK, WHICH IS THE WHOLE DESIGN
 * ══════════════════════════════════════════════════════════════
 *
 * Every other transactional email in this system is a one-shot: an order
 * is confirmed once, ships once, and a cancellation request is answered
 * once. A refund is not. Stripe allows several partial refunds against
 * one payment intent, and summarizeStripeRefunds sums every settled one
 * into a cumulative absolute total, so an ordinary order can walk:
 *
 *   paid                     refunded_total_cents NULL
 *   partially_refunded       refunded_total_cents 1000
 *   partially_refunded       refunded_total_cents 2500   (second refund)
 *   refunded                 refunded_total_cents 4990
 *
 * Three separate facts about the customer's money, and three separate
 * emails they are owed. A boolean "already sent" flag could express only
 * the first of them.
 *
 * So eligibility is a COMPARISON, not a flag:
 *
 *   owed  <=>  refunded_total_cents > coalesce(notifiedTotalCents, -1)
 *
 * refund_email_notified_total_cents (migration 033) is the cumulative
 * total the customer has actually been told about. It moves only on a
 * successful send, so a failure leaves the same fact owed rather than
 * silently swallowing it.
 *
 * The status column still exists and still means what it means
 * everywhere else - 'sending' is a held claim, 'failed' is the one state
 * a future retry may key on - but it no longer decides eligibility on its
 * own. 'sent' is claimable again the moment the total moves.
 *
 * ══════════════════════════════════════════════════════════════
 * WHY A HISTORICAL REFUND IS NOT SWEPT INTO SOMEONE'S INBOX
 * ══════════════════════════════════════════════════════════════
 *
 * An order refunded before this feature existed has a NULL watermark, so
 * the comparison above would say "owed" if anything evaluated it. What
 * stops that is not this module - it is that nothing enumerates orders.
 * The only caller is a live refund webhook for one specific payment
 * intent, and the webhook additionally sends only when
 * apply_order_refund_state reported 'applied' rather than 'unchanged'.
 * See isNewSettledRefundFact below, which is that second gate.
 *
 * NULL IS NEVER A SWEEP CRITERION. If a retry job is ever built it must
 * key on refund_email_status = 'failed' and nothing else.
 */

/** The complete vocabulary of migration 033's status column. */
export const REFUND_EMAIL_STATUSES = ["sending", "sent", "failed"] as const;

export type RefundEmailStatus = (typeof REFUND_EMAIL_STATUSES)[number];

/**
 * The payment states in which money has genuinely, durably gone back.
 *
 * Deliberately excludes 'refund_pending': a Refund object with
 * status='pending' means a refund is in flight and nothing has settled,
 * and apply_order_refund_state writes refunded_total_cents = 0 for it.
 * Telling a customer "your money is back" at that point would be a lie
 * that a subsequent failure would then have to be retracted.
 *
 * Also excludes 'paid', which is where a FAILED or CANCELLED refund
 * self-heals back to. That path is exactly why no email may fire on
 * anything but a settled total.
 */
export const SETTLED_REFUND_PAYMENT_STATUSES = ["partially_refunded", "refunded"] as const;

/** What the refund confirmation sender reports. It never throws. */
export type RefundEmailSendResult =
  /** Delivered to the provider now, and the watermark advanced. */
  | "sent"
  /** Nothing new to tell, or another worker is telling it right now. */
  | "already-sent"
  /** No settled refund on this order, no recipient, or no such order. */
  | "not-eligible"
  /** Attempted and failed. The row is 'failed' and the fact is still owed. */
  | "failed";

/** The order fields this decision depends on. Nothing else is read. */
export type RefundEmailOrderState = {
  /** Migration 019. The authoritative payment state. */
  payment_status: string;
  /** Migration 019. Cumulative settled refund, absolute. NULL = never observed. */
  refunded_total_cents: number | null;
  /** Migration 033. The cumulative total already announced. NULL = nothing yet. */
  refund_email_notified_total_cents: number | null;
  /** Migration 033. NULL = this order was never part of the flow. */
  refund_email_status: string | null;
};

/** Whether the durable payment state says money has actually settled back. */
export function hasSettledRefund(order: RefundEmailOrderState): boolean {
  if (!(SETTLED_REFUND_PAYMENT_STATUSES as readonly string[]).includes(order.payment_status)) {
    return false;
  }
  const total = order.refunded_total_cents;
  return typeof total === "number" && Number.isInteger(total) && total > 0;
}

/**
 * Whether this cumulative total is materially newer than what the
 * customer was last told.
 *
 * Strictly greater, never "not equal". A total that somehow went DOWN is
 * not a new thing to announce - settled refunds do not un-settle, so it
 * would mean a reconciliation oddity, and the right response to an oddity
 * is silence rather than an email retracting money.
 */
export function isNewerThanNotified(
  refundedTotalCents: number,
  notifiedTotalCents: number | null | undefined
): boolean {
  if (notifiedTotalCents === null || notifiedTotalCents === undefined) return refundedTotalCents > 0;
  return refundedTotalCents > notifiedTotalCents;
}

/**
 * Whether a status may be claimed by a LIVE send.
 *
 * Note what is NOT here: 'sent' is not excluded. Unlike every other email
 * in this system, a delivered refund confirmation does not close the
 * order to further sends - the watermark does that, and only for the
 * total it recorded. A larger total re-opens it.
 *
 * 'sending' is the only status that blocks outright: another worker holds
 * the claim, and competing with it is exactly how a duplicate is made.
 */
export function isRefundEmailClaimable(status: string | null | undefined): boolean {
  if (status === null || status === undefined) return true;
  return status === "sent" || status === "failed";
}

/**
 * Whether a status may be claimed by a SWEEP - a background job running
 * over rows nobody is watching.
 *
 * STRICTLY NARROWER THAN THE LIVE RULE, and the asymmetry is the point.
 * 'failed' and nothing else. NULL is refused because a NULL row is either
 * an order refunded before this feature existed or one whose live send is
 * about to happen, and in neither case may a background job mail anyone.
 * 'sent' is refused because a sweep has no business re-deciding what a
 * successful send already settled.
 *
 * No sweep exists (Phase 2E-A deliberately adds no cron). This predicate
 * exists now so the rule is written down and tested before anybody writes
 * the job.
 */
export function isRefundEmailSweepEligible(status: string | null | undefined): boolean {
  return status === "failed";
}

/**
 * Whether a live refund confirmation is owed for this order right now.
 *
 * All three conditions are required:
 *   1. money has genuinely settled back (not pending, not failed)
 *   2. the cumulative total is larger than what was last announced
 *   3. no other worker currently holds the claim
 *
 * This is the code half of a guarantee the database also enforces: the
 * claim UPDATE repeats every one of these in its WHERE clause, so nothing
 * can change between this check and the write and still produce an email.
 */
export function isRefundEmailOwed(order: RefundEmailOrderState): boolean {
  if (!hasSettledRefund(order)) return false;
  if (!isRefundEmailClaimable(order.refund_email_status)) return false;
  return isNewerThanNotified(order.refunded_total_cents as number, order.refund_email_notified_total_cents);
}

/**
 * Whether this refund sync outcome represents a genuinely NEW durable
 * fact, as opposed to a restatement of what the database already knew.
 *
 * THE HISTORICAL-REFUND GUARD, and the reason it lives at the webhook
 * boundary rather than in the eligibility rule above.
 *
 * apply_order_refund_state (migration 019) already draws this
 * distinction: 'applied' means it wrote something, 'unchanged' means the
 * absolute total and the payment state were already exactly what Stripe
 * reports. Only 'applied' may lead to an email.
 *
 * Without this, a refund event that merely restates an old refund - a
 * charge.refund.updated for a refund settled months ago, say - would find
 * a NULL watermark, conclude the customer had never been told, and mail
 * them about money they received long before this feature was built.
 *
 * Every other result is a refusal or a no-op: 'unchanged', 'not_applicable'
 * (the order was never paid), 'order_not_found', 'ambiguous_payment_intent',
 * 'invalid_amount', 'invalid_input'.
 */
export function isNewSettledRefundFact(syncResult: string): boolean {
  return syncResult === "applied";
}

/* ══════════════════════════════════════════════════════════════
   WHAT THE CUSTOMER IS TOLD
   ══════════════════════════════════════════════════════════════ */

/**
 * Which of the two messages this refund is.
 *
 * Derived from the persisted amounts, never from a caller's argument and
 * never from the Stripe payload. 'full' only when the cumulative settled
 * total has reached what the order was actually charged - the same
 * comparison apply_order_refund_state uses to choose between
 * 'partially_refunded' and 'refunded', so the email and the account page
 * can never disagree about which one happened.
 */
export type RefundKind = "partial" | "full";

export function refundKind(refundedTotalCents: number, totalGrossCents: number): RefundKind {
  if (totalGrossCents > 0 && refundedTotalCents >= totalGrossCents) return "full";
  return "partial";
}
