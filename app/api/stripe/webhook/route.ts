import type Stripe from "stripe";
import { getStripeClient } from "../../../../lib/stripe";
import {
  hasStripeWebhookEventBeenProcessed,
  recordStripeWebhookEvent,
} from "../../../../lib/stripeWebhookEvents";
import {
  findAttemptByStripeSessionId,
  findAttemptByRequestId,
  linkStripeSession,
  markAttemptPaid,
} from "../../../../lib/checkoutAttempts";
import { evaluateStripeSessionPayment } from "../../../../lib/stripeFulfillment";
import { isRefundEventType, paymentIntentIdFromRefundEvent } from "../../../../lib/stripeRefunds";
import { syncOrderRefundStateFromStripe } from "../../../../lib/orderRefunds";
import { isNewSettledRefundFact } from "../../../../lib/refundConfirmationRules";
import { sendRefundConfirmationIfNeeded } from "../../../../lib/refundConfirmationEmail";
import { createOrderFromPaidCheckoutAttempt } from "../../../../lib/orderFulfillment";
import { buildShippingAddressSnapshot, buildBillingAddressSnapshot } from "../../../../lib/orderAddressSnapshot";
import { sendOrderConfirmationEmailIfNeeded } from "../../../../lib/orderConfirmationEmail";
import { sendInternalOrderNotificationIfNeeded } from "../../../../lib/internalOrderNotificationEmail";
import { fulfillPaidSubscriptionInvoice, subscriptionInvoiceDeps } from "../../../../lib/subscriptionInvoiceFulfillment";
import { idOf, resolveGloaSubscriptionId, stripeSubscriptionIdMatches } from "../../../../lib/subscriptionInvoiceRules";
import {
  applyDeferredCancellationFromRenewal,
  markSubscriptionCancelledFromStripe,
  syncSubscriptionFromStripe,
} from "../../../../lib/subscriptionCancellation";
import { getSupabaseAdmin } from "../../../../lib/supabaseAdmin";

type ErrorResponse = {
  error: string;
};

export async function POST(request: Request): Promise<Response> {
  const stripe = getStripeClient();
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!stripe || !webhookSecret) {
    console.error("Stripe webhook error: server not configured.");
    return Response.json(
      { error: "Webhook vorübergehend nicht verfügbar." } as ErrorResponse,
      { status: 503 }
    );
  }

  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return Response.json(
      { error: "Fehlende Signatur." } as ErrorResponse,
      { status: 400 }
    );
  }

  // Signature verification requires the exact, unparsed request body.
  const rawBody = await request.text();

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (err) {
    console.error("Stripe webhook signature verification failed:", err instanceof Error ? err.message : err);
    return Response.json(
      { error: "Ungültige Signatur." } as ErrorResponse,
      { status: 400 }
    );
  }

  const alreadyProcessed = await hasStripeWebhookEventBeenProcessed(event.id);
  if (alreadyProcessed === null) {
    return Response.json(
      { error: "Interner Fehler." } as ErrorResponse,
      { status: 500 }
    );
  }
  if (alreadyProcessed) {
    console.error(`Stripe webhook event ${event.id} (${event.type}) already processed - skipping.`);
    return Response.json({ received: true }, { status: 200 });
  }

  const checkoutSessionId =
    event.type.startsWith("checkout.session.") ? (event.data.object as Stripe.Checkout.Session).id : null;

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;
      // The two flows are separated here, explicitly, and this branch is
      // load-bearing. A subscription session is also payment_status
      // "paid" with an amount_total that matches its checkout attempt, so
      // without it the one-time handler below would mark that attempt
      // paid and create an order - the first order, from the wrong event.
      // invoice.paid is the canonical event and it must be the only one
      // that ships anything.
      if (session.mode === "subscription") {
        await handleSubscriptionSessionCompleted(stripe, session);
      } else {
        await handleCheckoutSessionCompleted(stripe, session);
      }
    } else if (event.type === "invoice.paid") {
      await handleInvoicePaid(stripe, event);
    } else if (isRefundEventType(event.type)) {
      await handleRefundEvent(stripe, event);
    } else if (event.type === "customer.subscription.updated") {
      // Phase 3C. Reconciles scheduling facts only - the two period
      // timestamps and cancel_at. It is what makes a cancellation that
      // reached Stripe but failed to persist locally self-heal, because
      // Stripe emits this event for that very change.
      await handleSubscriptionUpdated(stripe, event);
    } else if (event.type === "customer.subscription.deleted") {
      // Phase 3C. The ONLY path that writes status = 'cancelled'.
      await handleSubscriptionDeleted(event);
    }
    // Other event types are acknowledged below with no action taken.
    // invoice.payment_failed in particular: a failed payment creates no
    // order, no fulfillment and no paid state. The subscription lifecycle
    // it implies (past_due, unpaid) belongs to the later cancellation and
    // lifecycle task, not here, and is deliberately not invented.
    // checkout.session.async_payment_succeeded / _failed can plug into
    // this same handleCheckoutSessionCompleted-style flow later without
    // restructuring this route.
  } catch (err) {
    console.error(
      `Stripe webhook processing failed for event ${event.id} (${event.type}):`,
      err instanceof Error ? err.message : err
    );
    return Response.json(
      { error: "Interner Fehler." } as ErrorResponse,
      { status: 500 }
    );
  }

  const recorded = await recordStripeWebhookEvent(event.id, event.type, checkoutSessionId);
  if (!recorded.ok) {
    // Processing already succeeded above; a failure to record it only
    // risks redundant reprocessing on redelivery, not a lost payment, so
    // this still acknowledges the event.
    console.error(`Stripe webhook: failed to record event ${event.id} after successful processing.`);
  }

  return Response.json({ received: true }, { status: 200 });
}

