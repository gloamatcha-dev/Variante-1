import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  B2B_BERLIN_ELIGIBILITY_VERSION,
  B2B_DELIVERY_COUNTRY,
  BERLIN_POSTCODE_RANGES,
  isBerlinPostcode,
  normalizeB2bPostcode,
  resolveB2bBerlinEligibility,
} from "../lib/b2bBerlinEligibility.ts";
import {
  B2B_SHIPPING_RULES_VERSION,
  DHL_DE_TARIFFS,
  DHL_TARIFF_SOURCE,
  parcelFitsWithin,
  parcelGirthMm,
  resolveB2bShipping,
  shipmentWeightGrams,
  validatePackagingMeasurement,
} from "../lib/b2bShippingRules.ts";
// The Package 1 authority, imported so "no second opinion about pack
// weight" is asserted rather than trusted to a comment.
import { B2B_PACK_GRAMS, B2B_SELF_SERVICE_MAX_PACKS } from "../lib/b2bPricingRules.ts";
// The one country normaliser, imported so the reuse is provable.
import { normalizeCountryCode } from "../lib/shipping.ts";

// SAFE DEFAULT SUITE: pure logic plus a little source inspection.
// No database, no network, no Stripe, no clock.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf-8");

/** The repository's comment stripper. The modules NAME what they refuse. */
const withoutComments = source => source
  .split(/\r?\n/)
  .filter(line => {
    const t = line.trim();
    return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*") && !t.startsWith("--");
  })
  .join("\n");

const berlinCode = () => withoutComments(read("lib/b2bBerlinEligibility.ts"));
const shippingCode = () => withoutComments(read("lib/b2bShippingRules.ts"));

/** A complete, obviously-fictional measurement profile for the fit tests. */
const measured = over => ({
  packTareGrams: 60,
  outerPackagingGrams: 400,
  lengthMm: 400,
  widthMm: 250,
  heightMm: 120,
  ...over,
});

const BERLIN = { country: "DE", postcode: "10115" };
const NON_BERLIN_DE = { country: "DE", postcode: "80331" };

/* ══════════════════════════════════════════════════════════════
   1. BERLIN: COUNTRY NORMALISATION
   ══════════════════════════════════════════════════════════════ */

test("1: DE and Deutschland both normalise to Germany", () => {
  for (const country of ["DE", "de", " DE ", "Deutschland", "deutschland", " Deutschland "]) {
    const result = resolveB2bBerlinEligibility({ country, postcode: "10115" });
    assert.equal(result.normalizedCountry, "DE", `${JSON.stringify(country)} did not normalise`);
    assert.equal(result.eligible, true, `${JSON.stringify(country)} was not eligible`);
  }
});

test("1b: the normalisation is lib/shipping.ts's, not a private copy", () => {
  // Proven two ways: the module imports it, and the results agree on
  // every form the address table can hold.
  assert.ok(/import \{ normalizeCountryCode \} from "\.\/shipping\.ts"/.test(read("lib/b2bBerlinEligibility.ts")),
    "the Berlin module no longer reuses the shared normaliser");
  for (const country of ["DE", "Deutschland", "FR", "Frankreich", "XX", "", "  ", null, undefined]) {
    const expected = typeof country === "string" ? normalizeCountryCode(country) : null;
    assert.equal(resolveB2bBerlinEligibility({ country, postcode: "10115" }).normalizedCountry, expected,
      `disagreement on ${JSON.stringify(country)}`);
  }
});

test("1c: a foreign country with a Berlin postcode is never eligible", () => {
  for (const country of ["FR", "Frankreich", "AT", "NL", "US", "XX", "", null, undefined, 42, {}]) {
    const result = resolveB2bBerlinEligibility({ country, postcode: "10115" });
    assert.equal(result.eligible, false, `${JSON.stringify(country)} + 10115 was eligible`);
    assert.equal(result.reason, "country_not_germany");
  }
});

test("1d: country is checked before postcode, so the reason names the real problem", () => {
  const result = resolveB2bBerlinEligibility({ country: "FR", postcode: "nonsense" });
  assert.equal(result.reason, "country_not_germany");
});

/* ══════════════════════════════════════════════════════════════
   2. BERLIN: POSTCODE
   ══════════════════════════════════════════════════════════════ */

test("2: the approved range is 10115 to 14199 inclusive", () => {
  assert.deepEqual(BERLIN_POSTCODE_RANGES.map(r => [r.from, r.to]), [[10115, 14199]]);
  assert.equal(B2B_DELIVERY_COUNTRY, "DE");
  assert.equal(B2B_BERLIN_ELIGIBILITY_VERSION, "berlin-2026.1");
});

test("2b: both boundaries are inside, both neighbours are outside", () => {
  assert.equal(isBerlinPostcode("10115"), true, "lower boundary excluded");
  assert.equal(isBerlinPostcode("14199"), true, "upper boundary excluded");
  assert.equal(isBerlinPostcode("10114"), false, "below the range was accepted");
  assert.equal(isBerlinPostcode("14200"), false, "above the range was accepted");
});

