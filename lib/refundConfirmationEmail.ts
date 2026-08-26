import { getSupabaseAdmin } from "./supabaseAdmin";
import { getResendClient } from "./resend";
import { getSiteOrigin } from "./siteUrl";
import { GLOA_FROM_HELLO, GLOA_REPLY_TO_SUPPORT } from "./emailSenders";
import {
  buildRefundConfirmationEmail,
  refundConfirmationIdempotencyKey,
} from "./email/refundConfirmation";
import {
  isRefundEmailOwed,
  refundKind,
  type RefundEmailSendResult,
} from "./refundConfirmationRules";

/**
 * Tells the customer that money went back (Phase 2E-A).
 *
 * The sixth message in the family, and the first that can legitimately
 * fire more than once for one order. Migration 033's three columns exist
 * for exactly that reason - see the long note there and in
 * lib/refundConfirmationRules.ts.
 *
 * ── IT REPORTS. IT DOES NOT REFUND. ───────────────────────────
 *
 * Nothing in this module creates, cancels or alters a refund. It cannot:
 * there is no Stripe import in this file and no Stripe write API exists
 * anywhere in this repository. Refunds are raised by hand in the Stripe
 * Dashboard and reconciled by migration 019's apply_order_refund_state
 * from an absolute re-read of the payment intent. This module runs
 * strictly afterwards and only reads what that reconciliation persisted.
 *
 * After migration 033, service_role's UPDATE grant on public.orders
 * covers thirteen columns and every one of them is email state. The three
 * this module writes are 033's. payment_status, refunded_total_cents and
 * refund_updated_at are outside its reach, enforced by the database
 * rather than by this comment - which is the property that matters most
 * here, because a bug in an email module must never be able to restate
 * how much money a customer got back.
 *
 * ── EVERY FACT COMES FROM THE ROW ─────────────────────────────
 *
 * The entry point takes an order id and nothing else. The amount, the
 * currency, the order total, whether this is a partial or a full refund,
 * and the recipient are all read back from the durable order. Nothing
 * from the Stripe webhook payload reaches the message: the payload is not
 * trusted for refund facts anywhere in this system, and it is not trusted
 * here either.
 *
 * The recipient in particular is taken from the order's own frozen
 * customer_snapshot, exactly as lib/shipmentConfirmationEmail.ts and
 * lib/cancellationOutcomeEmail.ts do. The Stripe customer email is
 * deliberately NOT used: it is whatever was typed into Checkout and can
 * diverge from the order's own record, and this repository has always
 * treated the snapshot as canonical.
 *
 * ── THE WATERMARK, NOT A FLAG ─────────────────────────────────
 *
 * refund_email_notified_total_cents records the cumulative total the
 * customer has been told about. The claim below wins only when
 * refunded_total_cents is strictly greater, so:
 *
 *   a first settled refund      -> sends
 *   the same fact again         -> mails nothing
 *   a second, larger refund     -> sends again
 *   full after partial          -> sends again
 *
 * The watermark advances only on success, so a failed send leaves the
 * same fact owed rather than swallowing it.
 *
 * ── IT NEVER THROWS, AND THAT IS A DELIBERATE DEPARTURE ───────
 *
 * lib/orderConfirmationEmail.ts and lib/internalOrderNotificationEmail.ts
 * both THROW on a send failure, so the Stripe webhook returns 500, the
 * event is never recorded, and Stripe's redelivery schedule becomes the
 * email's retry schedule. That pattern is correct for them and would be
 * actively harmful here.
 *
 * The reason is the eligibility gate. This email fires only when
 * apply_order_refund_state reported 'applied' - a genuinely new fact. On
 * a Stripe redelivery the sync runs again, finds the absolute total
 * already applied, and returns 'unchanged'. So the redelivery would NOT
 * re-attempt the email: the 500 would buy nothing, and would merely
 * re-run money-state reconciliation and pile up retries for an email that
 * can no longer be triggered that way.
 *
 * So the outcome is returned as data, the row records 'failed', and the
 * refund state - which is durable, authoritative and already correct - is
 * untouched. 'failed' is the one state a future retry may key on. This
 * matches lib/shipmentConfirmationEmail.ts and
 * lib/cancellationOutcomeEmail.ts, both of which report rather than
 * throw for the same underlying reason: their caller must not be failed
 * by a mail provider.
 */

/** The columns one refund confirmation is rebuilt from. */
const ORDER_COLUMNS =
  "id, order_number, user_id, customer_snapshot, currency, total_gross_cents, " +
  "payment_status, refunded_total_cents, " +
  "refund_email_status, refund_email_notified_total_cents";

type OrderRow = {
  id: string;
  order_number: string;
  user_id: string | null;
  customer_snapshot: unknown;
  currency: string;
  total_gross_cents: number;
  payment_status: string;
  refunded_total_cents: number | null;
  refund_email_status: string | null;
  refund_email_notified_total_cents: number | null;
};

