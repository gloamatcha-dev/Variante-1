/**
 * TAKING A WITHDRAWAL DECLARATION, AND DECIDING WHAT IT MEANS.
 *
 * The route above this is a parser: it checks shapes and sizes. This is
 * where the declaration becomes a case - resolved against a real order,
 * dated against a real receipt, and frozen if it has to be.
 *
 * ── THE ANSWER NEVER DEPENDS ON WHAT WE FOUND ────────────────
 *
 * Migration 018 built the public endpoint so it could not be used to
 * enumerate order numbers: the same acknowledgement came back whether
 * the reference matched anything or not. Resolving the order now would
 * destroy that property if any of it leaked outward - so it does not.
 * Resolution happens entirely inside, is written to columns only the
 * server can read, and `submit` returns the same shape in every case.
 * An attacker learns the same thing from a real order number as from a
 * made-up one: that we received it.
 *
 * ── AND IT NEVER DEPENDS ON WHAT THE BROWSER CLAIMS ──────────
 *
 * The caller supplies a name, an email, a reference and a scope. It
 * does not supply - and cannot influence - the receipt date, the
 * deadline, the timeliness, the seal state, the value loss, the refund
 * or the freeze. Those are read from the database or computed here.
 */

import {
  evaluateWithdrawalTimeliness,
  firstDeliveryReceiptOf,
  type DeadlineBasis,
  type WithdrawalTimeliness,
} from "./withdrawalDeadline.ts";
import { withdrawalProtectsFutureDeliveries } from "./withdrawalCase.ts";

/* ── What the world outside looks like ────────────────────────── */

export interface ResolvedContract {
  orderId: string;
  /** The account the order belongs to, when it has one. Guests have none. */
  userId: string | null;
  /** Lower-cased contact address stored on the order, for the identity check. */
  contactEmail: string | null;
  /** Set when this order is an annual-plan delivery. */
  annualPlanId: string | null;
  /** orders.delivered_at for THIS order. */
  deliveredAt: string | null;
}

export interface AnnualPlanDelivery {
  deliveryNumber: number;
  /** orders.delivered_at of the order this delivery minted, when there is one. */
  deliveredAt: string | null;
}

export interface WithdrawalSubmissionDeps {
  /**
   * Look an order up by the reference the consumer typed. Returns null
   * for anything that does not match - which is a normal outcome, not
   * an error, because BGB 356a must work for somebody who mistypes.
   */
  findContractByReference: (reference: string) => Promise<ResolvedContract | null>;
  /** Delivery rows for an annual plan, used to find delivery number one. */
  annualPlanDeliveries: (annualPlanId: string) => Promise<AnnualPlanDelivery[]>;
  /** Returns the existing case for an idempotency key, when one exists. */
  findByIdempotencyKey: (key: string) => Promise<{ id: string; submittedAt: string } | null>;
  /** Writes the case row. */
  insertCase: (row: WithdrawalCaseRow) => Promise<{ id: string; submittedAt: string }>;
  /** public.freeze_annual_deliveries_for_withdrawal(id). */
  freezeDeliveries: (caseId: string) => Promise<void>;
  /** Retry the existing authority after a partially completed submission. */
  repairFreezeOnReplay?: (caseId: string) => Promise<void>;
  /** Best-effort BGB 356a Abs. 4 confirmation. Returns whether it went. */
  sendConfirmation: (input: ConfirmationInput) => Promise<boolean>;
  /** Records whether the confirmation went out. */
  markConfirmation: (caseId: string, sent: boolean) => Promise<void>;
  /** Injected so tests do not depend on the wall clock. */
  now?: () => Date;
}

export interface WithdrawalCaseRow {
  customer_name: string;
  contact_email: string;
  order_reference: string;
  scope: "whole_order" | "partial";
  scope_note: string | null;
  customer_note: string | null;
  idempotency_key: string | null;
  resolved_order_id: string | null;
  resolved_user_id: string | null;
  resolved_annual_plan_id: string | null;
  resolution_method: "unresolved" | "order_number_and_email" | "authenticated_session" | "admin_manual";
  case_state: "submitted";
  timeliness: WithdrawalTimeliness;
  deadline_start_at: string | null;
  deadline_date: string | null;
  deadline_basis: DeadlineBasis;
}

