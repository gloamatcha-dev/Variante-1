import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import Stripe from "stripe";
import { writeBlockedServerEnv } from "./helpers/testSupabase.mjs";

// SAFE DEFAULT SUITE: the spawned server is started without a Supabase
// service-role key, so every write path in the app degrades to its
// "admin client not configured" branch and no row can be written.

// Fake, local-only secret used exclusively to sign test payloads. Never a
// real STRIPE_WEBHOOK_SECRET, and no network call is made with it - Stripe's
// webhook signing/verification helpers are pure local HMAC operations.
const FAKE_WEBHOOK_SECRET = "whsec_test_fake_secret_for_local_tests_only";
const stripeForSigning = new Stripe("sk_test_not_a_real_key_used_only_for_local_webhook_signing");

const PORT_WITH_SECRET = 8918;
const PORT_WITHOUT_SECRET = 8919;
const BASE_WITH_SECRET = `http://127.0.0.1:${PORT_WITH_SECRET}`;
const BASE_WITHOUT_SECRET = `http://127.0.0.1:${PORT_WITHOUT_SECRET}`;

let serverWithSecret;
let serverWithoutSecret;

async function waitForReady(baseUrl) {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const res = await fetch(`${baseUrl}/`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await delay(200);
  }
  throw new Error(`server at ${baseUrl} did not become ready in time`);
}

test.before(async () => {
  serverWithSecret = spawn(process.execPath, [".output/server/index.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: writeBlockedServerEnv({
      PORT: String(PORT_WITH_SECRET),
      STRIPE_WEBHOOK_SECRET: FAKE_WEBHOOK_SECRET,
      // Only needed so getStripeClient() is non-null and the route reaches
      // signature verification; webhooks.constructEvent is a pure local
      // HMAC check and never sends this key to Stripe's API.
      STRIPE_SECRET_KEY: "sk_test_not_a_real_key_used_only_so_the_client_constructs",
    }),
    stdio: "ignore",
  });
  const envWithoutSecret = writeBlockedServerEnv({
    PORT: String(PORT_WITHOUT_SECRET),
    // Set so this test isolates "STRIPE_WEBHOOK_SECRET missing" specifically,
    // not "STRIPE_SECRET_KEY missing" too.
    STRIPE_SECRET_KEY: "sk_test_not_a_real_key_used_only_so_the_client_constructs",
  });
  delete envWithoutSecret.STRIPE_WEBHOOK_SECRET;
  serverWithoutSecret = spawn(process.execPath, [".output/server/index.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: envWithoutSecret,
    stdio: "ignore",
  });

  await Promise.all([waitForReady(BASE_WITH_SECRET), waitForReady(BASE_WITHOUT_SECRET)]);
});

test.after(() => {
  serverWithSecret?.kill();
  serverWithoutSecret?.kill();
});

function fakeEventPayload() {
  return JSON.stringify({
    id: "evt_test_fake",
    object: "event",
    type: "ping",
    data: { object: { id: "obj_fake" } },
  });
}

test("webhook: missing stripe-signature header is rejected", async () => {
  const res = await fetch(`${BASE_WITH_SECRET}/api/stripe/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: fakeEventPayload(),
  });
  assert.equal(res.status, 400);
});

test("webhook: invalid stripe-signature header is rejected", async () => {
  const res = await fetch(`${BASE_WITH_SECRET}/api/stripe/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "stripe-signature": "t=1,v1=not-a-real-signature" },
    body: fakeEventPayload(),
  });
  assert.equal(res.status, 400);
});

test("webhook: signed with the wrong secret is rejected", async () => {
  const payload = fakeEventPayload();
  const signature = stripeForSigning.webhooks.generateTestHeaderString({
    payload,
    secret: "whsec_test_a_completely_different_fake_secret",
  });
  const res = await fetch(`${BASE_WITH_SECRET}/api/stripe/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "stripe-signature": signature },
    body: payload,
  });
  assert.equal(res.status, 400);
});

test("webhook: missing STRIPE_WEBHOOK_SECRET config fails closed with 503", async () => {
  const payload = fakeEventPayload();
  const signature = stripeForSigning.webhooks.generateTestHeaderString({
    payload,
    secret: FAKE_WEBHOOK_SECRET,
  });
  const res = await fetch(`${BASE_WITHOUT_SECRET}/api/stripe/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "stripe-signature": signature },
    body: payload,
  });
  assert.equal(res.status, 503);
});
