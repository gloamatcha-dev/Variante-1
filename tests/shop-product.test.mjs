import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * THE /shop MATCHA PRODUCT SECTION, as a source contract.
 *
 * Source-level rather than rendered: the catalog is fetched client-side,
 * so a server render only ever produces the shell. What matters here is
 * which products the page LISTS, which image it shows for the matcha,
 * that prices and variants still come from the catalog rather than from
 * this file, and that hiding the metal case removed none of it.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf8");

const site = read("app/GloaSite.tsx");
const css = read("app/globals.css");

const block = site.slice(site.indexOf("function ShopProductBlock("), site.indexOf("function MatchaShopDetails("));
const details = site.slice(site.indexOf("function MatchaShopDetails("), site.indexOf("/** Replaces the newsletter signup"));
const shop = site.slice(site.indexOf("function Shop({onAdd}"), site.indexOf("// -- Product detail ---"));
const rules = css.slice(css.indexOf("SHOP MATCHA PRODUCT SECTION"), css.indexOf("/our-matcha PAGE HERO"));
const rule = name => {
  const at = rules.indexOf(name);
  assert.notEqual(at, -1, `missing rule: ${name}`);
  return rules.slice(at, rules.indexOf("}", at));
};

/* ══════════════════════════════════════════════════════════════
   1. WHAT THE PAGE LISTS
   ══════════════════════════════════════════════════════════════ */

