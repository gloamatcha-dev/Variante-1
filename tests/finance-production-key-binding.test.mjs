import assert from 'node:assert/strict';
import {test} from 'node:test';
import {verifyProductionKeyBinding} from '../lib/financeProductionKeyBinding.ts';

const paymentId = 'pi_3UNcyODI76FH9qsq15ToRfXY';
const payment = {id: paymentId, livemode: true, currency: 'eur', status: 'succeeded', amount_received: 23268};
const config = {owner_id: 'owner', account_id: 'acct_1U6B3ODI76FH9qsq', known_payment_intent: paymentId, known_amount_cents: 23268};
const commit = 'a'.repeat(40);

function fixture() {
  const calls = {claims: [], reads: []};
  const used = new Map();
  const options = {
    ownerId: 'owner',
    confirm: 'VERIFY_ONE_PRODUCTION_PAYMENT_INTENT',
    env: {VERCEL_ENV: 'production', VERCEL_GIT_COMMIT_SHA: commit, FINANCE_KEY_BINDING_APPROVED_COMMIT: commit, STRIPE_RECONCILIATION_READ_KEY: 'rk_live_synthetic'},
    loadConfig: async () => config,
    async consume(args) {
      calls.claims.push(args);
      if (used.has(args.p_operation_id)) return used.get(args.p_operation_id) === args.p_entity_id;
      used.set(args.p_operation_id, args.p_entity_id);
      return true;
    },
    async request(url, init) {
      calls.reads.push([url.href, init.method, init.redirect]);
      return Response.json(payment);
    },
  };
  return {options, calls};
}

test('missing approval, wrong deploy, wrong confirmation or invalid reference cannot claim or read', async () => {
  for (const change of [
    {env: {}}, {env: {VERCEL_ENV: 'preview'}}, {confirm: false}, {ownerId: 'other'},
    {loadConfig: async () => null}, {loadConfig: async () => ({...config, known_amount_cents: 1})},
  ]) {
    const {options, calls} = fixture();
    assert.equal(await verifyProductionKeyBinding({...options, ...change}), false);
    assert.deepEqual(calls, {claims: [], reads: []});
  }
});

test('concurrent requests and later replay share one claim and produce exactly one bounded GET', async () => {
  const {options, calls} = fixture();
  assert.deepEqual((await Promise.all([verifyProductionKeyBinding(options), verifyProductionKeyBinding(options)])).sort(), [false, true]);
  assert.equal(await verifyProductionKeyBinding(options), false);
  assert.equal(new Set(calls.claims.map(claim => claim.p_operation_id)).size, 1);
  assert.equal(new Set(calls.claims.map(claim => claim.p_entity_id)).size, 3);
  assert.deepEqual(calls.reads, [[`https://api.stripe.com/v1/payment_intents/${paymentId}`, 'GET', 'error']]);
});

test('an uncertain database claim never starts a provider read', async () => {
  const {options, calls} = fixture();
  assert.equal(await verifyProductionKeyBinding({...options, consume: async () => { throw Error('uncertain'); }}), false);
  assert.equal(calls.reads.length, 0);
});

test('a provider failure consumes the attempt without retries', async () => {
  const {options, calls} = fixture();
  let attempts = 0;
  const failing = {...options, request: async () => { attempts++; throw Error('timeout'); }};
  assert.equal(await verifyProductionKeyBinding(failing), false);
  assert.equal(await verifyProductionKeyBinding(options), false);
  assert.equal(attempts, 1);
  assert.equal(calls.reads.length, 0);
});

test('each mismatched payment field fails closed', async () => {
  for (const field of Object.keys(payment)) {
    const {options} = fixture();
    assert.equal(await verifyProductionKeyBinding({
      ...options, request: async () => Response.json({...payment, [field]: null}),
    }), false);
  }
});
