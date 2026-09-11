import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startRenderServer } from "./helpers/renderServer.mjs";
import {
  suppressesLaunchPopup,
  launchPopupDismissed,
  LAUNCH_POPUP_STORAGE_KEY,
  LAUNCH_POPUP_DISMISS_MS,
  LAUNCH_POPUP_DELAY_MS,
  LAUNCH_POPUP_SCROLL_RATIO,
} from "../lib/launchPopupRules.ts";

/**
 * TWO INDEPENDENT PRELAUNCH BEHAVIOURS.
 *
 *   1. A launch-list popup that POINTS at /launch. It collects nothing.
 *   2. Public product prices withheld while SHOP_STATUS is "prelaunch".
 *
 * They share no state and no flag, and section 3 below asserts exactly
 * that - a popup that could suppress a price, or a price flag that could
 * open a popup, is the coupling this guards against.
 *
 * WHAT SECTION 2 IS REALLY FOR: proving nothing was DELETED. Hiding a
 * price by zeroing it, by dropping it from the catalog or by rewriting a
 * Stripe id would all make the page look right and the shop wrong. The
 * numbers have to still be there, unchanged, and only the rendering may
 * stop.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf8");

const popup = read("app/LaunchPopup.tsx");
const rules = read("lib/launchPopupRules.ts");
const site = read("app/GloaSite.tsx");
const content = read("app/content.ts");
const css = read("app/globals.css");

/** The popup's own appended css block, bounded so anything after it is
    not read as ours. */