/**
 * Reconciles scheduling facts from customer.subscription.updated
 * (Phase 3C).
 *
 * DELIBERATELY NARROW. Four facts reach the database: current_period_start,
 * current_period_end, cancel_at, and the clearing of a stale local
 * cancellation request when Stripe reports no cancellation at all.
 * migration 034's RPC refuses to write anything else - never status,
 * never money, never a snapshot, never the plan - so an arbitrary Stripe
 * update cannot rewrite GLOA business state.
 *
 * status in particular is NOT synchronised here. Stripe's status
 * vocabulary and GLOA's are different concepts, and the billing-failure
 * states ('past_due', 'unpaid') are Phase 3E's to design deliberately
 * rather than something this handler should start writing as a side
 * effect.
 *
 * A subscription this system did not create answers 'not_found' and is
 * ignored, which is the normal case for any Stripe account holding other
 * subscriptions.
 *
 * NEVER THE EVENT SNAPSHOT. Only the subscription id is taken from the
 * payload; every fact is re-read from Stripe, exactly as the checkout and
 * refund handlers already do.
 *
 * Webhook delivery is asynchronous and unordered. event.data.object is a
 * picture of the subscription at the moment the event was GENERATED, and
 * a delayed or redelivered event can therefore carry a state that is
 * several changes old. Syncing from it would regress
 * current_period_start, current_period_end and cancel_at - a renewal
 * undone, or a cancellation the owner has since removed put back. Because
 * every delivery re-reads instead, an old event and a new one write the
 * same current values, so an out-of-order arrival is a no-op rather than
 * a regression. No event-ordering column is needed to achieve that.
 *
 * A failed retrieve throws, which answers 500 and lets Stripe redeliver
 * against fresh state. Falling back to the stale payload would defeat the
 * entire purpose of the re-read.
 */
async function handleSubscriptionUpdated(stripe: Stripe, event: Stripe.Event): Promise<void> {
  const subscriptionId = (event.data.object as Stripe.Subscription)?.id;
  if (!subscriptionId) {
    console.error(`Stripe webhook: subscription updated event ${event.id} has no subscription id.`);
    return;
  }

  const subscription = await stripe.subscriptions.retrieve(subscriptionId);

  const result = await syncSubscriptionFromStripe(subscription);
  console.error(`Stripe webhook: subscription ${subscriptionId} updated -> ${result}`);
}

