import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// SAFE DEFAULT SUITE (Phase 3K.B): static SQL and source inspection only.
// No database is opened, no SQL is executed, no Supabase client is
// constructed, no Stripe API is called, no email is sent and no network
// is touched. Nothing here applies migration 038 or calls the function
// it reviews. The only child process it starts is git, which is local.
//
// What this suite protects: a one-time refund reaches the order that was
// actually paid with that payment intent, or it reaches nothing at all -
// and it can never report 'applied' for a write that did not happen.

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf-8");
const NEWLINE = String.fromCharCode(10);
const MIGRATIONS_DIR = path.join(ROOT, "supabase/migrations");

const MIGRATION_038 = "038_one_time_refund_writer_concurrency.sql";
const MIGRATION_039 = "039_b2c_annual_plan_foundation.sql";
const MIGRATION_040 = "040_annual_checkout_retry_fingerprints.sql";
const MIGRATION_041 = "041_annual_account_column_privileges.sql";
const MIGRATION_042 = "042_annual_delivery_rls_parent_user_privilege.sql";
const MIGRATION_037 = "037_subscription_refund_correlation.sql";
const MIGRATION_019 = "019_order_lifecycle_tracking.sql";

const withoutComments = source => source
  .split(NEWLINE)
  .filter(line => !line.trim().startsWith("--"))
  .join(NEWLINE);

const sql038Source = read(`supabase/migrations/${MIGRATION_038}`);
const sql038 = withoutComments(sql038Source);

/** One function definition, comment-stripped, from its header to its terminator. */
const functionOf = (source, name) => {
  const body = withoutComments(source);
  const from = body.indexOf(`create or replace function public.${name}(`);
  assert.notEqual(from, -1, `function not found: ${name}`);
  const to = body.indexOf("$$;", from);
  assert.ok(to > from, `function not terminated: ${name}`);
  return body.slice(from, to);
};

const fn038 = functionOf(sql038Source, "apply_order_refund_state");

/**
 * The executable half: everything from BEGIN onward. `v_order public.orders`
 * in the DECLARE block is a type reference, not a read of the table, and
 * must never be counted as one.
 */
const body038 = fn038.slice(fn038.indexOf("begin"));
const fn019 = functionOf(read(`supabase/migrations/${MIGRATION_019}`), "apply_order_refund_state");
const fn037 = functionOf(read(`supabase/migrations/${MIGRATION_037}`), "apply_order_refund_state_by_invoice");

/** Everything in 038 that is NOT inside the function body. */
const outsideTheFunction = (() => {
  const from = sql038.indexOf("as $$");
  const to = sql038.indexOf("$$;");
  assert.ok(from > 0 && to > from, "the function body was not found");
  return sql038.slice(0, from) + sql038.slice(to + "$$;".length);
})();

const LOCK = "lock table public.orders in exclusive mode;";
const at = needle => {
  const i = fn038.indexOf(needle);
  assert.notEqual(i, -1, `missing from the function: ${needle}`);
  return i;
};

/**
 * Every point in the function at which a refund business decision is
 * taken or written. Not one of them may be reachable before the table
 * lock, the cardinality proof and the post-select FOUND guard.
 */
const REFUND_DECISIONS = [
  "if v_order.payment_status not in",
  "return 'not_applicable';",
  "return 'invalid_amount';",
  "v_new_status := 'refunded';",
  "v_new_status := 'partially_refunded';",
  "v_new_status := 'refund_pending';",
  "return 'unchanged';",
  "update public.orders",
  "return 'applied';",
];

/* ══════════════════════════════════════════════════════════════
   1-5. THE MIGRATION SET
   ══════════════════════════════════════════════════════════════ */

test("1: 038 exists, owns its number, and 039 is the only one above it", () => {
  const files = readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith(".sql")).sort();
  assert.ok(files.includes(MIGRATION_038), "migration 038 is missing");
  assert.deepEqual(files.filter(f => f.startsWith("038")), [MIGRATION_038]);
  // Phase 4B1 added 039, the B2C prepaid annual plan foundation, reviewed
  // in tests/annual-plan-foundation-migration.test.mjs. 038 is therefore
  // no longer the highest, and this is re-pinned rather than deleted:
  // what it protects is that no UNREVIEWED migration appeared.
  assert.equal(files[files.length - 4], MIGRATION_039, "039 must be the highest");
  assert.equal(files[files.length - 5], MIGRATION_038, "038 must be the one before it");
  assert.equal(files[files.length - 6], MIGRATION_037, "037 must be the one before that");
  // No number is used twice.
  const numbers = files.map(f => f.slice(0, 3));
  assert.equal(new Set(numbers).size, numbers.length, "a migration number is used twice");
});

