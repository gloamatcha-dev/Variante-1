import type Stripe from "stripe";
import type { AnnualPricing } from "./annualPlanRules";
import type { AnnualLaunchPlan } from "./annualPlans";
import type { CheckoutAttemptItemSnapshot } from "./checkoutAttemptSnapshot";
import type { AddressSnapshot } from "./orderAddressSnapshot";
import type { CartTaxSnapshot, TaxableCartItem } from "./tax";

/**
 * Every decision the B2C prepaid annual checkout makes, and none of the
 * side effects (Phase 4B3).
 *
 * A leaf, exactly like lib/subscriptionCheckoutRules.ts and for the same
 * reason: type-only imports, no relative value import, no database, no
 * network, no Stripe client, no clock. Node cannot resolve this
 * repository's extension-less relative imports, so a module that
 * value-imports one of its neighbours stops being loadable by the test
 * runner - which is why the flow itself lives in lib/annualPlanCheckout.ts
 * and everything worth executing in a test lives here.
 *
 * That is also why this file computes no money. lib/annualPlanRules.ts
 * owns the arithmetic and cannot be value-imported from here, so an
 * already-calculated AnnualPricing is passed IN. Nothing below multiplies
 * anything by 13 or applies a discount; it only shapes what the
 * arithmetic already decided into the snapshots migration 039 and Stripe
 * require.
 */

/* ── The launch destination ─────────────────────────────────── */

/**
 * Germany only, at launch.
 *
 * The annual shipping rule in lib/annualPlanRules.ts is a GERMAN rule -
 * 590 for 30 g, free for 50 g and 100 g - and no annual price exists for
 * any other destination. Selling into one would mean inventing a figure
 * nobody reviewed and freezing it onto a thirteen-delivery contract, so
 * anything else is refused rather than approximated.
 */
export const ANNUAL_ALLOWED_COUNTRY = "DE";

/**
 * The zone that country belongs to, as checkout_attempts.shipping_zone
 * spells it (migration 015's CHECK) and as lib/shipping.ts keys it.
 * Restated rather than derived, because deriving would mean importing
 * lib/shipping.ts and losing the leaf property; the caller resolves the
 * zone from the country and the focused suite asserts the two agree.
 */
export const ANNUAL_SHIPPING_ZONE = "germany";

/** Marks which checkout produced a Stripe session. Matches the one-time flow's "1". */
export const ANNUAL_CHECKOUT_VERSION = "1";

/* ── Request validation ─────────────────────────────────────── */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Exactly the fields an annual checkout may send: which product, which of
 * the customer's own saved addresses, and an idempotency token.
 *
 * Not one of them is commercial and not one of them is an identity. There
 * is deliberately no quantity (thirteen is a server constant), no country
 * (the saved address decides), no email and no userId (the bearer token
 * decides), and nothing resembling a price.
 */
export const ALLOWED_ANNUAL_REQUEST_FIELDS: readonly string[] =
  Object.freeze(["variantId", "addressId", "requestId"]);

export type AnnualCheckoutRequest = {
  variantId: string;
  addressId: string;
  requestId: string;
};

export type AnnualBodyParseResult =
  | { ok: true; request: AnnualCheckoutRequest }
  | { ok: false; error: string };

/**
 * Pure request validation.
 *
 * An unexpected field is REFUSED, not ignored - the rule
 * lib/subscriptionCheckoutRules.ts already established: "ignoring is safe
 * today and one careless destructure away from unsafe tomorrow; refusing
 * keeps 'the browser cannot submit a price' a checked property rather
 * than a convention someone has to remember". A body carrying
 * annualUnitGrossCents, deliveryCount, discountPercent, total, country or
 * userId therefore fails the request rather than quietly losing them.
 */
export function parseAnnualCheckoutBody(body: unknown): AnnualBodyParseResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Ungültige Anfrage." };
  }

  const unexpected = Object.keys(body as Record<string, unknown>)
    .filter(key => !ALLOWED_ANNUAL_REQUEST_FIELDS.includes(key));
  if (unexpected.length > 0) {
    // Field NAMES only. A rejected body may well carry an address or an
    // amount somebody tried to inject; neither belongs in a log line.
    console.error(`Annual checkout: rejected unexpected fields: ${unexpected.join(", ")}`);
    return { ok: false, error: "Ungültige Anfrage." };
  }

  const { variantId, addressId, requestId } = body as Record<string, unknown>;

  if (typeof requestId !== "string" || !UUID_RE.test(requestId)) {
    return { ok: false, error: "Ungültige Anfrage-ID." };
  }
  if (typeof variantId !== "string" || !UUID_RE.test(variantId)) {
    return { ok: false, error: "Ungültiges Produkt." };
  }
  if (typeof addressId !== "string" || !UUID_RE.test(addressId)) {
    return { ok: false, error: "Ungültige Adresse." };
  }

  return { ok: true, request: { variantId, addressId, requestId } };
}

