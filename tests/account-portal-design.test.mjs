import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startRenderServer } from "./helpers/renderServer.mjs";

/**
 * THE AUTHENTICATED ACCOUNT — ONE NAVIGATION, ONE TYPE SYSTEM.
 *
 * All five signed-in sections plus the three detail views and the B2B
 * section render through ONE shell, so this is a contract about that
 * shell rather than about five pages.
 *
 * The point of the pass was to end three separate page-title scales and
 * six separate muted-label treatments; tests 3 and 4 are what stop them
 * coming back.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf8");

const portal = read("app/AccountPortal.tsx");
const css = read("app/globals.css");

const blockAt = css.indexOf("THE AUTHENTICATED ACCOUNT");
assert.notEqual(blockAt, -1, "the CSS block was not found");
const startAt = css.lastIndexOf("/*", blockAt);
const nextAt = css.indexOf("/* ══════", blockAt);
const rules = css.slice(startAt, nextAt === -1 ? css.length : nextAt);
const code = rules.replace(/\/\*[\s\S]*?\*\//g, "");

const rule = name => {
  const at = code.indexOf(name);
  assert.notEqual(at, -1, `missing rule: ${name}`);
  return code.slice(at, code.indexOf("}", at));
};
const at = (lo, vw, hi, w) => Math.max(lo, Math.min(vw / 100 * w, hi));

const PORT = 8939;
let server;
test.before(async () => { server = await startRenderServer(PORT); });
test.after(() => server?.stop());

/* ══════════════════════════════════════════════════════════════
   1. THE SHELL AND THE FIVE ROUTES
   ══════════════════════════════════════════════════════════════ */

test("1: all five sections resolve through one shared shell", async () => {
  for (const route of ["/account/dashboard", "/account/orders", "/account/subscriptions",
                       "/account/addresses", "/account/profile"]) {
    const { status, html } = await server.getHtml(route);
    assert.equal(status, 200, `${route} does not resolve`);
    assert.ok(html.includes('<main class="portal"'), `${route} is not the portal shell`);
  }
  // One nav, one content well, rendered once for every page.
  assert.equal((portal.match(/<nav className="portal-nav">/g) || []).length, 1,
    "the account navigation is declared more than once");
  assert.match(portal, /<div className=\{`portal-content\$\{customerType === "business" \? " portal-content-wide" : ""\}`\}>/);
});

test("1b: the navigation labels and the route map are unchanged", () => {
  const nav = portal.slice(portal.indexOf("const NAV:"), portal.indexOf("];", portal.indexOf("const NAV:")));
  assert.deepEqual([...nav.matchAll(/key: "([^"]+)", label: "([^"]+)"/g)].map(m => [m[1], m[2]]), [
    ["dashboard", "Übersicht"], ["orders", "Bestellungen"], ["subscriptions", "Abos"],
    ["addresses", "Adressen"], ["profile", "Kontodaten"], ["business", "B2B"],
  ]);
  // Uppercase is CSS, so the labels stay in sentence case in the source.
  assert.match(rule(".portal-nav a,"), /text-transform:uppercase/);
  // The href is still built from the key, so no route was rewritten.
  assert.match(portal, /href=\{`\/account\/\$\{n\.key\}`\}/);
});

test("1c: the active tab still follows the route, and now says so", () => {
  // The SAME predicate as before, named once so the underline and the
  // announced state cannot disagree.
  assert.match(portal, /const active = page === n\.key \|\| \(n\.key === "orders" && page === "order-detail"\) \|\| \(n\.key === "subscriptions" && page === "subscription-detail"\) \|\| \(n\.key === "business" && page === "supply-detail"\);/);
  assert.match(portal, /className=\{active \? "active" : ""\}/);
  assert.match(portal, /aria-current=\{active \? "page" : undefined\}/);
});

test("1d: logout is untouched", () => {
  assert.match(portal, /const handleLogout = async \(\) => \{\s*await signOut\(\);\s*window\.location\.href = "\/account";\s*\};/);
  assert.match(portal, /<button className="portal-logout" onClick=\{handleLogout\}>Abmelden<\/button>/);
  // It stays a button, not a link.
  assert.ok(!/portal-logout[^>]*href/.test(portal), "logout became a navigation");
});

