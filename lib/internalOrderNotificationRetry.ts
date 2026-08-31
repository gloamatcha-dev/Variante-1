import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseAdmin } from "./supabaseAdmin";
import {
  deliverClaimedInternalOrderNotification,
  markInternalNotificationFailed,
} from "./internalOrderNotificationEmail";
import {
  IN_FLIGHT_STATUS,
  RETRY_BATCH_LIMIT,
  RETRY_ELIGIBLE_STATUS,
  STALE_RECOVERY_BATCH_LIMIT,
  runInternalNotificationRetrySweep,
  runStaleSendingRecovery,
  staleSendingCutoff,
  type CronSweepSummary,
  type InternalNotificationRetrySummary,
  type RetryAttemptRow,
  type RetryClaimOutcome,
  type RetryOrderRow,
  type StaleRecoveryOutcome,
  type StaleRecoverySummary,
  type StaleSendingRow,
} from "./internalOrderNotificationRetryRules";
import type { AddressSnapshot } from "./orderAddressSnapshot";

/**
 * Gives the retry rules a database and a mail provider, and nothing else.
 *
 * Every decision - which rows are eligible, what the notification says,
 * what happens when one row fails - lives in
 * lib/internalOrderNotificationRetryRules.ts, which is a pure leaf and is
 * therefore unit-tested directly. This file is the half that cannot be:
 * two queries, one conditional UPDATE, and the existing send path.
 *
 * WHAT IT MAY DO. Send one internal notification to the fixed fulfillment
 * address and write internal_notification_status /
 * internal_notification_sent_at. That is the entire blast radius, and the
 * column-scoped grant migration 026 gives service_role means a bug here
 * still cannot reach a money column. No order is created, no payment
 * state moves, no customer email is sent, no subscription is activated,
 * nothing Stripe holds is touched, and no shipping, tax or product
 * snapshot is written or recomputed.
 *
 * WHY THERE IS NO MIGRATION 027. A retry has to know which rows are owed
 * a send, how to take one exclusively, and when to stop. Migration 026
 * already carries the first two: 'failed' is the work list, and the
 * conditional UPDATE below is the exclusive take. The third is the
 * schedule itself - one bounded batch per day - which needs no column. An
 * attempts counter would be a live migration bought for nothing.
 */

/**
 * The order columns a notification is rebuilt from.
 *
 * EXPORTED for lib/annualOrderNotification.ts (Phase 4B6), which rebuilds
 * the same message for an annual delivery order from the same columns.
 * Sharing the list rather than copying it means the two cannot end up
 * reading different facts about one order.
 */
export const ORDER_COLUMNS =
  "id, order_number, currency, subtotal_gross_cents, shipping_gross_cents, total_gross_cents, shipping_address_snapshot, customer_snapshot, checkout_attempt_id, internal_notification_status";

/**
 * The work list.
 *
 * An equality filter cannot match NULL in SQL, so every order written
 * before migration 026 is invisible here by construction rather than by a
 * query being careful.
 *
 * Ordered by updated_at ascending, which for a failed row is the moment
 * it was last marked failed - public.orders has carried an updated_at
 * trigger since migration 004, so that is a real timestamp and not a
 * guess. The ordering is therefore "least recently attempted first": when
 * more rows are eligible than one batch can hold, yesterday's overflow
 * sorts ahead of the rows that were already tried, instead of the same
 * head of the queue starving everything behind it.
 */
async function loadFailedOrders(
  admin: SupabaseClient,
  limit: number
): Promise<RetryOrderRow<AddressSnapshot>[]> {
  const { data, error } = await admin
    .from("orders")
    .select(ORDER_COLUMNS)
    .eq("internal_notification_status", RETRY_ELIGIBLE_STATUS)
    .order("updated_at", { ascending: true })
    .limit(limit);

  if (error) throw new Error(`failed internal notification lookup failed: ${error.message}`);
  return (data as RetryOrderRow<AddressSnapshot>[] | null) ?? [];
}

