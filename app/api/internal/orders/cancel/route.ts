import { getSupabaseAdmin } from "../../../../../lib/supabaseAdmin";
import { isBearerSecretAuthorized } from "../../../../../lib/serverSecretAuth";
import {
  cancellationIsDurable,
  cancellationResultStatus,
  cancellationWasNewlyApplied,
  isCancellationResult,
  validateCancellationRequest,
  type RefusedCancellationResult,
} from "../../../../../lib/orderCancellationRules";

/**
 * The authorized cancellation transition, and the only thing in this
 * repository that can move an order into 'cancelled'.
 *
 * The Phase 2C audit found the gap: a customer could ASK for a
 * cancellation (POST /api/orders/cancellation-request, which writes
 * migration 019's cancellation_requested_at and note and changes no
 * lifecycle column), but nothing could grant it. Cancelling meant
 * hand-written UPDATE statements against a live public.orders. This
 * endpoint replaces that with one guarded, idempotent, row-locked
 * transition.
 *
 * ── WHY ITS OWN SECRET ────────────────────────────────────────
 *
 * There is still no staff authorization model to use. public.profiles
 * (migration 001) carries customer_type - 'private' or 'business' - and
 * nothing else; there is no is_admin column, no role column and no
 * app_metadata claim anyone checks. Supabase Auth here answers "which
 * customer is this", which is a different question from "may this caller
 * operate the shop", and a signed-in customer must never acquire the
 * second answer by having the first.
 *
 * So this endpoint uses CANCELLATION_ADMIN_SECRET, in the shape the cron
 * endpoint and the shipment endpoint already established: Authorization:
 * Bearer <secret>, compared timing-safely through the shared helper,
 * failing closed when unset.
 *
 * DELIBERATELY NOT FULFILLMENT_ADMIN_SECRET, and deliberately not
 * CRON_SECRET. Three endpoints, three secrets, three blast radii:
 *
 *   CRON_SECRET               re-attempts work already owed
 *   FULFILLMENT_ADMIN_SECRET  ships an order and mails the customer
 *   CANCELLATION_ADMIN_SECRET STOPS fulfillment of an order
 *
 * A secret shared between two of them would make each as reachable as
 * the most widely copied instance of that one value, and would mean a
 * leaked shipping credential could also cancel every order in the shop.
 *
 * lib/verifyUser.ts is deliberately not imported. There is no code path
 * here through which a customer bearer token could authorize anything.
 *
 * ── WHAT A CALLER CAN AND CANNOT DECIDE ───────────────────────
 *
 * One order number. That is the whole input surface - there is not one
 * further field, optional or otherwise. Unknown keys are REFUSED, not
 * ignored, so `status`, `fulfillment_status`, `payment_status`,
 * `cancelled_at`, `refundAmount`, `reason`, `email`, `recipient` and
 * every other attempt to steer this endpoint comes back as a 400 rather
 * than being silently dropped. status, fulfillment_status and
 * cancelled_at are all computed by cancel_order (migration 029). There is
 * no arbitrary-value surface here at all.
 *
 * ── CANCELLATION IS NOT A REFUND ──────────────────────────────
 *
 * THIS ROUTE CREATES NO REFUND, AND MUST NEVER LEARN TO. There is no
 * Stripe import in this file and no Stripe call anywhere beneath it.
 * Refunds are initiated by hand in the Stripe Dashboard, and migration
 * 019's apply_order_refund_state reconciles the outcome from an absolute
 * re-read of the payment intent's refunds when the webhook arrives. That
 * pipeline is already idempotent and is completely untouched by this
 * task.
 *
 * A cancelled order may therefore still read payment_status = 'paid'.
 * That is an honest description of the world - fulfillment has stopped,
 * the money has not moved back yet - and not a state to "fix" from here.
 * Writing payment_status from a cancellation would assert a refund
 * nobody performed, and the next refund webhook would correctly write it
 * straight back.
 *
 * ── NO EMAIL FROM HERE, YET ───────────────────────────────────
 *
 * The customer cancellation email does not exist (Phase 2D). This route
 * therefore imports no sender and no Resend client, and it deliberately
 * does not pretend otherwise: unlike the shipment route, whose response
 * reports an emailOutcome, this response has no email field to report,
 * because no email is owed by this code yet. When that email is built it
 * plugs in exactly where the shipment confirmation does - strictly after
 * the RPC has committed, with its own claim state machine and its own
 * deterministic idempotency key, and with a send failure never able to
 * un-cancel anything.
 *
 * ── SAFE TO REPEAT ────────────────────────────────────────────
 *
 * Repeating an identical authorized request is safe and is the operator's
 * retry path: the RPC returns 'already_cancelled' having performed zero
 * writes, cancelled_at is not moved, and the response says
 * cancellationApplied: false so the operator can tell a first
 * cancellation from a repeat.
 *
 * ── SUBSCRIPTIONS ─────────────────────────────────────────────
 *
 * Nothing here knows how the order came to exist. A subscription cycle's
 * fulfillment order is a normal row in public.orders with the same
 * columns, so it cancels through this identical path. This cancels ONE
 * ORDER; it does not touch public.subscriptions, does not stop a Stripe
 * subscription, and does not prevent the next cycle. Subscription
 * lifecycle cancellation is a separate, unbuilt feature, and
 * B2C_SUBSCRIPTIONS_ENABLED is untouched.
 */

