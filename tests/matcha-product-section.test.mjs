import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * THE MERGED PRODUCT + TASTE SECTION ON /our-matcha.
 *
 * The page is statically composed, so the facts worth pinning are in the
 * source: that the two sections became ONE, that every line of copy
 * survived the move, and that a section-scale headline stays under the
 * page hero while the taste sub-heading stays under it in turn.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf8");

const site = read("app/GloaSite.tsx");
const css = read("app/globals.css");

const page = site.slice(site.indexOf("function MatchaPage()"), site.indexOf("\nfunction ", site.indexOf("function MatchaPage()") + 5));
const section = page.slice(page.indexOf('<section className="matcha-product">'),
                           page.indexOf('<section className="matcha-shizuoka">'));
const rules = css.slice(css.indexOf("/our-matcha PRODUCT + TASTE, MERGED"), css.indexOf("/our-matcha RESEARCH SECTION"));
const rule = name => {
  const at = rules.indexOf(name);
  assert.notEqual(at, -1, `missing rule: ${name}`);
  return rules.slice(at, rules.indexOf("}", at));
};

/* ══════════════════════════════════════════════════════════════
   1. ONE SECTION
   ══════════════════════════════════════════════════════════════ */

test("1: product and taste share one wrapper, and the old pair is gone", () => {
  // ONE <section>, holding both content groups.
  assert.equal([...section.matchAll(/<section /g)].length, 1, "the taste content is still its own section");
  assert.ok(section.indexOf("DAS PRODUKT") < section.indexOf("GESCHMACK"), "the groups swapped order");
  assert.match(section, /<div className="matcha-product-inner home-rail">/);
  // The taste block is INSIDE the right column, under a hairline.
  const detail = section.slice(section.indexOf('className="matcha-product-detail"'));
  assert.ok(detail.includes('className="matcha-taste-block"'), "the taste block left the product column");
  assert.match(rules, /\.matcha-taste-block\{[\s\S]*?border-top:1px solid rgba\(245,235,226,\.3\)/);

  // ── THE TWO RETIRED SECTIONS ARE GONE, MARKUP AND STYLE ──────
  for (const gone of ['className="matcha-facts"', 'className="matcha-taste"',
                      "matcha-facts-grid", "matcha-taste-grid"]) {
    assert.ok(!site.includes(gone), `the retired markup survived: ${gone}`);
  }
  for (const gone of [".matcha-facts{padding:110px", ".matcha-taste{padding:110px",
                      ".matcha-facts-grid{", ".matcha-taste-grid{"]) {
    assert.ok(!css.includes(gone), `the retired rule survived: ${gone}`);
  }
  // ONE SURFACE. The only other background in the block is the 1px
  // divider's own fade, which paints a line rather than an area.
  const surfaces = [...rules.matchAll(/background:([^;}]+)/g)].map(m => m[1].trim());
  const areas = surfaces.filter(v => !v.startsWith("linear-gradient"));
  assert.deepEqual([...new Set(areas)], ["var(--blue)"]);
  assert.equal(surfaces.length - areas.length, 1, "more than one gradient appeared");
  assert.match(css, /--blue:#1746D1;/);
});

/* ══════════════════════════════════════════════════════════════
   2. EVERY LINE OF COPY SURVIVED
   ══════════════════════════════════════════════════════════════ */

test("2: the copy moved without being rewritten", () => {
  for (const line of [
    "DAS PRODUKT", "Ein Grün.", "Klar erklärt.",
    "GLOA Matcha ist 100 % Bio-Matcha aus Shizuoka, Japan: fein gemahlenes Grünteepulver, kein Zusatz, keine Mischung. Die Verpackung ist licht-, luft- und feuchtigkeitsdicht, damit Farbe und Geschmack erhalten bleiben.",
    "HERKUNFT", "Shizuoka, Japan",
    "QUALITÄT", "100 % Bio-Matcha",
    "VERWENDUNG", "Latte · Iced · Pur",
    "GRÖSSEN", "30 g · 50 g · 100 g",
    "LAGER", "Deutschland",
    "GESCHMACK", "Wie schmeckt", "GLOA?",
    "Der Matcha zeichnet sich durch seine leuchtend grüne Farbe, feine Textur und seinen ausgewogenen Geschmack aus. Natürliche Süße und angenehmes Umami treffen auf eine dezente, frische Herbe, weich genug für den puren Genuss und gleichzeitig intensiv genug für Matcha Lattes.",
    "Ausgewogen, cremig, leicht süßlich & umami",
    "AROMA", "Frisch, vegetal & fein",
  ]) {
    assert.ok(section.includes(line), `the merge lost: ${line}`);
  }
  // Five facts, then the taste pair - and no invented sixth cell.
  const facts = section.slice(section.indexOf('className="matcha-fact-grid"'), section.indexOf('className="matcha-taste-block"'));
  assert.deepEqual([...facts.matchAll(/<dt>([^<]+)<\/dt>/g)].map(m => m[1]),
    ["HERKUNFT", "QUALITÄT", "VERWENDUNG", "GRÖSSEN", "LAGER"]);
  assert.match(rules, /\.matcha-fact-grid\{[\s\S]*?grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
  const pair = section.slice(section.indexOf('className="matcha-taste-pair"'));
  assert.deepEqual([...pair.matchAll(/<dt>([^<]+)<\/dt>/g)].map(m => m[1]), ["GESCHMACK", "AROMA"]);

  // ── NO ICONS, NO CARDS ───────────────────────────────────────
  assert.ok(!/<svg|<img/.test(section), "an icon or image was added");
  for (const banned of ["border-radius", "box-shadow", "backdrop-filter"]) {
    assert.ok(!rules.includes(banned), `the section grew a card: ${banned}`);
  }
  // The one gradient in the block belongs to the divider and softens its
  // two ends - it is not an area fill.
  assert.equal([...rules.matchAll(/linear-gradient/g)].length, 1);
  assert.match(rule(".matcha-product-divider{"), /background:linear-gradient\(/);
  // Only the two hairline colours the brief allows.
  for (const m of rules.matchAll(/border-top:1px solid ([^;}]+)/g)) {
    assert.equal(m[1].trim(), "rgba(245,235,226,.3)");
  }
});

/* ══════════════════════════════════════════════════════════════
   3. THE SCALE
   ══════════════════════════════════════════════════════════════ */

test("3: a section under the page hero, and a sub-heading under that", () => {
  const clamp = (lo, mid, hi) => Math.max(lo, Math.min(mid, hi));
  const parse = t => /clamp\(([\d.]+)px,([\d.]+)vw,([\d.]+)px\)/.exec(t).slice(1).map(Number);
  const at = (t, w) => { const [lo, vw, hi] = parse(t); return clamp(lo, (vw / 100) * w, hi); };
  const token = n => new RegExp("--type-" + n + ":([^;]+);").exec(css)[1];
  // The section headline reads the page-wide tokens rather than its own
  // numbers, so it cannot drift from the homepage's own sections.
  assert.match(rule(".matcha-product-line{"), /font-size:var\(--type-title\)/);
  assert.match(rule(".matcha-product-line-accent{"), /font-size:var\(--type-editorial\)/);
  assert.equal(parse(token("title"))[2], 64);
  assert.equal(parse(token("editorial"))[2], 68);

  // The page hero reads the shared page-hero token now, so the curve is
  // taken from the token - a lazy match on the rule would run past the
  // var() and pick up whatever clamp appears next in the file.
  assert.match(css, /\.matcha-hero-line\{[\s\S]*?font-size:var\(--type-page-hero\)/);
  const pageHero = token("page-hero");
  const tasteSans = /\.matcha-taste-line\{[\s\S]*?font-size:(clamp\([^)]*\))/.exec(rules)[1];
  const tasteAccent = /\.matcha-taste-line-accent\{[\s\S]*?font-size:(clamp\([^)]*\))/.exec(rules)[1];
  for (const w of [320, 390, 430, 640, 900, 1024, 1200, 1440, 1536, 1920]) {
    const title = at(token("title"), w);
    const editorial = at(token("editorial"), w);
    // PAGE HERO > SECTION TITLE.
    assert.ok(at(pageHero, w) > title, `the section title reaches the page hero at ${w}px`);
    // SECTION TITLE > TASTE SUB-HEADING.
    assert.ok(title > at(tasteSans, w), `the taste heading reaches the section title at ${w}px`);
    assert.ok(editorial > at(tasteAccent, w), `the taste accent reaches the section accent at ${w}px`);
  }
  // The 98px shared h2 scale this section used to inherit is not read here.
  assert.ok(!rules.includes("clamp(48px,7vw,98px)"), "the retired 98px scale survived");
});

/* ══════════════════════════════════════════════════════════════
   4. TYPE, COLOUR, RAIL
   ══════════════════════════════════════════════════════════════ */

test("4: two families, cream on blue, canonical rail", () => {
  // Cream everywhere - no near black, no raspberry, no plum.
  for (const name of [".matcha-product-eyebrow{", ".matcha-product-line{", ".matcha-product-line-accent{",
                      ".matcha-product-intro{", ".matcha-fact-grid dt{", ".matcha-fact-grid dd{",
                      ".matcha-taste-eyebrow{", ".matcha-taste-line{", ".matcha-taste-line-accent{",
                      ".matcha-taste-body{", ".matcha-taste-pair dt{", ".matcha-taste-pair dd{"]) {
    assert.match(rule(name), /color:var\(--cream\)/, `${name} is not cream`);
  }
  for (const banned of ["var(--berry)", "var(--plum)", "var(--ink)", "var(--matcha)", "var(--line)"]) {
    assert.ok(!rules.includes(banned), `the section uses ${banned}`);
  }

  // TWO FAMILIES. The display face carries the two editorial lines and
  // nothing else; the facts are functional and stay on the sans.
  for (const name of [".matcha-product-line-accent{", ".matcha-taste-line-accent{"]) {
    const r = rule(name);
    assert.match(r, /font-family:var\(--font-display\)/);
    assert.match(r, /font-style:italic/);
    assert.match(r, /font-weight:400/);
  }
  for (const name of [".matcha-product-line{", ".matcha-fact-grid dd{", ".matcha-taste-line{", ".matcha-taste-pair dd{"]) {
    const r = rule(name);
    assert.match(r, /font-family:var\(--font-sans\)/, `${name} is not on the sans`);
    assert.ok(!r.includes("--font-display"), `${name} uses the display face`);
  }
  for (const m of rules.matchAll(/font-family:([^;}]+)/g)) {
    assert.match(m[1], /^var\(--font-(sans|display)\)/, `a third family: ${m[1]}`);
  }
  // Meta reads the shared token; values are Inter 600.
  for (const name of [".matcha-product-eyebrow{", ".matcha-taste-eyebrow{", ".matcha-fact-grid dt{", ".matcha-taste-pair dt{"]) {
    assert.match(rule(name), /font-size:var\(--type-meta\)/, `${name} is not on the meta scale`);
  }
  assert.match(rule(".matcha-fact-grid dd{"), /font-weight:600/);
  assert.match(rule(".matcha-product-intro{"), /font-size:var\(--type-body\)/);

  // ── RAIL, RATIO, HEIGHT ──────────────────────────────────────
  assert.match(css, /\.matcha-hero,\s*\.matcha-product,\s*\.matcha-research,\s*\.matcha-use\{padding-inline:var\(--rail-gutter\)\}/);
  assert.match(rules, /\.matcha-product-inner\{[\s\S]*?grid-template-columns:minmax\(0,\.45fr\) 1px minmax\(0,\.55fr\)/);
  assert.match(rules, /\.matcha-product-inner\{[\s\S]*?align-items:start/);
  assert.match(rules, /\.matcha-product\{[\s\S]*?padding-block:clamp\(90px,8vw,110px\)/);
  assert.ok(!rules.includes("100vh"), "the section reserves a viewport");
  assert.ok(!/\.matcha-product\{[^}]*min-height/.test(rules), "the section has a fixed height");
  assert.ok(!rules.includes("position:sticky"), "an unrequested sticky column appeared");
  // Stacks to one column, and the facts stop being three-up on a phone.
  assert.match(rules, /@media \(max-width:1024px\)\{[\s\S]*?\.matcha-product-inner\{grid-template-columns:1fr/);
  assert.match(rules, /@media \(max-width:640px\)\{[\s\S]*?grid-template-columns:1fr;gap:0\}/);
});

/* ══════════════════════════════════════════════════════════════
   5. THE LEGACY PLUM ORIGIN SECTION
   ══════════════════════════════════════════════════════════════ */

test("5: the plum origin block is hidden, and every line of it survives", () => {
  // ── NOT RENDERED ─────────────────────────────────────────────
  // One named flag decides, in the same shape SHOP_STATUS and
  // SHOP_HIDDEN_SLUGS already use elsewhere in this file.
  assert.match(site, /const SHOW_LEGACY_ORIGIN_SECTION:boolean=false;/);
  assert.match(page, /\{SHOW_LEGACY_ORIGIN_SECTION&&<section className="matcha-shizuoka">/);
  // The blue product section is followed by the berry one directly - the
  // plum block is not between them any more.
  const flow = [...page.matchAll(/<section className="(matcha-[a-z-]+)"/g)].map(m => m[1]);
  assert.ok(flow.indexOf("matcha-product") + 1 === flow.indexOf("matcha-shizuoka"),
    "the flag no longer sits where the section used to render");

  // ── NOT DELETED ──────────────────────────────────────────────
  for (const line of [
    "HERKUNFT", "Aus Shizuoka,", "Japan.",
    "Unser Matcha kommt aus Shizuoka, einer der bekanntesten Teeregionen Japans. Das Blatt wird industriell zu feinem Pulver vermahlen.",
    "Wir planen, Shizuoka in Zukunft selbst zu besuchen und dir mehr von dort zu zeigen.",
    "AUF TIKTOK FOLGEN", "https://www.tiktok.com/@gloa.matcha",
  ]) {
    assert.ok(page.includes(line), `hiding the section deleted: ${line}`);
  }
  assert.match(css, /\.matcha-shizuoka\{padding:110px 5vw;background:var\(--plum\)/);
  assert.match(css, /\.matcha-build-note\{/);
  // The TikTok address is still configured where the rest of the site
  // reads it, so nothing else lost its link.
  assert.match(read("app/Chrome.tsx"), /tiktok\.com\/@gloa\.matcha/);

  // ── NOTHING REPLACED IT, AND NO GAP WAS LEFT ─────────────────
  // The section carried its own 110px padding, so the blue section and
  // the berry one below it now meet on their own paddings.
  assert.match(css, /\.matcha-what\{padding:110px 5vw;background:var\(--berry\)/);
  assert.ok(!page.includes("matcha-origin-spacer") && !page.includes('className="spacer"'),
    "a spacer was left behind");
  // The next section after the hidden block is the one that always
  // followed it - nothing was slotted into the space.
  const after = page.slice(page.indexOf('<section className="matcha-shizuoka">'));
  assert.match(after.slice(after.indexOf("</section>")), /^<\/section>\}\s*<section className="matcha-what">/,
    "something was inserted where the section used to be");
});

/* ══════════════════════════════════════════════════════════════
   6. THE CENTRE DIVIDER
   ══════════════════════════════════════════════════════════════ */

test("6: a partial, decorative seam between the two main columns", () => {
  // ── ITS OWN GRID TRACK, NOT A GUESSED OFFSET ─────────────────
  // The split is .45/.55, so anything anchored at 50% would miss the
  // seam. A 1px track puts it exactly on the column boundary and gives
  // it the section's gap on BOTH sides.
  assert.match(rules, /\.matcha-product-inner\{[\s\S]*?grid-template-columns:minmax\(0,\.45fr\) 1px minmax\(0,\.55fr\)/);
  assert.match(section, /<\/div><span className="matcha-product-divider" aria-hidden="true"\/><div className="matcha-product-detail">/);
  assert.ok(section.indexOf("matcha-product-copy") < section.indexOf("matcha-product-divider"));
  assert.ok(section.indexOf("matcha-product-divider") < section.indexOf("matcha-product-detail"));

  // ── 1PX, CREAM AT .28, PARTIAL HEIGHT, CENTRED ───────────────
  const divider = rule(".matcha-product-divider{");
  assert.match(divider, /width:1px/);
  assert.match(divider, /height:clamp\(260px,38vw,440px\)/);
  assert.match(divider, /align-self:center/);
  assert.match(divider, /rgba\(245,235,226,\.28\)/);
  // NOT full height, and nothing else paints it.
  assert.ok(!/\.matcha-product-divider\{[^}]*height:100%/.test(rules), "the seam runs the full height");
  assert.ok(!/\.matcha-product-divider\{[^}]*(border|box-shadow|border-radius)/.test(rules));
  // The gap is the spacing on each side - 57.6px at 1440, 72px at cap.
  assert.match(rules, /\.matcha-product-inner\{[\s\S]*?gap:clamp\(32px,4vw,72px\)/);

  // ── DECORATIVE, AND GONE WHEN THE SECTION STACKS ─────────────
  assert.match(section, /aria-hidden="true"/);
  assert.ok(!/matcha-product-divider[^>]*>[^<]/.test(section), "the seam carries text");
  assert.match(rules, /@media \(max-width:1024px\)\{[\s\S]*?\.matcha-product-divider\{display:none\}/);

  // ── THE INTERNAL HAIRLINES ARE A DIFFERENT THING, AND STAY ───
  assert.match(rules, /\.matcha-fact-grid>div\{[\s\S]*?border-top:1px solid rgba\(245,235,226,\.3\)/);
  assert.match(rules, /\.matcha-taste-pair>div\{[\s\S]*?border-top:1px solid rgba\(245,235,226,\.3\)/);
  assert.match(rules, /\.matcha-taste-block\{[\s\S]*?border-top:1px solid rgba\(245,235,226,\.3\)/);
});
