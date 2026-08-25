/**
 * The internal "new order, ship this" notification (Phase 1).
 *
 * Operational mail, not brand mail. It goes to orders@gloamatcha.com and
 * to nobody else, so it is written for the person packing the box rather
 * than for the customer: what to pick, how many, where it goes, what was
 * paid, and whether it came from a one-off purchase or a subscription
 * cycle. It carries no marketing copy and no unsubscribe link, because it
 * is neither.
 *
 * Pure and leaf: no relative imports, no DB, no network, no clock. That
 * is the same deliberate choice the other three templates in this folder
 * make, and it is what lets them be unit-tested directly. It is also why
 * the GLOA layout is repeated here rather than imported from a shared
 * module: an extension-less relative import cannot be resolved by the
 * plain Node test runner, so a shared layout module would trade testable
 * templates for de-duplicated markup. The shared thing is the pattern -
 * same tokens, same table shell, same escaping - and the tests are what
 * hold it together.
 *
 * The order row is the source of truth for fulfillment. This email is a
 * notification about it and never the other way round: nothing here may
 * be the reason an order exists, and nothing here invents a field the
 * database did not persist.
 */

export type InternalOrderItem = {
  productName: string;
  variantLabel: string;
  quantity: number;
  unitGrossCents: number;
  lineGrossCents: number;
  /** From the persisted order item. Null when the row has none. */
  sku: string | null;
};

export type InternalOrderAddress = {
  name: string | null;
  company: string | null;
  line1: string | null;
  line2: string | null;
  city: string | null;
  postalCode: string | null;
  state: string | null;
  /** Already resolved to a readable name by the caller, never an ISO code. */
  countryLabel: string | null;
};

/**
 * Where this order came from. Both values are derived from data that is
 * actually persisted - a subscription order is one whose checkout attempt
 * carries a subscription_id - so neither is a guess.
 */
export type InternalOrderSource = "one_time" | "subscription";

export type InternalOrderNotificationOrder = {
  order_number: string;
  currency: string;
  subtotal_gross_cents: number;
  shipping_gross_cents: number | null;
  total_gross_cents: number;
  shippingAddress: InternalOrderAddress | null;
  /** The customer's email, so fulfillment can reach them. */
  customerEmail: string | null;
  customerName: string | null;
  source: InternalOrderSource;
  /**
   * The Stripe invoice that paid a subscription cycle, for reconciliation.
   * Null for a one-off order, which has no invoice. Never a secret: an
   * invoice id is an identifier, not a credential.
   */
  stripeInvoiceId: string | null;
};

export type BuiltInternalOrderNotification = {
  subject: string;
  html: string;
  text: string;
};

/**
 * The provider-side duplicate guard for this message.
 *
 * One logical notification is "the internal notification for order X",
 * and every attempt at it - the first Stripe webhook delivery, a Stripe
 * redelivery, the daily failed-retry sweep, and a retry that follows a
 * stale-'sending' recovery - produces exactly this key. Resend refuses a
 * second send for a key it has already accepted, so an attempt that
 * genuinely succeeded but lost its database write cannot become a second
 * email in the fulfillment inbox.
 *
 * The order id is the whole input, deliberately. It is a GLOA uuid: it
 * identifies the durable order and nothing else, it is not a credential,
 * and it is already the primary key of the row the state machine locks.
 * A customer email, a name, an address, a Stripe secret or an amount
 * would all be worse keys as well as being data that has no business in
 * a request header. A timestamp, a retry counter or a random value would
 * be worse still: each of them would make every attempt a different key,
 * which is exactly the property an idempotency key must not have.
 *
 * The prefix namespaces it against every other GLOA message about the
 * same order - the customer confirmation is a different notification and
 * must never collide with this one.
 *
 * Deliberately NOT hashed. The key travels to Resend over TLS in an
 * Idempotency-Key header, it carries no secret, and a readable key is
 * worth more in a provider log than an opaque digest.
 */
export function internalOrderNotificationIdempotencyKey(orderId: string): string {
  return `gloa/internal-order/${orderId}`;
}

const BRAND = {
  blue: "#1746D1",
  berry: "#A61E59",
  cream: "#F5EBE2",
  plum: "#4F3A5B",
  ink: "#111111",
};

const SOURCE_LABEL: Readonly<Record<InternalOrderSource, string>> = Object.freeze({
  one_time: "Einzelbestellung",
  subscription: "Abo-Lieferung (alle 4 Wochen)",
});

