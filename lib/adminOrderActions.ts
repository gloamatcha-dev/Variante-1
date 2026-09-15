import { getSupabaseAdmin } from "./supabaseAdmin";
import { getStripeClient } from "./stripe";
import { sendShipmentConfirmationIfNeeded } from "./shipmentConfirmationEmail";
import { sendCancellationOutcomeEmailIfNeeded } from "./cancellationOutcomeEmail";
import { sendRefundConfirmationIfNeeded } from "./refundConfirmationEmail";
import { syncOrderRefundStateFromStripe } from "./orderRefunds";
import { isNewSettledRefundFact } from "./refundConfirmationRules";
import {
  isShipmentResult,
  shipmentIsDurable,
  shipmentResultStatus,
  shipmentWasNewlyApplied,
  validateShipmentRequest,
  type RefusedShipmentResult,
} from "./shipmentTransitionRules";
import {
  cancellationIsDurable,
  cancellationResultStatus,
  cancellationWasNewlyApplied,
  isCancellationResult,
  validateCancellationRequest,
  type RefusedCancellationResult,
} from "./orderCancellationRules";
import {
  isResolutionResult,
  resolutionIsDurable,
  resolutionOutcome,
  resolutionResultStatus,
  resolutionWasNewlyApplied,
  validateResolutionRequest,
  type RefusedResolutionResult,
} from "./cancellationResolutionRules";
import {
  canRefund,
  maxRefundableCents,
  refundIdempotencyKey,
  resolveRefundAmount,
  type ActionableOrder,
} from "./adminOrderActionRules";

/**
 * THE FOUR ORDER ACTIONS, BEHIND THE ADMIN SESSION.
 *
 * ── WHY NOT CALL THE INTERNAL ROUTES OVER HTTP ────────────────
 *
 * Because that would mean putting FULFILLMENT_ADMIN_SECRET and
 * CANCELLATION_ADMIN_SECRET into a request the admin screen causes, and
 * an internal HTTP hop buys nothing except a second place for a timeout
 * to happen. The routes under /api/internal/orders/* are thin: they check
 * a bearer secret, validate a body, call one RPC and then one email
 * sender. This module calls the SAME validator, the SAME RPC and the SAME
 * sender, with the admin session as its authorization instead.
 *
 * ── WHY THE ORCHESTRATION IS STATED TWICE AND THAT IS FINE ────
 *
 * The obvious alternative was to extract each internal route's four-line
 * sequence into a shared function and have both callers use it. It was
 * measured and rejected: roughly 150 assertions across nine test files
 * pin those routes by reading their source, and they guard shipment and
 * cancellation - customer email and order state. Rewriting that many live
 * guards to enable a refactor is a large chance to weaken one of them by
 * accident, for a gain of four lines.
 *
 * What matters is that the two paths cannot produce two truths, and they
 * cannot:
 *
 *   the TRANSITION   is decided inside the database function, under
 *                    `select ... for update`, in the same transaction as
 *                    its write. Neither caller can write those columns -
 *                    service_role's UPDATE grant on public.orders still
 *                    covers only the email-state columns.
 *   the EMAIL        is decided by the sender's own atomic claim. Two
 *                    callers racing means one wins the claim and the
 *                    other gets "already-sent".
 *
 * So the duplication is a call sequence, not a rule. Every rule has
 * exactly one home, and it is not this file.
 *
 * ── INVENTORY IS NOT TOUCHED HERE, AND CANNOT BE ──────────────
 *
 * No action below reads or writes a stock table, and none exists yet to
 * write. Shipping an order removes nothing from a shelf, a refund puts
 * nothing back, and a cancellation restores nothing. Stock stays manual
 * and separate until a package deliberately joins them.
 *
 * ── NO ACTION HERE CAN SEND AN ORDER CONFIRMATION ─────────────
 *
 * The purchase confirmation belongs to the checkout webhook and to
 * nothing else. It is not imported in this file, and a test asserts that.
 */

export type ActionFailure = {
  ok: false;
  /** HTTP status the route should answer with. */
  status: number;
  /** One operator-facing sentence. Never an infrastructure detail. */
  error: string;
};

