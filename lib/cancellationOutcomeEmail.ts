import { getSupabaseAdmin } from "./supabaseAdmin";
import { getResendClient } from "./resend";
import { getSiteOrigin } from "./siteUrl";
import { GLOA_FROM_HELLO, GLOA_REPLY_TO_SUPPORT } from "./emailSenders";
import {
  buildCancellationOutcomeEmail,
  cancellationOutcomeIdempotencyKey,
  type CancellationOutcome,
} from "./email/cancellationOutcome";
import {
  isOutcomeEmailOwed,
  type OutcomeEmailSendResult,
} from "./cancellationResolutionRules";

/**
 * Tells the customer how their cancellation request was answered
 * (Phase 2D-B).
 *
 * The fifth message in the family and the fifth pair of state columns,
 * from migration 031. It has a fifth fate: it is a CUSTOMER email about a
 * terminal operator decision, and it can fail long after the internal
 * request notification (030) succeeded.
 *
 * ── IT REPORTS. IT DOES NOT DECIDE. ───────────────────────────
 *
 * Nothing in this module resolves a request, cancels an order, moves any
 * lifecycle column or creates a refund. It cannot: after migration 031,
 * service_role's UPDATE grant on public.orders covers exactly ten
 * columns, all of them email state, and the two this module writes are
 * the two 031 added. status, fulfillment_status, cancelled_at,
 * cancellation_request_resolution, cancellation_request_resolved_at,
 * cancellation_requested_at, cancellation_request_note, payment_status,
 * refunded_total_cents and every money, tax, snapshot and tracking column
 * are all outside its reach, enforced by the database rather than by this
 * comment.
 *
 * ── THE OUTCOME IS READ, NEVER PASSED IN ──────────────────────
 *
 * The entry point takes an order id and nothing else. Which of the two
 * emails goes out is decided by reading
 * cancellation_request_resolution back from the durable row, not by a
 * caller's argument. That matters: it means no code path exists through
 * which a caller could send "your order was cancelled" for an order that
 * was not, and no request body can influence which message a customer
 * receives.
 *
 * The recipient is read the same way, from the order's own frozen
 * customer_snapshot, exactly as lib/shipmentConfirmationEmail.ts does.
 * There is no recipient parameter anywhere in this module, so
 * arbitrary-recipient is removed as a category of bug rather than guarded
 * against.
 *
 * ── IT NEVER THROWS FOR AN ORDINARY OUTCOME ───────────────────
 *
 * THE RESOLUTION IS ALREADY DURABLE BY THE TIME THIS RUNS, and it must
 * stay durable. Failing the operator's request because a mail provider
 * was down would be the wrong coupling entirely - worse here than
 * anywhere else in this codebase, because on the approved path the order
 * has ALREADY been cancelled in the same transaction that recorded the
 * answer. Rolling anything back is neither possible nor desirable. So the
 * outcome is returned as data, the row records it, and the resolution is
 * unaffected either way.
 *
 * ── THE RETRY PATH, UNTIL THERE IS A SWEEP ────────────────────
 *
 * There is no cron for this message (Phase 2D-B deliberately adds none).
 * The interim retry is a repeated authorized resolution with the SAME
 * decision: the RPC returns 'already_approved' or 'already_declined'
 * without moving resolved_at, and the route re-enters this sender, whose
 * claim picks the row up if and only if it is 'failed'. A 'sent' row
 * loses the claim and mails nothing. A CONFLICTING second decision never
 * reaches here at all.
 */

/** The columns one outcome email is rebuilt from. */
const ORDER_COLUMNS =
  "id, order_number, user_id, customer_snapshot, " +
  "cancellation_request_resolution, cancellation_outcome_email_status";

type OrderRow = {
  id: string;
  order_number: string;
  user_id: string | null;
  customer_snapshot: unknown;
  cancellation_request_resolution: string | null;
  cancellation_outcome_email_status: string | null;
};

type ClaimOutcome = "claimed" | "taken" | "error";

