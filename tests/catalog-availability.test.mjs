import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { getReadOnlySupabaseClient } from "./helpers/catalog.mjs";
import { writeBlockedServerEnv } from "./helpers/testSupabase.mjs";
import {
  WITHHELD_PRODUCT_SLUGS,
  isProductWithheld,
  WITHHELD_PRODUCT_STATUS,
  WITHHELD_PRODUCT_MESSAGE,
} from "../lib/catalogAvailability.ts";

/**
 * A PRODUCT THE SHOP WILL NOT SELL, REFUSED AT EVERY LAYER.
 *
 * The GLOA Metal Case is not a launch product. Before this suite it was
 * hidden by ONE client-side array in app/GloaSite.tsx, which skipped its
 * card on /shop and nothing else - /shop/metal-case still rendered a
 * full purchase page to anyone who knew the slug, and the checkout
 * endpoint still accepted its variant id, because the row is active in
 * Supabase and the server had never heard of the list.
 *
 * What is asserted here is that all three surfaces now refuse it, and
 * that nothing about the product was deleted to achieve that.
 *
 * ── TWO INDEPENDENT REFUSALS, ON PURPOSE ──────────────────────
 *
 * supabase/migrations/047_withhold_metal_case.sql sets is_active=false
 * on both rows, which is the intended end state and the one that stops
 * anything reading Supabase directly from publishing the case. The
 * application list is the second: it keeps holding even if a row is
 * reactivated by mistake. Test 4 below reports which of the two is
 * currently doing the work, so "the migration has not been applied yet"
 * can never be mistaken for "the case is sellable".
 *
 * SAFE: read-only against the catalog, and the spawned server runs
 * without a service-role key so no row can be written.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf8");

const site = read("app/GloaSite.tsx");
const quote = read("lib/checkoutQuote.ts");
const availability = read("lib/catalogAvailability.ts");
const MIGRATION_REL = "supabase/migrations/047_withhold_metal_case.sql";

const PORT = 8962;
const BASE_URL = `http://127.0.0.1:${PORT}`;

let serverProcess;
/** The case's rows as the PUBLIC catalog currently reports them. */
let caseProduct = null;
let caseVariant = null;

