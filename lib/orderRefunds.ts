import type Stripe from "stripe";
import { getSupabaseAdmin } from "./supabaseAdmin";
import { correlateInvoiceFromInvoicePayments, invoiceRefundWriterResolvedAnOrder, summarizeStripeRefunds } from "./stripeRefunds";

/**
 * Refund state synchronisation (Task 26A).
 *
 * Never trusts a webhook payload for refund facts. Given only a payment
 * intent id, this re-lists that intent's refunds directly from Stripe,
 * summarises them into an absolute refunded total, and hands that total
 * to the apply_order_refund_state Postgres function (migration 019),
 * which owns every ownership/amount/state check.
 *
 * This module issues no refund and never calls Stripe's refund-creation
 * API. It only ever reads refunds that already exist.
 *
 * ══════════════════════════════════════════════════════════════
 * PHASE 3J.B2 - THE SECOND CORRELATION, AND WHY IT IS SECOND
 * ══════════════════════════════════════════════════════════════
 *
 * A one-time order stores the payment intent it was paid with, so the
 * lookup below resolves it in one hop and the fallback is never
 * entered. That path is UNCHANGED: same query, same Stripe read, same
 * writer, same result words, and no InvoicePayment request is issued
 * on it at all.
 *
 * A subscription order stores no payment intent - this API version puts
 * none on an invoice - so the same lookup finds nothing for it and the
 * refund would silently never land. ONLY THEN, after zero rows, does
 * syncSubscriptionOrderRefundState below reverse-look-up the invoice
 * that payment intent settled and correlate through it.
 *
 * Zero rows is the entry condition on purpose. An ambiguous payment
 * intent (more than one matching order) is still refused outright, as
 * before: a fallback is for an absent correlation, never for a
 * contested one.
 *
 * ══════════════════════════════════════════════════════════════
 * KNOWN GAP, PRE-DATING THIS PHASE AND DELIBERATELY LEFT OPEN
 * ══════════════════════════════════════════════════════════════
 *
 * stripe.refunds.list is read with limit 100 and its has_more is not
 * consulted, on BOTH paths. An order carrying more than 100 refunds
 * against one payment intent would therefore be summarised from the
 * first page alone and could report a total lower than the true one.
 *
 * This is not a Phase 3J.B2 regression: the call, the limit and the
 * arithmetic are exactly what they were before, and 3J.B2 changes only
 * WHICH ORDER a refund is correlated to, never how much was refunded.
 * It is written down here rather than fixed because fixing it means
 * paginating an absolute-total computation, which is its own change
 * with its own failure modes and deserves its own phase.
 */

export type RefundSyncOutcome = {
  /** Status string returned by apply_order_refund_state, or a local reason. */
  result: string;
  refundedTotalCents: number | null;
  hasPendingRefund: boolean | null;
  /**
   * The durable GLOA order id this payment intent belongs to, or null
   * when no single order matched.
   *
   * Added in Phase 2E-A. apply_order_refund_state (migration 019) returns
   * a bare status string and that migration is immutable, so the id is
   * taken from the lookup this module already performs - the same query
   * that reads the order's currency, which is how the id is known to
   * belong to exactly one matching, already-paid order.
   *
   * It exists so the webhook can hand it to the refund confirmation
   * sender. Nothing else is exported from here for that purpose: the
   * sender re-reads every refund fact from the row itself.
   *
   * On the Phase 3J.B2 subscription path it is additionally withheld
   * unless the database agreed. See syncSubscriptionOrderRefundState.
   */
  orderId: string | null;
};

/**
 * Reads the authoritative refund state for one payment intent and
 * applies it to the matching order.
 *
 * Idempotent by construction: the same Stripe state always produces the
 * same absolute total, so a duplicate or out-of-order webhook delivery
 * converges on the same row rather than accumulating.
 */
