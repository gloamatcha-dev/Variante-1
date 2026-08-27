import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeBlockedServerEnv } from "./helpers/testSupabase.mjs";
import {
  ALLOWED_BODY_KEYS,
  CADENCE_DAYS,
  CADENCE_MS,
  CANCELLABLE_STATUSES,
  CANCELLATION_CUTOFF_DAYS,
  CANCEL_RESULTS,
  DEFERRED_SWEEP_LIMIT,
  CUTOFF_OFFSET_MS,
  cancelResultIsDurable,
  cancellationDelivery,
  deferredCancelIdempotencyKey,
  deferredCancellationIsDue,
  schedulesAtStripeNow,
  cancelResultStatus,
  cancelWasNewlyScheduled,
  isCancelResult,
  isCancellableStatus,
  resolveCancellationSchedule,
  subscriptionCancelIdempotencyKey,
  toStripeTimestamp,
  validateCancelRequest,
} from "../lib/subscriptionCancellationRules.ts";
import {
  PLAN_BILLING_INTERVAL_COUNT,
  PLAN_BILLING_INTERVAL_UNIT,
} from "../lib/subscriptionCheckoutRules.ts";

// SAFE DEFAULT SUITE: pure cutoff arithmetic, source-level checks against
// the migration and the service, and a real spawned server started
// WITHOUT a Supabase service-role key and WITHOUT a Stripe key. No
// database is reachable, no Stripe API is called, no subscription is
// cancelled, no order is touched and no email is sent. Nothing here
// executes SQL.
//
// The rules this suite protects: the 14-day boundary is exact and
// UTC-safe, a late cancellation honours one further cycle, a customer can
// only end their own subscription, scheduling is never the same thing as
// cancelling, and nothing about the cadence is ever monthly.

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf-8");
const NEWLINE = String.fromCharCode(10);

const MIGRATIONS = path.join(ROOT, "supabase/migrations");
const route = read("app/api/subscriptions/cancel/route.ts");
const service = read("lib/subscriptionCancellation.ts");
const rules = read("lib/subscriptionCancellationRules.ts");
const webhook = read("app/api/stripe/webhook/route.ts");
const migration034 = read("supabase/migrations/034_subscription_cancellation.sql");

/**
 * Code only. Block comments are removed first: both modules carry long
 * prose that deliberately NAMES the mechanisms they do not use
 * (cancel_at_period_end, monthly, pause), and a scan that read those
 * would report the avoidance as a violation of itself.
 */
const withoutComments = source => source
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split(NEWLINE)
  .filter(line => {
    const t = line.trim();
    return !t.startsWith("--") && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
  })
  .join(NEWLINE);

const routeCode = withoutComments(route);
const routeBody = routeCode.slice(routeCode.indexOf("export async function POST"));
const serviceCode = withoutComments(service);
const rulesCode = withoutComments(rules);
const webhookCode = withoutComments(webhook);
const sql034 = withoutComments(migration034);

/** Every `update public.subscriptions ... set <cols> where id = v_sub.id`. */
const updateSetClauses = sql =>
  [...sql.matchAll(/update public\.subscriptions\s+set([\s\S]*?)where id = v_sub\.id/g)].map(m => m[1]);

/** The column names assigned in one such SET clause, sorted. */
const columnsWritten = clause =>
  [...clause.matchAll(/^\s*(?:set\s+)?(\w+)\s*=/gm)].map(m => m[1]).sort();

const fnBody = (name, next) => sql034.slice(
  sql034.indexOf(`create or replace function public.${name}`),
  next ? sql034.indexOf(`create or replace function public.${next}`) : undefined
);

const scheduleFn = fnBody("schedule_subscription_cancellation", "apply_deferred_subscription_cancellation");
const applyFn = fnBody("apply_deferred_subscription_cancellation", "sync_subscription_from_stripe");
const syncFn = fnBody("sync_subscription_from_stripe", "mark_subscription_cancelled");
const scheduleWrites = updateSetClauses(scheduleFn);

/** One `if <head> ... end if;` branch, code only. */
const branch = (src, head) => {
  const at = src.indexOf(head);
  assert.ok(at > -1, `branch not found: ${head}`);
  const end = src.indexOf("end if;", at);
  assert.ok(end > -1, `unterminated branch: ${head}`);
  return src.slice(at, end);
};

const updatedHandler = (() => {
  const at = webhookCode.indexOf("async function handleSubscriptionUpdated");
  return webhookCode.slice(at, webhookCode.indexOf("async function handleSubscriptionDeleted", at));
})();

const SUB_ID = "11111111-2222-3333-4444-555555555555";
const PERIOD_END = "2026-09-24T10:00:00.000Z";
const CUTOFF = "2026-09-10T10:00:00.000Z"; // PERIOD_END - 14 days
const LATE_END = "2026-10-22T10:00:00.000Z"; // PERIOD_END + 28 days

const schedule = requestAt =>
  resolveCancellationSchedule({ requestAt, currentPeriodEnd: PERIOD_END });

/* ══════════════════════════════════════════════════════════════
   THE CADENCE IS 28 DAYS, NEVER A MONTH
   ══════════════════════════════════════════════════════════════ */

test("cadence: 28 days and 14 days, agreeing with the checkout constants", () => {
  assert.equal(CADENCE_DAYS, 28);
  assert.equal(CANCELLATION_CUTOFF_DAYS, 14);
  assert.equal(CADENCE_MS, 28 * 24 * 60 * 60 * 1000);
  assert.equal(CUTOFF_OFFSET_MS, 14 * 24 * 60 * 60 * 1000);
  // The same cadence the checkout module and migration 024 use.
  assert.equal(PLAN_BILLING_INTERVAL_UNIT, "week");
  assert.equal(PLAN_BILLING_INTERVAL_COUNT, 4);
  assert.equal(PLAN_BILLING_INTERVAL_COUNT * 7, CADENCE_DAYS);
});

test("cadence: NO calendar arithmetic anywhere in the rules", () => {
  // A month is not 28 days, and adding one to 31 January is ambiguous.
  // Every computation is epoch milliseconds.
  for (const forbidden of [
    "setMonth", "getMonth", "setDate", "getDate", "setFullYear",
    "addMonths", "monthly", "Monat",
  ]) {
    assert.ok(!rulesCode.includes(forbidden), `the rules use calendar arithmetic: ${forbidden}`);
  }
  for (const source of [routeCode, serviceCode]) {
    for (const forbidden of ["setMonth", "getMonth", "monthly", "Monat"]) {
      assert.ok(!source.includes(forbidden), `calendar arithmetic leaked: ${forbidden}`);
    }
  }
  assert.ok(!sql034.toLowerCase().includes("month"), "034 mentions months");
});

/* ══════════════════════════════════════════════════════════════
   THE BOUNDARY, TO THE MILLISECOND
   ══════════════════════════════════════════════════════════════ */

test("cutoff: it is exactly 14 days before the next billing", () => {
  const result = schedule("2026-09-01T00:00:00.000Z");
  assert.equal(result.ok, true);
  assert.equal(result.schedule.cutoffAt, CUTOFF);
  assert.equal(result.schedule.nextBillingAt, PERIOD_END);
});

test("BOUNDARY: exactly 14 days before is EARLY (inclusive)", () => {
  const result = schedule(CUTOFF);
  assert.equal(result.schedule.timing, "early");
  assert.equal(result.schedule.effectiveCancelAt, PERIOD_END);
});

test("BOUNDARY: one millisecond before the cutoff is EARLY", () => {
  const result = schedule(new Date(Date.parse(CUTOFF) - 1).toISOString());
  assert.equal(result.schedule.timing, "early");
  assert.equal(result.schedule.effectiveCancelAt, PERIOD_END);
});

test("BOUNDARY: one millisecond AFTER the cutoff is LATE", () => {
  const result = schedule(new Date(Date.parse(CUTOFF) + 1).toISOString());
  assert.equal(result.schedule.timing, "late");
  assert.equal(result.schedule.effectiveCancelAt, LATE_END);
});

test("BOUNDARY: one second after the cutoff is LATE", () => {
  const result = schedule(new Date(Date.parse(CUTOFF) + 1000).toISOString());
  assert.equal(result.schedule.timing, "late");
});

test("BOUNDARY: 13 days 23:59:59 before next billing is LATE", () => {
  const at = Date.parse(PERIOD_END) - (13 * 24 * 60 * 60 * 1000 + 23 * 3600 * 1000 + 59 * 60000 + 59000);
  const result = schedule(new Date(at).toISOString());
  assert.equal(result.schedule.timing, "late");
  assert.equal(result.schedule.effectiveCancelAt, LATE_END);
});

test("BOUNDARY: 14 days and 1 second before next billing is EARLY", () => {
  const at = Date.parse(PERIOD_END) - (CUTOFF_OFFSET_MS + 1000);
  const result = schedule(new Date(at).toISOString());
  assert.equal(result.schedule.timing, "early");
  assert.equal(result.schedule.effectiveCancelAt, PERIOD_END);
});

test("EARLY: the upcoming cycle does not happen", () => {
  const result = schedule("2026-08-27T09:00:00.000Z");
  assert.equal(result.schedule.timing, "early");
  assert.equal(result.schedule.effectiveCancelAt, PERIOD_END, "early ends at the next billing");
});

test("LATE: the upcoming cycle happens, then it ends 28 days later", () => {
  const result = schedule("2026-09-20T09:00:00.000Z");
  assert.equal(result.schedule.timing, "late");
  assert.equal(result.schedule.effectiveCancelAt, LATE_END);
  assert.equal(
    Date.parse(LATE_END) - Date.parse(PERIOD_END),
    CADENCE_MS,
    "the extra cycle is not exactly 28 days"
  );
});

test("UTC: the result is identical whatever the input timezone offset says", () => {
  // Same instant, three notations.
  const instants = [
    "2026-09-20T09:00:00.000Z",
    "2026-09-20T11:00:00.000+02:00",
    "2026-09-20T04:00:00.000-05:00",
  ];
  const outputs = instants.map(at => schedule(at).schedule);
  for (const out of outputs) {
    assert.equal(out.timing, outputs[0].timing);
    assert.equal(out.effectiveCancelAt, outputs[0].effectiveCancelAt);
    assert.equal(out.cutoffAt, outputs[0].cutoffAt);
  }
  // And a Date object gives the same answer as its ISO string.
  assert.deepEqual(
    resolveCancellationSchedule({ requestAt: new Date(instants[0]), currentPeriodEnd: PERIOD_END }).schedule,
    outputs[0]
  );
});

test("UTC: a DST boundary does not change the 28-day distance", () => {
  // European DST ends 25 October 2026. A period ending after it, measured
  // from before it, must still be exactly 28 * 24 hours.
  const end = "2026-11-05T02:30:00.000Z";
  const result = resolveCancellationSchedule({ requestAt: "2026-11-01T00:00:00.000Z", currentPeriodEnd: end });
  assert.equal(result.schedule.timing, "late");
  assert.equal(Date.parse(result.schedule.effectiveCancelAt) - Date.parse(end), CADENCE_MS);
  assert.equal(Date.parse(end) - Date.parse(result.schedule.cutoffAt), CUTOFF_OFFSET_MS);
});

test("cutoff: a missing or unparseable period end fails closed", () => {
  for (const bad of [null, undefined, "", "not-a-date"]) {
    const result = resolveCancellationSchedule({ requestAt: "2026-09-01T00:00:00.000Z", currentPeriodEnd: bad });
    assert.equal(result.ok, false, String(bad));
    assert.equal(result.reason, "invalid_period_end");
  }
  const badRequest = resolveCancellationSchedule({ requestAt: "nope", currentPeriodEnd: PERIOD_END });
  assert.equal(badRequest.ok, false);
  assert.equal(badRequest.reason, "invalid_request_time");
});

test("cutoff: Stripe gets whole seconds, never milliseconds", () => {
  assert.equal(toStripeTimestamp(PERIOD_END), Math.floor(Date.parse(PERIOD_END) / 1000));
  assert.ok(Number.isInteger(toStripeTimestamp(PERIOD_END)));
});

