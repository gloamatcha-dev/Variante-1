import assert from "node:assert/strict";
import test from "node:test";
import {
  TAX_CALCULATION_VERSION,
  TAX_CATEGORY_RATE_PERCENT,
  calculateCartTax,
  divideRoundHalfUp,
  extractTaxFromGross,
  resolveCheckoutTax,
  resolveTaxCategory,
  toTaxableCartItems,
} from "../lib/tax.ts";
import { resolveTaxJurisdiction } from "../lib/taxJurisdiction.ts";
import { computeShippingGrossCents } from "../lib/shipping.ts";

// SAFE DEFAULT SUITE: pure logic. No DB, no network, no Stripe.
//
// Tasks 21D / 21D.1. The confirmed customer-facing gross prices are fixed points
// throughout: 19,99 / 29,99 / 54,99 EUR for Matcha and 9,99 EUR for the
// standalone Metal Case. Every assertion below that touches a price
// checks the gross value is preserved, because tax is extracted FROM it
// and never added on top.

const MATCHA_30G = { variantId: "11111111-1111-4111-8111-111111111111", sku: "GLOA-MATCHA-30G", productSlug: "matcha", quantity: 1, unitGrossCents: 1999, lineGrossCents: 1999 };
const MATCHA_50G = { variantId: "22222222-2222-4222-8222-222222222222", sku: "GLOA-MATCHA-50G", productSlug: "matcha", quantity: 1, unitGrossCents: 2999, lineGrossCents: 2999 };
const MATCHA_100G = { variantId: "33333333-3333-4333-8333-333333333333", sku: "GLOA-MATCHA-100G", productSlug: "matcha", quantity: 1, unitGrossCents: 5499, lineGrossCents: 5499 };
const METAL_CASE = { variantId: "44444444-4444-4444-8444-444444444444", sku: "GLOA-CASE-01", productSlug: "metal-case", quantity: 1, unitGrossCents: 999, lineGrossCents: 999 };

const qty = (item, quantity) => ({ ...item, quantity, lineGrossCents: item.unitGrossCents * quantity });

/** Calculates for a destination, asserting the destination is taxable. */
function taxFor(country, items, shippingGrossCents) {
  const outcome = resolveCheckoutTax({
    jurisdictionResult: resolveTaxJurisdiction(country),
    items,
    shippingGrossCents,
  });
  assert.equal(outcome.kind, "calculated", `${country} should be taxable: ${outcome.reason ?? ""}`);
  return outcome.snapshot;
}

/* ── Rounding ───────────────────────────────────────────────── */

test("tax: division rounds half away from zero, deterministically", () => {
  assert.equal(divideRoundHalfUp(0, 107), 0);
  assert.equal(divideRoundHalfUp(1, 2), 1); // exactly .5 rounds up
  assert.equal(divideRoundHalfUp(3, 2), 2); // exactly 1.5 rounds up
  assert.equal(divideRoundHalfUp(4, 3), 1); // 1.33 rounds down
  assert.equal(divideRoundHalfUp(5, 3), 2); // 1.67 rounds up
  assert.equal(divideRoundHalfUp(107, 107), 1);
});

test("tax: division refuses inputs it cannot round exactly", () => {
  assert.throws(() => divideRoundHalfUp(1.5, 2), /safe integers/);
  assert.throws(() => divideRoundHalfUp(-1, 2), /non-negative/);
  assert.throws(() => divideRoundHalfUp(1, 0), /positive denominator/);
});

test("tax: gross always equals net plus tax, for every cent of every rate", () => {
  for (const ratePercent of [7, 19]) {
    for (let gross = 0; gross <= 2000; gross++) {
      const amount = extractTaxFromGross(gross, ratePercent);
      assert.equal(amount.grossCents, gross, `gross changed at ${gross}`);
      assert.equal(amount.netCents + amount.taxCents, gross, `net+tax != gross at ${gross}`);
      assert.ok(amount.netCents >= 0 && amount.taxCents >= 0, `negative component at ${gross}`);
    }
  }
});

test("tax: the confirmed German rates are 7 % for Matcha and 19 % for the Metal Case", () => {
  assert.deepEqual({ ...TAX_CATEGORY_RATE_PERCENT }, { matcha_reduced_de: 7, general_goods_de: 19 });
});

/* ── Classification ─────────────────────────────────────────── */

