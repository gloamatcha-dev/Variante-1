import { getSupabaseAdmin } from "./supabaseAdmin";
import { runInternalOrderNotificationCron } from "./internalOrderNotificationRetry";
import { sendOrderConfirmationEmailIfNeeded } from "./orderConfirmationEmail";
import { sendShipmentConfirmationIfNeeded } from "./shipmentConfirmationEmail";
import { sendCancellationRequestNotificationIfNeeded } from "./cancellationRequestNotificationEmail";
import { sendCancellationOutcomeEmailIfNeeded } from "./cancellationOutcomeEmail";
import { sendRefundConfirmationIfNeeded } from "./refundConfirmationEmail";
import type { AddressSnapshot } from "./orderAddressSnapshot";
import type { OrderConfirmationItem } from "./email/orderConfirmation";
import {
  EMAIL_FAMILY_STATUS_COLUMNS,
  RETRY_BATCH_LIMIT,
  STALE_RECOVERY_BATCH_LIMIT,
  emptyFamilySummary,
  runFamily,
  staleSendingCutoff,
  type EmailRetryFamilyPort,
  type EmailRetryFamilySummary,
  type EmailSendResult,
  type RetryCandidateRow,
  type StaleCandidateRow,
  type StaleRecoveryOutcome,
  type TransactionalEmailRetrySummary,
} from "./transactionalEmailRetryRules";

/**
 * Gives the transactional email retry rules a database and the six
 * existing senders, and nothing else (Phase 2E-B).
 *
 * ══════════════════════════════════════════════════════════════
 * WHAT THIS IS AND IS NOT
 * ══════════════════════════════════════════════════════════════
 *
 * It is a safety net for FAILED DELIVERY ONLY. It creates no order,
 * cancels nothing, resolves no cancellation request, ships nothing,
 * creates and alters no refund, and calls no Stripe API of any kind -
 * there is no Stripe import in this file or in the rules module. Every
 * row it touches is one that already carries a durable 'failed' from
 * code that genuinely tried to send and genuinely failed.
 *
 * It also writes no business state. It performs exactly two kinds of
 * write, both through machinery that already existed:
 *
 *   1. the stale recovery below, which moves ONE column from 'sending'
 *      back to 'failed' and touches nothing else
 *   2. whatever the existing senders write, which migrations 017, 026,
 *      027, 030, 031 and 033 have already constrained to thirteen
 *      email-state columns through column-scoped grants
 *
 * status, fulfillment_status, payment_status, refunded_total_cents,
 * refund_updated_at, cancelled_at, every cancellation column, shipped_at,
 * the tracking columns, every money and tax column and every snapshot are
 * outside its reach - enforced by the database, not by this comment.
 *
 * ══════════════════════════════════════════════════════════════
 * WHY THE INTERNAL NOTIFICATION KEEPS ITS OWN SWEEP
 * ══════════════════════════════════════════════════════════════
 *
 * Five of the six families are driven by the generic loop in the rules
 * module. The internal new-order notification is not: it delegates,
 * unchanged, to runInternalOrderNotificationCron().
 *
 * That is deliberate rather than lazy. Its message cannot be rebuilt from
 * the order row alone - the fulfillment inbox needs the frozen line items
 * off the originating checkout attempt - so its sweep carries a
 * reconstruction step and a sender signature that the others do not
 * share. It is also the one piece of this infrastructure that has been
 * live and proven. Rewriting it into a shape that matched the other five
 * would have been a large change to working code for a cosmetic gain,
 * and would have put the one battle-tested sweep at risk to tidy up the
 * five new ones.
 *
 * ══════════════════════════════════════════════════════════════
 * WHY ORDER CONFIRMATION NEEDS AN ADAPTER
 * ══════════════════════════════════════════════════════════════
 *
 * sendOrderConfirmationEmailIfNeeded takes a built params object rather
 * than an order id, and it THROWS on failure, because it was written to
 * ride Stripe's webhook redelivery. Both are handled by the small adapter
 * below rather than by changing that sender: it is on the paid-order
 * path, it is the most load-bearing email in the system, and a retry
 * feature has no business editing it.
 *
 * The adapter rebuilds the message from persisted data and from nothing
 * else - the frozen items_snapshot on the checkout attempt, and the
 * order's own customer_snapshot for the recipient. Nothing is re-priced,
 * nothing is re-quoted, and Stripe is not consulted: a retry days later
 * must describe the order that exists, not what the shop sells today.
 */

