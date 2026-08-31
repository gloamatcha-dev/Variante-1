import type Stripe from "stripe";
import {
  annualPaymentIntentId,
  decideAnnualPaymentReadiness,
  decidePaidState,
  decideSessionLink,
  interpretAnnualActivationResult,
  verifyAnnualPaymentAttempt,
  verifyAnnualPlanCorrelation,
  type AnnualSessionMetadata,
  type AnnualSettlementTrigger,
  type AnnualWebhookAttempt,
  type AnnualWebhookPlan,
} from "./annualPlanWebhookRules";
import { runAnnualDeliveryWorker, type AnnualDeliveryWorkerSummary } from "./annualDeliveryWorker";
import type {
  AnnualPaidSettlementOutcome,
  AnnualSessionLinkOutcome,
} from "./checkoutAttempts";
import { evaluateStripeSessionPayment } from "./stripeFulfillment";
import type { AnnualDeliveryWorkerDeps } from "./annualDeliveryWorker";

/**
 * A paid annual Checkout Session becomes an active annual plan
 * (Phase 4B4).
 *
 * This is the canonical settlement path for a prepaid annual plan, and
 * the only one. The browser's return from Stripe is not payment, the
 * success URL grants nothing, and nothing else in the system activates a
 * plan.
 *
 * TWO Stripe events reach it (Phase 4B4.2): checkout.session.completed,
 * and checkout.session.async_payment_succeeded for the delayed
 * notification methods whose money arrives days after the session does.
 * They run the SAME verification, not a second architecture - see the
 * trigger parameter, which changes exactly one decision.
 *
 * ── WHAT IT DOES, IN ORDER ────────────────────────────────────
 *
 *    1. re-retrieve the Checkout Session from Stripe
 *    2. re-read the local PAYMENT attempt named by metadata
 *    3. prove the attempt IS this annual payment, and not one of three
 *       impostors
 *    4. resolve the plan through annual_plans.payment_checkout_attempt_id
 *       and cross-check the id metadata named
 *    5. self-heal the Stripe session link ATOMICALLY, or refuse a
 *       different one
 *    6. verify the payment against the FROZEN expected total, or stop
 *       here if Stripe has not confirmed it yet
 *    7. settle the attempt paid ATOMICALLY, write-once
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
 * ── AND THE DATABASE, NOT THIS FILE, DECIDES WHO WON ──────────
 *
 * Stripe delivers concurrently and retries hard, so two invocations
 * settling one annual payment at the same moment is ordinary. Both of the
 * durable writes here are therefore compare-and-set: they restate the
 * state they expect inside the UPDATE, Postgres serialises them on the
 * row, and the loser re-reads instead of overwriting. The pure decisions
 * above them stay as early diagnostics and are never the guarantee.
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
  /**
   * COMPARE-AND-SET, not a plain write. It carries the state it expects
   * into the UPDATE's own WHERE clause and reports whether it won, lost
   * to an identical link, or hit a genuine conflict.
   */
  linkSessionAtomically: (
    attemptId: string,
    sessionId: string
  ) => Promise<AnnualSessionLinkOutcome>;
  /** Compare-and-set as well. paid_at is written at most once, ever. */
  settlePaidAtomically: (input: {
    attemptId: string;
    stripeCheckoutSessionId: string;
    stripePaymentIntentId: string;
  }) => Promise<AnnualPaidSettlementOutcome>;
  /** public.activate_annual_plan_from_payment(uuid, text, text). */
  activatePlan: (input: {
    annualPlanId: string;
    stripeCheckoutSessionId: string;
    stripePaymentIntentId: string;
  }) => Promise<unknown>;
  worker: AnnualDeliveryWorkerDeps;
};

