/**
 * THE WIDERRUFSFRIST, COMPUTED THE WAY THE BGB COMPUTES IT.
 *
 * Fourteen days is not "delivered_at plus 14 x 24 hours". It is a
 * period in days over the CIVIL CALENDAR, and three sections decide
 * where it starts and where it ends:
 *
 *   § 187 Abs. 1   the day the event falls in is NOT counted
 *   § 188 Abs. 1   a period in days ends with the expiry of its last day
 *   § 193          if that last day is a Saturday, a Sunday or a
 *                  recognised general public holiday, it moves to the
 *                  next working day
 *
 * and § 356 Abs. 2 Nr. 1 decides which event starts it at all:
 *
 *   lit. a   ordinary sale        receipt of the goods
 *   lit. b   several goods, one   receipt of the LAST item
 *            order
 *   lit. d   REGULAR DELIVERY     receipt of the FIRST goods
 *            over a fixed period
 *
 * The annual plan is lit. d. Twelve deliveries over a fixed term is
 * exactly "regelmaessige Lieferung von Waren ueber einen festgelegten
 * Zeitraum", so the period runs from the FIRST box and the eleven
 * after it do not restart anything. Getting this wrong in the other
 * direction - restarting on each delivery - would quietly give a
 * thirteen-month withdrawal right; getting it wrong the other way, by
 * dating from the purchase, would end the right before the goods
 * arrived.
 *
 * WHY THIS MODULE REFUSES TO GUESS
 *
 * Every uncertain input resolves toward a human, never toward a
 * refusal. A wrongly refused withdrawal destroys a statutory right the
 * consumer cannot get back; a wrongly reviewed one costs an
 * administrator a minute. The two errors are not symmetric, so the
 * code is not symmetric either: there is no path through this file
 * that returns "late" from data it is not sure about.
 */

/* ── Civil dates ──────────────────────────────────────────────── */

/**
 * The Europe/Berlin calendar DAY an instant falls on.
 *
 * The receipt itself is stored as an exact instant, because it is
 * evidence. The deadline is a calendar question, so the instant has to
 * be read as a day somewhere - and it must be the same somewhere every
 * time, or a parcel received at 23:30 would start its period on
 * different days depending on which server asked.
 *
 * Berlin, because that is where the declaration is received and where
 * § 193's "staatlich anerkannter allgemeiner Feiertag am
 * Erklaerungsort" is judged.
 */
export function berlinCivilDate(instant: Date | string): string {
  const d = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(d.getTime())) {
    throw new Error("berlinCivilDate requires a valid instant");
  }
  // en-CA renders as YYYY-MM-DD, which is the format the rest of this
  // codebase passes around.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/**
 * N days later on the calendar.
 *
 * Deliberately UTC arithmetic on a date-only value: there is no clock
 * here, so there is no DST to get wrong. Adding 14 days to a date is
 * adding 14 days, even across the March and October changes that would
 * make a 24-hour-based version land an hour early and, at the wrong
 * time of day, a whole day early.
 */
export function addDays(isoDate: string, days: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) throw new Error("addDays requires a YYYY-MM-DD date");
  if (!Number.isSafeInteger(days)) throw new Error("addDays requires an integer day count");

  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(t + days * 86_400_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${String(d.getUTCFullYear()).padStart(4, "0")}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** 0 = Sunday … 6 = Saturday, for a date-only value. */
export function weekdayOf(isoDate: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) throw new Error("weekdayOf requires a YYYY-MM-DD date");
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay();
}

/* ── Feiertage ────────────────────────────────────────────────── */

/**
 * Easter Sunday, anonymous Gregorian algorithm.
 *
 * Four of the nine nationwide holidays hang off this date, so it is
 * computed rather than tabulated - a table would need a new release
 * every year, and a missing year would silently become "not a
 * holiday", which is the one direction this file must never fail in.
 */
