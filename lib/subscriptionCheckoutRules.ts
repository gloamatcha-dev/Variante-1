import { createHash } from "node:crypto";
import type Stripe from "stripe";

/**
 * The decisions behind the B2C subscription checkout (Task 29D-D).
 *
 * A leaf on purpose: type-only imports, no relative value import, no DB,
 * no network, no Stripe client, no clock. That is what makes every rule
 * below directly unit-testable in a plain Node test - the same property
 * lib/tax.ts and lib/shipping.ts were written for, and the reason this
 * file exists separately from the orchestration in
 * lib/subscriptionCheckout.ts.
 *
 * Everything here answers one question: may this request become a
 * recurring charge, and on what terms. Nothing here performs one.
 */

/* ── The feature gate ───────────────────────────────────────── */

export const SUBSCRIPTION_FEATURE_FLAG = "B2C_SUBSCRIPTIONS_ENABLED";

/**
 * Server-side only, and closed unless explicitly opened. Anything other
 * than the exact string "true" - missing, empty, "1", "TRUE", "yes",
 * " true " - leaves subscriptions unavailable.
 *
 * Closed-by-default matters here more than usual: Task 29D-E has not been
 * built, so nothing yet handles invoice.paid. A subscription started
 * today could be paid for and never activated, which is a worse failure
 * than not offering it.
 */
export function isSubscriptionCheckoutEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[SUBSCRIPTION_FEATURE_FLAG] === "true";
}

/* ── Launch shape ───────────────────────────────────────────── */

/** One package per four-week cycle. Not client-configurable in this task. */
export const SUBSCRIPTION_QUANTITY = 1;

/** The one launch cadence, mirrored from lib/stripeRecurringPrice.ts. */
export const PLAN_BILLING_INTERVAL_UNIT = "week";
export const PLAN_BILLING_INTERVAL_COUNT = 4;

/**
 * The only variants a B2C subscription may contain at launch.
 *
 * An allowlist rather than a "not the Metal Case" check: the empty case
 * is a one-off accessory that must never become a recurring charge, and a
 * fourth SKU appearing in the catalog has to fail closed rather than
 * become subscribable by omission.
 */
export const LAUNCH_SUBSCRIPTION_SKUS: readonly string[] = Object.freeze([
  "GLOA-MATCHA-30G",
  "GLOA-MATCHA-50G",
  "GLOA-MATCHA-100G",
]);

/* ── Request validation ─────────────────────────────────────── */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Exactly the fields a subscription checkout may send: which plan, which
 * of the customer's own saved addresses, and an idempotency token. Not
 * one of them is commercial.
 */
export const ALLOWED_REQUEST_FIELDS: readonly string[] = Object.freeze(["planId", "addressId", "requestId"]);

export type SubscriptionCheckoutRequest = {
  planId: string;
  addressId: string;
  requestId: string;
};

export type BodyParseResult =
  | { ok: true; request: SubscriptionCheckoutRequest }
  | { ok: false; error: string };

/**
 * Pure request validation.
 *
 * The rejected-field half is the interesting one. A body carrying
 * unitAmount, shippingGrossCents, userId or stripeCustomerId does not get
 * those fields ignored, it gets refused outright. Ignoring is safe today
 * and one careless destructure away from unsafe tomorrow; refusing keeps
 * "the browser cannot submit a price" a checked property rather than a
 * convention someone has to remember.
 */
export function parseSubscriptionCheckoutBody(body: unknown): BodyParseResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Ungültige Anfrage." };
  }

  const unexpected = Object.keys(body as Record<string, unknown>)
    .filter(key => !ALLOWED_REQUEST_FIELDS.includes(key));
  if (unexpected.length > 0) {
    // Field NAMES only. A rejected body may well contain an address or an
    // amount somebody tried to inject; neither belongs in a log line.
    console.error(`Subscription checkout: rejected unexpected fields: ${unexpected.join(", ")}`);
    return { ok: false, error: "Ungültige Anfrage." };
  }

  const { planId, addressId, requestId } = body as Record<string, unknown>;

  if (typeof requestId !== "string" || !UUID_RE.test(requestId)) {
    return { ok: false, error: "Ungültige Anfrage-ID." };
  }
  if (typeof planId !== "string" || !UUID_RE.test(planId)) {
    return { ok: false, error: "Ungültiges Abo." };
  }
  if (typeof addressId !== "string" || !UUID_RE.test(addressId)) {
    return { ok: false, error: "Ungültige Adresse." };
  }

  return { ok: true, request: { planId, addressId, requestId } };
}

