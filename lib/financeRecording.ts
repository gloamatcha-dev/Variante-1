import { getSupabaseAdmin } from "./supabaseAdmin";

export type FinanceResult = {
  result: string;
  event_id?: string;
  gross_cents?: number;
  occurred_on?: string;
};

/**
 * Records a payment event for a one-time (B2C) order.
 *
 * Called AFTER the order is created and paid. Idempotent: the database
 * function deduplicates on the order and on the operation_id, so a
 * webhook redelivery writes nothing and returns 'already_recorded'.
 *
 * The order is already durable. A null result must be treated as a
 * mandatory-effect failure by the webhook, before marking its event processed.
 */
export async function recordOrderPaymentEvent(
  orderId: string,
  operationId?: string
): Promise<FinanceResult | null> {
  const admin = getSupabaseAdmin();
  if (!admin) {
    console.error("recordOrderPaymentEvent: admin client not configured");
    return null;
  }

  const { data, error } = await admin.rpc("record_order_payment_event", {
    p_order_id: orderId,
    p_operation_id: operationId ?? null,
  });

  if (error) {
    console.error(`recordOrderPaymentEvent failed for order ${orderId}:`, error.message);
    return null;
  }
  return (data ?? null) as FinanceResult | null;
}

/**
 * Records the single prepayment event for an annual plan.
 *
 * Called AFTER activate_annual_plan_from_payment succeeds. The plan's
 * total_gross_cents is the figure, written once, and the twelve delivery
 * orders that follow produce NO event.
 */
export async function recordAnnualPrepaymentEvent(
  annualPlanId: string,
  operationId?: string
): Promise<FinanceResult | null> {
  const admin = getSupabaseAdmin();
  if (!admin) {
    console.error("recordAnnualPrepaymentEvent: admin client not configured");
    return null;
  }

  const { data, error } = await admin.rpc("record_annual_prepayment_event", {
    p_annual_plan_id: annualPlanId,
    p_operation_id: operationId ?? null,
  });

  if (error) {
    console.error(`recordAnnualPrepaymentEvent failed for plan ${annualPlanId}:`, error.message);
    return null;
  }
  return (data ?? null) as FinanceResult | null;
}

/**
 * Records a settled B2B instalment as a financial event.
 *
 * Called when a b2b_payment_schedule row is marked paid. Idempotent on
 * the schedule row itself: the database function checks by
 * (kind, b2b_agreement_id, external_reference).
 */
export async function recordB2bSettlementEvent(
  scheduleId: string,
  operationId?: string
): Promise<FinanceResult | null> {
  const admin = getSupabaseAdmin();
  if (!admin) {
    console.error("recordB2bSettlementEvent: admin client not configured");
    return null;
  }

  const { data, error } = await admin.rpc("record_b2b_settlement_event", {
    p_schedule_id: scheduleId,
    p_operation_id: operationId ?? null,
  });

  if (error) {
    console.error(`recordB2bSettlementEvent failed for schedule ${scheduleId}:`, error.message);
    return null;
  }
  return (data ?? null) as FinanceResult | null;
}

/**
 * Finds the paid schedule row by agreement + invoice and records it.
 *
 * The lookup lives HERE rather than in b2bWebhookDeps.ts so the B2B
 * surface stays free of direct table access to b2b_payment_schedule —
 * every read and write of those four commerce tables goes through an
 * RPC, except this single admin-client SELECT that is strictly internal
 * to the finance recording path.
 */
export async function recordB2bSettlementByInvoice(
  agreementId: string,
  stripeInvoiceId: string,
  operationId?: string
): Promise<FinanceResult | null> {
  const admin = getSupabaseAdmin();
  if (!admin) {
    console.error("recordB2bSettlementByInvoice: admin client not configured");
    return null;
  }

  const { data: scheduleRow } = await admin
    .from("b2b_payment_schedule")
    .select("id")
    .eq("supply_agreement_id", agreementId)
    .eq("stripe_invoice_id", stripeInvoiceId)
    .eq("status", "paid")
    .maybeSingle();

  if (!scheduleRow?.id) return null;

  return recordB2bSettlementEvent(scheduleRow.id, operationId);
}

/**
 * Records a refund event for a one-time order.
 *
 * Takes the ABSOLUTE refunded total from Stripe; the database function
 * computes the DELTA against what the ledger already holds and writes
 * only the difference. Idempotent by arithmetic: replaying the same
 * total produces a delta of zero and writes nothing.
 */
export async function recordOrderRefundEvent(
  orderId: string,
  refundedTotalCents: number,
  externalReference?: string | null,
  operationId?: string
): Promise<FinanceResult | null> {
  const admin = getSupabaseAdmin();
  if (!admin) {
    console.error("recordOrderRefundEvent: admin client not configured");
    return null;
  }

  const { data, error } = await admin.rpc("record_order_refund_event", {
    p_order_id: orderId,
    p_refunded_total_cents: refundedTotalCents,
    p_external_reference: externalReference ?? null,
    p_operation_id: operationId ?? null,
  });

  if (error) {
    console.error(`recordOrderRefundEvent failed for order ${orderId}:`, error.message);
    return null;
  }
  return (data ?? null) as FinanceResult | null;
}

/**
 * Records a refund event for a prepaid annual plan.
 *
 * Same delta-from-absolute pattern as order refunds. One event against
 * the plan cancels the one prepayment event.
 */
export async function recordAnnualPlanRefundEvent(
  annualPlanId: string,
  refundedTotalCents: number,
  externalReference?: string | null,
  operationId?: string
): Promise<FinanceResult | null> {
  const admin = getSupabaseAdmin();
  if (!admin) {
    console.error("recordAnnualPlanRefundEvent: admin client not configured");
    return null;
  }

  const { data, error } = await admin.rpc("record_annual_plan_refund_event", {
    p_annual_plan_id: annualPlanId,
    p_refunded_total_cents: refundedTotalCents,
    p_external_reference: externalReference ?? null,
    p_operation_id: operationId ?? null,
  });

  if (error) {
    console.error(`recordAnnualPlanRefundEvent failed for plan ${annualPlanId}:`, error.message);
    return null;
  }
  return (data ?? null) as FinanceResult | null;
}

/**
 * Records a payment provider fee (e.g. Stripe fee) against an order.
 *
 * The provider's balance_transaction reference is MANDATORY — a fee
 * without a source is exactly the estimate the system refuses to store.
 */
export async function recordPaymentFeeEvent(
  orderId: string,
  feeCents: number,
  occurredAt: string,
  externalReference: string,
  operationId?: string
): Promise<FinanceResult | null> {
  const admin = getSupabaseAdmin();
  if (!admin) {
    console.error("recordPaymentFeeEvent: admin client not configured");
    return null;
  }

  const { data, error } = await admin.rpc("record_payment_fee_event", {
    p_order_id: orderId,
    p_fee_cents: feeCents,
    p_occurred_at: occurredAt,
    p_external_reference: externalReference,
    p_operation_id: operationId ?? null,
  });

  if (error) {
    console.error(`recordPaymentFeeEvent failed for order ${orderId}:`, error.message);
    return null;
  }
  return (data ?? null) as FinanceResult | null;
}
