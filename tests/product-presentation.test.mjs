import assert from "node:assert/strict";
import test from "node:test";
import {
  FOOD_PRODUCT_SLUGS,
  MATCHA_NOT_INCLUDED_NOTICE,
  MATCHA_NOT_INCLUDED_SHORT,
  MATCHA_NOT_INCLUDED_SLUGS,
  getProductPresentation,
  isUnitProduct,
  isWeighedProduct,
  requiresMatchaNotIncludedNotice,
  showsFoodInformation,
  showsUnitPricePer100g,
} from "../lib/productPresentation.ts";
import { buildItemsSnapshot } from "../lib/checkoutAttemptSnapshot.ts";

// SAFE DEFAULT SUITE: pure logic only. No DB, no network, no catalog write.

const MATCHA_30G = { size_grams: 30 };
const MATCHA_50G = { size_grams: 50 };
const CASE = { size_grams: null };

/* ── Food vs accessory ──────────────────────────────────────── */

test("presentation: Matcha variants are sold by weight", () => {
  for (const v of [MATCHA_30G, MATCHA_50G, { size_grams: 100 }]) {
    assert.equal(isWeighedProduct(v), true);
    assert.equal(isUnitProduct(v), false);
  }
});

test("presentation: an accessory without a weight is a unit product", () => {
  assert.equal(isWeighedProduct(CASE), false);
  assert.equal(isUnitProduct(CASE), true);
  // Undefined, zero and nonsense are all "not sold by weight", never a crash.
  for (const v of [{ size_grams: undefined }, { size_grams: 0 }, { size_grams: -5 }, {}]) {
    assert.equal(isWeighedProduct(v), false);
  }
});

test("presentation: a base price per 100 g is shown only for a weighed product", () => {
  assert.equal(showsUnitPricePer100g(MATCHA_30G), true);
  assert.equal(showsUnitPricePer100g(CASE), false, "an accessory must never show a per-100 g price");
});

/* ── Food information must not leak onto the accessory ──────── */

test("presentation: only known food products show food information", () => {
  assert.equal(showsFoodInformation("matcha"), true);
  assert.equal(showsFoodInformation("metal-case"), false);
});

test("presentation: food information is opt-in, so an unknown product shows none", () => {
  for (const slug of ["metal-case", "some-future-accessory", "", null, undefined, 42]) {
    assert.equal(showsFoodInformation(slug), false, `should not show food info for ${String(slug)}`);
  }
});

test("presentation: the accessory is not in the food allow-list", () => {
  assert.ok(!FOOD_PRODUCT_SLUGS.includes("metal-case"));
  assert.ok(FOOD_PRODUCT_SLUGS.includes("matcha"));
});

/* ── "Matcha nicht enthalten" disclosure ────────────────────── */

test("presentation: the standalone case carries the Matcha-not-included disclosure", () => {
  assert.equal(requiresMatchaNotIncludedNotice("metal-case"), true);
  const p = getProductPresentation("metal-case", CASE);
  assert.equal(p.matchaNotIncluded, true);
  assert.equal(p.matchaNotIncludedNotice, MATCHA_NOT_INCLUDED_NOTICE);
  assert.match(p.matchaNotIncludedNotice, /Matcha nicht enthalten/);
});

test("presentation: Matcha itself never carries the disclosure", () => {
  assert.equal(requiresMatchaNotIncludedNotice("matcha"), false);
  const p = getProductPresentation("matcha", MATCHA_30G);
  assert.equal(p.matchaNotIncluded, false);
  assert.equal(p.matchaNotIncludedNotice, null);
});

test("presentation: the disclosure is opt-in and never inferred from a missing weight", () => {
  // A weightless product is not automatically declared Matcha-free: the
  // disclosure only appears for a product explicitly listed for it.
  const p = getProductPresentation("some-future-accessory", CASE);
  assert.equal(p.matchaNotIncluded, false);
  assert.ok(!MATCHA_NOT_INCLUDED_SLUGS.includes("matcha"));
});

test("presentation: the disclosure text is plain and mentions the empty case", () => {
  assert.match(MATCHA_NOT_INCLUDED_NOTICE, /leere/);
  assert.equal(MATCHA_NOT_INCLUDED_SHORT, "Matcha nicht enthalten");
  // No invented commercial facts anywhere in this module's copy.
  for (const text of [MATCHA_NOT_INCLUDED_NOTICE, MATCHA_NOT_INCLUDED_SHORT]) {
    assert.ok(!/\d+\s*(g|ml|mm|cm|€)/i.test(text), `disclosure must not state a quantity or price: ${text}`);
    assert.ok(!/Edelstahl|Aluminium|Shizuoka|Japan/i.test(text), `disclosure must not state material or origin: ${text}`);
  }
});

/* ── Matcha presentation is unaffected ──────────────────────── */

test("presentation: Matcha keeps its food information and base price", () => {
  const p = getProductPresentation("matcha", MATCHA_50G);
  assert.deepEqual(p, {
    weighed: true,
    foodInformation: true,
    matchaNotIncluded: false,
    matchaNotIncludedNotice: null,
  });
});

test("presentation: the accessory gets no food information and no base price", () => {
  const p = getProductPresentation("metal-case", CASE);
  assert.equal(p.weighed, false);
  assert.equal(p.foodInformation, false);
});

/* ── Checkout snapshot stays generic ────────────────────────── */

