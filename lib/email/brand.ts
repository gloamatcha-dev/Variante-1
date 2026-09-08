/**
 * THE GLOA EMAIL BRAND SYSTEM, IN ONE PLACE.
 *
 * Thirteen transactional templates each built their own HTML, and none
 * of them carried the logo. That is how a mail that is otherwise correct
 * still arrives looking like it came from somewhere else - and it is why
 * this module exists: the colours, the mark and the shell are stated
 * once, and a template composes them rather than restating them.
 *
 * ── PURE, AND A LEAF ──────────────────────────────────────────
 *
 * No clock, no network, no database, no environment and no relative
 * runtime import. Every value is either a literal or a function of its
 * arguments, so the suite can load this module directly under plain Node
 * and assert the actual bytes an inbox would receive - the same
 * constraint lib/launchWaitlist.ts and lib/launchRateLimitStore.ts
 * record for themselves.
 *
 * ── WHY THE MARK IS A PNG AND NOT THE SVG ─────────────────────
 *
 * The site renders the wordmark as a CSS mask over
 * /gloa-logo-schwarz.svg, which is exact and recolours itself with
 * `currentColor`. An inbox can do none of that. Outlook's Word-based
 * renderer does not draw SVG at all, several clients strip <svg>
 * outright, and CSS masks are not available anywhere in mail. So mail
 * gets a raster copy of the SAME approved artwork - rendered from that
 * one SVG, at the same geometry, only recoloured - and the site keeps
 * the vector.
 *
 * The file referenced here is /gloa-logo-blue-600.png: the approved
 * wordmark, GLOA Blue #1746D1, transparent background, 600px wide for a
 * ~200px display box so it stays sharp on a 3x screen.
 *
 * ── WHAT MUST NEVER BE PUT HERE ───────────────────────────────
 *
 * The wordmark is NOT rebuilt from a font, and it is NOT regenerated.
 * The O is the approved organic glyph and may not be swapped for a round
 * O, a star or any other symbol. The slogan, where it appears at all, is
 * exactly "MATCHA IS FOR EVERYONE." and nothing else.
 *
 * The Cream-background slogan lockup (/gloa-logo-slogan-link.png) is a
 * SOCIAL PREVIEW IMAGE, not a logo. It carries its own baked-in
 * background and its own lockup proportions, so dropping it into a mail
 * header would put a second cream rectangle inside a cream mail and
 * shrink the wordmark to illegibility. It is deliberately not exported
 * from this module.
 */

/* ══════════════════════════════════════════════════════════════
   MASTER COLOURS
   ══════════════════════════════════════════════════════════════ */

export const GLOA_BLUE = "#1746D1";
export const GLOA_BERRY = "#A61E59";
export const GLOA_CREAM = "#F5EBE2";
export const GLOA_PLUM = "#4F3A5B";
export const GLOA_NEAR_BLACK = "#111111";

/**
 * The hairline used between a mail's body and its legal footer. Plum at
 * low alpha rather than a grey, so the one divider in the design still
 * belongs to the palette.
 */
export const GLOA_RULE = "rgba(79,58,91,.22)";

/* ══════════════════════════════════════════════════════════════
   THE MARK
   ══════════════════════════════════════════════════════════════ */

/**
 * Absolute HTTPS URL of the approved wordmark, as a mail must carry.
 *
 * A relative path is meaningless in an inbox - there is no page for it
 * to be relative to - and an http:// URL is either blocked or downgraded
 * by most clients. The origin is passed in rather than read from the
 * environment so this module stays pure and the caller keeps using
 * getSiteOrigin(), which already refuses to guess an origin from
 * attacker-controlled headers.
 */
export function logoUrl(origin: string): string {
  return `${origin.replace(/\/+$/, "")}/gloa-logo-blue-600.png`;
}

/**
 * Can this origin actually produce an image an inbox will load?
 *
 * The comment above has said since the launch mails were built that a
 * relative path is meaningless in an inbox and an http:// URL is blocked
 * or downgraded by most clients. It was a reason, not a rule, and the
 * difference cost a delivered mail: a test send picked up SITE_URL from
 * .env.local, which is http://localhost:3000, and Gmail on iOS drew the
 * broken-image glyph. The file on the real domain was fine the whole
 * time - it was never asked for.
 *
 * So the reason is now enforced. An origin that cannot work in an inbox
 * is treated exactly like a missing one, because the existing rule -
 * build the mail WITHOUT the mark rather than with a broken image - is
 * the right answer to both.
 *
 * Deliberately narrow: https, a host with a dot in it, and not a
 * loopback or .local name. It does not try to guess whether a given
 * public host is the right one; that is the caller's business, and a
 * check that pretended otherwise would be false comfort.
 */
export function isMailableOrigin(origin: string | null | undefined): boolean {
  if (!origin) return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1") return false;
  if (host.endsWith(".local") || host.endsWith(".localhost")) return false;
  return host.includes(".");
}

/** Display width of the mark in the mail header, in CSS pixels. */
export const LOGO_DISPLAY_WIDTH = 132;

