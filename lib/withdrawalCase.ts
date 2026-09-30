/**
 * WHAT A WITHDRAWAL CASE IS WORTH, AND WHO GETS TO DECIDE.
 *
 * The deadline engine (lib/withdrawalDeadline.ts) answers whether a
 * declaration was in time. This module answers everything that follows:
 * whether the goods come back, what - if anything - may be deducted,
 * and what the refund therefore is.
 *
 * ── THE ONE RULE THIS FILE EXISTS TO ENFORCE ─────────────────
 *
 * NO NUMBER A BROWSER SENDS IS EVER USED. Every figure below is
 * recomputed from the price the database froze at purchase and from an
 * administrator's explicit decision. A client may describe its goods;
 * it may not price them.
 *
 * ── WERTERSATZ IS NOT A FEE ──────────────────────────────────
 *
 * BGB 357a Abs. 1 lets the trader claim Wertersatz for a loss in value
 * caused by handling the goods beyond what was necessary to check them.
 * That is a compensation for a diminished thing, not a charge for
 * withdrawing. There is deliberately no concept in this file called a
 * fee, a penalty, or a processing charge, and the customer-facing word
 * is always "Wertersatz wegen Wertverlust".
 *
 * ── AND IT IS NOT A CONSUMPTION METER ────────────────────────
 *
 * Matcha has exactly two states: the seal is intact or it is not. There
 * is no grams-used, no percentage and no half-empty, because the moment
 * such a number exists somebody will multiply by it - and a
 * proportional-consumption deduction is not what 357a provides. An
 * opened tin is worth what an opened tin is worth.
 */

/* ── The goods ────────────────────────────────────────────────── */

/** The only two states Matcha has. */
export type SealState = "sealed_unopened" | "opened_seal_broken";

/** Whether we asked for the goods back. An ADMIN decision, never automatic. */
export type ReturnRequirement = "return_requested" | "return_not_required";

/** Where a case has got to. Mirrors migration 070's CHECK exactly. */
export type WithdrawalCaseState =
  | "submitted"
  | "under_review"
  | "awaiting_return"
  | "overdue_return"
  | "return_in_transit"
  | "return_received"
  | "opened_item_review"
  | "approved"
  | "refund_pending"
  | "refunded"
  | "rejected_late"
  | "closed";

export type RefundState =
  | "not_started"
  | "on_hold_awaiting_return"
  | "approved_for_payout"
  | "executed"
  | "failed";

/**
 * How long the consumer has to send the goods back: fourteen days from
 * declaring the withdrawal (BGB 357 Abs. 1). Used to mark a return
 * OVERDUE - which is a state, not a deduction.
 */
export const RETURN_WINDOW_DAYS = 14;

/* ── Wertersatz ───────────────────────────────────────────────── */

/**
 * What the server PROPOSES as the value loss for opened goods.
 *
 * THE PRICE COMES FROM THE PURCHASE, NOT FROM TODAY'S SHOP. Migration
 * 039 froze catalog_unit_gross_cents on the annual plan for exactly
 * this: the undiscounted retail price of that package at the moment it
 * was bought. A case from last year must be priced with last year's
 * figure, and reading the live catalogue would silently re-price
 * history every time the shop changes a number.
 *
 * SEALED GOODS PROPOSE NOTHING. An intact tin that comes back intact
 * has lost no value, so there is no deduction to discuss - and
 * returning 0 rather than null says that positively.
 *
 * WHAT COMES BACK IS A PROPOSAL. It is not applied, not stored as the
 * decision, and not shown to the customer as owed. An administrator
 * confirms or reduces it, and until they do, nothing is deducted.
 */
