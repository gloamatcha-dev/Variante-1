/**
 * What the authorized cancellation-resolution endpoint accepts, what it
 * refuses, and what the database can conclude (Phase 2D-B).
 *
 * Pure and leaf: no relative imports, no database, no network, no clock,
 * no environment - the same choice lib/orderCancellationRules.ts,
 * lib/shipmentTransitionRules.ts and
 * lib/cancellationRequestNotificationRules.ts make, so the request
 * validation and the outcome mapping are unit-testable rather than only
 * reachable through a live route.
 *
 * THE SHAPE OF THE TRUST BOUNDARY. An operator says WHICH order and
 * WHETHER the answer is yes or no. That is the entire input surface.
 * They cannot say what "yes" MEANS - migration 029's cancel_order
 * decides that, and it is the only thing in this system that writes
 * status, fulfillment_status or cancelled_at. Everything else is
 * computed:
 *
 *   cancellation_request_resolution   set by the RPC from the decision
 *   cancellation_request_resolved_at  set to now() by the RPC
 *   status, fulfillment_status,
 *   cancelled_at                      set by cancel_order, or not at all
 *   the email recipient               read from the order's own frozen
 *                                     customer_snapshot at send time
 *   payment_status, refund columns    never written by any of it
 *
 * That is why unknown keys are rejected outright rather than ignored.
 * Silently dropping a `refundAmount`, a `recipient` or a `status` the
 * caller sent would leave an operator believing they had set something
 * they had not, and would leave the guarantee resting on "we happen not
 * to read that key" rather than on a refusal.
 */

/**
 * `GLOA-YYYY-NNNNNN`, exactly as public.generate_order_number builds it.
 *
 * Duplicated from lib/orderCancellationRules.ts rather than imported,
 * because this module is a leaf and must stay one. The duplication is
 * asserted against that module's copy in the test suite, so the two
 * cannot drift apart unnoticed.
 */
export const ORDER_NUMBER_RE = /^GLOA-\d{4}-\d{6}$/;

/**
 * The only two answers an operator may give.
 *
 * A closed vocabulary, not free text and not a lifecycle value. In
 * particular there is no "cancel", no "refund", no "ship" and no
 * "pending": this endpoint answers a customer's question and does
 * nothing else.
 */
export const DECISIONS = ["approve", "decline"] as const;

export type Decision = (typeof DECISIONS)[number];

/** The only keys a request body may contain. */
export const ALLOWED_BODY_KEYS = ["orderNumber", "decision"] as const;

/** The normalized, server-trusted resolution input. */
export type ResolutionRequest = {
  orderNumber: string;
  decision: Decision;
};

export type ResolutionRequestFailure = {
  ok: false;
  /** A stable machine code. Never an infrastructure detail. */
  code: "invalid_body" | "unknown_field" | "invalid_order_number" | "invalid_decision";
};

export type ResolutionRequestSuccess = { ok: true; request: ResolutionRequest };

export type ResolutionRequestResult = ResolutionRequestSuccess | ResolutionRequestFailure;

function fail(code: ResolutionRequestFailure["code"]): ResolutionRequestFailure {
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
 * `cancelled_at`, `resolution`, `resolvedAt`, `refundAmount`, `reason`,
 * `userId`, `customerEmail`, `recipient`, `to`, `subject`, `html` and
 * everything else are refused by not being on the allow-list, and the
 * refusal is explicit rather than silent.
 *
 * The decision is matched case-sensitively against the closed set. An
 * operator sending "APPROVE" gets a clean 400 rather than a silently
 * different outcome, which is the right trade for a two-value field
 * where one value cancels a real customer's order.
 */
export function validateResolutionRequest(body: unknown): ResolutionRequestResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) return fail("invalid_body");

  const allowed = new Set<string>(ALLOWED_BODY_KEYS);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) return fail("unknown_field");
  }

  const raw = body as Record<string, unknown>;

  if (typeof raw.orderNumber !== "string") return fail("invalid_order_number");
  const orderNumber = raw.orderNumber.trim().toUpperCase();
  if (!ORDER_NUMBER_RE.test(orderNumber)) return fail("invalid_order_number");

  if (typeof raw.decision !== "string") return fail("invalid_decision");
  const decision = raw.decision as Decision;
  if (!(DECISIONS as readonly string[]).includes(decision)) return fail("invalid_decision");

  return { ok: true, request: { orderNumber, decision } };
}

