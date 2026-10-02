import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ANNUAL_PENDING_PLAN_CONFLICT_RESULTS,
  ANNUAL_UPGRADE_CLAIM_CONFLICT,
  ANNUAL_UPGRADE_CLAIM_TTL_MS,
  STRIPE_MIN_CHECKOUT_LIFETIME_MS,
  annualCheckoutIdempotencyKey,
  annualPendingPlanFailureStatus,
  annualUpgradeClaimExpiry,
  interpretPendingAnnualPlanResult,
  resolveAnnualSessionExpiry,
} from "../lib/annualPlanCheckoutRules.ts";
import { UPGRADE_ALREADY_PENDING } from "../lib/subscriptionUpgradeRules.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf8");

const M066 = read("supabase/migrations/066_annual_plan_subscription_transition.sql");
const M067 = read("supabase/migrations/067_annual_upgrade_pending_claim.sql");
const CHECKOUT = read("lib/annualPlanCheckout.ts");
const CHECKOUT_DEPS = read("lib/annualPlanCheckoutDeps.ts");
const RULES = read("lib/annualPlanCheckoutRules.ts");

/** The writer 067 installs, isolated from the activation function below it. */
const WRITER = M067.slice(
  M067.indexOf("create or replace function public.create_pending_annual_plan_for_attempt"),
  M067.indexOf("-- 5. ACTIVATION RELEASES THE CLAIM"));
/** The activation function 067 replaces. */
const ACTIVATION = M067.slice(M067.indexOf("-- 5. ACTIVATION RELEASES THE CLAIM"));

const T0 = Date.parse("2026-09-29T12:00:00.000Z");

/* ══════════════════════════════════════════════════════════════
   1-3. THE CLAIM, AND THE ONE CLOCK IT SHARES WITH STRIPE
   ══════════════════════════════════════════════════════════════ */

test("1: the first upgrade checkout creates a pending claim, before Stripe", () => {
  // The claim is written by the SAME call that creates the plan, and
  // that call is the one that happens before Stripe is contacted - which
  // migration 039's own guard already enforces by refusing any attempt
  // that has a Stripe id on it.
  assert.match(WRITER, /p_pending_expires_at\s+timestamptz/);
  assert.match(WRITER, /pending_expires_at\n\s*\) values/);
  assert.match(WRITER, /'result', 'attempt_not_pre_stripe'/);
  // And the route passes it in the same object as the source.
  // MIGRATION 068 widened this from "only an upgrade" to every annual
  // checkout, so the conditional this used to assert is gone; the claim
  // is now unconditional and the upgrade is one of its cases.
  assert.match(CHECKOUT, /pendingExpiresAt: claimExpiry,/);
  assert.match(CHECKOUT_DEPS, /p_pending_expires_at: input\.pendingExpiresAt,/);
  // The RPC call precedes every Stripe line in the file.
  assert.ok(CHECKOUT.indexOf("deps.createPendingPlan(") < CHECKOUT.indexOf("deps.getStripe()"),
    "the plan is created after Stripe is contacted");
});

test("2: the claim window is thirty minutes - Stripe's own floor, not a taste", () => {
  assert.equal(ANNUAL_UPGRADE_CLAIM_TTL_MS, 30 * 60 * 1000);
  assert.equal(STRIPE_MIN_CHECKOUT_LIFETIME_MS, 30 * 60 * 1000);
  // Always in the future, and exactly one TTL from the instant it is given.
  const minted = annualUpgradeClaimExpiry(new Date(T0));
  assert.equal(Date.parse(minted) - T0, ANNUAL_UPGRADE_CLAIM_TTL_MS);
  assert.ok(Date.parse(minted) > T0);
  // The database refuses a window it did not expect, in both directions,
  // and refuses one longer than a Stripe session may live at all.
  assert.match(WRITER, /'result', 'claim_not_expected'/);
  assert.match(WRITER, /'result', 'claim_expiry_invalid'/);
  assert.match(WRITER, /p_pending_expires_at <= pg_catalog\.now\(\)/);
  assert.match(WRITER, /p_pending_expires_at > pg_catalog\.now\(\) \+ pg_catalog\.make_interval\(hours => 24\)/);
});

