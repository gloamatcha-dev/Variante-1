import type Stripe from "stripe";
import { getSupabaseAdmin } from "./supabaseAdmin";
import { TAX_CATEGORY_RATE_PERCENT, addTaxToNet } from "./tax";
import { getOrCreateB2bMonthlyPrice } from "./b2bRecurringPrice";
import {
  runB2bCancellationReconciliation,
  type B2bAgreementFacts,
  type B2bCancelReconcileRow,
  type B2bCancelReconcileSummary,
  type B2bChangeDeps,
  type B2bRpcResult,
} from "./b2bAccountChange";

/**
 * The real wiring behind the B2B account changes (Package 5G).
 *
 * Kept apart from lib/b2bAccountChange.ts for the reason every *Deps
 * module in this repository is: the imports here reach lib/supabase.ts,
 * which reads import.meta.env at module scope, so isolating them lets
 * both flows be driven end to end with stubs.
 *
 * EVERY WRITE IS AN RPC. service_role holds SELECT and only SELECT on
 * the four commerce tables - 060 revoked the rest and 064 granted none
 * back - so there is no direct-write path to reach for by accident.
 */

const B2B_TAX_RATE_PERCENT = TAX_CATEGORY_RATE_PERCENT.matcha_reduced_de;

/**
 * The monthly GROSS for a pack count, net-origin.
 *
 * The recurring Stripe Price carries the gross, because B2B is
 * net-origin and lib/tax.ts has already produced the final charge
 * before Stripe is asked for anything - the same rule
 * lib/b2bCheckout.ts follows when it creates the first Price.
 */
export function b2bMonthlyGrossForPacks(packs: number, packNetCents: number): number {
  return addTaxToNet(packs * packNetCents, B2B_TAX_RATE_PERCENT).grossCents;
}

/** The same invoice-line wording the checkout used. */
export function b2bMonthlyProductName(packs: number): string {
  return `GLOA Matcha B2B – ${packs} × 500 g`;
}

/**
 * The agreement, read as the service role.
 *
 * A NARROW column list rather than `*`: this flow needs identity,
 * status and the frozen pack price, and has no business loading two
 * address snapshots and a pricing snapshot to decide whether somebody
 * may change a pack count.
 */
async function loadAgreement(agreementId: string): Promise<B2bAgreementFacts | null> {
  const admin = getSupabaseAdmin();
  if (!admin) return null;

  const { data, error } = await admin
    .from("b2b_supply_agreements")
    .select(
      "id, user_id, plan_type, status, quantity_packs, pending_quantity_packs, "
      + "pack_net_cents, currency, stripe_subscription_id, "
      + "cancellation_requested_at, cancellation_effective_at"
    )
    .eq("id", agreementId)
    .maybeSingle();

  if (error) {
    console.error("B2B account change: agreement lookup error:", error.message);
    return null;
  }
  return (data as B2bAgreementFacts | null) ?? null;
}

const rpc = async (name: string, args: Record<string, unknown>): Promise<B2bRpcResult> => {
  const admin = getSupabaseAdmin();
  if (!admin) return { result: "unavailable" };
  const { data, error } = await admin.rpc(name, args);
  if (error) {
    // The message only. An RPC argument list carries a user id.
    console.error(`B2B account change: ${name} error:`, error.message);
    return { result: "rpc_error" };
  }
  return (data as B2bRpcResult | null) ?? { result: "no_result" };
};

export const requestQuantityChange = (input: {
  agreementId: string; expectedUserId: string; quantityPacks: number;
}) => rpc("request_b2b_monthly_quantity_change", {
  p_agreement_id: input.agreementId,
  p_expected_user_id: input.expectedUserId,
  p_quantity_packs: input.quantityPacks,
});

export const requestCancellation = (input: {
  agreementId: string; expectedUserId: string; effectiveAt: Date; reason: string | null;
}) => rpc("request_b2b_monthly_cancellation", {
  p_agreement_id: input.agreementId,
  p_expected_user_id: input.expectedUserId,
  p_effective_at: input.effectiveAt.toISOString(),
  p_reason: input.reason,
});

