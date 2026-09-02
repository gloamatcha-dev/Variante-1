import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ANNUAL_DELIVERY_COUNT,
  ANNUAL_DELIVERY_INTERVAL_DAYS,
  buildAnnualPricing,
} from "../lib/annualPlanRules.ts";
import { ANNUAL_LAUNCH_SIZE_BY_SKU } from "../lib/annualPlans.ts";

/**
 * /shop — THE ANNUAL PLAN IN THE SHOP.
 *
 * The prepaid annual plan was complete on the server and invisible on the
 * page. This guards the shop side of it, and the three things that make
 * it safe to show:
 *
 *   1. NOT A SUBSCRIPTION. Thirteen deliveries, 28 days apart, one
 *      payment, no renewal - and never the word "monatlich".
 *   2. NOT A SECOND SOURCE OF TRUTH. Every euro the shop prints is
 *      derived from lib/annualPlanRules.ts, the same leaf the checkout
 *      route runs. No annual total is written down in the UI.
 *   3. NOT A PURCHASE. The shop never posts to the annual checkout and
 *      never puts a plan in the cart.
 *
 * The commercial arithmetic itself is already covered by
 * tests/annual-plan-rules.test.mjs and the mode:"payment" contract by
 * tests/annual-plan-checkout.test.mjs. Neither is restated here; both are
 * asserted to still exist.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf8");

const site = read("app/GloaSite.tsx");
const css = read("app/globals.css");

/** The shop's annual code, from the eligibility helper to the blue band. */
const shopFrom = site.indexOf("/* ══ THE ANNUAL PLAN, IN THE SHOP ══");
assert.notEqual(shopFrom, -1, "the annual shop block was not found");
const shopTo = site.indexOf("const SHOP_HERO_LEAD");
const shopCode = site.slice(shopFrom, shopTo);
assert.ok(shopCode.length > 2000, "the annual shop block is suspiciously short");

/**
 * Comments stripped. The block explains at length why it never says
 * "monatlich" and never stores 17,99 - so a scan for those strings has
 * to read the CODE, or the prose defending the rule trips the rule.
 */
const stripJs = src => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
const shopRendered = stripJs(shopCode);

/**
 * ONLY the annual components - the eligibility helper, the mode
 * selector, the plan panel and the blue band. Deliberately excludes
 * ShopProductBlock, which legitimately owns the one-time cart call.
 */
const annualOnly = stripJs(
  site.slice(shopFrom, site.indexOf("/** One product's purchase block")) +
  site.slice(site.indexOf("function ShopAnnualPlan"), shopTo)
);
assert.ok(annualOnly.length > 1500, "the annual components were not found");

