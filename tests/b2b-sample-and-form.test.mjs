import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * /for-cafes — THE SAMPLE CALLOUT AND THE B2B FORM.
 *
 * Both headlines were 75px, larger than the page hero, and four rules
 * painted literal `white` on raspberry: the section colour, the input
 * text and their bottom borders, the tab borders and the active tab.
 *
 * The sharpest thing these tests do is the WHITE AUDIT: no rule scoped
 * to either section may declare pure white in any form. Everything else
 * pins the copy, the untouched form contract and the type hierarchy.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf8");

const src = read("app/BusinessCalculator.tsx");
const css = read("app/globals.css");

const both = src.slice(src.indexOf('<section className="sample-callout">'),
                       src.indexOf("// ─────", src.indexOf('<section className="sample-callout">')));
assert.ok(both.length > 800, "the two sections were not found");
const callout = both.slice(0, both.indexOf('<section id="lead"'));
const form = both.slice(both.indexOf('<section id="lead"'));

const blockAt = css.indexOf("THE SAMPLE CALLOUT AND THE B2B FORM");
assert.notEqual(blockAt, -1, "the CSS block was not found");
// Bounded at the NEXT page block, so a block appended after this one
// cannot answer for - or trip - an assertion about these two sections.
const rules = css.slice(css.lastIndexOf("/*", blockAt), css.lastIndexOf("/*", css.indexOf("/for-cafes — THE B2B FAQ")));
const code = rules.replace(/\/\*[\s\S]*?\*\//g, "");
const desktop = code.slice(0, code.indexOf("@media"));
const mobile = code.slice(code.indexOf("@media (max-width:760px)"));

const rule = name => {
  const at = code.indexOf(name);
  assert.notEqual(at, -1, `missing rule: ${name}`);
  return code.slice(at, code.indexOf("}", at));
};

/* ══════════════════════════════════════════════════════════════
   1. THE WHITE AUDIT
   ══════════════════════════════════════════════════════════════ */

const WHITE = /\bwhite\b|#fff\b|#ffffff\b|rgb\(\s*255\s*,\s*255\s*,\s*255|rgba\(\s*255\s*,\s*255\s*,\s*255/i;

test("1: no rule scoped to either section declares pure white", () => {
  // The whole file, comment-free, filtered to these two sections - so a
  // white left behind in a legacy rule is caught too, not just in the
  // new block.
  const all = css.replace(/\/\*[\s\S]*?\*\//g, "");
  let checked = 0;
  for (const m of all.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const sel = m[1].split(/[\r\n]/).pop().trim();
    if (!/\.(sample-callout|lead-section|lead-form|intent-tabs|form-success)/.test(sel)) continue;
    checked++;
    assert.ok(!WHITE.test(m[2]), `pure white in ${sel} -> ${m[2].slice(0, 80)}`);
  }
  assert.ok(checked > 20, `only ${checked} rules were scanned`);

  // And the four rules that used to carry it are gone.
  for (const legacy of [
    ".lead-section{padding:110px 5vw;background:var(--berry);color:white}",
    "border-bottom:1px solid white",
    ".intent-tabs button{border:1px solid white",
    ".intent-tabs .active{background:white",
  ]) assert.ok(!css.includes(legacy), `a legacy white rule survived: ${legacy}`);

  // The markup carries none either.
  assert.ok(!WHITE.test(both), "pure white in the markup");
});

test("1b: the light values are cream, and the one hex escape is cream", () => {
  // Every colour in the block is a token or a cream/ink alpha.
  for (const m of code.matchAll(/rgba\(([^)]+)\)/g)) {
    const [r, g, b] = m[1].split(",").map(n => Number(n.trim()));
    const ok = (r === 245 && g === 235 && b === 226) || (r === 17 && g === 17 && b === 17);
    assert.ok(ok, `a non-brand rgba: rgba(${m[1]})`);
  }
  for (const m of code.matchAll(/(background|color|border-color|outline-color):var\(--([a-z]+)\)/g)) {
    assert.ok(["cream", "ink", "berry", "blue"].includes(m[2]), `an unexpected token: ${m[2]}`);
  }
  // No literal hex at all; the select chevron's data URI carries the one
  // escaped colour, and it is cream.
  assert.equal([...code.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].length, 0, "a literal hex colour");
  const escapes = [...code.matchAll(/%23[0-9A-Fa-f]{6}/g)].map(m => m[0]);
  assert.deepEqual(escapes, ["%23F5EBE2"], "the chevron is not cream");
  assert.ok(!code.includes("gradient"), "a gradient was added");
});

/* ══════════════════════════════════════════════════════════════
   2. COPY
   ══════════════════════════════════════════════════════════════ */

test("2: the one authorised copy correction, and nothing else", () => {
  assert.ok(callout.includes("PROBIER&apos;S ERST MAL."), "the corrected eyebrow is missing");
  assert.ok(!src.includes("ERSTMAL"), "the old spelling survived");
  for (const line of ["Test it with", "your team.",
    "Bestell ein Sample, bevor du deine erste größere Bestellung aufgibst. Konditionen klären wir individuell.",
    "Sample anfragen"]) assert.ok(callout.includes(line), `missing callout copy: ${line}`);

  for (const line of ["GLOA FOR BUSINESS", "Let&apos;s talk", "Matcha.",
                      "B2B-Anfrage", "Sample"]) assert.ok(form.includes(line), `missing form copy: ${line}`);
  // The consent sentence is untouched, word for word.
  assert.ok(form.includes("Ich stimme zu, dass GLOA meine Angaben zur Bearbeitung meiner Anfrage verwenden darf."));
});

test("2b: every form question, every name and every required is unchanged", () => {
  for (const label of ["Ansprechpartner/in*", "Unternehmen / Café*", "E-Mail*", "Stadt*",
                       "Unternehmenstyp*", "Anzahl Standorte*", "Interesse an",
                       "Geplanter monatlicher Bedarf", "Aktueller Matcha-Lieferant", "Nachricht"]) {
    assert.ok(form.includes(label), `a form question changed: ${label}`);
  }
  for (const field of ['required name="contact_name"', 'required name="business_name"',
                       'required type="email" name="email"', 'required name="city"',
                       'required name="business_type"', 'required min="1" type="number" name="locations"',
                       'name="pricing_interest"', 'name="demand"', 'name="supplier"',
                       'name="message"', 'required type="checkbox"']) {
    assert.ok(form.includes(field), `a field contract changed: ${field}`);
  }
  // The optional fields did not silently gain a star.
  assert.ok(!form.includes("Aktueller Matcha-Lieferant*"));
  assert.ok(!form.includes("Interesse an*"));
  assert.ok(!form.includes("Nachricht*"));
  // Every select option list is intact.
  for (const opt of ["Eigenständiges Café", "Café-Gruppe", "Restaurant", "Hotel",
                     "Büro / Office", "Fitness / Pilates / Wellness", "Einzelhandel", "Sonstiges",
                     "Regelmäßige Belieferung · 5 %", "12-Monats-Partnerschaft · 10 %",
                     "Unter 1 kg", "1-2 kg", "3-5 kg", "6-10 kg", "10+ kg"]) {
    assert.ok(form.includes(opt), `an option changed: ${opt}`);
  }
});

test("2c: the tab state, the handler and the submit labels are untouched", () => {
  assert.match(form, /onSubmit=\{submit\}/);
  assert.match(form, /className=\{intent==="wholesale"\?"active":""\} onClick=\{\(\)=>setIntent\("wholesale"\)\}/);
  assert.match(form, /className=\{intent==="sample"\?"active":""\} onClick=\{\(\)=>setIntent\("sample"\)\}/);
  // The Sample flow keeps its OWN submit label.
  assert.match(form, /\{intent==="sample"\?"Sample-Anfrage senden":"B2B-Konditionen anfragen"\}/);
  assert.match(callout, /onClick=\{\(\)=>choose\("sample"\)\}/);
  // The machinery behind them, unchanged.
  for (const sig of ["const submit=(e:React.FormEvent<HTMLFormElement>)=>{e.preventDefault()",
                     "const payload:LeadPayload={",
                     'window.dispatchEvent(new CustomEvent("gloa:b2b-lead",{detail:payload}))',
                     'track(intent==="sample"?"sample_request_submit":"wholesale_request_submit")',
                     "setSuccess(true)"]) {
    assert.ok(src.includes(sig), `the form logic changed: ${sig}`);
  }
  // Success state still renders both of its messages.
  assert.ok(form.includes('intent==="sample"?"Deine Sample-Anfrage ist drin.":"Danke. Wir melden uns."'));
});

/* ══════════════════════════════════════════════════════════════
   3. THE GROUNDS AND THE FORM UI
   ══════════════════════════════════════════════════════════════ */

test("3: cream callout, raspberry form, and no cards on either", () => {
  assert.match(rule(".sample-callout{"), /background:var\(--cream\)/);
  assert.match(rule(".sample-callout{"), /color:var\(--ink\)/);
  assert.match(rule(".lead-section{"), /background:var\(--berry\)/);
  assert.match(rule(".lead-section{"), /color:var\(--cream\)/);
  assert.match(css, /--cream:#F5EBE2;/);
  assert.match(css, /--berry:#A61E59;/);
  assert.match(css, /--blue:#1746D1;/);
  // The form sits directly on raspberry - no panel around it.
  assert.ok(!/\.lead-form\{[^}]*background/.test(code), "the form grew a panel");
  assert.ok(!/box-shadow:(?!none)/.test(code), "a shadow was added");
  for (const m of code.matchAll(/border-radius:([^;}]+)/g)) {
    assert.equal(m[1].trim(), "0", `a non-zero radius: ${m[1]}`);
  }
});

test("3b: bottom-border fields, cream hairlines, cream chevron, cream checkbox", () => {
  const field = rule(".lead-form input,");
  assert.match(field, /background:transparent/);
  assert.match(field, /color:var\(--cream\)/);
  assert.match(field, /border:0/);
  assert.match(field, /border-bottom:1px solid rgba\(245,235,226,\.62\)/);
  assert.match(field, /font-size:16px/);
  assert.match(code, /\.lead-form input::placeholder,[\s\S]{0,60}color:rgba\(245,235,226,\.68\)/);
  assert.match(code, /border-bottom-color:var\(--cream\)/);
  // The focus ring survives - only its colour is section-local.
  assert.match(code, /\.lead-form :focus-visible\{outline-color:var\(--cream\)\}/);
  assert.ok(!code.includes("outline:none"), "a focus outline was removed");
  assert.match(css, /:focus-visible\{outline:3px solid var\(--blue\)/);

  // Select: custom chevron, no native box.
  const sel = rule(".lead-form select{");
  assert.match(sel, /appearance:none/);
  assert.match(sel, /stroke='%23F5EBE2'/);
  // Textarea: open, no border box.
  // The standalone rule, not the grouped one all three fields share.
  assert.match(code, /\.lead-form textarea\{min-height:120px;resize:vertical\}/);
  // Checkbox: cream box, raspberry tick, never the browser default.
  const cb = rule('.lead-form .consent input[type="checkbox"]{');
  assert.match(cb, /appearance:none/);
  assert.match(cb, /border:1px solid var\(--cream\)/);
  assert.match(cb, /background:transparent/);
  assert.match(code, /:checked\{background:var\(--cream\)\}/);
  assert.match(code, /border:solid var\(--berry\)/);
});

test("3c: the tabs and both buttons are cream, never white", () => {
  const idle = rule(".lead-form .intent-tabs button{");
  assert.match(idle, /background:transparent/);
  assert.match(idle, /color:var\(--cream\)/);
  assert.match(idle, /border:1px solid rgba\(245,235,226,\.70\)/);
  assert.match(idle, /border-radius:0/);
  assert.match(idle, /min-height:52px/);
  const active = rule(".lead-form .intent-tabs button.active{");
  assert.match(active, /background:var\(--cream\)/);
  assert.match(active, /color:var\(--berry\)/);

  const submit = rule(".lead-form .cta{");
  assert.match(submit, /background:var\(--cream\)/);
  assert.match(submit, /color:var\(--blue\)/);
  assert.match(submit, /border:1px solid var\(--cream\)/);
  assert.match(rule(".lead-form .cta:hover{"), /background:transparent/);

  const cta1 = rule(".sample-callout .sample-callout-cta{");
  assert.match(cta1, /background:var\(--blue\)/);
  assert.match(cta1, /color:var\(--cream\)/);
  assert.match(rule(".sample-callout .sample-callout-cta:hover{"), /color:var\(--blue\)/);
  for (const m of code.matchAll(/transition:([^;}]+)/g)) {
    assert.ok(!/\d{3,}ms|[3-9]s/.test(m[1]), `a slow transition: ${m[1]}`);
  }
});

test("3d: .consent is answered under .lead-form, never edited", () => {
  // The shared rule the account forms read is byte-intact.
  assert.match(css, /\.consent\{grid-column:1\/-1!important;display:flex!important/);
  assert.match(css, /\.account-form \.consent\{/);
  assert.match(read("app/GloaSite.tsx"), /className="consent"/);
  // The override is scoped.
  assert.match(rule(".lead-form .consent{"), /font-size:12px!important/);
  assert.match(rule(".lead-form .consent{"), /color:var\(--cream\)/);
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
  // The callout headline is Inter on BOTH lines - never converted to a
  // serif pair.
  assert.match(rule(".sample-callout .sample-callout-line{"), /font-family:var\(--font-sans\)/);
  assert.ok(!code.includes("sample-callout-line-accent"), "the callout grew a serif line");
  assert.equal([...callout.matchAll(/<i[ >]/g)].length, 0);
  // The form pair is Inter + Cormorant italic.
  assert.match(rule(".lead-section .lead-form-line{"), /font-family:var\(--font-sans\)/);
  assert.match(rule(".lead-section .lead-form-line-accent{"), /font-family:var\(--font-display\)/);
  assert.match(rule(".lead-section .lead-form-line-accent{"), /font-style:italic/);

  const cap = t => Number(/clamp\([\d.]+px,[\d.]+vw,([\d.]+)px\)/.exec(t)[1]);
  assert.equal(cap(sizeOf(desktop, ".sample-callout .sample-callout-line{")), 58);
  assert.equal(cap(sizeOf(desktop, ".lead-section .lead-form-line{")), 60);
  assert.equal(cap(sizeOf(desktop, ".lead-section .lead-form-line-accent{")), 64);
  assert.match(rule(".lead-form label{"), /font-size:11px/);
  assert.match(rule(".sample-callout .sample-callout-eyebrow{"), /font-size:var\(--type-meta\)/);
  assert.match(rule(".lead-section .lead-form-eyebrow{"), /font-size:var\(--type-meta\)/);
  assert.match(css, /--type-meta:11px/);
  // The 75px headlines are gone.
  assert.ok(!css.includes(".sample-callout h2{font-size:75px"), "the 75px callout h2 survived");
  assert.ok(!css.includes(".lead-form h2,.form-success h2{"), "the 75px form h2 survived");
});

test("4b: both sections stay under the B2B hero at every width", () => {
  const heroBlock = css.slice(css.indexOf("/for-cafes PAGE HERO"), css.indexOf("INFO STRIP + MENU SECTION"));
  const heroCode = heroBlock.replace(/\/\*[\s\S]*?\*\//g, "");
  const heroD = heroCode.slice(0, heroCode.indexOf("@media"));
  const heroM = heroCode.slice(heroCode.indexOf("@media (max-width:900px)"));

  for (const w of [320, 360, 390, 430, 480, 640, 760, 761, 900, 1024, 1200, 1280, 1440, 1536, 1680, 1920]) {
    const heroSans = clampAt(sizeOf(w <= 900 ? heroM : heroD, ".b2b-hero .b2b-hero-line{"), w);
    const heroItal = clampAt(sizeOf(w <= 900 ? heroM : heroD, ".b2b-hero .b2b-hero-line-accent{"), w);
    const scope = w <= 760 ? mobile : desktop;
    const one = clampAt(sizeOf(scope, ".sample-callout .sample-callout-line{"), w);
    const two = clampAt(sizeOf(scope, ".lead-section .lead-form-line{"), w);
    const ital = clampAt(sizeOf(scope, ".lead-section .lead-form-line-accent{"), w);
    assert.ok(one < heroSans, `the callout (${one}) reaches the hero (${heroSans}) at ${w}px`);
    assert.ok(two < heroSans, `the form sans (${two}) reaches the hero (${heroSans}) at ${w}px`);
    assert.ok(ital < heroItal, `the form italic (${ital}) reaches the hero italic (${heroItal}) at ${w}px`);
  }
});

/* ══════════════════════════════════════════════════════════════
   5. LAYOUT, SEMANTICS AND THE FREEZES
   ══════════════════════════════════════════════════════════════ */

test("5: rails, grids, heights and headings", () => {
  assert.ok(callout.includes('className="sample-callout-inner home-rail"'));
  assert.ok(form.includes('className="lead-form home-rail"'));
  assert.ok(form.includes('className="form-success home-rail"'));
  assert.match(rule(".sample-callout{"), /padding-inline:var\(--rail-gutter\)/);
  assert.match(rule(".lead-section{"), /padding-inline:var\(--rail-gutter\)/);
  assert.match(rule(".sample-callout{"), /padding-block:clamp\(78px,7vw,104px\)/);
  assert.match(rule(".lead-section{"), /padding-block:clamp\(86px,7vw,110px\)/);
  assert.match(rule(".sample-callout-inner{"),
    /grid-template-columns:minmax\(0,1\.1fr\) minmax\(360px,\.7fr\)/);
  assert.match(rule(".lead-form{"), /grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  // No reserved height - the success block's 400px floor is gone.
  assert.ok(!/min-height:400px/.test(code), "the success floor survived");
  assert.ok(!/\dvh/.test(code), "a viewport height was used");
  for (const m of code.matchAll(/min-height:([^;}]+)/g)) {
    assert.ok(["52px", "54px", "120px"].includes(m[1].trim()), `a layout min-height: ${m[1]}`);
  }

  // One h2 each, no new h1.
  assert.equal([...callout.matchAll(/<h2[ >]/g)].length, 1);
  assert.equal([...form.matchAll(/<h2[ >]/g)].length, 2);   // form + success, one renders at a time
  assert.ok(!/<h1[ >]/.test(both));
});

test("5b: mobile stacks both, and every selector is scoped", () => {
  assert.match(code, /@media \(max-width:900px\)[\s\S]{0,200}\.sample-callout-inner\{grid-template-columns:1fr/);
  assert.match(mobile, /\.lead-form\{grid-template-columns:1fr/);
  assert.match(mobile, /\.lead-form>\*\{grid-column:1!important\}/);
  assert.match(mobile, /\.lead-form \.cta\{justify-self:stretch;width:100%/);
  assert.match(mobile, /\.sample-callout \.sample-callout-cta\{width:100%/);

  let n = 0;
  for (const m of code.matchAll(/[}{]\s*([^{}@]+?)\s*\{/g)) {
    for (const sel of m[1].split(",")) {
      const s = sel.trim();
      if (!s || s.startsWith("url(") || s.includes("svg")) continue;
      n++;
      assert.ok(/^\.(sample-callout|lead-section|lead-form|intent-tabs|form-success)/.test(s),
        `an unscoped selector: ${s}`);
    }
  }
  assert.ok(n > 20, `only ${n} selectors were scanned`);
});

test("5c: nothing else on the page moved", () => {
  // The section directly before this pair.
  assert.match(src, /<section className="b2b-support">/);
  assert.match(src, /MEHR ALS MATCHA/);
  // And every earlier B2B section.
  for (const marker of ['<section className="b2b-compare">', '<section className="b2b-portal-hint">',
                        '<section className="b2b-flow">']) {
    assert.ok(src.includes(marker), `an earlier section changed: ${marker}`);
  }
  const site = read("app/GloaSite.tsx");
  assert.match(site, /Dein Matcha\./);
  assert.match(site, /src="\/img\/B2B Packung\.png"/);
  assert.match(site, /const b2bFacts=\["SHIZUOKA, JAPAN"/);
  for (const marker of ["/about — ONE EDITORIAL SYSTEM", "/our-matcha PAGE HERO", ".home-rail{"]) {
    assert.ok(css.includes(marker), `a frozen block went missing: ${marker}`);
  }
});
