/**
 * Shipment confirmation email (Task 26A) - template only.
 *
 * Nothing in the application sends this yet: Resend and the sending
 * domain remain paused, so this module is deliberately not wired to a
 * provider. It is a pure builder, exactly like
 * lib/email/orderConfirmation.ts, so the copy and markup can be reviewed
 * and unit-tested now and connected to a sender in one small step once
 * email delivery is live.
 *
 * Pure and leaf: no relative imports, no DB, no network. The input type
 * carries no order id, user id, checkout attempt id or Stripe id, so no
 * internal identifier can leak into a customer's inbox even by accident.
 */

export type ShipmentAddress = {
  name: string | null;
  company: string | null;
  line1: string | null;
  line2: string | null;
  city: string | null;
  postalCode: string | null;
  state: string | null;
  /** Already resolved to a customer-facing name, never an ISO code. */
  countryLabel: string | null;
};

export type ShipmentTracking = {
  /** Carrier name, or null when unknown. Never guessed from the number. */
  carrier: string | null;
  trackingNumber: string | null;
  /**
   * A URL the caller has already validated as absolute http(s) (see
   * sanitizeTrackingUrl in lib/orderStatus.ts). Null when there is no
   * real tracking link - this template never builds a carrier URL of its
   * own from a carrier name or a number pattern.
   */
  trackingUrl: string | null;
};

export type ShipmentConfirmationOrder = {
  order_number: string;
  shippingAddress: ShipmentAddress | null;
  tracking: ShipmentTracking | null;
  /** Fully-built account link, or null to omit it (e.g. guest order). */
  accountOrderUrl: string | null;
};

export type BuiltShipmentConfirmationEmail = {
  subject: string;
  html: string;
  text: string;
};

