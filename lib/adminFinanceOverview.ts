import type { SupabaseClient } from '@supabase/supabase-js';
import type { PortalRow } from './adminPortalModel.ts';
import { portalPeriod } from './adminPortalFinance.ts';
import { readPortalPages } from './adminPortalRead.ts';
import { expenseNet } from './directCostCoverage.ts';

type Period = ReturnType<typeof portalPeriod>;

export function financeHistoryRange(dates: string[], current: Period): Period {
  const first = [current.from, ...dates].sort()[0];
  const last = [current.from, ...dates].sort().at(-1)!;
  const end = new Date(last + 'T12:00:00Z');
  end.setUTCDate(end.getUTCDate() + 1);
  return { from: first, to: [current.to, end.toISOString().slice(0, 10)].sort()[1] };
}

export async function readFinanceHistoryRange(admin: SupabaseClient, current: Period) {
  const sources = [
    ['documents', 'issued_on'],
    ['business_expenses', 'occurred_on'],
    ['financial_events', 'occurred_on'],
  ];
  const dates = await Promise.all(sources.flatMap(([table, field]) => [true, false].map(async ascending => {
    const query = admin.from(table).select(field).not(field, 'is', null);
    if (table === 'documents') query.eq('kind', 'expense_receipt');
    const { data, error } = await query.order(field, { ascending }).limit(1).maybeSingle();
    if (error) throw new Error('Finance history range unavailable');
    return (data as PortalRow | null)?.[field];
  })));
  return financeHistoryRange(dates.filter((date): date is string => typeof date === 'string'), current);
}

function sum(values: unknown[]) {
  let total = 0;
  for (const value of values) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) return null;
    total += value;
    if (!Number.isSafeInteger(total)) return null;
  }
  return values.length ? total : null;
}

export function summarizeExpenseEvidence(receipts: PortalRow[], expenses: PortalRow[], linkedIds: Set<unknown>) {
  const eur = receipts.filter(row => String(row.currency).toUpperCase() === 'EUR');
  const receiptAmounts = (field: string) => eur.map(row => row[field]);
  const known = (values: unknown[]) => values.filter(value => typeof value === 'number' && Number.isSafeInteger(value));
  const receiptFields = ['net_cents', 'tax_cents', 'gross_cents'];
  const group = (rows: PortalRow[]) => ({
    count: rows.length,
    netCents: sum(rows.map(expenseNet)),
    taxCents: sum(rows.map(row => row.vat_cents)),
    grossCents: sum(rows.map(row => row.gross_cents)),
  });
  return {
    receipts: {
      count: receipts.length,
      linked: receipts.filter(row => linkedIds.has(row.id)).length,
      excludedCurrency: receipts.length - eur.length,
      netCents: sum(known(receiptAmounts('net_cents'))),
      taxCents: sum(known(receiptAmounts('tax_cents'))),
      grossCents: sum(known(receiptAmounts('gross_cents'))),
      missing: receiptFields.map(field => eur.length - known(receiptAmounts(field)).length),
    },
    expenses: group(expenses),
    paid: group(expenses.filter(row => row.payment_status === 'paid')),
    open: group(expenses.filter(row => row.payment_status === 'open')),
    unknownPayment: expenses.filter(row => !['paid', 'open'].includes(String(row.payment_status))).length,
    categories: [...new Set(expenses.map(row => String(row.category)))].sort().map(category => ({
      category, ...group(expenses.filter(row => row.category === category)),
    })),
  };
}

export async function readExpenseEvidence(admin: SupabaseClient, period: Period, expenses: PortalRow[], all: boolean) {
  const receipts = await readPortalPages(admin, 'documents', query => {
    const scoped = query.eq('kind', 'expense_receipt');
    return all ? scoped : scoped.gte('issued_on', period.from).lt('issued_on', period.to);
  }, 'id', 'id,issued_on,currency,net_cents,tax_cents,gross_cents');
  const linkedIds = new Set<unknown>();
  for (let start = 0; start < receipts.length; start += 100) {
    const ids = receipts.slice(start, start + 100).map(row => row.id);
    const links = await readPortalPages(admin, 'document_links',
      query => query.eq('subject_type', 'business_expense').in('document_id', ids),
      'document_id', 'document_id');
    for (const link of links) linkedIds.add(link.document_id);
  }
  return {
    ...summarizeExpenseEvidence(receipts, expenses, linkedIds),
    undatedReceipts: receipts.filter(row => row.issued_on == null).length,
  };
}
