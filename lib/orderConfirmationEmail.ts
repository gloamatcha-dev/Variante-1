import { getSupabaseAdmin } from "./supabaseAdmin";
import { getResendClient } from "./resend";
import { getCountryLabel } from "./shipping";
import { getSiteOrigin } from "./siteUrl";
import type { AddressSnapshot } from "./orderAddressSnapshot";
import {
  buildOrderConfirmationEmail,
  type OrderConfirmationOrder,
  type OrderConfirmationAddress,
  type OrderConfirmationItem,
} from "./email/orderConfirmation";

type ClaimResult = "claimed" | "already-sent" | "error";

/**
 * Atomically claims the right to send this order's confirmation email.
 * Only one caller can ever win this for a given order: the UPDATE's
 * WHERE clause only matches 'pending'/'failed', and Postgres row
 * locking serializes concurrent UPDATEs to the same row, so a second
 * concurrent (or later, redelivered-webhook) caller sees the row
 * already moved to 'sending'/'sent' and gets zero rows back. This is
 * the same idempotent-guard pattern already used for checkout_attempts
 * elsewhere in this codebase, applied to email delivery state instead
 * of order identity.
 */
async function claimOrderConfirmationEmail(orderId: string): Promise<ClaimResult> {
  const admin = getSupabaseAdmin();
  if (!admin) return "error";

  const { data, error } = await admin
    .from("orders")
    .update({ confirmation_email_status: "sending" })
    .eq("id", orderId)
    .in("confirmation_email_status", ["pending", "failed"])
    .select("id");

  if (error) {
    console.error(`Order confirmation email: claim failed for order ${orderId}:`, error.message);
    return "error";
  }
  return (data?.length ?? 0) > 0 ? "claimed" : "already-sent";
}

async function markConfirmationEmailSent(orderId: string): Promise<void> {
  const admin = getSupabaseAdmin();
  if (!admin) return;
  const { error } = await admin
    .from("orders")
    .update({ confirmation_email_status: "sent", confirmation_email_sent_at: new Date().toISOString() })
    .eq("id", orderId);
  if (error) console.error(`Order confirmation email: mark-sent failed for order ${orderId}:`, error.message);
}

async function markConfirmationEmailFailed(orderId: string): Promise<void> {
  const admin = getSupabaseAdmin();
  if (!admin) return;
  const { error } = await admin
    .from("orders")
    .update({ confirmation_email_status: "failed" })
    .eq("id", orderId);
  if (error) console.error(`Order confirmation email: mark-failed failed for order ${orderId}:`, error.message);
}

function toEmailAddress(address: AddressSnapshot | null): OrderConfirmationAddress | null {
  if (!address) return null;
  return {
    name: address.name,
    company: address.company,
    line1: address.line1,
    line2: address.line2,
    city: address.city,
    postalCode: address.postalCode,
    state: address.state,
    // Customer-facing display always uses the full country name, never
    // the raw ISO code Stripe/the DB store internally.
    countryLabel: address.country ? getCountryLabel(address.country) : null,
  };
}

function buildAccountOrderUrl(orderId: string, userId: string | null): string | null {
  if (!userId) return null; // guest order - no account to show it in
  const origin = getSiteOrigin();
  if (!origin) return null;
  return `${origin}/account/orders/${orderId}`;
}

export type OrderForConfirmationEmail = {
  id: string;
  order_number: string;
  user_id: string | null;
  subtotal_gross_cents: number;
  shipping_gross_cents: number | null;
  total_gross_cents: number;
  shipping_address_snapshot: AddressSnapshot | null;
};

export type SendOrderConfirmationEmailParams = {
  order: OrderForConfirmationEmail;
  items: OrderConfirmationItem[];
  customerEmail: string | null;
};

/**
 * Sends the paid-order confirmation email at most once per order, no
 * matter how many times this is called - a redelivered Stripe webhook,
 * a manually-resent event with a different event id, or two truly
 * concurrent deliveries all converge on exactly one send.
 *
 * Throws on a genuine send failure (provider not configured, or Resend
 * rejects/errors) so the caller can propagate that into the Stripe
 * webhook handler's existing error path, which returns 500 and never
 * records the event as processed - Stripe's own retry schedule then
 * naturally retries the whole delivery later, which is idempotent for
 * every part of this flow, and gives the email another chance without
 * building a second, bespoke retry system. Never throws for "already
 * sent" - that is success, not failure. A missing customer email is
 * also not treated as a failure: there is nothing retryable about it.
 */
export async function sendOrderConfirmationEmailIfNeeded(params: SendOrderConfirmationEmailParams): Promise<void> {
  const { order, items, customerEmail } = params;

  if (!customerEmail) {
    console.error(`Order confirmation email: order ${order.id} has no verified customer email, skipping.`);
    return;
  }

  const claim = await claimOrderConfirmationEmail(order.id);
  if (claim === "already-sent") return;
  if (claim === "error") throw new Error(`could not claim confirmation email state for order ${order.id}`);

  const resend = getResendClient();
  const fromAddress = process.env.RESEND_CONTACT_FROM;
  if (!resend || !fromAddress) {
    console.error("Order confirmation email error: RESEND_API_KEY or RESEND_CONTACT_FROM is not configured.");
    await markConfirmationEmailFailed(order.id);
    throw new Error("email provider not configured");
  }

  const emailOrder: OrderConfirmationOrder = {
    order_number: order.order_number,
    subtotal_gross_cents: order.subtotal_gross_cents,
    shipping_gross_cents: order.shipping_gross_cents,
    total_gross_cents: order.total_gross_cents,
    shippingAddress: toEmailAddress(order.shipping_address_snapshot),
    accountOrderUrl: buildAccountOrderUrl(order.id, order.user_id),
  };
  const { subject, html, text } = buildOrderConfirmationEmail({ order: emailOrder, items, customerEmail });

  let sendErrorMessage: string | null = null;
  try {
    const { error } = await resend.emails.send({
      from: fromAddress,
      to: customerEmail,
      replyTo: "info@gloamatcha.com",
      subject,
      html,
      text,
    });
    if (error) sendErrorMessage = error.message;
  } catch (err) {
    sendErrorMessage = err instanceof Error ? err.message : "unknown error";
  }

  if (sendErrorMessage) {
    console.error(`Order confirmation email: send failed for order ${order.id}:`, sendErrorMessage);
    await markConfirmationEmailFailed(order.id);
    throw new Error(`order confirmation email send failed for order ${order.id}`);
  }

  await markConfirmationEmailSent(order.id);
}
