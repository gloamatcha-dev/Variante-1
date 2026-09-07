/**
 * THE DELETION THE PRIVACY NOTICE PROMISES, AS A JOB THAT ACTUALLY RUNS.
 *
 * Migration 043 writes the retention rule down and builds the index that
 * makes it cheap, but deliberately implements nothing: it says the
 * deletion is "recorded here and implemented as an operational job", and
 * refuses to start a trigger or a pg_cron schedule that deletes rows on a
 * clock nobody reviewed. This module is that job.
 *
 * -- WHAT IS DELETED, AND ON WHOSE AUTHORITY -------------------
 *
 * ONE rule, and it is not invented here. The privacy notice tells every
 * person who signs up, in these words:
 *
 *   "Bestätigst du sie nicht, löschen wir die Eintragung nach 14 Tagen."
 *
 * That is a promise made to a data subject about their own address, and
 * until this file existed it was a promise nothing kept. Fourteen days
 * is also PENDING_RETENTION_DAYS in lib/launchWaitlist.ts and the same
 * number as CONFIRMATION_TOKEN_TTL_DAYS there - a link that no longer
 * works must not leave a row behind that still holds an address.
 *
 * THE NUMBER IS STATED HERE RATHER THAN IMPORTED, and that repetition
 * is deliberate rather than careless. This module has to stay a leaf
 * with no runtime imports so the test suite can load it directly under
 * plain Node - the same constraint lib/launchRateLimitStore.ts records
 * for its digest pattern and lib/annualPlanCheckoutRules.ts for its
 * neighbours. The three places the period now appears (here,
 * lib/launchWaitlist.ts, and the sentence in the privacy notice in
 * app/GloaSite.tsx) are ASSERTED TO AGREE by
 * tests/launch-waitlist.test.mjs, so the repetition is checked on every
 * run rather than trusted. Change one and the suite fails.
 *
 * -- WHAT IS DELIBERATELY *NOT* DELETED HERE -------------------
 *
 * WITHDRAWN rows. A withdrawal is the record that consent was taken back
 * rather than quietly dropped, and it is also what stops the signup
 * endpoint reviving the entry when somebody types the address in again
 * (see the withdrawn_at branch in app/api/launch/route.ts). Deleting it
 * would delete both. The privacy notice states no period for it, so this
 * file invents none: a deletion date for withdrawal evidence is a legal
 * decision, not a default, and it is listed as open in the release
 * report rather than guessed at.
 *
 * NOTIFIED rows. The notice says the list is "gelöscht oder
 * anonymisiert" once the launch mail has gone out - after the send is
 * done and reconciled. That is a one-off operation tied to a real event
 * that has not happened, not a recurring sweep, and a daily cron that
 * deleted 'notified' rows on a timer could destroy the send log while
 * the send was still being checked. It stays a deliberate manual step.
 *
 * CONFIRMED rows. Consent is current and its purpose is unfulfilled.
 * There is nothing to delete yet.
 *
 * So the sweep touches exactly one status, and a row it deletes is by
 * definition one that no person ever confirmed.
 *
 * -- WHY THE ARITHMETIC IS A PURE FUNCTION ---------------------
 *
 * `cutoff` takes `now` as an argument and reads no clock, so a test can
 * put the boundary anywhere it likes without waiting fourteen days or
 * mocking time - the same shape as lib/launchWaitlist.ts and
 * lib/annualPlanRules.ts. The sweep below is the only part that does I/O.
 */

/** The one status this sweep may ever delete. */
export const RETENTION_SWEEPABLE_STATUS = "pending" as const;

/**
 * How long an unconfirmed entry may be kept. Must equal
 * PENDING_RETENTION_DAYS in lib/launchWaitlist.ts and the period stated
 * in the privacy notice; the suite asserts all three.
 */
export const RETENTION_PENDING_DAYS = 14;

/**
 * How many rows one invocation may delete.
 *
 * Bounded for the same reason every other sweep in this repository is:
 * a cron invocation has a wall-clock budget, and an unbounded delete on
 * a table that has grown unexpectedly is how a job starts timing out
 * halfway through and stops finishing at all. The job is idempotent and
 * runs daily, so a backlog drains over consecutive days rather than in
 * one risky statement - and `remaining` in the summary says out loud
 * when that is happening instead of letting a capped run look complete.
 */
export const RETENTION_BATCH_LIMIT = 500;

export type RetentionSummary = {
  /** Rows past the retention period that this run could see. */
  due: number;
  /** Rows actually deleted. */
  deleted: number;
  /**
   * Rows still past the cutoff after this run - the batch cap was hit
   * and the next invocation has work to do. Zero on a clean sweep.
   */
  remaining: number;
  /** True when the sweep could not complete. Counts above are then partial. */
  errored: boolean;
};

export function emptyRetentionSummary(errored = false): RetentionSummary {
  return { due: 0, deleted: 0, remaining: 0, errored };
}

/**
 * The instant before which an unconfirmed entry may no longer be kept.
 *
 * Pure: `nowMs` is the caller's, and the period is the constant the
 * privacy notice states.
 */
