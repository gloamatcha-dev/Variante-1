import type Stripe from "stripe";
import { getSupabaseAdmin } from "./supabaseAdmin";
import { evaluateStripeSessionPayment } from "./stripeFulfillment";
import { linkStripeSession, markAttemptPaid } from "./checkoutAttempts";
import type { B2bAttemptMoneyFacts, B2bFailureDeps, B2bWebhookDeps } from "./b2bWebhook";
import { recordB2bInitialSettlement, recordB2bMonthlyInvoiceEvent, recordB2bSettlementByInvoice } from "./financeRecording";
import { requireBusinessEffect, FINANCE_EFFECT_RESULTS } from './requiredBusinessEffect';

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
  // Activation is durable before Finance. Replay must repair the missing
  // effect even when the activation RPC returns its idempotent answer.
  if (payload.result === "activated" || payload.result === "already_active") {
    requireBusinessEffect('B2B initial settlement', await recordB2bInitialSettlement(input.agreementId), FINANCE_EFFECT_RESULTS);
  }
  return { result: payload.result ?? "unknown" };
}

async function settleMonthlyInvoice(input: {
  agreementId: string;
  stripeSubscriptionId: string;
  stripeInvoiceId: string;
}, stripe: Stripe): Promise<{ result: string; deliveryNumber?: number }> {
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

  // FINANCE RECORDING (076). Required: the monthly invoice RPC
  // live in lib/financeRecording.ts so b2bWebhookDeps stays free of
  // direct table access to the four commerce tables.
  if (payload.result === "settled" || payload.result === "activated" || payload.result === 'already_settled') {
    requireBusinessEffect('B2B monthly settlement', await recordB2bMonthlyInvoiceEvent(input.agreementId, input.stripeInvoiceId), FINANCE_EFFECT_RESULTS);
    // Monthly holds have agreement scope, not an invoice/period column.
    // Never clear them while another provider invoice is still owed.
    if (await monthlyInvoicesStillOwed(stripe, input.stripeSubscriptionId)) {
      requireBusinessEffect('B2B monthly delivery hold', await holdDeliveries(input.agreementId), ['held']);
    } else {
      requireBusinessEffect('B2B monthly delivery release', await releaseDeliveries(input.agreementId), ['released']);
    }
  }

  return { result: payload.result ?? "unknown", deliveryNumber: payload.delivery_number };
}

async function monthlyInvoicesStillOwed(stripe: Stripe, subscriptionId: string): Promise<boolean> {
  for (const status of ['open', 'uncollectible'] as const) {
    let after: string | undefined;
    do {
      const page = await stripe.invoices.list({ subscription: subscriptionId, status, limit: 100, ...(after ? { starting_after: after } : {}) });
      for (const invoice of page.data) {
        if (!Number.isSafeInteger(invoice.amount_remaining) || invoice.amount_remaining < 0) {
          throw new Error('Required B2B monthly outstanding invoice facts unavailable');
        }
        if (invoice.amount_remaining > 0) return true;
      }
      if (!page.has_more) break;
      const next = page.data.at(-1)?.id;
      if (!next || next === after) throw new Error('Required B2B monthly invoice pagination incomplete');
      after = next;
    } while (after);
  }
  return false;
}

export function b2bWebhookDeps(stripe: Stripe): B2bWebhookDeps & B2bFailureDeps {
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
    settleMonthlyInvoice: input => settleMonthlyInvoice(input, stripe),
    settleAnnualInstalment,
    recordAnnualFailure,
    holdDeliveries,
    releaseDeliveries,
  };
}

/* ── Packages 5D and 5F: instalment settlement, failure, holds ── */

async function callRpc(fn: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const admin = getSupabaseAdmin();
  if (!admin) return { result: "unavailable" };
  const { data, error } = await admin.rpc(fn, args);
  if (error) {
    console.error(`B2B ${fn} RPC error:`, error.message);
    return { result: "rpc_error" };
  }
  return (data ?? {}) as Record<string, unknown>;
}

async function settleAnnualInstalment(input: {
  agreementId: string;
  stripeInvoiceId: string;
  stripePaymentIntentId: string | null;
}): Promise<{ result: string; instalmentNumber?: number }> {
  const payload = await callRpc("settle_b2b_annual_paid_instalment", {
    p_agreement_id: input.agreementId,
    p_stripe_invoice_id: input.stripeInvoiceId,
    p_stripe_payment_intent_id: input.stripePaymentIntentId,
  });
  if(payload.result==='settled'||payload.result==='already_settled'){
    requireBusinessEffect('B2B annual settlement',await recordB2bSettlementByInvoice(input.agreementId,input.stripeInvoiceId),FINANCE_EFFECT_RESULTS);
  }
  return {
    result: (payload.result as string) ?? "unknown",
    instalmentNumber: payload.instalment_number as number | undefined,
  };
}

async function recordAnnualFailure(input: {
  agreementId: string;
  stripeInvoiceId: string;
}): Promise<{ result: string; instalmentNumber?: number }> {
  const payload = await callRpc("record_b2b_annual_instalment_failure", {
    p_agreement_id: input.agreementId,
    p_stripe_invoice_id: input.stripeInvoiceId,
  });
  return {
    result: (payload.result as string) ?? "unknown",
    instalmentNumber: payload.instalment_number as number | undefined,
  };
}

async function holdDeliveries(agreementId: string): Promise<{ result: string; held?: number }> {
  const payload = await callRpc("hold_b2b_deliveries_for_payment", { p_agreement_id: agreementId });
  return { result: (payload.result as string) ?? "unknown", held: payload.held as number | undefined };
}

async function releaseDeliveries(agreementId: string): Promise<{ result: string; released?: number }> {
  const payload = await callRpc("release_b2b_deliveries_after_payment", { p_agreement_id: agreementId });
  return {
    result: (payload.result as string) ?? "unknown",
    released: payload.released as number | undefined,
  };
}

/** The 5D/5F half of the deps, for the annual invoice handlers. */
export function b2bFailureDeps(): B2bFailureDeps {
  return { settleAnnualInstalment, recordAnnualFailure, holdDeliveries, releaseDeliveries };
}
