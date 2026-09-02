import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * /for-cafes — THE PROCESS AND THE ROUTE, MERGED.
 *
 * Was TWO sections: "HOW IT WORKS" on a 98px h2 over four bordered
 * cells, then a separate cream section for the origin route at 42px,
 * with 210px of stacked padding and another 140px of margin between
 * them.
 *
 * Now ONE section on one cream ground, separated only by a hairline.
 *
 * The sharpest thing these tests do is pin the CONTENT CORRECTION: the
 * Germany storage claim is gone from this section, nothing replaced it,
 * and the middle node of the route names a party rather than a place.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf8");

const src = read("app/BusinessCalculator.tsx");
const css = read("app/globals.css");

const section = src.slice(src.indexOf('<section className="b2b-flow">'),
                          src.indexOf('<section className="b2b-support">'));
assert.ok(section.length > 400, "the section markup was not found");
/* Anchored past the "=[" - the type annotation on this const contains
   a "];" of its own, which would truncate the slice to nothing. */
const stepsFrom = src.indexOf("const b2bFlowSteps");
const steps = src.slice(stepsFrom, src.indexOf("];", src.indexOf("=[", stepsFrom)));
const route = src.slice(src.indexOf("const b2bFlowRoute"), src.indexOf("];", src.indexOf("const b2bFlowRoute")));

