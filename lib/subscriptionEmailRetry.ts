import { getSupabaseAdmin } from "./supabaseAdmin";
import { deliverClaimedSubscriptionStarted } from "./subscriptionStartedEmail";
import { deliverClaimedCancellationConfirmation } from "./cancellationConfirmationEmail";
import { deliverClaimedSubscriptionEnded } from "./subscriptionEndedEmail";
import {
  emptySubscriptionFamilySummary,
  inspectStaleSubscriptionEmailDeliveries,
  runSubscriptionFamilyRetry,
  staleSubscriptionSendingCutoff,
  CANCELLATION_CONFIRMATION_FAMILY,
  STALE_SENDING_DIAGNOSTIC_LIMIT,
  SUBSCRIPTION_EMAIL_RETRY_FAMILIES,
  SUBSCRIPTION_ENDED_FAMILY,
  SUBSCRIPTION_STARTED_FAMILY,
  type SubscriptionEmailDeliveryRow,
  type SubscriptionEmailFamilySummary,
  type SubscriptionEmailRetryOutcome,
  type SubscriptionEmailRetryPort,
} from "./subscriptionEmailDeliveryRules";

/**
 * Automatic retry for the three subscription lifecycle emails
 * (Phase 3H.5B2).
 *
 * The database half of what the pure rules in
 * lib/subscriptionEmailDeliveryRules.ts orchestrate, plus the cron entry
 * point. It runs inside the existing authenticated cron route; there is
 * no second cron, no new schedule and no new infrastructure.
 *
 * ══════════════════════════════════════════════════════════════
 * IT SELECTS 'failed' AND NOTHING ELSE.
 * ══════════════════════════════════════════════════════════════
 *
 * Phase 3H.5B1 is what makes that safe. Before it, 'failed' was written
 * for a lost connection and a timeout as readily as for a rejection, so
 * retrying it could have re-sent a message Resend had already accepted.
 * Now 'failed' means the application PROVED non-acceptance, and a proven
 * non-acceptance is safe to retry a day or a week later - the provider's
 * 24-hour idempotency window is irrelevant, because there is no earlier
 * accepted message to deduplicate against.
 *
 * 'sending' is REPORTED, never retried and never mutated. See
 * inspectStaleSubscriptionEmailDeliveries.
 *
 * ── IT CANNOT CREATE A DELIVERY ROW ───────────────────────────
 *
 * There is no insert and no upsert in this module. The port exposes a
 * select, a compare-and-swap and a family send, and that is all it can
 * do. A subscription that predates these features, or one whose lifecycle
 * writer never claimed anything, is unreachable from here - so historical
 * replay is structurally impossible rather than merely forbidden.
 *
 * ── IT REUSES THE SENDERS RATHER THAN COPYING THEM ────────────
 *
 * Each family's retry is the sender's own deliverClaimed* function: the
 * same authoritative preflight, the same template, the same deterministic
 * provider idempotency key, the same provider outcome classifier and the
 * same three state transitions. Nothing about a retried message differs
 * from the original attempt except when it happened.
 *
 * The public sendXIfNeeded entry points are deliberately NOT used: each
 * begins with an INSERT ... ON CONFLICT DO NOTHING, which against a row
 * that already exists returns zero rows and would report "already
 * claimed" forever. A retry starts from the row, not from the event.
 */

/** The columns the sweep needs. No customer data of any kind. */
const DELIVERY_COLUMNS = "id, subscription_id, family, event_key";

/** One family's counters, keyed by the family name migration 035 uses. */
export type SubscriptionEmailRetrySummary = {
  errored: boolean;
  families: Record<string, SubscriptionEmailFamilySummary>;
};

export function emptySubscriptionEmailRetrySummary(
  errored = false
): SubscriptionEmailRetrySummary {
  const families: Record<string, SubscriptionEmailFamilySummary> = {};
  for (const family of SUBSCRIPTION_EMAIL_RETRY_FAMILIES) {
    families[family] = emptySubscriptionFamilySummary();
  }
  return { errored, families };
}

/**
 * Dispatches one claimed delivery to its own family's sender.
 *
 * FAILS CLOSED on anything unrecognised. Migration 035's CHECK already
 * refuses an unknown family at the database, so reaching the default here
 * would mean the schema and this code had diverged - which is the last
 * moment to guess which customer message a row represents.
 */
async function retryClaimedDelivery(
  row: SubscriptionEmailDeliveryRow
): Promise<SubscriptionEmailRetryOutcome> {
  switch (row.family) {
    case SUBSCRIPTION_STARTED_FAMILY:
      return normalize(await deliverClaimedSubscriptionStarted(row.subscription_id, row.id));
    case CANCELLATION_CONFIRMATION_FAMILY:
      // The delivery row's OWN event key, so the preflight re-proves that
      // the persisted cancellation pair still reconstructs this exact
      // event. A cancellation that was cleared, moved or re-requested
      // supersedes this row instead of mailing a stale date.
      return normalize(
        await deliverClaimedCancellationConfirmation(row.subscription_id, row.event_key, row.id)
      );
    case SUBSCRIPTION_ENDED_FAMILY:
      return normalize(await deliverClaimedSubscriptionEnded(row.subscription_id, row.id));
    default:
      throw new Error(`unknown subscription email family: ${row.family}`);
  }
}

