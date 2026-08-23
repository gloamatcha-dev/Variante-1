/**
 * German VAT calculation and EU origin-taxation policy (Task 21D).
 *
 * Scope, deliberately narrow:
 *   - Germany: domestic supply, German rates.
 *   - Other EU VAT territory: German rates too, but ONLY while the
 *     10 000 EUR allowance of § 3c Abs. 4 UStG keeps the place of supply
 *     in Germany. That is a dated fact, not a rule - see
 *     EU_ORIGIN_TAX_POLICY and resolveTaxTreatment below.
 *   - Everything else (UK, CH, NO, independent third countries): NO tax
 *     treatment. Not "German VAT", not "0" - unknown. Fails closed.
 *
 * Confirmed facts this module encodes (owner, 2026):
 *   Cara 2 GmbH, Regelbesteuerung, no § 19 Kleinunternehmer,
 *   USt-IdNr. DE457414734, NOT registered for the Union OSS, and no
 *   § 3c Abs. 4 Satz 3 election for destination taxation.
 *
 * Money is integer cents throughout. No floating-point money arithmetic:
 * every division goes through divideRoundHalfUp, and tax is always the
 * remainder (gross - net), so gross = net + tax holds exactly by
 * construction rather than by luck.
 *
 * Pure and server-safe: no DB, no network, no import.meta.env, no clock
 * of its own (the calendar year is always passed in), and - like every
 * other directly unit-tested module here - no value imports. The
 * DB-backed half of the threshold guard lives in lib/euThreshold.ts.
 */

import type { TaxJurisdiction, TaxJurisdictionResult } from "./taxJurisdiction";
import type { CheckoutQuote } from "./checkoutQuote";

/**
 * Bumped whenever the rules below change in a way that would produce a
 * different result for the same cart. Frozen onto every paid order so an
 * old order stays reproducible after a rate or classification change.
 */
export const TAX_CALCULATION_VERSION = "de-2026.1";

/* ── Product tax categories ─────────────────────────────────── */

/**
 * A tax category, not a product. Classification is a legal property of
 * what is supplied, so it is keyed on stable catalog identity (SKU, then
 * product slug) and never on a product NAME - renaming "GLOA Matcha"
 * must not silently reclassify it.
 */
export type TaxCategory = "matcha_reduced_de" | "general_goods_de";

/**
 * German rates.
 *
 *   matcha_reduced_de  7 %  - § 12 Abs. 2 Nr. 1 UStG i.V.m. Anlage 2
 *                             Nr. 12 ("Kaffee, Tee, Mate und Gewürze",
 *                             Kapitel 9). GLOA Matcha is pure green tea
 *                             powder, not a drink or mixed preparation.
 *   general_goods_de  19 %  - § 12 Abs. 1 UStG. The standalone, empty
 *                             Metal Case is an accessory, not food.
 */
export const TAX_CATEGORY_RATE_PERCENT: Readonly<Record<TaxCategory, number>> = Object.freeze({
  matcha_reduced_de: 7,
  general_goods_de: 19,
});

/**
 * Deterministic order used whenever categories have to be ranked (the
 * shipping remainder tie-break below). Alphabetical, so it cannot drift
 * with object key order.
 */
const TAX_CATEGORY_ORDER: readonly TaxCategory[] = Object.freeze(
  (Object.keys(TAX_CATEGORY_RATE_PERCENT) as TaxCategory[]).slice().sort()
);

/** SKU is the primary key for classification: exact, stable, per variant. */
const SKU_TAX_CATEGORY: Readonly<Record<string, TaxCategory>> = Object.freeze({
  "GLOA-MATCHA-30G": "matcha_reduced_de",
  "GLOA-MATCHA-50G": "matcha_reduced_de",
  "GLOA-MATCHA-100G": "matcha_reduced_de",
  "GLOA-CASE-01": "general_goods_de",
});

/**
 * Product-slug fallback, so a new variant of an already-classified
 * product (say a 200 g Matcha) is not sold untaxed the moment it is
 * seeded. A brand new PRODUCT still has no category and fails closed.
 */
