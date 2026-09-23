import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  NET_ORIGIN_TAX_CALCULATION_VERSION,
  TAX_CALCULATION_VERSION,
  TAX_CATEGORY_RATE_PERCENT,
  addTaxToNet,
  calculateCartTax,
  divideRoundHalfUp,
  extractTaxFromGross,
  netOriginTaxMetadata,
  resolveTaxCategory,
} from "../lib/tax.ts";
import { resolveTaxJurisdiction } from "../lib/taxJurisdiction.ts";
// The Package 1 authority, so the B2B fixtures below are the real
// contract amounts rather than numbers retyped into a test.
import {
  PACK_NET_CENTS,
  annualProductNetCents,
  monthlyProductNetCents,
} from "../lib/b2bPricingRules.ts";

// SAFE DEFAULT SUITE: pure arithmetic plus a little source inspection.
// No database, no network, no Stripe, no clock.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf-8");

/** The two German rates this shop actually uses. */
const MATCHA = TAX_CATEGORY_RATE_PERCENT.matcha_reduced_de;   // 7
const STANDARD = TAX_CATEGORY_RATE_PERCENT.general_goods_de;  // 19

/* ══════════════════════════════════════════════════════════════
   1. THE RATES COME FROM THE EXISTING AUTHORITY
   ══════════════════════════════════════════════════════════════ */

test("1: no second B2B rate table was created", () => {
  assert.equal(MATCHA, 7);
  assert.equal(STANDARD, 19);
  // The B2B packages must not carry a rate of their own.
  for (const rel of ["lib/b2bPricingRules.ts", "lib/b2bShippingRules.ts"]) {
    const source = read(rel);
    assert.ok(!source.includes("TAX_CATEGORY_RATE_PERCENT"), `${rel} restates the rate table`);
  }
});

test("1b: the existing product mapping is untouched", () => {
  assert.equal(resolveTaxCategory({ sku: "GLOA-MATCHA-500G", productSlug: "matcha" }), "matcha_reduced_de");
  assert.equal(resolveTaxCategory({ sku: "GLOA-CASE-01", productSlug: "metal-case" }), "general_goods_de");
});

/* ══════════════════════════════════════════════════════════════
   2. VERSIONING - THE B2C LINE IS NOT MOVED
   ══════════════════════════════════════════════════════════════ */

test("2: the gross-origin version is exactly what it was", () => {
  assert.equal(TAX_CALCULATION_VERSION, "de-2026.1",
    "the B2C calculation version was changed while adding B2B support");
});

test("2b: the net-origin path has its own version, and they are different", () => {
  assert.equal(NET_ORIGIN_TAX_CALCULATION_VERSION, "de-net-2026.1");
  assert.notEqual(NET_ORIGIN_TAX_CALCULATION_VERSION, TAX_CALCULATION_VERSION);
});

test("2c: net-origin metadata names both facts, and is not shared state", () => {
  const first = netOriginTaxMetadata();
  assert.deepEqual(first, { calculationVersion: "de-net-2026.1", priceOrigin: "net" });
  const second = netOriginTaxMetadata();
  assert.notEqual(first, second, "callers share one mutable metadata object");
  first.priceOrigin = "gross";
  assert.equal(netOriginTaxMetadata().priceOrigin, "net", "the metadata was mutable from outside");
});

test("2d: priceOrigin was NOT added to the existing cart snapshot", () => {
  const jurisdiction = resolveTaxJurisdiction("DE").jurisdiction;
  const result = calculateCartTax({
    jurisdiction,
    treatment: "de_domestic",
    items: [{
      variantId: "v1", sku: "GLOA-MATCHA-50G", productSlug: "matcha",
      quantity: 1, unitGrossCents: 2299, lineGrossCents: 2299,
    }],
    shippingGrossCents: 590,
  });
  assert.equal(result.ok, true);
  // A historical record that gains a key is no longer the record that
  // was frozen. Package 4 carries the origin beside the B2B amounts.
  assert.ok(!("priceOrigin" in result.snapshot), "priceOrigin leaked into the B2C snapshot");
  assert.equal(result.snapshot.calculationVersion, "de-2026.1");
});

/* ══════════════════════════════════════════════════════════════
   3. THE APPROVED B2B FIXTURES
   ══════════════════════════════════════════════════════════════ */

