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
  LAUNCH_POPUP_SETTLE_MS,
  overlayBlocksLaunchPopup,
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
  // The trigger marks the panel OWED. Whether it may be SHOWN is a
  // separate decision - see the overlay coordination tests below - so a
  // timer coming due behind an open menu is deferred rather than landing
  // on top of it.
  assert.match(popup, /window\.clearTimeout\(timer\);\s*window\.removeEventListener\("scroll", onScroll\);[\s\S]{0,120}?setDue\(true\);/);
  // It is closed on the first render, so it can never flash on paint.
  assert.match(popup, /useState\(false\)/);
  // STILL EXACTLY ONE PLACE THAT OPENS IT, which is what this assertion
  // has always been about - that place is now the coordination effect
  // rather than the trigger itself.
  assert.equal((popup.match(/setOpen\(true\)/g) || []).length, 1, "it opens from more than one place");
  assert.equal((popup.match(/setDue\(true\)/g) || []).length, 1, "it is armed from more than one place");
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
  // The shell passes the route in, so the decision is made once - and
  // the overlay state alongside it, so the panel can never cover a menu
  // or a cart the visitor already opened.
  assert.match(site, /<LaunchPopup route=\{route\} menuOpen=\{menuOpen\} cartOpen=\{cartOpen\}\/>/);
});