const PRODUCT_SLUG_TAX_CATEGORY: Readonly<Record<string, TaxCategory>> = Object.freeze({
  matcha: "matcha_reduced_de",
  "metal-case": "general_goods_de",
});

/**
 * Resolves the tax category for a catalog line, or null when the product
 * is not classified. Null must never be turned into a default rate:
 * guessing 19 % on an unclassified food item would under-charge the
 * customer and mis-declare the supply.
 */
export function resolveTaxCategory(item: { sku?: string | null; productSlug?: string | null }): TaxCategory | null {
  const sku = typeof item.sku === "string" ? item.sku.trim().toUpperCase() : "";
  if (sku && SKU_TAX_CATEGORY[sku]) return SKU_TAX_CATEGORY[sku];

  const slug = typeof item.productSlug === "string" ? item.productSlug.trim().toLowerCase() : "";
  if (slug && PRODUCT_SLUG_TAX_CATEGORY[slug]) return PRODUCT_SLUG_TAX_CATEGORY[slug];

  return null;
}

/* ── Gross-inclusive extraction ─────────────────────────────── */

/**
 * Integer division rounded half away from zero, for non-negative inputs
 * only. Written as floor((2n + d) / 2d) so the half-up decision is made
 * in integer arithmetic instead of on a float that may already have
 * drifted (0.5 + epsilon rounding up, 0.5 - epsilon rounding down).
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

export type TaxAmount = {
  grossCents: number;
  netCents: number;
  taxCents: number;
  taxRatePercent: number;
};

/**
 * Extracts VAT FROM a fixed gross price. The customer-facing gross price
 * is the fixed quantity here - tax is never added on top, so the gross
 * value comes back unchanged.
 *
 * net = round(gross * 100 / (100 + rate)), half up; tax is the remainder,
 * which is what makes gross = net + tax exact for every input.
 */
export function extractTaxFromGross(grossCents: number, taxRatePercent: number): TaxAmount {
  if (!Number.isSafeInteger(grossCents) || grossCents < 0) {
    throw new Error("extractTaxFromGross requires a non-negative integer gross amount");
  }
  if (!Number.isSafeInteger(taxRatePercent) || taxRatePercent < 0) {
    throw new Error("extractTaxFromGross requires a non-negative integer rate");
  }
  const netCents = divideRoundHalfUp(grossCents * 100, 100 + taxRatePercent);
  return { grossCents, netCents, taxCents: grossCents - netCents, taxRatePercent };
}

/* ── Tax policy: § 3c Abs. 4 UStG origin taxation ───────────── */

/** Which body of rules an order is actually taxed under. */
export type TaxTreatment =
  /** Domestic German supply (§ 1 Abs. 1 Nr. 1 UStG). */
  | "de_domestic"
  /**
   * Intra-EU B2C distance sale whose place of supply stays in Germany
   * because the § 3c Abs. 4 UStG allowance is not exceeded.
   */
  | "de_origin_intra_eu_3c4";

/**
 * Dated tax-policy facts. This is NOT a timeless configuration: the two
 * turnover figures are statements the owner confirmed about ONE calendar
 * year. confirmedForYear is what stops them from silently becoming a
 * permanent "we have never sold anything into the EU" assumption - see
 * resolveTaxTreatment, which refuses EU origin taxation outright once the
 * calendar year has moved on and the facts have not been re-confirmed.
 *
 * Reviewing this for a new year means re-checking, at minimum:
 *   - the actual qualifying EU B2C turnover of the year just ended,
 *   - any qualifying turnover outside GLOA web sales,
 *   - whether an OSS registration or a § 3c Abs. 4 Satz 3 election exists.
 */
export type EuOriginTaxPolicy = {
  /** The calendar year the figures below were confirmed for. */
  confirmedForYear: number;
  /** Union OSS registration. While false, OSS destination VAT is not implemented. */
  unionOssRegistered: boolean;
  /** Voluntary election for destination taxation, § 3c Abs. 4 Satz 3 UStG. */
  destinationTaxElection: boolean;
  /** § 3c Abs. 4 Satz 1 UStG: 10 000 EUR, EU-wide, not per country. */
  thresholdNetCents: number;
  /**
   * Refuse this far below the statutory allowance. Covers the two things
   * the reservation in lib/euThreshold.ts cannot see: a checkout whose
   * reservation window has lapsed but which still settles later (async
   * payment methods), and the fact that the opening balance below is a
   * dated statement rather than a live figure.
   */
  safetyBufferNetCents: number;
  /** Qualifying turnover in confirmedForYear from outside GLOA web sales. */
  externalRelevantNetCentsBeforeLaunch: number;
  /** Qualifying turnover in the year BEFORE confirmedForYear (§ 3c Abs. 4 Satz 1). */
  previousYearExternalRelevantNetCents: number;
};

