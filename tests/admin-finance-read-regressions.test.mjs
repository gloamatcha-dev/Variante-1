import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { summarizeLedger } from '../lib/adminPortalFinance.ts';
import { readFinanceSummary } from '../lib/adminPortalFinanceRead.ts';
import { readPortalPages } from '../lib/adminPortalRead.ts';
import { financeSyncCoverage } from '../lib/financeSyncMonitoring.ts';
import { adminFinanceSyncStatus } from '../lib/adminFinanceSyncStatus.ts';
import { globalFinanceSyncStatus } from '../lib/globalFinanceSync.ts';
import { emptyDashboardQuery } from './helpers/dashboardFinanceRoutes.mjs';

const basis = {
  subjects: [], coverage: [], months: [], generalCoverage: [], undatedEvents: 0, undatedFulfilments: 0,
  sourceCoverage: { status: 'checked', complete: true, missingPayments: 0, missingRefunds: 0, conflicts: 0 },
};

test('unknown or overflowing cents never produce a complete finance result', () => {
  const payment = { id: 'p', kind: 'order_payment', direction: 'inflow', gross_cents: 1000 };
  const evidence = [{ income_event_id: 'p', capture_status: 'checked', fee_cents: 0 }];
  assert.equal(summarizeLedger([payment], [], evidence, basis).resultCents, 1000);
  for (const cents of [null, NaN, Infinity, 1.5]) {
    const direct = summarizeLedger([payment], [{ category: 'shipping', gross_cents: cents }], evidence, basis);
    assert.equal(direct.contributionMarginCents, null);
    assert.equal(direct.contributionComplete, false);
    assert.equal(direct.resultCents, null);
    const general = summarizeLedger([payment], [{ category: 'general', gross_cents: cents }], evidence, basis);
    assert.equal(general.contributionMarginCents, 1000);
    assert.equal(general.resultCents, null);
  }
  const overflow = summarizeLedger([payment], [
    { category: 'shipping', gross_cents: Number.MAX_SAFE_INTEGER }, { category: 'shipping', gross_cents: 1 },
  ], evidence, basis);
  assert.equal(overflow.directCostCents, null);
  assert.equal(overflow.resultComplete, false);
});

const coverage = {
  configured: true, state: 'complete', missing_payments: 0, missing_refunds: 0,
  missing_fees: 0, unresolved: 0, persistent_failures: 0, unbridged_events: 0,
};

test('November report exposes the partial verified Stripe interval without certifying the month', () => {
  const now=Date.parse('2026-11-21T19:30:00Z');
  const status={...coverage,last_success_at:'2026-11-21T19:24:30Z',
    verified_from:'2026-11-12T23:00:00Z',verified_to:'2026-11-21T19:24:29Z'};
  const november=financeSyncCoverage(status,{from:'2026-11-01',to:'2026-12-01'},now);
  assert.equal(november.verified,false);
  assert.equal(november.coveredFrom,'2026-11-12T23:00:00.000Z');
  assert.equal(november.coveredTo,'2026-11-21T19:24:29.000Z');
  const october=financeSyncCoverage(status,{from:'2026-10-01',to:'2026-11-01'},now);
  assert.equal(october.coveredFrom,null);
  assert.equal(october.coveredTo,null);
});