/* ── The plan ───────────────────────────────────────────────── */

export type SubscriptionPlanRow = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  variant_id: string | null;
  billing_interval_unit: string | null;
  billing_interval_count: number | null;
  delivery_interval_unit: string | null;
  delivery_interval_count: number | null;
  discount_percent: number | null;
  commitment_months: number | null;
  is_active: boolean;
};

export type PlanResolution =
  | { ok: true; plan: SubscriptionPlanRow }
  | { ok: false; reason: string };

/**
 * Every invariant a launch plan has to satisfy before it may price a
 * subscription.
 *
 * Checked against the row, never assumed from the seed. Migration 024
 * wrote three correct plans, but a plan is data: it can be edited by hand
 * afterwards. A plan that has drifted is refused, never repaired -
 * converting a monthly plan into a four-weekly one, or reading a NULL
 * cadence as the launch cadence, would bill somebody on a rhythm they
 * never agreed to.
 */
export function validateLaunchPlan(plan: SubscriptionPlanRow | null | undefined): PlanResolution {
  if (!plan) return { ok: false, reason: "plan not found" };
  if (!plan.is_active) return { ok: false, reason: `plan ${plan.slug} is not active` };
  if (!plan.variant_id) return { ok: false, reason: `plan ${plan.slug} has no product variant` };

  if (plan.billing_interval_unit !== PLAN_BILLING_INTERVAL_UNIT
    || plan.billing_interval_count !== PLAN_BILLING_INTERVAL_COUNT) {
    return { ok: false, reason: `plan ${plan.slug} is not billed every ${PLAN_BILLING_INTERVAL_COUNT} ${PLAN_BILLING_INTERVAL_UNIT}s` };
  }

  // Billing and delivery must agree. A plan that charges every four weeks
  // and delivers on some other rhythm is a different product from the one
  // the customer is being shown.
  if (plan.delivery_interval_unit !== PLAN_BILLING_INTERVAL_UNIT
    || plan.delivery_interval_count !== PLAN_BILLING_INTERVAL_COUNT) {
    return { ok: false, reason: `plan ${plan.slug} does not deliver every ${PLAN_BILLING_INTERVAL_COUNT} ${PLAN_BILLING_INTERVAL_UNIT}s` };
  }

  // There is no B2C subscription discount and no commitment term. NULL
  // means "not applicable"; a number means somebody configured a
  // commercial condition this flow cannot honour, so it stops.
  if (plan.discount_percent !== null) {
    return { ok: false, reason: `plan ${plan.slug} carries a discount, which the launch flow does not implement` };
  }
  if (plan.commitment_months !== null) {
    return { ok: false, reason: `plan ${plan.slug} carries a commitment term, which the launch flow does not implement` };
  }

  return { ok: true, plan };
}

/* ── The saved address ──────────────────────────────────────── */

export type SavedAddressRow = {
  id: string;
  user_id: string;
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  street: string | null;
  house_number: string | null;
  zip: string | null;
  city: string | null;
  country: string | null;
};

/** The frozen shape, identical to the one orders use. */
export type SubscriptionAddressSnapshot = {
  name: string | null;
  company: string | null;
  line1: string | null;
  line2: string | null;
  city: string | null;
  postalCode: string | null;
  state: string | null;
  country: string | null;
};

export type AddressResolution =
  | { ok: true; snapshot: SubscriptionAddressSnapshot; recipientName: string }
  | { ok: false; reason: string };

/**
 * Turns a saved address row plus an ALREADY-NORMALISED country code into
 * the frozen snapshot, or refuses it.
 *
 * The country arrives normalised rather than being normalised here so
 * this stays a leaf: normalizeCountryCode lives in lib/shipping.ts and is
 * the one place that knows which destinations exist. The caller does that
 * step and hands in the result, or refuses before reaching this at all.
 *
 * The completeness checks are not pedantry. Migration 001 defaults every
 * address field to an empty string, so a half-filled saved address is an
 * ordinary thing to encounter, and shipping a recurring order to one
 * would fail quietly every four weeks instead of once.
 */
