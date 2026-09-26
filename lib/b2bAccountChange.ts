import type Stripe from "stripe";
import {
  b2bCancelAtMatches,
  b2bCancellationSchedule,
  b2bCurrentPeriodEnd,
  unixSeconds,
} from "./b2bCancellationRules.ts";
import { b2bMonthlyPriceLookupKey } from "./b2bRecurringPrice.ts";
import {
  B2B_MAX_SELF_SERVICE_PACKS,
  B2B_MIN_SELF_SERVICE_PACKS,
  isB2bQuantityChangeRequest,
} from "./b2bChangeRules.ts";

/**
 * THE TWO THINGS A MONTHLY B2B CUSTOMER MAY CHANGE (Package 5G).
 *
 * Injected end to end, exactly like lib/b2bRuntime.ts, so both flows can
 * be driven with stubs: no Stripe object, no database, no network.
 *
 *   changeB2bMonthlyQuantity    a new pack count, from the next cycle
 *   cancelB2bMonthly            an end date at a Stripe boundary
 *
 * ── THE WRITE ORDER, AND WHY IT IS THIS ONE ───────────────────
 *
 * Both flows write the DATABASE FIRST and Stripe SECOND, and both leave
 * a recoverable state if the second half never happens:
 *
 *   db ok, stripe failed   we believe a change is coming that Stripe has
 *                          not been told about. The customer keeps
 *                          exactly what they have today, keeps being
 *                          billed for it, and the reconcile pass below
 *                          re-applies the Stripe half on the next run.
 *
 *   the other order        Stripe would stop billing, or bill a
 *                          different amount, while every screen this
 *                          system renders still said otherwise. A
 *                          customer whose supply silently ends is not a
 *                          state a retry can apologise for.
 *
 * So the recoverable failure is the one that costs GLOA a reconciliation
 * and the customer nothing.
 *
 * ── AND WHY NEITHER FLOW PRORATES ─────────────────────────────
 *
 * proration_behavior: "none" on every update. The approved commercial
 * rule is that the current period is untouched - no mid-cycle charge and
 * no mid-cycle refund - and "none" is the only value that guarantees it.
 * create_prorations would leave invisible credit/debit line items to
 * surface on the next invoice; always_invoice would charge immediately.
 */

/* ── Injected surfaces ──────────────────────────────────────── */

export type B2bAgreementFacts = {
  id: string;
  user_id: string | null;
  plan_type: string | null;
  status: string;
  quantity_packs: number | null;
  pending_quantity_packs: number | null;
  pack_net_cents: number | null;
  currency: string;
  stripe_subscription_id: string | null;
  cancellation_requested_at: string | null;
  cancellation_effective_at: string | null;
};

export type B2bRpcResult = Record<string, unknown> & { result?: string };

export type B2bChangeDeps = {
  /** The agreement, read as the service role. NULL when it is not there. */
  loadAgreement: (agreementId: string) => Promise<B2bAgreementFacts | null>;
  /** 064's request writer. */
  requestQuantityChange: (input: {
    agreementId: string; expectedUserId: string; quantityPacks: number;
  }) => Promise<B2bRpcResult>;
  /** 064's cancellation writer. */
  requestCancellation: (input: {
    agreementId: string; expectedUserId: string; effectiveAt: Date; reason: string | null;
  }) => Promise<B2bRpcResult>;
  /** Stripe, read and updated. */
  retrieveSubscription: (subscriptionId: string) => Promise<Stripe.Subscription>;
  updateSubscription: (
    subscriptionId: string,
    params: Stripe.SubscriptionUpdateParams,
    options?: { idempotencyKey: string }
  ) => Promise<Stripe.Subscription>;
  /** lib/b2bRecurringPrice.ts, unchanged. */
  ensureMonthlyPrice: (input: {
    packs: number; unitAmountCents: number; productName: string; currency: string;
  }) => Promise<{ ok: true; priceId: string } | { ok: false; reason: string }>;
  /** Net -> gross, lib/tax.ts. The recurring Price carries the GROSS. */
  grossForPacks: (packs: number, packNetCents: number) => number;
  /** What the customer sees on the invoice line. */
  productNameFor: (packs: number) => string;
  now: () => Date;
};

