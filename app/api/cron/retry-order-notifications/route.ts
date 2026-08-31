import { getSupabaseAdmin } from "../../../../lib/supabaseAdmin";
import { isBearerSecretAuthorized } from "../../../../lib/serverSecretAuth";
import { runTransactionalEmailRetryCron } from "../../../../lib/transactionalEmailRetry";
import { getStripeClient } from "../../../../lib/stripe";
import { sweepDueDeferredCancellations } from "../../../../lib/subscriptionCancellation";
// Phase 3H.5B2. Same cron, third job, its own error boundary.
import {
  emptySubscriptionEmailRetrySummary,
  runSubscriptionEmailRetrySweep,
} from "../../../../lib/subscriptionEmailRetry";
// Phase 4B6. Same cron, fourth job, its own error boundary.
import { emptyAnnualMaintenanceSummary } from "../../../../lib/annualPlanMaintenance";
import { runAnnualPlanMaintenanceJob } from "../../../../lib/annualPlanMaintenanceDeps";

/**
 * Vercel Cron entry point for the transactional email safety net.
 *
 * ── PHASE 2E-B WIDENED WHAT THIS DRAINS ───────────────────────
 *
 * It began as the retry for the internal new-order notification alone.
 * There are now six transactional email families, and five of them could
 * end at 'failed' with nothing in the system that would ever look at
 * them again. This endpoint now drains all six.
 *
 * THE PATH IS DELIBERATELY UNCHANGED. "retry-order-notifications" stays
 * truthful - every one of the six is a notification about an order - and
 * renaming it would mean editing the path in vercel.json, which
 * re-registers the deployed cron. That is a real deployment risk for a
 * cosmetic gain, and the Vercel Hobby plan permits one invocation per
 * day, so a second endpoint would have meant a second schedule this plan
 * should not spend. One authenticated daily job, six families, separate
 * counters.
 *
 * The families are independent: each has its own bounded batch, its own
 * try/catch and its own counters, so one family's outage cannot stop the
 * other five and one noisy family cannot starve them. See
 * lib/transactionalEmailRetryRules.ts.
 *
 * ── FAILED ONLY. NEVER NULL. ──────────────────────────────────
 *
 * Selection is `<status column> = 'failed'` for every family, and that is
 * absolute. The live database holds 451 orders whose email state columns
 * are NULL because these features did not exist when those orders were
 * placed - including one order with a genuinely settled refund. A sweep
 * keyed on NULL, on a missing sent_at, or on a missing refund watermark
 * would mail that history. 'failed' can only be written by code that
 * genuinely tried and genuinely failed.
 *
 * ── PHASE 3C.3 ADDED A SEVENTH JOB, AND IT IS NOT EMAIL ───────
 *
 * This endpoint now also drains DUE DEFERRED SUBSCRIPTION CANCELLATIONS,
 * and that is a deliberate widening of its contract rather than an
 * oversight. State it plainly: this is the one place in the cron that
 * calls a Stripe write API.
 *
 * A late cancellation is applied at Stripe when its one owed cycle is
 * paid, driven by invoice.paid. If that application fails, the webhook
 * throws and Stripe redelivers - for about three days. Past that budget
 * the cancellation would wait for the NEXT renewal, 28 days away, which
 * charges the customer a second extra cycle. That is the concrete window
 * this job closes, and closing it needs a durable timer.
 *
 * It lives here rather than in its own endpoint because the Vercel Hobby
 * plan permits ONE cron invocation per day. A second endpoint would have
 * needed a second schedule this plan does not have.
 *
 * It is bounded, it re-derives due-ness from durable local state, and it
 * runs in its own guard: a Stripe outage cannot stop the six email
 * families, and an email failure cannot stop it.
 *
 * ── PHASE 4B6 ADDED A FOURTH JOB, AND IT DOES CREATE ORDERS ───
 *
 * This endpoint now also runs the ANNUAL PLAN'S DAILY MAINTENANCE, and
 * that is the largest widening of its contract so far: deliveries 2 to 13
 * of a prepaid annual plan become real orders here.
 *
 * It is here rather than in its own endpoint for the reason the deferred
 * cancellation sweep is: the Vercel Hobby plan permits ONE cron
 * invocation per day, and a second endpoint would have needed a second
 * schedule this plan does not have. vercel.json is unchanged, the path is
 * unchanged, and the authentication is the same CRON_SECRET.
 *
 * NO ORDER IS CREATED BY THIS FILE. The maintenance job asks migration
 * 039's claim and fulfillment functions, each of which decides under its
 * own row lock whether a delivery is due and whether its plan may still
 * be fulfilled, and creates the order inside one transaction. This
 * endpoint passes no id, no date, no amount and no limit into any of it:
 * its entire request surface is still one Authorization header.
 *
 * It runs in its own guard, like the two jobs above it. An annual
 * database outage cannot stop the six email families, a mail provider
 * cannot stop a plan being completed, and none of them can stop the
 * others.
 *
 * ── IT RETRIES DELIVERY. IT CREATES NOTHING. ──────────────────
 *
 * No order is created, cancelled, resolved, shipped or refunded here.
 * The only Stripe call is subscriptions.update setting cancel_at on a
 * subscription whose customer already asked to end it - no refund, no
 * charge, no price, no item, no quantity. The only local writes are one
 * column moving from a stale 'sending' back to 'failed', whatever the
 * existing senders write - which the column-scoped grants in migrations
 * 017, 026, 027, 030, 031 and 033 already confine to thirteen
 * email-state columns - and the two cancellation columns migration 034's
 * security-definer function owns.
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
 * WHAT ONE INVOCATION DOES, per family, in this order:
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
 * A family that cannot do its work reports errored: true in its own
 * counters rather than failing the whole run - a cron that could not read
 * one work list must still retry the other five, and must not answer with
 * a clean-looking set of zeroes for the one it missed. Only a failure of
 * the orchestration itself is a 500.
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

/*
 * The timing-safe comparison this endpoint used to carry privately now
 * lives in lib/serverSecretAuth.ts, unchanged: sha256 both sides so
 * length differences cannot leak, then timingSafeEqual. It moved there
 * when the authorized shipment endpoint (Phase 2B) needed the same
 * check - a second private copy of a comparison this security-sensitive
 * is how two copies drift apart.
 *
 * The SECRET is emphatically not shared. This endpoint keeps CRON_SECRET
 * and the shipment endpoint keeps FULFILLMENT_ADMIN_SECRET, because they
 * have different blast radii: this one can only re-attempt work the shop
 * already owed itself, while that one changes fulfillment state and mails
 * a customer.
 */