/* ══════════════════════════════════════════════════════════════
   WHAT THE DATABASE CAN CONCLUDE
   ══════════════════════════════════════════════════════════════ */

/**
 * The complete result vocabulary of
 * public.resolve_order_cancellation_request (migration 031).
 *
 *   approved                 approved now, and cancel_order applied the
 *                            cancellation in the same transaction
 *   declined                 declined now, lifecycle untouched
 *   already_approved         idempotent repeat. resolved_at NOT moved
 *   already_declined         idempotent repeat. resolved_at NOT moved
 *   conflict                 a DIFFERENT terminal decision already
 *                            stands. Never overwritten
 *   not_cancellable          approve was asked for, but cancel_order
 *                            refused (shipped/delivered). The request is
 *                            left UNRESOLVED
 *   order_already_cancelled  decline was asked for on an already
 *                            cancelled order. Refused rather than
 *                            recording a contradiction
 *   no_request               the order exists, but nobody asked to stop
 *                            it. There is nothing to answer
 *   not_found                no order with that number
 *   invalid_decision         the database's own fail-closed check on the
 *                            decision vocabulary
 */
export const RESOLUTION_RESULTS = [
  "approved",
  "declined",
  "already_approved",
  "already_declined",
  "conflict",
  "not_cancellable",
  "order_already_cancelled",
  "no_request",
  "not_found",
  "invalid_decision",
] as const;

export type ResolutionResult = (typeof RESOLUTION_RESULTS)[number];

/**
 * A result after which the request carries a durable terminal answer.
 *
 * A named type rather than an inline union so that resolutionIsDurable
 * can be a type predicate: a caller that checks it gets the refusal cases
 * narrowed for free. That is what stops a future edit from reaching the
 * customer outcome email with a 'not_cancellable' or a 'conflict' in
 * hand - which would mean mailing a customer about a decision that was
 * never recorded, or contradicting one that was.
 */
export type DurableResolutionResult =
  | "approved"
  | "declined"
  | "already_approved"
  | "already_declined";

/**
 * The four results after which the order genuinely carries the answer
 * the caller asked for, and only after which the customer outcome email
 * may be attempted.
 *
 * The two `already_*` results are on the list on purpose, and that is
 * what makes a repeated authorized call the safe retry path: the world
 * is already in the state the operator asked for, the RPC performed zero
 * writes to get there, and the email sender's own claim then decides
 * whether anything is actually sent. A 'sent' row mails nothing.
 *
 * 'conflict' is deliberately ABSENT even though the order does carry a
 * terminal resolution: it carries the OTHER one. Mailing from a conflict
 * would send the customer an email about a decision nobody made.
 */
export function resolutionIsDurable(result: ResolutionResult): result is DurableResolutionResult {
  return (
    result === "approved" ||
    result === "declined" ||
    result === "already_approved" ||
    result === "already_declined"
  );
}

/** A result the caller may not treat as durable, and must refuse. */
export type RefusedResolutionResult = Exclude<ResolutionResult, DurableResolutionResult>;

/** Whether this result represents a first, newly applied resolution. */
export function resolutionWasNewlyApplied(result: ResolutionResult): boolean {
  return result === "approved" || result === "declined";
}

/**
 * Which terminal answer a durable result represents.
 *
 * Deliberately derived from the RESULT rather than echoed from the
 * caller's request: on an `already_*` result the stored decision is the
 * authority, and it is the stored decision the customer must be emailed
 * about.
 */
export function resolutionOutcome(result: DurableResolutionResult): "approved" | "declined" {
  return result === "approved" || result === "already_approved" ? "approved" : "declined";
}

