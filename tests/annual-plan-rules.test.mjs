import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ANNUAL_DELIVERY_COUNT,
  ANNUAL_DELIVERY_INTERVAL_DAYS,
  ANNUAL_DELIVERY_INTERVAL_HOURS,
  ANNUAL_DELIVERY_INTERVAL_MS,
  ANNUAL_DISCOUNT_PERCENT,
  ANNUAL_RETAINED_PERCENT,
  ANNUAL_SHIPPING_PER_DELIVERY_GROSS_CENTS,
  ANNUAL_SIZES,
  ANNUAL_SIZE_GRAMS,
  ANNUAL_TERM_DAYS,
  ANNUAL_TERM_HOURS,
  ANNUAL_TERM_MS,
  annualDeliveryDueAt,
  annualPlanEndAt,
  annualShippingPerDeliveryGrossCents,
  annualSizeFromGrams,
  annualUnitGrossCents,
  buildAnnualDeliverySchedule,
  buildAnnualPricing,
  buildAnnualSavings,
  divideRoundHalfUp as annualDivideRoundHalfUp,
  isAnnualSize,
} from "../lib/annualPlanRules.ts";
import {
  ANNUAL_LAUNCH_GRAMS_BY_SKU,
  ANNUAL_LAUNCH_SIZE_BY_SKU,
  ANNUAL_LAUNCH_SKUS,
  ANNUAL_PLAN_FEATURE_FLAG,
  isAnnualPlanCheckoutEnabled,
  resolveAnnualLaunchPlan,
} from "../lib/annualPlans.ts";
// The two modules the annual rules deliberately do NOT import, imported
// here instead so the duplication and the seam can be asserted rather
// than trusted to a comment.
import { divideRoundHalfUp as taxDivideRoundHalfUp } from "../lib/tax.ts";
import { computeShippingGrossCents } from "../lib/shipping.ts";

// SAFE DEFAULT SUITE: pure arithmetic plus a little source inspection.
// No database is opened, no Supabase client is constructed, no Stripe API
// is called, no email is sent, no SQL is executed and no migration is
// applied. Nothing here reads a clock: every schedule assertion supplies
// its own anchor.
//
// What it protects: the money a customer is charged for a thirteen-box
// prepaid contract, and the thirteen dates they are promised. Both are
// frozen onto public.annual_plans at purchase by migration 039 and cannot
// be corrected afterwards, so they have to be right before the checkout
// route that will call these functions exists.

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf-8");

const NEWLINE = String.fromCharCode(10);

/**
 * Code only.
 *
 * Both modules carry long prose that deliberately NAMES what they refuse
 * to do - the 4900 threshold they must not derive from, the catalog
 * prices they must not hardcode, calendar months, Stripe, Supabase - so a
 * scan that read the comments would report every deliberate avoidance as
 * a violation of itself. The same helper the rest of this repository's
 * source-level suites use.
 */
const withoutComments = source => source
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split(NEWLINE)
  .filter(line => {
    const t = line.trim();
    return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
  })
  .join(NEWLINE);

const rulesSource = read("lib/annualPlanRules.ts");
const plansSource = read("lib/annualPlans.ts");
const rulesCode = withoutComments(rulesSource);
const plansCode = withoutComments(plansSource);

/** The launch catalog, as fixtures. NOT as the source of truth - see test 5. */
const CATALOG = {
  "30g": 1999,
  "50g": 2999,
  "100g": 5499,
};

/** A canonical variant in the shape buildAuthoritativeQuote returns. */
const variant = (over = {}) => ({
  variantId: "11111111-2222-3333-4444-555555555555",
  sku: "GLOA-MATCHA-50G",
  sizeGrams: 50,
  unitGrossCents: 2999,
  currency: "EUR",
  ...over,
});

/** buildAnnualPricing for one launch size, asserting it succeeded. */
const pricingFor = size => {
  const result = buildAnnualPricing({ size, catalogUnitGrossCents: CATALOG[size] });
  assert.equal(result.ok, true, `pricing failed for ${size}`);
  return result.pricing;
};

const ANCHOR = Date.UTC(2026, 8, 1, 9, 30, 0); // 2026-09-01T09:30:00Z
const DAY_MS = 24 * 60 * 60 * 1000;

