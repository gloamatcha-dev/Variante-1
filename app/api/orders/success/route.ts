import { getStripeClient } from "../../../../lib/stripe";
import { findAttemptByStripeSessionId, findAttemptByRequestId } from "../../../../lib/checkoutAttempts";
import { getSupabaseAdmin } from "../../../../lib/supabaseAdmin";
import type { AddressSnapshot } from "../../../../lib/orderAddressSnapshot";

// Stripe Checkout Session ids, e.g. cs_test_a1b2c3... / cs_live_a1b2c3...
const SESSION_ID_RE = /^cs_[a-zA-Z0-9_]{10,}$/;

type SuccessResponse =
  | { status: "invalid" }
  | { status: "unpaid" }
  | { status: "processing" }
  | {
      status: "success";
      order: {
        id: string;
        orderNumber: string;
        placedAt: string;
        currency: string;
        subtotalGrossCents: number;
        shippingGrossCents: number | null;
        totalGrossCents: number;
        paymentStatus: string;
        shippingAddress: AddressSnapshot | null;
        items: {
          productName: string;
          variantLabel: string | null;
          quantity: number;
          unitGrossCents: number;
          lineGrossCents: number;
        }[];
      };
    };

/**
 * Translates a Stripe Checkout Session id into minimal, non-sensitive
 * order confirmation data for the /order/success page. Never treats the
 * redirect/session_id itself as proof of payment - always re-verifies the
 * session server-side with Stripe, and only ever returns an order that
 * the verified, atomic order-creation flow (Stripe webhook) already
 * created. Returns the shipping address (the success page needs to show
 * it), but deliberately no billing address or customer email/name/phone -
 * this endpoint is reachable by anyone holding the session_id, including
 * guests, and those fields aren't needed to confirm "this is my order".
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const sessionId = url.searchParams.get("session_id");

  if (!sessionId || !SESSION_ID_RE.test(sessionId)) {
    return Response.json({ status: "invalid" } satisfies SuccessResponse, { status: 400 });
  }

  const stripe = getStripeClient();
  if (!stripe) {
    console.error("Order success lookup error: STRIPE_SECRET_KEY is not configured.");
    return Response.json({ error: "Vorübergehend nicht verfügbar." }, { status: 503 });
  }

  let session;
  try {
    session = await stripe.checkout.sessions.retrieve(sessionId);
  } catch (err) {
    console.error("Order success lookup: Stripe session retrieve failed:", err instanceof Error ? err.message : err);
    return Response.json({ status: "invalid" } satisfies SuccessResponse, { status: 404 });
  }

  let attempt = await findAttemptByStripeSessionId(session.id);
  if (!attempt) {
    const requestId = session.metadata?.request_id;
    if (requestId) attempt = await findAttemptByRequestId(requestId);
  }

  if (!attempt) {
    return Response.json({ status: "invalid" } satisfies SuccessResponse, { status: 404 });
  }

  if (session.payment_status !== "paid") {
    return Response.json({ status: "unpaid" } satisfies SuccessResponse, { status: 200 });
  }

  const admin = getSupabaseAdmin();
  if (!admin) {
    console.error("Order success lookup error: SUPABASE_SECRET_KEY is not configured.");
    return Response.json({ error: "Vorübergehend nicht verfügbar." }, { status: 503 });
  }

  const { data: order, error: orderError } = await admin
    .from("orders")
    .select("id, order_number, currency, subtotal_gross_cents, shipping_gross_cents, total_gross_cents, payment_status, placed_at, created_at, shipping_address_snapshot")
    .eq("checkout_attempt_id", attempt.id)
    .maybeSingle();

  if (orderError) {
    console.error("Order success lookup: order query failed:", orderError.message);
    return Response.json({ error: "Interner Fehler." }, { status: 500 });
  }

  if (!order) {
    // Payment is verified paid but the webhook hasn't created the order
    // yet - a normal, brief race, not a failure.
    return Response.json({ status: "processing" } satisfies SuccessResponse, { status: 200 });
  }

  const { data: items, error: itemsError } = await admin
    .from("order_items")
    .select("product_name, variant_name, quantity, unit_price_gross_cents, line_total_gross_cents")
    .eq("order_id", order.id)
    .order("created_at");

  if (itemsError) {
    console.error("Order success lookup: order_items query failed:", itemsError.message);
    return Response.json({ error: "Interner Fehler." }, { status: 500 });
  }

  return Response.json(
    {
      status: "success",
      order: {
        id: order.id,
        orderNumber: order.order_number,
        placedAt: order.placed_at ?? order.created_at,
        currency: order.currency,
        subtotalGrossCents: order.subtotal_gross_cents,
        shippingGrossCents: order.shipping_gross_cents,
        totalGrossCents: order.total_gross_cents,
        paymentStatus: order.payment_status,
        shippingAddress: (order.shipping_address_snapshot as AddressSnapshot | null) ?? null,
        items: (items ?? []).map(item => ({
          productName: item.product_name,
          variantLabel: item.variant_name,
          quantity: item.quantity,
          unitGrossCents: item.unit_price_gross_cents,
          lineGrossCents: item.line_total_gross_cents,
        })),
      },
    } satisfies SuccessResponse,
    { status: 200 }
  );
}
