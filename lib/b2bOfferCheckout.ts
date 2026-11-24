import { isDeepStrictEqual } from "node:util";
import { buildB2bOfferContract } from "./b2bOfferContract.ts";

export function acceptedB2bOfferTerms(value: unknown, address: { country: string | null; zip: string | null }) {
  if (!value || typeof value !== "object") return null;
  const terms = value as Record<string, unknown>;
  if (typeof terms.packs !== "number" || typeof terms.packNetCents !== "number" ||
      typeof terms.country !== "string" || terms.country !== address.country?.trim().toUpperCase() ||
      terms.postcode !== address.zip?.trim()) return null;
  const built = buildB2bOfferContract({
    pack_count: terms.packs, net_unit_cents: terms.packNetCents, destination_country: terms.country,
  }, { planType: terms.planType, instalmentCount: terms.instalmentCount, postcode: terms.postcode });
  return built.ok && isDeepStrictEqual(built.terms, value) ? built.terms : null;
}