test("3: the four agreed Matcha fixtures come out exactly", () => {
  const FIXTURES = [
    [5250, 368, 5618],
    [10500, 735, 11235],
    [15750, 1103, 16853],
    [21000, 1470, 22470],
  ];
  for (const [net, tax, gross] of FIXTURES) {
    const result = addTaxToNet(net, MATCHA);
    assert.equal(result.netCents, net);
    assert.equal(result.taxCents, tax, `${net} net produced the wrong tax`);
    assert.equal(result.grossCents, gross, `${net} net produced the wrong gross`);
    assert.equal(result.taxRatePercent, 7);
  }
});

test("3b: those fixtures ARE the Package 1 contract amounts, not retyped numbers", () => {
  assert.equal(PACK_NET_CENTS, 5250);
  assert.equal(monthlyProductNetCents(1), 5250);
  assert.equal(monthlyProductNetCents(2), 10500);
  assert.equal(monthlyProductNetCents(3), 15750);
  assert.equal(monthlyProductNetCents(4), 21000);
});

test("3c: every Package 1 monthly and annual amount taxes cleanly", () => {
  for (let packs = 1; packs <= 10; packs += 1) {
    for (const net of [monthlyProductNetCents(packs), annualProductNetCents(packs)]) {
      const r = addTaxToNet(net, MATCHA);
      assert.equal(r.netCents + r.taxCents, r.grossCents, `${net} net does not reconcile`);
      assert.ok(Number.isSafeInteger(r.taxCents) && r.taxCents >= 0);
    }
  }
  // The headline annual figure, spelled out: 5.355,00 net -> 5.729,85 gross.
  const biggest = addTaxToNet(annualProductNetCents(10), MATCHA);
  assert.equal(biggest.netCents, 535500);
  assert.equal(biggest.taxCents, 37485);
  assert.equal(biggest.grossCents, 572985);
});

/* ══════════════════════════════════════════════════════════════
   4. ROUNDING - THE HALF CENT
   ══════════════════════════════════════════════════════════════ */

test("4: a half cent rounds UP, and the tax is the remainder", () => {
  // 5250 * 7 / 100 = 367,5 exactly. Half up gives 368, never 367.
  assert.equal(divideRoundHalfUp(5250 * 7, 100), 368);
  const r = addTaxToNet(5250, MATCHA);
  assert.equal(r.taxCents, 368);
  assert.equal(r.grossCents, 5618);
  assert.notEqual(r.taxCents, 367, "the half cent rounded down");
});

test("4b: the gross is rounded once - tax is derived, never rounded separately", () => {
  // If tax were rounded independently the two could disagree. Sweep the
  // band where a half cent arises most often and prove they never do.
  for (const rate of [MATCHA, STANDARD]) {
    for (let net = 0; net <= 50000; net += 1) {
      const r = addTaxToNet(net, rate);
      assert.equal(r.grossCents, divideRoundHalfUp(net * (100 + rate), 100), `${net}@${rate}`);
      assert.equal(r.taxCents, r.grossCents - r.netCents, `${net}@${rate}`);
    }
  }
});

test("4c: no floating-point money entered the authority", () => {
  const source = read("lib/tax.ts");
  const added = source.slice(source.indexOf("export function addTaxToNet"));
  assert.ok(!/Math\.round|toFixed|parseFloat/.test(added.slice(0, 600)),
    "a float rounding call entered addTaxToNet");
  assert.ok(added.includes("divideRoundHalfUp"), "addTaxToNet stopped using the shared primitive");
});

/* ══════════════════════════════════════════════════════════════
   5. INVARIANTS
   ══════════════════════════════════════════════════════════════ */

test("5: net + tax = gross, gross >= net, tax >= 0, integers only", () => {
  for (const rate of [0, MATCHA, STANDARD]) {
    for (let net = 0; net <= 100000; net += 7) {
      const r = addTaxToNet(net, rate);
      assert.equal(r.netCents + r.taxCents, r.grossCents, `${net}@${rate}`);
      assert.ok(r.grossCents >= r.netCents, `${net}@${rate}: gross below net`);
      assert.ok(r.taxCents >= 0, `${net}@${rate}: negative tax`);
      assert.ok(Number.isSafeInteger(r.netCents));
      assert.ok(Number.isSafeInteger(r.taxCents));
      assert.ok(Number.isSafeInteger(r.grossCents));
    }
  }
});

