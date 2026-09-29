/**
 * THE HANDOVER FROM A 4-WEEK SUBSCRIPTION TO A PREPAID ANNUAL PLAN.
 *
 * One customer, two contracts, and exactly one date between them: the
 * first day the subscription no longer covers. Before that date the
 * subscription delivers; from it the annual plan does. Nothing overlaps,
 * nothing is charged twice, and no box arrives twice.
 *
 * Every function here is pure and takes rows. The account renders its
 * CTA from them, the checkout route decides eligibility with them and
 * the webhook resolves the final anchor with them, so the button, the
 * refusal and the thirteen delivery dates cannot disagree.
 *
 * ── WHY THE 14-DAY CUTOFF IS NOT USED HERE ────────────────────
 *
 * lib/subscriptionCancellationRules.ts's resolveCancellationSchedule is
 * the rule for a CUSTOMER CANCELLING. Asked inside the last fortnight of
 * a cycle it promises one more delivery and one more charge, because a
 * renewal that close is already in motion and taking it away would be
 * taking away something the customer expected.
 *
 * AN UPGRADE IS NOT THAT OPERATION. The customer has just paid for a
 * whole year in advance; billing them for one more 4-week cycle on top,
 * and shipping a box the annual plan would have shipped anyway, is the
 * opposite of what they bought. So the upgrade names its own end date -
 * the current paid period's end, whenever it is asked - and migration
 * 034's writer accepts it because that writer takes the effective date
 * as an ARGUMENT and applies no cutoff of its own.
 *
 * The cutoff rule is not imported, not re-implemented and not changed.
 * It still governs every ordinary cancellation, unchanged.
 *
 * ── AND WHY THE ANCHOR IS DECIDED TWICE ───────────────────────
 *
 * Once before payment, to show the customer what they are agreeing to,
 * and once at settlement, to write it. They are the same function over
 * different inputs, and the settlement one wins:
 *
 *   BEFORE   from the local subscription row, for the review screen.
 *            It is a statement about today, and the copy says so,
 *            because an asynchronous payment method can settle days
 *            later - by which time the subscription may have renewed.
 *   AT       from a FRESH read of the Stripe subscription. This is the
 *            one that becomes annual_plans.schedule_anchor_at and the
 *            origin of all thirteen dates.
 *
 * A frozen-at-checkout anchor would have meant a successful payment
 * ending in a failed transition for no better reason than that Stripe
 * took its time.
 */

import {
  hasEnded,
  isCancellationScheduled,
  type SubscriptionAccountFields,
} from "./subscriptionCancellationRules.ts";
import {
  isLiveAnnualPlan,
  isLiveSubscription,
  type AnnualPlanEligibilityRow,
  type SubscriptionEligibilityRow,
} from "./purchaseEligibility.ts";

/* ══════════════════════════════════════════════════════════════
   MAY THIS SUBSCRIPTION BE UPGRADED?
   ══════════════════════════════════════════════════════════════ */

/**
 * The columns the upgrade decision needs.
 *
 * current_period_end is the one that is not merely lifecycle: it is the
 * handover date, and a subscription without it cannot hand over at all.
 */
export type UpgradeSubscriptionRow = SubscriptionEligibilityRow & {
  customer_type?: string | null;
};

/**
 * May this customer swap THIS subscription for an annual plan?
 *
 * Four questions, and all four are asked of current state:
 *
 *   IS IT LIVE?          isLiveSubscription - the same predicate the
 *                        checkout route refuses a duplicate with. An
 *                        ended abo is history and has nothing to hand
 *                        over; a pending one never reached Stripe.
 *   CAN IT HAND OVER?    a current_period_end to hand over AT. Without
 *                        one there is no date, and this module does not
 *                        invent dates.
 *   IS IT B2C?           the B2B supply agreements are a different
 *                        system with a different contract, and migration
 *                        034's writer refuses them too.
 *   IS AN ANNUAL PLAN
 *   ALREADY RUNNING?     isLiveAnnualPlan - the same predicate that
 *                        refuses an ordinary duplicate annual purchase.
 *                        Two prepaid years at once is not an upgrade.
 *
 * A CANCELLATION ALREADY STANDING IS NOT A REFUSAL. The subscription is
 * still live, still delivering and still the thing being replaced; the
 * only difference is that its end date already exists and must be
 * preserved rather than recomputed - see resolveTransitionAnchor.
 */
