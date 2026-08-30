import { getStripeClient } from "./stripe";
import { getSiteOrigin } from "./siteUrl";
import { verifyBearerUser } from "./verifyUser";
import { getSupabaseAsUser } from "./subscriptionPlans";
import { getSupabaseAdmin } from "./supabaseAdmin";
import { buildAuthoritativeQuote } from "./checkoutQuote";
import { getOrCreateAnnualCheckoutAttempt, linkStripeSession } from "./checkoutAttempts";
import { isAnnualPlanCheckoutEnabled } from "./annualPlans";
import type { SavedAddressRow } from "./subscriptionCheckoutRules";
import type { AnnualCheckoutDeps, CreatePendingAnnualPlanInput } from "./annualPlanCheckout";

/**
 * The real wiring behind the annual plan checkout (Phase 4B3).
 *
 * Kept apart from lib/annualPlanCheckout.ts on purpose, exactly as
 * lib/subscriptionCheckoutDeps.ts is kept apart from its flow. The
 * modules imported here reach lib/supabase.ts, which reads
 * import.meta.env at module scope and so only loads under the bundler.
 * Isolating them means the flow itself can be driven with stubs, which is
 * how the ordering, idempotency and metadata guarantees are proven
 * without touching Stripe or a database.
 */

/**
 * Reads one address, as the CUSTOMER rather than as the server.
 *
 * The same function the subscription checkout uses, restated here rather
 * than exported across flows so that a future change to one cannot
 * silently alter the other. Ownership is enforced twice and neither check
 * relies on the other: the session-scoped client is subject to the RLS
 * policy from migration 001, which restricts the table to
 * auth.uid() = user_id, and the explicit filter below says the same thing
 * again in the query. A policy regression on its own would still not hand
 * back another customer's street.
 *
 * This is also why migration 025 does NOT grant the service role read
 * access to public.addresses: the route needs one person's address, not
 * everybody's.
 */
async function loadOwnAddress(token: string, userId: string, addressId: string): Promise<SavedAddressRow | null> {
  const asUser = getSupabaseAsUser(token);
  if (!asUser) return null;

  const { data, error } = await asUser
    .from("addresses")
    .select("id, user_id, first_name, last_name, company, street, house_number, zip, city, country")
    .eq("id", addressId)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    // The message only, never the row: a failed address query is not a
    // reason to put somebody's address in a log.
    console.error("Annual checkout address lookup error:", error.message);
    return null;
  }
  return (data as SavedAddressRow | null) ?? null;
}

/**
 * Calls migration 039's immutable pending-plan function.
 *
 * A thin wrapper and nothing more: it passes the thirteen arguments and
 * returns whatever jsonb the function answered with, unexamined.
 * Interpreting that answer is a pure decision and lives in
 * lib/annualPlanCheckoutRules.ts, where it can be tested - including the
 * rule that anything other than 'created' or 'existing' fails closed.
 *
 * NO TOTALS ARE PASSED. The function computes merchandise, shipping and
 * grand total itself from the per-delivery integers, then refuses the
 * whole call unless the result equals the payment attempt's expected
 * total. Passing them would create a second place for the money to be
 * wrong.
 */
async function createPendingAnnualPlan(input: CreatePendingAnnualPlanInput): Promise<unknown> {
  const admin = getSupabaseAdmin();
  if (!admin) {
    console.error("create_pending_annual_plan_for_attempt: supabase admin client is not configured");
    return null;
  }

  const { data, error } = await admin.rpc("create_pending_annual_plan_for_attempt", {
    p_checkout_attempt_id: input.checkoutAttemptId,
    p_user_id: input.userId,
    p_variant_id: input.variantId,
    p_catalog_unit_gross_cents: input.catalogUnitGrossCents,
    p_annual_unit_gross_cents: input.annualUnitGrossCents,
    p_shipping_per_delivery_gross_cents: input.shippingPerDeliveryGrossCents,
    p_discount_percent_applied: input.discountPercentApplied,
    p_customer_snapshot: input.customerSnapshot,
    p_shipping_address_snapshot: input.shippingAddressSnapshot,
    p_billing_address_snapshot: input.billingAddressSnapshot,
    p_tax_snapshot: input.taxSnapshot,
    p_delivery_items_snapshot: input.deliveryItemsSnapshot,
    p_delivery_tax_snapshot: input.deliveryTaxSnapshot,
  });

  if (error) {
    console.error("create_pending_annual_plan_for_attempt failed:", error.message);
    return null;
  }
  return data;
}

export const defaultAnnualCheckoutDeps: AnnualCheckoutDeps = {
  isEnabled: () => isAnnualPlanCheckoutEnabled(),
  verifyCaller: verifyBearerUser,
  buildQuote: buildAuthoritativeQuote,
  loadAddress: loadOwnAddress,
  getStripe: getStripeClient,
  getOrigin: getSiteOrigin,
  ensureAttempt: getOrCreateAnnualCheckoutAttempt,
  createPendingPlan: createPendingAnnualPlan,
  linkSession: linkStripeSession,
};
