import Stripe from "stripe";
import { getSupabaseAdmin } from "../../../../lib/supabaseAdmin";
import { requireAdminIdentity } from "../../../../lib/adminActionRoute.ts";
import { getSiteOrigin } from "../../../../lib/siteUrl";
import { getResendClient } from "../../../../lib/resend";
import { buildWithdrawalRefundCompletedEmail } from "../../../../lib/email/withdrawalRefundCompleted";
import {
  executeWithdrawalRefund,
  type WithdrawalRefundExecutionDeps,
} from "../../../../lib/withdrawalRefundExecution";
import {
  sendWithdrawalRefundCompletedIfNeeded,
  type WithdrawalRefundCompletionDeps,
  type ClaimedRefundCompletion,
} from "../../../../lib/withdrawalRefundCompletionEmail";

/**
 * THE PAYOUT ENDPOINT, AND THE ONLY ONE.
 *
 * Separate from /api/admin/customer-rights on purpose. That desk
 * DECIDES cases and deliberately contains no Stripe import, so no
 * amount of clicking around it can move money. This route is the single
 * place where a decision the database already made becomes a refund,
 * and it accepts exactly one action.
 *
 * ── WHAT THE BROWSER MAY SEND ────────────────────────────────
 *
 *   { "action": "execute_refund",          "withdrawalId": "<uuid>" }
 *   { "action": "retry_completion_email",  "withdrawalId": "<uuid>" }
 *
 * That is the whole contract. THERE IS NO AMOUNT FIELD in either, and
 * adding one would change nothing: lib/withdrawalRefundExecution
 * re-reads the approved figure from the database immediately before
 * calling Stripe and has no parameter through which another could
 * arrive.
 *
 * THE SECOND ACTION EXISTS SO A FAILED MAIL IS NOT A LOST MAIL. If
 * Stripe succeeded and Resend did not, the money is gone and the
 * customer has not been told - and fixing that must not risk a second
 * refund. retry_completion_email therefore does not touch Stripe at
 * all: it calls only the mail sender, whose claim re-wins a 'failed'
 * status and cannot be won at any other time.
 *
 * ── AND THE ACTOR IS THE SESSION, NEVER THE BODY ─────────────
 *
 * "write" is the strongest capability the role model has, and this
 * route asks for it before it reads the body - so a viewer is refused
 * without the request ever being parsed. p_actor_user_id is the
 * verified session's user id, and record_admin_activity refuses an
 * actor that is not an ACTIVE admin_users row, which rolls the whole
 * transaction back.
 *
 * ── IDEMPOTENCY IS THE DATABASE'S, NOT THIS ROUTE'S ──────────
 *
 * refund_operation_id was stamped once at approval under a unique
 * index, and it is what goes to Stripe as the idempotency key. A
 * double-click, a retried fetch and a replayed request therefore all
 * reach the SAME Stripe refund. This route adds no lock of its own
 * because it does not need one.
 *
 * ── AND THE ONE MAIL THAT SAYS THE MONEY WENT ────────────────
 *
 * "Deine Erstattung ist durchgeführt" is sent from here, after Stripe
 * confirmed AND the database persisted 'executed' - never at approval,
 * where a decline was still possible and the sentence would have been
 * untrue.
 *
 * Sending it is safe to attempt on every call, including a replayed one:
 * the claim inside lib/withdrawalRefundCompletionEmail.ts is a single
 * conditional UPDATE, so two concurrent requests cannot both win it and
 * a case whose mail already went loses it. A send failure leaves the
 * refund 'executed' and the mail retryable; it never reverses a payout.
 */

type ErrorResponse = { error: string };

function json(body: unknown, status: number): Response {
  return Response.json(body, { status });
}

/** The fields a payout needs, and no others. */
const SNAPSHOT_COLUMNS =
  "id, refund_state, refund_amount_cents, refund_operation_id, "
  + "resolved_order_id, resolved_annual_plan_id";

