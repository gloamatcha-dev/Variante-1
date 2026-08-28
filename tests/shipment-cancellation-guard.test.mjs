import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeBlockedServerEnv } from "./helpers/testSupabase.mjs";
import {
  SHIPMENT_RESULTS,
  isShipmentResult,
  shipmentIsDurable,
  shipmentResultStatus,
  shipmentWasNewlyApplied,
} from "../lib/shipmentTransitionRules.ts";

// SAFE DEFAULT SUITE: pure result logic, source-level checks against the
// live SQL, and a real spawned server started WITHOUT a Supabase
// service-role key and WITHOUT a Resend key. No database is reachable, no
// production row can be read or written, no order is shipped or
// cancelled, no request is resolved, no Stripe API is called and no email
// of any kind is sent. Nothing here executes SQL.
//
// The rule this suite protects: an order with an UNANSWERED customer
// cancellation request cannot be newly shipped, a DECLINED request does
// not block anything, the guard lives in the locked database transaction
// rather than in the route, and an order that already shipped answers
// exactly what it answered before this guard existed.

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf-8");
const NEWLINE = String.fromCharCode(10);

const MIGRATIONS = path.join(ROOT, "supabase/migrations");
const route = read("app/api/internal/orders/ship/route.ts");
const rules = read("lib/shipmentTransitionRules.ts");
const migration028 = read("supabase/migrations/028_authorized_shipment_transition.sql");
const migration032 = read("supabase/migrations/032_open_cancellation_request_shipment_guard.sql");

const withoutComments = source => source
  .split(NEWLINE)
  .filter(line => {
    const t = line.trim();
    return !t.startsWith("--") && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
  })
  .join(NEWLINE);

const routeCode = withoutComments(route);
const routeBody = routeCode.slice(routeCode.indexOf("export async function POST"));
const rulesCode = withoutComments(rules);
const sql028 = withoutComments(migration028);
const sql032 = withoutComments(migration032);

/** The `mark_order_shipped` body of one migration, comments stripped. */
const functionBody = sql => {
  const start = sql.indexOf("create or replace function public.mark_order_shipped");
  const end = sql.indexOf("$$;", start);
  assert.ok(start > -1 && end > start, "mark_order_shipped not found");
  return sql.slice(start, end + 3);
};

const fn028 = functionBody(sql028);
const fn032 = functionBody(sql032);

const ORDER_NUMBER = "GLOA-2026-000451";
const NEW_RESULT = "cancellation_request_open";

/* ══════════════════════════════════════════════════════════════
   MIGRATION 032: NUMBERING AND IMMUTABILITY
   ══════════════════════════════════════════════════════════════ */

test("032: it is the next free number and 022-031 are untouched", () => {
  const files = readdirSync(MIGRATIONS).filter(f => f.endsWith(".sql")).sort();
  const numbers = files.map(f => f.slice(0, 3));
  assert.equal(new Set(numbers).size, numbers.length, "a migration number is used twice");
  assert.deepEqual(files.filter(f => f.startsWith("032")), ["032_open_cancellation_request_shipment_guard.sql"]);
  // Phase 2E-A added 033, so this asserts ownership and immutability
  // rather than "nothing later exists" - the same correction each earlier
  // suite already took. No later migration may redefine the shipment
  // transition or its guard.
  for (const name of files.filter(f => f > "032_open_cancellation_request_shipment_guard.sql")) {
    const later = withoutComments(readFileSync(path.join(MIGRATIONS, name), "utf-8"));
    assert.ok(!later.includes("create or replace function public.mark_order_shipped"),
      `${name} redefines the shipment transition`);
    assert.ok(!later.includes(NEW_RESULT), `${name} touches the shipment guard result`);
  }
  const upTo032 = files.filter(f => f < "033");
  assert.deepEqual(upTo032.slice(-11, -1), [
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
  ]);
});

test("032: migration 028 is not edited and still says exactly what it said", () => {
  for (const line of [
    "create or replace function public.mark_order_shipped(",
    "security definer set search_path = ''",
    "if v_order.payment_status not in ('paid', 'partially_refunded') then",
    "if v_order.fulfillment_status not in ('unfulfilled', 'processing') then",
    "grant execute on function public.mark_order_shipped(text, text, text, text) to service_role;",
    "fulfillment_status = 'shipped',",
    "shipped_at         = now(),",
  ]) {
    assert.ok(migration028.includes(line), `028 no longer contains: ${line}`);
  }
  // 028 never learned about the guard - 032 owns it.
  assert.ok(!sql028.includes("cancellation_requested_at"), "028 now references the request timestamp");
  assert.ok(!sql028.includes(NEW_RESULT), "028 now returns the new result");
});

test("032: migrations 029, 030 and 031 are not edited", () => {
  const m029 = read("supabase/migrations/029_authorized_order_cancellation.sql");
  const m030 = read("supabase/migrations/030_cancellation_request_notification_state.sql");
  const m031 = read("supabase/migrations/031_cancellation_request_resolution.sql");
  assert.ok(m029.includes("create or replace function public.cancel_order("));
  assert.ok(m030.includes("check (cancellation_request_notification_status in ('sending', 'sent', 'failed'))"));
  assert.ok(m031.includes("create or replace function public.resolve_order_cancellation_request("));
  assert.ok(m031.includes("check (cancellation_request_resolution in ('approved', 'declined'))"));
  // And 032 redefines none of them.
  for (const owned of [
    "create or replace function public.cancel_order",
    "create or replace function public.resolve_order_cancellation_request",
    "create or replace function public.request_order_cancellation",
    "create or replace function public.apply_order_refund_state",
  ]) {
    assert.ok(!sql032.includes(owned), `032 redefines ${owned}`);
  }
});

