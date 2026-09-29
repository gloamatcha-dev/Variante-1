import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildAnnualPlanAccountView } from "../lib/annualPlanAccount.ts";
import { isLiveAnnualPlan, isLiveSubscription } from "../lib/purchaseEligibility.ts";
import { getSubscriptionStatusLabel } from "../lib/subscriptionCancellationRules.ts";
import { ANNUAL_DELIVERY_COUNT } from "../lib/annualPlanRules.ts";

/* ══════════════════════════════════════════════════════════════
   /account/subscriptions — TWO PRODUCTS, ONE STATE EACH

   SAFE DEFAULT SUITE: the pure read model driven with row literals, plus
   source-level contract checks on the account portal. No Supabase client
   is constructed, no SQL runs, no Stripe object exists and nothing is
   written anywhere.

   ── THE TWO THINGS THIS PAGE WAS DOING WRONG ──────────────────

   1. IT WAS FOUR FULL SECTIONS DEEP. The subscription history, the whole
      monthly checkout form, the annual history and the whole annual
      checkout form, stacked - two complete purchases nobody had asked
      for, between a customer and the state they opened the page to
      check. On a phone that state was several screens down.

   2. A REFUNDED PLAN READ AS A RUNNING ONE. The annual card rendered
      every plan with the same facts, so a plan whose 252,07 EUR had been
      given back still said "1 von 13", "Offen 12", "Läuft bis
      27.09.2027" and "Der Plan endet nach der letzten der 13
      Lieferungen". Every figure was true of the contract that WAS
      bought; none of it was going to happen. Twelve deliveries appeared
      to be on their way.

   Both are customer-facing communication defects rather than data
   defects: nothing about the money, the schedule or the eligibility was
   wrong, and nothing about them is changed here.
   ══════════════════════════════════════════════════════════════ */

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const NEWLINE = String.fromCharCode(10);
const read = rel => readFileSync(path.join(ROOT, rel), "utf-8");

/**
 * Block comments removed as well.
 *
 * The line-based stripper below only drops lines that START with a
 * comment marker, so the CONTINUATION lines of a /* … *\/ block survive -
 * and the prose in this file's own source explains at length what the
 * old card used to say ("Offen 12", "Läuft bis 27.09.2027"). A scan for
 * those strings has to read markup, not the note explaining why they are
 * no longer in it.
 */
const stripBlocks = source => source.replace(/\/\*[\s\S]*?\*\//g, "");

const withoutComments = source => source
  .split(NEWLINE)
  .filter(line => {
    const t = line.trim();
    return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
  })
  .join(NEWLINE);

const portal = read("app/AccountPortal.tsx");
const portalCode = withoutComments(portal);
const css = read("app/globals.css");

function between(source, startMarker, endMarker) {
  const at = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, at + startMarker.length);
  assert.ok(at > -1 && end > at, `could not locate ${startMarker} … ${endMarker}`);
  return source.slice(at, end);
}

/**
 * The portal with EVERY comment gone - blocks stripped from the raw
 * source BEFORE the line filter, because the line filter removes a
 * block's delimiters and leaves its prose behind.
 */
const portalMarkup = withoutComments(stripBlocks(portal));

const page = between(portalCode, "function PortalSubscriptions()", "function PortalPastPlans(");
const history = between(portalCode, "function PortalPastPlans(", "function SubscriptionDetail(");
const annualPanel = between(portalCode, "function PortalAnnualPlans(", "function annualStatusLabel(");
const annualDetail = between(portalCode, "function AnnualPlanDetail(", "function CheckoutReturnBanner()");
const subDetail = between(portalCode, "function SubscriptionDetail(", "function PortalAddresses()");
const monthlyForm = between(portalCode, "function SubscriptionStartForm(", "function AnnualPlanStartForm(");
const annualForm = between(portalCode, "function AnnualPlanStartForm(", "function PortalAnnualPlans(");
/*
  THE DASHBOARD'S OWN HISTORY LIST.

  Extracted separately because it is a SECOND renderer of the same idea:
  /account/dashboard has its own VERGANGEN block and does not reuse
  PortalPastPlans. Section 5 below asserted only the subscriptions page,
  so the dashboard was free to render a different date - and did.
*/
const dashboard = between(portalCode, "function PrivateDashboard()", "function BusinessDashboard()");
const dashboardPast = between(dashboard, 'label="VERGANGEN"', "</section>");