/** How the cron reports one family it could not even attempt. */
function erroredSummary(): EmailRetryFamilySummary {
  return { ...emptyFamilySummary(), errored: true };
}

/**
 * Builds the port for one of the four order-id-only families.
 *
 * The column name is the only thing that differs between them, which is
 * the whole reason the generic loop is worth having.
 *
 * SELECTION IS `<column> = 'failed'` AND NOTHING ELSE. Never a NULL
 * check, never a sent_at check, never a watermark check. See the long
 * note in the rules module for why that is not negotiable.
 *
 * Ordering is least-recently-updated first, so a backlog larger than one
 * batch drains oldest-first across successive days rather than starving
 * the same rows forever.
 */
function buildPort(
  statusColumn: string,
  label: string,
  send: (orderId: string) => Promise<EmailSendResult>
): EmailRetryFamilyPort {
  return {
    loadStaleSending: async (cutoffIso: string): Promise<StaleCandidateRow[]> => {
      const admin = getSupabaseAdmin();
      if (!admin) throw new Error("supabase admin client is not configured");

      const { data, error } = await admin
        .from("orders")
        .select(`id, updated_at, ${statusColumn}`)
        .eq(statusColumn, "sending")
        .lte("updated_at", cutoffIso)
        .order("updated_at", { ascending: true })
        .limit(STALE_RECOVERY_BATCH_LIMIT);

      if (error) throw new Error(`stale work list failed: ${error.message}`);

      return (data ?? []).map(row => {
        const r = row as unknown as Record<string, unknown>;
        return {
          id: String(r.id),
          status: typeof r[statusColumn] === "string" ? (r[statusColumn] as string) : null,
          updated_at: typeof r.updated_at === "string" ? r.updated_at : null,
        };
      });
    },

    /**
     * The conditional write. It re-checks BOTH that the row still says
     * 'sending' AND that its updated_at is still at or before the same
     * cutoff, in one statement, so a worker that finished between the
     * read and the write keeps its result.
     *
     * It writes exactly one column. No sent_at, no watermark, no
     * business state.
     */
    recoverStale: async (orderId: string, cutoffIso: string): Promise<StaleRecoveryOutcome> => {
      const admin = getSupabaseAdmin();
      if (!admin) throw new Error("supabase admin client is not configured");

      const { data, error } = await admin
        .from("orders")
        .update({ [statusColumn]: "failed" })
        .eq("id", orderId)
        .eq(statusColumn, "sending")
        .lte("updated_at", cutoffIso)
        .select("id");

      if (error) throw new Error(`stale recovery failed: ${error.message}`);
      return (data?.length ?? 0) > 0 ? "recovered" : "skipped";
    },

    loadFailed: async (): Promise<RetryCandidateRow[]> => {
      const admin = getSupabaseAdmin();
      if (!admin) throw new Error("supabase admin client is not configured");

      const { data, error } = await admin
        .from("orders")
        .select(`id, ${statusColumn}`)
        .eq(statusColumn, "failed")
        .order("updated_at", { ascending: true })
        .limit(RETRY_BATCH_LIMIT);

      if (error) throw new Error(`failed work list failed: ${error.message}`);

      return (data ?? []).map(row => {
        const r = row as unknown as Record<string, unknown>;
        return {
          id: String(r.id),
          status: typeof r[statusColumn] === "string" ? (r[statusColumn] as string) : null,
        };
      });
    },

    send,

    // The order id and the provider's message. Never a recipient, a name,
    // an address, an amount or a cancellation note.
    logFailure: (orderId: string, message: string) => {
      console.error(`Transactional email retry (${label}): ${orderId}: ${message}`);
    },
  };
}