/* ══════════════════════════════════════════════════════════════
   032 IS 028 PLUS EXACTLY ONE GUARD
   ══════════════════════════════════════════════════════════════ */

test("032: THE FUNCTION IS 028's, LINE FOR LINE, PLUS ONE CONTIGUOUS GUARD", () => {
  // The single most important assertion in this suite. Every line of
  // 028's body must survive verbatim, in the same order, and the only
  // difference may be the new guard.
  const lines028 = fn028.split(NEWLINE).map(l => l.trim()).filter(Boolean);
  const lines032 = fn032.split(NEWLINE).map(l => l.trim()).filter(Boolean);

  // Every 028 line still present, in order, as a subsequence of 032.
  let cursor = 0;
  for (const line of lines028) {
    const at = lines032.indexOf(line, cursor);
    assert.ok(at > -1, `028 line vanished or moved out of order: ${line}`);
    cursor = at + 1;
  }

  // The extra lines are exactly the guard, and nothing else.
  const extra = [];
  const remaining = [...lines028];
  for (const line of lines032) {
    if (remaining[0] === line) { remaining.shift(); continue; }
    extra.push(line);
  }
  assert.deepEqual(extra, [
    "if v_order.cancellation_requested_at is not null",
    "and v_order.cancellation_request_resolution is null",
    "then",
    "return jsonb_build_object(",
    `'result', '${NEW_RESULT}',`,
    "'order_id', v_order.id,",
    "'order_number', v_order.order_number",
    ");",
    "end if;",
  ], "032 changed something other than adding the guard");
});

test("032: the signature is byte-identical to 028's", () => {
  const signature = sql => {
    const at = sql.indexOf("create or replace function public.mark_order_shipped");
    return sql.slice(at, sql.indexOf("as $$", at));
  };
  assert.equal(signature(sql032), signature(sql028), "the signature changed");
  // And it is still four text arguments returning jsonb.
  const sig = signature(sql032);
  const params = [...sig.matchAll(/(p_\w+)\s+text/g)].map(m => m[1]);
  assert.deepEqual(params, ["p_order_number", "p_carrier", "p_tracking_number", "p_tracking_url"]);
  assert.ok(sig.includes("returns jsonb"));
  assert.ok(sig.includes("language plpgsql"));
  assert.ok(sig.includes("volatile"));
  assert.ok(sig.includes("security definer set search_path = ''"));
});

test("032: the six-column UPDATE is unchanged", () => {
  const setClause = sql => {
    const at = sql.indexOf("update public.orders");
    return sql.slice(at, sql.indexOf("where id = v_order.id", at));
  };
  assert.equal(setClause(sql032), setClause(sql028), "the transition writes something different");
  const written = [...setClause(sql032).matchAll(/^\s*(?:set\s+)?(\w+)\s*=/gm)].map(m => m[1]);
  assert.deepEqual(written.sort(), [
    "fulfillment_status", "shipped_at", "shipping_carrier", "status", "tracking_number", "tracking_url",
  ]);
  // Exactly one UPDATE in the whole migration.
  assert.equal([...sql032.matchAll(/update public\.orders/g)].length, 1);
});

test("032: every pre-existing guard survived verbatim", () => {
  for (const guard of [
    "if v_order.fulfillment_status = 'delivered' or v_order.status = 'delivered' then",
    "if v_order.fulfillment_status = 'shipped' then",
    "v_order.shipping_carrier is not distinct from v_carrier",
    "if v_order.fulfillment_status = 'cancelled'",
    "or v_order.status in ('cancelled', 'refunded')",
    "if v_order.payment_status not in ('paid', 'partially_refunded') then",
    "if v_order.fulfillment_status not in ('unfulfilled', 'processing') then",
    "if v_url is not null and v_url !~* '^https?://[^[:space:]]+$' then",
    "where order_number = btrim(upper(p_order_number))",
  ]) {
    assert.ok(fn032.includes(guard), `032 lost the guard: ${guard}`);
    assert.ok(fn028.includes(guard), `028 never had: ${guard}`);
  }
  // The three length ceilings too.
  for (const ceiling of ["> 100", "> 500"]) {
    assert.equal(
      [...fn032.matchAll(new RegExp(ceiling.replace(">", ">"), "g"))].length,
      [...fn028.matchAll(new RegExp(ceiling.replace(">", ">"), "g"))].length,
      `a length ceiling changed: ${ceiling}`
    );
  }
});

test("032: no column, constraint, trigger, policy, index or backfill", () => {
  for (const forbidden of [
    "add column", "alter column", "add constraint", "drop constraint",
    "create trigger", "create policy", "create index",
    "insert into", "delete from", "truncate", "drop table", "drop function",
    "notify", "http_post", "net.http", "resend", "smtp",
  ]) {
    assert.ok(!sql032.toLowerCase().includes(forbidden), `032 performs: ${forbidden}`);
  }
  assert.ok(!sql032.toLowerCase().includes("alter table"), "032 alters a table");
});

