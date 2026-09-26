import { verifyBearerUser } from "./verifyUser";
import { getSupabaseAsUser } from "./subscriptionPlans";
import { getStripeClient } from "./stripe";
import { isB2bSelfServiceEnabled } from "./b2bFeatureFlag";
import { b2bChangeDeps } from "./b2bAccountChangeDeps";
import type { B2bAccountRouteDeps } from "./b2bAccountRoutes";

/**
 * The real wiring behind the two B2B account routes (Package 5G).
 *
 * Deliberately the same three gates lib/b2bCheckoutDeps.ts supplies, and
 * the SAME implementations: the flag, the bearer verification and the
 * business-account check are not reimplemented here, because two
 * definitions of "is this a business account" is one too many.
 */

/**
 * Is this a business account?
 *
 * Read AS THE CUSTOMER, so RLS confines it to their own profile row.
 * Migration 064's writers ask the same question again in their own way -
 * they compare the expected user id against the agreement's owner - so
 * this is the friendly refusal rather than the guarantee.
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
    console.error("B2B account route profile lookup error:", error.message);
    return false;
  }
  return (data as { customer_type?: string } | null)?.customer_type === "business";
}

export function defaultB2bAccountRouteDeps(): B2bAccountRouteDeps {
  const stripe = getStripeClient();
  return {
    isEnabled: isB2bSelfServiceEnabled,
    verifyCaller: verifyBearerUser,
    isBusinessAccount,
    // A missing Stripe client is not a reason to hand the flow a null:
    // the gates above run first, and the change flow is only reached
    // once the request is a real authenticated business request. The
    // cast is confined to this one line, exactly as the checkout deps
    // confine theirs.
    change: b2bChangeDeps(stripe as NonNullable<ReturnType<typeof getStripeClient>>),
  };
}
