/**
 * Where Supabase must send a user back to after they click an auth email.
 *
 * This exists because forgetting it is silent and expensive. Supabase does
 * not error when `redirectTo` is missing or not allow-listed: it quietly
 * falls back to the project's Site URL. The customer then lands on the
 * homepage instead of the page that was supposed to handle their link,
 * the recovery token in the URL fragment is consumed by supabase-js on
 * the way past, and the only visible trace is a bare "#" left on the
 * address bar. Nothing logs, nothing throws, and the customer simply
 * cannot reset their password.
 *
 * That is exactly what happened after the gloamatcha.com cutover, from
 * the one call site that passed no redirect at all. So the paths and the
 * construction live here, once, and every caller goes through them.
 *
 * Pure and leaf: no imports, no DB, no network, no import.meta.env, so it
 * is directly unit-testable.
 */

/** The page that finishes a signup confirmation. */
export const AUTH_CONFIRM_PATH = "/auth/confirm";

/** The page that finishes a password recovery. */
export const PASSWORD_RESET_PATH = "/account/reset-password";

export type AuthRedirectPath = typeof AUTH_CONFIRM_PATH | typeof PASSWORD_RESET_PATH;

/**
 * Builds the absolute URL for one auth landing page.
 *
 * Every value this produces must ALSO be present in Supabase's
 * Authentication → URL Configuration redirect allow list. An origin that
 * is not on that list is not rejected, it is ignored, which is the whole
 * failure mode above.
 */
export function authRedirectUrl(origin: string, path: AuthRedirectPath): string {
  return `${origin.replace(/\/+$/, "")}${path}`;
}

/**
 * The same thing for the browser, where the origin is whatever host the
 * customer is actually on.
 *
 * Deliberately NOT a hardcoded production domain: that would be a second
 * source of truth to keep in step with Supabase's allow list, and it
 * would break local development. On gloamatcha.com this returns
 * https://gloamatcha.com/... , which is what the allow list contains.
 *
 * Returns undefined off the browser, which is unreachable from the event
 * handlers that call it. Undefined is deliberately not "" - an empty
 * redirect is indistinguishable to Supabase from no redirect at all, and
 * that is the bug this file exists to prevent.
 */
export function browserAuthRedirectUrl(path: AuthRedirectPath): string | undefined {
  if (typeof window === "undefined") return undefined;
  return authRedirectUrl(window.location.origin, path);
}
