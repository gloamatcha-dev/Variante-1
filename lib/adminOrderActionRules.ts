/**
 * WHICH ORDER ACTIONS ARE PERMITTED, AND WHY NOT.
 *
 * Zero imports, no Supabase, no Stripe, no clock. The same shape as
 * lib/adminOrdersQuery.ts and for the same reason: node imports this file
 * directly, so the test suite checks the ACTUAL rules rather than
 * grepping a route for strings.
 *
 * ── THIS FILE IS NOT THE GUARD ────────────────────────────────
 *
 * Every rule below is a RESTATEMENT of a rule that already lives in a
 * database function, and the database is the authority:
 *
 *   mark_order_shipped                 migration 028, tightened by 032
 *   cancel_order                       migration 029
 *   resolve_order_cancellation_request migration 031
 *   apply_order_refund_state           migration 019
 *
 * Each of those takes `select ... for update` on the order row and
 * decides inside the same transaction as its write, so two concurrent
 * operators serialize. A check here cannot do that - it reads, decides,
 * and only then calls, leaving a window. So this file exists for ONE
 * purpose: to stop the admin screen offering a button that the server
 * would refuse. It must never become the reason an action is safe.
 *
 * When the two disagree, the database wins and the operator sees the
 * refusal. That is the correct outcome and not a bug in this file.
 *
 * ── THE PAYMENT VOCABULARY IS MIGRATION 019'S ─────────────────
 *
 * orders.payment_status was defined by migration 004 and REDEFINED by
 * migration 019, which added 'refund_pending'. 019 is the constraint on
 * the live table. Reading 004 alone - as the first version of the admin
 * list did - loses exactly the value a refund in flight produces, which
 * is the one this package creates.
 */

/** orders.status - migration 004's CHECK, in lifecycle order. */
export const ACTION_ORDER_STATUSES = [
  "pending", "confirmed", "processing", "shipped", "delivered", "cancelled", "refunded",
] as const;

/**
 * orders.payment_status - MIGRATION 019's CHECK, which supersedes 004's.
 *
 * 'refund_pending' is the addition, and it is load-bearing here: a refund
 * that Stripe has accepted but not settled leaves the order in it, and
 * both the shipment guard and the refund guard below treat it as "wait".
 */
export const ACTION_PAYMENT_STATUSES = [
  "pending", "paid", "failed", "refund_pending", "partially_refunded", "refunded",
] as const;

/** orders.fulfillment_status - migration 004's CHECK. */
export const ACTION_FULFILLMENT_STATUSES = [
  "unfulfilled", "processing", "shipped", "delivered", "cancelled",
] as const;

/** The payment states migration 028 lets an order ship in. */
export const SHIPPABLE_PAYMENT_STATUSES = ["paid", "partially_refunded"] as const;

/** The fulfillment states migration 029 lets an order be cancelled in. */
export const CANCELLABLE_FULFILLMENT_STATUSES = ["unfulfilled", "processing"] as const;

/** The payment states a refund may be started from. */
export const REFUNDABLE_PAYMENT_STATUSES = ["paid", "partially_refunded"] as const;

export const ADMIN_ORDER_ACTIONS = ["ship", "cancel", "refund", "resolve-request"] as const;
export type AdminOrderAction = (typeof ADMIN_ORDER_ACTIONS)[number];

/**
 * The two answers a cancellation request may be given.
 *
 * TWO VOCABULARIES, AND THEY ARE NOT THE SAME WORDS. The REQUEST takes
 * an imperative - "approve" / "decline", the closed set
 * lib/cancellationResolutionRules.ts matches case-sensitively - while
 * the RESULT and the stored orders.cancellation_request_resolution read
 * "approved" / "declined". Sending the past tense is a 400, which is
 * exactly how the mismatch was found.
 *
 * Both are listed here so the screen cannot pick the wrong one again,
 * and a test reads the real allow-list out of the validator's source
 * rather than trusting this copy.
 */
export const RESOLUTION_DECISIONS = ["approve", "decline"] as const;
export type ResolutionDecision = (typeof RESOLUTION_DECISIONS)[number];

/** What the RPC reports back, and what the order column stores. */
export const RESOLUTION_OUTCOMES = ["approved", "declined"] as const;
export type ResolutionOutcome = (typeof RESOLUTION_OUTCOMES)[number];

/**
 * The order facts every rule below reads.
 *
 * Deliberately a structural type over the columns the admin detail route
 * already selects, so nothing new has to be fetched to decide what to
 * offer - and so no rule can quietly start depending on a column the
 * screen does not have.
 */
