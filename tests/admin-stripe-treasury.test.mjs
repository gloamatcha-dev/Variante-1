import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readAdminStripeTreasury } from '../lib/adminStripeTreasury.ts';
import { createStripeReconciliationRead } from '../lib/stripeReconciliationClient.ts';

const identity = { accountId: 'acct_Test', paymentIntentId: 'pi_Proof', amountCents: 2090 };
const proof = { id: 'pi_Proof', livemode: true, amount_received: 2090, status: 'succeeded', currency: 'eur' };
const period = { from: '2026-07-01', to: '2026-08-01' };
const list = (data, has_more = false) => ({ data, has_more });
const invoice = { id: 'in_Open', status: 'open', livemode: true, currency: 'eur', amount_remaining: 1000 };
const payout = { id: 'po_Paid', status: 'paid', livemode: true, currency: 'eur', amount: 1500, created: Date.parse('2026-06-30T22:00:00Z') / 1000 };
const fixtures = {
  '/v1/payment_intents/pi_Proof': proof,
  '/v1/invoices': list([invoice, { ...invoice, id: 'in_NoDebt', amount_remaining: 0 }]),
  '/v1/payouts': list([payout, { ...payout, id: 'po_Outside', created: payout.created - 1 }]),
  '/v1/balance': { livemode: true, available: [{ amount: 600, currency: 'eur' }, { amount: 900, currency: 'usd' }], pending: [{ amount: 800, currency: 'eur' }] },
};

test('period payout, available-only balance and current invoice remainder stay separate', async () => {
  const actual = await readAdminStripeTreasury(async (path, params) => {
    if (path.endsWith('/invoices')) assert.deepEqual(params, { status: 'open', limit: '100' });
    return fixtures[path];
  }, identity, period);
  assert.deepEqual(actual.payouts, [{ id: 'po_Paid', status: 'paid', currency: 'eur', amount: 1500, created: payout.created, arrival: null }]);
  assert.deepEqual(actual.available, [{ amount: 600, currency: 'eur' }, { amount: 900, currency: 'usd' }]);
  assert.deepEqual(actual.invoices, [{ id: 'in_Open', due: null, amount: 1000, currency: 'eur' }]);
});

test('duplicate invoice on different pages is counted once', async () => {
  const actual = await readAdminStripeTreasury(async (path, params) => path.endsWith('/invoices')
    ? params.starting_after ? list([invoice]) : list([invoice], true) : fixtures[path], identity, period);
  assert.equal(actual.invoices.length, 1);
});

test('provider denial and incomplete invoices do not leak between sources', async () => {
  let page = 0;
  const actual = await readAdminStripeTreasury(async (path) => {
    if (path.endsWith('/balance')) throw Error('Permission denied');
    if (path.endsWith('/invoices')) return list([{ ...invoice, id: 'in_Test' + ++page }], true);
    return fixtures[path];
  }, identity, period);
  assert.equal(actual.invoices, null);
  assert.equal(actual.available, null);
  assert.equal(actual.payouts.length, 1);
});

test('sandbox identity is rejected before querying any finance resources', async () => {
  const paths = [];
  const actual = await readAdminStripeTreasury(async path => {
    paths.push(path);
    return { ...proof, livemode: false };
  }, identity, period);
  assert.deepEqual(actual, { payouts: null, available: null, invoices: null });
  assert.deepEqual(paths, ['/v1/payment_intents/pi_Proof']);
});

test('restricted adapter uses GET only, does not follow redirects, and rejects other resources', async () => {
  const read = createStripeReconciliationRead('rk_live_synthetic', async (url, request) => {
    assert.equal(url.origin, 'https://api.stripe.com');
    assert.equal(request.method, 'GET');
    assert.equal(request.redirect, 'error');
    return Response.json({ livemode: true });
  });
  await read('/v1/balance', {});
  await read('/v1/invoices', { status: 'open' });
  await read('/v1/payouts', {});
  await assert.rejects(read('/v1/transfers', {}));
});
