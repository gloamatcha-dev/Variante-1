import type Stripe from "stripe";
import { getSupabaseAdmin } from "./supabaseAdmin";
import {
  isCancelResult,
  isCancellableStatus,
  resolveCancellationSchedule,
  subscriptionCancelIdempotencyKey,
  toStripeTimestamp,
  type CancelResult,
  type CancellationSchedule,
} from "./subscriptionCancellationRules";

/**
 * Schedules the end of one B2C subscription (Phase 3C).
 *
 * ══════════════════════════════════════════════════════════════
 * IT SCHEDULES. IT DOES NOT CANCEL.
 * ══════════════════════════════════════════════════════════════
 *
 * Nothing here terminates a subscription, and nothing here writes
 * status = 'cancelled'. It sets an absolute cancel_at at Stripe and
 * records that same instant locally. The subscription stays ACTIVE - it
 * still bills in the late case, it still ships, and the customer is still
 * owed what they are paying for. status becomes 'cancelled' at exactly
 * one moment: when Stripe reports the subscription genuinely ended,
 * through customer.subscription.deleted.
 *
 * It creates no refund, no order, no shipment and no email, and it calls
 * no Stripe API other than the two on the subscription itself.
 *
 * ══════════════════════════════════════════════════════════════
 * WHY cancel_at AND NOT cancel_at_period_end
 * ══════════════════════════════════════════════════════════════
 *
 * cancel_at_period_end cannot express the late case. It always ends at
 * the CURRENT period end, and a request inside the 14-day cutoff must
 * honour one further paid cycle. An absolute timestamp expresses both
 * branches with one field and Stripe enforces it - no cron, no scheduler,
 * no drift.
 *
 * proration_behavior is pinned to "none". Stripe's own documentation on
 * cancel_at warns that a date inside a future period "will always cause a
 * proration for that period". Our late date lands exactly on a period
 * boundary so a proration should not arise, but "should not" is not a
 * guarantee, and an unexpected credit line on a customer's invoice is not
 * an acceptable way to find out.
 *
 * ══════════════════════════════════════════════════════════════
 * ORDERING: STRIPE FIRST, THEN THE DATABASE
 * ══════════════════════════════════════════════════════════════
 *
 * A cancellation is only real once Stripe has accepted it. Persisting
 * first would mean an account page that says "ends on the 4th" for a
 * subscription that will happily bill forever. So the local write only
 * ever follows a Stripe success, and a Stripe failure returns an error
 * with nothing persisted - the customer sees no false confirmation.
 *
 * THE OPPOSITE WINDOW - Stripe succeeds, the local write fails - is
 * handled in three independent ways, because it is the one that can
 * actually mislead:
 *
 *   1. RECONCILE-BEFORE-WRITE. The subscription is retrieved from Stripe
 *      first. If it ALREADY carries a future cancel_at, that value is
 *      adopted verbatim instead of computing a new one. A retry therefore
 *      re-persists the original decision rather than deriving a fresh one
 *      from a period that may since have rolled - which, on the late
 *      path, would otherwise extend the subscription by another cycle
 *      every time someone pressed the button again.
 *   2. THE STRIPE IDEMPOTENCY KEY carries the effective date, so the same
 *      decision produces the same key and Stripe returns the original
 *      result rather than writing twice.
 *   3. THE customer.subscription.updated WEBHOOK. Stripe emits it for the
 *      very change this function makes, and the handler reconciles
 *      cancel_at into the local row. The record self-heals with no retry
 *      and no customer action at all.
 *
 * ══════════════════════════════════════════════════════════════
 * IT IS NOT GATED BY B2C_SUBSCRIPTIONS_ENABLED
 * ══════════════════════════════════════════════════════════════
 *
 * Deliberately, and this is the one place in the codebase where that flag
 * is intentionally absent. The flag gates PURCHASE. If bookings are
 * switched off while subscriptions exist, those customers must still be
 * able to end a contract they are paying for. Gating cancellation behind
 * the purchase flag would trap them, which is both wrong and, for a paid
 * recurring contract in Germany, the opposite of what the law expects.
 */

/** The columns one cancellation decision is made from. */
const SUBSCRIPTION_COLUMNS =
  "id, user_id, customer_type, status, stripe_subscription_id, current_period_end, " +
  "cancellation_requested_at, cancel_at";

type SubscriptionRow = {
  id: string;
  user_id: string | null;
  customer_type: string;
  status: string;
  stripe_subscription_id: string | null;
  current_period_end: string | null;
  cancellation_requested_at: string | null;
  cancel_at: string | null;
};

export type CancelSubscriptionOutcome =
  | { ok: true; result: CancelResult; schedule: CancellationSchedule }
  | { ok: false; result: CancelResult }
  | { ok: false; result: "error" };

export type CancelSubscriptionDeps = {
  getStripe: () => Stripe | null;
  now: () => Date;
};

