import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getActiveVariantBySku } from "./helpers/catalog.mjs";
import { startRenderServer } from "./helpers/renderServer.mjs";

/**
 * THE PUBLIC LIVE EXPERIENCE.
 *
 * One suite that answers "what does a customer actually get now that
 * SHOP_STATUS is live", against the built server rather than against a
 * source grep - because every claim here is about delivered markup.
 *
 * ── WHY A SUITE OF ITS OWN ────────────────────────────────────
 *
 * The launch flipped about twenty existing expectations from "withheld"
 * to "published", each inside the suite that owned that surface. What
 * none of them states is the WHOLE live picture in one place: no
 * countdown, no coming-soon copy, no launch sign-up, prices on the shop,
 * purchase controls rendered, and commerce gated by SHOP_STATUS rather
 * than by a date. That is what this file is for.
 *
 * ── AND WHY IT MAKES NO STRIPE CALL ───────────────────────────
 *
 * It reads pages. It never posts a checkout, so there is nothing here
 * that could reach a payment provider. The checkout contract lives in
 * tests/shop-launch-gate.test.mjs, which proves the gate is open without
 * contacting Stripe either.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf8");
const content = read("app/content.ts");
const site = read("app/GloaSite.tsx");

/** An amount in euros, in any spelling a page could produce. */
const MONEY = /\d{1,3}[.,]\d{2}\s*(?:&#x20AC;|€|EUR|Euro)/g;

/** Its own port, so this suite never races another spawned server. */
const PORT = 8979;

let server;
let home;
let shop;

test.before(async () => {
  server = await startRenderServer(PORT);
  home = (await server.getHtml("/")).html;
  shop = (await server.getHtml("/shop")).html;
});

test.after(() => { server?.stop(); });

/* ══════════════════════════════════════════════════════════════
   1. THE CANONICAL AUTHORITY
   ══════════════════════════════════════════════════════════════ */

test("1: SHOP_STATUS is the release authority, and it says live", () => {
  assert.match(content, /export const SHOP_STATUS = "live" as const;/);
  // Both derived flags come from it and from nothing else.
  assert.match(content, /const SHOP_STATUS_VALUE: string = SHOP_STATUS;/);
  assert.match(content, /export const PRICES_VISIBLE: boolean = SHOP_STATUS_VALUE !== "prelaunch";/);
  assert.match(content, /export const SHOP_IS_PRELAUNCH: boolean = SHOP_STATUS_VALUE === "prelaunch";/);
  // No second switch, and no environment variable pretending to be one.
  assert.ok(!/process\.env\[?["']?SHOP_STATUS/.test(content),
    "SHOP_STATUS reads an environment variable");
});

/* ══════════════════════════════════════════════════════════════
   2. THE HOMEPAGE HAS STOPPED SAYING IT IS COMING
   ══════════════════════════════════════════════════════════════ */

test("2: no countdown, no coming-soon copy, no launch sign-up, no popup", () => {
  // THE COPY. "GLOA is coming" is the sentence a live shop must never
  // print, and the countdown digits go with it.
  assert.ok(!/GLOA is coming/i.test(home), "the live homepage says GLOA is coming");
  assert.ok(!home.includes("countdown-units"), "the live homepage ships countdown digits");
  assert.ok(!home.includes('class="countdown"'), "the live homepage ships the countdown band");

  // THE LAUNCH SIGN-UP SECTION and everything it carried.
  assert.ok(!home.includes('class="prelaunch"'), "the live homepage ships the prelaunch section");
  assert.ok(!/Zum Launch benachrichtigt/i.test(home), "the live homepage still offers launch notice");
  assert.ok(!home.includes('href="/launch"'), "the live homepage still links the launch sign-up");

  // THE POPUP, in any of the shapes it renders as.
  for (const marker of ["lp-panel", "lp-backdrop", "ZUR LAUNCH LIST"]) {
    assert.ok(!home.includes(marker), `the live homepage ships the launch popup (${marker})`);
  }
});

test("2b: the sections the live homepage DOES render", () => {
  assert.deepEqual([...home.matchAll(/<section class="([a-z-]+)"/g)].map(m => m[1]),
    ["hero", "daily", "glance", "community", "brand-note"]);
});

test("2c: and the shop page carries no launch band either", () => {
  assert.ok(!/GLOA is coming/i.test(shop), "the live /shop says GLOA is coming");
  assert.ok(!shop.includes("shop-strip-units"), "the live /shop ships countdown digits");
});

test("2d: NOTHING WAS DELETED - all four are gated, not removed", () => {
  // The whole point of a gate: setting SHOP_STATUS back to "prelaunch"
  // in source brings every one of them back, with no code to restore.
  assert.match(site, /function LaunchCountdown\(\)/);
  assert.match(site, /function ShopLaunchStrip\(\)/);
  assert.match(site, /import \{ LaunchPopup \} from "\.\/LaunchPopup";/);
  assert.match(site, /\{SHOP_IS_PRELAUNCH&&<><LaunchCountdown\/><section className="prelaunch">/);
  assert.match(site, /\{SHOP_IS_PRELAUNCH&&<ShopLaunchStrip\/>\}/);
  assert.match(site, /\{SHOP_IS_PRELAUNCH&&<LaunchPopup /);
  // The sign-up page itself is untouched and still reachable.
  assert.match(read("lib/publicRoutes.ts"), /"launch"/);
});

/* ══════════════════════════════════════════════════════════════
   3. THE SHOP SELLS
   ══════════════════════════════════════════════════════════════ */

test("3: /shop publishes prices for all three sizes", async () => {
  const [thirty, fifty, hundred] = await Promise.all([
    getActiveVariantBySku("GLOA-MATCHA-30G"),
    getActiveVariantBySku("GLOA-MATCHA-50G"),
    getActiveVariantBySku("GLOA-MATCHA-100G"),
  ]);
  // Every size is offered by label.
  for (const label of ["30 g", "50 g", "100 g"]) {
    assert.ok(shop.includes(label), `/shop does not offer ${label}`);
  }
  // And an amount is published.
  const money = shop.match(MONEY) ?? [];
  assert.ok(money.length > 0, "a live /shop publishes no amount at all");

  // The cheapest active variant is the one the description quotes, so the
  // page and its metadata cannot disagree.
  const lowest = Math.min(...[thirty, fifty, hundred].map(v => v.price_gross_cents));
  const description = shop.match(/<meta name="description" content="([^"]*)"/);
  assert.ok(description, "/shop renders no meta description");
  const quoted = description[1].match(/(\d{1,3},\d{2})\s*Euro/);
  assert.ok(quoted, `the description quotes no price: ${description[1]}`);
  assert.equal(Number(quoted[1].replace(",", "")), lowest,
    "the description's price is not the cheapest active variant");
});

test("3b: purchase controls are rendered, and route to the cart", () => {
  // The live label, and the prelaunch one nowhere near it.
  assert.ok(!/Fragen zum Launch/i.test(shop),
    "a live /shop still offers the prelaunch enquiry");
  // The CTA source: prelaunch first, then the two account modes, then
  // the cart. Unchanged precedence, live predicate.
  assert.match(site,
    /onClick=\{SHOP_IS_PRELAUNCH\?\(\)=>window\.location\.href="\/contact":/);
  assert.match(site, /:"In den Warenkorb"\}<\/button>/);
});

test("3c: the cart is a real checkout again", () => {
  // The three cart sections that only exist for a shop that can charge.
  assert.match(site, /\{!SHOP_IS_PRELAUNCH&&<div className="cart-email">/);
  assert.match(site, /\{!SHOP_IS_PRELAUNCH&&<div className="cart-discount">/);
  assert.match(site, /!SHOP_IS_PRELAUNCH&&<p className="cart-legal-note"/);
  // And the button says what it does.
  // The prelaunch wording is still in the source, and must be: it is the
  // gated branch of the same ternary, which is what lets the shop be set
  // back to prelaunch without restoring any copy.
  assert.match(site, /checkoutBusy\?"WIRD GELADEN…":SHOP_IS_PRELAUNCH\?"FRAGEN ZUM LAUNCH":"ZUR KASSE"/);
});

/* ══════════════════════════════════════════════════════════════
   4. COMMERCE IS GATED BY STATUS, NEVER BY A DATE
   ══════════════════════════════════════════════════════════════ */

test("4: the launch instant neither opens nor closes the till", () => {
  // GLOA_LAUNCH_ISO is planned-timing data. It is still here, and it
  // still governs nothing commercial.
  assert.match(read("lib/launchCountdown.ts"), /export const GLOA_LAUNCH_ISO = "2026-10-01T12:00:00\+02:00";/);
  const route = read("app/api/checkout/session/route.ts");
  // Date.now() is NOT banned here: the route legitimately timestamps and
  // rate-limits. What may never appear is the launch-date machinery,
  // because that is the only clock that could re-close the till.
  for (const dateThing of ["launchCountdown", "GLOA_LAUNCH", "launchStatus"]) {
    assert.ok(!route.includes(dateThing),
      `the checkout route reads ${dateThing} - a date must not gate commerce`);
  }
  assert.match(route, /checkoutRefusalFor\(SHOP_STATUS\)/);
});

/* ══════════════════════════════════════════════════════════════
   5. EVERY OTHER FEATURE FLAG IS STILL ITS OWN DECISION
   ══════════════════════════════════════════════════════════════ */

test("5: releasing the B2C shop released nothing else", () => {
  // Each of these reads its OWN environment variable, exactly as before.
  // SHOP_STATUS = live says the general B2C shop is open; it says
  // nothing about a subscription, an annual plan or B2B self-service.
  assert.match(read("lib/subscriptionCheckoutRules.ts"),
    /export const SUBSCRIPTION_FEATURE_FLAG = "B2C_SUBSCRIPTIONS_ENABLED";/);
  assert.match(read("lib/annualPlans.ts"),
    /export const ANNUAL_PLAN_FEATURE_FLAG = "B2C_ANNUAL_PLAN_ENABLED";/);
  assert.match(read("lib/b2bFeatureFlag.ts"),
    /process\.env\[B2B_SELF_SERVICE_FLAG\] === "true"/);

  // And none of them is derived from SHOP_STATUS or from PRICES_VISIBLE.
  for (const rel of ["lib/subscriptionCheckoutRules.ts", "lib/annualPlans.ts",
                     "lib/b2bFeatureFlag.ts"]) {
    const code = read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const leak of ["SHOP_STATUS", "PRICES_VISIBLE", "SHOP_IS_PRELAUNCH"]) {
      assert.ok(!code.includes(leak),
        `${rel} now derives its flag from ${leak}`);
    }
  }
});

test("5b: the annual CTA still defers to the account, not to the cart", () => {
  // Whatever the annual flag says, the shop hands the customer to their
  // account for it and never adds an annual plan to the cart.
  assert.ok(site.includes('annualActive?()=>{track("shop_annual_start");window.location.href=annualPortalHref(v.sku)}'),
    "the annual CTA changed its action");
  assert.ok(!site.includes('purchaseType:"annual"'),
    "an annual plan was given a cart purchase type");
});