test("1e: no auth, guard, data or backend logic changed", () => {
  for (const kept of [
    'const { user, profile, loading, signOut } = useAuth();',
    'const customerType: CustomerType = profile?.customer_type ?? "private";',
    'if (!loading && !user) {',
    'window.location.href = "/account";',
    'if (!loading && (page === "business" || page === "supply-detail") && customerType !== "business")',
    'if (!loading && (page === "subscriptions" || page === "subscription-detail") && customerType === "business")',
    'const navItems = NAV.filter(n => (!n.b2bOnly || customerType === "business") && (!n.privateOnly || customerType === "private"));',
  ]) {
    assert.ok(portal.includes(kept), `portal logic changed: ${kept}`);
  }
  assert.deepEqual(readdirSync(path.join(ROOT, "app/api")).sort(),
    ["annual-plan", "checkout", "contact", "cron", "internal", "orders",
     "stripe", "subscriptions", "withdrawal"], "an API route changed");
  assert.ok(!readdirSync(path.join(ROOT, "supabase/migrations")).some(f => f.startsWith("043")),
    "migration 043 exists");
});

/* ══════════════════════════════════════════════════════════════
   2. THE NAVIGATION STRIP
   ══════════════════════════════════════════════════════════════ */

test("2: blue strip, cream labels, cream underline on the active tab", () => {
  const nav = rule(".portal-nav{");
  assert.match(nav, /background:var\(--blue\)/);
  assert.match(css, /--blue:#1746D1/);
  assert.match(nav, /padding-inline:var\(--rail-gutter\)/);

  const labels = rule(".portal-nav a,");
  assert.match(labels, /font-family:var\(--font-sans\),Arial,sans-serif/);
  assert.match(labels, /font-weight:600/);
  assert.match(labels, /font-size:11px/);
  assert.match(labels, /line-height:1\.2/);
  assert.match(labels, /letter-spacing:\.16em/);
  assert.match(labels, /color:rgba\(245,235,226,\.72\)/);

  const active = rule(".portal-nav a.active{");
  assert.match(active, /color:var\(--cream\)/);
  assert.match(active, /border-bottom-color:var\(--cream\)/);
  // The underline is a border on the tab, never a filled tab or a pill.
  assert.match(labels, /border-bottom:2px solid transparent/);
  assert.ok(!/\.portal-nav a\.active\{[^}]*background/.test(code), "the active tab became a filled tab");
  assert.ok(!/border-radius:(?!0)/.test(code), "a pill or rounded tab appeared");

  // Logout: same type as the tabs (it shares their rule), muted by
  // default, and its own rule clears the inherited opacity:.5 so the
  // muted state is a colour rather than a faded element.
  // Its own rule (the one carrying padding) clears the inherited fade.
  const logoutOwn = [...code.matchAll(/\.portal-logout\{[^}]*\}/g)].find(m => m[0].includes("padding"));
  assert.ok(logoutOwn && /opacity:1/.test(logoutOwn[0]), "the logout rule does not clear the inherited fade");
  assert.match(css, /\.portal-logout\{[^}]*opacity:\.5/, "the original logout rule changed");
  assert.match(rule(".portal-nav a:hover,"), /color:var\(--cream\)/);
  // Focus stays visible: the global ring is blue, invisible on blue.
  assert.match(rule(".portal-nav :focus-visible{"), /outline-color:var\(--cream\)/);
});

test("2b: the strip is a rail, not a second header", () => {
  // 20 + (11 * 1.2) + 20 + 2 = 55.2px, inside the 54-58 the brief names.
  assert.match(rule(".portal-nav a{"), /padding:20px 22px/);
  const height = 20 + 11 * 1.2 + 20 + 2;
  assert.ok(height >= 54 && height <= 58, `the strip is ${height}px tall`);
  // It keeps the horizontal scroll that makes all five reachable on a
  // phone - that behaviour predates this pass and was not removed.
  assert.match(css, /\.portal-nav\{[^}]*overflow-x:auto/);
  assert.ok(!code.includes("display:none"), "a tab can be hidden");
  assert.ok(!code.includes("flex-wrap"), "the strip wraps instead of scrolling");
});

test("2c: only the strip is blue - the content stays cream", () => {
  // The content well is never repainted; it inherits the cream body.
  assert.ok(!/\.portal-content\{[^}]*background/.test(code), "the content area was repainted");
  assert.match(css, /body\{[^}]*background:var\(--cream\)/);
  // And this block never reaches the site header, the ticker or the footer.
  for (const frozen of ["header", "footer", "brand-bar", "bb-track", "nav-active",
                        "account-landing", "search-bar"]) {
    assert.ok(!code.includes(frozen), `this block reaches ${frozen}`);
  }
});

/* ══════════════════════════════════════════════════════════════
   3. ONE PAGE TITLE
   ══════════════════════════════════════════════════════════════ */