test("2c: the approved examples resolve exactly as agreed", () => {
  const eligible = [
    { country: "DE", postcode: "10115" },
    { country: "Deutschland", postcode: "10999" },
    { country: "DE", postcode: "14199" },
    { country: "DE", postcode: "11011" }, // Berlin large-customer postcode
  ];
  for (const address of eligible) {
    assert.equal(resolveB2bBerlinEligibility(address).eligible, true, JSON.stringify(address));
  }
  const notEligible = [
    { country: "DE", postcode: "14467" }, // Potsdam
    { country: "DE", postcode: "14532" }, // Kleinmachnow
    { country: "DE", postcode: "80331" }, // Munich
    { country: "FR", postcode: "10115" },
  ];
  for (const address of notEligible) {
    assert.equal(resolveB2bBerlinEligibility(address).eligible, false, JSON.stringify(address));
  }
});

test("2d: a postcode is exactly five digits or it is nothing - never repaired", () => {
  for (const good of ["10115", "14199", " 10115 ", "00000"]) {
    assert.equal(normalizeB2bPostcode(good), good.trim(), `${JSON.stringify(good)} was rejected`);
  }
  for (const bad of ["1011", "101150", "1234", "0123", "1011a", "10 115", "10115-1",
                     "", "   ", "abcde", "Berlin", null, undefined, 10115, {}, [], NaN]) {
    assert.equal(normalizeB2bPostcode(bad), null, `${JSON.stringify(bad)} was accepted or repaired`);
  }
  // Specifically: a four-digit value is NOT zero-padded into Berlin.
  assert.equal(normalizeB2bPostcode("1115"), null);
  assert.equal(isBerlinPostcode("1115"), false);
});

test("2e: a German address with a malformed postcode is refused, and says why", () => {
  for (const postcode of ["", "   ", "abc", "1011", null, undefined, 10115]) {
    const result = resolveB2bBerlinEligibility({ country: "DE", postcode });
    assert.equal(result.eligible, false);
    assert.equal(result.reason, "postcode_malformed", `${JSON.stringify(postcode)}`);
    assert.equal(result.normalizedPostcode, null);
  }
});

test("2f: a German non-Berlin postcode is refused with its own distinct reason", () => {
  const result = resolveB2bBerlinEligibility({ country: "DE", postcode: "80331" });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, "postcode_outside_berlin");
  assert.equal(result.normalizedPostcode, "80331");
});

test("2g: exhaustive sweep of the boundary neighbourhood", () => {
  for (let code = 10100; code <= 14220; code += 1) {
    const postcode = String(code).padStart(5, "0");
    const expected = code >= 10115 && code <= 14199;
    assert.equal(isBerlinPostcode(postcode), expected, `${postcode}`);
  }
});

/* ══════════════════════════════════════════════════════════════
   3. BERLIN: THE CITY FIELD IS NOT AN INPUT
   ══════════════════════════════════════════════════════════════ */

test("3: city text cannot make an address eligible", () => {
  for (const city of ["Berlin", "BERLIN", "berlin", "Berlin-Mitte", "Hamburg"]) {
    const result = resolveB2bBerlinEligibility({ country: "DE", postcode: "80331", city });
    assert.equal(result.eligible, false, `city ${city} created eligibility`);
  }
});

test("3b: city text cannot make an eligible postcode ineligible", () => {
  for (const city of ["Hamburg", "", "München", "Potsdam", null, undefined]) {
    const result = resolveB2bBerlinEligibility({ country: "DE", postcode: "10115", city });
    assert.equal(result.eligible, true, `city ${String(city)} destroyed eligibility`);
  }
});

test("3c: the rule is structurally blind to city - it is not a parameter", () => {
  const source = berlinCode();
  assert.ok(!/\bcity\b/.test(source), "the Berlin rule now reads a city field");
  // The decision is byte-identical with and without the field present.
  assert.deepEqual(
    resolveB2bBerlinEligibility({ country: "DE", postcode: "10115" }),
    resolveB2bBerlinEligibility({ country: "DE", postcode: "10115", city: "Hamburg" })
  );
});

/* ══════════════════════════════════════════════════════════════
   4. THE SNAPSHOT SHAPE
   ══════════════════════════════════════════════════════════════ */

test("4: the result carries everything a frozen snapshot needs", () => {
  assert.deepEqual(resolveB2bBerlinEligibility({ country: "Deutschland", postcode: " 10115 " }), {
    eligible: true,
    reason: "eligible",
    normalizedCountry: "DE",
    normalizedPostcode: "10115",
    rulesVersion: "berlin-2026.1",
  });
});

/* ══════════════════════════════════════════════════════════════
   5. DHL TARIFFS ARE CARRIER RETAIL GROSS PRICES
   ══════════════════════════════════════════════════════════════ */