export function mayUpgradeToAnnualPlan(input: {
  subscription: UpgradeSubscriptionRow | null | undefined;
  annualPlans: AnnualPlanEligibilityRow[] | null | undefined;
}): boolean {
  const sub = input?.subscription;
  if (!sub || typeof sub !== "object") return false;
  if (typeof sub.id !== "string" || sub.id.trim() === "") return false;
  if (sub.customer_type !== undefined && sub.customer_type !== null
    && sub.customer_type !== "private") {
    return false;
  }
  if (!isLiveSubscription(sub)) return false;
  if (!isUsableDate(sub.current_period_end)) return false;

  const plans = Array.isArray(input?.annualPlans) ? input.annualPlans : [];
  if (plans.some(isLiveAnnualPlan)) return false;

  return true;
}

/** A timestamp this module is willing to build a promise on. */
function isUsableDate(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "" && !Number.isNaN(Date.parse(value));
}

/* ══════════════════════════════════════════════════════════════
   THE ONE DATE
   ══════════════════════════════════════════════════════════════ */

/**
 * Where a transition date came from. Carried so the caller can say the
 * right thing rather than guess, and so a test can tell the three cases
 * apart without re-deriving them.
 *
 *   'standing_cancellation'  the subscription already had an end date.
 *                            The upgrade adopts it and changes nothing -
 *                            neither Stripe nor the local row.
 *   'period_end'             the ordinary case. The current paid period
 *                            ends, and the annual plan starts there.
 *   'payment'                the subscription's period had already
 *                            ended by the time the money settled, so it
 *                            covers nothing and the plan starts at the
 *                            purchase. Only reachable on a very late
 *                            settlement.
 */
export type TransitionAnchorSource = "standing_cancellation" | "period_end" | "payment";

export type TransitionAnchor = {
  /** ISO. The first date the subscription no longer covers. */
  at: string;
  source: TransitionAnchorSource;
  /**
   * True when the upgrade must ask Stripe to stop the subscription.
   * False when an end date already stands, because then Stripe has
   * already been told - or, in the deferred late case, will be told by
   * the mechanism that already owns that promise.
   */
  needsStripeSchedule: boolean;
};

export type TransitionAnchorResult =
  | { ok: true; anchor: TransitionAnchor }
  | { ok: false; reason: string };

/**
 * The handover date, from durable facts and nothing else.
 *
 * `standingEffectiveAt` is the subscription's cancellation_effective_at
 * if one is already promised. It WINS, always: the customer has been
 * told that date, migration 034 refuses to move it, and an upgrade is
 * not a reason to shorten or extend an end somebody already agreed to.
 *
 * `periodEnd` is the current paid period's end. At settlement this comes
 * from a FRESH read of the Stripe subscription through the existing
 * resolveSubscriptionPeriod, never from the local mirror and never from
 * a clock.
 *
 * `paidAt` is when the annual money actually settled. It is a floor, not
 * an anchor: a period that ended before the payment landed covers
 * nothing, so the plan starts at the purchase instead of scheduling
 * boxes into the past.
 *
 * NO ARITHMETIC. No +28 days, no cadence, no now(). Every answer is one
 * of the three values handed in.
 */
