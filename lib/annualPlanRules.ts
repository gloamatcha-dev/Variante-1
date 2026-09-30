/**
 * The commercial arithmetic of the B2C PREPAID annual plan (Phase 4B2).
 *
 * A leaf on purpose: ZERO imports, no database, no network, no Stripe, no
 * environment, no clock. That is what makes every rule below directly
 * unit-testable in a plain Node test, and it is the same property
 * lib/shipping.ts, lib/taxJurisdiction.ts and
 * lib/subscriptionCancellationRules.ts were written for.
 *
 * The zero-import rule is not stylistic. Node cannot resolve this
 * repository's extension-less relative imports, so a module that
 * value-imports "./tax" stops being loadable by the test runner
 * entirely - which is exactly what lib/subscriptionCheckout.ts records
 * about lib/checkoutQuote.ts and lib/verifyUser.ts. Type-only imports are
 * erased and would be fine; there simply are none to make.
 *
 * ── WHAT AN ANNUAL PLAN IS ────────────────────────────────────
 *
 * ONE prepaid payment. THIRTEEN physical deliveries, 28 days apart,
 * delivery 1 on the purchase date and delivery 13 at purchase + 336 days,
 * with the plan running to purchase + 364 days. No renewal, no future
 * charge, no Stripe Subscription and no recurring Stripe Price.
 *
 * It is NEVER described as monthly. A calendar month is 28 to 31 days and
 * would make the delivery rhythm drift against what the customer was
 * told; every duration here is an exact elapsed span, matching migration
 * 039's 672-hour cadence and 8736-hour term to the millisecond.
 *
 * ── WHAT THIS MODULE DOES NOT DECIDE ──────────────────────────
 *
 * It does not read a catalog price - it is GIVEN one. The canonical price
 * lives in product_variants.price_gross_cents and reaches the server
 * through lib/checkoutQuote.ts's buildAuthoritativeQuote, which is the
 * single commercial truth for the shop and stays that way. If the catalog
 * changes, the annual quote changes with it; once a plan is purchased,
 * migration 039 freezes the resulting integers onto public.annual_plans
 * and nothing here can move them.
 *
 * It does not calculate tax. Every figure below is GROSS integer cents.
 * The frozen tax_snapshot and delivery_tax_snapshot that 039 requires are
 * built by the existing lib/tax.ts machinery in the checkout phase, and
 * the VAT-timing question a prepaid thirteen-delivery contract raises is
 * a legal one that is deliberately not answered here.
 *
 * It does not decide who may buy. The feature gate and the launch
 * allowlist live in lib/annualPlans.ts.
 */

/* ── The calendar, which is the v2 cadence ───────────────────── */

/**
 * THE ONE CALENDAR-MONTH RULE, and the whole reason it is a function.
 *
 * A v2 plan delivers once per calendar month on the day it was bought.
 * That sounds trivial and is not, because not every month has every day.
 *
 * ── EVERY DATE IS ANCHOR + N MONTHS, NEVER PREVIOUS + 1 ───────
 *
 * Adding a month to the PREVIOUS occurrence drifts permanently the first
 * time it passes a short month:
 *
 *     31 Jan -> 28 Feb -> 28 Mar -> 28 Apr ...   WRONG, drifted
 *     31 Jan -> 28 Feb -> 31 Mar -> 30 Apr ...   RIGHT, clamped
 *
 * The second sequence is what this returns: the ORIGINAL anchor day is
 * preserved and only clamped down when the target month is too short, so
 * February never moves March.
 *
 * ── IT WORKS ON CALENDAR PARTS, NOT INSTANTS ─────────────────
 *
 * No Date arithmetic across a month boundary, no hours, no timezone and
 * therefore no DST: a delivery is planned for a DAY, and adding months
 * to a timestamp is what makes a 23:30 anchor land on the wrong day when
 * the clocks change. migration 069 does the same thing in SQL against
 * Europe/Berlin, and the focused suite asserts the two agree.
 */
