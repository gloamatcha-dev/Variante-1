import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SUBSCRIPTION_EMAIL_RETRY_FAMILIES,
  SUBSCRIPTION_RETRY_BATCH_LIMIT,
  SUBSCRIPTION_RETRY_ELIGIBLE_STATUS,
  SUBSCRIPTION_RETRY_NEVER_ELIGIBLE_STATUSES,
  STALE_SENDING_DIAGNOSTIC_AFTER_MS,
  STALE_SENDING_DIAGNOSTIC_LIMIT,
  emptySubscriptionFamilySummary,
  inspectStaleSubscriptionEmailDeliveries,
  isSubscriptionEmailRetryFamily,
  isSubscriptionRetryEligibleStatus,
  runSubscriptionFamilyRetry,
  staleSubscriptionSendingCutoff,
} from "../lib/subscriptionEmailDeliveryRules.ts";

// SAFE DEFAULT SUITE: pure sweep logic driven by in-memory fake ports,
// plus source-level checks. No server is spawned, no database is
// reachable, no Supabase client is constructed, no Stripe API is called,
// no Resend request is made and no email of any kind is sent. Nothing
// here executes SQL and nothing here requires TEST_SUPABASE_*.
//
// THE RULE THIS SUITE EXISTS TO PROTECT: a retry may select 'failed' and
// nothing else. 'sending' is ambiguous about whether Resend already
// accepted the message, and this repository has already sent 25 duplicate
// order confirmations, on 2026-08-21, by treating an ambiguous state as
// retryable.

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf-8");
const NEWLINE = String.fromCharCode(10);

const MIGRATIONS_DIR = path.join(ROOT, "supabase/migrations");

const withoutComments = source => source
  .split(NEWLINE)
  .filter(line => {
    const t = line.trim();
    return !t.startsWith("--") && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
  })
  .join(NEWLINE);

const retryCode = withoutComments(read("lib/subscriptionEmailRetry.ts"));
const rulesCode = withoutComments(read("lib/subscriptionEmailDeliveryRules.ts"));
const cronCode = withoutComments(read("app/api/cron/retry-order-notifications/route.ts"));
const retryRulesCode = withoutComments(read("lib/transactionalEmailRetryRules.ts"));
const retryWiringCode = withoutComments(read("lib/transactionalEmailRetry.ts"));

const STARTED = "subscription_started";
const CANCELLATION = "cancellation_confirmation";
const ENDED = "subscription_ended";
const PAYMENT = "payment_problem";

const row = (id, family = STARTED, overrides = {}) => ({
  id,
  subscription_id: `sub-${id}`,
  family,
  event_key: `key-${id}`,
  ...overrides,
});

/**
 * An in-memory port over fake rows.
 *
 * The selection is written the way the real port writes it - status
 * equals 'failed', nothing else - so a change that widened the real
 * predicate would have to be copied here to keep these tests passing,
 * which is exactly the point.
 */
function fakePort(rows, { outcome, staleRows = [], onClaim } = {}) {
  const claims = [];
  const sends = [];
  const logs = [];
  const writes = [];
  return {
    claims,
    sends,
    logs,
    writes,
    port: {
      loadFailed: async (family, limit) =>
        rows
          .filter(r => r.family === family && r.status === "failed")
          .sort((a, b) => String(a.updated_at).localeCompare(String(b.updated_at)))
          .slice(0, limit)
          .map(r => row(r.id, r.family)),
      claimFailed: async deliveryId => {
        claims.push(deliveryId);
        if (onClaim) return onClaim(deliveryId);
        const target = rows.find(r => r.id === deliveryId);
        // COMPARE AND SWAP: it only wins while the row still says failed.
        if (!target || target.status !== "failed") return false;
        target.status = "sending";
        writes.push(`${deliveryId}:sending`);
        return true;
      },
      retryClaimed: async r => {
        sends.push(r.id);
        const result = outcome ? outcome(r) : "sent";
        const target = rows.find(x => x.id === r.id);
        if (target && (result === "sent" || result === "failed" || result === "superseded")) {
          target.status = result;
          writes.push(`${r.id}:${result}`);
        }
        return result;
      },
      loadStaleSending: async (family, cutoffIso, limit) =>
        staleRows
          .filter(r => r.family === family && r.status === "sending" && r.updated_at <= cutoffIso)
          .sort((a, b) => String(a.updated_at).localeCompare(String(b.updated_at)))
          .slice(0, limit)
          .map(r => ({ id: r.id })),
      logFailure: (id, message) => logs.push(`${id}: ${message}`),
    },
  };
}

const CUTOFF = "2026-08-28T05:00:00.000Z";

/* ══════════════════════════════════════════════════════════════
   1-4. WHICH STATUSES MAY BE RETRIED
   ══════════════════════════════════════════════════════════════ */

