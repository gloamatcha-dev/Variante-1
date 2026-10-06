import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  TERMINATION_ENTRY_LABEL,
  TERMINATION_CONFIRM_LABEL,
  resolveTerminationOutcome,
  terminateAnnualPlanOrdinary,
  terminateExtraordinary,
} from "../lib/terminationRequest.ts";
import { isKnownRoute, ROUTES, INDEXABLE_ROUTES } from "../lib/publicRoutes.ts";
import { isLiveAnnualPlan } from "../lib/purchaseEligibility.ts";
import { canRequestSubscriptionCancellation } from "../lib/subscriptionCancellationRules.ts";

/*
  ══════════════════════════════════════════════════════════════
  PLAN-CONTEXTUAL CANCELLATION
  ══════════════════════════════════════════════════════════════

  Both GLOA contracts can now be ended from the plan the customer is
  actually looking at, and NEITHER of them grew an engine to do it:

    4-WEEK ABO      the card names ABO KÜNDIGEN and links to the
                    cancellation section of that abo's own detail page,
                    where the existing POST /api/subscriptions/cancel and
                    the existing 14-day rules already lived.

    JAHRESPLAN      the card and the plan page name JAHRESPLAN KÜNDIGEN
                    and submit to the existing POST /api/termination, the
                    BGB 312k route, which gained a second way to IDENTIFY
                    a contract and no new way to decide anything.

  ── WHAT THIS SUITE IS GUARDING ───────────────────────────────

  1. The public § 312k page keeps working WITHOUT a login. The account
     buttons are an additional way in, never a replacement - BGB 312k
     Abs. 2 Satz 1 wants the button "ständig verfügbar sowie unmittelbar
     und leicht erreichbar".

  2. An ordinary annual termination moves NO money and stops NO delivery.
     The plan was paid once for a fixed term that ends by itself, so the
     only honest thing a termination can do is be recorded against that
     existing end date.

  3. Authorization is the SERVER's. The browser sends a plan id; the route
     re-reads that plan by id AND user_id before it resolves anything.

  4. A contract that is already over offers no cancellation, and the route
     refuses one even if a request arrives anyway.
*/

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf8");

const TERMINATION_ROUTE = read("app/api/termination/route.ts");
const CANCEL_ROUTE = read("app/api/subscriptions/cancel/route.ts");
const PORTAL = read("app/AccountPortal.tsx");
const SITE = read("app/GloaSite.tsx");
const CHROME = read("app/Chrome.tsx");
const ROUTES_SRC = read("lib/publicRoutes.ts");

/** Source between two markers, so an assertion can name one component. */
function between(source, start, end) {
  const a = source.indexOf(start);
  assert.ok(a > -1, `marker not found: ${start}`);
  const b = source.indexOf(end, a + start.length);
  assert.ok(b > -1, `marker not found: ${end}`);
  return source.slice(a, b);
}

/**
 * The executable region: this repository's suites read code, not prose.
 *
 * BLOCK COMMENTS ARE STRIPPED TOO, which the older line-based strippers in
 * this repository do not do. It matters here: the slices below end at the
 * NEXT function, so they pick up that function's docblock - and one of
 * those legitimately explains that the page makes no Stripe call. Scanning
 * prose for a banned word finds the sentence promising not to do the thing.
 */
const codeOnly = src => src
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split(/\r?\n/).filter(l => !l.trim().startsWith("//")).join("\n");

const PANEL = between(PORTAL, "function AnnualPlanTerminationPanel(", "function AnnualPlanDetail(");
const ANNUAL_DETAIL = between(PORTAL, "function AnnualPlanDetail(", "function CheckoutReturnBanner()");
const ANNUAL_LIST = between(PORTAL, "function PortalAnnualPlans(", "function annualStatusLabel(");
const SUB_LIST = between(PORTAL, "function PortalSubscriptions(", "function PortalPastPlans(");
const SUB_DETAIL = between(PORTAL, "function SubscriptionDetail(", "function PortalAddresses(");

