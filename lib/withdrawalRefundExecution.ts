/**
 * MOVING THE MONEY - THE ONE PLACE IT HAPPENS.
 *
 * Migration 070 splits a withdrawal payout in two on purpose.
 * admin_approve_withdrawal_refund DECIDES: it checks the seven
 * preconditions, derives the amount from what the customer paid, stamps
 * one refund_operation_id and stops. This module EXECUTES: it takes the
 * decision the database already made and turns it into exactly one
 * Stripe refund.
 *
 * The split is what makes the guarantee possible. A decision with no
 * payout is a case an operator can see and retry. A payout with no
 * decision cannot exist, because this file has no way to invent one.
 *
 * ══════════════════════════════════════════════════════════════
 * THE FIVE RULES THIS FILE EXISTS TO ENFORCE
 * ══════════════════════════════════════════════════════════════
 *
 * 1. THERE IS NO AMOUNT PARAMETER. Look at the input type: an actor and
 *    a case id. The figure is RE-READ from the database every time,
 *    immediately before the call, so a stale admin screen, a replayed
 *    request or a hand-edited body cannot change what is paid.
 *
 * 2. IT REFUSES ANY CASE THAT IS NOT ALREADY APPROVED. 'not_started',
 *    'on_hold_awaiting_return' and a missing refund_operation_id each
 *    stop it before Stripe is touched. The gate is the database's
 *    state, not this function's judgement.
 *
 * 3. refund_operation_id IS THE IDEMPOTENCY KEY. It was stamped once,
 *    at approval, and a unique index makes a second one impossible. So
 *    a timeout followed by a retry sends Stripe the SAME key, and
 *    Stripe returns the SAME refund instead of making a second one.
 *    This is the actual double-refund guarantee; the state checks are
 *    only the fast path.
 *
 * 4. 'executed' IS WRITTEN AFTER THE CALL RETURNED, NEVER BEFORE, and
 *    only together with the provider's own reference for the refund. A
 *    CHECK constraint in migration 070 makes the state and the evidence
 *    inseparable, so the row cannot claim a payout that no API call
 *    made. A failure is recorded as a failure - the case stays owed.
 *
 * 5. STRIPE IS INJECTED. Nothing here imports it. That is what lets the
 *    whole sequence, including the failure and mismatch paths, be
 *    tested without a network and without a live key.
 *
 * ── AND A ZERO REFUND IS NOT A PAYOUT ────────────────────────
 *
 * A case where the confirmed Wertersatz swallows the whole price is
 * legitimate and ends at refund_amount_cents = 0. There is nothing to
 * send to Stripe, and marking it 'executed' would require a provider
 * reference that does not exist. It returns 'nothing_to_pay' and stays
 * approved, for a human to close.
 */

/** What the database says about a case, read fresh. */
export type ApprovedRefundSnapshot = {
  withdrawalId: string;
  refundState: string;
  refundAmountCents: number | null;
  refundOperationId: string | null;
  /** The intent the customer's money arrived on. Never a browser value. */
  paymentIntentId: string | null;
  /** Which contract the amount came from, for the audit line only. */
  paymentBasis: "annual_plan" | "order" | "unresolved";
};

export type ProviderRefundOutcome =
  | { ok: true; reference: string; amountCents: number }
  | { ok: false; reason: string };

export type WithdrawalRefundExecutionDeps = {
  /** Installed 077 authority and fresh provider evidence, required by the real route. */
  preparePayout?: (snapshot: ApprovedRefundSnapshot) => Promise<{
    result: string; paymentIntentId?: string; recoveredRefund?: {reference:string;amountCents:number};
  }>;
  /**
   * RE-READS the case and its payment reference. Called once per
   * execution, immediately before the provider call.
   */
  loadApprovedRefund: (withdrawalId: string) => Promise<ApprovedRefundSnapshot | null>;
  /**
   * The single provider call. idempotencyKey is refund_operation_id and
   * must be passed to Stripe as the idempotency key, not merely logged.
   */
  createProviderRefund: (input: {
    paymentIntentId: string;
    amountCents: number;
    idempotencyKey: string;
  }) => Promise<ProviderRefundOutcome>;
  /** admin_record_withdrawal_refund_execution. */
  recordExecution: (input: {
    actorUserId: string;
    withdrawalId: string;
    providerReference: string;
    providerAmountCents: number;
  }) => Promise<{ result: string } & Record<string, unknown>>;
  /** admin_record_withdrawal_refund_failure. */
  recordFailure: (input: {
    actorUserId: string;
    withdrawalId: string;
    reason: string;
  }) => Promise<{ result: string } & Record<string, unknown>>;
};

