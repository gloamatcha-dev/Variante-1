/**
 * THE ONE AUTHORITY ON WHAT GLOA'S B2B MATCHA COSTS.
 *
 * A leaf, deliberately: no relative import, no database, no network, no
 * Stripe, no clock, no environment. That is what lets the server price a
 * contract from it, a browser render the same figures, and a plain Node
 * test drive every rule directly - the same property lib/tax.ts,
 * lib/shipping.ts and lib/annualPlanRules.ts were written for.
 *
 * ── WHAT THIS FILE IS NOT ─────────────────────────────────────
 *
 * It is NOT lib/b2bCalculator.ts. That module is a ROI COMPARISON: it
 * takes a price per kilo and a discount as ARGUMENTS, from rows the
 * caller supplies, and answers "how would this compare to what the
 * customer pays today". It states no price of its own and never has.
 * The two do not overlap and neither imports the other, so there is one
 * price authority in this repository and it is this file.
 *
 * It holds NO SHIPPING CONSTANT. Berlin, DHL, weight tiers, tare and
 * packaging belong to the B2B shipping leaf, which is a separate
 * decision about a separate cost. A shipping amount appearing here would
 * be a second answer to a question this file is not asked.
 *
 * It performs NO VAT CALCULATION. Every figure below is NET. B2B prices
 * are quoted net and lib/tax.ts stays the single tax authority - it will
 * gain the net-origin direction it does not have yet, and it will do so
 * there rather than here.
 *
 * ── INTEGER CENTS, EVERYWHERE ─────────────────────────────────
 *
 * Not one euro value is a float. A contract that runs twelve months and
 * splits into instalments is exactly where a half-cent becomes a
 * customer-visible discrepancy, so every amount is an integer number of
 * cents and every division states its rounding.
 */

/* ── Version ────────────────────────────────────────────────── */

/**
 * Bumped whenever a rule below changes the money it produces.
 *
 * It is written into the frozen contract snapshot, exactly as
 * TAX_CALCULATION_VERSION is written into a tax snapshot, so a contract
 * priced last quarter can be reproduced after the rules move. Without it
 * "why does this agreement say 535,50" becomes archaeology.
 */
export const B2B_PRICING_RULES_VERSION = "b2b-2026.1";

/* ── The commercial pack ────────────────────────────────────── */

/** The only currency this file speaks. */
export const B2B_CURRENCY = "EUR";

/** The commercial unit. Quantities are counted in packs, never in kilos. */
export const B2B_PACK_GRAMS = 500;

/**
 * 52,50 EUR NET per 500 g pack = 105,00 EUR NET per kilo.
 *
 * Stated as the PACK price rather than a rate per kilo, and that is a
 * deliberate correction of the first draft. Migration 053 retired
 * b2b_product_sizes precisely because "a rate per kilo" is the wrong
 * shape for a price list - it cannot express a price that is agreed per
 * pack, and deriving 52,50 from 105,00 invites a second rounding nobody
 * asked for. The pack is the thing GLOA sells, so the pack carries the
 * price.
 */
export const PACK_NET_CENTS = 5250;

/** The smallest order: one pack, 0,5 kg. */
export const B2B_MIN_PACKS = 1;

/**
 * The largest order this shop prices WITHOUT a human.
 *
 * Ten packs is 5,0 kg. Above it the answer is an individual B2B enquiry,
 * not a bigger number: a larger shipment leaves the carrier tiers that
 * were measured for it, and quoting a price whose delivery nobody has
 * costed is the mistake this ceiling exists to prevent. The ceiling is a
 * COMMERCIAL limit expressed here; the shipping leaf will refuse
 * independently on weight, and both refusing is the intent.
 */
export const B2B_SELF_SERVICE_MAX_PACKS = 10;

/* ── The annual plan ────────────────────────────────────────── */

/** Twelve monthly deliveries. Fixed term, no automatic renewal. */
export const B2B_ANNUAL_DELIVERY_COUNT = 12;

/** 15 % off the Matcha product total. Shipping never participates. */
export const B2B_ANNUAL_DISCOUNT_PERCENT = 15;

/** Derived, so the two can never drift apart. */
export const B2B_ANNUAL_RETAINED_PERCENT = 100 - B2B_ANNUAL_DISCOUNT_PERCENT;

