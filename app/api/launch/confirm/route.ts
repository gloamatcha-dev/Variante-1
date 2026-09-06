import { getSupabaseAdmin } from "../../../../lib/supabaseAdmin";
import { getSiteOrigin } from "../../../../lib/siteUrl";
import { hashToken, isConfirmationExpired, isWellFormedToken } from "../../../../lib/launchWaitlist";

/**
 * DOUBLE OPT-IN, SECOND HALF.
 *
 * The link in the confirmation mail lands here. It carries an opaque
 * 32-byte token and nothing else - no email address, no name, no id.
 * URLs end up in proxy logs, browser history and Referer headers, so an
 * address in a query string is an address published to all three.
 *
 * The token is matched by its SHA-256 hash, which is the only form the
 * database holds, so the lookup works without the table ever storing a
 * usable credential.
 *
 * -- WHY IT REDIRECTS ------------------------------------------
 * The outcome is rendered by /launch, which already owns the brand's
 * type and colour. Redirecting also drops the token out of the address
 * bar in the same step, so a confirmed visitor cannot leave it behind in
 * a screenshot, a shared link or the browser history entry they keep.
 *
 * -- IDEMPOTENT ------------------------------------------------
 * A second click on the same link - a prefetching client, a forwarded
 * mail, a curious refresh - is not an error. The token is cleared on
 * first use, so the second visit finds nothing and lands on the same
 * page it would have anyway. Nobody sees a failure for confirming twice.
 */
export async function GET(request: Request): Promise<Response> {
  const origin = getSiteOrigin();
  const base = origin || "";

  const redirect = (state: string): Response =>
    new Response(null, {
      status: 303,
      headers: {
        Location: `${base}/launch?state=${state}`,
        // A confirmation outcome is per-person and single-use. Nothing
        // about it may sit in a shared or local cache.
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      },
    });

  const token = new URL(request.url).searchParams.get("token");

  if (!isWellFormedToken(token)) return redirect("invalid");

  const supabase = getSupabaseAdmin();
  if (!supabase) {
    console.error("Launch waitlist confirm: Supabase is not configured.");
    return redirect("error");
  }

  const { data: row, error } = await supabase
    .from("launch_waitlist")
    .select("id, status, confirmation_sent_at")
    .eq("confirmation_token_hash", hashToken(token))
    .maybeSingle();

  if (error) {
    console.error("Launch waitlist confirm: lookup failed:", error.message);
    return redirect("error");
  }

  // No row: an unknown token, a link already used, or an entry that was
  // deleted by the retention rule. All three are the same neutral answer.
  if (!row) return redirect("invalid");

  if (row.status === "withdrawn") return redirect("withdrawn");

  if (isConfirmationExpired(row.confirmation_sent_at, Date.now())) {
    return redirect("expired");
  }

  // Confirming clears the token in the same statement that sets the
  // status, so the link is spent exactly once.
  const { error: updateError } = await supabase
    .from("launch_waitlist")
    .update({
      status: "confirmed",
      confirmed_at: new Date().toISOString(),
      confirmation_token_hash: null,
    })
    .eq("id", row.id)
    .eq("status", "pending");

  if (updateError) {
    console.error("Launch waitlist confirm: update failed:", updateError.message);
    return redirect("error");
  }

  return redirect("confirmed");
}
