import type Stripe from "stripe";
import {
  annualPaymentIntentId,
  decidePaidState,
  decideSessionLink,
  interpretAnnualActivationResult,
  verifyAnnualPaymentAttempt,
  verifyAnnualPlanCorrelation,
  type AnnualSessionMetadata,
  type AnnualWebhookAttempt,
  type AnnualWebhookPlan,
} from "./annualPlanWebhookRules";
import { runAnnualDeliveryWorker, type AnnualDeliveryWorkerSummary } from "./annualDeliveryWorker";
import { evaluateStripeSessionPayment } from "./stripeFulfillment";
import type { AnnualDeliveryWorkerDeps } from "./annualDeliveryWorker";

/**
 * A paid annual Checkout Session becomes an active annual plan
 * (Phase 4B4).
 *
 * This is the canonical settlement event for a prepaid annual plan, and
 * the only one. The browser's return from Stripe is not payment, the
 * success URL grants nothing, and nothing else in the system activates a
 * plan.
 *
 * ── WHAT IT DOES, IN ORDER ────────────────────────────────────
 *
 *    1. re-retrieve the Checkout Session from Stripe
 *    2. re-read the local PAYMENT attempt named by metadata
 *    3. prove the attempt IS this annual payment, and not one of three
 *       impostors
 *    4. resolve the plan through annual_plans.payment_checkout_attempt_id
 *       and cross-check the id metadata named
 *    5. self-heal the Stripe session link, or refuse a different one
 *    6. verify the payment against the FROZEN expected total
 *    7. mark the attempt paid through the existing writer
 *    8. activate through migration 039's RPC
 *    9. one bounded pass of the shared delivery worker
 *
 * ── THE FEATURE FLAG IS NOT CHECKED HERE ──────────────────────
 *
 * Deliberately, and this is load-bearing. B2C_ANNUAL_PLAN_ENABLED gates
 * NEW SALES. A customer can open a Checkout Session while it is on and
 * pay a minute after an operator turns it off, and Stripe can redeliver
 * the event for days. Gating settlement on it would mean money accepted
 * and no plan activated, which is far worse than a sale the operator no
 * longer wanted. The flag stops checkouts being created; it does not
 * abandon ones that already were.
 *
 * ── METADATA NAMES ROWS. THE DATABASE PROVES THEM. ────────────
 *
 * Every id below arrives from Stripe metadata and is then re-read
 * locally. Nothing is trusted because it was in the event: not the
 * amount, not the plan, not the owner, and not the session. The event's
 * embedded Session object is used only to learn which session to fetch.
 *
 * ── AND IT COMPUTES NOTHING ───────────────────────────────────
 *
 * No price, no discount, no shipping, no tax, no purchase date, no plan
 * end and no delivery date. The frozen attempt owns the money and
 * migration 039 owns every date; this file invokes and interprets.
 */

export type AnnualWebhookDeps = {
  /** Re-reads the Checkout Session from Stripe. Never the event's copy. */
  retrieveSession: (sessionId: string) => Promise<Stripe.Checkout.Session>;
  findAttempt: (checkoutAttemptId: string) => Promise<AnnualWebhookAttempt | null>;
  /** Resolves the plan BY payment_checkout_attempt_id, never by the metadata id. */
  findPlanByAttempt: (checkoutAttemptId: string) => Promise<AnnualWebhookPlan | null>;
  linkSession: (attemptId: string, sessionId: string) => Promise<boolean>;
  markPaid: (attemptId: string, paymentIntentId: string) => Promise<boolean>;
  /** public.activate_annual_plan_from_payment(uuid, text, text). */
  activatePlan: (input: {
    annualPlanId: string;
    stripeCheckoutSessionId: string;
    stripePaymentIntentId: string;
  }) => Promise<unknown>;
  worker: AnnualDeliveryWorkerDeps;
};

export type AnnualWebhookResult = {
  annualPlanId: string;
  activation: string;
  deliveries: number;
  worker: AnnualDeliveryWorkerSummary;
};

