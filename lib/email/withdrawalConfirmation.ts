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

export type WithdrawalConfirmationInput = {
  customerName: string;
  orderReference: string;
  scope: "whole_order" | "partial";
  scopeNote: string | null;
  customerNote: string | null;
  submittedAt: string; // ISO timestamp
  /**
   * Absolute site origin, for the logo in the mail header. Optional:
   * without it the mail is built without the mark rather than with a
   * broken image, which is what a relative path becomes in an inbox.
   */
  origin?: string;
};

export type BuiltWithdrawalConfirmationEmail = {
  subject: string;
  html: string;
  text: string;
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmtDateTime(iso: string): { date: string; time: string } {
  const d = new Date(iso);
  return {
    date: d.toLocaleDateString("de-DE", { timeZone: "Europe/Berlin" }),
    time: d.toLocaleTimeString("de-DE", { timeZone: "Europe/Berlin", hour: "2-digit", minute: "2-digit" }),
  };
}

/**
 * Builds the § 356a Abs. 4 BGB confirmation ("Der Unternehmer hat dem
 * Verbraucher... eine Bestätigung des Eingangs seiner Widerrufserklärung
 * unverzüglich auf einem dauerhaften Datenträger zu übermitteln") - content
 * of the declaration, date and time, no marketing. Pure - no DB/network
 * access, directly unit-testable, matching the convention in
 * lib/email/orderConfirmation.ts.
 */
/**
 * WHERE THE GOODS GO BACK, AND WHO PAYS THE POSTAGE.
 *
 * The confirmation is the moment the consumer is actually deciding what
 * to do next, so it carries the return address rather than making them
 * hunt for it on the website.
 *
 * THE RETURN-COST SENTENCE IS THE EGBGB ANLAGE 1 WORDING, VERBATIM. It
 * may only be used because the same information is given before the
 * contract is concluded - it is on /widerruf and in the AGB - which is
 * what BGB 357 Abs. 6 requires before the consumer can be asked to
 * carry those costs at all.
 *
 * WHAT IS DELIBERATELY ABSENT: any suggestion that money has moved, or
 * will move on a particular day. The repayment has its own message,
 * sent when it has actually been arranged.
 */
const RETURN_ADDRESS_LINES = [
  "Cara 2 GmbH",
  "Hardenbergstr. 4",
  "10623 Berlin",
  "Deutschland",
];

const RETURN_COST_SENTENCE = "Sie tragen die unmittelbaren Kosten der Rücksendung der Waren.";

const NEXT_STEPS_HTML = `<tr><td style="padding:0 0 28px 0;font-size:14px;line-height:1.7;color:${GLOA_NEAR_BLACK};">
<p style="font-size:14px;line-height:1.6;margin:0 0 8px;font-weight:600;">So geht es weiter</p>
<p style="font-size:14px;line-height:1.6;margin:0 0 12px;">Sende die Ware bitte unverzüglich, spätestens binnen vierzehn Tagen ab dieser Erklärung, an uns zurück:</p>
<p style="font-size:14px;line-height:1.6;margin:0 0 12px;">${RETURN_ADDRESS_LINES.join("<br/>")}</p>
<p style="font-size:14px;line-height:1.6;margin:0 0 12px;">${RETURN_COST_SENTENCE}</p>
<p style="font-size:14px;line-height:1.6;margin:0;">Diese E-Mail bestätigt den Eingang deiner Widerrufserklärung. Sie ist noch keine Erstattung. Über die Rückzahlung informieren wir dich gesondert, sobald sie veranlasst ist.</p>
</td></tr>`;

export function buildWithdrawalConfirmationEmail(input: WithdrawalConfirmationInput): BuiltWithdrawalConfirmationEmail {
  const { customerName, orderReference, scope, scopeNote, customerNote, submittedAt } = input;
  const { date, time } = fmtDateTime(submittedAt);

  const scopeLabel = scope === "whole_order" ? "die gesamte Bestellung" : "einen Teil der Bestellung";
  const subject = `Eingangsbestätigung: dein Widerruf zu ${orderReference}`;

  const scopeNoteHtml = scopeNote
    ? `<p style="font-size:14px;line-height:1.5;margin:0 0 8px;">Betroffener Teil: ${escapeHtml(scopeNote)}</p>`
    : "";
  const customerNoteHtml = customerNote
    ? `<p style="font-size:14px;line-height:1.5;margin:0 0 8px;">Anmerkung: ${escapeHtml(customerNote)}</p>`
    : "";

    // The approved mark, when an origin was supplied. Without one the
  // mail is built without it rather than with a broken image - the
  // same rule the launch mails already follow.
  const header = input.origin ? emailHeader(input.origin) : "";

  const html = emailShell(escapeHtml(subject), `${header}
${emailEyebrow(`Widerruf erhalten`)}
${emailHeadline(`Eingangsbestätigung deines Widerrufs.`)}
<tr><td style="padding:16px 0 28px 0;font-size:15px;line-height:1.6;color:${GLOA_NEAR_BLACK};">
<p style="font-size:14px;line-height:1.5;margin:0 0 8px;">Name: ${escapeHtml(customerName)}</p>
<p style="font-size:14px;line-height:1.5;margin:0 0 8px;">Bestellung/Vertrag: ${escapeHtml(orderReference)}</p>
<p style="font-size:14px;line-height:1.5;margin:0 0 8px;">Umfang: ${escapeHtml(scopeLabel)}</p>
${scopeNoteHtml}
${customerNoteHtml}
<p style="font-size:14px;line-height:1.5;margin:16px 0 0;">Eingegangen am ${escapeHtml(date)} um ${escapeHtml(time)} Uhr.</p>
</td></tr>
${NEXT_STEPS_HTML}
${emailFooter(`Fragen zu deinem Widerruf? <a href="mailto:hello@gloamatcha.com" style="color:${GLOA_BERRY};">hello@gloamatcha.com</a>
<br/><br/>
${legalLinks(input.origin)}`)}`);

  const text = [
    "GLOA · Widerruf erhalten",
    "",
    "Eingangsbestätigung deines Widerrufs.",
    `Name: ${customerName}`,
    `Bestellung/Vertrag: ${orderReference}`,
    `Umfang: ${scopeLabel}`,
    scopeNote ? `Betroffener Teil: ${scopeNote}` : "",
    customerNote ? `Anmerkung: ${customerNote}` : "",
    `Eingegangen am ${date} um ${time} Uhr.`,
    "",
    "So geht es weiter",
    "Sende die Ware bitte unverzüglich, spätestens binnen vierzehn Tagen ab dieser",
    "Erklärung, an uns zurück:",
    ...RETURN_ADDRESS_LINES,
    "",
    RETURN_COST_SENTENCE,
    "",
    "Diese E-Mail bestätigt den Eingang deiner Widerrufserklärung. Sie ist noch keine",
    "Erstattung. Über die Rückzahlung informieren wir dich gesondert, sobald sie",
    "veranlasst ist.",
    "",
    "Fragen zu deinem Widerruf? hello@gloamatcha.com",
    legalLinksText(input.origin),
  ]
    .filter(line => line !== "")
    .join("\n");

  return { subject, html, text };
}
