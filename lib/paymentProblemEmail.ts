import { getSupabaseAdmin } from "./supabaseAdmin";
import { getResendClient } from "./resend";
import { getSiteOrigin } from "./siteUrl";
import { GLOA_FROM_HELLO, GLOA_REPLY_TO_SUPPORT } from "./emailSenders";
import {
  buildPaymentProblemEmail,
  paymentProblemIdempotencyKey,
} from "./email/paymentProblem";
import {
  classifyPaymentProblemInvoiceStatus,
  classifySubscriptionEmailProviderError,
  evaluatePaymentProblemPreflight,
  isPaymentProblemInvoice,
  paymentProblemEventKey,
  PAYMENT_PROBLEM_FAMILY,
  type PaymentProblemFacts,
  type SubscriptionEmailProviderOutcome,
} from "./subscriptionEmailDeliveryRules";

/**
 * Tells the customer a subscription payment did not go through
 * (Phase 3I.B2).
 *
 * The fourth family, permitted by migration 036, and the first whose
 * preflight depends on a LIVE external read rather than on local columns
 * alone.
 *
 * ── IT WARNS. IT CHANGES NO BILLING STATE. ────────────────────
 *
 * Nothing here writes subscription status, creates an order, ships
 * anything, notifies fulfillment, advances payment proof or touches a
 * cancellation. It writes to exactly one table - the delivery row - and
 * migration 035 grants UPDATE on two columns of it. Local payment status
 * is reconciled by customer.subscription.updated alone; see
 * lib/subscriptionPaymentStatus.ts.
 *
 * ══════════════════════════════════════════════════════════════
 * THE LIVE INVOICE RE-READ IS MANDATORY, AND IT IS THE POINT.
 * ══════════════════════════════════════════════════════════════
 *
 * Stripe retries a failed invoice for days under Smart Retries. Between
 * the webhook that reported the failure and the moment this actually
 * sends - which for a retry may be a day later - the customer may well
 * have paid. The webhook payload is a snapshot of a moment that has
 * passed, so it is never trusted for the send decision: the invoice is
 * retrieved fresh and only a still-open invoice may produce a warning.
 *
 * ── STRIPE FAILURE IS NOT RESEND AMBIGUITY ────────────────────
 *
 * This distinction is the reason this sender differs from the other
 * three, and getting it backwards would be a real defect.
 *
 * A failure to READ Stripe happens strictly BEFORE Resend is contacted.
 * Provider acceptance is therefore not merely unlikely, it is
 * impossible: no request was made. So the delivery records 'failed',
 * which is exactly true - the provider did not accept it - and stays
 * safely retryable, because the next sweep will re-read Stripe and try
 * again.
 *
 * That is the opposite of a Resend transport failure, where the request
 * may have landed and the row must stay 'sending' forever. The two look
 * superficially similar and mean opposite things.
 */

/** What the caller learns. Never a customer fact, never a provider message. */
export type PaymentProblemEmailResult =
  | "sent"
  /** Not a reportable failure. Nothing claimed, nothing written. */
  | "not-eligible"
  /** Already claimed by some attempt. NOT a claim that it was delivered. */
  | "already-claimed"
  /** The problem is resolved or the subscription ended. Terminal. */
  | "superseded"
  /** The provider was contacted and we cannot prove what happened. */
  | "ambiguous"
  /** Proven not accepted, or refused before the provider was contacted. */
  | "failed";

/** Retrieves one invoice from Stripe. Injected, so this file imports no SDK. */
export type RetrieveInvoice = (invoiceId: string) => Promise<{ status?: string | null } | null>;

/** The subscription columns one payment warning is rebuilt from. */
const SUBSCRIPTION_COLUMNS = "id, customer_type, status, customer_snapshot, started_at";

type ClaimOutcome =
  | { kind: "claimed"; deliveryId: string }
  | { kind: "taken" }
  | { kind: "error" };

