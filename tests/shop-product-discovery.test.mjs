import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startRenderServer } from "./helpers/renderServer.mjs";
import { getReadOnlySupabaseClient } from "./helpers/catalog.mjs";
import { SITE_ORIGIN, absoluteUrl } from "../lib/publicRoutes.ts";
import { resolveProductSlug, PRODUCT_SLUG_ALIASES } from "../lib/productSlugs.ts";
import { buildProductSchema, schemaPrice } from "../lib/productStructuredData.ts";
import { getProductImage } from "../lib/productPresentation.ts";
import { WITHHELD_PRODUCT_SLUGS } from "../lib/catalogAvailability.ts";

/**
 * THE LAST SOFT-404, AND THE MARKUP THAT REPLACES IT AT LAUNCH.
 *
 * tests/seo-discovery.test.mjs ended the soft-404 for every route whose
 * URL is a PAGE NAME. /shop/<slug> was the one left over, because its
 * tail is DATA: the catalog was read only in the browser, so the server
 * could not tell /shop/matcha from /shop/xyz123 and answered both with
 * HTTP 200 and a page that said "Produkt vorübergehend nicht
 * verfügbar." Every invented product slug was therefore an indexable
 * page, in unbounded supply.
 *
 * Two halves are locked in here:
 *
 *   1. WHAT THE SERVER ANSWERS for a real slug, a withheld slug, an
 *      aliased slug and an invented one - measured against the built
 *      server, not asserted from source.
 *   2. WHAT THE PRODUCT MARKUP SAYS, in both shop states. Prelaunch
 *      must publish no Offer and no price at all; the LIVE shape is
 *      built here from the REAL catalog rows, so launch day is a flag
 *      flip rather than a first attempt.
 *
 * SAFE: the spawned server runs without a service-role key and every
 * request is a GET. The catalog reads are selects against the project
 * the app is already configured for - read-only, never a write.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf8");

const lookupSource = read("lib/catalogProducts.ts");
const slugPage = read("app/[...slug]/page.tsx");
const schemaSource = read("lib/productStructuredData.ts");

const PORT = 8964;
let server;

/** The slug the shop actually sells, and the one the sitemap lists. */
const REAL_SLUG = "matcha";
/** Withheld for this launch: a deliberate page, not a missing one. */
const WITHHELD_SLUG = WITHHELD_PRODUCT_SLUGS[0];
/** Nothing in the catalog answers to any of these. */
const INVENTED_SLUGS = ["does-not-exist", "erfunden", "xyz123", "matcha-xl", "gloa"];

test.before(async () => {
  server = await startRenderServer(PORT);
});

test.after(() => {
  server?.stop();
});

/* ══════════════════════════════════════════════════════════════
   1. UNKNOWN PRODUCT SLUGS ANSWER A REAL 404
   ══════════════════════════════════════════════════════════════ */

test("a real product slug still answers 200", async () => {
  const { status } = await server.getHtml(`/shop/${REAL_SLUG}`);
  assert.equal(status, 200, `/shop/${REAL_SLUG} must stay reachable`);
});

test("an invented product slug answers 404, not 200", async () => {
  for (const slug of INVENTED_SLUGS) {
    const { status } = await server.getHtml(`/shop/${slug}`);
    assert.equal(status, 404, `/shop/${slug} answered ${status} instead of 404`);
  }
});

