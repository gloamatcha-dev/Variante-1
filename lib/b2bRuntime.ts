import type Stripe from "stripe";
import type { B2bInstalmentCharge } from "./b2bInstalmentRules.ts";
import {
  b2bInstalmentInvoiceIdempotencyKey,
  b2bInstalmentItemIdempotencyKey,
  buildB2bInstalmentInvoiceParams,
  buildB2bInstalmentItemParams,
  resolveInstalmentPaymentMethod,
  verifyB2bInstalmentDraft,
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
  /**
   * The PaymentMethod that settled instalment 1, and the Customer it
   * belongs to. Read from the authoritative PaymentIntent whose id
   * migration 062 stored on instalment 1 at activation.
   */
  firstInstalmentPaymentIntent: (agreementId: string)
    => Promise<{ customer?: unknown; payment_method?: unknown } | null>;
  /** Read a draft back, WITH ITS LINES, before finalizing it. */
  retrieveInvoiceWithLines: (invoiceId: string) => Promise<Stripe.Invoice>;
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
 * Bring one instalment's Stripe invoice to the intended collecting state.
 *
 * SHARED BY BOTH PASSES - the first-time invoicer below and the recovery
 * pass after it - because "make sure this draft is right and then
 * finalize it" is the same question whether the draft was created a
 * second ago or a day ago. One implementation means the two cannot
 * disagree.
 *
 * ── IT READS THE DRAFT BACK BEFORE IT CHARGES ANYBODY ─────────
 *
 * This is the step whose absence caused the original defect. A stubbed
 * createInvoiceItem returning an id says nothing about whether the line
 * reached the invoice; only the invoice itself does. So it is retrieved
 * WITH ITS LINES and refused unless it holds exactly one line, for the
 * exact gross, in the expected currency, carrying this instalment's
 * metadata.
 *
 * ── AND EVERY NON-DRAFT STATE IS ANSWERED, NOT ASSUMED ────────
 *
 *   draft                 ensure the item, verify, finalize
 *   open / paid           already collecting or collected. Nothing to do,
 *                         and NEVER a second invoice.
 *   void / uncollectible  FAIL CLOSED and report. Stripe has given up or
 *                         somebody voided it, and neither is something a
 *                         scheduled job should paper over by issuing a
 *                         replacement charge.
 */
export async function ensureB2bInstalmentCollecting(
  deps: B2bInstalmentDeps,
  input: {
    agreementId: string;
    instalmentNumber: number;
    instalmentCount: number;
    stripeCustomerId: string;
    currency: string;
    charge: B2bInstalmentCharge;
    stripeInvoiceId: string;
  }
): Promise<{ kind: "finalized" | "already_collecting" | "refused"; detail?: string }> {
  const invoice = await deps.retrieveInvoiceWithLines(input.stripeInvoiceId);

  if (invoice.status === "open" || invoice.status === "paid") {
    return { kind: "already_collecting", detail: invoice.status };
  }
  if (invoice.status === "void" || invoice.status === "uncollectible") {
    return { kind: "refused", detail: `invoice is ${invoice.status}` };
  }
  if (invoice.status !== "draft") {
    return { kind: "refused", detail: `invoice is ${invoice.status ?? "unknown"}` };
  }

  // The line is created only if the draft does not already hold it. The
  // deterministic idempotency key makes a repeat harmless, but skipping
  // the call when the line is already there keeps a retry from depending
  // on Stripe replaying a key that may have expired.
  let verdict = verifyB2bInstalmentDraft(invoice, input);
  if (!verdict.ok) {
    const lines = invoice.lines?.data ?? [];
    if (lines.length > 1) {
      // Something else reached this invoice. Adding another line would
      // make it worse, and finalizing would charge for both.
      return { kind: "refused", detail: verdict.reason };
    }
    await deps.createInvoiceItem(
      buildB2bInstalmentItemParams({ ...input, invoiceId: input.stripeInvoiceId }),
      {
        idempotencyKey: b2bInstalmentItemIdempotencyKey(
          input.agreementId, input.instalmentNumber
        ),
      }
    );
    const reread = await deps.retrieveInvoiceWithLines(input.stripeInvoiceId);
    verdict = verifyB2bInstalmentDraft(reread, input);
    if (!verdict.ok) {
      // NOT FINALIZED. Nobody is charged and the draft can be inspected.
      return { kind: "refused", detail: verdict.reason };
    }
  }

  await deps.finalizeInvoice(input.stripeInvoiceId);
  return { kind: "finalized" };
}

/** The Stripe facts one instalment needs before it can be invoiced. */
async function instalmentContext(
  deps: B2bInstalmentDeps,
  row: B2bDueInstalment
): Promise<
  | { ok: true; stripeCustomerId: string; instalmentCount: number;
      defaultPaymentMethodId: string; charge: B2bInstalmentCharge }
  | { ok: false; reason: string }
> {
  const stripeCustomerId = await deps.findStripeCustomerId(row.user_id);
  if (!stripeCustomerId) {
    // The canonical mapping has no row. Inventing a Customer here would
    // be inventing a second identity for the same business.
    return { ok: false, reason: "no canonical stripe customer" };
  }

  const instalmentCount = await deps.instalmentCountFor(row.agreement_id);
  if (!instalmentCount) {
    return { ok: false, reason: "agreement has no instalment count" };
  }

  // ── THE PAYMENT METHOD IS PROVED, NOT ASSUMED ───────────────
  const intent = await deps.firstInstalmentPaymentIntent(row.agreement_id);
  if (!intent) {
    return { ok: false, reason: "instalment 1 has no recorded PaymentIntent" };
  }
  const pm = resolveInstalmentPaymentMethod(intent, stripeCustomerId);
  if (!pm.ok) {
    return { ok: false, reason: pm.reason };
  }

  return {
    ok: true,
    stripeCustomerId,
    instalmentCount,
    defaultPaymentMethodId: pm.paymentMethodId,
    charge: deps.chargeFor(row.net_cents),
  };
}

/**
 * Invoices every annual instalment that is due.
 *
 * ── THE ORDER, AND WHY IT IS THIS ONE ────────────────────────
 *
 *   1. INVOICE first, as a draft   (deterministic idempotency key)
 *   2. ITEM, bound to that invoice (deterministic idempotency key)
 *   3. RECORD the correlation in the database
 *   4. READ THE DRAFT BACK, verify it, and finalize
 *
 * The invoice comes FIRST because an InvoiceItem with no invoice id is a
 * PENDING item on the Customer, and a standalone invoice does not pick
 * pending items up - pending_invoice_items_behavior defaults to
 * "exclude". The original order created the item first and produced an
 * EMPTY invoice; binding the item to a named draft is the documented fix,
 * and it also means no unrelated pending item can drift in.
 *
 * Nothing charges anybody until step 4, and step 4 refuses unless the
 * draft is exactly right. So every crash window leaves either no invoice,
 * or a draft that has collected nothing and can be completed by the
 * recovery pass.
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
      const context = await instalmentContext(deps, row);
      if (!context.ok) {
        outcome.kind = "skipped";
        outcome.detail = context.reason;
        summary.skipped += 1;
        summary.outcomes.push(outcome);
        continue;
      }

      const input = {
        agreementId: row.agreement_id,
        instalmentNumber: row.instalment_number,
        instalmentCount: context.instalmentCount,
        stripeCustomerId: context.stripeCustomerId,
        currency: row.currency,
        charge: context.charge,
      };

      // 1. THE DRAFT, before any line exists.
      const invoice = await deps.createInvoice(
        buildB2bInstalmentInvoiceParams({
          ...input,
          defaultPaymentMethodId: context.defaultPaymentMethodId,
        }),
        { idempotencyKey: b2bInstalmentInvoiceIdempotencyKey(row.agreement_id, row.instalment_number) }
      );
      if (!invoice.id) {
        outcome.detail = "stripe returned an invoice with no id";
        summary.failed += 1;
        summary.outcomes.push(outcome);
        continue;
      }

      // 2. THE LINE, bound to that draft by id.
      await deps.createInvoiceItem(
        buildB2bInstalmentItemParams({ ...input, invoiceId: invoice.id }),
        { idempotencyKey: b2bInstalmentItemIdempotencyKey(row.agreement_id, row.instalment_number) }
      );

      // 3. THE CORRELATION, before anything can be collected.
      const recorded = await deps.recordInvoice({
        agreementId: row.agreement_id,
        instalmentNumber: row.instalment_number,
        stripeInvoiceId: invoice.id,
      });

      if (recorded.result !== "invoiced" && recorded.result !== "already_invoiced") {
        // NOT FINALIZED. The database refused, so nobody is charged and
        // the draft stays a draft.
        outcome.kind = "skipped";
        outcome.detail = recorded.result;
        summary.skipped += 1;
        summary.outcomes.push(outcome);
        continue;
      }

      // 4. VERIFY, then collect.
      const ensured = await ensureB2bInstalmentCollecting(deps, {
        ...input, stripeInvoiceId: invoice.id,
      });
      if (ensured.kind === "refused") {
        outcome.detail = ensured.detail;
        summary.failed += 1;
        summary.outcomes.push(outcome);
        continue;
      }

      outcome.kind = recorded.result === "already_invoiced" ? "already_invoiced" : "invoiced";
      if (outcome.kind === "already_invoiced") summary.alreadyInvoiced += 1;
      else summary.invoiced += 1;
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

/* ── Package 5D: THE RECOVERY PASS ──────────────────────────── */

export type B2bUnfinalizedInstalment = B2bDueInstalment & {
  stripe_invoice_id: string;
};

export type B2bReconcileSummary = {
  candidates: number;
  finalized: number;
  alreadyCollecting: number;
  refused: number;
  failed: number;
  outcomes: Array<{
    agreementId: string; instalmentNumber: number;
    kind: "finalized" | "already_collecting" | "refused" | "failed"; detail?: string;
  }>;
};

export type B2bReconcileDeps = B2bInstalmentDeps & {
  listUnfinalized: (limit: number) => Promise<B2bUnfinalizedInstalment[]>;
};

/**
 * Finishes instalments whose Stripe invoice was correlated but never
 * reached collection.
 *
 * ── THE CRASH WINDOW THIS CLOSES ─────────────────────────────
 *
 * Once a row is `invoiced`, b2b_annual_instalments_due stops offering it
 * - correctly, because re-offering it would risk a second invoice. But
 * that meant a process dying between the database record and the finalize
 * stranded a DRAFT nobody would ever collect: the money was owed, the row
 * said invoiced, and no code path would look at it again.
 *
 * So 063 gained a SECOND read - b2b_annual_instalments_unfinalized - and
 * this pass drives it. It never creates an invoice: it retrieves the one
 * the row already names and brings it to the intended state through the
 * same shared helper the first pass uses.
 *
 * The row is NOT moved back to `scheduled`. That would be the obvious fix
 * and the wrong one: `scheduled` means "no Stripe object exists", so a
 * row whose invoice id is set would become eligible for a SECOND invoice.
 */
export async function runB2bInstalmentReconciliation(
  deps: B2bReconcileDeps,
  limit: number = B2B_INSTALMENT_BATCH_LIMIT
): Promise<B2bReconcileSummary> {
  const summary: B2bReconcileSummary = {
    candidates: 0, finalized: 0, alreadyCollecting: 0, refused: 0, failed: 0, outcomes: [],
  };

  const rows = await deps.listUnfinalized(limit);
  summary.candidates = rows.length;

  for (const row of rows) {
    try {
      const context = await instalmentContext(deps, row);
      if (!context.ok) {
        summary.refused += 1;
        summary.outcomes.push({
          agreementId: row.agreement_id, instalmentNumber: row.instalment_number,
          kind: "refused", detail: context.reason,
        });
        continue;
      }

      const ensured = await ensureB2bInstalmentCollecting(deps, {
        agreementId: row.agreement_id,
        instalmentNumber: row.instalment_number,
        instalmentCount: context.instalmentCount,
        stripeCustomerId: context.stripeCustomerId,
        currency: row.currency,
        charge: context.charge,
        stripeInvoiceId: row.stripe_invoice_id,
      });

      if (ensured.kind === "finalized") summary.finalized += 1;
      else if (ensured.kind === "already_collecting") summary.alreadyCollecting += 1;
      else summary.refused += 1;

      summary.outcomes.push({
        agreementId: row.agreement_id, instalmentNumber: row.instalment_number,
        kind: ensured.kind, detail: ensured.detail,
      });
    } catch (err) {
      summary.failed += 1;
      summary.outcomes.push({
        agreementId: row.agreement_id, instalmentNumber: row.instalment_number,
        kind: "failed", detail: err instanceof Error ? err.message : "stripe or database error",
      });
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

export const emptyB2bReconcileSummary = (): B2bReconcileSummary =>
  ({ candidates: 0, finalized: 0, alreadyCollecting: 0, refused: 0, failed: 0, outcomes: [] });
