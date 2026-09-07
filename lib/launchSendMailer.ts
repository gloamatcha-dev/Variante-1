import { GLOA_FROM_HELLO } from "./emailSenders.ts";
import { buildLaunchDayEmail } from "./email/launchDay.ts";
import type { ClaimedRecipient, LaunchSendMailer, SendAttempt } from "./launchSend.ts";

/**
 * THE PROVIDER HALF OF THE LAUNCH SEND.
 *
 * Split out of lib/launchSendDeps.ts so it stays a LEAF: its only
 * imports are the sender constants, the template and a type. That is
 * what lets the suite drive the real 409 and 5xx mappings with a fake
 * fetcher, without a Supabase client, an environment or a socket - the
 * same reason lib/launchRateLimitStore.ts is separate from the route.
 *
 * lib/launchSendDeps.ts builds the environment-dependent half and
 * re-exports what the route needs.
 */

/** The narrow HTTP surface the mailer needs. Injected, so a test can supply it. */
export type Fetcher = (url: string, init: {
  method: string;
  headers: Record<string, string>;
  body: string;
}) => Promise<{ status: number; json(): Promise<unknown> }>;

export const RESEND_SEND_URL = "https://api.resend.com/emails";

/**
 * THE PROVIDER HALF, AND THE ONE PLACE THE IDEMPOTENCY CONTRACT IS READ.
 *
 * Resend's documented behaviour, which this maps onto the loop's three
 * outcomes:
 *
 *   2xx                            accepted            → ok
 *   409 concurrent_idempotent_...  a request with this key is IN FLIGHT.
 *                                  Somebody else may already be
 *                                  delivering it                → unclear
 *   409 invalid_idempotent_request the key was used with a DIFFERENT
 *                                  payload. That is a bug in the caller,
 *                                  not a transient fault, and repeating
 *                                  it will never succeed          → failed
 *   4xx other                      refused for a reason that will not
 *                                  change on its own              → failed
 *   5xx                            the provider broke AFTER accepting
 *                                  the request. It may or may not have
 *                                  queued the message             → unclear
 *
 * The 5xx mapping is the conservative one on purpose. Treating it as a
 * plain failure would send it again, and a provider that failed halfway
 * through queueing has quite possibly already queued it.
 *
 * WHAT IS SENT. The recipient's address, the rendered mail, and the
 * idempotency key. No metadata, no tags, no tracking parameters - the
 * consent covers a message, not an analytics record.
 */
export function launchSendMailer(
  apiKey: string,
  origin: string,
  fetcher: Fetcher
): LaunchSendMailer {
  return {
    async send(recipient: ClaimedRecipient, key: string): Promise<SendAttempt> {
      const { subject, html, text } = buildLaunchDayEmail({
        firstName: recipient.first_name,
        origin,
      });

      const response = await fetcher(RESEND_SEND_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          // Documented maximum is 256 characters; ours is ~64.
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
        const body = (await response.json()) as { name?: unknown; message?: unknown };
        name = typeof body?.name === "string" ? body.name : "";
      } catch {
        name = "";
      }

      if (response.status === 409) {
        if (name === "concurrent_idempotent_requests") {
          return { ok: false, unclear: true, reason: "provider reports the same key already in flight" };
        }
        // invalid_idempotent_request, or any other 409: the key was
        // reused with a different payload. Repeating cannot fix it.
        return { ok: false, reason: `provider rejected the idempotent request (${name || "409"})` };
      }

      if (response.status >= 500) {
        return { ok: false, unclear: true, reason: `provider error ${response.status}` };
      }

      // NEVER the provider's message body - it echoes the recipient
      // address on several error paths.
      return { ok: false, reason: `provider refused with ${response.status}${name ? ` (${name})` : ""}` };
    },
  };
}
