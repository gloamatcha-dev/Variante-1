import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeBlockedServerEnv } from "./helpers/testSupabase.mjs";
import {
  AUTO_RETRY_FAMILY_KEYS,
  AUTO_RETRY_STATUS_COLUMNS,
  EMAIL_FAMILY_KEYS,
  IN_FLIGHT_STATUS,
  RETRY_DISABLED_FAMILIES,
  NEVER_ELIGIBLE_STATUSES,
  RETRY_BATCH_LIMIT,
  RETRY_ELIGIBLE_STATUS,
  STALE_RECOVERY_BATCH_LIMIT,
  STALE_SENDING_AFTER_MS,
  disabledFamilySummary,
  emptyFamilySummary,
  isAutoRetryFamily,
  isNeverEligibleStatus,
  isRetryEligibleStatus,
  isStaleSending,
  runFamily,
  runFamilyRetrySweep,
  runFamilyStaleRecovery,
  staleSendingCutoff,
} from "../lib/transactionalEmailRetryRules.ts";
import {
  RETRY_BATCH_LIMIT as LEGACY_BATCH_LIMIT,
  RETRY_ELIGIBLE_STATUS as LEGACY_ELIGIBLE,
  STALE_SENDING_AFTER_MS as LEGACY_STALE_MS,
  isRetryEligibleStatus as legacyIsRetryEligible,
  isStaleSending as legacyIsStaleSending,
  staleSendingCutoff as legacyCutoff,
} from "../lib/internalOrderNotificationRetryRules.ts";
import { isRefundEmailOwed, isRefundEmailSweepEligible } from "../lib/refundConfirmationRules.ts";
import { isOutcomeEmailSweepEligible } from "../lib/cancellationResolutionRules.ts";
import { isNotificationSweepEligible } from "../lib/cancellationRequestNotificationRules.ts";

// SAFE DEFAULT SUITE: pure sweep logic driven by in-memory fake ports,
// source-level checks, and a real spawned server started WITHOUT a
// Supabase service-role key and WITHOUT a Resend key. No database is
// reachable, no production row can be read or written, no order is
// created, shipped, cancelled or refunded, no Stripe API is called and no
// email of any kind is sent. Nothing here executes SQL.
//
// THE RULE THIS SUITE EXISTS TO PROTECT: a retry sweep may select
// 'failed' and nothing else. The live database holds 451 orders whose
// email state is NULL, one of them with a genuinely settled refund. None
// of them may ever be mailed by this cron.

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf-8");
const NEWLINE = String.fromCharCode(10);

const MIGRATIONS = path.join(ROOT, "supabase/migrations");
const route = read("app/api/cron/retry-order-notifications/route.ts");
const wiring = read("lib/transactionalEmailRetry.ts");
const rules = read("lib/transactionalEmailRetryRules.ts");

/**
 * Code only.
 *
 * Block comments are removed FIRST. Both modules under test carry long
 * prose blocks that deliberately NAME the things they exclude - the
 * confirmation sender, its status column, the reason it is excluded - and
 * a scan that read those would report the exclusion as a violation of
 * itself.
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
const wiringCode = withoutComments(wiring);
const rulesCode = withoutComments(rules);

const ORDER_A = "aaaaaaaa-1111-2222-3333-444444444444";
const ORDER_B = "bbbbbbbb-1111-2222-3333-444444444444";
const ORDER_C = "cccccccc-1111-2222-3333-444444444444";

/**
 * An in-memory port over a list of fake rows.
 *
 * The selection is written the way the real port writes it - status
 * equals 'failed', nothing else - so a change that widened the real
 * predicate would have to be copied here to keep these tests passing,
 * which is exactly the point.
 */
function fakePort(rows, { send, staleRows = [], onRecover } = {}) {
  const calls = [];
  const logs = [];
  return {
    calls,
    logs,
    port: {
      loadStaleSending: async cutoffIso =>
        staleRows.filter(r => r.status === "sending" && r.updated_at && r.updated_at <= cutoffIso),
      recoverStale: async (orderId, cutoffIso) => {
        if (onRecover) return onRecover(orderId, cutoffIso);
        const row = staleRows.find(r => r.id === orderId);
        if (!row || row.status !== "sending" || !row.updated_at || row.updated_at > cutoffIso) return "skipped";
        row.status = "failed";
        return "recovered";
      },
      loadFailed: async () => rows.filter(r => r.status === "failed").map(r => ({ id: r.id, status: r.status })),
      send: async orderId => {
        calls.push(orderId);
        return send ? send(orderId) : "sent";
      },
      logFailure: (orderId, message) => logs.push(`${orderId}: ${message}`),
    },
  };
}

const CUTOFF = "2026-08-26T10:00:00.000Z";

/* ══════════════════════════════════════════════════════════════
   THE ABSOLUTE RULE
   ══════════════════════════════════════════════════════════════ */

test("rule: the only eligible status is 'failed'", () => {
  assert.equal(RETRY_ELIGIBLE_STATUS, "failed");
  assert.equal(isRetryEligibleStatus("failed"), true);
  for (const never of [null, undefined, "pending", "sending", "sent", "", "FAILED", "Failed", "x"]) {
    assert.equal(isRetryEligibleStatus(never), false, String(never));
  }
});

test("rule: NULL is explicitly never eligible, and so are pending/sending/sent", () => {
  assert.deepEqual([...NEVER_ELIGIBLE_STATUSES], ["pending", "sending", "sent"]);
  for (const never of [null, undefined, "pending", "sending", "sent"]) {
    assert.equal(isNeverEligibleStatus(never), true, String(never));
    assert.equal(isRetryEligibleStatus(never), false, String(never));
  }
  assert.equal(isNeverEligibleStatus("failed"), false);
});

test("rule: it agrees exactly with the proven internal-notification module", () => {
  // Two leaf modules cannot import each other, so the duplication is
  // asserted instead.
  assert.equal(RETRY_ELIGIBLE_STATUS, LEGACY_ELIGIBLE);
  assert.equal(RETRY_BATCH_LIMIT, LEGACY_BATCH_LIMIT);
  assert.equal(STALE_SENDING_AFTER_MS, LEGACY_STALE_MS);
  for (const status of [null, undefined, "failed", "sending", "sent", "pending", ""]) {
    assert.equal(isRetryEligibleStatus(status), legacyIsRetryEligible(status), String(status));
  }
  assert.equal(staleSendingCutoff(1_800_000_000_000), legacyCutoff(1_800_000_000_000));
});

test("rule: it agrees with every family's own sweep predicate", () => {
  // Each phase wrote its own isXSweepEligible when it built the flow, and
  // each said 'failed' and nothing else. This is where those independent
  // statements are checked against the sweep that finally uses them.
  for (const predicate of [
    isRefundEmailSweepEligible,
    isOutcomeEmailSweepEligible,
    isNotificationSweepEligible,
  ]) {
    assert.equal(predicate("failed"), true);
    for (const never of [null, undefined, "sending", "sent", "pending", ""]) {
      assert.equal(predicate(never), false, String(never));
    }
  }
});

