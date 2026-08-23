/**
 * B2B Matcha ROI calculation (Task 29B).
 *
 * The arithmetic behind the account calculator, kept out of the component
 * so it can be unit-tested directly rather than only looked at. It is the
 * per-model comparison the account calculator has always done, arranged
 * as one comparison table: the customer's own current purchase on the
 * left, one column per real GLOA offer model beside it.
 *
 * Prices are NEVER hardcoded here. Every figure comes either from the
 * catalog rows the signed-in business customer is already allowed to read
 * (b2b_product_sizes.price_per_kg_net and b2b_offer_models.discount_pct)
 * or from the scenario the customer set themselves. No supplier cost, no
 * internal margin and no assumed competitor price exists in this module.
 *
 * Returns null rather than zeros when the customer's current price is not
 * known yet, so a comparison is never drawn against an invented price.
 *
 * Pure and leaf: no imports, no DB, no clock, no rounding of intermediate
 * values - formatting is the caller's job.
 */

export type B2bOfferModel = { id: number; label: string; discount_pct: number };

export type B2bProductSize = { id: number; label: string; grams: number; price_per_kg_net: number };

export type B2bScenario = {
  /** The one value the customer types. null until they do. */
  currentPricePerKgNet: number | null;
  /** Slider values. */
  gramsPerDrink: number;
  salePricePerDrink: number;
  drinksPerMonth: number;
};

/** The customer's situation today, from their own stated price. */
export type B2bCurrentColumn = {
  pricePerKg: number;
  packagePrice: number;
  costPerDrink: number;
  monthlyCost: number;
  materialSharePct: number;
  monthlyAfterMatcha: number;
};

/** One GLOA offer model, priced against that situation. */
export type B2bModelColumn = B2bCurrentColumn & {
  model: B2bOfferModel;
  /** Positive = cheaper than the customer's current purchase. */
  diffPerKg: number;
  diffPercent: number;
  diffPerPackage: number;
  diffPerDrink: number;
  monthlyDiff: number;
  yearlyDiff: number;
};

export type B2bRoiResult = {
  /** Whole drinks only - a partial drink is not sold. */
  fullDrinksPerKg: number;
  fullDrinksPerPackage: number;
  monthlyConsumptionKg: number;
  monthlyRevenue: number;
  current: B2bCurrentColumn;
  models: B2bModelColumn[];
};

/**
 * Builds the ROI comparison, or null when it cannot be built honestly.
 *
 * Null is returned whenever the customer's current price is missing or
 * non-positive: that is the whole point of the gate. A scenario alone
 * cannot produce a comparison, because there is nothing to compare to.
 */
export function calculateB2bRoi(
  scenario: B2bScenario,
  size: B2bProductSize | null,
  models: B2bOfferModel[]
): B2bRoiResult | null {
  const { currentPricePerKgNet, gramsPerDrink, salePricePerDrink, drinksPerMonth } = scenario;

  if (!size) return null;
  if (currentPricePerKgNet === null || !Number.isFinite(currentPricePerKgNet) || currentPricePerKgNet <= 0) return null;
  if (!Number.isFinite(gramsPerDrink) || gramsPerDrink <= 0) return null;
  if (!Number.isFinite(salePricePerDrink) || salePricePerDrink <= 0) return null;
  if (!Number.isFinite(drinksPerMonth) || drinksPerMonth <= 0) return null;

  const monthlyRevenue = drinksPerMonth * salePricePerDrink;

  /** One column, given a net price per kg. */
  const column = (pricePerKg: number): B2bCurrentColumn => {
    const costPerDrink = pricePerKg * gramsPerDrink / 1000;
    const monthlyCost = costPerDrink * drinksPerMonth;
    return {
      pricePerKg,
      packagePrice: pricePerKg * size.grams / 1000,
      costPerDrink,
      monthlyCost,
      materialSharePct: (costPerDrink / salePricePerDrink) * 100,
      monthlyAfterMatcha: monthlyRevenue - monthlyCost,
    };
  };

  const current = column(currentPricePerKgNet);

  return {
    fullDrinksPerKg: Math.floor(1000 / gramsPerDrink),
    fullDrinksPerPackage: Math.floor(size.grams / gramsPerDrink),
    monthlyConsumptionKg: (drinksPerMonth * gramsPerDrink) / 1000,
    monthlyRevenue,
    current,
    models: models.map(model => {
      const gloa = column(size.price_per_kg_net * (1 - model.discount_pct / 100));
      const monthlyDiff = current.monthlyCost - gloa.monthlyCost;
      return {
        ...gloa,
        model,
        diffPerKg: current.pricePerKg - gloa.pricePerKg,
        diffPercent: ((current.pricePerKg - gloa.pricePerKg) / current.pricePerKg) * 100,
        diffPerPackage: current.packagePrice - gloa.packagePrice,
        diffPerDrink: current.costPerDrink - gloa.costPerDrink,
        monthlyDiff,
        yearlyDiff: monthlyDiff * 12,
      };
    }),
  };
}
