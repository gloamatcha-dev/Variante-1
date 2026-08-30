import { getSupabaseAdmin } from "./supabaseAdmin";
import type { CheckoutQuote } from "./checkoutQuote";
import { buildItemsSnapshot, type CheckoutAttemptItemSnapshot } from "./checkoutAttemptSnapshot";
import type { ShippingZoneKey } from "./shipping";
import type { CartTaxSnapshot } from "./tax";

export type { CheckoutAttemptItemSnapshot };
export { buildItemsSnapshot };

export type CheckoutAttemptStatus = "created" | "stripe_session_created" | "paid" | "failed" | "expired";

export type CheckoutAttemptShipping = {
  country: string;
  zone: ShippingZoneKey;
  grossCents: number;
};

export type CheckoutAttempt = {
  id: string;
  request_id: string;
  status: CheckoutAttemptStatus;
  currency: string;
  expected_total_gross_cents: number;
  items_snapshot: CheckoutAttemptItemSnapshot[];
  shipping_country: string | null;
  shipping_zone: ShippingZoneKey | null;
  shipping_gross_cents: number | null;
  /**
   * The frozen tax result, or null when this destination's VAT is
   * genuinely not implemented (UK, Switzerland, Norway, third
   * countries) - unknown, never a fabricated zero.
   */
  tax_snapshot: CartTaxSnapshot | null;
  stripe_checkout_session_id: string | null;
  stripe_payment_intent_id: string | null;
};

const ATTEMPT_COLUMNS =
  "id, request_id, status, currency, expected_total_gross_cents, items_snapshot, shipping_country, shipping_zone, shipping_gross_cents, tax_snapshot, stripe_checkout_session_id, stripe_payment_intent_id";

export type GetOrCreateAttemptResult =
  | { ok: true; attempt: CheckoutAttempt }
  | { ok: false; error: string };

/**
 * Gets or creates the checkout attempt for a request_id. Idempotent: on a
 * retry, the original locked-in snapshot/expected total is returned
 * unchanged rather than being overwritten by a freshly recomputed quote -
 * a later catalog price change must never invalidate an attempt a
 * customer is already paying against. The DB unique constraint on
 * request_id is the real race guard, not this select-then-insert order.
 */
export async function getOrCreateCheckoutAttempt(
  requestId: string,
  quote: CheckoutQuote,
  shipping: CheckoutAttemptShipping,
  taxSnapshot: CartTaxSnapshot | null,
  userId: string | null = null
): Promise<GetOrCreateAttemptResult> {
  const admin = getSupabaseAdmin();
  if (!admin) {
    return { ok: false, error: "Checkout-Speicherung vorübergehend nicht verfügbar." };
  }

  const { error: upsertError } = await admin
    .from("checkout_attempts")
    .upsert(
      {
        request_id: requestId,
        user_id: userId,
        currency: quote.currency,
        // The customer's total obligation is merchandise + shipping -
        // Stripe's amount_total must match this exactly.
        expected_total_gross_cents: quote.subtotalGrossCents + shipping.grossCents,
        items_snapshot: buildItemsSnapshot(quote),
        shipping_country: shipping.country,
        shipping_zone: shipping.zone,
        shipping_gross_cents: shipping.grossCents,
        // Frozen with the prices, and for the same reason: a retry must
        // settle the tax the customer was quoted, not whatever the tax
        // state happens to be when they come back. ignoreDuplicates
        // means an existing attempt keeps its original snapshot.
        tax_snapshot: taxSnapshot,
      },
      { onConflict: "request_id", ignoreDuplicates: true }
    );

  if (upsertError) {
    console.error("Checkout attempt upsert error:", upsertError.message);
    return { ok: false, error: "Checkout-Speicherung vorübergehend nicht verfügbar." };
  }

  const { data, error: selectError } = await admin
    .from("checkout_attempts")
    .select(ATTEMPT_COLUMNS)
    .eq("request_id", requestId)
    .single();

  if (selectError || !data) {
    console.error("Checkout attempt lookup error:", selectError?.message);
    return { ok: false, error: "Checkout-Speicherung vorübergehend nicht verfügbar." };
  }

  return { ok: true, attempt: data as CheckoutAttempt };
}

