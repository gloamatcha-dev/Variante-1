/**
 * "DEINE ERSTATTUNG IST DURCHGEFÜHRT" - SENT ONCE, AFTER THE MONEY WENT.
 *
 * The sixth transactional sender in this repository and the seventh
 * shaped like it. Migrations 017, 026, 027, 030, 031 and 033 each gave
 * their event a status column and claimed it with a conditional UPDATE;
 * migration 070 does the same for this one. Nothing new was invented
 * here - what is new is only which fact is being announced.
 *
 * ══════════════════════════════════════════════════════════════
 * THE TWO REFUND MOMENTS, AND WHY ONLY ONE OF THEM MAILS
 * ══════════════════════════════════════════════════════════════
 *
 * An administrator APPROVES a payout, and some time later Stripe
 * CONFIRMS it. Those are different facts, and a customer told "your
 * refund has been carried out" at the first one has been told something
 * that is not yet true - and may never become true, because a card can
 * decline.
 *
 * So this sends at the SECOND moment only. That is not a rule this file
 * follows carefully; it is a rule it cannot break. Every send begins by
 * winning claim_withdrawal_refund_completed_email, whose predicate
 * requires refund_state = 'executed' AND a provider reference - a
 * combination migration 070's CHECK makes impossible unless Stripe
 * answered and this database persisted the answer. Therefore:
 *
 *   at approval             the claim cannot be won
 *   when Stripe fails       the claim cannot be won
 *   on an amount mismatch   nothing was written, so it cannot be won
 *
 * ══════════════════════════════════════════════════════════════
 * AND EXACTLY ONCE, EVEN UNDER A DOUBLE-CLICK
 * ══════════════════════════════════════════════════════════════
 *
 * The claim is one UPDATE, so two concurrent attempts cannot both win
 * it: PostgreSQL serialises the row and the loser matches zero rows.
 * 'sent' is terminal and not re-claimable - a withdrawal case has
 * exactly one payout, guaranteed by the unique index on
 * refund_operation_id, so there is never a second fact to announce.
 *
 * ── A FAILED SEND IS RETRYABLE, AND COSTS NOTHING TWICE ───────
 *
 * If Stripe succeeded and Resend did not, the money is gone and the
 * customer has not been told. That must be fixable, and fixing it must
 * not touch Stripe again. So a failure writes 'failed', which IS
 * claimable, and retrying re-enters this function - which has no
 * provider dependency of any kind. There is no way to make a second
 * refund from here, because nothing here can make a first one.
 *
 * ── THE FIGURES COME FROM THE CLAIM, NOT FROM THE CALLER ──────
 *
 * The claim returns the amount, the deduction and the reference from the
 * row it just locked. This function has no parameter for a figure, so a
 * stale screen or a replayed request cannot change what the customer is
 * told the refund was.
 */

/** What the claim hands back when it is won. */
export type ClaimedRefundCompletion = {
  contactEmail: string;
  customerName: string;
  orderReference: string;
  refundAmountCents: number;
  valueLossCents: number;
  /** Original server-owned payment, including prior-refund/custom approval cases. */
  paidGrossCents?: number;
  /** Stripe's own id for the refund. Proof the money moved. */
  refundProviderReference: string;
  refundExecutedAt: string | null;
  /** Which kind of withdrawal this settled, for the one scope-dependent sentence. */
  refundScope?: "whole_order" | "partial";
  /** Whether the outbound delivery cost is part of this refund. */
  shippingIncluded?: boolean;
};

export type CompletionEmailResult =
  | "sent"
  | "already-sent-or-not-executed"
  | "no-recipient"
  | "failed";

export type WithdrawalRefundCompletionDeps = {
  /**
   * claim_withdrawal_refund_completed_email. Returns the locked row's
   * facts, or null when the claim could not be won - which covers
   * "already sent", "being sent by somebody else" and "not executed"
   * with one answer, because the correct behaviour is the same for all
   * three.
   */
  claim: (withdrawalId: string) => Promise<ClaimedRefundCompletion | null>;
  /** Builds the message. Injected so this module needs no template. */
  buildMail: (args: {
    customerName: string;
    orderReference: string;
    paidGrossCents: number;
    confirmedValueLossCents: number;
    refundGrossCents: number;
    refundScope?: "whole_order" | "partial";
    shippingIncluded?: boolean;
  }) => { subject: string; html: string; text: string };
  /** Hands the message to the provider. Returns whether it was accepted. */
  sendMail: (to: string, mail: { subject: string; html: string; text: string }) => Promise<boolean>;
  /** mark_withdrawal_refund_completed_email_sent. */
  markSent: (withdrawalId: string) => Promise<void>;
  /** mark_withdrawal_refund_completed_email_failed. Leaves it retryable. */
  markFailed: (withdrawalId: string) => Promise<void>;
};

/**
 * Sends the completion mail for one withdrawal case, at most once.
 *
 * Safe to call after every payout attempt and safe to call again later:
 * a case whose mail already went, or whose refund has not executed,
 * simply loses the claim and returns without sending.
 */
export async function sendWithdrawalRefundCompletedIfNeeded(
  deps: WithdrawalRefundCompletionDeps,
  input: { withdrawalId: string }
): Promise<CompletionEmailResult> {
  const withdrawalId = typeof input.withdrawalId === "string" ? input.withdrawalId.trim() : "";
  if (withdrawalId === "") return "already-sent-or-not-executed";

  let claimed: ClaimedRefundCompletion | null;
  try {
    claimed = await deps.claim(withdrawalId);
  } catch {
    // A claim that threw was not won, so nothing is held and nothing
    // needs releasing. Reporting a failure is honest; writing 'failed'
    // would be a claim about a lease this call never had.
    return "failed";
  }
  if (!claimed) return "already-sent-or-not-executed";

  const to = typeof claimed.contactEmail === "string" ? claimed.contactEmail.trim() : "";
  if (to === "") {
    // The refund stands. There is simply nobody to tell by email, and
    // leaving the case 'failed' keeps it visible and retryable rather
    // than pretending a message went out.
    await safely(() => deps.markFailed(withdrawalId));
    return "no-recipient";
  }

  const refund = numberOr(claimed.refundAmountCents, 0);
  const loss = numberOr(claimed.valueLossCents, 0);

  let accepted = false;
  try {
    const mail = deps.buildMail({
      customerName: claimed.customerName,
      orderReference: claimed.orderReference,
      // WHAT THEY PAID, RECONSTRUCTED FROM THE TWO FIGURES THE DATABASE
      // RETURNED, so the breakdown in the mail always adds up.
      paidGrossCents: claimed.paidGrossCents ?? refund + loss,
      confirmedValueLossCents: loss,
      refundGrossCents: refund,
      refundScope: claimed.refundScope,
      shippingIncluded: claimed.shippingIncluded,
    });
    accepted = await deps.sendMail(to, mail);
  } catch {
    accepted = false;
  }

  if (!accepted) {
    await safely(() => deps.markFailed(withdrawalId));
    return "failed";
  }

  await safely(() => deps.markSent(withdrawalId));
  return "sent";
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Runs a state write and swallows its error.
 *
 * Deliberate: by the time these run, the message has either been
 * accepted by the provider or definitively not been. Throwing out of
 * this function would turn a bookkeeping failure into an apparent send
 * failure, and a caller retrying on it would mail the customer twice.
 */
async function safely(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch {
    /* the outcome is already decided; a failed status write must not change it */
  }
}