export function suggestedValueLossCents(input: {
  sealState: SealState;
  /** annual_plans.catalog_unit_gross_cents - the snapshot, not the live price. */
  catalogUnitGrossCentsAtPurchase: number;
  /** How many packages are affected. One delivery is one package. */
  packages?: number;
}): number {
  const { sealState, catalogUnitGrossCentsAtPurchase } = input;
  const packages = input.packages ?? 1;

  if (sealState === "sealed_unopened") return 0;

  if (!Number.isSafeInteger(catalogUnitGrossCentsAtPurchase)
      || catalogUnitGrossCentsAtPurchase <= 0) {
    throw new Error("suggestedValueLossCents requires the frozen catalog price in cents");
  }
  if (!Number.isSafeInteger(packages) || packages < 1) {
    throw new Error("suggestedValueLossCents requires a positive package count");
  }

  return catalogUnitGrossCentsAtPurchase * packages;
}

/**
 * Whether an administrator's confirmed figure is allowed at all.
 *
 * Bounded at both ends, server-side. Wertersatz cannot be negative, and
 * it cannot exceed the value of the goods it is compensating for - a
 * deduction larger than the thing is not compensation, it is a charge
 * for withdrawing, which BGB 357a does not permit. It may be LOWER than
 * the proposal, which is the whole point of an administrator confirming
 * it rather than the server applying it.
 */
export function isConfirmableValueLoss(input: {
  confirmedCents: number;
  suggestedCents: number;
}): { ok: true } | { ok: false; reason: string } {
  const { confirmedCents, suggestedCents } = input;
  if (!Number.isSafeInteger(confirmedCents) || confirmedCents < 0) {
    return { ok: false, reason: "value loss must be a whole number of cents, never negative" };
  }
  if (confirmedCents > suggestedCents) {
    return {
      ok: false,
      reason: "value loss may be reduced but never raised above the goods' frozen retail value",
    };
  }
  return { ok: true };
}

/* ── The refund ───────────────────────────────────────────────── */

export interface RefundBreakdown {
  /** Everything the customer actually paid, from the order/plan row. */
  paidGrossCents: number;
  /** The goods component of that payment. */
  merchandiseGrossCents: number;
  /**
   * The ORIGINAL standard outbound delivery the customer paid us.
   *
   * BGB 357 Abs. 1 requires repaying payments INCLUDING delivery costs.
   * Only the supplement for a delivery type more expensive than our
   * cheapest standard offer may be kept - and GLOA offers exactly one
   * standard delivery, so there is no supplement and this is refunded
   * in full. It is NOT retained as a penalty, and there is no rule in
   * this file shaped like "keep the shipping".
   */
  outboundShippingGrossCents: number;
  /** What an administrator confirmed, or 0 while nothing is confirmed. */
  confirmedValueLossCents: number;
  /** paid - confirmed value loss, floored at zero. */
  refundGrossCents: number;
}

/**
 * What we owe back, computed from stored figures alone.
 *
 * RETURN POSTAGE DOES NOT APPEAR HERE, and its absence is deliberate.
 * BGB 357 Abs. 6 lets the consumer carry the DIRECT cost of sending the
 * goods back where they were told so before contracting - they pay the
 * carrier themselves. It is not our money, so it is not ours to deduct,
 * and a "return shipping" line in a refund breakdown would be exactly
 * the arbitrary deduction this must not contain.
 */
export function computeRefund(input: {
  paidGrossCents: number;
  merchandiseGrossCents: number;
  outboundShippingGrossCents: number;
  confirmedValueLossCents?: number | null;
}): RefundBreakdown {
  const {
    paidGrossCents,
    merchandiseGrossCents,
    outboundShippingGrossCents,
  } = input;

  for (const [name, v] of Object.entries({
    paidGrossCents, merchandiseGrossCents, outboundShippingGrossCents,
  })) {
    if (!Number.isSafeInteger(v) || v < 0) {
      throw new Error(`computeRefund requires a non-negative integer ${name}`);
    }
  }

  const confirmed = input.confirmedValueLossCents ?? 0;
  if (!Number.isSafeInteger(confirmed) || confirmed < 0) {
    throw new Error("computeRefund requires a non-negative integer confirmedValueLossCents");
  }

  // Floored, never negative: a value loss larger than the payment
  // cannot turn a refund into an invoice.
  const refund = Math.max(0, paidGrossCents - confirmed);

  return {
    paidGrossCents,
    merchandiseGrossCents,
    outboundShippingGrossCents,
    confirmedValueLossCents: confirmed,
    refundGrossCents: refund,
  };
}

