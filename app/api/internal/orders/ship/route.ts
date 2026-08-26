import { getSupabaseAdmin } from "../../../../../lib/supabaseAdmin";
import { isBearerSecretAuthorized } from "../../../../../lib/serverSecretAuth";
import { sendShipmentConfirmationIfNeeded } from "../../../../../lib/shipmentConfirmationEmail";
import {
  isShipmentResult,
  shipmentIsDurable,
  shipmentResultStatus,
  shipmentWasNewlyApplied,
  validateShipmentRequest,
  type RefusedShipmentResult,
} from "../../../../../lib/shipmentTransitionRules";

/**
 * The authorized shipment transition, and the only thing in this
 * repository that can move an order into 'shipped'.
 *
 * Phase 2A built the shipment confirmation and left it unwired, because
 * there was no authorized moment at which it could fire. This is that
 * moment: an operator marks one order shipped, and the customer's
 * confirmation follows strictly afterwards.
 *
 * ── WHY A SHARED SECRET AND NOT A ROLE ────────────────────────
 *
 * The audit found no staff authorization model to use. public.profiles
 * (migration 001) carries customer_type - 'private' or 'business' - and
 * nothing else; there is no is_admin column, no role column, no
 * organization model and no app_metadata claim anyone checks. Supabase
 * Auth here answers "which customer is this", which is a different
 * question from "may this caller operate the shop", and a signed-in
 * customer must never acquire the second answer by having the first.
 *
 * So this endpoint uses its own secret, in the shape the cron endpoint
 * already established: Authorization: Bearer <FULFILLMENT_ADMIN_SECRET>,
 * compared timing-safely, failing closed when unset. Deliberately its
 * OWN secret - not CRON_SECRET, not the Supabase, Stripe or Resend keys -
 * because a secret shared between two endpoints makes each of them as
 * reachable as the most widely copied instance of that value, and
 * because the two have genuinely different blast radii: the cron can
 * only re-attempt work already owed, while this changes fulfillment.
 *
 * lib/verifyUser.ts is deliberately not imported. There is no code path
 * here through which a customer bearer token could authorize anything.
 *
 * ── WHAT A CALLER CAN AND CANNOT DECIDE ───────────────────────
 *
 * One order number and three optional tracking strings. Unknown keys are
 * REFUSED, not ignored, so shipped_at, fulfillment_status, status,
 * payment_status, recipient, to, subject, html and every other attempt to
 * steer this endpoint comes back as a 400 rather than being silently
 * dropped. shipped_at and fulfillment_status are computed by
 * mark_order_shipped, and the recipient is read from the order's own
 * frozen customer_snapshot inside the confirmation sender. There is no
 * arbitrary-email surface here.
 *
 * ── AN OPEN CANCELLATION REQUEST BLOCKS THIS (Phase 2D-C) ─────
 *
 * Migration 032 added one guard to mark_order_shipped: an order is not
 * newly shipped while cancellation_requested_at IS NOT NULL AND
 * cancellation_request_resolution IS NULL. The RPC returns
 * 'cancellation_request_open' and this route answers 409.
 *
 * THE GUARD IS IN THE DATABASE, NOT HERE, and that is deliberate. A check
 * in this file would read the order, decide, and then call the RPC -
 * leaving a window in which a concurrent request_order_cancellation
 * commits and the shipment proceeds on a stale read. Inside the function
 * the check happens after `select ... for update`, and every other writer
 * of those columns takes the same lock on the same row, so the two
 * serialize. This route adds no pre-RPC check of its own and must not
 * grow one: it would be redundant at best and misleading at worst.
 *
 * A blocked shipment writes nothing and therefore mails nothing - the
 * result is not durable, so it never reaches sendShipmentConfirmationIfNeeded.
 * A DECLINED request does not block; the operator resolves the request
 * first (POST /api/internal/orders/cancellation-request/resolve) and then
 * ships normally.
 *
 * ── ORDERING, WHICH IS THE WHOLE POINT ────────────────────────
 *
 *   1. authorization
 *   2. request validation
 *   3. mark_order_shipped commits: fulfillment_status, status,
 *      shipped_at and the tracking columns are durable
 *   4. ONLY THEN sendShipmentConfirmationIfNeeded
 *
 * The email is never attempted for a result that did not leave the order
 * durably shipped - shipmentIsDurable decides that, and 'conflict',
 * 'already_advanced', 'not_shippable' and 'not_found' are all excluded.
 *
 * ── AN EMAIL FAILURE NEVER UN-SHIPS ANYTHING ──────────────────
 *
 * The send outcome is reported, never acted on. There is no rollback path
 * in this file and there could not be a useful one: migration 028's
 * function is the only way to write those columns and it has no reverse
 * operation, and service_role's UPDATE grant on public.orders still
 * covers only the six email-state columns. A Resend outage writes
 * shipment_email_status = 'failed' and touches nothing else.
 *
 * The response therefore reports two independent facts - what happened to
 * the shipment, and what happened to the email - so an operator is never
 * told the shipment failed because the mail did.
 *
 * ── SAFE TO REPEAT, WHICH IS THE MANUAL RETRY PATH ────────────
 *
 * There is no automatic shipment-email retry sweep yet (TECHNISCH
 * VORBEREITET - see lib/shipmentConfirmationEmail.ts). Until there is,
 * repeating an identical authorized request is the recovery path: the RPC
 * returns 'already_shipped' without moving shipped_at or rewriting
 * anything, and the confirmation sender is entered again, where its own
 * 'failed' -> 'sending' claim and the deterministic Resend key
 * gloa/shipment/<order-id> decide whether a message is actually sent. An
 * order whose email already says 'sent' loses the claim and mails
 * nothing.
 *
 * ── SUBSCRIPTIONS ─────────────────────────────────────────────
 *
 * Nothing here knows how the order came to exist. A subscription cycle's
 * fulfillment order is a normal row in public.orders with the same
 * columns, so it ships through this identical path. No subscription
 * lifecycle mail is sent from here and B2C_SUBSCRIPTIONS_ENABLED is
 * untouched.
 */

