import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * /for-cafes — THE B2B CUSTOMER PORTAL SECTION.
 *
 * Was a plum ground behind an 80px h2 - past every other section on the
 * page and past the page hero's italic - closed by a cream button beside
 * a PLUM one sitting on plum.
 *
 * Now GLOA blue, the shared section headline pair, and two buttons that
 * both read on blue. These tests pin the ground, the copy, the two
 * routes and the type hierarchy. They are not pixel tests.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf8");

const src = read("app/BusinessCalculator.tsx");
const css = read("app/globals.css");

const section = src.slice(src.indexOf('<section className="b2b-portal-hint">'),
                          src.indexOf('<section className="b2b-steps">'));
assert.ok(section.length > 300, "the section markup was not found");

const blockAt = css.indexOf("B2B CUSTOMER PORTAL SECTION");
assert.notEqual(blockAt, -1, "the CSS block was not found");
/* Bounded the way the sibling blocks are, so a block appended after this
   one cannot answer for - or trip - an assertion about this section. */
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
   1. THE COPY
   ══════════════════════════════════════════════════════════════ */

test("1: the approved copy, and the old sentence is gone", () => {
  for (const line of [
    "B2B KUNDENPORTAL",
    "Preise, Konditionen",
    "und dein Dashboard.",
    "Preise, individuelle Konditionen und dein B2B-Dashboard.",
    "Alles gebündelt in deinem GLOA Geschäftskonto.",
    "Geschäftskonto erstellen",
    "B2B-Anfrage starten",
  ]) assert.ok(section.includes(line), `missing copy: ${line}`);

  // The superseded body, in full and in fragments.
  for (const old of [
    "Detaillierte Preise, individuelle Konditionen und ein eigenes B2B-Dashboard, alles in deinem GLOA Geschäftskonto.",
    "Detaillierte Preise", "ein eigenes B2B-Dashboard",
  ]) assert.ok(!section.includes(old), `superseded copy survived: ${old}`);

  // Exactly two CTAs - no third was invented.
  assert.equal([...section.matchAll(/<Link |<button /g)].length, 2);
  // And no pricing claim came with the redesign.
  for (const banned of ["€", "%", "Rabatt", "Mindest", "Versand", "Lieferzeit",
                        "kostenlos", "gratis", "ab "]) {
    assert.ok(!section.includes(banned), `a new claim: ${banned}`);
  }
});