/**
 * Takes one failed notification exclusively: 'failed' -> 'sending', in a
 * single conditional UPDATE.
 *
 * The same mechanism the webhook path uses, and for the same reason:
 * Postgres locks the row for the duration of the update, so of two
 * workers arriving together exactly one sees a row that still says
 * 'failed' and the other gets zero rows back. The condition here is
 * strictly narrower, though. The webhook may claim NULL-or-failed,
 * because a first attempt is legitimately a first attempt; this may claim
 * 'failed' and nothing else, so a historical NULL row is refused a second
 * time even if it somehow reached this call.
 *
 * A row that has since become 'sending' or 'sent' yields "taken", which
 * is a normal outcome: it means the concurrent Stripe redelivery got
 * there first, which is exactly what should happen.
 */
async function claimFailedNotification(admin: SupabaseClient, orderId: string): Promise<RetryClaimOutcome> {
  const { data, error } = await admin
    .from("orders")
    .update({ internal_notification_status: "sending" })
    .eq("id", orderId)
    .eq("internal_notification_status", RETRY_ELIGIBLE_STATUS)
    .select("id");

  if (error) {
    console.error(`Internal order notification retry: claim failed for order ${orderId}:`, error.message);
    return "error";
  }
  return (data?.length ?? 0) > 0 ? "claimed" : "taken";
}

/**
 * The frozen lines the order was built from, read back rather than
 * recomputed.
 *
 * EXPORTED for the same reason ORDER_COLUMNS is. annual_plan_id joined
 * the selection with Phase 4B6: it is what makes the source label of an
 * annual delivery order truthful on a retry, so a message retried a week
 * later still says "Jahresplan-Lieferung" rather than
 * "Einzelbestellung".
 */
export async function loadAttempt(
  admin: SupabaseClient,
  checkoutAttemptId: string
): Promise<RetryAttemptRow | null> {
  const { data, error } = await admin
    .from("checkout_attempts")
    .select("items_snapshot, subscription_id, stripe_invoice_id, annual_plan_id")
    .eq("id", checkoutAttemptId)
    .maybeSingle();

  if (error) throw new Error(`checkout attempt lookup failed: ${error.message}`);
  return (data as RetryAttemptRow | null) ?? null;
}

/**
 * One bounded pass over the failed internal notifications.
 *
 * Throws only when the sweep cannot run at all (no admin client, or the
 * work-list query itself fails). A single bad row never throws out of
 * here - see the sweep in the rules module.
 */
export async function retryFailedInternalOrderNotifications(
  limit: number = RETRY_BATCH_LIMIT
): Promise<InternalNotificationRetrySummary> {
  const admin = getSupabaseAdmin();
  if (!admin) throw new Error("supabase admin client is not configured");

  return runInternalNotificationRetrySweep<AddressSnapshot>({
    loadFailedOrders: () => loadFailedOrders(admin, limit),
    claim: orderId => claimFailedNotification(admin, orderId),
    loadAttempt: checkoutAttemptId => loadAttempt(admin, checkoutAttemptId),
    // The existing send path, unchanged and unwrapped: one recipient
    // constant, one template, one pair of state columns, shared with the
    // Stripe webhook rather than reimplemented beside it.
    deliver: deliverClaimedInternalOrderNotification,
    markFailed: markInternalNotificationFailed,
    // The order id only. A retry that failed is not a reason to put a
    // customer's name, address or email into a log line.
    logFailure: (orderId, message) =>
      console.error(`Internal order notification retry: order ${orderId} still failing:`, message),
  });
}

/**
 * The stale work list: rows still at 'sending' that nothing has touched
 * since the cutoff.
 *
 * Two equality/inequality filters and a bound, so a NULL, 'failed' or
 * 'sent' row cannot appear in it and neither can a recently claimed one.
 * Oldest first, so the longest-abandoned rows are recovered first if
 * there are ever more than one batch of them.
 */
