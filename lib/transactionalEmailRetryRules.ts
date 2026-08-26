/**
 * The decision logic of the transactional email retry safety net
 * (Phase 2E-B).
 *
 * Pure and leaf: no relative imports, no database, no network, no clock,
 * no environment. The same choice lib/internalOrderNotificationRetryRules.ts
 * makes, and for the same reason - the plain Node test runner cannot
 * import a module that uses extension-less relative imports, so anything
 * worth testing behaviourally has to live in a file like this one.
 * lib/transactionalEmailRetry.ts is the thin wiring that gives these
 * rules a Supabase client and the six existing senders.
 *
 * ══════════════════════════════════════════════════════════════
 * THE ELIGIBILITY RULE IS THE WHOLE FEATURE
 * ══════════════════════════════════════════════════════════════
 *
 *     <status column> = 'failed'
 *
 * and nothing else, ever. Not NULL. Not "sent_at is null". Not "the
 * watermark is null". Not "the order looks like it should have had an
 * email by now".
 *
 * THIS IS ABSOLUTE, AND IT IS ABSOLUTE BECAUSE OF REAL PRODUCTION DATA.
 * The live database holds 451 orders. Every one of them predates most of
 * these email flows, so their status columns are NULL - migrations 026,
 * 027, 030, 031 and 033 each made their columns nullable with no default
 * precisely so that "this feature did not exist when this happened"
 * would be distinguishable from "queued work". One of those orders
 * carries a genuinely settled refund whose refund email state is entirely
 * NULL. A sweep keyed on anything but 'failed' would mail that customer
 * about money returned before the feature existed.
 *
 * 'failed' cannot be written by accident: it is only ever written by code
 * that genuinely tried to send and genuinely failed. That is what makes
 * it the one safe selector.
 *
 * 'sending' is not eligible - that row belongs to whoever claimed it.
 * 'sent' is not eligible - it is done.
 * 'pending' is not eligible - see the note on order confirmation below.
 *
 * ══════════════════════════════════════════════════════════════
 * WHY THIS MODULE EXISTS ALONGSIDE THE INTERNAL-NOTIFICATION ONE
 * ══════════════════════════════════════════════════════════════
 *
 * lib/internalOrderNotificationRetryRules.ts already solved this problem
 * for one email family, and its solution is not duplicated here: the
 * internal new-order notification keeps running through its own proven
 * sweep, unchanged, because it needs a reconstruction step (the
 * fulfillment inbox message is rebuilt from a checkout attempt's frozen
 * line items) that the others do not.
 *
 * What this module adds is the generic case. Four of the six senders
 * already take an order id and nothing else, re-read every fact from the
 * durable row themselves, and never throw - so retrying them is nothing
 * more than "find the failed rows, call the sender". This file is that
 * loop, once, rather than four near-copies of it.
 */

/** The one status any sweep may ever act on. */
export const RETRY_ELIGIBLE_STATUS = "failed";

/** The in-flight status. Owned by whichever worker won the claim. */
export const IN_FLIGHT_STATUS = "sending";

/**
 * How many failed rows one run may attempt PER FAMILY.
 *
 * Per family rather than globally, deliberately. A global cap would let
 * one noisy family - a hundred failed refund emails after a provider
 * outage - consume the entire budget and starve the other five
 * indefinitely, so a single customer's shipment confirmation could sit
 * unretried for days behind unrelated noise. Six independent buckets of
 * 25 means the worst any one family can do is exhaust its own.
 *
 * Matches RETRY_BATCH_LIMIT in lib/internalOrderNotificationRetryRules.ts,
 * asserted equal in the test suite. A ceiling, not a target: on a healthy
 * day nothing is eligible at all.
 */
export const RETRY_BATCH_LIMIT = 25;

/** How many stale rows one run may recover, per family. */
export const STALE_RECOVERY_BATCH_LIMIT = 25;

/**
 * How long a row may sit at 'sending' before it is presumed abandoned.
 *
 * Deliberately identical to STALE_SENDING_AFTER_MS in
 * lib/internalOrderNotificationRetryRules.ts, and asserted equal in the
 * test suite so the two cannot drift. The reasoning there applies
 * unchanged: a legitimate in-flight send lives inside one serverless
 * invocation, which the platform kills long before thirty minutes.
 *
 * A server-side constant, never a request parameter: a caller who could
 * shorten it could turn recovery into a duplicate-email generator.
 */
