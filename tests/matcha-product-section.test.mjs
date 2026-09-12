import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * WHAT MATCHA IS, HOW IT IS MADE, THE FACTS, AND HOW IT TASTES.
 *
 * /our-matcha used to answer the same question in four places: a fact
 * grid, a taste block, a "was ist Matcha" block, and a storage band that
 * existed for two sentence fragments. This pass merged the first three
 * into ONE band and folded storage into the fact row, then gave taste a
 * band of its own.
 *
 * The page is statically composed, so everything worth pinning is in the
 * source: which blocks exist, that no line of copy was lost on the way,
 * that the production steps make no claim about our own supplier, and
 * that nothing here can state a size the catalog does not sell.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf8");

const site = read("app/GloaSite.tsx");
const css = read("app/globals.css");

const page = site.slice(site.indexOf("function MatchaPage()"), site.indexOf("\nfunction ", site.indexOf("function MatchaPage()") + 5));
const section = page.slice(page.indexOf('<section className="matcha-explain">'),
                           page.indexOf('{SHOW_LEGACY_ORIGIN_SECTION'));
const taste = page.slice(page.indexOf('<section className="matcha-taste">'),
                         page.indexOf('<section className="matcha-research">'));
const rules = css.slice(css.indexOf("/our-matcha — WHAT IT IS, HOW IT IS MADE, AND THE FACTS"),
                        css.indexOf("/our-matcha RESEARCH SECTION"));
const rule = name => {
  const at = rules.indexOf(name);
  assert.notEqual(at, -1, `missing rule: ${name}`);
  return rules.slice(at, rules.indexOf("}", at));
};
// The four steps live in their own component now: they render as a
// plain list or as an accordion depending on the width, and that
// decision needs state.
const process = site.slice(site.indexOf("function MatchaProcess()"),
                           site.indexOf("function MatchaResearchSheet"));
// The three data lists the band renders from.
const list = name => site.slice(site.indexOf(`const ${name}`), site.indexOf("];", site.indexOf(`const ${name}`)));

/* ══════════════════════════════════════════════════════════════
   1. ONE BAND, AND THE OLD ONES ARE GONE
   ══════════════════════════════════════════════════════════════ */

test("1: explanation, process, photo and facts share one section", () => {
  // Brief 1: the page's order is fixed, and no extra section was
  // invented to hold any of this.
  const flow = [...page.matchAll(/<section className="(matcha-[a-z-]+)"/g)].map(m => m[1]);
  assert.deepEqual(flow, [
    "matcha-hero",      // 1 HERO / HERKUNFT
    "matcha-explain",   // 2 + 3 what it is, how it is made, the facts
    "matcha-shizuoka",  //     the hidden legacy block, see test 7
    "matcha-taste",     // 4 how GLOA tastes
    "matcha-research",  // 5
    "matcha-howto",     //     the hidden legacy block, see test 7
    "matcha-use",       // 6 latte / iced / pur
    "matcha-cta",       // 8
  ], "the page order changed");
  // 7 (FAQ) renders <section className="faq">, shared with /for-cafes.
  assert.ok(page.indexOf('<section className="faq"') > page.indexOf('<section className="matcha-use">'));
  assert.ok(page.indexOf('<section className="faq"') < page.indexOf('<section className="matcha-cta">'));

  // The band's three areas, in order.
  for (const part of ["matcha-explain-top", "matcha-explain-copy", "<MatchaProcess/>", "matcha-facts"]) {
    assert.ok(section.includes(part), `missing area: ${part}`);
  }
  assert.ok(section.indexOf("matcha-explain-copy") < section.indexOf("<MatchaProcess/>"));
  assert.ok(section.indexOf("matcha-explain-top") < section.indexOf("matcha-facts"));

  // THE POWDER PHOTO IS GONE, and it left no track behind: the row is
  // two content columns, not two plus an empty one.
  assert.ok(!site.includes("matcha-explain-photo"), "the photo markup survived");
  assert.ok(!css.includes("matcha-explain-photo"), "the photo CSS survived");
  // Scoped to this page: the same file is the shop's product imagery
  // and is not this pass's to remove.
  assert.ok(!page.includes("Produkt Bild"), "the powder image is still on /our-matcha");
  assert.ok(!process.includes("Produkt Bild"), "the powder image moved into the process block");
  assert.ok(!/<img|<figure/.test(section + process), "the band renders an image again");
  assert.match(rule(".matcha-explain-top{"), /grid-template-columns:minmax\(0,\.92fr\) minmax\(0,1\.08fr\)/);
  // The only image left on the page is the hero's map, which this pass
  // was told not to touch.
  assert.equal([...page.matchAll(/<img /g)].length, 1);
  assert.match(page, /<img src="\/img\/Japan_Karte\.png"/);

  // THE RETIRED BLOCKS. Not renamed, not orphaned: gone from markup and
  // from the stylesheet, so nothing styles an element that cannot exist.
  for (const dead of ["matcha-product", "matcha-storage", "matcha-what", "matcha-image"]) {
    assert.ok(!page.includes(dead), `retired markup survived: ${dead}`);
    assert.ok(!css.includes(`.${dead}`), `retired CSS survived: .${dead}`);
  }
});