test("2: no migration 043 or beyond", () => {
  // Phase 4B3.2 added 040, the annual checkout retry fingerprints,
  // reviewed in tests/annual-plan-checkout.test.mjs.
  const beyond = readdirSync(MIGRATIONS_DIR).filter(f => Number(f.slice(0, 3)) > 38).sort();
  // Phase 4B8.1 added 041, column-level privileges on the two annual
  // tables, reviewed in tests/annual-account-privileges-migration.test.mjs.
  assert.deepEqual(beyond, [MIGRATION_039, MIGRATION_040, MIGRATION_041, MIGRATION_042],
    "an unreviewed migration appeared after 041");
  // And 039 kept its hands off this phase's writer entirely.
  for (const name of [MIGRATION_039, MIGRATION_040, MIGRATION_041, MIGRATION_042]) {
    const sql = read(`supabase/migrations/${name}`);
    assert.ok(!sql.includes("function public.apply_order_refund_state("),
      `${name} redefined the one-time refund writer`);
    assert.ok(!/alter\s+table\s+public\.orders/i.test(sql),
      `${name} altered public.orders`);
  }
});

test("3, 4, 5: migrations 019 and 022 through 037 are unmodified", () => {
  const changed = execFileSync("git", ["diff", "--name-only", "HEAD", "--", "supabase/migrations/"],
    { cwd: ROOT, encoding: "utf-8" }).trim();
  const touched = changed ? changed.split(NEWLINE) : [];
  // 038 itself may be edited while it is still unapplied - that is the
  // whole reason it is not a 039. Everything BELOW it is live and
  // immutable, and that is what this guard is for.
  // Phase 4B1.1 note: 039 is the annual plan foundation and it has NOT
  // been applied anywhere, so it is still the right place to fix 039 and
  // it may be edited in place. Everything below it is live.
  // 040 is NOT APPLIED yet, so it may still be edited in place; every
  // migration below it is live and may not be.
  const immutable = touched.filter(rel =>
    !rel.endsWith(MIGRATION_038) && !rel.endsWith(MIGRATION_039)
    && !rel.endsWith(MIGRATION_040));
  assert.deepEqual(immutable, [], "a live, immutable migration was edited");
  // And the two this phase reasons about still read the way they were applied.
  assert.ok(read(`supabase/migrations/${MIGRATION_019}`)
    .includes("create or replace function public.apply_order_refund_state("));
  assert.ok(read(`supabase/migrations/${MIGRATION_037}`)
    .includes("create or replace function public.apply_order_refund_state_by_invoice("));
});

/* ══════════════════════════════════════════════════════════════
   6-11. THE CAPABILITY IS THE SAME CAPABILITY
   ══════════════════════════════════════════════════════════════ */

test("6, 7: the signature and return type are 019's, character for character", () => {
  const header = fn => {
    const to = fn.indexOf("as $$");
    return fn.slice(0, to).replace(/\s+/g, " ").trim();
  };
  assert.equal(header(fn038), header(fn019), "038 changed the function's shape");
  assert.ok(header(fn038).includes("returns text"));
  // Three parameters, in order, and nothing else.
  assert.ok(fn038.includes("p_payment_intent_id   text,"));
  assert.ok(fn038.includes("p_refunded_total_cents integer,"));
  assert.ok(fn038.includes("p_has_pending_refund  boolean"));
});

test("8, 9, 10, 11: plpgsql, volatile, security definer, empty search_path", () => {
  assert.ok(fn038.includes("language plpgsql"));
  assert.ok(fn038.includes("volatile"));
  assert.ok(fn038.includes("security definer set search_path = ''"));
  assert.ok(!/security\s+invoker/i.test(fn038), "the writer became security invoker");
  // With an empty search_path every object must be schema-qualified.
  for (const bare of ["from orders", "into orders", "update orders", "lock table orders"]) {
    assert.ok(!fn038.includes(bare), `unqualified object reference: ${bare}`);
  }
  // Four executable references: the lock, the count, the select, the update.
  assert.equal((body038.match(/public\.orders/g) ?? []).length, 4,
    "the function touches public.orders a different number of times");
  assert.ok(fn038.includes("v_order       public.orders;"), "the row variable changed type");
});

