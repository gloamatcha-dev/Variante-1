import type Stripe from "stripe";
import { buildAnnualPricing, type AnnualPricing } from "./annualPlanRules";
// The gate itself is INJECTED as deps.isEnabled rather than imported, so
// a test can drive both sides of it without touching process.env. The
// real implementation is isAnnualPlanCheckoutEnabled, wired in
// lib/annualPlanCheckoutDeps.ts.
import { resolveAnnualLaunchPlan, type AnnualLaunchPlan } from "./annualPlans";
import {
  ANNUAL_ALLOWED_COUNTRY,
  ANNUAL_SHIPPING_ZONE,
  annualAddressDigest,
  annualCheckoutIdempotencyKey,
  annualIntentFingerprint,
  annualRequestFingerprint,
  buildAnnualCheckoutLineItems,
  buildAnnualCustomerSnapshot,
  buildAnnualDeliveryItemsSnapshot,
  buildAnnualPaymentItemsSnapshot,
  buildAnnualSessionMetadata,
  buildAnnualShippingOptions,
  buildAnnualTaxableItems,
  buildDeliveryTaxableItems,
  annualPendingPlanFailureStatus,
  interpretPendingAnnualPlanResult,
  parseAnnualCheckoutBody,
  requireAnnualDestination,
  verifyFrozenAnnualAttempt,
  type FrozenAnnualAttempt,
} from "./annualPlanCheckoutRules";
import { buildSubscriptionAddressSnapshot, type SavedAddressRow } from "./subscriptionCheckoutRules";
import { SHIPPING_ZONES, normalizeCountryCode } from "./shipping";
import { resolveTaxJurisdiction } from "./taxJurisdiction";
import { TAX_DESTINATION_UNAVAILABLE_MESSAGE, resolveCheckoutTax } from "./tax";
// Type-only, deliberately. lib/verifyUser.ts and lib/checkoutQuote.ts both
// reach lib/supabase.ts, which evaluates import.meta.env at module scope
// and so only loads under the bundler. Their real implementations are
// injected from lib/annualPlanCheckoutDeps.ts instead - the same split
// lib/subscriptionCheckout.ts uses.
import type { AuthenticatedCaller } from "./verifyUser";
import type { QuoteRequestItem, QuoteResult } from "./checkoutQuote";
import type { AnnualAttemptInput, AnnualAttemptResult } from "./checkoutAttempts";
import type { CartTaxSnapshot } from "./tax";

/**
 * B2C PREPAID annual plan checkout (Phase 4B3).
 *
 * Creates everything a thirteen-delivery prepaid purchase needs up to and
 * including the Stripe Checkout Session, and stops there. It activates
 * nothing, creates no order, schedules no delivery and sends no email:
 * the payment webhook is a later phase, and returning from Stripe is not
 * payment.
 *
 * The browser supplies three things and none of them is commercial: which
 * product, which of the customer's own saved addresses, and an
 * idempotency token. Price, discount, shipping, tax, quantity, country
 * and identity are all resolved here.
 *
 * ── THE ORDER OF OPERATIONS IS THE CONTRACT ───────────────────
 *
 *    1. the feature gate, before anything at all
 *    2. request validation
 *    3. authentication - annual plans are account-bound, no guest path
 *    4. the canonical variant and its canonical catalog price
 *    5. annual launch eligibility, then the annual arithmetic
 *    6. the customer's own saved address, read as the customer
 *    7. Germany, or nothing
 *    8. two tax snapshots: the whole prepayment, and one delivery
 *    9. the PAYMENT checkout attempt - the first write, and the anchor
 *   10. the pending annual plan, claimed atomically from that attempt
 *   11. the Stripe Checkout Session, carrying the plan id as metadata
 *   12. the session linked back to the attempt
 *
 * Steps 9, 10 and 11 in that order are mandatory, and migration 039
 * enforces it rather than trusting this file: a new parent may only be
 * minted from an attempt that is still in the exact pre-Stripe state
 * ('created', no session, no intent, no invoice, no binding). The plan
 * therefore exists BEFORE Stripe does, which is what lets its id travel
 * as trusted correlation metadata and gives the future webhook a durable
 * local row to resolve against whatever order the events arrive in.
 *
 * ── WHAT A RETRY MUST DO ──────────────────────────────────────
 *
 * Converge. One request_id yields one attempt, one annual plan and one
 * Stripe session, through durable database state and a deterministic
 * Stripe idempotency key - never through anything held in memory. Every
 * value below is read back off the FROZEN attempt before it reaches
 * Stripe, so a catalog price that moved between the first request and the
 * retry cannot change what the customer is charged.
 */