export function addCalendarMonths(
  isoDate: string,
  months: number
): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) throw new Error("addCalendarMonths requires a YYYY-MM-DD date");
  if (!Number.isSafeInteger(months)) throw new Error("addCalendarMonths requires an integer month count");

  const year = Number(m[1]);
  const month = Number(m[2]) - 1;
  const day = Number(m[3]);

  const absolute = year * 12 + month + months;
  const targetYear = Math.floor(absolute / 12);
  const targetMonth = absolute - targetYear * 12;

  // Day 0 of the NEXT month is the last day of the target month, which is
  // where the leap year is handled without a special case.
  const daysInTargetMonth = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const targetDay = Math.min(day, daysInTargetMonth);

  const pad = (n: number) => String(n).padStart(2, "0");
  return `${String(targetYear).padStart(4, "0")}-${pad(targetMonth + 1)}-${pad(targetDay)}`;
}

/**
 * All twelve planned delivery dates for a v2 plan, from its anchor date.
 *
 * Delivery 1 is the anchor itself - the day the money settled - because
 * the first box is prepared as soon as the payment is durable. The other
 * eleven are the same calendar day in each following month, clamped.
 */
export function annualMonthlyScheduleDates(
  anchorIsoDate: string,
  deliveryCount: number = ANNUAL_DELIVERY_COUNT
): string[] {
  if (!Number.isSafeInteger(deliveryCount) || deliveryCount < 1 || deliveryCount > 24) {
    throw new Error("annualMonthlyScheduleDates requires a sane delivery count");
  }
  const dates: string[] = [];
  for (let n = 0; n < deliveryCount; n += 1) {
    dates.push(addCalendarMonths(anchorIsoDate, n));
  }
  return dates;
}

/**
 * When a v2 plan's term ends: ONE CALENDAR YEAR after the anchor.
 *
 * Not "after the last delivery" and not 364 days. An anchor of
 * 29.09.2026 ends 29.09.2027, which is one clear month after the twelfth
 * delivery on 29.08.2027 - so the term still covers every delivery it
 * promised, which is what complete_due_annual_plans depends on.
 */
export function annualMonthlyPlanEndDate(anchorIsoDate: string): string {
  return addCalendarMonths(anchorIsoDate, 12);
}

/* ── The shape of the contract ───────────────────────────────── */

/* ── TWO SCHEDULE MODELS, AND WHY BOTH MUST SURVIVE ──────────
 *
 * The annual plan sold until migration 069 was THIRTEEN deliveries every
 * 28 days. The plan sold after it is TWELVE deliveries, one per calendar
 * month. Both are real contracts: plans bought under the first model are
 * still running, still owe deliveries on 28-day steps, and a customer
 * looking at one must be shown the terms THEY bought.
 *
 * So the model is a value on the row, not a constant in this file, and
 * every surface that describes an EXISTING plan reads the row. The
 * constants below describe only what a NEW purchase gets.
 *
 * Nothing here backfills or reinterprets a v1 plan. Migration 069's own
 * default for existing rows is v1, and its CHECK admits both counts.
 */
export type AnnualScheduleModel = "v1_28d_13" | "v2_monthly_12";

/** Thirteen deliveries, every 28 days. Sold until migration 069. */
export const ANNUAL_SCHEDULE_MODEL_V1: AnnualScheduleModel = "v1_28d_13";

/** Twelve deliveries, one per calendar month. Sold from migration 069. */
export const ANNUAL_SCHEDULE_MODEL_V2: AnnualScheduleModel = "v2_monthly_12";

/** What a purchase made TODAY gets. The only model the checkout writes. */
export const ANNUAL_SCHEDULE_MODEL_CURRENT: AnnualScheduleModel = ANNUAL_SCHEDULE_MODEL_V2;

export type AnnualScheduleModelTerms = {
  deliveryCount: number;
  /** 28 for the fixed-step model, null when the cadence is the calendar. */
  intervalDays: number | null;
  /** What the customer is told the rhythm is. */
  cadenceLabel: string;
  /** How long the whole term runs, as the model expresses it. */
  termLabel: string;
};

