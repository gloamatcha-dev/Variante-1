import {
  emailShell,
  emailHeader,
  emailEyebrow,
  emailHeadline,
  emailFooter,
  GLOA_NEAR_BLACK,
  GLOA_BERRY,
} from "./brand.ts";

export type OrderConfirmationItem = {
  productName: string;
  variantLabel: string;
  quantity: number;
  unitGrossCents: number;
  lineGrossCents: number;
};

/**
 * Address ready for direct rendering - the caller has already resolved
 * countryLabel to a customer-facing name (e.g. "Deutschland"), never a
 * raw ISO code, and this module never reaches out to another module to
 * do that itself. Keeping this leaf module free of relative imports is
 * deliberate: it is what lets it be unit-tested directly and reliably
 * (see tests/order-confirmation-email-template.test.mjs).
 */
export type OrderConfirmationAddress = {
  name: string | null;
  company: string | null;
  line1: string | null;
  line2: string | null;
  city: string | null;
  postalCode: string | null;
  state: string | null;
  countryLabel: string | null;
};

export type OrderConfirmationOrder = {
  order_number: string;
  subtotal_gross_cents: number;
  shipping_gross_cents: number | null;
  total_gross_cents: number;
  shippingAddress: OrderConfirmationAddress | null;
  // Fully-built "view your order" link, or null to omit it entirely
  // (e.g. guest order, or SITE_URL not configured). Resolved by the
  // caller - this module never has access to order.id or user_id, so
  // it cannot leak an internal id even by accident.
  accountOrderUrl: string | null;
};

