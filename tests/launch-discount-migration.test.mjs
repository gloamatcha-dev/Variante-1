import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 057 — GLOALAUNCH10 BECOMES A REUSABLE CODE.
 *
 * Migration 056 built the discount as a one-use, first-order-only offer:
 * a claim ledger, a six-state lifecycle, a first-order query and a
 * redemption that was atomic with the order. It is APPLIED TO
 * PRODUCTION. The commercial decision then changed - the code is now
 * simply ten percent for anybody who knows it, as often as they like
 * while it is active - and 057 is the cleanup.
 *
 * ── WHAT THIS SUITE IS ACTUALLY PROTECTING ────────────────────
 *
 * Three things, and the first is the one that matters most:
 *
 *   1. 056 IS NEVER EDITED AGAIN. It is live. The old "may still be
 *      corrected in place" exemptions are gone from every suite, and
 *      this one checks the git tree directly.
 *   2. THE CLEANUP IS COMPLETE, not partial. A claim ledger nothing
 *      writes, or an order writer that still redeems, would be worse
 *      than either end of the migration - the schema would keep
 *      claiming to enforce a rule that no longer exists.
 *   3. THE MONEY SURVIVES. The two columns on the attempt and the two
 *      on the order are what a discounted order is made of, and none of
 *      them was part of the limit.
 *
 * SAFE: reads SQL, source and the git index. No database, no network,
 * no Stripe, no clock.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");
const NEWLINE = String.fromCharCode(10);

