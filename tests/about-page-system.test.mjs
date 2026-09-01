import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * /about, AS ONE EDITORIAL SYSTEM.
 *
 * The pass replaced seven independently built sections with the system
 * /our-matcha and the homepage already carry. These tests pin the things
 * that made the page look like several sites - the type scale, the rail,
 * the section grounds, the min-heights - and the things a redesign must
 * never quietly take with it: the routes, the ticker, the nav, the
 * footer, and the exact authorised copy.
 *
 * They are deliberately not pixel tests. Paddings and gaps are free to
 * move; the ROLES and the HIERARCHY are not.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf8");

const site = read("app/GloaSite.tsx");
const css = read("app/globals.css");

const about = site.slice(site.indexOf("function About(){return <main"), site.indexOf("\nfunction ForCafes()"));
const blockAt = css.indexOf("/about — ONE EDITORIAL SYSTEM");
assert.notEqual(blockAt, -1, "the About CSS block was not found");
// Bounded at the NEXT page block, so a block appended after this one
// cannot answer for - or trip - an assertion about /about.
const rules = css.slice(css.lastIndexOf("/*", blockAt), css.lastIndexOf("/*", css.indexOf("/for-cafes PAGE HERO")));
assert.ok(rules.length > 4000, "the About CSS block was not found");

/* The block opens with a long explanatory comment. Every structural
   check below reads the comment-free view, so the prose describing what
   the page USED to be cannot answer for the rules. */
