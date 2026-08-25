/**
 * When a shipment confirmation may be sent, and what it may say.
 *
 * Pure and leaf: no relative imports, no database, no network, no clock,
 * no environment - the same deliberate choice
 * lib/internalOrderNotificationRetryRules.ts makes, and for the same
 * reason. The plain Node test runner cannot import a module that uses
 * extension-less relative imports, so every decision worth testing
 * behaviourally has to live in a file like this one.
 * lib/shipmentConfirmationEmail.ts is the thin wiring that gives these
 * rules a Supabase client and a Resend client.
 *
 * ══════════════════════════════════════════════════════════════
 * TECHNISCH VORBEREITET - NOTHING CALLS THIS YET, AND THAT IS THE
 * HONEST STATE OF THE FEATURE.
 * ══════════════════════════════════════════════════════════════
 *
 * There is no server-side shipping transition in this repository. An
 * order becomes shipped when the OWNER writes the row directly, exactly
 * as migration 019 documents at its foot:
 *
 *     update public.orders
 *        set fulfillment_status = 'shipped',
 *            shipped_at         = now(),
 *            shipping_carrier   = 'DHL',   -- or NULL if unknown
 *            tracking_number    = '...',
 *            tracking_url       = '...'    -- or NULL if there is none
 *      where order_number = 'GLOA-2026-000123';
 *
 * That migration also withheld write access to those columns from
 * service_role on purpose: the website only ever reads them. So there is
 * currently no code path - no route, no webhook, no cron, no RPC - that
 * can move an order into 'shipped', and therefore no authorized moment
 * at which this email could fire.
 *
 * The infrastructure exists anyway because it is the half that can be
 * built correctly today: the durable state (migration 027), the atomic
 * claim, the eligibility rule and the idempotency key are all decided by
 * the order row, not by whoever eventually flips the switch. Wiring it
 * to a real shipment action is one small step, and none of it is a
 * reason to invent an admin endpoint now. What is deliberately NOT built
 * here: no public trigger, no customer-facing trigger, no "mark shipped"
 * route, and no sweep. See lib/shipmentConfirmationEmail.ts.
 *
 * THE RULE THIS FILE ENFORCES. A shipment confirmation may be sent only
 * after the durable order has genuinely reached a shipped state. Payment
 * is not shipment: a paid order, a completed checkout session, a
 * succeeded payment intent, a paid invoice, a customer opening the
 * success page and a redelivered Stripe webhook are all, individually and
 * together, insufficient. The only thing that makes an order eligible is
 * the order row saying it shipped.
 */

/**
 * The fulfillment states that genuinely mean "this left the building".
 *
 * 'delivered' is included because it is strictly later than 'shipped' and
 * migration 019 says it is only ever set from a real delivery
 * confirmation - an order that reached the customer was unquestionably
 * shipped, and refusing to confirm it would be the wrong answer. Every
 * other value in migration 004's vocabulary - 'unfulfilled',
 * 'processing', 'cancelled' - is not a shipment and never becomes one by
 * being paid for.
 */
export const SHIPPED_FULFILLMENT_STATUSES = ["shipped", "delivered"] as const;

/** The in-flight email status. Owned by whichever worker won the claim. */
export const IN_FLIGHT_STATUS = "sending";

/**
 * The one status a future retry sweep may ever key on.
 *
 * NULL is deliberately not on this list. Migration 027 makes the column
 * nullable with no default precisely so that every order written before
 * it - including any order the owner has ALREADY shipped by hand - is
 * NULL rather than looking like queued work. 'failed' can only be written
 * by code that genuinely tried to send and genuinely failed, so a sweep
 * keyed on it cannot email the order history.
 */
export const RETRY_ELIGIBLE_STATUS = "failed";

/** The complete durable vocabulary, mirroring migration 027's CHECK. */
export const SHIPMENT_EMAIL_STATUSES = ["sending", "sent", "failed"] as const;

/**
 * The persisted order columns this decision is made from.
 *
 * Generic in the address snapshot so this file stays a leaf: the wiring
 * module supplies the real AddressSnapshot type and passes the snapshot
 * through untouched. A shipment confirmation describes the order that
 * exists, so nothing here re-derives an address, re-prices a line or
 * consults Stripe.
 */
