import type Stripe from "stripe";
import type { B2bInstalmentCharge } from "./b2bInstalmentRules.ts";
import {
  b2bInstalmentInvoiceIdempotencyKey,
  b2bInstalmentItemIdempotencyKey,
  buildB2bInstalmentInvoiceParams,
  buildB2bInstalmentItemParams,
} from "./b2bInstalmentRules.ts";
import {
  resolveB2bDeliveryRoute,
  type B2bResolvableAddress,
} from "./b2bDeliveryResolutionRules.ts";

/**
 * The B2B scheduled runtime (Packages 5D and 5E).
 *
 * Two bounded jobs, both injected end to end so the whole thing can be
 * driven with stubs: no Stripe object, no database, no network.
 *
 *   runB2bInstalmentInvoicing   due annual instalments 2..n -> invoices
 *   runB2bDeliveryResolution    unresolved slots -> Berlin routes
 *
 * ── NEITHER LOOPS UNTIL EMPTY ─────────────────────────────────
 *
 * Both make exactly one bounded pass, so a caller inside a serverless
 * request cannot be turned into an unbounded job by a backlog. That is
 * the same rule lib/annualDeliveryWorker.ts follows, and for the same
 * reason.
 *
 * ── AND NEITHER DISPATCHES ANYTHING ───────────────────────────
 *
 * No order is created, nothing is marked dispatched and no tracking
 * number is written. Resolution produces a ROUTE; fulfilment is a
 * decision nobody has made yet.
 */

/* ── Package 5D: the instalment invoicer ────────────────────── */

export type B2bDueInstalment = {
  agreement_id: string;
  payment_id: string;
  instalment_number: number;
  net_cents: number;
  due_at: string;
  user_id: string;
  currency: string;
};

export type B2bInstalmentOutcome = {
  agreementId: string;
  instalmentNumber: number;
  kind: "invoiced" | "already_invoiced" | "skipped" | "failed";
  detail?: string;
};

export type B2bInstalmentSummary = {
  due: number;
  invoiced: number;
  alreadyInvoiced: number;
  skipped: number;
  failed: number;
  outcomes: B2bInstalmentOutcome[];
};

export type B2bInstalmentDeps = {
  /** Migration 063's bounded work list. */
  listDue: (limit: number) => Promise<B2bDueInstalment[]>;
  /** The CANONICAL Stripe customer for a GLOA user (022/023 mapping). */
  findStripeCustomerId: (userId: string) => Promise<string | null>;
  /** lib/tax.ts, applied to the frozen net. */
  chargeFor: (netCents: number) => B2bInstalmentCharge;
  /** How many instalments the contract has, for the invoice description. */
  instalmentCountFor: (agreementId: string) => Promise<number | null>;
  createInvoiceItem: (
    params: Stripe.InvoiceItemCreateParams,
    options: { idempotencyKey: string }
  ) => Promise<Stripe.InvoiceItem>;
  createInvoice: (
    params: Stripe.InvoiceCreateParams,
    options: { idempotencyKey: string }
  ) => Promise<Stripe.Invoice>;
  finalizeInvoice: (invoiceId: string) => Promise<Stripe.Invoice>;
  /** Migration 063: scheduled -> invoiced, with derived tax facts. */
  recordInvoice: (input: {
    agreementId: string;
    instalmentNumber: number;
    stripeInvoiceId: string;
  }) => Promise<{ result: string }>;
};

export const B2B_INSTALMENT_BATCH_LIMIT = 25;

/**
 * Invoices every annual instalment that is due.
 *
 * ── THE ORDER IS THE CRASH-SAFETY ────────────────────────────
 *
 *   1. item    (deterministic idempotency key)
 *   2. invoice (deterministic idempotency key, auto_advance false)
 *   3. RECORD the correlation in the database
 *   4. finalize, which is what starts Stripe collecting
 *
 * Step 3 before step 4 is the whole design. If the process dies between
 * 2 and 3 the invoice exists in Stripe but is still a DRAFT that has
 * charged nobody, and the next run replays the same idempotency keys and
 * gets the same invoice back. If it dies between 3 and 4 the row is
 * correctly marked invoiced and the draft is finalized on a later pass -
 * never a second invoice, and never a charge this system has not
 * recorded.
 *
 * A row the database refuses (not due, already invoiced, wrong status)
 * is SKIPPED, not retried: 063 has already decided, and re-asking would
 * not change the answer.
 */
