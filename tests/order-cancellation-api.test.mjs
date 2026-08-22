import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeBlockedServerEnv } from "./helpers/testSupabase.mjs";

// SAFE DEFAULT SUITE: the spawned server is started without a Supabase
// service-role key, so every write path degrades to its "admin client
// not configured" branch and no row can be written. These tests exercise
// the request-shape and authorization guards, which all run before the
// route ever reaches the database.

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const PORT = 8924;
const BASE = `http://127.0.0.1:${PORT}`;
const ENDPOINT = `${BASE}/api/orders/cancellation-request`;

let serverProcess;

async function waitForReady() {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const res = await fetch(`${BASE}/`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await delay(200);
  }
  throw new Error("server did not become ready in time");
}

test.before(async () => {
  serverProcess = spawn(process.execPath, [".output/server/index.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: writeBlockedServerEnv({ PORT: String(PORT) }),
    stdio: "ignore",
  });
  await waitForReady();
});

test.after(() => {
  serverProcess?.kill();
});

const REAL_LOOKING_ORDER_ID = "6b1f0a3c-6f4e-4a1e-9a1a-2f8a2b6c1d3e";

async function post(body, headers = {}) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const parsed = await res.json().catch(() => null);
  return { status: res.status, body: parsed };
}

/* ── Authorization ──────────────────────────────────────────── */

test("cancellation: an unauthenticated request is rejected", async () => {
  const { status, body } = await post({ orderId: REAL_LOOKING_ORDER_ID });
  assert.equal(status, 401);
  assert.equal(body.ok, undefined);
});

test("cancellation: a malformed bearer token is rejected", async () => {
  for (const authorization of ["Bearer", "Bearer   ", "Basic abc", "Bearer not-a-real-token"]) {
    const { status } = await post({ orderId: REAL_LOOKING_ORDER_ID }, { Authorization: authorization });
    assert.equal(status, 401, authorization);
  }
});

test("cancellation: authentication is checked before the order id is even looked at", async () => {
  // An unauthenticated caller must learn nothing about any order id -
  // a valid-looking id and a nonsense id answer identically.
  const withValidId = await post({ orderId: REAL_LOOKING_ORDER_ID });
  const withGarbageId = await post({ orderId: "not-a-uuid" });
  const withNoId = await post({});
  assert.equal(withValidId.status, 401);
  assert.equal(withGarbageId.status, 401);
  assert.equal(withNoId.status, 401);
  assert.deepEqual(withValidId.body, withGarbageId.body);
  assert.deepEqual(withValidId.body, withNoId.body);
});

/* ── Request shape ──────────────────────────────────────────── */

test("cancellation: a non-JSON content type is rejected", async () => {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: "orderId=x",
  });
  assert.equal(res.status, 400);
});

test("cancellation: malformed JSON is rejected", async () => {
  const { status } = await post("{not json");
  assert.equal(status, 400);
});

test("cancellation: an oversized body is rejected before parsing", async () => {
  const { status } = await post(JSON.stringify({ orderId: REAL_LOOKING_ORDER_ID, note: "x".repeat(25_000) }));
  assert.equal(status, 413);
});

test("cancellation: GET is not a way in", async () => {
  const res = await fetch(ENDPOINT, { method: "GET" });
  assert.ok(res.status === 404 || res.status === 405, `unexpected status ${res.status}`);
});

/* ── Never claims a cancellation ────────────────────────────── */

test("cancellation: no response ever says the order is cancelled", async () => {
  const responses = [
    await post({ orderId: REAL_LOOKING_ORDER_ID }),
    await post({ orderId: "not-a-uuid" }),
    await post({}),
  ];
  for (const { body } of responses) {
    const rendered = JSON.stringify(body ?? {});
    assert.ok(!/storniert/i.test(rendered), `claimed a cancellation: ${rendered}`);
    assert.ok(!/cancelled/i.test(rendered), `claimed a cancellation: ${rendered}`);
  }
});

test("cancellation: errors are customer copy, never a raw Supabase or Stripe message", async () => {
  const { body } = await post({ orderId: REAL_LOOKING_ORDER_ID });
  const rendered = JSON.stringify(body ?? {});
  for (const leak of ["supabase", "postgres", "PGRST", "stripe", "at Object.", "Error:", "service_role"]) {
    assert.ok(!rendered.toLowerCase().includes(leak.toLowerCase()), `leaked: ${leak}`);
  }
});

/* ── Structural separation from the legal withdrawal flow ───── */

test("cancellation: the route never touches the withdrawal flow", () => {
  // § 356a withdrawal declarations must keep going exclusively through
  // /widerruf and /api/withdrawal. A cancellation request is an
  // operational courtesy and must never be routed into that table.
  const source = readFileSync(path.join(ROOT, "app/api/orders/cancellation-request/route.ts"), "utf-8");
  // Prose explaining that the two flows are separate is fine; actually
  // naming the table or the route in code is not.
  const code = source
    .split("\n")
    .filter(line => {
      const trimmed = line.trim();
      return !trimmed.startsWith("*") && !trimmed.startsWith("//") && !trimmed.startsWith("/*");
    })
    .join("\n");
  assert.ok(!code.includes("withdrawal_requests"), "cancellation route must not touch withdrawal_requests");
  assert.ok(!code.includes("/api/withdrawal"), "cancellation route must not call the withdrawal API");
});

test("cancellation: the withdrawal route is unchanged by this feature", () => {
  const source = readFileSync(path.join(ROOT, "app/api/withdrawal/route.ts"), "utf-8");
  // Still its own independent insert into its own table.
  assert.ok(source.includes('.from("withdrawal_requests")'));
  assert.ok(source.includes(".insert({"));
  // And still knows nothing about cancellation requests or refunds.
  assert.ok(!source.includes("cancellation_requested_at"));
  assert.ok(!source.includes("request_order_cancellation"));
  assert.ok(!source.includes("apply_order_refund_state"));
});

test("cancellation: the database function is the ownership authority", () => {
  const migration = readFileSync(path.join(ROOT, "supabase/migrations/019_order_lifecycle_tracking.sql"), "utf-8");
  // Ownership is enforced in SQL against the verified user id, and a
  // foreign order is indistinguishable from a missing one.
  assert.ok(migration.includes("and user_id = p_user_id"));
  assert.ok(migration.includes("'not_found'"));
  // service_role never gets a blanket UPDATE on orders.
  assert.ok(!/grant\s+update\s+on\s+public\.orders/i.test(migration));
  assert.ok(migration.includes("grant execute on function public.request_order_cancellation"));
});
