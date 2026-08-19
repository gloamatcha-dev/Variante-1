import { getSupabaseAdmin } from "./supabaseAdmin";

export type RecordEventResult =
  | { ok: true; duplicate: false }
  | { ok: true; duplicate: true }
  | { ok: false };

/**
 * Fast-path check for a sequential redelivery of an already-fully-handled
 * event, so it can be skipped without redoing the Stripe retrieve + DB
 * update. Returns null if the admin client is unavailable.
 *
 * This is a "select then insert" only as an optimization, not as the
 * correctness guard: recordStripeWebhookEvent() is called AFTER
 * processing succeeds (not before), so a small race window where two
 * concurrent deliveries both pass this check and both process is
 * harmless - checkout attempt fulfillment is idempotent - and the
 * stripe_event_id primary key still prevents two dedup rows for the same
 * event. Recording only after success also means a transient processing
 * failure never permanently blocks Stripe's own webhook retry.
 */
export async function hasStripeWebhookEventBeenProcessed(stripeEventId: string): Promise<boolean | null> {
  const admin = getSupabaseAdmin();
  if (!admin) return null;

  const { data, error } = await admin
    .from("stripe_webhook_events")
    .select("stripe_event_id")
    .eq("stripe_event_id", stripeEventId)
    .maybeSingle();

  if (error) {
    console.error("Stripe webhook event lookup error:", error.message);
    return null;
  }
  return data !== null;
}

/**
 * Records a verified, fully-processed Stripe event id. Call this only
 * after the event's effects have been applied. A unique_violation here
 * (duplicate: true) means a concurrent delivery recorded it first, which
 * is fine given idempotent processing.
 */
export async function recordStripeWebhookEvent(
  stripeEventId: string,
  eventType: string,
  checkoutSessionId: string | null
): Promise<RecordEventResult> {
  const admin = getSupabaseAdmin();
  if (!admin) return { ok: false };

  const { error } = await admin.from("stripe_webhook_events").insert({
    stripe_event_id: stripeEventId,
    event_type: eventType,
    checkout_session_id: checkoutSessionId,
  });

  if (!error) return { ok: true, duplicate: false };

  // Postgres unique_violation on the stripe_event_id primary key.
  if (error.code === "23505") return { ok: true, duplicate: true };

  console.error("Stripe webhook event record error:", error.message);
  return { ok: false };
}
