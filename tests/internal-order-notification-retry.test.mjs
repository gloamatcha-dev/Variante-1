import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeBlockedServerEnv } from "./helpers/testSupabase.mjs";
import {
  IN_FLIGHT_STATUS,
  RETRY_BATCH_LIMIT,
  RETRY_ELIGIBLE_STATUS,
  STALE_RECOVERY_BATCH_LIMIT,
  STALE_SENDING_AFTER_MS,
  buildRetryNotificationParams,
  isRetryEligibleStatus,
  isStaleSending,
  runInternalNotificationRetrySweep,
  runStaleSendingRecovery,
  staleSendingCutoff,
} from "../lib/internalOrderNotificationRetryRules.ts";
import {
  buildInternalOrderNotificationEmail,
  internalOrderNotificationIdempotencyKey,
} from "../lib/email/internalOrderNotification.ts";

// SAFE DEFAULT SUITE: the pure sweep logic driven through an in-memory
// port, source-level checks, and two spawned servers that are started
// WITHOUT a Supabase service-role key and WITHOUT a Resend key. No Resend
// client is ever constructed, no email of any kind is sent, no database
// is reachable and no production row can be read or written.
//
// The rule this suite protects: the retry may re-send the internal
// "new order, ship this" notification for an order that genuinely failed
// one, and it may do nothing else whatsoever. In particular it may never
// notice an order that existed before migration 026.

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf-8");
const NEWLINE = String.fromCharCode(10);

const MIGRATIONS = path.join(ROOT, "supabase/migrations");
const rules = read("lib/internalOrderNotificationRetryRules.ts");
const wiring = read("lib/internalOrderNotificationRetry.ts");
const route = read("app/api/cron/retry-order-notifications/route.ts");
const sender = read("lib/internalOrderNotificationEmail.ts");
const template = read("lib/email/internalOrderNotification.ts");
const vercelConfig = JSON.parse(read("vercel.json"));

const withoutComments = source => source
  .split(NEWLINE)
  .filter(line => {
    const t = line.trim();
    return !t.startsWith("--") && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
  })
  .join(NEWLINE);

const wiringCode = withoutComments(wiring);
const routeCode = withoutComments(route);
const senderCode = withoutComments(sender);

/* ── An in-memory stand-in for the two external systems ─────── */

const ITEM = {
  variantId: "11111111-1111-1111-1111-111111111111",
  sku: "GLOA-MATCHA-30G",
  productName: "GLOA Matcha",
  variantLabel: "30 g",
  sizeGrams: 30,
  quantity: 1,
  unitGrossCents: 1999,
  lineGrossCents: 1999,
  currency: "EUR",
};

const orderRow = (overrides = {}) => ({
  id: "order-1",
  order_number: "GLOA-2026-000123",
  currency: "EUR",
  subtotal_gross_cents: 1999,
  shipping_gross_cents: 590,
  total_gross_cents: 2589,
  shipping_address_snapshot: { name: "Test Kundin", line1: "Teststrasse 1", city: "Berlin", country: "DE" },
  customer_snapshot: { email: "kundin@example.test", name: "Test Kundin" },
  checkout_attempt_id: "attempt-1",
  internal_notification_status: "failed",
  ...overrides,
});

const attemptRow = (overrides = {}) => ({
  items_snapshot: [ITEM],
  subscription_id: null,
  stripe_invoice_id: null,
  ...overrides,
});

/**
 * A tiny model of the live state machine: the claim is the ONLY way to
 * take a row, and it succeeds only while the row still says 'failed' -
 * which is exactly what the conditional UPDATE in the wiring module gets
 * from Postgres row locking.
 */
function makePort(rows, options = {}) {
  const {
    attempts = new Map([["attempt-1", attemptRow()]]),
    deliver = async () => {},
    beforeClaim = () => {},
  } = options;

  const state = new Map(rows.map(row => [row.id, { ...row }]));
  const calls = { claimed: [], delivered: [], markedFailed: [], logged: [], sentAt: new Map() };

  const port = {
    loadFailedOrders: async () => rows.map(row => ({ ...row })),
    claim: async orderId => {
      beforeClaim(orderId, state);
      const row = state.get(orderId);
      if (row?.internal_notification_status !== RETRY_ELIGIBLE_STATUS) return "taken";
      row.internal_notification_status = "sending";
      calls.claimed.push(orderId);
      return "claimed";
    },
    loadAttempt: async id => attempts.get(id) ?? null,
    deliver: async params => {
      calls.delivered.push(params);
      try {
        await deliver(params);
      } catch (err) {
        // The live send path returns the row to 'failed' itself before
        // throwing; the model does the same so the state is honest.
        const row = state.get(params.order.id);
        if (row) row.internal_notification_status = "failed";
        throw err;
      }
      const row = state.get(params.order.id);
      if (row) {
        row.internal_notification_status = "sent";
        calls.sentAt.set(params.order.id, "2026-08-25T05:20:00.000Z");
      }
    },
    markFailed: async orderId => {
      calls.markedFailed.push(orderId);
      const row = state.get(orderId);
      // Never clobbers a success, exactly as the live mark cannot.
      if (row && row.internal_notification_status !== "sent") row.internal_notification_status = "failed";
    },
    logFailure: (orderId, message) => calls.logged.push([orderId, message]),
  };

  return { port, state, calls };
}

/* ── Eligibility ────────────────────────────────────────────── */

test("eligibility: only 'failed' is eligible, and the predicate says so alone", () => {
  assert.equal(RETRY_ELIGIBLE_STATUS, "failed");
  assert.equal(isRetryEligibleStatus("failed"), true);
  for (const status of [null, undefined, "", "sent", "sending", "pending", "FAILED", "failed "]) {
    assert.equal(isRetryEligibleStatus(status), false, `${String(status)} was treated as eligible`);
  }
});

test("eligibility: a failed order is retried", async () => {
  const { port, state, calls } = makePort([orderRow()]);
  const summary = await runInternalNotificationRetrySweep(port);

  assert.deepEqual(summary, { processed: 1, sent: 1, failed: 0, skipped: 0 });
  assert.deepEqual(calls.claimed, ["order-1"]);
  assert.equal(calls.delivered.length, 1);
  assert.equal(state.get("order-1").internal_notification_status, "sent");
});