/* ══════════════════════════════════════════════════════════════
   1-4. THE SHAPE OF THE CONTRACT
   ══════════════════════════════════════════════════════════════ */

test("1: thirteen deliveries, 28 days apart, over a 364-day term", () => {
  assert.equal(ANNUAL_DELIVERY_COUNT, 13);
  assert.equal(ANNUAL_DELIVERY_INTERVAL_DAYS, 28);
  assert.equal(ANNUAL_DELIVERY_INTERVAL_DAYS / 7, 4, "the cadence is not four weeks");
  assert.equal(ANNUAL_TERM_DAYS, 364);
  // The term is thirteen whole cadences, not a 365-day year.
  assert.equal(ANNUAL_TERM_DAYS, ANNUAL_DELIVERY_INTERVAL_DAYS * ANNUAL_DELIVERY_COUNT);
  assert.notEqual(ANNUAL_TERM_DAYS, 365);
});

test("2: the durations agree with migration 039's hours, to the millisecond", () => {
  // 039 stores the schedule as make_interval(hours => 672 * (n - 1)) and
  // the term as make_interval(hours => 8736). These are the same spans.
  assert.equal(ANNUAL_DELIVERY_INTERVAL_HOURS, 672);
  assert.equal(ANNUAL_TERM_HOURS, 8736);
  assert.equal(ANNUAL_DELIVERY_INTERVAL_MS, 672 * 60 * 60 * 1000);
  assert.equal(ANNUAL_DELIVERY_INTERVAL_MS, 2_419_200_000);
  assert.equal(ANNUAL_TERM_MS, 8736 * 60 * 60 * 1000);
  // And 039 really does say so.
  const migration = read("supabase/migrations/039_b2c_annual_plan_foundation.sql");
  assert.ok(migration.includes("make_interval(hours => 672 * (n - 1))"),
    "039's delivery cadence is no longer 672 hours per step");
  assert.ok(migration.includes("make_interval(hours => 8736)"),
    "039's plan term is no longer 8736 hours");
});

test("3: the discount is ten percent, expressed as exact integers", () => {
  assert.equal(ANNUAL_DISCOUNT_PERCENT, 10);
  assert.equal(ANNUAL_RETAINED_PERCENT, 90);
  assert.equal(ANNUAL_DISCOUNT_PERCENT + ANNUAL_RETAINED_PERCENT, 100);
  assert.ok(Number.isInteger(ANNUAL_DISCOUNT_PERCENT));
  assert.ok(Number.isInteger(ANNUAL_RETAINED_PERCENT));
});

test("4: the three launch sizes and their weights", () => {
  assert.deepEqual([...ANNUAL_SIZES], ["30g", "50g", "100g"]);
  assert.deepEqual({ ...ANNUAL_SIZE_GRAMS }, { "30g": 30, "50g": 50, "100g": 100 });
  for (const size of ANNUAL_SIZES) {
    assert.equal(isAnnualSize(size), true);
    assert.equal(annualSizeFromGrams(ANNUAL_SIZE_GRAMS[size]), size);
  }
  // A weight nobody priced annually is not an annual size.
  for (const grams of [0, 1, 25, 31, 200, 1000, -50, 50.5, NaN, null, undefined]) {
    assert.equal(annualSizeFromGrams(grams), null, String(grams));
  }
  for (const notASize of ["30", "30 g", "30G", "", null, undefined, 30, {}]) {
    assert.equal(isAnnualSize(notASize), false, String(notASize));
  }
});

/* ══════════════════════════════════════════════════════════════
   5-9. MONEY
   ══════════════════════════════════════════════════════════════ */

test("5: the catalog price is an INPUT, never a constant in the rules module", () => {
  // The launch prices above are fixtures. If they were baked into the
  // rules, a catalog edit would silently stop changing the annual quote.
  for (const cents of Object.values(CATALOG)) {
    assert.ok(!rulesCode.includes(String(cents)),
      `lib/annualPlanRules.ts hardcodes the catalog price ${cents}`);
  }
  // Nor are the derived totals or the savings stored anywhere.
  for (const derived of [31057, 35087, 64337, 23387, 7670, 2600, 11570, 7150, 33657, 46657, 71487]) {
    assert.ok(!rulesCode.includes(String(derived)),
      `lib/annualPlanRules.ts hardcodes the derived figure ${derived}`);
  }
});

