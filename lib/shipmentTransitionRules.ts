/**
 * What the authorized shipment endpoint accepts, and what it refuses.
 *
 * Pure and leaf: no relative imports, no database, no network, no clock,
 * no environment - the same choice lib/shipmentConfirmationRules.ts and
 * lib/internalOrderNotificationRetryRules.ts make, so the request
 * validation is unit-testable rather than only reachable through a live
 * route.
 *
 * THE SHAPE OF THE TRUST BOUNDARY. Everything in this file is about one
 * question: which parts of an operator's request are allowed to influence
 * the database at all. The answer is deliberately tiny - one order
 * number and three optional tracking strings. Everything that decides
 * what the shipment MEANS is computed by the database:
 *
 *   fulfillment_status  set to 'shipped' by the RPC, never supplied
 *   shipped_at          set to now() by the RPC, never supplied
 *   recipient           read from the order's frozen customer_snapshot
 *   money, tax, snapshots   never written at all
 *
 * That is why unknown keys are rejected outright rather than ignored (see
 * validateShipmentRequest). Silently dropping a `shipped_at` or a
 * `recipient` the caller sent would leave an operator believing they had
 * set something they had not, and would leave the guarantee resting on
 * "we happen not to read that key" rather than on a refusal.
 */

/** `GLOA-YYYY-NNNNNN`, exactly as public.generate_order_number builds it. */
export const ORDER_NUMBER_RE = /^GLOA-\d{4}-\d{6}$/;

/**
 * Server-side length ceilings for the optional tracking fields.
 *
 * Not business rules - technical bounds, so a caller cannot push a
 * megabyte of text into a column and into every email rendered from it.
 * Generous against real values: the longest carrier names are a couple of
 * dozen characters, and a DHL tracking number is 20 digits.
 */
export const MAX_CARRIER_LEN = 100;
export const MAX_TRACKING_NUMBER_LEN = 100;
export const MAX_TRACKING_URL_LEN = 500;

/** The only keys a request body may contain. */
export const ALLOWED_BODY_KEYS = ["orderNumber", "carrier", "trackingNumber", "trackingUrl"] as const;

/** The normalized, server-trusted shipment input. */
export type ShipmentRequest = {
  orderNumber: string;
  carrier: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
};

export type ShipmentRequestFailure = {
  ok: false;
  /** A stable machine code. Never an infrastructure detail. */
  code:
    | "invalid_body"
    | "unknown_field"
    | "invalid_order_number"
    | "invalid_carrier"
    | "invalid_tracking_number"
    | "invalid_tracking_url";
};

export type ShipmentRequestSuccess = { ok: true; request: ShipmentRequest };

export type ShipmentRequestResult = ShipmentRequestSuccess | ShipmentRequestFailure;

function fail(code: ShipmentRequestFailure["code"]): ShipmentRequestFailure {
  return { ok: false, code };
}

/**
 * Trims, and turns "nothing meaningful" into exactly one representation.
 *
 * A blank string, a whitespace-only string, null and an absent key all
 * become NULL. "No carrier" must have one representation, not five, or
 * the idempotent-repeat comparison in the RPC would treat "" and NULL as
 * a conflict.
 */
function normalizeOptional(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return undefined; // signals a type error
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Whether a tracking URL is a genuinely safe, absolute http(s) link.
 *
 * The same rule as sanitizeTrackingUrl in lib/orderStatus.ts and as
 * migration 019's orders_tracking_url_scheme_check, applied at the
 * earliest possible point so a bad value is refused with a clear 400
 * rather than surfacing as a constraint violation from the database.
 * Three independent guards on one value, deliberately: this one, the
 * database CHECK, and the render-time sanitizer before it reaches an
 * anchor href.
 *
 * Duplicated rather than imported because this module is a leaf and must
 * stay one. The duplication is asserted against the real sanitizer in the
 * test suite, so the two cannot drift apart unnoticed.
 */
function isSafeAbsoluteHttpUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  // "https:///foo" parses but points nowhere.
  if (!parsed.hostname) return false;
  // A stored URL must not contain whitespace - the database CHECK
  // ([^[:space:]]+) refuses it, so refusing it here keeps the two in step.
  return !/\s/.test(value);
}

/**
 * Validates and normalizes one parsed request body.
 *
 * Takes an already-parsed value rather than a Request, so it stays a leaf
 * and so malformed JSON is the caller's error to report, not this
 * module's to guess at.
 *
 * REJECTS UNKNOWN KEYS. `shipped_at`, `fulfillment_status`, `recipient`,
 * `to`, `subject`, `html`, `status`, `payment_status` and everything else
 * are refused by not being on the allow-list, and the refusal is explicit
 * (code "unknown_field") rather than silent. An operator who sends one
 * finds out, and no future edit can accidentally start honouring one.
 */
