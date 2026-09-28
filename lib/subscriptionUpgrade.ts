import type Stripe from "stripe";
import {
  resolveTransitionAnchor,
  type TransitionAnchor,
  type UpgradeSubscriptionRow,
} from "./subscriptionUpgradeRules.ts";

/**
 * STOPPING THE OLD SUBSCRIPTION, ONCE THE YEAR IS PAID FOR.
 *
 * The one write this feature makes to an existing contract, and it makes
 * it in exactly one place. Called from the annual settlement path AFTER
 * the payment is durable and BEFORE the plan is activated, so the two
 * halves of the handover cannot come apart in the dangerous direction.
 *
 * ── THE INVARIANT THIS ORDERING EXISTS FOR ────────────────────
 *
 * There is one outcome that must never survive: a paid, ACTIVE annual
 * plan beside a subscription that goes on renewing. It cannot happen,
 * because the plan is not activated until this function has returned an
 * anchor - and it only returns one once Stripe has accepted the end
 * date. Every partial failure therefore leaves the plan 'pending':
 *
 *   Stripe refused          nothing written anywhere, throw, retry
 *   Stripe accepted,
 *   local write failed      Stripe holds the end date, throw, retry -
 *                           and the retry calls Stripe again, which is
 *                           idempotent both by key and by value
 *   both succeeded,
 *   activation failed       the subscription is correctly stopped and
 *                           the plan is still 'pending'; the retry
 *                           re-derives the SAME anchor and activates
 *
 * The opposite - a stopped subscription and no annual plan - is the safe
 * failure, is recoverable by the same retry, and is the one this order
 * deliberately chooses.
 *
 * ── STRIPE FIRST, LOCAL SECOND ────────────────────────────────
 *
 * The order POST /api/subscriptions/cancel already uses, for the reason
 * it gives: a cancellation is not real until Stripe has accepted it. It
 * also makes the retry converge. The local row's
 * cancellation_effective_at is what a later attempt reads to decide it
 * has nothing left to schedule, and that column is written last - so it
 * can never say "done" while Stripe still intends to bill.
 *
 * ── AND IT USES NO CUTOFF ─────────────────────────────────────
 *
 * The end date is the subscription's CURRENT PAID PERIOD END, whenever
 * the upgrade happens. Migration 034's 14-day rule is not consulted,
 * not imported and not changed; it still governs every ordinary
 * cancellation. See lib/subscriptionUpgradeRules.ts for why an upgrade
 * is a different operation.
 */

export type UpgradeTransitionSubscription = UpgradeSubscriptionRow & {
  user_id: string;
  stripe_subscription_id: string | null;
};

export type ScheduleCancellationOutcome = { result: string };

export type UpgradeTransitionDeps = {
  getStripe: () => Stripe | null;
  /** The local row, read with the service role. Never from a payload. */
  loadSubscription: (subscriptionId: string) => Promise<UpgradeTransitionSubscription | null>;
  /** A FRESH read of the Stripe subscription - the authoritative period. */
  retrieveStripeSubscription: (stripe: Stripe, stripeSubscriptionId: string) => Promise<Stripe.Subscription>;
  /** The period of that subscription, through the existing resolver. */
  resolvePeriodEnd: (subscription: Stripe.Subscription) => string | null;
  /** stripe.subscriptions.update(id, { cancel_at }), with an idempotency key. */
  scheduleAtStripe: (input: {
    stripe: Stripe;
    stripeSubscriptionId: string;
    cancelAtIso: string;
    idempotencyKey: string;
  }) => Promise<void>;
  /** public.schedule_subscription_cancellation, unchanged by this phase. */
  scheduleLocally: (input: {
    subscriptionId: string;
    userId: string;
    requestedAt: string;
    effectiveAt: string;
    cancelAt: string;
  }) => Promise<ScheduleCancellationOutcome>;
};

export class UpgradeTransitionConflict extends Error {}

/**
 * The Stripe idempotency key for an upgrade's cancellation.
 *
 * Keyed on the subscription AND the date, so every redelivery of the
 * same settlement reuses one key while a genuinely different handover
 * date - a renewal landed between attempts - gets its own. Distinct from
 * subscriptionCancelIdempotencyKey and deferredCancelIdempotencyKey by
 * prefix, so an upgrade and an ordinary cancellation can never collide.
 */
export function upgradeCancelIdempotencyKey(subscriptionId: string, effectiveAtIso: string): string {
  return `gloa/subscription-upgrade/${subscriptionId}/${Math.floor(Date.parse(effectiveAtIso) / 1000)}`;
}

/**
 * The two results migration 034 gives that mean "the end date this
 * upgrade wants is now durably recorded".
 *
 * 'already_scheduled' is as good as 'scheduled': it is what a redelivery
 * of the same settlement produces, and what a customer who had already
 * cancelled for this very date produces.
 */
export const UPGRADE_SCHEDULE_SETTLED: readonly string[] =
  Object.freeze(["scheduled", "already_scheduled"]);

export type UpgradeTransitionResult = {
  anchor: TransitionAnchor;
  /** What migration 034 answered, or null when it was not called. */
  scheduleResult: string | null;
};