test("12: input validation is 019's, character for character", () => {
  const validation = fn => {
    const from = fn.indexOf("if p_payment_intent_id is null");
    const to = fn.indexOf("return 'invalid_input'");
    assert.ok(from !== -1 && to > from, "the validation region was not found");
    return fn.slice(from, to).replace(/\s+/g, " ").trim();
  };
  assert.equal(validation(fn038), validation(fn019), "038 changed what counts as bad input");
  assert.ok(validation(fn038).includes("btrim(p_payment_intent_id) = ''"));
  assert.ok(validation(fn038).includes("p_refunded_total_cents < 0"));
});

test("12b: the comparison is still the RAW parameter, not a normalised one", () => {
  // 019 validates with btrim but COMPARES the raw parameter. Quietly
  // trimming here would change which rows match, and this is a
  // concurrency phase, not an identifier-normalisation phase.
  const comparisons = [...fn038.matchAll(/where stripe_payment_intent_id = ([a-z_]+)/g)].map(m => m[1]);
  assert.deepEqual(comparisons, ["p_payment_intent_id", "p_payment_intent_id"],
    "the payment intent comparison was normalised or changed");
  assert.ok(!fn038.includes("v_payment_intent_id"), "a normalised copy of the identifier appeared");
});

/* ══════════════════════════════════════════════════════════════
   13-16. THE TABLE LOCK
   ══════════════════════════════════════════════════════════════ */

test("13: the table lock exists, and it is EXCLUSIVE", () => {
  assert.ok(fn038.includes(LOCK), "the table lock is missing or is not EXCLUSIVE");
  assert.equal((fn038.match(/lock table/g) ?? []).length, 1, "more than one table lock");
});

test("13b: neither SHARE nor SHARE ROW EXCLUSIVE is used", () => {
  // SHARE is self-compatible, so two invocations hold it at once and then
  // deadlock upgrading to the ROW EXCLUSIVE their own UPDATE needs.
  //
  // SHARE ROW EXCLUSIVE fixes that but still ALLOWS ROW SHARE, which is
  // what SELECT ... FOR UPDATE takes - so one of the five live
  // row-locking order workflows can hold a row this function is about to
  // select, wait for ROW EXCLUSIVE behind this function's table lock, and
  // close a cross-RPC cycle. EXCLUSIVE blocks ROW SHARE, so that
  // transaction waits before it holds anything.
  assert.ok(!/in share mode/i.test(fn038), "the lock was weakened to SHARE, which self-deadlocks");
  assert.ok(!/in share row exclusive mode/i.test(fn038),
    "the lock was weakened to SHARE ROW EXCLUSIVE, which allows ROW SHARE and deadlocks cross-RPC");
  assert.ok(!/in share update exclusive mode/i.test(fn038),
    "the lock does not block DML at all");
  assert.ok(!/in access exclusive mode/i.test(fn038), "the lock blocks plain readers");
  assert.ok(!/nowait/i.test(fn038), "the lock refuses to wait, turning contention into an error");
  // The reasoning is written down where the next reader will find it.
  assert.ok(sql038Source.includes("SHARE MODE WAS EVALUATED FIRST AND IS REJECTED"),
    "the SHARE decision is not explained in the migration");
  assert.ok(sql038Source.includes("SHARE ROW EXCLUSIVE WAS EVALUATED SECOND AND IS ALSO REJECTED"),
    "the SHARE ROW EXCLUSIVE decision is not explained in the migration");
  assert.ok(sql038Source.includes("EXCLUSIVE IS THE NARROWEST MODE THAT IS CORRECT"),
    "the chosen mode is not justified in the migration");
});

test("13c: the chosen mode blocks every lock that can start a cycle here", () => {
  // The conflict facts this design rests on, written down as a table so a
  // future reader does not have to rederive them. A held EXCLUSIVE blocks
  // ROW SHARE, ROW EXCLUSIVE and EXCLUSIVE, and allows ACCESS SHARE.
  const rationale = sql038Source;
  for (const fact of [
    "INSERT / UPDATE / DELETE   ROW EXCLUSIVE   BLOCKED",
    "SELECT ... FOR UPDATE      ROW SHARE       BLOCKED",
    "another call to this fn    EXCLUSIVE       BLOCKED",
    "plain SELECT               ACCESS SHARE    allowed",
  ]) {
    assert.ok(rationale.includes(fact), `the conflict table lost a row: ${fact}`);
  }
  // And the five live row-locking order workflows this protects against
  // are named, so the next person to add a sixth sees the constraint.
  for (const fn of [
    "request_order_cancellation", "cancel_order", "resolve_order_cancellation_request",
    "mark_order_shipped", "apply_order_refund_state_by_invoice",
  ]) {
    assert.ok(rationale.includes(fn), `the cross-RPC inventory lost: ${fn}`);
  }
});

