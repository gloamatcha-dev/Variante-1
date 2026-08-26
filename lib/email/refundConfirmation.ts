/**
 * The customer's refund confirmation email (Phase 2E-A).
 *
 * Money went back. This tells them, in two forms, because a refund is
 * either partial or complete and those are different messages.
 *
 * ══════════════════════════════════════════════════════════════
 * WHAT THIS TEMPLATE IS NOT ALLOWED TO SAY
 * ══════════════════════════════════════════════════════════════
 *
 * More than in any other message in this system, the danger here is
 * plausible-sounding detail that nobody actually knows. A refund email
 * naturally invites sentences like "das Geld ist in 3-5 Werktagen wieder
 * auf deinem Konto" or "wir haben den Betrag auf deine Kreditkarte
 * zurückgebucht". GLOA does not know either of those things:
 *
 *   * NO BANK TIMING. Settlement depends on the customer's issuer and
 *     Stripe reports nothing this application persists. A number of
 *     working days would be invented.
 *   * NO PAYMENT DESTINATION. The order carries no card brand, no last4,
 *     no PayPal address and no IBAN - deliberately, since none of that
 *     is stored. "Auf dem Weg, den du bezahlt hast" is the most this can
 *     honestly say, and even that is a description of how refunds work
 *     rather than a claim about a specific account.
 *   * NO REASON. A refund is raised by hand in the Stripe Dashboard and
 *     the reason lives in nobody's database. The template is given no
 *     field for one and asks for none.
 *   * NO PROMISE OF MORE. A partial refund says what was refunded so
 *     far. It must never say or imply that the rest is coming, because
 *     whether anything else is owed is a decision nobody has recorded.
 *
 * The input type below is the enforcement: there is no field through
 * which any of those could arrive, so they cannot appear by accident.
 *
 * Pure and leaf: no relative imports, no DB, no network, no clock. The
 * same choice the other six templates in this folder make. The input type
 * carries no order id, user id, payment intent, charge id or refund id,
 * so no internal identifier can reach a customer's inbox.
 */

/** Partial or complete. Derived by the caller from persisted amounts. */
export type RefundKind = "partial" | "full";

/**
 * Everything this email is allowed to know.
 *
 * DELIBERATELY NARROW. No reason, no timing, no payment method, no card
 * details, no items, no address, no Stripe identifier, no remaining
 * balance owed. Two amounts and an order number.
 *
 * originalTotalGrossCents is present only so a partial refund can show
 * what the order cost alongside what came back - the customer can then
 * see the relationship for themselves without the template asserting
 * anything about the difference.
 */
export type RefundConfirmationOrder = {
  order_number: string;
  kind: RefundKind;
  /** Cumulative settled refund in cents, straight from refunded_total_cents. */
  refundedTotalCents: number;
  /** What the order was charged, from total_gross_cents. */
  originalTotalGrossCents: number;
  /** ISO 4217 code from the order row, e.g. "EUR". Never assumed. */
  currency: string;
  /** Fully-built account link, or null to omit it (e.g. guest order). */
  accountOrderUrl: string | null;
};

export type BuiltRefundConfirmationEmail = {
  subject: string;
  html: string;
  text: string;
};

