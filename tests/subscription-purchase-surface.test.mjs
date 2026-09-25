import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SUBSCRIPTION_LAUNCH_GRAMS_BY_SKU,
  SUBSCRIPTION_LAUNCH_SKUS,
  SUBSCRIPTION_PORTAL_PATH,
  isSubscribableVariant,
  subscriptionPortalHref,
  subscriptionSkuFromHint,
  SUBSCRIPTION_DE_SHIPPING_PER_DELIVERY_GROSS_CENTS,
  SUBSCRIPTION_SHIPPING_BENEFIT_COUNTRY,
  SUBSCRIPTION_FREE_SHIPPING_FROM_GRAMS,
  SUBSCRIPTION_FREE_SHIPPING_NOTE,
  SUBSCRIPTION_ABROAD_SHIPPING_NOTE,
  isSubscriptionBenefitCountry,
  subscriptionShippingGrossCents,
  subscriptionShipsFreeInGermany,
} from "../lib/subscriptionPurchaseRules.ts";
// The Stripe key builder, to prove the paid case stays deterministic.
import { recurringPriceLookupKey } from "../lib/stripeRecurringPrice.ts";
// The destination authority, to prove the benefit does not travel.
import { computeShippingGrossCents } from "../lib/shipping.ts";
import { LAUNCH_SUBSCRIPTION_SKUS, SUBSCRIPTION_QUANTITY } from "../lib/subscriptionCheckoutRules.ts";
import { ANNUAL_LAUNCH_SKUS } from "../lib/annualPlans.ts";
import { SUBSCRIPTION_CADENCE_LABEL, SUBSCRIPTION_QUANTITY_LABEL, CADENCE_DAYS } from "../lib/subscriptionCancellationRules.ts";
import {
  SUBSCRIPTION_STATUSES,
  SUBSCRIPTION_STATUS_LABEL,
  formatCadence,
  formatCents,
  normalizeSubscriptionSearch,
  parseSubscriptionStatus,
  resolveSubscriptionsQuery,
  shortStripeId,
  subscriptionCustomer,
  subscriptionPlanFacts,
  subscriptionsPageRange,
  SUBSCRIPTION_LIST_COLUMNS,
  SUBSCRIPTION_ATTEMPT_COLUMNS,
  SUBSCRIPTION_ORDER_COLUMNS,
  SUBSCRIPTION_GROUPS,
  SUBSCRIPTION_GROUP_LABEL,
  SUBSCRIPTION_SORTS,
  SUBSCRIPTION_SORT_COLUMN,
  SUMMARY_GROUPS,
  PAID_ATTEMPTS_PER_SUBSCRIPTION_CAP,
  REVENUE_CYCLE_DAYS,
  REVENUE_CYCLE_LABEL,
  REVENUE_ROW_CAP,
  buildCycleFacts,
  emptyCycleFacts,
  parseSubscriptionGroup,
  parseSubscriptionSort,
  recurringCycleRevenueCents,
  subscriptionGroupFilter,
} from "../lib/adminSubscriptionsQuery.ts";
// The shared view helpers the admin now reuses instead of rebuilding.
import {
  getEffectiveEndAt,
  getNextBillingAt,
  getNextDeliveryAt,
  getSubscriptionStatusLabel,
  hasEnded,
  isCancellationScheduled,
} from "../lib/subscriptionCancellationRules.ts";
import { normalizeOrderSearch } from "../lib/adminOrdersQuery.ts";
// The role leaf, imported rather than described: the access rule is
// checked against the function that decides it, not against a comment.
import { ADMIN_ROLES, canWrite, parseAdminRole, roleSatisfies } from "../lib/adminRoles.ts";

/**
 * THE B2C SUBSCRIPTION LAUNCH SURFACE.
 *
 * SAFE DEFAULT SUITE: pure rules plus source-level contract checks. No
 * socket is opened, no Supabase or Stripe client is constructed, no
 * subscription is created and no feature flag is read.
 *
 * The engine this package exposes was already complete. So the property
 * every test below protects is the same one, from three directions:
 *
 *   ONE engine       the shop, the portal and the admin all reach the
 *                    EXISTING route, RPC and tables. No second checkout,
 *                    no second price source, no second writer.
 *   ONE truth        no euro figure is decided in a browser, and no
 *                    eligibility list exists that the server does not
 *                    also enforce.
 *   NOTHING CLAIMED  the flag is untouched, the annual plan is
 *                    untouched, and no surface reports a state the
 *                    server did not report.
 */

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf-8");
const NEWLINE = String.fromCharCode(10);

const site = read("app/GloaSite.tsx");
const portal = read("app/AccountPortal.tsx");
const adminUi = read("app/AdminSubscriptions.tsx");
const adminRoute = read("app/api/admin/subscriptions/route.ts");
const adminOverview = read("app/AdminOverview.tsx");
const purchaseRules = read("lib/subscriptionPurchaseRules.ts");
const checkoutRoute = read("app/api/subscriptions/checkout/session/route.ts");

