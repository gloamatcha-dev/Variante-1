import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { writeBlockedServerEnv } from "./helpers/testSupabase.mjs";

/**
 * WHAT A CRAWLER WITHOUT JAVASCRIPT RECEIVES FOR THE ONE PRODUCT GLOA
 * IS LAUNCHING.
 *
 * /shop and /shop/matcha read the catalog in the BROWSER, so the HTML
 * both of them sent was a loading state:
 *
 *     <h1>Produkt</h1><p>Laden…</p>
 *
 * No product name, no description, no sizes - and because the product
 * band on /shop was client-only too, the link it carries to
 * /shop/matcha was client-only, which meant NO page of this site linked
 * to the product page in its source at all. The PDP was reachable only
 * through the sitemap. Google runs JavaScript and gets there eventually;
 * Bing is slower at it and an answer engine reading a plain fetch never
 * gets there.
 *
 * The server already read this product for the 404 check. This suite
 * asserts that the read now reaches the markup, that it brings the
 * product's real fields with it, and - the part that matters most -
 * that it brings NO money with it.
 *
 * ── THE TWO HALVES ARE TESTED SEPARATELY ──────────────────────
 *
 * The shape of what may cross into HTML is a pure function
 * (toSeedProduct) and is tested directly. What actually arrives in the
 * response is tested against the real built server, because "the source
 * says so" was exactly the assumption that hid this defect: the source
 * always looked fine, and the HTML was a spinner.
 *
 * SAFE: the spawned server runs without a service-role key, so no row
 * can be written, and every request here is a GET.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf8");

const site = read("app/GloaSite.tsx");
const slugPage = read("app/[...slug]/page.tsx");
const catalog = read("lib/catalogProducts.ts");
const content = read("app/content.ts");

const PORT = 8973;
const BASE_URL = `http://127.0.0.1:${PORT}`;
let serverProcess;
const pages = new Map();

async function load(pathname) {
  if (pages.has(pathname)) return pages.get(pathname);
  const res = await fetch(`${BASE_URL}${pathname}`, { redirect: "manual" });
  const entry = { status: res.status, body: await res.text() };
  pages.set(pathname, entry);
  return entry;
}

/** Source with every comment stripped - so a prose mention of a thing is
 *  never mistaken for the code doing it. */
const codeOnly = src => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

/** The rendered text of a response, scripts and styles removed. */
function visibleText(html) {
  const body = html.slice(html.indexOf("<body"));
  return body
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
}

test.before(async () => {
  serverProcess = spawn(process.execPath, [".output/server/index.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: writeBlockedServerEnv({ PORT: String(PORT) }),
    stdio: "ignore",
  });
  const ready = new Promise((resolveReady, rejectReady) => {
    serverProcess.once("exit", code => rejectReady(new Error(`server exited early (code ${code})`)));
    (async () => {
      for (let attempt = 0; attempt < 60; attempt++) {
        try { const res = await fetch(`${BASE_URL}/`); if (res.ok) { resolveReady(); return } } catch { /* not up */ }
        await delay(200);
      }
      rejectReady(new Error("server did not become ready in time"));
    })();
  });
  await ready;
});

test.after(() => { serverProcess?.kill(); });

/* ══════════════════════════════════════════════════════════════
   1. THE SEED CARRIES PRODUCT FACTS AND NO MONEY
   ══════════════════════════════════════════════════════════════ */

