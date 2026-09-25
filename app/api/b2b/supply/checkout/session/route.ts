import { handleB2bCheckout } from "../../../../../../lib/b2bCheckout";
import { defaultB2bCheckoutDeps } from "../../../../../../lib/b2bCheckoutDeps";

/**
 * POST /api/b2b/supply/checkout/session (Package 5B)
 *
 * Starts a B2B SELF-SERVICE SUPPLY agreement: 1 to 10 packs of Matcha a
 * month, monthly on a Stripe Subscription or annual as a fixed
 * twelve-month contract paid in 1, 2 or 4 instalments.
 *
 * A DEDICATED ENDPOINT, and the fourth one. The one-time route prices a
 * gross-origin cart and allows guest checkout; the subscription route
 * runs a four-weekly consumer cadence; the annual route buys a fixed
 * thirteen-delivery consumer plan. B2B is none of those - it is
 * net-origin, single-product, business-only and contractual - and
 * overloading any of them would have put a commercial supply contract
 * behind a flow written for a consumer.
 *
 * The flow lives in lib/b2bCheckout.ts and its real wiring in
 * lib/b2bCheckoutDeps.ts, so the whole thing can be driven end to end
 * with stubs: no network call, no Stripe object, no database write.
 *
 * Gated by B2B_SELF_SERVICE_ENABLED, server-side, before the body is
 * read and long before any database write or Stripe call. The flag is
 * closed by default and stays closed in production until Packages 5D
 * (instalment invoicing), 5E (delivery resolution) and 5F (payment
 * failure and holds) exist.
 *
 * IT CREATES NO ENTITLEMENT. Returning 200 means a Stripe Checkout
 * Session exists and a PENDING agreement is waiting for it. No agreement
 * is activated, no payment schedule is written, no delivery is created
 * and no order exists - those belong to the webhook and to migration 062.
 */
export async function POST(request: Request): Promise<Response> {
  return handleB2bCheckout(request, defaultB2bCheckoutDeps);
}
