import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ANNUAL_PLAN_ALREADY_RUNNING,
  SUBSCRIPTION_ALREADY_RUNNING,
  annualPlanHasEndedForGood,
  findBlockingAnnualPlan,
  findBlockingSubscription,
  isLiveAnnualPlan,
  isLiveSubscription,
  mayStartAnnualPlan,
  mayStartSubscription,
  subscriptionHasEndedForGood,
  toAnnualEligibilityRow,
} from "../lib/purchaseEligibility.ts";
import { getSubscriptionStatusLabel, hasEnded } from "../lib/subscriptionCancellationRules.ts";
import {
  ANNUAL_ACCOUNT_PAYMENT_STATUSES,
  ANNUAL_ACCOUNT_STATUSES,
} from "../lib/annualPlanAccount.ts";

/* ══════════════════════════════════════════════════════════════
   MAY THE CUSTOMER BUY IT AGAIN?

   SAFE DEFAULT SUITE: pure predicates driven with row literals, plus
   source-level contract checks on the two checkout handlers, their
   wiring and the account portal. No Supabase client is constructed, no
   SQL runs, no Stripe object exists and nothing is written anywhere.

   ── THE PRODUCTION HISTORY THIS EXISTS FOR ────────────────────

   Two contracts were driven to their end during production testing:

     * a 30 g monthly subscription, started 27.09.2026 and terminated,
       now reading "Beendet", ended 28.09.2026
     * an annual plan, 252,07 EUR paid once, later fully refunded, now
       reading "Erstattet"

   Both must stay in the account as history, and NEITHER may stop the
   customer buying the same product again. A gate that asks "is there a
   row for this customer" answers yes forever - nothing in this system
   deletes or expires a subscription, an annual plan or a checkout
   attempt - so eligibility is asked of CURRENT CONTRACT STATE and of
   nothing else.

   ── AND THE DUPLICATE GUARD THAT CAME WITH IT ─────────────────

   Before this package there was NO customer-level gate at all: the two
   checkout routes validated identity, product, address, price and
   idempotency, and would happily have created a second live contract on
   top of a running one. The same predicates that let a finished contract
   go are what now refuse a running one.
   ══════════════════════════════════════════════════════════════ */

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const NEWLINE = String.fromCharCode(10);
const read = rel => readFileSync(path.join(ROOT, rel), "utf-8");

const withoutComments = source => source
  .split(NEWLINE)
  .filter(line => {
    const t = line.trim();
    return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
  })
  .join(NEWLINE);

const subFlow = read("lib/subscriptionCheckout.ts");
const subFlowCode = withoutComments(subFlow);
const subDeps = read("lib/subscriptionCheckoutDeps.ts");
const subReader = read("lib/subscriptions.ts");
const annualFlow = read("lib/annualPlanCheckout.ts");
const annualFlowCode = withoutComments(annualFlow);
const annualDeps = read("lib/annualPlanCheckoutDeps.ts");
const eligibility = read("lib/purchaseEligibility.ts");
const eligibilityCode = withoutComments(eligibility);
const portal = read("app/AccountPortal.tsx");
const portalCode = withoutComments(portal);

function between(source, startMarker, endMarker) {
  const at = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, at + startMarker.length);
  assert.ok(at > -1 && end > at, `could not locate ${startMarker} … ${endMarker}`);
  return source.slice(at, end);
}

/* ── The two production contracts, as rows ──────────────────── */

const PLAN_30G = "11111111-1111-4111-8111-111111111111";
const PLAN_100G = "22222222-2222-4222-8222-222222222222";
const SUB_ID = "33333333-3333-4333-8333-333333333333";
const ANNUAL_ID = "44444444-4444-4444-8444-444444444444";
const ATTEMPT_ID = "55555555-5555-4555-8555-555555555555";

const STARTED_AT = "2026-09-27T10:00:00+00:00";
const PERIOD_END = "2026-10-25T10:00:00+00:00";
const ENDED_AT = "2026-09-28T09:00:00+00:00";

