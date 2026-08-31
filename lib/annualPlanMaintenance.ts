/**
 * The daily background runtime of a prepaid annual plan (Phase 4B6): the
 * ORDER the four jobs run in, and what happens when one of them cannot.
 *
 * A leaf: ZERO imports, no database client, no network, no clock, no
 * environment. Every step is an INJECTED PORT, which is what lets the
 * whole sequence be driven in a plain Node test - and what keeps it
 * loadable by the test runner at all, since Node cannot resolve this
 * repository's extension-less relative imports. Same shape as
 * lib/annualDeliveryWorker.ts and lib/annualPurchaseConfirmationEmail.ts,
 * for the same reasons. The wiring lives in
 * lib/annualPlanMaintenanceDeps.ts.
 *
 * ── IT COMPUTES NO DATE, AND OWNS NO RULE ─────────────────────
 *
 * There is no "+ 28 days" here, no "+ 672 hours", no "+ 364 days" and no
 * comparison of a schedule against a clock. Activation already wrote all
 * thirteen delivery dates, and migration 039's functions own every
 * question this file might otherwise be tempted to answer: which
 * deliveries are due, whether a plan may still be fulfilled, whether a
 * purchase email may be claimed, and whether a plan has earned
 * completion. This file invokes and reports.
 *
 * A MISSED RUN THEREFORE COSTS NOTHING BUT TIME. Because the dates are
 * frozen rather than derived, a cron outage does not shift a schedule: a
 * later run simply finds several deliveries due, fulfils each, and leaves
 * every future date exactly where activation put it.
 *
 * ── THE ORDER, AND WHY IT IS THIS ORDER ───────────────────────
 *
 *   1. DUE DELIVERIES        the queue, through the shared worker. It
 *                            also performs each new order's post-order
 *                            processing, so Delivery 1 (from the payment
 *                            webhook) and Deliveries 2 to 13 (from here)
 *                            are handled by one mechanism.
 *
 *   2. ORDER NOTIFICATION    the crash window: an order that exists with
 *      RECOVERY              its notification never attempted. AFTER
 *                            step 1, so a delivery fulfilled moments ago
 *                            whose notification did not land is picked up
 *                            on this same run rather than tomorrow.
 *
 *   3. PURCHASE EMAIL RETRY  'failed' and stale 'sending' only. Later
 *                            than the two above because a customer's
 *                            purchase confirmation is not more urgent
 *                            than the boxes they are owed, and it must
 *                            not be able to consume the invocation before
 *                            the queue is drained.
 *
 *   4. COMPLETION            LAST, and that is load-bearing: a plan whose
 *                            thirteenth delivery was fulfilled in step 1
 *                            becomes completable in the same invocation.
 *                            Running it first would always wait a day.
 *
 * ── ONE FAILURE DOES NOT CANCEL THE OTHERS ────────────────────
 *
 * Each step has its own guard and its own counters, exactly like the
 * email families and the deferred-cancellation sweep already sharing this
 * cron. A delivery queue that is unreachable must not stop a customer's
 * confirmation being retried, and a mail provider having a bad day must
 * not stop a finished plan being completed.
 *
 * WHAT IT MUST NOT DO IS LIE. A step that could not run reports
 * errored: true with its counts at zero, so an operator can never read a
 * clean set of zeroes and conclude there was no work.
 *
 * ── NO FEATURE FLAG ───────────────────────────────────────────
 *
 * B2C_ANNUAL_PLAN_ENABLED is not consulted here and must never be.
 * It gates NEW SALES. Turning it off means the shop stops selling annual
 * plans; it does not cancel a contract somebody already paid for in full,
 * and a plan with nine deliveries left is owed those nine deliveries, its
 * confirmation email and its completion regardless of what the shop is
 * currently selling.
 */

/** What one delivery pass reports. Counts and sanitised reasons only. */
export type AnnualDeliveryPassSummary = {
  claimed: number;
  fulfilled: number;
  /** Refused by migration 039's parent guard. Not an error. */
  guarded: number;
  failed: number;
  notified: number;
  notifyFailed: number;
  errors: string[];
};

/** What one order-notification recovery pass reports. */
export type AnnualOrderNotificationPassSummary = {
  found: number;
  notified: number;
  skipped: number;
  failed: number;
  errors: string[];
};

/** What one purchase-email retry pass reports. */
export type AnnualPurchaseEmailPassSummary = {
  found: number;
  attempted: number;
  skipped: number;
  sent: number;
  alreadySent: number;
  inFlight: number;
  notEligible: number;
  ambiguous: number;
  failed: number;
  errors: string[];
};

