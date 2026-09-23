import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  B2B_ANNUAL_DELIVERY_COUNT,
  B2B_ANNUAL_DISCOUNT_PERCENT,
  B2B_ANNUAL_RETAINED_PERCENT,
  B2B_CURRENCY,
  B2B_INSTALMENT_COUNTS,
  B2B_MIN_PACKS,
  B2B_PACK_GRAMS,
  B2B_PRICING_RULES_VERSION,
  B2B_SELF_SERVICE_MAX_PACKS,
  PACK_NET_CENTS,
  allocateInstalments,
  annualMonthlyEquivalentForDisplay,
  annualProductNetCents,
  annualSavingNetCents,
  baseAnnualProductNetCents,
  buildB2bAnnualPricing,
  buildB2bMonthlyPricing,
  divideRoundHalfUp as b2bDivideRoundHalfUp,
  isInstalmentCount,
  isSelfServicePackCount,
  kilogramsToPacks,
  monthlyProductNetCents,
  packsToKilograms,
} from "../lib/b2bPricingRules.ts";
// The two leaves this module deliberately does NOT import, imported here
// so the duplicated helper is ASSERTED to agree rather than trusted to a
// comment - the same seam tests/annual-plan-rules.test.mjs guards.
import { divideRoundHalfUp as taxDivideRoundHalfUp } from "../lib/tax.ts";
import { divideRoundHalfUp as annualDivideRoundHalfUp } from "../lib/annualPlanRules.ts";

// SAFE DEFAULT SUITE: pure arithmetic plus a little source inspection.
// No database, no network, no Stripe, no clock.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf-8");

/**
 * The repository's comment stripper, as tests/account-subscriptions.test.mjs
 * defines it. The boundary guards below need it: this module's header
 * deliberately NAMES the things it refuses to do - Stripe, VAT, shipping,
 * the ROI calculator - so a guard that read the comments would fail on the
 * very documentation that makes the boundary legible.
 */
const withoutComments = source => source
  .split(/\r?\n/)
  .filter(line => {
    const t = line.trim();
    return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*") && !t.startsWith("--");
  })
  .join("\n");

/** The pricing module, comments removed. What it DOES, not what it says. */
const pricingCode = () => withoutComments(read("lib/b2bPricingRules.ts"));

/** Every self-service quantity, once. */
const ALL_PACKS = Array.from({ length: 10 }, (_, i) => i + 1);

/* ══════════════════════════════════════════════════════════════
   1. CONSTANTS
   ══════════════════════════════════════════════════════════════ */

test("1: the approved commercial constants are exactly the agreed ones", () => {
  assert.equal(B2B_PRICING_RULES_VERSION, "b2b-2026.1");
  assert.equal(B2B_CURRENCY, "EUR");
  assert.equal(B2B_PACK_GRAMS, 500);
  assert.equal(PACK_NET_CENTS, 5250);
  assert.equal(B2B_MIN_PACKS, 1);
  assert.equal(B2B_SELF_SERVICE_MAX_PACKS, 10);
  assert.equal(B2B_ANNUAL_DELIVERY_COUNT, 12);
  assert.equal(B2B_ANNUAL_DISCOUNT_PERCENT, 15);
  assert.deepEqual([...B2B_INSTALMENT_COUNTS], [1, 2, 4]);
});

test("1b: 52,50 net per 500 g is 105,00 net per kilo", () => {
  // Stated as a check, not as a second constant: the rate per kilo is a
  // CONSEQUENCE of the pack price and must never become an input.
  assert.equal(PACK_NET_CENTS * 2, 10500);
});

test("1c: the retained percentage is derived, so it cannot drift", () => {
  assert.equal(B2B_ANNUAL_RETAINED_PERCENT, 85);
  assert.equal(B2B_ANNUAL_DISCOUNT_PERCENT + B2B_ANNUAL_RETAINED_PERCENT, 100);
});

test("1d: no shipping constant lives in the pricing module", () => {
  const source = pricingCode();
  for (const forbidden of ["619", "769", "1049", "BERLIN", "DHL", "berlin", "shipping"]) {
    assert.ok(!source.includes(forbidden), `the pricing module mentions ${forbidden}`);
  }
});