/**
 * The payment schedules an annual contract may choose.
 *
 * One, two or four product payments across a term that always delivers
 * twelve times. Payment frequency and delivery frequency are separate
 * facts about the same contract, and this list is the whole of the first
 * one. A count outside it is refused rather than approximated.
 */
export const B2B_INSTALMENT_COUNTS: readonly number[] = Object.freeze([1, 2, 4]);

/* ── Arithmetic ─────────────────────────────────────────────── */

/**
 * Integer division rounded half away from zero, for non-negative inputs.
 *
 * A DELIBERATE DUPLICATE of lib/tax.ts's and lib/annualPlanRules.ts's
 * function of the same name, character for character, and the focused
 * suite imports both and asserts they agree rather than trusting this
 * comment. It is duplicated because it cannot be imported: this module
 * is a leaf so the test runner can load it, and a value import of
 * "./tax" would end that. The repository already resolves this exact
 * tension the same way in lib/annualPlanRules.ts, which notes that "two
 * leaf modules cannot import each other, so the duplication is asserted
 * instead".
 *
 * Written as floor((2n + d) / 2d) so the half-up decision happens in
 * integer arithmetic rather than on a float that may already have drifted.
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

/* ── Quantity ───────────────────────────────────────────────── */

/**
 * Whether this pack count may be bought without speaking to anyone.
 *
 * FAILS CLOSED on every path: a non-integer, a NaN, an Infinity, a
 * string that looks like a number, zero, a negative and anything above
 * the ceiling all answer false. There is no clamping - silently turning
 * 11 packs into 10 would sell somebody a quantity they did not order,
 * and turning 0 into 1 would invent a contract.
 */
export function isSelfServicePackCount(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= B2B_MIN_PACKS
    && value <= B2B_SELF_SERVICE_MAX_PACKS;
}

/** Packs as kilograms, for display. Exact: 500 g halves cleanly. */
export function packsToKilograms(packs: number): number {
  if (!Number.isSafeInteger(packs) || packs < 0) {
    throw new Error("packsToKilograms requires a non-negative integer pack count");
  }
  return (packs * B2B_PACK_GRAMS) / 1000;
}

/**
 * Kilograms back to packs, or null when the amount is not a whole number
 * of packs. Null is a real answer: 0,7 kg is not an order this shop can
 * fill, and rounding it to one pack or two would both be wrong.
 */
export function kilogramsToPacks(kilograms: unknown): number | null {
  if (typeof kilograms !== "number" || !Number.isFinite(kilograms) || kilograms <= 0) return null;
  const grams = Math.round(kilograms * 1000);
  // Guard the rounding above: 0,5000001 kg is not 1 pack.
  if (Math.abs(grams - kilograms * 1000) > 1e-6) return null;
  if (grams % B2B_PACK_GRAMS !== 0) return null;
  return grams / B2B_PACK_GRAMS;
}

/* ── The monthly subscription ───────────────────────────────── */

/**
 * What the product costs per month on the ordinary subscription.
 *
 * No discount, by decision: the monthly plan buys flexibility and the
 * annual plan buys the discount. Throws rather than returning null,
 * because every caller has already narrowed the pack count through
 * isSelfServicePackCount - reaching here with an invalid one is a
 * programming error, not a customer input.
 */
export function monthlyProductNetCents(packs: number): number {
  if (!isSelfServicePackCount(packs)) {
    throw new Error("monthlyProductNetCents requires a self-service pack count");
  }
  return packs * PACK_NET_CENTS;
}

/* ── The annual contract amount ─────────────────────────────── */

/**
 * The UNDISCOUNTED Matcha total for a full twelve-month term.
 *
 * Kept as its own exported function rather than inlined, because it is
 * the number the 15 % is measured against and the one a customer is
 * shown as "statt". If it were computed twice, the saving displayed and
 * the saving granted could differ.
 */
export function baseAnnualProductNetCents(packs: number): number {
  return monthlyProductNetCents(packs) * B2B_ANNUAL_DELIVERY_COUNT;
}

