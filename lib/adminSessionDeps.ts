import { createClient } from "@supabase/supabase-js";
import {
  ADMIN_SESSION_COOKIE,
  ADMIN_SESSION_SECRET_MIN_LENGTH,
  isAllowedAdmin,
  parseAdminAllowlist,
  readAdminSession,
  readCookie,
  type AdminSession,
} from "./adminSession.ts";

/**
 * THE ENVIRONMENT-DEPENDENT HALF OF THE ADMIN SESSION.
 *
 * lib/adminSession.ts is pure arithmetic over a token. This module is
 * where the secret, the allowlist and Supabase Auth are actually read,
 * so there is one place to look for how an admin is authenticated and
 * one place that can be wrong about it.
 */

/**
 * The key that signs sessions.
 *
 * Prefers a dedicated secret and falls back to the Supabase secret key,
 * so a deployment needs no new variable to get a working admin login -
 * the fallback is already present, already server-only, and the HMAC
 * label in adminSession.ts keeps this use separate from every other.
 *
 * NEITHER IS EVER SENT ANYWHERE. Only the signed token is, and a token
 * cannot be turned back into the key.
 */
export function getAdminSessionSecret(): string | null {
  const secret = process.env.ADMIN_SESSION_SECRET || process.env.SUPABASE_SECRET_KEY || null;
  if (!secret || secret.length < ADMIN_SESSION_SECRET_MIN_LENGTH) return null;
  return secret;
}

export function getAdminAllowlist(): string[] {
  return parseAdminAllowlist(process.env.ADMIN_EMAILS);
}

/**
 * VERIFIES A REQUEST'S SESSION COOKIE.
 *
 * Two independent conditions, and both are re-checked on EVERY request
 * rather than trusted from the moment the session was issued:
 *
 *   1. The token is signed by this deployment and has not expired.
 *   2. The address it names is STILL on the allowlist.
 *
 * The second matters: removing somebody from ADMIN_EMAILS and
 * redeploying has to lock them out immediately, not in eight hours when
 * their token happens to lapse.
 */
export function verifyAdminRequest(request: Request, nowMs: number = Date.now()): AdminSession | null {
  const secret = getAdminSessionSecret();
  if (!secret) return null;

  const token = readCookie(request.headers.get("cookie"), ADMIN_SESSION_COOKIE);
  const session = readAdminSession(token, nowMs, secret);
  if (!session) return null;

  if (!isAllowedAdmin(session.email, getAdminAllowlist())) return null;

  return session;
}

export type PasswordCheck =
  | { ok: true; email: string }
  | { ok: false; reason: "invalid" | "unconfigured" };

/**
 * CHECKS A PASSWORD, USING SUPABASE AUTH AND NOT A SECOND PASSWORD STORE.
 *
 * A short-lived anon client is built per attempt and thrown away. It
 * never touches the module-level client the site uses, so a sign-in here
 * cannot disturb a customer session in the same process.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: keep the Supabase token. It is used
 * to prove the password and then discarded - the browser gets this
 * application's own session cookie instead, so no Supabase credential
 * ever reaches a script on the page.
 *
 * Being able to sign in proves only that an account exists. Whether that
 * account may see anything is decided by the allowlist, separately, by
 * the caller.
 */
export async function checkAdminPassword(email: string, password: string): Promise<PasswordCheck> {
  const url = import.meta.env.VITE_SUPABASE_URL;
  const anonKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !anonKey) return { ok: false, reason: "unconfigured" };

  const client = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.user?.email) return { ok: false, reason: "invalid" };

  // The token is not returned and not stored. It has done its one job.
  await client.auth.signOut().catch(() => undefined);

  return { ok: true, email: data.user.email };
}