test("rule: the real selection query filters on 'failed' and on nothing else", () => {
  const load = wiringCode.slice(wiringCode.indexOf("loadFailed: async ()"));
  const body = load.slice(0, load.indexOf("send,"));
  assert.ok(body.includes('.eq(statusColumn, "failed")'), "the work list does not filter on failed");
  // Never a NULL check, never sent_at, never a watermark.
  for (const forbidden of [
    ".is(", "is.null", "sent_at", "notified_total", "payment_status",
    "refunded_total_cents", ".not(", ".or(",
  ]) {
    assert.ok(!body.includes(forbidden), `the work list also filters on ${forbidden}`);
  }
  // Exactly one eq on the status column plus the ordering and the bound.
  assert.ok(body.includes("limit(RETRY_BATCH_LIMIT)"));
  assert.ok(body.includes('.order("updated_at", { ascending: true })'));
});

/* ══════════════════════════════════════════════════════════════
   HISTORICAL SAFETY - THE LOAD-BEARING TESTS
   ══════════════════════════════════════════════════════════════ */

test("HISTORICAL: a settled refund with NULL email state is NEVER selected", () => {
  // The single most important test in this suite. Production holds
  // exactly one such order: settled_refunds = 1, refund email_status = 0,
  // watermark count = 0. It must never receive an email from this cron.
  const historicalRefund = {
    id: ORDER_A,
    status: null, // refund_email_status IS NULL
    payment_status: "refunded",
    refunded_total_cents: 4990,
    refund_email_notified_total_cents: null,
  };

  // 1. the sweep's selector cannot see it
  assert.equal(isRetryEligibleStatus(historicalRefund.status), false);
  assert.equal(isRefundEmailSweepEligible(historicalRefund.status), false);

  // 2. the fake work list, written like the real one, returns nothing
  const { port, calls } = fakePort([historicalRefund]);
  return runFamily(port, CUTOFF).then(summary => {
    assert.deepEqual(calls, [], "the historical refund was handed to a sender");
    assert.equal(summary.eligible, 0);
    assert.equal(summary.attempted, 0);
    assert.equal(summary.sent, 0);
  });
});

test("HISTORICAL: that refund IS owed a live email, which is why the selector matters", () => {
  // The order genuinely satisfies isRefundEmailOwed - money settled, the
  // watermark is NULL. If the sweep selected on the watermark instead of
  // on 'failed', it would mail this customer. It selects on 'failed'.
  assert.equal(isRefundEmailOwed({
    payment_status: "refunded",
    refunded_total_cents: 4990,
    refund_email_notified_total_cents: null,
    refund_email_status: null,
  }), true, "the premise of this test changed");
  // And yet it is not sweep eligible.
  assert.equal(isRefundEmailSweepEligible(null), false);
  assert.equal(isRetryEligibleStatus(null), false);
});

test("HISTORICAL: a NULL row in every family is never selected", async () => {
  for (const key of EMAIL_FAMILY_KEYS) {
    const { port, calls } = fakePort([{ id: ORDER_A, status: null }]);
    const summary = await runFamily(port, CUTOFF);
    assert.deepEqual(calls, [], `${key}: a NULL row reached a sender`);
    assert.equal(summary.eligible, 0, key);
    assert.equal(summary.sent, 0, key);
  }
});

/* ══════════════════════════════════════════════════════════════
   HOTFIX 2E-B.1: ORDER CONFIRMATION IS EXCLUDED ENTIRELY
   ══════════════════════════════════════════════════════════════ */

test("EXCLUDED: order confirmation is not an auto-retry family", () => {
  // The root cause: it is the only one of the six senders that calls
  // resend.emails.send WITHOUT a deterministic idempotency key, so a
  // 'sending' or 'failed' row cannot be retried without risking a
  // duplicate customer email.
  assert.ok(!AUTO_RETRY_FAMILY_KEYS.includes("orderConfirmation"));
  assert.equal(isAutoRetryFamily("orderConfirmation"), false);
  assert.equal(AUTO_RETRY_FAMILY_KEYS.length, 5);
  assert.deepEqual([...AUTO_RETRY_FAMILY_KEYS], [
    "internalOrder", "shipment", "cancellationRequest", "cancellationOutcome", "refund",
  ]);
  assert.ok(RETRY_DISABLED_FAMILIES.orderConfirmation.includes("idempotency"));
});

test("EXCLUDED: the root cause is real - it is the one sender with no provider key", () => {
  const confirmation = withoutComments(read("lib/orderConfirmationEmail.ts"));
  assert.ok(confirmation.includes("resend.emails.send("), "the sender changed shape");
  assert.ok(!confirmation.includes("idempotencyKey"), "the confirmation sender now HAS a key");
  // Every auto-retryable family does have one.
  for (const rel of [
    "lib/internalOrderNotificationEmail.ts",
    "lib/shipmentConfirmationEmail.ts",
    "lib/cancellationRequestNotificationEmail.ts",
    "lib/cancellationOutcomeEmail.ts",
    "lib/refundConfirmationEmail.ts",
  ]) {
    assert.ok(withoutComments(read(rel)).includes("{ idempotencyKey }"), `${rel} lost its provider key`);
  }
});

test("EXCLUDED: confirmation_email_status appears NOWHERE in the retry system", () => {
  // Not "unused" - absent. No query, no work list and no conditional
  // write can name it even by accident.
  for (const [label, source] of [
    ["wiring", wiringCode], ["rules", rulesCode], ["route", routeCode],
  ]) {
    assert.ok(!source.includes("confirmation_email_status"), `${label} names the confirmation status column`);
    assert.ok(!source.includes("confirmation_email_sent_at"), `${label} names the confirmation sent_at column`);
  }
  assert.ok(!Object.values(AUTO_RETRY_STATUS_COLUMNS).includes("confirmation_email_status"));
  assert.ok(!("orderConfirmation" in AUTO_RETRY_STATUS_COLUMNS));
});

test("EXCLUDED: the retry never imports or calls the confirmation sender", () => {
  for (const [label, source] of [
    ["wiring", wiringCode], ["rules", rulesCode], ["route", routeCode],
  ]) {
    assert.ok(!source.includes("sendOrderConfirmationEmailIfNeeded"), `${label} calls the confirmation sender`);
    assert.ok(!source.includes("orderConfirmationEmail"), `${label} imports the confirmation sender`);
  }
  // And no reconstruction machinery survives either.
  assert.ok(!wiringCode.includes("checkout_attempts"), "the retry still reads checkout attempts");
  assert.ok(!wiringCode.includes("items_snapshot"), "the retry still rebuilds line items");
  assert.ok(!wiringCode.includes("retryOrderConfirmation"), "the adapter survived");
});

