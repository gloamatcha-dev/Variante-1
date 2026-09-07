import {
  ADMIN_SESSION_TTL_MS,
  adminSessionCookie,
  clearedAdminSessionCookie,
  isAllowedAdmin,
  issueAdminSession,
} from "../../../../lib/adminSession.ts";
import {
  checkAdminPassword,
  getAdminAllowlist,
  getAdminSessionSecret,
  verifyAdminRequest,
} from "../../../../lib/adminSessionDeps.ts";
import { getSupabaseAdmin } from "../../../../lib/supabaseAdmin";
import {
  LAUNCH_RATE_LIMIT_WINDOW_SECONDS,
  pseudonymizeBucketKey,
  rateLimitKeyFromRequest,
} from "../../../../lib/launchRateLimit";
import { consumePersistentRateLimit } from "../../../../lib/launchRateLimitStore";

/**
 * SIGNING IN AND OUT OF THE ADMIN OVERVIEW.
 *
 * POST   with { email, password } -> sets the session cookie
 * DELETE with a session cookie    -> clears it
 *
 * ── THE PASSWORD IS NOT CHECKED HERE ──────────────────────────
 *
 * Supabase Auth checks it, exactly as it does for customers. There is
 * one password store in this system and this endpoint does not become a
 * second one. What it adds is the part Supabase cannot know: whether
 * this particular account is allowed to see the launch list.
 *
 * Signing in and being authorised are therefore two separate answers,
 * and a customer with a valid password gets the first and not the
 * second.
 *
 * ── ATTEMPTS ARE LIMITED BEFORE THE PASSWORD IS TRIED ─────────
 *
 * Against the shared counter in migration 043, so the limit holds across
 * serverless instances. Counting only failures would let an attacker
 * spend the endpoint's whole capacity guessing; counting after the check
 * would mean every guess costs a password verification. It fails closed:
 * if the counter cannot be reached, the request is refused.
 *
 * ── WHAT A CALLER LEARNS FROM A REFUSAL ───────────────────────
 *
 * Nothing. A wrong password, an unknown address, a correct password for
 * an account that is not on the allowlist, and a deployment with no
 * allowlist at all all return the same 401 with the same body. Only the
 * log distinguishes them, and it never names the password.
 */

const MAX_BODY_BYTES = 2000;

/** Tight: an operator signs in once or twice, never ten times. */
const LOGIN_ATTEMPTS_PER_WINDOW = 5;

function unauthorized(): Response {
  return Response.json({ error: "Anmeldung fehlgeschlagen." }, { status: 401 });
}

export async function POST(request: Request): Promise<Response> {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return Response.json({ error: "Ungültige Anfrage." }, { status: 400 });
  }

  const supabase = getSupabaseAdmin();
  const secret = getAdminSessionSecret();
  if (!supabase || !secret) {
    console.error("Admin session: not configured - refusing every sign-in.");
    return unauthorized();
  }

  // ── THE ATTEMPT IS COUNTED BEFORE IT IS JUDGED ──────────────
  const bucketSecret = process.env.LAUNCH_RATE_LIMIT_SECRET || process.env.SUPABASE_SECRET_KEY;
  if (!bucketSecret) {
    console.error("Admin session: no bucket secret configured - refusing.");
    return unauthorized();
  }
  const bucketKey = pseudonymizeBucketKey(
    `admin-login:${rateLimitKeyFromRequest(request)}`,
    bucketSecret
  );
  const limit = await consumePersistentRateLimit(
    supabase,
    bucketKey,
    LOGIN_ATTEMPTS_PER_WINDOW,
    LAUNCH_RATE_LIMIT_WINDOW_SECONDS
  );
  if (limit.kind === "limited") {
    return Response.json({ error: "Zu viele Versuche." }, {
      status: 429,
      headers: { "Retry-After": String(Math.max(1, Math.ceil(limit.retryAfterSeconds))) },
    });
  }
  if (limit.kind === "unavailable") {
    console.error("Admin session: shared rate limit unavailable - refusing:", limit.reason);
    return unauthorized();
  }

  let body: unknown;
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return Response.json({ error: "Ungültige Anfrage." }, { status: 400 });
    body = JSON.parse(raw);
  } catch {
    return Response.json({ error: "Ungültige Anfrage." }, { status: 400 });
  }

  const { email, password } = (body ?? {}) as { email?: unknown; password?: unknown };
  if (typeof email !== "string" || typeof password !== "string" || !email || !password) {
    return unauthorized();
  }

  // Cheapest check first: an address that is not on the allowlist never
  // reaches the password check at all.
  const allowlist = getAdminAllowlist();
  if (!isAllowedAdmin(email, allowlist)) {
    if (allowlist.length === 0) {
      console.error("Admin session: ADMIN_EMAILS is empty - nobody can sign in.");
    }
    return unauthorized();
  }

  const check = await checkAdminPassword(email, password);
  if (!check.ok) {
    if (check.reason === "unconfigured") {
      console.error("Admin session: Supabase auth is not configured.");
    }
    return unauthorized();
  }

  // Authorised on the address Supabase confirmed, never the one the body
  // claimed - they are the same here, but only one of them is verified.
  if (!isAllowedAdmin(check.email, allowlist)) return unauthorized();

  const token = issueAdminSession(check.email.toLowerCase(), Date.now(), secret);

  return Response.json(
    { ok: true },
    {
      status: 200,
      headers: {
        "Set-Cookie": adminSessionCookie(token, ADMIN_SESSION_TTL_MS / 1000),
        "Cache-Control": "no-store",
      },
    }
  );
}

/** Signing out. Idempotent: clearing a cookie that is not there is fine. */
export async function DELETE(request: Request): Promise<Response> {
  // Not an error if there was no session - the outcome is the same
  // either way, and saying "you were not signed in" tells a caller
  // something about a cookie they do not hold.
  verifyAdminRequest(request);
  return Response.json(
    { ok: true },
    { status: 200, headers: { "Set-Cookie": clearedAdminSessionCookie(), "Cache-Control": "no-store" } }
  );
}
