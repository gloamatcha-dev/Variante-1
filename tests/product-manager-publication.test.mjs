import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { synchronizeProduct } from '../lib/productStripeSync.ts';
import { productStripeMock } from './helpers/productStripeMock.mjs';
import { productSafetyRoute } from './helpers/productSafetyRoute.mjs';

async function setup() {
  const stripe = productStripeMock();
  const p = { id: randomUUID(), name: 'Besen', slug: 'besen', is_active: false, archived_at: null,
    stripe_sync_revision: 1, stripe_sync_status: 'pending', stripe_product_id: null,
    product_variants: [{ id: randomUUID(), sku: 'GLOA-BESEN-01', label: 'Natur', is_active: true, availability: 'available',
      price_gross_cents: 1499, currency: 'EUR', tax_category: 'general_goods_de' }] };
  const result = await synchronizeProduct(stripe.adapter, p);
  p.stripe_product_id = result.productId; p.stripe_sync_status = 'synced';
  p.product_variants[0].stripe_price_id = result.prices[0].price_id;
  return { p, stripe };
}
const request = (p, action = 'publish') => ({ action, id: p.id, operationId: randomUUID(), revision: p.stripe_sync_revision });

test('Publication verifies remote objects read-only before invoking the deliberate state transition', async () => {
  const { p, stripe } = await setup(), app = productSafetyRoute(p, stripe.adapter);
  const before = JSON.stringify([...stripe.products.values(), ...stripe.prices.values()]);
  const result = await app.post(request(p));
  assert.equal(result.status, 200); assert.equal(app.calls.length, 1);
  assert.equal(app.calls[0].name, 'admin_product_state_v1'); assert.equal(app.calls[0].args.p_action, 'published');
  assert.equal(JSON.stringify([...stripe.products.values(), ...stripe.prices.values()]), before);
});

test('Unavailable, stale, incomplete or inactive mappings block publication without a database mutation', async () => {
  for (const mode of ['product', 'price', 'missing-product', 'missing-price', 'pending', 'revision', 'provider']) {
    const { p, stripe } = await setup(), body = request(p);
    if (mode === 'product') stripe.products.get(p.stripe_product_id).active = false;
    if (mode === 'price') [...stripe.prices.values()][0].active = false;
    if (mode === 'missing-product') p.stripe_product_id = null;
    if (mode === 'missing-price') p.product_variants[0].stripe_price_id = null;
    if (mode === 'pending') p.stripe_sync_status = 'pending';
    if (mode === 'revision') body.revision--;
    if (mode === 'provider') stripe.setFailure(true);
    const app = productSafetyRoute(p, stripe.adapter), result = await app.post(body);
    assert.equal(result.status, 409, mode); assert.equal(app.calls.length, 0, mode);
  }
});

test('Database rejection of publication is surfaced as failure even after a healthy preflight', async () => {
  const { p, stripe } = await setup();
  const app = productSafetyRoute(p, stripe.adapter, { rpc: async () => ({ error: { message: 'Stale revision' } }) });
  const result = await app.post(request(p));
  assert.equal(result.status, 409); assert.match((await result.json()).error, /Status nicht geändert/);
});

test('Lost local sync persistence does not lose remote identity on the next revision', async () => {
  const { p, stripe } = await setup();
  p.stripe_sync_status = 'pending'; p.stripe_product_id = null; p.product_variants[0].stripe_price_id = null;
  const app = productSafetyRoute(p, stripe.adapter, { rpc: async () => ({ error: { message: 'Revision changed' } }) });
  assert.equal((await app.post(request(p, 'sync'))).status, 409);
  p.stripe_sync_revision++;
  const retry = productSafetyRoute(p, stripe.adapter);
  assert.equal((await retry.post(request(p, 'sync'))).status, 200);
  assert.equal(stripe.products.size, 1);
  assert.equal(retry.calls[0].name, 'admin_product_sync_result_v1');
});

test('Ambiguous remote identity is displayed as review required and never persisted as success', async () => {
  const { p, stripe } = await setup();
  p.stripe_product_id = null; p.stripe_sync_status = 'pending';
  stripe.products.set('prod_duplicate', { id: 'prod_duplicate', active: true, metadata: { gloa_product_id: p.id } });
  const app = productSafetyRoute(p, stripe.adapter), result = await app.post(request(p, 'sync'));
  assert.equal(result.status, 502); assert.match((await result.json()).error, /Zuordnung vor einem neuen Versuch prüfen/);
  assert.equal(app.calls.length, 1); assert.equal(app.calls[0].name, 'admin_product_sync_result_v1');
  assert.equal(app.calls[0].args.p_stripe_product_id, null); assert.match(app.calls[0].args.p_error, /prüfen/);
});

test('Actual checkout eligibility rejects drafts, pending, unavailable and missing mappings; accepts valid published product', async () => {
  for (const mode of ['valid', 'draft', 'pending', 'sold-out', 'inactive', 'unmapped-product', 'unmapped-price', 'archived']) {
    const { p, stripe } = await setup(); p.is_active = mode !== 'draft';
    if (mode === 'pending') p.stripe_sync_status = 'pending';
    if (mode === 'archived') p.archived_at = new Date().toISOString();
    if (mode === 'unmapped-product') p.stripe_product_id = null;
    const v = { ...p.product_variants[0], product_id: p.id, products: p };
    if (mode === 'sold-out') v.availability = 'sold_out';
    if (mode === 'inactive') v.is_active = false;
    if (mode === 'unmapped-price') v.stripe_price_id = null;
    const catalogue = { from: () => ({ select: () => ({ in: async () => ({ data: [v], error: null }) }) }) };
    const app = productSafetyRoute(p, stripe.adapter, { catalogue });
    const result = await app.load('lib/checkoutQuote.ts').buildAuthoritativeQuote([{ variantId: v.id, quantity: 2 }]);
    assert.equal(result.ok, mode === 'valid', mode);
    if (result.ok) assert.equal(result.quote.subtotalGrossCents, 2998);
  }
});
