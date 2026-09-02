import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startRenderServer } from "./helpers/renderServer.mjs";

/**
 * THE B2B AUTHENTICATED ACCOUNT — ONE TYPE SYSTEM ACROSS FIVE ROUTES.
 *
 * account-portal-design.test.mjs already guards the shell: the blue
 * strip, the one page title, the one eyebrow, the one body, the one
 * action. This file guards what that pass did NOT reach - the rows,
 * tables, panels and B2B blocks the business account is mostly made of -
 * and the two boundaries around it:
 *
 *   1. Everything is keyed on `.portal`, so the public /b2b marketing
 *      page cannot be touched even though it shares the `b2b-` prefix.
 *   2. The shell is shared with the PRIVATE account. One type system for
 *      both is the point, but the navigation stays role dependent:
 *      private keeps ABOS, business keeps B2B, and neither gains the
 *      other's tab.
 *
 * The portal is client-rendered behind an auth guard, so the rendered
 * assertions cover the shell and the routes; the type itself is asserted
 * against the stylesheet.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf8");

const portal = read("app/AccountPortal.tsx");
const ui = read("app/AccountUI.tsx");
const css = read("app/globals.css");

const blockAt = css.indexOf("THE B2B ACCOUNT — THE REST OF THE TYPE");
assert.notEqual(blockAt, -1, "the CSS block was not found");
const startAt = css.lastIndexOf("/*", blockAt);
const nextAt = css.indexOf("/* ══════", blockAt + 10);
const rules = css.slice(startAt, nextAt === -1 ? css.length : nextAt);
const code = rules.replace(/\/\*[\s\S]*?\*\//g, "");

/** Selector + body pairs; `[^{}]*` for the body is what skips @media. */
const pairs = () => [...code.matchAll(/([^{}]+)\{([^{}]*)\}/g)];

const rule = name => {
  const at = code.indexOf(name);
  assert.notEqual(at, -1, `missing rule: ${name}`);
  return code.slice(at, code.indexOf("}", at));
};

const PORT = 8943;
let server;
test.before(async () => { server = await startRenderServer(PORT); });
test.after(() => server?.stop());

/* ══════════════════════════════════════════════════════════════
   1. THE FIVE B2B ROUTES, THE NAV, AND THE ROLE SPLIT
   ══════════════════════════════════════════════════════════════ */

test("1: all five business routes resolve through the one portal shell", async () => {
  for (const route of ["/account/dashboard", "/account/orders", "/account/addresses",
                       "/account/profile", "/account/business"]) {
    const { status, html } = await server.getHtml(route);
    assert.equal(status, 200, `${route} stopped resolving`);
    assert.ok(html.includes('<main class="portal"'), `${route} is not the portal`);
  }
});