test("1e: it is a leaf - no relative import, no database, no Stripe, no clock", () => {
  const source = pricingCode();
  // Stricter than "no relative import": a leaf has no import at all, so
  // this cannot be satisfied by reaching for a package instead.
  assert.ok(!/^import /m.test(source), "the pricing module gained an import");
  for (const forbidden of ["supabase", "Stripe", "process.env", "Date.now", "new Date", "fetch("]) {
    assert.ok(!source.includes(forbidden), `the pricing module reaches for ${forbidden}`);
  }
});

/* ══════════════════════════════════════════════════════════════
   2. THE DUPLICATED HELPER
   ══════════════════════════════════════════════════════════════ */

test("2: divideRoundHalfUp agrees with lib/tax.ts and lib/annualPlanRules.ts", () => {
  for (let n = 0; n <= 4000; n += 1) {
    for (const d of [3, 7, 12, 100, 119]) {
      const mine = b2bDivideRoundHalfUp(n, d);
      assert.equal(mine, taxDivideRoundHalfUp(n, d), `tax disagrees at ${n}/${d}`);
      assert.equal(mine, annualDivideRoundHalfUp(n, d), `annual disagrees at ${n}/${d}`);
    }
  }
});

test("2b: divideRoundHalfUp rounds a half away from zero", () => {
  assert.equal(b2bDivideRoundHalfUp(5, 2), 3);          // 2,5 -> 3
  assert.equal(b2bDivideRoundHalfUp(446250, 100), 4463); // the rejected pack rounding
  assert.equal(b2bDivideRoundHalfUp(0, 100), 0);
});

test("2c: divideRoundHalfUp refuses unusable input", () => {
  assert.throws(() => b2bDivideRoundHalfUp(1.5, 2), /safe integers/);
  assert.throws(() => b2bDivideRoundHalfUp(NaN, 2), /safe integers/);
  assert.throws(() => b2bDivideRoundHalfUp(Infinity, 2), /safe integers/);
  assert.throws(() => b2bDivideRoundHalfUp(-1, 2), /non-negative/);
  assert.throws(() => b2bDivideRoundHalfUp(10, 0), /positive denominator/);
  assert.throws(() => b2bDivideRoundHalfUp(10, -2), /positive denominator/);
});

/* ══════════════════════════════════════════════════════════════
   3. QUANTITY
   ══════════════════════════════════════════════════════════════ */

test("3: every pack count from 1 to 10 is self-service", () => {
  for (const packs of ALL_PACKS) {
    assert.equal(isSelfServicePackCount(packs), true, `${packs} packs was refused`);
  }
});

test("3b: 0, 11 and everything unusable is refused, never clamped", () => {
  for (const bad of [0, -1, 11, 12, 100, 1.5, 0.5, NaN, Infinity, -Infinity,
                     "1", "5", null, undefined, {}, [], [1], true, 1n]) {
    assert.equal(isSelfServicePackCount(bad), false, `${String(bad)} was accepted`);
  }
});

test("3c: packs convert to kilograms in halves", () => {
  assert.equal(packsToKilograms(1), 0.5);
  assert.equal(packsToKilograms(2), 1);
  assert.equal(packsToKilograms(3), 1.5);
  assert.equal(packsToKilograms(10), 5);
  assert.throws(() => packsToKilograms(-1), /non-negative integer/);
  assert.throws(() => packsToKilograms(1.5), /non-negative integer/);
});

test("3d: kilograms convert back only when they are whole packs", () => {
  assert.equal(kilogramsToPacks(0.5), 1);
  assert.equal(kilogramsToPacks(1), 2);
  assert.equal(kilogramsToPacks(5), 10);
  // Null is a real answer: these are not orders this shop can fill.
  for (const bad of [0.7, 0.25, 1.2, 0, -1, NaN, Infinity, "1", null, undefined]) {
    assert.equal(kilogramsToPacks(bad), null, `${String(bad)} kg became a pack count`);
  }
});

/* ══════════════════════════════════════════════════════════════
   4. THE MONTHLY SUBSCRIPTION
   ══════════════════════════════════════════════════════════════ */

const MONTHLY_FIXTURES = [
  [1, 5250], [2, 10500], [3, 15750], [4, 21000], [6, 31500], [10, 52500],
];

test("4: the monthly product net is the agreed figure at every fixture", () => {
  for (const [packs, expected] of MONTHLY_FIXTURES) {
    assert.equal(monthlyProductNetCents(packs), expected,
      `${packs} packs priced wrong`);
  }
});