test("13d: every named cross-RPC workflow really is a row-locking orders writer", () => {
  // The migration's argument is only as good as its inventory, so the
  // inventory is checked against the migrations rather than trusted.
  const live = {
    request_order_cancellation: "019_order_lifecycle_tracking.sql",
    cancel_order: "029_authorized_order_cancellation.sql",
    resolve_order_cancellation_request: "031_cancellation_request_resolution.sql",
    mark_order_shipped: "032_open_cancellation_request_shipment_guard.sql",
    apply_order_refund_state_by_invoice: "037_subscription_refund_correlation.sql",
  };
  for (const [name, file] of Object.entries(live)) {
    const source = withoutComments(read(`supabase/migrations/${file}`));
    const from = source.indexOf(`create or replace function public.${name}(`);
    assert.notEqual(from, -1, `${name} is not defined in ${file}`);
    const fn = source.slice(from, source.indexOf("$$;", from));
    const lockAt = fn.indexOf("for update;");
    const updateAt = fn.indexOf("update public.orders");
    assert.ok(lockAt > 0, `${name} takes no row lock`);
    assert.ok(updateAt > lockAt,
      `${name} no longer locks an orders row before updating orders`);
    assert.ok(fn.slice(0, lockAt).includes("from public.orders"),
      `${name} locks a row in a different table`);
  }
});

test("14: the table lock happens AFTER input validation", () => {
  const invalidInput = at("return 'invalid_input';");
  assert.ok(invalidInput < at(LOCK),
    "a malformed call stalls every write to orders before being refused");
});

test("15: the table lock happens BEFORE the cardinality query", () => {
  assert.ok(at(LOCK) < at("select count(*) into v_match_count"),
    "the count is taken in a snapshot that other writers can still move");
});

test("16: no refund-state decision sits before the table lock", () => {
  const lockAt = at(LOCK);
  for (const decision of REFUND_DECISIONS) {
    assert.ok(at(decision) > lockAt, `a refund decision runs before the lock: ${decision}`);
  }
  // And nothing at all reads public.orders before the lock. Measured on
  // the executable body, so the row variable's type declaration - which
  // reads nothing - is not mistaken for a query.
  const beforeLock = body038.slice(0, body038.indexOf(LOCK));
  assert.ok(!beforeLock.includes("public.orders"), "the table is read before it is locked");
});

/* ══════════════════════════════════════════════════════════════
   17-20. CARDINALITY
   ══════════════════════════════════════════════════════════════ */

test("17: zero matches returns order_not_found", () => {
  const zero = fn038.indexOf("if v_match_count = 0 then");
  assert.notEqual(zero, -1, "the zero-match branch is missing");
  const body = fn038.slice(zero, fn038.indexOf("end if;", zero));
  assert.ok(body.includes("return 'order_not_found';"));
});

test("18: more than one match returns ambiguous_payment_intent", () => {
  const many = fn038.indexOf("if v_match_count > 1 then");
  assert.notEqual(many, -1, "the ambiguity branch is missing");
  const body = fn038.slice(many, fn038.indexOf("end if;", many));
  assert.ok(body.includes("return 'ambiguous_payment_intent';"));
});

test("19: an ambiguous group can never reach row selection", () => {
  // The refusal is returned BEFORE any row is selected for business use,
  // so no arbitrary member of the group is read, let alone written.
  assert.ok(at("return 'ambiguous_payment_intent';") < at("select * into v_order"),
    "a row is selected before ambiguity is refused");
  for (const decision of REFUND_DECISIONS) {
    assert.ok(at(decision) > at("return 'ambiguous_payment_intent';"),
      `a refund decision runs before ambiguity is refused: ${decision}`);
  }
});

test("20: exactly one match continues, and the count is over the whole predicate", () => {
  assert.ok(fn038.includes("select count(*) into v_match_count"));
  const count = fn038.slice(at("select count(*) into v_match_count"), at("if v_match_count = 0 then"));
  assert.ok(count.includes("from public.orders"));
  assert.ok(count.includes("where stripe_payment_intent_id = p_payment_intent_id"));
  // A capped or ordered count would answer a different question.
  assert.ok(!/limit/i.test(count), "the cardinality query is capped");
  assert.ok(!/order by/i.test(count), "the cardinality query is ordered");
});

/* ══════════════════════════════════════════════════════════════
   21-24. THE ROW, AND THE GUARD THAT MAKES THE LOCK MEAN SOMETHING
   ══════════════════════════════════════════════════════════════ */