export type ShipOutcome =
  | ActionFailure
  | {
      ok: true;
      orderNumber: string;
      shippedAt: string | null;
      /** true on the first transition, false on an idempotent repeat. */
      applied: boolean;
      emailOutcome: "sent" | "already-sent" | "not-eligible" | "failed";
    };

export type CancelOutcome =
  | ActionFailure
  | { ok: true; orderNumber: string; cancelledAt: string | null; applied: boolean };

export type ResolveOutcome =
  | ActionFailure
  | {
      ok: true;
      orderNumber: string;
      resolution: "approved" | "declined";
      applied: boolean;
      emailOutcome: "sent" | "already-sent" | "not-eligible" | "failed";
    };

export type RefundOutcome =
  | ActionFailure
  | {
      ok: true;
      orderNumber: string;
      /** What was asked of Stripe, in integer cents. */
      amountCents: number;
      /** Stripe's own word for the refund: succeeded, pending, failed… */
      refundStatus: string | null;
      /** What the order says AFTER the absolute re-read. */
      refundedTotalCents: number | null;
      syncResult: string;
      emailOutcome: "sent" | "already-sent" | "not-eligible" | "failed" | "not-attempted";
    };

const SHIP_REFUSALS: Record<RefusedShipmentResult, string> = {
  not_found: "Bestellung nicht gefunden.",
  not_shippable: "Diese Bestellung kann nicht als versendet markiert werden.",
  already_advanced: "Diese Bestellung ist bereits weiter fortgeschritten.",
  conflict: "Diese Bestellung ist bereits mit anderen Sendungsdaten versendet.",
  cancellation_request_open:
    "Zu dieser Bestellung liegt eine offene Stornierungsanfrage vor. Bitte zuerst entscheiden (annehmen oder ablehnen), dann erneut versenden.",
};

const CANCEL_REFUSALS: Record<RefusedCancellationResult, string> = {
  not_found: "Bestellung nicht gefunden.",
  not_cancellable: "Diese Bestellung kann nicht mehr storniert werden.",
};

// Word for word the same map app/api/internal/orders/cancellation-request/
// resolve/route.ts uses. The operator gets the same sentence whichever
// path answered, which is the point of reusing the same vocabulary.
const RESOLVE_REFUSALS: Record<RefusedResolutionResult, string> = {
  not_found: "Bestellung nicht gefunden.",
  no_request: "Für diese Bestellung liegt keine Stornierungsanfrage vor.",
  conflict: "Diese Stornierungsanfrage wurde bereits anders entschieden.",
  not_cancellable: "Diese Bestellung kann nicht mehr storniert werden.",
  order_already_cancelled: "Diese Bestellung ist bereits storniert.",
  invalid_decision: "Ungültige Entscheidung.",
};

const unavailable = (): ActionFailure => ({ ok: false, status: 503, error: "Vorübergehend nicht verfügbar." });
const internal = (): ActionFailure => ({ ok: false, status: 500, error: "Interner Fehler." });

/* ══════════════════════════════════════════════════════════════
   SHIPMENT
   ══════════════════════════════════════════════════════════════ */

/**
 * Marks one order shipped and lets the existing confirmation follow.
 *
 * The same four steps app/api/internal/orders/ship/route.ts performs,
 * with the admin session already checked by the caller:
 *
 *   1. validateShipmentRequest  - the shared validator, unchanged
 *   2. mark_order_shipped       - migration 028, every guard inside it
 *   3. durability check         - a refused transition mails nothing
 *   4. sendShipmentConfirmationIfNeeded
 *
 * An email failure never un-ships anything: there is no reverse
 * operation for the RPC and service_role could not perform one. The
 * outcome is reported so the operator sees "versendet, Mail
 * fehlgeschlagen" rather than being told the shipment failed.
 */
