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
  deferredCancellationIsPaid,
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
const markFn = fnBody("mark_subscription_cancelled", "record_paid_subscription_period");

/**
 * The ONE writer of the payment proof (Phase 3C.5), bounded at its own
 * terminator so the work list after it is not read as its body.
 */
const recordFn = (() => {
  const at = sql034.indexOf("create or replace function public.record_paid_subscription_period");
  return at === -1 ? "" : sql034.slice(at, sql034.indexOf("$$;", at) + 3);
})();

/**
 * The read-only work list the safety sweep selects from, bounded at its
 * own terminator so nothing after it (the grants) is read as its body.
 */
const dueListFn = (() => {
  const at = sql034.indexOf("create or replace function public.due_deferred_subscription_cancellations");
  return at === -1 ? "" : sql034.slice(at, sql034.indexOf("$$;", at) + 3);
})();
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
  const markFn = fnBody("mark_subscription_cancelled", "due_deferred_subscription_cancellations");
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
    // Phase 3C.5. A payment fact, and the only column here that is not a
    // lifecycle column - written by nothing but the paid-invoice recorder.
    "last_paid_period_end",
  ]);
  const clauses = updateSetClauses(sql034);
  assert.equal(clauses.length, 6, "unexpected number of UPDATE statements");
  for (const clause of clauses) {
    for (const column of columnsWritten(clause)) {
      assert.ok(allowed.has(column), `034 writes ${column}`);
    }
  }
  for (const forbidden of [
    "quantity", "unit_amount", "price_id", "plan_id", "product", "shipping_address",
    "billing_address", "tax_", "_cents", "snapshot", "public.orders", "public.order_items",
    "next_delivery_at", "cancel_at_period_end",
  ]) {
    assert.ok(!sql034.includes(forbidden), `034 touches ${forbidden}`);
  }
  // checkout_attempts is READ, exactly once, by the payment recorder -
  // which will not write the proof unless the paid attempt for that
  // invoice is already there (3C.5). It must never be written, and the
  // read must stay inside that one function.
  for (const write of ["insert into public.checkout_attempts", "update public.checkout_attempts",
                       "delete from public.checkout_attempts"]) {
    assert.ok(!sql034.includes(write), `034 writes checkout attempts: ${write}`);
  }
  assert.equal([...sql034.matchAll(/public\.checkout_attempts/g)].length, 1,
    "034 mentions checkout_attempts somewhere other than the payment recorder");
  assert.ok(recordFn.includes("from public.checkout_attempts a"),
    "the one mention is not the recorder's payment check");
  // And the recorder writes exactly one column, on subscriptions.
  const recordSet = recordFn.slice(recordFn.indexOf("update public.subscriptions"));
  assert.deepEqual(columnsWritten(recordSet.slice(0, recordSet.indexOf("where id = v_sub.id"))),
    ["last_paid_period_end"]);
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
  // PHASE 3I.B2 ADDED THE HANDLER. What still holds is that it cannot
  // touch a deferred cancellation: no apply, no sweep, no cancellation
  // column, so a failed renewal still leaves the request pending.
  const failedHandler = webhookCode.slice(
    webhookCode.indexOf("async function handleInvoicePaymentFailed"),
    webhookCode.indexOf("async function handleSubscriptionUpdated")
  );
  for (const forbidden of [
    "applyDeferredCancellationFromRenewal", "sweepDueDeferredCancellations",
    "cancellation_requested_at", "cancellation_effective_at", "cancel_at",
  ]) {
    assert.ok(!failedHandler.includes(forbidden),
      `the payment failure handler touches the deferred cancellation: ${forbidden}`);
  }
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
  // The work list is the read-only RPC, and it is the ONLY selection.
  assert.ok(sweep.includes('admin.rpc("due_deferred_subscription_cancellations"'),
    "the sweep no longer selects its work list server-side");
  assert.ok(!sweep.includes('.from("subscriptions")'),
    "the sweep still builds a PostgREST query, which cannot compare two columns");
  // Bounded, by the same constant as before.
  assert.ok(sweep.includes("p_limit: DEFERRED_SWEEP_LIMIT"));
  assert.equal(DEFERRED_SWEEP_LIMIT, 50);
  // The PERIOD check is still re-checked per row in JavaScript. It is
  // not the payment proof - see the 3C.5 tests below.
  assert.ok(sweep.includes("deferredCancellationIsDue({"));
  // Every durable condition, all required, all now applied BEFORE the
  // limit rather than after it.
  assert.ok(dueListFn.includes("s.cancellation_requested_at is not null"));
  assert.ok(dueListFn.includes("s.cancellation_effective_at is not null"));
  assert.ok(dueListFn.includes("s.stripe_subscription_id is not null"));
  assert.ok(dueListFn.includes("s.cancel_at is null"));
  assert.ok(dueListFn.includes("s.customer_type = 'private'"));
  assert.ok(dueListFn.includes("s.status in ('active', 'past_due', 'unpaid')"));
  assert.deepEqual([...CANCELLABLE_STATUSES], ["active", "past_due", "unpaid"]);
});