/* ── The destination ────────────────────────────────────────── */

export type AnnualDestinationResult =
  | { ok: true; country: string }
  | { ok: false; reason: string };

/**
 * The Germany-only gate, applied to the FROZEN address snapshot.
 *
 * Checked against the snapshot rather than against the raw row, so the
 * country that is validated is the same string that gets frozen onto the
 * plan. The snapshot's country has already been through
 * normalizeCountryCode, which returns null for anything unsupported and
 * never guesses Germany - so an unrecognised country arrives here as null
 * and is refused, exactly as it should be.
 */
export function requireAnnualDestination(snapshot: AddressSnapshot): AnnualDestinationResult {
  if (snapshot.country !== ANNUAL_ALLOWED_COUNTRY) {
    return { ok: false, reason: "annual plans currently ship to Germany only" };
  }
  return { ok: true, country: ANNUAL_ALLOWED_COUNTRY };
}

/* ── Snapshots ──────────────────────────────────────────────── */

/** The canonical catalog display facts a snapshot needs. Server-resolved. */
export type AnnualCatalogFacts = {
  productName: string;
  variantLabel: string;
  sizeGrams: number | null;
  currency: string;
};

/**
 * ONE delivery, as an items snapshot.
 *
 * This is what migration 039 freezes into
 * annual_plans.delivery_items_snapshot and later copies verbatim into
 * each of the thirteen synthetic paid attempts, which
 * create_order_from_paid_checkout then turns into an order. So it has to
 * be the schema that function already understands - the same shape
 * lib/checkoutAttemptSnapshot.ts builds for every other flow - and it has
 * to describe ONE box:
 *
 *   quantity 1, at the ANNUAL discounted unit price.
 *
 * Never thirteen. Thirteen here would make every delivery order claim to
 * contain a year of Matcha, and 039's
 * annual_plans_delivery_item_quantity_check refuses the row outright.
 */
export function buildAnnualDeliveryItemsSnapshot(input: {
  plan: AnnualLaunchPlan;
  pricing: AnnualPricing;
  catalog: AnnualCatalogFacts;
}): CheckoutAttemptItemSnapshot[] {
  return [{
    variantId: input.plan.variantId,
    sku: input.plan.sku,
    productName: input.catalog.productName,
    variantLabel: input.catalog.variantLabel,
    sizeGrams: input.catalog.sizeGrams,
    quantity: 1,
    unitGrossCents: input.pricing.annualUnitGrossCents,
    lineGrossCents: input.pricing.annualUnitGrossCents,
    currency: input.catalog.currency,
  }];
}

/**
 * THE WHOLE PREPAYMENT, as an items snapshot.
 *
 * This one belongs to the payment checkout attempt and describes what the
 * customer is actually being charged today: thirteen boxes at the annual
 * unit price. It is never copied into a delivery order - only
 * delivery_items_snapshot is - so the two quantities cannot be confused
 * by anything downstream.
 */
export function buildAnnualPaymentItemsSnapshot(input: {
  plan: AnnualLaunchPlan;
  pricing: AnnualPricing;
  catalog: AnnualCatalogFacts;
}): CheckoutAttemptItemSnapshot[] {
  const { pricing } = input;
  return [{
    variantId: input.plan.variantId,
    sku: input.plan.sku,
    productName: input.catalog.productName,
    variantLabel: input.catalog.variantLabel,
    sizeGrams: input.catalog.sizeGrams,
    quantity: pricing.deliveryCount,
    unitGrossCents: pricing.annualUnitGrossCents,
    lineGrossCents: pricing.merchandiseTotalGrossCents,
    currency: input.catalog.currency,
  }];
}

/**
 * The tax engine's input for the WHOLE prepayment.
 *
 * Thirteen units plus the annual shipping TOTAL, so the resulting
 * snapshot's totals.totalGrossCents equals annual_plans.total_gross_cents
 * and totals.shippingGrossCents equals the annual shipping total - which
 * is exactly what 039's annual_plans_annual_tax_total_check verifies.
 *
 * The rates, the categories and the shipping apportionment all come from
 * lib/tax.ts unchanged. Nothing here invents a rate, and nothing here
 * decides WHEN the VAT is recognised: that is a legal question about
 * prepayments which this phase deliberately does not answer. These are
 * frozen technical breakdowns of an amount, not an accounting policy.
 */
