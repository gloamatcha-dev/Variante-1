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
 * "Deine Erstattung ist veranlasst" - the third message in the
 * withdrawal family, and the only one that names money.
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
  const subject = "Deine Erstattung ist veranlasst";
  const name = escapeHtml(input.customerName);
  const ref = escapeHtml(input.orderReference);
  const origin = input.origin;
  const deducted = input.confirmedValueLossCents > 0;

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
Das ist der vollständige von dir gezahlte Betrag einschließlich der Lieferkosten.
</td></tr>`;

  const html = emailShell(subject, `
${emailPreheader(`Erstattung zu ${ref} veranlasst.`)}
${origin ? emailHeader(origin) : ""}
${emailEyebrow("Widerruf")}
${emailHeadline("Erstattung<br/>veranlasst.")}
<tr><td style="padding:0 0 20px 0;font-size:15px;line-height:1.7;color:${GLOA_NEAR_BLACK};">
Hallo ${name},<br/><br/>
wir haben die Erstattung zu deinem Widerruf für <strong>${ref}</strong> veranlasst.
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
        "Das ist der vollständige von dir gezahlte Betrag einschließlich der Lieferkosten.",
      ];

  const text = [
    `Hallo ${input.customerName},`,
    "",
    `wir haben die Erstattung zu deinem Widerruf für ${input.orderReference} veranlasst.`,
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
