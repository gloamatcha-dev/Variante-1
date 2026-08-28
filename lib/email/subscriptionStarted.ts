/**
 * "Dein GLOA Abo ist aktiv" - the customer's subscription start message
 * (Phase 3H.2).
 *
 * The seventh message in the family and the FIRST one a B2C subscription
 * has ever produced for the customer. Until this phase a subscriber could
 * pay a first invoice, pay renewals, cancel and watch the subscription end
 * without GLOA ever writing to them about the subscription itself; the
 * only mail a paid cycle raised went to the internal fulfillment inbox.
 *
 * Pure. No database, no Stripe, no Resend, no environment read - the same
 * shape as the six templates beside it, and the reason each of them is
 * directly unit-testable.
 *
 * ══════════════════════════════════════════════════════════════
 * THERE IS NO NEXT-BILLING DATE IN THIS MESSAGE, DELIBERATELY.
 * ══════════════════════════════════════════════════════════════
 *
 * The obvious sentence to write here is "Nächste Abrechnung: 3. Oktober".
 * It is not written, and the reason is not squeamishness about dates.
 *
 * No stable first-cycle billing date exists to print. The two candidates
 * are both moving values:
 *
 *   subscriptions.current_period_end   is a RECONCILED MIRROR of Stripe.
 *                                      The customer.subscription.updated
 *                                      handler writes it from an event
 *                                      that is not a payment, so it can
 *                                      advance at any time.
 *   the invoice's own period end       belongs to the invoice, not to the
 *                                      message, and a later attempt would
 *                                      have to re-read a different one.
 *
 * This message is retry-stable state: migration 035 keeps the claim alive
 * until it is genuinely sent, and a send can therefore happen minutes or
 * days after the claim - after a failed provider call, after a Stripe
 * redelivery, or from the sweep a later phase will build. A date rendered
 * from either candidate at THAT moment could name a period the customer's
 * first payment never bought. Printing nothing is not a gap; it is the
 * only honest option available, and the account page shows the live date.
 *
 * WHAT IS PRINTED INSTEAD IS THE CADENCE, and it arrives as a number
 * proven from the frozen plan snapshot rather than as a constant in this
 * file. "Alle 4 Wochen" is true for the whole life of the subscription and
 * cannot go stale between the claim and the send.
 *
 * NEVER "monatlich". A four-week cycle is thirteen deliveries a year, not
 * twelve, and calling it monthly would misstate both the rhythm and the
 * annual cost.
 *
 * ── WHAT IS NOT MENTIONED ─────────────────────────────────────
 *
 * No Stripe, no invoice id, no subscription id, no event key, no delivery
 * status, no webhook, no RPC, no last_paid_period_end and nothing from the
 * internal order. None of it is the customer's business and several of
 * them are internal identifiers that must not leave the server.
 */

export type BuiltSubscriptionStartedEmail = {
  subject: string;
  html: string;
  text: string;
};

/** The facts the message may state. Every one comes off a frozen snapshot. */
export type SubscriptionStartedFacts = {
  /** The frozen plan name, or null when the snapshot carried none. */
  packageName: string | null;
  /** Packages per delivery, read from the frozen subscription line. */
  quantity: number;
  /** Weeks between deliveries, read from the frozen plan. */
  cadenceWeeks: number;
  /** Where the customer manages the subscription, or null without SITE_URL. */
  accountSubscriptionsUrl: string | null;
};

/**
 * The Resend idempotency key for one subscription's start message.
 *
 * The provider-side half of the duplicate guard. The database claim in
 * migration 035 stops two workers from both starting a send; this stops an
 * attempt that reached Resend but lost its state write from becoming a
 * second email in the customer's inbox.
 *
 * THE SUBSCRIPTION ID IS THE WHOLE INPUT, and it is the same value the
 * delivery row's event_key carries, for the same reason: a subscription
 * starts exactly once. A second start would be a different subscriptions
 * row and therefore a different key, which is correct.
 *
 * NOT the Stripe event id and NOT the invoice id. A redelivery of the same
 * paid invoice carries a new event id, and keying on one would make every
 * redelivery a fresh key - precisely the property an idempotency key must
 * not have. That is the whole point of this phase's guarantee that a
 * redelivered webhook cannot produce a second message.
 *
 * The prefix namespaces it against every other GLOA message:
 * gloa/internal-order/, gloa/shipment/, gloa/cancellation-request/,
 * gloa/cancellation-outcome/ and gloa/refund/ are order messages, and
 * gloa/subscription-cancel/ and gloa/subscription-defer/ are STRIPE
 * idempotency keys from lib/subscriptionCancellationRules.ts rather than
 * Resend ones. This is a new and unambiguous namespace and collides with
 * none of them.
 *
 * NO EMAIL, NO NAME, NO AMOUNT, NO TIMESTAMP. The first two are personal
 * data that has no business in a request header, and a timestamp would
 * change per attempt and defeat the key entirely.
 *
 * Deliberately NOT hashed: the key travels to Resend over TLS in an
 * Idempotency-Key header, it carries no secret, and a readable key is
 * worth more in a provider log than an opaque digest.
 */
