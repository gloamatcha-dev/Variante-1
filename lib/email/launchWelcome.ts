import {
  GLOA_BLUE,
  GLOA_NEAR_BLACK,
  GLOA_PLUM,
  GLOA_POSTAL_ADDRESS,
  GLOA_RULE,
  emailEyebrow,
  emailFooter,
  emailHeader,
  emailHeadline,
  emailPreheader,
  emailShell,
  escapeHtml,
} from "./brand.ts";

/**
 * THE WELCOME MAIL, CARRYING THE LAUNCH DISCOUNT CODE.
 *
 * Sent once, immediately after somebody confirms their address, and only
 * to people whose stored consent wording actually names it - see
 * mayReceiveWelcomeEmail() in lib/launchWaitlist.ts. Rows signed under
 * consent version 1 never receive this, because that wording promised
 * one launch notification and no offers.
 *
 * ── IT IS NOT THE LAUNCH ANNOUNCEMENT ─────────────────────────
 *
 * That is lib/email/launchDay.ts, sent on 1 October, and this mail must
 * not stand in for it: the code is useless until the shop opens, and
 * saying "GLOA is live" today would be false. So this message hands over
 * the code, says plainly when it can be used, and stops.
 *
 * ── IT LINKS TO NO SHOP ───────────────────────────────────────
 *
 * Deliberately. The shop is in prelaunch, the cart routes to /contact,
 * and a "shop now" button in a welcome mail three weeks before opening
 * is an invitation to a shut door. The code is the payload; the launch
 * mail is what will carry the link.
 *
 * ── WHAT MAY NEVER BE ADDED ───────────────────────────────────
 *
 * No second offer, no referral ask, no product push, no event, no
 * newsletter signup and no tracking pixel. The consent names two mails
 * and this is the first of them.
 *
 * Pure - no clock, no database, no network - so the suite reads the
 * exact bytes an inbox would receive. The validity window is passed in
 * rather than read, so it cannot drift from lib/launchDiscount.ts.
 */

export type LaunchWelcomeInput = {
  /** Optional. Absent means the mail simply does not greet by name. */
  firstName: string | null;
  /** Absolute site origin, for the logo. */
  origin: string;
  /** The shared code, e.g. GLOALAUNCH10. */
  code: string;
  /** What the code is worth, as printed. e.g. "10 %". */
  percentLabel: string;
  /** When it can be used, as printed. e.g. "01.10.2026, 12:00 Uhr". */
  validFromLabel: string;
  /** Last day it can be used, as printed. e.g. "31.10.2026, 23:59 Uhr". */
  validUntilLabel: string;
};

export type BuiltLaunchWelcomeEmail = {
  subject: string;
  html: string;
  text: string;
};

export const LAUNCH_WELCOME_SUBJECT = "Willkommen bei GLOA. Hier ist dein Launch-Code.";

export function buildLaunchWelcomeEmail(input: LaunchWelcomeInput): BuiltLaunchWelcomeEmail {
  const { firstName, origin, code, percentLabel, validFromLabel, validUntilLabel } = input;

  const base = origin.replace(/\/+$/, "");
  const greeting = firstName ? `Hi ${firstName},` : "Hi,";
  const subject = LAUNCH_WELCOME_SUBJECT;

  const body =
    "deine Eintragung ist bestätigt. Als Dankeschön bekommst du " +
    `${percentLabel} auf deine erste Bestellung.`;

  const validity =
    `Einlösbar ab ${validFromLabel} bis einschließlich ${validUntilLabel}. ` +
    "Wir melden uns noch einmal, sobald der Shop öffnet.";

  const footerText =
    "Du erhältst diese E-Mail, weil du dich für die GLOA Launch-Benachrichtigung " +
    "eingetragen hast. Du bekommst von uns nur noch eine weitere E-Mail zum Launch " +
    "und keine regelmäßigen Newsletter.";

  const text = [
    greeting,
    "",
    body,
    "",
    `DEIN CODE: ${code}`,
    "",
    validity,
    "",
    footerText,
    "",
    "GLOA",
    "Cara 2 GmbH, Hardenbergstr. 4, 10623 Berlin",
  ].join("\n");

  // The code, set as the one object in the mail. A bordered block rather
  // than a button: there is nothing to click yet, and a button that goes
  // nowhere is worse than no button.
  const codeBlock = `<tr><td style="padding:0 0 24px 0;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border:2px solid ${GLOA_BLUE};">
<tr><td style="padding:18px 28px;font-size:24px;font-weight:800;letter-spacing:.12em;color:${GLOA_BLUE};font-family:Inter,Helvetica,Arial,sans-serif;">${escapeHtml(code)}</td></tr>
</table>
</td></tr>`;

  const html = emailShell(
    escapeHtml(subject),
    `${emailPreheader(`${percentLabel} auf deine erste Bestellung.`)}
${emailHeader(base)}
${emailEyebrow("GLOA LAUNCH LIST")}
${emailHeadline("WILLKOMMEN.")}
<tr><td style="padding:20px 0 28px 0;font-size:16px;line-height:1.55;color:${GLOA_PLUM};">${escapeHtml(greeting)}<br/>${escapeHtml(body)}</td></tr>
${codeBlock}
<tr><td style="padding:0 0 24px 0;font-size:14px;line-height:1.6;color:${GLOA_NEAR_BLACK};border-top:1px solid ${GLOA_RULE};padding-top:20px;">${escapeHtml(validity)}</td></tr>
${emailFooter(`${escapeHtml(footerText)}
<br/><br/>
${GLOA_POSTAL_ADDRESS}`)}`
  );

  return { subject, html, text };
}