export const STALE_SENDING_AFTER_MS = 30 * 60 * 1000;

/**
 * The single eligibility predicate, applied in code as well as in SQL.
 *
 * The database query filters on the same status, and each sender's own
 * claim refuses anything else again - three independent refusals of a
 * historical NULL row, so no single mistake can produce an email about
 * an order from before these features existed.
 */
export function isRetryEligibleStatus(status: string | null | undefined): boolean {
  return status === RETRY_ELIGIBLE_STATUS;
}

/* ══════════════════════════════════════════════════════════════
   THE SIX FAMILIES
   ══════════════════════════════════════════════════════════════ */

export const EMAIL_FAMILY_KEYS = [
  "orderConfirmation",
  "internalOrder",
  "shipment",
  "cancellationRequest",
  "cancellationOutcome",
  "refund",
] as const;

export type EmailFamilyKey = (typeof EMAIL_FAMILY_KEYS)[number];

/**
 * Which durable column carries each family's delivery state.
 *
 * These are the exact column names migrations 017, 026, 027, 030, 031 and
 * 033 created. Nothing else on public.orders may ever appear here: the
 * sweep writes only through the senders, and the senders hold
 * column-scoped grants covering these thirteen columns and nothing more.
 */
export const EMAIL_FAMILY_STATUS_COLUMNS: Readonly<Record<EmailFamilyKey, string>> = Object.freeze({
  orderConfirmation: "confirmation_email_status",
  internalOrder: "internal_notification_status",
  shipment: "shipment_email_status",
  cancellationRequest: "cancellation_request_notification_status",
  cancellationOutcome: "cancellation_outcome_email_status",
  refund: "refund_email_status",
});

/**
 * ORDER CONFIRMATION IS THE ODD ONE, AND IT IS STILL SAFE.
 *
 * Migration 017 declared confirmation_email_status NOT NULL DEFAULT
 * 'pending', so unlike the other five it has no NULL rows at all - every
 * order ever created starts at 'pending'. That includes all 451 live
 * orders and every subscription-cycle order, which deliberately never
 * receives a customer confirmation and therefore sits at 'pending'
 * forever.
 *
 * The absolute rule covers this without a special case: a sweep keyed on
 * 'failed' cannot see 'pending'. What would have been catastrophic is a
 * sweep keyed on "not sent yet", which for this family would have meant
 * mailing the entire order history.
 */
export const NEVER_ELIGIBLE_STATUSES = ["pending", "sending", "sent"] as const;

export function isNeverEligibleStatus(status: string | null | undefined): boolean {
  if (status === null || status === undefined) return true;
  return (NEVER_ELIGIBLE_STATUSES as readonly string[]).includes(status);
}

/* ══════════════════════════════════════════════════════════════
   THE GENERIC SWEEP
   ══════════════════════════════════════════════════════════════ */

/**
 * What a sender reports back.
 *
 * Every sender this sweep drives already returns exactly this and never
 * throws - see lib/shipmentConfirmationEmail.ts,
 * lib/cancellationRequestNotificationEmail.ts,
 * lib/cancellationOutcomeEmail.ts and lib/refundConfirmationEmail.ts.
 * That is what makes the generic loop possible: the sweep needs no
 * knowledge of what any message says.
 */
export type EmailSendResult = "sent" | "already-sent" | "not-eligible" | "failed";

/** One family's counters. Numbers only - never a customer fact. */
export type EmailRetryFamilySummary = {
  /** Rows at 'sending' that looked abandoned when the work list was read. */
  staleFound: number;
  /** Rows moved from 'sending' back to 'failed' by this run. */
  staleRecovered: number;
  /** Rows the failed-only query returned. */
  eligible: number;
  /** Rows that reached a sender. */
  attempted: number;
  /** Rows delivered to the provider on this run. */
  sent: number;
  /** Rows attempted and still failing. */
  failed: number;
  /** Rows refused before or by the sender: not eligible, or already taken. */
  skipped: number;
  /**
   * True when this family's own work could not be run at all - a work
   * list query that failed, say. Recorded rather than thrown, so one
   * family's outage cannot hide the other five.
   */
  errored: boolean;
};