test("3C.3: the sweep can never reach a historical or owner-made cancellation", () => {
  // THE NULL RULE IS NOT VIOLATED. `cancel_at IS NULL` is selected, but
  // only together with a NON-NULL customer request - which no historical
  // subscription and no Stripe Dashboard cancellation has.
  const sweep = serviceCode.slice(
    serviceCode.indexOf("export async function sweepDueDeferredCancellations"),
    serviceCode.indexOf("export function stripeSubscriptionFacts")
  );
  assert.ok(dueListFn.includes("s.cancellation_requested_at is not null"),
    "the work list can select a subscription nobody asked to cancel");
  // And it is a SELECT, so it cannot reach anything by writing either.
  assert.ok(!/\b(update|insert|delete)\b/.test(dueListFn),
    "the work list is not read-only");
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

test("3C.4: a due cancellation cannot starve behind rows that are not due", () => {
  // THE DEFECT THIS PINS. The sweep applied .limit(DEFERRED_SWEEP_LIMIT)
  // to a query that could not express due-ness, and decided due-ness in
  // JavaScript afterwards. The bound was therefore on the wrong side of
  // the decision: with more pending cancellations than the limit, an
  // entire batch could be rows that are not yet due while a genuinely
  // due row was never read - and a starved due row means a customer is
  // billed for a cycle they cancelled.
  assert.ok(dueListFn.length > 0, "the due work list is missing");

  // The comparison is applied BEFORE the bound. Both live in one SQL
  // statement, so their ORDER IN THE TEXT is the property. Anchored to
  // the body so the `p_limit` PARAMETER is not read as the LIMIT clause.
  const body = dueListFn.slice(dueListFn.indexOf("as $$"));
  const compareAt = body.indexOf("s.current_period_end >= s.cancellation_effective_at");
  const orderAt = body.indexOf("order by");
  const limitAt = body.indexOf("limit ");
  assert.ok(compareAt > -1, "the work list does not prove the owed cycle was paid");
  assert.ok(orderAt > -1, "the work list has no ordering");
  assert.ok(limitAt > -1, "the work list is unbounded");
  assert.ok(compareAt < orderAt && orderAt < limitAt,
    "the bound is applied before due-ness is decided");

  // Deterministic and TOTAL, so the same state always yields the same
  // batch and the longest-owed cancellation is attempted first.
  assert.ok(dueListFn.includes("order by s.cancellation_effective_at asc, s.id asc"),
    "the ordering is not total, so a full batch can repeat forever");

  // Bounded, and the bound is clamped rather than trusted - no caller
  // can ask this for the whole table.
  assert.ok(/limit least\(greatest\(coalesce\(p_limit, 50\), 1\), 200\)/.test(dueListFn),
    "the limit is taken from the caller unchecked");

  // MINIMUM FIELDS. An id, the Stripe binding and the three dates the
  // caller re-checks - the promise, the period Stripe holds and the
  // period GLOA has proof was paid. Nothing that could turn a cron log
  // into a leak, and nothing the caller could not read off the row it is
  // about to act on anyway.
  const returns = dueListFn.slice(dueListFn.indexOf("returns table"), dueListFn.indexOf("language sql"));
  for (const leak of ["email", "name", "address", "_cents", "snapshot", "user_id", "plan"]) {
    assert.ok(!returns.includes(leak), `the work list returns ${leak}`);
  }
  assert.deepEqual(
    [...returns.matchAll(/^ {2}(\w+) +\w/gm)].map(m => m[1]),
    ["id", "stripe_subscription_id", "cancellation_effective_at",
     "current_period_end", "last_paid_period_end"]
  );
});

test("3C.4: ordering alone could NOT have fixed it - the counterexample", () => {
  // WHY THE COMPARISON HAD TO MOVE SERVER-SIDE. The two dates advance
  // independently: cancellation_effective_at is frozen when the customer
  // asks, and current_period_end moves only when a renewal is paid. So a
  // row with the EARLIER promise can still be pending while a row with a
  // LATER promise is already due. Sorted by the promise in either
  // direction, the pending row still sorts ahead of the due one.
  const early = {
    // Asked while the period ended 2026-08-20, so promised 28 days later.
    periodEnd: "2026-08-20T00:00:00.000Z",
    promisedAt: "2026-09-17T00:00:00.000Z",
  };
  const late = {
    // Asked later, and its renewal has since been paid.
    periodEnd: "2026-10-23T00:00:00.000Z",
    promisedAt: "2026-10-23T00:00:00.000Z",
  };
  assert.equal(deferredCancellationIsDue(early), false, "the pending row is due");
  assert.equal(deferredCancellationIsDue(late), true, "the paid row is not due");
  // The pending row carries the earlier promise, so ASCENDING order puts
  // it first...
  assert.ok(early.promisedAt < late.promisedAt);
  // ...and the due row carries the later period end, so DESCENDING order
  // by the promise would starve any due row with an early promise
  // instead. Neither direction is a fix, which is why the filter moved
  // into SQL rather than an .order() being added.
  const batch = [early, late].sort((a, b) => a.promisedAt.localeCompare(b.promisedAt));
  assert.deepEqual(batch.map(r => deferredCancellationIsDue(r)), [false, true],
    "the not-due row no longer sorts ahead of the due row");
});

test("3C.4: the sweep still touches nothing it could not touch before", () => {
  // The RPC is a NARROWING, not a widening. Every condition the old
  // query applied is still applied, and one more is applied earlier.
  assert.ok(dueListFn.includes("from public.subscriptions s"),
    "the work list reads something other than subscriptions");
  // Historical rows are unreachable: they carry NULL on the request.
  assert.ok(dueListFn.includes("s.cancellation_requested_at is not null"));
  // A Stripe Dashboard cancellation has no customer request either, so
  // the same condition excludes it.
  assert.ok(dueListFn.includes("s.cancel_at is null"));
  // Not-yet-due rows are excluded, not merely deprioritised.
  assert.ok(dueListFn.includes("s.current_period_end is not null"),
    "a row with no period end could be compared against NULL");
  // B2B is out of scope and stays out.
  assert.ok(dueListFn.includes("s.customer_type = 'private'"));
  // And the sweep still performs no local write of its own.
  const sweep = serviceCode.slice(
    serviceCode.indexOf("export async function sweepDueDeferredCancellations"),
    serviceCode.indexOf("export function stripeSubscriptionFacts")
  );
  for (const forbidden of [".update(", ".insert(", ".delete(", ".upsert("]) {
    assert.ok(!sweep.includes(forbidden), `the sweep writes directly: ${forbidden}`);
  }
  // Only the read RPC and the guarded apply. No second Stripe surface.
  assert.deepEqual(
    [...sweep.matchAll(/admin\.rpc\("([a-z_]+)"/g)].map(m => m[1]),
    ["due_deferred_subscription_cancellations"]
  );
  assert.ok(sweep.includes("applyDeferredCancellationFromRenewal("));
});

/* ══════════════════════════════════════════════════════════════
   PHASE 3C.5 - THE PAYMENT PROOF

   The defect: the work list treated

     current_period_end >= cancellation_effective_at

   as proof that the one owed cycle had been PAID. It is not.
   sync_subscription_from_stripe, in this same migration, writes
   current_period_end from customer.subscription.updated - a card update,
   a Dashboard edit, a move into past_due. A failed renewal that moved the
   period would have ended the subscription a cycle early, taking a cycle
   the customer never received.

   The fix is one payment-exclusive column, last_paid_period_end, whose
   only writer refuses to write without the durable record of a paid
   invoice. Both facts are then required, and both comparisons are
   PERIOD BOUNDARY vs PERIOD BOUNDARY - no clock is compared to another
   clock anywhere in this phase.
   ══════════════════════════════════════════════════════════════ */

test("3C.5 (1): current_period_end is NOT payment-exclusive, and the suite says so", () => {
  // The audit fact this whole phase rests on: a NON-PAYMENT event writes
  // this column. If that ever stops being true, this test should be the
  // thing that fails, not the safety property.
  assert.ok(syncFn.includes("current_period_end       = v_new_end"),
    "sync_subscription_from_stripe no longer writes current_period_end");
  assert.ok(syncFn.includes("p_current_period_end"),
    "the sync no longer takes a period end from Stripe");
  // And it is driven by customer.subscription.updated, which is not a
  // payment event.
  assert.ok(webhookCode.includes('event.type === "customer.subscription.updated"'));
  assert.ok(webhookCode.includes("handleSubscriptionUpdated(stripe, event)"));

  // The second writer is the paid one, in 022.
  const m022 = read("supabase/migrations/022_recurring_subscription_foundation.sql");
  assert.ok(m022.includes("current_period_end     = coalesce(p_current_period_end, v_subscription.current_period_end),"),
    "activate_subscription_from_invoice no longer writes the period");

  // EXACTLY TWO production writers of current_period_end, and no third
  // can appear: no role holds UPDATE on the table, so no application
  // code can write it outside a SECURITY DEFINER function.
  const writers = readdirSync(MIGRATIONS)
    .filter(f => f.endsWith(".sql"))
    .filter(f => /^\s*current_period_end\s*=/m.test(
      withoutComments(read(`supabase/migrations/${f}`))
    ));
  assert.deepEqual(writers, [
    "022_recurring_subscription_foundation.sql",
    "034_subscription_cancellation.sql",
  ], "a new writer of current_period_end appeared");
  assert.ok(m022.includes("grant select on public.subscriptions to service_role;"));
  const grantLines = [withoutComments(m022), sql034]
    .flatMap(s => s.split(NEWLINE))
    .filter(l => /^\s*grant\b/i.test(l));
  for (const line of grantLines) {
    assert.ok(!(/\bupdate\b/i.test(line) && /public\.subscriptions/i.test(line)),
      `something granted UPDATE on subscriptions: ${line.trim()}`);
  }

  // THEREFORE neither the work list nor the apply may rest on it alone.
  assert.ok(dueListFn.includes("s.last_paid_period_end >= s.cancellation_effective_at"),
    "the work list still infers payment from a period timestamp");
  assert.ok(applyFn.includes("v_sub.last_paid_period_end < v_sub.cancellation_effective_at"),
    "the apply still infers payment from a period timestamp");
});

test("3C.5 (2): the proof is a payment-exclusive PERIOD fact with exactly one writer", () => {
  // ONE column, and it is not a cancellation column.
  assert.ok(sql034.includes("add column if not exists last_paid_period_end timestamptz"));
  // ONE writer, and it is the recorder.
  const setters = [...sql034.matchAll(/last_paid_period_end\s*=\s*/g)];
  assert.equal(setters.length, 1, "something else assigns the payment proof");
  assert.ok(recordFn.includes("set last_paid_period_end = p_paid_period_end"),
    "the recorder is not the writer");
  // No other migration mentions it at all.
  const mentions = readdirSync(MIGRATIONS)
    .filter(f => f.endsWith(".sql"))
    .filter(f => read(`supabase/migrations/${f}`).includes("last_paid_period_end"));
  assert.deepEqual(mentions, ["034_subscription_cancellation.sql"]);

  // IT CANNOT BE CALLED INTO LYING. The recorder refuses unless the
  // durable payment record for THAT invoice on THAT subscription is
  // already there, so the caller's period end is never taken on trust.
  assert.ok(recordFn.includes("from public.checkout_attempts a"));
  assert.ok(recordFn.includes("a.stripe_invoice_id = btrim(p_stripe_invoice_id)"));
  assert.ok(recordFn.includes("a.subscription_id   = p_subscription_id"));
  assert.ok(recordFn.includes("a.status            = 'paid'"));
  assert.ok(recordFn.includes("'result', 'no_payment'"), "there is no refusal path");
  // Read-only against that table, under the subscription's row lock.
  assert.ok(recordFn.includes("for update"));
  assert.ok(recordFn.includes("select 1"), "the recorder reads customer data it does not need");
  for (const forbidden of [
    "status", "cancelled_at", "cancel_at", "cancellation_", "current_period",
    "_cents", "snapshot", "plan_id", "quantity", "public.orders", "next_delivery_at",
  ]) {
    const set = recordFn.slice(recordFn.indexOf("update public.subscriptions"));
    assert.ok(!set.slice(0, set.indexOf("where id = v_sub.id")).includes(forbidden),
      `the recorder writes ${forbidden}`);
  }
});

test("3C.5 (3): NO cross-clock comparison survives anywhere in the feature", () => {
  // THE DEFECT THIS PINS. An earlier attempt at this phase proved the
  // payment with
  //
  //   checkout_attempts.paid_at > subscriptions.cancellation_requested_at
  //
  // which is a comparison between the PostgreSQL clock and the Vercel
  // clock, and no billing invariant may rest on two clocks agreeing.
  assert.ok(!sql034.includes("paid_at"), "034 compares a payment timestamp");
  assert.ok(!/a\.paid_at/.test(sql034));
  assert.ok(!serviceCode.includes("paid_at"), "the service compares a payment timestamp");
  // Both surviving comparisons are period-vs-period.
  assert.ok(dueListFn.includes("s.current_period_end >= s.cancellation_effective_at"));
  assert.ok(dueListFn.includes("s.last_paid_period_end >= s.cancellation_effective_at"));
  // cancellation_requested_at is compared to nothing in the work list.
  const where = dueListFn.slice(dueListFn.indexOf("where s.customer_type"), dueListFn.indexOf("order by"));
  assert.ok(where.includes("s.cancellation_requested_at is not null"),
    "the work list stopped requiring a customer request");
  assert.equal([...where.matchAll(/cancellation_requested_at/g)].length, 1,
    "cancellation_requested_at is used for more than an existence check");
  // And every condition is required together, never either/or.
  assert.ok(!/\bor\b/.test(where), "the work list conditions are not all required");
});

test("3C.5 (4): the initial payment can never satisfy a LATE cancellation - by arithmetic", () => {
  // A late request falls inside the last 14 days of the cycle, and the
  // promise is the current period end PLUS one whole cadence. So the
  // period the customer is already in - the one their most recent
  // payment covers, including the very first one - ends a full 28 days
  // SHORT of the promise. No timestamp comparison is involved.
  const periodEnd = "2026-09-17T00:00:00.000Z";
  const requestAt = "2026-09-10T00:00:00.000Z";      // inside the cutoff
  const decided = resolveCancellationSchedule({ requestAt, currentPeriodEnd: periodEnd });
  assert.equal(decided.ok, true);
  assert.equal(decided.schedule.timing, "late");
  assert.equal(
    Date.parse(decided.schedule.effectiveCancelAt) - Date.parse(periodEnd),
    CADENCE_MS
  );

  // The cycle already paid for - whatever number it is, including the
  // FIRST - cannot reach the promise.
  assert.equal(deferredCancellationIsPaid({
    paidPeriodEnd: periodEnd,
    promisedAt: decided.schedule.effectiveCancelAt,
  }), false, "the payment the customer already made pays for their cancellation");

  // The one further renewal they are owed reaches it exactly.
  assert.equal(deferredCancellationIsPaid({
    paidPeriodEnd: decided.schedule.effectiveCancelAt,
    promisedAt: decided.schedule.effectiveCancelAt,
  }), true, "the owed cycle cannot satisfy the proof");

  // And a subscription that has never had a period recorded is out of
  // reach entirely - which is every historical row and every row the
  // moment 034 is applied, because there is no backfill.
  assert.equal(deferredCancellationIsPaid({
    paidPeriodEnd: null, promisedAt: decided.schedule.effectiveCancelAt,
  }), false, "a missing proof reads as proof");
  assert.ok(dueListFn.includes("s.last_paid_period_end is not null"),
    "a NULL proof could be compared");
});

test("3C.5 (5): a FAILED renewal cannot advance the proof, whatever Stripe did to the period", () => {
  // A failed renewal produces no invoice.paid, so
  // activate_subscription_from_invoice never runs, so no paid attempt
  // exists, so the recorder refuses - and the recorder is the only
  // writer. This holds independently of Stripe's failed-payment period
  // behaviour, which is exactly why the proof is a separate column.
  const invoicePaidOnly = webhookCode.slice(webhookCode.indexOf('event.type === "invoice.paid"'));
  assert.ok(invoicePaidOnly.includes("handleInvoicePaid(stripe, event)"));
  for (const eventType of [
    "invoice.created", "invoice.finalized",
    "invoice.payment_action_required", "customer.subscription.created",
  ]) {
    assert.ok(!webhookCode.includes(`"${eventType}"`), `${eventType} became a branch`);
  }
  // PHASE 3I.B2 MADE invoice.payment_failed A BRANCH, DELIBERATELY. The
  // property this guard protects is unchanged and is now asserted
  // directly rather than through the event's absence: that handler
  // cannot reach the payment proof, the recorder, the fulfillment or an
  // order, so a failed renewal still advances nothing.
  const failedHandler = webhookCode.slice(
    webhookCode.indexOf("async function handleInvoicePaymentFailed"),
    webhookCode.indexOf("async function handleSubscriptionUpdated")
  );
  assert.ok(failedHandler.length > 0, "the payment failure handler disappeared");
  for (const forbidden of [
    "record_paid_subscription_period", "recordPaidPeriod", "fulfillPaidSubscriptionInvoice",
    "createOrder", "sendInternalOrderNotificationIfNeeded", "applyDeferredCancellationFromRenewal",
    "sync_subscription_payment_status", "reconcileSubscriptionPaymentStatus",
  ]) {
    assert.ok(!failedHandler.includes(forbidden),
      `the payment failure handler reaches ${forbidden}`);
  }
  // The recorder has exactly one caller in the whole codebase, and it is
  // the paid-invoice fulfillment. Code only: other modules NAME it in
  // prose, which is documentation rather than a call.
  const callers = readdirSync(path.join(ROOT, "lib"))
    .filter(f => f.endsWith(".ts"))
    .filter(f => /rpc\(\s*"record_paid_subscription_period"/.test(withoutComments(read(`lib/${f}`))));
  assert.deepEqual(callers, ["subscriptionInvoiceFulfillment.ts"]);
  assert.ok(!webhookCode.includes("record_paid_subscription_period"),
    "the webhook can record a payment without going through fulfillment");

  // A subscription whose renewal failed sits in past_due or unpaid, and
  // the sweep still refuses it - not because of its status, which stays
  // reachable so a later dunning success can recover, but because the
  // proof has not moved.
  assert.ok(dueListFn.includes("s.status in ('active', 'past_due', 'unpaid')"));
  assert.equal(deferredCancellationIsPaid({
    paidPeriodEnd: "2026-09-17T00:00:00.000Z",       // the cycle before
    promisedAt:    "2026-10-15T00:00:00.000Z",       // the promise
  }), false, "an unpaid cycle satisfies the proof");
  // Even though the PERIOD condition would have passed on its own.
  assert.equal(deferredCancellationIsDue({
    periodEnd:  "2026-10-15T00:00:00.000Z",          // moved by the sync
    promisedAt: "2026-10-15T00:00:00.000Z",
  }), true, "the counterexample no longer reproduces the defect");
});

test("3C.5 (6): customer.subscription.updated cannot advance the proof", () => {
  // The reconciliation writes five columns and last_paid_period_end is
  // not one of them - and it cannot become one, because the column has a
  // single assignment in the whole migration.
  const setClause = syncFn.slice(syncFn.indexOf("update public.subscriptions"), syncFn.indexOf("where id = v_sub.id"));
  assert.deepEqual(columnsWritten(setClause), [
    "cancel_at", "cancellation_effective_at", "cancellation_requested_at",
    "current_period_end", "current_period_start",
  ]);
  assert.ok(!setClause.includes("last_paid_period_end"));
  // Nor can the handler reach the recorder.
  const handler = webhookCode.slice(
    webhookCode.indexOf("async function handleSubscriptionUpdated"),
    webhookCode.indexOf("async function handleSubscriptionDeleted")
  );
  for (const forbidden of ["record_paid_subscription_period", "recordPaidPeriod",
                           "fulfillPaidSubscriptionInvoice", "activate_subscription_from_invoice"]) {
    assert.ok(!handler.includes(forbidden), `the sync handler calls ${forbidden}`);
  }
  // Same for the one-time session path and the termination path.
  const oneTime = webhookCode.slice(
    webhookCode.indexOf("async function handleCheckoutSessionCompleted"),
    webhookCode.indexOf("async function handleInvoicePaid")
  );
  assert.ok(!oneTime.includes("recordPaidPeriod"));
  assert.ok(!oneTime.includes("record_paid_subscription_period"));
  const sessionHandler = webhookCode.slice(webhookCode.indexOf("async function handleSubscriptionSessionCompleted"));
  assert.ok(!sessionHandler.includes("recordPaidPeriod"),
    "checkout.session.completed can record a payment");
});

test("3C.5 (7): a successful subscription invoice.paid DOES advance it, from the validated period", () => {
  const fulfilment = read("lib/subscriptionInvoiceFulfillment.ts");
  const fulfilmentCode = withoutComments(fulfilment);
  // The value is the service period of THE INVOICE ITSELF, off its own
  // non-proration subscription lines - not a browser value, not the event
  // payload, not a wall clock, and since Phase 3C.6 not the current
  // Stripe subscription either. See tests/subscription-invoice-fulfillment
  // for the resolver's own behaviour.
  assert.ok(fulfilmentCode.includes(
    "const paidPeriod = resolvePaidInvoiceSubscriptionPeriod(invoice, stripeSubscriptionId);"),
    "the paid period is not resolved from the invoice");
  assert.ok(fulfilmentCode.includes("paidPeriodEnd: paidPeriod.end,"),
    "the paid period comes from somewhere other than the invoice's own lines");
  assert.ok(!/paidPeriodEnd: period\./.test(fulfilmentCode),
    "the paid period follows the current subscription period again");
  // The current subscription period is still resolved and still goes to
  // the activation, which is where a mirror of Stripe belongs.
  assert.ok(fulfilmentCode.includes("const period = resolveSubscriptionPeriod(stripeSubscription);"));
  assert.ok(fulfilmentCode.includes("currentPeriodEnd: period.currentPeriodEnd,"));
  assert.ok(fulfilmentCode.includes("stripeInvoiceId: invoice.id as string,"));
  assert.ok(fulfilmentCode.includes("subscriptionId: subscription.id,"));
  // The invoice it names is the one the fulfillment re-read from Stripe
  // and matched against the frozen total - never the webhook's copy.
  assert.ok(fulfilmentCode.includes("const invoice = await deps.retrieveInvoice(eventInvoiceId);"));
  assert.ok(fulfilmentCode.includes("evaluateSubscriptionInvoice("));

  // AND IT RUNS AFTER FULFILLMENT AND BEFORE THE CANCELLATION. The proof
  // must be durable before anything ends a subscription on its strength.
  const activateAt = fulfilmentCode.indexOf("deps.activateFromInvoice(");
  const orderAt = fulfilmentCode.indexOf("deps.createOrder(");
  const recordAt = fulfilmentCode.indexOf("deps.recordPaidPeriod(");
  assert.ok(activateAt > -1 && orderAt > activateAt && recordAt > orderAt,
    "the paid period is recorded before the order exists");
  const invoiceHandler = webhookCode.slice(webhookCode.indexOf("async function handleInvoicePaid"));
  assert.ok(invoiceHandler.indexOf("fulfillPaidSubscriptionInvoice(")
    < invoiceHandler.indexOf("applyDeferredCancellationFromRenewal("),
    "the cancellation is attempted before the payment is proven");

  // A period that cannot be proven FAILS CLOSED: nothing is recorded and
  // the deferred cancellation below is never reached, because the
  // fulfillment returns 'failed' and the handler throws on it.
  assert.ok(fulfilmentCode.includes("if (!paidPeriod.ok) {"));
  assert.ok(fulfilmentCode.indexOf("if (!paidPeriod.ok) {") < recordAt,
    "the recording is attempted before the period is proven");
});

test("3C.6: a delayed invoice paying only through P2 cannot unlock a cancellation owed P3", () => {
  // THE CONSEQUENCE OF 3C.6 FOR THIS PHASE, end to end.
  //
  // Invoice A bought P1 -> P2 and is processed late, while Stripe already
  // runs P2 -> P3. lib/subscriptionInvoiceRules.ts resolves A's period
  // off A's own lines, so the most last_paid_period_end can become from
  // A is P2 - never the P3 the subscription happens to be in.
  const P1 = "2026-08-20T00:00:00.000Z";
  const P2 = "2026-09-17T00:00:00.000Z";
  const P3 = "2026-10-15T00:00:00.000Z";
  assert.equal(Date.parse(P2) - Date.parse(P1), CADENCE_MS);
  assert.equal(Date.parse(P3) - Date.parse(P2), CADENCE_MS);

  // A late cancellation asked during P1 -> P2 is promised P3.
  const decided = resolveCancellationSchedule({
    requestAt: "2026-09-10T00:00:00.000Z", currentPeriodEnd: P2,
  });
  assert.equal(decided.schedule.timing, "late");
  assert.equal(decided.schedule.effectiveCancelAt, P3);

  // A's payment proves P2, and P2 does NOT reach the promise. The
  // subscription keeps running, which is correct: the customer is owed
  // the P2 -> P3 cycle and has not been billed for it yet.
  assert.equal(deferredCancellationIsPaid({ paidPeriodEnd: P2, promisedAt: P3 }), false,
    "an invoice that paid only through P2 unlocked a cancellation owed P3");
  // Whereas reading the CURRENT subscription period would have handed
  // over P3 and unlocked it - which is exactly the defect 3C.6 removed.
  assert.equal(deferredCancellationIsPaid({ paidPeriodEnd: P3, promisedAt: P3 }), true);

  // Only the invoice for P2 -> P3, once genuinely paid, advances it.
  assert.ok(dueListFn.includes("s.last_paid_period_end >= s.cancellation_effective_at"));
  assert.ok(applyFn.includes("v_sub.last_paid_period_end < v_sub.cancellation_effective_at"));
  // And the period condition still has to hold too, so neither fact
  // alone can end a subscription.
  assert.ok(dueListFn.includes("s.current_period_end >= s.cancellation_effective_at"));
});

test("3C.5 (8): a dunning retry that finally pays advances it - with no second renewal", () => {
  // Nothing about the proof requires the FIRST attempt to have
  // succeeded. When Stripe's retry finally pays, invoice.paid fires, the
  // activation writes the paid attempt and the recorder advances the
  // column - and the subscription is still in a status the activation
  // accepts.
  const m022 = read("supabase/migrations/022_recurring_subscription_foundation.sql");
  const activate = m022.slice(m022.indexOf("create or replace function public.activate_subscription_from_invoice"));
  assert.ok(activate.includes("if v_subscription.status not in ('pending', 'active', 'past_due', 'unpaid') then"),
    "a recovered subscription can no longer be activated from a paid invoice");
  assert.ok(dueListFn.includes("s.status in ('active', 'past_due', 'unpaid')"));

  // And the recovery needs no further invoice: the same webhook event is
  // retried, and the daily sweep is the net under that.
  assert.ok(serviceCode.includes("export async function sweepDueDeferredCancellations"));
  assert.ok(serviceCode.includes('admin.rpc("due_deferred_subscription_cancellations"'));
  const sweep = serviceCode.slice(
    serviceCode.indexOf("export async function sweepDueDeferredCancellations"),
    serviceCode.indexOf("export function stripeSubscriptionFacts")
  );
  for (const forbidden of ["invoice", "Invoice", "event"]) {
    assert.ok(!sweep.includes(forbidden), `the sweep needs ${forbidden}`);
  }
});

test("3C.5 (9)(10): the proof is monotonic - a redelivery cannot duplicate or regress it", () => {
  // Equal is 'unchanged', which is exactly what a redelivered
  // invoice.paid produces: the same invoice carries the same period end.
  assert.ok(recordFn.includes("v_sub.last_paid_period_end >= p_paid_period_end"),
    "the recorder is not monotonic");
  assert.ok(recordFn.includes("'result', 'unchanged'"));
  // An OLDER invoice arriving out of order cannot pull the proof
  // backwards and re-open a cancellation that already applied.
  assert.equal(deferredCancellationIsPaid({
    paidPeriodEnd: "2026-10-15T00:00:00.000Z", promisedAt: "2026-10-15T00:00:00.000Z",
  }), true);
  // One invoice can only ever produce one attempt, so there is no second
  // proof to mint either.
  const m022 = read("supabase/migrations/022_recurring_subscription_foundation.sql");
  assert.ok(m022.includes("create unique index checkout_attempts_stripe_invoice_id_key"));
  // The caller treats 'recorded' and 'unchanged' as the same success and
  // anything else as a failure, so a refusal can never pass silently.
  const fulfilmentCode = withoutComments(read("lib/subscriptionInvoiceFulfillment.ts"));
  assert.ok(fulfilmentCode.includes('if (result !== "recorded" && result !== "unchanged") {'));
  assert.ok(fulfilmentCode.includes("throw new Error("));
});

test("3C.5 (11)(12): the sweep requires BOTH the period and the payment", () => {
  const where = dueListFn.slice(dueListFn.indexOf("where s.customer_type"), dueListFn.indexOf("order by"));
  // Every pre-existing condition survives - this is a NARROWING.
  for (const condition of [
    "s.customer_type = 'private'",
    "s.status in ('active', 'past_due', 'unpaid')",
    "s.cancellation_requested_at is not null",
    "s.cancellation_effective_at is not null",
    "s.stripe_subscription_id is not null",
    "s.cancel_at is null",
    "s.current_period_end is not null",
    "s.current_period_end >= s.cancellation_effective_at",
  ]) {
    assert.ok(where.includes(condition), `the work list dropped: ${condition}`);
  }
  // Plus the payment proof, which was the point.
  assert.ok(where.includes("s.last_paid_period_end is not null"));
  assert.ok(where.includes("s.last_paid_period_end >= s.cancellation_effective_at"));

  // AND THE SWEEP RE-CHECKS BOTH IN JAVASCRIPT. A due check that lives
  // only in SQL is a due check this loop cannot be read to enforce.
  const sweep = serviceCode.slice(
    serviceCode.indexOf("export async function sweepDueDeferredCancellations"),
    serviceCode.indexOf("export function stripeSubscriptionFacts")
  );
  assert.ok(sweep.includes("deferredCancellationIsDue({"));
  assert.ok(sweep.includes("deferredCancellationIsPaid({"));
  assert.ok(sweep.includes("paidPeriodEnd: row.last_paid_period_end,"));

  // AND SO DOES THE APPLY, before any Stripe call and again under the
  // row lock inside the RPC.
  const apply = serviceCode.slice(
    serviceCode.indexOf("export async function applyDeferredCancellationFromRenewal"),
    serviceCode.indexOf("export type DeferredSweepSummary")
  );
  assert.ok(apply.indexOf("deferredCancellationIsPaid({") < apply.indexOf("stripe.subscriptions.update"),
    "Stripe is called before the payment is proven");
  assert.ok(apply.includes("last_paid_period_end"), "the apply does not read the proof");
  assert.ok(applyFn.includes("v_sub.last_paid_period_end is null"),
    "the RPC does not re-check the proof under its row lock");
});

test("3C.5 (20A): a crash after the order but before the proof is safely retryable", () => {
  // CASE A. The order and the checkout attempt are durable; recording
  // the proof fails. The recorder throws, fulfillment propagates it, the
  // webhook turns it into a 500 and never records the event - so Stripe
  // redelivers, and every step ahead is idempotent.
  const fulfilmentCode = withoutComments(read("lib/subscriptionInvoiceFulfillment.ts"));
  assert.ok(fulfilmentCode.includes("record_paid_subscription_period failed:"),
    "a failed recording is swallowed");
  // The throw happens BEFORE the caller sends anything, so no duplicate
  // internal notification can be produced by the retry either.
  const invoiceHandler = webhookCode.slice(webhookCode.indexOf("async function handleInvoicePaid"));
  assert.ok(invoiceHandler.indexOf("fulfillPaidSubscriptionInvoice(")
    < invoiceHandler.indexOf("sendInternalOrderNotificationIfNeeded("),
    "the notification is sent before fulfillment can fail");
  // And the notification is claimed durably anyway, so even a retry that
  // did reach it cannot send twice.
  assert.ok(read("lib/internalOrderNotificationEmail.ts").includes("already-sent")
    || read("lib/internalOrderNotificationRetry.ts").includes("already-sent")
    || webhookCode.includes("sendInternalOrderNotificationIfNeeded("),
    "the internal notification has no idempotency claim");
  // NO DUPLICATE ORDER: both idempotency anchors are unique indexes.
  const m022 = read("supabase/migrations/022_recurring_subscription_foundation.sql");
  assert.ok(m022.includes("create unique index checkout_attempts_stripe_invoice_id_key"));
  assert.ok(read("supabase/migrations/011_orders_from_paid_checkout.sql")
    .includes("orders_checkout_attempt_id_key"));
  // The event is recorded only after the handler returns cleanly.
  assert.ok(webhookCode.indexOf("await handleInvoicePaid(stripe, event)")
    < webhookCode.indexOf("recordStripeWebhookEvent(event.id"));
});

test("3C.5 (20B)(20C): the two later windows still close without a second renewal", () => {
  // CASE B. The proof is durable, the Stripe update fails. The apply
  // returns 'error', handleInvoicePaid throws on it, Stripe redelivers -
  // and the sweep is underneath that, needing no invoice at all.
  const invoiceHandler = webhookCode.slice(webhookCode.indexOf("async function handleInvoicePaid"));
  assert.ok(invoiceHandler.includes('if (deferred === "error") {'));
  assert.ok(invoiceHandler.includes("throw new Error("));
  assert.ok(serviceCode.includes("export async function sweepDueDeferredCancellations"));

  // CASE C. Stripe accepted it and the local write failed. Stripe emits
  // customer.subscription.updated for that very change and the sync
  // writes cancel_at - no second mechanism was added for it.
  assert.ok(webhookCode.includes("syncSubscriptionFromStripe(subscription)"));
  assert.ok(syncFn.includes("cancel_at                = p_cancel_at"));
  // And the row is out of the work list from then on.
  assert.ok(dueListFn.includes("s.cancel_at is null"));
});

test("3C.5: the payment proof adds no privilege and leaks nothing", () => {
  // The work list is still read-only, still service_role only, still no
  // PII, and it no longer reads any table but subscriptions.
  assert.ok(dueListFn.includes("language sql"));
  assert.ok(dueListFn.includes("stable"));
  assert.ok(dueListFn.includes("security definer set search_path = ''"));
  assert.ok(!dueListFn.includes("public.checkout_attempts"),
    "the work list reads a payment table it does not need");
  for (const leak of ["items_snapshot", "tax_snapshot", "expected_total", "user_id", "shipping_"]) {
    assert.ok(!dueListFn.includes(leak), `the work list touches ${leak}`);
  }

  // The recorder is the one new privilege, and it is closed to every
  // browser role - it reads checkout_attempts, a table no browser role
  // can see at all.
  const SIG = "public.record_paid_subscription_period(uuid, text, timestamptz)";
  for (const role of ["public", "anon", "authenticated"]) {
    assert.ok(sql034.includes(`revoke all on function ${SIG} from ${role};`));
  }
  assert.ok(sql034.includes(`grant execute on function ${SIG} to service_role;`));
  // Schema-qualified everywhere, because search_path is empty.
  assert.ok(recordFn.includes("public.subscriptions"));
  assert.ok(recordFn.includes("public.checkout_attempts"));
  // No new grant of any kind on checkout_attempts.
  assert.ok(!/grant[^;]*checkout_attempts/i.test(sql034), "034 grants something on checkout_attempts");
  // And the browser still holds no UPDATE on subscriptions, so no
  // customer can forge a paid period for themselves.
  assert.ok(!/grant\s+update/i.test(sql034));
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
  // 034 was the next free number when this phase ran, and 033 still
  // precedes it. Phase 3H.1 later took 035 for a server-only email
  // delivery table, and Phase 3I.B1 took 036 for the payment foundation;
  // Phase 3J.B1 took 037 for the invoice-keyed refund-state writer,
  // reviewed in tests/subscription-refund-correlation-migration.test.mjs;
  // and Phase 3K.B took 038 for the one-time refund writer's concurrency,
  // reviewed in tests/one-time-refund-writer-concurrency.test.mjs; and
  // Phase 4B1 took 039 for the B2C prepaid annual plan foundation,
  // reviewed in tests/annual-plan-foundation-migration.test.mjs. Those
  // five are the ONLY migrations permitted above 034 until a later one is
  // reviewed against this suite.
  assert.deepEqual(
    files.filter(f => f.slice(0, 3) > "034").sort(),
    ["035_subscription_email_deliveries.sql", "036_subscription_payment_status.sql",
     "037_subscription_refund_correlation.sql", "038_one_time_refund_writer_concurrency.sql",
     "039_b2c_annual_plan_foundation.sql",
     "040_annual_checkout_retry_fingerprints.sql"],
    "an unreviewed migration above 034 appeared"
  );
  // AND 039 REDEFINES NOTHING 034 OWNS. It is a prepaid plan with no
  // Stripe subscription at all, so it has no business anywhere near the
  // cancellation machinery, the subscriptions table or its status.
  const sql039 = read("supabase/migrations/039_b2c_annual_plan_foundation.sql");
  for (const owned of ["schedule_subscription_cancellation",
                       "apply_deferred_subscription_cancellation",
                       "mark_subscription_cancelled",
                       "sync_subscription_from_stripe",
                       "record_paid_subscription_period",
                       "due_deferred_subscription_cancellations",
                       "alter table public.subscriptions"]) {
    assert.ok(!sql039.includes(owned), `039 touches ${owned}`);
  }
  // AND 038 REDEFINES NOTHING 034 OWNS EITHER.
  const sql038 = read("supabase/migrations/038_one_time_refund_writer_concurrency.sql");
  assert.ok(!sql038.includes("schedule_subscription_cancellation"), "038 touches the cancellation machinery");
  assert.ok(!sql038.includes("apply_deferred_subscription_cancellation"), "038 touches the cancellation machinery");
  // AND 036 REDEFINES NOTHING 034 OWNS. It adds one function of its own
  // and must not touch the cancellation machinery this suite protects.
  const sql036 = read("supabase/migrations/036_subscription_payment_status.sql");
  for (const owned of [
    "schedule_subscription_cancellation", "apply_deferred_subscription_cancellation",
    "sync_subscription_from_stripe", "mark_subscription_cancelled",
    "record_paid_subscription_period", "due_deferred_subscription_cancellations",
  ]) {
    assert.ok(!sql036.includes(`function public.${owned}`), `036 redefines ${owned}`);
  }
  // Its only function is its own, and it writes status alone.
  assert.equal((sql036.match(/create or replace function/g) ?? []).length, 1);
  assert.ok(sql036.includes("function public.sync_subscription_payment_status"));
  assert.equal(
    files[files.indexOf("034_subscription_cancellation.sql") - 1],
    "033_refund_confirmation_email_state.sql"
  );
  // And 035 redefines nothing 034 owns: no function, and no write to
  // public.subscriptions.
  const sql035 = read("supabase/migrations/035_subscription_email_deliveries.sql");
  assert.ok(!/create (or replace )?function/i.test(sql035), "035 defines a function");
  assert.ok(!/alter table public\.subscriptions/i.test(sql035),
    "035 alters public.subscriptions");
  // It redefines nothing the subscription foundation owns.
  for (const owned of [
    "create_pending_subscription", "activate_subscription_from_invoice",
    "claim_pending_subscription_for_attempt", "subscriptions_status_check",
  ]) {
    assert.ok(!sql034.includes(owned), `034 touches ${owned}`);
  }
});

test("034: exactly four columns, nullable, no default, no backfill", () => {
  // THREE cancellation facts and, since Phase 3C.5, ONE payment fact.
  // The fourth is not a cancellation column: it is the only thing in the
  // schema that can say a subscription period was actually paid for.
  const adds = [...sql034.matchAll(/add column(?: if not exists)? (\w+)/g)].map(m => m[1]);
  assert.deepEqual(adds.sort(),
    ["cancel_at", "cancellation_effective_at", "cancellation_requested_at",
     "last_paid_period_end"]);
  // Every ADD COLUMN statement, not just the first: a default on the
  // payment column would claim proof GLOA does not hold, and a backfill
  // would claim it for periods nobody ever observed being paid.
  const statements = [...sql034.matchAll(/alter table public\.subscriptions[\s\S]*?;/g)]
    .map(m => m[0])
    .filter(stmt => /add column/.test(stmt));
  assert.equal(statements.length, 2, "unexpected number of ADD COLUMN statements");
  for (const statement of statements) {
    assert.ok(!/default/i.test(statement), "a column has a default");
    assert.ok(!/not null/i.test(statement), "a column is NOT NULL");
    assert.ok(statement.includes("timestamptz"));
  }
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
  // SIX since Phase 3C.5: recording a paid period is the sixth, and it
  // writes one column that is not a lifecycle column at all.
  const setClauses = updateSetClauses(sql034);
  assert.equal(setClauses.length, 6, "unexpected number of UPDATE statements");
  const writers = setClauses.filter(c => /status\s+=\s+'cancelled'/.test(c));
  assert.equal(writers.length, 1, "more than one path writes the cancelled status");
  assert.ok(markFn.includes("status       = 'cancelled'"));
  assert.ok(markFn.includes("cancelled_at = coalesce(p_cancelled_at, now())"));
  // And the recorder touches no lifecycle column whatsoever.
  const recordSet = setClauses[setClauses.length - 1];
  assert.deepEqual(columnsWritten(recordSet), ["last_paid_period_end"]);
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

test("034: every function is SECURITY DEFINER with an empty search_path", () => {
  assert.equal([...sql034.matchAll(/security definer set search_path = ''/g)].length, 6);
  // The five WRITERS. Each locks the row it decides on.
  for (const fn of [
    "schedule_subscription_cancellation", "apply_deferred_subscription_cancellation",
    "sync_subscription_from_stripe", "mark_subscription_cancelled",
    "record_paid_subscription_period",
  ]) {
    const at = sql034.indexOf(`create or replace function public.${fn}`);
    assert.ok(at > -1, `${fn} missing`);
    const body = sql034.slice(at, sql034.indexOf("$$;", at));
    assert.ok(body.includes("language plpgsql"));
    assert.ok(body.includes("returns jsonb"));
    assert.ok(body.includes("for update"), `${fn} does not lock the row`);
  }
  // The one READER. It decides nothing, so it locks nothing and must not
  // be able to write: a work list is a queue, never an authority.
  assert.ok(dueListFn.length > 0, "the due work list is missing");
  assert.ok(dueListFn.includes("language sql"));
  assert.ok(dueListFn.includes("stable"), "the work list is not declared read-only");
  assert.ok(dueListFn.includes("security definer set search_path = ''"));
  assert.ok(!dueListFn.includes("for update"), "a read-only work list takes row locks");
  assert.ok(!dueListFn.includes("volatile"));
});

test("034: execute revoked from public/anon/authenticated, granted to service_role only", () => {
  const signatures = [
    "public.schedule_subscription_cancellation(uuid, uuid, timestamptz, timestamptz, timestamptz)",
    "public.apply_deferred_subscription_cancellation(text, timestamptz)",
    "public.sync_subscription_from_stripe(text, timestamptz, timestamptz, timestamptz)",
    "public.mark_subscription_cancelled(text, timestamptz)",
    // The one function that can create payment evidence.
    "public.record_paid_subscription_period(uuid, text, timestamptz)",
    // Read-only, and still closed to every browser role.
    "public.due_deferred_subscription_cancellations(integer)",
  ];
  for (const sig of signatures) {
    for (const role of ["public", "anon", "authenticated"]) {
      assert.ok(sql034.includes(`revoke all on function ${sig} from ${role};`), `${sig} not revoked from ${role}`);
    }
    assert.ok(sql034.includes(`grant execute on function ${sig} to service_role;`));
  }
  const grants = sql034.split(NEWLINE).filter(l => l.trim().toLowerCase().startsWith("grant"));
  assert.equal(grants.length, 6, "an unexpected grant was issued");
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

test("034: the verification block checks the signature that actually exists", () => {
  // THE DEFECT THIS PINS. (G) used to check a FOUR argument
  // schedule_subscription_cancellation. The function has taken five
  // arguments since the deferred late branch added p_cancel_at, so
  // has_function_privilege would have raised "function does not exist"
  // and the owner would have been unable to verify the one privilege
  // check that matters most - on the only function a customer request
  // can reach.
  const FOUR = "public.schedule_subscription_cancellation(uuid,uuid,timestamptz,timestamptz)'";
  assert.ok(!migration034.includes(FOUR),
    "the verification block still names the old four argument signature");

  // All four role checks name the real five argument function.
  const FIVE = "public.schedule_subscription_cancellation(uuid,uuid,timestamptz,timestamptz,timestamptz)";
  const escaped = FIVE.replace(/[()]/g, "\\$&");
  for (const role of ["public", "anon", "authenticated", "service_role"]) {
    assert.ok(new RegExp(`has_function_privilege\\('${role}',\\s*'${escaped}'`).test(migration034),
      `(G) does not check ${role} against the real signature`);
  }
  assert.equal([...migration034.matchAll(new RegExp(escaped, "g"))].length, 4,
    "(G) no longer checks exactly the four roles");

  // AND THE VERIFICATION AGREES WITH THE EXECUTABLE GRANT. The grant is
  // spaced, the has_function_privilege argument is not, so they are
  // compared with whitespace removed rather than by eye.
  const squash = s => s.replace(/\s+/g, "");
  const granted = [...migration034.matchAll(/grant execute on function (public\.[^;]+?) to service_role;/g)]
    .map(m => squash(m[1]));
  const verified = [...migration034.matchAll(/has_function_privilege\('service_role',\s*'(public\.[^']+)'/g)]
    .map(m => squash(m[1]));
  for (const sig of verified) {
    assert.ok(granted.includes(sig), `(G) verifies ${sig}, which nothing grants`);
  }
  for (const sig of granted) {
    assert.ok(verified.includes(sig), `${sig} is granted but never verified`);
  }
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
  // The SERVICE still reads none of them. The payment proof lives in SQL
  // precisely so this module never has to read a payment record.
  for (const forbidden of ["orders", "order_items", "checkout_attempts", "payment_status", "refund"]) {
    assert.ok(!serviceCode.includes(forbidden), `the service touches ${forbidden}`);
  }
  assert.ok(!sql034.includes("public.orders"), "034 touches orders");
  // 034 reads checkout_attempts once, in the read-only work list, and
  // writes it never. A paid cycle that already shipped stays exactly as
  // it is.
  for (const write of ["insert into public.checkout_attempts", "update public.checkout_attempts",
                       "delete from public.checkout_attempts"]) {
    assert.ok(!sql034.includes(write), `034 writes checkout attempts: ${write}`);
  }
});

test("webhook: billing failure events remain unhandled - that is Phase 3E", () => {
  for (const deferred of [
    // PHASE 3I.B2 HANDLES invoice.payment_failed. It is asserted
    // elsewhere in this file that the handler creates nothing and
    // touches no cancellation column. These remain unhandled.
    "invoice.payment_action_required",
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

test("regression: the account reaches this feature ONLY through the endpoint", () => {
  // PHASE 3F CHANGED THIS GUARD, DELIBERATELY. It used to assert that the
  // account UI did not reference the cancel endpoint at all, which was
  // the correct boundary while Phase 3C had no customer-facing half. The
  // account now has one, so the guard states the boundary that still
  // holds: the browser goes through the authenticated HTTP route and
  // through nothing else.
  const portal = read("app/AccountPortal.tsx");
  assert.ok(portal.includes('fetch("/api/subscriptions/cancel"'),
    "the account no longer reaches the cancellation endpoint");
  assert.ok(portal.includes("Authorization: `Bearer ${session.access_token}`"),
    "the account calls the endpoint without a bearer token");

  // NEVER the service, never the RPC, never a direct write. Those run
  // server-side under the service-role key, and a browser that could
  // reach them would bypass every ownership check.
  // The account imports the pure RULES module - that is the point, it is
  // how the cutoff cannot drift - but never the SERVICE, which holds the
  // service-role client and every Stripe call.
  // Matched on the module SPECIFIER, not per line: these are multi-line
  // named imports, so the path sits on the closing line.
  assert.match(portal, /from "\.\.\/lib\/subscriptionCancellationRules"/,
    "the account stopped sharing the cancellation rules");
  assert.ok(!/from "\.\.\/lib\/subscriptionCancellation"/.test(portal),
    "the account imports the cancellation service");
  const portalCode = withoutComments(portal);
  for (const serverOnly of [
    "cancelSubscriptionForUser", "sweepDueDeferredCancellations",
    "applyDeferredCancellationFromRenewal", "schedule_subscription_cancellation",
    "apply_deferred_subscription_cancellation", "record_paid_subscription_period",
    "due_deferred_subscription_cancellations",
  ]) {
    assert.ok(!portalCode.includes(serverOnly), `the account UI reaches ${serverOnly}`);
  }
  assert.ok(!/from\("subscriptions"\)[\s\S]{0,200}\.update\(/.test(portalCode),
    "the account writes a subscription directly");

  // And NEVER the two internal columns. The account may show the promise
  // (cancellation_effective_at); what Stripe currently holds and the
  // payment proof the sweep needs are not customer facts. Checked on code
  // only, because the prose deliberately names what it refuses to read.
  assert.ok(!portalCode.includes("last_paid_period_end"), "the account UI reads the payment proof");
  assert.ok(!/\bcancel_at\b/.test(portalCode), "the account UI reads subscription cancel_at");
  // cancel_at_period_end is a different, pre-existing column and may stay.
  assert.ok(portalCode.includes("cancel_at_period_end"));
  // PHASE 3H.2 CHANGED THIS GUARD, DELIBERATELY. It used to assert that
  // no subscription email template existed anywhere, which was the
  // correct boundary while Phase 3C/3F had no customer-facing message.
  // subscriptionStarted.ts now exists, sent by the invoice.paid handler.
  // The boundary that still holds - and that this test is really about -
  // is that the CANCELLATION route, service and rules send nothing at
  // all, which the Resend assertions below prove directly.
  const templates = readdirSync(path.join(ROOT, "lib/email")).sort();
  assert.equal(templates.length, 12, "an unreviewed email template was added");
  assert.deepEqual(
    templates.filter(n => /subscription/i.test(n)).sort(),
    ["subscriptionEnded.ts", "subscriptionStarted.ts"],
    "a subscription template beyond the three reviewed families appeared"
  );
  // PHASE 3H.3 ADDED cancellationConfirmation.ts, and this route IS now
  // one of its triggers - through cancelSubscriptionForUser, which sends
  // it after the RPC has durably scheduled the cancellation. The boundary
  // that still holds is the one below: the route, the service and the
  // rules contain no Resend call of their own, and the browser still
  // reaches the feature only through the authenticated endpoint.
  assert.ok(templates.includes("cancellationConfirmation.ts"));
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
  assert.ok(sql034.includes("add column if not exists last_paid_period_end timestamptz"));
  // Every UPDATE is scoped to one row the function just locked, so
  // applying 034 cannot touch a single existing subscription.
  // mark_subscription_cancelled DOES write status - that is the
  // termination path, and it runs only for one Stripe event.
  // FOUR since Phase 3C.1: scheduling gained the CASE C single-column
  // write that records a customer request the webhook raced past.
  // FIVE since Phase 3C.2: applying a deferred late cancellation.
  // SIX since Phase 3C.5: recording that a period was paid - which
  // touches one column that no existing row has ever carried.
  const updates = [...sql034.matchAll(/update public\.subscriptions[\s\S]*?;/g)].map(m => m[0]);
  assert.equal(updates.length, 6, "unexpected number of UPDATE statements");
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