test("6: the annual unit price is ten percent off, in integer cents", () => {
  assert.equal(annualUnitGrossCents(1999), 1799);
  assert.equal(annualUnitGrossCents(2999), 2699);
  assert.equal(annualUnitGrossCents(5499), 4949);
  // Derived, not looked up: any catalog price gets the same treatment.
  for (const catalog of [1, 5, 10, 99, 100, 101, 1234, 4999, 12345, 99999]) {
    assert.equal(annualUnitGrossCents(catalog), Math.floor((catalog * 90 * 2 + 100) / 200));
    assert.ok(Number.isInteger(annualUnitGrossCents(catalog)));
    assert.ok(annualUnitGrossCents(catalog) <= catalog);
  }
  // Programmer error, not untrusted input: refuse rather than invent.
  for (const bad of [0, -1, 1.5, NaN, Infinity]) {
    assert.throws(() => annualUnitGrossCents(bad), /positive integer/);
  }
});

test("7: the rounding is character-for-character lib/tax.ts's, and is asserted so", () => {
  // The two leaf modules cannot import each other, so the duplication is
  // asserted - the same way the suite for lib/transactionalEmailRetryRules.ts
  // asserts STALE_SENDING_AFTER_MS against the internal-notification module.
  for (let n = 0; n <= 2000; n += 1) {
    for (const d of [1, 2, 3, 7, 100, 200]) {
      assert.equal(annualDivideRoundHalfUp(n, d), taxDivideRoundHalfUp(n, d), `${n}/${d}`);
    }
  }
  // Half really does go up, in both.
  assert.equal(annualDivideRoundHalfUp(1, 2), 1);
  assert.equal(annualDivideRoundHalfUp(3, 2), 2);
  assert.equal(annualDivideRoundHalfUp(5, 10), 1);
  // And both refuse the same inputs.
  for (const [n, d] of [[-1, 2], [1, 0], [1, -2], [1.5, 2], [1, 2.5]]) {
    assert.throws(() => annualDivideRoundHalfUp(n, d));
    assert.throws(() => taxDivideRoundHalfUp(n, d));
  }
});

test("8: annual shipping is explicit per size, and 50 g and 100 g are free", () => {
  assert.equal(annualShippingPerDeliveryGrossCents("30g"), 590);
  assert.equal(annualShippingPerDeliveryGrossCents("50g"), 0);
  assert.equal(annualShippingPerDeliveryGrossCents("100g"), 0);
  assert.deepEqual({ ...ANNUAL_SHIPPING_PER_DELIVERY_GROSS_CENTS },
    { "30g": 590, "50g": 0, "100g": 0 });
  for (const size of ANNUAL_SIZES) {
    assert.ok(Number.isInteger(ANNUAL_SHIPPING_PER_DELIVERY_GROSS_CENTS[size]));
  }
});

test("9: annual shipping does NOT depend on the shop's 4900 free-shipping threshold", () => {
  // The threshold is real and unchanged...
  assert.ok(read("lib/shipping.ts")
    .includes("germany: { shippingGrossCents: 590, freeShippingThresholdGrossCents: 4900 }"),
    "the German shop rule changed, so this comparison is stale");

  // ...and applying it to the ANNUAL unit prices would give a different
  // answer for 50 g. That divergence is the whole point: free shipping on
  // 50 g is an annual benefit, not a consequence of the threshold.
  assert.equal(computeShippingGrossCents("germany", pricingFor("50g").annualUnitGrossCents), 590);
  assert.equal(annualShippingPerDeliveryGrossCents("50g"), 0);

  // For 100 g the shop rule happens to agree today - 4949 sits 49 cents
  // above 4900 - and that coincidence must not become the reason.
  assert.equal(computeShippingGrossCents("germany", pricingFor("100g").annualUnitGrossCents), 0);
  assert.equal(annualShippingPerDeliveryGrossCents("100g"), 0);
  assert.equal(4949 - 4900, 49, "the 100 g headroom above the threshold changed");

  // Structurally: the rules module never mentions the threshold, never
  // imports the shipping module, and does not recompute it.
  assert.ok(!rulesCode.includes("4900"), "the annual rules reference the shop threshold");
  assert.ok(!rulesCode.includes("computeShippingGrossCents"));
  assert.ok(!/^import /m.test(rulesCode), "lib/annualPlanRules.ts gained an import");

  // And lib/shipping.ts itself is untouched by this phase.
  assert.equal(
    withoutComments(read("lib/shipping.ts")).toLowerCase().includes("annual"), false,
    "lib/shipping.ts was taught about annual plans");
});