/**
 * The two contracts, side by side, as the only place either is defined.
 *
 * A reader comparing a v1 card with a v2 card should be able to see from
 * this table alone why they say different things.
 */
export const ANNUAL_SCHEDULE_MODELS: Readonly<Record<AnnualScheduleModel, AnnualScheduleModelTerms>> =
  Object.freeze({
    v1_28d_13: Object.freeze({
      deliveryCount: 13,
      intervalDays: 28,
      cadenceLabel: "alle 4 Wochen",
      termLabel: "13 Lieferungen im 28-Tage-Rhythmus",
    }),
    v2_monthly_12: Object.freeze({
      deliveryCount: 12,
      intervalDays: null,
      cadenceLabel: "monatlich",
      termLabel: "12 Lieferungen, eine pro Kalendermonat",
    }),
  });

/**
 * WHICH MODEL A STORED PLAN WAS SOLD UNDER.
 *
 * The column first, because it is the authority. A row written before
 * migration 069 has no model recorded, so the COUNT decides - thirteen
 * deliveries is v1 and is the only thing it can be. An unrecognised
 * value falls back to v1 rather than to the current model: describing an
 * old contract with today's terms is the one error that rewrites
 * history, and guessing "current" is exactly how that happens.
 */
export function annualScheduleModelOf(plan: {
  scheduleModel?: string | null;
  deliveryCount?: number | null;
}): AnnualScheduleModel {
  if (plan?.scheduleModel === ANNUAL_SCHEDULE_MODEL_V2) return ANNUAL_SCHEDULE_MODEL_V2;
  if (plan?.scheduleModel === ANNUAL_SCHEDULE_MODEL_V1) return ANNUAL_SCHEDULE_MODEL_V1;
  if (plan?.deliveryCount === ANNUAL_SCHEDULE_MODELS.v2_monthly_12.deliveryCount) {
    return ANNUAL_SCHEDULE_MODEL_V2;
  }
  return ANNUAL_SCHEDULE_MODEL_V1;
}

/** The rhythm sentence for ONE stored plan, never a module-wide default. */
export function annualCadenceLabelOf(plan: {
  scheduleModel?: string | null;
  deliveryCount?: number | null;
}): string {
  return ANNUAL_SCHEDULE_MODELS[annualScheduleModelOf(plan)].cadenceLabel;
}

/** Twelve deliveries. What a NEW plan gets; admitted by 069's CHECK. */
export const ANNUAL_DELIVERY_COUNT =
  ANNUAL_SCHEDULE_MODELS.v2_monthly_12.deliveryCount;

/** Thirteen. What plans sold before migration 069 have, and keep. */
export const ANNUAL_LEGACY_DELIVERY_COUNT =
  ANNUAL_SCHEDULE_MODELS.v1_28d_13.deliveryCount;

/**
 * 28 days - THE LEGACY CADENCE ONLY.
 *
 * Kept because v1 plans still ship on it and migrations 039/066/067
 * store it as 672 hours, which the focused suites pin. A NEW plan has no
 * fixed interval at all: its cadence is the calendar, which is what
 * annualMonthlyScheduleDates computes.
 */
export const ANNUAL_DELIVERY_INTERVAL_DAYS =
  ANNUAL_SCHEDULE_MODELS.v1_28d_13.intervalDays as number;

/**
 * The same cadence in hours, which is the unit migration 039 stores it
 * in: make_interval(hours => 672 * (n - 1)). Restated rather than
 * imported, because 039 is SQL and this is TypeScript; the focused suite
 * asserts the two agree.
 */
export const ANNUAL_DELIVERY_INTERVAL_HOURS = ANNUAL_DELIVERY_INTERVAL_DAYS * 24;

/**
 * 364 days - THE LEGACY TERM ONLY. Thirteen whole 28-day periods.
 *
 * Rebased on the LEGACY count deliberately: this value is what migration
 * 039 froze as 8736 hours on plans that already exist, so it must not
 * move when the current count does. A v2 plan's term is one calendar
 * YEAR from its anchor instead - see annualMonthlyPlanEndDate.
 */