function fmtCents(cents: number): string {
  return (cents / 100).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Known-zero shipping is a real price and says so. A null shipping value
 * is genuinely unknown and is handled by the caller, never invented here.
 */
function fmtShipping(shippingGrossCents: number): string {
  return shippingGrossCents === 0 ? "Kostenlos" : `${fmtCents(shippingGrossCents)} €`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatAddressLines(address: InternalOrderAddress): string[] {
  const lines: string[] = [];
  if (address.name) lines.push(address.name);
  if (address.company) lines.push(address.company);
  if (address.line1) lines.push(address.line2 ? `${address.line1}, ${address.line2}` : address.line1);
  const cityLine = [address.postalCode, address.city].filter(Boolean).join(" ");
  if (cityLine) lines.push(cityLine);
  if (address.state) lines.push(address.state);
  if (address.countryLabel) lines.push(address.countryLabel);
  return lines;
}

/**
 * Builds the internal notification (subject + HTML + plain text).
 *
 * Every customer-supplied string goes through escapeHtml. A name or an
 * address line is whatever somebody typed into a form, and this message
 * is read in a mail client: an unescaped angle bracket there is not a
 * cosmetic problem.
 */
export function buildInternalOrderNotificationEmail(params: {
  order: InternalOrderNotificationOrder;
  items: InternalOrderItem[];
}): BuiltInternalOrderNotification {
  const { order, items } = params;

  const sourceLabel = SOURCE_LABEL[order.source];
  const subject = `Neue Bestellung ${order.order_number} · ${fmtCents(order.total_gross_cents)} ${order.currency}`;

  // ---- Items ----
  const itemRowsHtml = items
    .map(
      item => `<tr>
<td style="padding:10px 0;border-bottom:1px solid ${BRAND.cream};font-size:14px;line-height:1.4;color:${BRAND.ink};">
  <strong>${escapeHtml(item.productName)}</strong><br/>
  <span style="color:#6b6258;">${escapeHtml(item.variantLabel)} · ${item.quantity}×${item.sku ? ` · ${escapeHtml(item.sku)}` : ""}</span>
</td>
<td align="right" style="padding:10px 0;border-bottom:1px solid ${BRAND.cream};font-size:14px;white-space:nowrap;color:${BRAND.ink};">
  ${fmtCents(item.lineGrossCents)} €
</td>
</tr>`
    )
    .join("");

  // ---- Totals ----
  const shippingLabel = order.shipping_gross_cents === null ? null : fmtShipping(order.shipping_gross_cents);
  const totalsRows: [string, string, boolean][] = [
    ["Zwischensumme", `${fmtCents(order.subtotal_gross_cents)} €`, false],
    ...(shippingLabel !== null ? ([["Versand", shippingLabel, false]] as [string, string, boolean][]) : []),
    ["Bezahlt", `${fmtCents(order.total_gross_cents)} ${order.currency}`, true],
  ];
  const totalsRowsHtml = totalsRows
    .map(
      ([label, value, strong]) => `<tr>
<td style="padding:6px 0;font-size:${strong ? "15px" : "14px"};color:${BRAND.ink};${strong ? "font-weight:700;" : ""}">${escapeHtml(label)}</td>
<td align="right" style="padding:6px 0;font-size:${strong ? "15px" : "14px"};white-space:nowrap;color:${BRAND.ink};${strong ? "font-weight:700;" : ""}">${escapeHtml(value)}</td>
</tr>`
    )
    .join("");

  // ---- Facts block. Only rows whose value actually exists. ----
  const factRows: [string, string][] = [
    ["Bestellnummer", order.order_number],
    ["Art", sourceLabel],
    ...(order.customerName ? ([["Kundin/Kunde", order.customerName]] as [string, string][]) : []),
    ...(order.customerEmail ? ([["E-Mail", order.customerEmail]] as [string, string][]) : []),
    ...(order.stripeInvoiceId ? ([["Stripe-Rechnung", order.stripeInvoiceId]] as [string, string][]) : []),
  ];
  const factRowsHtml = factRows
    .map(
      ([label, value]) => `<tr>
<td style="padding:4px 0;font-size:13px;color:#6b6258;width:40%;">${escapeHtml(label)}</td>
<td style="padding:4px 0;font-size:13px;color:${BRAND.ink};">${escapeHtml(value)}</td>
</tr>`
    )
    .join("");

  // ---- Address ----
  const addressHtml = order.shippingAddress
    ? `<tr><td colspan="2" style="padding:22px 0 0;">
      <p style="font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:${BRAND.plum};font-weight:700;margin:0 0 6px;">Lieferadresse</p>
      <p style="font-size:14px;line-height:1.5;margin:0;color:${BRAND.ink};">
        ${formatAddressLines(order.shippingAddress).map(escapeHtml).join("<br/>")}
      </p>
    </td></tr>`
    : `<tr><td colspan="2" style="padding:22px 0 0;">
      <p style="font-size:14px;line-height:1.5;margin:0;color:${BRAND.berry};">Keine Lieferadresse gespeichert - vor dem Versand prüfen.</p>
    </td></tr>`;

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
<p style="font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:${BRAND.berry};font-weight:700;margin:0 0 10px;">${escapeHtml(sourceLabel)}</p>
<h1 style="font-size:22px;line-height:1.2;letter-spacing:-0.02em;margin:0 0 18px;color:${BRAND.ink};">Neue Bestellung.</h1>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${factRowsHtml}${addressHtml}</table>
<p style="font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:${BRAND.plum};font-weight:700;margin:26px 0 4px;">Zu packen</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${itemRowsHtml}</table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px;border-top:2px solid ${BRAND.plum};padding-top:6px;">${totalsRowsHtml}</table>
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

  const itemLinesText = items
    .map(
      item =>
        `${item.productName} (${item.variantLabel})${item.sku ? ` [${item.sku}]` : ""} · ${item.quantity}× · ${fmtCents(item.lineGrossCents)} €`
    )
    .join("\n");

  const totalsLinesText = [
    `Zwischensumme: ${fmtCents(order.subtotal_gross_cents)} €`,
    ...(shippingLabel !== null ? [`Versand: ${shippingLabel}`] : []),
    `Bezahlt: ${fmtCents(order.total_gross_cents)} ${order.currency}`,
  ].join("\n");

  const addressLinesText = order.shippingAddress
    ? `Lieferadresse:\n${formatAddressLines(order.shippingAddress).join("\n")}`
    : "Keine Lieferadresse gespeichert - vor dem Versand prüfen.";

  const text = [
    "GLOA · Neue Bestellung",
    "",
    factLinesText,
    "",
    addressLinesText,
    "",
    "Zu packen:",
    itemLinesText,
    "",
    totalsLinesText,
    "",
    "Interne Benachrichtigung. Die Bestellung im Shop-Backend ist maßgeblich.",
  ]
    .filter(line => line !== "")
    .join("\n");

  return { subject, html, text };
}