async function loadStaleSending(
  admin: SupabaseClient,
  cutoffIso: string,
  limit: number
): Promise<StaleSendingRow[]> {
  const { data, error } = await admin
    .from("orders")
    .select("id, internal_notification_status, updated_at")
    .eq("internal_notification_status", IN_FLIGHT_STATUS)
    .lte("updated_at", cutoffIso)
    .order("updated_at", { ascending: true })
    .limit(limit);

  if (error) throw new Error(`stale notification lookup failed: ${error.message}`);
  return (data as StaleSendingRow[] | null) ?? [];
}

/**
 * Hands one genuinely stale row back to the retry sweep: 'sending' ->
 * 'failed', in a single conditional UPDATE.
 *
 * Both halves of the stale rule are re-checked AT WRITE TIME, against the
 * same cutoff the work list used. The read is therefore never trusted: if
 * the original worker was alive after all and moved the row to 'sent', to
 * 'failed', or merely touched it and refreshed updated_at, this matches
 * zero rows and changes nothing. A delivered notification cannot be
 * un-sent by this and an active claim cannot be stolen from its holder.
 *
 * Losing that race yields "skipped", which is a normal outcome, not an
 * error.
 */
async function recoverStaleSending(
  admin: SupabaseClient,
  orderId: string,
  cutoffIso: string
): Promise<StaleRecoveryOutcome> {
  const { data, error } = await admin
    .from("orders")
    .update({ internal_notification_status: RETRY_ELIGIBLE_STATUS })
    .eq("id", orderId)
    .eq("internal_notification_status", IN_FLIGHT_STATUS)
    .lte("updated_at", cutoffIso)
    .select("id");

  if (error) throw new Error(`stale notification recovery failed: ${error.message}`);
  return (data?.length ?? 0) > 0 ? "recovered" : "skipped";
}

/**
 * One bounded stale-recovery pass.
 *
 * Throws only when the sweep cannot run at all - no admin client, or the
 * work-list query itself failed. A single unrecoverable row is counted
 * and logged inside the rules, never thrown, so one bad order cannot keep
 * every other abandoned notification stuck at 'sending'.
 */
export async function recoverStaleInternalNotifications(
  now: Date = new Date(),
  limit: number = STALE_RECOVERY_BATCH_LIMIT
): Promise<StaleRecoverySummary> {
  const admin = getSupabaseAdmin();
  if (!admin) throw new Error("supabase admin client is not configured");

  const cutoffIso = staleSendingCutoff(now);

  return runStaleSendingRecovery(
    {
      loadStaleSending: cutoff => loadStaleSending(admin, cutoff, limit),
      recover: (orderId, cutoff) => recoverStaleSending(admin, orderId, cutoff),
      // The order id only. An abandoned claim is not a reason to put a
      // customer's name, address or email into a log line.
      logFailure: (orderId, message) =>
        console.error(`Internal order notification recovery: order ${orderId} could not be recovered:`, message),
    },
    cutoffIso
  );
}

/**
 * What one cron invocation does, in this order and for this reason:
 *
 *   A. return genuinely stale 'sending' rows to 'failed'
 *   B. run the existing failed-only sweep
 *
 * A before B, so a notification recovered this morning is delivered on
 * the same run rather than waiting another day. B is unchanged and
 * remains the only path that sends anything; A never builds an email and
 * never touches a provider. Both halves are separately bounded, so the
 * total work per invocation stays bounded too.
 *
 * A failure in either half propagates: a cron that could not do its work
 * must answer with an error rather than a clean-looking set of zeroes.
 */
export async function runInternalOrderNotificationCron(now: Date = new Date()): Promise<CronSweepSummary> {
  const recovery = await recoverStaleInternalNotifications(now);
  const sweep = await retryFailedInternalOrderNotifications();
  return { ...recovery, ...sweep };
}
