import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { shopGridInteraction, shopGridFixture } from './helpers/shopGridInteraction.mjs';
import { renderToStaticMarkup } from 'react-dom/server';
import { inspectShopGrid } from './helpers/shopGridBrowserReady.mjs';

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
const shop = site.slice(site.indexOf("function Shop({"), site.indexOf("// -- Product detail ---"));
const rules = css.slice(css.indexOf("SHOP MATCHA PRODUCT SECTION"), css.indexOf("/our-matcha PAGE HERO"));

/* ══════════════════════════════════════════════════════════════
   1. WHAT THE PAGE LISTS
   ══════════════════════════════════════════════════════════════ */

test("1: only the matcha is listed, and the case is hidden rather than removed", () => {
  // ONE named list decides, and it is the only thing to edit to bring
  // the case back. It moved to lib/catalogAvailability.ts so the SERVER
  // reads the same list - hiding the card here never stopped
  // /shop/metal-case or a hand-written checkout request, which
  // tests/catalog-availability.test.mjs now covers.
  assert.match(site, /import \{ isProductWithheld \} from "\.\.\/lib\/catalogAvailability";/);
  assert.match(site, /const visibleShopProducts=\(products:CatalogProduct\[\]\)=>products\.filter\(p=>!isProductWithheld\(p\.slug\)\);/);
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
  // .webp, not .png: 906,588 bytes of a flat powder render became 70,702,
  // same pixels at q90 (mean per-channel difference 1.18 of 255) and the
  // source PNG's alpha was fully opaque, so nothing was lost by dropping
  // it. The PNG stays on disk, asserted below.
  assert.match(site, /\[MATCHA_SLUG\]:\{src:"\/img\/Produkt Bild \(2\)\.webp",alt:"Grünes Matcha-Pulver",width:964,height:908\}/);
  assert.ok(existsSync(path.join(ROOT, "public/img/Produkt Bild (2).webp")), "the optimised image is missing");
  assert.ok(existsSync(path.join(ROOT, "public/img/Produkt Bild (2).png")), "the approved image is missing");
  assert.ok(statSync(path.join(ROOT, "public/img/Produkt Bild (2).png")).size > 0);
  // NOT the pouch, NOT the header, NOT an automatically chosen asset.
  assert.ok(!block.includes("Produkt BILD.png"), "the shop section renders the pouch");
  assert.ok(!block.includes("Startseite.png"), "the shop section renders the hero image");
  // The shared presentation map is untouched: the cart line, the card
  // and the product page still resolve their own image.
  assert.match(block, /getProductImage\(product\)/);
  assert.ok(!read("lib/productPresentation.ts").includes("Produkt Bild (2)"),
    "the shared presentation map was changed for one page's sake");

  // ── CONTAINED, AND SMALL ─────────────────────────────────────
  const visual = css.slice(css.indexOf(".shop-page .shop-product-visual{"),css.indexOf("}",css.indexOf(".shop-page .shop-product-visual{")));
  assert.match(visual, /width:100%/);
  assert.match(visual, /aspect-ratio:4\/5/);
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
  assert.match(block, /const safe=Math\.max\(0,Math\.min\(idx,product\.variants\.length-1\)\);/);
  assert.match(block, /const v=product\.variants\[safe\];/);
  assert.match(block, /const per100=showsUnitPricePer100g\(v\)\?per100gCents\(v\.price_gross_cents,v\.size_grams as number\):null;/);
  assert.match(block, /selected\?fmtCents\(v\.price_gross_cents\)/);
  assert.match(block, /\{fmtCents\(per100\)\} € \/ 100 g/);
  // No price, size or per-100g figure is written into this file.
  for (const literal of ["19,99", "29,99", "54,99", "66,63", "30 g\"", "50 g\"", "100 g\""]) {
    assert.ok(!block.includes(literal), `a commerce value was hard-coded: ${literal}`);
  }
  // The launch CTA's ONE-TIME behaviour is untouched: prelaunch still
  // goes to /contact and the live path still adds to the cart. The
  // prelaunch test moved to the FRONT of the chain when the 4-week
  // option arrived - previously it sat between the annual branch and
  // handleAdd, which meant annual mode bypassed it entirely.
  assert.match(block, /onClick=\{SHOP_IS_PRELAUNCH\?\(\)=>window\.location\.href="\/contact":/);
  assert.match(block, /:handleAdd\}/, "the one-time path no longer ends at the cart");
  // Neither recurring branch reaches handleAdd - a plan is a dedicated
  // account-bound checkout, not a cart line. See
  // tests/shop-annual-plan.test.mjs and
  // tests/subscription-purchase-surface.test.mjs.
  // The annual arm hands over to the account now that a purchase path
  // exists; it still never reaches the cart.
  assert.match(block, /annualActive\?\(\)=>\{track\("shop_annual_start"\);window\.location\.href=annualPortalHref\(v\.sku\)\}/);
  assert.match(block, /subscriptionActive\?\(\)=>\{track\("shop_subscription_start"\);window\.location\.href=subscriptionPortalHref\(v\.sku\)\}/);
  // Prelaunch says the same thing in EVERY purchase mode, because in
  // prelaunch none of them sells anything.
  assert.match(block, /SHOP_IS_PRELAUNCH\?"Fragen zum Launch":annualActive\?"Jahresplan im Konto starten":subscriptionActive\?"Abo im Konto starten":"In den Warenkorb"/);
  assert.match(read("app/content.ts"), /export const SHOP_STATUS = "live"/);
  // The hero's anchor still lands on the section.
  assert.match(shop, /<section id="product" className="shop-products" data-count=\{shown.length\}/);
});

