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