test("032: the grants are re-stated exactly and nothing new is granted", () => {
  const signature = "public.mark_order_shipped(text, text, text, text)";
  for (const role of ["public", "anon", "authenticated"]) {
    assert.ok(sql032.includes(`revoke all on function ${signature} from ${role};`), `not revoked from ${role}`);
    assert.ok(sql028.includes(`revoke all on function ${signature} from ${role};`), `028 changed`);
  }
  const grants = sql032.split(NEWLINE).filter(l => l.trim().toLowerCase().startsWith("grant"));
  assert.equal(grants.length, 1, "more than one grant was issued");
  assert.ok(grants[0].includes(`grant execute on function ${signature} to service_role;`));
  // No table or column grant of any kind.
  assert.ok(!/grant\s+update/i.test(sql032), "032 grants an UPDATE privilege");
  assert.ok(!/grant[^;]*on\s+(table\s+)?public\.orders/i.test(sql032), "032 grants a table privilege");
  assert.ok(!/to (anon|authenticated|public)\b/i.test(sql032), "032 grants a browser role something");
  // public is revoked first, so anon/authenticated cannot inherit.
  assert.ok(sql032.indexOf("from public;") < sql032.indexOf("from anon;"));
});

/* ══════════════════════════════════════════════════════════════
   THE GUARD: PREDICATE AND PLACEMENT
   ══════════════════════════════════════════════════════════════ */

test("guard: the predicate is exactly the two required halves, nothing broader", () => {
  assert.ok(fn032.includes("if v_order.cancellation_requested_at is not null"));
  assert.ok(fn032.includes("and v_order.cancellation_request_resolution is null"));
  // It tests the resolution for NULL, NEVER for a value. A predicate like
  // "resolution <> 'approved'" would block every declined request
  // forever - the exact bug Phase 2D-A withheld this guard to avoid.
  assert.ok(!fn032.includes("cancellation_request_resolution <>"), "the guard tests for a value");
  assert.ok(!fn032.includes("cancellation_request_resolution ="), "the guard compares the resolution");
  assert.ok(!fn032.includes("'declined'"), "032 names a resolution value");
  assert.ok(!fn032.includes("'approved'"), "032 names a resolution value");
});

test("guard: it is AFTER the row lock", () => {
  assert.ok(fn032.indexOf("for update") < fn032.indexOf(NEW_RESULT), "the guard runs before the lock");
  assert.ok(fn032.indexOf("select * into v_order") < fn032.indexOf(NEW_RESULT));
});

test("guard: it is AFTER the idempotency branch, which is what preserves it", () => {
  // If it sat above already_shipped, a historically shipped order that
  // carries an unanswered request would start reporting
  // cancellation_request_open, breaking both the operator's answer and
  // the manual shipment-email retry path.
  assert.ok(fn032.indexOf("'already_advanced'") < fn032.indexOf(NEW_RESULT));
  assert.ok(fn032.indexOf("'already_shipped'") < fn032.indexOf(NEW_RESULT));
  assert.ok(fn032.indexOf("'conflict'") < fn032.indexOf(NEW_RESULT));
});

test("guard: it is AFTER every pre-existing refusal, so diagnoses keep priority", () => {
  // Placed last, the only orders whose answer changes are exactly those
  // that would otherwise have shipped.
  const lastNotShippable = fn032.lastIndexOf("'not_shippable'");
  assert.ok(lastNotShippable > -1);
  assert.ok(lastNotShippable < fn032.indexOf(NEW_RESULT), "a not_shippable guard runs after the new guard");
  assert.ok(fn032.indexOf("payment_status not in") < fn032.indexOf(NEW_RESULT));
  assert.ok(fn032.indexOf("fulfillment_status not in ('unfulfilled', 'processing')") < fn032.indexOf(NEW_RESULT));
});

test("guard: it is BEFORE the write, so nothing ships past it", () => {
  assert.ok(fn032.indexOf(NEW_RESULT) < fn032.indexOf("update public.orders"), "the guard runs after the write");
  assert.ok(fn032.indexOf(NEW_RESULT) < fn032.indexOf("shipped_at         = now()"));
  assert.ok(fn032.indexOf(NEW_RESULT) < fn032.lastIndexOf("'result', 'shipped'"));
});

test("guard: the blocked branch performs ZERO writes", () => {
  const branch = fn032.slice(
    fn032.indexOf("if v_order.cancellation_requested_at is not null"),
    fn032.indexOf("update public.orders")
  );
  for (const forbidden of ["update", "insert", "delete", "= now()", ":="]) {
    assert.ok(!branch.includes(forbidden), `the blocked branch performs: ${forbidden}`);
  }
  // It returns three fields and none of them is a customer fact.
  assert.ok(branch.includes("'order_id', v_order.id"));
  assert.ok(branch.includes("'order_number', v_order.order_number"));
  for (const pii of ["email", "name", "address", "snapshot", "_cents", "note", "customer"]) {
    assert.ok(!branch.includes(pii), `the blocked result returns ${pii}`);
  }
});