type ClaimOutcome = "claimed" | "taken" | "error";

/**
 * Atomically claims the right to announce this cumulative refund total.
 *
 * Only one caller can win it. Postgres row locking serialises concurrent
 * updates to one row, so a second worker sees the row already moved to
 * 'sending' and gets zero rows back.
 *
 * IT REPEATS EVERY HALF OF THE ELIGIBILITY RULE IN SQL, not just the
 * status:
 *
 *   payment_status in ('partially_refunded','refunded')
 *       money genuinely settled back - never 'refund_pending', never the
 *       'paid' a failed or cancelled refund self-heals to
 *   refunded_total_cents > <the total this attempt is announcing>  ... no:
 *       gte the value we read, see below
 *   refund_email_status is null / 'sent' / 'failed'
 *       'sending' is another worker's claim
 *
 * The watermark comparison cannot be expressed as a column-to-column
 * predicate through PostgREST, so it is applied two ways instead: in code
 * by isRefundEmailOwed before the claim, and here by pinning the claim to
 * the exact total that was read - `refunded_total_cents = total`. If a
 * concurrent refund sync moved the total between the read and the claim,
 * this matches zero rows and the attempt yields "taken" rather than
 * announcing a stale amount. The newer total is then announced by
 * whichever call observed it.
 */
async function claimRefundEmail(orderId: string, refundedTotalCents: number): Promise<ClaimOutcome> {
  const admin = getSupabaseAdmin();
  if (!admin) return "error";

  const { data, error } = await admin
    .from("orders")
    .update({ refund_email_status: "sending" })
    .eq("id", orderId)
    // Money genuinely settled back. Defence in depth against the row
    // changing between the read and the write.
    .in("payment_status", ["partially_refunded", "refunded"])
    // Pinned to the exact total this attempt intends to announce, so a
    // concurrently-updated total can never be described by a stale
    // message.
    .eq("refunded_total_cents", refundedTotalCents)
    // Not currently held by another worker. 'sent' IS claimable here -
    // the watermark, not the status, is what stops a duplicate.
    .or("refund_email_status.is.null,refund_email_status.eq.sent,refund_email_status.eq.failed")
    .select("id");

  if (error) {
    console.error(`Refund confirmation: claim failed for order ${orderId}:`, error.message);
    return "error";
  }
  return (data?.length ?? 0) > 0 ? "claimed" : "taken";
}

/**
 * Records that Resend accepted the message AND advances the watermark.
 *
 * The two writes are one statement on purpose. The watermark is what
 * stops this exact fact being announced twice, so it must land at the
 * same moment 'sent' does - a 'sent' row with a stale watermark would be
 * immediately eligible again and would duplicate the email.
 *
 * Deliberately NOT conditional on the row still saying 'sending'. 'sent'
 * records that the provider accepted it, which is true whatever the row
 * says by then, and suppressing the write would invite a duplicate rather
 * than prevent one. The same asymmetry the other five senders have.
 */
async function markSent(orderId: string, notifiedTotalCents: number): Promise<void> {
  const admin = getSupabaseAdmin();
  if (!admin) return;
  const { error } = await admin
    .from("orders")
    .update({
      refund_email_status: "sent",
      refund_email_sent_at: new Date().toISOString(),
      refund_email_notified_total_cents: notifiedTotalCents,
    })
    .eq("id", orderId);
  if (error) console.error(`Refund confirmation: mark-sent failed for order ${orderId}:`, error.message);
}

/**
 * Returns a claimed send to 'failed' - the one state a future retry may
 * key on.
 *
 * THE WATERMARK IS DELIBERATELY NOT TOUCHED. It still holds whatever the
 * customer was last successfully told, so the fact this attempt failed to
 * deliver remains owed and a later attempt announces exactly that total
 * rather than skipping past it.
 *
 * CONDITIONAL ON STILL BEING 'sending', for the same reason every other
 * sender's mark-failed is: writing 'failed' over a 'sent' row would
 * invite the very duplicate this mechanism exists to prevent.
 *
 * IT NEVER TOUCHES payment_status, refunded_total_cents OR
 * refund_updated_at, and it must never learn to. The money went back
 * whatever the mail provider did, and migration 033's column-scoped grant
 * means this code could not restate it even if it tried.
 */
async function markFailed(orderId: string): Promise<void> {
  const admin = getSupabaseAdmin();
  if (!admin) return;
  const { error } = await admin
    .from("orders")
    .update({ refund_email_status: "failed" })
    .eq("id", orderId)
    .eq("refund_email_status", "sending");
  if (error) console.error(`Refund confirmation: mark-failed failed for order ${orderId}:`, error.message);
}

