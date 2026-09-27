import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { getActiveVariantBySku } from "./helpers/catalog.mjs";
import { writeBlockedServerEnv } from "./helpers/testSupabase.mjs";
import {
  shopSellsNow,
  checkoutRefusalFor,
  CHECKOUT_CLOSED_STATUS,
  CHECKOUT_CLOSED_MESSAGE,
  SHOP_STATUS_LIVE,
} from "../lib/shopAvailability.ts";

/**
 * THE LAUNCH GATE: BOTH STATES, ONE SWITCH.
 *
 * The shop has to be provably safe while it is closed AND provably
 * complete when it opens, and the switch between the two has to be a
 * single edit. This suite is what makes all three checkable today,
 * while production stays prelaunch.
 *
 * ── HOW "LIVE" IS TESTED WITHOUT GOING LIVE ───────────────────
 *
 * SHOP_STATUS is a compile-time constant in app/content.ts, so a
 * rendered page can only ever be asserted in the state the bundle was
 * built in - which is, and must remain, prelaunch. The decision it
 * feeds is therefore kept in a pure function that takes the status as
 * an argument (lib/shopAvailability.ts), so both branches run here with
 * no rebuild, no environment override and, deliberately, no back door
 * on the deployed site: there is no ?shop=live, no header and no cookie
 * that could open a production shop from the outside.
 *
 * What the HTTP half proves is the half that cannot be faked: that the
 * REAL, currently deployed configuration refuses to create a payable
 * Stripe session, and that it does so with a clean answer rather than a
 * crash.
 *
 * SAFE BY CONSTRUCTION: the spawned server runs without a Supabase
 * service-role key (writeBlockedServerEnv), so no row can be written,
 * and the dummy Stripe key below is never used for a network call - the
 * gate returns before any Stripe request is made, which is precisely
 * what the test asserts.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf8");

const availability = read("lib/shopAvailability.ts");
const sessionRoute = read("app/api/checkout/session/route.ts");
const content = read("app/content.ts");
const slugPage = read("app/[...slug]/page.tsx");

const PORT = 8961;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const REQUEST_ID = "3f1c9a52-7d84-4f1e-9b6a-2c5d8e0a4b71";
// A request is only "fully valid" since 055 Phase B if it carries an
// address: the route resolves one to a Stripe Customer before Checkout.
// Every fixture below that is meant to REACH the gate must have it, or
// it would be refused at validation and stop proving anything about the
// gate at all - including 3c, which passes either way and would have
// quietly stopped testing the refusal.
const CUSTOMER_EMAIL = "launch-gate@example.com";

let serverProcess;
let variant30g;
let shopHtml;

test.before(async () => {
  variant30g = await getActiveVariantBySku("GLOA-MATCHA-30G");

  // STRIPE_SECRET_KEY and SITE_URL are set on purpose, and this is the
  // whole point of this suite's own server: tests/checkout-api.test.mjs
  // runs WITHOUT them and therefore stops at the 503 "payment provider
  // unavailable" branch, which would hide the gate behind it. Configured
  // like production, the request runs all the way to the gate.
  //
  // The key is a syntactically valid dummy and never leaves the process:
  // constructing a Stripe client performs no request, and the gate
  // returns before checkout.sessions.create is reached.
  serverProcess = spawn(process.execPath, [".output/server/index.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: writeBlockedServerEnv({
      PORT: String(PORT),
      STRIPE_SECRET_KEY: "sk_test_launchgate_dummy_key_never_sent",
      SITE_URL: "http://127.0.0.1:" + PORT,
    }),
    stdio: "ignore",
  });

  const ready = new Promise((resolveReady, rejectReady) => {
    serverProcess.once("exit", code => rejectReady(new Error(`server exited early (code ${code})`)));
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

  const shopRes = await fetch(`${BASE_URL}/shop`);
  assert.equal(shopRes.status, 200, "/shop did not render");
  shopHtml = await shopRes.text();
});

test.after(() => { serverProcess?.kill(); });

async function post(path, body, headers = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* non-JSON body is itself a finding */ }
  return { status: res.status, body: parsed, text };
}

/* ══════════════════════════════════════════════════════════════
   1. ONE SOURCE OF TRUTH
   ══════════════════════════════════════════════════════════════ */

