import {
  legalLinks,
  legalLinksText,
  emailShell,
  emailHeader,
  emailEyebrow,
  emailHeadline,
  emailFooter,
  emailPreheader,
  escapeHtml,
  GLOA_NEAR_BLACK,
  GLOA_PLUM,
} from "./brand.ts";

/**
 * "Deine Erstattung ist durchgeführt" - the third message in the
 * withdrawal family, and the only one that names money.
 *
 * ══════════════════════════════════════════════════════════════
 * IT IS SENT AFTER THE MONEY MOVED, NOT WHEN IT WAS DECIDED
 * ══════════════════════════════════════════════════════════════
 *
 * A withdrawal payout has two moments: an administrator approving it,
 * and the payment provider confirming it. THIS MAIL IS THE SECOND ONE.
 * Nothing sends it at approval, and that is enforced rather than
 * remembered - migration 070's claim function can only be won from
 * refund_state = 'executed', a state that cannot exist without the
 * provider's own reference for the refund.
 *
 * So the wording is in the past tense and says the refund was CARRIED
 * OUT. "Veranlasst" would have been the honest word for the approval
 * moment, and using it here would tell a customer whose refund is done
 * that it is merely on its way.
 *
 * ══════════════════════════════════════════════════════════════
 * IT NAMES A FIGURE, SO IT MUST NAME THE RIGHT ONE
 * ══════════════════════════════════════════════════════════════
 *
 * Every amount here is passed in from the SERVER's own calculation
 * (lib/withdrawalCase.ts computeRefund) after an administrator confirmed
 * any value loss. Nothing in this file computes, rounds or infers an
 * amount - it renders what it is given, so there is exactly one place
 * where a refund figure is decided.
 *
 * ── WHAT IT DOES NOT PROMISE ─────────────────────────────────
 *
 * NO BANK TIMING. GLOA does not know when the customer's issuer posts
 * it, so there is no "in 3-5 Werktagen". The same rule
 * lib/email/refundConfirmation.ts already follows, for the same reason.
 *
 * NO METHOD CLAIM beyond the one fact we do hold: it goes back the way
 * it came, which is what BGB 357 Abs. 3 requires of us anyway.
 *
 * ── AND IF SOMETHING WAS DEDUCTED ────────────────────────────
 *
 * It is named as WERTERSATZ WEGEN WERTVERLUST, with the amount, because
 * a silent deduction is how a refund becomes a complaint. It is never
 * called a fee, a Bearbeitungsgebühr or a Widerrufsgebühr - it is
 * compensation for a diminished thing under BGB 357a, and those other
 * words would describe something the law does not allow us to charge.
 */

export type WithdrawalRefundCompletedInput = {
  customerName: string;
  orderReference: string;
  /** Everything the customer paid, in cents. */
  paidGrossCents: number;
  /** What an administrator confirmed, in cents. Zero in the ordinary case. */
  confirmedValueLossCents: number;
  /** paid - value loss, computed server-side. */
  refundGrossCents: number;
  /**
   * Which kind of withdrawal this settles. Defaults to whole_order,
   * which is what every case was before partial payouts existed.
   *
   * It changes one sentence and it matters: a whole-order refund really
   * is "the full amount you paid, delivery costs included", and saying
   * that to somebody who withdrew one of three items - and whose
   * outbound shipping may have been retained - would be false.
   */
  refundScope?: "whole_order" | "partial";
  /**
   * Whether the outbound delivery cost is part of this refund. Only
   * meaningful for a partial case, where it is a decision a human made
   * and this template merely reports.
   */
  shippingIncluded?: boolean;
  origin?: string;
};

export type BuiltWithdrawalRefundCompletedEmail = {
  subject: string;
  html: string;
  text: string;
};

function euro(cents: number): string {
  return (cents / 100).toLocaleString("de-DE", {
    style: "currency", currency: "EUR", minimumFractionDigits: 2,
  });
}

