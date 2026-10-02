/**
 * The internal "annual plan sold, no order to ship yet" notification.
 *
 * Operational mail for orders@gloamatcha.com. It fills the one gap in the
 * existing internal notification system: when an annual plan is purchased
 * there is no order row to carry notification state, so fulfilment would
 * otherwise never learn about the sale.
 *
 * Pure and leaf: no relative imports, no DB, no network, no clock. Same
 * pattern as lib/email/internalOrderNotification.ts.
 */

export type InternalAnnualPurchasePlan = {
  annualPlanId: string;
  currency: string;
  totalGrossCents: number;
  merchandiseTotalGrossCents: number;
  shippingTotalGrossCents: number;
  annualUnitGrossCents: number;
  deliveryCount: number;
  discountPercentApplied: number;
  paymentStatus: string;
  status: string;
  purchasedAt: string | null;
  stripePaymentIntentId: string | null;
  customerName: string;
  customerEmail: string;
  productLabel: string;
  productSku: string;
};

export type BuiltInternalAnnualPurchaseNotification = {
  subject: string;
  html: string;
  text: string;
};

export function internalAnnualPurchaseNotificationIdempotencyKey(annualPlanId: string): string {
  return `gloa/internal-annual-purchase/${annualPlanId}`;
}

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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmtDate(iso: string | null): string {
  if (!iso) return "–";
  const d = new Date(iso);
  return d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
}

export function buildInternalAnnualPurchaseNotificationEmail(
  plan: InternalAnnualPurchasePlan
): BuiltInternalAnnualPurchaseNotification {
  const subject = `Neuer Jahresplan · ${fmtCents(plan.totalGrossCents)} ${plan.currency}`;

  const factRows: [string, string][] = [
    ["Jahresplan-ID", plan.annualPlanId],
    ["Kundin/Kunde", plan.customerName || "–"],
    ["E-Mail", plan.customerEmail || "–"],
    ["Produkt", plan.productLabel || "–"],
    ...(plan.productSku ? ([["SKU", plan.productSku]] as [string, string][]) : []),
    ["Lieferungen", `${plan.deliveryCount}× (alle 4 Wochen)`],
    ["Stückpreis (Jahres)", `${fmtCents(plan.annualUnitGrossCents)} €`],
    ["Rabatt", `${plan.discountPercentApplied}%`],
    ["Ware gesamt", `${fmtCents(plan.merchandiseTotalGrossCents)} €`],
    ["Versand gesamt", `${fmtCents(plan.shippingTotalGrossCents)} €`],
    ["Bezahlt", `${fmtCents(plan.totalGrossCents)} ${plan.currency}`],
    ["Zahlungsstatus", plan.paymentStatus],
    ["Plan-Status", plan.status],
    ["Kaufdatum", fmtDate(plan.purchasedAt)],
    ...(plan.stripePaymentIntentId ? ([["Stripe-PI", plan.stripePaymentIntentId]] as [string, string][]) : []),
  ];

  const factRowsHtml = factRows
    .map(
      ([label, value]) => `<tr>
<td style="padding:4px 0;font-size:13px;color:#6b6258;width:40%;">${escapeHtml(label)}</td>
<td style="padding:4px 0;font-size:13px;color:${BRAND.ink};">${escapeHtml(value)}</td>
</tr>`
    )
    .join("");

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
<p style="font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:${BRAND.berry};font-weight:700;margin:0 0 10px;">Jahresplan-Kauf (vorausbezahlt)</p>
<h1 style="font-size:22px;line-height:1.2;letter-spacing:-0.02em;margin:0 0 18px;color:${BRAND.ink};">Neuer Jahresplan verkauft.</h1>
<p style="font-size:14px;line-height:1.5;color:${BRAND.ink};margin:0 0 22px;">13 Lieferungen alle 4 Wochen, komplett vorausbezahlt. Die erste Lieferung wird automatisch erstellt.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${factRowsHtml}</table>
</td></tr>
<tr><td style="background-color:${BRAND.plum};padding:20px 32px;">
<p style="font-size:12px;line-height:1.5;color:${BRAND.cream};margin:0;">GLOA · Interne Benachrichtigung. Der Jahresplan im Admin ist maßgeblich.</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

  const factLinesText = factRows.map(([label, value]) => `${label}: ${value}`).join("\n");

  const text = [
    "GLOA · Neuer Jahresplan verkauft",
    "",
    "13 Lieferungen alle 4 Wochen, komplett vorausbezahlt.",
    "Die erste Lieferung wird automatisch erstellt.",
    "",
    factLinesText,
    "",
    "Interne Benachrichtigung. Der Jahresplan im Admin ist maßgeblich.",
  ]
    .filter(line => line !== "")
    .join("\n");

  return { subject, html, text };
}
