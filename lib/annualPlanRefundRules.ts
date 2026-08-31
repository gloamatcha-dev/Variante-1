/**
 * Stripe refund truth for a prepaid annual plan: the correlation, the
 * order the steps happen in, and every refusal (Phase 4B7).
 *
 * A leaf: ZERO imports, no database client, no Stripe client, no clock,
 * no environment. Every effect is an INJECTED PORT, which is what lets
 * the whole flow be driven in a plain Node test - and what keeps it
 * loadable by the test runner at all, since Node cannot resolve this
 * repository's extension-less relative imports. Same shape as
 * lib/annualDeliveryWorker.ts and lib/annualPlanMaintenance.ts, for the
 * same reasons. The wiring lives in lib/annualPlanRefunds.ts.
 *
 * ── THE ANNUAL REFUND IDENTITY IS THE PARENT PaymentIntent ────
 *
 * annual_plans.stripe_payment_intent_id, and nothing else, ever. Not a
 * delivery order, not a delivery checkout attempt, not the customer, not
 * the email, not the SKU, not the amount, not the date and not a
 * subscription.
 *
 * That is not a preference, it is the only thing that can work. A
 * prepaid annual plan is ONE payment for thirteen boxes, and migration
 * 039's synthetic delivery attempts are created with no Stripe identity
 * at all - the CHECK constraint
 * checkout_attempts_annual_delivery_no_stripe_payment_check refuses one
 * that carries a PaymentIntent - so no annual delivery order carries the
 * money this refund is against. Walking from a delivery order back to
 * its plan would be inventing a link the schema deliberately does not
 * have, and correlating by customer or amount would eventually attach
 * one plan's refund to another plan's record.
 *
 * annual_plans_stripe_payment_intent_id_key makes the parent lookup
 * exact: at most one plan can ever carry a given intent.
 *
 * ── NOTHING IS TRUSTED BECAUSE IT ARRIVED IN AN EVENT ─────────
 *
 * The only thing taken from a refund webhook is WHICH PaymentIntent it
 * concerns. Every amount, every status and every currency is re-read
 * from Stripe afterwards, exactly as the one-time and subscription
 * refund paths already do, and the total handed to the database is the
 * ABSOLUTE cumulative total of that intent's settled refunds - never the
 * amount of the single Refund object the event happened to carry.
 *
 * That is what makes duplicate, retried and OUT-OF-ORDER deliveries safe:
 * the same Stripe state always produces the same answer, and an event
 * from an hour ago re-read now yields today's total rather than the
 * total that was true when it was emitted. A replay converges instead of
 * regressing, and it cannot double count.
 *
 * ── IT RECORDS MONEY. IT DECIDES NO LIFECYCLE. ────────────────
 *
 * This path never cancels a plan, never cancels, deletes or rewrites a
 * delivery row, never touches an order that already exists, never sends
 * a message and never issues a refund. Migration 039 owns what a total
 * means: zero is 'paid', the full total is 'refunded', anything between
 * is 'partially_refunded', and a partially refunded customer is still
 * owed every remaining box.
 *
 * The stop after a FULL refund is not implemented here either. It is
 * already implemented, twice, in the database: the claim function
 * refuses a plan whose payment_status is 'refunded', and the fulfillment
 * function re-proves that under the parent row lock it holds until the
 * order exists. A second application-level stop flag would be a second
 * answer to a question the database already answers.
 */

/* ── The writer's vocabulary ────────────────────────────────── */

/**
 * Every word public.apply_annual_plan_refund_state can return, read off
 * the installed function in migration 039 rather than assumed.
 *
 *   'invalid_input'   no usable intent, or a null/negative total. Refused
 *                     before the row is even locked.
 *   'plan_not_found'  no annual plan carries this intent. NOT an error:
 *                     it may belong to a one-time order or a subscription
 *                     cycle, both of which have their own writers.
 *   'not_applicable'  the plan was never paid, so it has no refund story.
 *   'invalid_amount'  the total exceeds the plan's own total_gross_cents.
 *                     NOTHING is written - see the note on clamping below.
 *   'unchanged'       the row already says exactly this. No UPDATE is
 *                     issued at all, so updated_at does not move and a
 *                     replay does not look like activity.
 *   'applied'         payment_status, refunded_total_cents and
 *                     refund_updated_at were written.
 *
 * The focused suite asserts this list against the migration source, so it
 * cannot drift from the function that actually runs.
 */
export const ANNUAL_REFUND_WRITER_RESULTS: readonly string[] = Object.freeze([
  "applied",
  "unchanged",
  "not_applicable",
  "invalid_amount",
  "plan_not_found",
  "invalid_input",
]);

/** The one word that means the parent row genuinely moved. */
export function annualRefundWriterWroteAChange(result: string): boolean {
  return result === "applied";
}

/**
 * Reads the writer's answer without trusting its shape, and FAILS CLOSED
 * on anything unrecognised.
 *
 * An unknown word is never treated as success and never as a harmless
 * no-op: the caller throws on it, because a database answering something
 * this file has never heard of is a reason to stop, not to guess.
 */
export function interpretAnnualRefundWriterResult(data: unknown): string {
  const result = typeof data === "string" ? data.trim() : "";
  if (!result) return "unknown";
  return ANNUAL_REFUND_WRITER_RESULTS.includes(result) ? result : "unknown";
}

/* ── The ports ──────────────────────────────────────────────── */

/**
 * The three columns the correlation needs, and no more.
 *
 * The currency is the plan's OWN frozen currency, which is what the
 * refunds are checked against - never a hardcoded 'eur' here. The total
 * is read only so a caller can report what was compared; the authority
 * on whether a total is impossible is the database, which re-reads it
 * under the row lock.
 */