/**
 * Stops the source subscription and answers with the handover date.
 *
 * `paidAt` is the annual attempt's own paid_at - a durable column, not a
 * clock - so every retry of the same settlement computes the same floor
 * and asks migration 034 the same question.
 */
export async function applyUpgradeTransition(input: {
  sourceSubscriptionId: string;
  annualPlanUserId: string;
  paidAt: string;
  deps: UpgradeTransitionDeps;
}): Promise<UpgradeTransitionResult> {
  const { deps } = input;

  const sub = await deps.loadSubscription(input.sourceSubscriptionId);
  if (!sub) {
    // The plan names a subscription that does not exist. Never
    // retryable, and nothing was written.
    throw new UpgradeTransitionConflict(
      `upgrade: subscription ${input.sourceSubscriptionId} not found`
    );
  }
  // THE PLAN AND THE SUBSCRIPTION MUST BELONG TO THE SAME PERSON.
  // Migration 066 proved it when the plan was created; this is the
  // transaction that ends somebody's contract, so it is proved again.
  if (sub.user_id !== input.annualPlanUserId) {
    throw new UpgradeTransitionConflict(
      `upgrade: subscription ${sub.id} does not belong to the plan's owner`
    );
  }

  /*
    A STANDING END DATE WINS, AND IS NEVER TOUCHED.

    The customer has already been told when this subscription ends -
    migration 034 refuses to move it and answers 'conflict' for a
    different date - so the upgrade adopts it as the handover date
    instead of shortening or extending it. Stripe is not called at all on
    this path: for an early cancellation it already holds the date, and
    for a deferred late one the mechanism that owns that promise will set
    it when the last cycle is paid.
  */
  const standing = sub.cancellation_effective_at ?? null;

  let periodEnd: string | null = null;
  let stripe: Stripe | null = null;
  if (!standing) {
    stripe = deps.getStripe();
    if (!stripe) throw new Error("upgrade: STRIPE_SECRET_KEY is not configured");
    if (!sub.stripe_subscription_id) {
      throw new UpgradeTransitionConflict(
        `upgrade: subscription ${sub.id} has no Stripe binding to stop`
      );
    }
    // THE AUTHORITATIVE PERIOD, RE-READ NOW. Not the local mirror, and
    // not whatever the review screen showed days ago: an asynchronous
    // payment can settle long after the customer pressed the button, and
    // if the subscription renewed in between then the period it renewed
    // into is the one that must be handed over.
    const stripeSubscription = await deps.retrieveStripeSubscription(stripe, sub.stripe_subscription_id);
    periodEnd = deps.resolvePeriodEnd(stripeSubscription);
  }

  const resolved = resolveTransitionAnchor({
    standingEffectiveAt: standing,
    periodEnd,
    paidAt: input.paidAt,
  });
  if (!resolved.ok) {
    throw new UpgradeTransitionConflict(`upgrade: subscription ${sub.id} - ${resolved.reason}`);
  }
  const anchor = resolved.anchor;

  if (!anchor.needsStripeSchedule) {
    // Nothing to do. The end date already stands, in both systems or in
    // the one that owns it, and this function has written nothing.
    return { anchor, scheduleResult: null };
  }

  /*
    STRIPE FIRST. cancel_at, not cancel_at_period_end, because the date
    is explicit and must match what the local row records to the second -
    which is exactly what migration 034 refuses to store otherwise.

    NO PRORATION AND NO REFUND. Setting cancel_at schedules an end; it
    does not credit, refund or re-invoice anything, and nothing in this
    file asks Stripe for any of those.
  */
  if (!stripe || !sub.stripe_subscription_id) {
    throw new UpgradeTransitionConflict(`upgrade: subscription ${sub.id} cannot be scheduled`);
  }
  await deps.scheduleAtStripe({
    stripe,
    stripeSubscriptionId: sub.stripe_subscription_id,
    cancelAtIso: anchor.at,
    idempotencyKey: upgradeCancelIdempotencyKey(sub.id, anchor.at),
  });

  /*
    THEN THE LOCAL ROW, through migration 034's own writer.

    requestedAt is the annual payment's paid_at rather than a clock, so a
    redelivery asks the identical question and gets 'already_scheduled'
    rather than a second write.

    'conflict' means a DIFFERENT end date appeared between the read above
    and this write - a customer cancelling in the same seconds. Retryable
    on purpose: the next attempt reads that standing date and adopts it,
    which is the correct outcome and the one that does not overwrite
    something the customer was just told.

    'period_moved' means the local mirror has advanced past the date we
    computed. Also retryable: the next attempt re-reads Stripe and
    resolves against the period that actually exists now.
  */
  const outcome = await deps.scheduleLocally({
    subscriptionId: sub.id,
    userId: sub.user_id,
    requestedAt: input.paidAt,
    effectiveAt: anchor.at,
    cancelAt: anchor.at,
  });

  if (!UPGRADE_SCHEDULE_SETTLED.includes(outcome.result)) {
    throw new Error(
      `upgrade: subscription ${sub.id} cancellation not recorded - ${outcome.result}`
    );
  }

  return { anchor, scheduleResult: outcome.result };
}
