/**
 * "Deine Abo-Zahlung konnte nicht abgeschlossen werden" - the customer's
 * payment problem notice (Phase 3I.B2).
 *
 * The eleventh message in the family and the fourth subscription
 * lifecycle one. Pure: no database, no Stripe, no Resend, no environment
 * read and no relative import.
 *
 * ══════════════════════════════════════════════════════════════
 * IT PROMISES NO ACTION THIS PRODUCT CANNOT PERFORM.
 * ══════════════════════════════════════════════════════════════
 *
 * There is no Stripe Billing Portal in this repository, no payment-method
 * update flow, no "pay now" link and no retry button. A search of the
 * codebase finds none of them, and Phase 3I.A confirmed it.
 *
 * So this message must NOT say "Zahlungsmethode aktualisieren", must not
 * offer a retry, and must not link anywhere that would 404 or dead-end.
 * Inventing a repair flow in copy is worse than admitting there is none:
 * a customer who clicks and finds nothing has been told twice that
 * something is broken.
 *
 * What it says instead is what the account UI already says for exactly
 * these states. lib/subscriptionCancellationRules.ts renders "Die letzte
 * Abbuchung hat noch nicht geklappt. Sie wird automatisch erneut
 * versucht." for past_due and "Melde dich bei uns, dann klären wir das
 * gemeinsam." for unpaid. The email uses the same honest register, so the
 * inbox and the account page cannot contradict each other.
 *
 * ── IT CLAIMS NO ORDER AND NO SHIPMENT ────────────────────────
 *
 * A failed invoice creates nothing: no order, no shipment, no
 * fulfillment notification. The copy therefore never mentions a
 * Bestellung, a Lieferung on the way or a Sendung, because none exists
 * for this cycle.
 *
 * ── AND IT NEVER SAYS THE PAYMENT SUCCEEDED ───────────────────
 *
 * There is deliberately no recurring payment-success email in this
 * system, and this message must not imply one is coming.
 *
 * ── NO AMOUNT, NO DATE, NO INVOICE NUMBER ─────────────────────
 *
 * Every one of those is a moving value at retry time. The message is
 * retry-stable precisely because it states a condition rather than a
 * figure: the delivery may be sent minutes or days after it was claimed,
 * and nothing in the copy can have gone stale in between.
 */

export type BuiltPaymentProblemEmail = {
  subject: string;
  html: string;
  text: string;
};

/** The facts the message may state. There are deliberately almost none. */
export type PaymentProblemFactsForEmail = {
  /** Where the customer can see the subscription, or null without SITE_URL. */
  accountSubscriptionsUrl: string | null;
};

/**
 * The Resend idempotency key for one payment problem.
 *
 * KEYED ON THE INVOICE, not on the subscription. One subscription can
 * legitimately owe several of these over its life - one per failed
 * billing cycle - so a subscription-only key would let Resend swallow
 * every warning after the first and a customer would never hear about a
 * second failed cycle.
 *
 * The subscription id is carried too, matching the shape
 * gloa/cancellation-confirmation/ already uses, so a provider log line
 * names both the customer's subscription and the exact cycle.
 *
 * STABLE ACROSS STRIPE'S RETRIES. Smart Retries reattempt the SAME
 * invoice, so every attempt produces this same key - which is the point:
 * the customer is warned once per cycle, not once per attempt.
 *
 * NOT the Stripe event id, NOT attempt_count, NOT a timestamp. Each of
 * those changes per attempt and would defeat the key entirely.
 */
export function paymentProblemIdempotencyKey(subscriptionId: string, invoiceId: string): string {
  return `gloa/payment-problem/${subscriptionId}/${invoiceId}`;
}

const BRAND = {
  blue: "#1746D1",
  berry: "#A61E59",
  cream: "#F5EBE2",
  plum: "#4F3A5B",
  ink: "#111111",
};

/** Where a customer replies. Matches the other customer messages. */
const SUPPORT_ADDRESS = "support@gloamatcha.com";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const SUBJECT = "Deine Abo-Zahlung konnte nicht abgeschlossen werden";
const EYEBROW = "Zahlung offen";
const HEADLINE = "Die Zahlung für dein Abo hat nicht geklappt.";

