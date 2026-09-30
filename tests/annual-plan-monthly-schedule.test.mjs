import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ANNUAL_DELIVERY_COUNT,
  ANNUAL_DELIVERY_INTERVAL_DAYS,
  ANNUAL_LEGACY_DELIVERY_COUNT,
  ANNUAL_SCHEDULE_MODELS,
  ANNUAL_SCHEDULE_MODEL_CURRENT,
  ANNUAL_SCHEDULE_MODEL_V1,
  ANNUAL_SCHEDULE_MODEL_V2,
  ANNUAL_SHIPPING_PER_DELIVERY_GROSS_CENTS,
  ANNUAL_FREE_SHIPPING_FROM_GRAMS,
  ANNUAL_FREE_SHIPPING_NOTE,
  ANNUAL_TERM_DAYS,
  ANNUAL_TERM_HOURS,
  addCalendarMonths,
  annualCadenceLabelOf,
  annualMonthlyPlanEndDate,
  annualMonthlyScheduleDates,
  annualScheduleModelOf,
  buildAnnualDeliverySchedule,
  buildAnnualPricing,
} from "../lib/annualPlanRules.ts";

/* ══════════════════════════════════════════════════════════════
   THE 12-MONTH ANNUAL PLAN (migration 069)

   SAFE DEFAULT SUITE: pure leaves driven with literals, plus source and
   migration text. No Supabase client, no SQL, no Stripe object, no
   network, nothing written anywhere.

   ── WHAT THIS SUITE IS FOR ────────────────────────────────────

   The annual plan sold until migration 069 was THIRTEEN deliveries every
   28 days. The plan sold after it is TWELVE, one per CALENDAR MONTH.
   Both are real contracts and both must keep working, so almost every
   test below comes in a pair: what a NEW plan gets, and what an OLD plan
   keeps.

   The one thing that must never happen is an existing plan being
   described or re-scheduled under the new model. Tests 14, 15 and 18
   exist for exactly that.
   ══════════════════════════════════════════════════════════════ */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf8");
const M069 = read("supabase/migrations/069_annual_plan_monthly_schedule.sql");

/** The live retail prices the shop charges. */
const RETAIL = { "30g": 1499, "50g": 2299, "100g": 3999 };
const pricingFor = size => {
  const r = buildAnnualPricing({ size, catalogUnitGrossCents: RETAIL[size] });
  assert.equal(r.ok, true, `pricing failed for ${size}`);
  return r.pricing;
};
const eur = cents => (cents / 100).toFixed(2);

/* ══════════════════════════════════════════════════════════════
   1-6. THE CURRENT OFFER
   ══════════════════════════════════════════════════════════════ */

test("1: the current annual offer is twelve deliveries", () => {
  assert.equal(ANNUAL_DELIVERY_COUNT, 12);
  assert.equal(ANNUAL_SCHEDULE_MODEL_CURRENT, ANNUAL_SCHEDULE_MODEL_V2);
  assert.equal(ANNUAL_SCHEDULE_MODELS[ANNUAL_SCHEDULE_MODEL_CURRENT].deliveryCount, 12);
  // Every size gets the same count - it is the contract, not a size option.
  for (const size of ["30g", "50g", "100g"]) {
    assert.equal(pricingFor(size).deliveryCount, 12, size);
  }
  // And the database admits it.
  assert.match(M069, /check \(delivery_count in \(12, 13\)\)/);
});

test("2: 30 g is 12 x 13,49 product + 12 x 5,90 shipping = 232,68", () => {
  const p = pricingFor("30g");
  assert.equal(p.catalogUnitGrossCents, 1499);
  assert.equal(p.annualUnitGrossCents, 1349);
  assert.equal(p.merchandiseTotalGrossCents, 1349 * 12);
  assert.equal(p.merchandiseTotalGrossCents, 16188);
  assert.equal(p.shippingPerDeliveryGrossCents, 590);
  assert.equal(p.shippingTotalGrossCents, 590 * 12);
  assert.equal(p.shippingTotalGrossCents, 7080);
  assert.equal(p.totalGrossCents, 23268);
  assert.equal(eur(p.totalGrossCents), "232.68");
});