test("4b: the monthly price is linear in packs, with no discount anywhere", () => {
  for (const packs of ALL_PACKS) {
    assert.equal(monthlyProductNetCents(packs), packs * PACK_NET_CENTS);
  }
});

test("4c: an invalid pack count throws rather than pricing something", () => {
  for (const bad of [0, 11, 1.5, NaN, -1]) {
    assert.throws(() => monthlyProductNetCents(bad), /self-service pack count/);
  }
});

/* ══════════════════════════════════════════════════════════════
   5. THE ANNUAL CONTRACT AMOUNT
   ══════════════════════════════════════════════════════════════ */

const ANNUAL_FIXTURES = [
  { packs: 1,  base: 63000,  discounted: 53550 },
  { packs: 2,  base: 126000, discounted: 107100 },
  { packs: 3,  base: 189000, discounted: 160650 },
  { packs: 4,  base: 252000, discounted: 214200 },
  { packs: 6,  base: 378000, discounted: 321300 },
  { packs: 10, base: 630000, discounted: 535500 },
];

test("5: the undiscounted annual base is twelve monthly amounts", () => {
  for (const { packs, base } of ANNUAL_FIXTURES) {
    assert.equal(baseAnnualProductNetCents(packs), base, `${packs} packs base wrong`);
    assert.equal(base, monthlyProductNetCents(packs) * 12);
  }
});

test("5b: the frozen annual contract amount matches every approved fixture", () => {
  for (const { packs, discounted } of ANNUAL_FIXTURES) {
    assert.equal(annualProductNetCents(packs), discounted, `${packs} packs annual wrong`);
  }
});

test("5c: 0,5 kg annual is 535,50 NET and specifically NOT 535,56", () => {
  // The whole reason this module exists in this shape. 535,56 is what
  // discounting and rounding ONE PACK first produces; it is wrong, and
  // the six-cent gap is the difference between "15 %" on the page and
  // 15 % in the contract.
  assert.equal(annualProductNetCents(1), 53550);
  assert.notEqual(annualProductNetCents(1), 53556);

  const roundedPackFirst = b2bDivideRoundHalfUp(PACK_NET_CENTS * 85, 100) * 12;
  assert.equal(roundedPackFirst, 53556, "the rejected model no longer produces 53556");
  assert.equal(roundedPackFirst - annualProductNetCents(1), 6);
});

test("5d: 5,0 kg annual is 5.355,00 NET and specifically NOT 5.355,60", () => {
  assert.equal(annualProductNetCents(10), 535500);
  assert.notEqual(annualProductNetCents(10), 535560);

  const roundedPackFirst = b2bDivideRoundHalfUp(PACK_NET_CENTS * 85, 100) * 10 * 12;
  assert.equal(roundedPackFirst, 535560);
  // Ten times the one-pack error: exactly how a half-cent compounds.
  assert.equal(roundedPackFirst - annualProductNetCents(10), 60);
});

test("5e: the discount is EXACTLY 15 % of the base at every quantity", () => {
  for (const packs of ALL_PACKS) {
    const base = baseAnnualProductNetCents(packs);
    const annual = annualProductNetCents(packs);
    // Exact integer identity, not a tolerance: base * 85 divides by 100
    // cleanly for every one of these, so there is nothing to round.
    assert.equal(annual * 100, base * 85, `${packs} packs is not exactly 85 % of base`);
    assert.equal(annualSavingNetCents(packs) * 100, base * 15,
      `${packs} packs does not save exactly 15 %`);
  }
});

test("5f: the annual amount is never derived from a rounded monthly figure", () => {
  // If anyone re-introduces the rejected model, these quantities break
  // first - they are the ones whose pack discount does not land on a cent.
  for (const packs of ALL_PACKS) {
    const viaRoundedPack = b2bDivideRoundHalfUp(PACK_NET_CENTS * 85, 100) * packs * 12;
    const authority = annualProductNetCents(packs);
    assert.ok(authority <= viaRoundedPack, `${packs} packs is above the rejected model`);
  }
  // And the module does not even contain the shape of that mistake.
  const source = pricingCode();
  assert.ok(!/PACK_NET_CENTS \* B2B_ANNUAL_RETAINED_PERCENT/.test(source),
    "the pack price is being discounted before the term is applied");
});

