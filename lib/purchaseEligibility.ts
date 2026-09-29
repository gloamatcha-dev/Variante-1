/**
 * MAY THIS CUSTOMER BUY THIS CONTRACT AGAIN?
 *
 * One question, asked of CURRENT CONTRACT STATE and of nothing else, and
 * answered the same way on both sides of the wire: the checkout handlers
 * import these functions to refuse a duplicate, and the account portal
 * imports the SAME functions to decide whether to offer the button. A
 * page that offered a purchase the server would refuse would be worse
 * than no button at all, so there is exactly one predicate per product
 * and neither side has a copy of it.
 *
 * ── WHAT IT REFUSES TO ASK ────────────────────────────────────
 *
 * Not "does a row exist for this customer". Not "has this email bought
 * before". Not "is there a Stripe customer". Not "is there a previous
 * checkout attempt". Every one of those is permanent - nothing in this
 * system ever deletes a subscription, an annual plan or a checkout
 * attempt, and nothing expires one either - so a gate built on existence
 * is a gate that closes once and never opens.
 *
 * That matters because the history is deliberately kept. A cancelled
 * subscription and a refunded annual plan stay in the account as the
 * record of what happened, and a customer looking at them must still be
 * able to buy the thing again. Ending a contract is not spending a right.
 *
 * ── SO IT ASKS WHETHER SOMETHING IS STILL RUNNING ─────────────
 *
 * A contract blocks a second one only while it is LIVE. The two products
 * spell that differently because their lifecycles are different, and
 * each definition below is built from the vocabulary its own migration
 * CHECKs rather than from a word invented here.
 *
 * ── AND IT IS NOT THE RACE GUARD ──────────────────────────────
 *
 * Nothing here replaces or weakens idempotency. Two clicks on one form
 * carry ONE request id, and the attempt's row lock - migration 022's
 * claim_pending_subscription_for_attempt, migration 039/040's
 * create_pending_annual_plan_for_attempt - is what makes them one
 * contract. These predicates run BEFORE that claim and only when the
 * checkout does not already own a contract, so a retry of a checkout
 * that has already created its own row is never refused by them: the
 * customer must still be able to reach the Stripe session for the thing
 * they already started.
 */

/*
  THE TWO LEAVES THIS IS BUILT FROM, imported with their extensions - the
  spelling lib/adminActionRoute.ts and its neighbours already use, and
  the one that lets a node test import this module directly rather than
  re-describing its rules in the test.

  Both are pure and import-free. hasEnded is the SAME predicate the
  account prints "Beendet" from, and the two annual vocabularies are
  migration 039's own CHECKed words - so nothing here invents a lifecycle
  state, and a card that says a contract is over cannot coexist with a
  checkout that says it is not.
*/
import { hasEnded, type SubscriptionAccountFields } from "./subscriptionCancellationRules.ts";
import { ANNUAL_ACCOUNT_PAYMENT_STATUSES, ANNUAL_ACCOUNT_STATUSES } from "./annualPlanAccount.ts";

/* ══════════════════════════════════════════════════════════════
   THE MONTHLY SUBSCRIPTION
   ══════════════════════════════════════════════════════════════ */

/**
 * The columns the monthly decision needs, and no others.
 *
 * SubscriptionAccountFields is migration 034's account-facing shape and
 * is what hasEnded already reads; plan_id is added because "a second
 * EQUIVALENT subscription" is a statement about the plan, not about the
 * customer. Two different sizes are two different contracts and always
 * have been - migration 024's unique index is on the PLAN table, per
 * (variant, cadence), never per customer - so nothing here forbids a
 * customer who runs a 30 g abo from also running a 100 g one.
 */
export type SubscriptionEligibilityRow = SubscriptionAccountFields & {
  id: string;
  plan_id: string | null;
};

