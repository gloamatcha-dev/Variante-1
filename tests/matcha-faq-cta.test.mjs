import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * THE LAST TWO SECTIONS OF /our-matcha.
 *
 * This pass was CSS only, so the sharpest thing these tests do is prove
 * that: the FAQ's markup, its questions, its disclosure behaviour and
 * both CTA routes are the ones that were already there, and the new
 * rules are scoped so /for-cafes - which renders the SAME .faq class -
 * keeps what it had.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf8");

const site = read("app/GloaSite.tsx");
const css = read("app/globals.css");

const page = site.slice(site.indexOf("function MatchaPage()"), site.indexOf("\nfunction ", site.indexOf("function MatchaPage()") + 5));
const faq = page.slice(page.indexOf('<section className="faq"'), page.indexOf('<section className="matcha-cta">'));
const cta = page.slice(page.indexOf('<section className="matcha-cta">'));
// Bounded at the NEXT page block. Without an end this slice ran to the
// end of the file and silently absorbed every block appended after it.
const rules = css.slice(css.indexOf("/our-matcha FAQ + FINAL CTA"), css.indexOf("/about — ONE EDITORIAL SYSTEM"));
const rule = name => {
  const at = rules.indexOf(name);
  assert.notEqual(at, -1, `missing rule: ${name}`);
  return rules.slice(at, rules.indexOf("}", at));
};

/* ══════════════════════════════════════════════════════════════
   1. NOTHING STRUCTURAL MOVED
   ══════════════════════════════════════════════════════════════ */

