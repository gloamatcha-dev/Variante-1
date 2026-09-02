import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startRenderServer } from "./helpers/renderServer.mjs";

/**
 * /account, view === "choose" — THE ACCOUNT TYPE SELECTION.
 *
 * A TYPOGRAPHY pass only, so this file is written as a boundary test.
 * Two boundaries matter:
 *
 *   1. `.account-page`, `.account-section h1` and `.eyebrow` are shared
 *      by nine account views and by most of the site. Every rule in the
 *      block must be keyed on `.account-choose`.
 *   2. Nothing in the block may be a colour, a box or a position - the
 *      cream page, the blue and raspberry panels, the grid and both
 *      button boxes are frozen.
 *
 * The chooser is client state (its useState initialiser reads
 * window.location), so it does not server-render; the source slice is
 * the honest subject here, and the rendered assertions cover what this
 * pass must NOT have moved.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf8");

const site = read("app/GloaSite.tsx");
const css = read("app/globals.css");

/** The chooser return, from its `<main>` to the end of that statement. */
const chooseAt = site.indexOf('if(view==="choose")return <main className="account-page">');
assert.notEqual(chooseAt, -1, "the chooser return was not found");
const choose = site.slice(chooseAt, site.indexOf("</section></main>;", chooseAt));
assert.ok(choose.length > 400, "the chooser return is suspiciously short");

const blockAt = css.indexOf("/account — THE ACCOUNT TYPE SELECTION");
assert.notEqual(blockAt, -1, "the CSS block was not found");
const startAt = css.lastIndexOf("/*", blockAt);
const nextAt = css.indexOf("/* ══════", blockAt + 10);
const rules = css.slice(startAt, nextAt === -1 ? css.length : nextAt);
const code = rules.replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * Selector + body pairs. `[^{}]*` for the body rather than `[^}]*` is
 * what makes this skip an `@media` wrapper instead of swallowing it.
 */
const pairs = () => [...code.matchAll(/([^{}]+)\{([^{}]*)\}/g)];

const rule = name => {
  const at = code.indexOf(name);
  assert.notEqual(at, -1, `missing rule: ${name}`);
  return code.slice(at, code.indexOf("}", at));
};

const PORT = 8941;
let server;
test.before(async () => { server = await startRenderServer(PORT); });
test.after(() => server?.stop());

/* ══════════════════════════════════════════════════════════════
   1. BOTH OPTIONS, THE EXACT COPY, THE EXACT HANDLERS
   ══════════════════════════════════════════════════════════════ */

test("1: both account types still render, with the words they had", () => {
  for (const copy of ["KONTO ERSTELLEN", "Wie möchtest du", "<i>GLOA nutzen?</i>",
                      "PRIVATKUNDE", "Matcha für<br/>deinen Alltag.",
                      "Bestellen, Abos verwalten und Rezepte speichern.",
                      "GESCHÄFTSKUNDE", "Matcha für<br/>dein Business.",
                      "Großhandel, Samples und individuelle Konditionen."]) {
    assert.ok(choose.includes(copy), `missing copy: ${copy}`);
  }
  // Uppercase on the buttons is CSS; the source keeps its sentence case.
  assert.ok(choose.includes(">Privatkonto erstellen</button>"), "the private CTA was rewritten");
  assert.ok(choose.includes(">Geschäftskonto erstellen</button>"), "the business CTA was rewritten");
  assert.match(rule(".account-choose .account-type-cta{"), /text-transform:uppercase/);
  // Exactly two panels, exactly two calls to action.
  assert.equal((choose.match(/account-type-card/g) || []).length, 2, "there are not exactly two panels");
  assert.equal((choose.match(/account-type-cta/g) || []).length, 2, "there are not exactly two CTAs");
});