/**
 * Bounded so an unauthorized caller cannot stream a large body at us.
 * Smaller than the shipment endpoint's 4 KB because the entire valid body
 * is one order number: `{"orderNumber":"GLOA-2026-000123"}` is 34 bytes.
 */
const MAX_BODY_BYTES = 1_000;

type ErrorResponse = { error: string };

type CancelResponse = {
  ok: true;
  orderNumber: string;
  /** Always "cancelled" here - only durable results reach this response. */
  cancellationStatus: "cancelled";
  cancelledAt: string | null;
  /** true on the first transition, false on an idempotent repeat. */
  cancellationApplied: boolean;
};

/** One generic message per refusal. Never an infrastructure detail. */
const REFUSAL_MESSAGES: Record<RefusedCancellationResult, string> = {
  not_found: "Bestellung nicht gefunden.",
  not_cancellable: "Diese Bestellung kann nicht mehr storniert werden.",
};

export async function POST(request: Request): Promise<Response> {
  // Fail closed. An unset CANCELLATION_ADMIN_SECRET must never mean "no
  // authentication required" - that would leave a public endpoint that
  // can stop fulfillment of any order in the shop. The value itself is
  // never logged; only its absence is.
  const secret = process.env.CANCELLATION_ADMIN_SECRET;
  if (!secret) {
    console.error("Cancellation transition: CANCELLATION_ADMIN_SECRET is not configured - refusing to run.");
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

  const validated = validateCancellationRequest(parsed);
  if (!validated.ok) {
    // The machine code says which field, and nothing about the value.
    return Response.json({ error: `Ungültige Anfrage: ${validated.code}.` } as ErrorResponse, { status: 400 });
  }
  const { orderNumber } = validated.request;

  const admin = getSupabaseAdmin();
  if (!admin) {
    console.error("Cancellation transition: SUPABASE_SECRET_KEY is not configured.");
    return Response.json({ error: "Vorübergehend nicht verfügbar." } as ErrorResponse, { status: 503 });
  }

  // The durable transition. Every lifecycle guard, the row lock, the
  // idempotent repeat and the three-column write live inside this
  // function, in the same transaction as the write - see migration 029.
  // This route performs no table write of its own, and could not: after
  // 029 service_role STILL holds no UPDATE grant on status or
  // fulfillment_status.
  const { data, error } = await admin.rpc("cancel_order", {
    p_order_number: orderNumber,
  });

  if (error) {
    // The order number, never the raw body and never a customer fact.
    console.error(`Cancellation transition: RPC failed for ${orderNumber}:`, error.message);
    return Response.json({ error: "Interner Fehler." } as ErrorResponse, { status: 500 });
  }

  const payload = (data ?? {}) as { result?: unknown; cancelled_at?: unknown };
  if (!isCancellationResult(payload.result)) {
    console.error(`Cancellation transition: unexpected RPC result for ${orderNumber}.`);
    return Response.json({ error: "Interner Fehler." } as ErrorResponse, { status: 500 });
  }
  const result = payload.result;

  if (!cancellationIsDurable(result)) {
    return Response.json(
      { error: REFUSAL_MESSAGES[result] } as ErrorResponse,
      { status: cancellationResultStatus(result) }
    );
  }

  // Only operationally necessary facts. No customer email, no name, no
  // address, no snapshot, no money, no refund state, no order id - the
  // caller supplied the order number and gets it back, and nothing about
  // the customer travels in this response at all.
  //
  // cancelledAt may legitimately be null on an 'already_cancelled' result
  // for an order the owner cancelled by hand before migration 029
  // existed. Reporting that null honestly is correct; 029 deliberately
  // backfilled no timestamp.
  return Response.json(
    {
      ok: true,
      orderNumber,
      cancellationStatus: "cancelled",
      cancelledAt: typeof payload.cancelled_at === "string" ? payload.cancelled_at : null,
      cancellationApplied: cancellationWasNewlyApplied(result),
    } satisfies CancelResponse,
    { status: 200 }
  );
}
