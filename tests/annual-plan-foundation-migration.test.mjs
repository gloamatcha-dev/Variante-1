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
// on public.checkout_attempts, and five server-only functions.
//
// PHASE 4B1.1 HARDENED FOUR THINGS, and they are the reason several
// assertions below are about ORDER rather than presence:
//
//   * ownership of the payment attempt is proved BEFORE any annual plan
//     is resolved or reported, so a guessed attempt id is not an oracle
//   * a NEW parent can only be minted from a genuinely pre-Stripe
//     attempt ('created', no session, no intent, no invoice, no binding)
//   * activation correlates the EXACT Stripe Checkout Session and the
//     EXACT PaymentIntent against the paid attempt, and takes
//     purchased_at from that attempt's paid_at rather than from a caller
//   * the parent guard and the physical order creation are ONE
//     transaction under ONE parent row lock, so a full refund can no
//     longer commit between them

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
 * annual column on public.orders, the two composition functions Phase
 * 4B1.1 removed - so a scan that read the comments would report every
 * deliberate avoidance as a violation of itself.
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

/**
 * Every function this migration is allowed to define, with its identity
 * arguments. FIVE, not six: Phase 4B1.1 replaced
 * prepare_annual_plan_delivery_attempt and
 * mark_annual_plan_delivery_fulfilled with one atomic function.
 */
const FUNCTIONS = [
  ["create_pending_annual_plan_for_attempt",
   "uuid, uuid, uuid, integer, integer, integer, numeric, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb"],
  ["activate_annual_plan_from_payment", "uuid, text, text"],
  ["claim_due_annual_plan_deliveries", "integer"],
  ["fulfill_annual_plan_delivery", "uuid"],
  ["apply_annual_plan_refund_state", "text, integer"],
];

/** Functions that must NOT exist after the 4B1.1 hardening. */
const REMOVED_FUNCTIONS = [
  "prepare_annual_plan_delivery_attempt",
  "mark_annual_plan_delivery_fulfilled",
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
const PENDING = bodyOf("create_pending_annual_plan_for_attempt");
const ACTIVATE = bodyOf("activate_annual_plan_from_payment");
const CLAIM = bodyOf("claim_due_annual_plan_deliveries");
const FULFILL = bodyOf("fulfill_annual_plan_delivery");
const REFUND = bodyOf("apply_annual_plan_refund_state");

/** Whitespace-collapsed helper for reading one block. */
const oneLine = block => block.toLowerCase().replace(/\s+/g, " ");

/** Asserts `first` appears before `second` inside one block. */
const before = (block, first, second, message) => {
  const a = block.indexOf(first);
  const b = block.indexOf(second);
  assert.ok(a !== -1, `missing: ${first}`);
  assert.ok(b !== -1, `missing: ${second}`);
  assert.ok(a < b, message);
};

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
  // 039 is not applied anywhere, so it is still the right place to fix
  // 039. A hardening pass must not become a second migration.
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
  // 039 does not redefine either of them, nor any unrelated function.
  for (const forbidden of [
    "function public.apply_order_refund_state(",
    "function public.apply_order_refund_state_by_invoice(",
    "function public.activate_subscription_from_invoice(",
    "function public.schedule_subscription_cancellation(",
    "function public.mark_subscription_cancelled(",
    "function public.sync_subscription_payment_status(",
    "function public.authorize_order_shipment(",
  ]) {
    assert.ok(!flat.includes(forbidden), `039 redefines ${forbidden}`);
  }
  // And create_order_from_paid_checkout is CALLED, never redefined.
  assert.ok(!flat.includes("create or replace function public.create_order_from_paid_checkout"),
    "039 redefines the live order creator");
  assert.ok(flat.includes("v_order := public.create_order_from_paid_checkout("),
    "039 does not call the live order creator");
});