test("1: the gate derives from SHOP_STATUS and invents no second flag", () => {
  // The canonical value, and the price flag already derived from it.
  assert.match(content, /export const SHOP_STATUS = "(prelaunch|live)" as const;/);
  // DERIVED, still from SHOP_STATUS and from nothing else. The value is
  // widened to a string once in app/content.ts because `as const`
  // narrows the constant to one literal, which makes a direct
  // comparison a type error the moment the shop is flipped live.
  assert.match(content, /const SHOP_STATUS_VALUE: string = SHOP_STATUS;/);
  assert.match(content,
    /export const PRICES_VISIBLE: boolean = SHOP_STATUS_VALUE !== "prelaunch";/);
  // And the prelaunch predicate is its exact complement, so a surface
  // cannot show a price while still routing its button to /contact.
  assert.match(content,
    /export const SHOP_IS_PRELAUNCH: boolean = SHOP_STATUS_VALUE === "prelaunch";/);
  // The route reads that one constant - not an env var, not its own copy.
  assert.match(sessionRoute, /import \{ SHOP_STATUS \} from "\.\.\/\.\.\/\.\.\/content";/);
  assert.match(sessionRoute, /checkoutRefusalFor\(SHOP_STATUS\)/);
});

test("1b: the rules module is a pure leaf - no imports, no env, no clock", () => {
  const code = availability.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\r\n]*/g, "");
  assert.ok(!/^\s*import /m.test(code), "the availability module grew an import");
  for (const banned of ["process.env", "Date.now", "window.", "document.", "fetch("]) {
    assert.ok(!code.includes(banned), `the availability module reaches for ${banned}`);
  }
  // And no parallel launch switch was introduced anywhere.
  for (const invented of ["SHOP_LIVE", "SHOP_ENABLED", "CHECKOUT_ENABLED", "FORCE_LIVE", "SHOP_STATUS_OVERRIDE"]) {
    assert.ok(!availability.includes(invented) && !sessionRoute.includes(invented) && !content.includes(invented),
      `a second launch flag exists: ${invented}`);
  }
});

test("1c: no request-controlled back door can open the shop", () => {
  // Nothing about the gate may be reachable from a query string, a
  // header or a cookie - on production that would be the shop itself.
  for (const banned of ["shop=live", "searchParams", "x-shop", "cookie"]) {
    assert.ok(!sessionRoute.toLowerCase().includes(banned.toLowerCase()),
      `the checkout route reads ${banned}`);
  }
});

/* ══════════════════════════════════════════════════════════════
   2. BOTH STATES, AS PURE DECISIONS
   ══════════════════════════════════════════════════════════════ */

test("2: live sells, and the refusal disappears in exactly that state", () => {
  assert.equal(SHOP_STATUS_LIVE, "live");
  assert.equal(shopSellsNow("live"), true);
  assert.equal(checkoutRefusalFor("live"), null);
});

test("2b: every other status fails closed", () => {
  for (const closed of ["prelaunch", "LIVE", "Live", " live", "live ", "", "coming_soon", "true", "1"]) {
    assert.equal(shopSellsNow(closed), false, `${JSON.stringify(closed)} was treated as live`);
    const refusal = checkoutRefusalFor(closed);
    assert.ok(refusal, `${JSON.stringify(closed)} produced no refusal`);
    assert.equal(refusal.status, CHECKOUT_CLOSED_STATUS);
    assert.equal(refusal.error, CHECKOUT_CLOSED_MESSAGE);
  }
});

test("2c: the refusal is a conflict, not an error and not an outage", () => {
  // 409: the request is well-formed and allowed, the shop is just shut.
  // A 5xx would page somebody at 3am for a shop working as designed.
  assert.equal(CHECKOUT_CLOSED_STATUS, 409);
  assert.ok(CHECKOUT_CLOSED_STATUS < 500, "a closed shop is reported as a server fault");
  // Customer-facing German, and it promises no date it cannot keep.
  assert.match(CHECKOUT_CLOSED_MESSAGE, /Launch/);
  assert.ok(!/\d{1,2}\.\s*(Oktober|10\.)/.test(CHECKOUT_CLOSED_MESSAGE),
    "the refusal repeats a launch date that lives in lib/launchCountdown.ts");
});

