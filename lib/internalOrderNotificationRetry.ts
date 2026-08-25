import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseAdmin } from "./supabaseAdmin";
import {
  deliverClaimedInternalOrderNotification,
  markInternalNotificationFailed,
} from "./internalOrderNotificationEmail";
import {
  RETRY_BATCH_LIMIT,
  RETRY_ELIGIBLE_STATUS,
  runInternalNotificationRetrySweep,
  type InternalNotificationRetrySummary,
  type RetryAttemptRow,
  type RetryClaimOutcome,
  type RetryOrderRow,
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

const ORDER_COLUMNS =
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

/** The frozen lines the order was built from, read back rather than recomputed. */
async function loadAttempt(admin: SupabaseClient, checkoutAttemptId: string): Promise<RetryAttemptRow | null> {
  const { data, error } = await admin
    .from("checkout_attempts")
    .select("items_snapshot, subscription_id, stripe_invoice_id")
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