/* ══════════════════════════════════════════════════════════════
   INPUT VALIDATION
   ══════════════════════════════════════════════════════════════ */

test("input: the allow-list is exactly one key", () => {
  assert.deepEqual([...ALLOWED_BODY_KEYS], ["subscriptionId"]);
});

test("input: a valid body normalizes to one subscription id", () => {
  const result = validateCancelRequest({ subscriptionId: SUB_ID });
  assert.equal(result.ok, true);
  assert.deepEqual(result.request, { subscriptionId: SUB_ID });
});

test("input: a non-object or malformed id is rejected", () => {
  for (const bad of [null, undefined, "x", 42, true, []]) {
    assert.equal(validateCancelRequest(bad).ok, false, JSON.stringify(bad));
  }
  for (const bad of ["", "   ", "not-a-uuid", "1234", 42, null, {}, "DROP TABLE subscriptions"]) {
    const result = validateCancelRequest({ subscriptionId: bad });
    assert.equal(result.ok, false, String(bad));
    assert.equal(result.code, "invalid_subscription_id", String(bad));
  }
});

test("input: THE BROWSER CANNOT SUPPLY ANY OF THE DECIDING FACTS", () => {
  for (const key of [
    "userId", "user_id", "email", "stripeCustomerId", "stripeSubscriptionId",
    "nextBilling", "cutoff", "cutoffAt", "cancelAt", "cancel_at", "effectiveCancelAt",
    "timing", "price", "plan", "planId", "status", "requestAt", "now", "quantity",
  ]) {
    const result = validateCancelRequest({ subscriptionId: SUB_ID, [key]: "x" });
    assert.equal(result.ok, false, key);
    assert.equal(result.code, "unknown_field", key);
  }
});

/* ══════════════════════════════════════════════════════════════
   RESULT VOCABULARY
   ══════════════════════════════════════════════════════════════ */

test("results: the vocabulary matches what migration 034 returns", () => {
  assert.deepEqual([...CANCEL_RESULTS].sort(), [
    "already_scheduled", "conflict", "not_eligible", "not_found", "period_moved", "scheduled",
  ]);
  for (const result of CANCEL_RESULTS) {
    assert.ok(sql034.includes(`'${result}'`), `034 never returns ${result}`);
  }
});

test("results: only scheduled and already_scheduled confirm a cancellation", () => {
  assert.equal(cancelResultIsDurable("scheduled"), true);
  assert.equal(cancelResultIsDurable("already_scheduled"), true);
  for (const refused of ["conflict", "not_found", "not_eligible", "period_moved"]) {
    assert.equal(cancelResultIsDurable(refused), false, refused);
  }
  assert.equal(cancelWasNewlyScheduled("scheduled"), true);
  assert.equal(cancelWasNewlyScheduled("already_scheduled"), false);
});

test("results: a CONFLICT never confirms a date nobody asked for", () => {
  assert.equal(cancelResultIsDurable("conflict"), false);
  assert.equal(cancelResultStatus("conflict"), 409);
});

test("results: each maps to a sensible HTTP status", () => {
  assert.equal(cancelResultStatus("scheduled"), 200);
  assert.equal(cancelResultStatus("already_scheduled"), 200);
  assert.equal(cancelResultStatus("not_found"), 404);
  assert.equal(cancelResultStatus("not_eligible"), 409);
  assert.equal(cancelResultStatus("period_moved"), 409);
  for (const bad of ["cancelled", "", null, 42, {}]) {
    assert.equal(isCancelResult(bad), false, JSON.stringify(bad));
  }
});

test("states: exactly active, past_due and unpaid may be cancelled", () => {
  assert.deepEqual([...CANCELLABLE_STATUSES], ["active", "past_due", "unpaid"]);
  for (const ok of CANCELLABLE_STATUSES) assert.equal(isCancellableStatus(ok), true, ok);
  for (const no of ["pending", "paused", "cancelled", null, undefined, ""]) {
    assert.equal(isCancellableStatus(no), false, String(no));
  }
  // Every value named exists in migration 022's vocabulary.
  const m022 = read("supabase/migrations/022_recurring_subscription_foundation.sql");
  for (const value of ["pending", "active", "paused", "cancelled", "past_due", "unpaid"]) {
    assert.ok(m022.includes(`'${value}'`), `invented status: ${value}`);
  }
  // And the RPC agrees.
  assert.ok(sql034.includes("if v_sub.status not in ('active', 'past_due', 'unpaid') then"));
});

/* ══════════════════════════════════════════════════════════════
   STRIPE IDEMPOTENCY
   ══════════════════════════════════════════════════════════════ */

test("idempotency: the key carries the subscription AND the effective date", () => {
  const key = subscriptionCancelIdempotencyKey(SUB_ID, PERIOD_END);
  assert.equal(key, `gloa/subscription-cancel/${SUB_ID}/${toStripeTimestamp(PERIOD_END)}`);
  // Same decision, same key - so a retry cannot schedule twice.
  assert.equal(key, subscriptionCancelIdempotencyKey(SUB_ID, PERIOD_END));
  // Different decision, different key - so Stripe cannot paper over a
  // genuinely different end date.
  assert.notEqual(key, subscriptionCancelIdempotencyKey(SUB_ID, LATE_END));
  assert.notEqual(key, subscriptionCancelIdempotencyKey("99999999-8888-7777-6666-555555555555", PERIOD_END));
});

test("idempotency: no PII and no volatile input", () => {
  const key = subscriptionCancelIdempotencyKey(SUB_ID, PERIOD_END);
  for (const forbidden of ["@", "kundin", "example.com", "cus_", "sub_"]) {
    assert.ok(!key.includes(forbidden), `the key contains ${forbidden}`);
  }
  const fn = rulesCode.slice(rulesCode.indexOf("export function subscriptionCancelIdempotencyKey"));
  const body = fn.slice(0, fn.indexOf("\n}"));
  for (const volatile of ["Date.now", "random", "Math."]) {
    assert.ok(!body.includes(volatile), `the key uses ${volatile}`);
  }
});

test("idempotency: it cannot collide with any other GLOA namespace", () => {
  const key = subscriptionCancelIdempotencyKey(SUB_ID, PERIOD_END);
  assert.match(key, /^gloa\/subscription-cancel\/[0-9a-f-]{36}\/\d+$/);
  for (const other of ["gloa/refund/", "gloa/shipment/", "gloa/cancellation-outcome/", "gloa/internal-order/"]) {
    assert.ok(!key.startsWith(other));
  }
});

