/**
 * WHAT AN ADMINISTRATOR CAN ACTUALLY DO TO A CASE.
 *
 * Every function here is a thin, injected wrapper around one of
 * migration 070's audited SQL writers. The rules live in the database -
 * the value-loss ceiling, the payout preconditions, the double-refund
 * index - so this layer cannot weaken them by forgetting one. What it
 * adds is the part SQL cannot do: telling the customer.
 *
 * ── ONE OF THE SIX MAILS IS TRIGGERED FROM HERE ──────────────
 *
 * "Rücksendung erhalten" is the consequence of an ADMIN decision rather
 * than of a customer submission, so it is sent where that decision is
 * made. Three more hang off the public routes.
 *
 * ── AND "ERSTATTUNG DURCHGEFÜHRT" IS DELIBERATELY NOT HERE ───
 *
 * It used to be, sent by approveWithdrawalRefund, and that was wrong.
 * Approving a payout is a decision; it is not the money arriving. A card
 * can still decline afterwards, and a customer told their refund was
 * carried out at the moment it was merely authorised has been told
 * something untrue.
 *
 * That mail now belongs to lib/withdrawalRefundCompletionEmail.ts, which
 * cannot send it before the payment provider has confirmed: its claim
 * requires refund_state = 'executed', a state migration 070 will not
 * write without the provider's own reference for the refund.
 *
 * ── AND THE MAIL NEVER DECIDES ANYTHING ──────────────────────
 *
 * Nothing here computes an amount, and a send failure is reported rather
 * than allowed to roll back a decision that has already been recorded.
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
 *
 * ── AND AN ARRIVAL AFTER THE PAYOUT IS STILL AN ARRIVAL ──────
 *
 * BGB 357 Abs. 4 lets dispatch proof alone release the money, so goods
 * can legitimately turn up after the refund has already been paid. The
 * database records that as 'received_evidence_recorded' rather than
 * 'recorded' - the difference being that it appends the receipt instant
 * WITHOUT moving case_state, so a paid case keeps looking paid.
 *
 * Both results mean the same thing to the customer: we have their goods.
 * So both send the mail, and the database's own idempotency decides that
 * it goes exactly once - a second call returns 'unchanged', which is in
 * neither list.
 *
 * What this must NOT do is resend the refund-completed mail or touch
 * Stripe. It cannot: this module imports neither.
 */

/** The two results that mean "their goods are here, tell them". */
const RETURN_ARRIVED_RESULTS = ["recorded", "received_evidence_recorded"];
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
  const result = await deps.rpc("admin_record_withdrawal_return_v1", {
    p_actor_user_id: input.actorUserId,
    p_withdrawal_id: input.withdrawalId,
    p_event: input.event,
    p_at: input.at ?? null,
  });

  if (input.event !== "received"
      || !RETURN_ARRIVED_RESULTS.includes(result.result)) return result;

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
 * PREPARE a payout. This does not pay, and it does not mail.
 *
 * The Admin supplies a final decision; SQL derives and validates its maximum.
 *
 * IT SENDS NOTHING, and that is the fix for a real defect. It used to
 * send "Erstattung durchgeführt" here, at approval - before any money
 * had moved and while a decline was still possible. The customer now
 * hears once, after the payment provider confirms, from
 * lib/withdrawalRefundCompletionEmail.ts.
 *
 * So there is no buildRefundMail parameter any more. Removing it rather
 * than leaving it unused is deliberate: a parameter for a mail this
 * function must not send is an invitation to send it.
 */
export async function approveWithdrawalRefund(
  deps: CustomerRightsAdminDeps,
  input: { actorUserId: string; withdrawalId: string; finalRefundCents: number }
): Promise<WriterResult & { breakdown?: RefundBreakdown }> {
  return deps.rpc("admin_approve_withdrawal_refund_v1", {
    p_actor_user_id: input.actorUserId,
    p_withdrawal_id: input.withdrawalId,
    p_final_refund_cents: input.finalRefundCents,
  });
}

/**
 * Say WHICH goods a case is about, and how many of them.
 *
 * The consumer's own scope_note is a sentence they typed
 * ("nur 1x Ceremonial 40g"), which is the right thing to ask a person
 * and cannot be the basis of a refund. This records an administrator's
 * structured answer instead: an order_items reference and a quantity.
 *
 * The database is what makes it safe. admin_resolve_withdrawal_item
 * refuses a line belonging to a different order, refuses a quantity
 * larger than what was sold, requires the outbound-shipping decision for
 * a partial case and forbids it for a whole-order one. This wrapper adds
 * nothing to those rules and cannot weaken them.
 */
export async function resolveWithdrawalItem(
  deps: CustomerRightsAdminDeps,
  input: {
    actorUserId: string; withdrawalId: string;
    orderItemId: string; quantity: number;
    shippingTreatment?: "refund_outbound_shipping" | "retain_outbound_shipping" | null;
  }
): Promise<WriterResult> {
  return deps.rpc("admin_resolve_withdrawal_item", {
    p_actor_user_id: input.actorUserId,
    p_withdrawal_id: input.withdrawalId,
    p_order_item_id: input.orderItemId,
    p_quantity: input.quantity,
    p_shipping_treatment: input.shippingTreatment ?? null,
  });
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
 * THE ADMIN-TRIGGERED MAIL THIS MODULE SENDS, NAMED SO THE WIRING IS
 * GREPPABLE.
 *
 * One, not two. buildWithdrawalRefundCompletedEmail used to be here and
 * is deliberately gone: that message follows the payment provider
 * confirming, not an administrator deciding, so it is sent from
 * lib/withdrawalRefundCompletionEmail.ts through
 * /api/admin/withdrawal-refund. A test asserts it appears THERE and not
 * here, which is what stops it drifting back to approval time.
 *
 * The builder is passed in rather than imported so this module stays
 * testable without a template.
 */
export const ADMIN_TRIGGERED_MAILS = Object.freeze([
  "buildWithdrawalReturnReceivedEmail",
] as const);

/**
 * And the one sent from the payout route, named here for the same
 * reason: so the pair is findable from one place even though they are
 * triggered from two.
 */
export const PAYOUT_TRIGGERED_MAILS = Object.freeze([
  "buildWithdrawalRefundCompletedEmail",
] as const);