test("21: the matching order is selected FOR UPDATE", () => {
  const select = fn038.slice(at("select * into v_order"), at("if not found then"));
  assert.ok(select.includes("from public.orders"));
  assert.ok(select.includes("where stripe_payment_intent_id = p_payment_intent_id"));
  assert.ok(select.includes("for update"), "the row is read without being locked");
});

test("22, 23: a FOUND guard follows immediately and returns order_not_found", () => {
  const selectAt = at("select * into v_order");
  const guardAt = at("if not found then");
  assert.ok(guardAt > selectAt, "the guard does not follow the select");
  // Nothing executable between them.
  const between = fn038.slice(selectAt, guardAt);
  assert.equal(between.split(";").length - 1, 1,
    "a statement sits between the locked select and its guard");
  const guard = fn038.slice(guardAt, fn038.indexOf("end if;", guardAt));
  assert.ok(guard.includes("return 'order_not_found';"));
  assert.equal((fn038.match(/if not found then/g) ?? []).length, 1, "the FOUND guard count changed");
});

test("24: no refund-state decision runs before the FOUND guard", () => {
  const guardAt = at("if not found then");
  for (const decision of REFUND_DECISIONS) {
    assert.ok(at(decision) > guardAt, `a refund decision runs before the guard: ${decision}`);
  }
});

test("24b: the row is never chosen arbitrarily", () => {
  // Every mechanism that would turn an ambiguous answer into a confident
  // one. SELECT INTO STRICT is also absent: it raises, and every expected
  // refusal here has to be a word the webhook can log and acknowledge.
  assert.ok(!/order by/i.test(fn038), "the function orders rows to pick one");
  assert.ok(!/limit\s+1/i.test(fn038), "the function takes the first of several rows");
  assert.ok(!/into strict/i.test(fn038), "the function raises instead of returning");
  assert.ok(!/distinct on/i.test(fn038), "the function collapses rows to pick one");
});

test("24c: the locked row is the one that gets written", () => {
  const update = fn038.slice(at("update public.orders"));
  assert.ok(update.includes("where id = v_order.id;"),
    "the update does not target the locked row by its primary key");
});

/* ══════════════════════════════════════════════════════════════
   25-30. MIGRATION 019 PARITY
   ══════════════════════════════════════════════════════════════ */

test("25: exactly seven result words, and they are 019's seven", () => {
  const words = fn => [...new Set([...fn.matchAll(/return '(\w+)'/g)].map(m => m[1]))].sort();
  const expected = [
    "ambiguous_payment_intent", "applied", "invalid_amount", "invalid_input",
    "not_applicable", "order_not_found", "unchanged",
  ];
  assert.deepEqual(words(fn019), expected, "019's vocabulary is not what this phase assumed");
  assert.deepEqual(words(fn038), expected, "038 invented or dropped a result word");
  assert.equal(words(fn038).length, 7);
});

/** The transition region of a refund function: from the eligibility gate to 'applied'. */
const transitionOf = fn => {
  const from = fn.indexOf("if v_order.payment_status not in");
  const to = fn.indexOf("return 'applied'");
  assert.ok(from !== -1 && to > from, "the transition region was not found");
  return fn.slice(from, to + "return 'applied'".length).replace(/\s+/g, " ").trim();
};

test("26: THE PARITY PROOF - 038's transition is 019's, character for character", () => {
  // Not a keyword spot-check. The whole region, comment-stripped and
  // whitespace-collapsed, must be identical - and identical to 037's too,
  // so a one-time order and a subscription order can never reach
  // different payment states from the same facts.
  assert.equal(transitionOf(fn038), transitionOf(fn019), "038 invented a different state machine");
  assert.equal(transitionOf(fn038), transitionOf(fn037), "the three writers disagree");
  assert.equal(transitionOf(fn019).length, 861, "the transition region changed size");
});

test("27: the eligible statuses are 019's four, not widened", () => {
  const gate = "if v_order.payment_status not in ('paid', 'refund_pending', 'partially_refunded', 'refunded') then";
  assert.ok(fn019.includes(gate), "019's gate changed");
  assert.ok(fn038.includes(gate));
  assert.ok(fn038.includes("return 'not_applicable';"));
});