test("5b: zero net produces zero tax and zero gross", () => {
  for (const rate of [0, MATCHA, STANDARD]) {
    assert.deepEqual(addTaxToNet(0, rate), {
      grossCents: 0, netCents: 0, taxCents: 0, taxRatePercent: rate,
    });
  }
});

test("5c: one cent behaves, at both rates", () => {
  // 1 * 7 / 100 = 0,07 -> 0. 1 * 19 / 100 = 0,19 -> 0. Both round to a
  // gross of 1, so the tax is zero and the identity still holds.
  const seven = addTaxToNet(1, MATCHA);
  assert.deepEqual(seven, { grossCents: 1, netCents: 1, taxCents: 0, taxRatePercent: 7 });
  const nineteen = addTaxToNet(1, STANDARD);
  assert.deepEqual(nineteen, { grossCents: 1, netCents: 1, taxCents: 0, taxRatePercent: 19 });
});

test("5d: a zero rate is a pass-through, not an error", () => {
  const r = addTaxToNet(12345, 0);
  assert.deepEqual(r, { grossCents: 12345, netCents: 12345, taxCents: 0, taxRatePercent: 0 });
});

/* ══════════════════════════════════════════════════════════════
   6. VALIDATION - FAIL CLOSED
   ══════════════════════════════════════════════════════════════ */

test("6: an unusable net amount is refused, never clamped", () => {
  for (const bad of [-1, -5250, 0.5, 5250.5, NaN, Infinity, -Infinity,
                     "5250", null, undefined, {}, [], true]) {
    assert.throws(() => addTaxToNet(bad, MATCHA), /non-negative integer net amount/,
      `${String(bad)} was accepted as a net amount`);
  }
});

test("6b: an unusable rate is refused", () => {
  for (const bad of [-1, -7, 7.5, 0.07, NaN, Infinity, -Infinity,
                     "7", null, undefined, {}, [], true]) {
    assert.throws(() => addTaxToNet(5250, bad), /non-negative integer rate/,
      `${String(bad)} was accepted as a rate`);
  }
});

test("6c: the validation mirrors the gross-origin helper's, word for word", () => {
  // Same conventions, so a reader of one already knows the other.
  const netErr = (() => { try { addTaxToNet(-1, 7); } catch (e) { return e.message; } })();
  const grossErr = (() => { try { extractTaxFromGross(-1, 7); } catch (e) { return e.message; } })();
  assert.match(netErr, /^addTaxToNet requires a non-negative integer net amount$/);
  assert.match(grossErr, /^extractTaxFromGross requires a non-negative integer gross amount$/);
});

/* ══════════════════════════════════════════════════════════════
   7. THE INVERSE PROPERTY
   ══════════════════════════════════════════════════════════════ */

test("7: net -> addTaxToNet -> extractTaxFromGross -> the same net, 7 %", () => {
  let checked = 0;
  for (let net = 0; net <= 200000; net += 1) {
    const gross = addTaxToNet(net, MATCHA).grossCents;
    assert.equal(extractTaxFromGross(gross, MATCHA).netCents, net,
      `round trip broke at ${net} cents (gross ${gross})`);
    checked += 1;
  }
  assert.equal(checked, 200001);
});

test("7b: the same, at 19 %", () => {
  for (let net = 0; net <= 200000; net += 1) {
    const gross = addTaxToNet(net, STANDARD).grossCents;
    assert.equal(extractTaxFromGross(gross, STANDARD).netCents, net,
      `round trip broke at ${net} cents (gross ${gross})`);
  }
});

test("7c: and the tax agrees in both directions", () => {
  for (const rate of [MATCHA, STANDARD]) {
    for (let net = 0; net <= 50000; net += 3) {
      const forward = addTaxToNet(net, rate);
      const back = extractTaxFromGross(forward.grossCents, rate);
      assert.equal(back.netCents, forward.netCents, `${net}@${rate}`);
      assert.equal(back.taxCents, forward.taxCents, `${net}@${rate}`);
      assert.equal(back.grossCents, forward.grossCents, `${net}@${rate}`);
    }
  }
});