/**
 * Best-effort link of a created Stripe Checkout Session back to its
 * checkout attempt. Retries a few times on transient failure. Callers
 * must still return the valid Stripe session/url to the customer even if
 * this ultimately fails - the webhook falls back to matching by
 * metadata.request_id when stripe_checkout_session_id was never linked.
 */
export async function linkStripeSession(attemptId: string, stripeCheckoutSessionId: string): Promise<boolean> {
  const admin = getSupabaseAdmin();
  if (!admin) return false;

  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const { error } = await admin
      .from("checkout_attempts")
      .update({
        stripe_checkout_session_id: stripeCheckoutSessionId,
        status: "stripe_session_created",
      })
      .eq("id", attemptId);

    if (!error) return true;
    console.error(`Checkout attempt link failed (try ${attempt}/${MAX_ATTEMPTS}):`, error.message);
  }
  return false;
}

/* ── Subscription checkout attempts (Task 29D-D) ─────────────── */

/**
 * A checkout attempt that bills a subscription rather than a cart.
 *
 * Same table, same request_id idempotency, two extra columns from
 * migration 022: user_id, which a subscription always has because the
 * flow is authenticated, and subscription_id, the exact correlation to
 * the local subscription this attempt is starting.
 *
 * Deliberately NOT a second idempotency table. The attempt is already the
 * thing that freezes a priced snapshot before Stripe is contacted, and a
 * subscription needs exactly that.
 */
export type SubscriptionCheckoutAttempt = CheckoutAttempt & {
  user_id: string | null;
  subscription_id: string | null;
  /**
   * The digest of the exact checkout intent this attempt was created for
   * (migration 025). NULL means the attempt came from the one-time
   * payment flow and has no subscription intent, which the subscription
   * flow refuses rather than adopts.
   */
  subscription_request_fingerprint: string | null;
  /**
   * WHICH checkout this is: customer, plan and saved address, with no
   * priced value in it. Compared on every retry, including one that finds
   * an existing subscription - a different customer, plan or address is a
   * different checkout whatever has already been created.
   */
  subscription_intent_fingerprint: string | null;
};

const SUBSCRIPTION_ATTEMPT_COLUMNS =
  `${ATTEMPT_COLUMNS}, user_id, subscription_id, subscription_request_fingerprint, subscription_intent_fingerprint`;

export type SubscriptionAttemptInput = {
  requestId: string;
  userId: string;
  currency: string;
  items: CheckoutAttemptItemSnapshot[];
  shipping: CheckoutAttemptShipping;
  taxSnapshot: CartTaxSnapshot;
  /** Merchandise + shipping, gross. What Stripe must charge per cycle. */
  expectedTotalGrossCents: number;
  /**
   * The digest of this exact intent, from
   * subscriptionRequestFingerprint. Written once with the attempt and
   * compared on every retry, so one request_id can only ever mean one
   * customer, plan, saved address and priced snapshot.
   */
  fingerprint: string;
  /** The identity half, from subscriptionIntentFingerprint. */
  intentFingerprint: string;
};

export type SubscriptionAttemptResult =
  | { ok: true; attempt: SubscriptionCheckoutAttempt }
  | { ok: false; error: string };

/**
 * Gets or creates the checkout attempt for one subscription checkout
 * request.
 *
 * ignoreDuplicates, exactly as the one-time flow: a retry of the same
 * request_id returns the ORIGINAL frozen snapshot rather than overwriting
 * it with a freshly recomputed one. That is what makes a double click
 * safe and what stops a second request from quietly repricing an attempt
 * the customer is already paying against. The unique constraint on
 * request_id is the real race guard, not the select-then-insert order.
 *
 * subscription_id is deliberately not written here. It cannot be: the
 * attempt is the idempotency anchor and therefore has to exist BEFORE the
 * subscription, so that a retry finds the anchor instead of creating a
 * second subscription. Claiming it is a single database operation,
 * claim_pending_subscription_for_attempt from migration 025, which locks
 * this row and decides there. An earlier version read subscription_id
 * here, created a subscription and then linked it; two concurrent
 * requests could both read NULL, and the loser's subscription was left
 * unreferenced. No application-level sequence can close that window, so
 * none is attempted.
 */