test("1h: closed, it renders NOTHING - the page underneath is untouched", async () => {
  // Server-rendered markup contains no popup at all: it opens on a timer
  // or a scroll, both of which are client events.
  for (const [name, html] of [["/", home], ["/shop", shop]]) {
    assert.ok(!html.includes("lp-panel"), `${name} ships an open popup`);
    assert.ok(!html.includes("lp-backdrop"), `${name} ships a popup backdrop`);
    assert.ok(!html.includes("ZUR LAUNCH LIST"), `${name} ships the popup cta`);
  }
  // It is the LAST child of the shell, after the footer, the mobile
  // dock and the cart - so mounting it cannot move anything above it.
  assert.match(site, /<Footer\/><MobileDock [^/]*\/><CartDrawer open=\{cartOpen\} onClose=\{closeCart\}\/><LaunchPopup route=\{route\} menuOpen=\{menuOpen\} cartOpen=\{cartOpen\}\/><\/>/);
  // The homepage still renders exactly the sections it did.
  assert.deepEqual([...home.matchAll(/<section class="([a-z-]+)"/g)].map(m => m[1]),
    ["hero", "countdown", "prelaunch", "daily", "glance", "community", "brand-note"]);
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

/* ════════════════════════════════════════════════════════════════════
   4. ONE SCREEN, ONE OVERLAY

   THE BUG THIS SECTION EXISTS FOR. The popup arms itself on a timer, so
   it was free to land on top of a mobile menu or a cart drawer the
   visitor had already opened - two modals at once, the second one
   interrupting a deliberate action with an offer nobody asked for.
   Measured at 393x852: open the menu, wait out the 8s, and .lp-backdrop
   appeared over the navigation.

   Fixed as a state guard rather than a z-index: a z-index only decides
   which of the two wins, and both would still be there. The behaviour
   itself was measured in a real browser at 393x852, 390x844 and
   430x932; what is pinned here is the mechanism.
   ════════════════════════════════════════════════════════════════════ */

test("4: an overlay that owns the screen blocks the panel", () => {
  assert.equal(overlayBlocksLaunchPopup({}), false, "nothing open still blocks");
  assert.equal(overlayBlocksLaunchPopup({ menuOpen: false, cartOpen: false }), false,
    "both closed still blocks");
  assert.equal(overlayBlocksLaunchPopup({ menuOpen: true }), true, "the mobile menu does not block");
  assert.equal(overlayBlocksLaunchPopup({ cartOpen: true }), true, "the cart drawer does not block");
  assert.equal(overlayBlocksLaunchPopup({ menuOpen: true, cartOpen: true }), true,
    "both open does not block");
  // Still a pure leaf: the predicate takes the state, it does not reach
  // for a DOM node or a global to find it.
  const rules = readFileSync(new URL("../lib/launchPopupRules.ts", import.meta.url), "utf-8");
  assert.ok(!rules.includes("document."), "the rules leaf reached for the DOM");
  assert.ok(!rules.includes("window."), "the rules leaf reached for a global");
  assert.ok(!/^import /m.test(rules), "the rules leaf gained an import");
});

test("4b: BLOCKED IS NOT CANCELLED - the panel is held, not lost", () => {
  // The whole point. `due` survives the block, so a timer that came due
  // behind an open menu is offered once the screen is free rather than
  // being thrown away.
  assert.match(popup, /const \[due, setDue\] = useState\(false\)/, "there is no owed state");
  assert.match(popup, /if \(blocked\) \{ heldRef\.current = true; return; \}/,
    "a blocked panel is not held");
  // Blocking must not clear `due` - only a dismissal and a route change do.
  const guard = popup.slice(popup.indexOf("if (!due || open || shownRef.current) return;"));
  const effect = guard.slice(0, guard.indexOf("}, [due, open, blocked, route]);"));
  assert.ok(!effect.includes("setDue(false)"), "being blocked throws the owed panel away");
});

test("4c: the panel can only be shown when nothing else owns the screen", () => {
  // One place sets open, and it is behind the guard.
  assert.equal((popup.match(/setOpen\(true\)/g) || []).length, 1);
  const effect = popup.slice(popup.indexOf("if (!due || open || shownRef.current) return;"),
                             popup.indexOf("}, [due, open, blocked, route]);"));
  assert.ok(effect.indexOf("if (blocked)") < effect.indexOf("setOpen(true)"),
    "the panel is shown before the block is checked");
  assert.ok(effect.includes("suppressesLaunchPopup(route)"),
    "a held panel could still surface on a route that suppresses it");
  // And the shell actually hands it the state to check.
  assert.match(popup, /overlayBlocksLaunchPopup\(\{ menuOpen, cartOpen \}\)/,
    "the component does not consult the overlay rule");
});

test("4d: only a panel that WAITED gets the settle pause", () => {
  // The 8s/30% contract is unchanged for the normal path; the pause is
  // for the handover, where the menu is restoring body.style and
  // scrolling back in the same commit.
  assert.equal(LAUNCH_POPUP_DELAY_MS, 8000, "the trigger timing changed");
  assert.equal(LAUNCH_POPUP_SCROLL_RATIO, 0.3, "the scroll trigger changed");
  assert.ok(LAUNCH_POPUP_SETTLE_MS > 0 && LAUNCH_POPUP_SETTLE_MS <= 1500,
    "the settle pause is not a sane handover delay");
  assert.match(popup, /const wait = heldRef\.current \? SETTLE_MS : 0;/,
    "an unblocked panel was given the settle delay too");
});

test("4e: it still gets exactly one appearance per page", () => {
  assert.match(popup, /if \(!due \|\| open \|\| shownRef\.current\) return;/,
    "the once-per-page latch is gone, so it could reopen after a dismissal");
  assert.match(popup, /shownRef\.current = true; setOpen\(true\)/,
    "showing the panel does not spend its one appearance");
  // A dismissal clears BOTH, so nothing is left owed behind it.
  const close = popup.slice(popup.indexOf("const close = useCallback"));
  assert.ok(close.slice(0, close.indexOf("}, [])")).includes("setDue(false)"),
    "a dismissed panel is still owed and could come back");
});

test("4f: a new route is a new decision", () => {
  // Without this a panel still owed from the previous page would land the
  // instant the next one mounted - including on a route that suppresses
  // it entirely.
  const arming = popup.slice(popup.indexOf("if (suppressesLaunchPopup(route)) return;"));
  assert.ok(arming.slice(0, arming.indexOf("}, [route]);")).includes("setDue(false)"),
    "an owed panel survives navigation");
});

test("4g: no second scroll lock, and no z-index war", () => {
  // The guard means the popup can never mount while the menu or the cart
  // holds the body, so there is only ever one lock in force.
  assert.equal((popup.match(/document\.body\.style\.overflow = "hidden"/g) || []).length, 1,
    "the popup locks the body more than once");
  assert.equal((popup.match(/document\.body\.style\.overflow = ""/g) || []).length, 1,
    "the popup's lock is not paired with exactly one release");
  // The fix is state, not layering: no z-index was touched for this.
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf-8");
  assert.match(css, /\.lp-backdrop\{[^}]*z-index:60/, "the popup's z-index was changed");
  assert.match(css, /\.mobile-nav\{[^}]*z-index:35/, "the menu's z-index was changed");
  assert.match(css, /\.cart-backdrop\{[^}]*z-index:50/, "the cart's z-index was changed");
});

test("4h: the panel's own look and modal contract are untouched", () => {
  // This package coordinated WHEN it appears, nothing about what it is.
  assert.match(popup, /className="lp-backdrop"/);
  assert.match(popup, /className="lp-panel"/);
  assert.match(popup, /role="dialog" aria-modal="true"/);
  assert.match(popup, /e\.key === "Escape"/);
  assert.match(popup, /aria-label="Popup schließen"/);
  assert.match(popup, /ZUR LAUNCH LIST/);
});

/* ════════════════════════════════════════════════════════════════════
   5. ROUTE STATE — WHAT IS PER PAGE, AND WHAT IS PERSISTENT

   THE QUESTION THIS SECTION SETTLES. The panel carries four pieces of
   state: `due`, `open`, `shownRef` and `heldRef`. Only `due` is reset by
   name in the route cleanup, so the obvious worry is that the two refs
   leak from one route to the next - a heldRef from page A imposing an
   unnecessary settle pause on page B, or a shownRef spending the one
   appearance of page B before it starts.

   MEASURED, NOT ASSUMED. Driven as real client-side navigation in
   Chrome at 393x852 against the built app:

     forward nav  /about -> /contact with the panel OPEN: it is gone on
                  arrival, and window state set before the click
                  survives - so the navigation really was client-side
                  and the component really did remount.
     back nav     /about -> /our-matcha, same result.
     heldRef      blocked behind the menu on /our-matcha, then a menu
                  link to /about: the panel appeared 8074ms after the
                  click. A leaked heldRef would have made that ~8600ms
                  plus navigation. It is fresh.
     due          the held panel of route A never appeared on route B;
                  route B armed its own 8s trigger instead.

   So every piece of transient state is per route ALREADY, because the
   shell remounts per route - the refs cannot leak because the instance
   holding them does not survive. The route cleanup's setDue(false) is
   the belt to that pair of braces: it is what keeps this true if the
   shell is ever hoisted into a layout, which is exactly the refactor
   that would otherwise turn all four into cross-route state.

   These assertions pin what CAN be pinned from source: that the refs
   are per-instance, that the reset is route-scoped, that the guard
   re-checks the route, and that none of it touched the seven-day
   dismissal. The runtime behaviour above is browser QA, not a claim
   this file can make.
   ════════════════════════════════════════════════════════════════════ */

test("5: every piece of transient state is PER INSTANCE, not module-level", () => {
  // The one way the refs could leak regardless of remounting: hoisting
  // them out of the component, where every instance would share them.
  for (const name of ["shownRef", "heldRef", "due", "open"]) {
    assert.ok(popup.includes(name), `${name} is gone`);
  }
  const body = popup.slice(popup.indexOf("export function LaunchPopup("));
  for (const decl of ["const [due, setDue] = useState(false)",
                      "const [open, setOpen] = useState(false)",
                      "const shownRef = useRef(false)",
                      "const heldRef = useRef(false)"]) {
    assert.ok(body.includes(decl), `${decl} is not declared inside the component`);
  }
  // Nothing mutable at module scope that a second instance could share.
  const moduleScope = popup.slice(0, popup.indexOf("export function LaunchPopup("));
  assert.ok(!/^\s*(let|var)\s/m.test(moduleScope), "the popup module holds mutable top-level state");
});

test("5b: the transient reset is ROUTE-SCOPED", () => {
  // The arming effect keys on route and clears the owed flag on the way
  // out, so a panel owed by page A is not owed by page B.
  const arming = popup.slice(popup.indexOf("if (suppressesLaunchPopup(route)) return;"));
  const effect = arming.slice(0, arming.indexOf("}, [route]);"));
  assert.ok(effect.includes("setDue(false)"), "an owed panel survives navigation");
  assert.match(popup, /\}, \[route\]\);/, "the arming effect is no longer keyed on the route");
  // And the coordination effect is keyed on the route too, so a change
  // of page re-evaluates whether the panel may be shown at all.
  assert.match(popup, /\}, \[due, open, blocked, route\]\);/,
    "the coordination effect stopped depending on the route");
});