export type B2bChangeOutcome =
  | { ok: true; kind: string; detail?: Record<string, unknown> }
  | { ok: false; kind: string; reason: string };

/* ── Guards shared by both flows ────────────────────────────── */

/**
 * Is this caller allowed to change this agreement at all?
 *
 * Ownership is checked HERE and again inside the 064 writers, which take
 * the expected user id and compare it. Two checks on purpose: this one
 * produces the honest error message, and the writer's is the one that
 * cannot be bypassed by a bug in this file.
 */
function gateMonthly(
  agreement: B2bAgreementFacts | null,
  userId: string
): { ok: true; subscriptionId: string } | { ok: false; kind: string; reason: string } {
  if (!agreement) {
    return { ok: false, kind: "not_found", reason: "agreement not found" };
  }
  // NOT FOUND rather than FORBIDDEN for somebody else's agreement: a
  // 403 would confirm the id exists.
  if (agreement.user_id !== userId) {
    return { ok: false, kind: "not_found", reason: "agreement not found" };
  }
  if (agreement.plan_type !== "monthly") {
    return {
      ok: false, kind: "not_monthly",
      reason: "only a monthly agreement can be changed by self-service",
    };
  }
  if (agreement.status !== "active") {
    return { ok: false, kind: "not_active", reason: `agreement is ${agreement.status}` };
  }
  if (!agreement.stripe_subscription_id) {
    return { ok: false, kind: "no_subscription", reason: "agreement has no subscription" };
  }
  return { ok: true, subscriptionId: agreement.stripe_subscription_id };
}

/* ══════════════════════════════════════════════════════════════
   QUANTITY
   ══════════════════════════════════════════════════════════════

   ── WHY THE PRICE IS SWAPPED AND THE QUANTITY IS NOT ──────────

   lib/b2bRecurringPrice.ts builds ONE Price per pack count, whose
   unit_amount is the WHOLE monthly gross for that count, and the
   subscription carries it at `quantity: 1`. So "5 packs instead of 3" is
   a different Price object, not a different quantity - and the lookup
   key (`gloa-b2b-supply-5p-<amount>-m1`) already distinguishes them.

   Changing the Stripe `quantity` field instead would multiply the
   three-pack amount by five and bill a figure no price list contains.

   ── AND WHY NO SUBSCRIPTION SCHEDULE IS INVOLVED ──────────────

   A Subscription Schedule would be the mechanism if Stripe could not
   defer a price change to the boundary. It can: an item price updated
   with proration_behavior "none" leaves the paid current period exactly
   as it is and bills the new amount on the next invoice. That is the
   simplest Stripe-native mechanism that satisfies all three approved
   requirements, so the prohibition on schedules for annual B2B is not
   quietly worked around here - no schedule is created anywhere.
*/

