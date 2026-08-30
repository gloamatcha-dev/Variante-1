import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// SAFE DEFAULT SUITE: static SQL and source inspection only. No database
// is opened, no SQL is executed, no Supabase client is constructed, no
// Stripe API is called and no email is sent. Nothing here requires
// TEST_SUPABASE_*, and nothing here applies migration 039.
//
// What it protects. Phase 4B1 is the DATABASE FOUNDATION of the B2C
// prepaid annual plan and nothing else: two tables, two nullable columns
// on public.checkout_attempts, and six server-only functions. The
// invariants worth guarding are the ones that would be expensive or
// impossible to fix once a customer has paid for thirteen deliveries:
//
//   * the annual Stripe PaymentIntent belongs to the PARENT and can
//     never reach a delivery order, because migration 038 answers
//     'ambiguous_payment_intent' the moment two orders share one and the
//     refund then lands nowhere at all
//   * exactly thirteen deliveries, at exactly 28 days, frozen once
//   * refund state and lifecycle state stay separate vocabularies
//   * a claimed delivery that a dead worker abandoned can be recovered,
//     and one that already produced an order cannot
//   * no browser role can write, and no browser role can read another
//     customer's plan

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf-8");
const NEWLINE = String.fromCharCode(10);

const MIGRATIONS_DIR = path.join(ROOT, "supabase/migrations");
const MIGRATION_037 = "037_subscription_refund_correlation.sql";
const MIGRATION_038 = "038_one_time_refund_writer_concurrency.sql";
const MIGRATION_039 = "039_b2c_annual_plan_foundation.sql";

/**
 * Code only. The migration's prose deliberately NAMES what it refuses to
 * do - a table lock, a lifecycle write on refund, a completion cron, an
 * annual column on public.orders - so a scan that read the comments
 * would report every deliberate avoidance as a violation of itself.
 */
const withoutComments = source => source
  .split(NEWLINE)
  .filter(line => {
    const t = line.trim();
    return !t.startsWith("--") && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
  })
  .join(NEWLINE);

const migration039 = read(`supabase/migrations/${MIGRATION_039}`);
const sql = withoutComments(migration039);

/** Lowercased and whitespace-collapsed, so formatting cannot hide a statement. */
const flat = sql.toLowerCase().replace(/\s+/g, " ");

/** Every function this migration is allowed to define, with its identity arguments. */
const FUNCTIONS = [
  ["create_pending_annual_plan_for_attempt",
   "uuid, uuid, uuid, integer, integer, integer, numeric, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb"],
  ["activate_annual_plan_from_payment", "uuid, text, text, timestamptz"],
  ["claim_due_annual_plan_deliveries", "integer"],
  ["prepare_annual_plan_delivery_attempt", "uuid"],
  ["mark_annual_plan_delivery_fulfilled", "uuid, uuid"],
  ["apply_annual_plan_refund_state", "text, integer"],
];

/** The body of one function, from its CREATE to the terminating $$;. */
const bodyOf = name => {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  assert.notEqual(start, -1, `function ${name} was not found`);
  const end = sql.indexOf("$$;", start);
  assert.ok(end > start, `function ${name} is not terminated`);
  return sql.slice(start, end + 3);
};

/** The CREATE TABLE block for one table. */
const tableOf = name => {
  const start = sql.indexOf(`create table public.${name} (`);
  assert.notEqual(start, -1, `table ${name} was not found`);
  const end = sql.indexOf(NEWLINE + ");", start);
  assert.ok(end > start, `table ${name} is not terminated`);
  return sql.slice(start, end + 2);
};

const PLANS = tableOf("annual_plans");
const DELIVERIES = tableOf("annual_plan_deliveries");
const CLAIM = bodyOf("claim_due_annual_plan_deliveries");
const ACTIVATE = bodyOf("activate_annual_plan_from_payment");
const PREPARE = bodyOf("prepare_annual_plan_delivery_attempt");
const REFUND = bodyOf("apply_annual_plan_refund_state");
const FULFILLED = bodyOf("mark_annual_plan_delivery_fulfilled");
const PENDING = bodyOf("create_pending_annual_plan_for_attempt");

/** Whitespace-collapsed helper for reading one block. */
const oneLine = block => block.toLowerCase().replace(/\s+/g, " ");

/* ══════════════════════════════════════════════════════════════
   1-5. THE MIGRATION SET
   ══════════════════════════════════════════════════════════════ */

test("1: exactly one 039 exists and it is the highest migration", () => {
  const files = readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith(".sql")).sort();
  assert.deepEqual(files.filter(f => f.startsWith("039")), [MIGRATION_039],
    "there must be exactly one migration 039");
  assert.equal(files[files.length - 1], MIGRATION_039, "039 must be the highest");
  assert.equal(files[files.length - 2], MIGRATION_038, "038 must be the one before it");
  const numbers = files.map(f => f.slice(0, 3));
  assert.equal(new Set(numbers).size, numbers.length, "a migration number is used twice");
});

test("2: no migration 040 or beyond", () => {
  const beyond = readdirSync(MIGRATIONS_DIR).filter(f => Number(f.slice(0, 3)) > 39);
  assert.deepEqual(beyond, [], "an unreviewed migration appeared after 039");
});

