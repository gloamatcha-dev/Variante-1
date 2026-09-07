import { getSupabaseAdmin } from "../../../../../lib/supabaseAdmin";
import { guardLaunchAdmin } from "../../../../../lib/launchAdminRoute.ts";
import { GLOA_LAUNCH_ISO, GLOA_LAUNCH_MS } from "../../../../../lib/launchCountdown";
import { SHOP_STATUS } from "../../../../content";
import {
  launchSendBlockers,
  readLaunchStatus,
  type LaunchStatusClient,
  type WaitlistFilter,
} from "../../../../../lib/launchStatus.ts";

/**
 * THE DRY RUN. It reads, and that is all it does.
 *
 * No row is claimed, no status changes, nothing is marked notified and
 * no mail is sent by looking at this. That is worth stating in the file
 * rather than only in a comment on the function, because this is the
 * endpoint an operator will call repeatedly on 1 October while deciding
 * - and it has to be free to call.
 *
 * POST rather than GET even though it only reads. A GET would be
 * cached by intermediaries, restored by a browser and prefetched by
 * whatever renders the URL in a chat window; none of that should be
 * carrying an admin Bearer token around. Its sibling routes are POST
 * for a stronger reason, and one shape for all three is one thing less
 * to get wrong.
 *
 * WHAT IT ANSWERS WITH: integers and booleans. No address, no name, no
 * id, no sample of the list. See lib/launchStatus.ts.
 */

/**
 * The counting queries.
 *
 * `head: true` with an exact count, so Postgres returns the number and
 * NOT the rows - no address is read into this process to produce any of
 * these figures.
 */
function statusClient(supabase: NonNullable<ReturnType<typeof getSupabaseAdmin>>): LaunchStatusClient {
  return {
    async countWaitlist(filter: WaitlistFilter): Promise<number> {
      let query = supabase.from("launch_waitlist").select("id", { count: "exact", head: true });

      switch (filter) {
        case "confirmedUnsent":
          query = query
            .eq("status", "confirmed")
            .is("launch_notification_sent_at", null)
            .is("withdrawn_at", null)
            .is("launch_send_needs_review", false);
          break;
        case "pending":
          query = query.eq("status", "pending");
          break;
        case "withdrawn":
          query = query.eq("status", "withdrawn");
          break;
        case "notified":
          query = query.eq("status", "notified");
          break;
        case "openClaims":
          query = query.not("launch_send_claim_id", "is", null);
          break;
        case "needsReview":
          query = query.is("launch_send_needs_review", true);
          break;
      }

      const { count, error } = await query;
      if (error) throw new Error(error.message);
      return typeof count === "number" ? count : 0;
    },

    async readRelease() {
      const { data, error } = await supabase
        .from("launch_release")
        .select("released, released_at")
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) return null;
      return {
        released: (data as { released?: unknown }).released === true,
        released_at: ((data as { released_at?: unknown }).released_at as string | null) ?? null,
      };
    },
  };
}

export async function POST(request: Request): Promise<Response> {
  const gate = await guardLaunchAdmin(request);
  if (!gate.ok) return gate.response;

  const supabase = getSupabaseAdmin();
  if (!supabase) return Response.json({ error: "Nicht verfügbar." }, { status: 503 });

  const status = await readLaunchStatus(statusClient(supabase), {
    nowMs: Date.now(),
    plannedLaunchIso: GLOA_LAUNCH_ISO,
    plannedLaunchMs: GLOA_LAUNCH_MS,
    shopStatus: SHOP_STATUS,
  });

  return Response.json(
    {
      ...status,
      // Derived here so an operator does not have to work it out from
      // the flags, and phrased as blockers so "not ready" comes with a
      // reason. An empty array means a send would proceed.
      blockers: launchSendBlockers(status),
    },
    { status: 200 }
  );
}
