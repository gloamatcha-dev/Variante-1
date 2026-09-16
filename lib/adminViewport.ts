/**
 * THE ADMIN IS A DESKTOP TOOL, AND SAYS SO.
 *
 * A product decision, not a technical limitation: the operations screen
 * is tables, filters, drawers and destructive actions, and squeezing
 * that onto a phone produced something dense enough to be a hazard.
 * Below the width below, GLOA shows one sentence instead of a cramped
 * version of a screen nobody should be operating with a thumb.
 *
 * ── THIS IS NOT A SECURITY BOUNDARY, AND MUST NEVER BE READ AS ONE ──
 *
 * A viewport is a hint the client supplies. It can be resized, spoofed,
 * or simply absent - and `curl` has no viewport at all. NOTHING here
 * authorises anything.
 *
 * Every real gate is on the server and is unchanged by this file:
 *
 *   authentication      Supabase Auth checks the password
 *   session             the signed v2 cookie, verified per request
 *   allowlist           ADMIN_EMAILS, during the transition
 *   identity            admin_users, read per request
 *   role                owner/admin/viewer, enforced in openAdminAction
 *   database            RLS, grants, and the service role staying server-side
 *
 * Somebody who calls an admin endpoint from a phone still meets all of
 * them. What they do not get is a user interface. That is the whole of
 * what this module does.
 *
 * ── PURE ──────────────────────────────────────────────────────
 *
 * No React, no DOM, no window. The predicate takes a number, so the
 * boundary is testable to the pixel and this file loads as a leaf under
 * plain Node.
 */

/**
 * The narrowest viewport the operations screen is designed for.
 *
 * 1024 rather than a phone-sized number on purpose: the admin's tables
 * and drawers need the room, and a tablet in portrait (768) is no more
 * workable for them than a phone. One number, used by the media query,
 * the component and the tests alike.
 */
export const ADMIN_MIN_DESKTOP_WIDTH = 1024;

/** The media query the browser actually evaluates. */
export const ADMIN_DESKTOP_MEDIA_QUERY = `(min-width: ${ADMIN_MIN_DESKTOP_WIDTH}px)`;

/**
 * Whether a viewport width may operate the admin.
 *
 * Inclusive at the boundary: 1023 is refused, 1024 is allowed, which is
 * exactly what `(min-width: 1024px)` does - so the CSS and the component
 * can never disagree about the edge.
 */
export function isAdminDesktopWidth(width: number): boolean {
  if (!Number.isFinite(width)) return false;
  return width >= ADMIN_MIN_DESKTOP_WIDTH;
}

/** The copy the small-viewport screen shows. German, and deliberately short. */
export const ADMIN_DESKTOP_ONLY_COPY = Object.freeze({
  eyebrow: "GLOA · OPERATIONS",
  title: "Admin nur am Desktop verfügbar",
  body: "Der interne GLOA Admin ist für die Nutzung am Desktop optimiert. "
    + "Bitte öffne diese Seite auf einem Gerät mit größerem Bildschirm.",
});
