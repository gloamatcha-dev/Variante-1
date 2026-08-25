import { createHash, timingSafeEqual } from "node:crypto";
import { getSupabaseAdmin } from "../../../../lib/supabaseAdmin";
import { runInternalOrderNotificationCron } from "../../../../lib/internalOrderNotificationRetry";

/**
 * Vercel Cron entry point for the internal order notification safety net.
 *
 * It takes no input at all. There is no order id, no recipient, no batch
 * size and no filter to pass: the eligibility rule lives in
 * lib/internalOrderNotificationRetry.ts, the recipient is the compile-time
 * constant orders@gloamatcha.com, and this endpoint's entire request
 * surface is one Authorization header. A caller who somehow got past the
 * secret still cannot choose who gets mail or which orders are touched -
 * the worst they can do is make the server re-attempt work it already
 * owed, which is what the cron does anyway.
 *
 * It answers with counts and nothing else. No order number, no order id,
 * no email address, no name, no address and no amount: this is an
 * operational health signal, and a personal-data leak is not worth the
 * convenience of a detailed answer that only a cron ever reads.
 *
 * WHAT ONE INVOCATION DOES, in this order:
 *
 *   A. return genuinely stale 'sending' rows to 'failed'
 *   B. run the failed-only retry sweep
 *
 * A exists because a worker that wins a claim and then dies leaves a row
 * at 'sending', which the sweep deliberately cannot see - see
 * lib/internalOrderNotificationRetryRules.ts. A sends nothing; it only
 * makes an abandoned row visible to B, which remains the single delivery
 * path. Both halves are separately bounded.
 *
 * Either half failing is a 500. A cron that could not do its work must
 * not answer with a clean-looking set of zeroes.
 *
 * GET because that is what Vercel Cron issues.
 *
 * THE SCHEDULE, AND WHY IT IS ONLY DAILY. vercel.json registers this at
 * "20 5 * * *" - 05:20 UTC, once a day. That is not a judgement about how
 * often a failed notification deserves a retry; it is the Vercel Hobby
 * plan's limit, which permits one cron invocation per day and nothing
 * finer. The time is chosen so a notification that failed overnight is
 * retried before the European working day starts, i.e. before anyone
 * would have gone looking for it.
 *
 * TECHNISCH VORBEREITET: the daily fallback is what runs today, and the
 * endpoint itself is schedule-agnostic - it drains one bounded batch per
 * call and is safe to call repeatedly.
 *
 * OPTIONAL FUTURE IMPROVEMENT: on Vercel Pro the schedule can be raised
 * to roughly every 10 to 15 minutes by editing the schedule in
 * vercel.json alone. No code here changes. Nothing in this task requires
 * that upgrade: Stripe's own redelivery schedule remains the fast path,
 * and this is the net underneath it.
 */

/**
 * Fixed-length digests so the comparison is timing safe for any input
 * length. timingSafeEqual throws on differing lengths, which would turn a
 * length mismatch into an observable difference all by itself; hashing
 * first removes that channel and the early return below is on presence,
 * never on content.
 */
function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function isAuthorized(request: Request, secret: string): boolean {
  const header = request.headers.get("authorization");
  if (!header) return false;
  return timingSafeEqual(digest(header), digest(`Bearer ${secret}`));
}

export async function GET(request: Request): Promise<Response> {
  // Fail closed. An unset CRON_SECRET must never mean "no authentication
  // required" - that would leave a public endpoint that mails the
  // fulfillment inbox, which is precisely the thing this must not be.
  // The value itself is never logged, only its absence.
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error("Order notification retry: CRON_SECRET is not configured - refusing to run.");
    return Response.json({ error: "Nicht verfügbar." }, { status: 503 });
  }

  if (!isAuthorized(request, secret)) {
    return Response.json({ error: "Nicht autorisiert." }, { status: 401 });
  }

  // Server-only, service-role client. Checked here so a missing key is a
  // clear 503 rather than a generic failure, and so the sweep is never
  // entered half-configured.
  if (!getSupabaseAdmin()) {
    console.error("Order notification retry: SUPABASE_SECRET_KEY is not configured.");
    return Response.json({ error: "Vorübergehend nicht verfügbar." }, { status: 503 });
  }

  try {
    const summary = await runInternalOrderNotificationCron();
    return Response.json(summary, { status: 200 });
  } catch (err) {
    console.error(
      "Order notification retry: sweep failed:",
      err instanceof Error ? err.message : "unknown error"
    );
    return Response.json({ error: "Interner Fehler." }, { status: 500 });
  }
}
