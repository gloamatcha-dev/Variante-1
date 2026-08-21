import assert from "node:assert/strict";
import test from "node:test";
import { ALLOWED_SHIPPING_COUNTRIES, getShippingZone, getDeliveryTimeLabel, getCountryLabel, SHIPPING_ZONES, SHIPPING_PRICING, computeShippingGrossCents } from "../lib/shipping.ts";

test("shipping: DE is an allowed shipping country", () => {
  assert.ok(ALLOWED_SHIPPING_COUNTRIES.includes("DE"));
});

test("shipping: IT (EU) is an allowed shipping country", () => {
  assert.ok(ALLOWED_SHIPPING_COUNTRIES.includes("IT"));
});

test("shipping: FR (EU) is an allowed shipping country", () => {
  assert.ok(ALLOWED_SHIPPING_COUNTRIES.includes("FR"));
});

test("shipping: GB is an allowed shipping country", () => {
  assert.ok(ALLOWED_SHIPPING_COUNTRIES.includes("GB"));
});

test("shipping: CH is an allowed shipping country", () => {
  assert.ok(ALLOWED_SHIPPING_COUNTRIES.includes("CH"));
});

test("shipping: NO is an allowed shipping country", () => {
  assert.ok(ALLOWED_SHIPPING_COUNTRIES.includes("NO"));
});

test("shipping: every EU member state is allowed", () => {
  const EU = ["AT","BE","BG","HR","CY","CZ","DK","EE","FI","FR","DE","GR","HU","IE","IT","LV","LT","LU","MT","NL","PL","PT","RO","SK","SI","ES","SE"];
  for (const code of EU) {
    assert.ok(ALLOWED_SHIPPING_COUNTRIES.includes(code), `expected ${code} to be an allowed shipping country`);
  }
});

test("shipping zones: countries map to the correct zone", () => {
  assert.equal(getShippingZone("DE"), "germany");
  assert.equal(getShippingZone("IT"), "eu");
  assert.equal(getShippingZone("FR"), "eu");
  assert.equal(getShippingZone("GB"), "nonEuCore");
  assert.equal(getShippingZone("CH"), "nonEuCore");
  assert.equal(getShippingZone("NO"), "nonEuCore");
  assert.equal(getShippingZone("IS"), "restOfEurope");
});

test("shipping zones: mapping is case-insensitive", () => {
  assert.equal(getShippingZone("de"), "germany");
  assert.equal(getShippingZone("gb"), "nonEuCore");
});

test("delivery time labels match exactly the confirmed copy", () => {
  assert.equal(SHIPPING_ZONES.germany.deliveryTimeLabel, "2-4 Werktage");
  assert.equal(SHIPPING_ZONES.eu.deliveryTimeLabel, "3-8 Werktage");
  assert.equal(SHIPPING_ZONES.nonEuCore.deliveryTimeLabel, "4-8 Werktage");
  assert.equal(SHIPPING_ZONES.restOfEurope.deliveryTimeLabel, "5-10 Werktage");

  assert.equal(getDeliveryTimeLabel("DE"), "2-4 Werktage");
  assert.equal(getDeliveryTimeLabel("FR"), "3-8 Werktage");
  assert.equal(getDeliveryTimeLabel("CH"), "4-8 Werktage");
  assert.equal(getDeliveryTimeLabel("RS"), "5-10 Werktage");
});

test("shipping: an unsupported/non-configured country is never treated as an enabled destination", () => {
  for (const code of ["US", "RU", "BY", "UA", "CN", "ZZ", "MD"]) {
    assert.equal(getShippingZone(code), null, `${code} must not resolve to a shipping zone`);
    assert.equal(getDeliveryTimeLabel(code), null, `${code} must not get a delivery-time label`);
    assert.ok(!ALLOWED_SHIPPING_COUNTRIES.includes(code), `${code} must not be in the Stripe allowed_countries list`);
  }
});

test("shipping: null/empty country never crashes and resolves to no zone", () => {
  assert.equal(getShippingZone(null), null);
  assert.equal(getShippingZone(undefined), null);
  assert.equal(getShippingZone(""), null);
});

test("shipping: sanctioned/unconfirmed countries are explicitly excluded from the zone list", () => {
  const allZoneCountries = Object.values(SHIPPING_ZONES).flatMap(z => z.countryCodes);
  assert.ok(!allZoneCountries.includes("RU"));
  assert.ok(!allZoneCountries.includes("BY"));
  assert.ok(!allZoneCountries.includes("UA"));
});