test("1: the only retry-eligible status is 'failed'", () => {
  assert.equal(SUBSCRIPTION_RETRY_ELIGIBLE_STATUS, "failed");
  assert.equal(isSubscriptionRetryEligibleStatus("failed"), true);
  for (const never of [null, undefined, "sending", "sent", "superseded", "", "FAILED", "x"]) {
    assert.equal(isSubscriptionRetryEligibleStatus(never), false, String(never));
  }
});

test("2-4: sending, sent and superseded are never selected", async () => {
  assert.deepEqual([...SUBSCRIPTION_RETRY_NEVER_ELIGIBLE_STATUSES].sort(),
    ["sending", "sent", "superseded"]);

  const rows = [
    { id: "a", family: STARTED, status: "failed", updated_at: "1" },
    { id: "b", family: STARTED, status: "sending", updated_at: "0" },
    { id: "c", family: STARTED, status: "sent", updated_at: "0" },
    { id: "d", family: STARTED, status: "superseded", updated_at: "0" },
  ];
  const { port, sends } = fakePort(rows);
  const summary = emptySubscriptionFamilySummary();
  await runSubscriptionFamilyRetry(port, STARTED, summary);

  assert.deepEqual(sends, ["a"], "only the failed row may be sent");
  assert.equal(summary.selected, 1);
  assert.equal(summary.sent, 1);
  // The other three are untouched.
  assert.equal(rows[1].status, "sending");
  assert.equal(rows[2].status, "sent");
  assert.equal(rows[3].status, "superseded");
});

/* ══════════════════════════════════════════════════════════════
   5-8. FAMILIES, LIMITS AND ORDERING
   ══════════════════════════════════════════════════════════════ */

test("2b: the REAL selection query filters on 'failed' and on nothing else", () => {
  // The fake port above filters correctly by construction, so it can only
  // prove the orchestration. This proves the SQL: a widened predicate in
  // the real port would reach 'sending' rows, which are ambiguous about
  // whether Resend already accepted the message.
  const load = retryCode.slice(
    retryCode.indexOf("loadFailed: async (family, limit) =>"),
    retryCode.indexOf("claimFailed: async deliveryId =>")
  );
  assert.ok(load.length > 0, "the failed query could not be isolated");
  assert.ok(load.includes('.eq("status", "failed")'), "the work list does not filter on failed");
  assert.ok(load.includes('.eq("family", family)'), "the work list is not per family");
  assert.ok(load.includes(".limit(limit)"), "the work list is unbounded");
  // Never a widened predicate, never a NULL check, never an OR.
  for (const forbidden of ['.in("status"', '"sending"', '"sent"', '"superseded"', ".or(", ".is(", ".not("]) {
    assert.ok(!load.includes(forbidden), `the work list was widened: ${forbidden}`);
  }
});

test("5: exactly the four families are handled", () => {
  // PHASE 3I.B2 ADDED payment_problem, the fourth and last family
  // migration 036 permits.
  assert.deepEqual([...SUBSCRIPTION_EMAIL_RETRY_FAMILIES], [STARTED, CANCELLATION, ENDED, PAYMENT]);
  for (const family of SUBSCRIPTION_EMAIL_RETRY_FAMILIES) {
    assert.equal(isSubscriptionEmailRetryFamily(family), true);
  }
  // And the retry module dispatches all three by name.
  for (const constant of [
    "SUBSCRIPTION_STARTED_FAMILY", "CANCELLATION_CONFIRMATION_FAMILY",
    "SUBSCRIPTION_ENDED_FAMILY", "PAYMENT_PROBLEM_FAMILY",
  ]) {
    assert.ok(retryCode.includes(`case ${constant}:`), `the dispatch lost ${constant}`);
  }
});

test("6: an unknown family fails closed and sends nothing", async () => {
  // payment_problem is a KNOWN family since Phase 3I.B2, so the unknown
  // cases are now genuinely unknown ones.
  for (const unknown of ["payment_failed", "", null, undefined, "Subscription_Started"]) {
    assert.equal(isSubscriptionEmailRetryFamily(unknown), false, String(unknown));
  }
  const rows = [{ id: "a", family: "payment_failed", status: "failed", updated_at: "1" }];
  const { port, sends } = fakePort(rows);
  const summary = emptySubscriptionFamilySummary();
  await runSubscriptionFamilyRetry(port, "payment_failed", summary);
  assert.deepEqual(sends, []);
  assert.equal(summary.errors, 1);
  assert.equal(summary.selected, 0);
  // And the dispatcher throws rather than guessing which sender it is.
  assert.ok(retryCode.includes("throw new Error(`unknown subscription email family:"));
});

