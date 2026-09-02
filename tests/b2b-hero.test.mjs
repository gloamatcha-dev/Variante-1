import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * /for-cafes PAGE HERO — VARIANT 2.
 *
 * The pass replaced a blue 700px-min-height split carrying a 140px h1,
 * a CSS-drawn "tin" and a second CTA pointing at #calculator with a plum
 * hero that reads the page-hero role the rest of the site carries.
 *
 * These tests pin the copy contract, the single product image, the
 * removed CTA, the fact that the calculator code was NOT touched, and
 * the type hierarchy. They are not pixel tests: paddings and gaps may
 * move, the ROLES may not.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf8");

const site = read("app/GloaSite.tsx");
const css = read("app/globals.css");

const hero = site.slice(site.indexOf('<section className="b2b-hero"'),
                        site.indexOf('<section className="b2b-facts">'));
assert.ok(hero.length > 400, "the B2B hero markup was not found");

const blockAt = css.indexOf("/for-cafes PAGE HERO");
assert.notEqual(blockAt, -1, "the B2B hero CSS block was not found");
// Bounded at the NEXT page block. Without an end this slice runs to the
// end of the file and silently absorbs whatever is appended after it.
const rules = css.slice(css.lastIndexOf("/*", blockAt), css.lastIndexOf("/*", css.indexOf("INFO STRIP + MENU SECTION")));
/* The block opens with a long comment describing what the hero USED to
   be; every structural check reads the comment-free view so that prose
   can never satisfy an assertion. */
