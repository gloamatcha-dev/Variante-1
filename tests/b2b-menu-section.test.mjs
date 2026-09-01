import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * /for-cafes — THE INFO STRIP AND THE MENU SECTION.
 *
 * The two blocks directly under the B2B hero. The strip was plum, five
 * columns wide, and one of its cells carried a storage claim; the
 * section below it read the shared clamp(48px,7vw,98px) h2 rule - larger
 * than the page hero above it - beside a solid blue card.
 *
 * These tests pin the retired claim, the four remaining facts, the
 * authorised copy, the absence of the blue card, and the type
 * hierarchy. They are not pixel tests.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf8");

const site = read("app/GloaSite.tsx");
const css = read("app/globals.css");

/* The two sections, and nothing else: from the strip up to the first
   component that belongs to the frozen part of the page. */
const block = site.slice(site.indexOf('<section className="b2b-facts">'),
                         site.indexOf("<BusinessCalculator/>"));
assert.ok(block.length > 400, "the strip + menu markup was not found");
const facts = block.slice(0, block.indexOf('<section className="b2b-menu">'));
const menu = block.slice(block.indexOf('<section className="b2b-menu">'));

const blockAt = css.indexOf("INFO STRIP + MENU SECTION");
assert.notEqual(blockAt, -1, "the CSS block was not found");
// Bounded at the NEXT page block. Without an end this slice runs to the
// end of the file and silently absorbs whatever is appended after it.
const rules = css.slice(css.lastIndexOf("/*", blockAt), css.lastIndexOf("/*", css.indexOf("THE TWO ORDERING MODELS")));
/* Comment-free, so the prose describing what this USED to be can never
   satisfy - or trip - an assertion about the rules. */
