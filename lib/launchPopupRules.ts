/**
 * THE LAUNCH POPUP'S DECISIONS, WITHOUT THE POPUP.
 *
 * Zero imports, no React, no DOM, no storage, no clock: every function
 * here takes what it needs as an argument. That is what lets the test
 * suite check the ACTUAL rules - which routes are suppressed, when a
 * dismissal has expired - rather than grep the component for strings.
 *
 * app/LaunchPopup.tsx owns the rendering and the side effects and reads
 * its constants from here, so the numbers a test asserts are the numbers
 * the browser runs. It is a .ts leaf rather than part of the .tsx
 * component because node can import the former directly; the same reason
 * lib/partnershipRequest.ts and lib/annualPlanRules.ts are shaped this
 * way.
 */

/** One key, one timestamp. No cookie, no id, nothing about the visitor. */
export const LAUNCH_POPUP_STORAGE_KEY = "gloa_launch_popup_dismissed_at";

/** Closed means closed for seven days. */
export const LAUNCH_POPUP_DISMISS_MS = 7 * 24 * 60 * 60 * 1000;

/** Idle time before it offers itself. Never on the first paint. */
export const LAUNCH_POPUP_DELAY_MS = 8000;

/** Or this much of the page read, whichever comes first. */
export const LAUNCH_POPUP_SCROLL_RATIO = 0.3;

/**
 * Routes where a marketing panel is an interruption rather than an offer.
 *
 * /launch, because the visitor is already on the launch list. Then every
 * route that is a TASK rather than a browse: the account area, the auth
 * callbacks and the order flow. The admin tree is a separate route
 * namespace that never mounts this shell, so it needs no entry here.
 */
export function suppressesLaunchPopup(route: string): boolean {
  return route === "launch"
    || route.startsWith("account")
    || route.startsWith("auth/")
    || route.startsWith("order/");
}

/**
 * ONE SCREEN, ONE OVERLAY.
 *
 * The popup arms itself on a timer, so it was free to land on top of a
 * mobile menu or a cart drawer the visitor had already opened - two
 * modals at once, the second one interrupting a deliberate action with
 * an offer nobody asked for. A z-index would only decide which of the
 * two won; this decides that there is never a second one.
 *
 * Takes the shell's EXISTING overlay state rather than introducing its
 * own: app/GloaSite.tsx already holds menuOpen and cartOpen and already
 * hands both to the header, the dock and the drawer.
 *
 * Blocking is not cancelling. app/LaunchPopup.tsx keeps the fact that
 * the panel is owed and offers it once the screen is free again, so a
 * timer that came due behind a menu is deferred rather than lost.
 */
export function overlayBlocksLaunchPopup(
  overlays: { menuOpen?: boolean; cartOpen?: boolean }
): boolean {
  return Boolean(overlays.menuOpen || overlays.cartOpen);
}

/**
 * How long to wait after the last overlay closes before a HELD panel
 * appears.
 *
 * Only ever applied to a panel that was actually blocked - an unblocked
 * one still opens the moment its trigger fires, so the 8s/30% contract
 * above is unchanged. The pause exists for two concrete reasons:
 *
 *   the scroll lock  the menu restores body.style and calls scrollTo on
 *                    close. A panel mounting in that same commit would
 *                    set overflow:hidden while the menu was putting it
 *                    back, and whichever ran last would win - a leaked
 *                    lock in one order, a scroll jump in the other.
 *   the eye          a panel appearing in the same frame the menu
 *                    disappears reads as a flicker of one thing rather
 *                    than the arrival of another.
 */
export const LAUNCH_POPUP_SETTLE_MS = 600;

/**
 * Whether a stored dismissal is still in force.
 *
 * `raw` is whatever came out of localStorage - null, a number, or the
 * junk a different tab or an older build could have left behind. Anything
 * unparseable reads as "not dismissed", which shows the popup: the
 * harmless direction to fail in.
 */
export function launchPopupDismissed(raw: string | null, now: number): boolean {
  if (!raw) return false;
  const at = Number(raw);
  if (!Number.isFinite(at)) return false;
  return now - at < LAUNCH_POPUP_DISMISS_MS;
}
