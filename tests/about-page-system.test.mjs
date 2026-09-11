import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startRenderServer } from "./helpers/renderServer.mjs";

/**
 * /about — THE BRAND PAGE, IN THREE BANDS.
 *
 * It was seven sections and read as a second product page: a hero that
 * explained how to drink matcha, a WHY band, a NOT COMPLICATED band
 * saying much the same thing, a standalone HERKUNFT strip, a values list
 * about the product, a BUILDING GLOA band telling visitors the company
 * was still under construction, and a closing CTA band.
 *
 * Now: who GLOA is, where the name comes from and what it stands for,
 * and the story. The product lives on /our-matcha and is not
 * re-explained here.
 *
 * What these tests hold hardest:
 *   * exactly three bands before the footer, and no fourth creeping back
 *   * every removed section stays removed, in markup AND in the sheet
 *   * no dash in any visible sentence
 *   * the page still reads the shared type, rail and colour system
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf8");

const site = read("app/GloaSite.tsx");
const css = read("app/globals.css");

const about = site.slice(site.indexOf("function About(){return <main"), site.indexOf("\nfunction ForCafes()"));
assert.ok(about.length > 1500, "the About component was not found");

/** The About block, bounded at the next banner. */
const blockAt = css.indexOf("/about — THREE BANDS");
assert.notEqual(blockAt, -1, "the About CSS block was not found");
const rules = css.slice(css.lastIndexOf("/*", blockAt), css.indexOf("/* " + "═".repeat(6), blockAt));
const code = rules.replace(/\/\*[\s\S]*?\*\//g, "");
assert.ok(code.length > 2000, "the About CSS block is suspiciously short");

const rule = name => {
  const at = code.indexOf(name);
  assert.notEqual(at, -1, `missing rule: ${name}`);
  return code.slice(at, code.indexOf("}", at));
};
const desktop = code.slice(0, code.indexOf("@media"));

// 8939 belongs to account-portal-design; every render suite needs its
// own port or the two servers fight over the socket in a full run.
const PORT = 8950;
let server, html;
test.before(async () => {
  server = await startRenderServer(PORT);
  const res = await server.getHtml("/about");
  assert.equal(res.status, 200, "/about did not resolve");
  html = res.html;
});
test.after(() => server?.stop());

/** THE PAGE'S OWN MARKUP, WITHOUT THE SHELL. The brand-bar ticker says
    "MATCHA IS FOR EVERYONE." and the footer carries Berlin, TikTok and a
    /our-matcha link - all of them global chrome this page does not own.
    Reading the whole document would make every copy assertion below a
    test of Chrome.tsx instead. */
const mainHtml = () => html.slice(html.indexOf("<main"), html.indexOf("</main>") + 7);
/** JSX writes &#x27; for an apostrophe, so rendered text is compared decoded. */
const text = () => mainHtml().replace(/&#x27;/g, "'").replace(/&amp;/g, "&");

/* ══════════════════════════════════════════════════════════════
   1. THREE BANDS, THEN THE FOOTER
   ══════════════════════════════════════════════════════════════ */

test("1: exactly three content bands, in the blue / cream / blue rhythm", () => {
  const sections = [...mainHtml().matchAll(/<section class="(about-[a-z]+)"/g)].map(m => m[1]);
  assert.deepEqual(sections, ["about-hero", "about-name", "about-story"]);
  const bands = [[".about-hero{", "var(--blue)", "var(--cream)"],
                 [".about-name{", "var(--cream)", "var(--ink)"],
                 [".about-story{", "var(--blue)", "var(--cream)"]];
  for (const [sel, bg, fg] of bands) {
    const r = rule(sel);
    assert.ok(r.includes(`background:${bg}`), `${sel} is not on ${bg}`);
    assert.ok(r.includes(`color:${fg}`), `${sel} does not write in ${fg}`);
  }
  // No band paints itself anything outside the palette.
  for (const m of code.matchAll(/background:([^;}]+)/g)) {
    assert.ok(/^(var\(--(blue|berry|cream|ink)\)|transparent|none)$/.test(m[1].trim()),
      `a background outside the palette: ${m[1]}`);
  }
});

test("1b: nothing stands between the last band and the global footer", () => {
  const storyAt = html.indexOf('<section class="about-story"');
  const after = html.slice(storyAt + '<section class="about-story"'.length);
  const closeAt = after.indexOf("</main>");
  assert.notEqual(closeAt, -1, "the page main never closes");
  assert.equal((after.slice(0, closeAt).match(/<section/g) || []).length, 0,
    "a section still follows the story band");
  assert.ok(after.indexOf("<footer") > closeAt, "the footer does not follow the story");
  // The shared header and footer, unchanged and not rebuilt for this page.
  assert.ok(html.includes("<header"), "the shared header is missing");
  assert.ok(html.includes("<footer"), "the shared footer is missing");
  assert.ok(!about.includes("<header") && !about.includes("<footer"),
    "/about built a header or footer of its own");
});

test("1c: one h1, then h2s - and no heading level was skipped", () => {
  assert.equal((mainHtml().match(/<h1/g) || []).length, 1, "the page does not have exactly one h1");
  // Two band headings, the values intro, and the four value titles.
  assert.equal((mainHtml().match(/<h2/g) || []).length, 2, "the band headings changed");
  assert.equal((mainHtml().match(/<h3/g) || []).length, 1, "the values intro changed");
  assert.equal((mainHtml().match(/<h4/g) || []).length, 4, "the value titles changed");
});

/* ══════════════════════════════════════════════════════════════
   2. THE COPY
   ══════════════════════════════════════════════════════════════ */

test("2: the brand statement, the name and the story all render", () => {
  for (const copy of ["ÜBER GLOA", "Good energy.", "No theatre.",
                      "GLOA steht für gute Energie, klare Gestaltung und eine Haltung, die unkompliziert bleibt. Modern, offen und nahbar.",
                      "DER NAME GLOA", "Glow trifft Aura.",
                      "WAS UNS WICHTIG IST", "Klarheit, Qualität", "und ein gutes Gefühl.",
                      "UNSERE GESCHICHTE", "Unsere Geschichte", "wird noch geschrieben."]) {
    assert.ok(text().includes(copy), `missing page copy: ${copy}`);
  }
  // "No theatre." and "wird noch geschrieben." are the two display italics.
  assert.match(about, /<i className="about-hero-line about-hero-line-accent gloa-hero-secondary">No theatre\.<\/i>/);
  assert.match(about, /<i className="about-story-line about-story-line-accent">wird noch geschrieben\.<\/i>/);
});

test("2b: the name is explained as a combination of Glow and Aura", () => {
  assert.ok(text().includes("GLOA ist eine Wortkombination aus Glow und Aura."),
    "the page never says what the name is made of");
  assert.ok(text().includes("Glow steht für Ausstrahlung. Aura steht für die Atmosphäre, die wir mitbringen und hinterlassen."));
  assert.ok(text().includes("Zusammen beschreibt der Name das Gefühl, das wir mit GLOA schaffen möchten. Positiv, klar und nahbar."));
  // And it is SET as well as said: three words, two hairlines, no arrow,
  // no plus sign, no drawn device.
  assert.match(mainHtml(), /<span class="about-name-whole">GLOA<\/span>/);
  assert.deepEqual([...mainHtml().matchAll(/<span class="about-name-part">([^<]+)<\/span>/g)].map(m => m[1]),
    ["GLOW", "AURA"]);
  assert.match(code, /\.about-name-mark\{[\s\S]*?border-top:1px solid var\(--berry\)/);
  assert.match(code, /\.about-name-parts\{[\s\S]*?border-top:1px solid rgba\(17,17,17/);
  assert.ok(!/<svg|→|↗|\+<\/|"\+"/.test(about), "the name device grew an arrow or a plus");
});

test("2c: the four values are the brand's, not the product's", () => {
  const titles = [...mainHtml().matchAll(/<h4 class="about-value-title">([^<]+)<\/h4>/g)].map(m => m[1]);
  assert.deepEqual(titles, ["KLARHEIT", "QUALITÄT", "GESTALTUNG", "NÄHE"]);
  assert.deepEqual([...mainHtml().matchAll(/<span class="about-value-num">(\d+)<\/span>/g)].map(m => m[1]),
    ["01", "02", "03", "04"]);
  for (const copy of ["Wir sagen, was wir meinen und machen Dinge nicht komplizierter als nötig.",
                      "Wir haben hohe Ansprüche an das, was unseren Namen trägt.",
                      "Gutes Design soll nicht nur gut aussehen. Es soll sich selbstverständlich anfühlen.",
                      "GLOA soll Menschen einladen und nicht ausschließen."]) {
    assert.ok(text().includes(copy), `missing value copy: ${copy}`);
  }
  // The retired product-flavoured values are gone.
  for (const gone of ["Gutes Produkt statt komplizierter Begriffe.",
                      "Klare Infos statt erfundenem Prestige.",
                      "Matcha, der pur genauso funktioniert wie als Latte."]) {
    assert.ok(!text().includes(gone), `a retired value survived: ${gone}`);
  }
});

test("2d: the story reads as a future, not as a building site", () => {
  for (const copy of ["GLOA wurde 2026 in Berlin gegründet.",
                      "Was uns von Anfang an wichtig war, bleibt auch für alles, was noch kommt, gleich. Klarheit, Qualität, gute Gestaltung und eine Marke, die nahbar bleibt.",
                      "Unsere Geschichte wächst mit jedem neuen Kapitel weiter."]) {
    assert.ok(text().includes(copy), `missing story copy: ${copy}`);
  }
  for (const banned of [/wir bauen/i, /entsteht/i, /schau vorbei/i, /in vorbereitung/i,
                        /baustelle/i, /demnächst/i, /coming soon/i, /behind the scenes/i,
                        /tiktok/i, /building in public/i]) {
    assert.ok(!banned.test(text()), `the story sounds unfinished: ${banned}`);
  }
  // Exactly two actions, and they sit inside the story band.
  const story = mainHtml().slice(mainHtml().indexOf('<section class="about-story"'));
  const ctas = [...story.matchAll(/<a href="([^"]+)" class="cta about-story-cta[^"]*">([^<]+)</g)].map(m => [m[2], m[1]]);
  assert.deepEqual(ctas, [["UNSER MATCHA", "/our-matcha"], ["ZUM SHOP", "/shop"]]);
  // And they are the only links in the band.
  assert.equal((story.match(/<a /g) || []).length, 2, "the story band grew another link");
});

test("2e: NO DASH in any visible sentence", () => {
  // The brief rules out em and en dashes in rendered copy. Read from the
  // rendered prose rather than the source, so a dash cannot hide in an
  // attribute or a comment and still reach the screen.
  const prose = [...mainHtml().matchAll(/<(?:p|h1|h2|h3|h4|span|i)[^>]*>([^<]+)</g)].map(m => m[1]);
  assert.ok(prose.length >= 20, `only ${prose.length} text nodes found`);
  for (const t of prose) {
    for (const dash of ["—", "–", " - "]) {
      assert.ok(!t.includes(dash), `a dash reached the screen: ${t}`);
    }
  }
});

/* ══════════════════════════════════════════════════════════════
   3. WHAT WAS REMOVED STAYS REMOVED
   ══════════════════════════════════════════════════════════════ */

test("3: the four retired bands are gone, from markup and from the sheet", () => {
  for (const gone of ["WHY GLOA EXISTS", "Matcha gehört", "Schublade.",
                      "MATCHA IS FOR EVERYONE", "Nicht", "kompliziert.", "Einfach gut.",
                      "HERKUNFT", "Unser Matcha kommt aus Shizuoka",
                      "BUILDING GLOA", "Schau vorbei,", "während es entsteht.",
                      "Genug über uns.", "Zeit für Matcha.",
                      "@gloa.matcha", "BUILDING IN PUBLIC"]) {
    assert.ok(!text().includes(gone), `a retired band is still on the page: ${gone}`);
  }
  // Their markup and their rules left together - nothing kept "in case".
  for (const cls of ["about-why", "about-real", "about-origin", "about-cares",
                     "about-tiktok", "about-final", "about-handle", "about-micro"]) {
    assert.ok(!about.includes(cls), `${cls} survives in the component`);
    assert.ok(!code.includes(`.${cls}`), `${cls} still has rules in the About block`);
  }
  assert.ok(!site.includes("aboutCares"), "the old values data is still in the source");
});

test("3b: the hero no longer repeats facts other pages already carry", () => {
  const hero = mainHtml().slice(mainHtml().indexOf('<section class="about-hero"'), mainHtml().indexOf('<section class="about-name"'));
  for (const gone of ["SHIZUOKA / JAPAN", "BERLIN / GERMANY", "EST. 2026",
                      "GLOA bringt Matcha aus Shizuoka", "Für Latte, iced, pur",
                      "about-hero-meta", "about-hero-sub"]) {
    assert.ok(!hero.includes(gone), `the hero still carries: ${gone}`);
  }
  // The hero is one vertical column - no second copy column beside the
  // headline, which is what made the phone read two conversations.
  assert.match(rule(".about-hero-inner{"), /flex-direction:column/);
  assert.ok(!/grid-template-columns/.test(rule(".about-hero-inner{")), "the hero is a two-column grid again");
});

test("3c: each message is made ONCE on the whole page", () => {
  const t = text();
  for (const [phrase, times] of [["Glow", 3], ["Aura", 3], ["Berlin", 1], ["2026", 1]]) {
    const n = t.split(phrase).length - 1;
    assert.ok(n <= times, `"${phrase}" appears ${n} times, expected at most ${times}`);
  }
  // The page does not re-explain the product.
  for (const banned of [/iced/i, /\bpur\b/i, /latte/i, /grünteepulver/i, /zubereit/i]) {
    assert.ok(!banned.test(t), `/about explains the product again: ${banned}`);
  }
  // Shizuoka belongs to /our-matcha, and is not repeated here.
  assert.ok(!t.includes("Shizuoka"), "/about repeats the origin story");
});

/* ══════════════════════════════════════════════════════════════
   4. THE SHARED SYSTEM, STILL SHARED
   ══════════════════════════════════════════════════════════════ */

test("4: the hero reads the canonical page-hero scale, and sets none of its own", () => {
  assert.ok(about.includes('<p className="eyebrow about-eyebrow about-hero-eyebrow gloa-hero-eyebrow">'));
  assert.ok(about.includes('<span className="about-hero-line gloa-hero-primary">Good energy.</span>'));
  assert.ok(about.includes('<i className="about-hero-line about-hero-line-accent gloa-hero-secondary">No theatre.</i>'));
  for (const sel of [".about-hero-line{", ".about-hero-line-accent{"]) {
    assert.ok(!/font-family|font-size|font-weight|font-style|line-height|letter-spacing/.test(rule(sel)),
      `${sel} sets hero typography of its own`);
  }
  // And the shared scale is still the homepage's.
  assert.match(css, /--type-hero-primary:clamp\(54px,5\.9vw,100px\)/);
  assert.match(css, /--type-hero-secondary:clamp\(48px,5vw,86px\)/);
});

test("4b: section headings are the established GLOA section scale", () => {
  assert.match(desktop, /\.about-name-line,\s*\.about-story-line\{[\s\S]*?font-size:clamp\(42px,4\.2vw,60px\)/);
  assert.match(rule(".about-story-line-accent{"), /font-size:clamp\(44px,4\.6vw,64px\)/);
  assert.match(rule(".about-story-line-accent{"), /font-family:var\(--font-display\),Georgia,serif/);
  assert.match(rule(".about-story-line-accent{"), /font-style:italic/);
  // Exactly what /partnerships already sets, so no second scale exists.
  assert.match(css, /font-size:clamp\(42px,4\.2vw,60px\)/);
  // The values intro is a STEP BELOW the band scale - it opens a block,
  // not a band.
  const values = /clamp\(([\d.]+)px,[\d.]+vw,([\d.]+)px\)/.exec(rule(".about-values-line{"));
  assert.ok(Number(values[2]) < 60, `the values intro (${values[2]}px) reaches the section scale`);
  // Two families, and only two.
  for (const m of code.matchAll(/font-family:([^;}]+)/g)) {
    assert.match(m[1], /^var\(--font-(sans|display)\)/, `a third family: ${m[1]}`);
  }
  // One eyebrow rule, at the site's meta scale.
  const eyebrow = rule(".about-page .about-eyebrow{");
  assert.match(eyebrow, /font-size:var\(--type-meta\)/);
  assert.match(eyebrow, /letter-spacing:\.2em/);
  assert.match(eyebrow, /text-transform:uppercase/);
  assert.match(eyebrow, /font-weight:600/);
  assert.equal((mainHtml().match(/class="eyebrow about-eyebrow/g) || []).length, 4,
    "the eyebrows are not all on the one role");
});

test("4c: every band sits on the canonical rail, and reserves no height", () => {
  for (const inner of ["about-hero-inner", "about-name-inner", "about-story-inner"]) {
    assert.ok(about.includes(`className="${inner} home-rail"`), `${inner} is off the rail`);
  }
  for (const band of [".about-hero{", ".about-name{", ".about-story{"]) {
    assert.match(rule(band), /padding-inline:var\(--rail-gutter\)/, `${band} is off the shared gutter`);
  }
  // NO RESERVED SPACE. The old hero carried a min-height grid floor to
  // fill a blue field its own copy could not.
  // The ONE min-height left is the 50px tap target on the two buttons,
  // which is an accessibility floor rather than a band filling itself.
  const heights = [...code.matchAll(/([^{}]+)\{[^}]*min-height/g)]
    .map(m => m[1].split(/[\r\n]/).pop().trim());
  assert.deepEqual(heights, [".about-page .about-story-cta"], "a band reserves height again");
  assert.ok(!/100vh|\d+vh/.test(code), "a band reserves a viewport");
});

test("4d: editorial, not a card deck", () => {
  assert.ok(!/box-shadow:(?!none)/.test(code), "a shadow was introduced");
  assert.ok(!/border-radius:(?!0)/.test(code), "a rounded container was introduced");
  assert.ok(!/gradient|backdrop-filter|\bblur\(/.test(code), "a gradient or blur was introduced");
  // Structure comes from hairlines: 1px, and nothing heavier.
  for (const m of code.matchAll(/border(?:-(?:top|right|bottom|left))?:\s*([^;}]+)/g)) {
    if (m[1].trim() === "0") continue;
    assert.match(m[1], /^1px solid /, `a border heavier than a hairline: ${m[1]}`);
  }
  // NO PURE WHITE, and every tint is derived from cream or near black.
  assert.ok(!/#fff\b|#ffffff\b/i.test(code), "a white hex appeared");
  for (const m of code.matchAll(/rgba\((\d+),\s*(\d+),\s*(\d+),[^)]*\)/g)) {
    const rgb = `${m[1]},${m[2]},${m[3]}`;
    assert.ok(rgb === "245,235,226" || rgb === "17,17,17", `an rgba outside the palette: ${m[0]}`);
  }
});

test("4e: the grids reflow and the reading order never does", () => {
  const at1100 = code.slice(code.indexOf("@media (max-width:1100px)"), code.indexOf("@media (max-width:900px)"));
  const at900 = code.slice(code.indexOf("@media (max-width:900px)"), code.indexOf("@media (max-width:760px)"));
  const at520 = code.slice(code.indexOf("@media (max-width:520px)"));

  assert.match(rule(".about-values-list{"), /grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/);
  assert.match(at1100, /\.about-values-list\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(at900, /\.about-values-list\{grid-template-columns:minmax\(0,1fr\)/);
  // Both two-column shapes stack at the same width.
  assert.match(at900, /\.about-name-body\{grid-template-columns:minmax\(0,1fr\)/);
  assert.match(at900, /\.about-story-inner\{grid-template-columns:minmax\(0,1fr\)/);
  // The name halves stack rather than squeezing on a phone.
  assert.match(at520, /\.about-name-parts\{grid-template-columns:minmax\(0,1fr\)\}/);
  // Nothing is reordered.
  assert.ok(!/\border:\s*-?\d/.test(code) && !/grid-auto-flow:\s*dense/.test(code),
    "a reflow changed the reading order");
  // The section scale steps down once, at the same 900px the hero uses.
  assert.match(at900, /font-size:clamp\(36px,9\.2vw,44px\)/);
});

test("5: every rule is About-scoped, and no other page moved", () => {
  let preludes = 0;
  for (const m of code.matchAll(/[}{]\s*([^{}@]+?)\s*\{/g)) {
    for (const sel of m[1].split(",")) {
      const s = sel.trim();
      if (!s) continue;
      preludes++;
      assert.ok(/^\.about-/.test(s), `an unscoped selector in the About block: ${s}`);
    }
  }
  assert.ok(preludes > 25, `only ${preludes} selectors were scanned`);
  assert.ok(!code.includes("!important"), "specificity was solved with !important");
  // Nothing outside /about renders an About class.
  const others = site.replace(about, "");
  for (const cls of ["about-hero", "about-name", "about-story", "about-value"]) {
    assert.ok(!others.includes(cls), `${cls} is rendered outside /about`);
  }
  // The chrome and the other pages' blocks are untouched.
  const chrome = read("app/Chrome.tsx");
  assert.ok(chrome.includes('["/about","Über GLOA"]'), "the nav label changed");
  assert.match(chrome, /export function Header/);
  assert.match(chrome, /export function Footer/);
  for (const marker of ["/our-matcha PAGE HERO", ".home-rail{", "/partnerships — EVENTS"]) {
    assert.ok(css.includes(marker), `a frozen block went missing: ${marker}`);
  }
});

test("5b: the page got shorter, not just rearranged", () => {
  // Seven bands became three, and the sheet lost roughly a third of its
  // rules with them. A regression here means a band came back.
  assert.equal((mainHtml().match(/<section class="about-/g) || []).length, 3);
  assert.ok(code.length < 14000, `the About block grew back to ${code.length} characters`);
  assert.ok(about.length < 6000, `the About component grew back to ${about.length} characters`);
});