/**
 * Schedules the cancellation of one subscription for one authenticated
 * user.
 *
 * Takes a subscription id and a verified user id, and nothing else. The
 * Stripe subscription id, the next billing timestamp, the cutoff and the
 * effective date are all derived server-side from durable rows; none of
 * them can be supplied by the caller, because no parameter for them
 * exists.
 */
export async function cancelSubscriptionForUser(
  subscriptionId: string,
  userId: string,
  deps: CancelSubscriptionDeps
): Promise<CancelSubscriptionOutcome> {
  const admin = getSupabaseAdmin();
  if (!admin) {
    console.error("Subscription cancellation: SUPABASE_SECRET_KEY is not configured.");
    return { ok: false, result: "error" };
  }

  // Ownership is checked here AND again inside the RPC, which matches on
  // id AND user_id under a row lock. Two independent refusals, so no
  // single mistake can end somebody else's subscription.
  const { data, error } = await admin
    .from("subscriptions")
    .select(SUBSCRIPTION_COLUMNS)
    .eq("id", subscriptionId)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    console.error(`Subscription cancellation: load failed for ${subscriptionId}:`, error.message);
    return { ok: false, result: "error" };
  }
  // A foreign subscription and a missing one answer identically, so this
  // cannot be used to discover which subscription ids exist.
  if (!data) return { ok: false, result: "not_found" };

  const subscription = data as unknown as SubscriptionRow;

  // B2C only. B2B supply agreements are a different system with a
  // different contract and must never end through this route.
  if (subscription.customer_type !== "private") return { ok: false, result: "not_found" };

  if (!isCancellableStatus(subscription.status)) return { ok: false, result: "not_eligible" };
  if (!subscription.stripe_subscription_id) return { ok: false, result: "not_eligible" };

  const stripe = deps.getStripe();
  if (!stripe) {
    console.error("Subscription cancellation: STRIPE_SECRET_KEY is not configured.");
    return { ok: false, result: "error" };
  }

  let stripeSubscription: Stripe.Subscription;
  try {
    stripeSubscription = await stripe.subscriptions.retrieve(subscription.stripe_subscription_id);
  } catch (err) {
    console.error(
      `Subscription cancellation: stripe retrieve failed for ${subscription.id}:`,
      err instanceof Error ? err.message : "unknown error"
    );
    return { ok: false, result: "error" };
  }

  const requestAt = deps.now();

  // ── RECONCILE BEFORE COMPUTING ──────────────────────────────
  //
  // If Stripe already carries a future cancel_at, that decision stands
  // and is adopted verbatim. This is what makes a retry safe after the
  // local write failed: the original end date is re-persisted rather than
  // a fresh one derived from a period that may have rolled since.
  //
  // The schedule is rebuilt around the EXISTING date so the response
  // still carries a truthful cutoff and timing, derived from the same
  // durable current_period_end - nothing is invented to fill the shape.
  const existingCancelAt =
    typeof stripeSubscription.cancel_at === "number" && stripeSubscription.cancel_at > 0
      ? new Date(stripeSubscription.cancel_at * 1000).toISOString()
      : null;

  const computed = resolveCancellationSchedule({
    requestAt,
    currentPeriodEnd: subscription.current_period_end,
  });
  if (!computed.ok) {
    console.error(
      `Subscription cancellation: no usable period end for ${subscription.id} (${computed.reason}).`
    );
    return { ok: false, result: "not_eligible" };
  }

  const schedule: CancellationSchedule = existingCancelAt
    ? { ...computed.schedule, effectiveCancelAt: existingCancelAt }
    : computed.schedule;

  // Only write to Stripe when the value would actually change. An
  // already-scheduled subscription needs no second write, and skipping it
  // means a retry produces no further Stripe events either.
  if (!existingCancelAt) {
    try {
      await stripe.subscriptions.update(
        subscription.stripe_subscription_id,
        {
          cancel_at: toStripeTimestamp(schedule.effectiveCancelAt),
          // See the header: never let a cancellation quietly become a
          // credit or a charge.
          proration_behavior: "none",
        },
        {
          idempotencyKey: subscriptionCancelIdempotencyKey(
            subscription.id,
            schedule.effectiveCancelAt
          ),
        }
      );
    } catch (err) {
      // Nothing is persisted. The customer sees an error, not a
      // cancellation that does not exist at Stripe.
      console.error(
        `Subscription cancellation: stripe update failed for ${subscription.id}:`,
        err instanceof Error ? err.message : "unknown error"
      );
      return { ok: false, result: "error" };
    }
  }

  // ── ONLY NOW THE DATABASE ───────────────────────────────────
  //
  // Every terminal-state rule, the row lock, the ownership re-check, the
  // idempotent repeat, the conflict refusal and the two-column write live
  // inside the RPC, in one transaction. This module performs no table
  // write of its own and could not: service_role holds SELECT and nothing
  // else on public.subscriptions.
  const { data: rpcData, error: rpcError } = await admin.rpc("schedule_subscription_cancellation", {
    p_subscription_id: subscription.id,
    p_user_id: userId,
    p_requested_at: requestAt.toISOString(),
    p_cancel_at: schedule.effectiveCancelAt,
  });

  if (rpcError) {
    // Stripe already holds the schedule. The webhook reconciliation will
    // bring the local row into line, and a retry is safe.
    console.error(
      `Subscription cancellation: RPC failed for ${subscription.id}:`,
      rpcError.message
    );
    return { ok: false, result: "error" };
  }

  const payload = (rpcData ?? {}) as { result?: unknown };
  if (!isCancelResult(payload.result)) {
    console.error(`Subscription cancellation: unexpected RPC result for ${subscription.id}.`);
    return { ok: false, result: "error" };
  }

  const result = payload.result;
  if (result === "scheduled" || result === "already_scheduled") {
    return { ok: true, result, schedule };
  }
  return { ok: false, result };
}

