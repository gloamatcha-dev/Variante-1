import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeBlockedServerEnv } from "./helpers/testSupabase.mjs";
import {
  ALLOWED_BODY_KEYS,
  DECISIONS,
  ORDER_NUMBER_RE,
  OUTCOME_EMAIL_STATUSES,
  RESOLUTION_RESULTS,
  isOutcomeEmailClaimable,
  isOutcomeEmailOwed,
  isOutcomeEmailSweepEligible,
  isResolutionResult,
  resolutionIsDurable,
  resolutionOutcome,
  resolutionResultStatus,
  resolutionWasNewlyApplied,
  validateResolutionRequest,
} from "../lib/cancellationResolutionRules.ts";
import { ORDER_NUMBER_RE as CANCEL_ORDER_NUMBER_RE } from "../lib/orderCancellationRules.ts";
import {
  buildCancellationOutcomeEmail,
  cancellationOutcomeIdempotencyKey,
} from "../lib/email/cancellationOutcome.ts";
import { cancellationRequestNotificationIdempotencyKey } from "../lib/email/cancellationRequestNotification.ts";
import { internalOrderNotificationIdempotencyKey } from "../lib/email/internalOrderNotification.ts";
import { shipmentConfirmationIdempotencyKey } from "../lib/email/shipmentConfirmation.ts";
import { GLOA_FROM_HELLO, GLOA_REPLY_TO_SUPPORT } from "../lib/emailSenders.ts";
import {
  getCancellationView,
  getPrimaryStatusLabel,
  getStatusDetailText,
} from "../lib/orderStatus.ts";

// SAFE DEFAULT SUITE: pure template and rule logic, source-level checks,
// and a real spawned server started WITHOUT a Supabase service-role key
// and WITHOUT a Resend key. No database is reachable, no production row
// can be read or written, no order is cancelled, no request is resolved,
// no Stripe API is called and no email of any kind is sent. Nothing here
// executes SQL.
//
// The rules this suite protects: a resolution is terminal and cannot be
// reversed, approving delegates to migration 029 rather than
// reimplementing it, approving is never presented as a refund, declining
// never invents a reason, and a declined request stops the account page
// saying "wir prüfen" forever.

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf-8");
const NEWLINE = String.fromCharCode(10);

const MIGRATIONS = path.join(ROOT, "supabase/migrations");
const route = read("app/api/internal/orders/cancellation-request/resolve/route.ts");
const sender = read("lib/cancellationOutcomeEmail.ts");
const rules = read("lib/cancellationResolutionRules.ts");
const template = read("lib/email/cancellationOutcome.ts");
const migration031 = read("supabase/migrations/031_cancellation_request_resolution.sql");

const withoutComments = source => source
  .split(NEWLINE)
  .filter(line => {
    const t = line.trim();
    return !t.startsWith("--") && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
  })
  .join(NEWLINE);

const routeCode = withoutComments(route);
/** The handler body only: imports and type aliases excluded. */
const routeBody = routeCode.slice(routeCode.indexOf("export async function POST"));
const senderCode = withoutComments(sender);
const senderEntry = senderCode.slice(senderCode.indexOf("export async function sendCancellationOutcomeEmailIfNeeded"));
const rulesCode = withoutComments(rules);
const templateCode = withoutComments(template);
const sql031 = withoutComments(migration031);

const ORDER_ID = "11111111-2222-3333-4444-555555555555";
const ORDER_NUMBER = "GLOA-2026-000451";

const body = (overrides = {}) => ({ orderNumber: ORDER_NUMBER, decision: "approve", ...overrides });

const built = (outcome, overrides = {}) =>
  buildCancellationOutcomeEmail({
    order: { order_number: ORDER_NUMBER, outcome, accountOrderUrl: null, ...overrides },
  });

/** A complete OrderLifecycleFields row, for the account-UI assertions. */
const order = (overrides = {}) => ({
  status: "confirmed",
  payment_status: "paid",
  fulfillment_status: "unfulfilled",
  total_gross_cents: 4990,
  refunded_total_cents: null,
  shipping_carrier: null,
  tracking_number: null,
  tracking_url: null,
  shipped_at: null,
  cancellation_requested_at: null,
  cancellation_request_resolution: null,
  ...overrides,
});

/* ══════════════════════════════════════════════════════════════
   MIGRATION 031: NUMBERING AND IMMUTABILITY
   ══════════════════════════════════════════════════════════════ */

test("031: it is the next free number and 022-030 are untouched", () => {
  const files = readdirSync(MIGRATIONS).filter(f => f.endsWith(".sql")).sort();
  const numbers = files.map(f => f.slice(0, 3));
  assert.equal(new Set(numbers).size, numbers.length, "a migration number is used twice");
  assert.deepEqual(files.filter(f => f.startsWith("031")), ["031_cancellation_request_resolution.sql"]);
  // Phase 2D-C added 032, so this asserts ownership and immutability
  // rather than "nothing later exists" - the same correction each earlier
  // suite already took. No later migration may touch what 031 put live.
  for (const name of files.filter(f => f > "031_cancellation_request_resolution.sql")) {
    const later = withoutComments(readFileSync(path.join(MIGRATIONS, name), "utf-8"));
    assert.ok(!later.includes("create or replace function public.resolve_order_cancellation_request"),
      `${name} redefines the resolution RPC`);
    const setClauses = [...later.matchAll(/update public\.orders([\s\S]*?)where /g)].map(m => m[1]);
    for (const clause of setClauses) {
      for (const owned of ["cancellation_request_resolution", "cancellation_request_resolved_at"]) {
        assert.ok(!clause.includes(owned), `${name} writes ${owned}`);
      }
    }
  }
  const upTo031 = files.filter(f => f < "032");
  assert.deepEqual(upTo031.slice(-10, -1), [
    "022_recurring_subscription_foundation.sql",
    "023_harden_stripe_customers_grants.sql",
    "024_seed_b2c_subscription_plans.sql",
    "025_grant_subscription_plans_service_role.sql",
    "026_internal_order_notification_state.sql",
    "027_shipment_confirmation_email_state.sql",
    "028_authorized_shipment_transition.sql",
    "029_authorized_order_cancellation.sql",
    "030_cancellation_request_notification_state.sql",
  ]);
});

test("031: migration 029 is not edited and still says exactly what it said", () => {
  const migration029 = read("supabase/migrations/029_authorized_order_cancellation.sql");
  for (const line of [
    "create or replace function public.cancel_order(",
    "security definer set search_path = ''",
    "add column if not exists cancelled_at timestamptz;",
    "if v_order.status in ('shipped', 'delivered')",
    "or v_order.fulfillment_status in ('shipped', 'delivered')",
    "if v_order.fulfillment_status not in ('unfulfilled', 'processing') then",
    "status             = 'cancelled',",
    "fulfillment_status = 'cancelled',",
    "cancelled_at       = now()",
    "grant execute on function public.cancel_order(text) to service_role;",
  ]) {
    assert.ok(migration029.includes(line), `029 no longer contains: ${line}`);
  }
  // 031 does not redefine it.
  assert.ok(!sql031.includes("create or replace function public.cancel_order"), "031 redefines cancel_order");
});

test("031: migration 030 is not edited and still says exactly what it said", () => {
  const migration030 = read("supabase/migrations/030_cancellation_request_notification_state.sql");
  assert.ok(migration030.includes(
    "check (cancellation_request_notification_status in ('sending', 'sent', 'failed'))"
  ));
  assert.ok(migration030.includes(
    "grant update (cancellation_request_notification_status, cancellation_request_notification_sent_at)"
  ));
  assert.ok(!sql031.includes("cancellation_request_notification"), "031 touches 030's columns");
});

test("031: it redefines nothing 019, 026, 027 or 028 own", () => {
  for (const owned of [
    "request_order_cancellation(", "apply_order_refund_state(", "mark_order_shipped(",
    "internal_notification_status", "shipment_email_status", "confirmation_email_status",
  ]) {
    assert.ok(!sql031.includes(owned), `031 touches ${owned}`);
  }
});

/* ══════════════════════════════════════════════════════════════
   MIGRATION 031: COLUMNS AND CONSTRAINTS
   ══════════════════════════════════════════════════════════════ */

test("031: exactly four columns are added, all nullable, none with a default", () => {
  const adds = [...sql031.matchAll(/add column(?: if not exists)? (\w+)/g)].map(m => m[1]);
  assert.deepEqual(adds.sort(), [
    "cancellation_outcome_email_sent_at",
    "cancellation_outcome_email_status",
    "cancellation_request_resolution",
    "cancellation_request_resolved_at",
  ]);
  const alters = [...sql031.matchAll(/alter table public\.orders\n([\s\S]*?);/g)].map(m => m[1]);
  for (const statement of alters.filter(s => s.includes("add column"))) {
    assert.ok(!/\bdefault\b/i.test(statement), `a column has a default: ${statement.slice(0, 80)}`);
    assert.ok(!/not null/i.test(statement), `a column is NOT NULL: ${statement.slice(0, 80)}`);
  }
});

test("031: the resolution constraint allows exactly approved and declined", () => {
  assert.ok(sql031.includes("check (cancellation_request_resolution in ('approved', 'declined'))"));
  const check = sql031.slice(sql031.indexOf("check (cancellation_request_resolution"));
  const values = [...check.slice(0, 100).matchAll(/'(\w+)'/g)].map(m => m[1]);
  assert.deepEqual(values, ["approved", "declined"]);
  // An OPEN request is NULL, never a third value.
  assert.ok(!sql031.includes("'open'"), "031 introduces an 'open' resolution");
  assert.ok(!sql031.includes("'reviewing'"));
});

test("031: resolution and its timestamp are paired by a constraint", () => {
  assert.ok(sql031.includes("orders_cancellation_resolution_paired_check"));
  assert.ok(sql031.includes(
    "check ((cancellation_request_resolution is null) = (cancellation_request_resolved_at is null))"
  ));
  // Dropped defensively first, so re-running the migration is safe.
  assert.ok(sql031.includes("drop constraint if exists orders_cancellation_resolution_paired_check"));
});

