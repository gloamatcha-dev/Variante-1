import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

test('initial B2B Finance is required and repairs an already active settlement exactly once', async () => {
  let active = false, fail = true, events = 0, activations = 0;
  const admin = { rpc: async () => {
    const result = active ? 'already_active' : 'activated';
    if (!active) activations++;
    active = true;
    return { data: { result }, error: null };
  }};
  const effect = { requireBusinessEffect: (name, value, accepted) => {
    if (!value || !accepted.includes(value.result)) throw Error(`Required ${name} not completed`);
  }, FINANCE_EFFECT_RESULTS: ['recorded', 'already_recorded'] };
  const loadedModule = { exports: {} };
  const source = ts.transpileModule(fs.readFileSync('lib/b2bWebhookDeps.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(source, { module: loadedModule, exports: loadedModule.exports, console, require: name => {
    if (name === './supabaseAdmin') return { getSupabaseAdmin: () => admin };
    if (name === './requiredBusinessEffect') return effect;
    if (name === './financeRecording') return { recordB2bInitialSettlement: async id => {
      assert.equal(id, 'agreement');
      if (fail) return null;
      if (events) return { result: 'already_recorded' };
      events++;
      return { result: 'recorded' };
    }};
    return {};
  }});
  const deps = loadedModule.exports.b2bWebhookDeps({ checkout: { sessions: {} }, invoices: {}, subscriptions: {} });
  const input = { agreementId: 'agreement', checkoutAttemptId: 'attempt', stripePaymentIntentId: 'pi' };
  await assert.rejects(deps.activateAnnual(input), /Required B2B initial settlement/);
  assert.equal(active, true);
  assert.equal(events, 0);
  fail = false;
  assert.equal((await deps.activateAnnual(input)).result, 'already_active');
  assert.equal(events, 1);
  assert.equal((await deps.activateAnnual(input)).result, 'already_active');
  assert.equal(events, 1);
  assert.equal(activations, 1);
});
