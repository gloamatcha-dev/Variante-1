import type Stripe from "stripe";
import { getSupabaseAdmin } from "./supabaseAdmin";
import { createOrderFromPaidCheckoutAttempt, type CreatedOrder } from "./orderFulfillment";
import type { CheckoutAttemptItemSnapshot } from "./checkoutAttemptSnapshot";
import {
  customerChainMatches,
  evaluateSubscriptionInvoice,
  idOf,
  resolveGloaSubscriptionId,
  resolveInvoiceSubscriptionId,
  resolveSubscriptionPeriod,
  stripeSubscriptionIdMatches,
  validateLocalSubscription,
  type LocalSubscriptionFacts,
  type LocalSubscriptionItemFacts,
} from "./subscriptionInvoiceRules";

/**
 * A paid subscription invoice becomes exactly one GLOA order
 * (Task 29D-E).
 *
 * WHY THIS FILE CREATES NO NEW DATABASE OBJECTS. The one-invoice-one-order
 * guarantee already exists, live, as two unique indexes that compose:
 *
 *   checkout_attempts_stripe_invoice_id_key   (migration 022)
 *     unique (stripe_invoice_id) where stripe_invoice_id is not null
 *
 *   orders_checkout_attempt_id_key            (migration 011)
 *     unique (checkout_attempt_id) where checkout_attempt_id is not null
 *
 * One Stripe invoice can therefore produce at most one checkout attempt,
 * and one checkout attempt at most one order. The invariant is a
 * database guarantee end to end, not a select-then-insert, and it was
 * designed that way on purpose: migration 022 says a renewal "becomes an
 * ordinary paid checkout attempt and then an ordinary order, so the tax
 * snapshot, the shipping snapshot and the one-order-per-attempt
 * guarantee are reused rather than reimplemented".
 *
 * Correlation is answerable the same way. "Which subscription generated
 * this order" and "which Stripe invoice paid it" are both one join away
 * through orders.checkout_attempt_id, because checkout_attempts already
 * carries subscription_id and stripe_invoice_id. Copying either onto
 * orders would be a second place to disagree.
 *
 * So the flow is two existing security-definer functions in sequence,
 * followed by one narrow write that records what was paid:
 *
 *   activate_subscription_from_invoice   (022)
 *     locks the subscription, refuses a terminal status, refuses a
 *     conflicting Stripe subscription id, activates, and creates exactly
 *     one paid checkout attempt for this invoice - or returns the
 *     existing one.
 *
 *   create_order_from_paid_checkout      (021)
 *     locks that attempt and creates exactly one order and its items
 *     from the frozen snapshot - or returns the existing one.
 *
 *   record_paid_subscription_period      (034)
 *     locks the subscription and advances last_paid_period_end, but only
 *     after re-proving that a PAID attempt for this invoice exists on
 *     this subscription. Monotonic, so a redelivery is a no-op.
 *
 * All three are individually atomic and all three are idempotent, so a
 * redelivery converges instead of duplicating. They are three
 * transactions rather than one; the consequence is analysed under
 * PARTIAL FAILURE below and it is safe, because every later step is
 * reachable again on every retry.
 */

/** What the caller needs to answer Stripe with. */
export type InvoiceFulfillmentResult =
  /** Not ours, or not a delivery cycle. Acknowledge, do nothing. */
  | { kind: "ignored"; reason: string }
  /**
   * One order exists for this invoice, created now or already there.
   *
   * The persisted order and the frozen lines come back with it so the
   * caller can notify fulfillment and the customer WITHOUT re-reading
   * anything: the email must describe the order that exists, and every
   * value here came out of the frozen subscription snapshot.
   */
  | {
      kind: "fulfilled";
      orderId: string;
      orderNumber: string;
      created: boolean;
      order: CreatedOrder;
      items: CheckoutAttemptItemSnapshot[];
      customerEmail: string | null;
      customerName: string | null;
      stripeInvoiceId: string;
      /**
       * Which Stripe subscription this cycle belongs to.
       *
       * Reported so the caller never has to re-derive it from the
       * invoice. Phase 3C.2 needs it: a late cancellation is applied at
       * Stripe only once its one further cycle has genuinely been paid,
       * and this is the event that proves it was.
       */
      stripeSubscriptionId: string;
    }
  /**
   * Ours, but it does not reconcile. The caller must NOT mark the event
   * processed: an operator has to look, and Stripe's retry schedule is
   * what keeps the work reachable meanwhile.
   */
  | { kind: "failed"; reason: string };