/** Reads back exactly the columns this message is built from. */
async function loadSubscription(
  subscriptionId: string
): Promise<{ ok: true; row: PaymentProblemFacts | null } | { ok: false }> {
  const admin = getSupabaseAdmin();
  if (!admin) return { ok: false };

  const { data, error } = await admin
    .from("subscriptions")
    .select(SUBSCRIPTION_COLUMNS)
    .eq("id", subscriptionId)
    .maybeSingle();

  if (error) {
    console.error(`Payment problem email: load failed for ${subscriptionId}:`, error.message);
    return { ok: false };
  }
  return { ok: true, row: (data as PaymentProblemFacts | null) ?? null };
}

/**
 * Atomically claims the right to warn about THIS invoice.
 *
 * ON CONFLICT DO NOTHING against migration 035's unique
 * (subscription_id, family, event_key), where event_key is the Stripe
 * invoice id. Every Smart Retry attempt on one cycle produces the same
 * key, so the customer is warned once per cycle rather than once per
 * attempt, and a redelivered webhook adds nothing.
 *
 * ZERO ROWS BACK DOES NOT MEAN ALREADY SENT. The existing row may be
 * 'sending', 'sent', 'failed' or 'superseded', and three of those four
 * mean the customer has not been written to.
 */
async function claimPaymentProblem(
  subscriptionId: string,
  eventKey: string
): Promise<ClaimOutcome> {
  const admin = getSupabaseAdmin();
  if (!admin) return { kind: "error" };

  const { data, error } = await admin
    .from("subscription_email_deliveries")
    .upsert(
      {
        subscription_id: subscriptionId,
        family: PAYMENT_PROBLEM_FAMILY,
        event_key: eventKey,
        status: "sending",
      },
      {
        // Migration 035's unique constraint, named explicitly so
        // PostgREST does not target the primary key instead.
        onConflict: "subscription_id,family,event_key",
        // ON CONFLICT DO NOTHING. Never DO UPDATE: the identity columns
        // are not updatable by design.
        ignoreDuplicates: true,
      }
    )
    .select("id");

  if (error) {
    console.error(`Payment problem email: claim failed for ${subscriptionId}:`, error.message);
    return { kind: "error" };
  }

  const claimed = data?.[0]?.id as string | undefined;
  return claimed ? { kind: "claimed", deliveryId: claimed } : { kind: "taken" };
}

/**
 * Records that Resend accepted the message. Deliberately unconditional:
 * acceptance is already a fact, and suppressing the write would leave a
 * row a sweep could send a second time.
 */
async function markSent(deliveryId: string): Promise<boolean> {
  const admin = getSupabaseAdmin();
  if (!admin) return false;
  const { error } = await admin
    .from("subscription_email_deliveries")
    .update({ status: "sent", sent_at: new Date().toISOString() })
    .eq("id", deliveryId);
  if (error) {
    console.error(`Payment problem email: mark-sent failed for delivery ${deliveryId}:`, error.message);
    return false;
  }
  return true;
}

/** Returns a claimed delivery to 'failed'. Guarded to 'sending'. */
async function markFailed(deliveryId: string): Promise<void> {
  const admin = getSupabaseAdmin();
  if (!admin) return;
  const { error } = await admin
    .from("subscription_email_deliveries")
    .update({ status: "failed", sent_at: null })
    .eq("id", deliveryId)
    .eq("status", "sending");
  if (error) {
    console.error(`Payment problem email: mark-failed failed for delivery ${deliveryId}:`, error.message);
  }
}

/**
 * Closes a claimed delivery whose payment problem is no longer current.
 *
 * The family this status matters most for. A warning claimed on Monday
 * and not yet sent must never go out on Tuesday if the customer paid on
 * Monday night - and Stripe's own retry schedule makes exactly that
 * likely rather than exotic.
 *
 * GUARDED TO ('sending', 'failed'), never 'sent'.
 */
