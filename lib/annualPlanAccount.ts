/**
 * What the account area is allowed to know about a prepaid annual plan,
 * and how it is derived (Phase 4B8).
 *
 * Pure and leaf: no relative imports, no database, no network, no clock,
 * no environment - the same shape lib/orderStatus.ts has for orders, and
 * for the same reasons. Every function here takes rows and returns facts,
 * so the whole customer-facing contract is unit-testable without Supabase
 * and cannot drift between the account list, the plan detail and whatever
 * later reads it.
 *
 * ── HOW THE ACCOUNT AREA READS, AND WHY THERE IS NO NEW API ───
 *
 * This repository's account portal reads its own rows directly with the
 * USER'S Supabase client, under RLS, and maps them with pure modules like
 * this one; app/AccountPortal.tsx does exactly that for orders,
 * subscriptions, addresses and supply agreements. There is no account API
 * layer to extend, and adding one for annual plans alone would be a
 * second architecture for the same job.
 *
 * OWNERSHIP IS THEREFORE ENFORCED IN POSTGRES, not in a component and not
 * in a filter that a caller could forget. Migration 039 enables RLS on
 * both annual tables and grants SELECT to `authenticated` only:
 *
 *   annual_plans              using (auth.uid() = user_id)
 *   annual_plan_deliveries    using (exists (select 1 from annual_plans p
 *                               where p.id = annual_plan_id
 *                                 and p.user_id = auth.uid()))
 *
 * anon holds nothing at all, and there is no INSERT, UPDATE or DELETE
 * policy for any browser role. Two consequences matter here:
 *
 *   * A query for somebody else's plan id returns ZERO ROWS. Not an
 *     error, not a permission message - the same empty answer as an id
 *     that never existed, so the account area cannot leak whether another
 *     customer's plan exists.
 *   * Nothing in this file may be handed a service-role client. It is a
 *     mapper; the rows it receives were already filtered by the database.
 *
 * ── IT DESCRIBES A CONTRACT. IT NEVER PRICES ONE. ─────────────
 *
 * No catalog is read, no annual discount is applied, no shipping rule is
 * evaluated and no tax is computed. An annual plan is a PURCHASE THAT
 * ALREADY HAPPENED, frozen at activation, and the account view of it must
 * still say "30 g" and the price actually paid a year later, whatever the
 * shop sells today. That is why lib/annualPlanRules.ts,
 * lib/annualPlanCheckoutRules.ts, lib/shipping.ts, lib/tax.ts and
 * lib/checkoutQuote.ts are deliberately not imported: a mapper that could
 * reach them could re-price history.
 *
 * ── AND IT DERIVES NO SCHEDULE ────────────────────────────────
 *
 * There is no "+ 28 days" here, no "+ 672 hours", no "month 4 of 12" and
 * no comparison against a clock. Activation wrote thirteen dates into
 * public.annual_plan_deliveries; progress is COUNTED from those rows and
 * the next delivery is READ from them. A missed cron run therefore cannot
 * make the account page disagree with what will actually ship.
 */

/* ══════════════════════════════════════════════════════════════
   WHAT THE BROWSER MAY SELECT
   ══════════════════════════════════════════════════════════════ */

/**
 * Every annual plan column the account is allowed to read.
 *
 * Named explicitly rather than `*`, for the reason SUBSCRIPTION_SELECT in
 * app/AccountPortal.tsx gives: a star select would hand the browser the
 * Stripe identity, the purchase-email claim token and four raw snapshots
 * the moment they exist, and "we simply never render it" is not the same
 * guarantee as never having sent it.
 *
 * DELIBERATELY ABSENT, and each for a reason:
 *
 *   stripe_payment_intent_id           the refund identity of a paid
 *   stripe_checkout_session_id         contract. No page needs it, and it
 *                                      is the one value that correlates
 *                                      money to this plan.
 *   payment_checkout_attempt_id        an internal idempotency anchor.
 *   purchase_confirmation_email_*      a delivery state machine, including
 *                                      a claim token that is authority to
 *                                      write an outcome.
 *   customer_snapshot                  the account already knows who the
 *                                      customer is; it is logged in.
 *   shipping_address_snapshot          addresses are the address book's
 *   billing_address_snapshot           job, not a contract summary's.
 *   tax_snapshot / delivery_tax_snapshot   raw calculation input.
 *   variant_id / user_id               internal correlation keys.
 *   updated_at                         an operational timestamp.
 *
 * delivery_items_snapshot IS selected, because it is the only truthful
 * source of what was bought - see buildAnnualPlanProduct, which reduces
 * it to a name, a label and a size rather than passing it through.
 */