export type BuiltOrderConfirmationEmail = {
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

function fmtCents(cents: number): string {
  return (cents / 100).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Consistent GLOA convention for a real, known-zero shipping price -
 * matches the wording already used on /order/success and in the
 * account order detail view. Never invents a value: shippingGrossCents
 * being null (genuinely unknown) is handled by the caller, not here.
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

function formatAddressLines(address: OrderConfirmationAddress): string[] {
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
 * Builds the paid-order confirmation email (subject + HTML + plain
 * text). Pure - no DB or network access, no relative imports, so this
 * is directly unit-testable. Renders only fields that actually exist;
 * never fabricates a shelf-life, tax rate, or address field that
 * wasn't captured. Never includes any internal id - the input type
 * itself carries no order id, checkout attempt id, or Stripe id.
 */
/*
 * The footer address is support@gloamatcha.com, matching the Reply-To the
 * sender sets. It deliberately differs from the info@ address the
 * Impressum and app/content.ts publish: inside ONE transactional email,
 * telling a customer to write to one mailbox while their reply goes to
 * another is a message that contradicts itself. Reconciling the site's
 * published contact address is a separate task and is not done here.
 */
export function buildOrderConfirmationEmail(params: {
  order: OrderConfirmationOrder;
  items: OrderConfirmationItem[];
  customerEmail: string;
  /**
   * Absolute site origin, for the logo in the mail header. Optional:
   * without it the mail is built without the mark rather than with a
   * broken image, which is what a relative path becomes in an inbox.
   */
  origin?: string;
}): BuiltOrderConfirmationEmail {
  const { order, items } = params;
  const subject = `Deine GLOA Bestellung ist bestätigt: ${order.order_number}`;

  const shippingLabel = order.shipping_gross_cents === null ? null : fmtShipping(order.shipping_gross_cents);

  // ---- HTML ----
  const itemRowsHtml = items
    .map(
      item => `
      <tr>
        <td style="padding:12px 0;border-top:1px solid #e2dcd3;font-size:14px;line-height:1.4;color:${BRAND.ink};">
          <strong>${escapeHtml(item.productName)}</strong><br/>
          <span style="color:#6b6258;">${escapeHtml(item.variantLabel)} · ${item.quantity}×</span>
        </td>
        <td style="padding:12px 0;border-top:1px solid #e2dcd3;font-size:14px;text-align:right;white-space:nowrap;color:${BRAND.ink};">
          ${fmtCents(item.lineGrossCents)} €
        </td>
      </tr>`
    )
    .join("");

  const totalsRowsHtml = [
    ["Zwischensumme", `${fmtCents(order.subtotal_gross_cents)} €`, false],
    ...(shippingLabel !== null ? [["Versand", shippingLabel, false]] : []),
    ["Gesamt", `${fmtCents(order.total_gross_cents)} €`, true],
  ]
    .map(
      ([label, value, bold]) => `
      <tr>
        <td style="padding:6px 0;font-size:${bold ? "16px" : "14px"};font-weight:${bold ? "700" : "400"};color:${BRAND.ink};">${label}</td>
        <td style="padding:6px 0;font-size:${bold ? "16px" : "14px"};font-weight:${bold ? "700" : "400"};text-align:right;color:${BRAND.ink};">${value}</td>
      </tr>`
    )
    .join("");

  const addressHtml = order.shippingAddress
    ? `
      <tr><td style="padding-top:28px;">
        <p style="font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:${BRAND.berry};font-weight:700;margin:0 0 8px;">Lieferadresse</p>
        <p style="font-size:14px;line-height:1.6;color:${BRAND.ink};margin:0;">
          ${formatAddressLines(order.shippingAddress).map(escapeHtml).join("<br/>")}
        </p>
      </td></tr>`
    : "";

  const accountLinkHtml = order.accountOrderUrl
    ? `<p style="font-size:13px;margin:24px 0 0;"><a href="${order.accountOrderUrl}" style="color:${BRAND.blue};">Bestellung in deinem Konto ansehen →</a></p>`
    : "";

    // The approved mark, when an origin was supplied. Without one the
  // mail is built without it rather than with a broken image - the
  // same rule the launch mails already follow.
  const header = params.origin ? emailHeader(params.origin) : "";

  const html = emailShell(escapeHtml(subject), `${header}
${emailEyebrow(`Zahlung bestätigt`)}
${emailHeadline(`Danke für deine Bestellung.`)}
<tr><td style="padding:16px 0 28px 0;font-size:15px;line-height:1.6;color:${GLOA_NEAR_BLACK};">
<p style="font-size:14px;line-height:1.5;margin:0 0 24px;color:${BRAND.ink};">Bestellnummer <strong>${escapeHtml(order.order_number)}</strong></p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${itemRowsHtml}</table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px;border-top:2px solid ${BRAND.plum};padding-top:6px;">${totalsRowsHtml}</table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${addressHtml}</table>
${accountLinkHtml}
</td></tr>
${emailFooter(`Fragen zu deiner Bestellung? <a href="mailto:support@gloamatcha.com" style="color:${GLOA_BERRY};">support@gloamatcha.com</a>`)}`);

  // ---- Plain text ----
  const itemLinesText = items
    .map(item => `${item.productName} (${item.variantLabel}) · ${item.quantity}× · ${fmtCents(item.lineGrossCents)} €`)
    .join("\n");

  const totalsLinesText = [
    `Zwischensumme: ${fmtCents(order.subtotal_gross_cents)} €`,
    ...(shippingLabel !== null ? [`Versand: ${shippingLabel}`] : []),
    `Gesamt: ${fmtCents(order.total_gross_cents)} €`,
  ].join("\n");

  const addressLinesText = order.shippingAddress
    ? `\nLieferadresse:\n${formatAddressLines(order.shippingAddress).join("\n")}\n`
    : "";

  const accountLinkText = order.accountOrderUrl ? `\nBestellung in deinem Konto ansehen: ${order.accountOrderUrl}\n` : "";

  const text = [
    "GLOA · Zahlung bestätigt",
    "",
    "Danke für deine Bestellung.",
    `Bestellnummer: ${order.order_number}`,
    "",
    itemLinesText,
    "",
    totalsLinesText,
    addressLinesText,
    accountLinkText,
    "",
    "Fragen zu deiner Bestellung? support@gloamatcha.com",
  ]
    .filter(line => line !== "")
    .join("\n");

  return { subject, html, text };
}