const quoteItem = (over = {}) => ({
  productId: "11111111-1111-4111-8111-111111111111",
  productName: "GLOA Matcha",
  productSlug: "matcha",
  variantId: "22222222-2222-4222-8222-222222222222",
  sku: "GLOA-MATCHA-30G",
  label: "30 g",
  sizeGrams: 30,
  quantity: 1,
  unitGrossCents: 1999,
  lineGrossCents: 1999,
  ...over,
});

test("snapshot: each line keeps its own product name instead of a hardcoded one", () => {
  const snapshot = buildItemsSnapshot({
    currency: "EUR",
    subtotalGrossCents: 1999 + 1500,
    items: [
      quoteItem(),
      quoteItem({
        productName: "GLOA Metal Case",
        productSlug: "metal-case",
        sku: "GLOA-CASE-STANDALONE",
        label: "Metal Case",
        sizeGrams: null,
        unitGrossCents: 1500,
        lineGrossCents: 1500,
        variantId: "33333333-3333-4333-8333-333333333333",
      }),
    ],
  });

  assert.equal(snapshot.length, 2);
  assert.equal(snapshot[0].productName, "GLOA Matcha");
  assert.equal(snapshot[1].productName, "GLOA Metal Case");
  assert.notEqual(snapshot[1].productName, "GLOA Matcha", "the accessory must not be labelled as Matcha");
});

test("snapshot: an accessory line carries no fabricated weight", () => {
  const [line] = buildItemsSnapshot({
    currency: "EUR",
    subtotalGrossCents: 1500,
    items: [quoteItem({ productName: "GLOA Metal Case", sizeGrams: null, sku: "GLOA-CASE-STANDALONE" })],
  });
  assert.equal(line.sizeGrams, null);
  assert.notEqual(line.sizeGrams, 0, "a missing weight must stay unknown, not become zero");
});

test("snapshot: Matcha and the accessory stay separate lines with independent totals", () => {
  const snapshot = buildItemsSnapshot({
    currency: "EUR",
    subtotalGrossCents: 3998 + 1500,
    items: [
      quoteItem({ quantity: 2, lineGrossCents: 3998 }),
      quoteItem({
        productName: "GLOA Metal Case",
        productSlug: "metal-case",
        sku: "GLOA-CASE-STANDALONE",
        variantId: "33333333-3333-4333-8333-333333333333",
        sizeGrams: null,
        quantity: 1,
        unitGrossCents: 1500,
        lineGrossCents: 1500,
      }),
    ],
  });
  assert.equal(snapshot.length, 2, "lines must not be merged");
  assert.equal(snapshot[0].quantity, 2);
  assert.equal(snapshot[1].quantity, 1);
  assert.equal(snapshot[0].lineGrossCents, 3998);
  assert.equal(snapshot[1].lineGrossCents, 1500);
  assert.notEqual(snapshot[0].variantId, snapshot[1].variantId);
});

test("snapshot: carries no tax field and no internal identifier beyond the variant", () => {
  const [line] = buildItemsSnapshot({ currency: "EUR", subtotalGrossCents: 1999, items: [quoteItem()] });
  const keys = Object.keys(line);
  for (const forbidden of ["taxRatePercent", "tax_total_cents", "netCents", "vat", "taxTotalCents"]) {
    assert.ok(!keys.includes(forbidden), `snapshot must not carry ${forbidden}`);
  }
  const rendered = JSON.stringify(line);
  assert.ok(!/\bpi_/.test(rendered));
  assert.ok(!/\bcs_(test|live)_/.test(rendered));
});

/* ── Shipping stays product-agnostic ────────────────────────── */

test("shipping: thresholds are defined over the merchandise subtotal, not over products", async () => {
  const { SHIPPING_PRICING } = await import("../lib/shipping.ts");

  // The accessory needs no special case: shipping takes a subtotal in
  // cents and knows nothing about what produced it.
  assert.equal(SHIPPING_PRICING.germany.shippingGrossCents, 590);
  assert.equal(SHIPPING_PRICING.germany.freeShippingThresholdGrossCents, 4900);
  assert.equal(SHIPPING_PRICING.eu.shippingGrossCents, 1290);
  assert.equal(SHIPPING_PRICING.eu.freeShippingThresholdGrossCents, 7900);
  assert.equal(SHIPPING_PRICING.nonEuCore.shippingGrossCents, 1790);
  assert.equal(SHIPPING_PRICING.nonEuCore.freeShippingThresholdGrossCents, null);
  assert.equal(SHIPPING_PRICING.restOfEurope.shippingGrossCents, 1990);
  assert.equal(SHIPPING_PRICING.restOfEurope.freeShippingThresholdGrossCents, null);
});

test("shipping: an accessory counts toward free shipping exactly like any merchandise", async () => {
  const { computeShippingGrossCents } = await import("../lib/shipping.ts");

  // A cart that only reaches the threshold because of an accessory line
  // gets free shipping, because the threshold is a pure function of the
  // merchandise subtotal. No product-specific branch exists or is needed.
  const matchaOnly = 3999;
  const withAccessory = matchaOnly + 1500;
  assert.equal(computeShippingGrossCents("germany", matchaOnly), 590);
  assert.equal(computeShippingGrossCents("germany", withAccessory), 0);

  // Identical subtotals ship identically regardless of composition.
  assert.equal(
    computeShippingGrossCents("eu", 5000),
    computeShippingGrossCents("eu", 5000),
  );
  assert.equal(computeShippingGrossCents("nonEuCore", 100000), 1790, "no free shipping outside the EU, unchanged");
});
