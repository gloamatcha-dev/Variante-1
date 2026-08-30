import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// SAFE DEFAULT SUITE: static SQL and source inspection only. No database
// is opened, no SQL is executed, no Supabase client is constructed, no
// Stripe API is called and no email is sent. Nothing here requires
// TEST_SUPABASE_*, and nothing here applies a migration.
//
// What it protects: migration 036 makes exactly two changes - a fourth
// delivery family and one server-only status writer - and touches
// nothing else. In particular it must not become a second activation
// path, a way back out of 'cancelled', or a grant that lets a browser
// role move a customer between billing states.

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf-8");
const NEWLINE = String.fromCharCode(10);

const MIGRATIONS_DIR = path.join(ROOT, "supabase/migrations");
const MIGRATION_035 = "035_subscription_email_deliveries.sql";
const MIGRATION_036 = "036_subscription_payment_status.sql";
const FUNCTION = "public.sync_subscription_payment_status(text, text)";

/**
 * Code only. The migration's prose deliberately NAMES what it refuses to
 * do - 'paused', 'incomplete', last_paid_period_end, a column-scoped
 * UPDATE grant - so a scan that read the comments would report every
 * deliberate avoidance as a violation of itself.
 */
const withoutComments = source => source
  .split(NEWLINE)
  .filter(line => {
    const t = line.trim();
    return !t.startsWith("--") && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
  })
  .join(NEWLINE);

const migration035 = read(`supabase/migrations/${MIGRATION_035}`);
const migration036 = read(`supabase/migrations/${MIGRATION_036}`);
const sql035 = withoutComments(migration035);
const sql036 = withoutComments(migration036);

/** Lowercased and whitespace-collapsed, so formatting cannot hide a statement. */
const flat036 = sql036.toLowerCase().replace(/\s+/g, " ");

/** The function body, which is where every guard lives. */
const functionBody = (() => {
  const start = sql036.indexOf("create or replace function public.sync_subscription_payment_status");
  assert.notEqual(start, -1, "the reconciliation function was not found");
  const end = sql036.indexOf("$$;", start);
  assert.ok(end > start, "the function is not terminated");
  return sql036.slice(start, end + 3);
})();

/** The migrations that are LIVE and IMMUTABLE, by name. */
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
  MIGRATION_035,
];

/* ══════════════════════════════════════════════════════════════
   1-4. NUMBERING AND IMMUTABILITY
   ══════════════════════════════════════════════════════════════ */

test("1, 2: 036 exists, owns its number, and 037 is the only thing above it", () => {
  const files = readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith(".sql")).sort();
  assert.ok(files.includes(MIGRATION_036), "migration 036 is missing");
  assert.deepEqual(files.filter(f => f.startsWith("036")), [MIGRATION_036]);
  // PHASE 3J.B1 ADDED MIGRATION 037 (the invoice-keyed refund-state
  // writer), reviewed in
  // tests/subscription-refund-correlation-migration.test.mjs. 036 still
  // owns its number and is unedited; it is simply no longer the last.
  // Phase 4B1 added 039, the B2C prepaid annual plan foundation,
  // reviewed in tests/annual-plan-foundation-migration.test.mjs. The
  // guard is re-pinned, not deleted: it protects "no UNREVIEWED
  // migration appeared", never "the stack stopped growing".
  assert.equal(files[files.length - 1], "039_b2c_annual_plan_foundation.sql");
  assert.equal(files[files.length - 2], "038_one_time_refund_writer_concurrency.sql");
  assert.equal(files[files.length - 3], "037_subscription_refund_correlation.sql");
  assert.equal(files[files.length - 4], MIGRATION_036, "036 must still be the one before 037");
  assert.deepEqual(files.filter(f => f.startsWith("037")), ["037_subscription_refund_correlation.sql"]);
  assert.ok(!files.some(f => f.startsWith("040")), "a 040 appeared");
  assert.equal(files.length, 39);
  // No number is used twice.
  const numbers = files.map(f => f.slice(0, 3));
  assert.equal(new Set(numbers).size, numbers.length);
});