test("5c: a held panel can never surface on a route that suppresses it", () => {
  // Belt and braces: the arming effect already refuses to arm there, and
  // the guard checks again before showing - so even a panel that somehow
  // arrived still owed cannot appear on /launch or a task flow.
  const guard = popup.slice(popup.indexOf("if (!due || open || shownRef.current) return;"),
                            popup.indexOf("}, [due, open, blocked, route]);"));
  assert.ok(guard.includes("suppressesLaunchPopup(route)"),
    "the guard does not re-check the route");
  assert.ok(guard.indexOf("suppressesLaunchPopup(route)") < guard.indexOf("setOpen(true)"),
    "the route is checked after the panel is shown");
  // Both places consult the SAME predicate - no second copy to drift.
  assert.equal((popup.match(/suppressesLaunchPopup\(route\)/g) || []).length, 2,
    "the suppression check was duplicated or dropped");
});

test("5d: shownRef spends ONE appearance, and only on a real one", () => {
  // It is set in the same statement that opens the panel, so it cannot
  // be spent by a trigger that was held and never shown.
  assert.match(popup, /shownRef\.current = true; setOpen\(true\)/,
    "the once-per-page latch and the open are no longer one statement");
  assert.equal((popup.match(/shownRef\.current = true/g) || []).length, 1,
    "the latch is spent from more than one place");
  // And being blocked spends heldRef, never shownRef.
  assert.match(popup, /if \(blocked\) \{ heldRef\.current = true; return; \}/);
  const blockedLine = popup.slice(popup.indexOf("if (blocked) {"));
  assert.ok(!blockedLine.slice(0, blockedLine.indexOf("\n")).includes("shownRef"),
    "being blocked spends the one appearance");
});

