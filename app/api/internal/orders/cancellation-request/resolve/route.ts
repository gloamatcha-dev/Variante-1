import { getSupabaseAdmin } from "../../../../../../lib/supabaseAdmin";
import { isBearerSecretAuthorized } from "../../../../../../lib/serverSecretAuth";
import { sendCancellationOutcomeEmailIfNeeded } from "../../../../../../lib/cancellationOutcomeEmail";
import {
  isResolutionResult,
  resolutionIsDurable,
  resolutionOutcome,
  resolutionResultStatus,
  resolutionWasNewlyApplied,
  validateResolutionRequest,
  type RefusedResolutionResult,
} from "../../../../../../lib/cancellationResolutionRules";

/**
 * Answers a CUSTOMER's cancellation request, and tells them the answer.
 *
 * This is the end of the loop that started in Phase 2A. A customer asks
 * (POST /api/orders/cancellation-request, migration 019), the fulfillment
 * inbox is told (Phase 2D-A, migration 030), and now an operator answers
 * yes or no, the answer is durable, and the customer is emailed about it.
 *
 * ── HOW THIS DIFFERS FROM /api/internal/orders/cancel ─────────
 *
 * Both endpoints can end with an order cancelled. They are still two
 * different operations and both are kept:
 *
 *   /api/internal/orders/cancel          (Phase 2C)
 *     The low-level operational cancellation. "Cancel this order."
 *     Requires no customer request, records no resolution, mails no
 *     customer. Use it when the shop decides on its own to stop an order
 *     - a stock problem, a duplicate, a payment concern.
 *
 *   /api/internal/orders/cancellation-request/resolve   (this one)
 *     Answers a question a customer actually asked. REQUIRES a durable
 *     cancellation_requested_at; an order nobody asked about returns
 *     'no_request' and nothing happens. It records a terminal answer and
 *     emails the customer about it. On approval it does not reimplement
 *     cancellation - migration 031's RPC calls cancel_order, so the
 *     shipped/delivered guard is the same guard, in the same transaction.
 *
 * They share CANCELLATION_ADMIN_SECRET deliberately. Both are "an
 * operator decides the fate of an order": one blast radius, one
 * credential. Splitting them would have meant a fourth secret guarding
 * strictly less than the third already does.
 *
 * ── WHAT A CALLER CAN AND CANNOT DECIDE ───────────────────────
 *
 * One order number and one of two words. Unknown keys are REFUSED, not
 * ignored, so `status`, `fulfillment_status`, `payment_status`,
 * `cancelled_at`, `resolution`, `resolvedAt`, `refundAmount`, `reason`,
 * `userId`, `customerEmail`, `recipient`, `to`, `subject` and `html` all
 * come back as a 400 rather than being silently dropped.
 *
 * The caller cannot choose what "approve" means: cancel_order decides
 * that. They cannot choose the resolution timestamp: the RPC sets now().
 * They cannot choose who is emailed, what the subject says, or which of
 * the two messages goes out: the sender reads the recipient from the
 * order's frozen customer_snapshot and the outcome from the durable
 * resolution column.
 *
 * ── APPROVAL IS NOT A REFUND ──────────────────────────────────
 *
 * THIS ROUTE CREATES NO REFUND, AND MUST NEVER LEARN TO. There is no
 * Stripe import in this file and no Stripe call anywhere beneath it. An
 * approved cancellation stops fulfillment; the money is a separate,
 * manual Stripe Dashboard action reconciled afterwards by migration 019's
 * apply_order_refund_state. The customer email says exactly that and
 * claims nothing more.
 *
 * ── ORDERING, WHICH IS THE WHOLE POINT ────────────────────────
 *
 *   1. authorization
 *   2. request validation
 *   3. resolve_order_cancellation_request commits: the resolution, and
 *      on approval the cancellation itself, are durable
 *   4. ONLY THEN sendCancellationOutcomeEmailIfNeeded
 *
 * The email is never attempted for a result that did not leave a terminal
 * answer on the order - resolutionIsDurable decides that, and 'conflict',
 * 'not_cancellable', 'order_already_cancelled', 'no_request' and
 * 'not_found' are all excluded. A conflicting second decision in
 * particular sends nothing at all.
 *
 * ── AN EMAIL FAILURE NEVER REVERSES A RESOLUTION ──────────────
 *
 * The send outcome is reported, never acted on. There is no rollback path
 * in this file and there could not be a useful one: on the approved path
 * the order is already cancelled, and service_role holds no write access
 * to the resolution or the lifecycle columns anyway. A Resend outage
 * writes cancellation_outcome_email_status = 'failed' and touches nothing
 * else.
 *
 * The response therefore reports two independent facts - what happened to
 * the request, and what happened to the email - so an operator is never
 * told the resolution failed because the mail did.
 */

/** Bounded so an unauthorized caller cannot stream a large body at us. */
const MAX_BODY_BYTES = 1_000;

type ErrorResponse = { error: string };

