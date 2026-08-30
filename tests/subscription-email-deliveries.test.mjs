import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// SAFE DEFAULT SUITE: static source and SQL inspection only. No database
// is opened, no SQL is executed, no Supabase client is constructed, no
// Stripe call is made and no email is sent. Nothing here requires
// TEST_SUPABASE_*, and nothing here writes a file.
//
// What it protects: migration 035 creates ONE server-only delivery table
// and touches nothing that already exists. The three families are the
// three that were designed; 'payment_problem' is absent. The status
// vocabulary is the four that were designed; 'pending' is absent and
// unreachable. The table is invisible to a browser, has no DELETE grant,
// and is created EMPTY, so no subscription that exists today can enter a
// retry sweep.

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf-8");
const NEWLINE = String.fromCharCode(10);

const MIGRATIONS_DIR = path.join(ROOT, "supabase/migrations");
const MIGRATION_035 = "035_subscription_email_deliveries.sql";
const TABLE = "public.subscription_email_deliveries";

/**
 * Code only. The migration's prose deliberately NAMES the things it does
 * not do - 'payment_problem', 'pending', DELETE, the refund defect - so a
 * scan that read the comments would report each deliberate avoidance as a
 * violation of itself. Same helper, same reason, as
 * tests/subscription-cancellation.test.mjs.
 */
const withoutComments = source => source
  .split(NEWLINE)
  .filter(line => {
    const t = line.trim();
    return !t.startsWith("--") && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
  })
  .join(NEWLINE);

const migration035 = read(`supabase/migrations/${MIGRATION_035}`);
const sql035 = withoutComments(migration035);

/** Lowercased and whitespace-collapsed, so formatting cannot hide a statement. */
const flat = sql035.toLowerCase().replace(/\s+/g, " ");

/** Every executable statement, split on the terminator. */
const statements = flat.split(";").map(s => s.trim()).filter(Boolean);

/** The `create table ... ( ... )` body, for column-level assertions. */
const createTableBody = (() => {
  const at = flat.indexOf(`create table ${TABLE} (`);
  assert.notEqual(at, -1, "the create table statement was not found");
  return flat.slice(at, flat.indexOf(");", at));
})();

/**
 * The migrations that are LIVE and IMMUTABLE. Listed by name so a
 * deletion or a rename is a failure, not a silently smaller set.
 */
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
];

/* ══════════════════════════════════════════════════════════════
   EXISTENCE AND NUMBERING
   ══════════════════════════════════════════════════════════════ */

test("035 exists, is the only 035, and only 036 and 037 follow it", () => {
  const files = readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith(".sql"));
  assert.ok(files.includes(MIGRATION_035), "migration 035 is missing");

  const numbered = files
    .map(f => ({ file: f, n: Number.parseInt(f.slice(0, 3), 10) }))
    .filter(x => Number.isInteger(x.n));

  assert.deepEqual(
    numbered.filter(x => x.n === 35).map(x => x.file),
    [MIGRATION_035],
    "there must be exactly one migration numbered 035"
  );
  // PHASE 3I.B1 TOOK 036 for the payment_problem family and the payment
  // status RPC, PHASE 3J.B1 TOOK 037 for the invoice-keyed refund-state
  // writer, and PHASE 3K.B TOOK 038 for the one-time refund writer's
  // concurrency, and PHASE 4B1 TOOK 039 for the B2C prepaid annual plan
  // foundation. All four are reviewed in their own suites, and they
  // are the ONLY migrations permitted above 035 until a later one is
  // reviewed against this file.
  assert.deepEqual(
    numbered.filter(x => x.n > 35).map(x => x.file).sort(),
    ["036_subscription_payment_status.sql", "037_subscription_refund_correlation.sql",
     "038_one_time_refund_writer_concurrency.sql", "039_b2c_annual_plan_foundation.sql",
     "040_annual_checkout_retry_fingerprints.sql"],
    "an unreviewed migration above 035 appeared"
  );
  // And 039 leaves this table entirely alone. An annual plan's one
  // purchase confirmation lives in two columns on its own parent row,
  // deliberately NOT as a fourth family here: this table's family CHECK,
  // its event keys and its grants are unchanged.
  const sql039 = readFileSync(path.join(MIGRATIONS_DIR, "039_b2c_annual_plan_foundation.sql"), "utf-8");
  assert.ok(!sql039.includes("subscription_email_deliveries"),
    "039 reaches into the subscription email delivery table");
  // And 036 does not disturb what 035 owns beyond the family CHECK it
  // deliberately replaces: no column, no index, no grant, no policy.
  const sql036 = withoutComments(
    readFileSync(path.join(MIGRATIONS_DIR, "036_subscription_payment_status.sql"), "utf-8")
  ).toLowerCase();
  for (const forbidden of ["add column", "create index", "create policy", "create table"]) {
    assert.ok(!sql036.includes(forbidden), `036 changes the delivery table: ${forbidden}`);
  }
  assert.ok(!/grant[^;]*on public\.subscription_email_deliveries/.test(sql036),
    "036 changes a delivery table grant");
});

