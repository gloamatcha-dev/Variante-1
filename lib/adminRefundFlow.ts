import {
  canRefund,
  maxRefundableCents,
  refundIdempotencyKey,
  resolveRefundAmount,
  type ActionableOrder,
} from "./adminOrderActionRules.ts";

/**
 * THE REFUND SEQUENCE, WITH EVERY DEPENDENCY HANDED IN.
 *
 * Split out of lib/adminOrderActions.ts for one reason: this is the only
 * thing in the repository that can move money, and a claim like "two
 * simultaneous refunds cannot both reach Stripe" is about what happens
 * when two calls overlap. That cannot be proved by reading source. It
 * has to be RUN.
 *
 * So the four things this sequence touches - the lock, the order, Stripe
 * and the sync - arrive as an argument, exactly the way
 * lib/annualPlanCheckoutDeps.ts and lib/adminSessionDeps.ts already do
 * it in this repository. adminOrderActions supplies the real ones; the
 * test suite supplies fakes that behave like them and overlaps two
 * calls.
 *
 * ── WHAT THE LOCK IS FOR, AND WHAT IT IS NOT FOR ──────────────
 *
 * The Stripe idempotency key collapses REPETITIONS OF ONE INTENT: a
 * double click, a lost response, a network retry. It cannot collapse two
 * GENUINELY DIFFERENT intents - 10,00 EUR from one tab and 20,00 EUR
 * from another - because those produce different keys and Stripe would
 * honour both.
 *
 * claim() is what makes those two serialize. It is a row in the
 * database (migration 049), not a variable: this runs as several server
 * instances that share no memory, and a disabled button disappears on
 * reload.
 *
 * BOTH ARE KEPT. They solve different problems and neither subsumes the
 * other.
 *
 * ── THE LOCK IS TAKEN BEFORE ANYTHING IS DECIDED ──────────────
 *
 * Reading the order first and locking afterwards would leave exactly the
 * window this exists to close: both callers would read the same
 * refunded_total_cents and both would compute a maximum that ignores the
 * other. So the claim comes first, and the arithmetic happens inside it.
 *
 * ── AND IT IS GIVEN BACK ON EVERY PATH ────────────────────────
 *
 * release() runs in a finally, so a throw anywhere - Stripe, the sync, a
 * bug - hands the lock straight back. Even a hard process death is not a
 * deadlock: claim_order_refund expires a claim older than its stale
 * window in the same statement that takes it.
 */

export type RefundFlowFailure = { ok: false; status: number; error: string };

export type RefundFlowSuccess = {
  ok: true;
  orderNumber: string;
  amountCents: number;
  refundStatus: string | null;
  refundedTotalCents: number | null;
  syncResult: string;
  emailOutcome: "sent" | "already-sent" | "not-eligible" | "failed" | "not-attempted";
};

export type RefundFlowResult = RefundFlowFailure | RefundFlowSuccess;

export type RefundFlowDeps = {
  /** A fresh claim id for this attempt. */
  newClaimId(): string;
  /** claim_order_refund: true when this caller now holds the lock. */
  claim(orderId: string, claimId: string): Promise<{ claimed: boolean; error: string | null }>;
  /** release_order_refund. Never throws; a failure is logged, not acted on. */
  release(orderId: string, claimId: string): Promise<void>;
  /** The order, read by the server with the lock already held. */
  loadOrder(orderId: string): Promise<{
    order: (ActionableOrder & { id: string; order_number: string }) | null;
    error: string | null;
  }>;
  /** stripe.refunds.create. Throws on refusal, like the SDK does. */
  createRefund(input: {
    paymentIntentId: string;
    amountCents: number;
    idempotencyKey: string;
  }): Promise<{ status: string | null }>;
  /** syncOrderRefundStateFromStripe. Throws on a transient failure. */
  syncRefundState(paymentIntentId: string): Promise<{ result: string; refundedTotalCents: number | null }>;
  /**
   * Records the act, AFTER GLOA has committed the state Stripe
   * confirmed. Injected rather than imported so this module stays a
   * testable leaf. See the note at the call site for why this one audit
   * is not transactional.
   *
   * SHOULD NEVER THROW, like sendConfirmation. The call site guards it
   * anyway - a refund that already moved money must not be reported as
   * a failure because the log was briefly unreachable.
   */
  recordActivity(input: {
    orderId: string; orderNumber: string; claimId: string;
    amountCents: number; refundStatus: string | null;
  }): Promise<void>;
  /** isNewSettledRefundFact - the same gate the Stripe webhook uses. */
  isNewSettledFact(syncResult: string): boolean;
  /** sendRefundConfirmationIfNeeded. Never throws. */
  sendConfirmation(orderId: string): Promise<"sent" | "already-sent" | "not-eligible" | "failed">;
  /** Operator-facing logging. Never receives a customer fact. */
  log(message: string): void;
};

const BUSY: RefundFlowFailure = {
  ok: false,
  status: 409,
  error: "Für diese Bestellung wird gerade eine Erstattung verarbeitet. Bitte kurz warten und die Ansicht neu laden.",
};