export function buildSubscriptionAddressSnapshot(
  address: SavedAddressRow | null | undefined,
  normalizedCountryCode: string | null
): AddressResolution {
  if (!address) return { ok: false, reason: "address not found" };

  const street = (address.street ?? "").trim();
  const houseNumber = (address.house_number ?? "").trim();
  const zip = (address.zip ?? "").trim();
  const city = (address.city ?? "").trim();
  const firstName = (address.first_name ?? "").trim();
  const lastName = (address.last_name ?? "").trim();

  if (!street || !houseNumber || !zip || !city) {
    return { ok: false, reason: "address is incomplete" };
  }
  if (!firstName && !lastName) {
    return { ok: false, reason: "address has no recipient name" };
  }
  if (!normalizedCountryCode) {
    // Null is a real answer from normalizeCountryCode and it means the
    // country is unrecognised or unsupported. It must never quietly
    // become Germany.
    return { ok: false, reason: "address country is not a supported destination" };
  }

  const recipientName = [firstName, lastName].filter(Boolean).join(" ");

  return {
    ok: true,
    recipientName,
    snapshot: {
      name: recipientName,
      company: (address.company ?? "").trim() || null,
      // The same shape order snapshots use, so a subscription order and a
      // one-time order describe an address identically. line1 is composed
      // rather than parsed: street and house number are separate columns
      // here and the split is not reliably recoverable from one line.
      line1: `${street} ${houseNumber}`.trim(),
      line2: null,
      city,
      postalCode: zip,
      state: null,
      country: normalizedCountryCode,
    },
  };
}

/* ── Stripe wiring ──────────────────────────────────────────── */

/**
 * The Stripe idempotency key for one subscription Checkout Session.
 *
 * Tied to the checkout attempt, which is server-generated and stable
 * across retries of the same request_id, so a double click sends the same
 * key and Stripe replays one session instead of opening two. Internal and
 * free of anything personal: no email, no name, no address, no user id.
 */
export function subscriptionCheckoutIdempotencyKey(attemptId: string): string {
  return `gloa-sub-checkout-${attemptId}`;
}

/**
 * The recurring line items.
 *
 * Both lines are recurring Prices on the same week/4 cadence. Shipping in
 * particular must NOT be a one-time charge or a Stripe shipping_rate: a
 * subscription that collects shipping once and then delivers every four
 * weeks forever would give the delivery away after the first cycle.
 *
 * A zero shipping charge produces no line at all rather than a 0.00 line.
 * Free shipping is a real, known price, and an empty invoice line would
 * only invite the question of whether something had failed.
 */
export function buildSubscriptionLineItems(input: {
  productPriceId: string;
  shippingPriceId: string | null;
}): Stripe.Checkout.SessionCreateParams.LineItem[] {
  const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [
    { price: input.productPriceId, quantity: SUBSCRIPTION_QUANTITY },
  ];
  if (input.shippingPriceId) {
    lineItems.push({ price: input.shippingPriceId, quantity: SUBSCRIPTION_QUANTITY });
  }
  return lineItems;
}

/* ── Retry identity ─────────────────────────────────────────── */

/**
 * Bumped whenever the field list or the serialisation below changes in a
 * way that would produce a different digest for the same intent. An old
 * attempt then simply stops matching, which fails closed and asks for a
 * new checkout rather than silently comparing two different things.
 */
export const FINGERPRINT_VERSION = "gloa-sub-fp-1";

/**
 * The canonical field order, stated explicitly.
 *
 * The contract is this array, NOT the property order of whatever object
 * a caller happens to build. JavaScript preserves insertion order for
 * string keys, which makes it look safe to serialise an object directly
 * and makes it silently wrong the day two call sites construct their
 * fields in a different sequence.
 */
/**
 * The IDENTITY half: what the caller actually asked for, by name.
 *
 * Every one of these is either supplied by the browser (planId,
 * addressId), taken from the verified token (userId), or a constant of
 * the flow (quantity). None of them is server state that can change
 * underneath a request.
 *
 * That distinction is the whole point. A retry has to answer two
 * different questions - "is this the same checkout" and "are the priced
 * terms still the ones that were frozen" - and they stop having the same
 * answer the moment a subscription exists. See
 * subscriptionIntentFingerprint below.
 */
export const INTENT_FINGERPRINT_FIELDS = Object.freeze([
  "userId",
  "planId",
  "addressId",
  "quantity",
] as const);

export const FINGERPRINT_FIELDS = Object.freeze([
  "userId",
  "planId",
  "addressId",
  "addressDigest",
  "variantId",
  "quantity",
  "currency",
  "shippingCountry",
  "shippingZone",
  "shippingGrossCents",
  "subtotalGrossCents",
  "totalGrossCents",
  "taxCalculationVersion",
  "taxTreatment",
  "taxTotalCents",
] as const);

/**
 * ASCII unit separator, written as an escape so no invisible control
 * character sits in the source. None of the hashed values can contain
 * one, so two different field lists cannot concatenate into the same
 * string the way an empty or a common separator would allow.
 */