test("3: migrations 022 through 035 are all still present, none renamed", () => {
  const files = readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith(".sql"));
  for (const name of IMMUTABLE_MIGRATIONS) {
    assert.ok(files.includes(name), `${name} was renamed or deleted`);
  }
  // And none of them was edited in this working tree.
  const changed = execFileSync("git", ["diff", "--name-only", "HEAD", "--", "supabase/migrations/"], {
    cwd: ROOT,
    encoding: "utf-8",
  }).trim();
  const touched = changed ? changed.split(NEWLINE) : [];
  for (const file of touched) {
    // 037 is a NEW file, not an edit, so it may legitimately appear here
    // once it is staged, and 038 is still UNAPPLIED so it may genuinely be
    // edited in place. Nothing older may.
    // 039, the annual plan foundation, is UNAPPLIED and may likewise be
    // edited in place until the owner applies it.
    assert.ok(file.endsWith(MIGRATION_036)
      || file.endsWith("037_subscription_refund_correlation.sql")
      || file.endsWith("038_one_time_refund_writer_concurrency.sql")
      || file.endsWith("039_b2c_annual_plan_foundation.sql"),
      `an immutable migration was modified: ${file}`);
  }
});

test("4: migration 035's own family CHECK is untouched in its file", () => {
  // 036 replaces the constraint in the DATABASE. 035's text must still
  // say exactly what it said when it was applied.
  assert.ok(sql035.includes(`add constraint subscription_email_deliveries_family_check
  check (family in (
    'subscription_started',
    'cancellation_confirmation',
    'subscription_ended'
  ));`), "035's family CHECK text changed");
  assert.ok(!sql035.includes("payment_problem"), "035 must not name the fourth family");
});

/* ══════════════════════════════════════════════════════════════
   5-12. THE FAMILY CHECK
   ══════════════════════════════════════════════════════════════ */

test("5: 036 drops the exact known constraint, and does not use IF EXISTS", () => {
  assert.ok(sql036.includes(
    "alter table public.subscription_email_deliveries\n  drop constraint subscription_email_deliveries_family_check;"
  ), "036 must drop 035's constraint by its exact name");
  // Fail closed on drift: a DROP ... IF EXISTS would let 036 succeed
  // against a schema nobody had verified.
  assert.ok(!/drop constraint if exists/i.test(sql036),
    "036 must fail rather than silently build a different state");
});

test("6-8: exactly four families, including payment_problem", () => {
  const at = sql036.indexOf("add constraint subscription_email_deliveries_family_check");
  assert.notEqual(at, -1);
  const block = sql036.slice(at, sql036.indexOf("));", at) + 3);
  const values = [...block.matchAll(/'([a-z_]+)'/g)].map(m => m[1]);
  assert.deepEqual(values, [
    "subscription_started",
    "cancellation_confirmation",
    "subscription_ended",
    "payment_problem",
  ], "the family vocabulary is not exactly the four reviewed values");
  // The three existing families are re-stated exactly as 035 wrote them.
  for (const family of ["subscription_started", "cancellation_confirmation", "subscription_ended"]) {
    assert.ok(sql035.includes(`'${family}'`), `035 no longer names ${family}`);
  }
});

test("8b: no fifth family and no invented vocabulary appears", () => {
  for (const forbidden of [
    "payment_failed", "payment_recovered", "invoice_failed", "billing_problem",
    "payment_retry", "dunning", "past_due_email",
  ]) {
    assert.ok(!sql036.includes(forbidden), `036 invents a family: ${forbidden}`);
  }
});

test("9-12: the delivery table gains no column, index, grant or policy", () => {
  const deliveryStatements = flat036
    .split(";")
    .map(s => s.trim())
    .filter(s => s.includes("subscription_email_deliveries"));
  assert.ok(deliveryStatements.length > 0);
  for (const stmt of deliveryStatements) {
    // Only the two constraint statements may name this table.
    assert.ok(
      stmt.startsWith("alter table public.subscription_email_deliveries drop constraint")
        || stmt.startsWith("alter table public.subscription_email_deliveries add constraint"),
      `036 touches the delivery table in an unexpected way: ${stmt.slice(0, 90)}`
    );
  }
  for (const forbidden of [
    "add column", "drop column", "create index", "create trigger",
    "create policy", "enable row level security", "disable row level security",
  ]) {
    assert.ok(!flat036.includes(forbidden), `036 changes table shape: ${forbidden}`);
  }
  // And no grant or revoke names a TABLE at all.
  for (const stmt of flat036.split(";").map(s => s.trim())) {
    if (stmt.startsWith("grant ") || stmt.startsWith("revoke ")) {
      assert.ok(stmt.includes("on function "), `036 changes a table privilege: ${stmt.slice(0, 90)}`);
    }
  }
});

