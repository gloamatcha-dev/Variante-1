/**
 * The internal "a customer asked to stop this order" notification
 * (Phase 2D-A).
 *
 * Operational mail, not brand mail. It goes to orders@gloamatcha.com and
 * to nobody else, so it is written for the person who has to decide
 * whether the order can still be stopped. It carries no marketing copy
 * and no unsubscribe link, because it is neither.
 *
 * ── THIS EMAIL IS ABOUT A REQUEST, NOT A CANCELLATION ─────────
 *
 * The single most important property of this template, and the reason
 * every string in it was chosen carefully. Nothing here may read as
 * "this order has been cancelled". The order is still live: migration
 * 019's request_order_cancellation writes a timestamp and a note and
 * changes no lifecycle column, so at the moment this email is sent the
 * order's status, fulfillment_status and payment_status are all exactly
 * what they were.
 *
 * Cancelling is a separate, authorized operator action
 * (POST /api/internal/orders/cancel, migration 029), and refunding is a
 * third separate thing that still happens by hand in the Stripe
 * Dashboard. This message triggers neither. It says someone asked, shows
 * what they asked about, and stops.
 *
 * Pure and leaf: no relative imports, no DB, no network, no clock. That
 * is the same deliberate choice the other four templates in this folder
 * make, and it is what lets them be unit-tested directly. It is also why
 * the GLOA layout is repeated here rather than imported from a shared
 * module: an extension-less relative import cannot be resolved by the
 * plain Node test runner, so a shared layout module would trade testable
 * templates for de-duplicated markup. The shared thing is the pattern -
 * same tokens, same table shell, same escaping - and the tests are what
 * hold it together.
 */

/**
 * Everything this email is allowed to know about an order.
 *
 * DELIBERATELY NARROW, and what is missing matters as much as what is
 * here. This type carries NO items, NO shipping address, NO billing
 * address, NO order uuid, NO Stripe identifier, NO tracking data and NO
 * refund figure.
 *
 * Items and the address were considered and rejected. Fulfillment already
 * received both, for this same order number, in the "Neue Bestellung"
 * email that migration 026's flow sends at checkout. Repeating them here
 * would add a second database query and a second failure mode to answer a
 * question this message is not asking. The decision in front of the
 * reader is "can this still be stopped", and what answers that is the
 * fulfillment status, the payment status and the order number - not the
 * street.
 *
 * A refund figure is absent for a stronger reason: this feature creates
 * no refund and knows nothing about one, and printing a number next to
 * the word Stornierung would invite someone to believe money had already
 * moved.
 */
export type CancellationRequestNotificationOrder = {
  order_number: string;
  /** ISO timestamp from the durable order row. Never "now". */
  requestedAt: string | null;
  /** The customer's own words, or null. Never invented, never summarised. */
  requestNote: string | null;
  /** From the order's frozen customer_snapshot. Null when absent. */
  customerName: string | null;
  customerEmail: string | null;
  currency: string;
  total_gross_cents: number;
  /** Raw persisted lifecycle values, rendered through the label maps below. */
  payment_status: string;
  fulfillment_status: string;
};

export type BuiltCancellationRequestNotification = {
  subject: string;
  html: string;
  text: string;
};

