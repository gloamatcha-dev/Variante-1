/**
 * THE REAL WORLD, FOR lib/withdrawalSubmission.ts.
 *
 * Everything that touches Supabase or Resend lives here, so the decision
 * layer beside it stays a pure function of its inputs and the route
 * above it stays a parser. The same split lib/annualPlanCheckoutDeps.ts
 * uses, for the same reason: the interesting behaviour is testable
 * without a network.
 *
 * ── THE LOOKUP IS DELIBERATELY NARROW ────────────────────────
 *
 * findContractByReference reads ONE order by its order_number and
 * returns four fields. It does not search, does not match partially,
 * does not fall back to an email-only lookup and returns nothing about
 * any other order. A reference that matches nothing returns null, which
 * the decision layer treats as a normal outcome.
 */

import { getSupabaseAdmin } from "./supabaseAdmin";
import { getSiteOrigin } from "./siteUrl";
import { getResendClient } from "./resend";
import { buildWithdrawalConfirmationEmail } from "./email/withdrawalConfirmation";
import type {
  WithdrawalSubmissionDeps,
  ResolvedContract,
  AnnualPlanDelivery,
  WithdrawalCaseRow,
  ConfirmationInput,
} from "./withdrawalSubmission";

type Admin = NonNullable<ReturnType<typeof getSupabaseAdmin>>;

/**
 * The order behind a typed reference, plus the annual plan it belongs to
 * if it is a delivery of one.
 *
 * The contact address comes from the order's own customer_snapshot,
 * which is what the customer gave us at checkout - not from
 * auth.users, because a guest order has no account to read.
 */
async function findContractByReference(
  admin: Admin,
  reference: string
): Promise<ResolvedContract | null> {
  const { data, error } = await admin
    .from("orders")
    .select("id, user_id, customer_snapshot, delivered_at")
    .eq("order_number", reference)
    .maybeSingle();

  if (error || !data) return null;

  const snapshot = (data.customer_snapshot ?? {}) as Record<string, unknown>;
  const email = typeof snapshot.email === "string" ? snapshot.email : null;

  // Is this order one of an annual plan's deliveries?
  const { data: delivery } = await admin
    .from("annual_plan_deliveries")
    .select("annual_plan_id")
    .eq("order_id", data.id)
    .maybeSingle();

  return {
    orderId: data.id as string,
    userId: (data.user_id as string | null) ?? null,
    contactEmail: email,
    annualPlanId: (delivery?.annual_plan_id as string | undefined) ?? null,
    deliveredAt: (data.delivered_at as string | null) ?? null,
  };
}

/**
 * Every delivery of a plan with the receipt of the ORDER it minted.
 *
 * Read in full rather than filtered to number one, because which row
 * starts the period is a legal decision and belongs in
 * firstDeliveryReceiptOf, not in a SQL predicate somebody could later
 * "optimise" into reading the earliest delivered_at.
 */
async function annualPlanDeliveries(
  admin: Admin,
  annualPlanId: string
): Promise<AnnualPlanDelivery[]> {
  const { data, error } = await admin
    .from("annual_plan_deliveries")
    .select("delivery_number, order_id")
    .eq("annual_plan_id", annualPlanId);

  if (error || !data) return [];

  const orderIds = data.map(d => d.order_id).filter((v): v is string => typeof v === "string");
  const receipts = new Map<string, string | null>();
  if (orderIds.length > 0) {
    const { data: orders } = await admin
      .from("orders")
      .select("id, delivered_at")
      .in("id", orderIds);
    for (const o of orders ?? []) {
      receipts.set(o.id as string, (o.delivered_at as string | null) ?? null);
    }
  }

  return data.map(d => ({
    deliveryNumber: d.delivery_number as number,
    deliveredAt: typeof d.order_id === "string" ? receipts.get(d.order_id) ?? null : null,
  }));
}

export function buildWithdrawalSubmissionDeps(admin: Admin): WithdrawalSubmissionDeps {
  return {
    findContractByReference: reference => findContractByReference(admin, reference),

    annualPlanDeliveries: planId => annualPlanDeliveries(admin, planId),

    findByIdempotencyKey: async key => {
      const { data, error } = await admin
        .from("withdrawal_requests")
        .select("id, submitted_at")
        .eq("idempotency_key", key)
        .maybeSingle();
      if (error || !data) return null;
      return { id: data.id as string, submittedAt: data.submitted_at as string };
    },

    insertCase: async (row: WithdrawalCaseRow) => {
      const { data, error } = await admin
        .from("withdrawal_requests")
        .insert(row)
        .select("id, submitted_at")
        .single();
      if (error || !data) {
        throw new Error(`withdrawal case insert failed: ${error?.message ?? "no row"}`);
      }
      return { id: data.id as string, submittedAt: data.submitted_at as string };
    },

    // The freeze is a database function, not an UPDATE from here: the
    // rule about which cases may freeze lives next to the column.
    freezeDeliveries: async caseId => {
      const { error } = await admin.rpc("freeze_annual_deliveries_for_withdrawal", {
        p_withdrawal_id: caseId,
      });
      if (error) throw new Error(`freeze failed: ${error.message}`);
    },

    sendConfirmation: async (input: ConfirmationInput) => {
      const resend = getResendClient();
      const fromAddress = process.env.RESEND_CONTACT_FROM;
      if (!resend || !fromAddress) {
        console.error("Withdrawal confirmation email: RESEND_API_KEY or RESEND_CONTACT_FROM is not configured.");
        return false;
      }
      const { subject, html, text } = buildWithdrawalConfirmationEmail({
        origin: getSiteOrigin() ?? undefined,
        customerName: input.customerName,
        orderReference: input.orderReference,
        scope: input.scope,
        scopeNote: input.scopeNote,
        customerNote: input.customerNote,
        submittedAt: input.submittedAt,
      });
      try {
        const { error } = await resend.emails.send({
          from: fromAddress,
          to: input.contactEmail,
          replyTo: "hello@gloamatcha.com",
          subject, html, text,
        });
        if (error) {
          console.error(`Withdrawal confirmation email: send failed for ${input.caseId}:`, error.message);
          return false;
        }
        return true;
      } catch (err) {
        console.error(
          `Withdrawal confirmation email: send failed for ${input.caseId}:`,
          err instanceof Error ? err.message : err
        );
        return false;
      }
    },

    markConfirmation: async (caseId, sent) => {
      const { error } = await admin
        .from("withdrawal_requests")
        .update({
          confirmation_status: sent ? "sent" : "failed",
          confirmed_at: sent ? new Date().toISOString() : null,
        })
        .eq("id", caseId);
      if (error) {
        console.error(`Withdrawal error: could not update confirmation status for ${caseId}:`, error.message);
      }
    },
  };
}