/**
 * Records an actual termination from customer.subscription.deleted
 * (Phase 3C).
 *
 * THE ONLY PLACE status BECOMES 'cancelled'. Scheduling a cancellation
 * never does it, and neither does the customer's request: until Stripe
 * says the subscription has ended, the customer is still paying for and
 * receiving a service and the record must say so.
 *
 * It destroys nothing. The local subscription row survives with its
 * snapshots, and every durable order from every past cycle is untouched -
 * those deliveries happened and were paid for.
 *
 * UNLIKE THE UPDATED HANDLER, this one deliberately does NOT re-read the
 * subscription from Stripe, and the asymmetry is intentional. Termination
 * is terminal: the deleted event's object IS the final state, there is no
 * later state for a re-read to discover, and the two facts taken from it
 * (the id and ended_at) cannot go stale. The RPC is idempotent and
 * refuses to move an existing cancelled_at, so ordering does not matter
 * either. A retrieve would only add a round trip and a failure mode.
 *
 * A delayed customer.subscription.updated arriving AFTER this cannot undo
 * it: that handler now syncs from current Stripe state, and its RPC never
 * writes status at all.
 */
async function handleSubscriptionDeleted(event: Stripe.Event): Promise<void> {
  const subscription = event.data.object as Stripe.Subscription;
  if (!subscription?.id) {
    console.error(`Stripe webhook: subscription deleted event ${event.id} has no subscription id.`);
    return;
  }

  const result = await markSubscriptionCancelledFromStripe(subscription);
  console.error(`Stripe webhook: subscription ${subscription.id} deleted -> ${result}`);
}

/**
 * Records refund state for a refund-related event (Task 26A).
 *
 * The only thing taken from the payload is which payment intent the
 * event concerns; every amount and status is re-read from Stripe by
 * syncOrderRefundStateFromStripe. Because that produces an absolute
 * refunded total rather than an increment, a redelivered or out-of-order
 * refund event converges on the same order row instead of double
 * counting - which is what keeps partial refunds correct.
 *
 * This path never issues a refund and never touches fulfillment,
 * shipping or any money column on the order. It also never touches the
 * § 356a withdrawal declarations in public.withdrawal_requests: a
 * withdrawal is a legal declaration by the customer, a Stripe refund is
 * an operational payment fact, and the two stay deliberately uncoupled.
 *
 * Phase 2E-A added one thing after the sync: when the state genuinely
 * MOVED, the customer is told. See the guard below, which is what keeps
 * historical refunds out of anyone's inbox.
 */
async function handleRefundEvent(stripe: Stripe, event: Stripe.Event): Promise<void> {
  const paymentIntentId = paymentIntentIdFromRefundEvent(event.data.object);

  if (!paymentIntentId) {
    // Refunds against a charge that has no payment intent (legacy
    // charges) are acknowledged without action rather than guessed at.
    console.error(`Stripe webhook: refund event ${event.id} (${event.type}) has no payment intent - ignored.`);
    return;
  }

  const outcome = await syncOrderRefundStateFromStripe(stripe, paymentIntentId);
  console.error(`Stripe webhook: refund event ${event.id} (${event.type}) -> ${outcome.result}`);

  // ── CUSTOMER REFUND CONFIRMATION (Phase 2E-A) ───────────────
  //
  // Strictly after the refund state is durable, and only when it
  // genuinely MOVED.
  //
  // isNewSettledRefundFact is the historical-refund guard and it is the
  // load-bearing half of this branch. apply_order_refund_state already
  // distinguishes 'applied' from 'unchanged'; only 'applied' means this
  // delivery wrote something new. Without it, a refund event that merely
  // restates an old refund - a charge.refund.updated for money returned
  // months ago - would find a never-notified order and mail that customer
  // about a refund they received long before this feature existed.
  //
  // The second half of the guard lives in the sender: it re-reads the row
  // and announces a cumulative total only when it exceeds the watermark
  // in refund_email_notified_total_cents. That is what lets one order
  // legitimately receive several refund emails - one per genuinely larger
  // settled total - without any of them repeating.
  //
  // NOTHING IS SENT for 'refund_pending', for a failed or cancelled
  // refund (both of which self-heal the order back to 'paid' with a zero
  // total), or for 'unchanged'.
  if (!isNewSettledRefundFact(outcome.result) || !outcome.orderId) return;

  // The sender never throws, deliberately, and the outcome is reported
  // rather than acted on. A 500 here would be worse than useless: on
  // Stripe's redelivery the sync would return 'unchanged', so this branch
  // would not be reached again and the email could not be retried that
  // way. Meanwhile the refund state is already durable and correct, and
  // must stay that way. A failed send records 'failed' - the one state a
  // future retry may key on - and touches nothing else.
  const emailOutcome = await sendRefundConfirmationIfNeeded(outcome.orderId);
  if (emailOutcome === "failed") {
    // The order id only. Never the recipient, the customer, or the amount.
    console.error(`Stripe webhook: refund confirmation failed for order ${outcome.orderId}.`);
  }
}

