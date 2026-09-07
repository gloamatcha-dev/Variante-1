import { getSupabaseAdmin } from "../../../../../lib/supabaseAdmin";
import { guardLaunchAdmin, readAdminBody } from "../../../../../lib/launchAdminRoute.ts";
import { RELEASE_CONFIRMATION, hasConfirmation } from "../../../../../lib/launchAdminAuth.ts";
import { SHOP_STATUS } from "../../../../content";

/**
 * RELEASING THE LAUNCH - the human act migration 044 waits for.
 *
 * This endpoint writes one boolean. Everything else about the send flows
 * from it: until `released` is true the claim function in 044 hands back
 * no rows at all, whatever anybody calls.
 *
 * ── WHAT IT REFUSES TO DO ─────────────────────────────────────
 *
 * IT DOES NOT SEND. Releasing and sending are two requests to two
 * endpoints on purpose. One decision - "the shop works, we are going" -
 * should not also be the irreversible act of mailing two thousand
 * people; an operator must be able to release, look at the dry run
 * again, and only then start.
 *
 * IT DOES NOT RELEASE ON A SCHEDULE. There is no timer here, no date
 * check that flips it, and no cron that calls it. Reaching noon on
 * 1 October changes nothing.
 *
 * ── THE SHOP HAS TO BE LIVE FIRST ─────────────────────────────
 *
 * Refused unless SHOP_STATUS is "live". The whole point of the
 * announcement is that the shop is open; releasing it while the site
 * still routes the cart to /contact would mail everybody an invitation
 * to a door that is shut. This is the one ordering constraint the code
 * enforces rather than trusting a runbook.
 *
 * A release can be TAKEN BACK by posting released:false. That does not
 * unsend anything - nothing can - but it stops the next batch, which is
 * the only useful thing left to do when something has gone wrong
 * mid-run.
 */

export async function POST(request: Request): Promise<Response> {
  const gate = await guardLaunchAdmin(request);
  if (!gate.ok) return gate.response;

  const body = await readAdminBody(request);

  // A typed phrase, not a boolean. `{"confirm": true}` is what a
  // copy-pasted runbook line carries by accident.
  if (!hasConfirmation(body, RELEASE_CONFIRMATION)) {
    return Response.json(
      { error: `Bestätigung fehlt. Erwartet: {"confirm":"${RELEASE_CONFIRMATION}"}` },
      { status: 400 }
    );
  }

  // SHOP_STATUS is declared `as const`, so TypeScript narrows it to the
  // literal currently deployed and calls any comparison with "live"
  // unreachable. The comparison is the point: this file has to keep
  // working when the constant is flipped and redeployed, which is
  // exactly how the shop is released. Widened here rather than in
  // app/content.ts so no business file is touched for a type.
  const shopStatus: string = SHOP_STATUS;

  const release = (body as { released?: unknown }).released;
  const shouldRelease = release !== false;
  const releasedBy = (body as { releasedBy?: unknown }).releasedBy;
  const note = (body as { note?: unknown }).note;

  if (shouldRelease && shopStatus !== "live") {
    return Response.json(
      {
        error: `Der Shop ist noch ${shopStatus}. Erst SHOP_STATUS auf "live" setzen und deployen.`,
      },
      { status: 409 }
    );
  }

  const supabase = getSupabaseAdmin();
  if (!supabase) return Response.json({ error: "Nicht verfügbar." }, { status: 503 });

  const { error } = await supabase
    .from("launch_release")
    .update({
      released: shouldRelease,
      released_at: shouldRelease ? new Date().toISOString() : null,
      released_by: typeof releasedBy === "string" ? releasedBy.slice(0, 200) : null,
      note: typeof note === "string" ? note.slice(0, 2000) : null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", true);

  if (error) {
    // Names the failure, never the driver's full message to the caller.
    console.error("Launch admin: could not write the release flag:", error.message);
    return Response.json(
      { error: "Die Freigabe konnte nicht gespeichert werden. Ist Migration 044 angewendet?" },
      { status: 503 }
    );
  }

  return Response.json({ ok: true, released: shouldRelease }, { status: 200 });
}