export function emptyFamilySummary(): EmailRetryFamilySummary {
  return {
    staleFound: 0,
    staleRecovered: 0,
    eligible: 0,
    attempted: 0,
    sent: 0,
    failed: 0,
    skipped: 0,
    errored: false,
  };
}

/** A candidate row. Two fields, neither of them a customer fact. */
export type RetryCandidateRow = {
  id: string;
  status: string | null;
};

/** A stale candidate. Three fields, none of them a customer fact. */
export type StaleCandidateRow = {
  id: string;
  status: string | null;
  updated_at: string | null;
};

/** What one conditional recovery write concluded. */
export type StaleRecoveryOutcome = "recovered" | "skipped";

/**
 * Everything one family needs from the outside world.
 *
 * Note what is absent: there is no "build the message" hook and no
 * recipient. The sweep hands a sender an order id and the sender decides
 * everything else from the durable row, which is exactly why this loop
 * can be shared across four different messages to two different kinds of
 * recipient without knowing anything about either.
 */
export type EmailRetryFamilyPort = {
  /** Rows at 'sending' at or before the cutoff. Bounded by the caller. */
  loadStaleSending: (cutoffIso: string) => Promise<StaleCandidateRow[]>;
  /** Conditional 'sending' -> 'failed'. Must re-check status AND cutoff. */
  recoverStale: (orderId: string, cutoffIso: string) => Promise<StaleRecoveryOutcome>;
  /** Failed rows, oldest first, already bounded by the caller. */
  loadFailed: () => Promise<RetryCandidateRow[]>;
  /** The existing sender. Takes an order id and nothing else. */
  send: (orderId: string) => Promise<EmailSendResult>;
  /** Order id only. Never a customer fact. */
  logFailure: (orderId: string, message: string) => void;
};

/**
 * The cutoff a row's updated_at must not be newer than.
 *
 * Takes `now` rather than reading the clock, so this file stays pure and
 * the boundary is testable to the millisecond.
 */
export function staleSendingCutoff(now: Date | number): string {
  const millis = now instanceof Date ? now.getTime() : now;
  return new Date(millis - STALE_SENDING_AFTER_MS).toISOString();
}

/**
 * The stale predicate, applied in code as well as in SQL.
 *
 * Inclusive at the boundary, matching the internal notification module
 * exactly: a row whose updated_at is precisely the cutoff has been in
 * flight for precisely the threshold and counts as stale.
 *
 * updated_at is the right clock because public.orders has carried a
 * BEFORE UPDATE trigger since migration 004 that sets it to now() on
 * every update, unconditionally. The claim is an update, so updated_at is
 * at least as recent as the claim; any later write only pushes it
 * forward. A freshly claimed row can therefore never look stale, and a
 * genuinely stale row that looks fresh merely delays recovery - the
 * harmless direction.
 */
export function isStaleSending(
  status: string | null | undefined,
  updatedAt: string | null | undefined,
  cutoffIso: string
): boolean {
  if (status !== IN_FLIGHT_STATUS) return false;
  if (!updatedAt) return false;
  const at = Date.parse(updatedAt);
  const cutoff = Date.parse(cutoffIso);
  if (Number.isNaN(at) || Number.isNaN(cutoff)) return false;
  return at <= cutoff;
}

/**
 * Moves genuinely stale 'sending' rows back to 'failed' for one family.
 *
 * IT SENDS NOTHING. Recovery only makes an abandoned row visible to the
 * failed-only sweep below, which remains the single delivery path. That
 * separation is what keeps the number of ways an email can be sent at
 * exactly one per family.
 *
 * RACE BEHAVIOUR. The work list is a read and a read is never trusted:
 * every recovery is a conditional UPDATE that re-checks both the status
 * and the cutoff at write time. If the original worker was not dead after
 * all and finished in between - by writing 'sent', or 'failed', or simply
 * by touching the row - the write matches nothing and the row is left
 * exactly as that worker left it. A 'sent' email can never be un-sent by
 * this, and an active claim can never be stolen.
 *
 * A single row that cannot be recovered is counted and logged, never
 * thrown: one bad row must not keep the rest stuck at 'sending' forever.
 */