const lpAt = css.indexOf("THE LAUNCH-LIST POPUP");
assert.notEqual(lpAt, -1, "the popup css block is missing");
const lpStart = css.lastIndexOf("/*", lpAt);
const lpEnd = css.indexOf("/* " + "═".repeat(6), lpAt);
const lpCss = css.slice(lpStart, lpEnd === -1 ? undefined : lpEnd)
  .replace(/\/\*[\s\S]*?\*\//g, "");

// 8937 belongs to account-landing and to the secured-port case in
// internal-order-notification-retry; this suite needs its own.
const PORT = 8951;
let server, home, shop;
test.before(async () => {
  server = await startRenderServer(PORT);
  const h = await server.getHtml("/");
  assert.equal(h.status, 200, "the homepage did not render");
  home = h.html;
  const s = await server.getHtml("/shop");
  assert.equal(s.status, 200, "/shop did not render");
  shop = s.html;
});
test.after(() => server?.stop());

/* ══════════════════════════════════════════════════════════════
   1. THE POPUP
   ══════════════════════════════════════════════════════════════ */

test("1: the component exists, and it POINTS at /launch rather than collecting", () => {
  assert.match(popup, /export function LaunchPopup\(/);
  // One link, to /launch, and it is the CTA.
  assert.match(popup, /<Link className="cta lp-cta" href="\/launch"/);
  assert.match(popup, />ZUR LAUNCH LIST</);
  // NO SECOND SIGNUP PATH. The list lives on /launch and only there.
  for (const banned of ["<form", "<input", 'type="email"', "onSubmit", "fetch(", "/api/launch"]) {
    assert.ok(!popup.includes(banned), `the popup collects or submits: ${banned}`);
  }
  // NO IMAGE, no illustration - one flat panel.
  assert.ok(!/<img|<svg|background-image/.test(popup), "the popup carries an image");
  assert.ok(!lpCss.includes("background-image"), "the popup css carries an image");
});

test("1b: the copy is exactly the approved lines, in the approved faces", () => {
  assert.match(popup, /<p className="eyebrow lp-eyebrow">PRELAUNCH<\/p>/);
  assert.match(popup, /<span className="lp-line lp-line-1">Zum Launch<\/span>/);
  assert.match(popup, /<i className="lp-line lp-line-2">benachrichtigt<\/i>/);
  assert.match(popup, /<span className="lp-line lp-line-3">werden\.<\/span>/);
  assert.ok(popup.includes("Trag dich ein und wir schicken dir eine kurze Nachricht, sobald GLOA online geht."));
  // Sans, display-italic, sans - the site's own three-line prelaunch shape.
  assert.match(lpCss, /\.lp-line-1,\s*\.lp-line-3\{[\s\S]*?font-family:var\(--font-sans\)/);
  assert.match(lpCss, /\.lp-line-2\{[\s\S]*?font-family:var\(--font-display\)/);
  assert.match(lpCss, /\.lp-line-2\{[\s\S]*?font-style:italic/);
});

test("1c: brand blue, and the accent is legible rather than nominally raspberry", () => {
  assert.match(lpCss, /\.lp-panel\{[\s\S]*?background:var\(--blue\)/);
  assert.match(lpCss, /\.lp-panel\{[\s\S]*?color:var\(--cream\)/);
  // Raspberry on blue measures 1.04:1, so the accent word carries its
  // raspberry on a cream ground instead - 6.05:1, and the same marker
  // the homepage lifestyle band uses on this exact blue.
  assert.match(lpCss, /\.lp-line-2\{[\s\S]*?background:var\(--cream\)/);
  assert.match(lpCss, /\.lp-line-2\{[\s\S]*?color:var\(--berry\)/);
  // NO NEW COLOUR. Every value here is a palette token or a tint of one.
  for (const m of lpCss.matchAll(/(?:background|color|outline-color|border-color):\s*([^;}]+)/g)) {
    const v = m[1].trim();
    assert.ok(/^(var\(--(blue|berry|cream|ink)\)|none|transparent|inherit|rgba\((?:245,235,226|17,17,17),[^)]*\))$/.test(v),
      `a colour outside the palette: ${v}`);
  }
  // Square, like everything else on this site.
  assert.match(lpCss, /\.lp-panel\{[\s\S]*?border-radius:0/);
  assert.ok(!/border-radius:(?!0)/.test(lpCss), "the popup rounded a container");
  // Desktop width inside the 480-560 the brief names.
  assert.match(lpCss, /\.lp-panel\{[\s\S]*?max-width:520px/);
});

test("1d: it is a real dialog - labelled, focus-managed, escapable, dismissable", () => {
  assert.match(popup, /role="dialog"/);
  assert.match(popup, /aria-modal="true"/);
  assert.match(popup, /aria-labelledby="lp-title"/);
  assert.match(popup, /aria-describedby="lp-body"/);
  assert.match(popup, /id="lp-title"/);
  assert.match(popup, /id="lp-body"/);
  // The close control, named for a screen reader and a real tap size.
  assert.match(popup, /aria-label="Popup schließen"/);
  assert.match(lpCss, /\.lp-close\{[\s\S]*?width:44px/);
  assert.match(lpCss, /\.lp-close\{[\s\S]*?height:44px/);
  // Focus in on open, back out on close; Escape and the backdrop close it.
  assert.match(popup, /closeRef\.current\?\.focus\(\)/);
  assert.match(popup, /prev\?\.focus\?\.\(\)/);
  assert.match(popup, /e\.key === "Escape"/);
  assert.match(popup, /<div className="lp-backdrop" onClick=\{close\}/);
  // Body scroll is locked while it is open, the way the cart drawer does it.
  assert.match(popup, /document\.body\.style\.overflow = "hidden"/);
  // Motion is dropped entirely under reduced motion, not shortened.
  assert.match(lpCss, /@media \(prefers-reduced-motion:reduce\)\{[\s\S]*?animation:none/);
});

test("1e: the triggers are 8s OR 30% scroll, first one only", () => {
  assert.equal(LAUNCH_POPUP_DELAY_MS, 8000);
  assert.equal(LAUNCH_POPUP_SCROLL_RATIO, 0.3);
  // The component runs these exact values - it imports them, it does not
  // keep a second copy that could drift from what the test checks.
  assert.match(popup, /LAUNCH_POPUP_DELAY_MS as DELAY_MS/);
  assert.match(popup, /LAUNCH_POPUP_SCROLL_RATIO as SCROLL_RATIO/);
  // A single latch, so the two triggers can never both open it.
  assert.match(popup, /if \(done\) return;\s*done = true;/);
  assert.match(popup, /window\.clearTimeout\(timer\);\s*window\.removeEventListener\("scroll", onScroll\);\s*setOpen\(true\);/);
  // It is closed on the first render, so it can never flash on paint.
  assert.match(popup, /useState\(false\)/);
  assert.ok(!popup.includes("setOpen(true)\n"), "it opens outside the trigger");
});

test("1f: dismissal is one local timestamp, good for 7 days, and nothing else", () => {
  assert.equal(LAUNCH_POPUP_STORAGE_KEY, "gloa_launch_popup_dismissed_at");
  assert.equal(LAUNCH_POPUP_DISMISS_MS, 7 * 24 * 60 * 60 * 1000);
  assert.match(popup, /window\.localStorage\.getItem\(STORAGE_KEY\)/);
  assert.match(popup, /window\.localStorage\.setItem\(STORAGE_KEY, String\(now\)\)/);

  // THE RULE ITSELF, run rather than grepped.
  const now = 1_760_000_000_000;
  assert.equal(launchPopupDismissed(null, now), false, "never dismissed reads as dismissed");
  assert.equal(launchPopupDismissed(String(now - 1000), now), true, "a fresh dismissal does not hold");
  assert.equal(launchPopupDismissed(String(now - (LAUNCH_POPUP_DISMISS_MS - 1)), now), true,
    "it reappears inside the seven days");
  assert.equal(launchPopupDismissed(String(now - LAUNCH_POPUP_DISMISS_MS), now), false,
    "it never comes back after seven days");
  // Junk from another tab or an older build must not lock it out forever.
  for (const junk of ["", "abc", "NaN", "undefined"]) {
    assert.equal(launchPopupDismissed(junk, now), false, `junk value locked the popup out: "${junk}"`);
  }
  // NO COOKIE, no server call, no identifier - a number of milliseconds.
  for (const banned of ["document.cookie", "sessionStorage", "fetch(", "navigator.sendBeacon", "crypto.randomUUID"]) {
    assert.ok(!popup.includes(banned), `the popup reaches for ${banned}`);
  }
  // Blocked storage must not take the shell down with it.
  assert.equal((popup.match(/try \{/g) || []).length, 2, "storage access is not guarded");
});

test("1g: it stays away from /launch and from task flows", () => {
  assert.equal(suppressesLaunchPopup("launch"), true, "it would open on /launch");
  for (const route of ["account", "account/dashboard", "account/orders/7",
                       "auth/confirm", "order/success"]) {
    assert.equal(suppressesLaunchPopup(route), true, `it would open on /${route}`);
  }
  // And it DOES belong on the public marketing and shop pages.
  for (const route of ["home", "shop", "shop/gloa-matcha", "our-matcha", "about",
                       "for-cafes", "partnerships", "contact", "rezepte"]) {
    assert.equal(suppressesLaunchPopup(route), false, `it is suppressed on /${route}`);
  }
  // The shell passes the route in, so the decision is made once.
  assert.match(site, /<LaunchPopup route=\{route\}\/>/);
});

test("1h: closed, it renders NOTHING - the page underneath is untouched", async () => {
  // Server-rendered markup contains no popup at all: it opens on a timer
  // or a scroll, both of which are client events.
  for (const [name, html] of [["/", home], ["/shop", shop]]) {
    assert.ok(!html.includes("lp-panel"), `${name} ships an open popup`);
    assert.ok(!html.includes("lp-backdrop"), `${name} ships a popup backdrop`);
    assert.ok(!html.includes("ZUR LAUNCH LIST"), `${name} ships the popup cta`);
  }
  // It is the LAST child of the shell, after the footer and the cart -
  // so mounting it cannot move anything above it.
  assert.match(site, /<Footer\/><CartDrawer open=\{cartOpen\} onClose=\{closeCart\}\/><LaunchPopup route=\{route\}\/><\/>/);
  // The homepage still renders exactly the sections it did.
  assert.deepEqual([...home.matchAll(/<section class="([a-z-]+)"/g)].map(m => m[1]),
    ["hero", "countdown", "prelaunch", "daily", "how-to", "community", "brand-note"]);
});

test("1i: every rule is scoped to the popup, so no finished page moved", () => {
  for (const m of lpCss.matchAll(/([^{}]+)\{[^}]*\}/g)) {
    const sel = m[1].split(/[\r\n]/).pop().trim();
    if (!sel || sel.startsWith("@") || sel.startsWith("from") || sel.startsWith("to")) continue;
    for (const part of sel.split(",")) {
      const s = part.trim();
      if (!s) continue;
      assert.ok(/^\.lp-/.test(s), `a popup rule is not scoped: ${s}`);
    }
  }
  assert.ok(!lpCss.includes("!important"), "specificity was solved with !important");
});

/* ══════════════════════════════════════════════════════════════
   2. PRELAUNCH PRICES - HIDDEN, NEVER DELETED
   ══════════════════════════════════════════════════════════════ */

test("2: the flag is DERIVED from SHOP_STATUS, not a second switch", () => {
  assert.match(content, /export const PRICES_VISIBLE: boolean = SHOP_STATUS !== "prelaunch";/);
  // Flipping SHOP_STATUS is the only edit needed to bring prices back.
  assert.match(content, /export const SHOP_STATUS = "prelaunch" as const;/);
  // No parallel launch flag was invented for this.
  for (const invented of ["PRICES_HIDDEN", "HIDE_PRICES", "SHOW_PRICES", "PRELAUNCH_MODE"]) {
    assert.ok(!content.includes(invented) && !site.includes(invented),
      `a second price flag exists: ${invented}`);
  }
});

test("2b: no rendered page prints a price while prelaunch", () => {
  for (const [name, html] of [["/", home], ["/shop", shop]]) {
    // No euro amount anywhere in the rendered markup, in either notation.
    const money = [...html.matchAll(/\d{1,3},\d{2}\s*€/g)].map(m => m[0]);
    assert.deepEqual(money, [], `${name} prints a price: ${money.join(", ")}`);
    assert.ok(!/€\s*\d/.test(html), `${name} prints a price with a leading euro sign`);
    // No price CONTAINER is rendered either, so there is no empty box
    // left where a price used to be. (.shop-hero-price is deliberately
    // absent from this list: the shop's loading state reuses that class
    // for the word "Laden…", which is not a price - the money regex
    // above is what covers the hero.)
    for (const cls of ["shop-product-price", "shop-product-per100g", "pdp-price",
                       "pdp-per100g", "size-option-price", "purchase-mode-meta",
                       "annual-panel-total"]) {
      assert.ok(!html.includes(cls), `${name} still renders .${cls}`);
    }
    // No sale or compare-at pricing exists on this site at all.
    for (const term of ["Sale Price", "Compare-at", "Streichpreis", "UVP"]) {
      assert.ok(!html.toLowerCase().includes(term.toLowerCase()), `${name} shows ${term}`);
    }
  }
});

test("2c: only the price is gated - the rest of a product block is not", () => {
  // The render harness has no catalog (it runs without a Supabase key),
  // so /shop legitimately renders its loading shell and the product rows
  // cannot be asserted from HTML here. What CAN be asserted, and is the
  // actual risk, is that the gate was put around the price ALONE rather
  // than around the block that contains it.
  const card = site.slice(site.indexOf("function ShopProductBlock("),
                          site.indexOf("function MatchaShopDetails("));
  for (const kept of ['className="shop-product-title"', 'className="eyebrow shop-product-eyebrow"',
                      'className="shop-product-sub"', "<VariantSelector product={product}",
                      "Fragen zum Launch"]) {
    assert.ok(card.includes(kept), `the gate swallowed more than the price: ${kept}`);
  }
  // The size chips keep their labels and lose only the amount.
  assert.match(site, /<span className="size-option-size">\{mv\.label\}<\/span>\{PRICES_VISIBLE&&<span className="size-option-price">/);
  // And the non-money row of the annual panel stays put.
  assert.match(site, /<div><dt>Lieferungen<\/dt><dd>\{annual\.deliveryCount\}<\/dd><\/div>/);
});

test("2d: NOTHING WAS DELETED - the prices are still in the source, unchanged", () => {
  // Every gate is a render condition on a value that is still read.
  const gates = [...site.matchAll(/\{PRICES_VISIBLE&&/g)];
  assert.ok(gates.length >= 8, `only ${gates.length} price gates - a surface was deleted instead`);
  // The values themselves are untouched: still read from the catalog row.
  for (const expr of ["fmtCents(v.price_gross_cents)", "fmtCents(per100)",
                      "fmtCents(annual.totalGrossCents)", "fmtCents(annual.annualUnitGrossCents)",
                      "fmtCents(lowestCents)", "fmtCents(mv.price_gross_cents)",
                      "fmtCents(oncePriceCents)"]) {
    assert.ok(site.includes(expr), `a price expression was deleted: ${expr}`);
  }
  // NOT zeroed, NOT overwritten, NOT faked.
  assert.ok(!/price_gross_cents\s*[:=]\s*0\b/.test(site), "a price was zeroed");
  assert.ok(!/price_gross_cents\s*=\s*/.test(site), "a price was reassigned");
  for (const banned of ["priceOverride", "fakePrice", "hiddenPrice", "0,00 €"]) {
    assert.ok(!site.includes(banned), `a price was faked: ${banned}`);
  }
});

test("2e: the cart, the checkout and the catalog are untouched by this", () => {
  // The cart drawer still adds up real money - hiding a shop price must
  // never change what a customer is told they are paying.
  const cart = site.slice(site.indexOf("function CartDrawer("), site.indexOf("function GloaSiteInner("));
  assert.ok(!cart.includes("PRICES_VISIBLE"), "the cart was gated by the price flag");
  assert.match(cart, /fmtCents\(cart\.totalCents\)/);
  assert.match(cart, /fmtCents\(item\.unitPriceCents\*item\.quantity\)/);
  // The cart still stores the real unit price when something is added.
  assert.match(site, /unitPriceCents:v\.price_gross_cents/);
  // And nothing server-side learned about this flag.
  for (const rel of ["app/checkoutQuote.ts", "app/createCheckoutSession.ts",
                     "lib/checkoutQuote.ts", "lib/annualPlanRules.ts", "app/cart.ts"]) {
    assert.ok(!read(rel).includes("PRICES_VISIBLE"), `${rel} gates on the display flag`);
  }
});

test("2f: no active Offer is published in markup while the shop cannot sell", () => {
  // The only JSON-LD the site emits is an Organization block. There is no
  // Product/Offer anywhere, so the markup cannot advertise a purchasable
  // price the page itself refuses to show.
  const layout = read("app/layout.tsx");
  assert.match(layout, /"@type": "Organization"/);
  assert.ok(!layout.includes('"Product"'), "a Product schema appeared");
  assert.ok(!layout.includes('"Offer"'), "an Offer schema appeared");
  for (const [name, html] of [["/", home], ["/shop", shop]]) {
    assert.ok(!html.includes('"@type":"Offer"'), `${name} publishes an Offer`);
    assert.ok(!html.includes('"@type":"Product"'), `${name} publishes a Product`);
    assert.ok(!/property="product:price/.test(html), `${name} publishes an OG price`);
    assert.ok(!/itemprop="price"/.test(html), `${name} publishes a microdata price`);
  }
});

/* ══════════════════════════════════════════════════════════════
   3. THE TWO FEATURES ARE INDEPENDENT
   ══════════════════════════════════════════════════════════════ */

test("2g: the rules module is a pure leaf - no imports, no clock, no DOM", () => {
  // Comments stripped: the header explains what the module deliberately
  // does NOT touch, and naming those things is not using them.
  const code = rules.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\r\n]*/g, "");
  assert.ok(!/^\s*import /m.test(code), "the rules module grew an import");
  for (const banned of ["Date.now", "window.", "document.", "localStorage", "process.env"]) {
    assert.ok(!code.includes(banned), `the rules module reaches for ${banned}`);
  }
});

test("3: the popup knows nothing about prices, and prices nothing about the popup", () => {
  assert.ok(!popup.includes("PRICES_VISIBLE"), "the popup reads the price flag");
  assert.ok(!popup.includes("SHOP_STATUS"), "the popup reads the shop status");
  assert.ok(!content.includes("POPUP"), "the price flag knows about the popup");
  assert.ok(!content.includes("gloa_launch_popup"), "the price flag knows about the dismissal");
  // No shared machine was built for two unrelated behaviours.
  assert.ok(!site.includes("launchState") && !site.includes("prelaunchState"),
    "a shared state machine was introduced");
});
