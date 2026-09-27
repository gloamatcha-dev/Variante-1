/**
 * Which catalog variants may be bought as a 4-WEEK SUBSCRIPTION, for the
 * surfaces that have to decide it in a browser.
 *
 * A leaf, exactly like lib/annualPlans.ts: no relative value import, no
 * database, no network, no Stripe, no clock, no environment. That is what
 * lets /shop and the account portal both import it, and what lets the
 * focused suite load it in a plain Node test.
 *
 * ── AND WHY IT IS NOT lib/subscriptionPlans.ts ────────────────
 *
 * That name is taken, by the SERVER-side plan reader: it imports
 * @supabase/supabase-js, getSupabaseAdmin and import.meta.env, so it is
 * the exact opposite of a leaf and could never be bundled for a browser.
 * The two files answer different questions - that one reads ONE plan row
 * as the server, this one decides which catalog variants may be OFFERED
 * at all - and keeping them apart is what keeps this side loadable.
 *
 * ── WHY THIS IS NOT lib/subscriptionCheckoutRules.ts ──────────
 *
 * That module owns the same three SKUs as LAUNCH_SUBSCRIPTION_SKUS and is
 * the server's authority on them. It cannot be imported here, and not for
 * a stylistic reason: its first line is `import { createHash } from
 * "node:crypto"`, which no browser bundle can resolve. Importing it into
 * a "use client" component would break the shop.
 *
 * So the list is RESTATED and the equality is ASSERTED instead. That is
 * the resolution this repository has already settled on twice for exactly
 * this constraint - lib/transactionalEmailRetryRules.ts and
 * lib/internalOrderNotificationRetryRules.ts each define
 * STALE_SENDING_AFTER_MS with the suite asserting the two agree, and
 * lib/annualPlanRules.ts duplicates lib/tax.ts's divideRoundHalfUp for
 * the same reason, noting that "two leaf modules cannot import each
 * other, so the duplication is asserted instead".
 *
 * tests/subscription-purchase-surface.test.mjs imports BOTH and fails if
 * they ever disagree, so this file cannot silently offer a fourth SKU the
 * server would refuse, and cannot silently drop one the server accepts.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ──────────────────────────
 *
 * It resolves no price. The catalog price reaches the page from
 * product_variants through app/useCatalog.ts, and the AUTHORITATIVE price
 * is resolved again server-side by buildAuthoritativeQuote inside
 * lib/subscriptionCheckout.ts. Nothing here computes money, shipping or
 * tax, because a browser must not be the place any of those is decided.
 *
 * It also does not check the feature gate. B2C_SUBSCRIPTIONS_ENABLED is
 * server-only and is never mirrored into a client bundle - a public copy
 * would be a second place for it to disagree with the server. The route
 * answers 503 while it is closed, and the surfaces show that answer.
 */

/* ── The launch sizes ───────────────────────────────────────── */

/**
 * The three Matcha sizes offered as a 4-week subscription at launch.
 *
 * An ALLOWLIST keyed on SKU, for the reason lib/annualPlans.ts and
 * migration 024 both give: a SKU is the stable identity, a display label
 * is not, and renaming "30 g" to "30 g Dose" is an ordinary marketing
 * edit that must not be able to change what a plan IS.
 *
 * Keyed on SKU rather than on the variant uuid for migration 024's other
 * reason: nowhere in this repository is a catalog uuid treated as a
 * stable constant, and a hardcoded id would not survive a restore that
 * reassigns them.
 *
 * THE METAL CASE IS ABSENT, and absence is the mechanism. GLOA-CASE-01
 * is not listed, carries no net weight, and so fails both checks below -
 * the same fail-closed shape lib/subscriptionCheckoutRules.ts uses to
 * keep "the empty Metal Case must never become a recurring charge" a
 * checked property rather than a convention.
 */
export const SUBSCRIPTION_LAUNCH_GRAMS_BY_SKU: Readonly<Record<string, number>> = Object.freeze({
  "GLOA-MATCHA-30G": 30,
  "GLOA-MATCHA-50G": 50,
  "GLOA-MATCHA-100G": 100,
});

/** The three launch SKUs, in catalog order, for iteration and for tests. */
export const SUBSCRIPTION_LAUNCH_SKUS: readonly string[] = Object.freeze(
  Object.keys(SUBSCRIPTION_LAUNCH_GRAMS_BY_SKU)
);

/* ── Shipping, per delivery ─────────────────────────────────── */

