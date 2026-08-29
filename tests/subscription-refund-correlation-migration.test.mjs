import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// SAFE DEFAULT SUITE: static SQL and source inspection only. No database
// is opened, no SQL is executed, no Supabase client is constructed, no
// Stripe API is called, no email is sent and no network is touched.
// Nothing here requires TEST_SUPABASE_*, and nothing here applies a
// migration or calls the function it reviews.
//
// What it protects: migration 037 adds exactly ONE narrow capability and
// nothing else. The three properties that matter are
//
//   1. it cannot be pointed at an arbitrary order, because it takes no
//      local identifier at all - the database performs the join
//   2. its refund-state transition is migration 019's, not a second
//      state machine for subscription orders
//   3. it adds no schema, no data, no table privilege and no browser
//      privilege, and no application code calls it yet
//
// Phase 3J.B1 is the migration only. The runtime fallback that will call
// this function, including the InvoicePayments reverse lookup and its
// pagination policy, belongs to Phase 3J.B2 and is deliberately absent
// here.

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const NEWLINE = String.fromCharCode(10);
const CARRIAGE_RETURN = String.fromCharCode(13);

/**
 * Line endings are normalised, and they have to be. This repository is
 * genuinely mixed: migration 011 is LF, 022 is CRLF and 019 is both at
 * once. Every assertion below is about what a file SAYS, never about how
 * its lines happen to end, so a multi-line anchor must not pass on one
 * migration and fail on the next for a reason nobody meant.
 */
const read = rel => readFileSync(path.join(ROOT, rel), "utf-8")
  .split(CARRIAGE_RETURN + NEWLINE)
  .join(NEWLINE);

const MIGRATIONS_DIR = path.join(ROOT, "supabase/migrations");
const MIGRATION_019 = "019_order_lifecycle_tracking.sql";
const MIGRATION_037 = "037_subscription_refund_correlation.sql";
const FUNCTION = "public.apply_order_refund_state_by_invoice(text, integer, boolean)";

/**
 * Code only. The migration's prose deliberately NAMES what it refuses to
 * do - an order id parameter, a currency argument, ALTER TABLE, a
 * backfill - so a scan that read the comments would report every
 * deliberate avoidance as a violation of itself.
 */
const withoutComments = source => source
  .split(NEWLINE)
  .filter(line => {
    const t = line.trim();
    return !t.startsWith("--") && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
  })
  .join(NEWLINE);

const migration037 = read(`supabase/migrations/${MIGRATION_037}`);
const migration019 = read(`supabase/migrations/${MIGRATION_019}`);
const sql037 = withoutComments(migration037);
const sql019 = withoutComments(migration019);

/** Lowercased and whitespace-collapsed, so formatting cannot hide a statement. */
const flat037 = sql037.toLowerCase().replace(/\s+/g, " ");

/** One function body, extracted by its exact opening line. */
const bodyOf = (sql, opening) => {
  const start = sql.indexOf(opening);
  assert.notEqual(start, -1, `function not found: ${opening}`);
  const end = sql.indexOf("$$;", start);
  assert.ok(end > start, `function not terminated: ${opening}`);
  return sql.slice(start, end + 3);
};

const newFunction = bodyOf(sql037, "create or replace function public.apply_order_refund_state_by_invoice(");
const oldFunction = bodyOf(sql019, "create or replace function public.apply_order_refund_state(");

/** Top-level statements, so "one function plus its grants" is provable. */
const topLevelStatements = (() => {
  // The function body is one statement delimited by $$ ... $$;. Remove it
  // first, then split what remains, otherwise every semicolon inside the
  // body would read as a statement of its own.
  const start = sql037.indexOf("create or replace function");
  const end = sql037.indexOf("$$;", start);
  const withoutBody = sql037.slice(0, start) + "__FUNCTION__;" + sql037.slice(end + 3);
  return withoutBody.split(";").map(s => s.trim()).filter(Boolean);
})();

/** Every migration that is LIVE and IMMUTABLE, by name. */
const IMMUTABLE_MIGRATIONS = [
  "022_recurring_subscription_foundation.sql",
  "023_harden_stripe_customers_grants.sql",
  "024_seed_b2c_subscription_plans.sql",
  "025_grant_subscription_plans_service_role.sql",
  "026_internal_order_notification_state.sql",
  "027_shipment_confirmation_email_state.sql",
  "028_authorized_shipment_transition.sql",
  "029_authorized_order_cancellation.sql",
  "030_cancellation_request_notification_state.sql",
  "031_cancellation_request_resolution.sql",
  "032_open_cancellation_request_shipment_guard.sql",
  "033_refund_confirmation_email_state.sql",
  "034_subscription_cancellation.sql",
  "035_subscription_email_deliveries.sql",
  "036_subscription_payment_status.sql",
];

/* ══════════════════════════════════════════════════════════════
   1-4. NUMBERING AND IMMUTABILITY
   ══════════════════════════════════════════════════════════════ */

test("1, 2: 037 exists, owns its number, and is the highest migration", () => {
  const files = readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith(".sql")).sort();
  assert.ok(files.includes(MIGRATION_037), "migration 037 is missing");
  assert.deepEqual(files.filter(f => f.startsWith("037")), [MIGRATION_037]);
  assert.equal(files[files.length - 1], MIGRATION_037, "037 must be the highest");
  assert.ok(!files.some(f => f.startsWith("038")), "a 038 appeared");
  assert.equal(files.length, 37);
  // No number is used twice.
  const numbers = files.map(f => f.slice(0, 3));
  assert.equal(new Set(numbers).size, numbers.length);
});