test("eligibility: a historical NULL order is never selected, claimed or sent", async () => {
  // THE ONE THAT MATTERS. Every order written before migration 026 is
  // NULL. If this ever fails, a sweep emails the entire order history.
  const { port, state, calls } = makePort([
    orderRow({ id: "historical-1", internal_notification_status: null }),
    orderRow({ id: "historical-2", internal_notification_status: null }),
  ]);
  const summary = await runInternalNotificationRetrySweep(port);

  assert.deepEqual(summary, { processed: 2, sent: 0, failed: 0, skipped: 2 });
  assert.deepEqual(calls.claimed, [], "a historical order was claimed");
  assert.deepEqual(calls.delivered, [], "a historical order was emailed");
  assert.deepEqual(calls.markedFailed, [], "a historical order was given a state it never had");
  assert.equal(state.get("historical-1").internal_notification_status, null);
  assert.equal(state.get("historical-2").internal_notification_status, null);
});

test("eligibility: an already sent order is never sent again", async () => {
  const { port, state, calls } = makePort([orderRow({ internal_notification_status: "sent" })]);
  const summary = await runInternalNotificationRetrySweep(port);

  assert.deepEqual(summary, { processed: 1, sent: 0, failed: 0, skipped: 1 });
  assert.deepEqual(calls.delivered, []);
  assert.equal(state.get("order-1").internal_notification_status, "sent", "a sent state was overwritten");
});

test("eligibility: an in-flight 'sending' order belongs to whoever claimed it", async () => {
  const { port, state, calls } = makePort([orderRow({ internal_notification_status: "sending" })]);
  const summary = await runInternalNotificationRetrySweep(port);

  assert.deepEqual(summary, { processed: 1, sent: 0, failed: 0, skipped: 1 });
  assert.deepEqual(calls.claimed, []);
  assert.deepEqual(calls.delivered, []);
  assert.equal(state.get("order-1").internal_notification_status, "sending");
});

test("eligibility: a mixed batch retries the failed row and nothing else", async () => {
  const { port, calls } = makePort([
    orderRow({ id: "historical", internal_notification_status: null }),
    orderRow({ id: "done", internal_notification_status: "sent" }),
    orderRow({ id: "in-flight", internal_notification_status: "sending" }),
    orderRow({ id: "owed", internal_notification_status: "failed" }),
  ]);
  const summary = await runInternalNotificationRetrySweep(port);

  assert.deepEqual(summary, { processed: 4, sent: 1, failed: 0, skipped: 3 });
  assert.deepEqual(calls.delivered.map(p => p.order.id), ["owed"]);
});

/* ── Success and failure transitions ────────────────────────── */

test("transition: a successful retry ends at 'sent' with a sent timestamp", async () => {
  const { port, state, calls } = makePort([orderRow()]);
  await runInternalNotificationRetrySweep(port);

  assert.equal(state.get("order-1").internal_notification_status, "sent");
  assert.ok(calls.sentAt.has("order-1"), "no sent timestamp was written");
  // The live pair is written by one update in the shared send path.
  assert.match(senderCode, /internal_notification_status: "sent", internal_notification_sent_at: new Date\(\)\.toISOString\(\)/);
});

test("transition: a failed retry returns the row to 'failed', not to NULL", async () => {
  const { port, state, calls } = makePort([orderRow()], {
    deliver: async () => {
      throw new Error("resend refused");
    },
  });
  const summary = await runInternalNotificationRetrySweep(port);

  assert.deepEqual(summary, { processed: 1, sent: 0, failed: 1, skipped: 0 });
  assert.equal(state.get("order-1").internal_notification_status, "failed");
  assert.deepEqual(calls.markedFailed, ["order-1"]);
  // Eligible again tomorrow, and only because it is 'failed' - a row left
  // at 'sending' would be invisible to every future run.
  assert.equal(isRetryEligibleStatus(state.get("order-1").internal_notification_status), true);
});

test("transition: a row whose data cannot be rebuilt is returned to 'failed', never half-claimed", async () => {
  for (const [label, row, attempts] of [
    ["no checkout attempt", orderRow({ checkout_attempt_id: null }), new Map()],
    ["attempt row gone", orderRow(), new Map()],
    ["empty line snapshot", orderRow(), new Map([["attempt-1", attemptRow({ items_snapshot: [] })]])],
  ]) {
    const { port, state, calls } = makePort([row], { attempts });
    const summary = await runInternalNotificationRetrySweep(port);

    assert.deepEqual(summary, { processed: 1, sent: 0, failed: 1, skipped: 0 }, label);
    assert.deepEqual(calls.delivered, [], `${label}: an unrenderable order was still emailed`);
    assert.equal(state.get(row.id).internal_notification_status, "failed", `${label}: left stuck in 'sending'`);
  }
});

test("transition: the failure log carries the order id and no customer fact", async () => {
  const { port, calls } = makePort([orderRow()], {
    deliver: async () => {
      throw new Error("resend refused");
    },
  });
  await runInternalNotificationRetrySweep(port);

  assert.equal(calls.logged.length, 1);
  const [orderId, message] = calls.logged[0];
  assert.equal(orderId, "order-1");
  for (const fact of ["kundin@example.test", "Test Kundin", "Teststrasse 1", "Berlin", "GLOA-2026-000123"]) {
    assert.ok(!message.includes(fact), `the failure log leaks ${fact}`);
  }
});

/* ── Concurrency with the Stripe webhook ────────────────────── */

test("concurrency: a Stripe redelivery that wins the claim leaves nothing to send", async () => {
  // The cron selected this row while it still said 'failed'. Between the
  // select and the claim, a Stripe redelivery takes it.
  const { port, calls } = makePort([orderRow()], {
    beforeClaim: (orderId, state) => {
      state.get(orderId).internal_notification_status = "sending";
    },
  });
  const summary = await runInternalNotificationRetrySweep(port);

  assert.deepEqual(summary, { processed: 1, sent: 0, failed: 0, skipped: 1 });
  assert.deepEqual(calls.delivered, [], "both workers sent the same notification");
});

test("concurrency: a notification the webhook already delivered is never duplicated", async () => {
  const { port, state, calls } = makePort([orderRow()], {
    beforeClaim: (orderId, s) => {
      s.get(orderId).internal_notification_status = "sent";
    },
  });
  const summary = await runInternalNotificationRetrySweep(port);

  assert.deepEqual(summary, { processed: 1, sent: 0, failed: 0, skipped: 1 });
  assert.deepEqual(calls.delivered, []);
  assert.equal(state.get("order-1").internal_notification_status, "sent");
});