export const ANNUAL_TERM_DAYS = ANNUAL_DELIVERY_INTERVAL_DAYS * ANNUAL_LEGACY_DELIVERY_COUNT;

/** 8736 hours, as migration 039 stores it. */
export const ANNUAL_TERM_HOURS = ANNUAL_TERM_DAYS * 24;

const HOUR_MS = 60 * 60 * 1000;

/**
 * The cadence as an exact elapsed duration.
 *
 * lib/subscriptionCancellationRules.ts pins the flexible plan's four
 * weeks the same way and says why: 28 days is always 2 419 200 000 ms,
 * whereas calendar arithmetic across a DST boundary is 27 days 23 hours
 * or 28 days 1 hour. A schedule the customer was promised must not depend
 * on which time zone the server happened to be in.
 */
export const ANNUAL_DELIVERY_INTERVAL_MS = ANNUAL_DELIVERY_INTERVAL_HOURS * HOUR_MS;

/** 364 days as an exact elapsed duration, for the same reason. */
export const ANNUAL_TERM_MS = ANNUAL_TERM_HOURS * HOUR_MS;

/* ── The discount ────────────────────────────────────────────── */

/**
 * Ten percent off the canonical catalog price, per delivery.
 *
 * Stored as an integer percentage rather than a rate, because it is
 * frozen into annual_plans.discount_percent_applied, which is numeric -
 * exact - and because a rate would invite floating-point money.
 */
export const ANNUAL_DISCOUNT_PERCENT = 10;

/** What the customer actually pays, as a percentage. Derived, not typed twice. */
export const ANNUAL_RETAINED_PERCENT = 100 - ANNUAL_DISCOUNT_PERCENT;

/* ── The launch sizes ────────────────────────────────────────── */

/**
 * The three Matcha sizes offered as an annual plan at launch.
 *
 * A closed union rather than a string, so a fourth size cannot become
 * annual-eligible by omission: adding one means editing this type and
 * every table keyed on it, which is a review rather than an accident.
 */
export type AnnualSize = "30g" | "50g" | "100g";

/** The three, in catalog order, for iteration and validation. */
export const ANNUAL_SIZES: readonly AnnualSize[] = Object.freeze(["30g", "50g", "100g"] as const);

/** Net weight in grams for each annual size. The cross-check a SKU is validated against. */
export const ANNUAL_SIZE_GRAMS: Readonly<Record<AnnualSize, number>> = Object.freeze({
  "30g": 30,
  "50g": 50,
  "100g": 100,
});

/** Narrows untrusted input to a supported annual size. Anything else is null. */
export function isAnnualSize(value: unknown): value is AnnualSize {
  return typeof value === "string" && (ANNUAL_SIZES as readonly string[]).includes(value);
}

/**
 * The annual size for a net weight in grams, or null.
 *
 * Null is a real answer: a variant this shop sells but does not offer
 * annually - or a new weight nobody has priced annually - must stop the
 * flow rather than silently acquire a discount and a shipping rule.
 */
export function annualSizeFromGrams(sizeGrams: number | null | undefined): AnnualSize | null {
  if (typeof sizeGrams !== "number" || !Number.isSafeInteger(sizeGrams)) return null;
  for (const size of ANNUAL_SIZES) {
    if (ANNUAL_SIZE_GRAMS[size] === sizeGrams) return size;
  }
  return null;
}

/* ── Annual shipping ─────────────────────────────────────────── */

/**
 * Shipping charged PER DELIVERY on a German annual plan, in gross cents.
 *
 * ── THIS IS DELIBERATELY NOT DERIVED FROM lib/shipping.ts ─────
 *
 * The shop's German rule is 590 cents with free shipping once the
 * merchandise subtotal reaches 4900. Applying that rule to the annual
 * unit prices would produce 590 / 590 / 0 - and the third of those only
 * because 4949 happens to sit 49 cents above the threshold.
 *
 * Free shipping on 50 g and 100 g is an explicit ANNUAL-PLAN BENEFIT, not
 * a coincidence of a threshold that marketing may move next quarter. If
 * the threshold rose to 5000, deriving would silently start charging 100 g
 * annual customers 5.90 per delivery, thirteen times over, for a plan
 * that was sold as free shipping. So the annual outcome is stated here
 * and frozen onto annual_plans.shipping_per_delivery_gross_cents at
 * purchase, exactly as migration 039 requires.
 *
 * lib/shipping.ts is not imported, not read and not modified. The normal
 * shop and the flexible subscription keep their rules untouched.
 */
