/**
 * Tax jurisdiction resolution (Task 21C).
 *
 * Answers exactly one question: which tax jurisdiction does a destination
 * country belong to? It deliberately contains no rate, no threshold, no
 * registration state and no calculation. Those depend on facts about
 * Cara 2 GmbH that are not confirmed yet (Task 21B), and encoding a guess
 * here would put it straight into paid-order snapshots later.
 *
 * Why this is not part of lib/shipping.ts: a shipping zone answers "what
 * does delivery cost and how long does it take", which is a commercial
 * decision. A tax jurisdiction answers "whose VAT rules apply", which is
 * a legal one. They genuinely disagree:
 *
 *   Monaco        ships in the rest-of-Europe zone, but is EU VAT
 *                 territory treated as France.
 *   Liechtenstein ships in the same zone, but sits in the Swiss VAT and
 *                 customs union.
 *
 * Reusing the shipping zone as a tax zone would get both of those wrong,
 * so the two models are kept independent. tests/tax-jurisdiction.test.mjs
 * cross-checks that this module covers exactly the countries the shop
 * actually ships to, so the two cannot drift apart unnoticed.
 *
 * Pure and leaf: no imports, no DB, no network, no import.meta.env.
 */

/** Which body of VAT rules governs a destination. */
export type TaxJurisdictionKind =
  /** Domestic German supply. */
  | "germany"
  /** EU VAT territory other than Germany. */
  | "eu"
  | "united_kingdom"
  /** Swiss VAT territory, which also covers Liechtenstein. */
  | "switzerland"
  | "norway"
  /** Independent import-tax country with no special arrangement here. */
  | "third_country";

export type TaxJurisdiction = {
  kind: TaxJurisdictionKind;
  /** Where the goods actually go, ISO 3166-1 alpha-2, uppercase. */
  destinationCountry: string;
  /**
   * The country whose VAT rules govern, when that is a settled matter of
   * territory (e.g. Monaco is governed by France). Null for independent
   * third countries, where naming a VAT country would imply an obligation
   * this module is not entitled to assert.
   */
  vatCountry: string | null;
};

/**
 * Fail-closed result. An unknown or unsupported country can never be
 * mistaken for a usable jurisdiction, because the caller has to check
 * `supported` before it can reach one.
 */
export type TaxJurisdictionResult =
  | { supported: true; jurisdiction: TaxJurisdiction }
  | { supported: false; reason: string };

/**
 * EU Member States other than Germany. Germany is deliberately absent:
 * it is its own jurisdiction below, because domestic supply and
 * intra-EU distance selling are different situations.
 */
const EU_MEMBER_STATES_EXCLUDING_DE = [
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "GR", "HU",
  "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI",
  "ES", "SE",
] as const;

/**
 * Territories whose ISO code differs from the country whose VAT rules
 * apply. Both entries are settled territorial law, not policy:
 *
 *   MC - VAT Directive 2006/112/EC Art. 7: Monaco is not a third country
 *        and transactions intended for it are treated as intended for
 *        France.
 *   LI - Liechtenstein forms a customs and VAT union with Switzerland
 *        and applies Swiss VAT law.
 */
const SPECIAL_TERRITORIES: Readonly<Record<string, TaxJurisdiction>> = Object.freeze({
  MC: { kind: "eu", destinationCountry: "MC", vatCountry: "FR" },
  LI: { kind: "switzerland", destinationCountry: "LI", vatCountry: "CH" },
});

/** Non-EU countries that get their own jurisdiction rather than the generic bucket. */
const OWN_JURISDICTION: Readonly<Record<string, TaxJurisdictionKind>> = Object.freeze({
  GB: "united_kingdom",
  CH: "switzerland",
  NO: "norway",
});

/**
 * Independent import-tax countries the shop ships to. Listed explicitly
 * rather than used as a fallback, so an unrecognised code fails closed
 * instead of quietly becoming a third country.
 */
const INDEPENDENT_THIRD_COUNTRIES = ["IS", "AD", "SM", "AL", "BA", "ME", "MK", "RS"] as const;

/** Every country this module can classify. */
export const TAX_SUPPORTED_COUNTRIES: readonly string[] = Object.freeze([
  "DE",
  ...EU_MEMBER_STATES_EXCLUDING_DE,
  ...Object.keys(SPECIAL_TERRITORIES),
  ...Object.keys(OWN_JURISDICTION),
  ...INDEPENDENT_THIRD_COUNTRIES,
]);

/**
 * Every country above that sits in an EU VAT territory other than
 * Germany, i.e. every destination an intra-EU distance sale can go to.
 * Derived from the same tables the resolver uses rather than restated:
 * a hand-written list would sooner or later forget Monaco.
 *
 * Task 21D passes this into SQL so the threshold guard can recognise
 * paid EU orders whose relevant turnover was never recorded.
 */
export const EU_VAT_TERRITORY_COUNTRIES: readonly string[] = Object.freeze([
  ...EU_MEMBER_STATES_EXCLUDING_DE,
  ...Object.entries(SPECIAL_TERRITORIES)
    .filter(([, jurisdiction]) => jurisdiction.kind === "eu")
    .map(([code]) => code),
]);

/**
 * Normalises an ISO 3166-1 alpha-2 code, or null when the input is not
 * one. Lowercase is accepted and upper-cased, matching getShippingZone in
 * lib/shipping.ts, so the two never disagree about the same input.
 */
function normalizeCountryCode(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const code = value.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : null;
}

/**
 * Resolves a destination country to its tax jurisdiction.
 *
 * Returns a result object rather than throwing, matching how the rest of
 * this codebase reports expected outcomes (see the checkout quote and the
 * cancellation RPC). Unknown, malformed and unsupported inputs all return
 * `supported: false`, so no caller can obtain a jurisdiction it should
 * not have.
 */
export function resolveTaxJurisdiction(countryCode: string | null | undefined): TaxJurisdictionResult {
  const code = normalizeCountryCode(countryCode);
  if (!code) {
    return { supported: false, reason: "not a valid ISO 3166-1 alpha-2 country code" };
  }

  const special = SPECIAL_TERRITORIES[code];
  if (special) return { supported: true, jurisdiction: { ...special } };

  if (code === "DE") {
    return { supported: true, jurisdiction: { kind: "germany", destinationCountry: "DE", vatCountry: "DE" } };
  }

  if ((EU_MEMBER_STATES_EXCLUDING_DE as readonly string[]).includes(code)) {
    return { supported: true, jurisdiction: { kind: "eu", destinationCountry: code, vatCountry: code } };
  }

  const ownKind = OWN_JURISDICTION[code];
  if (ownKind) {
    return { supported: true, jurisdiction: { kind: ownKind, destinationCountry: code, vatCountry: code } };
  }

  if ((INDEPENDENT_THIRD_COUNTRIES as readonly string[]).includes(code)) {
    // No vatCountry: this module knows where the goods go, not what the
    // destination will charge or who must account for it.
    return { supported: true, jurisdiction: { kind: "third_country", destinationCountry: code, vatCountry: null } };
  }

  return { supported: false, reason: `no tax jurisdiction is defined for country ${code}` };
}

/** Convenience predicate. Never use it to bypass the fail-closed result. */
export function isTaxSupportedCountry(countryCode: string | null | undefined): boolean {
  return resolveTaxJurisdiction(countryCode).supported;
}