const code = rules.replace(/\/\*[\s\S]*?\*\//g, "");
const desktop = code.slice(0, code.indexOf("@media"));
const mobile = code.slice(code.indexOf("@media (max-width:900px)"));

const rule = name => {
  const at = code.indexOf(name);
  assert.notEqual(at, -1, `missing rule: ${name}`);
  return code.slice(at, code.indexOf("}", at));
};

/* ══════════════════════════════════════════════════════════════
   1. THE INFO STRIP
   ══════════════════════════════════════════════════════════════ */

test("1: exactly four facts, and the storage claim is gone from source", () => {
  const data = site.slice(site.indexOf("const b2bFacts"), site.indexOf("];", site.indexOf("const b2bFacts")));
  const items = [...data.matchAll(/"([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(items, [
    "SHIZUOKA, JAPAN",
    "LATTE · ICED · PUR",
    "SCHNELLE NACHBESTELLUNG",
    "500 G · 1 KG GASTRO",
  ]);
  // Removed at the data level, not hidden with CSS - and no empty
  // fifth slot or spacer was left behind.
  assert.ok(!data.includes("LAGER"), "the storage claim survived in the data");
  assert.ok(!facts.includes("LAGER IN DEUTSCHLAND"));
  // Scoped to the STRIP: the only display:none in the block belongs to
  // the menu divider when the section stacks, which is a layout switch,
  // not a hidden fact.
  const stripRules = code.slice(0, code.indexOf(".b2b-menu{"))
    + [...code.matchAll(/\.b2b-facts[^{]*\{[^}]*\}/g)].map(m => m[0]).join("");
  assert.ok(!/display:none|visibility:hidden|opacity:0/.test(stripRules),
    "a strip cell is hidden rather than removed");
  assert.ok(!/nth-child\(5\)|:empty/.test(code), "a fifth slot is still styled");
  assert.match(rule(".b2b-facts-inner{"), /grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/);

  // And NO replacement claim was invented in its place.
  for (const banned of ["ABGEFÜLLT", "ABFÜLLUNG", "LAGER", "BESTAND", "VERSAND AUS",
                        "MADE IN GERMANY", "DEUTSCHLAND"]) {
    assert.ok(!facts.includes(banned), `a replacement storage claim: ${banned}`);
  }
});

test("1b: cream ground, near-black type, dividers only between the cells", () => {
  assert.match(rule(".b2b-facts{"), /background:var\(--cream\)/);
  assert.match(rule(".b2b-facts{"), /color:var\(--ink\)/);
  assert.match(css, /--cream:#F5EBE2;/);
  assert.match(css, /--ink:#111111;/);
  const cell = rule(".b2b-facts-inner li{");
  assert.match(cell, /font-size:12px/);
  assert.match(cell, /font-weight:600/);
  assert.match(cell, /letter-spacing:\.06em/);
  assert.match(cell, /text-transform:uppercase/);
  assert.match(cell, /color:var\(--ink\)/);
  assert.match(cell, /border-left:1px solid rgba\(17,17,17,\.14\)/);
  // Compact - a strip, not a section.
  assert.match(cell, /min-height:72px/);
  assert.ok(!/padding-block/.test(rule(".b2b-facts{")), "the strip grew section padding");
  // No divider on the outside edge.
  assert.match(code, /\.b2b-facts-inner li:first-child\{border-left:0\}/);
  // On the canonical rail, in a full-width ground.
  assert.match(rule(".b2b-facts{"), /padding-inline:var\(--rail-gutter\)/);
  assert.ok(facts.includes('className="b2b-facts-inner home-rail"'));
});

test("1c: two by two on mobile, both axes divided, down to 320px", () => {
  assert.match(mobile, /\.b2b-facts-inner\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)\}/);
  assert.match(mobile, /\.b2b-facts-inner li:nth-child\(odd\)\{border-left:0\}/);
  assert.match(mobile, /\.b2b-facts-inner li:nth-child\(-n\+2\)\{border-top:0\}/);
  // The 2x2 is never collapsed into a four-row list.
  const narrow = code.slice(code.indexOf("@media (max-width:380px)"));
  assert.ok(!/grid-template-columns:1fr/.test(narrow), "the strip collapses to one column");
});

/* ══════════════════════════════════════════════════════════════
   2. THE MENU SECTION - COPY
   ══════════════════════════════════════════════════════════════ */

test("2: the authorised copy, exactly", () => {
  for (const line of [
    "FÜR DEINE KARTE GEMACHT.",
    "Einfach zubereitet.",
    "Leicht skalierbar.",
    "Latte, iced, Strawberry oder pur.",
    "Ein Matcha, viele Drinks auf deiner Karte.",
    "BEISPIELRECHNUNG",
    "3 G", "CA. 333", "PRO DRINK", "DRINKS / KG",
    "Beispiel bei 3 g Matcha pro Drink.",
  ]) assert.ok(menu.includes(line), `missing copy: ${line}`);

  // The superseded lines are gone.
  for (const old of ["FÜR DEINE BAR GEMACHT.", "Einfach zubereiten.", "Easy skalieren.",
                     "Classic, iced, Strawberry oder pur.", "Ein Produkt, viele Drinks auf der Karte."]) {
    assert.ok(!menu.includes(old), `superseded copy survived: ${old}`);
  }
});

test("2b: the example stayed an example, and grew no commercial claim", () => {
  assert.ok(menu.includes("BEISPIELRECHNUNG"), "the example lost its label");
  assert.ok(menu.includes("Beispiel bei 3 g Matcha pro Drink."), "the example lost its note");
  for (const banned of ["Marge", "Umsatz", "Gewinn", "€", "Preis", "ROI", "%",
                        "garantiert", "bis zu", "Rendite"]) {
    assert.ok(!menu.includes(banned), `a commercial claim was added: ${banned}`);
  }
  // The arrow is text, not an icon dependency, and nothing here is an icon.
  assert.ok(menu.includes('<span className="b2b-menu-arrow" aria-hidden="true">→</span>'));
  assert.ok(!menu.includes("<svg"), "an icon was added to the section");
});

/* ══════════════════════════════════════════════════════════════
   3. THE BLUE CARD IS GONE
   ══════════════════════════════════════════════════════════════ */

test("3: no blue, no card, no box anywhere in the section", () => {
  assert.match(rule(".b2b-menu{"), /background:var\(--berry\)/);
  assert.match(rule(".b2b-menu{"), /color:var\(--cream\)/);
  assert.match(css, /--berry:#A61E59;/);

  // The card is removed at the source, not made transparent: its class,
  // its markup and its rules are all gone.
  // The class, not the word: "servings" also names a field on the recipe
  // data, which this pass does not touch.
  assert.ok(!site.includes('className="servings"') && !site.includes("servings-label"),
    "the calculation card markup survived");
  assert.match(site, /servings:"1 Tasse"/, "the recipe data was collaterally edited");
  assert.ok(!css.includes(".servings"), "the calculation card rules survived");
  assert.ok(!css.includes(".quick-facts"), "the old strip rules survived");
  // The standalone rule. ".behind-bar{" still appears as the LAST
  // selector of the shared ".product-intro,.origin,.pdp-facts,.behind-bar"
  // list, which serves other pages and is deliberately untouched.
  assert.ok(!css.includes(".behind-bar{padding:110px"), "the old section rule survived");
  assert.ok(!css.includes(".behind-bar>div"), "an old descendant rule survived");

  // NOTHING in this block paints a container.
  assert.ok(!code.includes("var(--blue)"), "blue came back into the section");
  assert.ok(!/box-shadow/.test(code), "a shadow was added");
  assert.ok(!/border-radius/.test(code), "a radius was added");
  // The only backgrounds are the two section grounds and the divider fade.
  const grounds = [...code.matchAll(/background:([^;}]+)/g)].map(m => m[1].trim());
  for (const g of grounds) {
    assert.ok(/^var\(--(cream|berry)\)$/.test(g) || g.startsWith("linear-gradient("),
      `an unexpected background: ${g}`);
  }
  // No literal hex, and every rgba is a cream or ink alpha.
  for (const m of code.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) assert.fail(`a literal hex: ${m[0]}`);
  for (const m of code.matchAll(/rgba\(([^)]+)\)/g)) {
    const [r, g, b] = m[1].split(",").map(n => Number(n.trim()));
    const ok = (r === 245 && g === 235 && b === 226) || (r === 17 && g === 17 && b === 17)
      || (r === 0 && g === 0 && b === 0);
    assert.ok(ok, `a non-brand rgba: rgba(${m[1]})`);
  }
});