/** A live 30 g abo, exactly as migration 034's columns describe one. */
const subRow = (over = {}) => ({
  id: SUB_ID,
  plan_id: PLAN_30G,
  status: "active",
  current_period_end: PERIOD_END,
  next_delivery_at: PERIOD_END,
  cancellation_requested_at: null,
  cancellation_effective_at: null,
  cancelled_at: null,
  ...over,
});

/** The production subscription as it stands today: terminated. */
const endedSubRow = () => subRow({
  status: "cancelled",
  cancelled_at: ENDED_AT,
  cancellation_requested_at: STARTED_AT,
  cancellation_effective_at: ENDED_AT,
});

const annualRow = (over = {}) => ({
  id: ANNUAL_ID,
  status: "active",
  paymentStatus: "paid",
  paymentAttemptId: ATTEMPT_ID,
  ...over,
});

/** The production plan as it stands today: paid once, fully refunded. */
const refundedAnnualRow = () => annualRow({ paymentStatus: "refunded" });

/* ══════════════════════════════════════════════════════════════
   1. THE MONTHLY SUBSCRIPTION
   ══════════════════════════════════════════════════════════════ */

test("1a: a running abo blocks a second identical one", () => {
  assert.equal(isLiveSubscription(subRow()), true);
  assert.equal(mayStartSubscription([subRow()], PLAN_30G), false);
  const blocking = findBlockingSubscription([subRow()], PLAN_30G);
  assert.equal(blocking?.id, SUB_ID);
});

test("1b: a cancellation that has NOT taken effect still blocks", () => {
  /*
    "Kündigung vorgemerkt" is a promise, not an ending. The subscription
    still bills in the late case and still ships until its effective
    date, so a second identical one would be two boxes and two charges.
  */
  const scheduled = subRow({
    cancellation_requested_at: STARTED_AT,
    cancellation_effective_at: PERIOD_END,
  });
  assert.equal(getSubscriptionStatusLabel(scheduled), "Kündigung vorgemerkt");
  assert.equal(hasEnded(scheduled), false);
  assert.equal(isLiveSubscription(scheduled), true);
  assert.equal(mayStartSubscription([scheduled], PLAN_30G), false);
});

test("1c: an ENDED abo blocks nothing, however it ended", () => {
  // The production case: manually terminated, status cancelled.
  assert.equal(getSubscriptionStatusLabel(endedSubRow()), "Beendet");
  assert.equal(subscriptionHasEndedForGood(endedSubRow()), true);
  assert.equal(isLiveSubscription(endedSubRow()), false);
  assert.equal(mayStartSubscription([endedSubRow()], PLAN_30G), true);

  // And the other spelling of ended: Stripe deleted it while the local
  // status had not caught up. cancelled_at alone is enough, exactly as
  // hasEnded has always read it.
  const deletedAtStripe = subRow({ cancelled_at: ENDED_AT });
  assert.equal(isLiveSubscription(deletedAtStripe), false);
  assert.equal(mayStartSubscription([deletedAtStripe], PLAN_30G), true);
});

test("1d: every state that is not ended keeps blocking", () => {
  // A standing contract whose payment is being retried is still a
  // contract. None of these is "definitively inactive", so none of them
  // may hand out a duplicate.
  for (const status of ["active", "past_due", "unpaid", "paused"]) {
    assert.equal(isLiveSubscription(subRow({ status })), true, status);
    assert.equal(mayStartSubscription([subRow({ status })], PLAN_30G), false, status);
  }
});

test("1e: a 'pending' row does NOT block, and that is deliberate", () => {
  /*
    A pending subscription is written BEFORE Stripe is contacted and
    nothing in this system expires it, so an abandoned Checkout tab would
    otherwise veto that size for good - the exact class of permanent
    existence gate this module was written to remove. It cannot be told
    apart from a genuine one either: stripe_subscription_id is bound only
    at activation.
  */
  assert.equal(isLiveSubscription(subRow({ status: "pending" })), false);
  assert.equal(mayStartSubscription([subRow({ status: "pending" })], PLAN_30G), true);
  // It is not history either - it never became a contract.
  assert.equal(subscriptionHasEndedForGood(subRow({ status: "pending" })), false);
});

