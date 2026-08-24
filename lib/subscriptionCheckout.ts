import type Stripe from "stripe";
import {
  ALLOWED_REQUEST_FIELDS,
  LAUNCH_SUBSCRIPTION_SKUS,
  SUBSCRIPTION_FEATURE_FLAG,
  SUBSCRIPTION_QUANTITY,
  attemptMatchesRequest,
  buildSubscriptionAddressSnapshot,
  buildSubscriptionLineItems,
  isSubscriptionCheckoutEnabled,
  parseSubscriptionCheckoutBody,
  subscriptionCheckoutIdempotencyKey,
  validateLaunchPlan,
  type PlanResolution,
  type SavedAddressRow,
} from "./subscriptionCheckoutRules";
import { buildItemsSnapshot } from "./checkoutAttemptSnapshot";
import { buildPlanSnapshot } from "./subscriptions";
import {
  computeShippingGrossCents,
  getShippingZone,
  normalizeCountryCode,
  SHIPPING_ZONES,
  getCountryLabel,
  type ShippingZoneKey,
} from "./shipping";
import { resolveTaxJurisdiction } from "./taxJurisdiction";
import { resolveCheckoutTax, toTaxableCartItems, TAX_DESTINATION_UNAVAILABLE_MESSAGE } from "./tax";
// Type-only, deliberately. lib/verifyUser.ts and lib/checkoutQuote.ts both
// reach lib/supabase.ts, which evaluates import.meta.env at module scope
// and so only loads under the bundler. Their real implementations are
// injected from lib/subscriptionCheckoutDeps.ts instead.
import type { AuthenticatedCaller } from "./verifyUser";
import type { QuoteRequestItem, QuoteResult } from "./checkoutQuote";
import type {
  SubscriptionAttemptInput,
  SubscriptionAttemptResult,
  SubscriptionCheckoutAttempt,
} from "./checkoutAttempts";
import type {
  CreatePendingSubscriptionInput,
  CreatePendingSubscriptionResult,
} from "./subscriptions";
import type { StripeCustomerResult } from "./stripeCustomers";
import type { RecurringPriceResult } from "./stripeRecurringPrice";

/**
 * B2C subscription Checkout foundation (Task 29D-D).
 *
 * Creates everything a four-weekly subscription needs up to and including
 * the Stripe Checkout Session, and stops there. It does not activate a
 * subscription, does not create an order and does not send an email:
 * invoice.paid is the canonical paid event and it belongs to Task 29D-E.
 *
 * The browser supplies three things and none of them is commercial: which
 * plan, which of the customer's own saved addresses, and an idempotency
 * token. Price, shipping, tax, quantity, identity and the Stripe Customer
 * are all resolved here.
 *
 * Order of operations matters and is deliberate:
 *
 *   1. the feature gate, before anything at all
 *   2. request validation and authentication
 *   3. every server-side resolution, all of it read-only
 *   4. the checkout attempt, the idempotency anchor and the first write
 *   5. the local pending subscription, BEFORE Stripe
 *   6. Stripe Customer and recurring Prices
 *   7. the Checkout Session, carrying the local subscription id
 *
 * Step 5 before step 7 is Model A from migration 022: the local row is
 * frozen before Stripe knows anything, so an invoice.paid delivered
 * BEFORE checkout.session.completed still has a subscription to resolve
 * against. Stripe promises no ordering between the two, and the newer
 * API's invoice carries no top-level subscription id to fall back on, so
 * the correlation goes into subscription_data.metadata instead.
 */

export {
  ALLOWED_REQUEST_FIELDS,
  LAUNCH_SUBSCRIPTION_SKUS,
  SUBSCRIPTION_FEATURE_FLAG,
  SUBSCRIPTION_QUANTITY,
  isSubscriptionCheckoutEnabled,
  parseSubscriptionCheckoutBody,
  subscriptionCheckoutIdempotencyKey,
  validateLaunchPlan,
};
export type { SavedAddressRow };

/** A stable, customer-visible name for a zone's recurring shipping line. */
export function shippingProductName(zone: ShippingZoneKey): string {
  const codes = SHIPPING_ZONES[zone].countryCodes;
  return `Versand · ${codes.length === 1 ? getCountryLabel(codes[0]) : zone}`;
}

/* ── Orchestration ──────────────────────────────────────────── */