/** 064's boundary writer, for the webhook. */
export const applyPendingQuantity = (agreementId: string) =>
  rpc("apply_b2b_monthly_quantity_change", { p_agreement_id: agreementId });

/** 064's convergence writer, for the webhook and the reconcile pass. */
export const reconcileCancellation = (agreementId: string, effectiveAt: Date) =>
  rpc("reconcile_b2b_monthly_cancellation", {
    p_agreement_id: agreementId,
    p_effective_at: effectiveAt.toISOString(),
  });

/** 064's termination writer, for customer.subscription.deleted. */
export const settleCancelledSubscription = (stripeSubscriptionId: string) =>
  rpc("settle_b2b_monthly_cancelled_subscription", {
    p_stripe_subscription_id: stripeSubscriptionId,
  });

/** 064's narrow subscription -> agreement read. */
export const agreementForSubscription = (stripeSubscriptionId: string) =>
  rpc("b2b_monthly_agreement_for_subscription", {
    p_stripe_subscription_id: stripeSubscriptionId,
  });

/** Everything the two customer flows need, wired for real. */
export function b2bChangeDeps(stripe: Stripe): B2bChangeDeps {
  return {
    loadAgreement,
    requestQuantityChange,
    requestCancellation,
    retrieveSubscription: (id: string) => stripe.subscriptions.retrieve(id),
    updateSubscription: (id, params, options) =>
      // The options object is only passed when there is an idempotency
      // key, so a retried request is a replay rather than a second
      // commercial change.
      options ? stripe.subscriptions.update(id, params, options)
        : stripe.subscriptions.update(id, params),
    ensureMonthlyPrice: async input => {
      const result = await getOrCreateB2bMonthlyPrice(stripe, input);
      return result.ok
        ? { ok: true, priceId: result.priceId }
        : { ok: false, reason: result.reason };
    },
    grossForPacks: b2bMonthlyGrossForPacks,
    productNameFor: b2bMonthlyProductName,
    now: () => new Date(),
  };
}

/* ── The reconcile pass ─────────────────────────────────────── */

/**
 * Active monthly agreements that were promised an end date.
 *
 * These are the rows whose Stripe half may have been lost: the database
 * write landed and the subscription update did not. Bounded, ordered by
 * the nearest promise so the most urgent divergence is repaired first.
 */
async function listPromised(limit: number): Promise<B2bCancelReconcileRow[]> {
  const admin = getSupabaseAdmin();
  if (!admin) return [];

  const { data, error } = await admin
    .from("b2b_supply_agreements")
    .select("id, stripe_subscription_id, cancellation_effective_at")
    .eq("plan_type", "monthly")
    .eq("status", "active")
    .not("cancellation_effective_at", "is", null)
    .not("stripe_subscription_id", "is", null)
    .order("cancellation_effective_at", { ascending: true })
    .limit(limit);

  if (error) {
    console.error("B2B cancellation reconcile: list error:", error.message);
    return [];
  }

  type Row = {
    id: string;
    stripe_subscription_id: string | null;
    cancellation_effective_at: string | null;
  };

  return ((data ?? []) as Row[])
    .filter(r => r.stripe_subscription_id && r.cancellation_effective_at)
    .map(r => ({
      agreement_id: r.id,
      stripe_subscription_id: r.stripe_subscription_id as string,
      cancellation_effective_at: r.cancellation_effective_at as string,
    }));
}

export function runB2bCancelReconcileJob(
  stripe: Stripe,
  limit?: number
): Promise<B2bCancelReconcileSummary> {
  return runB2bCancellationReconciliation(
    {
      listPromised,
      retrieveSubscription: (id: string) => stripe.subscriptions.retrieve(id),
      updateSubscription: (id, params, options) =>
        options ? stripe.subscriptions.update(id, params, options)
          : stripe.subscriptions.update(id, params),
    },
    limit
  );
}
