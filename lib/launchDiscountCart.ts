/**
 * THE LAUNCH DISCOUNT, APPLIED TO AN ACTUAL BASKET.
 *
 * lib/launchDiscount.ts owns the offer: the code, the window, the ten
 * percent, the rounding and the exact split. It deliberately knows
 * nothing about products, because a basket is a catalogue fact and that
 * module has no catalogue.
 *
 * This is the missing half, and it is still pure: which LINES the code
 * may touch, what the discount is worth on them, and what Stripe must
 * be charged per line so the frozen total is reachable to the cent. No
 * database, no clock, no Stripe, no environment - `nowMs` is an
 * argument, exactly as it is next door.
 *
 * ── NO IDENTITY ANYWHERE IN HERE ──────────────────────────────
 *
 * GLOALAUNCH10 is reusable: anybody who knows it may use it, as often
 * as they like while the window is open. So there is no customer in
 * this file, no email, no order history and no "has this person used it
 * before" - migration 057 removed the ledger that could have answered
 * that, and nothing here wants to ask.
 *
 * ── WHY AN ALLOWLIST AND NOT "NOT THE METAL CASE" ─────────────
 *
 * The same reason lib/subscriptionCheckoutRules.ts uses one: a fourth
 * SKU appearing in the catalogue must fail CLOSED. A deny-list grants
 * the discount to anything nobody remembered to exclude, which is the
 * wrong direction for money. The Metal Case is excluded by not being on
 * the list, and it would still be excluded if it were switched on
 * tomorrow.
 *
 * ── WHY THE SPLIT IS PER UNIT, NOT PER LINE ───────────────────
 *
 * Stripe is sent `unit_amount` and `quantity`, and charges their
 * product. A line of three tins carrying 450 cents of discount divides
 * evenly; a line of three tins carrying 449 does not, and no single
 * unit_amount can express it. So the discount is allocated over UNITS,
 * and a line whose units end up one cent apart becomes two Stripe line
 * items - at most two, because units of one line start from the same
 * price. The sum is exact by construction, which is what
 * lib/stripeFulfillment.ts's amount check requires.
 */

import {
  decideLaunchDiscount,
  LAUNCH_DISCOUNT_CODE,
  LAUNCH_DISCOUNT_PERCENT,
  splitDiscountAcrossLines,
  type DiscountRefusal,
} from "./launchDiscount.ts";

/**
 * The only SKUs GLOALAUNCH10 may reduce.
 *
 * Mirrored from the offer as announced. Subscriptions, the prepaid
 * annual plan and B2B never reach this module at all - they have their
 * own flows and their own attempts, and migration 056's
 * checkout_attempts_discount_one_time_only refuses a discount on any of
 * them at the database - so this list is about the one-time basket
 * only.
 */
export const LAUNCH_DISCOUNT_ELIGIBLE_SKUS: readonly string[] = Object.freeze([
  "GLOA-MATCHA-30G",
  "GLOA-MATCHA-50G",
  "GLOA-MATCHA-100G",
]);

export function isLaunchDiscountEligibleSku(sku: unknown): boolean {
  return typeof sku === "string" && LAUNCH_DISCOUNT_ELIGIBLE_SKUS.includes(sku);
}

/** One basket line, as the authoritative quote already describes it. */
export type DiscountableLine = {
  variantId: string;
  sku: string;
  quantity: number;
  unitGrossCents: number;
  lineGrossCents: number;
};

/**
 * `no_eligible_items` is this module's own: the code is real and the
 * window is open, but the basket holds nothing it applies to. Telling
 * the customer "ungültig" there would be a lie.
 */
export type CartDiscountRefusal = DiscountRefusal | "no_eligible_items";

export type CartDiscountPricing = {
  applies: true;
  code: typeof LAUNCH_DISCOUNT_CODE;
  percent: number;
  /** The merchandise the code may touch, before it is applied. */
  eligibleSubtotalGrossCents: number;
  /** What the code is worth, in whole cents, on the eligible lines. */
  discountGrossCents: number;
  /** Per input line, in input order. Zero on every excluded line. */
  lineDiscountGrossCents: number[];
  /** Per input line, what Stripe is charged for it. */
  discountedLineGrossCents: number[];
  /** The WHOLE basket after the discount - excluded lines included. */
  discountedSubtotalGrossCents: number;
};

export type CartDiscountDecision =
  | CartDiscountPricing
  | { applies: false; reason: CartDiscountRefusal };

/**
 * THE WHOLE BASKET DECISION.
 *
 * Deterministic: the same code, instant and basket always produce the
 * same cents, which is what lets the checkout recompute a frozen
 * attempt's discount and compare rather than trust.
 */
export function priceLaunchDiscountForCart(input: {
  code: unknown;
  nowMs: number;
  lines: readonly DiscountableLine[];
}): CartDiscountDecision {
  const eligible = input.lines.map((line) => isLaunchDiscountEligibleSku(line.sku));
  const eligibleSubtotalGrossCents = input.lines.reduce(
    (sum, line, index) => (eligible[index] ? sum + line.lineGrossCents : sum),
    0
  );

  const decision = decideLaunchDiscount({
    code: input.code,
    nowMs: input.nowMs,
    subtotalGrossCents: eligibleSubtotalGrossCents,
  });

  if (!decision.applies) {
    // The engine says "empty_basket" when there is nothing to discount.
    // With a real basket in hand this module can say the truer thing:
    // there is a basket, the code just does not apply to any of it.
    if (decision.reason === "empty_basket" && input.lines.length > 0) {
      return { applies: false, reason: "no_eligible_items" };
    }
    return { applies: false, reason: decision.reason };
  }

  const lineDiscountGrossCents = splitFrozenDiscountAcrossCart(
    input.lines,
    decision.discountGrossCents
  );

  const discountedLineGrossCents = input.lines.map(
    (line, index) => line.lineGrossCents - lineDiscountGrossCents[index]
  );

  return {
    applies: true,
    code: LAUNCH_DISCOUNT_CODE,
    percent: LAUNCH_DISCOUNT_PERCENT,
    eligibleSubtotalGrossCents,
    discountGrossCents: decision.discountGrossCents,
    lineDiscountGrossCents,
    discountedLineGrossCents,
    discountedSubtotalGrossCents: discountedLineGrossCents.reduce((sum, cents) => sum + cents, 0),
  };
}

