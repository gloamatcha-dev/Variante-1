import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * /for-cafes — THE B2B FAQ.
 *
 * /for-cafes and /our-matcha render the SAME component: one
 * <section className="faq"> of native <details> rows. /our-matcha
 * restyled it by scoping every rule to `.matcha-page .faq` and leaving
 * the base `.faq` rules for this page; this pass does the same from the
 * other side with `.business .faq`.
 *
 * So the two sharpest things here are: /our-matcha must be provably
 * untouched, and the Germany warehouse question must be gone from the
 * data rather than hidden.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf8");

const site = read("app/GloaSite.tsx");
const css = read("app/globals.css");

const faq = site.slice(site.indexOf("function BusinessFaq()"),
                       site.indexOf("\nfunction ", site.indexOf("function BusinessFaq()") + 5));
assert.ok(faq.length > 600, "the B2B FAQ was not found");

const blockAt = css.indexOf("/for-cafes — THE B2B FAQ");
assert.notEqual(blockAt, -1, "the CSS block was not found");
const rules = css.slice(css.lastIndexOf("/*", blockAt));
const code = rules.replace(/\/\*[\s\S]*?\*\//g, "");
const desktop = code.slice(0, code.indexOf("@media"));
const mobile = code.slice(code.indexOf("@media (max-width:760px)"));

const rule = name => {
  const at = code.indexOf(name);
  assert.notEqual(at, -1, `missing rule: ${name}`);
  return code.slice(at, code.indexOf("}", at));
};

/* ══════════════════════════════════════════════════════════════
   1. THE CONTENT CORRECTION
   ══════════════════════════════════════════════════════════════ */

test("1: the Germany warehouse question is gone from the DATA", () => {
  // Removed as a pair, not hidden.
  for (const banned of [
    "Habt ihr Lager in Deutschland?", "Ja. Bestand in Deutschland.",
    "Lager in Deutschland", "Bestand in Deutschland",
  ]) assert.ok(!faq.includes(banned), `the warehouse FAQ survived: ${banned}`);
  assert.ok(!/display:none|visibility:hidden/.test(code), "something is hidden rather than removed");

  // And no replacement warehouse claim was written in its place.
  for (const banned of ["Lager", "Warenlager", "Versandlager", "Holland", "Niederlande",
                        "abgefüllt", "Abfüllung", "Bestand", "Wo lagert", "Wo ist euer"]) {
    assert.ok(!faq.includes(banned), `a replacement warehouse claim: ${banned}`);
  }
  // Eleven pairs remain - one fewer than before.
  const data = faq.slice(faq.indexOf("const qs"), faq.indexOf("];", faq.indexOf("const qs")));
  assert.equal([...data.matchAll(/\["/g)].length, 11, "the FAQ list length is wrong");
});

test("1b: every other question and its commercial truth is untouched", () => {
  for (const q of [
    "Wo kommt GLOA Matcha her?",
    "Ist GLOA für Matcha Latte geeignet?",
    "Welche Großhandelsformate gibt es?",
    "Wie schnell liefert ihr?",
    "Wie viele Drinks bekomme ich aus 1 kg?",
    "Was kostet es im Großhandel?",
    "Was ist die regelmäßige Belieferung?",
    "Wie funktioniert die 12-Monats-Partnerschaft?",
    "Muss ich beim Jahresmodell alles im Voraus bezahlen?",
    "Kann ich mehr als die vereinbarte Menge bestellen?",
    "Was passiert, wenn ich noch nicht weiß, wie viel Matcha ich brauche?",
  ]) assert.ok(faq.includes(q), `a question changed: ${q}`);

  // The numbers this page sells on.
  for (const fact of ["5 % Preisvorteil", "10 % Preisvorteil", "Mindestlaufzeit 3 Monate",
                      "500 g und 1 kg Gastroformate.", "Shizuoka, Japan.",
                      "ca. 500 Drinks", "ca. 333 Drinks", "ca. 250 Drinks"]) {
    assert.ok(faq.includes(fact), `a commercial fact changed: ${fact}`);
  }
  // The header the B2B page keeps.
  assert.match(faq, /<p className="eyebrow">B2B FAQ<\/p>/);
  assert.match(faq, /<h2>Fragen\?<br\/><i>Antworten\.<\/i><\/h2>/);
});

test("1c: the accordion is the same native component it was", () => {
  assert.match(faq, /\{qs\.map\(\(\[q,a\]\)=><details key=\{q\}><summary>\{q\}<span>\+<\/span><\/summary><p>\{a\}<\/p><\/details>\)\}/);
  // Native <details> - no hand-rolled state, no click handler, no ARIA
  // to get wrong, and keyboard access comes for free.
  assert.ok(!faq.includes("onClick") && !faq.includes("useState") && !faq.includes("aria-expanded"));
  // Nothing was bolted on.
  assert.ok(!faq.includes("<svg") && !faq.includes("<input") && !faq.includes("<button"),
    "an icon, a search field or a tab was added");
  assert.ok(!/>0[1-9]</.test(faq), "the questions were numbered");
});

/* ══════════════════════════════════════════════════════════════
   2. /our-matcha IS UNTOUCHED
   ══════════════════════════════════════════════════════════════ */

test("2: every rule here is .business-scoped, and the shared base survives", () => {
  let n = 0;
  for (const m of code.matchAll(/[}{]\s*([^{}@]+?)\s*\{/g)) {
    for (const sel of m[1].split(",")) {
      const s = sel.trim();
      if (!s) continue;
      n++;
      assert.ok(s.startsWith(".business .faq"), `an unscoped FAQ rule: ${s}`);
    }
  }
  assert.ok(n > 8, `only ${n} selectors were scanned`);

  // The base rules /our-matcha's own test pins are byte-intact.
  assert.match(css, /\.faq\{padding:110px 10vw\}/);
  assert.match(css, /\.faq details\{border-top:1px solid var\(--plum\)\}/);
  assert.match(css, /\.faq summary\{padding:25px 0/);
  // And so is every /our-matcha override.
  for (const marker of [".matcha-page .faq{", ".matcha-page .faq .eyebrow{", ".matcha-page .faq h2{",
                        ".matcha-page .faq h2 i{", ".matcha-page .faq summary{",
                        ".matcha-page .faq summary span{", ".matcha-page .faq details p{"]) {
    assert.ok(css.includes(marker), `a /our-matcha FAQ rule went missing: ${marker}`);
  }
  assert.match(css, /\.matcha-page \.faq h2\{[\s\S]*?font-size:clamp\(48px,4\.3vw,60px\)/);
  assert.match(css, /\.matcha-page \.faq h2 i\{[\s\S]*?font-size:clamp\(50px,4\.6vw,64px\)/);
  // The /our-matcha FAQ markup is the same one, still rendered there.
  assert.equal([...site.matchAll(/className="faq"/g)].length, 2);
  assert.match(site, /function MatchaPage\(\)/);
});

/* ══════════════════════════════════════════════════════════════
   3. THE LOOK
   ══════════════════════════════════════════════════════════════ */

test("3: cream ground, near black, no white, no cards", () => {
  assert.match(rule(".business .faq{"), /background:var\(--cream\)/);
  assert.match(rule(".business .faq{"), /color:var\(--ink\)/);
  assert.match(css, /--cream:#F5EBE2;/);
  assert.match(css, /--ink:#111111;/);
  // Pure white, in any form, across every faq-scoped rule in the file.
  const all = css.replace(/\/\*[\s\S]*?\*\//g, "");
  let checked = 0;
  for (const m of all.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const sel = m[1].split(/[\r\n]/).pop().trim();
    if (!/\.business \.faq/.test(sel)) continue;
    checked++;
    assert.ok(!/\bwhite\b|#fff\b|#ffffff\b|rgb\(\s*255|rgba\(\s*255/i.test(m[2]),
      `pure white in ${sel}`);
  }
  assert.ok(checked > 8, `only ${checked} rules were scanned`);

  // Rows are hairlines and nothing else.
  assert.match(rule(".business .faq details{"), /border-top:1px solid rgba\(17,17,17,\.30\)/);
  assert.ok(!/background:(?!var\(--cream\))/.test(code.replace(".business .faq{", "")),
    "something inside the FAQ got a background");
  assert.ok(!/box-shadow|border-radius/.test(code), "a card was introduced");
  assert.ok(!code.includes("gradient"), "a gradient was added");
  // No literal hex; every rgba is an ink alpha.
  for (const m of code.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) assert.fail(`a literal hex: ${m[0]}`);
  for (const m of code.matchAll(/rgba\(([^)]+)\)/g)) {
    const [r, g, b] = m[1].split(",").map(n => Number(n.trim()));
    assert.ok(r === 17 && g === 17 && b === 17, `a non-ink rgba: rgba(${m[1]})`);
  }
});

test("3b: the plus is the /our-matcha one - text, no circle, no colour", () => {
  const plus = rule(".business .faq summary span{");
  assert.match(plus, /font-weight:400/);
  assert.match(plus, /font-size:18px/);
  assert.match(plus, /color:var\(--ink\)/);
  assert.ok(!/border|background|border-radius/.test(plus), "the plus got a circle");
  // Hover is an opacity shift, nothing more.
  assert.match(rule(".business .faq summary:hover{"), /opacity:\.68/);
  // (text-transform is not a movement.)
  assert.ok(!/(^|[;{\s])transform:|scale\(|rotate\(/.test(code), "a movement was added");
  // The focus ring is the site's own - untouched, and not white.
  assert.ok(!code.includes("outline"), "the focus ring was overridden here");
  assert.match(css, /:focus-visible\{outline:3px solid var\(--blue\)/);
});

/* ══════════════════════════════════════════════════════════════
   4. TYPOGRAPHY
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
  assert.match(rule(".business .faq h2{"), /font-family:var\(--font-sans\)/);
  assert.match(rule(".business .faq h2 i{"), /font-family:var\(--font-display\)/);
  assert.match(rule(".business .faq h2 i{"), /font-style:italic/);

  const cap = t => Number(/clamp\([\d.]+px,[\d.]+vw,([\d.]+)px\)/.exec(t)[1]);
  assert.equal(cap(sizeOf(desktop, ".business .faq h2{")), 58);
  assert.equal(cap(sizeOf(desktop, ".business .faq h2 i{")), 62);
  assert.equal(cap(sizeOf(desktop, ".business .faq summary{")), 17);
  assert.equal(cap(sizeOf(desktop, ".business .faq details p{")), 16);
  assert.match(rule(".business .faq .eyebrow{"), /font-size:var\(--type-meta\)/);
  assert.match(css, /--type-meta:11px/);
  assert.match(rule(".business .faq .eyebrow{"), /letter-spacing:\.2em/);
  assert.match(rule(".business .faq summary{"), /font-weight:500/);
  assert.match(rule(".business .faq details p{"), /color:rgba\(17,17,17,\.82\)/);
  // The shared 98px h2 rule still exists for whatever else reads it -
  // it is answered here, not edited there.
  assert.match(css, /,\.faq h2\{font-size:clamp\(48px,7vw,98px\)/);
});

test("4b: the FAQ stays under the B2B hero at every width", () => {
  const heroBlock = css.slice(css.indexOf("/for-cafes PAGE HERO"), css.indexOf("INFO STRIP + MENU SECTION"));
  const heroCode = heroBlock.replace(/\/\*[\s\S]*?\*\//g, "");
  const heroD = heroCode.slice(0, heroCode.indexOf("@media"));
  const heroM = heroCode.slice(heroCode.indexOf("@media (max-width:900px)"));

  for (const w of [320, 360, 390, 430, 480, 640, 760, 761, 900, 1024, 1200, 1280, 1440, 1536, 1680, 1920]) {
    const heroSans = clampAt(sizeOf(w <= 900 ? heroM : heroD, ".b2b-hero .b2b-hero-line{"), w);
    const heroItal = clampAt(sizeOf(w <= 900 ? heroM : heroD, ".b2b-hero .b2b-hero-line-accent{"), w);
    const scope = w <= 760 ? mobile : desktop;
    const sans = clampAt(sizeOf(scope, ".business .faq h2{"), w);
    const ital = clampAt(sizeOf(scope, ".business .faq h2 i{"), w);
    assert.ok(sans < heroSans, `the FAQ sans (${sans}) reaches the hero (${heroSans}) at ${w}px`);
    assert.ok(ital < heroItal, `the FAQ italic (${ital}) reaches the hero italic (${heroItal}) at ${w}px`);
  }
});

/* ══════════════════════════════════════════════════════════════
   5. LAYOUT AND THE FREEZES
   ══════════════════════════════════════════════════════════════ */

test("5: the canonical rail, controlled rows, and a mobile step down", () => {
  const sec = rule(".business .faq{");
  assert.match(sec, /padding-inline:var\(--rail-gutter\)/);
  assert.match(sec, /max-width:calc\(var\(--rail-max\) \+ var\(--rail-gutter\) \* 2\)/);
  assert.match(sec, /margin-inline:auto/);
  assert.match(sec, /padding-block:clamp\(76px,6\.5vw,96px\) clamp\(80px,6\.5vw,104px\)/);
  // Exactly the geometry /our-matcha's FAQ uses.
  assert.match(css, /\.matcha-page \.faq\{[\s\S]*?max-width:calc\(var\(--rail-max\) \+ var\(--rail-gutter\) \* 2\)/);
  assert.ok(!/min-height|\dvh/.test(code), "the section reserves height");
  // Header to first row.
  assert.match(rule(".business .faq h2{"), /margin:clamp\(18px,1\.8vw,26px\) 0 clamp\(48px,4\.6vw,58px\)/);
  assert.match(rule(".business .faq summary{"), /padding:clamp\(22px,2\.2vw,26px\) 0/);
  assert.match(rule(".business .faq details p{"), /max-width:800px/);

  assert.match(mobile, /\.business \.faq h2 i\{font-size:clamp\(36px,9\.4vw,46px\)\}/);
  assert.match(mobile, /\.business \.faq summary\{[\s\S]*?font-size:16px/);
  assert.match(mobile, /\.business \.faq details p\{max-width:none;font-size:15px/);
});

test("5b: nothing else on either page moved", () => {
  // Every other /for-cafes section.
  const biz = read("app/BusinessCalculator.tsx");
  for (const marker of ['<section className="b2b-compare">', '<section className="b2b-portal-hint">',
                        '<section className="b2b-flow">', '<section className="b2b-support">',
                        '<section className="sample-callout">', 'id="lead"']) {
    assert.ok(biz.includes(marker), `a B2B section changed: ${marker}`);
  }
  assert.ok(biz.includes("const payload:LeadPayload={"), "the lead machinery changed");
  // The hero and the strip, in GloaSite.
  assert.match(site, /Dein Matcha\./);
  assert.match(site, /src="\/img\/B2B Packung\.png"/);
  assert.match(site, /const b2bFacts=\["SHIZUOKA, JAPAN"/);
  // The other pages' blocks.
  for (const marker of ["/about — ONE EDITORIAL SYSTEM", "/our-matcha PAGE HERO",
                        "/our-matcha FAQ + FINAL CTA", ".home-rail{"]) {
    assert.ok(css.includes(marker), `a frozen block went missing: ${marker}`);
  }
  // And the B2B FAQ is still the last thing ForCafes renders.
  assert.match(site, /<BusinessCalculator\/><BusinessFaq\/><\/main>/);
});
