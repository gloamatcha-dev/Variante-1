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

/* ══════════════════════════════════════════════════════════════
   SUBSCRIPTION REFUND CORRELATION (Phase 3J.B2)
   ══════════════════════════════════════════════════════════════

   A one-time order carries the payment intent the refund names, so
   orders.stripe_payment_intent_id resolves it directly and nothing
   below is ever reached for it.

   A subscription order does not. This API version puts no payment
   intent on an invoice, so those orders are created with
   stripe_payment_intent_id NULL and the durable relationship is the
   invoice, through checkout_attempts.stripe_invoice_id.

   The reverse lookup that bridges the two is Stripe's InvoicePayment
   list, filtered by the refund's payment intent. What follows is the
   INTERPRETATION of that answer, and it is pure so that every refusal
   below is testable with plain literals rather than only reachable
   through a live refund.

   ONE PAGE, NEVER TWO. The list is read once with limit 100 and the
   answer is either proven by that single page or refused. Fetching
   page two to "make sure" would turn an unprovable correlation into a
   longer unprovable correlation; refusing is the safe end state
   because nothing is mutated by a refusal.
*/

/** Structural shape of the InvoicePayment.payment fields we read. */
export type InvoicePaymentPaymentLike = {
  type?: unknown;
  charge?: unknown;
  payment_intent?: unknown;
  payment_record?: unknown;
};

/** Structural shape of the InvoicePayment fields we read. */
export type InvoicePaymentLike = {
  invoice?: unknown;
  payment?: InvoicePaymentPaymentLike | null;
};

/**
 * Why a subscription refund could not be correlated to exactly one
 * invoice. Every one of them mutates nothing and sends nothing.
 *
 *   order_not_found              the lookup completed and this payment
 *                                intent settled no invoice at all
 *   ambiguous_invoice_payment    it settled two or more distinct
 *                                invoices, so no single order owns it
 *   unproven_invoice_uniqueness  the page did not prove uniqueness
 *                                because Stripe reported another page
 *   inconsistent_invoice_payment an entry did not describe the payment
 *                                intent that was asked about
 */
export type InvoiceCorrelationRefusal =
  | "order_not_found"
  | "ambiguous_invoice_payment"
  | "unproven_invoice_uniqueness"
  | "inconsistent_invoice_payment";

export type InvoiceCorrelation =
  | { ok: true; invoiceId: string }
  | { ok: false; reason: InvoiceCorrelationRefusal };

/**
 * Reads a Stripe id from a field that may be an id or an expanded
 * object. Blank, missing and non-string values all answer null rather
 * than an empty id, because an empty id would compare equal to another
 * empty id and manufacture a match.
 */
function stripeIdOf(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (value && typeof value === "object") {
    const nested = (value as { id?: unknown }).id;
    if (typeof nested === "string") {
      const trimmed = nested.trim();
      return trimmed ? trimmed : null;
    }
  }
  return null;
}

/**
 * The invoice an InvoicePayment names, as an id.
 *
 * Accepts the id form and the expanded form (including a deleted
 * invoice, which still carries its id and will simply match no
 * checkout attempt). NOTHING ELSE from the invoice is read: not the
 * customer, not the email, not the amount, not the metadata and not
 * the subscription. The id is the only thing this correlation is
 * allowed to know.
 */
export function invoiceIdFromInvoicePayment(invoice: unknown): string | null {
  return stripeIdOf(invoice);
}