/* ── The workflow ─────────────────────────────────────────────── */

export interface ReturnProgress {
  returnRequirement: ReturnRequirement | null;
  returnDispatchProofAt: string | null;
  returnReceivedAt: string | null;
  /** When the consumer declared - the return window runs from this. */
  declaredAt: string;
  /** Evaluated against this instant. */
  now: string;
}

/**
 * Whether the money may move yet.
 *
 * BGB 357 Abs. 4 lets the trader withhold repayment until the goods are
 * back OR the consumer has proved they sent them - whichever comes
 * first. That is a HOLD, and it is the only lever here.
 *
 * AN OVERDUE RETURN IS STILL ONLY A HOLD. When the fourteen days pass
 * with nothing sent, this reports 'overdue_return' and keeps the money
 * on hold. It does NOT deduct the goods' full price and pay out a
 * remainder: that would be a unilateral set-off dressed up as a refund,
 * and it would close a case that is still open.
 */
export function refundHoldState(p: ReturnProgress): {
  caseState: WithdrawalCaseState;
  refundState: RefundState;
  mayPayOut: boolean;
  reason: string;
} {
  // Nothing to wait for: we did not ask for the goods back.
  if (p.returnRequirement === "return_not_required") {
    return {
      caseState: "approved",
      refundState: "approved_for_payout",
      mayPayOut: true,
      reason: "no return was required, so there is nothing to wait for",
    };
  }

  if (p.returnReceivedAt) {
    return {
      caseState: "return_received",
      refundState: "approved_for_payout",
      mayPayOut: true,
      reason: "the goods are back",
    };
  }

  if (p.returnDispatchProofAt) {
    return {
      caseState: "return_in_transit",
      refundState: "approved_for_payout",
      mayPayOut: true,
      reason: "BGB 357 Abs. 4: proof of dispatch ends the right to withhold",
    };
  }

  const overdue = returnIsOverdue(p.declaredAt, p.now);
  return {
    caseState: overdue ? "overdue_return" : "awaiting_return",
    refundState: "on_hold_awaiting_return",
    mayPayOut: false,
    reason: overdue
      ? "the return window passed with no goods and no proof - still a hold, never an automatic deduction"
      : "waiting for the goods or for proof they were sent",
  };
}

/** Fourteen days from the declaration, on the calendar. */
export function returnIsOverdue(declaredAt: string, now: string): boolean {
  const start = new Date(declaredAt).getTime();
  const at = new Date(now).getTime();
  if (Number.isNaN(start) || Number.isNaN(at)) return false;
  return at > start + RETURN_WINDOW_DAYS * 86_400_000;
}

/* ── The freeze ───────────────────────────────────────────────── */

/**
 * Whether a case must stop the annual plan producing new deliveries.
 *
 * PROTECTED IS WIDER THAN TIMELY. A case we cannot safely reject -
 * receipt never recorded, or a last day we could not decide - freezes
 * exactly as a clearly timely one does. Shipping box four while still
 * arguing about whether box one arrived in time is the one outcome
 * nobody can undo afterwards.
 *
 * Only a case we can positively show to be late does not freeze.
 */
export function withdrawalProtectsFutureDeliveries(
  timeliness: "timely" | "late" | "receipt_unknown" | "deadline_uncertain"
): boolean {
  return timeliness !== "late";
}

/* ── The return-cost sentence ─────────────────────────────────── */

/**
 * The exact wording EGBGB Anlage 1 gives for the consumer carrying the
 * direct return costs, which may only be used where that information
 * was actually given before the contract was concluded.
 *
 * Pinned as a constant so the customer email, the /widerruf page and
 * the admin all quote the same sentence, and so a test can prove they
 * do. It belongs to WITHDRAWAL only - a defect complaint is BGB 439 and
 * the seller carries the transport, so this string must never appear in
 * a complaint surface.
 */
export const WITHDRAWAL_RETURN_COST_SENTENCE =
  "Sie tragen die unmittelbaren Kosten der Rücksendung der Waren.";