export type SubscriptionInvoiceDeps = {
  /** Re-read from Stripe, never the webhook payload's embedded copy. */
  retrieveInvoice: (invoiceId: string) => Promise<Stripe.Invoice>;
  retrieveSubscription: (subscriptionId: string) => Promise<Stripe.Subscription>;
  loadLocalSubscription: (id: string) => Promise<LocalSubscriptionFacts | null>;
  loadLocalItems: (subscriptionId: string) => Promise<LocalSubscriptionItemFacts[]>;
  loadMappedStripeCustomerId: (userId: string) => Promise<string | null>;
  activateFromInvoice: (input: {
    subscriptionId: string;
    stripeSubscriptionId: string;
    stripeInvoiceId: string;
    currentPeriodStart: string | null;
    currentPeriodEnd: string | null;
    nextDeliveryAt: string | null;
  }) => Promise<string>;
  createOrder: (input: {
    checkoutAttemptId: string;
    subscription: LocalSubscriptionFacts;
  }) => Promise<CreatedOrder>;
  /**
   * Records that this subscription period was PAID (Phase 3C.5).
   *
   * Separate from activateFromInvoice because migration 022 is live and
   * immutable, and because the two facts are genuinely different:
   * activation reconciles the period Stripe currently reports, this
   * states that GLOA saw that period paid for. current_period_end cannot
   * do both jobs - the customer.subscription.updated reconciliation
   * writes it too, and that is not a payment event.
   */
  recordPaidPeriod: (input: {
    subscriptionId: string;
    stripeInvoiceId: string;
    paidPeriodEnd: string;
  }) => Promise<void>;
  /**
   * The frozen lines the order was built from. Read back off the attempt
   * rather than recomputed, so the notification describes the order that
   * exists - the same source the one-time flow's emails use.
   */
  loadAttemptItems: (checkoutAttemptId: string) => Promise<CheckoutAttemptItemSnapshot[]>;
};

const SUBSCRIPTION_COLUMNS =
  "id, user_id, status, currency, stripe_subscription_id, total_gross_cents, shipping_gross_cents, customer_snapshot, shipping_address_snapshot, billing_address_snapshot, plan_snapshot, tax_snapshot";

async function loadLocalSubscription(id: string): Promise<LocalSubscriptionFacts | null> {
  const admin = getSupabaseAdmin();
  if (!admin) throw new Error("supabase admin client is not configured");

  const { data, error } = await admin
    .from("subscriptions")
    .select(SUBSCRIPTION_COLUMNS)
    .eq("id", id)
    .maybeSingle();

  if (error) throw new Error(`subscription lookup failed: ${error.message}`);
  return (data as LocalSubscriptionFacts | null) ?? null;
}

async function loadLocalItems(subscriptionId: string): Promise<LocalSubscriptionItemFacts[]> {
  const admin = getSupabaseAdmin();
  if (!admin) throw new Error("supabase admin client is not configured");

  const { data, error } = await admin
    .from("subscription_items")
    .select("sku, quantity")
    .eq("subscription_id", subscriptionId);

  if (error) throw new Error(`subscription item lookup failed: ${error.message}`);
  return (data as LocalSubscriptionItemFacts[] | null) ?? [];
}

async function loadMappedStripeCustomerId(userId: string): Promise<string | null> {
  const admin = getSupabaseAdmin();
  if (!admin) throw new Error("supabase admin client is not configured");

  const { data, error } = await admin
    .from("stripe_customers")
    .select("stripe_customer_id")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw new Error(`stripe customer mapping lookup failed: ${error.message}`);
  return (data?.stripe_customer_id as string | undefined) ?? null;
}