/**
 * Is this subscription still a running contract?
 *
 * TERMINAL, so it never blocks: hasEnded - status 'cancelled', or a
 * cancelled_at written by customer.subscription.deleted. That is the
 * whole of "ended", and it is deliberately the SAME predicate the
 * account uses to print "Beendet", so a card that says a subscription is
 * over cannot coexist with a checkout that says it is not.
 *
 * ── A SCHEDULED CANCELLATION IS STILL LIVE ────────────────────
 *
 * "Kündigung vorgemerkt" means GLOA has promised an end date and has not
 * reached it. The subscription still bills in the late case and still
 * ships, so a second identical one would be a genuine duplicate - two
 * boxes, two charges - and it is refused. The customer may buy again the
 * moment the promise is kept.
 *
 * ── AND 'pending' DELIBERATELY DOES NOT BLOCK ─────────────────
 *
 * This is the one place where the safe-looking answer is the wrong one.
 * A pending subscription is written BEFORE Stripe is contacted, and
 * nothing in this system ever expires it: a customer who opened the
 * Checkout page and closed the tab leaves a pending row behind for good.
 * Blocking on it would hand that abandoned tab a permanent veto over the
 * size the customer wanted - the exact class of gate this module exists
 * to remove - and it cannot be told apart from a genuine one, because
 * stripe_subscription_id is bound only at activation.
 *
 * What that leaves open is narrow and is not an existence gate: between
 * a first invoice being paid and invoice.paid being handled, a customer
 * who deliberately started a SECOND checkout would not be refused. Two
 * clicks cannot do it - they share a request id and the attempt's row
 * lock - and the window closes by itself within the webhook. Closing it
 * durably would take a partial unique index on (user_id, plan_id), which
 * is a migration and is deliberately not taken here.
 */
export function isLiveSubscription(sub: SubscriptionEligibilityRow): boolean {
  if (hasEnded(sub)) return false;
  return sub.status !== "pending";
}

/** The mirror image, named positively where callers read it that way. */
export function subscriptionHasEndedForGood(sub: SubscriptionEligibilityRow): boolean {
  return hasEnded(sub);
}

/**
 * The subscription that stands in the way of buying `planId` again, or
 * null.
 *
 * `exceptId` is the subscription this very checkout already created. A
 * retry must find its own Stripe session, not a refusal, so the row the
 * attempt already owns is never allowed to block the attempt that owns
 * it. The caller passes the id from the attempt's own column, so it
 * cannot be supplied by a browser.
 *
 * A row with no plan_id - a plan deleted from the catalog sets it NULL -
 * cannot be shown to be equivalent to anything and therefore blocks
 * nothing. The contract itself is unaffected and stays in the account.
 */
export function findBlockingSubscription(
  subs: SubscriptionEligibilityRow[] | null | undefined,
  planId: string,
  exceptId?: string | null
): SubscriptionEligibilityRow | null {
  const wanted = typeof planId === "string" ? planId.trim() : "";
  if (wanted === "") return null;

  for (const sub of Array.isArray(subs) ? subs : []) {
    if (!sub || typeof sub !== "object") continue;
    if (typeof sub.id !== "string" || sub.id === "") continue;
    if (exceptId && sub.id === exceptId) continue;
    if (sub.plan_id !== wanted) continue;
    if (isLiveSubscription(sub)) return sub;
  }
  return null;
}

/** May the customer start a subscription on this plan right now? */
export function mayStartSubscription(
  subs: SubscriptionEligibilityRow[] | null | undefined,
  planId: string,
  exceptId?: string | null
): boolean {
  return findBlockingSubscription(subs, planId, exceptId) === null;
}

/* ══════════════════════════════════════════════════════════════
   THE PREPAID ANNUAL PLAN
   ══════════════════════════════════════════════════════════════ */

/**
 * The columns the annual decision needs.
 *
 * paymentAttemptId is here for the same reason the
 * subscription's exception is: it is how a retry recognises the plan it
 * already created. It is NOT on the attempt row - migration 039 keeps
 * checkout_attempts.annual_plan_id for the thirteen DELIVERY attempts
 * and leaves it NULL on the payment attempt - so the link is read from
 * the plan, in the opposite direction to the subscription's. Server-side
 * only: the account never selects that column and never needs to.
 */
export type AnnualPlanEligibilityRow = {
  id: string;
  status: string;
  paymentStatus: string;
  paymentAttemptId?: string | null;
};

/**
 * The server's row, in the shape this module reads.
 *
 * ONE EXPLICIT MAPPING, here rather than in the route, because the
 * spelling is the only difference between the two callers: the account
 * already derives AnnualPlanAccountView - camelCase, mapped by
 * lib/annualPlanAccount.ts - and passes it straight in, while a
 * server-side read comes back from PostgREST in the column names.
 * Writing the mapping once means the two sides cannot answer differently
 * because one of them read a field that was undefined.
 */
export function toAnnualEligibilityRow(row: {
  id: string;
  status: string;
  payment_status: string;
  payment_checkout_attempt_id?: string | null;
}): AnnualPlanEligibilityRow {
  return {
    id: row.id,
    status: row.status,
    paymentStatus: row.payment_status,
    paymentAttemptId: row.payment_checkout_attempt_id ?? null,
  };
}

