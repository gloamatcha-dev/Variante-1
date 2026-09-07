import { getSupabaseAdmin } from "./supabaseAdmin";
import {
  LAUNCH_RATE_LIMIT_WINDOW_SECONDS,
  pseudonymizeBucketKey,
  rateLimitKeyFromRequest,
} from "./launchRateLimit";
import { consumePersistentRateLimit } from "./launchRateLimitStore";
import {
  ADMIN_RATE_LIMIT_MAX,
  authorizeLaunchAdmin,
  type AdminAuthOutcome,
} from "./launchAdminAuth.ts";

/**
 * THE GUARD EVERY LAUNCH ADMIN ENDPOINT RUNS FIRST.
 *
 * Three endpoints share one door, so the door is described once. Each of
 * them can do something the shop cannot take back, and none of them may
 * be reachable by anything except a caller holding LAUNCH_ADMIN_SECRET.
 *
 * ── THE ORDER OF THE CHECKS IS THE DESIGN ─────────────────────
 *
 *   1. METHOD. POST only, always. A GET that starts a send would be
 *      triggerable by a link in a chat window, a prefetch, a crawler or
 *      a browser restoring a tab - and would sit in every proxy log on
 *      the way. There is no GET handler on any of these routes at all,
 *      so this is belt and braces with the absence of one.
 *
 *   2. RATE LIMIT, BEFORE THE SECRET IS COMPARED. This is the part that
 *      is easy to get backwards. Limiting only after a failed comparison
 *      still lets an attacker spend the endpoint's whole capacity
 *      guessing, and limiting per instance would reset with every cold
 *      start. So every attempt - right or wrong - is counted first,
 *      against the SHARED counter in migration 043 that the public
 *      signup already uses.
 *
 *      It fails CLOSED. If that counter cannot be reached, the request
 *      is refused rather than waved through: an admin endpoint is
 *      exactly the wrong place to degrade to "unlimited attempts".
 *
 *   3. THE SECRET, compared in constant time, with an unset or too-short
 *      value treated as a refusal for everybody.
 *
 * ── WHAT A CALLER LEARNS FROM A REFUSAL ───────────────────────
 *
 * As little as possible. A wrong secret and a missing secret both come
 * back 401 with the same body, so the endpoint cannot be used to
 * discover whether it is configured. Only the log distinguishes them,
 * and it names the absence, never the value.
 *
 * ── NO BROWSER SESSION, THEREFORE NO CSRF SURFACE ─────────────
 *
 * Authorization is a Bearer header and nothing else. There is no cookie,
 * no session and no same-origin form path, so a page on another origin
 * cannot make an authenticated request on somebody's behalf - the
 * browser would have to be given the secret to attach, and it never has
 * it. When the admin UI is built it will hold the secret server-side and
 * call these endpoints from its own backend; if it ever grows a cookie
 * session, THAT is where CSRF protection belongs, and this note is here
 * so the question is not forgotten.
 */

export type AdminGateResult =
  | { ok: true }
  | { ok: false; response: Response };

type ErrorBody = { error: string };

function json(body: unknown, status: number, headers?: Record<string, string>): Response {
  return Response.json(body, { status, headers });
}

/** The one refusal an unauthorized caller ever sees. */
function unauthorized(): Response {
  return json({ error: "Nicht autorisiert." } as ErrorBody, 401);
}

export async function guardLaunchAdmin(request: Request): Promise<AdminGateResult> {
  if (request.method !== "POST") {
    return { ok: false, response: json({ error: "Methode nicht erlaubt." } as ErrorBody, 405) };
  }

  const supabase = getSupabaseAdmin();
  if (!supabase) {
    console.error("Launch admin: supabase admin client is not configured - refusing.");
    return { ok: false, response: json({ error: "Nicht verfügbar." } as ErrorBody, 503) };
  }

  // ── 2. THE ATTEMPT IS COUNTED BEFORE IT IS JUDGED ───────────
  const secretForBucket = process.env.LAUNCH_RATE_LIMIT_SECRET || process.env.SUPABASE_SECRET_KEY;
  if (!secretForBucket) {
    console.error("Launch admin: no bucket secret configured - refusing.");
    return { ok: false, response: json({ error: "Nicht verfügbar." } as ErrorBody, 503) };
  }

  const bucketKey = pseudonymizeBucketKey(
    `admin:${rateLimitKeyFromRequest(request)}`,
    secretForBucket
  );

  const limit = await consumePersistentRateLimit(
    supabase,
    bucketKey,
    ADMIN_RATE_LIMIT_MAX,
    LAUNCH_RATE_LIMIT_WINDOW_SECONDS
  );

  if (limit.kind === "limited") {
    return {
      ok: false,
      response: json({ error: "Zu viele Versuche." } as ErrorBody, 429, {
        "Retry-After": String(Math.max(1, Math.ceil(limit.retryAfterSeconds))),
      }),
    };
  }

  if (limit.kind === "unavailable") {
    // Fails closed. The reason never contains the address or the digest.
    console.error("Launch admin: shared rate limit unavailable - refusing:", limit.reason);
    return { ok: false, response: json({ error: "Nicht verfügbar." } as ErrorBody, 503) };
  }

  // ── 3. THE SECRET ───────────────────────────────────────────
  const outcome: AdminAuthOutcome = authorizeLaunchAdmin(request, process.env.LAUNCH_ADMIN_SECRET);

  if (outcome.kind === "misconfigured") {
    // The absence is logged; the value never is. The CALLER is told the
    // same thing a wrong secret is told, so the endpoint cannot be
    // probed for whether it is configured.
    console.error("Launch admin: refusing every request -", outcome.reason);
    return { ok: false, response: unauthorized() };
  }

  if (outcome.kind === "unauthorized") {
    return { ok: false, response: unauthorized() };
  }

  return { ok: true };
}

/** Reads and parses a small JSON body. Never throws. */
export async function readAdminBody(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) return null;
  try {
    const raw = await request.text();
    if (raw.length > 4000) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
