import { getSupabaseAdmin } from "./supabaseAdmin";
import { getSiteOrigin } from "./siteUrl";
import { GLOA_FROM_HELLO } from "./emailSenders";
import { buildLaunchWelcomeEmail } from "./email/launchWelcome.ts";
import {
  LAUNCH_DISCOUNT_CODE,
  LAUNCH_DISCOUNT_PERCENT,
  LAUNCH_DISCOUNT_FROM_LABEL,
  LAUNCH_DISCOUNT_UNTIL_LABEL,
} from "./launchDiscount.ts";
import type { WelcomeSendDb, WelcomeSendMailer, WelcomeClaim } from "./launchWelcomeSend.ts";

/**
 * WIRING THE WELCOME MAIL TO THE REAL DATABASE AND PROVIDER.
 *
 * lib/launchWelcomeSend.ts owns the flow and stays testable because it
 * takes both as interfaces. This module is the one place they are
 * implemented, so the round trips have one shape and one failure policy.
 *
 * Every number and date the mail prints comes from lib/launchDiscount.ts,
 * so the message cannot promise a percentage or a validity window the
 * checkout does not honour.
 */

const CLAIM_FN = "claim_welcome_email";
const MARK_FN = "mark_welcome_email_sent";
const RELEASE_FN = "release_welcome_email_claim";

type Rpc = {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }>;
};

export function welcomeSendDb(client: Rpc): WelcomeSendDb {
  return {
    async claim(rowId, claimId): Promise<WelcomeClaim> {
      // The consent version is NOT passed. It is a literal inside
      // claim_welcome_email, so no caller can widen the gate by handing
      // it a different string - see the note in migration 045.
      const { data, error } = await client.rpc(CLAIM_FN, {
        p_id: rowId,
        p_claim_id: claimId,
      });
      // Thrown, not returned false: "the database could not be asked" is
      // a different thing from "you did not win the claim", and only the
      // first should read as unavailable. A missing migration 045 lands
      // here.
      if (error) throw new Error(error.message);

      const row = Array.isArray(data) ? data[0] : data;
      if (!row || typeof row !== "object") return { claimed: false };
      const r = row as { claimed?: unknown; email?: unknown; first_name?: unknown };
      if (r.claimed !== true || typeof r.email !== "string") return { claimed: false };
      return {
        claimed: true,
        email: r.email,
        firstName: typeof r.first_name === "string" ? r.first_name : null,
      };
    },

    async markSent(rowId, claimId) {
      const { data, error } = await client.rpc(MARK_FN, { p_id: rowId, p_claim_id: claimId });
      if (error) throw new Error(error.message);
      return data === true;
    },

    async release(rowId, claimId, reason, needsReview) {
      const { data, error } = await client.rpc(RELEASE_FN, {
        p_id: rowId,
        p_claim_id: claimId,
        p_reason: reason,
        p_needs_review: needsReview,
      });
      if (error) throw new Error(error.message);
      return data === true;
    },
  };
}

/** The narrow HTTP surface, injected so a test can supply it. */
export type Fetcher = (url: string, init: {
  method: string;
  headers: Record<string, string>;
  body: string;
}) => Promise<{ status: number; json(): Promise<unknown> }>;

export const RESEND_SEND_URL = "https://api.resend.com/emails";

/**
 * The provider half. Same 409/5xx mapping as the launch send - see
 * lib/launchSendMailer.ts for why 5xx is treated as unknown rather than
 * as a plain failure.
 */
export function welcomeSendMailer(apiKey: string, origin: string, fetcher: Fetcher): WelcomeSendMailer {
  return {
    async send(recipient, key) {
      const { subject, html, text } = buildLaunchWelcomeEmail({
        firstName: recipient.firstName,
        origin,
        code: LAUNCH_DISCOUNT_CODE,
        percentLabel: `${LAUNCH_DISCOUNT_PERCENT} %`,
        validFromLabel: LAUNCH_DISCOUNT_FROM_LABEL,
        validUntilLabel: LAUNCH_DISCOUNT_UNTIL_LABEL,
      });

      const response = await fetcher(RESEND_SEND_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": key,
        },
        body: JSON.stringify({
          from: GLOA_FROM_HELLO,
          to: recipient.email,
          subject,
          html,
          text,
        }),
      });

      if (response.status >= 200 && response.status < 300) return { ok: true };

      let name = "";
      try {
        const body = (await response.json()) as { name?: unknown };
        name = typeof body?.name === "string" ? body.name : "";
      } catch {
        name = "";
      }

      if (response.status === 409) {
        if (name === "concurrent_idempotent_requests") {
          return { ok: false, unclear: true, reason: "provider reports the same key already in flight" };
        }
        return { ok: false, reason: `provider rejected the idempotent request (${name || "409"})` };
      }
      if (response.status >= 500) {
        return { ok: false, unclear: true, reason: `provider error ${response.status}` };
      }
      // Never the provider's message body - it echoes the address.
      return { ok: false, reason: `provider refused with ${response.status}${name ? ` (${name})` : ""}` };
    },
  };
}

export type WelcomeWiring =
  | { ok: true; db: WelcomeSendDb; mailer: WelcomeSendMailer }
  | { ok: false; reason: string };

/**
 * Builds the wiring, or explains why it cannot.
 *
 * A caller that gets `ok: false` must still succeed at whatever it was
 * doing - the welcome mail is never allowed to fail a confirmation.
 */
export function buildWelcomeWiring(fetcher: Fetcher = defaultFetcher): WelcomeWiring {
  const supabase = getSupabaseAdmin();
  const origin = getSiteOrigin();
  const apiKey = process.env.RESEND_API_KEY;

  if (!supabase) return { ok: false, reason: "supabase admin client is not configured" };
  if (!origin) return { ok: false, reason: "SITE_URL is not configured" };
  if (!apiKey) return { ok: false, reason: "RESEND_API_KEY is not configured" };

  return {
    ok: true,
    db: welcomeSendDb(supabase as unknown as Rpc),
    mailer: welcomeSendMailer(apiKey, origin, fetcher),
  };
}

const defaultFetcher: Fetcher = async (url, init) => {
  const res = await fetch(url, init);
  return { status: res.status, json: () => res.json() };
};
