import type Stripe from "stripe";
import type { B2bRpcResult } from "./b2bAccountChange.ts";

/**
 * WHAT THE WEBHOOK DOES WITH A 5G CHANGE.
 *
 * Three narrow steps, injected like everything else in this package:
 *
 *   applyB2bPendingQuantity      invoice.paid, BEFORE the settlement
 *   reconcileB2bCancelAt         customer.subscription.updated
 *   terminateB2bSubscription     customer.subscription.deleted
 *
 * ── WHY THE QUANTITY IS APPLIED BEFORE THE SETTLEMENT ─────────
 *
 * Migration 062's settle_b2b_monthly_paid_invoice creates the period's
 * delivery from the agreement's CURRENT quantity_packs. 062 is live and
 * immutable, so the new count has to be in that column before the
 * settlement reads it - which is exactly what this step does, in its own
 * transaction, immediately before.
 *
 * The invoice that just paid already carries the new amount, because the
 * Stripe Price was swapped when the customer asked. So the money and the
 * delivery move at the same boundary without 062 being touched.
 *
 * If this step fails, the settlement still runs and the delivery carries
 * the OLD count - one period late rather than wrong forever, because the
 * pending change is still in the database and the next boundary applies
 * it. Failing the whole webhook instead would mean the paid invoice
 * created no delivery at all, which is worse.
 */

export type B2bAccountWebhookDeps = {
  /** 064's narrow subscription -> agreement read. */
  agreementForSubscription: (subscriptionId: string) => Promise<B2bRpcResult>;
  /** 064's boundary writer. */
  applyPendingQuantity: (agreementId: string) => Promise<B2bRpcResult>;
  /** 064's convergence writer. */
  reconcileCancellation: (agreementId: string, effectiveAt: Date) => Promise<B2bRpcResult>;
  /** 064's termination writer. */
  settleCancelledSubscription: (subscriptionId: string) => Promise<B2bRpcResult>;
};

const agreementIdOf = (row: B2bRpcResult): string | null =>
  row.result === "found" && typeof row.agreement_id === "string" ? row.agreement_id : null;

/* ── invoice.paid: the boundary ─────────────────────────────── */

export type B2bQuantityApplication =
  | { kind: "not_b2b" }
  | { kind: "no_pending_change"; agreementId: string }
  | { kind: "applied"; agreementId: string; quantityPacks: number }
  | { kind: "failed"; agreementId: string | null; detail: string };

export async function applyB2bPendingQuantity(
  subscriptionId: string | null,
  deps: B2bAccountWebhookDeps
): Promise<B2bQuantityApplication> {
  if (!subscriptionId) return { kind: "not_b2b" };

  const row = await deps.agreementForSubscription(subscriptionId);
  const agreementId = agreementIdOf(row);
  // A subscription this system does not own. Say nothing, do nothing:
  // every B2C subscription reaches this branch too.
  if (!agreementId) return { kind: "not_b2b" };

  if (row.pending_quantity_packs === null || row.pending_quantity_packs === undefined) {
    return { kind: "no_pending_change", agreementId };
  }

  const applied = await deps.applyPendingQuantity(agreementId);
  if (applied.result === "applied") {
    return {
      kind: "applied", agreementId,
      quantityPacks: Number(applied.quantity_packs ?? row.pending_quantity_packs),
    };
  }
  // Includes 'no_pending_change', which a redelivered event produces
  // once the first delivery already applied it.
  if (applied.result === "no_pending_change") {
    return { kind: "no_pending_change", agreementId };
  }
  return { kind: "failed", agreementId, detail: String(applied.result ?? "unknown") };
}

/* ── customer.subscription.updated: convergence ─────────────── */

export type B2bCancelReconciliation =
  | { kind: "not_b2b" }
  | { kind: "no_cancel_at"; agreementId: string }
  | { kind: "reconciled"; agreementId: string; result: string }
  | { kind: "failed"; agreementId: string; detail: string };

/**
 * Stripe told us a subscription now cancels at a date.
 *
 * This is the half that recovers the crash the other way round: a
 * cancellation that reached Stripe but never reached the database - or
 * one an operator scheduled in the Stripe dashboard - is recorded here
 * rather than silently diverging.
 *
 * A subscription with NO cancel_at is left alone. Clearing our
 * cancellation because an unrelated update arrived without the field
 * would un-promise a date the customer has already been given; undoing
 * a cancellation is a decision, not a reconciliation.
 */
export async function reconcileB2bCancelAt(
  subscription: Pick<Stripe.Subscription, "id" | "cancel_at">,
  deps: B2bAccountWebhookDeps
): Promise<B2bCancelReconciliation> {
  const row = await deps.agreementForSubscription(subscription.id);
  const agreementId = agreementIdOf(row);
  if (!agreementId) return { kind: "not_b2b" };

  if (typeof subscription.cancel_at !== "number" || subscription.cancel_at <= 0) {
    return { kind: "no_cancel_at", agreementId };
  }

  const reconciled = await deps.reconcileCancellation(
    agreementId, new Date(subscription.cancel_at * 1000)
  );
  const result = String(reconciled.result ?? "unknown");
  if (result === "recorded" || result === "already_recorded" || result === "effective_moved") {
    return { kind: "reconciled", agreementId, result };
  }
  return { kind: "failed", agreementId, detail: result };
}

/* ── customer.subscription.deleted: the end ─────────────────── */

export type B2bTermination =
  | { kind: "not_b2b" }
  | { kind: "cancelled"; agreementId: string }
  | { kind: "already_cancelled"; agreementId: string }
  | { kind: "failed"; detail: string };

/**
 * The subscription has actually ended.
 *
 * The ONLY path that writes status = 'cancelled' on a self-service
 * monthly agreement, and it is driven by Stripe rather than by a local
 * timer - the same posture Phase 3C took for B2C, because only Stripe
 * knows whether it really stopped billing.
 */
export async function terminateB2bSubscription(
  subscriptionId: string,
  deps: B2bAccountWebhookDeps
): Promise<B2bTermination> {
  const settled = await deps.settleCancelledSubscription(subscriptionId);
  const result = String(settled.result ?? "unknown");

  if (result === "agreement_not_found" || result === "not_monthly") {
    return { kind: "not_b2b" };
  }
  if (result === "cancelled") {
    return { kind: "cancelled", agreementId: String(settled.agreement_id ?? "") };
  }
  if (result === "already_cancelled") {
    return { kind: "already_cancelled", agreementId: String(settled.agreement_id ?? "") };
  }
  return { kind: "failed", detail: result };
}