test("022 through 034 are all still present, none renamed or deleted", () => {
  const files = new Set(readdirSync(MIGRATIONS_DIR));
  for (const name of IMMUTABLE_MIGRATIONS) {
    assert.ok(files.has(name), `${name} is missing - the live set must not change`);
  }
});

/* ══════════════════════════════════════════════════════════════
   035 TOUCHES NOTHING THAT ALREADY EXISTS
   ══════════════════════════════════════════════════════════════

   Byte-immutability of 022-034 is enforced by review of `git diff`
   before the commit. What is asserted HERE is the property that makes
   the diff safe to trust: migration 035's own SQL cannot reach any
   object those migrations own, so it could not disturb them even if it
   ran twice.
   ══════════════════════════════════════════════════════════════ */

test("exactly one table is created, and it is the delivery table", () => {
  const creates = statements.filter(s => s.startsWith("create table"));
  assert.equal(creates.length, 1, "035 must introduce exactly one table");
  assert.ok(creates[0].startsWith(`create table ${TABLE} (`));
});

test("no column is added to public.subscriptions", () => {
  assert.ok(!flat.includes("alter table public.subscriptions"),
    "035 must not alter public.subscriptions");
  assert.ok(!flat.includes("add column"),
    "035 adds no column to any existing table");
});

test("no column is added to public.orders, and no order email column is named", () => {
  assert.ok(!flat.includes("alter table public.orders"),
    "035 must not alter public.orders");
  // The excluded family's column must not appear anywhere, not even by
  // accident: the order confirmation retry exclusion is not reopened.
  assert.ok(!flat.includes("confirmation_email_status"));
});

test("035 creates, replaces and drops no function, and adds no SECURITY DEFINER", () => {
  assert.ok(!flat.includes("create function"));
  assert.ok(!flat.includes("create or replace function"));
  assert.ok(!flat.includes("security definer"));
  // It reuses public.set_updated_at() and must not redefine it.
  assert.ok(!flat.includes("function public.set_updated_at()"
    .replace("function", "replace function")));
});

test("035 drops nothing", () => {
  assert.ok(!statements.some(s => s.startsWith("drop ")),
    "035 must not drop any object");
});

test("035 changes no grant on any pre-existing table", () => {
  const grantLike = statements.filter(s => s.startsWith("grant ") || s.startsWith("revoke "));
  assert.ok(grantLike.length > 0, "the privilege statements are missing");
  for (const stmt of grantLike) {
    assert.ok(
      stmt.includes(TABLE),
      `every grant/revoke must target ${TABLE} only, found: ${stmt}`
    );
  }
});

/* ══════════════════════════════════════════════════════════════
   THE CLOSED VOCABULARIES
   ══════════════════════════════════════════════════════════════ */

const checkConstraint = name => {
  const at = flat.indexOf(`add constraint ${name} check`);
  assert.notEqual(at, -1, `${name} is missing`);
  return flat.slice(at, flat.indexOf(";", at));
};

