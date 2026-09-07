import { getSupabaseAdmin } from "./supabaseAdmin";
import { getSiteOrigin } from "./siteUrl";
import { launchSendMailer, type Fetcher } from "./launchSendMailer.ts";
import type { LaunchSendDb, LaunchSendMailer } from "./launchSend.ts";

/**
 * WIRING THE LAUNCH SEND TO THE REAL DATABASE AND THE REAL PROVIDER.
 *
 * lib/launchSend.ts holds the loop and stays testable because it takes
 * both as narrow interfaces. This module is the one place those
 * interfaces are implemented against Supabase and Resend, so the round
 * trips have exactly one shape and one failure policy - the same split
 * lib/launchRateLimitStore.ts uses for its single RPC.
 *
 * Nothing here decides who may be mailed. Every such decision lives in
 * migration 044's claim function, under a row lock.
 */

/** The three RPCs migration 044 exposes. */
const CLAIM_FN = "claim_launch_notifications";
const MARK_FN = "mark_launch_notification_sent";
const RELEASE_FN = "release_launch_notification_claim";
const REVIEW_FN = "flag_launch_notification_for_review";

type Rpc = {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }>;
};

/**
 * The database half.
 *
 * Every call throws on failure rather than returning a falsy value,
 * because the loop distinguishes "the database said no" (a legitimate
 * false, e.g. the claim had expired) from "the database could not be
 * reached" - and only the second is a reason to stop the run.
 */
export function launchSendDb(client: Rpc): LaunchSendDb {
  return {
    async claim(claimId, limit) {
      const { data, error } = await client.rpc(CLAIM_FN, {
        p_claim_id: claimId,
        p_limit: limit,
      });
      if (error) throw new Error(error.message);
      if (!Array.isArray(data)) return [];
      return data
        .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object")
        .map((row) => ({
          id: String(row.id),
          email: String(row.email),
          first_name: typeof row.first_name === "string" ? row.first_name : null,
          attempts: Number(row.attempts) || 0,
        }));
    },

    async markSent(id, claimId) {
      const { data, error } = await client.rpc(MARK_FN, { p_id: id, p_claim_id: claimId });
      if (error) throw new Error(error.message);
      return data === true;
    },

    async releaseClaim(id, claimId, reason) {
      const { data, error } = await client.rpc(RELEASE_FN, {
        p_id: id,
        p_claim_id: claimId,
        p_reason: reason,
      });
      if (error) throw new Error(error.message);
      return data === true;
    },

    async flagForReview(id, claimId, reason) {
      const { data, error } = await client.rpc(REVIEW_FN, {
        p_id: id,
        p_claim_id: claimId,
        p_reason: reason,
      });
      if (error) throw new Error(error.message);
      return data === true;
    },
  };
}

// Re-exported so the route has one import, and the suite can still load
// the mailer directly as a leaf.
export { RESEND_SEND_URL } from "./launchSendMailer.ts";
export { launchSendMailer, type Fetcher };

/** Everything the send endpoint needs, or a reason it cannot run. */
export type LaunchSendWiring =
  | { ok: true; db: LaunchSendDb; mailer: LaunchSendMailer }
  | { ok: false; reason: string };

/**
 * Builds the wiring from the environment.
 *
 * Refuses rather than half-configures: a send that started without a
 * site origin would mail a working button pointing nowhere, and one
 * without the provider key would burn every claim on a failure.
 */
export function buildLaunchSendWiring(fetcher: Fetcher = defaultFetcher): LaunchSendWiring {
  const supabase = getSupabaseAdmin();
  const origin = getSiteOrigin();
  const apiKey = process.env.RESEND_API_KEY;

  if (!supabase) return { ok: false, reason: "supabase admin client is not configured" };
  if (!origin) return { ok: false, reason: "SITE_URL is not configured" };
  if (!apiKey) return { ok: false, reason: "RESEND_API_KEY is not configured" };

  return {
    ok: true,
    db: launchSendDb(supabase as unknown as Rpc),
    mailer: launchSendMailer(apiKey, origin, fetcher),
  };
}

const defaultFetcher: Fetcher = async (url, init) => {
  const res = await fetch(url, init);
  return { status: res.status, json: () => res.json() };
};