/**
 * The recipient, taken from the order's own frozen customer_snapshot.
 *
 * Not a parameter, deliberately, and identical to the other two customer
 * senders. The address is a property of the durable order, read back at
 * send time. A Stripe payload email, a request-body email and a
 * client-supplied recipient all have nowhere to enter, because no
 * parameter for one exists.
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
 * Sends the refund confirmation for one order, at most once per settled
 * cumulative total, if and only if the durable order genuinely records
 * money having gone back.
 *
 * MUST be called strictly AFTER syncOrderRefundStateFromStripe has
 * committed, and only when it reported a genuinely new fact - see
 * isNewSettledRefundFact. It reads the row back for itself rather than
 * trusting anything the caller learned, so calling it too early cannot
 * produce a message about a refund that has not settled: the claim would
 * match zero rows and the outcome would be "not-eligible".
 */
export async function sendRefundConfirmationIfNeeded(orderId: string): Promise<RefundEmailSendResult> {
  const admin = getSupabaseAdmin();
  if (!admin) {
    console.error("Refund confirmation: SUPABASE_SECRET_KEY is not configured.");
    return "failed";
  }

  const { data, error } = await admin
    .from("orders")
    .select(ORDER_COLUMNS)
    .eq("id", orderId)
    .maybeSingle();

  if (error) {
    console.error(`Refund confirmation: load failed for order ${orderId}:`, error.message);
    return "failed";
  }
  // A missing order is not an error worth a stack trace, and it must not
  // be distinguishable from an ineligible one to anything upstream.
  if (!data) return "not-eligible";

  const order = data as unknown as OrderRow;

  // The code half of the guarantee: settled money, a total newer than the
  // watermark, and no competing claim. The claim below repeats all of it
  // in SQL.
  if (!isRefundEmailOwed(order)) return "already-sent";

  const refundedTotalCents = order.refunded_total_cents as number;

  const claim = await claimRefundEmail(order.id, refundedTotalCents);
  if (claim === "error") return "failed";
  if (claim === "taken") return "already-sent";

  return deliverClaimedRefundConfirmation(order, refundedTotalCents);
}

/**
 * Renders and sends a confirmation whose claim has ALREADY been won, and
 * records the outcome on the order.
 *
 * Split out so that a retry sweep, should one ever be built, reuses this
 * exact send and these exact state writes rather than growing a second
 * copy for the recipient, the template and the watermark to drift apart
 * in. Such a sweep must bring its own, stricter claim - 'failed' only,
 * never NULL and never 'sent' - which is what isRefundEmailSweepEligible
 * expresses.
 */
async function deliverClaimedRefundConfirmation(
  order: OrderRow,
  refundedTotalCents: number
): Promise<RefundEmailSendResult> {
  const customerEmail = recipientFromSnapshot(order.customer_snapshot);
  if (!customerEmail) {
    // Order id only. A missing address is not a reason to log whatever
    // the snapshot did contain. The refund stands; there is simply nobody
    // to tell by email, and the account page shows it either way.
    console.error(`Refund confirmation: order ${order.id} has no customer email to send to.`);
    await markFailed(order.id);
    return "failed";
  }

  const resend = getResendClient();
  if (!resend) {
    console.error("Refund confirmation: RESEND_API_KEY is not configured.");
    await markFailed(order.id);
    return "failed";
  }

  const { subject, html, text } = buildRefundConfirmationEmail({
    order: {
      order_number: order.order_number,
      // Derived from the persisted amounts by the same comparison
      // apply_order_refund_state uses, so the email and the account page
      // can never disagree about whether this was partial or full.
      kind: refundKind(refundedTotalCents, order.total_gross_cents),
      refundedTotalCents,
      originalTotalGrossCents: order.total_gross_cents,
      // The order's own currency, never a hardcoded 'EUR'.
      currency: order.currency,
      accountOrderUrl: buildAccountOrderUrl(order.id, order.user_id),
    },
  });

  // The provider-side half of the duplicate guard. Keyed on the order AND
  // the cumulative total, because one order can legitimately owe several
  // of these - see the long note on the key itself.
  const idempotencyKey = refundConfirmationIdempotencyKey(order.id, refundedTotalCents);

  let sendErrorMessage: string | null = null;
  try {
    const { error } = await resend.emails.send(
      {
        // The established customer transactional convention: the brand
        // voice sends, the order desk takes replies. Identical to the
        // order confirmation, the shipment confirmation and the
        // cancellation outcome.
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
    // customer's name, or the amount - a failed send is not a reason to
    // put a customer's money into a log line.
    console.error(`Refund confirmation: send failed for order ${order.id}:`, sendErrorMessage);
    await markFailed(order.id);
    return "failed";
  }

  // Success advances the watermark in the same statement that records
  // 'sent'. The refund state itself is untouched.
  await markSent(order.id, refundedTotalCents);
  return "sent";
}
