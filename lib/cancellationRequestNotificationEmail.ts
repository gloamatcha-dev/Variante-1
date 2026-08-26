import { getSupabaseAdmin } from "./supabaseAdmin";
import { getResendClient } from "./resend";
import { GLOA_FROM_HELLO, GLOA_INTERNAL_ORDERS } from "./emailSenders";
import {
  buildCancellationRequestNotificationEmail,
  cancellationRequestNotificationIdempotencyKey,
  type CancellationRequestNotificationOrder,
} from "./email/cancellationRequestNotification";
import {
  isLiveNotificationOwed,
  type CancellationNotificationOutcome,
} from "./cancellationRequestNotificationRules";

/**
 * Tells GLOA that a customer has ASKED to stop an order (Phase 2D-A).
 *
 * The same shape as lib/internalOrderNotificationEmail.ts and
 * lib/shipmentConfirmationEmail.ts, on its own pair of columns from
 * migration 030, because it is a fourth message with a fourth fate. The
 * other three fire from a payment or a parcel; this one fires from a
 * CUSTOMER ACTION that can happen days later, to an order whose other
 * three emails all went out cleanly.
 *
 * ── IT NOTIFIES. IT DOES NOT CANCEL. ──────────────────────────
 *
 * Nothing in this module changes order lifecycle state, creates a refund,
 * or touches a parcel. It cannot: after migration 030, service_role's
 * UPDATE grant on public.orders covers exactly eight columns, and the two
 * this module writes are the two 030 added. status, fulfillment_status,
 * cancelled_at, payment_status, refunded_total_cents, every money and tax
 * column and every snapshot are all outside its reach, enforced by the
 * database rather than by this comment.
 *
 * It also never writes cancellation_requested_at or
 * cancellation_request_note. Those are the customer's request - what they
 * asked and when - and an email that failed to send is a fact about an
 * email, never a reason to erase, move or rewrite it.
 *
 * ── IT TAKES AN ORDER ID AND NOTHING ELSE ─────────────────────
 *
 * No recipient, no subject, no body, no note, no "force" flag. Every word
 * of the message is read back from the durable order row inside this
 * function, so a caller cannot supply content, cannot redirect the
 * message, and cannot assert a cancellation request that the database
 * does not already record. A browser-supplied recipient has nowhere to
 * enter, because there is no parameter for one.
 *
 * The recipient is the fixed internal inbox, GLOA_INTERNAL_ORDERS. It is
 * a module-level constant from lib/emailSenders.ts, not a parameter and
 * not an environment variable, so there is no configuration and no
 * argument through which this message could be pointed at a customer.
 *
 * ── IT NEVER THROWS FOR AN ORDINARY OUTCOME ───────────────────
 *
 * Unlike the internal new-order notification - which throws so that a
 * failed send becomes a Stripe webhook 500 and inherits Stripe's
 * redelivery schedule - this one has no webhook behind it. Its caller is
 * a signed-in customer's request, and failing that request because a mail
 * provider was down would be exactly the wrong coupling: THE CUSTOMER'S
 * CANCELLATION REQUEST IS ALREADY DURABLE BY THE TIME THIS RUNS, and it
 * must stay durable. So the outcome is returned as data, the row records
 * it, and the request is unaffected either way.
 *
 * ── THE RETRY PATH, UNTIL THERE IS A SWEEP ────────────────────
 *
 * There is no cron for this message (Phase 2D-A deliberately adds none).
 * The interim retry is the customer's own repeat request: pressing the
 * button again returns 'already_requested' from request_order_cancellation
 * - no second request, original timestamp and note preserved - and the
 * route re-enters this sender, whose claim picks the row up if and only
 * if it is 'failed'. A 'sent' row loses the claim and mails nothing.
 */

/**
 * The columns one cancellation request notification is rebuilt from.
 *
 * Deliberately short. No items query, no address, no tracking, no Stripe
 * id: see the note on CancellationRequestNotificationOrder for why the
 * message does not carry them.
 */
const ORDER_COLUMNS =
  "id, order_number, customer_snapshot, currency, total_gross_cents, " +
  "payment_status, fulfillment_status, " +
  "cancellation_requested_at, cancellation_request_note, " +
  "cancellation_request_notification_status";

type OrderRow = {
  id: string;
  order_number: string;
  customer_snapshot: unknown;
  currency: string;
  total_gross_cents: number;
  payment_status: string;
  fulfillment_status: string;
  cancellation_requested_at: string | null;
  cancellation_request_note: string | null;
  cancellation_request_notification_status: string | null;
};