export function buildAnnualTaxableItems(input: {
  plan: AnnualLaunchPlan;
  pricing: AnnualPricing;
  productSlug: string;
}): TaxableCartItem[] {
  const { pricing } = input;
  return [{
    variantId: input.plan.variantId,
    sku: input.plan.sku,
    productSlug: input.productSlug,
    quantity: pricing.deliveryCount,
    unitGrossCents: pricing.annualUnitGrossCents,
    lineGrossCents: pricing.merchandiseTotalGrossCents,
  }];
}

/**
 * The tax engine's input for ONE delivery.
 *
 * One unit plus one delivery's shipping, so the resulting snapshot
 * satisfies 039's annual_plans_delivery_tax_total_check and
 * annual_plans_delivery_tax_shipping_check - and, later, migration 021's
 * two raise-conditions when create_order_from_paid_checkout validates the
 * synthetic attempt this snapshot is copied onto.
 */
export function buildDeliveryTaxableItems(input: {
  plan: AnnualLaunchPlan;
  pricing: AnnualPricing;
  productSlug: string;
}): TaxableCartItem[] {
  return [{
    variantId: input.plan.variantId,
    sku: input.plan.sku,
    productSlug: input.productSlug,
    quantity: 1,
    unitGrossCents: input.pricing.annualUnitGrossCents,
    lineGrossCents: input.pricing.annualUnitGrossCents,
  }];
}

/** Who bought it, from server-verified facts only. */
export type AnnualCustomerSnapshot = {
  email: string | null;
  name: string | null;
};

/**
 * The customer snapshot, in the shape orders and subscriptions already
 * use: an email and a name, and nothing else.
 *
 * The email comes from Supabase Auth via the verified bearer token, never
 * from the request body. The name comes from the customer's own saved
 * address row. Neither is an identifier: ownership is
 * annual_plans.user_id, which is the authenticated user id and is
 * re-checked inside 039's RPC under a row lock. Nothing derives
 * ownership from a matching email.
 *
 * No token, no key, no Stripe secret and no authorization data goes in
 * here - this document is readable by the customer through the own-row
 * SELECT policy on public.annual_plans.
 */
export function buildAnnualCustomerSnapshot(input: {
  email: string | null;
  recipientName: string;
}): AnnualCustomerSnapshot {
  return { email: input.email, name: input.recipientName || null };
}

/* ── The frozen attempt, re-checked on every retry ───────────── */

/** The columns a retry is verified against. Everything here is server-written. */
export type FrozenAnnualAttempt = {
  id: string;
  status: string;
  user_id: string | null;
  currency: string;
  expected_total_gross_cents: number;
  items_snapshot: CheckoutAttemptItemSnapshot[] | null;
  shipping_country: string | null;
  shipping_gross_cents: number | null;
  tax_snapshot: CartTaxSnapshot | null;
  stripe_checkout_session_id: string | null;
  annual_plan_id: string | null;
  annual_delivery_number: number | null;
  subscription_id: string | null;
};

export type FrozenAttemptCheck =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Proves that an existing attempt really is THIS annual checkout.
 *
 * ── WHY THERE IS NO FINGERPRINT COLUMN HERE ───────────────────
 *
 * The subscription flow stores two digests on the attempt, because the
 * thing it needs to compare - which PLAN was chosen - is not otherwise
 * recoverable from the row, and because its price can drift between the
 * attempt and the subscription.
 *
 * The annual flow needs neither. Everything that identifies this checkout
 * is already ON the attempt in a server-written column: the customer in
 * user_id, the product in items_snapshot, the money in
 * expected_total_gross_cents, the destination in shipping_country and the
 * shipping in shipping_gross_cents. Comparing those directly is stronger
 * than comparing a digest of them, because a digest can only say "these
 * differ" while these say which.
 *
 * It also means the annual flow writes NOTHING into
 * subscription_request_fingerprint or subscription_intent_fingerprint.
 * Those columns belong to migration 025's claim function, which compares
 * them against the subscription flow's own values; an annual attempt
 * leaves them NULL, which that function already refuses outright.
 *
 * ── WHAT IS DELIBERATELY NOT COMPARED ─────────────────────────
 *
 * The saved address id. A retry that names a different address of the
 * customer's OWN, before any plan exists, is not a different checkout:
 * both addresses are theirs, both must be German, and annual shipping is
 * decided by the product size rather than the address, so not one cent
 * moves. The moment the plan exists, 039 returns 'existing' and the
 * frozen address becomes authoritative and unchangeable - which is the
 * guarantee that actually matters, and the database owns it.
 */