test("1: the seed reaches the payload with its labels and without its prices", async () => {
  // MEASURED IN THE RESPONSE, NOT IN THE FUNCTION. What a client
  // component is handed is serialised into the HTML, so the only
  // assertion that proves the stripping worked is one made against the
  // bytes that leave the server - which is also the assumption that hid
  // the original defect: the source always looked right.
  const { body } = await load("/shop/matcha");

  // The seed crossed: its variant labels are in the document.
  for (const label of ["30 g", "50 g", "100 g"]) {
    assert.ok(body.includes(label), `the payload does not carry the variant label ${label}`);
  }
  assert.ok(body.includes("GLOA Matcha"), "the payload does not carry the product name");

  // And it crossed without money, in every spelling it could arrive as.
  for (const forbidden of ["price_gross_cents", "priceCurrency", "unitPriceCents", "\"currency\""]) {
    assert.ok(!body.includes(forbidden), `the payload carries ${forbidden}`);
  }
  assert.deepEqual(body.match(/\d+[.,]\d{2}\s*(?:&#x20AC;|€|EUR|Euro)/g) || [], []);
});

test("1b: the stripping is a field list, not a delete-what-we-remember", () => {
  const fn = codeOnly(catalog.slice(catalog.indexOf("export function toSeedProduct"),
                                    catalog.indexOf("export const lookupCatalogSeed")));
  assert.ok(!/delete |\.\.\.product|\.\.\.v\b/.test(fn),
    "toSeedProduct spreads or deletes - a new column would travel into HTML by default");
  assert.ok(!/price/.test(fn), "toSeedProduct copies a price field");
  // And every field it DOES carry, named, so a silent narrowing of the
  // seed shows up here rather than as a thinner page nobody looks at.
  for (const field of ["id", "slug", "name", "short_description", "description",
                       "primary_image_path", "sku", "label", "size_grams", "sort_order"]) {
    assert.ok(fn.includes(field), `toSeedProduct stopped carrying ${field}`);
  }
});

/* ══════════════════════════════════════════════════════════════
   2. THE SERVER READ REACHES THE RENDERER
   ══════════════════════════════════════════════════════════════ */

test("2: the route hands its own catalog read to the page", () => {
  // The same lookup that decides 404-or-not, reused rather than repeated.
  assert.match(slugPage, /const lookup=await productLookupFor\(path\);/);
  assert.match(slugPage, /const productSeed=lookup\?\.state==="found"\?toSeedProduct\(lookup\.product\):null;/);
  assert.match(slugPage, /const shopSeed=path==="shop"\?await lookupCatalogSeed\(\):null;/);
  assert.match(slugPage, /<GloaSite route=\{path\} productSeed=\{productSeed\} shopSeed=\{shopSeed\}\/>/);
  // "unavailable" must stay seedless, so a blip keeps the old behaviour
  // instead of rendering an empty product into the HTML.
  assert.ok(!/state==="unavailable".*toSeedProduct/s.test(slugPage));
});

test("2b: there is no second catalog and no second price source", () => {
  // Nothing in the seed path names a product, a SKU or an amount.
  // From the end of the section's banner comment, so the banner's own
  // prose is outside the slice rather than relying on it being stripped.
  const bannerAt = catalog.indexOf("THE SERVER-RENDERED HALF OF THE SHOP");
  assert.notEqual(bannerAt, -1, "the seed section was renamed");
  const seedSection = codeOnly(catalog.slice(catalog.indexOf("*/", bannerAt) + 2));
  assert.ok(!/\bmatcha\b/i.test(seedSection), "the seed code names a product");
  assert.ok(!/\bsku\s*:\s*"/.test(seedSection), "the seed code writes a SKU");
  assert.ok(!/\d{3,}/.test(seedSection), "the seed code contains a literal amount");
  // Read-only, publishable client, same RLS as the browser.
  assert.ok(!/\.insert\(|\.update\(|\.upsert\(|\.delete\(|\.rpc\(/.test(seedSection));
  assert.ok(!/supabaseAdmin|SUPABASE_SECRET_KEY/.test(seedSection));
  // A catalog that could not be asked returns null, not an empty shop.
  assert.match(seedSection, /if \(!supabase\) return null;/);
  assert.match(seedSection, /console\.error\("Catalog seed error:"[\s\S]{0,60}return null;/);
});

/* ══════════════════════════════════════════════════════════════
   3. WHAT THE RESPONSE ACTUALLY CONTAINS
   ══════════════════════════════════════════════════════════════ */

test("3: /shop/matcha ships the real product in its first HTML", async () => {
  const { status, body } = await load("/shop/matcha");
  assert.equal(status, 200);
  const text = visibleText(body);

  // The H1 is the product, not a placeholder.
  const h1 = body.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
  assert.ok(h1, "the page ships no h1");
  assert.equal(h1[1].replace(/<[^>]+>/g, "").trim(), "GLOA Matcha");
  assert.ok(!/Produkt<\/h1>/.test(body), "the placeholder heading is back");
  assert.ok(!text.includes("Laden…"), "the page still ships the loading state");

  // The catalog's own description and its variant labels.
  assert.ok(text.includes("Shizuoka"), "no origin in the source");
  for (const size of ["30 g", "50 g", "100 g"]) {
    assert.ok(text.includes(size), `the source does not mention ${size}`);
  }
  // And the product image is requested from the first HTML, which is
  // what makes it an LCP candidate rather than a post-hydration swap.
  assert.match(body, /<img src="\/img\/gloa-hero-packaging\.jpg"/);
});

test("3b: /shop ships the product band AND a crawlable link to the PDP", async () => {
  const { status, body } = await load("/shop");
  assert.equal(status, 200);
  const text = visibleText(body);
  assert.ok(!text.includes("Laden…"), "/shop still ships the loading state");
  assert.ok(text.includes("GLOA MATCHA"), "/shop ships no product name");

  // A real anchor, in the HTML, before any JavaScript runs.
  const links = [...body.matchAll(/<a[^>]+href="(\/shop\/[^"]+)"/g)].map(m => m[1]);
  assert.ok(links.includes("/shop/matcha"),
    `/shop does not link to the product page; /shop/* links found: ${JSON.stringify(links)}`);

  // The withheld product is not listed, and not linked.
  assert.ok(!links.includes("/shop/metal-case"), "/shop links to the withheld product");
  assert.ok(!text.includes("Metal Case"), "/shop lists the withheld product");
});

test("3c: the link survives hydration, because the live band carries it too", () => {
  // Both the seeded band and ShopProductBlock link the title, so the
  // anchor a crawler reads is the anchor a visitor clicks.
  assert.equal([...site.matchAll(/<Link href=\{`\/shop\/\$\{p\.slug\}`\} className="shop-product-link">/g)].length, 1);
  assert.equal([...site.matchAll(/<Link href=\{`\/shop\/\$\{product\.slug\}`\} className="shop-product-link">/g)].length, 1);
  // The title keeps its own class, so its type rules are untouched.
  assert.match(site, /<h2 className="shop-product-title"><Link href=\{`\/shop\/\$\{product\.slug\}`\}/);
});

/* ══════════════════════════════════════════════════════════════
   4. PRELAUNCH IS NOT WEAKENED BY ANY OF THIS
   ══════════════════════════════════════════════════════════════ */

test("4: no price, no offer, no purchase reaches the source", async () => {
  assert.match(content, /export const SHOP_STATUS = "prelaunch"/);
  for (const route of ["/shop", "/shop/matcha", "/shop/metal-case", "/shop/gloa-matcha"]) {
    const { body } = await load(route);
    // An amount in euros, in any spelling the page could produce.
    const amounts = body.match(/\d+[.,]\d{2}\s*(?:&#x20AC;|€|EUR|Euro)/g) || [];
    assert.deepEqual(amounts, [], `${route} leaks an amount`);
    // The catalog's own field name, which is what a serialised price
    // would arrive as.
    assert.ok(!body.includes("price_gross_cents"), `${route} ships a catalog price field`);
    // No Product/Offer structured data while the shop is closed.
    assert.ok(!/"@type"\s*:\s*"Offer"/.test(body), `${route} publishes an Offer`);
    assert.ok(!/"priceCurrency"|"availability"/.test(body), `${route} publishes offer data`);
    // And no purchase control in the server-rendered markup.
    assert.ok(!/In den Warenkorb/.test(body), `${route} ships a buy button`);
  }
});

test("4b: the seeded page renders no purchase column at all", () => {
  const seedPage = site.slice(site.indexOf("function ProductSeedPage("),
                              site.indexOf("/** Route entry for /shop/<slug>"));
  for (const banned of ["fmtCents", "price", "addItem", "handleAdd", "VariantSelector",
                        "PurchaseModeSelector", "shop-cta"]) {
    assert.ok(!seedPage.includes(banned), `the seeded product page reaches for ${banned}`);
  }
});

/* ══════════════════════════════════════════════════════════════
   5. THE BEHAVIOUR THAT MUST NOT HAVE CHANGED
   ══════════════════════════════════════════════════════════════ */

test("5: an unknown product is still a real 404, a reachable one still 200", async () => {
  assert.equal((await load("/shop/does-not-exist")).status, 404);
  assert.equal((await load("/shop/matcha")).status, 200);
  // The withheld product still resolves rather than 404s, and still
  // refuses to sell.
  const metal = await load("/shop/metal-case");
  assert.equal(metal.status, 200);
  assert.match(metal.body, /<meta name="robots" content="noindex/);
  // The alias still renders the product and still canonicalises to it.
  const alias = await load("/shop/gloa-matcha");
  assert.equal(alias.status, 200);
  assert.match(alias.body, /<link rel="canonical" href="https:\/\/gloamatcha\.com\/shop\/matcha"/);
});

test("5b: a catalog the server could not reach still falls back, never 404s", () => {
  // The seed is absent for "unavailable", so the page keeps the exact
  // client-side loading path it had - which lib/catalogProducts.ts
  // documents as the reason "unavailable" exists as a third state.
  assert.match(site, /if\(loading\)return seed\?<ProductSeedPage seed=\{seed\}\/>:shell\("Laden…",true\);/);
  assert.match(site, /if\(error\|\|!product\)return shell\("Produkt vorübergehend nicht verfügbar\."\);/);
  assert.match(catalog, /if \(!supabase\) return \{ state: "unavailable" \};/);
});
