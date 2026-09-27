import {
  legalLinks,
  legalLinksText,
  emailShell,
  emailHeader,
  emailEyebrow,
  emailHeadline,
  emailFooter,
  GLOA_NEAR_BLACK,
  GLOA_BERRY,
} from "./brand.ts";

/**
 * "Deine GLOA Abo-Kündigung wurde bestätigt" - the customer's subscription
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

/** The facts the message may state. Both instants come from the event. */
export type CancellationConfirmationFactsForEmail = {
  /** When the customer asked, as a canonical instant. */
  requestedAtIso: string;
  /** When the subscription ends, as a canonical instant. */
  effectiveAtIso: string;
  /**
   * The customer's first name, from the frozen customer_snapshot. Optional
   * and nullable: the greeting drops the name rather than addressing an
   * empty string or inventing one.
   */
  firstName?: string | null;
  /**
   * "GLOA Matcha 30 g", from the frozen SKU. Optional and nullable: the
   * product line is omitted rather than naming a product this subscription
   * cannot be proven to deliver.
   */
  packageName?: string | null;
  /**
   * 4, and only when the frozen plan proved it. Optional and nullable: a
   * cadence is stated or it is not, and it is never assumed.
   */
  cadenceWeeks?: number | null;
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

const SUBJECT = "Deine GLOA Abo-Kündigung wurde bestätigt";
const EYEBROW = "Kündigung bestätigt";
const HEADLINE = "Deine Kündigung ist bei uns eingegangen.";

/**
 * Read these as the specification. Every sentence is true of every
 * subscription that can legitimately reach this template: the preflight in
 * lib/subscriptionEmailDeliveryRules.ts has already proven the
 * cancellation is persisted, still current, and not yet carried out.
 */
const INTRO = "wir bestätigen dir die Kündigung deines GLOA Abos.";
const END_LABEL = "Dein Abo endet am:";
const CONTINUES = "Bis dahin bleibt dein bereits bezahlter Zeitraum bestehen.";

/**
 * ══════════════════════════════════════════════════════════════
 * THE TWO MONEY SENTENCES, AND WHY BOTH ARE HERE.
 * ══════════════════════════════════════════════════════════════
 *
 * NO FURTHER BILLING. This is the thing a customer who has just cancelled
 * a recurring contract actually needs told, and the cancellation genuinely
 * guarantees it: lib/subscriptionCancellation.ts sets an absolute cancel_at
 * at Stripe with proration_behavior 'none', or defers exactly one already
 * promised cycle and then sets it. After the end date there is no further
 * charge, so saying so is a statement of what was scheduled and not a
 * promise this template invents.
 *
 * NO AUTOMATIC REFUND. The other half, and the half a cancellation
 * confirmation is tempted to leave out. This flow creates no refund at
 * all - the module header of lib/subscriptionCancellation.ts says so and
 * tests assert it - so a customer who reads "Kündigung bestätigt" and
 * infers money coming back has been misled by omission. The paid period is
 * described as STILL RUNNING rather than as refunded, which is what it is.
 *
 * Neither sentence names a sum, a card, an invoice or a date other than the
 * contract end, because none of those is pinned by this delivery's event.
 */
const NO_FURTHER_BILLING = "Es erfolgt keine weitere Abbuchung nach dem Vertragsende.";
const NO_AUTOMATIC_REFUND =
  "Bereits erfolgte Zahlungen werden durch die Kündigung nicht automatisch erstattet.";

const ACCOUNT_LINE = "Den aktuellen Stand deines Abos findest du jederzeit in deinem GLOA Konto.";
const SIGN_OFF_LINE = "Liebe Grüße";
const SIGN_OFF_NAME = "GLOA";

/**
 * "Hallo Mia," or "Hallo," - never "Hallo null," and never a fabricated
 * name. The comma belongs to the greeting, so INTRO reads as its
 * continuation in both cases.
 */
function greeting(firstName: string | null | undefined): string {
  const name = typeof firstName === "string" ? firstName.trim() : "";
  return name ? `Hallo ${name},` : "Hallo,";
}

/**
 * "GLOA Matcha 30 g · alle 4 Wochen" - the one product line.
 *
 * Built from whichever halves were proven. Neither half is invented: no
 * product means no line at all, and no proven cadence means the product
 * without a rhythm rather than a rhythm nobody agreed to. And never the
 * word for a twelve-times-a-year cycle, because this is thirteen.
 */
function productLine(
  packageName: string | null | undefined,
  cadenceWeeks: number | null | undefined
): string | null {
  const name = typeof packageName === "string" ? packageName.trim() : "";
  if (!name) return null;
  const weeks = typeof cadenceWeeks === "number" && Number.isInteger(cadenceWeeks) && cadenceWeeks > 0
    ? cadenceWeeks
    : null;
  return weeks ? `${name} · alle ${weeks} Wochen` : name;
}

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
  /**
   * Absolute site origin, for the logo in the mail header. Optional:
   * without it the mail is built without the mark rather than with a
   * broken image, which is what a relative path becomes in an inbox.
   */
  origin?: string;
}): BuiltCancellationConfirmationEmail {
  const { cancellation } = params;

  const endsOn = fmtDate(cancellation.effectiveAtIso);
  const requestedOn = fmtDate(cancellation.requestedAtIso);
  const hello = greeting(cancellation.firstName);
  const product = productLine(cancellation.packageName, cancellation.cadenceWeeks);

  const helloHtml = `<p style="font-size:14px;line-height:1.6;margin:0 0 16px;color:${BRAND.ink};">${escapeHtml(hello)}</p>`;

  // What the ending subscription delivers, when the frozen plan proved it.
  // Omitted rather than guessed - see productLine.
  const productHtml = product
    ? `<p style="font-size:14px;line-height:1.5;font-weight:600;margin:0 0 20px;color:${BRAND.plum};">${escapeHtml(product)}</p>`
    : "";

  // The end date is the point of the message. Its absence cannot be
  // papered over, so the line is omitted rather than rendered empty, and
  // the neutral sentences below still stand on their own.
  const endLineHtml = endsOn
    ? `<p style="font-size:14px;line-height:1.5;margin:0 0 6px;color:${BRAND.ink};">${escapeHtml(END_LABEL)}</p>
<p style="font-size:20px;line-height:1.3;font-weight:700;margin:0 0 16px;color:${BRAND.ink};">${escapeHtml(endsOn)}</p>`
    : "";

  const requestedLineHtml = requestedOn
    ? `<p style="font-size:13px;line-height:1.5;margin:0 0 16px;color:${BRAND.plum};">Eingegangen am ${escapeHtml(requestedOn)}</p>`
    : "";

  const accountLinkHtml = cancellation.accountSubscriptionsUrl
    ? `<p style="font-size:13px;margin:24px 0 0;"><a href="${escapeHtml(cancellation.accountSubscriptionsUrl)}" style="color:${BRAND.blue};">Abo in deinem Konto ansehen &rarr;</a></p>`
    : "";

    // The approved mark, when an origin was supplied. Without one the
  // mail is built without it rather than with a broken image - the
  // same rule the launch mails already follow.
  const header = params.origin ? emailHeader(params.origin) : "";

  const html = emailShell(escapeHtml(SUBJECT), `${header}
${emailEyebrow(`${escapeHtml(EYEBROW)}`)}
${emailHeadline(`${escapeHtml(HEADLINE)}`)}
<tr><td style="padding:16px 0 28px 0;font-size:15px;line-height:1.6;color:${GLOA_NEAR_BLACK};">
${helloHtml}
<p style="font-size:14px;line-height:1.6;margin:0 0 20px;color:${BRAND.ink};">${escapeHtml(INTRO)}</p>
${productHtml}
${endLineHtml}
${requestedLineHtml}
<p style="font-size:14px;line-height:1.6;margin:0 0 6px;color:${BRAND.ink};">${escapeHtml(CONTINUES)}</p>
<p style="font-size:14px;line-height:1.6;margin:0 0 16px;color:${BRAND.ink};">${escapeHtml(NO_FURTHER_BILLING)}</p>
<p style="font-size:14px;line-height:1.6;margin:0 0 20px;color:${BRAND.ink};">${escapeHtml(NO_AUTOMATIC_REFUND)}</p>
<p style="font-size:14px;line-height:1.6;margin:0;color:${BRAND.ink};">${escapeHtml(ACCOUNT_LINE)}</p>
${accountLinkHtml}
<p style="font-size:14px;line-height:1.6;margin:24px 0 0;color:${BRAND.ink};">${escapeHtml(SIGN_OFF_LINE)}<br/>${escapeHtml(SIGN_OFF_NAME)}</p>
</td></tr>
${emailFooter(`Fragen zu deinem Abo? <a href="mailto:${SUPPORT_ADDRESS}" style="color:${GLOA_BERRY};">${SUPPORT_ADDRESS}</a>
<br/><br/>
${legalLinks(params.origin)}`)}`);

  // null is AN OMITTED LINE, "" is a DELIBERATE BLANK. The previous version
  // used "" for both and filtered it, which silently collapsed every
  // paragraph break in the plain-text part along with the optional lines.
  const text = ([
    `GLOA · ${EYEBROW}`,
    "",
    HEADLINE,
    "",
    hello,
    "",
    INTRO,
    "",
    product,
    product ? "" : null,
    endsOn ? `${END_LABEL} ${endsOn}` : null,
    requestedOn ? `Eingegangen am: ${requestedOn}` : null,
    "",
    CONTINUES,
    NO_FURTHER_BILLING,
    "",
    NO_AUTOMATIC_REFUND,
    "",
    ACCOUNT_LINE,
    cancellation.accountSubscriptionsUrl
      ? `Abo in deinem Konto ansehen: ${cancellation.accountSubscriptionsUrl}`
      : null,
    "",
    SIGN_OFF_LINE,
    SIGN_OFF_NAME,
    "",
    `Fragen zu deinem Abo? ${SUPPORT_ADDRESS}`,
    legalLinksText(params.origin),
  ] as readonly (string | null)[])
    .filter((line): line is string => line !== null)
    .join("\n");

  return { subject: SUBJECT, html, text };
}