/**
 * The senders share four outcomes with the sweep and can additionally
 * answer "not-eligible" or "already-claimed" from paths a retry cannot
 * reach. Anything unexpected is counted as ambiguous, which is the safe
 * direction: it writes nothing.
 */
function normalize(result: string): SubscriptionEmailRetryOutcome {
  if (result === "sent" || result === "failed" || result === "superseded") return result;
  return "ambiguous";
}

/** The real database port. Select, compare-and-swap, send. Nothing else. */
export function subscriptionEmailRetryPort(): SubscriptionEmailRetryPort | null {
  const admin = getSupabaseAdmin();
  if (!admin) return null;

  return {
    /**
     * One family's failed rows, oldest first.
     *
     * Filtered on 'failed' in SQL as well as in the rules, and ordered by
     * updated_at so the oldest owed message is attempted first. Migration
     * 035's partial index on (family, updated_at) where status = 'failed'
     * serves exactly this query.
     */
    loadFailed: async (family, limit) => {
      const { data, error } = await admin
        .from("subscription_email_deliveries")
        .select(DELIVERY_COLUMNS)
        .eq("family", family)
        .eq("status", "failed")
        .order("updated_at", { ascending: true })
        .limit(limit);

      if (error) throw new Error(`failed-delivery lookup failed: ${error.message}`);
      return (data as SubscriptionEmailDeliveryRow[] | null) ?? [];
    },

    /**
     * The compare-and-swap. THE RACE GUARD, and the database decides it.
     *
     * Matched on the id AND on status = 'failed', so two workers that both
     * selected the same row cannot both win: the second matches zero rows.
     * There is no select-then-update anywhere.
     *
     * Only `status` is written. subscription_id, family, event_key,
     * created_at and updated_at are not, and migration 035 would refuse
     * them anyway - the trigger stamps updated_at itself.
     */
    claimFailed: async deliveryId => {
      const { data, error } = await admin
        .from("subscription_email_deliveries")
        .update({ status: "sending" })
        .eq("id", deliveryId)
        .eq("status", "failed")
        .select("id");

      if (error) throw new Error(`retry claim failed: ${error.message}`);
      return (data?.length ?? 0) > 0;
    },

    retryClaimed: retryClaimedDelivery,

    /**
     * Stale 'sending' rows. A SELECT, and only ever a SELECT.
     *
     * Ids only: the subscription id, the recipient and the event key are
     * all customer facts and none of them is needed to find a row.
     */
    loadStaleSending: async (family, cutoffIso, limit) => {
      const { data, error } = await admin
        .from("subscription_email_deliveries")
        .select("id")
        .eq("family", family)
        .eq("status", "sending")
        .lte("updated_at", cutoffIso)
        .order("updated_at", { ascending: true })
        .limit(limit);

      if (error) throw new Error(`stale-sending lookup failed: ${error.message}`);
      return (data as { id: string }[] | null) ?? [];
    },

    logFailure: (deliveryId, message) => {
      // Delivery uuid and a message. Never a recipient, a name, a plan or
      // a subscription id.
      console.error(`Subscription email retry: delivery ${deliveryId} failed:`, message);
    },
  };
}

/**
 * Runs the whole subscription email sweep: three families, each with its
 * own bounded budget, then the read-only stale report.
 *
 * ── FAMILY FAIRNESS ───────────────────────────────────────────
 *
 * Three independent buckets of 25, never one shared budget. A backlog of
 * failed start messages cannot delay a cancellation confirmation or an
 * ending, because they are not competing for the same limit.
 *
 * ── ONE PROVIDER ATTEMPT PER ROW PER RUN ──────────────────────
 *
 * Each family's candidate list is read once and iterated once. A row this
 * run returns to 'failed' is not re-selected until the next cron run, so
 * a permanently rejected address costs one attempt a day rather than
 * twenty-five in a row. There is no while-loop over the work list.
 */
export async function runSubscriptionEmailRetrySweep(
  deps?: { port?: SubscriptionEmailRetryPort | null; now?: () => number }
): Promise<SubscriptionEmailRetrySummary> {
  const port = deps?.port !== undefined ? deps.port : subscriptionEmailRetryPort();
  if (!port) {
    console.error("Subscription email retry: SUPABASE_SECRET_KEY is not configured.");
    return emptySubscriptionEmailRetrySummary(true);
  }

  const summary = emptySubscriptionEmailRetrySummary();
  const cutoff = staleSubscriptionSendingCutoff((deps?.now ?? Date.now)());

  for (const family of SUBSCRIPTION_EMAIL_RETRY_FAMILIES) {
    const familySummary = summary.families[family];

    // Per family isolation: one family's outage must not cost the other
    // two their run, and the stale report must still be attempted.
    try {
      await runSubscriptionFamilyRetry(port, family, familySummary);
    } catch (err) {
      familySummary.errors += 1;
      console.error(
        `Subscription email retry: ${family} sweep failed:`,
        err instanceof Error ? err.message : "unknown error"
      );
    }

    try {
      await inspectStaleSubscriptionEmailDeliveries(port, family, cutoff, familySummary);
    } catch (err) {
      familySummary.errors += 1;
      console.error(
        `Subscription email retry: ${family} stale inspection failed:`,
        err instanceof Error ? err.message : "unknown error"
      );
    }
  }

  return summary;
}

/** Re-exported so the cron route needs one import for the bound. */
export { STALE_SENDING_DIAGNOSTIC_LIMIT };