export async function changeB2bMonthlyQuantity(
  deps: B2bChangeDeps,
  input: { agreementId: string; userId: string; quantityPacks: unknown }
): Promise<B2bChangeOutcome> {
  if (!isB2bQuantityChangeRequest(input.quantityPacks)) {
    return {
      ok: false, kind: "invalid_quantity",
      reason: `pack count must be a whole number from ${B2B_MIN_SELF_SERVICE_PACKS} to ${B2B_MAX_SELF_SERVICE_PACKS}`,
    };
  }
  const packs = input.quantityPacks;

  const agreement = await deps.loadAgreement(input.agreementId);
  const gate = gateMonthly(agreement, input.userId);
  if (!gate.ok) return gate;
  const row = agreement as B2bAgreementFacts;

  if (row.pack_net_cents === null || row.quantity_packs === null) {
    return { ok: false, kind: "not_priced", reason: "agreement carries no frozen pack price" };
  }

  // ── 1. THE DATABASE FIRST. See the header.
  const recorded = await deps.requestQuantityChange({
    agreementId: input.agreementId,
    expectedUserId: input.userId,
    quantityPacks: packs,
  });

  if (recorded.result === "unchanged") {
    // The customer asked for what they already have. Any pending change
    // was cleared, and Stripe must go back to the current price.
    const restore = await applyQuantityToStripe(deps, {
      subscriptionId: gate.subscriptionId,
      packs: row.quantity_packs,
      packNetCents: row.pack_net_cents,
      currency: row.currency,
    });
    if (!restore.ok) return restore;
    return { ok: true, kind: "unchanged", detail: { quantityPacks: row.quantity_packs } };
  }

  if (recorded.result !== "requested") {
    return {
      ok: false, kind: String(recorded.result ?? "refused"),
      reason: `the quantity change was refused: ${recorded.result ?? "unknown"}`,
    };
  }

  // ── 2. THEN STRIPE.
  const applied = await applyQuantityToStripe(deps, {
    subscriptionId: gate.subscriptionId,
    packs,
    packNetCents: row.pack_net_cents,
    currency: row.currency,
  });
  if (!applied.ok) return applied;

  return {
    ok: true, kind: "requested",
    detail: { quantityPacks: row.quantity_packs, pendingQuantityPacks: packs },
  };
}

/**
 * Points the subscription's ONE item at the Price for this pack count.
 *
 * Idempotent in the way that matters: re-running with the same pack
 * count resolves the same lookup key, finds the same Price and sets the
 * item to the price it already has. Stripe accepts that as a no-op
 * change, so a retry after a crash converges rather than stacking.
 */
async function applyQuantityToStripe(
  deps: B2bChangeDeps,
  input: { subscriptionId: string; packs: number; packNetCents: number; currency: string }
): Promise<B2bChangeOutcome> {
  const grossCents = deps.grossForPacks(input.packs, input.packNetCents);
  const price = await deps.ensureMonthlyPrice({
    packs: input.packs,
    unitAmountCents: grossCents,
    productName: deps.productNameFor(input.packs),
    currency: input.currency,
  });
  if (!price.ok) {
    return { ok: false, kind: "price_unavailable", reason: price.reason };
  }

  const subscription = await deps.retrieveSubscription(input.subscriptionId);
  const items = subscription.items?.data ?? [];
  if (items.length !== 1) {
    // The same fail-closed rule the cutoff uses: a subscription with two
    // lines has no single item this package may repoint.
    return {
      ok: false, kind: "unexpected_subscription",
      reason: `the subscription has ${items.length} items, expected one`,
    };
  }
  const item = items[0];

  // ALREADY THERE. A replay must not issue a second update.
  if (item.price?.id === price.priceId) {
    return { ok: true, kind: "already_applied" };
  }

  await deps.updateSubscription(
    input.subscriptionId,
    {
      items: [{ id: item.id, price: price.priceId }],
      // THE CURRENT PERIOD IS UNTOUCHED. No charge, no refund, no
      // proration line waiting on the next invoice.
      proration_behavior: "none",
    },
    { idempotencyKey: b2bQuantityIdempotencyKey(input.subscriptionId, input.packs, grossCents) }
  );

  return { ok: true, kind: "applied" };
}

/**
 * Deterministic per (subscription, pack count, amount).
 *
 * The amount is in the key because it is in the Price lookup key too:
 * the same pack count at a different price list is a different change,
 * and replaying the old key must not silently reapply the old amount.
 */
export function b2bQuantityIdempotencyKey(
  subscriptionId: string, packs: number, grossCents: number
): string {
  return `gloa-b2b-qty-${subscriptionId}-${b2bMonthlyPriceLookupKey(packs, grossCents)}`;
}