export const ANNUAL_PLAN_ACCOUNT_SELECT =
  "id, status, payment_status, currency, delivery_count, " +
  "catalog_unit_gross_cents, annual_unit_gross_cents, shipping_per_delivery_gross_cents, " +
  "merchandise_total_gross_cents, shipping_total_gross_cents, total_gross_cents, " +
  "refunded_total_cents, discount_percent_applied, delivery_items_snapshot, " +
  "purchased_at, plan_end_at, completed_at, cancelled_at, created_at";

/**
 * Every delivery column the account is allowed to read.
 *
 * checkout_attempt_id is deliberately absent: it names the synthetic
 * attempt migration 039 mints, which is an internal fulfillment detail
 * and not something a customer has any use for. claimed_at is absent for
 * the same reason - a six-hour worker lease is not a customer fact, and
 * showing it would invite reading a queue state as a shipping promise.
 *
 * order_id IS selected: an annual delivery becomes an ORDINARY order, and
 * the account already renders those. Linking to the order the customer
 * can already open is the whole point of not inventing a second,
 * annual-specific representation of a physical delivery.
 */
export const ANNUAL_PLAN_DELIVERY_ACCOUNT_SELECT =
  "id, annual_plan_id, delivery_number, scheduled_for, state, fulfilled_at, order_id";

/**
 * Which plans belong in "meine Jahrespläne".
 *
 * PURCHASED ONES. A plan is written in status 'pending' before Stripe is
 * ever contacted, so a customer who opened a Checkout Session and closed
 * the tab leaves a pending row behind. Listing it would show an abandoned
 * checkout as though it were a contract the customer holds.
 *
 * purchased_at is the honest test: migration 039 writes it from the
 * attempt's paid_at at activation, and its paired CHECK keeps it present
 * exactly when plan_end_at is. The equivalent PostgREST filter is
 * `.not("purchased_at", "is", null)`, and the account list should ORDER BY
 * purchased_at DESC.
 *
 * A pending plan is still readable by its owner - RLS allows it and the
 * post-checkout resolver below needs it - it simply is not a contract yet.
 */
export function isPurchasedAnnualPlanRow(plan: { purchased_at?: unknown } | null | undefined): boolean {
  return typeof plan?.purchased_at === "string" && plan.purchased_at.trim() !== "";
}

/* ══════════════════════════════════════════════════════════════
   THE ROWS, AS THE DATABASE RETURNS THEM
   ══════════════════════════════════════════════════════════════ */

export type AnnualPlanAccountRow = {
  id: string;
  status: string;
  payment_status: string;
  currency: string;
  delivery_count: number;
  catalog_unit_gross_cents: number;
  annual_unit_gross_cents: number;
  shipping_per_delivery_gross_cents: number;
  merchandise_total_gross_cents: number;
  shipping_total_gross_cents: number;
  total_gross_cents: number;
  refunded_total_cents: number;
  /** numeric(5,2) arrives as a string from PostgREST, or as a number. */
  discount_percent_applied: number | string;
  delivery_items_snapshot: unknown;
  purchased_at: string | null;
  plan_end_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  created_at?: string | null;
};

export type AnnualPlanDeliveryAccountRow = {
  id: string;
  delivery_number: number;
  scheduled_for: string;
  state: string;
  fulfilled_at: string | null;
  order_id: string | null;
};

/* ══════════════════════════════════════════════════════════════
   THE VIEW
   ══════════════════════════════════════════════════════════════ */

/** What was bought, read from the FROZEN snapshot and from nothing else. */
export type AnnualPlanProductView = {
  name: string;
  variantLabel: string | null;
  sizeGrams: number | null;
  quantityPerDelivery: number;
};

/**
 * One delivery, as a customer may see it.
 *
 * `state` is migration 039's own word, passed through rather than
 * translated: 'scheduled', 'claimed', 'fulfilled', 'cancelled'. A
 * 'claimed' row is a delivery a worker has taken responsibility for and
 * has NOT yet shipped, and it must never be reported as fulfilled - the
 * account may say it is being prepared, and nothing stronger.
 */
export type AnnualPlanDeliveryView = {
  deliveryNumber: number;
  scheduledFor: string;
  state: string;
  fulfilledAt: string | null;
  /** The ordinary order this delivery became, for the existing order page. */
  orderId: string | null;
};