test("3: every immutable migration is still present and unedited", () => {
  const files = readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith(".sql"));
  for (const name of [...IMMUTABLE_MIGRATIONS, MIGRATION_019]) {
    assert.ok(files.includes(name), `${name} was renamed or deleted`);
  }
  const changed = execFileSync("git", ["diff", "--name-only", "HEAD", "--", "supabase/migrations/"], {
    cwd: ROOT,
    encoding: "utf-8",
  }).trim();
  const touched = changed ? changed.split(NEWLINE) : [];
  for (const file of touched) {
    assert.ok(file.endsWith(MIGRATION_037), `an immutable migration was modified: ${file}`);
  }
});

test("4: migration 019's own refund function text is untouched", () => {
  // 037 adds a SECOND writer. It must not have quietly edited the first.
  assert.ok(migration019.includes("create or replace function public.apply_order_refund_state(\n  p_payment_intent_id   text,"),
    "019's signature changed");
  assert.ok(oldFunction.includes("where stripe_payment_intent_id = p_payment_intent_id"),
    "019 no longer correlates by the payment intent");
  assert.ok(migration019.includes(
    "grant execute on function public.apply_order_refund_state(text, integer, boolean) to service_role;"
  ), "019's grant changed");
  assert.ok(!migration019.includes("by_invoice"), "019 was edited to know about 037");
});

/* ══════════════════════════════════════════════════════════════
   5-10. THE CAPABILITY BOUNDARY
   ══════════════════════════════════════════════════════════════ */

test("5: exactly one function, with the exact intended signature", () => {
  const creates = [...sql037.matchAll(/create (or replace )?function\s+([\w.]+)/gi)].map(m => m[2]);
  assert.deepEqual(creates, ["public.apply_order_refund_state_by_invoice"],
    "037 must create exactly one function");
  assert.ok(sql037.includes(`create or replace function public.apply_order_refund_state_by_invoice(
  p_stripe_invoice_id    text,
  p_refunded_total_cents integer,
  p_has_pending_refund   boolean
)`), "the signature is not the reviewed one");
  assert.ok(newFunction.includes("returns text"));
});

test("6: THE WHOLE POINT - no local identifier can be presented by the caller", () => {
  // The signature is the capability. A p_order_id would make this a
  // general "mutate any order's refund state" primitive; every other
  // name here would let the caller choose the row some other way.
  const signature = newFunction.slice(0, newFunction.indexOf(")"));
  const params = [...signature.matchAll(/\bp_\w+/g)].map(m => m[0]);
  assert.deepEqual(params, ["p_stripe_invoice_id", "p_refunded_total_cents", "p_has_pending_refund"],
    "the parameter list changed");
  for (const forbidden of [
    "p_order_id", "p_order", "p_checkout_attempt_id", "p_attempt_id",
    "p_subscription_id", "p_stripe_subscription_id", "p_customer_id",
    "p_customer", "p_email", "p_metadata", "p_user_id", "p_payment_intent_id",
  ]) {
    assert.ok(!signature.includes(forbidden), `the caller may present ${forbidden}`);
  }
});

test("7: the amount is a transition input, never a way to choose a row", () => {
  // Every WHERE clause in the function, checked for money and identity.
  const wheres = [...newFunction.matchAll(/where ([\s\S]*?)(?:;|for update)/g)].map(m => m[1]);
  assert.ok(wheres.length >= 3, "the function stopped filtering rows");
  for (const clause of wheres) {
    for (const forbidden of [
      "total_gross_cents", "refunded_total_cents", "p_refunded_total_cents",
      "customer_snapshot", "user_id", "subscription_id", "placed_at", "currency",
    ]) {
      assert.ok(!clause.includes(forbidden), `a row is selected by ${forbidden}`);
    }
  }
});

test("8: no dynamic SQL, so no caller string can become a query", () => {
  for (const forbidden of ["execute ", "format(", "quote_ident", "quote_literal", "::regclass"]) {
    assert.ok(!newFunction.toLowerCase().includes(forbidden),
      `the function builds SQL dynamically: ${forbidden}`);
  }
});

test("9: SECURITY DEFINER with an emptied search_path, and every object qualified", () => {
  assert.ok(newFunction.includes("security definer set search_path = ''"),
    "the function is not a hardened definer");
  assert.ok(newFunction.includes("language plpgsql"));
  assert.ok(newFunction.includes("volatile"));
  // With search_path emptied, an unqualified name would not resolve.
  assert.ok(newFunction.includes("from public.checkout_attempts"));
  assert.ok(newFunction.includes("from public.orders"));
  assert.ok(newFunction.includes("update public.orders"));
  assert.ok(newFunction.includes("v_order       public.orders;"));
  // No bare table name anywhere.
  for (const bare of [
    /from\s+orders\b/i, /from\s+checkout_attempts\b/i,
    /update\s+orders\b/i, /join\s+orders\b/i,
  ]) {
    assert.ok(!bare.test(newFunction), `an unqualified table name appears: ${bare}`);
  }
});

