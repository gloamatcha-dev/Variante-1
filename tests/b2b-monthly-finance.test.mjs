import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {requireBusinessEffect, FINANCE_EFFECT_RESULTS} from '../lib/requiredBusinessEffect.ts';

test('monthly settlement requires Finance, repairs already_settled and never uses the annual schedule lookup', async () => {
  let settled = false, fail = true, deliveries = 0, events = 0;
  const admin = { rpc: async name => {
    if (name === 'release_b2b_deliveries_after_payment') return { data: { result: 'released' }, error: null };
    assert.equal(name, 'settle_b2b_monthly_paid_invoice');
    const result = settled ? 'already_settled' : 'activated';
    if (!settled) deliveries++;
    settled = true;
    return { data: { result, delivery_number: 1 }, error: null };
  }};
  const loadedModule = { exports: {} };
  const source = ts.transpileModule(fs.readFileSync('lib/b2bWebhookDeps.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(source, { module: loadedModule, exports: loadedModule.exports, console, require: name => {
    if (name === './supabaseAdmin') return { getSupabaseAdmin: () => admin };
    if (name === './requiredBusinessEffect') return {
      requireBusinessEffect: (label, value, accepted) => {
        if (!value || !accepted.includes(value.result)) throw Error(`Required ${label} not completed`);
      }, FINANCE_EFFECT_RESULTS: ['recorded', 'already_recorded'],
    };
    if (name === './financeRecording') return {
      recordB2bSettlementByInvoice: () => { throw Error('Monthly must not use annual schedule lookup'); },
      recordB2bMonthlyInvoiceEvent: async (agreement, invoice) => {
        assert.equal(agreement, 'agreement');assert.equal(invoice, 'invoice');
        if (fail) return null;
        if (events) return { result: 'already_recorded' };
        events++;return { result: 'recorded' };
      },
    };
    return {};
  }});
  const deps = loadedModule.exports.b2bWebhookDeps({ checkout: { sessions: {} }, invoices: { list: async () => ({ data: [], has_more: false }) }, subscriptions: {} });
  const input = { agreementId: 'agreement', stripeSubscriptionId: 'subscription', stripeInvoiceId: 'invoice' };
  await assert.rejects(deps.settleMonthlyInvoice(input), /Required B2B monthly settlement/);
  assert.equal(deliveries, 1);assert.equal(events, 0);
  fail = false;
  assert.equal((await deps.settleMonthlyInvoice(input)).result, 'already_settled');
  assert.equal(events, 1);
  assert.equal((await deps.settleMonthlyInvoice(input)).result, 'already_settled');
  assert.equal(events, 1);assert.equal(deliveries, 1);
});

test('monthly release checks all unpaid periods, paginates, and failed release remains repairable', async () => {
  let owed = true, releaseFails = false, releases = 0;
  const loadedModule = {exports:{}};
  const admin = {rpc: async name => {
    if(name === 'settle_b2b_monthly_paid_invoice') return {data:{result:'already_settled'}};
    if(name === 'hold_b2b_deliveries_for_payment')return {data:{result:'held'}};
    assert.equal(name,'release_b2b_deliveries_after_payment');
    releases++;
    return {data:{result:releaseFails?'rpc_error':'released'}};
  }};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('lib/b2bWebhookDeps.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{
    module:loadedModule,exports:loadedModule.exports,console,require:name=>{
      if(name==='./supabaseAdmin')return {getSupabaseAdmin:()=>admin};
      if(name==='./requiredBusinessEffect')return {requireBusinessEffect,FINANCE_EFFECT_RESULTS};
      if(name==='./financeRecording')return {recordB2bMonthlyInvoiceEvent:async()=>({result:'already_recorded'})};
      return {};
    },
  });
  const stripe={checkout:{sessions:{}},subscriptions:{},invoices:{list:async p=>p.status==='uncollectible'?{data:[],has_more:false}:p.starting_after?{data:[{id:'in_2',amount_remaining:owed?100:0}],has_more:false}:{data:[{id:'in_1',amount_remaining:0}],has_more:true}}};
  const deps=loadedModule.exports.b2bWebhookDeps(stripe),input={agreementId:'agreement',stripeSubscriptionId:'sub',stripeInvoiceId:'in_recovered'};
  await deps.settleMonthlyInvoice(input);assert.equal(releases,0,'another unpaid period preserves holds');
  owed=false;releaseFails=true;
  await assert.rejects(deps.settleMonthlyInvoice(input),/Required B2B monthly delivery release/);
  releaseFails=false;await deps.settleMonthlyInvoice(input);assert.equal(releases,2);
  stripe.invoices.list=async()=>{throw Error('Provider unavailable');};
  await assert.rejects(deps.settleMonthlyInvoice(input),/Provider unavailable/);assert.equal(releases,2);
});
