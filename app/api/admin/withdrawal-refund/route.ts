import Stripe from "stripe";
import { getSupabaseAdmin } from "../../../../lib/supabaseAdmin";
import { requireAdminIdentity } from "../../../../lib/adminActionRoute.ts";
import {
  executeWithdrawalRefund,
  type WithdrawalRefundExecutionDeps,
} from "../../../../lib/withdrawalRefundExecution";

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
 *   { "action": "execute_refund", "withdrawalId": "<uuid>" }
 *
 * That is the whole contract. THERE IS NO AMOUNT FIELD, and adding one
 * would change nothing: lib/withdrawalRefundExecution re-reads the
 * approved figure from the database immediately before calling Stripe
 * and has no parameter through which another could arrive.
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
 * ── AND IT SENDS NOTHING ─────────────────────────────────────
 *
 * The customer was already told at APPROVAL, by a mail whose subject is
 * "Deine Erstattung ist veranlasst" - which was true when it was sent
 * and is still true now. A second mail when the API call returns would
 * tell them nothing they do not already know, so there is no Resend
 * import in this file either.
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
  if (b.action !== "execute_refund") {
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

  try {
    const outcome = await executeWithdrawalRefund(deps, { actorUserId, withdrawalId });
    return json(outcome, 200);
  } catch (err) {
    console.error(
      "Withdrawal refund: execution failed -",
      err instanceof Error ? err.message : err
    );
    return json({ error: "Aktion fehlgeschlagen." } as ErrorResponse, 503);
  }
}