test("5: the three launch tariffs carry the verified retail amounts", () => {
  const byCode = Object.fromEntries(DHL_DE_TARIFFS.map(t => [t.productCode, t]));
  assert.equal(byCode.DHL_PAKET_2KG.carrierRetailGrossCents, 619);
  assert.equal(byCode.DHL_PAKET_2KG.maxWeightGrams, 2000);
  assert.deepEqual(byCode.DHL_PAKET_2KG.maxDimensionsMm, { lengthMm: 600, widthMm: 300, heightMm: 150 });
  assert.equal(byCode.DHL_PAKET_2KG.onlineOnly, true);
  // No girth limit is STATED for the 2 kg product. Null records that,
  // and its 600 x 300 x 150 cap makes 1500 mm the worst case anyway.
  assert.equal(byCode.DHL_PAKET_2KG.maxGirthMm, null);

  assert.equal(byCode.DHL_PAKET_5KG.carrierRetailGrossCents, 769);
  assert.equal(byCode.DHL_PAKET_5KG.maxWeightGrams, 5000);
  assert.equal(byCode.DHL_PAKET_5KG.maxGirthMm, 3000);
  assert.deepEqual(byCode.DHL_PAKET_5KG.maxDimensionsMm, { lengthMm: 1200, widthMm: 600, heightMm: 600 });

  assert.equal(byCode.DHL_PAKET_10KG.carrierRetailGrossCents, 1049);
  assert.equal(byCode.DHL_PAKET_10KG.maxWeightGrams, 10000);
  assert.equal(byCode.DHL_PAKET_10KG.maxGirthMm, 3000);
  assert.deepEqual(byCode.DHL_PAKET_10KG.maxDimensionsMm, { lengthMm: 1200, widthMm: 600, heightMm: 600 });
});

test("5b: tariffs are ordered cheapest-first, so resolution picks the cheapest fit", () => {
  const weights = DHL_DE_TARIFFS.map(t => t.maxWeightGrams);
  const prices = DHL_DE_TARIFFS.map(t => t.carrierRetailGrossCents);
  assert.deepEqual(weights, [...weights].sort((a, b) => a - b));
  assert.deepEqual(prices, [...prices].sort((a, b) => a - b));
});

test("5c: provenance is recorded as data and the validity date is NOT invented", () => {
  assert.equal(DHL_TARIFF_SOURCE.carrier, "DHL");
  assert.equal(DHL_TARIFF_SOURCE.market, "DE");
  assert.equal(DHL_TARIFF_SOURCE.priceBasis, "carrier_retail_end_price_including_vat");
  assert.equal(DHL_TARIFF_SOURCE.recordedOn, "2026-09-23");
  assert.equal(DHL_TARIFF_SOURCE.effectiveFrom, null,
    "a carrier validity date was invented");
});

/* ══════════════════════════════════════════════════════════════
   6. THE GROSS / NET GUARD
   ══════════════════════════════════════════════════════════════ */

test("6: 619, 769 and 1049 are never named as a net or billing amount", () => {
  const source = shippingCode();
  for (const forbidden of ["shippingNetCents", "netCents", "customerShippingNetCents",
                           "shippingGrossCents", "billingNetCents", "invoiceNetCents"]) {
    assert.ok(!source.includes(forbidden),
      `the tariff authority exposes ${forbidden}, which reads as a customer billing amount`);
  }
  // The one name the amounts DO carry says carrier, retail and gross.
  assert.ok(source.includes("carrierRetailGrossCents"));
  for (const amount of ["619", "769", "1049"]) {
    assert.ok(source.includes(amount), `${amount} left the tariff table`);
  }
});

test("6b: every amount the module exposes is on a carrierRetail-named field", () => {
  for (const tariff of DHL_DE_TARIFFS) {
    const moneyKeys = Object.keys(tariff).filter(k => /cents$/i.test(k));
    assert.deepEqual(moneyKeys, ["carrierRetailGrossCents"],
      `a tariff carries an unexpected money field: ${moneyKeys.join(", ")}`);
  }
  const resolved = resolveB2bShipping({ packs: 1, address: NON_BERLIN_DE, measurement: measured() });
  const moneyKeys = Object.keys(resolved).filter(k => /cents$/i.test(k));
  assert.deepEqual(moneyKeys, ["carrierRetailGrossCents"]);
});

test("6c: no VAT determination is made anywhere in this package", () => {
  // The letters "vat" DO appear, once, inside the string
  // "carrier_retail_end_price_including_vat" - which is the label saying
  // these are not GLOA's numbers. Banning the word would ban the
  // disclaimer. What must be absent is a tax CALCULATION, so that is
  // what this checks.
  for (const [name, source] of [["shipping", shippingCode()], ["berlin", berlinCode()]]) {
    for (const forbidden of ["extractTaxFromGross", "addTaxToNet", "divideRoundHalfUp",
                             "tax_snapshot", "taxRatePercent", "TAX_CATEGORY", "TAX_CALCULATION"]) {
      assert.ok(!source.includes(forbidden), `${name} calls a tax helper: ${forbidden}`);
    }
    assert.ok(!/from "\.\/tax(\.ts)?"/.test(source), `${name} imports the tax authority`);
    // No rate arithmetic in any of its usual disguises.
    assert.ok(!/\b(7|19)\s*%/.test(source), `${name} states a VAT rate`);
    assert.ok(!/[*/]\s*(107|119|1\.07|1\.19|0\.07|0\.19)\b/.test(source),
      `${name} performs rate arithmetic`);
  }
});