/* ══════════════════════════════════════════════════════════════
   WEBHOOK RECONCILIATION
   ══════════════════════════════════════════════════════════════ */

/**
 * Reads the period and cancellation facts off a Stripe subscription.
 *
 * The period lives on the first subscription ITEM in the current API
 * shape, which is exactly where lib/subscriptionInvoiceRules.ts already
 * reads it from - the two agree deliberately rather than by accident.
 */
export function stripeSubscriptionFacts(subscription: Stripe.Subscription): {
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  cancelAt: string | null;
} {
  const item = subscription.items?.data?.[0];
  const toIso = (seconds: number | null | undefined): string | null =>
    typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0
      ? new Date(seconds * 1000).toISOString()
      : null;

  return {
    currentPeriodStart: toIso(item?.current_period_start),
    currentPeriodEnd: toIso(item?.current_period_end),
    cancelAt: toIso(subscription.cancel_at),
  };
}

/**
 * Reconciles scheduling facts from customer.subscription.updated.
 *
 * DELIBERATELY NARROW. Four facts: the two period timestamps and
 * cancel_at, plus clearing a stale local request when Stripe reports no
 * cancellation at all. The RPC refuses to write anything else - never
 * status, never money, never a snapshot - so an arbitrary Stripe update
 * cannot rewrite GLOA business state.
 *
 * Never throws. A subscription this system did not create answers
 * 'not_found' and is ignored, which is the normal case for any Stripe
 * account that also holds other subscriptions.
 *
 * THE CALLER MUST PASS A FRESHLY RETRIEVED SUBSCRIPTION, never the object
 * embedded in a webhook event. That object is a snapshot from when the
 * event was generated, and webhook delivery is asynchronous: syncing from
 * a delayed one would regress the period timestamps and cancel_at to a
 * state that is already several changes old. The webhook handler
 * re-reads for exactly this reason.
 */
export async function syncSubscriptionFromStripe(
  subscription: Stripe.Subscription
): Promise<string> {
  const admin = getSupabaseAdmin();
  if (!admin) {
    console.error("Subscription sync: SUPABASE_SECRET_KEY is not configured.");
    return "error";
  }

  const facts = stripeSubscriptionFacts(subscription);

  const { data, error } = await admin.rpc("sync_subscription_from_stripe", {
    p_stripe_subscription_id: subscription.id,
    p_current_period_start: facts.currentPeriodStart,
    p_current_period_end: facts.currentPeriodEnd,
    p_cancel_at: facts.cancelAt,
  });

  if (error) {
    // Stripe subscription id only. Never a customer fact.
    console.error(`Subscription sync: RPC failed for ${subscription.id}:`, error.message);
    return "error";
  }

  const payload = (data ?? {}) as { result?: unknown };
  return typeof payload.result === "string" ? payload.result : "unknown";
}

/**
 * Records an actual termination from customer.subscription.deleted.
 *
 * THE ONLY PATH THAT WRITES status = 'cancelled'. It destroys nothing:
 * the local subscription row survives, its snapshots survive, and every
 * durable order from every past cycle is untouched.
 *
 * `ended_at` is Stripe's own authoritative termination timestamp; the RPC
 * falls back to now() when it is absent, and refuses to move an existing
 * cancelled_at on a redelivered event.
 */
export async function markSubscriptionCancelledFromStripe(
  subscription: Stripe.Subscription
): Promise<string> {
  const admin = getSupabaseAdmin();
  if (!admin) {
    console.error("Subscription termination: SUPABASE_SECRET_KEY is not configured.");
    return "error";
  }

  const endedAt =
    typeof subscription.ended_at === "number" && subscription.ended_at > 0
      ? new Date(subscription.ended_at * 1000).toISOString()
      : null;

  const { data, error } = await admin.rpc("mark_subscription_cancelled", {
    p_stripe_subscription_id: subscription.id,
    p_cancelled_at: endedAt,
  });

  if (error) {
    console.error(`Subscription termination: RPC failed for ${subscription.id}:`, error.message);
    return "error";
  }

  const payload = (data ?? {}) as { result?: unknown };
  return typeof payload.result === "string" ? payload.result : "unknown";
}