export type AnnualPlanAccountView = {
  id: string;
  /** 'pending' | 'active' | 'completed' | 'cancelled'. 039's vocabulary. */
  status: string;
  /** 'pending' | 'paid' | 'partially_refunded' | 'refunded'. */
  paymentStatus: string;

  product: AnnualPlanProductView | null;

  currency: string;
  annualUnitGrossCents: number;
  catalogUnitGrossCents: number;
  shippingPerDeliveryGrossCents: number;
  merchandiseTotalGrossCents: number;
  shippingTotalGrossCents: number;
  totalGrossCents: number;
  refundedTotalCents: number;
  discountPercentApplied: number | null;

  purchasedAt: string | null;
  planEndAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;

  deliveryCount: number;
  fulfilledDeliveries: number;
  /**
   * The next delivery that is genuinely still owed, or null.
   *
   * Null for a fully refunded plan, for a completed one, for a cancelled
   * one and for a plan with nothing left unfulfilled - see
   * findNextAnnualDelivery for why each of those is null rather than a
   * date nobody intends to ship.
   */
  nextDelivery: AnnualPlanDeliveryView | null;
  deliveries: AnnualPlanDeliveryView[];

  /**
   * False when the schedule the database returned is not the schedule the
   * parent claims - fewer rows than delivery_count, or duplicates. The
   * caller degrades; NOTHING here invents the missing rows.
   */
  scheduleComplete: boolean;

  /** Commercial facts, so no browser has to know them as arithmetic. */
  prepaid: true;
  autoRenews: false;
  cadence: "every_4_weeks";
};

/** The cadence, as a token rather than a sentence. Copy lives in the UI. */
export const ANNUAL_ACCOUNT_CADENCE = "every_4_weeks" as const;

/** The four lifecycle words migration 039 CHECKs. Nothing else is valid. */
export const ANNUAL_ACCOUNT_STATUSES: readonly string[] =
  Object.freeze(["pending", "active", "completed", "cancelled"]);

/** The four money words migration 039 CHECKs. */
export const ANNUAL_ACCOUNT_PAYMENT_STATUSES: readonly string[] =
  Object.freeze(["pending", "paid", "partially_refunded", "refunded"]);

/**
 * A delivery is DONE when the database says it shipped AND carries the
 * order it became.
 *
 * Both halves, deliberately: that is exactly the census
 * complete_due_annual_plans runs before it completes a plan, so the
 * progress a customer reads is the same progress the completion rule
 * counts. A 'fulfilled' row with no order_id cannot occur while
 * annual_plan_deliveries_fulfilled_check exists, and is not counted here
 * either way.
 */
export function isFulfilledAnnualDelivery(
  delivery: { state?: unknown; order_id?: unknown } | null | undefined
): boolean {
  return delivery?.state === "fulfilled"
    && typeof delivery.order_id === "string"
    && delivery.order_id.trim() !== "";
}

/**
 * The next delivery still owed, or null.
 *
 * ── NO CLOCK, AND THAT IS THE POINT ───────────────────────────
 *
 * "Next" is decided from DURABLE STATE, never from now(): the earliest
 * scheduled_for among rows that are neither fulfilled nor cancelled. A
 * delivery whose date has passed because a cron run was missed is still
 * the next one owed, and a page that filtered it out with a clock would
 * quietly hide work the system is going to do.
 *
 * A 'claimed' row is eligible and is returned with its own state word. It
 * is the next delivery: a worker has taken it and has not finished. The
 * caller may say "wird vorbereitet"; it may never say "geliefert".
 *
 * ── NULL IS AN ANSWER, IN FOUR CASES ──────────────────────────
 *
 *   FULLY REFUNDED    payment_status 'refunded' stops the queue, in the
 *                     database, for good. The schedule rows survive as
 *                     history and are still returned in `deliveries`, but
 *                     naming one of them "next" would promise a box that
 *                     the claim function will never hand out.
 *   COMPLETED         the term is over and all thirteen shipped.
 *   CANCELLED         nothing is owed.
 *   NOT ACTIVE YET    a pending plan has no schedule at all.
 *
 * A PARTIAL refund is deliberately NOT one of them. A customer refunded
 * one box is still owed the other twelve, and the database keeps
 * generating them.
 */
