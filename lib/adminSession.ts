import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * THE ADMIN BROWSER SESSION.
 *
 * The launch admin API already has authentication - a Bearer secret,
 * lib/launchAdminAuth.ts - and it is the right shape for a machine
 * calling an endpoint. It is the wrong shape for a person opening a page
 * in a browser: a browser cannot be handed LAUNCH_ADMIN_SECRET without
 * putting it in reach of every script on the page.
 *
 * So the browser gets a session instead, and the secret never leaves the
 * server.
 *
 * ── WHY THIS IS NOT A SECOND AUTH SYSTEM ──────────────────────
 *
 * It does not check passwords. Supabase Auth does that, exactly as it
 * does for customers - one password store, one set of hashing rules, one
 * place that gets rate limiting and reset flows right. An admin account
 * is an ordinary Supabase user that happens to appear on an allowlist.
 *
 * What this module adds is the step after: the server confirms the
 * password with Supabase, checks the allowlist, and then issues its OWN
 * short-lived token. That token is the only credential the browser ever
 * holds, and it is worth nothing anywhere except these pages.
 *
 * ── THE TOKEN, AND WHY IT LOOKS LIKE THIS ─────────────────────
 *
 *   v1.<base64url payload>.<hmac>
 *
 * Signed, not encrypted: the payload is an email and an expiry, neither
 * of which is a secret from the person already holding the cookie. What
 * matters is that it cannot be FORGED, which the HMAC gives.
 *
 * The expiry is inside the signed payload rather than left to the
 * cookie's own Max-Age, because a cookie's lifetime is a hint the client
 * controls and this one is a rule the server enforces.
 *
 * ── PURE ──────────────────────────────────────────────────────
 *
 * No clock, no environment, no network. `now` and the secret are
 * arguments, so expiry is testable to the millisecond and this file
 * loads as a leaf under plain Node.
 */

/**
 * Domain separation. The signing key may be shared with another use, so
 * the message carries a label belonging to this one and no other - the
 * same reasoning as the rate limiter's bucket HMAC.
 */
const SESSION_LABEL = "gloa:admin-session:v1";

/** The cookie the browser gets. Named without the word "admin" on purpose. */
export const ADMIN_SESSION_COOKIE = "gloa_ops";

/**
 * Eight hours. Long enough to work through a launch day without being
 * asked again, short enough that a forgotten open laptop stops mattering
 * the same evening.
 */
export const ADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1000;

/** Below this a signing key is refused as misconfigured, not merely weak. */
export const ADMIN_SESSION_SECRET_MIN_LENGTH = 32;

export type AdminSession = { email: string; expiresAtMs: number };

function b64url(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(`${SESSION_LABEL}.${payload}`, "utf8").digest("base64url");
}

/**
 * Issues a session token for an address that has ALREADY been
 * authenticated and authorised. This function does neither - it is the
 * last step, not the check.
 */
export function issueAdminSession(email: string, nowMs: number, secret: string): string {
  const payload = b64url(JSON.stringify({ e: email, x: nowMs + ADMIN_SESSION_TTL_MS }));
  return `v1.${payload}.${sign(payload, secret)}`;
}

/**
 * Verifies a token and returns the session, or null.
 *
 * Every failure returns null and none of them says which: a forged
 * signature, an expired token and a malformed one are the same answer to
 * the caller. The signature is compared in constant time.
 */
export function readAdminSession(
  token: string | null | undefined,
  nowMs: number,
  secret: string | null | undefined
): AdminSession | null {
  if (!token || !secret || secret.length < ADMIN_SESSION_SECRET_MIN_LENGTH) return null;

  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;
  const [, payload, mac] = parts;

  const expected = sign(payload, secret);
  const a = Buffer.from(mac, "utf8");
  const b = Buffer.from(expected, "utf8");
  // Length is checked first: timingSafeEqual throws on a mismatch, and a
  // thrown error would itself be a signal.
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;

  const { e, x } = parsed as { e?: unknown; x?: unknown };
  if (typeof e !== "string" || !e || typeof x !== "number" || !Number.isFinite(x)) return null;

  // THE EXPIRY IS ENFORCED HERE, from the signed payload - not from the
  // cookie's Max-Age, which the client controls.
  if (nowMs >= x) return null;

  return { email: e, expiresAtMs: x };
}

/**
 * The Set-Cookie value.
 *
 * HttpOnly so no script can read it, Secure so it never travels in
 * clear, SameSite=Strict so a page on another origin cannot cause an
 * authenticated request at all - which is what removes the CSRF surface
 * rather than merely mitigating it. Path is the whole site because both
 * the pages and their API live under it.
 */
export function adminSessionCookie(token: string, maxAgeSeconds: number): string {
  return [
    `${ADMIN_SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
  ].join("; ");
}

/** Clearing it is the same cookie with no value and no lifetime. */
export function clearedAdminSessionCookie(): string {
  return adminSessionCookie("", 0);
}

/** Reads one cookie out of a Cookie header without a parser dependency. */
export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim() || null;
  }
  return null;
}

/**
 * WHO IS ALLOWED IN.
 *
 * A comma-separated allowlist, compared on the normalised address. Being
 * able to sign in to Supabase is NOT authorisation - every customer can
 * do that. Authorisation is appearing on this list, which only somebody
 * with access to the deployment's environment can change.
 *
 * An empty or unset list authorises NOBODY. An admin surface whose
 * allowlist was forgotten must be shut, not open.
 */
export function parseAdminAllowlist(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0 && entry.includes("@"));
}

export function isAllowedAdmin(email: string | null | undefined, allowlist: readonly string[]): boolean {
  if (!email || allowlist.length === 0) return false;
  return allowlist.includes(email.trim().toLowerCase());
}