test("EXCLUDED: every confirmation state is unreachable, not merely refused", () => {
  // The 390 pending, 15 failed, 5 sending and 41 sent rows live in
  // production are unreachable because the family is never run at all.
  const m017 = read("supabase/migrations/017_order_confirmation_email_state.sql");
  assert.ok(m017.includes("not null default 'pending'"), "017 no longer defaults to pending");
  assert.equal(isAutoRetryFamily("orderConfirmation"), false);
  // Belt and braces: the generic predicates refuse most of them anyway.
  for (const status of ["pending", "sending", "sent", null, undefined]) {
    assert.equal(isRetryEligibleStatus(status), false, String(status));
  }
  // One runFamily call per auto-retry family, minus the internal
  // notification which keeps its own sweep. Four.
  assert.equal([...wiringCode.matchAll(/await runFamily\(/g)].length, 4,
    "the orchestrator runs a family it should not");
});

test("EXCLUDED: repo-wide, only the paid-order webhook calls the confirmation sender", () => {
  // The strongest form of the exclusion: a walk of the whole tree, with
  // comments stripped, finds exactly one caller. The retry module NAMES
  // the sender in its header prose to explain why it is excluded, which
  // is documentation and not a call site - hence the stripping.
  const callers = [];
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      const rel = path.relative(ROOT, full).split(path.sep).join("/");
      if (rel === "lib/orderConfirmationEmail.ts") continue;
      if (withoutComments(readFileSync(full, "utf-8")).includes("sendOrderConfirmationEmailIfNeeded")) {
        callers.push(rel);
      }
    }
  };
  walk(path.join(ROOT, "app"));
  walk(path.join(ROOT, "lib"));
  assert.deepEqual(callers, ["app/api/stripe/webhook/route.ts"],
    `the confirmation sender gained a caller: ${callers.join(", ")}`);
});

test("EXCLUDED: the response says disabled, and no query produced it", () => {
  const summary = disabledFamilySummary("because");
  assert.equal(summary.disabled, true);
  assert.equal(summary.reason, "because");
  for (const counter of ["staleFound", "staleRecovered", "eligible", "attempted", "sent", "failed", "skipped"]) {
    assert.equal(summary[counter], 0, counter);
  }
  assert.equal(summary.errored, false, "disabled is not an error");
  assert.ok(wiringCode.includes(
    "orderConfirmation: disabledFamilySummary(RETRY_DISABLED_FAMILIES.orderConfirmation)"
  ));
});

test("EXCLUDED: the production confirmation rows are not repaired by this change", () => {
  // 390 pending, 15 failed, 5 sending, 41 sent are left exactly as they
  // are. The hotfix stops the cron looking at them; it repairs nothing.
  for (const forbidden of ["confirmation_email", "backfill", "markConfirmationEmail"]) {
    assert.ok(!wiringCode.includes(forbidden), `the retry writes confirmation state: ${forbidden}`);
  }
  // The only UPDATE the retry performs is the one stale-recovery write,
  // on an auto-retry family's column.
  const updates = [...wiringCode.matchAll(/\.update\(\{([\s\S]*?)\}\)/g)].map(m => m[1]);
  assert.equal(updates.length, 1);
  assert.ok(updates[0].includes('[statusColumn]: "failed"'));
});

test("HISTORICAL: every family's status column is the one its migration created", () => {
  const expected = {
    internalOrder: ["026_internal_order_notification_state.sql", "internal_notification_status"],
    shipment: ["027_shipment_confirmation_email_state.sql", "shipment_email_status"],
    cancellationRequest: ["030_cancellation_request_notification_state.sql", "cancellation_request_notification_status"],
    cancellationOutcome: ["031_cancellation_request_resolution.sql", "cancellation_outcome_email_status"],
    refund: ["033_refund_confirmation_email_state.sql", "refund_email_status"],
  };
  assert.deepEqual(Object.keys(AUTO_RETRY_STATUS_COLUMNS).sort(), [...AUTO_RETRY_FAMILY_KEYS].sort());
  for (const [key, [file, column]] of Object.entries(expected)) {
    assert.equal(AUTO_RETRY_STATUS_COLUMNS[key], column, key);
    const sql = read(`supabase/migrations/${file}`);
    assert.ok(sql.includes(column), `${file} does not create ${column}`);
    assert.ok(sql.includes(`'sending', 'sent', 'failed'`), `${file} vocabulary changed`);
  }
});

/* ══════════════════════════════════════════════════════════════
   SELECTION PER FAMILY
   ══════════════════════════════════════════════════════════════ */

test("selection: failed is selected, sent/sending/pending/NULL are not", async () => {
  const { port, calls } = fakePort([
    { id: ORDER_A, status: "failed" },
    { id: ORDER_B, status: "sent" },
    { id: ORDER_C, status: "sending" },
    { id: "dddddddd-1111-2222-3333-444444444444", status: null },
    { id: "eeeeeeee-1111-2222-3333-444444444444", status: "pending" },
  ]);
  const summary = await runFamily(port, CUTOFF);
  assert.deepEqual(calls, [ORDER_A], "something other than the failed row was attempted");
  assert.equal(summary.eligible, 1);
  assert.equal(summary.attempted, 1);
  assert.equal(summary.sent, 1);
});

test("selection: a row that slips past the query is still refused in code", async () => {
  // Defence in depth: the loop re-checks the status even for rows the
  // work list handed it.
  const summary = emptyFamilySummary();
  const calls = [];
  await runFamilyRetrySweep({
    loadStaleSending: async () => [],
    recoverStale: async () => "skipped",
    loadFailed: async () => [
      { id: ORDER_A, status: null },
      { id: ORDER_B, status: "sent" },
      { id: ORDER_C, status: "failed" },
    ],
    send: async id => { calls.push(id); return "sent"; },
    logFailure: () => {},
  }, summary);
  assert.deepEqual(calls, [ORDER_C]);
  assert.equal(summary.eligible, 3);
  assert.equal(summary.skipped, 2);
  assert.equal(summary.attempted, 1);
});

test("selection: sender outcomes map to the right counters", async () => {
  const outcomes = {
    [ORDER_A]: "sent",
    [ORDER_B]: "failed",
    [ORDER_C]: "already-sent",
    "dddddddd-1111-2222-3333-444444444444": "not-eligible",
  };
  const rows = Object.keys(outcomes).map(id => ({ id, status: "failed" }));
  const { port } = fakePort(rows, { send: id => outcomes[id] });
  const summary = await runFamily(port, CUTOFF);
  assert.equal(summary.eligible, 4);
  assert.equal(summary.attempted, 4);
  assert.equal(summary.sent, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.skipped, 2, "already-sent and not-eligible are not counted as skipped");
});

/* ══════════════════════════════════════════════════════════════
   STALE 'sending' RECOVERY
   ══════════════════════════════════════════════════════════════ */

test("stale: the threshold and the cutoff match the proven module exactly", () => {
  assert.equal(STALE_SENDING_AFTER_MS, 30 * 60 * 1000);
  assert.equal(IN_FLIGHT_STATUS, "sending");
  const now = Date.parse("2026-08-26T12:00:00.000Z");
  assert.equal(staleSendingCutoff(now), "2026-08-26T11:30:00.000Z");
  assert.equal(staleSendingCutoff(new Date(now)), staleSendingCutoff(now));
});