test("10: input validation answers, and never raises, for expected bad input", () => {
  const guard = newFunction.slice(newFunction.indexOf("if p_stripe_invoice_id is null"),
    newFunction.indexOf("v_invoice_id := btrim"));
  for (const condition of [
    "p_stripe_invoice_id is null",
    "btrim(p_stripe_invoice_id) = ''",
    "p_refunded_total_cents is null",
    "p_refunded_total_cents < 0",
  ]) {
    assert.ok(guard.includes(condition), `missing validation: ${condition}`);
  }
  assert.ok(guard.includes("return 'invalid_input';"));
  // Nothing in the whole function raises: an expected refusal must be a
  // word the webhook can log, not a 500 Stripe would retry forever.
  assert.ok(!/raise\s+(exception|notice|warning)/i.test(newFunction),
    "the function raises instead of returning a result word");
});

/* ══════════════════════════════════════════════════════════════
   11-16. THE RESOLUTION CHAIN
   ══════════════════════════════════════════════════════════════ */

test("11: the invoice resolves through checkout_attempts, trimmed, and by nothing else", () => {
  assert.ok(newFunction.includes("v_invoice_id := btrim(p_stripe_invoice_id);"),
    "the presented id is not normalised once");
  assert.ok(newFunction.includes(`from public.checkout_attempts
  where stripe_invoice_id = v_invoice_id`), "the invoice hop is not on stripe_invoice_id");
  // Never any other column of that table.
  const attemptQueries = [...newFunction.matchAll(/from public\.checkout_attempts([\s\S]*?);/g)].map(m => m[1]);
  assert.equal(attemptQueries.length, 2, "the attempt hop changed shape");
  for (const q of attemptQueries) {
    for (const forbidden of [
      "stripe_payment_intent_id", "stripe_checkout_session_id", "subscription_id",
      "user_id", "request_id", "items_snapshot", "status",
    ]) {
      assert.ok(!q.includes(forbidden), `the attempt is resolved by ${forbidden}`);
    }
  }
});

test("12: the order resolves through checkout_attempt_id, and by nothing else", () => {
  assert.ok(newFunction.includes(`from public.orders
  where checkout_attempt_id = v_attempt_id`), "the order hop is not on checkout_attempt_id");
  const orderQueries = [...newFunction.matchAll(/from public\.orders\s+where ([\s\S]*?)(?:;|for update)/g)]
    .map(m => m[1]);
  assert.equal(orderQueries.length, 2, "the order hop changed shape");
  for (const q of orderQueries) {
    assert.ok(q.includes("checkout_attempt_id = v_attempt_id"));
    for (const forbidden of ["stripe_payment_intent_id", "stripe_checkout_session_id", "order_number"]) {
      assert.ok(!q.includes(forbidden), `the order is resolved by ${forbidden}`);
    }
  }
});

test("13, 14: both hops count first and refuse an impossible ambiguity", () => {
  // The two partial unique indexes make more than one row impossible.
  // Counting anyway is the same defence 019 applies to an unindexed
  // column: if an index were ever dropped, this refuses rather than
  // silently picking a row.
  const counts = [...newFunction.matchAll(/select count\(\*\) into v_match_count/g)];
  assert.equal(counts.length, 2, "a hop stopped counting before deciding");
  const ambiguous = [...newFunction.matchAll(/return 'ambiguous_invoice_correlation';/g)];
  assert.equal(ambiguous.length, 2, "a hop cannot report ambiguity");
  assert.ok(newFunction.includes(`if v_match_count > 1 then
    return 'ambiguous_invoice_correlation';`));
});

test("15: a missing invoice and a missing order are distinct, and both are silent", () => {
  const attemptMiss = newFunction.slice(
    newFunction.indexOf("from public.checkout_attempts"),
    newFunction.indexOf("select id into v_attempt_id")
  );
  assert.ok(attemptMiss.includes("return 'order_not_found';"));
  const orderMiss = newFunction.slice(
    newFunction.indexOf("from public.orders"),
    newFunction.indexOf("for update")
  );
  assert.ok(orderMiss.includes("return 'order_missing_for_attempt';"),
    "a paid attempt with no order is flattened into the ordinary case");
  // Neither writes anything.
  const beforeLock = newFunction.slice(0, newFunction.indexOf("for update"));
  assert.ok(!/\bupdate public\./i.test(beforeLock), "something is written before the lock");
  assert.ok(!/\binsert into\b/i.test(newFunction), "the function inserts");
  assert.ok(!/\bdelete from\b/i.test(newFunction), "the function deletes");
});

test("16: the complete result vocabulary is exactly the eight reviewed words", () => {
  const returned = [...newFunction.matchAll(/return '(\w+)';/g)].map(m => m[1]);
  assert.deepEqual([...new Set(returned)].sort(), [
    "ambiguous_invoice_correlation",
    "applied",
    "invalid_amount",
    "invalid_input",
    "not_applicable",
    "order_missing_for_attempt",
    "order_not_found",
    "unchanged",
  ], "the result vocabulary changed");
  // 019's payment-intent-only word cannot appear here: this function
  // never sees a payment intent.
  assert.ok(!newFunction.includes("ambiguous_payment_intent"));
});

/* ══════════════════════════════════════════════════════════════
   17-20. THE LOCK
   ══════════════════════════════════════════════════════════════ */

test("17, 18: the order is locked FOR UPDATE, exactly once, on the resolved row", () => {
  const locks = [...newFunction.matchAll(/for update/gi)];
  assert.equal(locks.length, 1, "the lock count changed");
  assert.ok(newFunction.includes(`select * into v_order
  from public.orders
  where checkout_attempt_id = v_attempt_id
  for update;`), "the locked read is not the resolved order");
});