/* ══════════════════════════════════════════════════════════════
   3. LIVE, AGAINST THE REAL DEPLOYED CONFIGURATION
   ══════════════════════════════════════════════════════════════

   The shop is LIVE, so what this section proves has inverted: the
   launch gate must no longer refuse a valid request, and a request
   that is refused must be refused for its OWN reason.

   ── AND IT STILL MAKES NO STRIPE CALL ───────────────────────

   The server spawned above has a dummy Stripe key and, by
   writeBlockedServerEnv, no Supabase service-role key. That pairing is
   what keeps these tests safe now that the gate is open:

     the launch gate        passed - it no longer returns 409
     the shared rate limit  DIRECTLY BELOW THE GATE in the route, and
                            it cannot read its counter without
                            Supabase, so it answers 503
     identity resolution    never reached; and even if it were,
                            getOrCreateCheckoutCustomerByEmail calls
                            findMapping (Supabase) BEFORE
                            createCustomer (Stripe), so it fails before
                            any Stripe request
     sessions.create        never reached

   So reaching the limiter is the PROOF that the gate is open - the
   limiter sits below it - and the dummy key is still never sent. A
   test that drove a genuinely successful Stripe session would have to
   talk to Stripe, and this suite must not.
*/

test("3: the deployed shop is LIVE, so the gate below is the live one", () => {
  assert.match(content, /export const SHOP_STATUS = "live" as const;/);
});

test("3b: a fully valid checkout is NOT refused by the launch gate", async () => {
  const { status, body } = await post("/api/checkout/session", {
    items: [{ variantId: variant30g.id, quantity: 1 }],
    requestId: REQUEST_ID,
    shippingCountry: "DE",
    email: CUSTOMER_EMAIL,
  });
  // THE PRELAUNCH REFUSAL IS GONE. Neither its status nor its wording
  // may come back for a well-formed request.
  assert.notEqual(status, CHECKOUT_CLOSED_STATUS,
    "a live shop still answers the prelaunch conflict");
  assert.notEqual(body.error, CHECKOUT_CLOSED_MESSAGE,
    "a live shop still sends the closed-shop message");
  // And it travelled PAST the gate: the shared rate limiter sits
  // directly below it and is the first thing that needs Supabase, which
  // this harness deliberately blocks.
  assert.equal(status, 503,
    `expected the post-gate limiter on this harness, got ${status}`);
});

test("3c: nothing Stripe-shaped and no price is produced on this harness", async () => {
  const { text } = await post("/api/checkout/session", {
    items: [{ variantId: variant30g.id, quantity: 1 }],
    requestId: REQUEST_ID,
    shippingCountry: "DE",
    email: CUSTOMER_EMAIL,
  });
  // NO REAL STRIPE CALL HAPPENED: no session, no url, no customer id.
  assert.ok(!/checkout\.stripe\.com|cs_test_|cs_live_|cus_/.test(text),
    "a Stripe object reached the response - a live call may have been made");
  assert.ok(!new RegExp(String(variant30g.price_gross_cents)).test(text),
    "the response published an amount");
});

test("3d: invalid requests are refused for their OWN reason, not the gate", async () => {
  const ok = {
    items: [{ variantId: variant30g.id, quantity: 1 }],
    requestId: REQUEST_ID,
    shippingCountry: "DE",
    email: CUSTOMER_EMAIL,
  };
  // Each of these is a VALIDATION failure and returns before the gate,
  // so none may carry the closed-shop answer.
  for (const bad of [
    { ...ok, items: [] },
    { ...ok, items: [{ variantId: variant30g.id, quantity: 0 }] },
    { ...ok, items: [{ variantId: variant30g.id, quantity: -1 }] },
    { ...ok, items: [{ variantId: variant30g.id, quantity: 99 }] },
    { ...ok, requestId: "not-a-uuid" },
    { ...ok, shippingCountry: "US" },
  ]) {
    const { status, body } = await post("/api/checkout/session", bad);
    assert.notEqual(status, CHECKOUT_CLOSED_STATUS,
      `${JSON.stringify(bad)} was answered with the prelaunch conflict`);
    assert.notEqual(body.error, CHECKOUT_CLOSED_MESSAGE);
    assert.ok(status >= 400,
      `${JSON.stringify(bad)} was accepted by a live shop`);
  }
  // A quantity of zero is still a quantity problem, in its own words.
  const zero = await post("/api/checkout/session",
    { ...ok, items: [{ variantId: variant30g.id, quantity: 0 }] });
  assert.equal(zero.status, 400);
  assert.match(zero.body.error, /Artikel oder Mengen/);
});