test("6b: a row of another family is never dispatched by this one", async () => {
  // Belt to the query's braces: even if a port returned a foreign row.
  const port = {
    loadFailed: async () => [row("a", ENDED)],
    claimFailed: async () => true,
    retryClaimed: async () => "sent",
    loadStaleSending: async () => [],
    logFailure: () => {},
  };
  const summary = emptySubscriptionFamilySummary();
  await runSubscriptionFamilyRetry(port, STARTED, summary);
  assert.equal(summary.errors, 1);
  assert.equal(summary.claimed, 0);
});

test("7: each family has its own independent limit of 25", async () => {
  assert.equal(SUBSCRIPTION_RETRY_BATCH_LIMIT, 25);
  const limits = [];
  const port = {
    loadFailed: async (family, limit) => { limits.push([family, limit]); return []; },
    claimFailed: async () => false,
    retryClaimed: async () => "sent",
    loadStaleSending: async () => [],
    logFailure: () => {},
  };
  for (const family of SUBSCRIPTION_EMAIL_RETRY_FAMILIES) {
    await runSubscriptionFamilyRetry(port, family, emptySubscriptionFamilySummary());
  }
  assert.deepEqual(limits, [[STARTED, 25], [CANCELLATION, 25], [ENDED, 25], [PAYMENT, 25]]);
});

test("8, 54: a full family backlog cannot starve another family", async () => {
  // 60 failed start messages and one cancellation confirmation.
  const rows = [];
  for (let i = 0; i < 60; i += 1) {
    rows.push({ id: `s${String(i).padStart(2, "0")}`, family: STARTED, status: "failed", updated_at: `0${i}` });
  }
  rows.push({ id: "c1", family: CANCELLATION, status: "failed", updated_at: "99" });

  const { port, sends } = fakePort(rows);
  const summaries = {};
  for (const family of SUBSCRIPTION_EMAIL_RETRY_FAMILIES) {
    summaries[family] = emptySubscriptionFamilySummary();
    await runSubscriptionFamilyRetry(port, family, summaries[family]);
  }

  // The start family spends its own 25 and no more.
  assert.equal(summaries[STARTED].selected, 25);
  // The cancellation confirmation is NOT starved: it runs in the same
  // invocation, out of its own bucket, despite the 60-row backlog.
  assert.equal(summaries[CANCELLATION].selected, 1);
  assert.ok(sends.includes("c1"), "a backlog in one family starved another");
});

test("8b: candidates are taken oldest first, by updated_at ascending", async () => {
  const rows = [
    { id: "new", family: STARTED, status: "failed", updated_at: "2026-08-28T09:00:00Z" },
    { id: "old", family: STARTED, status: "failed", updated_at: "2026-08-01T09:00:00Z" },
    { id: "mid", family: STARTED, status: "failed", updated_at: "2026-08-14T09:00:00Z" },
  ];
  const { port, sends } = fakePort(rows);
  await runSubscriptionFamilyRetry(port, STARTED, emptySubscriptionFamilySummary());
  assert.deepEqual(sends, ["old", "mid", "new"]);
  // And the real port orders in SQL rather than relying on PostgREST.
  assert.ok(retryCode.includes('.order("updated_at", { ascending: true })'));
  assert.equal((retryCode.match(/\.order\("updated_at", \{ ascending: true \}\)/g) ?? []).length, 2,
    "both the failed query and the stale query must be ordered");
});

/* ══════════════════════════════════════════════════════════════
   9-14. THE CLAIM
   ══════════════════════════════════════════════════════════════ */

test("9, 10, 43, 44: the retry can create no delivery row at all", () => {
  for (const f of ["insert(", "upsert(", "delete(", ".rpc("]) {
    assert.ok(!retryCode.includes(f), `the retry module can write a new row: ${f}`);
  }
  // It never reads public.subscriptions to invent work either.
  assert.ok(!retryCode.includes('.from("subscriptions")'),
    "the retry must not scan subscriptions");
  // Its only table is the delivery table.
  const tables = [...retryCode.matchAll(/\.from\("([a-z_]+)"\)/g)].map(m => m[1]);
  assert.deepEqual([...new Set(tables)], ["subscription_email_deliveries"]);
  // And the port type itself offers no way to insert.
  const portType = rulesCode.slice(
    rulesCode.indexOf("export type SubscriptionEmailRetryPort = {"),
    rulesCode.indexOf("};", rulesCode.indexOf("export type SubscriptionEmailRetryPort = {"))
  );
  for (const forbidden of ["insert", "upsert", "create", "delete"]) {
    assert.ok(!portType.includes(forbidden), `the port exposes ${forbidden}`);
  }
});