test("28: the amount cap is unchanged and never clamps", () => {
  assert.ok(fn038.includes("if p_refunded_total_cents > v_order.total_gross_cents then"));
  assert.ok(fn038.includes("return 'invalid_amount';"));
  assert.ok(!/least\(|greatest\(/i.test(fn038), "the function clamps an out-of-range total");
});

test("29: the status ladder is unchanged, in order", () => {
  const ladderAt = [
    "v_new_status := 'refunded';",
    "v_new_status := 'partially_refunded';",
    "v_new_status := 'refund_pending';",
    "v_new_status := 'paid';",
  ].map(at);
  assert.deepEqual([...ladderAt].sort((a, b) => a - b), ladderAt, "the ladder was reordered");
  assert.ok(fn038.includes("p_refunded_total_cents >= v_order.total_gross_cents and v_order.total_gross_cents > 0"));
  assert.ok(fn038.includes("coalesce(p_has_pending_refund, false)"));
});

test("30: the unchanged check is still NULL-safe", () => {
  assert.ok(fn038.includes("v_order.refunded_total_cents is not distinct from p_refunded_total_cents"),
    "a plain = would treat the first refund on an order as a no-op");
  assert.ok(fn038.includes("return 'unchanged';"));
});

/* ══════════════════════════════════════════════════════════════
   31-36. WHAT IS WRITTEN, AND WHAT IS NOT
   ══════════════════════════════════════════════════════════════ */

test("31: exactly three columns are written, and refund_updated_at only on applied", () => {
  const update = fn038.slice(at("update public.orders"), at("return 'applied';"));
  const columns = [...update.matchAll(/(\w+)\s*=\s*/g)].map(m => m[1]).filter(c => c !== "id");
  assert.deepEqual(columns, ["payment_status", "refunded_total_cents", "refund_updated_at"],
    "the refund writer writes a different set of columns");
  assert.ok(update.includes("refund_updated_at    = now()"));
  assert.equal((fn038.match(/update public\.orders/g) ?? []).length, 1, "more than one UPDATE");
  // Nothing outside the refund triple.
  for (const forbidden of [
    "refund_email_status", "refund_email_sent_at", "refund_email_notified_total_cents",
    "confirmation_email_status", "shipped_at", "cancelled_at", "cancellation_",
    "customer_snapshot", "shipping_address_snapshot", "billing_address_snapshot",
    "total_gross_cents =", "tax_", "order_number", "checkout_attempt_id =",
    "stripe_checkout_session_id", "subscription",
  ]) {
    assert.ok(!fn038.includes(forbidden), `038 reaches beyond the refund state: ${forbidden}`);
  }
});

test("32: 'applied' exists exactly once, and only past every guard", () => {
  assert.equal((fn038.match(/return 'applied';/g) ?? []).length, 1);
  assert.ok(at("return 'applied';") > at("if not found then"));
  assert.ok(at("return 'applied';") > at(LOCK));
  assert.ok(at("return 'applied';") > at("update public.orders"),
    "'applied' is returned before the write it reports");
});

test("33: no unique index, no unique constraint, no exclusion constraint", () => {
  assert.ok(!/create\s+unique\s+index/i.test(sql038), "038 creates a unique index");
  assert.ok(!/\bunique\s*\(/i.test(sql038), "038 adds a unique constraint");
  assert.ok(!/\bexclude\b/i.test(sql038), "038 adds an exclusion constraint");
  assert.ok(!/add\s+constraint/i.test(sql038), "038 adds a constraint");
  // The reason is written down: Production already holds duplicates.
  assert.ok(sql038Source.includes("IT IS NOT VALID AGAINST THIS DATABASE"),
    "the reason a unique index is impossible is not recorded");
});

test("34: no ordinary index either", () => {
  assert.ok(!/create\s+(unique\s+)?index/i.test(sql038), "038 creates an index");
});

test("35: no data is read or written outside the function definition", () => {
  for (const dml of [
    "insert into", "update public.", "delete from", "truncate", "select ",
    "alter table", "create table", "create trigger", "create policy", "drop ",
  ]) {
    assert.ok(!outsideTheFunction.toLowerCase().includes(dml),
      `038 performs work outside the function definition: ${dml}`);
  }
  // What IS outside is exactly the definition and the privilege block.
  const statements = outsideTheFunction.split(";").map(s => s.trim()).filter(Boolean);
  for (const statement of statements) {
    assert.ok(/^(create or replace function|revoke|grant)/i.test(statement),
      `unexpected statement in 038: ${statement.slice(0, 60)}`);
  }
});

test("36: the function is not called during the migration", () => {
  assert.ok(!/select\s+public\.apply_order_refund_state/i.test(sql038), "038 calls the writer");
  assert.ok(!/perform\s+public\.apply_order_refund_state/i.test(sql038), "038 calls the writer");
  assert.ok(!/\bdo\s+\$\$/i.test(sql038), "038 runs an anonymous block");
});

test("36b: the 41 duplicate orders are neither identified nor touched", () => {
  // The group is described in prose so the next reader understands the
  // refusal path. No stored value, no order id and no customer appears.
  assert.ok(!/pi_[A-Za-z0-9]/.test(sql038Source), "a payment intent literal is embedded in the migration");
  assert.ok(!/'[0-9a-f]{8}-[0-9a-f]{4}/i.test(sql038Source), "a uuid is embedded in the migration");
  assert.ok(!/\bwhere\b[^;]*\bin\s*\(/i.test(sql038), "038 targets a specific set of rows");
});

/* ══════════════════════════════════════════════════════════════
   37-42. WHO MAY EXECUTE IT
   ══════════════════════════════════════════════════════════════ */

const SIGNATURE = "public.apply_order_refund_state(text, integer, boolean)";

test("37, 38, 39: PUBLIC, anon and authenticated are revoked", () => {
  for (const role of ["public", "anon", "authenticated"]) {
    assert.ok(sql038.includes(`revoke all on function ${SIGNATURE} from ${role};`),
      `${role} is not revoked`);
    assert.ok(!sql038.includes(`grant execute on function ${SIGNATURE} to ${role};`),
      `${role} can execute the security definer writer`);
  }
});

test("40: service_role is revoked first, then granted EXECUTE only", () => {
  const revokeAt = sql038.indexOf(`revoke all on function ${SIGNATURE} from service_role;`);
  const grantAt = sql038.indexOf(`grant execute on function ${SIGNATURE} to service_role;`);
  assert.notEqual(revokeAt, -1, "service_role is not revoked");
  assert.notEqual(grantAt, -1, "service_role cannot execute");
  assert.ok(revokeAt < grantAt, "the grant is discarded by a later revoke");
  assert.equal((sql038.match(/grant /g) ?? []).length, 1, "038 grants something else as well");
});

test("41: no table grant is widened", () => {
  assert.ok(!/grant[^;]*on\s+(table\s+)?public\.orders/i.test(sql038), "038 widens a table grant");
  assert.ok(!/grant[^;]*to\s+(anon|authenticated|public)\b/i.test(sql038), "038 grants a browser role");
  for (const forbidden of ["alter default privileges", "create role", "alter role", "security label"]) {
    assert.ok(!sql038.toLowerCase().includes(forbidden), `038 changes the role model: ${forbidden}`);
  }
});

test("42: the function takes no order id, and no local identifier at all", () => {
  const header = fn038.slice(0, fn038.indexOf("as $$"));
  assert.ok(!/uuid/i.test(header), "the writer accepts a uuid");
  assert.ok(!/p_order_id/i.test(fn038), "the writer accepts an order id");
  // Mutation authority stays the payment intent, resolved by the database.
  assert.equal((header.match(/p_/g) ?? []).length, 3, "the parameter count changed");
});

/* ══════════════════════════════════════════════════════════════
   43-50. BLAST RADIUS
   ══════════════════════════════════════════════════════════════ */

const changedFiles = () => {
  const changed = execFileSync("git", ["diff", "--name-only", "HEAD"], { cwd: ROOT, encoding: "utf-8" }).trim();
  return changed ? changed.split(NEWLINE) : [];
};

test("43: the refund runtime is untouched - this is a migration-only phase", () => {
  const touched = changedFiles();
  // app/api/stripe/webhook/route.ts left this list in Phase 4B4, which
  // added an annual settlement branch to the one canonical webhook. The
  // subject of this guard is the REFUND RUNTIME, and the route's refund
  // wiring is asserted directly against the source below - which is the
  // stronger check anyway, since it also holds after a commit.
  for (const rel of [
    "lib/orderRefunds.ts", "lib/stripeRefunds.ts", "lib/refundConfirmationEmail.ts",
    "lib/refundConfirmationRules.ts", "lib/email/refundConfirmation.ts",
  ]) {
    assert.ok(!touched.includes(rel), `${rel} was modified by a migration-only phase`);
  }
  const webhook = read("app/api/stripe/webhook/route.ts");
  assert.ok(webhook.includes("isRefundEventType(event.type)"), "the refund discriminator left the webhook");
  assert.ok(webhook.includes("await handleRefundEvent(stripe, event);"), "the refund branch left the webhook");
  // And the runtime still calls the same name and signature, so 038 is
  // transparent to it.
  assert.ok(read("lib/orderRefunds.ts").includes('admin.rpc("apply_order_refund_state"'));
  assert.ok(read("lib/orderRefunds.ts").includes("p_payment_intent_id: trimmedId"));
});

test("44: the subscription refund writer is untouched", () => {
  assert.ok(!sql038.includes("apply_order_refund_state_by_invoice"),
    "038 reaches into the subscription writer");
  assert.ok(!sql038.includes("checkout_attempts"), "038 reaches into the invoice correlation");
  assert.ok(read("lib/orderRefunds.ts").includes('admin.rpc("apply_order_refund_state_by_invoice"'),
    "the subscription fallback stopped using 037");
});

test("45: refund email semantics are untouched", () => {
  const key = read("lib/email/refundConfirmation.ts");
  assert.ok(key.includes("gloa/refund/"), "the provider key changed");
  assert.ok(read("lib/refundConfirmationEmail.ts").includes("customer_snapshot"),
    "the recipient authority changed");
  assert.ok(read("lib/refundConfirmationRules.ts").includes('syncResult === "applied"'),
    "the historical-refund guard changed");
  for (const column of ["refund_email_status", "refund_email_notified_total_cents"]) {
    assert.ok(!sql038.includes(column), `038 touches the email state: ${column}`);
  }
});

test("46: the payment failure lifecycle and the Phase 3H emails are untouched", () => {
  for (const forbidden of [
    "subscription_email_deliveries", "payment_problem", "sync_subscription_payment_status",
    "subscription_started", "cancellation_confirmation", "subscription_ended",
    "public.subscriptions", "past_due", "unpaid", "stripe_webhook_events",
  ]) {
    assert.ok(!sql038.includes(forbidden), `038 reaches into an unrelated lifecycle: ${forbidden}`);
  }
});

test("47: B2C_SUBSCRIPTIONS_ENABLED is unchanged and still closed by default", () => {
  const rules = read("lib/subscriptionCheckoutRules.ts");
  assert.ok(rules.includes('export const SUBSCRIPTION_FEATURE_FLAG = "B2C_SUBSCRIPTIONS_ENABLED";'));
  assert.ok(rules.includes('return env[SUBSCRIPTION_FEATURE_FLAG] === "true";'));
  // A refund on a historical order must work whatever the flag says.
  assert.ok(!sql038.includes("B2C_SUBSCRIPTIONS_ENABLED"));
});

test("48: SHOP_STATUS is unchanged", () => {
  assert.ok(read("app/content.ts").includes('export const SHOP_STATUS = "prelaunch" as const;'));
});

test("49: this suite opens no database, calls nothing, and stages no secret", () => {
  const self = read("tests/one-time-refund-writer-concurrency.test.mjs");
  // Reading a path under supabase/migrations is fine; constructing a
  // client, or reaching a provider or the network, is not.
  //
  // Each needle is assembled from fragments so the list cannot match
  // ITSELF - a literal ban list is the one string guaranteed to contain
  // every word it bans, which would make this test either always fail or,
  // worse, be quietly deleted for "false positives".
  const forbidden = [
    ["create", "Client"], ["@sup", "abase"], ["getSup", "abaseAdmin"], ["new ", "Stripe"],
    ["Res", "end"], ["fetch", "("], ["http", "://"], ["process", ".env"],
    ["SUPABASE", "_SECRET_KEY"], ["STRIPE", "_SECRET_KEY"], ["RESEND", "_API_KEY"],
    ["stripe_", "backup_code"],
  ].map(parts => parts.join(""));
  for (const needle of forbidden) {
    assert.ok(!self.includes(needle), `the suite reaches outside itself: ${needle}`);
  }
  // The one child process it starts is git, and only to read.
  const gitCalls = [...self.matchAll(/execFileSync\("git", \[([^\]]*)\]/g)].map(m => m[1]);
  assert.ok(gitCalls.length > 0);
  for (const call of gitCalls) {
    assert.ok(call.includes('"diff"'), `a non-read git call: ${call}`);
  }
});

test("50: the existing duplicate group fails closed, end to end", () => {
  // 41 orders share one stored value in Production. Traced through this
  // function: the lock is taken, the count returns 41, the ambiguity
  // branch returns before any row is selected, and no UPDATE is reachable.
  // Every link of that chain is asserted above; this pins the ORDER of
  // the whole chain in one place so a future edit cannot quietly reorder
  // it and leave each individual assertion still passing.
  const chain = [
    "return 'invalid_input';",
    LOCK,
    "select count(*) into v_match_count",
    "if v_match_count = 0 then",
    "if v_match_count > 1 then",
    "return 'ambiguous_payment_intent';",
    "select * into v_order",
    "if not found then",
    "if v_order.payment_status not in",
    "update public.orders",
    "return 'applied';",
  ].map(at);
  assert.deepEqual([...chain].sort((a, b) => a - b), chain,
    "the refund correlation chain was reordered");
});