test("3b: the one gradient is a divider fade, never a section ground", () => {
  const gradients = [...code.matchAll(/linear-gradient\(/g)];
  assert.equal(gradients.length, 1, "more than one gradient in the block");
  const divider = rule(".b2b-menu-divider{");
  assert.match(divider, /width:1px/);
  assert.match(divider, /height:clamp\(180px,23vw,250px\)/);
  assert.match(divider, /linear-gradient\(/);
  assert.match(divider, /rgba\(245,235,226,\.40\)/);
  // It is a grid track of its own, so it cannot drift from the columns.
  assert.match(rule(".b2b-menu-inner{"), /grid-template-columns:minmax\(0,1fr\) 1px minmax\(0,\.95fr\)/);
  assert.match(menu, /<span className="b2b-menu-divider" aria-hidden="true"\/>/);
  // Hidden when stacked, replaced by a horizontal hairline.
  assert.match(mobile, /\.b2b-menu-divider\{display:none\}/);
  assert.match(mobile, /\.b2b-menu-example\{[^}]*border-top:1px solid rgba\(245,235,226,\.28\)/);
});

/* ══════════════════════════════════════════════════════════════
   4. TYPOGRAPHY - A SECTION, UNDER A PAGE HERO
   ══════════════════════════════════════════════════════════════ */

const clampAt = (t, w) => {
  const [lo, vw, hi] = /clamp\(([\d.]+)px,([\d.]+)vw,([\d.]+)px\)/.exec(t).slice(1).map(Number);
  return Math.max(lo, Math.min((vw / 100) * w, hi));
};
const sizeOf = (scope, sel) => {
  const at = scope.indexOf(sel);
  assert.notEqual(at, -1, `missing rule: ${sel}`);
  return /font-size:(clamp\([^)]*\)|\d+px)/.exec(scope.slice(at))[1];
};

test("4: two families, and the caps the contract names", () => {
  for (const m of code.matchAll(/font-family:([^;}]+)/g)) {
    assert.match(m[1], /^var\(--font-(sans|display)\)/, `a third family: ${m[1]}`);
  }
  for (const m of code.matchAll(/font-family:var\(--font-display\),([^;}]+)/g)) {
    assert.equal(m[1].trim(), "Georgia,serif");
  }
  assert.ok(!code.includes("@font-face") && !code.includes("@import"));
  assert.match(rule(".b2b-menu .b2b-menu-line{"), /font-family:var\(--font-sans\)/);
  assert.match(rule(".b2b-menu .b2b-menu-line-accent{"), /font-family:var\(--font-display\)/);
  assert.match(rule(".b2b-menu .b2b-menu-line-accent{"), /font-style:italic/);

  const cap = t => Number(/clamp\([\d.]+px,[\d.]+vw,([\d.]+)px\)/.exec(t)[1]);
  assert.equal(cap(sizeOf(desktop, ".b2b-menu .b2b-menu-line{")), 60);
  assert.equal(cap(sizeOf(desktop, ".b2b-menu .b2b-menu-line-accent{")), 64);
  assert.equal(cap(sizeOf(desktop, ".b2b-menu-number{")), 48);
  assert.match(rule(".b2b-menu .b2b-menu-eyebrow,"), /font-size:var\(--type-meta\)/);
  assert.match(rule(".b2b-menu .b2b-menu-eyebrow,"), /letter-spacing:\.2em/);
  assert.match(rule(".b2b-menu .b2b-menu-body{"), /font-size:clamp\(16px,1\.3vw,17px\)/);
  assert.match(rule(".b2b-menu-meta{"), /font-size:11px/);
  // Both eyebrows read ONE rule, so they cannot drift apart.
  assert.ok(rule(".b2b-menu .b2b-menu-eyebrow,").length > 0);
  assert.match(desktop, /\.b2b-menu \.b2b-menu-eyebrow,\s*\.b2b-menu \.b2b-menu-example-eyebrow\{/);
});