/* ══════════════════════════════════════════════════════════════
   10-13. THE DERIVED TOTALS
   ══════════════════════════════════════════════════════════════ */

test("10: every total is DERIVED from the per-delivery figures", () => {
  for (const size of ANNUAL_SIZES) {
    const p = pricingFor(size);
    assert.equal(p.merchandiseTotalGrossCents, p.annualUnitGrossCents * ANNUAL_DELIVERY_COUNT);
    assert.equal(p.shippingTotalGrossCents, p.shippingPerDeliveryGrossCents * ANNUAL_DELIVERY_COUNT);
    assert.equal(p.totalGrossCents, p.merchandiseTotalGrossCents + p.shippingTotalGrossCents);
    assert.equal(p.deliveryCount, 13);
    assert.equal(p.discountPercentApplied, 10);
    assert.equal(p.catalogUnitGrossCents, CATALOG[size]);
  }
});

test("11: the current Germany totals are exactly the reviewed integers", () => {
  const thirty = pricingFor("30g");
  assert.equal(thirty.annualUnitGrossCents, 1799);
  assert.equal(thirty.shippingPerDeliveryGrossCents, 590);
  assert.equal(thirty.merchandiseTotalGrossCents, 23387);
  assert.equal(thirty.shippingTotalGrossCents, 7670);
  assert.equal(thirty.totalGrossCents, 31057);

  const fifty = pricingFor("50g");
  assert.equal(fifty.annualUnitGrossCents, 2699);
  assert.equal(fifty.shippingPerDeliveryGrossCents, 0);
  assert.equal(fifty.merchandiseTotalGrossCents, 35087);
  assert.equal(fifty.shippingTotalGrossCents, 0);
  assert.equal(fifty.totalGrossCents, 35087);

  const hundred = pricingFor("100g");
  assert.equal(hundred.annualUnitGrossCents, 4949);
  assert.equal(hundred.shippingPerDeliveryGrossCents, 0);
  assert.equal(hundred.merchandiseTotalGrossCents, 64337);
  assert.equal(hundred.shippingTotalGrossCents, 0);
  assert.equal(hundred.totalGrossCents, 64337);
});

test("12: every money value is an integer number of cents", () => {
  const MONEY_FIELDS = [
    "catalogUnitGrossCents", "annualUnitGrossCents", "shippingPerDeliveryGrossCents",
    "merchandiseTotalGrossCents", "shippingTotalGrossCents", "totalGrossCents",
  ];
  for (const size of ANNUAL_SIZES) {
    const p = pricingFor(size);
    for (const field of MONEY_FIELDS) {
      assert.equal(typeof p[field], "number", `${size}.${field}`);
      assert.ok(Number.isSafeInteger(p[field]), `${size}.${field} is not a safe integer: ${p[field]}`);
    }
  }
  // No float creeps in for an awkward catalog price either.
  for (const catalog of [1, 3, 7, 999, 1001, 4999, 33333]) {
    const r = buildAnnualPricing({ size: "30g", catalogUnitGrossCents: catalog });
    assert.equal(r.ok, true);
    for (const field of MONEY_FIELDS) assert.ok(Number.isSafeInteger(r.pricing[field]));
  }
});

