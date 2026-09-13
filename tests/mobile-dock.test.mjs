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
// The doc comments quote the markup they describe, so a count of
// elements has to read the code without them.
const chromeCode = chrome.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
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
  // THREE routes, plus the two entries that are not routes at all: the
  // drawer and the cart.
  assert.equal(routes.length, 3, "three routes plus menu and cart is five entries");
  assert.deepEqual(routes.map(r => r[1]), ["/shop", "/our-matcha", "/account"]);
  assert.deepEqual(routes.map(r => r[2]), ["Kaufen", "Matcha", "Konto"]);
  // TWO LABELS. The visible one has to fit a 65px cell at 10px; the
  // accessible one keeps the full route name and CONTAINS the visible
  // one, so voice control still reaches it (WCAG 2.5.3).
  for (const [, , short, full] of routes) {
    assert.ok(full.includes(short), `"${full}" does not contain its visible label "${short}"`);
    assert.ok(short.length <= 7, `"${short}" is too long for the cell`);
  }
  assert.match(dockSource, /aria-label=\{short===full\?undefined:full\}/);

  // START IS GONE. The wordmark in the header is already the way back.
  assert.ok(!dockSource.includes('"/", "Start"'), "the home entry came back");
  assert.ok(!dockSource.includes("Startseite"), "the home entry came back");
  assert.ok(!dockSource.includes("home:"), "the home icon outlived its entry");

  // MENU OPENS THE DRAWER THAT ALREADY EXISTS. One panel, two openers.
  assert.match(dockSource, /<button type="button" className=\{"dock-item dock-menu"/);
  assert.match(dockSource, /onClick=\{\(\)=>onMenuOpenChange\(!menuOpen\)\}/);
  assert.match(dockSource, /aria-expanded=\{menuOpen\} aria-controls="mobile-menu"/);
  assert.match(dockSource, /<span className="dock-label">Men\u00fc<\/span>/);
  // It builds no drawer of its own.
  assert.ok(!dockSource.includes("mobile-nav"), "the dock renders a second menu");
  assert.equal([...chromeCode.matchAll(/<nav id="mobile-menu"/g)].length, 1, "there is more than one drawer");

  // THE CART IS THE EXISTING ONE, with the existing count.
  assert.match(dockSource, /<button type="button" className=\{"dock-item dock-cart"/);
  assert.match(dockSource, /onClick=\{onCart\}/);
  assert.match(dockSource, /aria-label=\{cartCount>0\?`Warenkorb, \$\{cartCount\} Artikel`:"Warenkorb, leer"\}/);
  assert.match(dockSource, /\{cartCount>0&&<span className="dock-badge"/);
  // ONE count, from the shell's one cart - the dock does not tally.
  assert.ok(!dockSource.includes("useState"), "the dock keeps state of its own");
  assert.ok(!dockSource.includes("reduce("), "the dock counts the cart a second time");

  // NO SEARCH, and no sixth cell.
  for (const gone of ["Suche", "search", "Search"]) {
    assert.ok(!dockSource.includes(gone), `a search entry appeared: ${gone}`);
  }
  assert.match(rule(".dock-inner{"), /grid-template-columns:repeat\(5,minmax\(0,1fr\)\)/);

  // 48px is the smallest a finger can be asked to hit.
  assert.match(rule(".dock-item{"), /min-height:48px/);
  assert.match(rule(".dock-label{"), /text-overflow:ellipsis/);
});

test("5: exactly one entry is marked, and only when it should be", () => {
  // ROUTES match on the path. "/" is no longer among them, so the
  // special case it needed is gone with it.
  assert.match(dockSource, /const isActive=\(href:string\)=>path===href\|\|path\.startsWith\(href\+"\/"\)/);
  assert.match(dockSource, /aria-current=\{active\?"page":undefined\}/);
  // THE TWO NON-ROUTES mark themselves from the state they control, so
  // a route entry and a drawer entry cannot both claim to be current.
  assert.match(dockSource, /"dock-item dock-menu"\+\(menuOpen\?" dock-item-active":""\)/);
  assert.match(dockSource, /"dock-item dock-cart"\+\(cartOpen\?" dock-item-active":""\)/);
  assert.ok(!/dock-menu[^\n]*aria-current/.test(dockSource), "the drawer claims to be a page");
  assert.ok(!/dock-cart[^\n]*aria-current/.test(dockSource), "the cart claims to be a page");
  // Raspberry type on a raspberry tint: colour alone would be a change
  // only a sighted user who knows the palette would catch.
  assert.match(rule(".dock-item-active{"), /background:rgba\(166,30,89,\.1\)/);
  assert.match(rule(".dock-item-active{"), /color:var\(--berry\)/);
  assert.match(rules, /\.dock-item-active \.dock-label\{color:var\(--berry\)\}/);
  // The active state is a colour and a background, not a size - so
  // marking one cannot move the row.
  const active = rule(".dock-item-active{");
  for (const shifts of ["font-size", "padding", "margin", "border", "transform", "min-height"]) {
    assert.ok(!active.includes(shifts), `the active state moves the layout: ${shifts}`);
  }
  // Focus stays visible: the global ring is blue and legible on cream.
  assert.match(rules, /\.dock-item:focus-visible\{/);
  assert.ok(!rules.includes("outline:none"), "the focus ring was removed");
});

/* ══════════════════════════════════════════════════════════════
   5b. THE MOBILE HEADER IS THE WORDMARK
   ══════════════════════════════════════════════════════════════ */

test("5b: below 640px the top bar carries the logo and nothing else", () => {
  const phone = rules.slice(rules.indexOf("@media (max-width:640px){"));
  // The hamburger and the cart moved into the dock, so they leave the
  // top bar - but only BELOW 640. Between 641 and 800 the hamburger is
  // still the entire navigation, because the dock does not exist there.
  assert.match(phone, /\.menu\{display:none\}/);
  assert.match(phone, /\.head-actions\{display:none\}/);
  assert.match(css, /@media\(max-width:800px\)\{[\s\S]*?\.menu\{display:block;justify-self:start\}/);
  // One centred track, so the wordmark is centred rather than left in
  // the first of three columns once its neighbours stop being items.
  assert.match(phone, /header\{grid-template-columns:1fr;justify-items:center\}/);
  // The height is not touched by any of it.
  assert.ok(!/@media \(max-width:640px\)\{[\s\S]*?header\{[^}]*height:/.test(rules),
    "the mobile header changed height");
  // The wordmark is still a link to the start, and still the only one
  // in the header.
  assert.match(chrome, /<Link className="wordmark" href="\/" aria-label="GLOA Startseite">/);
});


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
  assert.match(site, /<Footer\/><MobileDock onCart=\{openCart\} cartCount=\{cart\.totalCount\} cartOpen=\{cartOpen\} menuOpen=\{menuOpen\} onMenuOpenChange=\{setMenuOpen\}\/><CartDrawer/);
  // ONE piece of menu state, in the shell that renders both openers.
  assert.match(site, /const \[menuOpen,setMenuOpen\]=useState\(false\)/);
  assert.equal([...site.matchAll(/setMenuOpen/g)].length, 3, "the menu state is set from more than the two controls");
  assert.match(site, /<Header onCart=\{openCart\} cartCount=\{cart\.totalCount\} menuOpen=\{menuOpen\} onMenuOpenChange=\{setMenuOpen\}\/>/);
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
    for (const label of ["Menü", "Kaufen", "Matcha", "Konto", "Korb"]) {
      assert.ok(dock.includes(`>${label}<`), `${route} lost the ${label} entry`);
    }
    assert.ok(!dock.includes(">Start<"), `${route} still ships the home entry`);
    assert.ok(!/Suche|>Search</.test(dock), `${route} ships a search entry`);
    // The top bar ships the wordmark and, on this width, nothing a
    // phone visitor can see beside it.
    const head = html.slice(html.indexOf("<header"), html.indexOf("</header>"));
    assert.match(head, /<a href="\/" class="wordmark" aria-label="GLOA Startseite">/);
    assert.match(dock, /aria-label="Schnellnavigation"/);
    // An empty cart shows no badge.
    assert.ok(!dock.includes("dock-badge"), `${route} renders a count for an empty cart`);
  }
});

test("10: the dock marks the route it is on, and only that one", async () => {
  for (const [route, label] of [["/shop", "Kaufen"], ["/our-matcha", "Matcha"], ["/account", "Konto"]]) {
    const { html } = await server.getHtml(route);
    const dock = html.slice(html.indexOf('<nav class="dock"'), html.indexOf("</nav>", html.indexOf('<nav class="dock"')));
    assert.equal(dock.split('aria-current="page"').length - 1, 1, `${route} marks more than one entry`);
    assert.equal(dock.split("dock-item-active").length - 1, 1);
    // The marked one is the one for this route.
    const active = dock.slice(dock.indexOf("dock-item-active"));
    assert.ok(active.slice(0, active.indexOf("</a>")).includes(`>${label}<`),
      `${route} marks the wrong entry`);
  }
  // A route the dock does not list marks nothing at all - including the
  // homepage, which no longer has an entry.
  for (const route of ["/", "/about"]) {
    const { html: h } = await server.getHtml(route);
    const dk = h.slice(h.indexOf('<nav class="dock"'), h.indexOf("</nav>", h.indexOf('<nav class="dock"')));
    assert.ok(!dk.includes("dock-item-active"), `${route} marked an entry it is not`);
  }
  const { html } = await server.getHtml("/about");
  const dock = html.slice(html.indexOf('<nav class="dock"'), html.indexOf("</nav>", html.indexOf('<nav class="dock"')));
  assert.ok(!dock.includes('aria-current="page"'), "/about marked an entry it is not");
});

/* ══════════════════════════════════════════════════════════════
   11. THE PAGE END

   The cream band a visitor saw past the black footer was NOT extra
   layout: measured on /, /shop, /our-matcha, /about, /for-cafes,
   /partnerships and /account at 390px and 430px, the footer ends at
   document bottom every time. It was the native rubber-band revealing
   the canvas, which the body's cream was painting.

   So the fix is two rules, because different browsers honour different
   halves of it, and NEITHER of them stops the page scrolling.
   ══════════════════════════════════════════════════════════════ */

test("11: the root limits overscroll and the canvas matches the footer", () => {
  const root = css.slice(css.indexOf("html{scroll-behavior"), css.indexOf("}", css.indexOf("html{scroll-behavior")));
  // Where it is supported, the root scroller cannot be dragged past its
  // own content at all.
  assert.match(root, /overscroll-behavior-y:none/);
  // Where it is not, the bounce shows the canvas - so the canvas is the
  // footer's ink rather than the page's cream.
  assert.match(root, /background:var\(--ink\)/);
  const body = css.slice(css.indexOf("body{margin:0"), css.indexOf("}", css.indexOf("body{margin:0")));
  assert.match(body, /background:var\(--cream\)/);
  // min-height keeps the body covering the viewport, so the ink can only
  // ever appear OUTSIDE the page and never under a short one.
  assert.match(body, /min-height:100vh/);

  // SCROLLING STILL WORKS. No document-level lock, no fixed height.
  assert.ok(!/(^|[;{\s])html\{[^}]*overflow:hidden/.test(css), "the document was locked");
  assert.ok(!/(^|[;{\s])body\{[^}]*overflow:hidden/.test(css), "the body was locked");
  assert.ok(!/(^|[;{\s])html\{[^}]*height:100/.test(css), "the document was given a fixed height");
  // The only body overflow lock in the repo is the JS one the drawers
  // set while they are open, and it is always paired with a release.
  const chromeJs = readFileSync(new URL("../app/Chrome.tsx", import.meta.url), "utf-8");
  assert.match(chromeJs, /document\.body\.style\.overflow="hidden"/);
  assert.match(chromeJs, /document\.body\.style\.overflow=""/);

  // Drawers keep their own scroll rather than chaining it to the page
  // behind them.
  assert.match(css, /\.mobile-nav\{[^}]*overscroll-behavior:contain/);
  assert.match(css, /\.cart\{overscroll-behavior:contain\}/);
});

test("12: no spacer reserves the dock's height outside the footer", () => {
  // The reserve is INSIDE the footer, which is why the black runs to the
  // true end of the document. A padding on the body, the root or a
  // wrapper would have put that reserve after the footer, as a band of
  // page background - which is exactly the thing being fixed.
  const phone = rules.slice(rules.indexOf("@media (max-width:640px){"));
  assert.match(phone, /footer\{padding-bottom:calc\(25px \+ var\(--dock-space\)\)\}/);
  for (const wrong of ["body{padding-bottom", "html{padding-bottom", "main{padding-bottom",
                       "footer{margin-bottom", "dock-spacer", "mobile-nav-spacer"]) {
    assert.ok(!css.includes(wrong), `the dock reserve leaked outside the footer: ${wrong}`);
  }
  // And nothing is rendered after the footer that could occupy space:
  // the dock, the cart and the popup are all fixed-position layers.
  assert.match(site, /<Footer\/><MobileDock/);
  assert.match(rules, /\.dock\{\s*display:block;\s*position:fixed/);
});

test("13: as rendered, the footer is the last thing in the document", async () => {
  // A structural stand-in for the visual check: nothing may follow the
  // closing </footer> except the fixed layers, which take no space.
  for (const route of ["/", "/our-matcha", "/about"]) {
    const { html } = await server.getHtml(route);
    const after = html.slice(html.lastIndexOf("</footer>") + "</footer>".length);
    const tags = [...after.matchAll(/<(\w+)[^>]*>/g)].map(m => m[1]);
    for (const tag of tags) {
      assert.ok(["nav", "span", "svg", "path", "circle", "script", "a", "button", "div", "template",
                 "title", "meta", "link", "style", "noscript"].includes(tag),
        `${route} renders <${tag}> after the footer`);
    }
    // Whatever is there is the dock, and the dock is fixed.
    const nonDock = after.replace(/<nav class="dock"[\s\S]*?<\/nav>/, "");
    for (const [, attrs] of nonDock.matchAll(/<div([^>]*)>/g)) {
      assert.ok(attrs.includes("hidden"), `${route} has a visible div after the footer: <div${attrs}>`);
    }
  }
});