export type AnnualRefundPlanRow = {
  id: string;
  currency: string;
  total_gross_cents: number;
};

/** What the shared refund summariser answers. Structural, not imported. */
export type AnnualRefundSummaryLike =
  | { ok: true; refundedTotalCents: number; hasPendingRefund: boolean }
  | { ok: false; reason: string };

export type AnnualRefundPorts = {
  /**
   * annual_plans WHERE stripe_payment_intent_id = $1. The ONLY annual
   * money correlation there is.
   */
  findPlanByPaymentIntent: (paymentIntentId: string) => Promise<AnnualRefundPlanRow | null>;
  /**
   * Stripe's CURRENT refund list for that intent, re-read now. Never the
   * event's embedded refund, and never a locally accumulated tally.
   */
  listRefunds: (paymentIntentId: string) => Promise<unknown[]>;
  /**
   * The SHARED summariser (lib/stripeRefunds.ts), injected rather than
   * reimplemented: settled refunds only, currency proved against the
   * plan's own, and any unrecognised status refuses the whole summary.
   */
  summarizeRefunds: (refunds: unknown[], expectedCurrency: string) => AnnualRefundSummaryLike;
  /** public.apply_annual_plan_refund_state(text, integer). */
  applyRefundState: (input: {
    paymentIntentId: string;
    refundedTotalCents: number;
  }) => Promise<unknown>;
};

export type AnnualRefundSyncOutcome =
  /**
   * No annual plan carries this PaymentIntent. NOTHING was read from
   * Stripe and nothing was written; the caller falls through to the
   * existing one-time and subscription refund flow, unchanged.
   */
  | { kind: "not_annual" }
  /**
   * The intent belongs to an annual parent, and the database was asked.
   * `result` is one of the six words above.
   */
  | {
      kind: "annual";
      annualPlanId: string;
      result: string;
      refundedTotalCents: number;
      hasPendingRefund: boolean;
    };

/**
 * Records Stripe's refund truth against one annual plan.
 *
 * ── THE STEPS, AND WHY THEY ARE IN THIS ORDER ─────────────────
 *
 *   1. RESOLVE THE PARENT by PaymentIntent. First, because a
 *      PaymentIntent that belongs to no annual plan must cost nothing:
 *      no Stripe request is issued for an ordinary one-time refund.
 *   2. RE-READ THE REFUNDS from Stripe. Only after the intent is known
 *      to be an annual payment, and never from the event.
 *   3. SUMMARISE ABSOLUTELY, against the plan's own currency.
 *   4. HAND THE CUMULATIVE TOTAL to migration 039's writer, which locks
 *      the parent row and decides everything else.
 *
 * ── WHAT IT THROWS, AND WHAT IT RETURNS ───────────────────────
 *
 * A summary that cannot be trusted THROWS - an unrecognised refund
 * status, a currency that is not the plan's, an amount that is not a
 * non-negative integer. That is the same fail-closed choice
 * lib/orderRefunds.ts already makes for a one-time order, and it means
 * the webhook returns 500, the event is not recorded as processed, and
 * NO WRITER IS CALLED AT ALL. Nothing half-understood reaches a paid
 * contract.
 *
 * A word the writer answered that this file does not recognise throws
 * for the same reason.
 *
 * The six recognised words are RETURNED rather than thrown, including
 * 'invalid_amount'. A total larger than the plan's own is not a
 * transient condition that a redelivery would fix, and the important
 * half has already happened: the database refused to write it. It is
 * reported and logged, never clamped - clamping would silently convert
 * Stripe disagreeing with us into a plausible-looking refund state.
 */
export async function runAnnualPlanRefundSync(
  ports: AnnualRefundPorts,
  paymentIntentId: string
): Promise<AnnualRefundSyncOutcome> {
  const intent = typeof paymentIntentId === "string" ? paymentIntentId.trim() : "";
  if (!intent) return { kind: "not_annual" };

  const plan = await ports.findPlanByPaymentIntent(intent);
  if (!plan) return { kind: "not_annual" };

  const refunds = await ports.listRefunds(intent);

  // The plan's OWN currency. An annual plan is CHECKed to EUR by
  // migration 039, but the comparison still reads the row rather than
  // restating the constant: a refund in another currency against this
  // intent means the two disagree about what was paid, and that must
  // refuse rather than be rounded away.
  const summary = ports.summarizeRefunds(refunds, plan.currency);
  if (!summary.ok) {
    throw new Error(`annual refund sync: ${summary.reason}`);
  }

  // THE CUMULATIVE TOTAL, NOT THE LATEST REFUND. Two refunds of 5000 and
  // 3000 hand 8000 to the writer on the second event, never 3000 and
  // never 13000.
  //
  // AND IT IS NOT CLAMPED to the plan total. If Stripe reports more than
  // was ever charged, the database answers 'invalid_amount' and writes
  // nothing, which is the honest end state.
  const answer = await ports.applyRefundState({
    paymentIntentId: intent,
    refundedTotalCents: summary.refundedTotalCents,
  });

  const result = interpretAnnualRefundWriterResult(answer);
  if (result === "unknown") {
    throw new Error("annual refund sync: unrecognised writer result");
  }

  return {
    kind: "annual",
    annualPlanId: plan.id,
    result,
    refundedTotalCents: summary.refundedTotalCents,
    // Reported, never written: migration 039 gives the annual parent no
    // 'refund_pending' state, because no annual feature produces one.
    hasPendingRefund: summary.hasPendingRefund,
  };
}
