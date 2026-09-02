import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startRenderServer } from "./helpers/renderServer.mjs";

/**
 * /rezepte — THE LISTING PAGE, ON THE GLOA SYSTEM.
 *
 * The page was the last one still built out of the pre-system rules: a
 * plain cream header, filters bordered in plum whose active state was
 * set in LITERAL WHITE, a grid on its own 5vw gutter rather than the
 * canonical rail, and the shared <BrandNote/> as its ending.
 *
 * Two things these tests guard hardest:
 *   * the RECIPE DETAIL PAGE is untouched, and
 *   * <BrandNote/> still closes the HOMEPAGE, unchanged.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf8");

const site = read("app/GloaSite.tsx");
const css = read("app/globals.css");

const page = site.slice(site.indexOf("function Rezepte(){"), site.indexOf("\nfunction RezeptDetail("));
assert.ok(page.length > 1500, "the Rezepte listing component was not found");
const community = site.slice(site.indexOf("function RezepteCommunity(){"), site.indexOf("\nfunction RezeptDetail("));
assert.ok(community.length > 500, "the community component was not found");

/** The CSS block, bounded at the next banner. */
const blockAt = css.indexOf("/rezepte — THE LISTING PAGE");
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
/** clamp() evaluated at a width, the way the browser does it. */
const at = (t, w) => {
  const [lo, vw, hi] = /clamp\(([\d.]+)px,([\d.]+)vw,([\d.]+)px\)/.exec(t).slice(1).map(Number);
  return Math.max(lo, Math.min((vw / 100) * w, hi));
};

const PORT = 8935;
let server, html;
test.before(async () => {
  server = await startRenderServer(PORT);
  const res = await server.getHtml("/rezepte");
  assert.equal(res.status, 200);
  html = res.html;
});
test.after(() => server?.stop());

/* ══════════════════════════════════════════════════════════════
   1. THE COLOUR RHYTHM
   ══════════════════════════════════════════════════════════════ */

test("1: raspberry, cream, cream, blue - and then the existing footer", () => {
  const bands = [[".rezepte-hero{", "var(--berry)", "var(--cream)"],
                 [".rezepte-filters{", "var(--cream)", "var(--ink)"],
                 [".rezepte-grid{", "var(--cream)", "var(--ink)"],
                 [".rz-community{", "var(--blue)", "var(--cream)"]];
  for (const [sel, bg, fg] of bands) {
    const r = rule(sel);
    assert.ok(r.includes(`background:${bg}`), `${sel} is not on ${bg}`);
    assert.ok(r.includes(`color:${fg}`), `${sel} does not write in ${fg}`);
  }
  // In source order, so the page reads hero -> filters -> grid -> blue.
  const order = ["rezepte-hero", "rezepte-filters", "rezepte-grid", "rz-community"];
  assert.deepEqual([...html.matchAll(/<section class="(rezepte-hero|rezepte-filters|rezepte-grid|rz-community)"/g)].map(m => m[1]), order);
  // No band paints itself anything else.
  for (const m of code.matchAll(/background:([^;}]+)/g)) {
    assert.ok(/^(var\(--(blue|berry|cream|ink)\)|transparent|rgba\(17,17,17,\.06\))$/.test(m[1].trim()),
      `a background outside the palette: ${m[1]}`);
  }
  // PLUM IS GONE FROM THIS PAGE. It used to paint the active filter.
  assert.ok(!code.includes("--plum"), "plum came back to /rezepte");
});