test('dashboard uses Berlin windows, excludes historical retries and reports only continuous coverage', () => {
  const scope = '2026-11-12T23:00:00Z';
  const raw = { ...coverage, state: 'retry', monitoring_version: 1, unknown_refund_tax: 8,
    scan_modes: { version: 2, daily_latest_verified: true, daily_cutoff: '2026-11-21T13:56:00Z' } };
  const jobs = [
    { scan_from: '2026-08-31T22:00:00Z', state: 'retry', attempts: 2 },
    { scan_from: scope, scan_to: '2026-11-21T12:59:00Z', completed_at: '2026-11-21T12:59:20Z',
      state: 'completed', attempts: 1, checkpoint: { verified: true } },
    { scan_from: '2026-11-21T19:00:00Z', scan_to: '2026-11-21T19:24:00Z', completed_at: '2026-11-21T19:24:20Z',
      state: 'completed', attempts: 1, checkpoint: { verified: true } },
  ];
  const status = adminFinanceSyncStatus(raw, true, scope, jobs, Date.parse('2026-11-21T20:25:00Z'));
  assert.equal(status.next_sync_window, '2026-11-22T12:00:00.000Z');
  assert.equal(status.next_verify_window, '2026-11-22T13:00:00.000Z');
  assert.equal(status.verified, true);
  assert.equal(status.daily_verified, true);
  assert.equal(status.retry_attempts, 0);
  assert.equal(status.historical_retry_jobs, 1);
  assert.equal(status.historical_retry_attempts, 1);
  assert.equal(status.unknown_refund_tax, 8);
  assert.equal(status.verified_to, '2026-11-21T12:59:00.000Z');
  const retry = adminFinanceSyncStatus(raw, true, scope, [
    ...jobs, { scan_from: scope, state: 'retry', attempts: 3 },
  ], Date.parse('2026-11-21T20:25:00Z'));
  assert.equal(retry.state, 'retry');
  assert.equal(retry.retry_attempts, 2);
  assert.equal(retry.verified, false);
  assert.equal(financeSyncCoverage(status,{from:'2026-11-01',to:'2026-12-01'},Date.parse('2026-11-21T20:25:00Z')).verified,false);
  assert.equal(adminFinanceSyncStatus(raw,true,scope,jobs,Date.parse('2026-11-22T12:59:59Z')).stale,false);
  assert.equal(adminFinanceSyncStatus(raw,true,scope,jobs,Date.parse('2026-11-22T13:00:00Z')).stale,true);
  const summer = adminFinanceSyncStatus(raw,true,scope,[],Date.parse('2027-03-27T20:00:00Z'));
  assert.equal(summer.next_sync_window,'2027-03-28T11:00:00.000Z');
  assert.equal(summer.next_verify_window,'2027-03-28T12:00:00.000Z');
});

test('Berlin coverage respects both midnight boundaries across the DST change', () => {
  const now = Date.parse('2026-10-26T03:00:00Z');
  const period = { from: '2026-10-25', to: '2026-10-26' };
  const status = { ...coverage, last_success_at: '2026-10-26T02:00:00Z',
    verified_from: '2026-10-24T22:00:00Z', verified_to: '2026-10-25T23:00:00Z' };
  assert.equal(financeSyncCoverage(status, period, now).verified, true);
  assert.equal(financeSyncCoverage({ ...status, verified_from: '2026-10-24T22:00:01Z' }, period, now).verified, false);
  assert.equal(financeSyncCoverage({ ...status, verified_to: '2026-10-25T22:59:59Z' }, period, now).verified, false);
  assert.equal(financeSyncCoverage(status, { from: '2026-10-26', to: '2026-11-01' }, now).verified, false);
});

function pagedClient(pages, seen) {
  return { from: () => ({ select: () => ({ order: () => ({ range: async (from, to) => {
    seen.push([from, to]);
    const page = pages.shift();
    assert.ok(page);
    return page;
  } }) }) }) };
}

test('admin pagination advances by rows actually returned and rejects partial aggregates', async () => {
  const seen = [];
  const row = id => ({ id });
  const client = pagedClient([
    { data: [row(1), row(2)], count: 3, error: null },
    { data: [row(3)], count: 3, error: null },
  ], seen);
  assert.deepEqual(await readPortalPages(client, 'orders'), [row(1), row(2), row(3)]);
  assert.deepEqual(seen, [[0, 499], [2, 501]]);
  const incomplete = pagedClient([
    { data: [row(1)], count: 2, error: null }, { data: [], count: 2, error: null },
  ], []);
  await assert.rejects(readPortalPages(incomplete, 'orders'), /incomplete/);
});