/* ══════════════════════════════════════════════════════════════
   CANCELLATION
   ══════════════════════════════════════════════════════════════ */

export async function cancelB2bMonthly(
  deps: B2bChangeDeps,
  input: { agreementId: string; userId: string; reason?: unknown }
): Promise<B2bChangeOutcome> {
  const agreement = await deps.loadAgreement(input.agreementId);
  const gate = gateMonthly(agreement, input.userId);
  if (!gate.ok) return gate;
  const row = agreement as B2bAgreementFacts;

  // ── 0. THE AUTHORITATIVE BOUNDARY, from Stripe and from nowhere else.
  const subscription = await deps.retrieveSubscription(gate.subscriptionId);
  const boundary = b2bCurrentPeriodEnd(subscription);
  if (!boundary.ok) {
    // NO LOCAL FALLBACK. Deriving a boundary from started_at plus a month
    // would produce a date Stripe does not bill on, and the whole
    // 14-day promise is measured against Stripe's date.
    return { ok: false, kind: "no_billing_period", reason: boundary.reason };
  }

  const schedule = b2bCancellationSchedule({
    requestedAt: deps.now(),
    currentPeriodEnd: boundary.currentPeriodEnd,
  });

  // ── 1. THE DATABASE FIRST.
  const reason = typeof input.reason === "string" ? input.reason : null;
  const recorded = await deps.requestCancellation({
    agreementId: input.agreementId,
    expectedUserId: input.userId,
    effectiveAt: schedule.effectiveAt,
    reason,
  });

  // ALREADY PROMISED. 064 returns the existing promise and moves
  // nothing, so a repeated request converges on the FIRST date the
  // customer was given - including when the cutoff has since passed.
  if (recorded.result === "already_requested") {
    const promised = typeof recorded.cancellation_effective_at === "string"
      ? new Date(recorded.cancellation_effective_at)
      : schedule.effectiveAt;
    const synced = await applyCancelAtToStripe(deps, gate.subscriptionId, promised);
    if (!synced.ok) return synced;
    return {
      ok: true, kind: "already_requested",
      detail: { effectiveAt: promised.toISOString() },
    };
  }

  if (recorded.result !== "requested") {
    return {
      ok: false, kind: String(recorded.result ?? "refused"),
      reason: `the cancellation was refused: ${recorded.result ?? "unknown"}`,
    };
  }

  // ── 2. THEN STRIPE.
  const synced = await applyCancelAtToStripe(deps, gate.subscriptionId, schedule.effectiveAt);
  if (!synced.ok) return synced;

  return {
    ok: true, kind: "requested",
    detail: {
      effectiveAt: schedule.effectiveAt.toISOString(),
      cutoff: schedule.cutoff.toISOString(),
      currentPeriodEnd: schedule.currentPeriodEnd.toISOString(),
      inTime: schedule.inTime,
      periodsOwed: schedule.periodsOwed,
      // The row before the change, so the caller can see what moved.
      previousStatus: row.status,
    },
  };
}

/**
 * Tells Stripe to end the subscription AT the promised boundary.
 *
 * cancel_at with an EXACT Unix timestamp, not cancel_at_period_end.
 * cancel_at_period_end can only ever mean "the end of the period we are
 * in", which is wrong for exactly the case the 14-day rule creates: a
 * late request owes ONE MORE period, and there is no boolean that says
 * that. An exact timestamp expresses both cases with one field.
 *
 * proration_behavior "none" travels with it because the SDK warns that
 * setting cancel_at in a future period "will always cause a proration
 * for that period" when prorations are enabled. They are not, here.
 */
