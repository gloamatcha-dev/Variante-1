import { getSupabaseAdmin } from "./supabaseAdmin";
import type { AddressSnapshot } from "./orderAddressSnapshot";

export type OrderCustomerSnapshot = {
  email: string | null;
  name: string | null;
};

export type CreatedOrder = {
  id: string;
  order_number: string;
  checkout_attempt_id: string | null;
};

/**
 * Idempotently creates a real order (+ order_items) from a checkout
 * attempt that has already been verified paid. Safe to call multiple
 * times for the same attempt (e.g. Stripe webhook retries) - returns the
 * existing order instead of creating a second one. All locking/atomicity
 * happens inside the create_order_from_paid_checkout Postgres function;
 * this is a thin, typed wrapper around that RPC call. Shipping/billing
 * snapshots are only ever written on the first successful creation - a
 * later retry never overwrites them (see the RPC's idempotency check).
 */
export async function createOrderFromPaidCheckoutAttempt(
  checkoutAttemptId: string,
  customerSnapshot: OrderCustomerSnapshot,
  stripePaymentIntentId: string | null,
  shippingAddressSnapshot: AddressSnapshot | null,
  billingAddressSnapshot: AddressSnapshot | null
): Promise<CreatedOrder> {
  const admin = getSupabaseAdmin();
  if (!admin) {
    throw new Error("Supabase admin client not configured.");
  }

  const { data, error } = await admin.rpc("create_order_from_paid_checkout", {
    p_checkout_attempt_id: checkoutAttemptId,
    p_customer_snapshot: customerSnapshot,
    p_stripe_payment_intent_id: stripePaymentIntentId,
    p_shipping_address_snapshot: shippingAddressSnapshot,
    p_billing_address_snapshot: billingAddressSnapshot,
  });

  if (error || !data) {
    throw new Error(`create_order_from_paid_checkout failed: ${error?.message ?? "no data returned"}`);
  }

  // PostgREST returns a single row directly (not an array) for a function
  // returning a single composite row, but tolerate an array shape too.
  const row = Array.isArray(data) ? data[0] : data;
  return row as CreatedOrder;
}