export function validateShipmentRequest(body: unknown): ShipmentRequestResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) return fail("invalid_body");

  const allowed = new Set<string>(ALLOWED_BODY_KEYS);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) return fail("unknown_field");
  }

  const raw = body as Record<string, unknown>;

  if (typeof raw.orderNumber !== "string") return fail("invalid_order_number");
  const orderNumber = raw.orderNumber.trim().toUpperCase();
  if (!ORDER_NUMBER_RE.test(orderNumber)) return fail("invalid_order_number");

  const carrier = normalizeOptional(raw.carrier);
  if (carrier === undefined) return fail("invalid_carrier");
  if (carrier !== null && carrier.length > MAX_CARRIER_LEN) return fail("invalid_carrier");

  const trackingNumber = normalizeOptional(raw.trackingNumber);
  if (trackingNumber === undefined) return fail("invalid_tracking_number");
  if (trackingNumber !== null && trackingNumber.length > MAX_TRACKING_NUMBER_LEN) {
    return fail("invalid_tracking_number");
  }

  const trackingUrl = normalizeOptional(raw.trackingUrl);
  if (trackingUrl === undefined) return fail("invalid_tracking_url");
  if (trackingUrl !== null) {
    if (trackingUrl.length > MAX_TRACKING_URL_LEN) return fail("invalid_tracking_url");
    if (!isSafeAbsoluteHttpUrl(trackingUrl)) return fail("invalid_tracking_url");
  }

  return { ok: true, request: { orderNumber, carrier, trackingNumber, trackingUrl } };
}

/* ══════════════════════════════════════════════════════════════
   WHAT THE DATABASE CAN CONCLUDE
   ══════════════════════════════════════════════════════════════ */

/**
 * The complete result vocabulary of public.mark_order_shipped.
 *
 *   shipped          the transition was applied now, for the first time
 *   already_shipped  already shipped with identical data - a no-op, and
 *                    shipped_at was NOT moved
 *   conflict         already shipped with DIFFERENT tracking data. Never
 *                    silently overwritten; this task does not edit
 *                    shipment data
 *   already_advanced already 'delivered'. Never moved backwards
 *   not_shippable    cancelled, or not in a payment state that may ship
 *   not_found        no order with that number
 */
export const SHIPMENT_RESULTS = [
  "shipped",
  "already_shipped",
  "conflict",
  "already_advanced",
  "not_shippable",
  "not_found",
] as const;

export type ShipmentResult = (typeof SHIPMENT_RESULTS)[number];

/**
 * A result after which the order is durably shipped.
 *
 * A named type rather than an inline union so that shipmentIsDurable can
 * be a type predicate: a caller that checks it gets the refusal cases
 * narrowed for free, which is what stops a future edit from reaching the
 * email path with a 'conflict' in hand.
 */
export type DurableShipmentResult = "shipped" | "already_shipped";

/**
 * The two results after which the order is durably shipped, and only
 * after which the customer confirmation may be attempted.
 *
 * 'already_shipped' is on the list on purpose, and it is what makes the
 * endpoint a safe manual retry path: repeating an identical authorized
 * request for an order whose email failed re-enters the sender, whose own
 * 'failed' -> 'sending' claim and deterministic Resend key decide whether
 * anything is actually sent. Nothing about the shipment is rewritten to
 * get there.
 *
 * 'conflict', 'already_advanced', 'not_shippable' and 'not_found' are all
 * absent, so a request that changed nothing and a request that was
 * refused can never reach a customer's inbox.
 */
export function shipmentIsDurable(result: ShipmentResult): result is DurableShipmentResult {
  return result === "shipped" || result === "already_shipped";
}

/** A result the caller may not treat as durable, and must refuse. */
export type RefusedShipmentResult = Exclude<ShipmentResult, DurableShipmentResult>;

/** Whether this result represents a first, newly applied transition. */
export function shipmentWasNewlyApplied(result: ShipmentResult): boolean {
  return result === "shipped";
}

/** The HTTP status one result maps to. */
export function shipmentResultStatus(result: ShipmentResult): number {
  switch (result) {
    case "shipped":
    case "already_shipped":
      return 200;
    case "not_found":
      return 404;
    case "conflict":
    case "already_advanced":
    case "not_shippable":
      return 409;
  }
}

/** Whether a value is one of the results the RPC is allowed to return. */
export function isShipmentResult(value: unknown): value is ShipmentResult {
  return typeof value === "string" && (SHIPMENT_RESULTS as readonly string[]).includes(value);
}
