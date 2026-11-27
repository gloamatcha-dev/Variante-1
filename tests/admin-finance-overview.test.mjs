import { test } from 'node:test';
import assert from 'node:assert/strict';
import { financeHistoryRange, readExpenseEvidence } from '../lib/adminFinanceOverview.ts';
import { portalPeriod, summarizeLedger } from '../lib/adminPortalFinance.ts';

test('Berlin month and year boundaries and all-history date range retain older and undated evidence', async () => {
  const today = new Date('2026-11-30T23:05:00Z');
  const december = portalPeriod({ period: 'month' }, today);
  assert.deepEqual(december, { from: '2026-12-01', to: '2027-01-01' });
  assert.deepEqual(portalPeriod({ period: 'year' }, today), { from: '2026-01-01', to: '2027-01-01' });
  const history = financeHistoryRange(['2024-09-01', '2027-01-05'], december);
  assert.deepEqual(history, { from: '2024-09-01', to: '2027-01-06' });

  const receipts = [
    { id: 'sept', issued_on: '2024-09-07', currency: 'eur', net_cents: 4263, tax_cents: 810, gross_cents: 5073 },
    { id: 'unknown', issued_on: null, currency: 'EUR', net_cents: null, tax_cents: null, gross_cents: null },
    { id: 'usd', issued_on: '2024-09-08', currency: 'USD', net_cents: 300, tax_cents: 100, gross_cents: 400 },
  ].map(receipt => ({ ...receipt, kind: 'expense_receipt' }));
  const expenses = [
    { gross_cents: 5073, vat_cents: 810, payment_status: 'open', category: 'shipping' },
    { gross_cents: 2000, vat_cents: 0, payment_status: 'paid', category: 'general' },
  ];
  const links = [
    { document_id: 'sept', subject_type: 'business_expense' },
    { document_id: 'sept', subject_type: 'financial_event' },
  ];
  const db = {
    from(table) {
      let rows = table === 'documents' ? receipts : links;
      return {
        select() { return this; },
        order() { return this; },
        eq(key, value) { rows = rows.filter(row => row[key] === value); return this; },
        in(key, values) { rows = rows.filter(row => values.includes(row[key])); return this; },
        gte(key, value) { rows = rows.filter(row => row[key] >= value); return this; },
        lt(key, value) { rows = rows.filter(row => row[key] < value); return this; },
        async range() { return { data: rows, count: rows.length }; },
      };
    },
  };
  const month = { from: '2024-09-01', to: '2024-10-01' };
  const september = await readExpenseEvidence(db, month, expenses, false);
  assert.deepEqual(september.receipts, { count: 2, linked: 1, excludedCurrency: 1, netCents: 4263, taxCents: 810, grossCents: 5073, missing: [0, 0, 0] });
  assert.equal(september.expenses.grossCents, 7073);
  assert.equal(september.paid.grossCents, 2000);
  assert.equal(september.open.grossCents, 5073);
  assert.equal(september.paid.taxCents, 0);
  assert.equal((await readExpenseEvidence(db, december, [], false)).receipts.grossCents, null);
  const all = await readExpenseEvidence(db, history, expenses, true);
  assert.equal(all.undatedReceipts, 1);
  assert.equal(all.receipts.grossCents, 5073);
  assert.deepEqual(all.receipts.missing, [1, 1, 1]);
});

test('net receipts and tax come from the same ledger payment population without including refunds, fees or payouts', () => {
  const result = summarizeLedger([
    { kind: 'order_payment', direction: 'inflow', gross_cents: 11900, net_cents: 10000, tax_cents: 1900, channel: 'b2c' },
    { kind: 'manual_b2b_payment', direction: 'inflow', gross_cents: 2380, net_cents: 2000, tax_cents: 380, channel: 'b2b' },
    { kind: 'refund', direction: 'outflow', gross_cents: 1190, net_cents: 1000, tax_cents: 190, channel: 'b2c' },
  ], []);
  assert.equal(result.incomeCents, 14280);
  assert.equal(result.storedIncomeNetCents, 12000);
  assert.equal(result.storedIncomeTaxCents, 2280);
  assert.equal(result.refundCents, 1190);
  assert.equal(result.resultCents, null);
});