/**
 * The provider-side duplicate guard for this message.
 *
 * One logical notification is "the cancellation request notification for
 * order X", and every attempt at it - the customer's first request, a
 * repeat request that retries a failed send, and any future sweep -
 * produces exactly this key. Resend refuses a second send for a key it
 * has already accepted, so an attempt that genuinely reached the provider
 * but lost its database write cannot become a second email in the
 * fulfillment inbox.
 *
 * The order id is the whole input, deliberately, exactly as it is for
 * internalOrderNotificationIdempotencyKey and
 * shipmentConfirmationIdempotencyKey. It is a GLOA uuid: it identifies
 * the durable order and nothing else, it is not a credential, and it is
 * already the primary key of the row the state machine locks.
 *
 * NO CUSTOMER EMAIL, NO NAME, NO NOTE, NO TIMESTAMP. The first three are
 * PII that has no business travelling in a request header. A timestamp,
 * a retry counter or a random value would be worse still: each would make
 * every attempt a different key, which is precisely the property an
 * idempotency key must not have.
 *
 * WHY AN ORDER ID IS A SUFFICIENT KEY HERE, which is a claim about the
 * schema and not a convenience. public.orders carries exactly one
 * cancellation_requested_at and one cancellation_request_note (migration
 * 019); there is no cancellation_requests table and no foreign key
 * anywhere in the schema, and request_order_cancellation is explicitly
 * idempotent - a second submission returns 'already_requested' and does
 * not move the timestamp. A second, distinct cancellation request for one
 * order is therefore not representable at all. One order is one request,
 * so one order id is one key.
 *
 * The prefix namespaces it against every other GLOA message about the
 * same order. Deliberately NOT hashed: the key travels to Resend over TLS
 * in an Idempotency-Key header, it carries no secret, and a readable key
 * is worth more in a provider log than an opaque digest.
 */
export function cancellationRequestNotificationIdempotencyKey(orderId: string): string {
  return `gloa/cancellation-request/${orderId}`;
}

const BRAND = {
  blue: "#1746D1",
  berry: "#A61E59",
  cream: "#F5EBE2",
  plum: "#4F3A5B",
  ink: "#111111",
};

/**
 * Operational German for the persisted lifecycle values.
 *
 * An unrecognised value falls back to the raw string rather than to a
 * neutral phrase. This is the opposite of what lib/orderStatus.ts does
 * for the customer, and deliberately so: a customer must never be shown
 * "partially_refunded", while the operator reading this message is better
 * served by seeing exactly what the column says than by a label that
 * quietly smooths over a value nobody has taught this map about.
 */
const PAYMENT_LABEL: Readonly<Record<string, string>> = Object.freeze({
  pending: "Zahlung ausstehend",
  paid: "Bezahlt",
  failed: "Zahlung fehlgeschlagen",
  refund_pending: "Erstattung in Bearbeitung",
  partially_refunded: "Teilweise erstattet",
  refunded: "Erstattet",
});

const FULFILLMENT_LABEL: Readonly<Record<string, string>> = Object.freeze({
  unfulfilled: "Noch nicht bearbeitet",
  processing: "In Vorbereitung",
  shipped: "Versendet",
  delivered: "Zugestellt",
  cancelled: "Storniert",
});

function paymentLabel(value: string): string {
  return PAYMENT_LABEL[value] ?? value;
}

function fulfillmentLabel(value: string): string {
  return FULFILLMENT_LABEL[value] ?? value;
}

function fmtCents(cents: number): string {
  return (cents / 100).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * A readable German timestamp, or null when the row genuinely has none.
 *
 * Never falls back to the current time. "When did the customer ask" is a
 * persisted fact; if it is missing, the honest answer is to omit the row,
 * not to print the moment this email happened to be rendered.
 */
function fmtTimestamp(value: string | null): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Berlin",
  });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Builds the internal cancellation request notification.
 *
 * Every customer-supplied string goes through escapeHtml. The request
 * note in particular is free text a customer typed into a form and is
 * read here in a mail client: an unescaped angle bracket there is not a
 * cosmetic problem. The note is reproduced verbatim otherwise - never
 * truncated to a preview, never summarised - because the whole reason it
 * was collected is that the operator reads it.
 */