export type AnnualCheckoutDeps = {
  isEnabled: () => boolean;
  verifyCaller: (request: Request) => Promise<AuthenticatedCaller | null>;
  buildQuote: (items: QuoteRequestItem[]) => Promise<QuoteResult>;
  loadAddress: (token: string, userId: string, addressId: string) => Promise<SavedAddressRow | null>;
  getStripe: () => Stripe | null;
  getOrigin: () => string | null;
  ensureAttempt: (input: AnnualAttemptInput) => Promise<AnnualAttemptResult>;
  /**
   * One atomic database operation: returns the attempt's existing annual
   * plan, or creates exactly one and links it, under a row lock. There is
   * deliberately no separate "attach" step for a second caller to race
   * against - migration 039 owns that decision.
   */
  createPendingPlan: (input: CreatePendingAnnualPlanInput) => Promise<unknown>;
  linkSession: (attemptId: string, sessionId: string) => Promise<boolean>;
};

/** The fifteen arguments migration 040's hardened RPC takes, and no more. */
export type CreatePendingAnnualPlanInput = {
  checkoutAttemptId: string;
  userId: string;
  variantId: string;
  catalogUnitGrossCents: number;
  annualUnitGrossCents: number;
  shippingPerDeliveryGrossCents: number;
  discountPercentApplied: number;
  customerSnapshot: unknown;
  shippingAddressSnapshot: unknown;
  billingAddressSnapshot: unknown;
  taxSnapshot: CartTaxSnapshot;
  deliveryItemsSnapshot: unknown;
  deliveryTaxSnapshot: CartTaxSnapshot;
  expectedIntentFingerprint: string;
  expectedRequestFingerprint: string;
};

type ErrorResponse = { error: string };

function fail(status: number, error: string): Response {
  return Response.json({ error } as ErrorResponse, { status });
}

const UNAVAILABLE = "Jahresabo-Checkout ist derzeit nicht verfügbar.";
const PRODUCT_UNAVAILABLE = "Dieses Produkt ist derzeit nicht als Jahresabo verfügbar.";
const GERMANY_ONLY = "Das Jahresabo ist derzeit nur innerhalb Deutschlands verfügbar.";

/**
 * The whole flow, with every side effect injected. That is what lets the
 * ordering, idempotency and metadata guarantees below be driven end to
 * end in a test without a network call, a Stripe object or a database
 * write.
 */