test("7d: sparse sweep far above any real B2B contract", () => {
  // The largest self-service annual contract is 535.500 cents. This goes
  // an order of magnitude beyond it, thinned out, to catch any drift
  // that only appears at scale.
  for (const rate of [MATCHA, STANDARD]) {
    for (let net = 200000; net <= 5000000; net += 997) {
      const gross = addTaxToNet(net, rate).grossCents;
      assert.equal(extractTaxFromGross(gross, rate).netCents, net, `${net}@${rate}`);
    }
  }
});

/* ══════════════════════════════════════════════════════════════
   8. BOUNDARY - NO SHIPPING VAT DECISION WAS MADE
   ══════════════════════════════════════════════════════════════ */

test("8: Package 3 decides nothing about B2B shipping VAT", () => {
  const source = read("lib/tax.ts");
  const added = source.slice(source.indexOf("/* ── The other direction: NET-origin"),
                             source.indexOf("/* ── Configured EU B2C tax mode"));
  for (const forbidden of ["619", "769", "1049", "DHL", "carrierRetail", "b2bShipping"]) {
    assert.ok(!added.includes(forbidden), `a carrier amount entered the tax authority: ${forbidden}`);
  }
  // And the shipping allocator itself was not touched by this package:
  // the added block sits entirely above it and never names it.
  assert.ok(source.includes("function allocateShipping("), "the shipping allocator went missing");
  assert.ok(!added.includes("allocateShipping"), "the net-origin block reaches the shipping allocator");
});

test("8b: the B2B shipping module still makes no tax determination", () => {
  const source = read("lib/b2bShippingRules.ts");
  assert.ok(!/from "\.\/tax(\.ts)?"/.test(source), "the shipping rules now import the tax authority");
  assert.ok(!source.includes("addTaxToNet"), "the shipping rules now compute VAT");
});

test("8c: only the tax module gained a net-origin API", () => {
  assert.ok(read("lib/tax.ts").includes("export function addTaxToNet"));
  for (const rel of ["lib/b2bPricingRules.ts", "lib/b2bShippingRules.ts", "lib/shipping.ts"]) {
    assert.ok(!read(rel).includes("addTaxToNet"), `${rel} implements its own net-origin path`);
  }
});

/* ══════════════════════════════════════════════════════════════
   9. EXACT INTEGER ARITHMETIC - THE PRODUCT, NOT JUST THE FACTORS
   ══════════════════════════════════════════════════════════════ */

/**
 * The largest net amount whose PRODUCT is still exact, for one rate.
 *
 * DERIVED, never typed: the boundary is a consequence of
 * Number.MAX_SAFE_INTEGER and the rate, so writing it down as a literal
 * would be a magic number that stops being true the day either changes.
 *
 * This is NOT the accepted boundary - see below. It is the weaker of the
 * two constraints, and the tests keep it so the product guard can be
 * shown to still have its own job.
 */
const largestExactNet = rate => Math.floor(Number.MAX_SAFE_INTEGER / (100 + rate));

/**
 * The largest numerator divideRoundHalfUp can answer EXACTLY.
 *
 * It computes floor((2n + d) / 2d), so its own intermediate is 2n + d.
 * Requiring that to stay inside the safe range gives
 * n <= floor((MAX_SAFE_INTEGER - d) / 2). Derived here independently of
 * the module, so the test and the implementation have to agree by
 * arithmetic rather than by both quoting the same constant.
 */
const ROUNDING_DENOMINATOR = 100;
const MAX_EXACT_NUMERATOR = Math.floor((Number.MAX_SAFE_INTEGER - ROUNDING_DENOMINATOR) / 2);

/** The largest net whose FULL path through the helper is exact. */
const largestFullySafeNet = rate => Math.floor(MAX_EXACT_NUMERATOR / (100 + rate));

test("9: the approved GLOA fixtures are completely unchanged", () => {
  // A: nothing about ordinary amounts may have moved.
  assert.deepEqual(addTaxToNet(5250, MATCHA),
    { grossCents: 5618, netCents: 5250, taxCents: 368, taxRatePercent: 7 });
  assert.deepEqual(addTaxToNet(10500, MATCHA),
    { grossCents: 11235, netCents: 10500, taxCents: 735, taxRatePercent: 7 });
  assert.deepEqual(addTaxToNet(15750, MATCHA),
    { grossCents: 16853, netCents: 15750, taxCents: 1103, taxRatePercent: 7 });
  assert.deepEqual(addTaxToNet(21000, MATCHA),
    { grossCents: 22470, netCents: 21000, taxCents: 1470, taxRatePercent: 7 });
  // And the standard rate too.
  assert.deepEqual(addTaxToNet(999, STANDARD),
    { grossCents: 1189, netCents: 999, taxCents: 190, taxRatePercent: 19 });
  assert.deepEqual(addTaxToNet(100000, STANDARD),
    { grossCents: 119000, netCents: 100000, taxCents: 19000, taxRatePercent: 19 });
});

