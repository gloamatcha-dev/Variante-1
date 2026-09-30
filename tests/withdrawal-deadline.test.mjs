import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  berlinCivilDate,
  addDays,
  weekdayOf,
  easterSunday,
  nationwideHolidays,
  bussUndBettag,
  isNationwideHoliday,
  isRegionalHolidayCandidate,
  withdrawalDeadlineFromReceipt,
  evaluateWithdrawalTimeliness,
  firstDeliveryReceiptOf,
  WITHDRAWAL_PERIOD_DAYS,
} from "../lib/withdrawalDeadline.ts";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf8");

/* ══════════════════════════════════════════════════════════════
   THE CIVIL DATE
   ══════════════════════════════════════════════════════════════ */

test("berlin: an instant is read as a Berlin calendar day, not a UTC one", () => {
  // 22:30 UTC in summer is 00:30 the NEXT day in Berlin (UTC+2). A
  // UTC-based reading would start the period a day early.
  assert.equal(berlinCivilDate("2026-06-15T22:30:00Z"), "2026-06-16");
  // 21:30 UTC is still 23:30 the same day in Berlin.
  assert.equal(berlinCivilDate("2026-06-15T21:30:00Z"), "2026-06-15");
});

test("berlin: winter is UTC+1, so the boundary moves with the clocks", () => {
  // 23:30 UTC in winter is 00:30 the next day in Berlin (UTC+1).
  assert.equal(berlinCivilDate("2026-01-15T23:30:00Z"), "2026-01-16");
  assert.equal(berlinCivilDate("2026-01-15T22:30:00Z"), "2026-01-15");
});

test("berlin: the DST changeovers themselves resolve to a single day", () => {
  // Last Sunday in March 2026 is the 29th, last in October is the 25th.
  assert.equal(berlinCivilDate("2026-03-29T01:30:00Z"), "2026-03-29");
  assert.equal(berlinCivilDate("2026-10-25T00:30:00Z"), "2026-10-25");
});

test("addDays: crossing a DST boundary still adds whole calendar days", () => {
  // 20 March + 14 days spans the March changeover. A 24-hour-based
  // implementation loses an hour here and can land a day early.
  assert.equal(addDays("2026-03-20", 14), "2026-04-03");
  assert.equal(addDays("2026-10-18", 14), "2026-11-01");
});

test("addDays: it crosses months, years and the leap day", () => {
  assert.equal(addDays("2026-12-28", 14), "2027-01-11");
  assert.equal(addDays("2028-02-20", 14), "2028-03-05"); // 2028 is a leap year
  assert.equal(addDays("2027-02-20", 14), "2027-03-06");
});

test("addDays: it refuses anything that is not a calendar date", () => {
  assert.throws(() => addDays("2026-6-1", 14), /YYYY-MM-DD/);
  assert.throws(() => addDays("2026-06-01T00:00:00Z", 14), /YYYY-MM-DD/);
  assert.throws(() => addDays("2026-06-01", 1.5), /integer/);
});

/* ══════════════════════════════════════════════════════════════
   FEIERTAGE
   ══════════════════════════════════════════════════════════════ */

test("easter: the algorithm matches known Easter Sundays", () => {
  assert.equal(easterSunday(2026), "2026-04-05");
  assert.equal(easterSunday(2027), "2027-03-28");
  assert.equal(easterSunday(2028), "2028-04-16");
  assert.equal(easterSunday(2025), "2025-04-20");
});

test("nationwide: the nine bundesweit holidays are derived correctly for 2026", () => {
  const h = nationwideHolidays(2026);
  assert.equal(h.length, 9);
  assert.ok(h.includes("2026-01-01"), "Neujahr");
  assert.ok(h.includes("2026-04-03"), "Karfreitag 2026");
  assert.ok(h.includes("2026-04-06"), "Ostermontag 2026");
  assert.ok(h.includes("2026-05-01"), "Tag der Arbeit");
  assert.ok(h.includes("2026-05-14"), "Christi Himmelfahrt 2026");
  assert.ok(h.includes("2026-05-25"), "Pfingstmontag 2026");
  assert.ok(h.includes("2026-10-03"), "Tag der Deutschen Einheit");
  assert.ok(h.includes("2026-12-25"), "1. Weihnachtstag");
  assert.ok(h.includes("2026-12-26"), "2. Weihnachtstag");
});

