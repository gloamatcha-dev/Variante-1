import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SHIPPING_PRICING,
  computeShippingGrossCents,
  getShippingZone,
} from "../lib/shipping.ts";

/**
 * THE PRICES GLOA ACTUALLY CHARGES.
 *
 * Migration 008 seeded the three Matcha variants at 19.99 / 29.99 /
 * 54.99. The decided prices are 14.99 / 22.99 / 39.99 - every seeded one
 * HIGHER than intended, by up to fifteen euros. Nobody was overcharged,
 * because the prelaunch gate refuses to create a checkout while
 * SHOP_STATUS is not "live"; 054 is what had to be true before that gate
 * is opened.
 *
 * ── WHAT THIS SUITE IS FOR ────────────────────────────────────
 *
 * product_variants.price_gross_cents is the SINGLE source every paying
 * path reads - public page, cart, authoritative quote, Stripe line
 * items, order snapshot, subscription price, annual plan. A number that
 * important should not live only in a production row where no test can
 * see it. This pins it in source control.
 *
 * ── AND WHAT IT MUST NOT CAUSE ────────────────────────────────
 *
 * Pinning the values here must never tempt anyone to hardcode them in
 * runtime commerce code. Section 3 asserts the opposite: the runtime
 * still reads the catalog, and no price constant exists beside it.
 *
 * SAFE: reads source and SQL and runs pure leaves. No database, no
 * network, no server, and it prices nothing in production.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf8");

const MIGRATION = "054_b2c_price_alignment.sql";
const migration = read(`supabase/migrations/${MIGRATION}`);
const sql = migration.replace(/^\s*--.*$/gm, "");
const seed = read("supabase/migrations/008_b2c_launch_products.sql");

/** The decided B2C catalog, in integer cents. */
const INTENDED = Object.freeze({
  "GLOA-MATCHA-30G": 1499,
  "GLOA-MATCHA-50G": 2299,
  "GLOA-MATCHA-100G": 3999,
});

/** What 008 seeded, and what 054 therefore expects to replace. */
const SEEDED = Object.freeze({
  "GLOA-MATCHA-30G": 1999,
  "GLOA-MATCHA-50G": 2999,
  "GLOA-MATCHA-100G": 5499,
});

/* ══════════════════════════════════════════════════════════════
   1. THE DECIDED PRICES, PINNED
   ══════════════════════════════════════════════════════════════ */

test("1: 054 sets exactly the three decided prices", () => {
  for (const [sku, cents] of Object.entries(INTENDED)) {
    assert.match(sql, new RegExp(
      `update public\\.product_variants\\s+set price_gross_cents = ${cents}\\s+where sku = '${sku}'`),
      `054 does not set ${sku} to ${cents}`);
  }
  // Exactly three price updates, so a fourth cannot ride along.
  const updates = [...sql.matchAll(/set price_gross_cents = (\d+)\s+where sku = '([A-Z0-9-]+)'/g)]
    .map(m => [m[2], Number(m[1])]);
  assert.equal(updates.length, 3, "054 updates a different number of prices");
  assert.deepEqual(Object.fromEntries(updates), INTENDED);
});

test("1b: each update is COMPARE-AND-SET, naming the value it replaces", () => {
  // A blind overwrite would silently revert a hand-correction somebody
  // made for a reason this migration does not know about.
  for (const sku of Object.keys(INTENDED)) {
    assert.match(sql, new RegExp(
      `where sku = '${sku}'\\s+and price_gross_cents = ${SEEDED[sku]};`),
      `${sku} is updated without checking the value it replaces`);
  }
});