test("1b: the business navigation is exactly the five tabs plus logout", () => {
  // The labels live in ONE array; uppercase is CSS, not copy.
  assert.match(portal, /const NAV: \{ key: PortalPage; label: string; b2bOnly\?: boolean; privateOnly\?: boolean \}\[\] = \[/);
  for (const [key, label, flag] of [
    ["dashboard", "Übersicht", ""],
    ["orders", "Bestellungen", ""],
    ["subscriptions", "Abos", ", privateOnly: true"],
    ["addresses", "Adressen", ""],
    ["profile", "Kontodaten", ""],
    ["business", "B2B", ", b2bOnly: true"],
  ]) {
    assert.ok(portal.includes(`{ key: "${key}", label: "${label}"${flag} }`),
      `the nav entry for ${key} changed`);
  }
  assert.match(rule(".portal .portal-quicklink-label{"), /text-transform:uppercase/);
  // Logout is still a button with the real handler, still last.
  assert.ok(portal.includes('<button className="portal-logout" onClick={handleLogout}>Abmelden</button>'),
    "logout changed");
  assert.ok(portal.includes("const handleLogout = async () => {\n    await signOut();"),
    "the logout handler changed");
});

test("1c: private keeps ABOS, business keeps B2B, and neither gains the other", () => {
  // ONE filter decides this, and it reads customer_type - not CSS.
  assert.ok(portal.includes('const navItems = NAV.filter(n => (!n.b2bOnly || customerType === "business") && (!n.privateOnly || customerType === "private"));'),
    "the role filter changed");
  assert.ok(portal.includes('const customerType: CustomerType = profile?.customer_type ?? "private";'),
    "the account-type determination changed");
  // Simulate the filter both ways rather than trusting the string.
  const NAV = [...portal.matchAll(/\{ key: "(\w+)", label: "([^"]+)"(?:, (b2bOnly|privateOnly): true)? \}/g)]
    .map(m => ({ key: m[1], label: m[2], flag: m[3] }));
  assert.equal(NAV.length, 6, `the nav has ${NAV.length} entries`);
  const forType = t => NAV.filter(n => (n.flag !== "b2bOnly" || t === "business") && (n.flag !== "privateOnly" || t === "private")).map(n => n.label);
  assert.deepEqual(forType("business"), ["Übersicht", "Bestellungen", "Adressen", "Kontodaten", "B2B"]);
  assert.deepEqual(forType("private"), ["Übersicht", "Bestellungen", "Abos", "Adressen", "Kontodaten"]);
  // And the guards that back the filter up are untouched.
  assert.ok(portal.includes('if (!loading && (page === "business" || page === "supply-detail") && customerType !== "business")'),
    "the business-only guard changed");
  assert.ok(portal.includes('if (!loading && (page === "subscriptions" || page === "subscription-detail") && customerType === "business")'),
    "the private-only guard changed");
});

test("1d: the active tab still follows the route, and still says so", () => {
  assert.ok(portal.includes('const active = page === n.key || (n.key === "orders" && page === "order-detail") || (n.key === "subscriptions" && page === "subscription-detail") || (n.key === "business" && page === "supply-detail");'),
    "the active-tab contract changed");
  assert.ok(portal.includes('className={active ? "active" : ""} aria-current={active ? "page" : undefined}'),
    "the active tab lost its class or its aria-current");
  // Active is stated by cream AND an underline, never by colour alone.
  assert.match(css, /\.portal-nav a\.active\{\s*color:var\(--cream\);\s*border-bottom-color:var\(--cream\);/);
});

test("1e: no backend, auth, data or commercial logic changed", () => {
  for (const kept of [
    'const { user, profile, loading, signOut } = useAuth();',
    'supabase.from("b2b_supply_agreements").select("*")',
    'supabase.from("orders").select("*")',
    'const isBusiness = profile?.customer_type === "business";',
    'fmtCents(isBusiness ? o.total_net_cents ?? o.total_gross_cents : o.total_gross_cents)',
    'const calcPrice = (pricePerKg: number, grams: number, discountPct: number) =>',
  ]) {
    assert.ok(portal.includes(kept), `logic changed: ${kept}`);
  }
  assert.deepEqual(readdirSync(path.join(ROOT, "app/api")).sort(),
    ["annual-plan", "checkout", "contact", "cron", "internal", "orders",
     "stripe", "subscriptions", "withdrawal"], "an API route changed");
  assert.ok(!readdirSync(path.join(ROOT, "supabase/migrations")).some(f => f.startsWith("043")),
    "migration 043 exists");
  // The presentation primitives stayed presentation.
  assert.ok(!/supabase|useAuth|customer_type/.test(ui), "AccountUI grew a data dependency");
});

/* ══════════════════════════════════════════════════════════════
   2. INTER, EVERYWHERE, ON PURPOSE
   ══════════════════════════════════════════════════════════════ */

test("2: every rule names the real Inter variable", () => {
  // NOT belt and braces. `--font-mono` is declared on `:root` as
  // `var(--font-sans)`, but next/font puts Inter's `--font-sans` on
  // `<body>`; a custom property is substituted where it is DECLARED, so
  // `--font-mono` captures Tailwind's system stack and inherits it. Any
  // account rule that leaves the family to `--font-mono` renders the OS
  // UI font, which is exactly what this block exists to stop.
  assert.match(css, /--font-mono:var\(--font-sans\)\}/, "the root alias moved");
  assert.match(read("app/layout.tsx"), /<body className=\{`\$\{sans\.variable\}/,
    "the font variable moved off <body>");
  assert.ok(!code.includes("--font-mono"), "a rule here trusts the broken alias");
  // Every rule that sets any font property names the family too.
  // Every FULL type rule here declares a leading; the weight-only and
  // tracking-only riders, and the two mobile size overrides, do not -
  // and those inherit the family the rule above them already set.
  let full = 0;
  for (const [, selector, body] of pairs()) {
    if (!/line-height:/.test(body)) continue;
    full++;
    const sel = selector.split(/[\r\n]/).pop().trim();
    assert.match(body, /font-family:var\(--font-sans\),Arial,sans-serif/,
      `no explicit Inter on: ${sel}`);
  }
  assert.ok(full >= 7, `only ${full} full type rules were found`);
});

test("2b: no Cormorant, and no serif, reaches the signed-in account", () => {
  assert.ok(!code.includes("--font-display"), "Cormorant reached the account");
  assert.ok(!/Georgia|Times|Cormorant|serif(?!-)/.test(code.replace(/sans-serif/g, "")),
    "a serif reached the account");
  // The only route to Cormorant is `h1 i`/`h2 i`, and the portal renders
  // no italic display type at all.
  assert.equal((portal.match(/<i>/g) || []).length, 0, "the portal grew an italic display line");
  assert.equal((ui.match(/<i>/g) || []).length, 0, "AccountUI grew an italic display line");
});

/* ══════════════════════════════════════════════════════════════
   3. THE LADDER — ONE RULE PER RANK
   ══════════════════════════════════════════════════════════════ */

test("3: meta labels, including every table head", () => {
  const meta = rule(".portal .portal-company-fact>span,");
  assert.match(meta, /font-weight:600/);
  assert.match(meta, /font-size:11px/);
  assert.match(meta, /line-height:1\.3/);
  assert.match(meta, /letter-spacing:\.12em/);
  assert.match(meta, /text-transform:uppercase/);
  assert.match(meta, /color:rgba\(17,17,17,\.6\)/);
  // Orders, supply agreements and the B2B price table are the same rank,
  // so they are the same rule rather than three more.
  for (const s of [".portal .order-list-header", ".portal .supply-list-header",
                   ".portal .b2b-pricing-header .b2b-pricing-cell"]) {
    assert.ok(code.slice(code.indexOf(".portal .portal-company-fact>span,"),
                         code.indexOf("}", code.indexOf(".portal .portal-company-fact>span,"))).includes(s),
      `${s} is not on the shared meta rule`);
  }
  // The shared meta label in the block above reads the same rank.
  assert.match(css, /\.portal-summary-label\{[^}]*line-height:1\.3;[^}]*letter-spacing:\.12em/);
});

test("3b: block headings, and they are not page titles", () => {
  const head = rule(".portal .portal-company-head strong,");
  assert.match(head, /font-weight:700/);
  assert.match(head, /font-size:18px/);
  assert.match(head, /line-height:1\.2/);
  assert.match(head, /letter-spacing:-\.015em/);
  assert.match(head, /color:var\(--ink\)/);
  assert.ok(head.includes(".portal .b2b-model-label"), "the offer-model title is not on the shared rule");
  // Far below the shared page title at every width, so a panel can never
  // read as the page.
  const at = (lo, vw, hi, w) => Math.max(lo, Math.min(vw / 100 * w, hi));
  for (const w of [375, 768, 801, 1280, 1680]) {
    const title = w <= 800 ? at(34, 8.6, 44, w) : at(42, 4.4, 64, w);
    assert.ok(18 < title, `the block heading is not below the page title at ${w}px`);
  }
});

test("3c: the lead value states an absent delivery at weight, not at size", () => {
  const lead = rule(".portal .portal-summary-primary{");
  assert.match(lead, /font-weight:600/);
  assert.match(lead, /font-size:18px/);
  assert.match(lead, /line-height:1\.3/);
  assert.match(lead, /letter-spacing:-\.01em/);
  assert.match(lead, /color:var\(--ink\)/);
  // The sentence itself is untouched copy on the dashboard.
  assert.ok(portal.includes('primary="Keine geplante Lieferung."'), "the empty-delivery copy changed");
  assert.ok(portal.includes('secondary="Bezugsmodell, Lieferintervall und Konditionen richten wir gemeinsam ein."'),
    "the delivery explanation changed");
  // And its explanation stays supporting body, not a second heading.
  assert.match(rule(".portal .portal-summary-secondary,"), /font-size:15px/);
  assert.match(rule(".portal .portal-summary-secondary,"), /line-height:1\.55/);
});

test("3d: values are one size and one leading on every route", () => {
  const value = rule(".portal .portal-summary-value,");
  assert.match(value, /font-weight:400/);
  assert.match(value, /font-size:15px/);
  assert.match(value, /line-height:1\.45/);
  assert.match(value, /color:var\(--ink\)/);
  for (const s of [".portal .order-list-row", ".portal .supply-list-row",
                   ".portal .b2b-pricing-cell", ".portal .b2b-term-row",
                   ".portal .portal-address-display p"]) {
    assert.ok(value.includes(s), `${s} is not on the shared value rule`);
  }
  // The figures carry the weight; the fields around them stay quiet.
  const strongAt = code.indexOf(".portal .order-list-number,");
  assert.notEqual(strongAt, -1, "the emphasised-value rule went away");
  const strong = code.slice(strongAt, code.indexOf("}", strongAt));
  assert.match(strong, /font-weight:600/);
  for (const s of [".portal .order-list-total", ".portal .b2b-pricing-value",
                   ".portal .b2b-pricing-label strong",
                   ".portal .portal-address-display p:first-child"]) {
    assert.ok(strong.includes(s), `${s} is not on the emphasised-value rule`);
  }
  assert.match(rule(".portal .b2b-term-key{"), /color:rgba\(17,17,17,\.6\)/);
  // The block above already put the profile rows on the same 15/1.45.
  assert.match(css, /\.portal-profile-row,\r?\n\.portal-fact\{[\s\S]*?font-size:15px;\r?\n\s*line-height:1\.45/);
});

test("3e: one body size for everything explanatory", () => {
  const body = rule(".portal .portal-summary-secondary,");
  assert.match(body, /font-weight:400/);
  assert.match(body, /font-size:15px/);
  assert.match(body, /line-height:1\.55/);
  assert.match(body, /color:rgba\(17,17,17,\.6\)/);
  for (const s of [".portal .b2b-section-lead", ".portal .b2b-pricing-note",
                   ".portal .b2b-model-desc", ".portal .b2b-model-discount",
                   ".portal .b2b-discount"]) {
    assert.ok(body.includes(s), `${s} is not on the shared body rule`);
  }
  // Exactly one line on a B2B page earns the blue.
  assert.match(rule(".portal .b2b-model-discount{"), /color:var\(--blue\)/);
});

test("3f: button-like labels read the button type, not a size of their own", () => {
  const tile = rule(".portal .portal-quicklink-label{");
  assert.match(tile, /font-weight:600/);
  assert.match(tile, /font-size:12px/);
  assert.match(tile, /letter-spacing:\.16em/);
  const badge = rule(".portal .order-list-tracking{");
  assert.match(badge, /font-weight:600/);
  assert.match(badge, /font-size:11px/);
  assert.match(badge, /letter-spacing:\.14em/);
  assert.match(rule(".portal .portal-badge{"), /letter-spacing:\.14em/);
  // No text action became a filled button in this pass.
  assert.ok(!/background/.test(code), "this block paints a background");
});

/* ══════════════════════════════════════════════════════════════
   4. THE BOUNDARY
   ══════════════════════════════════════════════════════════════ */

test("4: every rule is keyed on the portal", () => {
  for (const [, selector] of pairs()) {
    const sel = selector.split(/[\r\n]/).pop().trim();
    if (!sel || sel.startsWith("@")) continue;
    for (const part of sel.split(",")) {
      const s = part.trim();
      if (!s) continue;
      assert.ok(s.startsWith(".portal"), `a rule here is not keyed on the portal: ${s}`);
    }
  }
  assert.ok(!code.includes("!important"), "specificity was solved with !important");
});

test("4b: the public /b2b page keeps its own type", async () => {
  // It shares the `b2b-` prefix and nothing else. Its marketing
  // selectors may not appear here at all.
  for (const other of ["b2b-pricing-card", "b2b-pricing-grid", "b2b-pricing-price",
                       "b2b-pricing-desc", "b2b-pricing-details", "b2b-hero",
                       "brand-bar", "account-landing", "account-choose"]) {
    assert.ok(!code.includes(other), `this block reaches ${other}`);
  }
  // And no bare element selector, which is how a block reaches the site
  // chrome by accident. Every selector here starts with `.portal`.
  assert.ok(!/(^|[\s,])(header|footer|body|html|nav)[\s,{]/m.test(code),
    "this block reaches the chrome");
  const { status, html } = await server.getHtml("/for-cafes");
  assert.equal(status, 200, "the public B2B page stopped resolving");
  assert.ok(!html.includes('class="portal'), "the public B2B page is inside the portal shell");
  // Its own rules are still there, untouched, outside this block.
  assert.match(css, /\.b2b-pricing-card\{border:1px solid var\(--line\);padding:40px 30px/);
  assert.match(css, /\.b2b-pricing h2\{font-size:clamp\(48px,7vw,98px\)/);
});

test("4c: nothing here paints, and no card was introduced", () => {
  const allowed = /^(font-family|font-style|font-weight|font-size|line-height|letter-spacing|text-transform|opacity|color|margin|border-top-color|flex|padding-left)$/;
  const decls = [];
  for (const [, , body] of pairs()) {
    for (const d of body.split(";")) { const t = d.trim(); if (t) decls.push(t); }
  }
  assert.ok(decls.length > 60, `only ${decls.length} declarations were parsed`);
  for (const d of decls) {
    assert.match(d.split(":")[0].trim(), allowed, `an out-of-scope declaration: ${d}`);
  }
  assert.ok(!/box-shadow|border-radius|gradient|backdrop-filter/.test(code),
    "a shadow, radius or gradient was introduced");
  // NO PURE WHITE.
  assert.ok(!/#fff\b|#ffffff\b/i.test(code), "a white hex appeared");
  assert.ok(!/rgba?\(\s*255\s*,\s*255\s*,\s*255/.test(code), "a white rgb appeared");
  assert.ok(!/(background|color|border[a-z-]*)\s*:\s*white\b/i.test(code), "the white keyword appeared");
  // Every rgba in the block is a near-black tone; nothing else dims.
  for (const m of code.matchAll(/rgba\((\d+),(\d+),(\d+),/g)) {
    assert.equal(`${m[1]},${m[2]},${m[3]}`, "17,17,17", `an unexpected rgba: ${m[0]}`);
  }
  for (const m of code.matchAll(/opacity:([\d.]+)/g)) {
    assert.equal(m[1], "1", `this block fades something with opacity:${m[1]}`);
  }
});

test("4d: the three grey hairlines became the account's near-black one", () => {
  const lines = rule(".portal .portal-summary-row,");
  assert.match(lines, /border-top-color:rgba\(17,17,17,\.12\)/);
  for (const s of [".portal .portal-address-item", ".portal .b2b-term-row"]) {
    assert.ok(lines.includes(s), `${s} is not on the shared hairline rule`);
  }
});

/* ══════════════════════════════════════════════════════════════
   5. RESPONSIVE
   ══════════════════════════════════════════════════════════════ */

test("5: the nav keeps one tracking and its scroll at every width", () => {
  // The strip scrolls, so the tabs never have to be squeezed to fit -
  // which is what keeps B2B reachable on a phone.
  assert.match(css, /\.portal-nav\{[^}]*overflow-x:auto/);
  assert.match(css, /\.portal-nav a,\r?\n\.portal-logout\{[\s\S]*?letter-spacing:\.16em/);
  const mobile = css.slice(css.indexOf("THE AUTHENTICATED ACCOUNT"));
  const at800 = mobile.slice(mobile.indexOf("@media (max-width:800px)"));
  assert.match(at800, /\.portal-nav a,\r?\n\s*\.portal-logout\{font-size:11px\}/);
  assert.ok(!/\.portal-logout\{font-size:11px;letter-spacing/.test(at800),
    "the nav still compresses its tracking on mobile");
});

test("5b: a stacked summary row gives its copy the column, not the action", () => {
  const at800 = code.slice(code.indexOf("@media (max-width:800px)"));
  // The value already dropped to a full-width line; the action did not,
  // which left the delivery copy in a ~68px column on a 375px phone.
  assert.match(at800, /\.portal \.portal-summary-row>\.portal-action\{flex:1 0 100%;padding-left:58px\}/);
  assert.match(css, /\.portal-summary-value\{width:100%;padding-left:58px\}/,
    "the value's own full-width rule went away");
  // Only sizes and that one wrap change on mobile.
  assert.match(at800, /\.portal \.portal-summary-primary\{font-size:17px\}/);
  assert.ok(!/font-family|font-weight|letter-spacing|text-transform/.test(at800),
    "mobile changes more than size and wrapping");
});