/* ══════════════════════════════════════════════════════════════
   2. WHAT MATCHA IS - BRIEF 2 AND 3
   ══════════════════════════════════════════════════════════════ */

test("2: the explanation is general, in full sentences, and said once", () => {
  assert.ok(section.includes('<p className="eyebrow matcha-explain-eyebrow">WAS IST MATCHA?</p>'));
  assert.ok(section.includes('<span className="matcha-explain-line">Matcha.</span>'));
  assert.ok(section.includes('<i className="matcha-explain-line matcha-explain-line-accent">Klar erklärt.</i>'));
  // The abstract headline this replaced is gone.
  assert.ok(!page.includes("Ein Grün."), "the retired headline survived");

  for (const line of [
    "Matcha ist fein vermahlener grüner Tee. Anders als bei aufgegossenem Tee wird bei Matcha das gemahlene Teeblatt direkt mitgetrunken.",
    "Dadurch unterscheidet sich Matcha sowohl in seiner Herstellung als auch in seiner Zubereitung von klassischem Grüntee.",
  ]) {
    assert.ok(section.includes(line), `the explanation is missing: ${line}`);
  }
  // It does NOT pre-empt taste, storage or usage - each has its own home.
  const copy = section.slice(section.indexOf("matcha-explain-copy"), section.indexOf("matcha-process"));
  for (const early of ["schmeckt", "Umami", "lagern", "Latte", "Iced"]) {
    assert.ok(!copy.includes(early), `the explanation answers ${early} too early`);
  }
  // No illustration stands in for the removed photo either.
  for (const asset of ["gloa-work.jpg", "gloa-iced.jpg", ".svg", "background-image"]) {
    assert.ok(!section.includes(asset), `an image came back into the band: ${asset}`);
  }
});

/* ══════════════════════════════════════════════════════════════
   3. HOW MATCHA IS MADE - BRIEF 4 AND 5
   ══════════════════════════════════════════════════════════════ */

