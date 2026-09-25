import type Stripe from "stripe";
import type { AuthenticatedCaller } from "./verifyUser";
import type { StripeCustomerResult } from "./stripeCustomers";
import type { B2bRecurringPriceResult } from "./b2bRecurringPrice";
import {
  B2B_TAX_RATE_PERCENT,
  b2bFirstCharge,
  buildB2bSessionMetadata,
  isB2bSelfServiceShippable,
  validateB2bCheckoutRequest,
  type B2bAuthoritativeQuote,
  type B2bFirstCharge,
} from "./b2bCheckoutRules.ts";

/**
 * The B2B self-service supply checkout (Package 5B).
 *
 * Kept apart from its wiring exactly as lib/annualPlanCheckout.ts is,
 * and for the same reason: the modules that reach lib/supabase.ts read
 * import.meta.env at module scope and so only load under the bundler.
 * Isolating them means this whole flow can be driven with stubs, which is
 * how the ordering, the gating, the frozen amount and the metadata are
 * proven without touching Stripe or a database.
 *
 * ── THE ORDER IS THE CONTRACT ─────────────────────────────────
 *
 *   1. feature flag              before anything at all
 *   2. authenticated caller
 *   3. business account
 *   4. request validation        lib/b2bCheckoutRules.ts
 *   5. Germany + postcode        the same validator, canonical resolver
 *   6. Berlin eligibility        carried, not discarded
 *   7. TEMPORARY 5B gate         non-Berlin refused until 5E
 *   8. authoritative pricing     Package 1 only
 *   9. net-origin tax            lib/tax.ts only
 *  10. the FIRST charge          what Stripe takes today
 *  11. checkout attempt          freezes that number
 *  12. pending agreement         migration 061's RPC
 *  13. Stripe customer
 *  14. Stripe Checkout Session
 *  15. link the session to the attempt
 *
 * Steps 1 to 10 touch nothing outside this process. The first database
 * write is step 11 and the first Stripe call is step 13, so every refusal
 * above them costs nothing and leaves nothing behind.
 *
 * ── IT CREATES NO ENTITLEMENT ─────────────────────────────────
 *
 * Returning 200 means a Stripe Checkout Session exists and a PENDING
 * agreement is waiting for it. No agreement is activated, no payment
 * schedule is written, no delivery is created and no order exists - those
 * belong to the webhook (Package 5C) and to migration 062.
 */

export type B2bCheckoutRequestBody = {
  requestId?: unknown;
  planType?: unknown;
  packs?: unknown;
  instalmentCount?: unknown;
  addressId?: unknown;
};

