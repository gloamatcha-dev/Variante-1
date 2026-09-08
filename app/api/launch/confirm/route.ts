import { getSupabaseAdmin } from "../../../../lib/supabaseAdmin";
import { getSiteOrigin } from "../../../../lib/siteUrl";
import { randomUUID } from "node:crypto";
import { CONFIRMATION_TOKEN_TTL_DAYS, LAUNCH_CONSENT_VERSION, hashToken, isWellFormedToken } from "../../../../lib/launchWaitlist";
import { buildWelcomeWiring } from "../../../../lib/launchWelcomeDeps.ts";
import { sendWelcomeEmail } from "../../../../lib/launchWelcomeSend.ts";
import {
  compatConfirmDb,
  isMissingFunctionError,
  legacyConfirm,
  type CompatClient,
} from "../../../../lib/launchSignupCompat.ts";

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

  // Until migration 046 is applied the function does not exist. That one
  // case - and no other database failure - takes the legacy path, so
  // confirmation links already sitting in inboxes keep working across the
  // deployment gap.
  if (confirmError) {
    if (!isMissingFunctionError(confirmError)) {
      console.error("Launch waitlist confirm: rpc failed:", confirmError.message);
      return redirect("error");
    }
    console.error("Launch waitlist confirm: migration 046 is not applied - using the legacy path.");
    try {
      const legacy = await legacyConfirm(
        compatConfirmDb(supabase as unknown as CompatClient),
        hashToken(token),
        Date.now(),
        CONFIRMATION_TOKEN_TTL_DAYS
      );
      // The welcome mail needs 045 as well, so it is not attempted on
      // this path: sendWelcomeEmail would only report unavailable.
      return redirect(legacy);
    } catch (err) {
      console.error(
        "Launch waitlist confirm: legacy path failed:",
        err instanceof Error ? err.message : "unknown error"
      );
      return redirect("error");
    }
  }

  // `returns table (...)` arrives as an array of rows through PostgREST.
  const row = Array.isArray(result) ? result[0] : result;
  const outcome = row && typeof row === "object" ? (row as { outcome?: unknown }).outcome : null;

  if (outcome === "withdrawn") return redirect("withdrawn");
  if (outcome === "expired") return redirect("expired");
  if (outcome !== "confirmed") return redirect("invalid");

  // ── THE WELCOME MAIL ────────────────────────────────────────
  //
  // Sent here, on the request that confirmed the address, and only to
  // somebody whose consent IN FORCE names it. The RPC above returned
  // which wording that is, and claim_welcome_email checks it again in
  // SQL - so a version 1 contact cannot reach this mail even if this
  // code forgot to look.
  //
  // NOTHING HERE MAY FAIL THE CONFIRMATION. Confirming is what the
  // person actually asked for; a second mail that could not be sent,
  // claimed or marked - including because migration 045 is not applied
  // yet - is an operational fact for the log, not a reason to tell them
  // their confirmation did not work.
  const effectiveVersion =
    row && typeof row === "object"
      ? (row as { effective_consent_version?: unknown }).effective_consent_version
      : null;
  const rowId = row && typeof row === "object" ? (row as { row_id?: unknown }).row_id : null;

  // ONLY A PROVEN DISPATCH MAY BE ANNOUNCED.
  //
  // The confirmation page offers to help people find the code in a spam
  // folder, which is only honest if the mail exists. This flag is set by
  // exactly one outcome - `sent`, meaning the provider returned 2xx AND
  // the row accepted the mark - and it is what picks the wording.
  //
  // Every other outcome stays quiet, and `not_claimed` is why it has to:
  // it covers a version 1 contact, a withdrawal, a parked row and an
  // already-sent one, and nothing here can tell those apart. Announcing a
  // mail on a maybe is how somebody ends up searching a spam folder for
  // something nobody sent them.
  let welcomeAccepted = false;

  if (typeof rowId === "string" && effectiveVersion === LAUNCH_CONSENT_VERSION) {
    const wiring = buildWelcomeWiring();
    if (!wiring.ok) {
      console.error("Launch welcome mail: not configured -", wiring.reason);
    } else {
      const sent = await sendWelcomeEmail(wiring.db, wiring.mailer, rowId, () => randomUUID());
      welcomeAccepted = sent.kind === "sent";
      // Counts and reasons only - never the address, never the row id.
      if (sent.kind === "needs_review" || sent.kind === "failed" || sent.kind === "unavailable") {
        console.error("Launch welcome mail:", sent.kind, "-", sent.reason);
      }
    }
  }

  return redirect(welcomeAccepted ? "confirmed-code" : "confirmed");
}