test("6d: neither module reaches a database, Stripe, the network, env or a clock", () => {
  for (const [name, source] of [["berlin", berlinCode()], ["shipping", shippingCode()]]) {
    for (const forbidden of ["supabase", "Stripe", "stripe", "process.env", "fetch(",
                             "Date.now", "new Date", ".from(", ".rpc(", "useState"]) {
      assert.ok(!source.includes(forbidden), `${name} reaches for ${forbidden}`);
    }
  }
});

/* ══════════════════════════════════════════════════════════════
   7. SHIPMENT WEIGHT
   ══════════════════════════════════════════════════════════════ */

test("7: shipment weight is Matcha plus tare plus outer packaging", () => {
  const m = measured({ packTareGrams: 60, outerPackagingGrams: 400 });
  assert.equal(shipmentWeightGrams(1, m), 1 * (500 + 60) + 400);   // 960
  assert.equal(shipmentWeightGrams(4, m), 4 * (500 + 60) + 400);   // 2640
  assert.equal(shipmentWeightGrams(10, m), 10 * (500 + 60) + 400); // 6000
});

test("7b: the 500 g comes from the Package 1 authority, not from a literal", () => {
  assert.equal(B2B_PACK_GRAMS, 500);
  const m = measured({ packTareGrams: 0, outerPackagingGrams: 0 });
  for (let packs = 1; packs <= B2B_SELF_SERVICE_MAX_PACKS; packs += 1) {
    assert.equal(shipmentWeightGrams(packs, m), packs * B2B_PACK_GRAMS);
  }
  // And the shipping module does not restate the pack weight.
  const source = shippingCode();
  assert.ok(source.includes("B2B_PACK_GRAMS"), "the shipping module stopped importing the pack weight");
  assert.ok(!/\b500\b/.test(source.replace(/B2B_PACK_GRAMS/g, "")),
    "the shipping module restates 500 g as a literal");
});

test("7c: an invalid pack count is refused by the Package 1 authority", () => {
  const m = measured();
  for (const bad of [0, 11, 1.5, -1, NaN, "4", null, undefined]) {
    assert.throws(() => shipmentWeightGrams(bad, m), /self-service pack count/, `${String(bad)}`);
  }
});

/* ══════════════════════════════════════════════════════════════
   8. MEASUREMENTS FAIL CLOSED
   ══════════════════════════════════════════════════════════════ */

test("8: a complete measured profile validates", () => {
  const result = validatePackagingMeasurement(measured());
  assert.equal(result.ok, true);
  assert.deepEqual(result.measurement, measured());
});

test("8b: a missing profile fails closed, and names why", () => {
  for (const bad of [undefined, null, 0, "", "profile", 42, true, []]) {
    const result = validatePackagingMeasurement(bad);
    assert.equal(result.ok, false, `${JSON.stringify(bad)} validated`);
  }
  assert.equal(validatePackagingMeasurement(undefined).reason, "measurement_missing");
  assert.equal(validatePackagingMeasurement(null).reason, "measurement_missing");
});

test("8c: a missing tare fails closed", () => {
  const m = measured();
  delete m.packTareGrams;
  const result = validatePackagingMeasurement(m);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "pack_tare_invalid");
});

test("8d: a missing outer packaging weight fails closed", () => {
  const m = measured();
  delete m.outerPackagingGrams;
  const result = validatePackagingMeasurement(m);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "outer_packaging_invalid");
});

test("8e: negative and non-integer measurements are refused, never rounded", () => {
  for (const bad of [-1, -0.5, 60.5, NaN, Infinity, "60", null]) {
    assert.equal(validatePackagingMeasurement(measured({ packTareGrams: bad })).reason,
      "pack_tare_invalid", `tare ${String(bad)}`);
    assert.equal(validatePackagingMeasurement(measured({ outerPackagingGrams: bad })).reason,
      "outer_packaging_invalid", `packaging ${String(bad)}`);
  }
});

test("8f: a zero weight is a measurement, a zero dimension is not a parcel", () => {
  assert.equal(validatePackagingMeasurement(measured({ packTareGrams: 0, outerPackagingGrams: 0 })).ok, true);
  for (const axis of ["lengthMm", "widthMm", "heightMm"]) {
    assert.equal(validatePackagingMeasurement(measured({ [axis]: 0 })).reason, "dimensions_invalid", axis);
    assert.equal(validatePackagingMeasurement(measured({ [axis]: -1 })).reason, "dimensions_invalid", axis);
    assert.equal(validatePackagingMeasurement(measured({ [axis]: 12.5 })).reason, "dimensions_invalid", axis);
    const m = measured();
    delete m[axis];
    assert.equal(validatePackagingMeasurement(m).reason, "dimensions_invalid", axis);
  }
});