test('Grid cards require explicit multi-variant choice and cart the selected authoritative variant',()=>{
 const product=shopGridFixture(1)[0],ui=shopGridInteraction(product);
 assert.match(renderToStaticMarkup(ui.render()),/14,99.*22,99/);
 assert.equal(ui.find(n=>n.type==='select').props.value,'');
 const buy=()=>ui.find(n=>n.type==='button');assert.equal(buy().props.disabled,true);buy().props.onClick();assert.equal(ui.items.length,0);
 ui.find(n=>n.type==='select').props.onChange({target:{value:product.variants[1].id}});
 assert.equal(buy().props.disabled,false);assert.match(renderToStaticMarkup(ui.render()),/22,99/);
 buy().props.onClick();assert.equal(ui.items[0].variantId,product.variants[1].id);assert.equal(ui.items[0].unitPriceCents,product.variants[1].price_gross_cents);
 assert.match(renderToStaticMarkup(ui.render()),/45,98/); // selected 50 g base price
 ui.find(n=>n.type==='select').props.onChange({target:{value:'tampered-id'}});assert.equal(ui.find(n=>n.type==='select').props.value,product.variants[1].id);
});
test('Grid cards keep storage images, detail routes, disclosures, single variants and sold-out guards',()=>{
 const product=shopGridFixture(2)[1];product.primary_image_path='https://images.example.invalid/product-images/immutable.webp';product.variants=product.variants.slice(0,1);
 const ui=shopGridInteraction(product),html=renderToStaticMarkup(ui.render());
 assert.ok(html.includes(product.primary_image_path));assert.ok(html.includes('/shop/'+product.slug));assert.equal(ui.find(n=>n.type==='button').props.disabled,false);
 const image=ui.find(n=>n.type==='img');assert.equal(image.props.loading,'lazy');assert.equal(image.props.alt,product.name);
 product.variants[0].availability='sold_out';assert.equal(ui.find(n=>n.type==='button').props.disabled,true);ui.find(n=>n.type==='button').props.onClick();assert.equal(ui.items.length,0);assert.match(renderToStaticMarkup(ui.render()),/AUSVERKAUFT/);
 assert.ok(renderToStaticMarkup(shopGridInteraction(shopGridFixture(1)[0]).render()).includes('#shop-matcha-disclosures'));
});
test('Grid has balanced 1/2/3 item layouts, 4 desktop columns and separate food/Annual sections',()=>{
 for(const columns of [2,3,4])assert.ok(css.includes(`grid-template-columns:repeat(${columns},minmax(0,1fr))`));
 for(const count of [1,2,3])assert.ok(css.includes(`[data-count="${count}"]`));
 assert.match(css,/aspect-ratio:4\/5/);assert.match(css,/\.shop-page \.shop-product-visual img\{[^}]*object-fit:contain/);
 assert.ok(shop.indexOf('shop-matcha-disclosures')>shop.indexOf('</section>'));
 assert.ok(shop.indexOf('{hasAnnual&&<ShopAnnualPlan')>shop.indexOf('</section>'));
 for(const count of [1,2,3,4,8])assert.equal(shopGridFixture(count).map(p=>renderToStaticMarkup(shopGridInteraction(p).render())).filter(html=>html.includes('shop-product-visual')).length,count);
});
test('Grid recurring choices keep account checkout separate from cart',()=>{
 const product=shopGridFixture(1)[0],ui=shopGridInteraction(product);
 ui.find(n=>n.type==='select').props.onChange({target:{value:product.variants[0].id}});
 const modes=ui.find(n=>n.type==='purchase-mode-test');assert.equal(modes.props.showSubscription,true);assert.equal(modes.props.showAnnual,true);
 modes.props.onSelect('subscription');ui.find(n=>n.type==='button').props.onClick();assert.equal(ui.items.length,0);assert.ok(ui.navigation.location.href.includes('GLOA-MATCHA-30G'));
 ui.find(n=>n.type==='purchase-mode-test').props.onSelect('annual');ui.find(n=>n.type==='button').props.onClick();assert.equal(ui.items.length,0);assert.ok(ui.navigation.location.href.includes('GLOA-MATCHA-30G'));
});

