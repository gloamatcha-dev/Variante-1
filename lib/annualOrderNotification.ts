import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseAdmin } from "./supabaseAdmin";
import { sendInternalOrderNotificationIfNeeded } from "./internalOrderNotificationEmail";
// THE EXISTING ORDER-NOTIFICATION MACHINERY, REUSED WHOLE. The column
// list, the attempt lookup and the rebuild are the generic retry's, and
// they are imported rather than copied so an annual delivery order and a
// one-time order can never be described from different facts.
import { ORDER_COLUMNS, loadAttempt } from "./internalOrderNotificationRetry";
import {
  buildRetryNotificationParams,
  type RetryOrderRow,
} from "./internalOrderNotificationRetryRules";
import {
  ANNUAL_ORDER_NOTIFICATION_RECOVERY_LIMIT,
  runAnnualOrderNotificationRecovery,
  type AnnualOrderNotificationRecoveryRow,
  type AnnualOrderNotificationRecoverySummary,
} from "./annualOrderNotificationRules";
import type { AddressSnapshot } from "./orderAddressSnapshot";

/**
 * What an ANNUAL DELIVERY ORDER receives after migration 039 mints it
 * (Phase 4B6).
 *
 * ── THE AUDIT THIS FILE EXISTS BECAUSE OF ─────────────────────
 *
 * fulfill_annual_plan_delivery creates a perfectly ordinary
 * public.orders row through create_order_from_paid_checkout - and the
 * database sends no email, so on its own an annual delivery would be a
 * paid, packable order that nobody was ever told about.
 *
 * An ordinary paid order gets TWO messages in this repository:
 *
 *   A. the customer's "Danke für deine Bestellung / Zahlung bestätigt"
 *      confirmation                       lib/orderConfirmationEmail.ts
 *   B. the internal "pack this" notification
 *                            lib/internalOrderNotificationEmail.ts
 *
 * AN ANNUAL DELIVERY GETS B AND DELIBERATELY NOT A, and that is the same
 * answer the subscription cycle already reached (see handleInvoicePaid in
 * app/api/stripe/webhook/route.ts). A is a message about a PAYMENT: it
 * says "Zahlung bestätigt" and thanks the customer for an order they just
 * placed. Delivery 7 of a prepaid annual plan involves no payment, no
 * order placed today and no money moving; sending it thirteen times would
 * tell one customer they had bought thirteen times. The customer-facing
 * message this contract does owe was sent once, at purchase, by
 * lib/annualPurchaseConfirmationEmail.ts, and it already names all
 * thirteen dates.
 *
 * B has no such problem and is not optional: fulfillment has to learn
 * that a box is owed, and the label the template prints for source
 * 'annual' says exactly why it is owed.
 *
 * Leaving A at its 'pending' default is the established outcome for an
 * order that is not owed a payment confirmation - every subscription
 * cycle order sits there - and 'pending' is invisible to every sweep in
 * the system, all of which select 'failed'.
 *
 * ── NO SHIPMENT CONFIRMATION HERE ─────────────────────────────
 *
 * An order existing is not a shipment. lib/shipmentConfirmationEmail.ts
 * belongs to the fulfillment-status transition that happens when someone
 * actually ships the box, and nothing in this file may anticipate it.
 */

function requireAdmin(): SupabaseClient {
  const admin = getSupabaseAdmin();
  if (!admin) throw new Error("supabase admin client is not configured");
  return admin;
}

/** One order, by id, in exactly the columns the notification is rebuilt from. */
async function loadOrder(
  admin: SupabaseClient,
  orderId: string
): Promise<RetryOrderRow<AddressSnapshot> | null> {
  const { data, error } = await admin
    .from("orders")
    .select(ORDER_COLUMNS)
    .eq("id", orderId)
    .maybeSingle();

  if (error) throw new Error(`annual delivery order lookup failed: ${error.message}`);
  return (data as RetryOrderRow<AddressSnapshot> | null) ?? null;
}

/**
 * Tells fulfillment about ONE annual delivery order.
 *
 * This is the function the shared delivery worker's notifyOrder port is
 * bound to, so Delivery 1 (from the payment webhook) and Deliveries 2 to
 * 13 (from the daily maintenance job) reach it by the same route.
 *
 * IT BRINGS NO IDEMPOTENCY OF ITS OWN, and must not. The duplicate guard
 * is the order's existing internal_notification_status claim plus the
 * deterministic provider key derived from the order id - the same pair
 * that already survives a Stripe redelivery. The annual delivery id is
 * deliberately not used as a substitute: the order owns this message.
 *
 * THROWS on a genuine failure, so the caller counts it and the row is
 * left in a state a later run can act on: the send path writes 'failed'
 * before it throws, which is precisely the generic daily sweep's work
 * list.
 */
export async function notifyAnnualDeliveryOrder(orderId: string): Promise<void> {
  const admin = requireAdmin();

  const order = await loadOrder(admin, orderId);
  if (!order) throw new Error(`annual delivery order ${orderId} not found`);

  const attempt = order.checkout_attempt_id
    ? await loadAttempt(admin, order.checkout_attempt_id)
    : null;

  // The rebuild refuses rather than improvises: no attempt, or no frozen
  // lines, and it throws instead of telling fulfillment to pack nothing.
  await sendInternalOrderNotificationIfNeeded(buildRetryNotificationParams(order, attempt));
}

/**
 * The work list for the crash window: annual delivery orders whose
 * internal notification was NEVER ATTEMPTED.
 *
 * ── THE JOIN IS THE SAFETY PROPERTY ───────────────────────────
 *
 * annual_plan_deliveries!inner is not a convenience. It is what makes
 * this query incapable of returning an order that is not an annual
 * delivery: PostgREST resolves it through the FK
 * annual_plan_deliveries.order_id -> orders.id, and an inner join drops
 * every order with no delivery row behind it. The historical orders whose
 * email columns are NULL because the feature post-dates them have no such
 * row and cannot appear, which is the entire reason this may filter on
 * NULL at all.
 *
 * Oldest first - on created_at, which migration 004 makes NOT NULL with a
 * default, so every row genuinely has one and a long-owed order sorts
 * ahead of today's. Bounded, so a backlog cannot turn one invocation into
 * an unbounded job.
 */
async function loadAnnualOrdersMissingNotification(
  admin: SupabaseClient,
  limit: number
): Promise<AnnualOrderNotificationRecoveryRow[]> {
  const { data, error } = await admin
    .from("orders")
    .select("id, internal_notification_status, annual_plan_deliveries!inner(id)")
    .is("internal_notification_status", null)
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error) throw new Error(`annual order notification lookup failed: ${error.message}`);
  return (data as AnnualOrderNotificationRecoveryRow[] | null) ?? [];
}

/**
 * One bounded recovery pass (Phase 4B6).
 *
 * Every decision - which rows are eligible, what happens when one fails,
 * where the loop stops - lives in lib/annualOrderNotificationRules.ts and
 * is unit-tested there. This is the half that cannot be: one query and
 * the existing send path.
 */
export async function recoverAnnualOrderNotifications(
  limit: number = ANNUAL_ORDER_NOTIFICATION_RECOVERY_LIMIT
): Promise<AnnualOrderNotificationRecoverySummary> {
  const admin = requireAdmin();

  return runAnnualOrderNotificationRecovery({
    loadCandidates: () => loadAnnualOrdersMissingNotification(admin, limit),
    notify: notifyAnnualDeliveryOrder,
    // The order id only. Never a recipient, an address or an amount.
    logFailure: (orderId, message) =>
      console.error(`Annual order notification recovery: order ${orderId} still owed:`, message),
  });
}
