import {
  emailShell,
  emailHeader,
  emailEyebrow,
  emailHeadline,
  emailFooter,
  GLOA_NEAR_BLACK,
  GLOA_BERRY,
  GLOA_POSTAL_ADDRESS,
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
${emailFooter(`Fragen zu deinem Widerruf? <a href="mailto:hello@gloamatcha.com" style="color:${GLOA_BERRY};">hello@gloamatcha.com</a>
<br/><br/>
${GLOA_POSTAL_ADDRESS}`)}`);

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
    "Fragen zu deinem Widerruf? hello@gloamatcha.com",
  ]
    .filter(line => line !== "")
    .join("\n");

  return { subject, html, text };
}
