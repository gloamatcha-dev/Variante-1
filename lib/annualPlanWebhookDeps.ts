import type Stripe from "stripe";
import { getSupabaseAdmin } from "./supabaseAdmin";
import { findAnnualPaymentAttemptById, linkStripeSession, markAttemptPaid } from "./checkoutAttempts";
import type { AnnualWebhookDeps } from "./annualPlanWebhook";
import type { AnnualWebhookAttempt, AnnualWebhookPlan } from "./annualPlanWebhookRules";
import type { ClaimedAnnualDelivery } from "./annualDeliveryWorker";

/**
 * The real wiring behind the annual payment webhook (Phase 4B4).
 *
 * Kept apart from lib/annualPlanWebhook.ts on purpose, exactly as the two
 * checkout flows keep theirs apart: the modules imported here reach
 * lib/supabase.ts, which reads import.meta.env at module scope and so
 * only loads under the bundler. Isolating them means the settlement flow
 * can be driven with stubs, which is how its ordering, correlation and
 * idempotency guarantees are proven without Stripe or a database.
 *
 * Every function below is a thin adapter. Not one of them decides
 * anything: the refusals live in lib/annualPlanWebhookRules.ts where they
 * can be tested, and the authoritative decisions live in migrations 039
 * and 040 where they hold a row lock.
 */

/**
 * Resolves the annual plan BY ITS PAYMENT ATTEMPT.
 *
 * annual_plans.payment_checkout_attempt_id is unique (migration 039), so
 * this is exact. It is deliberately not a lookup by the plan id Stripe
 * metadata carries: that id is a CLAIM, checked against what this query
 * returns, and resolving by it would let a session naming somebody else's
 * plan reach an activation call for that plan.
 *
 * Three columns and no more. The webhook needs to know which plan, whose
 * it is and whether it is terminal; it has no business reading the
 * customer's frozen address or the money out of here.
 */
async function findAnnualPlanByPaymentAttempt(
  checkoutAttemptId: string
): Promise<AnnualWebhookPlan | null> {
  const admin = getSupabaseAdmin();
  if (!admin) return null;

  const { data, error } = await admin
    .from("annual_plans")
    .select("id, user_id, status")
    .eq("payment_checkout_attempt_id", checkoutAttemptId)
    .maybeSingle();

  if (error) {
    console.error("Annual plan lookup error:", error.message);
    return null;
  }
  return (data as AnnualWebhookPlan | null) ?? null;
}

/**
 * Calls migration 039's installed activation function.
 *
 * A thin wrapper: three arguments, and whatever jsonb it answers with,
 * unexamined. Interpreting the answer is a pure decision and lives in the
 * rules module - including that only 'activated' and 'already_active'
 * are successes, that both must report thirteen deliveries, and that
 * anything unrecognised fails closed.
 *
 * NO DATE IS PASSED. purchased_at comes from the attempt's paid_at inside
 * the function, and plan_end_at and the thirteen delivery dates are
 * derived there from it. Phase 4B1.1 removed the caller's ability to
 * supply that timestamp precisely so this call could not move a year of
 * shipments.
 */
async function activateAnnualPlan(input: {
  annualPlanId: string;
  stripeCheckoutSessionId: string;
  stripePaymentIntentId: string;
}): Promise<unknown> {
  const admin = getSupabaseAdmin();
  if (!admin) {
    console.error("activate_annual_plan_from_payment: supabase admin client is not configured");
    return null;
  }

  const { data, error } = await admin.rpc("activate_annual_plan_from_payment", {
    p_annual_plan_id: input.annualPlanId,
    p_stripe_checkout_session_id: input.stripeCheckoutSessionId,
    p_stripe_payment_intent_id: input.stripePaymentIntentId,
  });

  if (error) {
    console.error("activate_annual_plan_from_payment failed:", error.message);
    return null;
  }
  return data;
}

/**
 * The shared worker's two database calls.
 *
 * claim_due_annual_plan_deliveries IS the queue: it selects due and
 * stale-claimed rows under FOR UPDATE SKIP LOCKED and moves them to
 * 'claimed' in one statement. Nothing here re-implements that predicate,
 * and nothing here selects deliveries and updates them separately.
 *
 * A database error THROWS rather than returning empty. An unreachable
 * queue is not "no work to do", and the worker's own error handling
 * turns it into a reported failure instead of a silent no-op.
 */
export const annualDeliveryWorkerDeps = {
  claimDue: async (limit: number): Promise<ClaimedAnnualDelivery[]> => {
    const admin = getSupabaseAdmin();
    if (!admin) throw new Error("supabase admin client is not configured");

    const { data, error } = await admin.rpc("claim_due_annual_plan_deliveries", {
      p_limit: limit,
    });
    if (error) throw new Error(`claim_due_annual_plan_deliveries failed: ${error.message}`);
    return (data as ClaimedAnnualDelivery[] | null) ?? [];
  },

  fulfillDelivery: async (deliveryId: string): Promise<unknown> => {
    const admin = getSupabaseAdmin();
    if (!admin) throw new Error("supabase admin client is not configured");

    const { data, error } = await admin.rpc("fulfill_annual_plan_delivery", {
      p_delivery_id: deliveryId,
    });
    if (error) throw new Error(`fulfill_annual_plan_delivery failed: ${error.message}`);
    return data;
  },
};

/**
 * The wiring, with the Stripe client supplied by the webhook route.
 *
 * Taken as an argument rather than built here because the route has
 * already constructed and validated one to verify the event signature;
 * building a second would be a second place for the key to be read.
 */
export function annualWebhookDeps(stripe: Stripe): AnnualWebhookDeps {
  return {
    retrieveSession: (sessionId: string) => stripe.checkout.sessions.retrieve(sessionId),
    findAttempt: (checkoutAttemptId: string) =>
      findAnnualPaymentAttemptById(checkoutAttemptId) as Promise<AnnualWebhookAttempt | null>,
    findPlanByAttempt: findAnnualPlanByPaymentAttempt,
    linkSession: linkStripeSession,
    // The EXISTING writer, unchanged. Its unconditional-write behaviour is
    // what the one-time and subscription flows depend on; the annual
    // already-settled guard sits in front of the call, not inside it.
    markPaid: markAttemptPaid,
    activatePlan: activateAnnualPlan,
    worker: annualDeliveryWorkerDeps,
  };
}