test("11, 12: the claim is an atomic compare-and-swap on id AND status", () => {
  const claim = retryCode.slice(
    retryCode.indexOf("claimFailed: async deliveryId =>"),
    retryCode.indexOf("retryClaimed: retryClaimedDelivery")
  );
  assert.ok(claim.includes('.update({ status: "sending" })'));
  assert.ok(claim.includes('.eq("id", deliveryId)'));
  assert.ok(claim.includes('.eq("status", "failed")'), "the CAS must pin the prior status");
  assert.ok(claim.includes('.select("id")'), "the CAS must report whether it won");
  assert.ok(claim.includes("return (data?.length ?? 0) > 0;"));
  // No select-then-update: the only .select in the claim is the RETURNING.
  assert.equal((claim.match(/\.select\(/g) ?? []).length, 1);
  assert.ok(!claim.includes(".maybeSingle()"));
  // And identity columns are never written.
  for (const forbidden of ["subscription_id", "family", "event_key", "created_at", "updated_at"]) {
    assert.ok(!claim.includes(forbidden), `the claim writes ${forbidden}`);
  }
});

test("13: a lost claim means no provider call", async () => {
  const rows = [{ id: "a", family: STARTED, status: "failed", updated_at: "1" }];
  const { port, sends, claims } = fakePort(rows, { onClaim: () => false });
  const summary = emptySubscriptionFamilySummary();
  await runSubscriptionFamilyRetry(port, STARTED, summary);
  assert.deepEqual(claims, ["a"]);
  assert.deepEqual(sends, [], "a lost claim must not contact the provider");
  assert.equal(summary.selected, 1);
  assert.equal(summary.claimed, 0);
});

test("14, 35: two workers cannot both retry the same failed row", async () => {
  // One shared row set, two independent sweeps, as two cron workers.
  const rows = [{ id: "x", family: STARTED, status: "failed", updated_at: "1" }];
  const a = fakePort(rows);
  const b = fakePort(rows);

  await runSubscriptionFamilyRetry(a.port, STARTED, emptySubscriptionFamilySummary());
  await runSubscriptionFamilyRetry(b.port, STARTED, emptySubscriptionFamilySummary());

  // A won and sent. B found the row no longer 'failed' and sent nothing.
  assert.deepEqual(a.sends, ["x"]);
  assert.deepEqual(b.sends, [], "the second worker must lose the compare-and-swap");
});

/* ══════════════════════════════════════════════════════════════
   15-24. THE FAMILY PATHS ARE REUSED, NOT REBUILT
   ══════════════════════════════════════════════════════════════ */

test("15-20: each family reuses its own sender's claimed-delivery path", () => {
  for (const fn of [
    "deliverClaimedSubscriptionStarted",
    "deliverClaimedCancellationConfirmation",
    "deliverClaimedSubscriptionEnded",
  ]) {
    assert.ok(retryCode.includes(fn), `the retry does not reuse ${fn}`);
  }
  // The cancellation retry passes the delivery row's OWN event key, so the
  // preflight re-proves the persisted pair still reconstructs this event.
  assert.ok(retryCode.includes("deliverClaimedCancellationConfirmation(row.subscription_id, row.event_key, row.id)"));

  // Each sender still runs its authoritative preflight after the claim.
  for (const [file, preflight] of [
    ["lib/subscriptionStartedEmail.ts", "evaluateSubscriptionStartPreflight("],
    ["lib/cancellationConfirmationEmail.ts", "evaluateCancellationConfirmationPreflight("],
    ["lib/subscriptionEndedEmail.ts", "evaluateSubscriptionEndedPreflight("],
  ]) {
    const sender = withoutComments(read(file));
    const deliverAt = sender.indexOf("export async function deliverClaimed");
    assert.notEqual(deliverAt, -1, `${file} does not expose its claimed path`);
    const body = sender.slice(deliverAt);
    assert.ok(body.includes(preflight), `${file} lost its preflight`);
    // Superseded still precedes the provider.
    const supersededAt = body.indexOf('preflight.kind === "superseded"');
    const providerAt = body.indexOf("getResendClient()");
    assert.ok(supersededAt !== -1 && supersededAt < providerAt);
  }

  // And the PUBLIC entry points are deliberately not used: they begin
  // with an INSERT that would conflict with the existing row forever.
  for (const entry of [
    "sendSubscriptionStartedEmailIfNeeded",
    "sendCancellationConfirmationEmailIfNeeded",
    "sendSubscriptionEndedEmailIfNeeded",
  ]) {
    assert.ok(!retryCode.includes(entry), `the retry calls the INSERT entry point: ${entry}`);
  }
});

test("21, 22: the recipient still comes only from customer_snapshot.email", () => {
  // The retry stores no recipient and accepts none. Checked on the
  // recipient vocabulary rather than on the word "email", which the
  // module's own name and the delivery table both legitimately contain.
  for (const forbidden of [
    "recipient", "customer_snapshot", "to:", "customer_email", "emailAddress",
  ]) {
    assert.ok(!retryCode.includes(forbidden), `the retry handles a recipient: ${forbidden}`);
  }
  // The single shared helper still reads snapshot.email.
  assert.ok(rulesCode.includes("export function recipientFromCustomerSnapshot("));
  assert.ok(rulesCode.includes("if (typeof customer.email !== \"string\") return null;"));
  // The delivery row the retry passes around carries no customer data.
  const rowType = rulesCode.slice(
    rulesCode.indexOf("export type SubscriptionEmailDeliveryRow = {"),
    rulesCode.indexOf("};", rulesCode.indexOf("export type SubscriptionEmailDeliveryRow = {"))
  );
  for (const forbidden of ["email", "recipient", "name", "snapshot"]) {
    assert.ok(!rowType.includes(forbidden), `the delivery row carries ${forbidden}`);
  }
});

test("23, 24: the original templates and provider keys are reused", () => {
  // No retry-specific template and no retry-specific provider key.
  for (const forbidden of ["build", "Idempotency", "idempotencyKey", "gloa/"]) {
    assert.ok(!retryCode.includes(forbidden), `the retry built its own ${forbidden}`);
  }
  // The senders keep theirs, and the retry goes through them.
  for (const [file, key] of [
    ["lib/subscriptionStartedEmail.ts", "subscriptionStartedIdempotencyKey(subscriptionId)"],
    ["lib/cancellationConfirmationEmail.ts", "cancellationConfirmationIdempotencyKey(subscriptionId, eventKey)"],
    ["lib/subscriptionEndedEmail.ts", "subscriptionEndedIdempotencyKey(subscriptionId)"],
  ]) {
    assert.ok(withoutComments(read(file)).includes(key), `${file} lost its provider key`);
  }
});

/* ══════════════════════════════════════════════════════════════
   25-32. RETRY OUTCOMES
   ══════════════════════════════════════════════════════════════ */

test("25-30: every outcome is counted and only three of them write", async () => {
  const outcomes = ["sent", "failed", "superseded", "ambiguous"];
  const rows = outcomes.map((o, i) => ({
    id: o, family: STARTED, status: "failed", updated_at: `0${i}`,
  }));
  const { port, writes } = fakePort(rows, { outcome: r => r.id });
  const summary = emptySubscriptionFamilySummary();
  await runSubscriptionFamilyRetry(port, STARTED, summary);

  assert.equal(summary.sent, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.superseded, 1);
  assert.equal(summary.ambiguous, 1);
  assert.equal(summary.claimed, 4);

  // The ambiguous row is left exactly where the claim put it: 'sending'.
  assert.equal(rows[3].status, "sending", "an ambiguous retry must stay sending");
  assert.ok(!writes.includes("ambiguous:failed"));
  assert.ok(!writes.includes("ambiguous:sent"));
  assert.ok(!writes.includes("ambiguous:superseded"));

  // 5xx, statusCode null and a thrown exception all classify as ambiguous
  // and therefore all land in that same branch - proven in
  // tests/subscription-email-provider-outcome.test.mjs, reused here.
  assert.ok(rulesCode.includes("export function classifySubscriptionEmailProviderError("));
});

test("31, 32, 36: one provider attempt per row per run, and no loop", async () => {
  // A row that returns to 'failed' this run is NOT re-selected.
  const rows = [{ id: "a", family: STARTED, status: "failed", updated_at: "1" }];
  const { port, sends } = fakePort(rows, { outcome: () => "failed" });
  const summary = emptySubscriptionFamilySummary();
  await runSubscriptionFamilyRetry(port, STARTED, summary);

  assert.deepEqual(sends, ["a"], "a re-failed row must not be attempted twice in one run");
  assert.equal(summary.failed, 1);
  assert.equal(rows[0].status, "failed", "it stays eligible for the NEXT run");

  // The candidate list is read once. No while-loop over the work list.
  assert.ok(!/while\s*\(/.test(rulesCode.slice(
    rulesCode.indexOf("export async function runSubscriptionFamilyRetry"),
    rulesCode.indexOf("export async function inspectStaleSubscriptionEmailDeliveries")
  )), "the sweep must not loop until the work list is empty");
  assert.ok(!/while\s*\(/.test(retryCode));
});

test("53: one bad delivery does not stop the rest of its family", async () => {
  const rows = ["a", "b", "c"].map((id, i) => ({
    id, family: STARTED, status: "failed", updated_at: `0${i}`,
  }));
  const { port, sends, logs } = fakePort(rows, {
    outcome: r => { if (r.id === "b") throw new Error("boom"); return "sent"; },
  });
  const summary = emptySubscriptionFamilySummary();
  await runSubscriptionFamilyRetry(port, STARTED, summary);

  assert.deepEqual(sends, ["a", "b", "c"], "the loop must continue past a bad row");
  assert.equal(summary.sent, 2);
  assert.equal(summary.errors, 1);
  assert.equal(logs.length, 1);
  assert.ok(logs[0].startsWith("b: "));
});

/* ══════════════════════════════════════════════════════════════
   33-40. STALE SENDING IS DIAGNOSTIC ONLY
   ══════════════════════════════════════════════════════════════ */

test("33: the stale threshold is 30 minutes, and diagnostic only", () => {
  assert.equal(STALE_SENDING_DIAGNOSTIC_AFTER_MS, 30 * 60 * 1000);
  assert.equal(STALE_SENDING_DIAGNOSTIC_LIMIT, 25);
  const nowMs = Date.parse("2026-08-28T06:00:00.000Z");
  assert.equal(staleSubscriptionSendingCutoff(nowMs), "2026-08-28T05:30:00.000Z");
  // The name says inspect, not recover, so nobody assumes it mutates.
  assert.ok(rulesCode.includes("export async function inspectStaleSubscriptionEmailDeliveries("));
  assert.ok(!rulesCode.includes("recoverStaleSending"));
  assert.ok(!retryCode.includes("recoverStale"));
});

test("34, 35, 36: the stale path reads and never writes", async () => {
  const staleRows = [
    { id: "s1", family: STARTED, status: "sending", updated_at: "2026-08-01T00:00:00Z" },
    { id: "s2", family: STARTED, status: "sending", updated_at: "2026-08-02T00:00:00Z" },
    { id: "fresh", family: STARTED, status: "sending", updated_at: "2026-08-29T00:00:00Z" },
  ];
  const { port, writes, sends } = fakePort([], { staleRows });
  const summary = emptySubscriptionFamilySummary();
  await inspectStaleSubscriptionEmailDeliveries(port, STARTED, CUTOFF, summary);

  assert.equal(summary.staleSendingCount, 2);
  assert.deepEqual(summary.staleSendingIds, ["s1", "s2"]);
  // NOTHING was written and nothing was sent.
  assert.deepEqual(writes, []);
  assert.deepEqual(sends, []);
  // The rows keep their status: no sending -> failed, ever.
  assert.deepEqual(staleRows.map(r => r.status), ["sending", "sending", "sending"]);

  // And the function body contains no write of any kind.
  const body = rulesCode.slice(
    rulesCode.indexOf("export async function inspectStaleSubscriptionEmailDeliveries"),
    rulesCode.indexOf("export const PAYMENT_PROBLEM_FAMILY")
  );
  for (const forbidden of ["update", "upsert", "insert", "delete", "rpc", "claim"]) {
    assert.ok(!body.includes(forbidden), `the stale inspection can write: ${forbidden}`);
  }
});

test("34b: the real stale query is a bounded, ordered SELECT", () => {
  const stale = retryCode.slice(
    retryCode.indexOf("loadStaleSending: async (family, cutoffIso, limit)"),
    retryCode.indexOf("logFailure:")
  );
  assert.ok(stale.includes('.select("id")'), "stale diagnostics must read ids only");
  assert.ok(stale.includes('.eq("status", "sending")'));
  assert.ok(stale.includes('.lte("updated_at", cutoffIso)'));
  assert.ok(stale.includes(".limit(limit)"));
  for (const forbidden of [".update(", ".upsert(", ".insert(", ".delete("]) {
    assert.ok(!stale.includes(forbidden), `the stale query writes: ${forbidden}`);
  }
});

test("37-40: stale diagnostics expose only the delivery uuid and family", () => {
  const summaryType = rulesCode.slice(
    rulesCode.indexOf("export type SubscriptionEmailFamilySummary = {"),
    rulesCode.indexOf("};", rulesCode.indexOf("export type SubscriptionEmailFamilySummary = {"))
  );
  assert.ok(summaryType.includes("staleSendingIds: string[];"));
  for (const leak of [
    "subscription_id", "subscriptionId", "event_key", "eventKey",
    "email", "recipient", "name", "customer", "snapshot", "plan",
  ]) {
    assert.ok(!summaryType.includes(leak), `the summary carries ${leak}`);
  }
  // The port returns ids only for stale rows.
  assert.ok(rulesCode.includes("loadStaleSending: (family: string, cutoffIso: string, limit: number) => Promise<{ id: string }[]>;"));
  // The family key is the migration's own family name, which is not PII.
  assert.ok(retryCode.includes("families[family] = emptySubscriptionFamilySummary();"));
});

test("41, 42: sent never becomes superseded, and superseded never sends", () => {
  for (const file of [
    "lib/subscriptionStartedEmail.ts",
    "lib/cancellationConfirmationEmail.ts",
    "lib/subscriptionEndedEmail.ts",
  ]) {
    const sender = withoutComments(read(file));
    assert.ok(sender.includes('.in("status", ["sending", "failed"])'),
      `${file} allows sent -> superseded`);
    assert.ok(sender.includes('.eq("status", "sending")'), `${file} lost its mark-failed guard`);
  }
});

/* ══════════════════════════════════════════════════════════════
   45-52. THE CRON AND EVERYTHING AROUND IT
   ══════════════════════════════════════════════════════════════ */

test("45, 46: the order retry engine and its disabled family are untouched", () => {
  assert.ok(retryRulesCode.includes('export const RETRY_ELIGIBLE_STATUS = "failed";'));
  assert.ok(retryRulesCode.includes("RETRY_DISABLED_FAMILIES"));
  // orderConfirmation must stay excluded from automatic retry.
  const disabled = retryRulesCode.slice(retryRulesCode.indexOf("RETRY_DISABLED_FAMILIES"));
  assert.ok(disabled.includes("orderConfirmation"), "orderConfirmation retry was re-enabled");
  // The six order families are unchanged and know nothing about us.
  for (const forbidden of [
    "subscription_email_deliveries", "subscription_started", "subscriptionEmailRetry",
  ]) {
    assert.ok(!retryRulesCode.includes(forbidden));
    assert.ok(!retryWiringCode.includes(forbidden));
  }
});

test("47: the deferred cancellation sweep is unchanged", () => {
  const service = withoutComments(read("lib/subscriptionCancellation.ts"));
  assert.ok(service.includes("export async function sweepDueDeferredCancellations("));
  assert.ok(service.includes("applyDeferredCancellationFromRenewal("));
  for (const forbidden of ["subscriptionEmailRetry", "runSubscriptionEmailRetrySweep", "loadStaleSending"]) {
    assert.ok(!service.includes(forbidden), `the cancellation service changed: ${forbidden}`);
  }
  assert.ok(cronCode.includes("sweepDueDeferredCancellations(stripe)"));
});

test("48, 49: exactly one cron remains, on the unchanged schedule", () => {
  const vercel = JSON.parse(read("vercel.json"));
  assert.equal(vercel.crons.length, 1, "a second cron appeared");
  assert.deepEqual(vercel.crons, [
    { path: "/api/cron/retry-order-notifications", schedule: "20 5 * * *" },
  ]);
  // And there is no second cron route file.
  const cronDirs = readdirSync(path.join(ROOT, "app/api/cron"));
  assert.deepEqual(cronDirs, ["retry-order-notifications"]);
});

test("50, 51: the sweep runs in the existing route, after the other two jobs", () => {
  const orderAt = cronCode.indexOf("runTransactionalEmailRetryCron()");
  const deferredAt = cronCode.indexOf("sweepDueDeferredCancellations(stripe)");
  const subscriptionAt = cronCode.indexOf("runSubscriptionEmailRetrySweep()");
  assert.ok(orderAt !== -1 && deferredAt !== -1 && subscriptionAt !== -1);
  assert.ok(orderAt < deferredAt, "the order retries must stay first");
  assert.ok(deferredAt < subscriptionAt, "the subscription sweep must run last");
});

test("52: the sweep has its own error boundary and reports errored", () => {
  // Anchored on the FINAL response, not the first: the route returns
  // early with 503/401 responses long before the sweep block.
  const blockStart = cronCode.indexOf("let subscriptionEmails;");
  assert.notEqual(blockStart, -1, "the sweep block disappeared");
  const block = cronCode.slice(
    blockStart,
    cronCode.indexOf("{ ...summary, deferredCancellations, subscriptionEmails }", blockStart)
  );
  assert.ok(block.length > 0, "the sweep block could not be isolated");
  assert.ok(block.includes("try {"), "the sweep needs its own try");
  assert.ok(block.includes("} catch (err) {"));
  assert.ok(block.includes("emptySubscriptionEmailRetrySummary(true)"),
    "a thrown sweep must report errored: true");
  // The earlier results still reach the response.
  assert.ok(cronCode.includes("{ ...summary, deferredCancellations, subscriptionEmails },"));
  // Per family isolation inside the sweep too.
  assert.equal((retryCode.match(/} catch \(err\) \{/g) ?? []).length, 2,
    "each family's retry and stale inspection need their own guard");
});

test("52b: no provider error or PII reaches the cron response", () => {
  for (const line of retryCode.match(/console\.error\([^;]*\)/g) ?? []) {
    for (const forbidden of ["recipient", "customer", "snapshot", "subscription_id", "event_key"]) {
      assert.ok(!line.includes(forbidden), `a log line leaks ${forbidden}: ${line}`);
    }
  }
  // The summary returned to the cron carries counts and delivery uuids.
  assert.ok(retryCode.includes("export type SubscriptionEmailRetrySummary = {"));
  assert.ok(retryCode.includes("errored: boolean;"));
});

/* ══════════════════════════════════════════════════════════════
   55-62. DATABASE, FLAGS AND THIS SUITE
   ══════════════════════════════════════════════════════════════ */

test("55-57: no migration was added, edited or required", () => {
  const files = readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith(".sql")).sort();
    // PHASE 3I.B1 ADDED MIGRATION 036 (payment_problem family plus the
  // payment-status RPC). It is reviewed in
  // tests/subscription-payment-status-migration.test.mjs. What this
  // guard still protects is that no UNREVIEWED migration appeared.
  // PHASE 3J.B1 THEN ADDED 037 (the invoice-keyed refund-state writer),
  // reviewed in tests/subscription-refund-correlation-migration.test.mjs.
  assert.equal(files.length, 39);
  // Phase 4B1 added 039, the B2C prepaid annual plan foundation,
  // reviewed in tests/annual-plan-foundation-migration.test.mjs. The
  // guard is re-pinned, not deleted: it protects "no UNREVIEWED
  // migration appeared", never "the stack stopped growing".
  assert.equal(files[files.length - 1], "039_b2c_annual_plan_foundation.sql");
  assert.equal(files[files.length - 2], "038_one_time_refund_writer_concurrency.sql");
  assert.equal(files[files.length - 3], "037_subscription_refund_correlation.sql");
  assert.equal(files[files.length - 4], "036_subscription_payment_status.sql");
  assert.equal(files[files.length - 5], "035_subscription_email_deliveries.sql");
  assert.deepEqual(files.filter(f => f.startsWith("037")), ["037_subscription_refund_correlation.sql"]);
  assert.ok(!files.some(f => f.startsWith("040")));
  const sql035 = withoutComments(read("supabase/migrations/035_subscription_email_deliveries.sql"));
  // The sweep needs exactly what 035 already grants: SELECT, and UPDATE
  // on status and sent_at.
  assert.ok(sql035.includes("grant select on public.subscription_email_deliveries to service_role;"));
  assert.ok(sql035.includes("grant update (status, sent_at)"));
  assert.ok(!/grant[^;]*delete/i.test(sql035), "no DELETE was granted");
  // And the partial index the failed query relies on still exists.
  assert.ok(sql035.includes("where status = 'failed'"));
  assert.ok(sql035.includes("where status = 'sending'"));
});

test("58, 59: the retry stays out of billing, and refunds are untouched", () => {
  // PHASE 3I.B2 ADDED payment_problem as the fourth family. What still
  // holds is that the SWEEP does no billing work of its own: it never
  // writes a subscription status and never reconciles Stripe.
  for (const forbidden of [
    "sync_subscription_payment_status", "reconcileSubscriptionPaymentStatus",
    "invoice.payment_failed", "past_due", "unpaid",
  ]) {
    assert.ok(!retryCode.includes(forbidden), `the sweep does billing work: ${forbidden}`);
  }
  const refunds = withoutComments(read("lib/orderRefunds.ts"));
  assert.ok(!refunds.includes("subscription_email_deliveries"));
  assert.ok(!refunds.includes("subscriptionEmailRetry"));
});

test("60: B2C_SUBSCRIPTIONS_ENABLED is still closed unless exactly 'true'", () => {
  const checkoutRules = read("lib/subscriptionCheckoutRules.ts");
  assert.ok(checkoutRules.includes('export const SUBSCRIPTION_FEATURE_FLAG = "B2C_SUBSCRIPTIONS_ENABLED"'));
  assert.ok(checkoutRules.includes('env[SUBSCRIPTION_FEATURE_FLAG] === "true"'));
  assert.ok(!retryCode.includes("B2C_SUBSCRIPTIONS_ENABLED"));
});

test("61: SHOP_STATUS is still prelaunch", () => {
  assert.ok(read("app/content.ts").includes('export const SHOP_STATUS = "prelaunch"'));
});

test("62: this suite reaches no network, database or provider", () => {
  // The rules module driving every behavioural test above is a pure leaf.
  for (const forbidden of ["supabase", "fetch(", "process.env", "resend"]) {
    assert.ok(!rulesCode.includes(forbidden), `the rules leaf reaches ${forbidden}`);
  }
  assert.ok(!/from "\.\//.test(rulesCode), "the rules module has a relative import");

  const self = readFileSync(fileURLToPath(import.meta.url), "utf-8");
  const specifiers = self
    .split(NEWLINE)
    .map(line => /^(?:import .*|\}) from "([^"]+)";$/.exec(line))
    .filter(Boolean)
    .map(m => m[1])
    .sort();
  assert.deepEqual([...new Set(specifiers)], [
    "../lib/subscriptionEmailDeliveryRules.ts",
    "node:assert/strict",
    "node:fs",
    "node:path",
    "node:test",
    "node:url",
  ], "this suite imports something that can reach a database or a network");
});
