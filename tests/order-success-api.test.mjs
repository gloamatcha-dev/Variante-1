import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const PORT = 8920;
const BASE_URL = `http://127.0.0.1:${PORT}`;

let serverProcess;

test.before(async () => {
  // STRIPE_SECRET_KEY / SUPABASE_SECRET_KEY are intentionally NOT set here,
  // so these tests verify request-validation happens before any config-
  // dependent work, and that missing config still fails gracefully (503)
  // rather than crashing.
  serverProcess = spawn(process.execPath, [".output/server/index.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, PORT: String(PORT) },
    stdio: "ignore",
  });

  const ready = new Promise((resolveReady, rejectReady) => {
    serverProcess.once("exit", (code) => rejectReady(new Error(`server exited early (code ${code})`)));
    (async () => {
      for (let attempt = 0; attempt < 50; attempt++) {
        try {
          const res = await fetch(`${BASE_URL}/`);
          if (res.ok) {
            resolveReady();
            return;
          }
        } catch {
          // server not up yet
        }
        await delay(200);
      }
      rejectReady(new Error("server did not become ready in time"));
    })();
  });

  await ready;
});

test.after(() => {
  serverProcess?.kill();
});

test("order success lookup: missing session_id is invalid", async () => {
  const res = await fetch(`${BASE_URL}/api/orders/success`);
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.equal(body.status, "invalid");
});

test("order success lookup: malformed session_id is invalid, never reaches Stripe", async () => {
  const res = await fetch(`${BASE_URL}/api/orders/success?session_id=not-a-real-session`);
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.equal(body.status, "invalid");
});

test("order success lookup: no order data is ever included on an invalid response", async () => {
  const res = await fetch(`${BASE_URL}/api/orders/success?session_id=not-a-real-session`);
  const body = await res.json();
  assert.equal(body.order, undefined);
});

test("order success lookup: well-formed session_id fails gracefully without STRIPE_SECRET_KEY", async () => {
  const res = await fetch(`${BASE_URL}/api/orders/success?session_id=cs_test_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`);
  const body = await res.json();
  assert.equal(res.status, 503);
  assert.equal(typeof body.error, "string");
});
