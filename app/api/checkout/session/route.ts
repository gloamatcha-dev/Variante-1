import type Stripe from "stripe";
import { getStripeClient } from "../../../../lib/stripe";
import { validateQuoteItems, buildAuthoritativeQuote } from "../../../../lib/checkoutQuote";
import { getSiteOrigin } from "../../../../lib/siteUrl";
import { PRODUCT } from "../../../content";

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

  const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = quote.items.map(item => ({
    quantity: item.quantity,
    price_data: {
      currency: quote.currency.toLowerCase(),
      unit_amount: item.unitGrossCents,
      product_data: {
        name: `${PRODUCT.name} · ${item.label}`,
      },
    },
  }));

  try {
    const session = await stripe.checkout.sessions.create(
      {
        mode: "payment",
        line_items: lineItems,
        success_url: `${origin}/shop?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${origin}/shop?checkout=cancelled`,
        metadata: {
          checkout_version: "1",
          request_id: requestId,
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