test("guard: it writes no cancellation, refund or email column anywhere in 032", () => {
  // The guard READS the two cancellation columns. It must never write
  // them, nor anything else outside the six shipment columns.
  const setClause = sql032.slice(
    sql032.indexOf("update public.orders"),
    sql032.indexOf("where id = v_order.id")
  );
  for (const forbidden of [
    "cancellation_requested_at", "cancellation_request_note",
    "cancellation_request_resolution", "cancellation_request_resolved_at",
    "cancelled_at", "payment_status", "refunded_total_cents", "refund_updated_at",
    "_cents", "tax_", "snapshot", "email_status", "notification_status",
  ]) {
    assert.ok(!setClause.includes(forbidden), `the transition writes ${forbidden}`);
  }
  // And the only two cancellation columns 032 mentions at all are read in
  // the guard predicate.
  const mentions = [...fn032.matchAll(/cancellation_\w+/g)].map(m => m[0]);
  assert.deepEqual([...new Set(mentions)].sort(), [
    "cancellation_request_open",
    "cancellation_request_resolution",
    "cancellation_requested_at",
  ]);
});

test("guard: an APPROVED request needs no special case - the cancelled guard covers it", () => {
  // Approving runs cancel_order in the same transaction (031 delegates to
  // 029), so an approved order is a cancelled order and is refused by the
  // guard that already existed.
  assert.ok(fn032.includes("if v_order.fulfillment_status = 'cancelled'"));
  assert.ok(fn032.includes("or v_order.status in ('cancelled', 'refunded')"));
  assert.ok(fn032.indexOf("'cancelled'") < fn032.indexOf(NEW_RESULT), "the cancelled guard moved");
  // 032 invents no approved-specific rule.
  assert.ok(!sql032.includes("= 'approved'"));
  const m031 = read("supabase/migrations/031_cancellation_request_resolution.sql");
  assert.ok(m031.includes("public.cancel_order(v_order.order_number)"), "031 no longer delegates");
});

/* ══════════════════════════════════════════════════════════════
   CONCURRENCY
   ══════════════════════════════════════════════════════════════ */

test("concurrency: all five writers of these columns take the same row lock", () => {
  const locking = {
    "019_order_lifecycle_tracking.sql": ["request_order_cancellation", "apply_order_refund_state"],
    "029_authorized_order_cancellation.sql": ["cancel_order"],
    "031_cancellation_request_resolution.sql": ["resolve_order_cancellation_request"],
    "032_open_cancellation_request_shipment_guard.sql": ["mark_order_shipped"],
  };
  for (const [file, functions] of Object.entries(locking)) {
    const sql = withoutComments(read(`supabase/migrations/${file}`));
    for (const name of functions) {
      const at = sql.indexOf(`create or replace function public.${name}`);
      assert.ok(at > -1, `${name} not found in ${file}`);
      const body = sql.slice(at, sql.indexOf("$$;", at));
      assert.ok(body.includes("for update"), `${name} does not lock the order row`);
    }
  }
});

test("concurrency: the lock is taken before the guard reads anything", () => {
  const beforeGuard = fn032.slice(0, fn032.indexOf(NEW_RESULT));
  assert.ok(beforeGuard.includes("for update"));
  // The guard reads v_order, which was populated by the locking SELECT -
  // never by a second, unlocked read.
  assert.equal([...fn032.matchAll(/select \* into v_order/g)].length, 1, "the function reads the row twice");
  assert.equal([...fn032.matchAll(/for update/g)].length, 1);
});