async function markSuperseded(deliveryId: string): Promise<void> {
  const admin = getSupabaseAdmin();
  if (!admin) return;
  const { error } = await admin
    .from("subscription_email_deliveries")
    .update({ status: "superseded", sent_at: null })
    .eq("id", deliveryId)
    .in("status", ["sending", "failed"]);
  if (error) {
    console.error(`Payment problem email: mark-superseded failed for delivery ${deliveryId}:`, error.message);
  }
}

/** Where the customer sees the subscription. Null without SITE_URL. */
function buildAccountSubscriptionsUrl(): string | null {
  const origin = getSiteOrigin();
  if (!origin) return null;
  return `${origin}/account/subscriptions`;
}

/**
 * Warns the customer about one failed renewal invoice, at most once per
 * invoice.
 *
 * ONLY a renewal. billing_reason 'subscription_create' returns
 * not-eligible without touching the database: a first invoice that never
 * succeeded never activated the local subscription, so there is no
 * running subscription to warn about.
 *
 * There is NO recipient parameter. The address is read from the
 * subscription's own frozen customer_snapshot, so a Stripe invoice
 * email, a Stripe customer email, a browser value and a query string all
 * have nowhere to enter.
 */
export async function sendPaymentProblemEmailIfNeeded(input: {
  subscriptionId: string;
  invoiceId: string;
  billingReason: string | null;
  retrieveInvoice: RetrieveInvoice;
}): Promise<PaymentProblemEmailResult> {
  const { subscriptionId, invoiceId, billingReason, retrieveInvoice } = input;

  if (!subscriptionId) return "not-eligible";
  if (!isPaymentProblemInvoice(billingReason)) return "not-eligible";

  const eventKey = paymentProblemEventKey(invoiceId);
  if (!eventKey) return "not-eligible";

  const admin = getSupabaseAdmin();
  if (!admin) {
    console.error("Payment problem email: SUPABASE_SECRET_KEY is not configured.");
    return "failed";
  }

  // Decide before claiming, so a subscription that could never be warned
  // leaves no row at all.
  const first = await loadSubscription(subscriptionId);
  if (!first.ok) return "failed";

  const eligibility = evaluatePaymentProblemPreflight({
    subscription: first.row,
    claimed: false,
  });
  if (eligibility.kind !== "send") {
    return eligibility.kind === "failed" ? "failed" : "not-eligible";
  }

  const claim = await claimPaymentProblem(subscriptionId, eventKey);
  if (claim.kind === "error") return "failed";
  if (claim.kind === "taken") return "already-claimed";

  return deliverClaimedPaymentProblem(subscriptionId, eventKey, claim.deliveryId, retrieveInvoice);
}

/**
 * Renders and sends a warning whose claim has ALREADY been won, and
 * records the outcome.
 *
 * EXPORTED FOR THE RETRY SWEEP ONLY. The caller must already hold the
 * delivery - either the initial claim above, or the sweep's
 * compare-and-swap from 'failed' to 'sending'. It performs no INSERT,
 * which is why the sweep uses it: the public entry point starts with ON
 * CONFLICT DO NOTHING against a row that already exists and could never
 * retry anything.
 */