async function activateFromInvoice(input: {
  subscriptionId: string;
  stripeSubscriptionId: string;
  stripeInvoiceId: string;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  nextDeliveryAt: string | null;
}): Promise<string> {
  const admin = getSupabaseAdmin();
  if (!admin) throw new Error("supabase admin client is not configured");

  const { data, error } = await admin.rpc("activate_subscription_from_invoice", {
    p_subscription_id: input.subscriptionId,
    p_stripe_subscription_id: input.stripeSubscriptionId,
    p_stripe_invoice_id: input.stripeInvoiceId,
    p_current_period_start: input.currentPeriodStart,
    p_current_period_end: input.currentPeriodEnd,
    p_next_delivery_at: input.nextDeliveryAt,
  });

  if (error || !data) {
    throw new Error(`activate_subscription_from_invoice failed: ${error?.message ?? "no attempt id returned"}`);
  }
  return typeof data === "string" ? data : String(data);
}

/**
 * The one call that can create payment evidence for a subscription.
 *
 * The RPC does not take this on trust: it refuses to write unless a PAID
 * checkout attempt for this exact Stripe invoice already exists on this
 * exact subscription, which only migration 022's activation - driven by
 * invoice.paid - can have created. It advances last_paid_period_end and
 * writes nothing else, and it only ever moves that value forward, so a
 * redelivery of the same invoice is a no-op rather than a second write.
 *
 * A failure THROWS. The caller is the webhook, which turns a throw into a
 * 500, skips recording the event and lets Stripe redeliver - and every
 * step ahead of this one is idempotent, so the retry re-attempts exactly
 * the missing evidence and creates no second order and no second email.
 */
async function recordPaidPeriod(input: {
  subscriptionId: string;
  stripeInvoiceId: string;
  paidPeriodEnd: string;
}): Promise<void> {
  const admin = getSupabaseAdmin();
  if (!admin) throw new Error("supabase admin client is not configured");

  const { data, error } = await admin.rpc("record_paid_subscription_period", {
    p_subscription_id: input.subscriptionId,
    p_stripe_invoice_id: input.stripeInvoiceId,
    p_paid_period_end: input.paidPeriodEnd,
  });

  if (error) {
    throw new Error(`record_paid_subscription_period failed: ${error.message}`);
  }

  // 'recorded' and 'unchanged' are both success: the second is what a
  // redelivered invoice produces. Anything else means the evidence was
  // NOT written, and the caller must not go on to end a subscription on
  // the strength of it.
  const result = ((data ?? {}) as { result?: unknown }).result;
  if (result !== "recorded" && result !== "unchanged") {
    throw new Error(
      `record_paid_subscription_period refused invoice ${input.stripeInvoiceId}: ${String(result)}`
    );
  }
}

/**
 * The order is built from the subscription's FROZEN snapshots and from
 * nothing else.
 *
 * Not the current catalog price, not the customer's current saved
 * address, not today's shipping rules and not a freshly computed tax
 * result. A customer who moves house or a shop that changes its prices
 * must not silently redirect or reprice a subscription that was agreed
 * months ago; changing an active subscription is a later, explicit
 * feature. Stripe is the payment authority, the frozen subscription is
 * the fulfillment authority.
 *
 * No payment intent is passed. This API version puts no payment intent
 * on the invoice, and a subscription order's payment correlation is the
 * invoice itself, reachable through the checkout attempt.
 */
async function createOrder(input: {
  checkoutAttemptId: string;
  subscription: LocalSubscriptionFacts;
}): Promise<CreatedOrder> {
  const { checkoutAttemptId, subscription } = input;
  return createOrderFromPaidCheckoutAttempt(
    checkoutAttemptId,
    subscription.customer_snapshot as { email: string | null; name: string | null },
    null,
    subscription.shipping_address_snapshot as never,
    subscription.billing_address_snapshot as never,
    subscription.shipping_gross_cents
  );
}

