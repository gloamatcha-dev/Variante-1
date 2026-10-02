import { getSupabaseAdmin } from "./supabaseAdmin";
import { getResendClient } from "./resend";
import { GLOA_FROM_HELLO, GLOA_INTERNAL_ORDERS } from "./emailSenders";
import { annualCustomer, annualProduct } from "./adminAnnualPlansQuery";
import {
  buildInternalAnnualPurchaseNotificationEmail,
  internalAnnualPurchaseNotificationIdempotencyKey,
  type InternalAnnualPurchasePlan,
} from "./email/internalAnnualPurchaseNotification";

/**
 * Claims the right to send an internal notification for an annual plan
 * purchase. Returns true if claimed, false if already claimed or
 * ineligible.
 *
 * Uses migration 072's claim_annual_purchase_notification RPC, which
 * follows migration 026's pattern: an UPDATE that only matches an
 * unclaimed row, so two concurrent webhook deliveries serialise on the
 * row lock and exactly one proceeds.
 */
export async function claimAnnualPurchaseNotification(annualPlanId: string): Promise<boolean> {
  const admin = getSupabaseAdmin();
  if (!admin) {
    console.error("claimAnnualPurchaseNotification: admin client not configured");
    return false;
  }

  const { data, error } = await admin.rpc("claim_annual_purchase_notification", {
    p_annual_plan_id: annualPlanId,
  });

  if (error) {
    console.error(`claim_annual_purchase_notification failed for plan ${annualPlanId}:`, error.message);
    return false;
  }

  return data === true;
}

/**
 * Marks the outcome of an annual purchase notification attempt.
 *
 * 'sent' records the timestamp; 'failed' leaves the row re-claimable
 * for the retry sweep.
 */
export async function markAnnualPurchaseNotification(
  annualPlanId: string,
  outcome: "sent" | "failed"
): Promise<boolean> {
  const admin = getSupabaseAdmin();
  if (!admin) {
    console.error("markAnnualPurchaseNotification: admin client not configured");
    return false;
  }

  const { data, error } = await admin.rpc("mark_annual_purchase_notification", {
    p_annual_plan_id: annualPlanId,
    p_outcome: outcome,
  });

  if (error) {
    console.error(`mark_annual_purchase_notification failed for plan ${annualPlanId}:`, error.message);
    return false;
  }

  return data === true;
}

/**
 * Loads the annual plan data needed for the internal notification email.
 * Returns null if the plan cannot be found or the admin client is not
 * configured.
 */
async function loadPlanForNotification(annualPlanId: string): Promise<InternalAnnualPurchasePlan | null> {
  const admin = getSupabaseAdmin();
  if (!admin) return null;

  const { data, error } = await admin
    .from("annual_plans")
    .select([
      "id",
      "currency",
      "total_gross_cents",
      "merchandise_total_gross_cents",
      "shipping_total_gross_cents",
      "annual_unit_gross_cents",
      "delivery_count",
      "discount_percent_applied",
      "payment_status",
      "status",
      "purchased_at",
      "stripe_payment_intent_id",
      "customer_snapshot",
      "delivery_items_snapshot",
    ].join(","))
    .eq("id", annualPlanId)
    .single();

  if (error || !data) {
    console.error(`loadPlanForNotification: failed for plan ${annualPlanId}:`, error?.message ?? "not found");
    return null;
  }

  const row = data as unknown as Record<string, unknown>;
  const customer = annualCustomer(row.customer_snapshot);
  const product = annualProduct(row.delivery_items_snapshot);

  return {
    annualPlanId: row.id as string,
    currency: row.currency as string,
    totalGrossCents: row.total_gross_cents as number,
    merchandiseTotalGrossCents: row.merchandise_total_gross_cents as number,
    shippingTotalGrossCents: row.shipping_total_gross_cents as number,
    annualUnitGrossCents: row.annual_unit_gross_cents as number,
    deliveryCount: row.delivery_count as number,
    discountPercentApplied: row.discount_percent_applied as number,
    paymentStatus: row.payment_status as string,
    status: row.status as string,
    purchasedAt: (row.purchased_at as string | null) ?? null,
    stripePaymentIntentId: (row.stripe_payment_intent_id as string | null) ?? null,
    customerName: customer.name,
    customerEmail: customer.email,
    productLabel: product.label,
    productSku: product.sku,
  };
}

/**
 * Sends the internal annual purchase notification to orders@gloamatcha.com.
 *
 * claim → load → build → send via Resend → mark sent on success /
 * mark failed + throw on failure.
 *
 * Follows the exact pattern of lib/internalOrderNotificationEmail.ts.
 * Throws on genuine send failure so the webhook returns 500 and Stripe
 * redelivers.
 */
export async function sendInternalAnnualPurchaseNotificationIfNeeded(
  annualPlanId: string
): Promise<void> {
  const claimed = await claimAnnualPurchaseNotification(annualPlanId);
  if (!claimed) return;

  await deliverClaimedAnnualPurchaseNotification(annualPlanId);
}

/**
 * Sends the notification for a claim that has ALREADY been won.
 *
 * Split out so a future retry sweep can reuse the send path with its
 * own stricter claim, exactly as the order notification does.
 */
export async function deliverClaimedAnnualPurchaseNotification(
  annualPlanId: string
): Promise<void> {
  const resend = getResendClient();
  if (!resend) {
    console.error("Annual purchase notification: RESEND_API_KEY is not configured.");
    await markAnnualPurchaseNotification(annualPlanId, "failed");
    throw new Error("email provider not configured");
  }

  const plan = await loadPlanForNotification(annualPlanId);
  if (!plan) {
    console.error(`Annual purchase notification: could not load plan ${annualPlanId}.`);
    await markAnnualPurchaseNotification(annualPlanId, "failed");
    throw new Error(`could not load annual plan ${annualPlanId} for notification`);
  }

  const { subject, html, text } = buildInternalAnnualPurchaseNotificationEmail(plan);
  const idempotencyKey = internalAnnualPurchaseNotificationIdempotencyKey(annualPlanId);

  let sendErrorMessage: string | null = null;
  try {
    const { error } = await resend.emails.send(
      {
        from: GLOA_FROM_HELLO,
        to: GLOA_INTERNAL_ORDERS,
        subject,
        html,
        text,
      },
      { idempotencyKey }
    );
    if (error) sendErrorMessage = error.message;
  } catch (err) {
    sendErrorMessage = err instanceof Error ? err.message : "unknown error";
  }

  if (sendErrorMessage) {
    console.error(`Annual purchase notification: send failed for plan ${annualPlanId}:`, sendErrorMessage);
    await markAnnualPurchaseNotification(annualPlanId, "failed");
    throw new Error(`annual purchase notification send failed for plan ${annualPlanId}`);
  }

  await markAnnualPurchaseNotification(annualPlanId, "sent");
}
