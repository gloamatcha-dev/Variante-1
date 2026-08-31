import { getSupabaseAdmin } from "./supabaseAdmin";
import { getResendClient } from "./resend";
import { getSiteOrigin } from "./siteUrl";
import { GLOA_FROM_HELLO, GLOA_REPLY_TO_SUPPORT } from "./emailSenders";
import { buildAnnualPurchaseConfirmationEmail } from "./email/annualPurchaseConfirmation";
// THE PROVIDER-ERROR CLASSIFIER IS REUSED, NOT REWRITTEN. Phase 3H.5B1
// settled what a resend@6 error proves and what it does not, and a second
// copy of that reasoning would be a second place for it to be wrong. The
// name says 'subscription' because that family needed it first; the
// function is about the SDK, not about subscriptions.
import {
  classifySubscriptionEmailProviderError,
  type ProviderErrorLike,
} from "./subscriptionEmailDeliveryRules";
import type {
  AnnualPurchaseEmailDeliveryRow,
  AnnualPurchaseEmailDeps,
  AnnualPurchaseEmailMessage,
  AnnualPurchaseEmailPlanRow,
  AnnualPurchaseEmailProviderResult,
} from "./annualPurchaseConfirmationEmail";

/**
 * The real wiring behind the annual purchase confirmation (Phase 4B5).
 *
 * Kept apart from lib/annualPurchaseConfirmationEmail.ts on purpose, the
 * same way lib/annualPlanWebhookDeps.ts is kept apart from the settlement
 * flow: the modules imported here reach lib/supabase.ts, which reads
 * import.meta.env at module scope and so only loads under the bundler.
 * Isolating them means the send flow can be driven with in-memory ports,
 * which is how its ordering, its duplicate guarantees and its refusals are
 * proven without Supabase, without Resend and without a network.
 *
 * Every function below is a thin adapter. Not one of them decides
 * anything: the refusals live in lib/annualPurchaseConfirmationEmail.ts
 * where they can be executed by a test, the copy lives in
 * lib/email/annualPurchaseConfirmation.ts where it is pure, and the
 * authoritative decisions live in migration 039 where they hold a row lock.
 *
 * ── THE TWO WRITES ARE MIGRATION 039'S FUNCTIONS, AND ONLY ────
 *
 * There is no UPDATE on public.annual_plans in this file and there must
 * never be one. Migration 039 withholds a column-scoped UPDATE grant on
 * that table deliberately, so that every write to a paid contract goes
 * through a SECURITY DEFINER function that proves something first. A
 * direct write here would be the one place that stopped being true.
 */

/** A missing service-role client is an INFRASTRUCTURE failure, not "no work". */
function requireAdmin() {
  const admin = getSupabaseAdmin();
  if (!admin) throw new Error("supabase admin client is not configured");
  return admin;
}

/**
 * public.claim_annual_plan_purchase_email(uuid).
 *
 * A thin wrapper: one argument, and whatever jsonb it answers with,
 * unexamined. Interpreting the answer is a pure decision and lives in the
 * sender - including that 'claimed' is the only word that permits a send,
 * and that anything unrecognised fails closed.
 *
 * A database error THROWS rather than returning null. An unreachable claim
 * function is not "somebody else has it", and the sender's own handling
 * turns the throw into a reported failure with nothing sent.
 */
async function claimAnnualPurchaseEmail(annualPlanId: string): Promise<unknown> {
  const admin = requireAdmin();
  const { data, error } = await admin.rpc("claim_annual_plan_purchase_email", {
    p_annual_plan_id: annualPlanId,
  });
  if (error) throw new Error(`claim_annual_plan_purchase_email failed: ${error.message}`);
  return data;
}

/**
 * public.record_annual_plan_purchase_email_result(uuid, uuid, text).
 *
 * The claim token travels from the sender's local variable into this
 * argument and nowhere else. It is not logged here - the thrown message
 * carries the database's own text only - and it is not returned.
 */
async function recordAnnualPurchaseEmailResult(input: {
  annualPlanId: string;
  claimToken: string;
  outcome: "sent" | "failed";
}): Promise<unknown> {
  const admin = requireAdmin();
  const { data, error } = await admin.rpc("record_annual_plan_purchase_email_result", {
    p_annual_plan_id: input.annualPlanId,
    p_claim_token: input.claimToken,
    p_outcome: input.outcome,
  });
  if (error) {
    throw new Error(`record_annual_plan_purchase_email_result failed: ${error.message}`);
  }
  return data;
}

/**
 * The frozen plan, by id.
 *
 * Exactly the columns the message is rebuilt from. The webhook's own
 * lookup reads three columns and no money; this one reads the money and no
 * Stripe identity. Neither reads the address snapshots: a purchase
 * confirmation does not print a delivery address, so it does not load one.
 */