export async function adminShipOrder(input: unknown): Promise<ShipOutcome> {
  const validated = validateShipmentRequest(input);
  if (!validated.ok) {
    return { ok: false, status: 400, error: `Ungültige Versanddaten: ${validated.code}.` };
  }
  const { orderNumber, carrier, trackingNumber, trackingUrl } = validated.request;

  const admin = getSupabaseAdmin();
  if (!admin) {
    console.error("Admin ship: SUPABASE_SECRET_KEY is not configured.");
    return unavailable();
  }

  const { data, error } = await admin.rpc("mark_order_shipped", {
    p_order_number: orderNumber,
    p_carrier: carrier,
    p_tracking_number: trackingNumber,
    p_tracking_url: trackingUrl,
  });

  if (error) {
    console.error(`Admin ship: RPC failed for ${orderNumber}:`, error.message);
    return internal();
  }

  const payload = (data ?? {}) as { result?: unknown; order_id?: unknown; shipped_at?: unknown };
  if (!isShipmentResult(payload.result)) {
    console.error(`Admin ship: unexpected RPC result for ${orderNumber}.`);
    return internal();
  }
  const result = payload.result;

  if (!shipmentIsDurable(result)) {
    return { ok: false, status: shipmentResultStatus(result), error: SHIP_REFUSALS[result] };
  }

  const shippedAt = typeof payload.shipped_at === "string" ? payload.shipped_at : null;
  const orderId = typeof payload.order_id === "string" ? payload.order_id : null;
  if (!orderId) {
    console.error(`Admin ship: no order id returned for ${orderNumber}; email not attempted.`);
    return { ok: true, orderNumber, shippedAt, applied: shipmentWasNewlyApplied(result), emailOutcome: "failed" };
  }

  // Strictly after the transition committed. The sender re-reads the
  // order, re-checks that it is genuinely shipped, claims the right to
  // send atomically and takes its recipient from the frozen snapshot.
  // Nothing from this request reaches it except the order id.
  const emailOutcome = await sendShipmentConfirmationIfNeeded(orderId);

  return { ok: true, orderNumber, shippedAt, applied: shipmentWasNewlyApplied(result), emailOutcome };
}

/* ══════════════════════════════════════════════════════════════
   CANCELLATION
   ══════════════════════════════════════════════════════════════ */

/**
 * Cancels one order. Creates NO refund, and must never learn to.
 *
 * cancel_order (migration 029) writes status, fulfillment_status and
 * cancelled_at and not one money column, so a cancelled order routinely
 * still reads payment_status = 'paid'. That is an honest description of
 * the world - fulfillment has stopped, the money has not moved back -
 * and the admin screen says exactly that rather than implying a refund.
 *
 * There is no customer email on this path, because the repository has
 * none for a direct cancellation. The only cancellation mail that exists
 * for an ORDER is the outcome of a customer's cancellation REQUEST
 * (lib/cancellationOutcomeEmail.ts), which is a different event and is
 * sent by adminResolveCancellationRequest below. Sending it from here
 * would answer a question the customer never asked.
 */
export async function adminCancelOrder(input: unknown): Promise<CancelOutcome> {
  const validated = validateCancellationRequest(input);
  if (!validated.ok) {
    return { ok: false, status: 400, error: `Ungültige Anfrage: ${validated.code}.` };
  }
  const { orderNumber } = validated.request;

  const admin = getSupabaseAdmin();
  if (!admin) {
    console.error("Admin cancel: SUPABASE_SECRET_KEY is not configured.");
    return unavailable();
  }

  const { data, error } = await admin.rpc("cancel_order", { p_order_number: orderNumber });
  if (error) {
    console.error(`Admin cancel: RPC failed for ${orderNumber}:`, error.message);
    return internal();
  }

  const payload = (data ?? {}) as { result?: unknown; cancelled_at?: unknown };
  if (!isCancellationResult(payload.result)) {
    console.error(`Admin cancel: unexpected RPC result for ${orderNumber}.`);
    return internal();
  }
  const result = payload.result;

  if (!cancellationIsDurable(result)) {
    return { ok: false, status: cancellationResultStatus(result), error: CANCEL_REFUSALS[result] };
  }

  return {
    ok: true,
    orderNumber,
    cancelledAt: typeof payload.cancelled_at === "string" ? payload.cancelled_at : null,
    applied: cancellationWasNewlyApplied(result),
  };
}