/* ══════════════════════════════════════════════════════════════
   6. INSTALMENT ALLOCATION
   ══════════════════════════════════════════════════════════════ */

const INSTALMENT_FIXTURES = [
  { packs: 1,  1: [53550],  2: [26775, 26775],   4: [13387, 13387, 13387, 13389] },
  { packs: 2,  1: [107100], 2: [53550, 53550],   4: [26775, 26775, 26775, 26775] },
  { packs: 3,  1: [160650], 2: [80325, 80325],   4: [40162, 40162, 40162, 40164] },
  { packs: 4,  1: [214200], 2: [107100, 107100], 4: [53550, 53550, 53550, 53550] },
  { packs: 6,  1: [321300], 2: [160650, 160650], 4: [80325, 80325, 80325, 80325] },
  { packs: 10, 1: [535500], 2: [267750, 267750], 4: [133875, 133875, 133875, 133875] },
];

test("6: every approved schedule allocates to the agreed instalments", () => {
  for (const fixture of INSTALMENT_FIXTURES) {
    const total = annualProductNetCents(fixture.packs);
    for (const count of [1, 2, 4]) {
      assert.deepEqual(allocateInstalments(total, count), fixture[count],
        `${fixture.packs} packs / ${count} instalments`);
    }
  }
});

test("6b: 0,5 kg quarterly puts the two remainder cents on the LAST instalment", () => {
  const parts = allocateInstalments(annualProductNetCents(1), 4);
  assert.deepEqual(parts, [13387, 13387, 13387, 13389]);
  assert.equal(parts[0], parts[1]);
  assert.equal(parts[1], parts[2]);
  assert.equal(parts[3] - parts[0], 2, "the remainder did not land at the end");
  assert.equal(parts.reduce((a, b) => a + b, 0), 53550);
});

test("6c: 1,5 kg quarterly behaves the same way", () => {
  const parts = allocateInstalments(annualProductNetCents(3), 4);
  assert.deepEqual(parts, [40162, 40162, 40162, 40164]);
  assert.equal(parts[3] - parts[0], 2);
  assert.equal(parts.reduce((a, b) => a + b, 0), 160650);
});

test("6d: THE INVARIANT - the instalments always sum to the frozen total", () => {
  for (const packs of ALL_PACKS) {
    const total = annualProductNetCents(packs);
    for (const count of B2B_INSTALMENT_COUNTS) {
      const parts = allocateInstalments(total, count);
      assert.equal(parts.length, count);
      assert.equal(parts.reduce((a, b) => a + b, 0), total,
        `${packs} packs / ${count} instalments lost or invented cents`);
      for (const part of parts) {
        assert.ok(Number.isSafeInteger(part) && part > 0, "an instalment is not a positive integer");
      }
    }
  }
});

test("6e: the invariant holds for every total a contract could ever carry", () => {
  // Exhaustive over a wide band rather than over the six fixtures, so a
  // future price or term change cannot quietly break the allocator.
  for (let total = 0; total <= 5000; total += 1) {
    for (const count of B2B_INSTALMENT_COUNTS) {
      const parts = allocateInstalments(total, count);
      assert.equal(parts.reduce((a, b) => a + b, 0), total, `${total} / ${count}`);
      const base = Math.floor(total / count);
      for (let i = 0; i < count - 1; i += 1) assert.equal(parts[i], base);
      assert.ok(parts[count - 1] >= base, "the final instalment is below the base");
      assert.ok(parts[count - 1] - base < count, "the remainder exceeded the instalment count");
    }
  }
});

test("6f: only 1, 2 and 4 are payment schedules", () => {
  for (const good of [1, 2, 4]) assert.equal(isInstalmentCount(good), true);
  for (const bad of [0, 3, 5, 6, 12, -1, -2, 1.5, NaN, Infinity,
                     "1", "4", null, undefined, {}, [], true]) {
    assert.equal(isInstalmentCount(bad), false, `${String(bad)} was accepted as a schedule`);
  }
});

test("6g: the allocator refuses an unapproved count and a negative total", () => {
  for (const bad of [0, 3, 5, 12, -1, 1.5, NaN, "2", null, undefined]) {
    assert.throws(() => allocateInstalments(53550, bad), /instalments/,
      `${String(bad)} instalments was allocated`);
  }
  for (const bad of [-1, -53550, 1.5, NaN, Infinity, "53550", null, undefined]) {
    assert.throws(() => allocateInstalments(bad, 4), /non-negative integer total/,
      `${String(bad)} was allocated`);
  }
});