test("13: an unsupported variant fails closed, with no default discount or shipping", () => {
  for (const size of [
    "200g", "30 g", "30G", "matcha", "", " ", null, undefined, 30, {}, [], true,
  ]) {
    const r = buildAnnualPricing({ size, catalogUnitGrossCents: 1999 });
    assert.equal(r.ok, false, `size ${String(size)} was accepted`);
    assert.match(r.reason, /supported annual launch size/);
    assert.equal(r.pricing, undefined, "a refusal still returned pricing");
  }
  // And an unusable catalog price is refused for a supported size.
  for (const catalog of [0, -1, 1.5, NaN, Infinity, "1999", null, undefined]) {
    const r = buildAnnualPricing({ size: "50g", catalogUnitGrossCents: catalog });
    assert.equal(r.ok, false, `catalog ${String(catalog)} was accepted`);
    assert.match(r.reason, /positive integer/);
  }
});

/* ══════════════════════════════════════════════════════════════
   14-15. THE SAVINGS LINE
   ══════════════════════════════════════════════════════════════ */

test("14: savings are derived from the shop's own shipping rule, not stored", () => {
  const EXPECTED = { "30g": 2600, "50g": 11570, "100g": 7150 };
  const FLEXIBLE_TOTAL = { "30g": 33657, "50g": 46657, "100g": 71487 };

  for (const size of ANNUAL_SIZES) {
    const pricing = pricingFor(size);
    // The flexible side pays the CATALOG price and the SHOP's shipping,
    // computed by lib/shipping.ts rather than restated here.
    const flexibleShipping = computeShippingGrossCents("germany", pricing.catalogUnitGrossCents);
    const r = buildAnnualSavings({ pricing, flexibleShippingPerDeliveryGrossCents: flexibleShipping });
    assert.equal(r.ok, true, `savings failed for ${size}`);
    const s = r.savings;

    // Derived, both sides.
    assert.equal(s.flexibleTotalGrossCents,
      (pricing.catalogUnitGrossCents + flexibleShipping) * ANNUAL_DELIVERY_COUNT);
    assert.equal(s.savingsGrossCents, s.flexibleTotalGrossCents - pricing.totalGrossCents);

    // And it lands on the reviewed figures for the current catalog.
    assert.equal(s.flexibleTotalGrossCents, FLEXIBLE_TOTAL[size], `${size} flexible total`);
    assert.equal(s.annualTotalGrossCents, pricing.totalGrossCents);
    assert.equal(s.savingsGrossCents, EXPECTED[size], `${size} savings`);
    assert.ok(Number.isSafeInteger(s.savingsGrossCents));
  }
});

