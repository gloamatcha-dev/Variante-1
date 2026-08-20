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
import { createOrderFromPaidCheckoutAttempt } from "../../../../lib/orderFulfillment";
import { buildShippingAddressSnapshot, buildBillingAddressSnapshot } from "../../../../lib/orderAddressSnapshot";

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
      await handleCheckoutSessionCompleted(stripe, event.data.object);
    }
    // Other event types are acknowledged below with no action taken.
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

  // Order creation is idempotent (see create_order_from_paid_checkout) and
  // always attempted here, even if this attempt was already marked paid by
  // an earlier delivery - a prior delivery may have failed after marking
  // paid but before the order existed, and a Stripe retry must still be
  // able to complete fulfillment, not be blocked by "already paid".
  await createOrderFromPaidCheckoutAttempt(
    attempt.id,
    {
      email: session.customer_details?.email ?? null,
      name: session.customer_details?.name ?? null,
    },
    paymentIntentId,
    buildShippingAddressSnapshot(session),
    buildBillingAddressSnapshot(session)
  );
}
