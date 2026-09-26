import type Stripe from "stripe";
import type { B2bSessionMetadata } from "./b2bWebhookRules.ts";

/**
 * The B2B settlement flow (Package 5C).
 *
 * Kept apart from lib/b2bWebhookRules.ts (the pure decisions) and from
 * lib/b2bWebhookDeps.ts (the real wiring), so the whole thing can be
 * driven with stubs: no Stripe object, no database, no network.
 *
 * ── EVERY FACT IS RE-READ FROM STRIPE ─────────────────────────
 *
 * Webhook delivery is asynchronous and unordered, and event.data.object
 * is a picture of the object at the moment the event was GENERATED. A
 * delayed or redelivered event can therefore carry a state several
 * changes old. So nothing here trusts the payload for anything but an
 * id: the session and the invoice are both retrieved again, exactly as
 * the one-time, subscription and annual handlers already do.
 *
 * ── AND NOTHING HERE DECIDES MONEY ────────────────────────────
 *
 * The frozen checkout attempt is the payment authority and migration 062
 * owns every amount and date. This module proves a payment happened and
 * hands two ids to a trusted RPC.
 */

export type B2bSettlementOutcome =
  | { kind: "activated"; agreementId: string; detail: string }
  | { kind: "already_active"; agreementId: string }
  /** Correct and expected: a monthly session waits for invoice.paid. */
  | { kind: "awaiting_invoice"; agreementId: string }
  /** The money did not arrive. Nothing was created. */
  | { kind: "not_paid"; agreementId: string; reason: string }
  | { kind: "refused"; agreementId: string; reason: string };

export type B2bAttemptMoneyFacts = {
  id: string;
  currency: string;
  expected_total_gross_cents: number;
  status: string;
  stripe_checkout_session_id: string | null;
};

export type B2bWebhookDeps = {
  retrieveSession: (sessionId: string) => Promise<Stripe.Checkout.Session>;
  retrieveInvoice: (invoiceId: string) => Promise<Stripe.Invoice>;
  retrieveSubscription: (subscriptionId: string) => Promise<Stripe.Subscription>;
  findAttemptById: (attemptId: string) => Promise<B2bAttemptMoneyFacts | null>;
  evaluatePayment: (
    session: { payment_status: string; currency: string; amount_total: number | null },
    attempt: { currency: string; expected_total_gross_cents: number }
  ) => { shouldMarkPaid: true } | { shouldMarkPaid: false; reason: string };
  linkSession: (attemptId: string, sessionId: string) => Promise<boolean>;
  markAttemptPaid: (attemptId: string, paymentIntentId: string | null) => Promise<boolean>;
  activateAnnual: (input: {
    agreementId: string;
    checkoutAttemptId: string;
    stripePaymentIntentId: string | null;
  }) => Promise<{ result: string; detail?: string }>;
  settleMonthlyInvoice: (input: {
    agreementId: string;
    stripeSubscriptionId: string;
    stripeInvoiceId: string;
  }) => Promise<{ result: string; deliveryNumber?: number }>;
};

/** The PaymentIntent id, whether Stripe expanded it or not. */
function paymentIntentIdOf(session: Stripe.Checkout.Session): string | null {
  const pi = session.payment_intent;
  if (typeof pi === "string") return pi.trim() || null;
  if (pi && typeof pi === "object" && typeof pi.id === "string") return pi.id;
  return null;
}

/**
 * Settles a B2B Checkout Session.
 *
 * ONE PATH for checkout.session.completed and
 * checkout.session.async_payment_succeeded. It re-retrieves the session,
 * re-proves the correlation, checks the frozen total and settles through
 * the same compare-and-set writers, so a replay of either event - or
 * both, in either order - converges on one activated agreement.
 *
 * A MONTHLY SESSION IS NOT SETTLED HERE. Its canonical event is
 * invoice.paid: a subscription session reaches payment_status "paid"
 * too, and activating on it would activate a contract before the first
 * invoice exists and before Stripe has a subscription id to record.
 */
