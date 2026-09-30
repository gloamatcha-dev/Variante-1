import { getSupabaseAdmin } from "../../../../lib/supabaseAdmin";
import { requireAdminIdentity } from "../../../../lib/adminActionRoute.ts";
import { getSiteOrigin } from "../../../../lib/siteUrl";
import { getResendClient } from "../../../../lib/resend";
import { buildWithdrawalReturnReceivedEmail } from "../../../../lib/email/withdrawalReturnReceived";
import { buildWithdrawalRefundCompletedEmail } from "../../../../lib/email/withdrawalRefundCompleted";
import {
  markOrderDelivered,
  setSealState,
  setReturnRequirement,
  recordReturn,
  confirmValueLoss,
  approveWithdrawalRefund,
  advanceComplaint,
  reviewTermination,
  createPurchaseRestriction,
  liftPurchaseRestriction,
  type CustomerRightsAdminDeps,
} from "../../../../lib/customerRightsAdminActions";

/**
 * THE CONSUMER RIGHTS DESK, FOR THE OPERATOR AND NOBODY ELSE.
 *
 * POST only, behind the admin-identity gate, in the same shape as
 * /api/admin/annual-plans and /api/admin/subscriptions.
 *
 * ══════════════════════════════════════════════════════════════
 * EVERY WRITE GOES THROUGH MIGRATION 070's SQL WRITERS
 * ══════════════════════════════════════════════════════════════
 *
 * There is no .update, .insert or .delete anywhere in this file. The
 * route reads for the list and otherwise only calls RPCs - which is
 * what keeps the rules (the value-loss ceiling, the payout
 * preconditions, the double-refund index, the audit entry) in the
 * database where every caller gets them, rather than here where this
 * route would be the only caller that does.
 *
 * ── THE ACTOR IS NEVER TAKEN FROM THE BODY ───────────────────
 *
 * p_actor_user_id is the verified admin session's user id, always. A
 * browser cannot author a decision in somebody else's name, and
 * record_admin_activity additionally refuses an actor that is not an
 * ACTIVE admin_users row.
 *
 * ── AND NO AMOUNT IS EITHER ──────────────────────────────────
 *
 * The refund action takes no amount. It calls
 * admin_approve_withdrawal_refund, which derives the figure from the
 * plan's own total minus the confirmed value loss. A confirmed value
 * loss IS accepted from the operator - that is the decision they are
 * there to make - but the database refuses anything above the frozen
 * retail ceiling it computes itself.
 *
 * ── IT PREPARES A PAYOUT. IT DOES NOT PAY. ───────────────────
 *
 * There is no Stripe import in this file. Approving marks the case
 * approved_for_payout and stamps one refund_operation_id; moving the
 * money is a separate, explicit step that does not exist yet.
 */

type ErrorResponse = { error: string };

function json(body: unknown, status: number): Response {
  return Response.json(body, { status });
}

/** The columns the desk shows. Internal notes are included - this is the admin. */
const WITHDRAWAL_COLUMNS =
  "id, customer_name, contact_email, order_reference, scope, scope_note, customer_note, "
  + "submitted_at, confirmation_status, resolved_order_id, resolved_user_id, "
  + "resolved_annual_plan_id, resolution_method, case_state, timeliness, "
  + "deadline_start_at, deadline_date, deadline_basis, seal_state, return_requirement, "
  + "return_dispatch_proof_at, return_received_at, suggested_value_loss_cents, "
  + "confirmed_value_loss_cents, value_loss_confirmed_at, refund_amount_cents, "
  + "refund_state, refund_executed_at, deliveries_frozen_at, internal_note, updated_at";

const COMPLAINT_COLUMNS =
  "id, customer_name, contact_email, order_reference, resolved_order_id, reason, "
  + "customer_note, case_state, seller_bears_transport_cost, submitted_at, "
  + "confirmation_status, internal_note, updated_at";

const TERMINATION_COLUMNS =
  "id, termination_kind, customer_name, contact_email, contract_reference, "
  + "resolved_user_id, resolved_subscription_id, resolved_annual_plan_id, contract_kind, "
  + "requested_end_at, extraordinary_reason, case_state, submitted_at, "
  + "confirmation_status, internal_note, updated_at";

