export type LaunchConfirmationInput = {
  /** Optional. Absent means the mail simply does not greet by name. */
  firstName: string | null;
  /** Absolute URL carrying the opaque confirmation token. */
  confirmUrl: string;
  /** Absolute URL that withdraws the entry in one click. */
  withdrawUrl: string;
};

export type BuiltLaunchConfirmationEmail = {
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

/**
 * THE DOUBLE OPT-IN MAIL, AND NOTHING ELSE.
 *
 * This message exists to ask one question: may GLOA tell you when it
 * opens? So it carries one action, one sentence explaining it, and the
 * way out.
 *
 * -- WHAT MUST NEVER BE ADDED HERE ----------------------------
 * No product, no price, no shop link, no discount code, no "meanwhile,
 * have a look at", no event, no second opt-in ride-along. A message sent
 * to obtain consent may not itself be the advertising the consent has
 * not been given for yet - and the whole promise of this list is that
 * the address is used for the launch and for nothing else.
 *
 * The Instagram line is the one soft link, and it stays a link to a
 * public profile: no tracking, no offer, and nothing that needs consent.
 *
 * Pure - no database, no network, no clock - so a unit test can read the
 * output directly, which is what tests/launch-waitlist.test.mjs does to
 * hold the "no marketing" promise to actual bytes.
 */
export function buildLaunchConfirmationEmail(input: LaunchConfirmationInput): BuiltLaunchConfirmationEmail {
  const { firstName, confirmUrl, withdrawUrl } = input;

  const greeting = firstName ? `Hi ${firstName},` : "Hi,";

  const subject = "GLOA Launch List bestätigen";

  const text = [
    greeting,
    "",
    "Fast geschafft.",
    "",
    "Bestätige kurz, dass wir dir Bescheid geben dürfen,",
    "wenn GLOA offiziell startet.",
    "",
    "EINTRAGUNG BESTÄTIGEN:",
    confirmUrl,
    "",
    "Du erhältst über diese Eintragung keine regelmäßigen Newsletter.",
    "Deine E-Mail-Adresse wird ausschließlich für die Launch-Benachrichtigung verwendet.",
    "",
    "Du warst das nicht oder hast es dir anders überlegt? Dann ignoriere diese",
    "E-Mail einfach, oder trag dich hier direkt wieder aus:",
    withdrawUrl,
    "",
    "GLOA",
    "Cara 2 GmbH, Hardenbergstr. 4, 10623 Berlin",
  ].join("\n");

  const html = `<!doctype html>
<html lang="de">
<head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#F5EBE2;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F5EBE2;">
<tr><td align="center" style="padding:40px 20px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;background:#F5EBE2;font-family:Inter,Helvetica,Arial,sans-serif;color:#111111;">
<tr><td style="padding:0 0 28px 0;font-size:11px;letter-spacing:.2em;text-transform:uppercase;font-weight:600;color:#A61E59;">GLOA Launch List</td></tr>
<tr><td style="padding:0 0 8px 0;font-size:34px;line-height:1.05;letter-spacing:-.03em;font-weight:800;">Fast geschafft.</td></tr>
<tr><td style="padding:0 0 28px 0;font-size:16px;line-height:1.55;color:#4F3A5B;">${escapeHtml(greeting)}<br/>Bestätige kurz, dass wir dir Bescheid geben dürfen, wenn GLOA offiziell startet.</td></tr>
<tr><td style="padding:0 0 28px 0;">
<a href="${escapeHtml(confirmUrl)}" style="display:inline-block;background:#1746D1;color:#F5EBE2;text-decoration:none;padding:16px 28px;font-size:12px;font-weight:600;letter-spacing:.16em;text-transform:uppercase;">Eintragung bestätigen</a>
</td></tr>
<tr><td style="padding:0 0 24px 0;font-size:13px;line-height:1.6;color:#4F3A5B;">Falls der Button nicht funktioniert, öffne diesen Link:<br/><a href="${escapeHtml(confirmUrl)}" style="color:#1746D1;word-break:break-all;">${escapeHtml(confirmUrl)}</a></td></tr>
<tr><td style="padding:24px 0 0 0;border-top:1px solid rgba(79,58,91,.22);font-size:12px;line-height:1.7;color:#4F3A5B;">
Du erhältst über diese Eintragung keine regelmäßigen Newsletter. Deine E-Mail-Adresse wird ausschließlich für die Launch-Benachrichtigung verwendet.
<br/><br/>
Du warst das nicht oder hast es dir anders überlegt? Dann ignoriere diese E-Mail einfach, oder <a href="${escapeHtml(withdrawUrl)}" style="color:#A61E59;">trag dich hier direkt wieder aus</a>.
<br/><br/>
GLOA &middot; Cara 2 GmbH, Hardenbergstr. 4, 10623 Berlin
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

  return { subject, html, text };
}