test("1c: and the END STATE is proven before commit, so a partial correction aborts", () => {
  // Asserting the result rather than counting updates keeps it
  // idempotent: a second run changes nothing and still passes.
  assert.match(sql, /if v_wrong > 0 then[\s\S]*?raise exception/,
    "054 does not refuse when a price did not end up correct");
  assert.match(sql, /do not hold the intended price - the catalog drifted and was NOT overwritten/);
  // All three must exist - a missing SKU would satisfy a "none are
  // wrong" check vacuously.
  assert.match(sql, /if v_wrong <> 3 then[\s\S]*?raise exception '054: expected 3 B2C matcha variants/);
  // One transaction, so a half-corrected catalog cannot exist.
  assert.match(sql, /^\s*begin;/m);
  assert.match(sql, /^\s*commit;/m);
});

test("1d: SKU is the key - never the label, the weight or the product id", () => {
  // Renaming a variant or adding a 200 g size must not reprice anything.
  for (const banned of ["where label =", "where size_grams =", "where product_id =",
                        "where name =", "p.slug = 'matcha'"]) {
    assert.ok(!sql.includes(banned), `054 identifies a row by ${banned}`);
  }
});

/* ══════════════════════════════════════════════════════════════
   2. WHAT 054 MUST NOT TOUCH
   ══════════════════════════════════════════════════════════════ */

test("2: the Metal Case is not touched, and stays withheld", () => {
  assert.ok(!sql.includes("GLOA-CASE-01"), "054 touches the Metal Case");
  assert.ok(!/999/.test(sql.replace(/\d{4}/g, "")), "054 mentions the Metal Case price");
  // 047 is what withheld it, and 047 is not edited.
  const withhold = read("supabase/migrations/047_withhold_metal_case.sql");
  assert.match(withhold, /set is_active = false/);
});

test("2b: no column but the price moves", () => {
  const sets = [...sql.matchAll(/set ([a-z_]+) =/g)].map(m => m[1]);
  assert.deepEqual([...new Set(sets)], ["price_gross_cents"],
    "054 sets a column other than the price");
  for (const banned of ["is_active", "size_grams", "label", "sort_order", "currency", "product_id"]) {
    assert.ok(!new RegExp(`set[^;]*\\b${banned}\\b`).test(sql), `054 changes ${banned}`);
  }
});

test("2c: HISTORY IS NOT REPRICED", () => {
  // A catalog price governs future quotes. Every order already carries
  // its own unit_price_gross_cents and every attempt its own frozen
  // snapshot - rewriting either would change what a customer was
  // charged after the fact.
  for (const table of ["orders", "order_items", "checkout_attempts", "subscriptions",
                       "subscription_items", "annual_plan"]) {
    assert.ok(!sql.includes(table), `054 touches ${table}`);
  }
  assert.ok(!/delete|drop|truncate|alter table/i.test(sql), "054 is not a pure data correction");
});

test("2d: 008 is left exactly as it is", () => {
  // It is applied, and it records what was seeded. Rewriting it would
  // make the repository disagree with what existing orders were priced
  // against.
  for (const [sku, cents] of Object.entries(SEEDED)) {
    assert.ok(seed.includes(String(cents)), `008 no longer seeds ${sku} at ${cents}`);
  }
  for (const cents of Object.values(INTENDED)) {
    assert.ok(!seed.includes(String(cents)), `008 was rewritten to seed ${cents}`);
  }
  assert.match(migration, /008 IS NOT EDITED/);
});

test("2e: 054 is still the price migration, and adds no schema", () => {
  const files = readdirSync(path.join(ROOT, "supabase/migrations"))
    .filter(f => f.endsWith(".sql")).sort();
  // 057 SIMPLIFIED THE LAUNCH DISCOUNT: the one-use claim architecture
  // 056 built is removed, because the code became reusable. Re-pinned
  // rather than deleted - what this guard protects is that nothing
  // UNREVIEWED appeared. Reviewed in
  // tests/launch-discount-migration.test.mjs.
  assert.equal(files.length, 57);
  assert.equal(files[files.length - 4], MIGRATION,
    "054 is no longer where its own number puts it");
  assert.deepEqual(files.filter(f => Number(f.slice(0, 3)) > 57), [],
    "a migration 058 or beyond appeared");
  for (const banned of ["create table", "create function", "create policy",
                        "grant ", "revoke ", "add column"]) {
    assert.ok(!sql.toLowerCase().includes(banned), `054 does ${banned} - it is a data correction`);
  }
});

/* ══════════════════════════════════════════════════════════════
   3. THE RUNTIME STILL READS THE CATALOG
   ══════════════════════════════════════════════════════════════ */

test("3: NO PRICE IS HARDCODED IN RUNTIME COMMERCE CODE", () => {
  // The whole value of this correction is that there is ONE source. A
  // constant here would be a second one, and the two would drift.
  const RUNTIME = [
    "lib/checkoutQuote.ts", "lib/catalogProducts.ts", "lib/shipping.ts",
    "lib/tax.ts", "lib/annualPlans.ts", "lib/subscriptionCheckout.ts",
    "app/content.ts", "app/api/checkout/session/route.ts", "app/api/checkout/quote/route.ts",
  ];
  const prices = [...Object.values(INTENDED), ...Object.values(SEEDED)];
  for (const rel of RUNTIME) {
    let src;
    try { src = read(rel); } catch { continue; }
    // Comments may discuss a price; code may not contain one.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
    for (const cents of prices) {
      assert.ok(!new RegExp(`\\b${cents}\\b`).test(code),
        `${rel} hardcodes the price ${cents} - the catalog must stay the only source`);
    }
  }
});

test("3b: the authoritative quote still reads product_variants", () => {
  const quote = read("lib/checkoutQuote.ts");
  assert.match(quote, /\.from\("product_variants"\)/);
  assert.match(quote, /price_gross_cents/);
  // And the line total is computed from that column, not from anything
  // the caller sent.
  assert.match(quote, /variant\.price_gross_cents \* item\.quantity/);
});

test("3c: the checkout session prices from the frozen attempt, not the request", () => {
  const route = read("app/api/checkout/session/route.ts");
  assert.match(route, /unit_amount: item\.unitGrossCents/);
  // The body carries no money at all. 055 Phase B added `email` to it,
  // which is an identity and not an amount - every price below still
  // comes from the attempt's frozen snapshot.
  assert.match(route, /const \{ items, requestId, shippingCountry, email \} = body/);
  for (const banned of ["body.price", "body.total", "body.amount", "body.shipping", "body.tax", "body.discount"]) {
    assert.ok(!route.includes(banned), `the checkout accepts ${banned} from the browser`);
  }
});

test("3d: the annual plan derives from the catalog unit price", () => {
  const plans = read("lib/annualPlans.ts");
  assert.match(plans, /catalogUnitGrossCents/);
  assert.match(plans, /product_variants\.price_gross_cents/);
  // It supplies no default price of its own.
  assert.match(plans, /no plan\. Nothing here supplies a default size, a default discount or a/);
});

test("3e: a new subscription price is keyed on the amount it is created for", () => {
  // So a corrected catalog produces a NEW Stripe price for new
  // subscriptions rather than silently reusing one at the old amount.
  const recurring = read("lib/stripeRecurringPrice.ts");
  assert.match(recurring, /recurringPriceLookupKey\(kind: "sku" \| "shipping", identifier: string, unitAmountCents: number\)/);
  assert.match(recurring, /found\.unit_amount !== unitAmountCents/,
    "an existing price with a different amount is no longer refused");
});

/* ══════════════════════════════════════════════════════════════
   4. WHAT THE NEW PRICES MEAN FOR SHIPPING
   ══════════════════════════════════════════════════════════════ */

test("4: the free-shipping thresholds are untouched", () => {
  assert.equal(SHIPPING_PRICING.germany.shippingGrossCents, 590);
  assert.equal(SHIPPING_PRICING.germany.freeShippingThresholdGrossCents, 4900);
  assert.equal(SHIPPING_PRICING.eu.shippingGrossCents, 1290);
  assert.equal(SHIPPING_PRICING.eu.freeShippingThresholdGrossCents, 7900);
  assert.equal(SHIPPING_PRICING.nonEuCore.shippingGrossCents, 1790);
  assert.equal(SHIPPING_PRICING.nonEuCore.freeShippingThresholdGrossCents, null);
  assert.equal(SHIPPING_PRICING.restOfEurope.shippingGrossCents, 1990);
  assert.equal(SHIPPING_PRICING.restOfEurope.freeShippingThresholdGrossCents, null);
});

test("4b: the boundary moves because the prices did - German carts", () => {
  const de = getShippingZone("DE");
  const ship = (cents) => computeShippingGrossCents(de, cents);

  // What a cart of the NEW prices actually costs, and whether it ships
  // free. The threshold did not change; which carts reach it did.
  const p30 = INTENDED["GLOA-MATCHA-30G"];   // 1499
  const p50 = INTENDED["GLOA-MATCHA-50G"];   // 2299
  const p100 = INTENDED["GLOA-MATCHA-100G"]; // 3999

  assert.equal(ship(p30), 590, "one 30 g tin should not ship free");
  assert.equal(ship(p50), 590, "one 50 g tin should not ship free");
  assert.equal(ship(p100), 590, "one 100 g tin should not ship free - 39.99 is under 49");
  assert.equal(ship(p50 * 2), 590, "two 50 g (45.98) is still under the threshold");
  assert.equal(ship(p30 * 2 + p50), 0, "two 30 g + one 50 g (52.97) ships free");
  assert.equal(ship(p100 + p30), 0, "100 g + 30 g (54.98) ships free");
  assert.equal(ship(p30 * 4), 0, "four 30 g (59.96) ships free");

  // The exact boundary, independent of any product combination.
  assert.equal(ship(4899), 590, "one cent under the threshold must still charge");
  assert.equal(ship(4900), 0, "exactly the threshold must ship free");

  // UNDER THE OLD PRICES a single 100 g (54.99) shipped free; under the
  // new ones it does not. Asserted so the change is visible rather than
  // discovered by a customer.
  assert.equal(ship(SEEDED["GLOA-MATCHA-100G"]), 0, "the old 100 g price did reach the threshold");
  assert.equal(ship(p100), 590, "the new 100 g price does not");
});

test("4c: zones without a threshold never ship free, whatever the cart costs", () => {
  for (const country of ["CH", "GB", "NO"]) {
    const zone = getShippingZone(country);
    assert.equal(computeShippingGrossCents(zone, 100_000), 1790,
      `${country} shipped free on a large cart`);
  }
  const eu = getShippingZone("FR");
  assert.equal(computeShippingGrossCents(eu, 7899), 1290);
  assert.equal(computeShippingGrossCents(eu, 7900), 0);
});