export function subscriptionStartedIdempotencyKey(subscriptionId: string): string {
  return `gloa/subscription-started/${subscriptionId}`;
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

const SUBJECT = "Dein GLOA Abo ist aktiv";
const EYEBROW = "Abo gestartet";
const HEADLINE = "Dein Matcha Abo ist gestartet.";

/**
 * The one sentence of body copy, plus the pointer to the account.
 *
 * Read these as the specification. Every sentence is true of every
 * subscription that can legitimately reach this template, with no further
 * facts required: the preflight in lib/subscriptionEmailDeliveryRules.ts
 * has already proven the subscription is active, private, billed every
 * four weeks and carries exactly one launch package.
 *
 * The account sentence is the deliberate replacement for a billing date.
 * It points at the one place where the live period, the live price and the
 * cancel control genuinely are, and it stays true however late this
 * message is delivered.
 */
const INTRO = "Danke, dass du dabei bist. Deine erste Zahlung ist angekommen und dein Abo läuft.";
const ACCOUNT_LINE =
  "Alle Details zu deinem Abo und deiner Abrechnung findest du jederzeit in deinem GLOA Konto.";

/** "Alle 4 Wochen" - built from the proven cadence, never hardcoded. */
function cadenceLabel(cadenceWeeks: number): string {
  return `Alle ${cadenceWeeks} Wochen`;
}

/** "1 Packung" / "2 Packungen" - the frozen line, stated truthfully. */
function quantityLabel(quantity: number): string {
  return quantity === 1 ? "1 Packung" : `${quantity} Packungen`;
}

/**
 * Builds the customer's subscription start email (subject + HTML + plain
 * text).
 *
 * The package name is the only database-derived string that reaches the
 * markup, and it still goes through escapeHtml. It is catalog display
 * text rather than customer input, and a template that escapes only what
 * it currently expects to be dangerous is one edit away from not escaping
 * enough - the same reasoning lib/email/cancellationOutcome.ts applies to
 * the order number.
 */
export function buildSubscriptionStartedEmail(params: {
  subscription: SubscriptionStartedFacts;
}): BuiltSubscriptionStartedEmail {
  const { subscription } = params;

  // The package line is omitted rather than faked when the frozen snapshot
  // carries no name. The remaining facts are complete without it.
  const factRows: string[] = [];
  if (subscription.packageName) factRows.push(subscription.packageName);
  factRows.push(quantityLabel(subscription.quantity));
  factRows.push(cadenceLabel(subscription.cadenceWeeks));

  const factsHtml = factRows
    .map(
      (row, index) =>
        `<tr><td style="padding:${index === 0 ? "0" : "8px"} 0 0;font-size:14px;line-height:1.5;color:${BRAND.ink};">${escapeHtml(row)}</td></tr>`
    )
    .join("");

  const accountLinkHtml = subscription.accountSubscriptionsUrl
    ? `<p style="font-size:13px;margin:24px 0 0;"><a href="${escapeHtml(subscription.accountSubscriptionsUrl)}" style="color:${BRAND.blue};">Abo in deinem Konto ansehen &rarr;</a></p>`
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
<p style="font-size:14px;line-height:1.6;margin:0 0 20px;color:${BRAND.ink};">${escapeHtml(INTRO)}</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid ${BRAND.cream};border-bottom:1px solid ${BRAND.cream};padding:16px 0;margin:0 0 20px;">
<tr><td style="padding:16px 0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${factsHtml}</table>
</td></tr>
</table>
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

  const accountLinkText = subscription.accountSubscriptionsUrl
    ? `Abo in deinem Konto ansehen: ${subscription.accountSubscriptionsUrl}`
    : "";

  const text = [
    `GLOA · ${EYEBROW}`,
    "",
    HEADLINE,
    INTRO,
    "",
    ...factRows,
    "",
    ACCOUNT_LINE,
    accountLinkText,
    "",
    `Fragen zu deinem Abo? ${SUPPORT_ADDRESS}`,
  ]
    .filter(line => line !== "")
    .join("\n");

  return { subject: SUBJECT, html, text };
}
