import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getProductPresentation,
  getProductImage,
  getProductSubtitle,
  getProductEyebrow,
  showsFoodInformation,
  showsUnitPricePer100g,
  MATCHA_NOT_INCLUDED_NOTICE,
  MATCHA_NOT_INCLUDED_SHORT,
} from "../lib/productPresentation.ts";
import { buildItemsSnapshot } from "../lib/checkoutAttemptSnapshot.ts";
import { computeShippingGrossCents } from "../lib/shipping.ts";

// SAFE DEFAULT SUITE: no DB access, no catalog write, no network.
//
// The catalog rows themselves are published by
// supabase/migrations/020_standalone_metal_case.sql, following the same
// convention migration 008 used for Matcha. service_role has no grant on
// the catalog tables, so these tests pin the seed SQL and the
// presentation rules rather than querying production.

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const MIGRATION = readFileSync(path.join(ROOT, "supabase/migrations/020_standalone_metal_case.sql"), "utf-8");

// Confirmed customer-facing data.
const SLUG = "metal-case";
const NAME = "GLOA Metal Case";
const SKU = "GLOA-CASE-01";
const PRICE_CENTS = 999;
const IMAGE = "/img/gloa-hero-packaging.jpg";

const CASE_PRODUCT = { slug: SLUG, name: NAME, primary_image_path: IMAGE, short_description: "Die GLOA Metal Case für unterwegs, zuhause oder als zweite Dose für deinen Matcha. Leer verkauft. Matcha nicht enthalten." };
const CASE_VARIANT = { size_grams: null };
const MATCHA_PRODUCT = { slug: "matcha", name: "GLOA Matcha", primary_image_path: null, short_description: null };

/* ── The published catalog rows ─────────────────────────────── */

