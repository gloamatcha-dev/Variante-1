import type Stripe from "stripe";
import { getSupabaseAdmin } from "./supabaseAdmin";
// Phase 4B4.1. The two ATOMIC annual settlement writers, not
// linkStripeSession and not markAttemptPaid. Those two write with the
// predicate `id = $1` alone, which is right for the one-time and
// subscription flows and unsafe for a contract whose paid_at is a year of
// delivery dates. They are deliberately not imported here, so no annual
// settlement path can reach an unconditional write by accident.
import {
  findAnnualPaymentAttemptById,
  linkAnnualStripeSessionAtomically,
  settleAnnualAttemptPaidAtomically,
} from "./checkoutAttempts";
import type { AnnualWebhookDeps } from "./annualPlanWebhook";
import type { AnnualWebhookAttempt, AnnualWebhookPlan } from "./annualPlanWebhookRules";
import type { ClaimedAnnualDelivery } from "./annualDeliveryWorker";
// Phase 4B5. The purchase confirmation's own ports live in their own deps
// module for the same reason this file exists at all; here they are only
// bound to the sender, so the settlement flow receives one function of
// one argument and cannot reach Supabase or Resend itself.
import { sendAnnualPurchaseConfirmationEmail } from "./annualPurchaseConfirmationEmail";
import { annualPurchaseEmailDeps } from "./annualPurchaseConfirmationEmailDeps";
// Phase 4B6. The post-order processing an ordinary order receives, bound
// to the SHARED worker below rather than to a caller - which is what
// makes Delivery 1 and Deliveries 2 to 13 one mechanism. Its own module
// for the same reason every port here is thin: this file resolves rows
// and calls functions, it does not know what an email is.
import { notifyAnnualDeliveryOrder } from "./annualOrderNotification";

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
 * The shared worker's two database calls, and the post-order processing
 * that follows them.
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

  // ONE ARGUMENT: the order id migration 039 just answered with. The
  // recipient, the lines, the address and the label are read from the
  // durable order and its frozen attempt by the notification itself, so
  // nothing about the annual plan can reach that message from here - and
  // the duplicate guard is the order's own claim, not anything decided in
  // this file.
  notifyOrder: (order: { orderId: string }): Promise<void> =>
    notifyAnnualDeliveryOrder(order.orderId),
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
    linkSessionAtomically: linkAnnualStripeSessionAtomically,
    settlePaidAtomically: settleAnnualAttemptPaidAtomically,
    activatePlan: activateAnnualPlan,
    worker: annualDeliveryWorkerDeps,
    // ONE ARGUMENT: the plan id. The recipient, the money, the pack size
    // and every date are read from the frozen row by the sender itself,
    // so nothing the webhook learned from Stripe can reach the message.
    sendPurchaseEmail: (annualPlanId: string) =>
      sendAnnualPurchaseConfirmationEmail(annualPlanId, annualPurchaseEmailDeps),
  };
}