export function verifyFrozenAnnualAttempt(input: {
  attempt: FrozenAnnualAttempt;
  userId: string;
  plan: AnnualLaunchPlan;
  pricing: AnnualPricing;
}): FrozenAttemptCheck {
  const { attempt, pricing } = input;

  // A different customer's attempt is never adopted, whatever else
  // matches. 039's RPC re-proves this under a row lock; refusing here
  // means it is refused before anything is attempted at all.
  if (attempt.user_id !== input.userId) {
    return { ok: false, reason: "attempt belongs to another customer" };
  }

  // This request id already belongs to a one-time cart, a subscription
  // cycle or an annual DELIVERY. None of those is an annual payment.
  if (attempt.subscription_id !== null
    || attempt.annual_plan_id !== null
    || attempt.annual_delivery_number !== null) {
    return { ok: false, reason: "attempt is not an annual payment attempt" };
  }

  if (attempt.currency !== "EUR") {
    return { ok: false, reason: "attempt is not priced in EUR" };
  }

  const frozenItems = attempt.items_snapshot;
  if (!Array.isArray(frozenItems) || frozenItems.length !== 1) {
    return { ok: false, reason: "attempt has no usable annual item snapshot" };
  }
  if (frozenItems[0].variantId !== input.plan.variantId) {
    return { ok: false, reason: "attempt was frozen for a different product" };
  }
  if (frozenItems[0].quantity !== pricing.deliveryCount) {
    return { ok: false, reason: "attempt was not frozen for a full annual prepayment" };
  }

  // THE MONEY. A retry that would produce a different total is a
  // different purchase, and the frozen one wins - it is what the customer
  // is already looking at, and it is what 039 will compare the plan
  // against.
  if (attempt.expected_total_gross_cents !== pricing.totalGrossCents) {
    return { ok: false, reason: "attempt was frozen for a different total" };
  }
  if (attempt.shipping_gross_cents !== pricing.shippingTotalGrossCents) {
    return { ok: false, reason: "attempt was frozen for a different shipping total" };
  }
  if (attempt.shipping_country !== ANNUAL_ALLOWED_COUNTRY) {
    return { ok: false, reason: "attempt was frozen for a different destination" };
  }
  if (!attempt.tax_snapshot) {
    return { ok: false, reason: "attempt has no frozen tax snapshot" };
  }

  return { ok: true };
}

/* ── The pending plan RPC's answer ──────────────────────────── */

/**
 * The only two results that mean "this attempt owns an annual plan".
 *
 * 'created' is a first call and 'existing' is a retry; both yield the
 * same authoritative row. Every other word 039 can return -
 * attempt_not_owned, attempt_not_pre_stripe, total_mismatch,
 * attempt_already_paid, attempt_not_a_payment_attempt, attempt_not_found,
 * invalid_input - is a refusal, and so is anything unrecognised.
 */
export const PENDING_ANNUAL_PLAN_SUCCESS_RESULTS: readonly string[] =
  Object.freeze(["created", "existing"]);

export type PendingAnnualPlanOutcome =
  | { ok: true; annualPlanId: string; created: boolean }
  | { ok: false; reason: string };

/**
 * Reads 039's jsonb answer, and FAILS CLOSED on anything it does not
 * recognise.
 *
 * An allowlist rather than a denylist: a future result word this code has
 * never seen must stop the checkout, not be treated as success because it
 * is not on a list of known failures.
 */
export function interpretPendingAnnualPlanResult(data: unknown): PendingAnnualPlanOutcome {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, reason: "pending annual plan returned no result" };
  }
  const payload = data as Record<string, unknown>;
  const result = typeof payload.result === "string" ? payload.result : "";

  if (!PENDING_ANNUAL_PLAN_SUCCESS_RESULTS.includes(result)) {
    return { ok: false, reason: result || "unknown" };
  }

  const annualPlanId = payload.annual_plan_id;
  if (typeof annualPlanId !== "string" || !UUID_RE.test(annualPlanId)) {
    return { ok: false, reason: "pending annual plan returned no id" };
  }

  return { ok: true, annualPlanId, created: result === "created" };
}