const FIELD_SEPARATOR = "\u001f";

function digest(parts: string[]): string {
  return createHash("sha256").update(parts.join(FIELD_SEPARATOR), "utf8").digest("hex");
}

/**
 * A digest of WHERE this subscription is to be delivered.
 *
 * It exists because a saved address can be edited between a request and
 * its retry. Binding only the addressId would let one request id cover
 * two different streets: the retry would create a subscription delivered
 * somewhere the original request never described. Binding the contents
 * makes an edited address a different intent, which fails closed and asks
 * for a new checkout.
 *
 * It is a digest rather than the values because comparison is the only
 * thing anyone needs from it. The result goes into a database column and
 * into no log line, and it cannot be read back into an address.
 *
 * The recipient name is included deliberately: it is part of the shipping
 * snapshot that gets frozen onto the subscription, so a change to it is a
 * change to what would have been frozen.
 */
export function subscriptionAddressDigest(snapshot: SubscriptionAddressSnapshot): string {
  return digest([
    FINGERPRINT_VERSION,
    "addr",
    snapshot.name ?? "",
    snapshot.company ?? "",
    snapshot.line1 ?? "",
    snapshot.line2 ?? "",
    snapshot.postalCode ?? "",
    snapshot.city ?? "",
    snapshot.state ?? "",
    snapshot.country ?? "",
  ]);
}

export type SubscriptionRequestIntent = {
  userId: string;
  planId: string;
  addressId: string;
  /** From subscriptionAddressDigest. Never the raw address. */
  addressDigest: string;
  variantId: string;
  quantity: number;
  currency: string;
  shippingCountry: string;
  shippingZone: string;
  shippingGrossCents: number;
  subtotalGrossCents: number;
  totalGrossCents: number;
  taxCalculationVersion: string;
  taxTreatment: string;
  taxTotalCents: number;
};

/**
 * The fingerprint of one exact subscription checkout intent.
 *
 * A request_id is an idempotency token, never commercial authority. This
 * is what makes "the same request" a checkable claim rather than a
 * convention: the same token arriving with a different customer, a
 * different plan, a different saved address, a different address CONTENT,
 * a different product or a different priced amount produces a different
 * digest, and the flow refuses it.
 *
 * The destination country alone was the previous check and it was not
 * enough. Two Berlin addresses are both DE and are two different delivery
 * intents.
 *
 * Nothing personal survives into the stored value: the address is already
 * reduced to a digest before it gets here, and no email, name or token is
 * an input.
 */
export function subscriptionRequestFingerprint(intent: SubscriptionRequestIntent): string {
  // Ordered by the exported contract, not by the object's own key order.
  const parts = FINGERPRINT_FIELDS.map(field => String(intent[field]));
  return digest([FINGERPRINT_VERSION, "intent", ...parts]);
}

/**
 * WHICH checkout this is, independent of what anything currently costs.
 *
 * This exists because the full fingerprint above answers a question that
 * stops being the right one once a subscription has been created.
 *
 * Consider a customer whose pending subscription already exists, who then
 * edits their saved address - or whose catalog price changes, or whose
 * shipping rate is adjusted - and who then returns to the same checkout.
 * The full fingerprint would differ and the retry would be refused, so
 * they could never reach the Stripe session for the subscription they
 * already have. Nothing is wrong with that subscription: it was frozen,
 * and it is authoritative. The request has not become a different
 * request, the world has moved on around it.
 *
 * So the identity half is compared always, and the priced half only while
 * the subscription does not exist yet. A different customer, plan or
 * saved address is still a different checkout on both paths - two Berlin
 * addresses are two delivery intents whether or not a subscription has
 * been created.
 */
export function subscriptionIntentFingerprint(intent: SubscriptionRequestIntent): string {
  const parts = INTENT_FINGERPRINT_FIELDS.map(field => String(intent[field]));
  return digest([FINGERPRINT_VERSION, "identity", ...parts]);
}

/**
 * Whether an existing attempt is really a retry of THIS request.
 *
 * A NULL stored fingerprint is refused rather than treated as "no
 * objection". It means the attempt was created by the one-time payment
 * flow, and starting a subscription on one would attach a recurring
 * charge to a snapshot that was never priced for it - which is reachable
 * simply by sending a request_id that already exists.
 */
export function attemptMatchesFingerprint(
  storedFingerprint: string | null | undefined,
  computedFingerprint: string
): boolean {
  if (typeof storedFingerprint !== "string" || storedFingerprint.length === 0) return false;
  return storedFingerprint === computedFingerprint;
}
