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

  // The band's four areas, in order.
  for (const part of ["matcha-explain-top", "matcha-explain-copy", "matcha-process",
                      "matcha-explain-photo", "matcha-facts"]) {
    assert.ok(section.includes(part), `missing area: ${part}`);
  }
  assert.ok(section.indexOf("matcha-explain-copy") < section.indexOf("matcha-process"));
  assert.ok(section.indexOf("matcha-process") < section.indexOf("matcha-explain-photo"));
  assert.ok(section.indexOf("matcha-explain-top") < section.indexOf("matcha-facts"));

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
  // The photo is the powder, not the workplace shot that used to sit here.
  // The intrinsic size is on the tag, not only in CSS. height:auto over
  // an image that has not loaded computes to 0px, and a zero-height
  // lazy image never intersects the viewport - so it never loads at
  // all. The attributes also mean the row does not jump when it does.
  assert.match(section, /<img src="\/img\/Produkt Bild \(2\)\.png" alt="Fein vermahlenes grünes Matcha-Pulver" width="964" height="908" loading="lazy"\/>/);
  assert.ok(!section.includes("gloa-work.jpg"), "the laptop photo survived");
});

/* ══════════════════════════════════════════════════════════════
   3. HOW MATCHA IS MADE - BRIEF 4 AND 5
   ══════════════════════════════════════════════════════════════ */

test("3: four steps, in full sentences, describing MATCHA and not our supplier", () => {
  assert.ok(section.includes('<h3 className="matcha-process-title">Wie Matcha entsteht</h3>'));
  // It says out loud that this is general production. That sentence is
  // what keeps the four steps from reading as a supply-chain claim.
  assert.ok(section.includes('<p className="matcha-process-note">So wird Matcha allgemein hergestellt.</p>'));

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
  // Cream then berry - the alternation /our-matcha already runs.
  assert.match(rule(".matcha-explain{"), /background:var\(--cream\)/);
  assert.match(rule(".matcha-explain{"), /color:var\(--ink\)/);
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
      assert.match(track.trim(), /^(minmax\(|repeat\(|clamp\(|1fr$|auto$|max-content$)/,
        `a track cannot shrink: ${track} in "${tracks}"`);
    }
  }
  assert.match(rule(".matcha-explain-copy{"), /min-width:0/);
  // The photo is capped to its column rather than to a viewport width.
  assert.match(rules, /\.matcha-explain-photo img\{[\s\S]*?width:100%/);
  // It fills the row on desktop and returns to its own height once the
  // columns stack, so neither layout leaves a column of empty ground.
  assert.match(rules, /\.matcha-explain-photo\{[^}]*align-self:stretch/);
  assert.match(rules, /@media \(max-width:1100px\)\{[\s\S]*?\.matcha-explain-photo\{[^}]*align-self:auto/);
  assert.match(rules, /\.matcha-explain-photo img\{[\s\S]*?object-fit:cover/);
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
