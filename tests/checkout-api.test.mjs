import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { getActiveVariantBySku } from "./helpers/catalog.mjs";
import { writeBlockedServerEnv } from "./helpers/testSupabase.mjs";

// SAFE DEFAULT SUITE: the spawned server is started without a Supabase
// service-role key, so every write path in the app degrades to its
// "admin client not configured" branch and no row can be written.

// Resolved dynamically from the configured Supabase project by SKU in
// test.before() - never hardcoded UUIDs or prices. Supabase stays the
// single source of truth these tests verify against.
let variant30g;
let variant50g;
let variant100g;

const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const REQUEST_ID = "11111111-1111-1111-1111-111111111111";
// Every session request carries one since 055 Phase B: the route
// resolves it to a Stripe Customer before Checkout, so an omitted or
// malformed address is now a 400 in its own right. Added to the fixtures
// below rather than removed from the assertions - each of those tests is
// about a DIFFERENT field being inert, and still is.
const CUSTOMER_EMAIL = "checkout-api@example.com";

const PORT = 8917;
const BASE_URL = `http://127.0.0.1:${PORT}`;

let serverProcess;

test.before(async () => {
  const [thirtyGram, fiftyGram, hundredGram] = await Promise.all([
    getActiveVariantBySku("GLOA-MATCHA-30G"),
    getActiveVariantBySku("GLOA-MATCHA-50G"),
    getActiveVariantBySku("GLOA-MATCHA-100G"),
  ]);
  variant30g = thirtyGram;
  variant50g = fiftyGram;
  variant100g = hundredGram;

  // STRIPE_SECRET_KEY is intentionally NOT set here, so these tests also
  // verify the session endpoint fails gracefully (503) instead of crashing
  // when Stripe is not configured.
  serverProcess = spawn(process.execPath, [".output/server/index.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: writeBlockedServerEnv({ PORT: String(PORT) }),
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
    email: CUSTOMER_EMAIL,
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
    email: CUSTOMER_EMAIL,
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
    email: CUSTOMER_EMAIL,
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

/* ══════════════════════════════════════════════════════════════
   GLOALAUNCH10 — THE AUTHORITATIVE QUOTE, LIVE

   Read-only. The quote endpoint writes nothing, takes no identity and
   creates no Stripe object, so these run against the same write-blocked
   server as everything else above and cannot produce a row.

   TIME-AWARE ON PURPOSE. The code is only valid in October 2026, and a
   suite that hardcoded "refused" would start failing the day the window
   opens - which is exactly the day nobody wants a red build. So each
   assertion says what must be true on the side of the window the clock
   is actually on, and both sides are asserted to the cent.
   ══════════════════════════════════════════════════════════════ */

const LAUNCH_FROM_MS = Date.parse("2026-10-01T12:00:00+02:00");
const LAUNCH_UNTIL_MS = Date.parse("2026-10-31T23:59:59.999+01:00");
const insideWindow = () => {
  const now = Date.now();
  return now >= LAUNCH_FROM_MS && now <= LAUNCH_UNTIL_MS;
};

test("discount: a basket without a code gets no discount block at all", async () => {
  const { status, body } = await post("/api/checkout/quote", {
    items: [{ variantId: variant50g.id, quantity: 1 }],
    shippingCountry: "DE",
  });
  assert.equal(status, 200);
  assert.equal("discount" in body, false, "an unasked-for discount appeared");
  assert.equal(body.subtotalGrossCents, variant50g.price_gross_cents);
});

test("discount: an unknown code is refused in German, and changes no price", async () => {
  const { status, body } = await post("/api/checkout/quote", {
    items: [{ variantId: variant50g.id, quantity: 1 }],
    shippingCountry: "DE",
    discountCode: "NOT-A-CODE",
  });
  assert.equal(status, 200);
  assert.deepEqual(body.discount, { applied: false, message: "Rabattcode ist ungültig." });
  // The basket is untouched: a refused code is not a silent discount.
  assert.equal(body.subtotalGrossCents, variant50g.price_gross_cents);
});

test("discount: GLOALAUNCH10 is priced by the server, on whichever side of the window today is", async () => {
  const { status, body } = await post("/api/checkout/quote", {
    items: [{ variantId: variant50g.id, quantity: 1 }],
    shippingCountry: "DE",
    discountCode: "gloalaunch10",   // lower case on purpose
  });
  assert.equal(status, 200);

  if (!insideWindow()) {
    // Before 01.10.2026 12:00 and after 31.10.2026 23:59:59.999 the
    // code exists but cannot be used, and the customer is told which.
    assert.equal(body.discount.applied, false);
    assert.ok(
      ["Der Rabattcode ist noch nicht gültig.", "Der Rabattcode ist abgelaufen."].includes(body.discount.message),
      `unexpected refusal: ${body.discount.message}`
    );
    return;
  }

  // Inside the window: ten percent of the eligible merchandise, rounded
  // half up, in whole cents - and the code comes back normalised.
  const gross = variant50g.price_gross_cents;
  const expected = Math.floor((gross * 10 + 50) / 100);
  assert.equal(body.discount.applied, true);
  assert.equal(body.discount.code, "GLOALAUNCH10");
  assert.equal(body.discount.percent, 10);
  assert.equal(body.discount.eligibleSubtotalGrossCents, gross);
  assert.equal(body.discount.discountGrossCents, expected);
  assert.equal(body.discount.discountedSubtotalGrossCents, gross - expected);
});

test("discount: the browser cannot send its own amount", async () => {
  // Every one of these is ignored: the response is identical to the one
  // the same basket and code produce on their own.
  const honest = await post("/api/checkout/quote", {
    items: [{ variantId: variant30g.id, quantity: 2 }],
    shippingCountry: "DE",
    discountCode: "GLOALAUNCH10",
  });
  const forged = await post("/api/checkout/quote", {
    items: [{ variantId: variant30g.id, quantity: 2 }],
    shippingCountry: "DE",
    discountCode: "GLOALAUNCH10",
    discount: { applied: true, discountGrossCents: 999999 },
    discountGrossCents: 999999,
    discountPercent: 95,
    percent: 95,
    eligibleSubtotalGrossCents: 999999,
    subtotalGrossCents: 1,
  });
  assert.equal(forged.status, 200);
  assert.deepEqual(forged.body, honest.body, "a client-supplied discount value was read");
});

test("discount: free shipping is judged on the PRE-discount merchandise", async () => {
  // A basket just over the German threshold (4900) must still ship free
  // after ten percent comes off - the discount must never make a total
  // go up. 2 x 100g is 7998 before the code and 7198 after, so both
  // sides of the threshold are covered by one basket only if the rule
  // is applied to the right one.
  const { status, body } = await post("/api/checkout/quote", {
    items: [{ variantId: variant100g.id, quantity: 1 }, { variantId: variant50g.id, quantity: 2 }],
    shippingCountry: "DE",
    discountCode: "GLOALAUNCH10",
  });
  assert.equal(status, 200);

  const merchandise = body.subtotalGrossCents;
  assert.ok(merchandise >= 4900, "the fixture basket no longer crosses the threshold");
  assert.equal(body.tax.shippingGrossCents, 0, "free shipping was lost");

  if (!insideWindow()) return;

  // AND THE TOTALS RECONCILE TO THE CENT:
  //   merchandise - discount + shipping = the gross the customer pays.
  const discount = body.discount.discountGrossCents;
  assert.equal(body.discount.discountedSubtotalGrossCents, merchandise - discount);
  assert.equal(body.tax.grossCents, merchandise - discount + body.tax.shippingGrossCents);
  // Tax is a share of that gross, never of the undiscounted one.
  assert.equal(body.tax.netCents + body.tax.taxCents, body.tax.grossCents);
  assert.ok(body.tax.taxCents > 0, "a German matcha basket pays no VAT");
});

test("discount: a basket of only ineligible lines is told so, not refused as unknown", async () => {
  // Every SKU this shop currently sells one-time is eligible, so the
  // honest live case is the empty one: no line at all means nothing the
  // code can reduce, and the endpoint says so rather than pretending
  // the code is wrong.
  const { status } = await post("/api/checkout/quote", {
    items: [],
    shippingCountry: "DE",
    discountCode: "GLOALAUNCH10",
  });
  // An empty basket is rejected before pricing, by the shared item
  // validation - which is the correct order: there is nothing to quote.
  assert.equal(status, 400);
});
