import type Stripe from "stripe";

/**
 * THE MONTHLY B2B CANCELLATION CUTOFF (Package 5G).
 *
 * A pure leaf. No Stripe client, no database, no clock of its own:
 * everything it needs is handed in, so the whole rule is testable
 * against fixed dates.
 *
 * ── THE RULE ──────────────────────────────────────────────────
 *
 *   cutoff = the next billing boundary MINUS 14 calendar days
 *
 *   request <= cutoff   the current period is the last one; the
 *                       agreement ends at that boundary
 *   request >  cutoff   one further period is owed; the agreement ends
 *                       at the FOLLOWING boundary
 *
 * The comparison is `<=`, so a request landing exactly on the cutoff is
 * IN TIME. A deadline the customer meets to the second is a deadline
 * they met.
 *
 * ── WHY THE BOUNDARY COMES FROM THE SUBSCRIPTION ITEM ─────────
 *
 * In the installed API version the billing period is NOT on the
 * Subscription any more. stripe 22.5.0 declares current_period_start and
 * current_period_end on SubscriptionItem (node_modules/stripe/cjs/
 * resources/SubscriptionItems.d.ts), and the Subscription's own list
 * filter documents itself in terms of "minimum item current_period_end"
 * - the item is the authority, and a Subscription can in principle carry
 * items on different periods.
 *
 * So the boundary is read off the items, and a B2B supply subscription
 * must have exactly one item: it is created as a single recurring line
 * (lib/b2bCheckout.ts, `line_items: [{ price, quantity: 1 }]`). More
 * than one item means something created a line this package does not
 * understand, and guessing which period governs the contract is not a
 * decision to make silently - so it fails closed.
 *
 * ── AND WHY THE ARITHMETIC IS CALENDAR, NOT MILLISECONDS ──────
 *
 * Two different pieces of calendar arithmetic are involved, and both are
 * done in Europe/Berlin - the convention migration 062 already pinned
 * for every B2B schedule date.
 *
 *   14 CALENDAR DAYS. Not 14 x 86_400_000. Germany changes clocks twice
 *   a year, so a fortnight spanning the last Sunday in March is 13 days
 *   and 23 hours of elapsed time, and one spanning the last Sunday in
 *   October is 14 days and 1 hour. Subtracting a fixed number of
 *   milliseconds would move a contractual deadline by an hour twice a
 *   year, in opposite directions, and that hour can decide whether a
 *   customer owes another month.
 *
 *   ONE CALENDAR MONTH, for the following boundary when a request is
 *   late. Stripe advances a monthly subscription by a calendar month
 *   with end-of-month clamping - 31 January bills again on 28 February -
 *   and this reproduces that rather than adding 30 days. Clamping never
 *   accumulates: the anchor stays the 31st, so the boundary after that
 *   one is 31 March again.
 *
 * B2C's four-weekly cadence is deliberately not reachable from here.
 */

/** The one zone every B2B schedule date is expressed in. */
export const B2B_TIME_ZONE = "Europe/Berlin";

/** Calendar days between the boundary and the cancellation deadline. */
export const B2B_CANCELLATION_NOTICE_DAYS = 14;

/* ── Europe/Berlin calendar arithmetic ──────────────────────── */

type BerlinParts = {
  year: number; month: number; day: number;
  hour: number; minute: number; second: number;
};

const BERLIN_PARTS = new Intl.DateTimeFormat("en-GB", {
  timeZone: B2B_TIME_ZONE,
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
  hour12: false,
});

/** What the clock on a Berlin wall reads at this instant. */
export function berlinPartsOf(instant: Date): BerlinParts {
  const parts: Record<string, string> = {};
  for (const p of BERLIN_PARTS.formatToParts(instant)) {
    if (p.type !== "literal") parts[p.type] = p.value;
  }
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    // 24 rather than 00 is what en-GB hour12:false emits at midnight.
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/** The Berlin offset in minutes at a given instant (+60 CET, +120 CEST). */
function berlinOffsetMinutes(instant: Date): number {
  const p = berlinPartsOf(instant);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60000);
}

/**
 * The instant at which a Berlin wall clock reads these parts.
 *
 * Solved rather than assumed: the offset depends on the answer, so a
 * first guess is made with a provisional offset and then corrected once
 * with the offset that actually applies at the guessed instant. One
 * correction is enough for a one-hour DST shift.
 *
 * A wall-clock time that does not exist (02:30 on the spring-forward
 * night) or that exists twice (02:30 in autumn) resolves deterministically
 * rather than throwing: these are period boundaries minus a whole number
 * of days, so the wall time is inherited from a real Stripe boundary and
 * the pathological half-hours simply do not arise in practice. Whatever
 * it lands on, it lands on the same instant every time it is computed,
 * which is the property the comparison needs.
 */
export function berlinInstant(p: BerlinParts): Date {
  const naive = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  let guess = new Date(naive - 60 * 60000);
  for (let i = 0; i < 2; i += 1) {
    const offset = berlinOffsetMinutes(guess);
    const next = new Date(naive - offset * 60000);
    if (next.getTime() === guess.getTime()) return guess;
    guess = next;
  }
  return guess;
}

