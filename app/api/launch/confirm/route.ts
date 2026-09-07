import { getSupabaseAdmin } from "../../../../lib/supabaseAdmin";
import { getSiteOrigin } from "../../../../lib/siteUrl";
import { CONFIRMATION_TOKEN_TTL_DAYS, hashToken, isWellFormedToken } from "../../../../lib/launchWaitlist";

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

  // ONE STATEMENT CONFIRMS, PROMOTES AND SPENDS THE TOKEN.
  //
  // confirm_launch_signup (migration 046) takes a row lock, checks the
  // withdrawal and the expiry, promotes any pending consent wording to
  // the one in force, and clears the token - all inside one transaction.
  //
  // THAT PROMOTION IS THE POINT. A person who agreed to version 1 and
  // later re-submitted the form keeps version 1 in force until this
  // moment; the newer wording waits in the pending_consent_* columns and
  // becomes effective only here, because somebody clicked a link sent to
  // their address. That is what a double opt-in is, and it is why the
  // signup endpoint cannot grant it.
  //
  // Doing it in one statement also makes a second click, a prefetching
  // mail client and two parallel requests harmless: the token is spent
  // by whichever transaction wins the lock, and the other finds nothing.
  const { data: result, error: confirmError } = await supabase.rpc("confirm_launch_signup", {
    p_token_hash: hashToken(token),
    p_ttl_days: CONFIRMATION_TOKEN_TTL_DAYS,
  });

  if (confirmError) {
    console.error("Launch waitlist confirm: rpc failed:", confirmError.message);
    return redirect("error");
  }

  // `returns table (...)` arrives as an array of rows through PostgREST.
  const row = Array.isArray(result) ? result[0] : result;
  const outcome = row && typeof row === "object" ? (row as { outcome?: unknown }).outcome : null;

  if (outcome === "withdrawn") return redirect("withdrawn");
  if (outcome === "expired") return redirect("expired");
  if (outcome !== "confirmed") return redirect("invalid");

  return redirect("confirmed");
}