test("stale: only old 'sending' rows are stale, and the boundary is inclusive", () => {
  const cutoff = "2026-08-26T11:30:00.000Z";
  assert.equal(isStaleSending("sending", "2026-08-26T11:29:59.000Z", cutoff), true);
  assert.equal(isStaleSending("sending", cutoff, cutoff), true, "the boundary is exclusive");
  assert.equal(isStaleSending("sending", "2026-08-26T11:30:01.000Z", cutoff), false);
  // And it agrees with the legacy predicate on every case.
  for (const [status, at] of [
    ["sending", "2026-08-26T11:00:00.000Z"], ["sending", "2026-08-26T12:00:00.000Z"],
    ["sent", "2026-08-26T11:00:00.000Z"], ["failed", "2026-08-26T11:00:00.000Z"],
    ["pending", "2026-08-26T11:00:00.000Z"], [null, "2026-08-26T11:00:00.000Z"],
    ["sending", null], ["sending", "not-a-date"],
  ]) {
    assert.equal(
      isStaleSending(status, at, cutoff),
      legacyIsStaleSending(status, at, cutoff),
      `${status} / ${at}`
    );
  }
});

test("stale: sent, failed, pending and NULL rows are never recovered", async () => {
  const summary = emptyFamilySummary();
  const touched = [];
  await runFamilyStaleRecovery({
    loadStaleSending: async () => [
      { id: ORDER_A, status: "sent", updated_at: "2026-08-26T09:00:00.000Z" },
      { id: ORDER_B, status: "failed", updated_at: "2026-08-26T09:00:00.000Z" },
      { id: ORDER_C, status: null, updated_at: "2026-08-26T09:00:00.000Z" },
      { id: "dddddddd-1111-2222-3333-444444444444", status: "pending", updated_at: "2026-08-26T09:00:00.000Z" },
    ],
    recoverStale: async id => { touched.push(id); return "recovered"; },
    loadFailed: async () => [],
    send: async () => "sent",
    logFailure: () => {},
  }, CUTOFF, summary);
  assert.deepEqual(touched, [], "a non-sending row was written");
  assert.equal(summary.staleFound, 0);
  assert.equal(summary.staleRecovered, 0);
});

test("stale: a recent 'sending' row is left alone", async () => {
  const summary = emptyFamilySummary();
  const touched = [];
  await runFamilyStaleRecovery({
    loadStaleSending: async () => [
      { id: ORDER_A, status: "sending", updated_at: "2026-08-26T11:00:00.000Z" },
    ],
    recoverStale: async id => { touched.push(id); return "recovered"; },
    loadFailed: async () => [],
    send: async () => "sent",
    logFailure: () => {},
  }, "2026-08-26T10:00:00.000Z", summary);
  assert.deepEqual(touched, []);
  assert.equal(summary.staleFound, 0);
});

test("stale: a genuinely stale row is recovered and then swept in the same run", async () => {
  const rows = [{ id: ORDER_A, status: "sending", updated_at: "2026-08-26T08:00:00.000Z" }];
  const { port, calls } = fakePort(rows, { staleRows: rows });
  const summary = await runFamily(port, CUTOFF);
  assert.equal(summary.staleFound, 1);
  assert.equal(summary.staleRecovered, 1);
  assert.equal(rows[0].status, "failed", "recovery did not move the row to failed");
  // Recovery sends nothing itself - the failed-only sweep does, on the
  // same run, through the one delivery path there has ever been.
  assert.deepEqual(calls, [ORDER_A]);
  assert.equal(summary.sent, 1);
});

test("stale: a lost race leaves the row exactly as the other worker left it", async () => {
  const summary = emptyFamilySummary();
  await runFamilyStaleRecovery({
    loadStaleSending: async () => [
      { id: ORDER_A, status: "sending", updated_at: "2026-08-26T08:00:00.000Z" },
    ],
    // The conditional write matched nothing: the original worker finished.
    recoverStale: async () => "skipped",
    loadFailed: async () => [],
    send: async () => "sent",
    logFailure: () => {},
  }, CUTOFF, summary);
  assert.equal(summary.staleFound, 1);
  assert.equal(summary.staleRecovered, 0, "a lost race was counted as a recovery");
});

test("stale: the real recovery write re-checks status AND cutoff, and moves one column", () => {
  const recover = wiringCode.slice(wiringCode.indexOf("recoverStale: async (orderId"));
  const body = recover.slice(0, recover.indexOf("loadFailed:"));
  assert.ok(body.includes('.update({ [statusColumn]: "failed" })'));
  assert.ok(body.includes('.eq("id", orderId)'));
  assert.ok(body.includes('.eq(statusColumn, "sending")'), "the write does not re-check the status");
  assert.ok(body.includes('.lte("updated_at", cutoffIso)'), "the write does not re-check the cutoff");
  // One column, nothing else.
  const updates = [...body.matchAll(/\.update\(\{([\s\S]*?)\}\)/g)].map(m => m[1]);
  assert.equal(updates.length, 1);
  for (const forbidden of ["sent_at", "notified", "payment_status", "status:", "fulfillment"]) {
    assert.ok(!updates[0].includes(forbidden), `recovery writes ${forbidden}`);
  }
});

/* ══════════════════════════════════════════════════════════════
   REFUND: THE WATERMARK SURVIVES THE RETRY
   ══════════════════════════════════════════════════════════════ */

test("refund: a failed partial refund is still owed the same durable total", () => {
  // A failed send left the watermark unmoved, so the same cumulative
  // total is still what the customer is owed.
  assert.equal(isRefundEmailOwed({
    payment_status: "partially_refunded",
    refunded_total_cents: 1000,
    refund_email_notified_total_cents: null,
    refund_email_status: "failed",
  }), true);
});

test("refund: a failed FULL refund is still owed the same durable total", () => {
  assert.equal(isRefundEmailOwed({
    payment_status: "refunded",
    refunded_total_cents: 4990,
    refund_email_notified_total_cents: 2500,
    refund_email_status: "failed",
  }), true);
});

test("refund: the watermark advances only on success, never on failure", () => {
  const sender = withoutComments(read("lib/refundConfirmationEmail.ts"));
  const markSent = sender.slice(sender.indexOf("async function markSent"));
  const sentBody = markSent.slice(0, markSent.indexOf("async function markFailed"));
  assert.ok(sentBody.includes("refund_email_notified_total_cents: notifiedTotalCents"));

  const markFailed = sender.slice(sender.indexOf("async function markFailed"));
  const failedBody = markFailed.slice(0, markFailed.indexOf("function recipientFromSnapshot"));
  assert.ok(!failedBody.includes("notified_total_cents"), "a failed send moved the watermark");
});

test("refund: a larger later refund stays independently eligible after a success", () => {
  assert.equal(isRefundEmailOwed({
    payment_status: "refunded",
    refunded_total_cents: 4990,
    refund_email_notified_total_cents: 2500,
    refund_email_status: "sent",
  }), true, "a larger total was swallowed by an earlier success");
  // And the same total is not.
  assert.equal(isRefundEmailOwed({
    payment_status: "refunded",
    refunded_total_cents: 4990,
    refund_email_notified_total_cents: 4990,
    refund_email_status: "sent",
  }), false);
});

