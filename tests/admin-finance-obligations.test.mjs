import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readManualB2bReceivables } from '../lib/adminManualB2bReceivables.ts';
import { summarizeLedger } from '../lib/adminPortalFinance.ts';

test('confirmed manual orders use unpaid or partial remainder without counting overpayments', async () => {
  const filters = [];
  const orders = ['open', 'partial', 'paid', 'overpaid'].map(id => ({ id, currency: 'EUR', total_gross_cents: 1000 }));
  let failed = false;
  const db = {
    from(table) {
      assert.equal(table, 'orders');
      return {
        select() { return this; },
        not(...args) { filters.push(args); return this; },
        eq(...args) { filters.push(args); return this; },
        is(...args) { filters.push(args); return this; },
        order() { return this; },
        async range() { return { data: orders, count: 4 }; },
      };
    },
    async rpc(name, { ids }) {
      assert.equal(name, 'read_manual_b2b_payment_totals_v1');
      assert.deepEqual(ids, orders.map(order => order.id));
      return failed ? { error: true } : { data: [
        { order_id: 'partial', received_cents: 300 },
        { order_id: 'paid', received_cents: 1000 },
        { order_id: 'overpaid', received_cents: 1100 },
      ] };
    },
  };
  assert.deepEqual(await readManualB2bReceivables(db), { openCount: 1, partialCount: 1, remainingCents: 1700 });
  assert.deepEqual(filters, [['manual_b2b', 'is', null], ['status', 'confirmed'], ['cancelled_at', null]]);
  failed = true;
  assert.equal(await readManualB2bReceivables(db), null);
});

test('existing expenses count once and open costs and unknown tax stay separately visible', () => {
  const result = summarizeLedger([{ kind: 'refund', gross_cents: 50, direction: 'outflow' }], [
    { category: 'general', payment_status: 'paid', gross_cents: 15, vat_cents: null },
    { category: 'shipping', payment_status: 'open', gross_cents: 100, vat_cents: 19 },
  ]);
  assert.equal(result.generalCostCents, 15);
  assert.equal(result.directCostCents, 100);
  assert.equal(result.refundCents, 50);
  assert.equal(result.recordedOpenExpenseCents, 100);
  assert.equal(result.storedInputTaxCents, null);
  assert.equal(result.expensesWithUnknownTax, 1);
  assert.equal(result.resultCents, null);
  assert.equal(summarizeLedger([], [{ gross_cents: 100 }]).recordedOpenExpenseCents, null);
});
