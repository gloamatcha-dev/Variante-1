import { validateQuoteItems, buildAuthoritativeQuote, type CheckoutQuote } from "../../../../lib/checkoutQuote";
import { ALLOWED_SHIPPING_COUNTRIES, getShippingZone, computeShippingGrossCents } from "../../../../lib/shipping";
import { resolveTaxJurisdiction } from "../../../../lib/taxJurisdiction";
import { resolveCheckoutTax, toTaxableCartItems, type CartTaxSnapshot, type TaxableCartItem } from "../../../../lib/tax";
import { normalizeDiscountCode } from "../../../../lib/launchDiscount";
import { priceLaunchDiscountForCart, launchDiscountMessage } from "../../../../lib/launchDiscountCart";

type ErrorResponse = {
  error: string;
};

/**
 * The tax information a browser may be shown (Task 21D). Present only
 * when a destination was supplied AND its VAT is actually implemented -
 * omitted entirely otherwise, so an unknown tax is never rendered as a
 * zero. This is display data: the checkout session endpoint re-derives
 * all of it server-side and reads none of it back.
 */
type QuoteTaxResponse = {
  taxCountry: string;
  destinationCountry: string;
  shippingGrossCents: number;
  netCents: number;
  taxCents: number;
  grossCents: number;
  rateBreakdown: CartTaxSnapshot["rateBreakdown"];
};

/**
 * The discount, as a browser may be shown it: an amount in whole cents,
 * or one sentence saying why not.
 *
 * Every figure here is the SERVER's. The browser sent a code string; it
 * did not send a percent, an amount, an eligibility verdict or a line
 * allocation, and none would be read if it did - exactly the rule the
 * prices above already follow.
 */
type QuoteDiscountResponse =
  | {
      applied: true;
      code: string;
      percent: number;
      eligibleSubtotalGrossCents: number;
      discountGrossCents: number;
      discountedSubtotalGrossCents: number;
    }
  | { applied: false; message: string };

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: "Ungültige Anfrage." } as ErrorResponse,
      { status: 400 }
    );
  }

  if (!body || typeof body !== "object") {
    return Response.json(
      { error: "Ungültige Artikel oder Mengen." } as ErrorResponse,
      { status: 400 }
    );
  }

  const { items, shippingCountry, discountCode } = body as {
    items?: unknown;
    shippingCountry?: unknown;
    discountCode?: unknown;
  };
  const validatedItems = validateQuoteItems(items);
  if (!validatedItems) {
    return Response.json(
      { error: "Ungültige Artikel oder Mengen." } as ErrorResponse,
      { status: 400 }
    );
  }

  const result = await buildAuthoritativeQuote(validatedItems);
  if (!result.ok) {
    return Response.json(
      { error: result.error } as ErrorResponse,
      { status: result.status }
    );
  }

  // THE DISCOUNT IS DECIDED BEFORE THE TAX, because the tax has to
  // describe the amounts the customer would actually pay. Nothing here
  // writes: no attempt, no Stripe object, no row. The session endpoint
  // re-derives every cent from the frozen attempt and reads none of
  // this back.
  const discount = buildQuoteDiscount(result.quote, discountCode);
  const discountedLineGrossCents = discount?.applied
    ? discount.perLine
    : result.quote.items.map(item => item.lineGrossCents);

  return Response.json(
    {
      ...result.quote,
      ...buildQuoteTax(result.quote, shippingCountry, discountedLineGrossCents),
      ...(discount ? { discount: discount.response } : {}),
    },
    { status: 200 }
  );
}

/**
 * WHAT A CODE IS WORTH ON THIS BASKET, ANSWERED BY THE SERVER.
 *
 * GLOALAUNCH10 is reusable, so this endpoint can answer completely: the
 * code, the window and the basket are all it needs, and there is no
 * per-customer limit left to make the answer depend on who is asking.
 * No email is accepted here and none is needed - which also means this
 * quote cannot be used to learn anything about anybody.
 */
function buildQuoteDiscount(
  quote: CheckoutQuote,
  discountCode: unknown
): { applied: true; perLine: number[]; response: QuoteDiscountResponse }
  | { applied: false; response: QuoteDiscountResponse }
  | null {
  if (discountCode !== undefined && discountCode !== null && typeof discountCode !== "string") {
    return { applied: false, response: { applied: false, message: launchDiscountMessage("unknown_code") } };
  }
  const code = normalizeDiscountCode(discountCode);
  if (code.length === 0) return null;

  const decision = priceLaunchDiscountForCart({
    code,
    nowMs: Date.now(),
    lines: quote.items.map(item => ({
      variantId: item.variantId,
      sku: item.sku,
      quantity: item.quantity,
      unitGrossCents: item.unitGrossCents,
      lineGrossCents: item.lineGrossCents,
    })),
  });

  if (!decision.applies) {
    return { applied: false, response: { applied: false, message: launchDiscountMessage(decision.reason) } };
  }

  return {
    applied: true,
    perLine: decision.discountedLineGrossCents,
    response: {
      applied: true,
      code: decision.code,
      percent: decision.percent,
      eligibleSubtotalGrossCents: decision.eligibleSubtotalGrossCents,
      discountGrossCents: decision.discountGrossCents,
      discountedSubtotalGrossCents: decision.discountedSubtotalGrossCents,
    },
  };
}

/**
 * Adds a `tax` block when the customer has chosen a destination whose
 * VAT this shop can actually calculate.
 *
 * The ONLY thing taken from the request is which country - never a rate,
 * a net amount or a jurisdiction. Everything else is re-derived from the
 * catalog quote, the zone shipping price and the tax policy. An
 * unrecognised country, or one whose VAT is not implemented, simply
 * yields no tax block: a quote that shows nothing is correct, a quote
 * that shows a made-up rate is not.
 */
function buildQuoteTax(
  quote: CheckoutQuote,
  shippingCountry: unknown,
  discountedLineGrossCents: number[]
): { tax?: QuoteTaxResponse } {
  if (typeof shippingCountry !== "string") return {};
  const country = shippingCountry.trim().toUpperCase();
  if (!ALLOWED_SHIPPING_COUNTRIES.includes(country)) return {};

  const zone = getShippingZone(country);
  if (!zone) return {};

  // THE THRESHOLD IS MEASURED ON THE MERCHANDISE THE CUSTOMER CHOSE,
  // BEFORE ANY CODE - quote.subtotalGrossCents, never the discounted
  // figure. A basket just over it must not LOSE free shipping because a
  // ten percent code was applied, and the session endpoint computes it
  // from the same pre-discount value.
  const shippingGrossCents = computeShippingGrossCents(zone, quote.subtotalGrossCents);
  const outcome = resolveCheckoutTax({
    jurisdictionResult: resolveTaxJurisdiction(country),
    // Taxed on what would actually be charged. The unit stays the
    // catalogue's and only the line carries the reduction, which is the
    // same shape the checkout freezes.
    items: toTaxableCartItems(quote).map((item, index): TaxableCartItem => ({
      ...item,
      lineGrossCents: discountedLineGrossCents[index],
    })),
    shippingGrossCents,
  });
  if (outcome.kind !== "calculated") return {};

  const { snapshot } = outcome;
  return {
    tax: {
      taxCountry: snapshot.taxCountry,
      destinationCountry: snapshot.destinationCountry,
      shippingGrossCents: snapshot.totals.shippingGrossCents,
      netCents: snapshot.totals.totalNetCents,
      taxCents: snapshot.totals.taxTotalCents,
      grossCents: snapshot.totals.totalGrossCents,
      rateBreakdown: snapshot.rateBreakdown,
    },
  };
}
