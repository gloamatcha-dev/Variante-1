import { createHmac } from "node:crypto";

/**
 * THE RATE LIMIT FOR THE LAUNCH SIGNUP, IN TWO LAYERS.
 *
 * The signup endpoint is public, unauthenticated and sends mail on
 * success. That combination is worth abusing twice over: to fill the
 * list with addresses nobody typed, and to use GLOA's sending domain to
 * post confirmation mail at somebody else's inbox. The honeypot the
 * contact form already uses catches indiscriminate form-fillers; it does
 * nothing against a script that posts a valid body in a loop.
 *
 * -- LAYER 1: THIS MODULE, IN PROCESS MEMORY -------------------
 * A fixed-window counter in the server process. It costs nothing, it
 * needs no round trip, and it absorbs a flood that arrives at one
 * instance. It is deliberately NOT presented as more than that:
 *
 *   - It is per instance. A deployment that runs several instances
 *     limits per instance, not globally.
 *   - It is lost on restart, and a serverless platform restarts
 *     constantly.
 *   - It is not a defence against a large distributed source.
 *
 * -- LAYER 2: THE DATABASE, WHERE THE REAL LIMIT LIVES ---------
 * Because this site is deployed serverless, layer 1 alone would be
 * defeated by the platform itself: sustained load is exactly what makes
 * it hand out fresh instances with empty counters. So the limit that
 * actually holds is a shared counter in Postgres -
 * lib/launchRateLimitStore.ts and migration 043 - which every instance
 * sees and which one atomic statement increments.
 *
 * Supabase is used rather than Redis, Upstash or a rate-limit SaaS,
 * because it is already here. A second datastore for one form would add
 * a vendor, a credential, a failure mode and a data-processing
 * agreement to a repository that needs none of them.
 *
 * -- NO RAW ADDRESS IS EVER STORED -----------------------------
 * A shared counter needs a key both instances agree on, and the obvious
 * candidate - the client address - is personal data that this feature
 * has no business keeping. `pseudonymizeBucketKey` below HMACs it with a
 * server-side secret before it leaves the request handler, so what
 * reaches the database is an opaque digest. The address itself exists
 * only for the lifetime of the request.
 *
 * -- WHY THIS MODULE IS PURE -----------------------------------
 * `now` is an argument, the state is passed in and the HMAC key is a
 * parameter, so none of the arithmetic reads a clock, an environment
 * variable, a socket or a database. The route owns the in-memory store;
 * the store module owns the round trip.
 */

export type RateLimitState = Map<string, { count: number; windowStartMs: number }>;

export type RateLimitDecision = {
  allowed: boolean;
  /** Seconds until the current window ends. For the Retry-After header. */
  retryAfterSeconds: number;
};

/**
 * Five signups per address-bucket per ten minutes. A real person needs
 * one, or two if the first mail went astray; five leaves room for a
 * shared office NAT without leaving the endpoint open.
 */
export const LAUNCH_RATE_LIMIT_MAX = 5;
export const LAUNCH_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;

/**
 * The same window, in the unit the database function takes. Derived
 * rather than written twice, so the two layers cannot drift apart.
 */
export const LAUNCH_RATE_LIMIT_WINDOW_SECONDS = LAUNCH_RATE_LIMIT_WINDOW_MS / 1000;

/** Stops the map from growing without bound if the key space is attacked. */
const MAX_TRACKED_KEYS = 10_000;

/**
 * Records one attempt against `key` and says whether it may proceed.
 *
 * Counts every attempt, including rejected ones: a caller hammering the
 * endpoint should not be able to reset its own window by being refused.
 */
export function consumeRateLimit(
  state: RateLimitState,
  key: string,
  nowMs: number,
  max: number = LAUNCH_RATE_LIMIT_MAX,
  windowMs: number = LAUNCH_RATE_LIMIT_WINDOW_MS
): RateLimitDecision {
  pruneExpired(state, nowMs, windowMs);

  const entry = state.get(key);

  if (!entry || nowMs - entry.windowStartMs >= windowMs) {
    if (!entry && state.size >= MAX_TRACKED_KEYS) {
      // Full and this key is new. Refusing is the safe direction: it
      // fails closed rather than silently switching the limit off under
      // exactly the load it exists for.
      return { allowed: false, retryAfterSeconds: Math.ceil(windowMs / 1000) };
    }
    state.set(key, { count: 1, windowStartMs: nowMs });
    return { allowed: true, retryAfterSeconds: 0 };
  }

  entry.count += 1;
  const elapsed = nowMs - entry.windowStartMs;
  const retryAfterSeconds = Math.max(1, Math.ceil((windowMs - elapsed) / 1000));

  if (entry.count > max) return { allowed: false, retryAfterSeconds };
  return { allowed: true, retryAfterSeconds: 0 };
}

/** Drops windows that have already closed. */
export function pruneExpired(
  state: RateLimitState,
  nowMs: number,
  windowMs: number = LAUNCH_RATE_LIMIT_WINDOW_MS
): void {
  for (const [key, entry] of state) {
    if (nowMs - entry.windowStartMs >= windowMs) state.delete(key);
  }
}

/**
 * The bucket key for a request.
 *
 * A client IP is only available here through a forwarding header, and a
 * public endpoint's headers are attacker-controlled - the same reason
 * lib/siteUrl.ts refuses to derive the site origin from them. So the
 * value is used ONLY as a rate-limit bucket, where a forged header buys
 * an attacker a fresh bucket and nothing else, and never as identity,
 * never in a decision about a row, and never stored.
 *
 * A request with no such header shares one bucket. That is intentional:
 * the alternative, letting an absent header mean "no limit", is the hole
 * this is meant to close.
 */
export function rateLimitKeyFromRequest(request: { headers: { get(name: string): string | null } }): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first.slice(0, 100);
  }
  const realIp = request.headers.get("x-real-ip");
  if (realIp) return realIp.trim().slice(0, 100);
  return "unknown";
}

/**
 * Domain separation for the HMAC below.
 *
 * The key this module is given also authenticates something else, so
 * the message is prefixed with a label that belongs to this use and no
 * other. Two different uses of one key then produce two unrelated
 * digests, and neither can be replayed as the other. Bump the version
 * if the meaning of the input ever changes; every bucket resets, which
 * for a ten-minute window costs nothing.
 */
const BUCKET_HMAC_LABEL = "gloa:launch-rate-limit:v1";

/**
 * TURNS A CLIENT ADDRESS INTO A BUCKET KEY THAT IS NOT AN ADDRESS.
 *
 * The persistent limiter needs a stable key, not an identity. An HMAC
 * gives exactly that: the same caller lands in the same bucket for as
 * long as the secret stands, and the value written to the database
 * cannot be turned back into an address by anyone who does not hold the
 * secret - including anyone holding a dump of the table.
 *
 * A plain hash would not do. The address space is small enough to
 * enumerate completely, so an unkeyed SHA-256 of an IPv4 address is
 * reversible by brute force in seconds and would be personal data in
 * everything but name. The secret is what makes the digest a
 * pseudonym.
 *
 * Returns 64 lowercase hex characters, which is the shape migration 043
 * pins with a CHECK constraint - so if this function is ever bypassed
 * and a raw address is passed through, the database refuses the row
 * instead of storing it.
 */
export function pseudonymizeBucketKey(rawKey: string, secret: string): string {
  return createHmac("sha256", secret).update(`${BUCKET_HMAC_LABEL}:${rawKey}`, "utf8").digest("hex");
}

/** The shape migration 043 accepts. Checked before the round trip. */
export function isBucketKey(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}