/** Bounded so an unauthorized caller cannot stream a large body at us. */
const MAX_BODY_BYTES = 4_000;

type ErrorResponse = { error: string };

type ShipResponse = {
  ok: true;
  orderNumber: string;
  /** Always "shipped" here - only durable results reach this response. */
  shipmentStatus: "shipped";
  shippedAt: string | null;
  /** true on the first transition, false on an idempotent repeat. */
  shipmentApplied: boolean;
  /** The confirmation sender's own outcome, reported and never acted on. */
  emailOutcome: "sent" | "already-sent" | "not-eligible" | "failed";
};

/** One generic message per refusal. Never an infrastructure detail. */
const REFUSAL_MESSAGES: Record<RefusedShipmentResult, string> = {
  not_found: "Bestellung nicht gefunden.",
  not_shippable: "Diese Bestellung kann nicht als versendet markiert werden.",
  already_advanced: "Diese Bestellung ist bereits weiter fortgeschritten.",
  conflict: "Diese Bestellung ist bereits mit anderen Sendungsdaten versendet.",
  // Migration 032. Operator-facing, so it says what to DO next.
  //
  // Deliberately worded to claim nothing that is not true. It does not
  // say the order is cancelled, because it is not - the customer asked a
  // question and nobody has answered it. It does not mention a refund,
  // because no refund follows from an unanswered request. It names the
  // one action that unblocks this: resolve the request. Declining it
  // leaves the order shippable through the ordinary path.
  cancellation_request_open:
    "Zu dieser Bestellung liegt eine offene Stornierungsanfrage vor. Bitte zuerst entscheiden (annehmen oder ablehnen), dann erneut versenden.",
};

