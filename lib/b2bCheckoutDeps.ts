import { getStripeClient } from "./stripe";
import { getSiteOrigin } from "./siteUrl";
import { verifyBearerUser } from "./verifyUser";
import { getSupabaseAsUser } from "./subscriptionPlans";
import { getSupabaseAdmin } from "./supabaseAdmin";
import { getOrCreateStripeCustomer } from "./stripeCustomers";
import { getOrCreateB2bCheckoutAttempt, linkStripeSession } from "./checkoutAttempts";
import { getOrCreateB2bMonthlyPrice } from "./b2bRecurringPrice";
import { isB2bSelfServiceEnabled } from "./b2bFeatureFlag";
import type {
  B2bAddressRow,
  B2bAgreementClaimInput,
  B2bAgreementClaimResult,
  B2bAttemptInput,
  B2bAttemptResult,
  B2bBusinessProfileRow,
  B2bCheckoutDeps,
} from "./b2bCheckout";

/**
 * The real wiring behind the B2B self-service checkout (Package 5B).
 *
 * Kept apart from lib/b2bCheckout.ts on purpose, exactly as
 * lib/annualPlanCheckoutDeps.ts is kept apart from its flow. The modules
 * imported here reach lib/supabase.ts, which reads import.meta.env at
 * module scope and so only loads under the bundler. Isolating them means
 * the flow itself can be driven with stubs, which is how the ordering,
 * the gating and the frozen amount are proven without touching Stripe or
 * a database.
 */

/**
 * Is this account a BUSINESS account?
 *
 * Asked as the customer, through the session-scoped client, so migration
 * 001's RLS confines the read to their own profile row. Migration 061's
 * RPC asks public.profiles the same question again with the service role
 * and refuses independently, so a regression in either place still
 * leaves the other standing.
 */
async function isBusinessAccount(token: string, userId: string): Promise<boolean> {
  const asUser = getSupabaseAsUser(token);
  if (!asUser) return false;

  const { data, error } = await asUser
    .from("profiles")
    .select("customer_type")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    console.error("B2B checkout profile lookup error:", error.message);
    return false;
  }
  return (data as { customer_type?: string } | null)?.customer_type === "business";
}

/**
 * Reads one address, as the CUSTOMER rather than as the server.
 *
 * Ownership is enforced twice and neither check relies on the other: the
 * session-scoped client is subject to migration 001's policy, which
 * restricts the table to auth.uid() = user_id, and the explicit filter
 * says the same thing again. A policy regression on its own would still
 * not hand back another customer's street.
 */
async function loadOwnAddress(
  token: string,
  userId: string,
  addressId: string
): Promise<B2bAddressRow | null> {
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
    console.error("B2B checkout address lookup error:", error.message);
    return null;
  }
  return (data as B2bAddressRow | null) ?? null;
}

async function loadBusinessProfile(
  token: string,
  userId: string
): Promise<B2bBusinessProfileRow | null> {
  const asUser = getSupabaseAsUser(token);
  if (!asUser) return null;

  const { data, error } = await asUser
    .from("business_profiles")
    .select("company_name, legal_form, vat_id, tax_number")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    console.error("B2B checkout business profile lookup error:", error.message);
    return null;
  }
  return (data as B2bBusinessProfileRow | null) ?? null;
}

async function ensureAttempt(input: B2bAttemptInput): Promise<B2bAttemptResult> {
  const result = await getOrCreateB2bCheckoutAttempt({
    requestId: input.requestId,
    userId: input.userId,
    currency: "EUR",
    expectedTotalGrossCents: input.expectedTotalGrossCents,
    shippingCountry: input.shippingCountry,
    shippingGrossCents: input.shippingGrossCents,
    items: [
      {
        kind: "b2b_supply",
        planType: input.planType,
        packs: input.packs,
        packGrams: 500,
        packNetCents: 5250,
        instalmentCount: input.instalmentCount,
        firstChargeNetCents: input.firstCharge.netCents,
        firstChargeTaxCents: input.firstCharge.taxCents,
        firstChargeGrossCents: input.firstCharge.grossCents,
        taxRatePercent: input.firstCharge.taxRatePercent,
        calculationVersion: input.firstCharge.calculationVersion,
        priceOrigin: input.firstCharge.priceOrigin,
      },
    ],
  });

  if (!result.ok) return { ok: false, error: result.error };
  return {
    ok: true,
    attempt: {
      id: result.attempt.id,
      currency: result.attempt.currency,
      expected_total_gross_cents: result.attempt.expected_total_gross_cents,
    },
  };
}

/**
 * Creates or returns the PENDING agreement, through migration 061's RPC.
 *
 * NEVER a direct table write. service_role holds SELECT and only SELECT
 * on the commerce tables; the RPC's definer privilege is the write
 * authority, and that is the whole posture 059 to 062 were built around.
 */
async function claimAgreement(input: B2bAgreementClaimInput): Promise<B2bAgreementClaimResult> {
  const admin = getSupabaseAdmin();
  if (!admin) {
    return { ok: false, result: "unavailable", reason: "supabase admin client is not configured" };
  }

  const { data, error } = await admin.rpc("create_pending_b2b_agreement_for_attempt", {
    p_checkout_attempt_id: input.checkoutAttemptId,
    p_expected_user_id: input.expectedUserId,
    p_plan_type: input.planType,
    p_quantity_packs: input.quantityPacks,
    p_instalment_count: input.instalmentCount,
    p_pricing_snapshot: input.pricingSnapshot,
    p_business_snapshot: input.businessSnapshot,
    p_customer_snapshot: input.customerSnapshot,
    p_shipping_address_snapshot: input.shippingAddressSnapshot,
    p_billing_address_snapshot: input.billingAddressSnapshot,
  });

  if (error) {
    console.error("B2B pending agreement RPC error:", error.message);
    return { ok: false, result: "rpc_error", reason: error.message };
  }

  const payload = (data ?? {}) as { result?: string; agreement_id?: string };
  const result = payload.result ?? "unknown";

  if ((result === "created" || result === "existing") && payload.agreement_id) {
    return { ok: true, agreementId: payload.agreement_id, result };
  }
  return { ok: false, result, reason: `the writer answered ${result}` };
}

export const defaultB2bCheckoutDeps: B2bCheckoutDeps = {
  isEnabled: isB2bSelfServiceEnabled,
  verifyCaller: verifyBearerUser,
  isBusinessAccount,
  loadOwnAddress,
  loadBusinessProfile,
  getStripe: getStripeClient,
  getOrigin: getSiteOrigin,
  ensureStripeCustomer: getOrCreateStripeCustomer,
  ensureAttempt,
  claimAgreement,
  ensureMonthlyPrice: getOrCreateB2bMonthlyPrice,
  linkSession: linkStripeSession,
};
