import { getSupabaseAdmin } from "./supabaseAdmin";
import { getResendClient } from "./resend";
import { getCountryLabel } from "./shipping";
import { getSiteOrigin } from "./siteUrl";
import { sanitizeTrackingUrl } from "./orderStatus";
import { GLOA_FROM_HELLO, GLOA_REPLY_TO_SUPPORT } from "./emailSenders";
import type { AddressSnapshot } from "./orderAddressSnapshot";
import {
  buildShipmentConfirmationEmail,
  shipmentConfirmationIdempotencyKey,
  type ShipmentAddress,
  type ShipmentConfirmationOrder,
} from "./email/shipmentConfirmation";
import {
  runShipmentConfirmation,
  selectShipmentTracking,
  type ShipmentClaimOutcome,
  type ShipmentConfirmationPort,
  type ShipmentOrderRow,
  type ShipmentSendOutcome,
} from "./shipmentConfirmationRules";

/**
 * Gives the shipment confirmation rules a database and a mail provider,
 * and nothing else.
 *
 * The same shape as lib/orderConfirmationEmail.ts and
 * lib/internalOrderNotificationEmail.ts, on its own pair of columns from
 * migration 027, because it is a third message with a third fate: the
 * customer's order confirmation and the internal fulfillment
 * notification are both about a PAYMENT and both happen at checkout
 * time; this one is about a PARCEL and happens whenever the parcel
 * actually leaves. One shared status could not express that.
 *
 * ══════════════════════════════════════════════════════════════
 * TECHNISCH VORBEREITET - NOTHING IN THE APPLICATION CALLS THIS.
 * ══════════════════════════════════════════════════════════════
 *
 * That is not an oversight, it is the finding. There is no server-side
 * shipping transition in this repository: no route, no webhook branch, no
 * cron and no RPC can move an order into 'shipped'. Migration 019 built
 * the tracking columns for the owner to write by hand and deliberately
 * withheld write access to them from service_role - "the website only
 * ever reads them". Until a real, authorized shipment action exists there
 * is no honest moment at which this email may fire, and manufacturing one
 * would mean inventing an admin workflow that the product does not have.
 *
 * WHAT WAS DELIBERATELY NOT BUILT, because each would be a way of
 * pretending the blocker is not there:
 *
 *   * no "mark this order shipped" endpoint, public or otherwise. The
 *     shipment transition has to be authorized before it can be trusted,
 *     and this repository has no admin authentication surface to
 *     authorize it against.
 *   * no customer-reachable trigger of any kind. A customer must never be
 *     able to mark their own order shipped, nor to cause the shop to tell
 *     them it shipped.
 *   * no trigger from any payment event. checkout.session.completed,
 *     payment_intent success and invoice.paid are payment facts, and a
 *     paid order is not a posted one.
 *   * no sweep, and no addition to the daily cron. A sweep is what would
 *     make this reachable, and reachable-without-a-shipment-action is
 *     exactly the thing that must not happen. See "WHY THERE IS NO
 *     SWEEP" below.
 *
 * WHAT IT MAY DO WHEN IT IS EVENTUALLY CALLED. Send one email to the
 * address on the order and write shipment_email_status /
 * shipment_email_sent_at. That is the entire blast radius: migration
 * 027's grant is column-scoped exactly as 017's and 026's are, so a bug
 * here cannot reach fulfillment_status, a money column, or the tracking
 * columns it reads. No order is created, no payment state moves, no other
 * email is sent, no subscription is touched, and nothing is re-priced.
 *
 * SUBSCRIPTIONS. Nothing here knows or cares how the order came to exist.
 * A subscription cycle's fulfillment order is a real order in
 * public.orders with the same shipment columns, so once it genuinely
 * ships it becomes eligible through this identical path, with its own
 * per-order idempotency key. That is why the entry point below takes an
 * order id and not a checkout attempt, a subscription or an invoice. No
 * subscription LIFECYCLE mail - started, renewed, payment failed,
 * cancelled - is built here, and B2C_SUBSCRIPTIONS_ENABLED is untouched.
 */

/** The columns one shipment confirmation is rebuilt from. */
const ORDER_COLUMNS =
  "id, order_number, user_id, fulfillment_status, shipped_at, " +
  "shipping_carrier, tracking_number, tracking_url, " +
  "shipping_address_snapshot, customer_snapshot, shipment_email_status";