export const EU_ORIGIN_TAX_POLICY: Readonly<EuOriginTaxPolicy> = Object.freeze({
  confirmedForYear: 2026,
  unionOssRegistered: false,
  destinationTaxElection: false,
  thresholdNetCents: 1_000_000,
  safetyBufferNetCents: 50_000,
  externalRelevantNetCentsBeforeLaunch: 0,
  previousYearExternalRelevantNetCents: 0,
});

export type TaxTreatmentResult =
  | {
      applicable: true;
      treatment: TaxTreatment;
      /** The country whose VAT is charged. Always DE in this task. */
      taxCountry: "DE";
      /** Whether this supply counts toward the § 3c Abs. 4 allowance. */
      thresholdRelevant: boolean;
    }
  | {
      applicable: false;
      /**
       * not_implemented - this jurisdiction's VAT is genuinely not built
       *   yet (UK, CH, NO, third countries). Tax stays UNKNOWN and the
       *   order is not blocked by this module.
       * policy_unavailable - the destination IS in scope, but the facts
       *   needed to tax it correctly are stale or superseded. Blocking.
       */
      kind: "not_implemented" | "policy_unavailable";
      reason: string;
    };

/**
 * Decides which rules govern a destination in a given calendar year.
 *
 * Germany deliberately does not depend on the policy year: a domestic
 * supply is taxed at German rates regardless of the EU allowance, so a
 * stale policy must not take the German shop offline on 1 January.
 */
export function resolveTaxTreatment(
  jurisdiction: TaxJurisdiction,
  options: { calendarYear: number; policy?: EuOriginTaxPolicy }
): TaxTreatmentResult {
  const policy = options.policy ?? EU_ORIGIN_TAX_POLICY;

  if (jurisdiction.kind === "germany") {
    return { applicable: true, treatment: "de_domestic", taxCountry: "DE", thresholdRelevant: false };
  }

  if (jurisdiction.kind !== "eu") {
    return {
      applicable: false,
      kind: "not_implemented",
      reason: `no VAT treatment is implemented for jurisdiction "${jurisdiction.kind}" (${jurisdiction.destinationCountry})`,
    };
  }

  if (policy.unionOssRegistered) {
    return {
      applicable: false,
      kind: "policy_unavailable",
      reason: "the shop is registered for the Union OSS, so destination VAT applies and is not implemented",
    };
  }

  if (policy.destinationTaxElection) {
    return {
      applicable: false,
      kind: "policy_unavailable",
      reason: "a § 3c Abs. 4 Satz 3 election for destination taxation is in force, which is not implemented",
    };
  }

  if (options.calendarYear !== policy.confirmedForYear) {
    return {
      applicable: false,
      kind: "policy_unavailable",
      reason: `EU tax policy was confirmed for ${policy.confirmedForYear} but the current calendar year is ${options.calendarYear}; it must be reviewed before intra-EU sales continue`,
    };
  }

  if (policy.previousYearExternalRelevantNetCents > policy.thresholdNetCents) {
    return {
      applicable: false,
      kind: "policy_unavailable",
      reason: "the § 3c Abs. 4 allowance was already exceeded in the previous calendar year",
    };
  }

  return { applicable: true, treatment: "de_origin_intra_eu_3c4", taxCountry: "DE", thresholdRelevant: true };
}

/* ── Threshold arithmetic ───────────────────────────────────── */

export type ThresholdInput = {
  thresholdNetCents: number;
  safetyBufferNetCents: number;
  /** Confirmed qualifying turnover from outside GLOA web sales. */
  externalNetCents: number;
  /** Qualifying turnover from paid GLOA orders in this calendar year. */
  paidNetCents: number;
  /** Qualifying value held by live, unpaid checkout reservations. */
  pendingNetCents: number;
  /** The relevant net value of the order being considered right now. */
  proposedNetCents: number;
};