const blockAt = css.indexOf("PROCESS + ROUTE, MERGED");
assert.notEqual(blockAt, -1, "the CSS block was not found");
const rules = css.slice(css.lastIndexOf("/*", blockAt), css.lastIndexOf("/*", css.indexOf("MEHR ALS MATCHA, THE SUPPORT SECTION")));
const code = rules.replace(/\/\*[\s\S]*?\*\//g, "");
const desktop = code.slice(0, code.indexOf("@media"));
const mobile = code.slice(code.indexOf("@media (max-width:760px)"));

const rule = name => {
  const at = code.indexOf(name);
  assert.notEqual(at, -1, `missing rule: ${name}`);
  return code.slice(at, code.indexOf("}", at));
};

/* ══════════════════════════════════════════════════════════════
   1. ONE SECTION, NOT TWO
   ══════════════════════════════════════════════════════════════ */

test("1: the two old sections are one semantic section now", () => {
  // Exactly one <section> holds both halves.
  assert.equal([...section.matchAll(/<section /g)].length, 1);
  assert.ok(section.includes('className="b2b-flow-top"'), "the process half is missing");
  assert.ok(section.includes('className="b2b-flow-route"'), "the route half is missing");
  assert.ok(section.indexOf("b2b-flow-top") < section.indexOf("b2b-flow-divider"));
  assert.ok(section.indexOf("b2b-flow-divider") < section.indexOf("b2b-flow-route"));

  // The old wrappers and their rules are gone.
  assert.ok(!src.includes('className="b2b-steps"') && !src.includes('className="supply"'),
    "an old section wrapper survived");
  assert.ok(!css.includes(".b2b-steps"), "the old process rules survived");
  assert.ok(!css.includes(".supply{") && !css.includes(".supply-path"),
    "the old route rules survived");
  // The account portal's supply TABLE is a different class and stays.
  assert.match(css, /\.supply-list\{/);
  assert.match(css, /\.supply-list-row\{/);

  // ONE ground, one rail, one divider - no second background.
  assert.match(rule(".b2b-flow{"), /background:var\(--cream\)/);
  assert.match(rule(".b2b-flow{"), /color:var\(--ink\)/);
  assert.equal([...code.matchAll(/background:var\(--cream\)/g)].length, 1,
    "a second background was painted inside the section");
  assert.ok(section.includes('className="b2b-flow-inner home-rail"'));
  assert.match(rule(".b2b-flow{"), /padding-inline:var\(--rail-gutter\)/);
  assert.match(rule(".b2b-flow{"), /padding-block:clamp\(88px,7vw,112px\) clamp\(78px,6\.5vw,104px\)/);
  assert.ok(!/min-height|\dvh/.test(code), "the section reserves height");
});

/* ══════════════════════════════════════════════════════════════
   2. THE CONTENT CORRECTION
   ══════════════════════════════════════════════════════════════ */

test("2: the Germany storage claim is gone, and nothing replaced it", () => {
  for (const banned of [
    "LAGER IN DEUTSCHLAND", "Lager in Deutschland",
    "Lokaler Bestand", "lokaler Bestand",
    "IN DEUTSCHLAND ABGEFÜLLT", "ABGEFÜLLT", "Abgefüllt",
    "DEUTSCHLAND", "Deutschland",
    "Bestand", "Lager", "Warenlager", "Versandlager",
  ]) assert.ok(!section.includes(banned) && !route.includes(banned),
    `a storage claim survived: ${banned}`);

  // The middle node names a party, not a place.
  assert.match(route, /\["SHIZUOKA","Herkunft"\]/);
  assert.match(route, /\["GLOA","Abwicklung"\]/);
  assert.match(route, /\["DEIN CAFÉ","Schnelle Nachbestellung"\]/);
  assert.equal([...route.matchAll(/\["/g)].length, 3, "the route is not three nodes");
  assert.ok(section.includes("AUS SHIZUOKA."), "the route eyebrow is missing");
  assert.ok(section.includes("FÜR DEINE KARTE."), "the route eyebrow is missing");

  // The availability note stays, and no guarantee replaced it.
  assert.ok(section.includes("Lieferzeit und Verfügbarkeit werden bei Bestellung bestätigt."));
  for (const banned of ["garantiert", "Garantie", "immer verfügbar", "stets verfügbar",
                        "sofort", "24h", "48h", "Express", "nächster Tag", "taggleich"]) {
    assert.ok(!section.includes(banned), `an availability promise: ${banned}`);
  }
});

test("2b: the authorised process copy, and the old wording is gone", () => {
  assert.ok(section.includes("SO FUNKTIONIERT&apos;S"), "the German eyebrow is missing");
  assert.ok(!section.includes("HOW IT WORKS"), "the English eyebrow survived");
  assert.ok(section.includes("Matcha, bevor") && section.includes("er ausgeht."));
  assert.ok(section.includes("In vier einfachen Schritten zu deinem Matcha,"));
  assert.ok(section.includes("passend zu deinem Bedarf."));
  // The generated-preview phrase the brief rejected.
  assert.ok(!section.includes("stets verfügbarer") && !section.includes("stets verfügbar"));

  const titles = [...steps.matchAll(/title:"([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(titles, ["Anfrage stellen", "Modell wählen", "Lieferung erhalten", "Bedarf anpassen"]);
  assert.ok(!steps.includes("Monatlich geliefert"), "the monthly-only step title survived");
  assert.ok(!steps.includes("regelmäßig geliefert"), "the old step 03 body survived");
  assert.ok(steps.includes("zuverlässig geliefert."), "the new step 03 body is missing");
  // Step 03 must not re-imply that every model is monthly.
  const step3 = steps.slice(steps.indexOf('n:"03"'), steps.indexOf('n:"04"'));
  assert.ok(!/monatlich|Monatlich/.test(step3), "step 03 still says monthly");
  assert.equal([...steps.matchAll(/n:"0[1-4]"/g)].length, 4);
});

/* ══════════════════════════════════════════════════════════════
   3. OPEN AND LINEAR - NO CARDS
   ══════════════════════════════════════════════════════════════ */

test("3: nothing is boxed, and the only rules are hairlines", () => {
  const step = rule(".b2b-flow-step{");
  assert.ok(!/background|border(?!-)/.test(step), "a step became a box");
  assert.ok(!/box-shadow/.test(code), "a shadow was added");
  // Radius only ever 0 or the icon ring.
  for (const m of code.matchAll(/border-radius:([^;}]+)/g)) {
    assert.equal(m[1].trim(), "50%", `an unexpected radius: ${m[1]}`);
  }
  // The icon ring is a 1px outline, never a filled bubble.
  const mark = rule(".b2b-flow-step-mark{");
  assert.match(mark, /border:1px solid rgba\(166,30,89,\.65\)/);
  assert.match(mark, /background:transparent/);
  assert.match(mark, /color:var\(--berry\)/);

  // Every painted line in the section is a hairline.
  assert.match(rule(".b2b-flow-divider{"), /height:1px/);
  assert.match(rule(".b2b-flow-divider{"), /background:rgba\(17,17,17,\.13\)/);
  assert.match(rule(".b2b-flow-divider{"), /margin:clamp\(56px,5vw,72px\) 0 clamp\(36px,3\.6vw,48px\)/);
  assert.match(rule(".b2b-flow-note-rule{"), /width:1px/);
  assert.match(rule(".b2b-flow-note-rule{"), /background:rgba\(17,17,17,\.14\)/);
  assert.match(section, /<span className="b2b-flow-divider" aria-hidden="true"\/>/);
  assert.match(section, /<span className="b2b-flow-note-rule" aria-hidden="true"\/>/);

  // Only cream, ink and berry - no other colour, no gradient.
  assert.ok(!code.includes("gradient"), "a gradient was added");
  for (const m of code.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) assert.fail(`a literal hex: ${m[0]}`);
  for (const m of code.matchAll(/rgba\(([^)]+)\)/g)) {
    const [r, g, b] = m[1].split(",").map(n => Number(n.trim()));
    const ok = (r === 17 && g === 17 && b === 17) || (r === 166 && g === 30 && b === 89);
    assert.ok(ok, `a non-brand rgba: rgba(${m[1]})`);
  }
  for (const m of code.matchAll(/(background|color):var\(--([a-z]+)\)/g)) {
    assert.ok(["cream", "ink", "berry"].includes(m[2]), `an unexpected token: ${m[2]}`);
  }
});

test("3b: the connectors are small text in the gap, not graphics", () => {
  assert.equal([...section.matchAll(/>→</g)].length, 2, "the arrows are not rendered from the two maps");
  assert.match(rule(".b2b-flow-step-arrow{"), /position:absolute/);
  assert.match(rule(".b2b-flow-step-arrow{"), /left:calc\(var\(--step-gap\) \/ -2\)/);
  assert.match(rule(".b2b-flow-step-arrow{"), /font-size:18px/);
  assert.match(rule(".b2b-flow-node-arrow{"), /font-size:18px/);
  assert.ok(!code.includes("::before") && !code.includes("::after"),
    "an arrow was moved into CSS content");
  // Icons: four, inline, decorative, no library.
  assert.equal([...section.matchAll(/<svg /g)].length, 1, "the icons are not one template");
  assert.equal([...steps.matchAll(/icon:"/g)].length, 4);
  assert.match(section, /aria-hidden="true"/);
  assert.match(section, /focusable="false"/);
  assert.match(section, /stroke="currentColor"/);
  assert.ok(!/react-icons|lucide|@heroicons/.test(src), "an icon library was added");
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
  assert.match(rule(".b2b-flow .b2b-flow-line{"), /font-family:var\(--font-sans\)/);
  assert.match(rule(".b2b-flow .b2b-flow-line-accent{"), /font-family:var\(--font-display\)/);
  assert.match(rule(".b2b-flow .b2b-flow-line-accent{"), /font-style:italic/);

  const cap = t => Number(/clamp\([\d.]+px,[\d.]+vw,([\d.]+)px\)/.exec(t)[1]);
  assert.equal(cap(sizeOf(desktop, ".b2b-flow .b2b-flow-line{")), 58);
  assert.equal(cap(sizeOf(desktop, ".b2b-flow .b2b-flow-line-accent{")), 62);
  assert.equal(cap(sizeOf(desktop, ".b2b-flow-step-title{")), 19);
  assert.equal(cap(sizeOf(desktop, ".b2b-flow-step-body{")), 15);
  assert.equal(cap(sizeOf(desktop, ".b2b-flow-node-main{")), 30);
  assert.equal(cap(sizeOf(desktop, ".b2b-flow-node-sub{")), 13);
  assert.match(rule(".b2b-flow .b2b-flow-eyebrow{"), /font-size:var\(--type-meta\)/);
  assert.match(rule(".b2b-flow .b2b-flow-route-eyebrow{"), /font-size:var\(--type-meta\)/);
  assert.match(css, /--type-meta:11px/);
  assert.match(rule(".b2b-flow-step-number{"), /font-size:12px/);
  assert.match(rule(".b2b-flow-step-number{"), /color:var\(--berry\)/);
  assert.match(rule(".b2b-flow .b2b-flow-eyebrow{"), /color:var\(--berry\)/);
});

test("4b: the section stays under the B2B hero at every width", () => {
  // The B2B hero no longer carries a size of its own. Every true page
  // hero reads the shared homepage scale, so the two tokens ARE the
  // hero - see tests/page-hero-typography.test.mjs. They are declared
  // once in :root and redefined once at 900px, in that order.
  const heroTok = (name, w) => {
    const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const all = bare.split(name + ":").slice(1).map((t) => t.slice(0, t.indexOf(")") + 1));
    assert.equal(all.length, 2, `${name} is not declared exactly twice`);
    return w <= 900 ? all[1] : all[0];
  };

  for (const w of [320, 360, 390, 430, 480, 640, 760, 761, 900, 1024, 1200, 1280, 1440, 1536, 1680, 1920]) {
    const heroSans = clampAt(heroTok("--type-hero-primary", w), w);
    const heroItal = clampAt(heroTok("--type-hero-secondary", w), w);
    const scope = w <= 760 ? mobile : desktop;
    const sans = clampAt(sizeOf(scope, ".b2b-flow .b2b-flow-line{"), w);
    const ital = clampAt(sizeOf(scope, ".b2b-flow .b2b-flow-line-accent{"), w);
    const node = clampAt(sizeOf(desktop, ".b2b-flow-node-main{"), w);
    assert.ok(sans < heroSans, `the section sans (${sans}) reaches the hero (${heroSans}) at ${w}px`);
    assert.ok(ital < heroItal, `the section italic (${ital}) reaches the hero italic (${heroItal}) at ${w}px`);
    assert.ok(node < sans, `a route node (${node}) reaches the section title (${sans}) at ${w}px`);
  }
  assert.ok(!css.includes(".b2b-steps h2"), "the 98px process h2 survived");
});

/* ══════════════════════════════════════════════════════════════
   5. RESPONSIVE AND THE FREEZES
   ══════════════════════════════════════════════════════════════ */

test("5: tablet goes two-by-two, mobile stacks", () => {
  const tablet = code.slice(code.indexOf("@media (max-width:1100px)"), code.indexOf("@media (max-width:760px)"));
  assert.match(tablet, /\.b2b-flow-top\{grid-template-columns:1fr/);
  assert.match(tablet, /\.b2b-flow-steps\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  // The arrow that would start a row has no gap to sit in.
  assert.match(tablet, /\.b2b-flow-step:nth-child\(odd\) \.b2b-flow-step-arrow\{display:none\}/);

  assert.match(mobile, /\.b2b-flow-steps\{grid-template-columns:1fr/);
  assert.match(mobile, /\.b2b-flow-step-arrow\{display:none\}/);
  // Stacked steps get a hairline between them instead of an arrow.
  assert.match(mobile, /border-top:1px solid rgba\(17,17,17,\.13\)/);
  assert.match(mobile, /\.b2b-flow-step:first-child\{border-top:0/);
  // The route stacks and its arrows turn to point down it.
  assert.match(mobile, /\.b2b-flow-path\{flex-direction:column/);
  assert.match(mobile, /rotate:90deg/);
  // Source order IS the stacked order.
  assert.ok(section.indexOf("b2b-flow-intro") < section.indexOf("b2b-flow-steps"));
  assert.ok(section.indexOf("b2b-flow-steps") < section.indexOf("b2b-flow-route-eyebrow"));
  assert.ok(section.indexOf("b2b-flow-path") < section.indexOf("b2b-flow-note"));
});

test("5b: one h2, h3 per step, and every selector is scoped", () => {
  assert.equal([...section.matchAll(/<h2[ >]/g)].length, 1);
  assert.equal([...section.matchAll(/<h3[ >]/g)].length, 1);   // rendered four times from one template
  assert.ok(!/<h1[ >]/.test(section));
  assert.match(section, /<h3 className="b2b-flow-step-title">/);
  // The steps are an ordered list, and the route nodes are not headings.
  assert.match(section, /<ol className="b2b-flow-steps">/);
  assert.ok(!/<h[1-6][^>]*>\{main\}/.test(section));

  let n = 0;
  for (const m of code.matchAll(/[}{]\s*([^{}@]+?)\s*\{/g)) {
    for (const sel of m[1].split(",")) {
      const s = sel.trim();
      if (!s) continue;
      n++;
      assert.ok(/^\.b2b-flow/.test(s), `an unscoped selector: ${s}`);
    }
  }
  assert.ok(n > 20, `only ${n} selectors were scanned`);
});

test("5c: nothing else on the page moved", () => {
  // The section directly before, and the one directly after.
  assert.match(src, /<section className="b2b-portal-hint">/);
  assert.match(src, /B2B KUNDENPORTAL/);
  assert.match(src, /<section className="b2b-support">/);
  assert.match(src, /MEHR ALS MATCHA/);
  // The rest of the B2B page.
  assert.match(src, /FLEXIBEL &amp; PLANBAR/);
  assert.match(src, /const b2bModels=\[/);
  for (const marker of ['className="sample-callout"', 'id="lead"', "const payload:LeadPayload={",
                        'window.dispatchEvent(new CustomEvent("gloa:b2b-lead",{detail:payload}))']) {
    assert.ok(src.includes(marker), `the page changed beyond this section: ${marker}`);
  }
  const site = read("app/GloaSite.tsx");
  assert.match(site, /Dein Matcha\./);
  assert.match(site, /src="\/img\/B2B Packung\.png"/);
  assert.match(site, /const b2bFacts=\["SHIZUOKA, JAPAN"/);
  assert.match(site, /Einfach zubereitet\./);
  for (const marker of ["/about — ONE EDITORIAL SYSTEM", "/our-matcha PAGE HERO", ".home-rail{"]) {
    assert.ok(css.includes(marker), `a frozen block went missing: ${marker}`);
  }
});
