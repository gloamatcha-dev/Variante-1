import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ANNUAL_PLAN_ACCOUNT_SELECT,
  ANNUAL_PLAN_DELIVERY_ACCOUNT_SELECT,
  ANNUAL_PLAN_DETAIL_ROUTE_PREFIX,
  annualPlanDetailHref,
  buildAnnualPlanAccountView,
  collectAnnualDeliveryOrderIds,
  pickEarliestUpcomingDelivery,
} from "../lib/annualPlanAccount.ts";
import { DYNAMIC_PREFIXES, INDEXABLE_ROUTES, isKnownRoute } from "../lib/publicRoutes.ts";
import { ANNUAL_LEGACY_DELIVERY_COUNT, ANNUAL_DELIVERY_INTERVAL_DAYS } from "../lib/annualPlanRules.ts";
import { startRenderServer } from "./helpers/renderServer.mjs";

/* ══════════════════════════════════════════════════════════════
   THE PREPAID ANNUAL PLAN, IN THE CUSTOMER ACCOUNT

   SAFE DEFAULT SUITE: the pure read model driven with plain row
   literals, source-level contract checks on the account portal, and
   server rendering of the CURRENT build through the shared harness
   (which strips the service-role key).

   No Supabase client is constructed, no SQL runs, no RPC is invoked, no
   Stripe object exists, no webhook is delivered and no email is sent.
   Nothing here writes anything anywhere.

   ── WHAT WENT WRONG, AND WHAT THIS PROTECTS ───────────────────

   A real annual plan was purchased in production: 30 g, paid once,
   thirteen deliveries, the first one already created. Stripe was right,
   the confirmation mail was right and the admin view was right. The
   CUSTOMER's account was not:

     * /account/dashboard showed a post-checkout banner saying the plan
       was running - and that banner lives on the URL the checkout
       returned with, so it was gone on the next visit.
     * Underneath it, "Nächste Lieferung: Keine geplante Lieferung",
       while annual_plan_deliveries held a dated row for the next box.
       The dashboard asked the subscriptions table and nothing else.
     * Nothing persistent named the plan, and nothing linked to it. The
       only annual surface was a section on /account/subscriptions, and
       the navigation calls that page "Abos".
     * The first delivery's order showed its per-delivery amount beside
       "Bezahlt", on an account that had already paid for the whole year.

   Every test below is one of those four, or one of the guarantees that
   had to survive them: the monthly subscription stays a separate
   contract with its cancellation untouched, and no plan is readable by
   anyone but its owner.
   ══════════════════════════════════════════════════════════════ */

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const NEWLINE = String.fromCharCode(10);
const read = rel => readFileSync(path.join(ROOT, rel), "utf-8");

/** Source with its comment lines dropped, so a "never says X" scan reads
 *  markup rather than the prose explaining why X is absent. */
const withoutComments = source => source
  .split(NEWLINE)
  .filter(line => {
    const t = line.trim();
    return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
  })
  .join(NEWLINE);

const portal = read("app/AccountPortal.tsx");
const portalCode = withoutComments(portal);
const site = read("app/GloaSite.tsx");
const routes = read("lib/publicRoutes.ts");
const migration039 = read("supabase/migrations/039_b2c_annual_plan_foundation.sql");

/** The source between two top-level declarations, comments stripped. */
function between(source, startMarker, endMarker) {
  const at = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, at + startMarker.length);
  assert.ok(at > -1 && end > at, `could not locate ${startMarker} … ${endMarker}`);
  return source.slice(at, end);
}

const dashboard = between(portalCode, "function PrivateDashboard()", "function BusinessDashboard()");
const annualReader = between(portalCode, "function useAnnualPlanViews(", "function AnnualPlanDetail(");
const annualDetail = between(portalCode, "function AnnualPlanDetail(", "function CheckoutReturnBanner()");
const ordersList = between(portalCode, "function PortalOrders()", "function OrderDetail(");
const orderDetail = between(portalCode, "function OrderDetail(", "function SubscriptionStartForm(");
const subsList = between(portalCode, "function PortalSubscriptions()", "function SubscriptionDetail(");
const subDetail = between(portalCode, "function SubscriptionDetail(", "function PortalAddresses()");
/**
 * The annual card on the dashboard.
 *
 * It moved into the AKTIV section when the dashboard was grouped by
 * whether a contract is running, so it is sliced by the map that renders
 * it rather than by a heading of its own.
 */
const dashboardAnnualCard = between(dashboard, "liveAnnualPlans.map(v =>", "liveSubs.length === 0");

