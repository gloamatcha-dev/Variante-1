/**
 * MAY THE SHOP TAKE MONEY RIGHT NOW?
 *
 * One question, one answer, derived from ONE value: SHOP_STATUS in
 * app/content.ts. This module holds no status of its own, reads no
 * environment variable and imports nothing - the caller passes the
 * status in, which is what makes both states testable without a
 * rebuild and what keeps this from becoming a second launch flag.
 *
 * ── WHY THE SERVER NEEDS THIS AT ALL ──────────────────────────
 *
 * The prelaunch shop already routes every buy button to /contact and
 * withholds every public price (PRICES_VISIBLE, same single source).
 * That is presentation. It is defeated by anyone who keeps a cart in
 * localStorage from a live build, replays a saved request, or simply
 * POSTs to /api/checkout/session by hand - none of which involve a
 * button. The checkout session endpoint is the only thing in this
 * repository that can hand a customer a payable Stripe page, so it is
 * where "the shop is closed" has to be enforced rather than displayed.
 *
 * ── FAIL CLOSED ───────────────────────────────────────────────
 *
 * Selling requires the exact string "live". "prelaunch", "LIVE",
 * " live ", an empty string, a typo introduced while editing
 * app/content.ts on launch day - every one of them means the shop does
 * not sell. The dangerous direction here is selling when nobody meant
 * to, so the permissive branch is the narrow one.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT DECIDE ────────────────────
 *
 * Not whether a price may be RENDERED (PRICES_VISIBLE, app/content.ts).
 * Not whether subscriptions or the annual plan may be booked - those
 * have their own closed-by-default environment flags and are out of
 * this launch. Not whether a paid order may be fulfilled: an order that
 * was legitimately paid for must still be processed, emailed and
 * shipped no matter what SHOP_STATUS says afterwards.
 */

/** The exact status in which this shop may charge a customer. */
export const SHOP_STATUS_LIVE = "live";

/**
 * 409, not 403 and not 503. The request is well-formed and the caller is
 * allowed to make it; the shop is simply not open yet, which is a
 * conflict with the current state of the resource rather than a
 * permission problem or an outage. It is also not a 500: a closed shop
 * is an expected answer, not a fault.
 */
export const CHECKOUT_CLOSED_STATUS = 409;

/**
 * Customer-facing and deliberately plain. It says what is true (no
 * orders yet), points at the one thing that IS open, and promises no
 * date - the launch date lives in lib/launchCountdown.ts and is not
 * repeated here where it could drift.
 */
export const CHECKOUT_CLOSED_MESSAGE =
  "Der Shop ist noch nicht eröffnet. Bestellungen sind erst zum Launch möglich - trag dich solange in die Launch List ein.";

/** Whether the shop may complete a purchase at this status. */
export function shopSellsNow(shopStatus: string): boolean {
  return shopStatus === SHOP_STATUS_LIVE;
}

export type CheckoutRefusal = {
  status: number;
  error: string;
};

/**
 * The refusal a checkout endpoint must return at this status, or null
 * when the shop is open and the request may proceed.
 *
 * Returning the whole response shape rather than a boolean is what keeps
 * every future checkout entry point answering identically: a caller
 * cannot accidentally invent its own status code or its own wording.
 */
export function checkoutRefusalFor(shopStatus: string): CheckoutRefusal | null {
  if (shopSellsNow(shopStatus)) return null;
  return { status: CHECKOUT_CLOSED_STATUS, error: CHECKOUT_CLOSED_MESSAGE };
}
