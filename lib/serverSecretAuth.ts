import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Timing-safe Bearer-secret authorization for server-only endpoints.
 *
 * Extracted verbatim from app/api/cron/retry-order-notifications/route.ts,
 * which had carried the only copy. The audit for the authorized shipment
 * transition asked whether a reusable helper existed; it did not, and a
 * second private copy of a comparison this security-sensitive is exactly
 * how the two drift apart. Both callers now share this one.
 *
 * WHAT THIS IS NOT. It is not customer authentication. lib/verifyUser.ts
 * verifies a Supabase Auth bearer token and tells you WHICH CUSTOMER is
 * calling; that is a different question with a different answer, and a
 * customer being signed in is never authorization to operate the shop.
 * The two must never be confused, so they deliberately live in different
 * modules with different names and share no code.
 *
 * Each endpoint keeps its OWN secret. A shared comparison is safety; a
 * shared secret would be the opposite, because it would make every
 * endpoint as reachable as the most widely distributed copy of one value.
 *
 * Pure and leaf apart from node:crypto: no relative imports, no database,
 * no network, no environment read. The caller supplies the secret, so
 * this module cannot itself be the reason a secret is read from the wrong
 * place, and it is directly unit-testable.
 */

/**
 * Fixed-length digests so the comparison is timing safe for any input
 * length.
 *
 * timingSafeEqual throws on differing lengths, which would turn a length
 * mismatch into an observable difference all by itself - an attacker
 * could learn the secret's length from which requests error rather than
 * return false. Hashing first removes that channel: every input becomes
 * 32 bytes before it is compared.
 */
function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * Whether the request carries exactly `Bearer <secret>`.
 *
 * FAILS CLOSED ON AN EMPTY SECRET. A caller that passes "" - which is
 * what an unset environment variable becomes if someone reaches for
 * `process.env.X ?? ""` - gets false for every request, including a
 * request that also sends "Bearer ". An unset secret must never mean "no
 * authentication required"; callers should still check for the missing
 * variable themselves and answer 503, but this refuses to be the reason
 * an endpoint silently became public.
 *
 * The early return is on the PRESENCE of the header, never on its
 * content, so nothing about the expected value leaks from how quickly
 * this returns.
 *
 * Neither the header nor the secret is logged, returned, or included in
 * any error - this function's entire output is one boolean.
 */
export function isBearerSecretAuthorized(request: Request, secret: string): boolean {
  if (!secret) return false;
  const header = request.headers.get("authorization");
  if (!header) return false;
  return timingSafeEqual(digest(header), digest(`Bearer ${secret}`));
}