export async function deliverClaimedPaymentProblem(
  subscriptionId: string,
  invoiceId: string,
  deliveryId: string,
  retrieveInvoice: RetrieveInvoice
): Promise<PaymentProblemEmailResult> {
  // ── THE LOCAL HALF, RE-READ AFTER THE CLAIM ────────────────
  const second = await loadSubscription(subscriptionId);
  if (!second.ok) {
    await markFailed(deliveryId);
    return "failed";
  }

  const preflight = evaluatePaymentProblemPreflight({
    subscription: second.row,
    claimed: true,
  });

  if (preflight.kind === "superseded") {
    console.error(`Payment problem email: superseded for ${subscriptionId} - ${preflight.reason}`);
    await markSuperseded(deliveryId);
    return "superseded";
  }
  if (preflight.kind === "not-eligible" || preflight.kind === "failed") {
    console.error(`Payment problem email: preflight refused ${subscriptionId} - ${preflight.reason}`);
    await markFailed(deliveryId);
    return "failed";
  }

  // ── THE LIVE HALF ──────────────────────────────────────────
  //
  // Only Stripe knows whether the money is still owed. A read failure
  // here is recorded as 'failed' and NOT as ambiguous: Resend has not
  // been contacted, so no message can exist, and the next sweep will
  // re-read and try again.
  let invoiceStatus: string | null | undefined;
  try {
    const invoice = await retrieveInvoice(invoiceId);
    if (!invoice) {
      console.error(`Payment problem email: invoice ${invoiceId} could not be read.`);
      await markFailed(deliveryId);
      return "failed";
    }
    invoiceStatus = invoice.status;
  } catch (err) {
    // A Stripe outage, a 5xx or a timeout. Provider acceptance is
    // impossible because the provider was never reached.
    console.error(
      `Payment problem email: live invoice read failed for delivery ${deliveryId}:`,
      err instanceof Error ? err.message : "unknown error"
    );
    await markFailed(deliveryId);
    return "failed";
  }

  const live = classifyPaymentProblemInvoiceStatus(invoiceStatus);
  if (live.kind === "superseded") {
    console.error(`Payment problem email: superseded for delivery ${deliveryId} - ${live.reason}`);
    await markSuperseded(deliveryId);
    return "superseded";
  }
  if (live.kind === "unknown") {
    // Fails closed. An invoice status this build does not understand
    // must never be read as "still a problem".
    console.error(`Payment problem email: ${live.reason} for delivery ${deliveryId}`);
    await markFailed(deliveryId);
    return "failed";
  }

  const resend = getResendClient();
  if (!resend) {
    console.error("Payment problem email: RESEND_API_KEY is not configured.");
    await markFailed(deliveryId);
    return "failed";
  }

  const { subject, html, text } = buildPaymentProblemEmail({
    payment: { accountSubscriptionsUrl: buildAccountSubscriptionsUrl() },
  });

  // Keyed on the invoice, so every Smart Retry attempt on one cycle is
  // the same key and a later cycle correctly earns a new one.
  const idempotencyKey = paymentProblemIdempotencyKey(subscriptionId, invoiceId);

  let outcome: SubscriptionEmailProviderOutcome | "accepted" = "accepted";
  let sendErrorMessage: string | null = null;
  try {
    const { error: sendError } = await resend.emails.send(
      {
        from: GLOA_FROM_HELLO,
        to: preflight.recipient,
        replyTo: GLOA_REPLY_TO_SUPPORT,
        subject,
        html,
        text,
      },
      { idempotencyKey }
    );
    if (sendError) {
      // The shared hardened classifier. 4xx except 409 is a proven
      // refusal; 409, 5xx, a null status and anything unrecognised are
      // ambiguous and leave the row 'sending'.
      outcome = classifySubscriptionEmailProviderError(sendError);
      sendErrorMessage = sendError.message;
    }
  } catch (err) {
    outcome = "ambiguous";
    sendErrorMessage = err instanceof Error ? err.message : "unknown error";
  }

  if (outcome === "ambiguous") {
    console.error(
      `Payment problem email: AMBIGUOUS provider outcome for delivery ${deliveryId} (${PAYMENT_PROBLEM_FAMILY}) - left sending:`,
      sendErrorMessage
    );
    return "ambiguous";
  }

  if (outcome === "definite_failure") {
    console.error(
      `Payment problem email: send rejected for delivery ${deliveryId} (${PAYMENT_PROBLEM_FAMILY}):`,
      sendErrorMessage
    );
    await markFailed(deliveryId);
    return "failed";
  }

  if (!(await markSent(deliveryId))) {
    console.error(
      `Payment problem email: provider accepted but the sent state did not persist for delivery ${deliveryId} (${PAYMENT_PROBLEM_FAMILY}) - left sending.`
    );
    return "ambiguous";
  }
  return "sent";
}