export async function POST(request: Request): Promise<Response> {
  // Fail closed. An unset FULFILLMENT_ADMIN_SECRET must never mean "no
  // authentication required" - that would leave a public endpoint that
  // can mark any order shipped and mail the customer about it. The value
  // itself is never logged; only its absence is.
  const secret = process.env.FULFILLMENT_ADMIN_SECRET;
  if (!secret) {
    console.error("Shipment transition: FULFILLMENT_ADMIN_SECRET is not configured - refusing to run.");
    return Response.json({ error: "Nicht verfügbar." } as ErrorResponse, { status: 503 });
  }

  if (!isBearerSecretAuthorized(request, secret)) {
    // No detail, and nothing about the header is logged: a rejected
    // request must not tell the caller how close they were.
    return Response.json({ error: "Nicht autorisiert." } as ErrorResponse, { status: 401 });
  }

  const contentType = request.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return Response.json({ error: "Ungültige Anfrage." } as ErrorResponse, { status: 400 });
  }

  const rawBody = await request.text();
  if (rawBody.length > MAX_BODY_BYTES) {
    return Response.json({ error: "Anfrage zu groß." } as ErrorResponse, { status: 413 });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return Response.json({ error: "Ungültige Anfrage." } as ErrorResponse, { status: 400 });
  }

  const validated = validateShipmentRequest(parsed);
  if (!validated.ok) {
    // The machine code says which field, and nothing about the value.
    return Response.json({ error: `Ungültige Anfrage: ${validated.code}.` } as ErrorResponse, { status: 400 });
  }
  const { orderNumber, carrier, trackingNumber, trackingUrl } = validated.request;

  const admin = getSupabaseAdmin();
  if (!admin) {
    console.error("Shipment transition: SUPABASE_SECRET_KEY is not configured.");
    return Response.json({ error: "Vorübergehend nicht verfügbar." } as ErrorResponse, { status: 503 });
  }

  // STEP 3. The durable transition. Every lifecycle, payment, conflict
  // and normalization rule lives inside this function, in the same
  // transaction as the write - see migration 028.
  const { data, error } = await admin.rpc("mark_order_shipped", {
    p_order_number: orderNumber,
    p_carrier: carrier,
    p_tracking_number: trackingNumber,
    p_tracking_url: trackingUrl,
  });

  if (error) {
    // The order number, never the tracking data and never the raw body.
    console.error(`Shipment transition: RPC failed for ${orderNumber}:`, error.message);
    return Response.json({ error: "Interner Fehler." } as ErrorResponse, { status: 500 });
  }

  const payload = (data ?? {}) as { result?: unknown; order_id?: unknown; shipped_at?: unknown };
  if (!isShipmentResult(payload.result)) {
    console.error(`Shipment transition: unexpected RPC result for ${orderNumber}.`);
    return Response.json({ error: "Interner Fehler." } as ErrorResponse, { status: 500 });
  }
  const result = payload.result;

  if (!shipmentIsDurable(result)) {
    // Nothing shipped, so nothing is mailed. This is the branch that
    // guarantees a refused request can never reach a customer's inbox.
    return Response.json(
      { error: REFUSAL_MESSAGES[result] } as ErrorResponse,
      { status: shipmentResultStatus(result) }
    );
  }

  const orderId = typeof payload.order_id === "string" ? payload.order_id : null;
  if (!orderId) {
    // The shipment is committed either way - this is only about whether
    // the confirmation can be addressed to the right order. Say so
    // honestly rather than reporting a shipment failure.
    console.error(`Shipment transition: no order id returned for ${orderNumber}; email not attempted.`);
    return Response.json(
      {
        ok: true,
        orderNumber,
        shipmentStatus: "shipped",
        shippedAt: typeof payload.shipped_at === "string" ? payload.shipped_at : null,
        shipmentApplied: shipmentWasNewlyApplied(result),
        emailOutcome: "failed",
      } satisfies ShipResponse,
      { status: 200 }
    );
  }

  // STEP 4. Strictly after the transition has committed. The sender reads
  // the order back for itself, re-checks that it is genuinely shipped,
  // claims the right to send atomically, and takes its recipient from the
  // order's frozen snapshot. Nothing from this request reaches it except
  // the order id.
  //
  // It never throws, so a mail failure cannot escape into the shipment's
  // response path as an error. The outcome is data.
  const emailOutcome = await sendShipmentConfirmationIfNeeded(orderId);

  return Response.json(
    {
      ok: true,
      orderNumber,
      shipmentStatus: "shipped",
      shippedAt: typeof payload.shipped_at === "string" ? payload.shipped_at : null,
      shipmentApplied: shipmentWasNewlyApplied(result),
      emailOutcome,
    } satisfies ShipResponse,
    { status: 200 }
  );
}