type OrderRow = ShipmentOrderRow<AddressSnapshot>;

/**
 * Atomically claims the right to send this order's shipment
 * confirmation.
 *
 * Only one caller can win it. The UPDATE matches only a row that was
 * never attempted (NULL) or that failed, and Postgres row locking
 * serialises concurrent updates to one row, so a second concurrent
 * worker sees the row already moved to 'sending' and gets zero rows back.
 * Identical to the guard lib/internalOrderNotificationEmail.ts uses, on
 * migration 027's columns.
 *
 * IT ALSO RE-CHECKS THE SHIPMENT ITSELF, in the same statement. The
 * caller has already read the row and found it shipped, but a read is
 * never trusted: making 'shipped' part of the WHERE clause means the
 * order cannot lose that state between the read and the claim and still
 * produce an email. It is the same defence in depth the eligibility
 * predicate applies in code - two independent refusals of an unshipped
 * order, so no single mistake can tell a customer their parcel is on its
 * way when it is not.
 */
async function claimShipmentConfirmation(orderId: string): Promise<ShipmentClaimOutcome> {
  const admin = getSupabaseAdmin();
  if (!admin) return "error";

  const { data, error } = await admin
    .from("orders")
    .update({ shipment_email_status: "sending" })
    .eq("id", orderId)
    .in("fulfillment_status", ["shipped", "delivered"])
    .not("shipped_at", "is", null)
    .or("shipment_email_status.is.null,shipment_email_status.eq.failed")
    .select("id");

  if (error) {
    console.error(`Shipment confirmation: claim failed for order ${orderId}:`, error.message);
    return "error";
  }
  return (data?.length ?? 0) > 0 ? "claimed" : "taken";
}

async function markShipmentEmailSent(orderId: string): Promise<void> {
  const admin = getSupabaseAdmin();
  if (!admin) return;
  const { error } = await admin
    .from("orders")
    .update({ shipment_email_status: "sent", shipment_email_sent_at: new Date().toISOString() })
    .eq("id", orderId);
  if (error) console.error(`Shipment confirmation: mark-sent failed for order ${orderId}:`, error.message);
}

/**
 * Returns a claimed confirmation to 'failed' - the one state a future
 * retry may key on.
 *
 * CONDITIONAL ON STILL BEING 'sending', for the same reason
 * markInternalNotificationFailed is: writing 'failed' over any other
 * state is never correct, and writing it over a 'sent' row would invite
 * the very duplicate this whole mechanism exists to prevent.
 *
 * THIS NEVER TOUCHES fulfillment_status, shipped_at OR ANY TRACKING
 * COLUMN, and it must never learn to. An email that failed to send is a
 * fact about an email. The parcel is still gone, the order is still
 * shipped, and un-shipping an order because a mail provider had a bad
 * minute would corrupt the business record to tidy up a notification.
 * Migration 027's column-scoped grant enforces this at the database, so
 * the property does not depend on this comment being read.
 */
async function markShipmentEmailFailed(orderId: string): Promise<void> {
  const admin = getSupabaseAdmin();
  if (!admin) return;
  const { error } = await admin
    .from("orders")
    .update({ shipment_email_status: "failed" })
    .eq("id", orderId)
    .eq("shipment_email_status", "sending");
  if (error) console.error(`Shipment confirmation: mark-failed failed for order ${orderId}:`, error.message);
}

