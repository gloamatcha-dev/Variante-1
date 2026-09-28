import { getSupabaseAdmin } from "../../../../lib/supabaseAdmin";
import type { RateLimitState } from "../../../../lib/launchRateLimit";
import {
  consumeLocalCheckoutRateLimit,
  consumeSharedCheckoutRateLimit,
  getCheckoutBucketSecret,
  CHECKOUT_RATE_LIMITED_MESSAGE,
} from "../../../../lib/checkoutRateLimit";
import {
  GUEST_ORDER_READ_RATE_LIMIT,
  GUEST_ORDER_SELECT_COLUMNS,
  GUEST_ORDER_ITEM_SELECT_COLUMNS,
  GUEST_ORDER_NOT_FOUND_MESSAGE,
  hashGuestOrderToken,
  isWellFormedGuestOrderToken,
  toGuestOrderView,
  type GuestOrderRow,
  type GuestOrderItemRow,
  type GuestOrderView,
} from "../../../../lib/guestOrderAccess";

/**
 * READ ONE ORDER, FOR THE HOLDER OF ITS MANAGEMENT LINK.
 *
 * The guest half of the order detail page. A one-time order can be
 * placed without an account; this is how the person who placed it looks
 * at it afterwards, and the only thing they present is the opaque token
 * their confirmation mail carried.
 *
 * ── WHY POST FOR A READ ───────────────────────────────────────
 *
 * Because the token is in the body, and a body is not a URL. A GET would
 * put a live credential in the request line, where it lands in the
 * platform's access log, in any intermediate proxy's log, and in the
 * Referer of anything the response loads. app/api/admin/orders/route.ts
 * already reads with POST for the same reason - a POST that writes
 * nothing is not a write.
 *
 * The token is unavoidably in ONE URL: the link in the mail. That is what
 * a link is. Everything downstream of it keeps it out of URLs, and the
 * page itself sends Referrer-Policy: no-referrer.
 *
 * ── WHAT IS TRUSTED, AND WHAT IS NOT ──────────────────────────
 *
 * The token, and nothing else. There is no order id in the request shape
 * to trust, no email, no order number - the body is rejected outright if
 * it carries anything but `token`, so a caller cannot even attempt to
 * name an order. The order is resolved by
 * guest_order_id_for_token (migration 065), which matches on the SHA-256
 * digest of the presented token against a table no role can read.
 *
 * ── IT FAILS CLOSED, AND SILENTLY ─────────────────────────────
 *
 * A malformed token, an unissued one, a revoked one, and an order that
 * has since been deleted all produce the identical 404 and the identical
 * sentence. Nothing in this file reports which case it was, to the caller
 * or to a log, so the endpoint cannot be used to learn that some other
 * order exists.
 *
 * ── NOT ONE ADMIN CAPABILITY ──────────────────────────────────
 *
 * No verb here writes anything. No refund, no shipment, no status
 * change, no price, no ownership. The response is built by
 * toGuestOrderView(), which carries no identifier of any kind - see the
 * type's own documentation. This route reaches Stripe never.
 */

const MAX_BODY_BYTES = 4_000;

type ErrorResponse = { error: string };

type GuestOrderResponse = { ok: true; order: GuestOrderView };

/**
 * Layer 1 of the limit: per instance, in memory, spent before the body is
 * read. Worth an instance's lifetime, which on a serverless platform is
 * short - layer 2 is the one that holds.
 */
const rateLimitState: RateLimitState = new Map();

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

/**
 * The one refusal. Same status, same sentence, no detail - and never
 * logged with the token or with any hint of which branch produced it.
 */
function notFound(): Response {
  return Response.json({ error: GUEST_ORDER_NOT_FOUND_MESSAGE } as ErrorResponse, { status: 404 });
}