/**
 * ══════════════════════════════════════════════════════════════
 * THE FROZEN CONTRACT AMOUNT. THE ONE NUMBER THAT MATTERS.
 * ══════════════════════════════════════════════════════════════
 *
 * Fifteen percent off the FULL TWELVE-MONTH BASE TOTAL, rounded exactly
 * once, at the end.
 *
 * ── WHY NOT DISCOUNT THE MONTHLY PACK FIRST ───────────────────
 *
 * Because it does not produce fifteen percent. Discounting one 500 g
 * pack gives 5250 x 85 / 100 = 4462,5, which rounds UP to 4463 - and
 * that half-cent is then multiplied by the pack count and by twelve
 * months. At ten packs the contract ends up 60 cents above the agreed
 * price, and the "15 %" on the page is no longer the 15 % in the
 * contract. Discounting the annual base instead gives 630,00 - 94,50 =
 * 535,50 for one pack, and the ratio is exactly 0,85 at every quantity.
 *
 * This is the AUTHORITY. The monthly equivalent below is derived FROM
 * this number for display; this number is never derived from it.
 */
export function annualProductNetCents(packs: number): number {
  return divideRoundHalfUp(baseAnnualProductNetCents(packs) * B2B_ANNUAL_RETAINED_PERCENT, 100);
}

/** What the customer saves over the term. Derived, never stated. */
export function annualSavingNetCents(packs: number): number {
  return baseAnnualProductNetCents(packs) - annualProductNetCents(packs);
}

/* ── Instalments ────────────────────────────────────────────── */

/** Whether this is one of the approved payment schedules. */
export function isInstalmentCount(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && B2B_INSTALMENT_COUNTS.includes(value);
}

/**
 * Splits a frozen total across instalments without losing or inventing a
 * cent.
 *
 * Every instalment but the last takes floor(total / count); the LAST one
 * takes whatever remains. The remainder lands at the end rather than the
 * beginning on purpose: the customer's first payment is the one they
 * agreed to on the page, and a first instalment two cents above the
 * quoted figure is the one place this would be noticed.
 *
 * The sum is asserted before returning. It cannot fail by construction,
 * which is exactly why the assertion is cheap and worth having - it
 * turns "this arithmetic is obviously right" into a checked property
 * that survives someone editing the formula.
 *
 * Generic on the total, so it can split a shipping or a tax figure later
 * with the same guarantees; strict on the count, so it can only ever
 * produce a schedule this business actually offers.
 */
export function allocateInstalments(totalNetCents: number, instalmentCount: number): number[] {
  if (!Number.isSafeInteger(totalNetCents) || totalNetCents < 0) {
    throw new Error("allocateInstalments requires a non-negative integer total in cents");
  }
  if (!isInstalmentCount(instalmentCount)) {
    throw new Error(`allocateInstalments requires one of ${B2B_INSTALMENT_COUNTS.join(", ")} instalments`);
  }

  const base = Math.floor(totalNetCents / instalmentCount);
  const parts: number[] = new Array(instalmentCount).fill(base);
  parts[instalmentCount - 1] = totalNetCents - base * (instalmentCount - 1);

  const sum = parts.reduce((running, part) => running + part, 0);
  if (sum !== totalNetCents) {
    throw new Error(`allocateInstalments lost cents: ${sum} != ${totalNetCents}`);
  }
  return parts;
}

/* ── The monthly equivalent, and its warning label ──────────── */

/**
 * What one delivery of an annual contract "works out at".
 *
 * ══════════════════════════════════════════════════════════════
 * DISPLAY ONLY. NOT A BILLING AMOUNT.
 * ══════════════════════════════════════════════════════════════
 *
 * An annual contract has no monthly payment. This number exists so a
 * customer can compare the annual plan against the monthly one, and it
 * is returned as a STRUCTURE rather than a bare integer so no caller can
 * mistake it for an amount to charge: the `isExact` flag says outright
 * whether it is the real figure or an average.
 *
 * At one and three packs the annual total does not divide by twelve
 * (535,50 / 12 = 44,625), so `isExact` is false and the surface must
 * mark the value as an average. Multiplying `averageNetCents` back by
 * twelve does NOT return the contract amount - that is precisely the
 * error annualProductNetCents was corrected to avoid, and it is why
 * nothing in this module consumes this function.
 */
export type B2bAnnualMonthlyEquivalent = {
  /** Rounded half up, for display beside an explicit average marker. */
  averageNetCents: number;
  /** True only when the annual total divides evenly across the term. */
  isExact: boolean;
  deliveryCount: number;
};