type ClaimOutcome = "claimed" | "taken" | "error";

/**
 * Atomically claims the right to send this order's cancellation request
 * notification.
 *
 * Only one caller can win it. The UPDATE matches only a row that was
 * never attempted (NULL) or that failed, and Postgres row locking
 * serialises concurrent updates to one row, so a second concurrent
 * request sees the row already moved to 'sending' and gets zero rows
 * back. Identical to the guard lib/internalOrderNotificationEmail.ts and
 * lib/shipmentConfirmationEmail.ts use, on migration 030's columns.
 *
 * IT ALSO RE-CHECKS THE REQUEST ITSELF, in the same statement. The caller
 * has already read the row and found a cancellation_requested_at, but a
 * read is never trusted: making `not null` part of the WHERE clause means
 * the request cannot vanish between the read and the claim and still
 * produce an email. It is the same defence in depth
 * isLiveNotificationOwed applies in code - two independent refusals, so
 * no single mistake can tell fulfillment that a customer asked to stop an
 * order they never asked to stop.
 */
async function claimCancellationRequestNotification(orderId: string): Promise<ClaimOutcome> {
  const admin = getSupabaseAdmin();
  if (!admin) return "error";

  const { data, error } = await admin
    .from("orders")
    .update({ cancellation_request_notification_status: "sending" })
    .eq("id", orderId)
    .not("cancellation_requested_at", "is", null)
    .or(
      "cancellation_request_notification_status.is.null," +
        "cancellation_request_notification_status.eq.failed"
    )
    .select("id");

  if (error) {
    console.error(`Cancellation request notification: claim failed for order ${orderId}:`, error.message);
    return "error";
  }
  return (data?.length ?? 0) > 0 ? "claimed" : "taken";
}

/**
 * Records that Resend accepted the message.
 *
 * Deliberately NOT conditional on the row still saying 'sending'. 'sent'
 * records that the provider accepted it, which is true whatever the row
 * says by then, and suppressing that write would invite a duplicate
 * rather than prevent one. The same asymmetry the other two senders have.
 */
async function markSent(orderId: string): Promise<void> {
  const admin = getSupabaseAdmin();
  if (!admin) return;
  const { error } = await admin
    .from("orders")
    .update({
      cancellation_request_notification_status: "sent",
      cancellation_request_notification_sent_at: new Date().toISOString(),
    })
    .eq("id", orderId);
  if (error) {
    console.error(`Cancellation request notification: mark-sent failed for order ${orderId}:`, error.message);
  }
}

/**
 * Returns a claimed notification to 'failed' - the one state a repeat or
 * a future sweep may key on.
 *
 * CONDITIONAL ON STILL BEING 'sending', for the same reason
 * markInternalNotificationFailed is: writing 'failed' over any other
 * state is never correct, and writing it over a 'sent' row would invite
 * the very duplicate this whole mechanism exists to prevent.
 *
 * THIS NEVER TOUCHES cancellation_requested_at, cancellation_request_note
 * OR ANY LIFECYCLE COLUMN, and it must never learn to. The customer's
 * request is still exactly as durable as it was a moment ago. Migration
 * 030's column-scoped grant enforces this at the database, so the
 * property does not depend on this comment being read.
 */
async function markFailed(orderId: string): Promise<void> {
  const admin = getSupabaseAdmin();
  if (!admin) return;
  const { error } = await admin
    .from("orders")
    .update({ cancellation_request_notification_status: "failed" })
    .eq("id", orderId)
    .eq("cancellation_request_notification_status", "sending");
  if (error) {
    console.error(`Cancellation request notification: mark-failed failed for order ${orderId}:`, error.message);
  }
}

/**
 * The customer's name and email, from the order's own frozen snapshot.
 *
 * Not parameters, deliberately. The customer identity shown to
 * fulfillment is a property of the durable order, read back at send time,
 * so a caller cannot substitute one. Both may legitimately be absent -
 * migration 011 writes {"email": null, "name": null} when checkout
 * collected neither - and the template omits the row rather than printing
 * a placeholder.
 *
 * Note that neither is the RECIPIENT. This message goes to the internal
 * inbox; the customer's address is shown as a fact so fulfillment can
 * reply, and is never used as a `to`.
 */
function customerFromSnapshot(snapshot: unknown): { name: string | null; email: string | null } {
  const customer = (snapshot ?? {}) as { email?: unknown; name?: unknown };
  const email = typeof customer.email === "string" ? customer.email.trim() || null : null;
  const name = typeof customer.name === "string" ? customer.name.trim() || null : null;
  return { name, email };
}