test("3: 50 g is 12 x 20,69 product + 12 x 5,90 shipping = 319,08", () => {
  const p = pricingFor("50g");
  assert.equal(p.annualUnitGrossCents, 2069);
  assert.equal(p.merchandiseTotalGrossCents, 24828);
  assert.equal(p.shippingTotalGrossCents, 7080);
  assert.equal(p.totalGrossCents, 31908);
  assert.equal(eur(p.totalGrossCents), "319.08");
});

test("4: 100 g is 12 x 35,99 product + 12 x 5,90 shipping = 502,68", () => {
  const p = pricingFor("100g");
  assert.equal(p.annualUnitGrossCents, 3599);
  assert.equal(p.merchandiseTotalGrossCents, 43188);
  assert.equal(p.shippingTotalGrossCents, 7080);
  assert.equal(p.totalGrossCents, 50268);
  assert.equal(eur(p.totalGrossCents), "502.68");
});

test("5: 50 g no longer ships free on an annual plan", () => {
  assert.equal(ANNUAL_SHIPPING_PER_DELIVERY_GROSS_CENTS["50g"], 590);
  assert.notEqual(ANNUAL_SHIPPING_PER_DELIVERY_GROSS_CENTS["50g"], 0);
  assert.equal(pricingFor("50g").shippingTotalGrossCents, 7080);
});

test("6: 100 g no longer ships free on an annual plan", () => {
  assert.equal(ANNUAL_SHIPPING_PER_DELIVERY_GROSS_CENTS["100g"], 590);
  assert.notEqual(ANNUAL_SHIPPING_PER_DELIVERY_GROSS_CENTS["100g"], 0);
  assert.equal(pricingFor("100g").shippingTotalGrossCents, 7080);
});

test("6b: the free-shipping claim removed ITSELF, because it was derived", () => {
  // ANNUAL_FREE_SHIPPING_FROM_GRAMS scans the shipping table for a zero.
  // There is none, so the constant is null and the note the shop and the
  // account rendered is null - no copy had to be hunted down and deleted.
  assert.equal(ANNUAL_FREE_SHIPPING_FROM_GRAMS, null);
  assert.equal(ANNUAL_FREE_SHIPPING_NOTE, null);
  // And the AGB no longer promises it either.
  assert.ok(!read("app/GloaSite.tsx").includes("ab 50 g ist der Versand kostenlos"),
    "the terms still advertise the withdrawn free-shipping benefit");
});

/* ══════════════════════════════════════════════════════════════
   7-13. THE CALENDAR
   ══════════════════════════════════════════════════════════════ */

test("7: a 29th anchor stays the 29th wherever the 29th exists", () => {
  const dates = annualMonthlyScheduleDates("2026-09-29");
  assert.equal(dates.length, 12);
  assert.deepEqual(dates, [
    "2026-09-29", "2026-10-29", "2026-11-29", "2026-12-29",
    "2027-01-29", "2027-02-28", "2027-03-29", "2027-04-29",
    "2027-05-29", "2027-06-29", "2027-07-29", "2027-08-29",
  ]);
  // Eleven of the twelve are the 29th; only February could not be.
  assert.equal(dates.filter(d => d.endsWith("-29")).length, 11);
  assert.deepEqual(dates.filter(d => !d.endsWith("-29")), ["2027-02-28"]);
});

test("8: a 30th anchor clamps ONLY where the 30th does not exist", () => {
  const dates = annualMonthlyScheduleDates("2026-03-30");
  assert.equal(dates.length, 12);
  // Every month has a 30th except February.
  assert.equal(dates.filter(d => d.endsWith("-30")).length, 11);
  assert.equal(dates[11], "2027-02-28", "the only clamp is February");
  // 2028 is a leap year, so the same anchor clamps to the 29th instead.
  assert.equal(addCalendarMonths("2028-01-30", 1), "2028-02-29");
});

test("9: 31 Jan 2026 gives 31 Jan, 28 Feb, 31 Mar, 30 Apr, 31 May", () => {
  assert.deepEqual(annualMonthlyScheduleDates("2026-01-31", 5), [
    "2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30", "2026-05-31",
  ]);
});