test("3: the three title scales became one", () => {
  // One rule, listing all three heads, so they cannot drift apart.
  const title = rule(".portal-greeting h1,");
  assert.ok(code.includes(".portal-page-head h1,"), "the page head left the shared title rule");
  assert.ok(code.includes(".portal-b2b-intro h1{"), "the b2b head left the shared title rule");
  assert.match(title, /font-family:var\(--font-sans\),Arial,sans-serif/);
  assert.match(title, /font-weight:800/);
  assert.match(title, /font-size:clamp\(42px,4\.4vw,64px\)/);
  assert.match(title, /line-height:\.96/);
  assert.match(title, /letter-spacing:-\.045em/);
  assert.match(title, /color:var\(--ink\)/);

  // The three retired scales are gone, not merely overridden.
  for (const dead of ["clamp(36px,5vw,64px)", "clamp(32px,4.5vw,56px)", "clamp(34px,4.6vw,58px)"]) {
    assert.ok(!css.includes(`.portal-greeting h1{font-size:${dead}`), `retired scale survived: ${dead}`);
    assert.ok(!css.includes(`.portal-page-head h1{font-size:${dead}`), `retired scale survived: ${dead}`);
    assert.ok(!css.includes(`.portal-b2b-intro h1{font-size:${dead}`), `retired scale survived: ${dead}`);
  }
  assert.ok(!css.includes(".portal-greeting h1{font-size:36px}"), "a retired mobile title rule survived");
  assert.ok(!css.includes(".portal-b2b-intro h1{font-size:34px}"), "a retired mobile title rule survived");
});

test("3b: it is an internal page title, never a page hero", () => {
  // Capped below every public page hero, at every width.
  for (const w of [320, 375, 390, 430, 800, 801, 900, 1024, 1280, 1440, 1680, 1920]) {
    const title = w <= 800 ? at(34, 8.6, 44, w) : at(42, 4.4, 64, w);
    const hero = w <= 900 ? at(44, 12, 64, w) : at(54, 5.9, 100, w);
    assert.ok(title <= hero, `the account title (${title}) passed the page hero (${hero}) at ${w}px`);
    assert.ok(title <= 64, `the account title reached ${title}px at ${w}px`);
  }
  // No Cormorant anywhere in the signed-in account.
  assert.ok(!code.includes("--font-display"), "Cormorant reached the account portal");
  assert.ok(!/Georgia|Times/.test(code), "a serif fallback reached the account portal");
  assert.ok(!portal.includes("display-italic"), "an editorial italic was added to the portal");
});

/* ══════════════════════════════════════════════════════════════
   4. ONE LABEL SYSTEM, ONE VALUE SYSTEM
   ══════════════════════════════════════════════════════════════ */

