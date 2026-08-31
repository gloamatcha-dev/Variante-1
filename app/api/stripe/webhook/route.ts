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
// Phase 4B7. The annual parent's own refund correlation, tried before the
// ordinary order flow and resolving by the plan's PaymentIntent alone.
import { syncAnnualPlanRefundStateFromStripe } from "../../../../lib/annualPlanRefunds";
import { isNewSettledRefundFact } from "../../../../lib/refundConfirmationRules";
import { sendRefundConfirmationIfNeeded } from "../../../../lib/refundConfirmationEmail";
import { createOrderFromPaidCheckoutAttempt } from "../../../../lib/orderFulfillment";
import { buildShippingAddressSnapshot, buildBillingAddressSnapshot } from "../../../../lib/orderAddressSnapshot";
import { sendOrderConfirmationEmailIfNeeded } from "../../../../lib/orderConfirmationEmail";
import { sendInternalOrderNotificationIfNeeded } from "../../../../lib/internalOrderNotificationEmail";
import { fulfillPaidSubscriptionInvoice, subscriptionInvoiceDeps } from "../../../../lib/subscriptionInvoiceFulfillment";
import { sendSubscriptionStartedEmailIfNeeded } from "../../../../lib/subscriptionStartedEmail";
// Phase 3I.B2. Payment status reconciliation and the payment problem email.
import { reconcileSubscriptionPaymentStatus } from "../../../../lib/subscriptionPaymentStatus";
import { sendPaymentProblemEmailIfNeeded } from "../../../../lib/paymentProblemEmail";
import {
  idOf,
  resolveGloaSubscriptionId,
  resolveInvoiceSubscriptionId,
  stripeSubscriptionIdMatches,
} from "../../../../lib/subscriptionInvoiceRules";
import {
  applyDeferredCancellationFromRenewal,
  markSubscriptionCancelledFromStripe,
  syncSubscriptionFromStripe,
} from "../../../../lib/subscriptionCancellation";
import { getSupabaseAdmin } from "../../../../lib/supabaseAdmin";
// Phase 4B4. The annual branch of this same endpoint - one canonical
// Stripe webhook, a third payment model on it.
import { acknowledgeAnnualPaymentFailure, routeAnnualSession } from "../../../../lib/annualPlanWebhookRules";
import { settleAnnualCheckoutSession } from "../../../../lib/annualPlanWebhook";
import { annualWebhookDeps } from "../../../../lib/annualPlanWebhookDeps";

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
      // THREE FLOWS ARE SEPARATED HERE, EXPLICITLY, and this branch is
      // load-bearing. A subscription session is also payment_status
      // "paid" with an amount_total that matches its checkout attempt, so
      // without it the one-time handler below would mark that attempt
      // paid and create an order - the first order, from the wrong event.
      // invoice.paid is the canonical event and it must be the only one
      // that ships anything.
      //
      // AN ANNUAL SESSION RUNS mode "payment" TOO, so it would otherwise
      // land in the one-time handler and be settled by it: that would
      // mark the annual PAYMENT attempt paid and immediately mint ONE
      // order for thirteen boxes carrying the annual PaymentIntent -
      // exactly what migration 039's architecture forbids, because the
      // intent belongs to public.annual_plans alone and thirteen separate
      // deliveries are owed. The annual branch is therefore checked
      // first, and it routes on metadata rather than on anything about
      // the amount, the SKU, the quantity or the customer.
      const annual = routeAnnualSession(session.metadata);
      if (annual.kind === "malformed") {
        // A session carrying an annual plan id IS annual. Falling through
        // would hand a paid annual purchase to a handler written for a
        // different product, so this stops instead - loudly, because
        // somebody has already been charged.
        throw new Error(
          `annual checkout session ${session.id} has unusable metadata: ${annual.reason}`
        );
      }
      if (annual.kind === "annual") {
        await settleAnnualCheckoutSession(session.id, annual.metadata, annualWebhookDeps(stripe));
      } else if (session.mode === "subscription") {
        await handleSubscriptionSessionCompleted(stripe, session);
      } else {
        await handleCheckoutSessionCompleted(stripe, session);
      }
    } else if (event.type === "checkout.session.async_payment_succeeded") {
      // Phase 4B4.2. DELAYED PAYMENT METHODS. SEPA Direct Debit and the
      // bank-transfer family complete a Checkout Session immediately and
      // confirm the money days later, so the session above arrives with
      // payment_status "unpaid" and this is the event that says it was
      // actually paid. Without it a customer could pay in full and never
      // receive the annual plan they paid for.
      //
      // Which payment methods are offered is Stripe Dashboard
      // configuration - no flow in this repository restricts them - so
      // annual settlement is made safe for delayed methods rather than
      // made to depend on them being switched off.
      const session = event.data.object as Stripe.Checkout.Session;
      const annual = routeAnnualSession(session.metadata);
      if (annual.kind === "malformed") {
        throw new Error(
          `annual async payment for session ${session.id} has unusable metadata: ${annual.reason}`
        );
      }
      if (annual.kind === "annual") {
        // THE SAME settlement path, not a second one. It re-retrieves the
        // Session, re-proves the correlation, checks the frozen total and
        // settles through the same compare-and-set writers, so a replay
        // of either event converges on one plan.
        await settleAnnualCheckoutSession(
          session.id, annual.metadata, annualWebhookDeps(stripe), "async_payment_succeeded"
        );
      }
      // A NON-ANNUAL async payment keeps today's semantics exactly: it is
      // acknowledged and nothing happens. Solving delayed payments for
      // one-time orders is a separate decision and is not made here - and
      // in particular this must never fall through to the one-time
      // handler, which would create an order from an event the rest of
      // that flow has never been designed around.
    } else if (event.type === "checkout.session.async_payment_failed") {
      // Phase 4B4.2. The money did not arrive. This creates NOTHING: it
      // calls a pure function that has no writer to call, so it cannot
      // mark an attempt paid, activate a plan, claim a delivery or mint
      // an order even by mistake.
      //
      // The pending annual plan and the checkout attempt both survive as
      // evidence. Cancelling or expiring them would be inventing contract
      // semantics this event does not carry.
      const session = event.data.object as Stripe.Checkout.Session;
      const annual = routeAnnualSession(session.metadata);
      if (annual.kind === "malformed") {
        throw new Error(
          `annual async failure for session ${session.id} has unusable metadata: ${annual.reason}`
        );
      }
      if (annual.kind === "annual") {
        console.error(acknowledgeAnnualPaymentFailure(annual.metadata, session.id).message);
      }
    } else if (event.type === "invoice.paid") {
      await handleInvoicePaid(stripe, event);
    } else if (event.type === "invoice.payment_failed") {
      // Phase 3I.B2. It creates NOTHING: no order, no shipment, no
      // fulfillment notice, no payment proof and no status write. Its
      // entire job is the customer's payment-problem message.
      await handleInvoicePaymentFailed(stripe, event);
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
    // invoice.payment_failed is now handled above, and its contract has
    // not loosened: a failed payment still creates no order, no
    // fulfillment and no paid state. What Phase 3I.B2 added is the
    // customer's warning, and the past_due/unpaid reconciliation that
    // customer.subscription.updated performs from a fresh Stripe read.
    // checkout.session.async_payment_succeeded / _failed ARE handled
    // above, for annual sessions only. Delayed payments for one-time
    // orders remain an open product decision: those events are
    // acknowledged with no action, exactly as they were before.
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
 * status is synchronised SEPARATELY, and by a different function.
 * Migration 034's RPC still refuses to write it, exactly as before;
 * Phase 3I.B2 added migration 036's sync_subscription_payment_status
 * alongside it, which moves the local row only among 'active',
 * 'past_due' and 'unpaid' and refuses a 'pending' or 'cancelled' row
 * outright. Two RPCs, two disjoint column sets, one handler.
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
/**
 * A subscription renewal that did not get paid (Phase 3I.B2).
 *
 * ══════════════════════════════════════════════════════════════
 * IT CREATES NOTHING. IT ONLY TELLS THE CUSTOMER.
 * ══════════════════════════════════════════════════════════════
 *
 * A failed invoice is not a sale. This handler creates no order, calls
 * no fulfillment, sends no internal paid-order notification, ships
 * nothing, refunds nothing, advances no payment proof, activates no
 * subscription and touches no cancellation. Compare it with
 * handleInvoicePaid above: everything that makes a paid cycle real is
 * deliberately absent here, and none of it is reachable from this
 * function.
 *
 * IT ALSO WRITES NO SUBSCRIPTION STATUS. past_due and unpaid are
 * reconciled by customer.subscription.updated, which re-reads the
 * subscription from Stripe. The two events arrive in either order and
 * neither waits for the other: the customer's warning does not require
 * the local row to already say past_due, and the status write does not
 * require the warning to have been sent.
 *
 * ── ONLY A RENEWAL ────────────────────────────────────────────
 *
 * billing_reason must be 'subscription_cycle'. A first invoice that
 * never succeeded never activated the local subscription - migration 022
 * binds stripe_subscription_id only on activation, so the row could not
 * even be found - and the customer is still in Checkout, where Stripe
 * shows the failure to them directly. The sender enforces this itself,
 * so a second caller could not bypass it.
 *
 * ── THE INVOICE IS RE-READ, TWICE ─────────────────────────────
 *
 * Once here, so the billing reason and the subscription link come from
 * Stripe rather than from the event payload, exactly as invoice.paid
 * does. And again inside the sender immediately before Resend, because
 * Stripe retries a failed invoice for days and the customer may have
 * paid in between.
 *
 * It never throws: the warning is not worth a 500 that would make Stripe
 * redeliver a payment failure, and the delivery row is the durable retry
 * state.
 */
async function handleInvoicePaymentFailed(stripe: Stripe, event: Stripe.Event): Promise<void> {
  const eventInvoice = event.data.object as Stripe.Invoice;
  if (!eventInvoice.id) {
    console.error(`Stripe webhook: invoice.payment_failed event ${event.id} has no invoice id - ignored.`);
    return;
  }

  // Re-read rather than trusting the payload, the same rule every other
  // invoice fact in this route follows.
  const invoice = await stripe.invoices.retrieve(eventInvoice.id);

  const stripeSubscriptionId = resolveInvoiceSubscriptionId(invoice);
  if (!stripeSubscriptionId) {
    console.error(
      `Stripe webhook: failed invoice ${eventInvoice.id} is not attached to a subscription - ignored.`
    );
    return;
  }

  // Resolved by the Stripe subscription id and by nothing else. Never by
  // an email, a Stripe customer email or anything a caller could shape.
  const admin = getSupabaseAdmin();
  if (!admin) {
    console.error("Stripe webhook: SUPABASE_SECRET_KEY is not configured for payment failure.");
    return;
  }

  const { data, error } = await admin
    .from("subscriptions")
    .select("id")
    .eq("stripe_subscription_id", stripeSubscriptionId)
    .maybeSingle();

  if (error) {
    console.error(
      `Stripe webhook: subscription lookup failed for ${stripeSubscriptionId}:`,
      error.message
    );
    return;
  }
  if (!data) {
    // A Stripe subscription this system does not know. Fail closed: no
    // delivery row is created for a subscription that never activated.
    console.error(
      `Stripe webhook: failed invoice ${eventInvoice.id} has no local subscription - ignored.`
    );
    return;
  }

  const outcome = await sendPaymentProblemEmailIfNeeded({
    subscriptionId: data.id as string,
    invoiceId: invoice.id as string,
    // From the RE-READ invoice, never the payload's copy.
    billingReason: invoice.billing_reason ?? null,
    retrieveInvoice: id => stripe.invoices.retrieve(id),
  });

  if (outcome !== "not-eligible" && outcome !== "sent") {
    // Stripe invoice id and an outcome word. No recipient, no name, no
    // amount, and never the provider's message.
    console.error(
      `Stripe webhook: payment problem email for invoice ${eventInvoice.id} -> ${outcome}`
    );
  }
}

async function handleSubscriptionUpdated(stripe: Stripe, event: Stripe.Event): Promise<void> {
  const subscriptionId = (event.data.object as Stripe.Subscription)?.id;
  if (!subscriptionId) {
    console.error(`Stripe webhook: subscription updated event ${event.id} has no subscription id.`);
    return;
  }

  const subscription = await stripe.subscriptions.retrieve(subscriptionId);

  const result = await syncSubscriptionFromStripe(subscription);
  console.error(`Stripe webhook: subscription ${subscriptionId} updated -> ${result}`);

  // ── LOCAL PAYMENT STATUS (Phase 3I.B2) ──────────────────────
  //
  // THE SINGLE STATUS AUTHORITY, and it lives here because this handler
  // already RE-READ the subscription from Stripe above. That is the
  // whole out-of-order defence: a late or duplicated past_due event
  // reconciles to today's status rather than to the stale one it was
  // carrying, so it cannot regress a subscription that has since
  // recovered. Recovery needs no separate path either - Stripe moves a
  // paid-up subscription back to active and emits this same event.
  //
  // invoice.paid keeps first-payment activation and invoice.payment_failed
  // writes no status at all, so there is exactly one writer.
  //
  // Migration 036's RPC refuses a 'pending' or 'cancelled' local row, so
  // this can neither fabricate first-payment proof nor undo a
  // termination. 'pending_no_payment_proof' and 'terminal' are those
  // guards working, not errors, and none of these results throws.
  const paymentStatus = await reconcileSubscriptionPaymentStatus(subscription);
  if (paymentStatus !== "unchanged" && paymentStatus !== "ignored_status") {
    // Stripe subscription id and a result word. No customer fact.
    console.error(
      `Stripe webhook: subscription ${subscriptionId} payment status -> ${paymentStatus}`
    );
  }
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
 *
 * ── PHASE 4B7 ADDED ONE BRANCH IN FRONT OF ALL OF IT ──────────
 *
 * A prepaid annual plan is refunded against ITS OWN PaymentIntent, which
 * lives on the annual parent and on no order at all - migration 039
 * refuses a synthetic delivery attempt that carries a Stripe payment, so
 * the thirteen delivery orders are invisible to the lookup below and an
 * annual refund would otherwise correlate to nothing and be silently
 * dropped.
 *
 * The annual resolver therefore runs FIRST, and it decides only one
 * thing: does an annual plan carry this intent. If one does, the annual
 * writer records the money and this handler is finished - the ordinary
 * order flow must never see an annual intent. If none does, NOTHING was
 * read from Stripe and nothing was written, and the ordinary flow runs
 * exactly as it did before this phase: same lookup, same absolute
 * re-read, same writer, same words, same email.
 *
 * NO ANNUAL EMAIL IS SENT. A prepaid contract is not one delivery order,
 * and the ordinary refund confirmation describes a single order's total.
 * What a customer is owed after a partial refund of a thirteen-box plan
 * is a commercial decision this phase does not make.
 */
async function handleRefundEvent(stripe: Stripe, event: Stripe.Event): Promise<void> {
  const paymentIntentId = paymentIntentIdFromRefundEvent(event.data.object);

  if (!paymentIntentId) {
    // Refunds against a charge that has no payment intent (legacy
    // charges) are acknowledged without action rather than guessed at.
    console.error(`Stripe webhook: refund event ${event.id} (${event.type}) has no payment intent - ignored.`);
    return;
  }

  // ── THE ANNUAL PARENT, FIRST (Phase 4B7) ────────────────────
  //
  // Resolves by annual_plans.stripe_payment_intent_id and by nothing
  // else. A non-annual intent answers "not_annual" after one indexed
  // lookup, having issued no Stripe request, and falls through.
  const annual = await syncAnnualPlanRefundStateFromStripe(stripe, paymentIntentId);
  if (annual.kind === "annual") {
    // Counts and words only: the plan id and the writer's answer. No
    // amount, no customer, no address and no Stripe secret.
    console.error(
      `Stripe webhook: annual refund event ${event.id} (${event.type}) for plan ${annual.annualPlanId} -> ${annual.result}`
    );
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

  // ── "DEIN GLOA ABO IST AKTIV" (Phase 3H.2) ──────────────────
  //
  // The first customer-facing message a subscription has ever produced,
  // and it fires for the FIRST paid invoice only. The gate is
  // billing_reason === 'subscription_create', taken from the invoice
  // fulfillPaidSubscriptionInvoice re-read from Stripe rather than from
  // this event's embedded copy. Every renewal is 'subscription_cycle' and
  // deliberately produces no customer email: there is no recurring
  // "Zahlung erfolgreich" in this system, and the sender itself refuses a
  // cycle invoice, so this ordering cannot be bypassed by a later caller.
  //
  // ── WHY HERE, AND NOWHERE ELSE ──────────────────────────────
  //
  // AFTER the durable order exists, because a customer told their
  // subscription started must have a first delivery genuinely on the way.
  // AFTER the internal notification, because fulfillment learning about a
  // paid cycle must never queue behind a customer mail provider.
  // BEFORE the deferred cancellation below, because that block may throw
  // by design and a throw must not be able to skip the customer's message
  // on a delivery that got this far.
  //
  // ── AND IT CANNOT BREAK ANY OF THEM ─────────────────────────
  //
  // It never throws. A provider failure records 'failed' on its own
  // delivery row in public.subscription_email_deliveries and returns, so
  // the order, the payment evidence and the mandatory cancellation work
  // below all still happen on this same delivery. Throwing would buy
  // nothing: the failed row is already claimed, the redelivery's claim
  // would return zero rows, and re-attempting a 'failed' row needs the
  // status-guarded claim that a later phase will build. See the long note
  // in lib/subscriptionStartedEmail.ts.
  //
  // Redelivery-safe by the database, not by this call site. The claim is
  // keyed on (subscription id, family, event key) and NOT on the webhook
  // event id, so a redelivery of this invoice - and any other Stripe
  // event that ever represents the same first paid fact - finds the key
  // already claimed and sends nothing.
  const started = await sendSubscriptionStartedEmailIfNeeded({
    subscriptionId: result.subscriptionId,
    billingReason: result.billingReason,
  });

  // 'ambiguous' is reported too (Phase 3H.5B1): the provider may already
  // have delivered it, the row stays 'sending', and no automatic retry
  // will ever resend it - so this line is the only trace an operator gets.
  if (started === "failed" || started === "superseded" || started === "ambiguous") {
    // GLOA uuid and an outcome word. No recipient, no name, no plan, no
    // amount - and never the provider's message, which is logged where it
    // happened.
    console.error(
      `Stripe webhook: subscription start email for ${result.subscriptionId} -> ${started}`
    );
  }

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
  // The proof is DURABLE before this line runs. fulfillPaidSubscriptionInvoice
  // recorded last_paid_period_end for this invoice, and both the call
  // below and the daily sweep refuse to end a subscription without it -
  // because current_period_end is also written by the
  // customer.subscription.updated reconciliation, which is not a payment.
  //
  // It answers 'nothing_pending' for every ordinary renewal, which is the
  // overwhelmingly common case.
  const deferred = await applyDeferredCancellationFromRenewal(stripe, result.stripeSubscriptionId);

  if (deferred !== "nothing_pending") {
    // Stripe ids only. No customer, no amount, no email.
    console.error(
      `Stripe webhook: deferred cancellation for ${result.stripeSubscriptionId} -> ${deferred}`
    );
  }

  // ── IT IS A MANDATORY POST-PAYMENT ACTION (Phase 3C.3) ──────
  //
  // A failure here THROWS, and that is the whole point.
  //
  // Phase 3C.2 swallowed it and let the event be recorded as processed,
  // reasoning that the next renewal would apply the cancellation. That
  // reasoning was wrong in the one way that matters: the next renewal is
  // 28 days away and it CHARGES THE CUSTOMER AGAIN. A transient Stripe or
  // Supabase failure would have turned "exactly one further cycle" into
  // two, and the customer would have paid for the difference.
  //
  // Throwing hands the problem to the mechanism that already solves it.
  // recordStripeWebhookEvent runs only after this function returns
  // cleanly, so an unrecorded event is redelivered by Stripe - for up to
  // three days, with backoff - and every action ahead of this one is
  // idempotent on redelivery: activate_subscription_from_invoice returns
  // the same checkout attempt, create_order_from_paid_checkout returns
  // the same order, and the internal notification's claim answers
  // 'already-sent'. No duplicate order, no duplicate email, no second
  // charge. Only the cancellation is retried.
  //
  // Stripe eventually gives up. The daily sweep in
  // sweepDueDeferredCancellations is the net underneath that, and it
  // closes the remaining window long before another cycle can bill.
  if (deferred === "error") {
    // Stripe subscription id only, exactly as the failure above.
    throw new Error(
      `deferred cancellation for subscription ${result.stripeSubscriptionId} could not be applied`
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
