import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * ONE PAGE HERO TYPE SCALE, AND THE HOMEPAGE DEFINES IT.
 *
 * Seven routes carry a true page hero. Six of them had grown a hero
 * scale of their own - six sizes, five letter-spacings, one hero at the
 * wrong weight, and six second lines set in Cormorant where the
 * homepage has always used Inter italic.
 *
 * These tests pin the canonical system, pin that the homepage's own
 * rules still agree with it (the homepage source is deliberately left
 * alone, so a test is what binds the two), and pin that every hero
 * reads it.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf8");

const site = read("app/GloaSite.tsx");
const css = read("app/globals.css");

const blockAt = css.indexOf("THE PAGE HERO TYPE SYSTEM");
assert.notEqual(blockAt, -1, "the canonical hero block was not found");
// Bounded at the next banner, so blocks appended after this one - the
// /partnerships page, and whatever follows it - are not read as ours.
const heroStart = css.lastIndexOf("/*", blockAt);
const heroEnd = css.indexOf("/* ══════", blockAt);
const rules = css.slice(heroStart, heroEnd === -1 ? css.length : heroEnd);
const code = rules.replace(/\/\*[\s\S]*?\*\//g, "");

const rule = name => {
  const at = code.indexOf(name);
  assert.notEqual(at, -1, `missing rule: ${name}`);
  return code.slice(at, code.indexOf("}", at));
};
/** A declaration's value from anywhere in the stylesheet. */
const decl = (scope, prop) => {
  const m = new RegExp(`(?:^|[;{\\s])${prop}\\s*:\\s*([^;}]+)`).exec(scope);
  return m ? m[1].trim() : null;
};

/* ══════════════════════════════════════════════════════════════
   1. THE CANONICAL CONTRACT
   ══════════════════════════════════════════════════════════════ */

test("1: the primary hero line is Inter 800 at the homepage scale", () => {
  const r = rule(".gloa-hero-primary{");
  assert.equal(decl(r, "font-family"), "var(--font-sans),Arial,sans-serif");
  assert.equal(decl(r, "font-style"), "normal");
  assert.equal(decl(r, "font-weight"), "800");
  assert.equal(decl(r, "font-size"), "var(--type-hero-primary)");
  assert.equal(decl(r, "line-height"), ".92");
  assert.equal(decl(r, "letter-spacing"), "-.055em");
  assert.match(css, /--type-hero-primary:clamp\(54px,5\.9vw,100px\)/);
});

test("2: the second hero line is Inter ITALIC 400, never Cormorant", () => {
  const r = rule(".gloa-hero-secondary{");
  assert.equal(decl(r, "font-family"), "var(--font-sans),Arial,sans-serif");
  assert.equal(decl(r, "font-style"), "italic");
  assert.equal(decl(r, "font-weight"), "400");
  assert.equal(decl(r, "font-size"), "var(--type-hero-secondary)");
  assert.equal(decl(r, "line-height"), ".98");
  assert.equal(decl(r, "letter-spacing"), "-.045em");
  assert.equal(decl(r, "font-synthesis"), "none");
  assert.match(css, /--type-hero-secondary:clamp\(48px,5vw,86px\)/);
  // The display face may not appear anywhere in this block.
  assert.ok(!code.includes("--font-display"), "Cormorant reached the hero system");
  assert.ok(!/Georgia|Times/.test(code), "a fallback serif reached the hero system");
});

test("3: the hero eyebrow is Inter 600 / 11px / 1.2 / .2em / uppercase", () => {
  const r = rule(".gloa-hero-eyebrow{");
  assert.equal(decl(r, "font-family"), "var(--font-sans),Arial,sans-serif");
  assert.equal(decl(r, "font-weight"), "600");
  assert.equal(decl(r, "font-size"), "11px");
  assert.equal(decl(r, "line-height"), "1.2");
  assert.equal(decl(r, "letter-spacing"), ".2em");
  assert.equal(decl(r, "text-transform"), "uppercase");
});

test("4: the whole scale steps down once, at 900px", () => {
  const mq = code.slice(code.indexOf("@media (max-width:900px)"));
  assert.match(mq, /--type-hero-primary:clamp\(44px,12vw,64px\)/);
  assert.match(mq, /--type-hero-secondary:clamp\(38px,10\.5vw,56px\)/);
  // Weight, leading and tracking do not change on mobile.
  assert.ok(!/font-weight|line-height|letter-spacing|font-style|font-family/.test(mq),
    "mobile changes more than the size");
});

/* ══════════════════════════════════════════════════════════════
   5. THE HOMEPAGE IS THE MASTER, AND STILL AGREES
   ══════════════════════════════════════════════════════════════ */

test("5: the homepage's own rules resolve to the canonical values", () => {
  // The homepage source is deliberately untouched, so this test is what
  // stops the master and the system drifting apart.
  const home = css.slice(css.indexOf(".hero .hero-copy h1{"));
  const primary = home.slice(0, home.indexOf("}"));
  assert.equal(decl(primary, "font-family"), "var(--font-sans),Arial,sans-serif");
  assert.equal(decl(primary, "font-weight"), "800");
  assert.equal(decl(primary, "font-style"), "normal");
  assert.equal(decl(primary, "font-size"), "clamp(54px,5.9vw,100px)");
  assert.equal(decl(primary, "line-height"), ".92");
  assert.equal(decl(primary, "letter-spacing"), "-.055em");

  const secAt = css.indexOf(".hero .hero-copy h1 .hero-line-2{");
  const secondary = css.slice(secAt, css.indexOf("}", secAt));
  assert.equal(decl(secondary, "font-family"), "var(--font-sans),Arial,sans-serif");
  assert.equal(decl(secondary, "font-style"), "italic");
  assert.equal(decl(secondary, "font-weight"), "400");
  assert.equal(decl(secondary, "font-size"), "clamp(48px,5vw,86px)");
  assert.equal(decl(secondary, "line-height"), ".98");
  assert.equal(decl(secondary, "letter-spacing"), "-.045em");
  assert.equal(decl(secondary, "font-synthesis"), "none");

  const eyeAt = css.indexOf(".hero .hero-copy .eyebrow{");
  const eyebrow = css.slice(eyeAt, css.indexOf("}", eyeAt));
  assert.equal(decl(eyebrow, "font-weight"), "600");
  assert.equal(decl(eyebrow, "font-size"), "11px");
  assert.equal(decl(eyebrow, "line-height"), "1.2");
  assert.equal(decl(eyebrow, "letter-spacing"), ".2em");

  // And its mobile step matches the token's.
  assert.match(css, /\.hero \.hero-copy h1\{font-size:clamp\(44px,12vw,64px\)/);
  assert.match(css, /\.hero \.hero-copy h1 \.hero-line-2\{font-size:clamp\(38px,10\.5vw,56px\)\}/);
});

/* ══════════════════════════════════════════════════════════════
   6. EVERY TRUE HERO READS THE SYSTEM
   ══════════════════════════════════════════════════════════════ */

/** route -> [eyebrow, primary line(s), secondary line] as rendered. */
const HEROES = [
  ["/shop", '<p className="eyebrow shop-hero-eyebrow gloa-hero-eyebrow">',
    ['<span className="shop-hero-line gloa-hero-primary">Alles von</span>',
     '<span className="shop-hero-line gloa-hero-primary">GLOA.</span>'],
    '<i className="shop-hero-line shop-hero-line-accent gloa-hero-secondary">'],
  ["/our-matcha", '<p className="eyebrow matcha-hero-eyebrow gloa-hero-eyebrow">',
    ['<span className="matcha-hero-line gloa-hero-primary">Matcha.</span>'],
    '<i className="matcha-hero-line matcha-hero-line-accent gloa-hero-secondary">'],
  ["/about", '<p className="eyebrow about-hero-eyebrow gloa-hero-eyebrow">',
    ['<span className="about-hero-line gloa-hero-primary">Good energy.</span>'],
    '<i className="about-hero-line about-hero-line-accent gloa-hero-secondary">'],
  ["/for-cafes", '<p className="eyebrow b2b-hero-eyebrow gloa-hero-eyebrow">',
    ['<span className="b2b-hero-line gloa-hero-primary">Dein Matcha.</span>'],
    '<i className="b2b-hero-line b2b-hero-line-accent gloa-hero-secondary">'],
  ["/rezepte", '<p className="eyebrow gloa-hero-eyebrow">GLOA · REZEPTE</p>',
    ['<h1 className="gloa-hero-primary">Matcha Rezepte.'],
    '<i className="gloa-hero-secondary">GLOA Edition.</i>'],
  ["/contact", '<p className="eyebrow gloa-hero-eyebrow">KONTAKT</p>',
    ['<h1 className="gloa-hero-primary">Schreib'],
    '<i className="gloa-hero-secondary">uns.</i>'],
  // Added with the page itself rather than converted: /partnerships was
  // built on this scale from the start and never had one of its own.
  ["/partnerships", '<p className="eyebrow pt-eyebrow pt-hero-eyebrow gloa-hero-eyebrow">',
    ['<span className="pt-hero-line gloa-hero-primary">Your idea.</span>'],
    '<i className="pt-hero-line pt-hero-line-accent gloa-hero-secondary">Our Matcha.</i>'],
];

test("6: all seven non-homepage heroes carry the canonical classes", () => {
  for (const [route, eyebrow, primaries, secondary] of HEROES) {
    assert.ok(site.includes(eyebrow), `${route}: eyebrow is off the system`);
    for (const p of primaries) assert.ok(site.includes(p), `${route}: primary is off the system`);
    assert.ok(site.includes(secondary), `${route}: second line is off the system`);
  }
  // The homepage keeps its own rules and needs no class - test 5 binds it.
  assert.match(site, /<h1>Matcha\.<br\/><span className="hero-line-2">Is for everyone\.<\/span><\/h1>/);
});

test("6b: no route-specific hero size, weight or family survives", () => {
  // Every route hero rule may still hold colour and margin - and nothing
  // typographic, or it would outrank the shared class.
  const TYPO = /(font-family|font-style|font-weight|font-size|line-height|letter-spacing)\s*:/;
  const ROUTE_HERO = /^\.(shop-hero-line|shop-hero-line-accent|matcha-hero-line|matcha-hero-line-accent|about-hero-line|about-hero-line-accent|pt-hero-line|pt-hero-line-accent|rezepte-page h1|contact-hero h1)( i)?$|^\.b2b-hero \.b2b-hero-line(-accent)?$/;
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
  let checked = 0;
  for (const m of bare.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const sel = m[1].split(/[\r\n]/).pop().trim();
    if (!ROUTE_HERO.test(sel)) continue;
    checked++;
    assert.ok(!TYPO.test(m[2]), `${sel} still sets hero typography: ${m[2].slice(0, 70)}`);
  }
  assert.ok(checked >= 8, `only ${checked} route hero rules were scanned`);

  // The two shared italic lists no longer reach a hero, and still serve
  // their h2 consumers.
  // Comment-free: both names still appear in prose explaining the change.
  assert.ok(!bare.includes(".matcha-page h1 i"), "the matcha hero italic list still targets the hero");
  assert.ok(!bare.includes(".b2b-hero h1 i"), "the b2b hero italic list still targets the hero");
  assert.match(css, /\.matcha-facts h2 i,\.matcha-transparency h2 i/);
  assert.match(css, /\.behind-bar h2 i,\.business-support h2 i,\.faq h2 i\{/);
  // The route hero curves are gone from every LIVE rule. (They are still
  // quoted in earlier block comments as history, which is why this reads
  // the comment-free view.)
  for (const legacy of ["clamp(48px,6vw,80px)", "clamp(52px,5.4vw,84px)",
                        "clamp(52px,5.4vw,76px)", "clamp(48px,5vw,76px)",
                        "clamp(50px,5vw,72px)"]) {
    assert.ok(!bare.includes(legacy), `a legacy hero curve survived: ${legacy}`);
  }
  // The one legacy rule that still carries a 122px curve is the old
  // `.hero h1,.inner h1` fallback. It is NOT deleted - it is outranked
  // by `.hero .hero-copy h1` (0,2,1 beats 0,1,1), which is why the
  // homepage measures 5.9vw. Pinned so the guard cannot silently vanish.
  assert.match(bare, /\.hero h1,\.inner h1\{font-size:clamp\(64px,8vw,122px\)/);
  assert.match(bare, /\.hero \.hero-copy h1\{[^}]*font-size:clamp\(54px,5\.9vw,100px\)/);
});

/* ══════════════════════════════════════════════════════════════
   7. WHAT THIS PASS MUST NOT HAVE TOUCHED
   ══════════════════════════════════════════════════════════════ */

test("7: typography only - no colour, layout or copy in the hero system", () => {
  // Declarations only - "max-width" in the media query condition is not one.
  const decls = code.replace(/@media[^{]*\{/g, "{");
  for (const banned of ["color:", "background", "border", "padding", "margin", "width:",
                        "display:", "grid", "flex", "position", "object-fit"]) {
    assert.ok(!decls.includes(banned), `the hero system declares ${banned}`);
  }
  // "height:" but never "line-height:", which is typography.
  assert.ok(!/(^|[;{\s])height\s*:/.test(decls), "the hero system declares height");
  assert.ok(!code.includes("!important"), "specificity was solved with !important");

  // Every hero's own colour is exactly where it was.
  assert.match(css, /\.matcha-hero-line\{color:var\(--ink\)\}/);
  assert.match(css, /\.about-hero-line\{color:var\(--cream\)\}/);
  assert.match(css, /\.b2b-hero \.b2b-hero-line\{color:var\(--cream\)\}/);
  assert.match(css, /\.b2b-hero \.b2b-hero-line-accent\{margin-top:6px;color:var\(--cream\)\}/);
  assert.match(css, /\.about-hero-eyebrow\{color:rgba\(245,235,226,\.72\)\}/);
  assert.match(css, /\.pt-hero-line\{color:var\(--cream\)\}/);

  // And every hero's copy, word for word.
  for (const copy of ["Matcha.<br/><span className=\"hero-line-2\">Is for everyone.",
                      "Alles von", "GLOA.", "alles was du brauchst.",
                      "Ohne Umwege.", "Good energy.", "No theatre.",
                      "Dein Matcha.", "Dein Signature-Drink.",
                      "Matcha Rezepte.", "GLOA Edition.", "Schreib", "uns.",
                      "Your idea.", "Our Matcha."]) {
    assert.ok(site.includes(copy), `hero copy changed: ${copy}`);
  }
});

test("7b: Cormorant is untouched everywhere it is not a page hero", () => {
  // Still loaded, still the editorial face of the content sections.
  const layout = read("app/layout.tsx");
  assert.match(layout, /Cormorant_Garamond\(\{/);
  assert.match(layout, /variable: "--font-display"/);
  // A generous sample of non-hero editorial lines that must still be it.
  // Some of these sit in grouped selectors, so the rule is found by
  // scanning blocks rather than by an exact "selector{" match.
  const blocks = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^}]*)\}/g)];
  for (const sel of [".about-why-line-accent", ".about-real-line-accent",
                     ".matcha-product-line-accent", ".matcha-research-line-accent",
                     ".b2b-menu .b2b-menu-line-accent", ".b2b-compare .b2b-compare-line-accent",
                     ".b2b-flow .b2b-flow-line-accent", ".b2b-support .b2b-support-line-accent",
                     ".business .faq h2 i", ".matcha-page .faq h2 i"]) {
    const hit = blocks.find(b => b[1].split(",").some(x => x.trim() === sel)
      && /font-family/.test(b[2]));
    assert.ok(hit, `missing rule: ${sel}`);
    assert.match(hit[2], /var\(--font-display\)/, `${sel} lost Cormorant`);
  }
  // The shared h1 i / h2 i fallback still exists for everything else.
  assert.match(css, /h1 i,h2 i,h3 i,\.display-italic\{font-family:var\(--font-display\)/);
});

test("7c: no non-hero heading was pulled into the hero scale", () => {
  // The canonical classes appear on hero elements only.
  const uses = [...site.matchAll(/gloa-hero-(eyebrow|primary|secondary)/g)];
  // 7 eyebrows + 8 primary lines (/shop has two) + 7 second lines.
  assert.equal(uses.length, 22, `unexpected number of hero-class uses: ${uses.length}`);
  // Every use sits on an element whose own class names it a hero, or on
  // the /rezepte and /contact hero h1/i that have no other class.
  for (const m of site.matchAll(/className="([^"]*gloa-hero-[^"]*)"/g)) {
    const cls = m[1];
    assert.ok(/(shop-hero|matcha-hero|about-hero|b2b-hero|pt-hero)-/.test(cls)
      || cls === "eyebrow gloa-hero-eyebrow"
      || cls === "gloa-hero-primary" || cls === "gloa-hero-secondary",
      `a hero class landed somewhere unexpected: ${cls}`);
  }
  // The product, article, account and legal headings carry no class at all.
  for (const plain of ["<h1>{PRODUCT.name}</h1>", "<h1>{product.name}</h1>",
                       "<h1>{r.title}</h1>", "<h1>{title.agb}</h1>",
                       "<h1>Anmelden.</h1>", "<h1>404</h1>"]) {
    assert.ok(site.includes(plain), `a non-hero heading changed: ${plain}`);
  }
  // The old page-hero tokens are still defined; nothing reads them for a
  // hero any more, and no non-hero consumer was resized.
  assert.match(css, /--type-page-hero:clamp\(40px,5\.2vw,84px\)/);
  assert.match(css, /--type-page-hero-accent:clamp\(37px,4\.8vw,78px\)/);
});
