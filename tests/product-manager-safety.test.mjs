import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { synchronizeProduct, verifyProductStripeMapping } from '../lib/productStripeSync.ts';
import { canonicalStripeProductId } from '../lib/productStripeIdentity.ts';
import { productStripeMock } from './helpers/productStripeMock.mjs';

function product() {
  return { id: randomUUID(), name: 'GLOA Bambusbesen', stripe_product_id: null,
    stripe_sync_revision: 1, stripe_sync_status: 'pending', archived_at: null,
    product_variants: [{ id: randomUUID(), sku: 'GLOA-BESEN-01', label: 'Natur',
      size_grams: null, price_gross_cents: 1499, currency: 'EUR', tax_category: 'general_goods_de',
      availability: 'available', inventory_item_id: null, is_active: true, sort_order: 0 }] };
}
async function completed(mock, p) {
  const result = await synchronizeProduct(mock.adapter, p);
  return { ...p, stripe_product_id: result.productId, stripe_sync_status: 'synced',
    product_variants: p.product_variants.map(v => ({ ...v, stripe_price_id: result.prices.find(x => x.variant_id === v.id).price_id })) };
}

test('Interrupted first sync after Product acceptance and Price failure recovers after name/revision change', async () => {
  const mock = productStripeMock(), p = product();
  const create = mock.adapter.prices.create;
  mock.adapter.prices.create = async () => { throw Error('Price failed after Product acceptance'); };
  await assert.rejects(synchronizeProduct(mock.adapter, p));
  assert.equal(mock.products.size, 1); assert.equal(p.stripe_product_id, null);
  mock.expireIdempotency(); mock.adapter.prices.create = create;
  const result = await synchronizeProduct(mock.adapter, { ...p, name: 'Geänderter Name', stripe_sync_revision: 2 });
  assert.equal(result.productId, [...mock.products.keys()][0]);
  assert.equal(mock.products.size, 1);
});

test('Concurrent retries across revisions use one Product and one Price per distinct immutable binding', async () => {
  const mock = productStripeMock(), p = product();
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => synchronizeProduct(mock.adapter, { ...p, stripe_sync_revision: 1 + i % 2 })));
  assert.equal(new Set(results.map(r => r.productId)).size, 1);
  assert.equal(mock.products.size, 1); assert.equal(mock.prices.size, 2);
});

test('Permanent Product ID wins even when concurrent listings omit a just-created object and keys expire', async () => {
  const mock = productStripeMock(), p = product();
  await synchronizeProduct(mock.adapter, p); mock.expireIdempotency();
  mock.adapter.products.list = async () => ({ data: [], has_more: false });
  const results = await Promise.all([synchronizeProduct(mock.adapter, p), synchronizeProduct(mock.adapter, { ...p, stripe_sync_revision: 2 })]);
  assert.ok(results.every(r => r.productId === canonicalStripeProductId(p.id)));
  assert.equal(mock.products.size, 1);
});

test('Old random Product is recovered by exact local metadata across list pages without mutation', async () => {
  const mock = productStripeMock(), p = product();
  for (let i = 0; i < 105; i++) mock.products.set('prod_other' + i, { id: 'prod_other' + i, active: true, metadata: {} });
  const legacy = { id: 'prod_legacy', name: 'Original', active: true, metadata: { gloa_product_id: p.id, gloa_revision: '1' } };
  mock.products.set(legacy.id, legacy);
  const before = JSON.stringify([...mock.products.values()]);
  const result = await synchronizeProduct(mock.adapter, { ...p, stripe_sync_revision: 5 });
  assert.equal(result.productId, legacy.id); assert.equal(JSON.stringify([...mock.products.values()]), before);
});

test('Ambiguous, inactive, unrelated and missing existing Product mappings fail without creating anything', async () => {
  for (const mode of ['ambiguous', 'inactive', 'unrelated', 'missing', 'collision']) {
    const mock = productStripeMock(), p = product();
    if (mode === 'missing') p.stripe_product_id = 'prod_missing';
    else if (mode === 'collision') mock.products.set(canonicalStripeProductId(p.id), { id: canonicalStripeProductId(p.id), active: true, metadata: { gloa_product_id: randomUUID() } });
    else {
      mock.products.set('prod_old', { id: 'prod_old', active: mode !== 'inactive', metadata: { gloa_product_id: mode === 'unrelated' ? randomUUID() : p.id } });
      if (mode === 'ambiguous') mock.products.set('prod_duplicate', { id: 'prod_duplicate', active: true, metadata: { gloa_product_id: p.id } });
      else p.stripe_product_id = 'prod_old';
    }
    const before = JSON.stringify([...mock.products.values()]);
    await assert.rejects(synchronizeProduct(mock.adapter, p), undefined, mode);
    assert.equal(JSON.stringify([...mock.products.values()]), before); assert.equal(mock.prices.size, 0);
  }
});

test('Failed/incomplete list never proves absence and never triggers Product creation', async () => {
  for (const mode of ['transport', 'empty-page', 'repeated-page', 'limit']) {
    const mock = productStripeMock(), p = product(); let calls = 0;
    mock.adapter.products.list = async () => {
      calls++;
      if (mode === 'transport') throw Error('Listing failed');
      return { data: mode === 'empty-page' ? [] : [{ id: 'prod_other' + (mode === 'limit' ? calls : 1), metadata: {} }], has_more: true };
    };
    await assert.rejects(synchronizeProduct(mock.adapter, p));
    assert.ok(calls <= 100); assert.equal(mock.products.size, 0); assert.equal(mock.prices.size, 0);
  }
});

test('Published mapping preflight is read-only and rejects missing/inactive/mismatched Prices', async () => {
  for (const mode of ['valid', 'inactive-product', 'inactive-price', 'missing-price', 'unmapped', 'wrong-amount', 'wrong-product', 'wrong-variant', 'pending']) {
    const mock = productStripeMock(); const p = await completed(mock, product());
    const price = [...mock.prices.values()][0];
    if (mode === 'inactive-product') mock.products.get(p.stripe_product_id).active = false;
    if (mode === 'inactive-price') price.active = false;
    if (mode === 'missing-price') mock.prices.clear();
    if (mode === 'unmapped') p.product_variants[0].stripe_price_id = null;
    if (mode === 'wrong-amount') price.unit_amount++;
    if (mode === 'wrong-product') price.product = 'prod_unrelated';
    if (mode === 'wrong-variant') price.metadata.gloa_variant_id = randomUUID();
    if (mode === 'pending') p.stripe_sync_status = 'pending';
    const before = JSON.stringify([...mock.products.values(), ...mock.prices.values()]);
    if (mode === 'valid') await verifyProductStripeMapping(mock.adapter, p);
    else await assert.rejects(verifyProductStripeMapping(mock.adapter, p), undefined, mode);
    assert.equal(JSON.stringify([...mock.products.values(), ...mock.prices.values()]), before);
  }
});

test('Price edit preserves every historical Price and existing verified Product', async () => {
  const mock = productStripeMock(), p = await completed(mock, product());
  const old = JSON.stringify([...mock.prices.values()]);
  p.stripe_sync_revision++; p.stripe_sync_status = 'pending'; p.product_variants[0].price_gross_cents += 100;
  const result = await synchronizeProduct(mock.adapter, p);
  assert.equal(result.productId, p.stripe_product_id); assert.equal(mock.products.size, 1);
  assert.equal(JSON.stringify([...mock.prices.values()].slice(0, 1)), old); assert.equal(mock.prices.size, 2);
});