test("19: every refund decision is made AFTER the lock, from the locked row", () => {
  const lockAt = newFunction.indexOf("for update");
  assert.notEqual(lockAt, -1);
  for (const decision of [
    "v_order.payment_status not in ('paid'",
    "p_refunded_total_cents > v_order.total_gross_cents",
    "p_refunded_total_cents >= v_order.total_gross_cents",
    "v_order.refunded_total_cents is not distinct from",
    "update public.orders",
  ]) {
    const at = newFunction.indexOf(decision);
    assert.notEqual(at, -1, `missing: ${decision}`);
    assert.ok(at > lockAt, `a refund decision is made before the lock: ${decision}`);
  }
});

/* ══════════════════════════════════════════════════════════════
   19a-19k. THE LOCK INVARIANT (Phase 3J.B1.1)
   ══════════════════════════════════════════════════════════════

   A count and the select that follows it are SEPARATE STATEMENTS, and
   under READ COMMITTED the row can vanish between them. SELECT INTO
   without STRICT does not raise on zero rows: FOUND goes false and the
   target is left NULL.

   For the ORDER LOCK that is not a no-op, it is a false success. Every
   comparison below would run against NULL: the eligibility test answers
   NULL and falls through, the cap answers NULL and falls through, the
   ladder picks an arm from the caller's amount alone, the unchanged
   check answers NULL and falls through, and the UPDATE runs with
   `where id = NULL`, matches nothing, and the function returns
   'applied'. A payment fact reported durable that was never written.

   So the invariant these tests hold is: the transition can only run
   against a row that was selected AND locked. ══════════════════════ */

/** Everything the function does with refund state, in source order. */
const REFUND_DECISIONS = [
  "v_order.payment_status not in ('paid'",
  "p_refunded_total_cents > v_order.total_gross_cents",
  "p_refunded_total_cents >= v_order.total_gross_cents",
  "elsif coalesce(p_has_pending_refund, false) then",
  "v_order.refunded_total_cents is not distinct from",
  "update public.orders",
  "return 'applied';",
];

/** The guard block that must sit between the lock and all of them. */
const LOCK_GUARD = `  for update;`;
const POST_LOCK_GUARD = `  if not found then
    return 'order_missing_for_attempt';
  end if;`;

test("19a: the attempt select is followed IMMEDIATELY by a NOT FOUND guard", () => {
  const at = newFunction.indexOf(`  select id into v_attempt_id
  from public.checkout_attempts
  where stripe_invoice_id = v_invoice_id;`);
  assert.notEqual(at, -1, "the attempt select changed shape");
  const after = newFunction.slice(at);
  const guardAt = after.indexOf(`  if not found then
    return 'order_not_found';
  end if;`);
  assert.notEqual(guardAt, -1, "the attempt select has no NOT FOUND guard");
  // Nothing executable may run between the select and its guard.
  const between = withoutComments(after.slice(after.indexOf(";") + 1, guardAt)).trim();
  assert.equal(between, "", `something runs before the attempt guard: ${between}`);
});

test("19b: a vanished attempt cannot reach the order lookup", () => {
  const guardAt = newFunction.indexOf(`  if not found then
    return 'order_not_found';
  end if;`);
  const orderCountAt = newFunction.indexOf(`  select count(*) into v_match_count
  from public.orders`);
  assert.ok(guardAt !== -1 && orderCountAt !== -1);
  assert.ok(guardAt < orderCountAt, "the order lookup runs before the attempt is proven");
});

test("19c: the FOR UPDATE is followed IMMEDIATELY by a NOT FOUND guard", () => {
  const lockAt = newFunction.indexOf(LOCK_GUARD);
  assert.notEqual(lockAt, -1, "the lock changed shape");
  const after = newFunction.slice(lockAt + LOCK_GUARD.length);
  const guardAt = after.indexOf(POST_LOCK_GUARD);
  assert.notEqual(guardAt, -1, "THE LOCK HAS NO NOT FOUND GUARD");
  // Nothing executable may run between the lock and its guard.
  const between = withoutComments(after.slice(0, guardAt)).trim();
  assert.equal(between, "", `something runs before the lock guard: ${between}`);
});

test("19d-19j: NO refund decision exists before the post-lock guard", () => {
  const lockAt = newFunction.indexOf(LOCK_GUARD);
  const guardEnd = lockAt + LOCK_GUARD.length
    + newFunction.slice(lockAt + LOCK_GUARD.length).indexOf(POST_LOCK_GUARD)
    + POST_LOCK_GUARD.length;
  for (const decision of REFUND_DECISIONS) {
    const at = newFunction.indexOf(decision);
    assert.notEqual(at, -1, `missing: ${decision}`);
    assert.ok(at > guardEnd,
      `a refund decision can run against an unlocked NULL row: ${decision}`);
  }
  // And the decisions are still in their reviewed order.
  const positions = REFUND_DECISIONS.map(d => newFunction.indexOf(d));
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b),
    "the transition was reordered");
});

test("19k: 'applied' is unreachable through the zero-row lock path", () => {
  // The guard returns before it, and it is the only 'applied' there is.
  const guardReturnAt = newFunction.indexOf(POST_LOCK_GUARD);
  const appliedAt = newFunction.indexOf("return 'applied';");
  assert.ok(guardReturnAt !== -1 && appliedAt > guardReturnAt);
  assert.equal([...newFunction.matchAll(/return 'applied';/g)].length, 1,
    "there is more than one way to report a durable write");
  // Every statement that could report success reads v_order, which the
  // guard has just proven exists.
  const tail = newFunction.slice(guardReturnAt + POST_LOCK_GUARD.length);
  assert.ok(tail.includes("where id = v_order.id;"),
    "the write no longer targets the locked row");
});

