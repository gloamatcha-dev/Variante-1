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
 * happens. Task 29D-E is not built yet, so a subscription started today
 * could be paid for and never activated.
 */
export async function POST(request: Request): Promise<Response> {
  return handleSubscriptionCheckout(request, defaultSubscriptionCheckoutDeps);
}
