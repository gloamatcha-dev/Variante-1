import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ANNUAL_CUSTOMER_CLAIM_CONFLICT,
  ANNUAL_PENDING_PLAN_CONFLICT_RESULTS,
  ANNUAL_PLAN_LIVE_CONFLICT,
  ANNUAL_UPGRADE_CLAIM_CONFLICT,
  ANNUAL_UPGRADE_CLAIM_TTL_MS,
  STRIPE_MIN_CHECKOUT_LIFETIME_MS,
  annualCheckoutIdempotencyKey,
  annualPendingPlanFailureStatus,
  annualUpgradeClaimExpiry,
  resolveAnnualSessionExpiry,
} from "../lib/annualPlanCheckoutRules.ts";
import {
  ANNUAL_CHECKOUT_ALREADY_PENDING,
  ANNUAL_PLAN_ALREADY_RUNNING,
  annualPlanHasEndedForGood,
  isLiveAnnualPlan,
} from "../lib/purchaseEligibility.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf8");

const M066 = read("supabase/migrations/066_annual_plan_subscription_transition.sql");
const M067 = read("supabase/migrations/067_annual_upgrade_pending_claim.sql");
const M068 = read("supabase/migrations/068_annual_plan_customer_claim.sql");
const CHECKOUT = read("lib/annualPlanCheckout.ts");
const CHECKOUT_DEPS = read("lib/annualPlanCheckoutDeps.ts");

/** 068's writer, isolated from the prose around it. */
const WRITER = M068.slice(
  M068.indexOf("create or replace function public.create_pending_annual_plan_for_attempt"),
  M068.indexOf("-- 5. PRIVILEGES"));
/** The executable half of 068, with the trailing verify comments dropped. */
const EXEC = M068.slice(0, M068.indexOf("-- 8. VERIFY"));

const T0 = Date.parse("2026-09-29T12:00:00.000Z");
const plan = (over = {}) => ({
  id: "66666666-7777-8888-9999-aaaaaaaaaaa1",
  status: "active", paymentStatus: "paid", paymentAttemptId: null, ...over,
});

/* ══════════════════════════════════════════════════════════════
   1-6. THE CUSTOMER CLAIM, AND THE FOUR COMBINATIONS
   ══════════════════════════════════════════════════════════════ */

test("1: an ordinary annual checkout now takes a customer claim", () => {
  // 067 sent a claim only for an upgrade. 068 sends one always, which is
  // the single line that brings the ordinary path inside the gate.
  assert.match(CHECKOUT, /pendingExpiresAt: claimExpiry,/);
  assert.ok(!/pendingExpiresAt: sourceSubscriptionId \?/.test(CHECKOUT),
    "the claim is still conditional on there being an upgrade");
  assert.match(CHECKOUT_DEPS, /p_pending_expires_at: input\.pendingExpiresAt,/);
  // And the database now accepts one on a row that names no subscription.
  assert.match(M068, /check \(pending_expires_at is null or status = 'pending'\)/);
});

test("2: a second annual checkout for the same customer is refused", () => {
  assert.equal(ANNUAL_CUSTOMER_CLAIM_CONFLICT, "annual_checkout_already_pending");
  assert.match(WRITER, /'result', 'annual_checkout_already_pending'/);
  // A fact about the customer, not about the server: a conflict, not an
  // outage, so the browser is not invited to retry the same second.
  assert.ok(ANNUAL_PENDING_PLAN_CONFLICT_RESULTS.includes(ANNUAL_CUSTOMER_CLAIM_CONFLICT));
  assert.equal(annualPendingPlanFailureStatus(ANNUAL_CUSTOMER_CLAIM_CONFLICT), 409);
  assert.match(CHECKOUT, /return fail\(409, ANNUAL_CHECKOUT_ALREADY_PENDING\);/);
  // The exact sentence, naming both ways out and neither a date nor a path.
  assert.match(ANNUAL_CHECKOUT_ALREADY_PENDING, /Du hast bereits einen offenen Jahresplan-Checkout\./);
  assert.match(ANNUAL_CHECKOUT_ALREADY_PENDING,
    /Schließe den bestehenden Checkout ab oder versuche es später erneut\./);
  assert.ok(!/\d{4}-\d{2}-\d{2}|EUR|€|Abo|Wechsel/.test(ANNUAL_CHECKOUT_ALREADY_PENDING),
    "the refusal leaks a date, an amount or which path the other tab took");
});

