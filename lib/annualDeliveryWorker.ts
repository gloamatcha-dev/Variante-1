/**
 * The shared annual delivery worker (Phase 4B4).
 *
 * A leaf: ZERO imports, no database client, no network, no Stripe, no
 * clock. Both database calls are INJECTED, which is what lets the whole
 * worker be driven in a plain Node test without a Supabase connection -
 * and what keeps it loadable by the test runner at all, since Node cannot
 * resolve this repository's extension-less relative imports.
 *
 * ── ONE WORKER, TWO CALLERS ───────────────────────────────────
 *
 * The annual payment webhook runs it immediately after activating a plan,
 * because migration 039 schedules delivery 1 at paid_at and it is
 * therefore due the moment the plan exists. A later phase will run the
 * same function from the daily cron for deliveries 2 to 13.
 *
 * That is the point of it being shared: DELIVERY 1 IS NOT SPECIAL. It is
 * claimed from the same global queue and fulfilled by the same RPC as
 * every other delivery, so there is no second code path that could
 * disagree with the first - and in particular no path that could mint an
 * order without going through migration 039's atomic fulfillment.
 *
 * ── WHAT IT DOES NOT DO ───────────────────────────────────────
 *
 * It writes no table, reads no catalog, calculates no price, no shipping
 * and no tax, and touches Stripe not at all. It does not select due rows
 * and then update them: claim_due_annual_plan_deliveries IS the queue,
 * and reproducing its predicate here would be a second answer to "what is
 * due" that could drift from the one holding the row locks.
 *
 * It also never loops until empty. The claim is bounded and this makes
 * exactly one pass, so a caller inside a serverless request cannot be
 * turned into an unbounded job by a backlog.
 */

/* ── The queue's contract ───────────────────────────────────── */

/** One row returned by claim_due_annual_plan_deliveries. */
export type ClaimedAnnualDelivery = {
  delivery_id: string;
  annual_plan_id: string;
  delivery_number: number;
  scheduled_for: string;
  /** True when this row was recovered from a stale six-hour claim. */
  reclaimed: boolean;
};

/**
 * The fulfillment results that mean the delivery is done.
 *
 * 'fulfilled' created the order; 'already_fulfilled' found the one a
 * previous run created and returns the same order id. Both are successes
 * and both are idempotent.
 */
export const ANNUAL_FULFILL_SUCCESS_RESULTS: readonly string[] =
  Object.freeze(["fulfilled", "already_fulfilled"]);

/**
 * Results that are the PARENT GUARD doing its job, not a failure.
 *
 * The claim deliberately reads the annual plan without a lock, so it is
 * advisory: a full refund or a future administrative termination can
 * commit between the claim and the fulfillment, and migration 039's
 * fulfillment re-reads the parent FOR UPDATE and refuses. When that
 * happens nothing was created and nothing is wrong - the guard is the
 * feature. Retrying would not change the answer and manufacturing an
 * order would defeat it, so these are counted and reported, never
 * escalated.
 *
 * The delivery returns to being claimable when its lease expires, which
 * is the correct outcome if the plan becomes deliverable again.
 */
export const ANNUAL_FULFILL_GUARDED_RESULTS: readonly string[] =
  Object.freeze(["plan_not_active", "plan_refunded", "delivery_not_claimed"]);

/** What one delivery's fulfillment attempt produced. */
export type AnnualDeliveryOutcome = {
  deliveryId: string;
  deliveryNumber: number;
  annualPlanId: string;
  /** The word migration 039 answered with, or a local failure word. */
  result: string;
  orderId: string | null;
};

export type AnnualDeliveryWorkerSummary = {
  claimed: number;
  fulfilled: number;
  /** Refused by the parent guard after the claim. Not an error. */
  guarded: number;
  /** A result nobody recognises, or a database error. Genuinely wrong. */
  failed: number;
  outcomes: AnnualDeliveryOutcome[];
  /** Sanitised failure reasons. Never an id, an amount or an address. */
  errors: string[];
};

export type AnnualDeliveryWorkerDeps = {
  /** public.claim_due_annual_plan_deliveries(p_limit). Returns the rows it claimed. */
  claimDue: (limit: number) => Promise<ClaimedAnnualDelivery[]>;
  /** public.fulfill_annual_plan_delivery(p_delivery_id). Returns its jsonb answer. */
  fulfillDelivery: (deliveryId: string) => Promise<unknown>;
};