/**
 * The Resend idempotency key for one refund confirmation.
 *
 * ══════════════════════════════════════════════════════════════
 * WHY THE ORDER ID ALONE IS NOT ENOUGH HERE
 * ══════════════════════════════════════════════════════════════
 *
 * Every other GLOA message keys on the order id alone, and each of those
 * modules explains why that is sufficient: one order is one shipment, one
 * cancellation request, one terminal resolution. A REFUND IS THE
 * EXCEPTION, and it is a claim about the schema rather than a
 * convenience. Stripe permits several partial refunds against one payment
 * intent; summarizeStripeRefunds sums every settled one into a cumulative
 * absolute total; and migration 019's payment vocabulary carries both
 * 'partially_refunded' and 'refunded' precisely because an order can pass
 * through the first on its way to the second.
 *
 * So one order can genuinely owe several refund emails, and a key of
 * `gloa/refund/<order-id>` would let Resend swallow every one after the
 * first. The customer would hear about the first 10,00 EUR and never
 * about the remaining 39,90.
 *
 * THE CUMULATIVE TOTAL IS THE VERSION. `<refunded-total-cents>` is
 * appended, and it is exactly the right discriminator:
 *
 *   * it is derived entirely from persisted state
 *     (orders.refunded_total_cents), so the key is reproducible from the
 *     database alone
 *   * it is monotonic - settled refunds never un-settle, so the value
 *     only ever grows
 *   * it is identical for every attempt at the SAME fact, so a retry of a
 *     failed send cannot become a second email
 *   * it differs for every materially different fact, so a genuinely
 *     larger refund is genuinely a new message
 *
 * NO PII, NO REASON, NO RANDOM, NO TIMESTAMP. A customer email or name
 * has no business in a request header. A timestamp or a random value
 * would make every attempt a different key, which is precisely the
 * property an idempotency key must not have. The amount is not PII: it is
 * a property of the order, it is already in the message body, and it
 * identifies nobody.
 *
 * The prefix namespaces it against gloa/internal-order/, gloa/shipment/,
 * gloa/cancellation-request/ and gloa/cancellation-outcome/.
 *
 * Deliberately NOT hashed: the key travels to Resend over TLS in an
 * Idempotency-Key header, it carries no secret, and a readable key is
 * worth more in a provider log than an opaque digest.
 */
export function refundConfirmationIdempotencyKey(orderId: string, refundedTotalCents: number): string {
  return `gloa/refund/${orderId}/${refundedTotalCents}`;
}

const BRAND = {
  blue: "#1746D1",
  berry: "#A61E59",
  cream: "#F5EBE2",
  plum: "#4F3A5B",
  ink: "#111111",
};

