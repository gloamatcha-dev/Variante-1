import { getSupabaseAdmin } from "./supabaseAdmin";
// THE SHARED WORKER'S WIRING, IMPORTED RATHER THAN REBUILT. This is the
// same const the annual payment webhook hands to the same worker for
// Delivery 1, so Deliveries 2 to 13 cannot end up on a different queue, a
// different fulfillment call or a different post-order path.
import { annualDeliveryWorkerDeps } from "./annualPlanWebhookDeps";
import { runAnnualDeliveryWorker } from "./annualDeliveryWorker";
import { recoverAnnualOrderNotifications } from "./annualOrderNotification";
import {
  ANNUAL_PURCHASE_EMAIL_RETRY_LIMIT,
  ANNUAL_PURCHASE_EMAIL_STALE_AFTER_MS,
  runAnnualPurchaseEmailRetrySweep,
  type AnnualPurchaseEmailRetryRow,
} from "./annualPurchaseConfirmationEmail";
import { annualPurchaseEmailDeps } from "./annualPurchaseConfirmationEmailDeps";
import {
  runAnnualPlanMaintenance,
  type AnnualMaintenanceSummary,
} from "./annualPlanMaintenance";

/**
 * The real wiring behind the annual plan's daily maintenance
 * (Phase 4B6).
 *
 * Kept apart from lib/annualPlanMaintenance.ts on purpose, exactly as
 * lib/annualPlanWebhookDeps.ts is kept apart from the settlement flow:
 * the modules imported here reach lib/supabase.ts, which reads
 * import.meta.env at module scope and so only loads under the bundler.
 * Isolating them means the ORDER of the maintenance steps, and what it
 * does when one of them fails, can be proven with in-memory ports.
 *
 * Every function below is a thin adapter. Not one of them decides
 * anything: which deliveries are due, whether a plan may be fulfilled,
 * whether a purchase email may be claimed and whether a plan has earned
 * completion are all migration 039's questions, answered under its own
 * row locks.
 */

/**
 * How many plans one completion pass may examine.
 *
 * Twenty-five, the ceiling every family in this repository uses.
 * complete_due_annual_plans clamps its own limit to 100 regardless, so
 * this cannot become unbounded even if it were called wrongly, and a
 * plan not reached today is completed tomorrow - a plan whose term ended
 * stays eligible until it is.
 */
export const ANNUAL_COMPLETION_BATCH_LIMIT = 25;

function requireAdmin() {
  const admin = getSupabaseAdmin();
  if (!admin) throw new Error("supabase admin client is not configured");
  return admin;
}

/**
 * The purchase-email work list.
 *
 * ── IT CANNOT MATCH NULL, AND THAT IS STRUCTURAL ──────────────
 *
 * Both branches of the filter are equality tests on the status column,
 * and no equality test in SQL matches NULL. So a plan that never entered
 * the purchase-email flow is invisible here by construction rather than
 * by the query remembering to be careful - the same property migration
 * 026 gave the internal notification's own sweep.
 *
 *   status = 'failed'                     a genuine attempt that
 *                                         genuinely failed
 *   status = 'sending' AND claimed_at     a claim whose worker died. The
 *     older than the thirty-minute lease  same threshold migration 039's
 *                                         claim function compares
 *                                         against, so the two agree.
 *
 * The cutoff is computed from the clock the caller passed in, and the
 * lease constant is a server-side constant that no request can shorten.
 *
 * Oldest claim first, so yesterday's overflow sorts ahead of rows that
 * were already tried today.
 */
async function loadAnnualPurchaseEmailCandidates(
  now: Date,
  limit: number
): Promise<AnnualPurchaseEmailRetryRow[]> {
  const admin = requireAdmin();
  const staleCutoff = new Date(now.getTime() - ANNUAL_PURCHASE_EMAIL_STALE_AFTER_MS).toISOString();

  const { data, error } = await admin
    .from("annual_plans")
    .select(
      "id, purchase_confirmation_email_status, purchase_confirmation_email_claimed_at"
    )
    // The cutoff is DOUBLE-QUOTED because it is a value inside a logical
    // expression: an ISO timestamp carries colons, which PostgREST
    // otherwise reads as its own reserved punctuation. Quoting it is what
    // makes the staleness half of the filter parse as one literal.
    .or(
      "purchase_confirmation_email_status.eq.failed," +
        "and(purchase_confirmation_email_status.eq.sending," +
        'purchase_confirmation_email_claimed_at.lte."' + staleCutoff + '")'
    )
    .order("purchase_confirmation_email_claimed_at", { ascending: true })
    .limit(limit);

  if (error) throw new Error(`annual purchase email lookup failed: ${error.message}`);
  return (data as AnnualPurchaseEmailRetryRow[] | null) ?? [];
}

/**
 * public.complete_due_annual_plans(p_limit).
 *
 * A thin wrapper. It passes a bound and counts the rows the function
 * returned; it does not check a term, count a delivery, look for an
 * order id or write a status. Every one of those conditions is evaluated
 * inside the function, under FOR UPDATE SKIP LOCKED, and a plan that
 * fails any of them is simply not returned.
 */
async function completeDueAnnualPlans(limit: number): Promise<{ completed: number }> {
  const admin = requireAdmin();

  const { data, error } = await admin.rpc("complete_due_annual_plans", { p_limit: limit });
  if (error) throw new Error(`complete_due_annual_plans failed: ${error.message}`);

  return { completed: Array.isArray(data) ? data.length : 0 };
}

/**
 * One invocation of the annual plan's daily maintenance, wired.
 *
 * The clock is taken as an argument for the same reason the other sweeps
 * take one: the staleness boundary is then testable to the millisecond,
 * and nothing below reads a clock of its own.
 */
export async function runAnnualPlanMaintenanceJob(
  now: Date = new Date()
): Promise<AnnualMaintenanceSummary> {
  return runAnnualPlanMaintenance({
    // THE SHARED WORKER, with the same deps the payment webhook uses -
    // including notifyOrder, which is why an order minted here receives
    // exactly what an order minted by Delivery 1 receives. `outcomes` is
    // deliberately dropped: this answer is an operational health signal,
    // and it needs counts rather than a list of order ids.
    runDeliveryPass: async () => {
      const worker = await runAnnualDeliveryWorker(annualDeliveryWorkerDeps);
      return {
        claimed: worker.claimed,
        fulfilled: worker.fulfilled,
        guarded: worker.guarded,
        failed: worker.failed,
        notified: worker.notified,
        notifyFailed: worker.notifyFailed,
        errors: worker.errors,
      };
    },

    recoverOrderNotifications: () => recoverAnnualOrderNotifications(),

    retryPurchaseEmails: () =>
      runAnnualPurchaseEmailRetrySweep({
        loadCandidates: () =>
          loadAnnualPurchaseEmailCandidates(now, ANNUAL_PURCHASE_EMAIL_RETRY_LIMIT),
        // THE SAME PORTS THE WEBHOOK'S IMMEDIATE SEND USES. There is no
        // second sender, no second claim and no second template.
        emailDeps: annualPurchaseEmailDeps,
        now,
      }),

    completeDuePlans: () => completeDueAnnualPlans(ANNUAL_COMPLETION_BATCH_LIMIT),

    // The step name and a sanitised reason. No plan id, no order id, no
    // recipient, no amount and no address reaches a log line here.
    logFailure: (step, message) =>
      console.error("Annual plan maintenance: step failed:", step, message),
  });
}