test("19l: both row-selecting statements are guarded, and the counts are not", () => {
  // A count always returns exactly one row, so FOUND after it proves
  // nothing. The guards belong to the two selects that can return none.
  const guards = [...newFunction.matchAll(/if not found then/g)];
  assert.equal(guards.length, 2, "the FOUND guard count changed");
  const rowSelects = [
    "select id into v_attempt_id",
    "select * into v_order",
  ];
  for (const stmt of rowSelects) {
    const at = newFunction.indexOf(stmt);
    assert.notEqual(at, -1, `missing: ${stmt}`);
    const next = newFunction.slice(at).indexOf("if not found then");
    assert.notEqual(next, -1, `${stmt} is unguarded`);
  }
  // SELECT INTO STRICT is deliberately NOT used: it raises, and every
  // expected refusal here must be a returned word the webhook can log.
  assert.ok(!/into strict/i.test(newFunction), "the function raises instead of returning");
});

test("20: the locked row is the one that gets written", () => {
  const update = newFunction.slice(newFunction.indexOf("update public.orders"));
  assert.ok(update.includes("where id = v_order.id;"),
    "the update does not target the locked row by its primary key");
});

/* ══════════════════════════════════════════════════════════════
   21-30. MIGRATION 019 PARITY
   ══════════════════════════════════════════════════════════════ */

/** The transition region of a refund function: from the eligibility gate to 'applied'. */
const transitionOf = fn => {
  const from = fn.indexOf("if v_order.payment_status not in");
  const to = fn.indexOf("return 'applied'");
  assert.ok(from !== -1 && to > from, "the transition region was not found");
  return fn.slice(from, to + "return 'applied'".length).replace(/\s+/g, " ").trim();
};

test("21: THE PARITY PROOF - the transition is migration 019's, character for character", () => {
  // Not a keyword spot-check. The whole region, comment-stripped and
  // whitespace-collapsed, must be identical, so a subscription order and
  // a one-time order can never reach different payment states from the
  // same facts.
  assert.equal(transitionOf(newFunction), transitionOf(oldFunction),
    "037 invented a different refund state machine");
});

test("22: eligible current statuses are 019's four, not widened", () => {
  const gate = "if v_order.payment_status not in ('paid', 'refund_pending', 'partially_refunded', 'refunded') then";
  assert.ok(oldFunction.includes(gate), "019's gate changed");
  assert.ok(newFunction.includes(gate));
  assert.ok(newFunction.includes("return 'not_applicable';"));
  // 'pending' and 'failed' are absent from both: an order that was never
  // paid has no refund story.
  const gateLine = newFunction.slice(newFunction.indexOf(gate), newFunction.indexOf("return 'not_applicable';"));
  for (const never of ["'pending'", "'failed'"]) {
    assert.ok(!gateLine.includes(never), `refund eligibility was widened to ${never}`);
  }
});

test("23: the amount cap refuses, and never clamps", () => {
  assert.ok(newFunction.includes(`if p_refunded_total_cents > v_order.total_gross_cents then
    return 'invalid_amount';`));
  for (const clamp of ["least(", "greatest(", "min(", "max("]) {
    assert.ok(!newFunction.toLowerCase().includes(clamp), `the amount is clamped with ${clamp}`);
  }
});

test("24-27: the four status arms, in 019's exact order", () => {
  const ladder = newFunction.slice(
    newFunction.indexOf("if p_refunded_total_cents >= v_order.total_gross_cents"),
    newFunction.indexOf("if v_order.payment_status = v_new_status")
  );
  const arms = [...ladder.matchAll(/v_new_status := '(\w+)';/g)].map(m => m[1]);
  assert.deepEqual(arms, ["refunded", "partially_refunded", "refund_pending", "paid"],
    "the ladder order changed");
  // The zero-total qualifier on the first arm is load-bearing: without
  // it a zero-total order would read as fully refunded.
  assert.ok(ladder.includes("p_refunded_total_cents >= v_order.total_gross_cents and v_order.total_gross_cents > 0"));
  assert.ok(ladder.includes("elsif p_refunded_total_cents > 0 then"));
  assert.ok(ladder.includes("elsif coalesce(p_has_pending_refund, false) then"));
});

test("28: the unchanged check is NULL-safe, exactly as 019's is", () => {
  const check = `if v_order.payment_status = v_new_status
     and v_order.refunded_total_cents is not distinct from p_refunded_total_cents
  then
    return 'unchanged';`;
  assert.ok(oldFunction.includes(check), "019's unchanged check changed");
  assert.ok(newFunction.includes(check));
  // A plain = would answer NULL for the first refund ever recorded and
  // fall through to a pointless write.
  assert.ok(!/refunded_total_cents\s*=\s*p_refunded_total_cents\s*$/m.test(
    newFunction.slice(newFunction.indexOf("if v_order.payment_status = v_new_status"),
      newFunction.indexOf("return 'unchanged';"))
  ), "the nullable total is compared with a plain equals");
});

