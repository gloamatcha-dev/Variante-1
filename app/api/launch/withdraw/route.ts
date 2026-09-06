import { getSupabaseAdmin } from "../../../../lib/supabaseAdmin";
import { getSiteOrigin } from "../../../../lib/siteUrl";
import { hashToken, isWellFormedToken } from "../../../../lib/launchWaitlist";

/**
 * WITHDRAWING THE LAUNCH CONSENT, IN ONE CLICK.
 *
 * Art. 7(3) GDPR: withdrawing consent has to be as easy as giving it.
 * Giving it took one checkbox and one button, so taking it back takes
 * one link - no login, no form, no "tell us why", no confirmation step
 * to click through.
 *
 * Same token discipline as the confirmation route: an opaque 32-byte
 * value, matched by its SHA-256 hash, never the email address in the
 * URL.
 *
 * -- WITHDRAWAL IS FINAL FOR THIS LIST -------------------------
 * The row goes to `withdrawn` and stays there. POST /api/launch will not
 * revive it, and lib/launchWaitlist.ts (mayReceiveLaunchNotification)
 * refuses to send to any row that is not `confirmed` - so a withdrawn
 * entry cannot receive the launch mail even if the send job is run
 * carelessly. Someone who changes their mind again gives fresh consent,
 * which is the point.
 *
 * The withdrawal token is kept rather than cleared, so clicking the link
 * a second time is a no-op that lands on the same page instead of an
 * error page telling someone their withdrawal did not work.
 */
export async function GET(request: Request): Promise<Response> {
  const origin = getSiteOrigin();
  const base = origin || "";

  const redirect = (state: string): Response =>
    new Response(null, {
      status: 303,
      headers: {
        Location: `${base}/launch?state=${state}`,
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      },
    });

  const token = new URL(request.url).searchParams.get("token");

  if (!isWellFormedToken(token)) return redirect("invalid");

  const supabase = getSupabaseAdmin();
  if (!supabase) {
    console.error("Launch waitlist withdraw: Supabase is not configured.");
    return redirect("error");
  }

  const { data: row, error } = await supabase
    .from("launch_waitlist")
    .select("id, status")
    .eq("withdrawal_token_hash", hashToken(token))
    .maybeSingle();

  if (error) {
    console.error("Launch waitlist withdraw: lookup failed:", error.message);
    return redirect("error");
  }

  if (!row) return redirect("invalid");

  // Already withdrawn: say so plainly rather than writing again.
  if (row.status === "withdrawn") return redirect("withdrawn");

  const { error: updateError } = await supabase
    .from("launch_waitlist")
    .update({
      status: "withdrawn",
      withdrawn_at: new Date().toISOString(),
      // The confirmation link dies with the consent it belonged to.
      confirmation_token_hash: null,
    })
    .eq("id", row.id);

  if (updateError) {
    console.error("Launch waitlist withdraw: update failed:", updateError.message);
    return redirect("error");
  }

  return redirect("withdrawn");
}
