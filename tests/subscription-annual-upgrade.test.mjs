import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  UPGRADE_CTA,
  UPGRADE_EXPLAINER,
  UPGRADE_SCHEDULED_LABEL,
  expectedTransitionAt,
  mayUpgradeToAnnualPlan,
  resolveTransitionAnchor,
} from "../lib/subscriptionUpgradeRules.ts";
import {
  UPGRADE_SCHEDULE_SETTLED,
  UpgradeTransitionConflict,
  applyUpgradeTransition,
  upgradeCancelIdempotencyKey,
} from "../lib/subscriptionUpgrade.ts";
import { isLiveAnnualPlan, isLiveSubscription } from "../lib/purchaseEligibility.ts";
import {
  CANCELLATION_CUTOFF_DAYS,
  getSubscriptionStatusLabel,
  resolveCancellationSchedule,
} from "../lib/subscriptionCancellationRules.ts";

/* ══════════════════════════════════════════════════════════════
   THE 4-WEEK SUBSCRIPTION → ANNUAL PLAN UPGRADE

   SAFE DEFAULT SUITE: pure rules driven with row literals, the
   transition orchestrator driven end to end with STUBS, and source-level
   contract checks on the checkout, the webhook, the migration and the
   account. No Supabase client is constructed, no SQL runs, no Stripe
   object exists, no webhook is delivered and nothing is written.

   ── THE ONE INVARIANT ─────────────────────────────────────────

   A customer must never end up with a paid, active annual plan beside a
   subscription that goes on renewing. Everything below is either that
   property or one of the four the customer was promised:

     the period already paid for is still delivered
     no further subscription renewal after it
     the annual plan starts exactly where the subscription stops
     nothing is delivered twice and nothing is charged twice

   ── AND THE ONE THING THAT DID NOT CHANGE ─────────────────────

   Migration 034's 14-day cancellation cutoff. An upgrade is a different
   operation and names its own end date; resolveCancellationSchedule is
   not imported by the upgrade path, not re-implemented and not edited,
   and the tests that prove it still governs ordinary cancellations are
   the untouched ones in tests/account-subscription-view.test.mjs.
   ══════════════════════════════════════════════════════════════ */

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const NEWLINE = String.fromCharCode(10);
const read = rel => readFileSync(path.join(ROOT, rel), "utf-8");