test("shipping: Moldova (MD) is not offered at launch (business decision, Task 23A)", () => {
  const allZoneCountries = Object.values(SHIPPING_ZONES).flatMap(z => z.countryCodes);
  assert.ok(!allZoneCountries.includes("MD"), "MD must not resolve to a shipping zone");
  assert.equal(getShippingZone("MD"), null);
  assert.ok(!ALLOWED_SHIPPING_COUNTRIES.includes("MD"), "MD must not be in the Stripe allowed_countries list");
});

test("country labels: known European codes get a German display name, not the raw code", () => {
  assert.equal(getCountryLabel("DE"), "Deutschland");
  assert.equal(getCountryLabel("GB"), "Vereinigtes Königreich");
  assert.equal(getCountryLabel("CH"), "Schweiz");
  assert.equal(getCountryLabel("NO"), "Norwegen");
  assert.equal(getCountryLabel("FR"), "Frankreich");
});

test("country labels: every allowed shipping country resolves to a real (non-code) label", () => {
  for (const code of ALLOWED_SHIPPING_COUNTRIES) {
    const label = getCountryLabel(code);
    assert.notEqual(label, code, `expected a real display name for ${code}, not the raw code`);
  }
});

test("country labels: an unmapped code falls back to the raw code instead of crashing", () => {
  assert.equal(getCountryLabel("ZZ"), "ZZ");
  assert.equal(getCountryLabel(null), "");
});

// ── Confirmed shipping prices (Task 20B) ──────────────────────────────

test("shipping pricing: confirmed per-zone prices and free-shipping thresholds", () => {
  assert.deepEqual(SHIPPING_PRICING.germany, { shippingGrossCents: 590, freeShippingThresholdGrossCents: 4900 });
  assert.deepEqual(SHIPPING_PRICING.eu, { shippingGrossCents: 1290, freeShippingThresholdGrossCents: 7900 });
  assert.deepEqual(SHIPPING_PRICING.nonEuCore, { shippingGrossCents: 1790, freeShippingThresholdGrossCents: null });
  assert.deepEqual(SHIPPING_PRICING.restOfEurope, { shippingGrossCents: 1990, freeShippingThresholdGrossCents: null });
});

test("computeShippingGrossCents: Germany below the free-shipping threshold charges 590", () => {
  assert.equal(computeShippingGrossCents("germany", 1999), 590);
  assert.equal(computeShippingGrossCents("germany", 4899), 590);
});

test("computeShippingGrossCents: Germany at or above the threshold is free (0, not null)", () => {
  assert.strictEqual(computeShippingGrossCents("germany", 4900), 0);
  assert.strictEqual(computeShippingGrossCents("germany", 9000), 0);
});

test("computeShippingGrossCents: EU below the free-shipping threshold charges 1290", () => {
  assert.equal(computeShippingGrossCents("eu", 1999), 1290);
  assert.equal(computeShippingGrossCents("eu", 7899), 1290);
});

test("computeShippingGrossCents: EU at or above the threshold is free", () => {
  assert.strictEqual(computeShippingGrossCents("eu", 7900), 0);
  assert.strictEqual(computeShippingGrossCents("eu", 20000), 0);
});

test("computeShippingGrossCents: CH/GB/NO (nonEuCore) always charge 1790 - no free shipping", () => {
  assert.equal(computeShippingGrossCents("nonEuCore", 1999), 1790);
  assert.equal(computeShippingGrossCents("nonEuCore", 1_000_000), 1790, "a huge order must still not be free - no threshold configured for this zone");
});

test("computeShippingGrossCents: restOfEurope always charges 1990 - no free shipping", () => {
  assert.equal(computeShippingGrossCents("restOfEurope", 1999), 1990);
  assert.equal(computeShippingGrossCents("restOfEurope", 1_000_000), 1990);
});

test("computeShippingGrossCents: free-shipping basis is the merchandise subtotal only, never subtotal+shipping (no circular threshold)", () => {
  // A merchandise subtotal just under threshold must not become "free"
  // by first adding the regular shipping price to it.
  const subtotalJustUnderThreshold = 4900 - 590 + 1; // 4311
  assert.equal(computeShippingGrossCents("germany", subtotalJustUnderThreshold), 590);
});
