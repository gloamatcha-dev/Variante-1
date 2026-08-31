import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ANNUAL_PLAN_ACCOUNT_SELECT,
  ANNUAL_PLAN_DELIVERY_ACCOUNT_SELECT,
} from "../lib/annualPlanAccount.ts";

/* ══════════════════════════════════════════════════════════════
   PHASE 4B8.1 - MIGRATION 041, THE ANNUAL ACCOUNT READ SURFACE

   STATIC SUITE. It reads SQL text and asserts what the statements say.
   NOTHING here connects to a database, applies a migration, opens a
   socket or reads an environment variable. 041 is written and reviewed
   in this phase and applied by hand afterwards, exactly as 040 was.

   What it protects: a customer's own Supabase client may read the
   columns of a prepaid contract that describe the contract, and may not
   read the ones that identify its money or carry authority - above all
   purchase_confirmation_email_claim_token, which is a capability rather
   than a fact.
   ══════════════════════════════════════════════════════════════ */

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf-8");
const NEWLINE = String.fromCharCode(10);

const MIGRATION = "supabase/migrations/041_annual_account_column_privileges.sql";
const sql = read(MIGRATION);

/** The statements PostgreSQL would actually run: no comment lines. */
const executable = sql
  .split(NEWLINE)
  .filter(line => !line.trim().startsWith("--"))
  .join(NEWLINE);

const lower = executable.toLowerCase();

/** The grant list for one table, as written. */
const grantColumns = table => {
  const at = executable.indexOf(`) on table public.${table} to authenticated;`);
  assert.notEqual(at, -1, `no column grant for ${table}`);
  const open = executable.lastIndexOf("grant select (", at);
  assert.notEqual(open, -1, `no grant statement for ${table}`);
  return executable
    .slice(open + "grant select (".length, at)
    .split(",")
    .map(c => c.trim())
    .filter(Boolean);
};

const PLAN_GRANTS = grantColumns("annual_plans");
const DELIVERY_GRANTS = grantColumns("annual_plan_deliveries");

const selectColumns = select => select.split(",").map(c => c.trim()).filter(Boolean);

/* ══════════════════════════════════════════════════════════════
   1-4. THE FILE ITSELF
   ══════════════════════════════════════════════════════════════ */

test("1: 041 is the newest migration, and 001-040 are untouched", () => {
  const migrations = readdirSync(path.join(ROOT, "supabase/migrations"))
    .filter(f => f.endsWith(".sql")).sort();
  assert.equal(migrations.length, 41);
  assert.equal(migrations[38], "039_b2c_annual_plan_foundation.sql");
  assert.equal(migrations[39], "040_annual_checkout_retry_fingerprints.sql");
  assert.equal(migrations[40], "041_annual_account_column_privileges.sql");
  assert.deepEqual(migrations.filter(f => Number(f.slice(0, 3)) > 41), [], "a 042 appeared");

  // No live migration was edited to make room for this one.
  const changed = execFileSync("git", ["diff", "--name-only", "HEAD", "--", "supabase/migrations/"],
    { cwd: ROOT, encoding: "utf-8" }).trim();
  assert.equal(changed, "", "a live, immutable migration was edited");
});

test("2: everything executable is inside ONE transaction", () => {
  const begin = executable.indexOf("begin;");
  const commit = executable.indexOf("commit;");
  assert.ok(begin > -1, "041 does not open a transaction");
  assert.ok(commit > begin, "041 does not commit after it begins");
  assert.equal(executable.indexOf("begin;", begin + 1), -1, "a second transaction was opened");
  assert.equal(executable.indexOf("commit;", commit + 1), -1, "a second commit exists");

  // Every privilege statement is between them, so there is no window
  // where the table grant is gone and the column grants are not yet in.
  for (const statement of [
    "revoke select on table public.annual_plans           from authenticated;",
    "revoke select on table public.annual_plan_deliveries from authenticated;",
  ]) {
    const at = executable.indexOf(statement);
    assert.ok(at > begin && at < commit, `outside the transaction: ${statement}`);
  }
  for (const table of ["annual_plans", "annual_plan_deliveries"]) {
    const at = executable.indexOf(`) on table public.${table} to authenticated;`);
    assert.ok(at > begin && at < commit, `the ${table} grant is outside the transaction`);
  }
  // And nothing executable follows the commit.
  const tail = executable.slice(commit + "commit;".length).trim();
  assert.equal(tail, "", "an executable statement follows the commit");
  // The revoke precedes the grants: a table-level SELECT left in place
  // would answer for every column and make the grants decorative.
  assert.ok(executable.indexOf("revoke select on table public.annual_plans") <
    executable.indexOf(") on table public.annual_plans to authenticated;"));
});