test("tax: every launch SKU is classified, by SKU and not by product name", () => {
  assert.equal(resolveTaxCategory({ sku: "GLOA-MATCHA-30G" }), "matcha_reduced_de");
  assert.equal(resolveTaxCategory({ sku: "GLOA-MATCHA-50G" }), "matcha_reduced_de");
  assert.equal(resolveTaxCategory({ sku: "GLOA-MATCHA-100G" }), "matcha_reduced_de");
  assert.equal(resolveTaxCategory({ sku: "GLOA-CASE-01" }), "general_goods_de");
  // A name is not an input at all - renaming a product cannot reclassify it.
  assert.equal(resolveTaxCategory({ sku: null, productSlug: null }), null);
});

test("tax: a new variant of a known product falls back to the product slug", () => {
  assert.equal(resolveTaxCategory({ sku: "GLOA-MATCHA-200G", productSlug: "matcha" }), "matcha_reduced_de");
  assert.equal(resolveTaxCategory({ sku: "GLOA-CASE-02", productSlug: "metal-case" }), "general_goods_de");
});

test("tax: an unclassified product has no category and is never given a default rate", () => {
  assert.equal(resolveTaxCategory({ sku: "GLOA-WHISK-01", productSlug: "bamboo-whisk" }), null);

  const outcome = resolveCheckoutTax({
    jurisdictionResult: resolveTaxJurisdiction("DE"),
    items: [{ variantId: "55555555-5555-4555-8555-555555555555", sku: "GLOA-WHISK-01", productSlug: "bamboo-whisk", quantity: 1, unitGrossCents: 2499, lineGrossCents: 2499 }],
    shippingGrossCents: 590,
  });
  assert.equal(outcome.kind, "blocked");
  assert.match(outcome.reason, /no tax category/);
});

/* ── Germany ────────────────────────────────────────────────── */

test("tax: Germany, Matcha at 7 %, gross prices unchanged and extraction exact", () => {
  const expected = [
    [MATCHA_30G, 1999, 1868, 131],
    [MATCHA_50G, 2999, 2803, 196],
    [MATCHA_100G, 5499, 5139, 360],
  ];
  for (const [item, gross, net, tax] of expected) {
    const snapshot = taxFor("DE", [item], 0);
    const line = snapshot.items[0];
    assert.equal(line.taxCategory, "matcha_reduced_de");
    assert.equal(line.taxRatePercent, 7);
    assert.equal(line.lineGrossCents, gross, "the customer-facing gross price must not move");
    assert.equal(line.lineNetCents, net);
    assert.equal(line.lineTaxCents, tax);
    assert.equal(snapshot.totals.totalGrossCents, gross);
  }
});

test("tax: Germany, standalone Metal Case at 19 %, gross price unchanged", () => {
  const snapshot = taxFor("DE", [METAL_CASE], 0);
  const line = snapshot.items[0];
  assert.equal(line.taxCategory, "general_goods_de");
  assert.equal(line.taxRatePercent, 19);
  assert.equal(line.lineGrossCents, 999);
  assert.equal(line.lineNetCents, 839);
  assert.equal(line.lineTaxCents, 160);
});

test("tax: Germany is a domestic supply, taxed independently of the EU mode", () => {
  const snapshot = taxFor("DE", [MATCHA_30G, METAL_CASE], 590);
  assert.equal(snapshot.treatment, "de_domestic");
  assert.equal(snapshot.taxCountry, "DE");
});

test("tax: line tax is taken from the line total, not from a multiplied-up unit price", () => {
  const snapshot = taxFor("DE", [qty(MATCHA_30G, 3)], 0);
  const line = snapshot.items[0];
  assert.equal(line.lineGrossCents, 5997);
  assert.equal(line.lineNetCents, 5605);
  assert.equal(line.lineTaxCents, 392);
  // The unit figures are display values and are allowed to disagree by a
  // cent or two - the line is what VAT is actually owed on.
  assert.equal(line.unitNetCents, 1868);
  assert.notEqual(line.unitNetCents * 3, line.lineNetCents);
  assert.equal(line.lineNetCents + line.lineTaxCents, line.lineGrossCents);
});

/* ── EU under the configured tax mode ───────────────────────── */

