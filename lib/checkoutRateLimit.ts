import {
  consumeRateLimit,
  pseudonymizeBucketKey,
  rateLimitKeyFromRequest,
  type RateLimitState,
} from "./launchRateLimit.ts";
import {
  consumePersistentRateLimit,
  type RateLimitRpcClient,
} from "./launchRateLimitStore.ts";

/**
 * THE RATE LIMIT FOR THE TWO CHECKOUT ENDPOINTS.
 *
 * Both are public, unauthenticated and free to call, and until now
 * neither counted anything. The contact form, the B2B lead form and the
 * waitlist all had a limit; the two endpoints that read the catalog and
 * create Stripe Customers did not.
 *
 * ── WHAT ABUSE ACTUALLY COSTS, PER ENDPOINT ───────────────────
 *
 *   /api/checkout/quote    reads the catalog from Supabase and prices a
 *                          discount code. Writes nothing, creates
 *                          nothing, needs no identity. The cost of
 *                          abuse is read volume - and, since the
 *                          reusable code turned this into something
 *                          that will answer "is this code worth
 *                          anything", an unmetered oracle for guessing
 *                          codes.
 *
 *   /api/checkout/session  resolves an identity, can create a Stripe
 *                          CUSTOMER, writes a checkout attempt and
 *                          hands back a payable page. The cost of abuse
 *                          is durable objects in someone else's system.
 *
 * Two costs, two policies. They are separated below rather than averaged
 * into one number that would be too tight for the cheap endpoint and too
 * loose for the expensive one.
 *
 * ── THE SAME TWO LAYERS THE WAITLIST USES ─────────────────────
 *
 * Layer 1 is the in-process counter in lib/launchRateLimit.ts: free, no
 * round trip, absorbs a flood arriving at one instance, and worth
 * exactly as much as an instance's lifetime - which on a serverless
 * platform is short. Layer 2 is the shared counter in Postgres
 * (lib/launchRateLimitStore.ts, migration 043), which every instance
 * sees and which one atomic statement increments. Layer 2 is the one
 * that actually holds.
 *
 * NO SECOND RATE-LIMIT SYSTEM. Same primitives, same table, same
 * function, same digest shape. What is new here is only the policy: two
 * sets of numbers and a rule for what to do when the shared counter
 * cannot be reached.
 *
 * ── WHY THE TWO LAYERS ARE TWO FUNCTIONS ──────────────────────
 *
 * Because they are spent at different points in a request, and each
 * must be spent exactly once.
 *
 * Layer 1 belongs at the very top, before the body is even read, so a
 * caller posting rubbish in a loop is counted like any other. Layer 2
 * belongs lower, next to the expensive thing it guards, so a malformed
 * request is still answered accurately without a database round trip.
 * A single function doing both would either have to be called twice -
 * charging every request two slots against the in-process counter - or
 * be called once and give up one of those two properties.
 *
 * ── SEPARATE BUCKETS, ON PURPOSE ──────────────────────────────
 *
 * Each policy carries its own HMAC label, so the waitlist, the quote and
 * the session occupy three unrelated rows for the same caller. A
 * customer who confirmed their signup this morning must not arrive at
 * the checkout with a partly-spent budget, and somebody trying codes
 * against the quote endpoint must not be able to close the session
 * endpoint as a side effect.
 *
 * ── NO ADDRESS IS EVER STORED ─────────────────────────────────
 *
 * The bucket key is an HMAC of whatever the forwarding header claimed,
 * taken with a server-side secret. What reaches the database is 64 hex
 * characters that cannot be turned back into an address by anyone
 * without the secret - the same guarantee migration 043 pins with a
 * CHECK constraint. NO EMAIL IS INVOLVED at any point: the session
 * endpoint has the customer's address in hand by the time it gets here
 * and deliberately does not bucket on it, because a per-address limit
 * would be a record of who tried to buy what and when.
 *
 * ── PURE ──────────────────────────────────────────────────────
 *
 * `nowMs`, the in-memory map, the database client and the secret are all
 * arguments. Nothing here reads a clock, a socket or a Response, and the
 * only environment read is the secret getter at the bottom, which is
 * called by the routes rather than by the logic above it. The routes own
 * their maps - one each, so the two endpoints cannot share a counter by
 * accident - and turn the decisions below into HTTP answers.
 */

