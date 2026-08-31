import type Stripe from "stripe";
import { getSupabaseAdmin } from "./supabaseAdmin";
// THE SHARED SUMMARISER, IMPORTED RATHER THAN REWRITTEN. Task 26A settled
// what a refund list means - settled statuses only, currency proved, an
// unknown status refuses the whole answer - and a second copy of that
// arithmetic would be a second place for it to be wrong. The annual path
// gets the same absolute total the one-time and subscription paths get.
import { summarizeStripeRefunds, type StripeRefundLike } from "./stripeRefunds";
import {
  runAnnualPlanRefundSync,
  type AnnualRefundPlanRow,
  type AnnualRefundSyncOutcome,
} from "./annualPlanRefundRules";

/**
 * The real wiring behind annual refund correlation (Phase 4B7).
 *
 * Kept apart from lib/annualPlanRefundRules.ts on purpose, exactly as
 * every other annual phase keeps its wiring apart: the modules imported
 * here reach lib/supabase.ts, which reads import.meta.env at module scope
 * and so only loads under the bundler. Isolating them means the
 * correlation, the ordering and every refusal can be proven with
 * in-memory ports.
 *
 * Three adapters, and not one of them decides anything:
 *
 *   THE LOOKUP     annual_plans WHERE stripe_payment_intent_id = $1.
 *   THE RE-READ    stripe.refunds.list for that same intent.
 *   THE WRITER     public.apply_annual_plan_refund_state, which locks the
 *                  parent row and owns what the total means.
 *
 * ── NO DIRECT WRITE, AND NO SECOND STOP FLAG ──────────────────
 *
 * There is no UPDATE on public.annual_plans in this file and there must
 * never be one, for migration 039's stated reason: every write to a paid
 * contract goes through a SECURITY DEFINER function that proves something
 * first. There is no write to public.annual_plan_deliveries either. A
 * full refund stops future deliveries because the claim and fulfillment
 * functions already refuse a refunded parent, not because anything here
 * cancels a row.
 *
 * ── IT SENDS NOTHING ──────────────────────────────────────────
 *
 * No refund confirmation, no purchase confirmation, no shipment mail. A
 * prepaid annual plan is not one delivery order, and what a customer
 * should be told about a refund against a thirteen-box contract is a
 * commercial decision that has not been made. This phase stores truth.
 */

/**
 * The annual parent that carries this PaymentIntent, or null.
 *
 * annual_plans_stripe_payment_intent_id_key already makes more than one
 * row impossible. Refusing anyway is the same defence lib/orderRefunds.ts
 * applies to its own lookup: if that index were ever dropped, this
 * refuses instead of silently picking a row.
 *
 * THREE COLUMNS. The refund correlation has no business reading the
 * customer snapshot, the address, the delivery schedule or the email
 * state out of a paid contract.
 */
async function findAnnualPlanByPaymentIntent(
  admin: NonNullable<ReturnType<typeof getSupabaseAdmin>>,
  paymentIntentId: string
): Promise<AnnualRefundPlanRow | null> {
  const { data, error } = await admin
    .from("annual_plans")
    .select("id, currency, total_gross_cents")
    .eq("stripe_payment_intent_id", paymentIntentId);

  if (error) {
    throw new Error(`annual refund sync: plan lookup failed: ${error.message}`);
  }
  if (!data || data.length === 0) return null;
  if (data.length > 1) {
    // Unreachable while the unique index exists, and a refusal rather
    // than a guess if it ever does not.
    throw new Error("annual refund sync: more than one annual plan carries this payment intent");
  }
  return data[0] as AnnualRefundPlanRow;
}

/**
 * Applies Stripe's current refund truth to the annual plan that owns this
 * PaymentIntent, if one does.
 *
 * Answers { kind: "not_annual" } when no annual plan carries the intent,
 * having issued NO Stripe request and written nothing - which is how the
 * caller knows to fall through to the existing one-time and subscription
 * refund flow, unchanged.
 *
 * The clock, the amounts and the statuses are all Stripe's, read now. See
 * lib/annualPlanRefundRules.ts for why that is what makes an out-of-order
 * redelivery converge instead of regress.
 *
 * ── THE KNOWN LIST-PAGE GAP, RESTATED HONESTLY ────────────────
 *
 * stripe.refunds.list is read with limit 100 and its has_more is not
 * consulted, exactly as lib/orderRefunds.ts already documents for the
 * one-time and subscription paths. An intent carrying more than 100
 * refunds would be summarised from the first page alone. This phase does
 * not fix that: it is the same call with the same limit, and paginating
 * an absolute-total computation is its own change with its own failure
 * modes. It is written down here so the annual path does not look like it
 * has a guarantee the others lack.
 */
export async function syncAnnualPlanRefundStateFromStripe(
  stripe: Stripe,
  paymentIntentId: string
): Promise<AnnualRefundSyncOutcome> {
  const admin = getSupabaseAdmin();
  if (!admin) {
    throw new Error("Supabase admin client not configured.");
  }

  return runAnnualPlanRefundSync(
    {
      findPlanByPaymentIntent: intent => findAnnualPlanByPaymentIntent(admin, intent),

      // THE ABSOLUTE RE-READ. Same call, same limit and same arithmetic
      // as the one-time path; the event's own refund object is never
      // consulted for an amount, a status or a currency.
      listRefunds: async intent => {
        const refunds = await stripe.refunds.list({ payment_intent: intent, limit: 100 });
        return refunds.data;
      },

      summarizeRefunds: (refunds, expectedCurrency) =>
        summarizeStripeRefunds(refunds as StripeRefundLike[], expectedCurrency),

      // THE ONLY WRITER. It receives the PaymentIntent, never a plan
      // uuid: the mutation authority resolves the plan again, itself,
      // from the Stripe identity alone and under its own row lock, so a
      // wrong uuid in this file could not rewrite a stranger's contract
      // because no uuid is passed.
      applyRefundState: async input => {
        const { data, error } = await admin.rpc("apply_annual_plan_refund_state", {
          p_stripe_payment_intent_id: input.paymentIntentId,
          p_refunded_total_cents: input.refundedTotalCents,
        });
        if (error) {
          throw new Error(`apply_annual_plan_refund_state failed: ${error.message}`);
        }
        return data;
      },
    },
    paymentIntentId
  );
}