test("1f: a different size is a different contract", () => {
  assert.equal(mayStartSubscription([subRow()], PLAN_100G), true,
    "a running 30 g abo blocked the 100 g one");
  // Which is what migration 024 has always said: its unique index is on
  // the PLAN table, per (variant, cadence), never per customer.
  assert.match(read("supabase/migrations/024_seed_b2c_subscription_plans.sql"),
    /create unique index b2c_plans_active_variant_cadence_key/);
});

test("1g: a checkout is never blocked by the subscription it created", () => {
  // The retry case. Without the exception the customer could not reach
  // the Stripe session for their own first click.
  assert.equal(mayStartSubscription([subRow()], PLAN_30G, SUB_ID), true);
  // And only that one row is excused.
  const other = subRow({ id: "66666666-6666-4666-8666-666666666666" });
  assert.equal(mayStartSubscription([subRow(), other], PLAN_30G, SUB_ID), false);
});

test("1h: a row with no plan cannot be shown equivalent to anything", () => {
  assert.equal(mayStartSubscription([subRow({ plan_id: null })], PLAN_30G), true);
  assert.equal(mayStartSubscription([], PLAN_30G), true);
  assert.equal(mayStartSubscription(null, PLAN_30G), true);
  // A missing plan id on the REQUEST side blocks nothing either; the
  // route refuses that request long before it gets here.
  assert.equal(mayStartSubscription([subRow()], ""), true);
});

/* ══════════════════════════════════════════════════════════════
   2. THE PREPAID ANNUAL PLAN
   ══════════════════════════════════════════════════════════════ */

test("2a: a running plan blocks a second one", () => {
  assert.equal(isLiveAnnualPlan(annualRow()), true);
  assert.equal(mayStartAnnualPlan([annualRow()]), false);
  assert.equal(findBlockingAnnualPlan([annualRow()])?.id, ANNUAL_ID);
});

test("2b: a FULLY REFUNDED plan does not consume the right to buy another", () => {
  /*
    THE PRODUCTION CASE. 252,07 EUR were taken and given back. The plan
    stays in the account reading "Erstattet", its thirteen delivery rows
    survive as the record of what had been scheduled, and none of that is
    an entitlement the customer has spent.
  */
  assert.equal(isLiveAnnualPlan(refundedAnnualRow()), false);
  assert.equal(annualPlanHasEndedForGood(refundedAnnualRow()), true);
  assert.equal(mayStartAnnualPlan([refundedAnnualRow()]), true);
});

test("2c: a PARTIAL refund still blocks - twelve boxes are still owed", () => {
  const partial = annualRow({ paymentStatus: "partially_refunded" });
  assert.equal(isLiveAnnualPlan(partial), true);
  assert.equal(mayStartAnnualPlan([partial]), false);
});

test("2d: completed and cancelled plans block nothing", () => {
  for (const status of ["completed", "cancelled"]) {
    assert.equal(isLiveAnnualPlan(annualRow({ status })), false, status);
    assert.equal(annualPlanHasEndedForGood(annualRow({ status })), true, status);
    assert.equal(mayStartAnnualPlan([annualRow({ status })]), true, status);
  }
});

test("2e: a 'pending' plan does not block, and is not history either", () => {
  // Same reasoning as the subscription's: written before Stripe, never
  // expired, so an abandoned checkout must not veto the next purchase.
  const pending = annualRow({ status: "pending", paymentStatus: "pending" });
  assert.equal(isLiveAnnualPlan(pending), false);
  assert.equal(annualPlanHasEndedForGood(pending), false);
  assert.equal(mayStartAnnualPlan([pending]), true);
});