test("3: the refused second checkout cannot reach Stripe", () => {
  // THE ORDERING IS THE PROOF: the refusal returns before the first line
  // that could contact Stripe, so no second payable session can exist.
  const refusal = CHECKOUT.indexOf("if (pending.reason === ANNUAL_CUSTOMER_CLAIM_CONFLICT) {");
  const ret = CHECKOUT.indexOf("return fail(409, ANNUAL_CHECKOUT_ALREADY_PENDING);", refusal);
  const getStripe = CHECKOUT.indexOf("const stripe = deps.getStripe();");
  const create = CHECKOUT.indexOf("stripe.checkout.sessions.create(");
  assert.ok(refusal > 0 && ret > 0 && getStripe > 0 && create > 0);
  assert.ok(ret < getStripe, "the refusal returns after Stripe is resolved");
  assert.ok(ret < create, "the refusal returns after a session is created");
  // The writer creates nothing on that path either.
  assert.ok(WRITER.indexOf("'result', 'annual_checkout_already_pending'")
            < WRITER.indexOf("insert into public.annual_plans"),
    "the writer inserts before it refuses");
});

test("4: a different requestId does not bypass the customer claim", () => {
  // Two request ids give two attempts and two Stripe idempotency keys.
  // The claim depends on neither: it is keyed on user_id, the one value
  // every annual plan has whichever path created it.
  assert.notEqual(annualCheckoutIdempotencyKey("a"), annualCheckoutIdempotencyKey("b"));
  assert.match(WRITER, /where user_id = p_user_id\s*\n\s*and status = 'pending'\s*\n\s*and pending_expires_at > pg_catalog\.now\(\)/);
  // It excludes only this checkout's own attempt, so a retry is never
  // blocked by the claim it created itself.
  assert.match(WRITER, /payment_checkout_attempt_id is distinct from p_checkout_attempt_id/);
  assert.ok(WRITER.indexOf("'result', 'existing'")
            < WRITER.indexOf("'result', 'annual_checkout_already_pending'"),
    "the own-plan short-circuit is below the claim question");
});

test("5: an expired ordinary claim stops blocking, with no job involved", () => {
  assert.match(WRITER, /and pending_expires_at > pg_catalog\.now\(\)/);
  assert.ok(!/delete from public\.annual_plans/.test(M068), "068 deletes historical rows");
  assert.ok(!/pg_cron|cron\.schedule/.test(M068), "068 depends on a scheduler");
  // The customer-claim index is partial and NOT unique - "unique among
  // the unexpired" is not something a unique index can say.
  const idx = M068.slice(M068.indexOf("create index annual_plans_pending_customer_claim_idx"));
  assert.ok(!/unique/i.test(idx.slice(0, 220)));
  assert.match(idx, /where status = 'pending';/);
});

test("6: all four path combinations meet the same single refusal", () => {
  // ONE DOMAIN, NOT TWO. The customer-level question is asked before the
  // upgrade-specific one and is not nested inside the upgrade branch, so
  // ordinary+ordinary, upgrade+ordinary, ordinary+upgrade and
  // upgrade+upgrade all reach it.
  const customerCheck = WRITER.indexOf("'result', 'annual_checkout_already_pending'");
  const upgradeBranch = WRITER.indexOf("if p_source_subscription_id is not null then");
  assert.ok(customerCheck > 0 && upgradeBranch > 0);
  assert.ok(customerCheck < upgradeBranch,
    "the customer-level claim is asked inside the upgrade branch and would miss ordinary tabs");
  // And the upgrade's narrower guarantee is kept rather than absorbed.
  assert.ok(WRITER.indexOf("'result', 'upgrade_already_pending'") > upgradeBranch);
  assert.ok(ANNUAL_PENDING_PLAN_CONFLICT_RESULTS.includes(ANNUAL_UPGRADE_CLAIM_CONFLICT));
});

/* ══════════════════════════════════════════════════════════════
   7-9. THE CUSTOMER LOCK
   ══════════════════════════════════════════════════════════════ */

