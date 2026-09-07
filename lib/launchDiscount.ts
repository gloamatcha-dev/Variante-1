/**
 * THE LAUNCH DISCOUNT, AS ARITHMETIC.
 *
 * One shared code, ten percent, first order only, October 2026. This
 * module decides everything about it that can be decided from inputs
 * alone: whether a code is the code, whether an instant is inside the
 * window, what the discount is worth, and how it is split across the
 * lines of a basket.
 *
 * ── IT IS APPLIED BEFORE STRIPE EVER SEES A NUMBER ────────────
 *
 * This repository prices server-side and then holds Stripe to it: the
 * checkout attempt freezes `expected_total_gross_cents`, and
 * lib/stripeFulfillment.ts REFUSES TO FULFIL an order whose
 * `amount_total` differs from it by a single cent. That check is the
 * reason a discount cannot be a Stripe promotion code entered at the
 * till - the customer would pay a reduced amount, the comparison would
 * fail, and the order would never be created.
 *
 * So the discount is computed here, folded into the line amounts, and
 * the frozen total is the DISCOUNTED total. The amount check stays
 * exactly as strict as it was; nothing about it is relaxed.
 *
 * ── THE WINDOW HAS A TIMEZONE TRAP IN IT ──────────────────────
 *
 * 01.10.2026 12:00 Europe/Berlin is CEST, +02:00, so 10:00Z.
 * 31.10.2026 23:59 Europe/Berlin is CET, +01:00, so 22:59Z -
 *
 * because the clocks go back on Sunday 25 October 2026. Writing both
 * ends with +02:00 would extend the code by an hour past its announced
 * expiry; writing both with +01:00 would open it an hour early. Both
 * offsets are therefore written explicitly and asserted in the suite,
 * rather than derived from a local-time string that would mean whatever
 * the server's timezone happens to be.
 *
 * ── PURE ──────────────────────────────────────────────────────
 *
 * No clock, no database, no environment, no relative import. `now` is
 * an argument, so the boundaries can be tested to the millisecond, and
 * the suite can load this file directly under plain Node.
 */

/** The one code. Compared case-insensitively after trimming. */
export const LAUNCH_DISCOUNT_CODE = "GLOALAUNCH10";

/** Ten percent. Integer, so no float ever enters the arithmetic. */
export const LAUNCH_DISCOUNT_PERCENT = 10;

/** 01.10.2026, 12:00 Europe/Berlin (CEST, +02:00). */
export const LAUNCH_DISCOUNT_FROM_ISO = "2026-10-01T12:00:00+02:00";

/**
 * 31.10.2026, 23:59:59.999 Europe/Berlin (CET, +01:00 - the clocks went
 * back on 25 October). Inclusive: the announced wording is "bis
 * einschließlich 31.10.2026, 23:59 Uhr".
 */
export const LAUNCH_DISCOUNT_UNTIL_ISO = "2026-10-31T23:59:59.999+01:00";

export const LAUNCH_DISCOUNT_FROM_MS = Date.parse(LAUNCH_DISCOUNT_FROM_ISO);
export const LAUNCH_DISCOUNT_UNTIL_MS = Date.parse(LAUNCH_DISCOUNT_UNTIL_ISO);

/** How the code is printed to a customer. Display only. */
export const LAUNCH_DISCOUNT_LABEL = "10 % auf deine erste Bestellung";

/** Normalises what a customer typed. Trimmed, upper-cased, nothing else. */
export function normalizeDiscountCode(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().toUpperCase() : "";
}

export function isLaunchDiscountCode(raw: unknown): boolean {
  return normalizeDiscountCode(raw) === LAUNCH_DISCOUNT_CODE;
}

/**
 * Is this instant inside the announced window?
 *
 * Half-open at neither end: the start is inclusive (12:00:00.000 counts)
 * and so is the end (23:59:59.999 counts). Before the start the code
 * does not exist yet - which is what "darf vor dem Launch nicht
 * einlösbar sein" means in code rather than in a runbook.
 */
export function isWithinLaunchDiscountWindow(
  nowMs: number,
  fromMs: number = LAUNCH_DISCOUNT_FROM_MS,
  untilMs: number = LAUNCH_DISCOUNT_UNTIL_MS
): boolean {
  if (!Number.isFinite(nowMs)) return false;
  return nowMs >= fromMs && nowMs <= untilMs;
}

/** Why a code was refused. Each maps to a message the customer can act on. */
export type DiscountRefusal =
  | "unknown_code"
  | "not_yet_active"
  | "expired"
  | "not_first_order"
  | "empty_basket";

export type DiscountDecision =
  | { applies: true; percent: number; discountGrossCents: number }
  | { applies: false; reason: DiscountRefusal };

/**
 * THE WHOLE DECISION, in one place.
 *
 * `isFirstOrder` is supplied by the caller because answering it needs a
 * database, and this module does not have one. What matters here is
 * that the answer is REQUIRED: there is no default, so a caller cannot
 * accidentally grant the discount by forgetting to check.
 */
