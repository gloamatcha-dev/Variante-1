/**
 * SENDING THE WELCOME MAIL, ONCE, RIGHT AFTER A CONFIRMATION.
 *
 * The launch send (lib/launchSend.ts) drains a queue in batches. This is
 * the opposite shape: one person has just clicked their confirmation
 * link, and the mail carrying their discount code goes out on that same
 * request. There is no worker and no schedule.
 *
 * What there IS, is a confirmation link opened more than once - by the
 * person, by a mail client's link scanner, by a browser restoring a tab,
 * or by an impatient double click. Without a claim, two of those would
 * both see an unsent row and both send.
 *
 * ── THE ORDER IS THE DESIGN ───────────────────────────────────
 *
 *   claim  →  send  →  mark sent, or park / give back
 *
 * The claim is one conditional UPDATE in migration 045 that also returns
 * the recipient, so winning the claim and knowing who to write to is a
 * single round trip. A caller that loses the claim gets no address at
 * all - it has no business knowing who it lost to.
 *
 * ── AN UNKNOWN OUTCOME IS NEVER RETRIED ───────────────────────
 *
 * Same rule as the launch send, for the same reason: Resend keeps an
 * idempotency key for 24 hours, so a repeat past that window is not a
 * safe repeat, it is a second mail. A provider timeout, a 409 saying the
 * key is in flight, or a mark that fails after the provider accepted -
 * all three park the row for a person to reconcile.
 *
 * ── IT NEVER FAILS THE CONFIRMATION ───────────────────────────
 *
 * The caller is the confirm route, and confirming is the thing the
 * person actually asked for. If the welcome mail cannot be claimed, sent
 * or marked - including because migration 045 has not been applied - the
 * confirmation still succeeds and this module reports what happened.
 * Nobody loses their place on the list because a second mail failed.
 *
 * Pure enough to test: the database and the mailer arrive as narrow
 * interfaces, so the whole flow including a double click runs with no
 * socket and no key.
 */

const IDEMPOTENCY_PREFIX = "gloa-launch-welcome:v1:";

/**
 * The provider-level idempotency key for one recipient.
 *
 * Derived from the row id alone, so a retry within the provider's window
 * is recognisably the same message. Deliberately a DIFFERENT namespace
 * from the launch announcement's key: the two mails are different
 * messages to the same person, and must never deduplicate against each
 * other.
 */
export function welcomeIdempotencyKey(rowId: string): string {
  return `${IDEMPOTENCY_PREFIX}${rowId}`;
}

export type WelcomeRecipient = {
  id: string;
  email: string;
  firstName: string | null;
};

export type WelcomeSendOutcome =
  /** Sent and recorded. */
  | { kind: "sent" }
  /** Somebody else holds the claim, or it was already sent. Nothing done. */
  | { kind: "not_claimed" }
  /** The provider refused. The claim was given back; it may be retried. */
  | { kind: "failed"; reason: string }
  /** Unknown outcome. Parked for a person. Never retried automatically. */
  | { kind: "needs_review"; reason: string }
  /** The database could not be asked at all - e.g. 045 is not applied. */
  | { kind: "unavailable"; reason: string };

export type WelcomeClaim =
  | { claimed: true; email: string; firstName: string | null }
  | { claimed: false };

export type WelcomeSendDb = {
  claim(rowId: string, claimId: string, consentVersion: string): Promise<WelcomeClaim>;
  markSent(rowId: string, claimId: string): Promise<boolean>;
  release(rowId: string, claimId: string, reason: string, needsReview: boolean): Promise<boolean>;
};

export type WelcomeSendMailer = {
  send(
    recipient: WelcomeRecipient,
    key: string
  ): Promise<{ ok: true } | { ok: false; unclear?: boolean; reason: string }>;
};

/**
 * Sends the welcome mail to one person, if they are owed it.
 *
 * `consentVersion` is passed through to the claim, which checks it in
 * SQL - so a caller that forgot to check cannot get a version 1 row out
 * of it. That is the gate protecting people who never agreed to receive
 * an offer.
 */
export async function sendWelcomeEmail(
  db: WelcomeSendDb,
  mailer: WelcomeSendMailer,
  rowId: string,
  consentVersion: string,
  newClaimId: () => string
): Promise<WelcomeSendOutcome> {
  const claimId = newClaimId();

  let claim: WelcomeClaim;
  try {
    claim = await db.claim(rowId, claimId, consentVersion);
  } catch (err) {
    return { kind: "unavailable", reason: errText(err) };
  }

  // Not owed, already sent, parked, withdrawn, or the wrong consent
  // version. The claim decided all of those in SQL; nothing to do.
  if (!claim.claimed) return { kind: "not_claimed" };

  let outcome: { ok: true } | { ok: false; unclear?: boolean; reason: string };
  try {
    outcome = await mailer.send(
      { id: rowId, email: claim.email, firstName: claim.firstName },
      welcomeIdempotencyKey(rowId)
    );
  } catch (err) {
    // A dead socket says nothing about whether the provider took the
    // message. Unknown, not failed.
    outcome = { ok: false, unclear: true, reason: errText(err) };
  }

  if (!outcome.ok) {
    const needsReview = outcome.unclear === true;
    await safeRelease(db, rowId, claimId, outcome.reason, needsReview);
    return needsReview
      ? { kind: "needs_review", reason: outcome.reason }
      : { kind: "failed", reason: outcome.reason };
  }

  try {
    const marked = await db.markSent(rowId, claimId);
    if (marked) return { kind: "sent" };
    // The provider took it but the row would not accept the mark - the
    // claim expired and somebody else owns it. A duplicate may exist, so
    // this is for a person to look at.
    await safeRelease(db, rowId, claimId, "mark refused after send", true);
    return { kind: "needs_review", reason: "mark refused after send" };
  } catch (err) {
    await safeRelease(db, rowId, claimId, `mark failed after send: ${errText(err)}`, true);
    return { kind: "needs_review", reason: `mark failed after send: ${errText(err)}` };
  }
}

async function safeRelease(
  db: WelcomeSendDb,
  rowId: string,
  claimId: string,
  reason: string,
  needsReview: boolean
): Promise<void> {
  try {
    await db.release(rowId, claimId, reason, needsReview);
  } catch {
    // A claim that cannot be given back expires on its own. Swallowed
    // rather than thrown: this must never fail a confirmation.
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : "unknown error";
}