/**
 * The ONE country the German subscription shipping rule applies in.
 *
 * ISO 3166-1 alpha-2, compared against an already-normalised code so a
 * saved address holding "Deutschland" is resolved before it gets here.
 */
export const SUBSCRIPTION_SHIPPING_BENEFIT_COUNTRY = "DE";

/**
 * WHAT A 4-WEEK SUBSCRIPTION DELIVERY COSTS TO SHIP **IN GERMANY**, in
 * gross cents.
 *
 * ══════════════════════════════════════════════════════════════
 * THIS TABLE IS AN EXCEPTION, NOT A SHIPPING PRICE LIST
 * ══════════════════════════════════════════════════════════════
 *
 * It describes one country. Every other destination keeps the shipping
 * price lib/shipping.ts already owns, and those prices are NOT copied
 * here - a second country table is a second answer, and the one that
 * would be wrong is whichever is not the shipping module's.
 *
 * The exception is layered over the normal amount by
 * subscriptionShippingGrossCents below, which takes that normal amount
 * as an ARGUMENT. That is what lets this file stay a zero-import leaf
 * the browser can load while lib/shipping.ts remains the authority on
 * what a destination costs.
 *
 * ── WHY GERMANY NEEDS AN EXCEPTION AT ALL ─────────────────────
 *
 * lib/shipping.ts charges 590 in Germany and WAIVES it once the
 * merchandise subtotal reaches 4900. A subscription delivery is ONE tin
 * and the largest is 39,99, so that threshold can never be reached from
 * a single delivery - but the shop's rule is a rule about a CART, and a
 * subscription delivery is not one. Stating the per-delivery charge here
 * means the day marketing moves the shop's threshold, no subscriber's
 * delivery charge moves with it.
 *
 * ── EVERY SIZE PAYS, ON EVERY DELIVERY ────────────────────────
 *
 * THERE IS NO FREE-SHIPPING THRESHOLD IN THE MONTHLY SUBSCRIPTION.
 * 30 g, 50 g and 100 g each pay 590 per delivery, for as long as the
 * subscription runs. The three amounts stay written out per SKU rather
 * than collapsed into one constant for the reason they always were: a
 * size is its own commercial decision, and a single shared number would
 * make "change one size" impossible to express.
 *
 * Until 2026-09-27 this table waived 50 g and 100 g as a subscription
 * benefit. That benefit is GONE - it is not a threshold that moved, it
 * is a benefit that no longer exists - and nothing downstream may
 * reconstruct it: SUBSCRIPTION_HAS_FREE_SHIPPING_IN_GERMANY below is
 * derived from this table so no sentence can outlive the rule, and the
 * focused suite asserts every size charges.
 *
 * ── AND IT IS NOT THE ANNUAL PLAN'S TABLE ─────────────────────
 *
 * lib/annualPlanRules.ts owns ANNUAL_SHIPPING_PER_DELIVERY_GROSS_CENTS
 * for a different product with a different contract, and it still
 * waives 50 g and 100 g. The two are SEPARATE AUTHORITIES: neither file
 * imports the other, neither number is copied from the other, and the
 * focused suite asserts they are free to disagree - which, since this
 * change, they do.
 *
 * KEYED ON SKU, the stable identity: a renamed "30 g" must not be able
 * to change what a delivery costs.
 */
export const SUBSCRIPTION_DE_SHIPPING_PER_DELIVERY_GROSS_CENTS: Readonly<Record<string, number>> = Object.freeze({
  "GLOA-MATCHA-30G": 590,
  "GLOA-MATCHA-50G": 590,
  "GLOA-MATCHA-100G": 590,
});

/** Whether this destination gets the German subscription rule. */
export function isSubscriptionBenefitCountry(country: unknown): boolean {
  return typeof country === "string"
    && country.trim().toUpperCase() === SUBSCRIPTION_SHIPPING_BENEFIT_COUNTRY;
}

/**
 * The German per-delivery charge for one SKU, or null.
 *
 * Exposed on its own because the SHOP needs it: a signed-out page has no
 * delivery address, so it states the German rule explicitly and says so.
 * Null for any SKU with no entry.
 */
export function subscriptionDeShippingGrossCents(sku: unknown): number | null {
  if (typeof sku !== "string") return null;
  const cents = SUBSCRIPTION_DE_SHIPPING_PER_DELIVERY_GROSS_CENTS[sku];
  return typeof cents === "number" ? cents : null;
}