/* ── The production plan, before and after the refund ────────── */

const PLAN_ID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const PURCHASED_AT = "2026-09-27T18:12:00+00:00";
const PLAN_END_AT = "2027-09-27T18:12:00+00:00";
const FIRST_AT = "2026-09-28T04:00:00+00:00";
const SECOND_AT = "2026-10-26T04:00:00+00:00";
const ORDER_ID = "cccccccc-3333-4333-8333-cccccccccccc";
const TOTAL_GROSS_CENTS = 25207;

const planRow = (over = {}) => ({
  id: PLAN_ID,
  status: "active",
  payment_status: "paid",
  currency: "EUR",
  delivery_count: ANNUAL_DELIVERY_COUNT,
  catalog_unit_gross_cents: 1499,
  annual_unit_gross_cents: 1349,
  shipping_per_delivery_gross_cents: 590,
  merchandise_total_gross_cents: 17537,
  shipping_total_gross_cents: 7670,
  total_gross_cents: TOTAL_GROSS_CENTS,
  refunded_total_cents: 0,
  discount_percent_applied: "10.00",
  delivery_items_snapshot: [
    { productName: "GLOA Matcha", variantLabel: "30 g", sizeGrams: 30, quantity: 1 },
  ],
  purchased_at: PURCHASED_AT,
  plan_end_at: PLAN_END_AT,
  completed_at: null,
  cancelled_at: null,
  ...over,
});

/** One delivery already created, twelve still only scheduled. */
function schedule() {
  const rows = [
    { delivery_number: 1, scheduled_for: FIRST_AT, state: "fulfilled", fulfilled_at: FIRST_AT, order_id: ORDER_ID },
    { delivery_number: 2, scheduled_for: SECOND_AT, state: "scheduled", fulfilled_at: null, order_id: null },
  ];
  for (let n = 3; n <= ANNUAL_DELIVERY_COUNT; n++) {
    rows.push({
      delivery_number: n,
      scheduled_for: `2027-${String(n).padStart(2, "0")}-01T04:00:00+00:00`,
      state: "scheduled",
      fulfilled_at: null,
      order_id: null,
    });
  }
  return rows;
}

const activePlan = () => buildAnnualPlanAccountView(planRow(), schedule());
/** The production state: paid once, fully refunded, never cancelled. */
const refundedPlan = () => buildAnnualPlanAccountView(
  planRow({ payment_status: "refunded", refunded_total_cents: TOTAL_GROSS_CENTS }),
  schedule()
);

const endedSub = {
  id: "33333333-3333-4333-8333-333333333333",
  plan_id: "11111111-1111-4111-8111-111111111111",
  status: "cancelled",
  current_period_end: "2026-10-25T10:00:00+00:00",
  next_delivery_at: "2026-10-25T10:00:00+00:00",
  cancellation_requested_at: "2026-09-27T10:00:00+00:00",
  cancellation_effective_at: "2026-09-28T09:00:00+00:00",
  cancelled_at: "2026-09-28T09:00:00+00:00",
};

/* ══════════════════════════════════════════════════════════════
   1. THE TWO PRODUCT PANELS
   ══════════════════════════════════════════════════════════════ */

