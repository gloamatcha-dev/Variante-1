import { b2bFirstCharge, B2B_TAX_RATE_PERCENT, isB2bSelfServiceShippable, validateB2bCheckoutRequest } from "./b2bCheckoutRules.ts";
import { addTaxToNet } from "./tax.ts";

export function buildB2bOfferContract(
  offer: { pack_count: number; net_unit_cents: number; destination_country: string },
  input: { planType?: unknown; instalmentCount?: unknown; postcode?: unknown },
) {
  const validated = validateB2bCheckoutRequest({
    planType: input.planType,
    packs: offer.pack_count,
    instalmentCount: input.instalmentCount,
    deliveryAddress: { country: offer.destination_country, postcode: input.postcode },
  });
  if (!validated.ok) return validated;
  const quote = validated.quote;
  if (!isB2bSelfServiceShippable(quote)) return { ok: false as const, reason: "shipping_unavailable" };
  if (quote.pricing.packNetCents !== offer.net_unit_cents) {
    return { ok: false as const, reason: "price_not_supported" };
  }
  const first = b2bFirstCharge(quote);
  const annual = "instalmentNetCents" in quote.pricing ? quote.pricing : null;
  const charges = (annual?.instalmentNetCents ?? [first.netCents]).map(
    netCents => addTaxToNet(netCents, B2B_TAX_RATE_PERCENT),
  );
  return { ok: true as const, terms: {
    planType: quote.planType, packs: quote.packs, packNetCents: quote.pricing.packNetCents,
    instalmentCount: quote.instalmentCount, country: quote.normalizedCountry,
    postcode: quote.normalizedPostcode, deliveryIntervalMonths: 1,
    deliveryCount: annual?.deliveryCount ?? null, shippingGrossCents: first.shippingGrossCents,
    charges, pricing: quote.pricingSnapshot,
  } };
}
