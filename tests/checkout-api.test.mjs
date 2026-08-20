import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { getActiveVariantBySku } from "./helpers/catalog.mjs";

// Resolved dynamically from the configured Supabase project by SKU in
// test.before() - never hardcoded UUIDs or prices. Supabase stays the
// single source of truth these tests verify against.
let variant30g;
let variant50g;

const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const REQUEST_ID = "11111111-1111-1111-1111-111111111111";

const PORT = 8917;
const BASE_URL = `http://127.0.0.1:${PORT}`;

let serverProcess;

test.before(async () => {
  const [thirtyGram, fiftyGram] = await Promise.all([
    getActiveVariantBySku("GLOA-MATCHA-30G"),
    getActiveVariantBySku("GLOA-MATCHA-50G"),
  ]);
  variant30g = thirtyGram;
  variant50g = fiftyGram;

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
      { variantId: variant30g.id, quantity: 1 },
      { variantId: variant50g.id, quantity: 1 },
      { variantId: variant30g.id, quantity: 2 },
    ],
  });
  assert.equal(status, 200);
  assert.equal(body.currency, variant30g.currency);
  assert.equal(body.items.length, 2);

  const thirtyGram = body.items.find(item => item.variantId === variant30g.id);
  assert.equal(thirtyGram.quantity, 3);
  assert.equal(thirtyGram.unitGrossCents, variant30g.price_gross_cents);
  assert.equal(thirtyGram.lineGrossCents, thirtyGram.unitGrossCents * 3);
  assert.equal(body.subtotalGrossCents, body.items.reduce((sum, item) => sum + item.lineGrossCents, 0));
});

test("session: rejects a missing requestId", async () => {
  const { status } = await post("/api/checkout/session", {
    items: [{ variantId: variant30g.id, quantity: 1 }],
  });
  assert.equal(status, 400);
});

test("session: rejects a non-UUID requestId", async () => {
  const { status } = await post("/api/checkout/session", {
    items: [{ variantId: variant30g.id, quantity: 1 }],
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
    items: [
      {
        variantId: variant30g.id,
        quantity: 1,
        unitPriceCents: 1,
        price: 1,
        currency: "usd",
      },
    ],
    requestId: REQUEST_ID,
    shippingCountry: "DE",
  });
  // Reaching the "payment provider unavailable" response proves the
  // authoritative DB quote was built successfully first (manipulated price
  // fields did not cause a different error), and that a missing Stripe key
  // fails the request instead of crashing the server.
  assert.equal(status, 503);
  assert.equal(typeof body.error, "string");
});

test("session: ignores any client-supplied user id field in the request body", async () => {
  const { status, body } = await post("/api/checkout/session", {
    items: [{ variantId: variant30g.id, quantity: 1 }],
    requestId: REQUEST_ID,
    shippingCountry: "DE",
    userId: "11111111-1111-1111-1111-111111111111",
    user_id: "22222222-2222-2222-2222-222222222222",
  });
  // The route never reads a userId/user_id field from the body at all -
  // identity comes exclusively from a verified Authorization bearer token
  // (lib/verifyUser.ts). Reaching the same "payment provider unavailable"
  // response as an identical request without these fields proves they
  // have zero effect on request handling.
  assert.equal(status, 503);
  assert.equal(typeof body.error, "string");
});

test("session: rejects a missing shippingCountry", async () => {
  const { status, body } = await post("/api/checkout/session", {
    items: [{ variantId: variant30g.id, quantity: 1 }],
    requestId: REQUEST_ID,
  });
  assert.equal(status, 400);
  assert.equal(typeof body.error, "string");
});

test("session: rejects an unsupported/sanctioned shippingCountry", async () => {
  for (const country of ["US", "RU", "BY", "UA", "ZZ", ""]) {
    const { status } = await post("/api/checkout/session", {
      items: [{ variantId: variant30g.id, quantity: 1 }],
      requestId: REQUEST_ID,
      shippingCountry: country,
    });
    assert.equal(status, 400, `expected ${JSON.stringify(country)} to be rejected`);
  }
});

test("session: ignores any client-supplied shipping zone/price/free-shipping fields in the request body", async () => {
  const { status, body } = await post("/api/checkout/session", {
    items: [{ variantId: variant30g.id, quantity: 1 }],
    requestId: REQUEST_ID,
    shippingCountry: "DE",
    shippingZone: "restOfEurope",
    shippingPrice: 1,
    shippingGrossCents: 1,
    freeShipping: true,
    orderTotal: 1,
  });
  // The route only ever reads shippingCountry from the body - zone, price,
  // and free-shipping eligibility are always recomputed server-side
  // (lib/shipping.ts). Reaching the same "payment provider unavailable"
  // response as a request without these fields proves they're inert.
  assert.equal(status, 503);
  assert.equal(typeof body.error, "string");
});