test("29: no currency argument was introduced on either side", () => {
  assert.ok(!newFunction.includes("currency"), "037 introduced a currency concept");
  assert.ok(!oldFunction.includes("currency"), "019's premise changed");
  // Currency validation stays application-side, where it already is.
  const refunds = read("lib/stripeRefunds.ts");
  assert.ok(refunds.includes("does not match order currency"),
    "summarizeStripeRefunds no longer validates currency");
});

test("30: 019 remains the writer for the payment-intent path", () => {
  assert.ok(oldFunction.includes("where stripe_payment_intent_id = p_payment_intent_id"));
  // And 037 never touches that column at all.
  assert.ok(!newFunction.includes("stripe_payment_intent_id"),
    "037 reaches for the payment intent column");
});

/* ══════════════════════════════════════════════════════════════
   31-34. WHAT IS MUTATED
   ══════════════════════════════════════════════════════════════ */

test("31, 32: exactly one UPDATE, writing exactly three columns", () => {
  const updates = [...sql037.matchAll(/update public\.\w+/gi)];
  assert.deepEqual(updates.map(m => m[0]), ["update public.orders"],
    "037 writes something other than one orders update");
  const clause = newFunction.slice(newFunction.indexOf("update public.orders"),
    newFunction.indexOf("where id = v_order.id"));
  const written = [...clause.matchAll(/(\w+)\s*=\s*/g)].map(m => m[1]);
  assert.deepEqual(written, ["payment_status", "refunded_total_cents", "refund_updated_at"],
    "the mutated column set changed");
});

test("33: refund_updated_at is now(), and only on the applied branch", () => {
  const clause = newFunction.slice(newFunction.indexOf("update public.orders"),
    newFunction.indexOf("return 'applied'"));
  assert.ok(clause.includes("refund_updated_at    = now()"));
  // The update is the last thing before 'applied' and nothing else
  // writes, so an 'unchanged' or a refusal cannot move the timestamp.
  const beforeUpdate = newFunction.slice(0, newFunction.indexOf("update public.orders"));
  assert.ok(!beforeUpdate.includes("now()"), "a timestamp is written before the applied branch");
});

test("34: no order state outside the three columns can be reached", () => {
  for (const forbidden of [
    "customer_snapshot", "shipping_address_snapshot", "billing_address_snapshot",
    "fulfillment_status", "shipped_at", "tracking_number", "shipping_carrier",
    "cancelled_at", "cancellation_requested_at", "cancellation_request_resolution",
    "tax_total_cents", "total_gross_cents =", "subtotal_gross_cents", "order_number",
    "placed_at", "user_id", "public.order_items", "public.subscriptions",
    "public.subscription_items", "public.subscription_email_deliveries",
  ]) {
    assert.ok(!newFunction.includes(forbidden), `the function reaches ${forbidden}`);
  }
});

/* ══════════════════════════════════════════════════════════════
   35-38. PRIVILEGES
   ══════════════════════════════════════════════════════════════ */

test("35: PUBLIC and both browser roles are revoked explicitly", () => {
  for (const role of ["public", "anon", "authenticated", "service_role"]) {
    assert.ok(sql037.includes(`revoke all on function ${FUNCTION} from ${role};`),
      `missing revoke from ${role}`);
  }
  // Postgres grants EXECUTE to PUBLIC by default, so the first revoke is
  // the one that actually closes the function.
  const revokes = [...sql037.matchAll(/revoke all on function/g)];
  assert.equal(revokes.length, 4);
});

test("36: exactly one grant, and it is EXECUTE to service_role", () => {
  const grants = sql037.split(NEWLINE).filter(l => /^\s*grant\b/i.test(l));
  assert.deepEqual(grants.map(l => l.trim()), [
    `grant execute on function ${FUNCTION} to service_role;`,
  ], "037's grant set changed");
});

test("37: nothing is granted to PUBLIC, anon or authenticated", () => {
  assert.ok(!/grant[^;]*\bto\s+public\b/i.test(sql037));
  assert.ok(!/grant[^;]*\bto\s+anon\b/i.test(sql037));
  assert.ok(!/grant[^;]*\bto\s+authenticated\b/i.test(sql037));
  // And no policy could grant a browser role a way in either.
  assert.ok(!/create policy/i.test(sql037));
});

test("38: no TABLE privilege is created, widened or revoked", () => {
  for (const statement of sql037.match(/^\s*(?:grant|revoke)[^;]*;/gim) ?? []) {
    assert.ok(/\bon\s+function\b/i.test(statement),
      `037 changes a table privilege: ${statement.trim()}`);
  }
  // Named tables must appear only inside the function body, never in a
  // grant, and never with a privilege attached.
  assert.ok(!/grant[^;]*public\.orders/i.test(sql037));
  assert.ok(!/grant[^;]*checkout_attempts/i.test(sql037));
});

/* ══════════════════════════════════════════════════════════════
   39-42. NO SCHEMA EXPANSION, NO DATA
   ══════════════════════════════════════════════════════════════ */

test("39: the migration is one function plus five privilege statements", () => {
  assert.deepEqual(topLevelStatements.length, 6,
    `037 has ${topLevelStatements.length} top-level statements: ${topLevelStatements.map(s => s.slice(0, 40))}`);
  assert.ok(topLevelStatements[0].includes("__FUNCTION__"));
  assert.equal(topLevelStatements.filter(s => /^revoke\b/i.test(s)).length, 4);
  assert.equal(topLevelStatements.filter(s => /^grant\b/i.test(s)).length, 1);
});