test("1b: both CTAs still invoke exactly the flows they did", () => {
  assert.ok(choose.includes('<button className="cta account-type-cta" onClick={()=>{setView("register");setPwError("")}}>Privatkonto erstellen</button>'),
    "the private account flow changed");
  assert.ok(choose.includes('<button className="cta account-type-cta" onClick={()=>{setView("b2b-apply");setPwError("")}}>Geschäftskonto erstellen</button>'),
    "the business account flow changed");
  // Still buttons, not links - no destination was invented, and the
  // back control still returns to the landing.
  assert.ok(!choose.includes("<Link") && !/href=/.test(choose), "an action became a navigation");
  assert.ok(choose.includes('<button className="account-back" onClick={()=>setView("landing")}>'),
    "the back control changed");
  // And both destinations still exist and still sign up the way they did.
  assert.match(site, /if\(view==="register"\)return <main className="account-page">/);
  assert.match(site, /if\(view==="b2b-apply"\)return <main className="account-page">/);
  assert.match(site, /data:\{customer_type:"private"/);
  assert.match(site, /data:\{customer_type:"business"/);
  assert.match(site, /if\(p\.get\("action"\)==="register"\)return "choose"/);
});

test("1c: no backend, auth or database was touched", () => {
  for (const kept of ["supabase.auth.signUp", "browserAuthRedirectUrl(AUTH_CONFIRM_PATH)",
                      "const { user, loading: authLoading } = useAuth();"]) {
    assert.ok(site.includes(kept), `auth code changed: ${kept}`);
  }
  assert.deepEqual(readdirSync(path.join(ROOT, "app/api")).sort(),
    ["annual-plan", "checkout", "contact", "cron", "internal", "orders",
     "stripe", "subscriptions", "withdrawal"], "an API route changed");
  assert.ok(!readdirSync(path.join(ROOT, "supabase/migrations")).some(f => f.startsWith("043")),
    "migration 043 exists");
});

/* ══════════════════════════════════════════════════════════════
   2. THE HEADLINE — INTER 800 OVER REAL INTER ITALIC 400
   ══════════════════════════════════════════════════════════════ */

test("2: the primary line is Inter 800 at the functional-page scale", () => {
  const h1 = rule(".account-choose.account-section h1{");
  assert.match(h1, /font-family:var\(--font-sans\),Arial,sans-serif/);
  assert.match(h1, /font-style:normal/);
  assert.match(h1, /font-weight:800/);
  assert.match(h1, /font-size:clamp\(42px,4\.2vw,64px\)/);
  assert.match(h1, /line-height:\.94/);
  assert.match(h1, /letter-spacing:-\.045em/);
  // It relies on the shared rule for its margins, so the block did not move.
  assert.ok(!/margin/.test(h1), "the headline redeclared its margins");
  assert.match(css, /\.account-section h1\{font-size:clamp\(32px,4\.5vw,48px\);line-height:1\.1;margin:12px 0 28px\}/,
    "the shared account h1 rule changed");
});

test("2b: the second line is REAL Inter Italic, never Cormorant", () => {
  const i = rule(".account-choose.account-section h1 i{");
  assert.match(i, /font-family:var\(--font-sans\),Arial,sans-serif/);
  assert.match(i, /font-style:italic/);
  assert.match(i, /font-weight:400/);
  assert.match(i, /font-size:clamp\(38px,3\.9vw,58px\)/);
  assert.match(i, /line-height:\.98/);
  assert.match(i, /letter-spacing:-\.04em/);
  assert.match(i, /font-synthesis:none/);
  // The display face and every serif fallback are absent from the block.
  assert.ok(!code.includes("--font-display"), "Cormorant reached the chooser");
  assert.ok(!/Georgia|Times|Cormorant|serif(?!-)/.test(code.replace(/sans-serif/g, "")),
    "a serif reached the chooser");
  // The two global italic rules it overrides are still there for the
  // rest of the site, which is why this override has to be (0,2,2).
  assert.match(css, /h1 i,h2 i,h3 i,\.display-italic\{font-family:var\(--font-display\),Georgia,serif/);
  assert.match(css, /h1 i,h2 i\{font-size:1\.06em;line-height:\.98\}/);
  // A real italic face is loaded, so font-synthesis:none is safe.
  assert.match(read("app/layout.tsx"), /style: \["normal", "italic"\]/);
});

test("2c: this is capped below the landing, which is capped below a hero", () => {
  const at = (lo, vw, hi, w) => Math.max(lo, Math.min(vw / 100 * w, hi));
  for (const w of [320, 375, 390, 430, 768, 900, 901, 1024, 1280, 1440, 1680, 1920]) {
    const choice  = w <= 900 ? at(38, 10, 52, w) : at(42, 4.2, 64, w);
    const landing = w <= 900 ? at(42, 11.5, 58, w) : at(48, 5.2, 84, w);
    assert.ok(choice <= landing, `the chooser (${choice}) passed the landing (${landing}) at ${w}px`);
    assert.ok(choice <= 64, `the chooser reached ${choice}px at ${w}px`);
  }
  assert.ok(!code.includes("--type-hero-primary") && !code.includes("--type-hero-secondary"),
    "the chooser reads the shared hero tokens");
  assert.ok(!choose.includes("gloa-hero-"), "the chooser took the shared page hero classes");
});

/* ══════════════════════════════════════════════════════════════
   3. ONE TYPE SYSTEM ACROSS BOTH PANELS
   ══════════════════════════════════════════════════════════════ */

test("3: label, title, body and button are each ONE rule for both panels", () => {
  // The strongest guarantee that blue and raspberry cannot drift apart
  // is that neither carries typography of its own anywhere in the file.
  // Comments are stripped first, or the prose naming those two selectors
  // in the block above would be read as a rule.
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of bare.matchAll(/\.account-type-(private|business)[^{]*\{([^}]*)\}/g)) {
    assert.ok(!/font|letter-spacing|text-transform|line-height/.test(m[2]),
      `a panel styles its own type: ${m[0]}`);
  }
  // And that no selector in the block names one panel: every rule here
  // is keyed on `.account-type-card`, which both of them carry.
  for (const [, selector] of pairs()) {
    const sel = selector.split(/[\r\n]/).pop().trim();
    assert.ok(!/account-type-(private|business)/.test(sel),
      `a rule here reaches one panel only: ${sel}`);
  }
  // The four shared rules, once each outside the media queries.
  const base = code.slice(0, code.indexOf("@media"));
  for (const sel of [".account-type-card .eyebrow{", ".account-type-card h2{",
                     ".account-type-card p:not(.eyebrow){", ".account-type-cta{"]) {
    assert.equal((base.split(sel).length - 1), 1, `not exactly one rule for ${sel}`);
  }
});

test("3b: the panel labels", () => {
  const label = rule(".account-choose .account-type-card .eyebrow{");
  assert.match(label, /font-family:var\(--font-sans\),Arial,sans-serif/);
  assert.match(label, /font-weight:600/);
  assert.match(label, /font-size:11px/);
  assert.match(label, /line-height:1\.2/);
  assert.match(label, /letter-spacing:\.18em/);
  assert.match(label, /text-transform:uppercase/);
  // Their cream stays where it was, outside this block.
  assert.match(css, /\.account-type-private \.eyebrow\{color:var\(--cream\)\}/);
  assert.match(css, /\.account-type-business \.eyebrow\{color:var\(--cream\)\}/);
});

test("3c: the panel titles", () => {
  const title = rule(".account-choose .account-type-card h2{");
  assert.match(title, /font-family:var\(--font-sans\),Arial,sans-serif/);
  assert.match(title, /font-style:normal/);
  assert.match(title, /font-weight:600/);
  assert.match(title, /font-size:clamp\(26px,2vw,32px\)/);
  assert.match(title, /line-height:1\.08/);
  assert.match(title, /letter-spacing:-\.025em/);
  // Subordinate to the page headline at every width.
  const at = (lo, vw, hi, w) => Math.max(lo, Math.min(vw / 100 * w, hi));
  for (const w of [375, 430, 768, 800, 801, 900, 901, 1280, 1440, 1680, 1920]) {
    const t = w <= 800 ? at(24, 7, 28, w) : at(26, 2, 32, w);
    const h = w <= 900 ? at(38, 10, 52, w) : at(42, 4.2, 64, w);
    assert.ok(t < h, `the panel title (${t}) is not below the headline (${h}) at ${w}px`);
  }
});

test("3d: the panel body copy", () => {
  const body = rule(".account-choose .account-type-card p:not(.eyebrow){");
  assert.match(body, /font-family:var\(--font-sans\),Arial,sans-serif/);
  assert.match(body, /font-weight:400/);
  assert.match(body, /font-size:16px/);
  assert.match(body, /line-height:1\.5/);
  assert.match(body, /letter-spacing:0/);
  // `:not(.eyebrow)` is what keeps the label out of the body rule - the
  // label is a `<p>` in this panel too. The shared rule keeps flex:1,
  // because that is layout and layout is frozen here.
  assert.match(css, /\.account-type-card p\{font-size:15px;line-height:1\.5;opacity:\.8;flex:1\}/,
    "the shared panel paragraph rule changed");
});

test("3e: the two CTAs, same type despite the longer German label", () => {
  const cta = rule(".account-choose .account-type-cta{");
  assert.match(cta, /font-family:var\(--font-sans\),Arial,sans-serif/);
  assert.match(cta, /font-weight:600/);
  assert.match(cta, /font-size:11px/);
  assert.match(cta, /line-height:1\.2/);
  assert.match(cta, /letter-spacing:\.14em/);
  assert.match(cta, /text-transform:uppercase/);
  // The button box itself is untouched: same paint, same padding.
  assert.match(css, /\.account-type-cta\{background:var\(--cream\)!important;color:var\(--plum\)!important;border:0;text-align:center;display:block;[^}]*padding:16px 24px/,
    "the CTA box changed");
  // GESCHÄFTSKONTO is the longest word on the screen. At 11px with
  // .14em tracking, uppercase Inter 600 runs roughly .70em per
  // character, and it has to fit a panel's text column at the
  // narrowest two-column width: a 270px card less 64px of padding.
  const width = 14 * 11 * (0.70 + 0.14);
  assert.ok(width < 206, `"GESCHÄFTSKONTO" (~${Math.round(width)}px) does not fit 206px`);
});

/* ══════════════════════════════════════════════════════════════
   4. THE PAGE HEAD
   ══════════════════════════════════════════════════════════════ */

test("4: the back link and the page eyebrow", () => {
  const back = rule(".account-choose .account-back{");
  assert.match(back, /font-weight:600/);
  assert.match(back, /font-size:11px/);
  assert.match(back, /line-height:1\.2/);
  assert.match(back, /letter-spacing:\.16em/);
  assert.match(back, /text-transform:uppercase/);
  assert.ok(!/color/.test(back), "the back link changed colour");

  const eyebrow = rule(".account-choose>.eyebrow{");
  assert.match(eyebrow, /font-weight:600/);
  assert.match(eyebrow, /font-size:11px/);
  assert.match(eyebrow, /line-height:1\.2/);
  assert.match(eyebrow, /letter-spacing:\.2em/);
  assert.match(eyebrow, /text-transform:uppercase/);
  assert.ok(!/color/.test(eyebrow), "the page eyebrow changed colour");
  // The child combinator is what keeps the two panel labels out of it.
  assert.ok(!code.includes(".account-choose .eyebrow{"), "the page eyebrow rule reaches the panels");
});

/* ══════════════════════════════════════════════════════════════
   5. THE BOUNDARY — TYPOGRAPHY ONLY, CHOOSER ONLY
   ══════════════════════════════════════════════════════════════ */

test("5: every declaration in the block is typography", () => {
  const allowed = /^(font-family|font-style|font-weight|font-size|font-synthesis|line-height|letter-spacing|text-transform)$/;
  const decls = [];
  for (const [, , body] of pairs()) {
    for (const d of body.split(";")) { const t = d.trim(); if (t) decls.push(t); }
  }
  assert.ok(decls.length > 40, `only ${decls.length} declarations were parsed`);
  for (const d of decls) {
    assert.match(d.split(":")[0].trim(), allowed, `a non-typography declaration: ${d}`);
  }
  // Which means no colour, no box, no position, by construction. The
  // colour scan covers the values as well as the property names.
  const values = decls.join(" ");
  assert.ok(!/#[0-9a-f]{3,6}|rgba?\(|var\(--(blue|berry|cream|plum|ink|line)\)/i.test(values),
    "a colour appeared in a typography pass");
  assert.ok(!code.includes("!important"), "specificity was solved with !important");
});

test("5b: every rule is keyed on the chooser", () => {
  for (const [, selector] of pairs()) {
    const sel = selector.split(/[\r\n]/).pop().trim();
    if (!sel || sel.startsWith("@")) continue;
    for (const part of sel.split(",")) {
      const s = part.trim();
      if (!s) continue;
      assert.ok(s.startsWith(".account-choose"), `a rule here is not keyed on the chooser: ${s}`);
    }
  }
  // The hook is on the section, not the main - so the `<main>` of every
  // account view, this one included, is still a plain `.account-page`.
  assert.equal((site.match(/account-section account-choose/g) || []).length, 1,
    "the chooser hook is on more than one view");
  assert.ok(choose.includes('return <main className="account-page"><section className="account-section account-choose">'),
    "the chooser wrapper changed shape");
  assert.ok(!site.includes("account-choose-page"), "a page-level hook was introduced");
});

test("5c: the other account views and the portal keep their type", async () => {
  const branches = [...site.matchAll(/return <main className="account-page([^"]*)"/g)].map(m => m[1].trim());
  assert.ok(branches.length >= 9, `only ${branches.length} account views were found`);
  assert.equal(branches.filter(b => b.includes("account-landing-page")).length, 1,
    "more than one account view carries the landing class");

  for (const route of ["/account", "/account/reset-password", "/auth/confirm"]) {
    const { status, html } = await server.getHtml(route);
    assert.equal(status, 200, `${route} stopped resolving`);
    assert.ok(!html.includes("account-choose"), `${route} picked up the chooser hook`);
  }
  // The signed-out landing headline this pass must not have touched.
  const { html } = await server.getHtml("/account");
  assert.ok(html.includes("Dein GLOA.") && html.includes("An einem Ort."),
    "the landing headline changed");
  assert.match(css, /\.account-landing-line\{[\s\S]*?font-size:clamp\(48px,5\.2vw,84px\)/,
    "the landing headline scale moved");

  for (const route of ["/account/dashboard", "/account/orders", "/account/subscriptions"]) {
    const { status, html: h } = await server.getHtml(route);
    assert.equal(status, 200, `${route} stopped resolving`);
    assert.ok(h.includes('<main class="portal"'), `${route} is not the portal any more`);
    assert.ok(!h.includes("account-choose"), `${route} picked up the chooser hook`);
  }
});

test("5d: no other selector, page or piece of chrome is reached", () => {
  for (const other of ["portal-", "account-form", "account-lead", "account-register",
                       "account-b2b", "account-landing", "account-forgot",
                       "header", "footer", "brand-bar", "hero-copy", "shop-hero"]) {
    assert.ok(!code.includes(other), `this block reaches ${other}`);
  }
  // The page, panel and grid paint is all still outside this block.
  assert.match(css, /\.account-type-private\{background:var\(--blue\);color:var\(--cream\)\}/);
  assert.match(css, /\.account-type-business\{background:var\(--berry\);color:var\(--cream\)\}/);
  assert.match(css, /\.account-type-grid\{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-top:8px\}/);
  assert.match(css, /\.account-type-card\{padding:40px 32px;display:flex;flex-direction:column;gap:16px\}/);
  assert.match(css, /\.account-page\{min-height:70vh;display:flex;align-items:center;justify-content:center;padding:80px 5vw\}/);
  assert.match(css, /\.account-section\{max-width:560px;width:100%\}/);
  assert.match(css, /--blue:#1746D1/);
  assert.match(css, /--berry:#A61E59/);
  assert.match(css, /--cream:#F5EBE2/);
});

/* ══════════════════════════════════════════════════════════════
   6. RESPONSIVE
   ══════════════════════════════════════════════════════════════ */

test("6: one step down at 900, panel titles at 800, size only", () => {
  const at900 = code.slice(code.indexOf("@media (max-width:900px)"), code.indexOf("@media (max-width:800px)"));
  const at800 = code.slice(code.indexOf("@media (max-width:800px)"));
  assert.match(at900, /\.account-choose\.account-section h1\{font-size:clamp\(38px,10vw,52px\)\}/);
  assert.match(at900, /\.account-choose\.account-section h1 i\{font-size:clamp\(34px,9vw,46px\)\}/);
  assert.match(at800, /\.account-choose \.account-type-card h2\{font-size:clamp\(24px,7vw,28px\)\}/);
  for (const q of [at900, at800]) {
    assert.ok(!/font-weight|font-family|font-style|line-height|letter-spacing/.test(q),
      "mobile changes more than the size");
  }
  // 800px is the existing one-column breakpoint, so the panel titles
  // step down exactly when a panel gains the full rail.
  assert.match(css, /\.account-type-grid\{grid-template-columns:1fr\}/, "the one-column breakpoint moved");

  // The headline fits the 560px rail at every checked width.
  const at = (lo, vw, hi, w) => Math.max(lo, Math.min(vw / 100 * w, hi));
  for (const w of [375, 390, 430, 768, 900, 1024, 1280, 1440, 1680]) {
    const size = w <= 900 ? at(38, 10, 52, w) : at(42, 4.2, 64, w);
    const rail = Math.min(560, w - 2 * (w * 0.05));
    // "Wie möchtest du" is 15 characters; Inter 800 at -.045em runs
    // roughly .52em per character.
    assert.ok(size * 0.52 * 15 < rail + 1,
      `"Wie möchtest du" (${Math.round(size * 0.52 * 15)}px) overflows ${Math.round(rail)}px at ${w}px`);
  }
});