test('Prelaunch grid keeps products and variant choices but hides money and cannot add to cart',()=>{
 const p=shopGridFixture(1)[0],ui=shopGridInteraction(p,{prelaunch:true});
 for(const choose of [false,true]){
  if(choose)ui.find(n=>n.type==='select').props.onChange({target:{value:p.variants[0].id}});
  const html=renderToStaticMarkup(ui.render());assert.ok(html.includes(p.name.toUpperCase()));assert.ok(html.includes('30 g'));
  assert.doesNotMatch(html,/\d+,\d{2}\s*€|shop-product-price|shop-product-per100g/);
 }
 const button=ui.find(n=>n.type==='button');assert.equal(button.props.children,'Fragen zum Launch');button.props.onClick();assert.equal(ui.navigation.location.href,'/contact');assert.equal(ui.items.length,0);
});

function browserReadinessFixture(broken=false,stalled=false){
 const calls=[],images=Array.from({length:4},(_,i)=>({loading:'lazy',complete:false,naturalWidth:0,
  scrollIntoView(){calls.push('scroll-'+i);this.inView=true;},getAttribute:()=>'/fixture-'+i+'.webp',
  decode(){assert.equal(this.inView,true,'decode must follow scroll');if(stalled)return new Promise(()=>{});if(broken)return Promise.reject(new Error('broken raster'));this.complete=true;this.naturalWidth=400;return Promise.resolve();}}));
 const grid={children:images},doc={fonts:{ready:Promise.resolve()},images,documentElement:{dataset:{},scrollWidth:800},querySelector:s=>s==='.shop-products'?grid:{getBoundingClientRect:()=>({width:400,height:500})}};
 const view={requestAnimationFrame:fn=>queueMicrotask(fn),scrollTo:()=>calls.push('top'),getComputedStyle:()=>({gridTemplateColumns:'400px 400px'}),innerWidth:800};
 return {doc,view,calls};
}
test('Visual runner scrolls lazy images into view before decoding and restores the screenshot position',async()=>{
 const f=browserReadinessFixture(),result=await inspectShopGrid(f.doc,f.view,1000);
 assert.deepEqual(f.calls,['scroll-0','scroll-1','scroll-2','scroll-3','top']);assert.equal(result.images,true);assert.equal(result.lazy,true);assert.equal(result.columns,2);assert.equal(result.overflow,false);assert.equal(result.ratio,.8);
});
test('Visual runner rejects broken images and bounds stalled decode instead of inventing a visual PASS',async()=>{
 const broken=browserReadinessFixture(true);await assert.rejects(inspectShopGrid(broken.doc,broken.view,1000),/broken raster/);
 const stalled=browserReadinessFixture(false,true);await assert.rejects(inspectShopGrid(stalled.doc,stalled.view,30),/Grid readiness timeout: image/);
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
    // SITE-01B: the same neutral composition line the matcha page now
    // carries, for as long as the certificate is outstanding.
    // PRODUCT-01B: the row states a composition, not a quality grade -
    // the product page already called it ZUTAT and the card follows.
    "ZUTAT", "100 % Matcha-Grünteepulver",
    "LAGERUNG", "{PRODUCT.storage}",
    // SITE-01 re-pinned the ASCII transliteration to the umlaut the rest
    // of the site already used (matcha page, account portal). Same label,
    // spelled the same way everywhere now.
    "GRÖSSEN", "ZUBEREITUNG", "VERSAND",
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

test("5: premium grid typography stays below hero scale and uses the shared GLOA rail", () => {
 const grid=css.slice(css.indexOf('/* Premium catalogue grid:'));
 assert.match(grid,/\.shop-page \.shop-product-title\{font-size:clamp\(20px,1\.6vw,26px\)/);
 assert.match(grid,/padding:48px var\(--rail-gutter\) 72px/);
 assert.match(grid,/max-width:1800px/);
 assert.match(grid,/\.shop-page \.shop-product-row\{[^}]*flex-direction:column/);
 assert.match(grid,/min-height:44px/);
 assert.match(grid,/:focus-visible\{outline:2px solid var\(--blue\)/);
 assert.ok(!grid.includes('box-shadow:'),'grid cards must remain calm and shadow-free');
 assert.match(details,/<div className="shop-accordion-inner home-rail">/);
});