const code = rules.replace(/\/\*[\s\S]*?\*\//g, "");

const rule = name => {
  const at = code.indexOf(name);
  assert.notEqual(at, -1, `missing rule: ${name}`);
  return code.slice(at, code.indexOf("}", at));
};
/* Desktop rules only - everything before the first @media. */
const desktop = code.slice(0, code.indexOf("@media"));
const mobile = code.slice(code.indexOf("@media (max-width:900px)"));

/* ══════════════════════════════════════════════════════════════
   1. THE SECTION SEQUENCE AND ITS GROUNDS
   ══════════════════════════════════════════════════════════════ */

test("1: seven sections, in the intended blue/raspberry/cream/plum rhythm", () => {
  const order = [...about.matchAll(/<section className="(about-[a-z]+)"/g)].map(m => m[1]);
  assert.deepEqual(order, [
    "about-hero", "about-why", "about-real",
    "about-origin", "about-cares", "about-tiktok", "about-final",
  ]);

  const ground = (sel, token) =>
    assert.match(rule(sel), new RegExp(`background:var\\(--${token}\\)`), `${sel} is not ${token}`);
  ground(".about-hero{", "blue");
  ground(".about-why{", "berry");
  ground(".about-real{", "cream");
  ground(".about-origin{", "plum");
  ground(".about-cares{", "cream");
  ground(".about-tiktok{", "blue");
  ground(".about-final{", "plum");

  // The four brand values, exactly - and no fifth colour anywhere in
  // the block. Every colour here is a token or a cream/ink alpha.
  assert.match(css, /--blue:#1746D1;/);
  assert.match(css, /--berry:#A61E59;/);
  assert.match(css, /--cream:#F5EBE2;/);
  assert.match(css, /--plum:#4F3A5B;/);
  assert.match(css, /--ink:#111111;/);
  for (const m of code.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
    assert.fail(`a literal hex colour in the About block: ${m[0]}`);
  }
  for (const m of code.matchAll(/rgba\(([^)]+)\)/g)) {
    const [r, g, b] = m[1].split(",").map(n => Number(n.trim()));
    const cream = r === 245 && g === 235 && b === 226;
    const ink = r === 17 && g === 17 && b === 17;
    assert.ok(cream || ink, `a non-brand rgba in the About block: rgba(${m[1]})`);
  }
});

test("1b: no gradient, no card, no pill, no shadow, no glass", () => {
  for (const banned of [
    "gradient", "box-shadow:0", "backdrop-filter", "filter:blur",
    "border-radius:4", "border-radius:8", "border-radius:12",
    "border-radius:99", "border-radius:50%",
  ]) {
    assert.ok(!code.includes(banned), `the About block grew ${banned}`);
  }
  // Radius is declared only to pin it to zero.
  for (const m of code.matchAll(/border-radius:([^;}]+)/g)) {
    assert.equal(m[1].trim(), "0", `a non-zero radius: ${m[1]}`);
  }
});

/* ══════════════════════════════════════════════════════════════
   2. NO EMPTY COLOUR BANDS
   ══════════════════════════════════════════════════════════════ */

test("2: every height is content-driven - no min-height, no vh", () => {
  // The 630px hero and the 600px split half were what produced the empty
  // blue and raspberry stripes between sections. What is left is the
  // shared button box (52/54px, a tap target), and ONE deliberate
  // content floor on the hero grid - the height the brief specifies for
  // it, dropped again below 1024px.
  const allowed = new Set(["52px", "54px", "clamp(300px,25vw,370px)", "0"]);
  for (const m of code.matchAll(/min-height:([^;}]+)/g)) {
    assert.ok(allowed.has(m[1].trim()), `an unexpected min-height: ${m[1].trim()}`);
  }
  // The floor is on the hero's grid, never on a section - so no section
  // can reserve blank ground.
  assert.match(rule(".about-hero-inner{"), /min-height:clamp\(300px,25vw,370px\)/);
  assert.match(rules, /\.about-hero-inner\{grid-template-columns:1fr;[^}]*min-height:0\}/);
  for (const sel of [".about-hero{", ".about-why{", ".about-real{", ".about-origin{",
                     ".about-cares{", ".about-tiktok{", ".about-final{"]) {
    assert.ok(!/min-height|height:/.test(rule(sel)), `${sel} reserves height`);
  }
  assert.ok(!/\d+vh/.test(code), "a viewport height came back to /about");
  // And the legacy rules that carried them are gone from the file.
  assert.ok(!css.includes(".about-hero{min-height:630px"), "the legacy hero rule survived");
  assert.ok(!css.includes(".about-why{display:grid;grid-template-columns:1fr 1fr;min-height:600px}"),
    "the legacy split rule survived");
  assert.ok(!css.includes(".about-page h1{font-size:clamp(64px,8vw,122px)"),
    "the legacy 122px page h1 survived");
  // Nothing renders an empty wrapper: every section's children carry
  // either text, a link or the one decorative svg.
  assert.ok(!/<div[^>]*\/>|<span className="[^"]*"\/>/.test(about),
    "an empty element was left in the markup");
  // The standalone hero sequence number is gone, and no section
  // numbering replaced it.
  assert.ok(!about.includes("page-index"), "the hero index number survived");
  assert.equal([...about.matchAll(/>0[1-9]</g)].length, 0,
    "a bare section number is rendered in the markup");
});

/* ══════════════════════════════════════════════════════════════
   3. THE TYPE SYSTEM
   ══════════════════════════════════════════════════════════════ */

const clampAt = (text, w) => {
  const [lo, vw, hi] = /clamp\(([\d.]+)px,([\d.]+)vw,([\d.]+)px\)/.exec(text).slice(1).map(Number);
  return Math.max(lo, Math.min((vw / 100) * w, hi));
};
const size = (scope, sel) => {
  const at = scope.indexOf(sel);
  assert.notEqual(at, -1, `missing rule: ${sel}`);
  return /font-size:(clamp\([^)]*\)|\d+px)/.exec(scope.slice(at))[1];
};
const at = (text, w) => (text.endsWith("px") && !text.startsWith("clamp") ? Number.parseFloat(text) : clampAt(text, w));

/* The two curves this page must never cross. */
const homepageHero = w => (w <= 900 ? Math.max(44, Math.min(0.12 * w, 64)) : Math.max(54, Math.min(0.059 * w, 100)));

const WIDTHS = [320, 360, 390, 430, 480, 640, 768, 900, 901, 1024, 1200, 1280, 1440, 1536, 1680, 1920];

