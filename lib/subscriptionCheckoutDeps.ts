import { getStripeClient } from "./stripe";
import { getSiteOrigin } from "./siteUrl";
import { verifyBearerUser } from "./verifyUser";
import { getSupabaseAsUser, resolveLaunchPlanById } from "./subscriptionPlans";
import { buildAuthoritativeQuote } from "./checkoutQuote";
import { getOrCreateSubscriptionCheckoutAttempt, linkStripeSession } from "./checkoutAttempts";
import { claimPendingSubscriptionForAttempt } from "./subscriptions";
import { getOrCreateStripeCustomer } from "./stripeCustomers";
import { getOrCreateRecurringPrice } from "./stripeRecurringPrice";
import {
  isSubscriptionCheckoutEnabled,
  type SavedAddressRow,
  type SubscriptionCheckoutDeps,
} from "./subscriptionCheckout";

/**
 * The real wiring behind the subscription checkout (Task 29D-D).
 *
 * Kept apart from lib/subscriptionCheckout.ts on purpose. The modules
 * imported here reach lib/supabase.ts, which reads import.meta.env at
 * module scope and so only loads under the bundler. Isolating them means
 * the flow itself stays importable in a plain Node test and can be driven
 * with stubs, which is how the ordering, idempotency and metadata
 * guarantees are proven without touching Stripe or a database.
 */

/**
 * Reads one address, as the CUSTOMER rather than as the server.
 *
 * Ownership is enforced twice and neither check relies on the other: the
 * session-scoped client is subject to the RLS policy from migration 001,
 * which restricts the table to auth.uid() = user_id, and the explicit
 * filter below says the same thing again in the query. A policy
 * regression on its own would still not hand back another customer's
 * street.
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
    console.error("Subscription checkout address lookup error:", error.message);
    return null;
  }
  return (data as SavedAddressRow | null) ?? null;
}

export const defaultSubscriptionCheckoutDeps: SubscriptionCheckoutDeps = {
  isEnabled: () => isSubscriptionCheckoutEnabled(),
  verifyCaller: verifyBearerUser,
  resolvePlan: resolveLaunchPlanById,
  buildQuote: buildAuthoritativeQuote,
  loadAddress: loadOwnAddress,
  getStripe: getStripeClient,
  getOrigin: getSiteOrigin,
  ensureStripeCustomer: getOrCreateStripeCustomer,
  ensureRecurringPrice: getOrCreateRecurringPrice,
  ensureAttempt: getOrCreateSubscriptionCheckoutAttempt,
  claimSubscription: claimPendingSubscriptionForAttempt,
  linkSession: linkStripeSession,
};