export function findNextAnnualDelivery(
  plan: { status: string; payment_status: string },
  deliveries: AnnualPlanDeliveryAccountRow[]
): AnnualPlanDeliveryAccountRow | null {
  if (plan.status !== "active") return null;
  if (plan.payment_status === "refunded") return null;

  const owed = deliveries.filter(d => d.state !== "fulfilled" && d.state !== "cancelled");
  if (owed.length === 0) return null;

  return owed.reduce((earliest, candidate) => {
    if (candidate.scheduled_for < earliest.scheduled_for) return candidate;
    if (candidate.scheduled_for > earliest.scheduled_for) return earliest;
    // Same instant: the lower delivery number is the earlier obligation.
    return candidate.delivery_number < earliest.delivery_number ? candidate : earliest;
  });
}

/**
 * What the customer bought, from the frozen delivery item snapshot.
 *
 * ONE item per delivery is what the annual contract allows, and migration
 * 039's annual_plans_delivery_items_shape_check enforces it. Anything
 * else - an empty array, a shape this does not recognise - answers null
 * rather than a plausible-looking guess, and the caller shows the plan
 * without a product line instead of inventing one.
 *
 * NOTHING IS READ FROM THE CATALOG. If the 30 g variant is relabelled or
 * retired tomorrow, this still says what was purchased.
 */
export function buildAnnualPlanProduct(snapshot: unknown): AnnualPlanProductView | null {
  const items = Array.isArray(snapshot) ? snapshot : [];
  const first = items[0] as Record<string, unknown> | undefined;
  if (!first || typeof first !== "object") return null;

  const name = typeof first.productName === "string" ? first.productName.trim() : "";
  if (!name) return null;

  const quantity = typeof first.quantity === "number" && Number.isInteger(first.quantity) && first.quantity > 0
    ? first.quantity
    : 1;

  return {
    name,
    variantLabel: typeof first.variantLabel === "string" && first.variantLabel.trim() !== ""
      ? first.variantLabel
      : null,
    sizeGrams: typeof first.sizeGrams === "number" && first.sizeGrams > 0 ? first.sizeGrams : null,
    quantityPerDelivery: quantity,
  };
}

/** numeric(5,2) reaches the browser as a string. Never NaN, never guessed. */
function readPercent(value: number | string | null | undefined): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toDeliveryView(row: AnnualPlanDeliveryAccountRow): AnnualPlanDeliveryView {
  return {
    deliveryNumber: row.delivery_number,
    scheduledFor: row.scheduled_for,
    state: row.state,
    fulfilledAt: row.fulfilled_at,
    orderId: typeof row.order_id === "string" && row.order_id.trim() !== "" ? row.order_id : null,
  };
}

/**
 * Maps one annual plan and its schedule into the customer-facing view.
 *
 * ── IT FAILS CLOSED ON A ROW IT CANNOT DESCRIBE ───────────────
 *
 * A parent whose id, status, payment_status or delivery_count is not what
 * migration 039 guarantees answers NULL, and the caller renders the same
 * neutral not-found it renders for an id that does not exist. Returning a
 * half-built view of a paid contract would be worse than showing nothing:
 * the numbers on that page are money.
 *
 * ── AND IT NEVER INVENTS A SCHEDULE ───────────────────────────
 *
 * If the delivery rows do not match delivery_count - fewer than the plan
 * claims, or a duplicated number - the view still reports the TRUE counts
 * and sets scheduleComplete false. It does not pad the list to thirteen,
 * and it does not scale progress to look right.
 */
