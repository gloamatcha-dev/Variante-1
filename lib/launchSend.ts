/**
 * RUNNING THE ONE-TIME LAUNCH ANNOUNCEMENT.
 *
 * Migration 044 owns the hard part - the atomic claim - and this module
 * owns the loop around it. The division matters: every decision about
 * WHO may be sent to is taken inside one SQL statement under a row lock,
 * and nothing here can widen it. This file cannot select a recipient,
 * cannot see a pending or withdrawn row, and cannot mark a row sent that
 * it does not hold the claim for.
 *
 * ── THE SHAPE OF ONE BATCH ────────────────────────────────────
 *
 *   claim(n)  →  for each row: send  →  mark sent, or give the claim back
 *
 * and NOT "claim everything, then send everything". A claim held across
 * a long send is a claim that expires halfway; claiming a small batch and
 * finishing it keeps the window between "this row is mine" and "this row
 * is done" as short as one provider round trip.
 *
 * ── WHY A DUPLICATE CANNOT HAPPEN ─────────────────────────────
 *
 * Four things have to fail at once for somebody to get two mails, and
 * each is closed separately:
 *
 *   1. Two workers claiming the same row - impossible: the claim is one
 *      UPDATE ... FOR UPDATE SKIP LOCKED (migration 044 §3).
 *   2. A retry re-sending an already-sent row - impossible: the claim
 *      selects `launch_notification_sent_at is null`, and marking is
 *      idempotent.
 *   3. A crash between the send and the mark - the row stays claimed,
 *      becomes reclaimable after the stale window, and the SECOND
 *      attempt carries the SAME idempotency key, so the provider itself
 *      refuses to deliver it twice.
 *   4. A worker whose claim expired marking a row it no longer owns -
 *      impossible: mark_launch_notification_sent matches on the claim id
 *      and reports false.
 *
 * Point 3 is the one that needs the provider's help, which is why
 * `idempotencyKey` below is derived from the row id and nothing else. It
 * is stable across retries, deploys and workers, and it is not a secret:
 * it identifies a message, not a person.
 *
 * ── PURE ENOUGH TO TEST ───────────────────────────────────────
 *
 * No clock, no Supabase client, no Resend client and no environment.
 * The database and the mailer arrive as narrow interfaces, so the suite
 * drives a full send - including double workers, provider failures and
 * expired claims - without a socket or a key.
 */

/** Fixed, so a retry of the same row produces the same key. */
const IDEMPOTENCY_PREFIX = "gloa-launch-notification:v1:";

/**
 * The provider-level idempotency key for one recipient.
 *
 * Derived from the row id alone. Not from the address (which would leak
 * one into provider metadata), not from a timestamp (which would change
 * on retry and defeat the point), and not from the batch (which would
 * make the same row use different keys in different runs).
 */
export function idempotencyKey(rowId: string): string {
  return `${IDEMPOTENCY_PREFIX}${rowId}`;
}

/** One recipient, exactly as the claim returns it. */
export type ClaimedRecipient = {
  id: string;
  email: string;
  first_name: string | null;
  attempts: number;
};

export type LaunchSendSummary = {
  /** Rows claimed across every batch this run. */
  claimed: number;
  /** Rows the provider accepted AND that were marked notified. */
  sent: number;
  /** Rows the provider refused. The claim was given back. */
  failed: number;
  /**
   * Rows the provider accepted but that could NOT be marked - the claim
   * had expired and another worker owned the row. Non-zero here means a
   * duplicate may have been delivered and is worth investigating.
   */
  unmarked: number;
  /** True when the run stopped early. `stoppedReason` says why. */
  stopped: boolean;
  stoppedReason: string | null;
};

export function emptyLaunchSendSummary(stoppedReason: string | null = null): LaunchSendSummary {
  return {
    claimed: 0,
    sent: 0,
    failed: 0,
    unmarked: 0,
    stopped: stoppedReason !== null,
    stoppedReason,
  };
}

/** The database surface. Narrow, so a test can supply it. */
export type LaunchSendDb = {
  claim(claimId: string, limit: number): Promise<ClaimedRecipient[]>;
  markSent(id: string, claimId: string): Promise<boolean>;
  releaseClaim(id: string, claimId: string, reason: string | null): Promise<boolean>;
};

/** The mailer surface. Returns nothing on success, throws or returns a reason on failure. */
export type LaunchSendMailer = {
  send(recipient: ClaimedRecipient, key: string): Promise<{ ok: true } | { ok: false; reason: string }>;
};

export type LaunchSendOptions = {
  /** Rows per claim. Small on purpose - see the note at the top. */
  batchSize?: number;
  /** Hard ceiling on rows this invocation will touch. */
  maxRows?: number;
  /**
   * Asked before every batch AND before every individual send.
   *
   * This is the abort switch. A run that has already started must be
   * stoppable - because the reason to stop it (the shop is broken, the
   * wrong copy went out, the provider is bouncing everything) is
   * discovered while it is running, not before.
   */
  shouldContinue?: () => boolean | Promise<boolean>;
};