export async function settleB2bCheckoutSession(
  sessionId: string,
  metadata: B2bSessionMetadata,
  deps: B2bWebhookDeps,
  source: "completed" | "async_payment_succeeded" = "completed"
): Promise<B2bSettlementOutcome> {
  const session = await deps.retrieveSession(sessionId);

  // A monthly agreement is billed by its subscription. Nothing to do
  // here, and saying so is not a failure.
  if (session.mode === "subscription") {
    return { kind: "awaiting_invoice", agreementId: metadata.agreementId };
  }

  const attempt = await deps.findAttemptById(metadata.checkoutAttemptId);
  if (!attempt) {
    return {
      kind: "refused",
      agreementId: metadata.agreementId,
      reason: `checkout attempt ${metadata.checkoutAttemptId} not found`,
    };
  }

  // THE FROZEN TOTAL IS THE AUTHORITY. The attempt recorded what the
  // customer was about to be asked for, before Stripe was contacted; if
  // Stripe's re-read amount is not that number, the two were computed
  // from different inputs and neither is trustworthy.
  const evaluation = deps.evaluatePayment(
    {
      payment_status: session.payment_status ?? "unknown",
      currency: session.currency ?? "",
      amount_total: session.amount_total,
    },
    { currency: attempt.currency, expected_total_gross_cents: attempt.expected_total_gross_cents }
  );

  if (!evaluation.shouldMarkPaid) {
    // A completed session that is not actually paid ACTIVATES NOTHING.
    // For a delayed payment method this is the normal first answer, and
    // async_payment_succeeded arrives later with the money.
    return {
      kind: "not_paid",
      agreementId: metadata.agreementId,
      reason: `${source}: ${evaluation.reason}`,
    };
  }

  // Re-link if the checkout's own best-effort link failed.
  if (attempt.stripe_checkout_session_id !== session.id) {
    await deps.linkSession(attempt.id, session.id);
  }

  const paymentIntentId = paymentIntentIdOf(session);

  // Idempotent by construction: marking an already-paid attempt paid
  // again writes the same two facts.
  await deps.markAttemptPaid(attempt.id, paymentIntentId);

  const activation = await deps.activateAnnual({
    agreementId: metadata.agreementId,
    checkoutAttemptId: attempt.id,
    stripePaymentIntentId: paymentIntentId,
  });

  if (activation.result === "activated") {
    return { kind: "activated", agreementId: metadata.agreementId, detail: source };
  }
  if (activation.result === "already_active") {
    return { kind: "already_active", agreementId: metadata.agreementId };
  }
  return {
    kind: "refused",
    agreementId: metadata.agreementId,
    reason: `${activation.result}${activation.detail ? `: ${activation.detail}` : ""}`,
  };
}

export type B2bInvoiceOutcome =
  | { kind: "not_b2b" }
  | { kind: "activated"; agreementId: string; deliveryNumber: number }
  | { kind: "settled"; agreementId: string; deliveryNumber: number }
  | { kind: "already_settled"; agreementId: string }
  | { kind: "refused"; agreementId: string | null; reason: string };

/**
 * Settles one paid Stripe invoice against a monthly B2B agreement.
 *
 * ── HOW A B2B INVOICE IS RECOGNISED ───────────────────────────
 *
 * By the SUBSCRIPTION's metadata, re-read from Stripe. The invoice
 * itself carries no GLOA metadata - Stripe generates it - and
 * subscription_data.metadata lands on the subscription. A consumer
 * subscription carries gloa_subscription_id and no agreement key, so it
 * answers not_b2b here and the existing B2C handler keeps it entirely
 * untouched.
 *
 * ── AND WHY THE AGREEMENT ROW IS NOT THE LOOKUP ───────────────
 *
 * invoice.paid can be delivered BEFORE checkout.session.completed. At
 * that moment b2b_supply_agreements.stripe_subscription_id is still
 * NULL, so resolving the agreement by it would fail on the very first
 * invoice - the one that activates the contract.
 */
export async function settleB2bPaidInvoice(
  invoiceId: string,
  deps: B2bWebhookDeps,
  route: (
    subscriptionMetadata: Stripe.Metadata | null | undefined,
    subscriptionId: string | null
  ) => { kind: "not_b2b" } | { kind: "b2b"; agreementId: string; stripeSubscriptionId: string }
    | { kind: "malformed"; reason: string }
): Promise<B2bInvoiceOutcome> {
  const invoice = await deps.retrieveInvoice(invoiceId);

  const subscriptionId = subscriptionIdOf(invoice);
  if (!subscriptionId) {
    // A one-off invoice. Not a B2B supply cycle.
    return { kind: "not_b2b" };
  }

  const subscription = await deps.retrieveSubscription(subscriptionId);
  const routed = route(subscription.metadata, subscription.id);

  if (routed.kind === "not_b2b") return { kind: "not_b2b" };
  if (routed.kind === "malformed") {
    return { kind: "refused", agreementId: null, reason: routed.reason };
  }

  // Only a PAID invoice settles. The caller reaches this on invoice.paid,
  // but the re-read is what proves it rather than the event name.
  if (invoice.status !== "paid") {
    return {
      kind: "refused",
      agreementId: routed.agreementId,
      reason: `invoice ${invoiceId} is ${invoice.status}, not paid`,
    };
  }

  const settlement = await deps.settleMonthlyInvoice({
    agreementId: routed.agreementId,
    stripeSubscriptionId: routed.stripeSubscriptionId,
    stripeInvoiceId: invoice.id ?? invoiceId,
  });

  if (settlement.result === "activated") {
    return {
      kind: "activated",
      agreementId: routed.agreementId,
      deliveryNumber: settlement.deliveryNumber ?? 1,
    };
  }
  if (settlement.result === "settled") {
    return {
      kind: "settled",
      agreementId: routed.agreementId,
      deliveryNumber: settlement.deliveryNumber ?? 0,
    };
  }
  if (settlement.result === "already_settled") {
    return { kind: "already_settled", agreementId: routed.agreementId };
  }
  return { kind: "refused", agreementId: routed.agreementId, reason: settlement.result };
}