test("10: 31 Jan 2028 gives 31 Jan, 29 Feb, 31 Mar - the leap year", () => {
  assert.deepEqual(annualMonthlyScheduleDates("2028-01-31", 3), [
    "2028-01-31", "2028-02-29", "2028-03-31",
  ]);
});

test("11: there is no chained drift after February", () => {
  // THE BUG THIS RULE EXISTS TO PREVENT. Adding one month to the PREVIOUS
  // occurrence loses the anchor day permanently the first time it passes
  // a short month:
  //
  //     chained : 31 Jan -> 28 Feb -> 28 Mar -> 28 Apr   WRONG
  //     anchored: 31 Jan -> 28 Feb -> 31 Mar -> 30 Apr   RIGHT
  const anchored = annualMonthlyScheduleDates("2026-01-31", 6);

  // Reproduce the wrong algorithm and prove the two diverge.
  const chained = ["2026-01-31"];
  for (let i = 1; i < 6; i += 1) chained.push(addCalendarMonths(chained[i - 1], 1));
  assert.deepEqual(chained,
    ["2026-01-31", "2026-02-28", "2026-03-28", "2026-04-28", "2026-05-28", "2026-06-28"]);
  assert.notDeepEqual(anchored, chained, "the schedule is chaining instead of anchoring");
  assert.equal(anchored[2], "2026-03-31");
  assert.equal(chained[2], "2026-03-28");

  // Every anchored date is the anchor day or its month's last day.
  for (const d of anchored) {
    const [y, m, day] = d.split("-").map(Number);
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    assert.ok(day === 31 || day === lastDay, `${d} is neither the anchor day nor a clamp`);
  }

  // And the SQL does it the same way: anchor + N months, never previous + 1.
  assert.match(M069, /p_anchor_date \+ pg_catalog\.make_interval\(months => p_delivery_number - 1\)/);
  assert.match(M069, /v_anchor_local \+ pg_catalog\.make_interval\(months => n - 1\)/);
});

test("12: DST does not change the intended calendar date", () => {
  // The helper works on calendar PARTS, so there is no instant to shift:
  // no Date arithmetic crosses a month boundary and no timezone is read.
  const octoberDst = annualMonthlyScheduleDates("2026-10-25", 3);
  assert.deepEqual(octoberDst, ["2026-10-25", "2026-11-25", "2026-12-25"]);
  const marchDst = annualMonthlyScheduleDates("2027-03-28", 3);
  assert.deepEqual(marchDst, ["2027-03-28", "2027-04-28", "2027-05-28"]);
  // The rules leaf reads no clock and no zone for this.
  const rules = read("lib/annualPlanRules.ts");
  const helper = rules.slice(rules.indexOf("export function addCalendarMonths("),
    rules.indexOf("export function annualMonthlyScheduleDates("));
  for (const banned of ["getTimezoneOffset", "toLocaleString", "Intl.", "Date.now()", "new Date()"]) {
    assert.ok(!helper.includes(banned), `the calendar helper reads the environment: ${banned}`);
  }
  // And the SQL pins its arithmetic to Berlin explicitly, so it does not
  // depend on the session's timezone either.
  assert.match(M069, /at time zone 'Europe\/Berlin'/);
  assert.equal((M069.match(/at time zone 'Europe\/Berlin'/g) || []).length >= 3, true);
});

test("13: the plan ends one calendar year after the ORIGINAL anchor", () => {
  assert.equal(annualMonthlyPlanEndDate("2026-09-29"), "2027-09-29");
  assert.equal(annualMonthlyPlanEndDate("2026-01-31"), "2027-01-31");
  // A leap-day anchor clamps on the way out, like any other.
  assert.equal(annualMonthlyPlanEndDate("2028-02-29"), "2029-02-28");
  // The term still ends AFTER the twelfth delivery rather than during it,
  // which is what the completion sweep depends on.
  const dates = annualMonthlyScheduleDates("2026-09-29");
  assert.ok(annualMonthlyPlanEndDate("2026-09-29") > dates[11]);
  assert.equal(dates[11], "2027-08-29");
  // The SQL agrees: twelve months for the term, from the same anchor.
  assert.match(M069, /v_anchor_local \+ pg_catalog\.make_interval\(months => 12\)/);
});

