import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AUDIT_ACTIONS,
  AUDIT_ACTION_LABEL,
  AUDIT_ACTIVE_MODULES,
  AUDIT_FILTERS,
  AUDIT_LOG_COLUMNS,
  AUDIT_MAX_PAGE,
  AUDIT_METADATA_KEYS,
  AUDIT_MODULES,
  AUDIT_MODULE_LABEL,
  AUDIT_PAGE_SIZE,
  auditPageRange,
  auditSummary,
  parseAuditFilter,
  parseAuditModule,
  resolveAuditPage,
  safeAuditMetadata,
} from "../lib/adminAudit.ts";

/**
 * 4A.2B-2 — WHO DID WHAT, AND WHEN.
 *
 * GLOA already recorded WHAT happened: inventory_movements is the stock
 * ledger, and an order's columns are its state. Neither records WHO, so
 * "who shipped this in March" had no answer at all.
 *
 * This package adds one append-only table beside them. Four properties
 * decide whether it is worth having, and each is asserted here rather
 * than described in a comment:
 *
 *   the actor is the VERIFIED one    it comes from the session and the
 *                                    admin_users row behind it. Not from
 *                                    a body, a header or a query.
 *   it cannot be edited              service_role is granted SELECT and
 *                                    nothing else, so the application
 *                                    cannot rewrite its own history.
 *   the act and the record are ONE   the five transitions run inside a
 *                                    wrapper that does both in a single
 *                                    transaction. The two that cannot -
 *                                    a refund and the item CRUD - say so.
 *   nothing was invented             no backfill, no fabricated history,
 *                                    and no "system" actor.
 *
 * SAFE: reads source and runs the pure leaf. No database, no network, no
 * server, and migration 052 is NOT applied by anything here.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf8");

/** Source with comments removed, so prose cannot satisfy an assertion. */
const codeOnly = src => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
/** SQL with BOTH comment forms removed, for the same reason. */
const sqlOnly = src => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*--.*$/gm, "");

const migration = read("supabase/migrations/052_admin_activity_audit.sql");
const sql = sqlOnly(migration);
const auditLib = read("lib/adminAudit.ts");
const auditDeps = codeOnly(read("lib/adminAuditDeps.ts"));
const orderActions = codeOnly(read("lib/adminOrderActions.ts"));
const refundFlow = codeOnly(read("lib/adminRefundFlow.ts"));
const inventoryAdmin = codeOnly(read("lib/inventoryAdmin.ts"));
const activityRoute = codeOnly(read("app/api/admin/activity/route.ts"));
const activityUi = read("app/AdminActivity.tsx");
const shell = read("app/AdminOverview.tsx");

/** The five wrappers migration 052 introduces. */
const WRAPPERS = [
  "admin_mark_order_shipped",
  "admin_cancel_order",
  "admin_resolve_order_cancellation_request",
  "admin_record_inventory_movement",
  "admin_record_inventory_stocktake",
];
/** The business functions they wrap. Each is older than this package. */
const WRAPPED = [
  "mark_order_shipped",
  "cancel_order",
  "resolve_order_cancellation_request",
  "record_inventory_movement",
  "record_inventory_stocktake",
];

/* ════════════════════════════════════════════════════════════════════
   1. THE VOCABULARY IS CLOSED
   ════════════════════════════════════════════════════════════════════ */

test("1: the modules and the actions are closed lists, and every action is real", () => {
  assert.deepEqual([...AUDIT_MODULES],
    ["orders", "inventory", "b2b", "finance", "documents", "fulfillment"]);
  // Only two modules write anything today. The other four are names the
  // database will accept later - offering them as a filter now would be
  // a filter that always returns nothing.
  assert.deepEqual([...AUDIT_ACTIVE_MODULES], ["orders", "inventory"]);

  const actions = Object.values(AUDIT_ACTIONS);
  assert.equal(new Set(actions).size, actions.length, "an action name is duplicated");
  for (const action of actions) {
    assert.match(action, /^(order|inventory)\.[a-z_]+$/, `${action} is not module.verb`);
    assert.ok(AUDIT_ACTION_LABEL[action], `${action} has no German label`);
  }
  for (const name of AUDIT_MODULES) {
    assert.ok(AUDIT_MODULE_LABEL[name], `${name} has no German label`);
  }

  // EVERY ACTION NAMES A FLOW THAT EXISTS. An audit vocabulary that
  // describes features the build does not have is how a log starts
  // lying: a reader assumes an absent entry means nothing happened.
  const FLOWS = {
    "order.shipped": () => orderActions.includes("adminShipOrder"),
    "order.refunded": () => orderActions.includes("adminRefundOrder"),
    "order.cancelled": () => orderActions.includes("adminCancelOrder"),
    "order.cancellation_request_resolved": () => orderActions.includes("adminResolveCancellationRequest"),
    "inventory.movement_recorded": () => inventoryAdmin.includes("export async function recordMovement"),
    "inventory.stocktake_recorded": () => inventoryAdmin.includes("export async function recordStocktake"),
    "inventory.item_created": () => inventoryAdmin.includes("export async function createInventoryItem"),
    "inventory.item_updated": () => inventoryAdmin.includes("export async function updateInventoryItem"),
    "inventory.item_archived": () => inventoryAdmin.includes("export async function setItemActive"),
    "inventory.category_saved": () => inventoryAdmin.includes("export async function saveInventoryCategory"),
  };
  assert.deepEqual([...actions].sort(), Object.keys(FLOWS).sort(),
    "an action exists with no flow, or a flow with no action");
  for (const [action, exists] of Object.entries(FLOWS)) {
    assert.ok(exists(), `${action} is recorded but the flow it names does not exist`);
  }
});

test("1b: the module CHECK in the database is the same closed list", () => {
  const check = /module\s+text not null\s*check \(module in\s*\(([^)]*)\)/.exec(sql);
  assert.ok(check, "the module column lost its CHECK constraint");
  const inSql = [...check[1].matchAll(/'(\w+)'/g)].map(m => m[1]);
  assert.deepEqual(inSql, [...AUDIT_MODULES],
    "the database and lib/adminAudit.ts disagree about which modules exist");
});

test("1c: the leaf is a leaf - no import, no clock, no database, no DOM", () => {
  assert.equal((auditLib.match(/^import /gm) ?? []).length, 0,
    "lib/adminAudit.ts gained an import and can no longer be tested directly");
  for (const banned of ["supabase", "process.env", "fetch(", "Date.now()", "document.", "window."]) {
    assert.ok(!codeOnly(auditLib).includes(banned), `the audit leaf reaches for ${banned}`);
  }
});

/* ════════════════════════════════════════════════════════════════════
   2. THE ACTOR IS THE VERIFIED ONE, AND NOTHING ELSE
   ════════════════════════════════════════════════════════════════════ */

/** The ten admin routes that CHANGE something and therefore record it. */
const WRITE_ROUTES = [
  "orders/ship", "orders/cancel", "orders/refund", "orders/resolve-request",
  "inventory/movement", "inventory/stocktake",
  "inventory/items/create", "inventory/items/update", "inventory/items/archive",
  "inventory/categories/save",
];

test("2: every audited route takes its actor from the gate, never from the request", () => {
  for (const route of WRITE_ROUTES) {
    const code = codeOnly(read(`app/api/admin/${route}/route.ts`));
    assert.ok(code.includes("gate.context.identity.userId"),
      `${route} does not pass the verified actor`);
    // And it takes an actor from nowhere a caller controls.
    for (const forged of [
      "body.actor", "raw.actor", "body.userId", "raw.userId", "body.email", "raw.email",
      "body.role", "raw.role", "actorEmail", "x-admin", "X-Admin",
    ]) {
      assert.ok(!code.includes(forged), `${route} can be told who the actor is: ${forged}`);
    }
  }
});