const BRAND = {
  blue: "#1746D1",
  berry: "#A61E59",
  cream: "#F5EBE2",
  plum: "#4F3A5B",
  ink: "#111111",
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatAddressLines(address: ShipmentAddress): string[] {
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
 * Builds the "your order is on its way" email (subject + HTML + plain
 * text).
 *
 * Renders only what actually exists. If there is no tracking number, no
 * tracking block appears at all rather than an empty placeholder. If the
 * carrier is unknown, the number stands on its own without a fabricated
 * carrier name. If there is no tracking URL, no link is produced - the
 * template never assembles a DHL/UPS/DPD URL itself.
 */
export function buildShipmentConfirmationEmail(params: {
  order: ShipmentConfirmationOrder;
  customerEmail: string;
}): BuiltShipmentConfirmationEmail {
  const { order } = params;
  const subject = `Deine GLOA Bestellung ist unterwegs – ${order.order_number}`;

  const carrier = order.tracking?.carrier ?? null;
  const trackingNumber = order.tracking?.trackingNumber ?? null;
  const trackingUrl = order.tracking?.trackingUrl ?? null;
  const hasTracking = Boolean(carrier || trackingNumber || trackingUrl);

  // ---- HTML ----
  const trackingRowsHtml = [
    ...(carrier ? [["Versanddienst", escapeHtml(carrier)]] : []),
    ...(trackingNumber ? [["Sendungsnummer", escapeHtml(trackingNumber)]] : []),
  ]
    .map(
      ([label, value]) => `
      <tr>
        <td style="padding:6px 0;font-size:14px;color:#6b6258;">${label}</td>
        <td style="padding:6px 0;font-size:14px;text-align:right;word-break:break-all;color:${BRAND.ink};">${value}</td>
      </tr>`
    )
    .join("");

  const trackingHtml = hasTracking
    ? `
      <p style="font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:${BRAND.berry};font-weight:700;margin:28px 0 8px;">Sendung</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${trackingRowsHtml}</table>
      ${
        trackingUrl
          ? `<p style="font-size:13px;margin:16px 0 0;"><a href="${escapeHtml(trackingUrl)}" style="color:${BRAND.blue};" rel="noopener noreferrer">Sendung verfolgen →</a></p>`
          : ""
      }`
    : "";

  const addressHtml = order.shippingAddress
    ? `
      <p style="font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:${BRAND.berry};font-weight:700;margin:28px 0 8px;">Lieferadresse</p>
      <p style="font-size:14px;line-height:1.6;color:${BRAND.ink};margin:0;">
        ${formatAddressLines(order.shippingAddress).map(escapeHtml).join("<br/>")}
      </p>`
    : "";

  const accountLinkHtml = order.accountOrderUrl
    ? `<p style="font-size:13px;margin:24px 0 0;"><a href="${escapeHtml(order.accountOrderUrl)}" style="color:${BRAND.blue};">Bestellung in deinem Konto ansehen →</a></p>`
    : "";

  const html = `<!doctype html>
<html lang="de">
<head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background-color:${BRAND.cream};font-family:Arial,Helvetica,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${BRAND.cream};padding:32px 16px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;">
<tr><td style="background-color:${BRAND.blue};padding:20px 32px;">
<span style="font-size:22px;font-weight:900;color:${BRAND.cream};letter-spacing:-0.03em;">GLOA</span>
</td></tr>
<tr><td style="padding:32px;">
<p style="font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:${BRAND.berry};font-weight:700;margin:0 0 10px;">Versendet</p>
<h1 style="font-size:22px;line-height:1.2;letter-spacing:-0.02em;margin:0 0 14px;color:${BRAND.ink};">Deine Bestellung ist unterwegs.</h1>
<p style="font-size:14px;line-height:1.5;margin:0 0 6px;color:${BRAND.ink};">Bestellnummer <strong>${escapeHtml(order.order_number)}</strong></p>
${trackingHtml}
${addressHtml}
${accountLinkHtml}
</td></tr>
<tr><td style="background-color:${BRAND.plum};padding:20px 32px;">
<p style="font-size:12px;line-height:1.5;color:${BRAND.cream};margin:0;">GLOA · Fragen zu deiner Bestellung? <a href="mailto:info@gloamatcha.com" style="color:${BRAND.cream};">info@gloamatcha.com</a></p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

  // ---- Plain text ----
  const trackingLinesText = [
    ...(carrier ? [`Versanddienst: ${carrier}`] : []),
    ...(trackingNumber ? [`Sendungsnummer: ${trackingNumber}`] : []),
    ...(trackingUrl ? [`Sendung verfolgen: ${trackingUrl}`] : []),
  ].join("\n");

  const addressLinesText = order.shippingAddress
    ? `\nLieferadresse:\n${formatAddressLines(order.shippingAddress).join("\n")}\n`
    : "";

  const accountLinkText = order.accountOrderUrl
    ? `\nBestellung in deinem Konto ansehen: ${order.accountOrderUrl}\n`
    : "";

  const text = [
    "GLOA · Versendet",
    "",
    "Deine Bestellung ist unterwegs.",
    `Bestellnummer: ${order.order_number}`,
    trackingLinesText ? `\n${trackingLinesText}` : "",
    addressLinesText,
    accountLinkText,
    "",
    "Fragen zu deiner Bestellung? info@gloamatcha.com",
  ]
    .filter(line => line !== "")
    .join("\n");

  return { subject, html, text };
}

/**
 * The Resend idempotency key for one order's shipment confirmation.
 *
 * The provider-side half of the duplicate guard, exactly as
 * internalOrderNotificationIdempotencyKey is for the fulfillment inbox.
 * The database claim stops two workers from both starting a send; this
 * stops an attempt that reached Resend but lost its state write from
 * becoming a second email in the customer's inbox.
 *
 * WHY AN ORDER ID IS A SUFFICIENT KEY HERE, which is a claim about the
 * schema and not a convenience. public.orders carries exactly one set of
 * shipment columns - shipping_carrier, tracking_number, tracking_url,
 * shipped_at (migration 019) - there is no shipments table and no
 * shipment foreign key anywhere in the schema, and fulfillment_status is
 * a single scalar whose vocabulary (migration 004) has no
 * 'partially_shipped' value. A second, partial shipment of one order is
 * therefore not representable at all today. One order is one shipment,
 * so one order is one confirmation, so the order id identifies the
 * message completely.
 *
 * IF THAT EVER CHANGES, this key must change with it, and changing it is
 * not optional: a per-shipment key is required the moment a second
 * shipment for one order becomes representable, or the second parcel's
 * confirmation would be silently swallowed by the first one's key.
 *
 * The prefix namespaces it against the other GLOA messages about the
 * same order - the customer's order confirmation and the internal
 * fulfillment notification are different notifications and must never
 * collide with this one. It carries no customer email, no name, no
 * address, no tracking number and no timestamp: none of those belong in
 * a request header, and a value that changed per attempt would defeat
 * the entire purpose of an idempotency key.
 */
export function shipmentConfirmationIdempotencyKey(orderId: string): string {
  return `gloa/shipment/${orderId}`;
}