test("concurrency: two sweeps racing the same row produce exactly one send", async () => {
  const rows = [orderRow()];
  const shared = makePort(rows);
  // A second worker over the SAME state, so the model's claim is the only
  // thing standing between them - as it is in production.
  const rival = {
    ...shared.port,
    loadFailedOrders: async () => rows.map(row => ({ ...row })),
  };

  const [a, b] = await Promise.all([
    runInternalNotificationRetrySweep(shared.port),
    runInternalNotificationRetrySweep(rival),
  ]);

  assert.equal(a.sent + b.sent, 1, "the notification was sent twice");
  assert.equal(a.skipped + b.skipped, 1);
  assert.equal(shared.calls.delivered.length, 1);
  assert.deepEqual(shared.calls.claimed, ["order-1"]);
});

/* ── The batch survives one bad record ──────────────────────── */

test("batch: one bad mail does not stop the rest of the bounded batch", async () => {
  const rows = [
    orderRow({ id: "a" }),
    orderRow({ id: "poison" }),
    orderRow({ id: "b" }),
    orderRow({ id: "c" }),
  ];
  const { port, state, calls } = makePort(rows, {
    deliver: async params => {
      if (params.order.id === "poison") throw new Error("resend refused");
    },
  });

  const summary = await runInternalNotificationRetrySweep(port);

  assert.deepEqual(summary, { processed: 4, sent: 3, failed: 1, skipped: 0 });
  assert.deepEqual(calls.delivered.map(p => p.order.id), ["a", "poison", "b", "c"]);
  assert.equal(state.get("poison").internal_notification_status, "failed");
  for (const id of ["a", "b", "c"]) {
    assert.equal(state.get(id).internal_notification_status, "sent", `${id} was skipped by a bad neighbour`);
  }
});

test("batch: a row that cannot be rebuilt does not stop the rest either", async () => {
  const rows = [orderRow({ id: "a" }), orderRow({ id: "orphan", checkout_attempt_id: null }), orderRow({ id: "b" })];
  const { port, state } = makePort(rows);

  const summary = await runInternalNotificationRetrySweep(port);

  assert.deepEqual(summary, { processed: 3, sent: 2, failed: 1, skipped: 0 });
  assert.equal(state.get("a").internal_notification_status, "sent");
  assert.equal(state.get("b").internal_notification_status, "sent");
  assert.equal(state.get("orphan").internal_notification_status, "failed");
});

test("batch: the run is bounded and the bound is small", () => {
  assert.equal(typeof RETRY_BATCH_LIMIT, "number");
  assert.ok(RETRY_BATCH_LIMIT > 0 && RETRY_BATCH_LIMIT <= 50, "the batch bound is not a bound");
  // The bound is applied in SQL, so an outage cannot hand the loop an
  // unbounded work list in the first place.
  assert.match(wiringCode, /\.limit\(limit\)/);
  assert.match(wiringCode, /limit: number = RETRY_BATCH_LIMIT/);
});

/* ── What the retry rebuilds, and what it cannot ────────────── */

test("payload: the notification is rebuilt from persisted data only", () => {
  const params = buildRetryNotificationParams(orderRow(), attemptRow());

  assert.equal(params.order.order_number, "GLOA-2026-000123");
  assert.equal(params.order.total_gross_cents, 2589);
  assert.deepEqual(params.items, [{
    productName: "GLOA Matcha",
    variantLabel: "30 g",
    quantity: 1,
    unitGrossCents: 1999,
    lineGrossCents: 1999,
    sku: "GLOA-MATCHA-30G",
  }]);
  assert.equal(params.customerEmail, "kundin@example.test");
  assert.equal(params.customerName, "Test Kundin");
});

test("payload: the source is derived from the attempt, never guessed", () => {
  const oneTime = buildRetryNotificationParams(orderRow(), attemptRow());
  assert.equal(oneTime.source, "one_time");
  // A one-off order has no invoice to give, even if a stray id sat there.
  assert.equal(buildRetryNotificationParams(orderRow(), attemptRow({ stripe_invoice_id: "in_stray" })).stripeInvoiceId, null);

  const subscription = buildRetryNotificationParams(
    orderRow(),
    attemptRow({ subscription_id: "sub-1", stripe_invoice_id: "in_123" })
  );
  assert.equal(subscription.source, "subscription");
  assert.equal(subscription.stripeInvoiceId, "in_123");
});

test("payload: a missing customer snapshot degrades to null, never to a guess", () => {
  for (const snapshot of [null, {}, { email: 42, name: [] }]) {
    const params = buildRetryNotificationParams(orderRow({ customer_snapshot: snapshot }), attemptRow());
    assert.equal(params.customerEmail, null);
    assert.equal(params.customerName, null);
  }
});

test("payload: there is no recipient field to override", () => {
  const params = buildRetryNotificationParams(orderRow(), attemptRow());
  for (const key of ["to", "recipient", "from", "replyTo", "cc", "bcc"]) {
    assert.ok(!(key in params), `the retry payload carries a ${key} field`);
  }
  // The recipient is a compile-time constant in the shared send path, and
  // the retry reuses that path rather than passing an address to it.
  assert.match(senderCode, /to: GLOA_INTERNAL_ORDERS/);
  assert.match(wiringCode, /deliver: deliverClaimedInternalOrderNotification/);
  assert.ok(!/GLOA_INTERNAL_ORDERS|@gloamatcha|to:/.test(wiringCode + routeCode), "the retry path names its own recipient");
});

/* ── The rules module is a pure leaf ────────────────────────── */

test("rules: the decision logic imports nothing and reads no environment", () => {
  const code = withoutComments(rules);
  assert.deepEqual(code.split(NEWLINE).filter(l => l.trim().startsWith("import ")), []);
  for (const forbidden of ["process.env", "import.meta.env", "SUPABASE", "RESEND", "fetch(", "createClient"]) {
    assert.ok(!code.includes(forbidden), `the rules module reaches for ${forbidden}`);
  }
});

/* ── The SQL the wiring actually issues ─────────────────────── */

