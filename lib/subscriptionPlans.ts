import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseAdmin } from "./supabaseAdmin";
import { validateLaunchPlan, type PlanResolution, type SubscriptionPlanRow } from "./subscriptionCheckoutRules";

/**
 * Reading a B2C subscription plan server-side (Task 29D-D).
 *
 * The plan decides the cadence and the billing terms, so it is read with
 * the service role and validated against every launch invariant rather
 * than believed because a browser named it. Migration 025 grants exactly
 * the SELECT this file needs and nothing else.
 *
 * The invariants themselves live in lib/subscriptionCheckoutRules.ts,
 * which has no database access and is therefore directly unit-testable.
 */

const PLAN_COLUMNS =
  "id, slug, name, description, variant_id, billing_interval_unit, billing_interval_count, delivery_interval_unit, delivery_interval_count, discount_percent, commitment_months, is_active";

/**
 * Loads one plan by id and validates it.
 *
 * A plan that does not exist and a plan that exists but is unusable both
 * come back as a failure the caller answers identically, so a response
 * cannot be used to enumerate plan state.
 */
export async function resolveLaunchPlanById(planId: string): Promise<PlanResolution> {
  const admin = getSupabaseAdmin();
  if (!admin) return { ok: false, reason: "supabase admin client is not configured" };

  const { data, error } = await admin
    .from("b2c_subscription_plans")
    .select(PLAN_COLUMNS)
    .eq("id", planId)
    .maybeSingle();

  if (error) {
    console.error("Subscription plan lookup error:", error.message);
    return { ok: false, reason: "plan lookup failed" };
  }

  return validateLaunchPlan(data as SubscriptionPlanRow | null);
}

/**
 * A Supabase client acting as the CUSTOMER, not as the server.
 *
 * Used only for reads that touch personal data, which at launch means one
 * saved address. RLS then confines the query to rows where
 * auth.uid() = user_id, so an addressId belonging to somebody else comes
 * back empty rather than as that person's street.
 *
 * This is why migration 025 grants the service role SELECT on the plan
 * table and deliberately NOT on public.addresses: the route needs one
 * person's address, not everybody's.
 *
 * Returns null when the public Supabase configuration is missing, so
 * callers fail closed instead of falling back to the service role.
 */
export function getSupabaseAsUser(accessToken: string): SupabaseClient | null {
  const url = import.meta.env.VITE_SUPABASE_URL;
  const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !publishableKey || !accessToken) return null;

  return createClient(url, publishableKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