test("1b: both destinations are exactly the ones that were here", () => {
  assert.match(section, /<Link className="cta b2b-portal-cta" href="\/account\?type=business">Geschäftskonto erstellen<\/Link>/);
  assert.match(section, /<button className="cta b2b-portal-cta b2b-portal-cta-secondary" onClick=\{\(\)=>choose\("wholesale"\)\}>B2B-Anfrage starten<\/button>/);
  // The handler behind the secondary is untouched.
  assert.match(src, /const choose=\(i:"wholesale"\|"sample"\)=>\{setIntent\(i\);track\(i==="sample"\?"sample_request_start":"wholesale_request_start"\);document\.getElementById\("lead"\)\?\.scrollIntoView/);
  // A link stays a link and a button stays a button.
  assert.ok(section.includes("<Link ") && section.includes("<button "));
  assert.ok(!section.includes("href=\"#\""), "a destination was stubbed out");
});

/* ══════════════════════════════════════════════════════════════
   2. THE GROUND
   ══════════════════════════════════════════════════════════════ */

test("2: GLOA blue edge to edge, and no plum survives", () => {
  assert.match(rule(".b2b-portal-hint{"), /background:var\(--blue\)/);
  assert.match(rule(".b2b-portal-hint{"), /color:var\(--cream\)/);
  assert.match(css, /--blue:#1746D1;/);
  assert.match(css, /--cream:#F5EBE2;/);
  // Not one plum reference left in the block, and no wrapper kept it.
  assert.ok(!code.includes("var(--plum)"), "plum survived in the section");
  assert.ok(!code.includes("79,58,91"), "a plum alpha survived in the section");
  assert.ok(!css.includes(".b2b-portal-hint{padding:100px 5vw;background:var(--plum)"),
    "the legacy plum rule survived");
  assert.ok(!section.includes("cta dark"), "the plum button token is still on the secondary CTA");

  // No literal hex, no gradient, and every rgba is a cream alpha.
  for (const m of code.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) assert.fail(`a literal hex: ${m[0]}`);
  assert.ok(!code.includes("gradient"), "a gradient was added");
  assert.ok(!code.includes("backdrop-filter") && !code.includes("filter:"), "an effect was added");
  for (const m of code.matchAll(/rgba\(([^)]+)\)/g)) {
    const [r, g, b] = m[1].split(",").map(n => Number(n.trim()));
    assert.ok(r === 245 && g === 235 && b === 226, `a non-cream rgba: rgba(${m[1]})`);
  }
});

test("2b: the shared button tokens were not touched", () => {
  // .cta.cream still serves another page; .cta.dark stays defined even
  // though this section stopped using it.
  assert.match(css, /\.cta\.cream\{background:var\(--cream\);color:var\(--blue\);border-color:var\(--cream\)\}/);
  assert.match(css, /\.cta\.dark\{background:var\(--plum\);color:var\(--cream\)\}/);
  assert.match(read("app/GloaSite.tsx"), /className="cta cream"/);
  // This section paints its own instead.
  assert.match(rule(".b2b-portal-hint .b2b-portal-cta{"), /background:var\(--cream\)/);
  assert.match(rule(".b2b-portal-hint .b2b-portal-cta{"), /color:var\(--blue\)/);
  assert.match(rule(".b2b-portal-hint .b2b-portal-cta-secondary{"), /background:transparent/);
  assert.match(rule(".b2b-portal-hint .b2b-portal-cta-secondary{"),
    /border:1px solid rgba\(245,235,226,\.62\)/);
  // Both boxes, and both hovers, are the same shape.
  for (const sel of [".b2b-portal-hint .b2b-portal-cta{"]) {
    assert.match(rule(sel), /min-height:54px/);
    assert.match(rule(sel), /border-radius:0/);
    assert.match(rule(sel), /font-size:12px/);
    assert.match(rule(sel), /letter-spacing:\.15em/);
    assert.match(rule(sel), /text-transform:uppercase/);
    assert.match(rule(sel), /width:auto/);      // never full width on desktop
  }
  assert.match(rule(".b2b-portal-hint .b2b-portal-cta:hover{"), /background:transparent/);
  assert.match(rule(".b2b-portal-hint .b2b-portal-cta-secondary:hover{"), /background:var\(--cream\)/);
  for (const m of code.matchAll(/transition:([^;}]+)/g)) {
    assert.ok(!/\d{3,}ms|[3-9]s/.test(m[1]), `a slow transition: ${m[1]}`);
  }
  // Focus states are the site's, never removed here.
  assert.ok(!code.includes("outline:none") && !code.includes("outline:0"),
    "a focus outline was removed");
  assert.match(css, /:focus-visible\{outline:3px solid var\(--blue\)/);
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
  assert.match(rule(".b2b-portal-hint .b2b-portal-line{"), /font-family:var\(--font-sans\)/);
  assert.match(rule(".b2b-portal-hint .b2b-portal-line-accent{"), /font-family:var\(--font-display\)/);
  assert.match(rule(".b2b-portal-hint .b2b-portal-line-accent{"), /font-style:italic/);

  const cap = t => Number(/clamp\([\d.]+px,[\d.]+vw,([\d.]+)px\)/.exec(t)[1]);
  assert.equal(cap(sizeOf(desktop, ".b2b-portal-hint .b2b-portal-line{")), 60);
  assert.equal(cap(sizeOf(desktop, ".b2b-portal-hint .b2b-portal-line-accent{")), 64);
  assert.match(rule(".b2b-portal-hint .b2b-portal-eyebrow{"), /font-size:var\(--type-meta\)/);
  assert.match(css, /--type-meta:11px/);
  assert.match(rule(".b2b-portal-hint .b2b-portal-eyebrow{"), /letter-spacing:\.2em/);
  assert.match(rule(".b2b-portal-hint .b2b-portal-lead,"), /font-size:clamp\(16px,1\.3vw,17px\)/);
  // The standalone override, not the grouped rule both paragraphs share.
  assert.match(code, /\.b2b-portal-hint \.b2b-portal-sub\{margin-top:6px;color:rgba\(245,235,226,\.82\)\}/);
  // The headline pair is the SAME one the two sibling sections carry.
  const menu = css.slice(css.indexOf("INFO STRIP + MENU SECTION"), css.indexOf("THE TWO ORDERING MODELS"));
  assert.equal(sizeOf(desktop, ".b2b-portal-hint .b2b-portal-line{"),
               /font-size:(clamp\([^)]*\))/.exec(menu.slice(menu.indexOf(".b2b-menu .b2b-menu-line{")))[1]);
  assert.equal(sizeOf(desktop, ".b2b-portal-hint .b2b-portal-line-accent{"),
               /font-size:(clamp\([^)]*\))/.exec(menu.slice(menu.indexOf(".b2b-menu .b2b-menu-line-accent{")))[1]);
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
    const sans = clampAt(sizeOf(scope, ".b2b-portal-hint .b2b-portal-line{"), w);
    const ital = clampAt(sizeOf(scope, ".b2b-portal-hint .b2b-portal-line-accent{"), w);
    assert.ok(sans < heroSans, `the section sans (${sans}) reaches the hero (${heroSans}) at ${w}px`);
    assert.ok(ital < heroItal, `the section italic (${ital}) reaches the hero italic (${heroItal}) at ${w}px`);
  }
  // The 80px h2 that used to be here is gone. Checked as the RULE, not
  // as the string - the block comment above quotes the old value.
  assert.ok(!css.includes(".b2b-portal-hint h2{"), "the 80px portal h2 survived");
});

/* ══════════════════════════════════════════════════════════════
   4. STRUCTURE, SEMANTICS AND THE FREEZES
   ══════════════════════════════════════════════════════════════ */

