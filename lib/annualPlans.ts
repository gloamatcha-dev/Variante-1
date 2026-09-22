import type { AnnualSize } from "./annualPlanRules";

/**
 * Who may buy a B2C prepaid annual plan, and for which product
 * (Phase 4B2).
 *
 * A leaf, like lib/annualPlanRules.ts: the only import is TYPE-ONLY and
 * therefore erased, so the test runner can load this file. No database,
 * no network, no Stripe, no clock.
 *
 * ── WHY THIS IS SEPARATE FROM annualPlanRules ─────────────────
 *
 * Two different questions, and they change for different reasons:
 *
 *   annualPlanRules   given a size and a canonical catalog price, what
 *                     is the money and what is the schedule. Pure
 *                     arithmetic; no environment, no catalog identity.
 *
 *   this file         is this catalog variant offered as an annual plan
 *                     at all, and is the feature open. Identity and
 *                     availability; it reads process.env.
 *
 * They deliberately do not import each other's VALUES, which is what
 * keeps both loadable by the plain Node test runner - the constraint
 * lib/subscriptionCheckout.ts records about extension-less relative
 * imports. The focused suite imports both and asserts the seam agrees.
 *
 * ── WHAT IT DOES NOT DO ───────────────────────────────────────
 *
 * It creates nothing. It writes nothing. It does not read the catalog: it
 * VALIDATES a canonical variant the caller already resolved server-side
 * through lib/checkoutQuote.ts's buildAuthoritativeQuote, which stays the
 * single commercial truth. That separation is what migration 039's
 * section 11 asked for - pure rule logic apart from the repository
 * lookup - so the commercial path stays unit-testable without Supabase.
 */

/* ── The feature gate ───────────────────────────────────────── */

export const ANNUAL_PLAN_FEATURE_FLAG = "B2C_ANNUAL_PLAN_ENABLED";

/**
 * Server-side only, and closed unless explicitly opened.
 *
 * Exactly the shape lib/subscriptionCheckoutRules.ts established for
 * B2C_SUBSCRIPTIONS_ENABLED, and exactly its semantics: only the string
 * "true" opens it. Missing, empty, "1", "TRUE", "yes" and " true " all
 * leave the annual plan unavailable. Deliberately not a broader truthy
 * parser - two flags in one codebase answering "is this on" differently
 * is how a feature gets enabled by accident.
 *
 * Closed-by-default matters more than usual right now: Phase 4B2 is
 * rules only. There is no annual checkout route, no webhook branch, no
 * fulfillment runtime and no purchase confirmation, so an annual plan
 * that could somehow be started today would be paid for and never
 * activated. The flag stays shut until the phase that handles the
 * payment exists.
 *
 * Server-side application configuration. NOT VITE_-prefixed and not
 * exposed to the browser: no UI reads it in this phase, and a public
 * mirror would be a second place for it to disagree.
 */
export function isAnnualPlanCheckoutEnabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  return env[ANNUAL_PLAN_FEATURE_FLAG] === "true";
}

/* ── Where an annual plan may be delivered ──────────────────── */

/**
 * THE ONE COUNTRY A PREPAID ANNUAL PLAN SHIPS TO.
 *
 * ISO 3166-1 alpha-2, compared against an already-normalised code.
 *
 * Restated from lib/annualPlanCheckoutRules.ts's ANNUAL_ALLOWED_COUNTRY
 * rather than imported, and not for a stylistic reason: that module
 * opens with `import { createHash } from "node:crypto"`, which no
 * browser bundle can resolve. The surfaces that must TELL a customer
 * the plan is Germany-only run in a browser, so the value is duplicated
 * here and tests/annual-plan-purchase-surface.test.mjs asserts the two
 * are equal - the resolution this repository already uses for
 * STALE_SENDING_AFTER_MS and divideRoundHalfUp.
 *
 * THIS IS A DISPLAY AND PRE-FLIGHT CONSTANT ONLY. The server still
 * refuses a non-German address itself, twice: once in
 * validateAnnualAddress and again against the frozen attempt.
 */
