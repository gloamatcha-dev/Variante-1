import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ANNUAL_DELIVERY_COUNT,
  ANNUAL_DELIVERY_INTERVAL_DAYS,
  ANNUAL_DISCOUNT_PERCENT,
  ANNUAL_SHIPPING_PER_DELIVERY_GROSS_CENTS,
  ANNUAL_SIZES,
  ANNUAL_TERM_DAYS,
  buildAnnualPricing,
} from "../lib/annualPlanRules.ts";
import {
  ANNUAL_DELIVERY_COUNTRY,
  ANNUAL_GERMANY_ONLY_NOTE,
  ANNUAL_LAUNCH_SIZE_BY_SKU,
  ANNUAL_PLAN_FEATURE_FLAG,
  ANNUAL_PORTAL_PATH,
  annualPortalHref,
  isAnnualDeliveryCountry,
} from "../lib/annualPlans.ts";
import {
  ANNUAL_CHECKOUT_RETURN_PARAM,
  ANNUAL_PLAN_ACCOUNT_SELECT,
  buildAnnualPlanAccountView,
  resolveAnnualCheckoutReturnState,
} from "../lib/annualPlanAccount.ts";
import {
  ANNUAL_DELIVERY_COLUMNS,
  ANNUAL_SUMMARY_GROUPS,
  DELIVERIES_PER_PLAN_CAP,
  annualGroupFilter,
  buildScheduleFacts,
  prepaidGrossCents,
} from "../lib/adminAnnualPlansQuery.ts";
import { canWrite, parseAdminRole, roleSatisfies } from "../lib/adminRoles.ts";

/*
  THE PREPAID ANNUAL PLAN'S PURCHASE SURFACE.

  The annual engine - the checkout route, the payment webhook, activation
  with thirteen frozen delivery dates, the maintenance job, the refund
  writer - has been complete and untouched for some time. What this
  package added is the part that was missing: a caller. A shop offer that
  hands over, an account form that starts one, a return banner that does
  not celebrate an unconfirmed payment, a read-only admin overview and
  terms that describe the contract the code actually performs.

  So this suite asserts the SURFACE, and asserts it against the engine's
  own leaves. Every euro figure, every date rule and every column list is
  imported rather than written down, because a test that restates a
  number is a second source of truth for it.

  SAFE BY CONSTRUCTION: source reads and pure leaf calls. No network, no
  Supabase client, no payment provider, no database.
*/

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf-8");
const NEWLINE = String.fromCharCode(10);

/* Comment-stripped, because the prose in these files legitimately NAMES
   what the code must not do - "not one commercial value is sent" would
   otherwise trip a ban on the phrase it exists to forbid. */
const withoutComments = source => source
  .split(NEWLINE)
  .filter(line => {
    const t = line.trim();
    return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
  })
  .join(NEWLINE);

const stripBlocks = source => source
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .split(NEWLINE)
  .filter(line => !line.trim().startsWith("//"))
  .join(NEWLINE);

const site = read("app/GloaSite.tsx");
const portal = read("app/AccountPortal.tsx");
const adminUi = read("app/AdminAnnualPlans.tsx");
const adminRoute = read("app/api/admin/annual-plans/route.ts");
const adminOverview = read("app/AdminOverview.tsx");
const checkoutRoute = read("lib/annualPlanCheckout.ts");
const pkg = JSON.parse(read("package.json"));

/* THE ANNUAL HALF OF THE PORTAL. The file holds both contracts; the
   marker is the boundary, and the subscription suite slices on the same
   comment from the other side. */
const ANNUAL_MARKER = "/* ══ JAHRESPLAN: DIE VORAUSBEZAHLTEN KOMPONENTEN ══";
/* Bounded at PortalSubscriptions, which is exactly what the marker
   promises: everything below it and above that function is the prepaid
   plan. Running to the end of the file would drag the recurring
   subscription, the addresses and the whole B2B section in with it. */
const ANNUAL_BLOCK_END = "function PortalSubscriptions()";
const annualPortalSource = portal.slice(portal.indexOf(ANNUAL_MARKER), portal.indexOf(ANNUAL_BLOCK_END));
const annualPortalCode = withoutComments(annualPortalSource);
/* The annual half with EVERY comment gone, for the bans: the prose here
   explains at length what the code must never do, and a substring check
   cannot tell the warning apart from the offence. */
const annualPortalBare = stripBlocks(annualPortalSource);
const adminUiBare = stripBlocks(adminUi);
const adminRouteBare = stripBlocks(adminRoute);

