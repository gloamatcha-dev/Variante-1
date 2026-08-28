/**
 * "Wir haben deine Kündigung erhalten" - the customer's subscription
 * cancellation confirmation (Phase 3H.3).
 *
 * The ninth message in the family and the second subscription lifecycle
 * one. Pure: no database, no Stripe, no Resend, no environment read and no
 * relative import, the same shape as the eight templates beside it.
 *
 * ══════════════════════════════════════════════════════════════
 * WHAT THIS MESSAGE CLAIMS, AND WHAT IT CAREFULLY DOES NOT.
 * ══════════════════════════════════════════════════════════════
 *
 * It says the cancellation has been RECEIVED AND SCHEDULED, and names the
 * date the subscription ends. Both are durable facts by the time this can
 * be rendered: lib/cancellationConfirmationEmail.ts only reaches here once
 * cancellation_requested_at and cancellation_effective_at are both
 * persisted and still match the delivery row's event key.
 *
 * NOT "Kündigung angefragt". The cancellation is not a request awaiting a
 * decision - migration 034's schedule_subscription_cancellation has
 * already written it, and Stripe has already been told or will be at the
 * next renewal. Calling it a request would understate what happened.
 *
 * NOT "Abo beendet". The subscription is still running and the customer
 * still has deliveries coming. The ending is a different fact on a
 * different day and gets its own family in a later phase.
 *
 * ── NO EARLY-VERSUS-LATE DISTINCTION, DELIBERATELY ────────────
 *
 * The obvious extra sentence is "Es kommt noch genau eine Lieferung". It
 * is not written, and the reason is retry stability rather than caution.
 *
 * Whether a cancellation was early or late was decided at request time by
 * comparing the request against a cutoff derived from current_period_end -
 * a column that is a RECONCILED MIRROR of Stripe and is rewritten by the
 * customer.subscription.updated handler, which is not a payment. The
 * delivery event pins the two cancellation timestamps and nothing else, so
 * a message rendered from it minutes or days later cannot re-derive that
 * comparison honestly. Counting deliveries would mean reading a moving
 * column at send time and printing a number the first attempt never
 * carried.
 *
 * The neutral sentence is true in both cases and stays true however late
 * the message is delivered: until the end date, the subscription runs as
 * agreed.
 *
 * ── DATES ─────────────────────────────────────────────────────
 *
 * Formatted server-side, in German, pinned to Europe/Berlin, from the
 * instants the event key carries. Never the customer's browser timezone -
 * this renders on a server that has none - and never a raw ISO string in
 * front of a customer. The same approach
 * lib/email/cancellationRequestNotification.ts already uses.
 *
 * No date is CALCULATED here. The end date is read from the event; adding
 * or subtracting anything would invent a fact the database never agreed
 * to.
 *
 * ── WHAT IS NOT MENTIONED ─────────────────────────────────────
 *
 * No Stripe, no Supabase, no subscription id, no invoice id, no event key,
 * no delivery status, no webhook, no RPC and nothing internal. And never
 * "monatlich": a four-week cycle is thirteen deliveries a year, not twelve.
 */

export type BuiltCancellationConfirmationEmail = {
  subject: string;
  html: string;
  text: string;
};

/** The facts the message may state. Both come from the delivery's event. */
export type CancellationConfirmationFactsForEmail = {
  /** When the customer asked, as a canonical instant. */
  requestedAtIso: string;
  /** When the subscription ends, as a canonical instant. */
  effectiveAtIso: string;
  /** Where the customer manages the subscription, or null without SITE_URL. */
  accountSubscriptionsUrl: string | null;
};

/**
 * The Resend idempotency key for one cancellation confirmation.
 *
 * ══════════════════════════════════════════════════════════════
 * THE SUBSCRIPTION ID ALONE WOULD BE WRONG HERE.
 * ══════════════════════════════════════════════════════════════
 *
 * gloa/subscription-started/ keys on the subscription alone, correctly: a
 * subscription starts once. A subscription can legitimately owe MORE THAN
 * ONE cancellation confirmation over its life - the effective date moves
 * when apply_deferred_subscription_cancellation applies a deferred late
 * cancellation, sync_subscription_from_stripe reconciles a Stripe-side
 * change, or the customer cancels again after an unscheduling. A key of
 * `gloa/cancellation-confirmation/<subscription-id>` would let Resend
 * swallow every one of those after the first, and the customer would be
 * left holding a date that has since moved.
 *
 * THE EVENT KEY IS THE VERSION, and it is the same value the delivery
 * row's event_key carries, so the provider guard and the database guard
 * cannot disagree about which cancellation this is. It varies when the
 * persisted pair varies and is identical for every retry of one delivery
 * row, which is exactly what an idempotency key must do.
 *
 * The prefix namespaces it against gloa/internal-order/, gloa/shipment/,
 * gloa/cancellation-request/, gloa/cancellation-outcome/, gloa/refund/ and
 * gloa/subscription-started/. The first is an internal message, the next
 * four are about ORDERS rather than subscriptions - gloa/cancellation-request/
 * and gloa/cancellation-outcome/ in particular are the order cancellation
 * flow and are a different feature entirely - and the last is this
 * family's sibling. gloa/subscription-cancel/ and gloa/subscription-defer/
 * are STRIPE idempotency keys from lib/subscriptionCancellationRules.ts,
 * not Resend ones, and are also distinct.
 *
 * NO EMAIL, NO NAME, NO CLOCK. The two instants in the key are properties
 * of the subscription, are already in the message body, and identify
 * nobody. Deliberately NOT hashed: the key travels to Resend over TLS in
 * an Idempotency-Key header, it carries no secret, and a readable key is
 * worth more in a provider log than an opaque digest.
 */
