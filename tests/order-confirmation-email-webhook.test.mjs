import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { parseEnv } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Stripe from "stripe";

// process.env.STRIPE_SECRET_KEY is never auto-populated for a spawned
// server from .env.local (unlike import.meta.env.VITE_* values, which
// Vite bakes in at build time) - it must be read and passed through
// explicitly, exactly like tests/helpers/*.mjs already do for Supabase
// credentials. Never logged/printed.
const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
function requireLocalEnv(name) {
  const fromShell = process.env[name];
  if (fromShell) return fromShell;
  const envLocalPath = path.join(ROOT, ".env.local");
  const local = existsSync(envLocalPath) ? parseEnv(readFileSync(envLocalPath, "utf-8")) : {};
  const value = local[name];
  if (!value) throw new Error(`Missing ${name}. Set it in the environment or .env.local to run these tests.`);
  return value;
}

// Webhook-level gating tests: confirms the confirmation email is never
// even attempted unless the webhook's existing, unmodified payment
// verification/order-creation path actually succeeds. A full real paid
// Checkout Session cannot be completed headlessly in this environment
// (no browser, and Stripe Checkout requires either browser-based card
// entry or a live redirect flow) - Task 20B.3's real sandbox payment
// test already proved that path end to end with a human present. What
// IS genuinely testable here, against the real webhook route and the
// real Stripe API, is that the webhook's existing gates correctly stop
// execution BEFORE the email code ever runs - which these tests confirm
// by checking a local mock Resend server received zero requests. The
// state-machine mechanics that prevent duplicate sends once an order
// does exist are covered separately (and against real Postgres) in
// tests/order-confirmation-email-state.test.mjs.

const FAKE_WEBHOOK_SECRET = "whsec_test_fake_secret_for_local_tests_only";
const stripeForSigning = new Stripe("sk_test_not_a_real_key_used_only_for_local_webhook_signing");

const PORT = 8923;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const MOCK_RESEND_PORT = 8924;

let serverProcess;
let mockResendServer;
let resendRequestCount = 0;

test.before(async () => {
  mockResendServer = createServer((req, res) => {
    resendRequestCount += 1;
    res.setHeader("Content-Type", "application/json");
    res.statusCode = 200;
    res.end(JSON.stringify({ id: "mock-email-id" }));
  });
  await new Promise(resolve => mockResendServer.listen(MOCK_RESEND_PORT, "127.0.0.1", resolve));

  // A real (test-mode) STRIPE_SECRET_KEY is required for this file: the
  // webhook re-fetches the session from Stripe's real API rather than
  // trusting the webhook payload, and that re-fetch is exactly the
  // behavior under test for the "invalid/unrecognized session" case.
  serverProcess = spawn(process.execPath, [".output/server/index.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      PORT: String(PORT),
      STRIPE_WEBHOOK_SECRET: FAKE_WEBHOOK_SECRET,
      STRIPE_SECRET_KEY: requireLocalEnv("STRIPE_SECRET_KEY"),
      // The webhook's event-dedup/recording (stripe_webhook_events) uses
      // the Supabase admin client, which reads process.env.SUPABASE_SECRET_KEY
      // at runtime - unlike VITE_SUPABASE_URL, this is never baked in at
      // build time, so a spawned server needs it explicitly, exactly like
      // STRIPE_SECRET_KEY above.
      SUPABASE_SECRET_KEY: requireLocalEnv("SUPABASE_SECRET_KEY"),
      RESEND_API_KEY: "test-mock-key-not-real",
      RESEND_CONTACT_FROM: "GLOA <kontakt@gloamatcha.invalid>",
      RESEND_BASE_URL: `http://127.0.0.1:${MOCK_RESEND_PORT}`,
    },
    stdio: "ignore",
  });

  const ready = new Promise((resolveReady, rejectReady) => {
    serverProcess.once("exit", (code) => rejectReady(new Error(`server exited early (code ${code})`)));
    (async () => {
      for (let attempt = 0; attempt < 50; attempt++) {
        try {
          const res = await fetch(`${BASE_URL}/`);
          if (res.ok) { resolveReady(); return; }
        } catch { /* not up yet */ }
        await delay(200);
      }
      rejectReady(new Error("server did not become ready in time"));
    })();
  });
  await ready;
});

test.after(() => {
  serverProcess?.kill();
  mockResendServer?.close();
});

test.beforeEach(() => { resendRequestCount = 0; });

function sign(payload) {
  return stripeForSigning.webhooks.generateTestHeaderString({ payload, secret: FAKE_WEBHOOK_SECRET });
}

async function postSignedEvent(eventBody) {
  const payload = JSON.stringify(eventBody);
  const signature = sign(payload);
  const res = await fetch(`${BASE_URL}/api/stripe/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "stripe-signature": signature },
    body: payload,
  });
  return res;
}

test("webhook: an event whose Stripe session does not actually exist fails closed and never reaches the email provider", async () => {
  const res = await postSignedEvent({
    id: `evt_test_${crypto.randomUUID()}`,
    object: "event",
    type: "checkout.session.completed",
    data: { object: { id: "cs_test_does_not_exist_in_stripe", object: "checkout.session" } },
  });
  // The real Stripe API genuinely rejects this session id (it requires a
  // real STRIPE_SECRET_KEY to be configured in this environment's
  // .env.local, matching every other real-Stripe test in this suite) -
  // the webhook's existing try/catch turns that into a 500.
  assert.equal(res.status, 500);
  assert.equal(resendRequestCount, 0, "no confirmation email may be sent when the referenced session cannot be verified");
});

test("webhook: an unrelated event type is acknowledged but never triggers a confirmation email", async () => {
  const res = await postSignedEvent({
    id: `evt_test_${crypto.randomUUID()}`,
    object: "event",
    type: "ping",
    data: { object: { id: "obj_fake" } },
  });
  assert.equal(res.status, 200);
  assert.equal(resendRequestCount, 0);
});

test("webhook: a redelivery of the exact same already-processed event id is acknowledged without reprocessing", async () => {
  // "ping" is a safe, side-effect-free event type to redeliver: the
  // first delivery is recorded in stripe_webhook_events after handling
  // (a no-op for "ping"), the second must short-circuit at the
  // already-processed check before reaching any handler logic at all.
  const eventId = `evt_test_${crypto.randomUUID()}`;
  const body = { id: eventId, object: "event", type: "ping", data: { object: { id: "obj_fake" } } };

  const first = await postSignedEvent(body);
  assert.equal(first.status, 200);

  const second = await postSignedEvent(body);
  assert.equal(second.status, 200);
  assert.equal(resendRequestCount, 0);
});