export async function POST(request: Request): Promise<Response> {
  // Before the body is read, so a caller posting rubbish in a loop is
  // counted like any other.
  const localLimit = consumeLocalCheckoutRateLimit({
    policy: GUEST_ORDER_READ_RATE_LIMIT,
    state: rateLimitState,
    request,
    nowMs: Date.now(),
  });
  if (!localLimit.allow) return rateLimitRefusal(localLimit);

  const contentType = request.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return Response.json({ error: "Ungültige Anfrage." } as ErrorResponse, { status: 400 });
  }

  const rawBody = await request.text();
  if (rawBody.length > MAX_BODY_BYTES) {
    return Response.json({ error: "Anfrage zu groß." } as ErrorResponse, { status: 413 });
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return Response.json({ error: "Ungültige Anfrage." } as ErrorResponse, { status: 400 });
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return Response.json({ error: "Ungültige Anfrage." } as ErrorResponse, { status: 400 });
  }

  // THE BODY MAY CARRY EXACTLY ONE KEY. An order id, an email or an
  // order number sent alongside the token is not ignored, it is refused -
  // so no future edit of this file can start reading one by accident.
  const keys = Object.keys(body as Record<string, unknown>);
  if (keys.length !== 1 || keys[0] !== "token") {
    return Response.json({ error: "Ungültige Anfrage." } as ErrorResponse, { status: 400 });
  }

  const { token } = body as { token?: unknown };

  // Shape first, so a malformed token costs no round trip - and gets the
  // same answer as a well-formed one that opens nothing.
  if (!isWellFormedGuestOrderToken(token)) return notFound();

  const admin = getSupabaseAdmin();
  if (!admin) {
    console.error("Guest order read error: Supabase admin client is not configured.");
    return Response.json({ error: "Vorübergehend nicht verfügbar." } as ErrorResponse, { status: 503 });
  }

  // Layer 2, immediately above the database work it guards.
  const sharedLimit = await consumeSharedCheckoutRateLimit({
    policy: GUEST_ORDER_READ_RATE_LIMIT,
    request,
    client: admin,
    secret: getCheckoutBucketSecret(),
  });
  if (!sharedLimit.allow) return rateLimitRefusal(sharedLimit);

  const tokenHash = hashGuestOrderToken(token);

  const { data: orderId, error: lookupError } = await admin.rpc("guest_order_id_for_token", {
    p_token_hash: tokenHash,
  });

  if (lookupError) {
    // The message is the database's, never the token's.
    console.error("Guest order read: token lookup failed:", lookupError.message);
    return Response.json({ error: "Interner Fehler." } as ErrorResponse, { status: 500 });
  }

  if (typeof orderId !== "string" || !orderId) return notFound();

  const { data: order, error: orderError } = await admin
    .from("orders")
    .select(GUEST_ORDER_SELECT_COLUMNS)
    .eq("id", orderId)
    .maybeSingle();

  if (orderError) {
    console.error("Guest order read: order query failed:", orderError.message);
    return Response.json({ error: "Interner Fehler." } as ErrorResponse, { status: 500 });
  }

  // The token resolved an id and the order is gone. Same answer as a
  // token that never resolved anything.
  if (!order) return notFound();

  const { data: items, error: itemsError } = await admin
    .from("order_items")
    .select(GUEST_ORDER_ITEM_SELECT_COLUMNS)
    .eq("order_id", orderId)
    .order("created_at");

  if (itemsError) {
    console.error("Guest order read: order_items query failed:", itemsError.message);
    return Response.json({ error: "Interner Fehler." } as ErrorResponse, { status: 500 });
  }

  return Response.json(
    {
      ok: true,
      order: toGuestOrderView(
        order as unknown as GuestOrderRow,
        (items ?? []) as unknown as GuestOrderItemRow[]
      ),
    } satisfies GuestOrderResponse,
    {
      status: 200,
      headers: {
        // One person's order, resolved from a credential. Nothing about
        // it may sit in a shared or a local cache.
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      },
    }
  );
}