/* ══════════════════════════════════════════════════════════════
   7. THE MONTHLY EQUIVALENT, AND ITS WARNING LABEL
   ══════════════════════════════════════════════════════════════ */

test("7: the monthly equivalent reports whether it is exact", () => {
  // 535,50 / 12 = 44,625 - not a cent, so it is an average.
  const one = annualMonthlyEquivalentForDisplay(1);
  assert.equal(one.averageNetCents, 4463);
  assert.equal(one.isExact, false);
  assert.equal(one.deliveryCount, 12);

  // 1.071,00 / 12 = 89,25 exactly.
  const two = annualMonthlyEquivalentForDisplay(2);
  assert.equal(two.averageNetCents, 8925);
  assert.equal(two.isExact, true);

  // 1.606,50 / 12 = 133,875 - the other inexact launch quantity.
  const three = annualMonthlyEquivalentForDisplay(3);
  assert.equal(three.averageNetCents, 13388);
  assert.equal(three.isExact, false);
});

test("7b: isExact is true exactly when the total divides by twelve", () => {
  for (const packs of ALL_PACKS) {
    const equivalent = annualMonthlyEquivalentForDisplay(packs);
    assert.equal(equivalent.isExact, annualProductNetCents(packs) % 12 === 0, `${packs} packs`);
  }
});

test("7c: the equivalent is NOT a pricing authority - multiplying it back is wrong", () => {
  // The property that makes this display-only. If anyone ever derives a
  // contract amount from it, this is the failure they would ship.
  const inexact = [1, 3];
  for (const packs of inexact) {
    const { averageNetCents } = annualMonthlyEquivalentForDisplay(packs);
    assert.notEqual(averageNetCents * 12, annualProductNetCents(packs),
      `${packs} packs: the average multiplied back happens to be correct, so this guard is blind`);
  }
  // And nothing inside the module consumes it.
  const source = pricingCode();
  const uses = source.split("annualMonthlyEquivalentForDisplay").length - 1;
  assert.equal(uses, 2, "the display helper gained a caller inside the pricing authority");
});

/* ══════════════════════════════════════════════════════════════
   8. THE BUILDERS
   ══════════════════════════════════════════════════════════════ */

