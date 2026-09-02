import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * THE /our-matcha PAGE HERO, as a source contract.
 *
 * The page is statically composed, so the interesting facts are all in
 * the source: which image it renders, which two families it types with,
 * and that a SECONDARY page hero stays under the homepage one at every
 * viewport width rather than at one convenient breakpoint.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf8");

const site = read("app/GloaSite.tsx");
const css = read("app/globals.css");

const page = site.slice(site.indexOf("function MatchaPage()"), site.indexOf("\nfunction ", site.indexOf("function MatchaPage()") + 5));
const hero = page.slice(page.indexOf('<section className="matcha-hero">'), page.indexOf("</section>") + 10);
const rules = css.slice(css.indexOf("/our-matcha PAGE HERO"), css.indexOf("/our-matcha PRODUCT + TASTE, MERGED"));
const rule = name => {
  const at = rules.indexOf(name);
  assert.notEqual(at, -1, `missing rule: ${name}`);
  return rules.slice(at, rules.indexOf("}", at));
};

/* ══════════════════════════════════════════════════════════════
   1. THE IMAGE
   ══════════════════════════════════════════════════════════════ */

test("1: the hero renders the map, and the packaging photo only left THIS hero", () => {
  assert.match(hero, /<img src="\/img\/Japan_Karte\.png" alt="Karte von Japan mit Shizuoka markiert"/);
  assert.ok(existsSync(path.join(ROOT, "public/img/Japan_Karte.png")), "the map asset is missing");
  assert.ok(statSync(path.join(ROOT, "public/img/Japan_Karte.png")).size > 0);
  // The retired map is not rendered here - and not deleted either.
  assert.ok(!hero.includes("Landkarte Japan.png"), "the hero still renders the old map");
  assert.ok(existsSync(path.join(ROOT, "public/img/Landkarte Japan.png")), "the old map asset was deleted");

  // ── THE PACKAGING PHOTO IS NOT DELETED ───────────────────────
  assert.ok(!hero.includes("gloa-hero-packaging"), "the hero still renders the packaging photo");
  assert.ok(existsSync(path.join(ROOT, "public/img/gloa-hero-packaging.jpg")), "the packaging asset was deleted");
  assert.ok(site.includes("gloa-hero-packaging"), "the packaging photo left the site entirely");
  // And no other image was smuggled into this hero.
  assert.equal([...hero.matchAll(/<img /g)].length, 1);
  for (const banned of ["Header.png", "Produkt Bild (2).png", "Produkt BILD.png", "Landkarte Japan.png"]) {
    assert.ok(!hero.includes(banned), `the hero renders ${banned}`);
  }

  // ── NO CONTAINER AROUND IT ───────────────────────────────────
  const map = rule(".matcha-hero-map{");
  assert.match(map, /background:transparent/);
  assert.match(map, /border:0/);
  assert.match(map, /border-radius:0/);
  assert.match(map, /box-shadow:none/);
  assert.match(map, /width:min\(100%,clamp\(500px,43vw,650px\)\)/);
  assert.match(map, /align-self:center/);
  // Contained, so no coastline and no label is cropped away.
  assert.match(rules, /\.matcha-hero-map img\{[\s\S]*?object-fit:contain/);
  assert.match(rules, /\.matcha-hero-map img\{[\s\S]*?height:auto/);
  assert.ok(!rules.includes("object-fit:cover"), "the map is cropped");
  // The section's own cream is the only ground.
  assert.match(rules, /\.matcha-hero\{[\s\S]*?background:var\(--cream\)/);
  assert.ok(!/\.matcha-hero-map[^{]*\{[^}]*background:var\(--(berry|blue|plum)\)/.test(rules),
    "the map sits on a coloured panel");
  // Nothing was drawn on top of the asset.
  assert.ok(!/<svg|::after|::before/.test(hero), "an overlay was added to the map");
});

/* ══════════════════════════════════════════════════════════════
   2. THE HIERARCHY
   ══════════════════════════════════════════════════════════════ */

test("2: a page hero - the homepage hero exactly, over a section title", () => {
  const clamp = (lo, mid, hi) => Math.max(lo, Math.min(mid, hi));
  const parse = t => /clamp\(([\d.]+)px,([\d.]+)vw,([\d.]+)px\)/.exec(t).slice(1).map(Number);

  // THE HOMEPAGE IS THE MASTER NOW. This hero used to read a pair of
  // page-hero tokens pitched deliberately UNDER the homepage's own
  // curve; it reads the homepage's curve itself instead, through the
  // two shared classes. The old tokens have no consumer left.
  assert.ok(hero.includes('<span className="matcha-hero-line gloa-hero-primary">'),
    "the hero sans line does not read the shared scale");
  assert.ok(hero.includes('gloa-hero-secondary">Ohne Umwege.</i>'),
    "the hero italic line does not read the shared scale");
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(!bare.includes("var(--type-page-hero)"), "the superseded token found a consumer");
  assert.ok(!bare.includes("var(--type-page-hero-accent)"), "the superseded accent token found a consumer");

  const tok = (name, w) => {
    const all = bare.split(name + ":").slice(1).map((t) => t.slice(0, t.indexOf(")") + 1));
    assert.equal(all.length, 2, `${name} is not declared exactly twice`);
    return all[w <= 900 ? 1 : 0];
  };
  // The homepage hero's own curve, read from the homepage's own rule so
  // the master and this page cannot drift apart.
  assert.match(bare, /\.hero \.hero-copy h1\{[^}]*font-size:clamp\(54px,5\.9vw,100px\)/);
  const homeHero = w => (w <= 900 ? clamp(44, 0.12 * w, 64) : clamp(54, 0.059 * w, 100));
  const sectionTitle = w => clamp(34, 0.044 * w, 64);
  for (const w of [320, 360, 390, 430, 640, 768, 900, 901, 1024, 1085, 1200, 1280, 1440, 1536, 1680, 1920, 2560]) {
    const [tLo, tVw, tHi] = parse(tok("--type-hero-primary", w));
    const [aLo, aVw, aHi] = parse(tok("--type-hero-secondary", w));
    const title = clamp(tLo, (tVw / 100) * w, tHi);
    const accent = clamp(aLo, (aVw / 100) * w, aHi);
    assert.ok(Math.abs(homeHero(w) - title) < 1e-6,
      `the page hero (${title}) is not the homepage hero (${homeHero(w)}) at ${w}px`);
    assert.ok(accent < title, `the accent outgrew the hero at ${w}px`);
    // And it is a HERO: at desktop widths it outranks a section title.
    if (w >= 1024) assert.ok(title > sectionTitle(w), `the page hero shrank to a section title at ${w}px`);
  }

  // -- ONE PAGE-HERO ROLE, EVERY PAGE ---------------------------
  // /shop and /our-matcha read the SAME two classes. Their colours and
  // their copy differ on purpose; their type scale cannot.
  assert.match(css, /\.gloa-hero-primary\{[\s\S]*?font-size:var\(--type-hero-primary\)/);
  assert.match(css, /\.gloa-hero-secondary\{[\s\S]*?font-size:var\(--type-hero-secondary\)/);
  assert.ok(site.includes('className="shop-hero-line gloa-hero-primary"'), "/shop left the shared scale");
  // And a page hero outranks a section title at desktop widths.
  const titleCap = Number(/--type-title:clamp\([^,]+,[^,]+,(\d+)px\)/.exec(css)[1]);
  assert.ok(100 > titleCap, "the page hero is no larger than a section title");
  // The 122px headline that beat the homepage hero is gone.
  assert.ok(!css.includes(".matcha-page h1{font-size:clamp(64px,8vw,122px)"), "the 122px headline survived");
});

/* ══════════════════════════════════════════════════════════════
   3. TYPE, COPY AND THE RAIL
   ══════════════════════════════════════════════════════════════ */

test("3: two families, unchanged copy, canonical rail", () => {
  // ── COPY: SAME WORDS, BROKEN INTO ITS THREE SENTENCES ────────
  // Same words. The gloa-hero-* classes are the shared homepage scale,
  // added in the global page hero pass; nothing here was reworded.
  assert.ok(hero.includes('<p className="eyebrow matcha-hero-eyebrow gloa-hero-eyebrow">UNSER MATCHA</p>'));
  assert.ok(hero.includes('<span className="matcha-hero-line gloa-hero-primary">Matcha.</span>'));
  assert.ok(hero.includes('<i className="matcha-hero-line matcha-hero-line-accent gloa-hero-secondary">Ohne Umwege.</i>'));
  assert.ok(hero.includes("100 % Bio-Matcha aus Shizuoka, Japan.<br/>Für Latte, pur oder iced.<br/>Klar beschrieben, nichts erfunden."));
  for (const dash of ["–", "—"]) assert.ok(!hero.includes(dash), `a dash was introduced: ${dash}`);

  // -- THE HEADLINE LINES ARE THE SHARED SCALE ------------------
  // Inter 800 over Inter ITALIC 400 - the homepage's pairing. The
  // Cormorant second line this hero used to set is retired here and
  // nowhere else; Cormorant still carries every editorial line in the
  // sections below.
  assert.match(css, /\.gloa-hero-primary\{[\s\S]*?font-weight:800/);
  assert.match(css, /\.gloa-hero-secondary\{[\s\S]*?font-style:italic/);
  assert.match(css, /\.gloa-hero-secondary\{[\s\S]*?font-weight:400/);
  assert.match(css, /\.matcha-facts h2 i[,{][^{]*\{[^}]*font-family:var\(--font-display\)/);
  for (const m of rules.matchAll(/font-family:([^;}]+)/g)) {
    assert.match(m[1], /^var\(--font-(sans|display)\)/, `a third family: ${m[1]}`);
  }
  // The eyebrow reads the page-wide meta token; the lead is body-sized.
  assert.match(rule(".matcha-hero-eyebrow{"), /font-size:var\(--type-meta\)/);
  assert.match(rule(".matcha-hero-eyebrow{"), /letter-spacing:\.2em/);
  assert.match(rule(".matcha-hero-lead{"), /font-size:clamp\(16px,1\.4vw,18px\)/);
  assert.match(rule(".matcha-hero-lead{"), /font-weight:400/);

  // ── THE RAIL, AND A CONTENT-DRIVEN HEIGHT ────────────────────
  assert.match(hero, /<div className="matcha-hero-inner home-rail">/);
  assert.match(css, /\.shop-accordion,\s*\.matcha-hero,\s*\.matcha-product,\s*\.matcha-research,\s*\.matcha-use,\s*\.matcha-page \.faq,\s*\.matcha-cta\{padding-inline:var\(--rail-gutter\)\}/);
  assert.match(rules, /\.matcha-hero-inner\{[\s\S]*?grid-template-columns:minmax\(0,\.95fr\) minmax\(0,1\.05fr\)/);
  assert.match(rules, /\.matcha-hero\{[\s\S]*?padding-block:clamp\(72px,7vw,110px\)/);
  assert.ok(!rules.includes("100vh"), "the hero reserves a viewport");
  assert.ok(!/\.matcha-hero\{[^}]*min-height/.test(rules), "the hero has a fixed height");
  // .pdp-hero on the product detail page legitimately uses 700px; the
  // guard names the rule this pass actually retired.
  assert.ok(!css.includes(".matcha-hero{display:grid"), "the retired 700px hero rule survived");
  // Stacks text-then-map before the columns can crush each other.
  assert.match(rules, /@media \(max-width:1024px\)\{[\s\S]*?\.matcha-hero-inner\{grid-template-columns:1fr/);
  assert.ok(hero.indexOf("matcha-hero-copy") < hero.indexOf("matcha-hero-map"), "the map stacks above the text");
  assert.match(rules, /@media \(max-width:640px\)\{[\s\S]*?\.matcha-hero-map\{justify-self:center;width:min\(100%,460px\)/);
});