export function buildAnnualPlanAccountView(
  plan: AnnualPlanAccountRow | null | undefined,
  deliveryRows: AnnualPlanDeliveryAccountRow[] | null | undefined
): AnnualPlanAccountView | null {
  if (!plan || typeof plan !== "object") return null;
  if (typeof plan.id !== "string" || plan.id.trim() === "") return null;
  if (!ANNUAL_ACCOUNT_STATUSES.includes(plan.status)) return null;
  if (!ANNUAL_ACCOUNT_PAYMENT_STATUSES.includes(plan.payment_status)) return null;
  if (typeof plan.delivery_count !== "number" || !Number.isInteger(plan.delivery_count) || plan.delivery_count <= 0) {
    return null;
  }
  for (const cents of [
    plan.annual_unit_gross_cents,
    plan.shipping_per_delivery_gross_cents,
    plan.merchandise_total_gross_cents,
    plan.shipping_total_gross_cents,
    plan.total_gross_cents,
    plan.refunded_total_cents,
  ]) {
    if (typeof cents !== "number" || !Number.isInteger(cents) || cents < 0) return null;
  }

  const rows = Array.isArray(deliveryRows) ? deliveryRows : [];
  const sorted = [...rows].sort((a, b) => a.delivery_number - b.delivery_number);
  const numbers = new Set(sorted.map(d => d.delivery_number));

  const next = findNextAnnualDelivery(plan, sorted);

  return {
    id: plan.id,
    status: plan.status,
    paymentStatus: plan.payment_status,

    product: buildAnnualPlanProduct(plan.delivery_items_snapshot),

    currency: plan.currency,
    annualUnitGrossCents: plan.annual_unit_gross_cents,
    catalogUnitGrossCents: plan.catalog_unit_gross_cents,
    shippingPerDeliveryGrossCents: plan.shipping_per_delivery_gross_cents,
    merchandiseTotalGrossCents: plan.merchandise_total_gross_cents,
    shippingTotalGrossCents: plan.shipping_total_gross_cents,
    totalGrossCents: plan.total_gross_cents,
    refundedTotalCents: plan.refunded_total_cents,
    discountPercentApplied: readPercent(plan.discount_percent_applied),

    purchasedAt: plan.purchased_at ?? null,
    planEndAt: plan.plan_end_at ?? null,
    completedAt: plan.completed_at ?? null,
    cancelledAt: plan.cancelled_at ?? null,

    deliveryCount: plan.delivery_count,
    // COUNTED from durable rows, never derived from elapsed time.
    fulfilledDeliveries: sorted.filter(isFulfilledAnnualDelivery).length,
    nextDelivery: next ? toDeliveryView(next) : null,
    deliveries: sorted.map(toDeliveryView),

    scheduleComplete: sorted.length === plan.delivery_count && numbers.size === sorted.length,

    prepaid: true,
    autoRenews: false,
    cadence: ANNUAL_ACCOUNT_CADENCE,
  };
}

/* ══════════════════════════════════════════════════════════════
   THE POST-CHECKOUT STATE
   ══════════════════════════════════════════════════════════════ */

/**
 * What the account page may conclude after a return from Stripe.
 *
 *   'active'      a purchased plan exists. The customer holds a contract.
 *   'processing'  a plan exists but has not been activated yet - the money
 *                 is settling, or the webhook has not arrived. Delayed
 *                 notification methods make this an ordinary outcome
 *                 rather than an error (Phase 4B4.2).
 *   'none'        this account has no annual plan at all.
 */
export type AnnualCheckoutReturnState = "active" | "processing" | "none";

/**
 * Resolves the post-checkout state from DURABLE ROWS ALONE.
 *
 * ── THE QUERY STRING IS AN INTENT, NEVER A PROOF ──────────────
 *
 * lib/annualPlanCheckout.ts sends the customer to `/account?annual=processing`
 * on success and `/account?annual=cancelled` on cancel. Both are UI
 * intent: a browser can type either one. Neither is an argument to this
 * function, and nothing here accepts a session id, a PaymentIntent, an
 * amount or a plan id from the caller - the plans passed in are the ones
 * RLS already proved belong to the signed-in user.
 *
 * That is also why no id needs to travel in the URL, and why this phase
 * adds no new public identifier: the account page asks "does the logged-in
 * customer hold an annual plan", which the user's own rows answer.
 *
 * ── AND IT NEVER POLLS STRIPE ─────────────────────────────────
 *
 * Payment truth arrives through the webhook, which is the only path that
 * activates a plan. A browser that could ask Stripe would be a second
 * source of truth about money, answering before the durable one.
 *
 * Ordering: a purchased plan wins over a pending one, so a customer who
 * abandoned a checkout last month and completed one today is told what
 * they now hold rather than what they left behind.
 */
export function resolveAnnualCheckoutReturnState(
  plans: Array<{ status?: unknown; purchased_at?: unknown }> | null | undefined
): AnnualCheckoutReturnState {
  const rows = Array.isArray(plans) ? plans : [];
  if (rows.length === 0) return "none";

  const purchased = rows.some(
    plan => isPurchasedAnnualPlanRow(plan) && (plan.status === "active" || plan.status === "completed")
  );
  if (purchased) return "active";

  // A row exists but is not a contract yet. 'cancelled' is deliberately
  // not "processing": nothing is settling for it.
  const settling = rows.some(plan => plan.status === "pending");
  return settling ? "processing" : "none";
}