export function buildCancellationRequestNotificationEmail(params: {
  order: CancellationRequestNotificationOrder;
}): BuiltCancellationRequestNotification {
  const { order } = params;

  // "Stornierungsanfrage", never "Storniert". The subject is the part
  // most likely to be read alone, on a phone, in a notification preview,
  // so it is the part that must not be ambiguous about whether anything
  // has actually happened to the order.
  const subject = `Stornierungsanfrage ${order.order_number}`;

  const requestedAtLabel = fmtTimestamp(order.requestedAt);

  // ---- Facts block. Only rows whose value actually exists. ----
  const factRows: [string, string][] = [
    ["Bestellnummer", order.order_number],
    ...(requestedAtLabel ? ([["Angefragt am", requestedAtLabel]] as [string, string][]) : []),
    ...(order.customerName ? ([["Kundin/Kunde", order.customerName]] as [string, string][]) : []),
    ...(order.customerEmail ? ([["E-Mail", order.customerEmail]] as [string, string][]) : []),
    ["Bestellwert", `${fmtCents(order.total_gross_cents)} ${order.currency}`],
    ["Zahlung", paymentLabel(order.payment_status)],
    ["Fulfillment", fulfillmentLabel(order.fulfillment_status)],
  ];
  const factRowsHtml = factRows
    .map(
      ([label, value]) => `<tr>
<td style="padding:4px 0;font-size:13px;color:#6b6258;width:40%;">${escapeHtml(label)}</td>
<td style="padding:4px 0;font-size:13px;color:${BRAND.ink};">${escapeHtml(value)}</td>
</tr>`
    )
    .join("");

  // ---- The customer's own words, only when they wrote some. ----
  const noteHtml = order.requestNote
    ? `<p style="font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:${BRAND.plum};font-weight:700;margin:26px 0 6px;">Grund der Kundin/des Kunden</p>
<p style="font-size:14px;line-height:1.5;margin:0;color:${BRAND.ink};white-space:pre-wrap;">${escapeHtml(order.requestNote)}</p>`
    : `<p style="font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:${BRAND.plum};font-weight:700;margin:26px 0 6px;">Grund der Kundin/des Kunden</p>
<p style="font-size:14px;line-height:1.5;margin:0;color:#6b6258;">Kein Grund angegeben.</p>`;

  const html = `<!doctype html>
<html lang="de">
<head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background-color:${BRAND.cream};font-family:Arial,Helvetica,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${BRAND.cream};padding:32px 16px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;">
<tr><td style="background-color:${BRAND.blue};padding:20px 32px;">
<span style="font-size:22px;font-weight:900;color:${BRAND.cream};letter-spacing:-0.03em;">GLOA</span>
<span style="font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:${BRAND.cream};margin-left:10px;">Fulfillment</span>
</td></tr>
<tr><td style="padding:32px;">
<p style="font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:${BRAND.berry};font-weight:700;margin:0 0 10px;">Anfrage</p>
<h1 style="font-size:22px;line-height:1.2;letter-spacing:-0.02em;margin:0 0 12px;color:${BRAND.ink};">Stornierungsanfrage.</h1>
<p style="font-size:14px;line-height:1.5;margin:0 0 18px;color:${BRAND.berry};font-weight:700;">Die Bestellung ist noch NICHT storniert. Es wurde nur angefragt.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${factRowsHtml}</table>
${noteHtml}
<p style="font-size:13px;line-height:1.5;margin:26px 0 0;color:#6b6258;">Prüfen, ob die Bestellung noch gestoppt werden kann. Stornieren und Erstatten sind getrennte Schritte und passieren nicht automatisch.</p>
</td></tr>
<tr><td style="background-color:${BRAND.plum};padding:20px 32px;">
<p style="font-size:12px;line-height:1.5;color:${BRAND.cream};margin:0;">GLOA · Interne Benachrichtigung. Die Bestellung im Shop-Backend ist maßgeblich.</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

  // ---- Plain text ----
  const factLinesText = factRows.map(([label, value]) => `${label}: ${value}`).join("\n");
  const noteText = order.requestNote
    ? `Grund der Kundin/des Kunden:\n${order.requestNote}`
    : "Grund der Kundin/des Kunden: Kein Grund angegeben.";

  const text = [
    "GLOA · Stornierungsanfrage",
    "",
    "Die Bestellung ist noch NICHT storniert. Es wurde nur angefragt.",
    "",
    factLinesText,
    "",
    noteText,
    "",
    "Pruefen, ob die Bestellung noch gestoppt werden kann. Stornieren und Erstatten sind getrennte Schritte und passieren nicht automatisch.",
    "",
    "Interne Benachrichtigung. Die Bestellung im Shop-Backend ist massgeblich.",
  ].join("\n");

  return { subject, html, text };
}