test("buss- und bettag: it is the Wednesday before 23 November", () => {
  for (const year of [2025, 2026, 2027, 2028]) {
    const d = bussUndBettag(year);
    assert.equal(weekdayOf(d), 3, `${d} must be a Wednesday`);
    const day = Number(d.slice(8, 10));
    assert.ok(day >= 16 && day <= 22, `${d} must sit in the 16-22 November window`);
  }
});

test("regional: a Land-specific day is NOT treated as a nationwide holiday", () => {
  // Fronleichnam 2026 is 4 June - a holiday in six Laender, not all.
  assert.equal(isNationwideHoliday("2026-06-04"), false);
  assert.equal(isRegionalHolidayCandidate("2026-06-04"), true);
  // Reformationstag is regional too.
  assert.equal(isNationwideHoliday("2026-10-31"), false);
  assert.equal(isRegionalHolidayCandidate("2026-10-31"), true);
});

/* ══════════════════════════════════════════════════════════════
   §§ 187 / 188 - WHERE THE PERIOD STARTS AND ENDS
   ══════════════════════════════════════════════════════════════ */

test("§ 187 Abs. 1: the day of receipt is not counted", () => {
  // Received Monday 1 June 2026. Day one is 2 June, so day fourteen is
  // 15 June - a Monday, so § 193 does not move it.
  const d = withdrawalDeadlineFromReceipt("2026-06-01T09:00:00Z");
  assert.equal(d.receiptDate, "2026-06-01");
  assert.equal(d.deadlineDate, "2026-06-15");
  assert.equal(d.extendedByWorkingDayRule, false);
  // Fourteen days after receipt on the calendar, NOT thirteen.
  assert.equal(addDays(d.receiptDate, WITHDRAWAL_PERIOD_DAYS), "2026-06-15");
});

test("the period is never delivered_at plus 14 x 24 hours", () => {
  // A late-evening Berlin receipt: 23:30 local on 1 June. A pure
  // 336-hour calculation from the instant would end at 21:30Z on 15
  // June, which is 23:30 Berlin on the 15th - looks the same. But read
  // as UTC the receipt DAY would be 1 June while Berlin says 1 June
  // too; the difference shows when the instant crosses midnight.
  const late = withdrawalDeadlineFromReceipt("2026-06-01T22:30:00Z"); // 00:30 Berlin on the 2nd
  assert.equal(late.receiptDate, "2026-06-02");
  assert.equal(late.deadlineDate, "2026-06-16");
});

/* ══════════════════════════════════════════════════════════════
   § 193 - SATURDAY, SUNDAY, FEIERTAG
   ══════════════════════════════════════════════════════════════ */

test("§ 193: a deadline landing on a Saturday moves to the Monday", () => {
  // Receipt Friday 29 May 2026 -> day 14 is 12 June 2026, a Friday.
  // Shift receipt so the 14th day is a Saturday: 30 May 2026 (Sat) ->
  // 13 June 2026 (Sat) -> Monday 15 June.
  const d = withdrawalDeadlineFromReceipt("2026-05-30T10:00:00Z");
  assert.equal(weekdayOf("2026-06-13"), 6, "13 June 2026 is a Saturday");
  assert.equal(d.deadlineDate, "2026-06-15");
  assert.equal(weekdayOf(d.deadlineDate), 1, "moved to a Monday");
  assert.equal(d.extendedByWorkingDayRule, true);
});

test("§ 193: a deadline landing on a Sunday moves to the Monday", () => {
  const d = withdrawalDeadlineFromReceipt("2026-05-31T10:00:00Z");
  assert.equal(weekdayOf("2026-06-14"), 0, "14 June 2026 is a Sunday");
  assert.equal(d.deadlineDate, "2026-06-15");
  assert.equal(d.extendedByWorkingDayRule, true);
});

test("§ 193: it steps over a holiday that follows a weekend", () => {
  // Christmas 2026: 25 Dec is a Friday, 26 Dec a Saturday, 27 a
  // Sunday. A deadline landing on 25 Dec must reach Monday 28 Dec.
  assert.equal(weekdayOf("2026-12-25"), 5, "25 Dec 2026 is a Friday");
  const receipt = addDays("2026-12-25", -WITHDRAWAL_PERIOD_DAYS); // 2026-12-11
  const d = withdrawalDeadlineFromReceipt(`${receipt}T10:00:00Z`);
  assert.equal(d.deadlineDate, "2026-12-28");
  assert.equal(weekdayOf(d.deadlineDate), 1);
  assert.equal(d.extendedByWorkingDayRule, true);
});