async function loadAttemptItems(checkoutAttemptId: string): Promise<CheckoutAttemptItemSnapshot[]> {
  const admin = getSupabaseAdmin();
  if (!admin) throw new Error("supabase admin client is not configured");

  const { data, error } = await admin
    .from("checkout_attempts")
    .select("items_snapshot")
    .eq("id", checkoutAttemptId)
    .maybeSingle();

  if (error) throw new Error(`checkout attempt item lookup failed: ${error.message}`);
  const items = data?.items_snapshot;
  return Array.isArray(items) ? (items as CheckoutAttemptItemSnapshot[]) : [];
}

export const defaultSubscriptionInvoiceDeps: SubscriptionInvoiceDeps = {
  retrieveInvoice: () => {
    throw new Error("retrieveInvoice must be provided by the caller with a Stripe client");
  },
  retrieveSubscription: () => {
    throw new Error("retrieveSubscription must be provided by the caller with a Stripe client");
  },
  loadLocalSubscription,
  loadLocalItems,
  loadMappedStripeCustomerId,
  activateFromInvoice,
  createOrder,
  recordPaidPeriod,
  loadAttemptItems,
};

/** Binds the Stripe-client-dependent halves for a real request. */
export function subscriptionInvoiceDeps(stripe: Stripe): SubscriptionInvoiceDeps {
  return {
    ...defaultSubscriptionInvoiceDeps,
    retrieveInvoice: id => stripe.invoices.retrieve(id),
    retrieveSubscription: id => stripe.subscriptions.retrieve(id),
  };
}

/**
 * Turns one paid Stripe invoice into one GLOA order.
 *
 * Every identifier that reaches a log line below is a Stripe id or a
 * GLOA uuid. No address, no name, no email and no amount belonging to a
 * customer is logged.
 */