export type ShipmentOrderRow<TAddress> = {
  id: string;
  order_number: string;
  user_id: string | null;
  fulfillment_status: string | null;
  shipped_at: string | null;
  shipping_carrier: string | null;
  tracking_number: string | null;
  tracking_url: string | null;
  shipping_address_snapshot: TAddress | null;
  /**
   * The order's own frozen customer snapshot, which is where the
   * recipient comes from. Carried on the row rather than passed
   * alongside it, so that "who this email goes to" is a property of the
   * durable order and there is no parameter anywhere by which a caller
   * could choose a different address.
   */
  customer_snapshot: unknown;
  shipment_email_status: string | null;
};

function nonBlank(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/**
 * Whether the durable order genuinely says it shipped.
 *
 * BOTH halves are required, and the second one is not redundant. A
 * fulfillment_status of 'shipped' with no shipped_at is a half-written
 * row - the owner updates several columns in one statement, but a
 * partially applied or hand-edited row must not produce a confirmation
 * about a shipment whose date the shop cannot state. Requiring the
 * timestamp also gives the email something true to print instead of an
 * invented date.
 */
export function isGenuinelyShipped(
  fulfillmentStatus: string | null | undefined,
  shippedAt: string | null | undefined
): boolean {
  const status = nonBlank(fulfillmentStatus);
  if (!status) return false;
  if (!(SHIPPED_FULFILLMENT_STATUSES as readonly string[]).includes(status)) return false;
  return nonBlank(shippedAt) !== null;
}

/**
 * Whether a caller that has just performed an authorized shipment
 * transition may claim this order's confirmation.
 *
 * NULL (never attempted) or 'failed' (attempted, failed, still owed).
 * 'sending' belongs to whoever holds it; 'sent' is done.
 *
 * This is the direct-caller condition, and it is deliberately wider than
 * the sweep condition below - the same split
 * lib/internalOrderNotificationEmail.ts makes between the webhook and the
 * retry. It is only ever safe for a caller that has itself just moved the
 * order into 'shipped', because such a caller knows the row is not a
 * historical one. No such caller exists yet.
 */
export function isShipmentEmailClaimable(status: string | null | undefined): boolean {
  return status === null || status === undefined || status === RETRY_ELIGIBLE_STATUS;
}

/**
 * Whether an unattended sweep may claim this order's confirmation.
 *
 * 'failed' and nothing else, ever. This is the narrow condition, and the
 * difference from the one above is the whole safety property: a sweep
 * that accepted NULL would, on its first run, email every customer whose
 * order the owner had already shipped by hand before migration 027
 * existed.
 *
 * No sweep exists today - see lib/shipmentConfirmationEmail.ts - but the
 * predicate is defined here so that whoever writes one cannot quietly
 * choose a wider rule.
 */
export function isShipmentEmailSweepEligible(status: string | null | undefined): boolean {
  return status === RETRY_ELIGIBLE_STATUS;
}

/**
 * The complete eligibility rule for a direct caller: genuinely shipped,
 * and not already sent or in flight.
 *
 * Both halves, in one place, so no call site can accidentally check only
 * the email state and mail a customer whose parcel has not moved.
 */
export function isShipmentConfirmationEligible<TAddress>(row: ShipmentOrderRow<TAddress>): boolean {
  return (
    isGenuinelyShipped(row.fulfillment_status, row.shipped_at) &&
    isShipmentEmailClaimable(row.shipment_email_status)
  );
}

/** Tracking as it will be rendered, or null when there is nothing real. */
export type ShipmentTrackingSelection = {
  carrier: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
};

/**
 * Picks the tracking facts that genuinely exist.
 *
 * Returns null - meaning "render no tracking block at all" - when not one
 * of the three is present. A blank string is not a fact and becomes null,
 * so "no tracking" has exactly one representation downstream.
 *
 * Nothing here guesses. A carrier is never inferred from the shape of a
 * tracking number, and a URL is never assembled from a carrier name: if
 * the owner stored a number and no link, the customer sees the number on
 * its own, which is a perfectly ordinary shipment confirmation. There is
 * no carrier lookup table in this repository and this function must never
 * become one.
 *
 * `trackingUrl` is expected to have ALREADY been sanitized by the caller
 * with sanitizeTrackingUrl from lib/orderStatus.ts - the same contract
 * lib/email/shipmentConfirmation.ts states for its own input. This module
 * is a leaf and cannot import that check; the wiring applies it, and the
 * database CHECK from migration 019 is the third guard.
 */
export function selectShipmentTracking(
  carrier: string | null | undefined,
  trackingNumber: string | null | undefined,
  sanitizedTrackingUrl: string | null | undefined
): ShipmentTrackingSelection | null {
  const selected: ShipmentTrackingSelection = {
    carrier: nonBlank(carrier),
    trackingNumber: nonBlank(trackingNumber),
    trackingUrl: nonBlank(sanitizedTrackingUrl),
  };
  if (!selected.carrier && !selected.trackingNumber && !selected.trackingUrl) return null;
  return selected;
}

/** What one send attempt concluded. */
export type ShipmentSendOutcome = "sent" | "already-sent" | "not-eligible" | "failed";

/** What a claim attempt concluded. */
export type ShipmentClaimOutcome = "claimed" | "taken" | "error";

/* ══════════════════════════════════════════════════════════════
   THE STATE MACHINE
   ══════════════════════════════════════════════════════════════ */

/**
 * The two external systems one send touches, as one injectable port.
 *
 * Everything below is decided here; nothing below knows what a database
 * or an email provider is. The same shape
 * InternalNotificationRetryPort uses, and for the same reason: it is what
 * lets the claim, the outcome and - critically - the "an email failure
 * must not un-ship the parcel" rule be tested for real rather than
 * asserted about in a comment.
 *
 * Note what the port CANNOT express. There is no markShipped, no
 * markUnshipped, no writeTracking and no setFulfillmentStatus. The state
 * machine is not given the ability to touch business state, so it cannot
 * lose it - the property is structural here exactly as the column-scoped
 * grant makes it structural in migration 027.
 */
export type ShipmentConfirmationPort<TAddress> = {
  /**
   * Atomic claim. Must refuse any row that is not genuinely shipped, and
   * any row whose email status is not NULL or 'failed', in one statement.
   * "taken" means it lost the race, which is a normal outcome.
   */
  claim: (orderId: string) => Promise<ShipmentClaimOutcome>;
  /** Sends a confirmation whose claim has already been won. Throws on failure. */
  deliver: (row: ShipmentOrderRow<TAddress>) => Promise<void>;
  /** Records a delivered confirmation. */
  markSent: (orderId: string) => Promise<void>;
  /** Returns a claimed row to 'failed'. Must not touch shipment state. */
  markFailed: (orderId: string) => Promise<void>;
  /** Order id and provider message only. Never a customer fact. */
  logFailure: (orderId: string, message: string) => void;
};

/**
 * One order, from eligibility to durable outcome.
 *
 * THE ORDER OF OPERATIONS IS THE POINT:
 *
 *   1. the durable order already says it shipped        (checked, not caused)
 *   2. the claim is won atomically                      (or we stop)
 *   3. the email is sent
 *   4. the durable email state records what happened
 *
 * Step 1 is a read of state someone else established. This function never
 * ships anything, and there is no argument by which a caller could tell
 * it that an order shipped - it only ever believes the row. A payment
 * event, a success page view or a browser claiming shipped=true all
 * arrive here as an order row that does not say 'shipped', and are
 * refused identically.
 *
 * ON FAILURE THE SHIPMENT IS UNAFFECTED. The catch writes 'failed' to the
 * email column and does nothing else: the parcel is gone, the order stays
 * shipped, the tracking stays as it is. A mail provider having a bad
 * minute is not a reason to corrupt the business record, and 'failed' is
 * precisely the state that leaves a future retry possible.
 *
 * It never throws. Its eventual caller will be a shipment action, and an
 * exception here would be an invitation to roll that action back.
 */
export async function runShipmentConfirmation<TAddress>(
  port: ShipmentConfirmationPort<TAddress>,
  row: ShipmentOrderRow<TAddress>
): Promise<ShipmentSendOutcome> {
  // The in-code half of the eligibility rule. The claim applies the same
  // rule again in SQL - two independent refusals, so no single mistake
  // can tell a customer their parcel is on its way when it is not.
  if (!isGenuinelyShipped(row.fulfillment_status, row.shipped_at)) return "not-eligible";
  if (!isShipmentEmailClaimable(row.shipment_email_status)) return "already-sent";

  const claim = await port.claim(row.id);
  if (claim === "taken") return "already-sent";
  if (claim === "error") return "failed";

  try {
    await port.deliver(row);
  } catch (err) {
    port.logFailure(row.id, err instanceof Error ? err.message : "unknown error");
    await port.markFailed(row.id);
    return "failed";
  }

  await port.markSent(row.id);
  return "sent";
}