test("3: it changes privileges and NOTHING else", () => {
  for (const banned of [
    "create table", "alter table", "drop table", "create index", "drop index",
    "create function", "create or replace function", "drop function",
    "create policy", "drop policy", "alter policy",
    "enable row level security", "disable row level security",
    "insert into", "update ", "delete from", "truncate", "alter column",
    "create trigger", "create type", "comment on",
  ]) {
    assert.ok(!lower.includes(banned), `041 contains ${banned}`);
  }
  // Exactly four privilege statements: two revokes and two grants.
  assert.equal((executable.match(/^revoke /gm) ?? []).length, 2);
  assert.equal((executable.match(/^grant /gm) ?? []).length, 2);
  // Every grant is SELECT. No write reaches a browser role.
  for (const write of ["insert", "update", "delete", "truncate", "references", "trigger", "all privileges"]) {
    assert.ok(!lower.includes(`grant ${write}`), `041 grants ${write}`);
  }
});

test("4: service_role and anon are not touched", () => {
  // The server reads these tables with service_role - the cron, the
  // settlement path and the refund writer all do - and narrowing that
  // would break them.
  assert.ok(!executable.includes("service_role"), "041 changes service_role privileges");
  // anon was given nothing by 039 and is given nothing here.
  assert.ok(!executable.includes("anon"), "041 mentions anon in an executable statement");
  assert.ok(!lower.includes("to public"), "041 grants to PUBLIC");
});

/* ══════════════════════════════════════════════════════════════
   5-8. THE ALLOWLIST
   ══════════════════════════════════════════════════════════════ */

test("5: the broad table-level read is removed from authenticated, on both tables", () => {
  assert.match(executable, /revoke select on table public\.annual_plans\s+from authenticated;/);
  assert.match(executable, /revoke select on table public\.annual_plan_deliveries from authenticated;/);
  // 039 is where those grants came from, and it stays as it is.
  const m039 = read("supabase/migrations/039_b2c_annual_plan_foundation.sql");
  assert.match(m039, /grant select on table public\.annual_plans\s+to authenticated;/);
});

test("6: the parent allowlist is exactly the reviewed set", () => {
  assert.deepEqual([...PLAN_GRANTS].sort(), [
    "annual_unit_gross_cents",
    "cancelled_at",
    "catalog_unit_gross_cents",
    "completed_at",
    "currency",
    "delivery_count",
    "delivery_items_snapshot",
    "discount_percent_applied",
    "id",
    "merchandise_total_gross_cents",
    "payment_status",
    "plan_end_at",
    "purchased_at",
    "refunded_total_cents",
    "shipping_per_delivery_gross_cents",
    "shipping_total_gross_cents",
    "status",
    "total_gross_cents",
  ]);
  assert.equal(PLAN_GRANTS.length, 18);
  assert.equal(new Set(PLAN_GRANTS).size, 18, "a column is granted twice");
});

test("7: no Stripe identity, capability or raw snapshot is granted", () => {
  const forbidden = [
    "user_id", "payment_checkout_attempt_id",
    "stripe_checkout_session_id", "stripe_payment_intent_id", "variant_id",
    "customer_snapshot", "shipping_address_snapshot", "billing_address_snapshot",
    "tax_snapshot", "delivery_tax_snapshot",
    "refund_updated_at", "created_at", "updated_at",
    "purchase_confirmation_email_status", "purchase_confirmation_email_sent_at",
    "purchase_confirmation_email_claimed_at", "purchase_confirmation_email_claim_token",
  ];
  for (const column of forbidden) {
    assert.ok(!PLAN_GRANTS.includes(column), `041 grants ${column}`);
  }
  // The claim token is the one that is a CAPABILITY: 039's outcome writer
  // accepts it as proof of owning a live claim.
  const m039 = read("supabase/migrations/039_b2c_annual_plan_foundation.sql");
  assert.match(m039, /p_claim_token/);
  assert.ok(!PLAN_GRANTS.includes("purchase_confirmation_email_claim_token"));
});