export type ThresholdEvaluation = {
  withinAllowance: boolean;
  totalNetCents: number;
  allowanceNetCents: number;
};

/**
 * Pure § 3c Abs. 4 arithmetic.
 *
 * The allowance holds while the running total does not EXCEED 10 000 EUR
 * ("nicht überschreitet"), so landing exactly on the threshold is still
 * inside it. The safety buffer only ever narrows the allowance further -
 * it never widens it.
 */
export function evaluateThreshold(input: ThresholdInput): ThresholdEvaluation {
  const totalNetCents =
    input.externalNetCents + input.paidNetCents + input.pendingNetCents + input.proposedNetCents;
  const allowanceNetCents = input.thresholdNetCents - input.safetyBufferNetCents;
  return { withinAllowance: totalNetCents <= allowanceNetCents, totalNetCents, allowanceNetCents };
}

/** The calendar year in Germany, which is the year § 3c Abs. 4 counts in. */
export function berlinCalendarYear(now: Date = new Date()): number {
  const year = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", year: "numeric" }).format(now);
  return Number.parseInt(year, 10);
}

/* ── Cart calculation ───────────────────────────────────────── */

export type TaxableCartItem = {
  variantId: string;
  sku: string;
  productSlug: string;
  quantity: number;
  unitGrossCents: number;
  lineGrossCents: number;
};

export type TaxedCartItem = {
  variantId: string;
  sku: string;
  productSlug: string;
  quantity: number;
  taxCategory: TaxCategory;
  taxRatePercent: number;
  unitGrossCents: number;
  /**
   * Unit net, for display only. It is extracted from the unit gross
   * price independently, so unitNetCents * quantity may differ from
   * lineNetCents by a cent or two. lineNetCents is the authoritative
   * figure: VAT is owed on the line's actual consideration, not on a
   * multiplied-up rounded unit price.
   */
  unitNetCents: number;
  unitTaxCents: number;
  lineGrossCents: number;
  lineNetCents: number;
  lineTaxCents: number;
};

export type ShippingTaxAllocation = {
  taxCategory: TaxCategory;
  taxRatePercent: number;
  grossCents: number;
  netCents: number;
  taxCents: number;
};

export type TaxRateBreakdown = {
  taxRatePercent: number;
  netCents: number;
  taxCents: number;
  grossCents: number;
};

export type CartTaxSnapshot = {
  calculationVersion: string;
  treatment: TaxTreatment;
  taxCountry: "DE";
  jurisdictionKind: TaxJurisdiction["kind"];
  destinationCountry: string;
  vatCountry: string | null;
  items: TaxedCartItem[];
  shipping: {
    grossCents: number;
    netCents: number;
    taxCents: number;
    /** Empty only when there is no shipping charge at all. */
    allocations: ShippingTaxAllocation[];
  };
  totals: {
    subtotalGrossCents: number;
    subtotalNetCents: number;
    subtotalTaxCents: number;
    shippingGrossCents: number;
    shippingNetCents: number;
    shippingTaxCents: number;
    totalGrossCents: number;
    totalNetCents: number;
    taxTotalCents: number;
  };
  /** Per-rate summary, the shape an invoice or a VAT return needs. */
  rateBreakdown: TaxRateBreakdown[];
  /** Net value counting toward § 3c Abs. 4; 0 for a domestic supply. */
  thresholdRelevantNetCents: number;
};

export type CartTaxResult =
  | { ok: true; snapshot: CartTaxSnapshot }
  | { ok: false; reason: string };

/**
 * Splits a shipping charge across the tax categories in the cart.
 *
 * Shipping is an ancillary supply (Nebenleistung) and normally shares the
 * treatment of the goods, but when the goods are taxed at different rates
 * the consideration has to be apportioned in a sachgerechte manner. The
 * basis used here is the relationship of the merchandise NET values -
 * that is the apportionment the administration's guidance on ancillary
 * supplies to differently taxed main supplies supports (Abschn. 3.10
 * UStAE, Einheitlichkeit der Leistung), and it needs no data beyond the
 * cart itself.
 *
 * The GROSS charge is what gets apportioned, and each share then has its
 * own tax extracted, so the customer's shipping line is preserved to the
 * cent. Rounding remainders are handed out by largest remainder, with a
 * fully deterministic tie-break, so no cent is ever lost or invented.
 */
