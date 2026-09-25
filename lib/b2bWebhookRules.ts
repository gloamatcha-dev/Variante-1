import type Stripe from "stripe";

/**
 * Every routing decision the B2B webhook branch makes, and none of the
 * side effects (Package 5C).
 *
 * A LEAF: type-only imports, no relative value import, no database, no
 * network, no Stripe client, no clock. The flow lives in
 * lib/b2bWebhook.ts and its wiring in lib/b2bWebhookDeps.ts, so
 * everything worth executing is here and can be driven in a plain Node
 * test.
 *
 * ── WHAT THIS FILE REFUSES TO DO ──────────────────────────────
 *
 * It computes no money, no date and no schedule. Migration 062 owns all
 * three. It decides nothing from metadata alone either: metadata says
 * WHICH ROWS to look at, and the database says whether they are what the
 * metadata claims.
 *
 * The routing key constants are restated here rather than imported from
 * lib/b2bCheckoutRules.ts, exactly as lib/annualPlanWebhookRules.ts
 * restates the annual ones: a value import between two sibling leaves
 * would make both unloadable by the test runner. The focused suite
 * asserts the two agree.
 */

/** Must equal B2B_SESSION_AGREEMENT_METADATA_KEY in b2bCheckoutRules. */
export const B2B_SESSION_AGREEMENT_METADATA_KEY = "gloa_b2b_agreement_id";
/** Must equal B2B_CHECKOUT_VERSION in b2bCheckoutRules. */
export const B2B_SESSION_CHECKOUT_VERSION = "1";

/**
 * The key the MONTHLY flow additionally writes onto the Stripe
 * SUBSCRIPTION through subscription_data.metadata.
 *
 * It is the same key, deliberately. invoice.paid can be delivered BEFORE
 * checkout.session.completed, and at that moment the agreement row does
 * not yet carry stripe_subscription_id - so the only way to find the
 * agreement from an invoice is the subscription's own metadata. Using a
 * second key name for the same fact would create a second routing
 * authority that could disagree with the first.
 */
export const B2B_SUBSCRIPTION_AGREEMENT_METADATA_KEY = B2B_SESSION_AGREEMENT_METADATA_KEY;

/**
 * The routing keys owned by the other three flows. A B2B object must
 * never carry one; if it does, two handlers would each believe it theirs.
 */
