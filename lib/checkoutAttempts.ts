import { getSupabaseAdmin } from "./supabaseAdmin";
import type { CheckoutQuote } from "./checkoutQuote";
import { buildItemsSnapshot, type CheckoutAttemptItemSnapshot } from "./checkoutAttemptSnapshot";

export type { CheckoutAttemptItemSnapshot };
export { buildItemsSnapshot };

export type CheckoutAttemptStatus = "created" | "stripe_session_created" | "paid" | "failed" | "expired";

export type CheckoutAttempt = {
  id: string;
  request_id: string;
  status: CheckoutAttemptStatus;
  currency: string;
  expected_total_gross_cents: number;
  items_snapshot: CheckoutAttemptItemSnapshot[];
  stripe_checkout_session_id: string | null;
  stripe_payment_intent_id: string | null;
};

const ATTEMPT_COLUMNS =
  "id, request_id, status, currency, expected_total_gross_cents, items_snapshot, stripe_checkout_session_id, stripe_payment_intent_id";

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
  quote: CheckoutQuote
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
        currency: quote.currency,
        expected_total_gross_cents: quote.subtotalGrossCents,
        items_snapshot: buildItemsSnapshot(quote),
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
