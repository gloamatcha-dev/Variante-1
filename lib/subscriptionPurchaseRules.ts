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
