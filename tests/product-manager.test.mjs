import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { validateProductDraft, validProductImage } from '../lib/productManagerRules.ts';
import { synchronizeProduct } from '../lib/productStripeSync.ts';
import { resolveProductCheckoutBindings, resolveProductPrice } from '../lib/productStripePrices.ts';
import { resolveTaxCategory, extractTaxFromGross } from '../lib/tax.ts';
import { buildItemsSnapshot } from '../lib/checkoutAttemptSnapshot.ts';
import { allocateDiscountedStripeLines } from '../lib/launchDiscountCart.ts';
import { productStripeMock } from './helpers/productStripeMock.mjs';

export const draft = (type = 'MERCH', labels = ['White / S', 'White / M', 'Blue / S']) => ({
  name: 'GLOA T-Shirt', slug: 't-shirt', product_type: type, short_description: 'Cotton shirt', description: 'Standalone physical goods',
  primary_image_path: 'https://images.example.invalid/shirt.jpg', sort_order: 0,
  variants: labels.map((label, n) => ({ id: randomUUID(), sku: 'TEST-' + randomUUID().slice(0, 8).toUpperCase(), label,
    size_grams: null, price_gross_cents: 2999 + n, currency: 'EUR', tax_category: 'general_goods_de',
    availability: 'available', inventory_item_id: null, is_active: true, sort_order: n })),
});
const syncRow = d => ({ ...d, id: randomUUID(), product_variants: d.variants, stripe_sync_revision: 1, stripe_sync_status: 'pending', stripe_product_id: null, archived_at: null });