test("9b: E - zero still produces zero at every rate", () => {
  for (const rate of [0, MATCHA, STANDARD]) {
    assert.deepEqual(addTaxToNet(0, rate),
      { grossCents: 0, netCents: 0, taxCents: 0, taxRatePercent: rate });
  }
});

test("9c: B - a safe net whose PRODUCT is unsafe is rejected", () => {
  for (const rate of [MATCHA, STANDARD]) {
    const tooBig = largestExactNet(rate) + 1;
    // The input itself is a perfectly good safe integer ...
    assert.ok(Number.isSafeInteger(tooBig), "the fixture is not a safe integer");
    // ... and its product with the factor is not.
    assert.ok(!Number.isSafeInteger(tooBig * (100 + rate)), "the fixture does not overflow");
    assert.throws(() => addTaxToNet(tooBig, rate),
      /product is an exact integer/, `${tooBig}@${rate} was accepted`);
  }
});

test("9d: B - and so is an obviously enormous but still safe net", () => {
  const huge = Number.MAX_SAFE_INTEGER;
  assert.ok(Number.isSafeInteger(huge));
  assert.throws(() => addTaxToNet(huge, MATCHA), /product is an exact integer/);
  assert.throws(() => addTaxToNet(huge, STANDARD), /product is an exact integer/);
});

test("9e: C - a rate that makes 100 + rate unsafe is rejected on its own terms", () => {
  const rate = Number.MAX_SAFE_INTEGER;
  // Individually a safe integer and non-negative, so it passes the
  // earlier rate check and must be caught by the factor check.
  assert.ok(Number.isSafeInteger(rate) && rate >= 0);
  assert.ok(!Number.isSafeInteger(100 + rate), "the fixture does not overflow the factor");
  assert.throws(() => addTaxToNet(5250, rate), /100 \+ rate is still an exact integer/);
  // A rate one below it still overflows the factor by exactly 99.
  assert.throws(() => addTaxToNet(5250, Number.MAX_SAFE_INTEGER - 99),
    /100 \+ rate is still an exact integer/);
  // And exactly at the edge the factor is safe again, so the failure
  // moves on to the product rather than the factor.
  assert.throws(() => addTaxToNet(5250, Number.MAX_SAFE_INTEGER - 100),
    /product is an exact integer/);
});

test("9f: A + C - the largest FULLY safe input succeeds, exactly", () => {
  for (const rate of [MATCHA, STANDARD]) {
    const boundary = largestFullySafeNet(rate);
    const factor = 100 + rate;
    const numerator = boundary * factor;

    // C: every link in the chain, checked individually.
    assert.ok(Number.isSafeInteger(factor), `${rate}%: factor unsafe`);
    assert.ok(Number.isSafeInteger(numerator), `${rate}%: numerator unsafe`);
    assert.ok(Number.isSafeInteger(2 * numerator + ROUNDING_DENOMINATOR),
      `${rate}%: the helper's own intermediate is unsafe at the accepted boundary`);

    const result = addTaxToNet(boundary, rate);
    // Against arbitrary precision, not against itself.
    const exactGross = Number((BigInt(boundary) * BigInt(factor) * 2n + 100n) / 200n);
    assert.equal(result.grossCents, exactGross, `${rate}%: the boundary result drifted`);
    assert.equal(result.netCents, boundary);
    assert.equal(result.netCents + result.taxCents, result.grossCents);
    assert.ok(Number.isSafeInteger(result.grossCents));
    assert.ok(Number.isSafeInteger(result.taxCents));
  }
});

