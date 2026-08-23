import { validateQuoteItems, buildAuthoritativeQuote, type CheckoutQuote } from "../../../../lib/checkoutQuote";
import { ALLOWED_SHIPPING_COUNTRIES, getShippingZone, computeShippingGrossCents } from "../../../../lib/shipping";
import { resolveTaxJurisdiction } from "../../../../lib/taxJurisdiction";
import { resolveCheckoutTax, toTaxableCartItems, berlinCalendarYear, type CartTaxSnapshot } from "../../../../lib/tax";

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

  const { items, shippingCountry } = body as { items?: unknown; shippingCountry?: unknown };
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

  return Response.json({ ...result.quote, ...buildQuoteTax(result.quote, shippingCountry) }, { status: 200 });
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
function buildQuoteTax(quote: CheckoutQuote, shippingCountry: unknown): { tax?: QuoteTaxResponse } {
  if (typeof shippingCountry !== "string") return {};
  const country = shippingCountry.trim().toUpperCase();
  if (!ALLOWED_SHIPPING_COUNTRIES.includes(country)) return {};

  const zone = getShippingZone(country);
  if (!zone) return {};

  const shippingGrossCents = computeShippingGrossCents(zone, quote.subtotalGrossCents);
  const outcome = resolveCheckoutTax({
    jurisdictionResult: resolveTaxJurisdiction(country),
    items: toTaxableCartItems(quote),
    shippingGrossCents,
    calendarYear: berlinCalendarYear(),
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