test("1: no markup, no copy and no behaviour changed in either section", () => {
  // The FAQ is the same three elements it always was.
  assert.match(faq, /<section className="faq"><p className="eyebrow">FAQ<\/p><h2>Fragen\?<br\/><i>Antworten\.<\/i><\/h2>\{matchaFaq\.map\(\(\[q,a\]\)=><details key=\{q\}><summary>\{q\}<span>\+<\/span><\/summary><p>\{a\}<\/p><\/details>\)\}<\/section>/);
  // Native <details>, no hand-rolled state, no click handler.
  assert.ok(!faq.includes("onClick") && !faq.includes("aria-expanded") && !faq.includes("useState"));
  // Every question and answer still comes from the same list.
  const data = site.slice(site.indexOf("const matchaFaq"), site.indexOf("];", site.indexOf("const matchaFaq")));
  assert.ok(data.length > 0, "the FAQ data moved");
  assert.ok([...data.matchAll(/\["/g)].length >= 4, "questions were removed");

  // The CTA is the same markup and the same two routes.
  assert.match(cta, /<section className="matcha-cta"><p className="eyebrow">MATCHA FOR REAL LIFE\.<\/p><h2>Bereit für<br\/><i>deinen Matcha\?<\/i><\/h2>/);
  assert.match(cta, /<Link className="cta" href="\/shop">Zum Shop<\/Link>/);
  assert.match(cta, /<Link className="cta secondary" href="\/for-cafes">B2B →<\/Link>/);
  // "ZUM SHOP" is CSS uppercase, not a rewritten string - and the
  // primary CTA carries no arrow.
  assert.ok(!/Zum Shop\s*→/.test(cta), "an arrow was added to the primary CTA");
  assert.match(rules, /\.matcha-cta \.matcha-cta-actions \.cta\{[\s\S]*?text-transform:uppercase/);

  // THE WHOLE PASS IS CSS. GloaSite.tsx is not in this change at all.
  assert.ok(!page.includes("faq-inner") && !page.includes("matcha-cta-inner"),
    "a wrapper was introduced");
});

/* ══════════════════════════════════════════════════════════════
   2. THE SCOPE - /for-cafes RENDERS THE SAME CLASS
   ══════════════════════════════════════════════════════════════ */

test("2: the FAQ rules are page-scoped, so the B2B FAQ is untouched", () => {
  assert.equal([...site.matchAll(/className="faq"/g)].length, 2, "the .faq class count changed");
  assert.match(site, /function BusinessFaq/);
  // EVERY new FAQ rule starts with .matcha-page - a bare `.faq` rule
  // here would have restyled /for-cafes.
  for (const m of rules.matchAll(/(^|\n)([^{@\n][^{\n]*)\{/g)) {
    const sel = m[2].trim();
    if (!sel.includes(".faq")) continue;
    assert.ok(sel.startsWith(".matcha-page .faq"), `an unscoped FAQ rule: ${sel}`);
  }
  // The original shared rules are still there for the B2B page.
  assert.match(css, /\.faq\{padding:110px 10vw\}/);
  assert.match(css, /\.faq details\{border-top:1px solid var\(--plum\)\}/);
  assert.match(css, /\.faq summary\{padding:25px 0/);
});

/* ══════════════════════════════════════════════════════════════
   3. FAQ TYPOGRAPHY
   ══════════════════════════════════════════════════════════════ */

test("3: section scale, not the 98px the shared h2 rule was giving it", () => {
  const title = rule(".matcha-page .faq h2{");
  assert.match(title, /font-size:clamp\(48px,4\.3vw,60px\)/);
  assert.match(title, /font-family:var\(--font-sans\)/);
  assert.match(title, /color:var\(--ink\)/);
  const accent = rule(".matcha-page .faq h2 i{");
  assert.match(accent, /font-size:clamp\(50px,4\.6vw,64px\)/);
  assert.match(accent, /font-family:var\(--font-display\)/);
  assert.match(accent, /font-style:italic/);
  // The shared 98px rule still exists for the sections that need it -
  // it is answered here, not edited there.
  assert.match(css, /\.faq h2\{font-size:clamp\(48px,7vw,98px\)|,\.faq h2[,{]/);
  assert.match(rule(".matcha-page .faq .eyebrow{"), /font-size:var\(--type-meta\)/);
  assert.match(rule(".matcha-page .faq summary{"), /font-size:clamp\(16px,1\.2vw,17px\)/);
  assert.match(rule(".matcha-page .faq details p{"), /font-size:clamp\(15px,1\.1vw,16px\)/);
  assert.match(rule(".matcha-page .faq details p{"), /max-width:760px/);
  // The "+" is sized, not emboldened, and no button was built around it.
  assert.match(rules, /\.matcha-page \.faq summary span\{font-weight:400;font-size:19px/);
  // Scoped to the FAQ half of the block - the raspberry below it belongs
  // to the CTA.
  const faqRules = rules.slice(rules.indexOf("/* ── FAQ"), rules.indexOf("FINAL CTA ─"));
  for (const banned of ["border-radius", "background:var(--berry)", "@keyframes", "box-shadow"]) {
    assert.ok(!faqRules.includes(banned), `the FAQ grew ${banned}`);
  }
});

/* ══════════════════════════════════════════════════════════════
   4. THE RASPBERRY CTA
   ══════════════════════════════════════════════════════════════ */

test("4: raspberry ground, cream type, cream button and its inverse", () => {
  assert.match(rule(".matcha-cta{"), /background:var\(--berry\)/);
  assert.match(css, /--berry:#A61E59;/);
  assert.match(css, /--cream:#F5EBE2;/);
  for (const name of [".matcha-cta .eyebrow{", ".matcha-page .matcha-cta h2{", ".matcha-page .matcha-cta h2 i{"]) {
    assert.match(rule(name), /color:var\(--cream\)/, `${name} is not cream`);
  }
  assert.match(rule(".matcha-page .matcha-cta h2{"), /font-size:clamp\(48px,4\.4vw,60px\)/);
  assert.match(rule(".matcha-page .matcha-cta h2 i{"), /font-size:clamp\(52px,4\.8vw,66px\)/);
  assert.match(rule(".matcha-page .matcha-cta h2 i{"), /font-family:var\(--font-display\)/);

  // ── THE TWO BUTTONS ──────────────────────────────────────────
  const box = rules.slice(rules.indexOf(".matcha-cta .matcha-cta-actions .cta{"));
  assert.match(box, /min-height:54px/);
  assert.match(box, /padding:17px 30px/);
  assert.match(box, /border-radius:0/);
  assert.match(box, /font-size:12px/);
  assert.match(box, /letter-spacing:\.14em/);
  // Primary: cream on raspberry. Secondary: the inverse, outlined.
  const primary = rules.slice(rules.indexOf(".matcha-cta .matcha-cta-actions .cta{", rules.indexOf(".matcha-cta .matcha-cta-actions .cta{") + 1));
  assert.match(primary, /background:var\(--cream\)/);
  assert.match(primary, /color:var\(--berry\)/);
  const secondary = rules.slice(rules.indexOf(".matcha-cta .matcha-cta-actions .cta.secondary{"));
  assert.match(secondary, /background:transparent/);
  assert.match(secondary, /color:var\(--cream\)/);
  assert.match(secondary, /border:1px solid rgba\(245,235,226,\.65\)/);
  // Hovers are subtle and short.
  for (const m of rules.matchAll(/transition:([^;}]+)/g)) {
    assert.ok(!/\d{3,}ms|[3-9]s/.test(m[1]), `a slow transition: ${m[1]}`);
  }
  // No decoration was invented.
  for (const banned of ["gradient", "backdrop-filter", "box-shadow:0", "<img", "<svg"]) {
    assert.ok(!rules.includes(banned) && !cta.includes(banned), `the CTA grew ${banned}`);
  }
  assert.ok(!rules.includes("100vh"), "the CTA reserves a viewport");
});

/* ══════════════════════════════════════════════════════════════
   5. SCALE AND RAIL
   ══════════════════════════════════════════════════════════════ */

test("5: both headlines stay under the page hero, on the canonical rail", () => {
  const clamp = (lo, mid, hi) => Math.max(lo, Math.min(mid, hi));
  const parse = t => /clamp\(([\d.]+)px,([\d.]+)vw,([\d.]+)px\)/.exec(t).slice(1).map(Number);
  const at = (t, w) => { const [lo, vw, hi] = parse(t); return clamp(lo, (vw / 100) * w, hi); };
  const token = n => new RegExp("--type-" + n + ":([^;]+);").exec(css)[1];
  const pick = (sel, mobile) => {
    const scope = mobile ? rules.slice(rules.indexOf("@media (max-width:640px)")) : rules;
    return /font-size:(clamp\([^)]*\))/.exec(scope.slice(scope.indexOf(sel)))[1];
  };
  const homeHero = w => (w <= 900 ? clamp(44, 0.12 * w, 64) : clamp(54, 0.059 * w, 100));
  for (const sel of [".matcha-page .faq h2{", ".matcha-page .faq h2 i{",
                     ".matcha-page .matcha-cta h2{", ".matcha-page .matcha-cta h2 i{"]) {
    const desktop = pick(sel, false);
    const mobile = pick(sel, true);
    for (const w of [320, 360, 390, 430, 480, 640, 900, 901, 1024, 1280, 1440, 1680, 1920]) {
      const size = at(w <= 640 ? mobile : desktop, w);
      assert.ok(homeHero(w) > size, `${sel} reaches the homepage hero at ${w}px`);
      if (w >= 1024) assert.ok(at(token("page-hero"), w) > size, `${sel} outgrows the page hero at ${w}px`);
    }
  }
  // Two families only.
  for (const m of rules.matchAll(/font-family:([^;}]+)/g)) {
    assert.match(m[1], /^var\(--font-(sans|display)\)/, `a third family: ${m[1]}`);
  }
  // The canonical rail, for both.
  assert.match(css, /\.matcha-page \.faq,\s*\.matcha-cta\{padding-inline:var\(--rail-gutter\)\}/);
  assert.match(rule(".matcha-page .faq{"), /max-width:calc\(var\(--rail-max\) \+ var\(--rail-gutter\) \* 2\)/);
  assert.match(rule(".matcha-page .faq{"), /margin-inline:auto/);
});