export const ANNUAL_SHIPPING_PER_DELIVERY_GROSS_CENTS: Readonly<Record<AnnualSize, number>> = Object.freeze({
  "30g": 590,
  "50g": 590,
  "100g": 590,
});

/**
 * Total on the closed union, so every supported size has an answer and
 * TypeScript refuses a call for anything else. Untrusted input is
 * narrowed by isAnnualSize or annualSizeFromGrams first.
 */
export function annualShippingPerDeliveryGrossCents(size: AnnualSize): number {
  return ANNUAL_SHIPPING_PER_DELIVERY_GROSS_CENTS[size];
}

/**
 * The smallest annual size whose deliveries ship free, in grams.
 *
 * DERIVED from the table above rather than typed, so any sentence built
 * from it cannot outlive the rule: if 50 g ever started costing
 * something this becomes 100 and the copy follows by itself. Null would
 * mean nothing ships free, and the surfaces then say nothing at all.
 *
 * The same DERIVED shape lib/subscriptionPurchaseRules.ts uses for its
 * own shipping wording, and for the same reason. They remain separate
 * decisions about separate products: neither file imports the other, and
 * neither number is copied from the other.
 *
 * And since 2026-09-27 they genuinely disagree. The monthly subscription
 * dropped its free-shipping benefit entirely - every size pays 5,90 per
 * delivery there, and its SUBSCRIPTION_FREE_SHIPPING_FROM_GRAMS is gone
 * rather than null. The PREPAID ANNUAL PLAN is untouched: it is a
 * different contract, paid once for thirteen deliveries, and 50 g upward
 * still ships free in it. Being able to differ is the whole point of the
 * two tables being separate authorities.
 */
export const ANNUAL_FREE_SHIPPING_FROM_GRAMS: number | null = (() => {
  const free = ANNUAL_SIZES
    .filter(size => ANNUAL_SHIPPING_PER_DELIVERY_GROSS_CENTS[size] === 0)
    .map(size => ANNUAL_SIZE_GRAMS[size]);
  return free.length === 0 ? null : Math.min(...free);
})();

/**
 * "Kostenloser Versand ab 50 g." - the annual shipping rule as ONE line,
 * for the surfaces that must state it BEFORE a size is chosen.
 *
 * PRESENTATION ONLY. It restates what the table above already decided
 * and adds no rule of its own; buildAnnualPricing is untouched and the
 * server still prices every plan exactly as it did before.
 *
 * Germany is not repeated inside this sentence, and that is the one
 * difference from the subscription note. Every annual surface already
 * carries ANNUAL_GERMANY_ONLY_NOTE and the plan ships nowhere else, so
 * there is no second destination a reader could mistake it for - while
 * the subscription note appears on a shop page that does reach other
 * countries and therefore has to name the one it means.
 */
export const ANNUAL_FREE_SHIPPING_NOTE: string | null =
  ANNUAL_FREE_SHIPPING_FROM_GRAMS === null
    ? null
    : `Kostenloser Versand ab ${ANNUAL_FREE_SHIPPING_FROM_GRAMS} g.`;
/* ── Money ───────────────────────────────────────────────────── */

