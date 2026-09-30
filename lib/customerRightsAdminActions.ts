/**
 * WHAT AN ADMINISTRATOR CAN ACTUALLY DO TO A CASE.
 *
 * Every function here is a thin, injected wrapper around one of
 * migration 070's audited SQL writers. The rules live in the database -
 * the value-loss ceiling, the payout preconditions, the double-refund
 * index - so this layer cannot weaken them by forgetting one. What it
 * adds is the part SQL cannot do: telling the customer.
 *
 * ── TWO OF THE SIX MAILS ARE TRIGGERED FROM HERE ─────────────
 *
 * "Rücksendung erhalten" and "Erstattung durchgeführt" are consequences
 * of an ADMIN decision, not of a customer submission, so they are sent
 * where that decision is made. The other four hang off the public
 * routes.
 *
 * ── AND THE MAIL NEVER DECIDES ANYTHING ──────────────────────
 *
 * The figures in the refund mail are the ones the database returned
 * from admin_approve_withdrawal_refund. Nothing here computes an
 * amount, and a send failure is reported rather than allowed to roll
 * back a decision that has already been recorded.
 *
 * ── THE STRIPE BOUNDARY ──────────────────────────────────────
 *
 * approveWithdrawalRefund PREPARES a payout and stops. It marks the
 * case approved_for_payout and stamps one refund_operation_id. Actually
 * moving money is a separate, explicit step that is deliberately NOT in
 * this file - so no admin screen, and no accidental second click, can
 * reach Stripe through here.
 */

import type { RefundBreakdown } from "./withdrawalCase";

/** The shape every writer answers with. */
export type WriterResult = { result: string } & Record<string, unknown>;

export type CustomerRightsAdminDeps = {
  /** Calls one of migration 070's SQL functions by name. */
  rpc: (fn: string, args: Record<string, unknown>) => Promise<WriterResult>;
  /** Reads the fields a customer mail needs. Never used for a decision. */
  loadCaseContact: (withdrawalId: string) => Promise<{
    customerName: string;
    contactEmail: string;
    orderReference: string;
  } | null>;
  /** Sends one already-built mail. Returns whether it went. */
  sendMail: (to: string, mail: { subject: string; html: string; text: string }) => Promise<boolean>;
  /** Injected so a test needs no clock. */
  now?: () => Date;
};

/* ── Delivery receipt ─────────────────────────────────────────── */

/**
 * Record that the customer received an order.
 *
 * Reuses migration 070's admin_mark_order_delivered, which refuses a
 * future date, refuses a receipt before dispatch and is idempotent.
 * There is no second path to delivered_at anywhere in the codebase.
 */
export async function markOrderDelivered(
  deps: CustomerRightsAdminDeps,
  input: { actorUserId: string; orderNumber: string; deliveredAt: string; source?: string }
): Promise<WriterResult> {
  return deps.rpc("admin_mark_order_delivered", {
    p_actor_user_id: input.actorUserId,
    p_order_number: input.orderNumber,
    p_delivered_at: input.deliveredAt,
    p_source: input.source ?? "admin_manual",
  });
}

/* ── The goods ────────────────────────────────────────────────── */

export async function setSealState(
  deps: CustomerRightsAdminDeps,
  input: { actorUserId: string; withdrawalId: string; sealState: "sealed_unopened" | "opened_seal_broken" }
): Promise<WriterResult> {
  return deps.rpc("admin_set_withdrawal_seal_state", {
    p_actor_user_id: input.actorUserId,
    p_withdrawal_id: input.withdrawalId,
    p_seal_state: input.sealState,
  });
}

export async function setReturnRequirement(
  deps: CustomerRightsAdminDeps,
  input: {
    actorUserId: string; withdrawalId: string;
    requirement: "return_requested" | "return_not_required";
  }
): Promise<WriterResult> {
  return deps.rpc("admin_set_withdrawal_return_requirement", {
    p_actor_user_id: input.actorUserId,
    p_withdrawal_id: input.withdrawalId,
    p_requirement: input.requirement,
  });
}

/**
 * Record proof of dispatch, or the parcel actually arriving.
 *
 * ARRIVAL SENDS THE CUSTOMER A MAIL. Proof of dispatch does not: it is
 * a fact about their evidence, not about our goods, and telling them
 * "wir haben deinen Beleg" adds nothing they did not just do.
 */
export async function recordReturn(
  deps: CustomerRightsAdminDeps,
  input: {
    actorUserId: string; withdrawalId: string;
    event: "dispatch_proof" | "received"; at?: string;
    buildReturnReceivedMail: (args: {
      customerName: string; orderReference: string; receivedAt: string;
    }) => { subject: string; html: string; text: string };
  }
): Promise<WriterResult & { mailSent?: boolean }> {
  const result = await deps.rpc("admin_record_withdrawal_return", {
    p_actor_user_id: input.actorUserId,
    p_withdrawal_id: input.withdrawalId,
    p_event: input.event,
    p_at: input.at ?? null,
  });

  if (input.event !== "received" || result.result !== "recorded") return result;

  const contact = await deps.loadCaseContact(input.withdrawalId);
  if (!contact) return { ...result, mailSent: false };

  const at = input.at ?? (deps.now ? deps.now() : new Date()).toISOString();
  const mail = input.buildReturnReceivedMail({
    customerName: contact.customerName,
    orderReference: contact.orderReference,
    receivedAt: at,
  });
  let mailSent = false;
  try {
    mailSent = await deps.sendMail(contact.contactEmail, mail);
  } catch {
    mailSent = false;
  }
  return { ...result, mailSent };
}

