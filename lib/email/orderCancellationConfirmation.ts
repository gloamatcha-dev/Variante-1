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
import type { CancellationRefundWording } from "../orderCancellationConfirmationRules.ts";

/**
 * THE CUSTOMER'S DIRECT CANCELLATION CONFIRMATION.
 *
 * Sent when GLOA cancels an order on its own initiative - out of stock,
 * an address that cannot be delivered to, a duplicate order. The
 * customer asked nothing, so nothing here answers a question.
 *
 * ── WHY THIS IS NOT lib/email/cancellationOutcome.ts ──────────
 *
 * That one is the reply to a cancellation the CUSTOMER REQUESTED, and
 * both of its variants are written as replies: "Wir haben deine
 * Stornierungsanfrage angenommen", "Wir konnten die Stornierung nicht
 * mehr umsetzen". Sending either to somebody who never wrote to us
 * describes a conversation that did not happen. Reusing its state
 * columns would additionally make the two indistinguishable in the
 * admin screen, where an operator genuinely needs to know which of the
 * two the customer received.
 *
 * ── STORNO IS NOT REFUND, AND THIS TEMPLATE PROVES IT ─────────
 *
 * migration 029's cancel_order writes no money column, so a cancelled
 * order routinely still reads payment_status = 'paid'. This email is
 * therefore given the refund state explicitly and says one of exactly
 * three things about it - none refunded, partly refunded, fully
 * refunded - and it has no field through which an amount, a date or a
 * deadline could be invented. A cancellation that claims money has been
 * returned when it has not is the single worst thing this message could
 * do, so the possibility is removed rather than reviewed for.
 *
 * ── NO LEGAL CLAIMS ARE MANUFACTURED ──────────────────────────
 *
 * No invoice is referenced, no tax statement is made, no statutory
 * deadline is quoted, and no processing time is promised. Everything
 * below is either a fact the caller supplied or an offer to answer
 * questions.
 */

/**
 * ONE VOCABULARY, DEFINED ONCE.
 *
 * The three words come from lib/orderCancellationConfirmationRules.ts,
 * which is also what derives them from the order's columns. Re-declaring
 * them here would be two lists that agree until somebody edits one.
 */
export type CancellationRefundState = CancellationRefundWording;

/**
 * Everything this email is allowed to know.
 *
 * DELIBERATELY NARROW. No amount, no currency, no payment status, no
 * items, no address, no carrier, no operator identity, no internal note
 * and no order uuid. The refund state is a WORD, not a number, so there
 * is no field through which a figure could reach a customer's inbox from
 * here - the refund confirmation email is what quotes amounts, and it is
 * sent only when money has genuinely settled back.
 */
export type CancellationConfirmationOrder = {
  order_number: string;
  refundState: CancellationRefundState;
  /** Fully-built account link, or null to omit it (e.g. guest order). */
  accountOrderUrl: string | null;
};

export type BuiltCancellationConfirmationEmail = {
  subject: string;
  html: string;
  text: string;
};

/**
 * The Resend idempotency key for one order's direct cancellation
 * confirmation.
 *
 * Deterministic and derived from the order alone: an order is cancelled
 * once, and the message that says so is the same message however many
 * times the send is attempted.
 *
 * THE NAMESPACE IS "order-cancellation-confirmation", NOT
 * "cancellation-confirmation". The shorter one is already taken by
 * lib/email/cancellationConfirmation.ts, which is the SUBSCRIPTION
 * cancellation confirmation and keys on a subscription id. Two
 * templates sharing a provider namespace is how one message silently
 * suppresses another at Resend, so each family gets its own - and the
 * test suite asserts the namespaces are unique, which is how this
 * collision was caught before it shipped.
 *
 * Also distinct from gloa/cancellation-outcome/<id>, so an order that
 * received both the direct confirmation and a request outcome cannot
 * have them collapse into one.
 */
export function cancellationConfirmationIdempotencyKey(orderId: string): string {
  return `gloa/order-cancellation-confirmation/${orderId}`;
}