/** The subscription id on an invoice, whether expanded or not. */
export function subscriptionIdOf(invoice: Stripe.Invoice): string | null {
  const raw = (invoice as unknown as { subscription?: unknown }).subscription;
  if (typeof raw === "string") return raw.trim() || null;
  if (raw && typeof raw === "object" && typeof (raw as { id?: unknown }).id === "string") {
    return (raw as { id: string }).id;
  }
  // Newer API shapes carry it on the invoice's parent details.
  const parent = (invoice as unknown as {
    parent?: { subscription_details?: { subscription?: unknown } };
  }).parent;
  const nested = parent?.subscription_details?.subscription;
  if (typeof nested === "string") return nested.trim() || null;
  if (nested && typeof nested === "object" && typeof (nested as { id?: unknown }).id === "string") {
    return (nested as { id: string }).id;
  }
  return null;
}

/* ══════════════════════════════════════════════════════════════
   PACKAGES 5D + 5F: ANNUAL INSTALMENT INVOICES AND FAILURES
   ══════════════════════════════════════════════════════════════ */

export type B2bAnnualInvoiceOutcome =
  | { kind: "not_annual" }
  | { kind: "settled"; agreementId: string; instalmentNumber: number }
  | { kind: "already_settled"; agreementId: string }
  | { kind: "failed_recorded"; agreementId: string; instalmentNumber: number }
  | { kind: "already_failed"; agreementId: string }
  | { kind: "refused"; agreementId: string | null; reason: string };

export type B2bFailureDeps = {
  settleAnnualInstalment: (input: {
    agreementId: string;
    stripeInvoiceId: string;
    stripePaymentIntentId: string | null;
  }) => Promise<{ result: string; instalmentNumber?: number }>;
  recordAnnualFailure: (input: {
    agreementId: string;
    stripeInvoiceId: string;
  }) => Promise<{ result: string; instalmentNumber?: number }>;
  holdDeliveries: (agreementId: string) => Promise<{ result: string; held?: number }>;
  releaseDeliveries: (agreementId: string) => Promise<{ result: string; released?: number }>;
};

/** The PaymentIntent behind an invoice, whether expanded or not. */
export function invoicePaymentIntentId(invoice: Stripe.Invoice): string | null {
  const direct = (invoice as unknown as { payment_intent?: unknown }).payment_intent;
  if (typeof direct === "string") return direct.trim() || null;
  if (direct && typeof direct === "object" && typeof (direct as { id?: unknown }).id === "string") {
    return (direct as { id: string }).id;
  }
  // Newer API shapes carry it under the invoice's payments.
  const payments = (invoice as unknown as {
    payments?: { data?: Array<{ payment?: { payment_intent?: unknown } }> };
  }).payments;
  const nested = payments?.data?.[0]?.payment?.payment_intent;
  if (typeof nested === "string") return nested.trim() || null;
  if (nested && typeof nested === "object" && typeof (nested as { id?: unknown }).id === "string") {
    return (nested as { id: string }).id;
  }
  return null;
}

/**
 * Settles a PAID annual instalment invoice (Package 5D).
 *
 * IT CREATES NO DELIVERY. An annual agreement received all twelve slots
 * at activation; a later instalment pays for deliveries that already
 * exist. That is the single most important difference from the monthly
 * settlement, and it is why 063 gave the two separate writers.
 *
 * A successful payment also RELEASES this package's own holds - and only
 * its own. Migration 063 refuses to release while any instalment is
 * still owed, so recovering one of two failed instalments correctly
 * leaves the deliveries held.
 */