/**
 * How many deliveries one pass may claim.
 *
 * Twenty-five, matching the batch size the transactional email cron
 * already uses for the same reason: a ceiling rather than a target. On a
 * healthy day a webhook-triggered pass finds exactly one row - the plan
 * that was just activated - and what is not reached now is reached by the
 * next pass. Migration 039 clamps its own limit to 100 regardless, so
 * this cannot become unbounded even if it is called wrongly.
 */
export const ANNUAL_DELIVERY_BATCH_LIMIT = 25;

/**
 * One bounded pass over the global due-delivery queue.
 *
 * ── EVERY CLAIMED ROW IS PROCESSED ────────────────────────────
 *
 * The queue is GLOBAL, so a pass triggered by one customer's payment may
 * claim another customer's older due delivery. That is not a problem to
 * be filtered out: every claimed row is legitimate work, and the claim
 * has already moved it out of the queue for six hours. Discarding one
 * because it belongs to a different plan would strand it for the lease
 * duration for no reason, so the worker fulfils everything it claimed.
 *
 * ── A FAILURE DOES NOT ABANDON THE REST ───────────────────────
 *
 * Each delivery has its own try/catch. One plan's database error must not
 * stop the other twenty-four rows this pass already took responsibility
 * for, and the summary reports what happened to each.
 */
export async function runAnnualDeliveryWorker(
  deps: AnnualDeliveryWorkerDeps,
  options: { limit?: number } = {}
): Promise<AnnualDeliveryWorkerSummary> {
  const limit = options.limit ?? ANNUAL_DELIVERY_BATCH_LIMIT;

  const summary: AnnualDeliveryWorkerSummary = {
    claimed: 0,
    fulfilled: 0,
    guarded: 0,
    failed: 0,
    outcomes: [],
    errors: [],
  };

  let claimed: ClaimedAnnualDelivery[];
  try {
    claimed = await deps.claimDue(limit);
  } catch (err) {
    // The queue itself is unreachable. Nothing was claimed, so nothing is
    // stranded; the caller decides whether that is retryable.
    summary.failed += 1;
    summary.errors.push(`claim failed: ${err instanceof Error ? err.message : "unknown error"}`);
    return summary;
  }

  summary.claimed = claimed.length;

  for (const delivery of claimed) {
    try {
      const answer = await deps.fulfillDelivery(delivery.delivery_id);
      const outcome = readFulfillResult(delivery, answer);
      summary.outcomes.push(outcome);

      if (ANNUAL_FULFILL_SUCCESS_RESULTS.includes(outcome.result)) {
        summary.fulfilled += 1;
      } else if (ANNUAL_FULFILL_GUARDED_RESULTS.includes(outcome.result)) {
        summary.guarded += 1;
      } else {
        // FAIL CLOSED on a word nobody recognises. It is not treated as a
        // success because it is not on the failure list.
        summary.failed += 1;
        summary.errors.push(`unexpected fulfillment result: ${outcome.result}`);
      }
    } catch (err) {
      summary.failed += 1;
      summary.outcomes.push({
        deliveryId: delivery.delivery_id,
        deliveryNumber: delivery.delivery_number,
        annualPlanId: delivery.annual_plan_id,
        result: "error",
        orderId: null,
      });
      summary.errors.push(`fulfillment failed: ${err instanceof Error ? err.message : "unknown error"}`);
    }
  }

  return summary;
}

/** Reads migration 039's fulfillment answer without trusting its shape. */
function readFulfillResult(
  delivery: ClaimedAnnualDelivery,
  answer: unknown
): AnnualDeliveryOutcome {
  const payload = answer && typeof answer === "object" && !Array.isArray(answer)
    ? (answer as Record<string, unknown>)
    : {};
  return {
    deliveryId: delivery.delivery_id,
    deliveryNumber: delivery.delivery_number,
    annualPlanId: delivery.annual_plan_id,
    result: typeof payload.result === "string" ? payload.result : "unknown",
    orderId: typeof payload.order_id === "string" ? payload.order_id : null,
  };
}
