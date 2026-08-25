import { getSupabaseAdmin } from "./supabaseAdmin";
import { getResendClient } from "./resend";
import { getCountryLabel } from "./shipping";
import { GLOA_FROM_HELLO, GLOA_INTERNAL_ORDERS } from "./emailSenders";
import type { AddressSnapshot } from "./orderAddressSnapshot";
import {
  buildInternalOrderNotificationEmail,
  type InternalOrderAddress,
  type InternalOrderItem,
  type InternalOrderNotificationOrder,
  type InternalOrderSource,
} from "./email/internalOrderNotification";

/**
 * Tells fulfillment that a paid order needs packing (Phase 1).
 *
 * Deliberately the same shape as lib/orderConfirmationEmail.ts, on its
 * own pair of columns from migration 026, because the two messages have
 * two different fates: the customer's copy can succeed while this one
 * fails, and a retry must then send only the one still owed.
 *
 * THIS THROWS ON FAILURE, and that is a deliberate correction. The first
 * version did not, on the reasoning that the order row is the record and
 * a flaky notification should not fail a settled payment. The reasoning
 * was fine and the consequence was not: not throwing let the handler
 * reach recordStripeWebhookEvent, the event became terminally processed,
 * Stripe never redelivered, and nothing else in the repository ever
 * looked at the row again. "Retryable" was true of the database column
 * and false of the system - a failed shipping instruction simply sat
 * there.
 *
 * Throwing hands the problem to the mechanism that already solves it for
 * the customer email: the webhook returns 500, the event is not recorded,
 * and Stripe's retry schedule becomes this email's retry schedule. That
 * is only safe because every step the retry repeats is idempotent -
 * markAttemptPaid, create_order_from_paid_checkout,
 * activate_subscription_from_invoice and both email claims - so a
 * redelivery cannot produce a second order, a second attempt or a second
 * copy of either message.
 *
 * It is bounded rather than infinite: Stripe eventually stops retrying.
 * 'failed' is what remains afterwards, and it is the only value a future
 * sweep may key on. That sweep does not exist yet.
 */

type ClaimResult = "claimed" | "already-sent" | "error";

/**
 * Atomically claims the right to send this order's internal
 * notification. Only one caller can win it: the UPDATE matches only a row
 * that was never attempted (NULL) or that failed, and Postgres row
 * locking serialises concurrent updates to one row, so a second
 * concurrent or redelivered webhook sees the row already moved and gets
 * zero rows back.
 *
 * NULL rather than a 'pending' default is what keeps every order written
 * before migration 026 out of this flow entirely. See the migration.
 */
async function claimInternalNotification(orderId: string): Promise<ClaimResult> {
  const admin = getSupabaseAdmin();
  if (!admin) return "error";

  const { data, error } = await admin
    .from("orders")
    .update({ internal_notification_status: "sending" })
    .eq("id", orderId)
    .or("internal_notification_status.is.null,internal_notification_status.eq.failed")
    .select("id");

  if (error) {
    console.error(`Internal order notification: claim failed for order ${orderId}:`, error.message);
    return "error";
  }
  return (data?.length ?? 0) > 0 ? "claimed" : "already-sent";
}

async function markSent(orderId: string): Promise<void> {
  const admin = getSupabaseAdmin();
  if (!admin) return;
  const { error } = await admin
    .from("orders")
    .update({ internal_notification_status: "sent", internal_notification_sent_at: new Date().toISOString() })
    .eq("id", orderId);
  if (error) console.error(`Internal order notification: mark-sent failed for order ${orderId}:`, error.message);
}

async function markFailed(orderId: string): Promise<void> {
  const admin = getSupabaseAdmin();
  if (!admin) return;
  const { error } = await admin
    .from("orders")
    .update({ internal_notification_status: "failed" })
    .eq("id", orderId);
  if (error) console.error(`Internal order notification: mark-failed failed for order ${orderId}:`, error.message);
}

function toEmailAddress(address: AddressSnapshot | null): InternalOrderAddress | null {
  if (!address) return null;
  return {
    name: address.name,
    company: address.company,
    line1: address.line1,
    line2: address.line2,
    city: address.city,
    postalCode: address.postalCode,
    state: address.state,
    // Readable country name, never the raw ISO code the database stores.
    countryLabel: address.country ? getCountryLabel(address.country) : null,
  };
}

export type OrderForInternalNotification = {
  id: string;
  order_number: string;
  currency: string;
  subtotal_gross_cents: number;
  shipping_gross_cents: number | null;
  total_gross_cents: number;
  shipping_address_snapshot: AddressSnapshot | null;
};

export type SendInternalOrderNotificationParams = {
  order: OrderForInternalNotification;
  items: InternalOrderItem[];
  customerEmail: string | null;
  customerName: string | null;
  /** Derived from persisted data, never guessed. */
  source: InternalOrderSource;
  /** Only for a subscription cycle; null for a one-off order. */
  stripeInvoiceId?: string | null;
};

/**
 * Sends the internal notification at most once per order.
 *
 * Throws on a genuine send failure so the caller can propagate it into
 * the Stripe webhook's existing error path, which returns 500 and leaves
 * the event unrecorded - see the note at the top of this file. Never
 * throws for "already sent": that is success, not failure.
 */
export async function sendInternalOrderNotificationIfNeeded(
  params: SendInternalOrderNotificationParams
): Promise<void> {
  const { order, items, customerEmail, customerName, source } = params;

  const claim = await claimInternalNotification(order.id);
  if (claim === "already-sent") return;
  if (claim === "error") {
    throw new Error(`could not claim internal notification state for order ${order.id}`);
  }

  const resend = getResendClient();
  if (!resend) {
    console.error("Internal order notification: RESEND_API_KEY is not configured.");
    await markFailed(order.id);
    throw new Error("email provider not configured");
  }

  const emailOrder: InternalOrderNotificationOrder = {
    order_number: order.order_number,
    currency: order.currency,
    subtotal_gross_cents: order.subtotal_gross_cents,
    shipping_gross_cents: order.shipping_gross_cents,
    total_gross_cents: order.total_gross_cents,
    shippingAddress: toEmailAddress(order.shipping_address_snapshot),
    customerEmail,
    customerName,
    source,
    stripeInvoiceId: params.stripeInvoiceId ?? null,
  };

  const { subject, html, text } = buildInternalOrderNotificationEmail({ order: emailOrder, items });

  let sendErrorMessage: string | null = null;
  try {
    const { error } = await resend.emails.send({
      from: GLOA_FROM_HELLO,
      to: GLOA_INTERNAL_ORDERS,
      subject,
      html,
      text,
    });
    if (error) sendErrorMessage = error.message;
  } catch (err) {
    sendErrorMessage = err instanceof Error ? err.message : "unknown error";
  }

  if (sendErrorMessage) {
    // The order id only. A failed notification is not a reason to put a
    // customer's address or email into a log line.
    console.error(`Internal order notification: send failed for order ${order.id}:`, sendErrorMessage);
    await markFailed(order.id);
    throw new Error(`internal order notification send failed for order ${order.id}`);
  }

  await markSent(order.id);
}