export async function syncOrderRefundStateFromStripe(
  stripe: Stripe,
  paymentIntentId: string
): Promise<RefundSyncOutcome> {
  const admin = getSupabaseAdmin();
  if (!admin) {
    throw new Error("Supabase admin client not configured.");
  }

  const trimmedId = paymentIntentId.trim();
  if (!trimmedId) {
    return { result: "invalid_input", refundedTotalCents: null, hasPendingRefund: null, orderId: null };
  }

  // The order's own currency is the reference the refunds must match -
  // never a hardcoded 'eur'.
  const { data: order, error: orderError } = await admin
    .from("orders")
    .select("id, currency")
    .eq("stripe_payment_intent_id", trimmedId);

  if (orderError) {
    throw new Error(`refund sync: order lookup failed: ${orderError.message}`);
  }

  if (order && order.length > 1) {
    // Never guess which order a refund belongs to. The database function
    // refuses this case too; refusing here as well avoids a pointless
    // Stripe call.
    return { result: "ambiguous_payment_intent", refundedTotalCents: null, hasPendingRefund: null, orderId: null };
  }

  if (!order || order.length === 0) {
    // No order carries this payment intent. Historically this ended
    // here as 'order_not_found', which is correct for a one-time
    // payment this shop never fulfilled - and WRONG for a subscription
    // order, which is correlated by invoice instead. Phase 3J.B2 tries
    // that second correlation before giving the same answer.
    return await syncSubscriptionOrderRefundState(stripe, trimmedId, admin);
  }

  const refunds = await stripe.refunds.list({ payment_intent: trimmedId, limit: 100 });

  const summary = summarizeStripeRefunds(refunds.data, order[0].currency);
  if (!summary.ok) {
    // Fail loudly rather than write a half-understood refund state. The
    // webhook route turns this into a 500 so Stripe retries.
    throw new Error(`refund sync: ${summary.reason}`);
  }

  const { data, error } = await admin.rpc("apply_order_refund_state", {
    p_payment_intent_id: trimmedId,
    p_refunded_total_cents: summary.refundedTotalCents,
    p_has_pending_refund: summary.hasPendingRefund,
  });

  if (error) {
    throw new Error(`apply_order_refund_state failed: ${error.message}`);
  }

  return {
    result: typeof data === "string" ? data : "unknown",
    orderId: typeof order[0].id === "string" ? order[0].id : null,
    refundedTotalCents: summary.refundedTotalCents,
    hasPendingRefund: summary.hasPendingRefund,
  };
}

/**
 * The subscription fallback (Phase 3J.B2). Reached ONLY when no order
 * carries this payment intent.
 *
 * The chain, and every link is exact:
 *
 *   refund payment intent
 *     -> stripe.invoicePayments.list, filtered to that payment intent
 *     -> exactly one proven invoice id, or a refusal
 *     -> checkout_attempts.stripe_invoice_id
 *     -> orders.checkout_attempt_id
 *     -> the order's currency
 *     -> the same absolute refund summary the one-time path uses
 *     -> apply_order_refund_state_by_invoice (migration 037)
 *
 * NOTHING ELSE MAY SELECT THE ORDER. Not the customer, not the email,
 * not the amount, not the date, not the subscription id and not
 * metadata. A subscription bills the same customer for the same amount
 * every month, so any of those would eventually attach one cycle's
 * refund to another cycle's order - the exact failure this correlation
 * exists to prevent.
 *
 * ONE PAGE. The InvoicePayment list is read once, with limit 100, and
 * page two is never fetched. Uniqueness is either proven by that page
 * or the correlation is refused; see correlateInvoiceFromInvoicePayments.
 *
 * A THROW HERE IS DELIBERATE for transient Stripe or Supabase failure.
 * The webhook route turns it into a 500, Stripe redelivers, and the
 * event is NOT recorded as processed - so nothing is lost. Only
 * permanently unprovable correlations return a refusal word, because
 * retrying those forever would achieve nothing.
 */
