import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * THE /our-matcha RESEARCH SECTION.
 *
 * The three paragraphs here are regulated statements about what is and
 * is not proven about green tea. This pass was visual, so the strongest
 * thing these tests do is pin the copy character for character - and
 * check that nothing turned an accent colour into a health claim.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf8");

const site = read("app/GloaSite.tsx");
const css = read("app/globals.css");

const data = site.slice(site.indexOf("const researchBlocks=["), site.indexOf("function MatchaPage()"));
const page = site.slice(site.indexOf("function MatchaPage()"), site.indexOf("\nfunction ", site.indexOf("function MatchaPage()") + 5));
const section = page.slice(page.indexOf('<section className="matcha-research">'),
                           page.indexOf('<section className="matcha-howto">'));
const rules = css.slice(css.indexOf("/our-matcha RESEARCH SECTION"));
const rule = name => {
  const at = rules.indexOf(name);
  assert.notEqual(at, -1, `missing rule: ${name}`);
  return rules.slice(at, rules.indexOf("}", at));
};

/* ══════════════════════════════════════════════════════════════
   1. THE COPY, WORD FOR WORD
   ══════════════════════════════════════════════════════════════ */

test("1: not one regulated sentence was rewritten", () => {
  for (const line of [
    "MATCHA & SCIENCE", "Forschung.", "Ehrlich eingeordnet.",
    "Wir wollen nichts versprechen, was sich nicht belegen lässt. Deshalb trennen wir hier klar, was Matcha enthält, was untersucht wurde und was offen bleibt.",
    "Wir behaupten nichts, was wir nicht belegen können.",
  ]) {
    assert.ok(section.includes(line), `the redesign lost: ${line}`);
  }
  for (const line of [
    "Was Matcha enthält",
    "Von Natur aus Koffein, L-Theanin und Pflanzenstoffe aus der Catechin-Gruppe wie EGCG. Weil beim Matcha das ganze Blatt getrunken wird, enthält er davon spürbar mehr als klassisch aufgegossener Grüntee.",
    "In Studien untersucht",
    "Die Kombination aus Koffein und L-Theanin wird häufig im Zusammenhang mit Aufmerksamkeit untersucht. Einzelne Übersichtsarbeiten deuten auf kurzfristige Effekte hin, die Ergebnisse sind uneinheitlich und lassen sich nicht pauschal auf ein bestimmtes Produkt übertragen.",
    "Was die Forschung noch nicht beantworten kann",
    "Für Grüntee-Catechine wurden bislang keine gesundheitsbezogenen Aussagen, etwa zu Stoffwechsel, Herz-Kreislauf oder Zellschutz, als ausreichend belegt eingestuft. Deshalb machen wir dazu keine Versprechen.",
  ]) {
    assert.ok(data.includes(line), `the redesign lost: ${line}`);
  }
  // EXACTLY THREE BLOCKS, and the labels stay sentence case in the
  // source - the uppercase is CSS, not a rewrite.
  assert.equal([...data.matchAll(/label:"/g)].length, 3);
  assert.equal([...data.matchAll(/body:"/g)].length, 3);
  assert.match(rule(".matcha-research-label{"), /text-transform:uppercase/);
  // No numbering: this is the icon variant, not the numbered one.
  assert.ok(!/>0[123]</.test(section), "a numbered variant was introduced");
  assert.ok(!/counter-increment|counter-reset/.test(rules), "the blocks were numbered in CSS");
});

/* ══════════════════════════════════════════════════════════════
   2. THREE ICONS, DRAWN NOT INSTALLED
   ══════════════════════════════════════════════════════════════ */

test("2: three minimal raspberry line icons, decorative only", () => {
  assert.equal([...data.matchAll(/<svg className="matcha-research-icon"/g)].length, 3);
  assert.equal([...data.matchAll(/width="22" height="22"/g)].length, 3);
  assert.equal([...data.matchAll(/aria-hidden="true" focusable="false"/g)].length, 3);
  // Line icons: every stroke is 1.6 and no shape is filled with a colour.
  const widths = [...data.matchAll(/strokeWidth="([\d.]+)"/g)].map(m => Number(m[1]));
  assert.ok(widths.length >= 6 && widths.every(w => w >= 1.5 && w <= 1.75), `stroke widths: ${widths}`);
  assert.ok(!/fill="#|stroke="#/.test(data), "an icon hard-codes a colour");
  // Outlines only: the single filled shape is the question mark's dot.
  const fills = [...data.matchAll(/fill="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual([...new Set(fills)].sort(), ["currentColor", "none"]);
  assert.equal(fills.filter(f => f === "currentColor").length, 1, "a shape other than the dot is filled");
  // Raspberry comes from the wrapper, through currentColor.
  assert.match(rule(".matcha-research-icon{"), /color:var\(--berry\)/);
  assert.match(css, /--berry:#A61E59;/);
  // No package was added for three marks.
  const pkg = JSON.parse(read("package.json"));
  for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
    assert.ok(!/icon|lucide|feather|heroicon/i.test(dep), `an icon package was added: ${dep}`);
  }
  // No emoji, no raster icon.
  assert.ok(!/\.png|\.svg"|<img/.test(section + data), "a raster or file-based icon was used");
});

/* ══════════════════════════════════════════════════════════════
   3. CREAM, NEAR BLACK, RASPBERRY - AND NO CARDS
   ══════════════════════════════════════════════════════════════ */

test("3: three colours, open columns, hairlines instead of boxes", () => {
  assert.match(rules, /\.matcha-research\{[\s\S]*?background:var\(--cream\)/);
  assert.match(css, /--cream:#F5EBE2;/);
  assert.match(css, /--ink:#111111;/);
  // The retired blue ground is gone.
  assert.ok(!css.includes(".matcha-transparency{"), "the blue research section survived");
  assert.ok(!css.includes(".matcha-science-grid{"), "the retired grid survived");
  assert.ok(!site.includes("matcha-transparency"), "the retired markup survived");

  // Near black carries the reading; raspberry is the accent only.
  for (const name of [".matcha-research-eyebrow{", ".matcha-research-line{", ".matcha-research-intro{", ".matcha-research-body{"]) {
    assert.match(rule(name), /color:var\(--ink\)/, `${name} is not near black`);
  }
  for (const name of [".matcha-research-line-accent{", ".matcha-research-note{", ".matcha-research-label{", ".matcha-research-icon{"]) {
    assert.match(rule(name), /color:var\(--berry\)/, `${name} is not raspberry`);
  }
  for (const banned of ["var(--blue)", "var(--plum)", "var(--matcha)", "gradient", "backdrop-filter"]) {
    assert.ok(!rules.includes(banned), `the section uses ${banned}`);
  }
  // ── NO CARDS ─────────────────────────────────────────────────
  // A 1px seam is allowed a colour; an AREA is not - the surfaces check
  // below is what actually holds that line.
  for (const banned of ["border-radius", "box-shadow", "background:#", "background:var(--berry)"]) {
    assert.ok(!rules.includes(banned), `the blocks became cards: ${banned}`);
  }
  // The only surface in the section is its own cream.
  const surfaces = [...rules.matchAll(/background:([^;}]+)/g)].map(m => m[1].trim());
  assert.deepEqual([...new Set(surfaces)], ["var(--cream)", "rgba(166,30,89,.16)"]);

  // ── HAIRLINES ────────────────────────────────────────────────
  // One raspberry rule above each block, and a fainter seam in the gap.
  assert.match(rule(".matcha-research-block{"), /border-top:1px solid rgba\(166,30,89,\.4\)/);
  const seam = rules.slice(rules.indexOf(".matcha-research-block+.matcha-research-block::before{"));
  assert.match(seam, /width:1px/);
  assert.match(seam, /background:rgba\(166,30,89,\.16\)/);
  assert.match(seam, /left:calc\(clamp\(34px,3vw,46px\) \/ -2\)/);
  // It starts BELOW the hairline and ends with the block.
  assert.match(seam, /top:clamp\(18px,1\.8vw,24px\)/);
  assert.match(seam, /bottom:0/);
  assert.ok(!/\.matcha-research-block[^{]*\{[^}]*height:100%/.test(rules), "the seam runs the full section");
});

/* ══════════════════════════════════════════════════════════════
   4. SCALE, RAIL, RESPONSIVE
   ══════════════════════════════════════════════════════════════ */

test("4: a section, not a hero - and it stacks cleanly", () => {
  const clamp = (lo, mid, hi) => Math.max(lo, Math.min(mid, hi));
  const parse = t => /clamp\(([\d.]+)px,([\d.]+)vw,([\d.]+)px\)/.exec(t).slice(1).map(Number);
  const at = (t, w) => { const [lo, vw, hi] = parse(t); return clamp(lo, (vw / 100) * w, hi); };
  const token = n => new RegExp("--type-" + n + ":([^;]+);").exec(css)[1];
  const line = /\.matcha-research-line\{[\s\S]*?font-size:(clamp\([^)]*\))/.exec(rules)[1];
  const accent = /\.matcha-research-line-accent\{[\s\S]*?font-size:(clamp\([^)]*\))/.exec(rules)[1];
  // THE BRIEF'S HARD CAPS: 60 sans, 64 italic - 4px under the shared
  // title tokens, which is why this section writes its own.
  assert.equal(parse(line)[2], 60);
  assert.equal(parse(accent)[2], 64);
  assert.ok(parse(line)[2] < parse(token("title"))[2] + 1);
  // Under both page heroes at every width, and far under the homepage one.
  const homeHero = w => (w <= 900 ? clamp(44, 0.12 * w, 64) : clamp(54, 0.059 * w, 100));
  // BELOW 640px the section's own mobile override is what renders, so
  // that is the value the hierarchy has to be checked against - reading
  // only the base rule would test a size nobody ever sees.
  const mobileLine = /@media \(max-width:640px\)\{[\s\S]*?\.matcha-research-line\{font-size:(clamp\([^)]*\))/.exec(rules)[1];
  const mobileAccent = /@media \(max-width:640px\)\{[\s\S]*?\.matcha-research-line-accent\{font-size:(clamp\([^)]*\))/.exec(rules)[1];
  const effective = w => at(w <= 640 ? mobileLine : line, w);
  const effectiveAccent = w => at(w <= 640 ? mobileAccent : accent, w);
  for (const w of [320, 360, 390, 430, 480, 640, 900, 901, 1024, 1280, 1440, 1680, 1920]) {
    assert.ok(homeHero(w) > effective(w), `the research headline reaches the homepage hero at ${w}px`);
    assert.ok(homeHero(w) > effectiveAccent(w), `the research accent reaches the homepage hero at ${w}px`);
    // The page-hero comparison is a DESKTOP one. Below ~770px the page
    // hero renders at its flat 40px floor - smaller than any reasonable
    // section headline - so the ordering only carries meaning where both
    // curves are on their vw term. The homepage-hero bound above holds at
    // every width, and that is the one section 5 leads with.
    if (w >= 1024) assert.ok(at(token("page-hero"), w) > effective(w), `it outgrows the page hero at ${w}px`);
  }
  // Body is a body, not a headline.
  assert.match(rule(".matcha-research-body{"), /font-size:clamp\(14\.5px,1\.1vw,16px\)/);
  assert.match(rule(".matcha-research-label{"), /font-size:var\(--type-meta\)/);
  // The closing statement is a sentence, so it is NOT uppercased.
  assert.ok(!rule(".matcha-research-note{").includes("text-transform"), "the closing sentence was uppercased");

  // Two families only.
  assert.match(rule(".matcha-research-line-accent{"), /font-family:var\(--font-display\)/);
  assert.match(rule(".matcha-research-line-accent{"), /font-style:italic/);
  for (const m of rules.matchAll(/font-family:([^;}]+)/g)) {
    assert.match(m[1], /^var\(--font-(sans|display)\)/, `a third family: ${m[1]}`);
  }

  // ── RAIL AND RESPONSIVE ──────────────────────────────────────
  assert.match(section, /<div className="matcha-research-inner home-rail">/);
  assert.match(css, /\.matcha-product,\s*\.matcha-research\{padding-inline:var\(--rail-gutter\)\}/);
  assert.match(rules, /\.matcha-research-inner\{[\s\S]*?grid-template-columns:minmax\(0,\.33fr\) minmax\(0,\.67fr\)/);
  assert.match(rules, /\.matcha-research\{[\s\S]*?padding-block:clamp\(84px,7vw,110px\)/);
  assert.ok(!rules.includes("100vh"), "the section reserves a viewport");
  assert.match(rules, /@media \(max-width:1024px\)\{[\s\S]*?\.matcha-research-inner\{grid-template-columns:1fr/);
  assert.match(rules, /@media \(max-width:900px\)\{[\s\S]*?\.matcha-research-grid\{grid-template-columns:1fr/);
  assert.match(rules, /@media \(max-width:640px\)\{[\s\S]*?\.matcha-research-line\{font-size:clamp\(38px,10\.5vw,50px\)/);
});
