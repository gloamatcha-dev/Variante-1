import {
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

/**
 * THE ONE MESSAGE THIS CONSENT COVERS.
 *
 * Every address on the launch list was given for exactly one thing: to
 * be told, once, that GLOA has opened. This is that message, and there
 * will not be a second one. lib/launchWaitlist.ts
 * (mayReceiveLaunchNotification) is the gate that enforces it; this file
 * is what goes through it.
 *
 * ── WHY THIS IS NOT THE CONFIRMATION MAIL WITH NEW WORDS ──────
 *
 * The double opt-in mail asks permission and therefore may advertise
 * nothing at all. This mail is the thing permission was given FOR, so it
 * may name the shop and link to it - and that difference is exactly why
 * they are separate files. Reusing one template for both would put a
 * shop link one edit away from a message sent to obtain consent.
 *
 * ── WHAT MAY NEVER BE ADDED HERE ──────────────────────────────
 *
 * No discount code, no voucher, no "only today", no countdown, no
 * referral ask, no event invitation, no B2B offer, no second product
 * push, no tracking pixel and no link that is not gloamatcha.com. The
 * consent was for an announcement, not for a campaign, and a recipient
 * who reads this mail has not agreed to receive anything else.
 *
 * It also carries NO WITHDRAWAL LINK, and that is deliberate rather than
 * an omission: by the time this arrives the consent has been used up.
 * There is nothing left to withdraw from, no further mail this list can
 * produce, and the honest footer says that instead of offering an
 * unsubscribe from a list that is about to be deleted.
 *
 * ── ONE CLAIM ABOUT THE PRODUCT, AND IT IS TRUE OR IT IS NOT ──
 *
 * The copy says the shop is open. It does not say every product is in
 * stock, does not name a variant and does not promise delivery by a
 * date. Whoever releases the send is confirming the first of those; the
 * mail deliberately does not put the others in their mouth.
 *
 * Pure - no database, no network, no clock - so the suite can read the
 * exact bytes an inbox would receive.
 */

export type LaunchDayInput = {
  /** Optional. Absent means the mail simply does not greet by name. */
  firstName: string | null;
  /** Absolute site origin, e.g. https://gloamatcha.com. */
  origin: string;
  /**
   * Marks the message as a pre-launch preview.
   *
   * A preview is a real send through the real provider to an explicitly
   * authorized address, so it has to be impossible to mistake for the
   * real thing sitting in an inbox next to it: the subject is prefixed
   * and a banner says so in the body. Everything else - the mark, the
   * copy, the button, the footer - is byte-identical to what the list
   * will receive, because a preview that differs from the real mail is
   * not a preview of anything.
   */
  preview?: boolean;
};

export type BuiltLaunchDayEmail = {
  subject: string;
  html: string;
  text: string;
};

/** The canonical shop route. Checked against the site's own nav, not invented. */
export const LAUNCH_DAY_SHOP_PATH = "/shop";

export const LAUNCH_DAY_SUBJECT = "GLOA ist live. Dein Matcha wartet.";
export const LAUNCH_DAY_PREVIEW_SUBJECT = `[TEST] ${LAUNCH_DAY_SUBJECT}`;

export function buildLaunchDayEmail(input: LaunchDayInput): BuiltLaunchDayEmail {
  const { firstName, origin, preview = false } = input;

  const base = origin.replace(/\/+$/, "");
  const shopUrl = `${base}${LAUNCH_DAY_SHOP_PATH}`;
  const greeting = firstName ? `Hi ${firstName},` : "Hi,";
  const subject = preview ? LAUNCH_DAY_PREVIEW_SUBJECT : LAUNCH_DAY_SUBJECT;

  const body =
    "Es ist so weit. GLOA ist offiziell gestartet und unser Shop ist geöffnet. " +
    "Entdecke unseren Matcha aus Japan und finde deinen neuen Daily Ritual.";

  const footerText =
    "Du erhältst diese E-Mail, weil du dich für die einmalige GLOA Launch-Benachrichtigung " +
    "eingetragen hast. Du erhältst dadurch keine regelmäßigen Newsletter.";

  const text = [
    ...(preview ? ["[TEST] Vorschau der Launch-Mail. Diese Nachricht ging nur an dich.", ""] : []),
    greeting,
    "",
    "THE WAIT IS OVER.",
    "",
    body,
    "",
    "JETZT MATCHA ENTDECKEN:",
    shopUrl,
    "",
    footerText,
    "",
    "GLOA",
    "Cara 2 GmbH, Hardenbergstr. 4, 10623 Berlin",
  ].join("\n");

  // The preview banner. Plum on Cream, no new colour, and it sits above
  // the mark so it is the first thing read.
  const previewBanner = preview
    ? `<tr><td style="padding:0 0 24px 0;font-size:12px;line-height:1.6;letter-spacing:.06em;color:${GLOA_PLUM};border-bottom:1px solid ${GLOA_BLUE};padding-bottom:14px;"><strong>[TEST]</strong> Vorschau der Launch-Mail. Diese Nachricht ging nur an dich, nicht an die Launch List.</td></tr>`
    : "";

  const html = emailShell(
    escapeHtml(subject),
    `${emailPreheader("Unser Shop ist geöffnet. Entdecke GLOA.")}
${previewBanner}
${emailHeader(base)}
${emailEyebrow("GLOA IS LIVE")}
${emailHeadline("THE WAIT<br/>IS OVER.")}
<tr><td style="padding:20px 0 28px 0;font-size:16px;line-height:1.55;color:${GLOA_PLUM};">${escapeHtml(greeting)}<br/>${escapeHtml(body)}</td></tr>
<tr><td style="padding:0 0 28px 0;">
${emailButton(escapeHtml(shopUrl), "Jetzt Matcha entdecken")}
</td></tr>
<tr><td style="padding:0 0 24px 0;font-size:13px;line-height:1.6;color:${GLOA_PLUM};">Falls der Button nicht funktioniert, öffne diesen Link:<br/><a href="${escapeHtml(shopUrl)}" style="color:${GLOA_BLUE};word-break:break-all;">${escapeHtml(shopUrl)}</a></td></tr>
${emailFooter(`${escapeHtml(footerText)}
<br/><br/>
${GLOA_POSTAL_ADDRESS}`)}`
  );

  return { subject, html, text };
}
