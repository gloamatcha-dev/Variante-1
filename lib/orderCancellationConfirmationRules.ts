/**
 * WHEN THE DIRECT CANCELLATION CONFIRMATION IS OWED, AND WHAT IT SAYS
 * ABOUT THE MONEY.
 *
 * Zero imports, no Supabase, no Resend, no clock - the same shape every
 * other *Rules.ts in this repository has, and for the same reason: node
 * imports this file directly, so the test suite checks the ACTUAL rules
 * rather than grepping a sender for strings.
 *
 * The sender is the only caller. It repeats both of these in SQL when it
 * claims the right to send, which is where the guarantee actually lives;
 * this is the readable half.
 */

export type CancellationConfirmationSendResult =
  | "sent"
  | "already-sent"
  | "not-eligible"
  | "failed";

/** The three refund sentences the template can carry. */
export type CancellationRefundWording = "none" | "partial" | "full";

/**
 * Whether the durable row genuinely records a cancelled order that has
 * not yet been told.
 *
 * cancel_order (migration 029) writes status, fulfillment_status and
 * cancelled_at together, so any ONE of them is sufficient evidence -
 * requiring all three would refuse an order somebody cancelled by hand
 * before 029 existed.
 *
 * NULL means never attempted and 'failed' is a retry; 'sent' is done and
 * 'sending' belongs to another worker.
 */
export function isCancellationConfirmationOwed(order: {
  status?: string | null;
  fulfillment_status?: string | null;
  cancelled_at?: string | null;
  cancellation_confirmation_email_status?: string | null;
}): boolean {
  const cancelled =
    order.status === "cancelled" ||
    order.fulfillment_status === "cancelled" ||
    Boolean(order.cancelled_at);
  if (!cancelled) return false;
  const status = order.cancellation_confirmation_email_status;
  return status === null || status === undefined || status === "failed";
}

/**
 * Which of the three refund sentences this order gets.
 *
 * From the row's own columns, never from an argument. A cancelled order
 * that has had nothing returned reads 'none', which is the honest
 * default and the one the vast majority of cancellations will use -
 * cancel_order writes no money column, so a cancelled order routinely
 * still reads payment_status = 'paid'.
 */
export function cancellationRefundStateOf(order: {
  total_gross_cents?: number | null;
  refunded_total_cents?: number | null;
}): CancellationRefundWording {
  const total = typeof order.total_gross_cents === "number" ? order.total_gross_cents : 0;
  const refunded = typeof order.refunded_total_cents === "number" ? order.refunded_total_cents : 0;
  if (refunded <= 0) return "none";
  if (total > 0 && refunded >= total) return "full";
  return "partial";
}
