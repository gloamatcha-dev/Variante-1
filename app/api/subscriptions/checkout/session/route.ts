import { handleSubscriptionCheckout } from "../../../../../lib/subscriptionCheckout";
import { defaultSubscriptionCheckoutDeps } from "../../../../../lib/subscriptionCheckoutDeps";

/**
 * POST /api/subscriptions/checkout/session (Task 29D-D)
 *
 * A dedicated endpoint. The one-time route stays exactly as it is: it
 * runs mode "payment", allows guest checkout and prices a cart, none of
 * which a four-weekly subscription wants. Overloading it would have made
 * both flows harder to reason about and put a subscription behind the
 * same guest path.
 *
 * The flow itself lives in lib/subscriptionCheckout.ts and its real
 * wiring in lib/subscriptionCheckoutDeps.ts, so the whole thing can be
 * driven end to end with stubs in tests: no network call, no Stripe
 * object, no database write.
 *
 * Gated by B2C_SUBSCRIPTIONS_ENABLED, server-side, before anything else
 * happens.
 *
 * ── THE ORIGINAL REASON FOR THE GATE IS GONE ──────────────────
 *
 * This comment used to say Task 29D-E was not built, so a subscription
 * started here could be paid for and never activated. That has not been
 * true for some time: invoice.paid is handled in the webhook and calls
 * activate_subscription_from_invoice, and the cancellation, refund and
 * lifecycle-mail paths exist as well.
 *
 * The flag stays closed for a different and current reason - the offer
 * has not been opened commercially, and the account portal is only now
 * gaining the form that calls this route. It is a launch switch, not a
 * placeholder for missing machinery.
 */
export async function POST(request: Request): Promise<Response> {
  return handleSubscriptionCheckout(request, defaultSubscriptionCheckoutDeps);
}
