import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * THE SHOP LAUNCH HERO, as a source contract.
 *
 * Source-level rather than rendered: the catalog is fetched client-side,
 * so a server render only proves the shell. What matters here is the copy,
 * the type roles, the absence of any product visual, and that the launch
 * band is the SAME countdown the homepage uses rather than a second one.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf8");

const site = read("app/GloaSite.tsx");
const css = read("app/globals.css");

const hero = site.slice(site.indexOf("function ShopHero("), site.indexOf("function Shop({onAdd}"));
const strip = site.slice(site.indexOf("function ShopLaunchStrip()"), site.indexOf("const SHOP_HERO_LEAD"));
const shop = site.slice(site.indexOf("function Shop({onAdd}"), site.indexOf("// -- Product detail ---"));
const block = css.slice(css.indexOf("SHOP LAUNCH HERO"), css.indexOf("SHOP MATCHA PRODUCT SECTION"));
const rules = block.slice(block.indexOf("*/") + 2);
const rule = name => {
  const at = rules.indexOf(name);
  assert.notEqual(at, -1, `missing rule: ${name}`);
  return rules.slice(at, rules.indexOf("}", at));
};

/* ══════════════════════════════════════════════════════════════
   1. THE COPY
   ══════════════════════════════════════════════════════════════ */

test("1: the hero says exactly the approved lines, and no dash", () => {
  assert.ok(hero.includes('<p className="eyebrow shop-hero-eyebrow">GLOA · SHOP</p>'));
  assert.ok(hero.includes('<span className="shop-hero-line">Alles von</span>'));
  assert.ok(hero.includes('<span className="shop-hero-line">GLOA.</span>'));
  assert.ok(hero.includes('<i className="shop-hero-line shop-hero-line-accent">alles was du brauchst.</i>'));
  assert.match(site, /const SHOP_HERO_LEAD=<>Premium Matcha aus Shizuoka, Japan<br\/>und alles, was dazugehört\.<\/>;/);
  assert.ok(hero.includes("LAUNCH AM {GLOA_LAUNCH_LABEL}"));
  assert.ok(hero.includes("PRODUKTE ENTDECKEN"));

  // ── NO DASH, IN EITHER FORM ──────────────────────────────────
  const lead = /const SHOP_HERO_LEAD=([\s\S]*?);/.exec(site)[1];
  for (const dash of ["–", "—", " - "]) {
    assert.ok(!lead.includes(dash), `the supporting copy carries a dash: ${dash}`);
  }
  // And the retired copy is gone from the whole file.
  for (const retired of ["Matcha aus Shizuoka, Japan –", "Launch in Vorbereitung.",
                         "Dein Matcha.", "Deine Art.", "shop-hero-micro"]) {
    assert.ok(!site.includes(retired), `retired shop copy survived: ${retired}`);
  }
  // The date is the launch utility's, never a second literal.
  assert.ok(!hero.includes("01.10.2026"), "the launch date is hard-coded in the hero");
  assert.match(read("lib/launchCountdown.ts"), /GLOA_LAUNCH_LABEL = "01\.10\.2026"/);
});

test("2: the price comes from the catalog, and the CTA still scrolls to the products", () => {
  // No invented commerce: the lowest gross price of the live variants.
  // Computed from what the page actually LISTS, not from the whole
  // catalog: a product withheld from /shop must not set the "ab" price.
  assert.match(shop, /const shown=visibleShopProducts\(products\);/);
  assert.match(shop, /const lowestCents=Math\.min\(\.\.\.shown\.flatMap\(p=>p\.variants\.map\(x=>x\.price_gross_cents\)\)\);/);
  assert.match(shop, /AB \{fmtCents\(lowestCents\)\} €/);
  assert.ok(!/AB 9,99|9\.99|999/.test(hero + shop), "a price was hard-coded");
  // The existing anchor and the existing analytics event, unchanged.
  assert.match(hero, /<Link className="cta shop-hero-cta" href="#product" onClick=\{\(\)=>track\("shop_scroll_product"\)\}>/);
  assert.match(shop, /<section id="product" className="shop-products">/);
});

/* ══════════════════════════════════════════════════════════════
   3. NO PRODUCT VISUAL - AND NO DELETED ASSET
   ══════════════════════════════════════════════════════════════ */