/** Where a customer replies. Matches the other customer order emails. */
const SUPPORT_ADDRESS = "support@gloamatcha.com";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmtCents(cents: number): string {
  return (cents / 100).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * The copy for each kind, in one place so the HTML and the plain text can
 * never say different things.
 *
 * Read these as the specification. Every sentence is true of every refund
 * that can legitimately reach it, with no further facts required.
 *
 *   PARTIAL  is reached when the cumulative settled total is above zero
 *            and below what the order was charged. It states the amount
 *            and stops. It does NOT say the rest is coming, does not say
 *            the rest is not coming, and does not characterise the
 *            difference at all.
 *
 *   FULL     is reached when the cumulative settled total has reached
 *            what the order was charged. "Vollständig erstattet" is then
 *            a fact, not a projection.
 *
 * Both close on the same sentence about the return path. It describes how
 * a Stripe refund works - back the way it came - without naming an
 * account, a card or a number of days.
 */
const COPY: Readonly<Record<RefundKind, {
  eyebrow: string;
  subjectPrefix: string;
  headline: string;
  lead: string;
}>> = Object.freeze({
  partial: {
    eyebrow: "Teilerstattung",
    subjectPrefix: "Teilerstattung für deine Bestellung",
    headline: "Ein Teil deiner Zahlung wurde erstattet.",
    lead: "Wir haben einen Teilbetrag deiner Bestellung erstattet.",
  },
  full: {
    eyebrow: "Erstattet",
    subjectPrefix: "Deine Bestellung wurde erstattet",
    headline: "Deine Zahlung wurde vollständig erstattet.",
    lead: "Wir haben den vollen Betrag deiner Bestellung erstattet.",
  },
});

/**
 * The one sentence about where the money goes.
 *
 * Says only what is true of every Stripe refund: it returns along the
 * original payment path. No account, no card brand, no last four digits,
 * and above all no number of working days - the issuer decides that and
 * this application stores nothing about it.
 */
const RETURN_PATH_LINE = "Die Gutschrift geht auf dem Weg zurück, den du bezahlt hast.";

/** The closing line. A question, never a promise about further money. */
const SUPPORT_LINE = "Wenn etwas nicht passt, melde dich einfach bei uns.";

/**
 * Builds the customer's refund confirmation (subject + HTML + plain text).
 *
 * The order number is the only database string that reaches the markup
 * and it still goes through escapeHtml: a template that escapes only what
 * it currently expects to be dangerous is one edit away from not escaping
 * enough. The amounts are formatted numbers and cannot carry markup.
 */
export function buildRefundConfirmationEmail(params: {
  order: RefundConfirmationOrder;
}): BuiltRefundConfirmationEmail {
  const { order } = params;
  const copy = COPY[order.kind];

  const amount = `${fmtCents(order.refundedTotalCents)} ${order.currency}`;
  const subject = `${copy.subjectPrefix} - ${order.order_number}`;

  // Only rows whose value actually exists and actually helps. A partial
  // refund shows the order total alongside the refunded amount so the
  // customer can see the relationship; a full refund does not, because
  // the two are the same number and printing it twice reads as an error.
  const factRows: [string, string][] = [
    ["Bestellnummer", order.order_number],
    ["Erstatteter Betrag", amount],
    ...(order.kind === "partial"
      ? ([["Bestellwert", `${fmtCents(order.originalTotalGrossCents)} ${order.currency}`]] as [string, string][])
      : []),
  ];

  const factRowsHtml = factRows
    .map(
      ([label, value]) => `<tr>
<td style="padding:6px 0;font-size:14px;color:#6b6258;">${escapeHtml(label)}</td>
<td align="right" style="padding:6px 0;font-size:14px;white-space:nowrap;color:${BRAND.ink};">${escapeHtml(value)}</td>
</tr>`
    )
    .join("");

  const accountLinkHtml = order.accountOrderUrl
    ? `<p style="font-size:13px;margin:24px 0 0;"><a href="${escapeHtml(order.accountOrderUrl)}" style="color:${BRAND.blue};">Bestellung in deinem Konto ansehen &rarr;</a></p>`
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
<p style="font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:${BRAND.berry};font-weight:700;margin:0 0 10px;">${escapeHtml(copy.eyebrow)}</p>
<h1 style="font-size:22px;line-height:1.2;letter-spacing:-0.02em;margin:0 0 14px;color:${BRAND.ink};">${escapeHtml(copy.headline)}</h1>
<p style="font-size:14px;line-height:1.6;margin:0 0 18px;color:${BRAND.ink};">${escapeHtml(copy.lead)}</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:2px solid ${BRAND.plum};padding-top:6px;">${factRowsHtml}</table>
<p style="font-size:14px;line-height:1.6;margin:22px 0 0;color:${BRAND.ink};">${escapeHtml(RETURN_PATH_LINE)}</p>
<p style="font-size:14px;line-height:1.6;margin:10px 0 0;color:${BRAND.ink};">${escapeHtml(SUPPORT_LINE)}</p>
${accountLinkHtml}
</td></tr>
<tr><td style="background-color:${BRAND.plum};padding:20px 32px;">
<p style="font-size:12px;line-height:1.5;color:${BRAND.cream};margin:0;">GLOA &middot; Fragen zu deiner Bestellung? <a href="mailto:${SUPPORT_ADDRESS}" style="color:${BRAND.cream};">${SUPPORT_ADDRESS}</a></p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

  const accountLinkText = order.accountOrderUrl
    ? `\nBestellung in deinem Konto ansehen: ${order.accountOrderUrl}`
    : "";

  const text = [
    `GLOA · ${copy.eyebrow}`,
    "",
    copy.headline,
    copy.lead,
    "",
    ...factRows.map(([label, value]) => `${label}: ${value}`),
    "",
    RETURN_PATH_LINE,
    SUPPORT_LINE,
    accountLinkText,
    "",
    `Fragen zu deiner Bestellung? ${SUPPORT_ADDRESS}`,
  ]
    .filter(line => line !== "")
    .join("\n");

  return { subject, html, text };
}