/**
 * Atomically claims the right to send this order's outcome email.
 *
 * Only one caller can win it. The UPDATE matches only a row that was
 * never attempted (NULL) or that failed, and Postgres row locking
 * serialises concurrent updates to one row, so a second concurrent
 * request sees the row already moved to 'sending' and gets zero rows
 * back. Identical to the guard the other four senders use, on migration
 * 031's columns.
 *
 * IT ALSO RE-CHECKS THE RESOLUTION ITSELF, in the same statement. The
 * caller has already read the row and found a terminal resolution, but a
 * read is never trusted: making `not null` part of the WHERE clause means
 * the resolution cannot vanish between the read and the claim and still
 * produce an email. It is the same defence in depth isOutcomeEmailOwed
 * applies in code - two independent refusals, so no single mistake can
 * tell a customer their order was cancelled when no answer was ever
 * recorded.
 */
async function claimOutcomeEmail(orderId: string): Promise<ClaimOutcome> {
  const admin = getSupabaseAdmin();
  if (!admin) return "error";

  const { data, error } = await admin
    .from("orders")
    .update({ cancellation_outcome_email_status: "sending" })
    .eq("id", orderId)
    .not("cancellation_request_resolution", "is", null)
    .or(
      "cancellation_outcome_email_status.is.null," +
        "cancellation_outcome_email_status.eq.failed"
    )
    .select("id");

  if (error) {
    console.error(`Cancellation outcome email: claim failed for order ${orderId}:`, error.message);
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
 * rather than prevent one. The same asymmetry the other four senders
 * have.
 */
async function markSent(orderId: string): Promise<void> {
  const admin = getSupabaseAdmin();
  if (!admin) return;
  const { error } = await admin
    .from("orders")
    .update({
      cancellation_outcome_email_status: "sent",
      cancellation_outcome_email_sent_at: new Date().toISOString(),
    })
    .eq("id", orderId);
  if (error) {
    console.error(`Cancellation outcome email: mark-sent failed for order ${orderId}:`, error.message);
  }
}

/**
 * Returns a claimed send to 'failed' - the one state a repeat or a future
 * sweep may key on.
 *
 * CONDITIONAL ON STILL BEING 'sending', for the same reason the other
 * senders' mark-failed is: writing 'failed' over any other state is never
 * correct, and writing it over a 'sent' row would invite the very
 * duplicate this whole mechanism exists to prevent.
 *
 * THIS NEVER TOUCHES THE RESOLUTION OR ANY LIFECYCLE COLUMN, and it must
 * never learn to. On the approved path the order is already cancelled;
 * un-resolving or un-cancelling it because a mail provider had a bad
 * minute would corrupt the business record to tidy up a notification.
 * Migration 031's grant enforces this at the database.
 */
async function markFailed(orderId: string): Promise<void> {
  const admin = getSupabaseAdmin();
  if (!admin) return;
  const { error } = await admin
    .from("orders")
    .update({ cancellation_outcome_email_status: "failed" })
    .eq("id", orderId)
    .eq("cancellation_outcome_email_status", "sending");
  if (error) {
    console.error(`Cancellation outcome email: mark-failed failed for order ${orderId}:`, error.message);
  }
}

/**
 * The recipient, taken from the order's own frozen customer_snapshot.
 *
 * Not a parameter, deliberately, and identical to
 * lib/shipmentConfirmationEmail.ts. The address is a property of the
 * durable order, read back at send time, and an order whose snapshot
 * holds no usable address simply cannot be mailed. A request-body email,
 * a query-string email and a client-supplied recipient all have nowhere
 * to enter, because no parameter for one exists.
 */
function recipientFromSnapshot(snapshot: unknown): string | null {
  const customer = (snapshot ?? {}) as { email?: unknown };
  if (typeof customer.email !== "string") return null;
  const trimmed = customer.email.trim();
  return trimmed ? trimmed : null;
}

function buildAccountOrderUrl(orderId: string, userId: string | null): string | null {
  if (!userId) return null; // guest order - no account to show it in
  const origin = getSiteOrigin();
  if (!origin) return null;
  return `${origin}/account/orders/${orderId}`;
}

/**
 * Sends the customer's cancellation outcome email for one order, at most
 * once, if and only if the durable order genuinely carries a terminal
 * resolution.
 *
 * MUST be called strictly AFTER resolve_order_cancellation_request has
 * committed. It reads the row back for itself rather than trusting
 * anything the caller learned, so calling it too early cannot produce a
 * message about a decision that does not exist yet: the claim would match
 * zero rows and the outcome would be "not-eligible".
 */
export async function sendCancellationOutcomeEmailIfNeeded(
  orderId: string
): Promise<OutcomeEmailSendResult> {
  const admin = getSupabaseAdmin();
  if (!admin) {
    console.error("Cancellation outcome email: SUPABASE_SECRET_KEY is not configured.");
    return "failed";
  }

  const { data, error } = await admin
    .from("orders")
    .select(ORDER_COLUMNS)
    .eq("id", orderId)
    .maybeSingle();

  if (error) {
    console.error(`Cancellation outcome email: load failed for order ${orderId}:`, error.message);
    return "failed";
  }
  // A missing order is not an error worth a stack trace, and it must not
  // be distinguishable from an ineligible one to anything upstream.
  if (!data) return "not-eligible";

  const order = data as unknown as OrderRow;

  // The code half of the guarantee. The claim below repeats the
  // resolution half of this in SQL.
  if (!isOutcomeEmailOwed(order)) return "already-sent";

  const claim = await claimOutcomeEmail(order.id);
  if (claim === "error") return "failed";
  if (claim === "taken") return "already-sent";

  return deliverClaimedCancellationOutcome(order);
}

/**
 * Renders and sends an outcome email whose claim has ALREADY been won,
 * and records the outcome on the order.
 *
 * Split out so that a retry sweep, should one ever be built, reuses this
 * exact send and these exact state writes rather than growing a second
 * copy for the recipient, the template and the state machine to drift
 * apart in. Such a sweep must bring its own, stricter claim - 'failed'
 * only, never NULL - which is what isOutcomeEmailSweepEligible expresses.
 */
async function deliverClaimedCancellationOutcome(order: OrderRow): Promise<OutcomeEmailSendResult> {
  // Read from the durable row, never from a caller. The CHECK constraint
  // in migration 031 permits only these two values, so anything else is a
  // corrupted row and is refused rather than guessed at.
  const resolution = order.cancellation_request_resolution;
  if (resolution !== "approved" && resolution !== "declined") {
    console.error(`Cancellation outcome email: order ${order.id} has no usable resolution.`);
    await markFailed(order.id);
    return "failed";
  }
  const outcome: CancellationOutcome = resolution;

  const customerEmail = recipientFromSnapshot(order.customer_snapshot);
  if (!customerEmail) {
    // Order id only. A missing address is not a reason to log whatever
    // the snapshot did contain. The resolution stands; there is simply
    // nobody to tell by email, and the account page shows it either way.
    console.error(`Cancellation outcome email: order ${order.id} has no customer email to send to.`);
    await markFailed(order.id);
    return "failed";
  }

  const resend = getResendClient();
  if (!resend) {
    console.error("Cancellation outcome email: RESEND_API_KEY is not configured.");
    await markFailed(order.id);
    return "failed";
  }

  const { subject, html, text } = buildCancellationOutcomeEmail({
    order: {
      order_number: order.order_number,
      outcome,
      accountOrderUrl: buildAccountOrderUrl(order.id, order.user_id),
    },
  });

  // The provider-side half of the duplicate guard, and a second,
  // independent enforcement of "one order, one answer". See the note on
  // cancellationOutcomeIdempotencyKey for why the outcome is deliberately
  // not part of the key.
  const idempotencyKey = cancellationOutcomeIdempotencyKey(order.id);

  let sendErrorMessage: string | null = null;
  try {
    const { error } = await resend.emails.send(
      {
        // The established customer transactional convention: the brand
        // voice sends, the order desk takes replies. Identical to the
        // order confirmation and the shipment confirmation.
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

  if (sendErrorMessage) {
    // The order id and the provider's message. Never the recipient, the
    // customer's name, the request note or the resolution.
    console.error(`Cancellation outcome email: send failed for order ${order.id}:`, sendErrorMessage);
    await markFailed(order.id);
    return "failed";
  }

  await markSent(order.id);
  return "sent";
}