/** What to do when the shared counter cannot be consulted at all. */
export type UnavailablePolicy =
  /**
   * Let the request through. Correct only where being wrong costs a
   * read: refusing would turn a database blip into a broken cart.
   */
  | "allow"
  /**
   * Refuse with a neutral 503. Correct where being wrong creates
   * something durable in Stripe or in the database.
   */
  | "refuse";

export type CheckoutRateLimitPolicy = {
  /** Domain separation for the bucket digest. One per endpoint. */
  readonly label: string;
  readonly max: number;
  readonly windowMs: number;
  /** The same window in the unit the database function takes. */
  readonly windowSeconds: number;
  readonly unavailable: UnavailablePolicy;
};

function policy(
  label: string,
  max: number,
  windowMs: number,
  unavailable: UnavailablePolicy
): CheckoutRateLimitPolicy {
  return Object.freeze({ label, max, windowMs, windowSeconds: windowMs / 1000, unavailable });
}

export const CHECKOUT_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;

/**
 * THE QUOTE. Thirty in ten minutes, and a database blip lets a request
 * through.
 *
 * A real customer reaches this endpoint by typing a discount code and
 * pressing Einlösen - it is the ONLY caller of requestCheckoutQuote, so
 * the cart, the country selector and the quantity steppers never touch
 * it. One or two calls is a normal visit; thirty is somebody scripting.
 * The ceiling is set well above a person and well below a useful
 * guessing rate.
 *
 * `allow` on unavailable, deliberately. This endpoint writes nothing and
 * charges nobody, so the worst a missed limit costs is catalog reads -
 * while refusing would mean a customer with a valid code is told their
 * cart is broken because a counter could not be reached. Layer 1 still
 * applies in that case, so "unavailable" is a weaker limit, not none.
 */
export const CHECKOUT_QUOTE_RATE_LIMIT = policy(
  "gloa:checkout-quote-rate-limit:v1",
  30,
  CHECKOUT_RATE_LIMIT_WINDOW_MS,
  "allow"
);

/**
 * THE SESSION. Fifteen in ten minutes, and a database blip refuses.
 *
 * Fifteen is generous for a person: a checkout is one call, a retry
 * after a failed Stripe response is another, and a shared office NAT
 * puts several customers in one bucket. It is not generous for a script,
 * which is the point.
 *
 * `refuse` on unavailable, for the reason POST /api/launch gives at
 * length: on a serverless deployment layer 1 alone is not a weaker limit
 * but an effectively absent one, because sustained load is exactly what
 * makes the platform hand out fresh instances with empty counters. The
 * failure this guards against is durable objects in Stripe created at
 * whatever rate the platform will scale to. A refused checkout is
 * recoverable; a Stripe Customer list filled by a script is not.
 */
export const CHECKOUT_SESSION_RATE_LIMIT = policy(
  "gloa:checkout-session-rate-limit:v1",
  15,
  CHECKOUT_RATE_LIMIT_WINDOW_MS,
  "refuse"
);

/**
 * What the route must do. Deliberately not a Response: this module has
 * no business knowing about HTTP bodies, and a decision is far easier to
 * assert on than a rendered Response.
 */
export type CheckoutRateLimitDecision =
  | { allow: true }
  /** Over the limit. 429, with a Retry-After the caller can honour. */
  | { allow: false; status: 429; retryAfterSeconds: number; reason: string }
  /** The shared counter could not be consulted and the policy refuses. */
  | { allow: false; status: 503; retryAfterSeconds: null; reason: string };