const UUID = "11111111-1111-1111-1111-111111111111";

/* ══════════════════════════════════════════════════════════════
   1. THE PUBLIC § 312k SURFACE IS UNTOUCHED
   ══════════════════════════════════════════════════════════════ */

test("1: /kuendigung still exists, is indexable and needs no account", () => {
  assert.ok(ROUTES.includes("kuendigung"), "the statutory page left the route list");
  assert.ok(INDEXABLE_ROUTES.includes("kuendigung"), "the statutory page became unindexable");
  assert.equal(isKnownRoute("kuendigung"), true);
  // It is reachable from the footer of every page, which is what
  // "ständig verfügbar" means in practice.
  assert.ok(CHROME.includes(TERMINATION_ENTRY_LABEL),
    "the Kündigungsbutton is no longer reachable from the footer");
  // And the page itself still renders the public form.
  assert.ok(SITE.includes("<TerminationForm/>"), "the public page lost its form");
  // NOTHING on that page asks for a session.
  const page = between(SITE, 'if(route==="kuendigung"){', "<TerminationForm/>");
  for (const gated of ["useAuth", "access_token", "Bearer", "Bitte melde dich an"]) {
    assert.ok(!page.includes(gated), `the public page requires ${gated}`);
  }
});

test("1b: the account points AT the public page rather than replacing it", () => {
  assert.ok(ANNUAL_DETAIL.includes('href="/kuendigung"'),
    "the plan page does not name the statutory surface");
});

/* ══════════════════════════════════════════════════════════════
   2. THE 4-WEEK ABO: DISCOVERABLE, AND THE SAME ENGINE
   ══════════════════════════════════════════════════════════════ */