export type AnnualWebhookResult =
  | {
      /** The plan is active and its first delivery has been through the queue. */
      outcome: "settled" | "terminal";
      annualPlanId: string;
      activation: string;
      deliveries: number;
      worker: AnnualDeliveryWorkerSummary;
    }
  | {
      /**
       * A real annual purchase, correlated and proved, whose payment
       * Stripe has not confirmed yet (Phase 4B4.2).
       *
       * It carries NO activation, NO delivery count and NO worker
       * summary, and that is deliberate rather than tidy: there is no
       * shape in which this variant can report an entitlement, because it
       * has no field to report one in.
       */
      outcome: "payment_pending";
      annualPlanId: string;
      reason: string;
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
  deps: AnnualWebhookDeps,
  /**
   * Which Stripe event asked. It changes ONE decision - whether a
   * not-yet-paid Session is expected or contradictory - and nothing else
   * about the path below. Defaulting to the ordinary trigger keeps the
   * common call site unchanged.
   */
  trigger: AnnualSettlementTrigger = "checkout_completed"
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
  //    THE PRE-READ IS A DIAGNOSTIC, NOT THE GUARANTEE. It refuses an
  //    obviously wrong session before any write is attempted, which keeps
  //    the common failure cheap and legible. But the row it looked at can
  //    change before the write lands, so the write itself is the
  //    authority: the compare-and-set below runs UNCONDITIONALLY, carries
  //    every expectation in its own WHERE clause, and a lost race is
  //    resolved from a fresh read rather than from this decision.
  const linkPrecheck = decideSessionLink({
    storedSessionId: attempt.stripe_checkout_session_id,
    retrievedSessionId: session.id,
  });
  if (linkPrecheck.kind === "conflict") {
    throw new AnnualWebhookConflict(`annual attempt ${attempt.id}: ${linkPrecheck.reason}`);
  }

  const link = await deps.linkSessionAtomically(attempt.id, session.id);
  if (link.kind === "conflict") {
    // A different session won the row, or this row is not a settleable
    // annual payment. Never retryable, and nothing was overwritten.
    throw new AnnualWebhookConflict(`annual attempt ${attempt.id}: ${link.reason}`);
  }
  if (link.kind === "error") {
    // Retryable: nothing is wrong, the write did not land. Activation
    // requires the session id, so stopping here is honest.
    throw new Error(`annual attempt ${attempt.id}: ${link.reason}`);
  }
  // 'linked' and 'already_linked' are both success. The second means
  // another invocation linked this same session, which is exactly what a
  // concurrent redelivery looks like and is not an error.

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
  //    A NOT-YET-PAID SESSION IS NOT AUTOMATICALLY AN ERROR. Delayed
  //    notification methods complete a Checkout Session immediately and
  //    confirm the money days later, so checkout.session.completed with
  //    payment_status "unpaid" is the normal FIRST event for them rather
  //    than a fault. It is acknowledged and nothing is written; Stripe's
  //    later async event runs this same function again and settles it.
  const readiness = decideAnnualPaymentReadiness({
    paymentStatus: session.payment_status ?? "",
    evaluation,
    trigger,
  });
  if (readiness.kind === "refused") {
    throw new AnnualWebhookConflict(
      `annual attempt ${attempt.id} not settleable - ${readiness.reason}`
    );
  }
  if (readiness.kind === "pending") {
    // RETURNS BEFORE EVERY WRITE THAT GRANTS ANYTHING. No PaymentIntent
    // is read, the attempt is not marked paid, no plan is activated and
    // the delivery worker never runs. The only thing that happened above
    // is the session link, which is correlation rather than entitlement
    // and is what the checkout route already attempts.
    console.error(
      `Annual webhook: session ${session.id} is not paid yet (plan ${plan.id}) - awaiting Stripe.`
    );
    return { outcome: "payment_pending", annualPlanId: plan.id, reason: readiness.reason };
  }

  // A PaymentIntent is REQUIRED. It is what migration 039 stores on the
  // plan and what its refund writer resolves by; an invoice id, a
  // customer id or an email is not a substitute.
  const paymentIntentId = annualPaymentIntentId(session);
  if (!paymentIntentId) {
    throw new AnnualWebhookConflict(`annual session ${session.id} has no payment intent`);
  }

  // 7. SETTLE IT PAID, write-once, and only now.
  //    NOT through markAttemptPaid. That writer's predicate is `id = $1`
  //    alone, which is the settled behaviour the one-time and
  //    subscription flows depend on and which this phase does not get to
  //    change - but which would also let a redelivery restamp paid_at and
  //    a second PaymentIntent overwrite the first. The annual flow uses
  //    its own compare-and-set writer instead, and does not import that
  //    one at all.
  const paidPrecheck = decidePaidState({
    attemptStatus: attempt.status,
    storedPaymentIntentId: attempt.stripe_payment_intent_id,
    verifiedPaymentIntentId: paymentIntentId,
  });
  if (paidPrecheck.kind === "conflict") {
    throw new AnnualWebhookConflict(`annual attempt ${attempt.id}: ${paidPrecheck.reason}`);
  }

  //    AND AGAIN, THE WRITE DECIDES. The compare-and-set requires the
  //    verified session, an unset paid_at and an unset PaymentIntent, so
  //    two invocations carrying different PaymentIntents cannot both
  //    succeed and a replay cannot restamp paid_at - which is migration
  //    039's purchased_at and therefore the origin of all thirteen
  //    delivery dates.
  const paid = await deps.settlePaidAtomically({
    attemptId: attempt.id,
    stripeCheckoutSessionId: session.id,
    stripePaymentIntentId: paymentIntentId,
  });
  if (paid.kind === "conflict") {
    throw new AnnualWebhookConflict(`annual attempt ${attempt.id}: ${paid.reason}`);
  }
  if (paid.kind === "error") {
    throw new Error(`annual attempt ${attempt.id}: ${paid.reason}`);
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
        outcome: "terminal",
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
    outcome: "settled",
    annualPlanId: plan.id,
    activation: activation.result,
    deliveries: activation.deliveries,
    worker,
  };
}