test("8g: NO placeholder measurement exists anywhere in the module", () => {
  const source = shippingCode();
  for (const invented of ["packTareGrams = ", "outerPackagingGrams = ",
                          "DEFAULT_TARE", "SAFETY_MARGIN", "FILLER_GRAMS", "CARTON"]) {
    assert.ok(!source.includes(invented), `a measurement was invented: ${invented}`);
  }
  // And no carton strategy was assumed for any pack range.
  assert.ok(!/1-3|4-6|7-10|smallCarton|mediumCarton|largeCarton/i.test(source),
    "an unapproved carton strategy entered the resolver");
});

/* ══════════════════════════════════════════════════════════════
   9. DIMENSIONS
   ══════════════════════════════════════════════════════════════ */

const TWO_KG_MAX = { lengthMm: 600, widthMm: 300, heightMm: 150 };

test("9: a parcel inside the maximum fits, one outside does not", () => {
  assert.equal(parcelFitsWithin({ lengthMm: 600, widthMm: 300, heightMm: 150 }, TWO_KG_MAX), true);
  assert.equal(parcelFitsWithin({ lengthMm: 400, widthMm: 250, heightMm: 120 }, TWO_KG_MAX), true);
  assert.equal(parcelFitsWithin({ lengthMm: 601, widthMm: 300, heightMm: 150 }, TWO_KG_MAX), false);
  assert.equal(parcelFitsWithin({ lengthMm: 700, widthMm: 100, heightMm: 100 }, TWO_KG_MAX), false);
});

test("9b: axis ordering cannot change the answer", () => {
  const edges = [150, 600, 300];
  const permutations = [
    [0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0],
  ];
  for (const [a, b, c] of permutations) {
    const parcel = { lengthMm: edges[a], widthMm: edges[b], heightMm: edges[c] };
    assert.equal(parcelFitsWithin(parcel, TWO_KG_MAX), true, JSON.stringify(parcel));
  }
  // The same holds for a box that does NOT fit, whichever way it is read.
  const tooLong = [700, 100, 100];
  for (const [a, b, c] of permutations) {
    const parcel = { lengthMm: tooLong[a], widthMm: tooLong[b], heightMm: tooLong[c] };
    assert.equal(parcelFitsWithin(parcel, TWO_KG_MAX), false, JSON.stringify(parcel));
  }
});

/* ══════════════════════════════════════════════════════════════
   10. RESOLUTION
   ══════════════════════════════════════════════════════════════ */

test("10: Berlin resolves to free local delivery without any measurement", () => {
  const result = resolveB2bShipping({ packs: 10, address: BERLIN });
  assert.equal(result.mode, "berlin_local");
  assert.equal(result.chargeStatus, "free_local_delivery");
  assert.equal(result.carrierRetailGrossCents, 0);
  assert.equal(result.berlin.eligible, true);
  assert.equal(result.packs, 10);
  assert.equal(result.rulesVersion, "dhl-de-2026.1");
  assert.equal(result.berlinEligibilityVersion, "berlin-2026.1");
  // Explicitly: no measurement was supplied and none was needed.
  assert.ok(!("shipmentWeightGrams" in result));
});

test("10b: a German non-Berlin address without measurements fails closed", () => {
  const result = resolveB2bShipping({ packs: 4, address: NON_BERLIN_DE });
  assert.equal(result.mode, "dhl");
  assert.equal(result.chargeStatus, "measurement_required");
  assert.equal(result.reason, "measurement_missing");
  // The crucial property: no amount at all, not a zero and not a 619.
  assert.ok(!("carrierRetailGrossCents" in result));
});

test("10c: a light, compact parcel resolves to the 2 kg product", () => {
  // 2 packs: 2 x 560 + 400 = 1520 g, inside 600 x 300 x 150.
  const result = resolveB2bShipping({
    packs: 2, address: NON_BERLIN_DE,
    measurement: measured({ lengthMm: 400, widthMm: 250, heightMm: 120 }),
  });
  assert.equal(result.chargeStatus, "carrier_reference_resolved");
  assert.equal(result.shipmentWeightGrams, 1520);
  assert.equal(result.dhlProductCode, "DHL_PAKET_2KG");
  assert.equal(result.carrierRetailGrossCents, 619);
  assert.equal(result.maxWeightGrams, 2000);
});