test("3: the Stripe session is given the SAME instant the claim holds", () => {
  // ONE VALUE, and it is the row's: resolveAnnualSessionExpiry is fed
  // pending.pendingExpiresAt, which is what the writer answered with.
  assert.match(CHECKOUT, /pendingExpiresAt: pending\.pendingExpiresAt,/);
  // MIGRATION 068: every annual session carries it, not only an upgrade's.
  assert.match(CHECKOUT, /expires_at: annualExpiresAt,/);
  // Floored to the second, so it can never round up past the claim.
  const full = annualUpgradeClaimExpiry(new Date(T0));
  assert.deepEqual(
    resolveAnnualSessionExpiry({ pendingExpiresAt: full, nowMs: T0, sessionAlreadyLinked: false }),
    { ok: true, expiresAtUnix: Math.floor(Date.parse(full) / 1000) });
  assert.equal(Math.floor(Date.parse(full) / 1000) * 1000 <= Date.parse(full), true);
  // The route reads a clock EXACTLY once per request; everything else is
  // derived from that reading or from the database's answer.
  assert.equal((CHECKOUT.match(/deps\.now \? deps\.now\(\) : new Date\(\)/g) || []).length, 1);
  assert.ok(!/Date\.now\(\)/.test(CHECKOUT), "the route reads a second clock");
});

test("3b: the retry uses the STORED expiry, not a fresh computation", () => {
  // The writer answers with pending_expires_at on 'existing' as well as
  // on 'created', which is the whole reason a retry cannot drift.
  // THREE RETURNS CARRY IT: 'created', the early 'existing', and the
  // 'existing' the unique_violation handler falls back to. A retry that
  // lands on any of them gets the row's own value rather than a new one.
  assert.equal((WRITER.match(/'pending_expires_at', v_plan\.pending_expires_at/g) || []).length, 3);
  const existing = interpretPendingAnnualPlanResult({
    result: "existing",
    annual_plan_id: "66666666-7777-8888-9999-aaaaaaaaaaa1",
    status: "pending",
    pending_expires_at: "2026-09-29T12:11:00.000Z",
  });
  assert.equal(existing.ok, true);
  assert.equal(existing.created, false);
  assert.equal(existing.pendingExpiresAt, "2026-09-29T12:11:00.000Z");
  // An ordinary purchase carries none, and a malformed one is never guessed.
  assert.equal(interpretPendingAnnualPlanResult({
    result: "created", annual_plan_id: "66666666-7777-8888-9999-aaaaaaaaaaa1",
  }).pendingExpiresAt, null);
  assert.equal(interpretPendingAnnualPlanResult({
    result: "created", annual_plan_id: "66666666-7777-8888-9999-aaaaaaaaaaa1",
    pending_expires_at: "not-a-date",
  }).pendingExpiresAt, null);
});

/* ══════════════════════════════════════════════════════════════
   4-7. THE SECOND TAB IS REFUSED BEFORE STRIPE
   ══════════════════════════════════════════════════════════════ */

test("4: a second upgrade while a claim is live is refused, as a 409", () => {
  assert.equal(ANNUAL_UPGRADE_CLAIM_CONFLICT, "upgrade_already_pending");
  assert.match(WRITER, /'result', 'upgrade_already_pending'/);
  // A statement about the customer's own state, so it is a conflict and
  // not an outage: a 503 would invite the browser to retry immediately.
  assert.ok(ANNUAL_PENDING_PLAN_CONFLICT_RESULTS.includes(ANNUAL_UPGRADE_CLAIM_CONFLICT));
  assert.equal(annualPendingPlanFailureStatus(ANNUAL_UPGRADE_CLAIM_CONFLICT), 409);
  // With its own sentence, naming both ways out.
  assert.match(CHECKOUT, /return fail\(409, UPGRADE_ALREADY_PENDING\);/);
  assert.match(UPGRADE_ALREADY_PENDING, /offenen Wechsel zum Jahresplan/);
  assert.match(UPGRADE_ALREADY_PENDING, /Schließe den bestehenden Checkout ab oder versuche es später erneut\./);
  // And it names no date, no plan id and no amount.
  assert.ok(!/\d{4}-\d{2}-\d{2}|EUR|€/.test(UPGRADE_ALREADY_PENDING));
});