test("tax: IT, FR and NL are taxed at German rates under the configured mode", () => {
  for (const country of ["IT", "FR", "NL"]) {
    const snapshot = taxFor(country, [MATCHA_30G, METAL_CASE], 1290);
    assert.equal(snapshot.treatment, "de_origin_intra_eu", country);
    assert.equal(snapshot.taxCountry, "DE", country);
    assert.equal(snapshot.destinationCountry, country);
    assert.equal(snapshot.items.find(i => i.sku === "GLOA-MATCHA-30G").taxRatePercent, 7, country);
    assert.equal(snapshot.items.find(i => i.sku === "GLOA-CASE-01").taxRatePercent, 19, country);
    // Displayed gross is identical to the German case.
    assert.equal(snapshot.totals.subtotalGrossCents, 2998, country);
  }
});

test("tax: Monaco is taxed through the EU jurisdiction, not as a third country", () => {
  const snapshot = taxFor("MC", [MATCHA_50G], 1990);
  assert.equal(snapshot.jurisdictionKind, "eu");
  assert.equal(snapshot.destinationCountry, "MC");
  assert.equal(snapshot.vatCountry, "FR", "Monaco is EU VAT territory governed by France");
  assert.equal(snapshot.treatment, "de_origin_intra_eu");
  assert.equal(snapshot.taxCountry, "DE", "the configured mode still charges German VAT");
});

test("tax: an EU destination's displayed gross prices are the German ones", () => {
  const de = taxFor("DE", [MATCHA_100G, METAL_CASE], 0);
  const it = taxFor("IT", [MATCHA_100G, METAL_CASE], 0);
  assert.deepEqual(
    it.items.map(i => [i.sku, i.lineGrossCents, i.taxRatePercent]),
    de.items.map(i => [i.sku, i.lineGrossCents, i.taxRatePercent])
  );
  assert.equal(it.totals.taxTotalCents, de.totals.taxTotalCents);
});

/* ── Non-EU ─────────────────────────────────────────────────── */

test("tax: UK, Switzerland, Norway and third countries stay UNKNOWN, never German", () => {
  for (const country of ["GB", "CH", "NO", "LI", "IS", "RS", "AD"]) {
    const outcome = resolveCheckoutTax({
      jurisdictionResult: resolveTaxJurisdiction(country),
      items: [MATCHA_30G],
      shippingGrossCents: 1790,
    });
    assert.equal(outcome.kind, "not_implemented", country);
    assert.equal(outcome.snapshot, undefined, `${country} must produce no tax snapshot at all`);
  }
});

test("tax: an unknown country fails closed rather than becoming a taxable destination", () => {
  for (const country of ["US", "XX", "", null, undefined, "D", "DEU"]) {
    const outcome = resolveCheckoutTax({
      jurisdictionResult: resolveTaxJurisdiction(country),
      items: [MATCHA_30G],
      shippingGrossCents: 590,
    });
    assert.equal(outcome.kind, "blocked", String(country));
  }
});

/* ── Mixed cart ─────────────────────────────────────────────── */

test("tax: a mixed cart keeps two independent rates and never blends them", () => {
  const snapshot = taxFor("DE", [MATCHA_30G, METAL_CASE], 590);

  const matcha = snapshot.items.find(i => i.sku === "GLOA-MATCHA-30G");
  const metalCase = snapshot.items.find(i => i.sku === "GLOA-CASE-01");
  assert.equal(matcha.taxRatePercent, 7);
  assert.equal(metalCase.taxRatePercent, 19);

  // A basket-wide rate would produce exactly one breakdown row.
  assert.equal(snapshot.rateBreakdown.length, 2);
  assert.deepEqual(snapshot.rateBreakdown.map(r => r.taxRatePercent).sort((a, b) => a - b), [7, 19]);

  // Basket tax is the exact sum of the item and shipping tax, with no
  // rounding applied to the total on top of the parts.
  const itemTax = snapshot.items.reduce((sum, i) => sum + i.lineTaxCents, 0);
  const shippingTax = snapshot.shipping.allocations.reduce((sum, a) => sum + a.taxCents, 0);
  assert.equal(snapshot.totals.taxTotalCents, itemTax + shippingTax);
  assert.equal(snapshot.totals.totalNetCents + snapshot.totals.taxTotalCents, snapshot.totals.totalGrossCents);

  // And the per-rate breakdown adds back up to the same totals.
  assert.equal(snapshot.rateBreakdown.reduce((sum, r) => sum + r.taxCents, 0), snapshot.totals.taxTotalCents);
  assert.equal(snapshot.rateBreakdown.reduce((sum, r) => sum + r.netCents, 0), snapshot.totals.totalNetCents);
  assert.equal(snapshot.rateBreakdown.reduce((sum, r) => sum + r.grossCents, 0), snapshot.totals.totalGrossCents);
});

