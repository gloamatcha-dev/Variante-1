/**
 * THE PERSISTENT HALF OF THE LAUNCH RATE LIMIT.
 *
 * lib/launchRateLimit.ts holds the arithmetic and stays pure. This
 * module is the one place that talks to the database about it, so the
 * round trip has exactly one shape and one failure policy.
 *
 * The counter lives in public.launch_rate_limit and is spent through
 * public.consume_launch_rate_limit (section 5 of migration 043). The decision is
 * taken inside a single INSERT ... ON CONFLICT DO UPDATE rather than by
 * reading a row and writing it back, because two serverless instances
 * racing through the gap between a read and a write is the exact
 * situation a shared counter exists to fix.
 *
 * -- WHAT TRAVELS ----------------------------------------------
 * A 64-character hex digest, a maximum and a window length. No address,
 * no email, no name, no identifier of any kind. The digest is produced
 * by pseudonymizeBucketKey and is checked here before it is sent, so a
 * raw address cannot reach the database even if a caller gets the
 * order of operations wrong.
 *
 * -- WHAT HAPPENS WHEN THE DATABASE CANNOT ANSWER --------------
 * The call reports `unavailable` rather than throwing or guessing.
 *
 * That is a deliberate choice and it deserves its reason in writing:
 * failing CLOSED here would mean a database hiccup, or a deployment
 * that has not run 043 yet, takes the signup form off the site
 * entirely. Failing OPEN is acceptable only because it is not actually
 * open - the in-process limiter in the route still applies to every
 * request, so the endpoint degrades from "limited globally" to
 * "limited per instance", which is precisely where it stood before this
 * module existed. The route logs the degradation.
 */

/** The Supabase surface this module uses. Narrow, so a test can supply it. */
export type RateLimitRpcClient = {
  rpc(
    fn: string,
    args: Record<string, unknown>
  ): PromiseLike<{ data: unknown; error: { message: string } | null }>;
};

export type PersistentRateLimitOutcome =
  | { kind: "allowed" }
  | { kind: "limited"; retryAfterSeconds: number }
  /** The shared counter could not be consulted. The caller must say so. */
  | { kind: "unavailable"; reason: string };

export const CONSUME_RATE_LIMIT_FN = "consume_launch_rate_limit";

/**
 * The digest shape, written out here rather than imported from
 * lib/launchRateLimit.ts.
 *
 * This module has to stay a leaf with no runtime imports so the test
 * suite can load it directly - the same reason lib/annualPlanCheckoutRules.ts
 * refers to its neighbours with `import type` only. The three places
 * that state this pattern (there, here, and the CHECK constraint in
 * migration 043) are asserted to agree by
 * tests/launch-waitlist.test.mjs, so the repetition is checked rather
 * than trusted.
 */
const BUCKET_KEY_PATTERN = /^[0-9a-f]{64}$/;

function isBucketKey(value: unknown): value is string {
  return typeof value === "string" && BUCKET_KEY_PATTERN.test(value);
}

/**
 * Spends one attempt against the shared counter.
 *
 * `bucketKey` MUST already be pseudonymized - see
 * pseudonymizeBucketKey. Anything else is refused here rather than
 * sent.
 */
export async function consumePersistentRateLimit(
  client: RateLimitRpcClient,
  bucketKey: string,
  max: number,
  windowSeconds: number
): Promise<PersistentRateLimitOutcome> {
  // Belt and braces with the CHECK constraint in 044: a value that is
  // not a digest is never put on the wire, so a mistake upstream cannot
  // turn into a raw address in a database log line.
  if (!isBucketKey(bucketKey)) {
    return { kind: "unavailable", reason: "bucket key was not a digest" };
  }

  let result: { data: unknown; error: { message: string } | null };
  try {
    result = await client.rpc(CONSUME_RATE_LIMIT_FN, {
      p_bucket_key: bucketKey,
      p_max: max,
      p_window_seconds: windowSeconds,
    });
  } catch (err) {
    return { kind: "unavailable", reason: err instanceof Error ? err.message : "rpc threw" };
  }

  if (result.error) return { kind: "unavailable", reason: result.error.message };

  // `returns table (...)` comes back as an array of rows through
  // PostgREST. Accept a bare object too rather than depending on that.
  const row = Array.isArray(result.data) ? result.data[0] : result.data;
  if (!row || typeof row !== "object") {
    return { kind: "unavailable", reason: "rate limit function returned no row" };
  }

  const { allowed, retry_after_seconds: retryAfter } = row as {
    allowed?: unknown;
    retry_after_seconds?: unknown;
  };

  if (allowed === true) return { kind: "allowed" };

  if (allowed === false) {
    const seconds = Number(retryAfter);
    return {
      kind: "limited",
      // A refusal without a usable Retry-After still has to produce a
      // header, so fall back to the full window rather than to zero -
      // "try again immediately" is the one answer a limit must not give.
      retryAfterSeconds: Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : windowSeconds,
    };
  }

  return { kind: "unavailable", reason: "rate limit function returned no verdict" };
}