test("3: the caps the brief specifies, exactly", () => {
  const cap = t => /clamp\([\d.]+px,[\d.]+vw,([\d.]+)px\)/.exec(t)[1];
  assert.equal(cap(size(desktop, ".about-hero-line{")), "84");          // page hero sans
  assert.equal(cap(size(desktop, ".about-hero-line-accent{")), "76");   // page hero italic
  assert.equal(cap(size(desktop, ".about-why-line,")), "60");           // section sans
  assert.equal(cap(size(desktop, ".about-why-line-accent,")), "64");    // section italic
  assert.equal(cap(size(desktop, ".about-cares-line{")), "50");         // values intro sans
  assert.equal(cap(size(desktop, ".about-cares-line-accent{")), "54");  // values intro italic
  assert.equal(cap(size(desktop, ".about-cares-statement{")), "32");    // 01/02/03 rows
  assert.equal(cap(size(desktop, ".about-handle{")), "36");             // @gloa.matcha
});

test("3b: the hero is the ONLY page-hero-scale title, at every width", () => {
  const pick = (sel, w) => at(size(w <= 900 ? mobile : desktop, sel), w);
  for (const w of WIDTHS) {
    const heroSans = pick(".about-hero-line{", w);
    const heroItalic = pick(".about-hero-line-accent{", w);

    // Nothing on /about reads larger than the homepage hero.
    assert.ok(heroSans < homepageHero(w),
      `the About hero (${heroSans}) reaches the homepage hero (${homepageHero(w)}) at ${w}px`);

    // Every other title on the page stays under the hero.
    for (const sel of [".about-why-line,", ".about-why-line-accent,",
                       ".about-cares-line{", ".about-cares-line-accent{",
                       ".about-cares-statement{", ".about-handle{"]) {
      const other = pick(sel, w);
      assert.ok(other < heroSans, `${sel} (${other}) reaches the hero sans (${heroSans}) at ${w}px`);
      assert.ok(other < heroItalic || sel.includes("statement") || sel.includes("handle") || sel.includes("cares"),
        `${sel} (${other}) reaches the hero italic (${heroItalic}) at ${w}px`);
    }
    // The section italic is the tallest non-hero line, so it is the one
    // that has to clear the hero italic too.
    assert.ok(pick(".about-why-line-accent,", w) < heroItalic,
      `the section italic reaches the hero italic at ${w}px`);

    // The values intro is deliberately BELOW section scale, and the
    // statement rows below that.
    assert.ok(pick(".about-cares-line{", w) < pick(".about-why-line,", w),
      `the values intro is not below section scale at ${w}px`);
    assert.ok(pick(".about-cares-statement{", w) < pick(".about-cares-line{", w),
      `a statement row outgrew the values intro at ${w}px`);
  }
});