test("10d: a parcel too BULKY for the 2 kg product moves up, despite its weight", () => {
  // Same 1520 g, but 700 mm long - outside 600 x 300 x 150.
  const result = resolveB2bShipping({
    packs: 2, address: NON_BERLIN_DE,
    measurement: measured({ lengthMm: 700, widthMm: 400, heightMm: 300 }),
  });
  assert.equal(result.chargeStatus, "carrier_reference_resolved");
  assert.equal(result.shipmentWeightGrams, 1520);
  assert.equal(result.dhlProductCode, "DHL_PAKET_5KG",
    "a bulky light parcel was quoted the 2 kg price the carrier would refuse");
  assert.equal(result.carrierRetailGrossCents, 769);
});

test("10e: over 5 kg but within 10 kg resolves to the 10 kg product", () => {
  // 10 packs: 10 x 560 + 400 = 6000 g.
  const result = resolveB2bShipping({
    packs: 10, address: NON_BERLIN_DE,
    measurement: measured({ lengthMm: 500, widthMm: 400, heightMm: 300 }),
  });
  assert.equal(result.shipmentWeightGrams, 6000);
  assert.equal(result.dhlProductCode, "DHL_PAKET_10KG");
  assert.equal(result.carrierRetailGrossCents, 1049);
});

test("10f: a parcel beyond every supported product fails closed, with the reason", () => {
  const tooHeavy = resolveB2bShipping({
    packs: 10, address: NON_BERLIN_DE,
    measurement: measured({ packTareGrams: 400, outerPackagingGrams: 2000, lengthMm: 500, widthMm: 400, heightMm: 300 }),
  });
  assert.equal(tooHeavy.chargeStatus, "unsupported_shipment");
  assert.equal(tooHeavy.reason, "over_max_weight");
  assert.equal(tooHeavy.shipmentWeightGrams, 11000);
  assert.ok(!("carrierRetailGrossCents" in tooHeavy));

  const tooBig = resolveB2bShipping({
    packs: 1, address: NON_BERLIN_DE,
    measurement: measured({ lengthMm: 1300, widthMm: 700, heightMm: 700 }),
  });
  assert.equal(tooBig.chargeStatus, "unsupported_shipment");
  assert.equal(tooBig.reason, "over_max_dimensions");
});

test("10g: a non-German destination is an explicit unsupported country", () => {
  for (const country of ["FR", "Frankreich", "AT", "NL", "US", "XX", null, undefined]) {
    const result = resolveB2bShipping({
      packs: 4, address: { country, postcode: "10115" }, measurement: measured(),
    });
    assert.equal(result.mode, "unsupported", `${String(country)}`);
    assert.equal(result.chargeStatus, "unsupported_country");
    // Never priced, never Berlin, never a German fallback.
    assert.ok(!("carrierRetailGrossCents" in result));
    assert.ok(!("dhlProductCode" in result));
  }
});

test("10h: an invalid quantity fails closed before anything else is decided", () => {
  for (const packs of [0, 11, 12, 1.5, -1, NaN, "4", null, undefined]) {
    const result = resolveB2bShipping({ packs, address: BERLIN, measurement: measured() });
    assert.equal(result.mode, "unsupported", `${String(packs)}`);
    assert.equal(result.chargeStatus, "unsupported_quantity");
    assert.equal(result.packs, null);
    assert.equal(result.berlin, null, "an address was evaluated for an invalid quantity");
  }
});

test("10i: every supported quantity resolves on both paths", () => {
  for (let packs = 1; packs <= B2B_SELF_SERVICE_MAX_PACKS; packs += 1) {
    const berlin = resolveB2bShipping({ packs, address: BERLIN });
    assert.equal(berlin.chargeStatus, "free_local_delivery", `${packs} packs in Berlin`);

    const dhl = resolveB2bShipping({
      packs, address: NON_BERLIN_DE,
      measurement: measured({ lengthMm: 500, widthMm: 400, heightMm: 300 }),
    });
    assert.equal(dhl.chargeStatus, "carrier_reference_resolved", `${packs} packs by DHL`);
    assert.equal(dhl.shipmentWeightGrams, packs * 560 + 400);
    assert.ok([619, 769, 1049].includes(dhl.carrierRetailGrossCents));
  }
});

test("10j: a German address with a malformed postcode still goes down the carrier path", () => {
  // It is not Berlin, so it is a parcel. The postcode problem is the
  // caller's to surface; this file does not guess a delivery mode.
  const result = resolveB2bShipping({ packs: 1, address: { country: "DE", postcode: "" }, measurement: measured() });
  assert.equal(result.mode, "dhl");
  assert.equal(result.berlin.reason, "postcode_malformed");
});

test("10k: every resolution carries both rule versions for the future snapshot", () => {
  const cases = [
    { packs: 1, address: BERLIN },
    { packs: 1, address: NON_BERLIN_DE },
    { packs: 1, address: NON_BERLIN_DE, measurement: measured() },
    { packs: 0, address: BERLIN },
    { packs: 1, address: { country: "FR", postcode: "10115" } },
  ];
  for (const input of cases) {
    const result = resolveB2bShipping(input);
    assert.equal(result.rulesVersion, B2B_SHIPPING_RULES_VERSION, JSON.stringify(input));
    assert.equal(result.berlinEligibilityVersion, B2B_BERLIN_ELIGIBILITY_VERSION);
  }
});

