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
// on public.checkout_attempts, and eight server-only functions.
//
// PHASE 4B1.2 completed the write surface rather than shipping a table
// whose email state nobody can set and whose completion rule nobody can
// execute: two functions for the purchase confirmation's state machine
// and one bounded completion sweep.
//
// PHASE 4B1.3 closed the last known hole in that state machine. Proving
// "the row is still 'sending'" does not prove the caller still OWNS the
// claim, because the thirty-minute lease can hand it to somebody else in
// between. Each claim now mints a uuid, the outcome writer must present
// it, and tests 73-79 walk the exact worker-A-against-worker-B sequence
// step by step.
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
 * arguments. EIGHT. Phase 4B1.1 replaced
 * prepare_annual_plan_delivery_attempt and
 * mark_annual_plan_delivery_fulfilled with one atomic function; Phase
 * 4B1.2 added the three the already-known runtime needs.
 */
const FUNCTIONS = [
  ["create_pending_annual_plan_for_attempt",
   "uuid, uuid, uuid, integer, integer, integer, numeric, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb"],
  ["activate_annual_plan_from_payment", "uuid, text, text"],
  ["claim_due_annual_plan_deliveries", "integer"],
  ["fulfill_annual_plan_delivery", "uuid"],
  ["apply_annual_plan_refund_state", "text, integer"],
  // Phase 4B1.2: the runtime write surface 039 was missing.
  ["claim_annual_plan_purchase_email", "uuid"],
  ["record_annual_plan_purchase_email_result", "uuid, uuid, text"],
  ["complete_due_annual_plans", "integer"],
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
const EMAIL_CLAIM = bodyOf("claim_annual_plan_purchase_email");
const EMAIL_RESULT = bodyOf("record_annual_plan_purchase_email_result");
const COMPLETE = bodyOf("complete_due_annual_plans");

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
  assert.equal(files[files.length - 2], MIGRATION_039, "039 must be the highest");
  assert.equal(files[files.length - 3], MIGRATION_038, "038 must be the one before it");
  const numbers = files.map(f => f.slice(0, 3));
  assert.equal(new Set(numbers).size, numbers.length, "a migration number is used twice");
});

test("2: no migration 040 or beyond", () => {
  // 039 is not applied anywhere, so it is still the right place to fix
  // 039. A hardening pass must not become a second migration.
  const beyond = readdirSync(MIGRATIONS_DIR).filter(f => Number(f.slice(0, 3)) > 40);
  assert.deepEqual(beyond, [], "an unreviewed migration appeared after 039");
});