/** The one thing a caller needs from a Request. Narrow, so a test can supply it. */
export type RateLimitRequestLike = { headers: { get(name: string): string | null } };

/**
 * LAYER 1. Spends one attempt against the route's in-process counter.
 *
 * Synchronous and free, so it belongs at the very top of a handler -
 * before the body is read, before anything is validated. It counts every
 * request that reaches the endpoint, valid or not: a caller hammering it
 * must not be able to reset its own window by sending rubbish.
 *
 * It NEVER refuses for any reason other than the count. There is nothing
 * here that can be unavailable.
 */
export function consumeLocalCheckoutRateLimit(input: {
  policy: CheckoutRateLimitPolicy;
  /** The route's own in-process map. One per endpoint. */
  state: RateLimitState;
  request: RateLimitRequestLike;
  nowMs: number;
}): CheckoutRateLimitDecision {
  const local = consumeRateLimit(
    input.state,
    rateLimitKeyFromRequest(input.request),
    input.nowMs,
    input.policy.max,
    input.policy.windowMs
  );
  if (local.allowed) return { allow: true };
  return {
    allow: false,
    status: 429,
    retryAfterSeconds: local.retryAfterSeconds,
    reason: "in-process rate limit exceeded",
  };
}

/**
 * LAYER 2. Spends one attempt against the shared counter in Postgres.
 *
 * This is the limit that actually holds on a serverless deployment, so
 * it belongs immediately above the expensive thing it guards rather than
 * at the top of the handler: a request that is about to be refused as
 * malformed should not cost a database round trip.
 *
 * The raw address exists only inside this function. What travels is the
 * digest and nothing else.
 */
export async function consumeSharedCheckoutRateLimit(input: {
  policy: CheckoutRateLimitPolicy;
  request: RateLimitRequestLike;
  /**
   * A service-role Supabase client, or null when one is not configured.
   * Null is treated exactly like a failed round trip - the shared
   * counter cannot be consulted either way.
   */
  client: RateLimitRpcClient | null;
  /** The HMAC secret, or null when none is configured. Same treatment. */
  secret: string | null;
}): Promise<CheckoutRateLimitDecision> {
  const { policy: p, request, client, secret } = input;

  if (!secret || !client) {
    return unavailable(p, secret ? "no service-role client configured" : "no bucket secret configured");
  }

  const bucketKey = pseudonymizeBucketKey(rateLimitKeyFromRequest(request), secret, p.label);
  const shared = await consumePersistentRateLimit(client, bucketKey, p.max, p.windowSeconds);

  if (shared.kind === "limited") {
    return {
      allow: false,
      status: 429,
      retryAfterSeconds: shared.retryAfterSeconds,
      reason: "shared rate limit exceeded",
    };
  }
  if (shared.kind === "unavailable") return unavailable(p, shared.reason);

  return { allow: true };
}

function unavailable(p: CheckoutRateLimitPolicy, reason: string): CheckoutRateLimitDecision {
  if (p.unavailable === "allow") return { allow: true };
  return { allow: false, status: 503, retryAfterSeconds: null, reason };
}

/**
 * The secret the digest is taken with.
 *
 * Exactly what POST /api/launch uses, read here rather than imported so
 * the route files do not have to. Falling back to the Supabase secret
 * means the limiter works on a deployment that never set a dedicated
 * one; both are server-only and neither is ever sent anywhere.
 */
export function getCheckoutBucketSecret(): string | null {
  return process.env.LAUNCH_RATE_LIMIT_SECRET || process.env.SUPABASE_SECRET_KEY || null;
}

/** The one sentence a refused caller ever sees. Says nothing about limits, buckets or counts. */
export const CHECKOUT_RATE_LIMITED_MESSAGE =
  "Zu viele Anfragen. Bitte versuch es gleich noch einmal.";