test("idempotency: every Stripe write carries a key, and the keys cannot collide", () => {
  // TWO writes since Phase 3C.2: the request-time one (early only) and
  // the renewal-time one that applies a deferred late cancellation.
  const updates = [...serviceCode.matchAll(/stripe\.subscriptions\.update\(/g)];
  assert.equal(updates.length, 2, "unexpected number of Stripe subscription writes");
  assert.ok(serviceCode.includes("subscriptionCancelIdempotencyKey(\n            subscription.id,"));
  assert.ok(serviceCode.includes("deferredCancelIdempotencyKey(row.id, effectiveCancelAt)"));
  // Neither call may reach Stripe without one.
  for (const update of updates) {
    const call = serviceCode.slice(update.index, serviceCode.indexOf("}\n    );", update.index));
    assert.ok(call.includes("idempotencyKey"), "a Stripe write has no idempotency key");
  }
  // Distinct namespaces, so the two can never collide on one subscription.
  assert.ok(rulesCode.includes("gloa/subscription-cancel/"));
  assert.ok(rulesCode.includes("gloa/subscription-defer/"));
  assert.equal(
    subscriptionCancelIdempotencyKey(SUB_ID, LATE_END) === deferredCancelIdempotencyKey(SUB_ID, LATE_END),
    false,
    "the two idempotency keys collide"
  );
});

/* ══════════════════════════════════════════════════════════════
   THE STRIPE WRITE
   ══════════════════════════════════════════════════════════════ */

test("stripe: cancel_at is genuinely supported by the installed SDK", () => {
  // Verified against the real type declarations, not from memory.
  const decl = readFileSync(
    path.join(ROOT, "node_modules/stripe/cjs/resources/Subscriptions.d.ts"), "utf-8"
  );
  const updateParams = decl.slice(
    decl.indexOf("interface SubscriptionUpdateParams {"),
    decl.indexOf("namespace SubscriptionUpdateParams")
  );
  assert.ok(updateParams.includes("cancel_at?:"), "SDK has no cancel_at on update");
  assert.ok(updateParams.includes("proration_behavior?:"), "SDK has no proration_behavior");
  assert.ok(decl.includes("'always_invoice' | 'create_prorations' | 'none'"), "no ProrationBehavior union");
  assert.ok(decl.includes("update(id: string, params?: SubscriptionUpdateParams, options?: RequestOptions)"));
  const lib = readFileSync(path.join(ROOT, "node_modules/stripe/cjs/lib.d.ts"), "utf-8");
  assert.ok(lib.includes("idempotencyKey?: string;"), "RequestOptions has no idempotencyKey");
});

test("stripe: it sets cancel_at and pins proration, and nothing else", () => {
  const call = serviceCode.slice(serviceCode.indexOf("stripe.subscriptions.update("));
  const params = call.slice(0, call.indexOf("idempotencyKey"));
  assert.ok(params.includes("cancel_at: toStripeTimestamp(schedule.effectiveCancelAt)"));
  assert.ok(params.includes('proration_behavior: "none"'));
  // Nothing else may be touched.
  for (const forbidden of [
    "items", "price", "quantity", "metadata", "customer", "default_payment_method",
    "billing_cycle_anchor", "trial", "cancel_at_period_end", "shipping",
  ]) {
    assert.ok(!params.includes(forbidden), `the Stripe update also sets ${forbidden}`);
  }
});

test("stripe: it NEVER cancels or deletes immediately", () => {
  for (const forbidden of [
    "subscriptions.cancel(", "subscriptions.del(", "subscriptions.delete(",
  ]) {
    assert.ok(!serviceCode.includes(forbidden), `the service performs: ${forbidden}`);
  }
  // Only retrieve and update.
  const calls = [...serviceCode.matchAll(/stripe\.subscriptions\.(\w+)\(/g)].map(m => m[1]);
  assert.deepEqual([...new Set(calls)].sort(), ["retrieve", "update"]);
});

test("stripe: cancel_at_period_end is deliberately never used", () => {
  // It cannot express the late case, and setting it would be misleading.
  for (const source of [serviceCode, routeCode, rulesCode]) {
    assert.ok(!source.includes("cancel_at_period_end"), "cancel_at_period_end is used");
  }
  const setClauses = [...sql034.matchAll(/update public\.subscriptions\s+set([\s\S]*?)where id = v_sub\.id/g)].map(m => m[1]).join(" ");
  assert.ok(!setClauses.includes("cancel_at_period_end"), "034 writes cancel_at_period_end");
});

/* ══════════════════════════════════════════════════════════════
   ORDERING AND THE TWO FAILURE WINDOWS
   ══════════════════════════════════════════════════════════════ */

test("ORDERING: Stripe is written BEFORE the database, never after", () => {
  const stripeAt = serviceCode.indexOf("stripe.subscriptions.update(");
  const rpcAt = serviceCode.indexOf('admin.rpc("schedule_subscription_cancellation"');
  assert.ok(stripeAt > -1 && rpcAt > -1);
  assert.ok(stripeAt < rpcAt, "the database is written before Stripe accepts");
});

test("STRIPE FAILS: nothing is persisted and no success is reported", () => {
  const block = serviceCode.slice(serviceCode.indexOf("stripe.subscriptions.update("));
  const catchBlock = block.slice(block.indexOf("} catch"), block.indexOf("admin.rpc("));
  assert.ok(catchBlock.includes('return { ok: false, result: "error" }'));
  // The failure returns before the RPC is reached.
  assert.ok(block.indexOf('return { ok: false, result: "error" }') < block.indexOf("admin.rpc("));
});

test("STRIPE SUCCEEDS, DB FAILS: reconcile-before-write stops a second schedule", () => {
  // The service retrieves Stripe first and adopts an existing future
  // cancel_at verbatim rather than recomputing. Without this, a retry
  // after a period roll would extend a LATE cancellation by another cycle
  // every time.
  const retrieveAt = serviceCode.indexOf("stripe.subscriptions.retrieve(");
  const existingAt = serviceCode.indexOf("const existingCancelAt");
  const updateAt = serviceCode.indexOf("stripe.subscriptions.update(");
  assert.ok(retrieveAt < existingAt && existingAt < updateAt);
  assert.ok(serviceCode.includes("if (deliverNow && !existingCancelAt) {"),
    "the update is not skipped when already scheduled");
  // An existing Stripe cancellation overrides the timing: Stripe holds it
  // NOW, so there is nothing left to defer.
  assert.ok(serviceCode.includes("Boolean(existingCancelAt) || schedulesAtStripeNow(schedule.timing)"));
  assert.ok(serviceCode.includes("effectiveCancelAt: existingCancelAt"), "an existing schedule is not adopted");
});

test("STRIPE SUCCEEDS, DB FAILS: the webhook self-heals the local row", () => {
  assert.ok(webhookCode.includes('event.type === "customer.subscription.updated"'));
  assert.ok(webhookCode.includes("handleSubscriptionUpdated(stripe, event)"));
  assert.ok(serviceCode.includes('admin.rpc("sync_subscription_from_stripe"'));
  // The sync writes cancel_at, which is the fact that was lost.
  assert.ok(sql034.includes("cancel_at                = p_cancel_at"));
});

/* ══════════════════════════════════════════════════════════════
   PHASE 3C.1 - THE RECONCILIATION RACE

   The ordering that forced this: the route writes to Stripe first,
   Stripe emits customer.subscription.updated for that very change, and
   that webhook can reach this system BEFORE the HTTP request persists
   the customer's request. sync_subscription_from_stripe then writes
   cancel_at while cancellation_requested_at stays NULL - Stripe has no
   idea when a customer asked. Before the fix the route's RPC saw a
   matching cancel_at, answered already_scheduled with zero writes, and
   the fact that an authenticated customer requested the cancellation was
   lost permanently.
   ══════════════════════════════════════════════════════════════ */

test("RACE 1 (CASE A): nothing standing yet writes all three columns", () => {
  assert.deepEqual(columnsWritten(scheduleWrites[1]),
    ["cancel_at", "cancellation_effective_at", "cancellation_requested_at"]);
  // Reached only when no cancellation stands: the whole effective-date
  // branch returns before it.
  const guardAt = scheduleFn.indexOf("if v_sub.cancellation_effective_at is not null then");
  const writeAt = scheduleFn.indexOf("set cancellation_requested_at = p_requested_at,");
  assert.ok(guardAt > -1 && guardAt < writeAt, "CASE A runs before the already-scheduled branch");
  // cancel_at is the PARAMETER, never the promise: a deferred late
  // cancellation passes NULL and the row must say so.
  assert.ok(scheduleWrites[1].includes("cancel_at                 = p_cancel_at"));
  assert.ok(!scheduleWrites[1].includes("cancel_at                 = p_effective_at"),
    "CASE A claims Stripe holds the promised date");
});

test("RACE 2 (CASE B): a genuine repeat writes NOTHING and moves nothing", () => {
  const caseB = branch(scheduleFn, "if v_sub.cancellation_requested_at is not null then");
  assert.ok(caseB.includes("'already_scheduled'"), "a repeat no longer answers already_scheduled");
  assert.ok(!caseB.includes("update"), "the repeat branch writes");
  // The ORIGINAL timestamp is returned, never the incoming one.
  assert.ok(caseB.includes("'cancellation_requested_at', v_sub.cancellation_requested_at"));
  assert.ok(!caseB.includes("p_requested_at"), "the repeat branch reports the new request time");
});

test("RACE 3 (CASE C): a reconciled cancel_at fills ONLY the request timestamp", () => {
  assert.deepEqual(columnsWritten(scheduleWrites[0]), ["cancellation_requested_at"]);
  const clause = scheduleWrites[0];
  // Everything the fix must not touch.
  for (const forbidden of [
    "cancel_at ", "cancel_at=", "status", "cancelled_at", "cancel_at_period_end",
    "current_period_start", "current_period_end", "_cents", "snapshot",
    "stripe_subscription_id", "next_delivery_at", "plan_id",
  ]) {
    assert.ok(!clause.includes(forbidden), `CASE C writes ${forbidden}`);
  }
  // Reported honestly: the timestamp now stored, plus a marker so the
  // race is legible in a log rather than silent.
  const ret = scheduleFn.slice(scheduleFn.indexOf("'request_recorded', true") - 400);
  assert.ok(ret.includes("'cancellation_requested_at', p_requested_at"));
  assert.ok(ret.includes("'cancel_at', v_sub.cancel_at"), "CASE C reports a cancel_at it did not read");
});

test("RACE 4 (CASE D): a DIFFERENT cancel_at still conflicts with zero writes", () => {
  const caseD = branch(scheduleFn, "if v_sub.cancellation_effective_at <> p_effective_at then");
  assert.ok(caseD.includes("'conflict'"));
  assert.ok(!caseD.includes("update"), "the conflict branch writes");
  // It is checked FIRST, so no later branch can reach a mismatched date.
  const dAt = scheduleFn.indexOf("if v_sub.cancellation_effective_at <> p_effective_at then");
  assert.ok(dAt < scheduleFn.indexOf("if v_sub.cancellation_requested_at is not null then"));
  assert.ok(dAt < scheduleFn.indexOf("set cancellation_requested_at = p_requested_at"));
});

test("RACE 5: a Stripe Dashboard cancellation keeps a NULL request forever", () => {
  // The pairing stays ONE-DIRECTIONAL. A symmetric constraint would make
  // an owner-initiated cancel_at unrepresentable, and the sync would have
  // had to invent a request that never happened.
  assert.ok(sql034.includes(
    "check (cancellation_requested_at is null or cancellation_effective_at is not null)"));
  assert.ok(!sql034.includes("(cancellation_requested_at is null) = (cancel_at is null)"));
  assert.ok(!sql034.includes("cancel_at is null or cancellation_requested_at is not null"));
  // And the request must NOT require a cancel_at, or the deferred late
  // state could not exist without lying about Stripe.
  assert.ok(!sql034.includes("check (cancellation_requested_at is null or cancel_at is not null)"),
    "a request is forced to claim a Stripe schedule");
  // Nothing fills the column outside an authenticated customer request.
  assert.ok(!syncFn.includes("p_requested_at"), "the sync invents a request timestamp");
  // ── CLEARING IS A TRANSITION, NOT A VALUE ──────────────────
  // Phase 3C.2 made this load-bearing. A deferred LATE cancellation holds
  // no cancel_at at Stripe for the whole cycle before its renewal, so
  // "Stripe reports no cancellation" is its normal resting state. Keying
  // the clear on that value would have deleted the customer's request on
  // the next card update or renewal event that happened to arrive.
  assert.ok(
    syncFn.includes("v_unscheduled := v_sub.cancel_at is not null and p_cancel_at is null"),
    "the sync clears on a value rather than on a transition"
  );
  assert.ok(syncFn.includes("when v_unscheduled then null"));
  assert.ok(syncFn.includes("else v_sub.cancellation_requested_at"), "the sync overwrites the request");
  // The old, now-wrong form must not come back.
  assert.ok(
    !/cancellation_requested_at = case\s+when p_cancel_at is null then null/.test(syncFn),
    "the sync clears a deferred request Stripe never held"
  );
});

test("RACE 5B: a deferred late cancellation survives every unrelated sync", () => {
  // The exact regression the transition guard prevents: while a late
  // cancellation waits for its last paid cycle the row holds a request
  // and NO cancel_at, and Stripe legitimately reports none either.
  assert.ok(syncFn.includes("v_unscheduled"), "no transition guard exists");
  const requestedAssignment = syncFn.slice(
    syncFn.indexOf("v_new_requested := case"),
    syncFn.indexOf("end;", syncFn.indexOf("v_new_requested := case"))
  );
  assert.ok(requestedAssignment.includes("when v_unscheduled then null"));
  assert.ok(!requestedAssignment.includes("p_cancel_at"),
    "the request is cleared from a Stripe value rather than a transition");
  // And the promised date survives the same way.
  const effectiveAssignment = syncFn.slice(
    syncFn.indexOf("v_new_effective := case"),
    syncFn.indexOf("end;", syncFn.indexOf("v_new_effective := case"))
  );
  assert.ok(effectiveAssignment.includes("else v_sub.cancellation_effective_at"),
    "an unrelated sync erases the promised end date");
});

test("RACE 6: a request that lost the race is still recorded", () => {
  // CASE C exists at all, and is reachable only after CASE D and CASE B
  // have declined - so it fires exactly when the webhook won.
  const caseCWriteAt = scheduleFn.indexOf("set cancellation_requested_at = p_requested_at\n");
  assert.ok(caseCWriteAt > -1, "CASE C performs no write");
  assert.ok(scheduleFn.indexOf("if v_sub.cancellation_requested_at is not null then") < caseCWriteAt);
  assert.ok(scheduleFn.indexOf("if v_sub.cancellation_effective_at <> p_effective_at then") < caseCWriteAt);
  // Still inside the standing-cancellation branch, so it can never run on
  // a row that has no end date at all.
  assert.ok(scheduleFn.indexOf("if v_sub.cancellation_effective_at is not null then") < caseCWriteAt);
});

test("RACE 7: once NON NULL the request timestamp is never moved again", () => {
  // Exactly two assignments in the whole migration, and each is guarded
  // by a condition that can only hold while the column is still NULL:
  // CASE A (no cancel_at at all) and CASE C (requested_at IS NULL).
  const assignments = [...sql034.matchAll(/cancellation_requested_at\s*=\s*p_requested_at/g)];
  assert.equal(assignments.length, 2, "the request timestamp is assigned somewhere new");
  assert.equal(scheduleWrites.filter(c => c.includes("p_requested_at")).length, 2);
  // The sync never assigns it a value at all.
  assert.ok(!/cancellation_requested_at\s*=\s*p_/.test(syncFn), "the sync writes a request timestamp");
  // And termination leaves it alone entirely.
  const markFn = fnBody("mark_subscription_cancelled", null);
  assert.ok(!markFn.includes("cancellation_requested_at"), "termination rewrites the request");
});

test("RACE 8: customer.subscription.updated syncs from CURRENT Stripe state", () => {
  assert.ok(updatedHandler.includes("stripe.subscriptions.retrieve(subscriptionId)"),
    "the handler does not re-read the subscription");
  const retrieveAt = updatedHandler.indexOf("stripe.subscriptions.retrieve(");
  const syncAt = updatedHandler.indexOf("syncSubscriptionFromStripe(");
  assert.ok(retrieveAt > -1 && retrieveAt < syncAt, "the database sync runs before the Stripe read");
  // ONLY the id comes off the event payload.
  assert.equal([...updatedHandler.matchAll(/event\.data\.object/g)].length, 1,
    "the handler reads the event snapshot more than once");
  assert.ok(updatedHandler.includes("(event.data.object as Stripe.Subscription)?.id"));
  assert.ok(!updatedHandler.includes("syncSubscriptionFromStripe(event"),
    "the event snapshot is synced directly");
});

test("RACE 9: a delayed webhook event cannot regress period or cancel_at", () => {
  // The object handed to the sync is the RETRIEVED one, not the payload.
  assert.ok(updatedHandler.includes("const subscription = await stripe.subscriptions.retrieve("));
  assert.ok(updatedHandler.includes("syncSubscriptionFromStripe(subscription)"));
  // No fallback to the snapshot when the retrieve fails: it throws, the
  // route answers 500, and Stripe redelivers against fresh state.
  assert.ok(!updatedHandler.includes("catch"), "the handler falls back to the stale payload");
  assert.ok(!updatedHandler.includes("??"), "the handler falls back to the stale payload");
  // No event-ordering column was invented to achieve this.
  for (const invented of [
    "stripe_event_created", "last_stripe_event", "event_sequence", "last_synced_at", "event_created_at",
  ]) {
    assert.ok(!sql034.includes(invented), `034 invented an ordering column: ${invented}`);
  }
  // Termination deliberately does NOT re-read: the deleted event's object
  // is the final state and cannot go stale.
  const deleted = webhookCode.slice(
    webhookCode.indexOf("async function handleSubscriptionDeleted"),
    webhookCode.indexOf("async function handleRefundEvent")
  );
  assert.ok(!deleted.includes("stripe.subscriptions.retrieve("), "the deleted handler re-reads");
  assert.ok(deleted.includes("markSubscriptionCancelledFromStripe(subscription)"));
});

test("RACE 10: no product, quantity, price, address, tax, money or order write", () => {
  const allowed = new Set([
    "cancellation_requested_at", "cancellation_effective_at", "cancel_at",
    "current_period_start", "current_period_end", "status", "cancelled_at",
  ]);
  const clauses = updateSetClauses(sql034);
  assert.equal(clauses.length, 5, "unexpected number of UPDATE statements");
  for (const clause of clauses) {
    for (const column of columnsWritten(clause)) {
      assert.ok(allowed.has(column), `034 writes ${column}`);
    }
  }
  for (const forbidden of [
    "quantity", "unit_amount", "price_id", "plan_id", "product", "shipping_address",
    "billing_address", "tax_", "_cents", "snapshot", "public.orders", "public.order_items",
    "public.checkout_attempts", "next_delivery_at", "cancel_at_period_end",
  ]) {
    assert.ok(!sql034.includes(forbidden), `034 touches ${forbidden}`);
  }
});

/* ══════════════════════════════════════════════════════════════
   PHASE 3C.2 - PRORATION SAFETY ON THE LATE BRANCH

   The finding, verified against the INSTALLED SDK rather than from
   memory: SubscriptionUpdateParams.cancel_at documents that a date "set
   during a future period ... will ALWAYS cause a proration for that
   period" - unqualified by proration_behavior. A late cancellation is a
   future-period date by definition.

   In GLOA that is not a cosmetic credit line. Migration 022's
   fulfillment refuses any invoice whose total does not equal the frozen
   subscription total, so a prorated renewal would fail to fulfill
   entirely: no order, no delivery, no confirmation, for a cycle the
   customer had already been charged for.
   ══════════════════════════════════════════════════════════════ */

test("SDK: the future-period proration clause is really in the installed types", () => {
  // Read from node_modules, not asserted from memory.
  const decl = readFileSync(
    path.join(ROOT, "node_modules/stripe/cjs/resources/Subscriptions.d.ts"), "utf-8"
  );
  // Anchored FORWARD from the update params: SubscriptionCreateParams
  // appears earlier in the file and carries the same field names, so an
  // unanchored search would slice the wrong interface (or nothing).
  const updateAt = decl.indexOf("interface SubscriptionUpdateParams {");
  assert.ok(updateAt > -1, "SubscriptionUpdateParams is gone");
  const params = decl.slice(updateAt, decl.indexOf("cancel_at_period_end?: boolean;", updateAt));
  assert.ok(params.includes("cancel_at?:"), "the slice missed cancel_at");
  assert.ok(
    params.includes("If set during a future period, this will always cause a proration for that period"),
    "the SDK no longer documents the future-period proration - re-evaluate the late branch"
  );
});

test("LATE: no future-period cancel_at is ever sent to Stripe", () => {
  // The request-time Stripe write is gated on the delivery decision, and
  // that decision is "immediate" for early only.
  assert.ok(rulesCode.includes('return timing === "early" ? "immediate" : "deferred";'));
  assert.equal(cancellationDelivery("early"), "immediate");
  assert.equal(cancellationDelivery("late"), "deferred");
  assert.equal(schedulesAtStripeNow("early"), true);
  assert.equal(schedulesAtStripeNow("late"), false);
  // And the service actually consults it before writing.
  const updateAt = serviceCode.indexOf("stripe.subscriptions.update(");
  const gateAt = serviceCode.indexOf("if (deliverNow && !existingCancelAt) {");
  assert.ok(gateAt > -1 && gateAt < updateAt, "the Stripe write is not gated on the timing");
});

test("LATE: exactly one further cycle, enforced without a counter", () => {
  // No cycle counter exists anywhere - a counter that can read 2 is a
  // counter that can one day bill someone twice.
  for (const invented of [
    "cycles_remaining", "remaining_cycles", "cycle_count", "extra_cycles", "cancellation_cycles",
  ]) {
    assert.ok(!sql034.includes(invented), `034 stores a cycle counter: ${invented}`);
    assert.ok(!serviceCode.includes(invented), `the service stores a cycle counter: ${invented}`);
  }
  // Instead: the decision is CONSUMED. It applies only while cancel_at is
  // NULL, and applying it sets cancel_at.
  assert.ok(applyFn.includes("if v_sub.cancel_at is not null then"));
  const consumed = branch(applyFn, "if v_sub.cancel_at is not null then");
  assert.ok(consumed.includes("'already_scheduled'"));
  assert.ok(!consumed.includes("update"), "the consumed branch writes again");
  // And it will not fire EARLY, so a redelivered invoice.paid for the
  // cycle the customer was still in cannot rob them of the owed one.
  assert.ok(applyFn.includes("if p_cancel_at < v_sub.cancellation_effective_at then"));
  assert.ok(branch(applyFn, "if p_cancel_at < v_sub.cancellation_effective_at then").includes("'too_early'"));
});

test("LATE: the due check is inclusive and fails toward NOT cancelling early", () => {
  const promised = LATE_END;
  // The exact cycle: due.
  assert.equal(deferredCancellationIsDue({ periodEnd: LATE_END, promisedAt: promised }), true);
  // The cycle the customer was still in when they asked: NOT due, so a
  // redelivery inside Stripe's retry window changes nothing.
  assert.equal(deferredCancellationIsDue({ periodEnd: PERIOD_END, promisedAt: promised }), false);
  // One millisecond short is still not due.
  const oneMsShort = new Date(Date.parse(LATE_END) - 1).toISOString();
  assert.equal(deferredCancellationIsDue({ periodEnd: oneMsShort, promisedAt: promised }), false);
  // Beyond is due - a missed renewal does not strand the cancellation.
  const later = new Date(Date.parse(LATE_END) + CADENCE_MS).toISOString();
  assert.equal(deferredCancellationIsDue({ periodEnd: later, promisedAt: promised }), true);
  // Unusable input never fires.
  for (const bad of [null, undefined, "", "nope"]) {
    assert.equal(deferredCancellationIsDue({ periodEnd: bad, promisedAt: promised }), false, String(bad));
    assert.equal(deferredCancellationIsDue({ periodEnd: LATE_END, promisedAt: bad }), false, String(bad));
  }
});

test("LATE: the applied date is a CURRENT-period date, which prorates nothing", () => {
  // What reaches Stripe at renewal time is the period end the renewal
  // just produced - never the promise, and never a computed future date.
  assert.ok(serviceCode.includes("const effectiveCancelAt = row.current_period_end as string;"));
  const call = serviceCode.slice(serviceCode.lastIndexOf("stripe.subscriptions.update("));
  const params = call.slice(0, call.indexOf("idempotencyKey"));
  assert.ok(params.includes("cancel_at: toStripeTimestamp(effectiveCancelAt)"));
  assert.ok(params.includes('proration_behavior: "none"'));
  // No cadence arithmetic at apply time: adding 28 days again would push
  // the date back into a future period and reintroduce the proration.
  assert.ok(!params.includes("CADENCE_MS"));
  assert.ok(!params.includes("resolveCancellationSchedule"));
});

test("LATE: the commercial configuration is never touched", () => {
  // Both Stripe writes carry cancel_at and proration_behavior and NOTHING
  // else. This is what keeps the full normal merchandise amount, the
  // normal recurring shipping line, quantity 1 and the week/4 cadence
  // exactly as checkout froze them.
  const updates = [...serviceCode.matchAll(/stripe\.subscriptions\.update\(/g)];
  assert.equal(updates.length, 2);
  for (const update of updates) {
    const params = serviceCode.slice(update.index, serviceCode.indexOf("idempotencyKey", update.index));
    for (const forbidden of [
      "items", "price", "quantity", "metadata", "customer", "default_payment_method",
      "billing_cycle_anchor", "trial", "cancel_at_period_end", "shipping", "discounts",
      "coupon", "promotion_code", "tax", "currency", "collection_method",
    ]) {
      assert.ok(!params.includes(forbidden), `a Stripe write also sets ${forbidden}`);
    }
  }
  // And the invariant that would have caught a proration anyway is still
  // in place: a renewal whose total moved does not fulfill.
  const invoiceRules = read("lib/subscriptionInvoiceRules.ts");
  assert.ok(invoiceRules.includes("invoice.total !== frozen.totalGrossCents"),
    "the frozen-total reconciliation was weakened");
});

test("LATE: no Subscription Schedule is created, and the SDK says why", () => {
  // Option A was evaluated and rejected. from_subscription forbids every
  // other parameter in the same call, and the follow-up update REQUIRES
  // phases[].items - which would make the cancellation path responsible
  // for re-declaring this subscription's prices and quantities.
  const decl = readFileSync(
    path.join(ROOT, "node_modules/stripe/cjs/resources/SubscriptionSchedules.d.ts"), "utf-8"
  );
  assert.ok(decl.includes("When using this parameter, other parameters (such as phase values) cannot be set"),
    "from_subscription no longer forbids phases - re-evaluate Option A");
  const updatePhase = decl.slice(
    decl.indexOf("namespace SubscriptionScheduleUpdateParams"),
    decl.indexOf("namespace SubscriptionScheduleUpdateParams") + 40000
  );
  assert.ok(/\n\s+items: Array<Phase\.Item>;/.test(updatePhase),
    "phases[].items is no longer required - re-evaluate Option A");
  // Nothing in GLOA touches schedules.
  const offenders = [];
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      const source = withoutComments(readFileSync(full, "utf-8"));
      for (const forbidden of ["subscriptionSchedules", "from_subscription", "end_behavior"]) {
        if (source.includes(forbidden)) offenders.push(`${entry.name}: ${forbidden}`);
      }
    }
  };
  walk(path.join(ROOT, "app"));
  walk(path.join(ROOT, "lib"));
  assert.deepEqual(offenders, []);
});

test("EARLY: unchanged, and safe under the documented proration rule", () => {
  // The early date is the CURRENT period end. The SDK's clause covers a
  // date BEFORE the period ends and only "if prorations have been enabled
  // using proration_behavior" - which is pinned to none - and the
  // future-period clause does not apply at all.
  const early = resolveCancellationSchedule({ requestAt: CUTOFF, currentPeriodEnd: PERIOD_END });
  assert.equal(early.ok, true);
  assert.equal(early.schedule.timing, "early");
  assert.equal(early.schedule.effectiveCancelAt, PERIOD_END);
  assert.equal(schedulesAtStripeNow(early.schedule.timing), true);
  // One millisecond past the cutoff is late, and that one defers.
  const late = resolveCancellationSchedule({
    requestAt: new Date(Date.parse(CUTOFF) + 1).toISOString(),
    currentPeriodEnd: PERIOD_END,
  });
  assert.equal(late.schedule.timing, "late");
  assert.equal(late.schedule.effectiveCancelAt, LATE_END);
  assert.equal(schedulesAtStripeNow(late.schedule.timing), false);
});

test("TRUTHFULNESS: cancel_at is written only when Stripe holds it", () => {
  // The row must never claim a Stripe schedule that does not exist.
  assert.ok(serviceCode.includes("p_cancel_at: deliverNow ? schedule.effectiveCancelAt : null"));
  // The RPC refuses a cancel_at that disagrees with the promise, so the
  // two can never drift apart through this entry point.
  assert.ok(scheduleFn.includes("if p_cancel_at is not null and p_cancel_at <> p_effective_at then"));
  // Only the deferred-apply path may turn a NULL cancel_at into a date,
  // and only after its own Stripe write.
  const stripeAt = serviceCode.lastIndexOf("stripe.subscriptions.update(");
  const rpcAt = serviceCode.indexOf('admin.rpc(\n    "apply_deferred_subscription_cancellation"');
  assert.ok(rpcAt > -1, "the deferred apply does not call its RPC");
  assert.ok(stripeAt < rpcAt, "the database is written before Stripe accepts the deferred cancellation");
});

test("DEFERRED APPLY: idempotent, ordered, and never throws", () => {
  const fn = serviceCode.slice(
    serviceCode.indexOf("export async function applyDeferredCancellationFromRenewal"),
    serviceCode.indexOf("export function stripeSubscriptionFacts")
  );
  assert.ok(fn.length > 0, "the deferred apply is missing");
  // Never throws: every failure is a returned value.
  assert.ok(!fn.includes("throw "), "the deferred apply throws");
  for (const answer of ["nothing_pending", "already_scheduled", "too_early", "not_found", "error"]) {
    assert.ok(fn.includes(`"${answer}"`), `the deferred apply cannot answer ${answer}`);
  }
  // It writes nothing directly - every write goes through the RPC.
  for (const forbidden of [".insert(", ".update(", ".delete(", ".upsert("]) {
    assert.ok(!fn.includes(`from("subscriptions")${forbidden}`), `it writes directly: ${forbidden}`);
  }
  assert.ok(fn.includes('.from("subscriptions")\n    .select('), "it does more than select");
  // An owner-initiated Stripe Dashboard cancellation is never re-applied.
  assert.ok(fn.includes("if (!row.cancellation_requested_at || !row.cancellation_effective_at) return \"nothing_pending\";"));
});

test("DEFERRED APPLY: it runs on invoice.paid, after the order exists", () => {
  const handler = webhookCode.slice(
    webhookCode.indexOf("async function handleInvoicePaid"),
    webhookCode.indexOf("async function handleSubscriptionSessionCompleted")
  );
  const orderAt = handler.indexOf("sendInternalOrderNotificationIfNeeded(");
  const applyAt = handler.indexOf("applyDeferredCancellationFromRenewal(");
  assert.ok(orderAt > -1 && applyAt > -1);
  assert.ok(orderAt < applyAt, "the cancellation is applied before the cycle is fulfilled");
  // It is not a cron.
  const vercel = JSON.parse(read("vercel.json"));
  assert.equal((vercel.crons ?? []).length, 1);
  assert.equal(vercel.crons[0].path, "/api/cron/retry-order-notifications");
  // The subscription id comes from the fulfillment result, not re-derived.
  assert.ok(handler.includes("result.stripeSubscriptionId"));
  assert.ok(read("lib/subscriptionInvoiceFulfillment.ts").includes("stripeSubscriptionId,"));
});

test("DEFERRED APPLY: a failed renewal leaves the request pending, not lost", () => {
  // No invoice.paid means no apply, so nothing is scheduled at Stripe and
  // the row keeps saying so. There is no separate failure policy to get
  // wrong, and none was invented.
  assert.ok(!webhookCode.includes("invoice.payment_failed"), "billing failure was handled in this phase");
  assert.ok(!serviceCode.includes("past_due ="), "the service writes a billing failure state");
  // past_due and unpaid remain CANCELLABLE, so a customer whose card
  // failed can still end the contract.
  assert.deepEqual([...CANCELLABLE_STATUSES], ["active", "past_due", "unpaid"]);
  assert.ok(sql034.includes("if v_sub.status not in ('active', 'past_due', 'unpaid') then"));
  // And the apply never writes status, so it cannot mask a billing state.
  assert.ok(!/update public\.subscriptions[\s\S]*?status/.test(applyFn), "the deferred apply writes status");
});

test("DEFERRED APPLY: scheduled is still not cancelled", () => {
  // It writes exactly two columns, neither of them status or cancelled_at.
  const writes = updateSetClauses(applyFn);
  assert.equal(writes.length, 1, "the deferred apply writes more than once");
  assert.deepEqual(columnsWritten(writes[0]), ["cancel_at", "cancellation_effective_at"]);
  for (const forbidden of ["status", "cancelled_at", "current_period", "_cents", "snapshot", "plan_id"]) {
    assert.ok(!writes[0].includes(forbidden), `the deferred apply writes ${forbidden}`);
  }
  // customer.subscription.deleted remains the only authority on
  // termination.
  const setClauses = updateSetClauses(sql034);
  assert.equal(setClauses.filter(c => /status\s+=\s+'cancelled'/.test(c)).length, 1);
});

/* ══════════════════════════════════════════════════════════════
   PHASE 3C.3 - DEFERRED CANCELLATION FAILURE RECOVERY

   The defect: applyDeferredCancellationFromRenewal returned "error" and
   handleInvoicePaid only LOGGED it. The webhook still answered 200, the
   event was recorded as processed, and the cancellation waited for the
   next renewal - 28 days later, and that renewal CHARGES THE CUSTOMER.
   A transient Stripe or Supabase blip turned "exactly one further cycle"
   into two at the customer's expense.

   Two independent recovery paths now, neither of which needs another
   paid invoice: the webhook throws so Stripe redelivers, and a daily
   sweep re-derives due-ness from durable local state.
   ══════════════════════════════════════════════════════════════ */

test("3C.3: the event is recorded ONLY after every mandatory action succeeds", () => {
  // This is what makes throwing a working retry rather than a lost event.
  const events = read("lib/stripeWebhookEvents.ts");
  assert.ok(events.includes("Records a verified, fully-processed Stripe event id"));
  // No status column exists, so a row means "done" and nothing else. The
  // table carries no UPDATE grant either, so a claim-then-mark design is
  // not even reachable from application code.
  const nine = read("supabase/migrations/009_stripe_checkout_attempts.sql");
  const table = nine.slice(
    nine.indexOf("create table public.stripe_webhook_events"),
    nine.indexOf(");", nine.indexOf("create table public.stripe_webhook_events"))
  );
  for (const invented of ["status", "attempts", "failed_at", "processing"]) {
    assert.ok(!table.includes(invented), `009 already had a ${invented} column`);
  }
  assert.ok(read("supabase/migrations/023_harden_stripe_customers_grants.sql")
    .includes("grant select, insert on table public.stripe_webhook_events to service_role;"));
  // Ordering in the route: record runs AFTER the handler block, so a
  // throw skips it entirely.
  const recordAt = webhookCode.indexOf("await recordStripeWebhookEvent(");
  const handlerAt = webhookCode.indexOf("await handleInvoicePaid(");
  // Anchored FORWARD from the handler: the route's first `} catch` belongs
  // to signature verification, which runs long before any handler.
  const catchAt = webhookCode.indexOf("} catch (err) {", handlerAt);
  assert.ok(handlerAt > -1 && handlerAt < catchAt && catchAt < recordAt,
    "the event is recorded before or inside the handler block");
  // And that catch answers 500, which is what makes Stripe redeliver.
  const failure = webhookCode.slice(catchAt, recordAt);
  assert.ok(failure.includes("status: 500"), "a handler failure no longer answers 500");
});

test("3C.3 (A): a Stripe failure after the paid order still throws", () => {
  const handler = webhookCode.slice(
    webhookCode.indexOf("async function handleInvoicePaid"),
    webhookCode.indexOf("async function handleSubscriptionSessionCompleted")
  );
  // The forbidden 3C.2 assumption is gone from every source.
  for (const source of [handler, serviceCode]) {
    assert.ok(!/pending for the next renewal/i.test(source),
      "the next-renewal recovery assumption is still claimed");
  }
  // 'error' is fatal.
  assert.ok(handler.includes('if (deferred === "error") {'));
  const fatal = handler.slice(handler.indexOf('if (deferred === "error") {'));
  assert.ok(fatal.includes("throw new Error("), "an error no longer throws");
  // Stripe ids only in the message - no customer, no amount, no email.
  const message = fatal.slice(fatal.indexOf("throw new Error("), fatal.indexOf(");", fatal.indexOf("throw new Error(")));
  for (const leak of ["customerEmail", "customerName", "order.", "orderNumber", "amount", "total"]) {
    assert.ok(!message.includes(leak), `the failure message leaks ${leak}`);
  }
  // A successful outcome does NOT throw.
  for (const fine of ["applied", "already_scheduled", "nothing_pending", "too_early"]) {
    assert.ok(!fatal.includes(`"${fine}"`), `${fine} is treated as fatal`);
  }
});

test("3C.3 (A): the throw comes last, so the order and the email survive it", () => {
  const handler = webhookCode.slice(
    webhookCode.indexOf("async function handleInvoicePaid"),
    webhookCode.indexOf("async function handleSubscriptionSessionCompleted")
  );
  const orderAt = handler.indexOf("fulfillPaidSubscriptionInvoice(");
  const emailAt = handler.indexOf("sendInternalOrderNotificationIfNeeded(");
  const applyAt = handler.indexOf("applyDeferredCancellationFromRenewal(");
  const throwAt = handler.indexOf('if (deferred === "error") {');
  assert.ok(orderAt < emailAt && emailAt < applyAt && applyAt < throwAt,
    "the mandatory cancellation runs before the delivery it must not undo");
});

test("3C.3 (D): a redelivered invoice.paid reuses everything and retries only the cancellation", () => {
  // The three things a redelivery re-runs are each idempotent AT THE
  // DATABASE, not merely by convention.
  const m022 = read("supabase/migrations/022_recurring_subscription_foundation.sql");
  const activate = m022.slice(m022.indexOf("create or replace function public.activate_subscription_from_invoice"));
  assert.ok(activate.includes("where stripe_invoice_id = p_stripe_invoice_id"));
  assert.ok(activate.includes("return v_attempt.id;"), "a redelivery does not reuse the checkout attempt");
  assert.ok(m022.includes("create unique index checkout_attempts_stripe_invoice_id_key"));

  const m021 = readdirSync(MIGRATIONS).find(f => f.startsWith("021"));
  const order = read(`supabase/migrations/${m021}`);
  const createFn = order.slice(order.indexOf("create or replace function public.create_order_from_paid_checkout"));
  assert.ok(createFn.includes("where checkout_attempt_id = p_checkout_attempt_id"));
  assert.ok(createFn.includes("return v_order;"), "a redelivery creates a second order");

  // The internal notification claims atomically and answers already-sent.
  const notify = read("lib/internalOrderNotificationEmail.ts");
  assert.ok(notify.includes('.or("internal_notification_status.is.null,internal_notification_status.eq.failed")'),
    "the notification claim is no longer atomic");
  assert.ok(notify.includes('if (claim === "already-sent") return;'));
  assert.ok(notify.includes("internalOrderNotificationIdempotencyKey(order.id)"),
    "the notification lost its provider idempotency key");

  // And fulfillment answers 'fulfilled' the second time, NOT 'ignored',
  // so the handler reaches the cancellation again.
  const fulfil = read("lib/subscriptionInvoiceFulfillment.ts");
  const tail = fulfil.slice(fulfil.indexOf("const order = await deps.createOrder("));
  assert.ok(tail.includes('kind: "fulfilled"'), "a redelivery stops before the deferred cancellation");
});

test("3C.3 (B/F): the sweep needs no invoice, no event and no second renewal", () => {
  const sweep = serviceCode.slice(
    serviceCode.indexOf("export async function sweepDueDeferredCancellations"),
    serviceCode.indexOf("export function stripeSubscriptionFacts")
  );
  assert.ok(sweep.length > 0, "the sweep is missing");
  // It reads durable state only - no invoice, no event, no Stripe list.
  for (const forbidden of ["invoice", "Invoice", "event", "Event", "subscriptions.list", "retrieve("]) {
    assert.ok(!sweep.includes(forbidden), `the sweep depends on ${forbidden}`);
  }
  // Four durable conditions, all required.
  assert.ok(sweep.includes('.not("cancellation_requested_at", "is", null)'));
  assert.ok(sweep.includes('.not("cancellation_effective_at", "is", null)'));
  assert.ok(sweep.includes('.not("stripe_subscription_id", "is", null)'));
  assert.ok(sweep.includes('.is("cancel_at", null)'));
  assert.ok(sweep.includes('.eq("customer_type", "private")'));
  assert.ok(sweep.includes(".in(\"status\", [...CANCELLABLE_STATUSES])"));
  // The paid-cycle proof, applied per row.
  assert.ok(sweep.includes("deferredCancellationIsDue({"));
  // Bounded.
  assert.ok(sweep.includes(".limit(DEFERRED_SWEEP_LIMIT)"));
  assert.equal(DEFERRED_SWEEP_LIMIT, 50);
});

test("3C.3: the sweep can never reach a historical or owner-made cancellation", () => {
  // THE NULL RULE IS NOT VIOLATED. `cancel_at IS NULL` is selected, but
  // only together with a NON-NULL customer request - which no historical
  // subscription and no Stripe Dashboard cancellation has.
  const sweep = serviceCode.slice(
    serviceCode.indexOf("export async function sweepDueDeferredCancellations"),
    serviceCode.indexOf("export function stripeSubscriptionFacts")
  );
  const query = sweep.slice(sweep.indexOf('.from("subscriptions")'), sweep.indexOf(".limit("));
  assert.ok(query.includes('.not("cancellation_requested_at", "is", null)'),
    "the sweep can select a subscription nobody asked to cancel");
  // It writes nothing itself - every write goes through the locking RPC.
  for (const forbidden of [".update(", ".insert(", ".delete(", ".upsert("]) {
    assert.ok(!sweep.includes(forbidden), `the sweep writes directly: ${forbidden}`);
  }
  assert.ok(sweep.includes("applyDeferredCancellationFromRenewal("),
    "the sweep does not reuse the guarded apply");
  // Which re-checks all four conditions under a row lock.
  assert.ok(applyFn.includes("for update"));
  assert.ok(applyFn.includes("if v_sub.cancellation_requested_at is null"));
  assert.ok(applyFn.includes("if v_sub.cancel_at is not null then"));
  assert.ok(applyFn.includes("if p_cancel_at < v_sub.cancellation_effective_at then"));
});

test("3C.3: one failing row never stops the sweep, and nothing is hidden", () => {
  const sweep = serviceCode.slice(
    serviceCode.indexOf("export async function sweepDueDeferredCancellations"),
    serviceCode.indexOf("export function stripeSubscriptionFacts")
  );
  assert.ok(sweep.includes("try {") && sweep.includes("} catch (err) {"), "a throwing row kills the batch");
  assert.ok(sweep.includes("continue;"));
  // An unreadable work list is reported, never a clean run of zeroes.
  assert.ok(sweep.includes("summary.errored = true;"));
  // too_early and nothing_pending cannot happen for a selected row, so
  // they are counted as failures rather than silently swallowed.
  assert.ok(sweep.includes("summary.failed += 1;"));
  // Counts only. No id, no Stripe id, no customer fact in the summary.
  const type = serviceCode.slice(
    serviceCode.indexOf("export type DeferredSweepSummary = {"),
    serviceCode.indexOf("};", serviceCode.indexOf("export type DeferredSweepSummary = {"))
  );
  for (const leak of ["subscriptionId", "stripe", "email", "name", "amount", "cancel_at"]) {
    assert.ok(!type.includes(leak), `the summary carries ${leak}`);
  }
});

test("3C.3: the sweep runs in the existing authenticated cron, in its own guard", () => {
  const cron = withoutComments(read("app/api/cron/retry-order-notifications/route.ts"));
  assert.ok(cron.includes("sweepDueDeferredCancellations(stripe)"));
  // Behind the same CRON_SECRET, checked before anything runs.
  const authAt = cron.indexOf("isBearerSecretAuthorized(request, secret)");
  const sweepAt = cron.indexOf("sweepDueDeferredCancellations(");
  assert.ok(authAt > -1 && authAt < sweepAt, "the sweep runs before authorization");
  assert.ok(cron.includes("if (!secret)"), "the cron no longer fails closed");
  // Its own try/catch, so a Stripe outage cannot lose the email counters
  // and an email failure cannot stop a cancellation.
  const block = cron.slice(cron.indexOf("runTransactionalEmailRetryCron()"));
  assert.ok(block.includes("let deferredCancellations;"));
  assert.ok(block.indexOf("try {") < block.indexOf("sweepDueDeferredCancellations("),
    "the sweep is not guarded");
  // Still exactly one schedule, at the unchanged path.
  const vercel = JSON.parse(read("vercel.json"));
  assert.equal((vercel.crons ?? []).length, 1, "a second cron was registered");
  assert.equal(vercel.crons[0].path, "/api/cron/retry-order-notifications");
  // GET only, and no new client-exposed surface.
  assert.ok(cron.includes("export async function GET("));
  for (const method of ["export async function POST(", "export async function PUT(", "export async function DELETE("]) {
    assert.ok(!cron.includes(method), `the cron gained ${method}`);
  }
});

test("3C.3 (C): Stripe succeeds and the local RPC fails - already closed, not re-solved", () => {
  const fn = serviceCode.slice(
    serviceCode.indexOf("export async function applyDeferredCancellationFromRenewal"),
    serviceCode.indexOf("export type DeferredSweepSummary")
  );
  // Stripe first, then the RPC.
  assert.ok(fn.indexOf("stripe.subscriptions.update(") < fn.indexOf("apply_deferred_subscription_cancellation"));
  // An RPC failure is reported, and the comment names the mechanism that
  // repairs it rather than inventing a second one.
  // The reasoning lives in a comment, so this reads the RAW source -
  // serviceCode has comments stripped for the code-only assertions.
  const rawFn = service.slice(
    service.indexOf("export async function applyDeferredCancellationFromRenewal"),
    service.indexOf("export type DeferredSweepSummary")
  );
  assert.ok(rawFn.includes("customer.subscription.updated"), "the self-heal path is not documented");
  // That mechanism still exists and still writes cancel_at.
  assert.ok(webhookCode.includes('event.type === "customer.subscription.updated"'));
  assert.ok(webhookCode.includes("handleSubscriptionUpdated(stripe, event)"));
  assert.ok(syncFn.includes("cancel_at                = p_cancel_at"));
  // And a retry after Stripe already holds it performs NO second Stripe
  // mutation: the local row is repaired by the sync, and the apply then
  // answers already_scheduled.
  assert.ok(fn.includes('if (row.cancel_at) return "already_scheduled";'));
  const guardAt = fn.indexOf('if (row.cancel_at) return "already_scheduled";');
  assert.ok(guardAt < fn.indexOf("stripe.subscriptions.update("),
    "a repaired row still issues a second Stripe write");
});

test("3C.3 (E): dedupe is unchanged for every other flow", () => {
  const events = read("lib/stripeWebhookEvents.ts");
  // Untouched by this phase.
  assert.ok(events.includes("export async function hasStripeWebhookEventBeenProcessed"));
  assert.ok(events.includes("export async function recordStripeWebhookEvent"));
  assert.ok(!events.includes("status"), "the event table gained a status");
  // A fully successful event is still recorded, so it is never replayed.
  const route = webhookCode;
  assert.ok(route.includes("if (alreadyProcessed) {"));
  assert.ok(route.includes("return Response.json({ received: true }, { status: 200 });"));
  // Only invoice.paid gained a mandatory action, and exactly one throw
  // was added - inside that handler, not across the route.
  const invoiceHandler = route.slice(
    route.indexOf("async function handleInvoicePaid"),
    route.indexOf("async function handleSubscriptionSessionCompleted")
  );
  assert.equal([...invoiceHandler.matchAll(/throw new Error\(/g)].length, 2,
    "an unexpected number of fatal failures in the invoice handler");
  assert.ok(invoiceHandler.includes("could not be fulfilled"), "the pre-existing fulfilment throw is gone");
  assert.ok(invoiceHandler.includes("could not be applied"), "the deferred cancellation throw is missing");
  // The refund, subscription-updated and subscription-deleted handlers
  // gained none.
  const others = route.slice(route.indexOf("async function handleSubscriptionUpdated"),
    route.indexOf("async function handleCheckoutSessionCompleted"));
  assert.equal([...others.matchAll(/throw new Error\(/g)].length, 0,
    "another handler became fatal in this phase");
});

/* ══════════════════════════════════════════════════════════════
   OWNERSHIP AND AUTH
   ══════════════════════════════════════════════════════════════ */

test("auth: the route authenticates before touching any subscription", () => {
  assert.ok(routeBody.includes("verifyBearerUser(request)"));
  const authAt = routeBody.indexOf("verifyBearerUser");
  assert.ok(authAt < routeBody.indexOf("cancelSubscriptionForUser"), "the service runs before auth");
  assert.ok(routeBody.includes("status: 401"));
});

test("auth: the user id comes from the token and never from the body", () => {
  assert.ok(routeCode.includes("caller.userId"));
  const call = routeBody.slice(routeBody.indexOf("cancelSubscriptionForUser("));
  const args = call.slice(0, call.indexOf(", {"));
  assert.ok(args.includes("validated.request.subscriptionId"));
  assert.ok(args.includes("caller.userId"));
  assert.ok(!args.includes("body"), "the body reaches the service");
});

test("ownership: it is enforced twice, in code and in the locked RPC", () => {
  // 1. the service SELECT matches id AND user_id
  assert.ok(serviceCode.includes('.eq("id", subscriptionId)'));
  assert.ok(serviceCode.includes('.eq("user_id", userId)'));
  // 2. the RPC matches again, under FOR UPDATE
  assert.ok(sql034.includes("where id = p_subscription_id"));
  assert.ok(sql034.includes("and user_id = p_user_id"));
  const select = sql034.slice(sql034.indexOf("select * into v_sub"));
  assert.ok(select.slice(0, 300).includes("for update"));
});

test("ownership: a foreign subscription is indistinguishable from a missing one", () => {
  assert.ok(serviceCode.includes('if (!data) return { ok: false, result: "not_found" }'));
  // customer_type also answers not_found, not a distinct code.
  assert.ok(serviceCode.includes('customer_type !== "private"'));
  const b2c = serviceCode.slice(serviceCode.indexOf('customer_type !== "private"'));
  assert.ok(b2c.slice(0, 120).includes('result: "not_found"'));
  assert.ok(sql034.includes("if v_sub.customer_type is distinct from 'private' then"));
});

test("ownership: B2B supply agreements can never be ended through this route", () => {
  for (const forbidden of ["b2b_supply_agreements", "business", "supply_agreement"]) {
    assert.ok(!serviceCode.includes(forbidden), `the service touches ${forbidden}`);
    assert.ok(!sql034.includes(forbidden), `034 touches ${forbidden}`);
  }
});

/* ══════════════════════════════════════════════════════════════
   MIGRATION 034
   ══════════════════════════════════════════════════════════════ */

test("034: it is the next free number and 022-033 are untouched", () => {
  const files = readdirSync(MIGRATIONS).filter(f => f.endsWith(".sql")).sort();
  const numbers = files.map(f => f.slice(0, 3));
  assert.equal(new Set(numbers).size, numbers.length, "a migration number is used twice");
  assert.deepEqual(files.filter(f => f.startsWith("034")), ["034_subscription_cancellation.sql"]);
  assert.equal(numbers.filter(nr => nr > "034").length, 0, "a migration above 034 appeared");
  assert.equal(files[files.length - 2], "033_refund_confirmation_email_state.sql");
  // It redefines nothing the subscription foundation owns.
  for (const owned of [
    "create_pending_subscription", "activate_subscription_from_invoice",
    "claim_pending_subscription_for_attempt", "subscriptions_status_check",
  ]) {
    assert.ok(!sql034.includes(owned), `034 touches ${owned}`);
  }
});

test("034: exactly three columns, nullable, no default, no backfill", () => {
  const adds = [...sql034.matchAll(/add column(?: if not exists)? (\w+)/g)].map(m => m[1]);
  assert.deepEqual(adds.sort(),
    ["cancel_at", "cancellation_effective_at", "cancellation_requested_at"]);
  const alter = sql034.slice(sql034.indexOf("alter table public.subscriptions"));
  const statement = alter.slice(0, alter.indexOf(";") + 1);
  assert.ok(!/default/i.test(statement), "a column has a default");
  assert.ok(!/not null/i.test(statement), "a column is NOT NULL");
  assert.ok(statement.includes("timestamptz"));
  for (const forbidden of ["insert into", "delete from", "truncate", "create trigger", "create policy"]) {
    assert.ok(!sql034.toLowerCase().includes(forbidden), `034 performs: ${forbidden}`);
  }
});

test("034: all four invariants exist, and the pairing is one-directional", () => {
  for (const name of [
    "subscriptions_cancellation_request_scheduled_check",
    "subscriptions_cancel_at_promised_check",
    "subscriptions_effective_after_request_check",
    "subscriptions_cancel_at_after_request_check",
  ]) {
    assert.ok(sql034.includes(`add constraint ${name}`), `${name} is missing`);
    assert.ok(sql034.includes(`drop constraint if exists ${name}`), `${name} is not re-runnable`);
  }
  // A request implies a PROMISE, and Stripe holding something implies one
  // too - but neither implies the other, which is what lets a late
  // cancellation exist before Stripe knows about it.
  assert.ok(sql034.includes(
    "check (cancellation_requested_at is null or cancellation_effective_at is not null)"));
  assert.ok(sql034.includes("check (cancel_at is null or cancellation_effective_at is not null)"));
  assert.ok(sql034.includes("or cancellation_effective_at > cancellation_requested_at"));
  assert.ok(sql034.includes("or cancel_at > cancellation_requested_at"));
  // NOT a symmetric pairing: a Stripe-originated cancel_at with no local
  // request must remain representable, or the sync could not reconcile it.
  assert.ok(!sql034.includes("(cancellation_requested_at is null) = (cancel_at is null)"),
    "the pairing is symmetric and would block Stripe-originated cancellations");
});

test("034: SCHEDULING NEVER WRITES status - that is termination's job", () => {
  // TWO writes since Phase 3C.1: CASE A (nothing scheduled yet, both
  // columns) and CASE C (the reconciliation race, one column). Both are
  // checked; slicing only the first would have let the other write
  // anything at all.
  const written = scheduleWrites.map(columnsWritten);
  assert.equal(written.length, 2, "unexpected number of scheduling writes");
  assert.deepEqual(written[0], ["cancellation_requested_at"], "CASE C writes more than the request");
  assert.deepEqual(written[1],
    ["cancel_at", "cancellation_effective_at", "cancellation_requested_at"],
    "CASE A writes the wrong columns");
  for (const clause of scheduleWrites) {
    for (const forbidden of [
      "status", "cancelled_at", "cancel_at_period_end", "current_period", "_cents",
      "snapshot", "stripe_subscription_id", "next_delivery_at", "plan_id",
    ]) {
      assert.ok(!clause.includes(forbidden), `scheduling writes ${forbidden}`);
    }
  }
});

test("034: only mark_subscription_cancelled writes status = cancelled", () => {
  // Count WRITES only. `if v_sub.status = 'cancelled'` is a read guard and
  // appears in two functions; the SET clause appears in exactly one.
  // Anchored on the UPDATE, not on the function's own `SET search_path`.
  const setClauses = updateSetClauses(sql034);
  assert.equal(setClauses.length, 5, "unexpected number of UPDATE statements");
  const writers = setClauses.filter(c => /status\s+=\s+'cancelled'/.test(c));
  assert.equal(writers.length, 1, "more than one path writes the cancelled status");
  const markFn = sql034.slice(sql034.indexOf("create or replace function public.mark_subscription_cancelled"));
  assert.ok(markFn.includes("status       = 'cancelled'"));
  assert.ok(markFn.includes("cancelled_at = coalesce(p_cancelled_at, now())"));
});

test("034: the sync refuses to write status, money or snapshots", () => {
  const syncFn = sql034.slice(
    sql034.indexOf("create or replace function public.sync_subscription_from_stripe"),
    sql034.indexOf("create or replace function public.mark_subscription_cancelled")
  );
  const setClause = syncFn.slice(syncFn.indexOf("update public.subscriptions"), syncFn.indexOf("where id = v_sub.id"));
  const written = [...setClause.matchAll(/^\s*(?:set\s+)?(\w+)\s*=/gm)].map(m => m[1]);
  assert.deepEqual(written.sort(), [
    "cancel_at", "cancellation_effective_at", "cancellation_requested_at",
    "current_period_end", "current_period_start",
  ]);
  for (const forbidden of ["status", "_cents", "snapshot", "plan_id", "stripe_subscription_id", "cancelled_at"]) {
    assert.ok(!setClause.includes(forbidden), `the sync writes ${forbidden}`);
  }
});

test("034: all four functions are SECURITY DEFINER with an empty search_path", () => {
  assert.equal([...sql034.matchAll(/security definer set search_path = ''/g)].length, 4);
  for (const fn of [
    "schedule_subscription_cancellation", "apply_deferred_subscription_cancellation",
    "sync_subscription_from_stripe", "mark_subscription_cancelled",
  ]) {
    const at = sql034.indexOf(`create or replace function public.${fn}`);
    assert.ok(at > -1, `${fn} missing`);
    const body = sql034.slice(at, sql034.indexOf("$$;", at));
    assert.ok(body.includes("language plpgsql"));
    assert.ok(body.includes("returns jsonb"));
    assert.ok(body.includes("for update"), `${fn} does not lock the row`);
  }
});

test("034: execute revoked from public/anon/authenticated, granted to service_role only", () => {
  const signatures = [
    "public.schedule_subscription_cancellation(uuid, uuid, timestamptz, timestamptz, timestamptz)",
    "public.apply_deferred_subscription_cancellation(text, timestamptz)",
    "public.sync_subscription_from_stripe(text, timestamptz, timestamptz, timestamptz)",
    "public.mark_subscription_cancelled(text, timestamptz)",
  ];
  for (const sig of signatures) {
    for (const role of ["public", "anon", "authenticated"]) {
      assert.ok(sql034.includes(`revoke all on function ${sig} from ${role};`), `${sig} not revoked from ${role}`);
    }
    assert.ok(sql034.includes(`grant execute on function ${sig} to service_role;`));
  }
  const grants = sql034.split(NEWLINE).filter(l => l.trim().toLowerCase().startsWith("grant"));
  assert.equal(grants.length, 4, "an unexpected grant was issued");
  // NO table or column grant: service_role still cannot write subscriptions.
  assert.ok(!/grant\s+update/i.test(sql034), "034 grants an UPDATE privilege");
  assert.ok(!/grant[^;]*on\s+(table\s+)?public\.subscriptions/i.test(sql034), "034 grants a table privilege");
  assert.ok(!/to (anon|authenticated|public)\b/i.test(sql034), "034 grants a browser role something");
});

test("034: the OWNER verification queries cover A through L", () => {
  for (const marker of [
    "-- (A)", "-- (C)", "-- (D)", "-- (E)", "-- (G)", "-- (H)", "-- (I)", "-- (J)", "-- (K)", "-- (L)",
  ]) {
    assert.ok(migration034.includes(marker), `verification ${marker} is missing`);
  }
  assert.ok(migration034.includes("prosecdef"));
  assert.ok(migration034.includes("has_function_privilege"));
  assert.ok(migration034.includes("column_privileges"));
  assert.ok(migration034.includes("pg_trigger"));
  assert.ok(migration034.includes("period_end_flagged"), "no cancel_at_period_end verification");
  assert.ok(migration034.includes("rowsecurity"), "no RLS verification");
});

/* ══════════════════════════════════════════════════════════════
   WEBHOOK
   ══════════════════════════════════════════════════════════════ */

test("webhook: deleted marks cancelled, updated only reconciles", () => {
  assert.ok(webhookCode.includes('event.type === "customer.subscription.deleted"'));
  assert.ok(webhookCode.includes("handleSubscriptionDeleted(event)"));
  assert.ok(webhookCode.includes("markSubscriptionCancelledFromStripe(subscription)"));
  assert.ok(webhookCode.includes("syncSubscriptionFromStripe(subscription)"));
  // Neither handler writes anything itself.
  const handlers = webhookCode.slice(webhookCode.indexOf("async function handleSubscriptionUpdated"));
  const block = handlers.slice(0, handlers.indexOf("async function handleRefundEvent"));
  for (const forbidden of [".update(", ".insert(", ".delete(", 'from("subscriptions")']) {
    assert.ok(!block.includes(forbidden), `a handler writes directly: ${forbidden}`);
  }
});

test("webhook: the deleted handler uses Stripe's own ended_at", () => {
  assert.ok(serviceCode.includes("subscription.ended_at"));
  assert.ok(sql034.includes("coalesce(p_cancelled_at, now())"));
  // Idempotent: a redelivery does not move cancelled_at.
  const markFn = sql034.slice(sql034.indexOf("create or replace function public.mark_subscription_cancelled"));
  const guardAt = markFn.indexOf("if v_sub.status = 'cancelled' then");
  const branch = markFn.slice(guardAt, markFn.indexOf("end if;", guardAt));
  assert.ok(branch.includes("'already_cancelled'"));
  assert.ok(!branch.includes("update"), "the idempotent branch writes");
  assert.ok(!branch.includes("now()"), "the idempotent branch re-stamps cancelled_at");
});

test("webhook: prior orders and billing cycles are never touched", () => {
  for (const forbidden of ["orders", "order_items", "checkout_attempts", "payment_status", "refund"]) {
    assert.ok(!serviceCode.includes(forbidden), `the service touches ${forbidden}`);
  }
  assert.ok(!sql034.includes("public.orders"), "034 touches orders");
  assert.ok(!sql034.includes("public.checkout_attempts"), "034 touches checkout attempts");
});

test("webhook: billing failure events remain unhandled - that is Phase 3E", () => {
  for (const deferred of [
    "invoice.payment_failed", "invoice.payment_action_required",
    "customer.subscription.paused", "customer.subscription.resumed",
  ]) {
    assert.ok(!webhookCode.includes(deferred), `${deferred} was handled in this phase`);
  }
  // And nothing here writes past_due or unpaid, so 3E owns that decision.
  const setClauses = [...sql034.matchAll(/update public\.subscriptions\s+set([\s\S]*?)where id = v_sub\.id/g)].map(m => m[1]).join(" ");
  assert.ok(!setClauses.includes("'past_due'"));
  assert.ok(!setClauses.includes("'unpaid'"));
});

/* ══════════════════════════════════════════════════════════════
   FEATURE FLAG
   ══════════════════════════════════════════════════════════════ */

test("FLAG: cancellation is NOT gated by the purchase flag", () => {
  // A customer whose bookings were switched off must still be able to end
  // a contract they are paying for.
  for (const source of [routeCode, serviceCode, rulesCode]) {
    assert.ok(!source.includes("B2C_SUBSCRIPTIONS_ENABLED"), "cancellation reads the purchase flag");
    assert.ok(!source.includes("isSubscriptionCheckoutEnabled"), "cancellation reads the purchase flag");
  }
});

test("FLAG: purchase remains fail-closed and unchanged", () => {
  const checkoutRules = withoutComments(read("lib/subscriptionCheckoutRules.ts"));
  assert.ok(checkoutRules.includes('return env[SUBSCRIPTION_FEATURE_FLAG] === "true";'));
  const checkout = withoutComments(read("lib/subscriptionCheckout.ts"));
  assert.ok(checkout.includes("if (!deps.isEnabled()) {"));
  // Against the CALL, not the deps type declaration, which necessarily
  // names verifyCaller earlier in the file.
  const handler = checkout.slice(checkout.indexOf("export async function handleSubscriptionCheckout"));
  assert.ok(
    handler.indexOf("if (!deps.isEnabled())") < handler.indexOf("deps.verifyCaller(request)"),
    "the flag no longer runs first"
  );
  assert.match(read(".env.example"), /^B2C_SUBSCRIPTIONS_ENABLED=$/m);
});

/* ══════════════════════════════════════════════════════════════
   RESPONSE AND LOGGING
   ══════════════════════════════════════════════════════════════ */

test("response: only truthful, non-sensitive facts", () => {
  // The payload object only. `{ status: 200 }` is the HTTP status option
  // that follows it, not a field the customer receives.
  const at = routeBody.lastIndexOf("Response.json(");
  const payload = routeBody.slice(at, routeBody.indexOf("satisfies CancelResponse", at));
  const fields = [...payload.matchAll(/^\s+(\w+)[:,]/gm)].map(m => m[1]);
  assert.deepEqual(fields.sort(), [
    "cutoffAt", "effectiveCancelAt", "newlyScheduled", "ok", "scheduled", "timing",
  ]);
  for (const forbidden of [
    "stripe", "customer", "email", "userId", "user_id", "subscriptionId", "_cents", "plan", "status",
  ]) {
    assert.ok(!payload.includes(forbidden), `the response exposes ${forbidden}`);
  }
});

test("response: a refusal never claims a cancellation", () => {
  const messages = routeCode.slice(routeCode.indexOf("const REFUSAL_MESSAGES"));
  const block = messages.slice(0, messages.indexOf("};"));
  assert.equal([...block.matchAll(/^\s+\w+:/gm)].length, 4);
  for (const forbidden of ["gekündigt.", "wurde beendet", "storniert"]) {
    assert.ok(!block.includes(forbidden), `a refusal claims ${forbidden}`);
  }
});

test("logging: no PII reaches a log line", () => {
  for (const source of [routeCode, serviceCode]) {
    const logs = [...source.matchAll(/console\.\w+\(([\s\S]*?)\);/g)].map(m => m[1]);
    for (const line of logs) {
      for (const forbidden of [
        "caller.email", "customer_snapshot", "snapshot", "address", "userId",
        "JSON.stringify", "rawBody", "parsed",
      ]) {
        assert.ok(!line.includes(forbidden), `a log line contains ${forbidden}: ${line}`);
      }
    }
  }
});

/* ══════════════════════════════════════════════════════════════
   REGRESSIONS
   ══════════════════════════════════════════════════════════════ */

test("regression: invoice.paid and checkout.session.completed are unchanged", () => {
  assert.ok(webhookCode.includes('event.type === "invoice.paid"'));
  assert.ok(webhookCode.includes("handleInvoicePaid(stripe, event)"));
  assert.ok(webhookCode.includes('event.type === "checkout.session.completed"'));
  assert.ok(webhookCode.includes("handleSubscriptionSessionCompleted(stripe, session)"));
  const invoice = withoutComments(read("lib/subscriptionInvoiceFulfillment.ts"));
  assert.ok(invoice.includes('admin.rpc("activate_subscription_from_invoice"'));
  assert.ok(invoice.includes("createOrderFromPaidCheckoutAttempt("));
  assert.ok(!invoice.includes("cancel"), "invoice fulfillment learned about cancellation");
});

test("regression: the order cancellation and refund systems are untouched", () => {
  const orderCancel = withoutComments(read("app/api/internal/orders/cancel/route.ts"));
  assert.deepEqual([...orderCancel.matchAll(/\.rpc\("(\w+)"/g)].map(m => m[1]), ["cancel_order"]);
  const resolve = withoutComments(read("app/api/internal/orders/cancellation-request/resolve/route.ts"));
  assert.deepEqual([...resolve.matchAll(/\.rpc\("(\w+)"/g)].map(m => m[1]),
    ["resolve_order_cancellation_request"]);
  assert.ok(webhookCode.includes("syncOrderRefundStateFromStripe(stripe, paymentIntentId)"));
  assert.ok(webhookCode.includes("isNewSettledRefundFact(outcome.result)"));
  // Subscription cancellation and ORDER cancellation are separate systems.
  for (const forbidden of ["cancel_order", "request_order_cancellation", "resolve_order_cancellation"]) {
    assert.ok(!serviceCode.includes(forbidden), `the subscription service touches ${forbidden}`);
    assert.ok(!sql034.includes(forbidden), `034 touches ${forbidden}`);
  }
});

test("regression: no Stripe write API for refunds appeared", () => {
  const STRIPE_WRITES = [["refunds", ".create"], ["refunds", ".cancel"], ["paymentIntents", ".cancel"]]
    .map(parts => parts.join(""));
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
  assert.deepEqual(offenders, []);
});

test("regression: no account UI, no email and no legal copy changed", () => {
  const portal = read("app/AccountPortal.tsx");
  assert.ok(!portal.includes("/api/subscriptions/cancel"), "the account UI gained a cancel control");
  // NOT a bare cancellation_requested_at check: the portal legitimately
  // reads orders.cancellation_requested_at, which is the Phase 2A ORDER
  // cancellation request and a different system entirely. What must be
  // absent is any use of the new SUBSCRIPTION columns.
  assert.ok(!portal.includes("sub.cancel_at\b"), "the account UI reads subscription cancel_at");
  assert.ok(!portal.includes("subscriptionCancel"), "the account UI calls the cancellation service");
  assert.ok(!portal.includes("schedule_subscription_cancellation"));
  // No new email template.
  const templates = readdirSync(path.join(ROOT, "lib/email")).sort();
  assert.equal(templates.length, 7, "an email template was added");
  assert.ok(!templates.some(n => /subscription/i.test(n)));
  for (const source of [routeCode, serviceCode, rulesCode]) {
    for (const forbidden of ["resend", "Resend", "emails.send", "GLOA_FROM_HELLO"]) {
      assert.ok(!source.includes(forbidden), `this phase sends email: ${forbidden}`);
    }
  }
});

test("regression: historical subscriptions are unaffected", () => {
  // Nullable, no default, no backfill means every existing row reads NULL
  // on both columns and nothing considers it cancelled.
  assert.ok(sql034.includes("add column if not exists cancellation_requested_at timestamptz"));
  assert.ok(sql034.includes("add column if not exists cancel_at                 timestamptz"));
  assert.ok(sql034.includes("add column if not exists cancellation_effective_at timestamptz"));
  // Every UPDATE is scoped to one row the function just locked, so
  // applying 034 cannot touch a single existing subscription.
  // mark_subscription_cancelled DOES write status - that is the
  // termination path, and it runs only for one Stripe event.
  // FOUR since Phase 3C.1: scheduling gained the CASE C single-column
  // write that records a customer request the webhook raced past.
  // FIVE since Phase 3C.2: applying a deferred late cancellation.
  const updates = [...sql034.matchAll(/update public\.subscriptions[\s\S]*?;/g)].map(m => m[0]);
  assert.equal(updates.length, 5, "unexpected number of UPDATE statements");
  for (const stmt of updates) {
    assert.ok(stmt.includes("where id = v_sub.id"), "an unscoped UPDATE exists");
  }
  // And nothing enumerates subscriptions - the only entry points are one
  // authenticated request and two Stripe events for one subscription id.
  const vercel = JSON.parse(read("vercel.json"));
  assert.equal((vercel.crons ?? []).length, 1);
  assert.equal(vercel.crons[0].path, "/api/cron/retry-order-notifications");
});

test("regression: SHOP_STATUS and the subscription flag are unchanged", () => {
  assert.ok(read("app/content.ts").includes('export const SHOP_STATUS = "prelaunch" as const;'));
  assert.match(read(".env.example"), /^B2C_SUBSCRIPTIONS_ENABLED=$/m);
  const declared = [...read(".env.example").matchAll(/^([A-Z_0-9]+)=/gm)].map(m => m[1]);
  assert.equal(new Set(declared).size, declared.length);
});

/* ══════════════════════════════════════════════════════════════
   THE HTTP BOUNDARY, ON A REAL SPAWNED SERVER
   ══════════════════════════════════════════════════════════════ */

const ENDPOINT_PATH = "/api/subscriptions/cancel";

/**
 * Started without SUPABASE_SECRET_KEY and without STRIPE_SECRET_KEY, so
 * no database is reachable and no Stripe client can be constructed. No
 * subscription can be cancelled by this suite.
 */
function serverEnv(extra) {
  const env = writeBlockedServerEnv({ ...extra });
  delete env.STRIPE_SECRET_KEY;
  delete env.RESEND_API_KEY;
  delete env.B2C_SUBSCRIPTIONS_ENABLED;
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

const PORT = 8956;
let server;

test.before(async () => {
  server = await startServer(PORT, {});
});

test.after(() => {
  server?.kill();
});

test("http: an unauthenticated caller cannot cancel", async () => {
  const res = await post(PORT, { subscriptionId: SUB_ID });
  assert.equal(res.status, 401);
  const parsed = await res.json();
  assert.equal(parsed.ok, undefined);
  assert.equal(parsed.error, "Bitte melde dich an.");
});

test("http: a malformed or absent bearer token is not authentication", async () => {
  for (const authorization of [
    "Bearer", "Bearer ", "Bearer nonsense", "Basic abc",
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyIn0.notarealsignature",
  ]) {
    const res = await post(PORT, { subscriptionId: SUB_ID }, { authorization });
    assert.equal(res.status, 401, authorization);
  }
});

test("http: authentication is checked before any subscription is looked at", async () => {
  const valid = await post(PORT, { subscriptionId: SUB_ID });
  const malformedId = await post(PORT, { subscriptionId: "nope" });
  const unknownField = await post(PORT, { subscriptionId: SUB_ID, cancelAt: "2026-01-01" });
  for (const res of [valid, malformedId, unknownField]) assert.equal(res.status, 401);
});

test("http: a non-JSON content type and an oversized body are refused", async () => {
  const wrongType = await fetch(`http://127.0.0.1:${PORT}${ENDPOINT_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: "subscriptionId=x",
  });
  assert.equal(wrongType.status, 400);

  const oversized = await post(PORT, JSON.stringify({ subscriptionId: SUB_ID, pad: "x".repeat(5_000) }));
  assert.equal(oversized.status, 413);
});

test("http: GET, PUT, PATCH and DELETE are not surfaces", async () => {
  for (const method of ["GET", "PUT", "PATCH", "DELETE"]) {
    const res = await fetch(`http://127.0.0.1:${PORT}${ENDPOINT_PATH}`, { method });
    assert.ok(res.status === 404 || res.status === 405, `${method} answered ${res.status}`);
  }
});

test("http: no response ever confirms a cancellation or leaks a fact", async () => {
  const responses = await Promise.all([
    post(PORT, { subscriptionId: SUB_ID }),
    post(PORT, { subscriptionId: "nope" }),
    post(PORT, {}),
  ]);
  for (const res of responses) {
    const text = await res.text();
    for (const forbidden of ["scheduled", "cancelAt", "effectiveCancelAt", "@", "sub_", "cus_"]) {
      assert.ok(!text.includes(forbidden), `a response contained ${forbidden}`);
    }
  }
});

test("no real Stripe request, no Resend request and no production Supabase in this suite", () => {
  const suite = withoutComments(read("tests/subscription-cancellation.test.mjs"));
  const forbidden = [
    ["create", "Client("], ["new ", "Resend("], ["new ", "Stripe("],
    ["supabase", ".co"], ["api.", "stripe.com"], ["api.", "resend.com"],
  ].map(parts => parts.join(""));
  for (const needle of forbidden) {
    assert.ok(!suite.includes(needle), `the suite performs: ${needle}`);
  }
  const spawns = [...suite.matchAll(/spawn\(process\.execPath[\s\S]*?\}\)/g)];
  assert.equal(spawns.length, 1, "a server is spawned outside the guarded helper");
  assert.ok(spawns[0][0].includes("serverEnv("));
});
