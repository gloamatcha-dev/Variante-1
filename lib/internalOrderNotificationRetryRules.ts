/**
 * The decision logic of the internal order notification retry safety net.
 *
 * Pure and leaf: no relative imports, no database, no network, no clock,
 * no environment. That is the same deliberate choice
 * lib/subscriptionInvoiceRules.ts and the email templates make, and it is
 * what lets the rules below be unit-tested for real - the plain Node test
 * runner cannot import a module that uses extension-less relative
 * imports, so anything worth testing behaviourally has to live in a file
 * like this one. lib/internalOrderNotificationRetry.ts is the thin wiring
 * that gives these rules a Supabase client and a Resend client.
 *
 * WHAT THE RETRY IS FOR. The primary retry mechanism is Stripe's: the
 * internal notification throws on failure, the webhook returns 500, the
 * event is never recorded and Stripe redelivers. That is bounded - Stripe
 * eventually stops - and what remains afterwards is an order sitting at
 * internal_notification_status = 'failed' with nothing left in the system
 * that will ever look at it again. These rules are what looks at it.
 *
 * THE ELIGIBILITY RULE IS THE WHOLE FEATURE:
 *
 *     internal_notification_status = 'failed'
 *
 * and nothing else, ever. NULL is not eligible, and that is the point:
 * migration 026 made the column nullable with no default precisely so
 * that every order written before it - and every order that never entered
 * this flow - would be NULL rather than looking like queued work. A sweep
 * keyed on 'failed' cannot email the order history, because 'failed' can
 * only be written by code that genuinely tried and genuinely failed.
 * 'sending' is not eligible either: that row belongs to whoever claimed
 * it. 'sent' is not eligible: it is done.
 */

/** The one status this sweep may ever act on. */
export const RETRY_ELIGIBLE_STATUS = "failed";

/** The in-flight status. Owned by whichever worker won the claim. */
export const IN_FLIGHT_STATUS = "sending";

/**
 * How many failed notifications one run may attempt.
 *
 * A ceiling, not a target: on a healthy day nothing is eligible at all.
 * It exists so that an outage which failed a hundred orders cannot turn
 * one cron invocation into a hundred sequential provider calls inside a
 * single serverless function. What is not reached today is reached
 * tomorrow, and the least-recently-attempted ordering the caller applies
 * means the overflow sorts to the front.
 */
export const RETRY_BATCH_LIMIT = 25;

/**
 * The single eligibility predicate, applied in code as well as in SQL.
 *
 * The database query filters on the same status, and the claim below
 * refuses anything else again - three independent refusals of a
 * historical NULL row, so no single mistake can produce an email about an
 * order from before migration 026.
 */
export function isRetryEligibleStatus(status: string | null | undefined): boolean {
  return status === RETRY_ELIGIBLE_STATUS;
}

/** Where this order came from. Derived from persisted data, never guessed. */
export type RetryNotificationSource = "one_time" | "subscription";

/** A frozen checkout line, as persisted on the checkout attempt. */
export type RetryItemSnapshot = {
  productName: string;
  variantLabel: string;
  quantity: number;
  unitGrossCents: number;
  lineGrossCents: number;
  sku?: string | null;
};

/**
 * The order columns the notification is rebuilt from.
 *
 * Generic in the address snapshot so this file stays a leaf: the wiring
 * module supplies the real AddressSnapshot type, and the snapshot itself
 * is passed through untouched - a retry describes the order that exists,
 * so nothing here re-derives an address.
 */
export type RetryOrderRow<TAddress> = {
  id: string;
  order_number: string;
  currency: string;
  subtotal_gross_cents: number;
  shipping_gross_cents: number | null;
  total_gross_cents: number;
  shipping_address_snapshot: TAddress | null;
  customer_snapshot: unknown;
  checkout_attempt_id: string | null;
  internal_notification_status: string | null;
};

/** The checkout attempt the order was created from. */
export type RetryAttemptRow = {
  items_snapshot: unknown;
  subscription_id: string | null;
  stripe_invoice_id: string | null;
};

/**
 * Exactly what the existing send path takes. No recipient field: the
 * internal notification goes to one compile-time constant address, and
 * there is deliberately nothing here that could redirect it.
 */