/**
 * Integer division rounded half away from zero, for non-negative inputs.
 *
 * A DELIBERATE DUPLICATE of lib/tax.ts's divideRoundHalfUp, character for
 * character, and the focused suite imports BOTH and asserts they agree
 * across the whole plausible range rather than trusting this comment.
 *
 * It is duplicated because it cannot be imported: this module is a leaf
 * so that the test runner can load it, and a value import of "./tax"
 * would break that. The repository already resolves this exact tension
 * the same way - lib/transactionalEmailRetryRules.ts and
 * lib/internalOrderNotificationRetryRules.ts each define
 * STALE_SENDING_AFTER_MS, and the suite asserts the two are equal,
 * noting that "two leaf modules cannot import each other, so the
 * duplication is asserted instead".
 *
 * Written as floor((2n + d) / 2d) so the half-up decision is made in
 * integer arithmetic instead of on a float that may already have drifted.
 */
export function divideRoundHalfUp(numerator: number, denominator: number): number {
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator)) {
    throw new Error("divideRoundHalfUp requires safe integers");
  }
  if (numerator < 0 || denominator <= 0) {
    throw new Error("divideRoundHalfUp requires a non-negative numerator and a positive denominator");
  }
  return Math.floor((2 * numerator + denominator) / (2 * denominator));
}

/**
 * What one delivery costs on an annual plan, from the canonical catalog
 * price for that variant.
 *
 * Ninety percent of the catalog price, in integer cents throughout: the
 * multiplication happens before the division, so no intermediate value is
 * ever fractional. For the launch catalog this is
 * 1999 -> 1799, 2999 -> 2699, 5499 -> 4949.
 */
export function annualUnitGrossCents(catalogUnitGrossCents: number): number {
  if (!Number.isSafeInteger(catalogUnitGrossCents) || catalogUnitGrossCents <= 0) {
    throw new Error("annualUnitGrossCents requires a positive integer catalog price in cents");
  }
  return divideRoundHalfUp(catalogUnitGrossCents * ANNUAL_RETAINED_PERCENT, 100);
}

/** Every gross integer-cent figure a purchase needs, and nothing else. */
export type AnnualPricing = {
  size: AnnualSize;
  /** The canonical catalog price this was calculated from. Frozen for the savings line. */
  catalogUnitGrossCents: number;
  annualUnitGrossCents: number;
  /** Recorded, never used in the arithmetic: the cents above are the truth. */
  discountPercentApplied: number;
  shippingPerDeliveryGrossCents: number;
  deliveryCount: number;
  merchandiseTotalGrossCents: number;
  shippingTotalGrossCents: number;
  totalGrossCents: number;
};

export type AnnualPricingResult =
  | { ok: true; pricing: AnnualPricing }
  | { ok: false; reason: string };

/**
 * The whole commercial calculation, from an annual size and a canonical
 * catalog price.
 *
 * Both inputs are typed `unknown` and validated here, because this is a
 * server boundary: the size ultimately derives from a catalog row and the
 * price from product_variants, but neither is trusted on shape. An
 * unsupported size FAILS CLOSED with a reason - it never falls back to a
 * default discount or a default shipping amount, which would sell a plan
 * nobody priced.
 *
 * The three totals are DERIVED, never supplied. That is what lets the
 * future checkout route hand migration 039 numbers no browser could have
 * chosen, and it mirrors what create_pending_annual_plan_for_attempt
 * already does in SQL: it takes the per-delivery integers and computes
 * the totals itself rather than accepting them.
 */