export async function getOrCreateSubscriptionCheckoutAttempt(
  input: SubscriptionAttemptInput
): Promise<SubscriptionAttemptResult> {
  const admin = getSupabaseAdmin();
  if (!admin) {
    return { ok: false, error: "Checkout-Speicherung vorübergehend nicht verfügbar." };
  }

  const { error: upsertError } = await admin
    .from("checkout_attempts")
    .upsert(
      {
        request_id: input.requestId,
        user_id: input.userId,
        currency: input.currency,
        expected_total_gross_cents: input.expectedTotalGrossCents,
        items_snapshot: input.items,
        shipping_country: input.shipping.country,
        shipping_zone: input.shipping.zone,
        shipping_gross_cents: input.shipping.grossCents,
        tax_snapshot: input.taxSnapshot,
        subscription_request_fingerprint: input.fingerprint,
        subscription_intent_fingerprint: input.intentFingerprint,
      },
      { onConflict: "request_id", ignoreDuplicates: true }
    );

  if (upsertError) {
    console.error("Subscription checkout attempt upsert error:", upsertError.message);
    return { ok: false, error: "Checkout-Speicherung vorübergehend nicht verfügbar." };
  }

  const { data, error: selectError } = await admin
    .from("checkout_attempts")
    .select(SUBSCRIPTION_ATTEMPT_COLUMNS)
    .eq("request_id", input.requestId)
    .single();

  if (selectError || !data) {
    console.error("Subscription checkout attempt lookup error:", selectError?.message);
    return { ok: false, error: "Checkout-Speicherung vorübergehend nicht verfügbar." };
  }

  return { ok: true, attempt: data as SubscriptionCheckoutAttempt };
}

/** Finds a checkout attempt by the Stripe Checkout Session that backs it. */
export async function findAttemptByStripeSessionId(stripeCheckoutSessionId: string): Promise<CheckoutAttempt | null> {
  const admin = getSupabaseAdmin();
  if (!admin) return null;

  const { data, error } = await admin
    .from("checkout_attempts")
    .select(ATTEMPT_COLUMNS)
    .eq("stripe_checkout_session_id", stripeCheckoutSessionId)
    .maybeSingle();

  if (error) {
    console.error("Checkout attempt lookup by session id error:", error.message);
    return null;
  }
  return (data as CheckoutAttempt | null) ?? null;
}

/**
 * Fallback lookup by request_id, used when a checkout attempt's
 * stripe_checkout_session_id was never successfully linked (e.g. the
 * session-creation request's DB update failed after Stripe had already
 * created the session).
 */
export async function findAttemptByRequestId(requestId: string): Promise<CheckoutAttempt | null> {
  const admin = getSupabaseAdmin();
  if (!admin) return null;

  const { data, error } = await admin
    .from("checkout_attempts")
    .select(ATTEMPT_COLUMNS)
    .eq("request_id", requestId)
    .maybeSingle();

  if (error) {
    console.error("Checkout attempt lookup by request id error:", error.message);
    return null;
  }
  return (data as CheckoutAttempt | null) ?? null;
}

/**
 * Marks a checkout attempt paid after Stripe payment has been verified
 * server-side. Idempotent - setting the same paid state twice (e.g. for a
 * duplicate webhook delivery) is harmless.
 */
export async function markAttemptPaid(attemptId: string, stripePaymentIntentId: string | null): Promise<boolean> {
  const admin = getSupabaseAdmin();
  if (!admin) return false;

  const { error } = await admin
    .from("checkout_attempts")
    .update({
      status: "paid",
      paid_at: new Date().toISOString(),
      stripe_payment_intent_id: stripePaymentIntentId,
    })
    .eq("id", attemptId);

  if (error) {
    console.error("Checkout attempt mark-paid error:", error.message);
    return false;
  }
  return true;
}

/* ── Annual plan payment attempts (Phase 4B3) ────────────────── */

/**
 * The columns the annual checkout verifies a retry against.
 *
 * Wider than the one-time list because the annual flow proves ownership
 * and non-adoption from the row itself rather than from a digest: it
 * needs user_id, and it needs the three link columns that would mean this
 * attempt already belongs to something else.
 */