export type ActionableOrder = {
  status?: string | null;
  payment_status?: string | null;
  fulfillment_status?: string | null;
  cancelled_at?: string | null;
  cancellation_requested_at?: string | null;
  cancellation_request_resolution?: string | null;
  total_gross_cents?: number | null;
  refunded_total_cents?: number | null;
  stripe_payment_intent_id?: string | null;
  stripe_checkout_session_id?: string | null;
  currency?: string | null;
};

export type ActionVerdict =
  | { allowed: true }
  | { allowed: false; reason: string };

const no = (reason: string): ActionVerdict => ({ allowed: false, reason });
const YES: ActionVerdict = { allowed: true };

/** Whether a cancellation request is open and unanswered (migration 032). */
export function hasOpenCancellationRequest(order: ActionableOrder): boolean {
  return Boolean(order.cancellation_requested_at) && !order.cancellation_request_resolution;
}

/**
 * May this order be marked shipped?
 *
 * Mirrors migration 028's guards in the order it applies them, plus the
 * open-request guard migration 032 added.
 */
export function canShip(order: ActionableOrder): ActionVerdict {
  if (order.status === "delivered" || order.fulfillment_status === "delivered") {
    return no("Diese Bestellung ist bereits als geliefert erfasst.");
  }
  if (order.fulfillment_status === "shipped") {
    return no("Diese Bestellung ist bereits als versendet erfasst.");
  }
  if (order.fulfillment_status === "cancelled" || order.status === "cancelled" || order.status === "refunded") {
    return no("Eine stornierte oder vollständig erstattete Bestellung kann nicht versendet werden.");
  }
  if (!(SHIPPABLE_PAYMENT_STATUSES as readonly string[]).includes(order.payment_status ?? "")) {
    // Named separately because 'refund_pending' is a wait, not a refusal:
    // apply_order_refund_state writes 'paid' back if the refund fails or
    // is cancelled, and the order then ships normally.
    if (order.payment_status === "refund_pending") {
      return no("Zu dieser Bestellung läuft eine Erstattung. Bitte deren Ergebnis abwarten.");
    }
    return no("Diese Bestellung ist nicht in einem Zahlungszustand, aus dem versendet werden darf.");
  }
  if (hasOpenCancellationRequest(order)) {
    return no("Zu dieser Bestellung liegt eine offene Stornierungsanfrage vor. Bitte zuerst entscheiden.");
  }
  return YES;
}

/** May this order be cancelled? Mirrors migration 029's guards. */
export function canCancel(order: ActionableOrder): ActionVerdict {
  if (order.status === "cancelled" || order.fulfillment_status === "cancelled") {
    return no("Diese Bestellung ist bereits storniert.");
  }
  if (
    order.status === "shipped" || order.status === "delivered" ||
    order.fulfillment_status === "shipped" || order.fulfillment_status === "delivered"
  ) {
    return no("Eine versendete oder gelieferte Bestellung kann nicht mehr storniert werden.");
  }
  if (!(CANCELLABLE_FULFILLMENT_STATUSES as readonly string[]).includes(order.fulfillment_status ?? "")) {
    return no("Diese Bestellung ist nicht in einem Zustand, aus dem storniert werden darf.");
  }
  return YES;
}

/** Is there an open cancellation request to answer? Migration 031. */
export function canResolveRequest(order: ActionableOrder): ActionVerdict {
  if (!order.cancellation_requested_at) return no("Zu dieser Bestellung liegt keine Stornierungsanfrage vor.");
  if (order.cancellation_request_resolution) return no("Diese Stornierungsanfrage ist bereits entschieden.");
  return YES;
}

/**
 * The most that may still be refunded, in integer cents.
 *
 * The same arithmetic migration 019's apply_order_refund_state enforces:
 * a cumulative total may never exceed total_gross_cents, and the table's
 * own CHECK repeats it. Returns 0 rather than a negative number when the
 * two columns are already equal or the row is unusable - "nothing left"
 * is the honest answer to every one of those cases.
 */
export function maxRefundableCents(order: ActionableOrder): number {
  const total = order.total_gross_cents;
  const refunded = order.refunded_total_cents;
  if (typeof total !== "number" || !Number.isFinite(total) || total <= 0) return 0;
  const already = typeof refunded === "number" && Number.isFinite(refunded) && refunded > 0 ? refunded : 0;
  return Math.max(0, Math.trunc(total) - Math.trunc(already));
}

/**
 * May money be sent back for this order?
 *
 * 'refund_pending' is refused deliberately. The refund pipeline is
 * absolute - it re-reads every refund Stripe holds for the payment intent
 * and writes the sum - so a second refund started while the first is in
 * flight would settle as a LARGER total rather than being rejected. That
 * is real money, so the rule is wait, not race.
 */