test("catalog: the seed publishes exactly the confirmed product values", () => {
  assert.match(MIGRATION, /'metal-case'/);
  assert.match(MIGRATION, /'GLOA Metal Case'/);
  assert.match(MIGRATION, /'GLOA-CASE-01'/);
  assert.match(MIGRATION, /'Metal Case'/);
  assert.match(MIGRATION, /999/);
  assert.match(MIGRATION, /'EUR'/);
  assert.match(MIGRATION, new RegExp(IMAGE.replace(/\//g, "\\/")));
  assert.match(MIGRATION, /is_active/);
});

test("catalog: the variant carries no weight, real or fabricated", () => {
  // The single most important line of the seed: size_grams must be NULL,
  // never 0 and never an invented gram value.
  assert.match(MIGRATION, /size_grams[\s\S]{0,400}?\n\s*null,/i, "size_grams must be seeded as NULL");
  for (const fake of ["size_grams, 0", "0 as size_grams", "size_grams = 0"]) {
    assert.ok(!MIGRATION.includes(fake), `seed must not set a zero weight: ${fake}`);
  }
  // No gram literal is offered as this product's size.
  assert.ok(!/'(0|1|30|50|100) ?g'/.test(MIGRATION), "seed must not label the accessory with a gram size");
});

test("catalog: the seed writes no tax or net field", () => {
  // Executable SQL only. The file's own comments explain that Task 21
  // (VAT/OSS) stays paused, and that prose must not be mistaken for a
  // field being written.
  const sql = MIGRATION.split("\n").filter(line => !line.trim().startsWith("--")).join("\n");

  for (const field of ["tax_total_cents", "tax_rate_percent", "price_net_cents", "net_cents"]) {
    assert.ok(!sql.toLowerCase().includes(field), `seed must not write ${field}`);
  }
  // Whole words only: "ust" lives inside "must", "vat" inside "private".
  // Built by concatenation on purpose - "\b" inside a template literal is
  // a backspace escape, not a word boundary, which would make this pass
  // against anything.
  for (const word of ["vat", "ust", "mwst", "steuer"]) {
    assert.ok(!new RegExp("\\b" + word + "\\b", "i").test(sql), `seed must not write a tax field: ${word}`);
  }
});

test("catalog: the seed states no unconfirmed physical claim", () => {
  // Material, capacity, coating, origin and durability are all unknown.
  for (const claim of ["Edelstahl", "Aluminium", "Stainless", "Blech", "spülmaschine", "luftdicht", "BPA", "ml", "mm", "cm", "Made in", "premium"]) {
    assert.ok(!new RegExp(`\\b${claim}`, "i").test(MIGRATION), `seed must not claim: ${claim}`);
  }
});

test("catalog: Matcha is not repriced or deactivated by the seed", () => {
  // The seed may READ Matcha to verify it, but must never write to it.
  const writes = MIGRATION.match(/(insert into|update)\s+public\.\w+/gi) ?? [];
  for (const w of writes) {
    assert.ok(!/matcha/i.test(w), `seed must not write to a Matcha object: ${w}`);
  }
  for (const price of ["1999", "2999", "5499"]) {
    assert.ok(!new RegExp(`(insert|update|set)[^;]*${price}`, "i").test(MIGRATION), `seed must not touch Matcha price ${price}`);
  }
});

test("catalog: the seed is re-runnable and keeps Matcha first in the shop", () => {
  assert.match(MIGRATION, /on conflict \(slug\) do update/i);
  assert.match(MIGRATION, /on conflict \(sku\) do update/i);
  assert.match(MIGRATION, /sort_order/);
  assert.match(MIGRATION, /\b10\b/, "accessory sorts after Matcha (sort_order 0)");
});

/* ── Presentation of the published product ──────────────────── */

test("metal case: is presented as a unit accessory, not a Matcha size", () => {
  const p = getProductPresentation(SLUG, CASE_VARIANT);
  assert.equal(p.weighed, false);
  assert.equal(p.foodInformation, false);
  assert.equal(p.matchaNotIncluded, true);
});

test("metal case: shows no per-100 g base price", () => {
  assert.equal(showsUnitPricePer100g(CASE_VARIANT), false);
});

test("metal case: shows no Matcha food information", () => {
  assert.equal(showsFoodInformation(SLUG), false);
});

test("metal case: reuses the existing Matcha packaging image from the catalog row", () => {
  assert.equal(getProductImage(CASE_PRODUCT), IMAGE);
  // Same asset as Matcha - which is precisely why the disclosure matters.
  assert.equal(getProductImage(MATCHA_PRODUCT), IMAGE);
});

test("metal case: card copy comes from the catalog and repeats the disclosure", () => {
  const subtitle = getProductSubtitle(CASE_PRODUCT);
  assert.match(subtitle, /Leer verkauft/);
  assert.match(subtitle, /Matcha nicht enthalten/);
  assert.equal(getProductEyebrow(CASE_PRODUCT), "METAL CASE");
});

/* ── The disclosure ─────────────────────────────────────────── */

test("disclosure: the exact confirmed wording is used", () => {
  assert.equal(MATCHA_NOT_INCLUDED_NOTICE, "Matcha nicht enthalten. Du kaufst nur die leere GLOA Metal Case.");
  assert.equal(MATCHA_NOT_INCLUDED_SHORT, "Matcha nicht enthalten");
});

test("disclosure: it is attached to the Metal Case and never to Matcha", () => {
  assert.equal(getProductPresentation(SLUG, CASE_VARIANT).matchaNotIncludedNotice, MATCHA_NOT_INCLUDED_NOTICE);
  for (const grams of [30, 50, 100]) {
    const matcha = getProductPresentation("matcha", { size_grams: grams });
    assert.equal(matcha.matchaNotIncluded, false, `${grams} g Matcha must not carry the disclosure`);
    assert.equal(matcha.matchaNotIncludedNotice, null);
  }
});

test("disclosure: it renders next to the price in every accessory view", () => {
  const site = readFileSync(path.join(ROOT, "app/GloaSite.tsx"), "utf-8");

  // Source of one component: from its declaration to the next top-level
  // function declaration.
  const body = name => {
    const start = site.indexOf(`function ${name}(`);
    assert.ok(start > -1, `${name} not found`);
    const rest = site.slice(start + 1);
    const next = rest.match(/^function /m);
    return next ? rest.slice(0, next.index) : rest;
  };

  // Both views that can render the accessory put the notice immediately
  // after the price, not in a footer or an FAQ.
  for (const [component, priceClass] of [["ShopProductBlock", "shop-product-price"], ["AccessoryProductPage", "pdp-price"]]) {
    const source = body(component);
    const priceIdx = source.indexOf(priceClass);
    assert.ok(priceIdx > -1, `${priceClass} not found in ${component}`);
    const noticeIdx = source.indexOf("matchaNotIncludedNotice", priceIdx);
    assert.ok(noticeIdx > -1, `disclosure missing after the price in ${component}`);
    assert.ok(noticeIdx - priceIdx < 400, `disclosure too far from the price in ${component}`);
  }

  // Matcha's own detail page must never render it.
  assert.ok(!body("MatchaProductPage").includes("matchaNotIncluded"), "Matcha PDP must not carry the disclosure");

  // Visually prominent: a berry accent rule plus a tinted panel, in berry
  // text. The exact border side is a design choice; carrying the brand
  // alert colour is the part that must not quietly disappear.
  const css = readFileSync(path.join(ROOT, "app/globals.css"), "utf-8");
  const rule = css.match(/\.product-not-included\{[^}]*\}/)?.[0] ?? "";
  assert.ok(rule, ".product-not-included rule not found");
  assert.match(rule, /border(-left)?:\d+px solid var\(--berry\)/, "disclosure needs a berry accent rule");
  assert.match(rule, /color:var\(--berry\)/, "disclosure text must carry the brand alert colour");
  assert.match(rule, /padding:/, "disclosure must not be cramped against its border");
});

/* ── Matcha stays exactly as it was ─────────────────────────── */

test("matcha: prices and food presentation are unchanged", () => {
  const matchaSeed = readFileSync(path.join(ROOT, "supabase/migrations/008_b2c_launch_products.sql"), "utf-8");
  assert.match(matchaSeed, /'GLOA-MATCHA-30G',\s*'30 g',\s*30,\s*1999/);
  assert.match(matchaSeed, /'GLOA-MATCHA-50G',\s*'50 g',\s*50,\s*2999/);
  assert.match(matchaSeed, /'GLOA-MATCHA-100G',\s*'100 g',\s*100,\s*5499/);

  for (const grams of [30, 50, 100]) {
    assert.equal(showsUnitPricePer100g({ size_grams: grams }), true);
  }
  assert.equal(showsFoodInformation("matcha"), true);
});

/* ── Cart: two independent lines ────────────────────────────── */

const MATCHA_LINE = {
  productId: "11111111-1111-4111-8111-111111111111",
  productName: "GLOA Matcha",
  productSlug: "matcha",
  variantId: "22222222-2222-4222-8222-222222222222",
  sku: "GLOA-MATCHA-30G",
  label: "30 g",
  sizeGrams: 30,
  quantity: 1,
  unitGrossCents: 1999,
  lineGrossCents: 1999,
};

const CASE_LINE = {
  productId: "33333333-3333-4333-8333-333333333333",
  productName: NAME,
  productSlug: SLUG,
  variantId: "44444444-4444-4444-8444-444444444444",
  sku: SKU,
  label: "Metal Case",
  sizeGrams: null,
  quantity: 1,
  unitGrossCents: PRICE_CENTS,
  lineGrossCents: PRICE_CENTS,
};

test("cart: Matcha and the Metal Case stay two separate lines", () => {
  const snapshot = buildItemsSnapshot({
    currency: "EUR",
    subtotalGrossCents: 1999 + PRICE_CENTS,
    items: [MATCHA_LINE, CASE_LINE],
  });

  assert.equal(snapshot.length, 2, "lines must never be merged");
  assert.equal(snapshot[0].productName, "GLOA Matcha");
  assert.equal(snapshot[1].productName, NAME);
  assert.equal(snapshot[1].sku, SKU);
  assert.equal(snapshot[1].variantLabel, "Metal Case");
  assert.equal(snapshot[1].sizeGrams, null, "no fabricated weight in the snapshot");
  assert.equal(snapshot[1].unitGrossCents, PRICE_CENTS);
  assert.equal(snapshot[1].lineGrossCents, PRICE_CENTS);
});

test("cart: the worked example totals 29,98 € merchandise", () => {
  const subtotal = 1999 + PRICE_CENTS;
  assert.equal(subtotal, 2998);
});

/* ── Shipping is untouched ──────────────────────────────────── */

test("shipping: 29,98 € to Germany still costs 5,90 €, so the total is 35,88 €", () => {
  const subtotal = 1999 + PRICE_CENTS;
  const shipping = computeShippingGrossCents("germany", subtotal);
  assert.equal(shipping, 590, "free shipping starts at 49 €, so this order pays shipping");
  assert.equal(subtotal + shipping, 3588);
});

test("shipping: the accessory gets no special rule of its own", () => {
  // Shipping is a pure function of the merchandise subtotal, so an
  // accessory-only cart is priced by the same rule.
  assert.equal(computeShippingGrossCents("germany", PRICE_CENTS), 590);
  assert.equal(computeShippingGrossCents("germany", 4900), 0);
  const site = readFileSync(path.join(ROOT, "lib/shipping.ts"), "utf-8");
  assert.ok(!/metal[-_ ]?case/i.test(site), "shipping must know nothing about the accessory");
});

/* ── Checkout stays server-authoritative ────────────────────── */

test("checkout: the browser sends only variant id and quantity, never a price", () => {
  const clientQuote = readFileSync(path.join(ROOT, "app/checkoutQuote.ts"), "utf-8");
  const payload = clientQuote.slice(clientQuote.indexOf("const payload"), clientQuote.indexOf("const response"));
  assert.match(payload, /variantId/);
  assert.match(payload, /quantity/);
  assert.ok(!/unitPriceCents|price_gross_cents|unitGrossCents/.test(payload), "client must not send a price");
});

test("checkout: the server reads the accessory's price from the catalog", () => {
  const serverQuote = readFileSync(path.join(ROOT, "lib/checkoutQuote.ts"), "utf-8");
  assert.match(serverQuote, /from\("product_variants"\)/);
  assert.match(serverQuote, /price_gross_cents/);
  // And it no longer refuses a variant that has no weight.
  assert.match(serverQuote, /variant\.size_grams !== null/);
});

test("checkout: no fabricated size_grams metadata reaches Stripe", () => {
  const session = readFileSync(path.join(ROOT, "app/api/checkout/session/route.ts"), "utf-8");
  assert.match(session, /typeof item\.sizeGrams === "number" \? \{ size_grams/);
});
