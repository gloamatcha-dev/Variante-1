/**
 * Server-side checkout policy for new purchases. Only the exact "live"
 * status permits checkout. Presentation and already-paid orders use
 * their own existing paths.
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

/** Customer-facing refusal shared by all checkout routes. */
export const CHECKOUT_CLOSED_MESSAGE =
  "Bestellungen sind vorübergehend nicht möglich.";

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
