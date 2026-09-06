/**
 * A SMALL, HONEST RATE LIMIT FOR THE LAUNCH SIGNUP.
 *
 * The signup endpoint is public, unauthenticated and sends mail on
 * success. That combination is worth abusing twice over: to fill the
 * list with addresses nobody typed, and to use GLOA's sending domain to
 * post confirmation mail at somebody else's inbox. The honeypot the
 * contact form already uses catches indiscriminate form-fillers; it does
 * nothing against a script that posts a valid body in a loop.
 *
 * -- WHAT THIS IS, PRECISELY -----------------------------------
 * A fixed-window counter held in the server process's memory. It is
 * deliberately NOT presented as more than that:
 *
 *   - It is per instance. A deployment that runs several instances
 *     limits per instance, not globally.
 *   - It is lost on restart.
 *   - It is not a defence against a large distributed source.
 *
 * It is a speed bump that costs nothing to run, and it is the honest
 * ceiling of what can be done without introducing Redis, Turnstile or a
 * second datastore into a repository that has none of them. Introducing
 * one for a single form would be a bigger, riskier change than the form
 * itself. If GLOA later adds shared infrastructure, this module is the
 * one place that has to change.
 *
 * -- WHY IT IS PURE --------------------------------------------
 * `now` is an argument and the state is passed in, so the window
 * arithmetic can be tested with explicit instants instead of sleeps. The
 * route owns the single shared store.
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