/** What one completion pass reports. The RPC decides; this counts. */
export type AnnualCompletionPassSummary = {
  completed: number;
};

export type AnnualMaintenancePorts = {
  /** One bounded pass of the SHARED delivery worker. */
  runDeliveryPass: () => Promise<AnnualDeliveryPassSummary>;
  /** One bounded pass over annual orders whose notification is still NULL. */
  recoverOrderNotifications: () => Promise<AnnualOrderNotificationPassSummary>;
  /** One bounded pass over 'failed' and stale 'sending' purchase emails. */
  retryPurchaseEmails: () => Promise<AnnualPurchaseEmailPassSummary>;
  /** public.complete_due_annual_plans(limit). The DB owns every condition. */
  completeDuePlans: () => Promise<AnnualCompletionPassSummary>;
  /** Step name and sanitised reason. Never a customer fact. */
  logFailure: (step: string, message: string) => void;
};

/** A step's counters plus whether the step itself could run. */
type Guarded<T> = T & { errored: boolean };

export type AnnualMaintenanceSummary = {
  deliveries: Guarded<AnnualDeliveryPassSummary>;
  orderNotifications: Guarded<AnnualOrderNotificationPassSummary>;
  purchaseEmails: Guarded<AnnualPurchaseEmailPassSummary>;
  completions: Guarded<AnnualCompletionPassSummary>;
};

const EMPTY_DELIVERIES: AnnualDeliveryPassSummary = {
  claimed: 0, fulfilled: 0, guarded: 0, failed: 0, notified: 0, notifyFailed: 0, errors: [],
};

const EMPTY_ORDER_NOTIFICATIONS: AnnualOrderNotificationPassSummary = {
  found: 0, notified: 0, skipped: 0, failed: 0, errors: [],
};

const EMPTY_PURCHASE_EMAILS: AnnualPurchaseEmailPassSummary = {
  found: 0, attempted: 0, skipped: 0, sent: 0, alreadySent: 0,
  inFlight: 0, notEligible: 0, ambiguous: 0, failed: 0, errors: [],
};

/**
 * Runs one step inside its own boundary.
 *
 * A step that throws yields its empty counters with errored: true and one
 * sanitised reason, and the sequence continues. Nothing here retries: the
 * schedule is the retry, and every step is idempotent by construction, so
 * tomorrow's invocation resumes from whatever durable state today's left.
 */
async function guardStep<T>(
  step: string,
  empty: T,
  run: () => Promise<T>,
  logFailure: (step: string, message: string) => void
): Promise<Guarded<T>> {
  try {
    return { ...(await run()), errored: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    logFailure(step, message);
    return { ...empty, errored: true };
  }
}

/**
 * The all-zero answer, for a run that could not start at all.
 *
 * errored is an ARGUMENT rather than a constant so this cannot be used to
 * report a quiet success. The cron uses it with `true` when the
 * orchestration itself threw; nothing else may use it at all.
 */
export function emptyAnnualMaintenanceSummary(errored: boolean): AnnualMaintenanceSummary {
  return {
    deliveries: { ...EMPTY_DELIVERIES, errors: [], errored },
    orderNotifications: { ...EMPTY_ORDER_NOTIFICATIONS, errors: [], errored },
    purchaseEmails: { ...EMPTY_PURCHASE_EMAILS, errors: [], errored },
    completions: { completed: 0, errored },
  };
}

/**
 * One invocation of the annual plan's daily maintenance.
 *
 * Every step is bounded by its own limit, and none of them loops until
 * empty: what a backlog leaves behind is left for the next daily run.
 * Correctness never depends on clearing the whole world in one execution.
 */
export async function runAnnualPlanMaintenance(
  ports: AnnualMaintenancePorts
): Promise<AnnualMaintenanceSummary> {
  const deliveries = await guardStep(
    "deliveries", EMPTY_DELIVERIES, ports.runDeliveryPass, ports.logFailure
  );

  const orderNotifications = await guardStep(
    "order notifications", EMPTY_ORDER_NOTIFICATIONS, ports.recoverOrderNotifications, ports.logFailure
  );

  const purchaseEmails = await guardStep(
    "purchase emails", EMPTY_PURCHASE_EMAILS, ports.retryPurchaseEmails, ports.logFailure
  );

  // LAST, so a plan whose final delivery was fulfilled by the first step
  // can complete in this same invocation.
  const completions = await guardStep(
    "completion", { completed: 0 }, ports.completeDuePlans, ports.logFailure
  );

  return { deliveries, orderNotifications, purchaseEmails, completions };
}
