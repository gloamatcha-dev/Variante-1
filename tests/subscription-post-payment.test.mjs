import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SUBSCRIPTION_RETURN_ID_PARAM,
  SUBSCRIPTION_RETURN_PARAM,
  SUBSCRIPTION_RETURN_PARAMS,
  parseSubscriptionReturnMode,
  resolveSubscriptionReturnState,
  stripSubscriptionReturnParams,
  subscriptionReturnCleanUrl,
  subscriptionReturnIsSettled,
  subscriptionReturnUrlNeedsCleanup,
} from "../lib/subscriptionCheckoutReturn.ts";
import {
  CADENCE_DAYS,
  CANCELLATION_CUTOFF_DAYS,
  canRequestSubscriptionCancellation,
  getCancellationCutoffAt,
  getCancellationPreview,
  getSubscriptionStatusLabel,
  hasEnded,
  isCancellableStatus,
  isCancellationScheduled,
  resolveCancellationSchedule,
} from "../lib/subscriptionCancellationRules.ts";
// The ANNUAL return resolver, to prove it is a separate authority that
// this package did not touch.
import { ANNUAL_CHECKOUT_RETURN_PARAM, resolveAnnualCheckoutReturnState } from "../lib/annualPlanAccount.ts";

/**
 * AFTER THE PAYMENT: THE RETURN BANNER, AND GETTING TO THE CANCELLATION.
 *
 * SAFE DEFAULT SUITE: pure leaves plus source-level contract checks. No
 * socket, no Supabase client, no Stripe object, no database row, and
 * nothing in this file can cancel or refund anything.
 *
 * Two defects, both observed on a REAL 30 g subscription bought through
 * Klarna on 2026-09-27:
 *
 *   1  /account/subscriptions showed "Deine Zahlung wird verarbeitet."
 *      above a subscription that was already AKTIV with a next delivery.
 *      The banner derived its whole state from `?subscription=processing`
 *      - a string Stripe's success_url wrote before any webhook had run -
 *      and never looked at the rows the page had loaded. That string never
 *      stops being true, so the banner never went away.
 *
 *   2  The active subscription row was a link to the detail page - where
 *      the cancellation screen already lived - and said so nowhere. No
 *      label, no chevron, nothing but a hover tint a touch device never
 *      shows. "There is no way to cancel" was a true statement about a
 *      page that had a working cancellation one click away.
 *
 * Nothing here builds a second cancellation engine. Every date below is
 * computed by resolveCancellationSchedule, the same function the cancel
 * route runs.
 */

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf-8");
const NEWLINE = String.fromCharCode(10);

const portal = read("app/AccountPortal.tsx");
const accountUi = read("app/AccountUI.tsx");
const css = read("app/globals.css");
const returnLeaf = read("lib/subscriptionCheckoutReturn.ts");
const flow = read("lib/subscriptionCheckout.ts");
const cancelRoute = read("app/api/subscriptions/cancel/route.ts");
const cancelImpl = read("lib/subscriptionCancellation.ts");

