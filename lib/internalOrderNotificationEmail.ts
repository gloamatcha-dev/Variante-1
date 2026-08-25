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
 * One difference, and it is the important one. The customer confirmation
 * throws on a send failure so the Stripe webhook returns 500 and Stripe's
 * own retry schedule becomes the email's retry schedule. This one does
 * NOT throw. An internal notification is operationally useful but it is
 * not the record: the order row is, and it already exists and is already
 * correct by the time this runs. Letting a flaky notification turn a
 * settled payment into a repeatedly failing webhook would trade a small
 * problem for a larger one. A failure is recorded as 'failed', which is
 * what makes it visible and sweepable later, and the caller carries on.
 */

type ClaimResult = "claimed" | "already-sent" | "error";

/**
 * Atomically claims the right to send this order's internal
 * notification. Only one caller can win it: the UPDATE matches only
 * 'pending'/'failed', and Postgres row locking serialises concurrent
 * updates to one row, so a second concurrent or redelivered webhook sees
 * the row already moved and gets zero rows back.
 */
async function claimInternalNotification(orderId: string): Promise<ClaimResult> {
  const admin = getSupabaseAdmin();
  if (!admin) return "error";

  const { data, error } = await admin
    .from("orders")
    .update({ internal_notification_status: "sending" })
    .eq("id", orderId)
    .in("internal_notification_status", ["pending", "failed"])
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
 * Never throws. Returns quietly on every failure path, having recorded
 * 'failed' where it could, so the caller's payment and order handling is
 * never affected by an email problem.
 */
export async function sendInternalOrderNotificationIfNeeded(
  params: SendInternalOrderNotificationParams
): Promise<void> {
  const { order, items, customerEmail, customerName, source } = params;

  const claim = await claimInternalNotification(order.id);
  if (claim === "already-sent") return;
  if (claim === "error") {
    console.error(`Internal order notification: could not claim state for order ${order.id}, skipping.`);
    return;
  }

  const resend = getResendClient();
  if (!resend) {
    console.error("Internal order notification: RESEND_API_KEY is not configured.");
    await markFailed(order.id);
    return;
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
    return;
  }

  await markSent(order.id);
}
