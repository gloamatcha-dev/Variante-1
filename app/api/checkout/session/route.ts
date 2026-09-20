import type Stripe from "stripe";
import { getStripeClient } from "../../../../lib/stripe";
import { validateQuoteItems, buildAuthoritativeQuote } from "../../../../lib/checkoutQuote";
import { getSiteOrigin } from "../../../../lib/siteUrl";
import {
  getOrCreateCheckoutAttempt,
  linkStripeSession,
  findAttemptByRequestId,
  type CheckoutAttemptDiscount,
} from "../../../../lib/checkoutAttempts";
import { normalizeDiscountCode } from "../../../../lib/launchDiscount";
import {
  priceLaunchDiscountForCart,
  splitFrozenDiscountAcrossCart,
  allocateDiscountedStripeLines,
  launchDiscountMessage,
  type DiscountableLine,
} from "../../../../lib/launchDiscountCart";
import { verifyUserId } from "../../../../lib/verifyUser";
import { validateCheckoutEmail, CHECKOUT_IDENTITY_CONFLICT_MESSAGE, CHECKOUT_TERMS_CONFLICT_MESSAGE } from "../../../../lib/checkoutIdentity";
import { getOrCreateCheckoutCustomerByEmail } from "../../../../lib/checkoutCustomerIdentity";
import { checkoutIdentityDeps } from "../../../../lib/checkoutCustomerIdentityDeps";
import { ALLOWED_SHIPPING_COUNTRIES, getShippingZone, computeShippingGrossCents, SHIPPING_ZONES } from "../../../../lib/shipping";
import { resolveTaxJurisdiction } from "../../../../lib/taxJurisdiction";
import { resolveCheckoutTax, toTaxableCartItems, TAX_DESTINATION_UNAVAILABLE_MESSAGE, type TaxableCartItem } from "../../../../lib/tax";
import { checkoutRefusalFor } from "../../../../lib/shopAvailability";
import { getSupabaseAdmin } from "../../../../lib/supabaseAdmin";
import type { RateLimitState } from "../../../../lib/launchRateLimit";
import {
  consumeLocalCheckoutRateLimit,
  consumeSharedCheckoutRateLimit,
  getCheckoutBucketSecret,
  CHECKOUT_SESSION_RATE_LIMIT,
  CHECKOUT_RATE_LIMITED_MESSAGE,
} from "../../../../lib/checkoutRateLimit";
import { SHOP_STATUS } from "../../../content";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ErrorResponse = {
  error: string;
};

type SessionResponse = {
  sessionId: string;
  url: string;
};

/**
 * THE ROUTE'S OWN IN-PROCESS COUNTER.
 *
 * Declared here rather than in lib/checkoutRateLimit.ts so the two
 * checkout endpoints cannot end up sharing one map - the same reason
 * POST /api/launch owns its own. Module scope, so it survives between
 * requests to the same warm instance and is lost when that instance is,
 * which is exactly what layer 2 exists to cover.
 */
const rateLimitState: RateLimitState = new Map();

/** The one answer a rate-limited caller ever gets. */
function rateLimitRefusal(decision: { status: number; retryAfterSeconds: number | null }): Response {
  return Response.json(
    { error: CHECKOUT_RATE_LIMITED_MESSAGE } as ErrorResponse,
    {
      status: decision.status,
      headers:
        decision.retryAfterSeconds === null
          ? undefined
          : { "Retry-After": String(Math.max(1, Math.ceil(decision.retryAfterSeconds))) },
    }
  );
}

