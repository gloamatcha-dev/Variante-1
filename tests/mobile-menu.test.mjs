import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * THE MOBILE NAVIGATION.
 *
 * ── THE BUG THESE TESTS EXIST FOR ─────────────────────────────
 *
 * The open menu inherited whichever state the last scroll left behind,
 * so it had three of them. The header is sticky with a scroll-driven
 * .compact class (64px -> 56px past 10px of scroll) and the .brand-bar
 * above it is in normal flow, so measured at 393x852 the OPEN menu
 * looked like this:
 *
 *   at the page top    header 64px at y=32, brand bar still visible,
 *                      and the first link UNDERNEATH the header -
 *                      "Startseite" was covered, not theoretically.
 *   scrolled a little  header 64px at y=28, brand bar half gone.
 *   scrolled down      header 56px at y=0, brand bar gone.
 *
 * The menu itself was always inset:0 and always in the right place.
 * What moved was the opaque header layered over its top edge at
 * z-index 40, one above the menu's 35. A layering problem, not a menu
 * problem - which is why the fix is a header fix.
 *
 * A SECOND, SEPARATE DEFECT was found in the same sweep: below 640px
 * the header's hamburger is display:none, so the dock is the only menu
 * control - and at z-index 34 it sat BEHIND the opaque menu.
 * elementFromPoint on its centre returned <nav#mobile-menu>, so an
 * open menu had no close control a thumb could reach and navigating
 * away was the only exit.
 *
 * These are source-level assertions. The geometry itself was measured
 * in a real browser at 393x852, 390x844 and 430x932; what is pinned
 * here is the mechanism, so a later edit cannot quietly restore any of
 * the three states or put the bar back behind the menu.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf8");

const chrome = read("app/Chrome.tsx");
const css = read("app/globals.css");

/** The source with its doc comments removed - they quote the code. */
const chromeCode = chrome.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const cssCode = css.replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * The stylesheet from this package's own section onwards. globals.css
 * has many @media (max-width:640px) blocks and two at 800px, so a bare
 * indexOf would read somebody else's rules and pass on them.
 */
const mine = cssCode.slice(cssCode.indexOf("--mobile-header-h"));

/** The body of one @media block, brace-matched. */
function mediaBlock(source, query) {
  const i = source.indexOf(query);
  if (i < 0) return "";
  const open = source.indexOf("{", i);
  let depth = 1, j = open + 1;
  while (j < source.length && depth > 0) {
    if (source[j] === "{") depth += 1;
    else if (source[j] === "}") depth -= 1;
    j += 1;
  }
  return source.slice(open + 1, j - 1);
}

/* ════════════════════════════════════════════════════════════════════
   1. THE HEADER HAS EXACTLY ONE STATE WHILE THE MENU IS OPEN
   ════════════════════════════════════════════════════════════════════ */

test("1: the open menu replaces the scroll state, it does not add to it", () => {
  // .nav-open INSTEAD OF .compact, never both. A className that could
  // emit "compact nav-open" would leave the height scroll-dependent
  // again, which is the whole bug.
  assert.match(chromeCode, /<header className=\{menuOpen\?"nav-open":scrolled\?"compact":""\}>/,
    "the header class is no longer a three-way single state");

  const header = chromeCode.slice(chromeCode.indexOf("<header"), chromeCode.indexOf("</header>"));
  assert.ok(!/className=\{[^}]*compact[^}]*\+/.test(header),
    "the header class is being concatenated, so compact and nav-open can co-exist");
});

test("1b: the header stops reading the scroll while the menu is open", () => {
  // The lock parks the document at 0, so an unguarded reader would see
  // "top of page", drop .compact and change the header height under the
  // open menu. It also cost 8px of scroll on every close: the header
  // grew while locked and scroll anchoring subtracted the difference.
  const effect = chromeCode.slice(chromeCode.indexOf("const s=()=>{setScrolled"));
  assert.ok(chromeCode.includes("useEffect(()=>{if(menuOpen)return;const s=()=>{setScrolled(window.scrollY>10)}"),
    "the scroll reader runs while the menu is open");
  assert.match(effect.slice(0, 400), /\},\[menuOpen\]\)/,
    "the scroll effect does not re-subscribe when the menu closes");
});