test("3: the hero is type only, and nothing was deleted to make it so", () => {
  for (const banned of ["<img", "backgroundImage", "hero-pack", "hero-tin", "product-visual",
                        "Produkt BILD", "gloa-hero-packaging", "<svg"]) {
    assert.ok(!hero.includes(banned), `the shop hero renders ${banned}`);
  }
  assert.ok(!/\.shop-hero[^{]*\{[^}]*(background-image|url\()/.test(rules),
    "the hero paints a visual through CSS");
  // THE ASSETS ARE UNTOUCHED. The product photography still exists and is
  // still rendered by the cards below the hero.
  for (const asset of ["public/img/Produkt BILD.png", "public/img/gloa-morning.jpg"]) {
    assert.ok(existsSync(path.join(ROOT, asset)), `${asset} was deleted`);
  }
  assert.match(shop, /<ShopProductBlock product=\{p\} onAdd=\{onAdd\}\/>/);
  assert.match(shop, /\{p\.slug===MATCHA_SLUG&&<MatchaShopDetails product=\{p\}\/>\}/);
  // The anti-newsletter band is deliberately NOT part of the shop
  // composition any more - tests/shop-render.test.mjs owns that contract
  // and proves the component and its other two pages are untouched.
  assert.ok(!shop.includes("<BrandNote/>"), "the band came back to /shop");
});

/* ══════════════════════════════════════════════════════════════
   4. ONE COUNTDOWN, BELOW THE HERO
   ══════════════════════════════════════════════════════════════ */

test("4: the launch band reuses the existing countdown and sits under the hero", () => {
  // ── THE SAME CLOCK, THE SAME ARITHMETIC, THE SAME INSTANT ────
  assert.match(strip, /useSyncExternalStore\(clockStore\.subscribe,clockStore\.getSnapshot,clockStore\.getServerSnapshot\)/);
  assert.match(strip, /launchCountdown\(now\)/);
  assert.match(strip, /padCountdownUnit\(value\)/);
  assert.match(strip, /\{GLOA_LAUNCH_LABEL\}/);
  assert.ok(!/new Date\(|Date\.now\(\)|setInterval|setTimeout/.test(strip),
    "the strip started a clock of its own");
  assert.equal([...site.matchAll(/const clockStore=/g)].length, 1, "a second clock appeared");
  assert.equal([...site.matchAll(/function launchCountdown/g)].length, 0, "the arithmetic was copied");
  // Seconds are shown, and the launched state is the homepage's own copy.
  assert.match(strip, /\["Sekunden",state\?\.seconds\]/);
  assert.match(strip, /state\?\.launched\?"GLOA is here":"GLOA is coming"/);
  const home = site.slice(site.indexOf("function LaunchCountdown()"), site.indexOf("function ShopLaunchStrip()"));
  assert.ok(home.includes('"GLOA is here":"GLOA is coming"'), "the two bands disagree about the launched copy");
  // No negative countdown: the utility clamps, and this file does no maths.
  assert.match(read("lib/launchCountdown.ts"), /Math\.max\(0/);

  // ── EXACTLY ONE BAND, AND IT IS BELOW THE HERO ───────────────
  // Twice: once in the shell the loading/error/empty states share, once
  // in the full page. Every state gets a band, and no state gets two.
  assert.equal([...shop.matchAll(/<ShopLaunchStrip\/>/g)].length, 2, "the band count changed");
  // Every band is immediately preceded by a hero, with nothing
  // between them.
  for (const m of shop.matchAll(/<ShopLaunchStrip\/>/g)) {
    const before = shop.slice(0, m.index).trimEnd();
    assert.ok(before.endsWith("/>") && before.lastIndexOf("<ShopHero ") > before.lastIndexOf("</section>"),
      "a band is not directly under its hero");
  }
  assert.ok(shop.indexOf("<ShopHero") < shop.indexOf("<ShopLaunchStrip/>"), "the band is above the hero");
  assert.ok(shop.indexOf("<ShopLaunchStrip/>") < shop.indexOf('id="product"'), "the band is below the products");
  // NOTHING blue was added above the navigation: the chrome is untouched.
  const chrome = read("app/Chrome.tsx");
  assert.ok(!chrome.includes("Countdown") && !chrome.includes("countdown"),
    "a countdown was added to the site chrome");
  assert.ok(!chrome.includes("shop-strip"), "the launch band leaked into the chrome");
});

/* ══════════════════════════════════════════════════════════════
   5. TYPE, COLOUR AND THE RAIL
   ══════════════════════════════════════════════════════════════ */

test("5: two families, cream on raspberry, and smaller than the homepage hero", () => {
  // ── THE HOMEPAGE HERO STAYS THE CEILING ──────────────────────
  // Sampled across the breakpoints and the two bends in the homepage
  // hero's own curve; clamp() is monotonic, so this covers the range.
  const clamp = (lo, mid, hi) => Math.max(lo, Math.min(mid, hi));
  const parse = t => /clamp\(([\d.]+)px,([\d.]+)vw,([\d.]+)px\)/.exec(t).slice(1).map(Number);
  // The two page heroes share one role, so the curve lives in a token.
  assert.match(rules, /\.shop-hero-line\{[\s\S]*?font-size:var\(--type-page-hero\)/);
  assert.match(rules, /\.shop-hero-line-accent\{[\s\S]*?font-size:var\(--type-page-hero-accent\)/);
  const token = n => new RegExp("--type-" + n + ":([^;]+);").exec(css)[1];
  const [sLo, sVw, sHi] = parse(token("page-hero"));
  const [aLo, aVw, aHi] = parse(token("page-hero-accent"));
  const homeTitle = w => (w <= 900 ? clamp(44, 0.12 * w, 64) : clamp(54, 0.059 * w, 100));
  for (const w of [320, 390, 430, 640, 900, 901, 1024, 1085, 1280, 1440, 1536, 1680, 1920, 2560]) {
    const shopTitle = clamp(sLo, (sVw / 100) * w, sHi);
    const shopAccent = clamp(aLo, (aVw / 100) * w, aHi);
    assert.ok(homeTitle(w) > shopTitle, `the shop hero outgrows the homepage hero at ${w}px`);
    assert.ok(homeTitle(w) > shopAccent, `the shop accent outgrows the homepage hero at ${w}px`);
  }
  assert.ok(sHi <= 100 && sHi >= 62, "the shop headline left its intended band");

  // ── TWO FAMILIES, AND THE ITALIC IS THE DISPLAY ONE ──────────
  assert.match(rule(".shop-hero-line{"), /font-family:var\(--font-sans\)/);
  assert.match(rule(".shop-hero-line{"), /font-weight:800/);
  const accent = rule(".shop-hero-line-accent{");
  assert.match(accent, /font-family:var\(--font-display\)/);
  assert.match(accent, /font-style:italic/);
  assert.match(accent, /font-weight:400/);
  for (const m of rules.matchAll(/font-family:([^;}]+)/g)) {
    assert.match(m[1], /^var\(--font-(sans|display)\)/, `a third family: ${m[1]}`);
  }
  // The small roles read the page's shared meta token.
  for (const name of [".shop-hero-eyebrow{", ".shop-hero-meta{", ".shop-hero .shop-hero-cta{"]) {
    assert.match(rule(name), /font-size:var\(--type-meta\)/, `${name} is not on the meta scale`);
  }
  assert.match(rule(".shop-hero-lead{"), /font-size:var\(--type-body\)/);
  assert.match(rule(".shop-hero-price{"), /font-weight:700/);

  // ── THE COLOUR CONTRACT ──────────────────────────────────────
  assert.match(rules, /\.shop-hero\{[\s\S]*?background:var\(--berry\)/);
  assert.match(rules, /\.shop-strip\{[\s\S]*?background:var\(--blue\)/);
  const cta = rule(".shop-hero .shop-hero-cta{");
  assert.match(cta, /background:var\(--cream\)/);
  assert.match(cta, /color:var\(--berry\)/);
  assert.match(cta, /border-radius:0/);
  assert.match(cta, /box-shadow:none/);
  for (const banned of ["gradient", "backdrop-filter", "var(--plum)", "var(--matcha)"]) {
    assert.ok(!rules.includes(banned), `the shop hero uses ${banned}`);
  }
  // The retired hero, which ran BIGGER than the homepage one, is gone.
  // The retired rule was `.shop-hero h1`; the same clamp still serves
  // `.hero h1,.inner h1` on the other routes and is not this pass's business.
  assert.ok(!/\.shop-hero h1\{/.test(css), "the 122px shop headline rule survived");
  assert.ok(!/\.shop-hero[^{]*\{[^}]*clamp\(64px,8vw,122px\)/.test(css), "the 122px scale is back on the shop hero");
  assert.ok(!css.includes(".shop-hero-micro"), "the retired micro line's rule survived");

  // ── THE RAIL, AND A CONTENT-DRIVEN HEIGHT ────────────────────
  assert.match(hero, /<div className="shop-hero-inner home-rail">/);
  assert.match(strip, /<div className="shop-strip-inner home-rail">/);
  assert.ok(!rules.includes("100vh"), "the hero reserves a viewport");
  assert.ok(!/\.shop-hero\{[^}]*min-height/.test(rules), "the hero has a fixed height");
  // The band is a ticker, not a section: one row, compact padding.
  assert.match(rules, /\.shop-strip\{[\s\S]*?padding-block:clamp\(20px,2vw,26px\)/);
  assert.match(rules, /\.shop-strip-inner\{[\s\S]*?display:flex/);
});