/**
 * Re-verifies and fulfills a checkout.session.completed event. Never
 * trusts the webhook payload's embedded session object for payment
 * facts - re-fetches the session directly from Stripe.
 */
async function handleCheckoutSessionCompleted(stripe: Stripe, eventSession: Stripe.Checkout.Session): Promise<void> {
  const session = await stripe.checkout.sessions.retrieve(eventSession.id);

  let attempt = await findAttemptByStripeSessionId(session.id);

  if (!attempt) {
    const requestId = session.metadata?.request_id;
    if (requestId) {
      attempt = await findAttemptByRequestId(requestId);
      if (attempt) {
        // Self-heal: the session-creation request's DB link must have
        // failed after Stripe had already created this session.
        await linkStripeSession(attempt.id, session.id);
      }
    }
  }

  if (!attempt) {
    console.error("Stripe webhook: no checkout attempt found for session", session.id);
    return;
  }

  const evaluation = evaluateStripeSessionPayment(
    {
      payment_status: session.payment_status,
      currency: session.currency ?? "",
      amount_total: session.amount_total,
    },
    {
      currency: attempt.currency,
      expected_total_gross_cents: attempt.expected_total_gross_cents,
    }
  );

  if (!evaluation.shouldMarkPaid) {
    console.error(`Stripe webhook: attempt ${attempt.id} not fulfillable -`, evaluation.reason);
    return;
  }

  const paymentIntentId =
    typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id ?? null;

  const marked = await markAttemptPaid(attempt.id, paymentIntentId);
  if (!marked) {
    throw new Error(`failed to mark checkout attempt ${attempt.id} paid`);
  }

  // Security check: the shipping country Stripe actually confirmed must
  // match what this attempt was priced/frozen for (see
  // getOrCreateCheckoutAttempt). shipping_address_collection.allowed_countries
  // is restricted to exactly that one country, so this should be
  // unreachable in normal use - but fail closed rather than assume, and
  // never silently re-zone a paid attempt after the fact. Payment is
  // still marked paid above (that's a true fact); only order creation is
  // withheld.
  const confirmedShippingCountry = session.collected_information?.shipping_details?.address?.country ?? null;
  if (!attempt.shipping_country || attempt.shipping_gross_cents === null || confirmedShippingCountry !== attempt.shipping_country) {
    console.error(
      `Stripe webhook: attempt ${attempt.id} shipping country mismatch or missing shipping snapshot (frozen=${attempt.shipping_country ?? "none"}, confirmed=${confirmedShippingCountry ?? "none"}) - fulfillment withheld.`
    );
    return;
  }
  const frozenShippingGrossCents = attempt.shipping_gross_cents;

  // Order creation is idempotent (see create_order_from_paid_checkout) and
  // always attempted here, even if this attempt was already marked paid by
  // an earlier delivery - a prior delivery may have failed after marking
  // paid but before the order existed, and a Stripe retry must still be
  // able to complete fulfillment, not be blocked by "already paid".
  const customerEmail = session.customer_details?.email ?? null;
  const order = await createOrderFromPaidCheckoutAttempt(
    attempt.id,
    {
      email: customerEmail,
      name: session.customer_details?.name ?? null,
    },
    paymentIntentId,
    buildShippingAddressSnapshot(session),
    buildBillingAddressSnapshot(session),
    frozenShippingGrossCents
  );

  // Confirmation email is sent only now that a real, persisted, paid
  // order genuinely exists. sendOrderConfirmationEmailIfNeeded() is its
  // own idempotency boundary (see lib/orderConfirmationEmail.ts) - safe
  // to call on every redelivery of this handler. It throws on a real
  // send failure, which propagates to the outer handler's catch below
  // and returns 500 - deliberately: that makes Stripe's own webhook
  // retry schedule double as this feature's email retry mechanism,
  // without needing a second, bespoke retry system. The order itself
  // is already fully created and paid at this point regardless of
  // whether the email ultimately succeeds.
  // Customer first, deliberately. Both emails now throw on failure, so
  // whichever runs first gets the first attempt - and the customer's
  // confirmation is the one they are owed. Its claim makes a later
  // redelivery skip it, so the internal notification still gets its own
  // retries without ever sending a second customer copy.
  const emailItems = attempt.items_snapshot.map(item => ({
    productName: item.productName,
    variantLabel: item.variantLabel,
    quantity: item.quantity,
    unitGrossCents: item.unitGrossCents,
    lineGrossCents: item.lineGrossCents,
  }));

  await sendOrderConfirmationEmailIfNeeded({ order, items: emailItems, customerEmail });

  await sendInternalOrderNotificationIfNeeded({
    order,
    items: attempt.items_snapshot.map(item => ({ ...item, sku: item.sku ?? null })),
    customerEmail,
    customerName: session.customer_details?.name ?? null,
    source: "one_time",
  });
}