export type SubscriptionCheckoutDeps = {
  isEnabled: () => boolean;
  verifyCaller: (request: Request) => Promise<AuthenticatedCaller | null>;
  resolvePlan: (planId: string) => Promise<PlanResolution>;
  buildQuote: (items: QuoteRequestItem[]) => Promise<QuoteResult>;
  loadAddress: (token: string, userId: string, addressId: string) => Promise<SavedAddressRow | null>;
  getStripe: () => Stripe | null;
  getOrigin: () => string | null;
  ensureStripeCustomer: (stripe: Stripe, userId: string) => Promise<StripeCustomerResult>;
  ensureRecurringPrice: (
    stripe: Stripe,
    input: { kind: "sku" | "shipping"; identifier: string; unitAmountCents: number; productName: string }
  ) => Promise<RecurringPriceResult>;
  ensureAttempt: (input: SubscriptionAttemptInput) => Promise<SubscriptionAttemptResult>;
  createSubscription: (input: CreatePendingSubscriptionInput) => Promise<CreatePendingSubscriptionResult>;
  attachSubscription: (attemptId: string, subscriptionId: string) => Promise<string | null>;
  linkSession: (attemptId: string, sessionId: string) => Promise<boolean>;
};

type ErrorResponse = { error: string };

function fail(status: number, error: string): Response {
  return Response.json({ error } as ErrorResponse, { status });
}

const UNAVAILABLE = "Abo-Checkout ist derzeit nicht verfügbar.";
const PLAN_UNAVAILABLE = "Dieses Abo ist derzeit nicht verfügbar.";

/**
 * The whole flow, with every side effect injected. That is what lets the
 * ordering, idempotency and metadata guarantees below be driven end to
 * end in a test without a network call, a Stripe object or a database
 * write.
 */
