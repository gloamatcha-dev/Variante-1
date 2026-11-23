import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { readSubscriptionPauseStatus } from '../lib/subscriptionPauseStatus.ts';

const localId = '23072064-4a5c-4116-88bf-d01199825fc9';
const stripeId = 'sub_synthetic';
const identity = { localId, stripeId };
const nextEnd = 1910000000;
const subscription = {
  id: stripeId, status: 'active', metadata: { gloa_subscription_id: localId },
  collection_method: 'charge_automatically', latest_invoice: { status: 'paid' },
  items: { has_more: false, data: [{
    current_period_end: nextEnd, price: { recurring: { interval: 'week', interval_count: 4 } },
  }] },
};

test('reports a genuine provider pause without inventing an effective date, and shows a confirmed renewed cycle', () => {
  const paused = { ...subscription, status: 'paused', latest_invoice: { status: 'open' } };
  assert.deepEqual(readSubscriptionPauseStatus(paused, identity), {
    state: 'paused', effectiveAt: null, nextCycleAt: null,
  });
  const resumed = readSubscriptionPauseStatus(subscription, identity, nextEnd * 1000 - 1);
  assert.deepEqual(resumed, {
    state: 'active', effectiveAt: null, nextCycleAt: new Date(nextEnd * 1000).toISOString(),
  });
});

test('fails closed for collection pause, open or missing invoices, schedules, stale cycles and foreign metadata', () => {
  for (const change of [
    { pause_collection: { behavior: 'void' } }, { latest_invoice: { status: 'open' } },
    { latest_invoice: 'in_unexpanded' }, { schedule: 'sub_sched_synthetic' },
    { metadata: { gloa_subscription_id: 'unrelated' } }, { pending_update: {} },
    { items: { ...subscription.items, has_more: true } }, { status: 'past_due' },
  ]) {
    assert.deepEqual(readSubscriptionPauseStatus({ ...subscription, ...change }, identity), {
      state: 'unconfirmed', effectiveAt: null, nextCycleAt: null,
    });
  }
  assert.equal(readSubscriptionPauseStatus(subscription, identity, nextEnd * 1000).state, 'unconfirmed');
});

test('status route requires the owner and permits actions only with isolated sandbox configuration', async () => {
  const source = readFileSync(new URL('../app/api/subscriptions/pause-status/route.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  const reads = [];
  let userId = null;
  let timeout = false;
  let sandboxKey = null;
  const actions = [];
  vm.runInNewContext(compiled, {
    module, exports: module.exports, Response, TextDecoder, Uint8Array,
    require(name) {
      if (name.endsWith('/verifyUser')) return { verifyBearerUser: async () => userId ? { userId } : null };
      if (name.endsWith('/supabaseAdmin')) return { getSupabaseAdmin: () => ({
        from: () => ({ select: () => ({ eq: (_column, id) => ({ eq: (column, owner) => ({
          maybeSingle: async () => {
            assert.equal(column, 'user_id');
            return { data: id === localId && owner === 'customer' ? {
              id, stripe_subscription_id: stripeId, status: 'active',
            } : null };
          },
        }) }) }) }),
      }) };
      if (name.endsWith('/subscriptionPauseActions.server')) return {
        sandboxPauseKey: () => sandboxKey,
        changeSandboxSubscriptionPause: async (_admin, target, action) => {
          actions.push([target.localId, target.stripeId, action]);
          return { state: 'scheduled', pauseAt: 1900000000 };
        },
      };
      if (name.endsWith('/stripe')) return { getStripeClient: () => ({ subscriptions: {
        retrieve: async (id, options) => {
          assert.equal(id, stripeId);
          assert.equal(options.expand[0], 'latest_invoice');
          reads.push(id);
          if (timeout) throw new Error('synthetic timeout');
          return subscription;
        },
      } }) };
      if (name.endsWith('/subscriptionPauseStatus.ts')) return { readSubscriptionPauseStatus };
      throw Error(name);
    },
  });
  const call = body => module.exports.POST(new Request('https://local.invalid/api/subscriptions/pause-status', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }));
  assert.equal((await call({ subscriptionId: localId })).status, 401);
  userId = 'other';
  assert.equal((await call({ subscriptionId: localId })).status, 404);
  userId = 'customer';

  assert.equal((await call({ subscriptionId: localId, action: 'resume' })).status, 409);
  assert.equal((await call({ subscriptionId: localId, action: 'cancel' })).status, 400);
  sandboxKey = 'sandbox fixture';
  userId = 'other';
  assert.equal((await call({ subscriptionId: localId, action: 'pause' })).status, 404);
  userId = 'customer';
  assert.equal((await call({ subscriptionId: localId, action: 'pause' })).status, 202);
  assert.deepEqual(actions, [[localId, stripeId, 'pause']]);
  assert.equal((await call({ subscriptionId: 'x'.repeat(260) })).status, 413);
  assert.equal(reads.length, 0);
  const results = await Promise.all([call({ subscriptionId: localId }), call({ subscriptionId: localId })]);
  for (const result of results) {
    assert.equal(result.headers.get('cache-control'), 'private, no-store');
    assert.equal((await result.json()).state, 'active');
  }
  timeout = true;
  assert.equal((await call({ subscriptionId: localId })).status, 503);
});

test('sandbox writes stay disabled in Production even with a test key and loopback configuration', () => {
  const source = readFileSync(new URL('../lib/subscriptionPauseActions.server.ts', import.meta.url), 'utf8')
    .replace('import.meta.env.VITE_SUPABASE_URL', 'fixtureUrl');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  const env = { VERCEL_ENV: 'production', GLOA_SANDBOX_PAUSE_ACTIONS: 'true', STRIPE_SECRET_KEY: 'sk_test_fixture' };
  vm.runInNewContext(compiled, {
    module, exports: module.exports, require: () => ({}), URL,
    fixtureUrl: 'http://127.0.0.1:54321', process: { env },
  });
  assert.equal(module.exports.sandboxPauseKey(), null);
  env.VERCEL_ENV = 'development';
  assert.equal(module.exports.sandboxPauseKey(), 'sk_test_fixture');
  env.STRIPE_SECRET_KEY = 'sk_live_fixture';
  assert.equal(module.exports.sandboxPauseKey(), null);
});
