/**
 * Server-only site origin for building Stripe redirect URLs.
 *
 * Deliberately NOT derived from request headers (x-forwarded-host, host).
 * Those headers are not on the browser's forbidden-header list, so any
 * caller of this public, unauthenticated endpoint can set them directly
 * (fetch, curl, etc). Whether a proxy in front of this app overwrites them
 * before they reach server code depends on the specific deployment target,
 * which isn't provably fixed for this project. Trusting them here would let
 * an attacker redirect a paying customer to an arbitrary domain after
 * checkout. SITE_URL must be configured explicitly per environment instead.
 */
export function getSiteOrigin(): string | null {
  const siteUrl = process.env.SITE_URL;
  if (!siteUrl) return null;
  return siteUrl.replace(/\/+$/, "");
}