type ResolveResponse = {
  ok: true;
  orderNumber: string;
  /** The terminal answer now standing on the order. */
  resolution: "approved" | "declined";
  /** true on the first resolution, false on an idempotent repeat. */
  resolutionApplied: boolean;
  /** The outcome sender's own result, reported and never acted on. */
  emailOutcome: "sent" | "already-sent" | "not-eligible" | "failed";
};

/** One generic message per refusal. Never an infrastructure detail. */
const REFUSAL_MESSAGES: Record<RefusedResolutionResult, string> = {
  not_found: "Bestellung nicht gefunden.",
  no_request: "Für diese Bestellung liegt keine Stornierungsanfrage vor.",
  conflict: "Diese Stornierungsanfrage wurde bereits anders entschieden.",
  not_cancellable: "Diese Bestellung kann nicht mehr storniert werden.",
  order_already_cancelled: "Diese Bestellung ist bereits storniert.",
  invalid_decision: "Ungültige Entscheidung.",
};

export async function POST(request: Request): Promise<Response> {
  // Fail closed. An unset CANCELLATION_ADMIN_SECRET must never mean "no
  // authentication required" - that would leave a public endpoint that
  // can cancel orders and mail customers about it. The value itself is
  // never logged; only its absence is.
  const secret = process.env.CANCELLATION_ADMIN_SECRET;
  if (!secret) {
    console.error("Cancellation resolution: CANCELLATION_ADMIN_SECRET is not configured - refusing to run.");
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

  const validated = validateResolutionRequest(parsed);
  if (!validated.ok) {
    // The machine code says which field, and nothing about the value.
    return Response.json({ error: `Ungültige Anfrage: ${validated.code}.` } as ErrorResponse, { status: 400 });
  }
  const { orderNumber, decision } = validated.request;

  const admin = getSupabaseAdmin();
  if (!admin) {
    console.error("Cancellation resolution: SUPABASE_SECRET_KEY is not configured.");
    return Response.json({ error: "Vorübergehend nicht verfügbar." } as ErrorResponse, { status: 503 });
  }

  // STEP 3. The durable resolution. Every terminal-state rule, the row
  // lock, the idempotent repeat, the conflict refusal and - on approval -
  // the delegation to migration 029's cancel_order all live inside this
  // function, in one transaction. See migration 031.
  //
  // This route performs no table write of its own, and could not: after
  // 031 service_role STILL holds no UPDATE grant on the resolution
  // columns or on any lifecycle column.
  const { data, error } = await admin.rpc("resolve_order_cancellation_request", {
    p_order_number: orderNumber,
    p_decision: decision,
  });

  if (error) {
    // The order number, never the raw body and never a customer fact.
    console.error(`Cancellation resolution: RPC failed for ${orderNumber}:`, error.message);
    return Response.json({ error: "Interner Fehler." } as ErrorResponse, { status: 500 });
  }

  const payload = (data ?? {}) as { result?: unknown; order_id?: unknown };
  if (!isResolutionResult(payload.result)) {
    console.error(`Cancellation resolution: unexpected RPC result for ${orderNumber}.`);
    return Response.json({ error: "Interner Fehler." } as ErrorResponse, { status: 500 });
  }
  const result = payload.result;

  if (!resolutionIsDurable(result)) {
    // Nothing was answered, so nothing is mailed. This is the branch that
    // guarantees a refused or conflicting request can never reach a
    // customer's inbox.
    return Response.json(
      { error: REFUSAL_MESSAGES[result] } as ErrorResponse,
      { status: resolutionResultStatus(result) }
    );
  }

  // Derived from the RESULT, not echoed from the request: on an
  // 'already_*' result the stored decision is the authority.
  const resolution = resolutionOutcome(result);
  const orderId = typeof payload.order_id === "string" ? payload.order_id : null;

  if (!orderId) {
    // The resolution is committed either way - this is only about whether
    // the email can be addressed to the right order. Say so honestly
    // rather than reporting a failed resolution.
    console.error(`Cancellation resolution: no order id returned for ${orderNumber}; email not attempted.`);
    return Response.json(
      {
        ok: true,
        orderNumber,
        resolution,
        resolutionApplied: resolutionWasNewlyApplied(result),
        emailOutcome: "failed",
      } satisfies ResolveResponse,
      { status: 200 }
    );
  }

  // STEP 4. Strictly after the resolution has committed. The sender reads
  // the order back for itself, re-checks that a terminal resolution
  // genuinely exists, claims the right to send atomically, takes its
  // recipient from the order's frozen snapshot, and picks which of the
  // two messages to send from the durable resolution column. Nothing from
  // this request reaches it except the order id.
  //
  // It never throws, so a mail failure cannot escape into the
  // resolution's response path as an error. The outcome is data.
  const emailOutcome = await sendCancellationOutcomeEmailIfNeeded(orderId);

  return Response.json(
    {
      ok: true,
      orderNumber,
      resolution,
      resolutionApplied: resolutionWasNewlyApplied(result),
      emailOutcome,
    } satisfies ResolveResponse,
    { status: 200 }
  );
}