test("3: four steps, in full sentences, describing MATCHA and not our supplier", () => {
  assert.ok(process.includes('<h3 className="matcha-process-title">Wie Matcha entsteht</h3>'));
  // It says out loud that this is general production. That sentence is
  // what keeps the four steps from reading as a supply-chain claim.
  assert.ok(process.includes('<p className="matcha-process-note">So wird Matcha allgemein hergestellt.</p>'));

  const steps = [...list("matchaProcess").matchAll(/\["(\d\d)","([^"]+)","([^"]+)"\]/g)];
  assert.equal(steps.length, 4, "the brief caps this at four steps");
  assert.deepEqual(steps.map(s => s[1]), ["01", "02", "03", "04"]);
  assert.deepEqual(steps.map(s => s[2]), ["BESCHATTUNG", "BLÄTTER", "VERARBEITUNG", "VERMAHLUNG"]);

  // Brief 5 asks that shading, harvest, processing and grinding are all
  // covered. The HARVEST STAGE is covered in prose ("Vor der Ernte...")
  // rather than as a labelled step, because tests/legal-content.test.mjs
  // bans harvest and grade wording as a heading across the whole site -
  // that ban came from the business and a process section is not a
  // reason to reopen it.
  const prose = steps.map(s => s[3]).join(" ");
  for (const stage of ["beschattet", "Ernte", "gedämpft", "vermahlen"]) {
    assert.ok(prose.includes(stage), `the process skips a stage: ${stage}`);
  }
  assert.ok(prose.includes("Tencha"), "the tencha step was dropped");

  // Full sentences, not label fragments.
  for (const [, , label, text] of steps) {
    assert.match(text, /\.$/, `not a sentence: ${label}`);
    assert.ok(text.split(" ").length >= 10, `still a fragment: ${label}`);
  }
  // NO CLAIM ABOUT OUR OWN PRODUCT, and no grade vocabulary.
  for (const claim of ["unser", "Unser", "GLOA", "hochwertig", "beste", "Premium", "handverlesen"]) {
    assert.ok(!prose.includes(claim), `the process claims something about us: ${claim}`);
  }
  for (const dash of ["–", "—"]) {
    assert.ok(!prose.includes(dash), `a dash was introduced: ${dash}`);
  }
});

/* ══════════════════════════════════════════════════════════════
   4. THE FACTS, AND STORAGE AMONG THEM - BRIEF 6 AND 7
   ══════════════════════════════════════════════════════════════ */