export function annualMonthlyEquivalentForDisplay(packs: number): B2bAnnualMonthlyEquivalent {
  const annual = annualProductNetCents(packs);
  return {
    averageNetCents: divideRoundHalfUp(annual, B2B_ANNUAL_DELIVERY_COUNT),
    isExact: annual % B2B_ANNUAL_DELIVERY_COUNT === 0,
    deliveryCount: B2B_ANNUAL_DELIVERY_COUNT,
  };
}

/* ── The builders ───────────────────────────────────────────── */

/**
 * Every net figure a MONTHLY contract needs, and nothing else.
 *
 * A result union rather than a throw, because this is the boundary a
 * request crosses: the pack count ultimately comes from a browser, and
 * an unsupported quantity is an ordinary answer rather than a fault.
 * The same shape lib/annualPlanRules.ts's buildAnnualPricing uses.
 */
export type B2bMonthlyPricing = {
  rulesVersion: string;
  currency: string;
  packs: number;
  kilograms: number;
  packNetCents: number;
  monthlyProductNetCents: number;
};

export type B2bMonthlyPricingResult =
  | { ok: true; pricing: B2bMonthlyPricing }
  | { ok: false; reason: string };

export function buildB2bMonthlyPricing(input: { packs: unknown }): B2bMonthlyPricingResult {
  if (!isSelfServicePackCount(input.packs)) {
    return { ok: false, reason: "pack count is not a self-service quantity" };
  }
  const packs = input.packs;
  return {
    ok: true,
    pricing: {
      rulesVersion: B2B_PRICING_RULES_VERSION,
      currency: B2B_CURRENCY,
      packs,
      kilograms: packsToKilograms(packs),
      packNetCents: PACK_NET_CENTS,
      monthlyProductNetCents: monthlyProductNetCents(packs),
    },
  };
}

/**
 * Every net figure an ANNUAL contract needs, including the schedule.
 *
 * The totals are DERIVED here and never supplied, so no browser can hand
 * this flow an amount, and the instalments are produced by the one
 * allocator rather than by whatever divided them at the call site.
 */
export type B2bAnnualPricing = {
  rulesVersion: string;
  currency: string;
  packs: number;
  kilograms: number;
  packNetCents: number;
  deliveryCount: number;
  discountPercent: number;
  /** The undiscounted twelve-month total, for the "statt" line. */
  baseAnnualNetCents: number;
  /** THE FROZEN CONTRACT AMOUNT. */
  annualProductNetCents: number;
  savingNetCents: number;
  instalmentCount: number;
  /** Sums to annualProductNetCents exactly. */
  instalmentNetCents: number[];
  monthlyEquivalent: B2bAnnualMonthlyEquivalent;
};

export type B2bAnnualPricingResult =
  | { ok: true; pricing: B2bAnnualPricing }
  | { ok: false; reason: string };

export function buildB2bAnnualPricing(input: {
  packs: unknown;
  instalmentCount: unknown;
}): B2bAnnualPricingResult {
  if (!isSelfServicePackCount(input.packs)) {
    return { ok: false, reason: "pack count is not a self-service quantity" };
  }
  if (!isInstalmentCount(input.instalmentCount)) {
    return { ok: false, reason: "instalment count is not an approved payment schedule" };
  }
  const packs = input.packs;
  const instalmentCount = input.instalmentCount;
  const annual = annualProductNetCents(packs);

  return {
    ok: true,
    pricing: {
      rulesVersion: B2B_PRICING_RULES_VERSION,
      currency: B2B_CURRENCY,
      packs,
      kilograms: packsToKilograms(packs),
      packNetCents: PACK_NET_CENTS,
      deliveryCount: B2B_ANNUAL_DELIVERY_COUNT,
      discountPercent: B2B_ANNUAL_DISCOUNT_PERCENT,
      baseAnnualNetCents: baseAnnualProductNetCents(packs),
      annualProductNetCents: annual,
      savingNetCents: annualSavingNetCents(packs),
      instalmentCount,
      instalmentNetCents: allocateInstalments(annual, instalmentCount),
      monthlyEquivalent: annualMonthlyEquivalentForDisplay(packs),
    },
  };
}
