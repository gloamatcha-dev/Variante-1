import type Stripe from "stripe";
import { getStripeClient } from "../../../../lib/stripe";
import { validateQuoteItems, buildAuthoritativeQuote } from "../../../../lib/checkoutQuote";
import { getSiteOrigin } from "../../../../lib/siteUrl";
import { getOrCreateCheckoutAttempt, linkStripeSession } from "../../../../lib/checkoutAttempts";
import { verifyUserId } from "../../../../lib/verifyUser";
import { ALLOWED_SHIPPING_COUNTRIES, getShippingZone, computeShippingGrossCents, SHIPPING_ZONES } from "../../../../lib/shipping";
import { resolveTaxJurisdiction } from "../../../../lib/taxJurisdiction";
import { resolveCheckoutTax, toTaxableCartItems, TAX_DESTINATION_UNAVAILABLE_MESSAGE } from "../../../../lib/tax";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ErrorResponse = {
  error: string;
};

type SessionResponse = {
  sessionId: string;
  url: string;
};

export async function POST(request: Request): Promise<Response> {
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

  const { items, requestId, shippingCountry } = body as { items?: unknown; requestId?: unknown; shippingCountry?: unknown };

  if (typeof requestId !== "string" || !UUID_RE.test(requestId)) {
    return Response.json(
      { error: "Ungültige Anfrage-ID." } as ErrorResponse,
      { status: 400 }
    );
  }

  const validatedItems = validateQuoteItems(items);
  if (!validatedItems) {
    return Response.json(
      { error: "Ungültige Artikel oder Mengen." } as ErrorResponse,
      { status: 400 }
    );
  }

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

  const { quote } = quoteResult;

  // Shipping price is computed server-side from the zone and the
  // authoritative merchandise subtotal above - never a client-supplied
  // amount, zone, or free-shipping flag.
  const shippingGrossCents = computeShippingGrossCents(shippingZone, quote.subtotalGrossCents);

  // Authoritative tax, derived only from the catalog quote, the
  // server-computed shipping charge and the validated destination. The
  // browser sends no rate, net amount, tax total or jurisdiction, and
  // none would be read if it did.
  const taxOutcome = resolveCheckoutTax({
    jurisdictionResult: resolveTaxJurisdiction(normalizedShippingCountry),
    items: toTaxableCartItems(quote),
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

  // Never trust a client-supplied user id - re-verify the bearer token
  // (if any) against Supabase Auth. Guest checkout (no/invalid token)
  // simply links no user, it never fails the request.
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
    userId
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

  const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = attempt.items_snapshot.map(item => ({
    quantity: item.quantity,
    price_data: {
      currency: item.currency.toLowerCase(),
      unit_amount: item.unitGrossCents,
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
  }));

  try {
    const session = await stripe.checkout.sessions.create(
      {
        mode: "payment",
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