/* ══════════════════════════════════════════════════════════════
   14-18. THE LEGACY CONTRACT IS UNTOUCHED
   ══════════════════════════════════════════════════════════════ */

test("14: the legacy v1 schedule is still thirteen deliveries, 28 days apart", () => {
  assert.equal(ANNUAL_LEGACY_DELIVERY_COUNT, 13);
  assert.equal(ANNUAL_DELIVERY_INTERVAL_DAYS, 28);
  assert.equal(ANNUAL_TERM_DAYS, 364);
  assert.equal(ANNUAL_TERM_HOURS, 8736);

  const anchor = Date.UTC(2026, 8, 1, 9, 30, 0);
  const schedule = buildAnnualDeliverySchedule(new Date(anchor));
  assert.equal(schedule.length, 13);
  const DAY = 24 * 60 * 60 * 1000;
  for (let i = 1; i < schedule.length; i += 1) {
    assert.equal(
      schedule[i].scheduledFor.getTime() - schedule[i - 1].scheduledFor.getTime(),
      28 * DAY, `gap before delivery ${i + 1}`);
  }
  assert.equal(schedule[12].scheduledFor.getTime() - anchor, 336 * DAY);
  // The v1 engine shares nothing with the calendar one.
  const rules = read("lib/annualPlanRules.ts");
  const legacy = rules.slice(rules.indexOf("export function buildAnnualDeliverySchedule("),
    rules.indexOf("export function annualPlanEndAt("));
  for (const banned of ["addCalendarMonths", "make_interval", "monatlich", "Kalendermonat"]) {
    assert.ok(!legacy.includes(banned), `the legacy engine gained calendar arithmetic: ${banned}`);
  }
});

test("15: an existing 13-delivery plan is NOT relabelled monthly", () => {
  // The row decides, and a row written before the column existed has no
  // model at all - so thirteen deliveries must resolve to v1.
  assert.equal(annualScheduleModelOf({ scheduleModel: null, deliveryCount: 13 }),
    ANNUAL_SCHEDULE_MODEL_V1);
  assert.equal(annualScheduleModelOf({ deliveryCount: 13 }), ANNUAL_SCHEDULE_MODEL_V1);
  assert.equal(annualCadenceLabelOf({ scheduleModel: null, deliveryCount: 13 }), "alle 4 Wochen");
  assert.equal(annualCadenceLabelOf({ scheduleModel: "v1_28d_13", deliveryCount: 13 }), "alle 4 Wochen");
  // An unrecognised model falls back to LEGACY, never to today's default -
  // describing an old contract with new terms is the one fatal direction.
  assert.equal(annualCadenceLabelOf({ scheduleModel: "v9_future", deliveryCount: 13 }), "alle 4 Wochen");
  // A v2 row says monatlich, so the two really are distinguished.
  assert.equal(annualCadenceLabelOf({ scheduleModel: "v2_monthly_12", deliveryCount: 12 }), "monatlich");
  assert.equal(annualScheduleModelOf({ scheduleModel: "v2_monthly_12", deliveryCount: 12 }),
    ANNUAL_SCHEDULE_MODEL_V2);

  // And the account renders the PLAN's label, not a module constant.
  const portal = read("app/AccountPortal.tsx");
  assert.match(portal, /\{annualCadenceLabel\(v\)\}/);
  assert.ok(!/const ANNUAL_CADENCE_LABEL = /.test(portal),
    "the account went back to one cadence for every plan");
});

