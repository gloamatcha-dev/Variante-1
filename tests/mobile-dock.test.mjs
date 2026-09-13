import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startRenderServer } from "./helpers/renderServer.mjs";

/**
 * THE MOBILE DOCK.
 *
 * A floating bar over the page on phones, holding five shortcuts. The
 * things worth pinning are the ones a redesign could quietly break:
 * that it is PHONES ONLY, that it floats clear of all four edges and
 * the home bar, that it never covers the end of a page, and that it
 * sits under every layer that is meant to cover it.
 *
 * The dock is rendered by the shell rather than by a page, so the
 * server checks run against a route rather than a component.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf8");

const chrome = read("app/Chrome.tsx");
const site = read("app/GloaSite.tsx");
const css = read("app/globals.css");

const dockSource = chrome.slice(chrome.indexOf("const dockIcons"), chrome.indexOf("export function Footer()"));
const rules = css.slice(css.indexOf("THE MOBILE DOCK"));
const rule = name => {
  const at = rules.indexOf(name);
  assert.notEqual(at, -1, `missing rule: ${name}`);
  return rules.slice(at, rules.indexOf("}", at));
};

const PORT = 8957;
let server;
test.before(async () => { server = await startRenderServer(PORT); });
test.after(() => { server?.stop(); });

/* ══════════════════════════════════════════════════════════════
   1. PHONES ONLY
   ══════════════════════════════════════════════════════════════ */

test("1: it is display:none by default and only appears below 640px", () => {
  // DEFAULT OFF. A media query that fails to match must leave the dock
  // hidden, not visible - so the base rule hides it and the phone query
  // turns it on, never the other way round.
  assert.match(rules, /\.dock\{display:none\}/);
  const phone = rules.slice(rules.indexOf("@media (max-width:640px){"));
  assert.notEqual(rules.indexOf("@media (max-width:640px){"), -1, "no phone breakpoint");
  assert.match(phone, /\.dock\{\s*display:block/);
  // 640px is what this stylesheet already calls a phone. The hamburger
  // appears at 800px, so tablets between the two keep exactly what they
  // had: header, menu, no dock.
  assert.ok(!rules.includes("max-width:800px"), "the dock reaches into tablet widths");
  assert.ok(!rules.includes("max-width:1024px"), "the dock reaches into desktop widths");
  // And nothing outside this block was touched to make room for it.
  assert.equal([...css.matchAll(/\.dock\b/g)].length, [...rules.matchAll(/\.dock\b/g)].length,
    "a dock rule was written outside the dock block");
});

/* ══════════════════════════════════════════════════════════════
   2. IT FLOATS, AND IT CLEARS THE HOME BAR
   ══════════════════════════════════════════════════════════════ */

test("2: air on all four sides, and the iOS inset is respected", () => {
  const dock = rule(".dock{\n    display:block");
  assert.match(dock, /position:fixed/);
  // Left and right read the same token as the bottom gap, so the bar
  // cannot end up inset differently on one axis.
  assert.match(dock, /left:var\(--dock-gap\)/);
  assert.match(dock, /right:var\(--dock-gap\)/);
  assert.match(dock, /bottom:calc\(var\(--dock-gap\) \+ env\(safe-area-inset-bottom,0px\)\)/);
  // The gap is in the 12-16px the brief asked for.
  const gap = /--dock-gap:(\d+)px/.exec(css);
  assert.ok(gap, "--dock-gap is not declared");
  assert.ok(Number(gap[1]) >= 12 && Number(gap[1]) <= 16, `--dock-gap is ${gap[1]}px`);
  // env() carries a fallback: without it the whole calc() is dropped on
  // a browser with no safe-area support, and the bar sits on the edge.
  for (const [, expr] of rules.matchAll(/env\(safe-area-inset-bottom([^)]*)\)/g)) {
    assert.equal(expr, ",0px", "an env() reference has no fallback");
  }
});