test("1b: NO PURE WHITE, in any form", () => {
  for (const src of [code, page]) {
    assert.ok(!/#fff\b|#ffffff\b/i.test(src), "a white hex appeared");
    assert.ok(!/rgba?\(\s*255\s*,\s*255\s*,\s*255/.test(src), "a white rgb appeared");
    assert.ok(!/(background|color|border[a-z-]*|outline[a-z-]*|fill|stroke)\s*:\s*white\b/i.test(src),
      "the white keyword appeared");
  }
  // Every light value is cream, or an rgba derived from cream.
  for (const m of code.matchAll(/rgba\((\d+),\s*(\d+),\s*(\d+),[^)]*\)/g)) {
    const rgb = `${m[1]},${m[2]},${m[3]}`;
    assert.ok(rgb === "245,235,226" || rgb === "17,17,17", `an rgba outside cream and near black: ${m[0]}`);
  }
  // And the literal `color:white` this pass retired is gone for good.
  assert.ok(!css.includes(".rezepte-filters button.active{background:var(--plum);color:white"),
    "the white active filter is back");
});

/* ══════════════════════════════════════════════════════════════
   2. THE HERO
   ══════════════════════════════════════════════════════════════ */

test("2: the hero is the canonical homepage hero scale, on raspberry", () => {
  assert.ok(page.includes('<p className="eyebrow rezepte-hero-eyebrow gloa-hero-eyebrow">GLOA · REZEPTE</p>'));
  assert.ok(page.includes('<span className="rezepte-hero-line gloa-hero-primary">Matcha Rezepte.</span>'));
  assert.ok(page.includes('<i className="rezepte-hero-line rezepte-hero-line-accent gloa-hero-secondary">GLOA Edition.</i>'));
  // The route's own rules carry colour and spacing, never type.
  for (const sel of [".rezepte-hero-line{", ".rezepte-hero-line-accent{"]) {
    assert.ok(!/font-family|font-size|font-weight|font-style|line-height|letter-spacing/.test(rule(sel)),
      `${sel} sets hero typography of its own`);
  }
  // Cream on raspberry, and the eyebrow at the same muted cream /about uses.
  assert.match(rule(".rezepte-hero-line{"), /color:var\(--cream\)/);
  assert.match(rule(".rezepte-hero .rezepte-hero-eyebrow{"), /color:rgba\(245,235,226,\.72\)/);
  // Two stacked lines, on the canonical rail, with the lead below.
  assert.match(rule(".rezepte-hero-headline{"), /flex-direction:column/);
  assert.ok(page.includes('<div className="rezepte-hero-inner home-rail">'), "the hero is off the shared rail");
  assert.match(rule(".rezepte-hero{"), /padding-inline:var\(--rail-gutter\)/);
  assert.ok(html.includes("Signature Drinks. Einfach, visuell stark und passend zur GLOA-Welt."));
  // Exactly one h1 on the page, and it is the hero.
  assert.equal((html.match(/<h1/g) || []).length, 1);
});

/* ══════════════════════════════════════════════════════════════
   3. THE FILTERS
   ══════════════════════════════════════════════════════════════ */

test("3: the active filter is raspberry with a cream label", () => {
  const active = rule(".rezepte-filters button.active{");
  assert.match(active, /background:var\(--berry\)/);
  assert.match(active, /color:var\(--cream\)/);
  assert.match(active, /border-color:var\(--berry\)/);
  // Idle: cream ground, near black label, one hairline.
  const idle = rule(".rezepte-filters button{");
  assert.match(idle, /background:var\(--cream\)/);
  assert.match(idle, /color:var\(--ink\)/);
  assert.match(idle, /border:1px solid rgba\(17,17,17,\.28\)/);
  assert.match(idle, /border-radius:0/);
  assert.match(idle, /box-shadow:none/);
  assert.match(idle, /min-height:44px/);
  assert.match(idle, /text-transform:uppercase/);
  // One exact rule across all four, at the contract's figures.
  assert.match(idle, /font-family:var\(--font-sans\),Arial,sans-serif/);
  assert.match(idle, /font-weight:600/);
  assert.match(idle, /font-size:12px/);
  assert.match(idle, /line-height:1\.2/);
  assert.match(idle, /letter-spacing:\.15em/);
  // The four share one selector, so none of them can drift alone.
  assert.equal((code.match(/\.rezepte-filters button\{/g) || []).length, 2,
    "the filters are styled by more than a base rule and one override");
  // Hover moves to raspberry rather than to a fill.
  assert.match(rule(".rezepte-filters button:hover{"), /border-color:var\(--berry\);color:var\(--berry\)/);
  // The four categories still render, and the state is announced.
  for (const t of ["ALLE", "LATTE", "ICED", "FRUITY"]) assert.ok(html.includes(`>${t}</button>`), `missing filter: ${t}`);
  assert.match(page, /aria-pressed=\{filter===t\}/);
  assert.match(page, /type="button"/);
});

/* ══════════════════════════════════════════════════════════════
   4. THE CARDS
   ══════════════════════════════════════════════════════════════ */

test("4: the cards are the homepage's recipe card, given room", () => {
  // META: near black, 11px, 1.2, .16em, uppercase. Raspberry stays the
  // accent where selection happens - the active filter and the CTA hover.
  const meta = rule(".rezept-card-meta{");
  assert.match(meta, /font-weight:600/);
  assert.match(meta, /font-size:var\(--type-meta\)/);
  assert.match(meta, /line-height:1\.2/);
  assert.match(meta, /letter-spacing:\.16em/);
  assert.match(meta, /text-transform:uppercase/);
  assert.match(meta, /color:var\(--ink\)/);
  // TITLE: real weight on an image-led listing, and one exact rule.
  const title = rule(".rezept-card-body h2{");
  assert.match(title, /font-weight:600/);
  assert.match(title, /font-size:clamp\(22px,1\.8vw,28px\)/);
  assert.match(title, /line-height:1\.12/);
  assert.match(title, /letter-spacing:-\.025em/);
  assert.match(title, /color:var\(--ink\)/);
  // DESCRIPTION and CTA, also one rule each.
  const excerpt = rule(".rezept-card-excerpt{");
  assert.match(excerpt, /font-weight:400/);
  assert.match(excerpt, /font-size:clamp\(15px,1\.1vw,16px\)/);
  assert.match(excerpt, /line-height:1\.5/);
  const cta = rule(".rezept-card-cta{");
  assert.match(cta, /font-weight:600/);
  assert.match(cta, /font-size:var\(--type-meta\)/);
  assert.match(cta, /line-height:1\.2/);
  assert.match(cta, /letter-spacing:\.12em/);
  assert.match(cta, /text-transform:uppercase/);
  assert.match(cta, /color:var\(--ink\)/);
  // Meta, title, excerpt, CTA - in that order, from the recipe data.
  assert.match(page, /<p className="rezept-card-meta">\{r\.category\} · \{r\.time\}<\/p><h2>\{r\.title\}<\/h2>/);
  assert.ok(page.includes('<p className="rezept-card-excerpt">{r.excerpt}</p>'));
  assert.ok(page.includes('Rezept ansehen <span aria-hidden="true">→</span>'));
  // React writes a <!-- --> separator between adjacent interpolations, so
  // the raw HTML is REZEPT<!-- --> · <!-- -->5 MIN. The TEXT is compared.
  const text = html.replace(/<!-- -->/g, "");
  assert.ok(text.includes("REZEPT · 5 MIN") && text.includes("REZEPT · 4 MIN"),
    "the meta line does not render");
  // The CTA underline is raspberry, and the whole card is one link.
  assert.match(rule(".rezept-card-cta{"), /text-decoration-color:var\(--berry\)/);
  assert.match(rule(".rezept-card a{"), /text-decoration:none/);
  // A RECIPE TITLE IS NEVER A SECTION HEADLINE. It has to stay well
  // under the page hero at every width - the contract bans 36-48px.
  for (const w of [320, 375, 390, 430, 768, 900, 901, 1280, 1440, 1680, 1920]) {
    const t = at("clamp(22px,1.8vw,28px)", w);
    const hero = w <= 900 ? at("clamp(44px,12vw,64px)", w) : at("clamp(54px,5.9vw,100px)", w);
    assert.ok(t <= 28, `the recipe title reached ${t}px at ${w}px`);
    assert.ok(t < hero * 0.7, `the recipe title (${t}) is not subordinate to the hero (${hero}) at ${w}px`);
  }
  // No card is a panel: no fill, no radius, no shadow anywhere here.
  assert.ok(!/box-shadow:(?!none)/.test(code), "a shadow was introduced");
  assert.ok(!/border-radius:(?!0)/.test(code), "a rounded container was introduced");
  assert.ok(!/gradient|backdrop-filter|\bfilter:/.test(code), "a gradient or filter was introduced");
});

test("4b: the burned-in watermark on the two square photos is framed out", () => {
  // Four of the six sources are 1122x1402 - exactly the 4:5 of the frame,
  // so they are shown whole. The other two are the 1254x1254 squares the
  // homepage also uses, and both carry a "PLACEHOLDER - NAME" mark in the
  // top 6.4% of the pixels.
  assert.match(rule(".rezept-card-img{"), /aspect-ratio:4 \/ 5/);
  assert.match(rule(".rezept-card-img img{"), /object-fit:cover/);
  // cover fits a SQUARE into a PORTRAIT frame by matching the height, so
  // it crops horizontally and object-position cannot reach the mark.
  // These two are pinned to the bottom and over-scaled instead.
  const fix = code.slice(code.indexOf('.rezept-card-img img[src$="gloa-morning.jpg"]'));
  const body = fix.slice(fix.indexOf("{"), fix.indexOf("}"));
  assert.ok(fix.includes('.rezept-card-img img[src$="gloa-iced.jpg"]'), "the second square is not covered");
  assert.match(body, /bottom:0/);
  assert.match(body, /top:auto/);
  const over = Number(/height:(\d+)%/.exec(body)[1]);
  // The hidden band is (over-100)/over of the source height, and it has
  // to clear the mark's 6.4% with real margin.
  const hidden = (over - 100) / over;
  assert.ok(hidden > 0.09, `only ${(hidden * 100).toFixed(1)}% of the top is cropped; the mark needs 6.4%`);
  // The files themselves are untouched.
  assert.match(css, /Nothing is written to the files/);
});

/* ══════════════════════════════════════════════════════════════
   5. THE COMMUNITY BAND
   ══════════════════════════════════════════════════════════════ */

test("5: the page closes on a community ask, not a newsletter", () => {
  for (const copy of ["YOUR TURN", "Jetzt bist du dran.", "Mix something good.",
                      "Strawberry, Coconut, Espresso oder etwas, auf das wir noch nicht gekommen sind.",
                      "Mix deinen GLOA Drink, teile ihn mit uns und markiere @gloa.matcha.",
                      "DEIN REZEPT TEILEN", "@GLOA.MATCHA", "@gloa.matcha"]) {
    assert.ok(html.includes(copy), `missing community copy: ${copy}`);
  }
  // The retired newsletter framing is not on this page any more.
  for (const gone of ["KEIN NEWSLETTER-LÄRM", "Wir melden uns nicht.", "Keine Rabattschreie"]) {
    assert.ok(!html.includes(gone), `the newsletter band is still on /rezepte: ${gone}`);
  }
  assert.ok(!/newsletter/i.test(html.replace(/<script[\s\S]*?<\/script>/g, "")), "a newsletter string survived");
  // THE CONTRACTED STRINGS, EXACTLY, INCLUDING THEIR ARROWS.
  assert.ok(html.includes("DEIN REZEPT TEILEN "), "the primary CTA label is not the contracted string");
  assert.ok(html.includes("↗"), "the external link has no outward arrow");

  // THERE IS NO RECIPE-SUBMISSION CHANNEL IN THIS REPOSITORY, so the
  // primary CTA cannot promise one. Both actions go to the one real
  // destination the copy already names, read from BRAND rather than
  // typed out, so they can never drift from the rest of the site.
  assert.equal((community.match(/https:\/\/instagram\.com\/\$\{BRAND\.instagram\}/g) || []).length, 2,
    "an action points somewhere other than the repository's Instagram");
  assert.match(read("app/content.ts"), /instagram: "gloa\.matcha"/);
  // The same destination the footer and the homepage already use.
  assert.match(read("app/Chrome.tsx"), /https:\/\/instagram\.com\/\$\{BRAND\.instagram\}/);
  assert.equal((community.match(/target="_blank" rel="noopener noreferrer"/g) || []).length, 2,
    "an external action is missing the safe-window attributes");
  // The label is derived, not hardcoded, so it cannot drift from the URL.
  assert.match(community, /\{`@\$\{BRAND\.instagram\}`\.toUpperCase\(\)\}/);
});

test("5b: BrandNote is untouched, and still closes the homepage", () => {
  // The component itself is not edited - only this page stopped using it.
  assert.match(site, /function BrandNote\(\)\{\nreturn <section className="brand-note">/);
  assert.ok(site.includes("KEIN NEWSLETTER-LÄRM"), "BrandNote lost its copy");
  assert.ok(site.includes("Wir melden uns nicht."), "BrandNote lost its headline");
  assert.match(css, /\.brand-note\{background:var\(--blue\);color:var\(--cream\)/);
  // Exactly one render of it, and it is the homepage's.
  const homepage = site.slice(site.indexOf("function Home()"), site.indexOf("\nfunction ", site.indexOf("function Home()") + 10));
  assert.ok(homepage.includes("<BrandNote/>"), "the homepage lost BrandNote");
  // `page` also contains the new component's comment, which names
  // <BrandNote/> in prose; what matters is the listing's own JSX.
  const listingJsx = site.slice(site.indexOf('return <main className="rezepte-page">'),
                                site.indexOf("</main>}", site.indexOf('return <main className="rezepte-page">')));
  assert.ok(!listingJsx.includes("<BrandNote/>"), "/rezepte still renders BrandNote");
  assert.ok(listingJsx.includes("<RezepteCommunity/>"), "/rezepte does not render the community band");
  assert.equal((site.match(/<BrandNote\/>/g) || []).length, 2,
    "BrandNote is rendered somewhere unexpected");
});

test("5c: the community headline is SECTION scale, never hero scale", () => {
  const sans = rule(".rz-community-line{");
  const ital = rule(".rz-community-line-accent{");
  // Inter 700 capped at 56, and the Cormorant editorial line at 60.
  assert.match(sans, /font-weight:700/);
  assert.match(sans, /font-size:clamp\(40px,4vw,56px\)/);
  assert.match(sans, /line-height:\.95/);
  assert.match(ital, /font-size:clamp\(42px,4\.3vw,60px\)/);
  assert.match(ital, /line-height:\.94/);
  assert.match(ital, /font-weight:400/);
  assert.match(ital, /font-family:var\(--font-display\),Georgia,serif/);
  assert.match(ital, /font-style:italic/);
  // IT IS AN INTERNAL SECTION, NOT A PAGE HERO: it must not read the
  // shared hero system, and the hero system must not read Cormorant.
  assert.ok(!community.includes("gloa-hero-"), "the community band took the page hero classes");
  assert.ok(!code.includes("--type-hero-primary") && !code.includes("--type-hero-secondary"),
    "this page redefines or reads the hero tokens outside the hero");
  // The body, at the contract's figures.
  const body = rule(".rz-community-body{");
  assert.match(body, /font-size:clamp\(16px,1\.2vw,17px\)/);
  assert.match(body, /line-height:1\.6/);
  assert.match(body, /max-width:460px/);
  // It never reaches the page hero, at any width.
  const heroSans = w => (w <= 900 ? at("clamp(44px,12vw,64px)", w) : at("clamp(54px,5.9vw,100px)", w));
  const secSans = w => (w <= 900 ? at("clamp(36px,9.2vw,44px)", w) : at("clamp(42px,4.2vw,60px)", w));
  for (const w of [320, 375, 390, 430, 640, 760, 900, 901, 1100, 1280, 1440, 1680, 1920]) {
    assert.ok(secSans(w) < heroSans(w),
      `the community headline (${secSans(w)}) reaches the hero (${heroSans(w)}) at ${w}px`);
  }
  // Cream on blue, and the CTA is the canonical coloured-section button.
  const cta = rule(".rz-community .rz-community-cta{");
  assert.match(cta, /background:var\(--cream\)/);
  assert.match(cta, /color:var\(--blue\)/);
  assert.match(cta, /border-radius:0/);
  assert.match(cta, /box-shadow:none/);
});

/* ══════════════════════════════════════════════════════════════
   6. RESPONSIVE, AND THE FREEZES
   ══════════════════════════════════════════════════════════════ */

test("6: the grid and the band reflow, and nothing reorders", () => {
  const at1100 = code.slice(code.indexOf("@media (max-width:1100px)"), code.indexOf("@media (max-width:900px)"));
  const at900 = code.slice(code.indexOf("@media (max-width:900px)"), code.indexOf("@media (max-width:760px)"));
  const at760 = code.slice(code.indexOf("@media (max-width:760px)"), code.indexOf("@media (max-width:520px)"));

  // TWO strong columns, held through tablet, one column below 760.
  assert.match(rule(".rezepte-grid-inner{"), /grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.ok(!at1100.includes(".rezepte-grid-inner"), "the grid still reflows at 1100");
  assert.ok(!at900.includes(".rezepte-grid-inner"), "the grid still reflows at 900");
  assert.match(at760, /\.rezepte-grid-inner\{grid-template-columns:minmax\(0,1fr\)/);
  assert.match(rule(".rezepte-grid-inner{"), /align-items:start/);

  // A full-rail 4:5 image must never be taller than the screen it is on.
  // Evaluated from the real rail, gutter and gap tokens.
  const cl = (t, w) => at(t, w);
  for (const w of [1680, 1536, 1440, 1280, 1024, 900, 768, 760, 430, 390, 375, 320]) {
    const gutter = cl("clamp(20px,3vw,48px)", w);
    const rail = Math.min(1520, w - 2 * gutter);
    const cols = w <= 760 ? 1 : 2;
    const colW = cols === 1 ? rail : (rail - cl("clamp(28px,3vw,56px)", w)) / 2;
    assert.ok(colW > 250, `a recipe image is only ${Math.round(colW)}px wide at ${w}px`);
    assert.ok(colW * 1.25 < 1000, `a recipe image is ${Math.round(colW * 1.25)}px tall at ${w}px`);
  }
  assert.match(rule(".rz-community-inner{"), /grid-template-columns:minmax\(0,1\.15fr\) minmax\(0,\.85fr\)/);
  assert.match(at1100, /\.rz-community-inner\{grid-template-columns:minmax\(0,1fr\)/);
  assert.match(at760, /\.rz-community \.rz-community-cta\{width:100%/);
  // The section scale steps down once, at the same 900px the hero uses.
  assert.match(at900, /\.rz-community-line\{font-size:clamp\(34px,8\.8vw,42px\)\}/);
  assert.match(at900, /\.rz-community-line-accent\{font-size:clamp\(36px,9\.4vw,44px\)\}/);
  // Nothing is reordered, so the reading order is the DOM order.
  assert.ok(!/\border:\s*-?\d|grid-auto-flow:\s*dense|flex-direction:\s*(column|row)-reverse/.test(code),
    "a reflow changed the reading order");
  // THE EMPTY FILTER STATE exists but is unreachable with the current
  // data - every filter matches at least two recipes - so it adds no
  // content, only a graceful floor if the data later changes.
  assert.match(page, /\{filtered\.length===0&&<p className="rezepte-empty home-rail">/);
  assert.match(rule(".rezepte-empty{"), /font-family:var\(--font-sans\)/);
  assert.ok(!html.includes("rezepte-empty"), "the empty state rendered with a full catalogue");
  // Filters stay a comfortable target at the narrowest width.
  assert.match(code.slice(code.indexOf("@media (max-width:520px)")), /\.rezepte-filters button\{padding:13px 16px/);
});

test("6b: every rule is scoped to /rezepte, and the DETAIL PAGE is untouched", () => {
  for (const m of code.matchAll(/([^{}]+)\{[^}]*\}/g)) {
    const sel = m[1].split(/[\r\n]/).pop().trim();
    if (!sel || sel.startsWith("@")) continue;
    for (const part of sel.split(",")) {
      const s = part.trim();
      if (!s) continue;
      assert.ok(/^\.(rezepte-|rezept-card|rz-community)/.test(s),
        `a rule here is not scoped to /rezepte: ${s}`);
      assert.ok(!/rezept-detail/.test(s), `this block reaches the detail page: ${s}`);
    }
  }
  assert.ok(!code.includes("!important"), "specificity was solved with !important");
  // The detail page still owns every one of its own rules.
  for (const kept of [".rezept-detail-hero{", ".rezept-detail-intro h1{", ".rezept-detail-ingredients{",
                      ".rezept-detail-steps li{", ".rezept-detail-nav{", ".rezept-detail-tags span{"]) {
    assert.ok(css.includes(kept), `the detail page lost ${kept}`);
  }
  assert.match(css, /\.rezept-detail-intro h1\{font-size:clamp\(42px,5vw,72px\)/,
    "the detail page's own heading changed");
  // And it still renders and still resolves.
  assert.match(site, /function RezeptDetail\(\{slug\}:\{slug:string\}\)\{/);
});

test("6c: no other page moved", () => {
  for (const other of ["shop-hero", "matcha-hero", "about-hero", "b2b-hero", "pt-hero",
                       "hero-copy", "daily-", "featured-recipes", "recipe-card", "community-tile"]) {
    assert.ok(!code.includes(other), `this block reaches ${other}`);
  }
  // The recipe DATA is untouched: same six recipes, same order, same paths.
  const data = site.slice(site.indexOf("const recipes:Recipe[]=["), site.indexOf("];", site.indexOf("const recipes:Recipe[]=[")));
  assert.deepEqual([...data.matchAll(/slug:"([^"]+)"/g)].map(m => m[1]),
    ["classic-matcha-latte", "iced-matcha-latte", "strawberry-matcha-latte",
     "orange-zest-matcha-tonic", "lemon-raspberry-coconut-matcha", "affogato-matcha-cloud"]);
  assert.equal([...data.matchAll(/image:"\/img\/[^"]+"/g)].length, 6, "a recipe photo changed");
  assert.deepEqual([...site.matchAll(/const ALL_TAGS=\[([^\]]+)\]/g)].map(m => m[1]),
    ['"ALLE","LATTE","ICED","FRUITY"'], "the filter categories changed");
});

/* ══════════════════════════════════════════════════════════════
   7. THE THINGS THAT MUST STILL WORK
   ══════════════════════════════════════════════════════════════ */

test("7: every filter still selects from the real data", () => {
  // The matcher is unchanged, so the counts are DERIVED here rather than
  // written down: ALLE is everything, any other tag is a tags.includes.
  const data = site.slice(site.indexOf("const recipes:Recipe[]=["),
                          site.indexOf("];", site.indexOf("const recipes:Recipe[]=[")));
  const recipes = [...data.matchAll(/slug:"([^"]+)"[\s\S]*?tags:\[([^\]]*)\]/g)]
    .map(m => ({ slug: m[1], tags: m[2].replace(/"/g, "").split(",") }));
  assert.equal(recipes.length, 6, "the recipe set changed size");

  const tags = /const ALL_TAGS=\[([^\]]+)\]/.exec(site)[1].replace(/"/g, "").split(",");
  assert.deepEqual(tags, ["ALLE", "LATTE", "ICED", "FRUITY"]);
  for (const t of tags) {
    const hits = t === "ALLE" ? recipes : recipes.filter(r => r.tags.includes(t));
    assert.ok(hits.length > 0, `the ${t} filter would render an empty grid`);
  }
  // The logic itself is untouched: one state, one predicate, one source.
  assert.match(page, /const \[filter,setFilter\]=useState\("ALLE"\)/);
  assert.match(page, /filter==="ALLE"\?recipes:recipes\.filter\(r=>r\.tags\.includes\(filter\)\)/);
  // No query param, no route change - selection stays local state.
  assert.ok(!page.includes("useSearchParams") && !page.includes("router.push"),
    "the filter started touching the route");
});

test("7b: every listing link still resolves to its own detail route", async () => {
  const hrefs = [...html.matchAll(/href="(\/rezepte\/[^"]+)"/g)].map(m => m[1]);
  assert.equal(hrefs.length, 6, `the listing rendered ${hrefs.length} recipe links`);
  assert.equal(new Set(hrefs).size, 6, "two cards point at the same recipe");
  for (const href of hrefs) {
    const { status } = await server.getHtml(href);
    assert.equal(status, 200, `${href} does not resolve`);
  }
  // One link per card, wrapping the whole item - no nested anchors.
  assert.equal((html.match(/<article class="rezept-card">/g) || []).length, 6);
  // Exactly one anchor per card, so the whole item is clickable without
  // a second link nested inside it.
  for (const m of html.matchAll(/<article class="rezept-card">([\s\S]*?)<\/article>/g)) {
    assert.equal(m[1].split("<a ").length - 1, 1, "a recipe card has more than one link");
    assert.ok(!/<button/.test(m[1]), "a recipe card nests a control inside its link");
  }
  // Alt text survived on every photo.
  const alts = [...html.matchAll(/<img src="\/img\/[^"]+" alt="([^"]*)"/g)].map(m => m[1]);
  assert.equal(alts.length, 6, "a recipe photo lost its img tag");
  for (const a of alts) {
    assert.ok(a.length > 3 && !/^(image|bild|recipe image|rezept)$/i.test(a), `a placeholder alt: "${a}"`);
  }
});

test("7c: this pass added no backend of any kind", () => {
  // The recipe-sharing CTA is a link to Instagram, not a submission.
  assert.deepEqual(readdirSync(path.join(ROOT, "app/api")).sort(),
    ["annual-plan", "checkout", "contact", "cron", "internal", "orders",
     "stripe", "subscriptions", "withdrawal"],
    "an API route was added or removed");
  assert.ok(!readdirSync(path.join(ROOT, "supabase/migrations")).some(f => f.startsWith("043")),
    "migration 043 exists");
  for (const banned of ['"use server"', "fetch(", "supabase", "resend",
                        "localStorage", "sessionStorage", "<form", "onSubmit"]) {
    assert.ok(!page.toLowerCase().includes(banned.toLowerCase()),
      `the recipes page reaches for ${banned}`);
  }
});
