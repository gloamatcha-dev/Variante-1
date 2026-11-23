import type Stripe from "stripe";

export type SubscriptionPauseStatus = {
  state: "active" | "paused" | "unconfirmed";
  effectiveAt: string | null;
  nextCycleAt: string | null;
};

const unconfirmed: SubscriptionPauseStatus = { state: "unconfirmed", effectiveAt: null, nextCycleAt: null };

function stripeTimestamp(value: unknown) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > 253402300799) return null;
  return new Date(value * 1000).toISOString();
}

export function readSubscriptionPauseStatus(
  subscription: Stripe.Subscription,
  expected: { localId: string; stripeId: string },
  now = Date.now(),
): SubscriptionPauseStatus {
  if (subscription.id !== expected.stripeId || subscription.metadata.gloa_subscription_id !== expected.localId) {
    return unconfirmed;
  }
  if (subscription.status === "paused") {
    // A missing payment method after a trial can also produce this status.
    // The stable API can prove billing is paused, but its effective date
    // cannot be inferred from a period end or from our local order history.
    return { state: "paused", effectiveAt: null, nextCycleAt: null };
  }
  if (subscription.status !== "active" || subscription.pause_collection || subscription.schedule ||
      subscription.cancel_at_period_end || subscription.cancel_at != null || subscription.pending_update ||
      subscription.collection_method !== "charge_automatically" ||
      subscription.items.has_more || subscription.items.data.length === 0) {
    return unconfirmed;
  }
  const latestInvoice = subscription.latest_invoice;
  if (!latestInvoice || typeof latestInvoice === "string" || latestInvoice.status !== "paid") {
    return unconfirmed;
  }
  const items = subscription.items.data;
  const nextCycleAt = stripeTimestamp(items[0].current_period_end);
  if (!nextCycleAt || Date.parse(nextCycleAt) <= now || items.some(item =>
    item.price.recurring?.interval !== "week" || item.price.recurring.interval_count !== 4 ||
    item.current_period_end !== items[0].current_period_end)) {
    return unconfirmed;
  }
  return { state: "active", effectiveAt: null, nextCycleAt };
}