test('incremental finance mode never falls back to a daily completeness claim on missing mode status', async () => {
  const oldModes = process.env.FINANCE_SCAN_MODES_ENABLED;
  const oldEnabled = process.env.FINANCE_RECONCILIATION_ENABLED;
  process.env.FINANCE_SCAN_MODES_ENABLED = 'true';
  process.env.FINANCE_RECONCILIATION_ENABLED = 'true';
  try {
    const now = new Date().toISOString();
    const calls = [];
    const status = { ...coverage, monitoring_version: 1, last_scan_at: now, last_success_at: now,
      verified_from: '2020-01-01T00:00:00Z', verified_to: now };
    let modeResult = { data: null, error: { message: 'unavailable' } };
    const admin = { from(table) {
      if (table === 'finance_sync_config') return { select: () => ({ eq: () => ({
        maybeSingle: async () => ({ data: { account_id: 'acct_test', scan_from: status.verified_from } }),
      }) }) };
      const query = emptyDashboardQuery();
      query.eq = () => query;
      return query;
    }, async rpc(name) {
      calls.push(name);
      if (name === 'finance_sync_global_status_v1') return { data: status, error: null };
      if (name === 'finance_sync_modes_status_v2') return modeResult;
      if (name === 'finance_sync_period_v1') return { data: null, error: null };
      return { data: { ...basis, events: [], expenses: [], providerEvidence: [] }, error: null };
    } };
    const period = { from: '2020-02-01', to: '2099-01-01' };
    const { summary } = await readFinanceSummary(admin, period);
    assert.ok(calls.includes('finance_sync_modes_status_v2'));
    assert.equal(summary.stripeSync.verified, false);
    assert.equal(summary.resultCents, null);
    modeResult = { data: { version: 2, incremental_last_scan: now }, error: null };
    const usable = await readFinanceSummary(admin, period);
    assert.equal(usable.summary.stripeSync.berlin_daily_schedule, true);
  } finally {
    if (oldModes === undefined) delete process.env.FINANCE_SCAN_MODES_ENABLED;
    else process.env.FINANCE_SCAN_MODES_ENABLED = oldModes;
    if (oldEnabled === undefined) delete process.env.FINANCE_RECONCILIATION_ENABLED;
    else process.env.FINANCE_RECONCILIATION_ENABLED = oldEnabled;
  }
});

test('global status route reports unavailable when the configured incremental contract is absent', async () => {
  const compiled = { exports: {} };
  const now = new Date().toISOString();
  const admin = { async rpc(name) {
    if (name === 'finance_sync_modes_status_v2') return { error: null, data: null };
    return { error: null, data: { ...coverage, monitoring_version: 1,
      verified_from: '2020-01-01T00:00:00Z', verified_to: now, last_success_at: now } };
  } };
  const dependencies = {
    '../../../../lib/adminActionRoute.ts': { requireAdminIdentity: async () => ({ ok: true, identity: { role: 'admin' } }) },
    '../../../../lib/productOwnerAccess': { canAccessProductManager: () => assert.fail('unexpected Owner lookup') },
    '../../../../lib/supabaseAdmin': { getSupabaseAdmin: () => admin },
    '../../../../lib/financeSyncServer': { runFinanceSyncServer: () => assert.fail('unexpected worker') },
    '../../../../lib/globalFinanceSync.ts': { globalFinanceSyncStatus },
    '../../../../lib/financeProductionKeyBinding.ts': { verifyProductionKeyBinding: () => assert.fail('unexpected binding check') },
  };
  const code = ts.transpileModule(fs.readFileSync('app/api/admin/stripe-sync/route.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(code, { module: compiled, exports: compiled.exports, Response, URL,
    process: { env: { FINANCE_RECONCILIATION_ENABLED: 'true', FINANCE_SCAN_MODES_ENABLED: 'true' } },
    require: name => {
      assert.ok(Object.hasOwn(dependencies, name), name);
      return dependencies[name];
    } });
  const response = await compiled.exports.POST(new Request('http://local.invalid/api/admin/stripe-sync',
    { method: 'POST', body: JSON.stringify({ action: 'status' }) }));
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});