/**
 * Whether this SKU's German deliveries ship free. Derived, never listed.
 *
 * Kept although the answer is now false for every size, because that is
 * exactly what has to stay CHECKED rather than assumed: a surface that
 * asks gets the table's answer, and the suite asserts the answer is
 * false for all three launch SKUs.
 */
export function subscriptionShipsFreeInGermany(sku: unknown): boolean {
  return subscriptionDeShippingGrossCents(sku) === 0;
}

/**
 * WHAT ONE DELIVERY OF THIS SKU COSTS TO SHIP TO THIS DESTINATION.
 *
 * The whole rule, in one function, and the only one the server calls.
 *
 *   Germany              the table above. Every size pays 590 per
 *                        delivery, on every delivery.
 *   every other country  destinationGrossCents, UNCHANGED - whatever
 *                        lib/shipping.ts computed for that zone. The
 *                        German amount is never applied abroad.
 *
 * ── WHY THE NORMAL AMOUNT IS AN ARGUMENT ──────────────────────
 *
 * Because this file must stay importable by the browser, and
 * lib/shipping.ts is not the problem - the LAYERING is. Passing the
 * destination amount in means the country price has exactly one owner
 * (the shipping module), this file adds exactly one exception, and
 * neither can silently become a copy of the other.
 *
 * Returns null when it cannot answer: an unknown SKU in Germany, or a
 * non-German destination whose normal amount is missing. Null is a real
 * answer and the caller must refuse on it - defaulting to 0 would ship
 * free by accident and defaulting to 590 would charge an unapproved
 * German price to a foreign address.
 */
export function subscriptionShippingGrossCents(input: {
  sku: unknown;
  /** Normalised ISO alpha-2, as lib/shipping.ts's normalizeCountryCode returns. */
  country: unknown;
  /** What lib/shipping.ts charges this destination. Ignored for Germany. */
  destinationGrossCents: unknown;
}): number | null {
  if (isSubscriptionBenefitCountry(input.country)) {
    return subscriptionDeShippingGrossCents(input.sku);
  }
  // Outside Germany the subscription adds nothing and takes nothing
  // away. The SKU is still validated, so an ineligible product cannot
  // acquire a shipping price by travelling.
  if (subscriptionDeShippingGrossCents(input.sku) === null) return null;
  const cents = input.destinationGrossCents;
  if (typeof cents !== "number" || !Number.isSafeInteger(cents) || cents < 0) return null;
  return cents;
}

/**
 * WHETHER ANY GERMAN SUBSCRIPTION DELIVERY SHIPS FREE AT ALL.
 *
 * DERIVED from the table, and false since every size pays. It exists so
 * that "there is no free-shipping threshold in the monthly subscription"
 * is a value a test can read rather than a sentence a comment claims -
 * and so that the day a size is waived again, the wording returns by
 * itself instead of being forgotten.
 */
export const SUBSCRIPTION_HAS_FREE_SHIPPING_IN_GERMANY: boolean =
  Object.values(SUBSCRIPTION_DE_SHIPPING_PER_DELIVERY_GROSS_CENTS).some(cents => cents === 0);

/**
 * The ONE German per-delivery amount, when every size shares it, else null.
 *
 * Derived rather than typed for the same reason as everything else here:
 * the sentence under it must not be able to state a flat price while the
 * table has stopped being flat. Null means the sizes differ, and the
 * surfaces then show the per-size rows only.
 */
export const SUBSCRIPTION_DE_SHIPPING_UNIFORM_GROSS_CENTS: number | null = (() => {
  const amounts = [...new Set(Object.values(SUBSCRIPTION_DE_SHIPPING_PER_DELIVERY_GROSS_CENTS))];
  return amounts.length === 1 ? amounts[0] : null;
})();

/**
 * German cent formatting, for the one sentence below and nothing else.
 *
 * Written out rather than taken from Intl because this file is a leaf
 * that a browser bundle and a plain Node test both load, and a locale
 * database is a dependency on the environment for a value that has to be
 * identical in both. Integer arithmetic on a non-negative amount.
 */
function euroFromCents(cents: number): string {
  return `${Math.floor(cents / 100)},${String(cents % 100).padStart(2, "0")}`;
}

