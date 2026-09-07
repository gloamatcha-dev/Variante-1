/**
 * WHO MAY OPERATE THE LAUNCH SEND.
 *
 * These endpoints can mail the entire waiting list once, irreversibly.
 * That is the largest blast radius in this repository - larger than the
 * cron, which can only re-attempt work the shop already owed itself, and
 * larger than the fulfillment endpoint, which touches one order at a
 * time. So it gets its own secret and shares none.
 *
 * ── WHY NOT REUSE AN EXISTING SECRET ──────────────────────────
 *
 * lib/serverSecretAuth.ts already says it, and it is worth repeating
 * here because the temptation is real: a shared COMPARISON is safety, a
 * shared SECRET is the opposite. CRON_SECRET sits in Vercel's cron
 * configuration and is presented on a schedule by the platform;
 * FULFILLMENT_ADMIN_SECRET is handed to whoever ships parcels. Either
 * would make "mail the whole list" as reachable as the most widely
 * distributed copy of a value that was issued for something else.
 *
 * LAUNCH_ADMIN_SECRET is issued for this and nothing else, and if it
 * leaks the damage is bounded by what these three endpoints can do.
 *
 * ── IT FAILS CLOSED, AND AN UNSET SECRET IS NOT "OPEN" ────────
 *
 * An unconfigured secret must never mean "no authentication required".
 * That is how an endpoint that mails two thousand people ends up public
 * because an environment variable was forgotten in a new project. When
 * the secret is missing these endpoints refuse every request, and the
 * refusal names the absence in the log without ever naming the value.
 *
 * ── A LONG SECRET IS PART OF THE CONTRACT ─────────────────────
 *
 * The comparison below is timing safe, but timing safety does not help
 * against a short secret - a six-character value falls to a dictionary
 * whatever the comparison does. So a secret under the minimum length is
 * treated as MISCONFIGURED rather than merely weak: the endpoint refuses
 * to run at all, loudly, instead of running with a lock anybody can pick.
 *
 * Pure and leaf apart from the shared comparison helper: no database, no
 * network, no environment read of its own. The caller supplies the
 * secret, so this module cannot be the reason one is read from the wrong
 * place.
 */

import { isBearerSecretAuthorized } from "./serverSecretAuth.ts";

/**
 * Below this the secret is refused as misconfigured.
 *
 * 32 characters of a random alphabet is roughly 160 bits, which is far
 * past anything guessable and is what `openssl rand -hex 32` produces
 * anyway. The number exists to catch "changeme" and a stray test value,
 * not to grade entropy.
 */
export const LAUNCH_ADMIN_SECRET_MIN_LENGTH = 32;

export type AdminAuthOutcome =
  /** Authorized. */
  | { kind: "ok" }
  /** No secret configured, or one too short to be a secret. Refuse everything. */
  | { kind: "misconfigured"; reason: string }
  /** A caller presented the wrong secret, or none. */
  | { kind: "unauthorized" };

/**
 * Decides whether a request may operate the launch send.
 *
 * `secret` is the configured value; the request carries the presented
 * one as a Bearer token. Both are compared as fixed-length digests in
 * constant time by lib/serverSecretAuth.ts.
 */
export function authorizeLaunchAdmin(
  request: Request,
  secret: string | undefined | null
): AdminAuthOutcome {
  if (!secret) {
    return { kind: "misconfigured", reason: "LAUNCH_ADMIN_SECRET is not configured" };
  }
  if (secret.length < LAUNCH_ADMIN_SECRET_MIN_LENGTH) {
    return {
      kind: "misconfigured",
      reason: `LAUNCH_ADMIN_SECRET is shorter than ${LAUNCH_ADMIN_SECRET_MIN_LENGTH} characters`,
    };
  }
  return isBearerSecretAuthorized(request, secret) ? { kind: "ok" } : { kind: "unauthorized" };
}

/**
 * THE TYPED CONFIRMATION A DESTRUCTIVE ACTION HAS TO CARRY.
 *
 * Holding a valid secret is authorization, not intent. These two
 * actions - releasing the launch and starting the send - are the ones
 * nobody can undo, so each also requires the operator to type its exact
 * phrase into the request body.
 *
 * It is deliberately not a boolean. `{"confirm": true}` is what a
 * copy-pasted curl line from a runbook carries by accident, and what a
 * retried request replays without a second thought. A phrase naming the
 * specific action is something a person has to mean.
 */
/**
 * Admin attempts allowed per caller bucket per window.
 *
 * Deliberately tighter than the public signup's five: a legitimate
 * operator makes a handful of calls in a session, and there is no
 * shared-office NAT case to accommodate here.
 */
export const ADMIN_RATE_LIMIT_MAX = 10;

export const RELEASE_CONFIRMATION = "RELEASE GLOA LAUNCH";
export const SEND_CONFIRMATION = "SEND GLOA LAUNCH ANNOUNCEMENT";

export function hasConfirmation(body: unknown, expected: string): boolean {
  if (!body || typeof body !== "object") return false;
  const value = (body as { confirm?: unknown }).confirm;
  return typeof value === "string" && value === expected;
}