test("1a: each product states its CURRENT state, at the top, compactly", () => {
  assert.match(page, /label="ABO"/, "the abo panel is gone");
  assert.match(annualPanel, /label="JAHRESPLAN"/, "the plan panel is gone");
  assert.ok(page.indexOf('label="ABO"') < page.indexOf("PortalAnnualPlans"),
    "the two panels are not the first thing on the page");
  // Both partitions come from the shared eligibility predicates, so
  // "aktiv" means here what it means to the route that would refuse a
  // duplicate of it.
  assert.match(page, /const liveSubs = subs\.filter\(sub => isLiveSubscription\(/);
  assert.match(annualPanel, /const live = views\.filter\(isLiveAnnualPlan\);/);
});

test("1a2: the page is named after BOTH contracts it holds", () => {
  /*
    It said "Deine Abos." and "Hier findest du deine regelmäßigen
    Lieferungen." - accurate when the recurring subscription was the only
    thing here, and wrong since the prepaid annual plan gained its own
    panel, its own history and its own purchase form on this page. A
    customer arriving to look at their Jahresplan was told the page was
    about something else.
  */
  assert.match(page, /<p className="eyebrow">PLÄNE<\/p>/);
  assert.match(page, /"Deine Pläne\."/);
  assert.match(page, /"Hier verwaltest du deine regelmäßigen Lieferungen und deinen Jahresplan\."/);
  assert.ok(!page.includes('"Deine Abos."'), "the page is still named after one of its two products");
  // The empty page keeps its own headline and names both as well.
  assert.match(page, /"Dein Matcha, regelmäßig\."/);
  assert.match(page, /"Regelmäßige Lieferungen und der Jahresplan für deinen GLOA Matcha\."/);
  // AND THE RECURRING PRODUCT IS STILL NOT CALLED MONTHLY. It ships every
  // four weeks; tests/account-subscription-view.test.mjs bans the word on
  // this surface, and the panel is labelled ABO for that reason.
  const bare = between(portalMarkup, "function PortalSubscriptions()", "function PortalPastPlans(");
  assert.ok(!/Monat/.test(bare), "the plans page calls the 4-week contract monthly");
});

test("1b: an ended abo gets the terminal state and the offer, not a form", () => {
  assert.match(page, /Kein aktives Abo/);
  assert.match(page, /Dein letztes Abo wurde am \$\{fmtDate\(getEffectiveEndAt\(lastEndedSub\) as string\)\} beendet\./);
  // No date, no sentence with a hole in it.
  assert.match(page, /"Dein letztes Abo wurde beendet\."/);
  assert.match(page, /NEUES ABO STARTEN/);
  // Executed: the production row is terminal and reads as such.
  assert.equal(isLiveSubscription(endedSub), false);
  assert.equal(getSubscriptionStatusLabel(endedSub), "Beendet");
});

test("1c: a refunded plan gets the terminal state and the offer, not a form", () => {
  assert.match(annualPanel, /Kein aktiver Jahresplan/);
  assert.match(annualPanel, /\{annualHistoryNote\(lastFinished\)\}/);
  assert.match(annualPanel, /NEUEN JAHRESPLAN WÄHLEN/);
  // The sentence itself, and the order it decides in - the same order
  // annualStatusLabel uses, so the badge and the note cannot disagree.
  const note = between(portalCode, "function annualHistoryNote(", "\n}");
  assert.match(note, /Dein letzter Jahresplan wurde vollständig erstattet\./);
  assert.ok(note.indexOf('v.paymentStatus === "refunded"') < note.indexOf('v.status === "completed"'));
  // Executed: the production plan is terminal.
  assert.equal(isLiveAnnualPlan(refundedPlan()), false);
  assert.equal(isLiveAnnualPlan(activePlan()), true);
});

test("1d: the offer is absent exactly when the server would refuse it", () => {
  // One live plan at a time, so a running plan gets no CTA at all -
  // hasAnnualPlan is the same isLiveAnnualPlan the route refuses with.
  assert.match(page, /const hasAnnualPlan = annual\.views\.some\(isLiveAnnualPlan\);/);
  assert.match(page, /onStart=\{hasAnnualPlan \? undefined : \(\) => setOpenForm\(/);
  assert.match(annualPanel, /\{onStart && \(/, "the plan CTA is unconditional");
  // A second SIZE of abo is still allowed, so that offer stays.
  assert.match(page, /WEITERES ABO STARTEN/);
});

/* ══════════════════════════════════════════════════════════════
   2. THE FORMS ARE REVEALED, NOT STACKED
   ══════════════════════════════════════════════════════════════ */

test("2a: neither checkout form is expanded on first render", () => {
  assert.match(page, /const \[openForm, setOpenForm\] = useState<"none" \| "monthly" \| "annual">\("none"\);/,
    "the page does not start with both forms collapsed");
  // Each form is behind its own value, so opening one cannot open both.
  assert.match(page, /openForm === "monthly" && \(\s*<SubscriptionStartForm/);
  assert.match(page, /openForm === "annual" && \(\s*<AnnualPlanStartForm/);
  // And there is exactly one of each on the page.
  assert.equal([...page.matchAll(/<SubscriptionStartForm/g)].length, 1);
  assert.equal([...page.matchAll(/<AnnualPlanStartForm/g)].length, 1);
});

test("2b: the monthly CTA opens the monthly form and nothing else", () => {
  const abo = between(page, 'label="ABO"', "PortalAnnualPlans");
  const opens = [...abo.matchAll(/setOpenForm\(openForm === "(\w+)" \? "none" : "(\w+)"\)/g)];
  assert.ok(opens.length >= 1, "the abo panel opens no form");
  for (const [, tested, opened] of opens) {
    assert.equal(tested, "monthly");
    assert.equal(opened, "monthly");
  }
  assert.ok(!abo.includes('"annual"'), "the abo panel can open the annual form");
});

test("2c: the annual CTA opens the annual form and nothing else", () => {
  const onStart = between(page, "onStart={hasAnnualPlan", "/>");
  assert.match(onStart, /setOpenForm\(openForm === "annual" \? "none" : "annual"\)/);
  assert.ok(!onStart.includes('"monthly"'), "the plan panel can open the abo form");
});

test("2d: a form that can be opened can be closed, and closing buys nothing", () => {
  for (const [name, form] of Object.entries({ monthlyForm, annualForm })) {
    assert.match(form, /onCancel\?: \(\) => void;/, `${name} cannot be closed`);
    assert.match(form, /<button type="button" className="plan-form-close" onClick=\{onCancel\}>ABBRECHEN<\/button>/,
      `${name} has no close control`);
  }
  // Closing is presentation only: it sends nothing and cancels nothing.
  assert.match(page, /onCancel=\{\(\) => setOpenForm\("none"\)\}/);
  assert.equal([...page.matchAll(/onCancel=\{\(\) => setOpenForm\("none"\)\}/g)].length, 2);
  assert.ok(css.includes(".plan-form-close{"), "the close control has no styling");
});

test("2e: the checkout itself is untouched", () => {
  // Same endpoints, same bodies, same idempotency token. This package
  // moved markup; it did not touch a purchase.
  assert.match(monthlyForm, /await fetch\("\/api\/subscriptions\/checkout\/session"/);
  assert.match(annualForm, /await fetch\("\/api\/annual-plan\/checkout\/session"/);
  assert.match(monthlyForm, /body: JSON\.stringify\(\{ planId, addressId, requestId \}\)/);
  assert.match(monthlyForm, /const tokenRef = useRef<\{ key: string; id: string \} \| null>\(null\);/);
  assert.match(annualForm, /const tokenRef = useRef<\{ key: string; id: string \} \| null>\(null\);/);
});

/* ══════════════════════════════════════════════════════════════
   3. A REFUNDED PLAN PROMISES NOTHING
   ══════════════════════════════════════════════════════════════ */

test("3a: the read model already refuses to name a next delivery", () => {
  const refunded = refundedPlan();
  assert.equal(refunded.nextDelivery, null, "a refunded plan still has a next delivery");
  assert.equal(refunded.fulfilledDeliveries, 1);
  assert.equal(refunded.deliveryCount, ANNUAL_DELIVERY_COUNT);
  assert.equal(refunded.refundedTotalCents, TOTAL_GROSS_CENTS);
  // Twelve rows survive as the record of what had been arranged. They
  // are history, not a queue - which is exactly what the UI has to say.
  assert.equal(refunded.deliveries.filter(d => d.state === "scheduled").length, 12);
  // The active plan is unaffected and still owes the next box.
  assert.equal(activePlan().nextDelivery.scheduledFor, SECOND_AT);
});

test("3b: the panel never renders a finished plan at all", () => {
  // The card that said "Offen 12" and "Läuft bis" is now only ever
  // reached for a running plan, so those figures cannot appear beside a
  // status reading Erstattet. Read from the MARKUP - the prose in the
  // file says those words too, explaining why they moved.
  const markup = between(portalMarkup, "function PortalAnnualPlans(", "function annualStatusLabel(");
  const gate = markup.indexOf("const live = views.filter(isLiveAnnualPlan);");
  const loop = markup.indexOf("live.map(v =>");
  assert.ok(gate > -1 && loop > gate, "the running-plan branch could not be located");
  for (const promise of ["Offen", "Läuft bis", "Nächste Lieferung", "Einmal bezahlt, keine automatische Verlängerung."]) {
    const at = markup.indexOf(promise);
    assert.ok(at > loop, `"${promise}" is rendered outside the running-plan branch`);
  }
  // And the empty state, which is what a finished plan reaches instead,
  // states none of them.
  const empty = markup.slice(markup.indexOf("Kein aktiver Jahresplan"), loop);
  for (const promise of ["Offen", "Läuft bis", "Nächste Lieferung", "von {"]) {
    assert.ok(!empty.includes(promise), `the empty state promises: ${promise}`);
  }
});

test("3c: the plan's own page moves every promise behind the live branch", () => {
  assert.match(annualDetail, /const planIsLive = isLiveAnnualPlan\(plan\);/);
  // The three promise rows are inside {planIsLive && (…)}.
  const liveOnly = between(annualDetail, "{planIsLive && (", "{!planIsLive && terminalEndAt");
  for (const promise of ["Laufzeit bis", "Bereits ausgelöst", "Nächste Lieferung", "ANNUAL_CADENCE_LABEL"]) {
    assert.ok(liveOnly.includes(promise), `"${promise}" left the running-plan branch`);
  }
  // And the sentence about the thirteenth delivery is a live-only branch
  // of its own.
  assert.match(annualDetail, /\{planIsLive\s*\?\s*`Einmalig bezahlt, keine automatische Verlängerung\./);
  assert.match(annualDetail, /: `Dieser Plan ist beendet\./);
});

test("3d: a finished plan's rows say they are NOT going to happen", () => {
  assert.match(annualDetail, /\? ANNUAL_DELIVERY_STATE_LABEL\[d\.state\] \?\? "Unbekannt"\s*: "Findet nicht statt"/);
  // A delivery that actually happened is still reported truthfully.
  assert.match(annualDetail, /planIsLive \|\| d\.state === "fulfilled" \|\| d\.state === "cancelled"/);
  // And only a delivery that BECAME an order carries the prepaid note,
  // because only that one has an amount to explain.
  assert.match(annualDetail, /\{d\.orderId \? \(/);
});

test("3e: it says in words that the remaining deliveries will not come", () => {
  assert.match(portalCode, /const NO_FURTHER_DELIVERIES = "Keine weiteren Lieferungen\.";/);
  assert.match(annualDetail, /\{NO_FURTHER_DELIVERIES\} Es folgt keine weitere Abbuchung\./);
  assert.match(annualDetail, /\{annualHistorySummary\(plan\)\}/);
  const summary = between(portalCode, "function annualHistorySummary(", "\n}");
  assert.match(summary, /Die übrigen \$\{remaining\} finden nicht mehr statt\./);
  assert.match(summary, /v\.paymentStatus === "refunded" \? " vor der Erstattung" : ""/);
  // COUNTED from the rows, never derived from a date or a cadence.
  assert.match(summary, /v\.deliveryCount - v\.fulfilledDeliveries/);
  for (const banned of ["Date", "672", "364", "* 28", "28 *"]) {
    assert.ok(!summary.includes(banned), `the summary computes a schedule: ${banned}`);
  }
});

test("3f: no date is invented for a plan that has none", () => {
  const ends = between(portalCode, "function annualTerminalEndAt(", "\n}");
  assert.match(ends, /return v\.cancelledAt \?\? v\.completedAt \?\? null;/);
  // plan_end_at is when the year WOULD have ended. It is the single most
  // misleading value on a refunded row and is deliberately not used.
  assert.ok(!ends.includes("planEndAt"), "the terminal date falls back to plan_end_at");
  // Executed: the production plan was refunded, never cancelled, so it
  // has no authoritative end date - and the UI omits the line.
  const refunded = refundedPlan();
  assert.equal(refunded.cancelledAt, null);
  assert.equal(refunded.completedAt, null);
  assert.match(annualDetail, /\{terminalEndAt && \(/);
  assert.match(annualDetail, /\{!planIsLive && terminalEndAt && \(/);
});

/* ══════════════════════════════════════════════════════════════
   4. AN ACTIVE PLAN KEEPS EVERYTHING IT HAD
   ══════════════════════════════════════════════════════════════ */

test("4: a running plan still shows progress, the open count and the next box", () => {
  const card = between(annualPanel, "live.map(v =>", "</section>");
  for (const fact of [
    "{v.fulfilledDeliveries} von {v.deliveryCount}",
    "<dt>Offen</dt>",
    "<dt>Nächste Lieferung</dt>",
    "<dt>Läuft bis</dt>",
    "<dt>Bezahlt</dt>",
    "Einmal bezahlt, keine automatische Verlängerung.",
  ]) {
    assert.ok(card.includes(fact), `a running plan lost: ${fact}`);
  }
  // Executed, against the live production row.
  const live = activePlan();
  assert.equal(live.fulfilledDeliveries, 1);
  assert.equal(live.deliveryCount - live.fulfilledDeliveries, 12);
  assert.equal(live.nextDelivery.deliveryNumber, 2);
  assert.equal(live.planEndAt, PLAN_END_AT);
  assert.equal(live.totalGrossCents, TOTAL_GROSS_CENTS);
});

/* ══════════════════════════════════════════════════════════════
   5. HISTORY STAYS, AND STAYS SECONDARY
   ══════════════════════════════════════════════════════════════ */

test("5a: both products' finished contracts are listed, and both open", () => {
  assert.match(history, /label="VERGANGENE PLÄNE"/);
  assert.match(history, /href=\{`\/account\/subscriptions\/\$\{sub\.id\}`\}/);
  assert.match(history, /href=\{annualPlanDetailHref\(v\.id\)\}/);
  assert.match(history, /ANSEHEN/);
  // The product is named, so a row cannot be mistaken for the other one.
  assert.match(history, /<span className="portal-past-type">Abo<\/span>/);
  assert.match(history, /<span className="portal-past-type">Jahresplan<\/span>/);
  // Fed the finished contracts of both products.
  assert.match(page, /const pastSubs = subs\.filter\(sub => subscriptionHasEndedForGood\(/);
  assert.match(page, /const pastAnnual = annual\.views\.filter\(v => !isLiveAnnualPlan\(v\) && v\.status !== "pending"\);/);
});

test("5b: a history row promises nothing", () => {
  // No count, no open deliveries, no next date, no run-to date. Those
  // are promises, and this section is about contracts that are over.
  for (const promise of ["Offen", "Nächste Lieferung", "Läuft bis", "von {", "deliveryCount"]) {
    assert.ok(!history.includes(promise), `a finished contract promises: ${promise}`);
  }
  // Its date is the authoritative terminal one, never plan_end_at.
  assert.match(history, /annualTerminalEndAt\(v\)/);
  assert.match(history, /getEffectiveEndAt\(sub\)/);
  assert.ok(!history.includes("planEndAt"), "a history row shows the date the plan would have run to");
  // And it carries no purchase form.
  assert.ok(!history.includes("StartForm"), "a purchase form is repeated between history records");
});

test("5c: it is visually secondary, and it is not a card", () => {
  assert.match(history, /className="portal-section portal-section-past"/);
  assert.match(history, /className="portal-past-row"/);
  assert.ok(css.includes(".portal-section-past .portal-section-head{opacity:"),
    "the history heading is as loud as the live ones");
  assert.ok(css.includes(".portal-past-row{display:flex;flex-wrap:wrap"),
    "a history row cannot reflow on a narrow screen");
});

/* ══════════════════════════════════════════════════════════════
   6. THE MONTHLY TERMINAL STATE
   ══════════════════════════════════════════════════════════════ */

test("6a: an ended abo says so first, with its date and the offer", () => {
  assert.match(subDetail, /\{ended && \(/);
  assert.match(subDetail, /className="portal-terminal-state">\{statusLabel\}/);
  assert.match(subDetail, /Beendet am \{fmtDate\(endsAt\)\}/);
  assert.match(subDetail, /\{NO_FURTHER_DELIVERIES\} Es folgen keine weiteren Abbuchungen\./);
  assert.match(subDetail, /NEUES ABO STARTEN/);
  // It is above the meta rows, so the fact that decides what the rest of
  // the page means is not the seventh line.
  assert.ok(subDetail.indexOf("{ended && (") < subDetail.indexOf('className="order-detail-meta"'),
    "the terminal state is below the detail rows");
});

test("6b: a finished cancellation never reads as a standing one", () => {
  // The cancellation section tests ended FIRST, which is what stops an
  // abo that ended in September reading "Kündigung vorgemerkt".
  const cancelSection = subDetail.slice(subDetail.indexOf("KÜNDIGUNG</p>"));
  assert.ok(cancelSection.indexOf("{ended ?") > -1);
  assert.ok(cancelSection.indexOf("{ended ?") < cancelSection.indexOf("scheduled && endsAt ?"));
  // Executed: the production row reads Beendet, not vorgemerkt, even
  // though all three cancellation columns are set.
  assert.equal(getSubscriptionStatusLabel(endedSub), "Beendet");
});

/* ══════════════════════════════════════════════════════════════
   7. NOTHING COMMERCIAL MOVED
   ══════════════════════════════════════════════════════════════ */

test("7: this package changed presentation and nothing else", () => {
  // No new endpoint, no migration, no write from the account.
  const pkg = JSON.parse(read("package.json"));
  assert.ok(pkg.scripts.test.includes("tests/account-plans-overview.test.mjs"),
    "this suite is not in the test script");
  // Nothing on the PLANS surface writes. (The address book and the
  // profile page do, as they always have, and are not this package.)
  for (const write of [".update(", ".insert(", ".delete(", ".upsert(", ".rpc("]) {
    for (const [name, slice] of Object.entries({ page, annualPanel, history, annualDetail })) {
      assert.ok(!slice.includes(write), `${name} writes: ${write}`);
    }
  }
  // The eligibility predicates are still the shared ones and still the
  // only thing that decides what may be bought.
  assert.match(portal, /from "\.\.\/lib\/purchaseEligibility"/);
  // The refund, the schedule and the prices are read, never recomputed.
  for (const banned of ["672", "364", "* 28", "28 *", "setDate(", "Math.round"]) {
    const bare = between(portalMarkup, "function PortalSubscriptions()", "function SubscriptionDetail(");
    assert.ok(!bare.includes(banned), `the plans page computes: ${banned}`);
  }
});


/* ══════════════════════════════════════════════════════════════
   6. THE DASHBOARD'S VERGANGEN LIST AGREES WITH THE SUBSCRIPTIONS PAGE

   THE REGRESSION THIS SECTION EXISTS FOR. Section 5 pinned the history
   row on /account/subscriptions and nothing pinned the one on
   /account/dashboard, so the dashboard went on printing plan_end_at. In
   Production the refunded plan therefore read:

       Erstattet 27.09.2027

   - the money came back, beside a date eleven months in the future. Both
   surfaces are asserted here against the SAME helper so they cannot
   drift apart again.
   ══════════════════════════════════════════════════════════════ */

test("6a: the dashboard's refunded annual row shows NO date", () => {
  assert.match(dashboardPast, /const endedAt = annualTerminalEndAt\(v\);/);
  assert.match(dashboardPast, /\{endedAt \? fmtDate\(endedAt\) : ""\}/);
  assert.ok(!dashboardPast.includes("planEndAt"),
    "the dashboard history row shows the date the plan would have run to");
  // Executed against the production row: refunded, never cancelled, so
  // there is no authoritative date and the row renders an empty string.
  const refunded = refundedPlan();
  assert.equal(refunded.paymentStatus, "refunded");
  assert.equal(refunded.cancelledAt, null);
  assert.equal(refunded.completedAt, null);
  assert.equal(refunded.cancelledAt ?? refunded.completedAt ?? null, null);
  // And the value it used to print is exactly the misleading one.
  assert.equal(refunded.planEndAt, PLAN_END_AT);
  assert.match(PLAN_END_AT, /^2027-/);
});

test("6b: the dashboard's refunded annual row still says Erstattet", () => {
  assert.match(dashboardPast, /\{annualStatusLabel\(v\)\}/);
  const label = between(portalCode, "function annualStatusLabel(", NEWLINE + "}");
  assert.match(label, /v\.paymentStatus === "refunded"\) return "Erstattet"/);
  assert.match(dashboardPast, /className="portal-past-state"/);
});

test("6c: both surfaces derive the annual terminal date the same way", () => {
  for (const surface of [dashboardPast, history]) {
    assert.match(surface, /annualTerminalEndAt\(v\)/);
    assert.ok(!surface.includes("planEndAt"));
  }
  // And both derive a SUBSCRIPTION's end the same way, which was already
  // true and must stay true.
  assert.match(dashboardPast, /getEffectiveEndAt\(sub\)/);
  assert.match(history, /getEffectiveEndAt\(sub\)/);
});

test("6d: a completed or cancelled plan keeps its authoritative date", () => {
  const ends = between(portalCode, "function annualTerminalEndAt(", NEWLINE + "}");
  assert.match(ends, /return v\.cancelledAt \?\? v\.completedAt \?\? null;/);
  // Executed: both terminal kinds still produce their own event date, so
  // the fix removes an invented date and no real one.
  const cancelled = buildAnnualPlanAccountView(
    planRow({ status: "cancelled", cancelled_at: "2026-09-30T09:00:00+00:00" }), schedule());
  assert.equal(cancelled.cancelledAt ?? cancelled.completedAt ?? null, "2026-09-30T09:00:00+00:00");
  const completed = buildAnnualPlanAccountView(
    planRow({ status: "completed", completed_at: "2027-09-27T18:12:00+00:00" }), schedule());
  assert.equal(completed.cancelledAt ?? completed.completedAt ?? null, "2027-09-27T18:12:00+00:00");
  // An ENDED SUBSCRIPTION is untouched by this change.
  assert.equal(endedSub.cancelled_at, "2026-09-28T09:00:00+00:00");
});

test("6e: the ACTIVE annual card on the dashboard still promises its run-to date", () => {
  // The fix is scoped to VERGANGEN. A running plan still states when it
  // runs to, how many deliveries and which is next.
  const live = between(dashboard, 'label="AKTIV"', 'label="VERGANGEN"');
  assert.match(live, /Laufzeit bis/);
  assert.match(live, /\{v\.planEndAt \? fmtDate\(v\.planEndAt\) : "—"\}/);
  assert.match(live, /Nächste Lieferung/);
  assert.match(live, /\{v\.fulfilledDeliveries\} von \{v\.deliveryCount\} Lieferungen/);
  // Executed: the live production plan keeps every one of those values.
  const active = buildAnnualPlanAccountView(planRow(), schedule());
  assert.equal(active.status, "active");
  assert.equal(active.planEndAt, PLAN_END_AT);
  assert.equal(active.purchasedAt, PURCHASED_AT);
  assert.equal(active.deliveryCount, ANNUAL_DELIVERY_COUNT);
  assert.ok(isLiveAnnualPlan(active), "the active plan stopped counting as live");
});

test("6f: nothing about money, schedule or eligibility moved", () => {
  // This is a rendering fix. The read model still reports the same
  // figures for the same row, and the refund still shows as an AMOUNT.
  const refunded = refundedPlan();
  assert.equal(refunded.totalGrossCents, TOTAL_GROSS_CENTS);
  assert.equal(refunded.refundedTotalCents, TOTAL_GROSS_CENTS);
  assert.equal(refunded.deliveryCount, ANNUAL_DELIVERY_COUNT);
  assert.equal(refunded.purchasedAt, PURCHASED_AT);
  // A refunded plan is still not live, so it still cannot block a repurchase.
  assert.equal(isLiveAnnualPlan(refunded), false);
  // The dashboard history row invents no figure of its own either.
  for (const promise of ["Offen", "Nächste Lieferung", "Laufzeit bis", "deliveryCount"]) {
    assert.ok(!dashboardPast.includes(promise),
      `the dashboard history row promises: ${promise}`);
  }
});