test("3: cream, rounded, blurred, and lifted - with a solid fallback", () => {
  const inner = rule(".dock-inner{");
  // The cream token's own rgb, kept translucent so the page moving
  // underneath is what makes it read as a layer.
  assert.match(inner, /background:rgba\(245,235,226,\.88\)/);
  assert.match(inner, /backdrop-filter:blur\(16px\)/);
  assert.match(inner, /-webkit-backdrop-filter:blur\(16px\)/);
  assert.match(inner, /border-radius:20px/);
  assert.match(inner, /box-shadow:0 10px 30px/);
  assert.match(inner, /border:1px solid rgba\(79,58,91,/);
  // A browser without backdrop-filter gets solid cream rather than a
  // washed-out panel over live text.
  assert.match(rules, /@supports not \(\(backdrop-filter:blur\(1px\)\) or \(-webkit-backdrop-filter:blur\(1px\)\)\)\{\s*\.dock-inner\{background:var\(--cream\)\}/);
  // NO NEW COLOUR. Every value is a token or a token's own rgb.
  for (const [, colour] of rules.matchAll(/(?:^|[;{\s])(?:background|color):\s*(#[0-9a-fA-F]{3,8})/g)) {
    assert.fail(`a raw hex colour entered the dock: ${colour}`);
  }
});

/* ══════════════════════════════════════════════════════════════
   4. THE CONTENT, AND THE TARGETS
   ══════════════════════════════════════════════════════════════ */

test("4: five entries, real touch targets, and no truncated label", () => {
  const routes = [...dockSource.matchAll(/\["(\/[a-z-]*)", "([^"]+)", "([^"]+)", "(\w+)"\]/g)];
  assert.equal(routes.length, 4, "four routes plus the cart button is five entries");
  assert.deepEqual(routes.map(r => r[1]), ["/", "/shop", "/our-matcha", "/account"]);
  // TWO LABELS. The visible one has to fit a 65px cell at 10px; the
  // accessible one keeps the full route name and CONTAINS the visible
  // one, so voice control still reaches it (WCAG 2.5.3).
  for (const [, , short, full] of routes) {
    assert.ok(full.includes(short), `"${full}" does not contain its visible label "${short}"`);
    assert.ok(short.length <= 7, `"${short}" is too long for the cell`);
  }
  assert.match(dockSource, /aria-label=\{short===full\?undefined:full\}/);
  // The cart is a drawer, not a route, so it is a button - and its name
  // says what is in it.
  assert.match(dockSource, /<button type="button" className="dock-item dock-cart" onClick=\{onCart\}/);
  assert.match(dockSource, /aria-label=\{cartCount>0\?`Warenkorb, \$\{cartCount\} Artikel`:"Warenkorb, leer"\}/);
  assert.match(dockSource, /\{cartCount>0&&<span className="dock-badge"/);
  // 48px is the smallest a finger can be asked to hit.
  assert.match(rule(".dock-item{"), /min-height:48px/);
  // Five equal columns that can shrink, so a long label cannot widen
  // the bar past the viewport.
  assert.match(rule(".dock-inner{"), /grid-template-columns:repeat\(5,minmax\(0,1fr\)\)/);
  assert.match(rule(".dock-label{"), /text-overflow:ellipsis/);
});

test("5: the active entry is marked for the eye AND for a screen reader", () => {
  assert.match(dockSource, /aria-current=\{active\?"page":undefined\}/);
  assert.match(dockSource, /const isActive=\(href:string\)=>href==="\/"\?path===href:path===href\|\|path\.startsWith\(href\+"\/"\)/);
  // Raspberry type on a raspberry tint: colour alone would be a change
  // only a sighted user who knows the palette would catch.
  assert.match(rule(".dock-item-active{"), /background:rgba\(166,30,89,\.1\)/);
  assert.match(rule(".dock-item-active{"), /color:var\(--berry\)/);
  assert.match(rules, /\.dock-item-active \.dock-label\{color:var\(--berry\)\}/);
  // Focus stays visible: the global ring is blue and legible on cream.
  assert.match(rules, /\.dock-item:focus-visible\{/);
  assert.ok(!rules.includes("outline:none"), "the focus ring was removed");
});

/* ══════════════════════════════════════════════════════════════
   6. IT COVERS NOTHING, AND EVERYTHING COVERS IT
   ══════════════════════════════════════════════════════════════ */

test("6: the page reserves exactly the space the bar occupies", () => {
  // ONE declaration for both. If the bar grows, the reservation grows
  // with it, because they read the same custom property.
  assert.match(css, /--dock-space:calc\(var\(--dock-h\) \+ var\(--dock-gap\) \+ env\(safe-area-inset-bottom,0px\)\)/);
  assert.match(rules, /footer\{padding-bottom:calc\(25px \+ var\(--dock-space\)\)\}/);
  assert.match(rule(".dock-inner{"), /min-height:var\(--dock-h\)/);
  // The reservation lives in the PHONE block, so the desktop footer
  // keeps the padding it had.
  const phone = rules.slice(rules.indexOf("@media (max-width:640px){"));
  assert.ok(phone.includes("footer{padding-bottom:"), "the footer reservation is outside the phone block");
});

test("7: it sits under the menu, the cart and the popup", () => {
  const z = sel => {
    const at = css.indexOf(sel);
    assert.notEqual(at, -1, `missing rule: ${sel}`);
    const hit = /z-index:(\d+)/.exec(css.slice(at, css.indexOf("}", at)));
    assert.ok(hit, `${sel} declares no z-index`);
    return Number(hit[1]);
  };
  const dock = z(".dock{\n    display:block");
  // The full-screen mobile menu is the INDEX; while it is open the
  // shortcut belongs behind it.
  assert.ok(dock < z(".mobile-nav{display:flex"), "the dock floats over the mobile menu");
  // And both modal layers cover it.
  assert.ok(dock < z(".cart-backdrop{"), "the dock floats over the cart drawer");
  assert.ok(dock < z(".lp-backdrop{"), "the dock floats over the launch popup");
});

/* ══════════════════════════════════════════════════════════════
   8. NOTHING ELSE MOVED
   ══════════════════════════════════════════════════════════════ */

test("8: the header, the menu and the desktop nav are untouched", () => {
  // The dock is an ADDITION. The hamburger still carries the complete
  // navigation and the desktop row still reads the same one array.
  assert.match(chrome, /const visibleLinks = links\.filter/);
  assert.match(chrome, /<nav aria-label="Hauptnavigation">\{visibleLinks\.map/);
  assert.match(chrome, /<nav id="mobile-menu" className="mobile-nav" aria-label="Mobile Navigation">/);
  // Seven routes in the menu, five shortcuts in the dock: the dock does
  // not claim to be the index.
  assert.ok([...chrome.matchAll(/\["\/[a-z-]*","[^"]+"\]/g)].length >= 6);
  // It is mounted by the shell, once, next to the drawer it opens.
  assert.match(site, /<Footer\/><MobileDock onCart=\{openCart\} cartCount=\{cart\.totalCount\}\/><CartDrawer/);
  assert.equal([...site.matchAll(/<MobileDock/g)].length, 1);
});

/* ══════════════════════════════════════════════════════════════
   9. AS RENDERED
   ══════════════════════════════════════════════════════════════ */

test("9: every public route ships the dock, once, with its five entries", async () => {
  for (const route of ["/", "/shop", "/our-matcha", "/about", "/for-cafes", "/contact"]) {
    const { status, html } = await server.getHtml(route);
    assert.equal(status, 200, `${route} did not render`);
    assert.equal(html.split('<nav class="dock"').length - 1, 1, `${route} renders the dock ${html.split('<nav class="dock"').length - 1} times`);
    const dock = html.slice(html.indexOf('<nav class="dock"'), html.indexOf("</nav>", html.indexOf('<nav class="dock"')));
    assert.equal(dock.split('class="dock-item').length - 1, 5, `${route} does not have five entries`);
    for (const label of ["Start", "Kaufen", "Matcha", "Konto", "Korb"]) {
      assert.ok(dock.includes(`>${label}<`), `${route} lost the ${label} entry`);
    }
    assert.match(dock, /aria-label="Schnellnavigation"/);
    // An empty cart shows no badge.
    assert.ok(!dock.includes("dock-badge"), `${route} renders a count for an empty cart`);
  }
});

test("10: the dock marks the route it is on, and only that one", async () => {
  for (const [route, label] of [["/", "Start"], ["/shop", "Kaufen"], ["/our-matcha", "Matcha"]]) {
    const { html } = await server.getHtml(route);
    const dock = html.slice(html.indexOf('<nav class="dock"'), html.indexOf("</nav>", html.indexOf('<nav class="dock"')));
    assert.equal(dock.split('aria-current="page"').length - 1, 1, `${route} marks more than one entry`);
    assert.equal(dock.split("dock-item-active").length - 1, 1);
    // The marked one is the one for this route.
    const active = dock.slice(dock.indexOf("dock-item-active"));
    assert.ok(active.slice(0, active.indexOf("</a>")).includes(`>${label}<`),
      `${route} marks the wrong entry`);
  }
  // A route the dock does not list marks nothing at all.
  const { html } = await server.getHtml("/about");
  const dock = html.slice(html.indexOf('<nav class="dock"'), html.indexOf("</nav>", html.indexOf('<nav class="dock"')));
  assert.ok(!dock.includes('aria-current="page"'), "/about marked an entry it is not");
});
