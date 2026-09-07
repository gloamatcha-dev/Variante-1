/**
 * THE DRY RUN.
 *
 * Everything an operator has to know before releasing the launch, as
 * counts. It reads and it never writes: no row is claimed, no status
 * changes, and nothing is marked notified by looking at it.
 *
 * ── COUNTS, NEVER PEOPLE ──────────────────────────────────────
 *
 * This answer is returned over HTTP and will end up in a terminal, a
 * screenshot and eventually a chat message. So it carries integers and
 * booleans and nothing else: no address, no name, no id, not even a
 * sample. "How many" is the operational question; "who" is not, and an
 * export of the list is not something an endpoint should make easy.
 *
 * ── WHY THE FOUR STATES ARE COUNTED SEPARATELY ────────────────
 *
 *   confirmed + unsent   who WOULD receive the announcement
 *   pending              never confirmed - excluded, and due for
 *                        deletion by the retention sweep
 *   withdrawn            consent taken back - excluded permanently
 *   notified             already received it - excluded
 *
 * They are listed apart rather than summed because "2000 people are on
 * the list" is the number that gets quoted, and it is the wrong one. The
 * only number that matters before a send is the first.
 *
 * Pure: the client and `now` are arguments, so the suite drives it with
 * no socket and no clock.
 */

export type LaunchStatusCounts = {
  confirmedUnsent: number;
  pending: number;
  withdrawn: number;
  notified: number;
  /** Claimed and not yet finished. Non-zero mid-run is normal. */
  openClaims: number;
  /**
   * Rows whose outcome is unknown and which are excluded from any
   * further automatic attempt. Every one of these needs a person.
   */
  needsReview: number;
};

export type LaunchStatus = {
  /** The planned instant, from lib/launchCountdown.ts. Display only. */
  plannedLaunchIso: string;
  /** Has the planned instant passed, by the server's clock? */
  plannedInstantReached: boolean;
  /** The actual shop release - SHOP_STATUS, edited and deployed. */
  shopStatus: string;
  /** The human release flag from migration 044. */
  released: boolean;
  releasedAt: string | null;
  counts: LaunchStatusCounts;
  /** True when migration 044 is not applied, so nothing can be sent. */
  migrationMissing: boolean;
};

/** The narrow surface this reads through. */
export type LaunchStatusClient = {
  countWaitlist(filter: WaitlistFilter): Promise<number>;
  readRelease(): Promise<{ released: boolean; released_at: string | null } | null>;
};

export type WaitlistFilter =
  | "confirmedUnsent"
  | "pending"
  | "withdrawn"
  | "notified"
  | "openClaims"
  | "needsReview";

export const WAITLIST_FILTERS: readonly WaitlistFilter[] = [
  "confirmedUnsent",
  "pending",
  "withdrawn",
  "notified",
  "openClaims",
  "needsReview",
];

export function emptyCounts(): LaunchStatusCounts {
  return {
    confirmedUnsent: 0,
    pending: 0,
    withdrawn: 0,
    notified: 0,
    openClaims: 0,
    needsReview: 0,
  };
}

/**
 * Reads the whole picture.
 *
 * A missing migration is reported as `migrationMissing` rather than
 * thrown: "044 is not applied" is the single most useful thing this
 * endpoint can tell an operator on 1 October, and it must not arrive as
 * a 500 with a driver message.
 */
export async function readLaunchStatus(
  client: LaunchStatusClient,
  input: {
    nowMs: number;
    plannedLaunchIso: string;
    plannedLaunchMs: number;
    shopStatus: string;
  }
): Promise<LaunchStatus> {
  let released = false;
  let releasedAt: string | null = null;
  let migrationMissing = false;

  try {
    const row = await client.readRelease();
    if (row === null) {
      // The table exists but holds no row - 044 half-applied, which is
      // not a state it can reach through its own transaction, but is
      // reachable by hand. Treated as "not released", which is the safe
      // reading.
      released = false;
    } else {
      released = row.released === true;
      releasedAt = row.released_at;
    }
  } catch {
    migrationMissing = true;
  }

  const counts = emptyCounts();
  if (!migrationMissing) {
    for (const filter of WAITLIST_FILTERS) {
      try {
        counts[filter] = await client.countWaitlist(filter);
      } catch {
        // A count that cannot be read stays zero. It is not worth
        // failing the whole status for, and a zero next to a working
        // `released` flag is visibly odd rather than silently wrong.
        counts[filter] = 0;
      }
    }
  } else {
    // 043's columns still exist, so the four consent states can be
    // counted even when 044 is missing. The two 044-only counters
    // cannot, and stay zero.
    for (const filter of ["pending", "withdrawn", "notified"] as const) {
      try {
        counts[filter] = await client.countWaitlist(filter);
      } catch {
        counts[filter] = 0;
      }
    }
  }

  return {
    plannedLaunchIso: input.plannedLaunchIso,
    plannedInstantReached: input.nowMs >= input.plannedLaunchMs,
    shopStatus: input.shopStatus,
    released,
    releasedAt,
    counts,
    migrationMissing,
  };
}

/**
 * IS EVERYTHING IN PLACE FOR A SEND?
 *
 * Returned alongside the counts so an operator does not have to derive
 * it, and phrased as blockers rather than a single boolean - "not ready"
 * is useless, "not ready because the shop is still prelaunch" is not.
 *
 * NOTE WHAT IS NOT A BLOCKER: the planned instant. Reaching noon on
 * 1 October is not permission, and not reaching it is not a prohibition
 * either - if the shop is live and a person has released the launch,
 * the clock has no further say. It is reported for context and nothing
 * more.
 */
export function launchSendBlockers(status: LaunchStatus): string[] {
  const blockers: string[] = [];
  if (status.migrationMissing) blockers.push("migration 044 is not applied");
  if (!status.released) blockers.push("the launch has not been released");
  if (status.shopStatus !== "live") blockers.push(`the shop is still ${status.shopStatus}`);
  if (status.counts.confirmedUnsent === 0) blockers.push("no confirmed recipient is waiting");
  return blockers;
}