/* ══════════════════════════════════════════════════════════════
   13-23. THE FUNCTION SHAPE
   ══════════════════════════════════════════════════════════════ */

test("13-20: the function has exactly the reviewed signature and safety flags", () => {
  assert.ok(sql036.includes(`create or replace function public.sync_subscription_payment_status(
  p_stripe_subscription_id text,
  p_stripe_status          text
)`), "the signature is not the two text parameters reviewed");
  assert.ok(sql036.includes("returns jsonb"), "it must return jsonb");
  assert.ok(sql036.includes("language plpgsql"));
  assert.ok(sql036.includes("volatile"));
  assert.ok(sql036.includes("security definer set search_path = ''"),
    "SECURITY DEFINER with an empty search_path is mandatory");
  // Exactly one function is created.
  assert.equal((sql036.match(/create or replace function/g) ?? []).length, 1);
  assert.equal((sql036.match(/create function/g) ?? []).length, 0);
});

test("21: every table reference inside the function is fully qualified", () => {
  // An empty search_path means an unqualified name cannot resolve.
  for (const ref of ["public.subscriptions"]) {
    assert.ok(functionBody.includes(ref), `the function lost ${ref}`);
  }
  // No bare table name in a from/update/join.
  assert.ok(!/\bfrom\s+subscriptions\b/.test(functionBody));
  assert.ok(!/\bupdate\s+subscriptions\b/.test(functionBody));
  assert.ok(!/\bjoin\s+subscriptions\b/.test(functionBody));
  // And no dynamic SQL at all.
  for (const forbidden of ["execute format", "execute '", "quote_ident", "quote_literal"]) {
    assert.ok(!functionBody.toLowerCase().includes(forbidden), `dynamic SQL: ${forbidden}`);
  }
});

test("22, 23: it finds the row by stripe_subscription_id and locks it", () => {
  assert.ok(functionBody.includes("where stripe_subscription_id = btrim(p_stripe_subscription_id)"),
    "the lookup must be by the Stripe subscription id");
  assert.ok(functionBody.includes("for update"), "the row must be locked before the guards");
  // Never resolved by anything a caller could forge or a customer shares.
  for (const forbidden of ["customer_snapshot", "email", "metadata", "user_id"]) {
    assert.ok(!functionBody.includes(forbidden), `the lookup could use ${forbidden}`);
  }
  // The lock precedes every guard and the write.
  const lockAt = functionBody.indexOf("for update");
  assert.ok(lockAt < functionBody.indexOf("update public.subscriptions"));
  assert.ok(lockAt < functionBody.indexOf("'pending'"));
});

/* ══════════════════════════════════════════════════════════════
   24-32. INPUT AND STRIPE STATUS GUARDS
   ══════════════════════════════════════════════════════════════ */

test("24, 25: blank or null input is refused without throwing", () => {
  assert.ok(functionBody.includes("p_stripe_subscription_id is null"));
  assert.ok(functionBody.includes("btrim(p_stripe_subscription_id) = ''"));
  assert.ok(functionBody.includes("p_stripe_status is null"));
  assert.ok(functionBody.includes("btrim(p_stripe_status) = ''"));
  assert.ok(functionBody.includes("'result', 'invalid_input'"));
  // It reports rather than raising: a caller bug must not turn the
  // Stripe webhook into a 500.
  assert.ok(!/\braise\b/.test(functionBody), "the function must not raise");
});

