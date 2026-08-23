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

/**
 * The tax result frozen onto a checkout attempt (Task 21D).
 *
 * snapshot is null when this destination's VAT is genuinely not
 * implemented (UK, Switzerland, Norway, third countries) - unknown, not
 * zero. thresholdRelevantNetCents is known either way: an export is not
 * an intra-EU distance sale, so it contributes a real 0 to the
 * § 3c Abs. 4 allowance rather than an unknown.
 */
export type CheckoutAttemptTax = {
  snapshot: CartTaxSnapshot | null;
  thresholdRelevantNetCents: number;
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
  tax_snapshot: CartTaxSnapshot | null;
  threshold_relevant_net_cents: number | null;
  threshold_reserved_at: string | null;
  stripe_checkout_session_id: string | null;
  stripe_payment_intent_id: string | null;
};

const ATTEMPT_COLUMNS =
  "id, request_id, status, currency, expected_total_gross_cents, items_snapshot, shipping_country, shipping_zone, shipping_gross_cents, tax_snapshot, threshold_relevant_net_cents, threshold_reserved_at, stripe_checkout_session_id, stripe_payment_intent_id";

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
  tax: CheckoutAttemptTax,
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
        tax_snapshot: tax.snapshot,
        threshold_relevant_net_cents: tax.thresholdRelevantNetCents,
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
