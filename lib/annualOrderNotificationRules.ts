/**
 * The one crash window an annual delivery order can fall into, and the
 * bounded, ANNUAL-SCOPED recovery that closes it (Phase 4B6).
 *
 * Pure and leaf: no relative imports, no database, no network, no clock,
 * no environment - the same choice lib/annualDeliveryWorker.ts and
 * lib/internalOrderNotificationRetryRules.ts make, and what lets the loop
 * below be executed by the plain Node test runner.
 * lib/annualOrderNotification.ts is the wiring that gives it a Supabase
 * client and the existing send path.
 *
 * ── THE WINDOW, STATED EXACTLY ────────────────────────────────
 *
 * migration 039's fulfill_annual_plan_delivery COMMITS an order and marks
 * the delivery fulfilled. The shared worker then hands that order to the
 * ordinary internal notification, which claims NULL-or-failed -> sending
 * before it sends anything. Between those two moments the process can
 * die, and then:
 *
 *   - the delivery is 'fulfilled', so claim_due_annual_plan_deliveries
 *     will NEVER return it again (it requires order_id null and
 *     fulfilled_at null). The six-hour stale-claim lease cannot help: a
 *     fulfilled row is not a claimed row.
 *   - the order's internal_notification_status is still NULL, and the
 *     generic daily sweep in lib/internalOrderNotificationRetryRules.ts
 *     selects 'failed' and NOTHING ELSE, by design.
 *   - the stale-'sending' recovery cannot see it either: the row never
 *     reached 'sending'.
 *
 * Every other outcome is already covered. A send that genuinely failed
 * wrote 'failed' and belongs to the generic sweep; a worker that died
 * mid-send left 'sending' and belongs to the stale recovery. This is the
 * remaining state, and without something looking for it a paid annual
 * delivery could exist that fulfillment is never told to pack.
 *
 * ── WHY THIS MAY SELECT NULL, WHEN NOTHING ELSE MAY ───────────
 *
 * Because it is not a sweep over public.orders. The work list is derived
 * from the ANNUAL DELIVERY CORRELATION - rows in
 * public.annual_plan_deliveries that carry an order_id - and those rows
 * did not exist before migration 039. The 451 historical orders whose
 * email columns are NULL because the feature post-dates them have no
 * delivery row and therefore cannot appear here, no matter what their
 * status column says. The repository's absolute rule is that no GLOBAL
 * NULL sweep may exist, and this is not one: it is an inner join to a
 * table whose every row is an annual delivery this system created and
 * owes a box for.
 *
 * ── AND IT SENDS NOTHING ITSELF ───────────────────────────────
 *
 * Recovery hands each order to the SAME send path the webhook and the
 * cron use, which brings its own atomic claim and the same deterministic
 * provider idempotency key. There is no second sender here, no second
 * recipient, no second template and no second state machine - so a row
 * that a concurrent worker is already delivering is refused by that
 * claim rather than by anything decided in this file.
 */

/**
 * How many recovered orders one run may notify.
 *
 * Twenty-five, matching RETRY_BATCH_LIMIT in
 * lib/internalOrderNotificationRetryRules.ts and
 * ANNUAL_DELIVERY_BATCH_LIMIT in lib/annualDeliveryWorker.ts. A ceiling,
 * not a target: on a healthy day this list is empty, because the worker
 * that minted the order already sent the message. What is not reached
 * today is reached tomorrow.
 */
export const ANNUAL_ORDER_NOTIFICATION_RECOVERY_LIMIT = 25;

/**
 * The eligibility rule, and the whole of it: the notification was NEVER
 * ATTEMPTED.
 *
 * 'failed' is deliberately NOT eligible here. It is the generic sweep's
 * work list, that sweep already runs on this same cron, and claiming it
 * from two places would be two answers to one question. 'sending'
 * belongs to whoever holds the claim, and 'sent' is done.
 */
export function isAnnualOrderNotificationRecoveryCandidate(
  status: string | null | undefined
): boolean {
  return status === null || status === undefined;
}

/** One annual-generated order, as the work-list query returns it. */
export type AnnualOrderNotificationRecoveryRow = {
  id: string;
  internal_notification_status: string | null;
};

/** The outcome of one run. Counts and order ids only - never a customer fact. */
export type AnnualOrderNotificationRecoverySummary = {
  /** Rows the work list returned. */
  found: number;
  /** Rows handed to the send path without an error. */
  notified: number;
  /** Rows refused in code because they were not actually NULL. */
  skipped: number;
  /** Rows the send path could not complete. Still owed, and reported. */
  failed: number;
  /** Sanitised reasons. Never a recipient, an address or an amount. */
  errors: string[];
};

export type AnnualOrderNotificationRecoveryPort = {
  /**
   * Annual delivery orders whose internal notification was never
   * attempted, already bounded by the caller.
   */
  loadCandidates: () => Promise<AnnualOrderNotificationRecoveryRow[]>;
  /**
   * The ordinary send path, by order id. It brings its own claim, so
   * nothing here decides whether a message is actually sent.
   */
  notify: (orderId: string) => Promise<void>;
  /** Order id only. A failed recovery is not a reason to log a customer. */
  logFailure: (orderId: string, message: string) => void;
};

/**
 * One bounded pass over annual delivery orders that were never told
 * about.
 *
 * Sequential and per-row guarded, for the reasons the generic sweep is:
 * the batch is small, and one bad row - an order whose frozen lines will
 * not render, a provider refusing - must not strand the rest. A row that
 * fails stays exactly as owed as it was, and tomorrow's run sees it
 * again.
 *
 * Throws only when the work list itself cannot be read. That is an
 * infrastructure failure rather than "nothing to do", and the caller
 * reports it instead of answering with a clean-looking zero.
 */
export async function runAnnualOrderNotificationRecovery(
  port: AnnualOrderNotificationRecoveryPort
): Promise<AnnualOrderNotificationRecoverySummary> {
  const summary: AnnualOrderNotificationRecoverySummary = {
    found: 0,
    notified: 0,
    skipped: 0,
    failed: 0,
    errors: [],
  };

  const rows = await port.loadCandidates();
  summary.found = rows.length;

  for (const row of rows) {
    // The in-code half of the rule. The query already filters on NULL;
    // this refuses a row that reached the loop anyway - which is what a
    // concurrent worker moving it to 'sending' between the read and here
    // looks like.
    if (!isAnnualOrderNotificationRecoveryCandidate(row.internal_notification_status)) {
      summary.skipped += 1;
      continue;
    }

    try {
      await port.notify(row.id);
      summary.notified += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown error";
      port.logFailure(row.id, message);
      summary.failed += 1;
      summary.errors.push(`annual order notification recovery failed: ${message}`);
    }
  }

  return summary;
}