export const DEFAULT_BATCH_SIZE = 50;
export const DEFAULT_MAX_ROWS = 2000;

/**
 * Sends the launch announcement to everybody the database will hand over.
 *
 * Note what this function does NOT check: whether the launch is
 * released, whether the shop is open, or what time it is. All three are
 * upstream of it - the release gate lives inside the claim function in
 * migration 044, where a caller cannot forget it. This loop only asks
 * for rows and sends to whoever comes back, which is why the claim is
 * the only place that decides.
 */
export async function runLaunchSend(
  db: LaunchSendDb,
  mailer: LaunchSendMailer,
  options: LaunchSendOptions = {}
): Promise<LaunchSendSummary> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
  const shouldContinue = options.shouldContinue ?? (() => true);

  const summary = emptyLaunchSendSummary();

  // One id for this whole invocation. Every row this worker claims
  // carries it, so "rows this worker owns" is answerable.
  const claimId = newClaimId();

  while (summary.claimed < maxRows) {
    if (!(await shouldContinue())) {
      summary.stopped = true;
      summary.stoppedReason = "aborted before claiming";
      return summary;
    }

    const remaining = maxRows - summary.claimed;
    const take = Math.min(batchSize, remaining);

    let batch: ClaimedRecipient[];
    try {
      batch = await db.claim(claimId, take);
    } catch (err) {
      summary.stopped = true;
      summary.stoppedReason = `claim failed: ${errText(err)}`;
      return summary;
    }

    // Nothing came back. Either everybody has been notified, or the
    // launch is not released - the claim function refuses to hand over a
    // single row until somebody sets that flag. Either way this run is
    // finished, and it is finished cleanly rather than by an error.
    if (batch.length === 0) return summary;

    summary.claimed += batch.length;

    for (let i = 0; i < batch.length; i += 1) {
      const recipient = batch[i];

      if (!(await shouldContinue())) {
        // GIVE BACK THE WHOLE REMAINDER, not just this row.
        //
        // Everything from here to the end of the batch is claimed by
        // this worker and has not been sent to. Releasing only the
        // current row would park the rest for the full stale window -
        // so an abort would leave rows that look busy for fifteen
        // minutes and cannot be picked up by the operator who aborted
        // and then wants to resume. An abort should leave the queue
        // ready, and that means all of it.
        for (const pending of batch.slice(i)) {
          await safeRelease(db, pending.id, claimId, "aborted", summary);
        }
        summary.stopped = true;
        summary.stoppedReason = "aborted mid-batch";
        return summary;
      }

      let outcome: { ok: true } | { ok: false; reason: string };
      try {
        outcome = await mailer.send(recipient, idempotencyKey(recipient.id));
      } catch (err) {
        outcome = { ok: false, reason: errText(err) };
      }

      if (!outcome.ok) {
        summary.failed += 1;
        await safeRelease(db, recipient.id, claimId, outcome.reason, summary);
        continue;
      }

      // Accepted by the provider. Now close the row.
      try {
        const marked = await db.markSent(recipient.id, claimId);
        if (marked) {
          summary.sent += 1;
        } else {
          // The provider took the message but the row would not accept
          // the mark - the claim had expired and another worker owns it,
          // or it was already marked. Counted separately because it is
          // the only path on which a duplicate can exist, and an
          // operator has to be able to see that it happened.
          summary.unmarked += 1;
        }
      } catch (err) {
        summary.unmarked += 1;
        summary.stopped = true;
        summary.stoppedReason = `mark failed after a send: ${errText(err)}`;
        return summary;
      }
    }

    // A short batch means the queue is drained.
    if (batch.length < take) return summary;
  }

  summary.stopped = true;
  summary.stoppedReason = "row ceiling reached";
  return summary;
}

async function safeRelease(
  db: LaunchSendDb,
  id: string,
  claimId: string,
  reason: string | null,
  summary: LaunchSendSummary
): Promise<void> {
  try {
    await db.releaseClaim(id, claimId, reason);
  } catch (err) {
    // A claim that cannot be given back is not lost - it expires and
    // becomes reclaimable on its own. Recorded, not thrown.
    summary.stoppedReason = summary.stoppedReason ?? `release failed: ${errText(err)}`;
  }
}

/**
 * A claim id for one invocation.
 *
 * crypto.randomUUID is used through globalThis so this module keeps no
 * import at all and stays loadable by the suite as a leaf.
 */
function newClaimId(): string {
  return (globalThis.crypto as { randomUUID(): string }).randomUUID();
}

/** Never returns an object that could carry a row, an address or a key. */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : "unknown error";
}