const ANNUAL_ATTEMPT_COLUMNS =
  `${ATTEMPT_COLUMNS}, user_id, subscription_id, annual_plan_id, annual_delivery_number`;

export type AnnualCheckoutAttempt = CheckoutAttempt & {
  user_id: string | null;
  subscription_id: string | null;
  /**
   * NULL on a payment attempt, always. Migration 039's paired CHECK keeps
   * the payment population and the thirteen delivery attempts disjoint,
   * and the annual PaymentIntent belongs to public.annual_plans alone.
   */
  annual_plan_id: string | null;
  annual_delivery_number: number | null;
};

export type AnnualAttemptInput = {
  requestId: string;
  userId: string;
  currency: string;
  items: CheckoutAttemptItemSnapshot[];
  shipping: CheckoutAttemptShipping;
  taxSnapshot: CartTaxSnapshot;
  /** The WHOLE prepayment: thirteen units plus thirteen shipping charges. */
  expectedTotalGrossCents: number;
};

export type AnnualAttemptResult =
  | { ok: true; attempt: AnnualCheckoutAttempt }
  | { ok: false; error: string };

/**
 * Gets or creates the PAYMENT checkout attempt for one annual checkout
 * request (Phase 4B3).
 *
 * ignoreDuplicates, exactly as the one-time and subscription flows: a
 * retry of the same request_id returns the ORIGINAL frozen snapshot
 * rather than overwriting it with a freshly recomputed one. That is what
 * makes a double click safe and what stops a second request from quietly
 * repricing a thirteen-delivery contract the customer is already looking
 * at. The unique constraint on request_id is the real race guard, not the
 * select-then-insert order.
 *
 * A SEPARATE FUNCTION rather than a reuse of the one-time writer, because
 * the two freeze different things. getOrCreateCheckoutAttempt derives its
 * expected total from a CheckoutQuote's catalog subtotal plus one
 * shipping charge; an annual purchase is thirteen discounted units plus
 * thirteen shipping charges, which that quote cannot express. Teaching it
 * to would have changed a live guest-checkout path for a case it does not
 * need to know about. Nothing above this line is modified.
 *
 * annual_plan_id and annual_delivery_number are deliberately NOT written.
 * They cannot be: migration 039 only mints a parent from an attempt that
 * is still in the exact pre-Stripe state, with no annual binding at all,
 * and the parent must exist before Stripe so its id can travel as
 * metadata. The link runs the other way, through
 * annual_plans.payment_checkout_attempt_id.
 *
 * The subscription fingerprint columns are not written either. They
 * belong to migration 025's claim function, which compares them against
 * the subscription flow's own values; an annual attempt leaves them NULL,
 * which that function already refuses outright.
 */
export async function getOrCreateAnnualCheckoutAttempt(
  input: AnnualAttemptInput
): Promise<AnnualAttemptResult> {
  const admin = getSupabaseAdmin();
  if (!admin) {
    return { ok: false, error: "Checkout-Speicherung vorübergehend nicht verfügbar." };
  }

  const { error: upsertError } = await admin
    .from("checkout_attempts")
    .upsert(
      {
        request_id: input.requestId,
        user_id: input.userId,
        currency: input.currency,
        expected_total_gross_cents: input.expectedTotalGrossCents,
        items_snapshot: input.items,
        shipping_country: input.shipping.country,
        shipping_zone: input.shipping.zone,
        shipping_gross_cents: input.shipping.grossCents,
        tax_snapshot: input.taxSnapshot,
      },
      { onConflict: "request_id", ignoreDuplicates: true }
    );

  if (upsertError) {
    console.error("Annual checkout attempt upsert error:", upsertError.message);
    return { ok: false, error: "Checkout-Speicherung vorübergehend nicht verfügbar." };
  }

  const { data, error: selectError } = await admin
    .from("checkout_attempts")
    .select(ANNUAL_ATTEMPT_COLUMNS)
    .eq("request_id", input.requestId)
    .single();

  if (selectError || !data) {
    console.error("Annual checkout attempt lookup error:", selectError?.message);
    return { ok: false, error: "Checkout-Speicherung vorübergehend nicht verfügbar." };
  }

  return { ok: true, attempt: data as AnnualCheckoutAttempt };
}