export function canRefund(order: ActionableOrder): ActionVerdict {
  if (!(REFUNDABLE_PAYMENT_STATUSES as readonly string[]).includes(order.payment_status ?? "")) {
    if (order.payment_status === "refunded") return no("Diese Bestellung ist bereits vollständig erstattet.");
    if (order.payment_status === "refund_pending") {
      return no("Zu dieser Bestellung läuft bereits eine Erstattung. Bitte deren Ergebnis abwarten.");
    }
    return no("Diese Bestellung wurde nicht bezahlt und kann nicht erstattet werden.");
  }
  const intent = typeof order.stripe_payment_intent_id === "string" ? order.stripe_payment_intent_id.trim() : "";
  if (!intent) {
    // Honest and specific: the money may well exist, the reference to it
    // does not. Without a payment intent there is nothing to refund
    // AGAINST, and inventing one is out of the question.
    //
    // The sentence has to be useful, not just true. "Do it in Stripe"
    // alone sends the operator to a dashboard with no idea what to
    // search for, so it names what they DO have: the checkout session
    // when the order carries one, and otherwise the order number and
    // date, which is what a Stripe payment search actually takes.
    const session = typeof order.stripe_checkout_session_id === "string"
      ? order.stripe_checkout_session_id.trim()
      : "";
    return no(
      session
        ? `Zu dieser Bestellung ist keine Stripe-Zahlungsreferenz gespeichert. Eine Erstattung ist nur direkt in Stripe möglich – die Zahlung lässt sich dort über die Checkout-Session ${session} finden.`
        : "Zu dieser Bestellung ist keine Stripe-Zahlungsreferenz gespeichert. Eine Erstattung ist nur direkt in Stripe möglich – suche die Zahlung dort über Bestelldatum und Betrag."
    );
  }
  if (maxRefundableCents(order) <= 0) return no("Es ist kein erstattbarer Betrag mehr offen.");
  return YES;
}

/* ══════════════════════════════════════════════════════════════
   WHAT A REFUND REQUEST MAY SAY

   The client sends an order id and, at most, an amount. It never
   sends the payment intent, the maximum, the currency, the paid
   total or the already-refunded total - the server reads all five
   from the order it loaded itself. Everything below validates the
   ONE number the client is allowed to choose.
   ══════════════════════════════════════════════════════════════ */

export type RefundAmountFailure = {
  ok: false;
  /** Machine code, for a 400 that names the field and never the value. */
  code: "invalid_amount" | "not_an_integer" | "too_small" | "too_large";
  message: string;
};
export type RefundAmountSuccess = { ok: true; amountCents: number; full: boolean };
export type RefundAmountResult = RefundAmountSuccess | RefundAmountFailure;

/**
 * Resolves the amount to refund against the server's own maximum.
 *
 * `null`/`undefined` means "everything still refundable" - the common
 * case, and the one that cannot be got wrong by arithmetic in a browser.
 * A number must be integer cents. Money is never a float here: 0.1 + 0.2
 * is not 0.3, and this value becomes a Stripe refund.
 */
export function resolveRefundAmount(raw: unknown, maxCents: number): RefundAmountResult {
  if (maxCents <= 0) {
    return { ok: false, code: "too_large", message: "Es ist kein erstattbarer Betrag mehr offen." };
  }
  if (raw === undefined || raw === null) {
    return { ok: true, amountCents: maxCents, full: true };
  }
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return { ok: false, code: "invalid_amount", message: "Ungültiger Betrag." };
  }
  if (!Number.isInteger(raw)) {
    return { ok: false, code: "not_an_integer", message: "Der Betrag muss in vollen Cent angegeben werden." };
  }
  if (raw <= 0) {
    return { ok: false, code: "too_small", message: "Der Betrag muss größer als 0 sein." };
  }
  if (raw > maxCents) {
    return { ok: false, code: "too_large", message: "Der Betrag übersteigt den noch erstattbaren Betrag." };
  }
  return { ok: true, amountCents: raw, full: raw === maxCents };
}

/**
 * The Stripe idempotency key for one INTENDED refund operation.
 *
 * Stable across a double click, a lost response and a network retry,
 * because all three re-send the same intent against the same already-
 * refunded total. Different for a deliberate second refund later,
 * because `alreadyRefundedCents` has moved by then.
 *
 * This is the protection that matters. A disabled button protects
 * nothing: it is gone the moment the tab is reloaded, and it was never
 * there for a retry that the browser made by itself.
 */
export function refundIdempotencyKey(
  orderId: string,
  alreadyRefundedCents: number,
  amountCents: number
): string {
  return `gloa/refund/${orderId}/${alreadyRefundedCents}/${amountCents}`;
}

/* ══════════════════════════════════════════════════════════════
   WHAT THE OPERATOR IS SHOWN
   ══════════════════════════════════════════════════════════════ */