test("7: the critical section serializes on a durable per-customer row", () => {
  // public.profiles: ours, one row per user, primary key on user_id,
  // created by migration 001's trigger and removed only by cascade.
  assert.match(WRITER, /from public\.profiles\s*\n\s*where user_id = p_user_id\s*\n\s*for update;/);
  const m001 = read("supabase/migrations/001_customer_accounts.sql");
  assert.match(m001, /create table public\.profiles \(\s*\n\s*user_id\s+uuid primary key references auth\.users\(id\) on delete cascade/);
  assert.match(m001, /insert into public\.profiles \(/);
  // NOT Supabase's auth table, which would couple checkout to GoTrue.
  assert.ok(!/from auth\.users[\s\S]{0,80}for update/.test(M068),
    "068 takes a row lock inside Supabase's auth schema");
});

test("8: the lock is taken BEFORE anything is read about this customer", () => {
  const lock = WRITER.indexOf("for update;\n\n  if not found then\n    -- Fails closed.");
  const claimQ = WRITER.indexOf("'result', 'annual_checkout_already_pending'");
  const liveQ = WRITER.indexOf("'result', 'annual_plan_already_live'");
  assert.ok(lock > 0, "the customer lock is not taken at all");
  assert.ok(lock < claimQ, "the claim is decided before the customer is locked");
  assert.ok(lock < liveQ, "the live plan is decided before the customer is locked");
  // LOCK ORDER: attempts, then profiles, then subscriptions. One order,
  // one function holding more than one of them, so no cycle.
  const attemptLock = WRITER.indexOf("from public.checkout_attempts");
  const subLock = WRITER.indexOf("from public.subscriptions");
  assert.ok(attemptLock < lock && lock < subLock,
    "the lock order is not attempts -> profiles -> subscriptions");
});

test("9: a missing profile fails CLOSED, never open", () => {
  // profiles is filled by a trigger rather than by a foreign key, so
  // "always there" is a convention. A SELECT FOR UPDATE that matches
  // nothing locks nothing and would let both tabs through - so it
  // refuses instead.
  assert.match(WRITER, /'result', 'customer_profile_missing'/);
  const at = WRITER.indexOf("'result', 'customer_profile_missing'");
  assert.ok(at < WRITER.indexOf("'result', 'annual_checkout_already_pending'"),
    "the checkout continues past a missing lock row");
  assert.ok(at < WRITER.indexOf("insert into public.annual_plans"));
  // It is not a conflict the browser should retry into; it is a fault.
  assert.ok(!ANNUAL_PENDING_PLAN_CONFLICT_RESULTS.includes("customer_profile_missing"));
  assert.equal(annualPendingPlanFailureStatus("customer_profile_missing"), 503);
});

/* ══════════════════════════════════════════════════════════════
   10-14. ONE LIVE PLAN, AND REPURCHASE AFTER A TERMINAL ONE
   ══════════════════════════════════════════════════════════════ */

test("10: a customer holding a live annual plan cannot start another", () => {
  assert.equal(ANNUAL_PLAN_LIVE_CONFLICT, "annual_plan_already_live");
  assert.match(WRITER, /'result', 'annual_plan_already_live'/);
  assert.ok(ANNUAL_PENDING_PLAN_CONFLICT_RESULTS.includes(ANNUAL_PLAN_LIVE_CONFLICT));
  assert.equal(annualPendingPlanFailureStatus(ANNUAL_PLAN_LIVE_CONFLICT), 409);
  // The customer sees the sentence the route already gave them.
  assert.match(CHECKOUT, /return fail\(409, ANNUAL_PLAN_ALREADY_RUNNING\);/);
  assert.match(ANNUAL_PLAN_ALREADY_RUNNING, /bereits einen laufenden Jahresplan/);
  // USER-LEVEL, so a different size, a different request id and the
  // other purchase path all meet it.
  assert.match(WRITER, /where user_id = p_user_id\s*\n\s*and status = 'active'\s*\n\s*and payment_status <> 'refunded'/);
});

test("11: the database's own one-live-plan-per-user invariant", () => {
  assert.match(M068, /create unique index annual_plans_one_live_per_user_key\s*\n\s*on public\.annual_plans \(user_id\)\s*\n\s*where status = 'active'\s*\n\s*and payment_status <> 'refunded';/);
  // THE PREDICATE IS isLiveAnnualPlan'S, and that is the whole point -
  // see tests 12-14 for the case a bare status='active' would break.
  assert.equal(isLiveAnnualPlan(plan()), true);
  assert.equal(isLiveAnnualPlan(plan({ paymentStatus: "refunded" })), false);
  assert.equal(isLiveAnnualPlan(plan({ status: "completed" })), false);
  assert.equal(isLiveAnnualPlan(plan({ status: "cancelled" })), false);
  // A PARTIAL refund still blocks: twelve boxes are still owed.
  assert.equal(isLiveAnnualPlan(plan({ paymentStatus: "partially_refunded" })), true);
});

test("12: a COMPLETED plan permits a repurchase", () => {
  assert.equal(isLiveAnnualPlan(plan({ status: "completed" })), false);
  assert.equal(annualPlanHasEndedForGood(plan({ status: "completed" })), true);
  // Outside the index predicate, so the unique slot is free.
  assert.ok(!/status in \('active', *'completed'\)/.test(
    M068.slice(M068.indexOf("create unique index annual_plans_one_live_per_user_key"),
               M068.indexOf("-- 3. THE CUSTOMER-KEYED"))));
});

test("13: a CANCELLED plan permits a repurchase", () => {
  assert.equal(isLiveAnnualPlan(plan({ status: "cancelled" })), false);
  assert.equal(annualPlanHasEndedForGood(plan({ status: "cancelled" })), true);
});

test("14: a FULLY REFUNDED plan permits a repurchase - the regression 068 nearly shipped", () => {
  // A refund writes payment_status and NOTHING ELSE. Migration 039's
  // record_annual_plan_refund sets payment_status and refunded_total_cents
  // and leaves status alone, so a fully refunded plan sits at 'active'
  // for good. A bare "unique (user_id) where status = 'active'" would
  // therefore have made a refunded customer unable to ever buy again -
  // and the refusal would have arrived at SETTLEMENT, after they paid.
  const m039 = read("supabase/migrations/039_b2c_annual_plan_foundation.sql");
  const refundWriter = m039.slice(m039.indexOf("update public.annual_plans\n     set payment_status"));
  assert.ok(refundWriter.startsWith("update public.annual_plans\n     set payment_status"));
  // A BARE `status =` in its SET list, not `payment_status =`.
  assert.ok(!/\n\s+status\s*=/.test(refundWriter.slice(0, 300)),
    "the refund writer changes status, which would make this test moot");
  assert.match(refundWriter.slice(0, 300), /set payment_status\s*= v_new_status,/);
  // So the index and the pre-payment check both carry the clause.
  assert.match(M068, /where status = 'active'\s*\n\s*and payment_status <> 'refunded';/);
  assert.match(WRITER, /and status = 'active'\s*\n\s*and payment_status <> 'refunded'/);
  assert.equal(isLiveAnnualPlan(plan({ paymentStatus: "refunded" })), false);
  // And 068 says so where a reader will find it.
  assert.match(M068, /FULLY REFUNDED plan sits at\s*\n-- status = 'active' forever/);
});

/* ══════════════════════════════════════════════════════════════
   15-17. EXPIRY, STRIPE AND FAILURE - ALL 067'S, UNCHANGED
   ══════════════════════════════════════════════════════════════ */

test("15: the claim is cleared on activation, and 068 does not touch activation", () => {
  // 067 clears it in the same UPDATE that sets the status. 068 leaves
  // that function completely alone, which is part of why it can be
  // applied before its code ships.
  assert.ok(!/create or replace function public\.activate_annual_plan_from_payment/.test(M068),
    "068 redefines the activation function");
  assert.ok(!/drop function public\.activate_annual_plan_from_payment/.test(M068));
  const a067 = M067.slice(M067.indexOf("-- 5. ACTIVATION RELEASES THE CLAIM"));
  assert.ok(a067.includes("pending_expires_at         = null"));
  // The new unique index is caught by the handler 067 already wrote.
  assert.match(a067, /when unique_violation then[\s\S]{0,400}'result', 'transition_conflict'/);
});

test("16: the Stripe session expiry equals the stored claim expiry", () => {
  // ONE CLOCK, still 067's, and still the row's value rather than a
  // second reading - now for every annual checkout rather than only an
  // upgrade's.
  assert.equal(ANNUAL_UPGRADE_CLAIM_TTL_MS, 30 * 60 * 1000);
  assert.equal(STRIPE_MIN_CHECKOUT_LIFETIME_MS, 30 * 60 * 1000);
  assert.match(CHECKOUT, /pendingExpiresAt: pending\.pendingExpiresAt,/);
  assert.match(CHECKOUT, /expires_at: annualExpiresAt,/);
  assert.equal((CHECKOUT.match(/deps\.now \? deps\.now\(\) : new Date\(\)/g) || []).length, 1,
    "the route reads more than one clock");
  const full = annualUpgradeClaimExpiry(new Date(T0));
  assert.deepEqual(
    resolveAnnualSessionExpiry({ pendingExpiresAt: full, nowMs: T0, sessionAlreadyLinked: false }),
    { ok: true, expiresAtUnix: Math.floor(Date.parse(full) / 1000) });
  // Still refuses to mint a session that would outlive its own claim.
  assert.deepEqual(
    resolveAnnualSessionExpiry({
      pendingExpiresAt: new Date(T0 + 60_000).toISOString(), nowMs: T0, sessionAlreadyLinked: false }),
    { ok: false, reason: "claim_too_short" });
  // The bounds the database enforces are unchanged.
  assert.match(WRITER, /p_pending_expires_at <= pg_catalog\.now\(\)/);
  assert.match(WRITER, /make_interval\(hours => 24\)/);
});

test("17: an ambiguous Stripe error still releases nothing", () => {
  // Unchanged from 067 and deliberately so: a timeout or a 5xx may have
  // created a session anyway, and releasing on one would permit a second
  // payable session beside it. The bound on the wait is the claim.
  assert.ok(!/release_pending_annual|release_annual|clear_annual_claim/.test(M068),
    "068 ships a release path that could race a created session");
  assert.ok(!/\.delete\(\)/.test(CHECKOUT_DEPS), "the checkout deletes a row on failure");
  assert.match(CHECKOUT, /idempotencyKey: annualCheckoutIdempotencyKey\(attempt\.id\)/);
});

/* ══════════════════════════════════════════════════════════════
   18-24. NOTHING COMMERCIAL OR UPGRADE-RELATED MOVED
   ══════════════════════════════════════════════════════════════ */

test("18: ordinary annual pricing is untouched", () => {
  for (const forbidden of ["catalog_unit_gross_cents =", "annual_unit_gross_cents =",
                           "total_gross_cents =", "merchandise_total_gross_cents ="]) {
    assert.ok(!M068.includes(forbidden), `068 writes ${forbidden}`);
  }
  // The writer still computes the totals itself and still refuses unless
  // they equal the attempt's frozen expectation.
  assert.match(WRITER, /v_merch := p_annual_unit_gross_cents \* v_count;/);
  assert.match(WRITER, /'result', 'total_mismatch'/);
});

test("19: thirteen deliveries, unchanged", () => {
  assert.match(WRITER, /v_count := 13;/);
  assert.ok(!/delivery_count\s*=\s*\d/.test(M068), "068 writes a delivery count");
});

test("20: the annual discount is unchanged", () => {
  assert.ok(!/discount_percent_applied\s*=/.test(M068), "068 writes a discount");
  assert.match(WRITER, /p_discount_percent_applied/);
  const rules = read("lib/annualPlanRules.ts");
  assert.ok(!rules.includes("pending_expires_at"), "the pricing leaf learned about the claim");
});

test("21: the 28-day cadence and the term are unchanged", () => {
  // Both live in activation, which 068 does not touch at all.
  assert.ok(!/make_interval\(hours => 672/.test(M068), "068 writes a delivery cadence");
  assert.ok(!/make_interval\(hours => 8736/.test(M068), "068 writes a plan term");
  assert.match(M067, /make_interval\(hours => 672 \* \(n - 1\)\)/);
  assert.match(M067, /make_interval\(hours => 8736\)/);
});

test("22: subscription cancellation is unchanged", () => {
  assert.ok(!/schedule_subscription_cancellation/.test(M068));
  for (const forbidden of ["cancellation_effective_at =", "cancel_at =", "cancelled_at ="]) {
    assert.ok(!M068.includes(forbidden), `068 writes ${forbidden}`);
  }
  // 068 only LOCKS the subscription row, and only on the upgrade path.
  assert.ok(!/update public\.subscriptions|insert into public\.subscriptions|alter table public\.subscriptions/.test(M068));
});

test("23: the upgrade transition is unchanged", () => {
  // Every 066/067 promise about the handover lives in activation or in
  // lib/subscriptionUpgrade.ts, and 068 touches neither.
  assert.ok(!/schedule_anchor_at/.test(WRITER), "the writer learned about the anchor");
  assert.match(M066, /add constraint annual_plans_anchor_requires_source_check/);
  assert.match(M066, /add constraint annual_plans_anchor_requires_purchase_check/);
  // 068 does not drop or weaken either of 066's constraints or its index.
  for (const kept of ["annual_plans_anchor_requires_source_check",
                      "annual_plans_anchor_requires_purchase_check",
                      "annual_plans_active_upgrade_per_subscription_key"]) {
    assert.ok(!EXEC.replace(/^--.*$/gm, "").includes(kept), `068 touches ${kept}`);
  }
  assert.ok(!/drop index/i.test(M068), "068 drops an index");
  // Exactly one constraint is dropped, and it is 067's claim shape.
  const drops = EXEC.match(/drop constraint \w+/g) || [];
  assert.deepEqual(drops, ["drop constraint annual_plans_pending_claim_shape_check"]);
  const upgrade = read("lib/subscriptionUpgrade.ts");
  assert.ok(!upgrade.includes("pending_expires_at") && !upgrade.includes("annual_checkout_already_pending"));
});

test("24: the browser's grants did not move", () => {
  assert.ok(!/grant select/.test(M068), "068 widens what the browser can read");
  assert.ok(!/grant |revoke /.test(EXEC.replace(/^--.*$/gm, "")),
    "068 changes a privilege");
  assert.ok(!read("lib/annualPlanAccount.ts").includes("pending_expires_at"));
  assert.ok(!read("app/AccountPortal.tsx").includes("pending_expires_at"));
});

/* ══════════════════════════════════════════════════════════════
   25. THE SUITE, AND THE ROLLOUT PROPERTY THAT MAKES 068 SAFE
   ══════════════════════════════════════════════════════════════ */

test("25: no Stripe, Supabase or production credential is reachable from this suite", () => {
  const self = read("tests/annual-plan-customer-claim.test.mjs");
  for (const forbidden of [
    "sk_" + "live", "pk_" + "live", "supabase" + ".co", "SUPABASE_SERVICE_" + "ROLE_KEY",
    "STRIPE_SECRET_" + "KEY", "process." + "env", "fetch" + "(", "http" + "s://",
  ]) {
    assert.ok(!self.includes(forbidden), `the suite references ${forbidden}`);
  }
});

test("25b: 068 is applicable BEFORE its code ships - the rollout property", () => {
  // THE SIGNATURE IS IDENTICAL to 067's, so the running application keeps
  // resolving to it. No DROP, so every grant survives.
  assert.ok(!/drop function public\.create_pending_annual_plan_for_attempt/.test(M068),
    "068 drops the writer, which would break the running application mid-migration");
  assert.match(M068, /create or replace function public\.create_pending_annual_plan_for_attempt\(/);
  assert.match(M068, /p_source_subscription_id\s+uuid,\s*\n\s*p_pending_expires_at\s+timestamptz\s*\n\)/);
  // A NULL claim is still accepted, which is what the pre-068
  // application sends for every ordinary purchase.
  assert.ok(!/'result', 'claim_not_expected'/.test(WRITER),
    "068 refuses the call shape the running application still makes");
  assert.match(WRITER, /if p_pending_expires_at is not null\s*\n\s*and \(p_pending_expires_at <= pg_catalog\.now\(\)/);
  // The new CHECK is strictly weaker than the one it replaces, so no row
  // the old code writes can violate it.
  assert.match(M068, /check \(pending_expires_at is null or status = 'pending'\)/);
  assert.match(M067, /or \(status = 'pending' and source_subscription_id is not null\)/);
  // One transaction, no backfill, no historical row touched.
  assert.equal((M068.match(/^begin;$/gm) || []).length, 1);
  assert.equal((M068.match(/^commit;$/gm) || []).length, 1);
  assert.ok(!/update public\.annual_plans/.test(EXEC), "068 rewrites existing rows");
  assert.ok(!/delete from/.test(M068));
});

test("25c: 068 is the newest migration and owns its number alone", () => {
  const files = readdirSync(path.join(ROOT, "supabase/migrations"))
    .filter(f => f.endsWith(".sql")).sort();
  assert.equal(files.at(-5), "068_annual_plan_customer_claim.sql");
  assert.equal(files.filter(f => f.startsWith("068")).length, 1);
  assert.equal(files.filter(f => Number(f.slice(0, 3)) > 72).length, 0);
  assert.match(M068, /NOT YET APPLIED/);
});
