import {
  B2B_INSTALMENT_COUNTS,
  B2B_SELF_SERVICE_MAX_PACKS,
  B2B_MIN_PACKS,
  buildB2bAnnualPricing,
  buildB2bMonthlyPricing,
  isInstalmentCount,
  isSelfServicePackCount,
  type B2bAnnualPricing,
  type B2bMonthlyPricing,
} from "./b2bPricingRules.ts";
import {
  B2B_DELIVERY_COUNTRY,
  resolveB2bBerlinEligibility,
  type B2bBerlinEligibility,
} from "./b2bBerlinEligibility.ts";
import { netOriginTaxMetadata } from "./tax.ts";

/**
 * Every decision the B2B self-service checkout makes, and none of the
 * side effects (Package 5A).
 *
 * A PURE LEAF. No Stripe client, no Supabase client, no env access, no
 * network, no database, no clock, no randomness. Its only imports are
 * the three already-approved authorities, and each is imported with an
 * explicit .ts extension so the Node test runner can load this file -
 * the same convention lib/b2bShippingRules.ts uses on the same
 * neighbours.
 *
 * ── WHAT THIS FILE REFUSES TO DO ──────────────────────────────
 *
 * IT COMPUTES NO PRICE OF ITS OWN. Not one multiplication, not one
 * rounding, not one discount. Every net figure comes from
 * lib/b2bPricingRules.ts (b2b-2026.1) and every tax marker from
 * lib/tax.ts (de-net-2026.1). A formula restated here would be a second
 * pricing authority that could drift from the one the migrations
 * validate against, which is exactly the failure 059's snapshot CHECK
 * exists to catch.
 *
 * AND IT NEVER TOUCHES THE B2C QUOTE. lib/checkoutQuote.ts prices a
 * gross-origin cart with catalog prices, shipping zones and a launch
 * discount. B2B is net-origin, single-product and contractual. The two
 * must not meet: this module does not import it, and the focused suite
 * asserts that it does not.
 *
 * ── WHAT IT DOES NOT DO YET ───────────────────────────────────
 *
 * It creates nothing. No Stripe Checkout Session, no Stripe Customer, no
 * agreement, no payment schedule, no delivery, no order. Package 5A ends
 * at the contract; 5B builds the session, 5C settles it.
 *
 * Shipping is deliberately absent too. The country gate below is a
 * COMMERCIAL eligibility test - does GLOA sell a supply contract to this
 * address at all - and it is not a routing decision. Which carrier
 * serves a delivery, and at what reference cost, is resolved per
 * delivery at resolution time (Package 5E) by lib/b2bShippingRules.ts,
 * and migration 060 refuses to store anything else.
 */

/* ── Plan types ─────────────────────────────────────────────── */

/**
 * The two self-service plans, and there is no third.
 *
 * These are the exact strings migration 059 admits in
 * b2b_supply_agreements.plan_type. A legacy negotiated agreement carries
 * NULL there and is not reachable from this flow at all.
 */
export const B2B_PLAN_TYPES = Object.freeze(["monthly", "annual"] as const);

export type B2bPlanType = (typeof B2B_PLAN_TYPES)[number];

export function isB2bPlanType(value: unknown): value is B2bPlanType {
  return value === "monthly" || value === "annual";
}

/* ── The metadata contract (defined now, used in 5B) ────────── */

/**
 * The version marker this flow writes, matching the one every other
 * flow writes.
 *
 * Deliberately "1", the same value the one-time, subscription and annual
 * flows use. The version is not the discriminator - the routing KEY is -
 * and giving B2B a different version would only mean a future reader had
 * to know three numbers instead of one.
 */
export const B2B_CHECKOUT_VERSION = "1";