test("1c: the pinned header is the COMPACT height, so opening changes no height", () => {
  // Not cosmetic. header has transition:height, and on close it is back
  // in flow - a 64px open state shrinking to 56px moves 8px of content
  // above the viewport and Chrome's scroll anchoring silently subtracts
  // those 8px from the restored position. Measured before this line
  // existed: 3000 restored exactly on frame one, then drifted to 2992.
  assert.match(cssCode, /--mobile-header-h:56px/,
    "the open header height no longer matches the compact height");
  assert.match(cssCode, /header\.compact\{height:56px\}/,
    "the compact height moved and --mobile-header-h was not moved with it");
});

/* ════════════════════════════════════════════════════════════════════
   2. THE PINNED HEADER AND THE MENU BELOW IT
   ════════════════════════════════════════════════════════════════════ */

test("2: the open header is pinned, so the brand bar and the scroll cannot move it", () => {
  const block = mediaBlock(mine, "@media (max-width:800px)");
  const rule = block.slice(block.indexOf("header.nav-open"), block.indexOf("}", block.indexOf("header.nav-open")) + 1);
  assert.ok(rule.includes("position:fixed"), "the open header is still in the flow");
  assert.ok(/top:\s*0/.test(rule), "the open header is not pinned to the top");
  assert.ok(rule.includes("var(--mobile-header-h)"), "the open header height is a second copy of the number");
  assert.ok(rule.includes("env(safe-area-inset-top"), "the open header ignores the notch");
  assert.ok(rule.includes("padding-top:env(safe-area-inset-top"),
    "the notch is added to the height without padding, which would squash the content box");
});

test("2b: the menu starts BELOW the header, so no link can be covered", () => {
  const block = mediaBlock(mine, "@media (max-width:800px)");
  const i = block.indexOf(".mobile-nav{");
  const rule = block.slice(i, block.indexOf("}", i) + 1);
  assert.ok(rule.includes("top:calc(var(--mobile-header-h)"),
    "the menu no longer starts below the header");
  assert.ok(rule.includes("env(safe-area-inset-top"), "the menu's top edge ignores the notch");
  // The original inset:0 is what put a link under the header.
  assert.ok(!/inset:\s*0/.test(rule), "the menu is back to inset:0 and can be covered again");
});

test("2c: the menu follows the DYNAMIC viewport where the engine has one", () => {
  // A fixed bottom:0 is pinned to the LAYOUT viewport, so on mobile
  // Safari the last link can sit behind the browser chrome while it is
  // shown. 100dvh is what is visible right now; bottom:0 stays as the
  // fallback for engines without it, so neither is removed.
  assert.match(mine, /@supports \(height:100dvh\)/, "there is no dynamic-viewport height at all");
  const sup = mine.slice(mine.indexOf("@supports (height:100dvh)"));
  assert.ok(sup.includes("100dvh - var(--mobile-header-h)"),
    "the dynamic height does not subtract the header");
  const block = mediaBlock(mine, "@media (max-width:800px)");
  const i = block.indexOf(".mobile-nav{");
  assert.ok(/bottom:\s*0/.test(block.slice(i, block.indexOf("}", i) + 1)),
    "the bottom:0 fallback was removed, so an engine without dvh gets no height at all");
});

test("2d: the menu clears the home bar at the bottom", () => {
  const block = mediaBlock(mine, "@media (max-width:800px)");
  const i = block.indexOf(".mobile-nav{");
  assert.ok(block.slice(i, block.indexOf("}", i) + 1).includes("env(safe-area-inset-bottom"),
    "the last link can sit under the home indicator");
});

/* ════════════════════════════════════════════════════════════════════
   3. THE CLOSE CONTROL A THUMB CAN ACTUALLY REACH
   ════════════════════════════════════════════════════════════════════ */