/**
 * "Versand: 5,90 € je Lieferung innerhalb Deutschlands."
 *
 * The monthly subscription's shipping rule as ONE line, for the surfaces
 * that have to state it before a size or an address is chosen.
 *
 * ── WHAT IT REPLACED, AND WHY THE OLD ONE COULD NOT STAY ──────
 *
 * Until 2026-09-27 this said "Ab 50 g kostenloser Versand innerhalb
 * Deutschlands." That sentence described a benefit that no longer
 * exists, and it was derived from a table that no longer has a free
 * size - so it is not reworded, it is REPLACED, and the constant that
 * carried it (SUBSCRIPTION_FREE_SHIPPING_FROM_GRAMS) is deleted rather
 * than left holding null for a caller to misread as "ab 0 g".
 *
 * The country is IN the sentence, not implied by context. The shop shows
 * this before it knows any address, so a bare "5,90 € je Lieferung"
 * would read as a promise to every destination.
 *
 * Null when the sizes do not share one amount, and the surfaces then say
 * nothing global - the per-size rows already carry the truth.
 */
export const SUBSCRIPTION_DE_SHIPPING_NOTE: string | null =
  SUBSCRIPTION_DE_SHIPPING_UNIFORM_GROSS_CENTS === null
    ? null
    : `Versand: ${euroFromCents(SUBSCRIPTION_DE_SHIPPING_UNIFORM_GROSS_CENTS)} € je Lieferung innerhalb Deutschlands.`;

/** The other half of the same fact, and never shown without it. */
export const SUBSCRIPTION_ABROAD_SHIPPING_NOTE =
  "Für Lieferadressen außerhalb Deutschlands gelten die jeweiligen Versandkosten.";

/* ── Eligibility ────────────────────────────────────────────── */

/** The catalog facts a subscription decision is made from. */
export type SubscribableVariant = {
  sku: string;
  size_grams: number | null;
};

/**
 * Whether ONE catalog variant may be offered as a 4-week subscription.
 *
 * FAILS CLOSED on every path. An unknown SKU, a null weight, or a weight
 * that disagrees with the allowlist each return false and no reason to
 * proceed. Nothing here supplies a default size or a default price.
 *
 * The weight cross-check exists for the reason lib/annualPlans.ts states:
 * two independent catalog columns describe the same product, and a row
 * that ever said GLOA-MATCHA-50G with size_grams 30 would be a 30 g tin
 * sold under a 50 g identity. Refusing the mismatch is cheaper than
 * deciding afterwards which column was right.
 */
export function isSubscribableVariant(variant: unknown): boolean {
  if (!variant || typeof variant !== "object") return false;
  const candidate = variant as Partial<SubscribableVariant>;
  if (typeof candidate.sku !== "string") return false;
  const expected = SUBSCRIPTION_LAUNCH_GRAMS_BY_SKU[candidate.sku];
  if (expected === undefined) return false;
  return candidate.size_grams === expected;
}

/* ── The handover to the portal ─────────────────────────────── */

/**
 * Where the shop sends a customer who chose the 4-week option.
 *
 * ── WHY THE SHOP CANNOT START THE CHECKOUT ITSELF ─────────────
 *
 * POST /api/subscriptions/checkout/session takes exactly three fields -
 * planId, addressId, requestId - and refuses a body carrying anything
 * else outright. Two of the three are things the shop does not have and
 * must not invent:
 *
 *   planId     a row in b2c_subscription_plans, whose RLS grants SELECT
 *              to `authenticated` only. A signed-out shop visitor cannot
 *              read the plans at all.
 *   addressId  one of the customer's OWN saved addresses. There is no
 *              guest path: the route answers 401 without a verified
 *              bearer token, because a recurring contract belongs to a
 *              person.
 *
 * So the shop states the offer and hands over. It does not collect an
 * address, does not mint a request id and does not post anywhere - which
 * also keeps the shop free of a second checkout implementation.
 *
 * The SKU travels in the query string so the portal can preselect the
 * size the customer was actually looking at. It is a hint and nothing
 * more: the portal re-reads the plans itself, and the server re-resolves
 * the price from the plan's own variant regardless of what any URL said.
 */
export const SUBSCRIPTION_PORTAL_PATH = "/account/subscriptions";

/** The portal link for one SKU, or the bare portal path for an unknown one. */
export function subscriptionPortalHref(sku: string | null | undefined): string {
  if (typeof sku !== "string" || SUBSCRIPTION_LAUNCH_GRAMS_BY_SKU[sku] === undefined) {
    return SUBSCRIPTION_PORTAL_PATH;
  }
  return `${SUBSCRIPTION_PORTAL_PATH}?sku=${encodeURIComponent(sku)}`;
}

/** Narrows a `?sku=` hint back to a launch SKU, or null. */
export function subscriptionSkuFromHint(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  return SUBSCRIPTION_LAUNCH_GRAMS_BY_SKU[raw] === undefined ? null : raw;
}
