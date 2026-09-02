import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
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
  // The raspberry meta line, at the same scale the homepage card sets.
  const meta = rule(".rezept-card-meta{");
  assert.match(meta, /font-size:var\(--type-meta\)/);
  assert.match(meta, /letter-spacing:\.18em/);
  assert.match(meta, /text-transform:uppercase/);
  assert.match(meta, /color:var\(--berry\)/);
  assert.match(css, /\.recipe-card-time\{[\s\S]*?letter-spacing:\.18em[\s\S]*?color:var\(--berry\)/,
    "the homepage card this one follows changed");
  // The title reads the shared card token, not a number of its own.
  assert.match(rule(".rezept-card-body h2{"), /font-size:var\(--type-card\)/);
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
                      "Dein Rezept teilen", "@gloa.matcha"]) {
    assert.ok(html.includes(copy), `missing community copy: ${copy}`);
  }
  // The retired newsletter framing is not on this page any more.
  for (const gone of ["KEIN NEWSLETTER-LÄRM", "Wir melden uns nicht.", "Keine Rabattschreie"]) {
    assert.ok(!html.includes(gone), `the newsletter band is still on /rezepte: ${gone}`);
  }
  assert.ok(!/newsletter/i.test(html.replace(/<script[\s\S]*?<\/script>/g, "")), "a newsletter string survived");
  // Two actions: one internal, one external with the outward arrow.
  assert.ok(community.includes('href="/contact"'), "the primary action goes nowhere");
  assert.match(community, /href=\{`https:\/\/instagram\.com\/\$\{BRAND\.instagram\}`\}/);
  assert.match(community, /target="_blank" rel="noopener noreferrer"/);
  assert.ok(community.includes("↗"), "the external link has no outward arrow");
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
  assert.match(sans, /font-size:clamp\(42px,4\.2vw,60px\)/);
  assert.match(sans, /font-weight:500/);
  assert.match(ital, /font-size:clamp\(44px,4\.6vw,64px\)/);
  assert.match(ital, /font-family:var\(--font-display\),Georgia,serif/);
  assert.match(ital, /font-style:italic/);
  // Exactly what /about and /partnerships already set - one section scale.
  assert.match(css, /\.about-why-line,[^{]*\{[^}]*font-size:clamp\(42px,4\.2vw,60px\)/);
  assert.match(css, /\.partnerships-page \.pt-line\{[\s\S]*?font-size:clamp\(42px,4\.2vw,60px\)/);
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

  assert.match(rule(".rezepte-grid-inner{"), /grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
  assert.match(at1100, /\.rezepte-grid-inner\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)\}/);
  assert.match(at760, /\.rezepte-grid-inner\{grid-template-columns:minmax\(0,1fr\)/);
  assert.match(rule(".rz-community-inner{"), /grid-template-columns:minmax\(0,1\.15fr\) minmax\(0,\.85fr\)/);
  assert.match(at1100, /\.rz-community-inner\{grid-template-columns:minmax\(0,1fr\)/);
  assert.match(at760, /\.rz-community \.rz-community-cta\{width:100%/);
  // The section scale steps down once, at the same 900px the hero uses.
  assert.match(at900, /\.rz-community-line\{font-size:clamp\(36px,9\.2vw,44px\)\}/);
  assert.match(at900, /\.rz-community-line-accent\{font-size:clamp\(38px,10vw,46px\)\}/);
  // Nothing is reordered, so the reading order is the DOM order.
  assert.ok(!/\border:\s*-?\d|grid-auto-flow:\s*dense|flex-direction:\s*(column|row)-reverse/.test(code),
    "a reflow changed the reading order");
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