export type RefundExecutionResult = { result: string } & Record<string, unknown>;

/** The states a payout may be attempted from. 'failed' is a retry. */
const EXECUTABLE_STATES = Object.freeze(["approved_for_payout", "failed"]);

/**
 * Pay out one approved withdrawal refund.
 *
 * Takes an actor and a case id, and nothing else. Every figure comes
 * from the database; the only thing that comes back from Stripe is
 * evidence.
 */
export async function executeWithdrawalRefund(
  deps: WithdrawalRefundExecutionDeps,
  input: { actorUserId: string; withdrawalId: string }
): Promise<RefundExecutionResult> {
  const actorUserId = typeof input.actorUserId === "string" ? input.actorUserId.trim() : "";
  const withdrawalId = typeof input.withdrawalId === "string" ? input.withdrawalId.trim() : "";
  if (actorUserId === "") return { result: "missing_actor" };
  if (withdrawalId === "") return { result: "missing_withdrawal" };

  // RULE 1. The truth is read here, not received.
  const snapshot = await deps.loadApprovedRefund(withdrawalId);
  if (!snapshot) return { result: "not_found" };

  // Already paid. No provider call, and nothing to re-record.
  if (snapshot.refundState === "executed") {
    return {
      result: "already_executed",
      refund_amount_cents: snapshot.refundAmountCents,
      refund_operation_id: snapshot.refundOperationId,
    };
  }

  // RULE 2. Only a decision this database made may be paid.
  if (!EXECUTABLE_STATES.includes(snapshot.refundState)) {
    return { result: "not_approved_for_payout", refund_state: snapshot.refundState };
  }
  if (!snapshot.refundOperationId) {
    return { result: "missing_refund_operation" };
  }
  const prepared = await deps.preparePayout?.(snapshot);
  if(prepared && prepared.result!=='ready')return {result:prepared.result};
  if(prepared?.paymentIntentId)snapshot.paymentIntentId=prepared.paymentIntentId;

  const amountCents = snapshot.refundAmountCents;
  if (typeof amountCents !== "number" || !Number.isSafeInteger(amountCents) || amountCents < 0) {
    return { result: "no_approved_amount" };
  }
  if (amountCents === 0) {
    // Legitimate, and not a payout. See the header.
    return { result: "nothing_to_pay", payment_basis: snapshot.paymentBasis };
  }
  if (!snapshot.paymentIntentId) {
    return { result: "missing_payment_reference", payment_basis: snapshot.paymentBasis };
  }

  // RULE 3 and RULE 5. One injected call, keyed by the approval.
  let outcome: ProviderRefundOutcome;
  try {
    outcome = prepared?.recoveredRefund ? {ok:true,...prepared.recoveredRefund} : await deps.createProviderRefund({
      paymentIntentId: snapshot.paymentIntentId,
      amountCents,
      idempotencyKey: snapshot.refundOperationId,
    });
  } catch (err) {
    outcome = { ok: false, reason: err instanceof Error ? err.message : "provider_error" };
  }

  if (!outcome.ok) {
    // RULE 4, the other half: a failure is a state, not a silence. The
    // case stays owed and keeps its operation id, so the retry is the
    // same idempotent call rather than a new one.
    const recorded = await deps.recordFailure({
      actorUserId, withdrawalId, reason: outcome.reason,
    });
    return {
      result: "provider_failed",
      reason: outcome.reason,
      recorded: recorded.result,
      refund_operation_id: snapshot.refundOperationId,
    };
  }

  // RULE 4. Only now, and only with the provider's own reference. The
  // amount Stripe reports is passed through unchanged - the SQL writer
  // compares it to the approved figure and refuses a mismatch, so an
  // anomaly surfaces instead of being written over.
  const recorded = await deps.recordExecution({
    actorUserId,
    withdrawalId,
    providerReference: outcome.reference,
    providerAmountCents: outcome.amountCents,
  });
  return { ...recorded, provider_reference: outcome.reference };
}