/**
 * A paid subscription invoice becomes exactly one GLOA order
 * (Task 29D-E).
 *
 * This is the canonical fulfillment event for a subscription, for the
 * first cycle and for every four-weekly renewal alike. The browser
 * success page, checkout.session.completed, customer.subscription.created
 * and payment_intent.succeeded are all deliberately not it.
 *
 * A "failed" outcome THROWS rather than returning quietly. That is the
 * whole point: the outer handler turns a throw into a 500 and skips
 * recordStripeWebhookEvent, so the event never becomes terminally
 * processed, Stripe keeps retrying, and a genuinely paid invoice cannot
 * disappear because one delivery could not reconcile.
 */
async function handleInvoicePaid(stripe: Stripe, event: Stripe.Event): Promise<void> {
  const eventInvoice = event.data.object as Stripe.Invoice;
  if (!eventInvoice.id) {
    console.error(`Stripe webhook: invoice.paid event ${event.id} has no invoice id - ignored.`);
    return;
  }

  const result = await fulfillPaidSubscriptionInvoice(eventInvoice.id, subscriptionInvoiceDeps(stripe));

  if (result.kind === "failed") {
    // Sanitized: Stripe ids and GLOA uuids only. No address, name, email
    // or customer amount reaches a log line.
    throw new Error(`subscription invoice ${eventInvoice.id} could not be fulfilled: ${result.reason}`);
  }

  if (result.kind === "ignored") {
    console.error(`Stripe webhook: invoice ${eventInvoice.id} ignored - ${result.reason}`);
    return;
  }

  console.error(
    `Stripe webhook: invoice ${eventInvoice.id} fulfilled as order ${result.orderNumber}`
  );

  // ONLY the internal notification. A subscription cycle gets no generic
  // "Danke für deine Bestellung" - the dedicated customer lifecycle mails
  // ("Abo gestartet" for the first invoice, a delivery confirmation for
  // each later cycle) are their own later task, and sending the one-off
  // confirmation here now would mean every subscriber received two
  // different emails about the same delivery the day those arrive.
  // Fulfillment still has to be told about every paid cycle, so this one
  // runs for all of them.
  await sendInternalOrderNotificationIfNeeded({
    order: result.order,
    items: result.items.map(item => ({ ...item, sku: item.sku ?? null })),
    customerEmail: result.customerEmail,
    customerName: result.customerName,
    source: "subscription",
    stripeInvoiceId: result.stripeInvoiceId,
  });

  // ── A DEFERRED LATE CANCELLATION (Phase 3C.2) ───────────────
  //
  // STRICTLY LAST, and strictly after the order for this cycle exists.
  //
  // A late cancellation promises one further full-price cycle and
  // deliberately puts NOTHING on Stripe at request time: a cancel_at in a
  // future period always prorates, whatever proration_behavior says, and
  // a prorated renewal would fail the total check above for a cycle the
  // customer had already paid for. This is the event that proves the
  // owed cycle was paid, so the cancellation can now be set at Stripe for
  // the end of the period that just became current - a current-period
  // date, which prorates nothing.
  //
  // It answers 'nothing_pending' for every ordinary renewal, which is the
  // overwhelmingly common case, and it never throws: the delivery above
  // is already durable and must not be undone by a failure here. A
  // failure simply leaves the decision pending for the next renewal.
  const deferred = await applyDeferredCancellationFromRenewal(stripe, result.stripeSubscriptionId);
  if (deferred !== "nothing_pending") {
    // Stripe ids only. No customer, no amount, no email.
    console.error(
      `Stripe webhook: deferred cancellation for ${result.stripeSubscriptionId} -> ${deferred}`
    );
  }
}