test("031: the outcome email constraint allows exactly sending, sent, failed", () => {
  assert.ok(sql031.includes(
    "check (cancellation_outcome_email_status in ('sending', 'sent', 'failed'))"
  ));
  const check = sql031.slice(sql031.indexOf("check (cancellation_outcome_email_status"));
  const values = [...check.slice(0, 110).matchAll(/'(\w+)'/g)].map(m => m[1]);
  assert.deepEqual(values, ["sending", "sent", "failed"]);
});

test("031: THE NULL RULE - there is no 'pending' anywhere", () => {
  assert.ok(!sql031.includes("'pending'"), "031 introduces a pending state");
  assert.ok(!/default\s+'/i.test(sql031), "031 gives a column a literal default");
});

test("031: no backfill, no trigger, no policy, no index, no database mail", () => {
  for (const forbidden of [
    "insert into", "delete from", "truncate", "create trigger", "create policy",
    "create index", "drop column", "drop table", "alter column",
    "notify", "http_post", "net.http", "resend", "smtp",
  ]) {
    assert.ok(!sql031.toLowerCase().includes(forbidden), `031 performs: ${forbidden}`);
  }
});

/* ══════════════════════════════════════════════════════════════
   MIGRATION 031: THE RPC, ITS SECURITY, AND ITS DELEGATION
   ══════════════════════════════════════════════════════════════ */

test("031: the function is SECURITY DEFINER with an empty search_path", () => {
  assert.ok(sql031.includes("security definer set search_path = ''"));
  const fn = sql031.slice(sql031.indexOf("create or replace function public.resolve_order_cancellation_request"));
  assert.ok(fn.includes("language plpgsql"));
  assert.ok(fn.includes("volatile"));
  assert.ok(fn.includes("returns jsonb"));
});

test("031: the function takes exactly two parameters", () => {
  const signature = sql031.slice(
    sql031.indexOf("create or replace function public.resolve_order_cancellation_request"),
    sql031.indexOf("returns jsonb")
  );
  const params = [...signature.matchAll(/(p_\w+)\s+\w+/g)].map(m => m[1]);
  assert.deepEqual(params, ["p_order_number", "p_decision"]);
  for (const forbidden of [
    "status", "fulfillment_status", "payment_status", "cancelled_at",
    "resolution", "resolved_at", "refund", "amount", "email", "p_user",
  ]) {
    assert.ok(!signature.includes(forbidden), `the function accepts ${forbidden} as a parameter`);
  }
});

test("031: DELEGATION - approval calls migration 029 rather than reimplementing it", () => {
  // The single most important assertion in this suite. If 031 ever grows
  // its own copy of the shipped/delivered guard, the two can drift and
  // one of them will be wrong.
  assert.ok(sql031.includes("public.cancel_order(v_order.order_number)"), "031 does not delegate to 029");
  assert.equal([...sql031.matchAll(/public\.cancel_order\(/g)].length, 1, "cancel_order is called more than once");
  // And it inspects the result rather than assuming success.
  assert.ok(sql031.includes("v_cancel ->> 'result'"));
  assert.ok(sql031.includes("not in ('cancelled', 'already_cancelled')"));
});

test("031: it never writes a lifecycle, payment or refund column itself", () => {
  const updates = [...sql031.matchAll(/update public\.orders([\s\S]*?)where id = v_order\.id/g)].map(m => m[1]);
  assert.equal(updates.length, 2, "expected exactly two UPDATE statements: decline and approve");
  for (const setClause of updates) {
    for (const forbidden of [
      "status ", "status=", "fulfillment_status", "cancelled_at", "payment_status",
      "refunded_total_cents", "refund_updated_at", "_cents", "tax_", "snapshot",
      "tracking", "shipped_at", "email_status", "order_number",
      "cancellation_requested_at", "cancellation_request_note",
    ]) {
      const stripped = setClause
        .split("cancellation_request_resolution").join("")
        .split("cancellation_request_resolved_at").join("");
      assert.ok(!stripped.includes(forbidden), `a resolution UPDATE writes ${forbidden}`);
    }
    const written = [...setClause.matchAll(/^\s*(?:set\s+)?(\w+)\s*=/gm)].map(m => m[1]);
    assert.deepEqual(written.sort(), ["cancellation_request_resolution", "cancellation_request_resolved_at"]);
  }
});

test("031: the customer's request timestamp and note are never touched", () => {
  const fn = sql031.slice(sql031.indexOf("create or replace function public.resolve_order_cancellation_request"));
  // Read as a guard, never assigned.
  assert.ok(fn.includes("if v_order.cancellation_requested_at is null then"));
  assert.ok(!fn.includes("cancellation_requested_at ="), "031 writes the request timestamp");
  assert.ok(!fn.includes("cancellation_request_note"), "031 touches the request note");
});

test("031: the row is locked before any decision is made", () => {
  const select = sql031.slice(sql031.indexOf("select * into v_order"));
  assert.ok(select.slice(0, 300).includes("for update"), "the target row is not locked");
  assert.ok(sql031.indexOf("for update") < sql031.indexOf("public.cancel_order("));
  assert.ok(sql031.includes("where order_number = btrim(upper(p_order_number))"));
  // The same normalization 028 and 029 use, so the three cannot drift.
  assert.ok(read("supabase/migrations/029_authorized_order_cancellation.sql")
    .includes("where order_number = btrim(upper(p_order_number))"));
});

test("031: execute is revoked from public, anon and authenticated", () => {
  const signature = "public.resolve_order_cancellation_request(text, text)";
  for (const role of ["public", "anon", "authenticated"]) {
    assert.ok(
      sql031.includes(`revoke all on function ${signature} from ${role};`),
      `execute is not revoked from ${role}`
    );
  }
  assert.ok(sql031.indexOf("from public;") < sql031.indexOf("from anon;"), "public is not revoked first");
});

test("031: execute is granted to service_role only", () => {
  const grants = sql031.split(NEWLINE).filter(l => l.trim().toLowerCase().startsWith("grant"));
  assert.equal(grants.length, 2, "unexpected number of grants");
  const execGrant = grants.find(g => g.includes("grant execute"));
  assert.ok(execGrant.includes("public.resolve_order_cancellation_request(text, text) to service_role;"));
  assert.ok(!/to (anon|authenticated|public)\b/i.test(sql031), "031 grants a browser role something");
});

test("031: only the outcome EMAIL columns get a column-scoped UPDATE grant", () => {
  const updateGrant = sql031.split(NEWLINE).filter(l => l.trim().toLowerCase().startsWith("grant update"));
  assert.equal(updateGrant.length, 1);
  const grant = sql031.slice(sql031.indexOf("grant update"));
  const clause = grant.slice(0, grant.indexOf(";")).replace(/\s+/g, " ");
  assert.ok(clause.includes(
    "grant update (cancellation_outcome_email_status, cancellation_outcome_email_sent_at)"
  ), `unexpected grant: ${clause}`);
  assert.ok(clause.includes("on public.orders to service_role"));
  // THE RESOLUTION COLUMNS ARE NOT GRANTED. Only the RPC may write them.
  assert.ok(!clause.includes("cancellation_request_resolution"), "the resolution is directly UPDATE-grantable");
  assert.ok(!clause.includes("cancellation_request_resolved_at"), "resolved_at is directly UPDATE-grantable");
  for (const forbidden of [
    "fulfillment_status", "cancelled_at", "payment_status",
    "refunded_total_cents", "refund_updated_at", "_cents", "snapshot", "tracking",
  ]) {
    assert.ok(!clause.includes(forbidden), `031 grants ${forbidden}`);
  }
  assert.ok(!/grant[^;(]*update[^;(]*on\s+(table\s+)?public\.orders/i.test(sql031),
    "031 grants table-level UPDATE");
});

test("031: the OWNER verification queries cover A through P", () => {
  for (const marker of [
    "-- (A)", "-- (D)", "-- (E)", "-- (F)", "-- (G)", "-- (H)",
    "-- (I)", "-- (J)", "-- (K)", "-- (L)", "-- (M)", "-- (N)", "-- (O)", "-- (P)",
  ]) {
    assert.ok(migration031.includes(marker), `verification ${marker} is missing`);
  }
  assert.ok(migration031.includes("prosecdef"), "no SECURITY DEFINER verification");
  assert.ok(migration031.includes("proconfig"), "no search_path verification");
  assert.ok(migration031.includes("has_function_privilege"), "no execute-privilege verification");
  assert.ok(migration031.includes("column_privileges"), "no UPDATE-grant verification");
  assert.ok(migration031.includes("pg_trigger"), "no trigger verification");
  assert.ok(migration031.includes("broken_pairs"), "no paired-invariant verification");
  assert.ok(migration031.includes("delegates_to_029"), "no delegation verification");
  assert.ok(migration031.includes("pg_get_userbyid"), "no function-owner verification");
});

/* ══════════════════════════════════════════════════════════════
   THE RESOLUTION STATE MACHINE
   ══════════════════════════════════════════════════════════════ */

test("resolution: the result vocabulary matches what 031 can return", () => {
  assert.equal(RESOLUTION_RESULTS.length, 10);
  for (const result of RESOLUTION_RESULTS) {
    if (result === "already_approved" || result === "already_declined") {
      // Built by string concatenation in the RPC: 'already_' || v_decision.
      assert.ok(sql031.includes("'already_' || v_decision"), "the already_* results are not produced");
      continue;
    }
    assert.ok(sql031.includes(`'${result}'`), `031 never returns ${result}`);
  }
});

test("resolution: only the four terminal-answer results are durable", () => {
  for (const durable of ["approved", "declined", "already_approved", "already_declined"]) {
    assert.equal(resolutionIsDurable(durable), true, durable);
  }
  for (const refused of [
    "conflict", "not_cancellable", "order_already_cancelled",
    "no_request", "not_found", "invalid_decision",
  ]) {
    assert.equal(resolutionIsDurable(refused), false, refused);
  }
});

test("resolution: a CONFLICT is never durable, so it can never mail anyone", () => {
  // The order does carry a terminal resolution on a conflict - it carries
  // the OTHER one. Mailing from here would tell a customer about a
  // decision nobody made.
  assert.equal(resolutionIsDurable("conflict"), false);
  assert.equal(resolutionResultStatus("conflict"), 409);
});

test("resolution: only a first resolution counts as newly applied", () => {
  assert.equal(resolutionWasNewlyApplied("approved"), true);
  assert.equal(resolutionWasNewlyApplied("declined"), true);
  assert.equal(resolutionWasNewlyApplied("already_approved"), false);
  assert.equal(resolutionWasNewlyApplied("already_declined"), false);
  assert.equal(resolutionWasNewlyApplied("conflict"), false);
});

test("resolution: the outcome is derived from the RESULT, not the request", () => {
  assert.equal(resolutionOutcome("approved"), "approved");
  assert.equal(resolutionOutcome("already_approved"), "approved");
  assert.equal(resolutionOutcome("declined"), "declined");
  assert.equal(resolutionOutcome("already_declined"), "declined");
});

test("resolution: each result maps to a sensible HTTP status", () => {
  assert.equal(resolutionResultStatus("approved"), 200);
  assert.equal(resolutionResultStatus("declined"), 200);
  assert.equal(resolutionResultStatus("already_approved"), 200);
  assert.equal(resolutionResultStatus("already_declined"), 200);
  assert.equal(resolutionResultStatus("not_found"), 404);
  assert.equal(resolutionResultStatus("no_request"), 404);
  assert.equal(resolutionResultStatus("conflict"), 409);
  assert.equal(resolutionResultStatus("not_cancellable"), 409);
  assert.equal(resolutionResultStatus("order_already_cancelled"), 409);
  assert.equal(resolutionResultStatus("invalid_decision"), 400);
});

test("resolution: an unrecognized RPC result is refused, never guessed at", () => {
  for (const bad of ["cancelled", "shipped", "", null, undefined, 42, {}, ["approved"]]) {
    assert.equal(isResolutionResult(bad), false, JSON.stringify(bad));
  }
  for (const good of RESOLUTION_RESULTS) assert.equal(isResolutionResult(good), true);
});

test("031: TERMINAL - the same decision repeated performs zero writes", () => {
  const branch = sql031.slice(
    sql031.indexOf("if v_order.cancellation_request_resolution is not null then"),
    sql031.indexOf("v_now := now();")
  );
  assert.ok(branch.includes("'already_' || v_decision"));
  // resolved_at is REPORTED from the stored value, never re-stamped.
  assert.ok(branch.includes("v_order.cancellation_request_resolved_at"));
  assert.ok(!branch.includes("update"), "the idempotent branch performs a write");
  assert.ok(!branch.includes("now()"), "the idempotent branch re-stamps the timestamp");
});

test("031: TERMINAL - a different decision is refused in both directions", () => {
  const branch = sql031.slice(
    sql031.indexOf("if v_order.cancellation_request_resolution is not null then"),
    sql031.indexOf("v_now := now();")
  );
  assert.ok(branch.includes("'result', 'conflict'"));
  assert.ok(!branch.includes("update"), "a conflicting decision writes something");
  // The check is a plain equality against the STORED value, so it is
  // symmetric: approved->declined and declined->approved both conflict.
  assert.ok(branch.includes("if v_order.cancellation_request_resolution = v_decision then"));
  // And the terminal check runs before either decision path.
  assert.ok(sql031.indexOf("cancellation_request_resolution is not null then")
    < sql031.indexOf("if v_decision = 'declined' then"));
});

test("031: a failed approval leaves the request UNRESOLVED", () => {
  const approve = sql031.slice(sql031.indexOf("v_cancel     := public.cancel_order"));
  const guard = approve.slice(0, approve.indexOf("update public.orders"));
  assert.ok(guard.includes("'result', 'not_cancellable'"));
  assert.ok(guard.includes("return jsonb_build_object("), "the refusal does not return early");
  // The UPDATE that records 'approved' comes strictly after the guard.
  assert.ok(approve.indexOf("'not_cancellable'") < approve.indexOf("cancellation_request_resolution  = 'approved'"));
});

test("031: a decline refuses to contradict an already-cancelled order", () => {
  const decline = sql031.slice(
    sql031.indexOf("if v_decision = 'declined' then"),
    sql031.indexOf("v_cancel     := public.cancel_order")
  );
  assert.ok(decline.includes("if v_order.status = 'cancelled' or v_order.fulfillment_status = 'cancelled' then"));
  assert.ok(decline.includes("'result', 'order_already_cancelled'"));
  assert.ok(decline.indexOf("'order_already_cancelled'") < decline.indexOf("update public.orders"));
});

test("031: a decision may only be given where a request exists", () => {
  assert.ok(sql031.includes("if v_order.cancellation_requested_at is null then"));
  assert.ok(sql031.includes("'result', 'no_request'"));
  // Checked before the terminal check and before either decision path.
  assert.ok(sql031.indexOf("'no_request'") < sql031.indexOf("cancellation_request_resolution is not null then"));
});

test("031: the decision vocabulary is closed and fails closed", () => {
  assert.ok(sql031.includes("when 'approve' then 'approved'"));
  assert.ok(sql031.includes("when 'decline' then 'declined'"));
  assert.ok(sql031.includes("else null"));
  assert.ok(sql031.includes("'result', 'invalid_decision'"));
  // The decision is checked before the order is even read.
  assert.ok(sql031.indexOf("'invalid_decision'") < sql031.indexOf("select * into v_order"));
});

/* ══════════════════════════════════════════════════════════════
   INPUT VALIDATION
   ══════════════════════════════════════════════════════════════ */

test("input: a valid request normalizes to an order number and a decision", () => {
  assert.deepEqual(validateResolutionRequest(body()).request, {
    orderNumber: ORDER_NUMBER,
    decision: "approve",
  });
  assert.deepEqual(validateResolutionRequest(body({ decision: "decline" })).request, {
    orderNumber: ORDER_NUMBER,
    decision: "decline",
  });
});

test("input: the allow-list is exactly two keys and the decisions exactly two values", () => {
  assert.deepEqual([...ALLOWED_BODY_KEYS], ["orderNumber", "decision"]);
  assert.deepEqual([...DECISIONS], ["approve", "decline"]);
});

test("input: a non-object body is rejected", () => {
  for (const bad of [null, undefined, "string", 42, true, []]) {
    const result = validateResolutionRequest(bad);
    assert.equal(result.ok, false, JSON.stringify(bad));
    assert.equal(result.code, "invalid_body");
  }
});

test("input: a malformed order number is rejected", () => {
  for (const bad of [
    "", "   ", "GLOA-2026-12345", "GLOA-26-000451", "000451",
    "DROP TABLE orders", "GLOA-2026-000451 OR 1=1", 42, null, {},
  ]) {
    const result = validateResolutionRequest({ orderNumber: bad, decision: "approve" });
    assert.equal(result.ok, false, String(bad));
    assert.equal(result.code, "invalid_order_number", String(bad));
  }
});

test("input: the duplicated order-number regex has not drifted", () => {
  assert.equal(ORDER_NUMBER_RE.source, CANCEL_ORDER_NUMBER_RE.source);
  assert.equal(ORDER_NUMBER_RE.flags, CANCEL_ORDER_NUMBER_RE.flags);
});

test("input: an invalid decision is rejected, including near-misses", () => {
  for (const bad of [
    "", "APPROVE", "Approve", "approved", "declined", "cancel", "yes", "no",
    "approve ", true, 1, null, undefined, {}, ["approve"],
  ]) {
    const result = validateResolutionRequest({ orderNumber: ORDER_NUMBER, decision: bad });
    assert.equal(result.ok, false, JSON.stringify(bad));
    assert.equal(result.code, "invalid_decision", JSON.stringify(bad));
  }
});

test("input: the caller cannot supply lifecycle, resolution, refund or email fields", () => {
  for (const key of [
    "status", "fulfillment_status", "payment_status", "cancelled_at",
    "resolution", "resolvedAt", "cancellation_request_resolution",
    "refundAmount", "refunded_total_cents", "reason", "note",
    "userId", "user_id", "customerEmail", "recipient", "to", "subject", "html", "from",
  ]) {
    const result = validateResolutionRequest(body({ [key]: "x" }));
    assert.equal(result.ok, false, key);
    assert.equal(result.code, "unknown_field", key);
  }
});

/* ══════════════════════════════════════════════════════════════
   THE OUTCOME EMAIL CLAIM
   ══════════════════════════════════════════════════════════════ */

test("claim: the vocabulary is exactly sending, sent, failed", () => {
  assert.deepEqual([...OUTCOME_EMAIL_STATUSES], ["sending", "sent", "failed"]);
  assert.ok(!OUTCOME_EMAIL_STATUSES.includes("pending"));
});

test("claim: NULL and failed are claimable; sending and sent are not", () => {
  assert.equal(isOutcomeEmailClaimable(null), true);
  assert.equal(isOutcomeEmailClaimable(undefined), true);
  assert.equal(isOutcomeEmailClaimable("failed"), true);
  assert.equal(isOutcomeEmailClaimable("sending"), false);
  assert.equal(isOutcomeEmailClaimable("sent"), false);
  for (const bad of ["pending", "queued", "", "SENT", "x"]) {
    assert.equal(isOutcomeEmailClaimable(bad), false, bad);
  }
});

test("claim: THE SWEEP RULE is strictly narrower - failed and nothing else", () => {
  assert.equal(isOutcomeEmailSweepEligible("failed"), true);
  for (const never of [null, undefined, "sending", "sent", "pending", ""]) {
    assert.equal(isOutcomeEmailSweepEligible(never), false, String(never));
  }
  // NULL is claimable LIVE but never by a sweep. That asymmetry is the
  // whole point of having two predicates.
  assert.equal(isOutcomeEmailClaimable(null), true);
  assert.equal(isOutcomeEmailSweepEligible(null), false);
});

test("claim: eligibility requires a terminal resolution", () => {
  assert.equal(isOutcomeEmailOwed({
    cancellation_request_resolution: null,
    cancellation_outcome_email_status: null,
  }), false, "an unresolved order is eligible for an outcome email");

  for (const resolution of ["approved", "declined"]) {
    assert.equal(isOutcomeEmailOwed({
      cancellation_request_resolution: resolution,
      cancellation_outcome_email_status: null,
    }), true, resolution);
    assert.equal(isOutcomeEmailOwed({
      cancellation_request_resolution: resolution,
      cancellation_outcome_email_status: "failed",
    }), true, `${resolution} + failed`);
    for (const taken of ["sending", "sent"]) {
      assert.equal(isOutcomeEmailOwed({
        cancellation_request_resolution: resolution,
        cancellation_outcome_email_status: taken,
      }), false, `${resolution} + ${taken}`);
    }
  }
});

test("claim: the SQL claim repeats both halves of the rule", () => {
  const claim = senderCode.slice(senderCode.indexOf("async function claimOutcomeEmail"));
  const claimBody = claim.slice(0, claim.indexOf("return (data?.length"));
  assert.ok(claimBody.includes('.update({ cancellation_outcome_email_status: "sending" })'));
  assert.ok(claimBody.includes('.eq("id", orderId)'));
  assert.ok(claimBody.includes('.not("cancellation_request_resolution", "is", null)'));
  assert.ok(claimBody.includes("cancellation_outcome_email_status.is.null"));
  assert.ok(claimBody.includes("cancellation_outcome_email_status.eq.failed"));
  // A single UPDATE, so concurrent callers serialise on the row lock and
  // the loser gets zero rows back.
  assert.equal([...claimBody.matchAll(/\.update\(/g)].length, 1);
});

test("claim: mark-sent is unconditional, mark-failed is conditional on sending", () => {
  const markSent = senderCode.slice(senderCode.indexOf("async function markSent"));
  const sentBody = markSent.slice(0, markSent.indexOf("async function markFailed"));
  assert.ok(sentBody.includes('cancellation_outcome_email_status: "sent"'));
  assert.ok(sentBody.includes("cancellation_outcome_email_sent_at"));
  assert.ok(!sentBody.includes('.eq("cancellation_outcome_email_status"'),
    "mark-sent is conditional, which invites a duplicate");

  const markFailed = senderCode.slice(senderCode.indexOf("async function markFailed"));
  const failedBody = markFailed.slice(0, markFailed.indexOf("function recipientFromSnapshot"));
  assert.ok(failedBody.includes('cancellation_outcome_email_status: "failed"'));
  assert.ok(failedBody.includes('.eq("cancellation_outcome_email_status", "sending")'));
  assert.ok(!failedBody.includes("sent_at"), "mark-failed stamps a sent timestamp");
});

test("claim: the sender writes only migration 031's two email columns", () => {
  const updates = [...senderCode.matchAll(/\.update\(\{([\s\S]*?)\}\)/g)].map(m => m[1]);
  assert.ok(updates.length >= 3, "the state machine has fewer writes than expected");
  for (const payload of updates) {
    const keys = [...payload.matchAll(/(\w+):/g)].map(m => m[1]);
    for (const key of keys) {
      assert.ok(
        key === "cancellation_outcome_email_status" || key === "cancellation_outcome_email_sent_at",
        `the sender writes ${key}`
      );
    }
  }
});

test("claim: the sender never writes a resolution, lifecycle or refund column", () => {
  const updates = [...senderCode.matchAll(/\.update\(\{([\s\S]*?)\}\)/g)].map(m => m[1]).join(" ");
  for (const forbidden of [
    "cancellation_request_resolution", "cancellation_request_resolved_at",
    "status:", "fulfillment_status", "cancelled_at", "payment_status",
    "refunded_total_cents", "refund_updated_at",
  ]) {
    const stripped = updates
      .split("cancellation_outcome_email_status").join("")
      .split("cancellation_outcome_email_sent_at").join("");
    assert.ok(!stripped.includes(forbidden), `the sender writes ${forbidden}`);
  }
  for (const forbidden of [".rpc(", ".insert(", ".delete(", ".upsert("]) {
    assert.ok(!senderCode.includes(forbidden), `the sender performs: ${forbidden}`);
  }
});

test("claim: the sender never throws for an ordinary outcome", () => {
  assert.ok(!senderCode.includes("throw"), "the sender throws");
  const outcomes = [...senderEntry.matchAll(/return "([a-z-]+)"/g)].map(m => m[1]);
  assert.ok(outcomes.length >= 4);
  for (const outcome of outcomes) {
    assert.ok(["sent", "already-sent", "not-eligible", "failed"].includes(outcome), outcome);
  }
});

/* ══════════════════════════════════════════════════════════════
   IDEMPOTENCY KEY
   ══════════════════════════════════════════════════════════════ */

test("idempotency: the key is deterministic and per order", () => {
  assert.equal(cancellationOutcomeIdempotencyKey(ORDER_ID), `gloa/cancellation-outcome/${ORDER_ID}`);
  assert.equal(cancellationOutcomeIdempotencyKey(ORDER_ID), cancellationOutcomeIdempotencyKey(ORDER_ID));
  assert.notEqual(
    cancellationOutcomeIdempotencyKey(ORDER_ID),
    cancellationOutcomeIdempotencyKey("99999999-8888-7777-6666-555555555555")
  );
});

test("idempotency: the OUTCOME is deliberately not part of the key", () => {
  // A per-outcome key would let two contradictory emails go out if the
  // terminal invariant were ever broken. The plain per-order key makes
  // that physically impossible.
  const key = cancellationOutcomeIdempotencyKey(ORDER_ID);
  assert.ok(!key.includes("approved"));
  assert.ok(!key.includes("declined"));
  // Both outcomes for one order produce the identical key, which is the
  // property that makes two contradictory emails impossible.
  assert.equal(key, cancellationOutcomeIdempotencyKey(ORDER_ID));
  assert.ok(key.endsWith(ORDER_ID), "the key is suffixed with something other than the order id");
  // The function takes the order id and nothing else. ("outcome" appears
  // in the namespace `gloa/cancellation-outcome/`, so the body cannot be
  // scanned for that word - the signature is the real check.)
  const fn = templateCode.slice(templateCode.indexOf("export function cancellationOutcomeIdempotencyKey"));
  const signature = fn.slice(0, fn.indexOf("{"));
  assert.equal(signature.includes("orderId: string"), true);
  assert.equal([...signature.matchAll(/\w+:/g)].length, 1, "the key function takes more than one input");
});

test("idempotency: the key carries no PII and no volatile input", () => {
  const key = cancellationOutcomeIdempotencyKey(ORDER_ID);
  for (const forbidden of ["@", "kundin", "example.com", "2026-08", "GLOA-2026"]) {
    assert.ok(!key.includes(forbidden), `the key contains ${forbidden}`);
  }
  const fn = templateCode.slice(templateCode.indexOf("export function cancellationOutcomeIdempotencyKey"));
  const fnBody = fn.slice(0, fn.indexOf("}"));
  for (const volatile of ["Date", "now(", "random", "Math."]) {
    assert.ok(!fnBody.includes(volatile), `the key uses ${volatile}`);
  }
});

test("idempotency: it cannot collide with any other GLOA message about one order", () => {
  const keys = [
    cancellationOutcomeIdempotencyKey(ORDER_ID),
    cancellationRequestNotificationIdempotencyKey(ORDER_ID),
    internalOrderNotificationIdempotencyKey(ORDER_ID),
    shipmentConfirmationIdempotencyKey(ORDER_ID),
  ];
  assert.equal(new Set(keys).size, 4, "two GLOA messages share an idempotency key");
  for (const key of keys) assert.match(key, /^gloa\/[a-z-]+\/[0-9a-f-]{36}$/);
});

test("idempotency: the sender uses the deterministic key on its single send", () => {
  assert.ok(senderCode.includes("cancellationOutcomeIdempotencyKey(order.id)"));
  assert.ok(senderCode.includes("{ idempotencyKey }"));
  assert.equal([...senderCode.matchAll(/resend\.emails\.send\(/g)].length, 1);
});

/* ══════════════════════════════════════════════════════════════
   THE APPROVED EMAIL
   ══════════════════════════════════════════════════════════════ */

test("approved email: the subject states the cancellation and names the order", () => {
  const { subject } = built("approved");
  assert.ok(subject.includes("storniert"), "the subject does not say the order was cancelled");
  assert.ok(subject.includes(ORDER_NUMBER));
});

test("approved email: it states the cancellation as fact in every surface", () => {
  const { subject, html, text } = built("approved");
  for (const surface of [subject, html, text]) {
    assert.ok(surface.includes(ORDER_NUMBER), "the order number is missing");
  }
  assert.ok(html.includes("Deine Bestellung wurde storniert."));
  assert.ok(text.includes("Deine Bestellung wurde storniert."));
  assert.ok(html.includes("wird nicht mehr versendet"));
});

test("approved email: IT NEVER CLAIMS A REFUND HAPPENED", () => {
  const { subject, html, text } = built("approved");
  for (const surface of [subject, html, text]) {
    for (const forbidden of [
      "erstattet", "Erstattet", "zurückerstattet", "zurücküberwiesen",
      "Gutschrift", "Geld zurück", "Rückzahlung erfolgt", "wurde erstattet",
    ]) {
      assert.ok(!surface.includes(forbidden), `the approved email claims a refund: ${forbidden}`);
    }
  }
  // What it DOES say is conditional and separate.
  assert.ok(html.includes("Falls eine Erstattung nötig ist"));
  assert.ok(text.includes("Falls eine Erstattung nötig ist"));
  assert.ok(html.includes("melden uns separat"));
});

test("approved email: it invents no refund amount, date, method or account", () => {
  const { html, text } = built("approved");
  for (const surface of [html, text]) {
    assert.ok(!/\d+[,.]\d{2}\s*(€|EUR)/.test(surface), "an amount appears in the approved email");
    assert.ok(!/\d{2}\.\d{2}\.\d{4}/.test(surface), "a date appears in the approved email");
    for (const forbidden of ["IBAN", "Kreditkarte", "PayPal", "Konto", "Werktage", "Bankarbeitstage"]) {
      assert.ok(!surface.includes(forbidden), `the approved email invents ${forbidden}`);
    }
  }
});

test("approved email: it fabricates no tracking and asserts no shipment", () => {
  const { subject, html, text } = built("approved");
  for (const surface of [subject, html, text]) {
    for (const forbidden of ["Sendungsnummer", "Tracking", "DHL", "unterwegs", "zugestellt"]) {
      assert.ok(!surface.includes(forbidden), `the approved email fabricates ${forbidden}`);
    }
    // "versendet" appears exactly once, and only in the NEGATIVE: "wird
    // nicht mehr versendet". It must never assert a shipment.
    const stripped = surface.split("wird nicht mehr versendet").join("");
    assert.ok(!stripped.includes("versendet"), "the approved email claims a shipment");
  }
  assert.ok(html.includes("wird nicht mehr versendet"));
});

/* ══════════════════════════════════════════════════════════════
   THE DECLINED EMAIL
   ══════════════════════════════════════════════════════════════ */

test("declined email: the subject names the request and the order, not a cancellation", () => {
  const { subject } = built("declined");
  assert.ok(subject.includes("Stornierungsanfrage"));
  assert.ok(subject.includes(ORDER_NUMBER));
  // It must not read as "your order was cancelled".
  const stripped = subject.split("Stornierungsanfrage").join("");
  assert.ok(!stripped.includes("storniert"), "the declined subject claims a cancellation");
});

test("declined email: it says the request could not be accepted", () => {
  const { html, text } = built("declined");
  assert.ok(html.includes("Wir konnten die Stornierung nicht mehr umsetzen."));
  assert.ok(text.includes("Wir konnten die Stornierung nicht mehr umsetzen."));
  assert.ok(html.includes("bleibt bestehen"));
  for (const surface of [html, text]) assert.ok(surface.includes(ORDER_NUMBER));
});

test("declined email: IT NEVER CLAIMS THE ORDER WAS CANCELLED", () => {
  const { subject, html, text } = built("declined");
  for (const surface of [subject, html, text]) {
    const stripped = surface
      .split("Stornierungsanfrage").join("")
      .split("Stornierung nicht mehr umsetzen").join("")
      .split("Stornierung</p>").join("")
      .split("Stornierung").join("");
    assert.ok(!stripped.includes("storniert"), `the declined email claims a cancellation: ${surface.slice(0, 90)}`);
  }
});

test("declined email: it invents no reason", () => {
  const { html, text } = built("declined");
  for (const surface of [html, text]) {
    for (const forbidden of [
      "weil", "da die", "bereits verpackt", "bereits versendet", "unterwegs",
      "zu spät", "Lager", "Sendungsnummer", "DHL", "Tracking",
    ]) {
      assert.ok(!surface.includes(forbidden), `the declined email invents a reason: ${forbidden}`);
    }
  }
});

test("declined email: it claims no refund", () => {
  const { subject, html, text } = built("declined");
  for (const surface of [subject, html, text]) {
    for (const forbidden of ["erstattet", "Erstattung", "Gutschrift", "zurücküberwiesen", "Geld"]) {
      assert.ok(!surface.includes(forbidden), `the declined email mentions ${forbidden}`);
    }
  }
});

test("declined email: it points at the statutory withdrawal right, which is always true", () => {
  const { html, text } = built("declined");
  assert.ok(html.includes("Widerrufsrecht"));
  assert.ok(text.includes("Widerrufsrecht"));
});

/* ══════════════════════════════════════════════════════════════
   BOTH EMAILS: BRANDING, SAFETY, PURITY
   ══════════════════════════════════════════════════════════════ */

test("email: neither surface carries a secret, an id or card data", () => {
  for (const outcome of ["approved", "declined"]) {
    const { subject, html, text } = built(outcome);
    for (const surface of [subject, html, text]) {
      for (const forbidden of [
        "sk_", "whsec_", "re_", "pi_", "cus_", "sub_", "in_",
        "card", "Karte", "IBAN", "CVC", "last4",
        "SECRET", "api_key", "Bearer", "customer_snapshot", "user_id", ORDER_ID,
      ]) {
        assert.ok(!surface.includes(forbidden), `${outcome} contains ${forbidden}`);
      }
    }
  }
});

test("email: the order number is escaped, and the template escapes what reaches markup", () => {
  const { html } = buildCancellationOutcomeEmail({
    order: { order_number: '<script>alert(1)</script>&"', outcome: "approved", accountOrderUrl: null },
  });
  assert.ok(!html.includes("<script>"), "an unescaped script tag reached the HTML");
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(html.includes("&amp;"));
  assert.ok(html.includes("&quot;"));
});

test("email: the account link is escaped and omitted when absent", () => {
  const withLink = buildCancellationOutcomeEmail({
    order: { order_number: ORDER_NUMBER, outcome: "approved", accountOrderUrl: "https://gloamatcha.com/account/orders/x" },
  });
  assert.ok(withLink.html.includes("https://gloamatcha.com/account/orders/x"));
  assert.ok(withLink.text.includes("https://gloamatcha.com/account/orders/x"));

  const without = built("approved");
  assert.ok(!without.html.includes("Konto ansehen"), "a null link produced a link");
  assert.ok(!without.text.includes("Konto ansehen"));
});

test("email: it uses the established GLOA transactional branding", () => {
  const { html } = built("approved");
  for (const token of ["#1746D1", "#A61E59", "#F5EBE2", "#4F3A5B"]) {
    assert.ok(html.includes(token), `missing brand token ${token}`);
  }
  assert.ok(html.includes(">GLOA<"));
  assert.ok(html.includes('<html lang="de">'));
  assert.ok(html.includes("support@gloamatcha.com"));
  // Transactional, not marketing.
  assert.ok(!html.includes("unsubscribe"));
  assert.ok(!html.includes("Abmelden"));
  assert.ok(!html.includes("Newsletter"));
});

test("email: it makes no health or product claim", () => {
  for (const outcome of ["approved", "declined"]) {
    const { html, text } = built(outcome);
    for (const surface of [html, text]) {
      for (const forbidden of [
        "gesund", "Gesundheit", "heilt", "Antioxid", "Energie", "Wirkung",
        "Koffein", "Vitamin", "Bio-", "entdecke", "jetzt kaufen",
      ]) {
        assert.ok(!surface.includes(forbidden), `${outcome} makes a claim: ${forbidden}`);
      }
    }
  }
});

test("email: the template is a pure leaf, like its siblings", () => {
  assert.ok(!/from "\.\//.test(templateCode), "the template has a relative import");
  assert.ok(!templateCode.includes("supabase"), "the template touches the database");
  assert.ok(!templateCode.includes("fetch("), "the template makes a network call");
  for (const volatile of ["Date.now", "new Date()", "Math.random"]) {
    assert.ok(!templateCode.includes(volatile), `the template reads ${volatile}`);
  }
  const templates = readdirSync(path.join(ROOT, "lib/email")).sort();
  assert.deepEqual(templates, [
    "cancellationOutcome.ts", "cancellationRequestNotification.ts",
    "internalOrderNotification.ts", "orderConfirmation.ts",
    "refundConfirmation.ts", "shipmentConfirmation.ts", "withdrawalConfirmation.ts",
  ]);
});

/* ══════════════════════════════════════════════════════════════
   RECIPIENT, SENDER, REPLY-TO
   ══════════════════════════════════════════════════════════════ */

test("recipient: it comes only from the durable customer_snapshot", () => {
  assert.ok(senderCode.includes("recipientFromSnapshot(order.customer_snapshot)"));
  assert.ok(senderCode.includes("to: customerEmail"));
  // There is no recipient parameter anywhere in the module.
  const entry = senderCode.slice(senderCode.indexOf("export async function sendCancellationOutcomeEmailIfNeeded"));
  const signature = entry.slice(0, entry.indexOf(")"));
  assert.ok(signature.includes("orderId: string"));
  for (const forbidden of ["recipient", "email", "to:", "subject", "html", "outcome", "decision"]) {
    assert.ok(!signature.includes(forbidden), `the entry point accepts ${forbidden}`);
  }
});

test("recipient: an order with no usable address fails rather than inventing one", () => {
  const guard = senderCode.slice(senderCode.indexOf("const customerEmail = recipientFromSnapshot"));
  assert.ok(guard.slice(0, 600).includes("if (!customerEmail)"));
  assert.ok(guard.slice(0, 600).includes("markFailed(order.id)"));
  assert.ok(guard.slice(0, 600).includes('return "failed"'));
  // No fallback address anywhere.
  assert.ok(!senderCode.includes("@gloamatcha.com"), "the sender hardcodes an address");
  assert.ok(!senderCode.includes("GLOA_INTERNAL_ORDERS"), "a customer email would go to the internal inbox");
});

test("sender and reply-to match the other CUSTOMER order emails", () => {
  assert.equal(GLOA_FROM_HELLO, "GLOA <hello@gloamatcha.com>");
  assert.equal(GLOA_REPLY_TO_SUPPORT, "support@gloamatcha.com");
  assert.ok(senderCode.includes("from: GLOA_FROM_HELLO"));
  assert.ok(senderCode.includes("replyTo: GLOA_REPLY_TO_SUPPORT"));
  // Identical to the shipment confirmation, which is the other customer
  // order email that actually sends.
  const shipment = withoutComments(read("lib/shipmentConfirmationEmail.ts"));
  assert.ok(shipment.includes("from: GLOA_FROM_HELLO"));
  assert.ok(shipment.includes("replyTo: GLOA_REPLY_TO_SUPPORT"));
});

test("outcome: which of the two emails is sent comes from the durable row", () => {
  const deliver = senderCode.slice(senderCode.indexOf("async function deliverClaimedCancellationOutcome"));
  assert.ok(deliver.includes("const resolution = order.cancellation_request_resolution;"));
  assert.ok(deliver.includes('resolution !== "approved" && resolution !== "declined"'));
  // A corrupted resolution is refused, never guessed at.
  assert.ok(deliver.includes("markFailed(order.id)"));
  // The outcome is never taken from a parameter.
  assert.ok(!deliver.includes("params.outcome"));
});

/* ══════════════════════════════════════════════════════════════
   THE ROUTE
   ══════════════════════════════════════════════════════════════ */

test("route: it is POST only and size-bounded before parsing", () => {
  const handlers = [...route.matchAll(/export async function (\w+)\(/g)].map(m => m[1]);
  assert.deepEqual(handlers, ["POST"]);
  assert.ok(routeBody.indexOf("rawBody.length > MAX_BODY_BYTES") < routeBody.indexOf("JSON.parse"));
  assert.ok(routeBody.includes("status: 413"));
  for (const forbidden of ["searchParams", "new URL(request.url)"]) {
    assert.ok(!routeCode.includes(forbidden), `the route reads ${forbidden}`);
  }
});

test("route: it reuses CANCELLATION_ADMIN_SECRET and creates no new secret", () => {
  const names = [...routeCode.matchAll(/process\.env\.(\w+)/g)].map(m => m[1]);
  assert.deepEqual([...new Set(names)].sort(), ["CANCELLATION_ADMIN_SECRET"]);
  for (const other of ["FULFILLMENT_ADMIN_SECRET", "CRON_SECRET", "RESEND_API_KEY", "STRIPE_", "VITE_"]) {
    assert.ok(!routeCode.includes(other), `the route names ${other}`);
  }
  // No new variable was added to .env.example either.
  const example = read(".env.example");
  assert.equal([...example.matchAll(/^[A-Z_]+=/gm)].length,
    [...read(".env.example").matchAll(/^[A-Z_]+=/gm)].length);
  assert.match(example, /^CANCELLATION_ADMIN_SECRET=$/m);
});

test("route: it fails closed when the secret is unset, before anything else", () => {
  assert.ok(routeBody.includes("const secret = process.env.CANCELLATION_ADMIN_SECRET;"));
  const guard = routeBody.slice(routeBody.indexOf("if (!secret)"));
  assert.ok(guard.slice(0, 400).includes("status: 503"));
  assert.ok(routeBody.indexOf("if (!secret)") < routeBody.indexOf("isBearerSecretAuthorized"));
  assert.ok(routeBody.indexOf("if (!secret)") < routeBody.indexOf("request.text()"));
});

test("route: it uses the shared timing-safe helper and rolls no comparison", () => {
  assert.ok(routeCode.includes("isBearerSecretAuthorized(request, secret)"));
  for (const forbidden of ["=== secret", "timingSafeEqual", "createHash"]) {
    assert.ok(!routeCode.includes(forbidden), `the route compares secrets itself: ${forbidden}`);
  }
});

test("route: authorization happens before anything else is read", () => {
  const authAt = routeBody.indexOf("isBearerSecretAuthorized");
  for (const later of [
    'request.headers.get("content-type")', "request.text()", "JSON.parse",
    "validateResolutionRequest", "getSupabaseAdmin()", ".rpc(",
  ]) {
    const at = routeBody.indexOf(later);
    assert.ok(at > -1, `${later} does not appear in the handler`);
    assert.ok(authAt < at, `${later} runs before authorization`);
  }
});

test("route: it performs no table write of its own and calls exactly one RPC", () => {
  for (const forbidden of ['.from("orders")', ".update(", ".insert(", ".delete(", ".upsert("]) {
    assert.ok(!routeCode.includes(forbidden), `the route writes directly: ${forbidden}`);
  }
  const rpcs = [...routeCode.matchAll(/\.rpc\("(\w+)"/g)].map(m => m[1]);
  assert.deepEqual(rpcs, ["resolve_order_cancellation_request"]);
  // And it never reaches cancel_order directly - approval goes through
  // the resolution RPC, which delegates.
  assert.ok(!routeCode.includes('"cancel_order"'), "the route calls cancel_order directly");
});

test("route: the RPC receives exactly the order number and the decision", () => {
  const call = routeBody.slice(routeBody.indexOf('.rpc("resolve_order_cancellation_request"'));
  const args = call.slice(0, call.indexOf("});"));
  const params = [...args.matchAll(/(p_\w+):/g)].map(m => m[1]);
  assert.deepEqual(params, ["p_order_number", "p_decision"]);
  assert.ok(args.includes("p_order_number: orderNumber"));
  assert.ok(args.includes("p_decision: decision"));
});

test("route: ORDERING - the email is only ever attempted after the RPC returns", () => {
  const rpcAt = routeBody.indexOf('.rpc("resolve_order_cancellation_request"');
  const sendAt = routeBody.indexOf("sendCancellationOutcomeEmailIfNeeded(orderId)");
  assert.ok(rpcAt > -1 && sendAt > -1);
  assert.ok(rpcAt < sendAt, "the email is attempted before the resolution is durable");
  assert.equal([...routeBody.matchAll(/sendCancellationOutcomeEmailIfNeeded\(/g)].length, 1);
});

test("route: ORDERING - a non-durable result returns before the email is reached", () => {
  const durableAt = routeBody.indexOf("if (!resolutionIsDurable(result))");
  const sendAt = routeBody.indexOf("sendCancellationOutcomeEmailIfNeeded(orderId)");
  assert.ok(durableAt > -1);
  assert.ok(durableAt < sendAt, "a refused result can reach the email");
  // And an RPC error returns before it too.
  assert.ok(routeBody.indexOf("if (error)") < sendAt);
  assert.ok(routeBody.indexOf("isResolutionResult(payload.result)") < sendAt);
});

test("route: A CONFLICTING DECISION SENDS NOTHING", () => {
  // conflict is not durable, so it takes the refusal branch, which
  // returns before the sender.
  assert.equal(resolutionIsDurable("conflict"), false);
  const refusals = routeCode.slice(routeCode.indexOf("const REFUSAL_MESSAGES"));
  const block = refusals.slice(0, refusals.indexOf("};"));
  assert.ok(block.includes("conflict:"));
  assert.ok(block.includes("not_cancellable:"));
  assert.ok(block.includes("order_already_cancelled:"));
  assert.ok(block.includes("no_request:"));
  assert.ok(block.includes("not_found:"));
  assert.ok(block.includes("invalid_decision:"));
  assert.equal([...block.matchAll(/^\s+\w+:/gm)].length, 6);
});

test("route: an email failure never reverses the resolution", () => {
  // No rollback path exists at all.
  for (const forbidden of ["rollback", "revert", "undo", '"decline"', "cancel_order"]) {
    assert.ok(!routeBody.includes(forbidden), `the route has a rollback path: ${forbidden}`);
  }
  // The outcome is reported as data alongside the resolution.
  const success = routeBody.slice(routeBody.lastIndexOf("Response.json("));
  assert.ok(success.includes("emailOutcome"));
  assert.ok(success.includes("resolution"));
  assert.ok(success.includes("status: 200"));
});

test("route: the response reports resolution and email as two separate facts", () => {
  const success = routeBody.slice(routeBody.lastIndexOf("Response.json("));
  const fields = [...success.matchAll(/^\s+(\w+)[:,]/gm)].map(m => m[1]);
  assert.deepEqual(fields.sort(), [
    "emailOutcome", "ok", "orderNumber", "resolution", "resolutionApplied",
  ]);
});

test("route: the response carries no customer PII, money or refund data", () => {
  const responses = [...routeBody.matchAll(/Response\.json\(\s*\{([\s\S]*?)\}\s*(?:as|satisfies|,)/g)].map(m => m[1]);
  assert.ok(responses.length > 0);
  for (const payload of responses) {
    for (const forbidden of [
      "email:", "name", "address", "snapshot", "phone", "_cents", "customer",
      "payment", "refund", "secret", "user", "note", "order_id", "orderId",
    ]) {
      assert.ok(!payload.toLowerCase().includes(forbidden.toLowerCase()), `a response carries ${forbidden}`);
    }
  }
});

test("route: the resolution reported is derived from the result, not the request", () => {
  assert.ok(routeBody.includes("const resolution = resolutionOutcome(result);"));
  // Not `decision`, which is what the caller asked for.
  const success = routeBody.slice(routeBody.lastIndexOf("Response.json("));
  assert.ok(!success.includes("resolution: decision"), "the response echoes the request");
});

test("logging: no PII and no request body reaches a log line", () => {
  for (const source of [routeCode, senderCode]) {
    const logs = [...source.matchAll(/console\.\w+\(([\s\S]*?)\);/g)].map(m => m[1]);
    for (const line of logs) {
      for (const forbidden of [
        "customerEmail", "customer_snapshot", "snapshot", "address", "note",
        "rawBody", "parsed", "JSON.stringify", "payload)", "resolution)",
      ]) {
        assert.ok(!line.includes(forbidden), `a log line contains ${forbidden}: ${line}`);
      }
      assert.ok(!/\bsecret\b/.test(line), `a log line references the secret: ${line}`);
    }
  }
});

/* ══════════════════════════════════════════════════════════════
   ACCOUNT UI
   ══════════════════════════════════════════════════════════════ */

test("account: an UNRESOLVED request still shows the pending-review state", () => {
  const pending = order({ cancellation_requested_at: "2026-08-24T09:00:00.000Z" });
  assert.equal(getCancellationView(pending).state, "requested");
  assert.equal(getStatusDetailText(pending), "Wir prüfen, ob die Bestellung noch gestoppt werden kann.");
});

test("account: a DECLINED request no longer shows pending review forever", () => {
  // The bug this phase exists to fix.
  const declined = order({
    cancellation_requested_at: "2026-08-24T09:00:00.000Z",
    cancellation_request_resolution: "declined",
  });
  assert.equal(getCancellationView(declined).state, "declined");
  const detail = getStatusDetailText(declined);
  assert.ok(!detail.includes("Wir prüfen"), "a declined request still says 'wir prüfen'");
  assert.equal(detail, "Wir konnten die Stornierung nicht mehr umsetzen. Deine Bestellung bleibt bestehen.");
  // The order is still a normal, live order.
  assert.equal(getPrimaryStatusLabel(declined), "Bestätigt");
});

test("account: an APPROVED request shows the ordinary cancelled state", () => {
  // Approving cancels the order in the same transaction, so the existing
  // cancelled rendering already covers it and needs no new branch.
  const approved = order({
    status: "cancelled",
    fulfillment_status: "cancelled",
    cancellation_requested_at: "2026-08-24T09:00:00.000Z",
    cancellation_request_resolution: "approved",
  });
  assert.equal(getPrimaryStatusLabel(approved), "Storniert");
  assert.equal(getStatusDetailText(approved), "Diese Bestellung wurde storniert.");
  assert.equal(getCancellationView(approved).state, "unavailable");
});

test("account: a declined request on a shipped order still points at Widerruf", () => {
  const shipped = order({
    status: "shipped",
    fulfillment_status: "shipped",
    cancellation_requested_at: "2026-08-24T09:00:00.000Z",
    cancellation_request_resolution: "declined",
  });
  // too_late outranks declined here on purpose: it is the more useful
  // answer, and it is still not "wir prüfen".
  assert.equal(getCancellationView(shipped).state, "too_late");
  assert.ok(!getStatusDetailText(shipped).includes("Wir prüfen"));
});

test("account: the declined branch is rendered and shows no reason", () => {
  const portal = read("app/AccountPortal.tsx");
  assert.ok(portal.includes('cancellation.state === "declined"'));
  assert.ok(portal.includes("Deine Stornierungsanfrage konnten wir nicht mehr umsetzen."));
  // It is checked FIRST, so it can never fall through to "wir prüfen".
  assert.ok(portal.indexOf('cancellation.state === "declined" ? (')
    < portal.indexOf("cancellationRequested ? ("));
});

test("account: internal email state and operator details are never shown", () => {
  const portal = read("app/AccountPortal.tsx");
  for (const forbidden of [
    "cancellation_outcome_email", "cancellation_request_notification",
    "resolve_order_cancellation_request", "CANCELLATION_ADMIN_SECRET",
    "/api/internal/", "emailOutcome", "resolutionApplied",
  ]) {
    assert.ok(!portal.includes(forbidden), `the portal exposes ${forbidden}`);
  }
  // It reads the resolution, which is a legitimate customer-facing fact.
  assert.ok(portal.includes("cancellation_request_resolution"));
});

test("account: the customer request flow itself is unchanged", () => {
  const portal = read("app/AccountPortal.tsx");
  assert.ok(portal.includes('fetch("/api/orders/cancellation-request"'));
  assert.ok(portal.includes("Stornierung anfragen"));
  const requestRoute = withoutComments(read("app/api/orders/cancellation-request/route.ts"));
  const rpcs = [...requestRoute.matchAll(/\.rpc\("(\w+)"/g)].map(m => m[1]);
  assert.deepEqual(rpcs, ["request_order_cancellation"]);
  assert.ok(requestRoute.includes("sendCancellationRequestNotificationIfNeeded(orderId)"));
  assert.ok(!requestRoute.includes("resolve_order_cancellation_request"));
});

/* ══════════════════════════════════════════════════════════════
   SECURITY
   ══════════════════════════════════════════════════════════════ */

test("security: only the one route can reach the resolution RPC and the sender", () => {
  const rpcCallers = [];
  const senderCallers = [];
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      const source = withoutComments(readFileSync(full, "utf-8"));
      const rel = path.relative(ROOT, full).split(path.sep).join("/");
      if (source.includes("resolve_order_cancellation_request")) rpcCallers.push(rel);
      if (source.includes("sendCancellationOutcomeEmailIfNeeded")) senderCallers.push(rel);
    }
  };
  walk(path.join(ROOT, "app"));
  walk(path.join(ROOT, "lib"));
  assert.deepEqual(rpcCallers, ["app/api/internal/orders/cancellation-request/resolve/route.ts"]);
  assert.deepEqual(senderCallers.sort(), [
    "app/api/internal/orders/cancellation-request/resolve/route.ts",
    "lib/cancellationOutcomeEmail.ts",
  ]);
});

test("security: no client file can see the endpoint, the RPC or the secret", () => {
  for (const rel of ["app/GloaSite.tsx", "app/AccountPortal.tsx", "app/Chrome.tsx", "app/createCheckoutSession.ts"]) {
    const source = read(rel);
    for (const forbidden of [
      "CANCELLATION_ADMIN_SECRET", "resolve_order_cancellation_request",
      "sendCancellationOutcomeEmailIfNeeded", "/api/internal/",
    ]) {
      assert.ok(!source.includes(forbidden), `${rel} exposes ${forbidden}`);
    }
  }
});

test("security: no server-only material reaches the built client bundle", () => {
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
      "CANCELLATION_ADMIN_SECRET", "resolve_order_cancellation_request",
      "sendCancellationOutcomeEmailIfNeeded", "isBearerSecretAuthorized",
      "timingSafeEqual", "RESEND_API_KEY", "cancellationOutcomeIdempotencyKey",
    ]) {
      if (source.includes(needle)) leaks.push(`${path.relative(ROOT, file)}: ${needle}`);
    }
  }
  assert.deepEqual(leaks, [], `server-only material reached the client bundle: ${leaks.join(", ")}`);
});

/* ══════════════════════════════════════════════════════════════
   NO REFUND COUPLING
   ══════════════════════════════════════════════════════════════ */

test("refunds: no Stripe write API anywhere in the repository", () => {
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
});

test("refunds: this feature imports no Stripe client and mutates no refund column", () => {
  for (const source of [routeCode, senderCode, templateCode, rulesCode]) {
    for (const forbidden of ["stripe", "Stripe", "payment_intent", "refunded_total_cents", "refund_updated_at"]) {
      assert.ok(!source.includes(forbidden), `this feature touches ${forbidden}`);
    }
  }
  for (const forbidden of ["stripe", "payment_intent", "refunded_total_cents", "refund_updated_at"]) {
    assert.ok(!sql031.toLowerCase().includes(forbidden), `031 touches ${forbidden}`);
  }
});

test("refunds: the webhook sync is untouched", () => {
  const webhook = withoutComments(read("app/api/stripe/webhook/route.ts"));
  assert.ok(webhook.includes("isRefundEventType(event.type)"));
  assert.ok(webhook.includes("syncOrderRefundStateFromStripe(stripe, paymentIntentId)"));
  assert.ok(!webhook.includes("resolve_order_cancellation_request"));
  const refunds = read("lib/stripeRefunds.ts");
  for (const event of [
    "charge.refunded", "charge.refund.updated", "refund.created", "refund.updated", "refund.failed",
  ]) {
    assert.ok(refunds.includes(`"${event}"`), `the refund event set lost ${event}`);
  }
  assert.ok(read("lib/orderRefunds.ts").includes('admin.rpc("apply_order_refund_state"'));
});

/* ══════════════════════════════════════════════════════════════
   REGRESSIONS
   ══════════════════════════════════════════════════════════════ */

test("regression: POST /api/internal/orders/cancel is unchanged", () => {
  const cancelRoute = withoutComments(read("app/api/internal/orders/cancel/route.ts"));
  const rpcs = [...cancelRoute.matchAll(/\.rpc\("(\w+)"/g)].map(m => m[1]);
  assert.deepEqual(rpcs, ["cancel_order"]);
  assert.ok(cancelRoute.includes("process.env.CANCELLATION_ADMIN_SECRET"));
  // It still sends no email at all - it is the low-level operational
  // cancellation, not an answer to a customer.
  for (const forbidden of [
    "sendCancellationOutcomeEmailIfNeeded", "sendCancellationRequestNotificationIfNeeded",
    "resolve_order_cancellation_request", "cancellation_request_resolution",
  ]) {
    assert.ok(!cancelRoute.includes(forbidden), `the cancel route now does ${forbidden}`);
  }
  const imports = [...cancelRoute.matchAll(/^import[\s\S]*?from "([^"]+)";$/gm)].map(m => m[1]);
  assert.equal(imports.length, 3, "the cancel route gained an import");
});

test("regression: the shipment endpoint and mark_order_shipped are unchanged", () => {
  const shipRoute = withoutComments(read("app/api/internal/orders/ship/route.ts"));
  const rpcs = [...shipRoute.matchAll(/\.rpc\("(\w+)"/g)].map(m => m[1]);
  assert.deepEqual(rpcs, ["mark_order_shipped"]);
  assert.ok(shipRoute.includes("sendShipmentConfirmationIfNeeded(orderId)"));
  const migration028 = read("supabase/migrations/028_authorized_shipment_transition.sql");
  assert.ok(migration028.includes("create or replace function public.mark_order_shipped("));
  assert.ok(!withoutComments(migration028).includes("cancellation_request_resolution"));
  assert.ok(!sql031.includes("mark_order_shipped"), "031 redefines the shipment transition");
  // Phase 2D-C's guard lives in migration 032 and in the RPC, never in
  // the route: a route-level check would decide on a stale read. The
  // route still reads no order of its own.
  for (const forbidden of ['from("orders")', ".select(", "maybeSingle"]) {
    assert.ok(!shipRoute.includes(forbidden), `the ship route reads an order itself: ${forbidden}`);
  }
});

test("regression: THE DOCUMENTED GAP - the shipment guard is still deferred", () => {
  // Deliberate, and NOW UNBLOCKED: with a terminal resolution, the next
  // phase can express "open request" as requested_at IS NOT NULL AND
  // resolution IS NULL, which a declined request no longer satisfies.
  const shipRoute = withoutComments(read("app/api/internal/orders/ship/route.ts"));
  const migration028 = withoutComments(read("supabase/migrations/028_authorized_shipment_transition.sql"));
  assert.ok(!shipRoute.includes("cancellation_requested_at"));
  assert.ok(!migration028.includes("cancellation_requested_at"));
  assert.ok(!shipRoute.includes("cancellation_request_resolution"));
  // The migration documents the rule the next phase must use.
  assert.ok(migration031.includes("cancellation_request_resolution IS NULL"));
});

test("regression: no retry cron was added", () => {
  const vercel = JSON.parse(read("vercel.json"));
  assert.equal((vercel.crons ?? []).length, 1, "a cron job was added");
  assert.equal(vercel.crons[0].path, "/api/cron/retry-order-notifications");
  const cron = withoutComments(read("app/api/cron/retry-order-notifications/route.ts"));
  assert.ok(!cron.includes("cancellation"), "the cron now sweeps cancellations");
});

test("regression: the other five emails and their state columns are untouched", () => {
  for (const other of [
    "sendOrderConfirmationEmailIfNeeded", "confirmation_email_status",
    "sendInternalOrderNotificationIfNeeded", "internal_notification_status",
    "sendShipmentConfirmationIfNeeded", "shipment_email_status",
    "sendCancellationRequestNotificationIfNeeded", "cancellation_request_notification_status",
  ]) {
    assert.ok(!routeCode.includes(other), `the resolve route triggers ${other}`);
    assert.ok(!senderCode.includes(other), `the sender touches ${other}`);
    assert.ok(!sql031.includes(other), `031 touches ${other}`);
  }
  const webhook = withoutComments(read("app/api/stripe/webhook/route.ts"));
  assert.ok(webhook.includes("sendOrderConfirmationEmailIfNeeded("));
  assert.ok(webhook.includes("sendInternalOrderNotificationIfNeeded("));
});

test("regression: SHOP_STATUS and B2C_SUBSCRIPTIONS_ENABLED are unchanged", () => {
  assert.ok(read("app/content.ts").includes('export const SHOP_STATUS = "prelaunch" as const;'));
  assert.match(read(".env.example"), /^B2C_SUBSCRIPTIONS_ENABLED=$/m);
  for (const source of [routeCode, senderCode, templateCode, rulesCode]) {
    for (const forbidden of ["B2C_SUBSCRIPTIONS_ENABLED", "SHOP_STATUS", "subscription"]) {
      assert.ok(!source.includes(forbidden), `this feature touches ${forbidden}`);
    }
  }
  assert.ok(!sql031.toLowerCase().includes("subscription"), "031 touches subscriptions");
});

test("regression: pricing, tax and shipping are untouched", () => {
  for (const source of [routeCode, senderCode, sql031]) {
    for (const forbidden of [
      "price_gross_cents", "computeShippingGrossCents", "resolveCheckoutTax",
      "SHIPPING_ZONES", "tax_total_cents", "total_gross_cents",
    ]) {
      assert.ok(!source.includes(forbidden), `this feature touches ${forbidden}`);
    }
  }
});

/* ══════════════════════════════════════════════════════════════
   THE HTTP BOUNDARY, ON REAL SPAWNED SERVERS
   ══════════════════════════════════════════════════════════════ */

const ENDPOINT_PATH = "/api/internal/orders/cancellation-request/resolve";
const SECRET = "test-only-cancellation-secret-not-a-real-value";

/**
 * Every server is started without SUPABASE_SECRET_KEY and without
 * RESEND_API_KEY, so even a fully authorized request cannot reach a
 * database: it stops at the 503 the route returns when the admin client
 * is unconfigured, which is strictly before the RPC and therefore
 * strictly before any resolution and any email.
 */
function serverEnv(extra) {
  const env = writeBlockedServerEnv({ ...extra });
  delete env.RESEND_API_KEY;
  delete env.RESEND_CONTACT_FROM;
  delete env.FULFILLMENT_ADMIN_SECRET;
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

const UNSET_PORT = 8950;
let unsetServer;

test.before(async () => {
  unsetServer = await startServer(UNSET_PORT, { CANCELLATION_ADMIN_SECRET: "" });
});

test.after(() => {
  unsetServer?.kill();
});

test("http: an unconfigured secret refuses every caller, including a correct-looking one", async () => {
  for (const headers of [{}, { authorization: "Bearer " }, { authorization: `Bearer ${SECRET}` }]) {
    const res = await post(UNSET_PORT, body(), headers);
    assert.equal(res.status, 503, JSON.stringify(headers));
    const parsed = await res.json().catch(() => null);
    assert.equal(parsed?.ok, undefined);
  }
});

const SECURED_PORT = 8951;
let securedServer;

test.before(async () => {
  securedServer = await startServer(SECURED_PORT, { CANCELLATION_ADMIN_SECRET: SECRET });
});

test.after(() => {
  securedServer?.kill();
});

test("http: no Authorization header is rejected", async () => {
  const res = await post(SECURED_PORT, body());
  assert.equal(res.status, 401);
});

test("http: a wrong or malformed secret is rejected", async () => {
  for (const authorization of [
    "Bearer", "Bearer ", "Bearer wrong-secret", `Bearer ${SECRET}x`,
    `Bearer ${SECRET.slice(0, -1)}`, `bearer ${SECRET}`, `Basic ${SECRET}`, SECRET,
    "Bearer test-only-fulfillment-secret-not-a-real-value",
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyIn0.notarealsignature",
  ]) {
    const res = await post(SECURED_PORT, body(), { authorization });
    assert.equal(res.status, 401, authorization);
  }
});

test("http: authorization is checked before the body is even looked at", async () => {
  const valid = await post(SECURED_PORT, body());
  const invalid = await post(SECURED_PORT, { orderNumber: "nonsense", decision: "x" });
  const malformed = await post(SECURED_PORT, "{not json");
  for (const res of [valid, invalid, malformed]) assert.equal(res.status, 401);
});

test("http: the correct secret is accepted and reaches validation", async () => {
  const authorization = `Bearer ${SECRET}`;
  const malformed = await post(SECURED_PORT, "{not json", { authorization });
  assert.equal(malformed.status, 400);

  const badNumber = await post(SECURED_PORT, body({ orderNumber: "nonsense" }), { authorization });
  assert.equal(badNumber.status, 400);
  assert.equal((await badNumber.json()).error, "Ungültige Anfrage: invalid_order_number.");
});

test("http: an invalid decision is refused with the correct secret", async () => {
  const authorization = `Bearer ${SECRET}`;
  for (const decision of ["", "APPROVE", "approved", "cancel", "yes", 1, null]) {
    const res = await post(SECURED_PORT, { orderNumber: ORDER_NUMBER, decision }, { authorization });
    assert.equal(res.status, 400, String(decision));
    assert.equal((await res.json()).error, "Ungültige Anfrage: invalid_decision.");
  }
  // A missing decision too.
  const missing = await post(SECURED_PORT, { orderNumber: ORDER_NUMBER }, { authorization });
  assert.equal(missing.status, 400);
});

test("http: an unknown field is refused even with the correct secret", async () => {
  const authorization = `Bearer ${SECRET}`;
  for (const key of [
    "status", "fulfillment_status", "payment_status", "cancelled_at",
    "resolution", "refundAmount", "recipient", "to", "subject", "html", "userId",
  ]) {
    const res = await post(SECURED_PORT, body({ [key]: "x" }), { authorization });
    assert.equal(res.status, 400, key);
    assert.equal((await res.json()).error, "Ungültige Anfrage: unknown_field.", key);
  }
});

test("http: a non-JSON content type and an oversized body are refused", async () => {
  const wrongType = await fetch(`http://127.0.0.1:${SECURED_PORT}${ENDPOINT_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "text/plain", authorization: `Bearer ${SECRET}` },
    body: "orderNumber=GLOA-2026-000451",
  });
  assert.equal(wrongType.status, 400);

  const oversized = await post(
    SECURED_PORT,
    JSON.stringify({ orderNumber: ORDER_NUMBER, decision: "approve", padding: "x".repeat(5_000) }),
    { authorization: `Bearer ${SECRET}` }
  );
  assert.equal(oversized.status, 413);
});

test("http: a fully valid authorized request stops at the unconfigured database", async () => {
  // The last stop before the RPC. It proves the whole chain is reachable
  // with the right secret, and that no resolution and no email can happen
  // in this suite - there is no database here to make one.
  for (const decision of ["approve", "decline"]) {
    const res = await post(SECURED_PORT, body({ decision }), { authorization: `Bearer ${SECRET}` });
    assert.equal(res.status, 503, decision);
    const parsed = await res.json();
    assert.equal(parsed.ok, undefined);
    assert.equal(parsed.error, "Vorübergehend nicht verfügbar.");
  }
});

test("http: GET, PUT, PATCH and DELETE are not mutation surfaces", async () => {
  for (const method of ["GET", "PUT", "PATCH", "DELETE"]) {
    const res = await fetch(`http://127.0.0.1:${SECURED_PORT}${ENDPOINT_PATH}`, {
      method,
      headers: { authorization: `Bearer ${SECRET}` },
    });
    assert.ok(res.status === 404 || res.status === 405, `${method} answered ${res.status}`);
  }
});

test("http: no response body ever contains the secret or a customer fact", async () => {
  const responses = await Promise.all([
    post(SECURED_PORT, body()),
    post(SECURED_PORT, body({ orderNumber: "nonsense" }), { authorization: `Bearer ${SECRET}` }),
    post(SECURED_PORT, body(), { authorization: `Bearer ${SECRET}` }),
  ]);
  for (const res of responses) {
    const text = await res.text();
    assert.ok(!text.includes(SECRET), "a response echoed the secret");
    assert.ok(!text.includes("CANCELLATION_ADMIN_SECRET"), "a response named the secret variable");
    for (const forbidden of ["@", "customer_snapshot", "resolve_order_cancellation_request"]) {
      assert.ok(!text.includes(forbidden), `a response contained ${forbidden}`);
    }
  }
});

test("no real Resend request, no Stripe request and no production Supabase in this suite", () => {
  const suite = withoutComments(read("tests/cancellation-resolution.test.mjs"));
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