test("26-32: only active, past_due and unpaid may be mirrored", () => {
  assert.ok(functionBody.includes("if v_target not in ('active', 'past_due', 'unpaid') then"),
    "the Stripe target allowlist changed");
  assert.ok(functionBody.includes("'result', 'ignored_status'"));
  // Every other Stripe status must be absent as a WRITABLE target. The
  // allowlist is the ONLY place v_target is compared to literals, so a
  // second comparison anywhere would be a second, unreviewed rule.
  const targetLines = functionBody
    .split(NEWLINE)
    .map(l => l.trim())
    .filter(l => l.includes("v_target") && (l.includes(" in ") || l.includes("= '")));
  assert.deepEqual(targetLines, ["if v_target not in ('active', 'past_due', 'unpaid') then"],
    "v_target is compared somewhere beyond the single allowlist");
  // And none of Stripe's other statuses is written anywhere in the body.
  for (const ignored of ["canceled", "incomplete", "incomplete_expired", "trialing", "paused"]) {
    assert.ok(!functionBody.includes(`'${ignored}'`),
      `${ignored} appears in the executable body`);
  }
  // 'cancelled' appears only as the LOCAL terminal guard, never as a
  // Stripe input value or a write target.
  assert.equal((functionBody.match(/'cancelled'/g) ?? []).length, 1);
  assert.ok(functionBody.includes("if v_sub.status = 'cancelled' then"));
  // The allowlist is checked BEFORE the row is read, so an unsupported
  // status costs no lock.
  assert.ok(functionBody.indexOf("v_target not in") < functionBody.indexOf("for update"));
});

/* ══════════════════════════════════════════════════════════════
   33-38. LOCAL STATE GUARDS
   ══════════════════════════════════════════════════════════════ */

test("33: a pending subscription is never updated", () => {
  assert.ok(functionBody.includes("if v_sub.status = 'pending' then"));
  assert.ok(functionBody.includes("'result', 'pending_no_payment_proof'"));
  const guardAt = functionBody.indexOf("if v_sub.status = 'pending' then");
  const writeAt = functionBody.indexOf("update public.subscriptions");
  assert.ok(guardAt !== -1 && guardAt < writeAt, "the pending guard must precede the write");
  // And 022 still owns the only pending -> active transition.
  const sql022 = withoutComments(read("supabase/migrations/022_recurring_subscription_foundation.sql"));
  assert.ok(sql022.includes("status                 = 'active'"));
});

test("34: a cancelled subscription is never updated", () => {
  assert.ok(functionBody.includes("if v_sub.status = 'cancelled' then"));
  assert.ok(functionBody.includes("'result', 'terminal'"));
  const guardAt = functionBody.indexOf("if v_sub.status = 'cancelled' then");
  assert.ok(guardAt < functionBody.indexOf("update public.subscriptions"));
  // 034 remains the only writer of 'cancelled'.
  const sql034 = withoutComments(read("supabase/migrations/034_subscription_cancellation.sql"));
  assert.ok(sql034.includes("set status       = 'cancelled',"));
  assert.ok(!functionBody.includes("= 'cancelled'\n"), "036 must not write 'cancelled'");
});

test("35, 36: paused is ignored, and only three local states may transition", () => {
  assert.ok(functionBody.includes("if v_sub.status not in ('active', 'past_due', 'unpaid') then"),
    "the local allowlist changed");
  assert.ok(functionBody.includes("'result', 'ignored_local_status'"));
  // 'paused' is never written, and no pause feature is introduced.
  assert.ok(!functionBody.includes("'paused'"), "036 must not act on paused");
  assert.ok(!sql036.includes("resume"), "036 must not invent pause/resume");
});

test("36b: the full matrix among the three is allowed, with no assumed sequence", () => {
  // The write is `set status = v_target` with both sides validated by
  // allowlist, so every pairing among the three is permitted. Nothing
  // hardcodes active -> past_due -> unpaid.
  assert.ok(functionBody.includes("set status = v_target"));
  for (const forbidden of [
    "past_due' and v_target = 'unpaid",
    "if v_sub.status = 'active' and v_target",
    "attempt_count", "next_payment_attempt",
  ]) {
    assert.ok(!functionBody.includes(forbidden), `a dunning sequence is assumed: ${forbidden}`);
  }
});

test("37: an unchanged status performs no UPDATE", () => {
  assert.ok(functionBody.includes("if v_sub.status = v_target then"));
  assert.ok(functionBody.includes("'result', 'unchanged'"));
  const unchangedAt = functionBody.indexOf("if v_sub.status = v_target then");
  const writeAt = functionBody.indexOf("update public.subscriptions");
  assert.ok(unchangedAt !== -1 && unchangedAt < writeAt,
    "the unchanged branch must return before the write, so updated_at does not move");
});

/* ══════════════════════════════════════════════════════════════
   38-45. THE WRITE ITSELF
   ══════════════════════════════════════════════════════════════ */