/**
 * Is this annual plan still a running contract?
 *
 * LIVE means exactly one thing: migration 039 says status 'active', and
 * the money has not gone back. Everything else is terminal and blocks
 * nothing:
 *
 *   completed   the year is over and all thirteen boxes shipped.
 *   cancelled   nothing is owed.
 *   refunded    the customer was given their money back. A plan they
 *               were refunded for must NOT keep consuming their right to
 *               buy another one - it is the clearest case of history
 *               being mistaken for entitlement, and it is the production
 *               case this module was written for.
 *   pending     not a contract at all. It is written before Stripe is
 *               contacted and nothing expires it, so an abandoned
 *               checkout would otherwise veto every future purchase.
 *
 * A PARTIAL refund still blocks. The customer was refunded one box and
 * is still owed the other twelve; the plan keeps generating them, and a
 * second plan on top of it would be a duplicate.
 *
 * An unrecognised word in either column blocks, because a state this
 * build does not understand is not a state it may declare finished.
 */
export function isLiveAnnualPlan(plan: AnnualPlanEligibilityRow): boolean {
  if (!plan || typeof plan !== "object") return false;
  if (typeof plan.status !== "string" || typeof plan.paymentStatus !== "string") return false;

  const knownStatus = ANNUAL_ACCOUNT_STATUSES.includes(plan.status);
  const knownPayment = ANNUAL_ACCOUNT_PAYMENT_STATUSES.includes(plan.paymentStatus);
  if (!knownStatus || !knownPayment) return true;

  if (plan.status !== "active") return false;
  return plan.paymentStatus !== "refunded";
}

/** True once nothing is owed and nothing is being established. */
export function annualPlanHasEndedForGood(plan: AnnualPlanEligibilityRow): boolean {
  return !isLiveAnnualPlan(plan) && plan?.status !== "pending";
}

/**
 * The annual plan that stands in the way of buying another one, or null.
 *
 * Not scoped to a size, unlike the subscription's. An annual plan is a
 * twelve-month obligation paid in one amount; two of them running at
 * once is not a size choice, it is a duplicate purchase, and the
 * customer is told so rather than charged twice.
 *
 * `exceptAttemptId` is this checkout's own payment attempt. The plan it
 * already created is never allowed to block the retry that owns it.
 */
export function findBlockingAnnualPlan(
  plans: AnnualPlanEligibilityRow[] | null | undefined,
  exceptAttemptId?: string | null
): AnnualPlanEligibilityRow | null {
  for (const plan of Array.isArray(plans) ? plans : []) {
    if (!plan || typeof plan !== "object") continue;
    if (typeof plan.id !== "string" || plan.id === "") continue;
    if (exceptAttemptId && plan.paymentAttemptId === exceptAttemptId) continue;
    if (isLiveAnnualPlan(plan)) return plan;
  }
  return null;
}

/** May the customer buy an annual plan right now? */
export function mayStartAnnualPlan(
  plans: AnnualPlanEligibilityRow[] | null | undefined,
  exceptAttemptId?: string | null
): boolean {
  return findBlockingAnnualPlan(plans, exceptAttemptId) === null;
}

/* ══════════════════════════════════════════════════════════════
   WHAT THE CUSTOMER IS TOLD
   ══════════════════════════════════════════════════════════════ */

/**
 * The two refusals, as sentences a customer may read.
 *
 * They state the CURRENT contract and the way out of it, because a
 * refusal that only says "no" is one the customer cannot act on. Neither
 * names a row, an id, a status word or an amount: the account page
 * already shows all of that, under the customer's own session.
 */
export const SUBSCRIPTION_ALREADY_RUNNING =
  "Dieses Abo läuft bereits. Du kannst es in deinem Konto ansehen oder kündigen.";

/**
 * THE REFUSAL WHEN ONE ANNUAL CHECKOUT IS STILL PAYABLE (migration 068).
 *
 * Not "you already have a plan" - they do not, yet - but "you already
 * have a checkout open". The customer has a Stripe Checkout Session
 * live right now for an annual plan, and the honest answer names both
 * ways out: finish that one, or wait for it to lapse. It lapses on its
 * own within half an hour, because the claim behind this sentence
 * expires at exactly the moment the session it guards stops being
 * payable.
 *
 * ONE SENTENCE FOR BOTH PATHS. An ordinary purchase and an upgrade are
 * the same thing to a customer holding one open checkout, and saying
 * which kind the OTHER tab was would leak a detail this refusal has no
 * reason to carry. It names no date, no plan and no amount.
 */
export const ANNUAL_CHECKOUT_ALREADY_PENDING =
  "Du hast bereits einen offenen Jahresplan-Checkout. "
  + "Schließe den bestehenden Checkout ab oder versuche es später erneut.";

export const ANNUAL_PLAN_ALREADY_RUNNING =
  "Du hast bereits einen laufenden Jahresplan. Einen neuen kannst du starten, sobald er beendet ist.";
