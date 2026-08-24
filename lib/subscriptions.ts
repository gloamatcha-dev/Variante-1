import { getSupabaseAdmin } from "./supabaseAdmin";
import type { AddressSnapshot } from "./orderAddressSnapshot";
import type { CheckoutAttemptItemSnapshot } from "./checkoutAttemptSnapshot";
import type { CartTaxSnapshot } from "./tax";
import type { SubscriptionPlanRow } from "./subscriptionCheckoutRules";

/**
 * Creating the local pending subscription (Task 29D-D).
 *
 * Thin, typed wrapper around create_pending_subscription from migration
 * 022, in the same shape as lib/orderFulfillment.ts wraps
 * create_order_from_paid_checkout. All atomicity lives in the function:
 * parent and items are one transaction, and a subscription with no items
 * cannot exist.
 *
 * The row is written BEFORE Stripe is contacted. That ordering is the
 * whole point of Model A: every later Stripe event resolves against local
 * data that was frozen before any of it happened, rather than against
 * whatever a webhook payload claims. It also means an invoice.paid that
 * arrives before checkout.session.completed still has something to
 * activate.
 *
 * Nothing here activates anything. The row is 'pending' and only
 * invoice.paid may move it, in Task 29D-E.
 */

/** Identity and contact, for the frozen snapshot. Never used to authenticate. */
export type SubscriptionCustomerSnapshot = {
  email: string | null;
  name: string | null;
};

/**
 * What was agreed, frozen at creation. Deliberately records the plan's
 * commercial terms rather than pointing at the plan row: a later edit to
 * the plan must not retroactively change what an existing subscriber
 * signed up for.
 */
export type SubscriptionPlanSnapshot = {
  planId: string;
  slug: string;
  name: string;
  description: string | null;
  variantId: string;
  sku: string;
  billingIntervalUnit: string;
  billingIntervalCount: number;
  deliveryIntervalUnit: string;
  deliveryIntervalCount: number;
  /** Both NULL at launch: not applicable, not "zero was configured". */
  discountPercent: number | null;
  commitmentMonths: number | null;
};

export function buildPlanSnapshot(plan: SubscriptionPlanRow, sku: string): SubscriptionPlanSnapshot {
  return {
    planId: plan.id,
    slug: plan.slug,
    name: plan.name,
    description: plan.description,
    // Non-null by construction: validateLaunchPlan refuses a plan without
    // a variant, and this is only reached for a validated plan.
    variantId: plan.variant_id as string,
    sku,
    billingIntervalUnit: plan.billing_interval_unit as string,
    billingIntervalCount: plan.billing_interval_count as number,
    deliveryIntervalUnit: plan.delivery_interval_unit as string,
    deliveryIntervalCount: plan.delivery_interval_count as number,
    discountPercent: plan.discount_percent,
    commitmentMonths: plan.commitment_months,
  };
}

export type CreatePendingSubscriptionInput = {
  userId: string;
  planId: string;
  planSnapshot: SubscriptionPlanSnapshot;
  customerSnapshot: SubscriptionCustomerSnapshot;
  shippingAddressSnapshot: AddressSnapshot;
  billingAddressSnapshot: AddressSnapshot;
  taxSnapshot: CartTaxSnapshot;
  items: CheckoutAttemptItemSnapshot[];
};

export type CreatePendingSubscriptionResult =
  | { ok: true; subscriptionId: string }
  | { ok: false; reason: string };

/**
 * Calls the RPC and returns the new subscription's id.
 *
 * The money columns are NOT passed: the function derives every total from
 * the tax snapshot, for the same reason the order RPC does. Two copies of
 * one total are two chances to disagree.
 *
 * The tax snapshot is required, and that is a real business rule rather
 * than a technicality. A destination whose VAT this build does not
 * implement cannot become a subscription at all, because the shop cannot
 * bill something every four weeks that it cannot tax.
 */
export async function createPendingSubscription(
  input: CreatePendingSubscriptionInput
): Promise<CreatePendingSubscriptionResult> {
  const admin = getSupabaseAdmin();
  if (!admin) return { ok: false, reason: "supabase admin client is not configured" };

  const { data, error } = await admin.rpc("create_pending_subscription", {
    p_user_id: input.userId,
    p_plan_id: input.planId,
    p_plan_snapshot: input.planSnapshot,
    p_customer_snapshot: input.customerSnapshot,
    p_shipping_address_snapshot: input.shippingAddressSnapshot,
    p_billing_address_snapshot: input.billingAddressSnapshot,
    p_tax_snapshot: input.taxSnapshot,
    p_items: input.items,
  });

  if (error || !data) {
    console.error("create_pending_subscription failed:", error?.message ?? "no id returned");
    return { ok: false, reason: "pending subscription could not be created" };
  }

  const subscriptionId = typeof data === "string" ? data : String(data);
  return { ok: true, subscriptionId };
}
