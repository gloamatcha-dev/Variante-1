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
 * "Deine Rücksendung ist bei uns angekommen" - the second message in the
 * withdrawal family.
 *
 * ══════════════════════════════════════════════════════════════
 * WHAT IT CLAIMS, AND WHAT IT REFUSES TO
 * ══════════════════════════════════════════════════════════════
 *
 * It says the parcel ARRIVED. That is a durable fact by the time this
 * can be rendered: an administrator recorded return_received_at through
 * the audited writer, and nothing else can set it.
 *
 * IT DOES NOT SAY THE MONEY IS BACK. Arrival and repayment are two
 * different events on two different days, and the repayment has its own
 * message. Saying "wir erstatten dir jetzt X EUR" here would be a figure
 * nobody has confirmed yet - the Wertersatz decision, if the seal was
 * broken, has not necessarily been made.
 *
 * IT DOES NOT ANNOUNCE A DEDUCTION EITHER. If a value loss ends up being
 * applied it is named in the repayment message, once a person has
 * decided it. A "wir prüfen noch Abzüge" line here would worry a
 * customer who is, in the ordinary case, owed everything back.
 */

export type WithdrawalReturnReceivedInput = {
  customerName: string;
  orderReference: string;
  /** When the parcel was recorded as received. ISO. */
  receivedAt: string;
  origin?: string;
};

export type BuiltWithdrawalReturnReceivedEmail = {
  subject: string;
  html: string;
  text: string;
};

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("de-DE", { timeZone: "Europe/Berlin" });
}

export function buildWithdrawalReturnReceivedEmail(
  input: WithdrawalReturnReceivedInput
): BuiltWithdrawalReturnReceivedEmail {
  const subject = "Deine Rücksendung ist bei uns angekommen";
  const name = escapeHtml(input.customerName);
  const ref = escapeHtml(input.orderReference);
  const date = fmtDate(input.receivedAt);
  const origin = input.origin;

  const body = `
<tr><td style="padding:0 0 20px 0;font-size:15px;line-height:1.7;color:${GLOA_NEAR_BLACK};">
Hallo ${name},<br/><br/>
deine Rücksendung zum Widerruf für <strong>${ref}</strong> ist am ${date} bei uns eingegangen. Danke dafür.
</td></tr>
<tr><td style="padding:0 0 20px 0;font-size:15px;line-height:1.7;color:${GLOA_NEAR_BLACK};">
Wir prüfen die Ware jetzt und kümmern uns anschließend um die Rückzahlung. Sobald die Erstattung veranlasst ist, bekommst du dazu eine eigene E-Mail von uns.
</td></tr>
<tr><td style="padding:0 0 28px 0;font-size:14px;line-height:1.7;color:${GLOA_PLUM};">
Diese Nachricht bestätigt den Eingang deiner Rücksendung. Sie ist noch keine Erstattung.
</td></tr>`;

  const html = emailShell(subject, `
${emailPreheader(`Rücksendung zu ${ref} eingegangen.`)}
${origin ? emailHeader(origin) : ""}
${emailEyebrow("Widerruf")}
${emailHeadline("Rücksendung<br/>angekommen.")}
${body}
${emailFooter(legalLinks(origin))}
`);

  const text = [
    `Hallo ${input.customerName},`,
    "",
    `deine Rücksendung zum Widerruf für ${input.orderReference} ist am ${date} bei uns eingegangen. Danke dafür.`,
    "",
    "Wir prüfen die Ware jetzt und kümmern uns anschließend um die Rückzahlung.",
    "Sobald die Erstattung veranlasst ist, bekommst du dazu eine eigene E-Mail.",
    "",
    "Diese Nachricht bestätigt den Eingang deiner Rücksendung. Sie ist noch keine Erstattung.",
    "",
    legalLinksText(origin),
  ].join("\n");

  return { subject, html, text };
}