test("sql: the work list filters on 'failed' and nothing else", () => {
  assert.match(wiringCode, /\.eq\("internal_notification_status", RETRY_ELIGIBLE_STATUS\)/);
  // An equality filter cannot match NULL, which is what keeps every
  // pre-026 order out of the work list by construction.
  assert.ok(!/is\.null|isNull|\.or\(/.test(wiringCode), "the retry query can reach a NULL row");
  assert.ok(!/"pending"/.test(wiringCode), "a state migration 026 does not have appeared");
  // Least-recently-attempted first, so a full batch cannot starve the tail.
  assert.match(wiringCode, /\.order\("updated_at", \{ ascending: true \}\)/);
});

test("sql: the claim is one conditional UPDATE that only 'failed' can win", () => {
  const claim = wiringCode.slice(wiringCode.indexOf("async function claimFailedNotification"));
  assert.match(claim, /\.update\(\{ internal_notification_status: "sending" \}\)/);
  assert.match(claim, /\.eq\("id", orderId\)/);
  assert.match(claim, /\.eq\("internal_notification_status", RETRY_ELIGIBLE_STATUS\)/);
  assert.match(claim, /\.select\("id"\)/);
  assert.match(claim, /\(data\?\.length \?\? 0\) > 0 \? "claimed" : "taken"/);
});

test("sql: the sweep writes notification state and nothing else", () => {
  // Exactly two writes exist in this file: the claim (failed -> sending)
  // and the stale recovery (sending -> failed). Neither sends anything
  // and neither touches a column outside the notification state.
  const updates = [...wiringCode.matchAll(/\.update\(\{([^}]*)\}\)/g)].map(m => m[1]);
  assert.equal(updates.length, 2, "the retry issues a write it did not have");
  assert.match(updates[0], /internal_notification_status: "sending"/);
  assert.match(updates[1], /internal_notification_status: RETRY_ELIGIBLE_STATUS/);
  for (const payload of updates) {
    assert.match(payload, /internal_notification_status/);
    for (const forbidden of ["payment_status", "total_", "placed_at", "fulfillment_status", "confirmation_email"]) {
      assert.ok(!payload.includes(forbidden), `the retry writes ${forbidden}`);
    }
  }
  assert.ok(!/\.insert\(|\.delete\(|\.upsert\(|\.rpc\(/.test(wiringCode), "the retry creates, removes or invokes something");
});

test("scope: the retry touches no other feature", () => {
  const all = wiringCode + routeCode + withoutComments(rules);
  // Reading a subscription id or an invoice id off the frozen attempt is
  // how the source label is derived; these are the ACTIONS that must be
  // out of reach.
  for (const forbidden of [
    "sendOrderConfirmationEmailIfNeeded",
    "orderConfirmationEmail",
    "confirmation_email",
    "createOrderFromPaidCheckoutAttempt",
    "create_order_from_paid_checkout",
    "activate_subscription_from_invoice",
    "getStripeClient",
    "stripe.",
    "tax_snapshot",
    "shipping_address_collection",
    "B2C_SUBSCRIPTIONS_ENABLED",
  ]) {
    assert.ok(!all.includes(forbidden), `the retry path reaches into ${forbidden}`);
  }
});

/* ── The endpoint ───────────────────────────────────────────── */

test("endpoint: it fails closed when CRON_SECRET is missing", () => {
  assert.match(routeCode, /const secret = process\.env\.CRON_SECRET;/);
  const handler = routeCode.slice(routeCode.indexOf("export async function GET"));
  const guard = handler.indexOf("if (!secret)");
  assert.ok(guard > 0, "a missing secret is not checked at all");
  assert.ok(guard < handler.indexOf("isBearerSecretAuthorized("), "the secret is used before it is checked");
  assert.ok(guard < handler.indexOf("getSupabaseAdmin("), "the database is reached before the check");
  assert.ok(guard < handler.indexOf("runInternalOrderNotificationCron("), "work happens before the check");
  assert.match(handler, /return Response\.json\(\{ error: "[^"]+" \}, \{ status: 503 \}\);/);
});

test("endpoint: the comparison is timing safe and the secret never reaches a log", () => {
  // The comparison this endpoint used to carry privately now lives in
  // lib/serverSecretAuth.ts, unchanged, because the authorized shipment
  // endpoint (Phase 2B) needed the same check and two private copies of a
  // security primitive are how the two drift apart. The property is
  // asserted where the code now is, plus that this route uses it.
  assert.match(routeCode, /isBearerSecretAuthorized\(request, secret\)/);
  const helper = readFileSync(path.join(ROOT, "lib/serverSecretAuth.ts"), "utf-8");
  assert.match(helper, /timingSafeEqual/);
  assert.match(helper, /createHash\("sha256"\)/);
  // Equal-length digests, so timingSafeEqual cannot throw on a length
  // mismatch and a length difference is not observable by itself.
  assert.match(helper, /timingSafeEqual\(digest\(header\), digest\(`Bearer \$\{secret\}`\)\)/);
  assert.ok(!/===\s*secret|secret\s*===|!==\s*secret/.test(helper), "a plain string comparison survived");

  // The secret still reaches no log line here, and the route no longer
  // interpolates it anywhere at all.
  const logs = [...routeCode.matchAll(/console\.error\(([\s\S]*?)\);/g)].map(m => m[1]);
  assert.ok(logs.length > 0);
  for (const line of logs) {
    assert.deepEqual([...line.matchAll(/\$\{([^}]*)\}/g)].map(m => m[1]), [], `a log line interpolates a value: ${line}`);
    for (const leak of ["authorization", "header", "process.env"]) {
      assert.ok(!line.includes(leak), `a log line carries ${leak}`);
    }
  }
  assert.deepEqual([...routeCode.matchAll(/\$\{([^}]*)\}/g)].map(m => m[1]), [], "the route interpolates a value");
  // And the shipment endpoint's secret is a different one entirely.
  assert.ok(!routeCode.includes("FULFILLMENT_ADMIN_SECRET"), "the cron reuses the fulfillment secret");
});

test("endpoint: it is server-only and takes no input from the caller", () => {
  // No browser-supplied order id, no recipient, no batch size, no filter.
  for (const forbidden of ["searchParams", "new URL(", "request.json()", "request.text()", "orderId", "email"]) {
    assert.ok(!routeCode.includes(forbidden), `the endpoint reads ${forbidden} from the request`);
  }
  // The only header read is the one it authenticates with. That read
  // now happens inside lib/serverSecretAuth.ts, so the route itself reads
  // no header at all and the helper reads exactly one.
  assert.deepEqual([...routeCode.matchAll(/headers\.get\("([^"]+)"\)/g)].map(m => m[1]), []);
  const helper = readFileSync(path.join(ROOT, "lib/serverSecretAuth.ts"), "utf-8");
  assert.deepEqual([...helper.matchAll(/headers\.get\("([^"]+)"\)/g)].map(m => m[1]), ["authorization"]);
  // Service role stays on the server: the route is an API route, and the
  // key is only ever read through the server-only admin module.
  assert.match(routeCode, /getSupabaseAdmin/);
  assert.ok(!/VITE_/.test(routeCode), "a client-visible variable reached the endpoint");
  // GET, because that is what Vercel Cron issues - and nothing else.
  const handlers = [...routeCode.matchAll(/export async function ([A-Z]+)\(/g)].map(m => m[1]);
  assert.deepEqual(handlers, ["GET"]);
});

test("endpoint: it answers with counts and no customer data", () => {
  assert.match(routeCode, /Response\.json\(summary, \{ status: 200 \}\)/);
  // The summary type is closed: four counts.
  assert.match(rules, /export type InternalNotificationRetrySummary = \{/);
  const summaryBlock = rules.slice(
    rules.indexOf("export type InternalNotificationRetrySummary = {"),
    rules.indexOf("};", rules.indexOf("export type InternalNotificationRetrySummary = {"))
  );
  const fields = [...summaryBlock.matchAll(/^\s*(\w+): number;/gm)].map(m => m[1]);
  assert.deepEqual(fields, ["processed", "sent", "failed", "skipped"]);
  for (const leak of ["orderNumber", "order_number", "email", "name", "address", "orderId", "ids"]) {
    assert.ok(!summaryBlock.includes(leak), `the response carries ${leak}`);
  }

  // What the endpoint actually returns is the merged summary: the two
  // recovery counts plus the four sweep counts, and nothing else.
  assert.match(rules, /export type CronSweepSummary = StaleRecoverySummary & InternalNotificationRetrySummary;/);
  const staleBlock = rules.slice(
    rules.indexOf("export type StaleRecoverySummary = {"),
    rules.indexOf("};", rules.indexOf("export type StaleRecoverySummary = {"))
  );
  assert.deepEqual([...staleBlock.matchAll(/^\s*(\w+): number;/gm)].map(m => m[1]), ["staleFound", "staleRecovered"]);
  for (const leak of ["orderNumber", "order_number", "email", "name", "address", "orderId", "ids"]) {
    assert.ok(!staleBlock.includes(leak), `the recovery response carries ${leak}`);
  }
});

/* ── The schedule ───────────────────────────────────────────── */

test("schedule: exactly one daily cron, as Vercel Hobby allows", () => {
  assert.equal(vercelConfig.crons.length, 1);
  const [cron] = vercelConfig.crons;
  assert.equal(cron.path, "/api/cron/retry-order-notifications");

  const fields = cron.schedule.split(" ");
  assert.equal(fields.length, 5, "not a five-field cron expression");
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  // Hobby permits one invocation per day: a fixed minute and a fixed
  // hour, every day. Any step or list in the first two fields would be a
  // schedule the plan rejects.
  assert.match(minute, /^\d{1,2}$/, "the minute field is not a single fixed value");
  assert.match(hour, /^\d{1,2}$/, "the hour field is not a single fixed value");
  assert.deepEqual([dayOfMonth, month, dayOfWeek], ["*", "*", "*"], "the job does not run every day");
});

/* ── No migration was needed ────────────────────────────────── */

test("migrations: the retry still adds none, and 022-026 are untouched", () => {
  const files = readdirSync(MIGRATIONS).filter(n => n.endsWith(".sql")).sort();
  // The live, immutable ones are still exactly the files they were.
  // Matched by name rather than by position, so a later migration for an
  // unrelated feature cannot make this assertion fail for no reason.
  for (const name of [
    "022_recurring_subscription_foundation.sql",
    "023_harden_stripe_customers_grants.sql",
    "024_seed_b2c_subscription_plans.sql",
    "025_grant_subscription_plans_service_role.sql",
    "026_internal_order_notification_state.sql",
    "027_shipment_confirmation_email_state.sql",
    "028_authorized_shipment_transition.sql",
  ]) {
    assert.ok(files.includes(name), `${name} is missing`);
  }
  // 027 and 028 both belong to the SHIPMENT work, not to this retry. The
  // rule this assertion protects is unchanged: the internal notification
  // retry needs no migration of its own, and it must not acquire one by
  // borrowing someone else's.
  assert.equal(files[files.length - 1], "028_authorized_shipment_transition.sql");
  assert.equal(files.filter(n => /^029|^0[3-9]\d/.test(n)).length, 0, "the retry added a migration");
  // Against their SQL only: 027's verification notes deliberately SELECT
  // 026's columns to prove they are unchanged, and reading them is the
  // opposite of reaching into them.
  for (const name of ["027_shipment_confirmation_email_state.sql", "028_authorized_shipment_transition.sql"]) {
    const shipment = withoutComments(read(`supabase/migrations/${name}`));
    assert.ok(!shipment.includes("internal_notification"), `${name} writes the internal notification state`);
  }
  // The retry needs no column 026 did not already provide.
  const sql = read("supabase/migrations/026_internal_order_notification_state.sql");
  assert.match(sql, /check \(internal_notification_status in \('sending', 'sent', 'failed'\)\)/);
  assert.match(sql, /grant update \(internal_notification_status, internal_notification_sent_at\)/);
});

/* ── Stale 'sending' recovery ───────────────────────────────── */

const NOW = Date.parse("2026-08-25T06:00:00.000Z");
const CUTOFF = staleSendingCutoff(NOW);
const minutesAgo = m => new Date(NOW - m * 60 * 1000).toISOString();

const staleRow = (overrides = {}) => ({
  id: "order-1",
  internal_notification_status: IN_FLIGHT_STATUS,
  updated_at: minutesAgo(90),
  ...overrides,
});

/**
 * A model of the live conditional recovery: the write re-checks BOTH the
 * status and the cutoff, so anything another worker did between the read
 * and the write makes it match nothing.
 */
function makeRecoveryPort(rows, options = {}) {
  const { failOn = new Set(), beforeRecover = () => {} } = options;
  const state = new Map(rows.map(row => [row.id, { ...row }]));
  const calls = { recovered: [], attempted: [], logged: [] };

  const port = {
    loadStaleSending: async cutoff =>
      rows
        .map(row => ({ ...row }))
        .filter(row => isStaleSending(row.internal_notification_status, row.updated_at, cutoff)),
    recover: async (orderId, cutoff) => {
      calls.attempted.push(orderId);
      if (failOn.has(orderId)) throw new Error("recovery write failed");
      beforeRecover(orderId, state);
      const row = state.get(orderId);
      if (!row || !isStaleSending(row.internal_notification_status, row.updated_at, cutoff)) return "skipped";
      row.internal_notification_status = RETRY_ELIGIBLE_STATUS;
      row.updated_at = new Date(NOW).toISOString();
      calls.recovered.push(orderId);
      return "recovered";
    },
    logFailure: (orderId, message) => calls.logged.push([orderId, message]),
  };

  return { port, state, calls };
}

test("stale: the threshold is a conservative server-side constant", () => {
  assert.equal(STALE_SENDING_AFTER_MS, 30 * 60 * 1000);
  // Comfortably beyond any legitimate in-flight attempt: one notification
  // lives inside a single serverless invocation, and the platform kills
  // that in minutes. No override exists in the repository.
  assert.ok(STALE_SENDING_AFTER_MS >= 15 * 60 * 1000, "the threshold is not conservative");
  assert.ok(!/maxDuration/.test(route), "a duration override appeared and the threshold was not revisited");
  assert.equal(staleSendingCutoff(NOW), new Date(NOW - STALE_SENDING_AFTER_MS).toISOString());
  // The cutoff is derived from a passed clock, never read inside the rules.
  assert.ok(!/new Date\(\)|Date\.now\(\)/.test(withoutComments(rules)), "the rules read the clock themselves");
});

test("stale: a recent sending row is not stale", () => {
  for (const minutes of [0, 1, 5, 29]) {
    assert.equal(
      isStaleSending(IN_FLIGHT_STATUS, minutesAgo(minutes), CUTOFF),
      false,
      `${minutes} minutes old was treated as abandoned`
    );
  }
});

test("stale: the boundary is deterministic and inclusive", () => {
  const exactly = new Date(NOW - STALE_SENDING_AFTER_MS).toISOString();
  assert.equal(isStaleSending(IN_FLIGHT_STATUS, exactly, CUTOFF), true, "exactly at the cutoff must be stale");
  const oneMsNewer = new Date(NOW - STALE_SENDING_AFTER_MS + 1).toISOString();
  assert.equal(isStaleSending(IN_FLIGHT_STATUS, oneMsNewer, CUTOFF), false, "one millisecond inside must not be stale");
  const oneMsOlder = new Date(NOW - STALE_SENDING_AFTER_MS - 1).toISOString();
  assert.equal(isStaleSending(IN_FLIGHT_STATUS, oneMsOlder, CUTOFF), true);
});

test("stale: an old sending row is stale", () => {
  for (const minutes of [31, 90, 60 * 24 * 7]) {
    assert.equal(isStaleSending(IN_FLIGHT_STATUS, minutesAgo(minutes), CUTOFF), true, `${minutes} minutes old`);
  }
});

test("stale: only 'sending' can ever be stale", () => {
  // A historical NULL row, a done row and an ordinary failed row are all
  // outside this mechanism entirely, however old they are.
  for (const status of [null, undefined, "sent", "failed", "pending", ""]) {
    assert.equal(
      isStaleSending(status, minutesAgo(60 * 24 * 365), CUTOFF),
      false,
      `${String(status)} was treated as an abandoned claim`
    );
  }
  // A missing or unparseable timestamp is never stale either.
  for (const updatedAt of [null, undefined, "", "not-a-date"]) {
    assert.equal(isStaleSending(IN_FLIGHT_STATUS, updatedAt, CUTOFF), false);
  }
});

test("stale: a stale row is atomically returned to 'failed'", async () => {
  const { port, state, calls } = makeRecoveryPort([staleRow()]);
  const summary = await runStaleSendingRecovery(port, CUTOFF);

  assert.deepEqual(summary, { staleFound: 1, staleRecovered: 1 });
  assert.deepEqual(calls.recovered, ["order-1"]);
  assert.equal(state.get("order-1").internal_notification_status, RETRY_ELIGIBLE_STATUS);
});

test("stale: a recovered row is exactly what the failed sweep is looking for", async () => {
  const { port, state } = makeRecoveryPort([staleRow()]);
  await runStaleSendingRecovery(port, CUTOFF);

  // The handover between the two halves of the cron, stated as one
  // assertion: recovery writes the one status the sweep can see.
  assert.equal(isRetryEligibleStatus(state.get("order-1").internal_notification_status), true);
});

test("stale: sent, failed and historical NULL rows are never recovered", async () => {
  const { port, state, calls } = makeRecoveryPort([
    staleRow({ id: "done", internal_notification_status: "sent" }),
    staleRow({ id: "owed", internal_notification_status: "failed" }),
    staleRow({ id: "historical", internal_notification_status: null }),
  ]);
  const summary = await runStaleSendingRecovery(port, CUTOFF);

  assert.deepEqual(summary, { staleFound: 0, staleRecovered: 0 });
  assert.deepEqual(calls.attempted, [], "a row outside the mechanism was written to");
  assert.equal(state.get("done").internal_notification_status, "sent");
  assert.equal(state.get("owed").internal_notification_status, "failed");
  assert.equal(state.get("historical").internal_notification_status, null);
});

test("stale: a fresh sending row is never recovered", async () => {
  const { port, state, calls } = makeRecoveryPort([staleRow({ updated_at: minutesAgo(2) })]);
  const summary = await runStaleSendingRecovery(port, CUTOFF);

  assert.deepEqual(summary, { staleFound: 0, staleRecovered: 0 });
  assert.deepEqual(calls.attempted, []);
  assert.equal(state.get("order-1").internal_notification_status, IN_FLIGHT_STATUS);
});

test("stale: recovery loses safely when the original worker finishes first", async () => {
  // It was not dead after all: it delivered and wrote 'sent' between the
  // read and the conditional write.
  const { port, state, calls } = makeRecoveryPort([staleRow()], {
    beforeRecover: (orderId, s) => {
      s.get(orderId).internal_notification_status = "sent";
    },
  });
  const summary = await runStaleSendingRecovery(port, CUTOFF);

  assert.deepEqual(summary, { staleFound: 1, staleRecovered: 0 });
  assert.deepEqual(calls.recovered, [], "a delivered notification was un-sent");
  assert.equal(state.get("order-1").internal_notification_status, "sent");
});

test("stale: recovery never overwrites a claim that has just been refreshed", async () => {
  // Another worker touched the row, so its updated_at is inside the
  // window again. The conditional write re-checks the cutoff, not just
  // the status, and therefore matches nothing.
  const { port, state, calls } = makeRecoveryPort([staleRow()], {
    beforeRecover: (orderId, s) => {
      s.get(orderId).updated_at = minutesAgo(1);
    },
  });
  const summary = await runStaleSendingRecovery(port, CUTOFF);

  assert.deepEqual(summary, { staleFound: 1, staleRecovered: 0 });
  assert.deepEqual(calls.recovered, []);
  assert.equal(state.get("order-1").internal_notification_status, IN_FLIGHT_STATUS);
});

test("stale: two recoveries racing the same row recover it once", async () => {
  const rows = [staleRow()];
  const shared = makeRecoveryPort(rows);
  const rival = { ...shared.port };

  const [a, b] = await Promise.all([
    runStaleSendingRecovery(shared.port, CUTOFF),
    runStaleSendingRecovery(rival, CUTOFF),
  ]);

  assert.equal(a.staleRecovered + b.staleRecovered, 1, "the row was recovered twice");
  assert.deepEqual(shared.calls.recovered, ["order-1"]);
});

test("stale: one unrecoverable row does not block the others", async () => {
  const { port, state, calls } = makeRecoveryPort(
    [staleRow({ id: "a" }), staleRow({ id: "poison" }), staleRow({ id: "b" })],
    { failOn: new Set(["poison"]) }
  );
  const summary = await runStaleSendingRecovery(port, CUTOFF);

  assert.deepEqual(summary, { staleFound: 3, staleRecovered: 2 });
  assert.equal(state.get("a").internal_notification_status, RETRY_ELIGIBLE_STATUS);
  assert.equal(state.get("b").internal_notification_status, RETRY_ELIGIBLE_STATUS);
  assert.equal(state.get("poison").internal_notification_status, IN_FLIGHT_STATUS);
  assert.equal(calls.logged.length, 1);
  assert.equal(calls.logged[0][0], "poison");
});

test("stale: a work-list failure is infrastructure and is not swallowed", async () => {
  const port = {
    loadStaleSending: async () => {
      throw new Error("stale notification lookup failed: connection reset");
    },
    recover: async () => assert.fail("nothing may be written when the work list could not be read"),
    logFailure: () => assert.fail("a query failure is not a row failure"),
  };
  await assert.rejects(() => runStaleSendingRecovery(port, CUTOFF), /stale notification lookup failed/);
});

test("stale: recovery sends nothing and knows nothing about email", () => {
  const recovery = rules.slice(rules.indexOf("export async function runStaleSendingRecovery"));
  for (const forbidden of ["deliver", "resend", "Resend", "subject", "html", "@gloamatcha"]) {
    assert.ok(!recovery.includes(forbidden), `the stale recovery reaches for ${forbidden}`);
  }
  // The port it is given has no delivery seam at all.
  const portBlock = rules.slice(
    rules.indexOf("export type StaleSendingRecoveryPort = {"),
    rules.indexOf("};", rules.indexOf("export type StaleSendingRecoveryPort = {"))
  );
  assert.ok(!/deliver|markFailed|send\(/.test(portBlock), "the recovery port can send");
});

test("stale: the recovery run is bounded", () => {
  assert.ok(STALE_RECOVERY_BATCH_LIMIT > 0 && STALE_RECOVERY_BATCH_LIMIT <= 50);
  assert.match(wiringCode, /\.limit\(limit\)/);
  assert.match(wiringCode, /limit: number = STALE_RECOVERY_BATCH_LIMIT/);
});

test("stale sql: the query and the write agree on both halves of the rule", () => {
  const list = wiringCode.slice(wiringCode.indexOf("async function loadStaleSending"));
  assert.match(list, /\.eq\("internal_notification_status", IN_FLIGHT_STATUS\)/);
  assert.match(list, /\.lte\("updated_at", cutoffIso\)/);

  const write = wiringCode.slice(wiringCode.indexOf("async function recoverStaleSending"));
  assert.match(write, /\.update\(\{ internal_notification_status: RETRY_ELIGIBLE_STATUS \}\)/);
  assert.match(write, /\.eq\("id", orderId\)/);
  // BOTH conditions re-checked at write time. Without the second one a
  // refreshed claim could be stolen from a worker that is still alive.
  assert.match(write, /\.eq\("internal_notification_status", IN_FLIGHT_STATUS\)/);
  assert.match(write, /\.lte\("updated_at", cutoffIso\)/);
  assert.match(write, /\.select\("id"\)/);
  assert.match(write, /\(data\?\.length \?\? 0\) > 0 \? "recovered" : "skipped"/);
  // created_at is the age of the order, not of the claim, and is never used.
  assert.ok(!/created_at/.test(wiringCode), "the recovery keys on the order's age");
});

test("cron: recovery runs first, then the unchanged failed sweep", () => {
  const cron = wiringCode.slice(wiringCode.indexOf("export async function runInternalOrderNotificationCron"));
  const recover = cron.indexOf("recoverStaleInternalNotifications(");
  const sweep = cron.indexOf("retryFailedInternalOrderNotifications(");
  assert.ok(recover > 0 && sweep > recover, "the sweep runs before the recovery it depends on");
  // One cron, not two. vercel.json still registers a single daily job.
  assert.equal(vercelConfig.crons.length, 1);
});

/* ── Provider-level duplicate suppression ───────────────────── */

const ORDER_ID = "3f4a6b2c-0000-4d1e-9a77-1c2b3d4e5f60";

test("idempotency: the key is deterministic for one order", () => {
  const first = internalOrderNotificationIdempotencyKey(ORDER_ID);
  assert.equal(first, `gloa/internal-order/${ORDER_ID}`);
  // Every attempt from every path derives it the same way, so the first
  // webhook delivery, a Stripe redelivery, the failed sweep and a retry
  // after a stale recovery all present the same key.
  for (let attempt = 0; attempt < 5; attempt++) {
    assert.equal(internalOrderNotificationIdempotencyKey(ORDER_ID), first);
  }
});

test("idempotency: different orders never share a key", () => {
  const other = "9c8b7a65-0000-4d1e-9a77-1c2b3d4e5f60";
  assert.notEqual(internalOrderNotificationIdempotencyKey(ORDER_ID), internalOrderNotificationIdempotencyKey(other));
  // And the internal notification is namespaced away from any other GLOA
  // message about the same order.
  assert.match(internalOrderNotificationIdempotencyKey(ORDER_ID), /^gloa\/internal-order\//);
});

test("idempotency: the key carries no customer data and no clock", () => {
  const key = internalOrderNotificationIdempotencyKey(ORDER_ID);
  for (const leak of ["@", "kundin", "Test Kundin", "Teststrasse", "Berlin", "GLOA-2026", "sk_", "re_", "whsec_", "pi_", "in_"]) {
    assert.ok(!key.includes(leak), `the idempotency key carries ${leak}`);
  }
  // No timestamp, no counter, no randomness: a key that changed per
  // attempt would suppress nothing at all.
  assert.ok(!/\d{4}-\d{2}-\d{2}|\d{13}/.test(key), "the key contains a timestamp");
  const templateCode = withoutComments(template);
  const builder = templateCode
    .slice(templateCode.indexOf("export function internalOrderNotificationIdempotencyKey"))
    .slice(0, 200);
  for (const forbidden of ["Date", "random", "attempt", "retry", "count"]) {
    assert.ok(!builder.includes(forbidden), `the key builder uses ${forbidden}`);
  }
  // Resend rejects an over-long key; this one is a prefix plus a uuid.
  assert.ok(key.length <= 256);
});

test("idempotency: the provider call actually receives the key", () => {
  // The seam that matters is the real send, not a test double.
  assert.match(senderCode, /const idempotencyKey = internalOrderNotificationIdempotencyKey\(order\.id\);/);
  const send = senderCode.slice(senderCode.indexOf("resend.emails.send"));
  assert.match(send, /to: GLOA_INTERNAL_ORDERS/);
  assert.ok(send.indexOf("{ idempotencyKey }") > 0, "the send does not pass the option");
  // It is derived from the durable order id and from nothing else.
  assert.ok(!/idempotencyKey = .*(customerEmail|customerName|Date|random)/.test(senderCode));
});

test("idempotency: the installed SDK supports the option", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.match(pkg.dependencies.resend, /6\./);
  const types = read("node_modules/resend/dist/index.d.mts");
  assert.match(types, /interface CreateEmailRequestOptions extends PostOptions, IdempotentRequest/);
  assert.match(types, /idempotencyKey\?: string;/);
  assert.match(types, /send\(payload: CreateEmailOptions, options\?: CreateEmailRequestOptions\)/);
});

test("idempotency: the payload for one order is stable across attempts", () => {
  // Same frozen row, same frozen attempt, twice - as the webhook and a
  // later retry both see it.
  const first = buildRetryNotificationParams(orderRow(), attemptRow());
  const second = buildRetryNotificationParams(orderRow(), attemptRow());
  assert.deepEqual(first, second);

  const render = params => buildInternalOrderNotificationEmail({
    order: {
      order_number: params.order.order_number,
      currency: params.order.currency,
      subtotal_gross_cents: params.order.subtotal_gross_cents,
      shipping_gross_cents: params.order.shipping_gross_cents,
      total_gross_cents: params.order.total_gross_cents,
      shippingAddress: null,
      customerEmail: params.customerEmail,
      customerName: params.customerName,
      source: params.source,
      stripeInvoiceId: params.stripeInvoiceId,
    },
    items: params.items,
  });
  assert.deepEqual(render(first), render(second), "the same order renders differently on a second attempt");

  // Nothing in the rendered message can vary between attempts.
  const templateCode = withoutComments(template);
  for (const forbidden of ["new Date(", "Date.now(", "Math.random(", "process.env"]) {
    assert.ok(!templateCode.includes(forbidden), `the template injects ${forbidden}`);
  }
});

test("idempotency: mark-failed can never resurrect a delivered notification", () => {
  // A worker that hung long enough to be recovered must not come round
  // and write 'failed' over a notification a later worker delivered.
  const markFailed = senderCode.slice(senderCode.indexOf("export async function markInternalNotificationFailed"));
  assert.match(markFailed, /\.update\(\{ internal_notification_status: "failed" \}\)/);
  assert.match(markFailed, /\.eq\("id", orderId\)/);
  assert.match(markFailed, /\.eq\("internal_notification_status", "sending"\)/);
});

/* ── The HTTP boundary, on real spawned servers ─────────────── */

const PATH = "/api/cron/retry-order-notifications";
const TEST_SECRET = "test-only-cron-secret-not-a-real-value";

/**
 * Every server below is started without SUPABASE_SECRET_KEY and without
 * RESEND_API_KEY, so even a request that authenticates cannot reach a
 * database or construct a Resend client. The rejection paths answer
 * before either is consulted anyway.
 */
function serverEnv(extra) {
  const env = writeBlockedServerEnv({ ...extra });
  delete env.RESEND_API_KEY;
  delete env.RESEND_CONTACT_FROM;
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

const get = (port, headers = {}) => fetch(`http://127.0.0.1:${port}${PATH}`, { method: "GET", headers });

const UNSET_PORT = 8936;
let unsetServer;

test.before(async () => {
  // CRON_SECRET deliberately unset, which is how the endpoint ships until
  // the owner creates the value in Vercel.
  unsetServer = await startServer(UNSET_PORT, { CRON_SECRET: "" });
});

test.after(() => {
  unsetServer?.kill();
});

test("http: an unconfigured CRON_SECRET refuses every caller", async () => {
  for (const headers of [
    {},
    { authorization: "Bearer " },
    { authorization: `Bearer ${TEST_SECRET}` },
    { authorization: "Bearer undefined" },
  ]) {
    const res = await get(UNSET_PORT, headers);
    assert.equal(res.status, 503, `${JSON.stringify(headers)} was not refused`);
    const body = await res.json();
    assert.ok(!/cron|secret|supabase|resend|env/i.test(JSON.stringify(body)), "the refusal leaks an internal detail");
  }
});

const SECURED_PORT = 8937;
let securedServer;

test.before(async () => {
  securedServer = await startServer(SECURED_PORT, { CRON_SECRET: TEST_SECRET });
});

test.after(() => {
  securedServer?.kill();
});

test("http: a caller without the secret is rejected", async () => {
  const res = await get(SECURED_PORT);
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.ok(!JSON.stringify(body).includes(TEST_SECRET), "the refusal echoes the secret");
});

test("http: a wrong secret is rejected, in every shape", async () => {
  for (const authorization of [
    "Bearer wrong",
    "Bearer ",
    `Bearer ${TEST_SECRET}x`,
    `Bearer ${TEST_SECRET.slice(0, -1)}`,
    TEST_SECRET,
    `Basic ${TEST_SECRET}`,
    `bearer ${TEST_SECRET}`,
  ]) {
    const res = await get(SECURED_PORT, { authorization });
    assert.equal(res.status, 401, `${authorization} was accepted`);
  }
});

test("http: the endpoint is not an arbitrary mail trigger", async () => {
  // No parameter can widen it, because it reads none: an unauthenticated
  // caller supplying an order id and a recipient is still refused.
  const res = await fetch(
    `http://127.0.0.1:${SECURED_PORT}${PATH}?orderId=00000000-0000-0000-0000-000000000000&to=attacker@example.test&limit=1000`
  );
  assert.equal(res.status, 401);
});

test("http: the correct secret is accepted and the sweep is still fail-closed without a database", async () => {
  // The positive control for the comparison: this request authenticates.
  // The server has no service-role key, so the sweep is refused rather
  // than run - nothing can be read, written or emailed by this test.
  const res = await get(SECURED_PORT, { authorization: `Bearer ${TEST_SECRET}` });
  assert.equal(res.status, 503, "the correct secret was not accepted");

  const body = await res.json();
  const serialized = JSON.stringify(body);
  assert.ok(!serialized.includes(TEST_SECRET), "the answer echoes the secret");
  for (const leak of ["@", "GLOA-", "supabase", "SUPABASE", "resend", "key"]) {
    assert.ok(!serialized.includes(leak), `the answer carries ${leak}`);
  }
});