export const B2B_FOREIGN_ROUTING_KEYS: readonly string[] = Object.freeze([
  "gloa_annual_plan_id",
  "gloa_subscription_id",
  "gloa_checkout_attempt_id",
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The four correlation identifiers a B2B session must carry. */
export type B2bSessionMetadata = {
  checkoutVersion: string;
  requestId: string;
  checkoutAttemptId: string;
  agreementId: string;
};

export type B2bSessionRouting =
  /** Not a B2B session. Every existing branch keeps it, unchanged. */
  | { kind: "not_b2b" }
  /** B2B, and its correlation metadata is well formed. */
  | { kind: "b2b"; metadata: B2bSessionMetadata }
  /**
   * B2B by the routing key, but the rest is unusable.
   *
   * NOT "not B2B". A session carrying an agreement id IS a B2B session,
   * and letting it fall through to a handler written for another product
   * would settle a business supply contract as a consumer cart - or, for
   * a monthly session running mode "subscription", hand it to the B2C
   * subscription handler which would look for a gloa_subscription_id row
   * that does not exist. The caller must stop, loudly: somebody has
   * already been charged.
   */
  | { kind: "malformed"; reason: string };

/**
 * Decides whether a Checkout Session belongs to the B2B branch.
 *
 * THE PRESENCE OF THE AGREEMENT KEY IS THE DECISION. It is the only key
 * of the four that no other flow ever writes:
 *
 *   one-time      checkout_version, request_id, checkout_attempt_id
 *   subscription  gloa_subscription_id, and mode "subscription"
 *   annual        gloa_annual_plan_id
 *   B2B           gloa_b2b_agreement_id
 *
 * Nothing about the amount, the plan, the pack count, the company name,
 * the email or the customer is a routing key. All of those are
 * customer-visible or configuration-derived, all can coincide across
 * products, and one of them changing must never re-route a payment.
 */
export function routeB2bSession(
  metadata: Stripe.Metadata | Record<string, unknown> | null | undefined
): B2bSessionRouting {
  const raw = (metadata ?? {}) as Record<string, unknown>;
  const agreementId = raw[B2B_SESSION_AGREEMENT_METADATA_KEY];

  if (typeof agreementId !== "string" || agreementId.trim() === "") {
    return { kind: "not_b2b" };
  }

  if (!UUID_RE.test(agreementId)) {
    return { kind: "malformed", reason: `${B2B_SESSION_AGREEMENT_METADATA_KEY} is not a uuid` };
  }
  if (raw.checkout_version !== B2B_SESSION_CHECKOUT_VERSION) {
    return { kind: "malformed", reason: "checkout_version is not the B2B checkout version" };
  }
  const requestId = raw.request_id;
  if (typeof requestId !== "string" || !UUID_RE.test(requestId)) {
    return { kind: "malformed", reason: "request_id is missing or not a uuid" };
  }
  const checkoutAttemptId = raw.checkout_attempt_id;
  if (typeof checkoutAttemptId !== "string" || !UUID_RE.test(checkoutAttemptId)) {
    return { kind: "malformed", reason: "checkout_attempt_id is missing or not a uuid" };
  }
  for (const key of B2B_FOREIGN_ROUTING_KEYS) {
    const foreign = raw[key];
    if (typeof foreign === "string" && foreign.trim() !== "") {
      return { kind: "malformed", reason: `a B2B session also carries ${key}` };
    }
  }

  return {
    kind: "b2b",
    metadata: {
      checkoutVersion: B2B_SESSION_CHECKOUT_VERSION,
      requestId,
      checkoutAttemptId,
      agreementId,
    },
  };
}

/* ── The invoice side ───────────────────────────────────────── */

export type B2bInvoiceRouting =
  /** Not a B2B invoice. The B2C subscription handler keeps it. */
  | { kind: "not_b2b" }
  | { kind: "b2b"; agreementId: string; stripeSubscriptionId: string }
  | { kind: "malformed"; reason: string };

/**
 * Decides whether a paid invoice belongs to a B2B supply agreement.
 *
 * READ FROM THE SUBSCRIPTION, NOT THE INVOICE. The invoice itself carries
 * no GLOA metadata: Stripe generates it, and subscription_data.metadata
 * lands on the SUBSCRIPTION. So the caller re-reads the subscription from
 * Stripe and hands its metadata here.
 *
 * That is also what makes this safe for B2C: a consumer subscription
 * carries gloa_subscription_id and no agreement key, so it answers
 * not_b2b and the existing handler keeps it untouched.
 */
export function routeB2bSubscriptionInvoice(
  subscriptionMetadata: Stripe.Metadata | Record<string, unknown> | null | undefined,
  stripeSubscriptionId: string | null | undefined
): B2bInvoiceRouting {
  const raw = (subscriptionMetadata ?? {}) as Record<string, unknown>;
  const agreementId = raw[B2B_SUBSCRIPTION_AGREEMENT_METADATA_KEY];

  if (typeof agreementId !== "string" || agreementId.trim() === "") {
    return { kind: "not_b2b" };
  }
  if (!UUID_RE.test(agreementId)) {
    return { kind: "malformed", reason: `${B2B_SUBSCRIPTION_AGREEMENT_METADATA_KEY} is not a uuid` };
  }
  // A subscription may belong to exactly one flow.
  const consumer = raw.gloa_subscription_id;
  if (typeof consumer === "string" && consumer.trim() !== "") {
    return { kind: "malformed", reason: "a B2B subscription also carries gloa_subscription_id" };
  }
  if (typeof stripeSubscriptionId !== "string" || stripeSubscriptionId.trim() === "") {
    return { kind: "malformed", reason: "a B2B invoice carries no subscription id" };
  }

  return { kind: "b2b", agreementId, stripeSubscriptionId: stripeSubscriptionId.trim() };
}

/**
 * What a B2B payment FAILURE event means today (Package 5C).
 *
 * ── IT MEANS "NOT YET IMPLEMENTED", AND THAT IS THE POINT ─────
 *
 * Package 5F owns the failure and hold state machine. Until it lands
 * there is no correct B2B mutation for invoice.payment_failed, and two
 * wrong answers were available:
 *
 *   1. Let it fall into the B2C handler. That handler sends the consumer
 *      payment-problem email and reconciles a public.subscriptions row
 *      that does not exist for a B2B agreement. Wrong customer, wrong
 *      table.
 *   2. Mark it handled. The webhook records an event id only AFTER
 *      successful processing, so "handled" would put this event in
 *      stripe_webhook_events and 5F could never replay it.
 *
 * So this is a pure classification that the route uses to take NO action
 * and record nothing beyond a log line. It mutates nothing, sends
 * nothing, and - because the route returns normally rather than throwing
 * - Stripe is not asked to retry an event nobody can yet act on.
 *
 * The event is still recorded as processed, which is correct: 5F will act
 * on FUTURE failures, and the flag is closed in production so no real B2B
 * invoice can fail before 5F ships. The focused suite asserts that this
 * path performs no write of any kind.
 */
export function acknowledgeB2bPaymentFailure(agreementId: string, stripeInvoiceId: string): {
  action: "none";
  message: string;
} {
  return {
    action: "none",
    message:
      `B2B invoice ${stripeInvoiceId} for agreement ${agreementId} failed: no hold state exists `
      + `until Package 5F - nothing was mutated, no email sent, no B2C path entered.`,
  };
}
