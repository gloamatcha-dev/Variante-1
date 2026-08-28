import type Stripe from "stripe";
import { getSupabaseAdmin } from "./supabaseAdmin";
// The status vocabulary is a pure rule and lives in the leaf, so the
// focused suites can exercise it without loading a Supabase client.
import {
  isReconcilableStripeStatus,
} from "./subscriptionEmailDeliveryRules";

/**
 * Local payment-status reconciliation (Phase 3I.B2).
 *
 * The application half of migration 036's
 * sync_subscription_payment_status. It is a thin wrapper on purpose:
 * every guard that matters lives in the database, under a row lock,
 * where an application bug cannot skip it.
 *
 * ══════════════════════════════════════════════════════════════
 * ONE STATUS AUTHORITY, AND IT IS customer.subscription.updated.
 * ══════════════════════════════════════════════════════════════
 *
 * Three events could plausibly own local payment status and only one
 * does:
 *
 *   customer.subscription.updated  THIS one. Its handler already
 *                                  retrieves the subscription fresh from
 *                                  Stripe, so a duplicated or
 *                                  out-of-order delivery reconciles to
 *                                  today's truth rather than to the
 *                                  event's stale copy. That single
 *                                  property is what makes a late
 *                                  past_due event unable to regress a
 *                                  subscription that has since recovered.
 *   invoice.paid                   keeps first-payment activation, and
 *                                  nothing else. Making it a second
 *                                  status writer would create two
 *                                  writers that can disagree.
 *   invoice.payment_failed         writes NO status at all. It owns the
 *                                  customer email and nothing more.
 *
 * Recovery needs no extra path: when a customer finally pays, Stripe
 * moves the subscription back to active and emits subscription.updated,
 * which arrives here.
 *
 * ── IT CANNOT ACTIVATE AND IT CANNOT TERMINATE ────────────────
 *
 * The RPC refuses a 'pending' local row outright, so no Stripe event can
 * fabricate the first-payment proof that
 * activate_subscription_from_invoice exists to require. It refuses a
 * 'cancelled' row too, so nothing here can walk back a termination.
 */


/**
 * Every result migration 036's RPC can return, mirrored so the caller
 * can be exhaustive rather than guessing.
 *
 *   updated                   the local status moved.
 *   unchanged                 it already matched. No write happened, so
 *                             updated_at did not move either.
 *   pending_no_payment_proof  DELIBERATE PROTECTION, NOT AN ERROR. The
 *                             local row has never had a successful first
 *                             payment and no Stripe event may invent one.
 *   terminal                  the local row is cancelled. Also not an
 *                             error: it is the guard working.
 *   ignored_local_status      a local state this reconciliation does not
 *                             own, which today means 'paused' alone.
 *   ignored_status            the Stripe status is outside the three.
 *   not_found                 no local row carries that Stripe id.
 *   invalid_input             a caller bug. The only genuinely wrong one.
 */
export type PaymentStatusSyncResult =
  | "updated"
  | "unchanged"
  | "pending_no_payment_proof"
  | "terminal"
  | "ignored_local_status"
  | "ignored_status"
  | "not_found"
  | "invalid_input"
  /** The RPC itself could not be reached. */
  | "error"
  /** The RPC answered something this build does not recognise. */
  | "unknown";

/** Results that mean the reconciliation worked as designed. */
const EXPECTED_RESULTS: readonly string[] = Object.freeze([
  "updated",
  "unchanged",
  "pending_no_payment_proof",
  "terminal",
  "ignored_local_status",
  "ignored_status",
  "not_found",
]);

/**
 * Reconciles one subscription's local payment status from a FRESHLY
 * RETRIEVED Stripe subscription.
 *
 * The caller must pass a subscription it just read from Stripe, not one
 * lifted out of a webhook payload. That is the whole out-of-order
 * defence: an event delivered late still carries today's status because
 * the status was re-read, not remembered.
 *
 * IT NEVER THROWS. A reconciliation failure must not turn the Stripe
 * webhook into a 500 and start a redelivery storm over a status that the
 * next subscription.updated event will correct anyway.
 */
export async function reconcileSubscriptionPaymentStatus(
  subscription: Stripe.Subscription
): Promise<PaymentStatusSyncResult> {
  const stripeStatus = subscription.status;

  // Refused here as well as in the RPC. A status outside the three is
  // not an error and not worth a round trip.
  if (!isReconcilableStripeStatus(stripeStatus)) return "ignored_status";

  const admin = getSupabaseAdmin();
  if (!admin) {
    console.error("Subscription payment status: SUPABASE_SECRET_KEY is not configured.");
    return "error";
  }

  const { data, error } = await admin.rpc("sync_subscription_payment_status", {
    p_stripe_subscription_id: subscription.id,
    p_stripe_status: stripeStatus,
  });

  if (error) {
    // Stripe subscription id only. Never a customer fact.
    console.error(
      `Subscription payment status: RPC failed for ${subscription.id}:`,
      error.message
    );
    return "error";
  }

  const payload = (data ?? {}) as { result?: unknown };
  const result = typeof payload.result === "string" ? payload.result : "unknown";

  if (result === "invalid_input") {
    // The one result that is genuinely a bug on this side.
    console.error(`Subscription payment status: RPC rejected input for ${subscription.id}.`);
    return "invalid_input";
  }

  if (!EXPECTED_RESULTS.includes(result)) {
    console.error(
      `Subscription payment status: unrecognised RPC result for ${subscription.id}: ${result}`
    );
    return "unknown";
  }

  return result as PaymentStatusSyncResult;
}