const BRAND = {
  blue: "#1746D1",
  berry: "#A61E59",
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

/**
 * What the email says about the money, per refund state.
 *
 * Read these as the specification. Each is true of every order that can
 * reach it, and none requires a fact the template was not given:
 *
 *   none     nothing has settled back. Says so plainly, and promises a
 *            separate message rather than a date - because the refund
 *            confirmation genuinely is a separate message, sent by a
 *            different state machine when the money actually moves.
 *   partial  part has settled. Names no figure: the refund confirmation
 *            already quoted the exact amount when it settled, and a
 *            second, possibly stale number here would contradict it.
 *   full     everything has settled. The one case where this email may
 *            state that money is on its way back, because
 *            refunded_total_cents has reached total_gross_cents.
 */
const REFUND_LINE: Readonly<Record<CancellationRefundState, string>> = Object.freeze({
  none: "Eine Erstattung ist bisher nicht erfolgt. Falls du für diese Bestellung bereits bezahlt hast, melden wir uns separat dazu bei dir.",
  partial: "Ein Teil des Betrags wurde bereits erstattet. Zu jeder Erstattung erhältst du eine eigene Bestätigung per E-Mail.",
  full: "Der Betrag für diese Bestellung wurde bereits vollständig erstattet.",
});

/**
 * Builds the customer's direct cancellation confirmation (subject + HTML
 * + plain text).
 *
 * The order number is the only string that reaches the markup and it
 * still goes through escapeHtml: it comes from a database column, and a
 * template that escapes only what it currently expects to be dangerous
 * is one edit away from not escaping enough.
 */
export function buildCancellationConfirmationEmail(params: {
  order: CancellationConfirmationOrder;
  /**
   * Absolute site origin, for the logo in the mail header. Optional:
   * without it the mail is built without the mark rather than with a
   * broken image, which is what a relative path becomes in an inbox.
   */
  origin?: string;
}): BuiltCancellationConfirmationEmail {
  const { order } = params;

  const eyebrow = "Storniert";
  const headline = "Deine Bestellung wurde storniert.";
  const subject = `Deine Bestellung wurde storniert - ${order.order_number}`;

  const lines = [
    "Wir haben diese Bestellung storniert. Sie wird nicht versendet.",
    REFUND_LINE[order.refundState],
    "Wenn du dazu Fragen hast oder die Bestellung neu aufgeben möchtest, antworte einfach auf diese E-Mail.",
  ];

  const linesHtml = lines
    .map(
      line =>
        `<p style="font-size:14px;line-height:1.6;margin:0 0 12px;color:${BRAND.ink};">${escapeHtml(line)}</p>`
    )
    .join("");

  const accountLinkHtml = order.accountOrderUrl
    ? `<p style="font-size:13px;margin:24px 0 0;"><a href="${escapeHtml(order.accountOrderUrl)}" style="color:${BRAND.blue};">Bestellung in deinem Konto ansehen &rarr;</a></p>`
    : "";

  const header = params.origin ? emailHeader(params.origin) : "";

  const html = emailShell(escapeHtml(subject), `${header}
${emailEyebrow(escapeHtml(eyebrow))}
${emailHeadline(escapeHtml(headline))}
<tr><td style="padding:16px 0 28px 0;font-size:15px;line-height:1.6;color:${GLOA_NEAR_BLACK};">
<p style="font-size:14px;line-height:1.5;margin:0 0 16px;color:${BRAND.ink};">Bestellnummer <strong>${escapeHtml(order.order_number)}</strong></p>
${linesHtml}
${accountLinkHtml}
</td></tr>
${emailFooter(`Fragen zu deiner Bestellung? <a href="mailto:${SUPPORT_ADDRESS}" style="color:${GLOA_BERRY};">${SUPPORT_ADDRESS}</a>
<br/><br/>
${legalLinks(params.origin)}`)}`);

  const accountLinkText = order.accountOrderUrl
    ? `\nBestellung in deinem Konto ansehen: ${order.accountOrderUrl}`
    : "";

  const text = [
    `GLOA · ${eyebrow}`,
    "",
    headline,
    `Bestellnummer: ${order.order_number}`,
    "",
    ...lines,
    accountLinkText,
    "",
    `Fragen zu deiner Bestellung? ${SUPPORT_ADDRESS}`,
    legalLinksText(params.origin),
  ]
    .filter(line => line !== "")
    .join("\n");

  return { subject, html, text };
}