/**
 * Sends the internal cancellation request notification for one order, at
 * most once, if and only if the durable order genuinely records a
 * cancellation request.
 *
 * MUST be called strictly AFTER request_order_cancellation has committed.
 * It reads the row back for itself rather than trusting anything the
 * caller learned, so calling it too early cannot produce a message about
 * a request that does not exist yet: the claim would match zero rows and
 * the outcome would be "not-eligible".
 */
export async function sendCancellationRequestNotificationIfNeeded(
  orderId: string
): Promise<CancellationNotificationOutcome> {
  const admin = getSupabaseAdmin();
  if (!admin) {
    console.error("Cancellation request notification: SUPABASE_SECRET_KEY is not configured.");
    return "failed";
  }

  const { data, error } = await admin
    .from("orders")
    .select(ORDER_COLUMNS)
    .eq("id", orderId)
    .maybeSingle();

  if (error) {
    console.error(`Cancellation request notification: load failed for order ${orderId}:`, error.message);
    return "failed";
  }
  // A missing order is not an error worth a stack trace, and it must not
  // be distinguishable from an ineligible one to anything upstream.
  if (!data) return "not-eligible";

  const order = data as unknown as OrderRow;

  // The code half of the guarantee. The claim below repeats the
  // cancellation-request half of this in SQL.
  if (!isLiveNotificationOwed(order)) return "already-sent";

  const claim = await claimCancellationRequestNotification(order.id);
  if (claim === "error") return "failed";
  if (claim === "taken") return "already-sent";

  return deliverClaimedCancellationRequestNotification(order);
}

/**
 * Renders and sends a notification whose claim has ALREADY been won, and
 * records the outcome on the order.
 *
 * Split out so that a retry sweep, should one ever be built, reuses this
 * exact send and these exact state writes rather than growing a second
 * copy for the recipient, the template and the state machine to drift
 * apart in. Such a sweep must bring its own, stricter claim - 'failed'
 * only, never NULL - which is what isNotificationSweepEligible expresses.
 *
 * It must only ever be called by a caller holding a won claim. It does
 * not re-check the state, because by this point the row says 'sending'
 * and re-reading it would only re-derive what the claim atomically
 * established.
 */
async function deliverClaimedCancellationRequestNotification(
  order: OrderRow
): Promise<CancellationNotificationOutcome> {
  const resend = getResendClient();
  if (!resend) {
    console.error("Cancellation request notification: RESEND_API_KEY is not configured.");
    await markFailed(order.id);
    return "failed";
  }

  const customer = customerFromSnapshot(order.customer_snapshot);

  const emailOrder: CancellationRequestNotificationOrder = {
    order_number: order.order_number,
    // The persisted timestamp, never Date.now(). If the row somehow has
    // none the template omits the row rather than inventing one.
    requestedAt: order.cancellation_requested_at,
    requestNote: order.cancellation_request_note,
    customerName: customer.name,
    customerEmail: customer.email,
    currency: order.currency,
    total_gross_cents: order.total_gross_cents,
    // The lifecycle as it stands RIGHT NOW, which is the point: this
    // message exists so a human can judge whether the order can still be
    // stopped. Nothing here has changed it.
    payment_status: order.payment_status,
    fulfillment_status: order.fulfillment_status,
  };

  const { subject, html, text } = buildCancellationRequestNotificationEmail({ order: emailOrder });

  // The provider-side half of the duplicate guard. The database claim
  // stops two callers from both starting a send; this stops an attempt
  // that reached Resend but lost its state write from becoming a second
  // email. Same order, same key, on every attempt from every path.
  const idempotencyKey = cancellationRequestNotificationIdempotencyKey(order.id);

  let sendErrorMessage: string | null = null;
  try {
    const { error } = await resend.emails.send(
      {
        // The established transactional convention, matching the internal
        // new-order notification exactly: the brand voice sends, the
        // fixed fulfillment inbox receives. No replyTo - this is internal
        // mail and a reply goes to the customer's address printed in the
        // body, not back into an automated flow.
        from: GLOA_FROM_HELLO,
        to: GLOA_INTERNAL_ORDERS,
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

  if (sendErrorMessage) {
    // The order id and the provider's message. Never the recipient, the
    // customer's name or email, and never the request note - that is the
    // customer's free text and it does not belong in a log line.
    console.error(`Cancellation request notification: send failed for order ${order.id}:`, sendErrorMessage);
    await markFailed(order.id);
    return "failed";
  }

  await markSent(order.id);
  return "sent";
}