export async function runAdminRefund(
  deps: RefundFlowDeps,
  orderId: string,
  rawAmount: unknown
): Promise<RefundFlowResult> {
  const claimId = deps.newClaimId();
  const claim = await deps.claim(orderId, claimId);
  if (claim.error) {
    // An unknown order id reaches the function as a no-op rather than an
    // error, so this really is infrastructure failing.
    deps.log(`Admin refund: claim failed for order ${orderId}: ${claim.error}`);
    return { ok: false, status: 500, error: "Interner Fehler." };
  }
  if (!claim.claimed) {
    // A FAILED CLAIM HAS TWO CAUSES AND THEY DESERVE DIFFERENT ANSWERS.
    //
    // claim_order_refund updates a row and reports whether it matched
    // one, so "somebody else holds the lock" and "there is no such
    // order" both come back as false. Telling an operator that a
    // mistyped order id is "gerade in Bearbeitung" sends them off to
    // wait for something that will never finish.
    //
    // The extra read costs nothing in the normal case: it happens only
    // on the failure path, and only to choose a sentence.
    const { order } = await deps.loadOrder(orderId);
    if (!order) return { ok: false, status: 404, error: "Bestellung nicht gefunden." };
    return BUSY;
  }

  try {
    return await refundUnderClaim(deps, orderId, rawAmount, claimId);
  } finally {
    await deps.release(orderId, claimId);
  }
}

async function refundUnderClaim(
  deps: RefundFlowDeps,
  orderId: string,
  rawAmount: unknown,
  /** The claim held by the caller - also the audit's idempotency key. */
  claimId: string
): Promise<RefundFlowResult> {
  const { order, error } = await deps.loadOrder(orderId);
  if (error) {
    deps.log(`Admin refund: order load failed for ${orderId}: ${error}`);
    return { ok: false, status: 500, error: "Interner Fehler." };
  }
  if (!order) return { ok: false, status: 404, error: "Bestellung nicht gefunden." };

  const orderNumber = typeof order.order_number === "string" ? order.order_number : orderId;

  const verdict = canRefund(order);
  if (!verdict.allowed) return { ok: false, status: 409, error: verdict.reason };

  const maxCents = maxRefundableCents(order);
  const amount = resolveRefundAmount(rawAmount, maxCents);
  if (!amount.ok) return { ok: false, status: 400, error: amount.message };

  const paymentIntentId = String(order.stripe_payment_intent_id ?? "").trim();
  const alreadyRefunded =
    typeof order.refunded_total_cents === "number" && order.refunded_total_cents > 0
      ? Math.trunc(order.refunded_total_cents)
      : 0;

  let refundStatus: string | null = null;
  try {
    const refund = await deps.createRefund({
      paymentIntentId,
      amountCents: amount.amountCents,
      // Derived from the order and the amount ALREADY refunded, so a
      // repeat of this intent is the same key and a deliberate second
      // refund later is a different one.
      idempotencyKey: refundIdempotencyKey(order.id, alreadyRefunded, amount.amountCents),
    });
    refundStatus = refund.status;
  } catch (cause) {
    // The order number and the provider's message. Never the intent id,
    // never the key, never the customer - and never any of it to the
    // browser, which gets one generic sentence.
    const message = cause instanceof Error ? cause.message : "unknown";
    deps.log(`Admin refund: Stripe refused the refund for ${orderNumber}: ${message}`);
    return { ok: false, status: 502, error: "Die Erstattung konnte bei Stripe nicht ausgelöst werden." };
  }

  // The existing pipeline. It re-reads EVERY refund Stripe holds for this
  // payment intent and writes the absolute sum, so it converges rather
  // than accumulating.
  let syncResult: string;
  let refundedTotalCents: number | null;
  try {
    const outcome = await deps.syncRefundState(paymentIntentId);
    syncResult = outcome.result;
    refundedTotalCents = outcome.refundedTotalCents;
  } catch (cause) {
    // The money HAS moved. Reporting this as a failed refund would be a
    // lie and would invite the operator to try again. Say what is true:
    // the refund happened, the order has not caught up yet, and the
    // webhook will reconcile it.
    const message = cause instanceof Error ? cause.message : "unknown";
    deps.log(`Admin refund: refund succeeded but sync failed for ${orderNumber}: ${message}`);
    return {
      ok: true,
      orderNumber,
      amountCents: amount.amountCents,
      refundStatus,
      refundedTotalCents: null,
      syncResult: "sync_failed",
      emailOutcome: "not-attempted",
    };
  }

  // The same gate the Stripe webhook uses. 'applied' is the only result
  // that means this write moved something; 'refund_pending' and
  // 'unchanged' mail nothing.
  let emailOutcome: RefundFlowSuccess["emailOutcome"] = "not-attempted";
  if (deps.isNewSettledFact(syncResult)) {
    // ── THE ONE AUDIT THAT CANNOT BE TRANSACTIONAL ────────────
    //
    // Stripe cannot join a Postgres transaction, so this is recorded
    // after the fact rather than with it - and only for a result that
    // means GLOA ACCEPTED a new settled refund. It never claims a
    // refund on 'refund_pending', on 'unchanged', or when the sync
    // failed above.
    //
    // The claim id from migration 049 is the idempotency key: a retry
    // holds the same claim, so the log cannot gain a second line for
    // one refund. Nothing about the PaymentIntent or the Refund object
    // is stored - an amount and a status, and no more.
    // Guarded rather than trusted. The recorder returns a boolean and
    // swallows its own errors today; this is the second belt, so a
    // future implementation that throws still cannot turn a settled
    // refund into an error message for the operator.
    try {
      await deps.recordActivity({
        orderId: order.id,
        orderNumber,
        claimId,
        amountCents: amount.amountCents,
        refundStatus,
      });
    } catch {
      deps.log(`Admin refund: the act on ${orderNumber} was not recorded.`);
    }

    emailOutcome = await deps.sendConfirmation(order.id);
  }

  return {
    ok: true,
    orderNumber,
    amountCents: amount.amountCents,
    refundStatus,
    refundedTotalCents,
    syncResult,
    emailOutcome,
  };
}