export async function POST(request: Request): Promise<Response> {
  // LAYER 1, BEFORE THE BODY IS EVEN READ. See the quote endpoint: free,
  // counts every request valid or not, and worth an instance's lifetime.
  const localLimit = consumeLocalCheckoutRateLimit({
    policy: CHECKOUT_SESSION_RATE_LIMIT,
    state: rateLimitState,
    request,
    nowMs: Date.now(),
  });
  if (!localLimit.allow) return rateLimitRefusal(localLimit);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: "Ungültige Anfrage." } as ErrorResponse,
      { status: 400 }
    );
  }

  if (!body || typeof body !== "object") {
    return Response.json(
      { error: "Ungültige Anfrage." } as ErrorResponse,
      { status: 400 }
    );
  }

  // Exactly five inputs, and not one of them is an identity or an
  // amount. The browser may say which address it wants the order sent
  // to and which code it typed; it may never say which Stripe Customer,
  // which normalized form, which identity row that address resolves to,
  // or what the code is worth. Every one of those is derived below by
  // the server - the identity through lib/checkoutIdentity.ts, the
  // discount through lib/launchDiscountCart.ts.
  //
  // `discountCode` is a STRING and nothing else. There is deliberately
  // no discountCents, no percent, no eligibility flag and no line
  // allocation in this shape: a browser that could send any of those
  // could nominate its own price.
  const { items, requestId, shippingCountry, email, discountCode } = body as {
    items?: unknown;
    requestId?: unknown;
    shippingCountry?: unknown;
    email?: unknown;
    discountCode?: unknown;
  };

  if (typeof requestId !== "string" || !UUID_RE.test(requestId)) {
    return Response.json(
      { error: "Ungültige Anfrage-ID." } as ErrorResponse,
      { status: 400 }
    );
  }

  // The authoritative email, canonicalised once, here. Validation is
  // pure and writes nothing, so it belongs above the launch gate with
  // the rest of the request checks: a malformed request must still be
  // told it is malformed, whether or not the shop is open.
  const emailResult = validateCheckoutEmail(email);
  if (!emailResult.ok) {
    return Response.json(
      { error: emailResult.error } as ErrorResponse,
      { status: 400 }
    );
  }
  const customerEmail = emailResult.email;

  const validatedItems = validateQuoteItems(items);
  if (!validatedItems) {
    return Response.json(
      { error: "Ungültige Artikel oder Mengen." } as ErrorResponse,
      { status: 400 }
    );
  }

  // Shape only, here with the other 400s: a malformed request is told so
  // whether or not the shop is open. WHETHER the code applies is a
  // business decision and lives below the launch gate, with the writes.
  if (discountCode !== undefined && discountCode !== null && typeof discountCode !== "string") {
    return Response.json(
      { error: launchDiscountMessage("unknown_code") } as ErrorResponse,
      { status: 400 }
    );
  }
  const requestedDiscountCode = normalizeDiscountCode(discountCode);
  const wantsDiscount = requestedDiscountCode.length > 0;

  // The client may only tell us WHICH country it wants to ship to - never
  // the resulting zone, price, or free-shipping eligibility. Those are
  // always recomputed server-side from this validated code.
  if (typeof shippingCountry !== "string" || !ALLOWED_SHIPPING_COUNTRIES.includes(shippingCountry.toUpperCase())) {
    return Response.json(
      { error: "Ungültiges Lieferland." } as ErrorResponse,
      { status: 400 }
    );
  }
  const normalizedShippingCountry = shippingCountry.toUpperCase();
  const shippingZone = getShippingZone(normalizedShippingCountry);
  if (!shippingZone) {
    // Unreachable given the ALLOWED_SHIPPING_COUNTRIES check above, but
    // fail closed rather than assume.
    return Response.json(
      { error: "Ungültiges Lieferland." } as ErrorResponse,
      { status: 400 }
    );
  }

  // Authoritative server-side quote - client-supplied prices are never trusted.
  const quoteResult = await buildAuthoritativeQuote(validatedItems);
  if (!quoteResult.ok) {
    return Response.json(
      { error: quoteResult.error } as ErrorResponse,
      { status: quoteResult.status }
    );
  }

  const stripe = getStripeClient();
  if (!stripe) {
    console.error("Checkout session error: STRIPE_SECRET_KEY is not configured.");
    return Response.json(
      { error: "Zahlungsfunktion vorübergehend nicht verfügbar." } as ErrorResponse,
      { status: 503 }
    );
  }

  const origin = getSiteOrigin();
  if (!origin) {
    console.error("Checkout session error: SITE_URL is not configured.");
    return Response.json(
      { error: "Zahlungsfunktion vorübergehend nicht verfügbar." } as ErrorResponse,
      { status: 503 }
    );
  }

  // THE LAUNCH GATE - the last thing before the first side effect.
  //
  // Everything above this line is validation and pure reads: the request
  // shape, the destination, the authoritative catalog quote, and whether
  // Stripe and SITE_URL are configured at all. Everything below it
  // writes or charges - the user verification calls Supabase Auth, the
  // checkout attempt inserts a row, and the Stripe call at the end hands
  // the customer a payable page.
  //
  // So this sits exactly between them. While SHOP_STATUS is anything
  // other than "live" no checkout attempt is written and no Stripe
  // session is created, no matter how the request got here - a saved
  // cart from a live build, a replayed request, or a hand-written POST.
  // Hiding the buy buttons is presentation; this is the part that holds.
  //
  // Placed here rather than at the top of the handler on purpose: a
  // malformed request must still be told it is malformed (400), and a
  // shop whose payment provider is unconfigured must still say so (503).
  // A closed shop is not a reason to stop answering those accurately,
  // and the suite's proofs that client-supplied prices, user ids and
  // shipping fields are inert all depend on reaching the quote stage.
  const closed = checkoutRefusalFor(SHOP_STATUS);
  if (closed) {
    return Response.json(
      { error: closed.error } as ErrorResponse,
      { status: closed.status }
    );
  }

  // LAYER 2, THE SHARED COUNTER - DIRECTLY BELOW THE GATE, WITH THE
  // THINGS IT PROTECTS.
  //
  // What makes this endpoint worth limiting is what sits underneath it:
  // an identity resolution that can create a STRIPE CUSTOMER, a checkout
  // attempt, and a payable Checkout Session. Those are exactly the
  // things the gate withholds, so the limit belongs on the same side of
  // it - and a shop that is shut then answers "not open yet" cheaply,
  // accurately and without a database round trip for a request that
  // could not have bought anything anyway.
  //
  // The catalog read above this line is left to layer 1. That is a real
  // limitation and it is the right trade: metering one read by
  // performing one write is not a saving, the read needs a valid UUID, a
  // valid request id, a valid address and a supported country to reach
  // at all, and the endpoint a script would actually use to mine the
  // catalog or guess a code - /api/checkout/quote - carries the shared
  // counter ABOVE its own read for that very reason.
  //
  // A counter that cannot be reached REFUSES here - see
  // CHECKOUT_SESSION_RATE_LIMIT. On a serverless deployment layer 1
  // alone is not a weaker limit but an effectively absent one, and what
  // follows creates durable objects in Stripe.
  const sharedLimit = await consumeSharedCheckoutRateLimit({
    policy: CHECKOUT_SESSION_RATE_LIMIT,
    request,
    client: getSupabaseAdmin(),
    secret: getCheckoutBucketSecret(),
  });
  if (!sharedLimit.allow) {
    if (sharedLimit.status === 503) {
      console.error("Checkout session: shared rate limit unavailable - refusing:", sharedLimit.reason);
    }
    return rateLimitRefusal(sharedLimit);
  }

  const { quote } = quoteResult;

  // SHIPPING IS PRICED ON THE MERCHANDISE THE CUSTOMER CHOSE, BEFORE
  // ANY CODE. quote.subtotalGrossCents is the PRE-DISCOUNT value, and
  // this line is deliberately unchanged by the discount below: a basket
  // just over the free-shipping threshold must not LOSE free shipping
  // because a ten percent code was applied. A 50,00 EUR basket in
  // Germany still ships free after 5,00 EUR off.
  const shippingGrossCents = computeShippingGrossCents(shippingZone, quote.subtotalGrossCents);

  // ── THE DISCOUNT, DECIDED BY THE SERVER ─────────────────────
  //
  // Everything about it is computed here from the authoritative quote:
  // which lines are eligible, what ten percent of them is in whole
  // cents, and how that splits across the lines. The browser sent a
  // string.
  //
  // GLOALAUNCH10 is REUSABLE, so there is nothing to look up and no
  // one to ask: no claim, no reservation, no redemption ledger, no
  // "has this address used it". Migration 057 removed all of that, and
  // this route is the shape that leaves behind - a pure decision about
  // a code, a clock and a basket.
  const discountLines: DiscountableLine[] = quote.items.map(item => ({
    variantId: item.variantId,
    sku: item.sku,
    quantity: item.quantity,
    unitGrossCents: item.unitGrossCents,
    lineGrossCents: item.lineGrossCents,
  }));

  let discount: CheckoutAttemptDiscount | null = null;
  let discountedLineGrossCents: number[] = discountLines.map(line => line.lineGrossCents);

  if (wantsDiscount) {
    const priced = priceLaunchDiscountForCart({
      code: requestedDiscountCode,
      nowMs: Date.now(),
      lines: discountLines,
    });
    if (!priced.applies) {
      // A wrong, early or expired code is refused rather than silently
      // ignored: a customer who typed one must not be charged full
      // price while believing otherwise.
      return Response.json(
        { error: launchDiscountMessage(priced.reason) } as ErrorResponse,
        { status: 409 }
      );
    }
    discount = { code: priced.code, grossCents: priced.discountGrossCents };
    discountedLineGrossCents = priced.discountedLineGrossCents;
  }

  // Authoritative tax, derived only from the catalog quote, the
  // server-computed shipping charge and the validated destination. The
  // browser sends no rate, net amount, tax total or jurisdiction, and
  // none would be read if it did.
  //
  // THE LINES ARE THE DISCOUNTED ONES, because the tax snapshot has to
  // describe the transaction that is actually settled:
  // create_order_from_paid_checkout refuses a snapshot whose total
  // disagrees with the attempt's frozen total, and that total is now
  // net of the discount. The UNIT stays the catalogue's, so the order's
  // per-unit columns keep agreeing with items_snapshot - only the LINE
  // carries the reduction, and only the line feeds the totals.
  //
  // Shipping is passed unchanged: it is never discounted, and it is
  // taxed exactly as it was before this package.
  const taxOutcome = resolveCheckoutTax({
    jurisdictionResult: resolveTaxJurisdiction(normalizedShippingCountry),
    items: toTaxableCartItems(quote).map((item, index): TaxableCartItem => ({
      ...item,
      lineGrossCents: discountedLineGrossCents[index],
    })),
    shippingGrossCents,
  });

  if (taxOutcome.kind === "blocked") {
    // In scope but not correctly taxable right now (an unimplemented tax
    // mode or an unclassified product). Never create a paid order the
    // shop cannot tax correctly.
    console.error(`Checkout session: tax unavailable for ${normalizedShippingCountry} -`, taxOutcome.reason);
    return Response.json(
      { error: TAX_DESTINATION_UNAVAILABLE_MESSAGE } as ErrorResponse,
      { status: 409 }
    );
  }

  // Non-EU destinations keep behaving exactly as before Task 21D: tax
  // stays genuinely unknown rather than being invented as German VAT,
  // and the order is not blocked on that account.
  const attemptTaxSnapshot = taxOutcome.kind === "calculated" ? taxOutcome.snapshot : null;

  // ── THE IDENTITY, RESOLVED BEFORE STRIPE IS TOLD ANYTHING ───
  //
  // Everything from here down is below the launch gate, and that
  // placement is the point: a visitor POSTing to a prelaunch shop must
  // not be able to create a Stripe Customer or an identity mapping any
  // more than they can create a payable session. Nothing above this
  // line writes to Stripe or to the identity map.
  //
  // First, cheaply: if this request_id already has an attempt, its
  // identity is frozen and this request cannot change it. Refusing here
  // rather than after resolution means a retry that arrives with a
  // different address does not leave a stray Stripe Customer behind for
  // an address that will never be allowed to buy under this request id.
  // It is an optimisation, not the guarantee - the authoritative check
  // is against the attempt this request actually gets, further down.
  const existingAttempt = await findAttemptByRequestId(requestId);
  if (existingAttempt && existingAttempt.customer_email && existingAttempt.customer_email !== customerEmail) {
    console.error(
      `Checkout session: request ${requestId} was frozen for a different identity - refusing to repoint it.`
    );
    return Response.json(
      { error: CHECKOUT_IDENTITY_CONFLICT_MESSAGE } as ErrorResponse,
      { status: 409 }
    );
  }

  const identityDeps = checkoutIdentityDeps(stripe);
  if (!identityDeps) {
    console.error("Checkout session error: the identity resolver has no service-role client.");
    return Response.json(
      { error: "Zahlungsfunktion vorübergehend nicht verfügbar." } as ErrorResponse,
      { status: 503 }
    );
  }

  const identity = await getOrCreateCheckoutCustomerByEmail(identityDeps, customerEmail);
  if (!identity.ok) {
    // The address is never echoed. `conflict` separates "this identity
    // needs a human" (409, and no retry will help) from "Stripe or the
    // database was briefly unavailable" (503, and a retry might).
    console.error(`Checkout session: identity unresolved for request ${requestId} -`, identity.reason);
    return Response.json(
      {
        error: identity.conflict
          ? CHECKOUT_IDENTITY_CONFLICT_MESSAGE
          : "Zahlungsfunktion vorübergehend nicht verfügbar.",
      } as ErrorResponse,
      { status: identity.conflict ? 409 : 503 }
    );
  }
  const stripeCustomerId = identity.stripeCustomerId;

  // Never trust a client-supplied user id - re-verify the bearer token
  // (if any) against Supabase Auth. Guest checkout (no/invalid token)
  // simply links no user, it never fails the request.
  //
  // Deliberately NOT an identity source. The authoritative identity for
  // this checkout is the email above, for a signed-in customer exactly
  // as for a guest - so nothing here reads public.stripe_customers, and
  // a one-time order never borrows the subscription flow's Customer.
  const userId = await verifyUserId(request);

  // Persists (or reuses, on retry) the authoritative server-side snapshot
  // for this request_id BEFORE calling Stripe, so a retry after a failed
  // Stripe call reuses the same locked-in prices instead of a possibly
  // changed fresh quote. This also freezes the shipping country/zone/
  // price: a retry with a different shippingCountry can never change an
  // already-created attempt's shipping identity (same guarantee as
  // user_id - see getOrCreateCheckoutAttempt's ignoreDuplicates upsert).
  const attemptResult = await getOrCreateCheckoutAttempt(
    requestId,
    quote,
    { country: normalizedShippingCountry, zone: shippingZone, grossCents: shippingGrossCents },
    attemptTaxSnapshot,
    userId,
    { email: customerEmail, stripeCustomerId },
    discount
  );
  if (!attemptResult.ok) {
    return Response.json(
      { error: attemptResult.error } as ErrorResponse,
      { status: 503 }
    );
  }

  const { attempt } = attemptResult;

  if (attempt.status === "paid") {
    return Response.json(
      { error: "Diese Anfrage wurde bereits bezahlt." } as ErrorResponse,
      { status: 409 }
    );
  }

  // THE AUTHORITATIVE IDENTITY CHECK, against the attempt that actually
  // came back rather than the one this request hoped to create.
  //
  // The upsert above ignores duplicates, so on a retry these are the
  // ORIGINAL frozen values. If they disagree with what this request
  // resolved, the attempt belongs to a different person and settling it
  // against this one would mean charging an address the customer never
  // confirmed - and rewriting the attempt to agree is not an option
  // either, since a frozen identity that can be edited is not frozen.
  // Both directions are refused; the attempt stands untouched.
  //
  // The pre-read above catches the ordinary retry-with-a-new-address
  // case before any Stripe write. This catches the rest: a genuine race
  // between two first-time requests sharing one request_id, and any
  // attempt written without an identity at all.
  if (
    attempt.customer_email !== customerEmail ||
    attempt.stripe_customer_id === null ||
    attempt.stripe_customer_id !== stripeCustomerId
  ) {
    console.error(
      `Checkout session: attempt ${attempt.id} holds a different frozen identity (customer ${attempt.stripe_customer_id ?? "none"}, resolved ${stripeCustomerId}) - session withheld.`
    );
    return Response.json(
      { error: CHECKOUT_IDENTITY_CONFLICT_MESSAGE } as ErrorResponse,
      { status: 409 }
    );
  }
  // Read from the attempt, not from this request - the same rule the
  // frozen shipping data below follows, for the same reason.
  const frozenStripeCustomerId = attempt.stripe_customer_id;

  // THE SAME RULE, APPLIED TO THE COMMERCIAL TERMS.
  //
  // The upsert ignores duplicates, so on a retry these are the ORIGINAL
  // frozen values. A request that arrives with a code the attempt does
  // not carry, without the code it does, or with an amount that no
  // longer matches - because the basket changed, or the window closed
  // in between - is asking to settle a DIFFERENT checkout under an old
  // request id.
  //
  // Refused, in both directions, and the attempt stands untouched.
  // Rewriting it to agree is not an option either: a frozen price that
  // can be edited is not frozen, and the customer is looking at the
  // other one.
  if (
    attempt.discount_code !== (discount?.code ?? null) ||
    attempt.discount_gross_cents !== (discount?.grossCents ?? null)
  ) {
    console.error(
      `Checkout session: attempt ${attempt.id} holds a different frozen discount (frozen ${attempt.discount_code ?? "none"}/${attempt.discount_gross_cents ?? 0}, requested ${discount?.code ?? "none"}/${discount?.grossCents ?? 0}) - session withheld.`
    );
    return Response.json(
      { error: CHECKOUT_TERMS_CONFLICT_MESSAGE } as ErrorResponse,
      { status: 409 }
    );
  }
  const frozenDiscountGrossCents = attempt.discount_gross_cents ?? 0;

  // Always build the Stripe session from the attempt's frozen shipping
  // data, never from this request's freshly computed values - a retry
  // with a different shippingCountry must not change an already-created
  // attempt's priced shipping (see getOrCreateCheckoutAttempt above).
  if (!attempt.shipping_country || !attempt.shipping_zone || attempt.shipping_gross_cents === null) {
    console.error(`Checkout session error: attempt ${attempt.id} has no frozen shipping data.`);
    return Response.json(
      { error: "Zahlungsfunktion vorübergehend nicht verfügbar." } as ErrorResponse,
      { status: 503 }
    );
  }
  const frozenShippingCountry = attempt.shipping_country;
  const frozenShippingZone = SHIPPING_ZONES[attempt.shipping_zone];
  const frozenShippingGrossCents = attempt.shipping_gross_cents;

  // WHAT STRIPE IS CHARGED, PER LINE.
  //
  // Built from the ATTEMPT, never from this request's fresh quote - the
  // same rule the frozen shipping above follows - and from the FROZEN
  // discount amount, so the lines sum to exactly the frozen total
  // lib/stripeFulfillment.ts will hold the payment to.
  //
  // Undiscounted, this is byte-for-byte what it always was: one line
  // item per snapshot item at the catalogue unit price. Discounted, the
  // allocation runs per UNIT so unit_amount x quantity is exact - a line
  // whose units end up a cent apart becomes two Stripe line items,
  // which is the only way `unit_amount` can express an uneven split.
  //
  // NO STRIPE COUPON AND NO PROMOTION CODE. GLOALAUNCH10 is computed
  // here and folded into the amounts, because a promotion code entered
  // at the till would reduce amount_total below the frozen total and
  // the order would never be created.
  const frozenLines: DiscountableLine[] = attempt.items_snapshot.map(item => ({
    variantId: item.variantId,
    sku: item.sku,
    quantity: item.quantity,
    unitGrossCents: item.unitGrossCents,
    lineGrossCents: item.lineGrossCents,
  }));

  const stripeLines = frozenDiscountGrossCents > 0
    ? allocateDiscountedStripeLines(
        frozenLines,
        splitFrozenDiscountAcrossCart(frozenLines, frozenDiscountGrossCents)
      )
    : frozenLines.map((line, index) => ({
        sourceIndex: index,
        quantity: line.quantity,
        unitGrossCents: line.unitGrossCents,
        lineGrossCents: line.lineGrossCents,
      }));

  const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = stripeLines.map(line => {
    const item = attempt.items_snapshot[line.sourceIndex];
    return {
      quantity: line.quantity,
      price_data: {
        currency: item.currency.toLowerCase(),
        unit_amount: line.unitGrossCents,
        product_data: {
          name: `${item.productName} · ${item.variantLabel}`,
        },
      },
      metadata: {
        variant_id: item.variantId,
        sku: item.sku,
        // Only sent when the product actually has a net weight. An
        // accessory sold as a unit would otherwise carry size_grams:"null".
        ...(typeof item.sizeGrams === "number" ? { size_grams: String(item.sizeGrams) } : {}),
      },
    };
  });

  try {
    const session = await stripe.checkout.sessions.create(
      {
        mode: "payment",
        // THE LOCK. Not customer_email - that one only PREFILLS a field
        // the buyer can still change, which would make the identity this
        // attempt froze a suggestion rather than a fact. A `customer`
        // that already carries a valid email is prefilled AND NOT
        // EDITABLE in Checkout (migration 055's header quotes the SDK on
        // exactly this), and getOrCreateCheckoutCustomerByEmail
        // guarantees the email is on it before we get here.
        customer: frozenStripeCustomerId,
        line_items: lineItems,
        // Restricted to exactly the one country this attempt was priced
        // for - Stripe shipping rates have no per-country filtering, so
        // allowing every enabled country in one session would let a
        // customer pick an address in a different (cheaper) zone than
        // the shipping_options price below actually reflects.
        shipping_address_collection: { allowed_countries: [frozenShippingCountry] },
        shipping_options: [
          {
            shipping_rate_data: {
              type: "fixed_amount",
              display_name: frozenShippingGrossCents === 0 ? "Kostenloser Versand" : "Versand",
              fixed_amount: { amount: frozenShippingGrossCents, currency: "eur" },
              delivery_estimate: {
                minimum: { unit: "business_day", value: frozenShippingZone.minBusinessDays },
                maximum: { unit: "business_day", value: frozenShippingZone.maxBusinessDays },
              },
            },
          },
        ],
        success_url: `${origin}/order/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${origin}/shop?checkout=cancelled`,
        metadata: {
          checkout_version: "1",
          request_id: requestId,
          checkout_attempt_id: attempt.id,
          // The CODE, which is a public string anyone may type, and
          // only when one was actually applied. Never the amount, never
          // the address: Stripe metadata is not where this shop keeps
          // money or identities.
          ...(attempt.discount_code ? { discount_code: attempt.discount_code } : {}),
        },
      },
      { idempotencyKey: `gloa-checkout-${requestId}` }
    );

    if (!session.url) {
      console.error("Checkout session error: Stripe returned no session URL.");
      return Response.json(
        { error: "Zahlungsfunktion vorübergehend nicht verfügbar." } as ErrorResponse,
        { status: 502 }
      );
    }

    // Best-effort: the customer must still be able to pay even if this
    // link fails. The webhook falls back to matching by
    // metadata.request_id and self-heals this link when it runs.
    await linkStripeSession(attempt.id, session.id);

    return Response.json(
      { sessionId: session.id, url: session.url } as SessionResponse,
      { status: 200 }
    );
  } catch (err) {
    console.error("Checkout session error:", err instanceof Error ? err.message : err);
    return Response.json(
      { error: "Zahlungsfunktion vorübergehend nicht verfügbar." } as ErrorResponse,
      { status: 500 }
    );
  }
}