test("the product 404 is the site's own 404 page, not a technical error", async () => {
  const { html } = await server.getHtml("/shop/does-not-exist");
  assert.match(html, /Diese Seite gibt es nicht/);
  assert.match(html, /<meta name="robots" content="noindex/);
  assert.ok(!/stack|Internal Server Error/i.test(html), "the 404 leaks a technical error");
  // And it must not look like a product page.
  assert.ok(!/Produkt vorübergehend nicht verfügbar/.test(html), "still the old soft-404 body");
});

test("a slug shape that cannot be a catalog slug is refused too", async () => {
  // Scanner fodder. None of these reaches the database - the shape
  // check in lib/catalogProducts.ts answers them for free.
  // No ".." here: fetch() collapses it before the request is made, so
  // such a test would measure the client rather than the server.
  for (const tail of ["wp-admin.php", "MATCHA", "Matcha", "matcha%20", "matcha_30", "a".repeat(80)]) {
    const { status } = await server.getHtml(`/shop/${tail}`);
    assert.equal(status, 404, `/shop/${tail} answered ${status} instead of 404`);
  }
});

test("the withheld product keeps its deliberate page: 200 and noindex", async () => {
  // Migration 047 deactivated it, so a plain catalog read reports it
  // missing. It is NOT missing - it is held back on purpose, the page
  // says so, and it is kept out of the index by noindex rather than by
  // a 404 that would also remove the decision from the record.
  const { status, html } = await server.getHtml(`/shop/${WITHHELD_SLUG}`);
  assert.equal(status, 200, `/shop/${WITHHELD_SLUG} must not become a 404`);
  assert.match(html, /<meta name="robots" content="noindex/);
});

test("the /shop/gloa-matcha alias resolves, and canonicalises to the product", async () => {
  const alias = Object.keys(PRODUCT_SLUG_ALIASES)[0];
  const { status, html } = await server.getHtml(`/shop/${alias}`);
  assert.equal(status, 200, `/shop/${alias} broke`);
  assert.ok(
    html.includes(`rel="canonical" href="${absoluteUrl(`shop/${resolveProductSlug(alias)}`)}"`),
    "the alias canonicalises to itself, which is a second indexable copy of one product",
  );
});

/* ══════════════════════════════════════════════════════════════
   2. A BLIP IS NOT A 404
   ══════════════════════════════════════════════════════════════ */

test("only a catalog that ANSWERED can produce a 404", () => {
  // A 404 is durable - it is what removes a URL from an index. The
  // three outcomes exist so an unreachable catalog cannot de-list a
  // real product, and the page must act on "missing" alone.
  assert.match(lookupSource, /if \(error\) \{[\s\S]*?return \{ state: "unavailable" \};/,
    "a failed catalog read must be 'unavailable', never 'missing'");
  assert.match(lookupSource, /if \(!supabase\) return \{ state: "unavailable" \};/,
    "an unconfigured catalog must be 'unavailable', never 'missing'");
  assert.match(slugPage, /lookup\?\.state==="missing"\)notFound\(\)/,
    "the page must 404 on 'missing' and on nothing else");
  // Two guards, and only two: the route list and the catalog. Comments
  // are stripped first so prose mentioning notFound() does not count.
  const code = slugPage.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.equal(
    (code.match(/notFound\(\)/g) || []).length, 2,
    "the page gained a notFound() call beyond the route guard and the product guard",
  );
  // And no retry loop: postgrest-js already retries idempotent reads
  // three times (tests/catalog-read-resilience.test.mjs measures it).
  assert.ok(!/for \(let attempt|while \(attempt/.test(lookupSource), "a second retry loop was added");
});

test("the lookup reads the catalog and writes nothing", () => {
  assert.ok(!/\.insert\(|\.update\(|\.upsert\(|\.delete\(|\.rpc\(/.test(lookupSource),
    "the product lookup must be read-only");
  assert.ok(!/supabaseAdmin|SUPABASE_SECRET_KEY/.test(lookupSource),
    "the product lookup must not use the service role");
  // One select, from the public catalog, through the publishable client.
  assert.equal((lookupSource.match(/\.select\(/g) || []).length, 1);
  assert.match(lookupSource, /from\("products"\)/);
});

test("no second product list was introduced anywhere", () => {
  // The one product name that may appear in this module is in a comment
  // about the withheld case. No slug, sku, price or variant is hardcoded
  // in either new module - Supabase stays the only place that knows
  // what GLOA sells.
  for (const [name, source] of [["catalogProducts", lookupSource], ["productStructuredData", schemaSource]]) {
    assert.ok(!/GLOA-MATCHA|price_gross_cents\s*[:=]\s*\d/.test(source), `${name} hardcodes catalog data`);
    assert.ok(!/\b\d{3,5}\s*\/\s*100\b/.test(source.replace(/\/\*[\s\S]*?\*\//g, "")), `${name} hardcodes a price`);
  }
});

/* ══════════════════════════════════════════════════════════════
   3. PRELAUNCH PUBLISHES NO OFFER AND NO PRICE
   ══════════════════════════════════════════════════════════════ */

test("the product page publishes no Offer, price or availability in prelaunch", async () => {
  assert.match(read("app/content.ts"), /export const SHOP_STATUS = "prelaunch" as const;/);
  for (const route of ["/shop", `/shop/${REAL_SLUG}`, `/shop/${WITHHELD_SLUG}`]) {
    const { html } = await server.getHtml(route);
    for (const banned of [
      '"@type":"Offer"', '"@type": "Offer"', '"@type":"ProductGroup"', '"@type":"AggregateOffer"',
      '"priceCurrency"', '"availability"', '"price"', '"hasVariant"',
      'property="product:price', 'itemprop="price"',
    ]) {
      assert.ok(!html.includes(banned), `${route} publishes ${banned} while the shop is closed`);
    }
    const money = [...html.matchAll(/\d{1,3},\d{2}\s*(€|Euro)/g)].map(m => m[0]);
    assert.deepEqual(money, [], `${route} publishes a price: ${money.join(", ")}`);
  }
});

test("the builder is the single gate, and it is wired to the one launch flag", () => {
  assert.match(schemaSource, /if \(!ctx\?\.offersVisible\) return null;/,
    "the schema must be gated on offersVisible");
  assert.match(slugPage, /offersVisible:PRICES_VISIBLE/,
    "the page must pass the derived launch flag, not a second switch");
  assert.equal(buildProductSchema({
    id: "p", slug: "x", name: "X",
    variants: [{ sku: "S", label: "30 g", size_grams: 30, price_gross_cents: 1999, currency: "EUR" }],
  }, { origin: SITE_ORIGIN, url: absoluteUrl("shop/x"), offersVisible: false }), null);
});

/* ══════════════════════════════════════════════════════════════
   4. THE LIVE SHAPE, BUILT FROM THE REAL CATALOG
   ══════════════════════════════════════════════════════════════ */

/** The real catalog row for the launch product, read once, read-only. */
let matchaRow;

test.before(async () => {
  const supabase = getReadOnlySupabaseClient();
  const { data, error } = await supabase
    .from("products")
    .select("id, slug, name, short_description, description, primary_image_path, " +
      "product_variants(id, sku, label, size_grams, price_gross_cents, currency, sort_order)")
    .eq("slug", REAL_SLUG)
    .limit(1);
  if (error) throw new Error(`Test setup: catalog read failed (${error.message})`);
  if (!data?.length) throw new Error(`Test setup: no product "${REAL_SLUG}" in the configured project`);
  matchaRow = {
    ...data[0],
    variants: (data[0].product_variants ?? [])
      .filter(v => typeof v.price_gross_cents === "number" && v.price_gross_cents > 0)
      .sort((a, b) => a.sort_order - b.sort_order),
  };
});

/** The context the page builds, with the launch flag forced open. */
const liveContext = () => ({
  origin: SITE_ORIGIN,
  url: absoluteUrl(`shop/${REAL_SLUG}`),
  offersVisible: true,
  imagePath: getProductImage(matchaRow),
  fallbackDescription: "GLOA Matcha aus Shizuoka, Japan.",
});

test("LIVE: the launch product becomes a ProductGroup with one variant per size", () => {
  const schema = buildProductSchema(matchaRow, liveContext());
  assert.ok(schema, "no product markup would be published at launch");
  assert.equal(schema["@context"], "https://schema.org");
  assert.equal(schema["@type"], "ProductGroup");
  assert.equal(schema["@id"], `${absoluteUrl(`shop/${REAL_SLUG}`)}#product`);
  assert.equal(schema.url, absoluteUrl(`shop/${REAL_SLUG}`));
  assert.equal(schema.name, matchaRow.name);
  assert.equal(schema.productGroupID, matchaRow.id, "productGroupID must be the catalog's own id");
  assert.deepEqual(schema.variesBy, ["https://schema.org/weight"]);
  assert.equal(schema.brand["@id"], `${SITE_ORIGIN}/#brand`, "the product must point at the Brand node");
  assert.equal(schema.hasVariant.length, matchaRow.variants.length);
  assert.ok(matchaRow.variants.length >= 2, "this product is expected to have several sizes");
});

test("LIVE: every price and sku comes from the catalog, and none is invented", () => {
  const schema = buildProductSchema(matchaRow, liveContext());
  const bySku = Object.fromEntries(schema.hasVariant.map(v => [v.sku, v]));
  for (const variant of matchaRow.variants) {
    const node = bySku[variant.sku];
    assert.ok(node, `variant ${variant.sku} is missing from the markup`);
    assert.equal(node.offers.price, schemaPrice(variant.price_gross_cents));
    assert.equal(node.offers.price, (variant.price_gross_cents / 100).toFixed(2));
    assert.equal(node.offers.priceCurrency, variant.currency.toUpperCase());
    assert.equal(node.offers.priceSpecification.valueAddedTaxIncluded, true,
      "catalog prices are gross; the markup must say so");
    assert.equal(node.offers.availability, "https://schema.org/InStock");
    assert.equal(node.offers.itemCondition, "https://schema.org/NewCondition");
    assert.equal(node.offers.seller["@id"], `${SITE_ORIGIN}/#organization`);
    assert.equal(node.name, `${matchaRow.name} ${variant.label}`);
    assert.deepEqual(node.weight, {
      "@type": "QuantitativeValue", value: variant.size_grams, unitCode: "GRM", unitText: "g",
    });
  }
  // Three sizes at three different prices is the whole reason this is a
  // group rather than one Product with three offers.
  const prices = new Set(schema.hasVariant.map(v => v.offers.price));
  assert.equal(prices.size, matchaRow.variants.length, "the sizes must keep their own prices");
});

test("LIVE: no rating, review, GTIN, MPN or award is fabricated", () => {
  const json = JSON.stringify(buildProductSchema(matchaRow, liveContext()));
  for (const banned of ["aggregateRating", "review", "ratingValue", "gtin", "mpn",
                        "award", "priceValidUntil", "bester", "best "]) {
    assert.ok(!json.toLowerCase().includes(banned.toLowerCase()), `the markup invents ${banned}`);
  }
});

test("LIVE: every URL in the markup is absolute and on the production origin", () => {
  const json = JSON.stringify(buildProductSchema(matchaRow, liveContext()));
  for (const m of json.matchAll(/"(?:url|@id|image)":(?:\["([^"]+)"\]|"([^"]+)")/g)) {
    const value = m[1] ?? m[2];
    if (value.startsWith("https://schema.org/")) continue;
    assert.ok(value.startsWith(SITE_ORIGIN), `markup URL off the production origin: ${value}`);
  }
});

test("LIVE: the markup names the same image the page renders", () => {
  const schema = buildProductSchema(matchaRow, liveContext());
  const expected = getProductImage(matchaRow);
  assert.ok(expected, "the product has no image to publish");
  assert.deepEqual(schema.image, [encodeURI(`${SITE_ORIGIN}${expected}`)]);
});

test("LIVE: the markup parses as JSON and survives being embedded in HTML", () => {
  const json = JSON.stringify(buildProductSchema(matchaRow, liveContext()));
  assert.doesNotThrow(() => JSON.parse(json));
  assert.ok(!json.includes("</script"), "the markup would close its own script tag");
});

/* ── The shapes that are NOT a group ────────────────────────── */

const ONE_VARIANT = {
  id: "3f0f0f0f-0000-4000-8000-000000000000", slug: "case", name: "Test Accessory",
  variants: [{ sku: "TEST-CASE", label: "1 Stück", size_grams: null, price_gross_cents: 1499, currency: "EUR" }],
};

test("a single-variant product is a plain Product, not a group of one", () => {
  const schema = buildProductSchema(ONE_VARIANT, { origin: SITE_ORIGIN, url: absoluteUrl("shop/case"), offersVisible: true });
  assert.equal(schema["@type"], "Product");
  assert.equal(schema.sku, "TEST-CASE");
  assert.equal(schema.offers.price, "14.99");
  assert.ok(!("hasVariant" in schema));
  assert.ok(!("weight" in schema), "an accessory is not sold by weight");
});

test("a product with nothing purchasable publishes nothing at all", () => {
  const ctx = { origin: SITE_ORIGIN, url: absoluteUrl("shop/x"), offersVisible: true };
  assert.equal(buildProductSchema({ ...ONE_VARIANT, variants: [] }, ctx), null);
  assert.equal(buildProductSchema({
    ...ONE_VARIANT,
    variants: [{ sku: "X", label: "x", size_grams: null, price_gross_cents: 0, currency: "EUR" }],
  }, ctx), null, "a zero price is not an offer");
  assert.equal(buildProductSchema({
    ...ONE_VARIANT,
    variants: [{ sku: "X", label: "x", size_grams: null, price_gross_cents: 1000, currency: "" }],
  }, ctx), null, "no currency, no offer");
  assert.equal(buildProductSchema(null, ctx), null);
});

test("schemaPrice writes the decimal form schema.org expects", () => {
  assert.equal(schemaPrice(1999), "19.99");
  assert.equal(schemaPrice(5499), "54.99");
  assert.equal(schemaPrice(2000), "20.00");
});