export const ANNUAL_DELIVERY_COUNTRY = "DE";

/** Whether an annual plan may be delivered to this normalised country. */
export function isAnnualDeliveryCountry(country: unknown): boolean {
  return typeof country === "string"
    && country.trim().toUpperCase() === ANNUAL_DELIVERY_COUNTRY;
}

/**
 * The sentence every annual surface shows, in one place.
 *
 * A customer choosing a twelve-month prepaid commitment must not
 * discover the geographic limit at the payment step, so the shop says it
 * before the price and the account says it beside the address.
 */
export const ANNUAL_GERMANY_ONLY_NOTE =
  "Der Jahresplan ist aktuell nur für Lieferadressen in Deutschland verfügbar.";

/* ── The handover to the account ────────────────────────────── */

/**
 * Where the shop sends a customer who chose the annual plan.
 *
 * ── WHY THE SHOP CANNOT START THE CHECKOUT ITSELF ─────────────
 *
 * POST /api/annual-plan/checkout/session takes exactly variantId,
 * addressId and requestId, and refuses a body carrying anything else.
 * The addressId is one of the customer's OWN saved addresses, and there
 * is no guest path: a prepaid twelve-month contract has to be reachable
 * for a year, so migration 039 made annual_plans.user_id NOT NULL with
 * no "on delete set null".
 *
 * So the shop states the offer and hands over. It collects no address,
 * mints no request id and posts nowhere - which also keeps the shop
 * free of a second checkout implementation.
 *
 * The SKU travels as a hint so the account can preselect the size the
 * customer was looking at. It is a hint and nothing more: the account
 * re-reads the catalog, and the server re-resolves the price from the
 * variant it validates itself.
 */
export const ANNUAL_PORTAL_PATH = "/account/subscriptions";

/** The account link for one SKU, or the bare path for an unknown one. */
export function annualPortalHref(sku: string | null | undefined): string {
  if (typeof sku !== "string" || ANNUAL_LAUNCH_SIZE_BY_SKU[sku] === undefined) {
    return `${ANNUAL_PORTAL_PATH}?plan=annual`;
  }
  return `${ANNUAL_PORTAL_PATH}?plan=annual&sku=${encodeURIComponent(sku)}`;
}

/* ── The launch allowlist ───────────────────────────────────── */

/**
 * The only variants that may be sold as an annual plan at launch.
 *
 * An ALLOWLIST keyed on SKU, for the reasons this repository has already
 * settled twice. lib/subscriptionCheckoutRules.ts uses one so that "the
 * empty Metal Case must never become a recurring charge, and a fourth SKU
 * appearing in the catalog has to fail closed rather than become
 * subscribable by omission" - both apply here word for word. Migration
 * 024 resolves its launch plans by SKU too, calling it "the stable
 * identity" and refusing to key on a display label, because renaming
 * "30 g" to "30 g Dose" is an ordinary marketing edit that must not be
 * able to change what a plan IS.
 *
 * Not keyed on the variant UUID either: this repository nowhere treats
 * catalog uuids as stable constants, and migration 024 explicitly says a
 * hardcoded id would not survive a restore that reassigns them.
 */
export const ANNUAL_LAUNCH_SIZE_BY_SKU: Readonly<Record<string, AnnualSize>> = Object.freeze({
  "GLOA-MATCHA-30G": "30g",
  "GLOA-MATCHA-50G": "50g",
  "GLOA-MATCHA-100G": "100g",
});

/** The three launch SKUs, for iteration and for tests to enumerate. */
export const ANNUAL_LAUNCH_SKUS: readonly string[] = Object.freeze(
  Object.keys(ANNUAL_LAUNCH_SIZE_BY_SKU)
);

/**
 * Net weight each launch SKU must report.
 *
 * The cross-check below exists because two independent catalog columns
 * describe the same product, and a plan is priced from ONE of them while
 * being identified by the other. If a catalog row ever said
 * GLOA-MATCHA-50G with size_grams 30, the SKU would select the 50 g
 * annual shipping rule for a 30 g box. Refusing the mismatch is cheaper
 * than deciding afterwards which column was right.
 */