/* ── Stripe ─────────────────────────────────────────────────── */

/**
 * The Stripe idempotency key for one annual Checkout Session.
 *
 * Tied to the durable payment attempt, which is stable across every retry
 * of the same request_id, so a double click sends the same key and Stripe
 * replays ONE session instead of opening two. Deterministic: no clock, no
 * random value, no retry counter, and nothing personal - no email, no
 * name, no address, no user id.
 */
export function annualCheckoutIdempotencyKey(attemptId: string): string {
  return `gloa-annual-checkout-${attemptId}`;
}

/**
 * The line items for one prepaid annual purchase.
 *
 * ONE product line: thirteen boxes at the annual discounted unit price.
 * Inline price_data, exactly as the one-time flow does it - never a
 * Stripe Price object, and emphatically never a RECURRING one. There is
 * no second charge to schedule.
 *
 * Amounts come from the FROZEN pricing, so what Stripe collects is
 * arithmetically the attempt's expected total: unit x 13 plus the
 * shipping option below.
 */
export function buildAnnualCheckoutLineItems(input: {
  pricing: AnnualPricing;
  productName: string;
  variantLabel: string;
  currency: string;
}): Stripe.Checkout.SessionCreateParams.LineItem[] {
  return [{
    quantity: input.pricing.deliveryCount,
    price_data: {
      currency: input.currency.toLowerCase(),
      unit_amount: input.pricing.annualUnitGrossCents,
      product_data: {
        name: `${input.productName} · ${input.variantLabel} · Jahresabo`,
      },
    },
  }];
}

/**
 * The single shipping option, carrying the ANNUAL SHIPPING TOTAL.
 *
 * ── WHY THE TOTAL AND NOT THE PER-DELIVERY AMOUNT ─────────────
 *
 * The customer pays once, for all thirteen deliveries. A 30 g plan owes
 * 590 thirteen times, so Stripe must collect 7670 now; charging 590 would
 * leave twelve deliveries unpaid for.
 *
 * ── WHY A ZERO OPTION IS STILL EMITTED ────────────────────────
 *
 * Following the one-time flow, which always emits exactly one option and
 * labels a free one "Kostenloser Versand". Two reasons to keep that here:
 * the session then always states a shipping position, so free shipping
 * reads as a decision rather than as something that failed to load; and
 * the option's amount is what makes Stripe's amount_total equal the
 * attempt's frozen expected total on every size.
 *
 * The delivery estimate is the shop's own German one, passed in by the
 * caller from lib/shipping.ts rather than restated here. It describes
 * the FIRST delivery, which ships immediately.
 */
export function buildAnnualShippingOptions(input: {
  shippingTotalGrossCents: number;
  currency: string;
  minBusinessDays: number;
  maxBusinessDays: number;
}): Stripe.Checkout.SessionCreateParams.ShippingOption[] {
  return [{
    shipping_rate_data: {
      type: "fixed_amount",
      display_name: input.shippingTotalGrossCents === 0
        ? "Kostenloser Versand"
        : "Versand · 13 Lieferungen",
      fixed_amount: {
        amount: input.shippingTotalGrossCents,
        currency: input.currency.toLowerCase(),
      },
      delivery_estimate: {
        minimum: { unit: "business_day", value: input.minBusinessDays },
        maximum: { unit: "business_day", value: input.maxBusinessDays },
      },
    },
  }];
}

/**
 * Session metadata: CORRELATION ONLY.
 *
 * Four internal identifiers and nothing else. No amount, no discount, no
 * shipping figure, no delivery count, no address, no email, no name, no
 * token and no tax. Stripe metadata is world-readable to anyone with the
 * account, it is not a place to keep a customer's details, and every
 * number in it would be a second copy of a value the database already
 * holds authoritatively.
 *
 * gloa_annual_plan_id is a LOOKUP KEY. It names a row; it proves neither
 * ownership nor payment. The webhook phase will resolve the plan by it
 * and then verify the payment against the attempt, exactly as migration
 * 039's activation function requires.
 */
export function buildAnnualSessionMetadata(input: {
  requestId: string;
  checkoutAttemptId: string;
  annualPlanId: string;
}): Record<string, string> {
  return {
    checkout_version: ANNUAL_CHECKOUT_VERSION,
    request_id: input.requestId,
    checkout_attempt_id: input.checkoutAttemptId,
    gloa_annual_plan_id: input.annualPlanId,
  };
}