/** One saved address, read as the customer through RLS. */
export type B2bAddressRow = {
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

export type B2bBusinessProfileRow = {
  company_name: string | null;
  legal_form: string | null;
  vat_id: string | null;
  tax_number: string | null;
};

export type B2bAttemptInput = {
  requestId: string;
  userId: string;
  planType: "monthly" | "annual";
  packs: number;
  instalmentCount: number | null;
  expectedTotalGrossCents: number;
  shippingCountry: string;
  shippingGrossCents: number;
  firstCharge: B2bFirstCharge;
};

export type B2bAttemptResult =
  | { ok: true; attempt: { id: string; currency: string; expected_total_gross_cents: number } }
  | { ok: false; error: string };

export type B2bAgreementClaimInput = {
  checkoutAttemptId: string;
  expectedUserId: string;
  planType: "monthly" | "annual";
  quantityPacks: number;
  instalmentCount: number | null;
  pricingSnapshot: Record<string, unknown>;
  businessSnapshot: Record<string, unknown>;
  customerSnapshot: Record<string, unknown>;
  shippingAddressSnapshot: Record<string, unknown>;
  billingAddressSnapshot: Record<string, unknown>;
};

export type B2bAgreementClaimResult =
  | { ok: true; agreementId: string; result: string }
  | { ok: false; result: string; reason: string };

export type B2bCheckoutDeps = {
  isEnabled: () => boolean;
  verifyCaller: (request: Request) => Promise<AuthenticatedCaller | null>;
  isBusinessAccount: (token: string, userId: string) => Promise<boolean>;
  loadOwnAddress: (token: string, userId: string, addressId: string) => Promise<B2bAddressRow | null>;
  loadBusinessProfile: (token: string, userId: string) => Promise<B2bBusinessProfileRow | null>;
  getStripe: () => Stripe | null;
  getOrigin: () => string | null;
  ensureStripeCustomer: (stripe: Stripe, userId: string) => Promise<StripeCustomerResult>;
  ensureAttempt: (input: B2bAttemptInput) => Promise<B2bAttemptResult>;
  claimAgreement: (input: B2bAgreementClaimInput) => Promise<B2bAgreementClaimResult>;
  ensureMonthlyPrice: (
    stripe: Stripe,
    input: { packs: number; unitAmountCents: number; productName: string; currency: string }
  ) => Promise<B2bRecurringPriceResult>;
  linkSession: (attemptId: string, sessionId: string) => Promise<boolean>;
};

type ErrorResponse = { error: string };

function fail(status: number, error: string): Response {
  return Response.json({ error } as ErrorResponse, { status });
}

const UNAVAILABLE = "B2B-Checkout ist derzeit nicht verfügbar.";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The customer-facing sentence for each refusal. Never a number. */
const REJECTION_MESSAGE: Record<string, string> = {
  plan_type_unsupported: "Dieses Liefermodell gibt es nicht.",
  quantity_not_self_service: "Bitte wähle 1 bis 10 Packungen. Für mehr melde dich über das Formular.",
  monthly_takes_no_instalments: "Ein monatlicher Vertrag hat keine Ratenzahlung.",
  instalment_count_unsupported: "Bitte wähle 1, 2 oder 4 Zahlungen.",
  delivery_address_missing: "Bitte wähle eine Lieferadresse.",
  country_not_supported: "Wir beliefern derzeit nur Adressen in Deutschland.",
  postcode_malformed: "Bitte prüfe die Postleitzahl der Lieferadresse.",
  pricing_unavailable: UNAVAILABLE,
};

/**
 * The temporary non-Berlin refusal (Package 5B, removed by 5E).
 *
 * Honest about what it is: GLOA does supply all of Germany, but the
 * self-service till can only price a delivery it can actually cost, and
 * outside Berlin that measurement does not exist yet. Pointing at the
 * existing enquiry flow is the truthful alternative rather than a dead
 * end.
 */
const SHIPPING_NOT_YET_SUPPORTED =
  "Self-Service-Belieferung ist derzeit nur innerhalb Berlins buchbar. "
  + "Für alle anderen Adressen melde dich bitte über das B2B-Formular.";

export async function handleB2bCheckout(
  request: Request,
  deps: B2bCheckoutDeps
): Promise<Response> {
  // ── 1. THE FLAG, BEFORE ANYTHING ────────────────────────────
  //
  // Before the body is read, before the caller is verified, and long
  // before any database write or Stripe call. A closed flag must cost
  // exactly one boolean.
  if (!deps.isEnabled()) {
    return fail(404, "Nicht gefunden.");
  }

  // ── 2. THE CALLER ───────────────────────────────────────────
  const caller = await deps.verifyCaller(request);
  if (!caller) {
    return fail(401, "Bitte melde dich an.");
  }

  // ── 3. THE BUSINESS ACCOUNT ─────────────────────────────────
  //
  // A supply agreement is a contract between GLOA and a named business.
  // Migration 061's RPC asks public.profiles the same question again and
  // refuses independently, so this is the friendly answer rather than the
  // guarantee.
  const isBusiness = await deps.isBusinessAccount(caller.token, caller.userId);
  if (!isBusiness) {
    return fail(403, "Dieser Bereich ist Geschäftskonten vorbehalten.");
  }

  let body: B2bCheckoutRequestBody;
  try {
    body = (await request.json()) as B2bCheckoutRequestBody;
  } catch {
    return fail(400, "Ungültige Anfrage.");
  }

  const requestId = typeof body.requestId === "string" ? body.requestId.trim() : "";
  if (!UUID_RE.test(requestId)) {
    return fail(400, "Ungültige Anfrage.");
  }
  const addressId = typeof body.addressId === "string" ? body.addressId.trim() : "";
  if (!UUID_RE.test(addressId)) {
    return fail(400, "Bitte wähle eine Lieferadresse.");
  }

  // The address is read AS THE CUSTOMER, so RLS confines it to their own
  // rows - the route needs one person's address, not everybody's.
  const address = await deps.loadOwnAddress(caller.token, caller.userId, addressId);
  if (!address) {
    return fail(404, "Lieferadresse nicht gefunden.");
  }

  // ── 4, 5, 6. VALIDATION, GERMANY, BERLIN ────────────────────
  //
  // One call. The pack count, the plan, the instalment count, the
  // country and the postcode are all decided by the rules leaf, using
  // the canonical Berlin resolver - so this route derives no commercial
  // rule of its own and cannot disagree with the delivery rows later.
  const validation = validateB2bCheckoutRequest({
    planType: body.planType,
    packs: body.packs,
    instalmentCount: body.instalmentCount,
    deliveryAddress: { country: address.country, postcode: address.zip },
  });
  if (!validation.ok) {
    return fail(400, REJECTION_MESSAGE[validation.reason] ?? "Ungültige Anfrage.");
  }
  const quote: B2bAuthoritativeQuote = validation.quote;

  // ── 7. THE TEMPORARY 5B GATE ────────────────────────────────
  //
  // ONE CALL, and Package 5E deletes it. See the comment on
  // isB2bSelfServiceShippable: outside Berlin there is no measured
  // parcel and no approved customer shipping charge, so the till fails
  // closed rather than inventing either.
  if (!isB2bSelfServiceShippable(quote)) {
    return fail(409, SHIPPING_NOT_YET_SUPPORTED);
  }

  // ── 8, 9, 10. THE AMOUNT ────────────────────────────────────
  //
  // Derived, never received. The request body carries no price, no
  // total and no currency; b2bFirstCharge takes the canonical net from
  // Package 1 and the VAT from lib/tax.ts, and THIS number is what the
  // attempt freezes and what Stripe is asked for.
  const charge = b2bFirstCharge(quote);

  const stripe = deps.getStripe();
  const origin = deps.getOrigin();
  if (!stripe || !origin) {
    console.error("B2B checkout: server not configured.");
    return fail(503, UNAVAILABLE);
  }

  // ── 11. THE ATTEMPT ─────────────────────────────────────────
  const attemptResult = await deps.ensureAttempt({
    requestId,
    userId: caller.userId,
    planType: quote.planType,
    packs: quote.packs,
    instalmentCount: quote.instalmentCount,
    expectedTotalGrossCents: charge.grossCents,
    shippingCountry: quote.normalizedCountry,
    shippingGrossCents: charge.shippingGrossCents,
    firstCharge: charge,
  });
  if (!attemptResult.ok) {
    return fail(503, attemptResult.error);
  }
  const attempt = attemptResult.attempt;

  // A RETRY MUST NOT BE REPRICED. The attempt writer returns the
  // ORIGINAL frozen total for a repeated request_id, so if it disagrees
  // with what was just computed the customer is looking at a different
  // offer than the one they started - and the safe answer is to refuse
  // rather than to charge either number.
  if (attempt.expected_total_gross_cents !== charge.grossCents) {
    console.error(
      `B2B checkout: attempt ${attempt.id} froze ${attempt.expected_total_gross_cents} `
      + `but this request computed ${charge.grossCents}.`
    );
    return fail(409, "Dieser Checkout wurde bereits mit einem anderen Betrag gestartet.");
  }

  // ── 12. THE PENDING AGREEMENT, BEFORE STRIPE ────────────────
  //
  // Strictly ordered: attempt -> pending agreement -> Stripe session.
  // The agreement must exist before the session so its id can travel in
  // the session metadata as gloa_b2b_agreement_id, which is what lets
  // the webhook resolve the contract against trusted local data instead
  // of anything the payload claims.
  const business = await deps.loadBusinessProfile(caller.token, caller.userId);
  const claim = await deps.claimAgreement({
    checkoutAttemptId: attempt.id,
    expectedUserId: caller.userId,
    planType: quote.planType,
    quantityPacks: quote.packs,
    instalmentCount: quote.instalmentCount,
    pricingSnapshot: quote.pricingSnapshot,
    businessSnapshot: {
      companyName: business?.company_name ?? null,
      legalForm: business?.legal_form ?? null,
      vatId: business?.vat_id ?? null,
      taxNumber: business?.tax_number ?? null,
    },
    customerSnapshot: {
      // The verified account email, never anything the body claimed.
      email: caller.email,
      firstName: address.first_name,
      lastName: address.last_name,
    },
    shippingAddressSnapshot: {
      company: address.company,
      firstName: address.first_name,
      lastName: address.last_name,
      street: address.street,
      houseNumber: address.house_number,
      zip: quote.normalizedPostcode,
      city: address.city,
      country: quote.normalizedCountry,
    },
    billingAddressSnapshot: {
      company: address.company,
      firstName: address.first_name,
      lastName: address.last_name,
      street: address.street,
      houseNumber: address.house_number,
      zip: quote.normalizedPostcode,
      city: address.city,
      country: quote.normalizedCountry,
    },
  });

  if (!claim.ok) {
    console.error(`B2B checkout: agreement claim refused - ${claim.result}: ${claim.reason}`);
    // A conflicting replay is the customer's problem to see; every other
    // refusal is ours.
    if (claim.result === "conflicting_agreement") {
      return fail(409, "Dieser Checkout wurde bereits mit einer anderen Konfiguration gestartet.");
    }
    return fail(503, UNAVAILABLE);
  }
  const agreementId = claim.agreementId;

  // ── 13. THE STRIPE CUSTOMER ─────────────────────────────────
  const customer = await deps.ensureStripeCustomer(stripe, caller.userId);
  if (!customer.ok) {
    console.error(`B2B checkout: stripe customer - ${customer.reason}`);
    return fail(503, UNAVAILABLE);
  }

  // ── 14. THE SESSION ─────────────────────────────────────────
  const metadata = buildB2bSessionMetadata({
    requestId,
    checkoutAttemptId: attempt.id,
    agreementId,
  });
  const productName = `GLOA Matcha B2B – ${quote.packs} × 500 g`;

  let session: Stripe.Checkout.Session;
  try {
    if (quote.planType === "monthly") {
      const price = await deps.ensureMonthlyPrice(stripe, {
        packs: quote.packs,
        // THE GROSS. B2B pricing is net-origin, so the VAT is already
        // inside this number and Stripe is not asked to compute any.
        unitAmountCents: charge.grossCents,
        productName,
        currency: attempt.currency,
      });
      if (!price.ok) {
        console.error(`B2B checkout: monthly price - ${price.reason}`);
        return fail(503, UNAVAILABLE);
      }

      session = await stripe.checkout.sessions.create(
        {
          mode: "subscription",
          customer: customer.stripeCustomerId,
          line_items: [{ price: price.priceId, quantity: 1 }],
          subscription_data: {
            // MANDATORY. invoice.paid can be delivered BEFORE
            // checkout.session.completed, and at that moment the
            // agreement does not yet carry stripe_subscription_id - so
            // the subscription's own metadata is the ONLY way an invoice
            // can find the agreement. Correlation only: it names a row,
            // it does not prove ownership.
            metadata: { gloa_b2b_agreement_id: agreementId },
          },
          metadata,
          success_url: `${origin}/account/business?supply=processing`,
          cancel_url: `${origin}/account/business?supply=cancelled`,
        },
        { idempotencyKey: `gloa-b2b-session-${attempt.id}` }
      );
    } else {
      // ANNUAL: ONE PAYMENT TODAY, for instalment 1 only. Never mode
      // "subscription" - there is no recurring price and no Stripe
      // Subscription, and 059 forbids an annual agreement from carrying
      // a subscription id at all.
      const needsFuturePayments = (quote.instalmentCount ?? 1) > 1;

      session = await stripe.checkout.sessions.create(
        {
          mode: "payment",
          customer: customer.stripeCustomerId,
          line_items: [
            {
              quantity: 1,
              price_data: {
                currency: attempt.currency.toLowerCase(),
                unit_amount: charge.grossCents,
                product_data: {
                  name: `${productName} – Rate 1 von ${quote.instalmentCount}`,
                },
              },
            },
          ],
          payment_intent_data: {
            // THE SAME CORRELATION ON THE PAYMENTINTENT. Not a second
            // routing authority: the session metadata is what routes,
            // and this only lets a refund or a dispute be traced back to
            // the agreement without a join through Checkout.
            metadata: { gloa_b2b_agreement_id: agreementId },
            // ── SAVING THE PAYMENT METHOD, AND ONLY WHEN NEEDED ──
            //
            // Instalments 2..n are charged in Package 5D by Stripe
            // Invoices with collection_method "charge_automatically",
            // which can only succeed if the Customer already has a
            // default payment method Stripe may use OFF SESSION.
            // setup_future_usage "off_session" is the typed Checkout
            // field that attaches it and records the customer's mandate
            // at the moment they are present to give it.
            //
            // For a SINGLE instalment there is nothing to charge later,
            // so no mandate is taken: asking for one would be asking the
            // customer to authorise future payments that will never
            // happen.
            ...(needsFuturePayments ? { setup_future_usage: "off_session" as const } : {}),
          },
          metadata,
          success_url: `${origin}/account/business?supply=processing`,
          cancel_url: `${origin}/account/business?supply=cancelled`,
        },
        { idempotencyKey: `gloa-b2b-session-${attempt.id}` }
      );
    }
  } catch (err) {
    // NOTHING WAS ACTIVATED. The pending agreement survives as a
    // non-entitled row and the attempt stays retryable; a repeat of the
    // same request_id converges on both rather than minting a second
    // agreement, because the attempt is keyed on request_id and the
    // agreement on the attempt.
    console.error("B2B checkout: stripe session error -", err instanceof Error ? err.message : err);
    return fail(502, UNAVAILABLE);
  }

  if (!session.url) {
    console.error("B2B checkout: Stripe returned no session URL.");
    return fail(502, UNAVAILABLE);
  }

  // ── 15. LINK. Best effort, exactly as every other flow ──────
  //
  // The customer must still be able to pay if this fails: the session
  // already carries the agreement id in its metadata, so a missing link
  // cannot strand the payment - the webhook re-links it.
  await deps.linkSession(attempt.id, session.id);

  return Response.json(
    { sessionId: session.id, url: session.url, agreementId },
    { status: 200 }
  );
}

/** Re-exported so the route and the tests name one rate. */
export { B2B_TAX_RATE_PERCENT };