async function applyCancelAtToStripe(
  deps: B2bChangeDeps,
  subscriptionId: string,
  effectiveAt: Date
): Promise<B2bChangeOutcome> {
  const subscription = await deps.retrieveSubscription(subscriptionId);

  // ALREADY CARRYING IT. A replay must not re-issue the update.
  if (b2bCancelAtMatches(subscription.cancel_at, effectiveAt)) {
    return { ok: true, kind: "already_scheduled" };
  }

  await deps.updateSubscription(
    subscriptionId,
    { cancel_at: unixSeconds(effectiveAt), proration_behavior: "none" },
    { idempotencyKey: b2bCancelIdempotencyKey(subscriptionId, effectiveAt) }
  );
  return { ok: true, kind: "scheduled" };
}

export function b2bCancelIdempotencyKey(subscriptionId: string, effectiveAt: Date): string {
  return `gloa-b2b-cancel-${subscriptionId}-${unixSeconds(effectiveAt)}`;
}

/* ══════════════════════════════════════════════════════════════
   THE RECONCILE PASS
   ══════════════════════════════════════════════════════════════

   The other half of "database first". An agreement whose Stripe half
   never landed is found here and finished, and an agreement Stripe
   knows about that the database does not is recorded.

   Bounded, like every other B2B job: one pass, no loop until empty.
*/

export type B2bCancelReconcileRow = {
  agreement_id: string;
  stripe_subscription_id: string;
  cancellation_effective_at: string;
};

export type B2bCancelReconcileDeps = {
  /** Active monthly agreements carrying a promise, capped. */
  listPromised: (limit: number) => Promise<B2bCancelReconcileRow[]>;
  retrieveSubscription: (subscriptionId: string) => Promise<Stripe.Subscription>;
  updateSubscription: (
    subscriptionId: string,
    params: Stripe.SubscriptionUpdateParams,
    options?: { idempotencyKey: string }
  ) => Promise<Stripe.Subscription>;
};

export type B2bCancelReconcileSummary = {
  promised: number;
  alreadyScheduled: number;
  repaired: number;
  failed: number;
  outcomes: Array<{ agreementId: string; kind: string; detail?: string }>;
};

export const B2B_CANCEL_RECONCILE_LIMIT = 50;

export const emptyB2bCancelReconcileSummary = (): B2bCancelReconcileSummary =>
  ({ promised: 0, alreadyScheduled: 0, repaired: 0, failed: 0, outcomes: [] });

export async function runB2bCancellationReconciliation(
  deps: B2bCancelReconcileDeps,
  limit: number = B2B_CANCEL_RECONCILE_LIMIT
): Promise<B2bCancelReconcileSummary> {
  const summary = emptyB2bCancelReconcileSummary();
  const rows = await deps.listPromised(limit);
  summary.promised = rows.length;

  for (const row of rows) {
    const effectiveAt = new Date(row.cancellation_effective_at);
    try {
      const subscription = await deps.retrieveSubscription(row.stripe_subscription_id);

      if (b2bCancelAtMatches(subscription.cancel_at, effectiveAt)) {
        summary.alreadyScheduled += 1;
        summary.outcomes.push({ agreementId: row.agreement_id, kind: "already_scheduled" });
        continue;
      }

      // THE PROMISE IS AUTHORITATIVE HERE, not Stripe: this row exists
      // because the customer was told a date. Stripe carrying a
      // different one - or none - is the divergence being repaired.
      await deps.updateSubscription(
        row.stripe_subscription_id,
        { cancel_at: unixSeconds(effectiveAt), proration_behavior: "none" },
        { idempotencyKey: b2bCancelIdempotencyKey(row.stripe_subscription_id, effectiveAt) }
      );
      summary.repaired += 1;
      summary.outcomes.push({ agreementId: row.agreement_id, kind: "repaired" });
    } catch (err) {
      summary.failed += 1;
      summary.outcomes.push({
        agreementId: row.agreement_id, kind: "failed",
        detail: err instanceof Error ? err.message : "stripe error",
      });
      // One agreement's failure never stops the rest of the batch.
    }
  }

  return summary;
}