/**
 * Intrinsic aspect ratio of the approved artwork, 825.444 x 248.443.
 * Height is derived from it rather than typed, so the mark can never be
 * stretched by a rounding mistake in a template.
 */
export const LOGO_DISPLAY_HEIGHT = Math.round((LOGO_DISPLAY_WIDTH * 248.443) / 825.444);

/**
 * The header block: the mark, and nothing else.
 *
 * Width and height are set as HTML attributes as well as in the style,
 * because Outlook ignores CSS dimensions on images and would otherwise
 * draw the file at its intrinsic 600px and blow the layout apart.
 * `display:block` kills the descender gap that inline images inherit,
 * and the alt text is the brand name alone - the mark IS the word GLOA,
 * so "GLOA logo" would be read out as "GLOA logo" by a screen reader
 * where the mark is standing in for the word.
 */
export function emailHeader(origin: string): string {
  // An origin that cannot load in an inbox is treated as no origin at
  // all. Callers already write `origin ? emailHeader(origin) : ""`, so
  // an empty string here lands them in the branch they already handle.
  if (!isMailableOrigin(origin)) return "";
  return `<tr><td style="padding:0 0 32px 0;">
<img src="${logoUrl(origin)}" alt="GLOA" width="${LOGO_DISPLAY_WIDTH}" height="${LOGO_DISPLAY_HEIGHT}" style="display:block;width:${LOGO_DISPLAY_WIDTH}px;height:${LOGO_DISPLAY_HEIGHT}px;border:0;outline:none;text-decoration:none;"/>
</td></tr>`;
}

/* ══════════════════════════════════════════════════════════════
   BUILDING BLOCKS
   ══════════════════════════════════════════════════════════════ */

/**
 * The one button shape GLOA mail uses: a rectangle, Blue on Cream, with
 * the label in the same tracked uppercase the site uses for its calls to
 * action. No radius, no gradient, no shadow.
 *
 * Built as a padded anchor rather than a table so it degrades to a plain
 * link where a client strips the styling, which is the failure mode that
 * still leaves the reader able to act.
 */
export function emailButton(href: string, label: string): string {
  return `<a href="${href}" style="display:inline-block;background:${GLOA_BLUE};color:${GLOA_CREAM};text-decoration:none;padding:16px 28px;font-size:12px;font-weight:600;letter-spacing:.16em;text-transform:uppercase;">${label}</a>`;
}

/** The small tracked label above a headline. Berry, so it reads as GLOA. */
export function emailEyebrow(text: string): string {
  return `<tr><td style="padding:0 0 28px 0;font-size:11px;letter-spacing:.2em;text-transform:uppercase;font-weight:600;color:${GLOA_BERRY};">${text}</td></tr>`;
}

/** The headline. Heavy, tight, near black - the site's display voice. */
export function emailHeadline(html: string): string {
  return `<tr><td style="padding:0 0 8px 0;font-size:34px;line-height:1.05;letter-spacing:-.03em;font-weight:800;color:${GLOA_NEAR_BLACK};">${html}</td></tr>`;
}

/**
 * The shell every GLOA mail sits in.
 *
 * Table-based, inline-styled, one column, max 520px. That is not a
 * stylistic choice: it is the only layout that survives Outlook, Gmail's
 * proxy and Apple Mail alike. The outer table paints the Cream so the
 * mail does not sit on a client's white, and `rows` is inserted verbatim
 * so a template keeps full control of its own content.
 */
export function emailShell(subject: string, rows: string): string {
  return `<!doctype html>
<html lang="de">
<head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${subject}</title></head>
<body style="margin:0;padding:0;background:${GLOA_CREAM};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${GLOA_CREAM};">
<tr><td align="center" style="padding:40px 20px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;background:${GLOA_CREAM};font-family:Inter,Helvetica,Arial,sans-serif;color:${GLOA_NEAR_BLACK};">
${rows}
</table>
</td></tr>
</table>
</body>
</html>`;
}

/** The legal foot, above the rule. Small, plum, never a call to action. */
export function emailFooter(html: string): string {
  return `<tr><td style="padding:24px 0 0 0;border-top:1px solid ${GLOA_RULE};font-size:12px;line-height:1.7;color:${GLOA_PLUM};">
${html}
</td></tr>`;
}

/** The postal identity every GLOA mail carries. */
export const GLOA_POSTAL_ADDRESS = "GLOA &middot; Cara 2 GmbH, Hardenbergstr. 4, 10623 Berlin";

/**
 * The preheader: the line a client shows next to the subject.
 *
 * Hidden in the body itself. Without one, clients pull the first visible
 * text - which, once a mail starts with a logo, is whatever follows it.
 * The zero-width padding stops the client filling the rest of the
 * preview with the body copy.
 */
export function emailPreheader(text: string): string {
  return `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${text}${"&#847;&zwnj;&nbsp;".repeat(60)}</div>`;
}

/** Shared HTML escaping, so thirteen templates cannot drift on it. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