const RESTRICTION_COLUMNS =
  "id, user_id, scope, reason_category, internal_note, created_at, created_by, "
  + "expires_at, active, lifted_at, lifted_by";

const PAGE_CAP = 100;

export async function POST(request: Request): Promise<Response> {
  // READ_SENSITIVE, not "read". This desk shows customer billing data -
  // what was paid, what is being refunded, what an operator deducted -
  // which is the same class of data /api/admin/annual-plans protects, so
  // a viewer may not open it. Every write below re-gates at "write".
  const gate = await requireAdminIdentity(request, "read_sensitive");
  if (!gate.ok) return gate.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Ungültige Anfrage." } as ErrorResponse, 400);
  }
  if (!body || typeof body !== "object") {
    return json({ error: "Ungültige Anfrage." } as ErrorResponse, 400);
  }
  const { action } = body as Record<string, unknown>;

  const admin = getSupabaseAdmin();
  if (!admin) {
    console.error("Customer rights: Supabase admin client is not configured.");
    return json({ error: "Nicht verfügbar." } as ErrorResponse, 503);
  }

  /* ── THE LIST ───────────────────────────────────────────────── */
  if (action === "list" || action === undefined) {
    const [withdrawals, complaints, terminations, restrictions] = await Promise.all([
      admin.from("withdrawal_requests").select(WITHDRAWAL_COLUMNS)
        .order("submitted_at", { ascending: false }).limit(PAGE_CAP),
      admin.from("complaint_requests").select(COMPLAINT_COLUMNS)
        .order("submitted_at", { ascending: false }).limit(PAGE_CAP),
      admin.from("termination_requests").select(TERMINATION_COLUMNS)
        .order("submitted_at", { ascending: false }).limit(PAGE_CAP),
      admin.from("purchase_restrictions").select(RESTRICTION_COLUMNS)
        .order("created_at", { ascending: false }).limit(PAGE_CAP),
    ]);

    for (const r of [withdrawals, complaints, terminations, restrictions]) {
      if (r.error) {
        console.error("Customer rights: list failed -", r.error.message);
        return json({ error: "Nicht verfügbar." } as ErrorResponse, 503);
      }
    }

    // The delivery facts a withdrawal case is judged against, for the
    // orders those cases actually resolved to. One extra query, not one
    // per row.
    const withdrawalRows = (withdrawals.data ?? []) as unknown as Array<Record<string, unknown>>;
    const orderIds = withdrawalRows
      .map(w => w.resolved_order_id).filter((v): v is string => typeof v === "string");
    let orders: unknown[] = [];
    if (orderIds.length > 0) {
      const { data } = await admin
        .from("orders")
        .select("id, order_number, shipped_at, delivered_at, delivery_receipt_source, "
              + "delivery_recorded_at, total_gross_cents")
        .in("id", orderIds);
      orders = data ?? [];
    }

    // The frozen retail price behind each case's Wertersatz ceiling.
    const planIds = withdrawalRows
      .map(w => w.resolved_annual_plan_id).filter((v): v is string => typeof v === "string");
    let plans: unknown[] = [];
    if (planIds.length > 0) {
      const { data } = await admin
        .from("annual_plans")
        .select("id, catalog_unit_gross_cents, annual_unit_gross_cents, "
              + "shipping_per_delivery_gross_cents, total_gross_cents, delivery_count, "
              + "schedule_model, status, payment_status")
        .in("id", planIds);
      plans = data ?? [];
    }

    return json({
      ok: true,
      withdrawals: withdrawals.data ?? [],
      complaints: complaints.data ?? [],
      terminations: terminations.data ?? [],
      restrictions: restrictions.data ?? [],
      orders,
      plans,
    }, 200);
  }

  /* ── THE WRITES ─────────────────────────────────────────────── */
  const writeGate = await requireAdminIdentity(request, "write");
  if (!writeGate.ok) return writeGate.response;
  const actorUserId = writeGate.session.userId;

  const deps: CustomerRightsAdminDeps = {
    rpc: async (fn, args) => {
      const { data, error } = await admin.rpc(fn, args);
      if (error) throw new Error(`${fn}: ${error.message}`);
      return (data ?? { result: "unknown" }) as { result: string };
    },
    loadCaseContact: async withdrawalId => {
      const { data } = await admin
        .from("withdrawal_requests")
        .select("customer_name, contact_email, order_reference")
        .eq("id", withdrawalId)
        .maybeSingle();
      if (!data) return null;
      return {
        customerName: data.customer_name as string,
        contactEmail: data.contact_email as string,
        orderReference: data.order_reference as string,
      };
    },
    sendMail: async (to, mail) => {
      const resend = getResendClient();
      const from = process.env.RESEND_CONTACT_FROM;
      if (!resend || !from) {
        console.error("Customer rights mail: RESEND_API_KEY or RESEND_CONTACT_FROM is not configured.");
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
  };

  const b = body as Record<string, unknown>;
  const str = (k: string): string => (typeof b[k] === "string" ? (b[k] as string) : "");

  try {
    switch (action) {
      case "mark_delivered":
        return json(await markOrderDelivered(deps, {
          actorUserId, orderNumber: str("orderNumber"), deliveredAt: str("deliveredAt"),
          source: str("source") || undefined,
        }), 200);

      case "set_seal_state":
        return json(await setSealState(deps, {
          actorUserId, withdrawalId: str("withdrawalId"),
          sealState: str("sealState") as "sealed_unopened" | "opened_seal_broken",
        }), 200);

      case "set_return_requirement":
        return json(await setReturnRequirement(deps, {
          actorUserId, withdrawalId: str("withdrawalId"),
          requirement: str("requirement") as "return_requested" | "return_not_required",
        }), 200);

      case "record_return":
        return json(await recordReturn(deps, {
          actorUserId, withdrawalId: str("withdrawalId"),
          event: str("event") as "dispatch_proof" | "received",
          at: str("at") || undefined,
          buildReturnReceivedMail: args => buildWithdrawalReturnReceivedEmail({
            origin: getSiteOrigin() ?? undefined, ...args,
          }),
        }), 200);

      case "confirm_value_loss": {
        const cents = Number(b.confirmedCents);
        if (!Number.isSafeInteger(cents) || cents < 0) {
          return json({ error: "Ungültiger Betrag." } as ErrorResponse, 400);
        }
        return json(await confirmValueLoss(deps, {
          actorUserId, withdrawalId: str("withdrawalId"), confirmedCents: cents,
        }), 200);
      }

      // NOTE: no amount parameter. The database derives it.
      case "approve_refund":
        return json(await approveWithdrawalRefund(deps, {
          actorUserId, withdrawalId: str("withdrawalId"),
          buildRefundMail: args => buildWithdrawalRefundCompletedEmail({
            origin: getSiteOrigin() ?? undefined, ...args,
          }),
        }), 200);

      case "advance_complaint":
        return json(await advanceComplaint(deps, {
          actorUserId, complaintId: str("complaintId"),
          caseState: str("caseState"), internalNote: str("internalNote") || null,
        }), 200);

      case "review_termination":
        return json(await reviewTermination(deps, {
          actorUserId, terminationId: str("terminationId"),
          caseState: str("caseState"), internalNote: str("internalNote") || null,
        }), 200);

      case "create_restriction":
        return json(await createPurchaseRestriction(deps, {
          actorUserId, userId: str("userId"), scope: str("scope"),
          reasonCategory: str("reasonCategory"),
          internalNote: str("internalNote") || null,
          expiresAt: str("expiresAt") || null,
        }), 200);

      case "lift_restriction":
        return json(await liftPurchaseRestriction(deps, {
          actorUserId, restrictionId: str("restrictionId"),
        }), 200);

      default:
        return json({ error: "Unbekannte Aktion." } as ErrorResponse, 400);
    }
  } catch (err) {
    console.error("Customer rights: action failed -", err instanceof Error ? err.message : err);
    return json({ error: "Aktion fehlgeschlagen." } as ErrorResponse, 503);
  }
}
