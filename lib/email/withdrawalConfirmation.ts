export type WithdrawalConfirmationInput = {
  customerName: string;
  orderReference: string;
  scope: "whole_order" | "partial";
  scopeNote: string | null;
  customerNote: string | null;
  submittedAt: string; // ISO timestamp
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

  const html = `<!doctype html>
<html lang="de">
<head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background-color:#F5EBE2;font-family:Arial,Helvetica,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#F5EBE2;padding:32px 16px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;">
<tr><td style="background-color:#1746D1;padding:20px 32px;">
<span style="font-size:22px;font-weight:900;color:#F5EBE2;letter-spacing:-0.03em;">GLOA</span>
</td></tr>
<tr><td style="padding:32px;">
<p style="font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:#A61E59;font-weight:700;margin:0 0 10px;">Widerruf erhalten</p>
<h1 style="font-size:22px;line-height:1.2;letter-spacing:-0.02em;margin:0 0 14px;color:#111111;">Eingangsbestätigung deines Widerrufs.</h1>
<p style="font-size:14px;line-height:1.5;margin:0 0 8px;">Name: ${escapeHtml(customerName)}</p>
<p style="font-size:14px;line-height:1.5;margin:0 0 8px;">Bestellung/Vertrag: ${escapeHtml(orderReference)}</p>
<p style="font-size:14px;line-height:1.5;margin:0 0 8px;">Umfang: ${escapeHtml(scopeLabel)}</p>
${scopeNoteHtml}
${customerNoteHtml}
<p style="font-size:14px;line-height:1.5;margin:16px 0 0;">Eingegangen am ${escapeHtml(date)} um ${escapeHtml(time)} Uhr.</p>
</td></tr>
<tr><td style="background-color:#4F3A5B;padding:20px 32px;">
<p style="font-size:12px;line-height:1.5;color:#F5EBE2;margin:0;">GLOA · Fragen zu deinem Widerruf? <a href="mailto:info@gloamatcha.com" style="color:#F5EBE2;">info@gloamatcha.com</a></p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

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
    "Fragen zu deinem Widerruf? info@gloamatcha.com",
  ]
    .filter(line => line !== "")
    .join("\n");

  return { subject, html, text };
}