export type RetryNotificationParams<TAddress> = {
  order: {
    id: string;
    order_number: string;
    currency: string;
    subtotal_gross_cents: number;
    shipping_gross_cents: number | null;
    total_gross_cents: number;
    shipping_address_snapshot: TAddress | null;
  };
  items: {
    productName: string;
    variantLabel: string;
    quantity: number;
    unitGrossCents: number;
    lineGrossCents: number;
    sku: string | null;
  }[];
  customerEmail: string | null;
  customerName: string | null;
  source: RetryNotificationSource;
  stripeInvoiceId: string | null;
};

/**
 * Rebuilds the notification from persisted data and from nothing else.
 *
 * The lines come off the checkout attempt's frozen items_snapshot, the
 * recipient facts off the order's own customer_snapshot, and the source
 * from whether that attempt belongs to a subscription - the same
 * derivation the webhook call sites make, from the same rows. Nothing is
 * re-priced, nothing is re-quoted and Stripe is not consulted: a retry
 * days later must describe the order that exists, not what the shop sells
 * today.
 *
 * Throws rather than improvising. A missing attempt or an empty line
 * snapshot means the retry cannot describe what to pack, and telling
 * fulfillment to ship nothing is worse than a row that stays 'failed' and
 * says so.
 */
export function buildRetryNotificationParams<TAddress>(
  row: RetryOrderRow<TAddress>,
  attempt: RetryAttemptRow | null
): RetryNotificationParams<TAddress> {
  if (!row.checkout_attempt_id) {
    throw new Error(`order ${row.id} has no checkout attempt to rebuild the notification from`);
  }
  if (!attempt) {
    throw new Error(`no checkout attempt behind order ${row.id}`);
  }

  const snapshot = attempt.items_snapshot;
  const items = (Array.isArray(snapshot) ? snapshot : []) as RetryItemSnapshot[];
  if (items.length === 0) {
    throw new Error(`order ${row.id} has no frozen line items`);
  }

  const source: RetryNotificationSource = attempt.subscription_id ? "subscription" : "one_time";
  const customer = (row.customer_snapshot ?? {}) as { email?: unknown; name?: unknown };

  return {
    order: {
      id: row.id,
      order_number: row.order_number,
      currency: row.currency,
      subtotal_gross_cents: row.subtotal_gross_cents,
      shipping_gross_cents: row.shipping_gross_cents,
      total_gross_cents: row.total_gross_cents,
      shipping_address_snapshot: row.shipping_address_snapshot,
    },
    items: items.map(item => ({
      productName: item.productName,
      variantLabel: item.variantLabel,
      quantity: item.quantity,
      unitGrossCents: item.unitGrossCents,
      lineGrossCents: item.lineGrossCents,
      sku: item.sku ?? null,
    })),
    customerEmail: typeof customer.email === "string" ? customer.email : null,
    customerName: typeof customer.name === "string" ? customer.name : null,
    source,
    // A one-off order has no invoice to give, exactly as at the webhook
    // call site.
    stripeInvoiceId: source === "subscription" ? attempt.stripe_invoice_id : null,
  };
}

/** The outcome of one run. Counts only - never a customer fact. */
export type InternalNotificationRetrySummary = {
  /** Eligible-looking rows this run examined. */
  processed: number;
  /** Rows that reached the internal fulfillment inbox on this run. */
  sent: number;
  /** Rows that were claimed, attempted, and returned to 'failed'. */
  failed: number;
  /** Rows refused before any send: not eligible, or already taken. */
  skipped: number;
};

/** What a claim attempt can conclude. */
export type RetryClaimOutcome = "claimed" | "taken" | "error";

/**
 * The two external systems the sweep touches, as one injectable port.
 * Everything below is decided here; nothing below knows what a database
 * or an email provider is.
 */
export type InternalNotificationRetryPort<TAddress> = {
  /** Failed rows, oldest failure first, already bounded by the caller. */
  loadFailedOrders: () => Promise<RetryOrderRow<TAddress>[]>;
  /** Atomic 'failed' -> 'sending'. Must refuse any other current status. */
  claim: (orderId: string) => Promise<RetryClaimOutcome>;
  /** The checkout attempt behind the order, or null when there is none. */
  loadAttempt: (checkoutAttemptId: string) => Promise<RetryAttemptRow | null>;
  /** Sends a notification whose claim has already been won. */
  deliver: (params: RetryNotificationParams<TAddress>) => Promise<void>;
  /** Returns a claimed row to 'failed'. */
  markFailed: (orderId: string) => Promise<void>;
  /** Order id only. Never a customer fact. */
  logFailure: (orderId: string, message: string) => void;
};

