/**
 * What the authorized cancellation endpoint accepts, and what it refuses.
 *
 * Pure and leaf: no relative imports, no database, no network, no clock,
 * no environment - the same choice lib/shipmentTransitionRules.ts,
 * lib/shipmentConfirmationRules.ts and
 * lib/internalOrderNotificationRetryRules.ts make, so the request
 * validation is unit-testable rather than only reachable through a live
 * route.
 *
 * THE SHAPE OF THE TRUST BOUNDARY. Everything in this file is about one
 * question: which parts of an operator's request are allowed to influence
 * the database at all. The answer here is smaller than it is for a
 * shipment, because a cancellation carries no operator-supplied facts at
 * all. It is one order number, and nothing else. Everything that decides
 * what the cancellation MEANS is computed by the database:
 *
 *   status              set to 'cancelled' by the RPC, never supplied
 *   fulfillment_status  set to 'cancelled' by the RPC, never supplied
 *   cancelled_at        set to now() by the RPC, never supplied
 *   payment_status, refunded_total_cents, refund_updated_at
 *                       never written at all - a cancellation is not a
 *                       refund, and the two stay separate facts
 *   money, tax, snapshots, tracking, email state
 *                       never written at all
 *
 * That is why unknown keys are rejected outright rather than ignored (see
 * validateCancellationRequest). Silently dropping a `cancelled_at`, a
 * `payment_status` or a `refundAmount` the caller sent would leave an
 * operator believing they had set something they had not, and would leave
 * the guarantee resting on "we happen not to read that key" rather than
 * on a refusal.
 *
 * NO REASON FIELD, DELIBERATELY. The audit found no persisted destination
 * for an operator-supplied cancellation reason and no reader for one.
 * Migration 019's cancellation_request_note already holds the customer's
 * own words and is preserved through the cancellation; adding a second,
 * unread free-text field would be inventing a requirement.
 */

/**
 * `GLOA-YYYY-NNNNNN`, exactly as public.generate_order_number builds it.
 *
 * Duplicated from lib/shipmentTransitionRules.ts rather than imported,
 * because this module is a leaf and must stay one - the same reasoning
 * that module gives for duplicating its URL check. The duplication is
 * asserted against the shipment module's copy in the test suite, so the
 * two cannot drift apart unnoticed.
 */
export const ORDER_NUMBER_RE = /^GLOA-\d{4}-\d{6}$/;

/**
 * The only key a request body may contain.
 *
 * One. Not "one required plus some optional" - one, total.
 */
export const ALLOWED_BODY_KEYS = ["orderNumber"] as const;

/** The normalized, server-trusted cancellation input. */
export type CancellationRequest = {
  orderNumber: string;
};

export type CancellationRequestFailure = {
  ok: false;
  /** A stable machine code. Never an infrastructure detail. */
  code: "invalid_body" | "unknown_field" | "invalid_order_number";
};

export type CancellationRequestSuccess = { ok: true; request: CancellationRequest };

export type CancellationRequestResult = CancellationRequestSuccess | CancellationRequestFailure;

function fail(code: CancellationRequestFailure["code"]): CancellationRequestFailure {
  return { ok: false, code };
}

/**
 * Validates and normalizes one parsed request body.
 *
 * Takes an already-parsed value rather than a Request, so it stays a leaf
 * and so malformed JSON is the caller's error to report, not this
 * module's to guess at.
 *
 * REJECTS UNKNOWN KEYS. `status`, `fulfillment_status`, `payment_status`,
 * `cancelled_at`, `refundAmount`, `refund_reason`, `reason`, `userId`,
 * `email`, `recipient`, `to`, `subject`, `html` and everything else are
 * refused by not being on the allow-list, and the refusal is explicit
 * (code "unknown_field") rather than silent. An operator who sends one
 * finds out, and no future edit can accidentally start honouring one.
 *
 * The unknown-key check runs BEFORE the order number is validated, so a
 * body carrying a forbidden field is refused as such even when its order
 * number is also malformed. The stricter refusal is the more useful one.
 */
export function validateCancellationRequest(body: unknown): CancellationRequestResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) return fail("invalid_body");

  const allowed = new Set<string>(ALLOWED_BODY_KEYS);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) return fail("unknown_field");
  }

  const raw = body as Record<string, unknown>;

  if (typeof raw.orderNumber !== "string") return fail("invalid_order_number");
  const orderNumber = raw.orderNumber.trim().toUpperCase();
  if (!ORDER_NUMBER_RE.test(orderNumber)) return fail("invalid_order_number");

  return { ok: true, request: { orderNumber } };
}

/* ══════════════════════════════════════════════════════════════
   WHAT THE DATABASE CAN CONCLUDE
   ══════════════════════════════════════════════════════════════ */

/**
 * The complete result vocabulary of public.cancel_order (migration 029).
 *
 *   cancelled          the transition was applied now, for the first
 *                      time. status, fulfillment_status and cancelled_at
 *                      are durable
 *   already_cancelled  already cancelled - a true no-op, and
 *                      cancelled_at was NOT moved. Zero writes occurred
 *   not_cancellable    already shipped or delivered. Fulfillment cannot
 *                      be un-done, and an order is never moved backwards
 *   not_found          no order with that number
 *
 * There is deliberately no 'conflict' result, unlike the shipment
 * vocabulary. A shipment carries operator-supplied tracking data that a
 * repeat could contradict; a cancellation carries no data at all, so two
 * cancellation requests for the same order can never disagree about
 * anything.
 */
export const CANCELLATION_RESULTS = [
  "cancelled",
  "already_cancelled",
  "not_cancellable",
  "not_found",
] as const;

export type CancellationResult = (typeof CANCELLATION_RESULTS)[number];

/**
 * A result after which the order is durably cancelled.
 *
 * A named type rather than an inline union so that cancellationIsDurable
 * can be a type predicate: a caller that checks it gets the refusal cases
 * narrowed for free. That is what will stop a future edit from reaching
 * the (not yet built) customer cancellation email with a 'not_cancellable'
 * in hand.
 */
export type DurableCancellationResult = "cancelled" | "already_cancelled";

/**
 * The two results after which the order is durably cancelled.
 *
 * 'already_cancelled' is on the list on purpose: repeating an authorized
 * request is the operator's safe retry path, and it must report success
 * rather than an error, because the world is in exactly the state the
 * operator asked for. Nothing about the cancellation is rewritten to get
 * there - the RPC performs no write on that branch at all.
 *
 * 'not_cancellable' and 'not_found' are absent, so a request that was
 * refused can never be mistaken for one that worked.
 */
export function cancellationIsDurable(result: CancellationResult): result is DurableCancellationResult {
  return result === "cancelled" || result === "already_cancelled";
}

/** A result the caller may not treat as durable, and must refuse. */
export type RefusedCancellationResult = Exclude<CancellationResult, DurableCancellationResult>;

/** Whether this result represents a first, newly applied transition. */
export function cancellationWasNewlyApplied(result: CancellationResult): boolean {
  return result === "cancelled";
}

/** The HTTP status one result maps to. */
export function cancellationResultStatus(result: CancellationResult): number {
  switch (result) {
    case "cancelled":
    case "already_cancelled":
      return 200;
    case "not_found":
      return 404;
    case "not_cancellable":
      return 409;
  }
}

/** Whether a value is one of the results the RPC is allowed to return. */
export function isCancellationResult(value: unknown): value is CancellationResult {
  return typeof value === "string" && (CANCELLATION_RESULTS as readonly string[]).includes(value);
}