const PORT = 8953;
let server;

test.before(async () => {
  server = await startRenderServer(PORT);
});

test.after(() => {
  server?.stop();
});

/* ══════════════════════════════════════════════════════════════
   THE PRODUCTION CONTRACT, AS ROW LITERALS

   The numbers are the ones the live purchase actually produced, so a
   change that would have re-derived any of them fails here with the
   figure a customer read on the page.
   ══════════════════════════════════════════════════════════════ */

const PLAN_ID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const OTHER_PLAN_ID = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const PURCHASED_AT = "2026-09-27T18:12:00+00:00";
const PLAN_END_AT = "2027-09-27T18:12:00+00:00";
const FIRST_DELIVERY_AT = "2026-09-28T04:00:00+00:00";
const SECOND_DELIVERY_AT = "2026-10-26T04:00:00+00:00";
const FIRST_ORDER_ID = "cccccccc-3333-4333-8333-cccccccccccc";

/** 252,07 EUR, once. 13 x 13,49 matcha + 13 x 5,90 shipping. */
const TOTAL_GROSS_CENTS = 25207;
const UNIT_GROSS_CENTS = 1349;
const SHIPPING_PER_DELIVERY_CENTS = 590;

const planRow = (over = {}) => ({
  id: PLAN_ID,
  status: "active",
  payment_status: "paid",
  currency: "EUR",
  delivery_count: ANNUAL_LEGACY_DELIVERY_COUNT,
  catalog_unit_gross_cents: 1499,
  annual_unit_gross_cents: UNIT_GROSS_CENTS,
  shipping_per_delivery_gross_cents: SHIPPING_PER_DELIVERY_CENTS,
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

/**
 * The thirteen rows activation wrote, with the first one already
 * fulfilled and carrying the order it became - exactly the production
 * state: "delivery 1/13 created, next delivery 26.10.2026".
 *
 * The dates after the second are not computed from a cadence here: each
 * is a distinct sortable literal, because the point of these rows is
 * that the account READS a schedule rather than deriving one.
 */
function productionSchedule() {
  const rows = [
    { delivery_number: 1, scheduled_for: FIRST_DELIVERY_AT, state: "fulfilled", fulfilled_at: FIRST_DELIVERY_AT, order_id: FIRST_ORDER_ID },
    { delivery_number: 2, scheduled_for: SECOND_DELIVERY_AT, state: "scheduled", fulfilled_at: null, order_id: null },
  ];
  for (let n = 3; n <= ANNUAL_LEGACY_DELIVERY_COUNT; n++) {
    rows.push({
      delivery_number: n,
      // A stable, ordered, literal date per row. No arithmetic on the
      // cadence, and none on a clock.
      scheduled_for: `2027-${String(n).padStart(2, "0")}-01T04:00:00+00:00`,
      state: "scheduled",
      fulfilled_at: null,
      order_id: null,
    });
  }
  return rows;
}

const productionView = () => buildAnnualPlanAccountView(planRow(), productionSchedule());

/* ══════════════════════════════════════════════════════════════
   1. THE READ MODEL'S NEW ANSWERS
   ══════════════════════════════════════════════════════════════ */

test("1a: the next delivery is the earliest owed across BOTH contracts", () => {
  const annual = { source: "annual_plan", id: PLAN_ID, scheduledFor: SECOND_DELIVERY_AT };
  const later = { source: "subscription", id: "sub-1", scheduledFor: "2026-11-24T04:00:00+00:00" };
  const earlier = { source: "subscription", id: "sub-1", scheduledFor: "2026-10-12T04:00:00+00:00" };

  assert.deepEqual(pickEarliestUpcomingDelivery([later, annual]), annual,
    "the annual delivery lost to a later subscription delivery");
  assert.deepEqual(pickEarliestUpcomingDelivery([earlier, annual]), earlier);
  // And a customer who holds ONLY an annual plan gets an answer at all -
  // the defect this whole package exists for.
  assert.deepEqual(pickEarliestUpcomingDelivery([null, annual]), annual);
});

test("1b: nothing owed is null, and an unusable candidate is never offered", () => {
  assert.equal(pickEarliestUpcomingDelivery([]), null);
  assert.equal(pickEarliestUpcomingDelivery(null), null);
  assert.equal(pickEarliestUpcomingDelivery([null, undefined]), null);
  for (const broken of [
    { source: "annual_plan", id: "", scheduledFor: SECOND_DELIVERY_AT },
    { source: "annual_plan", id: PLAN_ID, scheduledFor: "" },
    { source: "annual_plan", id: PLAN_ID, scheduledFor: null },
    { source: "invented", id: PLAN_ID, scheduledFor: SECOND_DELIVERY_AT },
  ]) {
    assert.equal(pickEarliestUpcomingDelivery([broken]), null, JSON.stringify(broken));
  }
});

test("1c: a tie is decided by the caller's order, not by chance", () => {
  const a = { source: "subscription", id: "sub-1", scheduledFor: SECOND_DELIVERY_AT };
  const b = { source: "annual_plan", id: PLAN_ID, scheduledFor: SECOND_DELIVERY_AT };
  assert.deepEqual(pickEarliestUpcomingDelivery([a, b]), a);
  assert.deepEqual(pickEarliestUpcomingDelivery([b, a]), b);
});

test("1d: the orders a plan already paid for are collected from its own rows", () => {
  const view = productionView();
  assert.deepEqual(collectAnnualDeliveryOrderIds([view]), [FIRST_ORDER_ID],
    "the fulfilled delivery's order was not recognised as prepaid");
  // Deliveries that have not become orders contribute nothing, and one
  // order is listed once however many views carry it.
  assert.deepEqual(collectAnnualDeliveryOrderIds([view, view]), [FIRST_ORDER_ID]);
  assert.deepEqual(collectAnnualDeliveryOrderIds([]), []);
  assert.deepEqual(collectAnnualDeliveryOrderIds(null), []);
  assert.deepEqual(collectAnnualDeliveryOrderIds([{ deliveries: [{ orderId: null }] }]), []);
});

test("1e: the plan's href is the route, and a blank id gets no link at all", () => {
  assert.equal(annualPlanDetailHref(PLAN_ID), `/account/annual-plans/${PLAN_ID}`);
  for (const nothing of ["", "   ", null, undefined]) {
    assert.equal(annualPlanDetailHref(nothing), "", JSON.stringify(nothing));
  }
});

test("1f: the route the read model names is the route that exists", () => {
  assert.equal(ANNUAL_PLAN_DETAIL_ROUTE_PREFIX, "account/annual-plans/");
  const entry = DYNAMIC_PREFIXES.find(p => p.prefix === ANNUAL_PLAN_DETAIL_ROUTE_PREFIX);
  assert.ok(entry, "the plan page's prefix is not a known dynamic route");
  assert.equal(entry.segments, 3, "the plan page took a shape other than /account/annual-plans/<id>");
  assert.equal(isKnownRoute(`${ANNUAL_PLAN_DETAIL_ROUTE_PREFIX}${PLAN_ID}`), true);
  // The shapes around it are NOT routes: there is no list page, and the
  // tail is one segment.
  assert.equal(isKnownRoute("account/annual-plans"), false);
  assert.equal(isKnownRoute("account/annual-plans/a/b"), false);
  // A private page is never offered to a search engine.
  assert.ok(!INDEXABLE_ROUTES.some(r => r.startsWith("account")), "an account route became indexable");
});

/* ══════════════════════════════════════════════════════════════
   2. THE DASHBOARD
   ══════════════════════════════════════════════════════════════ */

test("2a: the dashboard reads annual plans, through the one shared reader", () => {
  assert.match(dashboard, /const \{ views: annualViews, loading: annualLoading \} = useAnnualPlanViews\(\);/,
    "the dashboard stopped reading the annual plans");
  // And it does not open a second connection of its own to do it.
  assert.ok(!dashboard.includes('from("annual_plans")'), "the dashboard selects annual columns itself");
  assert.ok(!dashboard.includes('from("annual_plan_deliveries")'));
  // The reader is the two-read, RLS-scoped one, with the read model's
  // own column lists.
  assert.match(annualReader, /\.select\(ANNUAL_PLAN_ACCOUNT_SELECT\)/);
  assert.match(annualReader, /\.select\(ANNUAL_PLAN_DELIVERY_ACCOUNT_SELECT\)/);
  assert.equal([...annualReader.matchAll(/await supabase/g)].length, 2, "the shared reader became an N+1");
});

test("2b: a running plan gets a persistent place of its own", () => {
  // Under AKTIV, beside the running subscription and above the
  // VERGANGEN list - not as a post-checkout banner, and not inside the
  // Abo card.
  assert.match(dashboard, /label="AKTIV"/, "the dashboard has no active section");
  assert.match(dashboard, /label="VERGANGEN"/, "the dashboard has no history section");
  assert.match(dashboard, /liveAnnualPlans\.map\(v =>/, "the annual card is not rendered from the live plans");
  // WHICH plans count as running is lib/purchaseEligibility.ts's answer,
  // the same one the checkout route refuses a duplicate with - never a
  // status string written out here.
  assert.match(dashboard, /const liveAnnualPlans = annualViews\.filter\(isLiveAnnualPlan\);/,
    "a plan that is over, cancelled or refunded could be shown as running");
  assert.match(dashboard,
    /const pastAnnualPlans = annualViews\.filter\(v => !isLiveAnnualPlan\(v\) && v\.status !== "pending"\);/,
    "finished plans are not kept as history");
});

test("2c: the card survives a reload, because it is built from rows", () => {
  /*
    THE DEFECT. What the customer DID see after paying was
    CheckoutReturnBanner, which resolves its state from the annualPlanId
    the Stripe return URL carried - so it vanished with that URL. The
    persistent card must not depend on any of that.
  */
  for (const fromTheUrl of [
    "ANNUAL_CHECKOUT_RETURN_PARAM", "annualState", "resolveAnnualCheckoutReturnState",
    "searchParams", "location.search",
  ]) {
    assert.ok(!dashboard.includes(fromTheUrl), `the dashboard's annual card depends on the return URL: ${fromTheUrl}`);
  }
  // The banner still exists, in the shell, doing its own job.
  assert.match(portal, /<CheckoutReturnBanner \/>/);
});

test("2d: every figure on the card is the view's, and none is computed", () => {
  for (const fromTheView of [
    "{v.deliveryCount} Lieferungen",
    "{v.fulfilledDeliveries} von {v.deliveryCount} Lieferungen",
    "<dt>Einmalig bezahlt</dt><dd>{fmtCents(v.totalGrossCents)} €</dd>",
    "<dt>Nächste Lieferung</dt><dd>{fmtDate(v.nextDelivery.scheduledFor)}</dd>",
    "<dt>Laufzeit bis</dt><dd>{v.planEndAt ? fmtDate(v.planEndAt) : \"—\"}</dd>",
    "{annualStatusLabel(v)}",
  ]) {
    assert.ok(dashboardAnnualCard.includes(fromTheView), `the card stopped rendering: ${fromTheView}`);
  }
  // No amount, date, count or percentage baked into the markup.
  assert.ok(!/\d+[.,]\d{2}\s*€/.test(dashboardAnnualCard), "the card renders a hardcoded amount");
  assert.ok(!/\d{2}\.\d{2}\.\d{4}/.test(dashboardAnnualCard), "the card renders a hardcoded date");
  assert.ok(!/\b\d{1,3}\s?%/.test(dashboardAnnualCard), "the card renders a hardcoded percentage");
  // AND THE CADENCE IS THE PLAN'S OWN, not a module-wide sentence.
  //
  // Until migration 069 this was a constant, because there was one
  // contract. There are now two, and a constant here would describe a
  // v1 plan with v2's rhythm - thirteen deliveries labelled "monatlich".
  // annualCadenceLabel reads the row's own schedule_model.
  assert.match(dashboardAnnualCard, /\{annualCadenceLabel\(v\)\}/);
  assert.match(portalCode, /function annualCadenceLabel\(v: \{[^}]*\}\): string \{/);
  assert.match(portalCode, /return annualCadenceLabelOf\(v\);/);
  // The legacy cadence itself is unchanged: four weeks, for v1 plans.
  assert.equal(ANNUAL_DELIVERY_INTERVAL_DAYS / 7, 4, "the legacy annual cadence is no longer four weeks");
});

test("2e: the card leads somewhere, and that somewhere is the plan's page", () => {
  assert.match(dashboardAnnualCard, /<a href=\{annualPlanDetailHref\(v\.id\)\} className="portal-action">JAHRESPLAN ANSEHEN<\/a>/);
});

test("2e2: with nothing running, the dashboard offers each product back", () => {
  // The two repurchase CTAs, on exactly the condition the checkout
  // routes use - no LIVE contract of that kind. An ended abo and a
  // refunded plan block nothing, so both offers return by themselves.
  assert.match(dashboard, /liveSubs\.length === 0 && \(/);
  assert.match(dashboard, /ABO STARTEN/);
  assert.match(dashboard, /liveAnnualPlans\.length === 0 && \(/);
  assert.match(dashboard, /JAHRESPLAN WÄHLEN/);
  // And history is still reachable rather than hidden.
  assert.match(dashboard, /pastSubs\.map\(sub =>/);
  assert.match(dashboard, /pastAnnualPlans\.map\(v =>/);
});

test("2f: \"Nächste Lieferung\" asks both contracts and prefers neither", () => {
  assert.match(dashboard, /const nextDelivery = pickEarliestUpcomingDelivery\(\[/);
  assert.match(dashboard, /source: "subscription" as const/);
  assert.match(dashboard, /source: "annual_plan" as const/);
  assert.match(dashboard, /scheduledFor: v\.nextDelivery\.scheduledFor/,
    "the annual candidate stopped using the durable schedule row");
  // It waits for BOTH answers before concluding that nothing is due, so
  // the empty state can no longer win a race against the annual read.
  assert.match(dashboard, /const contractsLoading = subLoading \|\| annualLoading;/);
  assert.match(dashboard, /\{contractsLoading \?/);
  // The empty state itself is unchanged and still reachable.
  assert.match(dashboard, /Keine geplante Lieferung\./);
});

test("2g: an annual delivery is never announced as an Abo", () => {
  const annualBranch = between(dashboard, "nextDelivery && nextDeliveryPlan ?", "nextDelivery && nextDeliverySub ?");
  assert.match(annualBranch, /Jahresplan/);
  assert.match(annualBranch, /annualPlanDetailHref\(nextDeliveryPlan\.id\)/);
  for (const monthly of ["ABO ANSEHEN", "SUBSCRIPTION_CADENCE_LABEL", "subPlanName"]) {
    assert.ok(!annualBranch.includes(monthly), `the annual delivery borrows the Abo's ${monthly}`);
  }
});

test("2h: the production plan reads as 1 of 13, at 252,07 €, next on the 26th", () => {
  const view = productionView();
  assert.equal(view.deliveryCount, 13);
  assert.equal(view.fulfilledDeliveries, 1, "the created delivery was not counted");
  assert.equal(view.totalGrossCents, TOTAL_GROSS_CENTS, "the prepaid total changed");
  assert.equal(view.nextDelivery.scheduledFor, SECOND_DELIVERY_AT);
  assert.equal(view.nextDelivery.deliveryNumber, 2);
  assert.equal(view.planEndAt, PLAN_END_AT);
  assert.equal(view.purchasedAt, PURCHASED_AT);
  assert.equal(view.scheduleComplete, true);
  assert.equal(view.prepaid, true);
  assert.equal(view.autoRenews, false);
  assert.equal(view.product.variantLabel, "30 g");
  // 13,49 + 5,90 is what one delivery's ORDER is worth. The plan's own
  // total is not that figure and never becomes it.
  assert.equal(UNIT_GROSS_CENTS + SHIPPING_PER_DELIVERY_CENTS, 1939);
  assert.notEqual(view.totalGrossCents, 1939);
});

test("2i: a fulfilled delivery is progress; a claimed one is not", () => {
  const claimed = productionSchedule().map(d => d.delivery_number === 2 ? { ...d, state: "claimed" } : d);
  const view = buildAnnualPlanAccountView(planRow(), claimed);
  assert.equal(view.fulfilledDeliveries, 1, "a box being prepared was counted as delivered");
  assert.equal(view.nextDelivery.deliveryNumber, 2);
  assert.equal(view.nextDelivery.state, "claimed");
});

/* ══════════════════════════════════════════════════════════════
   3. THE PLAN'S OWN PAGE
   ══════════════════════════════════════════════════════════════ */

test("3a: the route exists, renders, and is never offered to a crawler", async () => {
  const { status, html } = await server.getHtml(`/account/annual-plans/${PLAN_ID}`);
  assert.equal(status, 200, "the plan page is a 404");
  assert.match(html, /<title>Jahresplan · GLOA<\/title>/);
  assert.match(html, /noindex/, "a private account page was offered to a search engine");
});

test("3b: only the three-segment shape exists", async () => {
  for (const missing of ["/account/annual-plans", "/account/annual-plans/a/b"]) {
    const { status } = await server.getHtml(missing);
    assert.equal(status, 404, `${missing} answers 200`);
  }
});

test("3c: the renderer serves the route the route list knows", () => {
  assert.match(site, /route\.startsWith\("account\/annual-plans\/"\)&&route\.split\("\/"\)\.length===3/);
  assert.match(site, /page="annual-plan-detail" annualPlanId=\{route\.split\("\/"\)\[2\]\}/);
  assert.match(routes, /\{ prefix: "account\/annual-plans\/", segments: 3 \}/);
  assert.match(portalCode, /\{page === "annual-plan-detail" && <AnnualPlanDetail annualPlanId=\{annualPlanId!\} \/>\}/);
});

test("3d: the page states what was bought, what it cost and what is owed", () => {
  for (const fact of [
    "<span>Produkt</span>",
    "<span>Status</span>",
    "<span>Gekauft am</span>",
    "<span>Lieferungen</span>",
    "<span>Bereits ausgelöst</span>",
    "<span>Nächste Lieferung</span>",
    "<span>Laufzeit bis</span>",
    "<span>Einmalig bezahlt</span>",
  ]) {
    assert.ok(annualDetail.includes(fact), `the plan page stopped stating: ${fact}`);
  }
  for (const value of [
    "{fmtCents(plan.totalGrossCents)}",
    "{plan.fulfilledDeliveries} von {plan.deliveryCount}",
    "{fmtDate(plan.nextDelivery.scheduledFor)}",
    "{plan.planEndAt ? fmtDate(plan.planEndAt) : \"—\"}",
    "{plan.purchasedAt ? fmtDate(plan.purchasedAt) : \"—\"}",
  ]) {
    assert.ok(annualDetail.includes(value), `the plan page stopped rendering: ${value}`);
  }
  // The schedule is shown from the rows, and each delivered box links to
  // the ordinary order it became rather than to a second view of one.
  assert.match(annualDetail, /plan\.deliveries\.map\(d =>/);
  assert.match(annualDetail, /href=\{`\/account\/orders\/\$\{d\.orderId\}`\}/);
  // An incomplete schedule says so; it is never padded to thirteen.
  assert.match(annualDetail, /!plan\.scheduleComplete/);
});

test("3e: it is paid once and renews never, in the page's own words", () => {
  assert.match(annualDetail, /Einmalig bezahlt, keine automatische Verlängerung\./);
  // NOTHING on any annual surface suggests a recurring charge.
  for (const surface of [annualDetail, dashboardAnnualCard]) {
    for (const wrong of [
      "verlängert sich", "automatisch verlängert", "Verlängerung des Plans",
      "monatlich", "Kündigungsfrist", "kündigen", "Kündigung",
      "nächste Abbuchung", "wird erneut abgebucht",
    ]) {
      assert.ok(!surface.includes(wrong), `an annual surface says: ${wrong}`);
    }
  }
});

test("3f: the owner opens it; anybody else gets the same answer a typo gets", () => {
  /*
    THE ID SELECTS, IT DOES NOT AUTHORIZE.

    The page never builds a query from the URL - the reader it uses takes
    no plan id at all - so the set it searches is the set RLS already
    proved belongs to the signed-in customer. A stranger's uuid therefore
    matches nothing in that set, and renders the SAME neutral screen a
    uuid that never existed renders. Ownership is decided in PostgreSQL
    by migration 039's policies, not by this component.
  */
  assert.match(annualDetail, /const plan = views\.find\(v => v\.id === annualPlanId\) \?\? null;/);
  assert.match(annualDetail, /Jahresplan nicht gefunden\./);
  assert.ok(!annualReader.includes('.eq("id"'), "the annual reader filters by an id from the URL");
  assert.ok(!annualReader.includes("annualPlanId"), "the annual reader was handed the URL's id");
  assert.ok(!annualDetail.includes("fetch("), "the plan page asks a server about an id");

  // Executed: the same set, two different ids, two different answers.
  const mine = [productionView()];
  assert.equal(mine.find(v => v.id === PLAN_ID).id, PLAN_ID);
  assert.equal(mine.find(v => v.id === OTHER_PLAN_ID) ?? null, null,
    "a plan that is not the customer's resolved to something");
});

test("3g: the browser is never sent a payment identity to begin with", () => {
  for (const secret of [
    "stripe_payment_intent_id", "stripe_checkout_session_id",
    "payment_checkout_attempt_id", "purchase_confirmation_email",
    "customer_snapshot", "shipping_address_snapshot", "tax_snapshot", "user_id",
  ]) {
    assert.ok(!ANNUAL_PLAN_ACCOUNT_SELECT.includes(secret), `the account select asks for ${secret}`);
    assert.ok(!annualDetail.includes(secret), `the plan page reads ${secret}`);
  }
  assert.ok(!ANNUAL_PLAN_DELIVERY_ACCOUNT_SELECT.includes("checkout_attempt_id"));
  assert.ok(!ANNUAL_PLAN_DELIVERY_ACCOUNT_SELECT.includes("claimed_at"));
  // And the portal holds no service-role anything.
  for (const banned of ["SUPABASE_SECRET_KEY", "service_role", "getSupabaseAdmin", "serviceRole"]) {
    assert.ok(!portal.includes(banned), `the portal reaches for ${banned}`);
  }
});

test("3h: the plan page is B2C, and is routed away from a business account", () => {
  assert.ok(portal.includes('if (!loading && page === "annual-plan-detail" && customerType === "business")'),
    "a business account can open the annual plan page");
  // The EXISTING private-only guard is untouched by that addition.
  assert.ok(portal.includes('if (!loading && (page === "subscriptions" || page === "subscription-detail") && customerType === "business")'),
    "the subscription guard changed");
});

test("3i: a delivery's durable state is translated, never promoted", () => {
  const labels = between(portalCode, "const ANNUAL_DELIVERY_STATE_LABEL", "};");
  assert.match(labels, /claimed: "Wird vorbereitet"/, "a claimed box is reported as shipped");
  assert.match(labels, /scheduled: "Geplant"/);
  assert.match(labels, /cancelled: "Storniert"/);
  for (const promise of ["Geliefert", "Zugestellt", "Versendet", "Angekommen"]) {
    assert.ok(!labels.includes(promise), `a delivery state promises ${promise}`);
  }
  // An unknown word fails closed rather than being guessed into one.
  assert.match(annualDetail, /ANNUAL_DELIVERY_STATE_LABEL\[d\.state\] \?\? "Unbekannt"/);
});

/* ══════════════════════════════════════════════════════════════
   4. THE PREPAID DELIVERY ORDER
   ══════════════════════════════════════════════════════════════ */

test("4a: the per-delivery amount is the database's, and stays the database's", () => {
  /*
    WHY 19,39 € IS CORRECT.

    Migration 039 creates one ORDINARY order per delivery, against a
    synthetic paid attempt whose expected total is
    annual_unit_gross_cents + shipping_per_delivery_gross_cents. That is
    the per-delivery allocation of a plan that was paid in full once -
    13,49 + 5,90 - and it is what the accounting needs the order to say.
    Nothing in this package changes it.
  */
  assert.match(migration039,
    /v_expected := v_plan\.annual_unit_gross_cents \+ v_plan\.shipping_per_delivery_gross_cents;/,
    "the per-delivery allocation changed");
  // No customer-facing surface recomputes or rewrites an order amount.
  for (const arithmetic of [
    "total_gross_cents =", "total_gross_cents:", "* 13", "/ 13",
    ".update(", ".insert(", ".upsert(", ".delete(",
  ]) {
    assert.ok(!ordersList.includes(arithmetic), `the order list writes or recomputes money: ${arithmetic}`);
    assert.ok(!annualDetail.includes(arithmetic), `the plan page writes or recomputes money: ${arithmetic}`);
  }
});

test("4b: but it is never presented as a second charge", () => {
  assert.match(portalCode, /const ANNUAL_PREPAID_ORDER_NOTE = "Im Jahresplan enthalten";/);
  // All three surfaces that show one of these orders say so.
  for (const [name, surface] of Object.entries({ dashboard, ordersList, orderDetail })) {
    assert.ok(surface.includes("ANNUAL_PREPAID_ORDER_NOTE"),
      `${name} shows an annual delivery's amount without saying it was prepaid`);
  }
  assert.match(orderDetail, /Der Betrag ist Teil der einmaligen/);
  assert.match(orderDetail, /es wurde dafür nichts erneut abgebucht\./);
});

test("4c: an order is only called prepaid when a delivery actually says so", () => {
  assert.match(dashboard, /const prepaidOrderIds = collectAnnualDeliveryOrderIds\(annualViews\);/);
  assert.match(dashboard, /latestOrder && prepaidOrderIds\.includes\(latestOrder\.id\)/);
  assert.match(ordersList, /prepaidOrderIds\.includes\(o\.id\)/);
  assert.match(orderDetail, /collectAnnualDeliveryOrderIds\(annualViews\)\.includes\(orderId\)/);
  // Executed: an ordinary order is not covered by anything.
  const ids = collectAnnualDeliveryOrderIds([productionView()]);
  assert.equal(ids.includes(FIRST_ORDER_ID), true);
  assert.equal(ids.includes("dddddddd-4444-4444-8444-dddddddddddd"), false);
});

/* ══════════════════════════════════════════════════════════════
   5. THE MONTHLY SUBSCRIPTION IS A DIFFERENT CONTRACT
   ══════════════════════════════════════════════════════════════ */

test("5a: the scheduled cancellation is untouched, engine and all", () => {
  for (const kept of [
    "canRequestSubscriptionCancellation",
    "getCancellationCutoffAt",
    "getCancellationPreview",
    "getEffectiveEndAt",
    "/api/subscriptions/cancel",
    "cancellation_effective_at",
  ]) {
    assert.ok(subDetail.includes(kept) || portalCode.includes(kept),
      `the subscription cancellation lost: ${kept}`);
  }
  // The portal still asks the server rather than deciding locally, and
  // still re-reads the row instead of inventing the outcome.
  assert.match(subDetail, /const res = await fetch\("\/api\/subscriptions\/cancel"/);
  assert.match(subDetail, /const refreshed = await fetchSubscription\(\);/);
});

test("5b: no annual surface can cancel, end or refund anything", () => {
  for (const [name, surface] of Object.entries({ annualDetail, annualReader, dashboardAnnualCard })) {
    for (const write of [
      "/api/subscriptions/cancel", "cancel_at_period_end", "refunds.create",
      ".update(", ".insert(", ".delete(", ".rpc(",
    ]) {
      assert.ok(!surface.includes(write), `${name} reaches a write path: ${write}`);
    }
  }
});

test("5c: the two contracts stay side by side, never merged", () => {
  // The dashboard still renders the subscription from the subscription
  // row and the plan from the plan view; grouping them by whether they
  // are running did not merge them into one product.
  assert.match(dashboard, /subPlanName\(sub\)/);
  assert.match(dashboard, /getSubscriptionStatusLabel\(sub\)/);
  assert.match(dashboard, /annualStatusLabel\(v\)/);
  // An annual plan is not in the Abo list, and an Abo is not in the
  // annual section: each list maps only its own rows.
  assert.ok(!subsList.includes("annualViews"), "an annual plan leaked into the Abo list");
  assert.ok(!subsList.includes("buildAnnualPlanAccountView"));
  assert.ok(!annualDetail.includes("SubscriptionRow"), "the plan page renders a subscription row");
  assert.ok(!annualDetail.includes("SUBSCRIPTION_SELECT"));
  // And the annual plan is reachable WITHOUT the Abo page, which is the
  // navigation complaint this package answers.
  assert.match(dashboard, /annualPlanDetailHref/);
});

/* ══════════════════════════════════════════════════════════════
   6. OWNERSHIP IS STILL THE DATABASE'S
   ══════════════════════════════════════════════════════════════ */

test("6a: both annual tables are still scoped to the signed-in user", () => {
  assert.match(migration039, /alter table public\.annual_plans\s+enable row level security;/);
  assert.match(migration039, /alter table public\.annual_plan_deliveries\s+enable row level security;/);
  assert.match(migration039, /using \(auth\.uid\(\) = user_id\)/);
  assert.match(migration039, /where p\.id = annual_plan_deliveries\.annual_plan_id/);
  assert.match(migration039, /and p\.user_id = auth\.uid\(\)/);
  // SELECT is the only policy either table has: there is no INSERT,
  // UPDATE or DELETE policy for any browser role, so RLS refuses every
  // write from the account regardless of what a grant says.
  const policyKinds = [...migration039.matchAll(
    /create policy [^;]*?on public\.(annual_plans|annual_plan_deliveries) for (select|insert|update|delete)/g
  )].map(m => m[2]);
  assert.equal(policyKinds.length, 2, "the two annual read policies are not both there");
  assert.deepEqual([...new Set(policyKinds)], ["select"],
    "an annual table gained a policy that is not a read");
  const anonGrants = [...migration039.matchAll(/^grant [^;]*to anon;/gm)];
  assert.deepEqual(anonGrants, [], "anon was granted something on an annual table");
});

test("6b: this package added no endpoint, no migration and no table", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.ok(pkg.scripts.test.includes("tests/account-annual-plan.test.mjs"),
    "this suite is not in the test script");
  /*
    The account area reads its own rows with the customer's client and
    maps them with pure leaves. That is the architecture, and this
    package did not add a second one: the ONE annual endpoint the portal
    has ever called is the checkout session that STARTS a plan, which
    predates all of this, and neither the reader nor the plan page nor
    the dashboard card calls anything at all.
  */
  const annualEndpoints = [...portalCode.matchAll(/"(\/api\/annual-plan\/[^"]*)"/g)].map(m => m[1]);
  assert.deepEqual([...new Set(annualEndpoints)], ["/api/annual-plan/checkout/session"],
    "the portal gained an annual endpoint");
  for (const [name, surface] of Object.entries({ annualReader, annualDetail, dashboardAnnualCard })) {
    assert.ok(!surface.includes("fetch("), `${name} calls a server`);
  }
  assert.match(portalCode, /import \{ supabase \} from "\.\.\/lib\/supabase"/);
});