/* ══════════════════════════════════════════════════════════════
   ORDER CONFIRMATION: RECONSTRUCTION FROM DURABLE DATA
   ══════════════════════════════════════════════════════════════ */

const CONFIRMATION_ORDER_COLUMNS =
  "id, order_number, user_id, subtotal_gross_cents, shipping_gross_cents, total_gross_cents, " +
  "shipping_address_snapshot, customer_snapshot, checkout_attempt_id, confirmation_email_status";

type ConfirmationOrderRow = {
  id: string;
  order_number: string;
  user_id: string | null;
  subtotal_gross_cents: number;
  shipping_gross_cents: number | null;
  total_gross_cents: number;
  shipping_address_snapshot: AddressSnapshot | null;
  customer_snapshot: unknown;
  checkout_attempt_id: string | null;
};

type ConfirmationItemSnapshot = {
  productName: string;
  variantLabel: string;
  quantity: number;
  unitGrossCents: number;
  lineGrossCents: number;
};

/**
 * Retries one order confirmation, rebuilt from persisted rows.
 *
 * Returns rather than throws, so it satisfies the generic loop's
 * contract even though the sender it wraps does throw.
 *
 * "not-eligible" is used for the two cases where a retry can never
 * succeed and must not be counted as a failure: an order with no frozen
 * line items to describe, and an order whose snapshot holds no recipient.
 * Both leave the row at 'failed', which means the sweep will look at them
 * again tomorrow and reach the same conclusion - noisy but harmless, and
 * strictly better than inventing a line item or an address. The sender
 * itself already refuses a missing recipient the same way.
 */
async function retryOrderConfirmation(orderId: string): Promise<EmailSendResult> {
  const admin = getSupabaseAdmin();
  if (!admin) return "failed";

  const { data, error } = await admin
    .from("orders")
    .select(CONFIRMATION_ORDER_COLUMNS)
    .eq("id", orderId)
    .maybeSingle();

  if (error) {
    console.error(`Transactional email retry (orderConfirmation): load failed for ${orderId}.`);
    return "failed";
  }
  if (!data) return "not-eligible";

  const order = data as unknown as ConfirmationOrderRow;

  if (!order.checkout_attempt_id) return "not-eligible";

  const { data: attempt, error: attemptError } = await admin
    .from("checkout_attempts")
    .select("items_snapshot")
    .eq("id", order.checkout_attempt_id)
    .maybeSingle();

  if (attemptError) {
    console.error(`Transactional email retry (orderConfirmation): attempt load failed for ${orderId}.`);
    return "failed";
  }
  if (!attempt) return "not-eligible";

  const snapshot = (attempt as { items_snapshot?: unknown }).items_snapshot;
  const raw = (Array.isArray(snapshot) ? snapshot : []) as ConfirmationItemSnapshot[];
  if (raw.length === 0) return "not-eligible";

  // Exactly the five fields the customer template takes - the same
  // mapping the webhook call site makes, from the same frozen snapshot.
  const items: OrderConfirmationItem[] = raw.map(item => ({
    productName: item.productName,
    variantLabel: item.variantLabel,
    quantity: item.quantity,
    unitGrossCents: item.unitGrossCents,
    lineGrossCents: item.lineGrossCents,
  }));

  // The order's own frozen snapshot, which is what
  // create_order_from_paid_checkout persisted from the Checkout session.
  // Never a Stripe payload and never a caller's value.
  const customer = (order.customer_snapshot ?? {}) as { email?: unknown };
  const customerEmail = typeof customer.email === "string" ? customer.email.trim() || null : null;
  if (!customerEmail) return "not-eligible";

  try {
    await sendOrderConfirmationEmailIfNeeded({
      order: {
        id: order.id,
        order_number: order.order_number,
        user_id: order.user_id,
        subtotal_gross_cents: order.subtotal_gross_cents,
        shipping_gross_cents: order.shipping_gross_cents,
        total_gross_cents: order.total_gross_cents,
        shipping_address_snapshot: order.shipping_address_snapshot,
      },
      items,
      customerEmail,
    });
    return "sent";
  } catch {
    // The sender has already written 'failed' before throwing, and it has
    // already logged the provider's message without any customer fact.
    // Nothing is added here beyond the count.
    return "failed";
  }
}