/* ── 1. The rules this package is allowed to describe ───────── */

test("1a: the plan the surface describes is the plan the engine performs", () => {
  // Not one of these is a new decision. They are asserted here so a
  // change to the engine breaks the SURFACE's tests too, rather than
  // leaving a shop panel quietly advertising a contract that moved.
  assert.equal(ANNUAL_DELIVERY_COUNT, 13);
  assert.equal(ANNUAL_DELIVERY_INTERVAL_DAYS, 28);
  assert.equal(ANNUAL_TERM_DAYS, 364);
  assert.equal(ANNUAL_TERM_DAYS, ANNUAL_DELIVERY_COUNT * ANNUAL_DELIVERY_INTERVAL_DAYS);
  assert.equal(ANNUAL_DISCOUNT_PERCENT, 10);
  assert.deepEqual([...ANNUAL_SIZES], ["30g", "50g", "100g"]);
  assert.deepEqual({ ...ANNUAL_SHIPPING_PER_DELIVERY_GROSS_CENTS }, { "30g": 590, "50g": 0, "100g": 0 });
});

test("1b: the feature flag is untouched and still the gate", () => {
  // This package makes the plan BUYABLE, not enabled. The flag name is
  // unchanged and the checkout route still refuses while it is closed.
  assert.equal(ANNUAL_PLAN_FEATURE_FLAG, "B2C_ANNUAL_PLAN_ENABLED");
  assert.match(checkoutRoute, /isAnnualPlanCheckoutEnabled/);
  // And nothing in the three new browser surfaces reads the flag itself -
  // the server is the gate, and a client-side copy could disagree with it.
  for (const [label, source] of [["shop", stripBlocks(site)], ["portal", annualPortalBare], ["admin", adminUiBare]]) {
    assert.ok(!source.includes(ANNUAL_PLAN_FEATURE_FLAG), `${label} reads the flag directly`);
  }
});

/* ── 2. The shop states the offer and hands over ────────────── */

test("2a: the shop's annual CTA navigates to the account, and posts nowhere", () => {
  // THE PROPERTY THAT MATTERS: the shop is not a second checkout. It
  // names the offer, then hands the customer to the one form that can
  // start a plan, with the chosen size as a hint.
  assert.ok(site.includes('track("shop_annual_start");window.location.href=annualPortalHref(v.sku)'));
  assert.ok(site.includes('annualActive?"Jahresplan im Konto starten"'));

  const shopCode = withoutComments(site);
  assert.ok(!shopCode.includes("/api/annual-plan"), "the shop posts to the annual checkout");
  assert.ok(!shopCode.includes("annual_plans"), "the shop reads the annual table directly");
});

test("2b: the hand-over target is the portal, with the size carried as a hint", () => {
  assert.equal(ANNUAL_PORTAL_PATH, "/account/subscriptions");
  assert.equal(annualPortalHref("GLOA-MATCHA-50G"), "/account/subscriptions?plan=annual&sku=GLOA-MATCHA-50G");
  // A SKU that is not an annual launch product carries no size hint at
  // all, rather than one the form would then have to reject.
  assert.equal(annualPortalHref("GLOA-CASE"), `${ANNUAL_PORTAL_PATH}?plan=annual`);
  assert.equal(annualPortalHref(null), `${ANNUAL_PORTAL_PATH}?plan=annual`);
  assert.equal(annualPortalHref(undefined), `${ANNUAL_PORTAL_PATH}?plan=annual`);
  // The hint is only ever a hint: the form re-derives eligibility from
  // the same allowlist, so a hand-typed sku cannot widen the offer.
  assert.match(annualPortalCode, /new URLSearchParams\(window\.location\.search\)\.get\("sku"\)/);
  assert.match(annualPortalCode, /eligible\.find\(v => v\.sku === skuHint\)/);
});

test("2c: the shop panel's figures come from the pricing leaf, not from the file", () => {
  // The panel renders buildAnnualPricing's output. No annual euro amount
  // is written down in the component, so the shop cannot advertise a
  // total the server would not charge.
  assert.match(site, /function annualPricingFor\(variant: CatalogVariant\): AnnualPricing \| null/);
  assert.match(site, /buildAnnualPricing\(\{\s*size,\s*catalogUnitGrossCents: variant\.price_gross_cents\s*\}\)/);
  const panel = site.slice(site.indexOf("function AnnualPlanPanel("), site.indexOf("function SubscriptionPlanPanel("));
  assert.ok(panel.length > 200, "the annual panel could not be located");
  for (const value of ["annual.annualUnitGrossCents", "annual.totalGrossCents", "annual.shippingPerDeliveryGrossCents"]) {
    assert.ok(panel.includes(value), `the panel stopped rendering ${value}`);
  }
  // A hardcoded euro total would be a second source of truth.
  assert.ok(!/\d{3},\d{2}/.test(panel), "a euro total is hardcoded in the annual panel");
});