test("2: the active abo card names its cancellation and carries its own id", () => {
  assert.ok(SUB_LIST.includes("ABO KÜNDIGEN"), "the abo card does not name the cancellation");
  // The id in the href is the card's own subscription, so the action can
  // only ever reach that contract.
  assert.match(SUB_LIST, /href=\{`\/account\/subscriptions\/\$\{s\.id\}#kuendigung`\}/);
  // Offered only when the SHARED rule says the server would accept it, so
  // a visible action cannot lead to a refusal.
  assert.match(SUB_LIST, /\{canRequestSubscriptionCancellation\(s\) && \(/);
});

test("2b: the list links to the engine and never reimplements it", () => {
  assert.ok(!SUB_LIST.includes("/api/subscriptions/cancel"),
    "the list submits a cancellation itself");
  assert.ok(!codeOnly(SUB_LIST).includes("fetch("), "the list calls a server");
  for (const borrowed of ["cutoffAt", "effectiveCancelAt", "resolveCancellationSchedule"]) {
    assert.ok(!SUB_LIST.includes(borrowed), `the list recomputes ${borrowed}`);
  }
});

test("2c: the section it points at is the EXISTING cancellation", () => {
  assert.ok(SUB_DETAIL.includes('<section className="order-detail-section" id="kuendigung">'),
    "the cancellation section is not linkable");
  // Still the one endpoint, still gated by the one rule, still a second
  // step before anything is submitted.
  assert.match(SUB_DETAIL, /fetch\("\/api\/subscriptions\/cancel"/);
  assert.match(SUB_DETAIL, /const canCancel = canRequestSubscriptionCancellation\(sub\);/);
  assert.match(SUB_DETAIL, /body: JSON\.stringify\(\{ subscriptionId \}\)/);
  assert.ok(SUB_DETAIL.includes("Abo wirklich kündigen?"), "the confirmation step is gone");
  // The route it calls is unchanged by this package.
  assert.match(CANCEL_ROUTE, /verifyBearerUser/);
});

test("2d: the rhythm is still every four weeks, never monthly", () => {
  /*
    THE EXECUTABLE REGION ONLY. Both surfaces carry long comments that
    explain WHY the word is wrong - "Naming the panel Monatsabo would have
    put the wrong promise in the largest type on the page" - so scanning
    the prose finds the warning rather than a violation.
  */
  for (const surface of [SUB_LIST, SUB_DETAIL]) {
    const code = codeOnly(surface);
    assert.ok(!/monatlich/i.test(code), "an abo surface says monatlich");
    assert.ok(!code.includes("Monatsabo"), "an abo surface says Monatsabo");
  }
  assert.ok(SUB_LIST.includes("SUBSCRIPTION_CADENCE_LABEL"),
    "the card stopped reading the cadence constant");
});

test("2e: an abo that may not be cancelled is offered no action", () => {
  // The predicate is the gate, and it refuses the states it always did.
  // The full row shape the rules module reads - every field, so an
  // absent one cannot be mistaken for a decision.
  const live = {
    id: UUID,
    status: "active",
    current_period_end: "2027-01-01T00:00:00.000Z",
    next_delivery_at: "2027-01-01T00:00:00.000Z",
    cancellation_requested_at: null,
    cancellation_effective_at: null,
    cancelled_at: null,
  };
  assert.equal(canRequestSubscriptionCancellation(live), true);
  assert.equal(canRequestSubscriptionCancellation({ ...live, status: "cancelled" }), false);
  /*
    A STANDING CANCELLATION IS BOTH HALVES: the request AND the date it
    was promised. A request with no effective date is not yet a schedule,
    and the module deliberately still offers the control for it rather
    than stranding an abo whose date never got written.
  */
  assert.equal(canRequestSubscriptionCancellation({
    ...live,
    cancellation_requested_at: "2026-01-01T00:00:00.000Z",
    cancellation_effective_at: "2027-01-01T00:00:00.000Z",
  }), false, "an abo with a standing cancellation is offered a second one");
  // And an abo that has actually ended offers nothing either.
  assert.equal(canRequestSubscriptionCancellation({
    ...live, cancelled_at: "2026-02-01T00:00:00.000Z",
  }), false, "an ended abo is offered a cancellation");
});

/* ══════════════════════════════════════════════════════════════
   3. THE JAHRESPLAN: AN ACTION WHERE THERE WAS NONE
   ══════════════════════════════════════════════════════════════ */

test("3: the annual card and the plan page both name JAHRESPLAN KÜNDIGEN", () => {
  assert.ok(ANNUAL_LIST.includes("JAHRESPLAN KÜNDIGEN"),
    "the annual card does not name its termination");
  assert.ok(ANNUAL_LIST.includes("#kuendigung"), "the annual action does not land on the control");
  assert.ok(PANEL.includes("Jahresplan kündigen"), "the panel has no entry control");
  // The plan page mounts the panel, in a section the lists can link to.
  assert.ok(ANNUAL_DETAIL.includes('id="kuendigung"'), "the plan page section is not linkable");
  assert.ok(ANNUAL_DETAIL.includes("<AnnualPlanTerminationPanel plan={plan} />"),
    "the plan page does not mount the panel");
});

test("3b: the final button carries the statutory label, from the constant", () => {
  assert.ok(PANEL.includes("TERMINATION_CONFIRM_LABEL"),
    "the final button does not read the statutory label from the constant");
  assert.ok(!PANEL.includes('"JETZT KÜNDIGEN"'),
    "the label is retyped instead of imported");
  assert.equal(TERMINATION_CONFIRM_LABEL, "JETZT KÜNDIGEN");
  // A deliberate second step, exactly as BGB 312k Abs. 2 Satz 4 asks.
  assert.ok(PANEL.includes("Jahresplan wirklich kündigen?"), "there is no confirmation step");
});

test("3c: it identifies the exact plan, and sends nothing else that matters", () => {
  assert.match(PANEL, /fetch\("\/api\/termination"/);
  assert.match(PANEL, /annualPlanId: plan\.id/);
  assert.match(PANEL, /Authorization: `Bearer \$\{session\.access_token\}`/);
  // THE E-MAIL IS NOT SENT. The route reads it from the verified token, so
  // a confirmation cannot be redirected by whoever is holding the form.
  const body = between(PANEL, "body: JSON.stringify({", "}),");
  assert.ok(!body.includes("email"), "the panel sends an e-mail address");
  assert.ok(!body.includes("contractReference"), "the panel sends a contract reference");
});

test("3d: a terminal plan is offered nothing, and the predicate is shared", () => {
  // The section only renders for a live plan.
  assert.match(ANNUAL_DETAIL, /\{planIsLive && \(\s*<section className="portal-section" id="kuendigung">/);
  assert.match(ANNUAL_DETAIL, /const planIsLive = isLiveAnnualPlan\(plan\);/);
  // And that is the same predicate the route refuses with.
  assert.match(TERMINATION_ROUTE, /if \(!isLiveAnnualPlan\(\{/);
  // Executed, for every state migration 039 can hold.
  assert.equal(isLiveAnnualPlan({ id: UUID, status: "active", paymentStatus: "paid" }), true);
  for (const dead of [
    { status: "completed", paymentStatus: "paid" },
    { status: "cancelled", paymentStatus: "paid" },
    { status: "pending", paymentStatus: "pending" },
    // THE ONE THAT LOOKS ALIVE: a plan whose money has gone back keeps
    // status 'active' and keeps its delivery rows.
    { status: "active", paymentStatus: "refunded" },
  ]) {
    assert.equal(isLiveAnnualPlan({ id: UUID, ...dead }), false,
      `a ${dead.status}/${dead.paymentStatus} plan is treated as live`);
  }
});

/* ══════════════════════════════════════════════════════════════
   4. AN ORDINARY ANNUAL TERMINATION MOVES NO MONEY
   ══════════════════════════════════════════════════════════════ */

test("4: it is recorded against the existing end date and nothing else", () => {
  const outcome = terminateAnnualPlanOrdinary({ planEndAt: "2027-09-27T00:00:00.000Z" });
  assert.equal(outcome.caseState, "acknowledged_ends_automatically");
  assert.equal(outcome.triggersRefund, false);
  assert.equal(outcome.stopsDeliveries, false);
  assert.equal(outcome.appliedImmediately, false);
  assert.equal(outcome.routeToSubscriptionCancellation, false);
  // It names the date the contract already had, and it promises the
  // deliveries that were already paid for.
  assert.match(outcome.message, /27\.09\.2027/);
  assert.match(outcome.message, /Lieferungen erhältst du wie vereinbart weiter/);
  assert.match(outcome.message, /Erstattung ist mit dieser Kündigung nicht verbunden/);
});

test("4b: and the same is true through the resolver the route calls", () => {
  const outcome = resolveTerminationOutcome({
    terminationKind: "ordinary",
    contractKind: "annual_plan",
    planEndAt: "2027-09-27T00:00:00.000Z",
  });
  assert.equal(outcome.triggersRefund, false);
  assert.equal(outcome.stopsDeliveries, false);
  assert.equal(outcome.caseState, "acknowledged_ends_automatically");
  // An extraordinary one is reviewed by a person and still refunds nothing.
  const extra = terminateExtraordinary();
  assert.equal(extra.caseState, "under_review");
  assert.equal(extra.triggersRefund, false);
  assert.equal(extra.stopsDeliveries, false);
});

test("4c: no annual cancellation surface can reach money or Stripe", () => {
  for (const [name, src] of Object.entries({ PANEL, ANNUAL_LIST, ANNUAL_DETAIL })) {
    const code = codeOnly(src);
    for (const banned of ["stripe", "Stripe", "refunds.create", "/api/admin/orders/refund",
                          "/api/subscriptions/cancel"]) {
      assert.ok(!code.includes(banned), `${name} reaches ${banned}`);
    }
  }
  // The route itself carries no payment client at all - the surface guard
  // in tests/customer-rights-surfaces.test.mjs asserts the same thing on
  // the executable region, and this is the import list.
  assert.ok(!/from "[^"]*stripe[^"]*"/i.test(TERMINATION_ROUTE),
    "the termination route imports a payment client");
});

test("4d: the panel states the consequence in the SERVER's own words", () => {
  // Not a sentence the component wrote: the same pure functions the route
  // runs, so what the customer agrees to is what the backend applies.
  assert.match(PANEL, /terminateAnnualPlanOrdinary\(\{ planEndAt: plan\.planEndAt \}\)\.message/);
  assert.match(PANEL, /terminateExtraordinary\(\)\.message/);
  // And it discloses both halves before anything is confirmed.
  assert.ok(/Lieferungen erhältst du weiter/.test(PANEL),
    "the panel does not say the paid deliveries continue");
  assert.ok(/Erstattung ist damit nicht verbunden/.test(PANEL),
    "the panel does not say that no money comes back");
});

/* ══════════════════════════════════════════════════════════════
   5. AUTHORIZATION IS THE SERVER'S
   ══════════════════════════════════════════════════════════════ */

test("5: the plan is re-read by id AND user_id before anything resolves", () => {
  assert.match(TERMINATION_ROUTE, /const caller = await verifyBearerUser\(request\);/);
  assert.match(TERMINATION_ROUTE, /\.from\("annual_plans"\)/);
  assert.match(TERMINATION_ROUTE, /\.eq\("id", annualPlanId\.trim\(\)\)/);
  assert.match(TERMINATION_ROUTE, /\.eq\("user_id", caller\.userId\)/);
  // A foreign plan and a non-existent plan answer identically, so this
  // cannot be used to discover which plan ids are real.
  assert.match(TERMINATION_ROUTE, /"Jahresplan nicht gefunden\."/);
});

test("5b: no token is no termination, and a bad id never reaches a query", () => {
  assert.match(TERMINATION_ROUTE, /if \(!caller\) \{[\s\S]{0,200}status: 401/);
  assert.match(TERMINATION_ROUTE, /!UUID_RE\.test\(annualPlanId\.trim\(\)\)/);
  const shapeCheck = TERMINATION_ROUTE.indexOf("UUID_RE.test(annualPlanId");
  const query = TERMINATION_ROUTE.indexOf('.from("annual_plans")');
  assert.ok(shapeCheck > -1 && query > shapeCheck,
    "the id reaches a query before its shape is checked");
});

test("5c: the e-mail and the reference are the server's on that path", () => {
  // Taken from the verified token, never from the body.
  assert.match(TERMINATION_ROUTE, /email: caller\.email,/);
  assert.match(TERMINATION_ROUTE, /const effectiveEmail = accountPlan \? accountPlan\.email : trimmedEmail;/);
  assert.match(TERMINATION_ROUTE, /const effectiveRef = accountPlan \? accountPlan\.reference : trimmedRef \|\|/);
  // Built here, from the plan, rather than accepted from the browser.
  assert.match(TERMINATION_ROUTE, /reference: endAt/);
  assert.match(TERMINATION_ROUTE, /"Jahresplan, Ende " \+ formatGermanDate\(endAt\)/);
  // And the row records the effective values, not the raw ones.
  assert.match(TERMINATION_ROUTE, /contract_reference: effectiveRef,/);
  assert.match(TERMINATION_ROUTE, /contact_email: effectiveEmail,/);
});

test("5d: the authenticated path cannot fall through to a subscription", () => {
  /*
    THE BUG THIS PREVENTS. The public path resolves an order number and,
    failing that, falls back to "this customer's active subscription". On
    the authenticated path the order number is empty, so without an else
    an annual termination could have been recorded against the customer's
    ABO instead - the wrong contract, silently.
  */
  assert.match(TERMINATION_ROUTE, /if \(accountPlan\) \{[\s\S]{0,400}\} else try \{/);
  assert.match(TERMINATION_ROUTE, /resolvedAnnualPlanId = accountPlan\.id;/);
  assert.match(TERMINATION_ROUTE, /contractKind = "annual_plan";/);
});

test("5e: the public order-number path still works without a login", () => {
  // Unchanged: the order number plus the e-mail that order carries.
  assert.match(TERMINATION_ROUTE, /\.eq\("order_number", trimmedRef\)/);
  assert.match(TERMINATION_ROUTE, /stored === trimmedEmail\.toLowerCase\(\)/);
  // And the one decision layer is still what decides.
  assert.match(TERMINATION_ROUTE, /resolveTerminationOutcome\(/);
  assert.match(TERMINATION_ROUTE, /validateTerminationInput\(/);
  // The route still has no second termination table or state machine.
  assert.equal((TERMINATION_ROUTE.match(/\.from\("termination_requests"\)/g) || []).length, 3,
    "the number of termination_requests statements changed");
});

/* ══════════════════════════════════════════════════════════════
   6. NO DEAD ACCOUNT ROUTE
   ══════════════════════════════════════════════════════════════ */

test("6: /account/subscriptions/kuendigung is not a route at all", () => {
  /*
    It used to BE one, because every three-segment URL under
    /account/subscriptions/ existed and the tail was passed on as a
    subscription id. So the page answered 200 and rendered "Abo nicht
    gefunden." - a soft 404, and a plausible-looking URL to arrive at,
    since /kuendigung is a real page.
  */
  assert.equal(isKnownRoute("account/subscriptions/kuendigung"), false);
  assert.equal(isKnownRoute("account/annual-plans/kuendigung"), false);
  assert.equal(isKnownRoute("account/orders/kuendigung"), false);
  // The real ones still are.
  assert.equal(isKnownRoute(`account/subscriptions/${UUID}`), true);
  assert.equal(isKnownRoute(`account/annual-plans/${UUID}`), true);
  assert.equal(isKnownRoute(`account/orders/${UUID}`), true);
  // The list pages themselves are untouched.
  assert.equal(isKnownRoute("account/subscriptions"), true);
});

test("6b: an id tail is declared as one, and a catalog slug is not", () => {
  for (const prefix of ["account/orders/", "account/subscriptions/",
                        "account/annual-plans/", "account/business/supply/"]) {
    assert.ok(ROUTES_SRC.includes(`prefix: "${prefix}"`), `${prefix} left the list`);
  }
  assert.match(ROUTES_SRC, /\{ prefix: "account\/subscriptions\/", segments: 3, tail: "uuid" \}/);
  // A product slug is not an id and keeps taking any shape.
  assert.equal(isKnownRoute("shop/a-brand-new-product"), true);
  assert.match(ROUTES_SRC, /\{ prefix: "shop\/", segments: 2 \}/);
});

/* ══════════════════════════════════════════════════════════════
   7. THIS PACKAGE ADDED NO SCHEMA
   ══════════════════════════════════════════════════════════════ */

test("7: no migration, and no new table or column is referenced", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.ok(pkg.scripts.test.includes("tests/plan-contextual-cancellation.test.mjs"),
    "this suite is not in the test script");
  /*
    The cancellation UX needed none. termination_requests already carried
    resolved_annual_plan_id, resolved_user_id and contract_kind from
    migration 070 - the authenticated path fills in columns that existed
    for exactly this, and writes no column 070 did not define.
  */
  for (const column of ["resolved_annual_plan_id", "resolved_user_id", "contract_kind"]) {
    assert.ok(read("supabase/migrations/070_customer_rights_foundation.sql").includes(column),
      `${column} is not a 070 column`);
  }
  // And nothing here touches a migration.
  assert.ok(!PANEL.includes("supabase/migrations"));
});