test("40: no DDL of any other kind", () => {
  for (const forbidden of [
    "alter table", "create table", "create index", "create unique index",
    "create trigger", "create policy", "drop table", "drop column", "add column",
    "alter column", "drop constraint", "add constraint", "create type", "create schema",
    "alter function", "drop function", "create view", "create materialized view",
  ]) {
    assert.ok(!flat037.includes(forbidden), `037 contains ${forbidden}`);
  }
});

test("41: no data is written, read back or backfilled by the migration itself", () => {
  // Statements outside the function body: none of them may touch data.
  const outside = topLevelStatements.filter(s => !s.includes("__FUNCTION__"));
  for (const statement of outside) {
    assert.ok(/^(grant|revoke)\b/i.test(statement), `a non-privilege statement appears: ${statement.slice(0, 60)}`);
  }
  // And the migration never calls what it creates.
  assert.ok(!/select\s+public\.apply_order_refund_state_by_invoice/i.test(sql037),
    "the migration calls its own function");
  assert.ok(!/\bdo\s*\$\$/i.test(sql037), "037 runs an anonymous block");
});

test("42: the verification notes are comments, and read-only", () => {
  // The VERIFY section exists so the owner can check the apply, and it
  // must never be executable.
  assert.ok(migration037.includes("-- 6. VERIFY"), "the verification section is missing");
  const verify = migration037.slice(migration037.indexOf("-- 6. VERIFY"));
  for (const line of verify.split(NEWLINE)) {
    if (!line.trim()) continue;
    assert.ok(line.trim().startsWith("--"), `an executable line follows VERIFY: ${line}`);
  }
  assert.ok(!/update |insert |delete /i.test(withoutComments(verify)));
});

/* ══════════════════════════════════════════════════════════════
   43-46. THE ONE-TIME PARTITION
   ══════════════════════════════════════════════════════════════ */

test("43: a one-time checkout attempt never receives a stripe_invoice_id", () => {
  // The application writes only these columns to checkout_attempts, and
  // the invoice is not among them.
  const attempts = withoutComments(read("lib/checkoutAttempts.ts"));
  const updates = [...attempts.matchAll(/\.update\(\{([\s\S]*?)\}\)/g)].map(m => m[1]);
  assert.ok(updates.length >= 2, "the attempt writer changed shape");
  for (const clause of updates) {
    assert.ok(!clause.includes("stripe_invoice_id"),
      "the one-time flow writes an invoice id onto a checkout attempt");
  }
  // Nowhere in the application, in fact.
  for (const rel of ["lib/checkoutAttempts.ts", "lib/orderFulfillment.ts", "lib/subscriptionInvoiceFulfillment.ts"]) {
    const source = withoutComments(read(rel));
    assert.ok(!/(insert|update)[\s\S]{0,200}stripe_invoice_id\s*:/.test(source),
      `${rel} writes stripe_invoice_id`);
  }
});

test("44: migration 022 is the only writer of checkout_attempts.stripe_invoice_id", () => {
  const writers = readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith(".sql"))
    .filter(f => {
      const sql = withoutComments(read(`supabase/migrations/${f}`));
      return /insert into public\.checkout_attempts[\s\S]*?stripe_invoice_id/.test(sql)
        || /update public\.checkout_attempts\s+set[\s\S]*?stripe_invoice_id\s*=/.test(sql);
    });
  assert.deepEqual(writers, ["022_recurring_subscription_foundation.sql"],
    "a second writer of the invoice binding appeared");
  // And 022 proves the invoice belongs to the named subscription before
  // it writes, which is what makes the binding trustworthy.
  const m022 = read("supabase/migrations/022_recurring_subscription_foundation.sql");
  assert.ok(m022.includes("if v_attempt.subscription_id is distinct from p_subscription_id then"),
    "022 no longer proves the invoice belongs to the subscription");
});

test("45: therefore 037 cannot reach a one-time order", () => {
  // A one-time attempt has stripe_invoice_id NULL; a non-blank presented
  // id cannot match NULL, and a blank one is refused before any lookup.
  assert.ok(newFunction.includes("btrim(p_stripe_invoice_id) = ''"));
  assert.ok(newFunction.includes("where stripe_invoice_id = v_invoice_id"));
  // The subscription order path, for contrast, always has one: the
  // fulfillment module passes no payment intent, by design.
  const fulfillment = read("lib/subscriptionInvoiceFulfillment.ts");
  assert.match(fulfillment,
    /createOrderFromPaidCheckoutAttempt\(\s*checkoutAttemptId,\s*subscription\.customer_snapshot[^)]*?null,/s,
    "the subscription order now carries a payment intent, which changes this partition");
});

test("46: 019 and 037 partition the orders table, neither overlapping", () => {
  assert.ok(oldFunction.includes("stripe_payment_intent_id"));
  assert.ok(!oldFunction.includes("checkout_attempt_id"), "019 learned about the attempt");
  assert.ok(newFunction.includes("checkout_attempt_id"));
  assert.ok(!newFunction.includes("stripe_payment_intent_id"), "037 learned about the payment intent");
});

/* ══════════════════════════════════════════════════════════════
   47-50. THE UNIQUE INDEXES, WHICH 037 USES AND DOES NOT CREATE
   ══════════════════════════════════════════════════════════════ */