test("8: the delivery allowlist is exactly the reviewed set", () => {
  assert.deepEqual([...DELIVERY_GRANTS].sort(), [
    "annual_plan_id",
    "delivery_number",
    "fulfilled_at",
    "order_id",
    "scheduled_for",
    "state",
  ]);
  for (const column of ["id", "checkout_attempt_id", "claimed_at", "created_at"]) {
    assert.ok(!DELIVERY_GRANTS.includes(column), `041 grants the delivery column ${column}`);
  }
  // annual_plan_id is granted although nothing renders it: the account
  // FILTERS by it, and a filtered column needs SELECT too.
  assert.ok(DELIVERY_GRANTS.includes("annual_plan_id"));
});

/* ══════════════════════════════════════════════════════════════
   9-11. THE APPLICATION CONTRACT MATCHES THE ACL
   ══════════════════════════════════════════════════════════════ */

test("9: every column the account selects is granted by 041", () => {
  for (const column of selectColumns(ANNUAL_PLAN_ACCOUNT_SELECT)) {
    assert.ok(PLAN_GRANTS.includes(column),
      `the account selects annual_plans.${column}, which 041 does not grant`);
  }
  for (const column of selectColumns(ANNUAL_PLAN_DELIVERY_ACCOUNT_SELECT)) {
    assert.ok(DELIVERY_GRANTS.includes(column),
      `the account selects annual_plan_deliveries.${column}, which 041 does not grant`);
  }
});

test("10: and nothing is granted that the account does not select", () => {
  // Both directions, so the two contracts cannot drift apart in either
  // one: a granted column with no reader is read surface nobody audited.
  assert.deepEqual([...PLAN_GRANTS].sort(), selectColumns(ANNUAL_PLAN_ACCOUNT_SELECT).sort());
  assert.deepEqual([...DELIVERY_GRANTS].sort(), selectColumns(ANNUAL_PLAN_DELIVERY_ACCOUNT_SELECT).sort());
});

test("11: every granted column exists on the table 039 created", () => {
  const m039 = read("supabase/migrations/039_b2c_annual_plan_foundation.sql");
  const plansTable = m039.slice(
    m039.indexOf("create table public.annual_plans"),
    m039.indexOf("create table public.annual_plan_deliveries")
  );
  const deliveriesTable = m039.slice(
    m039.indexOf("create table public.annual_plan_deliveries"),
    m039.indexOf("create unique index annual_plan_deliveries_checkout_attempt_id_key")
  );
  for (const column of PLAN_GRANTS) {
    assert.ok(new RegExp(`^\\s+${column}\\s`, "m").test(plansTable),
      `annual_plans has no column ${column}`);
  }
  for (const column of DELIVERY_GRANTS) {
    assert.ok(new RegExp(`^\\s+${column}\\s`, "m").test(deliveriesTable),
      `annual_plan_deliveries has no column ${column}`);
  }
});

/* ══════════════════════════════════════════════════════════════
   12-14. RLS IS UNCHANGED, AND STILL REQUIRED
   ══════════════════════════════════════════════════════════════ */

test("12: 041 touches no policy and does not disable row security", () => {
  for (const banned of ["policy", "row level security", "force row"]) {
    assert.ok(!lower.includes(banned), `041 executable SQL contains ${banned}`);
  }
  // 039 keeps both policies, and they still scope by owner.
  const m039 = read("supabase/migrations/039_b2c_annual_plan_foundation.sql");
  assert.match(m039, /create policy "Users read own annual plans"[\s\S]{0,200}using \(auth\.uid\(\) = user_id\)/);
  assert.match(m039, /create policy "Users read own annual plan deliveries"[\s\S]{0,400}p\.user_id = auth\.uid\(\)/);
  assert.match(m039, /alter table public\.annual_plans\s+enable row level security;/);
});

test("13: the two protections are documented as both required", () => {
  // Column grants decide WHICH COLUMNS; RLS decides WHICH ROWS. Neither
  // replaces the other, and the file says so where a future reader will
  // look before relaxing one of them.
  assert.match(sql, /COLUMN GRANTS AND RLS ARE NOT\n--\s+ALTERNATIVES/);
  assert.match(sql, /RLS decides WHICH ROWS a customer\n-- may read\. It says nothing at all about WHICH COLUMNS\./);
});