/**
 * The four email state machines an order carries, as the admin reads
 * them. Every column here exists on public.orders; none is invented.
 *
 *   confirmation          migration 011 / the checkout webhook
 *   shipment              migration 028 + lib/shipmentConfirmationEmail
 *   refund                migration 033 + lib/refundConfirmationEmail
 *   cancellation outcome  migration 031 + lib/cancellationOutcomeEmail
 */
export const ORDER_EMAIL_STATE_COLUMNS = [
  "confirmation_email_status", "confirmation_email_sent_at",
  "shipment_email_status", "shipment_email_sent_at",
  "refund_email_status", "refund_email_sent_at", "refund_email_notified_total_cents",
  "cancellation_outcome_email_status", "cancellation_outcome_email_sent_at",
  // Migration 049. A DIRECT cancellation and the answer to a REQUESTED
  // one are different events, so they get different columns - and the
  // operator can see which of the two a customer actually received.
  "cancellation_confirmation_email_status", "cancellation_confirmation_email_sent_at",
] as const;

/**
 * The five customer emails an order can carry, as the admin lists them.
 *
 * FIVE, NOT FOUR, AND THE LAST TWO ARE NOT THE SAME MESSAGE. One
 * confirms a cancellation GLOA decided on; the other answers a
 * cancellation the customer asked for. Collapsing them into one row
 * would hide which one went out, which is exactly what an operator
 * fielding a reply needs to know.
 */
export const ORDER_EMAIL_KINDS = [
  { key: "confirmation", label: "Bestellbestätigung", column: "confirmation_email_status" },
  { key: "shipment", label: "Versandbestätigung", column: "shipment_email_status" },
  { key: "refund", label: "Erstattungsbestätigung", column: "refund_email_status" },
  { key: "cancellation", label: "Stornierungsbestätigung", column: "cancellation_confirmation_email_status" },
  { key: "outcome", label: "Antwort auf Stornierungsanfrage", column: "cancellation_outcome_email_status" },
] as const;

/** The status words those columns actually hold. */
export const EMAIL_STATUS_LABEL: Readonly<Record<string, string>> = Object.freeze({
  pending: "Ausstehend",
  sending: "Wird gesendet",
  sent: "Gesendet",
  failed: "Fehlgeschlagen",
  skipped: "Übersprungen",
});

/** A dash for NULL - "never attempted" is not a status word. */
export function emailStatusLabel(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "—";
  return EMAIL_STATUS_LABEL[value] ?? value;
}

/**
 * Whether a cancelled order still owes the customer money.
 *
 * The single most important sentence this screen says. cancel_order
 * writes no money column and starts no refund - migration 029 is
 * explicit that it "creates no refund, and must never learn to" - so a
 * cancelled order routinely still reads payment_status = 'paid'. Showing
 * that as "storniert und erstattet" would assert a refund nobody
 * performed.
 */
export function cancellationRefundState(order: ActionableOrder): {
  cancelled: boolean;
  refundedCents: number;
  outstandingCents: number;
  label: string;
} {
  const cancelled = Boolean(order.cancelled_at) ||
    order.status === "cancelled" || order.fulfillment_status === "cancelled";
  const refunded = typeof order.refunded_total_cents === "number" && order.refunded_total_cents > 0
    ? Math.trunc(order.refunded_total_cents)
    : 0;
  const outstanding = maxRefundableCents(order);

  let label: string;
  if (!cancelled) label = "—";
  else if (refunded <= 0) label = "Erstattung: noch nicht erfolgt";
  else if (outstanding > 0) label = "Erstattung: teilweise erfolgt";
  else label = "Erstattung: vollständig erfolgt";

  return { cancelled, refundedCents: refunded, outstandingCents: outstanding, label };
}

/**
 * A typed euro amount as integer cents, or null.
 *
 * The operator types "39,98"; Stripe takes 3998. The conversion is done
 * by string surgery rather than `Math.round(Number(x) * 100)` because
 * that multiplication is a float operation on money: 19.99 * 100 is
 * 1998.9999999999998, and rounding it happens to work until the value
 * where it does not. Splitting on the separator and padding the fraction
 * to two digits cannot be wrong by a cent.
 *
 * Accepts a comma or a dot, tolerates thousands separators the operator
 * may paste, and refuses anything with more than two decimal places
 * rather than silently truncating a third.
 */
export function parseEuroToCents(raw: string): number | null {
  const text = raw.trim().replace(/\s|€/g, "");
  if (!text) return null;
  // One separator decides the fraction; dots before it are thousands.
  const normalized = text.includes(",") ? text.replace(/\./g, "").replace(",", ".") : text;
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;
  const [whole, fraction = ""] = normalized.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(cents) ? cents : null;
}