export async function settleB2bAnnualPaidInvoice(
  invoiceId: string,
  deps: B2bWebhookDeps & B2bFailureDeps,
  route: (metadata: Stripe.Metadata | null | undefined) =>
    { kind: "not_annual" } | { kind: "annual"; agreementId: string; instalmentNumber: number }
    | { kind: "malformed"; reason: string }
): Promise<B2bAnnualInvoiceOutcome> {
  const invoice = await deps.retrieveInvoice(invoiceId);
  const routed = route(invoice.metadata);

  if (routed.kind === "not_annual") return { kind: "not_annual" };
  if (routed.kind === "malformed") {
    return { kind: "refused", agreementId: null, reason: routed.reason };
  }

  if (invoice.status !== "paid") {
    return {
      kind: "refused",
      agreementId: routed.agreementId,
      reason: `invoice ${invoiceId} is ${invoice.status}, not paid`,
    };
  }

  const settlement = await deps.settleAnnualInstalment({
    agreementId: routed.agreementId,
    stripeInvoiceId: invoice.id ?? invoiceId,
    stripePaymentIntentId: invoicePaymentIntentId(invoice),
  });

  if (settlement.result === "already_settled") {
    return { kind: "already_settled", agreementId: routed.agreementId };
  }
  if (settlement.result !== "settled") {
    return { kind: "refused", agreementId: routed.agreementId, reason: settlement.result };
  }

  // Recovery: release only what this package held, and only if nothing
  // else is still owed. 063 decides both.
  await deps.releaseDeliveries(routed.agreementId);

  return {
    kind: "settled",
    agreementId: routed.agreementId,
    instalmentNumber: settlement.instalmentNumber ?? routed.instalmentNumber,
  };
}

/**
 * Records a FAILED annual instalment invoice and holds supply
 * (Package 5F).
 *
 * The contract is NOT ended: 063 writes no agreement status, Stripe
 * keeps dunning, and 060's transition graph admits payment_failed ->
 * paid so the recovery above needs no special case.
 */
export async function recordB2bAnnualInvoiceFailure(
  invoiceId: string,
  deps: B2bWebhookDeps & B2bFailureDeps,
  route: (metadata: Stripe.Metadata | null | undefined) =>
    { kind: "not_annual" } | { kind: "annual"; agreementId: string; instalmentNumber: number }
    | { kind: "malformed"; reason: string }
): Promise<B2bAnnualInvoiceOutcome> {
  const invoice = await deps.retrieveInvoice(invoiceId);
  const routed = route(invoice.metadata);

  if (routed.kind === "not_annual") return { kind: "not_annual" };
  if (routed.kind === "malformed") {
    return { kind: "refused", agreementId: null, reason: routed.reason };
  }

  const recorded = await deps.recordAnnualFailure({
    agreementId: routed.agreementId,
    stripeInvoiceId: invoice.id ?? invoiceId,
  });

  if (recorded.result === "already_failed") {
    // Still hold: a redelivery must not leave supply running because the
    // first delivery already recorded the state.
    await deps.holdDeliveries(routed.agreementId);
    return { kind: "already_failed", agreementId: routed.agreementId };
  }
  if (recorded.result !== "failed") {
    return { kind: "refused", agreementId: routed.agreementId, reason: recorded.result };
  }

  await deps.holdDeliveries(routed.agreementId);

  return {
    kind: "failed_recorded",
    agreementId: routed.agreementId,
    instalmentNumber: recorded.instalmentNumber ?? routed.instalmentNumber,
  };
}

/**
 * A MONTHLY B2B invoice failed (Package 5F).
 *
 * A monthly agreement has NO payment schedule row - 060's integrity
 * assertion forbids one - so there is no payment state to write. The
 * failure is expressed entirely as a HOLD on unresolved future
 * deliveries, which is exactly what 060 introduced the held status for:
 * "a payment failure pauses DELIVERIES and leaves the contract
 * standing."
 *
 * Stripe dunning owns the retries. When a later invoice is paid, 062's
 * monthly settlement runs and the caller releases the hold.
 */
export async function holdB2bMonthlyForFailure(
  agreementId: string,
  deps: B2bFailureDeps
): Promise<{ kind: "held"; agreementId: string; held: number }
  | { kind: "refused"; agreementId: string; reason: string }> {
  const held = await deps.holdDeliveries(agreementId);
  if (held.result !== "held") {
    return { kind: "refused", agreementId, reason: held.result };
  }
  return { kind: "held", agreementId, held: held.held ?? 0 };
}