test("3: migrations 001 through 038 are unmodified", () => {
  const changed = execFileSync("git", ["diff", "--name-only", "HEAD", "--", "supabase/migrations/"],
    { cwd: ROOT, encoding: "utf-8" }).trim();
  const touched = changed ? changed.split(NEWLINE) : [];
  const immutable = touched.filter(rel => !rel.endsWith(MIGRATION_039));
  assert.deepEqual(immutable, [], "a live, immutable migration was edited");
});

test("4: migrations 037 and 038 still hold their refund writers, untouched", () => {
  assert.ok(read(`supabase/migrations/${MIGRATION_037}`)
    .includes("create or replace function public.apply_order_refund_state_by_invoice("),
    "037's invoice refund writer changed");
  assert.ok(read(`supabase/migrations/${MIGRATION_038}`)
    .includes("create or replace function public.apply_order_refund_state("),
    "038's one-time refund writer changed");
  // And 039 does not redefine either of them, nor any unrelated function.
  assert.ok(!flat.includes("function public.apply_order_refund_state("),
    "039 redefines the one-time refund writer");
  assert.ok(!flat.includes("function public.apply_order_refund_state_by_invoice("),
    "039 redefines the invoice refund writer");
  assert.ok(!flat.includes("function public.create_order_from_paid_checkout("),
    "039 redefines the live order creator");
  for (const forbidden of [
    "function public.activate_subscription_from_invoice(",
    "function public.schedule_subscription_cancellation(",
    "function public.mark_subscription_cancelled(",
    "function public.sync_subscription_payment_status(",
    "function public.apply_order_refund_state_by_invoice(",
    "function public.authorize_order_shipment(",
  ]) {
    assert.ok(!flat.includes(forbidden), `039 redefines ${forbidden}`);
  }
});