export async function fulfillPaidSubscriptionInvoice(
  eventInvoiceId: string,
  deps: SubscriptionInvoiceDeps
): Promise<InvoiceFulfillmentResult> {
  // Re-read from Stripe rather than trusting the webhook payload's
  // embedded object, exactly as the one-time session handler does.
  const invoice = await deps.retrieveInvoice(eventInvoiceId);

  const stripeSubscriptionId = resolveInvoiceSubscriptionId(invoice);
  if (!stripeSubscriptionId) {
    return { kind: "ignored", reason: "invoice is not attached to a stripe subscription" };
  }

  const stripeSubscription = await deps.retrieveSubscription(stripeSubscriptionId);

  const gloaSubscriptionId = resolveGloaSubscriptionId(stripeSubscription.metadata);
  if (!gloaSubscriptionId) {
    // No fallback exists on purpose. Guessing from an email, a name, an
    // amount or "the most recent pending subscription" would eventually
    // attach one customer's payment to another customer's subscription.
    return { kind: "failed", reason: `stripe subscription ${stripeSubscriptionId} carries no gloa_subscription_id` };
  }

  const subscription = await deps.loadLocalSubscription(gloaSubscriptionId);
  if (!subscription) {
    // Deliberately the same shape of answer as a corrupted one, so the
    // response cannot be used to probe which uuids exist.
    return { kind: "failed", reason: `no local subscription for ${gloaSubscriptionId}` };
  }

  const items = await deps.loadLocalItems(subscription.id);
  const localCheck = validateLocalSubscription(subscription, items);
  if (!localCheck.ok) {
    return { kind: "failed", reason: `subscription ${subscription.id}: ${localCheck.reason}` };
  }

  // Two Stripe subscriptions pointing at one local row is never quietly
  // accepted, and the existing id is never overwritten.
  if (!stripeSubscriptionIdMatches(subscription.stripe_subscription_id, stripeSubscriptionId)) {
    return {
      kind: "failed",
      reason: `subscription ${subscription.id} is bound to a different stripe subscription`,
    };
  }

  // Metadata says which row to look at; it is not proof of whose money
  // paid. The whole chain has to close.
  const mappedCustomerId = await deps.loadMappedStripeCustomerId(subscription.user_id as string);
  if (!customerChainMatches({
    mappedStripeCustomerId: mappedCustomerId,
    subscriptionCustomerId: idOf(stripeSubscription.customer),
    invoiceCustomerId: idOf(invoice.customer as string | { id: string } | null),
  })) {
    return { kind: "failed", reason: `subscription ${subscription.id}: stripe customer does not match the local mapping` };
  }

  const decision = evaluateSubscriptionInvoice(
    {
      id: invoice.id ?? null,
      currency: invoice.currency ?? null,
      status: invoice.status ?? null,
      billingReason: invoice.billing_reason ?? null,
      total: typeof invoice.total === "number" ? invoice.total : null,
      customerId: idOf(invoice.customer as string | { id: string } | null),
      stripeSubscriptionId,
    },
    { totalGrossCents: subscription.total_gross_cents, currency: subscription.currency }
  );

  if (decision.kind === "ignore") return { kind: "ignored", reason: decision.reason };
  if (decision.kind === "fail") {
    return { kind: "failed", reason: `invoice ${invoice.id}: ${decision.reason}` };
  }

  // STEP 1. Activate and claim this invoice's checkout attempt. Migration
  // 022 does both under a row lock on the subscription and is idempotent
  // on stripe_invoice_id, so a redelivery returns the same attempt.
  const period = resolveSubscriptionPeriod(stripeSubscription);
  const checkoutAttemptId = await deps.activateFromInvoice({
    subscriptionId: subscription.id,
    stripeSubscriptionId,
    stripeInvoiceId: invoice.id as string,
    currentPeriodStart: period.currentPeriodStart,
    currentPeriodEnd: period.currentPeriodEnd,
    nextDeliveryAt: period.nextDeliveryAt,
  });

  // STEP 2. One order for that attempt. Migration 021 locks the attempt
  // and returns the existing order if there is one, so this is safe to
  // reach again on every retry - which is what makes the two-step shape
  // safe despite being two transactions.
  const order = await deps.createOrder({ checkoutAttemptId, subscription });
  const frozenItems = await deps.loadAttemptItems(checkoutAttemptId);

  // STEP 3. RECORD THAT THIS PERIOD WAS PAID (Phase 3C.5).
  //
  // Strictly after the order exists and strictly before the caller can
  // act on a deferred cancellation, because a cancellation that ends a
  // subscription must be able to point at durable proof that the cycle it
  // is ending was paid for. current_period_end cannot be that proof: the
  // customer.subscription.updated reconciliation writes the same column
  // from an event that is not a payment, so a failed renewal whose period
  // moved anyway would otherwise look exactly like a paid one - and the
  // customer would lose a cycle they had paid for.
  //
  // The value is the period this same flow just reconciled, off the
  // Stripe subscription re-read above. Not a browser value, not an event
  // payload, and not a wall clock: a period boundary, so everything
  // downstream compares periods to periods.
  //
  // A missing period end records nothing rather than guessing. The same
  // gap already stops the activation from advancing current_period_end,
  // so the deferred cancellation waits either way - which is the safe
  // direction: the customer keeps the cycle.
  if (period.currentPeriodEnd) {
    await deps.recordPaidPeriod({
      subscriptionId: subscription.id,
      stripeInvoiceId: invoice.id as string,
      paidPeriodEnd: period.currentPeriodEnd,
    });
  }

  // The frozen customer snapshot, not Stripe's billing details. Stripe is
  // the payment authority; the subscription snapshot is the fulfillment
  // authority, and that holds for who the confirmation is addressed to
  // just as much as for what is in the box.
  const customer = (subscription.customer_snapshot ?? {}) as { email?: unknown; name?: unknown };

  return {
    kind: "fulfilled",
    orderId: order.id,
    orderNumber: order.order_number,
    created: true,
    order,
    items: frozenItems,
    customerEmail: typeof customer.email === "string" ? customer.email : null,
    customerName: typeof customer.name === "string" ? customer.name : null,
    stripeInvoiceId: invoice.id as string,
    stripeSubscriptionId,
  };
}