export function pendingRetentionCutoff(nowMs: number, days: number = RETENTION_PENDING_DAYS): Date {
  return new Date(nowMs - days * 24 * 60 * 60 * 1000);
}

/**
 * Is this row one the sweep is allowed to delete?
 *
 * Expressed as a function of the row rather than left implicit in a
 * query, so the rule can be tested directly and so the query below has
 * something to be checked against. Both halves must hold: the status is
 * pending AND the row is older than the cutoff. A row missing or
 * carrying an unparseable created_at is NOT deletable - an unreadable
 * date is not evidence that a retention period has elapsed.
 */
export function isSweepablePendingEntry(
  row: { status: string; created_at: string | null },
  cutoff: Date
): boolean {
  if (row.status !== RETENTION_SWEEPABLE_STATUS) return false;
  if (!row.created_at) return false;
  const createdMs = Date.parse(row.created_at);
  if (Number.isNaN(createdMs)) return false;
  return createdMs < cutoff.getTime();
}

/**
 * The narrow Supabase surface this sweep uses, so a test can supply it
 * without a client, a socket or a key - the same pattern
 * lib/launchRateLimitStore.ts uses for its one RPC.
 */
export type RetentionClient = {
  from(table: string): {
    select(
      columns: string,
      options?: { count?: "exact"; head?: boolean }
    ): RetentionSelectBuilder;
    delete(): RetentionDeleteBuilder;
  };
};

type RetentionSelectBuilder = {
  eq(column: string, value: unknown): RetentionSelectBuilder;
  lt(column: string, value: unknown): RetentionSelectBuilder;
  limit(n: number): PromiseLike<{ data: unknown; count?: number | null; error: { message: string } | null }>;
} & PromiseLike<{ data: unknown; count?: number | null; error: { message: string } | null }>;

type RetentionDeleteBuilder = {
  eq(column: string, value: unknown): RetentionDeleteBuilder;
  in(column: string, values: readonly unknown[]): PromiseLike<{ error: { message: string } | null }>;
};

export const WAITLIST_TABLE = "launch_waitlist";

/**
 * DELETES UNCONFIRMED ENTRIES PAST THEIR RETENTION PERIOD.
 *
 * Three statements, in this order, and the order matters:
 *
 *   1. COUNT how many rows are due. Head-only, so no address is read
 *      into this process to produce it.
 *   2. SELECT the ids of at most RETENTION_BATCH_LIMIT of them. Ids
 *      only - not the address, not the name, not the consent text.
 *      Nothing this function holds in memory is personal data.
 *   3. DELETE by id, narrowed AGAIN by status = 'pending'. The second
 *      predicate is not redundant: between step 2 and step 3 somebody
 *      may have clicked their confirmation link, and a confirmed row
 *      must not be deleted by an id list that was true a moment ago.
 *      The database decides, not the snapshot.
 *
 * It returns counts and nothing else. No address, no id, no name - this
 * summary is answered by an HTTP endpoint, and a retention job that
 * leaked the addresses it deleted would be a poor kind of retention job.
 */
export async function sweepExpiredPendingEntries(
  client: RetentionClient,
  nowMs: number,
  batchLimit: number = RETENTION_BATCH_LIMIT
): Promise<RetentionSummary> {
  const cutoff = pendingRetentionCutoff(nowMs).toISOString();

  const counted = await client
    .from(WAITLIST_TABLE)
    .select("id", { count: "exact", head: true })
    .eq("status", RETENTION_SWEEPABLE_STATUS)
    .lt("created_at", cutoff);

  if (counted.error) {
    console.error("Launch waitlist retention: could not count expired entries:", counted.error.message);
    return emptyRetentionSummary(true);
  }

  const due = typeof counted.count === "number" ? counted.count : 0;
  if (due === 0) return { due: 0, deleted: 0, remaining: 0, errored: false };

  const selected = await client
    .from(WAITLIST_TABLE)
    .select("id")
    .eq("status", RETENTION_SWEEPABLE_STATUS)
    .lt("created_at", cutoff)
    .limit(batchLimit);

  if (selected.error) {
    console.error("Launch waitlist retention: could not list expired entries:", selected.error.message);
    return { due, deleted: 0, remaining: due, errored: true };
  }

  const ids = Array.isArray(selected.data)
    ? selected.data
        .map((row) => (row && typeof row === "object" ? (row as { id?: unknown }).id : null))
        .filter((id): id is string => typeof id === "string" && id.length > 0)
    : [];

  if (ids.length === 0) return { due, deleted: 0, remaining: due, errored: false };

  const removed = await client
    .from(WAITLIST_TABLE)
    .delete()
    .eq("status", RETENTION_SWEEPABLE_STATUS)
    .in("id", ids);

  if (removed.error) {
    console.error("Launch waitlist retention: could not delete expired entries:", removed.error.message);
    return { due, deleted: 0, remaining: due, errored: true };
  }

  return { due, deleted: ids.length, remaining: Math.max(0, due - ids.length), errored: false };
}
