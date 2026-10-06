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
 * "Deine Kündigung ist eingegangen" - the BGB 312k Abs. 3 confirmation.
 *
 * The law asks us to confirm an electronically declared termination
 * immediately, in text form, on a durable medium, naming its content,
 * the date and the time, and when the termination takes effect. That is
 * the whole job of this message.
 *
 * ══════════════════════════════════════════════════════════════
 * A KÜNDIGUNG IS NOT A WIDERRUF, AND THIS MAIL MUST NOT BLUR THEM
 * ══════════════════════════════════════════════════════════════
 *
 * NO REFUND IS PROMISED, HINTED AT, OR MENTIONED AS PENDING. A
 * termination ends a contract going forward; it reverses nothing. The
 * word Erstattung appears here only to say that none is connected to
 * this - and a test greps this file to keep it that way.
 *
 * NO GOODS ARE STOPPED. For the annual plan in particular, the remaining
 * deliveries are paid for and still owed, so the message says so
 * outright rather than leaving the customer to wonder why boxes keep
 * arriving after they cancelled.
 *
 * ── THE ANNUAL PLAN'S AWKWARD TRUTH, SAID PLAINLY ────────────
 *
 * It already ends by itself and does not renew, so an ordinary
 * termination cannot bring that date forward. Telling somebody their
 * cancellation "took effect" without saying that would be technically
 * true and practically misleading.
 */

export type TerminationKindForMail = "ordinary" | "extraordinary";

export type TerminationReceivedInput = {
  customerName: string;
  contractReference: string;
  terminationKind: TerminationKindForMail;
  /** When the declaration reached us. ISO. */
  submittedAt: string;
  /**
   * The substance of what happens next, decided by
   * lib/terminationRequest.ts. Rendered verbatim so the page, the mail
   * and the admin all say the same thing.
   */
  outcomeMessage: string;
  requestedEndAt?: string | null;
  origin?: string;
};

export type BuiltTerminationReceivedEmail = {
  subject: string;
  html: string;
  text: string;
};

function fmtDateTime(iso: string): { date: string; time: string } {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { date: "", time: "" };
  return {
    date: d.toLocaleDateString("de-DE", { timeZone: "Europe/Berlin" }),
    time: d.toLocaleTimeString("de-DE", {
      timeZone: "Europe/Berlin", hour: "2-digit", minute: "2-digit",
    }),
  };
}

export function buildTerminationReceivedEmail(
  input: TerminationReceivedInput
): BuiltTerminationReceivedEmail {
  const extraordinary = input.terminationKind === "extraordinary";
  const subject = extraordinary
    ? "Deine außerordentliche Kündigung ist eingegangen"
    : "Deine Kündigung ist eingegangen";

  const name = escapeHtml(input.customerName);
  const ref = escapeHtml(input.contractReference);
  const { date, time } = fmtDateTime(input.submittedAt);
  const origin = input.origin;
  const outcome = escapeHtml(input.outcomeMessage);
  const requestedEnd = input.requestedEndAt ? new Date(input.requestedEndAt).toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin' }) : 'Zum nächstmöglichen Zeitpunkt';

  const kindLine = extraordinary
    ? "Art der Kündigung: außerordentliche Kündigung"
    : "Art der Kündigung: ordentliche Kündigung";

  const html = emailShell(subject, `
${emailPreheader(`Kündigung zu ${ref} eingegangen.`)}
${origin ? emailHeader(origin) : ""}
${emailEyebrow("Kündigung")}
${emailHeadline(extraordinary ? "Außerordentliche<br/>Kündigung." : "Kündigung<br/>eingegangen.")}
<tr><td style="padding:0 0 20px 0;font-size:15px;line-height:1.7;color:${GLOA_NEAR_BLACK};">
Hallo ${name},<br/><br/>
wir bestätigen den Eingang deiner Kündigung.
</td></tr>
<tr><td style="padding:0 0 20px 0;font-size:15px;line-height:1.8;color:${GLOA_NEAR_BLACK};">
Vertrag: <strong>${ref}</strong><br/>
${kindLine}<br/>
Gewünschtes Vertragsende: ${escapeHtml(requestedEnd)}<br/>
Eingegangen am ${date} um ${time} Uhr
</td></tr>
<tr><td style="padding:0 0 20px 0;font-size:15px;line-height:1.7;color:${GLOA_NEAR_BLACK};">
${outcome}
</td></tr>
<tr><td style="padding:0 0 28px 0;font-size:14px;line-height:1.7;color:${GLOA_PLUM};">
Eine Kündigung ist etwas anderes als ein Widerruf und etwas anderes als eine Reklamation. Sie beendet den Vertrag für die Zukunft.
</td></tr>
${emailFooter(legalLinks(origin))}
`);

  const text = [
    `Hallo ${input.customerName},`,
    "",
    "wir bestätigen den Eingang deiner Kündigung.",
    "",
    `Vertrag: ${input.contractReference}`,
    kindLine,
    `Gewünschtes Vertragsende: ${requestedEnd}`,
    `Eingegangen am ${date} um ${time} Uhr`,
    "",
    input.outcomeMessage,
    "",
    "Eine Kündigung ist etwas anderes als ein Widerruf und etwas anderes als eine",
    "Reklamation. Sie beendet den Vertrag für die Zukunft.",
    "",
    legalLinksText(origin),
  ].join("\n");

  return { subject, html, text };
}