/**
 * Read these as the specification. Every sentence is true of every
 * subscription that can legitimately reach this template: the preflight
 * has proven the subscription is live, private, genuinely started, not
 * terminally cancelled, and that the invoice is STILL open at Stripe.
 *
 *   INTRO       states the condition and nothing more. No amount, no
 *               date, no invoice number - all of them move.
 *   NO_PARCEL   the honest consequence, and the one the customer most
 *               needs: this cycle produced no order and nothing is on
 *               its way for it.
 *   HELP        the only real action this product offers today. It
 *               deliberately mirrors the account page's own wording for
 *               an unpaid subscription rather than inventing a flow.
 */
const INTRO = "Für dein GLOA Abo konnte die letzte Zahlung nicht abgeschlossen werden.";
const NO_PARCEL = "Für diesen Zeitraum wurde deshalb noch nichts versendet.";
const HELP = "Melde dich einfach bei uns, dann klären wir das gemeinsam.";
const ACCOUNT_LINE = "Den Stand deines Abos siehst du jederzeit in deinem GLOA Konto.";

/**
 * Builds the customer's payment problem notice (subject, HTML, text).
 *
 * The account URL is the only value that reaches the markup, and it
 * still goes through escapeHtml for the reason
 * lib/email/cancellationOutcome.ts gives about the order number.
 */
export function buildPaymentProblemEmail(params: {
  payment: PaymentProblemFactsForEmail;
}): BuiltPaymentProblemEmail {
  const { payment } = params;

  const accountLinkHtml = payment.accountSubscriptionsUrl
    ? `<p style="font-size:13px;margin:24px 0 0;"><a href="${escapeHtml(payment.accountSubscriptionsUrl)}" style="color:${BRAND.blue};">Abo in deinem Konto ansehen &rarr;</a></p>`
    : "";

  const html = `<!doctype html>
<html lang="de">
<head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${escapeHtml(SUBJECT)}</title></head>
<body style="margin:0;padding:0;background-color:${BRAND.cream};font-family:Arial,Helvetica,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${BRAND.cream};padding:32px 16px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;">
<tr><td style="background-color:${BRAND.blue};padding:20px 32px;">
<span style="font-size:22px;font-weight:900;color:${BRAND.cream};letter-spacing:-0.03em;">GLOA</span>
</td></tr>
<tr><td style="padding:32px;">
<p style="font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:${BRAND.berry};font-weight:700;margin:0 0 10px;">${escapeHtml(EYEBROW)}</p>
<h1 style="font-size:22px;line-height:1.2;letter-spacing:-0.02em;margin:0 0 14px;color:${BRAND.ink};">${escapeHtml(HEADLINE)}</h1>
<p style="font-size:14px;line-height:1.6;margin:0 0 12px;color:${BRAND.ink};">${escapeHtml(INTRO)}</p>
<p style="font-size:14px;line-height:1.6;margin:0 0 12px;color:${BRAND.ink};">${escapeHtml(NO_PARCEL)}</p>
<p style="font-size:14px;line-height:1.6;margin:0 0 12px;color:${BRAND.ink};">${escapeHtml(HELP)}</p>
<p style="font-size:14px;line-height:1.6;margin:0;color:${BRAND.ink};">${escapeHtml(ACCOUNT_LINE)}</p>
${accountLinkHtml}
</td></tr>
<tr><td style="background-color:${BRAND.plum};padding:20px 32px;">
<p style="font-size:12px;line-height:1.5;color:${BRAND.cream};margin:0;">GLOA &middot; Fragen zu deinem Abo? <a href="mailto:${SUPPORT_ADDRESS}" style="color:${BRAND.cream};">${SUPPORT_ADDRESS}</a></p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

  const text = [
    `GLOA · ${EYEBROW}`,
    "",
    HEADLINE,
    INTRO,
    NO_PARCEL,
    HELP,
    "",
    ACCOUNT_LINE,
    payment.accountSubscriptionsUrl
      ? `Abo in deinem Konto ansehen: ${payment.accountSubscriptionsUrl}`
      : "",
    "",
    `Fragen zu deinem Abo? ${SUPPORT_ADDRESS}`,
  ]
    .filter(line => line !== "")
    .join("\n");

  return { subject: SUBJECT, html, text };
}