export function buildWithdrawalRefundCompletedEmail(
  input: WithdrawalRefundCompletedInput
): BuiltWithdrawalRefundCompletedEmail {
  const subject = "Deine Erstattung ist durchgeführt";
  const name = escapeHtml(input.customerName);
  const ref = escapeHtml(input.orderReference);
  const origin = input.origin;
  const deducted = input.confirmedValueLossCents > 0;
  const partial = input.refundScope === "partial";

  // THE ONE SENTENCE THAT DEPENDS ON THE SCOPE. A whole-order refund is
  // everything including the delivery; a partial one covers the goods
  // that were withdrawn, and says about the shipping only what is true.
  const fullAmountSentence = partial
    ? (input.shippingIncluded === true
        ? "Das ist der Betrag für die widerrufenen Artikel einschließlich der Lieferkosten."
        : "Das ist der Betrag für die widerrufenen Artikel.")
    : input.refundGrossCents===input.paidGrossCents
      ? "Das ist der vollständige von dir gezahlte Betrag einschließlich der Lieferkosten."
      : "Das ist der nach Prüfung freigegebene Erstattungsbetrag für deinen Widerruf.";

  const breakdown = deducted
    ? `
<tr><td style="padding:0 0 20px 0;font-size:15px;line-height:1.8;color:${GLOA_NEAR_BLACK};">
Gezahlt: <strong>${euro(input.paidGrossCents)}</strong><br/>
Wertersatz wegen Wertverlust: <strong>&minus; ${euro(input.confirmedValueLossCents)}</strong><br/>
Erstattung: <strong>${euro(input.refundGrossCents)}</strong>
</td></tr>
<tr><td style="padding:0 0 20px 0;font-size:14px;line-height:1.7;color:${GLOA_PLUM};">
Der Wertersatz betrifft den Wertverlust der zurückgesendeten Ware. Er ist keine Gebühr für den Widerruf.
</td></tr>`
    : `
<tr><td style="padding:0 0 20px 0;font-size:15px;line-height:1.8;color:${GLOA_NEAR_BLACK};">
Erstattung: <strong>${euro(input.refundGrossCents)}</strong><br/>
${escapeHtml(fullAmountSentence)}
</td></tr>`;

  const html = emailShell(subject, `
${emailPreheader(`Erstattung zu ${ref} durchgeführt.`)}
${origin ? emailHeader(origin) : ""}
${emailEyebrow("Widerruf")}
${emailHeadline("Erstattung<br/>durchgeführt.")}
<tr><td style="padding:0 0 20px 0;font-size:15px;line-height:1.7;color:${GLOA_NEAR_BLACK};">
Hallo ${name},<br/><br/>
wir haben die Erstattung zu deinem Widerruf für <strong>${ref}</strong> ausgezahlt.
</td></tr>
${breakdown}
<tr><td style="padding:0 0 28px 0;font-size:14px;line-height:1.7;color:${GLOA_PLUM};">
Die Rückzahlung erfolgt über dasselbe Zahlungsmittel, das du bei der Bestellung verwendet hast. Wann sie auf deinem Konto sichtbar ist, entscheidet dein Zahlungsdienstleister.
</td></tr>
${emailFooter(legalLinks(origin))}
`);

  const textBreakdown = deducted
    ? [
        `Gezahlt: ${euro(input.paidGrossCents)}`,
        `Wertersatz wegen Wertverlust: - ${euro(input.confirmedValueLossCents)}`,
        `Erstattung: ${euro(input.refundGrossCents)}`,
        "",
        "Der Wertersatz betrifft den Wertverlust der zurückgesendeten Ware.",
        "Er ist keine Gebühr für den Widerruf.",
      ]
    : [
        `Erstattung: ${euro(input.refundGrossCents)}`,
        fullAmountSentence,
      ];

  const text = [
    `Hallo ${input.customerName},`,
    "",
    `wir haben die Erstattung zu deinem Widerruf für ${input.orderReference} ausgezahlt.`,
    "",
    ...textBreakdown,
    "",
    "Die Rückzahlung erfolgt über dasselbe Zahlungsmittel, das du bei der Bestellung verwendet hast.",
    "Wann sie auf deinem Konto sichtbar ist, entscheidet dein Zahlungsdienstleister.",
    "",
    legalLinksText(origin),
  ].join("\n");

  return { subject, html, text };
}