export async function POST(request: Request): Promise<Response> {
  const gate = await requireAdminIdentity(request, "write");
  if (!gate.ok) return gate.response;
  const actorUserId = gate.session.userId;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Ungültige Anfrage." } as ErrorResponse, 400);
  }
  if (!body || typeof body !== "object") {
    return json({ error: "Ungültige Anfrage." } as ErrorResponse, 400);
  }
  const b = body as Record<string, unknown>;
  const action = b.action;
  if (action !== "execute_refund" && action !== "retry_completion_email") {
    return json({ error: "Unbekannte Aktion." } as ErrorResponse, 400);
  }
  const withdrawalId = typeof b.withdrawalId === "string" ? b.withdrawalId.trim() : "";
  if (withdrawalId === "") {
    return json({ error: "Kein Fall angegeben." } as ErrorResponse, 400);
  }

  const admin = getSupabaseAdmin();
  if (!admin) {
    console.error("Withdrawal refund: Supabase admin client is not configured.");
    return json({ error: "Nicht verfügbar." } as ErrorResponse, 503);
  }
  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) {
    console.error("Withdrawal refund: STRIPE_SECRET_KEY is not configured.");
    return json({ error: "Nicht verfügbar." } as ErrorResponse, 503);
  }
  const stripe = new Stripe(secret);

  const deps: WithdrawalRefundExecutionDeps = {
    async loadApprovedRefund(id) {
      const { data, error } = await admin
        .from("withdrawal_requests")
        .select(SNAPSHOT_COLUMNS)
        .eq("id", id)
        .maybeSingle();
      if (error || !data) return null;
      const row = data as unknown as Record<string, unknown>;

      // THE PAYMENT REFERENCE COMES FROM THE CONTRACT, not from the
      // case row and not from the request. One extra read, so that the
      // intent being refunded is provably the one the money arrived on.
      let paymentIntentId: string | null = null;
      let paymentBasis: "annual_plan" | "order" | "unresolved" = "unresolved";
      if (typeof row.resolved_annual_plan_id === "string") {
        const { data: plan } = await admin
          .from("annual_plans")
          .select("stripe_payment_intent_id")
          .eq("id", row.resolved_annual_plan_id)
          .maybeSingle();
        const pi = plan?.stripe_payment_intent_id;
        paymentIntentId = typeof pi === "string" && pi.trim() !== "" ? pi.trim() : null;
        paymentBasis = "annual_plan";
      } else if (typeof row.resolved_order_id === "string") {
        const { data: order } = await admin
          .from("orders")
          .select("stripe_payment_intent_id")
          .eq("id", row.resolved_order_id)
          .maybeSingle();
        const pi = order?.stripe_payment_intent_id;
        paymentIntentId = typeof pi === "string" && pi.trim() !== "" ? pi.trim() : null;
        paymentBasis = "order";
      }

      return {
        withdrawalId: String(row.id),
        refundState: String(row.refund_state ?? "not_started"),
        refundAmountCents:
          typeof row.refund_amount_cents === "number" ? row.refund_amount_cents : null,
        refundOperationId:
          typeof row.refund_operation_id === "string" ? row.refund_operation_id : null,
        paymentIntentId,
        paymentBasis,
      };
    },

    async createProviderRefund({ paymentIntentId, amountCents, idempotencyKey }) {
      try {
        const refund = await stripe.refunds.create(
          { payment_intent: paymentIntentId, amount: amountCents },
          { idempotencyKey }
        );
        // A refund Stripe itself calls failed is not evidence of a payout.
        if (refund.status === "failed" || refund.status === "canceled") {
          return { ok: false, reason: `stripe_refund_${refund.status}` };
        }
        return {
          ok: true,
          reference: String(refund.id),
          amountCents: typeof refund.amount === "number" ? refund.amount : -1,
        };
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : "stripe_error" };
      }
    },

    async recordExecution({ withdrawalId: id, providerReference, providerAmountCents }) {
      const { data, error } = await admin.rpc("admin_record_withdrawal_refund_execution", {
        p_actor_user_id: actorUserId,
        p_withdrawal_id: id,
        p_provider_reference: providerReference,
        p_provider_amount_cents: providerAmountCents,
      });
      if (error) throw new Error(`admin_record_withdrawal_refund_execution: ${error.message}`);
      return (data ?? { result: "unknown" }) as { result: string };
    },

    async recordFailure({ withdrawalId: id, reason }) {
      const { data, error } = await admin.rpc("admin_record_withdrawal_refund_failure", {
        p_actor_user_id: actorUserId,
        p_withdrawal_id: id,
        p_reason: reason,
      });
      if (error) throw new Error(`admin_record_withdrawal_refund_failure: ${error.message}`);
      return (data ?? { result: "unknown" }) as { result: string };
    },
  };

  /* ── THE COMPLETION MAIL ─────────────────────────────────────── */

  const mailDeps: WithdrawalRefundCompletionDeps = {
    async claim(id) {
      const { data, error } = await admin.rpc("claim_withdrawal_refund_completed_email", {
        p_withdrawal_id: id,
      });
      if (error) throw new Error(`claim_withdrawal_refund_completed_email: ${error.message}`);
      const row = (data ?? {}) as Record<string, unknown>;
      // NOT CLAIMED is not an error. It is the ordinary answer for a case
      // whose mail already went, whose mail is being sent right now, or
      // whose refund has not executed - and the caller does the same
      // thing in all three: nothing.
      if (row.result !== "claimed") return null;

      // The scope facts the one scope-dependent sentence needs. Read
      // separately because the claim returns only what it locked.
      const { data: scopeRow } = await admin
        .from("withdrawal_requests")
        .select("scope, partial_shipping_treatment")
        .eq("id", id)
        .maybeSingle();
      const scope = scopeRow?.scope === "partial" ? "partial" : "whole_order";

      return {
        contactEmail: String(row.contact_email ?? ""),
        customerName: String(row.customer_name ?? ""),
        orderReference: String(row.order_reference ?? ""),
        refundAmountCents: Number(row.refund_amount_cents ?? 0),
        valueLossCents: Number(row.value_loss_cents ?? 0),
        refundProviderReference: String(row.refund_provider_reference ?? ""),
        refundExecutedAt: typeof row.refund_executed_at === "string"
          ? row.refund_executed_at : null,
        refundScope: scope,
        shippingIncluded: scope === "partial"
          ? scopeRow?.partial_shipping_treatment === "refund_outbound_shipping"
          : true,
      } satisfies ClaimedRefundCompletion;
    },

    buildMail: args => buildWithdrawalRefundCompletedEmail({
      origin: getSiteOrigin() ?? undefined, ...args,
    }),

    async sendMail(to, mail) {
      const resend = getResendClient();
      const from = process.env.RESEND_CONTACT_FROM;
      if (!resend || !from) {
        console.error("Withdrawal refund mail: RESEND_API_KEY or RESEND_CONTACT_FROM is not configured.");
        return false;
      }
      try {
        const { error } = await resend.emails.send({
          from, to, replyTo: "hello@gloamatcha.com", ...mail,
        });
        return !error;
      } catch {
        return false;
      }
    },

    async markSent(id) {
      const { error } = await admin.rpc("mark_withdrawal_refund_completed_email_sent", {
        p_withdrawal_id: id,
      });
      if (error) throw new Error(`mark_withdrawal_refund_completed_email_sent: ${error.message}`);
    },

    async markFailed(id) {
      const { error } = await admin.rpc("mark_withdrawal_refund_completed_email_failed", {
        p_withdrawal_id: id,
      });
      if (error) throw new Error(`mark_withdrawal_refund_completed_email_failed: ${error.message}`);
    },
  };

  /* ── DISPATCH ────────────────────────────────────────────────── */

  // THE MAIL-ONLY PATH, which reaches no payment provider. Declared
  // before the payout so that reading this file top to bottom shows the
  // retry cannot become a second refund.
  if (action === "retry_completion_email") {
    try {
      const mailResult = await sendWithdrawalRefundCompletedIfNeeded(mailDeps, { withdrawalId });
      return json({ result: "completion_email", completion_email: mailResult }, 200);
    } catch (err) {
      console.error(
        "Withdrawal refund: completion mail retry failed -",
        err instanceof Error ? err.message : err
      );
      return json({ error: "Aktion fehlgeschlagen." } as ErrorResponse, 503);
    }
  }

  try {
    const outcome = await executeWithdrawalRefund(deps, { actorUserId, withdrawalId });

    // ATTEMPTED AFTER EVERY PAYOUT CALL, INCLUDING A REPLAYED ONE. The
    // claim is what decides whether anything is actually sent, so this
    // needs no condition of its own - and a payout that did not execute
    // simply cannot win it.
    let completionEmail: string | undefined;
    try {
      completionEmail = await sendWithdrawalRefundCompletedIfNeeded(mailDeps, { withdrawalId });
    } catch (err) {
      // The money moved. A mail problem is reported, never allowed to
      // turn a completed refund into a failed request.
      console.error(
        "Withdrawal refund: completion mail failed -",
        err instanceof Error ? err.message : err
      );
      completionEmail = "failed";
    }

    return json({ ...outcome, completion_email: completionEmail }, 200);
  } catch (err) {
    console.error(
      "Withdrawal refund: execution failed -",
      err instanceof Error ? err.message : err
    );
    return json({ error: "Aktion fehlgeschlagen." } as ErrorResponse, 503);
  }
}
