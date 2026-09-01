import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * /for-cafes — THE TWO ORDERING MODELS.
 *
 * Was a headline on the shared clamp(48px,7vw,98px) h2 rule - larger
 * than the page hero above it - over two bordered boxes, with the
 * explanatory paragraph repeated underneath them.
 *
 * Now three open columns: intro, Flexibel, Planbar. These tests pin the
 * copy (including the commercial terms, which must not drift), the
 * absence of pricing cards, the single explanatory paragraph, the CTA
 * routes and the type hierarchy. They are not pixel tests.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf8");

const src = read("app/BusinessCalculator.tsx");
const css = read("app/globals.css");

const section = src.slice(src.indexOf('<section className="b2b-compare">'),
                          src.indexOf('<section className="b2b-portal-hint">'));
assert.ok(section.length > 400, "the section markup was not found");
const data = src.slice(src.indexOf("const b2bModels"), src.indexOf("];", src.indexOf("const b2bModels")));

const blockAt = css.indexOf("THE TWO ORDERING MODELS");
assert.notEqual(blockAt, -1, "the CSS block was not found");
/* Bounded at the NEXT page block, so a block appended after this one
   cannot answer for - or trip - an assertion about this section. */
const rules = css.slice(css.lastIndexOf("/*", blockAt), css.lastIndexOf("/*", css.indexOf("B2B CUSTOMER PORTAL SECTION")));
const code = rules.replace(/\/\*[\s\S]*?\*\//g, "");
const desktop = code.slice(0, code.indexOf("@media"));
const mobile = code.slice(code.indexOf("@media (max-width:760px)"));

const rule = name => {
  const at = code.indexOf(name);
  assert.notEqual(at, -1, `missing rule: ${name}`);
  return code.slice(at, code.indexOf("}", at));
};

/* ══════════════════════════════════════════════════════════════
   1. COPY, AND THE COMMERCIAL TERMS THAT MUST NOT DRIFT
   ══════════════════════════════════════════════════════════════ */

test("1: every approved line renders, and nothing else", () => {
  for (const line of [
    "FLEXIBEL &amp; PLANBAR",
    "Flexibel bestellen",
    "oder langfristig profitieren.",
    "Je länger wir deinen Bedarf planen können, desto größer ist dein Preisvorteil. Preise und Konditionen erhältst du auf Anfrage.",
  ]) assert.ok(section.includes(line), `missing intro copy: ${line}`);

  for (const line of [
    "FLEXIBEL", "Regelmäßige Belieferung",
    "5 % Preisvorteil gegenüber Einzelbestellung", "Flexible monatliche Lieferung",
    "Konditionen anfragen",
    "PLANBAR", "12-Monats-Partnerschaft",
    "10 % Preisvorteil gegenüber Einzelbestellung", "Planbare monatliche Belieferung",
    "Partnerschaft anfragen",
  ]) assert.ok(data.includes(line), `missing model copy: ${line}`);

  // The eyebrow the approved copy contract replaces.
  assert.ok(!section.includes("BEZUGSMODELLE"), "the old eyebrow survived");
  // And the reference link that was never part of the approved content.
  assert.ok(!section.includes("MEHR ERFAHREN") && !section.includes("Mehr erfahren"));
  // No badge copy of any kind.
  for (const banned of ["Most popular", "Empfohlen", "Beliebt", "Recommended", "Best value",
                        "Bestseller", "Top"]) {
    assert.ok(!section.includes(banned) && !data.includes(banned), `a badge label: ${banned}`);
  }
});

test("1b: the commercial terms are the ones that were already here", () => {
  assert.ok(data.includes("5 % Preisvorteil"), "the 5 % changed");
  assert.ok(data.includes("10 % Preisvorteil"), "the 10 % changed");
  assert.ok(data.includes("12-Monats-Partnerschaft"), "the 12-month term changed");
  // Exactly two models, exactly two benefits each.
  assert.equal([...data.matchAll(/key:"/g)].length, 2);
  assert.equal([...data.matchAll(/benefits:\[/g)].length, 2);
  // No word that would re-frame the offer as a subscription.
  for (const banned of ["Abo", "Subscription", "automatisch", "verlängert", "Mindestabnahme",
                        "jährlich", "Kündigung"]) {
    assert.ok(!data.includes(banned) && !section.includes(banned), `a new commercial term: ${banned}`);
  }
  // No price, no number beyond the two discounts.
  assert.ok(!section.includes("€") && !data.includes("€"));
});

test("1c: the explanatory paragraph is rendered exactly ONCE", () => {
  assert.equal([...section.matchAll(/Je länger wir deinen Bedarf/g)].length, 1,
    "the explanatory paragraph is duplicated");
  assert.equal([...section.matchAll(/b2b-compare-note/g)].length, 1);
  // It now lives in the intro, above the two models - not under them.
  assert.ok(section.indexOf("b2b-compare-note") < section.indexOf("b2bModels.map"),
    "the paragraph is still below the offers");
});

test("1d: both CTAs keep their handler, and both carry the arrow", () => {
  assert.equal([...section.matchAll(/onClick=\{\(\)=>choose\("wholesale"\)\}/g)].length, 1,
    "the request handler changed");
  assert.match(section, /<button className="cta b2b-model-cta" onClick=\{\(\)=>choose\("wholesale"\)\}>\{m\.cta\} <span aria-hidden="true">→<\/span><\/button>/);
  // The handler itself is untouched: same intent, same tracking, same anchor.
  assert.match(src, /const choose=\(i:"wholesale"\|"sample"\)=>\{setIntent\(i\);track\(i==="sample"\?"sample_request_start":"wholesale_request_start"\);document\.getElementById\("lead"\)\?\.scrollIntoView/);
  // Internal action CTAs, so the arrow is → and never ↗.
  assert.ok(!section.includes("↗"));
});

test("1e: the lead machinery in this file was not touched", () => {
  // This file also owns the B2B lead form, which is why it is named in
  // the working-tree guard in tests/annual-plan-foundation-migration.mjs.
  // The claim made there - that this pass is presentation only - is
  // asserted HERE, against the source, so it survives the commit.
  for (const sig of [
    'const [intent,setIntent]=useState<"wholesale"|"sample">',
    'const submit=(e:React.FormEvent<HTMLFormElement>)=>{',
    "const payload:LeadPayload={",
    'window.dispatchEvent(new CustomEvent("gloa:b2b-lead",{detail:payload}))',
    'track(intent==="sample"?"sample_request_submit":"wholesale_request_submit")',
    '<section id="lead" className="lead-section">',
    'name="contact_name"', 'name="business_name"', 'name="email"',
    'name="business_type"', 'name="locations"',
  ]) assert.ok(src.includes(sig), `the lead machinery changed: ${sig}`);
  // And nothing in this pass reaches a network, a store or a price.
  assert.ok(!section.includes("fetch(") && !section.includes("supabase")
    && !section.includes("stripe") && !section.includes("price"),
    "the section grew a runtime dependency");
});

/* ══════════════════════════════════════════════════════════════
   2. OPEN COLUMNS, NOT PRICING CARDS
   ══════════════════════════════════════════════════════════════ */

test("2: nothing in the section is a card", () => {
  assert.ok(!src.includes("b2b-compare-card"), "the card markup survived");
  assert.ok(!css.includes(".b2b-compare-card"), "the card rules survived");
  assert.ok(!css.includes(".b2b-compare-grid"), "the old two-column grid survived");

  // No shadow anywhere, and no radius except the two icon discs.
  assert.ok(!/box-shadow:(?!none)/.test(code), "a shadow was added");
  for (const m of code.matchAll(/border-radius:([^;}]+)/g)) {
    assert.ok(["0", "50%"].includes(m[1].trim()), `an unexpected radius: ${m[1]}`);
  }
  // The model column paints nothing at all.
  const model = rule(".b2b-model{");
  assert.ok(!/background|border(?!-)/.test(model), "the model column became a box");
  // Only the two CTAs and the two icon discs carry a background.
  const backgrounds = [...code.matchAll(/background:([^;}]+)/g)].map(m => m[1].trim());
  for (const b of backgrounds) {
    assert.ok(/^var\(--(cream|blue|plum)\)$/.test(b) || /^rgba\((166,30,89|79,58,91|17,17,17)/.test(b)
      || b === "transparent" || b === "none",
      `an unexpected painted surface: ${b}`);
  }
  // The only full borders are on the CTAs.
  for (const m of code.matchAll(/(^|\n)\s*border:([^;}]+)/g)) {
    assert.match(m[2].trim(), /^1px solid var\(--(blue|plum)\)$/, `a box border: ${m[2]}`);
  }
});

test("2b: the separators are hairlines in the gap, not edges", () => {
  const seam = rule(".b2b-model::before{");
  assert.match(seam, /position:absolute/);
  assert.match(seam, /width:1px/);
  assert.match(seam, /height:76%/);
  assert.match(seam, /background:rgba\(17,17,17,\.13\)/);
  assert.match(seam, /left:calc\(var\(--col-gap\) \/ -2\)/);
  // Under the title, a second hairline - a rule, not a border on a box.
  assert.match(rule(".b2b-model-rule{"), /height:1px/);
  assert.match(rule(".b2b-model-rule{"), /background:rgba\(17,17,17,\.14\)/);
  assert.match(section, /<span className="b2b-model-rule" aria-hidden="true"\/>/);
  // Vertical seams go on mobile; the models gain a horizontal one.
  assert.match(mobile, /\.b2b-model::before\{content:none\}/);
  assert.match(mobile, /border-top:1px solid rgba\(17,17,17,\.14\)/);
  // Tablet keeps only the seam between the two models.
  const tablet = code.slice(code.indexOf("@media (max-width:1100px)"), code.indexOf("@media (max-width:760px)"));
  assert.match(tablet, /\.b2b-model-flex::before\{content:none\}/);
  assert.match(tablet, /grid-column:1 \/ -1/);
});

/* ══════════════════════════════════════════════════════════════
   3. COLOUR
   ══════════════════════════════════════════════════════════════ */

test("3: cream ground, blue CTA, plum CTA, raspberry only as a label", () => {
  assert.match(rule(".b2b-compare{"), /background:var\(--cream\)/);
  assert.match(rule(".b2b-compare{"), /color:var\(--ink\)/);
  assert.match(rule(".b2b-compare .b2b-model-flex .b2b-model-cta{"), /background:var\(--blue\)/);
  assert.match(rule(".b2b-compare .b2b-model-plan .b2b-model-cta{"), /background:var\(--plum\)/);
  for (const [sel, token] of [[".b2b-model-flex .b2b-model-eyebrow{", "blue"],
                              [".b2b-model-plan .b2b-model-eyebrow{", "plum"],
                              [".b2b-model-flex .b2b-model-check{", "blue"],
                              [".b2b-model-plan .b2b-model-check{", "plum"]]) {
    assert.match(rule(sel), new RegExp(`color:var\\(--${token}\\)`), `${sel} is not ${token}`);
  }
  // Raspberry appears twice and only as an accent: the intro eyebrow and
  // the 6% disc behind the Flexibel mark.
  assert.match(rule(".b2b-compare .b2b-compare-eyebrow{"), /color:var\(--berry\)/);
  assert.equal([...code.matchAll(/var\(--berry\)|rgba\(166,30,89/g)].length, 2,
    "raspberry is doing more than accent work here");

  assert.match(css, /--cream:#F5EBE2;/);
  assert.match(css, /--ink:#111111;/);
  assert.match(css, /--blue:#1746D1;/);
  assert.match(css, /--plum:#4F3A5B;/);
  assert.match(css, /--berry:#A61E59;/);
  // No literal hex, no gradient, no new colour.
  for (const m of code.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) assert.fail(`a literal hex: ${m[0]}`);
  assert.ok(!code.includes("gradient"), "a gradient was added");
  for (const m of code.matchAll(/rgba\(([^)]+)\)/g)) {
    const [r, g, b] = m[1].split(",").map(n => Number(n.trim()));
    const ok = (r === 17 && g === 17 && b === 17) || (r === 166 && g === 30 && b === 89)
      || (r === 79 && g === 58 && b === 91);
    assert.ok(ok, `a non-brand rgba: rgba(${m[1]})`);
  }
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
  assert.match(rule(".b2b-compare .b2b-compare-line{"), /font-family:var\(--font-sans\)/);
  assert.match(rule(".b2b-compare .b2b-compare-line-accent{"), /font-family:var\(--font-display\)/);
  assert.match(rule(".b2b-compare .b2b-compare-line-accent{"), /font-style:italic/);

  const cap = t => Number(/clamp\([\d.]+px,[\d.]+vw,([\d.]+)px\)/.exec(t)[1]);
  assert.equal(cap(sizeOf(desktop, ".b2b-compare .b2b-compare-line{")), 58);
  assert.equal(cap(sizeOf(desktop, ".b2b-compare .b2b-compare-line-accent{")), 62);
  assert.equal(cap(sizeOf(desktop, ".b2b-model-title{")), 28);
  assert.match(rule(".b2b-compare .b2b-compare-eyebrow{"), /font-size:var\(--type-meta\)/);
  assert.match(rule(".b2b-compare .b2b-model-eyebrow{"), /font-size:var\(--type-meta\)/);
  assert.match(css, /--type-meta:11px/);
  assert.match(rule(".b2b-compare .b2b-compare-note{"), /font-size:clamp\(15px,1\.2vw,16px\)/);
  assert.match(rule(".b2b-model-benefits li{"), /font-size:clamp\(14px,1\.1vw,15px\)/);
  assert.match(rule(".b2b-compare .b2b-model-cta{"), /font-size:12px/);
});

test("4b: the section stays under the B2B hero at every width", () => {
  const heroBlock = css.slice(css.indexOf("/for-cafes PAGE HERO"), css.indexOf("INFO STRIP + MENU SECTION"));
  const heroCode = heroBlock.replace(/\/\*[\s\S]*?\*\//g, "");
  const heroD = heroCode.slice(0, heroCode.indexOf("@media"));
  const heroM = heroCode.slice(heroCode.indexOf("@media (max-width:900px)"));
  const pick = (d, m, sel, w) => clampAt(sizeOf(w <= 760 ? m : d, sel), w);

  for (const w of [320, 360, 390, 430, 480, 640, 760, 761, 900, 1024, 1200, 1280, 1440, 1536, 1680, 1920]) {
    const heroSans = clampAt(sizeOf(w <= 900 ? heroM : heroD, ".b2b-hero .b2b-hero-line{"), w);
    const heroItal = clampAt(sizeOf(w <= 900 ? heroM : heroD, ".b2b-hero .b2b-hero-line-accent{"), w);
    const sans = pick(desktop, mobile, ".b2b-compare .b2b-compare-line{", w);
    const ital = pick(desktop, mobile, ".b2b-compare .b2b-compare-line-accent{", w);
    const offer = pick(desktop, mobile, ".b2b-model-title{", w);

    assert.ok(sans < heroSans, `the section sans (${sans}) reaches the hero (${heroSans}) at ${w}px`);
    assert.ok(ital < heroItal, `the section italic (${ital}) reaches the hero italic (${heroItal}) at ${w}px`);
    assert.ok(offer < sans, `an offer title (${offer}) reaches the section title (${sans}) at ${w}px`);
  }
  // The 98px shared rule is gone from this section.
  assert.ok(!css.includes(".b2b-compare h2{"), "the 98px section h2 survived");
});

/* ══════════════════════════════════════════════════════════════
   5. STRUCTURE, SEMANTICS AND THE FREEZES
   ══════════════════════════════════════════════════════════════ */

test("5: rail, alignment, icons and heading order", () => {
  assert.ok(section.includes('className="b2b-compare-inner home-rail"'));
  assert.match(rule(".b2b-compare{"), /padding-inline:var\(--rail-gutter\)/);
  assert.match(rule(".b2b-compare{"), /padding-block:clamp\(84px,7vw,108px\)/);
  assert.match(rule(".b2b-compare-inner{"),
    /grid-template-columns:minmax\(300px,\.82fr\) minmax\(320px,1fr\) minmax\(320px,1fr\)/);
  assert.ok(!/min-height|\dvh/.test(rule(".b2b-compare{")), "the section reserves height");

  // Both CTAs land on the same baseline through the layout, not absolutes.
  assert.match(rule(".b2b-compare .b2b-model-cta{"), /margin-top:auto/);
  assert.match(rule(".b2b-model{"), /flex-direction:column/);
  assert.ok(!/position:absolute/.test(rule(".b2b-compare .b2b-model-cta{")));

  // One h2 for the section, one h3 per model, and no new h1.
  assert.equal([...section.matchAll(/<h2[ >]/g)].length, 1);
  assert.equal([...section.matchAll(/<h3[ >]/g)].length, 1);   // rendered twice from one template
  assert.ok(!/<h1[ >]/.test(section));
  assert.match(section, /<h3 className="b2b-model-title">/);

  // Decorative icons, inline, no library, never interactive.
  assert.equal([...section.matchAll(/<svg /g)].length, 2);
  assert.equal([...section.matchAll(/aria-hidden="true"/g)].length, 4);
  assert.equal([...section.matchAll(/focusable="false"/g)].length, 2);
  assert.match(section, /stroke="currentColor"/);
  assert.ok(!/react-icons|lucide|@heroicons/.test(src), "an icon library was added");
  assert.ok(!/<button[^>]*>\s*<svg/.test(section), "an icon became interactive");
});

test("5b: every selector is scoped, and nothing else on the page moved", () => {
  let n = 0;
  for (const m of code.matchAll(/[}{]\s*([^{}@]+?)\s*\{/g)) {
    for (const sel of m[1].split(",")) {
      const s = sel.trim();
      if (!s) continue;
      n++;
      assert.ok(/^\.b2b-(compare|model)/.test(s), `an unscoped selector: ${s}`);
    }
  }
  assert.ok(n > 20, `only ${n} selectors were scanned`);

  // .cta.dark is a SHARED token and this pass left its definition alone.
  // (The portal-hint section below stopped rendering it in a later pass -
  // see tests/b2b-portal-section.test.mjs - so the class is no longer
  // asserted in the markup, only its untouched definition.)
  assert.match(css, /\.cta\.dark\{background:var\(--plum\);color:var\(--cream\)\}/);
  assert.match(css, /\.cta\.cream\{background:var\(--cream\)/);
  assert.match(src, /<section className="b2b-portal-hint">/);

  // The three B2B blocks above this one are untouched.
  const site = read("app/GloaSite.tsx");
  assert.match(site, /Dein Matcha\./);
  assert.match(site, /Dein Signature-Drink\./);
  assert.match(site, /src="\/img\/B2B Packung\.png"/);
  assert.match(site, /const b2bFacts=\["SHIZUOKA, JAPAN"/);
  assert.match(site, /FÜR DEINE KARTE GEMACHT\./);
  assert.match(site, /Einfach zubereitet\./);
  assert.match(site, /Leicht skalierbar\./);
  // And the sections below it.
  for (const marker of ['className="b2b-steps"', 'className="supply"', 'className="business-support"',
                        'className="sample-callout"', 'id="lead"']) {
    assert.ok(src.includes(marker), `a section below changed: ${marker}`);
  }
  assert.match(read("app/B2bCalculator.tsx"), /export function B2bCalculator\(/);
  for (const marker of ["/about — ONE EDITORIAL SYSTEM", "/our-matcha PAGE HERO", ".home-rail{"]) {
    assert.ok(css.includes(marker), `a frozen block went missing: ${marker}`);
  }
});