/* ── Wertersatz ───────────────────────────────────────────────── */

/**
 * Confirm or reduce the proposed value loss.
 *
 * The ceiling is enforced in SQL. A caller trying to raise it gets
 * 'above_ceiling' back with the ceiling named, and nothing is written.
 */
export async function confirmValueLoss(
  deps: CustomerRightsAdminDeps,
  input: { actorUserId: string; withdrawalId: string; confirmedCents: number }
): Promise<WriterResult> {
  return deps.rpc("admin_confirm_withdrawal_value_loss", {
    p_actor_user_id: input.actorUserId,
    p_withdrawal_id: input.withdrawalId,
    p_confirmed_cents: input.confirmedCents,
  });
}

/* ── The refund ───────────────────────────────────────────────── */

/**
 * PREPARE a payout. This does not pay.
 *
 * The amount comes back from the database, which derived it; this
 * function has no parameter for one and does not compute one. On
 * success the customer is told what was decided, including any
 * deduction, because a silent deduction is how a refund becomes a
 * complaint.
 */
export async function approveWithdrawalRefund(
  deps: CustomerRightsAdminDeps,
  input: {
    actorUserId: string; withdrawalId: string;
    buildRefundMail: (args: {
      customerName: string; orderReference: string;
      paidGrossCents: number; confirmedValueLossCents: number; refundGrossCents: number;
    }) => { subject: string; html: string; text: string };
  }
): Promise<WriterResult & { mailSent?: boolean; breakdown?: RefundBreakdown }> {
  const result = await deps.rpc("admin_approve_withdrawal_refund", {
    p_actor_user_id: input.actorUserId,
    p_withdrawal_id: input.withdrawalId,
  });

  if (result.result !== "approved") return result;

  const paid = Number(result.paid_cents ?? 0);
  const loss = Number(result.value_loss_cents ?? 0);
  const refund = Number(result.refund_amount_cents ?? 0);

  const contact = await deps.loadCaseContact(input.withdrawalId);
  if (!contact) return { ...result, mailSent: false };

  const mail = input.buildRefundMail({
    customerName: contact.customerName,
    orderReference: contact.orderReference,
    paidGrossCents: paid,
    confirmedValueLossCents: loss,
    refundGrossCents: refund,
  });
  let mailSent = false;
  try {
    mailSent = await deps.sendMail(contact.contactEmail, mail);
  } catch {
    mailSent = false;
  }

  return { ...result, mailSent };
}

/* ── The other two case families ──────────────────────────────── */

export async function advanceComplaint(
  deps: CustomerRightsAdminDeps,
  input: { actorUserId: string; complaintId: string; caseState: string; internalNote?: string | null }
): Promise<WriterResult> {
  return deps.rpc("admin_advance_complaint", {
    p_actor_user_id: input.actorUserId,
    p_complaint_id: input.complaintId,
    p_case_state: input.caseState,
    p_internal_note: input.internalNote ?? null,
  });
}

export async function reviewTermination(
  deps: CustomerRightsAdminDeps,
  input: { actorUserId: string; terminationId: string; caseState: string; internalNote?: string | null }
): Promise<WriterResult> {
  return deps.rpc("admin_review_termination", {
    p_actor_user_id: input.actorUserId,
    p_termination_id: input.terminationId,
    p_case_state: input.caseState,
    p_internal_note: input.internalNote ?? null,
  });
}

/* ── Purchase restrictions ────────────────────────────────────── */

export async function createPurchaseRestriction(
  deps: CustomerRightsAdminDeps,
  input: {
    actorUserId: string; userId: string; scope: string; reasonCategory: string;
    internalNote?: string | null; expiresAt?: string | null;
  }
): Promise<WriterResult> {
  return deps.rpc("admin_create_purchase_restriction", {
    p_actor_user_id: input.actorUserId,
    p_user_id: input.userId,
    p_scope: input.scope,
    p_reason_category: input.reasonCategory,
    p_internal_note: input.internalNote ?? null,
    p_expires_at: input.expiresAt ?? null,
  });
}

export async function liftPurchaseRestriction(
  deps: CustomerRightsAdminDeps,
  input: { actorUserId: string; restrictionId: string }
): Promise<WriterResult> {
  return deps.rpc("admin_lift_purchase_restriction", {
    p_actor_user_id: input.actorUserId,
    p_restriction_id: input.restrictionId,
  });
}

/**
 * THE TWO ADMIN-TRIGGERED MAILS, NAMED SO THE WIRING IS GREPPABLE.
 *
 * The builders are passed in rather than imported so this module stays
 * testable without a template, but the real call sites use exactly
 * these two - and a test asserts both names appear here.
 */
export const ADMIN_TRIGGERED_MAILS = Object.freeze([
  "buildWithdrawalReturnReceivedEmail",
  "buildWithdrawalRefundCompletedEmail",
] as const);