/**
 * One bounded pass over the failed internal notifications.
 *
 * Sequential on purpose: the batch is small, the goal is to drain a
 * backlog rather than to drain it fast, and one row at a time keeps the
 * claim, the send and the state write in an order that can be reasoned
 * about.
 *
 * CONCURRENCY. The cron and a Stripe redelivery can arrive together, so
 * every row is taken by an atomic conditional claim before anything is
 * sent. Exactly one of two workers can win it; the loser is told "taken"
 * and skips, which is a normal outcome and not an error. Nothing is sent
 * without a won claim, so a concurrent Stripe retry and a cron run cannot
 * produce two internal emails about one order.
 *
 * ONE BAD ROW NEVER STOPS THE BATCH. A missing checkout attempt, a
 * snapshot that will not render, a provider that refuses: each is caught
 * per row, counted, and the row is returned to 'failed' so it is eligible
 * again tomorrow. Returning it is the important half - a claim that threw
 * on its way to the send would otherwise leave 'sending' behind, which
 * nothing is eligible to pick up. That write cannot clobber a success,
 * because the only writer of 'sent' for a claimed row is the delivery
 * this loop just awaited, and a successful delivery does not throw.
 */
export async function runInternalNotificationRetrySweep<TAddress>(
  port: InternalNotificationRetryPort<TAddress>
): Promise<InternalNotificationRetrySummary> {
  const summary: InternalNotificationRetrySummary = { processed: 0, sent: 0, failed: 0, skipped: 0 };

  const rows = await port.loadFailedOrders();

  for (const row of rows) {
    summary.processed += 1;

    // The in-code half of the eligibility rule. The query already filters
    // on 'failed'; this refuses a NULL, 'sent' or 'sending' row that
    // reached the loop anyway, before it can be claimed or sent.
    if (!isRetryEligibleStatus(row.internal_notification_status)) {
      summary.skipped += 1;
      continue;
    }

    const claim = await port.claim(row.id);
    if (claim !== "claimed") {
      summary.skipped += 1;
      continue;
    }

    try {
      const attempt = row.checkout_attempt_id ? await port.loadAttempt(row.checkout_attempt_id) : null;
      await port.deliver(buildRetryNotificationParams(row, attempt));
      summary.sent += 1;
    } catch (err) {
      port.logFailure(row.id, err instanceof Error ? err.message : "unknown error");
      await port.markFailed(row.id);
      summary.failed += 1;
    }
  }

  return summary;
}

/* ══════════════════════════════════════════════════════════════
   STALE 'sending' RECOVERY
   ══════════════════════════════════════════════════════════════

   The one gap the failed-only sweep above cannot see.

   A worker that wins the claim (NULL-or-failed -> 'sending', or
   failed -> 'sending') and then dies before writing either 'sent' or
   'failed' leaves the row at 'sending' forever. 'sending' is deliberately
   not eligible for the retry sweep - it means "another worker holds
   this" - so nothing in the system would ever look at that row again,
   and fulfillment would silently never hear about a paid order.

   The fix is deliberately NOT a second sending path. Recovery only moves
   a genuinely stale row back to 'failed'; the existing sweep then picks
   it up on the same run and does the actual delivery through the one
   send path there has ever been. Nothing here builds an email, and
   nothing here talks to a mail provider.

   WHY updated_at IS THE RIGHT CLOCK, AND WHY IT IS SAFE. public.orders
   has carried a BEFORE UPDATE trigger since migration 004 that sets
   updated_at = now() on every row update, unconditionally and without the
   writer being able to influence it. The claim is an update, so
   updated_at is at least as recent as the moment the row was claimed -
   any later write (a refund sync, a status change) only pushes it
   further forward, never back. That direction is what makes it safe
   here: "updated_at is older than the cutoff" therefore implies "this
   row was claimed at least that long ago", so a freshly claimed row can
   never look stale. The reverse - a stale row that looks fresh because
   something else touched it - only delays a recovery, and delaying a
   recovery is the harmless direction.

   created_at is deliberately not used: it is the age of the ORDER, not of
   the claim, and every failed notification on an old order would look
   stale immediately. */