test("5: the refused second request cannot reach Stripe at all", () => {
  // THE ORDERING IS THE PROOF. The refusal returns from the function
  // before the first line that could contact Stripe, so no second
  // payable session can come into existence on this path.
  const refusal = CHECKOUT.indexOf("if (pending.reason === ANNUAL_UPGRADE_CLAIM_CONFLICT) {");
  const refusalReturn = CHECKOUT.indexOf("return fail(409, UPGRADE_ALREADY_PENDING);", refusal);
  const getStripe = CHECKOUT.indexOf("const stripe = deps.getStripe();");
  const createSession = CHECKOUT.indexOf("stripe.checkout.sessions.create(");
  assert.ok(refusal > 0 && getStripe > 0 && createSession > 0);
  assert.ok(refusalReturn < getStripe, "the claim refusal returns after Stripe is resolved");
  assert.ok(refusalReturn < createSession, "the claim refusal returns after a session is created");
  // Nothing is written on the way out either: no link, no cancellation.
  const between = CHECKOUT.slice(refusal, refusalReturn);
  assert.ok(!/deps\.linkSession|scheduleAtStripe|cancel/.test(between));
  // And the writer creates NOTHING when it answers that word - the
  // refusal returns before the insert.
  assert.ok(WRITER.indexOf("'result', 'upgrade_already_pending'")
            < WRITER.indexOf("insert into public.annual_plans"),
    "the writer inserts before it refuses");
});

test("6: two concurrent requests serialize on the subscription's row lock", () => {
  // The lock is taken BEFORE the claim question is asked. Without that
  // ordering both tabs would read 'no live claim' and both proceed,
  // which is the race one table earlier.
  const lock = WRITER.indexOf("for update;");
  const subSelect = WRITER.indexOf("from public.subscriptions");
  const claimQuestion = WRITER.indexOf("and pending_expires_at > pg_catalog.now()");
  assert.ok(subSelect > 0 && claimQuestion > 0);
  const subLock = WRITER.indexOf("for update", subSelect);
  assert.ok(subLock < claimQuestion, "the claim is decided before the subscription is locked");
  assert.match(WRITER, /where id = p_source_subscription_id\s+and user_id = p_user_id\s+for update;/);
  // The attempt is locked first and the subscription second, in this one
  // function and nowhere else, so two upgrade requests contend on the
  // subscription alone and cannot deadlock.
  assert.ok(lock > 0 && lock < subLock, "the attempt is not locked first");
  // The route holds no lock and decides nothing of its own.
  assert.ok(!/SELECT .* FOR UPDATE|for update/i.test(CHECKOUT));
});

test("7: a different requestId does not bypass the claim", () => {
  // Two request ids give two attempts, two fingerprints and two Stripe
  // idempotency keys. The claim depends on none of them: it is keyed on
  // the SUBSCRIPTION, which is the thing that may be upgraded once.
  assert.notEqual(
    annualCheckoutIdempotencyKey("55555555-6666-7777-8888-999999999991"),
    annualCheckoutIdempotencyKey("55555555-6666-7777-8888-999999999992"));
  assert.match(WRITER, /where source_subscription_id = p_source_subscription_id/);
  // It excludes only this checkout's OWN attempt, so a retry is never
  // blocked by the claim it created itself.
  assert.match(WRITER, /payment_checkout_attempt_id is distinct from p_checkout_attempt_id/);
  // And the 'existing' short-circuit is above the claim question, so the
  // retry never even reaches it.
  assert.ok(WRITER.indexOf("'result', 'existing'") < WRITER.indexOf("'result', 'upgrade_already_pending'"));
});

/* ══════════════════════════════════════════════════════════════
   8-10. EXPIRY, ABANDONMENT, AND A STRIPE FAILURE
   ══════════════════════════════════════════════════════════════ */