async function syncSubscriptionOrderRefundState(
  stripe: Stripe,
  trimmedId: string,
  admin: NonNullable<ReturnType<typeof getSupabaseAdmin>>
): Promise<RefundSyncOutcome> {
  // The modern relationship. invoice.payment_intent, invoice.charge and
  // charge.invoice do not exist in this API version, and guessing at a
  // charge would correlate money to the wrong cycle.
  const invoicePayments = await stripe.invoicePayments.list({
    payment: {
      type: "payment_intent",
      payment_intent: trimmedId,
    },
    limit: 100,
  });

  const correlation = correlateInvoiceFromInvoicePayments(
    invoicePayments.data,
    invoicePayments.has_more,
    trimmedId
  );
  if (!correlation.ok) {
    return { result: correlation.reason, refundedTotalCents: null, hasPendingRefund: null, orderId: null };
  }

  // The unique index checkout_attempts_stripe_invoice_id_key (022)
  // already makes more than one row impossible. Refusing anyway is the
  // same defence migration 037 applies in SQL: if that index were ever
  // dropped, this refuses instead of silently picking a row.
  const { data: attempts, error: attemptError } = await admin
    .from("checkout_attempts")
    .select("id")
    .eq("stripe_invoice_id", correlation.invoiceId);

  if (attemptError) {
    throw new Error(`refund sync: checkout attempt lookup failed: ${attemptError.message}`);
  }

  if (!attempts || attempts.length === 0) {
    // An invoice this system has no paid attempt for. Not an error: the
    // Stripe account may hold invoices that were never fulfilled here.
    return { result: "order_not_found", refundedTotalCents: null, hasPendingRefund: null, orderId: null };
  }
  if (attempts.length > 1) {
    return { result: "ambiguous_invoice_correlation", refundedTotalCents: null, hasPendingRefund: null, orderId: null };
  }

  const { data: order, error: orderError } = await admin
    .from("orders")
    .select("id, currency")
    .eq("checkout_attempt_id", attempts[0].id);

  if (orderError) {
    throw new Error(`refund sync: invoiced order lookup failed: ${orderError.message}`);
  }

  if (!order || order.length === 0) {
    // A paid attempt with no order is an internal inconsistency, and
    // migration 037 answers it with its own distinct word. Neither
    // mutates anything.
    return { result: "order_not_found", refundedTotalCents: null, hasPendingRefund: null, orderId: null };
  }
  if (order.length > 1) {
    return { result: "ambiguous_invoice_correlation", refundedTotalCents: null, hasPendingRefund: null, orderId: null };
  }

  // Identical arithmetic to the one-time path, against the
  // subscription order's OWN stored currency. Absolute, cumulative, and
  // unchanged by this phase.
  const refunds = await stripe.refunds.list({ payment_intent: trimmedId, limit: 100 });

  const summary = summarizeStripeRefunds(refunds.data, order[0].currency);
  if (!summary.ok) {
    throw new Error(`refund sync: ${summary.reason}`);
  }

  // THE INVOICE ID, NEVER THE ORDER ID. Defence in depth, and the
  // reason migration 037 has the signature it has: the order this
  // function resolved above is used for the currency and for the email
  // follow-up, but the mutation authority resolves the order again,
  // itself, from the Stripe invoice identity alone. A wrong uuid in
  // this file therefore cannot rewrite a stranger's payment record,
  // because no uuid is passed.
  const { data, error } = await admin.rpc("apply_order_refund_state_by_invoice", {
    p_stripe_invoice_id: correlation.invoiceId,
    p_refunded_total_cents: summary.refundedTotalCents,
    p_has_pending_refund: summary.hasPendingRefund,
  });

  if (error) {
    throw new Error(`apply_order_refund_state_by_invoice failed: ${error.message}`);
  }

  const result = typeof data === "string" ? data : "unknown";

  // WHERE THE TWO CORRELATIONS ARE CROSS-CHECKED.
  //
  // This file resolved an order from the invoice; the database resolved
  // one again, independently, from the same invoice. When the database
  // reports a correlation failure - or a word nobody recognises - the
  // two disagree, and the id resolved here is not evidence of anything.
  // Withholding it means the webhook cannot reach the refund
  // confirmation sender, so no customer is told about a mutation that
  // did not happen.
  return {
    result,
    orderId: invoiceRefundWriterResolvedAnOrder(result) && typeof order[0].id === "string"
      ? order[0].id
      : null,
    refundedTotalCents: summary.refundedTotalCents,
    hasPendingRefund: summary.hasPendingRefund,
  };
}