test("38-45: exactly one column is written, and it is status", () => {
  const updates = functionBody.match(/update public\.subscriptions[\s\S]*?;/g) ?? [];
  assert.equal(updates.length, 1, "there must be exactly one UPDATE");
  const stmt = updates[0];
  assert.ok(stmt.includes("set status = v_target"));
  assert.ok(stmt.includes("where id = v_sub.id"));
  // Every column the migration promises not to touch.
  for (const column of [
    "last_paid_period_end", "started_at", "cancelled_at",
    "cancellation_requested_at", "cancellation_effective_at", "cancel_at",
    "current_period_start", "current_period_end", "next_delivery_at",
    "stripe_subscription_id", "customer_snapshot", "plan_snapshot",
    "shipping_address_snapshot", "billing_address_snapshot", "tax_snapshot",
    "user_id", "plan_id", "created_at", "updated_at",
  ]) {
    assert.ok(!stmt.includes(column), `the UPDATE writes ${column}`);
  }
  // last_paid_period_end is payment PROOF and must not be nameable at all
  // in the executable body: a failed payment can never advance it.
  assert.ok(!functionBody.includes("last_paid_period_end"),
    "the function must not reference the payment proof column");
});

/* ══════════════════════════════════════════════════════════════
   46-48. NO DATA CHANGE
   ══════════════════════════════════════════════════════════════ */

test("46-48: the migration inserts, deletes and backfills nothing", () => {
  // Statement-level: the only executable statements are two ALTERs, one
  // CREATE FUNCTION, four REVOKEs and one GRANT.
  const statements = flat036.split(";").map(s => s.trim()).filter(Boolean);
  const allowed = ["alter table ", "create or replace function", "revoke all on function", "grant execute on function"];
  for (const stmt of statements) {
    // The function body's own statements live inside the CREATE, which
    // the split breaks up; anything before `end` belongs to it.
    if (stmt.startsWith("declare") || stmt.startsWith("begin") || stmt.startsWith("if ")
      || stmt.startsWith("return") || stmt.startsWith("select ") || stmt.startsWith("update public.subscriptions")
      || stmt.startsWith("v_target") || stmt.startsWith("end") || stmt.startsWith("$$")) continue;
    assert.ok(
      allowed.some(prefix => stmt.startsWith(prefix)),
      `unexpected top-level statement: ${stmt.slice(0, 90)}`
    );
  }
  // No DML outside the function body.
  const outsideFunction = sql036.replace(functionBody, "");
  for (const forbidden of ["insert into", "delete from", "update public."]) {
    assert.ok(!outsideFunction.toLowerCase().includes(forbidden),
      `036 executes DML at apply time: ${forbidden}`);
  }
  // And it never calls its own function.
  assert.ok(!flat036.includes("select public.sync_subscription_payment_status"));
  assert.ok(!flat036.includes("perform public.sync_subscription_payment_status"));
});

/* ══════════════════════════════════════════════════════════════
   49-55. PRIVILEGES
   ══════════════════════════════════════════════════════════════ */

test("49-52: PUBLIC, anon and authenticated are revoked; only service_role executes", () => {
  for (const role of ["public", "anon", "authenticated", "service_role"]) {
    assert.ok(
      sql036.includes(`revoke all on function ${FUNCTION} from ${role};`),
      `revoke from ${role} is missing - a default EXECUTE would survive`
    );
  }
  assert.ok(sql036.includes(`grant execute on function ${FUNCTION} to service_role;`));
  // Exactly one grant, and it is to the server role.
  const grants = flat036.split(";").map(s => s.trim()).filter(s => s.startsWith("grant "));
  assert.equal(grants.length, 1);
  assert.ok(grants[0].endsWith("to service_role"));
  // The revokes come before the grant, or they would undo it.
  const revokeAt = sql036.indexOf(`revoke all on function ${FUNCTION} from service_role;`);
  const grantAt = sql036.indexOf(`grant execute on function ${FUNCTION} to service_role;`);
  assert.ok(revokeAt !== -1 && grantAt !== -1 && revokeAt < grantAt);
});