test("3: the dock comes forward while the menu is open", () => {
  assert.match(chromeCode, /className=\{"dock"\+\(menuOpen\?" dock-over-menu":""\)\}/,
    "the dock no longer marks itself when the menu is open");
  // The rule lives in the dock's OWN section, next to its z-index 34 -
  // tests/mobile-dock.test.mjs asserts that no rule for the bar is
  // written anywhere else, and that is the right place for it.
  const dock = css.slice(css.indexOf("THE MOBILE DOCK"));
  assert.match(dock, /\.dock\.dock-over-menu\{z-index:36\}/,
    "the dock does not come above the menu, so there is no reachable close control");
  assert.ok(dock.indexOf(".dock.dock-over-menu") < dock.indexOf("MOBILE NAVIGATION"),
    "the rule drifted out of the dock's own section");
});

test("3b: and it is still below the layers that must cover it", () => {
  // 36 is one above the menu's 35 and below the cart drawer (50) and
  // the launch popup (60) - both of those must keep covering the dock.
  assert.match(cssCode, /\.mobile-nav\{display:flex;position:fixed;inset:0;z-index:35/,
    "the menu's own z-index moved; the dock's 36 was chosen against it");
  assert.match(cssCode, /\.cart-backdrop\{[^}]*z-index:50/, "the cart drawer no longer covers the dock");
});

test("3c: the menu reserves the bar's space, so the bar covers no link", () => {
  const block = mediaBlock(mine, "@media (max-width:640px)");
  const i = block.indexOf(".mobile-nav{");
  assert.ok(i >= 0, "the menu no longer reserves anything below 640px");
  assert.ok(block.slice(i, block.indexOf("}", i) + 1).includes("var(--dock-space)"),
    "the reservation is a second copy of the number rather than the shared --dock-space");
});

/* ════════════════════════════════════════════════════════════════════
   4. THE SCROLL LOCK KEEPS THE PLACE IT LOCKED
   ════════════════════════════════════════════════════════════════════ */

test("4: the lock is the one every engine honours, not overflow alone", () => {
  // body{overflow:hidden} is not a scroll lock on iOS Safari - the page
  // keeps moving behind the menu there.
  const lock = chromeCode.slice(chromeCode.indexOf("const prev=document.activeElement"),
                                chromeCode.indexOf("},[menuOpen]);", chromeCode.indexOf("const prev=document.activeElement")));
  assert.ok(lock.includes('body.style.position="fixed"'), "the body is not taken out of flow");
  assert.ok(lock.includes("const y=window.scrollY"), "the scroll offset is not remembered");
  assert.ok(lock.includes("body.style.top=`-${y}px`"), "the page is not held at its offset");
  assert.ok(lock.includes("window.scrollTo(0,y)"), "the scroll offset is never restored");
});

test("4b: the restore does not ANIMATE back to where the page already was", () => {
  // html has scroll-behavior:smooth globally, so without suspending it
  // the restore animates - the visible jump the lock exists to prevent.
  assert.match(cssCode, /html\{scroll-behavior:smooth/, "the global smooth scroll moved; 4b assumes it");
  const lock = chromeCode.slice(chromeCode.indexOf("const prev=document.activeElement"));
  const restore = lock.slice(0, lock.indexOf("},[menuOpen]);"));
  assert.ok(restore.includes('html.style.scrollBehavior="auto"'), "the smooth scroll is not suspended");
  assert.ok(restore.indexOf('scrollBehavior="auto"') < restore.indexOf("window.scrollTo(0,y)"),
    "the smooth scroll is suspended only after the restore, which is too late");
  assert.ok(restore.includes("html.style.scrollBehavior=behavior"),
    "the page is left with smooth scrolling permanently off");
});

test("4c: every property the lock overwrote is put back, not blanked", () => {
  const lock = chromeCode.slice(chromeCode.indexOf("const prev=document.activeElement"));
  const restore = lock.slice(0, lock.indexOf("},[menuOpen]);"));
  for (const prop of ["position", "top", "left", "right", "width", "overflow"]) {
    assert.ok(restore.includes(`prior.${prop}`), `body.style.${prop} is not restored to what it was`);
  }
});

test("4d: the opener still gets the focus back", () => {
  // Pre-existing behaviour the rewritten lock must not have dropped.
  const lock = chromeCode.slice(chromeCode.indexOf("const prev=document.activeElement"));
  assert.ok(lock.slice(0, lock.indexOf("},[menuOpen]);")).includes("prev?.focus?.()"),
    "closing the menu no longer returns focus to whatever opened it");
});

/* ════════════════════════════════════════════════════════════════════
   5. DESKTOP IS NOT TOUCHED
   ════════════════════════════════════════════════════════════════════ */

test("5: not one of the new rules can reach a desktop viewport", () => {
  // Everything added for the mobile menu lives inside a max-width block.
  // The only thing outside one is the custom property, which is inert
  // until a rule in one of those blocks reads it.
  const section = mine;
  for (const selector of ["header.nav-open"]) {
    const at = section.indexOf(selector);
    assert.ok(at > 0, `${selector} is gone`);
    const before = section.slice(0, at);
    const opens = (before.match(/@media \(max-width:\d+px\)\{/g) || []).length;
    assert.ok(opens > 0, `${selector} sits outside any max-width media query`);
  }
  // The dock's lift lives in the dock's own 640px block; that it is
  // inside a max-width query is asserted where the rule lives.
  const dock = css.slice(css.indexOf("THE MOBILE DOCK"));
  const at = dock.indexOf(".dock.dock-over-menu");
  assert.ok(at > 0 && (dock.slice(0, at).match(/@media \(max-width:\d+px\)\{/g) || []).length > 0,
    "the dock lift sits outside any max-width media query");
});

test("5b: the desktop header keeps its own sticky, height and compact rules", () => {
  assert.match(cssCode, /header\{height:86px;[^}]*position:sticky;top:0;z-index:40/,
    "the desktop header's base rule changed");
  assert.match(cssCode, /header\.compact\{height:64px\}/, "the desktop compact height changed");
  const mobile = mediaBlock(cssCode, "@media(max-width:800px)");
  assert.match(mobile, /header\{height:64px/, "the mobile base header height changed");
});

/* ════════════════════════════════════════════════════════════════════
   6. NOTHING WAS REDESIGNED
   ════════════════════════════════════════════════════════════════════ */

test("6: the menu keeps its own type, colour, centring and link set", () => {
  // The fix is position and layering only. If a later edit "tidies"
  // these away it is a redesign, and this package was not one.
  assert.match(cssCode, /\.mobile-nav\{display:flex;position:fixed;inset:0;z-index:35;background:var\(--cream\);flex-direction:column;justify-content:center;padding:0 8vw;overflow-y:auto;overscroll-behavior:contain\}/,
    "the menu's base rule changed - the fix is meant to override it, not replace it");
  assert.match(cssCode, /\.mobile-nav a\{font-size:clamp\(36px,8vw,52px\)/, "the menu's type changed");
  // ONE array feeds the desktop row and the mobile menu alike.
  assert.ok(chromeCode.includes('<nav id="mobile-menu" className="mobile-nav"'), "the menu markup changed");
  assert.equal((chromeCode.match(/id="mobile-menu"/g) || []).length, 1,
    "there is more than one #mobile-menu, so the two navigations can diverge");
});

test("6b: a menu link still closes the menu on the way out", () => {
  const menu = chromeCode.slice(chromeCode.indexOf('<nav id="mobile-menu"'));
  const markup = menu.slice(0, menu.indexOf("</nav>"));
  const links = markup.match(/onClick=\{\(\)=>onMenuOpenChange\(false\)\}/g) || [];
  assert.ok(links.length >= 2, "a menu link no longer closes the menu when it navigates");
});