export async function runB2bInstalmentInvoicing(
  deps: B2bInstalmentDeps,
  limit: number = B2B_INSTALMENT_BATCH_LIMIT
): Promise<B2bInstalmentSummary> {
  const summary: B2bInstalmentSummary = {
    due: 0, invoiced: 0, alreadyInvoiced: 0, skipped: 0, failed: 0, outcomes: [],
  };

  const due = await deps.listDue(limit);
  summary.due = due.length;

  for (const row of due) {
    const outcome: B2bInstalmentOutcome = {
      agreementId: row.agreement_id,
      instalmentNumber: row.instalment_number,
      kind: "failed",
    };
    try {
      const customerId = await deps.findStripeCustomerId(row.user_id);
      if (!customerId) {
        // The canonical mapping has no row. Inventing a Customer here
        // would be inventing a second identity for the same business.
        outcome.kind = "skipped";
        outcome.detail = "no canonical stripe customer";
        summary.skipped += 1;
        summary.outcomes.push(outcome);
        continue;
      }

      const instalmentCount = await deps.instalmentCountFor(row.agreement_id);
      if (!instalmentCount) {
        outcome.kind = "skipped";
        outcome.detail = "agreement has no instalment count";
        summary.skipped += 1;
        summary.outcomes.push(outcome);
        continue;
      }

      const charge = deps.chargeFor(row.net_cents);
      const input = {
        agreementId: row.agreement_id,
        instalmentNumber: row.instalment_number,
        instalmentCount,
        stripeCustomerId: customerId,
        currency: row.currency,
        charge,
      };

      await deps.createInvoiceItem(
        buildB2bInstalmentItemParams(input),
        { idempotencyKey: b2bInstalmentItemIdempotencyKey(row.agreement_id, row.instalment_number) }
      );

      const invoice = await deps.createInvoice(
        buildB2bInstalmentInvoiceParams(input),
        { idempotencyKey: b2bInstalmentInvoiceIdempotencyKey(row.agreement_id, row.instalment_number) }
      );

      if (!invoice.id) {
        outcome.detail = "stripe returned an invoice with no id";
        summary.failed += 1;
        summary.outcomes.push(outcome);
        continue;
      }

      const recorded = await deps.recordInvoice({
        agreementId: row.agreement_id,
        instalmentNumber: row.instalment_number,
        stripeInvoiceId: invoice.id,
      });

      if (recorded.result === "already_invoiced") {
        // A concurrent run won. The draft is the same object, so
        // finalizing it is still correct and still idempotent.
        await deps.finalizeInvoice(invoice.id);
        outcome.kind = "already_invoiced";
        summary.alreadyInvoiced += 1;
        summary.outcomes.push(outcome);
        continue;
      }
      if (recorded.result !== "invoiced") {
        // NOT FINALIZED. The database refused, so nobody is charged: the
        // draft stays a draft and can be voided by hand if it ever
        // matters.
        outcome.kind = "skipped";
        outcome.detail = recorded.result;
        summary.skipped += 1;
        summary.outcomes.push(outcome);
        continue;
      }

      // ONLY NOW does Stripe start collecting - and from here dunning is
      // authoritative, which is the approved rule.
      await deps.finalizeInvoice(invoice.id);
      outcome.kind = "invoiced";
      summary.invoiced += 1;
      summary.outcomes.push(outcome);
    } catch (err) {
      outcome.detail = err instanceof Error ? err.message : "stripe or database error";
      summary.failed += 1;
      summary.outcomes.push(outcome);
      // One instalment's failure never stops the rest of the batch.
    }
  }

  return summary;
}

/* ── Package 5E: the delivery resolver ──────────────────────── */

export type B2bResolvableDelivery = {
  delivery_id: string;
  agreement_id: string;
  delivery_number: number;
  quantity_packs: number;
  scheduled_for: string;
  shipping_address_snapshot: B2bResolvableAddress | null;
};

export type B2bResolutionOutcome = {
  deliveryId: string;
  kind: "resolved" | "already_resolved" | "refused" | "failed";
  detail?: string;
};

export type B2bResolutionSummary = {
  candidates: number;
  resolved: number;
  alreadyResolved: number;
  /** Refused for a reason the system is supposed to refuse for. */
  refused: number;
  failed: number;
  /** Refusals grouped by reason, so a blocker is visible in the logs. */
  refusals: Record<string, number>;
  outcomes: B2bResolutionOutcome[];
};