const PLAN_COLUMNS =
  "id, status, purchased_at, plan_end_at, currency, delivery_count, " +
  "annual_unit_gross_cents, shipping_per_delivery_gross_cents, " +
  "merchandise_total_gross_cents, shipping_total_gross_cents, total_gross_cents, " +
  "discount_percent_applied, customer_snapshot, delivery_items_snapshot";

async function loadAnnualPlanForPurchaseEmail(
  annualPlanId: string
): Promise<AnnualPurchaseEmailPlanRow | null> {
  const admin = requireAdmin();
  const { data, error } = await admin
    .from("annual_plans")
    .select(PLAN_COLUMNS)
    .eq("id", annualPlanId)
    .maybeSingle();
  if (error) throw new Error(`annual plan load failed: ${error.message}`);
  return (data as AnnualPurchaseEmailPlanRow | null) ?? null;
}

/**
 * The durable schedule - THE ONLY SOURCE OF ANY DATE IN THE MESSAGE.
 *
 * All thirteen rows, ordered by delivery number. Nothing downstream adds
 * hours to anything: the preflight picks the earliest row still at
 * 'scheduled' and reads its scheduled_for, so a DST boundary has nothing
 * to shift.
 */
async function loadAnnualDeliveriesForPurchaseEmail(
  annualPlanId: string
): Promise<AnnualPurchaseEmailDeliveryRow[]> {
  const admin = requireAdmin();
  const { data, error } = await admin
    .from("annual_plan_deliveries")
    .select("delivery_number, scheduled_for, state")
    .eq("annual_plan_id", annualPlanId)
    .order("delivery_number", { ascending: true });
  if (error) throw new Error(`annual plan schedule load failed: ${error.message}`);
  return (data as AnnualPurchaseEmailDeliveryRow[] | null) ?? [];
}

/**
 * Where the customer's thirteen deliveries appear.
 *
 * /account/orders, because that is where they genuinely are: migration
 * 039's fulfillment mints an ordinary order per delivery. There is no
 * annual-specific account screen yet, and linking to one that does not
 * exist would be worse than linking to the list that does. Null without
 * SITE_URL, and the template then omits the link rather than guessing an
 * origin - lib/siteUrl.ts explains why a request header is not a source.
 */
function buildAccountOrdersUrl(): string | null {
  const origin = getSiteOrigin();
  if (!origin) return null;
  return `${origin}/account/orders`;
}

/**
 * Renders the message and makes the one provider call.
 *
 * RENDERING HAPPENS HERE, not in the sender, because the account link is
 * the one fact that comes from the environment rather than from the
 * frozen contract, and the sender reads no environment. Everything the
 * template prints besides that link arrives in `facts`, already proved
 * against the durable rows.
 *
 * The established customer transactional convention, unchanged: the brand
 * voice sends, support takes replies. Identical to the order
 * confirmation, the shipment confirmation, the cancellation outcome, the
 * refund confirmation and the subscription start message.
 *
 * A MISSING API KEY IS A PROVEN NON-SEND. The provider was never
 * contacted, so no message can appear later and recording 'failed' cannot
 * produce a duplicate.
 */
async function sendAnnualPurchaseEmail(
  message: AnnualPurchaseEmailMessage
): Promise<AnnualPurchaseEmailProviderResult> {
  const resend = getResendClient();
  if (!resend) {
    return { kind: "definite_failure", message: "RESEND_API_KEY is not configured" };
  }

  const { subject, html, text } = buildAnnualPurchaseConfirmationEmail({
    plan: { ...message.facts, accountOrdersUrl: buildAccountOrdersUrl() },
  });

  const { error } = await resend.emails.send(
    {
      from: GLOA_FROM_HELLO,
      to: message.to,
      replyTo: GLOA_REPLY_TO_SUPPORT,
      subject,
      html,
      text,
    },
    // The provider-side duplicate guard. Deterministic per annual plan, so
    // a redelivery, a retry and a stale reclaim all present the same
    // value. Never the claim token, never the Stripe event id.
    { idempotencyKey: message.idempotencyKey }
  );

  if (!error) return { kind: "accepted" };

  // statusCode is the whole discriminator: a number means Resend answered,
  // null means fetch itself threw and the request may still have landed.
  const outcome = classifySubscriptionEmailProviderError(error as ProviderErrorLike);
  return outcome === "definite_failure"
    ? { kind: "definite_failure", message: error.message }
    : { kind: "ambiguous", message: error.message };
}

/** The wiring, assembled once. */
export const annualPurchaseEmailDeps: AnnualPurchaseEmailDeps = {
  claim: claimAnnualPurchaseEmail,
  loadPlan: loadAnnualPlanForPurchaseEmail,
  loadDeliveries: loadAnnualDeliveriesForPurchaseEmail,
  sendEmail: sendAnnualPurchaseEmail,
  recordResult: recordAnnualPurchaseEmailResult,
};