function allocateShipping(
  shippingGrossCents: number,
  netByCategory: Map<TaxCategory, number>
): ShippingTaxAllocation[] {
  const categories = TAX_CATEGORY_ORDER.filter(category => netByCategory.has(category));
  if (categories.length === 0 || shippingGrossCents === 0) return [];

  if (categories.length === 1) {
    const category = categories[0];
    const amount = extractTaxFromGross(shippingGrossCents, TAX_CATEGORY_RATE_PERCENT[category]);
    return [{ taxCategory: category, taxRatePercent: amount.taxRatePercent, grossCents: amount.grossCents, netCents: amount.netCents, taxCents: amount.taxCents }];
  }

  const totalNet = categories.reduce((sum, category) => sum + (netByCategory.get(category) ?? 0), 0);
  if (totalNet <= 0) {
    // Unreachable with real catalog prices (every price is > 0), but a
    // zero basis has no sachgerechte split, so refuse rather than invent.
    throw new Error("cannot apportion shipping across a zero merchandise net value");
  }

  const shares = categories.map(category => {
    const categoryNet = netByCategory.get(category) ?? 0;
    const numerator = shippingGrossCents * categoryNet;
    const base = Math.floor(numerator / totalNet);
    return { category, categoryNet, base, remainder: numerator - base * totalNet };
  });

  const leftover = shippingGrossCents - shares.reduce((sum, share) => sum + share.base, 0);

  // Largest remainder first; then the larger merchandise value; then the
  // category name. The last two make the outcome reproducible even when
  // two categories tie exactly.
  const ranked = shares.slice().sort((a, b) =>
    b.remainder - a.remainder ||
    b.categoryNet - a.categoryNet ||
    a.category.localeCompare(b.category)
  );
  // leftover is strictly smaller than the number of categories (every
  // share was floored), so each category gains at most one cent.
  for (let i = 0; i < leftover; i++) {
    ranked[i].base += 1;
  }

  return categories.map(category => {
    const share = shares.find(candidate => candidate.category === category)!;
    const amount = extractTaxFromGross(share.base, TAX_CATEGORY_RATE_PERCENT[category]);
    return {
      taxCategory: category,
      taxRatePercent: amount.taxRatePercent,
      grossCents: amount.grossCents,
      netCents: amount.netCents,
      taxCents: amount.taxCents,
    };
  });
}

/**
 * Builds the authoritative tax snapshot for one cart and one shipping
 * charge, under an already-resolved treatment.
 *
 * Every input here has to come from the server (catalog prices, the
 * server-computed shipping charge, the resolved destination). Nothing a
 * browser sends may reach this function: a client-chosen rate, net price
 * or category is exactly what this module exists to prevent.
 */