export function decideLaunchDiscount(input: {
  code: unknown;
  nowMs: number;
  subtotalGrossCents: number;
  isFirstOrder: boolean;
}): DiscountDecision {
  if (!isLaunchDiscountCode(input.code)) return { applies: false, reason: "unknown_code" };

  if (!Number.isSafeInteger(input.subtotalGrossCents) || input.subtotalGrossCents <= 0) {
    return { applies: false, reason: "empty_basket" };
  }

  if (input.nowMs < LAUNCH_DISCOUNT_FROM_MS) return { applies: false, reason: "not_yet_active" };
  if (input.nowMs > LAUNCH_DISCOUNT_UNTIL_MS) return { applies: false, reason: "expired" };

  if (!input.isFirstOrder) return { applies: false, reason: "not_first_order" };

  return {
    applies: true,
    percent: LAUNCH_DISCOUNT_PERCENT,
    discountGrossCents: discountGrossCents(input.subtotalGrossCents),
  };
}

/**
 * Ten percent of a gross subtotal, in whole cents.
 *
 * Rounded HALF UP, and computed on the subtotal once rather than per
 * line - the split comes afterwards. Rounding each line first and
 * summing would give a different, smaller total on baskets with several
 * odd amounts, and the customer should get the discount on what they
 * actually spend.
 */
export function discountGrossCents(
  subtotalGrossCents: number,
  percent: number = LAUNCH_DISCOUNT_PERCENT
): number {
  return Math.floor((subtotalGrossCents * percent + 50) / 100);
}

/**
 * SPLITTING THE DISCOUNT ACROSS THE LINES, EXACTLY.
 *
 * Stripe is sent line items, not a basket total, so the discount has to
 * live inside the per-line amounts. Two things must hold and they fight
 * each other:
 *
 *   1. The discounted lines must sum to EXACTLY
 *      subtotal - discountGrossCents. One cent of drift and
 *      lib/stripeFulfillment.ts refuses the order.
 *   2. No line may go negative, and each should carry roughly its
 *      proportional share.
 *
 * Largest-remainder does both. Each line gets the floor of its
 * proportional share; the cents left over by flooring are handed out one
 * each to the lines with the largest discarded fraction, biggest first.
 * The result is deterministic - the same basket always splits the same
 * way - and it sums exactly by construction.
 *
 * Ties are broken by index so the output never depends on sort
 * stability.
 */
export function splitDiscountAcrossLines(
  lineGrossCents: readonly number[],
  totalDiscountGrossCents: number
): number[] {
  const subtotal = lineGrossCents.reduce((sum, cents) => sum + cents, 0);
  if (subtotal <= 0 || totalDiscountGrossCents <= 0) return lineGrossCents.map(() => 0);

  // A discount that would take the whole basket is clamped rather than
  // allowed to produce negative lines.
  const total = Math.min(totalDiscountGrossCents, subtotal);

  const exact = lineGrossCents.map((cents) => (cents * total) / subtotal);
  const shares = exact.map((value) => Math.floor(value));
  let remaining = total - shares.reduce((sum, value) => sum + value, 0);

  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => (b.fraction - a.fraction) || (a.index - b.index));

  for (let i = 0; i < order.length && remaining > 0; i += 1) {
    shares[order[i].index] += 1;
    remaining -= 1;
  }

  return shares;
}

export type DiscountedLine = {
  /** The line's gross amount before the discount. */
  originalGrossCents: number;
  /** What this line contributes to the discount. */
  discountGrossCents: number;
  /** What Stripe is charged for this line. Never negative. */
  netOfDiscountGrossCents: number;
};

/**
 * Applies a decided discount to a basket and returns lines that sum
 * exactly to the discounted subtotal.
 *
 * The caller passes the same line amounts it will send to Stripe, so
 * there is no second place where the split could be computed
 * differently.
 */
export function applyDiscountToLines(
  lineGrossCents: readonly number[],
  totalDiscountGrossCents: number
): { lines: DiscountedLine[]; discountedSubtotalGrossCents: number } {
  const shares = splitDiscountAcrossLines(lineGrossCents, totalDiscountGrossCents);
  const lines = lineGrossCents.map((cents, index) => ({
    originalGrossCents: cents,
    discountGrossCents: shares[index],
    netOfDiscountGrossCents: cents - shares[index],
  }));
  return {
    lines,
    discountedSubtotalGrossCents: lines.reduce((sum, line) => sum + line.netOfDiscountGrossCents, 0),
  };
}

/**
 * DOES THE DISCOUNT MOVE THE FREE-SHIPPING THRESHOLD?
 *
 * No, and this constant is here so the answer is written down rather
 * than implied by which variable a caller happens to pass.
 *
 * Shipping is free above a merchandise threshold
 * (lib/shipping.ts). If the threshold were measured on the DISCOUNTED
 * subtotal, a basket a few euros above it would lose free shipping
 * BECAUSE of the discount - the customer applies a ten percent code and
 * watches the total go up. That is the kind of surprise that produces
 * support mail and cancelled baskets.
 *
 * So the threshold is measured on the merchandise value the customer
 * chose, before the code. Stated as a constant because it is a
 * commercial decision, not an implementation detail, and somebody may
 * want to change it.
 */
export const FREE_SHIPPING_MEASURED_BEFORE_DISCOUNT = true;

/**
 * The window as a person reads it. Display only.
 *
 * Written out rather than formatted from the ISO strings, because a
 * runtime formatter would need a locale and a timezone at exactly the
 * moment this file refuses to have either. The suite asserts these
 * against the instants above, so they cannot drift from the window the
 * checkout actually enforces.
 */
export const LAUNCH_DISCOUNT_FROM_LABEL = "01.10.2026, 12:00 Uhr";
export const LAUNCH_DISCOUNT_UNTIL_LABEL = "31.10.2026, 23:59 Uhr";