/* ══════════════════════════════════════════════════════════════
   11. BOUNDARY
   ══════════════════════════════════════════════════════════════ */

test("11: B2C shipping is untouched and still owns its own rules", () => {
  const b2c = read("lib/shipping.ts");
  assert.ok(b2c.includes("computeShippingGrossCents"), "the B2C shipping module changed shape");
  assert.ok(!b2c.includes("b2b"), "B2B leaked into the B2C shipping authority");
  assert.ok(!b2c.includes("DHL"), "a carrier tariff entered the B2C shipping authority");
});

test("11b: no checkout, invoice, UI, admin or email came with this package", () => {
  for (const source of [shippingCode(), berlinCode()]) {
    for (const forbidden of ["checkout", "Checkout", "invoice", "Invoice",
                             "resend", "Resend", "admin", "Admin", "className", "useState"]) {
      assert.ok(!source.includes(forbidden), `the package reaches into ${forbidden}`);
    }
  }
});

/* ══════════════════════════════════════════════════════════════
   12. GIRTH - THE CONSTRAINT THE THREE AXES DO NOT IMPLY
   ══════════════════════════════════════════════════════════════ */

/** 4 packs: 4 x (500 + 60) + 400 = 2640 g. Past the 2 kg product. */
const GIRTH_PACKS = 4;
const GIRTH_WEIGHT = 2640;

/** The six ways of writing the same box. */
const PERMUTATIONS = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];

test("12: the girth formula is length + 2 x width + 2 x height", () => {
  assert.equal(parcelGirthMm({ lengthMm: 1200, widthMm: 600, heightMm: 600 }), 3600);
  assert.equal(parcelGirthMm({ lengthMm: 1200, widthMm: 450, heightMm: 450 }), 3000);
  assert.equal(parcelGirthMm({ lengthMm: 1199, widthMm: 451, heightMm: 450 }), 3001);
  assert.equal(parcelGirthMm({ lengthMm: 400, widthMm: 250, heightMm: 120 }), 1140);
});

test("12b: the longest edge is the length, whichever axis it was written on", () => {
  const edges = [450, 1200, 500];
  const expected = 1200 + 2 * 500 + 2 * 450; // 3100
  for (const [a, b, c] of PERMUTATIONS) {
    assert.equal(
      parcelGirthMm({ lengthMm: edges[a], widthMm: edges[b], heightMm: edges[c] }),
      expected,
      `permutation ${a}${b}${c}`
    );
  }
});

/* A. The defect this correction exists for. */
test("12c: 1200 x 600 x 600 is inside every axis and STILL fails on girth", () => {
  const dims = { lengthMm: 1200, widthMm: 600, heightMm: 600 };
  // Every individual axis sits exactly on the 120 x 60 x 60 cm maximum.
  assert.equal(parcelFitsWithin(dims, { lengthMm: 1200, widthMm: 600, heightMm: 600 }), true);
  // And the girth is 600 mm over.
  assert.equal(parcelGirthMm(dims), 3600);

  const result = resolveB2bShipping({
    packs: GIRTH_PACKS, address: NON_BERLIN_DE, measurement: measured(dims),
  });
  assert.equal(result.chargeStatus, "unsupported_shipment");
  assert.equal(result.reason, "over_max_girth");
  assert.equal(result.girthMm, 3600);
  assert.equal(result.shipmentWeightGrams, GIRTH_WEIGHT);
  // Never quoted, and never promoted to a larger product to make it fit.
  assert.ok(!("carrierRetailGrossCents" in result));
  assert.ok(!("dhlProductCode" in result));
});

/* B. The boundary is inclusive. */
test("12d: a parcel at exactly 3000 mm of girth is accepted", () => {
  const dims = { lengthMm: 1200, widthMm: 450, heightMm: 450 };
  assert.equal(parcelGirthMm(dims), 3000);

  const result = resolveB2bShipping({
    packs: GIRTH_PACKS, address: NON_BERLIN_DE, measurement: measured(dims),
  });
  assert.equal(result.chargeStatus, "carrier_reference_resolved");
  assert.equal(result.dhlProductCode, "DHL_PAKET_5KG");
  assert.equal(result.carrierRetailGrossCents, 769);
  assert.equal(result.girthMm, 3000);
  assert.equal(result.maxGirthMm, 3000);
});

/* C. One millimetre past it fails closed. */
test("12e: a parcel at 3001 mm of girth fails closed", () => {
  const dims = { lengthMm: 1199, widthMm: 451, heightMm: 450 };
  // Still inside every axis of the 5 kg / 10 kg maximum.
  assert.equal(parcelFitsWithin(dims, { lengthMm: 1200, widthMm: 600, heightMm: 600 }), true);
  assert.equal(parcelGirthMm(dims), 3001);

  const result = resolveB2bShipping({
    packs: GIRTH_PACKS, address: NON_BERLIN_DE, measurement: measured(dims),
  });
  assert.equal(result.chargeStatus, "unsupported_shipment");
  assert.equal(result.reason, "over_max_girth");
  assert.equal(result.girthMm, 3001);
});

