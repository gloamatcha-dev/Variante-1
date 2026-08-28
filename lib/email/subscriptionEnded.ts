/**
 * "Dein GLOA Abo ist beendet" - the customer's subscription ending
 * (Phase 3H.4).
 *
 * The tenth message in the family and the third and last of migration
 * 035's subscription lifecycle set. Pure: no database, no Stripe, no
 * Resend, no environment read and no relative import.
 *
 * ══════════════════════════════════════════════════════════════
 * THIS IS THE ENDING. IT IS NOT A CANCELLATION CONFIRMATION.
 * ══════════════════════════════════════════════════════════════
 *
 * lib/email/cancellationConfirmation.ts says "we have your cancellation,
 * your subscription ends on X, until then it runs as agreed". THIS
 * message says the opposite half: it is over now. They are two different
 * customer facts on two different days and they are deliberately two
 * different templates - merging them would mean one of the two lying.
 *
 * So no "Kündigung vorgemerkt", no "wir haben deine Kündigung erhalten",
 * and no "dein Abo endet am". Those are all forward-looking and all
 * belong to the confirmation. Here everything is past tense.
 *
 * ── IT DOES NOT CLAIM A REASON ────────────────────────────────
 *
 * customer.subscription.deleted is the final authority on the fact that a
 * subscription ended. It is NOT authority on WHY. A subscription can
 * reach that event through the customer's own cancellation, through an
 * operator ending it in the Stripe Dashboard, or through Stripe's own
 * dunning giving up - and nothing durable in this system distinguishes
 * them at the moment this renders.
 *
 * So there is no "wie von dir gewünscht", no "auf deinen Wunsch" and no
 * "deine Kündigung wurde ausgeführt". Telling a customer their own
 * cancellation was carried out when an operator ended it, or when a
 * failed payment did, would be a small lie in the one message they are
 * most likely to reply to. The copy is reason-neutral and every sentence
 * is true however the ending came about.
 *
 * ── THE DATE IS SHOWN, AND IT IS PROVABLY STABLE ──────────────
 *
 * subscriptions.cancelled_at has exactly ONE writer in the schema:
 * migration 034's mark_subscription_cancelled. It writes
 * coalesce(p_cancelled_at, now()) on the first transition and then
 * refuses to touch it - a redelivered deletion hits the early
 * 'already_cancelled' return before the UPDATE, and its own comment says
 * cancelled_at is deliberately not moved. p_cancelled_at is Stripe's
 * subscription.ended_at, so the value describes the actual termination
 * rather than a previously promised end date.
 *
 * One writer, written once, never moved: the same instant is read by the
 * first attempt and by a retry days later. That is what makes it safe to
 * print, and it is why cancellation_effective_at is NOT used here - that
 * column is rewritten by two other functions and describes a promise
 * rather than the event.
 *
 * It is still nullable in the type. A row that somehow carries no
 * cancelled_at loses the date line rather than the whole message.
 *
 * ── WHAT IT DOES NOT REPEAT ───────────────────────────────────
 *
 * No plan, no package, no price, no cadence and no next date. None of it
 * is what the customer needs at this moment, and every extra fact is
 * another column that could move between the claim and the send.
 */

export type BuiltSubscriptionEndedEmail = {
  subject: string;
  html: string;
  text: string;
};

/** The facts the ending may state. */
export type SubscriptionEndedFactsForEmail = {
  /** When it ended, as a canonical instant, or null when the row has none. */
  endedAtIso: string | null;
  /** Where past orders and the account live, or null without SITE_URL. */
  accountUrl: string | null;
};

/**
 * The Resend idempotency key for one subscription's ending.
 *
 * THE SUBSCRIPTION ID IS THE WHOLE INPUT, and the same proof that makes
 * it the delivery row's event_key makes it correct here: 'cancelled' is
 * terminal, the row can never be reactivated and can never be attached to
 * a replacement Stripe subscription, so one subscription ends at most
 * once. A customer who subscribes again gets a new subscriptions row and
 * correctly its own ending message under its own key.
 *
 * NOT the Stripe event id. customer.subscription.deleted is redelivered
 * for up to three days and an operator can resend it from the Dashboard;
 * every one of those carries a new event id, and keying on it would make
 * each redelivery a fresh key - exactly what an idempotency key must not
 * do. NOT cancelled_at either: it is stable, but it is a value the
 * message CONTAINS rather than the identity of the event.
 *
 * The prefix namespaces it against gloa/internal-order/, gloa/shipment/,
 * gloa/cancellation-request/, gloa/cancellation-outcome/, gloa/refund/,
 * gloa/subscription-started/ and gloa/cancellation-confirmation/, and
 * against the two STRIPE keys in lib/subscriptionCancellationRules.ts,
 * which are not Resend keys at all.
 *
 * Deliberately NOT hashed: the key travels to Resend over TLS in an
 * Idempotency-Key header, it carries no secret, and a readable key is
 * worth more in a provider log than an opaque digest.
 */
