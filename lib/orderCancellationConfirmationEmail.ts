import { getSupabaseAdmin } from "./supabaseAdmin";
import { getResendClient } from "./resend";
import { getSiteOrigin } from "./siteUrl";
import { GLOA_FROM_HELLO, GLOA_REPLY_TO_SUPPORT } from "./emailSenders";
import {
  buildCancellationConfirmationEmail,
  cancellationConfirmationIdempotencyKey,
} from "./email/orderCancellationConfirmation";
import {
  cancellationRefundStateOf,
  isCancellationConfirmationOwed,
  type CancellationConfirmationSendResult,
} from "./orderCancellationConfirmationRules.ts";

/**
 * TELLS THE CUSTOMER THAT GLOA CANCELLED THEIR ORDER.
 *
 * The sixth message in the family and the sixth pair of state columns,
 * from migration 049. Same fate as the other five and the same shape:
 * read the durable row, claim atomically, render, send with a
 * deterministic provider key, record the outcome.
 *
 * ── WHY IT IS NOT THE OUTCOME EMAIL ───────────────────────────
 *
 * lib/cancellationOutcomeEmail.ts answers a cancellation the CUSTOMER
 * requested, and reads its eligibility from
 * cancellation_request_resolution. An order cancelled by an operator on
 * their own initiative carries no resolution at all, so that sender
 * would correctly refuse it - and forcing it through would send somebody
 * the reply to a question they never asked.
 *
 * ── IT REPORTS. IT DOES NOT DECIDE. ───────────────────────────
 *
 * Nothing here cancels anything, moves a lifecycle column or creates a
 * refund. It cannot: migration 049 grants service_role UPDATE on exactly
 * the two columns this module writes, and status, fulfillment_status,
 * cancelled_at, payment_status, refunded_total_cents and every money
 * column remain outside its reach. Enforced by the database rather than
 * by this comment.
 *
 * ── THE REFUND STATE IS READ, NEVER PASSED IN ─────────────────
 *
 * The entry point takes an order id and nothing else. Whether the email
 * says "nothing refunded", "partly refunded" or "fully refunded" is
 * derived from the row's own refunded_total_cents and total_gross_cents
 * at send time. A caller cannot make this message claim money went back.
 */

const ORDER_COLUMNS =
  "id, order_number, user_id, customer_snapshot, status, fulfillment_status, " +
  "cancelled_at, total_gross_cents, refunded_total_cents, " +
  "cancellation_confirmation_email_status";

type OrderRow = {
  id: string;
  order_number: string;
  user_id: string | null;
  customer_snapshot: unknown;
  status: string | null;
  fulfillment_status: string | null;
  cancelled_at: string | null;
  total_gross_cents: number | null;
  refunded_total_cents: number | null;
  cancellation_confirmation_email_status: string | null;
};

type ClaimOutcome = "claimed" | "taken" | "error";

/**
 * Atomically claims the right to send this order's cancellation
 * confirmation.
 *
 * Only one caller can win it. The UPDATE matches only a row that is
 * genuinely cancelled and whose status is NULL or 'failed', so a second
 * concurrent caller matches zero rows and is told the claim is taken.
 * UPDATE takes a row lock, so the two serialize rather than both
 * reading "not sent yet" and both sending.
 */
async function claimConfirmationEmail(orderId: string): Promise<ClaimOutcome> {
  const admin = getSupabaseAdmin();
  if (!admin) return "error";

  const { data, error } = await admin
    .from("orders")
    .update({ cancellation_confirmation_email_status: "sending" })
    .eq("id", orderId)
    // Genuinely cancelled. Defence in depth against the row changing
    // between the read above and this write.
    .or("status.eq.cancelled,fulfillment_status.eq.cancelled,cancelled_at.not.is.null")
    // Not currently held by another worker, and not already delivered.
    .or(
      "cancellation_confirmation_email_status.is.null," +
        "cancellation_confirmation_email_status.eq.failed"
    )
    .select("id");

  if (error) {
    console.error(`Cancellation confirmation: claim failed for order ${orderId}:`, error.message);
    return "error";
  }
  return (data?.length ?? 0) > 0 ? "claimed" : "taken";
}

/**
 * Records that Resend accepted the message.
 *
 * Deliberately NOT conditional on the row still saying 'sending'. 'sent'
 * records that the provider accepted it, which is true whatever the row
 * says by then, and suppressing the write would invite a duplicate
 * rather than prevent one. The same asymmetry the other five senders
 * have.
 */
async function markSent(orderId: string): Promise<void> {
  const admin = getSupabaseAdmin();
  if (!admin) return;
  const { error } = await admin
    .from("orders")
    .update({
      cancellation_confirmation_email_status: "sent",
      cancellation_confirmation_email_sent_at: new Date().toISOString(),
    })
    .eq("id", orderId);
  if (error) {
    console.error(`Cancellation confirmation: mark-sent failed for order ${orderId}:`, error.message);
  }
}

