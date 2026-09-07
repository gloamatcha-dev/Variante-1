import {
  GLOA_BERRY,
  GLOA_BLUE,
  GLOA_PLUM,
  GLOA_POSTAL_ADDRESS,
  emailButton,
  emailEyebrow,
  emailFooter,
  emailHeader,
  emailHeadline,
  emailPreheader,
  emailShell,
  escapeHtml,
} from "./brand.ts";

export type LaunchConfirmationInput = {
  /** Optional. Absent means the mail simply does not greet by name. */
  firstName: string | null;
  /** Absolute URL carrying the opaque confirmation token. */
  confirmUrl: string;
  /** Absolute URL that withdraws the entry in one click. */
  withdrawUrl: string;
  /**
   * The site origin, for the absolute image URL the logo needs.
   *
   * Optional, and the mail is built without a logo when it is absent
   * rather than with a broken image: a missing origin must not put a
   * grey placeholder box at the top of a consent mail. The caller passes
   * getSiteOrigin(), which it has already checked before sending.
   */
  origin?: string | null;
};

export type BuiltLaunchConfirmationEmail = {
  subject: string;
  html: string;
  text: string;
};

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
 * -- THE FOOTER HAS TO MATCH THE CONSENT BEING CONFIRMED --
 *
 * This mail used to promise the address would be used for the launch
 * notification and nothing else. That was true under consent version
 * one. Version two asks the same person to agree to TWO mails - the
 * welcome mail carrying the discount code, and the launch notification
 * itself - so the old sentence claimed less than the person had just
 * agreed to, and gave no warning of a mail arriving seconds later.
 *
 * This wording is template prose, not the stored consent text, which is
 * why nothing broke when the consent version moved and why the
 * contradiction survived the whole suite: the test asserted the old
 * string. It names both mails now, and still says plainly that there is
 * nothing beyond them.
 *
 * The Instagram line is the one soft link, and it stays a link to a
 * public profile: no tracking, no offer, and nothing that needs consent.
 *
 * Pure - no database, no network, no clock - so a unit test can read the
 * output directly, which is what tests/launch-waitlist.test.mjs does to
 * hold the "no marketing" promise to actual bytes.
 */
export function buildLaunchConfirmationEmail(input: LaunchConfirmationInput): BuiltLaunchConfirmationEmail {
  const { firstName, confirmUrl, withdrawUrl, origin } = input;

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
    "Gleich nach deiner Bestätigung schicken wir dir deinen Launch-Rabattcode,",
    "und zum Start einmalig die Launch-Benachrichtigung. Mehr sind es nicht:",
    "keine regelmäßigen Newsletter und keine weitere Werbung.",
    "",
    "Du warst das nicht oder hast es dir anders überlegt? Dann ignoriere diese",
    "E-Mail einfach, oder trag dich hier direkt wieder aus:",
    withdrawUrl,
    "",
    "GLOA",
    "Cara 2 GmbH, Hardenbergstr. 4, 10623 Berlin",
  ].join("\n");

  // The mark, when an origin was supplied. A mail with no absolute
  // origin is built without it rather than with a broken image.
  const header = origin ? emailHeader(origin) : "";

  const html = emailShell(
    escapeHtml(subject),
    `${emailPreheader("Ein Klick, dann sagen wir dir zum Launch Bescheid.")}
${header}
${emailEyebrow("GLOA Launch List")}
${emailHeadline("Fast geschafft.")}
<tr><td style="padding:0 0 28px 0;font-size:16px;line-height:1.55;color:${GLOA_PLUM};">${escapeHtml(greeting)}<br/>Bestätige kurz, dass wir dir Bescheid geben dürfen, wenn GLOA offiziell startet.</td></tr>
<tr><td style="padding:0 0 28px 0;">
${emailButton(escapeHtml(confirmUrl), "Eintragung bestätigen")}
</td></tr>
<tr><td style="padding:0 0 24px 0;font-size:13px;line-height:1.6;color:${GLOA_PLUM};">Falls der Button nicht funktioniert, öffne diesen Link:<br/><a href="${escapeHtml(confirmUrl)}" style="color:${GLOA_BLUE};word-break:break-all;">${escapeHtml(confirmUrl)}</a></td></tr>
${emailFooter(`Gleich nach deiner Bestätigung schicken wir dir deinen Launch-Rabattcode, und zum Start einmalig die Launch-Benachrichtigung. Mehr sind es nicht: keine regelmäßigen Newsletter und keine weitere Werbung.
<br/><br/>
Du warst das nicht oder hast es dir anders überlegt? Dann ignoriere diese E-Mail einfach, oder <a href="${escapeHtml(withdrawUrl)}" style="color:${GLOA_BERRY};">trag dich hier direkt wieder aus</a>.
<br/><br/>
${GLOA_POSTAL_ADDRESS}`)}`
  );

  return { subject, html, text };
}