function toEmailAddress(address: AddressSnapshot | null): ShipmentAddress | null {
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

function buildAccountOrderUrl(orderId: string, userId: string | null): string | null {
  if (!userId) return null; // guest order - no account to show it in
  const origin = getSiteOrigin();
  if (!origin) return null;
  return `${origin}/account/orders/${orderId}`;
}

/**
 * The recipient, taken from the order's own frozen customer_snapshot.
 *
 * Not a parameter, deliberately. There is no argument anywhere in this
 * module by which a caller could choose who receives a shipment
 * confirmation: the address is a property of the durable order, read back
 * from the database at send time, and an order whose snapshot holds no
 * usable address simply cannot be confirmed. That removes arbitrary-
 * recipient as a category of bug rather than guarding against it.
 */
function recipientFromSnapshot(snapshot: unknown): string | null {
  const customer = (snapshot ?? {}) as { email?: unknown };
  if (typeof customer.email !== "string") return null;
  const trimmed = customer.email.trim();
  return trimmed ? trimmed : null;
}

/**
 * Sends the shipment confirmation for one order at most once, if and only
 * if the durable order genuinely says it shipped.
 *
 * TAKES AN ORDER ID AND NOTHING ELSE. No recipient, no tracking number,
 * no carrier, no subject, no body, no "force" flag. Everything the email
 * says is read back from the order row inside this function, so a caller
 * cannot supply content, cannot redirect the message, and cannot assert a
 * shipment that the database does not already record. A browser-supplied
 * shipped=true or a browser-supplied tracking number has nowhere to enter.
 *
 * It never throws for an ordinary outcome. Unlike the internal
 * notification - which throws so that a failed send becomes a Stripe
 * webhook 500 and inherits Stripe's redelivery schedule - a shipment
 * confirmation has no webhook behind it to retry it. Its eventual caller
 * will be a shipment action, and failing that action because a mail
 * provider was down would be exactly the coupling section 12 forbids: the
 * shipment must stay shipped. So the outcome is returned, the durable
 * state records it, and the parcel is unaffected either way.
 */
export async function sendShipmentConfirmationIfNeeded(orderId: string): Promise<ShipmentSendOutcome> {
  const admin = getSupabaseAdmin();
  if (!admin) {
    console.error("Shipment confirmation: SUPABASE_SECRET_KEY is not configured.");
    return "failed";
  }

  const { data, error } = await admin
    .from("orders")
    .select(ORDER_COLUMNS)
    .eq("id", orderId)
    .maybeSingle();

  if (error) {
    console.error(`Shipment confirmation: load failed for order ${orderId}:`, error.message);
    return "failed";
  }
  // A missing order is not an error worth a stack trace, and it must not
  // be distinguishable from an ineligible one to anything upstream.
  if (!data) return "not-eligible";

  const order = data as unknown as OrderRow;

  // Every decision from here on is made by the rules module. This
  // function's remaining job is to be the port.
  return runShipmentConfirmation(shipmentConfirmationPort, order);
}

/**
 * The database and the mail provider, as the rules module's port.
 *
 * A module-level constant rather than something a caller passes in:
 * there must be no seam through which a call site could substitute its
 * own recipient, its own claim or its own idea of what "sent" means.
 */
const shipmentConfirmationPort: ShipmentConfirmationPort<AddressSnapshot> = {
  claim: claimShipmentConfirmation,
  deliver: deliverClaimedShipmentConfirmation,
  markSent: markShipmentEmailSent,
  markFailed: markShipmentEmailFailed,
  logFailure: (orderId, message) => {
    // The order id and the provider's message. Never the recipient, the
    // name, the address or the tracking number.
    console.error(`Shipment confirmation: send failed for order ${orderId}:`, message);
  },
};

/**
 * Renders and sends a confirmation whose claim has ALREADY been won.
 *
 * THROWS on a genuine send failure and writes no state itself: the rules
 * module owns the outcome, calls markFailed, and returns "failed". Two
 * writers of that column would be one too many - it is what let the
 * internal notification's mark-failed need a conditional guard.
 *
 * It must only ever be called by a caller holding a won claim. It does
 * not re-check the state, because by this point the row says 'sending'
 * and re-reading it would only re-derive what the claim atomically
 * established.
 *
 * Exported so that a retry sweep, should one ever be built, reuses this
 * exact send rather than growing a second copy for the recipient, the
 * template and the state machine to drift apart in. Such a sweep must
 * bring its own, stricter claim - 'failed' only, never NULL. See the note
 * at the foot of this file.
 */
export async function deliverClaimedShipmentConfirmation(order: OrderRow): Promise<void> {
  const customerEmail = recipientFromSnapshot(order.customer_snapshot);
  if (!customerEmail) {
    // Order id only. A missing address is not a reason to log whatever
    // the snapshot did contain.
    throw new Error(`order ${order.id} has no customer email to send to`);
  }

  const resend = getResendClient();
  if (!resend) throw new Error("email provider not configured");

  const emailOrder: ShipmentConfirmationOrder = {
    order_number: order.order_number,
    shippingAddress: toEmailAddress(order.shipping_address_snapshot),
    // Only what the owner actually stored. sanitizeTrackingUrl is the
    // render-time half of migration 019's CHECK constraint, so a row
    // written before that constraint existed still cannot put a
    // javascript: or data: URL into a customer's inbox. A carrier is
    // never inferred from a number and a URL is never assembled from a
    // carrier.
    tracking: selectShipmentTracking(
      order.shipping_carrier,
      order.tracking_number,
      sanitizeTrackingUrl(order.tracking_url)
    ),
    accountOrderUrl: buildAccountOrderUrl(order.id, order.user_id),
  };

  const { subject, html, text } = buildShipmentConfirmationEmail({ order: emailOrder, customerEmail });

  // The provider-side half of the duplicate guard. The database claim
  // stops two workers from both starting a send; this stops an attempt
  // that reached Resend but lost its state write from becoming a second
  // email. Same order, same key, on every attempt from every path.
  const idempotencyKey = shipmentConfirmationIdempotencyKey(order.id);

  let sendErrorMessage: string | null = null;
  try {
    const { error } = await resend.emails.send(
      {
        // The established transactional convention: the brand voice
        // sends, the order desk takes replies. Not RESEND_CONTACT_FROM,
        // which gates the contact form, and not the published info@
        // address, which is Impressum copy and stays in the footer.
        from: GLOA_FROM_HELLO,
        to: customerEmail,
        replyTo: GLOA_REPLY_TO_SUPPORT,
        subject,
        html,
        text,
      },
      { idempotencyKey }
    );
    if (error) sendErrorMessage = error.message;
  } catch (err) {
    sendErrorMessage = err instanceof Error ? err.message : "unknown error";
  }

  // The shipment is untouched by this. fulfillment_status, shipped_at and
  // every tracking column stay exactly as they are - the parcel is gone
  // whatever the mail provider did, and migration 027's column-scoped
  // grant means this code could not un-ship it even if it tried.
  if (sendErrorMessage) throw new Error(sendErrorMessage);
}


/* ══════════════════════════════════════════════════════════════
   WHY THERE IS NO SWEEP, AND WHAT IT WOULD TAKE TO ADD ONE
   ══════════════════════════════════════════════════════════════

   The internal fulfillment notification has a daily cron behind it
   (app/api/cron/retry-order-notifications) that drains rows stuck at
   'failed' and recovers rows abandoned at 'sending'. The obvious move is
   to extend it. That is deliberately not done, for two reasons.

   THE FIRST IS THAT IT WOULD HAVE NOTHING TO DO. 'failed' is the only
   status a sweep may key on, and 'failed' can only be written by a send
   that was attempted. Nothing calls the send. Until a real shipment
   action exists, a shipment sweep would run every morning over an empty
   set forever.

   THE SECOND IS THE DANGEROUS ONE, and it is why the rule must be written
   down before anyone writes that sweep. The tempting eligibility rule is
   "shipped, and shipment_email_status IS NULL". It is wrong, and on its
   first run it would be spectacularly wrong: the owner has been shipping
   orders by hand since migration 019, so production already holds orders
   that are genuinely 'shipped' and whose new column is NULL. That sweep's
   first invocation would mail every one of those customers a "your order
   is on its way" about a parcel that arrived weeks ago. Migration 027
   makes the column nullable with no default so those rows read as "never
   part of this flow" rather than as queued work - the same trap migration
   026 documents at length, and the same escape.

   So a sweep, if one is ever built, must key on 'failed' and nothing
   else (isShipmentEmailSweepEligible enforces exactly this), and it must
   keep its counts separate from the internal notification's: they are two
   different messages to two different recipients, and one summary that
   conflated them would hide a customer-facing failure behind an
   operational success.

   And none of that is the blocker. The blocker is upstream: there is no
   authorized shipment transition to send anything about.

   OWNER ACTION REQUIRED to unblock it, in this order:
     1. decide where a shipment is recorded - a SECURITY DEFINER RPC in
        the migration 019 style is the natural fit, since service_role has
        no write access to the tracking columns by design
     2. decide what authorizes the caller, which this repository currently
        has no surface for
     3. call sendShipmentConfirmationIfNeeded(orderId) after that
        transition has durably committed, never before, and never let its
        result change the shipment
   ══════════════════════════════════════════════════════════════ */