test("concurrency: NO pre-RPC application-only guard is relied upon", () => {
  // A route-level check would decide on a stale read. The route must not
  // grow one, and today it reads no order at all.
  for (const forbidden of [
    "cancellation_requested_at", "cancellation_request_resolution",
    'from("orders")', ".select(", "maybeSingle",
  ]) {
    assert.ok(!routeCode.includes(forbidden), `the route performs its own check: ${forbidden}`);
  }
  const rpcs = [...routeCode.matchAll(/\.rpc\("(\w+)"/g)].map(m => m[1]);
  assert.deepEqual(rpcs, ["mark_order_shipped"], "the route calls something else first");
  // And the pure rules module has no database access to check with.
  assert.ok(!rulesCode.includes("supabase"));
  assert.ok(!/from "\.\//.test(rulesCode), "the rules module stopped being a leaf");
});

/* ══════════════════════════════════════════════════════════════
   RESULT VOCABULARY
   ══════════════════════════════════════════════════════════════ */

test("results: the vocabulary gained exactly one value", () => {
  assert.deepEqual([...SHIPMENT_RESULTS].sort(), [
    "already_advanced", "already_shipped", NEW_RESULT,
    "conflict", "not_found", "not_shippable", "shipped",
  ]);
  assert.equal(SHIPMENT_RESULTS.length, 7);
  for (const result of SHIPMENT_RESULTS) {
    assert.ok(sql032.includes(`'${result}'`), `032 never returns ${result}`);
  }
});

test("results: the new result is NOT durable, so it can never mail anyone", () => {
  assert.equal(shipmentIsDurable(NEW_RESULT), false);
  assert.equal(shipmentWasNewlyApplied(NEW_RESULT), false);
  // The two durable results are unchanged.
  assert.equal(shipmentIsDurable("shipped"), true);
  assert.equal(shipmentIsDurable("already_shipped"), true);
});

test("results: the new result maps to 409, like the other state conflicts", () => {
  assert.equal(shipmentResultStatus(NEW_RESULT), 409);
  // Every pre-existing mapping is unchanged.
  assert.equal(shipmentResultStatus("shipped"), 200);
  assert.equal(shipmentResultStatus("already_shipped"), 200);
  assert.equal(shipmentResultStatus("not_found"), 404);
  assert.equal(shipmentResultStatus("conflict"), 409);
  assert.equal(shipmentResultStatus("already_advanced"), 409);
  assert.equal(shipmentResultStatus("not_shippable"), 409);
});

test("results: the new result is recognised and unknown values still are not", () => {
  assert.equal(isShipmentResult(NEW_RESULT), true);
  for (const bad of ["cancellation_pending", "cancelled", "", null, undefined, 42, {}]) {
    assert.equal(isShipmentResult(bad), false, JSON.stringify(bad));
  }
});

test("results: the name says REQUEST and OPEN, never that the order is cancelled", () => {
  assert.ok(NEW_RESULT.includes("request"));
  assert.ok(NEW_RESULT.includes("open"));
  assert.ok(!NEW_RESULT.includes("cancelled"));
  assert.ok(!NEW_RESULT.includes("pending"), "a 'pending' name would read as 'being cancelled'");
});

/* ══════════════════════════════════════════════════════════════
   THE API ROUTE
   ══════════════════════════════════════════════════════════════ */

test("route: the new result has a refusal message and there are now six", () => {
  const messages = routeCode.slice(routeCode.indexOf("const REFUSAL_MESSAGES"));
  const block = messages.slice(0, messages.indexOf("};"));
  assert.ok(block.includes(`${NEW_RESULT}:`));
  for (const existing of ["not_found:", "not_shippable:", "already_advanced:", "conflict:"]) {
    assert.ok(block.includes(existing), `the route lost ${existing}`);
  }
  assert.equal([...block.matchAll(/^\s+\w+:/gm)].length, 5);
});

test("route: the message says to resolve the request and claims nothing else", () => {
  const messages = routeCode.slice(routeCode.indexOf("const REFUSAL_MESSAGES"));
  const block = messages.slice(0, messages.indexOf("};"));
  const line = block.slice(block.indexOf(`${NEW_RESULT}:`));
  const message = line.slice(0, line.indexOf("\n", line.indexOf('"') + 1) + 200);
  // What it MUST say.
  assert.ok(message.includes("Stornierungsanfrage"), "the message does not name the request");
  assert.ok(/entscheiden|ablehnen|annehmen/.test(message), "the message does not say what to do");
  // What it MUST NOT say.
  for (const forbidden of ["storniert wurde", "ist storniert", "Erstattung", "erstattet", "Rückzahlung", "Geld"]) {
    assert.ok(!message.includes(forbidden), `the message claims ${forbidden}`);
  }
});

test("route: no response anywhere claims a cancellation or a refund", () => {
  for (const forbidden of ["ist storniert", "wurde storniert", "Erstattung", "erstattet", "Rückzahlung"]) {
    assert.ok(!routeCode.includes(forbidden), `the route claims ${forbidden}`);
  }
});

test("route: the secret, the RPC and the success response are unchanged", () => {
  assert.ok(routeCode.includes("process.env.FULFILLMENT_ADMIN_SECRET"));
  const names = [...routeCode.matchAll(/process\.env\.(\w+)/g)].map(m => m[1]);
  assert.deepEqual([...new Set(names)].sort(), ["FULFILLMENT_ADMIN_SECRET"]);
  assert.ok(!routeCode.includes("CANCELLATION_ADMIN_SECRET"), "the ship route reuses the cancellation secret");
  assert.ok(!routeCode.includes("CRON_SECRET"));
  const rpcs = [...routeCode.matchAll(/\.rpc\("(\w+)"/g)].map(m => m[1]);
  assert.deepEqual(rpcs, ["mark_order_shipped"]);
  const call = routeBody.slice(routeBody.indexOf('.rpc("mark_order_shipped"'));
  const args = call.slice(0, call.indexOf("});"));
  const params = [...args.matchAll(/(p_\w+):/g)].map(m => m[1]);
  assert.deepEqual(params, ["p_order_number", "p_carrier", "p_tracking_number", "p_tracking_url"]);
});

test("route: the success response shape is unchanged", () => {
  const success = routeBody.slice(routeBody.lastIndexOf("Response.json("));
  const fields = [...success.matchAll(/^\s+(\w+)[:,]/gm)].map(m => m[1]);
  assert.deepEqual(fields.sort(), [
    "emailOutcome", "ok", "orderNumber", "shipmentApplied", "shipmentStatus", "shippedAt",
  ]);
  assert.ok(routeCode.includes('shipmentStatus: "shipped"'));
});

test("route: a blocked shipment returns before the email is reached", () => {
  const durableAt = routeBody.indexOf("if (!shipmentIsDurable(result))");
  const sendAt = routeBody.indexOf("sendShipmentConfirmationIfNeeded(orderId)");
  assert.ok(durableAt > -1 && sendAt > -1);
  assert.ok(durableAt < sendAt, "a refused result can reach the email");
  assert.equal([...routeBody.matchAll(/sendShipmentConfirmationIfNeeded\(/g)].length, 1);
});

/* ══════════════════════════════════════════════════════════════
   EMAIL
   ══════════════════════════════════════════════════════════════ */

test("email: no new template and no new Resend namespace", () => {
  // Phase 2E-A added refundConfirmation.ts and the gloa/refund/
  // namespace. Neither belongs to the shipment guard, and what this
  // assertion protects is that THIS task added nothing of its own.
  const templates = readdirSync(path.join(ROOT, "lib/email")).sort();
  assert.deepEqual(templates, [
    "cancellationConfirmation.ts", "cancellationOutcome.ts",
    "cancellationRequestNotification.ts",
    "internalOrderNotification.ts", "orderConfirmation.ts",
    "refundConfirmation.ts", "shipmentConfirmation.ts", "subscriptionStarted.ts",
    "withdrawalConfirmation.ts",
  ], "an unexpected email template was added");
  const namespaces = [];
  for (const name of templates) {
    const source = withoutComments(read(`lib/email/${name}`));
    for (const m of source.matchAll(/`gloa\/([a-z-]+)\//g)) namespaces.push(m[1]);
  }
  // Phase 3H.2 added gloa/subscription-started/. It belongs to the
  // subscription lifecycle, not to the shipment guard, and what this
  // assertion protects is that THIS task still added nothing of its own.
  assert.deepEqual(namespaces.sort(), [
    "cancellation-confirmation", "cancellation-outcome", "cancellation-request",
    "internal-order", "refund", "shipment", "subscription-started",
  ], "a Resend idempotency namespace was added or removed");
});

test("email: the shipment confirmation architecture is untouched", () => {
  const sender = withoutComments(read("lib/shipmentConfirmationEmail.ts"));
  assert.ok(sender.includes("shipmentConfirmationIdempotencyKey(order.id)"));
  assert.ok(sender.includes('.in("fulfillment_status", ["shipped", "delivered"])'));
  // It never learned about cancellation requests, and must not: it is
  // only ever entered for an order that is already durably shipped.
  assert.ok(!sender.includes("cancellation_requested_at"));
  assert.ok(!sender.includes("cancellation_request_resolution"));
});

/* ══════════════════════════════════════════════════════════════
   REGRESSIONS
   ══════════════════════════════════════════════════════════════ */

test("regression: the three cancellation routes are unchanged", () => {
  const requestRoute = withoutComments(read("app/api/orders/cancellation-request/route.ts"));
  assert.deepEqual([...requestRoute.matchAll(/\.rpc\("(\w+)"/g)].map(m => m[1]), ["request_order_cancellation"]);
  assert.ok(requestRoute.includes("sendCancellationRequestNotificationIfNeeded(orderId)"));

  const cancelRoute = withoutComments(read("app/api/internal/orders/cancel/route.ts"));
  assert.deepEqual([...cancelRoute.matchAll(/\.rpc\("(\w+)"/g)].map(m => m[1]), ["cancel_order"]);
  assert.ok(cancelRoute.includes("process.env.CANCELLATION_ADMIN_SECRET"));

  const resolveRoute = withoutComments(read("app/api/internal/orders/cancellation-request/resolve/route.ts"));
  assert.deepEqual([...resolveRoute.matchAll(/\.rpc\("(\w+)"/g)].map(m => m[1]),
    ["resolve_order_cancellation_request"]);
  assert.ok(resolveRoute.includes("sendCancellationOutcomeEmailIfNeeded(orderId)"));

  // None of them learned about shipping.
  for (const source of [requestRoute, cancelRoute, resolveRoute]) {
    assert.ok(!source.includes("mark_order_shipped"), "a cancellation route can ship");
    assert.ok(!source.includes(NEW_RESULT));
  }
});

test("regression: the refund webhook flow is untouched", () => {
  const webhook = withoutComments(read("app/api/stripe/webhook/route.ts"));
  assert.ok(webhook.includes("isRefundEventType(event.type)"));
  assert.ok(webhook.includes("syncOrderRefundStateFromStripe(stripe, paymentIntentId)"));
  assert.ok(!webhook.includes("mark_order_shipped"));
  const refunds = read("lib/stripeRefunds.ts");
  for (const event of [
    "charge.refunded", "charge.refund.updated", "refund.created", "refund.updated", "refund.failed",
  ]) {
    assert.ok(refunds.includes(`"${event}"`), `the refund event set lost ${event}`);
  }
  assert.ok(read("lib/orderRefunds.ts").includes('admin.rpc("apply_order_refund_state"'));
});

test("regression: no Stripe write API anywhere in the repository", () => {
  const STRIPE_WRITES = [
    ["refunds", ".create"], ["refunds", ".cancel"], ["paymentIntents", ".cancel"],
  ].map(parts => parts.join(""));
  const offenders = [];
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      const source = withoutComments(readFileSync(full, "utf-8"));
      for (const forbidden of STRIPE_WRITES) {
        if (source.includes(forbidden)) offenders.push(`${entry.name}: ${forbidden}`);
      }
    }
  };
  walk(path.join(ROOT, "app"));
  walk(path.join(ROOT, "lib"));
  assert.deepEqual(offenders, [], `a Stripe write API appeared: ${offenders.join(", ")}`);
  for (const forbidden of ["stripe", "payment_intent", "refunded_total_cents", "refund_updated_at"]) {
    assert.ok(!sql032.toLowerCase().includes(forbidden), `032 touches ${forbidden}`);
  }
});

test("regression: the other order emails are untouched", () => {
  for (const other of [
    "sendOrderConfirmationEmailIfNeeded", "sendInternalOrderNotificationIfNeeded",
    "sendCancellationRequestNotificationIfNeeded", "sendCancellationOutcomeEmailIfNeeded",
  ]) {
    assert.ok(!routeCode.includes(other), `the ship route triggers ${other}`);
    assert.ok(!sql032.includes(other), `032 touches ${other}`);
  }
  const webhook = withoutComments(read("app/api/stripe/webhook/route.ts"));
  assert.ok(webhook.includes("sendOrderConfirmationEmailIfNeeded("));
  assert.ok(webhook.includes("sendInternalOrderNotificationIfNeeded("));
});

test("regression: no new cron and no new secret", () => {
  const vercel = JSON.parse(read("vercel.json"));
  assert.equal((vercel.crons ?? []).length, 1, "a cron job was added");
  assert.equal(vercel.crons[0].path, "/api/cron/retry-order-notifications");
  const example = read(".env.example");
  for (const name of ["FULFILLMENT_ADMIN_SECRET", "CANCELLATION_ADMIN_SECRET", "CRON_SECRET"]) {
    assert.match(example, new RegExp(`^${name}=$`, "m"), `${name} gained a value or vanished`);
  }
  const declared = [...example.matchAll(/^([A-Z_0-9]+)=/gm)].map(m => m[1]);
  assert.equal(new Set(declared).size, declared.length, "a variable is declared twice");
});

test("regression: SHOP_STATUS, the subscription flag, pricing and tax are unchanged", () => {
  assert.ok(read("app/content.ts").includes('export const SHOP_STATUS = "prelaunch" as const;'));
  assert.match(read(".env.example"), /^B2C_SUBSCRIPTIONS_ENABLED=$/m);
  for (const source of [routeCode, rulesCode, sql032]) {
    for (const forbidden of [
      "B2C_SUBSCRIPTIONS_ENABLED", "SHOP_STATUS", "price_gross_cents",
      "computeShippingGrossCents", "resolveCheckoutTax", "SHIPPING_ZONES", "tax_total_cents",
    ]) {
      assert.ok(!source.includes(forbidden), `this task touches ${forbidden}`);
    }
  }
  assert.ok(!sql032.toLowerCase().includes("subscription"), "032 touches subscriptions");
});

test("regression: the account UI is untouched by this task", () => {
  const portal = read("app/AccountPortal.tsx");
  assert.ok(!portal.includes(NEW_RESULT), "the portal exposes an internal shipment result");
  assert.ok(!portal.includes("mark_order_shipped"));
  assert.ok(!portal.includes("/api/internal/"));
  // The declined rendering from Phase 2D-B is still there.
  assert.ok(portal.includes('cancellation.state === "declined"'));
});

test("regression: no client bundle can see the secret or the RPC", () => {
  const CLIENT = path.join(ROOT, ".output/public");
  if (!existsSync(CLIENT)) return; // no build present; npm test always makes one

  const files = [];
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (/\.(js|mjs|json|html|css)$/.test(entry.name)) files.push(full);
    }
  };
  walk(CLIENT);
  assert.ok(files.length > 0, "no client assets were found to check");

  const leaks = [];
  for (const file of files) {
    const source = readFileSync(file, "utf-8");
    for (const needle of [
      "FULFILLMENT_ADMIN_SECRET", "CANCELLATION_ADMIN_SECRET",
      "mark_order_shipped", "isBearerSecretAuthorized", "timingSafeEqual",
    ]) {
      if (source.includes(needle)) leaks.push(`${path.relative(ROOT, file)}: ${needle}`);
    }
  }
  assert.deepEqual(leaks, [], `server-only material reached the client bundle: ${leaks.join(", ")}`);
});

test("032: the OWNER verification queries cover A through L", () => {
  for (const marker of [
    "-- (A)", "-- (B)", "-- (C)", "-- (D)", "-- (E)", "-- (F)",
    "-- (G)", "-- (H)", "-- (I)", "-- (J)", "-- (K)", "-- (L)",
  ]) {
    assert.ok(migration032.includes(marker), `verification ${marker} is missing`);
  }
  assert.ok(migration032.includes("prosecdef"), "no SECURITY DEFINER verification");
  assert.ok(migration032.includes("proconfig"), "no search_path verification");
  assert.ok(migration032.includes("has_function_privilege"), "no execute-privilege verification");
  assert.ok(migration032.includes("column_privileges"), "no UPDATE-grant verification");
  assert.ok(migration032.includes("pg_trigger"), "no trigger verification");
  assert.ok(migration032.includes("tests_resolution_for_null"), "no predicate-shape verification");
  assert.ok(migration032.includes("guard_after_idempotency"), "no placement verification");
  assert.ok(migration032.includes("shipped_with_open_request"), "no historical-row verification");
  assert.ok(migration032.includes("locks_row"), "no concurrency verification");
  assert.ok(migration032.includes("EXACTLY ONE ROW"), "no overload warning");
});

/* ══════════════════════════════════════════════════════════════
   THE HTTP BOUNDARY, ON REAL SPAWNED SERVERS
   ══════════════════════════════════════════════════════════════ */

const ENDPOINT_PATH = "/api/internal/orders/ship";
const SECRET = "test-only-fulfillment-secret-not-a-real-value";

/**
 * Every server is started without SUPABASE_SECRET_KEY and without
 * RESEND_API_KEY, so even a fully authorized request cannot reach a
 * database: it stops at the 503 the route returns when the admin client
 * is unconfigured, which is strictly before the RPC and therefore
 * strictly before any shipment and any email.
 */
function serverEnv(extra) {
  const env = writeBlockedServerEnv({ ...extra });
  delete env.RESEND_API_KEY;
  delete env.RESEND_CONTACT_FROM;
  delete env.CANCELLATION_ADMIN_SECRET;
  return env;
}

async function startServer(port, extraEnv) {
  const child = spawn(process.execPath, [".output/server/index.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: serverEnv({ PORT: String(port), ...extraEnv }),
    stdio: "ignore",
  });

  await new Promise((resolveReady, rejectReady) => {
    child.once("exit", code => rejectReady(new Error(`server exited early (code ${code})`)));
    (async () => {
      for (let attempt = 0; attempt < 50; attempt++) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/`);
          if (res.ok) return resolveReady();
        } catch {
          // not up yet
        }
        await delay(200);
      }
      rejectReady(new Error("server did not become ready in time"));
    })();
  });

  return child;
}

const post = (port, payload, headers = {}) =>
  fetch(`http://127.0.0.1:${port}${ENDPOINT_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  });

const UNSET_PORT = 8952;
let unsetServer;

test.before(async () => {
  unsetServer = await startServer(UNSET_PORT, { FULFILLMENT_ADMIN_SECRET: "" });
});

test.after(() => {
  unsetServer?.kill();
});

test("http: the existing fail-closed behavior is unchanged", async () => {
  for (const headers of [{}, { authorization: "Bearer " }, { authorization: `Bearer ${SECRET}` }]) {
    const res = await post(UNSET_PORT, { orderNumber: ORDER_NUMBER }, headers);
    assert.equal(res.status, 503, JSON.stringify(headers));
    assert.equal((await res.json().catch(() => null))?.ok, undefined);
  }
});

const SECURED_PORT = 8953;
let securedServer;

test.before(async () => {
  securedServer = await startServer(SECURED_PORT, { FULFILLMENT_ADMIN_SECRET: SECRET });
});

test.after(() => {
  securedServer?.kill();
});

test("http: the existing unauthorized behavior is unchanged", async () => {
  const none = await post(SECURED_PORT, { orderNumber: ORDER_NUMBER });
  assert.equal(none.status, 401);
  for (const authorization of [
    "Bearer wrong-secret", `Bearer ${SECRET}x`, `bearer ${SECRET}`, SECRET,
    "Bearer test-only-cancellation-secret-not-a-real-value",
  ]) {
    const res = await post(SECURED_PORT, { orderNumber: ORDER_NUMBER }, { authorization });
    assert.equal(res.status, 401, authorization);
  }
});

test("http: the existing validation behavior is unchanged", async () => {
  const authorization = `Bearer ${SECRET}`;
  assert.equal((await post(SECURED_PORT, "{not json", { authorization })).status, 400);

  const badNumber = await post(SECURED_PORT, { orderNumber: "nonsense" }, { authorization });
  assert.equal(badNumber.status, 400);
  assert.equal((await badNumber.json()).error, "Ungültige Anfrage: invalid_order_number.");

  const unknown = await post(SECURED_PORT, { orderNumber: ORDER_NUMBER, shipped_at: "x" }, { authorization });
  assert.equal(unknown.status, 400);
  assert.equal((await unknown.json()).error, "Ungültige Anfrage: unknown_field.");
});

test("http: a fully valid authorized request still stops at the unconfigured database", async () => {
  // Unchanged from Phase 2B: the guard lives past this point, in the RPC,
  // so this suite can never block or ship anything for real.
  const res = await post(
    SECURED_PORT,
    { orderNumber: ORDER_NUMBER, carrier: "DHL", trackingNumber: "00340434161094042557" },
    { authorization: `Bearer ${SECRET}` }
  );
  assert.equal(res.status, 503);
  const parsed = await res.json();
  assert.equal(parsed.ok, undefined);
  assert.equal(parsed.error, "Vorübergehend nicht verfügbar.");
});

test("http: no response body ever contains the secret", async () => {
  const responses = await Promise.all([
    post(SECURED_PORT, { orderNumber: ORDER_NUMBER }),
    post(SECURED_PORT, { orderNumber: "nonsense" }, { authorization: `Bearer ${SECRET}` }),
    post(SECURED_PORT, { orderNumber: ORDER_NUMBER }, { authorization: `Bearer ${SECRET}` }),
  ]);
  for (const res of responses) {
    const text = await res.text();
    assert.ok(!text.includes(SECRET), "a response echoed the secret");
    assert.ok(!text.includes("FULFILLMENT_ADMIN_SECRET"), "a response named the secret variable");
  }
});

test("no real Resend request, no Stripe request and no production Supabase in this suite", () => {
  const suite = withoutComments(read("tests/shipment-cancellation-guard.test.mjs"));
  const forbidden = [
    ["create", "Client("], ["new ", "Resend("], ["new ", "Stripe("],
    ["supabase", ".co"], ["api.", "resend.com"], ["api.", "stripe.com"],
  ].map(parts => parts.join(""));
  for (const needle of forbidden) {
    assert.ok(!suite.includes(needle), `the suite performs: ${needle}`);
  }
  const spawns = [...suite.matchAll(/spawn\(process\.execPath[\s\S]*?\}\)/g)];
  assert.equal(spawns.length, 1, "a server is spawned outside the guarded helper");
  assert.ok(spawns[0][0].includes("serverEnv("));
});