test("2b: the database looks the actor up - the caller passes an id and nothing more", () => {
  const at = sql.indexOf("create or replace function public.record_admin_activity");
  const body = sql.slice(at, sql.indexOf("$$;", at));

  // The signature accepts an ID. It accepts no email, name or role.
  const params = /record_admin_activity\(([\s\S]*?)\)\s*returns/.exec(body)[1];
  assert.ok(params.includes("p_actor_user_id uuid"), "the actor is not a uuid");
  for (const forged of ["p_actor_email", "p_actor_name", "p_actor_role", "p_display_name"]) {
    assert.ok(!params.includes(forged), `the caller can dictate ${forged}`);
  }
  // The snapshots are READ from admin_users, inside the function.
  assert.match(body, /select a\.email, a\.display_name, a\.role\s*\n\s*into v_email, v_name, v_role\s*\n\s*from public\.admin_users a/);
  assert.match(body, /where a\.user_id = p_actor_user_id\s*\n\s*and a\.is_active/,
    "a deactivated administrator can still be made to appear to have acted");
  // And no row means no line, rather than a line attributed to nobody.
  assert.match(body, /if v_email is null then[\s\S]*?raise exception[\s\S]*?errcode = '42501'/);
});

test("2c: there is no system actor, no anonymous actor and no fallback", () => {
  for (const ghost of ["'system'", "'unknown'", "coalesce(p_actor_user_id", "'gloa'"]) {
    assert.ok(!sql.includes(ghost), `052 can attribute an act to ${ghost}`);
  }
  // The column cannot even hold one: NOT NULL, pointing at a real
  // administrator, with RESTRICT so the reference cannot be deleted away.
  assert.match(sql, /actor_user_id\s+uuid not null\s*\n?\s*references public\.admin_users\(user_id\) on delete restrict/);
});

/* ════════════════════════════════════════════════════════════════════
   3. THE TABLE CANNOT BE REACHED, AND CANNOT BE REWRITTEN
   ════════════════════════════════════════════════════════════════════ */

test("3: no browser role can read the log, and RLS is on with zero policies", () => {
  assert.match(sql, /alter table public\.admin_activity_log enable row level security/);
  // Taken away from the browser roles by the same end-state revoke that
  // strips service_role - see 3b for why the delta form was not enough.
  const revokeLine = /revoke all privileges on table public\.admin_activity_log\s+from ([a-z_, ]+);/.exec(sql);
  assert.ok(revokeLine, "the audit log's privileges are not revoked as an end state");
  const revoked = revokeLine[1].split(",").map(r => r.trim());
  for (const role of ["anon", "authenticated"]) {
    assert.ok(revoked.includes(role), `${role} keeps whatever privileges it arrived with`);
  }
  // And neither is ever granted anything back.
  assert.ok(!/grant[^;]*on (?:table )?public\.admin_activity_log to [^;]*\b(anon|authenticated|public)\b/i.test(sql),
    "a browser role is granted something on the audit log");
  // Not one policy. A customer is an `authenticated` Supabase user, so a
  // permissive policy here would publish who does what inside GLOA.
  assert.ok(!/create policy[^;]*admin_activity_log/i.test(sql), "052 creates a policy on the log");
});