test("4b: the section stays under the B2B hero, and the numbers under the title", () => {
  // The hero's own curves, from the block above this one.
  const heroBlock = css.slice(css.indexOf("/for-cafes PAGE HERO"), blockAt);
  const heroCode = heroBlock.replace(/\/\*[\s\S]*?\*\//g, "");
  const heroDesktop = heroCode.slice(0, heroCode.indexOf("@media"));
  const heroMobile = heroCode.slice(heroCode.indexOf("@media (max-width:900px)"));

  const pick = (scopeD, scopeM, sel, w) => clampAt(sizeOf(w <= 900 ? scopeM : scopeD, sel), w);
  for (const w of [320, 360, 390, 430, 480, 640, 768, 900, 901, 1024, 1200, 1280, 1440, 1536, 1680, 1920]) {
    const heroSans = pick(heroDesktop, heroMobile, ".b2b-hero .b2b-hero-line{", w);
    const heroItal = pick(heroDesktop, heroMobile, ".b2b-hero .b2b-hero-line-accent{", w);
    const sans = pick(desktop, mobile, ".b2b-menu .b2b-menu-line{", w);
    const ital = pick(desktop, mobile, ".b2b-menu .b2b-menu-line-accent{", w);
    const num = pick(desktop, mobile, ".b2b-menu-number{", w);

    assert.ok(sans < heroSans, `the section sans (${sans}) reaches the hero (${heroSans}) at ${w}px`);
    assert.ok(ital < heroItal, `the section italic (${ital}) reaches the hero italic (${heroItal}) at ${w}px`);
    // The example may be prominent, never louder than the title.
    assert.ok(num < sans, `the example number (${num}) outgrew the title (${sans}) at ${w}px`);
  }
  // The 98px shared h2 rule no longer reaches this section - it renamed
  // rather than editing a list that .faq and .business-support share.
  assert.ok(!menu.includes("behind-bar"), "the old class survived in the markup");
  assert.match(css, /\.behind-bar h2,|,\.behind-bar h2[,{]/);
  assert.match(css, /\.b2b-hero h1 i,\.behind-bar h2 i,\.business-support h2 i,\.faq h2 i\{/);
});

/* ══════════════════════════════════════════════════════════════
   5. STRUCTURE, SEMANTICS AND THE FREEZES
   ══════════════════════════════════════════════════════════════ */

test("5: rail, order and semantics", () => {
  assert.ok(menu.includes('className="b2b-menu-inner home-rail"'));
  assert.match(rule(".b2b-menu{"), /padding-inline:var\(--rail-gutter\)/);
  assert.match(rule(".b2b-menu{"), /padding-block:clamp\(84px,7vw,108px\)/);
  assert.match(rule(".b2b-menu-inner{"), /align-items:center/);
  assert.ok(!/min-height|\dvh/.test(rule(".b2b-menu{")), "the section reserves height");

  // One h2 for the section; the eyebrows are paragraphs, not headings.
  assert.equal([...menu.matchAll(/<h2[ >]/g)].length, 1);
  assert.ok(!/<h1[ >]/.test(block), "the strip or section grew a second h1");
  assert.ok(!/<h[3-6][ >]/.test(block));
  assert.match(menu, /<p className="eyebrow b2b-menu-eyebrow">/);
  assert.match(menu, /<p className="eyebrow b2b-menu-example-eyebrow">/);
  // The strip is a list, not a row of bare <strong>.
  assert.match(facts, /<ul className="b2b-facts-inner home-rail">/);
  assert.match(facts, /<li key=\{x\}>\{x\}<\/li>/);

  // Source order IS the stacked order: copy, then divider, then example.
  assert.ok(menu.indexOf("b2b-menu-copy") < menu.indexOf("b2b-menu-divider"));
  assert.ok(menu.indexOf("b2b-menu-divider") < menu.indexOf("b2b-menu-example"));
});

test("5b: every selector is scoped, and nothing else on the page moved", () => {
  let n = 0;
  for (const m of code.matchAll(/[}{]\s*([^{}@]+?)\s*\{/g)) {
    for (const sel of m[1].split(",")) {
      const s = sel.trim();
      if (!s) continue;
      n++;
      assert.ok(/^\.b2b-(facts|menu)/.test(s), `an unscoped selector: ${s}`);
    }
  }
  assert.ok(n > 15, `only ${n} selectors were scanned`);

  // The hero above is untouched, including its asset.
  const hero = site.slice(site.indexOf('<section className="b2b-hero"'), site.indexOf('<section className="b2b-facts">'));
  assert.match(hero, /Dein Matcha\./);
  assert.match(hero, /Dein Signature-Drink\./);
  assert.match(hero, /src="\/img\/B2B Packung\.png"/);
  assert.match(hero, /href="\?intent=sample#lead"/);
  assert.match(css, /\.b2b-hero\{[\s\S]{0,200}background:var\(--plum\)/);

  // Everything after this section is frozen and still there.
  const after = site.slice(site.indexOf("<BusinessCalculator/>"));
  assert.match(after, /<BusinessCalculator\/>/);
  assert.match(after, /<BusinessFaq\/>/);
  assert.match(read("app/BusinessCalculator.tsx"), /className="b2b-compare"/);
  assert.match(read("app/BusinessCalculator.tsx"), /className="supply"/);
  assert.match(read("app/B2bCalculator.tsx"), /export function B2bCalculator\(/);
  // And the other finished pages still have their own blocks.
  for (const marker of ["/about — ONE EDITORIAL SYSTEM", "/our-matcha PAGE HERO", ".home-rail{"]) {
    assert.ok(css.includes(marker), `a frozen block went missing: ${marker}`);
  }
});