test("3d2: a client-supplied price is inert - it neither pays nor refuses", async () => {
  // The amount is the server's. A crafted unit price must not change
  // the outcome, and must not appear anywhere in the answer.
  const { status, body, text } = await post("/api/checkout/session", {
    items: [{ variantId: variant30g.id, quantity: 1, unitPriceCents: 1, price: 0.01, currency: "usd" }],
    requestId: REQUEST_ID,
    shippingCountry: "DE",
    email: CUSTOMER_EMAIL,
  });
  // Same outcome as the clean request above: the crafted price bought
  // nothing and blocked nothing.
  assert.equal(status, 503);
  assert.notEqual(body.error, CHECKOUT_CLOSED_MESSAGE);
  assert.ok(!/usd|unitPriceCents/i.test(text),
    "the client price was echoed back");
  // And the crafted amount itself is nowhere in the answer.
  assert.ok(!text.includes("0.01"), "the client amount was echoed back");
});

test("3f: the launch DATE does not gate commerce - only SHOP_STATUS does", () => {
  // Reaching or not reaching GLOA_LAUNCH_ISO must never open or close
  // the till. The route knows nothing about the countdown.
  for (const dateThing of ["launchCountdown", "GLOA_LAUNCH", "launchStatus"]) {
    assert.ok(!sessionRoute.includes(dateThing),
      `the checkout route reads ${dateThing} - a date must not gate commerce`);
  }
  assert.match(sessionRoute, /checkoutRefusalFor\(SHOP_STATUS\)/,
    "SHOP_STATUS is no longer the commerce authority");
});

test("3e: the gate sits before every side effect in the route", () => {
  // Source order is the guarantee: the refusal must be returned before
  // anything writes a row, verifies a token or calls Stripe. A gate
  // placed after getOrCreateCheckoutAttempt would still answer 409 while
  // leaving a checkout attempt behind on every probe.
  const gateAt = sessionRoute.indexOf("checkoutRefusalFor(SHOP_STATUS)");
  assert.ok(gateAt > 0, "the gate is not in the route at all");
  for (const sideEffect of [
    "getOrCreateCheckoutAttempt(",
    "stripe.checkout.sessions.create(",
    "verifyUserId(",
    "linkStripeSession(",
  ]) {
    const at = sessionRoute.indexOf(sideEffect);
    assert.ok(at > gateAt, `${sideEffect} can run before the launch gate`);
  }
});

/* ══════════════════════════════════════════════════════════════
   4. LIVE PRICES - INCLUDING THE ONES IN THE MARKUP
   ══════════════════════════════════════════════════════════════ */

test("4: /shop publishes its price in metadata now that the shop is live", () => {
  // INVERTED BY THE LAUNCH. While the shop could not sell, a price in
  // the description was a promise the page could not keep. It can keep
  // it now, and withholding it would cost a real shop its click.
  const description = shopHtml.match(/<meta name="description" content="([^"]*)"/);
  assert.ok(description, "/shop renders no meta description at all");
  assert.match(description[1], /\d{1,3},\d{2}\s*(€|Euro)/,
    `a live /shop withholds its price: ${description[1]}`);
  // The same sentence reaches the OpenGraph twin, so a link preview and
  // the page cannot disagree.
  const og = [...shopHtml.matchAll(/<meta property="og:description" content="([^"]*)"/g)];
  assert.ok(og.length > 0, "/shop renders no og:description");
  for (const m of og) {
    assert.match(m[1], /\d{1,3},\d{2}\s*(€|Euro)/,
      `og:description withholds the price: ${m[1]}`);
  }
  // And the delivered markup carries real prices again.
  const money = [...shopHtml.matchAll(/\d{1,3},\d{2}\s*(€|Euro)/g)].map(m => m[0]);
  assert.ok(money.length > 0, "a live /shop ships no price at all");
});