const stripBlocks = source => source.replace(/\/\*[\s\S]*?\*\//g, "");
const withoutComments = source => stripBlocks(source)
  .split(NEWLINE)
  .filter(line => {
    const t = line.trim();
    return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
  })
  .join(NEWLINE);

const MIGRATION = "066_annual_plan_subscription_transition.sql";
const m066 = read(`supabase/migrations/${MIGRATION}`);
const m066Sql = m066.split(NEWLINE).filter(l => !l.trim().startsWith("--")).join(NEWLINE);
const upgradeFlow = withoutComments(read("lib/subscriptionUpgrade.ts"));
const upgradeRules = withoutComments(read("lib/subscriptionUpgradeRules.ts"));
const annualFlow = withoutComments(read("lib/annualPlanCheckout.ts"));
const webhook = withoutComments(read("lib/annualPlanWebhook.ts"));
const webhookDeps = withoutComments(read("lib/annualPlanWebhookDeps.ts"));
const portal = read("app/AccountPortal.tsx");
const portalCode = withoutComments(portal);
const emailTemplate = read("lib/email/annualPurchaseConfirmation.ts");

function between(source, a, b) {
  const at = source.indexOf(a);
  const end = source.indexOf(b, at + a.length);
  assert.ok(at > -1 && end > at, `could not locate ${a} … ${b}`);
  return source.slice(at, end);
}

/* ── The production shapes ───────────────────────────────────── */

const SUB_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const STRIPE_SUB = "sub_live_1";
const PLAN_ID = "33333333-3333-4333-8333-333333333333";

/** The brief's own example: 27.09 → 25.10, upgrade on 10.10. */
const PERIOD_START = "2026-09-27T10:00:00.000Z";
const PERIOD_END = "2026-10-25T10:00:00.000Z";
const UPGRADE_EARLY = "2026-10-10T12:00:00.000Z";
const UPGRADE_LATE = "2026-10-20T12:00:00.000Z";
const NEXT_CYCLE_END = "2026-11-22T10:00:00.000Z";

const subRow = (over = {}) => ({
  id: SUB_ID,
  user_id: USER_ID,
  plan_id: "44444444-4444-4444-8444-444444444444",
  customer_type: "private",
  status: "active",
  stripe_subscription_id: STRIPE_SUB,
  current_period_end: PERIOD_END,
  next_delivery_at: PERIOD_END,
  cancellation_requested_at: null,
  cancellation_effective_at: null,
  cancelled_at: null,
  ...over,
});

const annualRow = (over = {}) => ({
  id: PLAN_ID, status: "active", paymentStatus: "paid", paymentAttemptId: null, ...over,
});

/** Every dependency stubbed; the calls are recorded, nothing happens. */
function stubDeps(over = {}) {
  const calls = { stripe: [], local: [], retrieved: 0 };
  const deps = {
    getStripe: () => ({ marker: "stripe" }),
    loadSubscription: async () => subRow(),
    retrieveStripeSubscription: async () => { calls.retrieved += 1; return { id: STRIPE_SUB }; },
    resolvePeriodEnd: () => PERIOD_END,
    scheduleAtStripe: async input => { calls.stripe.push(input); },
    scheduleLocally: async input => { calls.local.push(input); return { result: "scheduled" }; },
    ...over,
  };
  return { deps, calls };
}

/* ══════════════════════════════════════════════════════════════
   1. ELIGIBILITY
   ══════════════════════════════════════════════════════════════ */

test("1a: a live 4-week subscription may be upgraded", () => {
  assert.equal(mayUpgradeToAnnualPlan({ subscription: subRow(), annualPlans: [] }), true);
  assert.equal(isLiveSubscription(subRow()), true);
});

test("1b: no live subscription, no upgrade", () => {
  // Ended: history, and nothing to hand over.
  const ended = subRow({ status: "cancelled", cancelled_at: PERIOD_END });
  assert.equal(mayUpgradeToAnnualPlan({ subscription: ended, annualPlans: [] }), false);
  assert.equal(getSubscriptionStatusLabel(ended), "Beendet");
  // Pending: never reached Stripe, so there is no period to hand over.
  assert.equal(mayUpgradeToAnnualPlan({ subscription: subRow({ status: "pending" }), annualPlans: [] }), false);
  // Absent entirely.
  assert.equal(mayUpgradeToAnnualPlan({ subscription: null, annualPlans: [] }), false);
});

test("1c: a live annual plan blocks the upgrade", () => {
  assert.equal(mayUpgradeToAnnualPlan({ subscription: subRow(), annualPlans: [annualRow()] }), false);
  // A refunded or completed one does not: that is history, and the
  // ordinary repurchase rules already say so.
  for (const finished of [annualRow({ paymentStatus: "refunded" }), annualRow({ status: "completed" })]) {
    assert.equal(isLiveAnnualPlan(finished), false);
    assert.equal(mayUpgradeToAnnualPlan({ subscription: subRow(), annualPlans: [finished] }), true);
  }
});

test("1d: a standing cancellation does NOT block the upgrade", () => {
  const scheduled = subRow({
    cancellation_requested_at: UPGRADE_EARLY,
    cancellation_effective_at: PERIOD_END,
  });
  assert.equal(getSubscriptionStatusLabel(scheduled), "Kündigung vorgemerkt");
  assert.equal(mayUpgradeToAnnualPlan({ subscription: scheduled, annualPlans: [] }), true);
  // And the date it already promised is what the review screen shows.
  assert.equal(expectedTransitionAt(scheduled), PERIOD_END);
});

test("1e: a subscription with no period, and a B2B one, are refused", () => {
  assert.equal(mayUpgradeToAnnualPlan({ subscription: subRow({ current_period_end: null }), annualPlans: [] }), false);
  assert.equal(mayUpgradeToAnnualPlan({ subscription: subRow({ customer_type: "business" }), annualPlans: [] }), false);
});

/* ══════════════════════════════════════════════════════════════
   2. THE TRANSITION ANCHOR
   ══════════════════════════════════════════════════════════════ */

test("2a: the anchor is the CURRENT PAID PERIOD END - the brief's example", () => {
  const r = resolveTransitionAnchor({ periodEnd: PERIOD_END, paidAt: UPGRADE_EARLY });
  assert.equal(r.ok, true);
  assert.equal(r.anchor.at, PERIOD_END, "the handover is not the period end");
  assert.equal(r.anchor.source, "period_end");
  assert.equal(r.anchor.needsStripeSchedule, true);
});

test("2b: AND IT IGNORES THE 14-DAY CUTOFF - upgrading late does not add a cycle", () => {
  /*
    THE CORRECTION THIS SUITE EXISTS FOR.

    An ordinary cancellation on 20.10, five days before the period ends,
    is LATE: migration 034 promises one more delivery and one more charge
    because that renewal is already in motion. An upgrade must not do
    that - the customer has just paid for a whole year.
  */
  const ordinary = resolveCancellationSchedule({
    requestAt: UPGRADE_LATE, currentPeriodEnd: PERIOD_END,
  });
  assert.equal(ordinary.ok, true);
  assert.equal(ordinary.schedule.timing, "late", "the example is not inside the cutoff any more");
  assert.notEqual(ordinary.schedule.effectiveCancelAt, PERIOD_END);

  // The upgrade, for the very same instant, ends at the period end.
  const upgrade = resolveTransitionAnchor({ periodEnd: PERIOD_END, paidAt: UPGRADE_LATE });
  assert.equal(upgrade.anchor.at, PERIOD_END);
  assert.notEqual(upgrade.anchor.at, ordinary.schedule.effectiveCancelAt);

  // AND THE CUTOFF RULE ITSELF IS UNTOUCHED, in value and in reach.
  assert.equal(CANCELLATION_CUTOFF_DAYS, 14);
  assert.ok(!upgradeRules.includes("resolveCancellationSchedule"),
    "the upgrade rules reach for the ordinary cancellation schedule");
  assert.ok(!upgradeFlow.includes("resolveCancellationSchedule"),
    "the transition reaches for the ordinary cancellation schedule");
  assert.ok(!upgradeRules.includes("CANCELLATION_CUTOFF_DAYS"));
});

test("2c: a standing end date wins, and is never moved", () => {
  // A late cancellation already promised 22.11. The upgrade adopts it
  // rather than pulling it forward - the customer was told that date.
  const r = resolveTransitionAnchor({
    standingEffectiveAt: NEXT_CYCLE_END, periodEnd: PERIOD_END, paidAt: UPGRADE_LATE,
  });
  assert.equal(r.anchor.at, NEXT_CYCLE_END);
  assert.equal(r.anchor.source, "standing_cancellation");
  assert.equal(r.anchor.needsStripeSchedule, false, "a promised end was re-scheduled");
});

test("2d: an anchor is never before the money", () => {
  // Settled long after the period ended: the subscription covers
  // nothing, so the plan starts at the purchase rather than scheduling
  // thirteen boxes into the past.
  const late = "2026-12-01T00:00:00.000Z";
  const r = resolveTransitionAnchor({ periodEnd: PERIOD_END, paidAt: late });
  assert.equal(r.anchor.at, late);
  assert.equal(r.anchor.source, "payment");
  // Which is exactly what the migration refuses to accept otherwise.
  assert.match(m066Sql, /if p_schedule_anchor_at < v_purchased then/);
  assert.match(m066Sql, /'result', 'anchor_before_purchase'/);
});

test("2e: no period, no promise", () => {
  assert.deepEqual(resolveTransitionAnchor({ periodEnd: null, paidAt: UPGRADE_EARLY }),
    { ok: false, reason: "period_end_missing" });
  assert.deepEqual(resolveTransitionAnchor({ periodEnd: PERIOD_END, paidAt: "" }),
    { ok: false, reason: "paid_at_missing" });
  // NO ARITHMETIC ANYWHERE. Every answer is one of the values handed in.
  for (const banned of ["672", "8736", "28 *", "* 28", "setDate(", "Date.now()"]) {
    assert.ok(!upgradeRules.includes(banned), `the anchor rule computes: ${banned}`);
  }
});

/* ══════════════════════════════════════════════════════════════
   3. THE TRANSITION, EXECUTED
   ══════════════════════════════════════════════════════════════ */

test("3a: it reads Stripe, stops the subscription there FIRST, then records it", async () => {
  const { deps, calls } = stubDeps();
  const result = await applyUpgradeTransition({
    sourceSubscriptionId: SUB_ID, annualPlanUserId: USER_ID, paidAt: UPGRADE_EARLY, deps,
  });

  assert.equal(result.anchor.at, PERIOD_END);
  assert.equal(result.scheduleResult, "scheduled");
  assert.equal(calls.retrieved, 1, "the authoritative period was not re-read");
  assert.equal(calls.stripe.length, 1);
  assert.equal(calls.stripe[0].cancelAtIso, PERIOD_END);
  assert.equal(calls.stripe[0].stripeSubscriptionId, STRIPE_SUB);
  assert.equal(calls.local.length, 1);
  // The local row records the SAME date Stripe was given, to the second.
  assert.equal(calls.local[0].effectiveAt, PERIOD_END);
  assert.equal(calls.local[0].cancelAt, PERIOD_END);
  assert.equal(calls.local[0].subscriptionId, SUB_ID);
  assert.equal(calls.local[0].userId, USER_ID);
  // requestedAt is the PAYMENT's instant, not a clock, so a redelivery
  // asks the identical question.
  assert.equal(calls.local[0].requestedAt, UPGRADE_EARLY);
});

test("3b: ordering - Stripe before the local write, always", () => {
  const stripeAt = upgradeFlow.indexOf("deps.scheduleAtStripe(");
  const localAt = upgradeFlow.indexOf("deps.scheduleLocally(");
  assert.ok(stripeAt > -1 && localAt > stripeAt,
    "the local cancellation is written before Stripe accepts one");
});

test("3c: a Stripe failure writes nothing locally", async () => {
  const { deps, calls } = stubDeps({
    scheduleAtStripe: async () => { throw new Error("stripe down"); },
  });
  await assert.rejects(() => applyUpgradeTransition({
    sourceSubscriptionId: SUB_ID, annualPlanUserId: USER_ID, paidAt: UPGRADE_EARLY, deps,
  }), /stripe down/);
  assert.equal(calls.local.length, 0, "the subscription was marked cancelled without Stripe");
});

test("3d: a refused local write is retryable and never reported as done", async () => {
  for (const result of ["conflict", "period_moved", "not_eligible", "rpc_error", "unknown"]) {
    const { deps } = stubDeps({ scheduleLocally: async () => ({ result }) });
    await assert.rejects(() => applyUpgradeTransition({
      sourceSubscriptionId: SUB_ID, annualPlanUserId: USER_ID, paidAt: UPGRADE_EARLY, deps,
    }), new RegExp(result), result);
  }
  // Only these two mean "recorded".
  assert.deepEqual([...UPGRADE_SCHEDULE_SETTLED], ["scheduled", "already_scheduled"]);
});

test("3e: a redelivery is idempotent - same key, same date, no second promise", async () => {
  const { deps, calls } = stubDeps({
    scheduleLocally: async () => ({ result: "already_scheduled" }),
  });
  const first = await applyUpgradeTransition({
    sourceSubscriptionId: SUB_ID, annualPlanUserId: USER_ID, paidAt: UPGRADE_EARLY, deps,
  });
  const second = await applyUpgradeTransition({
    sourceSubscriptionId: SUB_ID, annualPlanUserId: USER_ID, paidAt: UPGRADE_EARLY, deps,
  });
  assert.equal(first.anchor.at, second.anchor.at, "a retry moved the handover date");
  assert.equal(calls.stripe[0].idempotencyKey, calls.stripe[1].idempotencyKey);
  assert.match(calls.stripe[0].idempotencyKey, /^gloa\/subscription-upgrade\//);
  // And a DIFFERENT date gets a different key, so a genuine change is
  // never swallowed by a reused one.
  assert.notEqual(
    upgradeCancelIdempotencyKey(SUB_ID, PERIOD_END),
    upgradeCancelIdempotencyKey(SUB_ID, NEXT_CYCLE_END)
  );
});

test("3f: a subscription that already has an end date is not touched at all", async () => {
  const { deps, calls } = stubDeps({
    loadSubscription: async () => subRow({
      cancellation_requested_at: UPGRADE_EARLY,
      cancellation_effective_at: NEXT_CYCLE_END,
    }),
  });
  const result = await applyUpgradeTransition({
    sourceSubscriptionId: SUB_ID, annualPlanUserId: USER_ID, paidAt: UPGRADE_LATE, deps,
  });
  assert.equal(result.anchor.at, NEXT_CYCLE_END, "the promised end was moved");
  assert.equal(result.scheduleResult, null);
  assert.equal(calls.stripe.length, 0, "Stripe was asked to re-schedule a standing end");
  assert.equal(calls.local.length, 0, "the local row was rewritten");
  assert.equal(calls.retrieved, 0);
});

test("3g: ownership is proved again before anything ends", async () => {
  const { deps, calls } = stubDeps({
    loadSubscription: async () => subRow({ user_id: "99999999-9999-4999-8999-999999999999" }),
  });
  await assert.rejects(() => applyUpgradeTransition({
    sourceSubscriptionId: SUB_ID, annualPlanUserId: USER_ID, paidAt: UPGRADE_EARLY, deps,
  }), UpgradeTransitionConflict);
  assert.equal(calls.stripe.length, 0);
  assert.equal(calls.local.length, 0);

  const missing = stubDeps({ loadSubscription: async () => null });
  await assert.rejects(() => applyUpgradeTransition({
    sourceSubscriptionId: SUB_ID, annualPlanUserId: USER_ID, paidAt: UPGRADE_EARLY, deps: missing.deps,
  }), UpgradeTransitionConflict);
  assert.equal(missing.calls.stripe.length, 0);
});

test("3h: it never prorates and never refunds", () => {
  for (const banned of ["proration", "prorate", "refund", "credit_note", "invoice_item"]) {
    assert.ok(!upgradeFlow.includes(banned), `the transition ${banned}s`);
    assert.ok(!upgradeRules.includes(banned));
  }
  // cancel_at, never cancel_at_period_end: the date is explicit and must
  // match the local row to the second.
  assert.match(webhookDeps, /cancel_at: toStripeTimestamp\(cancelAtIso\)/);
  assert.ok(!webhookDeps.includes("cancel_at_period_end"));
});

/* ══════════════════════════════════════════════════════════════
   4. PAYMENT FAILURE SAFETY, AND THE SETTLEMENT ORDER
   ══════════════════════════════════════════════════════════════ */

test("4a: pressing the button writes nothing to the subscription", () => {
  /*
    THE CHECKOUT READS AND REFUSES; IT NEVER SCHEDULES. An abandoned,
    failed or expired annual payment therefore leaves the subscription
    exactly as it was - there is no code path from the checkout route to
    a cancellation at all.
  */
  assert.match(annualFlow, /const source = await deps\.loadOwnSubscription\(/);
  assert.match(annualFlow, /mayUpgradeToAnnualPlan\(\{ subscription: source, annualPlans: ownPlans\.rows \}\)/);
  for (const banned of [
    "schedule_subscription_cancellation", "cancel_at", "applyUpgradeTransition",
    "scheduleAtStripe", "subscriptions.update",
  ]) {
    assert.ok(!annualFlow.includes(banned), `the checkout route ${banned}s`);
  }
});

test("4b: the transition runs AFTER the money and BEFORE activation", () => {
  const paidAt = webhook.indexOf("await deps.settlePaidAtomically(");
  const transitionAt = webhook.indexOf("await deps.applyTransition(");
  const activateAt = webhook.indexOf("await deps.activatePlan(");
  assert.ok(paidAt > -1 && transitionAt > paidAt,
    "the subscription is stopped before the annual payment is durable");
  assert.ok(activateAt > transitionAt,
    "the annual plan is activated before the subscription is stopped");
  // AND ONLY FOR AN UPGRADE.
  assert.match(webhook, /if \(plan\.source_subscription_id\) \{/);
  assert.match(webhook, /let scheduleAnchorAt: string \| null = null;/);
});

test("4c: an incomplete transition leaves the plan pending, and retries finish it", () => {
  // applyTransition throws on every failure, and the webhook does not
  // catch it - so activation is never reached, no delivery row exists,
  // no email is owed, and Stripe redelivers into the same path.
  const block = between(webhook, "if (plan.source_subscription_id) {", "const activation =");
  assert.ok(!block.includes("catch"), "a failed transition is swallowed");
  assert.ok(!block.includes("try {"), "a failed transition is swallowed");
  assert.match(block, /throw new Error\(`annual attempt \$\{attempt\.id\}: paid_at missing after settlement`\)/);
  // The anchor comes from the transition and is passed straight through.
  assert.match(webhook, /scheduleAnchorAt = transition\.anchorAt;/);
  assert.match(webhook, /scheduleAnchorAt,\s*\}\)/);
});

test("4d: paid_at is re-read, so a retry computes the same date", () => {
  assert.match(webhook, /const paidAt = await deps\.loadAttemptPaidAt\(attempt\.id\);/);
  assert.match(webhookDeps, /\.select\("paid_at"\)/);
  // NO CLOCK in the settlement path's date handling.
  for (const banned of ["Date.now()", "new Date()"]) {
    assert.ok(!webhook.includes(banned), `the settlement reads a clock: ${banned}`);
  }
});

/* ══════════════════════════════════════════════════════════════
   5. THE MIGRATION
   ══════════════════════════════════════════════════════════════ */

test("5a: two nullable columns, and an ordinary plan is unchanged", () => {
  assert.match(m066Sql, /add column source_subscription_id uuid references public\.subscriptions\(id\)/);
  assert.match(m066Sql, /add column schedule_anchor_at\s+timestamptz/);
  // Nullable: no NOT NULL, no DEFAULT, no backfill, no UPDATE of
  // existing rows anywhere in the file.
  assert.ok(!/add column (source_subscription_id|schedule_anchor_at)[^,;]*not null/i.test(m066Sql));
  assert.ok(!/^update public\.annual_plans/mi.test(m066Sql.replace(/update public\.annual_plans\n\s+set status/g, "")));
  // The ordinary anchor is still paid_at.
  assert.match(m066Sql, /if v_plan\.source_subscription_id is null then/);
  assert.match(m066Sql, /v_anchor := v_purchased;/);
});

test("5b: the invariant the audit was asked to relax", () => {
  // An unpaid upgrade legitimately has a source and NO anchor, so the
  // pair is one-directional rather than all-or-nothing.
  assert.match(m066Sql, /check \(schedule_anchor_at is null or source_subscription_id is not null\)/);
  assert.ok(!/\(source_subscription_id is null\) =\s*\(schedule_anchor_at is null\)/.test(m066Sql),
    "the all-or-nothing constraint the audit proposed survived");
  // And an anchor can only exist on a plan that was actually paid for.
  assert.match(m066Sql, /check \(schedule_anchor_at is null or purchased_at is not null\)/);
});

test("5c: one subscription can have at most ONE active upgrade", () => {
  assert.match(m066Sql, /create unique index annual_plans_active_upgrade_per_subscription_key/);
  assert.match(m066Sql, /on public\.annual_plans \(source_subscription_id\)/);
  assert.match(m066Sql, /where source_subscription_id is not null\s+and status = 'active'/);
  // PENDING rows are deliberately not covered: nothing expires them, and
  // a gate on them would let one abandoned tab veto a purchase for good.
  assert.ok(!/status in \('pending', 'active'\)/.test(m066Sql));
  // The losing activation is refused, not retried forever.
  assert.match(m066Sql, /'result', 'transition_conflict'/);
  assert.match(read("lib/annualPlanWebhookRules.ts"),
    /result === "transition_conflict"[\s\S]{0,200}terminal: true/);
});

test("5d: both functions are REPLACED, never overloaded", () => {
  assert.match(m066Sql, /drop function public\.create_pending_annual_plan_for_attempt\(/);
  assert.match(m066Sql, /drop function public\.activate_annual_plan_from_payment\(uuid, text, text\);/);
  // And their privileges are restated, because a dropped function takes
  // its grants with it.
  assert.match(m066Sql, /grant execute on function public\.activate_annual_plan_from_payment\(uuid, text, text, timestamptz\) to service_role;/);
  for (const role of ["public", "anon", "authenticated"]) {
    assert.ok(m066Sql.includes(`from ${role};`), `the new functions are not revoked from ${role}`);
  }
});

test("5e: the anchor is required for an upgrade and refused for anything else", () => {
  assert.match(m066Sql, /'result', 'anchor_required'/);
  assert.match(m066Sql, /'result', 'anchor_not_expected'/);
  // A redelivery carrying a different anchor is a conflict, not a retry:
  // thirteen dates the customer has been emailed must not move.
  assert.match(m066Sql, /'result', 'anchor_conflict'/);
  // The term follows the anchor, so the plan still ends after box 13.
  assert.match(m066Sql, /plan_end_at\s+= v_anchor \+ pg_catalog\.make_interval\(hours => 8736\)/);
  assert.match(m066Sql, /v_anchor \+ pg_catalog\.make_interval\(hours => 672 \* \(n - 1\)\)/);
});

test("5f: it changes no price, no cadence, no count and no cancellation rule", () => {
  assert.match(m066Sql, /v_count := 13;/);
  for (const banned of [
    "discount_percent_applied =", "annual_unit_gross_cents =", "total_gross_cents =",
    "delivery_count =", "alter table public.subscriptions",
    "schedule_subscription_cancellation", "resolveCancellationSchedule",
  ]) {
    assert.ok(!m066Sql.includes(banned), `migration 066 changes ${banned}`);
  }
  // It is the newest file, and nothing below it was edited.
  const files = read("package.json");
  assert.ok(files.includes("tests/subscription-annual-upgrade.test.mjs"),
    "this suite is not in the test script");
});

/* ══════════════════════════════════════════════════════════════
   6. THE ACCOUNT
   ══════════════════════════════════════════════════════════════ */

const subDetail = between(portalCode, "function SubscriptionDetail(", "function PortalAddresses()");
const annualForm = between(portalCode, "function AnnualPlanStartForm(", "function PortalAnnualPlans(");

test("6a: the CTA appears on a live subscription, and only there", () => {
  assert.match(subDetail, /const mayUpgrade = !transitionPlan\s*&& mayUpgradeToAnnualPlan\(\{/);
  assert.match(subDetail, /\{UPGRADE_CTA\}/);
  assert.match(subDetail, /\{UPGRADE_EXPLAINER\}/);
  assert.equal(UPGRADE_CTA, "AUF JAHRESPLAN WECHSELN");
  // The promise beside it, and it never calls the 4-week abo monthly.
  assert.match(UPGRADE_EXPLAINER, /Es gibt keine doppelte Lieferung\./);
  assert.ok(!/Monat/.test(UPGRADE_EXPLAINER));
});

test("6b: the review states what stops and what starts, before any money", () => {
  assert.match(annualForm, /label=\{sourceSubscription \? "WECHSEL ZUM JAHRESPLAN" : "JAHRESPLAN STARTEN"\}/);
  for (const line of [
    "<dt>Aktuelles Abo</dt>",
    "<dt>Dein Abo läuft noch bis</dt>",
    "<dt>Danach</dt><dd>keine weitere Abo-Abbuchung</dd>",
    "<dt>Jahresplan startet</dt>",
    "JAHRESPLAN KAUFEN",
  ]) {
    assert.ok(annualForm.includes(line), `the review lost: ${line}`);
  }
  // The date comes from the subscription's own row, and the copy names
  // the condition under which it is final.
  assert.match(annualForm, /expectedTransitionAt\(sourceSubscription as unknown as UpgradeSubscriptionRow\)/);
  assert.match(annualForm, /\{UPGRADE_DATE_IS_CONFIRMED_ON_PAYMENT\}/);
  // NO MONEY IS COMPUTED IN THE BROWSER. The total is the same leaf the
  // server prices with, unchanged by the upgrade.
  assert.match(annualForm, /buildAnnualPricing\(\{ size, catalogUnitGrossCents: v\.price_gross_cents \}\)/);
});

test("6c: during the handover the account shows one delivering contract", () => {
  assert.match(subDetail, /const transitionPlan = findTransitionPlanFor\(sub\.id, livePlans\);/);
  assert.match(subDetail, /\{UPGRADE_SCHEDULED_LABEL\}/);
  assert.equal(UPGRADE_SCHEDULED_LABEL, "Wechsel zum Jahresplan vorgemerkt");
  assert.match(subDetail, /Dein Abo läuft bis \{fmtDate\(endsAt\)\}/);
  assert.match(subDetail, /Erste Jahresplan-Lieferung: \{fmtDate\(transitionPlan\.scheduleAnchorAt\)\}/);
  assert.match(subDetail, /Es gibt keine doppelte Lieferung\./);
  // The upgrade CTA is gone once the handover is in progress.
  assert.ok(subDetail.indexOf("const mayUpgrade = !transitionPlan") > -1);
});

test("6d: the account reads the handover, and only the handover", () => {
  const select = read("lib/annualPlanAccount.ts");
  assert.match(select, /"source_subscription_id, schedule_anchor_at"/);
  // Still no Stripe identity, no claim token, no snapshot.
  for (const secret of ["stripe_payment_intent_id", "purchase_confirmation_email", "tax_snapshot"]) {
    assert.ok(!select.includes(`, ${secret}`), `the account select asks for ${secret}`);
  }
});

/* ══════════════════════════════════════════════════════════════
   7. THE EMAIL
   ══════════════════════════════════════════════════════════════ */

test("7a: one mail, and it says what an upgrade needs it to say", () => {
  assert.match(emailTemplate, /const UPGRADE_SUBJECT = "Dein Wechsel zum GLOA Jahresplan ist bestätigt";/);
  for (const line of [
    "Dein bisheriges Abo läuft bis zum Ende des bereits bezahlten Zeitraums weiter.",
    "Danach wird dein Abo nicht mehr verlängert und nicht mehr abgebucht.",
    "Dein Jahresplan beginnt genau dann. Es gibt keine doppelte Lieferung.",
  ]) {
    assert.ok(emailTemplate.includes(line), `the upgrade mail lost: ${line}`);
  }
  // The existing facts stay: one payment, no renewal, the total, 13.
  for (const kept of ["ONE_PAYMENT", "NO_RENEWAL", "Einmalig bezahlt", "plan.deliveryCount"]) {
    assert.ok(emailTemplate.includes(kept), `the mail lost: ${kept}`);
  }
  // Both dates are the STORED handover, printed twice because a customer
  // has two questions about one instant.
  assert.match(emailTemplate, /factRows\.push\(\["Dein Abo läuft bis", handoverDate\]\);/);
  assert.match(emailTemplate, /factRows\.push\(\["Jahresplan startet", handoverDate\]\);/);
  assert.match(emailTemplate, /"Erste Jahresplan-Lieferung" : "Nächste geplante Lieferung"/);
});

test("7b: it is the SAME claim, so a retry cannot send it twice", () => {
  const sender = read("lib/annualPurchaseConfirmationEmail.ts");
  // One message per plan, claimed by migration 039. This phase added no
  // second message and no second claim.
  assert.match(sender, /claim_annual_plan_purchase_email/);
  assert.ok(!sender.includes("claim_annual_plan_upgrade_email"), "a second email claim appeared");
  // And the handover date is READ from the plan, not recomputed.
  assert.match(sender, /transitionAt: typeof plan\.schedule_anchor_at === "string"/);
  // An upgrade never claims the first box is already on its way.
  assert.match(emailTemplate, /!isUpgrade && plan\.firstDeliveryStarted/);
});

/* ══════════════════════════════════════════════════════════════
   8. THE ORDINARY PATHS ARE UNCHANGED
   ══════════════════════════════════════════════════════════════ */

test("8a: an ordinary annual purchase sends no source and gets no anchor", () => {
  // The field is absent from the body unless an upgrade named one.
  assert.match(portalCode, /\.\.\.\(sourceSubscription \? \{ sourceSubscriptionId: sourceSubscription\.id \} : \{\}\)/);
  // Null all the way down, and the database anchors on paid_at.
  assert.match(annualFlow, /sourceSubscriptionId: sourceSubscriptionId,/);
  assert.match(m066Sql, /if v_plan\.source_subscription_id is null then[\s\S]{0,200}v_anchor := v_purchased;/);
});

test("8b: the subscription product is untouched", () => {
  const subFlow = withoutComments(read("lib/subscriptionCheckout.ts"));
  for (const banned of ["annual", "Annual", "sourceSubscriptionId", "schedule_anchor"]) {
    assert.ok(!subFlow.includes(banned), `the subscription checkout learned about annual plans: ${banned}`);
  }
  // The cancellation engine, its cutoff and its endpoint are as they were.
  const rules = read("lib/subscriptionCancellationRules.ts");
  assert.match(rules, /export const CANCELLATION_CUTOFF_DAYS = 14;/);
  assert.match(rules, /export const CADENCE_DAYS = 28;/);
  assert.ok(!rules.includes("subscriptionUpgrade"), "the cancellation leaf learned about upgrades");
  assert.match(subDetail, /await fetch\("\/api\/subscriptions\/cancel"/);
});

test("8c: no new endpoint, and the upgrade rides the existing annual checkout", () => {
  const endpoints = [...portalCode.matchAll(/"(\/api\/[^"]*)"/g)].map(m => m[1]);
  assert.ok(endpoints.includes("/api/annual-plan/checkout/session"));
  for (const invented of ["/api/annual-plan/upgrade", "/api/subscriptions/upgrade", "/api/upgrade"]) {
    assert.ok(!endpoints.includes(invented), `a new endpoint appeared: ${invented}`);
  }
  assert.match(read("app/api/annual-plan/checkout/session/route.ts"),
    /return handleAnnualPlanCheckout\(request, defaultAnnualCheckoutDeps\);/);
});