export function subscriptionEndedIdempotencyKey(subscriptionId: string): string {
  return `gloa/subscription-ended/${subscriptionId}`;
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

/**
 * A German calendar date, pinned to Europe/Berlin.
 *
 * Server-side and timezone-fixed, exactly as
 * lib/email/cancellationRequestNotification.ts and
 * lib/email/cancellationConfirmation.ts do it. This renders on a server
 * with no browser timezone to borrow, and a date that shifted with the
 * renderer would be a different date in a retry.
 */
function fmtDate(value: string): string | null {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleDateString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "Europe/Berlin",
  });
}

const SUBJECT = "Dein GLOA Abo ist beendet";
const EYEBROW = "Abo beendet";
const HEADLINE = "Dein GLOA Abo ist jetzt beendet.";

/**
 * Read these as the specification. Every sentence is true of every
 * subscription that can legitimately reach this template, whatever ended
 * it, and stays true however late the message is delivered.
 *
 *   NO FURTHER DELIVERIES  is exactly what a terminated subscription
 *                          guarantees, and it is scoped to this
 *                          subscription so it cannot be read as a claim
 *                          about a one-off order the customer may also
 *                          have placed.
 *   PAST ORDERS REMAIN     migration 034's own comment is explicit that
 *                          termination writes two columns and touches
 *                          nothing on public.orders, so the deliveries
 *                          that were paid for stay exactly as they are.
 *   COME BACK ANY TIME     an invitation, not a promise about a stored
 *                          plan or a price. Nothing is reactivated by
 *                          this system, and the copy does not imply it.
 */
const NO_MORE_DELIVERIES = "Aus diesem Abo werden keine weiteren Lieferungen versendet.";
const PAST_ORDERS = "Deine bisherigen Bestellungen bleiben in deinem Konto verfügbar.";
const CLOSING = "Danke, dass du dabei warst. Du kannst jederzeit wieder ein Abo starten.";

/**
 * Builds the customer's subscription ending (subject, HTML, plain text).
 *
 * The formatted date is the only value that reaches the markup, it is
 * server-built from an instant rather than from customer input, and it
 * still goes through escapeHtml for the reason
 * lib/email/cancellationOutcome.ts gives about the order number.
 */
export function buildSubscriptionEndedEmail(params: {
  subscription: SubscriptionEndedFactsForEmail;
}): BuiltSubscriptionEndedEmail {
  const { subscription } = params;

  const endedOn = subscription.endedAtIso ? fmtDate(subscription.endedAtIso) : null;

  const endedLineHtml = endedOn
    ? `<p style="font-size:13px;line-height:1.5;margin:0 0 16px;color:${BRAND.plum};">Beendet am ${escapeHtml(endedOn)}</p>`
    : "";

  const accountLinkHtml = subscription.accountUrl
    ? `<p style="font-size:13px;margin:24px 0 0;"><a href="${escapeHtml(subscription.accountUrl)}" style="color:${BRAND.blue};">Zu deinem GLOA Konto &rarr;</a></p>`
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
${endedLineHtml}
<p style="font-size:14px;line-height:1.6;margin:0 0 12px;color:${BRAND.ink};">${escapeHtml(NO_MORE_DELIVERIES)}</p>
<p style="font-size:14px;line-height:1.6;margin:0 0 12px;color:${BRAND.ink};">${escapeHtml(PAST_ORDERS)}</p>
<p style="font-size:14px;line-height:1.6;margin:0;color:${BRAND.ink};">${escapeHtml(CLOSING)}</p>
${accountLinkHtml}
</td></tr>
<tr><td style="background-color:${BRAND.plum};padding:20px 32px;">
<p style="font-size:12px;line-height:1.5;color:${BRAND.cream};margin:0;">GLOA &middot; Fragen? <a href="mailto:${SUPPORT_ADDRESS}" style="color:${BRAND.cream};">${SUPPORT_ADDRESS}</a></p>
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
    endedOn ? `Beendet am: ${endedOn}` : "",
    "",
    NO_MORE_DELIVERIES,
    PAST_ORDERS,
    CLOSING,
    subscription.accountUrl ? `Zu deinem GLOA Konto: ${subscription.accountUrl}` : "",
    "",
    `Fragen? ${SUPPORT_ADDRESS}`,
  ]
    .filter(line => line !== "")
    .join("\n");

  return { subject: SUBJECT, html, text };
}
