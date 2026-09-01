import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * /for-cafes — MEHR ALS MATCHA, THE SUPPORT SECTION.
 *
 * Was: no ground of its own, a headline on the shared 98px h2 rule, and
 * five bordered cells each repeating "Verfügbar ab Launch" underneath
 * it - five copies of one sentence.
 *
 * Now GLOA blue: a wide intro column, a seam, five open service
 * columns, and that sentence ONCE at the foot. These tests pin the
 * copy, the single note, the absence of cards and the type hierarchy.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf8");

const src = read("app/BusinessCalculator.tsx");
const css = read("app/globals.css");

const section = src.slice(src.indexOf('<section className="b2b-support">'),
                          src.indexOf('<section className="sample-callout">'));
assert.ok(section.length > 400, "the section markup was not found");
/* Anchored past the "=[" - the type annotation carries a "];" of its own. */
const dataFrom = src.indexOf("const b2bSupport");
const data = src.slice(dataFrom, src.indexOf("];", src.indexOf("=[", dataFrom)));

const blockAt = css.indexOf("MEHR ALS MATCHA, THE SUPPORT SECTION");
assert.notEqual(blockAt, -1, "the CSS block was not found");
// Bounded at the NEXT page block, so a block appended after this one
// cannot answer for - or trip - an assertion about this section.
const rules = css.slice(css.lastIndexOf("/*", blockAt), css.lastIndexOf("/*", css.indexOf("THE SAMPLE CALLOUT AND THE B2B FORM")));
const code = rules.replace(/\/\*[\s\S]*?\*\//g, "");
const desktop = code.slice(0, code.indexOf("@media"));
const mobile = code.slice(code.indexOf("@media (max-width:760px)"));

const rule = name => {
  const at = code.indexOf(name);
  assert.notEqual(at, -1, `missing rule: ${name}`);
  return code.slice(at, code.indexOf("}", at));
};

/* ══════════════════════════════════════════════════════════════
   1. THE COPY
   ══════════════════════════════════════════════════════════════ */

test("1: the approved intro copy, and the old headline is gone", () => {
  for (const line of [
    "MEHR ALS MATCHA",
    "Mehr als Matcha.",
    "Alles für deine Karte.",
    "Von Rezepten bis Team-Training: Wir helfen dir dabei, GLOA sauber in deinen Alltag und deine Karte zu integrieren.",
  ]) assert.ok(section.includes(line), `missing intro copy: ${line}`);

  // The old oversized headline.
  assert.ok(!section.includes("Matcha auf die Karte zu bringen"), "the old headline survived");
  assert.ok(!src.includes("<i>Matcha auf die Karte zu bringen.</i>"));
  // No CTA and no button were invented - this section is informational.
  assert.ok(!section.includes("<Link ") && !section.includes("<button "),
    "a CTA was added to an informational section");
  for (const banned of ["Mehr erfahren", "Anfragen", "Kontakt", "Sample anfragen", "B2B starten"]) {
    assert.ok(!section.includes(banned), `a CTA label: ${banned}`);
  }
});

test("1b: the five services, exactly", () => {
  const titles = [...data.matchAll(/title:"([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(titles, ["REZEPT-GUIDES", "BAR-SOPS", "TEAM-TRAINING", "MENÜ-SUPPORT", "SOCIAL TOOLKIT"]);
  const bodies = [...data.matchAll(/body:"([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(bodies, [
    "Standardisierte Rezepte für gleichbleibende Drinks.",
    "Klare Abläufe für dein Team.",
    "Kompakte Schulungsmaterialien.",
    "Hilfe bei der Integration in deine Karte.",
    "Content für deinen GLOA Launch.",
  ]);
  assert.deepEqual([...data.matchAll(/n:"(\d\d)"/g)].map(m => m[1]), ["01", "02", "03", "04", "05"]);
  // The two wordings the copy contract corrects.
  assert.ok(!data.includes("BAR-SOPs"), "the old lowercase title survived");
  assert.ok(!data.includes("Fertiger Content"), "the old service 05 body survived");

  // NO new service promise came with the redesign.
  for (const banned of ["Beratung", "kostenlos", "gratis", "vor Ort", "24/7", "Account Manager",
                        "garantiert", "persönlich", "inklusive", "unbegrenzt"]) {
    assert.ok(!data.includes(banned) && !section.includes(banned), `a new promise: ${banned}`);
  }
});

test("1c: the launch note renders ONCE, not under every service", () => {
  assert.ok(!src.includes("Verfügbar ab Launch"), "the repeated launch label survived");
  assert.ok(!section.includes("<small>"), "the per-service label markup survived");
  assert.equal([...section.matchAll(/ALLE SUPPORT-MATERIALIEN AB LAUNCH VERFÜGBAR\./g)].length, 1,
    "the launch note is duplicated");
  assert.equal([...section.matchAll(/b2b-support-note/g)].length, 1);
  // It sits at the foot, under the hairline.
  assert.ok(section.indexOf("b2b-support-rule") < section.indexOf("b2b-support-note"));
  assert.ok(section.indexOf("b2b-support-grid") < section.indexOf("b2b-support-rule"));
});

/* ══════════════════════════════════════════════════════════════
   2. ONE BLUE FIELD, NO CARDS
   ══════════════════════════════════════════════════════════════ */

test("2: exact GLOA blue, cream type, and nothing else painted", () => {
  assert.match(rule(".b2b-support{"), /background:var\(--blue\)/);
  assert.match(rule(".b2b-support{"), /color:var\(--cream\)/);
  assert.match(css, /--blue:#1746D1;/);
  assert.match(css, /--cream:#F5EBE2;/);
  // One uninterrupted field: nothing inside paints a second ground.
  assert.equal([...code.matchAll(/background:var\(--/g)].length, 1,
    "a second background was painted inside the section");
  assert.ok(!code.includes("var(--berry)") && !code.includes("var(--plum)"),
    "another brand ground appeared");
  assert.ok(!code.includes("gradient"), "a gradient was added");
  assert.ok(!code.includes("backdrop-filter"), "an effect was added");
  // No literal hex; every rgba is a cream alpha.
  for (const m of code.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) assert.fail(`a literal hex: ${m[0]}`);
  for (const m of code.matchAll(/rgba\(([^)]+)\)/g)) {
    const [r, g, b] = m[1].split(",").map(n => Number(n.trim()));
    assert.ok(r === 245 && g === 235 && b === 226, `a non-cream rgba: rgba(${m[1]})`);
  }
});

test("2b: the five services are open columns, not cards", () => {
  const item = rule(".b2b-support-item{");
  assert.ok(!/background|border(?!-)|padding/.test(item), "a service became a box");
  assert.ok(!/box-shadow/.test(code), "a shadow was added");
  // Radius only ever the icon ring.
  for (const m of code.matchAll(/border-radius:([^;}]+)/g)) {
    assert.equal(m[1].trim(), "50%", `an unexpected radius: ${m[1]}`);
  }
  // The ring is a 1px outline, never filled.
  const mark = rule(".b2b-support-mark{");
  assert.match(mark, /border:1px solid rgba\(245,235,226,\.72\)/);
  assert.match(mark, /background:transparent/);
  assert.match(mark, /width:50px/);
  assert.match(mark, /height:50px/);
  // No outer box around all five, and no hover theatre.
  assert.ok(!code.includes(":hover"), "a hover effect was added");
  for (const banned of ["scale(", "rotate(", "translateY", "@keyframes", "animation"]) {
    assert.ok(!code.includes(banned), `an animation was added: ${banned}`);
  }
});

test("2c: the separators are hairlines - a seam, five gaps, one rule", () => {
  // Intro -> services: a real grid track.
  const seam = rule(".b2b-support-seam{");
  assert.match(seam, /width:1px/);
  assert.match(seam, /background:rgba\(245,235,226,\.30\)/);
  assert.match(seam, /align-self:center/);
  assert.match(section, /<span className="b2b-support-seam" aria-hidden="true"\/>/);
  assert.match(rule(".b2b-support-grid{"),
    /grid-template-columns:minmax\(300px,1\.45fr\) 1px repeat\(5,minmax\(125px,\.78fr\)\)/);

  // Between services: a pseudo-element in the gap, never a column edge.
  const between = rule(".b2b-support-item + .b2b-support-item::before{");
  assert.match(between, /position:absolute/);
  assert.match(between, /width:1px/);
  assert.match(between, /height:85%/);
  assert.match(between, /background:rgba\(245,235,226,\.28\)/);
  assert.match(between, /left:calc\(var\(--col-gap\) \/ -2\)/);

  // The foot.
  const foot = rule(".b2b-support-rule{");
  assert.match(foot, /width:100%/);
  assert.match(foot, /height:1px/);
  assert.match(foot, /background:rgba\(245,235,226,\.32\)/);
  assert.match(section, /<span className="b2b-support-rule" aria-hidden="true"\/>/);
});

/* ══════════════════════════════════════════════════════════════
   3. TYPOGRAPHY
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

test("3: two families, and the caps the contract names", () => {
  for (const m of code.matchAll(/font-family:([^;}]+)/g)) {
    assert.match(m[1], /^var\(--font-(sans|display)\)/, `a third family: ${m[1]}`);
  }
  for (const m of code.matchAll(/font-family:var\(--font-display\),([^;}]+)/g)) {
    assert.equal(m[1].trim(), "Georgia,serif");
  }
  assert.ok(!code.includes("@font-face") && !code.includes("@import"));
  assert.match(rule(".b2b-support .b2b-support-line{"), /font-family:var\(--font-sans\)/);
  assert.match(rule(".b2b-support .b2b-support-line-accent{"), /font-family:var\(--font-display\)/);
  assert.match(rule(".b2b-support .b2b-support-line-accent{"), /font-style:italic/);

  const cap = t => Number(/clamp\([\d.]+px,[\d.]+vw,([\d.]+)px\)/.exec(t)[1]);
  assert.equal(cap(sizeOf(desktop, ".b2b-support .b2b-support-line{")), 54);
  assert.equal(cap(sizeOf(desktop, ".b2b-support .b2b-support-line-accent{")), 58);
  assert.equal(cap(sizeOf(desktop, ".b2b-support-title{")), 15);
  assert.equal(cap(sizeOf(desktop, ".b2b-support-text{")), 14);
  assert.equal(cap(sizeOf(desktop, ".b2b-support .b2b-support-body{")), 16);
  assert.match(rule(".b2b-support .b2b-support-eyebrow{"), /font-size:var\(--type-meta\)/);
  assert.match(css, /--type-meta:11px/);
  assert.match(rule(".b2b-support-number{"), /font-size:11px/);
  assert.match(rule(".b2b-support .b2b-support-note{"), /font-size:11px/);
  assert.match(rule(".b2b-support .b2b-support-note{"), /text-transform:uppercase/);
});

test("3b: the section stays under the B2B hero at every width", () => {
  const heroBlock = css.slice(css.indexOf("/for-cafes PAGE HERO"), css.indexOf("INFO STRIP + MENU SECTION"));
  const heroCode = heroBlock.replace(/\/\*[\s\S]*?\*\//g, "");
  const heroD = heroCode.slice(0, heroCode.indexOf("@media"));
  const heroM = heroCode.slice(heroCode.indexOf("@media (max-width:900px)"));

  for (const w of [320, 360, 390, 430, 480, 640, 760, 761, 900, 1024, 1200, 1280, 1440, 1536, 1680, 1920]) {
    const heroSans = clampAt(sizeOf(w <= 900 ? heroM : heroD, ".b2b-hero .b2b-hero-line{"), w);
    const heroItal = clampAt(sizeOf(w <= 900 ? heroM : heroD, ".b2b-hero .b2b-hero-line-accent{"), w);
    const scope = w <= 760 ? mobile : desktop;
    const sans = clampAt(sizeOf(scope, ".b2b-support .b2b-support-line{"), w);
    const ital = clampAt(sizeOf(scope, ".b2b-support .b2b-support-line-accent{"), w);
    const title = clampAt(sizeOf(desktop, ".b2b-support-title{"), w);
    assert.ok(sans < heroSans, `the section sans (${sans}) reaches the hero (${heroSans}) at ${w}px`);
    assert.ok(ital < heroItal, `the section italic (${ital}) reaches the hero italic (${heroItal}) at ${w}px`);
    assert.ok(title < sans, `a service title (${title}) reaches the section title (${sans}) at ${w}px`);
  }
  // The shared 98px rule no longer reaches this section, and BOTH lists
  // that still name .business-support are untouched.
  assert.ok(!section.includes("business-support"), "the old class survived in the markup");
  assert.match(css, /\.behind-bar h2,\.business-support h2,\.faq h2\{/);
  assert.match(css, /\.b2b-hero h1 i,\.behind-bar h2 i,\.business-support h2 i,\.faq h2 i\{/);
  assert.ok(!css.includes(".business-support{"), "the old standalone rule survived");
  assert.ok(!css.includes(".business-support article"), "the old cell rules survived");
});

/* ══════════════════════════════════════════════════════════════
   4. STRUCTURE, SEMANTICS AND THE FREEZES
   ══════════════════════════════════════════════════════════════ */

test("4: rail, height, icons and heading order", () => {
  assert.ok(section.includes('className="b2b-support-rail home-rail"'), "the section is off the rail");
  assert.match(rule(".b2b-support{"), /padding-inline:var\(--rail-gutter\)/);
  assert.match(rule(".b2b-support{"), /padding-block:clamp\(88px,7vw,108px\) clamp\(72px,6vw,94px\)/);
  assert.ok(!/min-height|\dvh/.test(code), "the section reserves height");

  // One h2 for the section, one h3 per service, no new h1.
  assert.equal([...section.matchAll(/<h2[ >]/g)].length, 1);
  assert.equal([...section.matchAll(/<h3[ >]/g)].length, 1);   // rendered five times from one template
  assert.ok(!/<h1[ >]/.test(section));
  assert.match(section, /<h2 className="b2b-support-headline"><span className="b2b-support-line">Mehr als Matcha\.<\/span><i className="b2b-support-line b2b-support-line-accent">Alles für deine Karte\.<\/i><\/h2>/);
  assert.match(section, /<h3 className="b2b-support-title">/);

  // Five decorative icons from one inline template, no library.
  assert.equal([...section.matchAll(/<svg /g)].length, 1);
  assert.equal([...data.matchAll(/icon:"/g)].length, 5);
  assert.match(section, /aria-hidden="true"/);
  assert.match(section, /focusable="false"/);
  assert.match(section, /stroke="currentColor"/);
  assert.match(section, /fill="none"/);
  assert.ok(!/react-icons|lucide|@heroicons/.test(src), "an icon library was added");
});

test("4b: tablet goes three-and-two, mobile stacks", () => {
  const tablet = code.slice(code.indexOf("@media (max-width:1200px)"), code.indexOf("@media (max-width:760px)"));
  assert.match(tablet, /\.b2b-support-grid\{grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
  assert.match(tablet, /\.b2b-support-intro\{grid-column:1 \/ -1\}/);
  assert.match(tablet, /\.b2b-support-seam\{display:none\}/);
  // The fourth item starts the second row and has no gap to its left.
  assert.match(tablet, /\.b2b-support-item:nth-of-type\(4\)::before\{content:none\}/);

  assert.match(mobile, /\.b2b-support-grid\{grid-template-columns:1fr/);
  assert.match(mobile, /\.b2b-support-item \+ \.b2b-support-item::before\{content:none\}/);
  // Vertical dividers out, horizontal ones in.
  assert.match(mobile, /border-top:1px solid rgba\(245,235,226,\.25\)/);
  assert.match(mobile, /grid-template-columns:46px minmax\(0,1fr\)/);
  assert.match(mobile, /\.b2b-support-mark\{width:46px;height:46px/);
  // Source order IS the stacked order.
  assert.ok(section.indexOf("b2b-support-intro") < section.indexOf("b2b-support-item"));
});

test("4c: every selector is scoped, and nothing else on the page moved", () => {
  let n = 0;
  for (const m of code.matchAll(/[}{]\s*([^{}@]+?)\s*\{/g)) {
    for (const sel of m[1].split(",")) {
      const s = sel.trim();
      if (!s) continue;
      n++;
      assert.ok(/^\.b2b-support/.test(s), `an unscoped selector: ${s}`);
    }
  }
  assert.ok(n > 15, `only ${n} selectors were scanned`);

  // The section before, and the one after.
  assert.match(src, /<section className="b2b-flow">/);
  assert.match(src, /SO FUNKTIONIERT&apos;S/);
  assert.match(src, /<section className="sample-callout">/);
  assert.match(src, /Test it with/);
  // The rest of the B2B page, and the lead machinery this file owns.
  for (const marker of ['<section className="b2b-compare">', '<section className="b2b-portal-hint">',
                        'id="lead"', "const payload:LeadPayload={",
                        'window.dispatchEvent(new CustomEvent("gloa:b2b-lead",{detail:payload}))']) {
    assert.ok(src.includes(marker), `the page changed beyond this section: ${marker}`);
  }
  const site = read("app/GloaSite.tsx");
  assert.match(site, /Dein Matcha\./);
  assert.match(site, /src="\/img\/B2B Packung\.png"/);
  assert.match(site, /const b2bFacts=\["SHIZUOKA, JAPAN"/);
  for (const marker of ["/about — ONE EDITORIAL SYSTEM", "/our-matcha PAGE HERO", ".home-rail{"]) {
    assert.ok(css.includes(marker), `a frozen block went missing: ${marker}`);
  }
});