test("tax: a mixed cart's tax is not what a single blended rate would produce", () => {
  const snapshot = taxFor("DE", [MATCHA_30G, METAL_CASE], 0);
  const blendedAt7 = extractTaxFromGross(2998, 7).taxCents;
  const blendedAt19 = extractTaxFromGross(2998, 19).taxCents;
  assert.notEqual(snapshot.totals.subtotalTaxCents, blendedAt7);
  assert.notEqual(snapshot.totals.subtotalTaxCents, blendedAt19);
  assert.equal(snapshot.totals.subtotalTaxCents, 131 + 160);
});

/* ── Shipping apportionment ─────────────────────────────────── */

test("tax: shipping in a Matcha-only cart follows the reduced treatment", () => {
  const snapshot = taxFor("DE", [MATCHA_30G, qty(MATCHA_50G, 2)], 590);
  assert.equal(snapshot.shipping.allocations.length, 1);
  const [share] = snapshot.shipping.allocations;
  assert.equal(share.taxCategory, "matcha_reduced_de");
  assert.equal(share.taxRatePercent, 7);
  assert.equal(share.grossCents, 590);
  assert.deepEqual([share.netCents, share.taxCents], [extractTaxFromGross(590, 7).netCents, extractTaxFromGross(590, 7).taxCents]);
});

test("tax: shipping in a Case-only cart follows the standard treatment", () => {
  const snapshot = taxFor("DE", [qty(METAL_CASE, 3)], 590);
  assert.equal(snapshot.shipping.allocations.length, 1);
  const [share] = snapshot.shipping.allocations;
  assert.equal(share.taxCategory, "general_goods_de");
  assert.equal(share.taxRatePercent, 19);
  assert.equal(share.grossCents, 590);
});

test("tax: shipping in a mixed cart is apportioned by merchandise net value", () => {
  // Matcha net 1868, Case net 839, total 2707; shipping 590 gross.
  //   Matcha share 590 * 1868 / 2707 = 407.14 -> 407
  //   Case   share 590 *  839 / 2707 = 182.86 -> 183 (largest remainder)
  const snapshot = taxFor("DE", [MATCHA_30G, METAL_CASE], 590);
  const byCategory = Object.fromEntries(snapshot.shipping.allocations.map(a => [a.taxCategory, a]));
  assert.equal(byCategory.matcha_reduced_de.grossCents, 407);
  assert.equal(byCategory.general_goods_de.grossCents, 183);
  assert.equal(byCategory.matcha_reduced_de.taxRatePercent, 7);
  assert.equal(byCategory.general_goods_de.taxRatePercent, 19);
  assert.equal(byCategory.matcha_reduced_de.grossCents + byCategory.general_goods_de.grossCents, 590);
});

test("tax: the rounding remainder is handed to a deterministic winner", () => {
  // 590 splits 407.14 / 182.86: the Case share has the larger fractional
  // remainder, so it is the one that gains the odd cent. Re-running must
  // give the same answer every time.
  for (let run = 0; run < 5; run++) {
    const snapshot = taxFor("DE", [MATCHA_30G, METAL_CASE], 590);
    const byCategory = Object.fromEntries(snapshot.shipping.allocations.map(a => [a.taxCategory, a.grossCents]));
    assert.deepEqual(byCategory, { matcha_reduced_de: 407, general_goods_de: 183 });
  }
});