test("4: centred composition, one heading, no cards and no mockup", () => {
  assert.ok(section.includes('className="b2b-portal-inner home-rail"'), "the section is off the rail");
  assert.match(rule(".b2b-portal-hint{"), /padding-inline:var\(--rail-gutter\)/);
  assert.match(rule(".b2b-portal-hint{"), /padding-block:clamp\(96px,8vw,128px\)/);
  assert.match(rule(".b2b-portal-copy{"), /max-width:940px/);
  assert.match(rule(".b2b-portal-copy{"), /margin-inline:auto/);
  assert.match(rule(".b2b-portal-copy{"), /text-align:center/);
  // The only min-height left is the CTA tap target.
  for (const m of code.matchAll(/min-height:([^;}]+)/g)) {
    assert.equal(m[1].trim(), "54px", `a layout min-height: ${m[1]}`);
  }
  assert.ok(!/\dvh/.test(code), "a viewport height was used");
  assert.ok(!/min-height/.test(rule(".b2b-portal-hint{")), "the section reserves height");

  // ONE heading, holding both lines.
  assert.equal([...section.matchAll(/<h2[ >]/g)].length, 1);
  assert.ok(!/<h1[ >]|<h3[ >]/.test(section), "the section grew another heading level");
  assert.match(section, /<h2 className="b2b-portal-headline"><span className="b2b-portal-line">Preise, Konditionen<\/span><i className="b2b-portal-line b2b-portal-line-accent">und dein Dashboard\.<\/i><\/h2>/);

  // Typography only: no image, no svg, no icon, no mockup.
  assert.ok(!section.includes("<img") && !section.includes("<svg"),
    "an image or icon was added");
  assert.ok(!/dashboard-mock|screenshot|browser|panel|card/i.test(section),
    "a mockup or card was added");
  // Exactly ONE decorative mark, and it is a hairline.
  assert.equal([...section.matchAll(/aria-hidden="true"/g)].length, 1);
  assert.match(section, /<span className="b2b-portal-rule" aria-hidden="true"\/>/);
  assert.match(rule(".b2b-portal-rule{"), /width:48px/);
  assert.match(rule(".b2b-portal-rule{"), /height:1px/);
  assert.match(rule(".b2b-portal-rule{"), /background:rgba\(245,235,226,\.55\)/);
  // Nothing paints a box: no shadow, and radius only ever zero.
  assert.ok(!/box-shadow:(?!none)/.test(code), "a shadow was added");
  for (const m of code.matchAll(/border-radius:([^;}]+)/g)) {
    assert.equal(m[1].trim(), "0", `a non-zero radius: ${m[1]}`);
  }
});

test("4b: mobile stacks the pair, capped and centred", () => {
  assert.match(mobile, /flex-direction:column/);
  assert.match(mobile, /max-width:340px/);
  assert.match(mobile, /margin-inline:auto/);
  assert.match(mobile, /gap:12px/);
  assert.match(mobile, /\.b2b-portal-hint \.b2b-portal-cta\{width:100%/);
  assert.match(mobile, /padding-block:clamp\(72px,12vw,88px\)/);
});

test("4c: every selector is scoped, and nothing else on the page moved", () => {
  let n = 0;
  for (const m of code.matchAll(/[}{]\s*([^{}@]+?)\s*\{/g)) {
    for (const sel of m[1].split(",")) {
      const s = sel.trim();
      if (!s) continue;
      n++;
      assert.ok(/^\.b2b-portal/.test(s), `an unscoped selector: ${s}`);
    }
  }
  assert.ok(n > 12, `only ${n} selectors were scanned`);

  // The section immediately above, and the ones above that.
  assert.match(src, /FLEXIBEL &amp; PLANBAR/);
  assert.match(src, /Flexibel bestellen/);
  assert.match(src, /oder langfristig profitieren\./);
  assert.match(src, /const b2bModels=\[/);
  const site = read("app/GloaSite.tsx");
  assert.match(site, /Dein Matcha\./);
  assert.match(site, /Dein Signature-Drink\./);
  assert.match(site, /src="\/img\/B2B Packung\.png"/);
  assert.match(site, /const b2bFacts=\["SHIZUOKA, JAPAN"/);
  assert.match(site, /Einfach zubereitet\./);
  // And everything after it.
  for (const marker of ['className="b2b-steps"', 'className="supply"', 'className="business-support"',
                        'className="sample-callout"', 'id="lead"']) {
    assert.ok(src.includes(marker), `a section below changed: ${marker}`);
  }
  // The lead machinery this file also owns is untouched.
  for (const sig of ['const [intent,setIntent]=useState<"wholesale"|"sample">',
                     "const payload:LeadPayload={",
                     'window.dispatchEvent(new CustomEvent("gloa:b2b-lead",{detail:payload}))']) {
    assert.ok(src.includes(sig), `the lead machinery changed: ${sig}`);
  }
  for (const marker of ["/about — ONE EDITORIAL SYSTEM", "/our-matcha PAGE HERO", ".home-rail{"]) {
    assert.ok(css.includes(marker), `a frozen block went missing: ${marker}`);
  }
});
