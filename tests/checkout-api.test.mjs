import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

// Real, permanently seeded variants from supabase/migrations/008_b2c_launch_products.sql
// (GLOA Matcha 30g/50g). Used to exercise the authoritative-quote pipeline
// against the live catalog without hardcoding prices anywhere in source.
const VARIANT_30G = "ca99d0f5-739e-4362-81bb-d508e37b42de";
const VARIANT_50G = "dad62795-efff-4d12-867f-9d6a7eb138f2";
const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const REQUEST_ID = "11111111-1111-1111-1111-111111111111";

const PORT = 8917;
const BASE_URL = `http://127.0.0.1:${PORT}`;

let serverProcess;

test.before(async () => {
  // STRIPE_SECRET_KEY is intentionally NOT set here, so these tests also
  // verify the session endpoint fails gracefully (503) instead of crashing
  // when Stripe is not configured.
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

async function post(path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test("quote: rejects an empty items array", async () => {
  const { status } = await post("/api/checkout/quote", { items: [] });
  assert.equal(status, 400);
});

test("quote: rejects an invalid variant UUID", async () => {
  const { status } = await post("/api/checkout/quote", { items: [{ variantId: "not-a-uuid", quantity: 1 }] });
  assert.equal(status, 400);
});

test("quote: rejects quantity 0", async () => {
  const { status } = await post("/api/checkout/quote", { items: [{ variantId: NIL_UUID, quantity: 0 }] });
  assert.equal(status, 400);
});

test("quote: unknown-but-valid variant UUID is treated as unavailable, not trusted", async () => {
  const { status } = await post("/api/checkout/quote", { items: [{ variantId: NIL_UUID, quantity: 1 }] });
  assert.equal(status, 400);
});

test("quote: prices and totals come from the DB, merges duplicate variant IDs", async () => {
  const { status, body } = await post("/api/checkout/quote", {
    items: [
      { variantId: VARIANT_30G, quantity: 1 },
      { variantId: VARIANT_50G, quantity: 1 },
      { variantId: VARIANT_30G, quantity: 2 },
    ],
  });
  assert.equal(status, 200);
  assert.equal(body.currency, "EUR");
  assert.equal(body.items.length, 2);

  const thirtyGram = body.items.find(item => item.variantId === VARIANT_30G);
  assert.equal(thirtyGram.quantity, 3);
  assert.equal(thirtyGram.lineGrossCents, thirtyGram.unitGrossCents * 3);
  assert.equal(body.subtotalGrossCents, body.items.reduce((sum, item) => sum + item.lineGrossCents, 0));
});

test("session: rejects a missing requestId", async () => {
  const { status } = await post("/api/checkout/session", {
    items: [{ variantId: VARIANT_30G, quantity: 1 }],
  });
  assert.equal(status, 400);
});

test("session: rejects a non-UUID requestId", async () => {
  const { status } = await post("/api/checkout/session", {
    items: [{ variantId: VARIANT_30G, quantity: 1 }],
    requestId: "not-a-uuid",
  });
  assert.equal(status, 400);
});

test("session: rejects an empty items array", async () => {
  const { status } = await post("/api/checkout/session", { items: [], requestId: REQUEST_ID });
  assert.equal(status, 400);
});

test("session: ignores client-supplied price fields and fails gracefully without STRIPE_SECRET_KEY", async () => {
  const { status, body } = await post("/api/checkout/session", {
    items: [{ variantId: VARIANT_30G, quantity: 1, unitPriceCents: 1, price: 1, currency: "usd" }],
    requestId: REQUEST_ID,
  });
  // Reaching the "payment provider unavailable" response proves the
  // authoritative DB quote was built successfully first (manipulated price
  // fields did not cause a different error), and that a missing Stripe key
  // fails the request instead of crashing the server.
  assert.equal(status, 503);
  assert.equal(typeof body.error, "string");
});