/**
 * Answers one customer cancellation request, approved or declined.
 *
 * Migration 031's function owns every rule, including delegating to
 * cancel_order on approval. The outcome email is the existing one and is
 * sent strictly after the resolution committed.
 */
export async function adminResolveCancellationRequest(input: unknown): Promise<ResolveOutcome> {
  const validated = validateResolutionRequest(input);
  if (!validated.ok) {
    return { ok: false, status: 400, error: `Ungültige Anfrage: ${validated.code}.` };
  }
  const { orderNumber, decision } = validated.request;

  const admin = getSupabaseAdmin();
  if (!admin) {
    console.error("Admin resolve: SUPABASE_SECRET_KEY is not configured.");
    return unavailable();
  }

  const { data, error } = await admin.rpc("resolve_order_cancellation_request", {
    p_order_number: orderNumber,
    p_decision: decision,
  });
  if (error) {
    console.error(`Admin resolve: RPC failed for ${orderNumber}:`, error.message);
    return internal();
  }

  const payload = (data ?? {}) as { result?: unknown; order_id?: unknown };
  if (!isResolutionResult(payload.result)) {
    console.error(`Admin resolve: unexpected RPC result for ${orderNumber}.`);
    return internal();
  }
  const result = payload.result;

  if (!resolutionIsDurable(result)) {
    return { ok: false, status: resolutionResultStatus(result), error: RESOLVE_REFUSALS[result] };
  }

  // From the RESULT, not echoed from the request: on an 'already_*'
  // result the stored decision is the authority.
  const resolution = resolutionOutcome(result);
  const orderId = typeof payload.order_id === "string" ? payload.order_id : null;
  if (!orderId) {
    console.error(`Admin resolve: no order id returned for ${orderNumber}; email not attempted.`);
    return { ok: true, orderNumber, resolution, applied: resolutionWasNewlyApplied(result), emailOutcome: "failed" };
  }

  const emailOutcome = await sendCancellationOutcomeEmailIfNeeded(orderId);
  return { ok: true, orderNumber, resolution, applied: resolutionWasNewlyApplied(result), emailOutcome };
}

/* ══════════════════════════════════════════════════════════════
   REFUND

   The one action with no existing execution path anywhere in the
   repository. Before this, `stripe.refunds.create` appeared in no
   source file: refunds were made by hand in the Stripe dashboard
   and the webhook reconciled the result. Everything AFTER the
   creation - the absolute re-read, the order write, the customer
   email - already existed and is reused unchanged.
   ══════════════════════════════════════════════════════════════ */

/** The columns the server needs to decide a refund. Read by the server. */
const REFUND_ORDER_COLUMNS =
  "id, order_number, currency, total_gross_cents, refunded_total_cents, payment_status, " +
  "status, fulfillment_status, cancelled_at, cancellation_requested_at, " +
  "cancellation_request_resolution, stripe_payment_intent_id";

/**
 * Sends money back for one order.
 *
 * THE CLIENT SENDS AN ORDER ID AND AT MOST AN AMOUNT. It does not send
 * the payment intent, the maximum, the currency, the paid total or the
 * already-refunded total, and if it did they would be ignored: every one
 * of those is read from the order this function loads itself. A browser
 * cannot name the Stripe object that gets charged.
 *
 * The sequence:
 *
 *   1. load the order with the service role
 *   2. canRefund + resolveRefundAmount, both against the loaded row
 *   3. stripe.refunds.create with a deterministic idempotency key
 *   4. syncOrderRefundStateFromStripe - the EXISTING absolute re-read,
 *      which is what actually writes refunded_total_cents and
 *      payment_status, through migration 019's function
 *   5. sendRefundConfirmationIfNeeded, gated by isNewSettledRefundFact
 *      exactly as the webhook gates it
 *
 * Step 4 is why a duplicate refund cannot inflate the order: the total
 * written is the sum Stripe reports, not a delta this function adds. And
 * step 3's key means a retry of the SAME intent returns Stripe's existing
 * refund instead of creating a second one.
 */