test("5: 039 defines exactly the five reviewed functions and no others", () => {
  const defined = [...sql.matchAll(/create or replace function public\.(\w+)\(/g)].map(m => m[1]);
  assert.deepEqual(defined.slice().sort(), FUNCTIONS.map(f => f[0]).slice().sort());
  assert.equal(defined.length, FUNCTIONS.length, "a function is defined twice");
  // The removed composition path is gone entirely, not merely ungranted.
  for (const gone of REMOVED_FUNCTIONS) {
    assert.ok(!sql.includes(gone), `${gone} still exists in executable SQL`);
  }
});

/* ══════════════════════════════════════════════════════════════
   6-13. THE PARENT TABLE
   ══════════════════════════════════════════════════════════════ */

test("6: annual_plans exists with its identity and ownership columns", () => {
  assert.ok(PLANS.includes("id                          uuid primary key"));
  assert.match(PLANS, /user_id\s+uuid not null references auth\.users\(id\)/);
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
  assert.ok(!/annual_plan_id[\s\S]{0,120}on delete cascade/.test(DELIVERIES));
});

test("8: lifecycle and payment vocabularies are separate, and neither borrows the other's words", () => {
  const lifecycle = /status\s+text not null default 'pending'\s+check \(status in \(\s*'pending', 'active', 'completed', 'cancelled'\s*\)\)/;
  const payment = /payment_status\s+text not null default 'pending'\s+check \(payment_status in \(\s*'pending', 'paid', 'partially_refunded', 'refunded'\s*\)\)/;
  assert.match(PLANS, lifecycle, "the lifecycle vocabulary is not exactly the four reviewed values");
  assert.match(PLANS, payment, "the payment vocabulary is not exactly the four reviewed values");

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

test("14: the terminal timestamps are biconditional with their status", () => {
  // Phase 4B1.1. A terminal status and its timestamp are the same fact
  // recorded twice, so neither may exist without the other.
  assert.ok(flat.includes(
    "check ((completed_at is not null) = (status = 'completed'))"),
    "completed_at is not biconditional with status");
  assert.ok(flat.includes(
    "check ((cancelled_at is not null) = (status = 'cancelled'))"),
    "cancelled_at is not biconditional with status");
  // The one-way forms this replaced must be gone, or a completed row
  // could still exist with no completed_at.
  assert.ok(!flat.includes("check ((completed_at is null) or status = 'completed')"));
  assert.ok(!flat.includes("check ((cancelled_at is null) or status = 'cancelled')"));
  // An abandoned pending plan may still become cancelled later: the
  // purchase-date guard exempts 'pending' and 'cancelled'.
  assert.ok(flat.includes("check (status not in ('active', 'completed')"),
    "the purchase-date guard no longer exempts a never-purchased plan");
});

/* ══════════════════════════════════════════════════════════════
   15-19. ONE PAYMENT, THIRTEEN DELIVERIES, NEVER SHARED
   ══════════════════════════════════════════════════════════════ */

test("15: one delivery row per (plan, delivery number), enforced by a unique constraint", () => {
  assert.ok(oneLine(DELIVERIES).includes(
    "constraint annual_plan_deliveries_plan_number_key unique (annual_plan_id, delivery_number)"));
  assert.ok(flat.includes(
    "create unique index annual_plan_deliveries_checkout_attempt_id_key on public.annual_plan_deliveries (checkout_attempt_id) where checkout_attempt_id is not null"));
  assert.ok(flat.includes(
    "create unique index annual_plan_deliveries_order_id_key on public.annual_plan_deliveries (order_id) where order_id is not null"));
});

test("16: one synthetic fulfillment attempt per (plan, delivery number)", () => {
  assert.ok(flat.includes(
    "create unique index checkout_attempts_annual_delivery_key on public.checkout_attempts (annual_plan_id, annual_delivery_number) where annual_plan_id is not null and annual_delivery_number is not null"));
  assert.ok(flat.includes(
    "add column annual_plan_id uuid references public.annual_plans(id), add column annual_delivery_number integer"));
});

test("17: a synthetic delivery attempt can never carry the annual Stripe payment identity", () => {
  const guard = flat.slice(flat.indexOf("checkout_attempts_annual_delivery_no_stripe_payment_check"));
  assert.ok(guard.startsWith("checkout_attempts_annual_delivery_no_stripe_payment_check check ( annual_plan_id is null or (stripe_payment_intent_id is null and stripe_invoice_id is null and stripe_checkout_session_id is null and subscription_id is null) )"),
    "the no-shared-payment CHECK is not the reviewed one");

  assert.ok(flat.includes(
    "checkout_attempts_annual_delivery_paired_check check ( (annual_plan_id is null and annual_delivery_number is null) or (annual_plan_id is not null and annual_delivery_number between 1 and 13) )"));

  // The insert inside the atomic fulfillment sets none of the four.
  const f = oneLine(FULFILL);
  const insert = f.slice(
    f.indexOf("insert into public.checkout_attempts"),
    f.indexOf("returning * into v_attempt"));
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
  // And the order creator is handed a NULL payment intent, explicitly typed.
  assert.ok(f.includes("null::text"), "the order creator is not given a null payment intent");
});

test("18: no annual column is added to public.orders", () => {
  assert.ok(!/alter\s+table\s+public\.orders/i.test(sql), "039 alters public.orders");
  assert.ok(!/alter\s+table\s+public\.order_items/i.test(sql));
  const altered = [...sql.matchAll(/alter table public\.(\w+)/g)].map(m => m[1]);
  assert.deepEqual([...new Set(altered)].sort(),
    ["annual_plan_deliveries", "annual_plans", "checkout_attempts"]);
});

test("19: nothing fresh is read for a purchased plan", () => {
  for (const block of [FULFILL, ACTIVATE]) {
    assert.ok(!block.includes("product_variants"), "a purchased plan re-read the catalog");
    assert.ok(!block.includes("price_gross_cents"), "a purchased plan re-read a catalog price");
  }
});

/* ══════════════════════════════════════════════════════════════
   20-23. THE PENDING PARENT, BEFORE STRIPE
   ══════════════════════════════════════════════════════════════ */

test("20: ownership is proved before any annual plan is resolved or reported", () => {
  // Phase 4B1.1. Answering the existing-plan branch first would let a
  // guessed attempt id reveal that a plan exists, plus its uuid and its
  // status.
  const p = oneLine(PENDING);
  before(p,
    "if v_attempt.user_id is distinct from p_user_id then",
    "from public.annual_plans where payment_checkout_attempt_id = p_checkout_attempt_id",
    "the existing plan is resolved before ownership is proved");
  before(p,
    "'attempt_not_owned'",
    "'annual_plan_id', v_plan.id",
    "a plan id can be reported before ownership is proved");
  // The refusal carries no plan id and no status.
  const refusal = p.slice(p.indexOf("if v_attempt.user_id is distinct from p_user_id then"));
  const refusalReturn = refusal.slice(0, refusal.indexOf("end if;"));
  assert.ok(refusalReturn.includes("'result', 'attempt_not_owned'"));
  assert.ok(!refusalReturn.includes("annual_plan_id"), "the ownership refusal leaks a plan id");
  assert.ok(!refusalReturn.includes("status"), "the ownership refusal leaks a status");
});

test("21: a NEW parent can only be minted from a genuinely pre-Stripe attempt", () => {
  const p = oneLine(PENDING);
  // 'created' is the exact pre-Stripe state name in this architecture.
  assert.ok(p.includes("if v_attempt.status <> 'created'"),
    "the pre-Stripe state is not pinned to 'created'");
  // Audited against the live source rather than assumed.
  const attempts = read("lib/checkoutAttempts.ts");
  assert.ok(attempts.includes(
    'export type CheckoutAttemptStatus = "created" | "stripe_session_created" | "paid" | "failed" | "expired";'),
    "the checkout attempt status vocabulary changed");
  assert.ok(attempts.includes('status: "stripe_session_created",'),
    "linkStripeSession no longer marks the post-Stripe state");
  assert.ok(read("supabase/migrations/009_stripe_checkout_attempts.sql")
    .includes("status                      text not null default 'created'"),
    "'created' is no longer the default pre-Stripe state");
  // Every external-object marker is refused too, not just the status.
  for (const evidence of [
    "v_attempt.stripe_checkout_session_id is not null",
    "v_attempt.stripe_payment_intent_id is not null",
    "v_attempt.stripe_invoice_id is not null",
    "v_attempt.subscription_id is not null",
    "v_attempt.annual_plan_id is not null",
    "v_attempt.annual_delivery_number is not null",
  ]) {
    assert.ok(p.includes(evidence), `a new parent can be minted despite ${evidence}`);
  }
  assert.ok(p.includes("'attempt_not_pre_stripe'"));
});

test("22: the pre-Stripe test does not break a legitimate retry", () => {
  // A retry after the Stripe session was created has an attempt that is
  // no longer pre-Stripe, and must still get its existing parent back.
  // So the existing-plan return has to come FIRST.
  const p = oneLine(PENDING);
  before(p,
    "'result', 'existing'",
    "if v_attempt.status <> 'created'",
    "the pre-Stripe test runs before the existing-plan return and would break retries");
});

test("23: the pending parent is claimed under the attempt's row lock", () => {
  const p = oneLine(PENDING);
  before(p,
    "from public.checkout_attempts where id = p_checkout_attempt_id for update",
    "insert into public.annual_plans",
    "the parent is created without holding the attempt lock");
  assert.ok(p.includes("when unique_violation then"), "the concurrent-race winner is not adopted");
  assert.ok(p.includes(
    "if v_attempt.expected_total_gross_cents is distinct from v_total then"),
    "the plan total is not checked against the amount the customer will be asked for");
});

/* ══════════════════════════════════════════════════════════════
   24-29. ACTIVATION
   ══════════════════════════════════════════════════════════════ */

test("24: the activation signature takes no caller timestamp", () => {
  // Phase 4B1.1 removed p_purchased_at rather than defaulting it: one
  // timestamp positions thirteen future shipments and the end date.
  const header = ACTIVATE.slice(0, ACTIVATE.indexOf("as $$"));
  assert.ok(!header.includes("p_purchased_at"), "activation still accepts a caller timestamp");
  assert.ok(!header.includes("timestamptz"), "activation still accepts a timestamp argument");
  assert.match(header, /p_annual_plan_id\s+uuid,\s*[\s\S]*p_stripe_checkout_session_id text,\s*[\s\S]*p_stripe_payment_intent_id\s+text/);
  // And the grants name the new three-argument signature.
  assert.ok(flat.includes(
    "grant execute on function public.activate_annual_plan_from_payment(uuid, text, text) to service_role;"));
  assert.ok(!flat.includes("activate_annual_plan_from_payment(uuid, text, text, timestamptz)"),
    "a stale four-argument grant survived");
});

test("25: purchased_at is the attempt's verified paid_at and nothing else", () => {
  const a = oneLine(ACTIVATE);
  assert.ok(a.includes("if v_attempt.paid_at is null then"), "a paid attempt with no paid_at can activate");
  assert.ok(a.includes("'attempt_paid_at_missing'"));
  assert.ok(a.includes("v_purchased := v_attempt.paid_at;"),
    "purchased_at is not taken from the attempt");
  // Never invented.
  assert.ok(!a.includes("v_purchased := pg_catalog.now()"), "purchased_at falls back to a clock");
  assert.ok(!a.includes("coalesce(p_purchased_at"), "a caller timestamp is still consulted");
  // paid_at is written by markAttemptPaid at the verified moment.
  assert.ok(read("lib/checkoutAttempts.ts").includes("paid_at: new Date().toISOString(),"),
    "markAttemptPaid no longer stamps paid_at");
});

test("26: activation correlates the exact Checkout Session and the exact PaymentIntent", () => {
  const a = oneLine(ACTIVATE);
  // Both must be present on the attempt.
  assert.ok(a.includes("if v_attempt.stripe_payment_intent_id is null"));
  assert.ok(a.includes("'attempt_payment_intent_missing'"));
  assert.ok(a.includes("if v_attempt.stripe_checkout_session_id is null"));
  assert.ok(a.includes("'attempt_checkout_session_missing'"));
  // And both must match, after trimming.
  assert.ok(a.includes(
    "if pg_catalog.btrim(v_attempt.stripe_payment_intent_id) is distinct from v_intent then"),
    "the PaymentIntent is not correlated to the paid attempt");
  assert.ok(a.includes("'payment_intent_conflict'"));
  assert.ok(a.includes(
    "if pg_catalog.btrim(v_attempt.stripe_checkout_session_id) is distinct from v_session then"),
    "the Checkout Session is not correlated to the paid attempt");
  assert.ok(a.includes("'checkout_session_conflict'"));
  // Blank input is refused before anything is read.
  assert.ok(a.includes("or pg_catalog.btrim(p_stripe_payment_intent_id) = ''"));
  assert.ok(a.includes("or pg_catalog.btrim(p_stripe_checkout_session_id) = ''"));
  // The plan stores the ATTEMPT's values, not the caller's arguments.
  const set = a.slice(a.indexOf("update public.annual_plans set"), a.indexOf("returning * into v_plan"));
  assert.ok(set.includes("stripe_payment_intent_id = pg_catalog.btrim(v_attempt.stripe_payment_intent_id)"));
  assert.ok(set.includes("stripe_checkout_session_id = pg_catalog.btrim(v_attempt.stripe_checkout_session_id)"));
  assert.ok(!set.includes("= v_intent"), "the caller's argument is written instead of the evidence");
  assert.ok(!set.includes("= v_session"), "the caller's argument is written instead of the evidence");
});

test("27: a correlation mismatch mutates nothing", () => {
  const a = oneLine(ACTIVATE);
  const write = a.indexOf("update public.annual_plans set");
  assert.ok(write > 0, "the activation write was not found");
  for (const guard of [
    "if v_attempt.status <> 'paid' then",
    "if v_attempt.expected_total_gross_cents is distinct from v_plan.total_gross_cents then",
    "if v_attempt.user_id is distinct from v_plan.user_id then",
    "if v_attempt.stripe_payment_intent_id is null",
    "if v_attempt.stripe_checkout_session_id is null",
    "if pg_catalog.btrim(v_attempt.stripe_payment_intent_id) is distinct from v_intent then",
    "if pg_catalog.btrim(v_attempt.stripe_checkout_session_id) is distinct from v_session then",
    "if v_attempt.paid_at is null then",
  ]) {
    const at = a.indexOf(guard);
    assert.ok(at !== -1, `missing guard: ${guard}`);
    assert.ok(at < write, `a guard runs after the write: ${guard}`);
  }
  // No mutation of any kind happens before the guards either.
  const head = a.slice(0, write);
  assert.ok(!head.includes("insert into"), "activation inserts before its guards");
  assert.ok(!/update public\./.test(head), "activation updates before its guards");
});

test("28: nothing is correlated by customer, email, amount alone, SKU or timestamp", () => {
  const a = oneLine(ACTIVATE);
  for (const forbidden of ["customer_snapshot", "email", "sku", "variant_id", "created_at"]) {
    assert.ok(!a.includes(forbidden), `activation correlates by ${forbidden}`);
  }
  // The attempt and the plan must also agree on who they belong to.
  assert.ok(a.includes("if v_attempt.user_id is distinct from v_plan.user_id then"));
  assert.ok(a.includes("'attempt_owner_mismatch'"));
});

test("29: activation is idempotent and refuses a second, different payment", () => {
  const a = oneLine(ACTIVATE);
  assert.ok(a.includes("if v_plan.status = 'active' then"), "a replay is not detected");
  assert.ok(a.includes("if v_plan.stripe_payment_intent_id is distinct from v_intent then"));
  assert.ok(a.includes("if v_plan.stripe_checkout_session_id is distinct from v_session then"));
  assert.ok(a.includes("'already_active'"), "an idempotent replay has no distinct answer");
  assert.ok(a.includes("if v_plan.status in ('completed', 'cancelled') then"));
  assert.ok(a.includes("'terminal'"));
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
   30-33. THE FROZEN SCHEDULE
   ══════════════════════════════════════════════════════════════ */

test("30: the cadence is exactly 28 days, expressed as an absolute duration", () => {
  assert.equal(672, 28 * 24);
  assert.ok(oneLine(ACTIVATE).includes("pg_catalog.make_interval(hours => 672 * (n - 1))"),
    "the delivery cadence is not 672 hours per step");
  for (const forbidden of ["interval '1 month'", "interval '28 days'", "interval '4 weeks'", "'1 mon'"]) {
    assert.ok(!flat.includes(forbidden), `calendar arithmetic appears: ${forbidden}`);
  }
});

test("31: delivery 1 is the paid date and delivery 13 is exactly +336 days", () => {
  assert.equal(672 * (1 - 1), 0);
  assert.equal(672 * (13 - 1), 8064);
  assert.equal(8064, 336 * 24);
  assert.ok(oneLine(ACTIVATE).includes("v_purchased + pg_catalog.make_interval(hours => 672 * (n - 1))"));
  assert.ok(oneLine(ACTIVATE).includes(
    "from pg_catalog.generate_series(1, v_plan.delivery_count) as n"),
    "the thirteen rows are not generated from delivery_count");
});

test("32: plan_end_at is exactly paid_at + 364 days", () => {
  assert.equal(8736, 364 * 24);
  assert.equal(8736, 672 * 13);
  assert.ok(oneLine(ACTIVATE).includes(
    "plan_end_at = v_purchased + pg_catalog.make_interval(hours => 8736)"),
    "plan_end_at is not purchase + 8736 hours");
});

test("33: the thirteen rows are created in the activation transaction, with the constraint as backstop", () => {
  const a = oneLine(ACTIVATE);
  assert.ok(a.includes("insert into public.annual_plan_deliveries"));
  assert.ok(a.includes("on conflict on constraint annual_plan_deliveries_plan_number_key do nothing"),
    "the duplicate backstop is not the unique constraint");
  assert.ok(a.includes("if v_created <> v_plan.delivery_count then"),
    "a partial schedule is not refused");
  assert.ok(a.includes("raise exception"), "a partial schedule does not roll the activation back");
  assert.ok(!a.includes("insert into public.orders"), "activation creates an order");
  assert.ok(!a.includes("create_order_from_paid_checkout"), "activation mints an order");
});

/* ══════════════════════════════════════════════════════════════
   34-37. CLAIMING, AND THE SIX HOUR LEASE
   ══════════════════════════════════════════════════════════════ */

test("34: the claim locks its rows and skips ones another worker holds", () => {
  const c = oneLine(CLAIM);
  assert.ok(c.includes("for update of d skip locked"),
    "the claim does not lock with SKIP LOCKED");
  assert.ok(!c.includes("for update of p"), "the claim locks the parent too and can deadlock");
  assert.ok(!c.includes("lock table"), "the claim takes a table lock");
  assert.ok(c.includes("with due as ("));
  assert.ok(c.includes("update public.annual_plan_deliveries t set state = 'claimed', claimed_at = pg_catalog.now()"));
  assert.ok(c.includes("limit least(greatest(coalesce(p_limit, 25), 1), 100)"),
    "the batch is not bounded");
});

test("35: the stale-claim lease is exactly six hours and is the only reclaim path", () => {
  const c = oneLine(CLAIM);
  assert.ok(c.includes("d.claimed_at < pg_catalog.now() - interval '6 hours'"),
    "the lease threshold is not the pinned six hours");
  const LEASE_HOURS = 6;
  assert.ok(LEASE_HOURS * 60 * 60 > 300, "the lease is not above the maximum function duration");
  assert.ok(LEASE_HOURS < 24, "the lease is not below the daily cron interval");
  assert.match(read("vercel.json"), /"schedule":\s*"20 5 \* \* \*"/,
    "the cron is no longer daily, so the lease reasoning has to be revisited");
  assert.ok(c.includes("(d.state = 'claimed' and d.claimed_at is not null and d.claimed_at < pg_catalog.now() - interval '6 hours')"));
  assert.equal((c.match(/interval '6 hours'/g) || []).length, 1);
});

test("36: a delivery that already produced an order can never be reclaimed", () => {
  const c = oneLine(CLAIM);
  const orBranch = c.indexOf("and ( (d.state = 'scheduled'");
  assert.ok(orBranch > 0, "the due/reclaim disjunction was not found");
  const shared = c.slice(0, orBranch);
  assert.ok(shared.includes("d.order_id is null"), "a delivery with an order can be reclaimed");
  assert.ok(shared.includes("d.fulfilled_at is null"), "a fulfilled delivery can be reclaimed");
  assert.ok(oneLine(DELIVERIES).includes(
    "check ((state = 'fulfilled') = (order_id is not null and fulfilled_at is not null))"));
});

test("37: the claim creates nothing at all", () => {
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
   38-43. ATOMIC FULFILLMENT, AND THE RACE THAT IS NOW CLOSED
   ══════════════════════════════════════════════════════════════ */

test("38: fulfillment is ONE function, and the unsafe composition is gone", () => {
  // Phase 4B1.1. Two exposed halves meant the parent lock was released
  // between the guard and the order; a second supported write path that
  // recreates the race is not an acceptable leftover.
  assert.ok(sql.includes("create or replace function public.fulfill_annual_plan_delivery("),
    "the atomic fulfillment function does not exist");
  for (const gone of REMOVED_FUNCTIONS) {
    assert.ok(!sql.includes(gone), `${gone} is still defined or granted`);
    assert.ok(!flat.includes(`grant execute on function public.${gone}`),
      `${gone} is still granted to a role`);
  }
  // No caller-supplied order id exists anywhere any more: the function
  // derives the order from the attempt it created in the same
  // transaction, so there is nothing to take on trust.
  assert.ok(!sql.includes("p_order_id"), "a caller-supplied order id survives");
});

test("39: the parent is locked first, the delivery second, and the lock is held through the order", () => {
  const f = oneLine(FULFILL);
  const planLock = f.indexOf("from public.annual_plans where id = v_delivery.annual_plan_id for update");
  const rowLock = f.indexOf("from public.annual_plan_deliveries where id = p_delivery_id for update");
  const guardStatus = f.indexOf("if v_plan.status <> 'active' then");
  const guardRefund = f.indexOf("if v_plan.payment_status = 'refunded' then");
  const insert = f.indexOf("insert into public.checkout_attempts");
  const order = f.indexOf("v_order := public.create_order_from_paid_checkout(");
  const record = f.indexOf("update public.annual_plan_deliveries");

  assert.ok(planLock > 0, "the parent is not locked");
  assert.ok(rowLock > planLock, "the lock order is not parent then child");
  assert.ok(guardStatus > rowLock, "the status guard runs before the row is locked");
  assert.ok(guardRefund > rowLock, "the refund guard runs before the row is locked");
  assert.ok(insert > guardRefund, "an attempt is created before the parent guards");
  assert.ok(order > insert, "the order is created before its attempt exists");
  assert.ok(record > order, "the delivery is recorded before the order exists");

  // THE WHOLE POINT: the guard and the order are in the same function
  // body, so they are in the same transaction and the same lock.
  assert.ok(guardRefund < order,
    "the refund guard does not precede order creation inside one transaction");
  assert.ok(!f.includes("commit"), "the fulfillment splits itself into several transactions");
});

test("40: the refund writer serialises on the SAME parent row lock", () => {
  // This is the proof that "guard passes, refund commits, order is
  // created" cannot happen: both functions take FOR UPDATE on the same
  // public.annual_plans row before deciding anything.
  assert.ok(oneLine(FULFILL).includes(
    "from public.annual_plans where id = v_delivery.annual_plan_id for update"));
  assert.ok(oneLine(REFUND).includes(
    "from public.annual_plans where stripe_payment_intent_id = v_intent for update"));
  // And the refund's write happens after that lock, so it cannot
  // interleave with a fulfillment that already holds it.
  const r = oneLine(REFUND);
  assert.ok(r.indexOf("update public.annual_plans") >
    r.indexOf("from public.annual_plans where stripe_payment_intent_id = v_intent for update"),
    "the refund writes before it locks");
});

test("41: fulfillment is idempotent and returns the same one order", () => {
  const f = oneLine(FULFILL);
  // Already fulfilled: return what happened, create nothing.
  assert.ok(f.includes("if v_delivery.state = 'fulfilled' then"));
  assert.ok(f.includes("'already_fulfilled'"));
  const already = f.indexOf("if v_delivery.state = 'fulfilled' then");
  assert.ok(already < f.indexOf("insert into public.checkout_attempts"),
    "a fulfilled delivery can still reach the attempt insert");
  // An existing attempt is resolved, never rebuilt.
  assert.ok(f.includes("if v_delivery.checkout_attempt_id is not null then"),
    "an existing synthetic attempt is not reused");
  assert.ok(f.includes("when unique_violation then"), "the race winner is not adopted");
  assert.ok(f.includes("where annual_plan_id = v_plan.id and annual_delivery_number = v_delivery.delivery_number"),
    "the adopted attempt is not proved to be this delivery's");
  // Only a live claim may be fulfilled.
  assert.ok(f.includes("if v_delivery.state <> 'claimed' then"));
  assert.ok(f.includes("'delivery_not_claimed'"));
  // And a missing order is refused rather than recorded.
  assert.ok(f.includes("if v_order.id is null then"));
  assert.ok(f.includes("raise exception"));
});

test("42: a full refund prevents fulfillment; a partial refund does not", () => {
  assert.ok(oneLine(CLAIM).includes("p.payment_status <> 'refunded'"),
    "the claim does not refuse a fully refunded plan");
  assert.ok(oneLine(FULFILL).includes("if v_plan.payment_status = 'refunded' then"),
    "fulfillment does not refuse a fully refunded plan");
  assert.ok(oneLine(FULFILL).includes("'plan_refunded'"));
  // A partial refund is a real recorded state that stops nothing.
  assert.ok(PLANS.includes("'partially_refunded'"));
  assert.ok(oneLine(REFUND).includes("v_new_status := 'partially_refunded'"));
  assert.ok(!oneLine(CLAIM).includes("partially_refunded"),
    "a partial refund stops future deliveries");
  assert.ok(!oneLine(FULFILL).includes("partially_refunded"),
    "a partial refund stops future deliveries");
});

test("43: a plan that leaves 'active' stops producing orders, whatever moved it", () => {
  // Future administrative termination needs no change here: the guard
  // tests status generally rather than naming the states 039 writes, and
  // it is evaluated under the same parent lock the terminator would take.
  const f = oneLine(FULFILL);
  assert.ok(f.includes("if v_plan.status <> 'active' then"),
    "the status guard names specific states instead of requiring 'active'");
  assert.ok(f.includes("'plan_not_active'"));
});

/* ══════════════════════════════════════════════════════════════
   44-47. THE ANNUAL REFUND WRITER
   ══════════════════════════════════════════════════════════════ */

test("44: the refund writer resolves by the unique annual PaymentIntent and nothing else", () => {
  const r = oneLine(REFUND);
  assert.ok(r.includes("from public.annual_plans where stripe_payment_intent_id = v_intent for update"),
    "the plan is not resolved by payment intent under a lock");
  for (const forbidden of [
    "customer_snapshot", "email", "total_gross_cents =", "created_at", "variant_id",
    "sku", "order_id", "subscription_id", "delivery_number", "user_id",
  ]) {
    assert.ok(!r.includes(forbidden), `the refund writer correlates by ${forbidden}`);
  }
  assert.ok(!r.includes("lock table"), "the annual writer takes a table lock it does not need");
  assert.ok(!r.includes("limit 1"), "an answer is manufactured where a refusal is honest");
  assert.ok(!r.includes("order by"), "an answer is manufactured where a refusal is honest");
});

test("45: the three financial transitions are exactly the reviewed ones", () => {
  const r = oneLine(REFUND);
  assert.ok(r.includes("if p_refunded_total_cents = 0 then v_new_status := 'paid';"));
  assert.ok(r.includes("elsif p_refunded_total_cents >= v_plan.total_gross_cents then v_new_status := 'refunded';"));
  assert.ok(r.includes("else v_new_status := 'partially_refunded';"));
  assert.ok(r.includes("if p_refunded_total_cents > v_plan.total_gross_cents then"));
  assert.ok(r.includes("'invalid_amount'"));
  assert.ok(r.includes("if v_plan.payment_status = 'pending' then"), "an unpaid plan can be refunded");
  assert.ok(r.includes("'not_applicable'"));
  assert.ok(r.includes("'unchanged'"), "a no-op still writes");
  assert.ok(!r.includes("refunded_total_cents +"), "the refund total is accumulated, not absolute");
});

test("46: the refund writer never touches lifecycle or a delivery row", () => {
  const r = oneLine(REFUND);
  assert.ok(!r.includes("annual_plan_deliveries"), "the refund writer touches a delivery row");
  assert.ok(!r.includes("set status"), "the refund writer writes lifecycle status");
  const setClause = r.slice(r.indexOf("update public.annual_plans set"), r.indexOf("where id = v_plan.id"));
  assert.ok(setClause.includes("payment_status ="));
  assert.ok(setClause.includes("refunded_total_cents ="));
  assert.ok(setClause.includes("refund_updated_at ="));
  assert.ok(!setClause.includes("completed_at"), "the refund writer completes a plan");
  assert.ok(!setClause.includes("cancelled_at"), "the refund writer cancels a plan");
});

test("47: nothing in 039 writes 'completed' or 'cancelled'", () => {
  for (const [name] of FUNCTIONS) {
    const body = oneLine(bodyOf(name));
    assert.ok(!body.includes("status = 'completed'"), `${name} completes a plan`);
    assert.ok(!body.includes("status = 'cancelled'"), `${name} cancels a plan`);
    assert.ok(!body.includes("completed_at ="), `${name} stamps completed_at`);
    assert.ok(!body.includes("cancelled_at ="), `${name} stamps cancelled_at`);
  }
  assert.ok(PLANS.includes("'pending', 'active', 'completed', 'cancelled'"));
});

/* ══════════════════════════════════════════════════════════════
   48-52. RLS, PRIVILEGES AND FUNCTION HARDENING
   ══════════════════════════════════════════════════════════════ */

test("48: RLS is enabled on both annual tables", () => {
  assert.ok(flat.includes("alter table public.annual_plans enable row level security"));
  assert.ok(flat.includes("alter table public.annual_plan_deliveries enable row level security"));
});

test("49: authenticated may only SELECT, and only its own rows", () => {
  const policies = [...sql.matchAll(/create policy "([^"]+)"\s+on public\.(\w+) for (\w+)/g)];
  assert.equal(policies.length, 2, "there must be exactly two policies");
  const declaredCommands = policies.map(([, , , cmd]) => cmd);
  for (const cmd of declaredCommands) {
    assert.equal(cmd, "select", "a policy permits something other than SELECT");
  }
  for (const cmd of ["insert", "update", "delete", "all"]) {
    assert.ok(!declaredCommands.includes(cmd), `a write policy exists: for ${cmd}`);
  }
  assert.ok(flat.includes('create policy "users read own annual plans" on public.annual_plans for select using (auth.uid() = user_id)'));
  assert.ok(oneLine(sql).includes(
    "where p.id = annual_plan_deliveries.annual_plan_id and p.user_id = auth.uid()"));
  assert.ok(!DELIVERIES.includes("user_id"), "the delivery row duplicates the owner");
});

test("50: anon gets nothing, and no role gets a direct write on either table", () => {
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
  assert.ok(!/grant[^;]*on table public\.checkout_attempts/i.test(sql),
    "039 changes checkout_attempts privileges");
  assert.ok(!/grant[^;]*on (table )?public\.orders/i.test(sql),
    "039 changes orders privileges");
});

test("51: every function is SECURITY DEFINER with an empty search_path and no dynamic SQL", () => {
  for (const [name] of FUNCTIONS) {
    const body = bodyOf(name);
    assert.ok(body.includes("security definer set search_path = ''"),
      `${name} is not hardened`);
    assert.ok(!/execute\s+format\s*\(/i.test(body), `${name} uses dynamic SQL`);
    assert.ok(!/\bexecute\s+'/i.test(body), `${name} uses dynamic SQL`);
    for (const bare of [
      " from annual_plans", " from annual_plan_deliveries", " from checkout_attempts",
      " from orders", " into annual_plans", "insert into annual_plan",
      "insert into checkout_attempts", "update annual_plan",
      ":= create_order_from_paid_checkout(",
    ]) {
      assert.ok(!oneLine(body).includes(bare), `${name} references an unqualified relation: ${bare}`);
    }
  }
});

test("52: only service_role may execute, and PUBLIC is revoked first", () => {
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
    assert.ok(flat.indexOf(`revoke all on ${sig} from public;`)
      < flat.indexOf(`grant execute on ${sig} to service_role;`),
      `${name} grants before it revokes`);
  }
  // Exactly five functions are granted, no more.
  const granted = [...sql.matchAll(/grant execute on function public\.(\w+)\(/g)].map(m => m[1]);
  assert.deepEqual([...new Set(granted)].sort(), FUNCTIONS.map(f => f[0]).slice().sort());
});

/* ══════════════════════════════════════════════════════════════
   53-56. THE COMMERCIAL CONTRACT, AND WHAT WAS NOT TOUCHED
   ══════════════════════════════════════════════════════════════ */

test("53: the three Germany annual totals are exact in integer cents", () => {
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
  assert.ok(read("lib/shipping.ts").includes("germany: { shippingGrossCents: 590, freeShippingThresholdGrossCents: 4900 }"));
  assert.ok(2699 < 4900, "the 50 g annual unit is above the normal free-shipping threshold");
  assert.ok(!flat.includes("4900"), "the migration derives annual shipping from the shop threshold");
});

test("54: no application code was changed by this phase", () => {
  const changed = execFileSync("git", ["diff", "--name-only", "HEAD"],
    { cwd: ROOT, encoding: "utf-8" }).trim();
  const touched = changed ? changed.split(NEWLINE) : [];
  for (const rel of touched) {
    assert.ok(!rel.startsWith("lib/"), `an application module changed: ${rel}`);
    assert.ok(!rel.startsWith("app/"), `an application module changed: ${rel}`);
  }
});

test("55: the feature flag and the shop status are unchanged and still closed", () => {
  assert.ok(read("app/content.ts").includes('export const SHOP_STATUS = "prelaunch" as const;'));
  assert.ok(read("lib/subscriptionCheckoutRules.ts")
    .includes('export const SUBSCRIPTION_FEATURE_FLAG = "B2C_SUBSCRIPTIONS_ENABLED";'));
  assert.ok(!flat.includes("b2c_annual_plan_enabled"),
    "the migration references a feature flag it does not own");
});

test("56: the migration changes no data and creates no order of its own", () => {
  const inserts = [...sql.matchAll(/insert into public\.(\w+)/g)].map(m => m[1]);
  assert.deepEqual([...new Set(inserts)].sort(),
    ["annual_plan_deliveries", "annual_plans", "checkout_attempts"]);
  assert.ok(!flat.includes("insert into public.orders"),
    "039 inserts into orders instead of calling the live creator");
  assert.ok(!flat.includes("delete from"), "039 deletes rows");
  assert.ok(!flat.includes("truncate"), "039 truncates");
  assert.ok(!flat.includes("drop table"), "039 drops a table");
  assert.ok(!flat.includes("drop constraint"), "039 drops a constraint");
  assert.ok(!flat.includes("drop function"), "039 drops a function");
  assert.ok(!flat.includes("drop index"), "039 drops an index");
});
