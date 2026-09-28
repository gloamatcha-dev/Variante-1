import { getSupabaseAdmin } from "../../../../../lib/supabaseAdmin";
import { sendCancellationRequestNotificationIfNeeded } from "../../../../../lib/cancellationRequestNotificationEmail";
import type { RateLimitState } from "../../../../../lib/launchRateLimit";
import {
  consumeLocalCheckoutRateLimit,
  consumeSharedCheckoutRateLimit,
  getCheckoutBucketSecret,
  CHECKOUT_RATE_LIMITED_MESSAGE,
} from "../../../../../lib/checkoutRateLimit";
import {
  GUEST_ORDER_CANCEL_RATE_LIMIT,
  GUEST_ORDER_NOT_FOUND_MESSAGE,
  hashGuestOrderToken,
  isWellFormedGuestOrderToken,
} from "../../../../../lib/guestOrderAccess";

/**
 * GUEST CANCELLATION REQUEST.
 *
 * The same act as POST /api/orders/cancellation-request, authorized a
 * different way: by possession of the management link instead of by a
 * verified Supabase Auth session. It records that somebody has asked
 * whether an order can still be stopped. It cancels nothing.
 *
 * ── IT IS THE SAME REQUEST, NOT A SECOND KIND OF ONE ──────────
 *
 * There is exactly one cancellation-request rule in this system and it
 * lives in the database: migration 065's
 * apply_order_cancellation_request, which is migration 019's body moved
 * intact - the same row lock, the same idempotency check ahead of the
 * same eligibility check, the same two columns written and no others.
 * This route reaches it through request_order_cancellation_by_token; the
 * account route reaches it through request_order_cancellation. Neither
 * wrapper contains a rule.
 *
 * So everything downstream is unchanged and needs no guest-specific
 * anything: the admin overview reads cancellation_requested_at and shows
 * STORNO ANGEFRAGT, mark_order_shipped (migration 032) refuses to ship
 * while the request is open, resolve_order_cancellation_request
 * (migration 031) answers it, and the customer's outcome mail is sent
 * from the resolution column by the existing sender. There is no second
 * admin workflow, and nothing here can create one.
 *
 * ── STORNO IS STILL NOT REFUND ────────────────────────────────
 *
 * No Stripe import exists in this file and no refund function is
 * reachable from it. A request moves one timestamp and one note. Whether
 * money goes back is a separate, later, human decision - exactly as it
 * is for a signed-in customer.
 *
 * ── THE BROWSER NAMES NOTHING ─────────────────────────────────
 *
 * The account route has to accept an orderId, because a signed-in
 * customer has many orders and has to say which. A link points at one
 * order, so this route accepts no order id at all - and refuses a body
 * that carries one. The order is resolved from the token's digest inside
 * the database. There is no eligibility check here, no payment state read
 * here, and no order read here: all three would be a decision taken on a
 * stale read outside the lock.
 *
 * ── THE NOTIFICATION IS THE EXISTING ONE ──────────────────────
 *
 * After the request is durable, the same internal sender the account
 * route calls is entered, so a human actually learns a customer asked.
 * Its outcome is reported and never acted on: the customer's request is
 * already durable by then and must stay durable, so a mail failure is
 * recorded on its own column and never reaches this response.
 */

const MAX_NOTE_LEN = 2000;
const MAX_BODY_BYTES = 20_000;

type ErrorResponse = { error: string };

type SuccessResponse = {
  ok: true;
  /** 'requested' on first submission, 'already_requested' on a repeat. */
  state: "requested" | "already_requested";
  message: string;
};

/**
 * The SAME sentence the account route returns, written out rather than
 * imported because that route keeps it as a private const. It is the one
 * neutral "we will look into it" message, and it never says "storniert",
 * because nothing has been cancelled.
 */
const REVIEW_MESSAGE = "Wir prüfen, ob die Bestellung noch gestoppt werden kann, und melden uns per E-Mail.";

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

/** The same answer for "no such link" and "not this link's order". */
function notFound(): Response {
  return Response.json({ error: GUEST_ORDER_NOT_FOUND_MESSAGE } as ErrorResponse, { status: 404 });
}

