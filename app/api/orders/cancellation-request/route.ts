import { verifyUserId } from "../../../../lib/verifyUser";
import { getSupabaseAdmin } from "../../../../lib/supabaseAdmin";

/**
 * Customer cancellation REQUEST (Task 26A).
 *
 * This endpoint records that a customer has asked whether an order can
 * still be stopped. It never cancels anything: no order status, no
 * fulfillment status and no payment is changed here, and the response
 * deliberately says "wir prüfen" rather than "storniert".
 *
 * It is also not the § 356a withdrawal route. Statutory withdrawal
 * declarations continue to go through /widerruf and /api/withdrawal
 * exclusively, and nothing in this file reads or writes
 * public.withdrawal_requests.
 *
 * Security shape:
 *   * account-only. A guest has no authenticated identity to bind an
 *     order to, so there is no email + order-number variant of this
 *     endpoint - that would be an unauthenticated mutation keyed on
 *     guessable data.
 *   * the order id from the browser is never trusted on its own.
 *     Ownership is enforced inside request_order_cancellation
 *     (migration 019) against the user id verified from the bearer
 *     token.
 *   * a foreign order and a non-existent order return exactly the same
 *     response, so this cannot be used to discover which order ids
 *     exist.
 *   * idempotent: submitting twice reports the same "requested" state
 *     and never moves the recorded timestamp.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_NOTE_LEN = 2000;
const MAX_BODY_BYTES = 20_000;

type ErrorResponse = { error: string };

type SuccessResponse = {
  ok: true;
  /** 'requested' on first submission, 'already_requested' on a repeat. */
  state: "requested" | "already_requested";
  message: string;
};

// One neutral message for every "we will look into it" outcome, so the
// customer is never told an order is cancelled when it is not.
const REVIEW_MESSAGE = "Wir prüfen, ob die Bestellung noch gestoppt werden kann, und melden uns per E-Mail.";

export async function POST(request: Request): Promise<Response> {
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

  if (typeof body !== "object" || body === null) {
    return Response.json({ error: "Ungültige Anfrage." } as ErrorResponse, { status: 400 });
  }

  const { orderId, note } = body as { orderId?: unknown; note?: unknown };

  // Authentication is checked before anything else touches the database,
  // so an unauthenticated caller learns nothing about any order id.
  const userId = await verifyUserId(request);
  if (!userId) {
    return Response.json({ error: "Bitte melde dich an." } as ErrorResponse, { status: 401 });
  }

  if (typeof orderId !== "string" || !UUID_RE.test(orderId)) {
    return Response.json({ error: "Bestellung nicht gefunden." } as ErrorResponse, { status: 404 });
  }

  let trimmedNote: string | null = null;
  if (note !== undefined && note !== null) {
    if (typeof note !== "string" || note.length > MAX_NOTE_LEN) {
      return Response.json({ error: "Ungültige Anfrage." } as ErrorResponse, { status: 400 });
    }
    trimmedNote = note.trim() || null;
  }

  const admin = getSupabaseAdmin();
  if (!admin) {
    console.error("Cancellation request error: Supabase admin client is not configured.");
    return Response.json(
      { error: "Das klappt gerade nicht. Schreib uns direkt an info@gloamatcha.com." } as ErrorResponse,
      { status: 503 }
    );
  }

  const { data, error } = await admin.rpc("request_order_cancellation", {
    p_order_id: orderId,
    p_user_id: userId,
    p_note: trimmedNote,
  });

  if (error) {
    console.error("Cancellation request error:", error.message);
    return Response.json({ error: "Interner Fehler." } as ErrorResponse, { status: 500 });
  }

  // Same response for "not yours" and "does not exist" - no enumeration.
  if (data === "not_found") {
    return Response.json({ error: "Bestellung nicht gefunden." } as ErrorResponse, { status: 404 });
  }

  if (data === "not_eligible") {
    return Response.json(
      {
        error:
          "Diese Bestellung lässt sich nicht mehr stoppen. Nach Erhalt kannst du dein Widerrufsrecht nutzen.",
      } as ErrorResponse,
      { status: 409 }
    );
  }

  if (data === "requested" || data === "already_requested") {
    return Response.json(
      { ok: true, state: data, message: REVIEW_MESSAGE } satisfies SuccessResponse,
      { status: 200 }
    );
  }

  console.error("Cancellation request: unexpected result from request_order_cancellation:", data);
  return Response.json({ error: "Interner Fehler." } as ErrorResponse, { status: 500 });
}