test("4: storage is a product fact now, not a band of its own", () => {
  // 6. NO SEPARATE STORAGE SECTION anywhere on the page.
  assert.ok(!page.includes("matcha-storage"), "the storage band survived");
  assert.ok(!/<section[^>]*>\s*<p className="eyebrow[^"]*">LAGERUNG/.test(page),
    "storage got a section of its own again");

  // 7. It is a row in the fact list, and it reads the ONE confirmed
  // value rather than a hand-typed copy of it, so the food-info wording
  // on this page cannot drift from the product page's.
  const facts = [...list("matchaFacts").matchAll(/\["([A-ZÄÖÜ]+)",(PRODUCT\.storage|"[^"]*"),"([^"]+)"\]/g)];
  assert.deepEqual(facts.map(f => f[1]), ["HERKUNFT", "ZUTAT", "GRÖSSEN", "LAGERUNG"]);
  const storage = facts.find(f => f[1] === "LAGERUNG");
  assert.equal(storage[2].trim(), "PRODUCT.storage", "the page hand-types the storage wording");
  assert.match(read("app/content.ts"),
    /storage: "Kühl, trocken und lichtgeschützt lagern\. Nach dem Öffnen gut verschlossen aufbewahren\.",/);

  // Every fact carries an explaining sentence, which is what made the
  // old label-fragment rows readable.
  for (const [, label, , text] of facts) {
    assert.match(text, /\.$/, `not a sentence: ${label}`);
    assert.ok(text.split(" ").length >= 8, `still a fragment: ${label}`);
  }
  // BESTAND named a warehouse and VERWENDUNG previewed a section three
  // bands further down. Both left, and neither came back.
  for (const gone of ["BESTAND", "VERWENDUNG"]) {
    assert.ok(!section.includes(gone), `a retired fact came back: ${gone}`);
  }
  // Rendered as a description list, so it is a fact table to a reader.
  assert.match(section, /<dl className="matcha-facts-list">/);
  assert.match(section, /<dt className="matcha-fact-label">\{label\}<\/dt>/);
});

/* ══════════════════════════════════════════════════════════════
   5. HOW GLOA TASTES - BRIEF 8
   ══════════════════════════════════════════════════════════════ */

test("5: the taste band describes THIS matcha, with no health angle", () => {
  assert.ok(taste.includes('<p className="eyebrow matcha-taste-eyebrow">GESCHMACK</p>'));
  assert.ok(taste.includes('<span className="matcha-taste-line">Wie GLOA schmeckt.</span>'));
  for (const line of [
    "GLOA Matcha hat eine leuchtend grüne Farbe, eine feine Textur und einen ausgewogenen Geschmack. Eine natürliche Süße und angenehmes Umami treffen auf eine dezente, frische Herbe.",
    "Dadurch funktioniert er sowohl pur als auch in einem Matcha Latte.",
  ]) {
    assert.ok(taste.includes(line), `the taste copy is missing: ${line}`);
  }
  const notes = [...list("matchaTaste").matchAll(/\["([A-ZÄÖÜ]+)","([^"]+)"\]/g)];
  assert.deepEqual(notes.map(n => n[1]), ["AUSGEWOGEN", "UMAMI", "AROMA", "FINISH"]);
  // The notes restate the paragraph above them; they do not add a new
  // sensory claim, and they never stray into effect.
  for (const [, label, text] of notes) {
    for (const claim of ["gesund", "wirkt", "Energie", "Fokus", "beruhigt", "Wachheit"]) {
      assert.ok(!text.includes(claim), `${label} makes an effect claim: ${claim}`);
    }
  }
  for (const dash of ["–", "—"]) {
    assert.ok(!taste.includes(dash), `a dash was introduced: ${dash}`);
  }
});

/* ══════════════════════════════════════════════════════════════
   6. THE LOOK: TWO FAMILIES, THE PAGE'S OWN COLOURS, NO CARDS
   ══════════════════════════════════════════════════════════════ */

test("6: the band alternates the page's two grounds and invents nothing", () => {
  // GLOA BLUE then berry. The band changed ground in this pass; blue is
  // the token the homepage daily band and the about hero already stand
  // on, so no colour was mixed for it.
  assert.match(rule(".matcha-explain{"), /background:var\(--blue\)/);
  assert.match(rule(".matcha-explain{"), /color:var\(--cream\)/);
  assert.ok(!rules.includes("#"), "a raw hex colour entered the band");
  assert.match(rule(".matcha-taste{"), /background:var\(--berry\)/);
  assert.match(rule(".matcha-taste{"), /color:var\(--cream\)/);
  // No third ground, no gradient, no glass.
  for (const banned of ["var(--plum)", "var(--matcha)", "gradient", "backdrop-filter", "box-shadow"]) {
    assert.ok(!rules.includes(banned), `the band uses ${banned}`);
  }
  for (const [, value] of rules.matchAll(/border-radius:([^;}]+)/g)) {
    assert.match(value.trim(), /^0[a-z%]*$/, `the blocks became cards: border-radius:${value}`);
  }
  // Two families only, and the accent line is the display italic.
  for (const m of rules.matchAll(/font-family:([^;}]+)/g)) {
    assert.match(m[1], /^var\(--font-(sans|display)\)/, `a third family: ${m[1]}`);
  }
  assert.match(rule(".matcha-explain-line-accent{"), /font-family:var\(--font-display\)/);
  // The eyebrows read the page-wide meta token rather than a local size.
  for (const eyebrow of [".matcha-explain-eyebrow{", ".matcha-facts-eyebrow{", ".matcha-taste-eyebrow{"]) {
    assert.match(rule(eyebrow), /font-size:var\(--type-meta\)/, `${eyebrow} sets its own size`);
  }
  // Hairlines separate the rows; no bordered boxes.
  assert.match(rule(".matcha-fact{"), /border-top:1px solid/);

  // ── EVERY COLOUR ON THE NEW GROUND, BY ARITHMETIC ──────────
  // Raspberry, which several of these carried while the band was cream,
  // measures 1.04:1 on GLOA blue - the eyebrow, the step numbers and
  // the fact labels would simply not be on the screen. So each one is
  // checked against the ground it actually sits on.
  const BLUE = [23, 70, 209], CREAM = [245, 235, 226], BERRY = [166, 30, 89];
  const lum = ([r, g, b]) => {
    const f = c => (c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (fg, bg) => {
    const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a);
    return (hi + 0.05) / (lo + 0.05);
  };
  const over = (fg, alpha, bg) => fg.map((c, i) => Math.round(c * alpha + bg[i] * (1 - alpha)));
  const colourOf = selector => {
    const body = rule(selector).replace(/\/\*[\s\S]*?\*\//g, "");
    const hit = body.split(/[;{]/).map(d => d.trim()).find(d => d.startsWith("color:"));
    assert.ok(hit, `${selector} declares no colour`);
    const value = hit.slice(6).trim();
    if (value === "var(--cream)") return [CREAM, 1];
    if (value === "var(--berry)") return [BERRY, 1];
    const rgba = value.match(/^rgba\((\d+),(\d+),(\d+),([\d.]+)\)$/);
    assert.ok(rgba, `unparseable colour on ${selector}: ${value}`);
    return [[+rgba[1], +rgba[2], +rgba[3]], +rgba[4]];
  };
  const onBlue = [
    ".matcha-explain-eyebrow{", ".matcha-explain-line{", ".matcha-explain-line-accent{",
    ".matcha-explain-body{", ".matcha-process-title{", ".matcha-process-note{",
    ".matcha-process-hint{", ".matcha-process-num{", ".matcha-process-label{",
    ".matcha-process-text{", ".matcha-facts-eyebrow{", ".matcha-fact-label{",
    ".matcha-fact-value{", ".matcha-fact-text{",
  ];
  for (const selector of onBlue) {
    const [rgb, alpha] = colourOf(selector);
    const measured = ratio(over(rgb, alpha, BLUE), BLUE);
    assert.ok(measured >= 4.5,
      `${selector} measures ${measured.toFixed(2)}:1 on GLOA blue - needs 4.5:1`);
  }
  // The accordion "+" is a 22px glyph, so 3:1 is its bar.
  const mark = (() => {
    const at = rules.indexOf(".matcha-process-mark{");
    assert.notEqual(at, -1, "the accordion mark has no rule");
    return rules.slice(at, rules.indexOf("}", at));
  })();
  assert.match(mark, /color:var\(--cream\)/);
  assert.ok(ratio(CREAM, BLUE) >= 3);
  // And the hairlines are light on it, not the ink ones they were.
  for (const hairline of [".matcha-process-list{", ".matcha-process-step{", ".matcha-facts{", ".matcha-fact{"]) {
    assert.match(rule(hairline), /border-(top|bottom):1px solid rgba\(245,235,226,/,
      `${hairline} keeps an ink hairline on a blue ground`);
  }
});

/* ══════════════════════════════════════════════════════════════
   7. THE LEGACY BLOCKS: HIDDEN, NOT DELETED
   ══════════════════════════════════════════════════════════════ */

test("7: the plum origin block is hidden, and every line of it survives", () => {
  // ── NOT RENDERED ─────────────────────────────────────────────
  // One named flag decides, in the same shape SHOP_STATUS and
  // SHOP_HIDDEN_SLUGS already use elsewhere in this file.
  assert.match(site, /const SHOW_LEGACY_ORIGIN_SECTION:boolean=false;/);
  assert.match(page, /\{SHOW_LEGACY_ORIGIN_SECTION&&<section className="matcha-shizuoka">/);
  assert.match(site, /const SHOW_LEGACY_PREPARATION_SECTION:boolean=false;/);
  assert.match(page, /\{SHOW_LEGACY_PREPARATION_SECTION&&<section className="matcha-howto">/);

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

  // ── NOTHING WAS SLOTTED INTO THE SPACE ───────────────────────
  assert.ok(!page.includes("matcha-origin-spacer") && !page.includes('className="spacer"'),
    "a spacer was left behind");
  const after = page.slice(page.indexOf('<section className="matcha-shizuoka">'));
  assert.match(after.slice(after.indexOf("</section>")), /^<\/section>\}\s*\{\/\*[\s\S]*?\*\/\}\s*<section className="matcha-taste">/,
    "something was inserted where the section used to be");
});

/* ══════════════════════════════════════════════════════════════
   8. THE SIZES CANNOT DRIFT AWAY FROM THE CATALOG
   ══════════════════════════════════════════════════════════════ */

test("8: the sizes on this page cannot drift away from the catalog", () => {
  // /our-matcha is editorial: it does not fetch the catalog, so its size
  // row is a LITERAL, while the shop card and the product page both build
  // theirs from product.variants. That is fine - but only for as long as
  // the literal is checked against the same sizes everyone else uses.
  // Pinning the string on its own would keep passing while a fourth
  // size, or a changed one, left this page quietly stating the old set.
  //
  // Three sources are locked together here, none of them this page:
  //   1. lib/annualPlans.ts   - ANNUAL_LAUNCH_GRAMS_BY_SKU, the map the
  //                             annual plan is priced and shipped from
  //   2. migration 008        - the seed the catalog rows were created by
  //   3. this section         - the literal a customer reads
  // Read as source text rather than imported, so this test stays a leaf.
  const plans = read("lib/annualPlans.ts");
  const map = plans.slice(plans.indexOf("ANNUAL_LAUNCH_GRAMS_BY_SKU"),
                          plans.indexOf("}", plans.indexOf("ANNUAL_LAUNCH_GRAMS_BY_SKU")));
  const grams = [...map.matchAll(/"GLOA-MATCHA-\d+G":\s*(\d+)/g)].map(m => Number(m[1]));
  assert.ok(grams.length >= 3, "the launch sizes moved out of ANNUAL_LAUNCH_GRAMS_BY_SKU");
  grams.sort((a, b) => a - b);

  // 2. The catalog seed declares the same set, with matching labels.
  const seed = read("supabase/migrations/008_b2c_launch_products.sql");
  const seeded = [...seed.matchAll(/'GLOA-MATCHA-(\d+)G',\s*'(\d+) g',\s*(\d+),/g)]
    .map(m => [Number(m[1]), m[2] + " g", Number(m[3])]);
  assert.deepEqual(seeded.map(s => s[0]).sort((a, b) => a - b), grams,
    "the seeded SKUs and the annual size map disagree");
  for (const [sku, label, size] of seeded) {
    assert.equal(size, sku, `GLOA-MATCHA-${sku}G is seeded with size_grams ${size}`);
    assert.equal(label, `${sku} g`, `GLOA-MATCHA-${sku}G is labelled "${label}"`);
  }

  // 3. And the sentence on this page is exactly that set, in order.
  const expected = grams.map(g => `${g} g`).join(" · ");
  assert.ok(list("matchaFacts").includes(`["GRÖSSEN","${expected}"`),
    `the page states sizes the catalog does not have - expected "${expected}"`);
});

/* ══════════════════════════════════════════════════════════════
   9. NOTHING CAN PUSH THE PAGE SIDEWAYS - BRIEF 17
   ══════════════════════════════════════════════════════════════ */

test("9: every new grid track can shrink, and nothing reserves a viewport", () => {
  // A grid column defaults to min-content, which is what makes a long
  // word or a wide image widen the whole page on a phone. Every track
  // the restructure added is declared minmax(0,...) or a fixed unit, and
  // every column that holds text carries min-width:0.
  for (const [, tracks] of rules.matchAll(/grid-template-columns:([^;}]+)/g)) {
    for (const track of tracks.split(/\s+(?![^(]*\))/)) {
      assert.match(track.trim(), /^(minmax\(|repeat\(|clamp\(|\d+px$|1fr$|auto$|max-content$)/,
        `a track cannot shrink: ${track} in "${tracks}"`);
    }
  }
  assert.match(rule(".matcha-explain-copy{"), /min-width:0/);
  // The photo is gone entirely, so nothing in this band reserves a
  // height for an image that will never load.
  assert.ok(!rules.includes("matcha-explain-photo"));
  assert.ok(!rules.includes("object-fit"), "an image box survived the removal");
  // No viewport heights, no fixed widths, no negative margins that could
  // reach past the rail.
  for (const banned of ["100vh", "100vw", "position:absolute", "margin-left:-", "margin-inline:-"]) {
    assert.ok(!rules.includes(banned), `the band uses ${banned}`);
  }
  // And it stacks before the columns can crush each other.
  assert.match(rules, /@media \(max-width:1100px\)\{[\s\S]*?\.matcha-explain-top\{grid-template-columns:/);
  assert.match(rules, /@media \(max-width:640px\)/);
});

/* ══════════════════════════════════════════════════════════════
   10. THE CHROME IS NOT PART OF THIS PASS - BRIEF 16
   ══════════════════════════════════════════════════════════════ */

test("10: the restructure did not reach the header or the footer", () => {
  // /our-matcha renders inside the shared shell. This pass touched the
  // page's own <main> and nothing around it.
  const chrome = read("app/Chrome.tsx");
  assert.match(chrome, /href="\/our-matcha"/, "the nav entry is missing");
  assert.ok(!chrome.includes("matcha-explain") && !chrome.includes("matcha-process")
    && !chrome.includes("mr-sheet"), "the restructure leaked into the site chrome");
  // The page is still one <main> with the page class on it.
  assert.match(page, /return <main className="matcha-page">/);
  assert.equal([...page.matchAll(/<main/g)].length, 1);
  // And the sheet is the page's own overlay, not a shell-level one.
  assert.ok(!chrome.includes("MatchaResearchSheet"));
});

/* ══════════════════════════════════════════════════════════════
   11. THE FOUR STEPS, IN TWO SHAPES
   Brief 14.4 and 14.5: desktop prints all four, mobile collapses them
   into an accordion. The interesting part is that the aria state and
   the styling describe the SAME shape at every width.
   ══════════════════════════════════════════════════════════════ */

test("11a: desktop prints every step, with no accordion machinery", () => {
  // The plain branch renders the label as a heading, not as a control.
  assert.match(process, /<span className="matcha-process-num">\{n\}<\/span><h4 className="matcha-process-label">\{title\}<\/h4>/);
  // All four texts are in the markup unconditionally - the panel is
  // never conditionally rendered, only conditionally `hidden`.
  assert.match(process, /<div id=\{panelId\} className="matcha-process-panel" hidden=\{accordion&&!isOpen\}>/);
  assert.match(process, /<p className="matcha-process-text">\{text\}<\/p>/);
  // The toggle is display:none outside the accordion query, so a wide
  // viewport cannot show a button the component did not render either.
  assert.match(rules, /\.matcha-process-toggle\{[\s\S]*?display:none/);
});

test("11b: the accordion is a real one - button, state, and a single open step", () => {
  assert.match(process, /<button type="button" className="matcha-process-toggle"/);
  assert.match(process, /aria-expanded=\{isOpen\}/);
  assert.match(process, /aria-controls=\{panelId\}/);
  assert.match(process, /const panelId=`matcha-process-panel-\$\{n\}`/);
  // ONE AT A TIME: the setter replaces the open index rather than
  // adding to a set, and clicking the open one closes it.
  assert.match(process, /setOpen\(prev=>prev===i\?null:i\)/);
  assert.match(process, /useState<number\|null>\(null\)/);
  // The "+" carries no meaning a reader needs - aria-expanded does.
  assert.match(process, /className="matcha-process-mark" aria-hidden="true"/);
  // The hint exists, and only while the accordion does.
  assert.match(process, /\{accordion&&<p className="matcha-process-hint">Zum Lesen antippen<\/p>\}/);
  // A real <button> is keyboard-operable without a keydown handler, so
  // there must not be one faking it.
  assert.ok(!process.includes("onKeyDown"), "a hand-rolled key handler was added to a native button");
  assert.ok(!process.includes("role=\"button\""), "a div was dressed up as a button");
  // Touch target.
  assert.match(rules, /\.matcha-process-toggle\{[\s\S]*?min-height:52px/);
});

test("11c: the two shapes cannot disagree about which one is on screen", () => {
  // The component and the stylesheet read the SAME breakpoint. If they
  // drifted, a button would claim aria-expanded="false" over a panel a
  // desktop media query had made visible - the exact failure this
  // pairing exists to prevent.
  const query = /const MATCHA_PROCESS_ACCORDION_QUERY="\(max-width:(\d+)px\)"/.exec(site);
  assert.ok(query, "the breakpoint constant is missing");
  assert.ok(rules.includes(`@media (max-width:${query[1]}px)`),
    `the stylesheet does not switch at ${query[1]}px`);
  // It is also the width the research cards switch at, so the page has
  // one tap-to-read breakpoint rather than two.
  assert.match(css, new RegExp(`\\.matcha-research-open\\{[\\s\\S]*?@media \\(max-width:${query[1]}px\\)`));
  // SSR AND THE FIRST CLIENT RENDER ARE THE PLAIN LIST, so hydration
  // cannot mismatch and the full text is what ships in the HTML.
  assert.match(process, /const \[accordion,setAccordion\]=useState\(false\)/);
  assert.match(process, /window\.matchMedia\(MATCHA_PROCESS_ACCORDION_QUERY\)/);
  assert.match(process, /mq\.addEventListener\("change",sync\)/);
  assert.match(process, /removeEventListener\("change",sync\)/);
  // Leaving the accordion closes whatever was open, so a step cannot
  // stay half-open in a layout that has no toggles.
  assert.match(process, /if\(!mq\.matches\)setOpen\(null\)/);
  // The switch runs before paint, so mobile never flashes the open text.
  assert.match(site, /typeof window!=="undefined"\?useLayoutEffect:useEffect/);
});

/* ══════════════════════════════════════════════════════════════
   12. THE MOBILE RHYTHM
   Brief 14.13: no fixed or minimum height may reserve empty ground on
   a phone, and the band padding actually came down.
   ══════════════════════════════════════════════════════════════ */

test("12: nothing on this page reserves height it does not fill", () => {
  const mobile = css.slice(css.indexOf("/our-matcha MOBILE RHYTHM"), css.indexOf("/about — THREE BANDS"));
  assert.ok(mobile.length > 0, "the mobile rhythm block is missing");

  // THE SEVEN BANDS ALL COME DOWN, and they are all named here so a new
  // band cannot quietly keep the old desktop padding on a phone.
  for (const band of [".matcha-hero{", ".matcha-explain{", ".matcha-taste{", ".matcha-research{",
                      ".matcha-use{", ".matcha-page .faq{", ".matcha-cta{"]) {
    const at = mobile.indexOf(band);
    assert.notEqual(at, -1, `no mobile padding for ${band}`);
    const value = /clamp\((\d+)px,/.exec(mobile.slice(at, mobile.indexOf("}", at)));
    assert.ok(value, `${band} does not clamp its mobile padding`);
    assert.ok(Number(value[1]) <= 46,
      `${band} still reserves ${value[1]}px per side on a phone`);
  }

  // NO RESERVED HEIGHT ANYWHERE ON THE PAGE, at any width. The only two
  // minimums left are touch targets, and they are named rather than
  // pattern-matched so a third one has to be argued for.
  const pageCss = [
    css.slice(css.indexOf("/our-matcha PAGE HERO"), css.indexOf("/our-matcha — WHAT IT IS")),
    rules,
    css.slice(css.indexOf("/our-matcha RESEARCH SECTION"), css.indexOf("/about — THREE BANDS")),
  ].join("\n");
  for (const banned of ["100vh", "min-height:100", "height:70vh", "height:55vh"]) {
    assert.ok(!pageCss.includes(banned), `the page reserves a viewport: ${banned}`);
  }
  const minimums = [...pageCss.matchAll(/min-height:([^;}]+)/g)].map(m => m[1].trim());
  assert.deepEqual(minimums.sort(), ["48px", "52px", "54px"],
    "a new reserved height appeared - touch targets are 48px, 52px and 54px");
});