test("47: migration 022 still carries the invoice unique index", () => {
  const m022 = read("supabase/migrations/022_recurring_subscription_foundation.sql");
  assert.ok(m022.includes(`create unique index checkout_attempts_stripe_invoice_id_key
  on public.checkout_attempts (stripe_invoice_id)
  where stripe_invoice_id is not null;`), "022's invoice index text changed");
});

test("48: migration 011 still carries the checkout attempt unique index", () => {
  const m011 = read("supabase/migrations/011_orders_from_paid_checkout.sql");
  assert.ok(m011.includes(`create unique index orders_checkout_attempt_id_key
  on public.orders (checkout_attempt_id)
  where checkout_attempt_id is not null;`), "011's attempt index text changed");
});

test("49: 037 recreates neither, and creates no index at all", () => {
  assert.ok(!/create\s+(unique\s+)?index/i.test(sql037), "037 creates an index");
  for (const name of ["checkout_attempts_stripe_invoice_id_key", "orders_checkout_attempt_id_key"]) {
    assert.ok(!sql037.split(NEWLINE).some(l => !l.trim().startsWith("--") && l.includes(name)),
      `037 executes something naming ${name}`);
  }
});

test("50: orders.stripe_payment_intent_id still has no unique index anywhere", () => {
  // The premise of 019's count-then-refuse, and the reason 037 copies it.
  const indexed = readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith(".sql"))
    .filter(f => /create\s+(unique\s+)?index[^;]*orders[^;]*stripe_payment_intent_id/i.test(
      withoutComments(read(`supabase/migrations/${f}`))
    ));
  assert.deepEqual(indexed, [], "an index on the payment intent appeared, which changes 019's reasoning");
});

/* ══════════════════════════════════════════════════════════════
   51-55. NOTHING IS WIRED UP YET
   ══════════════════════════════════════════════════════════════ */

/** Every source file under lib/ and app/. */
const sourceFiles = (() => {
  const out = [];
  const walk = dir => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx|mjs|js)$/.test(entry)) out.push(path.relative(ROOT, full));
    }
  };
  walk(path.join(ROOT, "lib"));
  walk(path.join(ROOT, "app"));
  return out;
})();

test("51: no application code calls the new function", () => {
  const callers = sourceFiles.filter(rel => read(rel).includes("apply_order_refund_state_by_invoice"));
  assert.deepEqual(callers, [], "the runtime fallback belongs to Phase 3J.B2, not this migration phase");
});

test("52: the refund runtime is byte-identical to HEAD", () => {
  const changed = execFileSync("git", ["diff", "--name-only", "HEAD"], { cwd: ROOT, encoding: "utf-8" })
    .trim();
  const touched = changed ? changed.split(NEWLINE) : [];
  for (const rel of [
    "lib/orderRefunds.ts", "lib/stripeRefunds.ts", "lib/refundConfirmationEmail.ts",
    "lib/refundConfirmationRules.ts", "lib/email/refundConfirmation.ts",
    "app/api/stripe/webhook/route.ts",
  ]) {
    assert.ok(!touched.includes(rel), `${rel} was modified by a migration-only phase`);
  }
});

test("53: the existing refund path still correlates the way it always did", () => {
  const orderRefunds = read("lib/orderRefunds.ts");
  assert.ok(orderRefunds.includes('.eq("stripe_payment_intent_id", trimmedId)'));
  assert.deepEqual([...orderRefunds.matchAll(/admin\.rpc\("(\w+)"/g)].map(m => m[1]),
    ["apply_order_refund_state"], "the refund writer changed in a migration-only phase");
});

test("54: the payment failure lifecycle and the Phase 3H emails are untouched", () => {
  // 037 is about money going back, which has nothing to do with money
  // that never arrived.
  for (const forbidden of [
    "subscription_email_deliveries", "payment_problem", "sync_subscription_payment_status",
    "subscription_started", "cancellation_confirmation", "subscription_ended",
    "public.subscriptions", "past_due", "unpaid",
  ]) {
    assert.ok(!sql037.includes(forbidden), `037 reaches into the subscription lifecycle: ${forbidden}`);
  }
  const m036 = read("supabase/migrations/036_subscription_payment_status.sql");
  assert.ok(m036.includes("create or replace function public.sync_subscription_payment_status"),
    "036 changed");
});

test("55: this suite opens no database, calls nothing, and stages no secret", () => {
  const self = read("tests/subscription-refund-correlation-migration.test.mjs");
  // Asserted on the suite's IMPORTS and PROCESSES rather than on banned
  // substrings. A substring scan of this file would match its own list
  // and either fail against itself or have to be written around, which
  // is how a safety check quietly stops checking anything.
  const imports = [...self.matchAll(/^import .*? from "([^"]+)";$/gm)].map(m => m[1]);
  assert.ok(imports.length > 0, "the import scan found nothing");
  for (const specifier of imports) {
    assert.ok(specifier.startsWith("node:"),
      `this suite imports something outside the standard library: ${specifier}`);
  }
  // The only child process it starts is git, which is local.
  const spawned = [...self.matchAll(/execFileSync\("([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual([...new Set(spawned)], ["git"], "this suite spawns something other than git");
  // And it reads no configuration, so it cannot pick up a live key.
  assert.ok(!self.includes("process" + ".env"), "this suite reads the environment");
  const tracked = execFileSync("git", ["ls-files", "stripe_backup_code.txt"], {
    cwd: ROOT,
    encoding: "utf-8",
  }).trim();
  assert.equal(tracked, "", "stripe_backup_code.txt is tracked");
});