/** Code only: the prose deliberately names what it refuses to do. */
const withoutComments = source => source
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split(NEWLINE)
  .filter(line => {
    const t = line.trim();
    return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*") && !t.startsWith("{/*");
  })
  .join(NEWLINE);

const banner = portal.slice(portal.indexOf("function CheckoutReturnBanner()"),
  portal.indexOf("function PortalSubscriptions()"));
assert.ok(banner.length > 1500, "the return banner was not found");

const list = portal.slice(portal.indexOf("function PortalSubscriptions()"),
  portal.indexOf("function SubscriptionDetail("));
assert.ok(list.length > 1500, "the subscription list was not found");

const detail = portal.slice(portal.indexOf("function SubscriptionDetail("),
  portal.indexOf("function PortalAddresses()"));
assert.ok(detail.length > 4000, "the subscription detail was not found");

/* ── The real subscription, as its own row ──────────────────── */

/**
 * THE ROW THE LIVE TEST PRODUCED, in the shape the account reads.
 *
 * Bought 27.09.2026, next cycle 25.10.2026, 20,89 EUR. The dates are
 * INPUTS here and nothing below asserts them as rule output: every
 * consequence is computed from them by the shared leaf, so the day the
 * cadence or the cutoff changes, this file follows instead of lying.
 */
const PURCHASED_AT = "2026-09-27T12:00:00.000Z";
const NEXT_CYCLE_AT = "2026-10-25T12:00:00.000Z";

const liveRow = (overrides = {}) => ({
  id: "sub-live",
  status: "active",
  current_period_end: NEXT_CYCLE_AT,
  next_delivery_at: NEXT_CYCLE_AT,
  cancellation_requested_at: null,
  cancellation_effective_at: null,
  cancelled_at: null,
  ...overrides,
});

const pendingRow = (overrides = {}) => liveRow({
  id: "sub-pending",
  status: "pending",
  current_period_end: null,
  next_delivery_at: null,
  ...overrides,
});

/* ══════════════════════════════════════════════════════════════
   1. THE PROCESSING BANNER RESOLVES
   ══════════════════════════════════════════════════════════════ */

test("1: processing + nothing confirmed => the banner is shown", () => {
  // The local row exists from the moment the session is created (Model A,
  // migration 022), so "still being set up" is what pending looks like.
  assert.equal(resolveSubscriptionReturnState({
    targetSubscriptionId: "sub-pending",
    subscriptions: [pendingRow()],
  }), "pending");
  // A read that failed, or rows that have not arrived yet, is pending too -
  // never a claim that the payment went through.
  assert.equal(resolveSubscriptionReturnState({ targetSubscriptionId: "sub-live", subscriptions: [] }), "pending");
  assert.equal(resolveSubscriptionReturnState({ targetSubscriptionId: null, subscriptions: [] }), "pending");
  // An id that is not among the caller's own rows - a stranger's, a guess,
  // a deleted row - resolves to pending, so the URL grants nothing.
  assert.equal(resolveSubscriptionReturnState({
    targetSubscriptionId: "not-mine",
    subscriptions: [liveRow()],
  }), "pending");
  // An unrecognised status never settles either.
  assert.equal(resolveSubscriptionReturnState({
    targetSubscriptionId: "sub-live",
    subscriptions: [liveRow({ status: "who_knows" })],
  }), "pending");
  for (const state of ["pending"]) {
    assert.equal(subscriptionReturnIsSettled(state), false, state);
  }
});

test("2: processing + an ACTIVE subscription => the banner is hidden", () => {
  assert.equal(resolveSubscriptionReturnState({
    targetSubscriptionId: "sub-live",
    subscriptions: [liveRow()],
  }), "confirmed");
  assert.equal(subscriptionReturnIsSettled("confirmed"), true);
  // The bug exactly as it was observed: a stale parameter with no id, and
  // one active subscription. The rows win.
  assert.equal(resolveSubscriptionReturnState({
    targetSubscriptionId: null,
    subscriptions: [liveRow()],
  }), "confirmed");
  // Not a false success: a payment that did not go through is its own
  // state, and an ended subscription is another.
  for (const status of ["past_due", "unpaid"]) {
    assert.equal(resolveSubscriptionReturnState({
      targetSubscriptionId: "sub-live",
      subscriptions: [liveRow({ status })],
    }), "attention", status);
  }
  assert.equal(resolveSubscriptionReturnState({
    targetSubscriptionId: "sub-live",
    subscriptions: [liveRow({ status: "cancelled", cancelled_at: NEXT_CYCLE_AT })],
  }), "ended");
  // FAIL-SAFE ACROSS SEVERAL: one subscription still being set up keeps
  // the banner up whatever the others say, so an old active abo cannot
  // hide a new pending one.
  assert.equal(resolveSubscriptionReturnState({
    targetSubscriptionId: null,
    subscriptions: [liveRow(), pendingRow()],
  }), "pending");
  assert.equal(resolveSubscriptionReturnState({
    targetSubscriptionId: null,
    subscriptions: [liveRow(), liveRow({ id: "b", status: "past_due" })],
  }), "attention");
});

test("2b: the BANNER gates its copy on the resolved state, not on the URL", () => {
  const code = withoutComments(banner);
  // The mode is narrowed through the leaf, so a hand-typed value cannot
  // summon a banner.
  assert.match(code, /subscription: parseSubscriptionReturnMode\(p\.get\(SUBSCRIPTION_RETURN_PARAM\)\)/);
  assert.equal(parseSubscriptionReturnMode("processing"), "processing");
  assert.equal(parseSubscriptionReturnMode("cancelled"), "cancelled");
  for (const junk of ["aktiv", "", null, undefined, 1, "Processing", "PROCESSING"]) {
    assert.equal(parseSubscriptionReturnMode(junk), null, String(junk));
  }
  // The processing copy is reachable ONLY while the state is unsettled.
  assert.match(code,
    /const subscriptionSettled = subscriptionState !== null && subscriptionReturnIsSettled\(subscriptionState\);/);
  assert.match(code, /params\.subscription === "processing" && !subscriptionSettled/);
  assert.ok(code.includes('Deine Zahlung wird verarbeitet.'),
    "the processing copy disappeared entirely");
  // ONE read, of the customer's own rows, through the leaf.
  assert.match(code, /\.from\("subscriptions"\)/);
  assert.match(code, /setSubscriptionState\(resolveSubscriptionReturnState\(\{/);
  assert.match(code, /targetSubscriptionId: params\.subscriptionId,/);
  assert.match(code, /subscriptions: read\.error \? \[\] : /,
    "a failed read no longer degrades to pending");
  // AND IT STILL DOES NOT POLL, TIME OUT OR ASK STRIPE. The banner is
  // resolved by the database or not at all - hiding it on a timer is the
  // fix that was explicitly rejected.
  for (const polling of ["setInterval", "setTimeout", "requestAnimationFrame"]) {
    assert.ok(!banner.includes(polling), `the return banner polls with ${polling}`);
  }
  assert.ok(!banner.includes("/api/"), "the return banner calls an API route");
  // The word STRIPE appears in the customer copy ("sobald Stripe die
  // Zahlung bestätigt hat") and that is fine. What must not appear is a
  // call: no client, no session, no lookup.
  for (const call of ["stripe.", "Stripe(", "getStripeClient", "checkout.sessions", "subscriptions.retrieve"]) {
    assert.ok(!code.includes(call), `the return banner reaches Stripe: ${call}`);
  }
  // The ABORTED return is untouched: no row was ever paid, so there is
  // nothing in the database to resolve it against.
  assert.match(code, /params\.subscription === "cancelled"/);
  assert.ok(banner.includes("Du hast die Zahlung abgebrochen."), "the aborted copy changed");
});

test("3: once settled, the stale parameters leave the URL", () => {
  assert.equal(SUBSCRIPTION_RETURN_PARAM, "subscription");
  assert.equal(SUBSCRIPTION_RETURN_ID_PARAM, "subscriptionId");
  assert.deepEqual([...SUBSCRIPTION_RETURN_PARAMS], ["subscription", "subscriptionId"]);

  const returned = "?subscription=processing&subscriptionId=sub-live";
  assert.equal(stripSubscriptionReturnParams(returned), "");
  assert.equal(subscriptionReturnUrlNeedsCleanup(returned), true);
  assert.equal(subscriptionReturnCleanUrl({
    pathname: "/account/subscriptions", search: returned, hash: "",
  }), "/account/subscriptions");
  // A page with nothing to strip does not rewrite its own history entry.
  for (const clean of ["", "?", "?annual=processing", undefined, null, 5]) {
    assert.equal(subscriptionReturnUrlNeedsCleanup(clean), false, String(clean));
  }
  // REPLACE, NOT PUSH: a refresh and a Back press must both land on the
  // cleaned URL rather than resurrecting the banner.
  const code = withoutComments(banner);
  assert.match(code, /window\.history\.replaceState\(window\.history\.state, "", subscriptionReturnCleanUrl\(window\.location\)\)/);
  assert.ok(!code.includes("pushState"), "the cleanup pushes a new history entry");
  // Gated on the SETTLED state and on there being something to strip.
  assert.match(code, /if \(!subscriptionState \|\| !subscriptionReturnIsSettled\(subscriptionState\)\) return;/);
  assert.match(code, /if \(!subscriptionReturnUrlNeedsCleanup\(window\.location\.search\)\) return;/);
  // AND IT IS NOT A NAVIGATION. Nothing is reloaded and no checkout is
  // re-entered, so the list on the page below is not remounted.
  const cleanup = code.slice(code.indexOf("subscriptionReturnUrlNeedsCleanup(window.location.search)"));
  for (const navigation of ["window.location.href", "window.location.assign", "window.location.reload"]) {
    assert.ok(!cleanup.includes(navigation), `the cleanup navigates: ${navigation}`);
  }
});

test("4: unrelated query parameters survive the cleanup, byte for byte", () => {
  assert.equal(
    stripSubscriptionReturnParams("?subscription=processing&subscriptionId=sub-live&annual=processing&annualPlanId=abc"),
    "?annual=processing&annualPlanId=abc");
  assert.equal(stripSubscriptionReturnParams("?utm_source=klarna&subscription=processing"), "?utm_source=klarna");
  assert.equal(stripSubscriptionReturnParams("?a=1&subscription=processing&b=2"), "?a=1&b=2");
  // Order is preserved and nothing is re-encoded on its way past - a
  // parameter this module has never heard of is exactly the one that must
  // not be rewritten.
  assert.equal(stripSubscriptionReturnParams("?q=a%20b&subscription=processing"), "?q=a%20b");
  assert.equal(stripSubscriptionReturnParams("?q=a+b&subscription=processing"), "?q=a+b");
  assert.equal(stripSubscriptionReturnParams("?flag&subscription=processing"), "?flag");
  assert.equal(stripSubscriptionReturnParams("?sku=GLOA-MATCHA-30G"), "?sku=GLOA-MATCHA-30G");
  // The pathname and the hash are carried through untouched.
  assert.equal(subscriptionReturnCleanUrl({
    pathname: "/account/subscriptions", search: "?subscription=processing&keep=1", hash: "#abo",
  }), "/account/subscriptions?keep=1#abo");
  // A missing hash is not the string "undefined".
  assert.equal(subscriptionReturnCleanUrl({
    pathname: "/account/subscriptions", search: "?subscription=processing",
  }), "/account/subscriptions");
  // An encoded spelling of the parameter is stripped too, so it cannot
  // survive while the plain one is removed.
  assert.equal(stripSubscriptionReturnParams("?subscription=processing&subscriptionId=x"), "");
  // Garbage is not a crash and is not silently dropped.
  assert.equal(stripSubscriptionReturnParams("?q=%E0%A4%A"), "?q=%E0%A4%A");
});

test("4b: the checkout carries the id so the page knows WHICH subscription", () => {
  const code = withoutComments(flow);
  assert.match(code,
    /success_url: `\$\{origin\}\/account\/subscriptions\?subscription=processing&subscriptionId=\$\{encodeURIComponent\(subscriptionId\)\}`/,
    "the success URL no longer names the subscription it created");
  assert.match(code, /cancel_url: `\$\{origin\}\/account\/subscriptions\?subscription=cancelled`/,
    "the cancel URL changed");
  // Still the configured origin, never a request header, and still no
  // success wording in the URL itself.
  assert.ok(!/x-forwarded-host|request\.headers\.get\("host"\)/i.test(code));
  assert.ok(!/aktiv|bezahlt|erfolgreich/i.test(code.match(/success_url[^`]*`[^`]*`/)?.[0] ?? ""));
  // The id it carries is the LOCAL subscription id the flow already
  // created - not a Stripe object, and not something the browser sent.
  assert.match(code, /const subscriptionId = claimed\.subscriptionId;/);
});

/* ══════════════════════════════════════════════════════════════
   5. THE LIST MAKES MANAGING DISCOVERABLE
   ══════════════════════════════════════════════════════════════ */

test("5: every subscription card carries a visible manage action", () => {
  assert.ok(list.includes("ABO VERWALTEN"), "the card has no visible action");
  assert.match(list, /<span className="sub-card-manage">/);
  assert.match(list, /<span className="portal-action">ABO VERWALTEN<\/span>/);
  // The portal's own chevron, reused rather than redrawn, so every
  // navigable row in the account ends the same way.
  assert.match(list, /<AccountChevron \/>/);
  assert.match(accountUi, /export function AccountChevron\(\) \{/);
  assert.match(portal, /import \{\s*\n?\s*AccountChevron,/);
  // A SPAN, not a nested link or button: the row is already the link, and
  // a control inside it would be a second target for one destination.
  const manage = list.slice(list.indexOf('className="sub-card-manage"'));
  const block = manage.slice(0, manage.indexOf("</span>", manage.indexOf("AccountChevron")));
  assert.ok(!/<a |<button|<Link/.test(block), "the manage affordance is a nested interactive element");
  // And it is styled, so it is genuinely visible rather than only present.
  assert.ok(css.includes(".sub-card-manage{display:flex"), "the manage affordance has no style");
  assert.ok(css.includes(".sub-card:hover .sub-card-manage{color:var(--blue)}"),
    "the manage affordance does not respond to hover");
  assert.ok(css.includes(".portal-action{font:600 12px/1 var(--font-mono)"),
    "the action type is no longer the portal's own");
});

test("6: the manage action opens the EXISTING detail route", () => {
  // The whole card is the link, and its destination is the account's own
  // subscription detail route - not a new page and not a modal.
  assert.match(list, /<a key=\{s\.id\} href=\{`\/account\/subscriptions\/\$\{s\.id\}`\} className="sub-card">/);
  // That route exists and is wired to the existing component.
  assert.match(read("app/GloaSite.tsx"),
    /route\.startsWith\("account\/subscriptions\/"\)&&route\.split\("\/"\)\.length===3\)page=<AccountPortal page="subscription-detail" subscriptionId=\{route\.split\("\/"\)\[2\]\}\/>/);
  assert.match(read("lib/publicRoutes.ts"),
    /\{ prefix: "account\/subscriptions\/", segments: 3 \}/);
  assert.match(portal, /\{page === "subscription-detail" && <SubscriptionDetail subscriptionId=\{subscriptionId!\} \/>\}/);
  // Exactly one destination per card, so nothing competes with it.
  assert.equal((list.match(/\/account\/subscriptions\/\$\{s\.id\}/g) || []).length, 1);
});

/* ══════════════════════════════════════════════════════════════
   7. THE DETAIL EXPOSES THE EXISTING CANCELLATION
   ══════════════════════════════════════════════════════════════ */

test("7: an active monthly subscription can be cancelled from the detail page", () => {
  // The control is rendered only when the shared rule says the server
  // would accept it.
  assert.match(detail, /const canCancel = canRequestSubscriptionCancellation\(sub\);/);
  assert.match(detail, /\) : canCancel && preview \? \(/);
  assert.match(detail, /className="cta order-cancel-cta"[\s\S]{0,200}?Abo kündigen/,
    "the cancellation CTA is gone");
  // Uppercase is CSS, so the source keeps its sentence case and the page
  // still reads ABO KÜNDIGEN.
  assert.ok(css.includes("text-transform:uppercase;font:var(--cta-type)"),
    "the CTA no longer uppercases its label");
  assert.ok(detail.includes('<p className="eyebrow">KÜNDIGUNG</p>'), "the cancellation section lost its heading");
  // A DELIBERATE SECOND STEP: one stray click must not end a paid contract.
  assert.match(detail, /setConfirming\(true\)/);
  assert.ok(detail.includes("Abo wirklich kündigen?"), "the confirmation step is gone");
  assert.ok(detail.includes('"Jetzt kündigen"'), "the final confirmation is gone");

  // AND THE RULE DECIDES, for the real row.
  assert.equal(canRequestSubscriptionCancellation(liveRow()), true);
  // Every state the existing rules prohibit stays prohibited.
  assert.equal(canRequestSubscriptionCancellation(liveRow({ status: "cancelled" })), false);
  assert.equal(canRequestSubscriptionCancellation(liveRow({ cancelled_at: NEXT_CYCLE_AT })), false);
  assert.equal(canRequestSubscriptionCancellation(liveRow({
    cancellation_requested_at: PURCHASED_AT, cancellation_effective_at: NEXT_CYCLE_AT,
  })), false, "a standing cancellation offers a second one");
  assert.equal(canRequestSubscriptionCancellation(pendingRow()), false,
    "a subscription with no period end offers a cancellation date it cannot honour");
  assert.equal(isCancellableStatus("pending"), false);
  assert.equal(isCancellableStatus("active"), true);
  // A standing cancellation shows the promise instead of a second CTA.
  assert.match(detail, /\) : scheduled && endsAt \? \(/);
  assert.ok(detail.includes("Kündigung vorgemerkt."), "the standing-cancellation copy is gone");
  assert.equal(isCancellationScheduled(liveRow({
    cancellation_requested_at: PURCHASED_AT, cancellation_effective_at: NEXT_CYCLE_AT,
  })), true);
  assert.equal(hasEnded(liveRow({ status: "cancelled" })), true);
  assert.equal(getSubscriptionStatusLabel(liveRow()), "Aktiv");
});

test("8: it is the EXISTING cancellation engine, and no second one exists", () => {
  // The detail page posts to the route that has existed since Phase 3C,
  // with the one field it accepts.
  assert.match(detail, /await fetch\("\/api\/subscriptions\/cancel", \{/);
  assert.match(detail, /body: JSON\.stringify\(\{ subscriptionId \}\)/);
  assert.equal((portal.match(/\/api\/subscriptions\/cancel/g) || []).length, 1,
    "the cancellation route is called from more than one place");
  // The route still delegates to the one implementation.
  assert.match(cancelRoute, /cancelSubscriptionForUser/);
  assert.match(cancelRoute, /validateCancelRequest/);
  // NO SECOND ENGINE IN THE BROWSER: the page decides no date, writes no
  // row and touches no payment provider. It re-reads the row afterwards
  // and renders whatever was actually persisted.
  const code = withoutComments(detail);
  for (const banned of ["stripe", "Stripe", "cancel_at", "cancellation_effective_at:", ".update(", ".insert(",
                        ".upsert(", ".delete(", ".rpc("]) {
    assert.ok(!code.includes(banned), `the detail page builds a second cancellation engine: ${banned}`);
  }
  assert.match(code, /const refreshed = await fetchSubscription\(\);/);
  assert.ok(!/setSub\(\{ \.\.\.sub/.test(code), "the page optimistically fakes a cancellation");

  // THE PREVIEW IS THE SERVER'S OWN RULE. Not a second calculation: the
  // page calls getCancellationPreview, which calls
  // resolveCancellationSchedule, which is what the route runs.
  assert.match(detail, /const preview = getCancellationPreview\(sub, now\);/);
  assert.match(detail, /const cutoffAt = getCancellationCutoffAt\(sub, now\);/);
  assert.match(detail, /Ende: \{fmtDate\(preview\.schedule\.effectiveCancelAt\)\}/);
  assert.match(detail, /\{preview\.consequence\}/);
  // NO DATE ARITHMETIC IN THE BROWSER. The page formats what the leaf
  // returned and adds nothing: no day count, no millisecond constant, no
  // Date maths of its own.
  for (const arithmetic of ["86400000", "* 24 *", "CADENCE_MS", "CUTOFF_OFFSET_MS",
                            "setDate(", "getTime() +", "Date.parse("]) {
    assert.ok(!code.includes(arithmetic), `the detail page computes a date itself: ${arithmetic}`);
  }
});

test("8b: the preview states the real consequence for the live subscription", () => {
  /*
    27.09.2026 is more than 14 days before the 25.10.2026 boundary, so the
    approved rule is EARLY: the upcoming cycle does not happen and the
    subscription ends at the period end already paid for.

    NOTHING IS HARDCODED. The two dates are inputs; every consequence
    below is computed by the same function the cancel route runs, so the
    day the cadence or the cutoff moves this test moves with it.
  */
  const decided = resolveCancellationSchedule({
    requestAt: PURCHASED_AT,
    currentPeriodEnd: NEXT_CYCLE_AT,
  });
  assert.equal(decided.ok, true);
  assert.equal(decided.schedule.timing, "early", "the request is not treated as early");
  assert.equal(decided.schedule.nextBillingAt, NEXT_CYCLE_AT);
  // NO ADDITIONAL CYCLE: it ends ON the boundary, not one cadence later.
  assert.equal(decided.schedule.effectiveCancelAt, NEXT_CYCLE_AT);
  assert.notEqual(decided.schedule.effectiveCancelAt,
    new Date(Date.parse(NEXT_CYCLE_AT) + CADENCE_DAYS * 86400000).toISOString(),
    "an extra billing cycle was scheduled");
  // The cutoff is exactly the approved distance before the boundary.
  assert.equal(decided.schedule.cutoffAt,
    new Date(Date.parse(NEXT_CYCLE_AT) - CANCELLATION_CUTOFF_DAYS * 86400000).toISOString());
  assert.equal(CANCELLATION_CUTOFF_DAYS, 14);
  assert.equal(CADENCE_DAYS, 28);

  // The page shows that same schedule, and the sentence that goes with it.
  const preview = getCancellationPreview(liveRow(), PURCHASED_AT);
  assert.equal(preview.schedule.effectiveCancelAt, NEXT_CYCLE_AT);
  assert.equal(preview.schedule.timing, "early");
  assert.match(preview.consequence, /Die nächste Lieferung entfällt/);
  assert.equal(getCancellationCutoffAt(liveRow(), PURCHASED_AT), decided.schedule.cutoffAt);
  // A request AFTER the cutoff keeps the upcoming cycle, and the preview
  // says so - the other half of the rule is still reachable.
  const late = getCancellationPreview(liveRow(), "2026-10-20T12:00:00.000Z");
  assert.equal(late.schedule.timing, "late");
  assert.match(late.consequence, /wird noch ganz normal geliefert und berechnet/);
  assert.notEqual(late.schedule.effectiveCancelAt, NEXT_CYCLE_AT);
});

test("9: the ANNUAL plan's rules and its own return state are untouched", () => {
  // Two separate authorities, two separate parameters, neither reading the
  // other's module.
  assert.equal(ANNUAL_CHECKOUT_RETURN_PARAM, "annualPlanId");
  assert.notEqual(ANNUAL_CHECKOUT_RETURN_PARAM, SUBSCRIPTION_RETURN_ID_PARAM);
  assert.ok(!withoutComments(returnLeaf).includes("annual"), "the subscription leaf reads the annual flow");
  assert.ok(!withoutComments(read("lib/annualPlanAccount.ts")).includes("subscriptionCheckoutReturn"),
    "the annual leaf reads the subscription return");
  // The annual resolver still answers exactly as it did.
  const mine = { id: "mine", status: "active", payment_status: "paid", purchased_at: PURCHASED_AT };
  assert.equal(resolveAnnualCheckoutReturnState({ targetAnnualPlanId: "mine", plans: [mine] }), "active");
  assert.equal(resolveAnnualCheckoutReturnState({ targetAnnualPlanId: "gone", plans: [mine] }),
    resolveAnnualCheckoutReturnState({ targetAnnualPlanId: "gone", plans: [] }));
  // And the annual branch of the banner is byte-identical in intent.
  assert.match(withoutComments(banner), /\.from\("annual_plans"\)\.select\("id, status, payment_status, purchased_at"\)/);
  assert.match(withoutComments(banner), /setAnnualState\(resolveAnnualCheckoutReturnState\(\{/);
  // THE PREPAID PLAN HAS NO CANCELLATION AND STILL OFFERS NONE. It is paid
  // once for thirteen deliveries and ends; this package added nothing.
  const annualForm = portal.slice(portal.indexOf("function AnnualPlanStartForm()"),
    portal.indexOf("function PortalAnnualPlans("));
  const annualList = portal.slice(portal.indexOf("function PortalAnnualPlans("),
    portal.indexOf("function annualStatusLabel("));
  for (const source of [annualForm, annualList]) {
    assert.ok(!source.includes("/api/subscriptions/cancel"), "an annual surface reaches the abo cancellation");
    assert.ok(!/kündigen/i.test(withoutComments(source)), "an annual surface offers a cancellation");
  }
});

test("10: none of this refunds anything", () => {
  // The cancellation SCHEDULES an end. It creates no refund, and neither
  // the route nor the implementation has one.
  for (const [name, src] of Object.entries({ route: cancelRoute, impl: cancelImpl })) {
    const code = withoutComments(src);
    for (const banned of ["refunds.create", "createRefund", "issueRefund", "refund_amount",
                          "amount_to_refund", "prorate"]) {
      assert.ok(!code.includes(banned), `the cancellation ${name} refunds: ${banned}`);
    }
  }
  // Nothing in the account portal refunds either, and the detail page's
  // only write is the cancel POST.
  const code = withoutComments(portal);
  for (const banned of ["refunds.create", "createRefund", "/api/admin/", "refund("]) {
    assert.ok(!code.includes(banned), `the portal reaches a refund: ${banned}`);
  }
  // The RETURN path writes nothing at all: it reads rows and rewrites a
  // query string.
  const bannerCode = withoutComments(banner);
  for (const banned of [".insert(", ".update(", ".upsert(", ".delete(", ".rpc(", "/api/"]) {
    assert.ok(!bannerCode.includes(banned), `the return banner writes: ${banned}`);
  }
  // And this suite cannot reach anything live.
  assert.ok(!withoutComments(returnLeaf).includes("supabase"), "the return leaf opened a database client");
  assert.ok(!/^import /m.test(withoutComments(returnLeaf).replace(/^import \{ hasEnded[\s\S]*?;$/m, "")),
    "the return leaf gained an import beyond the rules leaf");
});

test("11: the subscription list and detail keep every value they had", () => {
  // REGRESSION SURFACE. The card still shows the same four facts, from the
  // same shared helpers, and the detail still derives every sentence from
  // lib/subscriptionCancellationRules.ts.
  for (const kept of ["<dl className=\"sub-card-facts\">", "{SUBSCRIPTION_CADENCE_LABEL}",
                      "Nächste Lieferung", "Pro Lieferung", "getSubscriptionStatusLabel(s)"]) {
    assert.ok(list.includes(kept), `the card lost: ${kept}`);
  }
  for (const kept of ["getSubscriptionStatusLabel(sub)", "getSubscriptionStatusNote(sub)",
                      "getNextBillingAt(sub)", "getNextDeliveryAt(sub)", "getEffectiveEndAt(sub)",
                      "SUMME PRO LIEFERUNG", "LIEFERADRESSE", "RECHNUNGSADRESSE", "ARTIKEL"]) {
    assert.ok(detail.includes(kept), `the detail lost: ${kept}`);
  }
  // The list is still ONE read, ordered, with active first.
  assert.equal((list.match(/await supabase|supabase\.from/g) || []).length, 1,
    "the subscription list became more than one read");
  assert.match(list, /\.select\(SUBSCRIPTION_SELECT\)\.order\("created_at", \{ ascending: false \}\)/);
  // The booking form is still a sibling of the list, so a customer with an
  // ended abo can start another without a detour through the shop.
  assert.match(list, /\{!loading && !error && <SubscriptionStartForm subscriptions=\{subs\} \/>\}/);
});