export function easterSunday(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${year}-${pad(month)}-${pad(day)}`;
}

/**
 * The nine holidays that are general public holidays in EVERY German
 * Land. These can be decided without knowing where the declaration was
 * received, so they are safe to apply.
 */
export function nationwideHolidays(year: number): string[] {
  const easter = easterSunday(year);
  return [
    `${year}-01-01`,        // Neujahr
    addDays(easter, -2),    // Karfreitag
    addDays(easter, 1),     // Ostermontag
    `${year}-05-01`,        // Tag der Arbeit
    addDays(easter, 39),    // Christi Himmelfahrt
    addDays(easter, 50),    // Pfingstmontag
    `${year}-10-03`,        // Tag der Deutschen Einheit
    `${year}-12-25`,        // 1. Weihnachtstag
    `${year}-12-26`,        // 2. Weihnachtstag
  ];
}

/**
 * Days that are a general public holiday in SOME Laender only.
 *
 * § 193 asks whether the day is recognised at the Erklaerungsort, and
 * that is a fact about the consumer, not about us. Rather than guess a
 * Land, this module reports such a day as undecidable and lets a human
 * look - which can only ever extend a consumer's chance to be heard,
 * never shorten it.
 *
 * Easter Sunday and Whit Sunday are included because they are general
 * public holidays in Brandenburg, and because they are Sundays anyway
 * the practical effect is nil - they are listed for completeness
 * rather than left out as an exception somebody has to remember.
 */
export function regionalHolidayCandidates(year: number): string[] {
  const easter = easterSunday(year);
  return [
    `${year}-01-06`,        // Heilige Drei Koenige - BW, BY, ST
    `${year}-03-08`,        // Internationaler Frauentag - BE, MV
    easter,                 // Ostersonntag - BB
    addDays(easter, 49),    // Pfingstsonntag - BB
    addDays(easter, 60),    // Fronleichnam - BW, BY, HE, NW, RP, SL (+ teils SN, TH)
    `${year}-08-15`,        // Mariae Himmelfahrt - SL (+ teils BY)
    `${year}-09-20`,        // Weltkindertag - TH
    `${year}-10-31`,        // Reformationstag - BB, HB, HH, MV, NI, SN, ST, SH, TH
    `${year}-11-01`,        // Allerheiligen - BW, BY, NW, RP, SL
    bussUndBettag(year),    // Buss- und Bettag - SN
  ];
}

/**
 * Buss- und Bettag: the Wednesday before 23 November.
 *
 * Computed rather than tabulated for the same reason as Easter. It is
 * a public holiday in Sachsen only, so it lands in the regional list.
 */
export function bussUndBettag(year: number): string {
  // 23 November, then back up to the preceding Wednesday (weekday 3).
  const ref = `${year}-11-23`;
  const back = (weekdayOf(ref) + 4) % 7 || 7;
  return addDays(ref, -back);
}

export function isNationwideHoliday(isoDate: string): boolean {
  const year = Number(isoDate.slice(0, 4));
  return nationwideHolidays(year).includes(isoDate);
}

export function isRegionalHolidayCandidate(isoDate: string): boolean {
  const year = Number(isoDate.slice(0, 4));
  return regionalHolidayCandidates(year).includes(isoDate);
}

/* ── The period ───────────────────────────────────────────────── */

/** Which event under § 356 Abs. 2 Nr. 1 started the period. */
export type DeadlineBasis =
  | "single_delivery_receipt"
  | "first_delivery_receipt_regular_delivery"
  | "last_item_receipt"
  | "unknown";

/** What we are able to say about a declaration's timeliness. */
export type WithdrawalTimeliness =
  | "timely"
  | "late"
  | "receipt_unknown"
  | "deadline_uncertain";

export interface WithdrawalDeadline {
  /** The Berlin civil date the goods were received. */
  receiptDate: string;
  /** The last day on which a declaration is still in time. */
  deadlineDate: string;
  /** True when § 193 moved the last day off a Saturday/Sunday/holiday. */
  extendedByWorkingDayRule: boolean;
  /**
   * True when the last day landed on a day that is a public holiday in
   * some Laender but not all, so it cannot be decided without knowing
   * the Erklaerungsort.
   */
  uncertain: boolean;
}

/** The statutory fourteen days. */
export const WITHDRAWAL_PERIOD_DAYS = 14;

/**
 * The last day of the withdrawal period for a given receipt.
 *
 * § 187 Abs. 1 first: the day of receipt is not counted, so day one is
 * the day after. § 188 Abs. 1 then ends the period with the expiry of
 * the fourteenth such day - which is receipt + 14 on the calendar.
 *
 * § 193 last: if that day is a Saturday, a Sunday or a nationwide
 * holiday, it moves forward to the next working day, and keeps moving
 * if the day it landed on is one too - a Christmas Day on a Thursday
 * pushes past Boxing Day and the weekend to the Monday.
 */
export function withdrawalDeadlineFromReceipt(receipt: Date | string): WithdrawalDeadline {
  const receiptDate = berlinCivilDate(receipt);

  // § 187 Abs. 1 + § 188 Abs. 1 in one step: the event day is excluded,
  // so the fourteenth counted day is the calendar date fourteen days on.
  let day = addDays(receiptDate, WITHDRAWAL_PERIOD_DAYS);

  let extended = false;
  let uncertain = false;

  // § 193. Bounded rather than while(true): the longest real run of
  // consecutive non-working days in Germany is a handful, and a bound
  // means a bad holiday table can never hang the request.
  for (let guard = 0; guard < 10; guard += 1) {
    const wd = weekdayOf(day);
    if (wd === 0 || wd === 6 || isNationwideHoliday(day)) {
      day = addDays(day, 1);
      extended = true;
      continue;
    }
    // A weekday that is a holiday in some Laender only. We cannot
    // decide it here, and we will not decide it against the consumer.
    if (isRegionalHolidayCandidate(day)) {
      uncertain = true;
    }
    break;
  }

  return {
    receiptDate,
    deadlineDate: day,
    extendedByWorkingDayRule: extended,
    uncertain,
  };
}

/* ── The answer a case gets ───────────────────────────────────── */

export interface WithdrawalTimelinessInput {
  /**
   * The authoritative receipt instant, from orders.delivered_at. Null
   * when we never recorded one - which is a state, not an error.
   */
  receiptAt?: string | Date | null;
  /** When the consumer declared the withdrawal. */
  declaredAt: string | Date;
  /** Which § 356 Abs. 2 Nr. 1 case this contract is. */
  basis?: DeadlineBasis;
}

export interface WithdrawalTimelinessResult {
  timeliness: WithdrawalTimeliness;
  basis: DeadlineBasis;
  /** ISO instant, or null when receipt was never recorded. */
  startAt: string | null;
  /** Berlin civil date of receipt, or null. */
  startDate: string | null;
  /** Last day still in time, or null when it could not be computed. */
  deadlineDate: string | null;
  /** True whenever a human has to look before anything is refused. */
  requiresManualReview: boolean;
  /** Why this answer, in one machine-readable token. */
  reason:
    | "within_period"
    | "after_period"
    | "no_authoritative_receipt"
    | "regional_holiday_undecidable";
}

/**
 * Whether a declaration was in time - and, when that cannot be said
 * safely, that it cannot be said safely.
 *
 * THE ONLY PATH THAT RETURNS "late" is one where we hold an
 * authoritative receipt AND the last day was decidable AND the
 * declaration arrived after it. Everything else routes to a human with
 * requiresManualReview set.
 */
export function evaluateWithdrawalTimeliness(
  input: WithdrawalTimelinessInput
): WithdrawalTimelinessResult {
  const basis = input.basis ?? "unknown";

  // No recorded receipt. We may not claim the period ran, and we may
  // certainly not claim it expired: § 356 Abs. 2 never started.
  if (input.receiptAt === null || input.receiptAt === undefined) {
    return {
      timeliness: "receipt_unknown",
      basis,
      startAt: null,
      startDate: null,
      deadlineDate: null,
      requiresManualReview: true,
      reason: "no_authoritative_receipt",
    };
  }

  const receipt = input.receiptAt instanceof Date
    ? input.receiptAt
    : new Date(input.receiptAt);
  if (Number.isNaN(receipt.getTime())) {
    return {
      timeliness: "receipt_unknown",
      basis,
      startAt: null,
      startDate: null,
      deadlineDate: null,
      requiresManualReview: true,
      reason: "no_authoritative_receipt",
    };
  }

  const deadline = withdrawalDeadlineFromReceipt(receipt);
  const declaredDate = berlinCivilDate(input.declaredAt);

  // Undecidable last day. Report the computed date for the record, but
  // never conclude from it.
  if (deadline.uncertain) {
    return {
      timeliness: "deadline_uncertain",
      basis,
      startAt: receipt.toISOString(),
      startDate: deadline.receiptDate,
      deadlineDate: deadline.deadlineDate,
      requiresManualReview: true,
      reason: "regional_holiday_undecidable",
    };
  }

  // § 188 Abs. 1: the period ends with the EXPIRY of the last day, so a
  // declaration made ON that day is in time.
  if (declaredDate <= deadline.deadlineDate) {
    return {
      timeliness: "timely",
      basis,
      startAt: receipt.toISOString(),
      startDate: deadline.receiptDate,
      deadlineDate: deadline.deadlineDate,
      requiresManualReview: false,
      reason: "within_period",
    };
  }

  return {
    timeliness: "late",
    basis,
    startAt: receipt.toISOString(),
    startDate: deadline.receiptDate,
    deadlineDate: deadline.deadlineDate,
    // A late case is still reviewed before it is refused: § 356 Abs. 3
    // means the period never started at all if the consumer was not
    // properly informed, and this module cannot see that.
    requiresManualReview: true,
    reason: "after_period",
  };
}

/**
 * The receipt that starts the period for an annual plan.
 *
 * § 356 Abs. 2 Nr. 1 lit. d: the FIRST goods. Given the plan's
 * deliveries, this picks delivery number one and returns its order's
 * recorded receipt - and nothing else. Later deliveries are ignored
 * entirely rather than compared, so there is no code path in which
 * delivery seven can move a deadline.
 */
export function firstDeliveryReceiptOf(
  deliveries: ReadonlyArray<{ deliveryNumber: number; deliveredAt?: string | null }>
): { receiptAt: string | null; basis: DeadlineBasis } {
  const first = deliveries.find(d => d.deliveryNumber === 1);
  return {
    receiptAt: first?.deliveredAt ?? null,
    basis: "first_delivery_receipt_regular_delivery",
  };
}