test("9i: B + D - boundary + 1 fails closed, and the ROUNDING guard is what catches it", () => {
  for (const rate of [MATCHA, STANDARD]) {
    const rejected = largestFullySafeNet(rate) + 1;
    const numerator = rejected * (100 + rate);

    // D: the earlier validations all PASS for this value, so the
    // rejection cannot be attributed to any of them.
    assert.ok(Number.isSafeInteger(rejected), "the fixture net is not a safe integer");
    assert.ok(rejected >= 0);
    assert.ok(Number.isSafeInteger(100 + rate), "the factor guard would have fired");
    assert.ok(Number.isSafeInteger(numerator),
      "the product guard would have fired - this fixture proves nothing");
    // What is NOT safe is the helper's own intermediate.
    assert.ok(numerator > MAX_EXACT_NUMERATOR, "the fixture is inside the exact rounding range");
    assert.ok(!Number.isSafeInteger(2 * numerator + ROUNDING_DENOMINATOR),
      "2n + d is still safe, so there is nothing to guard against here");

    assert.throws(() => addTaxToNet(rejected, rate),
      /rounding stays in exact integer arithmetic/,
      `${rate}%: boundary + 1 was accepted, or refused for the wrong reason`);
  }
});

test("9g: acceptance flips exactly once, at the derived boundary", () => {
  for (const rate of [MATCHA, STANDARD]) {
    const boundary = largestFullySafeNet(rate);
    const accepts = net => { try { addTaxToNet(net, rate); return true; } catch { return false; } };
    for (const offset of [-2, -1, 0]) {
      assert.equal(accepts(boundary + offset), true, `${rate}%: ${boundary + offset} rejected`);
    }
    for (const offset of [1, 2, 3]) {
      assert.equal(accepts(boundary + offset), false, `${rate}%: ${boundary + offset} accepted`);
    }
  }
});

test("9j: the accepted boundary is strictly below the product-only boundary", () => {
  // The rounding constraint really is the binding one now. If these ever
  // became equal, the new guard would be doing nothing.
  for (const rate of [MATCHA, STANDARD]) {
    assert.ok(largestFullySafeNet(rate) < largestExactNet(rate),
      `${rate}%: the rounding guard is not the binding constraint`);
  }
  assert.equal(MAX_EXACT_NUMERATOR, 4503599627370445);
  assert.ok(Number.isSafeInteger(2 * MAX_EXACT_NUMERATOR + ROUNDING_DENOMINATOR));
  assert.ok(!Number.isSafeInteger(2 * (MAX_EXACT_NUMERATOR + 1) + ROUNDING_DENOMINATOR));
});

test("9h: no clamping, no BigInt, no float fallback entered the helper", () => {
  // Comment-stripped: the helper's own prose explains why it REJECTS
  // rather than reaching for BigInt, and a guard that read the comments
  // would fail on the sentence that documents the decision.
  const source = read("lib/tax.ts")
    .split(/\r?\n/)
    .filter(line => {
      const t = line.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");
  const fn = source.slice(source.indexOf("export function addTaxToNet"),
                          source.indexOf("export function netOriginTaxMetadata"));
  assert.ok(fn.includes("Number.isSafeInteger(numerator)"), "the product is not validated");
  assert.ok(fn.includes("Number.isSafeInteger(factor)"), "the factor is not validated");
  assert.ok(fn.includes("Number.isSafeInteger(grossCents)"), "the result is not validated");
  // The rounding ceiling is DERIVED in the module, not typed as a literal.
  assert.ok(fn.includes("Number.MAX_SAFE_INTEGER"), "the rounding ceiling is not derived");
  assert.ok(fn.includes("maxExactNumerator"), "the rounding-intermediate guard is missing");
  assert.ok(!/45035996273704\d\d/.test(fn), "the rounding ceiling was hardcoded");
  for (const forbidden of ["BigInt", "Math.min", "Math.max", "clamp", "parseFloat", "toFixed"]) {
    assert.ok(!fn.includes(forbidden), `addTaxToNet reaches for ${forbidden}`);
  }
  // The approved formula and its single rounding are untouched: one call
  // to the shared primitive, with the same denominator, and the tax is
  // still the remainder.
  assert.ok(fn.includes("divideRoundHalfUp(numerator, roundingDenominator)"),
    "the single rounding call changed shape");
  assert.equal(fn.split("divideRoundHalfUp(").length - 1, 1,
    "the helper now rounds more than once");
  assert.ok(fn.includes("const roundingDenominator = 100"), "the denominator is no longer 100");
  assert.ok(fn.includes("grossCents - netCents"), "the tax stopped being the remainder");
});