/**
 * The HTTP status one result maps to.
 *
 * 404 for not_found AND no_request: both mean "there is no customer
 * request here to answer", and the caller is an authorized operator, so
 * there is no enumeration concern to trade against clarity.
 *
 * 409 for every state conflict: a decision that contradicts a standing
 * one, an approval the lifecycle refuses, and a decline of an order that
 * is already cancelled are all "the world is not in a state where this
 * makes sense", not "you sent something malformed".
 */
export function resolutionResultStatus(result: ResolutionResult): number {
  switch (result) {
    case "approved":
    case "declined":
    case "already_approved":
    case "already_declined":
      return 200;
    case "not_found":
    case "no_request":
      return 404;
    case "conflict":
    case "not_cancellable":
    case "order_already_cancelled":
      return 409;
    case "invalid_decision":
      return 400;
  }
}

/** Whether a value is one of the results the RPC is allowed to return. */
export function isResolutionResult(value: unknown): value is ResolutionResult {
  return typeof value === "string" && (RESOLUTION_RESULTS as readonly string[]).includes(value);
}

/* ══════════════════════════════════════════════════════════════
   THE CUSTOMER OUTCOME EMAIL STATE MACHINE
   ══════════════════════════════════════════════════════════════ */

/**
 * The complete vocabulary of migration 031's outcome email status.
 *
 * There is deliberately no 'pending', for the reason migration 030 sets
 * out at length: NULL must keep meaning "this feature did not exist when
 * this happened", so that no sweep can ever mistake a historical order
 * for queued work.
 */
export const OUTCOME_EMAIL_STATUSES = ["sending", "sent", "failed"] as const;

export type OutcomeEmailStatus = (typeof OUTCOME_EMAIL_STATUSES)[number];

/** What the outcome sender reports. It never throws for an ordinary outcome. */
export type OutcomeEmailSendResult =
  /** Delivered to the provider now. */
  | "sent"
  /** Someone else already sent it, or is sending it right now. */
  | "already-sent"
  /** No resolution on this order, no recipient, or no such order. */
  | "not-eligible"
  /** Attempted and failed. The row is 'failed' and a repeat may retry. */
  | "failed";

/**
 * Whether a status may be claimed by a LIVE send - one happening right
 * now, immediately after a resolution has committed.
 *
 * NULL is claimable here, and only here: the decision was made seconds
 * ago by an authorized operator, so "never attempted" means "owed now".
 * 'failed' is claimable, which makes a repeated authorized resolution the
 * interim retry path. 'sending' and 'sent' are never claimable.
 */
export function isOutcomeEmailClaimable(status: string | null | undefined): boolean {
  if (status === null || status === undefined) return true;
  return status === "failed";
}

/**
 * Whether a status may be claimed by a SWEEP - a background job running
 * over rows nobody is currently watching.
 *
 * STRICTLY NARROWER THAN THE LIVE RULE. 'failed' and nothing else. NULL
 * is refused, because a NULL row is either an order that predates this
 * feature or one whose live send is about to happen, and in neither case
 * may a background job mail anyone.
 *
 * No sweep exists (Phase 2D-B deliberately adds no cron). This predicate
 * exists now so the rule is written down and tested before anybody writes
 * the job, rather than being rediscovered afterwards.
 */
export function isOutcomeEmailSweepEligible(status: string | null | undefined): boolean {
  return status === "failed";
}

/** The order fields the outcome-email decision depends on. */
export type OutcomeEmailOrderState = {
  /** Migration 031. NULL means the request is still open. */
  cancellation_request_resolution: string | null;
  /** Migration 031. NULL means this order was never part of the flow. */
  cancellation_outcome_email_status: string | null;
};

/**
 * Whether a live outcome send is owed for this order right now.
 *
 * Both halves are required, and the first is the important one: an order
 * with no terminal resolution has no outcome to report, and must never
 * produce a message. This is the code half of a guarantee the database
 * also enforces - the claim UPDATE repeats
 * `cancellation_request_resolution is not null` in its WHERE clause, so
 * the resolution cannot vanish between this check and the write and still
 * produce an email.
 */
export function isOutcomeEmailOwed(order: OutcomeEmailOrderState): boolean {
  if (!order.cancellation_request_resolution) return false;
  return isOutcomeEmailClaimable(order.cancellation_outcome_email_status);
}