test("2d: the shop names the discount and the Germany-only limit", () => {
  const panel = site.slice(site.indexOf("function AnnualPlanPanel("), site.indexOf("function SubscriptionPlanPanel("));
  // The discount was previously visible only as a struck-through price,
  // which states a saving without naming the rule that produces it.
  assert.match(panel, /<dt>Rabatt<\/dt><dd>\{ANNUAL_DISCOUNT_PERCENT\} % auf den Matcha-Preis<\/dd>/);
  assert.match(panel, /\{ANNUAL_GERMANY_ONLY_NOTE\}/);
  assert.equal(ANNUAL_DELIVERY_COUNTRY, "DE");
  // THE SENTENCE ITSELF, PINNED. It is a commercial statement about the
  // offer, shown in the shop panel, beside the address in the account
  // form and again under the size chooser - so it must not drift into
  // something narrower, wider or merely vaguer without a test saying so.
  // Pinned on the exported constant, never duplicated into the app.
  assert.equal(
    ANNUAL_GERMANY_ONLY_NOTE,
    "Der Jahresplan ist aktuell nur für Lieferadressen in Deutschland verfügbar.");
});

/* ── 3. The account form is the only caller ─────────────────── */

test("3a: exactly one place in the browser posts to the annual checkout", () => {
  const combined = withoutComments(site) + NEWLINE + withoutComments(portal) + NEWLINE + withoutComments(adminUi);
  const posts = [...combined.matchAll(/"\/api\/annual-plan\/checkout\/session"/g)];
  assert.equal(posts.length, 1, "the annual checkout gained a second caller");
  assert.match(annualPortalCode, /fetch\("\/api\/annual-plan\/checkout\/session", \{/);
  assert.match(annualPortalCode, /method: "POST"/);
});

test("3b: exactly three fields are sent, and not one of them is money", () => {
  // The route accepts variantId, addressId and requestId. Everything
  // commercial - price, discount, shipping, tax, total, delivery count -
  // is resolved server-side from the catalog and the customer's own
  // address row, so none of it may travel from the browser.
  assert.match(annualPortalCode, /body: JSON\.stringify\(\{ variantId, addressId, requestId \}\)/);
  const body = annualPortalCode.slice(
    annualPortalCode.indexOf('fetch("/api/annual-plan/checkout/session"'),
    annualPortalCode.indexOf("const body = await res.json()"));
  assert.ok(body.length > 100, "the request could not be located");
  for (const commercial of [
    "totalGrossCents", "priceGrossCents", "price_gross_cents", "discount", "shipping",
    "tax", "deliveryCount", "amount", "currency",
  ]) {
    assert.ok(!body.includes(commercial), `a commercial value is sent: ${commercial}`);
  }
  // The authorization is the customer's own session, not an admin key.
  assert.match(body, /Authorization: `Bearer \$\{session\.access_token\}`/);
  assert.ok(!annualPortalCode.includes("SERVICE_ROLE"), "the browser reaches for a service role key");
});

test("3c: the same intent is not charged twice", () => {
  // The id is keyed on (variant, address), so a double press reuses it.
  // The UNIQUE constraint on payment_checkout_attempt_id is the real
  // guarantee; this is the part of it the browser is responsible for.
  assert.match(annualPortalCode, /const intentKey = `\$\{variantId\}\|\$\{addressId\}`/);
  assert.match(annualPortalCode, /if \(tokenRef\.current\?\.key !== intentKey\)/);
  // Minted in the handler, never during render: a render-time id is not
  // a pure value and would differ between the two renders of a double
  // click, producing two plans for one intent.
  const at = annualPortalCode.indexOf("const start = async () =>");
  assert.ok(at > 0, "the handler could not be located");
  assert.ok(annualPortalCode.slice(at).includes("randomUUID()"), "the id moved out of the handler");
  assert.ok(!annualPortalCode.slice(0, at).includes("randomUUID()"), "an id is minted during render");
  // And the button cannot be pressed while a request is in flight.
  assert.match(annualPortalCode, /disabled=\{busy \|\| !variantId \|\| !addressId\}/);
});

test("3d: only the three launch sizes are offered", () => {
  // The Metal Case carries no net weight and is absent from the
  // allowlist, so it fails here exactly as it fails server-side.
  assert.deepEqual(Object.keys(ANNUAL_LAUNCH_SIZE_BY_SKU).sort(),
    ["GLOA-MATCHA-100G", "GLOA-MATCHA-30G", "GLOA-MATCHA-50G"]);
  assert.equal(ANNUAL_LAUNCH_SIZE_BY_SKU["GLOA-CASE"], undefined);
  assert.match(annualPortalCode,
    /const eligible = \(product\?\.variants \?\? \[\]\)\.filter\(v => ANNUAL_LAUNCH_SIZE_BY_SKU\[v\.sku\] !== undefined\)/);
});

test("3e: Germany only, stated before the price rather than after the payment", () => {
  assert.equal(isAnnualDeliveryCountry("DE"), true);
  assert.equal(isAnnualDeliveryCountry("de"), true);
  assert.equal(isAnnualDeliveryCountry("AT"), false);
  assert.equal(isAnnualDeliveryCountry(null), false);
  assert.equal(isAnnualDeliveryCountry(""), false);
  // Only German addresses are OFFERED, so the customer is never given a
  // choice whose only outcome is the route's refusal.
  assert.match(annualPortalCode,
    /const germanAddresses = addresses\.filter\(a => isAnnualDeliveryCountry\(normalizeCountryCode\(a\.country\)\)\)/);
  // With no German address there is no form at all, and the reason is
  // told apart from "you have no addresses".
  assert.match(annualPortalCode, /germanAddresses\.length === 0 \?/);
  assert.match(annualPortalSource, /Für einen Jahresplan brauchen wir eine Lieferadresse in Deutschland\./);
  assert.match(annualPortalSource, /Deine hinterlegten Adressen liegen außerhalb Deutschlands\./);
  assert.match(annualPortalSource, /ADRESSE HINTERLEGEN/);
});

test("3f: the form shows the same total the server will charge", () => {
  // Rendered from buildAnnualPricing - the leaf the checkout route
  // prices with - so the figure on screen and the figure charged are
  // computed by the same code rather than agreeing by coincidence.
  assert.match(annualPortalCode, /buildAnnualPricing\(\{ size, catalogUnitGrossCents: variant\.price_gross_cents \}\)/);
  assert.match(checkoutRoute, /buildAnnualPricing\(/);
  for (const line of [
    "pricing.discountPercentApplied", "pricing.annualUnitGrossCents", "pricing.merchandiseTotalGrossCents",
    "pricing.shippingPerDeliveryGrossCents", "pricing.shippingTotalGrossCents", "pricing.totalGrossCents",
  ]) {
    assert.ok(annualPortalCode.includes(line), `the form stopped showing ${line}`);
  }
  // And it says plainly that this is the whole of it.
  assert.match(annualPortalSource, /Gesamt, einmalig/);
  assert.match(annualPortalSource, /es folgt keine weitere Abbuchung/);
});

test("3g: the arithmetic behind those lines, executed", () => {
  // Not a restated number: the leaf is called, and the identities that
  // must hold for any size are checked against its own output.
  for (const sku of Object.keys(ANNUAL_LAUNCH_SIZE_BY_SKU)) {
    const size = ANNUAL_LAUNCH_SIZE_BY_SKU[sku];
    const result = buildAnnualPricing({ size, catalogUnitGrossCents: 2490 });
    assert.ok(result.ok, `pricing failed for ${size}`);
    const p = result.pricing;
    assert.equal(p.deliveryCount, ANNUAL_DELIVERY_COUNT);
    assert.equal(p.discountPercentApplied, ANNUAL_DISCOUNT_PERCENT);
    // The discount is on the merchandise, and shipping is added after it.
    assert.equal(p.merchandiseTotalGrossCents, p.annualUnitGrossCents * ANNUAL_DELIVERY_COUNT);
    assert.equal(p.shippingTotalGrossCents, p.shippingPerDeliveryGrossCents * ANNUAL_DELIVERY_COUNT);
    assert.equal(p.totalGrossCents, p.merchandiseTotalGrossCents + p.shippingTotalGrossCents);
    assert.ok(p.annualUnitGrossCents < p.catalogUnitGrossCents, "the annual unit is not discounted");
    assert.equal(p.shippingPerDeliveryGrossCents, ANNUAL_SHIPPING_PER_DELIVERY_GROSS_CENTS[size]);
  }
});

/* ── 4. The return from the payment page ────────────────────── */

test("4a: nothing celebrates a purchase the webhook has not confirmed", () => {
  // resolveAnnualCheckoutReturnState decides, from the customer's OWN
  // rows. The banner adds no judgement of its own.
  assert.match(annualPortalCode, /setAnnualState\(resolveAnnualCheckoutReturnState\(\{/);
  assert.match(annualPortalCode, /targetAnnualPlanId: params\.annualPlanId/);
  assert.equal(ANNUAL_CHECKOUT_RETURN_PARAM, "annualPlanId");
  assert.match(annualPortalCode, /annualPlanId: p\.get\(ANNUAL_CHECKOUT_RETURN_PARAM\)/);
});

test("4b: the id in the URL is a selector, never an authority", () => {
  // A stranger's id, a guess and a deleted row must all answer
  // identically, because RLS returns only the caller's own plans and the
  // target is then looked for among them.
  const mine = { id: "mine", status: "active", payment_status: "paid", purchased_at: "2026-09-01T00:00:00Z" };
  const stranger = resolveAnnualCheckoutReturnState({ targetAnnualPlanId: "not-mine", plans: [mine] });
  const missing = resolveAnnualCheckoutReturnState({ targetAnnualPlanId: "gone", plans: [] });
  assert.deepEqual(stranger, missing, "an unknown id is distinguishable from an absent one");
  // An unpaid row is not reported as bought.
  const pending = resolveAnnualCheckoutReturnState({
    targetAnnualPlanId: "p",
    plans: [{ id: "p", status: "pending_payment", payment_status: "pending", purchased_at: null }],
  });
  const paid = resolveAnnualCheckoutReturnState({ targetAnnualPlanId: "mine", plans: [mine] });
  assert.notDeepEqual(pending, paid, "an unpaid plan reports the same state as a paid one");
});

test("4c: the return page does not poll, and asks no payment provider", () => {
  const banner = annualPortalBare.slice(annualPortalBare.indexOf("function CheckoutReturnBanner()"));
  assert.ok(banner.length > 500, "the return banner could not be located");
  for (const polling of ["setInterval", "setTimeout", "requestAnimationFrame"]) {
    assert.ok(!banner.includes(polling), `the return banner polls with ${polling}`);
  }
  assert.ok(!banner.includes("/api/"), "the return banner calls an API route");
  // ONE read, for the four columns the decision needs.
  assert.match(banner, /\.from\("annual_plans"\)\.select\("id, status, payment_status, purchased_at"\)/);
});

test("4d: the account landing carries the return parameters through", () => {
  // The annual route returns to /account with its own parameters, and
  // /account bounces a signed-in customer to the dashboard. Dropping the
  // query there would have silently swallowed every annual return.
  const account = site.slice(site.indexOf("function Account()"), site.indexOf("function Account()") + 1500);
  assert.match(account,
    /useEffect\(\(\)=>\{if\(!authLoading&&user\)window\.location\.href="\/account\/dashboard"\+window\.location\.search\}/);
  assert.match(checkoutRoute, /\/account\?annual=/);
});

/* ── 5. The customer's own plans ────────────────────────────── */

test("5a: the plan list is built by the leaf, with no arithmetic of its own", () => {
  assert.match(annualPortalCode, /buildAnnualPlanAccountView\(plan, deliveries\.filter\(d => d\.annual_plan_id === plan\.id\)\)/);
  // Two reads for any number of plans, not one per plan.
  const list = annualPortalCode.slice(
    annualPortalCode.indexOf("function PortalAnnualPlans("),
    annualPortalCode.indexOf("function annualStatusLabel("));
  assert.ok(list.length > 500, "the plan list could not be located");
  assert.equal([...list.matchAll(/await supabase/g)].length, 2, "the plan list became an N+1");
  assert.match(list, /\.in\("annual_plan_id", plans\.map\(p => p\.id\)\)/);
});

test("5b: the browser asks only for the columns the migration grants it", () => {
  // The grant is column-level, so asking for more is refused by the
  // database. Asserting it here keeps the failure at build time.
  for (const forbidden of [
    "stripe_payment_intent_id", "payment_checkout_attempt_id",
    "shipping_address", "billing_address", "tax_snapshot",
  ]) {
    assert.ok(!ANNUAL_PLAN_ACCOUNT_SELECT.includes(forbidden), `the account select asks for ${forbidden}`);
    assert.ok(!annualPortalBare.includes(forbidden), `the portal reads ${forbidden}`);
  }
  assert.match(annualPortalCode, /\.select\(ANNUAL_PLAN_ACCOUNT_SELECT\)/);
  assert.match(annualPortalCode, /\.select\(ANNUAL_PLAN_DELIVERY_ACCOUNT_SELECT\)/);
});

test("5c: a prepaid plan is never described as an Abo", () => {
  const list = annualPortalSource.slice(
    annualPortalSource.indexOf("function PortalAnnualPlans("),
    annualPortalSource.indexOf("function annualStatusLabel("));
  // The two contracts differ in exactly the ways a customer would care
  // about, so the copy must not borrow the subscription's vocabulary.
  for (const wrong of ["Kündigung", "kündigen", "Kündigungsfrist", "monatlich"]) {
    assert.ok(!list.includes(wrong), `the annual card says ${wrong}`);
  }
  assert.match(list, /Einmal bezahlt, keine automatische Verlängerung\./);
  assert.match(list, /DEIN JAHRESPLAN/);
});

test("5d: a refunded or cancelled plan is not reported as running", () => {
  const label = annualPortalCode.slice(annualPortalCode.indexOf("function annualStatusLabel("));
  assert.ok(label.length > 100, "the status label could not be located");
  // Order matters: cancelled and refunded are checked BEFORE active, so
  // a row that is both cannot report the friendlier of the two.
  assert.ok(label.indexOf('v.cancelledAt || v.status === "cancelled"') < label.indexOf('v.status === "active"'));
  assert.ok(label.indexOf('v.paymentStatus === "refunded"') < label.indexOf('v.status === "active"'));
  // And an unpaid plan says so rather than showing nothing.
  assert.match(label, /if \(!v\.purchasedAt\) return "Zahlung wird verarbeitet";/);
});

test("5e: the card's delivery counts are the leaf's, executed", () => {
  const purchasedAt = "2026-01-05T09:00:00.000Z";
  const plan = {
    id: "plan-1", status: "active", payment_status: "paid", currency: "EUR",
    delivery_count: ANNUAL_DELIVERY_COUNT,
    catalog_unit_gross_cents: 2490, annual_unit_gross_cents: 2241,
    shipping_per_delivery_gross_cents: 0,
    merchandise_total_gross_cents: 2241 * ANNUAL_DELIVERY_COUNT,
    shipping_total_gross_cents: 0,
    total_gross_cents: 2241 * ANNUAL_DELIVERY_COUNT,
    refunded_total_cents: 0,
    discount_percent_applied: "10.00",
    delivery_items_snapshot: null,
    purchased_at: purchasedAt, plan_end_at: null, completed_at: null, cancelled_at: null,
  };
  // Three settled, ten still open - the card renders exactly this.
  const deliveries = Array.from({ length: ANNUAL_DELIVERY_COUNT }, (_, i) => ({
    delivery_number: i + 1,
    scheduled_for: new Date(Date.parse(purchasedAt) + i * ANNUAL_DELIVERY_INTERVAL_DAYS * 86400000).toISOString(),
    state: i < 3 ? "fulfilled" : "scheduled",
    fulfilled_at: i < 3 ? new Date(Date.parse(purchasedAt) + i * ANNUAL_DELIVERY_INTERVAL_DAYS * 86400000).toISOString() : null,
    order_id: i < 3 ? `order-${i + 1}` : null,
  }));
  const view = buildAnnualPlanAccountView(plan, deliveries);
  assert.ok(view, "the view could not be built");
  assert.equal(view.deliveryCount, ANNUAL_DELIVERY_COUNT);
  assert.equal(view.fulfilledDeliveries, 3);
  assert.equal(Math.max(0, view.deliveryCount - view.fulfilledDeliveries), 10);
  assert.equal(view.nextDelivery?.deliveryNumber, 4);
});

/* ── 6. The admin overview, read only ───────────────────────── */

test("6a: the annual admin route can only read", () => {
  // No insert, update, upsert, delete or remote procedure anywhere in it.
  const route = withoutComments(adminRoute);
  for (const write of [".insert(", ".update(", ".upsert(", ".delete(", ".rpc("]) {
    assert.ok(!route.includes(write), `the annual admin route performs ${write}`);
  }
  // POST is the verb because the filters are a body, not because
  // anything is written. No other verb is exported.
  const verbs = [...adminRoute.matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)\(/g)].map(m => m[1]);
  assert.deepEqual(verbs, ["POST"]);
});

test("6b: a VIEWER may not open it, and is not shown the door", () => {
  // Same capability as the subscription overview: this is customer
  // billing data, so it takes the restricted read rather than "read".
  assert.match(adminRoute, /requireAdminIdentity\(request, "read_sensitive"\)/);
  assert.equal(roleSatisfies("viewer", "read_sensitive"), false);
  assert.equal(roleSatisfies("admin", "read_sensitive"), true);
  assert.equal(roleSatisfies("owner", "read_sensitive"), true);
  assert.equal(canWrite(parseAdminRole(undefined)), false);
  // The tab shares the subscription predicate rather than growing a
  // weaker one of its own.
  assert.match(adminOverview, /\(key === "subscriptions" \|\| key === "annual"\) && !maySeeSubscriptions \? null :/);
  assert.match(adminOverview, /view === "annual" && maySeeSubscriptions && <AdminAnnualPlans/);
});

test("6c: a page of many plans costs the same round trips as a page of one", () => {
  // Three waves: the page, every delivery row for it in one .in(...),
  // then the orders behind those deliveries in one .in(...).
  const route = withoutComments(adminRoute);
  assert.match(route, /\.in\("annual_plan_id", ids\)/);
  assert.match(route, /\.in\("id", orderIds\)/);
  // No per-row read inside a loop.
  assert.ok(!/\.map\([^)]*=>[^)]*await supabase/.test(route), "the route reads per row");
  assert.ok(!/for \([^)]*\) \{[^}]*await supabase\.from/s.test(route), "the route reads in a loop");
  // The cap is declared rather than silently applied.
  assert.equal(DELIVERIES_PER_PLAN_CAP, ANNUAL_DELIVERY_COUNT);
  assert.match(adminUi, /Der Lieferplan wurde gekürzt/);
});

test("6d: the summary counts are database counts built from the filters they label", () => {
  assert.match(adminRoute, /const head = \(\) => supabase\.from\("annual_plans"\)\.select\("id", \{ count: "exact", head: true \}\)/);
  assert.deepEqual([...ANNUAL_SUMMARY_GROUPS], ["aktiv", "abgeschlossen", "zahlungsproblem", "beendet"]);
  // Every group resolves to a real filter, so a card cannot label a
  // count that no query produced.
  for (const group of ANNUAL_SUMMARY_GROUPS) {
    const filter = annualGroupFilter(group);
    assert.ok(filter && (filter.statusIn || filter.paymentIn), `${group} has no filter`);
  }
  // A failed count is a dash, never a silent zero.
  assert.match(adminUi, /=== null \? "—"/);
  assert.match(adminUi, /aria-pressed=\{group === key\}/);
});

test("6e: the admin says Letzter Versand, because that is what the database knows", () => {
  // annual_plan_deliveries records shipped_at. Nothing records a
  // delivery, so calling it one would be inventing a fact.
  assert.match(adminUi, /Letzter Versand/);
  assert.ok(!adminUiBare.includes("Letzte Lieferung"), "the admin claims a delivery date");
  assert.ok(!adminUiBare.includes("Zugestellt"), "the admin claims a delivery");
  assert.ok(!ANNUAL_DELIVERY_COLUMNS.includes("delivered_at"), "a delivered_at column appeared");
  // The fact comes from the schedule builder, from shipped_at.
  const deliveries = [
    { annual_plan_id: "p1", delivery_number: 1, scheduled_for: "2026-01-05T00:00:00Z", state: "fulfilled", fulfilled_at: "2026-01-05T06:00:00Z", order_id: "o1" },
    { annual_plan_id: "p1", delivery_number: 2, scheduled_for: "2026-02-02T00:00:00Z", state: "scheduled", fulfilled_at: null, order_id: null },
  ];
  // THE DATE COMES FROM shipped_at ON THE ORDER - the only column in
  // this system that records that a parcel actually left.
  const facts = buildScheduleFacts(deliveries, [
    { id: "o1", order_number: "GL-1", placed_at: "2026-01-05T06:00:00Z", fulfillment_status: "shipped", shipped_at: "2026-01-06T00:00:00Z" },
  ]);
  assert.equal(facts.p1.lastShipmentAt, "2026-01-06T00:00:00Z");
  assert.equal(facts.p1.fulfilled, 1);
  assert.equal(facts.p1.nextDeliveryNumber, 2);
  // An order that exists but has NOT shipped yields no date, rather than
  // borrowing the order timestamp and calling it a shipment.
  const unshipped = buildScheduleFacts(deliveries, [
    { id: "o1", order_number: "GL-1", placed_at: "2026-01-05T06:00:00Z", fulfillment_status: "pending", shipped_at: null },
  ]);
  assert.equal(unshipped.p1.lastShipmentAt, null);
  assert.equal(unshipped.p1.lastOrderAt, "2026-01-05T06:00:00Z");
});

test("6f: what was prepaid is reported net of refunds", () => {
  assert.equal(prepaidGrossCents([{ total_gross_cents: 26897, refunded_total_cents: 0 }]), 26897);
  assert.equal(prepaidGrossCents([{ total_gross_cents: 26897, refunded_total_cents: 26897 }]), 0);
  assert.equal(prepaidGrossCents([{ total_gross_cents: 26897, refunded_total_cents: 5000 }]), 21897);
  // It is a SUM across the whole book, so one fully refunded plan does
  // not drag the figure below what the others genuinely brought in.
  assert.equal(prepaidGrossCents([
    { total_gross_cents: 26897, refunded_total_cents: 26897 },
    { total_gross_cents: 25207, refunded_total_cents: 0 },
  ]), 25207);
  // Nonsense is skipped rather than guessed at, and an over-refund
  // clamps at zero instead of producing a negative.
  assert.equal(prepaidGrossCents([{ total_gross_cents: null, refunded_total_cents: 0 }]), 0);
  assert.equal(prepaidGrossCents([{ total_gross_cents: 100, refunded_total_cents: 500 }]), 0);
  assert.equal(prepaidGrossCents([]), 0);
});

/* ── 7. The engine, and everything else, is untouched ───────── */

test("7a: the annual engine is still the one that runs", () => {
  // This package is a caller. If any of these had to be replaced, the
  // claim "the backend was already complete" was wrong.
  for (const file of [
    "lib/annualPlanRules.ts",
    "lib/annualPlanCheckout.ts",
    "lib/annualPlanAccount.ts",
    "lib/annualPlanMaintenance.ts",
  ]) {
    assert.ok(read(file).length > 0, `${file} disappeared`);
  }
  // The scheduler still runs from the one job it always ran from.
  assert.match(read("app/api/cron/retry-order-notifications/route.ts"), /runAnnualPlanMaintenanceJob\(\)/);
});

test("7b: the payment architecture is unchanged - nothing new is created there", () => {
  // No product or price is created, looked up or named by any surface
  // this package added. The checkout route builds its own line items
  // exactly as it did before.
  for (const [label, source] of [["portal", annualPortalBare], ["admin ui", adminUiBare], ["admin route", adminRouteBare]]) {
    for (const forbidden of ["prod_", "lookup_key", "products.create", "prices.create", "stripe.prices", "stripe.products"]) {
      assert.ok(!source.includes(forbidden), `${label} touches ${forbidden}`);
    }
  }
});

test("7c: the recurring subscription surface is untouched by this package", () => {
  // The two contracts share a file and a portal page. The subscription
  // form still posts where it always did, with its own fields.
  const subscriptionHalf = portal.slice(
    portal.indexOf("function SubscriptionStartForm("), portal.indexOf(ANNUAL_MARKER));
  assert.ok(subscriptionHalf.length > 500, "the subscription form could not be located");
  assert.ok(!subscriptionHalf.includes("/api/annual-plan"), "the subscription form posts to the annual route");
  assert.ok(!subscriptionHalf.includes("buildAnnualPricing"), "the subscription form prices an annual plan");
  // And the shop's 4-week option still hands over to its own portal path.
  assert.ok(site.includes('track("shop_subscription_start");window.location.href=subscriptionPortalHref(v.sku)'));
});

test("7d: B2B is not touched, and no second order writer was added", () => {
  for (const [label, source] of [["portal", annualPortalBare], ["admin ui", adminUiBare], ["admin route", adminRouteBare]]) {
    for (const forbidden of ["b2b", "B2B", "wholesale", "offer_model", "discount_pct"]) {
      assert.ok(!source.includes(forbidden), `${label} reaches into ${forbidden}`);
    }
  }
  // The annual plan's orders are written by the maintenance job, which
  // this package did not touch. Nothing added here writes one.
  for (const source of [annualPortalBare, adminUiBare, adminRouteBare]) {
    assert.ok(!source.includes('from("orders").insert'), "a second order writer appeared");
  }
});

test("7e: this suite runs in npm test", () => {
  // A focused suite that is never invoked protects nothing. npm test is
  // an explicit file list, so registration is a real step.
  assert.ok(pkg.scripts.test.includes("tests/annual-plan-purchase-surface.test.mjs"),
    "the annual purchase suite is not registered in npm test");
});