test("8: an expired claim does not block a new attempt, and no job makes that true", () => {
  // Correctness is the PREDICATE's. Only a row whose expiry is still in
  // the future counts, so an abandoned checkout stops blocking the
  // moment it lapses - with no sweep, no cron and no webhook involved.
  assert.match(WRITER, /and pending_expires_at > pg_catalog\.now\(\)/);
  assert.ok(!/delete from public\.annual_plans/.test(M067),
    "067 deletes rows; an expired claim must simply stop counting");
  assert.ok(!/pg_cron|cron\.schedule/.test(M067), "067 depends on a scheduler");
  // The index that serves the predicate is partial and NOT unique - a
  // unique index cannot say "unique among the unexpired" and would
  // reinstate the permanent veto this design exists to avoid.
  const idx = M067.slice(M067.indexOf("create index annual_plans_pending_upgrade_claim_idx"));
  assert.ok(!/unique/i.test(idx.slice(0, 260)));
  assert.match(idx, /where source_subscription_id is not null\s*\n\s*and status = 'pending';/);
});

test("9: an abandoned checkout becomes retryable once the window passes", () => {
  // Same customer, same subscription, a fresh request id after the lapse:
  // the predicate no longer sees a live claim, so the writer creates one.
  // The bound on the wait is the TTL and nothing longer.
  const abandonedAt = T0;
  const lapses = Date.parse(annualUpgradeClaimExpiry(new Date(abandonedAt)));
  assert.equal(lapses - abandonedAt, ANNUAL_UPGRADE_CLAIM_TTL_MS);
  // A fresh checkout one millisecond later gets a full window of its own.
  const next = annualUpgradeClaimExpiry(new Date(lapses + 1));
  assert.equal(Date.parse(next) - (lapses + 1), ANNUAL_UPGRADE_CLAIM_TTL_MS);
  // Nothing in the code path shortens or extends an existing claim.
  assert.ok(!/update public\.annual_plans\s+set pending_expires_at/.test(WRITER),
    "the writer moves an existing claim");
});

test("10: a Stripe failure cannot lock the customer out beyond the claim", () => {
  // THE CLAIM IS NEVER RELEASED ON A FAILURE, and that is deliberate.
  // An ambiguous Stripe error - a timeout, a 5xx - may have created a
  // session anyway; releasing on one would allow a second payable
  // session beside it, which is the exact hole this migration closes.
  // So the bound on the customer's wait is the claim, which is exactly
  // as long as any session Stripe may have made can still be paid.
  assert.ok(!/release_pending_annual|release_annual_upgrade_claim/.test(M067),
    "067 ships a release path that could race a created session");
  assert.ok(!/pendingExpiresAt: null,\s*\n\s*\}\);[\s\S]{0,200}catch/.test(CHECKOUT));
  // The same request id converges instead of waiting at all: the attempt
  // is reused, the writer answers 'existing', and the Stripe idempotency
  // key - derived from the attempt, not from a clock - replays the one
  // session rather than opening a second.
  assert.match(CHECKOUT, /idempotencyKey: annualCheckoutIdempotencyKey\(attempt\.id\)/);
  assert.equal(annualCheckoutIdempotencyKey("55555555-6666-7777-8888-999999999991"),
    "gloa-annual-checkout-55555555-6666-7777-8888-999999999991");
  // And a failed session creation deletes nothing: the attempt and the
  // pending plan both survive as evidence.
  assert.ok(!/\.delete\(\)/.test(CHECKOUT_DEPS), "the checkout deletes a row on failure");
});

test("10b: a claim too close to lapsing refuses rather than outliving itself", () => {
  const nearly = new Date(T0 + 60 * 1000).toISOString();
  // Stripe will not accept an expires_at under thirty minutes away, so
  // any session created here could only outlive its own claim.
  assert.deepEqual(
    resolveAnnualSessionExpiry({ pendingExpiresAt: nearly, nowMs: T0, sessionAlreadyLinked: false }),
    { ok: false, reason: "claim_too_short" });
  // Unless the session already exists: that call is an idempotent replay
  // and cannot mint a second payable thing however little time is left.
  assert.deepEqual(
    resolveAnnualSessionExpiry({ pendingExpiresAt: nearly, nowMs: T0, sessionAlreadyLinked: true }),
    { ok: true, expiresAtUnix: Math.floor(Date.parse(nearly) / 1000) });
  // A missing or unparseable claim is never guessed at.
  for (const bad of [null, "", "not-a-date", undefined]) {
    assert.deepEqual(
      resolveAnnualSessionExpiry({ pendingExpiresAt: bad, nowMs: T0, sessionAlreadyLinked: false }),
      { ok: false, reason: "claim_missing" });
  }
  // The route checks the linked session rather than assuming.
  assert.match(CHECKOUT, /sessionAlreadyLinked: !!attempt\.stripe_checkout_session_id,/);
});

