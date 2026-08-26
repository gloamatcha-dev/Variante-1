/**
 * When the internal cancellation request notification may be sent, and
 * when it may not (Phase 2D-A).
 *
 * Pure and leaf: no relative imports, no database, no network, no clock,
 * no environment - the same choice lib/shipmentConfirmationRules.ts,
 * lib/shipmentTransitionRules.ts, lib/orderCancellationRules.ts and
 * lib/internalOrderNotificationRetryRules.ts make, so the eligibility
 * rules are unit-testable rather than only reachable through a live
 * database.
 *
 * THE ONE RULE THAT MATTERS MOST is the NULL rule, and it is a rule about
 * production data rather than about code. public.orders may already hold
 * rows with a non-NULL cancellation_requested_at: the customer request
 * endpoint has been live since Phase 2A and every request it recorded is
 * sitting there with nobody notified. Those rows have a NULL notification
 * status, and NULL means "this feature did not exist when this happened",
 * NOT "queued work".
 *
 * A predicate of the shape "requested and status is null" is therefore
 * forbidden as a SWEEP rule: its first run would mail the fulfillment
 * inbox about every historical request at once. It is legitimate only as
 * a LIVE rule, at the moment a customer has just pressed the button,
 * because then the request is happening now and the notification is
 * genuinely owed. Those two cases are separated below into
 * isLiveNotificationClaimable and isNotificationSweepEligible so that a
 * future sweep cannot reach for the wrong one by accident.
 */

/**
 * The complete vocabulary of migration 030's status column.
 *
 * There is deliberately no 'pending'. A row is either outside this flow
 * entirely (NULL), being sent right now, delivered to the provider, or
 * owed a retry. Nothing in this repository queues, so no value means
 * "queued".
 */
export const CANCELLATION_NOTIFICATION_STATUSES = ["sending", "sent", "failed"] as const;

export type CancellationNotificationStatus = (typeof CANCELLATION_NOTIFICATION_STATUSES)[number];

/** What the sender reports back. It never throws for an ordinary outcome. */
export type CancellationNotificationOutcome =
  /** Delivered to the provider now, for the first time. */
  | "sent"
  /** Someone else already sent it, or is sending it right now. */
  | "already-sent"
  /** No cancellation request on this order, or no such order. */
  | "not-eligible"
  /** Attempted and failed. The row is 'failed' and a repeat may retry. */
  | "failed";

/**
 * Whether a status may be claimed by a LIVE send - one happening right
 * now, immediately after a customer's request has committed.
 *
 * NULL is claimable here, and only here. At this moment the request was
 * made seconds ago by a signed-in customer who is still looking at the
 * page, so "never attempted" genuinely means "owed now".
 *
 * 'sent' is never claimable: a delivered message is delivered.
 * 'sending' is never claimable: another caller holds the claim, and
 * competing with it is exactly how a duplicate is produced.
 * 'failed' is claimable, which is what makes a repeated customer request
 * a safe manual retry.
 */
export function isLiveNotificationClaimable(status: string | null | undefined): boolean {
  if (status === null || status === undefined) return true;
  return status === "failed";
}

/**
 * Whether a status may be claimed by a SWEEP - a background job running
 * over rows nobody is currently watching.
 *
 * STRICTLY NARROWER THAN THE LIVE RULE, and that asymmetry is the whole
 * point of this module. 'failed' and nothing else. NULL is refused,
 * because a NULL row is either a historical request from before this
 * feature existed or a request whose live send is about to happen - and
 * in neither case may a background job mail anyone about it.
 *
 * No sweep exists yet (Phase 2D-A deliberately adds no cron). This
 * predicate exists now so that the rule is written down and tested before
 * anybody writes the job, rather than being rediscovered afterwards.
 */
export function isNotificationSweepEligible(status: string | null | undefined): boolean {
  return status === "failed";
}

/** The order fields this decision depends on. Nothing else is read. */
export type CancellationNotificationOrderState = {
  /** Migration 019. NULL means no cancellation was ever requested. */
  cancellation_requested_at: string | null;
  /** Migration 030. NULL means this order was never part of the flow. */
  cancellation_request_notification_status: string | null;
};

/**
 * Whether a live send is owed for this order right now.
 *
 * Both halves are required. A notification status of NULL on an order
 * with no cancellation request is not "owed" - it is an ordinary order
 * that nobody asked to stop, and it must never produce a message.
 *
 * This is the code half of a guarantee the database also enforces: the
 * claim UPDATE repeats `cancellation_requested_at is not null` in its
 * WHERE clause, so the request cannot vanish between this check and the
 * write and still produce an email. Two independent refusals, so no
 * single mistake can tell the fulfillment inbox that a customer asked to
 * stop an order they never asked to stop.
 */
export function isLiveNotificationOwed(order: CancellationNotificationOrderState): boolean {
  if (!order.cancellation_requested_at) return false;
  return isLiveNotificationClaimable(order.cancellation_request_notification_status);
}