export function buildAnnualPricing(input: {
  size: unknown;
  catalogUnitGrossCents: unknown;
}): AnnualPricingResult {
  if (!isAnnualSize(input.size)) {
    return { ok: false, reason: "size is not a supported annual launch size" };
  }
  const catalog = input.catalogUnitGrossCents;
  if (typeof catalog !== "number" || !Number.isSafeInteger(catalog) || catalog <= 0) {
    return { ok: false, reason: "catalog unit price must be a positive integer in cents" };
  }

  const unit = annualUnitGrossCents(catalog);
  const shippingPerDelivery = annualShippingPerDeliveryGrossCents(input.size);

  const merchandiseTotal = unit * ANNUAL_DELIVERY_COUNT;
  const shippingTotal = shippingPerDelivery * ANNUAL_DELIVERY_COUNT;
  // TWELVE of each, because ANNUAL_DELIVERY_COUNT is the CURRENT model's
  // count. A v1 plan's totals are not recomputed here and never were -
  // they are frozen on the row by migration 039.
  const total = merchandiseTotal + shippingTotal;

  if (!Number.isSafeInteger(merchandiseTotal) || !Number.isSafeInteger(total)) {
    return { ok: false, reason: "annual total exceeds the safe integer range" };
  }

  return {
    ok: true,
    pricing: {
      size: input.size,
      catalogUnitGrossCents: catalog,
      annualUnitGrossCents: unit,
      discountPercentApplied: ANNUAL_DISCOUNT_PERCENT,
      shippingPerDeliveryGrossCents: shippingPerDelivery,
      deliveryCount: ANNUAL_DELIVERY_COUNT,
      merchandiseTotalGrossCents: merchandiseTotal,
      shippingTotalGrossCents: shippingTotal,
      totalGrossCents: total,
    },
  };
}

/* ── The savings line ────────────────────────────────────────── */

/** What thirteen ordinary purchases would have cost, and what the plan saves. */
export type AnnualSavings = {
  deliveryCount: number;
  /** The catalog price a flexible customer pays per delivery. */
  flexibleUnitGrossCents: number;
  /** What the SHOP's own shipping rule charges that customer per delivery. */
  flexibleShippingPerDeliveryGrossCents: number;
  flexibleTotalGrossCents: number;
  annualTotalGrossCents: number;
  savingsGrossCents: number;
};

export type AnnualSavingsResult =
  | { ok: true; savings: AnnualSavings }
  | { ok: false; reason: string };

/**
 * The comparison the "Du sparst X" line will later be built from.
 *
 * ── WHY THE FLEXIBLE SHIPPING IS AN ARGUMENT ──────────────────
 *
 * The annual side states its shipping explicitly, for the reason recorded
 * above. The FLEXIBLE side must not: it is a description of what the shop
 * really charges today, so it has to come from lib/shipping.ts's
 * computeShippingGrossCents and stay correct when that rule changes.
 *
 * This module cannot import that function without ceasing to be
 * unit-testable, and copying the 4900 threshold here would create a
 * second answer to "what does the shop charge for shipping" - the exact
 * coupling the annual rule exists to avoid, pointed the other way. So the
 * caller, which can import lib/shipping.ts freely, supplies the one
 * number, and the arithmetic that turns it into a savings figure stays
 * pure and testable.
 *
 * NOTHING HERE IS A STORED CONSTANT. The savings for the current catalog
 * are 2600, 11570 and 7150 cents; none of those appears in this file.
 * They fall out of the catalog price, the shop's shipping rule and the
 * annual pricing, and they change the moment any of the three does.
 */
export function buildAnnualSavings(input: {
  pricing: AnnualPricing;
  flexibleShippingPerDeliveryGrossCents: unknown;
}): AnnualSavingsResult {
  const flexibleShipping = input.flexibleShippingPerDeliveryGrossCents;
  if (
    typeof flexibleShipping !== "number" ||
    !Number.isSafeInteger(flexibleShipping) ||
    flexibleShipping < 0
  ) {
    return { ok: false, reason: "flexible shipping must be a non-negative integer in cents" };
  }

  const { catalogUnitGrossCents, totalGrossCents, deliveryCount } = input.pricing;
  const flexibleTotal = (catalogUnitGrossCents + flexibleShipping) * deliveryCount;
  const savings = flexibleTotal - totalGrossCents;

  if (!Number.isSafeInteger(flexibleTotal)) {
    return { ok: false, reason: "flexible total exceeds the safe integer range" };
  }
  if (savings < 0) {
    // Not an arithmetic failure but a commercial one: an annual plan that
    // costs MORE than buying thirteen times must never be advertised as a
    // saving, so this refuses rather than printing a negative.
    return { ok: false, reason: "the annual plan is not cheaper than thirteen flexible purchases" };
  }

  return {
    ok: true,
    savings: {
      deliveryCount,
      flexibleUnitGrossCents: catalogUnitGrossCents,
      flexibleShippingPerDeliveryGrossCents: flexibleShipping,
      flexibleTotalGrossCents: flexibleTotal,
      annualTotalGrossCents: totalGrossCents,
      savingsGrossCents: savings,
    },
  };
}

