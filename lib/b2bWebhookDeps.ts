import type Stripe from "stripe";
import { getSupabaseAdmin } from "./supabaseAdmin";
import { evaluateStripeSessionPayment } from "./stripeFulfillment";
import { linkStripeSession, markAttemptPaid } from "./checkoutAttempts";
import type { B2bAttemptMoneyFacts, B2bWebhookDeps } from "./b2bWebhook";

/**
 * The real wiring behind the B2B settlement (Package 5C).
 *
 * Kept apart from lib/b2bWebhook.ts for the usual reason: the modules
 * imported here reach lib/supabase.ts, which reads import.meta.env at
 * module scope. Isolating them means the settlement flow can be driven
 * with stubs, which is how the ordering, the re-reads and the
 * convergence guarantees are proven without touching Stripe or a
 * database.
 *
 * Both writers are RPCs. service_role holds SELECT and only SELECT on
 * the four commerce tables, so there is no direct-write path to reach
 * for even by accident.
 */

/**
 * The money facts one B2B attempt holds.
 *
 * A NARROW read, deliberately: the settlement needs the frozen total,
 * the currency, the status and the session link, and nothing about the
 * customer. It also reads the four cross-flow binding columns in order
 * to REFUSE an impostor - an attempt carrying a subscription or annual
 * binding is not a B2B attempt, whatever the metadata said.
 */
async function findAttemptById(attemptId: string): Promise<B2bAttemptMoneyFacts | null> {
  const admin = getSupabaseAdmin();
  if (!admin) return null;

  const { data, error } = await admin
    .from("checkout_attempts")
    .select(
      "id, currency, expected_total_gross_cents, status, stripe_checkout_session_id, "
      + "subscription_id, annual_plan_id, annual_delivery_number"
    )
    .eq("id", attemptId)
    .maybeSingle();

  if (error) {
    console.error("B2B settlement attempt lookup error:", error.message);
    return null;
  }
  if (!data) return null;

  const row = data as unknown as B2bAttemptMoneyFacts & {
    subscription_id: string | null;
    annual_plan_id: string | null;
    annual_delivery_number: number | null;
  };

  // An attempt bound to another flow cannot be the one that minted a B2B
  // agreement: migration 061 refuses to mint from anything but a clean
  // pre-Stripe attempt, so a binding here means the ids do not describe
  // what the metadata claimed.
  if (row.subscription_id || row.annual_plan_id || row.annual_delivery_number !== null) {
    console.error(`B2B settlement: attempt ${attemptId} carries another flow's binding.`);
    return null;
  }

  return {
    id: row.id,
    currency: row.currency,
    expected_total_gross_cents: row.expected_total_gross_cents,
    status: row.status,
    stripe_checkout_session_id: row.stripe_checkout_session_id,
  };
}

async function activateAnnual(input: {
  agreementId: string;
  checkoutAttemptId: string;
  stripePaymentIntentId: string | null;
}): Promise<{ result: string; detail?: string }> {
  const admin = getSupabaseAdmin();
  if (!admin) return { result: "unavailable", detail: "supabase admin client is not configured" };

  const { data, error } = await admin.rpc("activate_b2b_annual_from_payment", {
    p_agreement_id: input.agreementId,
    p_checkout_attempt_id: input.checkoutAttemptId,
    p_stripe_payment_intent_id: input.stripePaymentIntentId,
  });

  if (error) {
    console.error("B2B annual activation RPC error:", error.message);
    return { result: "rpc_error", detail: error.message };
  }
  const payload = (data ?? {}) as { result?: string };
  return { result: payload.result ?? "unknown" };
}

async function settleMonthlyInvoice(input: {
  agreementId: string;
  stripeSubscriptionId: string;
  stripeInvoiceId: string;
}): Promise<{ result: string; deliveryNumber?: number }> {
  const admin = getSupabaseAdmin();
  if (!admin) return { result: "unavailable" };

  const { data, error } = await admin.rpc("settle_b2b_monthly_paid_invoice", {
    p_agreement_id: input.agreementId,
    p_stripe_subscription_id: input.stripeSubscriptionId,
    p_stripe_invoice_id: input.stripeInvoiceId,
  });

  if (error) {
    console.error("B2B monthly settlement RPC error:", error.message);
    return { result: "rpc_error" };
  }
  const payload = (data ?? {}) as { result?: string; delivery_number?: number };
  return { result: payload.result ?? "unknown", deliveryNumber: payload.delivery_number };
}

export function b2bWebhookDeps(stripe: Stripe): B2bWebhookDeps {
  return {
    // EVERY FACT IS RE-READ. A webhook payload is a picture of the object
    // when the event was generated, and a redelivered or delayed event
    // can carry a state several changes old.
    retrieveSession: sessionId => stripe.checkout.sessions.retrieve(sessionId),
    retrieveInvoice: invoiceId => stripe.invoices.retrieve(invoiceId),
    retrieveSubscription: subscriptionId => stripe.subscriptions.retrieve(subscriptionId),
    findAttemptById,
    evaluatePayment: evaluateStripeSessionPayment,
    linkSession: linkStripeSession,
    markAttemptPaid,
    activateAnnual,
    settleMonthlyInvoice,
  };
}