/**
 * THE KEY THAT ROUTES A CHECKOUT SESSION TO THE B2B BRANCH.
 *
 * It is the only key of the four that no other flow ever writes, which
 * is what makes its PRESENCE the routing decision and the other three
 * REQUIRED rather than optional once it is there:
 *
 *   one-time      checkout_version, request_id, checkout_attempt_id
 *                 (+ discount_code when one was applied)
 *   subscription  gloa_subscription_id, and mode "subscription"
 *   annual        gloa_annual_plan_id
 *   B2B           gloa_b2b_agreement_id          <- this one
 *
 * Nothing about the amount, the plan, the pack count, the company name,
 * the email or the customer is a routing key. All of those are
 * customer-visible or configuration-derived, all of them can coincide
 * across products, and one of them changing must never re-route a
 * payment. This is the rule lib/annualPlanWebhookRules.ts states for the
 * annual branch, restated because it binds this branch identically.
 *
 * NO EXISTING KEY CHANGES. This is purely additive: a session that does
 * not carry this key is classified exactly as it was before Package 5
 * existed, and routeAnnualSession() answers "not_annual" for a B2B
 * session because gloa_annual_plan_id is absent from it.
 */
export const B2B_SESSION_AGREEMENT_METADATA_KEY = "gloa_b2b_agreement_id";

/**
 * The routing keys owned by the other three flows.
 *
 * A B2B session must never carry one. Listed as data rather than left
 * implicit so the focused suite can assert the disjointness directly,
 * and so a future flow that invents a fourth key is forced to think
 * about this list.
 */
export const B2B_FOREIGN_ROUTING_KEYS: readonly string[] = Object.freeze([
  "gloa_annual_plan_id",
  "gloa_subscription_id",
  "gloa_checkout_attempt_id",
]);

/** The four correlation identifiers a B2B session must carry. */
export type B2bSessionMetadata = {
  checkoutVersion: string;
  requestId: string;
  checkoutAttemptId: string;
  agreementId: string;
};

/**
 * Builds the metadata a future B2B Checkout Session carries.
 *
 * Correlation identifiers ONLY. No amount, no pack count, no plan type,
 * no company name, no address and no email: Stripe metadata is not where
 * this shop keeps money or identities, and everything the webhook needs
 * to know it re-reads from the database against these ids.
 */