/**
 * checkout.session.completed for a SUBSCRIPTION session.
 *
 * It validates the correlation and does nothing else. In particular it
 * must not activate the local subscription, must not create an order,
 * must not mark a paid cycle and must not send anything: a completed
 * Checkout Session means the customer finished the form, not that the
 * first invoice was paid, and invoice.paid may well arrive before this
 * event does.
 *
 * It also writes nothing. Synchronising subscriptions.stripe_subscription_id
 * here was considered and rejected: service_role holds SELECT on
 * public.subscriptions and no write grant, so it would have needed a new
 * privilege or a new RPC for a value that activate_subscription_from_invoice
 * binds authoritatively moments later anyway. A conflicting id still
 * fails closed, which is the part that actually matters.
 */
async function handleSubscriptionSessionCompleted(stripe: Stripe, eventSession: Stripe.Checkout.Session): Promise<void> {
  const session = await stripe.checkout.sessions.retrieve(eventSession.id);

  const gloaSubscriptionId = resolveGloaSubscriptionId(session.metadata);
  if (!gloaSubscriptionId) {
    console.error(`Stripe webhook: subscription session ${session.id} carries no gloa_subscription_id - ignored.`);
    return;
  }

  const stripeSubscriptionId = idOf(session.subscription as string | { id: string } | null);
  if (!stripeSubscriptionId) {
    console.error(`Stripe webhook: subscription session ${session.id} has no stripe subscription yet - ignored.`);
    return;
  }

  const admin = getSupabaseAdmin();
  if (!admin) {
    throw new Error("supabase admin client is not configured");
  }

  const { data, error } = await admin
    .from("subscriptions")
    .select("id, stripe_subscription_id")
    .eq("id", gloaSubscriptionId)
    .maybeSingle();

  if (error) {
    throw new Error(`subscription lookup failed for session ${session.id}: ${error.message}`);
  }
  if (!data) {
    console.error(`Stripe webhook: session ${session.id} references no local subscription - ignored.`);
    return;
  }

  // Two Stripe subscriptions pointing at one local row is never quietly
  // accepted. Throwing keeps the event retryable and visible rather than
  // acknowledging a correlation nobody has reconciled.
  if (!stripeSubscriptionIdMatches(data.stripe_subscription_id as string | null, stripeSubscriptionId)) {
    throw new Error(
      `subscription ${gloaSubscriptionId} is bound to a different stripe subscription than session ${session.id}`
    );
  }

  console.error(
    `Stripe webhook: subscription session ${session.id} verified for subscription ${gloaSubscriptionId} - no order created, invoice.paid remains canonical.`
  );
}