test("1: only the matcha is listed, and the case is hidden rather than removed", () => {
  // ONE named list decides, and it is the only thing to edit to bring
  // the case back.
  assert.match(site, /const SHOP_HIDDEN_SLUGS=Object\.freeze\(\["metal-case"\]\);/);
  assert.match(site, /const visibleShopProducts=\(products:CatalogProduct\[\]\)=>products\.filter\(p=>!SHOP_HIDDEN_SLUGS\.includes\(p\.slug\)\);/);
  // Both the section AND the hero's "ab" price read the filtered list,
  // so the page cannot quote a price for something it does not show.
  assert.match(shop, /const shown=visibleShopProducts\(products\);/);
  assert.match(shop, /const lowestCents=Math\.min\(\.\.\.shown\.flatMap/);
  assert.match(shop, /\{shown\.map\(p=>/);
  assert.ok(!/\{products\.map\(/.test(shop), "the section still renders the whole catalog");

  // ── NOTHING OF THE CASE WAS DELETED ──────────────────────────
  assert.match(read("lib/productPresentation.ts"), /MATCHA_NOT_INCLUDED_SLUGS = Object\.freeze\(\["metal-case"\]\)/);
  assert.match(read("lib/tax.ts"), /"metal-case":/);
  assert.ok(existsSync(path.join(ROOT, "supabase/migrations/020_standalone_metal_case.sql")));
  assert.match(css, /\.shop-column\[id\$="metal-case"\]/, "the case's own presentation rule was removed");
  // Its notice is still wired into the block that would render it.
  assert.match(block, /presentation\.matchaNotIncludedNotice&&<p className="product-not-included">/);
  // And the generic route still exists for /shop/metal-case.
  assert.match(site, /function AccessoryProductPage/);
});

/* ══════════════════════════════════════════════════════════════
   2. THE IMAGE
   ══════════════════════════════════════════════════════════════ */

test("2: the matcha shows exactly the approved file, unmodified", () => {
  assert.match(site, /\[MATCHA_SLUG\]:\{src:"\/img\/Produkt Bild \(2\)\.png",alt:"Grünes Matcha-Pulver"\}/);
  assert.ok(existsSync(path.join(ROOT, "public/img/Produkt Bild (2).png")), "the approved image is missing");
  assert.ok(statSync(path.join(ROOT, "public/img/Produkt Bild (2).png")).size > 0);
  // NOT the pouch, NOT the header, NOT an automatically chosen asset.
  assert.ok(!block.includes("Produkt BILD.png"), "the shop section renders the pouch");
  assert.ok(!block.includes("Header.png"), "the shop section renders the hero image");
  // The shared presentation map is untouched: the cart line, the card
  // and the product page still resolve their own image.
  assert.match(block, /getProductImage\(product\)/);
  assert.ok(!read("lib/productPresentation.ts").includes("Produkt Bild (2)"),
    "the shared presentation map was changed for one page's sake");

  // ── CONTAINED, AND SMALL ─────────────────────────────────────
  const visual = rule(".shop-product-visual{");
  assert.match(visual, /width:min\(100%,320px\)/);
  assert.match(rules, /\.shop-product-visual img\{[\s\S]*?object-fit:contain/);
  for (const banned of ["box-shadow:0", "border-radius:8", "filter:", "transform:scale"]) {
    assert.ok(!visual.includes(banned), `the image got ${banned}`);
  }
  // The retired treatment - a berry-filled 5:4 cover crop - is gone.
  assert.ok(!css.includes(".shop-product-image{background:var(--berry)"), "the old image panel survived");
});

/* ══════════════════════════════════════════════════════════════
   3. COMMERCE STAYS THE AUTHORITY
   ══════════════════════════════════════════════════════════════ */

test("3: variants, price and base price still come from the catalog", () => {
  // Three sizes, from the product's own variant list.
  assert.match(site, /product\.variants\.map\(\(mv,i\)=>/);
  assert.match(site, /<span className="size-option-size">\{mv\.label\}<\/span>/);
  assert.match(site, /<span className="size-option-price">\{fmtCents\(mv\.price_gross_cents\)\} €<\/span>/);
  // Selecting one moves BOTH numbers, because both derive from the same
  // selected variant rather than from anything stored twice.
  assert.match(block, /const safe=Math\.min\(idx,product\.variants\.length-1\);/);
  assert.match(block, /const v=product\.variants\[safe\];/);
  assert.match(block, /const per100=showsUnitPricePer100g\(v\)\?per100gCents\(v\.price_gross_cents,v\.size_grams as number\):null;/);
  assert.match(block, /<p className="shop-product-price">\{fmtCents\(v\.price_gross_cents\)\} €<\/p>/);
  assert.match(block, /\{fmtCents\(per100\)\} € \/ 100 g/);
  // No price, size or per-100g figure is written into this file.
  for (const literal of ["19,99", "29,99", "54,99", "66,63", "30 g\"", "50 g\"", "100 g\""]) {
    assert.ok(!block.includes(literal), `a commerce value was hard-coded: ${literal}`);
  }
  // The launch CTA's behaviour is untouched.
  assert.match(block, /onClick=\{SHOP_STATUS==="prelaunch"\?\(\)=>window\.location\.href="\/contact":handleAdd\}/);
  assert.match(block, /SHOP_STATUS==="prelaunch"\?"Fragen zum Launch":"In den Warenkorb"/);
  assert.match(read("app/content.ts"), /export const SHOP_STATUS = "prelaunch"/);
  // The hero's anchor still lands on the section.
  assert.match(shop, /<section id="product" className="shop-products">/);
});

/* ══════════════════════════════════════════════════════════════
   4. THE ACCORDIONS
   ══════════════════════════════════════════════════════════════ */

test("4: four rows, native disclosure, and no mandatory line lost", () => {
  const titles = [...details.matchAll(/<summary><span>([^<]+)<\/span>/g)].map(m => m[1]);
  assert.deepEqual(titles, ["Produktdetails &amp; Pflichtangaben", "Zutaten", "Zubereitung", "Versand &amp; Lieferung"]);
  // NATIVE <details>/<summary>: keyboard reachable and correctly
  // announced without an aria-expanded this code would have to maintain.
  assert.equal([...details.matchAll(/<details className="product-accordion">/g)].length, 4);
  // The analytics handler on the "mehr über unseren Matcha" LINK is
  // fine; a handler on the summary would mean a hand-rolled disclosure.
  assert.ok(!/<summary[^>]*onClick/.test(details), "the disclosure grew a click handler");
  assert.ok(!details.includes("aria-expanded"), "a hand-rolled expanded state appeared");
  assert.match(css, /\.product-accordion summary:focus-visible\{outline/);

  // ── EVERY MANDATORY LINE SURVIVED THE REGROUPING ─────────────
  for (const line of [
    "LEBENSMITTELBEZEICHNUNG", "Matcha (Grünteepulver)",
    "ZUTAT", "100 % Matcha-Grünteepulver, keine Zusätze",
    "HERKUNFT", "Shizuoka, Japan",
    "QUALITÄT", "100 % Bio-Matcha",
    "LAGERUNG", "{PRODUCT.storage}",
    "GROESSEN", "ZUBEREITUNG", "VERSAND",
    "Deutschland: 2–4 Werktage · Andere Länder: 3–10 Werktage",
    "Lebensmittelunternehmer: Cara 2 GmbH, Hardenbergstr. 4, 10623 Berlin, Deutschland",
    "MEHR ÜBER UNSEREN MATCHA →", "VERSAND & LIEFERZEITEN →",
  ]) {
    assert.ok(details.includes(line), `the regrouping lost: ${line}`);
  }
  // NO NUTRITION TABLE WAS INVENTED. tests/legal-content.test.mjs bans
  // the word outright; the row is "Zutaten" for exactly that reason.
  assert.ok(!site.includes("Nährwert"), "a nutrition claim appeared");

  // No card, no icon, no decoration - text and a plus.
  assert.match(rules, /\.shop-accordion \.product-accordion\{border-top:1px solid var\(--line\)\}/);
  assert.ok(!/\.shop-accordion[^{]*\{[^}]*(border-radius|box-shadow)/.test(rules), "the rows became cards");
  assert.ok(!/<svg|📦|🍵/.test(details), "a decorative icon was added");
});

/* ══════════════════════════════════════════════════════════════
   5. TYPE AND THE RAIL
   ══════════════════════════════════════════════════════════════ */

test("5: a product title, not a hero one, on the canonical rail", () => {
  const cap = t => Number(/clamp\([^,]+,[^,]+,(\d+)px\)/.exec(t)[1]);
  const title = rule(".shop-product-title{");
  assert.match(title, /font-size:clamp\(32px,3vw,46px\)/);
  assert.ok(cap(title) <= 46, "the product title left its band");
  // Below the shop hero (84px) and far below the homepage hero (100px).
  assert.ok(cap(title) < cap(/\.shop-hero-line\{[\s\S]*?(font-size:clamp\([^)]*\))/.exec(css)[1]));
  assert.ok(cap(title) < cap(/\.hero \.hero-copy h1\{[\s\S]*?(font-size:clamp\(54px[^)]*\))/.exec(css)[1]));

  // The small roles read the page's shared tokens.
  assert.match(rule(".shop-product-eyebrow{"), /font-size:var\(--type-meta\)/);
  assert.match(rule(".shop-product-eyebrow{"), /color:var\(--berry\)/);
  assert.match(rules, /\.shop-product-row \.shop-cta\{[\s\S]*?font-size:var\(--type-meta\)/);
  assert.match(rules, /\.shop-accordion \.product-accordion summary\{[\s\S]*?font:600 var\(--type-meta\)/);
  assert.match(rule(".shop-product-sub{"), /font-size:15px/);
  assert.match(rules, /\.shop-accordion \.product-accordion dd\{font:400 15px/);
  assert.match(rule(".shop-product-price{"), /font-size:clamp\(28px,2\.2vw,32px\)/);
  assert.match(rule(".shop-product-price{"), /font-weight:700/);
  // Inter only in this block - no editorial accent was forced in.
  for (const m of rules.matchAll(/font-family:([^;}]+)|font:[^;}]*var\(--font-(\w+)\)/g)) {
    assert.ok(!/--font-display/.test(m[0]), `the product block reaches for the display face: ${m[0]}`);
  }

  // ── COLOUR AND CONTAINER ─────────────────────────────────────
  assert.match(rules, /\.shop-products\{[\s\S]*?background:var\(--cream\)/);
  assert.match(rules, /\.shop-column\{[\s\S]*?background:var\(--cream\)/);
  assert.match(rules, /\.shop-product-row \.shop-cta\{[\s\S]*?background:var\(--blue\)/);
  assert.match(rules, /\.shop-product-row \.shop-cta\{[\s\S]*?color:var\(--cream\)/);
  // The rail: the section takes the shared gutter, the row is a
  // narrower INNER block that starts on the same left edge.
  assert.match(css, /\.shop-column,\s*\.shop-accordion,\s*\.matcha-hero,\s*\.matcha-product,\s*\.matcha-research,\s*\.matcha-use\{padding-inline:var\(--rail-gutter\)\}/);
  assert.match(block, /<div className="shop-product-row home-rail">/);
  assert.match(details, /<div className="shop-accordion-inner home-rail">/);
  assert.match(rule(".shop-product-row{"), /max-width:min\(1240px,var\(--rail-max\)\)/);
  assert.ok(!rules.includes("100vh"), "the section reserves a viewport");
  // Stacks before the two columns can crush each other.
  assert.match(rules, /@media \(max-width:900px\)\{[\s\S]*?\.shop-product-row\{grid-template-columns:1fr/);
  assert.match(rules, /@media \(max-width:640px\)\{[\s\S]*?grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
});