export async function runFamilyStaleRecovery(
  port: EmailRetryFamilyPort,
  cutoffIso: string,
  summary: EmailRetryFamilySummary
): Promise<void> {
  const rows = await port.loadStaleSending(cutoffIso);

  for (const row of rows) {
    // The in-code half of the stale rule. The query already applies it;
    // this refuses a row that reached the loop anyway - a NULL, 'pending',
    // 'failed' or 'sent' row, or one that is not old enough.
    if (!isStaleSending(row.status, row.updated_at, cutoffIso)) continue;

    summary.staleFound += 1;

    try {
      if ((await port.recoverStale(row.id, cutoffIso)) === "recovered") summary.staleRecovered += 1;
    } catch (err) {
      port.logFailure(row.id, err instanceof Error ? err.message : "unknown error");
    }
  }
}

/**
 * One bounded pass over one family's failed rows.
 *
 * Sequential on purpose: the batch is small, the goal is to drain a
 * backlog rather than to drain it fast, and one row at a time keeps the
 * claim, the send and the state write in an order that can be reasoned
 * about.
 *
 * CONCURRENCY. Nothing here claims anything itself - each sender does its
 * own atomic conditional claim, which is what already protects it from a
 * concurrent webhook delivery or a concurrent operator action. The sweep
 * simply calls the sender; a sender that loses the claim answers
 * "already-sent" and is counted as skipped, which is a normal outcome and
 * not an error.
 *
 * ONE BAD ROW NEVER STOPS THE BATCH. A sender that reports "failed" is
 * counted and the loop continues; a sender that throws despite its
 * contract is caught, logged by order id, counted and the loop continues.
 * The row stays 'failed' either way and is eligible again tomorrow.
 */
export async function runFamilyRetrySweep(
  port: EmailRetryFamilyPort,
  summary: EmailRetryFamilySummary
): Promise<void> {
  const rows = await port.loadFailed();

  for (const row of rows) {
    summary.eligible += 1;

    // The in-code half of the eligibility rule. The query already filters
    // on 'failed'; this refuses a NULL, 'pending', 'sent' or 'sending'
    // row that reached the loop anyway, before any sender is entered.
    if (!isRetryEligibleStatus(row.status)) {
      summary.skipped += 1;
      continue;
    }

    summary.attempted += 1;

    try {
      const result = await port.send(row.id);
      if (result === "sent") summary.sent += 1;
      else if (result === "failed") summary.failed += 1;
      else summary.skipped += 1;
    } catch (err) {
      // The senders this drives do not throw, but a future one might.
      // Counting it beats letting one row abort five other families.
      port.logFailure(row.id, err instanceof Error ? err.message : "unknown error");
      summary.failed += 1;
    }
  }
}

/**
 * Recovery then sweep, for one family, with every failure contained.
 *
 * The two halves are separately guarded. A work-list query that fails
 * marks the family errored and returns whatever counters were already
 * gathered, so the other five still run and the cron still answers
 * truthfully about what it managed. A cron that silently reported zeroes
 * for a family it could not read would be worse than useless.
 */
export async function runFamily(
  port: EmailRetryFamilyPort,
  cutoffIso: string
): Promise<EmailRetryFamilySummary> {
  const summary = emptyFamilySummary();

  try {
    await runFamilyStaleRecovery(port, cutoffIso, summary);
  } catch (err) {
    summary.errored = true;
    port.logFailure("stale-recovery", err instanceof Error ? err.message : "unknown error");
  }

  try {
    await runFamilyRetrySweep(port, summary);
  } catch (err) {
    summary.errored = true;
    port.logFailure("retry-sweep", err instanceof Error ? err.message : "unknown error");
  }

  return summary;
}

/** What one cron invocation reports. Six families, counts only. */
export type TransactionalEmailRetrySummary = {
  ok: true;
} & Record<EmailFamilyKey, EmailRetryFamilySummary>;