export const ANNUAL_LAUNCH_GRAMS_BY_SKU: Readonly<Record<string, number>> = Object.freeze({
  "GLOA-MATCHA-30G": 30,
  "GLOA-MATCHA-50G": 50,
  "GLOA-MATCHA-100G": 100,
});

/* ── Canonical variant validation ───────────────────────────── */

/**
 * The catalog facts an annual plan is resolved from.
 *
 * Shaped to match what lib/checkoutQuote.ts's buildAuthoritativeQuote
 * already returns per line, so the future checkout route hands its quote
 * item straight in rather than re-reading anything: variantId, sku,
 * sizeGrams and unitGrossCents are that function's own field names.
 */
export type CanonicalAnnualVariant = {
  variantId: string;
  sku: string;
  sizeGrams: number | null;
  /** The canonical catalog price. product_variants.price_gross_cents. */
  unitGrossCents: number;
  currency: string;
};

/** A variant proven eligible, and the two inputs the pricing rules need. */
export type AnnualLaunchPlan = {
  variantId: string;
  sku: string;
  size: AnnualSize;
  catalogUnitGrossCents: number;
};

export type AnnualLaunchPlanResult =
  | { ok: true; plan: AnnualLaunchPlan }
  | { ok: false; reason: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Decides whether one canonical catalog variant may be sold as an annual
 * plan, and returns the identity plus the price the rules will work from.
 *
 * FAILS CLOSED on every path. An unknown SKU, a SKU whose weight
 * disagrees with the allowlist, a missing or non-integer price, a
 * currency that is not EUR - each one refuses with a reason and returns
 * no plan. Nothing here supplies a default size, a default discount or a
 * default shipping amount, because a plan nobody priced must not be
 * buyable.
 *
 * It does NOT check the feature flag. Availability and eligibility are
 * different questions with different answers, and the route gates on the
 * flag first, before it resolves anything at all - the order
 * lib/subscriptionCheckout.ts already uses.
 */
export function resolveAnnualLaunchPlan(variant: unknown): AnnualLaunchPlanResult {
  if (!variant || typeof variant !== "object") {
    return { ok: false, reason: "no canonical variant supplied" };
  }
  const candidate = variant as Partial<CanonicalAnnualVariant>;

  if (typeof candidate.sku !== "string" || candidate.sku.trim() === "") {
    return { ok: false, reason: "variant has no sku" };
  }
  const sku = candidate.sku;

  const size = ANNUAL_LAUNCH_SIZE_BY_SKU[sku];
  if (!size) {
    return { ok: false, reason: "sku is not an annual launch product" };
  }

  // The two catalog columns must agree. A null weight fails too: the
  // Metal Case is sold as a unit and has none, and nothing without a
  // weight is an annual Matcha plan.
  if (candidate.sizeGrams !== ANNUAL_LAUNCH_GRAMS_BY_SKU[sku]) {
    return { ok: false, reason: "variant weight does not match its annual launch sku" };
  }

  if (typeof candidate.variantId !== "string" || !UUID_RE.test(candidate.variantId)) {
    return { ok: false, reason: "variant has no usable id" };
  }

  if (
    typeof candidate.unitGrossCents !== "number" ||
    !Number.isSafeInteger(candidate.unitGrossCents) ||
    candidate.unitGrossCents <= 0
  ) {
    return { ok: false, reason: "variant has no usable catalog price" };
  }

  // EUR only, matching the CHECK on annual_plans.currency and on every
  // money table this repository has.
  if (candidate.currency !== "EUR") {
    return { ok: false, reason: "annual plans are sold in EUR only" };
  }

  return {
    ok: true,
    plan: {
      variantId: candidate.variantId,
      sku,
      size,
      catalogUnitGrossCents: candidate.unitGrossCents,
    },
  };
}