/** Code only: the prose deliberately names what it refuses to do. */
const withoutComments = source => source
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split(NEWLINE)
  .filter(line => {
    const t = line.trim();
    return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*") && !t.startsWith("{/*");
  })
  .join(NEWLINE);

/** The shop's 4-week components, sliced at their own marker. */
const shopSubscription = (() => {
  const from = site.indexOf("/* ══ THE 4-WEEK SUBSCRIPTION, IN THE SHOP ══");
  assert.notEqual(from, -1, "the 4-week shop marker was not found");
  const to = site.indexOf("/** One product's purchase block on the shop page");
  assert.ok(to > from, "the 4-week block has no end");
  return site.slice(from, to);
})();
const shopSubscriptionCode = withoutComments(shopSubscription);

/* ══════════════════════════════════════════════════════════════
   1. ELIGIBILITY — THE SAME THREE SKUS, AND NO FOURTH
   ══════════════════════════════════════════════════════════════ */

test("1: the browser's allowlist is exactly the server's", () => {
  // The leaf restates LAUNCH_SUBSCRIPTION_SKUS because it cannot import
  // it: lib/subscriptionCheckoutRules.ts opens with `import { createHash }
  // from "node:crypto"` and would break any browser bundle. The
  // duplication is therefore ASSERTED here, which is how this repository
  // already resolves the same constraint for STALE_SENDING_AFTER_MS and
  // divideRoundHalfUp.
  assert.deepEqual([...SUBSCRIPTION_LAUNCH_SKUS], [...LAUNCH_SUBSCRIPTION_SKUS],
    "the shop offers a different set of SKUs than the server accepts");
  assert.deepEqual([...SUBSCRIPTION_LAUNCH_SKUS],
    ["GLOA-MATCHA-30G", "GLOA-MATCHA-50G", "GLOA-MATCHA-100G"]);
  // And the leaf really is a leaf, or the shop cannot load it.
  // Comment-stripped: the file EXPLAINS that it cannot import node:crypto,
  // and the prose naming what it refuses to do must not trip the rule.
  const leafCode = withoutComments(purchaseRules);
  assert.ok(!/^import /m.test(leafCode), "lib/subscriptionPurchaseRules.ts gained an import");
  assert.ok(!leafCode.includes("node:crypto"), "the leaf reached for node:crypto");
});

test("1b: the three launch weights, cross-checked against the SKU", () => {
  assert.deepEqual({ ...SUBSCRIPTION_LAUNCH_GRAMS_BY_SKU },
    { "GLOA-MATCHA-30G": 30, "GLOA-MATCHA-50G": 50, "GLOA-MATCHA-100G": 100 });
  for (const sku of SUBSCRIPTION_LAUNCH_SKUS) {
    assert.equal(isSubscribableVariant({ sku, size_grams: SUBSCRIPTION_LAUNCH_GRAMS_BY_SKU[sku] }), true, sku);
  }
});

test("2: THE METAL CASE CANNOT SUBSCRIBE, and fails both halves of the check", () => {
  // The real catalog row: unlisted SKU, and no net weight at all,
  // because migration 020 stores size_grams NULL for an accessory sold
  // as a unit.
  assert.equal(isSubscribableVariant({ sku: "GLOA-CASE-01", size_grams: null }), false);
  // Not even if someone gave it a weight.
  assert.equal(isSubscribableVariant({ sku: "GLOA-CASE-01", size_grams: 30 }), false);
  // And a Matcha SKU whose weight disagrees with the allowlist is
  // refused too - a 50 g identity over a 30 g tin is a mis-sale.
  assert.equal(isSubscribableVariant({ sku: "GLOA-MATCHA-50G", size_grams: 30 }), false);
  assert.equal(isSubscribableVariant({ sku: "GLOA-MATCHA-30G", size_grams: null }), false);
  // Fails closed on every shape of nonsense.
  for (const junk of [null, undefined, "", 0, [], {}, { sku: "" }, { sku: "GLOA-MATCHA-30G" }]) {
    assert.equal(isSubscribableVariant(junk), false, String(JSON.stringify(junk)));
  }
  // The SERVER refuses it as well, so the browser list is a convenience
  // and never the only guard.
  assert.ok(!LAUNCH_SUBSCRIPTION_SKUS.includes("GLOA-CASE-01"), "the server would accept the Metal Case");
  assert.match(read("lib/subscriptionCheckout.ts"),
    /if \(!LAUNCH_SUBSCRIPTION_SKUS\.includes\(item\.sku\)\)/,
    "the checkout stopped checking the launch allowlist");
});

test("2b: the subscription and annual allowlists are independent lists", () => {
  // They happen to hold the same three SKUs today. They are separate
  // decisions answering to separate server rules, and the shop gates
  // each option on its own - so one may change without the other.
  assert.deepEqual([...SUBSCRIPTION_LAUNCH_SKUS].sort(), [...ANNUAL_LAUNCH_SKUS].sort());
  assert.ok(site.includes("showSubscription={subscribable}"));
  assert.ok(site.includes("showAnnual={annual!==null}"));
});

/* ══════════════════════════════════════════════════════════════
   3. THE SHOP — WHAT IT SAYS, AND WHAT IT REFUSES TO COMPUTE
   ══════════════════════════════════════════════════════════════ */

test("3: the purchase mode offers all three options, one-time first", () => {
  assert.ok(site.includes('type PurchaseMode = "one_time" | "subscription" | "annual"'));
  assert.ok(site.includes('const [mode,setMode]=useState<PurchaseMode>("one_time");'),
    "the shop no longer defaults to one-time");
  assert.ok(shopSubscription.includes(">Einmalig kaufen<"), "the one-time option label changed");
  assert.ok(shopSubscription.includes(">Jahresplan<"), "the annual option label changed");
  // The 4-week label is READ from the rules module, never typed.
  assert.ok(shopSubscription.includes("{SUBSCRIPTION_CADENCE_LABEL}"),
    "the cadence label is hardcoded in the shop");
  assert.equal(SUBSCRIPTION_CADENCE_LABEL, "Alle 4 Wochen");
});

test("3b: every 4 weeks, one package, and NO discount - all three stated", () => {
  assert.ok(shopSubscription.includes("Kein Abo-Rabatt"), "the shop stopped stating the absence of a discount");
  // Twice: once in the option meta so it is visible before the panel
  // opens, once in the panel itself.
  assert.ok((shopSubscription.match(/Kein Abo-Rabatt/g) || []).length >= 2,
    "the no-discount statement is not visible from the selector");
  assert.ok(shopSubscription.includes("{SUBSCRIPTION_QUANTITY_LABEL}"), "the quantity is hardcoded");
  assert.ok(shopSubscription.includes("{CADENCE_DAYS}"), "the 28-day figure is hardcoded");
  assert.equal(CADENCE_DAYS, 28);
  assert.equal(SUBSCRIPTION_QUANTITY_LABEL, "1 Packung");
  assert.equal(SUBSCRIPTION_QUANTITY, 1, "one package per cycle is no longer the contract");
  // It is NEVER monthly, and no savings claim is invented.
  for (const banned of [/monatlich/i, /monthly/i, /pro Monat/i, /%\s*(sparen|günstiger|Rabatt)/i]) {
    assert.ok(!banned.test(shopSubscriptionCode), `misleading wording in the shop: ${banned}`);
  }
});

test("3c: the price is the catalog's, and no total is computed in the browser", () => {
  // The one figure shown is product_variants.price_gross_cents - the
  // same column buildAuthoritativeQuote resolves server-side.
  assert.ok(shopSubscription.includes("{fmtCents(variant.price_gross_cents)} €"),
    "the panel stopped showing the catalog price");
  // NO SHIPPING ARITHMETIC. Its amount depends on the delivery address,
  // which a signed-out shop page does not have.
  assert.ok(!shopSubscriptionCode.includes("computeShippingGrossCents"),
    "the shop computes subscription shipping");
  assert.ok(!/\b4900\b/.test(shopSubscriptionCode), "the free-shipping threshold leaked into the panel");
  assert.ok(!/\b590\b/.test(shopSubscriptionCode), "a shipping amount is hardcoded");
  // And no total of any kind is assembled here.
  for (const banned of ["totalGrossCents", "subtotal", "* 13", "*13"]) {
    assert.ok(!shopSubscriptionCode.includes(banned), `the shop computes a total: ${banned}`);
  }
  // Not one hardcoded euro figure for the three real catalog prices.
  for (const cents of [1499, 2299, 3999]) {
    assert.ok(!shopSubscriptionCode.includes(String(cents)), `${cents} is hardcoded in the shop`);
  }
});

test("3d: the shop CTA hands over to the account and never posts a checkout", () => {
  // The route needs a plan id (readable only by `authenticated`) and one
  // of the customer's own saved addresses, so the shop cannot call it.
  assert.ok(site.includes('window.location.href=subscriptionPortalHref(v.sku)'),
    "the shop CTA no longer hands over to the account");
  assert.ok(!withoutComments(site).includes("/api/subscriptions/checkout"),
    "the shop posts to the subscription checkout");
  assert.ok(!shopSubscriptionCode.includes("addItem"), "a subscription reaches the cart");
  assert.ok(!site.includes('purchaseType:"subscription"'), "a subscription was given a cart purchase type");
  // Prelaunch still wins over every mode, like every other shop CTA.
  assert.ok(site.includes('onClick={SHOP_STATUS==="prelaunch"?()=>window.location.href="/contact":annualActive?'),
    "prelaunch no longer takes precedence");
});

test("3e: the handover link carries a hint and nothing else", () => {
  assert.equal(SUBSCRIPTION_PORTAL_PATH, "/account/subscriptions");
  assert.equal(subscriptionPortalHref("GLOA-MATCHA-50G"), "/account/subscriptions?sku=GLOA-MATCHA-50G");
  // An unknown SKU degrades to the bare portal path rather than putting
  // an attacker-chosen string into a URL the portal will read back.
  for (const junk of ["GLOA-CASE-01", "", null, undefined, "../../etc", "<script>"]) {
    assert.equal(subscriptionPortalHref(junk), "/account/subscriptions", String(junk));
  }
  // And the portal narrows it again on the way in.
  assert.equal(subscriptionSkuFromHint("GLOA-MATCHA-30G"), "GLOA-MATCHA-30G");
  for (const junk of ["GLOA-CASE-01", "", null, undefined, 30]) {
    assert.equal(subscriptionSkuFromHint(junk), null, String(junk));
  }
});

test("3f: an ineligible size cannot leave a subscription panel standing", () => {
  assert.ok(site.includes("const subscribable=isSubscribableVariant(v);"));
  assert.ok(site.includes('const subscriptionActive=mode==="subscription"&&subscribable;'),
    "the panel can render for a product with no subscription");
  assert.ok(site.includes('if((mode==="subscription"&&!subscribable)||(mode==="annual"&&!annual)){'),
    "a stale mode is no longer reset when the size changes");
});

/* ══════════════════════════════════════════════════════════════
   3S. SHIPPING — PER SIZE, ONE DEFINITION, SERVER-AUTHORITATIVE
   ══════════════════════════════════════════════════════════════ */

test("3s: GERMANY - 30 g pays 5,90 per delivery; 50 g and 100 g ship free", () => {
  const de = (sku, destinationGrossCents = 590) =>
    subscriptionShippingGrossCents({ sku, country: "DE", destinationGrossCents });
  assert.equal(de("GLOA-MATCHA-30G"), 590);
  assert.equal(de("GLOA-MATCHA-50G"), 0);
  assert.equal(de("GLOA-MATCHA-100G"), 0);
  assert.equal(subscriptionShipsFreeInGermany("GLOA-MATCHA-30G"), false);
  assert.equal(subscriptionShipsFreeInGermany("GLOA-MATCHA-50G"), true);
  assert.equal(subscriptionShipsFreeInGermany("GLOA-MATCHA-100G"), true);
  // The German answer never depends on what the shop rule computed.
  assert.equal(de("GLOA-MATCHA-50G", 1290), 0);
  assert.equal(de("GLOA-MATCHA-30G", 0), 590);
  // FAILS CLOSED. Null is a real answer the caller must refuse on:
  // defaulting to 0 would ship a product free by accident, defaulting to
  // 590 would charge a rule nobody approved.
  for (const junk of ["GLOA-CASE-01", "", null, undefined, 30, {}, "gloa-matcha-30g"]) {
    assert.equal(de(junk), null, String(junk));
    assert.equal(subscriptionShipsFreeInGermany(junk), false, String(junk));
  }
  // THE METAL CASE has no shipping rule AND no subscription at all.
  assert.equal(isSubscribableVariant({ sku: "GLOA-CASE-01", size_grams: null }), false);
  // Every subscribable SKU has a German rule, and nothing else does.
  assert.deepEqual(
    Object.keys(SUBSCRIPTION_DE_SHIPPING_PER_DELIVERY_GROSS_CENTS).sort(),
    [...SUBSCRIPTION_LAUNCH_SKUS].sort(),
    "the shipping table and the allowlist describe different products");
});

test("3s1: OUTSIDE GERMANY the benefit does not travel", () => {
  // The destination's own amount, passed through unchanged, for EVERY
  // size - including the two that ship free at home.
  const eu = computeShippingGrossCents("eu", 2299);
  assert.equal(eu, 1290, "the EU shipping price changed");
  for (const sku of [...SUBSCRIPTION_LAUNCH_SKUS]) {
    assert.equal(
      subscriptionShippingGrossCents({ sku, country: "FR", destinationGrossCents: eu }), 1290,
      `${sku} was waived outside Germany`);
    assert.notEqual(
      subscriptionShippingGrossCents({ sku, country: "AT", destinationGrossCents: 1290 }), 0,
      `${sku} ships free outside Germany`);
  }
  // Only "DE" gets the benefit, and the check is case/space tolerant
  // because it compares a normalised code.
  assert.equal(SUBSCRIPTION_SHIPPING_BENEFIT_COUNTRY, "DE");
  assert.equal(isSubscriptionBenefitCountry("DE"), true);
  assert.equal(isSubscriptionBenefitCountry(" de "), true);
  for (const other of ["AT", "FR", "CH", "", null, undefined, "DEU", "D"]) {
    assert.equal(isSubscriptionBenefitCountry(other), false, String(other));
  }
  // An unusable destination amount fails closed rather than shipping free.
  for (const bad of [null, undefined, "1290", -1, 1.5, NaN]) {
    assert.equal(
      subscriptionShippingGrossCents({ sku: "GLOA-MATCHA-50G", country: "FR", destinationGrossCents: bad }),
      null, String(bad));
  }
});

test("3s2: ONE definition - the German exception here, every country price there", () => {
  /*
    The exception is stated once and read three times: the server prices
    from it, the shop states it, the account states it. Every OTHER
    country's price stays in lib/shipping.ts and is never copied - a
    second country table is a second answer, and the copy would be the
    half that is wrong.
  */
  assert.match(purchaseRules, /export const SUBSCRIPTION_DE_SHIPPING_PER_DELIVERY_GROSS_CENTS/);
  // THE LEAF HOLDS NO COUNTRY PRICES. 1290/1790/1990 and the thresholds
  // belong to lib/shipping.ts and appear nowhere here.
  for (const foreign of ["1290", "1790", "1990", "7900", "4900"]) {
    assert.ok(!withoutComments(purchaseRules).includes(foreign),
      `a destination price was copied into the subscription rule: ${foreign}`);
  }
  // It is still a leaf, so the browser can load it.
  assert.ok(!/^import /m.test(withoutComments(purchaseRules)), "the rule leaf gained an import");
  // Not one consumer writes an amount of its own.
  for (const [name, src] of Object.entries({
    server: withoutComments(read("lib/subscriptionCheckout.ts")),
    shop: shopSubscriptionCode,
    account: withoutComments(read("app/AccountPortal.tsx")),
  })) {
    assert.ok(!/\b590\b/.test(src), `${name} hardcodes the 5,90 shipping amount`);
    assert.ok(!/\b4900\b/.test(src), `${name} reaches for the one-time free-shipping threshold`);
  }
  // The headline sentence is DERIVED, and it NAMES THE COUNTRY.
  assert.equal(SUBSCRIPTION_FREE_SHIPPING_FROM_GRAMS, 50);
  assert.equal(SUBSCRIPTION_FREE_SHIPPING_NOTE, "Ab 50 g kostenloser Versand innerhalb Deutschlands.");
  assert.equal(SUBSCRIPTION_ABROAD_SHIPPING_NOTE,
    "Für Lieferadressen außerhalb Deutschlands gelten die jeweiligen Versandkosten.");
  assert.match(purchaseRules,
    /`Ab \$\{SUBSCRIPTION_FREE_SHIPPING_FROM_GRAMS\} g kostenloser Versand innerhalb Deutschlands\.`/);
});

test("3s3: the SERVER is the monetary authority, and it fails closed", () => {
  const flow = withoutComments(read("lib/subscriptionCheckout.ts"));
  // The amount is resolved server-side from the DESTINATION and the SKU.
  assert.match(flow, /const destinationGrossCents = computeShippingGrossCents\(shippingZone, quote\.subtotalGrossCents\);/);
  assert.match(flow, /subscriptionShippingGrossCents\(\{/);
  assert.match(flow, /country: destinationCountry,/);
  assert.match(flow, /destinationGrossCents,/);
  assert.match(flow, /if \(shippingGrossCents === null\)/, "a missing rule no longer fails closed");
  // lib/shipping.ts is still the destination authority - the German
  // exception is layered OVER it, not instead of it.
  assert.ok(flow.includes("computeShippingGrossCents"), "the flow stopped asking the shipping module");
  /*
    THE BROWSER SENDS NO SHIPPING VALUE.

    Scoped to the BOOKING FORM, which is the only thing in the account
    that sends anything. The wider portal legitimately DISPLAYS
    shipping_gross_cents on an order and on an existing subscription -
    those are the customer's own frozen rows, read under RLS, and
    banning the string there would forbid reading a column rather than
    sending one.
  */
  const bookingForm = withoutComments(
    portal.slice(portal.indexOf("function SubscriptionStartForm("), portal.indexOf("/* ══ JAHRESPLAN: DIE VORAUSBEZAHLTEN KOMPONENTEN ══"))
  );
  assert.match(bookingForm, /body: JSON\.stringify\(\{ planId, addressId, requestId \}\)/);
  for (const forbidden of ["shippingGrossCents", "shipping_gross_cents", "totalGrossCents"]) {
    assert.ok(!bookingForm.includes(forbidden), `the booking form sends ${forbidden}`);
    assert.ok(!shopSubscriptionCode.includes(forbidden), `the shop sends ${forbidden}`);
  }
  // The form reads the rule for DISPLAY only, and the value never
  // reaches the request body - which is still exactly three fields.
  assert.match(bookingForm, /subscriptionDeShippingGrossCents\(variant\.sku\)/);
  // And the amount is used as it is: never scaled, discounted or zeroed.
  assert.ok(!/shippingGrossCents\s*[*/]/.test(flow), "the shipping amount is modified after the rule");
});

test("3s4: FREE SHIPPING CREATES NO STRIPE LINE AND NO CHARGE", () => {
  const flow = withoutComments(read("lib/subscriptionCheckout.ts"));
  // A recurring shipping Price is created ONLY above zero, so a free
  // size mints no Stripe Price and adds no line item at all - not a
  // 0,00 line that would invite "did something fail?".
  assert.match(flow, /if \(frozenShippingGrossCents > 0\) \{/);
  assert.match(flow, /let shippingPriceId: string \| null = null;/);
  const rules = withoutComments(read("lib/subscriptionCheckoutRules.ts"));
  assert.match(rules, /if \(input\.shippingPriceId\) \{\s*\n?\s*lineItems\.push/);
  // The line is RECURRING on the same cadence - never a one-time charge
  // or a Stripe shipping_rate, which would give the delivery away from
  // the second cycle onwards.
  assert.ok(!/shipping_options|shipping_rate_data|shipping_rate:/.test(flow),
    "a one-time shipping rate was used");
  // Deterministic key for the PAID case: the amount is part of it, so
  // 30 g in Germany always resolves to the same Price.
  assert.equal(recurringPriceLookupKey("shipping", "germany", 590), "gloa-shipping-germany-590-w4");
  assert.equal(recurringPriceLookupKey("shipping", "germany", 590),
    recurringPriceLookupKey("shipping", "germany", 590), "the shipping key is not deterministic");
  assert.match(flow, /kind: "shipping",\s*identifier: frozenZone,/);
});

test("3s5: the shop copy states the GERMAN rule and says it is German", () => {
  // The shop has no delivery address, so every figure it prints is the
  // German one and must say so. A bare "Kostenloser Versand" here would
  // read as a promise to an Austrian customer.
  assert.ok(shopSubscription.includes("subscriptionDeShippingGrossCents(variant.sku)"),
    "the panel stopped reading the canonical German rule");
  assert.ok(shopSubscription.includes("Kostenloser Versand innerhalb Deutschlands"),
    "the free-shipping wording lost its country");
  assert.ok(shopSubscription.includes("€ Versand je Lieferung innerhalb Deutschlands"),
    "the paid-shipping wording lost its country");
  // NO UNQUALIFIED PROMISE ANYWHERE IN THE PANEL.
  // Every occurrence must carry its country, checked as a negative
  // lookahead rather than by stripping the qualifier - stripping it
  // would leave the bare phrase behind and always fail.
  assert.ok(!/Kostenloser Versand(?! innerhalb Deutschlands)/.test(shopSubscriptionCode),
    "an unqualified free-shipping promise survives in the shop panel");
  // Both halves of the headline, and neither on its own.
  assert.ok(shopSubscription.includes("{SUBSCRIPTION_FREE_SHIPPING_NOTE} {SUBSCRIPTION_ABROAD_SHIPPING_NOTE}"),
    "the 'ab 50 g' headline is shown without its geographic bound");
  // The two required statements survive untouched.
  assert.ok(shopSubscription.includes("Kein Abo-Rabatt"), "the no-discount statement is gone");
  assert.ok(shopSubscription.includes("{SUBSCRIPTION_CADENCE_LABEL}"), "the cadence label is gone");
  // The one-time rule is named as what it is - still the shop's own.
  assert.ok(shopSubscription.includes("Für Einzelbestellungen gelten weiterhin die normalen"),
    "the panel no longer separates the one-time rule from the plan's");
});

test("3s6: the account copy follows the SELECTED address", () => {
  const portalSrc = read("app/AccountPortal.tsx");
  const form = portalSrc.slice(portalSrc.indexOf("function SubscriptionStartForm("),
    portalSrc.indexOf("/* ══ JAHRESPLAN: DIE VORAUSBEZAHLTEN KOMPONENTEN ══"));
  // The destination comes from the address the customer picked, through
  // the same normaliser lib/shipping.ts exposes.
  assert.match(form, /normalizeCountryCode\(\s*\n?\s*addresses\.find\(a => a\.id === addressId\)\?\.country\s*\n?\s*\)/);
  assert.match(form, /const deliversToGermany = isSubscriptionBenefitCountry\(selectedCountry\);/);
  // Exact figures ONLY for Germany; every other destination gets the
  // rule rather than a number, because computing one here would put the
  // monetary logic in a browser.
  assert.match(form, /if \(!deliversToGermany\) return null;/);
  assert.match(form, /subscriptionDeShippingGrossCents\(variant\.sku\)/);
  // Comment-stripped: the form EXPLAINS that importing this would put
  // the monetary logic in a browser, and the prose naming what it
  // refuses to do must not trip the rule.
  assert.ok(!withoutComments(form).includes("computeShippingGrossCents"),
    "the account duplicates the destination shipping calculation");
  // Both branches of the note exist and name the right thing.
  assert.match(form, /deliversToGermany\s*\n?\s*\? `\$\{SUBSCRIPTION_FREE_SHIPPING_NOTE\}/);
  assert.match(form, /: `\$\{SUBSCRIPTION_ABROAD_SHIPPING_NOTE\}/);
  assert.ok(form.includes("gilt nur innerhalb Deutschlands"),
    "the abroad branch does not say the benefit is German-only");
  // Still no percentage and still no invented benefit.
  assert.ok(!/\d\s*%/.test(withoutComments(form)), "a percentage appeared in the booking form");
});

/* ══════════════════════════════════════════════════════════════
   4. THE ANNUAL PLAN IS UNTOUCHED
   ══════════════════════════════════════════════════════════════ */

test("4: the annual option, panel and discount are byte-identical in intent", () => {
  // The annual option's own label and meta line, unchanged.
  assert.ok(site.includes('<span className="purchase-mode-label">Jahresplan</span>'));
  assert.ok(site.includes('<span className="purchase-mode-meta">{ANNUAL_DELIVERY_COUNT} Lieferungen · alle {ANNUAL_DELIVERY_INTERVAL_DAYS} Tage</span>'));
  // The panel's commercial copy, unchanged.
  for (const phrase of ["einmal bezahlen", "keine automatische Verlängerung",
                        "Du zahlst den Jahresgesamtbetrag einmalig.", "Jahresgesamtbetrag"]) {
    assert.ok(site.includes(phrase), `the annual panel lost: ${phrase}`);
  }
  // THE 10% RULE IS NOT TOUCHED BY THIS PACKAGE.
  assert.match(read("lib/annualPlanRules.ts"), /export const ANNUAL_DISCOUNT_PERCENT = 10;/,
    "this package changed the annual discount");
  // The annual CTA still goes to /contact and still posts nowhere.
  // The annual CTA hands over to the account now that a purchase path
  // exists - and the SHOP still posts nowhere, which is the half of this
  // assertion that always mattered.
  assert.ok(site.includes('track("shop_annual_start");window.location.href=annualPortalHref(v.sku)'));
  assert.ok(!withoutComments(site).includes("/api/annual-plan"), "the shop posts to the annual checkout");
});

/* ══════════════════════════════════════════════════════════════
   5. THE PORTAL — ONE CALLER, THREE FIELDS, NO MONEY
   ══════════════════════════════════════════════════════════════ */

const startForm = (() => {
  const at = portal.indexOf("function SubscriptionStartForm(");
  const end = portal.indexOf("/* ══ JAHRESPLAN: DIE VORAUSBEZAHLTEN KOMPONENTEN ══");
  assert.ok(at > -1 && end > at, "the booking form was not found");
  return portal.slice(at, end);
})();
const startCode = withoutComments(startForm);

test("5: the booking form calls the EXISTING route, exactly once", () => {
  assert.ok(startCode.includes('fetch("/api/subscriptions/checkout/session"'),
    "the form no longer calls the existing checkout");
  assert.equal((startCode.match(/\/api\/subscriptions\/checkout/g) || []).length, 1);
  // The route itself is still one delegating POST into the existing flow.
  assert.match(checkoutRoute, /return handleSubscriptionCheckout\(request, defaultSubscriptionCheckoutDeps\);/);
  assert.equal((checkoutRoute.match(/export async function/g) || []).length, 1);
});

test("5b: no second engine is built anywhere in the surface", () => {
  // The two PURCHASE surfaces may not touch Stripe at all.
  for (const source of [startCode, shopSubscriptionCode]) {
    for (const banned of ["stripe", "Stripe", "price_data", "unit_amount", "recurring:",
                          "createCheckoutSession", ".rpc(", ".insert(", ".update(", ".upsert(", ".delete("]) {
      assert.ok(!source.includes(banned), `a second engine appeared: ${banned}`);
    }
  }
  // The ADMIN legitimately DISPLAYS a Stripe subscription id, so the
  // ban there is on calling Stripe rather than on naming it: no client,
  // no price, no write.
  const admin = withoutComments(adminUi);
  for (const banned of ["price_data", "unit_amount", "recurring:", "createCheckoutSession",
                        "stripe.", "Stripe(", ".rpc(", ".insert(", ".update(", ".upsert(", ".delete("]) {
    assert.ok(!admin.includes(banned), `the admin reaches an engine: ${banned}`);
  }
});

test("5c: exactly the three allowed fields, and not one commercial value", () => {
  assert.match(startCode, /body: JSON\.stringify\(\{ planId, addressId, requestId \}\)/);
  for (const forbidden of ["unitAmount", "priceCents", "totalGrossCents", "shippingGrossCents",
                           "taxTotalCents", "userId", "stripeCustomerId", "quantity:"]) {
    assert.ok(!startCode.includes(forbidden), `a commercial value is sent: ${forbidden}`);
  }
});

test("5d: the flag is never mirrored, and the server's refusal is shown verbatim", () => {
  assert.ok(!withoutComments(portal).includes("B2C_SUBSCRIPTIONS_ENABLED"));
  assert.ok(!withoutComments(site).includes("B2C_SUBSCRIPTIONS_ENABLED"));
  assert.match(read(".env.example"), /^B2C_SUBSCRIPTIONS_ENABLED=$/m, "the flag entry changed");
  assert.match(startCode, /typeof body\?\.error === "string" \? body\.error/);
  // No fabricated success: the page navigates to the url the SERVER sent.
  assert.match(startCode, /window\.location\.href = url/);
});

/* ══════════════════════════════════════════════════════════════
   6. THE ADMIN AREA — READ ONLY, STRUCTURALLY
   ══════════════════════════════════════════════════════════════ */

test("6: OWNER and ADMIN may read the list; VIEWER may not", () => {
  // The route declares a RESTRICTED read. It is still a read - nothing
  // in the file writes - but it is not one a viewer may perform: the
  // list carries running contracts, their next billing dates and their
  // Stripe identifiers.
  assert.match(adminRoute, /requireAdminIdentity\(request, "read_sensitive"\)/,
    "the route no longer declares itself a restricted read");
  // It does not restate the role matrix; lib/adminRoles.ts owns it.
  const routeCode = withoutComments(adminRoute);
  for (const banned of ["owner", "viewer", "canWrite", "canRead", "roleSatisfies"]) {
    assert.ok(!routeCode.includes(banned), `the route restates the role matrix: ${banned}`);
  }

  // THE ANSWER ITSELF, from the module that gives it.
  assert.equal(roleSatisfies("owner", "read_sensitive"), true, "owner cannot read the list");
  assert.equal(roleSatisfies("admin", "read_sensitive"), true, "admin cannot read the list");
  assert.equal(roleSatisfies("viewer", "read_sensitive"), false, "VIEWER can read the list");
  // Fails closed on anything that is not a known role.
  for (const junk of [null, undefined, "", "administrator", "OWNER ", 7]) {
    if (junk === "OWNER ") continue;
    assert.equal(roleSatisfies(parseAdminRole(junk), "read_sensitive"), false, String(junk));
  }
  // A padded, cased value is still the role it names - refusing that
  // would be a bug, not a safety property.
  assert.equal(roleSatisfies(parseAdminRole("OWNER "), "read_sensitive"), true);

  // DERIVED, NOT RE-LISTED. The restricted read is exactly the write
  // set, so the two cannot drift apart.
  for (const role of [...ADMIN_ROLES, null]) {
    assert.equal(roleSatisfies(role, "read_sensitive"), canWrite(role),
      `the restricted read drifted from the write set for ${role}`);
  }
});

test("6a: no other admin permission moved", () => {
  // Every existing answer, restated so a change to roleSatisfies cannot
  // quietly alter one of them while adding the third capability.
  const EXPECTED = {
    owner:  { read: true,  read_sensitive: true,  write: true },
    admin:  { read: true,  read_sensitive: true,  write: true },
    viewer: { read: true,  read_sensitive: false, write: false },
  };
  for (const [role, caps] of Object.entries(EXPECTED)) {
    for (const [capability, expected] of Object.entries(caps)) {
      assert.equal(roleSatisfies(role, capability), expected, `${role} / ${capability}`);
    }
  }
  // An unknown role is refused every capability, including the weakest.
  for (const capability of ["read", "read_sensitive", "write"]) {
    assert.equal(roleSatisfies(null, capability), false, `null satisfied ${capability}`);
  }
  // An unknown CAPABILITY is refused too, rather than falling through to
  // the weakest answer - which is what the exhaustive switch buys.
  assert.equal(roleSatisfies("owner", "something_else"), false, "an unknown capability was granted");
  // The three roles and the three capabilities are the whole vocabulary.
  assert.deepEqual([...ADMIN_ROLES], ["owner", "admin", "viewer"]);
  assert.match(read("lib/adminRoles.ts"),
    /export type AdminCapability = "read" \| "read_sensitive" \| "write";/);
  // And every OTHER admin route keeps the capability it already had.
  const KEEP = {
    "orders": "read", "orders/detail": "read", "waitlist": "read", "activity": "read",
    "inventory/items": "read", "inventory/items/detail": "read", "inventory/categories": "read",
  };
  for (const [route, capability] of Object.entries(KEEP)) {
    assert.match(read(`app/api/admin/${route}/route.ts`),
      new RegExp(`\\(request, "${capability}"\\)`), `${route} changed capability`);
  }
});

test("6a2: the UI does not offer the section to a VIEWER", () => {
  // Presentation only - the server is the access control and is asserted
  // above - but a viewer must not be shown a door that would refuse them.
  assert.match(adminOverview, /const maySeeSubscriptions = canWrite\(parseAdminRole\(data\.identity\?\.role\)\);/,
    "the shell stopped deriving the predicate from the shared leaf");
  // Fails closed: an absent identity yields false.
  assert.equal(canWrite(parseAdminRole(undefined)), false);
  // The tab is not rendered at all for a role that may not open it -
  // not disabled, which would still announce the section.
  // The prepaid plan is the same customer data under a second tab, so
  // it shares this predicate rather than growing a weaker one of its own.
  assert.match(adminOverview, /\(key === "subscriptions" \|\| key === "annual"\) && !maySeeSubscriptions \? null :/);
  // And the screen itself is not mounted, so no request is ever issued.
  assert.match(adminOverview, /view === "subscriptions" && maySeeSubscriptions && <AdminSubscriptions/);
  // The overview note does not point a viewer at a tab they lack.
  assert.match(adminOverview, /\{maySeeSubscriptions && <> Laufende Abos unter/);
  assert.match(adminOverview, /view === "annual" && maySeeSubscriptions && <AdminAnnualPlans/);
  // No OTHER tab became role-gated by this change.
  // Five: the definition, the shared tab guard, the two mounts, and the
  // overview note. Counted so the predicate cannot quietly start gating
  // a tab that has nothing to do with the two subscription surfaces.
  assert.equal([...adminOverview.matchAll(/maySeeSubscriptions/g)].length, 5,
    "the role predicate reaches more of the shell than the two Abo sections");
});

test("6b2: the summary counts are database counts, built from the filters they label", () => {
  // One HEAD request per card, with count:"exact" - the database counts
  // and not one row crosses the wire for them.
  assert.match(adminRoute, /const head = \(\) => supabase\.from\("subscriptions"\)\.select\("id", \{ count: "exact", head: true \}\)/);
  // Each card's count is built from the SAME filter the card's tab
  // applies, so a number and the list behind it cannot disagree.
  assert.match(adminRoute, /SUMMARY_GROUPS\.map\(group =>\s*\n?\s*countOf\(applyGroup\(head\(\), subscriptionGroupFilter\(group\)\), group\)/);
  assert.deepEqual([...SUMMARY_GROUPS], ["aktiv", "gekuendigt", "zahlungsproblem", "beendet"]);
  // A failed count is null and renders as a dash - never a silent zero.
  assert.match(adminRoute, /return null;\n\s*\}\n\s*return count \?\? null;/);
  assert.match(adminUi, /s\[key\] === null \? "—" : s\[key\]/);
  assert.match(adminUi, /s\.recurringCycleGrossCents === null \? "—" :/);
  // The cards are the filters: clicking one narrows the list.
  assert.match(adminUi, /aria-pressed=\{group === key\}/);
});

test("6b3: a page of 25 costs the same round trips as a page of 1 - no N+1", () => {
  const route = withoutComments(adminRoute);
  /*
    EVERY read is either a single request or ONE `.in(...)` over the
    whole page. Nothing iterates rows issuing requests, so the query
    budget is constant in the page size.
  */
  // The two page-wide reads are `.in(...)` over the ids, not per row.
  assert.match(route, /\.in\("subscription_id", ids\)/);
  assert.match(route, /\.in\("checkout_attempt_id", attemptIds\)/);
  assert.equal((route.match(/\.in\(/g) || []).length, 4,
    "the route gained an .in() - check it is still page-wide");

  // NO REQUEST INSIDE A LOOP. These are the shapes an N+1 takes.
  for (const shape of [
    /for\s*\([^)]*\)\s*\{[^}]*supabase\./,
    /\.map\([^)]*=>\s*supabase\./,
    /\.forEach\([^)]*supabase\./,
    /rows\.map\([^)]*await/,
  ]) {
    assert.ok(!shape.test(route), `a per-row request appeared: ${shape}`);
  }
  // Every page-wide read is bounded, and every bound is reported.
  assert.match(route, /\.limit\(itemLimit\)/);
  assert.match(route, /\.limit\(attemptLimit\)/);
  assert.match(route, /\.limit\(attemptIds\.length\)/);
  assert.match(route, /\.limit\(REVENUE_ROW_CAP\)/);
  for (const flag of ["itemsCapped", "historyCapped", "recurringCapped"]) {
    assert.ok(route.includes(flag), `the route stopped reporting ${flag}`);
  }
  // The independent reads overlap rather than queue.
  assert.match(route, /await Promise\.all\(\[/);
  // And the SCREEN issues exactly one request, with no second endpoint.
  const ui = withoutComments(adminUi);
  assert.equal((ui.match(/fetch\(/g) || []).length, 1, "the screen makes a second request");
  assert.match(ui, /fetch\("\/api\/admin\/subscriptions"/);
});

test("6b: THERE IS NO WRITE VERB IN THE ADMIN SUBSCRIPTION AREA", () => {
  for (const source of [adminRoute, adminUi]) {
    for (const banned of [".insert(", ".update(", ".upsert(", ".delete(", ".rpc(", "mark_subscription_cancelled"]) {
      assert.ok(!source.includes(banned), `a write appeared: ${banned}`);
    }
  }
  // And no control that would need one.
  for (const banned of ["Kündigen", "Stornieren", "Erstatten", "Pausieren", "Preis ändern", "Abo anlegen"]) {
    assert.ok(!adminUi.includes(banned), `the admin offers ${banned}`);
  }
  // The screen SAYS it is read only, rather than leaving it to be found.
  assert.match(adminUi, /Nur Ansicht\./);
});

test("6c: it shows every field the operator was promised", () => {
  const columns = SUBSCRIPTION_LIST_COLUMNS.split(",");
  for (const column of ["id", "status", "total_gross_cents", "shipping_gross_cents",
                        "subtotal_gross_cents", "current_period_end", "next_delivery_at",
                        "stripe_subscription_id", "created_at", "started_at", "cancelled_at",
                        "cancellation_requested_at", "cancellation_effective_at",
                        "customer_snapshot", "plan_snapshot"]) {
    assert.ok(columns.includes(column), `the list stopped reading ${column}`);
  }
  // THE MISLEADING COLUMN IS NOT FETCHED. cancel_at_period_end is
  // migration 005's, nothing in the cancellation flow writes it, and
  // every production row carries false while two have a real scheduled
  // cancellation. Fetching it would only invite somebody to read it.
  assert.ok(!columns.includes("cancel_at_period_end"),
    "the misleading cancellation column is back in the wire format");

  for (const header of ["Kunde", "Produkt", "Status", "Angelegt", "Zyklen",
                        "Letzte Zahlung", "Letzte Bestellung", "Letzter Versand",
                        "Nächste Abbuchung", "Nächste Lieferung", "Matcha", "Versand",
                        "Gesamt", "Kündigung", "Stripe / Abo-ID"]) {
    assert.ok(adminUi.includes(`>${header}</th>`), `the table lost the ${header} column`);
  }
  // AND NOT ONE PERSONAL FIELD MORE than name and email, on any of the
  // four reads this screen makes.
  for (const forbidden of ["shipping_address_snapshot", "billing_address_snapshot", "tax_snapshot",
                           "items_snapshot", "delivery_tax_snapshot"]) {
    for (const [name, cols] of Object.entries({
      list: SUBSCRIPTION_LIST_COLUMNS,
      attempts: SUBSCRIPTION_ATTEMPT_COLUMNS,
      orders: SUBSCRIPTION_ORDER_COLUMNS,
    })) {
      assert.ok(!cols.includes(forbidden), `the ${name} read moves ${forbidden}`);
    }
  }
});

test("6c2: LETZTER VERSAND, never LETZTE LIEFERUNG - the audit's finding, pinned", () => {
  /*
    THE SYSTEM DOES NOT KNOW THAT ANYTHING WAS DELIVERED.

    public.orders has no delivered_at column. 'delivered' exists in the
    fulfillment_status CHECK and is READ by lib/orderStatus.ts, but
    nothing in this repository ever writes it - migration 019 says so
    explicitly. mark_order_shipped is the only writer of fulfilment
    state and it sets 'shipped' with a shipped_at.

    So the column is named for the fact that exists. If a real delivery
    confirmation is ever recorded, this test is where the rename starts.
  */
  const orders004 = read("supabase/migrations/004_orders.sql");
  assert.ok(!/delivered_at/.test(orders004), "orders gained a delivered_at column");
  for (const migration of readdirSync(path.join(ROOT, "supabase/migrations"))) {
    assert.ok(!/add column[^;]*delivered_at/i.test(read(`supabase/migrations/${migration}`)),
      `${migration} added a delivered_at column`);
  }
  assert.match(read("supabase/migrations/019_order_lifecycle_tracking.sql"),
    /'delivered' is deliberately never set automatically anywhere in this/,
    "the never-set-automatically guarantee changed");
  // The shipment value read is shipped_at, and the heading says Versand.
  assert.ok(SUBSCRIPTION_ORDER_COLUMNS.split(",").includes("shipped_at"));
  assert.ok(adminUi.includes(">Letzter Versand</th>"), "the shipment column was renamed");
  assert.ok(!adminUi.includes(">Letzte Lieferung</th>"),
    "the admin claims a delivery date the database does not hold");
  // "Nächste Lieferung" IS legitimate - it is a scheduled future date
  // from subscriptions.next_delivery_at, not a claim about the past.
  assert.ok(adminUi.includes(">Nächste Lieferung</th>"));
  assert.match(adminUi, /getNextDeliveryAt\(r\)/);
});

test("6c3: the cycle history comes from the three traces, and nothing is invented", () => {
  // PAYMENT -> ORDER -> SHIPMENT, grouped from two bounded reads.
  const A = (id, sub, paid, inv) => ({ id, subscription_id: sub, paid_at: paid, stripe_invoice_id: inv });
  const O = (attempt, num, placed, fulfil, shipped) => ({
    checkout_attempt_id: attempt, order_number: num, placed_at: placed,
    fulfillment_status: fulfil, shipped_at: shipped,
  });
  const facts = buildCycleFacts(
    [
      A("a1", "s1", "2026-01-01T10:00:00Z", "in_1"),
      A("a2", "s1", "2026-02-01T10:00:00Z", "in_2"),
      A("a3", "s2", "2026-01-15T10:00:00Z", "in_3"),
    ],
    [
      O("a1", "GLOA-1", "2026-01-01T10:05:00Z", "shipped", "2026-01-03T09:00:00Z"),
      O("a2", "GLOA-2", "2026-02-01T10:05:00Z", "unfulfilled", null),
      O("a3", "GLOA-3", "2026-01-15T10:05:00Z", "unfulfilled", null),
    ]
  );
  // Latest PAYMENT wins, and brings its own invoice id with it.
  assert.equal(facts.s1.lastPaymentAt, "2026-02-01T10:00:00Z");
  assert.equal(facts.s1.lastInvoiceId, "in_2");
  // Latest ORDER is the newest placed_at, with its number and state.
  assert.equal(facts.s1.lastOrderAt, "2026-02-01T10:05:00Z");
  assert.equal(facts.s1.lastOrderNumber, "GLOA-2");
  assert.equal(facts.s1.lastOrderFulfillment, "unfulfilled");
  // THE LAST SHIPMENT IS THE OLDER ORDER'S, because it is the only one
  // that shipped. A newest-order-wins rule would have shown "—" here.
  assert.equal(facts.s1.lastShipmentAt, "2026-01-03T09:00:00Z");
  assert.equal(facts.s1.paidCycles, 2);
  assert.equal(facts.s1.orderCount, 2);
  // Rows are grouped per subscription and never bleed into each other.
  assert.equal(facts.s2.paidCycles, 1);
  assert.equal(facts.s2.lastShipmentAt, null);

  // A paid attempt whose order does not exist counts as a CYCLE but not
  // as an order - the two numbers are allowed to disagree and say so.
  const partial = buildCycleFacts([A("a9", "s9", "2026-03-01T10:00:00Z", "in_9")], []);
  assert.equal(partial.s9.paidCycles, 1);
  assert.equal(partial.s9.orderCount, 0);
  assert.equal(partial.s9.lastOrderAt, null);
  assert.equal(partial.s9.lastShipmentAt, null);

  // Nothing at all is invented for a subscription with no history.
  assert.deepEqual(buildCycleFacts([], []), {});
  assert.deepEqual(emptyCycleFacts(), {
    lastPaymentAt: null, lastInvoiceId: null, lastOrderAt: null, lastOrderNumber: null,
    lastShipmentAt: null, lastOrderFulfillment: null, paidCycles: 0, orderCount: 0,
  });
  // A missing timestamp never becomes "the last one".
  const nulls = buildCycleFacts([A("a0", "s0", null, null)], []);
  assert.equal(nulls.s0.lastPaymentAt, null);
  assert.equal(nulls.s0.paidCycles, 1);
});

test("6c4: only PAID attempts count as cycles, and the read is bounded", () => {
  // A 'stripe_session_created' attempt is a checkout that was started,
  // not a cycle that was billed.
  assert.match(adminRoute, /\.eq\("status", "paid"\)/, "the attempt read stopped filtering on paid");
  // Bounded per page, and the cap is reported rather than silently hit.
  assert.equal(PAID_ATTEMPTS_PER_SUBSCRIPTION_CAP, 26);
  assert.match(adminRoute, /attemptLimit = Math\.max\(ids\.length, 1\) \* PAID_ATTEMPTS_PER_SUBSCRIPTION_CAP/);
  assert.match(adminRoute, /historyCapped/);
  assert.match(adminUi, /data\.historyCapped &&/, "the screen does not report a truncated history");
});

test("6d: the admin tab is mounted only when open, and named honestly", () => {
  assert.match(adminOverview, /\{view === "subscriptions" && maySeeSubscriptions && <AdminSubscriptions onSessionLost/);
  // The nav array still lists every section that EXISTS; which of them
  // an operator is offered is decided beside it, not by editing the list.
  assert.match(adminOverview, /\["subscriptions", "Abos"\]/);
  assert.match(adminOverview, /subscriptions: "Abos"/);
});

/* ══════════════════════════════════════════════════════════════
   7. THE ADMIN QUERY LEAF
   ══════════════════════════════════════════════════════════════ */

test("7: the status vocabulary is migration 022's, exactly", () => {
  const migration = read("supabase/migrations/022_recurring_subscription_foundation.sql");
  const check = migration.slice(migration.indexOf("add constraint subscriptions_status_check"));
  for (const status of SUBSCRIPTION_STATUSES) {
    assert.ok(check.includes(`'${status}'`), `${status} is not in the database CHECK`);
    assert.ok(SUBSCRIPTION_STATUS_LABEL[status], `${status} has no label`);
  }
  assert.equal(SUBSCRIPTION_STATUSES.length, 6);
  // An unknown value returns null and is printed raw, never relabelled.
  for (const junk of ["incomplete", "", null, 7, "ACTIVE ", "trialing"]) {
    if (junk === "ACTIVE ") continue;
    assert.equal(parseSubscriptionStatus(junk), null, String(junk));
  }
  assert.equal(parseSubscriptionStatus("ACTIVE "), "active", "a padded value is still the same status");
});

test("7b: the cadence is derived from each row, never printed as a constant", () => {
  assert.equal(formatCadence("week", 4), "Alle 4 Wochen");
  assert.equal(formatCadence("week", 4), SUBSCRIPTION_CADENCE_LABEL,
    "the admin and the customer disagree about the launch cadence");
  assert.equal(formatCadence("month", 1), "Jede(n) Monat");
  // Unreadable rows get a dash, never a guessed rhythm.
  for (const [unit, count] of [["", 4], ["week", null], ["week", 0], ["fortnight", 2], ["week", 1.5]]) {
    assert.equal(formatCadence(unit, count), "—", `${unit}/${count}`);
  }
  // A row frozen under another cadence shows ITS cadence.
  assert.equal(subscriptionPlanFacts({ billingIntervalUnit: "month", billingIntervalCount: 3 }).cadence,
    "Alle 3 Monate");
});

test("7c: cancellation state is the CUSTOMER's classification, not a second one", async () => {
  /*
    THE DEFECT THIS REPLACES, AND WHY THE TEST INVERTED.

    V1 carried its own cancellationView() reading
    subscriptions.cancel_at_period_end. Production disproved it: all
    four rows carry cancel_at_period_end = false while two of them hold
    a real scheduled cancellation in cancellation_requested_at /
    cancellation_effective_at. The admin would have shown "—" over a
    contract that is scheduled to end.

    cancel_at_period_end is migration 005's column and the cancellation
    flow never writes it; migration 034 introduced the columns it does
    write. So the admin no longer classifies at all - it calls the same
    helpers the customer's own account page calls.
  */
  assert.ok(!Object.keys(await import("../lib/adminSubscriptionsQuery.ts")).includes("cancellationView"),
    "the admin grew its own cancellation classifier again");

  const SCHEDULED = {
    status: "active", current_period_end: "2026-10-25T00:11:48Z", next_delivery_at: "2026-10-25T00:11:48Z",
    cancellation_requested_at: "2026-08-30T00:29:03Z", cancellation_effective_at: "2026-10-25T00:11:48Z",
    cancelled_at: null,
  };
  const PLAIN = { ...SCHEDULED, cancellation_requested_at: null, cancellation_effective_at: null };
  const ENDED = { ...SCHEDULED, status: "cancelled", cancelled_at: "2026-10-10T12:00:00Z" };

  // The exact production shape: active, cancel_at_period_end false, and
  // genuinely ending. The shared helper sees it; the old one did not.
  assert.equal(isCancellationScheduled(SCHEDULED), true, "a scheduled cancellation is invisible again");
  assert.equal(getSubscriptionStatusLabel(SCHEDULED), "Kündigung vorgemerkt");
  assert.equal(getEffectiveEndAt(SCHEDULED), "2026-10-25T00:11:48Z");
  assert.equal(hasEnded(SCHEDULED), false);

  assert.equal(getSubscriptionStatusLabel(PLAIN), "Aktiv");
  assert.equal(getEffectiveEndAt(PLAIN), null);

  assert.equal(hasEnded(ENDED), true);
  assert.equal(getSubscriptionStatusLabel(ENDED), "Beendet");

  // A scheduled cancellation stops the future dates from being promised.
  assert.equal(getNextBillingAt(ENDED), null, "an ended subscription still promises a billing date");
  assert.equal(getNextDeliveryAt(ENDED), null, "an ended subscription still promises a delivery");

  // And the SCREEN uses those helpers rather than reading the columns.
  for (const helper of ["getSubscriptionStatusLabel(r)", "isCancellationScheduled(r)",
                        "hasEnded(r)", "getEffectiveEndAt(r)",
                        "getNextBillingAt(r)", "getNextDeliveryAt(r)"]) {
    assert.ok(adminUi.includes(helper), `the admin stopped using ${helper}`);
  }
  assert.ok(!withoutComments(adminUi).includes("cancel_at_period_end === true"),
    "the admin reads the misleading column again");
});

test("7c2: the display groups map to the database without changing it", () => {
  assert.deepEqual([...SUBSCRIPTION_GROUPS], ["alle", "aktiv", "gekuendigt", "zahlungsproblem", "beendet"]);
  assert.deepEqual(SUMMARY_GROUPS.map(g => SUBSCRIPTION_GROUP_LABEL[g]),
    ["Aktiv", "Kündigung vorgemerkt", "Zahlungsproblem", "Beendet"]);

  // "Aktiv" is running WITH NO cancellation on record.
  assert.deepEqual(subscriptionGroupFilter("aktiv"),
    { statusIn: ["active"], requested: "no", notEnded: true });
  // "Kündigung vorgemerkt" is NOT keyed on a status, because a scheduled
  // cancellation leaves the row 'active' - which is the whole point.
  const scheduled = subscriptionGroupFilter("gekuendigt");
  assert.equal(scheduled.requested, "yes");
  assert.equal(scheduled.notEnded, true);
  assert.ok(!scheduled.statusIn.includes("cancelled"), "an ended row would match the scheduled group");
  // The two payment states, exactly as migration 022 spells them.
  assert.deepEqual(subscriptionGroupFilter("zahlungsproblem"), { statusIn: ["past_due", "unpaid"] });
  // "Beendet" is an OR, because the status and the date can arrive apart.
  assert.equal(subscriptionGroupFilter("beendet").or, "status.eq.cancelled,cancelled_at.not.is.null");
  // "Alle" filters nothing.
  assert.deepEqual(subscriptionGroupFilter("alle"), {});

  // Every status named by a group is one migration 022's CHECK allows -
  // no group invents or remaps a stored value.
  const migration = read("supabase/migrations/022_recurring_subscription_foundation.sql");
  const check = migration.slice(migration.indexOf("add constraint subscriptions_status_check"));
  for (const group of SUBSCRIPTION_GROUPS) {
    for (const status of subscriptionGroupFilter(group).statusIn ?? []) {
      assert.ok(check.includes(`'${status}'`), `${group} names a status the database does not have: ${status}`);
    }
  }
  // NO WRITE, anywhere in the mapping or the route.
  for (const banned of ["update", "insert", "upsert", "delete"]) {
    assert.ok(!JSON.stringify(SUBSCRIPTION_GROUPS.map(subscriptionGroupFilter)).includes(banned),
      `a group filter carries a ${banned}`);
  }
  // An unknown group shows everything rather than filtering on junk.
  for (const junk of ["", "weird", null, 7, undefined]) {
    assert.equal(parseSubscriptionGroup(junk), "alle", String(junk));
  }
});

test("7c3: sorting is done by the database, on real columns", () => {
  assert.deepEqual([...SUBSCRIPTION_SORTS], ["created", "next_billing", "next_delivery"]);
  // Newest-first is the default, so the most relevant rows lead.
  assert.equal(parseSubscriptionSort(undefined), "created");
  assert.deepEqual(SUBSCRIPTION_SORT_COLUMN.created, { column: "created_at", ascending: false });
  // The two forward-looking sorts are SOONEST first: the operator is
  // looking for what happens next, not what happened longest ago.
  assert.deepEqual(SUBSCRIPTION_SORT_COLUMN.next_billing, { column: "current_period_end", ascending: true });
  assert.deepEqual(SUBSCRIPTION_SORT_COLUMN.next_delivery, { column: "next_delivery_at", ascending: true });
  // Every sort names a column the list actually fetches.
  const columns = SUBSCRIPTION_LIST_COLUMNS.split(",");
  for (const sort of SUBSCRIPTION_SORTS) {
    assert.ok(columns.includes(SUBSCRIPTION_SORT_COLUMN[sort].column),
      `${sort} sorts on a column the list does not read`);
  }
  // The DATABASE sorts, and a tiebreaker keeps paging stable.
  assert.match(adminRoute, /\.order\(sort\.column, \{ ascending: sort\.ascending, nullsFirst: false \}\)/);
  assert.match(adminRoute, /\.order\("id", \{ ascending: true \}\)/);
  // Nothing is re-sorted in the browser, which would sort only the 25
  // rows it holds and lie about the rest.
  assert.ok(!/\.sort\(/.test(withoutComments(adminUi)), "the screen re-sorts the page client-side");
  for (const junk of ["", "price", null, 7]) {
    assert.equal(parseSubscriptionSort(junk), "created", String(junk));
  }
});

test("7c4: the recurring figure is per 4-week cycle and never called monthly", () => {
  // 28 days, agreeing with the module the cutoff arithmetic uses.
  assert.equal(REVENUE_CYCLE_DAYS, 28);
  assert.equal(REVENUE_CYCLE_DAYS, CADENCE_DAYS, "the admin and the cadence rules disagree");
  assert.equal(REVENUE_CYCLE_LABEL, "je 4 Wochen");
  // Derived from the number, never typed out.
  assert.match(read("lib/adminSubscriptionsQuery.ts"),
    /REVENUE_CYCLE_LABEL = `je \$\{REVENUE_CYCLE_DAYS \/ 7\} Wochen`/);

  // The sum itself: integer cents only, and junk contributes nothing.
  assert.equal(recurringCycleRevenueCents([{ total_gross_cents: 2589 }, { total_gross_cents: 1499 }]), 4088);
  assert.equal(recurringCycleRevenueCents([]), 0);
  for (const junk of [{ total_gross_cents: null }, { total_gross_cents: "2589" },
                      { total_gross_cents: 1.5 }, { total_gross_cents: -100 }, {}]) {
    assert.equal(recurringCycleRevenueCents([junk]), 0, JSON.stringify(junk));
  }

  // IT COUNTS THE "aktiv" SET - running, no cancellation on record -
  // because a scheduled cancellation stops billing on a known date.
  assert.match(adminRoute, /subscriptionGroupFilter\("aktiv"\)\n?\s*\)\.limit\(REVENUE_ROW_CAP\)/);
  assert.equal(REVENUE_ROW_CAP, 1000);
  assert.match(adminRoute, /recurringCapped = list\.length >= REVENUE_ROW_CAP/);

  // NEVER "monatlich", in the leaf, the route or the screen.
  //
  // Comment-stripped, the usual trap in this repository: all three files
  // EXPLAIN at length why the figure is not monthly, and the prose
  // defending the rule must not trip the rule.
  for (const [name, src] of Object.entries({
    leaf: withoutComments(read("lib/adminSubscriptionsQuery.ts")),
    route: withoutComments(adminRoute),
    ui: withoutComments(adminUi),
  })) {
    for (const banned of [/monatlich/i, /monthly/i, /pro Monat/i, /Monatsumsatz/i]) {
      assert.ok(!banned.test(src), `${name} calls the 28-day cycle monthly: ${banned}`);
    }
  }
  // And the card says what it is.
  assert.match(adminUi, /Wiederkehrend \{REVENUE_CYCLE_LABEL\}/);
});

test("7d: snapshots are read tolerantly and never invented", () => {
  assert.deepEqual(subscriptionCustomer({ name: "Tester Test", email: "a@b.de" }),
    { name: "Tester Test", email: "a@b.de" });
  assert.deepEqual(subscriptionCustomer({ first_name: "A", last_name: "B" }), { name: "A B", email: "" });
  assert.deepEqual(subscriptionCustomer(null), { name: "", email: "" });
  assert.deepEqual(subscriptionCustomer("nonsense"), { name: "", email: "" });
  // Money that is not money is a dash, never a fabricated 0,00.
  assert.equal(formatCents(2589), "25,89 €");
  for (const junk of [null, undefined, NaN, Infinity, "2589"]) assert.equal(formatCents(junk), "—");
  // Stripe identifiers are shortened, and absence is a dash.
  const long = "sub_1U9v6mDASU5R3UGE2fgQ0Ciz";
  assert.equal(shortStripeId(long), `${long.slice(0, 14)}…${long.slice(-6)}`);
  assert.ok(shortStripeId(long).length < long.length, "a long id was not shortened");
  assert.equal(shortStripeId("sub_short"), "sub_short");
  for (const junk of [null, undefined, "", "   "]) assert.equal(shortStripeId(junk), "—");
});

test("7e: the query allowlists every filter and cannot carry PostgREST syntax", () => {
  const q = resolveSubscriptionsQuery({
    group: "aktiv", sort: "next_billing", search: "  a,b(c)*d  ", page: "3", pageSize: 9999, evil: 1,
  });
  assert.equal(q.group, "aktiv");
  assert.equal(q.sort, "next_billing");
  assert.equal(q.search, "abcd");
  assert.equal(q.page, 3);
  assert.equal(q.pageSize, 100, "the page size cap is gone");
  assert.ok(!("evil" in q), "an unknown filter survived");
  // Unknown values degrade to the safe default rather than filtering or
  // ordering on junk.
  assert.equal(resolveSubscriptionsQuery({ group: "trialing" }).group, "alle");
  assert.equal(resolveSubscriptionsQuery({ sort: "price" }).sort, "created");
  assert.equal(resolveSubscriptionsQuery(null).page, 1);
  assert.equal(resolveSubscriptionsQuery(null).group, "alle");
  assert.equal(resolveSubscriptionsQuery(null).sort, "created");
  assert.deepEqual(subscriptionsPageRange({ page: 2, pageSize: 25 }), { from: 25, to: 49 });
  // The duplicated normaliser agrees with the order list's, character
  // for character, on every input that matters.
  for (const input of ["a,b", "x(y)", "%_*", 'q"', "z'", "\\", "  padded  ", "x".repeat(300), 7, null]) {
    assert.equal(normalizeSubscriptionSearch(input), normalizeOrderSearch(input), String(input));
  }
});

/* ══════════════════════════════════════════════════════════════
   8. NOTHING ELSE MOVED
   ══════════════════════════════════════════════════════════════ */

test("8: no backend, migration, cadence, price or shipping rule changed", () => {
  // The cadence and its Stripe expression.
  const recurring = read("lib/stripeRecurringPrice.ts");
  assert.match(recurring, /export const SUBSCRIPTION_INTERVAL: Stripe\.PriceCreateParams\.Recurring\.Interval = "week";/);
  assert.match(recurring, /export const SUBSCRIPTION_INTERVAL_COUNT = 4;/);
  // The shipping rules.
  const shipping = read("lib/shipping.ts");
  assert.match(shipping, /germany: \{ shippingGrossCents: 590, freeShippingThresholdGrossCents: 4900 \}/);
  assert.ok(!withoutComments(shipping).toLowerCase().includes("subscription"),
    "lib/shipping.ts was taught about subscriptions");
  // NO MIGRATION WAS ADDED OR EDITED. This package is UI and one read
  // route; the schema it reads was complete before it started.
  const migrations = readdirSync(path.join(ROOT, "supabase/migrations")).sort();
  // PACKAGE 4A ADDED MIGRATION 059: the B2B self-service supply
  // commerce foundation. It evolves the two b2b_supply_* tables 006
  // built, adds no table of its own, and touches no subscription,
  // annual or order object. Reviewed in
  // tests/b2b-supply-commerce-foundation.test.mjs.
  assert.equal(migrations.at(-1), "061_b2b_pending_agreement_writer.sql",
    "a migration was added by a UI package");
  assert.match(read("supabase/migrations/024_seed_b2c_subscription_plans.sql"),
    /'week',\s*4,\s*'week',\s*4,\s*true,/, "the seeded cadence changed");
  // The one-time checkout is untouched.
  assert.match(read("app/api/checkout/session/route.ts"), /mode: "payment"/);
  // And no B2B surface was involved.
  for (const source of [startCode, shopSubscriptionCode, adminUi, adminRoute]) {
    for (const banned of ["b2b", "B2B", "supply_agreement", "wholesale"]) {
      assert.ok(!source.includes(banned), `a B2B concept appeared: ${banned}`);
    }
  }
});

test("8b: the stale invoice.paid blocker comment is corrected, not the gate", () => {
  // The flag still exists, still opens on the exact string, and is still
  // checked first. Only the REASON recorded next to it changed.
  const rules = read("lib/subscriptionCheckoutRules.ts");
  assert.match(rules, /return env\[SUBSCRIPTION_FEATURE_FLAG\] === "true";/);
  assert.match(read("lib/subscriptionCheckout.ts"), /if \(!deps\.isEnabled\(\)\) \{\n\s{4}return fail\(503, UNAVAILABLE\);/);
  // The claim that nothing handles invoice.paid is gone from both files.
  for (const source of [rules, checkoutRoute]) {
    assert.ok(!/Task 29D-E (has not been built|is not built yet)/.test(source),
      "a stale blocker comment survived");
  }
  // Because it is handled, and that is asserted rather than assumed.
  assert.match(read("app/api/stripe/webhook/route.ts"), /event\.type === "invoice\.paid"/);
});