test("53-55: no table grant changes, and no browser write privilege exists", () => {
  // 036 contains no table grant at all - asserted structurally above and
  // by name here.
  for (const forbidden of [
    "on public.subscriptions to", "on public.subscription_email_deliveries to",
    "grant update", "grant insert", "grant delete", "grant all",
  ]) {
    assert.ok(!flat036.includes(forbidden), `036 changes a table privilege: ${forbidden}`);
  }
  // The live grants those tables carry are still only in 022/005 and 035.
  const sql022 = withoutComments(read("supabase/migrations/022_recurring_subscription_foundation.sql"));
  assert.ok(sql022.includes("grant select on public.subscriptions to service_role;"));
  assert.ok(!sql022.includes("grant update on public.subscriptions"));
  assert.ok(sql035.includes("grant select on public.subscription_email_deliveries to service_role;"));
  assert.ok(sql035.includes("grant insert (subscription_id, family, event_key, status)"));
  assert.ok(sql035.includes("grant update (status, sent_at)"));
  // And no browser role is granted anything anywhere in 036.
  assert.ok(!flat036.includes("to anon"));
  assert.ok(!flat036.includes("to authenticated"));
});

/* ══════════════════════════════════════════════════════════════
   56-60. NOTHING ELSE MOVED
   ══════════════════════════════════════════════════════════════ */

test("56: the migration executes the new function zero times", () => {
  // The only executable occurrences are the CREATE, the four REVOKEs and
  // the one GRANT. Any seventh would be a call.
  const mentions = (sql036.match(/sync_subscription_payment_status/g) ?? []).length;
  assert.equal(mentions, 6, "unexpected reference to the function in executable SQL");
  for (const call of ["select public.sync", "perform public.sync", "= public.sync"]) {
    assert.ok(!flat036.includes(call), `036 calls its own function: ${call}`);
  }
});

test("57, 58: the launch gates are unchanged", () => {
  const checkoutRules = read("lib/subscriptionCheckoutRules.ts");
  assert.ok(checkoutRules.includes('export const SUBSCRIPTION_FEATURE_FLAG = "B2C_SUBSCRIPTIONS_ENABLED"'));
  assert.ok(checkoutRules.includes('env[SUBSCRIPTION_FEATURE_FLAG] === "true"'));
  assert.ok(read("app/content.ts").includes('export const SHOP_STATUS = "prelaunch"'));
  assert.ok(!sql036.includes("B2C_SUBSCRIPTIONS_ENABLED"));
});

test("59: the migration itself still reaches no email machinery", () => {
  // PHASE 3I.B2 WIRED THE RUNTIME, so this guard no longer asserts that
  // no application code exists. What still holds is the property that
  // made 036 reviewable on its own: the MIGRATION touches nothing the
  // email families own, and its function writes one column.
  //
  // 036 names none of the email machinery.
  for (const forbidden of [
    "subscription_started", "cancellation_confirmation", "subscription_ended",
    "sending", "sent_at", "superseded",
  ]) {
    assert.ok(!functionBody.includes(forbidden), `the function reaches email state: ${forbidden}`);
  }
});

test("60: the RPC is reached only through its one wrapper, refunds untouched", () => {
  // PHASE 3I.B2 WIRED IT. What still holds is that the RPC has exactly
  // ONE caller in the whole codebase - lib/subscriptionPaymentStatus.ts -
  // so the guards in 036 cannot be bypassed by a second call site with
  // its own idea of which statuses are safe.
  const callers = [];
  for (const dir of ["lib", "app/api/stripe/webhook"]) {
    const base = path.join(ROOT, dir);
    for (const f of readdirSync(base)) {
      if (!f.endsWith(".ts")) continue;
      const source = withoutComments(readFileSync(path.join(base, f), "utf-8"));
      if (source.includes('rpc("sync_subscription_payment_status"')) callers.push(f);
    }
  }
  assert.deepEqual(callers, ["subscriptionPaymentStatus.ts"],
    "the payment status RPC gained a second caller");
  // The refund correlation defect is untouched.
  const refunds = withoutComments(read("lib/orderRefunds.ts"));
  assert.ok(!refunds.includes("sync_subscription_payment_status"));
  assert.ok(!refunds.includes("payment_problem"));
});

test("60b: stripe_backup_code.txt is not tracked and is referenced nowhere", () => {
  const tracked = execFileSync("git", ["ls-files", "stripe_backup_code.txt"], {
    cwd: ROOT,
    encoding: "utf-8",
  }).trim();
  assert.equal(tracked, "", "stripe_backup_code.txt must never be tracked or staged");
  assert.ok(!migration036.includes("stripe_backup_code"));
});