export async function handleAnnualPlanCheckout(
  request: Request,
  deps: AnnualCheckoutDeps
): Promise<Response> {
  // 1. THE GATE, FIRST. Nothing has been read, nothing has been written,
  //    and no external service has been contacted at this point.
  //    B2C_ANNUAL_PLAN_ENABLED is closed by default and the payment
  //    webhook does not exist yet, so an annual plan started today could
  //    be paid for and never activated.
  if (!deps.isEnabled()) {
    return fail(503, UNAVAILABLE);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "Ungültige Anfrage.");
  }

  const parsed = parseAnnualCheckoutBody(body);
  if (!parsed.ok) return fail(400, parsed.error);
  const { variantId, addressId, requestId } = parsed.request;

  // 3. AUTHENTICATION. A prepaid annual plan belongs to a person for
  //    twelve months, so unlike the one-time flow there is no guest path.
  //    The user id comes from the verified token and from nowhere else;
  //    the body cannot carry one, and parseAnnualCheckoutBody refuses a
  //    body that tries.
  const caller = await deps.verifyCaller(request);
  if (!caller) {
    return fail(401, "Bitte melde dich an, um ein Jahresabo zu starten.");
  }

  // 4. THE CANONICAL PRODUCT. The browser named a variant id; everything
  //    priced comes from the catalog. buildAuthoritativeQuote is the same
  //    single commercial truth the one-time and subscription flows use,
  //    and it refuses an inactive product or an inactive variant.
  const quoteResult = await deps.buildQuote([{ variantId, quantity: 1 }]);
  if (!quoteResult.ok) {
    console.error(`Annual checkout: variant ${variantId} unavailable -`, quoteResult.error);
    return fail(409, PRODUCT_UNAVAILABLE);
  }
  const quote = quoteResult.quote;
  const item = quote.items[0];
  if (!item || quote.items.length !== 1) {
    return fail(409, PRODUCT_UNAVAILABLE);
  }

  // 5. ANNUAL ELIGIBILITY, then the annual arithmetic. Both are Phase
  //    4B2's, and neither is reimplemented here: this file multiplies
  //    nothing and discounts nothing.
  const planResult = resolveAnnualLaunchPlan({
    variantId: item.variantId,
    sku: item.sku,
    sizeGrams: item.sizeGrams,
    unitGrossCents: item.unitGrossCents,
    currency: quote.currency,
  });
  if (!planResult.ok) {
    console.error(`Annual checkout: variant ${variantId} rejected -`, planResult.reason);
    return fail(409, PRODUCT_UNAVAILABLE);
  }
  const plan: AnnualLaunchPlan = planResult.plan;

  const pricingResult = buildAnnualPricing({
    size: plan.size,
    catalogUnitGrossCents: plan.catalogUnitGrossCents,
  });
  if (!pricingResult.ok) {
    console.error(`Annual checkout: pricing refused for ${plan.sku} -`, pricingResult.reason);
    return fail(409, PRODUCT_UNAVAILABLE);
  }
  const pricing: AnnualPricing = pricingResult.pricing;

  // 6. THE ADDRESS. Only the id came from the browser; recipient, street,
  //    postcode, city and country are re-read from the customer's OWN row
  //    through a session-scoped client, where RLS confines the query to
  //    auth.uid() = user_id, and with an explicit user_id filter as well.
  const addressRow = await deps.loadAddress(caller.token, caller.userId, addressId);
  const countryCode = normalizeCountryCode(addressRow?.country);
  const addressResult = buildSubscriptionAddressSnapshot(addressRow, countryCode);
  if (!addressResult.ok) {
    // ONE NEUTRAL ANSWER for "does not exist", "belongs to somebody else"
    // and "is incomplete", so the response cannot be used to probe for
    // another customer's address ids.
    console.error("Annual checkout: address rejected -", addressResult.reason);
    return fail(404, "Adresse nicht gefunden oder unvollständig.");
  }
  const { snapshot: addressSnapshot, recipientName } = addressResult;

  // 7. GERMANY, OR NOTHING. Checked against the FROZEN snapshot, so the
  //    country that is validated is the one that gets stored. There is no
  //    annual price for any other destination and none is invented.
  const destination = requireAnnualDestination(addressSnapshot);
  if (!destination.ok) {
    console.error("Annual checkout: destination rejected -", destination.reason);
    return fail(409, GERMANY_ONLY);
  }

  // 8. TWO TAX SNAPSHOTS, from the existing engine and its existing
  //    rates. One describes the whole prepayment, one describes a single
  //    delivery; migration 039 requires both and CHECKs each against the
  //    money it belongs to. Nothing here decides when VAT is recognised.
  const jurisdiction = resolveTaxJurisdiction(destination.country);

  const annualTax = resolveCheckoutTax({
    jurisdictionResult: jurisdiction,
    items: buildAnnualTaxableItems({ plan, pricing, productSlug: item.productSlug }),
    shippingGrossCents: pricing.shippingTotalGrossCents,
  });
  const deliveryTax = resolveCheckoutTax({
    jurisdictionResult: jurisdiction,
    items: buildDeliveryTaxableItems({ plan, pricing, productSlug: item.productSlug }),
    shippingGrossCents: pricing.shippingPerDeliveryGrossCents,
  });

  // STRICTER THAN THE ONE-TIME FLOW, and deliberately so: migration 039
  // refuses a plan without both snapshots, because a contract that ships
  // thirteen times cannot be sold in a place the shop cannot tax.
  if (annualTax.kind !== "calculated" || deliveryTax.kind !== "calculated") {
    const reason = annualTax.kind !== "calculated" ? annualTax.reason : "delivery tax unavailable";
    console.error(`Annual checkout: tax unavailable for ${destination.country} -`, reason);
    return fail(409, TAX_DESTINATION_UNAVAILABLE_MESSAGE);
  }

  const catalog = {
    productName: item.productName,
    variantLabel: item.label,
    sizeGrams: item.sizeGrams,
    currency: quote.currency,
  };

  // 8b. THE FINGERPRINT OF THIS EXACT INTENT (Phase 4B3.2).
  //
  // A request_id is an idempotency token, never commercial authority, so
  // "the same request" has to be a checkable claim. Two digests, because
  // the question changes the moment a contract exists:
  //
  //   identity  customer, product, selected address. Compared on EVERY
  //             retry, including one that finds an existing plan.
  //   terms     the identity plus the address CONTENTS and every frozen
  //             commercial fact. Compared only while no plan exists.
  //
  // The address is reduced to a digest first, so nothing readable about
  // a delivery ever reaches a database column or a log line. Phase 4B3.1
  // reproduced the gap this closes: six different address edits all left
  // the money, the country and the tax identical, so nothing noticed.
  const intent = {
    userId: caller.userId,
    variantId: plan.variantId,
    addressId,
    deliveryCount: pricing.deliveryCount,
    addressDigest: annualAddressDigest(addressSnapshot),
    sku: plan.sku,
    currency: quote.currency,
    shippingCountry: destination.country,
    catalogUnitGrossCents: pricing.catalogUnitGrossCents,
    discountPercentApplied: pricing.discountPercentApplied,
    annualUnitGrossCents: pricing.annualUnitGrossCents,
    shippingPerDeliveryGrossCents: pricing.shippingPerDeliveryGrossCents,
    shippingTotalGrossCents: pricing.shippingTotalGrossCents,
    totalGrossCents: pricing.totalGrossCents,
    taxCalculationVersion: annualTax.snapshot.calculationVersion,
    taxTreatment: annualTax.snapshot.treatment,
    taxTotalCents: annualTax.snapshot.totals.taxTotalCents,
  };
  const intentFingerprint = annualIntentFingerprint(intent);
  const requestFingerprint = annualRequestFingerprint(intent);

  // 9. THE PAYMENT ATTEMPT: the idempotency anchor, and the FIRST WRITE.
  //    It has to exist before the plan so a retry finds the anchor rather
  //    than creating a second plan. annual_plan_id and
  //    annual_delivery_number stay NULL on it: this is the payment, not
  //    one of the thirteen deliveries, and migration 039's paired CHECK
  //    keeps the two populations disjoint.
  const attemptResult = await deps.ensureAttempt({
    requestId,
    userId: caller.userId,
    currency: quote.currency,
    items: buildAnnualPaymentItemsSnapshot({ plan, pricing, catalog }),
    shipping: {
      country: destination.country,
      zone: ANNUAL_SHIPPING_ZONE,
      // THE ANNUAL SHIPPING TOTAL, not one delivery's. The customer pays
      // for all thirteen now.
      grossCents: pricing.shippingTotalGrossCents,
    },
    taxSnapshot: annualTax.snapshot,
    expectedTotalGrossCents: pricing.totalGrossCents,
    // Written once, with the attempt. ignoreDuplicates means a retry
    // never overwrites them: the FIRST durable intent wins, and it is
    // what migration 040 compares under the row lock.
    intentFingerprint,
    requestFingerprint,
  });
  if (!attemptResult.ok) {
    return fail(503, attemptResult.error);
  }
  const attempt: FrozenAnnualAttempt = attemptResult.attempt;

  if (attempt.status === "paid") {
    return fail(409, "Diese Anfrage wurde bereits bezahlt.");
  }

  // WHICH CHECKOUT THIS IS, proved against the attempt's own frozen
  // columns rather than against a digest. A different customer, a
  // different product or a different total is a different purchase, and
  // the frozen one wins.
  const frozen = verifyFrozenAnnualAttempt({
    attempt, userId: caller.userId, plan, pricing, intentFingerprint,
  });
  if (!frozen.ok) {
    console.error(`Annual checkout: request ${requestId} reused for a different checkout -`, frozen.reason);
    return fail(409, "Diese Anfrage-ID gehört zu einem anderen Vorgang.");
  }

  // 10. THE PENDING ANNUAL PLAN, BEFORE STRIPE, claimed atomically.
  //     ONE database call decides under a row lock whether this attempt
  //     already owns a plan and creates one only if it does not, so two
  //     concurrent requests cannot produce two plans and there is no
  //     loser left unreferenced.
  //
  //     The totals are NOT passed. Migration 039 computes merchandise,
  //     shipping and grand total itself from the per-delivery integers
  //     and then refuses the whole call unless the result equals the
  //     attempt's expected total - which is where "the browser cannot
  //     choose the price" stops being this file's promise and becomes the
  //     database's.
  const rpcResult = await deps.createPendingPlan({
    checkoutAttemptId: attempt.id,
    userId: caller.userId,
    variantId: plan.variantId,
    catalogUnitGrossCents: pricing.catalogUnitGrossCents,
    annualUnitGrossCents: pricing.annualUnitGrossCents,
    shippingPerDeliveryGrossCents: pricing.shippingPerDeliveryGrossCents,
    discountPercentApplied: pricing.discountPercentApplied,
    customerSnapshot: buildAnnualCustomerSnapshot({ email: caller.email, recipientName }),
    shippingAddressSnapshot: addressSnapshot,
    // ONE SAVED ADDRESS AT LAUNCH: the customer selects a delivery
    // address and it is also what is invoiced. Exactly what the
    // subscription checkout does, and for the same reason - a separate
    // billing address is a later feature, not an invented second
    // snapshot and not a new request field.
    billingAddressSnapshot: addressSnapshot,
    taxSnapshot: annualTax.snapshot,
    deliveryItemsSnapshot: buildAnnualDeliveryItemsSnapshot({ plan, pricing, catalog }),
    deliveryTaxSnapshot: deliveryTax.snapshot,
    // BOTH EXPECTED DIGESTS, compared against the STORED ones under the
    // attempt's row lock. The database decides which of the two still
    // has to match: the identity always, the terms only while no annual
    // plan exists. Doing that comparison here instead would either miss
    // the race or lock a customer out of a contract they already hold.
    expectedIntentFingerprint: intentFingerprint,
    expectedRequestFingerprint: requestFingerprint,
  });

  const pending = interpretPendingAnnualPlanResult(rpcResult);
  if (!pending.ok) {
    // FAIL CLOSED on every word that is not 'created' or 'existing',
    // including one this code has never seen. The attempt survives, so a
    // retry can reuse it.
    //
    // A fingerprint mismatch is a 409 rather than a 503: this request id
    // is not this checkout, and retrying will never change that - the
    // customer needs a fresh one. The reason is LOGGED, never returned;
    // no digest and no stored value reaches the response.
    const status = annualPendingPlanFailureStatus(pending.reason);
    console.error(`Annual checkout: pending plan refused for attempt ${attempt.id} -`, pending.reason);
    return status === 409
      ? fail(409, "Diese Anfrage-ID gehört zu einem anderen Vorgang.")
      : fail(503, UNAVAILABLE);
  }
  const annualPlanId = pending.annualPlanId;

  // 11. STRIPE. Nothing below can change what was frozen above.
  const stripe = deps.getStripe();
  if (!stripe) {
    console.error("Annual checkout error: STRIPE_SECRET_KEY is not configured.");
    return fail(503, UNAVAILABLE);
  }
  const origin = deps.getOrigin();
  if (!origin) {
    console.error("Annual checkout error: SITE_URL is not configured.");
    return fail(503, UNAVAILABLE);
  }

  // FROM THE FROZEN ATTEMPT, not from this request's fresh figures. A
  // catalog edit between the first request and a retry therefore cannot
  // change what Stripe collects; verifyFrozenAnnualAttempt already proved
  // the two agree, and reading the attempt makes that structural.
  const frozenShippingTotal = attempt.shipping_gross_cents ?? 0;
  const frozenItem = (attempt.items_snapshot ?? [])[0];
  if (!frozenItem) {
    console.error(`Annual checkout error: attempt ${attempt.id} has no frozen item snapshot.`);
    return fail(503, UNAVAILABLE);
  }
  const zone = SHIPPING_ZONES[ANNUAL_SHIPPING_ZONE];

  try {
    const session = await stripe.checkout.sessions.create(
      {
        // ONE PAYMENT. Never mode "subscription": there is no recurring
        // charge, no Stripe Subscription and no recurring Price. After
        // this PaymentIntent succeeds Stripe holds no further obligation,
        // which is what makes a card that dies in month seven irrelevant
        // to deliveries eight to thirteen.
        mode: "payment",
        line_items: buildAnnualCheckoutLineItems({
          pricing: {
            ...pricing,
            annualUnitGrossCents: frozenItem.unitGrossCents,
            deliveryCount: frozenItem.quantity,
          },
          productName: frozenItem.productName,
          variantLabel: frozenItem.variantLabel,
          currency: attempt.currency,
        }),
        // GERMANY ONLY, and restricted to the one country this plan was
        // priced for. Offering the shop's other destinations would let a
        // customer pay a German annual contract and then choose an
        // address the annual shipping rule never covered.
        shipping_address_collection: { allowed_countries: [ANNUAL_ALLOWED_COUNTRY] },
        shipping_options: buildAnnualShippingOptions({
          shippingTotalGrossCents: frozenShippingTotal,
          currency: attempt.currency,
          minBusinessDays: zone.minBusinessDays,
          maxBusinessDays: zone.maxBusinessDays,
        }),
        // Back to the account area. A return from Stripe is NOT payment
        // proof and this URL grants nothing: no plan is activated, no
        // delivery is scheduled and no order exists until the webhook
        // phase says so. Deliberately a minimal existing route - the
        // annual success experience is a later phase.
        success_url: `${origin}/account?annual=processing`,
        cancel_url: `${origin}/account?annual=cancelled`,
        metadata: buildAnnualSessionMetadata({
          requestId,
          checkoutAttemptId: attempt.id,
          annualPlanId,
        }),
      },
      // DETERMINISTIC, from the durable attempt. Two concurrent requests
      // and every later retry send the same key, so Stripe replays one
      // session instead of opening a second.
      { idempotencyKey: annualCheckoutIdempotencyKey(attempt.id) }
    );

    if (!session.url) {
      console.error("Annual checkout error: Stripe returned no session URL.");
      return fail(502, UNAVAILABLE);
    }

    const linked = await deps.linkSession(attempt.id, session.id);
    if (!linked) {
      // NOTHING IS DELETED. The attempt, the pending plan and the Stripe
      // session are all evidence and all survive. Answering with a
      // retryable failure is honest - the correlation this flow promises
      // is not fully durable yet - and a retry converges on the same
      // session through the same idempotency key.
      console.error(`Annual checkout: failed to link session to attempt ${attempt.id}.`);
      return fail(503, UNAVAILABLE);
    }

    // Still 'pending'. Nothing here activates a plan, creates an order,
    // schedules a delivery or sends an email.
    return Response.json({ sessionId: session.id, url: session.url }, { status: 200 });
  } catch (err) {
    console.error("Annual checkout session error:", err instanceof Error ? err.message : err);
    return fail(500, UNAVAILABLE);
  }
}