test.before(async () => {
  const supabase = getReadOnlySupabaseClient();
  const { data: products } = await supabase
    .from("products").select("id, slug, name, is_active").eq("slug", "metal-case");
  caseProduct = products?.[0] ?? null;
  const { data: variants } = await supabase
    .from("product_variants").select("id, sku, price_gross_cents, currency, is_active").eq("sku", "GLOA-CASE-01");
  caseVariant = variants?.[0] ?? null;

  serverProcess = spawn(process.execPath, [".output/server/index.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: writeBlockedServerEnv({
      PORT: String(PORT),
      STRIPE_SECRET_KEY: "sk_test_catalog_availability_dummy",
      SITE_URL: BASE_URL,
    }),
    stdio: "ignore",
  });
  const ready = new Promise((resolveReady, rejectReady) => {
    serverProcess.once("exit", code => rejectReady(new Error(`server exited early (code ${code})`)));
    (async () => {
      for (let attempt = 0; attempt < 50; attempt++) {
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
   1. ONE LIST, READ BY THE PAGE AND BY THE SERVER
   ══════════════════════════════════════════════════════════════ */

test("1: the withheld list is a pure leaf both sides can read", () => {
  assert.deepEqual([...WITHHELD_PRODUCT_SLUGS], ["metal-case"]);
  assert.equal(isProductWithheld("metal-case"), true);
  assert.equal(isProductWithheld("matcha"), false);
  for (const notASlug of [null, undefined, "", "METAL-CASE", "metal-case ", "metal"]) {
    assert.equal(isProductWithheld(notASlug), false, `${JSON.stringify(notASlug)} matched`);
  }
  const code = availability.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\r\n]*/g, "");
  assert.ok(!/^\s*import /m.test(code), "the availability module grew an import");
  for (const banned of ["process.env", "supabase", "fetch(", "window."]) {
    assert.ok(!code.includes(banned), `the availability module reaches for ${banned}`);
  }
});

test("1b: the client list was moved, not duplicated", () => {
  // The array itself no longer lives in the component.
  assert.ok(!/Object\.freeze\(\["metal-case"\]\)/.test(site),
    "a second copy of the list is still hardcoded in the site component");
  assert.match(site, /import \{ isProductWithheld \} from "\.\.\/lib\/catalogAvailability";/);
  // The old name is gone rather than aliased - one name for one rule.
  // Checked as a DECLARATION: the prose above the filter still mentions
  // the old name to orient a reader, and banning the word outright would
  // only push the change to document itself less.
  assert.ok(!/\bconst SHOP_HIDDEN_SLUGS\s*=/.test(site), "the superseded alias survived");
  // The server reads the same module rather than its own copy.
  assert.match(quote, /from "\.\/catalogAvailability"/);
  assert.ok(!quote.includes('"metal-case"'), "the server hardcodes the slug instead of reading the list");
});

/* ══════════════════════════════════════════════════════════════
   2. ALL THREE SURFACES REFUSE IT
   ══════════════════════════════════════════════════════════════ */

test("2: /shop does not list it, and its price cannot set the hero's 'ab'", () => {
  assert.match(site, /const visibleShopProducts=\(products:CatalogProduct\[\]\)=>products\.filter\(p=>!isProductWithheld\(p\.slug\)\)/);
  // The hero's lowest price is computed from `shown`, never from the
  // full catalog - so a withheld 9,99 € cannot become "AB 9,99 €".
  assert.match(site, /const shown=visibleShopProducts\(products\);/);
  assert.match(site, /const lowestCents=Math\.min\(\.\.\.shown\.flatMap/);
});

test("2b: the detail route refuses it before rendering a purchase page", () => {
  const page = site.slice(site.indexOf("function ProductPage("), site.indexOf("// Unused - kept for"));
  assert.match(page, /if\(isProductWithheld\(product\.slug\)\)return shell\("Aktuell nicht verfügbar\."\);/);
  // The guard must precede both layouts, or it guards nothing.
  const guardAt = page.indexOf("isProductWithheld(product.slug)");
  for (const layout of ["<MatchaProductPage", "<AccessoryProductPage"]) {
    assert.ok(page.indexOf(layout) > guardAt, `${layout} can render before the guard`);
  }
});

test("2c: the authoritative quote refuses it, so a crafted request cannot buy it", () => {
  assert.match(quote, /if \(isProductWithheld\(productSlug\)\) \{\s*return fail\(WITHHELD_PRODUCT_STATUS, WITHHELD_PRODUCT_MESSAGE\);/);
  // Indistinguishable from an inactive product: same status, same words.
  assert.equal(WITHHELD_PRODUCT_STATUS, 409);
  assert.equal(WITHHELD_PRODUCT_MESSAGE, "Ein oder mehrere Produkte sind nicht mehr verfügbar.");
  assert.ok(quote.includes(`return fail(409, "${WITHHELD_PRODUCT_MESSAGE}")`),
    "the inactive-product refusal it is meant to mirror is gone");
});

test("2d: the quote endpoint actually refuses the case's live variant id", async t => {
  if (!caseVariant) return t.skip("the metal case is no longer in the public catalog at all");
  const res = await fetch(`${BASE_URL}/api/checkout/quote`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items: [{ variantId: caseVariant.id, quantity: 1 }] }),
  });
  const body = await res.json();
  assert.equal(res.status, 409);
  assert.equal(body.error, WITHHELD_PRODUCT_MESSAGE);
  // And the refusal never leaks the price it is withholding.
  assert.ok(!JSON.stringify(body).includes(String(caseVariant.price_gross_cents)),
    "the refusal published the withheld price");
});

test("2e: a cart mixing Matcha with the case is refused whole, not silently trimmed", async t => {
  if (!caseVariant) return t.skip("the metal case is no longer in the public catalog at all");
  const supabase = getReadOnlySupabaseClient();
  const { data } = await supabase.from("product_variants")
    .select("id").eq("sku", "GLOA-MATCHA-30G").eq("is_active", true);
  const matcha = data?.[0];
  assert.ok(matcha, "the 30 g variant could not be read");
  const res = await fetch(`${BASE_URL}/api/checkout/quote`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items: [
      { variantId: matcha.id, quantity: 1 },
      { variantId: caseVariant.id, quantity: 1 },
    ] }),
  });
  assert.equal(res.status, 409, "a mixed cart was priced anyway");
});

