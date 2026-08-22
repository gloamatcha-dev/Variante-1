/**
 * Customer-facing order lifecycle logic (Task 26A).
 *
 * Pure and leaf: no relative imports, no DB, no network, no
 * import.meta.env - so it is directly unit-testable the same way
 * lib/shipping.ts and lib/email/orderConfirmation.ts are.
 *
 * This module deliberately adds no new persisted status column. The
 * orders table already carries status / payment_status /
 * fulfillment_status (migration 004), and duplicating that into a fourth
 * column would just create a fourth thing that can disagree. Instead
 * this derives what the customer is actually shown from the columns that
 * already exist, in one place, so the account list, the order detail
 * page and the shipment email can never drift apart.
 *
 * Two rules run through everything here:
 *   1. Nothing is inferred that the data does not support. "Zugestellt"
 *      appears only when fulfillment_status is literally 'delivered' -
 *      never from elapsed time since shipping. A carrier is never
 *      guessed from a tracking number's shape. A refund amount is never
 *      assumed to be the order total.
 *   2. Nothing internal is exposed. This module has no access to order
 *      ids, checkout attempt ids, Stripe ids or webhook ids - the input
 *      type does not carry them.
 */

/** The persisted order fields the customer-facing lifecycle depends on. */
export type OrderLifecycleFields = {
  status: string;
  payment_status: string;
  fulfillment_status: string;
  total_gross_cents: number;
  refunded_total_cents: number | null;
  shipping_carrier: string | null;
  tracking_number: string | null;
  tracking_url: string | null;
  shipped_at: string | null;
  cancellation_requested_at: string | null;
};

/* ── Tracking ─────────────────────────────────────────────────── */

/**
 * Returns the URL only if it is a genuinely safe, absolute http(s) link;
 * null for anything else. Rejects javascript:, data:, vbscript:, file:,
 * mailto:, protocol-relative and relative URLs, and anything that does
 * not parse. The database has an equivalent CHECK constraint (migration
 * 019); this is the render-time half of the same guarantee, so a row
 * written before that constraint existed still cannot produce a
 * dangerous href.
 */
export function sanitizeTrackingUrl(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw) return null;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  // A URL like "https:///foo" parses but points nowhere.
  if (!parsed.hostname) return null;

  return parsed.toString();
}

export type TrackingView = {
  /** Carrier name, or null when genuinely unknown - never guessed. */
  carrier: string | null;
  trackingNumber: string | null;
  /** Safe absolute http(s) URL, or null - never fabricated from a carrier. */
  url: string | null;
  shippedAt: string | null;
};

/**
 * Tracking information to display, or null when there is nothing real to
 * show. A tracking number with no URL is a valid, common case: the
 * number is shown on its own rather than wrapped in an invented carrier
 * link. A URL with no number is equally valid.
 */
export function getTrackingView(order: OrderLifecycleFields): TrackingView | null {
  const carrier = nonBlank(order.shipping_carrier);
  const trackingNumber = nonBlank(order.tracking_number);
  const url = sanitizeTrackingUrl(order.tracking_url);
  const shippedAt = nonBlank(order.shipped_at);

  if (!carrier && !trackingNumber && !url && !shippedAt) return null;
  return { carrier, trackingNumber, url, shippedAt };
}