/* D. Rotation cannot bypass the check. */
test("12f: axis permutation cannot get a girth-breaching parcel accepted", () => {
  const edges = [1200, 500, 550]; // girth 1200 + 1100 + 1000 = 3300
  for (const [a, b, c] of PERMUTATIONS) {
    const dims = { lengthMm: edges[a], widthMm: edges[b], heightMm: edges[c] };
    const result = resolveB2bShipping({
      packs: GIRTH_PACKS, address: NON_BERLIN_DE, measurement: measured(dims),
    });
    assert.equal(result.chargeStatus, "unsupported_shipment", JSON.stringify(dims));
    assert.equal(result.reason, "over_max_girth", JSON.stringify(dims));
    assert.equal(result.girthMm, 3300);
  }
});

test("12g: and permutation cannot make a compliant parcel fail either", () => {
  const edges = [1200, 400, 450]; // girth 1200 + 900 + 800 = 2900
  for (const [a, b, c] of PERMUTATIONS) {
    const dims = { lengthMm: edges[a], widthMm: edges[b], heightMm: edges[c] };
    const result = resolveB2bShipping({
      packs: GIRTH_PACKS, address: NON_BERLIN_DE, measurement: measured(dims),
    });
    assert.equal(result.chargeStatus, "carrier_reference_resolved", JSON.stringify(dims));
    assert.equal(result.dhlProductCode, "DHL_PAKET_5KG");
    assert.equal(result.girthMm, 2900);
  }
});

/* E. The pre-existing promotion still works when the girth is compliant. */
test("12h: too bulky for the 2 kg product but girth-compliant still resolves to 5 kg", () => {
  const dims = { lengthMm: 700, widthMm: 400, heightMm: 300 };
  assert.equal(parcelGirthMm(dims), 2100);

  const result = resolveB2bShipping({
    packs: 2, address: NON_BERLIN_DE, measurement: measured(dims),
  });
  assert.equal(result.chargeStatus, "carrier_reference_resolved");
  assert.equal(result.shipmentWeightGrams, 1520);
  assert.equal(result.dhlProductCode, "DHL_PAKET_5KG",
    "the girth check broke the existing dimension-promotion case");
  assert.equal(result.carrierRetailGrossCents, 769);
});

/* F. Berlin never consults a carrier rule. */
test("12i: Berlin local delivery is unaffected by girth, even at 3600 mm", () => {
  const dims = { lengthMm: 1200, widthMm: 600, heightMm: 600 };
  assert.equal(parcelGirthMm(dims), 3600);

  for (const measurement of [undefined, measured(dims)]) {
    const result = resolveB2bShipping({ packs: GIRTH_PACKS, address: BERLIN, measurement });
    assert.equal(result.mode, "berlin_local");
    assert.equal(result.chargeStatus, "free_local_delivery");
    assert.equal(result.carrierRetailGrossCents, 0);
    assert.ok(!("girthMm" in result), "a carrier constraint leaked into local delivery");
  }
});

test("12j: the three refusal reasons stay distinguishable", () => {
  // Too heavy for every product: weight decides, before girth.
  const tooHeavy = resolveB2bShipping({
    packs: 10, address: NON_BERLIN_DE,
    measurement: measured({ packTareGrams: 400, outerPackagingGrams: 2000,
                            lengthMm: 1200, widthMm: 600, heightMm: 600 }),
  });
  assert.equal(tooHeavy.reason, "over_max_weight");

  // An edge beyond 1200 mm: dimensions, not girth.
  const tooLong = resolveB2bShipping({
    packs: GIRTH_PACKS, address: NON_BERLIN_DE,
    measurement: measured({ lengthMm: 1300, widthMm: 200, heightMm: 200 }),
  });
  assert.equal(tooLong.reason, "over_max_dimensions");

  // Every axis fine, girth not.
  const tooFat = resolveB2bShipping({
    packs: GIRTH_PACKS, address: NON_BERLIN_DE,
    measurement: measured({ lengthMm: 1200, widthMm: 600, heightMm: 600 }),
  });
  assert.equal(tooFat.reason, "over_max_girth");
});

test("12k: no larger DHL product was added to absorb girth failures", () => {
  const codes = DHL_DE_TARIFFS.map(t => t.productCode);
  assert.deepEqual(codes, ["DHL_PAKET_2KG", "DHL_PAKET_5KG", "DHL_PAKET_10KG"]);
  const source = shippingCode();
  for (const forbidden of ["20KG", "31_5", "31.5", "SPERRGUT", "oversize", "girthSurcharge"]) {
    assert.ok(!source.includes(forbidden), `an unapproved product entered the table: ${forbidden}`);
  }
});