test("5e: THE SEVEN-DAY DISMISSAL IS UNTOUCHED, and is the only persistent thing", () => {
  // The audit was about transient route state. Nothing here may have
  // moved the persistent half.
  assert.equal(LAUNCH_POPUP_DISMISS_MS, 7 * 24 * 60 * 60 * 1000);
  assert.equal(LAUNCH_POPUP_STORAGE_KEY, "gloa_launch_popup_dismissed_at");
  assert.equal(launchPopupDismissed(String(Date.now()), Date.now()), true,
    "a fresh dismissal is not in force");
  assert.equal(launchPopupDismissed(String(Date.now() - 6 * 24 * 60 * 60 * 1000), Date.now()), true,
    "a six-day-old dismissal expired early");
  assert.equal(launchPopupDismissed(String(Date.now() - 8 * 24 * 60 * 60 * 1000), Date.now()), false,
    "an eight-day-old dismissal is still in force");
  // Storage is the ONLY thing that crosses a page load; the transient
  // state is not written anywhere that survives one.
  assert.equal((popup.match(/window\.localStorage\.getItem/g) || []).length, 1,
    "the popup reads storage somewhere new");
  assert.equal((popup.match(/window\.localStorage\.setItem/g) || []).length, 1,
    "the popup writes storage somewhere new");
  for (const name of ["shownRef", "heldRef", "due"]) {
    assert.ok(!new RegExp(`setItem\\([^)]*${name}`).test(popup),
      `${name} is being persisted across page loads`);
  }
  // The triggers and the overlay coordination are unchanged by this audit.
  assert.equal(LAUNCH_POPUP_DELAY_MS, 8000);
  assert.equal(LAUNCH_POPUP_SCROLL_RATIO, 0.3);
  assert.equal(LAUNCH_POPUP_SETTLE_MS, 600);
  assert.equal(overlayBlocksLaunchPopup({ menuOpen: true }), true);
  assert.equal(overlayBlocksLaunchPopup({ cartOpen: true }), true);
});

test("5f: the CTA closes the panel on its way to /launch", () => {
  // The one link that navigates FROM an open panel, and it goes to a
  // suppressed route. Without the close it would rely entirely on the
  // remount to not be visible there.
  assert.match(popup, /<Link className="cta lp-cta" href="\/launch" onClick=\{close\}>/,
    "the CTA no longer closes the panel as it navigates");
});