/* ══════════════════════════════════════════════════════════════
   11-14. SETTLEMENT KEEPS EVERY 066 PROMISE
   ══════════════════════════════════════════════════════════════ */

test("11: 067 preserves migration 066's transition algorithm exactly", () => {
  for (const kept of [
    "'result', 'anchor_not_expected'",
    "'result', 'anchor_required'",
    "'result', 'anchor_before_purchase'",
    "'result', 'anchor_conflict'",
    "'result', 'transition_conflict'",
    "make_interval(hours => 8736)",
    "make_interval(hours => 672 * (n - 1))",
  ]) {
    assert.ok(ACTIVATION.includes(kept), `067 dropped 066's ${kept}`);
    assert.ok(M066.includes(kept), `066 never had ${kept}`);
  }
  // Thirteen deliveries, still asserted after the insert.
  assert.match(ACTIVATION, /v_created <> v_plan\.delivery_count/);
  assert.ok(!/delivery_count\s*=\s*\d/.test(M067), "067 writes a delivery count");
  // No price, discount or cadence is written anywhere in 067.
  for (const forbidden of ["discount_percent_applied =", "annual_unit_gross_cents =",
                           "total_gross_cents =", "shipping_per_delivery_gross_cents ="]) {
    assert.ok(!M067.includes(forbidden), `067 writes ${forbidden}`);
  }
  // Migration 034's cancellation rule is not referenced at all.
  assert.ok(!/schedule_subscription_cancellation/.test(M067));
});

test("12: activation clears the claim atomically, in the status UPDATE", () => {
  const from = ACTIVATION.indexOf("update public.annual_plans");
  const to = ACTIVATION.indexOf("where id = v_plan.id", from);
  const update = ACTIVATION.slice(from, to);
  assert.ok(update.includes("status                     = 'active'"));
  assert.ok(update.includes("pending_expires_at         = null"),
    "activation does not clear the claim in the same UPDATE as the status");
  // And the CHECK makes it structural: no settled or terminal row may
  // hold a claim at all, so activation could not do otherwise.
  assert.match(M067, /pending_expires_at is null\s*\n\s*or \(status = 'pending' and source_subscription_id is not null\)/);
  // The loser of a transition conflict keeps its claim, because its
  // whole UPDATE is rolled back - nothing has to remember to release it.
  assert.ok(ACTIVATION.indexOf("'result', 'transition_conflict'") > from);
});

