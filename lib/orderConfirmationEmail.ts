import { getSupabaseAdmin } from "./supabaseAdmin";
import { getResendClient } from "./resend";
import { getCountryLabel } from "./shipping";
import { getSiteOrigin } from "./siteUrl";
import { GLOA_FROM_HELLO, GLOA_REPLY_TO_SUPPORT } from "./emailSenders";
import {
  deriveGuestOrderToken,
  hashGuestOrderToken,
  getGuestOrderTokenSecret,
  buildGuestOrderManageUrl,
} from "./guestOrderAccess";
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

/**
 * THE SECURE ORDER MANAGEMENT LINK, AND THE ROW THAT MAKES IT WORK.
 *
 * A guest could place a one-time order and then had nowhere to manage it:
 * the cancellation request is reachable only from /account/orders/<id>,
 * and migration 019's function refuses a NULL user id by design. So the
 * one thing a guest was promised - "melde uns per E-Mail" - was the only
 * route, and the system could not see it.
 *
 * This resolves that link, and it is deliberately the ONLY place in the
 * codebase that mints one. Two steps, in this order:
 *
 *   1. DERIVE. Pure HMAC over the order id (lib/guestOrderAccess.ts).
 *      Deriving rather than drawing a random value is what makes a
 *      redelivered webhook produce the SAME token: the mail is rebuilt
 *      from scratch on every retry, and a random token would have to be
 *      stored in plaintext to survive that.
 *   2. ATTACH. Hand the DIGEST to the database, which is the only form
 *      of the token that is ever written down. Idempotent by value:
 *      a redelivery hands over the same digest and gets 'unchanged', so
 *      no second token and no second row can exist for an order.
 *
 * ── IT FAILS OPEN ON THE LINK AND CLOSED ON ACCESS ────────────
 *
 * Every failure here - no secret configured, no admin client, an RPC
 * error, an order that has vanished - returns null, and the mail is then
 * built and sent WITHOUT the CTA. A customer's paid-order confirmation is
 * never withheld over a link, and nothing is thrown into the webhook's
 * error path, because the order is already paid and created by now.
 *
 * Closed on access, because the two are the same condition: no digest
 * stored means no token can ever resolve that order. There is no state in
 * which a link exists but is unverifiable, and none in which a token
 * works without a row.
 *
 * ── AND IT IS SENT TO ACCOUNT CUSTOMERS TOO ───────────────────
 *
 * Gated on nothing. One mail architecture rather than two, so the guest
 * path is not a second, less-tested template - and a signed-in customer
 * reading the mail on a phone they are not logged in on can still get to
 * their order. It adds no privilege: the link resolves that one order,
 * which is an order they already own, and their account page remains the
 * primary place they manage it.
 */
async function buildGuestManageUrl(orderId: string): Promise<string | null> {
  const origin = getSiteOrigin();
  if (!origin) return null;

  const secret = getGuestOrderTokenSecret();
  if (!secret) {
    // Not an error: a deployment with no usable secret simply has no
    // links. Named so it is visible in a log, without the order or a
    // token in the line.
    console.error("Order confirmation email: no guest order token secret configured, management link omitted.");
    return null;
  }

  const token = deriveGuestOrderToken(orderId, secret);
  if (!token) return null;

  const admin = getSupabaseAdmin();
  if (!admin) return null;

  // The digest, never the token. attach_guest_order_manage_token is the
  // only writer of public.order_guest_access and the table is granted to
  // no role at all, so this RPC is the single path by which a credential
  // can come into existence.
  const { data, error } = await admin.rpc("attach_guest_order_manage_token", {
    p_order_id: orderId,
    p_token_hash: hashGuestOrderToken(token),
  });

  if (error) {
    console.error(`Order confirmation email: could not attach the management token for order ${orderId}:`, error.message);
    return null;
  }

  // 'attached' first time, 'unchanged' on every redelivery of the same
  // secret, 'rotated' after the secret was rotated. All three mean the
  // digest in the database now matches the token in this mail.
  if (data !== "attached" && data !== "unchanged" && data !== "rotated") {
    console.error(`Order confirmation email: management token not attached for order ${orderId} (${String(data)}).`);
    return null;
  }

  return buildGuestOrderManageUrl(origin, token);
}

export type OrderForConfirmationEmail = {
  id: string;
  order_number: string;
  user_id: string | null;
  subtotal_gross_cents: number;
  discount_total_cents: number;
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
  if (!resend) {
    console.error("Order confirmation email error: RESEND_API_KEY is not configured.");
    await markConfirmationEmailFailed(order.id);
    throw new Error("email provider not configured");
  }

  const emailOrder: OrderConfirmationOrder = {
    order_number: order.order_number,
    subtotal_gross_cents: order.subtotal_gross_cents,
    discount_total_cents: order.discount_total_cents,
    shipping_gross_cents: order.shipping_gross_cents,
    total_gross_cents: order.total_gross_cents,
    shippingAddress: toEmailAddress(order.shipping_address_snapshot),
    accountOrderUrl: buildAccountOrderUrl(order.id, order.user_id),
    // Resolved AFTER the claim above, so an already-sent order does no
    // work here, and BEFORE the mail is built, so the link and the row
    // that makes it resolve are created in the same breath. Null omits
    // the CTA and never blocks the send - see buildGuestManageUrl.
    guestManageUrl: await buildGuestManageUrl(order.id),
  };
  const { subject, html, text } = buildOrderConfirmationEmail({ origin: getSiteOrigin() ?? undefined, order: emailOrder, items, customerEmail });

  let sendErrorMessage: string | null = null;
  try {
    const { error } = await resend.emails.send({
      // Canonical sender, not RESEND_CONTACT_FROM. That variable gates the
      // contact form, where an unset value fails one form; here an unset
      // value threw and turned every paid-order webhook into a repeating
      // 500. The footer still points customers at the published info@
      // address from the Impressum; Reply-To is the order desk.
      from: GLOA_FROM_HELLO,
      to: customerEmail,
      replyTo: GLOA_REPLY_TO_SUPPORT,
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
