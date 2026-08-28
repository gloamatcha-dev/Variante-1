import type Stripe from "stripe";
import { getSupabaseAdmin } from "./supabaseAdmin";
// Phase 3H.3. Every writer of the cancellation pair lives in this module,
// so the confirmation is wired here once rather than at each of the four
// call sites - the Stripe webhook route and the cron route both stay
// unchanged and neither needs to know this email exists.
import { sendCancellationConfirmationEmailIfNeeded } from "./cancellationConfirmationEmail";
import {
  DEFERRED_SWEEP_LIMIT,
  deferredCancelIdempotencyKey,
  deferredCancellationIsDue,
  deferredCancellationIsPaid,
  isCancelResult,
  isCancellableStatus,
  isDeferredApplyResult,
  resolveCancellationSchedule,
  schedulesAtStripeNow,
  subscriptionCancelIdempotencyKey,
  toStripeTimestamp,
  type CancelResult,
  type CancellationSchedule,
  type DeferredApplyResult,
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
  "cancellation_requested_at, cancellation_effective_at, cancel_at";

type SubscriptionRow = {
  id: string;
  user_id: string | null;
  customer_type: string;
  status: string;
  stripe_subscription_id: string | null;
  current_period_end: string | null;
  cancellation_requested_at: string | null;
  cancellation_effective_at: string | null;
  cancel_at: string | null;
  /**
   * The end of the latest subscription period GLOA has durable proof was
   * PAID. Deliberately not part of SUBSCRIPTION_COLUMNS: a cancellation
   * REQUEST is decided from the cutoff and never from a payment, so the
   * request path must not read this. Only the deferred-apply path and
   * the sweep do.
   */
  last_paid_period_end: string | null;
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

  // ── WHAT REACHES STRIPE NOW ─────────────────────────────────
  //
  // EARLY: the cancellation goes to Stripe immediately. The date is the
  // CURRENT period end, which prorates nothing.
  //
  // LATE: NOTHING goes to Stripe. See the module header - a cancel_at in
  // a future period ALWAYS prorates, whatever proration_behavior says,
  // and a prorated renewal would fail GLOA's own fulfillment check for a
  // cycle the customer had already paid for. The decision is stored
  // instead and applied by applyDeferredCancellationFromRenewal below
  // when that cycle is genuinely paid.
  //
  // An existingCancelAt overrides the timing entirely: if Stripe already
  // holds a cancellation, it holds it now, and there is nothing to defer.
  const deliverNow = Boolean(existingCancelAt) || schedulesAtStripeNow(schedule.timing);

  // Only write to Stripe when the value would actually change. An
  // already-scheduled subscription needs no second write, and skipping it
  // means a retry produces no further Stripe events either.
  if (deliverNow && !existingCancelAt) {
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
  //
  // p_cancel_at carries ONLY what Stripe actually holds. For a deferred
  // late cancellation that is null, and the row honestly says so rather
  // than claiming a Stripe schedule that does not exist.
  const { data: rpcData, error: rpcError } = await admin.rpc("schedule_subscription_cancellation", {
    p_subscription_id: subscription.id,
    p_user_id: userId,
    p_requested_at: requestAt.toISOString(),
    p_effective_at: schedule.effectiveCancelAt,
    p_cancel_at: deliverNow ? schedule.effectiveCancelAt : null,
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
    // ── CONFIRM IT TO THE CUSTOMER (Phase 3H.3) ───────────────
    //
    // BOTH results, deliberately. 'already_scheduled' is not only the
    // idempotent repeat: migration 034's CASE C answers it after writing
    // cancellation_requested_at onto an effective date Stripe already
    // had, which is a genuinely NEW persisted pair and therefore a new
    // customer-facing fact. Gating on 'scheduled' alone would silently
    // drop that customer's confirmation.
    //
    // The repeat case costs nothing: an unchanged pair produces the same
    // event key, the claim conflicts, and nothing is sent.
    //
    // IT IS PASSED THE SUBSCRIPTION ID AND NOTHING ELSE. `schedule` above
    // is what THIS request calculated before the RPC ran, and the RPC has
    // four outcomes that write different things - so the sender re-reads
    // the row and derives its event key from what actually landed.
    //
    // AND IT CANNOT FAIL THIS CANCELLATION. The cancellation is already
    // durable, locally and at Stripe. The sender never throws and its
    // result is deliberately not consulted: a mail provider having a bad
    // day must not turn the customer's successful cancellation into an
    // error in the response they are waiting on.
    await sendCancellationConfirmationEmailIfNeeded(subscription.id);
    return { ok: true, result, schedule };
  }
  return { ok: false, result };
}

/* ══════════════════════════════════════════════════════════════
   THE DEFERRED LATE BRANCH (Phase 3C.2)
   ══════════════════════════════════════════════════════════════ */

/**
 * Applies a late cancellation once its one further cycle has been paid.
 *
 * Driven by invoice.paid, strictly AFTER fulfillPaidSubscriptionInvoice
 * has advanced current_period_end, created the order for the cycle that
 * was just paid and RECORDED THE PAID PERIOD. By then the promised end
 * date IS the end of the current period, so setting cancel_at prorates
 * nothing - which is the entire reason the late branch defers.
 *
 * ══════════════════════════════════════════════════════════════
 * EXACTLY ONE FURTHER CYCLE, WITHOUT A COUNTER
 * ══════════════════════════════════════════════════════════════
 *
 *   1. THE DECISION IS CONSUMED. It applies only while the local
 *      cancel_at is still NULL, and applying it sets cancel_at. Every
 *      later delivery of the same event and every later renewal finds a
 *      non-NULL cancel_at, answers 'already_scheduled', writes nothing
 *      and calls no Stripe API.
 *   2. IT WILL NOT FIRE EARLY. A redelivered invoice.paid for the cycle
 *      the customer was still in carries an earlier period end than the
 *      promise, and is refused - so a redelivery inside Stripe's retry
 *      window cannot rob them of the cycle they are owed.
 *   3. IT WILL NOT FIRE UNPAID. Reaching the promised date is a fact
 *      about current_period_end, and customer.subscription.updated
 *      writes that column too - a card update, a Dashboard edit, a move
 *      into past_due. It is a mirror of Stripe, not a receipt. So the
 *      payment is required separately, from last_paid_period_end, which
 *      only a paid subscription invoice can advance. Without this, a
 *      failed renewal whose period moved anyway would end the
 *      subscription a cycle EARLY, taking a cycle the customer never
 *      received.
 *
 * All three guards are enforced again inside the RPC under a row lock;
 * the checks here exist only to avoid a pointless Stripe call.
 *
 * ══════════════════════════════════════════════════════════════
 * IT REPORTS FAILURE. IT NEVER SWALLOWS IT. (Phase 3C.3)
 * ══════════════════════════════════════════════════════════════
 *
 * This function itself does not throw - every outcome is a returned
 * value, so the caller decides. But "the next renewal will apply it" is
 * NOT an acceptable recovery story and is no longer claimed anywhere:
 * the next renewal is 28 days away and it charges the customer again, so
 * a transient failure here would turn "exactly one further cycle" into
 * two at the customer's expense.
 *
 * TWO INDEPENDENT RECOVERY PATHS, neither of which needs another paid
 * invoice:
 *
 *   1. THE WEBHOOK RETRIES. handleInvoicePaid treats 'error' as fatal and
 *      throws, so the event is never recorded as processed and Stripe
 *      redelivers it - for up to three days, with backoff. Everything
 *      ahead of this call is idempotent, so a redelivery re-attempts the
 *      cancellation and nothing else: the same order, the same email
 *      claim, no second charge.
 *   2. THE DAILY SWEEP. sweepDueDeferredCancellations below finds every
 *      cancellation whose owed cycle is already paid and which Stripe
 *      still does not hold, and re-attempts it. That is the net for the
 *      case where Stripe stops redelivering before the problem is fixed.
 *
 * ══════════════════════════════════════════════════════════════
 * A FAILED RENEWAL NEEDS NO POLICY OF ITS OWN
 * ══════════════════════════════════════════════════════════════
 *
 * If the one permitted invoice fails there is no invoice.paid, so
 * last_paid_period_end does not move, nothing is applied and the request
 * stays pending - truthfully, because Stripe holds nothing. That holds
 * WHATEVER Stripe did to the period in the meantime, which is the point
 * of proving the payment separately rather than reading it off
 * current_period_end. Stripe's own dunning then decides: if a retry
 * succeeds,
 * that renewal applies the cancellation and the customer gets exactly the
 * cycle they paid for; if dunning is exhausted and Stripe cancels the
 * subscription, customer.subscription.deleted marks it cancelled and the
 * customer never received a cycle they did not pay for. The cancellation
 * cannot be lost either way, so no new business rule was invented here.
 */
export async function applyDeferredCancellationFromRenewal(
  stripe: Stripe,
  stripeSubscriptionId: string,
  deps?: { getAdmin?: typeof getSupabaseAdmin }
): Promise<DeferredApplyResult | "error"> {
  const admin = (deps?.getAdmin ?? getSupabaseAdmin)();
  if (!admin) {
    console.error("Deferred cancellation: SUPABASE_SECRET_KEY is not configured.");
    return "error";
  }

  const { data, error } = await admin
    .from("subscriptions")
    .select(
      "id, cancellation_requested_at, cancellation_effective_at, cancel_at, " +
      "current_period_end, last_paid_period_end"
    )
    .eq("stripe_subscription_id", stripeSubscriptionId)
    .maybeSingle();

  if (error) {
    console.error(`Deferred cancellation: load failed for ${stripeSubscriptionId}:`, error.message);
    return "error";
  }
  if (!data) return "not_found";

  const row = data as unknown as Pick<
    SubscriptionRow,
    "id" | "cancellation_requested_at" | "cancellation_effective_at" | "cancel_at"
    | "current_period_end" | "last_paid_period_end"
  >;

  // Nothing is owed: no customer ever asked, or Stripe already holds it.
  // An owner-initiated Stripe Dashboard cancellation has no request and
  // must never be re-applied from here.
  if (!row.cancellation_requested_at || !row.cancellation_effective_at) return "nothing_pending";
  if (row.cancel_at) return "already_scheduled";

  // current_period_end was just advanced by the fulfillment ahead of this
  // call, from the subscription it re-read from Stripe. It says the
  // period has REACHED the promised date, which is what makes the
  // cancel_at below a current-period date that prorates nothing.
  if (!deferredCancellationIsDue({
    periodEnd: row.current_period_end,
    promisedAt: row.cancellation_effective_at,
  })) {
    return "too_early";
  }

  // AND IT SAYS NOTHING ABOUT PAYMENT (Phase 3C.5). The same column is
  // written by the customer.subscription.updated reconciliation, which is
  // not a payment event, so the receipt is asked for separately: the
  // fulfillment ahead of this call recorded last_paid_period_end from the
  // invoice it had just seen Stripe report paid. A failed renewal cannot
  // reach the promise here however Stripe moved the period.
  //
  // 'too_early' is the honest answer: the cycle the customer is owed has
  // not been delivered yet, and the failure direction is the safe one -
  // they keep the subscription rather than lose a cycle they paid for.
  if (!deferredCancellationIsPaid({
    paidPeriodEnd: row.last_paid_period_end,
    promisedAt: row.cancellation_effective_at,
  })) {
    return "too_early";
  }

  const effectiveCancelAt = row.current_period_end as string;

  // ── STRIPE FIRST, THEN THE DATABASE ─────────────────────────
  // The same discipline as the request path: the local row may only
  // record a cancellation Stripe has actually accepted.
  try {
    await stripe.subscriptions.update(
      stripeSubscriptionId,
      {
        cancel_at: toStripeTimestamp(effectiveCancelAt),
        // A current-period date, so this is belt and braces rather than
        // load-bearing - but a cancellation must never become a credit.
        proration_behavior: "none",
      },
      { idempotencyKey: deferredCancelIdempotencyKey(row.id, effectiveCancelAt) }
    );
  } catch (err) {
    console.error(
      `Deferred cancellation: stripe update failed for ${row.id}:`,
      err instanceof Error ? err.message : "unknown error"
    );
    return "error";
  }

  const { data: rpcData, error: rpcError } = await admin.rpc(
    "apply_deferred_subscription_cancellation",
    { p_stripe_subscription_id: stripeSubscriptionId, p_cancel_at: effectiveCancelAt }
  );

  if (rpcError) {
    // Stripe holds the cancellation. customer.subscription.updated for
    // that very change reconciles cancel_at into the row moments later,
    // so this self-heals with no retry and no customer action.
    console.error(`Deferred cancellation: RPC failed for ${row.id}:`, rpcError.message);
    return "error";
  }

  const payload = (rpcData ?? {}) as { result?: unknown };
  const applied = isDeferredApplyResult(payload.result) ? payload.result : "error";

  // ── THE END DATE MAY HAVE MOVED (Phase 3H.3) ────────────────
  //
  // apply_deferred_subscription_cancellation writes
  // cancellation_effective_at = p_cancel_at. For a late cancellation that
  // is the period end of the cycle that has just been paid, which can be
  // LATER than the date the customer was told when they cancelled. That
  // is a new persisted pair, a new event key and a genuinely new customer
  // fact: they are entitled to the corrected date.
  //
  // BOTH CALLERS ARE COVERED BY THIS ONE LINE. The invoice.paid webhook
  // and sweepDueDeferredCancellations below both reach the RPC through
  // this function, so neither the Stripe webhook route nor the cron route
  // needs to know this email exists.
  //
  // Only on 'applied'. Every other result wrote nothing, so there is no
  // new fact - and the sender would refuse anyway, because an unchanged
  // pair yields the same event key and loses the claim.
  if (applied === "applied") {
    // Never allowed to fail the cancellation that just succeeded.
    await sendCancellationConfirmationEmailIfNeeded(row.id);
  }

  return applied;
}

export type DeferredSweepSummary = {
  /** Rows that are genuinely owed a Stripe cancellation right now. */
  due: number;
  applied: number;
  /** Stripe already held it; the row was repaired or was already right. */
  alreadyScheduled: number;
  failed: number;
  /** True when the work list itself could not be read. */
  errored: boolean;
};

/**
 * The safety net under the webhook retry (Phase 3C.3).
 *
 * ══════════════════════════════════════════════════════════════
 * THE WINDOW IT CLOSES, CONCRETELY
 * ══════════════════════════════════════════════════════════════
 *
 * handleInvoicePaid throws when the deferred cancellation cannot be
 * applied, so Stripe redelivers the event. That is the fast path and it
 * handles essentially every transient failure - but Stripe stops
 * redelivering after about three days. If the problem outlives that
 * budget, the cancellation would sit unapplied until the NEXT renewal,
 * which is 28 days away and charges the customer a second extra cycle.
 *
 * This sweep is what makes that impossible. It needs no invoice, no
 * event and no customer action: it re-derives due-ness from durable local
 * state alone, so recovery is bounded by the cron schedule rather than by
 * Stripe's retry budget or by the billing cadence.
 *
 * ══════════════════════════════════════════════════════════════
 * WHAT "DUE" MEANS, AND WHY IT CANNOT TOUCH HISTORY
 * ══════════════════════════════════════════════════════════════
 *
 * Five conditions, all durable, all required:
 *
 *   1. cancellation_requested_at IS NOT NULL - an authenticated customer
 *      actually asked. This alone excludes every historical subscription
 *      and every Stripe Dashboard cancellation.
 *   2. cancel_at IS NULL - Stripe does not hold it yet.
 *   3. current_period_end >= cancellation_effective_at - Stripe's period
 *      has REACHED the promised end date, which is what makes the
 *      cancel_at this sweep goes on to send a CURRENT-period date and so
 *      prorate nothing.
 *   4. last_paid_period_end >= cancellation_effective_at - AND THAT
 *      PERIOD WAS PAID FOR.
 *   5. a live B2C subscription with a Stripe binding.
 *
 * ══════════════════════════════════════════════════════════════
 * WHY 3 IS NOT 4, AND WHY BOTH ARE REQUIRED
 * ══════════════════════════════════════════════════════════════
 *
 * Condition 3 used to be described here as the paid-cycle proof, on the
 * grounds that only activate_subscription_from_invoice advances the
 * period. THAT WAS WRONG. sync_subscription_from_stripe - in the same
 * migration - writes current_period_end from
 * customer.subscription.updated, which is not a payment event: it fires
 * for a card update, a Dashboard edit, a move into past_due, anything.
 * The column is a MIRROR OF STRIPE, and a mirror is not a receipt.
 *
 * The fix is not to assume Stripe leaves the period alone when a payment
 * fails; that is Stripe's behaviour to change, not GLOA's invariant to
 * lean on. If a renewal failed and the period moved anyway, condition 3
 * alone would have ended the subscription a cycle EARLY - taking a cycle
 * the customer had not received. So the sweep also requires payment
 * evidence the database wrote itself, in its own column.
 *
 * last_paid_period_end has exactly ONE writer,
 * record_paid_subscription_period, which refuses to write unless a PAID
 * checkout attempt for that exact Stripe invoice already exists on that
 * exact subscription - and that attempt in turn has one writer,
 * activate_subscription_from_invoice (022), driven by invoice.paid after
 * the invoice total matched the frozen subscription total. No browser
 * role can execute either function or update either table.
 *
 * ══════════════════════════════════════════════════════════════
 * TWO PERIOD BOUNDARIES, AND NOT ONE CLOCK COMPARISON
 * ══════════════════════════════════════════════════════════════
 *
 * Conditions 3 and 4 both compare a period boundary to a period
 * boundary, and every period boundary here comes from the same place -
 * the Stripe subscription item. Nothing in this sweep compares the
 * Vercel clock to the Postgres clock, and nothing infers a payment from
 * when an event happened to arrive.
 *
 * The subscription's OWN first payment is excluded by arithmetic rather
 * than by timing. A deferred row exists only for a LATE cancellation,
 * whose promise is the current period end PLUS one whole cadence, so
 * every period paid up to the request ends a full cadence short of it.
 * Only the one further renewal the customer is owed can reach it.
 *
 * ══════════════════════════════════════════════════════════════
 * THE BATCH IS BOUNDED, AND A DUE ROW CANNOT STARVE
 * ══════════════════════════════════════════════════════════════
 *
 * The work list comes from due_deferred_subscription_cancellations, a
 * read-only SECURITY DEFINER function in migration 034 that applies ALL
 * of the conditions above - including the two-column comparison - BEFORE
 * its own LIMIT.
 *
 * That ordering is the safety property. This sweep used to select rows
 * with a PostgREST query and decide condition 3 in JavaScript afterwards,
 * because PostgREST can only compare a column to a literal value and
 * never to another column. The bound therefore landed on the wrong side
 * of the decision: with more pending cancellations than the limit, a
 * batch could consist entirely of rows that were not yet due while a
 * genuinely due row was never even read.
 *
 * SORTING WOULD NOT HAVE FIXED IT, so it was not used as the fix. The two
 * dates move independently - cancellation_effective_at is frozen when the
 * customer asks, current_period_end advances only when a renewal is paid
 * - so an earlier promise can still be pending while a later one is
 * already due. Ordered either way, pending rows can crowd out a due one.
 * Filtering server-side removes the possibility rather than reducing it:
 * every row in the batch is due, so the only rows a full batch defers are
 * other DUE rows, which the next run picks up in a deterministic order.
 *
 * THIS IS NOT A NULL-KEYED SWEEP. The absolute rule that email retries
 * may select 'failed' and never NULL exists because a NULL email column
 * means "this feature did not exist when this happened". `cancel_at IS
 * NULL` means nothing of the sort: it is a state this code deliberately
 * writes, it is only ever reached together with a non-NULL customer
 * request, and conditions 3 and 4 additionally require a renewal that
 * was durably paid. The 451 historical subscriptions carry NULL on
 * cancellation_requested_at AND on last_paid_period_end, so each of
 * those conditions alone already puts them out of reach.
 *
 * It performs no local write of its own. Every row goes through
 * applyDeferredCancellationFromRenewal, which re-reads the row and
 * re-checks every condition - including the payment proof - before any
 * Stripe call, and the RPC behind it re-checks them again under a row
 * lock. A row that stopped being due between the query and the attempt
 * is refused there rather than here.
 */
export async function sweepDueDeferredCancellations(
  stripe: Stripe,
  deps?: { getAdmin?: typeof getSupabaseAdmin }
): Promise<DeferredSweepSummary> {
  const summary: DeferredSweepSummary = {
    due: 0, applied: 0, alreadyScheduled: 0, failed: 0, errored: false,
  };

  const admin = (deps?.getAdmin ?? getSupabaseAdmin)();
  if (!admin) {
    console.error("Deferred cancellation sweep: SUPABASE_SECRET_KEY is not configured.");
    summary.errored = true;
    return summary;
  }

  // THE WORK LIST IS SELECTED SERVER-SIDE, AND THAT IS THE WHOLE POINT.
  // Due-ness compares two columns of the same row, which PostgREST cannot
  // express - a filter there compares a column to a value, never to
  // another column. Selecting rows and deciding due-ness here afterwards
  // meant the bound was applied BEFORE the decision, so a batch could
  // fill with rows that are not yet due while a genuinely due row sat
  // outside it. The RPC applies the comparison before its LIMIT, so every
  // row it returns is due and no pending row can crowd one out.
  const { data, error } = await admin.rpc("due_deferred_subscription_cancellations", {
    p_limit: DEFERRED_SWEEP_LIMIT,
  });

  if (error) {
    // A work list this sweep cannot read is reported, never swallowed as
    // a clean run of zero.
    console.error("Deferred cancellation sweep: work list failed:", error.message);
    summary.errored = true;
    return summary;
  }

  const rows = (data ?? []) as unknown as Array<
    Pick<
      SubscriptionRow,
      "id" | "stripe_subscription_id" | "cancellation_effective_at"
      | "current_period_end" | "last_paid_period_end"
    >
  >;

  for (const row of rows) {
    // BOTH conditions, re-checked. The RPC already guaranteed each of
    // them for every row it returned, so neither can skip anything here -
    // they are kept because a due check that lives only in SQL is a due
    // check this loop cannot be read to enforce, and the cost is two
    // comparisons.
    //
    // They are two different facts and they are asked separately on
    // purpose: the first is Stripe's period reaching the promise, the
    // second is proof that period was paid for. Reading only the first
    // is exactly the mistake Phase 3C.5 removed.
    if (!deferredCancellationIsDue({
      periodEnd: row.current_period_end,
      promisedAt: row.cancellation_effective_at,
    })) {
      continue;
    }

    if (!deferredCancellationIsPaid({
      paidPeriodEnd: row.last_paid_period_end,
      promisedAt: row.cancellation_effective_at,
    })) {
      continue;
    }

    summary.due += 1;

    // One failure never stops the rest of the batch.
    let outcome: DeferredApplyResult | "error";
    try {
      outcome = await applyDeferredCancellationFromRenewal(stripe, row.stripe_subscription_id as string);
    } catch (err) {
      console.error(
        `Deferred cancellation sweep: ${row.id} threw:`,
        err instanceof Error ? err.message : "unknown error"
      );
      summary.failed += 1;
      continue;
    }

    if (outcome === "applied") summary.applied += 1;
    else if (outcome === "already_scheduled") summary.alreadyScheduled += 1;
    else {
      // 'too_early' and 'nothing_pending' cannot occur for a row this
      // query selected and the due check passed, so either is as much a
      // problem as 'error' and is counted with it rather than hidden.
      summary.failed += 1;
      console.error(`Deferred cancellation sweep: ${row.id} -> ${outcome}`);
    }
  }

  return summary;
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

  const payload = (data ?? {}) as { result?: unknown; subscription_id?: unknown };
  const result = typeof payload.result === "string" ? payload.result : "unknown";

  // ── STRIPE MOVED THE CANCELLATION (Phase 3H.3) ──────────────
  //
  // sync_subscription_from_stripe is the third writer of the cancellation
  // pair and the only one that can CLEAR it: an unscheduling at Stripe
  // nulls both columns. It can also move cancellation_effective_at to
  // whatever Stripe now reports while cancellation_requested_at stays.
  //
  // Only on 'synced'. 'unchanged' wrote nothing, by the RPC's own
  // column-by-column comparison, so there is no new fact to confirm.
  //
  // The sender decides what the change actually was from the ROW rather
  // than from this result word, and all three cases come out right:
  //
  //   pair cleared    no event key at all -> nothing sent, nothing written
  //   pair moved      a new event key -> a new claim and a new message
  //   pair unmoved    the same event key -> the claim conflicts, silence
  //
  // Superseding a now-stale OLDER delivery row is the retry preflight's
  // job and needs the sweep a later phase will build; this call reaches
  // only the row for the current pair.
  //
  // It never throws, so a reconciliation is never failed by a mail
  // provider - which matters here because this runs inside the Stripe
  // webhook, where a throw becomes a 500 and a redelivery.
  if (result === "synced" && typeof payload.subscription_id === "string") {
    await sendCancellationConfirmationEmailIfNeeded(payload.subscription_id);
  }

  return result;
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