test("13: the webhook retry path is untouched and still idempotent", () => {
  for (const kept of ["'result', 'already_active'", "'result', 'payment_intent_conflict'",
                      "'result', 'checkout_session_conflict'", "'result', 'terminal'"]) {
    assert.ok(ACTIVATION.includes(kept), `067 lost ${kept}`);
  }
  // The already-active branch writes nothing, so a replay cannot touch
  // a claim that was already cleared by the activation it replays.
  const branch = ACTIVATION.slice(
    ACTIVATION.indexOf("if v_plan.status = 'active' then"),
    ACTIVATION.indexOf("select * into v_attempt"));
  assert.ok(!/update |insert /.test(branch), "the idempotent replay branch writes");
  // And no webhook module learned about the claim - only the database
  // knows, which is what keeps the settlement path unchanged.
  for (const mod of ["lib/annualPlanWebhook.ts", "lib/annualPlanWebhookDeps.ts",
                     "lib/annualPlanWebhookRules.ts", "lib/subscriptionUpgrade.ts"]) {
    assert.ok(!read(mod).includes("pending_expires_at"), `${mod} reads the claim`);
    assert.ok(!read(mod).includes("pendingExpiresAt"), `${mod} reads the claim`);
  }
  // activate_annual_plan_from_payment keeps 066's signature exactly, so
  // no caller has to change and its grants survive the replace.
  assert.match(ACTIVATION, /create or replace function public\.activate_annual_plan_from_payment\(/);
  assert.ok(!/drop function public\.activate_annual_plan_from_payment/.test(M067),
    "067 drops the activation function and would lose its grants");
});

test("14: migration 066's active-only backstop is neither weakened nor re-created", () => {
  const executable = M067.slice(0, M067.indexOf("-- 8. VERIFY"));
  assert.ok(!/annual_plans_active_upgrade_per_subscription_key/.test(
    executable.replace(/^--.*$/gm, "")),
    "067 touches 066's unique index");
  assert.ok(!/drop index/i.test(M067), "067 drops an index");
  assert.ok(!/alter table public\.annual_plans\s+drop constraint/i.test(M067),
    "067 drops a constraint");
  // 066's index is still the thing that refuses the second settlement.
  assert.match(M066, /create unique index annual_plans_active_upgrade_per_subscription_key/);
  assert.match(ACTIVATION, /when unique_violation then/);
});

/* ══════════════════════════════════════════════════════════════
   15-19. NOTHING ELSE MOVED
   ══════════════════════════════════════════════════════════════ */

test("15: 067's upgrade-specific claim semantics survive migration 068", () => {
  // THIS TEST USED TO ASSERT THE OPPOSITE HALF. Until 068 an ordinary
  // annual purchase held no claim and its Stripe session carried no
  // expires_at, and 067's writer refused a claim on one outright. 068
  // deliberately reversed all three - the duplicate-charge race on the
  // ordinary path is exactly what it exists to close - so what is
  // asserted here now is the part 067 owns and still owns.
  //
  // 067's FILE is unchanged and still says what it always said.
  assert.match(WRITER, /'result', 'claim_not_expected'/);
  assert.match(WRITER, /if p_source_subscription_id is null then/);
  // And the upgrade's own narrower guarantee - one upgrade checkout per
  // SUBSCRIPTION - is still enforced, by its own predicate, on top of
  // the customer-level one 068 added.
  assert.match(WRITER, /where source_subscription_id = p_source_subscription_id/);
  assert.ok(ANNUAL_PENDING_PLAN_CONFLICT_RESULTS.includes("upgrade_already_pending"));
  // The live 068 writer keeps that check rather than absorbing it.
  const m068 = read("supabase/migrations/068_annual_plan_customer_claim.sql");
  assert.match(m068, /'result', 'upgrade_already_pending'/);
  assert.match(m068, /where source_subscription_id = p_source_subscription_id/);
});

test("16: the 4-week subscription purchase is untouched", () => {
  for (const mod of ["lib/subscriptionCheckout.ts", "lib/subscriptionCheckoutRules.ts"]) {
    const src = read(mod);
    for (const word of ["pending_expires_at", "pendingExpiresAt", "upgrade_already_pending"]) {
      assert.ok(!src.includes(word), `${mod} learned ${word}`);
    }
  }
  // 067 only LOCKS the subscription row; it writes no subscription column.
  assert.ok(!/update public\.subscriptions/.test(M067), "067 writes to subscriptions");
  assert.ok(!/insert into public\.subscriptions/.test(M067));
  // No subscription table, policy or grant is altered.
  assert.ok(!/alter table public\.subscriptions/.test(M067));
});

test("17: no cancellation, refund or delivery rule is changed", () => {
  for (const forbidden of [
    "cancellation_effective_at =", "cancel_at =", "cancelled_at =",
    "refunded_total_cents =", "payment_status             = 'refunded'",
  ]) {
    assert.ok(!M067.includes(forbidden), `067 writes ${forbidden}`);
  }
  assert.ok(!/complete_due_annual_plans|claim_due_annual_plan_deliveries|record_annual_plan_refund/.test(M067),
    "067 redefines a worker or refund function");
  // The 14-day cutoff lives in TypeScript and is not imported here.
  assert.ok(!read("lib/annualPlanCheckout.ts").includes("resolveCancellationSchedule"));
});

test("18: the account's readable columns did not move", () => {
  // 041's rule is that the browser's grant list and the account's select
  // list are the same list. pending_expires_at is machinery with no
  // reader, so 067 grants nothing to a browser role at all.
  assert.ok(!/grant select/.test(M067), "067 widens what the browser can read");
  const account = read("lib/annualPlanAccount.ts");
  assert.ok(!account.includes("pending_expires_at"),
    "the account reads a column no migration granted it");
  assert.ok(!read("app/AccountPortal.tsx").includes("pending_expires_at"));
});

test("19: only service_role may execute the replaced writer", () => {
  for (const role of ["public", "anon", "authenticated"]) {
    assert.ok(M067.includes(`) from ${role};`), `067 does not revoke from ${role}`);
  }
  assert.match(M067, /grant execute on function public\.create_pending_annual_plan_for_attempt\([\s\S]*?\) to service_role;/);
  // Every function 067 writes is still SECURITY DEFINER with an empty
  // search_path, and there is no dynamic SQL anywhere in it.
  assert.equal((M067.match(/security definer set search_path = ''/g) || []).length, 2);
  assert.ok(!/execute format|execute '/i.test(M067), "067 contains dynamic SQL");
  // The route still reaches the database only through the RPC.
  assert.ok(!/from\("annual_plans"\)[\s\S]{0,40}(insert|update|delete)\(/.test(CHECKOUT_DEPS),
    "the checkout writes annual_plans directly");
});

/* ══════════════════════════════════════════════════════════════
   20. THE SUITE, AND THE MIGRATION'S OWN SAFETY
   ══════════════════════════════════════════════════════════════ */

test("20: no Stripe, Supabase or production credential is reachable from this suite", () => {
  const self = read("tests/annual-upgrade-pending-claim.test.mjs");
  // Split so the probes themselves are not what they search for.
  for (const forbidden of [
    "sk_" + "live", "pk_" + "live", "supabase" + ".co", "SUPABASE_SERVICE_" + "ROLE_KEY",
    "STRIPE_SECRET_" + "KEY", "process." + "env", "fetch" + "(",
  ]) {
    assert.ok(!self.includes(forbidden), `the suite references ${forbidden}`);
  }
  // It reads files and asserts. It opens no socket and starts no server.
  assert.ok(!self.includes("http" + "s://"), "the suite names a network URL");
});

test("20b: migration 067 is written, self-contained and NOT applied", () => {
  assert.match(M067, /NOT YET APPLIED/);
  // One transaction, so a failure anywhere leaves the schema as it was.
  assert.equal((M067.match(/^begin;$/gm) || []).length, 1);
  assert.equal((M067.match(/^commit;$/gm) || []).length, 1);
  assert.ok(!/^rollback;$/m.test(M067));
  // It adds exactly one column and backfills nothing.
  assert.equal((M067.match(/add column /g) || []).length, 1);
  assert.match(M067, /add column pending_expires_at timestamptz;/);
  assert.ok(!/update public\.annual_plans\s+set pending_expires_at\s*=\s*(?!null)/.test(
    M067.slice(0, M067.indexOf("-- 5. ACTIVATION"))), "067 backfills the new column");
  // It is the newest migration and owns its number alone.
  const files = readdirSync(path.join(ROOT, "supabase/migrations"))
    .filter(f => f.endsWith(".sql")).sort();
  assert.equal(files.at(-6), "067_annual_upgrade_pending_claim.sql");
  assert.equal(files.filter(f => f.startsWith("067")).length, 1);
  assert.equal(files.filter(f => Number(f.slice(0, 3)) > 72).length, 0);
});

test("20c: the rules leaf stays pure - no clock, no env, no Stripe import", () => {
  assert.ok(!/new Date\(\)/.test(RULES), "the rules leaf reads a clock of its own");
  assert.ok(!/Date\.now\(\)/.test(RULES), "the rules leaf reads a clock of its own");
  assert.ok(!/process\.env/.test(RULES));
  // Stripe appears only as a TYPE import, which is erased at runtime -
  // the leaf pulls in no SDK, opens no client and reads no key.
  for (const line of RULES.split("\n").filter(l => /^import\b/.test(l) && /stripe/i.test(l))) {
    assert.match(line, /^import type /, `the rules leaf imports Stripe at runtime: ${line}`);
  }
  // The clock is injected, so the whole window is testable to the ms.
  assert.match(CHECKOUT, /now\?: \(\) => Date;/);
});