export interface ConfirmationInput {
  caseId: string;
  customerName: string;
  contactEmail: string;
  orderReference: string;
  scope: "whole_order" | "partial";
  scopeNote: string | null;
  customerNote: string | null;
  submittedAt: string;
}

export interface WithdrawalSubmissionInput {
  customerName: string;
  contactEmail: string;
  orderReference: string;
  scope: "whole_order" | "partial";
  scopeNote?: string | null;
  customerNote?: string | null;
  /** Stable per declaration, so a retried request is one declaration. */
  idempotencyKey?: string | null;
  /**
   * The signed-in user, when there is one. Used ONLY to strengthen
   * identification - never to weaken it, and never required.
   */
  sessionUserId?: string | null;
}

/**
 * What the caller may know. Deliberately thin: an acknowledgement, the
 * timestamp the law requires us to confirm, and whether the mail went.
 * No case id, no timeliness, no resolution - nothing that differs
 * between a matched and an unmatched reference.
 */
export interface WithdrawalSubmissionResult {
  ok: true;
  submittedAt: string;
  confirmationEmailSent: boolean;
  /** True when this exact declaration had already been recorded. */
  duplicate: boolean;
}

/* ── Identification ───────────────────────────────────────────── */

/**
 * Whether the declaration and the order belong to the same person.
 *
 * Two independent ways to be sure, and either is enough:
 *
 *   the session   a signed-in customer whose account owns the order is
 *                 identified by the session itself, which is stronger
 *                 than anything typed into a form.
 *   the address   a guest who knows the order reference AND the address
 *                 the order carries. Knowing one without the other is
 *                 not identification.
 *
 * Case and surrounding whitespace are normalised, because an email
 * address is not case-sensitive in its domain and customers type
 * capitals.
 *
 * A FAILURE HERE IS NOT AN ERROR. It leaves the case unresolved, which
 * is a legitimate state: the declaration still stands, it is still
 * recorded, and an administrator can link it by hand. What it must
 * never do is change the response.
 */
export function identifies(
  contract: ResolvedContract,
  input: { contactEmail: string; sessionUserId?: string | null }
): { resolved: boolean; method: WithdrawalCaseRow["resolution_method"] } {
  if (input.sessionUserId && contract.userId && input.sessionUserId === contract.userId) {
    return { resolved: true, method: "authenticated_session" };
  }
  const typed = input.contactEmail.trim().toLowerCase();
  const stored = (contract.contactEmail ?? "").trim().toLowerCase();
  if (typed && stored && typed === stored) {
    return { resolved: true, method: "order_number_and_email" };
  }
  return { resolved: false, method: "unresolved" };
}

/* ── Dating the period ────────────────────────────────────────── */

/**
 * Which receipt starts the period for this contract.
 *
 * AN ANNUAL PLAN IS BGB 356 Abs. 2 Nr. 1 lit. d - regular delivery of
 * goods over a fixed period - so it dates from the FIRST goods. The
 * plan's delivery rows are read and delivery number one is taken; the
 * other eleven are never consulted, which is why no later box can move
 * the deadline even if it arrives first.
 *
 * ANYTHING ELSE is lit. a: the receipt of the goods on that order.
 */
export async function resolveReceipt(
  deps: Pick<WithdrawalSubmissionDeps, "annualPlanDeliveries">,
  contract: ResolvedContract
): Promise<{ receiptAt: string | null; basis: DeadlineBasis }> {
  if (contract.annualPlanId) {
    const deliveries = await deps.annualPlanDeliveries(contract.annualPlanId);
    return firstDeliveryReceiptOf(
      deliveries.map(d => ({ deliveryNumber: d.deliveryNumber, deliveredAt: d.deliveredAt }))
    );
  }
  return { receiptAt: contract.deliveredAt, basis: "single_delivery_receipt" };
}

/* ── The submission ───────────────────────────────────────────── */

/**
 * Record one declaration, and everything that follows from it.
 *
 * ORDER OF OPERATIONS MATTERS. The durable record is written before the
 * mail is attempted, because BGB 356a Abs. 1 is satisfied by receiving
 * the declaration and Abs. 4 only asks us to confirm it. A case that
 * exists with an unsent confirmation is a mail problem; a confirmation
 * sent for a case that was never stored is a lost right.
 *
 * THE FREEZE HAPPENS BEFORE THE MAIL for the same reason: it is the
 * part that stops goods shipping, and it must not depend on Resend.
 */