test("tax: apportioned shipping conserves the charge exactly, for every cart and every zone", () => {
  const carts = [
    [MATCHA_30G],
    [METAL_CASE],
    [MATCHA_30G, METAL_CASE],
    [MATCHA_100G, qty(METAL_CASE, 2)],
    [qty(MATCHA_30G, 7), METAL_CASE],
    [MATCHA_30G, MATCHA_50G, MATCHA_100G, qty(METAL_CASE, 4)],
  ];
  // Every shipping price the shop can actually charge, plus every value
  // from 0 to 100 cents to hammer the remainder path.
  const charges = [0, 590, 1290, 1790, 1990, ...Array.from({ length: 101 }, (_, i) => i)];

  for (const cart of carts) {
    for (const shippingGrossCents of charges) {
      const snapshot = taxFor("DE", cart, shippingGrossCents);
      const allocatedGross = snapshot.shipping.allocations.reduce((sum, a) => sum + a.grossCents, 0);
      assert.equal(allocatedGross, shippingGrossCents, `lost or invented a cent at ${shippingGrossCents}`);
      for (const share of snapshot.shipping.allocations) {
        assert.equal(share.netCents + share.taxCents, share.grossCents);
        assert.ok(share.grossCents >= 0);
      }
      assert.equal(snapshot.shipping.netCents + snapshot.shipping.taxCents, shippingGrossCents);
      assert.equal(
        snapshot.totals.totalGrossCents,
        cart.reduce((sum, item) => sum + item.lineGrossCents, 0) + shippingGrossCents
      );
      assert.equal(snapshot.totals.totalNetCents + snapshot.totals.taxTotalCents, snapshot.totals.totalGrossCents);
    }
  }
});

test("tax: free shipping produces no shipping tax and no phantom allocation", () => {
  // 3 x 100 g clears the German free-shipping threshold.
  const cart = [qty(MATCHA_100G, 3)];
  const shippingGrossCents = computeShippingGrossCents("germany", cart[0].lineGrossCents);
  assert.equal(shippingGrossCents, 0);

  const snapshot = taxFor("DE", cart, shippingGrossCents);
  assert.deepEqual(snapshot.shipping.allocations, []);
  assert.equal(snapshot.shipping.netCents, 0);
  assert.equal(snapshot.shipping.taxCents, 0);
  assert.equal(snapshot.totals.totalGrossCents, cart[0].lineGrossCents);
});

/* ── Server authority ───────────────────────────────────────── */

test("tax: the calculation reads only catalog identity, never a client-supplied rate", () => {
  // A cart item carrying hostile extra fields must be ignored entirely.
  const hostile = {
    ...METAL_CASE,
    taxRatePercent: 0,
    taxCategory: "matcha_reduced_de",
    netCents: 999,
    taxCents: 0,
    taxTotalCents: 0,
  };
  const snapshot = taxFor("DE", [hostile], 590);
  assert.equal(snapshot.items[0].taxRatePercent, 19, "a client-supplied rate must not be honoured");
  assert.equal(snapshot.items[0].taxCategory, "general_goods_de");
  assert.equal(snapshot.items[0].lineTaxCents, 160);
});

test("tax: the quote mapping carries only catalog identity into the calculation", () => {
  const quote = {
    currency: "EUR",
    subtotalGrossCents: 1999,
    items: [{
      productId: "p1",
      productName: "GLOA Matcha",
      productSlug: "matcha",
      variantId: MATCHA_30G.variantId,
      sku: "GLOA-MATCHA-30G",
      label: "30 g",
      sizeGrams: 30,
      quantity: 1,
      unitGrossCents: 1999,
      lineGrossCents: 1999,
      // Fields a hostile client might hope survive the mapping.
      taxRatePercent: 0,
      netCents: 1999,
    }],
  };
  assert.deepEqual(toTaxableCartItems(quote), [{
    variantId: MATCHA_30G.variantId,
    sku: "GLOA-MATCHA-30G",
    productSlug: "matcha",
    quantity: 1,
    unitGrossCents: 1999,
    lineGrossCents: 1999,
  }]);
});

test("tax: an empty cart and a negative shipping charge are refused", () => {
  const jurisdictionResult = resolveTaxJurisdiction("DE");
  assert.equal(calculateCartTax({ jurisdiction: jurisdictionResult.jurisdiction, treatment: "de_domestic", items: [], shippingGrossCents: 0 }).ok, false);
  assert.equal(calculateCartTax({ jurisdiction: jurisdictionResult.jurisdiction, treatment: "de_domestic", items: [MATCHA_30G], shippingGrossCents: -1 }).ok, false);
});

test("tax: the calculation version is recorded on every snapshot", () => {
  assert.equal(taxFor("DE", [MATCHA_30G], 590).calculationVersion, TAX_CALCULATION_VERSION);
  assert.equal(taxFor("IT", [MATCHA_30G], 1290).calculationVersion, TAX_CALCULATION_VERSION);
  assert.match(TAX_CALCULATION_VERSION, /^de-\d{4}\.\d+$/);
});