test("14: the verify section is commented, read-only, and proves each claim", () => {
  const verify = sql.slice(sql.lastIndexOf(NEWLINE, sql.indexOf("4. VERIFY")) + 1);
  for (const line of verify.split(NEWLINE)) {
    if (line.trim() === "") continue;
    assert.ok(line.trim().startsWith("--"), `an executable line is in the verify section: ${line}`);
  }
  // Both metadata representations, not just one.
  assert.match(verify, /information_schema\.role_table_grants/);
  assert.match(verify, /has_table_privilege\('authenticated', 'public\.annual_plans', 'select'\)/);
  assert.match(verify, /information_schema\.column_privileges/);
  assert.match(verify, /has_column_privilege\('authenticated', 'public\.annual_plans', column_name, 'select'\)/);
  // RLS and the policies.
  assert.match(verify, /pg_policies/);
  assert.match(verify, /relrowsecurity/);
  // The star select and the capability columns are probed by name.
  assert.match(verify, /select \* from public\.annual_plans;/);
  assert.match(verify, /select purchase_confirmation_email_claim_token from public\.annual_plans;/);
  // And the whole probe runs as the browser role and rolls back.
  assert.match(verify, /set local role authenticated;/);
  assert.match(verify, /rollback;/);
  // Read-only: the verify section issues no write of any kind. Checked on
  // the SQL it would run if uncommented, since its prose legitimately
  // names the statement classes it proves are absent.
  const verifySql = verify
    .split(NEWLINE)
    .map(line => line.replace(/^\s*--\s?/, ""))
    .filter(line => !/^[A-Z0-9 .,'`-]+$/.test(line.trim()))
    .join(NEWLINE)
    .toLowerCase();
  for (const banned of ["insert into", "update public.", "delete from", "drop table", "alter table"]) {
    assert.ok(!verifySql.includes(banned), `the verify section contains ${banned}`);
  }
  // And it starts no statement that could change anything: the scan is
  // anchored to statement openings, so the section's own prose about the
  // grants it proves absent cannot trip it.
  for (const [label, pattern] of [
    ["insert", /^\s*insert\s+into\b/im],
    ["update", /^\s*update\s+\w/im],
    ["delete", /^\s*delete\s+from\b/im],
    ["drop", /^\s*drop\s+\w/im],
    ["alter", /^\s*alter\s+\w/im],
    ["grant", /^\s*grant\s+[\w(), ]+\s+on\b/im],
    ["revoke", /^\s*revoke\s+\w/im],
    ["truncate", /^\s*truncate\b/im],
    ["create", /^\s*create\s+\w/im],
    ["commit", /^\s*commit\s*;/im],
  ]) {
    assert.ok(!pattern.test(verifySql), `the verify section starts a ${label} statement`);
  }
  // What it does run: reads, and a rolled-back role probe.
  assert.ok(/^\s*select\s/im.test(verifySql), "the verify section lost its queries");
  assert.ok(/^\s*begin;/im.test(verifySql) && /^\s*rollback;/im.test(verifySql));
});

/* ══════════════════════════════════════════════════════════════
   15-16. THE HEADER, AND THE STAR SELECT
   ══════════════════════════════════════════════════════════════ */

test("15: the header states the boundary this migration establishes", () => {
  const header = sql.slice(0, sql.indexOf("begin;"));
  for (const claim of [
    "Migrations 001-040 are LIVE, VERIFIED and IMMUTABLE",
    "PRIVILEGES ONLY",
    "It does not touch RLS",
    "It does not touch service_role",
    "It grants anon nothing",
    "It grants no INSERT, UPDATE or DELETE",
    "It changes no data",
  ]) {
    assert.ok(header.includes(claim), `the header does not state: ${claim}`);
  }
  // And it names the contingency for the one thing that can only be
  // confirmed against a live database.
  assert.match(header, /grant select \(user_id\) on public\.annual_plans to authenticated;/);
});

test("16: after 041 a star select cannot succeed for authenticated", () => {
  // The property, stated as the ACL arithmetic it is: a star expands to
  // EVERY column, the grant names a strict subset, and a column with no
  // grant refuses the whole statement. The proof that it holds on the
  // live database is verify section E3.
  const m039 = read("supabase/migrations/039_b2c_annual_plan_foundation.sql");
  const plansTable = m039.slice(
    m039.indexOf("create table public.annual_plans"),
    m039.indexOf("create table public.annual_plan_deliveries")
  );
  const allColumns = [...plansTable.matchAll(/^ {2}([a-z_]+) +[a-z]/gm)].map(m => m[1]);
  assert.ok(allColumns.length > PLAN_GRANTS.length,
    "the allowlist covers every column, so a star select would still work");
  const ungranted = allColumns.filter(c => !PLAN_GRANTS.includes(c));
  for (const column of [
    "stripe_payment_intent_id", "purchase_confirmation_email_claim_token", "customer_snapshot",
  ]) {
    assert.ok(ungranted.includes(column), `${column} is not in the ungranted set`);
  }
  assert.match(sql, /`select \*` fails for authenticated/);
});