test("8: the monthly builder returns the agreed figures and the rules version", () => {
  const result = buildB2bMonthlyPricing({ packs: 4 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.pricing, {
    rulesVersion: "b2b-2026.1",
    currency: "EUR",
    packs: 4,
    kilograms: 2,
    packNetCents: 5250,
    monthlyProductNetCents: 21000,
  });
});

test("8b: the monthly builder refuses rather than throwing at the boundary", () => {
  for (const bad of [0, 11, 1.5, NaN, "4", null, undefined, {}]) {
    const result = buildB2bMonthlyPricing({ packs: bad });
    assert.equal(result.ok, false, `${String(bad)} packs was priced`);
    assert.match(result.reason, /self-service quantity/);
  }
});

test("8c: the annual builder returns the frozen amount and its schedule", () => {
  const result = buildB2bAnnualPricing({ packs: 1, instalmentCount: 4 });
  assert.equal(result.ok, true);
  const p = result.pricing;
  assert.equal(p.rulesVersion, "b2b-2026.1");
  assert.equal(p.currency, "EUR");
  assert.equal(p.packs, 1);
  assert.equal(p.kilograms, 0.5);
  assert.equal(p.deliveryCount, 12);
  assert.equal(p.discountPercent, 15);
  assert.equal(p.baseAnnualNetCents, 63000);
  assert.equal(p.annualProductNetCents, 53550);
  assert.equal(p.savingNetCents, 9450);
  assert.equal(p.instalmentCount, 4);
  assert.deepEqual(p.instalmentNetCents, [13387, 13387, 13387, 13389]);
  assert.equal(p.monthlyEquivalent.isExact, false);
});

test("8d: every quantity and schedule builds, and the schedule always reconciles", () => {
  for (const packs of ALL_PACKS) {
    for (const instalmentCount of B2B_INSTALMENT_COUNTS) {
      const result = buildB2bAnnualPricing({ packs, instalmentCount });
      assert.equal(result.ok, true, `${packs}/${instalmentCount} refused`);
      const p = result.pricing;
      assert.equal(p.instalmentNetCents.reduce((a, b) => a + b, 0), p.annualProductNetCents);
      assert.equal(p.baseAnnualNetCents - p.savingNetCents, p.annualProductNetCents);
      assert.equal(p.annualProductNetCents * 100, p.baseAnnualNetCents * 85);
    }
  }
});

test("8e: the annual builder refuses a bad quantity and a bad schedule separately", () => {
  const badQuantity = buildB2bAnnualPricing({ packs: 11, instalmentCount: 4 });
  assert.equal(badQuantity.ok, false);
  assert.match(badQuantity.reason, /self-service quantity/);

  const badSchedule = buildB2bAnnualPricing({ packs: 4, instalmentCount: 3 });
  assert.equal(badSchedule.ok, false);
  assert.match(badSchedule.reason, /approved payment schedule/);

  // Quantity is checked first, so an invalid pair names the quantity.
  const both = buildB2bAnnualPricing({ packs: 0, instalmentCount: 7 });
  assert.equal(both.ok, false);
  assert.match(both.reason, /self-service quantity/);
});

/* ══════════════════════════════════════════════════════════════
   9. NO FLOATING-POINT MONEY
   ══════════════════════════════════════════════════════════════ */

test("9: every monetary value produced is a safe integer", () => {
  for (const packs of ALL_PACKS) {
    for (const value of [monthlyProductNetCents(packs), baseAnnualProductNetCents(packs),
                         annualProductNetCents(packs), annualSavingNetCents(packs),
                         annualMonthlyEquivalentForDisplay(packs).averageNetCents]) {
      assert.ok(Number.isSafeInteger(value), `${packs} packs produced ${value}`);
    }
    for (const count of B2B_INSTALMENT_COUNTS) {
      for (const part of allocateInstalments(annualProductNetCents(packs), count)) {
        assert.ok(Number.isSafeInteger(part), `${packs}/${count} produced ${part}`);
      }
    }
  }
});

test("9b: no euro float and no decimal library appear in the module", () => {
  const source = pricingCode();
  assert.ok(!/\btoFixed\b|\bparseFloat\b|\bNumber\.parseFloat\b/.test(source),
    "a float formatting or parsing call entered the pricing authority");
  assert.ok(!/decimal\.js|big\.js|dinero|currency\.js/i.test(source),
    "a decimal library was introduced");
  // 52.50 written as a euro float would be the obvious way to get this
  // wrong; the only decimal literals allowed are the kilogram halves.
  assert.ok(!/\b52\.5\b|\b105\.0?\b|\b535\.5\b/.test(source),
    "a euro amount is written as a decimal");
});

test("9c: the largest contract stays far inside the safe integer range", () => {
  const biggest = annualProductNetCents(B2B_SELF_SERVICE_MAX_PACKS);
  assert.equal(biggest, 535500);
  assert.ok(biggest * 100 < Number.MAX_SAFE_INTEGER,
    "the exactness check itself could overflow");
});

/* ══════════════════════════════════════════════════════════════
   10. BOUNDARY: THIS PACKAGE IS PRODUCT PRICING ONLY
   ══════════════════════════════════════════════════════════════ */

test("10: no checkout, tax, UI, admin, email or migration came with it", () => {
  const source = pricingCode();
  for (const forbidden of ["checkout", "Checkout", "tax_snapshot", "taxRate", "VAT",
                           "gross", "Gross", "resend", "Resend", "admin", "Admin"]) {
    assert.ok(!source.includes(forbidden), `the pricing module mentions ${forbidden}`);
  }
});

test("10b: the ROI calculator is a separate concern and stays untouched", () => {
  // lib/b2bCalculator.ts compares a customer's CURRENT price against
  // discounts supplied by its caller. It states no price and is not a
  // second pricing authority - this asserts it did not become one.
  const calculator = read("lib/b2bCalculator.ts");
  assert.ok(calculator.length > 0, "the calculator library went missing");
  assert.ok(!calculator.includes("5250"), "the calculator gained a hardcoded pack price");
  assert.ok(!calculator.includes("b2bPricingRules"), "the calculator now imports the pricing authority");
  assert.ok(!pricingCode().includes("b2bCalculator"),
    "the pricing authority now imports the calculator");
});
