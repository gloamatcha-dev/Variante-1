import { getSupabaseAdmin } from "./supabaseAdmin";
import { runInternalOrderNotificationCron } from "./internalOrderNotificationRetry";
import { sendShipmentConfirmationIfNeeded } from "./shipmentConfirmationEmail";
import { sendCancellationRequestNotificationIfNeeded } from "./cancellationRequestNotificationEmail";
import { sendCancellationOutcomeEmailIfNeeded } from "./cancellationOutcomeEmail";
import { sendRefundConfirmationIfNeeded } from "./refundConfirmationEmail";
import {
  AUTO_RETRY_STATUS_COLUMNS,
  RETRY_DISABLED_FAMILIES,
  RETRY_BATCH_LIMIT,
  STALE_RECOVERY_BATCH_LIMIT,
  disabledFamilySummary,
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
 * Gives the transactional email retry rules a database and five of the
 * six existing senders, and nothing else (Phase 2E-B, hotfixed in 2E-B.1).
 *
 * ══════════════════════════════════════════════════════════════
 * FIVE FAMILIES, NOT SIX
 * ══════════════════════════════════════════════════════════════
 *
 * The customer ORDER CONFIRMATION is excluded from automatic retry, and
 * the exclusion is total: this module never queries
 * confirmation_email_status, never recovers a stale confirmation
 * 'sending', never selects a confirmation 'failed', and never imports
 * sendOrderConfirmationEmailIfNeeded. The column name does not appear in
 * this file at all.
 *
 * Phase 2E-B included it and that was wrong. It is the only one of the six
 * senders that calls resend.emails.send WITHOUT a deterministic
 * { idempotencyKey }, so its whole duplicate guard is the database claim.
 * A 'sending' row therefore does not prove the message was never accepted
 * - the process can die between Resend accepting it and the 'sent' write
 * committing - and a 'failed' row carries the same ambiguity. Recovering
 * either and re-sending can put a second order confirmation in a
 * customer's inbox with nothing at the provider to stop it. Production
 * showed exactly that on the first manual invocation.
 *
 * BOTH halves are disabled, not just recovery: leaving the failed-only
 * sweep enabled would duplicate just as readily.
 *
 * See lib/transactionalEmailRetryRules.ts for what a future fix has to
 * account for - chiefly that adding a key today does not make yesterday's
 * keyless sends retryable.
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
 * THE PRODUCTION ROWS ARE LEFT EXACTLY AS THEY ARE
 * ══════════════════════════════════════════════════════════════
 *
 * At the time of the hotfix production held 390 confirmation rows at
 * 'pending', 15 at 'failed', 5 at 'sending' and 41 at 'sent'. This
 * change repairs none of them: no backfill, no reset, no re-send, no
 * deletion. It only stops the cron from looking at them. Deciding what
 * those 20 ambiguous rows deserve is an operator judgement about real
 * customers' inboxes, not something a code change should make silently.
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

  const shipment = await runFamily(
    buildPort(AUTO_RETRY_STATUS_COLUMNS.shipment, "shipment", sendShipmentConfirmationIfNeeded),
    cutoffIso
  );

  const cancellationRequest = await runFamily(
    buildPort(
      AUTO_RETRY_STATUS_COLUMNS.cancellationRequest,
      "cancellationRequest",
      sendCancellationRequestNotificationIfNeeded
    ),
    cutoffIso
  );

  const cancellationOutcome = await runFamily(
    buildPort(
      AUTO_RETRY_STATUS_COLUMNS.cancellationOutcome,
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
    buildPort(AUTO_RETRY_STATUS_COLUMNS.refund, "refund", sendRefundConfirmationIfNeeded),
    cutoffIso
  );

  return {
    ok: true,
    // Never run, never queried. Zero counters plus an explicit flag, so
    // the response says "switched off" rather than "nothing was owed".
    orderConfirmation: disabledFamilySummary(RETRY_DISABLED_FAMILIES.orderConfirmation),
    internalOrder,
    shipment,
    cancellationRequest,
    cancellationOutcome,
    refund,
  };
}