test("family CHECK allows exactly the three intended families", () => {
  const c = checkConstraint("subscription_email_deliveries_family_check");
  for (const family of ["subscription_started", "cancellation_confirmation", "subscription_ended"]) {
    assert.ok(c.includes(`'${family}'`), `family '${family}' is missing`);
  }
  // Exactly three, so a fourth cannot be smuggled in alongside them.
  assert.equal((c.match(/'/g) ?? []).length, 6,
    "the family CHECK must list exactly three quoted values");
});

test("payment_problem is absent from the whole migration", () => {
  // Deferred deliberately: it needs a pre-send invoice event key, a live
  // Stripe re-read and a supersession ordering, plus the unresolved
  // past_due/unpaid reconciliation. See the migration header.
  assert.ok(!flat.includes("payment_problem"));
  assert.ok(!flat.includes("invoice"),
    "no invoice fact belongs in 035 - the payment-problem family is deferred");
});

test("status CHECK allows exactly sending, sent, failed and superseded", () => {
  const c = checkConstraint("subscription_email_deliveries_status_check");
  for (const status of ["sending", "sent", "failed", "superseded"]) {
    assert.ok(c.includes(`'${status}'`), `status '${status}' is missing`);
  }
  assert.equal((c.match(/'/g) ?? []).length, 8,
    "the status CHECK must list exactly four quoted values");
});

test("pending, queued, retrying and cancelled are absent as statuses", () => {
  // Absence of a row IS the pending state. Migration 017's
  // `not null default 'pending'` is the mistake this cannot repeat.
  const c = checkConstraint("subscription_email_deliveries_status_check");
  for (const forbidden of ["pending", "queued", "retrying", "cancelled"]) {
    assert.ok(!c.includes(`'${forbidden}'`), `'${forbidden}' must not be a status`);
  }
  assert.ok(!flat.includes("'pending'"), "'pending' must not appear anywhere in 035");
});

test("status has NO DEFAULT, so a row cannot exist without a real claim", () => {
  const statusLine = createTableBody
    .split(",")
    .find(part => part.trim().startsWith("status "));
  assert.ok(statusLine, "the status column was not found");
  assert.ok(statusLine.includes("text not null"));
  assert.ok(!statusLine.includes("default"),
    "status must have no default - a default is how a historical row becomes queued work");
});

/* ══════════════════════════════════════════════════════════════
   THE INVARIANTS
   ══════════════════════════════════════════════════════════════ */

test("the unique claim guard is (subscription_id, family, event_key)", () => {
  assert.ok(
    flat.includes("unique (subscription_id, family, event_key)"),
    "the unique constraint is the race guard and must name all three columns in order"
  );
});

test("event_key cannot be blank", () => {
  const c = checkConstraint("subscription_email_deliveries_event_key_check");
  assert.ok(c.includes("length(btrim(event_key)) > 0"),
    "a blank key would collapse every occurrence of a family into one row");
});

test("sent_at is enforced in BOTH directions", () => {
  const c = checkConstraint("subscription_email_deliveries_sent_at_check");
  // sent -> sent_at present
  assert.ok(/status\s*=\s*'sent' and sent_at is not null/.test(c),
    "a 'sent' row must carry sent_at");
  // not sent -> sent_at absent. This half is the one that matters: a
  // 'failed' row still holding sent_at reads as delivered to anyone
  // querying it.
  assert.ok(/status\s*<>\s*'sent' and sent_at is null/.test(c),
    "a sending, failed or superseded row must not retain sent_at");
});

test("sent_at itself is nullable, or the biconditional could never hold", () => {
  const sentAtLine = createTableBody
    .split(",")
    .find(part => part.trim().startsWith("sent_at"));
  assert.ok(sentAtLine, "the sent_at column was not found");
  assert.ok(!sentAtLine.includes("not null"));
  assert.ok(!sentAtLine.includes("default"));
});

test("the columns are exactly the eight designed, and none of the rejected ones", () => {
  for (const col of [
    "id ", "subscription_id ", "family ", "event_key ",
    "status ", "sent_at ", "created_at ", "updated_at ",
  ]) {
    assert.ok(createTableBody.includes(col), `column ${col.trim()} is missing`);
  }
  // Deliberately absent. Each was considered and rejected in the header.
  for (const forbidden of [
    "recipient", "email_address", "error", "attempt_count",
    "stripe_", "webhook", "payload", "last_error",
  ]) {
    assert.ok(!createTableBody.includes(forbidden),
      `${forbidden} must not be a column on the delivery table`);
  }
});

test("subscription_id references public.subscriptions and cascades", () => {
  assert.ok(createTableBody.includes("references public.subscriptions(id) on delete cascade"));
});

/* ══════════════════════════════════════════════════════════════
   updated_at, INDEXES
   ══════════════════════════════════════════════════════════════ */

test("the updated_at trigger exists and reuses public.set_updated_at()", () => {
  assert.ok(flat.includes("create trigger set_subscription_email_deliveries_updated_at"));
  assert.ok(flat.includes(`before update on ${TABLE}`));
  assert.ok(flat.includes("for each row execute function public.set_updated_at()"),
    "the existing function from migration 001 must be reused, not redefined");
});

test("the existing subscriptions trigger is not touched", () => {
  assert.ok(!flat.includes("set_subscriptions_updated_at"),
    "035 must not redefine or drop the trigger migration 005 created");
});

test("two partial indexes exist, shaped for the two work-list queries", () => {
  const failed = flat.slice(
    flat.indexOf("create index subscription_email_deliveries_failed_idx"),
    flat.indexOf(";", flat.indexOf("create index subscription_email_deliveries_failed_idx"))
  );
  assert.ok(failed.includes(`on ${TABLE} (family, updated_at)`));
  assert.ok(failed.includes("where status = 'failed'"));

  const sending = flat.slice(
    flat.indexOf("create index subscription_email_deliveries_sending_idx"),
    flat.indexOf(";", flat.indexOf("create index subscription_email_deliveries_sending_idx"))
  );
  assert.ok(sending.includes(`on ${TABLE} (family, updated_at)`));
  assert.ok(sending.includes("where status = 'sending'"));

  // No others. An index nothing queries is an index nobody maintains.
  assert.equal(statements.filter(s => s.startsWith("create index")).length, 2);
});

/* ══════════════════════════════════════════════════════════════
   SECURITY
   ══════════════════════════════════════════════════════════════ */

test("row level security is enabled", () => {
  assert.ok(flat.includes(`alter table ${TABLE} enable row level security`));
});

test("ZERO policies are created", () => {
  assert.equal(statements.filter(s => s.startsWith("create policy")).length, 0,
    "the table is server-only: RLS on with no policy is the point");
});

test("PUBLIC, anon and authenticated are explicitly revoked", () => {
  for (const role of ["public", "anon", "authenticated"]) {
    assert.ok(
      flat.includes(`revoke all on ${TABLE} from ${role}`),
      `revoke from ${role} is missing - Supabase default privileges are not assumed`
    );
  }
});

/**
 * Every grant statement in 035, parsed.
 *
 *   `grant insert (a, b) on public.t to service_role`
 *     -> { privilege: "insert", columns: ["a", "b"], grantee: "service_role" }
 *   `grant select on public.t to service_role`
 *     -> { privilege: "select", columns: null,       grantee: "service_role" }
 *
 * columns === null means TABLE-WIDE, which is a materially different
 * thing from a column list and is asserted as such below. The comma
 * split ignores commas inside a parenthesised column list.
 */
const GRANTED = statements
  .filter(s => s.startsWith("grant "))
  .flatMap(stmt => {
    const m = /^grant (.+?) on (\S+) to (\S+)$/.exec(stmt);
    assert.ok(m, `unparsable grant statement: ${stmt}`);
    const [, privileges, table, grantee] = m;
    assert.equal(table, TABLE, `a grant names another table: ${stmt}`);
    return privileges.split(/,(?![^(]*\))/).map(part => {
      const scoped = /^(\w+) \((.+)\)$/.exec(part.trim());
      return scoped
        ? {
            privilege: scoped[1],
            columns: scoped[2].split(",").map(c => c.trim()).sort(),
            grantee,
          }
        : { privilege: part.trim(), columns: null, grantee };
    });
  });

const granted = privilege => GRANTED.filter(g => g.privilege === privilege);

/** Every column the table declares, so "not granted" can be proven per column. */
const ALL_COLUMNS = [
  "id", "subscription_id", "family", "event_key",
  "status", "sent_at", "created_at", "updated_at",
];

/** The three values the unique constraint guards. */
const IDENTITY_COLUMNS = ["subscription_id", "family", "event_key"];

/** Database-generated, and never the application's to write. */
const GENERATED_COLUMNS = ["id", "created_at", "updated_at"];

/** Everything a sender legitimately writes, across both DML privileges. */
const WRITABLE_COLUMNS = ["subscription_id", "family", "event_key", "status", "sent_at"];

test("service_role is revoked BEFORE every grant, so nothing survives a default", () => {
  // Granting a privilege does not remove another. If ALTER DEFAULT
  // PRIVILEGES hands service_role ALL on new tables, DELETE - and
  // table-wide UPDATE - would already be present and the grants below
  // would simply not mention them. Migration 023 exists because that
  // assumption failed once already.
  const revokeAt = flat.indexOf(`revoke all on ${TABLE} from service_role`);
  assert.notEqual(revokeAt, -1, "service_role must be revoked before being granted");

  const grants = statements.filter(s => s.startsWith("grant "));
  assert.ok(grants.length > 0, "the service_role grants are missing");
  for (const stmt of grants) {
    assert.ok(
      revokeAt < flat.indexOf(stmt),
      `the revoke must precede every grant, or it undoes one: ${stmt.slice(0, 60)}`
    );
  }
});

test("no browser role receives any grant", () => {
  for (const g of GRANTED) {
    assert.equal(g.grantee, "service_role",
      `only the server role may be granted anything: ${g.privilege} to ${g.grantee}`);
  }
});

test("the old table-wide SELECT, INSERT, UPDATE grant is gone", () => {
  // The shape this migration was hardened away from. Named literally so
  // a revert cannot pass by quietly re-adding it.
  assert.ok(
    !flat.includes(`grant select, insert, update on ${TABLE}`),
    "the table-wide grant let service_role rewrite the delivery identity"
  );
  for (const g of GRANTED) {
    if (g.privilege === "insert" || g.privilege === "update") {
      assert.notEqual(g.columns, null,
        `${g.privilege} must be column-scoped, never table-wide`);
    }
  }
});

test("service_role has SELECT on the table", () => {
  const selects = granted("select");
  assert.equal(selects.length, 1, "exactly one SELECT grant");
  assert.equal(selects[0].columns, null,
    "SELECT is deliberately table-wide: the sweep filters and re-reads freely");
});

test("INSERT is column-scoped to exactly the four columns a claim supplies", () => {
  const inserts = granted("insert");
  assert.equal(inserts.length, 1, "exactly one INSERT grant");
  assert.deepEqual(inserts[0].columns,
    ["event_key", "family", "status", "subscription_id"],
    "the claim writes these four and nothing else");
});

test("INSERT does not name id, sent_at, created_at or updated_at", () => {
  // The first, third and fourth carry database defaults, and a
  // column-scoped INSERT still applies the default of every column it
  // does not name. sent_at must be NULL at 'sending' by the section 4
  // CHECK, so an INSERT that named it could only ever be rejected.
  const [insert] = granted("insert");
  for (const column of ["id", "sent_at", "created_at", "updated_at"]) {
    assert.ok(!insert.columns.includes(column),
      `${column} must not be application-suppliable at claim time`);
  }
});

test("UPDATE is column-scoped to exactly status and sent_at", () => {
  const updates = granted("update");
  assert.equal(updates.length, 1, "exactly one UPDATE grant");
  assert.deepEqual(updates[0].columns, ["sent_at", "status"],
    "sent, failed, superseded and stale recovery touch these two columns only");
});

test("the delivery identity is not writable after the claim", () => {
  // subscription_id, family and event_key are insert-only. The unique
  // constraint guards exactly these three, so if they were updatable the
  // guard would be only as strong as the code that avoids touching them:
  // a claimed key could be edited aside and the same message sent twice.
  const [update] = granted("update");
  for (const column of IDENTITY_COLUMNS) {
    assert.ok(!update.columns.includes(column),
      `${column} is delivery identity and must never be updatable`);
  }
  // And the guard those three values feed is still the same guard.
  assert.ok(
    flat.includes(`unique (${IDENTITY_COLUMNS.join(", ")})`),
    "the unique claim guard must remain (subscription_id, family, event_key)"
  );
});

test("id, created_at and updated_at are never application-writable", () => {
  const [insert] = granted("insert");
  const [update] = granted("update");
  for (const column of GENERATED_COLUMNS) {
    assert.ok(!insert.columns.includes(column), `${column} must not be insertable`);
    assert.ok(!update.columns.includes(column), `${column} must not be updatable`);
  }
});

test("updated_at is unwritable AND still trigger-maintained", () => {
  // PostgreSQL checks UPDATE privilege against the columns the statement
  // assigns - its SET list - before row processing begins. A BEFORE
  // trigger's assignment to NEW is not a privilege-checked assignment,
  // so withholding UPDATE on updated_at does not disable the trigger. It
  // does stop a sender keeping a stuck row looking fresh forever, which
  // is what section 6's stale-recovery argument depends on.
  const [update] = granted("update");
  assert.ok(!update.columns.includes("updated_at"));
  assert.ok(
    flat.includes(
      `create trigger set_subscription_email_deliveries_updated_at before update on ${TABLE} for each row execute function public.set_updated_at()`
    ),
    "the updated_at trigger must survive the privilege hardening intact"
  );
});

test("every column is on a deliberate side of the write boundary", () => {
  // A column added later must be classified here rather than inheriting
  // a privilege by accident.
  const [insert] = granted("insert");
  const [update] = granted("update");
  const writable = new Set([...insert.columns, ...update.columns]);
  for (const column of ALL_COLUMNS) {
    assert.ok(createTableBody.includes(column), `a designed column disappeared: ${column}`);
    assert.equal(writable.has(column), WRITABLE_COLUMNS.includes(column),
      `${column} is on the wrong side of the write boundary`);
  }
});

test("DELETE is granted to nobody", () => {
  // Checked against the parsed grants only: `on delete cascade` in the
  // table definition legitimately contains the word.
  for (const g of GRANTED) {
    assert.notEqual(g.privilege, "delete",
      "delivery history is append-and-amend; a superseded fact is closed, never erased");
    assert.notEqual(g.privilege, "all",
      "the privileges must be enumerated, never granted wholesale");
  }
  assert.deepEqual(
    GRANTED.map(g => g.privilege).sort(),
    ["insert", "select", "update"],
    "exactly three privileges, and DELETE is not one of them"
  );
});

/* ══════════════════════════════════════════════════════════════
   HISTORICAL SAFETY
   ══════════════════════════════════════════════════════════════ */

test("the table is created EMPTY: no backfill of any kind", () => {
  assert.ok(!flat.includes("insert into"),
    "a backfill would queue messages about subscriptions that predate the feature");
  assert.ok(!statements.some(s => s.startsWith("insert")));
  assert.ok(!flat.includes("select * from public.subscriptions"));
  assert.ok(!flat.includes("select * from public.orders"));
});

test("no INSERT ... SELECT exists", () => {
  assert.ok(!/insert[\s\S]{0,200}select/.test(flat));
});

test("the only DML-shaped verbs in 035 are DDL", () => {
  const allowedStarts = [
    "create table", "create index", "create trigger",
    "alter table", "revoke ", "grant ",
  ];
  for (const stmt of statements) {
    assert.ok(
      allowedStarts.some(prefix => stmt.startsWith(prefix)),
      `unexpected statement in a schema-only migration: ${stmt.slice(0, 80)}`
    );
  }
});

/* ══════════════════════════════════════════════════════════════
   NOTHING ELSE MOVED
   ══════════════════════════════════════════════════════════════ */

test("exactly the three reviewed lifecycle templates were built on this foundation", () => {
  // PHASE 3H.4 CHANGED THIS GUARD A THIRD AND FINAL TIME. 3H.1 shipped
  // the table alone; 3H.2, 3H.3 and 3H.4 built the three families
  // migration 035 permits. The family set is now CLOSED - the migration's
  // CHECK admits no fourth value - so from here this list may only change
  // for a message that is not a subscription lifecycle email at all.
  const templates = readdirSync(path.join(ROOT, "lib/email")).sort();
  assert.deepEqual(templates, [
    "cancellationConfirmation.ts",
    "cancellationOutcome.ts",
    "cancellationRequestNotification.ts",
    "internalOrderNotification.ts",
    "orderConfirmation.ts",
    "paymentProblem.ts",
    "refundConfirmation.ts",
    "shipmentConfirmation.ts",
    "subscriptionEnded.ts",
    "subscriptionStarted.ts",
    "withdrawalConfirmation.ts",
  ], "an unreviewed email template was added");
});

test("every family 035 permits has a sender, and 036 added the fourth", () => {
  // PHASE 3I.B2 CLOSED THIS GUARD OUT COMPLETELY. Migration 035's own
  // three families were built in 3H.2-3H.4; migration 036 added
  // payment_problem and 3I.B2 built it. All four now exist.
  //
  // 035's file text is unchanged and still names only three - the fourth
  // lives in 036, which is where a reader should go looking for it.
  const libFiles = readdirSync(path.join(ROOT, "lib"));
  for (const [family, senderFile] of [
    ["subscription_started", "subscriptionStartedEmail.ts"],
    ["cancellation_confirmation", "cancellationConfirmationEmail.ts"],
    ["subscription_ended", "subscriptionEndedEmail.ts"],
  ]) {
    assert.ok(libFiles.includes(senderFile), `the ${family} sender is missing`);
    assert.ok(flat.includes(`'${family}'`), `035 no longer permits ${family}`);
  }
  assert.ok(!flat.includes("payment_problem"),
    "035's own text must still name only its three families");
  // The fourth family and its sender.
  assert.ok(libFiles.includes("paymentProblemEmail.ts"), "the payment_problem sender is missing");
  const sql036 = withoutComments(
    readFileSync(path.join(MIGRATIONS_DIR, "036_subscription_payment_status.sql"), "utf-8")
  );
  assert.ok(sql036.includes("'payment_problem'"), "036 no longer permits payment_problem");
});

test("034's reconciliation still never writes subscriptions.status", () => {
  // PHASE 3I.B2 BUILT THE PAYMENT FAILURE LIFECYCLE, so this guard no
  // longer asserts that invoice.payment_failed is unhandled. What it
  // still protects is the boundary that made 3I.B2 safe: migration 034's
  // reconciliation writes period and cancellation facts only, and status
  // reconciliation went to a SEPARATE function in 036 rather than being
  // bolted onto this one.
  const webhook = withoutComments(read("app/api/stripe/webhook/route.ts"));
  assert.ok(webhook.includes('"invoice.payment_failed"'),
    "the payment failure branch disappeared");
  assert.ok(webhook.includes("reconcileSubscriptionPaymentStatus("),
    "status reconciliation disappeared");
  // 034's reconciliation still never writes subscriptions.status.
  const sync = read("supabase/migrations/034_subscription_cancellation.sql");
  const syncFn = sync.slice(
    sync.indexOf("create or replace function public.sync_subscription_from_stripe"),
    sync.indexOf("create or replace function public.mark_subscription_cancelled")
  );
  const setClause = syncFn.slice(syncFn.indexOf("update public.subscriptions"), syncFn.indexOf("where id = v_sub.id"));
  assert.ok(!/^\s*status\s*=/m.test(setClause),
    "sync_subscription_from_stripe must still never write status");
});

test("the refund correlation defect remains open and untouched", () => {
  // Still keyed on the payment intent the subscription path never stores.
  assert.ok(read("lib/orderRefunds.ts").includes("stripe_payment_intent_id"));
  const fulfillment = withoutComments(read("lib/subscriptionInvoiceFulfillment.ts"));
  assert.ok(!fulfillment.includes("payment_intent"),
    "the refund correlation fix belongs to its own later phase, not to 035");
});

test("the order confirmation retry exclusion is not reopened", () => {
  const rules = read("lib/transactionalEmailRetryRules.ts");

  // The exclusion is still recorded as data, with its reason.
  assert.ok(rules.includes("RETRY_DISABLED_FAMILIES"));
  const disabled = rules.slice(
    rules.indexOf("export const RETRY_DISABLED_FAMILIES"),
    rules.indexOf("export function isAutoRetryFamily")
  );
  assert.ok(disabled.includes("orderConfirmation:"),
    "orderConfirmation must remain in RETRY_DISABLED_FAMILIES");

  // And it is still absent from the list the cron may sweep.
  const autoRetry = rules.slice(
    rules.indexOf("export const AUTO_RETRY_FAMILY_KEYS"),
    rules.indexOf("export type AutoRetryFamilyKey")
  );
  assert.ok(autoRetry.length > 0, "AUTO_RETRY_FAMILY_KEYS was not found");
  assert.ok(!autoRetry.includes("orderConfirmation"),
    "orderConfirmation must stay out of AUTO_RETRY_FAMILY_KEYS");
  // Five families, not six.
  assert.equal((autoRetry.match(/"/g) ?? []).length, 10,
    "AUTO_RETRY_FAMILY_KEYS must still list exactly five families");
});

test("the retry sweep is unchanged: it still names no subscription family", () => {
  const retry = withoutComments(read("lib/transactionalEmailRetryRules.ts"));
  for (const family of ["subscription_started", "cancellation_confirmation", "subscription_ended"]) {
    assert.ok(!retry.includes(family),
      `the sweep must not know about ${family} yet - that is a later phase`);
  }
});

test("the cron route is unchanged and still runs only the order families", () => {
  const cron = withoutComments(read("app/api/cron/retry-order-notifications/route.ts"));
  assert.ok(!cron.includes("subscription_email_deliveries"));
  assert.ok(!cron.includes("subscriptionStarted"));
});

test("the subscription cancel route still sends nothing", () => {
  const route = read("app/api/subscriptions/cancel/route.ts");
  assert.ok(!route.includes("resend"));
  assert.ok(!route.includes("Email"),
    "no sender is wired into the cancellation route in this phase");
});

/* ══════════════════════════════════════════════════════════════
   FEATURE FLAGS AND REPOSITORY HYGIENE
   ══════════════════════════════════════════════════════════════ */

test("B2C_SUBSCRIPTIONS_ENABLED is still closed unless exactly 'true'", () => {
  const rules = read("lib/subscriptionCheckoutRules.ts");
  assert.ok(rules.includes('export const SUBSCRIPTION_FEATURE_FLAG = "B2C_SUBSCRIPTIONS_ENABLED"'));
  assert.ok(rules.includes('env[SUBSCRIPTION_FEATURE_FLAG] === "true"'),
    "the gate must stay closed-by-default and exact-match");
  assert.ok(!flat.includes("b2c_subscriptions_enabled"),
    "035 must not reference the feature flag");
});

test("SHOP_STATUS is still prelaunch", () => {
  assert.ok(read("app/content.ts").includes('export const SHOP_STATUS = "prelaunch"'));
});

test("stripe_backup_code.txt is not tracked and is referenced nowhere", () => {
  const tracked = execFileSync("git", ["ls-files", "stripe_backup_code.txt"], {
    cwd: ROOT,
    encoding: "utf-8",
  }).trim();
  assert.equal(tracked, "", "stripe_backup_code.txt must never be tracked or staged");
  assert.ok(!migration035.includes("stripe_backup_code"));
});