export async function GET(request: Request): Promise<Response> {
  // Fail closed. An unset CRON_SECRET must never mean "no authentication
  // required" - that would leave a public endpoint that mails the
  // fulfillment inbox, which is precisely the thing this must not be.
  // The value itself is never logged, only its absence.
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error("Transactional email retry: CRON_SECRET is not configured - refusing to run.");
    return Response.json({ error: "Nicht verfügbar." }, { status: 503 });
  }

  if (!isBearerSecretAuthorized(request, secret)) {
    return Response.json({ error: "Nicht autorisiert." }, { status: 401 });
  }

  // Server-only, service-role client. Checked here so a missing key is a
  // clear 503 rather than a generic failure, and so the sweep is never
  // entered half-configured.
  if (!getSupabaseAdmin()) {
    console.error("Transactional email retry: SUPABASE_SECRET_KEY is not configured.");
    return Response.json({ error: "Vorübergehend nicht verfügbar." }, { status: 503 });
  }

  try {
    const summary = await runTransactionalEmailRetryCron();

    // ── THE DEFERRED CANCELLATION NET (Phase 3C.3) ────────────
    //
    // Its own guard, deliberately. The six email families above have
    // already done their work by this point and their counters must
    // survive a Stripe outage; equally, an email family that errored
    // must not stop a customer's cancellation from reaching Stripe.
    //
    // An unconfigured Stripe key is reported rather than thrown: the
    // email half of this run genuinely succeeded and its summary is
    // worth returning.
    let deferredCancellations;
    try {
      const stripe = getStripeClient();
      if (!stripe) {
        console.error("Deferred cancellation sweep: STRIPE_SECRET_KEY is not configured.");
        deferredCancellations = { due: 0, applied: 0, alreadyScheduled: 0, failed: 0, errored: true };
      } else {
        deferredCancellations = await sweepDueDeferredCancellations(stripe);
      }
    } catch (err) {
      console.error(
        "Deferred cancellation sweep: failed:",
        err instanceof Error ? err.message : "unknown error"
      );
      deferredCancellations = { due: 0, applied: 0, alreadyScheduled: 0, failed: 0, errored: true };
    }

    // ── THE SUBSCRIPTION LIFECYCLE EMAIL SWEEP (Phase 3H.5B2) ──
    //
    // THIRD, AND LAST, deliberately. The two jobs above have already
    // finished by this point, so an unexpected failure here cannot cost
    // an order email its retry or a customer's cancellation its trip to
    // Stripe. Its own guard, for the same reason the deferred sweep has
    // one.
    //
    // It selects status = 'failed' and nothing else. 'sending' is
    // reported and never touched: it is ambiguous about whether Resend
    // already accepted the message, and Phase 3H.5A proved this daily
    // cron cannot guarantee landing inside the provider's 24-hour
    // idempotency window. Nothing here converts an age into a failure.
    let subscriptionEmails;
    try {
      subscriptionEmails = await runSubscriptionEmailRetrySweep();
    } catch (err) {
      console.error(
        "Subscription email retry: sweep failed:",
        err instanceof Error ? err.message : "unknown error"
      );
      subscriptionEmails = emptySubscriptionEmailRetrySummary(true);
    }

    // ── THE ANNUAL PLAN'S DAILY MAINTENANCE (Phase 4B6) ───────
    //
    // FOURTH, AND LAST. The three jobs above have finished by this point,
    // so a failure here cannot cost an order email its retry, a
    // cancellation its trip to Stripe or a subscription email its sweep.
    // Its own guard, for the same reason they have one.
    //
    // Inside it, four bounded steps run in a fixed order with their own
    // boundaries: due deliveries through the shared worker, the recovery
    // for an annual order whose notification was never attempted, the
    // purchase-confirmation retry - which selects 'failed' and stale
    // 'sending' and NEVER a NULL - and finally completion, last so a plan
    // whose thirteenth delivery was fulfilled a moment ago can complete
    // on this same run. See lib/annualPlanMaintenance.ts.
    //
    // B2C_ANNUAL_PLAN_ENABLED is deliberately not consulted: that flag
    // stops new sales, and a contract somebody already paid for in full
    // is still owed its deliveries.
    let annual;
    try {
      annual = await runAnnualPlanMaintenanceJob();
    } catch (err) {
      console.error(
        "Annual plan maintenance: run failed:",
        err instanceof Error ? err.message : "unknown error"
      );
      annual = emptyAnnualMaintenanceSummary(true);
    }

    // Counts only, exactly like the email families. No subscription id,
    // no Stripe id, no customer fact. The subscription block adds
    // delivery uuids for stale 'sending' rows, which are the one thing an
    // operator needs to find them - and are not customer data. The annual
    // block adds counts and sanitised failure reasons, and no plan id,
    // order id, recipient or amount at all.
    return Response.json(
      { ...summary, deferredCancellations, subscriptionEmails, annual },
      { status: 200 }
    );
  } catch (err) {
    console.error(
      "Transactional email retry: sweep failed:",
      err instanceof Error ? err.message : "unknown error"
    );
    return Response.json({ error: "Interner Fehler." }, { status: 500 });
  }
}