function nonBlank(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/* ── Refunds ──────────────────────────────────────────────────── */

export type RefundView =
  /** No refund has been observed for this order. */
  | { kind: "none" }
  /** Stripe reports a refund that has not settled yet. */
  | { kind: "pending" }
  /** Part of the order was refunded; amountCents is the real amount. */
  | { kind: "partial"; amountCents: number }
  /** The full order total was refunded. */
  | { kind: "full"; amountCents: number }
  /**
   * The order is flagged refunded/partially refunded but no amount was
   * ever recorded (e.g. an order refunded before migration 019). The UI
   * must say that a refund happened without inventing a number.
   */
  | { kind: "unknown_amount"; partial: boolean };

/**
 * Derives what to tell the customer about money coming back. Never
 * assumes refund = order total: a partially_refunded order with no
 * recorded amount reports "unknown_amount", not the order total.
 */
export function getRefundView(order: OrderLifecycleFields): RefundView {
  const amount = order.refunded_total_cents;
  const hasAmount = typeof amount === "number" && Number.isFinite(amount) && amount > 0;

  if (order.payment_status === "refund_pending") return { kind: "pending" };

  if (order.payment_status === "refunded") {
    if (!hasAmount) return { kind: "unknown_amount", partial: false };
    return amount >= order.total_gross_cents
      ? { kind: "full", amountCents: amount }
      : { kind: "partial", amountCents: amount };
  }

  if (order.payment_status === "partially_refunded") {
    if (!hasAmount) return { kind: "unknown_amount", partial: true };
    return amount >= order.total_gross_cents
      ? { kind: "full", amountCents: amount }
      : { kind: "partial", amountCents: amount };
  }

  // A recorded amount on an otherwise-paid order still deserves to be
  // shown - the payment_status may simply not have caught up yet.
  if (hasAmount) {
    return amount >= order.total_gross_cents
      ? { kind: "full", amountCents: amount }
      : { kind: "partial", amountCents: amount };
  }

  return { kind: "none" };
}

/* ── Status labels ────────────────────────────────────────────── */

const CANCELLED_VALUES = ["cancelled"];

function isCancelled(order: OrderLifecycleFields): boolean {
  return (
    CANCELLED_VALUES.includes(order.status) ||
    CANCELLED_VALUES.includes(order.fulfillment_status)
  );
}

function isShipped(order: OrderLifecycleFields): boolean {
  return (
    order.fulfillment_status === "shipped" ||
    order.fulfillment_status === "delivered" ||
    order.status === "shipped" ||
    order.status === "delivered"
  );
}

/** Only ever true from an explicit persisted signal, never from time. */
function isDelivered(order: OrderLifecycleFields): boolean {
  return order.fulfillment_status === "delivered" || order.status === "delivered";
}

function isPaid(order: OrderLifecycleFields): boolean {
  return ["paid", "refund_pending", "partially_refunded", "refunded"].includes(order.payment_status);
}

/**
 * The single short label for an order, for the account order list and
 * the top of the order detail page. Customer vocabulary only - no
 * fulfillment_status, no payment_intent, no state-machine wording.
 */
export function getPrimaryStatusLabel(order: OrderLifecycleFields): string {
  if (isCancelled(order)) return "Storniert";

  const refund = getRefundView(order);
  if (refund.kind === "full") return "Erstattet";
  if (refund.kind === "partial") return "Teilweise erstattet";
  if (refund.kind === "unknown_amount") return refund.partial ? "Teilweise erstattet" : "Erstattet";
  if (refund.kind === "pending") return "Erstattung läuft";

  if (isDelivered(order)) return "Zugestellt";
  if (isShipped(order)) return "Versendet";

  if (isPaid(order)) {
    return order.fulfillment_status === "processing" ? "In Vorbereitung" : "Bestätigt";
  }

  if (order.payment_status === "failed") return "Zahlung fehlgeschlagen";
  return "Zahlung ausstehend";
}

/**
 * The payment line on the order detail page. Always a real German
 * phrase - a raw column value such as "partially_refunded" must never
 * reach the customer, so an unrecognised value falls back to a neutral
 * wording rather than being printed through.
 */
export function getPaymentStatusLabel(order: OrderLifecycleFields): string {
  switch (order.payment_status) {
    case "paid":
      return "Bezahlt";
    case "refund_pending":
      return "Erstattung in Bearbeitung";
    case "partially_refunded":
      return "Teilweise erstattet";
    case "refunded":
      return "Erstattet";
    case "failed":
      return "Fehlgeschlagen";
    case "pending":
      return "Ausstehend";
    default:
      return "Ausstehend";
  }
}

/**
 * One supporting sentence under the headline on the order detail page.
 * Returns null when the label already says everything.
 */
export function getStatusDetailText(order: OrderLifecycleFields): string | null {
  if (isCancelled(order)) return "Diese Bestellung wurde storniert.";

  const refund = getRefundView(order);
  if (refund.kind === "pending") return "Deine Erstattung ist angestoßen. Die Gutschrift dauert je nach Bank ein paar Tage.";
  if (refund.kind === "full" || refund.kind === "partial" || refund.kind === "unknown_amount") {
    return "Die Gutschrift geht auf dem Weg zurück, den du bezahlt hast.";
  }

  if (isDelivered(order)) return "Deine Bestellung ist zugestellt.";
  if (isShipped(order)) return "Deine Bestellung ist unterwegs zu dir.";

  if (isPaid(order)) {
    if (order.cancellation_requested_at) return "Wir prüfen, ob die Bestellung noch gestoppt werden kann.";
    return "Wir bereiten deine Bestellung vor und melden uns, sobald sie unterwegs ist.";
  }

  if (order.payment_status === "failed") return "Die Zahlung konnte nicht abgeschlossen werden.";
  return "Wir warten noch auf die Bestätigung deiner Zahlung.";
}

/* ── Lifecycle steps ──────────────────────────────────────────── */

export type LifecycleStepState = "done" | "current" | "upcoming";

export type LifecycleStep = {
  key: "received" | "paid" | "preparing" | "shipped" | "delivered";
  label: string;
  state: LifecycleStepState;
};

/**
 * The progress of an order as a short list of steps.
 *
 * "Zugestellt" is included only when the order genuinely carries a
 * delivered signal - we have no carrier integration, so for every other
 * order the honest last step is "Versendet" and no phantom final step is
 * dangled in front of the customer.
 *
 * Returns an empty list for a cancelled order: a progress track for
 * something that has stopped is misleading.
 */
export function getLifecycleSteps(order: OrderLifecycleFields): LifecycleStep[] {
  if (isCancelled(order)) return [];

  const paid = isPaid(order);
  const shipped = isShipped(order);
  const delivered = isDelivered(order);

  const steps: LifecycleStep[] = [
    { key: "received", label: "Bestellung eingegangen", state: "done" },
    { key: "paid", label: "Zahlung bestätigt", state: paid ? "done" : "current" },
    {
      key: "preparing",
      label: "Wir bereiten deine Bestellung vor",
      state: shipped ? "done" : paid ? "current" : "upcoming",
    },
    {
      key: "shipped",
      label: "Versendet",
      state: delivered ? "done" : shipped ? "current" : "upcoming",
    },
  ];

  if (delivered) {
    steps.push({ key: "delivered", label: "Zugestellt", state: "current" });
  }

  return steps;
}

/* ── Cancellation ─────────────────────────────────────────────── */

export type CancellationView =
  /** A cancellation request can be submitted right now. */
  | { state: "eligible" }
  /** Already asked - we are checking, but nothing is cancelled yet. */
  | { state: "requested" }
  /** Too late to stop it; point at the statutory withdrawal route. */
  | { state: "too_late" }
  /** Already cancelled, or never in a state where this applies. */
  | { state: "unavailable" };

/**
 * Whether a customer may ask us to stop this order.
 *
 * Mirrors the server-side rules in request_order_cancellation (migration
 * 019) exactly. This is the display half only - the database is the
 * authority, and this function being wrong could at worst show a button
 * that then returns a clean "not eligible", never actually cancel
 * anything.
 */
export function getCancellationView(order: OrderLifecycleFields): CancellationView {
  if (isCancelled(order)) return { state: "unavailable" };

  // A refunded order is past the point where "stop the parcel" is the
  // right conversation.
  if (["refunded", "partially_refunded"].includes(order.payment_status)) return { state: "unavailable" };

  // Once it has shipped, fulfillment cannot be reversed. The honest
  // answer is the Widerrufsrecht, not a cancellation button.
  if (isShipped(order)) return { state: "too_late" };

  if (!isPaid(order)) return { state: "unavailable" };

  if (order.cancellation_requested_at) return { state: "requested" };

  return { state: "eligible" };
}

/** Convenience predicate for rendering the request button. */
export function canRequestCancellation(order: OrderLifecycleFields): boolean {
  return getCancellationView(order).state === "eligible";
}