/**
 * Turns ONE page of InvoicePayments, already filtered by Stripe to the
 * refund's payment intent, into either exactly one proven invoice id
 * or a refusal.
 *
 * THREE RULES, AND THE ORDER MATTERS.
 *
 * 1. EVERY ENTRY IS RE-VALIDATED, even though Stripe was asked to
 *    filter. An entry that describes a payment_record, a bare charge,
 *    or a different payment intent means the answer is not the answer
 *    that was asked for, and the whole page is refused. It is NOT
 *    filtered out: discarding the entries that disagree is precisely
 *    how a page holding two invoices would be reduced to one and
 *    reported as proven.
 *
 * 2. DISTINCT invoice ids are counted, not rows. Stripe legitimately
 *    returns several InvoicePayment rows against the same invoice, and
 *    three rows naming invoice A are still one invoice. Two distinct
 *    invoices are ambiguous and are never resolved by amount, date,
 *    customer, subscription or metadata - there is no tie-break here
 *    at all, deliberately.
 *
 * 3. UNIQUENESS IS ONLY PROVEN WHEN has_more IS FALSE. One invoice on
 *    a page that admits to having a successor proves nothing: the next
 *    page may hold a second invoice. Anything other than an explicit
 *    false refuses.
 */
export function correlateInvoiceFromInvoicePayments(
  entries: InvoicePaymentLike[],
  hasMore: boolean,
  expectedPaymentIntentId: string
): InvoiceCorrelation {
  const expected = typeof expectedPaymentIntentId === "string" ? expectedPaymentIntentId.trim() : "";
  if (!expected) return { ok: false, reason: "inconsistent_invoice_payment" };
  if (!Array.isArray(entries)) return { ok: false, reason: "inconsistent_invoice_payment" };

  const invoiceIds = new Set<string>();

  for (const entry of entries) {
    const payment = entry?.payment;
    if (!payment || typeof payment !== "object") {
      return { ok: false, reason: "inconsistent_invoice_payment" };
    }

    // A charge- or payment-record-settled invoice has no supported
    // relation to a refund's payment intent, so it is refused rather
    // than interpreted.
    if (payment.type !== "payment_intent") {
      return { ok: false, reason: "inconsistent_invoice_payment" };
    }
    if (payment.payment_record !== undefined && payment.payment_record !== null) {
      return { ok: false, reason: "inconsistent_invoice_payment" };
    }
    if (payment.charge !== undefined && payment.charge !== null) {
      return { ok: false, reason: "inconsistent_invoice_payment" };
    }

    const paymentIntentId = stripeIdOf(payment.payment_intent);
    if (!paymentIntentId || paymentIntentId !== expected) {
      return { ok: false, reason: "inconsistent_invoice_payment" };
    }

    const invoiceId = invoiceIdFromInvoicePayment(entry?.invoice);
    if (!invoiceId) return { ok: false, reason: "inconsistent_invoice_payment" };

    invoiceIds.add(invoiceId);
  }

  if (invoiceIds.size > 1) return { ok: false, reason: "ambiguous_invoice_payment" };

  // Strictly false. undefined, null and truthy all mean unproven.
  if (hasMore !== false) return { ok: false, reason: "unproven_invoice_uniqueness" };

  if (invoiceIds.size === 0) return { ok: false, reason: "order_not_found" };

  const [invoiceId] = invoiceIds;
  return { ok: true, invoiceId };
}

/**
 * The complete vocabulary of migration 037's
 * apply_order_refund_state_by_invoice.
 *
 * Written down so an unexpected word cannot be mistaken for one of
 * these and quietly treated as success.
 */
export const INVOICE_REFUND_WRITER_RESULTS = [
  "applied",
  "unchanged",
  "not_applicable",
  "invalid_amount",
  "order_not_found",
  "ambiguous_invoice_correlation",
  "order_missing_for_attempt",
  "invalid_input",
] as const;

/**
 * Whether migration 037's writer reached the SAME order the
 * application resolved.
 *
 * The application resolves the order in TypeScript to learn its
 * currency and its id; the database resolves it again, independently,
 * from the invoice id alone. Only the four words below mean the
 * database found exactly one order and made a decision about it. The
 * rest are correlation failures, and after one of those the
 * application's order id is not evidence of anything and must not be
 * carried forward into a refund email.
 *
 * An unknown word is a correlation failure too. Success is never
 * inferred from "not obviously a failure".
 */
export function invoiceRefundWriterResolvedAnOrder(result: string): boolean {
  return (
    result === "applied" ||
    result === "unchanged" ||
    result === "not_applicable" ||
    result === "invalid_amount"
  );
}