export function cancellationConfirmationIdempotencyKey(
  subscriptionId: string,
  eventKey: string
): string {
  return `gloa/cancellation-confirmation/${subscriptionId}/${eventKey}`;
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
 * Returns null rather than a fallback when the instant will not parse. A
 * confirmation that cannot state its end date is not silently downgraded
 * to one that states a wrong one; the sender's preflight has already
 * proven both instants exist, so this is the belt to that braces.
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

const SUBJECT = "Wir haben deine Kündigung erhalten";
const EYEBROW = "Kündigung bestätigt";
const HEADLINE = "Deine Kündigung ist bei uns eingegangen.";

/**
 * Read these as the specification. Every sentence is true of every
 * subscription that can legitimately reach this template: the preflight in
 * lib/subscriptionEmailDeliveryRules.ts has already proven the
 * cancellation is persisted, still current, and not yet carried out.
 */
const INTRO = "Wir haben deine Kündigung aufgenommen und alles Weitere veranlasst.";
const CONTINUES = "Bis dahin läuft dein Abo wie vorgesehen weiter - alle 4 Wochen wie gewohnt.";
const ACCOUNT_LINE = "Den aktuellen Stand deines Abos findest du jederzeit in deinem GLOA Konto.";

/**
 * Builds the customer's cancellation confirmation (subject, HTML, text).
 *
 * The two dates are the only values that reach the markup and both are
 * server-formatted from instants, never customer input - and they still go
 * through escapeHtml, for the reason lib/email/cancellationOutcome.ts
 * gives about the order number: a template that escapes only what it
 * currently expects to be dangerous is one edit away from not escaping
 * enough.
 */
export function buildCancellationConfirmationEmail(params: {
  cancellation: CancellationConfirmationFactsForEmail;
}): BuiltCancellationConfirmationEmail {
  const { cancellation } = params;

  const endsOn = fmtDate(cancellation.effectiveAtIso);
  const requestedOn = fmtDate(cancellation.requestedAtIso);

  // The end date is the point of the message. Its absence cannot be
  // papered over, so the line is omitted rather than rendered empty, and
  // the neutral sentences below still stand on their own.
  const endLineHtml = endsOn
    ? `<p style="font-size:14px;line-height:1.5;margin:0 0 6px;color:${BRAND.ink};">Dein GLOA Abo endet am</p>
<p style="font-size:20px;line-height:1.3;font-weight:700;margin:0 0 16px;color:${BRAND.ink};">${escapeHtml(endsOn)}</p>`
    : "";

  const requestedLineHtml = requestedOn
    ? `<p style="font-size:13px;line-height:1.5;margin:0 0 16px;color:${BRAND.plum};">Eingegangen am ${escapeHtml(requestedOn)}</p>`
    : "";

  const accountLinkHtml = cancellation.accountSubscriptionsUrl
    ? `<p style="font-size:13px;margin:24px 0 0;"><a href="${escapeHtml(cancellation.accountSubscriptionsUrl)}" style="color:${BRAND.blue};">Abo in deinem Konto ansehen &rarr;</a></p>`
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
${endLineHtml}
${requestedLineHtml}
<p style="font-size:14px;line-height:1.6;margin:0 0 16px;color:${BRAND.ink};">${escapeHtml(CONTINUES)}</p>
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
    "",
    endsOn ? `Dein GLOA Abo endet am: ${endsOn}` : "",
    requestedOn ? `Eingegangen am: ${requestedOn}` : "",
    "",
    CONTINUES,
    ACCOUNT_LINE,
    cancellation.accountSubscriptionsUrl
      ? `Abo in deinem Konto ansehen: ${cancellation.accountSubscriptionsUrl}`
      : "",
    "",
    `Fragen zu deinem Abo? ${SUPPORT_ADDRESS}`,
  ]
    .filter(line => line !== "")
    .join("\n");

  return { subject: SUBJECT, html, text };
}