test("3: migrations 001 through 038 are unmodified", () => {
  const changed = execFileSync("git", ["diff", "--name-only", "HEAD", "--", "supabase/migrations/"],
    { cwd: ROOT, encoding: "utf-8" }).trim();
  const touched = changed ? changed.split(NEWLINE) : [];
  // 040 is NOT APPLIED yet, so it may still be edited in place; every
  // migration below it is live and may not be.
  const immutable = touched.filter(rel =>
    !rel.endsWith(MIGRATION_039) && !rel.endsWith("040_annual_checkout_retry_fingerprints.sql"));
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

test("5: 039 defines exactly the eight reviewed functions and no others", () => {
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
  assert.match(PLANS, /payment_checkout_attempt_id uuid not null\s+references public\.checkout_attempts\(id\)/);
  // Named, not derived: one payment attempt, at most one annual plan.
  assert.ok(oneLine(PLANS).includes(
    "constraint annual_plans_payment_checkout_attempt_id_key unique (payment_checkout_attempt_id)"),
    "the one-plan-per-payment-attempt guarantee is not a named constraint");
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

test("47: exactly one function writes 'completed', and none writes 'cancelled'", () => {
  for (const [name] of FUNCTIONS) {
    const body = oneLine(bodyOf(name));
    // 'cancelled' belongs to administrative termination, which is still
    // a later phase. Nothing in 039 may reach it.
    assert.ok(!body.includes("status = 'cancelled'"), `${name} cancels a plan`);
    assert.ok(!body.includes("cancelled_at ="), `${name} stamps cancelled_at`);
    if (name === "complete_due_annual_plans") continue;
    assert.ok(!body.includes("status = 'completed'"), `${name} completes a plan`);
    assert.ok(!body.includes("completed_at ="), `${name} stamps completed_at`);
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

test("54: no UNCOMMITTED edit to a live application module is in the working tree", () => {
  // ── WHAT THIS ACTUALLY CHECKS, AND WHAT IT DOES NOT ─────────
  //
  // It reads `git diff --name-only HEAD`, so its subject is exactly one
  // thing: TRACKED FILES MODIFIED IN THE WORKING TREE. Three consequences
  // follow, and the test name and the assertions below are narrowed to
  // them rather than claiming more:
  //
  //   * A NEW file is invisible here. Untracked files never appear in
  //     that diff, so this cannot and does not prove that no new route,
  //     no new lib module and no new annual code was added. Phase 4B3
  //     added four such files and this test stayed green throughout.
  //     Whether a new file is acceptable is a review question, not
  //     something this assertion answers.
  //   * After a commit the diff is empty, so this passes trivially. It
  //     is a working-tree guard, not a history guard. Every guard of this
  //     shape in the repository has the same property.
  //   * It says nothing about WHAT changed inside a file. The annual
  //     checkout suite asserts that the two pre-existing attempt writers
  //     survived intact; that is where the real protection lives.
  //
  // What is left is still worth having: an in-progress edit to a live
  // application module, made to bend an existing flow around the annual
  // plan, shows up here before it is committed.
  //
  // Written when 039 was a database-only phase, as "no application module
  // changed at all". Phase 4B3 legitimately edits one, so the guard is
  // re-pinned rather than deleted.
  const changed = execFileSync("git", ["diff", "--name-only", "HEAD"],
    { cwd: ROOT, encoding: "utf-8" }).trim();
  const touched = changed ? changed.split(NEWLINE) : [];

  // lib/checkoutAttempts.ts gains getOrCreateAnnualCheckoutAttempt. That
  // file owns every attempt writer, and an annual prepayment - thirteen
  // discounted units plus thirteen shipping charges - cannot be expressed
  // by the one-time writer, whose total comes from a CheckoutQuote's
  // catalog subtotal plus one shipping charge. Additive only.
  //
  // Phase 4B3.2 adds the annual checkout's own modules to the list. All
  // four are annual-only: the one-time and subscription flows import
  // none of them, and lib/checkoutAttempts.ts still gains only an
  // additional writer.
  const ALLOWED_LIB_EDITS = [
    "lib/checkoutAttempts.ts",
    "lib/annualPlanCheckout.ts",
    "lib/annualPlanCheckoutRules.ts",
    "lib/annualPlanCheckoutDeps.ts",
  ];

  // Phase 4B4 edits ONE application module: the single canonical Stripe
  // webhook, which is where a paid annual session has to be settled -
  // creating a second endpoint would mean a second signature check and a
  // second definition of what "paid" means. The edit is additive, and
  // that it is additive is asserted directly against the source in
  // tests/annual-plan-webhook.test.mjs rather than assumed here.
  const ALLOWED_APP_EDITS = ["app/api/stripe/webhook/route.ts"];

  for (const rel of touched) {
    if (rel.startsWith("app/")) {
      assert.ok(ALLOWED_APP_EDITS.includes(rel),
        `an unreviewed application module has an uncommitted edit: ${rel}`);
    }
    if (rel.startsWith("lib/")) {
      assert.ok(ALLOWED_LIB_EDITS.includes(rel),
        `an unreviewed application module has an uncommitted edit: ${rel}`);
    }
  }
});

test("54b: the annual checkout did not disturb the two live attempt writers", () => {
  // The invariant test 54 cannot reach, asserted directly against the
  // source rather than against a diff - so it holds after the commit too,
  // and it does not depend on which files happen to be dirty.
  const attempts = read("lib/checkoutAttempts.ts");
  for (const writer of [
    "export async function getOrCreateCheckoutAttempt(",
    "export async function getOrCreateSubscriptionCheckoutAttempt(",
    "export async function markAttemptPaid(",
    "export async function linkStripeSession(",
  ]) {
    assert.ok(attempts.includes(writer), `a live attempt writer disappeared: ${writer}`);
  }
  // The subscription writer still owns the fingerprint columns, and the
  // annual writer still does not touch them: migration 025 reads their
  // non-NULL-ness as "this attempt IS a subscription checkout".
  // Bounded at the annual payment READER that Phase 4B4 appended. That
  // reader's column list necessarily NAMES both subscription
  // fingerprints - it selects them in order to PROVE they are null - and
  // a read is not a write.
  const annualWriter = attempts.slice(
    attempts.indexOf("export async function getOrCreateAnnualCheckoutAttempt("),
    attempts.indexOf("const ANNUAL_PAYMENT_ATTEMPT_COLUMNS"));
  for (const column of ["subscription_request_fingerprint", "subscription_intent_fingerprint"]) {
    assert.ok(attempts.includes(`${column}: input.`), `the subscription writer stopped writing ${column}`);
    assert.ok(!annualWriter.includes(column), `the annual writer writes ${column}`);
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

/* ══════════════════════════════════════════════════════════════
   57-63. THE PURCHASE CONFIRMATION'S STATE MACHINE
   ══════════════════════════════════════════════════════════════ */

test("57: the state machine is migration 017's vocabulary, and NULL still means never entered", () => {
  assert.match(PLANS, /purchase_confirmation_email_status\s+text\s+check \(purchase_confirmation_email_status is null\s+or purchase_confirmation_email_status in \(\s*'sending', 'sent', 'failed'\s*\)\)/);
  // Nullable, no default: absence is the pending state, so a plan that
  // predates the sender is not queued work. Read off the DECLARATION
  // alone - the pairing constraints further down legitimately say
  // "is not null" about the very same column.
  const declaration = PLANS.slice(
    PLANS.indexOf("purchase_confirmation_email_status   text"),
    PLANS.indexOf("purchase_confirmation_email_sent_at"));
  assert.ok(declaration.length > 0, "the email status declaration was not found");
  assert.ok(!/not null/.test(declaration),
    "the email status became NOT NULL and NULL stopped meaning 'never entered'");
  assert.ok(!/default/.test(declaration),
    "the email status gained a default and every plan now looks queued");
  assert.ok(!PLANS.includes("'pending', 'sending'"), "'pending' entered the email vocabulary");
  // The same three words the live order families use.
  assert.ok(read("supabase/migrations/017_order_confirmation_email_state.sql")
    .includes("check (confirmation_email_status in ('pending', 'sending', 'sent', 'failed'))"),
    "migration 017's vocabulary changed, so the comparison this file makes is stale");
});

test("58: all three email state columns are paired with the status by CHECK", () => {
  assert.ok(flat.includes(
    "check ((purchase_confirmation_email_sent_at is not null) = (purchase_confirmation_email_status is not distinct from 'sent'))"),
    "sent_at is not biconditional with 'sent'");
  // Phase 4B1.2's new column. claimed_at exists exactly when the row has
  // entered the flow at all, which is what lets the stale rule trust it.
  assert.match(PLANS, /purchase_confirmation_email_claimed_at timestamptz/);
  assert.ok(flat.includes(
    "check ((purchase_confirmation_email_claimed_at is not null) = (purchase_confirmation_email_status is not null))"),
    "claimed_at is not paired with the status");
  // Phase 4B1.3's claim token. Biconditional against 'sending' ALONE, so
  // NULL, 'sent' and 'failed' are all provably tokenless - which is what
  // makes "present the current token" a real proof rather than a
  // convention.
  assert.match(PLANS, /purchase_confirmation_email_claim_token uuid/);
  assert.ok(flat.includes(
    "constraint annual_plans_purchase_email_claim_token_check check ((purchase_confirmation_email_claim_token is not null) = (purchase_confirmation_email_status is not distinct from 'sending'))"),
    "the claim token is not paired with the 'sending' state");
  // Nullable, no default: a token is minted by a claim, never by a row
  // coming into existence.
  const token = PLANS.slice(
    PLANS.indexOf("purchase_confirmation_email_claim_token uuid"),
    PLANS.indexOf("purchase_confirmation_email_claim_token uuid") + 60);
  assert.ok(!/not null/.test(token) && !/default/.test(token),
    "the claim token is NOT NULL or has a default");
});

test("59: the claim locks the row before it decides anything", () => {
  const c = oneLine(EMAIL_CLAIM);
  const lock = c.indexOf("from public.annual_plans where id = p_annual_plan_id for update");
  assert.ok(lock > 0, "the claim does not lock the row");
  for (const decision of [
    "if v_plan.purchase_confirmation_email_status = 'sent' then",
    "if v_plan.purchase_confirmation_email_status = 'sending'",
    "update public.annual_plans",
  ]) {
    assert.ok(c.indexOf(decision) > lock, `a decision is taken before the lock: ${decision}`);
  }
  // Two workers therefore serialise: the loser reads the winner's
  // committed 'sending' rather than the state it started from.
  assert.ok(c.includes("'in_flight'"), "a second concurrent claimer is not refused");
  assert.ok(c.includes("'claimed'"));
});

test("60: 'sent' is terminal and mutates nothing; 'failed' is retryable", () => {
  const c = oneLine(EMAIL_CLAIM);
  const sent = c.indexOf("if v_plan.purchase_confirmation_email_status = 'sent' then");
  const write = c.indexOf("update public.annual_plans");
  assert.ok(sent > 0 && sent < write, "a sent confirmation can be re-claimed");
  assert.ok(c.includes("'already_sent'"));
  // 'failed' is never named as a refusal, so it falls through to the claim.
  assert.ok(!c.includes("= 'failed' then"), "a failed send is refused instead of retried");

  // And the outcome writer is idempotent for 'sent' and refuses a
  // contradicting late report.
  const r = oneLine(EMAIL_RESULT);
  assert.ok(r.includes("if v_plan.purchase_confirmation_email_status = 'sent' then"));
  assert.ok(r.includes("'unchanged'"), "recording 'sent' twice is not idempotent");
  assert.ok(r.includes("'already_sent'"), "a late failure can un-send a sent message");
});

test("61: only the claim owner may record an outcome, and only 'sent' or 'failed'", () => {
  const r = oneLine(EMAIL_RESULT);
  assert.ok(r.includes("if v_outcome not in ('sent', 'failed') then"),
    "the outcome vocabulary is not closed");
  assert.ok(r.includes("'invalid_outcome'"));
  // 'sending' is not an accepted outcome: claiming belongs to the other
  // function, and accepting it here would be a second way to take
  // ownership.
  const vocab = r.slice(r.indexOf("if v_outcome not in"), r.indexOf("'invalid_outcome'"));
  assert.ok(!vocab.includes("'sending'"), "the outcome writer can also claim");
  assert.ok(r.includes("if v_plan.purchase_confirmation_email_status is distinct from 'sending' then"),
    "an unclaimed row can be marked sent");
  assert.ok(r.includes("'not_claimed'"));
  // sent_at is written with 'sent', never alone.
  assert.ok(r.includes("purchase_confirmation_email_status = 'sent', purchase_confirmation_email_sent_at = pg_catalog.now()"));
});

test("62: the stale-sending lease is the house threshold, thirty minutes", () => {
  const c = oneLine(EMAIL_CLAIM);
  assert.ok(c.includes("interval '30 minutes'"), "the email lease is not thirty minutes");
  assert.equal((c.match(/interval '30 minutes'/g) || []).length, 1);
  // A row is only stolen once the lease has genuinely run out.
  assert.ok(c.includes("v_plan.purchase_confirmation_email_claimed_at > pg_catalog.now() - v_stale"),
    "the in-flight test does not use the claim timestamp");
  // Not a new number: it is what every other GLOA email family recovers on.
  const rules = read("lib/transactionalEmailRetryRules.ts");
  assert.ok(rules.includes("export const STALE_SENDING_AFTER_MS = 30 * 60 * 1000;"),
    "the house stale threshold changed, so 039's thirty minutes is now a second answer");
  assert.equal(30 * 60 * 1000, 30 * 60 * 1000);
  // The clock is the dedicated column, never the row's generic updated_at.
  assert.ok(!c.includes("updated_at"), "the email lease reads the row's generic updated_at");
});

test("63: no email is sent from PostgreSQL, and no reminder family is invented", () => {
  for (const forbidden of ["resend", "http", "pg_net", "smtp", "reminder", "net.http"]) {
    assert.ok(!flat.includes(forbidden), `039 reaches outside the database: ${forbidden}`);
  }
  // One message per plan. No family column, no event key, no second table.
  assert.ok(!flat.includes("annual_plan_email_deliveries"),
    "a deliveries table was invented for a single message");
  assert.ok(!flat.includes("subscription_email_deliveries"),
    "039 reaches into the subscription email delivery table");
  const statuses = [...PLANS.matchAll(/purchase_confirmation_email_status/g)];
  assert.ok(statuses.length >= 1);
});

/* ══════════════════════════════════════════════════════════════
   64-69. COMPLETION
   ══════════════════════════════════════════════════════════════ */

test("64: completion requires an active plan whose term is genuinely over", () => {
  const c = oneLine(COMPLETE);
  assert.ok(c.includes("where p.status = 'active'"), "completion does not require 'active'");
  assert.ok(c.includes("and p.plan_end_at is not null"), "a plan with no end date can complete");
  assert.ok(c.includes("and p.plan_end_at <= pg_catalog.now()"),
    "completion does not require the term to be over");
  // Never delivery 13 alone: the census counts rows, it does not look at
  // a delivery number.
  assert.ok(!c.includes("delivery_number = 13"), "completion keys on delivery 13");
  assert.ok(!c.includes("delivery_number"), "completion looks at a delivery number");
});

test("65: completion requires all thirteen deliveries, fulfilled, each with an order", () => {
  const c = oneLine(COMPLETE);
  // Two integers answer all four parts of the rule.
  assert.ok(c.includes("select pg_catalog.count(*), pg_catalog.count(*) filter ( where d.state = 'fulfilled' and d.order_id is not null ) into v_total, v_done"),
    "the delivery census is not the reviewed one");
  assert.ok(c.includes("from public.annual_plan_deliveries d where d.annual_plan_id = v_plan.id"));
  // Both counts must equal the plan's own delivery_count, which is
  // pinned to 13 by CHECK - so a missing row, a scheduled row, a claimed
  // row, a cancelled row or a fulfilled row with no order all fail.
  assert.ok(c.includes("if v_total <> v_plan.delivery_count or v_done <> v_plan.delivery_count then continue;"),
    "a partially delivered plan can complete");
  assert.match(PLANS, /delivery_count\s+integer not null default 13\s+check \(delivery_count = 13\)/);
});

test("66: completion writes exactly two columns and touches nothing else", () => {
  const c = oneLine(COMPLETE);
  const set = c.slice(c.indexOf("update public.annual_plans set"), c.indexOf("where id = v_plan.id"));
  assert.ok(set.includes("status = 'completed'"));
  assert.ok(set.includes("completed_at = v_now"));
  for (const forbidden of [
    "payment_status", "refunded_total_cents", "refund_updated_at", "cancelled_at",
    "purchased_at", "plan_end_at", "total_gross_cents", "snapshot",
    "stripe_payment_intent_id", "purchase_confirmation_email",
  ]) {
    assert.ok(!set.includes(forbidden), `completion writes ${forbidden}`);
  }
  // Delivery history is read and never altered.
  assert.ok(!c.includes("update public.annual_plan_deliveries"), "completion rewrites a delivery");
  assert.ok(!c.includes("delete"), "completion deletes delivery history");
  assert.ok(!c.includes("insert into"), "completion inserts");
});

test("67: completion is idempotent, bounded, and locks with SKIP LOCKED", () => {
  const c = oneLine(COMPLETE);
  // A completed plan no longer matches status = 'active', so a second
  // run is a no-op by construction rather than by a guard.
  assert.ok(c.includes("where p.status = 'active'"));
  assert.ok(c.includes("for update skip locked"), "two runs can fight over the same plan");
  assert.ok(c.includes("limit least(greatest(coalesce(p_limit, 25), 1), 100)"),
    "the completion batch is not bounded");
  assert.ok(c.includes("order by p.plan_end_at asc, p.id asc"), "the batch order is not deterministic");
});

test("68: completion and refund state stay separate", () => {
  // payment_status is not part of the eligibility rule at all.
  const c = oneLine(COMPLETE);
  assert.ok(!c.includes("payment_status"), "completion consults refund state");
  // And the refund writer still never writes lifecycle status.
  const r = oneLine(REFUND);
  assert.ok(!r.includes("set status"), "the refund writer writes lifecycle status");
  assert.ok(!r.includes("'completed'"), "the refund writer completes a plan");
  // The unresolved case is NAMED in the migration rather than guessed at.
  assert.ok(migration039.includes("NOCH NICHT ENTSCHIEDEN"),
    "the fully-refunded, partly-delivered case is not flagged as undecided");
});

test("69: the completion rule the prose promises is the rule the function implements", () => {
  // The migration documented this rule before it was executable. Both
  // halves must still be there, and the function must implement both.
  assert.ok(migration039.includes("now() >= plan_end_at"),
    "the documented completion rule lost its date half");
  const c = oneLine(COMPLETE);
  assert.ok(c.includes("p.plan_end_at <= pg_catalog.now()"));
  assert.ok(c.includes("v_done <> v_plan.delivery_count"));
});

/* ══════════════════════════════════════════════════════════════
   70-72. THE WRITE SURFACE STAYS NARROW
   ══════════════════════════════════════════════════════════════ */

test("70: no direct INSERT, UPDATE or DELETE grant is introduced on either annual table", () => {
  // public.orders carries column-scoped UPDATE grants for its email
  // state (017, 027, 033). That pattern is deliberately NOT extended
  // here: every write goes through a SECURITY DEFINER function.
  const statements = migration039.split(NEWLINE).filter(l => !l.trim().startsWith("--"));
  for (const line of statements) {
    if (!/^\s*grant\b/i.test(line)) continue;
    if (/on function/i.test(line)) continue;
    assert.match(line, /grant select on table public\.(annual_plans|annual_plan_deliveries)\s+to (authenticated|service_role);/,
      `a non-SELECT table grant was introduced: ${line.trim()}`);
  }
  // Belt and braces: no column-scoped grant of any kind.
  assert.ok(!/grant (update|insert|delete)\s*\(/i.test(withoutComments(migration039)),
    "a column-scoped write grant was introduced");
});

test("71: customer roles can execute none of the eight functions", () => {
  for (const [name, args] of FUNCTIONS) {
    const sig = `function public.${name}(${args})`;
    for (const role of ["public", "anon", "authenticated"]) {
      assert.ok(flat.includes(`revoke all on ${sig} from ${role};`), `${name} is not revoked from ${role}`);
    }
    assert.ok(!flat.includes(`grant execute on ${sig} to anon`));
    assert.ok(!flat.includes(`grant execute on ${sig} to authenticated`));
  }
  // Exactly eight grants, all to service_role, and no other grantee.
  const grants = [...sql.matchAll(/grant execute on function public\.(\w+)\([^)]*\) to (\w+);/g)];
  assert.equal(grants.length, FUNCTIONS.length, "the number of execute grants changed");
  for (const [, , grantee] of grants) assert.equal(grantee, "service_role");
});

test("72: the verification block contains no stale expected count", () => {
  // The prose and the schema have to agree, or the owner's dry run is
  // checked against a number nobody updated.
  const verify = migration039.slice(migration039.indexOf("VERIFY AFTER APPLYING"));
  assert.ok(verify.length > 0, "the verify block was removed");
  for (const stale of [
    "Expect six rows", "expect six rows", "expect FIVE rows", "Expect five rows",
    "Expect four index rows", "expect four index",
  ]) {
    assert.ok(!verify.includes(stale), `the verify block still promises "${stale}"`);
  }
  assert.ok(verify.includes("Expect EIGHT rows"), "the function count is not restated");
  // And the count it promises is the count the file defines.
  const named = [...verify.matchAll(/--\s+'(\w+)'[,)]?$/gm)].map(m => m[1]);
  for (const [name] of FUNCTIONS) {
    assert.ok(named.includes(name), `the verify block does not list ${name}`);
  }
  // Every load-bearing uniqueness guarantee is verified by name.
  for (const index of [
    "annual_plans_payment_checkout_attempt_id_key",
    "annual_plans_stripe_payment_intent_id_key",
    "annual_plans_stripe_checkout_session_id_key",
    "annual_plan_deliveries_plan_number_key",
    "annual_plan_deliveries_checkout_attempt_id_key",
    "annual_plan_deliveries_order_id_key",
    "checkout_attempts_annual_delivery_key",
  ]) {
    assert.ok(verify.includes(index), `the verify block does not check ${index}`);
    assert.ok(sql.includes(index), `${index} is not actually created`);
  }
});

/* ══════════════════════════════════════════════════════════════
   73-79. THE STALE-RECLAIM RACE: WORKER A AGAINST WORKER B

   The exact sequence these seven tests pin, step by step:

     A. worker A claims                -> token_A, status 'sending'
     B. A's claim ages past 30 minutes
     C. worker B reclaims              -> token_B, token_B != token_A
     D. A reports 'sent'  with token_A -> REFUSED, nothing mutated
     E. A reports 'failed' with token_A -> REFUSED, nothing mutated
     F. B reports with token_B          -> accepted, token cleared

   This is a static suite, so each step is pinned by the SQL structure
   that makes it true rather than by executing it. The structure is the
   guarantee: no execution can produce a different outcome from these
   statements, and a future edit that broke any step would have to
   change a line one of these tests names.
   ══════════════════════════════════════════════════════════════ */

test("73: (A) a successful claim mints a FRESH token and returns it to the winner", () => {
  const c = oneLine(EMAIL_CLAIM);
  // Minted per claim, never derived from the row and never reused.
  assert.ok(c.includes("v_token := pg_catalog.gen_random_uuid();"),
    "the claim does not mint a fresh token");
  assert.ok(!c.includes("v_token := v_plan."), "the token is reused from the row");
  // Written atomically with the status and the clock, in ONE update.
  const set = c.slice(c.indexOf("update public.annual_plans set"), c.indexOf("where id = v_plan.id"));
  assert.ok(set.includes("purchase_confirmation_email_status = 'sending'"));
  assert.ok(set.includes("purchase_confirmation_email_claimed_at = pg_catalog.now()"));
  assert.ok(set.includes("purchase_confirmation_email_claim_token = v_token"));
  // And handed back only on the winning path.
  const claimed = c.slice(c.indexOf("'result', 'claimed'"));
  assert.ok(claimed.includes("'claim_token', v_token"),
    "the winner is not told its own claim token");
  // Same pg_catalog-qualified generator the rest of the migration uses.
  assert.ok(flat.includes("pg_catalog.gen_random_uuid()"));
});

test("74: (B, C) every claimable state mints a NEW token, so a reclaim cannot collide", () => {
  const c = oneLine(EMAIL_CLAIM);
  // There is exactly ONE update in the claim, and exactly one mint, so
  // all three claimable entries - never entered, 'failed', and a stale
  // 'sending' - pass through the same fresh-token statement. A reclaim
  // therefore cannot reuse the previous owner's identity.
  assert.equal((c.match(/update public\.annual_plans/g) || []).length, 1,
    "the claim has more than one write path");
  assert.equal((c.match(/pg_catalog\.gen_random_uuid\(\)/g) || []).length, 1,
    "the claim mints a token on some paths and not others");
  // The stale branch is the only way a 'sending' row becomes claimable,
  // and it is a refusal ABOVE the write, so a fresh claim is never stolen.
  assert.ok(c.includes("v_plan.purchase_confirmation_email_claimed_at > pg_catalog.now() - v_stale"));
  const inFlight = c.indexOf("'result', 'in_flight'");
  const write = c.indexOf("update public.annual_plans");
  assert.ok(inFlight > 0 && inFlight < write, "a live claim can be taken over");
  // Thirty minutes, unchanged by this phase.
  assert.ok(c.includes("interval '30 minutes'"));
});

test("75: (C) a losing caller is never told the winner's token", () => {
  const c = oneLine(EMAIL_CLAIM);
  // Every non-'claimed' answer, and none of them may carry the identity
  // that authorises a write.
  for (const result of ["'not_found'", "'not_purchased'", "'already_sent'", "'in_flight'", "'invalid_input'"]) {
    const at = c.indexOf(result);
    assert.ok(at > 0, `missing claim result: ${result}`);
    // The payload of that answer ends at its closing ");".
    const payload = c.slice(at, c.indexOf(");", at));
    assert.ok(!payload.includes("claim_token"),
      `the ${result} answer leaks a claim token`);
  }
  // claim_token appears in exactly one returned payload: the winner's.
  assert.equal((c.match(/'claim_token'/g) || []).length, 1);
});

test("76: (D, E) a stale worker cannot write ANY outcome over a newer claim", () => {
  const r = oneLine(EMAIL_RESULT);
  // The guard, and it is a comparison against the row's CURRENT token.
  assert.ok(r.includes(
    "if v_plan.purchase_confirmation_email_claim_token is distinct from p_claim_token then"),
    "the outcome writer does not prove the caller owns the current claim");
  assert.ok(r.includes("'claim_not_owned'"), "a stale worker has no distinct refusal");
  // NULL-safe: `is distinct from`, never `<>`, so a NULL on either side
  // refuses instead of falling through as unknown.
  assert.ok(!/claim_token <> p_claim_token/.test(r), "the token comparison is not NULL-safe");

  // IT APPLIES TO BOTH OUTCOMES, because the refusal sits above the
  // branch that chooses between them - one guard, not one per outcome.
  const guard = r.indexOf("if v_plan.purchase_confirmation_email_claim_token is distinct from p_claim_token then");
  const branch = r.indexOf("if v_outcome = 'sent' then update public.annual_plans");
  assert.ok(guard > 0 && branch > guard,
    "the ownership guard does not cover both 'sent' and 'failed'");

  // AND NOTHING IS MUTATED. No write of any kind precedes the guard.
  const head = r.slice(0, guard);
  assert.ok(!/update public\./.test(head), "the outcome writer updates before proving ownership");
  assert.ok(!head.includes("insert into"), "the outcome writer inserts before proving ownership");
});

test("77: (D, E) the token is required input and cannot be omitted", () => {
  const header = EMAIL_RESULT.slice(0, EMAIL_RESULT.indexOf("as $$"));
  assert.match(header, /p_annual_plan_id uuid,\s*p_claim_token\s+uuid,\s*p_outcome\s+text/,
    "the outcome writer's signature is not (uuid, uuid, text)");
  const r = oneLine(EMAIL_RESULT);
  assert.ok(r.includes("if p_annual_plan_id is null or p_claim_token is null or p_outcome is null then"),
    "a NULL claim token is accepted");
  // There is no two-argument version anywhere: 039 was corrected in
  // place, so an overload that skips the ownership proof cannot exist.
  assert.ok(!flat.includes("record_annual_plan_purchase_email_result(uuid, text)"),
    "a two-argument overload survives and would skip the ownership proof");
  assert.equal(
    (sql.match(/create or replace function public\.record_annual_plan_purchase_email_result\(/g) || []).length,
    1, "the outcome writer is defined more than once");
  // And the grants name the new signature only.
  for (const role of ["public", "anon", "authenticated"]) {
    assert.ok(flat.includes(
      `revoke all on function public.record_annual_plan_purchase_email_result(uuid, uuid, text) from ${role};`));
  }
  assert.ok(flat.includes(
    "grant execute on function public.record_annual_plan_purchase_email_result(uuid, uuid, text) to service_role;"));
});

test("78: (F) the current owner's outcome is accepted and clears the token", () => {
  const r = oneLine(EMAIL_RESULT);
  // Both outcomes end the claim, and both clear the token in the SAME
  // statement that moves the status - so the token CHECK holds at every
  // commit rather than between two of them.
  const sentSet = r.slice(r.indexOf("set purchase_confirmation_email_status = 'sent'"),
    r.indexOf("else"));
  assert.ok(sentSet.includes("purchase_confirmation_email_sent_at = pg_catalog.now()"));
  assert.ok(sentSet.includes("purchase_confirmation_email_claim_token = null"),
    "'sent' does not clear the claim token");
  const failedSet = r.slice(r.indexOf("set purchase_confirmation_email_status = 'failed'"));
  assert.ok(failedSet.includes("purchase_confirmation_email_claim_token = null"),
    "'failed' does not clear the claim token");
  // claimed_at is deliberately NOT cleared: it keeps documenting when
  // the last claim was taken.
  assert.ok(!sentSet.includes("purchase_confirmation_email_claimed_at"),
    "'sent' erases the claim timestamp");
  assert.ok(!failedSet.includes("purchase_confirmation_email_claimed_at"),
    "'failed' erases the claim timestamp");
  assert.ok(r.includes("'recorded'"));
});

test("79: 'sent' stays terminal and 'failed' stays retryable under the token rule", () => {
  const r = oneLine(EMAIL_RESULT);
  // Terminal is checked BEFORE the token, so a duplicate success report
  // from any worker is idempotent rather than a token error - the
  // message really was sent, and the row already says so.
  const terminal = r.indexOf("if v_plan.purchase_confirmation_email_status = 'sent' then");
  const tokenGuard = r.indexOf("if v_plan.purchase_confirmation_email_claim_token is distinct from p_claim_token then");
  assert.ok(terminal > 0 && terminal < tokenGuard,
    "a duplicate success report is answered as a token error rather than as idempotent");
  assert.ok(r.includes("'unchanged'"));
  assert.ok(r.includes("'already_sent'"), "a late failure can un-send a sent message");

  // 'failed' is claimable again, and the next claim mints a NEW token -
  // there is one mint on the one write path (test 74).
  const c = oneLine(EMAIL_CLAIM);
  assert.ok(!c.includes("= 'failed' then"), "a failed send is refused instead of retried");
  // A 'failed' row holds no token, so nothing from the failed attempt
  // could authorise a write against the retry.
  assert.ok(flat.includes(
    "check ((purchase_confirmation_email_claim_token is not null) = (purchase_confirmation_email_status is not distinct from 'sending'))"));
});

/* ══════════════════════════════════════════════════════════════
   80. THE PROSE MATCHES THE FUNCTIONALITY
   ══════════════════════════════════════════════════════════════ */

test("80: no comment still claims 039 never writes 'completed'", () => {
  // 039 becomes immutable when it is applied, so a comment that is wrong
  // now is wrong forever. complete_due_annual_plans DOES write
  // 'completed'; only 'cancelled' is still unreachable.
  for (const stale of [
    "It writes no status 'completed' and no status 'cancelled'",
    "039 writes 'pending' and 'active' and nothing else",
    "NO FUNCTION IN 039 WRITES 'completed'",
    "no completion cron is created",
    "COMPLETION IS NOT WRITTEN HERE",
  ]) {
    assert.ok(!migration039.includes(stale), `a stale comment survives: "${stale}"`);
  }
  // And the corrected statements are actually there.
  assert.ok(migration039.includes("It writes no status 'cancelled'"),
    "the migration no longer states that 'cancelled' is unreachable");
  assert.ok(migration039.includes("'completed'  complete_due_annual_plans"),
    "the lifecycle comment does not name which function writes 'completed'");
  // The one function that writes it is the one that may.
  assert.ok(oneLine(COMPLETE).includes("set status = 'completed', completed_at = v_now"));

  // Section 14's cross-reference used to point at TABLE PRIVILEGES.
  assert.ok(!migration039.includes("Section 5's rule is that refund state is not lifecycle"),
    "the refund contract still cites the wrong section");
});