export async function POST(request: Request): Promise<Response> {
  const localLimit = consumeLocalCheckoutRateLimit({
    policy: GUEST_ORDER_CANCEL_RATE_LIMIT,
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

  // TOKEN AND AN OPTIONAL NOTE. NOTHING ELSE, EVER. An orderId, an email
  // or an order number alongside them is a refusal rather than an
  // ignored field, so this route cannot quietly grow a second way to
  // name an order.
  const keys = Object.keys(body as Record<string, unknown>);
  if (keys.some(key => key !== "token" && key !== "note")) {
    return Response.json({ error: "Ungültige Anfrage." } as ErrorResponse, { status: 400 });
  }

  const { token, note } = body as { token?: unknown; note?: unknown };

  if (!isWellFormedGuestOrderToken(token)) return notFound();

  let trimmedNote: string | null = null;
  if (note !== undefined && note !== null) {
    if (typeof note !== "string" || note.length > MAX_NOTE_LEN) {
      return Response.json({ error: "Ungültige Anfrage." } as ErrorResponse, { status: 400 });
    }
    trimmedNote = note.trim() || null;
  }

  const admin = getSupabaseAdmin();
  if (!admin) {
    console.error("Guest cancellation request error: Supabase admin client is not configured.");
    return Response.json(
      { error: "Das klappt gerade nicht. Schreib uns direkt an hello@gloamatcha.com." } as ErrorResponse,
      { status: 503 }
    );
  }

  // Layer 2, immediately above the durable write it guards. `refuse` on
  // unavailable for this policy - see GUEST_ORDER_CANCEL_RATE_LIMIT.
  const sharedLimit = await consumeSharedCheckoutRateLimit({
    policy: GUEST_ORDER_CANCEL_RATE_LIMIT,
    request,
    client: admin,
    secret: getCheckoutBucketSecret(),
  });
  if (!sharedLimit.allow) return rateLimitRefusal(sharedLimit);

  const { data, error } = await admin.rpc("request_order_cancellation_by_token", {
    p_token_hash: hashGuestOrderToken(token),
    p_note: trimmedNote,
  });

  if (error) {
    console.error("Guest cancellation request error:", error.message);
    return Response.json({ error: "Interner Fehler." } as ErrorResponse, { status: 500 });
  }

  // Same response for "no such link" and "that link's order is gone" -
  // no enumeration, and nothing about which orders exist.
  if (data === "not_found") return notFound();

  if (data === "not_eligible") {
    // Byte-for-byte the account route's sentence for the same outcome.
    return Response.json(
      {
        error:
          "Diese Bestellung lässt sich nicht mehr stoppen. Nach Erhalt kannst du dein Widerrufsrecht nutzen.",
      } as ErrorResponse,
      { status: 409 }
    );
  }

  if (data === "requested" || data === "already_requested") {
    // STRICTLY AFTER the request is durable, exactly as the account route
    // does it. The RPC has committed by this line, so the timestamp and
    // the note genuinely exist in public.orders.
    //
    // Both results enter the sender on purpose. 'already_requested'
    // created no second request and moved no timestamp, but the sender's
    // own claim picks the row up if and only if an earlier send FAILED -
    // which makes pressing the button again the interim retry path. A
    // 'sent' row loses the claim and mails nothing, so a repeat can never
    // produce a second notification.
    //
    // The sender needs an order id and this route deliberately never
    // learned one. It is re-resolved from the same digest, through the
    // same function the RPC used - so the id handed over is the database's
    // answer and never the browser's. Reaching this branch is itself
    // proof that this link's order accepted the request.
    const { data: orderId, error: lookupError } = await admin.rpc("guest_order_id_for_token", {
      p_token_hash: hashGuestOrderToken(token),
    });

    if (lookupError || typeof orderId !== "string" || !orderId) {
      // The request is durable regardless. Only the notification is lost,
      // and only until somebody presses the button again or a sweep runs.
      console.error("Guest cancellation request: could not resolve the order for the internal notification.");
    } else {
      const notification = await sendCancellationRequestNotificationIfNeeded(orderId);
      if (notification === "failed") {
        // Order id only. Never the token, the note, or the customer.
        console.error(`Guest cancellation request: internal notification failed for order ${orderId}.`);
      }
    }

    // Deliberately identical to the account route's success body: the
    // customer is told the same thing whichever door they came through,
    // and it still never says "storniert".
    return Response.json(
      { ok: true, state: data, message: REVIEW_MESSAGE } satisfies SuccessResponse,
      { status: 200, headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } }
    );
  }

  console.error("Guest cancellation request: unexpected result from request_order_cancellation_by_token:", data);
  return Response.json({ error: "Interner Fehler." } as ErrorResponse, { status: 500 });
}