export function calculateCartTax(input: {
  jurisdiction: TaxJurisdiction;
  treatment: TaxTreatment;
  thresholdRelevant: boolean;
  items: TaxableCartItem[];
  shippingGrossCents: number;
}): CartTaxResult {
  const { jurisdiction, treatment, thresholdRelevant, items, shippingGrossCents } = input;

  if (items.length === 0) return { ok: false, reason: "cannot tax an empty cart" };
  if (!Number.isSafeInteger(shippingGrossCents) || shippingGrossCents < 0) {
    return { ok: false, reason: "shipping amount is not a non-negative integer" };
  }

  const taxedItems: TaxedCartItem[] = [];
  const netByCategory = new Map<TaxCategory, number>();

  for (const item of items) {
    const category = resolveTaxCategory(item);
    if (!category) {
      return { ok: false, reason: `no tax category is defined for sku "${item.sku}" / product "${item.productSlug}"` };
    }
    if (!Number.isSafeInteger(item.lineGrossCents) || item.lineGrossCents < 0) {
      return { ok: false, reason: `line amount for sku "${item.sku}" is not a non-negative integer` };
    }
    if (!Number.isSafeInteger(item.unitGrossCents) || item.unitGrossCents < 0) {
      return { ok: false, reason: `unit amount for sku "${item.sku}" is not a non-negative integer` };
    }

    const ratePercent = TAX_CATEGORY_RATE_PERCENT[category];
    const line = extractTaxFromGross(item.lineGrossCents, ratePercent);
    const unit = extractTaxFromGross(item.unitGrossCents, ratePercent);

    taxedItems.push({
      variantId: item.variantId,
      sku: item.sku,
      productSlug: item.productSlug,
      quantity: item.quantity,
      taxCategory: category,
      taxRatePercent: ratePercent,
      unitGrossCents: unit.grossCents,
      unitNetCents: unit.netCents,
      unitTaxCents: unit.taxCents,
      lineGrossCents: line.grossCents,
      lineNetCents: line.netCents,
      lineTaxCents: line.taxCents,
    });

    netByCategory.set(category, (netByCategory.get(category) ?? 0) + line.netCents);
  }

  let allocations: ShippingTaxAllocation[];
  try {
    allocations = allocateShipping(shippingGrossCents, netByCategory);
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : "shipping apportionment failed" };
  }

  const subtotalGrossCents = taxedItems.reduce((sum, item) => sum + item.lineGrossCents, 0);
  const subtotalNetCents = taxedItems.reduce((sum, item) => sum + item.lineNetCents, 0);
  const subtotalTaxCents = taxedItems.reduce((sum, item) => sum + item.lineTaxCents, 0);
  const shippingNetCents = allocations.reduce((sum, share) => sum + share.netCents, 0);
  const shippingTaxCents = allocations.reduce((sum, share) => sum + share.taxCents, 0);
  const allocatedShippingGrossCents = allocations.reduce((sum, share) => sum + share.grossCents, 0);

  if (allocatedShippingGrossCents !== shippingGrossCents) {
    // A lost or invented cent would silently change what the customer is
    // charged, so this is a hard stop rather than a log line.
    return { ok: false, reason: "apportioned shipping does not add back up to the shipping charge" };
  }

  const totalGrossCents = subtotalGrossCents + shippingGrossCents;
  const totalNetCents = subtotalNetCents + shippingNetCents;
  const taxTotalCents = subtotalTaxCents + shippingTaxCents;

  if (totalNetCents + taxTotalCents !== totalGrossCents) {
    return { ok: false, reason: "net plus tax does not equal gross" };
  }

  const rateBreakdown: TaxRateBreakdown[] = TAX_CATEGORY_ORDER.map(category => {
    const ratePercent = TAX_CATEGORY_RATE_PERCENT[category];
    const itemRows = taxedItems.filter(item => item.taxCategory === category);
    const shippingRow = allocations.find(share => share.taxCategory === category);
    const netCents = itemRows.reduce((sum, item) => sum + item.lineNetCents, 0) + (shippingRow?.netCents ?? 0);
    const taxCents = itemRows.reduce((sum, item) => sum + item.lineTaxCents, 0) + (shippingRow?.taxCents ?? 0);
    const grossCents = itemRows.reduce((sum, item) => sum + item.lineGrossCents, 0) + (shippingRow?.grossCents ?? 0);
    return { taxRatePercent: ratePercent, netCents, taxCents, grossCents };
  }).filter(row => row.grossCents > 0);

  return {
    ok: true,
    snapshot: {
      calculationVersion: TAX_CALCULATION_VERSION,
      treatment,
      taxCountry: "DE",
      jurisdictionKind: jurisdiction.kind,
      destinationCountry: jurisdiction.destinationCountry,
      vatCountry: jurisdiction.vatCountry,
      items: taxedItems,
      shipping: {
        grossCents: shippingGrossCents,
        netCents: shippingNetCents,
        taxCents: shippingTaxCents,
        allocations,
      },
      totals: {
        subtotalGrossCents,
        subtotalNetCents,
        subtotalTaxCents,
        shippingGrossCents,
        shippingNetCents,
        shippingTaxCents,
        totalGrossCents,
        totalNetCents,
        taxTotalCents,
      },
      rateBreakdown,
      thresholdRelevantNetCents: thresholdRelevant ? totalNetCents : 0,
    },
  };
}