export function resolveTransitionAnchor(input: {
  standingEffectiveAt?: string | null;
  periodEnd?: string | null;
  paidAt: string;
}): TransitionAnchorResult {
  const paidAt = input?.paidAt;
  if (!isUsableDate(paidAt)) return { ok: false, reason: "paid_at_missing" };

  const standing = isUsableDate(input?.standingEffectiveAt) ? input.standingEffectiveAt : null;
  const periodEnd = isUsableDate(input?.periodEnd) ? input.periodEnd : null;

  const candidate = standing ?? periodEnd;
  if (!candidate) return { ok: false, reason: "period_end_missing" };

  const source: TransitionAnchorSource = standing ? "standing_cancellation" : "period_end";
  // A promise already made is never re-made, however this resolves.
  const needsStripeSchedule = standing === null;

  if (Date.parse(candidate) >= Date.parse(paidAt)) {
    return { ok: true, anchor: { at: candidate, source, needsStripeSchedule } };
  }
  // The period is already over. Migration 066 refuses an anchor before
  // the purchase, and it is right to: the plan cannot start before it
  // was bought.
  return { ok: true, anchor: { at: paidAt, source: "payment", needsStripeSchedule } };
}

/**
 * What the REVIEW SCREEN may say before the customer pays.
 *
 * The same rule over the local row: the standing end date if there is
 * one, otherwise the current period's end. It is an expectation rather
 * than a promise, which is why it has no paidAt to floor against and why
 * the copy beside it names the condition.
 */
export function expectedTransitionAt(sub: UpgradeSubscriptionRow | null | undefined): string | null {
  if (!sub || typeof sub !== "object") return null;
  if (hasEnded(sub as SubscriptionAccountFields)) return null;
  if (isCancellationScheduled(sub as SubscriptionAccountFields)
    && isUsableDate(sub.cancellation_effective_at)) {
    return sub.cancellation_effective_at;
  }
  return isUsableDate(sub.current_period_end) ? sub.current_period_end : null;
}

/* ══════════════════════════════════════════════════════════════
   WHAT THE CUSTOMER IS TOLD
   ══════════════════════════════════════════════════════════════ */

/** The promise, in one sentence, beside the CTA. */
export const UPGRADE_EXPLAINER =
  "Dein aktuelles Abo läuft bis zum Ende des bereits bezahlten Zeitraums weiter. "
  + "Danach übernimmt dein Jahresplan. Es gibt keine doppelte Lieferung.";

/** The CTA itself, spelled once so the page and the tests agree. */
export const UPGRADE_CTA = "AUF JAHRESPLAN WECHSELN";

/** What the account calls a subscription that is handing over. */
export const UPGRADE_SCHEDULED_LABEL = "Wechsel zum Jahresplan vorgemerkt";

/**
 * The one caveat an asynchronous payment needs.
 *
 * Shown on the review screen next to the expected date, because for
 * SEPA and its relatives the money can settle days later and the real
 * handover date is whatever the subscription's period is by then.
 */
export const UPGRADE_DATE_IS_CONFIRMED_ON_PAYMENT =
  "Das endgültige Startdatum bestätigen wir, sobald deine Zahlung eingegangen ist.";

/**
 * THE REFUSAL WHEN ONE UPGRADE CHECKOUT IS STILL PAYABLE (migration 067).
 *
 * Not "no" and not "already running": the customer has a Stripe Checkout
 * Session open right now for this very subscription, and the honest
 * answer names both ways out of it - finish that one, or wait for it to
 * lapse. It lapses on its own, within half an hour, because the claim
 * that produces this sentence expires at exactly the moment the session
 * it guards stops being payable.
 *
 * It deliberately names no date, no plan and no amount. The account page
 * renders the customer's own pending upgrade under their own session;
 * a checkout refusal is not the place to restate it.
 */
export const UPGRADE_ALREADY_PENDING =
  "Du hast bereits einen offenen Wechsel zum Jahresplan. "
  + "Schließe den bestehenden Checkout ab oder versuche es später erneut.";

/** The refusal, when a subscription cannot be handed over after all. */
export const UPGRADE_NOT_AVAILABLE =
  "Dieser Wechsel ist gerade nicht möglich. Prüfe dein Abo und deinen Jahresplan im Konto.";
