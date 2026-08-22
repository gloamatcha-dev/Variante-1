import type Stripe from "stripe";
import { getSupabaseAdmin } from "./supabaseAdmin";
import { summarizeStripeRefunds } from "./stripeRefunds";

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
 */

export type RefundSyncOutcome = {
  /** Status string returned by apply_order_refund_state, or a local reason. */
  result: string;
  refundedTotalCents: number | null;
  hasPendingRefund: boolean | null;
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
    return { result: "invalid_input", refundedTotalCents: null, hasPendingRefund: null };
  }

  // The order's own currency is the reference the refunds must match -
  // never a hardcoded 'eur'.
  const { data: order, error: orderError } = await admin
    .from("orders")
    .select("currency")
    .eq("stripe_payment_intent_id", trimmedId);

  if (orderError) {
    throw new Error(`refund sync: order lookup failed: ${orderError.message}`);
  }

  if (!order || order.length === 0) {
    // A payment intent we have no order for is not an error: it may
    // belong to something that was never fulfilled here.
    return { result: "order_not_found", refundedTotalCents: null, hasPendingRefund: null };
  }

  if (order.length > 1) {
    // Never guess which order a refund belongs to. The database function
    // refuses this case too; refusing here as well avoids a pointless
    // Stripe call.
    return { result: "ambiguous_payment_intent", refundedTotalCents: null, hasPendingRefund: null };
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
    refundedTotalCents: summary.refundedTotalCents,
    hasPendingRefund: summary.hasPendingRefund,
  };
}