const MIGRATION = "057_simplify_launch_discount.sql";
const migration = read(`supabase/migrations/${MIGRATION}`);
/** SQL with comments stripped, so prose can neither satisfy nor break an assertion. */
const sql = migration.replace(/^\s*--.*$/gm, "");
/** And with the block comments above the function stripped too. */
const statements = sql.replace(/\/\*[\s\S]*?\*\//g, "");

/** 056, as applied. Read only to prove it is untouched. */
const applied056 = read("supabase/migrations/056_launch_discount.sql");

/**
 * Source with line comments removed, so a module that EXPLAINS the
 * discount in prose is not counted as a module that depends on it.
 */
const readCode = (rel) => read(rel)
  .split(NEWLINE)
  .filter((line) => {
    const t = line.trim();
    return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
  })
  .join(NEWLINE);

/** The body of the one function 057 replaces. */
const orderWriter = (() => {
  const start = statements.indexOf("create or replace function public.create_order_from_paid_checkout(");
  assert.ok(start >= 0, `the order writer is not replaced in ${MIGRATION}`);
  const end = statements.indexOf("$$;", start);
  assert.ok(end > start, "the order writer has no terminator");
  return statements.slice(start, end + 3);
})();

/* ══════════════════════════════════════════════════════════════
   1. THE MIGRATION ITSELF
   ══════════════════════════════════════════════════════════════ */

test("1: 057 is the newest migration, there is no 058, and it is one transaction", () => {
  const files = readdirSync(path.join(ROOT, "supabase/migrations"))
    .filter((f) => f.endsWith(".sql")).sort();

  assert.equal(files.length, 58);
  assert.equal(files[files.length - 2], MIGRATION, "057 is not the newest migration");
  assert.equal(files[55], "056_launch_discount.sql", "056 moved");
  assert.deepEqual(files.filter((f) => Number(f.slice(0, 3)) > 58), [],
    "a migration 058 or beyond appeared");

  // Migration numbers are unique, so two people cannot both own 057.
  const numbers = files.map((f) => Number(f.slice(0, 3)));
  assert.equal(new Set(numbers).size, numbers.length, "a migration number is used twice");

  // ONE transaction. A half-applied cleanup is the one outcome worth
  // refusing: an order writer that still redeems, or a ledger that half
  // exists, is worse than either end of this migration.
  assert.match(sql, /^\s*begin;/m);
  assert.match(sql, /^\s*commit;/m);
  assert.equal(sql.match(/^\s*begin;/gm).length, 1);
  assert.equal(sql.match(/^\s*commit;/gm).length, 1);
});

test("1b: 056 IS APPLIED AND IS NEVER EDITED AGAIN", () => {
  // THE RULE THIS PACKAGE RESTORES. While it was committed and still
  // unapplied, eleven suites carried an explicit exemption letting that
  // migration be corrected in place. It is live now, so every one of
  // those is gone - and this asks git directly rather than trusting
  // that they were.
  const changed = execFileSync(
    "git",
    ["diff", "--name-only", "--diff-filter=MD", "HEAD", "--", "supabase/migrations/"],
    { cwd: ROOT, encoding: "utf-8" }
  ).trim();
  const touched = changed ? changed.split(NEWLINE) : [];
  assert.deepEqual(touched, [], "a live, immutable migration was edited");

  // And 056 still reads the way production is running it: the cleanup is
  // 057's job, not a rewrite of history.
  for (const kept of [
    "create table if not exists public.launch_discount_claims",
    "create or replace function public.claim_launch_discount(",
    "create or replace function public.redeem_launch_discount(",
    "create or replace function public.launch_discount_is_first_order(",
  ]) {
    assert.ok(applied056.includes(kept), `056 no longer contains ${kept} - it must not be edited`);
  }

  // NO SUITE MAY CLAIM THAT MIGRATION IS STILL UNAPPLIED.
  //
  // The pattern is assembled from pieces rather than written as a
  // literal, because a literal would match this file's own source and
  // fail forever - the classic way a self-scanning assertion breaks.
  const staleExemption = new RegExp("056" + "[^" + NEWLINE + "]{0,80}" + "NOT APP" + "LIED", "i");
  for (const rel of readdirSync(path.join(ROOT, "tests")).filter((f) => f.endsWith(".test.mjs"))) {
    assert.ok(
      !staleExemption.test(read(`tests/${rel}`)),
      `tests/${rel} still exempts 056 from the immutability guard`
    );
  }
});

test("1c: it is idempotent - a second run changes nothing and still passes", () => {
  // Every destructive statement is guarded, and the one constraint that
  // is re-added is guarded by its own catalogue lookup, because ADD
  // CONSTRAINT has no IF NOT EXISTS.
  assert.match(sql, /drop constraint if exists checkout_attempts_discount_snapshot_paired/);
  assert.match(sql, /conname = 'checkout_attempts_discount_snapshot_paired'[\s\S]{0,300}add constraint checkout_attempts_discount_snapshot_paired/);
  assert.match(sql, /drop table if exists public\.launch_discount_claims/);
  assert.match(sql, /drop column if exists discount_claim_id/);
  assert.match(sql, /drop index if exists public\.idx_orders_paid_customer_email_created_at/);
  assert.equal((sql.match(/drop function if exists/g) || []).length, 9);

  // The end state is asserted before commit, not the number of things
  // changed.
  for (const raised of [
    "057: public\\.launch_discount_claims still exists",
    "057: public\\.% still exists - a claim door survived the cleanup",
    "057: checkout_attempts\\.discount_claim_id still exists",
    "057: the first-order index still exists",
    "057: checkout_attempts lost column %",
    "057: orders lost column discount_code",
    "057: checkout_attempts is missing constraint %",
    "057: orders is missing constraint %",
    "057: the discount snapshot constraint still requires a claim token",
    "057: a discounted attempt is no longer attributable to a customer email",
    "057: public\\.create_order_from_paid_checkout does not exist exactly once",
    "057: public\\.create_order_from_paid_checkout is not security definer",
    "057: public\\.create_order_from_paid_checkout does not pin an empty search_path",
    "057: a browser role may execute the order writer",
    "057: service_role cannot execute the order writer",
    "057: an attempt was backfilled with a discount code",
    "057: an order was backfilled with a discount code",
    "057: an order was backfilled with a discount amount",
  ]) {
    assert.match(sql, new RegExp(`raise exception '${raised}`), `057 does not assert: ${raised}`);
  }
});

/* ══════════════════════════════════════════════════════════════
   2. THE CLAIM ARCHITECTURE IS REMOVED, NOT ORPHANED
   ══════════════════════════════════════════════════════════════ */

test("2: the one-use ledger is dropped", () => {
  assert.match(statements, /drop table if exists public\.launch_discount_claims;/);

  // NOT cascade. Nothing outside the table depends on it - its foreign
  // keys point OUT of it - so a plain drop is sufficient, and if
  // something unexpected did depend on it this migration should fail
  // rather than quietly remove that too.
  assert.ok(!/drop table[^;]*cascade/i.test(statements), "the ledger is dropped with CASCADE");

  // And nothing recreates it, or anything like it.
  assert.ok(!/create table/i.test(statements), "057 creates a table");
  assert.ok(!/create index/i.test(statements), "057 creates an index");
  assert.ok(!/create policy/i.test(statements), "057 creates a policy");
});

test("2b: every claim door is dropped, by exact signature", () => {
  // A bare name would refuse to drop if an overload had ever been
  // created; 056's own pre-commit block proved there is exactly one of
  // each, so the signatures are written out.
  for (const signature of [
    "public.redeem_launch_discount(text, text, uuid, uuid, uuid)",
    "public.claim_launch_discount(text, text, uuid, uuid, integer)",
    "public.mark_launch_discount_session_creating(text, text, uuid, uuid)",
    "public.mark_launch_discount_session_open(text, text, uuid, uuid, text)",
    "public.mark_launch_discount_payment_pending(text, text, uuid, uuid)",
    "public.release_launch_discount(text, text, uuid, uuid)",
    "public.release_launch_discount_after_expired_session(text, text, uuid, uuid, text)",
    "public.release_launch_discount_after_failed_payment(text, text, uuid, uuid)",
  ]) {
    assert.ok(
      statements.includes(`drop function if exists ${signature};`),
      `057 does not drop ${signature}`
    );
    // And the signature is the one 056 actually created.
    assert.ok(
      applied056.includes(signature.slice("public.".length).split("(")[0]),
      `${signature} is not a 056 function`
    );
  }
});

test("2c: THE ORDER WRITER IS REPLACED BEFORE THE REDEMPTION IS DROPPED", () => {
  // LOAD-BEARING ORDER. create_order_from_paid_checkout calls
  // redeem_launch_discount, so dropping the redemption first would leave
  // the live order writer pointing at a function that no longer exists
  // for the rest of this transaction.
  const replaceAt = statements.indexOf("create or replace function public.create_order_from_paid_checkout(");
  const dropAt = statements.indexOf("drop function if exists public.redeem_launch_discount(");
  assert.ok(replaceAt > 0 && dropAt > 0);
  assert.ok(replaceAt < dropAt, "the redemption is dropped before its caller is replaced");

  // The same rule for the column: the constraint that required it and
  // the function that read it both go first.
  const constraintAt = statements.indexOf("drop constraint if exists checkout_attempts_discount_snapshot_paired");
  const columnAt = statements.indexOf("drop column if exists discount_claim_id");
  assert.ok(constraintAt > 0 && columnAt > 0);
  assert.ok(constraintAt < columnAt, "the claim token is dropped while a constraint still requires it");
  assert.ok(replaceAt < columnAt, "the claim token is dropped while the order writer still reads it");
});

test("2d: the first-order query and the index built for it are dropped", () => {
  assert.match(statements, /drop function if exists public\.launch_discount_is_first_order\(text\);/);
  assert.match(statements, /drop index if exists public\.idx_orders_paid_customer_email_created_at;/);

  // Nothing replaces either. "First order" is not a condition any more,
  // so there is no query to keep, and no index to keep one for.
  assert.ok(!/create or replace function[^(]*is_first_order/.test(statements),
    "057 keeps a first-order query");
  assert.ok(!/idx_orders_paid_customer_email_created_at\s*\n\s*on public\.orders/.test(statements),
    "the first-order index is recreated");
});

/* ══════════════════════════════════════════════════════════════
   3. THE ATTEMPT KEEPS TWO COLUMNS, NOT THREE
   ══════════════════════════════════════════════════════════════ */

test("3: the claim token is gone from the checkout attempt", () => {
  assert.match(statements, /alter table public\.checkout_attempts\s*\n\s*drop column if exists discount_claim_id;/);
  // And nothing reintroduces it.
  assert.ok(!/add column if not exists discount_claim_id/.test(statements));
});

test("3b: the paired constraint is REPLACED, and what it now requires", () => {
  // A CHECK is replaced by dropping and re-adding it, and doing that in
  // two visible statements is clearer than pretending there is an ALTER.
  assert.match(statements, /alter table public\.checkout_attempts\s*\n\s*drop constraint if exists checkout_attempts_discount_snapshot_paired;/);
  assert.match(statements, /add constraint checkout_attempts_discount_snapshot_paired\s*\n\s*check \(\s*\n\s*\(discount_code is null\s*\n\s*and discount_gross_cents is null\)\s*\n\s*or \(discount_code is not null\s*\n\s*and discount_gross_cents is not null\s*\n\s*and discount_gross_cents > 0\s*\n\s*and customer_email is not null\)\s*\n\s*\)/);

  // NO CLAIM TOKEN. That half of 056's constraint is what made the code
  // one-use; it is the whole point of this migration that it is gone.
  const added = statements.slice(
    statements.indexOf("add constraint checkout_attempts_discount_snapshot_paired"),
    statements.indexOf("comment on column public.checkout_attempts.discount_gross_cents")
  );
  assert.ok(added.length > 0);
  assert.ok(!added.includes("discount_claim_id"), "the new constraint still requires a claim token");

  // THE ADDRESS STAYS. It is no longer a limit on anything - the code is
  // reusable - but since 055 the normalised checkout email IS the
  // authoritative B2C identity, and a discounted order that cannot be
  // attributed to one would be a reduction with nobody's name on it.
  assert.ok(added.includes("customer_email is not null"),
    "a discounted attempt is no longer attributable to a customer");
  assert.match(migration, /a discounted order stays attributable to the identity 055 froze/);
});

test("3c: the two scope constraints are untouched", () => {
  // "B2C one-time only" and "one known code" were never about the limit,
  // and both are still enforced by 056's constraints. 057 neither drops
  // nor redefines them - it only asserts they survived.
  for (const kept of [
    "checkout_attempts_discount_code_known",
    "checkout_attempts_discount_one_time_only",
  ]) {
    assert.ok(!new RegExp(`drop constraint[^;]*${kept}`).test(statements),
      `057 drops ${kept}`);
    assert.ok(!new RegExp(`add constraint ${kept}`).test(statements),
      `057 redefines ${kept}`);
    assert.ok(sql.includes(kept), `057 does not assert that ${kept} survived`);
  }
  // And they still say what they said in the migration that created them.
  assert.match(applied056, /add constraint checkout_attempts_discount_code_known\s*\n\s*check \(discount_code is null or discount_code = 'GLOALAUNCH10'\)/);
  assert.match(applied056, /add constraint checkout_attempts_discount_one_time_only\s*\n\s*check \(\s*\n\s*discount_code is null\s*\n\s*or \(subscription_id is null\s*\n\s*and annual_plan_id is null\s*\n\s*and stripe_invoice_id is null\)\s*\n\s*\)/);
});

/* ══════════════════════════════════════════════════════════════
   4. THE MONEY, AND THE ORDER THAT RECORDS IT
   ══════════════════════════════════════════════════════════════ */

test("4: the order keeps its discount columns and their pairing", () => {
  for (const kept of ["orders_discount_code_known", "orders_discount_code_paired"]) {
    assert.ok(!new RegExp(`drop constraint[^;]*${kept}`).test(statements), `057 drops ${kept}`);
    assert.ok(sql.includes(kept), `057 does not assert that ${kept} survived`);
  }
  assert.ok(!/drop column if exists discount_code/.test(statements), "057 drops orders.discount_code");
  assert.ok(!/drop column if exists discount_total_cents/.test(statements));
  assert.ok(!/drop column if exists discount_gross_cents/.test(statements));

  // An amount and a name, or neither - 056's rule, still in force.
  assert.match(applied056, /add constraint orders_discount_code_paired\s*\n\s*check \(\s*\n\s*\(discount_code is null and discount_total_cents = 0\)\s*\n\s*or \(discount_code is not null and discount_total_cents > 0\)\s*\n\s*\)/);
});

test("4b: the order writer no longer redeems anything", () => {
  for (const gone of [
    "redeem_launch_discount",
    "discount_claim_id",
    "v_redemption",
    "already_redeemed",
    "redemption_conflicts",
  ]) {
    assert.ok(!orderWriter.includes(gone), `the order writer still references ${gone}`);
  }
  // No claim telemetry, no invariant warning, nothing to interpret.
  assert.ok(!/raise warning/.test(orderWriter), "the order writer still warns about a claim");
  assert.match(migration, /No claim is spent, nothing is reserved/);
});

test("4c: and it still writes the discount onto the order", () => {
  // The two columns the accounting is made of, copied from the attempt
  // exactly as 056 copied them.
  assert.match(orderWriter, /discount_total_cents,\s*\n\s*discount_code,/);
  assert.match(orderWriter, /coalesce\(v_attempt\.discount_gross_cents, 0\),\s*\n\s*v_attempt\.discount_code,/);

  // A DISCOUNTED ATTEMPT MUST STILL BE ACCOUNTABLE - a code with no
  // amount, a non-positive amount or no address aborts the order rather
  // than writing a reduction nobody can explain.
  assert.match(orderWriter, /if v_attempt\.discount_code is not null\s*\n\s*and \(v_attempt\.customer_email is null\s*\n\s*or v_attempt\.discount_gross_cents is null\s*\n\s*or v_attempt\.discount_gross_cents <= 0\) then/);
  assert.match(orderWriter, /raise exception 'checkout attempt % carries discount code % without a customer email or a positive amount'/);
});

test("4d: SAME SIGNATURE, and 021's invariants are reproduced verbatim", () => {
  // A true in-place replacement: no second overload is left callable and
  // no caller changes. lib/orderFulfillment.ts passes exactly six
  // arguments and knows nothing about any of this.
  assert.match(orderWriter, /create or replace function public\.create_order_from_paid_checkout\(\s*\n\s*p_checkout_attempt_id uuid,\s*\n\s*p_customer_snapshot jsonb,\s*\n\s*p_stripe_payment_intent_id text,\s*\n\s*p_shipping_address_snapshot jsonb,\s*\n\s*p_billing_address_snapshot jsonb,\s*\n\s*p_shipping_gross_cents integer\s*\n\s*\)/);
  assert.match(orderWriter, /returns public\.orders/);
  assert.ok(!/p_discount/.test(orderWriter), "the RPC grew a discount argument the callers do not pass");
  assert.equal(
    (statements.match(/create or replace function public\.(\w+)/g) || []).length,
    1,
    "057 replaces more than the order writer"
  );
  assert.match(read("lib/orderFulfillment.ts"), /p_shipping_gross_cents: shippingGrossCents,/);

  for (const kept of [
    "raise exception 'checkout attempt % not found'",
    "raise exception 'checkout attempt % is not paid (status=%)'",
    "tax snapshot shipping (%) does not match the paid shipping (%) for attempt %",
    "tax snapshot total (%) does not match the expected total (%) for attempt %",
    "tax snapshot for attempt % has no line for variant %",
    "when unique_violation then",
    "for update;",
    "v_attempt.expected_total_gross_cents,",
    "insert into public.order_items (",
  ]) {
    assert.ok(orderWriter.includes(kept), `the RPC lost an invariant: ${kept}`);
  }
});

/* ══════════════════════════════════════════════════════════════
   5. SECURITY: THE DOORS ARE NOT LOCKED, THEY ARE GONE
   ══════════════════════════════════════════════════════════════ */

test("5: one function is left, and its ACL is stated rather than inherited", () => {
  // CREATE OR REPLACE keeps whatever privileges the function already
  // had, so this file must be able to say what that ACL IS. End state,
  // not a delta - the 052/053 lesson.
  assert.match(statements, /revoke all on function public\.create_order_from_paid_checkout\(uuid, jsonb, text, jsonb, jsonb, integer\)\s*\n\s*from public, anon, authenticated, service_role;\s*\n\s*grant execute on function public\.create_order_from_paid_checkout\(uuid, jsonb, text, jsonb, jsonb, integer\)\s*\n\s*to service_role;/);
  assert.match(orderWriter, /security definer/);
  assert.match(orderWriter, /set search_path = ''/);
});

test("5b: NOTHING is granted, and no browser can reach a discount anywhere", () => {
  // After 057 there is no launch-discount RPC of any kind for anybody to
  // call, which is the strongest form the security model can take.
  assert.ok(!/grant[^;]*to (anon|authenticated)/i.test(statements),
    "057 grants something to a browser role");
  assert.ok(!/grant[^;]*on table/i.test(statements), "057 grants a table privilege");
  assert.ok(!/enable row level security/i.test(statements), "057 adds an RLS object");

  // Exactly one grant in the whole file, and it is the order writer's.
  const grants = statements.match(/^grant [^;]+;/gm) || [];
  assert.equal(grants.length, 1, "057 hands out more than one privilege");
  assert.ok(grants[0].includes("create_order_from_paid_checkout"));
  assert.ok(grants[0].includes("to service_role"));

  // And the pre-commit block proves the browser roles cannot execute it.
  assert.match(sql, /raise exception '057: a browser role may execute the order writer/);
});

/* ══════════════════════════════════════════════════════════════
   6. THE NEW BUSINESS RULE, AND THE OLD ONE'S ABSENCE
   ══════════════════════════════════════════════════════════════ */

test("6: the reusable code is written down, in the file that implements it", () => {
  assert.match(migration, /GLOALAUNCH10 BECOMES A REUSABLE CODE/);
  assert.match(migration, /reuse {9}AS OFTEN AS THEY LIKE while it is active/);
  assert.match(migration, /first order\s+NO LONGER A CONDITION/);
  assert.match(migration, /one use\s+NO LONGER A CONDITION/);

  // The terms that did NOT change.
  assert.match(migration, /eligible {6}GLOA-MATCHA-30G, GLOA-MATCHA-50G, GLOA-MATCHA-100G/);
  assert.match(migration, /not eligible {2}subscriptions, the prepaid annual plan, B2B, the metal/);
  assert.match(migration, /free-shipping threshold is measured BEFORE the/);
  assert.match(migration, /01\.10\.2026 12:00 Europe\/Berlin \(CEST, \+02:00\)/);
  assert.match(migration, /31\.10\.2026 23:59:59\.999 Europe\/Berlin \(CET, \+01:00\)/);

  // And the window still agrees with the module that enforces it.
  assert.match(read("lib/launchDiscount.ts"), /LAUNCH_DISCOUNT_FROM_ISO = "2026-10-01T12:00:00\+02:00"/);
  assert.match(read("lib/launchDiscount.ts"), /LAUNCH_DISCOUNT_UNTIL_ISO = "2026-10-31T23:59:59\.999\+01:00"/);
  assert.match(read("lib/launchDiscount.ts"), /LAUNCH_DISCOUNT_CODE = "GLOALAUNCH10"/);
});

test("6b: nothing is backfilled, deleted or recalculated", () => {
  // 057 removes capacity, not data. Production carries 0 claims, 0
  // discounted attempts and 0 discounted orders.
  //
  // The order writer's own INSERTs are what that FUNCTION does at
  // runtime, not what this migration does to a table, so the ban is on
  // everything outside it - the same distinction 056's suite drew.
  const migrationBody = statements.replace(orderWriter, "");
  assert.ok(!/insert into/i.test(migrationBody), "057 inserts a row");
  assert.ok(!/^\s*update public\./m.test(migrationBody), "057 rewrites existing rows");
  assert.ok(!/delete from/i.test(migrationBody), "057 deletes rows");
  assert.ok(!/truncate/i.test(migrationBody), "057 truncates something");
  assert.match(sql, /raise exception '057: an attempt was backfilled with a discount code/);
  assert.match(sql, /raise exception '057: an order was backfilled with a discount code/);
  assert.match(sql, /raise exception '057: an order was backfilled with a discount amount/);
});

test("6c: NO SUBSCRIPTION, ANNUAL, B2B, CATALOGUE OR PRICE IS TOUCHED", () => {
  for (const banned of [
    "public.subscriptions", "public.annual_plans", "public.b2c_subscription_plans",
    "public.stripe_customers", "public.b2b_", "public.annual_deliveries",
    "public.product_variants", "public.products", "public.inventory",
    "public.launch_waitlist", "public.admin_activity_log",
    "public.checkout_customer_identities", "public.order_items",
  ]) {
    // order_items appears inside the order writer's own INSERT, which is
    // 021's and unchanged - so the ban is on the MIGRATION's statements
    // outside that function.
    const outsideWriter = statements.replace(orderWriter, "");
    assert.ok(!outsideWriter.includes(banned), `057 touches ${banned}`);
  }
  for (const banned of [
    "settle_annual", "record_paid_subscription_period", "sync_subscription_from_stripe",
    "apply_order_refund_state", "mark_subscription_cancelled",
    "claim_annual_delivery", "record_admin_activity",
  ]) {
    assert.ok(!statements.includes(banned), `057 redefines ${banned}`);
  }
  assert.ok(!/price/i.test(statements.replace(orderWriter, "")), "057 declares a price of its own");
  assert.match(read("app/content.ts"), /export const SHOP_STATUS = "prelaunch" as const;/);
  assert.match(read("lib/shipping.ts"), /germany: \{ shippingGrossCents: 590, freeShippingThresholdGrossCents: 4900 \}/);
});

/* ══════════════════════════════════════════════════════════════
   7. STILL DATABASE ONLY
   ══════════════════════════════════════════════════════════════ */

test("7: NOT ONE LINE OF THE CLAIM ARCHITECTURE SURVIVES IN THE RUNTIME", () => {
  // THE PHASE BOUNDARY, MOVED DELIBERATELY. When 057 landed, nothing in
  // this repository read a discount column - the whole feature was
  // schema. The runtime package then wired the reusable code in, so
  // this assertion changed shape: what it forbids is no longer "the
  // discount" but the ONE-USE MACHINERY, which the database no longer
  // has and the application must never grow a private copy of.
  const SOURCES = [
    "lib/launchDiscount.ts",
    "lib/launchDiscountCart.ts",
    "lib/checkoutAttempts.ts",
    "lib/checkoutQuote.ts",
    "lib/checkoutIdentity.ts",
    "lib/checkoutCustomerIdentity.ts",
    "lib/checkoutCustomerIdentityDeps.ts",
    "lib/orderFulfillment.ts",
    "lib/stripeFulfillment.ts",
    "lib/adminOrdersQuery.ts",
    "app/api/checkout/session/route.ts",
    "app/api/checkout/quote/route.ts",
    "app/api/stripe/webhook/route.ts",
    "app/createCheckoutSession.ts",
    "app/checkoutQuote.ts",
    "app/GloaSite.tsx",
    "app/AccountPortal.tsx",
    "app/AdminOrders.tsx",
  ];
  const GONE = [
    "launch_discount_claims",
    "claim_launch_discount",
    "release_launch_discount",
    "mark_launch_discount",
    "redeem_launch_discount",
    "launch_discount_is_first_order",
    "discount_claim_id",
    "isFirstOrder",
    "not_first_order",
    "already_redeemed",
  ];
  for (const rel of SOURCES) {
    const code = readCode(rel);
    for (const object of GONE) {
      assert.ok(!code.includes(object), `${rel} still carries ${object} - 057 removed that rule`);
    }
  }

  // AND NO APPLICATION CODE TALKS TO THE CLAIM LEDGER, because there is
  // no ledger: no RPC name, no table name, anywhere under lib/ or app/.
  const everything = [...SOURCES].map(readCode).join("\n");
  assert.ok(!/\.rpc\(\s*"(claim|redeem|mark|release)_launch/.test(everything),
    "application code calls a claim RPC");

  // And the strict Stripe amount check the whole feature is shaped
  // around is untouched.
  assert.match(read("lib/stripeFulfillment.ts"), /session\.amount_total !== attempt\.expected_total_gross_cents/);
});

test("7b: the pure engine has lost the rule 057 removed from the database", () => {
  // 057 dropped the first-order query and the one-use ledger; the
  // runtime package then took the matching argument out of the engine,
  // so the schema and the code now describe the same offer. An engine
  // that could still answer "not your first order" would be a second,
  // private copy of a rule nothing enforces.
  const engine = read("lib/launchDiscount.ts");
  assert.ok(!engine.includes("isFirstOrder"), "the engine still takes a first-order answer");
  assert.ok(!engine.includes("not_first_order"), "the engine can still refuse a repeat customer");
  assert.match(engine, /export function decideLaunchDiscount\(input: \{\s*\n\s*code: unknown;\s*\n\s*nowMs: number;\s*\n\s*subtotalGrossCents: number;\s*\n\s*\}\)/);

  // What it still owns is the offer itself.
  assert.match(engine, /LAUNCH_DISCOUNT_CODE = "GLOALAUNCH10"/);
  assert.match(engine, /LAUNCH_DISCOUNT_PERCENT = 10/);
  assert.match(engine, /FREE_SHIPPING_MEASURED_BEFORE_DISCOUNT = true/);
});

test("7c: it carries its own read-only verification", () => {
  assert.match(migration, /VERIFYING THIS MIGRATION, read-only:/);
  assert.match(migration, /THE CLAIM ARCHITECTURE IS GONE/);
  assert.match(migration, /THE MONEY SURVIVED/);
  assert.match(migration, /AND IT NO LONGER REDEEMS ANYTHING/);
  assert.match(migration, /select count\(\*\) from public\.orders;\s*-> unchanged \(458\)/);
  assert.match(migration, /select count\(\*\) from public\.checkout_attempts;\s*-> unchanged \(729\)/);
  assert.match(migration, /where discount_code is not null;\s*-> 0/);
});