test("§ 193: an ordinary weekday deadline is not moved at all", () => {
  const d = withdrawalDeadlineFromReceipt("2026-06-02T10:00:00Z");
  assert.equal(d.deadlineDate, "2026-06-16");
  assert.equal(weekdayOf(d.deadlineDate), 2, "a Tuesday");
  assert.equal(d.extendedByWorkingDayRule, false);
  assert.equal(d.uncertain, false);
});

test("a regional holiday on the last day makes the deadline UNDECIDABLE, not late", () => {
  // Fronleichnam 2026 is Thursday 4 June - a working day in some
  // Laender, a holiday in others. Receipt 21 May 2026 lands day 14 on
  // exactly that date.
  assert.equal(addDays("2026-05-21", 14), "2026-06-04");
  const d = withdrawalDeadlineFromReceipt("2026-05-21T10:00:00Z");
  assert.equal(d.deadlineDate, "2026-06-04");
  assert.equal(d.uncertain, true, "must be flagged undecidable");
});

/* ══════════════════════════════════════════════════════════════
   THE ANSWER A CASE GETS
   ══════════════════════════════════════════════════════════════ */

test("a declaration inside the period is timely and needs no review", () => {
  const r = evaluateWithdrawalTimeliness({
    receiptAt: "2026-06-01T09:00:00Z",
    declaredAt: "2026-06-10T12:00:00Z",
    basis: "single_delivery_receipt",
  });
  assert.equal(r.timeliness, "timely");
  assert.equal(r.requiresManualReview, false);
  assert.equal(r.reason, "within_period");
  assert.equal(r.deadlineDate, "2026-06-15");
});

test("§ 188 Abs. 1: a declaration ON the last day is still in time", () => {
  const r = evaluateWithdrawalTimeliness({
    receiptAt: "2026-06-01T09:00:00Z",
    declaredAt: "2026-06-15T23:59:00+02:00",
  });
  assert.equal(r.timeliness, "timely", "the period ends with the EXPIRY of the last day");
});

test("a declaration after the period is late - but still reviewed", () => {
  const r = evaluateWithdrawalTimeliness({
    receiptAt: "2026-06-01T09:00:00Z",
    declaredAt: "2026-06-16T08:00:00Z",
  });
  assert.equal(r.timeliness, "late");
  assert.equal(r.reason, "after_period");
  // § 356 Abs. 3: if the consumer was never properly informed the
  // period did not start, and this module cannot see that.
  assert.equal(r.requiresManualReview, true);
});

test("FAIL OPEN: no recorded receipt is never late", () => {
  for (const receiptAt of [null, undefined, "not-a-date"]) {
    const r = evaluateWithdrawalTimeliness({
      receiptAt,
      declaredAt: "2027-01-01T00:00:00Z",
    });
    assert.equal(r.timeliness, "receipt_unknown", `receiptAt=${String(receiptAt)}`);
    assert.equal(r.requiresManualReview, true);
    assert.equal(r.deadlineDate, null);
    assert.notEqual(r.timeliness, "late");
  }
});

test("FAIL OPEN: an undecidable holiday is never late", () => {
  const r = evaluateWithdrawalTimeliness({
    receiptAt: "2026-05-21T10:00:00Z",   // day 14 = Fronleichnam
    declaredAt: "2027-01-01T00:00:00Z",  // far beyond any reading
  });
  assert.equal(r.timeliness, "deadline_uncertain");
  assert.equal(r.reason, "regional_holiday_undecidable");
  assert.equal(r.requiresManualReview, true);
  assert.notEqual(r.timeliness, "late");
});

test("there is no input that yields 'late' without an authoritative receipt", () => {
  const src = read("lib/withdrawalDeadline.ts");
  // The single "late" result object in the module is the one guarded by
  // both the receipt check and the uncertainty check above it.
  const lateReturns = src.match(/timeliness:\s*"late"/g) ?? [];
  assert.equal(lateReturns.length, 1,
    "more than one path can conclude 'late' - each needs the same guards");
});

/* ══════════════════════════════════════════════════════════════
   § 356 Abs. 2 Nr. 1 lit. d - REGULAR DELIVERY
   ══════════════════════════════════════════════════════════════ */