const code = rules.replace(/\/\*[\s\S]*?\*\//g, "");

const rule = name => {
  const at = code.indexOf(name);
  assert.notEqual(at, -1, `missing rule: ${name}`);
  return code.slice(at, code.indexOf("}", at));
};

/* ══════════════════════════════════════════════════════════════
   1. THE COPY CONTRACT
   ══════════════════════════════════════════════════════════════ */

test("1: the hero says exactly what it is supposed to say", () => {
  for (const line of [
    "GLOA FOR BUSINESS",
    "Dein Matcha.",
    "Dein Signature-Drink.",
    "Matcha aus Shizuoka für moderne Menüs.",
    "Sample anfragen",
  ]) assert.ok(hero.includes(line), `missing hero copy: ${line}`);

  // The four audiences, from one list.
  const data = site.slice(site.indexOf("const b2bAudience"), site.indexOf("];", site.indexOf("const b2bAudience")));
  for (const label of ["CAFÉS", "RESTAURANTS", "HOTELS", "OFFICES"]) {
    assert.ok(data.includes(`"${label}"`), `missing audience: ${label}`);
  }
  assert.equal([...data.matchAll(/^\["/gm)].length, 4, "the audience list is not four rows");

  // The old headline is gone from the hero.
  assert.ok(!hero.includes("Matcha for"), "the old headline survived");
  assert.ok(!hero.includes("your menu."), "the old headline survived");

  // And none of the claims the brief bans were introduced.
  for (const banned of ["Commercial", "Premium", "Wholesale", "Großhandel",
                        "100 %", "Bio", "MOQ", "Lieferzeit", "€"]) {
    assert.ok(!hero.includes(banned), `the hero grew a claim: ${banned}`);
  }
  // No variant number from the concept preview.
  assert.ok(!/>0\d</.test(hero), "a variant number is rendered");
});

/* ══════════════════════════════════════════════════════════════
   2. THE REMOVED CTA - AND THE CALCULATOR THAT STAYED
   ══════════════════════════════════════════════════════════════ */

test("2: the Umsatzpotenzial CTA is gone from the hero, not hidden", () => {
  assert.ok(!hero.includes("Umsatzpotenzial"), "the CTA copy survived in the hero");
  assert.ok(!hero.includes("#calculator"), "the hero still links to #calculator");
  // Not hidden - actually absent from the whole page component.
  const page = site.slice(site.indexOf("function ForCafes()"), site.indexOf("\nfunction BusinessFaq()"));
  assert.ok(!page.includes("Umsatzpotenzial"));
  assert.ok(!/opacity:0|visibility:hidden|display:none/.test(rule(".b2b-hero{")));
  // Exactly one link in the hero.
  assert.equal([...hero.matchAll(/<Link /g)].length, 1, "the hero has more than one CTA");
});

test("2b: the calculator code was not touched", () => {
  // The live calculator lives in the authenticated business account and
  // is not on /for-cafes at all - the hero's #calculator anchor had
  // already been archived before this pass, so removing that button also
  // removed a dead link.
  const calc = read("app/B2bCalculator.tsx");
  assert.match(calc, /export function B2bCalculator\(/);
  assert.match(read("app/AccountPortal.tsx"), /<B2bCalculator models=\{models\} sizes=\{sizes\} \/>/);
  assert.ok(read("lib/b2bCalculator.ts").length > 0, "the calculator library went missing");
  // The archive note that records where the public section went is still
  // there, so the history is not lost.
  assert.match(read("app/BusinessCalculator.tsx"), /ARCHIVIERT: Calculator Section \(id="calculator"\)/);
  // And nothing anywhere renders an id="calculator" that the hero could
  // have been pointing at.
  assert.ok(!/id="calculator"/.test(site), "an unlinked calculator anchor exists on the page");
});

test("2c: the sections below the hero are untouched", () => {
  const page = site.slice(site.indexOf("function ForCafes()"), site.indexOf("\nfunction BusinessFaq()"));
  // The strip and the menu section below the hero were redesigned in
  // their own pass - see tests/b2b-menu-section.test.mjs. What this test
  // guards is that the HERO pass did not reach past them.
  for (const marker of ['<section className="b2b-facts">', '<section className="b2b-menu">',
                        "<BusinessCalculator/>", "<BusinessFaq/>",
                        "Einfach zubereitet.", "BEISPIELRECHNUNG"]) {
    assert.ok(page.includes(marker), `a section below the hero changed: ${marker}`);
  }
  // The strip facts live in their own const above ForCafes.
  assert.match(site, /const b2bFacts=\["SHIZUOKA, JAPAN"/);
});

/* ══════════════════════════════════════════════════════════════
   3. ONE PRODUCT IMAGE, THE AUDITED ONE, UNMODIFIED
   ══════════════════════════════════════════════════════════════ */

test("3: exactly one image, and it is the B2B Packung asset", () => {
  const imgs = [...hero.matchAll(/<img [^>]*src="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(imgs, ["/img/B2B Packung.png"]);
  assert.match(hero, /alt="GLOA Matcha B2B Packung"/);

  // The file on disk is the one that was audited, byte for byte.
  const bytes = readFileSync(path.join(ROOT, "public/img/B2B Packung.png"));
  assert.equal(statSync(path.join(ROOT, "public/img/B2B Packung.png")).size, 1075497);
  assert.equal(createHash("md5").update(bytes).digest("hex"), "1f2a24309867e53a322e7f351d323a97");
  // A real RGBA PNG at the dimensions the crop maths assumes.
  assert.equal(bytes.slice(1, 4).toString(), "PNG");
  assert.equal(bytes.readUInt32BE(16), 1448);
  assert.equal(bytes.readUInt32BE(20), 1086);
  assert.equal(bytes[25], 6, "the asset lost its alpha channel");

  // No other product visual came with it.
  for (const other of ["hero-tin", "Placeholder", "Produkt BILD", "Produkt Bild",
                       "gloa-work", "gloa-hero-packaging", "Header.png"]) {
    assert.ok(!hero.includes(other), `a second product visual: ${other}`);
  }
  // The CSS tin and its Placeholder chip are gone from the whole app.
  assert.ok(!site.includes("hero-tin") && !css.includes(".hero-tin"), "the CSS tin survived");
  assert.ok(!site.includes("Placeholder") && !css.includes(".placeholder-label"),
    "the Placeholder chip survived");
});

test("3b: the crop is CSS, and the baked shadow is the only shadow", () => {
  // The pouch is 729x1448 of the canvas, so the artwork is cropped to
  // its own bounding box by percentages rather than by editing the file.
  const pack = rule(".b2b-hero-pack{");
  assert.match(pack, /overflow:hidden/);
  assert.match(pack, /aspect-ratio:882 \/ 1000/);
  const img = rule(".b2b-hero-pack img{");
  assert.match(img, /width:calc\(100% \* 1448 \/ 882\)/);
  assert.match(img, /left:calc\(100% \* -288 \/ 882\)/);
  assert.match(img, /top:calc\(100% \* -35 \/ 1000\)/);
  // Preflight would otherwise clamp that 164% back to the box width.
  assert.match(img, /max-width:none/);

  // NOT ONE extra shadow anywhere in the block - the PNG carries its own.
  assert.ok(!/box-shadow:(?!none)/.test(code), "a box-shadow was added");
  assert.ok(!/filter:/.test(code), "a filter was added");
  assert.ok(!/drop-shadow/.test(code), "a drop-shadow was added");
  assert.ok(!/::(before|after)/.test(code), "a pseudo-element was added");
});

test("3c: the pedestal is a flat CSS ellipse, not an image", () => {
  const ped = rule(".b2b-hero-pedestal{");
  assert.match(ped, /background:rgba\(17,17,17,\.10\)/);
  assert.match(ped, /border-radius:50%/);
  assert.match(ped, /width:calc\(var\(--pack\) \* 1\.4\)/);
  assert.match(ped, /height:calc\(var\(--pack\) \* \.33\)/);
  assert.ok(!/url\(|image/.test(ped), "the pedestal became an image");
  assert.match(hero, /<span className="b2b-hero-pedestal" aria-hidden="true"\/>/);
});

/* ══════════════════════════════════════════════════════════════
   4. COLOUR
   ══════════════════════════════════════════════════════════════ */

test("4: flat plum, cream type, no new colour and no gradient", () => {
  assert.match(rule(".b2b-hero{"), /background:var\(--plum\)/);
  assert.match(rule(".b2b-hero{"), /color:var\(--cream\)/);
  assert.match(css, /--plum:#4F3A5B;/);
  assert.match(css, /--cream:#F5EBE2;/);
  // No literal hex and no non-brand rgba anywhere in the block.
  for (const m of code.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
    assert.fail(`a literal hex colour: ${m[0]}`);
  }
  for (const m of code.matchAll(/rgba\(([^)]+)\)/g)) {
    const [r, g, b] = m[1].split(",").map(n => Number(n.trim()));
    const cream = r === 245 && g === 235 && b === 226;
    const ink = r === 17 && g === 17 && b === 17;
    assert.ok(cream || ink, `a non-brand rgba: rgba(${m[1]})`);
  }
  for (const banned of ["gradient", "backdrop-filter", "var(--blue)", "var(--berry)"]) {
    assert.ok(!code.includes(banned), `the hero grew ${banned}`);
  }
  // Square, never a pill, and no cards.
  for (const m of code.matchAll(/border-radius:([^;}]+)/g)) {
    assert.ok(["0", "50%"].includes(m[1].trim()), `an unexpected radius: ${m[1]}`);
  }
});

/* ══════════════════════════════════════════════════════════════
   5. TYPOGRAPHY - THE PAGE-HERO ROLE, NOT A NEW ONE
   ══════════════════════════════════════════════════════════════ */

const clampAt = (t, w) => {
  const [lo, vw, hi] = /clamp\(([\d.]+)px,([\d.]+)vw,([\d.]+)px\)/.exec(t).slice(1).map(Number);
  return Math.max(lo, Math.min((vw / 100) * w, hi));
};
const homepageHero = w => (w <= 900 ? Math.max(44, Math.min(0.12 * w, 64)) : Math.max(54, Math.min(0.059 * w, 100)));

test("5: two families only, at the sizes the contract names", () => {
  for (const m of code.matchAll(/font-family:([^;}]+)/g)) {
    assert.match(m[1], /^var\(--font-(sans|display)\)/, `a third family: ${m[1]}`);
  }
  for (const m of code.matchAll(/font-family:var\(--font-display\),([^;}]+)/g)) {
    assert.equal(m[1].trim(), "Georgia,serif");
  }
  assert.ok(!code.includes("@font-face") && !code.includes("@import"), "the hero loads a font");

  assert.match(rule(".b2b-hero .b2b-hero-eyebrow{"), /font-size:var\(--type-meta\)/);
  assert.match(css, /--type-meta:11px/);
  assert.match(rule(".b2b-hero .b2b-hero-eyebrow{"), /letter-spacing:\.2em/);
  assert.match(rule(".b2b-hero .b2b-hero-lead{"), /font-size:clamp\(16px,1\.3vw,17px\)/);
  assert.match(rule(".b2b-hero-audience span{"), /font-size:11px/);

  // THE TWO HEADLINE LINES ARE NO LONGER SET HERE. The homepage is the
  // typography master for every true page hero, so both lines read the
  // shared classes and this block keeps only their colour and spacing.
  // The contract itself lives in tests/page-hero-typography.test.mjs.
  //
  // That also retires this hero's Cormorant second line: the homepage
  // sets "Is for everyone." in Inter italic, and so does this one now.
  assert.ok(hero.includes('className="b2b-hero-line gloa-hero-primary"'),
    "the hero sans line does not read the shared scale");
  assert.ok(hero.includes('className="b2b-hero-line b2b-hero-line-accent gloa-hero-secondary"'),
    "the hero italic line does not read the shared scale");
  for (const sel of [".b2b-hero .b2b-hero-line{", ".b2b-hero .b2b-hero-line-accent{"]) {
    const at = code.indexOf(sel);
    if (at === -1) continue;
    const body = code.slice(at + sel.length, code.indexOf("}", at));
    for (const prop of ["font-size", "font-family", "font-weight", "font-style", "letter-spacing", "line-height"]) {
      assert.ok(!body.includes(prop), `the hero still sets ${prop} of its own: ${sel}`);
    }
  }
});

test("5b: this hero IS the homepage hero, at any width", () => {
  // It no longer sits under the homepage hero - it reads the same two
  // tokens, so the curves are identical by construction. What is worth
  // checking is that the shared scale still behaves like a page hero
  // here: the italic under the sans, and never down at section scale.
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const tok = (name, w) => {
    const all = bare.split(name + ":").slice(1).map((t) => t.slice(0, t.indexOf(")") + 1));
    assert.equal(all.length, 2, `${name} is not declared exactly twice`);
    return all[w <= 900 ? 1 : 0];
  };
  for (const w of [320, 360, 390, 430, 480, 640, 768, 900, 901, 1024, 1200, 1280, 1440, 1536, 1680, 1920]) {
    const sans = clampAt(tok("--type-hero-primary", w), w);
    const ital = clampAt(tok("--type-hero-secondary", w), w);
    assert.ok(Math.abs(sans - homepageHero(w)) < 1e-6,
      `the B2B hero (${sans}) is not the homepage hero (${homepageHero(w)}) at ${w}px`);
    assert.ok(ital < sans, `the italic outgrew the sans at ${w}px`);
    // And it stays a page hero, never a section headline: comfortably
    // above the 60px section cap the finished pages use.
    if (w >= 1440) assert.ok(sans > 60, `the page hero fell to section scale at ${w}px`);
  }
  // The 140px h1 that used to be here is gone from the file.
  assert.ok(!css.includes("clamp(70px,9vw,140px)"), "the 140px B2B h1 survived");
});

/* ══════════════════════════════════════════════════════════════
   6. STRUCTURE, RAIL AND SEMANTICS
   ══════════════════════════════════════════════════════════════ */

test("6: on the canonical rail, three columns, content-driven height", () => {
  assert.ok(hero.includes('className="b2b-hero-inner home-rail"'), "the hero is off the shared rail");
  assert.match(rule(".b2b-hero{"), /padding-inline:var\(--rail-gutter\)/);
  assert.match(rule(".b2b-hero{"), /padding-block:clamp\(76px,7vw,108px\)/);
  assert.match(rule(".b2b-hero-inner{"),
    /grid-template-columns:minmax\(0,1\.05fr\) minmax\(300px,\.64fr\) minmax\(160px,\.26fr\)/);
  assert.match(rule(".b2b-hero-inner{"), /align-items:center/);
  // Nothing reserves layout height any more - the 700px min-height is
  // gone. The only survivor is the CTA's 54px box, which is a tap
  // target, not a hero height.
  for (const m of code.matchAll(/min-height:([^;}]+)/g)) {
    assert.equal(m[1].trim(), "54px", `a layout min-height came back: ${m[1]}`);
  }
  assert.ok(!/min-height/.test(rule(".b2b-hero{")), "the section reserves height");
  assert.ok(!/\dvh/.test(code), "a viewport height came back");
  // The legacy `.b2b-hero{...min-height:700px}` is gone. (`.pdp-hero`
  // still carries its own 700px - that is the product page, frozen.)
  assert.ok(!/\.b2b-hero\{[^}]*min-height/.test(css), "the legacy 700px B2B hero survived");
  assert.match(css, /\.pdp-hero\{[^}]*min-height:700px\}/, "the product hero was collaterally edited");
  // The legacy descendant selectors are gone - they would have matched
  // the new .b2b-hero-inner as `> div:first-child` and re-added 100px 5vw.
  assert.ok(!css.includes(".b2b-hero>div:first-child"), "a legacy descendant rule survived");
  assert.ok(!css.includes(".b2b-visual"), "the old visual column survived");
});

test("6b: one h1, decorative icons, and the audiences are not fake links", () => {
  assert.equal([...hero.matchAll(/<h1[ >]/g)].length, 1);
  assert.match(hero, /<h1 className="b2b-hero-headline">/);
  assert.ok(!/<h[2-6][ >]/.test(hero), "the hero grew a second heading level");
  // Four decorative icons, one path each, no library.
  assert.equal([...hero.matchAll(/<svg /g)].length, 1, "the icons are not rendered from one template");
  assert.match(hero, /aria-hidden="true"/);
  assert.match(hero, /focusable="false"/);
  assert.match(hero, /stroke="currentColor"/);
  assert.match(hero, /fill="none"/);
  assert.ok(!/react-icons|lucide|@heroicons|font-awesome/.test(site), "an icon library was added");
  // Information, not navigation: the list holds no anchors.
  const list = hero.slice(hero.indexOf("b2b-hero-audience"));
  assert.ok(!/<a |<Link /.test(list), "the audience list became fake navigation");
  assert.match(hero, /<ul className="b2b-hero-audience">/);
});

test("6c: the Sample CTA keeps its route, its tracking and its box", () => {
  assert.match(hero, /href="\?intent=sample#lead"/);
  assert.match(hero, /onClick=\{\(\)=>track\("sample_request_start"\)\}/);
  const cta = rule(".b2b-hero .b2b-hero-cta{");
  assert.match(cta, /background:var\(--cream\)/);
  assert.match(cta, /color:var\(--plum\)/);
  assert.match(cta, /border:1px solid var\(--cream\)/);
  assert.match(cta, /border-radius:0/);
  assert.match(cta, /min-height:54px/);
  assert.match(cta, /text-transform:uppercase/);
  assert.match(cta, /letter-spacing:\.15em/);
  const hover = rule(".b2b-hero .b2b-hero-cta:hover{");
  assert.match(hover, /background:transparent/);
  assert.match(hover, /color:var\(--cream\)/);
  for (const m of code.matchAll(/transition:([^;}]+)/g)) {
    assert.ok(!/\d{3,}ms|[3-9]s/.test(m[1]), `a slow transition: ${m[1]}`);
  }
});

/* ══════════════════════════════════════════════════════════════
   7. RESPONSIVE, AND THE FREEZES
   ══════════════════════════════════════════════════════════════ */

test("7: tablet drops to two columns, mobile to one", () => {
  const tablet = code.slice(code.indexOf("@media (max-width:1200px)"), code.indexOf("@media (max-width:900px)"));
  assert.match(tablet, /grid-template-columns:minmax\(0,1fr\) minmax\(260px,\.72fr\)/);
  assert.match(tablet, /grid-column:1 \/ -1/);
  const mob = code.slice(code.indexOf("@media (max-width:900px)"));
  assert.match(mob, /\.b2b-hero-inner\{grid-template-columns:1fr/);
  assert.match(mob, /--pack:min\(72vw,300px\)/);
  assert.match(mob, /grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  // Source order IS the mobile order: copy, product, audiences.
  assert.ok(hero.indexOf("b2b-hero-copy") < hero.indexOf("b2b-hero-product"));
  assert.ok(hero.indexOf("b2b-hero-product") < hero.indexOf("b2b-hero-audience"));
});

test("7b: every selector is hero-scoped, and no other page moved", () => {
  let n = 0;
  for (const m of code.matchAll(/[}{]\s*([^{}@]+?)\s*\{/g)) {
    for (const sel of m[1].split(",")) {
      const s = sel.trim();
      if (!s) continue;
      n++;
      assert.ok(/^\.b2b-hero/.test(s), `an unscoped selector in the B2B hero block: ${s}`);
    }
  }
  assert.ok(n > 15, `only ${n} selectors were scanned`);
  // The italic rule the sections BELOW the hero share is still intact.
  // The hero italic left this list when every page hero moved to the
  // shared homepage scale (Inter italic, not Cormorant). The list is
  // otherwise untouched and still serves its three h2 consumers.
  assert.match(css, /\.behind-bar h2 i,\.business-support h2 i,\.faq h2 i\{/);
  // The other finished pages still have their own blocks.
  for (const marker of ["/about — ONE EDITORIAL SYSTEM", "/our-matcha PAGE HERO",
                        "/our-matcha FAQ + FINAL CTA", ".home-rail{"]) {
    assert.ok(css.includes(marker), `a frozen block went missing: ${marker}`);
  }
  // Ticker and navigation are in Chrome.tsx, which this pass never opens.
  const chrome = read("app/Chrome.tsx");
  assert.ok(chrome.includes("<span>GLOA · SHIZUOKA, JAPAN</span><span>MATCHA FOR REAL LIFE.</span>"));
  assert.ok(chrome.includes('["/for-cafes","B2B"]'));
});
