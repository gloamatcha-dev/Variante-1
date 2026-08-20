import type Stripe from "stripe";
import { getStripeClient } from "../../../../lib/stripe";
import { validateQuoteItems, buildAuthoritativeQuote } from "../../../../lib/checkoutQuote";
import { getSiteOrigin } from "../../../../lib/siteUrl";
import { getOrCreateCheckoutAttempt, linkStripeSession } from "../../../../lib/checkoutAttempts";
import { verifyUserId } from "../../../../lib/verifyUser";

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

  const { items, requestId } = body as { items?: unknown; requestId?: unknown };

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

  // Never trust a client-supplied user id - re-verify the bearer token
  // (if any) against Supabase Auth. Guest checkout (no/invalid token)
  // simply links no user, it never fails the request.
  const userId = await verifyUserId(request);

  // Persists (or reuses, on retry) the authoritative server-side snapshot
  // for this request_id BEFORE calling Stripe, so a retry after a failed
  // Stripe call reuses the same locked-in prices instead of a possibly
  // changed fresh quote.
  const attemptResult = await getOrCreateCheckoutAttempt(requestId, quote, userId);
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
      size_grams: String(item.sizeGrams),
    },
  }));

  try {
    const session = await stripe.checkout.sessions.create(
      {
        mode: "payment",
        line_items: lineItems,
        // Launch ships to Germany only. Adding a country here is a
        // business decision, not a technical one - see task notes before
        // extending this list.
        shipping_address_collection: { allowed_countries: ["DE"] },
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
