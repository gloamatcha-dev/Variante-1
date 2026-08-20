export type ShippingZoneKey = "germany" | "eu" | "nonEuCore" | "restOfEurope";

export type ShippingZone = {
  key: ShippingZoneKey;
  countryCodes: string[]; // ISO 3166-1 alpha-2, matching Stripe's shipping_address_collection.allowed_countries
  minBusinessDays: number;
  maxBusinessDays: number;
  deliveryTimeLabel: string; // derived from min/max below - single source of truth for both the label and Stripe's delivery_estimate
};

/**
 * Per-zone shipping price (confirmed, Task 20B). shippingGrossCents is
 * the price charged when the free-shipping threshold (if any) isn't
 * met. freeShippingThresholdGrossCents is compared against the
 * server-computed merchandise subtotal only (never subtotal+shipping,
 * never a client-reported cart total) - null means that zone never gets
 * free shipping.
 */
export type ShippingPricing = {
  shippingGrossCents: number;
  freeShippingThresholdGrossCents: number | null;
};

function deliveryLabel(min: number, max: number): string {
  return `${min}–${max} Werktage`;
}

// All 27 current EU member states except Germany, which gets its own
// zone/label below (still legally the EU, just a faster label).
const EU_COUNTRIES_EXCLUDING_DE = [
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "GR", "HU",
  "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI",
  "ES", "SE",
];

// Non-EU destinations explicitly requested for launch.
const NON_EU_CORE = ["GB", "CH", "NO"];

// Remaining European destinations that are both Stripe-supported and not
// currently sanctioned/logistically blocked. Deliberately excludes:
// - Russia (RU) and Belarus (BY): sanctions
// - Ukraine (UA): actual shipping feasibility not yet confirmed
//   operationally - add only once that's verified, not assumed
// - Moldova (MD): not offered at launch (business decision, Task 23A)
const REST_OF_EUROPE = [
  "IS", "LI", "AD", "MC", "SM", "AL", "BA", "ME", "MK", "RS",
];

export const SHIPPING_ZONES: Record<ShippingZoneKey, ShippingZone> = {
  germany: { key: "germany", countryCodes: ["DE"], minBusinessDays: 2, maxBusinessDays: 4, deliveryTimeLabel: deliveryLabel(2, 4) },
  eu: { key: "eu", countryCodes: EU_COUNTRIES_EXCLUDING_DE, minBusinessDays: 3, maxBusinessDays: 8, deliveryTimeLabel: deliveryLabel(3, 8) },
  nonEuCore: { key: "nonEuCore", countryCodes: NON_EU_CORE, minBusinessDays: 4, maxBusinessDays: 8, deliveryTimeLabel: deliveryLabel(4, 8) },
  restOfEurope: { key: "restOfEurope", countryCodes: REST_OF_EUROPE, minBusinessDays: 5, maxBusinessDays: 10, deliveryTimeLabel: deliveryLabel(5, 10) },
};

export const SHIPPING_PRICING: Record<ShippingZoneKey, ShippingPricing> = {
  germany: { shippingGrossCents: 590, freeShippingThresholdGrossCents: 4900 },
  eu: { shippingGrossCents: 1290, freeShippingThresholdGrossCents: 7900 },
  nonEuCore: { shippingGrossCents: 1790, freeShippingThresholdGrossCents: null },
  restOfEurope: { shippingGrossCents: 1990, freeShippingThresholdGrossCents: null },
};

/**
 * Server-side shipping amount for a zone, given the authoritative
 * merchandise subtotal (from buildAuthoritativeQuote - never a
 * client-reported cart/subtotal value). Returns 0 (a real, known price -
 * not "unknown") once the zone's free-shipping threshold is met; zones
 * with no threshold (nonEuCore, restOfEurope) always charge the regular
 * price.
 */
export function computeShippingGrossCents(zone: ShippingZoneKey, merchandiseSubtotalGrossCents: number): number {
  const pricing = SHIPPING_PRICING[zone];
  if (pricing.freeShippingThresholdGrossCents !== null && merchandiseSubtotalGrossCents >= pricing.freeShippingThresholdGrossCents) {
    return 0;
  }
  return pricing.shippingGrossCents;
}

const COUNTRY_TO_ZONE: Record<string, ShippingZoneKey> = Object.fromEntries(
  Object.values(SHIPPING_ZONES).flatMap(zone => zone.countryCodes.map(code => [code, zone.key]))
);

/**
 * Every Stripe-allowed shipping country code across all enabled zones.
 * This is the single source Stripe Checkout session creation reads
 * shipping_address_collection.allowed_countries from.
 */
export const ALLOWED_SHIPPING_COUNTRIES: string[] = Object.values(SHIPPING_ZONES).flatMap(z => z.countryCodes);

/**
 * Deterministically maps an ISO 3166-1 alpha-2 country code to its
 * shipping zone, or null if that country isn't an enabled destination.
 */
export function getShippingZone(countryCode: string | null | undefined): ShippingZoneKey | null {
  if (!countryCode) return null;
  return COUNTRY_TO_ZONE[countryCode.toUpperCase()] ?? null;
}

/** The delivery-time label for a country, or null if it isn't a shipping destination. */
export function getDeliveryTimeLabel(countryCode: string | null | undefined): string | null {
  const zone = getShippingZone(countryCode);
  return zone ? SHIPPING_ZONES[zone].deliveryTimeLabel : null;
}

// German display names for customer-facing UI - a raw ISO code should
// never be shown to a customer when a clean name is available.
const COUNTRY_LABELS_DE: Record<string, string> = {
  DE: "Deutschland",
  AT: "Österreich", BE: "Belgien", BG: "Bulgarien", HR: "Kroatien",
  CY: "Zypern", CZ: "Tschechien", DK: "Dänemark", EE: "Estland",
  FI: "Finnland", FR: "Frankreich", GR: "Griechenland", HU: "Ungarn",
  IE: "Irland", IT: "Italien", LV: "Lettland", LT: "Litauen",
  LU: "Luxemburg", MT: "Malta", NL: "Niederlande", PL: "Polen",
  PT: "Portugal", RO: "Rumänien", SK: "Slowakei", SI: "Slowenien",
  ES: "Spanien", SE: "Schweden",
  GB: "Vereinigtes Königreich", CH: "Schweiz", NO: "Norwegen",
  IS: "Island", LI: "Liechtenstein", AD: "Andorra", MC: "Monaco",
  SM: "San Marino", AL: "Albanien", BA: "Bosnien und Herzegowina",
  ME: "Montenegro", MK: "Nordmazedonien", RS: "Serbien",
};

/** Customer-facing country name; falls back to the raw code if unmapped. */
export function getCountryLabel(countryCode: string | null | undefined): string {
  if (!countryCode) return "";
  return COUNTRY_LABELS_DE[countryCode.toUpperCase()] ?? countryCode;
}

export const DELIVERY_TIME_NOTE =
  "Die angegebenen Lieferzeiten sind Richtwerte. Bei Lieferungen außerhalb der EU kann es durch die Zollabfertigung zu Verzögerungen kommen.";

export const CUSTOMS_NOTE =
  "Bei Lieferungen außerhalb der EU können zusätzliche Zölle, Steuern oder Einfuhrabgaben anfallen. Diese werden gegebenenfalls von den zuständigen Behörden bzw. dem Versanddienstleister erhoben.";