/* ── Checkout composition ───────────────────────────────────── */

/**
 * Shown to the customer when a destination cannot currently be taxed
 * correctly. Says only that the destination is unavailable and offers a
 * way to reach a human: no tax law, no OSS, no thresholds, no numbers,
 * nothing about the database.
 */
export const TAX_DESTINATION_UNAVAILABLE_MESSAGE =
  "Bestellungen in dieses Lieferland sind momentan vorübergehend nicht verfügbar. Bitte kontaktiere uns.";

/**
 * Maps an authoritative catalog quote onto the shape the calculation
 * consumes. One mapping, so the quote endpoint and the session endpoint
 * cannot classify the same cart differently.
 */
export function toTaxableCartItems(quote: CheckoutQuote): TaxableCartItem[] {
  return quote.items.map(item => ({
    variantId: item.variantId,
    sku: item.sku,
    productSlug: item.productSlug,
    quantity: item.quantity,
    unitGrossCents: item.unitGrossCents,
    lineGrossCents: item.lineGrossCents,
  }));
}

export type CheckoutTaxOutcome =
  /** Tax is known and authoritative. */
  | { kind: "calculated"; snapshot: CartTaxSnapshot; thresholdRelevantNetCents: number }
  /**
   * This destination's VAT is genuinely not built yet (UK, Switzerland,
   * Norway, third countries). Tax stays UNKNOWN - never a fabricated
   * German rate and never a fabricated zero - and checkout is not
   * blocked on that account, exactly as it behaved before Task 21D. The
   * supply is not an intra-EU distance sale, so its contribution to the
   * § 3c Abs. 4 allowance is a real, known zero.
   */
  | { kind: "not_implemented"; reason: string }
  /**
   * The destination IS in scope but cannot be taxed correctly right now
   * (stale policy year, an OSS registration or destination-tax election
   * that is not implemented, an unrecognised country, or a product with
   * no tax classification). Checkout must not proceed.
   */
  | { kind: "blocked"; reason: string };

/**
 * Resolves the tax outcome for one checkout: a server-authoritative
 * catalog quote, a server-computed shipping charge, and a destination
 * already classified by the Task 21C resolver.
 *
 * The jurisdiction is passed in as that resolver's own result type, so
 * this function cannot be handed a jurisdiction the resolver refused -
 * an unsupported country arrives as `blocked`, never as a usable one.
 *
 * Every input is server-derived by construction. A browser-supplied
 * rate, net amount, tax total, category or jurisdiction has no way in.
 */
export function resolveCheckoutTax(input: {
  jurisdictionResult: TaxJurisdictionResult;
  items: TaxableCartItem[];
  shippingGrossCents: number;
  calendarYear: number;
  policy?: EuOriginTaxPolicy;
}): CheckoutTaxOutcome {
  if (!input.jurisdictionResult.supported) {
    return { kind: "blocked", reason: input.jurisdictionResult.reason };
  }
  const jurisdiction = input.jurisdictionResult.jurisdiction;

  const treatmentResult = resolveTaxTreatment(jurisdiction, {
    calendarYear: input.calendarYear,
    policy: input.policy,
  });

  if (!treatmentResult.applicable) {
    return treatmentResult.kind === "not_implemented"
      ? { kind: "not_implemented", reason: treatmentResult.reason }
      : { kind: "blocked", reason: treatmentResult.reason };
  }

  const taxResult = calculateCartTax({
    jurisdiction,
    treatment: treatmentResult.treatment,
    thresholdRelevant: treatmentResult.thresholdRelevant,
    items: input.items,
    shippingGrossCents: input.shippingGrossCents,
  });

  if (!taxResult.ok) {
    // An unclassified product or a failed apportionment is a bug or an
    // unreviewed catalog change, never something to sell around.
    return { kind: "blocked", reason: taxResult.reason };
  }

  return {
    kind: "calculated",
    snapshot: taxResult.snapshot,
    thresholdRelevantNetCents: taxResult.snapshot.thresholdRelevantNetCents,
  };
}