export async function submitWithdrawal(
  deps: WithdrawalSubmissionDeps,
  input: WithdrawalSubmissionInput
): Promise<WithdrawalSubmissionResult> {
  const now = deps.now ? deps.now() : new Date();

  // ── ONE DECLARATION, HOWEVER MANY CLICKS ────────────────────
  if (input.idempotencyKey) {
    const existing = await deps.findByIdempotencyKey(input.idempotencyKey);
    if (existing) {
      try { await deps.repairFreezeOnReplay?.(existing.id); }
      catch { console.error('Withdrawal replay: delivery freeze repair remains pending'); }
      return {
        ok: true,
        submittedAt: existing.submittedAt,
        confirmationEmailSent: false,
        duplicate: true,
      };
    }
  }

  // ── RESOLUTION, WHICH NEVER REACHES THE RESPONSE ────────────
  let contract: ResolvedContract | null = null;
  try {
    contract = await deps.findContractByReference(input.orderReference);
  } catch {
    // A lookup failure must not lose the declaration. The case is
    // simply recorded unresolved and a human links it.
    contract = null;
  }

  let resolvedOrderId: string | null = null;
  let resolvedUserId: string | null = null;
  let resolvedAnnualPlanId: string | null = null;
  let method: WithdrawalCaseRow["resolution_method"] = "unresolved";
  let timeliness: WithdrawalTimeliness = "receipt_unknown";
  let deadlineStartAt: string | null = null;
  let deadlineDate: string | null = null;
  let basis: DeadlineBasis = "unknown";

  if (contract) {
    const id = identifies(contract, {
      contactEmail: input.contactEmail,
      sessionUserId: input.sessionUserId ?? null,
    });
    if (id.resolved) {
      resolvedOrderId = contract.orderId;
      resolvedUserId = contract.userId;
      resolvedAnnualPlanId = contract.annualPlanId;
      method = id.method;

      const receipt = await resolveReceipt(deps, contract);
      const verdict = evaluateWithdrawalTimeliness({
        receiptAt: receipt.receiptAt,
        declaredAt: now.toISOString(),
        basis: receipt.basis,
      });
      timeliness = verdict.timeliness;
      deadlineStartAt = verdict.startAt;
      deadlineDate = verdict.deadlineDate;
      basis = verdict.basis;
    }
  }

  const row: WithdrawalCaseRow = {
    customer_name: input.customerName,
    contact_email: input.contactEmail,
    order_reference: input.orderReference,
    scope: input.scope,
    scope_note: input.scopeNote ?? null,
    customer_note: input.customerNote ?? null,
    idempotency_key: input.idempotencyKey ?? null,
    resolved_order_id: resolvedOrderId,
    resolved_user_id: resolvedUserId,
    resolved_annual_plan_id: resolvedAnnualPlanId,
    resolution_method: method,
    case_state: "submitted",
    timeliness,
    deadline_start_at: deadlineStartAt,
    deadline_date: deadlineDate,
    deadline_basis: basis,
  };

  const inserted = await deps.insertCase(row);

  // ── THE FREEZE ──────────────────────────────────────────────
  // Only for a resolved annual plan, and only where the case is not
  // something we can positively show to be late.
  if (resolvedAnnualPlanId && withdrawalProtectsFutureDeliveries(timeliness)) {
    try {
      await deps.freezeDeliveries(inserted.id);
    } catch {
      console.error('Withdrawal received: Annual delivery freeze failed; Admin repair required');
      // A failed freeze must not lose the declaration either. The case
      // is recorded and an administrator sees an unfrozen protected
      // case, which the admin view surfaces.
    }
  }

  // ── THE CONFIRMATION, BEST EFFORT ───────────────────────────
  let sent = false;
  try {
    sent = await deps.sendConfirmation({
      caseId: inserted.id,
      customerName: input.customerName,
      contactEmail: input.contactEmail,
      orderReference: input.orderReference,
      scope: input.scope,
      scopeNote: input.scopeNote ?? null,
      customerNote: input.customerNote ?? null,
      submittedAt: inserted.submittedAt,
    });
  } catch {
    sent = false;
  }
  try {
    await deps.markConfirmation(inserted.id, sent);
  } catch {
    // Tracking only.
  }

  return {
    ok: true,
    submittedAt: inserted.submittedAt,
    confirmationEmailSent: sent,
    duplicate: false,
  };
}