test('Product validation strips privileged browser fields and rejects unsafe commercial data', () => {
  const d = draft();
  const validated = validateProductDraft({ ...d, is_active: true, stripe_product_id: 'prod_attacker', stripe_sync_status: 'synced',
    variants: d.variants.map(v => ({ ...v, stripe_price_id: 'price_attacker', tax_rate_percent: 0, product_id: randomUUID() })) });
  assert.deepEqual(validated, d);
  for (const patch of [{ product_type: 'DIGITAL' }, { slug: '../x' }, { primary_image_path: 'javascript:alert(1)' }]) assert.throws(() => validateProductDraft({ ...d, ...patch }));
  for (const patch of [{ price_gross_cents: 0 }, { currency: 'USD' }, { tax_category: 'free' }, { size_grams: -1 }, { inventory_item_id: 'bad' }]) assert.throws(() => validateProductDraft({ ...d, variants: [{ ...d.variants[0], ...patch }] }));
});
test('Image references are safe native HTTPS or raster public assets', () => {
  for (const path of ['/img/item.webp', 'https://cdn.example.com/item.png', '']) assert.equal(validProductImage(path), true);
  for (const path of ['data:image/png;base64,x', 'javascript:x', '//host/a', '/img/../x.jpg', 'https://user:password@host/a', '/img/x.svg']) assert.equal(validProductImage(path), false);
});
for (const [type, labels] of [['MERCH', ['White / S', 'White / M', 'White / L', 'Blue / S', 'Blue / M', 'Blue / L']], ['ACCESSORY', ['Whisk']], ['BUNDLE', ['Gift Set']]]) {
  test(type + ' creates one canonical Product and individual immutable variant Prices', async () => {
    const mock = productStripeMock(), p = syncRow(draft(type, labels));
    const first = await synchronizeProduct(mock.adapter, p), replay = await synchronizeProduct(mock.adapter, p);
    assert.deepEqual(replay, first); assert.equal(mock.products.size, 1); assert.equal(mock.prices.size, labels.length);
    for (const price of mock.prices.values()) assert.equal(price.product, first.productId);
  });
}
test('Timeout after Product creation reconciles on retry without duplicate objects', async () => {
  const mock = productStripeMock(), p = syncRow(draft()); mock.timeoutProduct();
  await assert.rejects(synchronizeProduct(mock.adapter, p));
  await synchronizeProduct(mock.adapter, p); assert.equal(mock.products.size, 1); assert.equal(mock.prices.size, 3);
});
test('Timeout after Price creation and parallel retries reuse verified lookup winners', async () => {
  const mock = productStripeMock(), p = syncRow(draft()); mock.timeoutPrice();
  const [a, b] = await Promise.all([synchronizeProduct(mock.adapter, p), synchronizeProduct(mock.adapter, p)]);
  assert.deepEqual(a, b); assert.equal(mock.products.size, 1); assert.equal(mock.prices.size, 3);
});
test('Stripe failure recovers; changed price uses new Price and preserves prior commercial objects', async () => {
  const mock = productStripeMock(), p = syncRow(draft()); mock.setFailure(true);
  await assert.rejects(synchronizeProduct(mock.adapter, p)); assert.equal(mock.products.size, 0);
  mock.setFailure(false); const first = await synchronizeProduct(mock.adapter, p);
  const historical = JSON.stringify([...mock.prices.values()]);
  const next = structuredClone(p); next.stripe_product_id = first.productId; next.stripe_sync_revision++;
  next.product_variants[0].price_gross_cents += 500;
  const second = await synchronizeProduct(mock.adapter, next);
  assert.notEqual(second.prices[0].price_id, first.prices[0].price_id);
  assert.equal(JSON.stringify([...mock.prices.values()].slice(0, 3)), historical);
});
test('Inactive or wrong-product Stripe lookup is rejected, including concurrent winner verification', async () => {
  const mock = productStripeMock(), input = { productId: 'prod_test', variantId: randomUUID(), revision: 1, amount: 100, purpose: 'base' };
  await resolveProductPrice(mock.adapter, input);
  const price = [...mock.prices.values()][0]; price.active = false;
  await assert.rejects(resolveProductPrice(mock.adapter, input), /mismatch/);
  price.active = true; price.product = 'prod_attacker';
  await assert.rejects(resolveProductPrice(mock.adapter, input), /mismatch/);
});
test('Discount-derived Stripe Prices preserve exact allocator cents and stable frozen bindings', async () => {
  const mock = productStripeMock(), p = syncRow(draft('ACCESSORY', ['Whisk'])), synced = await synchronizeProduct(mock.adapter, p);
  const item = { variantId: p.product_variants[0].id, stripeProductId: synced.productId, stripePriceId: synced.prices[0].price_id,
    stripeSyncRevision: 1, quantity: 3, unitGrossCents: 2999, lineGrossCents: 8997 };
  const lines = allocateDiscountedStripeLines([item], [100]);
  const a = await resolveProductCheckoutBindings(mock.adapter, [item], lines);
  const count = mock.prices.size;
  assert.equal(a.reduce((n, b) => n + b.quantity * b.unitGrossCents, 0), 8897);
  assert.deepEqual(await resolveProductCheckoutBindings(mock.adapter, [item], lines), a);
  assert.equal(mock.prices.size, count);
});
test('Catalogue tax overrides identity; unknown classification fails closed; snapshots survive later pricing', () => {
  assert.equal(resolveTaxCategory({ sku: 'GLOA-MATCHA-30G', catalogTaxCategory: 'general_goods_de' }), 'general_goods_de');
  assert.equal(resolveTaxCategory({ sku: 'GLOA-MATCHA-30G', catalogTaxCategory: null }), null);
  const item = { productId: randomUUID(), productName: 'Whisk', productSlug: 'whisk', variantId: randomUUID(), sku: 'WHISK-01', label: 'Whisk', sizeGrams: null, quantity: 1, unitGrossCents: 1000, lineGrossCents: 1000 };
  const snapshot = buildItemsSnapshot({ currency: 'EUR', items: [item], subtotalGrossCents: 1000 });
  const tax = extractTaxFromGross(snapshot[0].lineGrossCents, 19);
  item.unitGrossCents = 1500;
  assert.equal(snapshot[0].unitGrossCents, 1000); assert.deepEqual(extractTaxFromGross(snapshot[0].lineGrossCents, 19), tax);
});
test('Migration 083 defines no automatic Inventory/contract/history writers and denies browser execution', () => {
  const sql = readFileSync('supabase/migrations/083_admin_product_manager.sql', 'utf8');
  assert.doesNotMatch(sql, /(?:update|insert into|delete from) public\.(?:orders|order_items|subscriptions|annual_plans|inventory_items|inventory_movements|financial_events)\b/i);
  assert.match(sql, /from public,anon,authenticated;/); assert.match(sql, /to service_role;/);
  assert.doesNotMatch(sql, /create (?:or replace )?trigger/i);
});
test('Product Manager client modules and built browser assets contain no provider/admin credentials', () => {
  for (const file of ['app/AdminProducts.tsx', 'app/GenericProductPage.tsx', 'lib/productManagerRules.ts']) {
    assert.doesNotMatch(readFileSync(file, 'utf8'), /supabaseAdmin|productStripeSync|productStripePrices|STRIPE_SECRET_KEY|SUPABASE_SECRET_KEY/);
  }
  // Build artifacts are inspected when present; the source boundary always runs.
  let files;
  try { files = readdirSync('.output/public', { recursive: true }).filter(f => f.endsWith('.js')); } catch { return; }
  for (const file of files) {
    const code = readFileSync('.output/public/' + file, 'utf8');
    assert.doesNotMatch(code, /\bsk_(?:live|test)_[A-Za-z0-9]{16,}|\bsb_secret_[A-Za-z0-9_-]{16,}/, file);
    for (const token of code.match(/[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}/g) ?? []) {
      try { assert.notEqual(JSON.parse(Buffer.from(token.split('.')[1], 'base64url')).role, 'service_role', file); }
      catch (error) { if (error.code === 'ERR_ASSERTION') throw error; }
    }
  }
});