test("3c: the four normal sections share ONE headline pair", () => {
  // One rule, four selectors - drift is not expressible.
  assert.match(desktop, /\.about-why-line,\s*\.about-real-line,\s*\.about-tiktok-line,\s*\.about-final-line\{/);
  assert.match(desktop, /\.about-why-line-accent,\s*\.about-real-line-accent,\s*\.about-tiktok-line-accent,\s*\.about-final-line-accent\{/);
  // The sans is Inter 500, the accent is a real Cormorant italic.
  assert.match(rule(".about-why-line,"), /font-weight:500/);
  assert.match(rule(".about-why-line,"), /font-family:var\(--font-sans\)/);
  assert.match(rule(".about-why-line-accent,"), /font-family:var\(--font-display\)/);
  assert.match(rule(".about-why-line-accent,"), /font-style:italic/);
  assert.match(rule(".about-why-line-accent,"), /font-weight:400/);
});

test("3d: one eyebrow rule for all six eyebrows, at 11px / .2em", () => {
  const eyebrow = rule(".about-hero-eyebrow,");
  assert.match(eyebrow, /font-size:var\(--type-meta\)/);
  assert.match(css, /--type-meta:11px/);
  assert.match(eyebrow, /letter-spacing:\.2em/);
  assert.match(eyebrow, /font-weight:600/);
  assert.match(eyebrow, /text-transform:uppercase/);
  for (const name of ["about-why-eyebrow", "about-real-eyebrow", "about-origin-eyebrow",
                      "about-cares-eyebrow", "about-tiktok-eyebrow"]) {
    assert.ok(eyebrow.includes(name), `${name} is not on the shared eyebrow rule`);
  }
  // Every eyebrow in the markup carries the shared .eyebrow class too.
  for (const m of about.matchAll(/className="([^"]*about-\w+-eyebrow)"/g)) {
    assert.match(m[1], /^eyebrow /, `${m[1]} is missing the shared class`);
  }
});

test("3e: body copy is 16-17px everywhere, and 16px on mobile", () => {
  for (const sel of [".about-hero-lead,", ".about-why-body{", ".about-real-body{",
                     ".about-origin-body{", ".about-tiktok-body{"]) {
    assert.match(rule(sel), /font-size:clamp\(16px,1\.3vw,17px\)/, `${sel} is off the body role`);
    assert.match(rule(sel), /line-height:1\.5[5-9]|line-height:1\.6[0-9]?/, `${sel} is off the body leading`);
  }
  assert.match(mobile, /\.about-real-body\{max-width:none;font-size:16px\}/);
  // No 20-22px default body, and no 12px body copy.
  for (const m of desktop.matchAll(/font-size:(\d+)px/g)) {
    const px = Number(m[1]);
    assert.ok(px <= 12 || px >= 16, `a stray ${px}px type size`);
  }
});

test("3f: two families, and only two", () => {
  for (const m of rules.matchAll(/font-family:([^;}]+)/g)) {
    assert.match(m[1], /^var\(--font-(sans|display)\)/, `a third family: ${m[1]}`);
  }
  // Georgia survives only as the technical fallback after the variable,
  // which is the site-wide contract.
  for (const m of rules.matchAll(/font-family:var\(--font-display\),([^;}]+)/g)) {
    assert.equal(m[1].trim(), "Georgia,serif");
  }
  assert.ok(!rules.includes("@import") && !rules.includes("@font-face"),
    "the About block loads a font");
  // Both families are still the two next/font faces, unchanged.
  const layout = read("app/layout.tsx");
  assert.match(layout, /Inter\(\{/);
  assert.match(layout, /Cormorant_Garamond\(\{/);
  assert.equal([...layout.matchAll(/from "next\/font\/google"/g)].length, 1);
});

/* ══════════════════════════════════════════════════════════════
   4. THE CANONICAL RAIL
   ══════════════════════════════════════════════════════════════ */

test("4: every section content block sits on the canonical rail", () => {
  // All seven sections use the shared utility inside a full-width ground.
  for (const inner of ["about-hero-inner", "about-why-inner", "about-real-inner", "about-origin-inner",
                       "about-cares-inner", "about-tiktok-inner", "about-final-inner"]) {
    assert.ok(about.includes(`className="${inner} home-rail"`), `${inner} is off the rail`);
  }
  assert.match(css, /\.home-rail\{\s*width:100%;\s*max-width:var\(--rail-max\);\s*margin-inline:auto;\s*\}/);
  // Their grounds hand the horizontal gutter to the shared token - no
  // section-specific 5vw survives.
  for (const sel of [".about-hero{", ".about-real{", ".about-origin{",
                     ".about-cares{", ".about-tiktok{", ".about-final{"]) {
    assert.match(rule(sel), /padding-inline:var\(--rail-gutter\)/, `${sel} sets its own gutter`);
  }
  assert.ok(!/padding[^;}]*\dvw/.test(desktop.replace(/clamp\([^)]*\)/g, "")),
    "a section-specific vw gutter survived");

  // ALL SEVEN sections are now the same shape - a full-width ground
  // handing its gutter to the token, with .home-rail inside. The
  // half-column rail arithmetic the old 50/50 split needed is gone,
  // and with it the last bespoke geometry on the page.
  assert.ok(!code.includes("100% * 2"), "the split's bespoke rail maths survived");
  assert.equal([...about.matchAll(/ home-rail"/g)].length, 7,
    "a section content block is off the shared rail utility");
  assert.equal([...code.matchAll(/padding-inline:var\(--rail-gutter\)/g)].length, 7,
    "a section ground is not on the shared gutter");
});

/* ══════════════════════════════════════════════════════════════
   5. LAYOUT SHAPES
   ══════════════════════════════════════════════════════════════ */

test("5: WHY GLOA EXISTS is ONE raspberry ground, not a split", () => {
  // The cream half, the seam and the near-black copy are gone, and so
  // is the bespoke half-column rail arithmetic the split needed.
  assert.ok(!about.includes("about-why-left") && !about.includes("about-why-right"),
    "a half of the old split survived in the markup");
  assert.ok(!code.includes("about-why-left") && !code.includes("about-why-right"),
    "a half of the old split survived in the CSS");
  const why = rule(".about-why{");
  assert.match(why, /background:var\(--berry\)/);
  assert.match(why, /color:var\(--cream\)/);
  assert.ok(!/var\(--ink\)/.test(rules.slice(rules.indexOf(".about-why{"), rules.indexOf("/* ── 03"))),
    "near-black type survived in the raspberry section");
  // It is a normal railed section now, exactly like the other five.
  assert.match(why, /padding-inline:var\(--rail-gutter\)/);
  assert.ok(about.includes('className="about-why-inner home-rail"'));

  // Two columns, headline-dominant, with a real column gap.
  const inner = rule(".about-why-inner{");
  assert.match(inner, /grid-template-columns:minmax\(0,1\.05fr\) minmax\(0,\.95fr\)/);
  assert.match(inner, /gap:clamp\(40px,4\.8vw,88px\)/);
  assert.match(inner, /align-items:center/);
  assert.ok(!/border-radius|box-shadow|background/.test(inner), "the columns grew a container");

  // Eyebrow, headline, then copy - the order the stacked view needs.
  assert.ok(about.indexOf("about-why-eyebrow") < about.indexOf("about-why-headline"));
  assert.ok(about.indexOf("about-why-headline") < about.indexOf("about-why-detail"));
  assert.match(mobile, /\.about-why-inner\{grid-template-columns:1fr/);
});

test("5a: the right column is three blocks that never leave the body role", () => {
  for (const cls of ["about-why-lead", "about-why-body", "about-why-close"]) {
    assert.ok(about.includes(`className="${cls}"`), `${cls} is not rendered`);
  }
  // 500/18 -> 400/17 -> 500/17. A step in weight and one in size, and
  // the top of it is --type-body's own 18px ceiling.
  const lead = rule(".about-why-lead{");
  assert.match(lead, /font-weight:500/);
  assert.match(lead, /font-size:clamp\(17px,1\.45vw,18px\)/);
  assert.match(rule(".about-why-body{"), /font-weight:400/);
  assert.match(rule(".about-why-body{"), /font-size:clamp\(16px,1\.3vw,17px\)/);
  assert.match(rule(".about-why-close{"), /font-weight:500/);
  const bodyCap = Number(/clamp\([\d.]+px,[\d.]+vw,([\d.]+)px\)/.exec(/--type-body:([^;]+);/.exec(css)[1])[1]);
  for (const sel of [".about-why-lead{", ".about-why-body{", ".about-why-close{"]) {
    const px = Number(/font-size:clamp\([\d.]+px,[\d.]+vw,([\d.]+)px\)/.exec(rule(sel))[1]);
    assert.ok(px <= bodyCap, `${sel} (${px}px) is above the site body ceiling (${bodyCap}px)`);
  }
  // All three are cream, and the blocks are separated by space.
  for (const sel of [".about-why-lead{", ".about-why-body{", ".about-why-close{"]) {
    assert.match(rule(sel), /color:var\(--cream\)/, `${sel} is not cream`);
  }
  assert.match(rule(".about-why-body{"), /margin:clamp\(24px,2\.4vw,32px\) 0 0/);
  assert.match(rule(".about-why-close{"), /margin:clamp\(28px,2\.8vw,40px\) 0 0/);
  // One subtle hairline, inside the dark-ground band the rest of the
  // site uses (.20-.28), and no box around anything.
  const close = rule(".about-why-close{");
  assert.match(close, /border-top:1px solid rgba\(245,235,226,\.22\)/);
  // Exactly one such rule - the section grew no second divider.
  assert.equal([...code.matchAll(/rgba\(245,235,226,\.22\)/g)].length, 1);
  assert.match(close, /line-height:1\.85/);
  assert.match(rule(".about-why-detail{"), /max-width:560px/);
});

test("5b: Herkunft is a compact band, with a decorative line mark", () => {
  const band = rule(".about-origin{");
  assert.match(band, /padding-block:clamp\(54px,4\.6vw,70px\)/);
  // Smaller than every normal section on the page.
  for (const sel of [".about-real{", ".about-cares{", ".about-tiktok{", ".about-final{"]) {
    const other = /padding-block:clamp\(([\d.]+)px/.exec(rule(sel))[1];
    assert.ok(Number(other) > 54, `${sel} is not taller than the compact band`);
  }
  // One inline svg, decorative, no dependency and no emoji.
  assert.equal([...about.matchAll(/<svg/g)].length, 1);
  const svg = about.slice(about.indexOf("<svg"), about.indexOf("</svg>"));
  assert.match(svg, /aria-hidden="true"/);
  assert.match(svg, /focusable="false"/);
  assert.match(svg, /stroke="currentColor"/);
  assert.ok(!/fill="(?!none)/.test(svg), "the mark is not a line drawing");
  assert.match(rule(".about-origin-mark{"), /color:var\(--berry\)/);
  assert.match(rule(".about-origin-mark{"), /width:88px/);
  assert.ok(!site.includes("import ") || !/react-icons|lucide|@heroicons/.test(site),
    "an icon library was added");
});

test("5c: the values list is rows and hairlines, never cards", () => {
  assert.match(rule(".about-cares-list{"), /border-top:1px solid rgba\(17,17,17,\.14\)/);
  assert.match(rule(".about-cares-list>div{"), /border-bottom:1px solid rgba\(17,17,17,\.14\)/);
  const row = rule(".about-cares-list>div{");
  assert.ok(!/background/.test(row), "the rows grew a background");
  assert.ok(!/border-radius|box-shadow/.test(row));
  assert.match(rule(".about-cares-number{"), /color:var\(--berry\)/);
  assert.match(rule(".about-cares-number{"), /font-size:12px/);
  // Three rows, three numbers, no icon per row.
  const data = site.slice(site.indexOf("const aboutCares"), site.indexOf("];", site.indexOf("const aboutCares")));
  assert.equal([...data.matchAll(/\["0[1-9]"/g)].length, 3);
  assert.ok(!/<svg/.test(about.slice(about.indexOf("about-cares-list"), about.indexOf("about-tiktok"))),
    "an icon was added to the statement rows");
});

test("5d: Building GLOA is typography-led - no image was invented", () => {
  // The brief permits ONE existing APPROVED lifestyle image here. There
  // is none: every lifestyle photograph in public/img carries a
  // burned-in PLACEHOLDER mark, so the section stays typographic and no
  // asset was created, renamed or edited.
  assert.equal([...about.matchAll(/<img /g)].length, 0, "/about renders an image");
  assert.ok(!about.includes("/img/"), "/about references an image asset");
  assert.ok(!code.includes("about-tiktok-photo"), "the photo rules survived");
  // The assets the homepage uses are still referenced there, unchanged.
  assert.ok(site.includes('image:"/img/gloa-cafe.jpg"'));
  assert.ok(site.includes('src:"/img/gloa-work.jpg"'));

  // It takes the same two-column shape as MATCHA FOR REAL LIFE, so the
  // page has one section grammar rather than a second one here.
  assert.equal(
    /grid-template-columns:([^;}]+)/.exec(rule(".about-tiktok-inner{"))[1],
    /grid-template-columns:([^;}]+)/.exec(rule(".about-real-inner{"))[1],
  );
  // And it stacks on narrow viewports.
  assert.match(rules, /\.about-tiktok-inner\{grid-template-columns:1fr/);
  assert.ok(about.indexOf("about-tiktok-copy") < about.indexOf("about-tiktok-detail"));
});

/* ══════════════════════════════════════════════════════════════
   6. THE BUTTONS
   ══════════════════════════════════════════════════════════════ */

test("6: square editorial rectangles, in the brief's exact colours", () => {
  const tiktok = rule(".about-tiktok .about-tiktok-cta{");
  assert.match(tiktok, /background:var\(--cream\)/);
  assert.match(tiktok, /color:var\(--blue\)/);
  assert.match(tiktok, /border:1px solid var\(--cream\)/);
  assert.match(tiktok, /border-radius:0/);
  assert.match(tiktok, /letter-spacing:\.14em/);

  assert.match(rule(".about-final-actions .cta.about-final-primary{"),
    /background:var\(--cream\);color:var\(--plum\);border:1px solid var\(--cream\)/);
  assert.match(rule(".about-final-actions .cta.about-final-secondary{"),
    /background:transparent;color:var\(--cream\);border:1px solid rgba\(245,235,226,\.65\)/);
  const box = rule(".about-final-actions .cta{");
  assert.match(box, /border-radius:0/);
  assert.match(box, /font-size:12px/);
  assert.match(box, /text-transform:uppercase/);

  // The Herkunft CTA is a hairline text link, not a filled button.
  const link = rule(".about-origin-link{");
  assert.match(link, /border-bottom:1px solid rgba\(245,235,226,\.45\)/);
  assert.ok(!/background:/.test(link), "the Herkunft CTA became a filled button");
  assert.ok(!about.includes('className="cta" href="/our-matcha"'));

  // Hovers stay short.
  for (const m of rules.matchAll(/transition:([^;}]+)/g)) {
    assert.ok(!/\d{3,}ms|[3-9]s/.test(m[1]), `a slow transition: ${m[1]}`);
  }
});

/* ══════════════════════════════════════════════════════════════
   7. COPY AND ROUTES
   ══════════════════════════════════════════════════════════════ */

test("7: the authorised copy, and nothing else, changed", () => {
  // The three refinements, verbatim.
  assert.ok(about.includes("Wir mögen Matcha. Nur nicht die Regeln, die manchmal darum gebaut werden."));
  assert.ok(about.includes("GLOA soll unkompliziert funktionieren: im Café, im Büro, unterwegs oder zu Hause."));
  assert.ok(about.includes("Kein Dresscode.<br/>Kein Pflichtprogramm.<br/>Ein gutes Produkt.<br/>Du entscheidest, was du daraus machst."));
  assert.ok(about.includes("Morgens, im Büro, im Café oder unterwegs.<br/>Iced, als Latte oder pur."));
  assert.ok(about.includes("Dein Tag entscheidet, nicht ein Regelwerk."));
  assert.ok(about.includes("Wir bauen GLOA gerade auf:<br/>Produkt, Packaging, Cafés und alles dazwischen."));
  assert.ok(about.includes("Auf TikTok zeigen wir,<br/>was hinter der Marke passiert."));

  // The superseded sentences are gone.
  for (const old of [
    "Wir mögen Matcha, aber nicht die Regeln",
    "GLOA funktioniert überall dort, wo du gerade bist",
    "Und du entscheidest, was du daraus machst",
    "Auf TikTok zeigen wir, was hinter der Marke passiert.</p>",
  ]) {
    assert.ok(!about.includes(old), `superseded copy survived: ${old}`);
  }

  // Everything NOT on the authorised list is untouched.
  for (const kept of [
    "ÜBER GLOA", "Good energy.", "No theatre.",
    "GLOA bringt Matcha aus Shizuoka in einen Alltag, der nicht nach Regeln fragt.",
    "Für Latte, iced, pur oder genau so, wie du ihn magst.",
    "SHIZUOKA / JAPAN", "BERLIN / GERMANY", "EST. 2026",
    "WHY GLOA EXISTS", "Matcha gehört", "nicht in eine", "Schublade.",
    "MATCHA FOR REAL LIFE", "Nicht", "kompliziert.", "Einfach gut.",
    "HERKUNFT", "Unser Matcha kommt aus Shizuoka, Japan: 100 % Bio-Matcha, fein vermahlen.",
    "WAS UNS WICHTIG IST", "Worauf wir", "Wert legen.",
    "BUILDING GLOA", "Schau vorbei,", "während es entsteht.",
    "@gloa.matcha", "Auf TikTok folgen ↗", "BUILDING IN PUBLIC · BERLIN · 2026",
    "Genug über uns.", "Zeit für Matcha.", "Zum Shop", "Unser Matcha →",
  ]) {
    assert.ok(about.includes(kept), `copy went missing: ${kept}`);
  }
  const data = site.slice(site.indexOf("const aboutCares"), site.indexOf("];", site.indexOf("const aboutCares")));
  for (const statement of [
    "Gutes Produkt statt komplizierter Begriffe.",
    "Klare Infos statt erfundenem Prestige.",
    "Matcha, der pur genauso funktioniert wie als Latte.",
  ]) assert.ok(data.includes(statement), `a value statement changed: ${statement}`);
});

test("7b: every destination is the one it was", () => {
  assert.ok(about.includes('className="about-origin-link" href="/our-matcha"'));
  assert.ok(about.includes('className="cta about-final-primary" href="/shop"'));
  assert.ok(about.includes('className="cta about-final-secondary" href="/our-matcha"'));
  assert.equal([...about.matchAll(/href="https:\/\/www\.tiktok\.com\/@gloa\.matcha"/g)].length, 2);
  for (const m of about.matchAll(/href="([^"]+)"/g)) {
    assert.ok(["/our-matcha", "/shop", "https://www.tiktok.com/@gloa.matcha"].includes(m[1]),
      `an unexpected destination: ${m[1]}`);
  }
  // The external links keep target/rel; the internal ones do not have them.
  assert.equal([...about.matchAll(/target="_blank" rel="noopener noreferrer"/g)].length, 2);
  // ↗ for external, → for internal - and no arrow on the primary CTA.
  assert.ok(!/Zum Shop\s*→/.test(about), "an arrow was added to the primary CTA");
});

/* ══════════════════════════════════════════════════════════════
   8. SEMANTICS
   ══════════════════════════════════════════════════════════════ */

test("8: one h1, then h2s, then h3s", () => {
  assert.equal([...about.matchAll(/<h1[ >]/g)].length, 1);
  assert.match(about, /<h1 className="about-hero-headline">/);
  // Five section titles, all h2 - the Herkunft band is a band, so it
  // carries an eyebrow and a sentence and no heading of its own.
  assert.equal([...about.matchAll(/<h2[ >]/g)].length, 5);
  // The three statements are h3 - under the "Worauf wir Wert legen." h2.
  assert.equal([...about.matchAll(/<h3[ >]/g)].length, 1);
  assert.ok(about.includes('<h3 className="about-cares-statement">'));
  assert.ok(!/<h[4-6][ >]/.test(about));
});

/* ══════════════════════════════════════════════════════════════
   9. THE FREEZES
   ══════════════════════════════════════════════════════════════ */

test("9: ticker, nav, footer and the other pages are untouched", () => {
  // The ticker and the navigation live in app/Chrome.tsx, which this
  // pass does not open at all. Their copy, verbatim.
  const chrome = read("app/Chrome.tsx");
  assert.ok(chrome.includes("<span>GLOA · SHIZUOKA, JAPAN</span><span>MATCHA FOR REAL LIFE.</span>"));
  assert.ok(chrome.includes('<Link href="/for-cafes">B2B</Link>'));
  assert.match(chrome, /className="brand-bar"/);
  assert.match(chrome, /className="bb-track"/);
  // The nav, its ÜBER GLOA label and its active state.
  assert.ok(chrome.includes('["/about","Über GLOA"]'));
  assert.match(chrome, /nav-active/);
  assert.match(chrome, /export function Header/);
  assert.match(chrome, /export function Footer/);

  // The About block cannot reach any of them, or any other page: every
  // selector in it is About-scoped. A selector prelude is the run of
  // text between a brace and the next `{`, so declarations - which never
  // reach a `{` before their block closes - cannot match here.
  let preludes = 0;
  for (const m of code.matchAll(/[}{]\s*([^{}@]+?)\s*\{/g)) {
    for (const sel of m[1].split(",")) {
      const s = sel.trim();
      if (!s) continue;
      preludes++;
      assert.ok(/^\.about-/.test(s), `an unscoped selector in the About block: ${s}`);
    }
  }
  assert.ok(preludes > 40, `only ${preludes} selectors were scanned`);
  // The pages the brief freezes still have their own blocks.
  for (const marker of ["/our-matcha PAGE HERO", "/our-matcha FAQ + FINAL CTA",
                        ".home-rail{", ".featured-recipes{"]) {
    assert.ok(css.includes(marker), `a frozen block went missing: ${marker}`);
  }
});

test("9b: nothing outside /about renders the About classes", () => {
  const others = site.replace(about, "");
  for (const cls of ["about-hero", "about-why", "about-real", "about-origin",
                     "about-cares", "about-tiktok", "about-final", "about-handle"]) {
    assert.ok(!others.includes(cls), `${cls} is rendered outside /about`);
  }
});