test("3b: APPEND-ONLY IN THE STRONG SENSE - the server itself cannot rewrite history", () => {
  // ── THE BUG THIS TEST EXISTS BECAUSE OF ──────────────────
  //
  // The first version of 052 revoked from anon and authenticated, then
  // granted SELECT to service_role, and this test read that as proof. It
  // was not. Supabase carries DEFAULT PRIVILEGES for service_role on new
  // tables in `public`, so the table arrived already holding SELECT,
  // REFERENCES, TRIGGER and TRUNCATE for it. The grant added nothing and
  // revoked nothing, and the applied database showed all four.
  //
  // TRUNCATE is the one that mattered: the server could have emptied its
  // own audit log in one statement, which is the exact opposite of what
  // the table is for.
  //
  // So this no longer checks a list of privileges it remembered to
  // forbid - a denylist is a list somebody forgets to extend. It checks
  // that the migration STATES AN END STATE: take everything away from
  // all three roles, then give back exactly one thing.
  const revoke = /revoke all privileges on table public\.admin_activity_log\s*\n\s*from ([a-z_, ]+);/.exec(sql);
  assert.ok(revoke, "052 does not revoke ALL PRIVILEGES on the audit log");
  const revokedFrom = revoke[1].split(",").map(r => r.trim()).sort();
  assert.deepEqual(revokedFrom, ["anon", "authenticated", "service_role"],
    "a role keeps whatever privileges it happened to arrive with");

  // Exactly one grant, exactly SELECT, exactly to service_role.
  const grants = [...sql.matchAll(/grant ([a-z, ]+) on (?:table )?public\.admin_activity_log to (\w+)/g)]
    .map(m => [m[2], m[1].trim()]);
  assert.deepEqual(grants, [["service_role", "select"]],
    "the audit log is granted more than SELECT, or granted to somebody else");

  // The revoke must come FIRST. Granting and then revoking would end
  // with nothing at all.
  assert.ok(sql.indexOf("revoke all privileges on table public.admin_activity_log")
    < sql.indexOf("grant select on table public.admin_activity_log"),
    "the grant is revoked away again");

  // And named privileges are still checked one by one, so a future
  // `grant trigger ... to service_role` appended below cannot slip past
  // the end-state reading above.
  for (const priv of ["insert", "update", "delete", "truncate", "references", "trigger", "all"]) {
    assert.ok(!new RegExp(`grant[^;]*\\b${priv}\\b[^;]*on (?:table )?public\\.admin_activity_log`, "i").test(sql),
      `service_role can ${priv} the audit log`);
  }
  // Nothing may be passed on to a fourth role either.
  assert.ok(!/with grant option/i.test(sql), "a privilege on the audit log is grantable onward");

  // The owner is deliberately NOT revoked - that would leave nobody able
  // to administer the table.
  assert.ok(!/revoke[^;]*from[^;]*\bpostgres\b/i.test(sql), "052 revokes the owner's own privileges");

  // So the only door is the definer function.
  assert.match(sql, /create or replace function public\.record_admin_activity[\s\S]*?security definer set search_path = ''/);

  // The migration tells the next person how to prove this against a real
  // database, grouped by role - a per-row query is what missed it before.
  assert.match(migration, /select grantee, string_agg\(privilege_type/);
  assert.match(migration, /select is_grantable from information_schema\.role_table_grants/);
});

test("3c: and nothing in the application tries to write or delete it directly", () => {
  for (const rel of [
    "lib/adminAuditDeps.ts", "lib/adminOrderActions.ts", "lib/adminRefundFlow.ts",
    "lib/inventoryAdmin.ts", "app/api/admin/activity/route.ts",
  ]) {
    const code = codeOnly(read(rel));
    for (const m of code.matchAll(/\.from\("admin_activity_log"\)([\s\S]{0,200})/g)) {
      for (const write of [".insert(", ".update(", ".upsert(", ".delete("]) {
        assert.ok(!m[1].includes(write), `${rel} tries to ${write} the audit log`);
      }
    }
  }
  // The read endpoint reads. It has no other verb - not even an RPC.
  assert.ok(activityRoute.includes('.from("admin_activity_log")'));
  for (const write of [".insert(", ".update(", ".upsert(", ".delete(", ".rpc("]) {
    assert.ok(!activityRoute.includes(write), `the activity route can ${write}`);
  }
});

test("3d: the execute grants are server-only, and the block names every wrapper", () => {
  assert.match(sql, /revoke all on function public\.record_admin_activity\(uuid, text, text, text, text, text, uuid, jsonb\)\s*\n?\s*from public, anon, authenticated/);
  assert.match(sql, /grant execute on function public\.record_admin_activity\([^)]*\)\s*\n?\s*to service_role/);
  assert.match(sql, /revoke all on function %s from public, anon, authenticated/);
  assert.match(sql, /grant execute on function %s to service_role/);
  // The do-block names exactly the five wrappers, so one cannot be added
  // to the migration and left with PUBLIC execute.
  const block = sql.slice(sql.indexOf("foreach fn in array array["), sql.indexOf("] loop"));
  const named = [...block.matchAll(/'public\.(\w+)\(/g)].map(m => m[1]).sort();
  assert.deepEqual(named, [...WRAPPERS].sort(),
    "a wrapper exists that the grant block does not name");
});

/* ════════════════════════════════════════════════════════════════════
   4. THE ACT AND ITS RECORD ARE ONE TRANSACTION
   ════════════════════════════════════════════════════════════════════ */

test("4: the five wrappers run the EXISTING function and record in the same call", () => {
  for (const [wrapper, wrapped] of WRAPPERS.map((w, i) => [w, WRAPPED[i]])) {
    const at = sql.indexOf(`create or replace function public.${wrapper}`);
    assert.ok(at > -1, `${wrapper} does not exist`);
    const body = sql.slice(at, sql.indexOf("$$;", at));
    assert.ok(body.includes(`public.${wrapped}(`), `${wrapper} does not call ${wrapped}`);
    assert.ok(body.includes("public.record_admin_activity("),
      `${wrapper} performs the change without recording it`);
    assert.match(body, /security definer set search_path = ''/,
      `${wrapper} does not pin its search_path`);
    // Both statements are inside ONE function call, so they are inside
    // one transaction: there is no state in which the order moved and
    // the log does not say who moved it.
    assert.ok(!/\bcommit\b|\brollback\b/.test(body), `${wrapper} manages its own transaction`);
  }
});

test("4b: NO EXISTING FUNCTION WAS REDEFINED, so no overload can be resolved by accident", () => {
  // The danger this package had to avoid: CREATE OR REPLACE with a
  // CHANGED signature does not replace anything - it creates a SECOND
  // function of the same name, and which one a caller gets then depends
  // on argument types. The wrappers therefore have NEW names, and 052
  // redefines none of the five functions it wraps.
  const defined = [...sql.matchAll(/create (?:or replace )?function public\.(\w+)\s*\(/g)].map(m => m[1]);
  assert.deepEqual(defined.sort(), ["record_admin_activity", ...WRAPPERS].sort(),
    "052 defines a function that is neither the recorder nor one of the five wrappers");
  for (const existing of WRAPPED) {
    assert.ok(!defined.includes(existing), `052 redefines ${existing} and creates an overload`);
  }
  // And it drops nothing, so no other caller loses a function.
  assert.ok(!/drop function/i.test(sql), "052 drops a function");
  // The migration says how to prove the same thing against the real
  // database, because a regex here cannot.
  assert.match(migration, /select proname, count\(\*\) from pg_proc/);
});

test("4c: the other callers of those functions are untouched", () => {
  // Each of the five has a SECOND caller that is not an admin: the
  // internal bearer-secret routes and the Stripe webhook. Putting the
  // audit inside the shared function would have forced a fake actor for
  // them, which is why the wrapper exists. They must still call the bare
  // function, and must not have gained an actor.
  const OTHERS = [
    "app/api/internal/orders/ship/route.ts",
    "app/api/internal/orders/cancel/route.ts",
    "app/api/stripe/webhook/route.ts",
  ];
  let checked = 0;
  for (const rel of OTHERS) {
    let code;
    try { code = codeOnly(read(rel)); } catch { continue; }
    checked += 1;
    const called = [...code.matchAll(/\.rpc\("(\w+)"/g)].map(m => m[1]);
    for (const wrapper of WRAPPERS) {
      assert.ok(!called.includes(wrapper), `${rel} was moved onto the audited wrapper ${wrapper}`);
    }
    for (const forged of ["record_admin_activity", "recordAdminActivity", "actorUserId"]) {
      assert.ok(!code.includes(forged), `${rel} invents an admin actor: ${forged}`);
    }
  }
  assert.ok(checked >= 2, "the non-admin callers moved and this test stopped checking anything");
});

test("4d: ONE EVENT IS module + action + operation_id, and the action is in the key", () => {
  // THE DEFECT THIS REPLACED. The key used to be (module, operation_id),
  // which quietly assumed one operator action is at most one recordable
  // act per module. It is not: creating an item WITH an opening stock is
  // an item_created AND a movement_recorded, both genuinely part of one
  // operation. Under the old key the second one hit the constraint and
  // was dropped by a do-nothing conflict - no error, no line, and a call
  // that reported success.
  assert.match(sql, /constraint admin_activity_log_event_key\s*\n\s*unique \(module, action, operation_id\)/,
    "the audit's event key does not include the action");
  assert.ok(!/unique \(module, operation_id\)/.test(sql),
    "the old, too-coarse key is still in the migration");
  // The function targets that exact named constraint rather than a
  // column list that could drift away from it.
  assert.match(sql, /on conflict on constraint admin_activity_log_event_key do nothing/);
  assert.equal((sql.match(/on conflict/g) ?? []).length, 1,
    "a second conflict clause exists somewhere in 052");
});

test("4d2: a retry is idempotent - same module, action, operation, actor and entity", () => {
  // CASES A and F-I of the matrix. The insert is attempted; a conflict is
  // read back and the existing event returned UNCHANGED when it
  // describes the same act.
  const at = sql.indexOf("create or replace function public.record_admin_activity");
  const fn = sql.slice(at, sql.indexOf("$$;", at));
  const after = fn.slice(fn.indexOf("on conflict on constraint"));
  assert.match(after, /if v_id is not null then\s*\n\s*return v_id;/,
    "a fresh insert no longer returns straight away");
  assert.match(after, /select l\.id, l\.actor_user_id, l\.entity_type, l\.entity_id\s*\n\s*into v_existing/,
    "the conflicting row is not read back");
  assert.match(after, /where l\.module = p_module\s*\n\s*and l\.action = p_action\s*\n\s*and l\.operation_id = p_operation_id/,
    "the read-back does not use the same three-part key as the constraint");
  assert.match(after, /return v_existing\.id;\s*\n?\s*end;/,
    "a matching retry does not return the existing event");
  // IMMUTABLE. The retry path neither rewrites nor removes the first
  // telling of the event.
  for (const mutate of ["update public.admin_activity_log", "delete from public.admin_activity_log"]) {
    assert.ok(!sql.toLowerCase().includes(mutate), `the conflict path can ${mutate}`);
  }
});

test("4d3: a MISMATCHED collision is raised, never swallowed", () => {
  // CASES C and D. A bare do-nothing treats a retry and a programming
  // error identically and answers success to both - the same silent-loss
  // failure one level up from the key itself. So the existing row's
  // identity is compared with what the caller claims.
  const at = sql.indexOf("create or replace function public.record_admin_activity");
  const fn = sql.slice(at, sql.indexOf("$$;", at));
  const guard = /if v_existing\.actor_user_id is distinct from p_actor_user_id\s*\n\s*or v_existing\.entity_type\s+is distinct from p_entity_type\s*\n\s*or v_existing\.entity_id\s+is distinct from p_entity_id then/;
  assert.match(fn, guard, "the three identity columns are not all compared");
  const raiseAt = fn.slice(fn.search(guard));
  assert.match(raiseAt, /raise exception[\s\S]*?already describes a different act[\s\S]*?errcode = '23505'/,
    "a mismatched collision does not raise");
  // A concurrent, not-yet-visible insert gets its own answer rather than
  // being mistaken for either case.
  assert.match(fn, /if not found then[\s\S]*?raise exception[\s\S]*?errcode = '40001'/,
    "an invisible concurrent event is not distinguished");

  // AND THE COMPARISON STOPS AT IDENTITY. A safe derived fact or a
  // reformatted sentence may legitimately differ between attempts, and
  // refusing over that would turn a harmless retry into an error.
  assert.ok(!/is distinct from p_summary|is distinct from p_metadata/.test(fn),
    "the retry check compares the summary or the metadata");
});

test("4d4: THE OPERATION-ID MATRIX - every action, its key source, its collisions", () => {
  // CASES B and E. Two acts of the SAME operation are allowed BECAUSE
  // the action is in the key; two acts of the same operation AND the
  // same action are one event. This enumerates every producer, so a new
  // one cannot be added without being placed in the matrix.
  //
  //  module     | action                              | operation_id source
  //  -----------+-------------------------------------+---------------------------
  //  orders     | order.shipped                       | gen_random_uuid() (wrapper)
  //  orders     | order.cancelled                     | gen_random_uuid() (wrapper)
  //  orders     | order.cancellation_request_resolved | gen_random_uuid() (wrapper)
  //  orders     | order.refunded                      | refund claim id (049)
  //  inventory  | inventory.movement_recorded         | request.operationId
  //  inventory  | inventory.stocktake_recorded        | request.operationId
  //  inventory  | inventory.item_created              | request.operationId
  //  inventory  | inventory.item_updated              | request.operationId
  //  inventory  | inventory.item_archived             | request.operationId
  //  inventory  | inventory.category_saved            | request.operationId
  //
  // The three order wrappers mint a fresh id per call, so their
  // idempotency is the business gate alone ('shipped' vs
  // 'already_shipped') and their key can never collide. The refund's key
  // is the 049 claim, already unique per economic refund.
  const PRODUCERS = {
    "order.shipped": ["admin_mark_order_shipped", "gen_random_uuid()"],
    "order.cancelled": ["admin_cancel_order", "gen_random_uuid()"],
    "order.cancellation_request_resolved": ["admin_resolve_order_cancellation_request", "gen_random_uuid()"],
    "inventory.movement_recorded": ["admin_record_inventory_movement", "p_operation_id"],
    "inventory.stocktake_recorded": ["admin_record_inventory_stocktake", "p_operation_id"],
  };
  for (const [action, [fn, key]] of Object.entries(PRODUCERS)) {
    const at = sql.indexOf(`create or replace function public.${fn}`);
    const body = sql.slice(at, sql.indexOf("$$;", at));
    assert.ok(body.includes(`'${action}'`), `${fn} no longer records ${action}`);
    assert.ok(body.includes(key), `${fn} no longer keys its audit on ${key}`);
    assert.equal((body.match(/record_admin_activity\(/g) ?? []).length, 1,
      `${fn} records more than one act and the matrix does not say so`);
  }
  // Each ORDER wrapper mints exactly one id, so no two of them can meet;
  // each INVENTORY wrapper mints none, because its key is the
  // operationId the client chose before the request. Counted per
  // function - the table's own `id ... default gen_random_uuid()` is not
  // an operation id and must not be mistaken for one.
  for (const [fn, minted] of [
    ["admin_mark_order_shipped", 1],
    ["admin_cancel_order", 1],
    ["admin_resolve_order_cancellation_request", 1],
    ["admin_record_inventory_movement", 0],
    ["admin_record_inventory_stocktake", 0],
  ]) {
    const at = sql.indexOf(`create or replace function public.${fn}`);
    const body = sql.slice(at, sql.indexOf("$$;", at));
    assert.equal((body.match(/gen_random_uuid\(\)/g) ?? []).length, minted,
      `${fn} mints a different number of operation ids than the matrix says`);
  }
  // The refund keeps the 049 claim as its key.
  assert.match(refundFlow, /recordActivity\(\{[\s\S]{0,200}?claimId/);
  const refundDep = codeOnly(read("lib/adminOrderActions.ts"));
  assert.match(refundDep, /action: AUDIT_ACTIONS\.orderRefunded[\s\S]{0,300}?operationId: claimId/,
    "the refund audit no longer keys on the claim id");

  // CASE E, which motivated the whole correction: creating an item WITH
  // an opening stock produces TWO acts under ONE operation id, and both
  // must survive.
  const create = inventoryAdmin.slice(
    inventoryAdmin.indexOf("export async function createInventoryItem"),
    inventoryAdmin.indexOf("export async function updateInventoryItem"));
  assert.ok(create.includes("operationId: request.operationId"),
    "the opening movement stopped using the request's operation id");
  const audit = create.slice(create.indexOf("recordAdminActivity({"));
  assert.match(audit, /operationId: request\.operationId/,
    "the item-created audit no longer shares the operation with its opening movement");
  assert.match(audit, /action: AUDIT_ACTIONS\.inventoryItemCreated/);
  // Same module, same operation, DIFFERENT action - which the widened
  // key allows, so no workaround id is needed and none is used.
  assert.ok(!create.includes("operationId: item.id"),
    "the item.id workaround survived although the key was widened");

  // Each application-level producer records exactly one act, except the
  // category save, whose two calls sit on mutually exclusive branches.
  for (const fn of ["createInventoryItem", "updateInventoryItem", "setItemActive", "saveInventoryCategory"]) {
    const at = inventoryAdmin.indexOf(`export async function ${fn}`);
    const nextAt = inventoryAdmin.indexOf("\nexport async function", at + 10);
    const body = inventoryAdmin.slice(at, nextAt === -1 ? inventoryAdmin.length : nextAt);
    assert.equal((body.match(/recordAdminActivity\(\{/g) ?? []).length,
      fn === "saveInventoryCategory" ? 2 : 1,
      `${fn} records an unexpected number of acts`);
  }
});

test("4d5: a replay is not an act - the business gate decides before the key does", () => {
  // CASES F, H and I. The key is the second belt; the FIRST is that each
  // business function already distinguishes "I did it" from "it was
  // already done". A replay returns the "already" result and the wrapper
  // never calls the recorder at all - so idempotency does not depend on
  // the constraint, and no new rule was invented beside the ones that
  // were already protecting the business data.
  const GATES = [
    ["admin_mark_order_shipped", /if v_result = 'shipped' then/],
    ["admin_cancel_order", /if v_payload ->> 'result' = 'cancelled' then/],
    ["admin_resolve_order_cancellation_request", /if v_result in \('approved', 'declined'\) then/],
    ["admin_record_inventory_movement", /if v_payload ->> 'result' = 'recorded' then/],
    ["admin_record_inventory_stocktake", /if v_payload ->> 'result' = 'recorded' then/],
  ];
  for (const [fn, gate] of GATES) {
    const at = sql.indexOf(`create or replace function public.${fn}`);
    const body = sql.slice(at, sql.indexOf("$$;", at));
    assert.match(body, gate, `${fn} records a replay as a fresh act`);
    const gateAt = body.search(gate);
    const recordAt = body.indexOf("public.record_admin_activity(");
    assert.ok(gateAt > -1 && gateAt < recordAt,
      `${fn} records before deciding whether anything actually happened`);
  }

  // CASE G. A refund is gated the same way one level up, by the sync
  // result the Stripe webhook uses - never on 'refund_pending', never on
  // 'unchanged', and never when the sync threw.
  const gateAt = refundFlow.indexOf("deps.isNewSettledFact(");
  const auditAt = refundFlow.indexOf("deps.recordActivity(");
  assert.ok(gateAt > -1 && gateAt < auditAt,
    "a refund is recorded before GLOA has accepted a new settled fact");
});

test("4d6: the conflict raise cannot roll back a business change", () => {
  // The one cost of raising instead of swallowing: inside a wrapper, an
  // exception takes the business change down with it. So it must be
  // unreachable from there, and that is a property of the code rather
  // than a hope.
  //
  // The order wrappers mint their key, so they can never present one
  // that exists. The inventory wrappers pass the caller's key, but 050
  // owns a GLOBAL unique index on inventory_movements.operation_id and
  // answers 'already_recorded' before locking anything - and the
  // wrappers record only on 'recorded'.
  const ledger = sqlOnly(read("supabase/migrations/050_inventory_foundation.sql"));
  assert.match(ledger, /create unique index if not exists idx_inventory_movements_operation\s*\n\s*on public\.inventory_movements \(operation_id\)/,
    "050's operation id is no longer globally unique, so a reused id could reach the audit inside a wrapper");
  assert.match(ledger, /where operation_id = p_operation_id;\s*\n\s*if found then\s*\n\s*return jsonb_build_object\(\s*\n\s*'result', 'already_recorded'/,
    "050 no longer short-circuits a repeated operation id");
  for (const fn of ["admin_record_inventory_movement", "admin_record_inventory_stocktake"]) {
    const at = sql.indexOf(`create or replace function public.${fn}`);
    const body = sql.slice(at, sql.indexOf("$$;", at));
    assert.ok(body.includes("if v_payload ->> 'result' = 'recorded' then"),
      `${fn} would audit a repeated operation id and could raise inside the transaction`);
  }
  // And the reasoning is written in the migration, where the next person
  // to touch this will be.
  assert.match(migration, /WHERE THIS RAISE CAN AND CANNOT REACH/);

  // On the application path a raise is exactly what is wanted: it
  // arrives as an error, is logged, and the business change stands.
  assert.match(auditDeps, /if \(error\) \{[\s\S]*?console\.error[\s\S]*?return false/);
});

test("4e: the two paths that CANNOT be one transaction say so, and are still keyed", () => {
  // A refund. Stripe cannot join a Postgres transaction, so the audit is
  // written after the sync says the settled fact is NEW - the same gate
  // that decides whether a confirmation mail is sent.
  const gateAt = refundFlow.indexOf("deps.isNewSettledFact(");
  const auditAt = refundFlow.indexOf("deps.recordActivity(");
  const mailAt = refundFlow.indexOf("deps.sendConfirmation(");
  assert.ok(gateAt > -1 && auditAt > -1 && mailAt > -1, "the refund flow lost a step");
  assert.ok(gateAt < auditAt, "a refund is recorded before the state is durable");
  assert.ok(auditAt < mailAt, "the customer is mailed before the act is recorded");
  // Keyed on the refund CLAIM, which migration 049 already makes unique
  // per economic refund - so a retry is one line, not two.
  assert.match(refundFlow, /recordActivity\(\{[\s\S]{0,200}?claimId/);

  // The item and category writes are several statements today, so their
  // audit follows the success rather than sharing its transaction. Each
  // is keyed on the operationId the client chose BEFORE the request.
  for (const fn of ["createInventoryItem", "updateInventoryItem", "setItemActive", "saveInventoryCategory"]) {
    const at = inventoryAdmin.indexOf(`export async function ${fn}`);
    assert.ok(at > -1, `${fn} disappeared`);
    const body = inventoryAdmin.slice(at, inventoryAdmin.indexOf("\n}", at));
    assert.ok(body.includes("recordAdminActivity({"), `${fn} performs a change it does not record`);
    assert.match(body, /operationId[,:]/, `${fn} records without an idempotency key`);
  }
  // And the honest account of that gap is written where the code is, not
  // only in a report.
  assert.match(read("lib/adminAuditDeps.ts"), /honest rather than atomic/);
});

test("4f: a failed audit never undoes a successful business change", () => {
  // The alternative is worse than a missing line: an operator whose stock
  // correction worked being told it failed, or having it rolled back,
  // because the log was briefly unreachable.
  assert.match(auditDeps, /Promise<boolean>/, "the recorder does not report a boolean");
  assert.ok(!auditDeps.includes("throw"), "the recorder throws and can fail a business call");
  assert.match(auditDeps, /if \(error\) \{[\s\S]*?console\.error[\s\S]*?return false/,
    "a failed audit is silent");
  for (const undo of ["rollback", "revert", "undo", "compensate"]) {
    assert.ok(!auditDeps.toLowerCase().includes(undo), `the recorder tries to ${undo}`);
  }
});

test("4g: and the one non-transactional audit is guarded at its call site too", () => {
  // lib/adminAuditDeps.ts already swallows its own errors, so this is a
  // second belt rather than the first. It matters because the refund is
  // the only audited act where the money has ALREADY moved: an exception
  // here would turn a successful refund into an error message for the
  // operator, and there is nothing to roll back.
  const at = refundFlow.indexOf("deps.recordActivity(");
  const around = refundFlow.slice(at - 400, at + 400);
  assert.match(around, /try \{[\s\S]*?await deps\.recordActivity\(\{[\s\S]*?\}\);[\s\S]*?\} catch \{[\s\S]*?deps\.log\(/,
    "a throwing recorder can fail a refund that already moved money");
  // The guard wraps the AUDIT only. The confirmation mail is still
  // decided by isNewSettledFact, not by whether the log was reachable.
  const sendAt = refundFlow.indexOf("deps.sendConfirmation(");
  assert.ok(sendAt > refundFlow.indexOf("} catch {", at),
    "the confirmation mail was pulled inside the audit's catch");
});

/* ════════════════════════════════════════════════════════════════════
   5. WHAT THE LOG IS ALLOWED TO HOLD
   ════════════════════════════════════════════════════════════════════ */

test("5: metadata is an allowlist, so nothing can be parked in the log", () => {
  const hostile = {
    carrier: "DHL",
    quantity: 12,
    // Everything below is refused BY NAME, whatever it contains.
    email: "kunde@example.com",
    customer: { name: "Anna", street: "Hauptstr. 1" },
    stripe_payment_intent: "pi_123",
    token: "secret",
    address: "Hauptstr. 1",
    note: "x".repeat(5000),
  };
  assert.deepEqual(safeAuditMetadata(hostile), { carrier: "DHL", quantity: 12 });

  // An allowed key with a value that is not a small fact is dropped too.
  assert.deepEqual(safeAuditMetadata({ carrier: "x".repeat(200) }), {});
  assert.deepEqual(safeAuditMetadata({ carrier: { nested: true } }), {});
  assert.deepEqual(safeAuditMetadata({ areas: Array(50).fill("b2c") }), {});
  assert.deepEqual(safeAuditMetadata({ quantity: Number.NaN }), {});
  // And it is total: no input makes it throw or pass something through.
  for (const junk of [null, undefined, 0, "", "carrier", [], [1, 2], () => {}]) {
    assert.deepEqual(safeAuditMetadata(junk), {}, `${JSON.stringify(junk)} got through`);
  }

  // No allowlisted key names a person, an address or a payment token.
  // item_name and category_name are the two exceptions, and they name a
  // THING in the shop rather than a human being.
  for (const key of AUDIT_METADATA_KEYS) {
    if (key === "item_name" || key === "category_name") continue;
    assert.ok(!/mail|address|street|phone|customer|token|secret|intent|charge|card|iban|name/i.test(key),
      `${key} is a person or a payment detail, not a fact about the act`);
  }
});

test("5b: the allowlist is applied on the SERVER, before anything leaves it", () => {
  // Not in the database and not on the screen - both of those are the
  // second line. A caller must not be able to widen what is stored by
  // passing something new through.
  assert.match(auditDeps, /p_metadata: safeAuditMetadata\(input\.metadata\)/);
  assert.match(auditDeps, /p_summary: auditSummary\(input\.summary\)/);
  // The database's size ceiling is the second limit, and it exists.
  assert.match(sql, /check \(jsonb_typeof\(metadata\) = 'object'\s*\n?\s*and length\(metadata::text\) <= 1024\)/);
});

test("5c: a summary is a bounded sentence, not a payload dump", () => {
  assert.equal(auditSummary("  Bestellung   GLOA-1  versendet \n"), "Bestellung GLOA-1 versendet");
  const long = auditSummary("x".repeat(1000));
  assert.equal(long.length, 300);
  assert.ok(long.endsWith("…"), "an over-long summary is cut without saying so");
  assert.match(sql, /summary\s+text not null check \(length\(btrim\(summary\)\) between 1 and 300\)/);
});

test("5d: the tracking NUMBER is never stored - only whether one exists", () => {
  const at = sql.indexOf("create or replace function public.admin_mark_order_shipped");
  const body = sql.slice(at, sql.indexOf("$$;", at));
  assert.ok(body.includes("'tracking_added', p_tracking_number is not null"),
    "the shipment audit lost its tracking flag");
  assert.ok(!/'tracking_number'\s*,\s*p_tracking_number/.test(body),
    "the tracking number itself is written into the audit log");
  assert.ok(!body.includes("'tracking_url'"), "the tracking url is written into the audit log");
  assert.ok(!AUDIT_METADATA_KEYS.includes("tracking_number"));
  assert.ok(!AUDIT_METADATA_KEYS.includes("tracking_url"));
});

test("5e: no money crosses into the log except the refund amount it is about", () => {
  // A refund's amount IS the act, so it is recorded. Nothing else
  // financial belongs here - this is not the finance module.
  const money = AUDIT_METADATA_KEYS.filter(k => /cent|amount|price|cost|total|sum/i.test(k));
  assert.deepEqual(money, ["refund_amount_cents"], "a second money field entered the audit log");
  for (const banned of ["unit_price", "price_cents", "total_cents", "invoice", "tax_cents"]) {
    assert.ok(!sql.includes(banned), `052 mentions ${banned}`);
  }
});

/* ════════════════════════════════════════════════════════════════════
   6. NOTHING WAS INVENTED, AND NOTHING WAS REPLACED
   ════════════════════════════════════════════════════════════════════ */

test("6: no history was backfilled - the log starts empty and says so on screen", () => {
  // The only INSERT in the migration is the one inside the recorder.
  const inserts = [...sql.matchAll(/insert into public\.(\w+)/g)].map(m => m[1]);
  assert.deepEqual([...new Set(inserts)], ["admin_activity_log"]);
  const at = sql.indexOf("create or replace function public.record_admin_activity");
  assert.ok(sql.slice(at, sql.indexOf("$$;", at)).includes("insert into public.admin_activity_log"),
    "an insert exists somewhere other than the recorder");
  assert.equal((sql.match(/insert into public\.admin_activity_log/g) ?? []).length, 1,
    "052 writes rows of history that nobody performed");

  // And the empty screen is honest about why it is empty rather than
  // implying nothing ever happened.
  assert.match(activityUi, /Der Verlauf beginnt mit der Einführung/);
});

test("6b: the domain history is still the source of truth, and is untouched", () => {
  // The audit log is ADDITIONAL. The ledger and the order columns keep
  // their job, and 052 neither replaces nor writes to either.
  for (const banned of [
    "alter table public.orders", "alter table public.inventory_movements",
    "alter table public.inventory_items", "drop table", "drop column",
  ]) {
    assert.ok(!sql.toLowerCase().includes(banned), `052 changes existing schema: ${banned}`);
  }
  // It READS an item name for the summary. That is all it does to them.
  const writes = [...sql.matchAll(/(?:insert into|update|delete from)\s+public\.(\w+)/gi)]
    .map(m => m[1].toLowerCase());
  assert.deepEqual([...new Set(writes)], ["admin_activity_log"],
    "052 writes a table other than its own");
  // Stated in the table's own comment, where a reader will find it.
  assert.match(sql, /comment on table public\.admin_activity_log is/);
  assert.match(migration, /inventory_movements is the ledger/);
});

test("6c: 052 is additive, and edits none of the 51 before it", () => {
  const files = readdirSync(path.join(ROOT, "supabase/migrations")).filter(f => f.endsWith(".sql")).sort();
  // 057 SIMPLIFIED THE LAUNCH DISCOUNT: the one-use claim architecture
  // 056 built is removed, because the code became reusable. Re-pinned
  // rather than deleted - what this guard protects is that nothing
  // UNREVIEWED appeared. Reviewed in
  // tests/launch-discount-migration.test.mjs.
  // PACKAGE 4A ADDED MIGRATION 059: the B2B self-service supply
  // commerce foundation - it evolves the two tables 006 built for a
  // negotiated agreement and adds no table of its own. Re-pinned rather
  // than deleted - what this guard protects is that nothing UNREVIEWED
  // appeared. Reviewed in tests/b2b-supply-commerce-foundation.test.mjs.
  assert.equal(files.length, 61);
  // 4A.4b added 053, so 052 is no longer the newest - it is the one
  // before it. What this guard is actually about is that 052 sits at its
  // own number and nothing was slipped in between.
  assert.equal(files[files.length - 8], "054_b2c_price_alignment.sql",
    "054 is no longer the migration directly below the newest");
  assert.equal(files[files.length - 10], "052_admin_activity_audit.sql",
    "052 is no longer the migration before the newest");
  assert.deepEqual(files.filter(f => Number(f.slice(0, 3)) > 61), [],
    "a migration 062 or beyond appeared");
  // 001-051 are immutable, which git - not a regex - is the authority on.
  // What this can assert is that 052 names none of them as something to
  // change.
  for (const f of files.slice(0, -1)) {
    assert.ok(!sql.includes(f), `052 refers to ${f} as something to change`);
  }
});

test("6d: the audit is never consulted to decide whether somebody may act", () => {
  // Evidence, not authorisation. If a permission check ever read this
  // table, deleting a line would become a way to gain access - and the
  // whole point of the design is that the log is downstream of every
  // decision, never upstream of one.
  for (const rel of [
    "lib/adminRoles.ts", "lib/adminSession.ts", "lib/adminIdentityDeps.ts",
    "lib/adminActionRoute.ts",
  ]) {
    const code = codeOnly(read(rel));
    for (const banned of ["admin_activity_log", "recordAdminActivity", "record_admin_activity"]) {
      assert.ok(!code.includes(banned), `${rel} reaches the audit log`);
    }
  }
  // And no caller branches on whether the audit succeeded.
  for (const rel of ["lib/adminOrderActions.ts", "lib/inventoryAdmin.ts"]) {
    const code = codeOnly(read(rel));
    assert.ok(!/if \([^)]*recordAdminActivity/.test(code),
      `${rel} branches on whether the audit succeeded`);
  }
});

/* ════════════════════════════════════════════════════════════════════
   7. READING IT
   ════════════════════════════════════════════════════════════════════ */

test("7: the read endpoint is a read, gated, and never cached", () => {
  assert.match(activityRoute, /export async function POST\(request: Request\)/);
  assert.ok(!/export async function (GET|PUT|PATCH|DELETE)\(/.test(activityRoute),
    "the activity route gained a second verb");
  // A VIEWER may read it: the least sensitive thing in the admin, and
  // looking is what a viewer is for.
  assert.match(activityRoute, /requireAdminIdentity\(request, "read"\)/);
  assert.match(activityRoute, /if \(!gate\.ok\) return gate\.response/);
  assert.match(activityRoute, /"Cache-Control": "no-store"/);
  // It selects the named columns, not everything the table holds.
  assert.match(activityRoute, /\.select\(AUDIT_LOG_COLUMNS/);
  assert.ok(!AUDIT_LOG_COLUMNS.includes("*"), "the read endpoint selects everything");
  assert.ok(!AUDIT_LOG_COLUMNS.includes("actor_user_id"),
    "the read endpoint publishes the actor's Supabase Auth id");
});

test("7a2: THE ACTOR'S ADDRESS IS STORED AND NOT SENT", () => {
  // The two halves of this are separate decisions, and both matter.
  //
  // STORED, because an address is how an administrator is identified
  // years later - after a display name changed, or when two people
  // share one. That snapshot is a large part of what the log is for, and
  // removing it would weaken the evidence.
  assert.match(sql, /actor_email_snapshot text not null check \(length\(btrim\(actor_email_snapshot\)\) between 3 and 200\)/,
    "the audit log stopped storing the actor's address");
  const at = sql.indexOf("create or replace function public.record_admin_activity");
  const fn = sql.slice(at, sql.indexOf("$$;", at));
  assert.ok(fn.includes("actor_email_snapshot"), "the recorder stopped snapshotting the address");
  assert.match(fn, /select a\.email, a\.display_name, a\.role/,
    "the recorder no longer reads the address from admin_users");

  // NOT SENT, because the screen shows a name and a role. The least data
  // that does the job is the right amount to put across the
  // server/browser boundary; adding it back should be a deliberate act
  // with a reason, not a default.
  assert.ok(!AUDIT_LOG_COLUMNS.includes("actor_email_snapshot"),
    "the read endpoint still selects the actor's address");
  assert.ok(!AUDIT_LOG_COLUMNS.includes("actor_user_id"),
    "the read endpoint still selects the actor's Supabase Auth id");
  assert.deepEqual(AUDIT_LOG_COLUMNS.split(","), [
    "id", "created_at", "actor_name_snapshot", "actor_role_snapshot",
    "module", "action", "entity_type", "entity_id", "summary", "metadata",
  ], "the columns crossing to the browser changed");

  // The route selects nothing beyond that list, and the screen neither
  // types nor renders an address.
  assert.match(activityRoute, /\.select\(AUDIT_LOG_COLUMNS/);
  assert.ok(!activityRoute.includes("actor_email"), "the route names the address directly");
  assert.ok(!activityUi.includes("actor_email"),
    "the activity screen still expects the actor's address");

  // And it still renders who acted, so nothing was lost on the way.
  assert.ok(activityUi.includes("row.actor_name_snapshot"), "the screen stopped showing who acted");
  assert.ok(activityUi.includes("row.actor_role_snapshot"), "the screen stopped showing the role");
});

test("7b: the filter and the page are allowlisted and bounded", () => {
  // Anything unrecognised becomes "all" rather than reaching PostgREST.
  assert.deepEqual([...AUDIT_FILTERS], ["all", "orders", "inventory"]);
  for (const hostile of ["orders,inventory", "'; drop table --", "finance", "", null, 7, {}]) {
    assert.equal(parseAuditFilter(hostile), "all", `${JSON.stringify(hostile)} reached the query`);
  }
  assert.equal(parseAuditFilter(" ORDERS "), "orders");
  assert.equal(parseAuditModule("Inventory"), "inventory");
  assert.equal(parseAuditModule("nonsense"), null);

  for (const [raw, expected] of [[-5, 1], [0, 1], ["abc", 1], [null, 1], [2.9, 2], [1e9, AUDIT_MAX_PAGE]]) {
    assert.equal(resolveAuditPage(raw), expected, `page ${JSON.stringify(raw)} was not bounded`);
  }
  assert.deepEqual(auditPageRange(1), { from: 0, to: AUDIT_PAGE_SIZE - 1 });
  assert.deepEqual(auditPageRange(3), { from: 50, to: 74 });
  // The page is applied server-side, so the log is never read unbounded.
  assert.match(activityRoute, /\.range\(from, to\)/);
});

test("7c: newest first, with a tiebreaker, so nothing swaps between pages", () => {
  const order = [...activityRoute.matchAll(/\.order\("(\w+)", \{ ascending: (\w+) \}\)/g)]
    .map(m => [m[1], m[2]]);
  assert.deepEqual(order, [["created_at", "false"], ["id", "false"]],
    "the activity read is not newest-first with an id tiebreaker");
  assert.match(sql, /create index if not exists idx_admin_activity_created\s*\n\s*on public\.admin_activity_log \(created_at desc, id desc\)/);
});

test("7d: the screen shows words, never the raw metadata object", () => {
  for (const banned of ["JSON.stringify(row.metadata", "JSON.stringify(m)", "{JSON.stringify"]) {
    assert.ok(!activityUi.includes(banned), `the activity screen prints raw JSON: ${banned}`);
  }
  // It renders an allowlist of its own, so widening what is STORED can
  // never silently widen what is DISPLAYED.
  const details = activityUi.slice(activityUi.indexOf("function details("),
    activityUi.indexOf("export function AdminActivity"));
  const shown = [...new Set([...details.matchAll(/\bm\.(\w+)/g)].map(m => m[1]))];
  assert.ok(shown.length > 0, "the screen renders no metadata at all");
  for (const key of shown) {
    assert.ok(AUDIT_METADATA_KEYS.includes(key),
      `the screen renders ${key}, which is not an allowed key`);
  }
});

test("7e: the tab is real, desktop-only by inheritance, and fetches nothing until opened", () => {
  assert.match(shell, /view === "activity" && <AdminActivity/);
  assert.match(shell, /activity: "Aktivität"/);
  // Mounted only under its own tab, so no other screen pays for it.
  assert.equal((shell.match(/<AdminActivity/g) ?? []).length, 1);
  // The desktop-only gate is INHERITED: AdminActivity carries no viewport
  // logic of its own, because the shell never renders it below the
  // breakpoint. A second gate here would be a second thing to keep in
  // step with the first.
  for (const banned of ["matchMedia", "innerWidth", "ADMIN_MIN_DESKTOP_WIDTH", "isAdminDesktopWidth"]) {
    assert.ok(!activityUi.includes(banned), `the activity screen re-implements the desktop gate: ${banned}`);
  }
  assert.ok(codeOnly(shell).includes("isDesktop"), "the shell lost its desktop gate");
});

test("7f: a lost session is reported, never rendered as an empty history", () => {
  // An empty table and an expired cookie must not look the same. The
  // second would read as "nobody has done anything", which is the one
  // thing an audit screen must never say when it does not know.
  assert.match(activityUi, /if \(res\.status === 401\) \{ onSessionLost\(\); return; \}/);
  assert.match(activityUi, /setLoadError\("Die Aktivität konnte nicht geladen werden\."\)/);
});

/* ════════════════════════════════════════════════════════════════════
   8. THE TAB IS ACTUALLY IN THE NAVIGATION

   Added after the audit trail was deployed and the Aktivität tab was
   reported missing from the live admin. It was not missing: the built
   and deployed bundle contained it, and a signed-in render shows it in
   place. What WAS missing is this section - test 7e only checked that
   the component is rendered under its view, and tests/admin-orders
   test 6 looked for the word "Aktivität" ANYWHERE in the file, which
   the TITLE map alone satisfies. Deleting the nav entry would have left
   the tab unreachable with every test still green.

   So these read the array the buttons are rendered from.
   ════════════════════════════════════════════════════════════════════ */

/** The nav entries, parsed from the array the buttons are built from. */
function navPairs() {
  const m = /\(\[(\["overview"[\s\S]*?)\] as const\)\.map\(\(\[key, label\]\)/.exec(shell);
  assert.ok(m, "the admin nav array is no longer recognisable");
  return [...m[1].matchAll(/\["(\w+)", "([^"]+)"\]/g)].map(x => [x[1], x[2]]);
}

test("8: AKTIVITÄT is a real entry in the navigation array, in its required place", () => {
  assert.deepEqual(navPairs(), [
    ["overview", "Übersicht"],
    ["orders", "Bestellungen"],
    // The read-only subscription view, between orders and inventory:
    // it is a commerce screen, so it belongs beside Bestellungen.
    ["subscriptions", "Abos"],
    // The prepaid plan, beside the recurring one and under the same role
    // gate. A different contract, so its own tab rather than a column.
    ["annual", "Jahrespläne"],
    ["inventory", "Inventar"],
    ["activity", "Aktivität"],
    ["waitlist", "Launch List"],
  ], "the navigation lost, gained or reordered a tab");

  // The required order, stated as the relationship rather than as an
  // index, so a future sixth tab elsewhere does not silently break it.
  const keys = navPairs().map(([k]) => k);
  assert.ok(keys.indexOf("inventory") < keys.indexOf("activity"),
    "Aktivität is not after Inventar");
  assert.ok(keys.indexOf("activity") < keys.indexOf("waitlist"),
    "Aktivität is not before Launch List");

  // NO EXISTING TAB DISAPPEARED.
  for (const key of ["overview", "orders", "inventory", "waitlist"]) {
    assert.ok(keys.includes(key), `the ${key} tab disappeared`);
  }
  // And Aktivität is a real tab, never advertised as "bald".
  const soon = shell.slice(shell.indexOf("ops-nav-soon") - 400, shell.indexOf("ops-nav-soon"));
  assert.ok(!soon.includes("Aktivität"), "Aktivität is listed as coming while its tab exists");
});

test("8b: every nav entry is a button that switches the view, with an active state", () => {
  // The tab has to be operable, not merely present: rendered as a
  // button, wired to setView, and carrying the same active state and
  // aria-current as its neighbours. One shared map does all five, so
  // Aktivität cannot behave differently from the rest.
  const nav = shell.slice(shell.indexOf('<nav className="ops-nav"'), shell.indexOf("</nav>"));
  assert.match(nav, /onClick=\{\(\) => setView\(key\)\}/, "the tabs no longer switch the view");
  assert.match(nav, /className=\{view === key \? "is-active" : ""\}/, "the active state is gone");
  assert.match(nav, /aria-current=\{view === key \? "page" : undefined\}/, "aria-current is gone");
  // One map for all five - no per-tab special case to diverge.
  assert.equal((nav.match(/\.map\(/g) ?? []).length, 2,
    "the nav gained a third map, so a tab can now be rendered differently");
  // The view union carries the key, so the button cannot point nowhere.
  const keys = navPairs().map(([k]) => k);
  const union = /const \[view, setView\] = useState<([^>]*)>/.exec(shell);
  assert.ok(union, "the view state is no longer recognisable");
  for (const key of keys) {
    assert.ok(union[1].includes(`"${key}"`), `${key} is a nav button but not a view`);
  }
});

test("8c: choosing the tab renders AdminActivity, and only that tab does", () => {
  assert.match(shell, /\{view === "activity" && <AdminActivity onSessionLost=/,
    "the activity view no longer renders AdminActivity");
  assert.equal((shell.match(/<AdminActivity/g) ?? []).length, 1,
    "AdminActivity is rendered from more than one place");
  assert.match(shell, /import \{ AdminActivity \}/, "AdminActivity is not imported");
  // Each view renders its own screen; none renders another's.
  for (const [view, component] of [
    ["orders", "AdminOrders"], ["inventory", "AdminInventory"], ["activity", "AdminActivity"],
  ]) {
    assert.ok(shell.includes(`{view === "${view}" && <${component}`),
      `the ${view} view does not render ${component}`);
  }
});

test("8d: the AKTIVITÄT tab is shown to every signed-in role - it is a read", () => {
  // A viewer is somebody trusted to LOOK at what the shop is doing, and
  // the log is the least sensitive thing there is to look at.
  //
  // ── NARROWED FROM "THE NAVIGATION" TO "THIS TAB" ──────────────
  //
  // This used to scan the whole <nav> for any role word, which was an
  // accurate proxy while no tab was role-gated. One now is: the Abos
  // section is a read a viewer may not perform, so the shell holds
  // exactly one role branch. The claim this test actually makes is
  // about the ACTIVITY tab, and it is now made about that tab.
  const nav = shell.slice(shell.indexOf('<nav className="ops-nav"'), shell.indexOf("</nav>"));
  // The activity entry itself carries no role condition...
  assert.match(nav, /\["activity", "Aktivität"\]/);
  assert.ok(!/activity[^\]]*canWrite|canWrite[^)]*activity/.test(nav),
    "the activity tab became role-gated");
  // ...and the ONE branch the nav holds is the subscription tab's.
  const branches = [...nav.matchAll(/maySeeSubscriptions/g)].length;
  assert.equal(branches, 1, "the navigation gained a second role branch");
  for (const roleWord of ["owner", "viewer", "canRead", "roleSatisfies"]) {
    assert.ok(!nav.includes(roleWord), `the navigation branches on ${roleWord}`);
  }
  // Nor is the render of the activity screen gated by a role.
  const render = shell.slice(shell.indexOf('{view === "activity"'), shell.indexOf('{view === "activity"') + 200);
  for (const roleWord of ["role", "owner", "viewer", "maySee"]) {
    assert.ok(!render.includes(roleWord), `rendering the activity screen branches on ${roleWord}`);
  }
  // The server still decides, and for the activity it asks only for
  // "read" - so a viewer keeps this tab whatever the shell does.
  assert.match(activityRoute, /requireAdminIdentity\(request, "read"\)/);
});

test("8e: the activity is fetched only while its own tab is open", () => {
  // Mounted under its view and nowhere else, and the fetch lives inside
  // the component - so a closed tab is an unmounted component is no
  // request. Nothing else in the admin may reach the endpoint.
  assert.ok(activityUi.includes('fetch("/api/admin/activity"'),
    "the activity screen no longer owns its own fetch");
  for (const rel of ["app/AdminOverview.tsx", "app/AdminOrders.tsx", "app/AdminInventory.tsx"]) {
    const code = codeOnly(read(rel));
    assert.ok(!code.includes("/api/admin/activity"),
      `${rel} fetches the activity while another tab is open`);
  }
  // The effect that loads it depends on the component's own state only,
  // so opening a different tab cannot trigger it.
  assert.match(activityUi, /useEffect\(\(\) => \{[\s\S]*?load\(\{ filter, page \}[\s\S]*?\}, \[load, filter, page\]\)/,
    "the activity load is no longer driven by its own state alone");
});

test("8f: below 1024 there is no navigation at all, so no tab and no request", () => {
  // The desktop rule is upstream of every tab: the blocker replaces the
  // whole shell, so Aktivität cannot appear on a phone and cannot fetch.
  assert.ok(codeOnly(shell).includes("isDesktop"), "the shell lost its desktop gate");
  assert.match(shell, /if \(isDesktop !== true\) return;/,
    "the session probe no longer waits for a desktop viewport");
  // The blocker returns before the navigation is reached.
  const blockerAt = shell.indexOf("ADMIN_DESKTOP_ONLY_COPY");
  const navAt = shell.indexOf('<nav className="ops-nav"');
  assert.ok(blockerAt > -1 && blockerAt < navAt,
    "the desktop blocker no longer precedes the navigation");
  // And the activity screen carries no viewport logic of its own.
  for (const banned of ["matchMedia", "innerWidth", "ADMIN_MIN_DESKTOP_WIDTH"]) {
    assert.ok(!activityUi.includes(banned), `the activity screen re-implements the desktop gate: ${banned}`);
  }
});

test("8g: no public navigation learned about the admin", () => {
  for (const rel of ["app/Chrome.tsx", "app/GloaSite.tsx"]) {
    const code = codeOnly(read(rel));
    for (const banned of ["Aktivität", "AdminActivity", "/api/admin/activity", "adminxyzuebersicht"]) {
      assert.ok(!code.includes(banned), `${rel} reaches the admin: ${banned}`);
    }
  }
});

test("8h: exposing the tab is a UI concern - it touched no migration", () => {
  // Stated here because the fix that added this section was reported as
  // a database-looking bug. The audit schema is already in production
  // and nothing about it moved.
  const files = readdirSync(path.join(ROOT, "supabase/migrations")).filter(f => f.endsWith(".sql"));
  assert.equal(files.length, 61, "a migration was added or removed by a navigation fix");
  assert.ok(!files.includes("053_admin_activity_nav.sql"), "a migration was invented for a UI fix");
  // And no migration knows what a tab is.
  for (const f of files) {
    const sqlSrc = read(`supabase/migrations/${f}`);
    for (const uiWord of ["ops-nav", "setView", "AdminActivity", "Aktivität"]) {
      assert.ok(!sqlSrc.includes(uiWord), `${f} mentions the user interface: ${uiWord}`);
    }
  }
});