/* ── The schedule ────────────────────────────────────────────── */

/** One planned delivery. The ordinal is 1-based, as annual_plan_deliveries stores it. */
export type AnnualScheduledDelivery = {
  deliveryNumber: number;
  scheduledFor: Date;
};

/**
 * Normalises a trusted purchase anchor to epoch milliseconds.
 *
 * THROWS rather than returning a failure, and the distinction is
 * deliberate. The anchor is checkout_attempts.paid_at, written by
 * markAttemptPaid at the moment payment was verified, and migration 039
 * refuses to activate a plan whose paid_at is NULL. An unparseable value
 * here is therefore an internal inconsistency, not untrusted input, and
 * there is no safe "closed" answer to fall back to: silently choosing a
 * different anchor would move all thirteen deliveries.
 */
function anchorMillis(purchasedAt: Date | string | number): number {
  const millis =
    purchasedAt instanceof Date
      ? purchasedAt.getTime()
      : typeof purchasedAt === "number"
        ? purchasedAt
        : Date.parse(purchasedAt);
  if (!Number.isFinite(millis)) {
    throw new Error("annual schedule requires a valid purchase timestamp");
  }
  return millis;
}

/**
 * When delivery n is due, counted from the purchase.
 *
 * delivery 1 is the purchase itself (+0), and each later one is exactly
 * 28 days further out. This is the TypeScript twin of migration 039's
 * `v_purchased + make_interval(hours => 672 * (n - 1))`, and the focused
 * suite asserts the two describe the same offsets.
 */
export function annualDeliveryDueAt(purchasedAt: Date | string | number, deliveryNumber: number): Date {
  if (!Number.isInteger(deliveryNumber) || deliveryNumber < 1
      || deliveryNumber > ANNUAL_LEGACY_DELIVERY_COUNT) {
    throw new Error(`delivery number must be 1..${ANNUAL_LEGACY_DELIVERY_COUNT}`);
  }
  return new Date(anchorMillis(purchasedAt) + (deliveryNumber - 1) * ANNUAL_DELIVERY_INTERVAL_MS);
}

/**
 * All thirteen dates, frozen in one pass.
 *
 * The whole sequence is derived from the anchor rather than from the
 * previous delivery, which is what makes a late run unable to push the
 * rest of the year out: 039 stores these once at activation and never
 * recomputes them.
 */
/*
  THE v1 ENGINE, AND ONLY v1.

  Thirteen deliveries on fixed 28-day steps from the purchase instant.
  Migration 069 did not change it and must not: plans sold under that
  contract are still running on exactly these dates, and migration 039
  froze them as 672-hour steps.

  A v2 plan's dates come from annualMonthlyScheduleDates instead, which
  is calendar arithmetic and shares nothing with this.
*/
export function buildAnnualDeliverySchedule(
  purchasedAt: Date | string | number
): AnnualScheduledDelivery[] {
  const anchor = anchorMillis(purchasedAt);
  const schedule: AnnualScheduledDelivery[] = [];
  for (let deliveryNumber = 1; deliveryNumber <= ANNUAL_LEGACY_DELIVERY_COUNT; deliveryNumber += 1) {
    schedule.push({
      deliveryNumber,
      scheduledFor: new Date(anchor + (deliveryNumber - 1) * ANNUAL_DELIVERY_INTERVAL_MS),
    });
  }
  return schedule;
}

/**
 * When the contract ends: purchase + 364 days.
 *
 * 28 days AFTER the thirteenth delivery, not on it. The last delivery has
 * its own four-week period like every other, which is why 039 completes a
 * plan only once the term has run out AND all thirteen boxes shipped.
 */
export function annualPlanEndAt(purchasedAt: Date | string | number): Date {
  return new Date(anchorMillis(purchasedAt) + ANNUAL_TERM_MS);
}