test("16: a v2 confirmation email says twelve deliveries, monatlich", () => {
  const sender = read("lib/annualPurchaseConfirmationEmail.ts");
  assert.ok(sender.includes('v2_monthly_12: Object.freeze({ deliveryCount: 12, cadenceLabel: "monatlich" })'),
    "the email leaf does not know the v2 contract");
  // The expected count comes from the plan's own model, not one constant.
  assert.match(sender, /EMAIL_SCHEDULE_MODELS\[emailScheduleModelOf\(plan\)\]\.deliveryCount/);
  assert.match(sender, /cadenceLabel: EMAIL_SCHEDULE_MODELS\[emailScheduleModelOf\(plan\)\]\.cadenceLabel/);
  // The template prints the label it is handed rather than deriving weeks.
  const template = read("lib/email/annualPurchaseConfirmation.ts");
  assert.match(template, /const cadence = plan\.cadenceLabel;/);
  assert.ok(!/alle \$\{cadenceWeeks\} Wochen/.test(template),
    "the template still derives a week count");
  assert.match(template, /\$\{plan\.deliveryCount\} Lieferungen, \$\{cadence\}/);
});

test("17: a v1 confirmation email still says thirteen and four weeks", () => {
  const sender = read("lib/annualPurchaseConfirmationEmail.ts");
  assert.ok(sender.includes('v1_28d_13: Object.freeze({ deliveryCount: 13, cadenceLabel: "alle 4 Wochen" })'),
    "the email leaf forgot the v1 contract");
  // A row with no model resolves to v1 inside the email path too.
  assert.match(sender, /return plan\.delivery_count === 12 \? "v2_monthly_12" : "v1_28d_13";/);
  // The legacy constants the leaf restates are unchanged.
  assert.match(sender, /export const ANNUAL_EMAIL_DELIVERY_COUNT = 13;/);
  assert.match(sender, /export const ANNUAL_CADENCE_WEEKS = 4;/);
});

test("18: migration 069 rewrites no existing row and no existing schedule", () => {
  const exec = M069.slice(0, M069.indexOf("-- 8. VERIFY"));
  const code = exec.replace(/^--.*$/gm, "");
  // Every existing row becomes v1 by DEFAULT, without an UPDATE.
  assert.match(M069, /add column schedule_model text not null default 'v1_28d_13'/);
  assert.ok(!/update public\.annual_plans\s+set schedule_model/.test(code),
    "069 backfills schedule_model");
  // No delivery row is touched at all.
  assert.ok(!/update public\.annual_plan_deliveries/.test(code),
    "069 rewrites an existing delivery");
  assert.ok(!/delete from/.test(code), "069 deletes rows");
  // The v1 branch of activation still builds 672-hour steps and an
  // 8736-hour term, so a v1 plan settling AFTER 069 is unchanged too.
  assert.match(M069, /make_interval\(hours => 672 \* \(n - 1\)\)/);
  assert.match(M069, /make_interval\(hours => 8736\)/);
  // One transaction, so a failure leaves the schema exactly as it was.
  assert.equal((M069.match(/^begin;$/gm) || []).length, 1);
  assert.equal((M069.match(/^commit;$/gm) || []).length, 1);
  // And it grants nothing to a browser role.
  assert.ok(!/grant select/.test(M069), "069 widens what the browser can read");
});

test("18b: 069 is the newest migration, owns its number, and is NOT applied", () => {
  const files = readdirSync(path.join(ROOT, "supabase/migrations"))
    .filter(f => f.endsWith(".sql")).sort();
  assert.equal(files.at(-1), "069_annual_plan_monthly_schedule.sql");
  assert.equal(files.filter(f => f.startsWith("069")).length, 1);
  assert.equal(files.filter(f => Number(f.slice(0, 3)) > 69).length, 0);
  assert.match(M069, /NOT YET APPLIED/);
  // 066, 067 and 068 are not touched by it.
  for (const kept of ["annual_plans_active_upgrade_per_subscription_key",
                      "annual_plans_one_live_per_user_key",
                      "annual_plans_pending_claim_shape_check"]) {
    assert.ok(!M069.slice(0, M069.indexOf("-- 8. VERIFY")).replace(/^--.*$/gm, "").includes(kept),
      `069 touches ${kept}`);
  }
  // The writer keeps its callable shape for the RUNNING application: an
  // eighteenth argument WITH A DEFAULT, so migration-first is safe.
  assert.match(M069, /p_schedule_model\s+text default 'v1_28d_13'/);
});