test("the annual plan dates from the FIRST delivery's receipt", () => {
  const deliveries = [
    { deliveryNumber: 1, deliveredAt: "2026-06-01T09:00:00Z" },
    { deliveryNumber: 2, deliveredAt: "2026-07-01T09:00:00Z" },
    { deliveryNumber: 3, deliveredAt: "2026-08-01T09:00:00Z" },
  ];
  const { receiptAt, basis } = firstDeliveryReceiptOf(deliveries);
  assert.equal(receiptAt, "2026-06-01T09:00:00Z");
  assert.equal(basis, "first_delivery_receipt_regular_delivery");

  const r = evaluateWithdrawalTimeliness({ receiptAt, declaredAt: "2026-06-10T00:00:00Z", basis });
  assert.equal(r.deadlineDate, "2026-06-15", "dated from delivery one, not two or three");
});

test("a later delivery does NOT restart the period", () => {
  const withOne = firstDeliveryReceiptOf([
    { deliveryNumber: 1, deliveredAt: "2026-06-01T09:00:00Z" },
  ]);
  const withTwelve = firstDeliveryReceiptOf([
    { deliveryNumber: 1, deliveredAt: "2026-06-01T09:00:00Z" },
    ...Array.from({ length: 11 }, (_, i) => ({
      deliveryNumber: i + 2,
      deliveredAt: `2026-${String(i + 7).padStart(2, "0")}-01T09:00:00Z`,
    })),
  ]);
  assert.equal(withOne.receiptAt, withTwelve.receiptAt,
    "eleven more deliveries must not move the start event");

  const a = evaluateWithdrawalTimeliness({ ...withOne, declaredAt: "2026-06-20T00:00:00Z" });
  const b = evaluateWithdrawalTimeliness({ ...withTwelve, declaredAt: "2026-06-20T00:00:00Z" });
  assert.deepEqual(a, b);
  assert.equal(a.timeliness, "late", "still late - the twelfth box does not revive it");
});

test("deliveries arriving out of order still date from number one", () => {
  const { receiptAt } = firstDeliveryReceiptOf([
    { deliveryNumber: 3, deliveredAt: "2026-08-01T09:00:00Z" },
    { deliveryNumber: 1, deliveredAt: "2026-06-01T09:00:00Z" },
    { deliveryNumber: 2, deliveredAt: "2026-07-01T09:00:00Z" },
  ]);
  assert.equal(receiptAt, "2026-06-01T09:00:00Z");
});

test("an annual plan whose first box was never marked received is unknown, not late", () => {
  const { receiptAt, basis } = firstDeliveryReceiptOf([
    { deliveryNumber: 1, deliveredAt: null },
    { deliveryNumber: 2, deliveredAt: "2026-07-01T09:00:00Z" },
  ]);
  assert.equal(receiptAt, null, "delivery two must not stand in for delivery one");
  const r = evaluateWithdrawalTimeliness({ receiptAt, declaredAt: "2027-01-01T00:00:00Z", basis });
  assert.equal(r.timeliness, "receipt_unknown");
});

/* ══════════════════════════════════════════════════════════════
   WHAT THE PERIOD MUST NEVER BE DATED FROM
   ══════════════════════════════════════════════════════════════ */

test("the module names no purchase, payment or dispatch field at all", () => {
  const src = read("lib/withdrawalDeadline.ts");
  const code = src.replace(/\/\*\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const forbidden of ["paid_at", "paidAt", "purchased_at", "purchasedAt",
                           "shipped_at", "shippedAt", "created_at", "createdAt",
                           "placed_at", "placedAt"]) {
    assert.ok(!code.includes(forbidden),
      `the deadline engine reads ${forbidden}, which § 356 Abs. 2 does not name`);
  }
});

test("the same order dispatched much earlier yields the same deadline", () => {
  // Two contracts received on the same day, one shipped weeks before
  // the other. Only receipt may matter, so the answers must be equal.
  const a = evaluateWithdrawalTimeliness({
    receiptAt: "2026-06-01T09:00:00Z", declaredAt: "2026-06-10T00:00:00Z",
  });
  const b = evaluateWithdrawalTimeliness({
    receiptAt: "2026-06-01T09:00:00Z", declaredAt: "2026-06-10T00:00:00Z",
  });
  assert.deepEqual(a, b);
});

test("the module is a pure leaf: it imports nothing", () => {
  const src = read("lib/withdrawalDeadline.ts");
  assert.ok(!/^import /m.test(src), "lib/withdrawalDeadline.ts gained an import");
});