test("15: the savings helper refuses bad input and never advertises a negative", () => {
  const pricing = pricingFor("50g");
  for (const bad of [-1, 1.5, NaN, "590", null, undefined, {}]) {
    const r = buildAnnualSavings({ pricing, flexibleShippingPerDeliveryGrossCents: bad });
    assert.equal(r.ok, false, String(bad));
  }
  // A catalog cheap enough that the annual plan is not a saving must
  // refuse rather than print a negative number.
  const dearAnnual = buildAnnualPricing({ size: "30g", catalogUnitGrossCents: 100 }).pricing;
  const r = buildAnnualSavings({ pricing: dearAnnual, flexibleShippingPerDeliveryGrossCents: 0 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /not cheaper/);
});

/* ══════════════════════════════════════════════════════════════
   16-19. THE SCHEDULE
   ══════════════════════════════════════════════════════════════ */

test("16: exactly thirteen deliveries, numbered 1 to 13, first one at the anchor", () => {
  const schedule = buildAnnualDeliverySchedule(new Date(ANCHOR));
  assert.equal(schedule.length, 13);
  assert.deepEqual(schedule.map(d => d.deliveryNumber), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
  assert.equal(schedule[0].scheduledFor.getTime(), ANCHOR, "delivery 1 is not the purchase moment");
  assert.equal(schedule[0].scheduledFor.getTime() - ANCHOR, 0);
});

test("17: delivery 13 is exactly +336 days and every gap is exactly 28 days", () => {
  const schedule = buildAnnualDeliverySchedule(ANCHOR);
  assert.equal(schedule[12].scheduledFor.getTime() - ANCHOR, 336 * DAY_MS);
  assert.equal(336, ANNUAL_DELIVERY_INTERVAL_DAYS * (ANNUAL_DELIVERY_COUNT - 1));
  for (let i = 1; i < schedule.length; i += 1) {
    const gap = schedule[i].scheduledFor.getTime() - schedule[i - 1].scheduledFor.getTime();
    assert.equal(gap, 28 * DAY_MS, `gap before delivery ${i + 1}`);
    assert.equal(gap, ANNUAL_DELIVERY_INTERVAL_MS);
  }
  // The single-delivery helper agrees with the whole schedule.
  for (const d of schedule) {
    assert.equal(annualDeliveryDueAt(ANCHOR, d.deliveryNumber).getTime(), d.scheduledFor.getTime());
  }
  assert.throws(() => annualDeliveryDueAt(ANCHOR, 0), /1\.\.13/);
  assert.throws(() => annualDeliveryDueAt(ANCHOR, 14), /1\.\.13/);
});

test("18: the plan ends at +364 days, which is 28 days after the last delivery", () => {
  const schedule = buildAnnualDeliverySchedule(ANCHOR);
  const end = annualPlanEndAt(ANCHOR);
  assert.equal(end.getTime() - ANCHOR, 364 * DAY_MS);
  assert.equal(end.getTime() - schedule[12].scheduledFor.getTime(), 28 * DAY_MS);
  assert.equal(end.getTime() - ANCHOR, ANNUAL_TERM_MS);
});

test("19: the schedule is elapsed time, never calendar arithmetic", () => {
  // An anchor deliberately placed so that calendar-month or DST-sensitive
  // arithmetic would give a different answer: late October, across the
  // European clock change, at an hour near midnight.
  const dst = Date.UTC(2026, 9, 20, 23, 40, 0); // 2026-10-20T23:40:00Z
  const schedule = buildAnnualDeliverySchedule(dst);
  for (let i = 1; i < schedule.length; i += 1) {
    assert.equal(
      schedule[i].scheduledFor.getTime() - schedule[i - 1].scheduledFor.getTime(),
      28 * DAY_MS,
      "a gap moved, so the schedule is not exact elapsed time");
  }
  assert.equal(annualPlanEndAt(dst).getTime() - dst, 364 * DAY_MS);

  // Accepts the shapes a trusted paid_at arrives in, and agrees on all.
  const iso = new Date(ANCHOR).toISOString();
  assert.equal(buildAnnualDeliverySchedule(iso)[12].scheduledFor.getTime(),
    buildAnnualDeliverySchedule(ANCHOR)[12].scheduledFor.getTime());
  assert.equal(buildAnnualDeliverySchedule(new Date(ANCHOR))[0].scheduledFor.getTime(), ANCHOR);
  // An unusable anchor throws: there is no safe alternative date.
  for (const bad of ["", "not-a-date", NaN, new Date("nope")]) {
    assert.throws(() => buildAnnualDeliverySchedule(bad), /valid purchase timestamp/);
  }
});

test("20: nothing in the annual rules is monthly", () => {
  for (const banned of [
    "setMonth", "getMonth", "setUTCMonth", "monthly", "Monthly", "monatlich", "Monatlich",
    "addMonths", "365",
  ]) {
    assert.ok(!rulesCode.includes(banned), `lib/annualPlanRules.ts contains ${banned}`);
    assert.ok(!plansCode.includes(banned), `lib/annualPlans.ts contains ${banned}`);
  }
  // Not even the word, once the prose that explains its absence is gone.
  assert.ok(!/month/i.test(rulesCode), "month arithmetic reached the annual rules");
  assert.ok(!/month/i.test(plansCode), "month arithmetic reached the annual plans module");
});

/* ══════════════════════════════════════════════════════════════
   21-24. LAUNCH RESOLUTION AND THE FEATURE GATE
   ══════════════════════════════════════════════════════════════ */

test("21: the three launch SKUs resolve to their sizes, and agree with the rules module", () => {
  assert.deepEqual([...ANNUAL_LAUNCH_SKUS],
    ["GLOA-MATCHA-30G", "GLOA-MATCHA-50G", "GLOA-MATCHA-100G"]);
  // The seam between the two leaf modules: every size the allowlist names
  // is a size the rules module can price, and every weight agrees.
  for (const sku of ANNUAL_LAUNCH_SKUS) {
    const size = ANNUAL_LAUNCH_SIZE_BY_SKU[sku];
    assert.equal(isAnnualSize(size), true, `${sku} maps to an unpriceable size`);
    assert.equal(ANNUAL_SIZE_GRAMS[size], ANNUAL_LAUNCH_GRAMS_BY_SKU[sku],
      `${sku} weight disagrees between the two modules`);
    assert.equal(annualSizeFromGrams(ANNUAL_LAUNCH_GRAMS_BY_SKU[sku]), size);
  }
  assert.equal(ANNUAL_LAUNCH_SKUS.length, ANNUAL_SIZES.length);
  // The same three the flexible subscription allows, and no fourth.
  assert.deepEqual([...ANNUAL_LAUNCH_SKUS].sort(),
    ["GLOA-MATCHA-100G", "GLOA-MATCHA-30G", "GLOA-MATCHA-50G"]);
});

test("22: a canonical variant resolves to a plan the rules can price", () => {
  const r = resolveAnnualLaunchPlan(variant());
  assert.equal(r.ok, true);
  assert.equal(r.plan.size, "50g");
  assert.equal(r.plan.sku, "GLOA-MATCHA-50G");
  assert.equal(r.plan.catalogUnitGrossCents, 2999);
  // End to end, without touching a database: variant -> plan -> money.
  const pricing = buildAnnualPricing({
    size: r.plan.size,
    catalogUnitGrossCents: r.plan.catalogUnitGrossCents,
  });
  assert.equal(pricing.ok, true);
  assert.equal(pricing.pricing.totalGrossCents, 35087);
});

test("23: resolution fails closed on every unsafe path", () => {
  const cases = [
    [undefined, /no canonical variant/],
    [null, /no canonical variant/],
    ["GLOA-MATCHA-50G", /no canonical variant/],
    [variant({ sku: "GLOA-CASE-01" }), /not an annual launch product/],
    [variant({ sku: "GLOA-MATCHA-200G" }), /not an annual launch product/],
    [variant({ sku: "" }), /no sku/],
    [variant({ sku: 50 }), /no sku/],
    // The Metal Case has no weight, and neither has anything annual.
    [variant({ sizeGrams: null }), /weight does not match/],
    [variant({ sizeGrams: 30 }), /weight does not match/],
    [variant({ variantId: "not-a-uuid" }), /no usable id/],
    [variant({ unitGrossCents: 0 }), /no usable catalog price/],
    [variant({ unitGrossCents: -2999 }), /no usable catalog price/],
    [variant({ unitGrossCents: 29.99 }), /no usable catalog price/],
    [variant({ unitGrossCents: "2999" }), /no usable catalog price/],
    [variant({ currency: "USD" }), /EUR only/],
    [variant({ currency: "eur" }), /EUR only/],
  ];
  for (const [input, reason] of cases) {
    const r = resolveAnnualLaunchPlan(input);
    assert.equal(r.ok, false, `accepted: ${JSON.stringify(input)}`);
    assert.match(r.reason, reason);
    assert.equal(r.plan, undefined, "a refusal still returned a plan");
  }
});

test("24: the feature flag is closed by default and follows the existing convention", () => {
  assert.equal(ANNUAL_PLAN_FEATURE_FLAG, "B2C_ANNUAL_PLAN_ENABLED");
  // Only the exact string "true".
  assert.equal(isAnnualPlanCheckoutEnabled({}), false, "an unset flag opened the feature");
  assert.equal(isAnnualPlanCheckoutEnabled({ B2C_ANNUAL_PLAN_ENABLED: undefined }), false);
  for (const closed of ["", " ", "false", "0", "1", "TRUE", "True", "yes", "on", " true ", "true\n"]) {
    assert.equal(isAnnualPlanCheckoutEnabled({ B2C_ANNUAL_PLAN_ENABLED: closed }), false,
      `"${closed}" opened the feature`);
  }
  assert.equal(isAnnualPlanCheckoutEnabled({ B2C_ANNUAL_PLAN_ENABLED: "true" }), true);

  // Character for character the subscription gate's rule, so the codebase
  // has ONE answer to "is this flag on".
  const subs = read("lib/subscriptionCheckoutRules.ts");
  assert.ok(subs.includes('return env[SUBSCRIPTION_FEATURE_FLAG] === "true";'),
    "the subscription flag convention changed");
  assert.ok(plansSource.includes('return env[ANNUAL_PLAN_FEATURE_FLAG] === "true";'),
    "the annual flag does not follow the established convention");

  // Documented in .env.example, unset - an empty value is not "true", so
  // the safe state is the default one. Matches every other flag there.
  const env = read(".env.example");
  assert.match(env, /^B2C_ANNUAL_PLAN_ENABLED=$/m,
    ".env.example does not carry the flag in the house style");
  assert.match(env, /^B2C_SUBSCRIPTIONS_ENABLED=$/m, "the subscription flag entry changed");
  // Server-only: never exposed to the browser bundle.
  assert.ok(!env.includes("VITE_B2C_ANNUAL_PLAN_ENABLED"));
  assert.ok(!env.includes("NEXT_PUBLIC_B2C_ANNUAL_PLAN_ENABLED"));
});

/* ══════════════════════════════════════════════════════════════
   25-27. ARCHITECTURAL GUARDRAILS
   ══════════════════════════════════════════════════════════════ */

test("25: the rules module is a pure leaf, and the plans module nearly one", () => {
  // Zero imports at all: that is what lets the test runner load it, and
  // it is why divideRoundHalfUp is duplicated and asserted in test 7.
  assert.ok(!/^import /m.test(rulesCode), "lib/annualPlanRules.ts gained an import");
  // The plans module may hold the gate, so it reads process.env - but the
  // arithmetic module must not.
  assert.ok(!rulesCode.includes("process.env"), "the arithmetic module reads the environment");
  assert.ok(!rulesCode.includes("Date.now()"), "the arithmetic module reads a clock");
  assert.ok(!rulesCode.includes("new Date()"), "the arithmetic module reads a clock");
  // The plans module's only import is type-only, and therefore erased.
  const plansImports = plansSource.split(String.fromCharCode(10)).filter(l => /^import /.test(l));
  assert.deepEqual(plansImports, ['import type { AnnualSize } from "./annualPlanRules";']);

  for (const [name, code] of [["annualPlanRules", rulesCode], ["annualPlans", plansCode]]) {
    for (const banned of [
      "supabase", "Supabase", "stripe", "Stripe", "resend", "Resend",
      "fetch(", "react", "React", "NextResponse", "createClient",
    ]) {
      assert.ok(!code.includes(banned), `lib/${name}.ts reaches for ${banned}`);
    }
  }
});

test("26: this phase created no Stripe object and no recurring price", () => {
  for (const [name, code] of [["annualPlanRules", rulesCode], ["annualPlans", plansCode]]) {
    for (const banned of [
      "ensureRecurringPrice", "recurring", "subscription_data", "price_data",
      "checkout.sessions", "paymentIntent", "payment_intent", "interval_count",
    ]) {
      assert.ok(!code.includes(banned), `lib/${name}.ts contains ${banned}`);
    }
  }
});

test("27: 039 is untouched, 040 is the highest, and there is no 041", () => {
  const migrations = readdirSync(path.join(ROOT, "supabase/migrations"))
    .filter(f => f.endsWith(".sql")).sort();
  assert.equal(migrations[migrations.length - 1], "040_annual_checkout_retry_fingerprints.sql");
  assert.equal(migrations[migrations.length - 2], "039_b2c_annual_plan_foundation.sql");
  assert.deepEqual(migrations.filter(f => Number(f.slice(0, 3)) > 40), [],
    "a migration 041 or beyond appeared");
  assert.equal(migrations.length, 40);
  // 039 is LIVE and therefore immutable. 040 is NOT APPLIED yet, so it
  // may still be edited in place - that is the whole reason it is a file
  // under review rather than a 041 - and it is the only one that may.
  const changed = execFileSync("git", ["diff", "--name-only", "HEAD", "--", "supabase/migrations/"],
    { cwd: ROOT, encoding: "utf-8" }).trim();
  const live = (changed ? changed.split(NEWLINE) : [])
    .filter(rel => !rel.endsWith("040_annual_checkout_retry_fingerprints.sql"));
  assert.deepEqual(live, [], "a live, immutable migration was edited");
});
