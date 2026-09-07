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
 * ── WHAT IS ACTUALLY GUARANTEED, AND WHAT IS NOT ──────────────
 *
 * Three duplicate paths are closed outright, by the database:
 *
 *   1. Two workers claiming the same row - impossible: the claim is one
 *      UPDATE ... FOR UPDATE SKIP LOCKED (migration 044 §3).
 *   2. A retry re-sending an already-sent row - impossible: the claim
 *      selects `launch_notification_sent_at is null`, and marking is
 *      idempotent.
 *   3. A worker whose claim expired marking a row it no longer owns -
 *      impossible: mark_launch_notification_sent matches on the claim id
 *      and reports false.
 *
 * The fourth is NOT closed outright, and saying otherwise would be a
 * lie worth avoiding: a crash between the provider accepting a message
 * and the row being marked leaves an outcome nobody knows.
 *
 * THE PROVIDER'S HELP HAS AN EXPIRY DATE. Resend keeps an idempotency
 * key for TWENTY-FOUR HOURS and answers 409 while a request with the
 * same key is still in flight. Inside that window a repeat is genuinely
 * safe - the provider returns the original response without sending
 * again. Outside it the key means nothing and a "retry" is a second
 * mail to somebody who consented to exactly one.
 *
 * So this module does not retry an unknown outcome. It reports
 * `unclear`, the caller parks the row for review (migration 044 §5b),
 * and the claim can no longer see it. A person reconciles it against
 * the provider's own delivery log. That is slower than an automatic
 * retry and it is the correct trade: a missing mail can be sent later,
 * a duplicate cannot be unsent.
 *
 * `idempotencyKey` below is derived from the row id and nothing else, so
 * it is stable across retries, deploys and workers. It is not a secret:
 * it identifies a message, not a person, and it stays well inside the
 * provider's 256-character limit.
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
   * Rows whose outcome is unknown and which were parked for a human to
   * reconcile. NOT retried: see the note at the top of this file.
   */
  needsReview: number;
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
    needsReview: 0,
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
  /** Parks a row whose outcome is unknown. It is never claimed again. */
  flagForReview(id: string, claimId: string, reason: string): Promise<boolean>;
};

/**
 * What one send attempt can end as.
 *
 * THREE OUTCOMES, NOT TWO. `unclear` is the one that matters: the
 * provider neither confirmed nor refused, so whether this person
 * received the mail is unknown. It is kept separate from `failed`
 * because the two must be handled differently - a refusal may be
 * retried, an unknown outcome may not.
 */
export type SendAttempt =
  | { ok: true }
  | { ok: false; unclear?: false; reason: string }
  | { ok: false; unclear: true; reason: string };

/** The mailer surface. Narrow, so a test can supply it. */
export type LaunchSendMailer = {
  send(recipient: ClaimedRecipient, key: string): Promise<SendAttempt>;
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

      let outcome: SendAttempt;
      try {
        outcome = await mailer.send(recipient, idempotencyKey(recipient.id));
      } catch (err) {
        // A THROW IS NOT A REFUSAL. A socket that died mid-request tells
        // us nothing about whether the provider took the message, so
        // this is unknown rather than failed - and unknown is never
        // retried automatically.
        outcome = { ok: false, unclear: true, reason: errText(err) };
      }

      if (!outcome.ok) {
        if (outcome.unclear) {
          summary.needsReview += 1;
          await safeFlag(db, recipient.id, claimId, outcome.reason, summary);
        } else {
          summary.failed += 1;
          await safeRelease(db, recipient.id, claimId, outcome.reason, summary);
        }
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
        // THE WORST CASE: the provider has the message and the database
        // would not record it. Park the row so no automatic retry can
        // turn this into a second mail, then stop - a database that
        // cannot be written to will not do better on the next row.
        summary.unmarked += 1;
        await safeFlag(db, recipient.id, claimId, `mark failed after send: ${errText(err)}`, summary);
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

/**
 * Parks a row whose outcome is unknown.
 *
 * A flag that cannot be written is itself a problem, but not one worth
 * throwing over: the row stays claimed and expires, and the operator
 * sees it in the open-claims count. Recorded, never thrown.
 */
async function safeFlag(
  db: LaunchSendDb,
  id: string,
  claimId: string,
  reason: string,
  summary: LaunchSendSummary
): Promise<void> {
  try {
    await db.flagForReview(id, claimId, reason);
  } catch (err) {
    summary.stoppedReason = summary.stoppedReason ?? `flag failed: ${errText(err)}`;
  }
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