export type B2bResolutionDeps = {
  listResolvable: (limit: number, horizonDays: number) => Promise<B2bResolvableDelivery[]>;
  resolveDelivery: (input: {
    deliveryId: string;
    addressSnapshot: Record<string, unknown>;
    berlinSnapshot: unknown;
    shippingClass: string;
    shippingSnapshot: unknown;
  }) => Promise<{ result: string }>;
};

export const B2B_RESOLUTION_BATCH_LIMIT = 50;

/**
 * How far ahead a slot is routed.
 *
 * Deliberately short. Resolution FREEZES the address, so routing a
 * delivery months early would freeze an address the customer has not
 * used yet and would defeat the rule that an address change affects the
 * next unresolved delivery. Fourteen days is long enough that a daily
 * cron always has time to route a slot before it is due, and short
 * enough that the customer keeps the ability to move.
 */
export const B2B_RESOLUTION_HORIZON_DAYS = 14;

/**
 * Routes every unresolved delivery slot that is close enough to be
 * routed - and refuses the ones this system cannot price.
 *
 * The refusal is not an error. Outside Berlin there is no measured
 * parcel and no approved customer shipping charge, so the honest outcome
 * is a slot that stays a slot; migration 060 already makes such a row
 * undispatchable, so nothing downstream can mistake it for ready.
 */
export async function runB2bDeliveryResolution(
  deps: B2bResolutionDeps,
  limit: number = B2B_RESOLUTION_BATCH_LIMIT,
  horizonDays: number = B2B_RESOLUTION_HORIZON_DAYS
): Promise<B2bResolutionSummary> {
  const summary: B2bResolutionSummary = {
    candidates: 0, resolved: 0, alreadyResolved: 0, refused: 0, failed: 0,
    refusals: {}, outcomes: [],
  };

  const candidates = await deps.listResolvable(limit, horizonDays);
  summary.candidates = candidates.length;

  for (const row of candidates) {
    const outcome: B2bResolutionOutcome = { deliveryId: row.delivery_id, kind: "failed" };
    try {
      if (!row.shipping_address_snapshot) {
        outcome.kind = "refused";
        outcome.detail = "agreement_has_no_address";
        summary.refused += 1;
        summary.refusals.agreement_has_no_address =
          (summary.refusals.agreement_has_no_address ?? 0) + 1;
        summary.outcomes.push(outcome);
        continue;
      }

      const route = resolveB2bDeliveryRoute({
        address: row.shipping_address_snapshot,
        packs: row.quantity_packs,
      });

      if (!route.ok) {
        outcome.kind = "refused";
        outcome.detail = route.reason;
        summary.refused += 1;
        summary.refusals[route.reason] = (summary.refusals[route.reason] ?? 0) + 1;
        summary.outcomes.push(outcome);
        continue;
      }

      const written = await deps.resolveDelivery({
        deliveryId: row.delivery_id,
        addressSnapshot: route.addressSnapshot,
        berlinSnapshot: route.berlinSnapshot,
        shippingClass: route.shippingClass,
        shippingSnapshot: route.shippingSnapshot,
      });

      if (written.result === "resolved") {
        outcome.kind = "resolved";
        summary.resolved += 1;
      } else if (written.result === "already_resolved") {
        outcome.kind = "already_resolved";
        summary.alreadyResolved += 1;
      } else {
        outcome.kind = "refused";
        outcome.detail = written.result;
        summary.refused += 1;
        summary.refusals[written.result] = (summary.refusals[written.result] ?? 0) + 1;
      }
      summary.outcomes.push(outcome);
    } catch (err) {
      outcome.detail = err instanceof Error ? err.message : "database error";
      summary.failed += 1;
      summary.outcomes.push(outcome);
    }
  }

  return summary;
}

export const emptyB2bInstalmentSummary = (): B2bInstalmentSummary =>
  ({ due: 0, invoiced: 0, alreadyInvoiced: 0, skipped: 0, failed: 0, outcomes: [] });

export const emptyB2bResolutionSummary = (): B2bResolutionSummary =>
  ({ candidates: 0, resolved: 0, alreadyResolved: 0, refused: 0, failed: 0,
     refusals: {}, outcomes: [] });