export function buildB2bSessionMetadata(input: {
  requestId: string;
  checkoutAttemptId: string;
  agreementId: string;
}): Record<string, string> {
  return {
    checkout_version: B2B_CHECKOUT_VERSION,
    request_id: input.requestId,
    checkout_attempt_id: input.checkoutAttemptId,
    [B2B_SESSION_AGREEMENT_METADATA_KEY]: input.agreementId,
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type B2bSessionRouting =
  /** Not a B2B session. The existing branches keep it, unchanged. */
  | { kind: "not_b2b" }
  /** B2B, and its correlation metadata is well formed. */
  | { kind: "b2b"; metadata: B2bSessionMetadata }
  /**
   * B2B by the routing key, but the rest is unusable.
   *
   * This is NOT "not B2B". A session carrying an agreement id IS a B2B
   * session, and letting it fall through to a handler written for
   * another product would settle a business supply contract as a
   * one-time cart. The caller must stop, loudly - somebody has already
   * been charged.
   */
  | { kind: "malformed"; reason: string };

/**
 * Classifies a Checkout Session's metadata.
 *
 * PURE, and nothing calls it yet. It is defined in 5A so the routing
 * contract is reviewed with the key that creates it rather than written
 * under time pressure in the webhook package; Package 5C wires it into
 * app/api/stripe/webhook/route.ts ahead of the session.mode test, which
 * is where the annual branch already sits and for the same reason.
 */
export function classifyB2bSessionMetadata(
  metadata: Record<string, unknown> | null | undefined
): B2bSessionRouting {
  const raw = metadata ?? {};
  const agreementId = raw[B2B_SESSION_AGREEMENT_METADATA_KEY];

  if (typeof agreementId !== "string" || agreementId.trim() === "") {
    return { kind: "not_b2b" };
  }

  // From here the session IS B2B and every further failure is
  // "malformed", never "not_b2b".
  if (!UUID_RE.test(agreementId)) {
    return { kind: "malformed", reason: `${B2B_SESSION_AGREEMENT_METADATA_KEY} is not a uuid` };
  }
  if (raw.checkout_version !== B2B_CHECKOUT_VERSION) {
    return { kind: "malformed", reason: "checkout_version is not the B2B checkout version" };
  }
  const requestId = raw.request_id;
  if (typeof requestId !== "string" || !UUID_RE.test(requestId)) {
    return { kind: "malformed", reason: "request_id is missing or not a uuid" };
  }
  const checkoutAttemptId = raw.checkout_attempt_id;
  if (typeof checkoutAttemptId !== "string" || !UUID_RE.test(checkoutAttemptId)) {
    return { kind: "malformed", reason: "checkout_attempt_id is missing or not a uuid" };
  }
  // A session may belong to exactly one flow. Carrying another flow's
  // routing key means two handlers would each believe it is theirs.
  for (const key of B2B_FOREIGN_ROUTING_KEYS) {
    const foreign = raw[key];
    if (typeof foreign === "string" && foreign.trim() !== "") {
      return { kind: "malformed", reason: `a B2B session also carries ${key}` };
    }
  }

  return {
    kind: "b2b",
    metadata: {
      checkoutVersion: B2B_CHECKOUT_VERSION,
      requestId,
      checkoutAttemptId,
      agreementId,
    },
  };
}

/* ── The checkout request ───────────────────────────────────── */

/**
 * What the browser is allowed to say.
 *
 * Four fields, and NOT ONE OF THEM IS AN AMOUNT. The plan, the quantity,
 * the payment schedule and the delivery address - everything else is
 * derived by an authority on the server.
 */
export type B2bCheckoutRequest = {
  planType?: unknown;
  packs?: unknown;
  instalmentCount?: unknown;
  deliveryAddress?: { country?: unknown; postcode?: unknown } | null | undefined;
};

export type B2bCheckoutRejection =
  | "plan_type_unsupported"
  | "quantity_not_self_service"
  | "monthly_takes_no_instalments"
  | "instalment_count_unsupported"
  | "delivery_address_missing"
  | "country_not_supported"
  | "postcode_malformed"
  | "pricing_unavailable";

/**
 * The frozen answer the future endpoint hands to the writer and to
 * Stripe.
 *
 * `pricingSnapshot` is the exact object migration 059's
 * b2b_supply_agreements_self_service_pricing_snapshot_check validates:
 * a FLAT MERGE of the pricing builder's output and netOriginTaxMetadata(),
 * with no key added and none removed.
 */
export type B2bAuthoritativeQuote = {
  planType: B2bPlanType;
  packs: number;
  /** NULL for monthly. 1, 2 or 4 for annual. */
  instalmentCount: number | null;
  pricing: B2bMonthlyPricing | B2bAnnualPricing;
  pricingSnapshot: Record<string, unknown>;
  /** The canonical Berlin decision, including its negative answers. */
  berlinEligibility: B2bBerlinEligibility;
  /**
   * The normalized pair the future delivery producer must feed
   * lib/b2bShippingRules.ts, so the shipping snapshot and the Berlin
   * snapshot on one delivery row cannot disagree about the address they
   * describe.
   */
  normalizedCountry: string;
  normalizedPostcode: string;
};

export type B2bCheckoutValidation =
  | { ok: true; quote: B2bAuthoritativeQuote }
  | { ok: false; reason: B2bCheckoutRejection };

/**
 * Builds the pricing snapshot exactly as migration 059 expects it.
 *
 * The merge order matters only in that the two objects share no key:
 * the pricing builders emit no calculationVersion and no priceOrigin,
 * and netOriginTaxMetadata() emits nothing else. 059 requires
 * calculationVersion = 'de-net-2026.1' and priceOrigin = 'net' and
 * cross-checks every pricing figure against the agreement's own columns,
 * so a snapshot built any other way is a CHECK violation rather than a
 * stored disagreement.
 */
export function buildB2bPricingSnapshot(
  pricing: B2bMonthlyPricing | B2bAnnualPricing
): Record<string, unknown> {
  return { ...pricing, ...netOriginTaxMetadata() };
}

/**
 * The whole contract check, in one place and in a fixed order.
 *
 * Order is deliberate: the plan is established before the quantity,
 * the quantity before the schedule, and the commercial country gate
 * before any price is built - so a French enquiry is refused as
 * "we do not supply there" rather than being priced first and rejected
 * afterwards.
 */
export function validateB2bCheckoutRequest(input: B2bCheckoutRequest): B2bCheckoutValidation {
  if (!isB2bPlanType(input.planType)) {
    return { ok: false, reason: "plan_type_unsupported" };
  }
  const planType = input.planType;

  if (!isSelfServicePackCount(input.packs)) {
    // 1 to 10 packs, i.e. 0.5 to 5 kg a month. Above that the existing
    // enquiry flow at /api/b2b-lead is the only route, and this endpoint
    // must never quietly become a second one.
    return { ok: false, reason: "quantity_not_self_service" };
  }
  const packs = input.packs;

  if (planType === "monthly") {
    // A monthly agreement has no payment schedule at all - migration
    // 060's integrity assertion raises if an active monthly one has a
    // single row - so accepting an instalment count here would accept a
    // number that can never mean anything.
    if (input.instalmentCount !== undefined && input.instalmentCount !== null) {
      return { ok: false, reason: "monthly_takes_no_instalments" };
    }
  } else if (!isInstalmentCount(input.instalmentCount)) {
    return { ok: false, reason: "instalment_count_unsupported" };
  }
  const instalmentCount = planType === "annual" ? (input.instalmentCount as number) : null;

  const address = input.deliveryAddress;
  if (address === null || address === undefined || typeof address !== "object") {
    return { ok: false, reason: "delivery_address_missing" };
  }

  // GERMANY ONLY, and the canonical resolver answers it. Re-deriving
  // "is this DE" here would be a second country authority that could
  // disagree with the one the delivery row freezes.
  const berlinEligibility = resolveB2bBerlinEligibility(address);
  if (berlinEligibility.reason === "country_not_germany") {
    return { ok: false, reason: "country_not_supported" };
  }
  if (berlinEligibility.normalizedPostcode === null) {
    return { ok: false, reason: "postcode_malformed" };
  }
  // Narrowed by the country check above, and restated so the returned
  // type carries no null.
  const normalizedCountry = berlinEligibility.normalizedCountry ?? B2B_DELIVERY_COUNTRY;

  // THE ONE PRICING CALL. Each plan has exactly one builder and neither
  // is reachable from the other's branch.
  const built =
    planType === "monthly"
      ? buildB2bMonthlyPricing({ packs })
      : buildB2bAnnualPricing({ packs, instalmentCount });

  if (!built.ok) {
    // Unreachable through the guards above, and answered rather than
    // thrown: a pricing authority that refuses an input this module
    // accepted is a disagreement between two rule sets, not a customer
    // error, and it must fail closed.
    return { ok: false, reason: "pricing_unavailable" };
  }

  return {
    ok: true,
    quote: {
      planType,
      packs,
      instalmentCount,
      pricing: built.pricing,
      pricingSnapshot: buildB2bPricingSnapshot(built.pricing),
      berlinEligibility,
      normalizedCountry,
      normalizedPostcode: berlinEligibility.normalizedPostcode,
    },
  };
}

/* ── Re-exported bounds, for callers that need to say them ──── */

/**
 * The self-service window, re-exported rather than restated so a page,
 * an endpoint and a test all read the same two numbers from the same
 * authority.
 */
export const B2B_SELF_SERVICE_PACK_RANGE = Object.freeze({
  min: B2B_MIN_PACKS,
  max: B2B_SELF_SERVICE_MAX_PACKS,
});

/** The approved payment schedules, re-exported from Package 1. */
export const B2B_SUPPORTED_INSTALMENT_COUNTS = B2B_INSTALMENT_COUNTS;