export async function handleSubscriptionCheckout(
  request: Request,
  deps: SubscriptionCheckoutDeps
): Promise<Response> {
  // 1. THE GATE, FIRST. Nothing has been read, nothing has been written,
  //    and no external service has been contacted at this point.
  if (!deps.isEnabled()) {
    return fail(503, UNAVAILABLE);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "Ungültige Anfrage.");
  }

  const parsed = parseSubscriptionCheckoutBody(body);
  if (!parsed.ok) return fail(400, parsed.error);
  const { planId, addressId, requestId } = parsed.request;

  // 2. AUTHENTICATION. A subscription belongs to a person, so unlike the
  //    one-time flow there is no guest path. The user id comes from the
  //    verified token and from nowhere else.
  const caller = await deps.verifyCaller(request);
  if (!caller) {
    return fail(401, "Bitte melde dich an, um ein Abo zu starten.");
  }

  // 3. THE PLAN, read and checked server-side.
  const planResult = await deps.resolvePlan(planId);
  if (!planResult.ok) {
    console.error(`Subscription checkout: plan ${planId} rejected -`, planResult.reason);
    return fail(409, PLAN_UNAVAILABLE);
  }
  const plan = planResult.plan;

  // 4. THE PRODUCT, resolved from the PLAN's variant rather than from
  //    anything the browser said, and priced by the same authoritative
  //    quote builder the one-time checkout uses - so the catalog stays
  //    the single commercial truth for both flows.
  const quoteResult = await deps.buildQuote([
    { variantId: plan.variant_id as string, quantity: SUBSCRIPTION_QUANTITY },
  ]);
  if (!quoteResult.ok) {
    console.error(`Subscription checkout: variant for plan ${plan.slug} unavailable -`, quoteResult.error);
    return fail(409, PLAN_UNAVAILABLE);
  }
  const quote = quoteResult.quote;
  const item = quote.items[0];

  if (!item || quote.items.length !== 1) {
    return fail(409, PLAN_UNAVAILABLE);
  }
  if (!LAUNCH_SUBSCRIPTION_SKUS.includes(item.sku)) {
    console.error(`Subscription checkout: sku ${item.sku} is not a launch subscription product`);
    return fail(409, "Dieses Produkt ist nicht als Abo verfügbar.");
  }
  if (quote.currency !== "EUR") {
    console.error(`Subscription checkout: currency ${quote.currency} is not supported`);
    return fail(409, PLAN_UNAVAILABLE);
  }

  // 5. THE ADDRESS. Only the id came from the browser; recipient, street,
  //    postcode, city and country are re-read from the customer's own row
  //    and normalised through the existing utility, which also accepts
  //    the German country NAMES older rows still hold.
  const addressRow = await deps.loadAddress(caller.token, caller.userId, addressId);
  const countryCode = normalizeCountryCode(addressRow?.country);
  const addressResult = buildSubscriptionAddressSnapshot(addressRow, countryCode);
  if (!addressResult.ok) {
    // One neutral answer for "does not exist", "belongs to someone else"
    // and "is incomplete", so the response cannot be used to probe for
    // another customer's address ids.
    console.error("Subscription checkout: address rejected -", addressResult.reason);
    return fail(404, "Adresse nicht gefunden oder unvollständig.");
  }
  const { snapshot: addressSnapshot, recipientName } = addressResult;
  const destinationCountry = countryCode as string;

  // 6. SHIPPING, from the existing rules and the server-side merchandise
  //    subtotal. No subscription-specific zone logic and no subscription
  //    shipping discount exists or is invented here.
  const shippingZone = getShippingZone(destinationCountry);
  if (!shippingZone) {
    return fail(409, "In dieses Land liefern wir derzeit nicht.");
  }
  const shippingGrossCents = computeShippingGrossCents(shippingZone, quote.subtotalGrossCents);

  // 7. TAX, from the existing calculation. A subscription is STRICTER
  //    than a one-time order here: create_pending_subscription refuses a
  //    subscription without a tax snapshot, because the shop cannot bill
  //    something every four weeks that it cannot tax. So a destination
  //    where VAT is merely "not implemented" - which the one-time
  //    checkout lets through with tax genuinely unknown - cannot become a
  //    subscription at all.
  const taxOutcome = resolveCheckoutTax({
    jurisdictionResult: resolveTaxJurisdiction(destinationCountry),
    items: toTaxableCartItems(quote),
    shippingGrossCents,
  });
  if (taxOutcome.kind !== "calculated") {
    console.error(`Subscription checkout: tax unavailable for ${destinationCountry} -`, taxOutcome.reason);
    return fail(409, TAX_DESTINATION_UNAVAILABLE_MESSAGE);
  }
  const taxSnapshot = taxOutcome.snapshot;
  const expectedTotalGrossCents = quote.subtotalGrossCents + shippingGrossCents;

  // 8. THE ATTEMPT: the idempotency anchor, and the first write. It has
  //    to exist before the subscription so a retry finds the anchor
  //    rather than creating a second subscription.
  const items = buildItemsSnapshot(quote);
  const attemptResult = await deps.ensureAttempt({
    requestId,
    userId: caller.userId,
    currency: quote.currency,
    items,
    shipping: { country: destinationCountry, zone: shippingZone, grossCents: shippingGrossCents },
    taxSnapshot,
    expectedTotalGrossCents,
  });
  if (!attemptResult.ok) {
    return fail(503, attemptResult.error);
  }
  const attempt: SubscriptionCheckoutAttempt = attemptResult.attempt;

  if (attempt.status === "paid") {
    return fail(409, "Diese Anfrage wurde bereits bezahlt.");
  }

  // A request id reused with a different customer, product or total is
  // not a retry. Refuse, rather than attach this request to the frozen
  // snapshot somebody else's attempt already holds.
  if (!attemptMatchesRequest(attempt, {
    userId: caller.userId,
    variantId: item.variantId,
    totalGrossCents: expectedTotalGrossCents,
    country: destinationCountry,
  })) {
    console.error(`Subscription checkout: request ${requestId} reused with a different commercial snapshot`);
    return fail(409, "Diese Anfrage-ID gehört zu einem anderen Vorgang.");
  }

  // 9. THE LOCAL SUBSCRIPTION, before Stripe. Reused if this attempt
  //    already has one, so a retry never creates a second.
  let subscriptionId = attempt.subscription_id;
  if (!subscriptionId) {
    const created = await deps.createSubscription({
      userId: caller.userId,
      planId: plan.id,
      planSnapshot: buildPlanSnapshot(plan, item.sku),
      customerSnapshot: { email: caller.email, name: recipientName },
      shippingAddressSnapshot: addressSnapshot,
      // One saved address at launch: the customer selects a delivery
      // address and it is also what is invoiced. A separate billing
      // address is a later feature, not an invented second snapshot.
      billingAddressSnapshot: addressSnapshot,
      taxSnapshot,
      items,
    });
    if (!created.ok) {
      return fail(503, UNAVAILABLE);
    }

    // Adopt whatever is actually linked: a concurrent request may have
    // won, in which case this request uses the winner's subscription and
    // its own is left as an unreferenced pending row for reconciliation
    // rather than deleted here.
    const linked = await deps.attachSubscription(attempt.id, created.subscriptionId);
    if (!linked) {
      console.error(`Subscription checkout: attempt ${attempt.id} could not be linked to a subscription`);
      return fail(503, UNAVAILABLE);
    }
    subscriptionId = linked;
  }

  // 10. STRIPE. Nothing below can change what was frozen above.
  const stripe = deps.getStripe();
  if (!stripe) {
    console.error("Subscription checkout error: STRIPE_SECRET_KEY is not configured.");
    return fail(503, UNAVAILABLE);
  }
  const origin = deps.getOrigin();
  if (!origin) {
    console.error("Subscription checkout error: SITE_URL is not configured.");
    return fail(503, UNAVAILABLE);
  }

  const customerResult = await deps.ensureStripeCustomer(stripe, caller.userId);
  if (!customerResult.ok) {
    console.error("Subscription checkout: stripe customer -", customerResult.reason);
    return fail(503, UNAVAILABLE);
  }

  const productPrice = await deps.ensureRecurringPrice(stripe, {
    kind: "sku",
    identifier: item.sku,
    unitAmountCents: item.unitGrossCents,
    productName: `${item.productName} · ${item.label}`,
  });
  if (!productPrice.ok) {
    console.error("Subscription checkout: product price -", productPrice.reason);
    return fail(503, UNAVAILABLE);
  }

  let shippingPriceId: string | null = null;
  if (shippingGrossCents > 0) {
    // The zone KEY, which is this repository's canonical shipping
    // identifier, never a label and never free text: a renamed
    // customer-facing label must not mint a second Stripe Price for the
    // same zone.
    const shippingPrice = await deps.ensureRecurringPrice(stripe, {
      kind: "shipping",
      identifier: shippingZone,
      unitAmountCents: shippingGrossCents,
      productName: shippingProductName(shippingZone),
    });
    if (!shippingPrice.ok) {
      console.error("Subscription checkout: shipping price -", shippingPrice.reason);
      return fail(503, UNAVAILABLE);
    }
    shippingPriceId = shippingPrice.priceId;
  }

  try {
    const session = await stripe.checkout.sessions.create(
      {
        mode: "subscription",
        customer: customerResult.stripeCustomerId,
        line_items: buildSubscriptionLineItems({ productPriceId: productPrice.priceId, shippingPriceId }),
        subscription_data: {
          metadata: {
            // MANDATORY. This is what lets invoice.paid find the local
            // subscription even when it is delivered BEFORE
            // checkout.session.completed. Correlation only: it names a
            // row, it does not prove ownership, and the row itself holds
            // the authoritative user.
            gloa_subscription_id: subscriptionId,
            gloa_checkout_attempt_id: attempt.id,
          },
        },
        // The same correlation on the session, for the
        // checkout.session.completed path in Task 29D-E.
        metadata: {
          checkout_version: "1",
          request_id: requestId,
          checkout_attempt_id: attempt.id,
          gloa_subscription_id: subscriptionId,
        },
        // Back to the account area, where every state shown comes from
        // the database. A return from Stripe is not payment proof and
        // this URL grants nothing: "processing" is the honest word until
        // a webhook says otherwise.
        success_url: `${origin}/account/subscriptions?subscription=processing`,
        cancel_url: `${origin}/account/subscriptions?subscription=cancelled`,
      },
      { idempotencyKey: subscriptionCheckoutIdempotencyKey(attempt.id) }
    );

    if (!session.url) {
      console.error("Subscription checkout error: Stripe returned no session URL.");
      return fail(502, UNAVAILABLE);
    }

    // Best effort, exactly as the one-time flow: the customer must still
    // be able to pay if this fails. The local subscription already
    // carries the correlation Stripe sends back in metadata, so a missing
    // session link cannot strand the payment.
    await deps.linkSession(attempt.id, session.id);

    // Still 'pending'. Nothing in this task activates a subscription.
    return Response.json({ sessionId: session.id, url: session.url }, { status: 200 });
  } catch (err) {
    console.error("Subscription checkout session error:", err instanceof Error ? err.message : err);
    return fail(500, UNAVAILABLE);
  }
}