/**
 * Returns a claimed send to 'failed' - the one state a repeat may key on.
 *
 * CONDITIONAL ON STILL BEING 'sending': writing 'failed' over any other
 * state is never correct, and writing it over a 'sent' row would invite
 * the very duplicate this mechanism exists to prevent.
 */
async function markFailed(orderId: string): Promise<void> {
  const admin = getSupabaseAdmin();
  if (!admin) return;
  const { error } = await admin
    .from("orders")
    .update({ cancellation_confirmation_email_status: "failed" })
    .eq("id", orderId)
    .eq("cancellation_confirmation_email_status", "sending");
  if (error) {
    console.error(`Cancellation confirmation: mark-failed failed for order ${orderId}:`, error.message);
  }
}

/**
 * The recipient, taken from the order's own frozen customer_snapshot.
 *
 * The address is a property of the durable order, read back at send
 * time. A request-body email and a client-supplied recipient both have
 * nowhere to enter, because no parameter for one exists.
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
 * Sends the direct cancellation confirmation for one order, at most
 * once, if and only if the durable order genuinely records a
 * cancellation.
 *
 * MUST be called strictly AFTER cancel_order has committed. It reads the
 * row back for itself rather than trusting anything the caller learned,
 * so calling it too early cannot produce a message about a cancellation
 * that has not happened: the claim would match zero rows and the outcome
 * would be "already-sent" or "not-eligible".
 *
 * Never throws. A failed send is data, not an exception: the
 * cancellation is already durable and must stay that way.
 */
export async function sendCancellationConfirmationIfNeeded(
  orderId: string
): Promise<CancellationConfirmationSendResult> {
  const admin = getSupabaseAdmin();
  if (!admin) {
    console.error("Cancellation confirmation: SUPABASE_SECRET_KEY is not configured.");
    return "failed";
  }

  const { data, error } = await admin
    .from("orders")
    .select(ORDER_COLUMNS)
    .eq("id", orderId)
    .maybeSingle();

  if (error) {
    console.error(`Cancellation confirmation: load failed for order ${orderId}:`, error.message);
    return "failed";
  }
  // A missing order is not an error worth a stack trace, and it must not
  // be distinguishable from an ineligible one to anything upstream.
  if (!data) return "not-eligible";

  const order = data as unknown as OrderRow;
  if (!isCancellationConfirmationOwed(order)) {
    return order.cancellation_confirmation_email_status === "sent" ? "already-sent" : "not-eligible";
  }

  const claim = await claimConfirmationEmail(order.id);
  if (claim === "error") return "failed";
  if (claim === "taken") return "already-sent";

  return deliverClaimedCancellationConfirmation(order);
}

/**
 * Renders and sends a confirmation whose claim has ALREADY been won, and
 * records the outcome on the order.
 *
 * Split out so that a retry sweep, should one ever be built, reuses this
 * exact send and these exact state writes rather than growing a second
 * copy for the recipient, the template and the state machine to drift
 * apart in.
 */
export async function deliverClaimedCancellationConfirmation(
  order: OrderRow
): Promise<CancellationConfirmationSendResult> {
  const customerEmail = recipientFromSnapshot(order.customer_snapshot);
  if (!customerEmail) {
    // Order id only. A missing address is not a reason to log whatever
    // the snapshot did contain. The cancellation stands; there is simply
    // nobody to tell by email.
    console.error(`Cancellation confirmation: order ${order.id} has no customer email to send to.`);
    await markFailed(order.id);
    return "failed";
  }

  const resend = getResendClient();
  if (!resend) {
    console.error("Cancellation confirmation: RESEND_API_KEY is not configured.");
    await markFailed(order.id);
    return "failed";
  }

  const { subject, html, text } = buildCancellationConfirmationEmail({
    origin: getSiteOrigin() ?? undefined,
    order: {
      order_number: order.order_number,
      // From the row, at send time. Not from the caller, and not from
      // anything the admin screen displayed a moment earlier.
      refundState: cancellationRefundStateOf(order),
      accountOrderUrl: buildAccountOrderUrl(order.id, order.user_id),
    },
  });

  // The provider-side half of the duplicate guard, independent of the
  // database claim: if this process died between winning the claim and
  // Resend accepting the message, the retry presents the same key and
  // Resend returns the same message instead of sending a second one.
  const idempotencyKey = cancellationConfirmationIdempotencyKey(order.id);

  let sendErrorMessage: string | null = null;
  try {
    const { error } = await resend.emails.send(
      {
        // The established customer transactional convention: the brand
        // voice sends, the order desk takes replies.
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
    // The order id and the provider's message. Never the recipient and
    // never the customer.
    console.error(`Cancellation confirmation: send failed for order ${order.id}:`, sendErrorMessage);
    await markFailed(order.id);
    return "failed";
  }

  await markSent(order.id);
  return "sent";
}