test("refund: the sweep hands over an order id and lets the sender re-validate", () => {
  // The sweep must not re-implement the watermark comparison - the sender
  // owns it, which is what keeps the multi-refund architecture in one
  // place.
  assert.ok(wiringCode.includes("AUTO_RETRY_STATUS_COLUMNS.refund"));
  assert.ok(wiringCode.includes("sendRefundConfirmationIfNeeded"));
  for (const forbidden of [
    "refunded_total_cents >", "notified_total_cents >", "isRefundEmailOwed", "refundKind",
  ]) {
    assert.ok(!wiringCode.includes(forbidden), `the sweep re-implements refund logic: ${forbidden}`);
  }
});

/* ══════════════════════════════════════════════════════════════
   BATCHING AND ISOLATION
   ══════════════════════════════════════════════════════════════ */

test("batching: the per-family limit matches the proven module and is per family", () => {
  assert.equal(RETRY_BATCH_LIMIT, 25);
  assert.equal(STALE_RECOVERY_BATCH_LIMIT, 25);
  assert.equal(RETRY_BATCH_LIMIT, LEGACY_BATCH_LIMIT);
  // The limit is applied inside the per-family port, so one noisy family
  // cannot consume another's budget.
  assert.ok(wiringCode.includes(".limit(RETRY_BATCH_LIMIT)"));
  assert.ok(wiringCode.includes(".limit(STALE_RECOVERY_BATCH_LIMIT)"));
  assert.equal([...wiringCode.matchAll(/\.limit\(/g)].length, 2, "an unbounded query exists");
});

test("isolation: one failing order does not stop the rest of its batch", async () => {
  const { port, calls } = fakePort(
    [
      { id: ORDER_A, status: "failed" },
      { id: ORDER_B, status: "failed" },
      { id: ORDER_C, status: "failed" },
    ],
    { send: id => (id === ORDER_B ? "failed" : "sent") }
  );
  const summary = await runFamily(port, CUTOFF);
  assert.deepEqual(calls, [ORDER_A, ORDER_B, ORDER_C], "the batch stopped early");
  assert.equal(summary.sent, 2);
  assert.equal(summary.failed, 1);
});

test("isolation: a sender that THROWS is caught, counted, and the batch continues", async () => {
  const { port, calls, logs } = fakePort(
    [
      { id: ORDER_A, status: "failed" },
      { id: ORDER_B, status: "failed" },
      { id: ORDER_C, status: "failed" },
    ],
    { send: id => { if (id === ORDER_B) throw new Error("provider exploded"); return "sent"; } }
  );
  const summary = await runFamily(port, CUTOFF);
  assert.deepEqual(calls, [ORDER_A, ORDER_B, ORDER_C]);
  assert.equal(summary.sent, 2);
  assert.equal(summary.failed, 1);
  assert.equal(logs.length, 1);
  assert.ok(logs[0].startsWith(ORDER_B));
});

test("isolation: a work-list failure marks the family errored, never throws", async () => {
  const summary = await runFamily({
    loadStaleSending: async () => { throw new Error("db down"); },
    recoverStale: async () => "skipped",
    loadFailed: async () => { throw new Error("db down"); },
    send: async () => "sent",
    logFailure: () => {},
  }, CUTOFF);
  assert.equal(summary.errored, true);
  assert.equal(summary.sent, 0);
  assert.equal(summary.eligible, 0);
});

test("isolation: a stale-recovery failure does not stop that family's sweep", async () => {
  const summary = await runFamily({
    loadStaleSending: async () => { throw new Error("db down"); },
    recoverStale: async () => "skipped",
    loadFailed: async () => [{ id: ORDER_A, status: "failed" }],
    send: async () => "sent",
    logFailure: () => {},
  }, CUTOFF);
  assert.equal(summary.errored, true, "the recovery failure was not recorded");
  assert.equal(summary.sent, 1, "the sweep did not run after a recovery failure");
});

test("isolation: every family runs inside its own guard in the orchestrator", () => {
  // Six families, each awaited separately, and the legacy one wrapped too.
  // Four: five auto-retry families, minus the internal notification,
  // which keeps its own proven sweep. Order confirmation is excluded
  // entirely and is never run at all.
  assert.equal([...wiringCode.matchAll(/await runFamily\(/g)].length, 4);
  assert.ok(wiringCode.includes("try {"), "the legacy sweep is not guarded");
  assert.ok(wiringCode.includes("internalOrder = erroredSummary();"));
  // The cutoff is computed once so all six judge staleness identically.
  assert.equal([...wiringCode.matchAll(/staleSendingCutoff\(/g)].length, 1);
});

/* ══════════════════════════════════════════════════════════════
   NO BUSINESS STATE MUTATION, NO EVENT CREATION
   ══════════════════════════════════════════════════════════════ */

test("safety: the retry writes exactly one column of its own", () => {
  const updates = [...wiringCode.matchAll(/\.update\(\{([\s\S]*?)\}\)/g)].map(m => m[1]);
  assert.equal(updates.length, 1, "the retry performs more than one kind of write");
  assert.ok(updates[0].includes('[statusColumn]: "failed"'));
  for (const forbidden of [
    "status:", "fulfillment_status", "payment_status", "refunded_total_cents",
    "refund_updated_at", "cancelled_at", "cancellation_requested_at",
    "cancellation_request_note", "cancellation_request_resolution",
    "cancellation_request_resolved_at", "shipped_at", "tracking",
    "_cents", "tax_", "snapshot", "sent_at",
  ]) {
    assert.ok(!updates[0].includes(forbidden), `the retry writes ${forbidden}`);
  }
});

test("safety: the retry creates no business event and calls no RPC", () => {
  // THE RETRY ITSELF - the six email families and their rules - still
  // touches no business state and no Stripe API at all.
  for (const source of [wiringCode, rulesCode]) {
    for (const forbidden of [
      ".rpc(", ".insert(", ".delete(", ".upsert(",
      "cancel_order", "mark_order_shipped", "resolve_order_cancellation_request",
      "request_order_cancellation", "apply_order_refund_state",
      "create_order_from_paid_checkout", "stripe", "Stripe", "checkout.sessions",
    ]) {
      assert.ok(!source.includes(forbidden), `the retry performs: ${forbidden}`);
    }
  }

  // ── THE ROUTE IS NO LONGER EMAIL-ONLY (Phase 3C.3) ─────────
  //
  // It gained the deferred subscription cancellation sweep, because the
  // Vercel Hobby plan permits one cron per day and that net needs a
  // durable timer. So the route may name Stripe - but only for that one
  // job, and only to set cancel_at on a subscription whose customer
  // already asked to end it.
  //
  // Asserted by symbol, which is stricter than the old blanket ban: that
  // would have permitted refunds.create in any file it did not list.
  for (const forbidden of [
    ".rpc(", ".insert(", ".delete(", ".upsert(",
    "cancel_order", "mark_order_shipped", "resolve_order_cancellation_request",
    "request_order_cancellation", "apply_order_refund_state",
    "create_order_from_paid_checkout", "checkout.sessions",
    "refunds.", "paymentIntents.", "prices.", "products.", "subscriptions.update",
  ]) {
    assert.ok(!routeCode.includes(forbidden), `the cron performs: ${forbidden}`);
  }
  // The ONLY Stripe surface the route names is the client factory, which
  // it hands straight to the sweep.
  const stripeUses = [...routeCode.matchAll(/\bstripe[A-Za-z.]*/g)].map(m => m[0]);
  assert.deepEqual([...new Set(stripeUses)].sort(), ["stripe"]);
  assert.ok(routeCode.includes("getStripeClient()"));
  assert.ok(routeCode.includes("sweepDueDeferredCancellations(stripe)"));
});

test("safety: no Stripe write API anywhere in the repository", () => {
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

test("safety: the retry chooses no recipient and builds no message of its own", () => {
  // Four families are driven by senders that take an order id and read
  // everything else themselves. The rules module has no message concept
  // at all.
  for (const forbidden of ["to:", "from:", "subject", "html", "replyTo", "resend", "Resend"]) {
    assert.ok(!rulesCode.includes(forbidden), `the rules module builds a message: ${forbidden}`);
  }
  assert.ok(!wiringCode.includes("resend.emails.send"), "the wiring sends directly");
  assert.ok(!wiringCode.includes("GLOA_INTERNAL_ORDERS"));
  // Since the 2E-B.1 hotfix the retry performs NO reconstruction at all:
  // the one family that needed it is excluded, so every remaining sender
  // takes an order id and reads every fact itself.
  assert.ok(!wiringCode.includes("customer_snapshot"), "the retry reads a customer snapshot");
  assert.ok(!wiringCode.includes("customer_details"), "the retry reads a Stripe payload");
});

/* ══════════════════════════════════════════════════════════════
   IDEMPOTENCY
   ══════════════════════════════════════════════════════════════ */

test("idempotency: the retry creates no key of its own", () => {
  for (const source of [wiringCode, rulesCode, routeCode]) {
    for (const forbidden of ["idempotencyKey", "IdempotencyKey", "gloa/", "randomUUID", "Math.random"]) {
      assert.ok(!source.includes(forbidden), `the retry invents a key: ${forbidden}`);
    }
  }
});

test("idempotency: all six deterministic namespaces still exist and are distinct", () => {
  const namespaces = [];
  for (const name of readdirSync(path.join(ROOT, "lib/email")).sort()) {
    const source = withoutComments(read(`lib/email/${name}`));
    for (const m of source.matchAll(/`gloa\/([a-z-]+)\//g)) namespaces.push(m[1]);
  }
  // Phase 3H.2 added gloa/subscription-started/, the first namespace that
  // is keyed on a subscription rather than an order. It is distinct from
  // all five order namespaces, and distinct from the two STRIPE keys in
  // lib/subscriptionCancellationRules.ts - which are not Resend keys and
  // deliberately do not live in lib/email.
  // Phase 3H.3 added gloa/cancellation-confirmation/, the second keyed on
  // a subscription. It is a different message from gloa/cancellation-request/
  // and gloa/cancellation-outcome/, which are the ORDER cancellation flow.
  assert.deepEqual(namespaces.sort(), [
    "cancellation-confirmation", "cancellation-outcome", "cancellation-request",
    "internal-order", "payment-problem", "refund", "shipment",
    "subscription-ended", "subscription-started",
  ]);
  assert.equal(new Set(namespaces).size, namespaces.length, "two templates share a namespace");
  // The order confirmation is the sixth family and deliberately has no
  // provider-side key: its duplicate guard is the database claim alone,
  // which predates this task and is not changed by it.
  const confirmation = withoutComments(read("lib/orderConfirmationEmail.ts"));
  assert.ok(confirmation.includes('.in("confirmation_email_status", ["pending", "failed"])'));
});

test("idempotency: the refund key still carries the durable cumulative total", () => {
  const template = withoutComments(read("lib/email/refundConfirmation.ts"));
  assert.ok(template.includes("`gloa/refund/${orderId}/${refundedTotalCents}`"));
  const sender = withoutComments(read("lib/refundConfirmationEmail.ts"));
  assert.ok(sender.includes("refundConfirmationIdempotencyKey(order.id, refundedTotalCents)"));
});

/* ══════════════════════════════════════════════════════════════
   THE CRON ROUTE
   ══════════════════════════════════════════════════════════════ */

test("cron: it reuses CRON_SECRET and creates no new secret", () => {
  // Still exactly one env var read here. STRIPE_SECRET_KEY is read by
  // lib/stripe.ts, which this route calls - it never touches the value,
  // and no new secret was invented for the sweep.
  const names = [...routeCode.matchAll(/process\.env\.(\w+)/g)].map(m => m[1]);
  assert.deepEqual([...new Set(names)].sort(), ["CRON_SECRET"]);
  // No OTHER secret is read here. The deepEqual above is already
  // exhaustive on process.env, so this checks the remaining ways a secret
  // could arrive - and names may still appear inside a log MESSAGE, which
  // is how every module in this repository reports an unset variable.
  for (const other of ["FULFILLMENT_ADMIN_SECRET", "CANCELLATION_ADMIN_SECRET", "RESEND_API_KEY"]) {
    assert.ok(!routeCode.includes(other), `the cron names ${other}`);
  }
  for (const read of ["process.env.STRIPE", "process.env.SUPABASE", "process.env.RESEND"]) {
    assert.ok(!routeCode.includes(read), `the cron reads ${read}`);
  }
  // And no secret VALUE is ever interpolated into a log line.
  for (const line of routeCode.split(NEWLINE).filter(l => l.includes("console."))) {
    assert.ok(!/\$\{\s*secret/i.test(line), "a log line interpolates the secret");
    assert.ok(!line.includes("process.env"), "a log line reads an environment variable");
  }
  const example = read(".env.example");
  for (const name of ["CRON_SECRET", "FULFILLMENT_ADMIN_SECRET", "CANCELLATION_ADMIN_SECRET", "RESEND_API_KEY"]) {
    assert.match(example, new RegExp(`^${name}=$`, "m"), `${name} gained a value or vanished`);
  }
});

test("cron: it fails closed and uses the shared timing-safe helper", () => {
  assert.ok(routeCode.includes("const secret = process.env.CRON_SECRET;"));
  assert.ok(routeCode.includes("if (!secret)"));
  assert.ok(routeCode.includes("status: 503"));
  assert.ok(routeCode.includes("isBearerSecretAuthorized(request, secret)"));
  assert.ok(routeCode.includes("status: 401"));
  for (const forbidden of ["=== secret", "timingSafeEqual", "createHash", "searchParams", "request.url"]) {
    assert.ok(!routeCode.includes(forbidden), `the cron rolls its own or reads a query param: ${forbidden}`);
  }
});

test("cron: the secret is never logged", () => {
  const logs = [...routeCode.matchAll(/console\.\w+\(([\s\S]*?)\);/g)].map(m => m[1]);
  assert.ok(logs.length > 0);
  for (const line of logs) {
    assert.ok(!line.includes("${secret}"), "a log line interpolates the secret");
    assert.ok(!/\bsecret\b/.test(line), `a log line references the secret variable: ${line}`);
    assert.ok(!line.includes("authorization"), "a log line contains the header");
  }
});

test("cron: it is GET only and drives the new orchestrator", () => {
  const handlers = [...route.matchAll(/export async function (\w+)\(/g)].map(m => m[1]);
  assert.deepEqual(handlers, ["GET"]);
  assert.ok(routeCode.includes("runTransactionalEmailRetryCron()"));
  assert.ok(!routeCode.includes("runInternalOrderNotificationCron()"), "the route still calls only the old sweep");
});

test("cron: exactly one schedule, unchanged, at the unchanged path", () => {
  const vercel = JSON.parse(read("vercel.json"));
  assert.equal((vercel.crons ?? []).length, 1, "a second cron schedule was added");
  assert.equal(vercel.crons[0].path, "/api/cron/retry-order-notifications");
  assert.equal(vercel.crons[0].schedule, "20 5 * * *");
});

test("cron: the response carries counts only, never a customer fact", () => {
  const summary = emptyFamilySummary();
  assert.deepEqual(Object.keys(summary).sort(), [
    "attempted", "eligible", "errored", "failed", "sent", "skipped", "staleFound", "staleRecovered",
  ]);
  for (const value of Object.values(summary)) {
    assert.ok(typeof value === "number" || typeof value === "boolean");
  }
  // The orchestrator returns ok plus all six family keys - the five it
  // runs, and order confirmation reported as disabled so the shape stays
  // stable and the exclusion is visible rather than silent.
  const ret = wiringCode.slice(wiringCode.lastIndexOf("return {"));
  assert.ok(ret.includes("ok: true"));
  for (const key of EMAIL_FAMILY_KEYS) {
    assert.ok(ret.includes(key), `the response omits ${key}`);
  }
  assert.ok(ret.includes("orderConfirmation: disabledFamilySummary("));
  // And a disabled family carries a reason, which is a string constant,
  // never a customer fact.
  assert.equal(typeof RETRY_DISABLED_FAMILIES.orderConfirmation, "string");
  assert.ok(!RETRY_DISABLED_FAMILIES.orderConfirmation.includes("@"));
});

test("logging: no PII reaches a log line anywhere in this feature", () => {
  for (const source of [wiringCode, routeCode]) {
    const logs = [...source.matchAll(/console\.\w+\(([\s\S]*?)\);/g)].map(m => m[1]);
    for (const line of logs) {
      for (const forbidden of [
        "customerEmail", "customer_snapshot", "snapshot", "address", "items",
        "refundedTotal", "notified", "note", "JSON.stringify", "order_number",
      ]) {
        assert.ok(!line.includes(forbidden), `a log line contains ${forbidden}: ${line}`);
      }
    }
  }
});

/* ══════════════════════════════════════════════════════════════
   REGRESSIONS
   ══════════════════════════════════════════════════════════════ */

test("regression: the internal notification sweep is reused, not rewritten", () => {
  assert.ok(wiringCode.includes("runInternalOrderNotificationCron()"));
  // Its own modules are untouched by this task.
  const legacyRules = read("lib/internalOrderNotificationRetryRules.ts");
  assert.ok(legacyRules.includes("export const RETRY_ELIGIBLE_STATUS = \"failed\";"));
  assert.ok(legacyRules.includes("export const RETRY_BATCH_LIMIT = 25;"));
  assert.ok(legacyRules.includes("export const STALE_SENDING_AFTER_MS = 30 * 60 * 1000;"));
  assert.ok(read("lib/internalOrderNotificationRetry.ts").includes("runInternalOrderNotificationCron"));
});

test("regression: every sender keeps its own claim and its own contract", () => {
  const claims = {
    "lib/orderConfirmationEmail.ts": '.in("confirmation_email_status", ["pending", "failed"])',
    "lib/shipmentConfirmationEmail.ts": '.or("shipment_email_status.is.null,shipment_email_status.eq.failed")',
    "lib/refundConfirmationEmail.ts":
      '.or("refund_email_status.is.null,refund_email_status.eq.sent,refund_email_status.eq.failed")',
  };
  for (const [rel, claim] of Object.entries(claims)) {
    assert.ok(withoutComments(read(rel)).includes(claim), `${rel} changed its claim`);
  }
  for (const rel of [
    "lib/cancellationRequestNotificationEmail.ts",
    "lib/cancellationOutcomeEmail.ts",
  ]) {
    const source = withoutComments(read(rel));
    assert.ok(source.includes("is.null,"), `${rel} changed its claim`);
    assert.ok(source.includes(".eq.failed"), `${rel} no longer accepts failed`);
  }
});

test("regression: the Stripe webhook and every business flow are unchanged", () => {
  const webhook = withoutComments(read("app/api/stripe/webhook/route.ts"));
  assert.ok(webhook.includes("isRefundEventType(event.type)"));
  assert.ok(webhook.includes("syncOrderRefundStateFromStripe(stripe, paymentIntentId)"));
  assert.ok(webhook.includes("isNewSettledRefundFact(outcome.result)"));
  assert.ok(webhook.includes("hasStripeWebhookEventBeenProcessed(event.id)"));
  assert.ok(!webhook.includes("runTransactionalEmailRetryCron"), "the webhook now runs the cron");

  const shipRoute = withoutComments(read("app/api/internal/orders/ship/route.ts"));
  assert.deepEqual([...shipRoute.matchAll(/\.rpc\("(\w+)"/g)].map(m => m[1]), ["mark_order_shipped"]);
  assert.ok(shipRoute.includes("cancellation_request_open"));

  const resolveRoute = withoutComments(read("app/api/internal/orders/cancellation-request/resolve/route.ts"));
  assert.deepEqual([...resolveRoute.matchAll(/\.rpc\("(\w+)"/g)].map(m => m[1]),
    ["resolve_order_cancellation_request"]);
});

test("regression: no migration was added and 022-033 are untouched", () => {
  const files = readdirSync(MIGRATIONS).filter(f => f.endsWith(".sql")).sort();
  // Phase 3C added 034 (subscription cancellation), which is not this
  // task's. What this assertion protects is that the RETRY needed no
  // migration of its own, so no later migration may touch the six
  // email-state vocabularies it depends on.
  for (const name of files.filter(f => f > "033_refund_confirmation_email_state.sql")) {
    // STATEMENTS ONLY. Migration 039's prose explains which house
    // pattern its own annual purchase confirmation follows, and doing so
    // quotes migration 017's grant verbatim. Citing a live column is not
    // touching it; what this guard is about is DDL.
    const later = readFileSync(path.join(MIGRATIONS, name), "utf-8")
      .split(NEWLINE)
      .filter(line => !line.trim().startsWith("--"))
      .join(NEWLINE);
    for (const owned of ["confirmation_email_status", "internal_notification_status",
                         "shipment_email_status", "cancellation_request_notification_status",
                         "cancellation_outcome_email_status", "refund_email_status"]) {
      // Anchored on the left, because these are COLUMN NAMES on
      // public.orders and a different table's column may legitimately end
      // with the same words. Phase 4B1's 039 owns
      // annual_plans.purchase_confirmation_email_status, which is its own
      // column on its own new table and is not one of the six this sweep
      // drains. A bare substring test would have read that as a
      // regression it is not.
      assert.ok(!new RegExp(`(?<![a-z_])${owned}`).test(later), `${name} touches ${owned}`);
    }
    // And what the six actually live on is untouched by anything later.
    assert.ok(!/alter table public\.orders/i.test(later),
      `${name} alters public.orders, where the six email states live`);
  }
  // The six state vocabularies are all exactly as their migrations left
  // them, which is what makes a no-migration retry possible.
  for (const [file, column] of [
    ["017_order_confirmation_email_state.sql", "confirmation_email_status"],
    ["026_internal_order_notification_state.sql", "internal_notification_status"],
    ["027_shipment_confirmation_email_state.sql", "shipment_email_status"],
    ["030_cancellation_request_notification_state.sql", "cancellation_request_notification_status"],
    ["031_cancellation_request_resolution.sql", "cancellation_outcome_email_status"],
    ["033_refund_confirmation_email_state.sql", "refund_email_status"],
  ]) {
    const sql = read(`supabase/migrations/${file}`);
    assert.ok(sql.includes(`grant update (${column}`) || sql.includes(`, ${column}`) || sql.includes(column),
      `${file} no longer owns ${column}`);
  }
});

test("regression: SHOP_STATUS, the subscription flag and pricing are unchanged", () => {
  assert.ok(read("app/content.ts").includes('export const SHOP_STATUS = "prelaunch" as const;'));
  assert.match(read(".env.example"), /^B2C_SUBSCRIPTIONS_ENABLED=$/m);
  for (const source of [wiringCode, rulesCode, routeCode]) {
    for (const forbidden of [
      "B2C_SUBSCRIPTIONS_ENABLED", "SHOP_STATUS", "price_gross_cents",
      "computeShippingGrossCents", "resolveCheckoutTax", "SHIPPING_ZONES",
    ]) {
      assert.ok(!source.includes(forbidden), `this task touches ${forbidden}`);
    }
  }
});

test("regression: no client bundle can see the cron, the secret or the sweep", () => {
  for (const rel of ["app/GloaSite.tsx", "app/AccountPortal.tsx", "app/Chrome.tsx"]) {
    const source = read(rel);
    for (const forbidden of ["CRON_SECRET", "runTransactionalEmailRetryCron", "/api/cron/"]) {
      assert.ok(!source.includes(forbidden), `${rel} exposes ${forbidden}`);
    }
  }
  const CLIENT = path.join(ROOT, ".output/public");
  if (!existsSync(CLIENT)) return;

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
      "CRON_SECRET", "runTransactionalEmailRetryCron", "isBearerSecretAuthorized",
      "RESEND_API_KEY", "refund_email_status", "timingSafeEqual",
    ]) {
      if (source.includes(needle)) leaks.push(`${path.relative(ROOT, file)}: ${needle}`);
    }
  }
  assert.deepEqual(leaks, [], `server-only material reached the client bundle: ${leaks.join(", ")}`);
});

/* ══════════════════════════════════════════════════════════════
   THE HTTP BOUNDARY, ON REAL SPAWNED SERVERS
   ══════════════════════════════════════════════════════════════ */

const ENDPOINT_PATH = "/api/cron/retry-order-notifications";
const SECRET = "test-only-cron-secret-not-a-real-value";

/**
 * Every server is started without SUPABASE_SECRET_KEY and without
 * RESEND_API_KEY, so even a fully authorized request cannot reach a
 * database: it stops at the 503 the route returns when the admin client
 * is unconfigured, which is strictly before any sweep and therefore
 * strictly before any email.
 */
function serverEnv(extra) {
  const env = writeBlockedServerEnv({ ...extra });
  delete env.RESEND_API_KEY;
  delete env.RESEND_CONTACT_FROM;
  delete env.FULFILLMENT_ADMIN_SECRET;
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

const get = (port, headers = {}) =>
  fetch(`http://127.0.0.1:${port}${ENDPOINT_PATH}`, { method: "GET", headers });

const UNSET_PORT = 8954;
let unsetServer;

test.before(async () => {
  unsetServer = await startServer(UNSET_PORT, { CRON_SECRET: "" });
});

test.after(() => {
  unsetServer?.kill();
});

test("http: an unconfigured CRON_SECRET refuses every caller", async () => {
  for (const headers of [{}, { authorization: "Bearer " }, { authorization: `Bearer ${SECRET}` }]) {
    const res = await get(UNSET_PORT, headers);
    assert.equal(res.status, 503, JSON.stringify(headers));
    assert.equal((await res.json().catch(() => null))?.ok, undefined);
  }
});

const SECURED_PORT = 8955;
let securedServer;

test.before(async () => {
  securedServer = await startServer(SECURED_PORT, { CRON_SECRET: SECRET });
});

test.after(() => {
  securedServer?.kill();
});

test("http: no bearer secret is rejected", async () => {
  assert.equal((await get(SECURED_PORT)).status, 401);
});

test("http: a wrong or malformed secret is rejected", async () => {
  for (const authorization of [
    "Bearer", "Bearer ", "Bearer wrong-secret", `Bearer ${SECRET}x`,
    `Bearer ${SECRET.slice(0, -1)}`, `bearer ${SECRET}`, `Basic ${SECRET}`, SECRET,
    "Bearer test-only-fulfillment-secret-not-a-real-value",
    "Bearer test-only-cancellation-secret-not-a-real-value",
  ]) {
    const res = await get(SECURED_PORT, { authorization });
    assert.equal(res.status, 401, authorization);
  }
});

test("http: the correct secret is accepted and stops at the unconfigured database", async () => {
  // Proof that the whole chain is reachable with the right secret, and
  // that this suite can never sweep or mail anything for real.
  const res = await get(SECURED_PORT, { authorization: `Bearer ${SECRET}` });
  assert.equal(res.status, 503);
  const parsed = await res.json();
  assert.equal(parsed.ok, undefined);
  assert.equal(parsed.error, "Vorübergehend nicht verfügbar.");
});

test("http: POST, PUT, PATCH and DELETE are not surfaces", async () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const res = await fetch(`http://127.0.0.1:${SECURED_PORT}${ENDPOINT_PATH}`, {
      method,
      headers: { authorization: `Bearer ${SECRET}` },
    });
    assert.ok(res.status === 404 || res.status === 405, `${method} answered ${res.status}`);
  }
});

test("http: no response body ever contains the secret", async () => {
  const responses = await Promise.all([
    get(SECURED_PORT),
    get(SECURED_PORT, { authorization: "Bearer wrong" }),
    get(SECURED_PORT, { authorization: `Bearer ${SECRET}` }),
  ]);
  for (const res of responses) {
    const text = await res.text();
    assert.ok(!text.includes(SECRET), "a response echoed the secret");
    assert.ok(!text.includes("CRON_SECRET"), "a response named the secret variable");
    assert.ok(!text.includes("@"), "a response contains an address");
  }
});

test("no real Resend request, no Stripe request and no production Supabase in this suite", () => {
  const suite = withoutComments(read("tests/transactional-email-retry.test.mjs"));
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
