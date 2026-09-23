// The ONE country normaliser this repository has. It is a zero-import
// leaf, so importing it keeps this module loadable by a plain Node test
// and by a browser bundle, and it already knows that addresses written
// before Task 29D-B hold "Deutschland" rather than "DE" - which is
// exactly the case a Berlin rule must not trip over.
import { normalizeCountryCode } from "./shipping.ts";

/**
 * MAY THIS ADDRESS BE DELIVERED BY GLOA ITSELF, IN BERLIN, FOR FREE?
 *
 * One question, one deterministic answer, and the answer is worth money:
 * eligible means the customer is charged nothing for delivery. That is
 * why nothing here is decided by free text.
 *
 * ── THE CITY FIELD IS NOT AN INPUT ────────────────────────────
 *
 * Not "is not trusted" - not an input at all. addresses.city is
 * `text not null default ''` (migration 001), typed by a customer, never
 * validated, and "Berlin" is also a district of several other places.
 * A rule that read it could be satisfied by typing a word. This function
 * cannot be, because the word never reaches it.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DECIDE ──────────────────────
 *
 * Not what shipping costs - lib/b2bShippingRules.ts owns that, and calls
 * this to learn which of its two worlds an address lives in. Not whether
 * GLOA's own van actually drives to a given street: postal Berlin and
 * operational Berlin are different questions, and the second one has no
 * approved answer yet. If an operating-area allowlist is ever needed it
 * narrows this result; it does not replace it.
 */

/* ── Version ────────────────────────────────────────────────── */

/**
 * Written into the frozen delivery snapshot alongside the result.
 *
 * The postcode ranges below are a commercial decision that can change -
 * a district could be excluded, an operating area could grow - and a
 * contract priced under the old rule must stay explicable afterwards.
 * Storing the answer without the version of the rule that produced it
 * makes that impossible.
 */
export const B2B_BERLIN_ELIGIBILITY_VERSION = "berlin-2026.1";

/* ── The rule's two halves ──────────────────────────────────── */

/** Germany only at launch. ISO 3166-1 alpha-2, as normalizeCountryCode returns. */
export const B2B_DELIVERY_COUNTRY = "DE";

/**
 * The approved Berlin postcode ranges, inclusive on both ends.
 *
 * Written as a LIST OF RANGES rather than one span on purpose. Berlin's
 * postcodes do happen to run contiguously from 10115 to 14199 today -
 * Potsdam begins at 14467 and Kleinmachnow at 14532, so the span cuts no
 * Brandenburg territory - but excluding an outlying district later must
 * be an edit to this array, not a rewrite of the comparison.
 *
 * 11xxx is included deliberately: those are Berlin large-customer
 * postcodes (the Bundestag's 11011 among them) and they are Berlin.
 */
export type BerlinPostcodeRange = { from: number; to: number };

export const BERLIN_POSTCODE_RANGES: readonly BerlinPostcodeRange[] = Object.freeze([
  Object.freeze({ from: 10115, to: 14199 }),
]);

/* ── Normalisation ──────────────────────────────────────────── */

/**
 * A German postcode is exactly five digits, or it is not a postcode.
 *
 * NOTHING IS REPAIRED. "1234" does not become "01234", "10115-1" does
 * not lose its suffix, and "1 0 1 1 5" is not squeezed together. Every
 * one of those is a malformed address, and inventing the customer's
 * intent here would hand somebody free delivery on a typo.
 *
 * Surrounding whitespace is the one thing removed, because a trailing
 * space is an artefact of typing rather than a different postcode.
 */
export function normalizeB2bPostcode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^[0-9]{5}$/.test(trimmed) ? trimmed : null;
}

/** Whether a normalised postcode falls inside an approved Berlin range. */
export function isBerlinPostcode(value: unknown): boolean {
  const normalized = normalizeB2bPostcode(value);
  if (normalized === null) return false;
  const numeric = Number(normalized);
  return BERLIN_POSTCODE_RANGES.some(range => numeric >= range.from && numeric <= range.to);
}

/* ── The result ─────────────────────────────────────────────── */

/**
 * Why an address is or is not eligible.
 *
 * Distinct reasons rather than one boolean, because the caller does
 * different things with them: a non-German country ends the whole
 * shipping resolution, while a German non-Berlin address simply moves to
 * the carrier path. A malformed postcode is a third thing again - the
 * customer has to fix something.
 */
export type B2bBerlinReason =
  | "eligible"
  | "country_not_germany"
  | "postcode_malformed"
  | "postcode_outside_berlin";

/**
 * Everything a frozen delivery snapshot needs to record about this
 * decision, so it can be re-read years later without re-running it.
 */
export type B2bBerlinEligibility = {
  eligible: boolean;
  reason: B2bBerlinReason;
  /** From lib/shipping.ts. Null when the country is unrecognised. */
  normalizedCountry: string | null;
  /** Exactly five digits, or null. Never a repaired value. */
  normalizedPostcode: string | null;
  rulesVersion: string;
};

/**
 * The address facts this decision is allowed to see.
 *
 * Two fields, and no city. The database column is addresses.zip; mapping
 * it onto `postcode` is the caller's job, and naming it differently here
 * is intentional - it makes the mapping a visible step rather than a
 * field that silently arrives.
 */
export type B2bBerlinAddressInput = {
  country?: unknown;
  postcode?: unknown;
};

/**
 * The whole rule. All three conditions, in a fixed order.
 *
 * Country is checked FIRST, so a French address with a Berlin postcode
 * reports country_not_germany rather than a postcode verdict that would
 * read as though the postcode were the problem.
 */
export function resolveB2bBerlinEligibility(address: B2bBerlinAddressInput): B2bBerlinEligibility {
  const normalizedCountry = normalizeCountryCode(
    typeof address.country === "string" ? address.country : null
  );
  const normalizedPostcode = normalizeB2bPostcode(address.postcode);

  const base = {
    normalizedCountry,
    normalizedPostcode,
    rulesVersion: B2B_BERLIN_ELIGIBILITY_VERSION,
  };

  if (normalizedCountry !== B2B_DELIVERY_COUNTRY) {
    return { ...base, eligible: false, reason: "country_not_germany" };
  }
  if (normalizedPostcode === null) {
    return { ...base, eligible: false, reason: "postcode_malformed" };
  }
  if (!isBerlinPostcode(normalizedPostcode)) {
    return { ...base, eligible: false, reason: "postcode_outside_berlin" };
  }
  return { ...base, eligible: true, reason: "eligible" };
}