/**
 * A refusal that is NOT retryable: the correlation is wrong and no number
 * of Stripe redeliveries will make it right.
 *
 * Thrown reasons are sanitised. Ids appear because they are internal and
 * already in the logs; no amount, address, name or email ever does.
 */
export class AnnualWebhookConflict extends Error {}

/**
 * Settles one paid annual Checkout Session.
 *
 * THROWS on anything unresolved. The webhook route turns a throw into a
 * 500 and skips recording the event as processed, so Stripe redelivers
 * against fresh state and a genuinely paid annual plan cannot disappear
 * because one delivery could not reconcile. Every step below is
 * idempotent, so redelivery converges rather than duplicating.
 */
export async function settleAnnualCheckoutSession(
  eventSessionId: string,
  metadata: AnnualSessionMetadata,
  deps: AnnualWebhookDeps
): Promise<AnnualWebhookResult> {
  // 1. THE SESSION, RE-READ FROM STRIPE. The event proves Stripe sent
  //    something; it is not a reason to trust every nested field of a
  //    payload that may be minutes old. Every payment decision below uses
  //    this copy, exactly as the one-time and refund handlers already do.
  const session = await deps.retrieveSession(eventSessionId);

  // 2. THE LOCAL ATTEMPT, by the id metadata named.
  const attempt = await deps.findAttempt(metadata.checkoutAttemptId);

  // 3. AND IT MUST REALLY BE THIS ANNUAL PAYMENT. A subscription attempt,
  //    a synthetic annual DELIVERY attempt and a pre-040 attempt are all
  //    refused by structure, and the request id is cross-checked so an
  //    attempt id alone cannot select a row.
  const attemptCheck = verifyAnnualPaymentAttempt({ attempt, metadata });
  if (!attemptCheck.ok || !attempt) {
    throw new AnnualWebhookConflict(
      `annual session ${session.id}: ${attemptCheck.ok ? "attempt missing" : attemptCheck.reason}`
    );
  }
  const attemptUserId = attempt.user_id as string;

  // 4. THE PLAN, resolved through the DATABASE RELATIONSHIP and then
  //    compared with the id the metadata claimed. Resolving by the
  //    metadata id would let a session naming somebody else's plan reach
  //    an activation call for it.
  const plan = await deps.findPlanByAttempt(attempt.id);
  const planCheck = verifyAnnualPlanCorrelation({ plan, metadata, attemptUserId });
  if (!planCheck.ok || !plan) {
    throw new AnnualWebhookConflict(
      `annual session ${session.id}: ${planCheck.ok ? "plan missing" : planCheck.reason}`
    );
  }

  // 5. THE SESSION LINK. Migration 039 expects this recovery: the
  //    checkout route links best-effort, so a request that died after
  //    Stripe created the session leaves an attempt with none. A
  //    DIFFERENT session is never overwritten.
  const link = decideSessionLink({
    storedSessionId: attempt.stripe_checkout_session_id,
    retrievedSessionId: session.id,
  });
  if (link.kind === "conflict") {
    throw new AnnualWebhookConflict(`annual attempt ${attempt.id}: ${link.reason}`);
  }
  if (link.kind === "link") {
    const linked = await deps.linkSession(attempt.id, session.id);
    if (!linked) {
      // Retryable: nothing is wrong, the write did not land. Activation
      // requires the session id, so stopping here is honest.
      throw new Error(`annual attempt ${attempt.id}: failed to link the Stripe session`);
    }
  }

  // 6. THE PAYMENT, against the FROZEN expected total. The same pure
  //    evaluator the one-time flow uses: paid state, currency and amount,
  //    with the attempt as the authority. No annual price is recomputed
  //    and no amount from metadata is consulted.
  const evaluation = evaluateStripeSessionPayment(
    {
      payment_status: session.payment_status ?? "",
      currency: session.currency ?? "",
      amount_total: session.amount_total,
    },
    {
      currency: attempt.currency,
      expected_total_gross_cents: attempt.expected_total_gross_cents,
    }
  );
  if (!evaluation.shouldMarkPaid) {
    throw new AnnualWebhookConflict(
      `annual attempt ${attempt.id} not settleable - ${evaluation.reason}`
    );
  }

  // A PaymentIntent is REQUIRED. It is what migration 039 stores on the
  // plan and what its refund writer resolves by; an invoice id, a
  // customer id or an email is not a substitute.
  const paymentIntentId = annualPaymentIntentId(session);
  if (!paymentIntentId) {
    throw new AnnualWebhookConflict(`annual session ${session.id} has no payment intent`);
  }

  // 7. MARK IT PAID, through the existing writer and only now.
  //    The already-settled guard lives in the rules module in front of
  //    this call rather than inside markAttemptPaid, which is an
  //    unconditional write the one-time and subscription flows depend on.
  const paid = decidePaidState({
    attemptStatus: attempt.status,
    storedPaymentIntentId: attempt.stripe_payment_intent_id,
    verifiedPaymentIntentId: paymentIntentId,
  });
  if (paid.kind === "conflict") {
    throw new AnnualWebhookConflict(`annual attempt ${attempt.id}: ${paid.reason}`);
  }
  if (paid.kind === "settle") {
    const marked = await deps.markPaid(attempt.id, paymentIntentId);
    if (!marked) {
      throw new Error(`annual attempt ${attempt.id}: failed to mark paid`);
    }
  }

  // 8. ACTIVATION. Migration 039 re-proves every one of the facts above
  //    under its own row lock and then owns everything this file must
  //    not compute: purchased_at from the attempt's paid_at, plan_end_at
  //    at +8736 hours, and thirteen delivery rows at 672-hour steps.
  const activation = interpretAnnualActivationResult(
    await deps.activatePlan({
      annualPlanId: plan.id,
      stripeCheckoutSessionId: session.id,
      stripePaymentIntentId: paymentIntentId,
    })
  );

  if (!activation.ok) {
    if (activation.terminal) {
      // A plan somebody already ended. Acknowledged as a historical
      // replay rather than retried forever - and safe to acknowledge
      // ONLY because the attempt, the plan, the session and the
      // PaymentIntent were all proved to belong together above. Random
      // metadata pointing at a terminal plan never reaches this line.
      console.error(`Annual webhook: plan ${plan.id} is terminal - acknowledged historical replay.`);
      return {
        annualPlanId: plan.id,
        activation: "terminal",
        deliveries: 0,
        worker: { claimed: 0, fulfilled: 0, guarded: 0, failed: 0, outcomes: [], errors: [] },
      };
    }
    // Everything else - a conflicting PaymentIntent or session, an
    // unpaid attempt, a total mismatch, a wrong owner, a missing
    // timestamp, a delivery count that is not thirteen, or a word this
    // code has never seen - is NOT a successful activation.
    throw new Error(`annual plan ${plan.id} activation refused: ${activation.reason}`);
  }

  // 9. DELIVERY 1, THROUGH THE SHARED QUEUE. Migration 039 scheduled it
  //    at paid_at, so it is due now. It is claimed and fulfilled by the
  //    same worker the cron will use for deliveries 2 to 13 - there is no
  //    special first-delivery path, and no order is created here.
  //
  //    The queue is global, so this pass may also pick up another
  //    customer's overdue delivery. That is legitimate work and it is
  //    processed rather than discarded.
  const worker = await runAnnualDeliveryWorker(deps.worker);

  if (worker.failed > 0) {
    // The plan IS activated and durable at this point; only fulfillment
    // had trouble. Throwing makes Stripe redeliver, which re-runs an
    // activation that answers 'already_active' and another worker pass -
    // both idempotent. A guarded refusal is not a failure and does not
    // reach here.
    throw new Error(
      `annual plan ${plan.id} activated, delivery worker reported ${worker.failed} failure(s): ${worker.errors.join("; ")}`
    );
  }

  return {
    annualPlanId: plan.id,
    activation: activation.result,
    deliveries: activation.deliveries,
    worker,
  };
}