const blockAt = css.indexOf("/shop — THE ANNUAL PLAN");
assert.notEqual(blockAt, -1, "the annual CSS block was not found");
const startAt = css.lastIndexOf("/*", blockAt);
const nextAt = css.indexOf("/* ══════", blockAt + 10);
const cssCode = css.slice(startAt, nextAt === -1 ? css.length : nextAt).replace(/\/\*[\s\S]*?\*\//g, "");

/** German money, the way fmtCents renders it. */
const eur = cents => (cents / 100).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/* ══════════════════════════════════════════════════════════════
   1. THE CONTRACT — WHAT THE CUSTOMER IS TOLD
   ══════════════════════════════════════════════════════════════ */

test("1: thirteen deliveries, 28 days, one payment, no renewal", () => {
  // The four mandatory concepts, in the customer's own reading order.
  for (const phrase of [
    "Lieferungen",
    "einmal bezahlen",
    "keine automatische Verlängerung",
    "Du zahlst den Jahresgesamtbetrag einmalig.",
    "Keine automatische Verlängerung, keine weitere Abbuchung.",
    "Jahresgesamtbetrag",
  ]) {
    assert.ok(shopCode.includes(phrase), `missing customer copy: ${phrase}`);
  }
  // The counts are READ from the rules, never typed into the page: the
  // page cannot say twelve while the server schedules thirteen.
  assert.ok(shopCode.includes("{ANNUAL_DELIVERY_COUNT}"), "the delivery count is hardcoded in the UI");
  assert.ok(shopCode.includes("{ANNUAL_DELIVERY_INTERVAL_DAYS}"), "the cadence is hardcoded in the UI");
  assert.equal(ANNUAL_DELIVERY_COUNT, 13);
  assert.equal(ANNUAL_DELIVERY_INTERVAL_DAYS, 28);
  // The band states all four as facts, not as a tooltip.
  assert.ok(shopCode.includes("LIEFERUNGEN`"), "the band lost its delivery-count fact");
  assert.ok(shopCode.includes("TAGE`"), "the band lost its cadence fact");
  assert.ok(shopCode.includes('"EINMAL ZAHLEN"'), "the band lost its one-payment fact");
  assert.ok(shopCode.includes('"KEINE AUTOMATISCHE VERLÄNGERUNG"'), "the band lost its no-renewal fact");
});

test("1b: it is never described as monthly, and never as a subscription", () => {
  // The cadence is 28 days. Thirteen 28-day steps are 364 days; twelve
  // calendar months are 365 or 366, so "monatlich" would misstate the
  // rhythm, the count AND the number of payments.
  for (const banned of [/monatlich/i, /monthly/i, /pro Monat/i, /jederzeit kündbar/i,
                        /automatisch verlängert/i, /Abo\b/, /Abonnement/i]) {
    assert.ok(!banned.test(shopRendered), `misleading wording in the shop: ${banned}`);
  }
  for (const banned of [/monatlich/i, /monthly/i, /subscription/i]) {
    assert.ok(!banned.test(cssCode), `misleading wording in the styles: ${banned}`);
  }
  // No savings percentage was invented. The rules expose a discount, but
  // no approved "X % sparen" claim exists, so the shop makes none.
  assert.ok(!/%\s*(sparen|günstiger|Rabatt)/i.test(shopRendered), "an unapproved savings claim appeared");
});

/* ══════════════════════════════════════════════════════════════
   2. ONE SOURCE OF COMMERCIAL TRUTH
   ══════════════════════════════════════════════════════════════ */

test("2: every euro is derived from the rules, never written down", () => {
  assert.ok(shopCode.includes("buildAnnualPricing({ size, catalogUnitGrossCents: variant.price_gross_cents })"),
    "the shop stopped deriving its annual pricing");
  assert.ok(site.includes('from "../lib/annualPlanRules"'), "the shop stopped importing the rules");
  assert.ok(site.includes('from "../lib/annualPlans"'), "the shop stopped importing the allowlist");
  // Not one annual figure - per delivery, merchandise, shipping or total
  // - appears anywhere in the shop code or its styles.
  for (const size of ["30g", "50g", "100g"]) {
    const p = buildAnnualPricing({ size, catalogUnitGrossCents: { "30g": 1999, "50g": 2999, "100g": 5499 }[size] });
    assert.ok(p.ok);
    for (const cents of [p.pricing.annualUnitGrossCents, p.pricing.merchandiseTotalGrossCents,
                         p.pricing.shippingTotalGrossCents, p.pricing.totalGrossCents]) {
      // Free shipping is 0, which is not a figure anybody can "hardcode"
      // distinguishably - the 50 g and 100 g benefit is asserted in 2b
      // and rendered as the word "inklusive".
      if (cents === 0) continue;
      assert.ok(!shopRendered.includes(String(cents)), `${cents} is hardcoded in the shop`);
      assert.ok(!shopRendered.includes(eur(cents)), `${eur(cents)} is hardcoded in the shop`);
    }
  }
  // The shipping figure is read off the pricing object, not restated.
  assert.ok(shopRendered.includes("annual.shippingPerDeliveryGrossCents"), "shipping is not read from the rules");
  assert.ok(!/\b590\b/.test(shopRendered), "the 30 g shipping amount is hardcoded in the shop");
});

test("2b: the three launch sizes, and their commercial truth", () => {
  // The numbers the shop RENDERS, proven from the same function the page
  // calls. The catalog prices are the launch catalog's own.
  const expected = {
    "30g": { catalog: 1999, unit: 1799, shipping: 590, merch: 23387, shipTotal: 7670, total: 31057 },
    "50g": { catalog: 2999, unit: 2699, shipping: 0, merch: 35087, shipTotal: 0, total: 35087 },
    "100g": { catalog: 5499, unit: 4949, shipping: 0, merch: 64337, shipTotal: 0, total: 64337 },
  };
  for (const [size, e] of Object.entries(expected)) {
    const r = buildAnnualPricing({ size, catalogUnitGrossCents: e.catalog });
    assert.ok(r.ok, `${size} did not price`);
    const p = r.pricing;
    assert.equal(p.annualUnitGrossCents, e.unit, `${size} per-delivery value`);
    assert.equal(p.shippingPerDeliveryGrossCents, e.shipping, `${size} shipping per delivery`);
    assert.equal(p.deliveryCount, 13, `${size} delivery count`);
    assert.equal(p.merchandiseTotalGrossCents, e.merch, `${size} merchandise total`);
    assert.equal(p.shippingTotalGrossCents, e.shipTotal, `${size} shipping total`);
    assert.equal(p.totalGrossCents, e.total, `${size} annual total`);
    // And the arithmetic really is total = 13 x (unit + shipping).
    assert.equal(p.totalGrossCents, (p.annualUnitGrossCents + p.shippingPerDeliveryGrossCents) * 13);
  }
  // German money, as the customer reads it.
  assert.equal(eur(31057), "310,57");
  assert.equal(eur(35087), "350,87");
  assert.equal(eur(64337), "643,37");
  // The canonical suite that owns these figures is still there.
  const rules = read("tests/annual-plan-rules.test.mjs");
  for (const cents of [31057, 35087, 64337, 23387, 7670]) {
    assert.ok(rules.includes(String(cents)), `the rules suite stopped asserting ${cents}`);
  }
});

test("2c: annual shipping is the plan's own rule, not the shop threshold", () => {
  // 30 g pays 5,90 per delivery thirteen times; 50 g and 100 g are free
  // as an annual BENEFIT, not because a 49,00 threshold happened to be
  // crossed. The shop reads the plan's answer and never the shop's.
  assert.ok(!shopRendered.includes("computeShippingGrossCents"), "the shop applied the normal shipping rule to a plan");
  assert.ok(!shopRendered.includes("4900"), "the free-shipping threshold leaked into the annual panel");
  const thirty = buildAnnualPricing({ size: "30g", catalogUnitGrossCents: 1999 });
  assert.equal(thirty.pricing.shippingTotalGrossCents, 590 * 13);
  // Germany only, and the shop says so in the panel.
  assert.ok(shopCode.includes("nur innerhalb Deutschlands"), "the Germany-only note went away");
  assert.match(read("lib/annualPlanCheckoutRules.ts"), /snapshot\.country !== ANNUAL_ALLOWED_COUNTRY/,
    "the Germany-only server gate changed");
});

/* ══════════════════════════════════════════════════════════════
   3. ELIGIBILITY
   ══════════════════════════════════════════════════════════════ */

test("3: only the three annual launch SKUs get the option", () => {
  // The SHOP reads the same frozen allowlist the server validates
  // against, so a fourth SKU fails closed in both places by omission.
  assert.ok(shopCode.includes("ANNUAL_LAUNCH_SIZE_BY_SKU[variant.sku]"),
    "the shop stopped reading the server's allowlist");
  assert.deepEqual(Object.keys(ANNUAL_LAUNCH_SIZE_BY_SKU).sort(),
    ["GLOA-MATCHA-100G", "GLOA-MATCHA-30G", "GLOA-MATCHA-50G"]);
  // An accessory, the metal case or an unpriced weight gets nothing.
  for (const sku of ["GLOA-METAL-CASE", "GLOA-MATCHA-500G", "", "GLOA-GIFT-CARD"]) {
    assert.equal(ANNUAL_LAUNCH_SIZE_BY_SKU[sku], undefined, `${sku} became annual-eligible`);
  }
  // The band only renders when the page actually lists an annual product.
  assert.ok(site.includes("const hasAnnual=shown.some(p=>p.variants.some(v=>annualPricingFor(v)!==null));"),
    "the blue band lost its eligibility guard");
  assert.ok(site.includes("{hasAnnual&&<ShopAnnualPlan"), "the band is rendered unconditionally");
});

/* ══════════════════════════════════════════════════════════════
   4. THE PURCHASE MODE
   ══════════════════════════════════════════════════════════════ */

test("4: one-time is the default and both modes exist", () => {
  assert.ok(shopCode.includes('type PurchaseMode = "one_time" | "annual"'), "the mode union changed");
  assert.ok(site.includes('const [mode,setMode]=useState<PurchaseMode>("one_time");'),
    "the shop no longer defaults to one-time");
  assert.ok(shopCode.includes(">Einmalig kaufen<"), "the one-time option label changed");
  assert.ok(shopCode.includes(">Jahresplan<"), "the annual option label changed");
  // The selector only appears where an annual plan actually exists.
  assert.ok(site.includes("{annual&&<PurchaseModeSelector"), "the selector renders without an annual plan");
});

test("4b: it is a real radio group, and selection is not colour alone", () => {
  assert.ok(shopCode.includes('role="radiogroup"'), "the purchase mode is not a radio group");
  assert.ok(shopCode.includes('aria-label="Kaufoption wählen"'), "the radio group lost its name");
  assert.equal((shopCode.match(/type="radio"/g) || []).length, 2, "there are not exactly two radios");
  assert.ok(shopCode.includes('className="sr-only"'), "the radios are not real inputs");
  // The active state is a border AND a ground, and the native radio
  // underneath carries it a third time.
  assert.match(cssCode, /\.purchase-mode-option\.active\{[^}]*border-color:var\(--berry\)/);
  assert.match(cssCode, /\.purchase-mode-option\.active\{[^}]*background:rgba\(166,30,89,\.06\)/);
  // The same state the size selector already uses - one selection
  // language on the page, not two.
  assert.match(css, /\.size-option\.active\{border-color:var\(--berry\);background:rgba\(166,30,89,\.06\)\}/,
    "the shop's canonical selection state changed");
  assert.match(cssCode, /\.purchase-mode-option:focus-within\{outline:3px solid var\(--blue\)/);
});

test("4c: switching size or mode leaves nothing stale", () => {
  // The annual figures are DERIVED every render from the selected
  // variant, so there is no annual state to go stale.
  assert.ok(site.includes("const annual=annualPricingFor(v);"), "the annual pricing became state");
  assert.ok(site.includes('const annualActive=mode==="annual"&&annual!==null;'),
    "an annual panel can render for a product with no annual plan");
  // One-time restores the ordinary display - price, Grundpreis and all.
  assert.ok(site.includes("{annualActive&&annual\n?<AnnualPlanPanel"), "the mode no longer switches the panel");
  assert.ok(site.includes('<p className="shop-product-price">{fmtCents(v.price_gross_cents)} €</p>'),
    "the ordinary one-time price display changed");
  // No effect-driven state, so no cascading render on mode change.
  assert.ok(!/useEffect\(\(\)=>\{if\(mode/.test(site), "the mode is synchronised in an effect");
});

/* ══════════════════════════════════════════════════════════════
   5. THE SHOP NEVER BUYS
   ══════════════════════════════════════════════════════════════ */

test("5: the annual CTA never adds to the cart and never posts a checkout", () => {
  // An annual plan is a dedicated account-bound checkout, not a cart
  // line. The one-time handler is unreachable from annual mode.
  assert.ok(site.includes('onClick={annualActive?()=>{track("shop_annual_interest");window.location.href="/contact"}:SHOP_STATUS==="prelaunch"?()=>window.location.href="/contact":handleAdd}'),
    "the annual CTA changed its action");
  assert.ok(!annualOnly.includes("addItem"), "an annual component reaches the cart");
  assert.ok(!site.includes('purchaseType:"annual"'), "an annual plan was given a cart purchase type");
  // And nothing in the shop calls the annual checkout endpoint.
  assert.ok(!site.includes("/api/annual-plan"), "the shop posts to the annual checkout");
  assert.ok(!site.includes("annualCheckout"), "the shop wires an annual checkout call");
  // No fake success anywhere.
  assert.ok(!/setTimeout[^)]*aktiviert|Jahresplan aktiviert|Plan aktiv/i.test(site),
    "the shop fakes an activated plan");
});

test("5b: the band's CTA selects, it does not buy", () => {
  assert.ok(shopCode.includes(">JAHRESPLAN AUSWÄHLEN<"), "the band CTA label changed");
  assert.ok(shopCode.includes('<button type="button" className="cta shop-annual-cta"'),
    "the band CTA is not a plain button");
  assert.ok(site.includes("setAnnualRequest(n=>n+1)"), "the band CTA no longer selects annual mode");
  assert.ok(site.includes('document.getElementById("product")?.scrollIntoView'),
    "the band CTA no longer moves to the purchase area");
  // A COUNTER, so pressing it twice works.
  assert.ok(site.includes("const [annualRequest,setAnnualRequest]=useState(0);"), "the request became a boolean");
  assert.ok(site.includes("if(annualRequest!==seenRequest){"), "the request is no longer edge-triggered");
});

test("5c: the server keeps every commercial decision", () => {
  // The endpoint accepts THREE fields and none of them is money.
  const rules = read("lib/annualPlanCheckoutRules.ts");
  assert.match(rules, /const \{ variantId, addressId, requestId \} = body as Record<string, unknown>;/,
    "the annual checkout request shape changed");
  assert.match(rules, /rejected unexpected fields/, "the strict field allowlist went away");
  // One payment, never a Stripe Subscription.
  const flow = read("lib/annualPlanCheckout.ts");
  assert.match(flow, /mode: "payment"/, "the annual checkout stopped being a one-time payment");
  assert.ok(!flow.includes('mode: "subscription"'), "the annual checkout became a subscription");
  // Comments stripped: the flow EXPLAINS that it mints no recurring price,
  // and that sentence must not read as one.
  assert.ok(!/recurring/.test(stripJs(flow)), "a recurring price reached the annual checkout");
  // The gate is still server-side and still closed unless exactly "true".
  const plans = read("lib/annualPlans.ts");
  assert.match(plans, /return env\[ANNUAL_PLAN_FEATURE_FLAG\] === "true";/, "the feature gate changed");
  assert.match(plans, /ANNUAL_PLAN_FEATURE_FLAG = "B2C_ANNUAL_PLAN_ENABLED"/, "the flag was renamed");
  // And it was NOT mirrored into the browser.
  assert.ok(!site.includes("B2C_ANNUAL_PLAN_ENABLED"), "the server flag leaked into the client bundle");
  assert.ok(!site.includes("isAnnualPlanCheckoutEnabled"), "the shop calls a server-only gate");
  assert.ok(!read(".env.example").includes("VITE_B2C_ANNUAL"), "a public mirror of the flag appeared");
});

test("5d: no backend, migration or commercial logic changed", () => {
  assert.deepEqual(readdirSync(path.join(ROOT, "app/api")).sort(),
    ["annual-plan", "checkout", "contact", "cron", "internal", "orders",
     "stripe", "subscriptions", "withdrawal"], "an API route changed");
  assert.ok(!readdirSync(path.join(ROOT, "supabase/migrations")).some(f => f.startsWith("043")),
    "migration 043 exists");
  assert.equal(readdirSync(path.join(ROOT, "supabase/migrations")).filter(f => f.endsWith(".sql")).length, 42,
    "the migration count changed");
  // The one-time path is untouched.
  assert.ok(site.includes('purchaseType:"once",unitPriceCents:v.price_gross_cents'),
    "the one-time cart line changed");
  assert.match(read("app/api/checkout/session/route.ts"), /mode: "payment"/, "the one-time checkout changed");
});

/* ══════════════════════════════════════════════════════════════
   6. IT MUST NOT LOOK LIKE A SUBSCRIPTION
   ══════════════════════════════════════════════════════════════ */

test("6: no card, no pill, no badge, and no pure white", () => {
  assert.ok(!/border-radius:(?!0)/.test(cssCode), "a radius was introduced");
  assert.ok(!/box-shadow:(?!none)/.test(cssCode), "a shadow was introduced");
  assert.ok(!/gradient|backdrop-filter/.test(cssCode), "a gradient or blur was introduced");
  assert.ok(!/#fff\b|#ffffff\b/i.test(cssCode), "a white hex appeared");
  assert.ok(!/rgba?\(\s*255\s*,\s*255\s*,\s*255/.test(cssCode), "a white rgb appeared");
  assert.ok(!/(background|color|border[a-z-]*)\s*:\s*white\b/i.test(cssCode), "the white keyword appeared");
  // Every rgba is either the near-black text tone or cream.
  for (const m of cssCode.matchAll(/rgba\((\d+),(\d+),(\d+),/g)) {
    const rgb = `${m[1]},${m[2]},${m[3]}`;
    assert.ok(["17,17,17", "245,235,226", "166,30,89"].includes(rgb), `an unexpected rgba: ${m[0]}`);
  }
  // The palette is the GLOA palette.
  assert.match(css, /--blue:#1746D1/);
  assert.match(css, /--cream:#F5EBE2/);
  assert.match(css, /--berry:#A61E59/);
});

test("6b: the amount actually charged is the loudest number", () => {
  // The year total outranks the per-delivery figure at every width. A
  // panel that shouted 17,99 over a plan charging 310,57 at once would
  // be the single most misleading thing it could do.
  assert.match(cssCode, /\.annual-panel-total b\{[\s\S]*?font-size:clamp\(30px,3vw,40px\)/);
  assert.match(cssCode, /\.annual-panel-total b\{[\s\S]*?font-weight:800/);
  assert.match(cssCode, /\.annual-panel-lines dd\{[\s\S]*?font-size:15px/);
  const at = (lo, vw, hi, w) => Math.max(lo, Math.min(vw / 100 * w, hi));
  for (const w of [375, 390, 430, 768, 1024, 1280, 1440, 1536, 1680]) {
    assert.ok(at(30, 3, 40, w) > 15, `the annual total is not dominant at ${w}px`);
  }
  assert.ok(shopCode.includes('<span className="annual-panel-total-note">einmalig</span>'),
    "the total lost its 'einmalig' qualifier");
});

test("6c: the blue band is an internal section, not a second page hero", () => {
  assert.match(cssCode, /\.shop-annual\{[\s\S]*?background:var\(--blue\)/);
  assert.match(cssCode, /\.shop-annual\{[\s\S]*?color:var\(--cream\)/);
  // Capped at 56, well below the shop hero, and it does not read the
  // shared page-hero tokens.
  assert.match(cssCode, /\.shop-annual-line\{[\s\S]*?font-size:clamp\(34px,3\.6vw,56px\)/);
  assert.ok(!cssCode.includes("--type-hero-primary") && !cssCode.includes("--type-hero-secondary"),
    "the band reads the shared page-hero tokens");
  assert.ok(!shopCode.includes("gloa-hero-"), "the band took the page-hero classes");
  // Inter over real Inter Italic, never Cormorant.
  assert.match(cssCode, /\.shop-annual-line-accent\{[\s\S]*?font-synthesis:none/);
  assert.ok(!cssCode.includes("--font-display"), "Cormorant reached the band");
  // Background full width, content on the shared rail.
  assert.match(cssCode, /\.shop-annual\{[\s\S]*?padding-inline:var\(--rail-gutter\)/);
  assert.ok(shopCode.includes('className="shop-annual-inner home-rail"'), "the band left the rail");
  // The shop hero is untouched.
  assert.match(css, /\.shop-hero\{/, "the shop hero rule vanished");
  assert.ok(!cssCode.includes("shop-hero"), "this block reaches the shop hero");
  assert.ok(!/(^|[\s,])(header|footer|nav|body|html)[\s,{]/m.test(cssCode), "this block reaches the chrome");
});

test("6d: exactly one explanatory band, and it stacks on a phone", () => {
  assert.equal((site.match(/<ShopAnnualPlan/g) || []).length, 1, "the band is rendered more than once");
  assert.equal((site.match(/function ShopAnnualPlan/g) || []).length, 1, "the band is defined more than once");
  const at900 = cssCode.slice(cssCode.indexOf("@media (max-width:900px)"));
  assert.match(at900, /\.shop-annual-inner\{grid-template-columns:1fr/);
  const at560 = cssCode.slice(cssCode.indexOf("@media (max-width:560px)"));
  assert.match(at560, /\.purchase-mode\{grid-template-columns:1fr\}/);
  // The annual total does NOT shrink to meta text on mobile.
  assert.ok(!/annual-panel-total b\{font-size:1\d px\}/.test(at560), "the annual total shrank on mobile");
});