test("4: eyebrows, section labels, body, labels and values each have one rule", () => {
  // (0,2,0), so it outranks the global .eyebrow at 12px/.14em.
  const eyebrow = rule(".portal .eyebrow{");
  assert.match(eyebrow, /font-weight:600/);
  assert.match(eyebrow, /font-size:11px/);
  assert.match(eyebrow, /line-height:1\.2/);
  assert.match(eyebrow, /letter-spacing:\.16em/);
  assert.match(eyebrow, /text-transform:uppercase/);
  assert.match(eyebrow, /color:var\(--ink\)/);
  assert.match(css, /\.eyebrow\{font:600 12px\/1\.2 var\(--font-mono\)/, "the global eyebrow changed");
  // A page eyebrow sits one notch wider than a section label.
  assert.match(rule(".portal .portal-page-head .eyebrow,"), /letter-spacing:\.2em/);

  const lead = rule(".portal-page-lead,");
  assert.match(lead, /font-size:16px/);
  assert.match(lead, /line-height:1\.55/);
  assert.match(lead, /color:rgba\(17,17,17,\.72\)/);

  const label = rule(".portal-profile-row>span,");
  assert.match(label, /font-weight:400/);
  assert.match(label, /color:rgba\(17,17,17,\.6\)/);
  const value = rule(".portal-profile-row>strong,");
  assert.match(value, /font-weight:600/);
  assert.match(value, /color:var\(--ink\)/);
  const row = rule(".portal-profile-row,");
  assert.match(row, /font-size:15px/);
  assert.match(row, /line-height:1\.45/);
  // Hairline separated, never boxed.
  assert.match(row, /border-top:1px solid rgba\(17,17,17,\.12\)/);
  assert.ok(!/box-shadow:(?!none)/.test(code), "a shadow was introduced");
  assert.ok(!/gradient|backdrop-filter/.test(code), "a gradient was introduced");
});

test("4b: every muted label reads ONE value", () => {
  // Six treatments - opacity .4 / .45 / .5 / .55 / .6 and two trackings -
  // collapse to one colour. Opacity fades an element; a colour states
  // an intent, so the muted role is expressed as a colour now.
  // `color:` only - a border-color is a hairline, not a text tone.
  const muted = [...code.matchAll(/(?:^|[;{\s])color:rgba\(17,17,17,\.(\d+)\)/g)].map(m => m[1]);
  assert.ok(muted.length >= 5, `only ${muted.length} muted colours were set`);
  // Exactly two text tones survive, and they are two different roles:
  // .6 is every muted label, .72 is the page lead, which is body copy
  // rather than a label. Nothing else dims text.
  assert.deepEqual([...new Set(muted)].sort(), ["6", "72"],
    "the account uses more than one muted label tone");
  // The two hairline tones are borders, and there are only two.
  const lines = [...code.matchAll(/border[a-z-]*:(?:1px solid )?rgba\(17,17,17,\.(\d+)\)/g)].map(m => m[1]);
  assert.deepEqual([...new Set(lines)].sort(), ["12", "22"], "the account uses more than two hairline tones");
  // Nothing in this block dims with opacity any more.
  for (const m of code.matchAll(/opacity:([\d.]+)/g)) {
    assert.equal(m[1], "1", `this block still fades something with opacity:${m[1]}`);
  }
});

test("4c: actions keep their hierarchy", () => {
  // Primary stays the canonical blue button at the account's meta size.
  const cta = rule(".portal .cta{");
  assert.match(cta, /font-size:12px/);
  assert.match(cta, /letter-spacing:\.16em/);
  assert.match(cta, /border-radius:0/);
  assert.match(cta, /box-shadow:none/);
  assert.match(css, /\.cta\{[^}]*background:var\(--blue\);color:var\(--cream\)/, "the shared button changed");
  // Secondary actions stay text, not a second filled button.
  const secondary = rule(".portal-action,");
  assert.match(secondary, /font-size:11px/);
  assert.match(secondary, /letter-spacing:\.16em/);
  assert.match(secondary, /color:rgba\(17,17,17,\.6\)/);
  assert.ok(!/\.portal-action[^{]*\{[^}]*background:var\(--blue\)/.test(code),
    "a secondary action became a primary button");
});

/* ══════════════════════════════════════════════════════════════
   5. NO PURE WHITE, AND NOTHING ELSE MOVED
   ══════════════════════════════════════════════════════════════ */

test("5: NO PURE WHITE", () => {
  assert.ok(!/#fff\b|#ffffff\b/i.test(code), "a white hex appeared");
  assert.ok(!/rgba?\(\s*255\s*,\s*255\s*,\s*255/.test(code), "a white rgb appeared");
  assert.ok(!/(background|color|border[a-z-]*|outline[a-z-]*)\s*:\s*white\b/i.test(code),
    "the white keyword appeared");
  for (const m of code.matchAll(/rgba\((\d+),\s*(\d+),\s*(\d+),[^)]*\)/g)) {
    const rgb = `${m[1]},${m[2]},${m[3]}`;
    assert.ok(rgb === "245,235,226" || rgb === "17,17,17", `an rgba outside the palette: ${m[0]}`);
  }
});

test("5b: every rule is keyed on the portal", () => {
  for (const m of code.matchAll(/([^{}]+)\{[^}]*\}/g)) {
    const sel = m[1].split(/[\r\n]/).pop().trim();
    if (!sel || sel.startsWith("@")) continue;
    for (const part of sel.split(",")) {
      const s = part.trim();
      if (!s) continue;
      assert.ok(/^\.portal/.test(s), `a rule here is not keyed on the portal: ${s}`);
    }
  }
  assert.ok(!code.includes("!important"), "specificity was solved with !important");
  // The public /account landing, redesigned in the previous pass, is
  // a different component and is not reachable from here.
  assert.match(css, /\.account-page\.account-landing-page\{[^}]*background:var\(--blue\)/,
    "the public account landing changed");
});

/* ══════════════════════════════════════════════════════════════
   6. RESPONSIVE
   ══════════════════════════════════════════════════════════════ */

test("6: one step down at 800, and the strip keeps its scroll", () => {
  const at800 = code.slice(code.indexOf("@media (max-width:800px)"));
  assert.match(at800, /\.portal-nav a\{padding:18px 16px\}/);
  assert.match(at800, /font-size:clamp\(34px,8\.6vw,44px\)/);
  // One title rule means one mobile step, listing the same three heads.
  assert.ok(at800.includes(".portal-greeting h1,") && at800.includes(".portal-page-head h1,")
    && at800.includes(".portal-b2b-intro h1{"), "the mobile step covers fewer heads than the base rule");
  // A stacked data row puts its value under its label, left aligned.
  assert.match(at800, /text-align:left/);
  // Long values never push the row wide.
  assert.match(css, /\.portal-fact strong\{font-weight:600;text-align:right;overflow-wrap:anywhere\}/,
    "the long-value guard changed");
});