test("2f: a word migration 039 does not CHECK fails CLOSED", () => {
  // A state this build cannot read is not a state it may declare
  // finished, so it blocks rather than handing out a second contract.
  assert.equal(isLiveAnnualPlan(annualRow({ status: "zombie" })), true);
  assert.equal(isLiveAnnualPlan(annualRow({ paymentStatus: "vanished" })), true);
  // And the vocabularies are migration 039's, not this module's.
  assert.deepEqual([...ANNUAL_ACCOUNT_STATUSES].sort(),
    ["active", "cancelled", "completed", "pending"]);
  assert.deepEqual([...ANNUAL_ACCOUNT_PAYMENT_STATUSES].sort(),
    ["paid", "partially_refunded", "pending", "refunded"]);
});

test("2g: a checkout is never blocked by the plan it created", () => {
  assert.equal(mayStartAnnualPlan([annualRow()], ATTEMPT_ID), true);
  const other = annualRow({ id: "77777777-7777-4777-8777-777777777777", paymentAttemptId: "other" });
  assert.equal(mayStartAnnualPlan([annualRow(), other], ATTEMPT_ID), false);
});

test("2h: the server's row reaches the predicate in the account's shape", () => {
  const mapped = toAnnualEligibilityRow({
    id: ANNUAL_ID,
    status: "active",
    payment_status: "refunded",
    payment_checkout_attempt_id: ATTEMPT_ID,
  });
  assert.deepEqual(mapped, {
    id: ANNUAL_ID, status: "active", paymentStatus: "refunded", paymentAttemptId: ATTEMPT_ID,
  });
  // The mapped row and the account's own view answer identically.
  assert.equal(isLiveAnnualPlan(mapped), false);
  assert.equal(isLiveAnnualPlan(refundedAnnualRow()), false);
  // A NULL attempt id never accidentally matches an absent exception.
  assert.equal(toAnnualEligibilityRow({ id: "x", status: "active", payment_status: "paid" }).paymentAttemptId, null);
});

/* ══════════════════════════════════════════════════════════════
   3. THE EXACT PRODUCTION HISTORY
   ══════════════════════════════════════════════════════════════ */

test("3: one ended abo and one refunded plan - BOTH products buyable again", () => {
  const history = [endedSubRow()];
  const plans = [refundedAnnualRow()];

  assert.equal(mayStartSubscription(history, PLAN_30G), true,
    "an ended subscription still blocked the same size");
  assert.equal(mayStartAnnualPlan(plans), true,
    "a refunded annual plan still blocked a new one");

  // The history itself is untouched and still reads the way the customer
  // sees it. Nothing here rewrites a terminal row into a live one.
  assert.equal(getSubscriptionStatusLabel(history[0]), "Beendet");
  assert.equal(history[0].cancelled_at, ENDED_AT);
  assert.equal(plans[0].status, "active");
  assert.equal(plans[0].paymentStatus, "refunded");

  // And a NEW contract is a new row: nothing in this module returns,
  // reuses or revives an id.
  for (const banned of ["update", "insert", "delete", "upsert", "rpc"]) {
    assert.ok(!eligibilityCode.includes(banned), `the eligibility leaf ${banned}s`);
  }
});

/* ══════════════════════════════════════════════════════════════
   4. THE SERVER REFUSES, AND ONLY FOR A LIVE CONTRACT
   ══════════════════════════════════════════════════════════════ */