/**
 * SPLITS A KNOWN DISCOUNT ACROSS A KNOWN BASKET.
 *
 * Used twice, which is the point of extracting it: once when the
 * discount is first decided, and once when a frozen attempt is settled
 * and the amount is no longer this request's to decide. Both produce
 * the same cents for the same basket, so a retry sends Stripe exactly
 * the line amounts the frozen total was built from.
 *
 * The split runs over the ELIGIBLE lines only, so an excluded line -
 * the Metal Case, or anything a future catalogue adds - cannot absorb a
 * cent of it.
 */
export function splitFrozenDiscountAcrossCart(
  lines: readonly DiscountableLine[],
  totalDiscountGrossCents: number
): number[] {
  const eligible = lines.map((line) => isLaunchDiscountEligibleSku(line.sku));
  const eligibleLineAmounts = lines
    .filter((_line, index) => eligible[index])
    .map((line) => line.lineGrossCents);
  const eligibleShares = splitDiscountAcrossLines(eligibleLineAmounts, totalDiscountGrossCents);

  const shares: number[] = [];
  let cursor = 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (eligible[index]) {
      shares.push(eligibleShares[cursor]);
      cursor += 1;
    } else {
      shares.push(0);
    }
  }
  return shares;
}

/**
 * A basket line as Stripe must be told about it.
 *
 * `sourceIndex` points back at the basket line this came from, so the
 * caller can copy the name, the SKU and the weight without this module
 * needing to know any of them.
 */
export type StripeDiscountedLine = {
  sourceIndex: number;
  quantity: number;
  unitGrossCents: number;
  lineGrossCents: number;
};

/**
 * TURNS A PER-LINE DISCOUNT INTO unit_amount × quantity, EXACTLY.
 *
 * A line of `q` units carrying `d` cents of discount gives every unit
 * `floor(d / q)` off, and the `d mod q` cents left over are taken off
 * one more unit each. So a line becomes either one Stripe line item (the
 * discount divided evenly, or there was none) or two, one cent apart.
 *
 * The cheaper group is emitted SECOND so the basket reads highest price
 * first, and so the output is deterministic rather than dependent on
 * how a sort happened to tie.
 *
 * Never negative: a per-unit discount larger than the unit price is
 * clamped, which the ten-percent offer cannot reach but a future one
 * might.
 */
export function allocateDiscountedStripeLines(
  lines: readonly DiscountableLine[],
  lineDiscountGrossCents: readonly number[]
): StripeDiscountedLine[] {
  const out: StripeDiscountedLine[] = [];

  lines.forEach((line, index) => {
    const quantity = line.quantity;
    if (quantity <= 0) return;

    const discount = Math.max(0, Math.min(lineDiscountGrossCents[index] ?? 0, line.lineGrossCents));

    if (discount === 0) {
      out.push({
        sourceIndex: index,
        quantity,
        unitGrossCents: line.unitGrossCents,
        lineGrossCents: line.unitGrossCents * quantity,
      });
      return;
    }

    const perUnit = Math.floor(discount / quantity);
    const remainder = discount - perUnit * quantity;
    const dearerQuantity = quantity - remainder;
    const dearerUnit = Math.max(0, line.unitGrossCents - perUnit);
    const cheaperUnit = Math.max(0, line.unitGrossCents - perUnit - 1);

    if (dearerQuantity > 0) {
      out.push({
        sourceIndex: index,
        quantity: dearerQuantity,
        unitGrossCents: dearerUnit,
        lineGrossCents: dearerUnit * dearerQuantity,
      });
    }
    if (remainder > 0) {
      out.push({
        sourceIndex: index,
        quantity: remainder,
        unitGrossCents: cheaperUnit,
        lineGrossCents: cheaperUnit * remainder,
      });
    }
  });

  return out;
}

/**
 * WHAT A CUSTOMER IS TOLD WHEN THE CODE DOES NOT APPLY.
 *
 * Five sentences, and they are the only thing that ever leaves the
 * server about a refused code. No database state, no Stripe id, no
 * attempt id, no internal word - and nothing about anybody else,
 * because with a reusable code there is nobody else to leak.
 */
export const LAUNCH_DISCOUNT_MESSAGES = Object.freeze({
  unknown_code: "Rabattcode ist ungültig.",
  not_yet_active: "Der Rabattcode ist noch nicht gültig.",
  expired: "Der Rabattcode ist abgelaufen.",
  no_eligible_items: "Für diese Produkte kann der Rabattcode nicht verwendet werden.",
  empty_basket: "Für diese Produkte kann der Rabattcode nicht verwendet werden.",
  unavailable: "Rabattcode konnte gerade nicht geprüft werden. Bitte versuche es erneut.",
} as const);

/** The one sentence this refusal earns. */
export function launchDiscountMessage(reason: CartDiscountRefusal | "unavailable"): string {
  return LAUNCH_DISCOUNT_MESSAGES[reason] ?? LAUNCH_DISCOUNT_MESSAGES.unavailable;
}
