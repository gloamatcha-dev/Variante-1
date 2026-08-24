import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { writeBlockedServerEnv } from "./helpers/testSupabase.mjs";

// SAFE DEFAULT SUITE: two spawned servers, both started WITHOUT a
// Supabase service-role key, so every write path degrades to its "admin
// client not configured" branch and no row can be written. Neither server
// gets a Stripe key either, so no Stripe object can be created.
//
// This file proves the two things that only exist at the HTTP boundary:
// the feature gate is enforced by the SERVER and not by a hidden button,
// and an unauthenticated caller is refused before any work happens.

const PATH = "/api/subscriptions/checkout/session";
const UUID = n => `${String(n).repeat(8)}-${String(n).repeat(4)}-${String(n).repeat(4)}-${String(n).repeat(4)}-${String(n).repeat(12)}`;

const VALID_BODY = { planId: UUID(1), addressId: UUID(3), requestId: UUID(4) };

async function startServer(port, extraEnv) {
  const child = spawn(process.execPath, [".output/server/index.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: writeBlockedServerEnv({ PORT: String(port), ...extraEnv }),
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

function post(port, body, headers = {}) {
  return fetch(`http://127.0.0.1:${port}${PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

/* ── The gate, as the production environment has it ─────────── */

const DISABLED_PORT = 8921;
let disabledServer;

test.before(async () => {
  // B2C_SUBSCRIPTIONS_ENABLED is deliberately NOT set, which is exactly
  // the live configuration until Task 29D-E is verified.
  disabledServer = await startServer(DISABLED_PORT, { B2C_SUBSCRIPTIONS_ENABLED: "" });
});

test.after(() => {
  disabledServer?.kill();
});

test("gate: the server refuses subscription checkout while the flag is unset", async () => {
  const res = await post(DISABLED_PORT, VALID_BODY);
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.match(body.error, /nicht verfügbar/);
  // No internals in the customer-facing message.
  assert.ok(!/stripe|supabase|env|flag|B2C_/i.test(body.error), "the refusal leaks an internal detail");
});

test("gate: it refuses even a well-formed authenticated-looking request", async () => {
  // A bearer token changes nothing while the gate is shut: the gate runs
  // before authentication, before any read and before any write.
  const res = await post(DISABLED_PORT, VALID_BODY, { authorization: "Bearer looks-like-a-token" });
  assert.equal(res.status, 503);
});

test("gate: a body carrying a price is still refused by the gate, not accepted", async () => {
  const res = await post(DISABLED_PORT, { ...VALID_BODY, unitAmountCents: 1 });
  assert.equal(res.status, 503, "the gate must answer before the body is even parsed");
});

/* ── With the gate open, in a throwaway server only ─────────── */

const ENABLED_PORT = 8922;
let enabledServer;

test.before(async () => {
  // Enabled ONLY inside this test process, and only for a server that has
  // no service-role key and no Stripe key. Nothing here can reach a real
  // Stripe account or write a production row.
  enabledServer = await startServer(ENABLED_PORT, { B2C_SUBSCRIPTIONS_ENABLED: "true" });
});

test.after(() => {
  enabledServer?.kill();
});

test("auth: an unauthenticated caller is rejected with 401", async () => {
  const res = await post(ENABLED_PORT, VALID_BODY);
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.match(body.error, /melde dich an/i);
  assert.ok(!/stripe|supabase|token|jwt/i.test(body.error), "the refusal leaks an internal detail");
});

test("auth: an invalid bearer token is rejected, not trusted", async () => {
  for (const authorization of ["Bearer", "Bearer ", "Bearer not-a-real-token", "Basic abc"]) {
    const res = await post(ENABLED_PORT, VALID_BODY, { authorization });
    assert.equal(res.status, 401, `${authorization} was accepted`);
  }
});

test("request: a commercial field is refused before authentication is even attempted", async () => {
  // 400, not 401: the body is rejected outright rather than the field
  // being ignored and the request continuing.
  for (const extra of [
    { unitAmountCents: 1 },
    { price: 1 },
    { shippingGrossCents: 0 },
    { quantity: 99 },
    { userId: UUID(5) },
    { stripeCustomerId: "cus_evil" },
  ]) {
    const res = await post(ENABLED_PORT, { ...VALID_BODY, ...extra });
    assert.equal(res.status, 400, `${Object.keys(extra)[0]} was not refused`);
  }
});

test("request: malformed ids are refused", async () => {
  for (const body of [
    {},
    { ...VALID_BODY, planId: "not-a-uuid" },
    { ...VALID_BODY, addressId: "not-a-uuid" },
    { ...VALID_BODY, requestId: "not-a-uuid" },
  ]) {
    const res = await post(ENABLED_PORT, body);
    assert.equal(res.status, 400);
  }
});

test("boundary: the one-time checkout endpoint is unaffected by the flag", async () => {
  // Same server, flag on: the payment flow must behave exactly as before.
  // Without a Stripe key it degrades to 503, which is its existing
  // behaviour and not a subscription-related change.
  const res = await fetch(`http://127.0.0.1:${ENABLED_PORT}/api/checkout/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items: [], requestId: UUID(4), shippingCountry: "DE" }),
  });
  assert.equal(res.status, 400, "invalid items must still be a 400 from the one-time route");
});