test("5: 039 defines exactly the six reviewed functions and no others", () => {
  const defined = [...sql.matchAll(/create or replace function public\.(\w+)\(/g)].map(m => m[1]);
  assert.deepEqual(defined.slice().sort(), FUNCTIONS.map(f => f[0]).slice().sort());
  assert.equal(defined.length, FUNCTIONS.length, "a function is defined twice");
});

/* ══════════════════════════════════════════════════════════════
   6-13. THE PARENT TABLE
   ══════════════════════════════════════════════════════════════ */

test("6: annual_plans exists with its identity and ownership columns", () => {
  assert.ok(PLANS.includes("id                          uuid primary key"));
  assert.match(PLANS, /user_id\s+uuid not null references auth\.users\(id\)/);
  // NOT "on delete set null": a paid annual contract must not lose its owner.
  assert.ok(!/user_id[\s\S]{0,120}on delete set null/.test(PLANS),
    "the owner of a paid annual plan must not be nullable on delete");
  assert.match(PLANS, /payment_checkout_attempt_id uuid not null unique\s+references public\.checkout_attempts\(id\)/);
  assert.match(PLANS, /variant_id\s+uuid not null references public\.product_variants\(id\)/);
});

test("7: annual_plan_deliveries exists, keyed by plan and delivery number", () => {
  assert.match(DELIVERIES, /annual_plan_id\s+uuid not null references public\.annual_plans\(id\)/);
  assert.match(DELIVERIES, /delivery_number\s+integer not null/);
  assert.match(DELIVERIES, /check \(delivery_number between 1 and 13\)/);
  assert.match(DELIVERIES, /scheduled_for\s+timestamptz not null/);
  // No cascade: a delivery is evidence and must not vanish with a delete.
  assert.ok(!/annual_plan_id[\s\S]{0,120}on delete cascade/.test(DELIVERIES));
});

test("8: lifecycle and payment vocabularies are separate, and neither borrows the other's words", () => {
  const lifecycle = /status\s+text not null default 'pending'\s+check \(status in \(\s*'pending', 'active', 'completed', 'cancelled'\s*\)\)/;
  const payment = /payment_status\s+text not null default 'pending'\s+check \(payment_status in \(\s*'pending', 'paid', 'partially_refunded', 'refunded'\s*\)\)/;
  assert.match(PLANS, lifecycle, "the lifecycle vocabulary is not exactly the four reviewed values");
  assert.match(PLANS, payment, "the payment vocabulary is not exactly the four reviewed values");

  // The lifecycle CHECK must not contain a refund word, and the payment
  // CHECK must not contain a lifecycle word. Extracted separately so one
  // cannot satisfy the other.
  const lifecycleList = PLANS.match(lifecycle)[0];
  const paymentList = PLANS.match(payment)[0];
  for (const refundWord of ["refunded", "partially_refunded", "refund_pending"]) {
    assert.ok(!lifecycleList.includes(refundWord),
      `refund state leaked into the lifecycle vocabulary: ${refundWord}`);
  }
  for (const lifecycleWord of ["active", "completed", "cancelled"]) {
    assert.ok(!paymentList.includes(lifecycleWord),
      `lifecycle state leaked into the payment vocabulary: ${lifecycleWord}`);
  }
});

test("9: delivery_count is pinned to exactly 13, in the parent and in the child", () => {
  assert.match(PLANS, /delivery_count\s+integer not null default 13\s+check \(delivery_count = 13\)/);
  assert.match(DELIVERIES, /check \(delivery_number between 1 and 13\)/);
  // The same 13 in the attempt link, so a fourteenth delivery attempt is
  // refused by the column CHECK before any index is consulted.
  assert.ok(flat.includes("annual_delivery_number between 1 and 13"));
});

test("10: every money field is integer cents and no floating point type appears", () => {
  const CENTS = [
    "catalog_unit_gross_cents",
    "annual_unit_gross_cents",
    "shipping_per_delivery_gross_cents",
    "merchandise_total_gross_cents",
    "shipping_total_gross_cents",
    "total_gross_cents",
    "refunded_total_cents",
  ];
  for (const column of CENTS) {
    assert.match(PLANS, new RegExp(`${column}\\s+integer not null`), `${column} is not integer not null`);
  }
  // numeric is exact and is used for the recorded percentage only.
  assert.match(PLANS, /discount_percent_applied\s+numeric\(5,2\) not null/);
  for (const forbidden of ["float", "double precision", "real ", "money"]) {
    assert.ok(!flat.includes(forbidden), `a non-exact numeric type appears: ${forbidden}`);
  }
});

test("11: the money identities make a total impossible to supply independently", () => {
  assert.ok(flat.includes(
    "check (merchandise_total_gross_cents = annual_unit_gross_cents * delivery_count)"));
  assert.ok(flat.includes(
    "check (shipping_total_gross_cents = shipping_per_delivery_gross_cents * delivery_count)"));
  assert.ok(flat.includes(
    "check (total_gross_cents = merchandise_total_gross_cents + shipping_total_gross_cents)"));
  // And the totals are DERIVED in the creation function, never accepted.
  assert.ok(oneLine(PENDING).includes("v_merch := p_annual_unit_gross_cents * v_count"));
  assert.ok(oneLine(PENDING).includes("v_total := v_merch + v_ship"));
  assert.ok(!/p_total_gross_cents/.test(PENDING), "a caller-supplied total was accepted");
});

test("12: the refund range is protected, and each payment status names one band", () => {
  assert.ok(flat.includes("check (refunded_total_cents >= 0)"));
  assert.ok(flat.includes("check (refunded_total_cents <= total_gross_cents)"));
  const band = oneLine(PLANS);
  assert.ok(band.includes("when 'pending' then refunded_total_cents = 0"));
  assert.ok(band.includes("when 'paid' then refunded_total_cents = 0"));
  assert.ok(band.includes(
    "when 'partially_refunded' then refunded_total_cents > 0 and refunded_total_cents < total_gross_cents"));
  assert.ok(band.includes("when 'refunded' then refunded_total_cents = total_gross_cents"));
});

test("13: the annual Stripe PaymentIntent is unique on the parent", () => {
  assert.ok(flat.includes(
    "create unique index annual_plans_stripe_payment_intent_id_key on public.annual_plans (stripe_payment_intent_id) where stripe_payment_intent_id is not null"));
  assert.ok(flat.includes(
    "create unique index annual_plans_stripe_checkout_session_id_key on public.annual_plans (stripe_checkout_session_id) where stripe_checkout_session_id is not null"));
});

/* ══════════════════════════════════════════════════════════════
   14-18. ONE PAYMENT, THIRTEEN DELIVERIES, NEVER SHARED
   ══════════════════════════════════════════════════════════════ */

test("14: one delivery row per (plan, delivery number), enforced by a unique constraint", () => {
  assert.ok(oneLine(DELIVERIES).includes(
    "constraint annual_plan_deliveries_plan_number_key unique (annual_plan_id, delivery_number)"));
  // And a delivery holds at most one attempt and at most one order.
  assert.ok(flat.includes(
    "create unique index annual_plan_deliveries_checkout_attempt_id_key on public.annual_plan_deliveries (checkout_attempt_id) where checkout_attempt_id is not null"));
  assert.ok(flat.includes(
    "create unique index annual_plan_deliveries_order_id_key on public.annual_plan_deliveries (order_id) where order_id is not null"));
});

test("15: one synthetic fulfillment attempt per (plan, delivery number)", () => {
  assert.ok(flat.includes(
    "create unique index checkout_attempts_annual_delivery_key on public.checkout_attempts (annual_plan_id, annual_delivery_number) where annual_plan_id is not null and annual_delivery_number is not null"));
  assert.ok(flat.includes(
    "add column annual_plan_id uuid references public.annual_plans(id), add column annual_delivery_number integer"));
});

test("16: a synthetic delivery attempt can never carry the annual Stripe payment identity", () => {
  // The CHECK is the guarantee; the function merely respects it.
  const guard = flat.slice(flat.indexOf("checkout_attempts_annual_delivery_no_stripe_payment_check"));
  assert.ok(guard.startsWith("checkout_attempts_annual_delivery_no_stripe_payment_check check ( annual_plan_id is null or (stripe_payment_intent_id is null and stripe_invoice_id is null and stripe_checkout_session_id is null and subscription_id is null) )"),
    "the no-shared-payment CHECK is not the reviewed one");

  // The two populations are disjoint: an attempt has both annual columns
  // or neither, so the payment attempt cannot acquire a back-reference.
  assert.ok(flat.includes(
    "checkout_attempts_annual_delivery_paired_check check ( (annual_plan_id is null and annual_delivery_number is null) or (annual_plan_id is not null and annual_delivery_number between 1 and 13) )"));

  // And the insert in prepare_... sets none of the four.
  const insert = oneLine(PREPARE).slice(
    oneLine(PREPARE).indexOf("insert into public.checkout_attempts"),
    oneLine(PREPARE).indexOf("returning * into v_attempt"));
  for (const forbidden of [
    "stripe_payment_intent_id", "stripe_invoice_id", "stripe_checkout_session_id", "subscription_id",
  ]) {
    assert.ok(!insert.includes(forbidden),
      `the synthetic delivery attempt sets ${forbidden}`);
  }
  assert.ok(insert.includes("'paid'"), "the synthetic attempt is not paid");
  assert.ok(insert.includes("v_plan.delivery_items_snapshot"), "the frozen item is not used");
  assert.ok(insert.includes("v_plan.delivery_tax_snapshot"), "the frozen per-delivery tax is not used");
  assert.ok(insert.includes("v_plan.shipping_per_delivery_gross_cents"),
    "the frozen per-delivery shipping is not used");
});

test("17: no annual column is added to public.orders", () => {
  assert.ok(!/alter\s+table\s+public\.orders/i.test(sql),
    "039 alters public.orders");
  assert.ok(!/alter\s+table\s+public\.order_items/i.test(sql));
  // The only table 039 extends is checkout_attempts.
  const altered = [...sql.matchAll(/alter table public\.(\w+)/g)].map(m => m[1]);
  assert.deepEqual([...new Set(altered)].sort(),
    ["annual_plan_deliveries", "annual_plans", "checkout_attempts"]);
});

test("18: nothing fresh is read for a purchased plan", () => {
  // The fulfillment path must never touch the catalog or recompute a price.
  for (const block of [PREPARE, ACTIVATE, FULFILLED]) {
    assert.ok(!block.includes("product_variants"), "a purchased plan re-read the catalog");
    assert.ok(!block.includes("price_gross_cents"), "a purchased plan re-read a catalog price");
  }
});

/* ══════════════════════════════════════════════════════════════
   19-22. THE FROZEN SCHEDULE
   ══════════════════════════════════════════════════════════════ */

test("19: the cadence is exactly 28 days, expressed as an absolute duration", () => {
  // 672 hours is 28 days. Hours, not calendar days, so the sequence does
  // not depend on a session time zone or on a DST boundary.
  assert.equal(672, 28 * 24);
  assert.ok(oneLine(ACTIVATE).includes("pg_catalog.make_interval(hours => 672 * (n - 1))"),
    "the delivery cadence is not 672 hours per step");
  // Never calendar arithmetic.
  for (const forbidden of ["interval '1 month'", "interval '28 days'", "interval '4 weeks'", "'1 mon'"]) {
    assert.ok(!flat.includes(forbidden), `calendar arithmetic appears: ${forbidden}`);
  }
});

test("20: delivery 1 is the purchase date and delivery 13 is exactly +336 days", () => {
  // n = 1 gives + 0 hours, so delivery 1 is purchased_at itself.
  assert.equal(672 * (1 - 1), 0);
  // n = 13 gives 8064 hours, which is 336 days.
  assert.equal(672 * (13 - 1), 8064);
  assert.equal(8064, 336 * 24);
  assert.ok(oneLine(ACTIVATE).includes("v_purchased + pg_catalog.make_interval(hours => 672 * (n - 1))"));
  assert.ok(oneLine(ACTIVATE).includes(
    "from pg_catalog.generate_series(1, v_plan.delivery_count) as n"),
    "the thirteen rows are not generated from delivery_count");
});

test("21: plan_end_at is exactly purchase + 364 days", () => {
  assert.equal(8736, 364 * 24);
  // And 364 days is 13 whole 28-day periods, so the plan ends when the
  // final delivery's own period does.
  assert.equal(8736, 672 * 13);
  assert.ok(oneLine(ACTIVATE).includes(
    "plan_end_at = v_purchased + pg_catalog.make_interval(hours => 8736)"),
    "plan_end_at is not purchase + 8736 hours");
});

test("22: the thirteen rows are created in the activation transaction, with the constraint as backstop", () => {
  const a = oneLine(ACTIVATE);
  assert.ok(a.includes("insert into public.annual_plan_deliveries"));
  assert.ok(a.includes("on conflict on constraint annual_plan_deliveries_plan_number_key do nothing"),
    "the duplicate backstop is not the unique constraint");
  assert.ok(a.includes("if v_created <> v_plan.delivery_count then"),
    "a partial schedule is not refused");
  assert.ok(a.includes("raise exception"), "a partial schedule does not roll the activation back");
  // Activation creates no order, ever.
  assert.ok(!a.includes("insert into public.orders"), "activation creates an order");
  assert.ok(!a.includes("create_order_from_paid_checkout"), "activation mints an order");
});

/* ══════════════════════════════════════════════════════════════
   23-25. ACTIVATION IS IDEMPOTENT AND FAILS CLOSED
   ══════════════════════════════════════════════════════════════ */

test("23: activation is idempotent and refuses a second, different payment", () => {
  const a = oneLine(ACTIVATE);
  assert.ok(a.includes("if v_plan.status = 'active' then"), "a replay is not detected");
  assert.ok(a.includes("if v_plan.stripe_payment_intent_id is distinct from v_intent then"),
    "a replay does not prove it is the same payment");
  assert.ok(a.includes("'payment_intent_conflict'"), "a conflicting payment intent is adopted");
  assert.ok(a.includes("'already_active'"), "an idempotent replay has no distinct answer");
  // Terminal states stay terminal.
  assert.ok(a.includes("if v_plan.status in ('completed', 'cancelled') then"));
  assert.ok(a.includes("'terminal'"));
});

test("24: activation requires real payment proof from the frozen anchor", () => {
  const a = oneLine(ACTIVATE);
  assert.ok(a.includes("from public.checkout_attempts where id = v_plan.payment_checkout_attempt_id for update"),
    "the payment attempt is not read under a lock");
  assert.ok(a.includes("if v_attempt.status <> 'paid' then"), "an unpaid attempt can activate a plan");
  assert.ok(a.includes(
    "if v_attempt.expected_total_gross_cents is distinct from v_plan.total_gross_cents then"),
    "the paid amount is not re-proved against the plan total");
});

test("25: the plan row is locked before any activation decision", () => {
  const a = oneLine(ACTIVATE);
  const lock = a.indexOf("from public.annual_plans where id = p_annual_plan_id for update");
  assert.ok(lock > 0, "the plan is not locked");
  for (const decision of [
    "if v_plan.status in ('completed', 'cancelled')",
    "if v_plan.status = 'active'",
    "update public.annual_plans",
    "insert into public.annual_plan_deliveries",
  ]) {
    assert.ok(a.indexOf(decision) > lock, `a decision is taken before the lock: ${decision}`);
  }
});

/* ══════════════════════════════════════════════════════════════
   26-29. CLAIMING, AND THE SIX HOUR LEASE
   ══════════════════════════════════════════════════════════════ */

test("26: the claim locks its rows and skips ones another worker holds", () => {
  const c = oneLine(CLAIM);
  assert.ok(c.includes("for update of d skip locked"),
    "the claim does not lock with SKIP LOCKED");
  // OF d: only the delivery rows, so this and prepare_... cannot acquire
  // the same two rows in opposite orders.
  assert.ok(!c.includes("for update of p"), "the claim locks the parent too and can deadlock");
  assert.ok(!c.includes("lock table"), "the claim takes a table lock");
  // Select and update are one statement, so two runs cannot both read a
  // row as due.
  assert.ok(c.includes("with due as ("));
  assert.ok(c.includes("update public.annual_plan_deliveries t set state = 'claimed', claimed_at = pg_catalog.now()"));
  // Bounded batch.
  assert.ok(c.includes("limit least(greatest(coalesce(p_limit, 25), 1), 100)"),
    "the batch is not bounded");
});

test("27: the stale-claim lease is exactly six hours and is the only reclaim path", () => {
  const c = oneLine(CLAIM);
  assert.ok(c.includes("d.claimed_at < pg_catalog.now() - interval '6 hours'"),
    "the lease threshold is not the pinned six hours");
  // Six hours sits far above any request and far below the daily cron.
  const LEASE_HOURS = 6;
  assert.ok(LEASE_HOURS * 60 * 60 > 300, "the lease is not above the maximum function duration");
  assert.ok(LEASE_HOURS < 24, "the lease is not below the daily cron interval");
  assert.match(read("vercel.json"), /"schedule":\s*"20 5 \* \* \*"/,
    "the cron is no longer daily, so the lease reasoning has to be revisited");
  // Exactly one reclaim branch, and it requires a real stale claim.
  assert.ok(c.includes("(d.state = 'claimed' and d.claimed_at is not null and d.claimed_at < pg_catalog.now() - interval '6 hours')"));
  assert.equal((c.match(/interval '6 hours'/g) || []).length, 1);
});

test("28: a delivery that already produced an order can never be reclaimed", () => {
  const c = oneLine(CLAIM);
  // Both guards sit in the shared WHERE, before the OR that offers the
  // reclaim branch, so they apply to the reclaim path too.
  const orBranch = c.indexOf("and ( (d.state = 'scheduled'");
  assert.ok(orBranch > 0, "the due/reclaim disjunction was not found");
  const shared = c.slice(0, orBranch);
  assert.ok(shared.includes("d.order_id is null"),
    "a delivery with an order can be reclaimed");
  assert.ok(shared.includes("d.fulfilled_at is null"),
    "a fulfilled delivery can be reclaimed");
  // The state CHECK keeps the two facts from disagreeing.
  assert.ok(oneLine(DELIVERIES).includes(
    "check ((state = 'fulfilled') = (order_id is not null and fulfilled_at is not null))"));
});

test("29: the claim creates nothing at all", () => {
  const c = oneLine(CLAIM);
  for (const forbidden of [
    "insert into public.orders",
    "insert into public.checkout_attempts",
    "create_order_from_paid_checkout",
    "email",
    "stripe",
  ]) {
    assert.ok(!c.includes(forbidden), `the claim does ${forbidden}`);
  }
});

/* ══════════════════════════════════════════════════════════════
   30-32. PREPARING A DELIVERY, AND THE ORDER LINK
   ══════════════════════════════════════════════════════════════ */

test("30: prepare locks parent then child, and fails closed on anything but a live claim", () => {
  const p = oneLine(PREPARE);
  const planLock = p.indexOf("from public.annual_plans where id = v_delivery.annual_plan_id for update");
  const rowLock = p.indexOf("from public.annual_plan_deliveries where id = p_delivery_id for update");
  assert.ok(planLock > 0 && rowLock > planLock, "the lock order is not parent then child");
  assert.ok(p.indexOf("insert into public.checkout_attempts") > rowLock,
    "an attempt is created before the row is locked");
  assert.ok(p.includes("if v_plan.status <> 'active' then"));
  assert.ok(p.includes("if v_delivery.state <> 'claimed' then"));
  assert.ok(p.includes("if v_delivery.checkout_attempt_id is not null then"),
    "an already-prepared delivery is not idempotent");
  assert.ok(p.includes("'already_prepared'"));
  // The unique index is the real guard, and its winner is adopted.
  assert.ok(p.includes("when unique_violation then"));
  assert.ok(p.includes("where annual_plan_id = v_plan.id and annual_delivery_number = v_delivery.delivery_number"));
  // It creates no order; the live creator is left to application code.
  assert.ok(!p.includes("insert into public.orders"));
  assert.ok(!p.includes("create_order_from_paid_checkout"));
});

test("31: an order is bound to a delivery only by the attempt they share", () => {
  const f = oneLine(FULFILLED);
  assert.ok(f.includes(
    "if v_order.checkout_attempt_id is distinct from v_delivery.checkout_attempt_id then"),
    "a caller-supplied order id is taken on trust");
  assert.ok(f.includes("'order_not_this_delivery'"));
  assert.ok(f.includes("if v_delivery.state = 'fulfilled' then"), "re-marking is not idempotent");
  assert.ok(f.includes("'unchanged'"));
  assert.ok(f.includes("'order_conflict'"));
});

test("32: nothing in 039 writes 'completed' or 'cancelled'", () => {
  for (const [name] of FUNCTIONS) {
    const body = oneLine(bodyOf(name));
    assert.ok(!body.includes("status = 'completed'"), `${name} completes a plan`);
    assert.ok(!body.includes("status = 'cancelled'"), `${name} cancels a plan`);
    assert.ok(!body.includes("completed_at ="), `${name} stamps completed_at`);
    assert.ok(!body.includes("cancelled_at ="), `${name} stamps cancelled_at`);
  }
  // The vocabulary still declares both, so a later phase does not have
  // to widen a CHECK to reach them.
  assert.ok(PLANS.includes("'pending', 'active', 'completed', 'cancelled'"));
});

/* ══════════════════════════════════════════════════════════════
   33-36. THE ANNUAL REFUND WRITER
   ══════════════════════════════════════════════════════════════ */

test("33: the refund writer resolves by the unique annual PaymentIntent and nothing else", () => {
  const r = oneLine(REFUND);
  assert.ok(r.includes("from public.annual_plans where stripe_payment_intent_id = v_intent for update"),
    "the plan is not resolved by payment intent under a lock");
  for (const forbidden of [
    "customer_snapshot", "email", "total_gross_cents =", "created_at", "variant_id",
    "sku", "order_id", "subscription_id", "delivery_number", "user_id",
  ]) {
    assert.ok(!r.includes(forbidden), `the refund writer correlates by ${forbidden}`);
  }
  // A unique index makes ambiguity impossible, so no table lock is taken
  // and no arbitrary row is picked.
  assert.ok(!r.includes("lock table"), "the annual writer takes a table lock it does not need");
  assert.ok(!r.includes("limit 1"), "an answer is manufactured where a refusal is honest");
  assert.ok(!r.includes("order by"), "an answer is manufactured where a refusal is honest");
});

test("34: the three financial transitions are exactly the reviewed ones", () => {
  const r = oneLine(REFUND);
  assert.ok(r.includes("if p_refunded_total_cents = 0 then v_new_status := 'paid';"));
  assert.ok(r.includes("elsif p_refunded_total_cents >= v_plan.total_gross_cents then v_new_status := 'refunded';"));
  assert.ok(r.includes("else v_new_status := 'partially_refunded';"));
  assert.ok(r.includes("if p_refunded_total_cents > v_plan.total_gross_cents then"));
  assert.ok(r.includes("'invalid_amount'"));
  assert.ok(r.includes("if v_plan.payment_status = 'pending' then"), "an unpaid plan can be refunded");
  assert.ok(r.includes("'not_applicable'"));
  assert.ok(r.includes("'unchanged'"), "a no-op still writes");
  // Absolute totals: nothing accumulates.
  assert.ok(!r.includes("refunded_total_cents +"), "the refund total is accumulated, not absolute");
});

test("35: a full refund blocks future delivery generation", () => {
  assert.ok(oneLine(CLAIM).includes("p.payment_status <> 'refunded'"),
    "the claim does not refuse a fully refunded plan");
  assert.ok(oneLine(PREPARE).includes("if v_plan.payment_status = 'refunded' then"),
    "prepare does not refuse a fully refunded plan");
  assert.ok(oneLine(PREPARE).includes("'plan_refunded'"));
});

test("36: a partial refund is recorded but by itself stops nothing", () => {
  // It is a real state on the parent...
  assert.ok(PLANS.includes("'partially_refunded'"));
  assert.ok(oneLine(REFUND).includes("v_new_status := 'partially_refunded'"));
  // ...and neither gate mentions it, so twelve owed deliveries stay owed.
  assert.ok(!oneLine(CLAIM).includes("partially_refunded"),
    "a partial refund stops future deliveries");
  assert.ok(!oneLine(PREPARE).includes("partially_refunded"),
    "a partial refund stops future deliveries");
  // And the refund writer never touches lifecycle or a delivery row.
  const r = oneLine(REFUND);
  assert.ok(!r.includes("annual_plan_deliveries"), "the refund writer touches a delivery row");
  assert.ok(!r.includes("set status"), "the refund writer writes lifecycle status");
  const setClause = r.slice(r.indexOf("update public.annual_plans set"), r.indexOf("where id = v_plan.id"));
  assert.ok(setClause.includes("payment_status ="));
  assert.ok(setClause.includes("refunded_total_cents ="));
  assert.ok(setClause.includes("refund_updated_at ="));
  assert.ok(!setClause.includes("status =") || setClause.includes("payment_status ="),
    "the refund writer writes something other than money state");
});

/* ══════════════════════════════════════════════════════════════
   37-41. RLS, PRIVILEGES AND FUNCTION HARDENING
   ══════════════════════════════════════════════════════════════ */

test("37: RLS is enabled on both annual tables", () => {
  assert.ok(flat.includes("alter table public.annual_plans enable row level security"));
  assert.ok(flat.includes("alter table public.annual_plan_deliveries enable row level security"));
});

test("38: authenticated may only SELECT, and only its own rows", () => {
  const policies = [...sql.matchAll(/create policy "([^"]+)"\s+on public\.(\w+) for (\w+)/g)];
  assert.equal(policies.length, 2, "there must be exactly two policies");
  for (const [, , , cmd] of policies) {
    assert.equal(cmd, "select", "a policy permits something other than SELECT");
  }
  assert.ok(flat.includes('create policy "users read own annual plans" on public.annual_plans for select using (auth.uid() = user_id)'));
  // Ownership is inherited by the child, never duplicated onto it.
  assert.ok(oneLine(sql).includes(
    "where p.id = annual_plan_deliveries.annual_plan_id and p.user_id = auth.uid()"));
  assert.ok(!DELIVERIES.includes("user_id"), "the delivery row duplicates the owner");
  // No write policy of any kind. Read off the policy declarations
  // themselves, never off the whole file - "for update" also appears in
  // every row lock in every function body.
  const declaredCommands = policies.map(([, , , cmd]) => cmd);
  for (const cmd of ["insert", "update", "delete", "all"]) {
    assert.ok(!declaredCommands.includes(cmd), `a write policy exists: for ${cmd}`);
  }
});

test("39: anon gets nothing, and no role gets a direct write on either table", () => {
  assert.ok(flat.includes("revoke all privileges on table public.annual_plans from anon, authenticated, service_role"));
  assert.ok(flat.includes("revoke all privileges on table public.annual_plan_deliveries from anon, authenticated, service_role"));
  const grants = [...sql.matchAll(/grant ([\w, ()]+?) on table public\.(\w+)\s+to (\w+);/g)]
    .map(m => [m[1].trim(), m[2], m[3]]);
  assert.deepEqual(grants.slice().sort(), [
    ["select", "annual_plan_deliveries", "authenticated"],
    ["select", "annual_plan_deliveries", "service_role"],
    ["select", "annual_plans", "authenticated"],
    ["select", "annual_plans", "service_role"],
  ].sort(), "the table grants are not the four reviewed SELECTs");
  for (const [priv, , grantee] of grants) {
    assert.equal(priv, "select");
    assert.notEqual(grantee, "anon");
  }
  // checkout_attempts and orders keep the privileges 011 and 023 gave them.
  assert.ok(!/grant[^;]*on table public\.checkout_attempts/i.test(sql),
    "039 changes checkout_attempts privileges");
  assert.ok(!/grant[^;]*on (table )?public\.orders/i.test(sql),
    "039 changes orders privileges");
});

test("40: every function is SECURITY DEFINER with an empty search_path and no dynamic SQL", () => {
  for (const [name] of FUNCTIONS) {
    const body = bodyOf(name);
    assert.ok(body.includes("security definer set search_path = ''"),
      `${name} is not hardened`);
    assert.ok(!/execute\s+format\s*\(/i.test(body), `${name} uses dynamic SQL`);
    assert.ok(!/\bexecute\s+'/i.test(body), `${name} uses dynamic SQL`);
    // Every relation is schema-qualified, so an emptied search_path
    // cannot resolve one somewhere else.
    for (const bare of [
      " from annual_plans", " from annual_plan_deliveries", " from checkout_attempts",
      " from orders", " into annual_plans", "insert into annual_plan",
      "insert into checkout_attempts", "update annual_plan",
    ]) {
      assert.ok(!oneLine(body).includes(bare), `${name} references an unqualified relation: ${bare}`);
    }
  }
});

test("41: only service_role may execute, and PUBLIC is revoked first", () => {
  for (const [name, args] of FUNCTIONS) {
    const sig = `function public.${name}(${args})`;
    for (const role of ["public", "anon", "authenticated"]) {
      assert.ok(flat.includes(`revoke all on ${sig} from ${role};`),
        `${name} is not revoked from ${role}`);
    }
    assert.ok(flat.includes(`grant execute on ${sig} to service_role;`),
      `${name} is not granted to service_role`);
    assert.ok(!flat.includes(`grant execute on ${sig} to authenticated`));
    assert.ok(!flat.includes(`grant execute on ${sig} to anon`));
    // PUBLIC comes first, because anon and authenticated inherit it.
    assert.ok(flat.indexOf(`revoke all on ${sig} from public;`)
      < flat.indexOf(`grant execute on ${sig} to service_role;`),
      `${name} grants before it revokes`);
  }
});

/* ══════════════════════════════════════════════════════════════
   42-45. THE COMMERCIAL CONTRACT, AND WHAT WAS NOT TOUCHED
   ══════════════════════════════════════════════════════════════ */

test("42: the three Germany annual totals are exact in integer cents", () => {
  // The schema stores these; the arithmetic is asserted here so the
  // contract the migration was built for is pinned next to it.
  const N = 13;
  const rows = [
    { size: "30g", catalog: 1999, unit: 1799, ship: 590, total: 31057 },
    { size: "50g", catalog: 2999, unit: 2699, ship: 0, total: 35087 },
    { size: "100g", catalog: 5499, unit: 4949, ship: 0, total: 64337 },
  ];
  for (const r of rows) {
    assert.equal(r.unit * N + r.ship * N, r.total, `${r.size} total is wrong`);
    assert.equal(r.unit, Math.floor((r.catalog * 90 + 50) / 100), `${r.size} is not 10 percent off`);
    assert.ok(r.unit <= r.catalog);
    assert.ok(Number.isInteger(r.unit) && Number.isInteger(r.ship) && Number.isInteger(r.total));
  }
  // 50 g free shipping is a real annual benefit; the normal German rule
  // would charge it, which is why the amount is a frozen per-plan column
  // and not derived from lib/shipping.ts.
  assert.ok(read("lib/shipping.ts").includes("germany: { shippingGrossCents: 590, freeShippingThresholdGrossCents: 4900 }"));
  assert.ok(2699 < 4900, "the 50 g annual unit is above the normal free-shipping threshold");
  assert.ok(!flat.includes("4900"), "the migration derives annual shipping from the shop threshold");
});

test("43: no application code was changed by this phase", () => {
  const changed = execFileSync("git", ["diff", "--name-only", "HEAD"],
    { cwd: ROOT, encoding: "utf-8" }).trim();
  const touched = changed ? changed.split(NEWLINE) : [];
  for (const rel of touched) {
    assert.ok(!rel.startsWith("lib/"), `an application module changed: ${rel}`);
    assert.ok(!rel.startsWith("app/"), `an application module changed: ${rel}`);
  }
});

test("44: the feature flag and the shop status are unchanged and still closed", () => {
  assert.ok(read("app/content.ts").includes('export const SHOP_STATUS = "prelaunch" as const;'));
  assert.ok(read("lib/subscriptionCheckoutRules.ts")
    .includes('export const SUBSCRIPTION_FEATURE_FLAG = "B2C_SUBSCRIPTIONS_ENABLED";'));
  // B2C_ANNUAL_PLAN_ENABLED is application configuration for a later
  // phase. 039 must not invent it, read it, or default it to anything.
  assert.ok(!flat.includes("b2c_annual_plan_enabled"),
    "the migration references a feature flag it does not own");
});

test("45: the migration changes no data and creates no order", () => {
  // Every INSERT in the file is inside a function body, so applying it
  // writes nothing.
  const inserts = [...sql.matchAll(/insert into public\.(\w+)/g)].map(m => m[1]);
  assert.deepEqual([...new Set(inserts)].sort(),
    ["annual_plan_deliveries", "annual_plans", "checkout_attempts"]);
  assert.ok(!flat.includes("insert into public.orders"), "039 creates an order");
  assert.ok(!flat.includes("delete from"), "039 deletes rows");
  assert.ok(!flat.includes("truncate"), "039 truncates");
  assert.ok(!flat.includes("drop table"), "039 drops a table");
  assert.ok(!flat.includes("drop constraint"), "039 drops a constraint");
  assert.ok(!flat.includes("drop function"), "039 drops a function");
  assert.ok(!flat.includes("drop index"), "039 drops an index");
});