/** The days in a Gregorian month, so a clamp does not need a table. */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * N calendar days earlier, keeping the Berlin wall-clock time.
 *
 * 14 days before 10:00 on 5 April is 10:00 on 22 March, whichever side
 * of the DST change each of them falls on - which is exactly what "14
 * calendar days" means to a customer reading a contract.
 */
export function berlinMinusDays(instant: Date, days: number): Date {
  const p = berlinPartsOf(instant);
  // Date arithmetic on the CALENDAR, in UTC where a day is always 24h,
  // then re-anchored to the Berlin wall clock. The intermediate UTC date
  // is a calendar helper and never an instant anybody sees.
  const shifted = new Date(Date.UTC(p.year, p.month - 1, p.day - days));
  return berlinInstant({
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: p.hour, minute: p.minute, second: p.second,
  });
}

/**
 * One calendar month later, clamped at the end of the month.
 *
 * 31 Jan -> 28 Feb (29 in a leap year), 31 Mar -> 30 Apr, 29 Feb -> 29 Mar.
 * The same rule PostgreSQL's make_interval(months => 1) applies, and the
 * same one migration 062 pinned for the B2B annual schedule.
 */
export function berlinPlusMonths(instant: Date, months: number): Date {
  const p = berlinPartsOf(instant);
  const targetMonthIndex = p.month - 1 + months;
  const year = p.year + Math.floor(targetMonthIndex / 12);
  const month = ((targetMonthIndex % 12) + 12) % 12 + 1;
  const day = Math.min(p.day, daysInMonth(year, month));
  return berlinInstant({
    year, month, day,
    hour: p.hour, minute: p.minute, second: p.second,
  });
}

/* ── The boundary, read off the authoritative Stripe object ── */

export type B2bBoundaryResult =
  | { ok: true; currentPeriodEnd: Date }
  | { ok: false; reason: string };

/**
 * The end of the subscription's current billing period.
 *
 * Read from the SUBSCRIPTION ITEM because that is where the installed
 * API version puts it, and from EXACTLY ONE item because a B2B supply
 * subscription is created with exactly one line. A subscription with two
 * items has two periods and no obvious governing one.
 */
export function b2bCurrentPeriodEnd(
  subscription: Pick<Stripe.Subscription, "items"> & { status?: string }
): B2bBoundaryResult {
  const items = subscription.items?.data ?? [];
  if (items.length === 0) {
    return { ok: false, reason: "the subscription has no items" };
  }
  if (items.length > 1) {
    return { ok: false, reason: `the subscription has ${items.length} items, expected one` };
  }
  const end = items[0].current_period_end;
  if (typeof end !== "number" || !Number.isFinite(end) || end <= 0) {
    return { ok: false, reason: "the subscription item has no current period end" };
  }
  return { ok: true, currentPeriodEnd: new Date(end * 1000) };
}

/* ── The cutoff itself ──────────────────────────────────────── */

export type B2bCancellationSchedule = {
  /** The boundary the current period ends on. */
  currentPeriodEnd: Date;
  /** currentPeriodEnd minus 14 calendar days, Europe/Berlin. */
  cutoff: Date;
  /** True when the request was in time for the current period. */
  inTime: boolean;
  /** The boundary the agreement actually ends on. */
  effectiveAt: Date;
  /** How many further billing periods the customer still owes: 0 or 1. */
  periodsOwed: 0 | 1;
};

/**
 * When does this cancellation take effect?
 *
 * `requestedAt` is the moment the customer asked, `currentPeriodEnd` the
 * authoritative Stripe boundary from b2bCurrentPeriodEnd above.
 *
 * A request AT the cutoff is in time (`<=`). A request one second later
 * owes one more period, and the effective date moves to the boundary a
 * calendar month after the current one - not 30 days, not 4 weeks.
 */
export function b2bCancellationSchedule(input: {
  requestedAt: Date;
  currentPeriodEnd: Date;
}): B2bCancellationSchedule {
  const { requestedAt, currentPeriodEnd } = input;
  const cutoff = berlinMinusDays(currentPeriodEnd, B2B_CANCELLATION_NOTICE_DAYS);
  const inTime = requestedAt.getTime() <= cutoff.getTime();
  return {
    currentPeriodEnd,
    cutoff,
    inTime,
    effectiveAt: inTime ? currentPeriodEnd : berlinPlusMonths(currentPeriodEnd, 1),
    periodsOwed: inTime ? 0 : 1,
  };
}

/** Unix seconds, which is what Stripe's cancel_at takes. */
export const unixSeconds = (d: Date): number => Math.floor(d.getTime() / 1000);

/**
 * Is Stripe already carrying the boundary we promised?
 *
 * Used by the reconcile pass. Compared in SECONDS because that is the
 * resolution Stripe stores; a millisecond difference is the same instant
 * as far as cancel_at is concerned.
 */
export function b2bCancelAtMatches(
  subscriptionCancelAt: number | null | undefined,
  effectiveAt: Date
): boolean {
  return typeof subscriptionCancelAt === "number"
    && subscriptionCancelAt === unixSeconds(effectiveAt);
}
