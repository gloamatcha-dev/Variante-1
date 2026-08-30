import { handleAnnualPlanCheckout } from "../../../../../lib/annualPlanCheckout";
import { defaultAnnualCheckoutDeps } from "../../../../../lib/annualPlanCheckoutDeps";

/**
 * POST /api/annual-plan/checkout/session (Phase 4B3)
 *
 * Starts a B2C PREPAID annual plan: one payment now, thirteen deliveries
 * 28 days apart, no renewal and no Stripe Subscription.
 *
 * A DEDICATED ENDPOINT, and the third one. The one-time route prices a
 * cart, runs mode "payment" and allows guest checkout; the subscription
 * route runs mode "subscription" and mints recurring Prices. An annual
 * plan is neither - it is a single payment for a fixed thirteen-delivery
 * contract that must be account-bound - and overloading either would have
 * put a twelve-month obligation behind a flow written for something else.
 *
 * The flow itself lives in lib/annualPlanCheckout.ts and its real wiring
 * in lib/annualPlanCheckoutDeps.ts, so the whole thing can be driven end
 * to end with stubs in tests: no network call, no Stripe object, no
 * database write.
 *
 * Gated by B2C_ANNUAL_PLAN_ENABLED, server-side, before anything else
 * happens. The flag is closed by default and the payment webhook does not
 * exist yet, so a plan started today could be paid for and never
 * activated.
 *
 * IT CREATES NO ENTITLEMENT. Returning 200 means a Stripe Checkout
 * Session exists and a PENDING annual plan is waiting for it. No plan is
 * activated, no delivery is scheduled, no order is created and no email
 * is sent - those belong to the webhook phase.
 */
export async function POST(request: Request): Promise<Response> {
  return handleAnnualPlanCheckout(request, defaultAnnualCheckoutDeps);
}