/* ══════════════════════════════════════════════════════════════
   THE CRON ORCHESTRATION
   ══════════════════════════════════════════════════════════════ */

/**
 * One bounded pass over every family's failed transactional emails.
 *
 * FAILURE ISOLATION IS THE POINT OF THE SHAPE. Each family runs inside
 * its own try/catch and reports its own counters, so a database hiccup
 * while reading the refund work list cannot stop the shipment
 * confirmations from being retried, and one order that will never send
 * cannot block the twenty-four behind it. A family that could not run at
 * all reports errored: true rather than a clean-looking set of zeroes.
 *
 * The cutoff is computed once for the whole run, so all six families
 * judge staleness against exactly the same instant.
 */
export async function runTransactionalEmailRetryCron(): Promise<TransactionalEmailRetrySummary> {
  const cutoffIso = staleSendingCutoff(Date.now());

  // The internal new-order notification keeps its own proven sweep. Its
  // summary shape predates this task, so it is mapped rather than
  // reshaped - the live code is not edited to make a report tidier.
  let internalOrder: EmailRetryFamilySummary;
  try {
    const legacy = await runInternalOrderNotificationCron();
    internalOrder = {
      staleFound: legacy.staleFound,
      staleRecovered: legacy.staleRecovered,
      eligible: legacy.processed,
      attempted: legacy.processed - legacy.skipped,
      sent: legacy.sent,
      failed: legacy.failed,
      skipped: legacy.skipped,
      errored: false,
    };
  } catch (err) {
    console.error(
      "Transactional email retry (internalOrder): sweep failed:",
      err instanceof Error ? err.message : "unknown error"
    );
    internalOrder = erroredSummary();
  }

  const orderConfirmation = await runFamily(
    buildPort(EMAIL_FAMILY_STATUS_COLUMNS.orderConfirmation, "orderConfirmation", retryOrderConfirmation),
    cutoffIso
  );

  const shipment = await runFamily(
    buildPort(EMAIL_FAMILY_STATUS_COLUMNS.shipment, "shipment", sendShipmentConfirmationIfNeeded),
    cutoffIso
  );

  const cancellationRequest = await runFamily(
    buildPort(
      EMAIL_FAMILY_STATUS_COLUMNS.cancellationRequest,
      "cancellationRequest",
      sendCancellationRequestNotificationIfNeeded
    ),
    cutoffIso
  );

  const cancellationOutcome = await runFamily(
    buildPort(
      EMAIL_FAMILY_STATUS_COLUMNS.cancellationOutcome,
      "cancellationOutcome",
      sendCancellationOutcomeEmailIfNeeded
    ),
    cutoffIso
  );

  // The refund family needs no special selection: it starts from
  // refund_email_status = 'failed' like the rest, and
  // sendRefundConfirmationIfNeeded then re-validates the durable refund
  // state for itself. That re-validation is what preserves the
  // multi-refund architecture - it announces whatever cumulative total is
  // currently owed against the watermark, not whatever total happened to
  // fail earlier, and a historical settled refund whose email state is
  // NULL is never selected here in the first place.
  const refund = await runFamily(
    buildPort(EMAIL_FAMILY_STATUS_COLUMNS.refund, "refund", sendRefundConfirmationIfNeeded),
    cutoffIso
  );

  return {
    ok: true,
    orderConfirmation,
    internalOrder,
    shipment,
    cancellationRequest,
    cancellationOutcome,
    refund,
  };
}