test("4b: the description is gated on the same flag as every visible price", () => {
  assert.match(slugPage, /import \{ PRICES_VISIBLE \} from "\.\.\/content";/);
  assert.match(slugPage, /const SHOP_DESCRIPTION = PRICES_VISIBLE/);
  // The live sentence was not deleted, only withheld.
  assert.match(slugPage, /const SHOP_DESCRIPTION_PRICE = "Ab \d{1,3},\d{2} Euro\.";/);
});

test("4c: the written-out price still matches the cheapest active variant", async () => {
  // The one number in this repository that is a price and cannot be read
  // from the catalog at render time. It is allowed to exist; it is not
  // allowed to drift from the shop it describes.
  const [thirty, fifty, hundred] = await Promise.all([
    getActiveVariantBySku("GLOA-MATCHA-30G"),
    getActiveVariantBySku("GLOA-MATCHA-50G"),
    getActiveVariantBySku("GLOA-MATCHA-100G"),
  ]);
  const lowest = Math.min(...[thirty, fifty, hundred].map(v => v.price_gross_cents));
  const written = slugPage.match(/const SHOP_DESCRIPTION_PRICE = "Ab (\d{1,3},\d{2}) Euro\.";/);
  assert.ok(written, "the price sentence could not be located");
  const writtenCents = Number(written[1].replace(",", ""));
  assert.equal(writtenCents, lowest,
    `/shop's description says ${written[1]} but the cheapest active variant is ${(lowest / 100).toFixed(2)}`);
});

test("4d: no purchasable Offer is published while the shop cannot sell", () => {
  for (const banned of ['"@type":"Offer"', '"@type":"Product"', '"@type": "Offer"', '"@type": "Product"']) {
    assert.ok(!shopHtml.includes(banned), `/shop publishes ${banned}`);
  }
  assert.ok(!/property="product:price/.test(shopHtml), "/shop publishes an OG price");
  assert.ok(!/itemprop="price"/.test(shopHtml), "/shop publishes a microdata price");
});

/* ══════════════════════════════════════════════════════════════
   5. NOTHING WAS TAKEN AWAY TO ACHIEVE ANY OF THIS
   ══════════════════════════════════════════════════════════════ */

test("5: the catalog still holds the real prices", async () => {
  for (const sku of ["GLOA-MATCHA-30G", "GLOA-MATCHA-50G", "GLOA-MATCHA-100G"]) {
    const variant = await getActiveVariantBySku(sku);
    assert.ok(Number.isSafeInteger(variant.price_gross_cents) && variant.price_gross_cents > 0,
      `${sku} lost its price`);
    assert.equal(variant.currency, "EUR");
    assert.equal(variant.is_active, true);
  }
});

test("5b: the server still prices from the catalog, and never from the client", () => {
  const quote = read("lib/checkoutQuote.ts");
  assert.match(quote, /unitGrossCents: variant\.price_gross_cents/);
  // No client-supplied money is read anywhere in the session route.
  for (const banned of ["body.price", "body.total", "body.amount", "unitPriceCents", "body.currency"]) {
    assert.ok(!sessionRoute.includes(banned), `the session route reads ${banned} from the request`);
  }
  // The gate did not replace any of the existing validation.
  for (const kept of ["validateQuoteItems(items)", "buildAuthoritativeQuote(validatedItems)",
                      "ALLOWED_SHIPPING_COUNTRIES.includes", "computeShippingGrossCents(",
                      "resolveCheckoutTax(", "idempotencyKey"]) {
    assert.ok(sessionRoute.includes(kept), `the gate removed ${kept}`);
  }
});

test("5c: the launch list is still open while the shop is not", async () => {
  const res = await fetch(`${BASE_URL}/launch`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(!/\d{1,3},\d{2}\s*(€|Euro)/.test(html), "/launch prints a price");
});

test("5d: paid orders are not gated - fulfillment must survive a closed shop", () => {
  // An order that was legitimately paid for has to be processed,
  // emailed and shipped whatever SHOP_STATUS says afterwards. The gate
  // belongs to the checkout entry point alone.
  for (const rel of ["app/api/stripe/webhook/route.ts", "lib/orderFulfillment.ts",
                     "lib/orderConfirmationEmail.ts", "lib/shipmentConfirmationEmail.ts",
                     "app/api/internal/orders/ship/route.ts", "app/api/orders/success/route.ts"]) {
    assert.ok(!read(rel).includes("shopAvailability"), `${rel} gates fulfillment on the shop status`);
  }
});