/**
 * How long a row may sit at 'sending' before it is presumed abandoned.
 *
 * Conservative by an order of magnitude. A legitimate in-flight
 * notification lives inside one serverless invocation, and the platform
 * kills that invocation long before this: the Vercel ceiling for a
 * function is minutes, not tens of minutes, and the repository sets no
 * maxDuration override, so no legitimate attempt can still be running
 * after thirty. Stripe gives up on a webhook response after thirty
 * seconds; the daily cron finishes its bounded batch in seconds.
 *
 * A server-side constant, never a request parameter and never a customer
 * setting: a caller who could shorten this could turn the recovery into a
 * duplicate-notification generator.
 */
export const STALE_SENDING_AFTER_MS = 30 * 60 * 1000;

/** How many stale rows one run may recover. Bounded like the sweep. */
export const STALE_RECOVERY_BATCH_LIMIT = 25;

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
 * Inclusive at the boundary: a row whose updated_at is exactly the cutoff
 * has been in flight for exactly the threshold and counts as stale. The
 * same comparison is used by the query and by the conditional write, so
 * all three agree on the boundary rather than differing by a millisecond.
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

/** A candidate row. Three columns, none of them a customer fact. */
export type StaleSendingRow = {
  id: string;
  internal_notification_status: string | null;
  updated_at: string | null;
};

/** What one conditional recovery write concluded. */
export type StaleRecoveryOutcome = "recovered" | "skipped";

/** Counts only. Recovered ids stay internal to the caller. */
export type StaleRecoverySummary = {
  /** Rows that looked stale when the work list was read. */
  staleFound: number;
  /** Rows this run actually moved from 'sending' back to 'failed'. */
  staleRecovered: number;
};

export type StaleSendingRecoveryPort = {
  /** Rows at 'sending' whose updated_at is at or before the cutoff. */
  loadStaleSending: (cutoffIso: string) => Promise<StaleSendingRow[]>;
  /**
   * The conditional write. Must verify BOTH that the row still says
   * 'sending' AND that its updated_at is still at or before the same
   * cutoff, in one statement. "skipped" means it lost the race, which is
   * a normal outcome and not an error.
   */
  recover: (orderId: string, cutoffIso: string) => Promise<StaleRecoveryOutcome>;
  /** Order id only. Never a customer fact. */
  logFailure: (orderId: string, message: string) => void;
};

/**
 * Moves genuinely stale 'sending' rows back to 'failed'.
 *
 * RACE BEHAVIOUR. The work list is a read, and a read is never trusted:
 * every recovery is a conditional UPDATE that re-checks the status and
 * the cutoff at write time. So if the original worker was not dead after
 * all and finished between the read and the write - by moving the row to
 * 'sent', or to 'failed', or simply by touching it and refreshing
 * updated_at - the write matches nothing and the row is left exactly as
 * that worker left it. A 'sent' notification can therefore never be
 * un-sent by this, and a genuinely active claim can never be stolen.
 *
 * It sends nothing. Recovery hands the row to the existing failed-only
 * sweep, which is and remains the only path that delivers a retry.
 *
 * A single row that cannot be recovered is counted and logged, never
 * thrown: one bad row must not keep the rest of the batch stuck at
 * 'sending' forever. A failure of the work-list query itself is a
 * different thing entirely and is left to propagate - see the caller.
 */
export async function runStaleSendingRecovery(
  port: StaleSendingRecoveryPort,
  cutoffIso: string
): Promise<StaleRecoverySummary> {
  const summary: StaleRecoverySummary = { staleFound: 0, staleRecovered: 0 };

  const rows = await port.loadStaleSending(cutoffIso);

  for (const row of rows) {
    // The in-code half of the stale rule. The query already applies it;
    // this refuses a row that reached the loop anyway - a NULL, 'failed'
    // or 'sent' row, or one that is not old enough - before it can be
    // written to at all.
    if (!isStaleSending(row.internal_notification_status, row.updated_at, cutoffIso)) continue;

    summary.staleFound += 1;

    try {
      if ((await port.recover(row.id, cutoffIso)) === "recovered") summary.staleRecovered += 1;
    } catch (err) {
      port.logFailure(row.id, err instanceof Error ? err.message : "unknown error");
    }
  }

  return summary;
}

/** What one cron invocation reports: recovery first, then the sweep. */
export type CronSweepSummary = StaleRecoverySummary & InternalNotificationRetrySummary;