test("4a: the subscription route asks the shared predicate, before the claim", () => {
  assert.match(subFlowCode, /import \{[\s\S]*?findBlockingSubscription,[\s\S]*?\} from "\.\/purchaseEligibility";/);
  assert.match(subFlowCode, /const ownSubscriptions = await deps\.listSubscriptions\(caller\.userId\);/);
  assert.match(subFlowCode,
    /if \(findBlockingSubscription\(ownSubscriptions\.rows, plan\.id, attempt\.subscription_id\)\) \{\s*return fail\(409, SUBSCRIPTION_ALREADY_RUNNING\);/);
  // ORDER IS THE PROPERTY. The refusal has to happen before anything is
  // claimed, or a duplicate exists by the time it is refused.
  const gateAt = subFlowCode.indexOf("deps.listSubscriptions(");
  const claimAt = subFlowCode.indexOf("await deps.claimSubscription(");
  const stripeAt = subFlowCode.indexOf("deps.getStripe()");
  assert.ok(gateAt > -1 && claimAt > gateAt, "the duplicate gate runs after the subscription is claimed");
  assert.ok(stripeAt > claimAt, "Stripe is contacted before the local subscription exists");
});

test("4b: the annual route asks the shared predicate, before the claim", () => {
  assert.match(annualFlowCode, /import \{[\s\S]*?findBlockingAnnualPlan,[\s\S]*?\} from "\.\/purchaseEligibility";/);
  assert.match(annualFlowCode, /const ownPlans = await deps\.listAnnualPlans\(caller\.userId\);/);
  assert.match(annualFlowCode,
    /if \(findBlockingAnnualPlan\(ownPlans\.rows, attempt\.id\)\) \{\s*return fail\(409, ANNUAL_PLAN_ALREADY_RUNNING\);/);
  const gateAt = annualFlowCode.indexOf("deps.listAnnualPlans(");
  const claimAt = annualFlowCode.indexOf("await deps.createPendingPlan(");
  const stripeAt = annualFlowCode.indexOf("deps.getStripe()");
  assert.ok(gateAt > -1 && claimAt > gateAt, "the duplicate gate runs after the plan is claimed");
  assert.ok(stripeAt > claimAt, "Stripe is contacted before the local plan exists");
});

test("4c: a failed read refuses the checkout - it never means 'no contracts'", () => {
  for (const [name, flow] of Object.entries({ subFlowCode, annualFlowCode })) {
    assert.match(flow, /if \(!own(Subscriptions|Plans)\.ok\) \{[\s\S]{0,200}?return fail\(503,/,
      `${name} treats an unreadable contract list as an empty one`);
  }
  // The readers say the same thing on their own side.
  assert.match(subReader, /console\.error\("subscription eligibility read failed:", error\.message\);\s*return \{ ok: false \};/);
  assert.match(annualDeps, /console\.error\("annual eligibility read failed:", error\.message\);\s*return \{ ok: false \};/);
});

test("4d: the reads are unfiltered, scoped to one user, and name their columns", () => {
  // UNFILTERED on purpose: half a rule in SQL is a rule no test reaches,
  // and `.eq("status","active")` would miss past_due and unpaid.
  const subFn = between(subReader, "export async function listOwnSubscriptionsForEligibility", "\n}");
  assert.match(subFn, /\.select\(SUBSCRIPTION_ELIGIBILITY_SELECT\)/);
  assert.match(subFn, /\.eq\("user_id", userId\)/);
  assert.ok(!subFn.includes('.eq("status"'), "the subscription read filters status in SQL");
  assert.ok(!subFn.includes('select("*")'), "the subscription read stars");

  const annualFn = between(annualDeps, "async function listOwnAnnualPlansForEligibility", "\n}");
  assert.match(annualFn, /\.select\(ANNUAL_ELIGIBILITY_SELECT\)/);
  assert.match(annualFn, /\.eq\("user_id", userId\)/);
  assert.ok(!annualFn.includes('.eq("status"'), "the annual read filters status in SQL");
  assert.ok(!annualFn.includes('select("*")'), "the annual read stars");

  // And neither asks for a Stripe identity it has no use for.
  const selects = subReader + annualDeps;
  for (const secret of ["stripe_payment_intent_id", "stripe_subscription_id", "customer_snapshot"]) {
    assert.ok(!between(selects, "SUBSCRIPTION_ELIGIBILITY_SELECT", ";").includes(secret), secret);
  }
  assert.match(annualDeps, /const ANNUAL_ELIGIBILITY_SELECT = "id, status, payment_status, payment_checkout_attempt_id";/);
});

test("4e: both routes are wired to the real readers", () => {
  assert.match(subDeps, /listSubscriptions: listOwnSubscriptionsForEligibility,/);
  assert.match(annualDeps, /listAnnualPlans: listOwnAnnualPlansForEligibility,/);
});

/* ══════════════════════════════════════════════════════════════
   5. IDEMPOTENCY AND THE RACE GUARD ARE UNTOUCHED
   ══════════════════════════════════════════════════════════════ */

test("5a: the atomic claim is still the only thing that decides how many exist", () => {
  // Two simultaneous clicks carry ONE request id and meet a row lock.
  // Nothing in this package replaced that, weakened it, or moved the
  // decision out of the database.
  assert.match(subFlowCode, /const claimed = await deps\.claimSubscription\(\{/);
  assert.match(read("lib/subscriptions.ts"), /admin\.rpc\("claim_pending_subscription_for_attempt"/);
  assert.match(annualDeps, /admin\.rpc\("create_pending_annual_plan_for_attempt"/);

  // Every fingerprint gate the two flows had is still there, unchanged.
  for (const kept of [
    "attemptMatchesFingerprint(attempt.subscription_intent_fingerprint, intentFingerprint)",
    "attemptMatchesFingerprint(attempt.subscription_request_fingerprint, fingerprint)",
    'if (attempt.status === "paid")',
  ]) {
    assert.ok(subFlowCode.includes(kept), `the subscription checkout lost: ${kept}`);
  }
  for (const kept of [
    "verifyFrozenAnnualAttempt({",
    "expectedIntentFingerprint: intentFingerprint,",
    "expectedRequestFingerprint: requestFingerprint,",
    'if (attempt.status === "paid")',
  ]) {
    assert.ok(annualFlowCode.includes(kept), `the annual checkout lost: ${kept}`);
  }
});

test("5b: a retry of a checkout that already owns a contract is not refused", () => {
  // The exception is read from the DATABASE's own column, never from the
  // request: the subscription id the attempt carries, and the payment
  // attempt id the plan carries.
  assert.match(subFlowCode, /attempt\.subscription_id\)\)/);
  assert.match(annualFlowCode, /findBlockingAnnualPlan\(ownPlans\.rows, attempt\.id\)/);
  assert.ok(!subFlowCode.includes("body.subscriptionId"), "the exception comes from the request");
  assert.ok(!annualFlowCode.includes("body.annualPlanId"), "the exception comes from the request");

  // Executed, both products.
  assert.equal(mayStartSubscription([subRow()], PLAN_30G, SUB_ID), true);
  assert.equal(mayStartAnnualPlan([annualRow()], ATTEMPT_ID), true);
});

test("5c: no migration, no new endpoint, no deleted history", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.ok(pkg.scripts.test.includes("tests/repurchase-eligibility.test.mjs"),
    "this suite is not in the test script");
  // The eligibility decision needed no schema change: it reads columns
  // migrations 005/022/034 and 039 already wrote, through grants
  // migrations 022 and 039 already made.
  assert.match(read("supabase/migrations/022_recurring_subscription_foundation.sql"),
    /grant select on public\.subscriptions to service_role;/);
  assert.match(read("supabase/migrations/039_b2c_annual_plan_foundation.sql"),
    /grant select on table public\.annual_plans\s+to service_role;/);
  // And nothing anywhere removes a terminal contract to make room.
  for (const src of [eligibilityCode, subFlowCode, annualFlowCode, withoutComments(subReader)]) {
    for (const banned of ['.delete(', '.update(', 'DROP ', 'truncate']) {
      assert.ok(!src.includes(banned), `a repurchase path writes: ${banned}`);
    }
  }
});

/* ══════════════════════════════════════════════════════════════
   6. THE ACCOUNT OFFERS EXACTLY WHAT THE SERVER ACCEPTS
   ══════════════════════════════════════════════════════════════ */

const dashboard = between(portalCode, "function PrivateDashboard()", "function BusinessDashboard()");
const startForm = between(portalCode, "function SubscriptionStartForm(", "function AnnualPlanStartForm()");
const annualForm = between(portalCode, "function AnnualPlanStartForm()", "function PortalAnnualPlans(");
const subDetail = between(portalCode, "function SubscriptionDetail(", "function PortalAddresses()");
const annualDetail = between(portalCode, "function AnnualPlanDetail(", "function CheckoutReturnBanner()");

test("6a: the portal decides with the SAME functions the routes refuse with", () => {
  assert.match(portal, /from "\.\.\/lib\/purchaseEligibility"/);
  for (const shared of ["isLiveSubscription", "isLiveAnnualPlan", "mayStartSubscription", "subscriptionHasEndedForGood"]) {
    assert.ok(portalCode.includes(shared), `the portal stopped using ${shared}`);
  }
  // No second opinion: the portal never writes a status list of its own
  // to decide what is still running.
  for (const homegrown of ['status === "cancelled"', 'status !== "cancelled"', 'eq("status", "active")']) {
    assert.ok(!dashboard.includes(homegrown), `the dashboard decides eligibility itself: ${homegrown}`);
  }
});

test("6b: active and historical contracts are not shown as equally current", () => {
  assert.match(dashboard, /label="AKTIV"/);
  assert.match(dashboard, /label="VERGANGEN"/);
  assert.ok(dashboard.indexOf('label="AKTIV"') < dashboard.indexOf('label="VERGANGEN"'),
    "history is listed above what is running");
  // History is kept and reachable, never hidden.
  assert.match(dashboard, /href=\{`\/account\/subscriptions\/\$\{sub\.id\}`\}/);
  assert.match(dashboard, /href=\{annualPlanDetailHref\(v\.id\)\}/);
  assert.match(dashboard, /getSubscriptionStatusLabel\(sub\)/);
  assert.match(dashboard, /annualStatusLabel\(v\)/);
});

test("6c: the repurchase CTAs appear exactly when the server would accept", () => {
  // Ended monthly -> the offer comes back. Live monthly -> it does not.
  assert.match(dashboard, /\{liveSubs\.length === 0 && \(/);
  assert.match(dashboard, /MONATSABO STARTEN/);
  assert.match(dashboard, /\{liveAnnualPlans\.length === 0 && \(/);
  assert.match(dashboard, /JAHRESPLAN WÄHLEN/);
  // A LIVE contract gets the view action instead, never a buy action.
  const liveSubCard = between(dashboard, "liveSubs.map(sub =>", "liveAnnualPlans.map(v =>");
  assert.match(liveSubCard, /ABO ANSEHEN/);
  assert.ok(!liveSubCard.includes("STARTEN"), "a running abo is offered again");
  const liveAnnualCard = between(dashboard, "liveAnnualPlans.map(v =>", "liveSubs.length === 0");
  assert.match(liveAnnualCard, /JAHRESPLAN ANSEHEN/);
  assert.ok(!liveAnnualCard.includes("WÄHLEN"), "a running plan is offered again");
});

test("6d: the booking form never offers a size that is already running", () => {
  assert.match(startForm, /const planIsAvailable = \(candidatePlanId: string\) => mayStartSubscription\(ownSubs, candidatePlanId\);/);
  assert.match(startForm, /disabled=\{!available\}/);
  assert.match(startForm, /\{!available && <span className="sub-start-option-meta">Läuft bereits<\/span>\}/);
  // And the submit is refused with the server's own sentence.
  assert.match(startForm, /if \(!planIsAvailable\(planId\)\) \{ setError\(SUBSCRIPTION_ALREADY_RUNNING\); return; \}/);
});

test("6e: the annual form steps aside for a running plan and returns after it", () => {
  assert.match(annualForm, /const runningPlan = ownAnnualPlans\.find\(isLiveAnnualPlan\) \?\? null;/);
  assert.match(annualForm, /\) : runningPlan \? \(/);
  assert.match(annualForm, /\{ANNUAL_PLAN_ALREADY_RUNNING\}/);
  // The way out is the plan itself, not a dead end.
  assert.match(annualForm, /annualPlanDetailHref\(runningPlan\.id\)/);
});

test("6f: a terminal contract says so first, and says it in the agreed words", () => {
  // Monthly.
  assert.match(subDetail, /\{ended && \(/);
  assert.match(subDetail, /className="portal-terminal-state">\{statusLabel\}/);
  assert.match(subDetail, /Beendet am \{fmtDate\(endsAt\)\}/);
  assert.match(subDetail, /NEUES ABO STARTEN/);
  // Annual.
  assert.match(annualDetail, /const planIsLive = isLiveAnnualPlan\(plan\);/);
  assert.match(annualDetail, /\{!planIsLive && \(/);
  assert.match(annualDetail, /Erstattet: \{fmtCents\(/);
  assert.match(annualDetail, /Plan beendet\./);
  assert.match(annualDetail, /NEUEN JAHRESPLAN WÄHLEN/);
  // A finished plan's schedule is history, not a promise.
  assert.match(annualDetail, /label=\{planIsLive \? "LIEFERUNGEN" : "PLANVERLAUF"\}/);
});

test("6g: the labels are the agreed ones, and never a raw database word", () => {
  // Monthly, from the existing rules leaf.
  assert.equal(getSubscriptionStatusLabel(subRow()), "Aktiv");
  assert.equal(getSubscriptionStatusLabel(subRow({
    cancellation_requested_at: STARTED_AT, cancellation_effective_at: PERIOD_END,
  })), "Kündigung vorgemerkt");
  assert.equal(getSubscriptionStatusLabel(endedSubRow()), "Beendet");
  assert.equal(getSubscriptionStatusLabel(subRow({ status: "was-soll-das" })), "Unbekannt");

  // Annual, from the portal's own label function.
  const annualLabel = between(portalCode, "function annualStatusLabel(", "\n}");
  for (const word of ['"Beendet"', '"Erstattet"', '"Abgeschlossen"', '"Aktiv"']) {
    assert.ok(annualLabel.includes(word), `the annual label lost ${word}`);
  }
  // Refunded and cancelled are decided BEFORE active, so a refunded plan
  // can never report itself as running.
  assert.ok(annualLabel.indexOf('v.paymentStatus === "refunded"') < annualLabel.indexOf('v.status === "active"'));
});

test("6h: no monthly-to-annual upgrade was invented", () => {
  // The two products stay separate: buying one neither cancels nor
  // migrates the other, and nothing crosses between the flows.
  for (const [name, flow] of Object.entries({ subFlowCode, annualFlowCode })) {
    for (const banned of ["upgrade", "migrate", "cancelExisting", "supersede", "replaceSubscription"]) {
      assert.ok(!flow.includes(banned), `${name} invents an upgrade: ${banned}`);
    }
  }
  assert.ok(!subFlowCode.includes("annual_plans"), "the subscription checkout reads annual rows");
  assert.ok(!annualFlowCode.includes('from("subscriptions")'), "the annual checkout reads subscription rows");
  // And the two refusals are the only thing either says about the other.
  assert.equal(typeof SUBSCRIPTION_ALREADY_RUNNING, "string");
  assert.equal(typeof ANNUAL_PLAN_ALREADY_RUNNING, "string");
  assert.ok(!SUBSCRIPTION_ALREADY_RUNNING.includes("Jahresplan"));
  assert.ok(!ANNUAL_PLAN_ALREADY_RUNNING.includes("Abo"));
});

test("6i: the monthly cancellation rules were not touched", () => {
  // This package must not have changed how an abo ends. The rules leaf
  // is asserted by its own contract rather than by a diff, so it holds
  // after the commit too.
  const rules = read("lib/subscriptionCancellationRules.ts");
  assert.match(rules, /export const CANCELLATION_CUTOFF_DAYS = 14;/);
  assert.match(rules, /export const CADENCE_DAYS = 28;/);
  assert.match(rules, /export const CANCELLABLE_STATUSES = \["active", "past_due", "unpaid"\] as const;/);
  assert.match(rules, /export function hasEnded\(sub: SubscriptionAccountFields\): boolean \{\s*return sub\.status === "cancelled" \|\| !!sub\.cancelled_at;\s*\}/);
  // It gained nothing: the eligibility rule lives in its own module and
  // only READS this one.
  assert.ok(!rules.includes("purchaseEligibility"), "the cancellation leaf now knows about purchasing");
  assert.match(eligibility, /from "\.\/subscriptionCancellationRules\.ts"/);
  // And the portal still cancels through the same endpoint.
  assert.match(subDetail, /await fetch\("\/api\/subscriptions\/cancel"/);
});