export async function adminRefundOrder(orderId: string, rawAmount: unknown): Promise<RefundOutcome> {
  const admin = getSupabaseAdmin();
  if (!admin) {
    console.error("Admin refund: SUPABASE_SECRET_KEY is not configured.");
    return unavailable();
  }

  const { data, error } = await admin
    .from("orders")
    .select(REFUND_ORDER_COLUMNS)
    .eq("id", orderId)
    .maybeSingle();

  if (error) {
    console.error(`Admin refund: order load failed for ${orderId}:`, error.message);
    return internal();
  }
  if (!data) return { ok: false, status: 404, error: "Bestellung nicht gefunden." };

  const order = data as unknown as ActionableOrder & { id: string; order_number: string };
  const orderNumber = typeof order.order_number === "string" ? order.order_number : orderId;

  const verdict = canRefund(order);
  if (!verdict.allowed) return { ok: false, status: 409, error: verdict.reason };

  const maxCents = maxRefundableCents(order);
  const amount = resolveRefundAmount(rawAmount, maxCents);
  if (!amount.ok) return { ok: false, status: 400, error: amount.message };

  const paymentIntentId = String(order.stripe_payment_intent_id ?? "").trim();
  const alreadyRefunded = typeof order.refunded_total_cents === "number" && order.refunded_total_cents > 0
    ? Math.trunc(order.refunded_total_cents)
    : 0;

  const stripe = getStripeClient();
  if (!stripe) {
    console.error("Admin refund: STRIPE_SECRET_KEY is not configured.");
    return unavailable();
  }

  let refundStatus: string | null = null;
  try {
    const refund = await stripe.refunds.create(
      { payment_intent: paymentIntentId, amount: amount.amountCents },
      { idempotencyKey: refundIdempotencyKey(order.id, alreadyRefunded, amount.amountCents) }
    );
    refundStatus = typeof refund.status === "string" ? refund.status : null;
  } catch (cause) {
    // The order number and Stripe's own message. Never the intent id,
    // never the key, never the customer - and never any of it to the
    // browser, which gets one generic sentence.
    const message = cause instanceof Error ? cause.message : "unknown";
    console.error(`Admin refund: Stripe refused the refund for ${orderNumber}: ${message}`);
    return { ok: false, status: 502, error: "Die Erstattung konnte bei Stripe nicht ausgelöst werden." };
  }

  // The existing pipeline, unchanged. It re-reads EVERY refund Stripe
  // holds for this payment intent and writes the absolute sum through
  // apply_order_refund_state, so it converges rather than accumulating.
  let syncResult: string;
  let refundedTotalCents: number | null;
  try {
    const outcome = await syncOrderRefundStateFromStripe(stripe, paymentIntentId);
    syncResult = outcome.result;
    refundedTotalCents = outcome.refundedTotalCents;
  } catch (cause) {
    // The money HAS moved. Reporting this as a failed refund would be a
    // lie and would invite the operator to try again. Say what is true:
    // the refund happened, the order has not caught up yet, and the
    // webhook will reconcile it.
    const message = cause instanceof Error ? cause.message : "unknown";
    console.error(`Admin refund: refund succeeded but sync failed for ${orderNumber}: ${message}`);
    return {
      ok: true,
      orderNumber,
      amountCents: amount.amountCents,
      refundStatus,
      refundedTotalCents: null,
      syncResult: "sync_failed",
      emailOutcome: "not-attempted",
    };
  }

  // The same gate the Stripe webhook uses. 'applied' is the only result
  // that means this write moved something; 'refund_pending' and
  // 'unchanged' mail nothing.
  let emailOutcome: "sent" | "already-sent" | "not-eligible" | "failed" | "not-attempted" = "not-attempted";
  if (isNewSettledRefundFact(syncResult)) {
    emailOutcome = await sendRefundConfirmationIfNeeded(order.id);
  }

  return {
    ok: true,
    orderNumber,
    amountCents: amount.amountCents,
    refundStatus,
    refundedTotalCents,
    syncResult,
    emailOutcome,
  };
}