/* ══════════════════════════════════════════════════════════════
   3. NOTHING WAS DELETED
   ══════════════════════════════════════════════════════════════ */

test("3: everything the case needs to come back is still here", () => {
  assert.ok(existsSync(path.join(ROOT, "supabase/migrations/020_standalone_metal_case.sql")),
    "the case's publishing migration was removed");
  assert.match(read("lib/productPresentation.ts"), /"metal-case"/);
  assert.match(read("lib/tax.ts"), /"metal-case"/);
  assert.match(read("app/globals.css"), /\.shop-column\[id\$="metal-case"\]/);
  // The accessory layout itself is untouched and still reachable code.
  assert.match(site, /function AccessoryProductPage\(/);
});

test("3b: the withdrawal migration deactivates exactly two rows and deletes nothing", () => {
  assert.ok(existsSync(path.join(ROOT, MIGRATION_REL)), "047 is missing");
  const sql = read(MIGRATION_REL);
  const statements = sql.replace(/--[^\r\n]*/g, "").split(";").map(s => s.trim()).filter(Boolean);
  assert.equal(statements.length, 2, `expected exactly two statements, found ${statements.length}`);
  for (const statement of statements) {
    assert.match(statement, /^update /i, "047 contains something other than an update");
    assert.match(statement, /is_active = false/);
  }
  // Scoped to the case by its natural keys, and to nothing else.
  assert.match(sql, /p\.slug = 'metal-case'/);
  assert.match(sql, /v\.sku = 'GLOA-CASE-01'/);
  assert.match(sql, /where slug = 'metal-case'/);
  // Checked against the EXECUTABLE sql only. The comments name 'matcha'
  // on purpose - they tell the operator to verify it came through
  // untouched - and a guard that failed on that would be pushing the
  // migration to document itself less.
  const executable = statements.join(";").toLowerCase();
  for (const banned of ["delete from", "drop ", "truncate", "'matcha'", "gloa-matcha", "insert into"]) {
    assert.ok(!executable.includes(banned), `047 touches something it must not: ${banned}`);
  }
  // Idempotent by construction: an unconditional set to a constant.
  assert.ok(!/is_active = not /i.test(sql), "047 toggles instead of setting");
});

/* ══════════════════════════════════════════════════════════════
   4. WHICH REFUSAL IS CURRENTLY LOAD-BEARING
   ══════════════════════════════════════════════════════════════ */

test("4: the case is not purchasable - and it is visible which layer stops it", () => {
  // Both refusals are wanted. This test passes either way and REPORTS
  // the state, so an unapplied migration is never silently assumed.
  const productActive = caseProduct?.is_active === true;
  const variantActive = caseVariant?.is_active === true;
  if (caseProduct === null && caseVariant === null) {
    console.error("      catalog: the metal case is not in the public catalog (047 applied, or RLS hides it)");
  } else {
    console.error(`      catalog: product is_active=${productActive}, variant is_active=${variantActive}` +
      (productActive || variantActive
        ? " - 047 NOT YET APPLIED, the application list is what withholds it"
        : " - 047 applied"));
  }
  // Whatever the database says, the application must refuse it.
  assert.equal(isProductWithheld("metal-case"), true);
});
