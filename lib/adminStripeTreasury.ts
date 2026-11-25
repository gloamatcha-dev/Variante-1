import { createStripeReconciliationRead } from './stripeReconciliationClient.ts';
import { verifyStripeReconciliationIdentity, type StripeRead } from './stripeReconciliationRead.ts';

type Row = Record<string, unknown>;
type Period = { from: string; to: string };
type Money = { amount: number; currency: string };
type Identity = Parameters<typeof verifyStripeReconciliationIdentity>[1];
const berlinDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' });
const MAX_PAGES = 5;

function money(row: Row, field: string): Money {
  const amount = row[field];
  if (typeof amount !== 'number' || !Number.isSafeInteger(amount) ||
      typeof row.currency !== 'string' || !/^[a-z]{3}$/.test(row.currency)) {
    throw Error('Invalid Stripe amount');
  }
  return { amount, currency: row.currency };
}

function timestamp(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > 253402300799) {
    throw Error('Invalid Stripe timestamp');
  }
  return value;
}

async function loadList<T>(
  read: StripeRead, resource: 'payouts' | 'invoices', params: Record<string, string>,
  normalize: (row: Row, id: string) => T | null,
): Promise<T[]> {
  const results = new Map<string, T | null>();
  let cursor: string | undefined;
  const idPattern = resource === 'payouts' ? /^po_[A-Za-z0-9]+$/ : /^in_[A-Za-z0-9]+$/;
  for (let page = 0; page < MAX_PAGES; page++) {
    const response = await read('/v1/' + resource, { ...params, limit: '100', ...(cursor ? { starting_after: cursor } : {}) });
    if (!Array.isArray(response.data) || typeof response.has_more !== 'boolean') throw Error('Invalid Stripe list');
    const previous = cursor;
    for (const row of response.data as Row[]) {
      if (typeof row?.id !== 'string' || !idPattern.test(row.id) || row.livemode !== true) throw Error('Invalid LIVE object');
      cursor = row.id;
      const value = normalize(row, cursor);
      if (results.has(cursor) && JSON.stringify(value) !== JSON.stringify(results.get(cursor))) {
        throw Error('Stripe record changed during pagination');
      }
      results.set(cursor, value);
    }
    if (!response.has_more) return [...results.values()].filter((value): value is T => value !== null);
    if (!cursor || cursor === previous) throw Error('Invalid Stripe cursor');
  }
  throw Error('Incomplete Stripe list');
}

async function known<T>(read: () => Promise<T>): Promise<T | null> {
  try { return await read(); } catch { return null; }
}

export async function readAdminStripeTreasury(read: StripeRead, identity: Identity, period: Period) {
  const verified = await known(async () => {
    await verifyStripeReconciliationIdentity(read, identity);
    return true;
  });
  if (!verified) return { payouts: null, available: null, invoices: null };
  // Berlin civil dates may straddle UTC dates. Filter the bounded provider result again below.
  const from = Date.parse(period.from) / 1000;
  const to = Date.parse(period.to) / 1000;
  const [payouts, available, invoices] = await Promise.all([
    known(() => loadList(read, 'payouts', { 'created[gte]': String(from - 86400), 'created[lt]': String(to) }, (row, id) => {
      const created = timestamp(row.created);
      const day = berlinDate.format(created * 1000);
      if (day < period.from || day >= period.to) return null;
      const status = row.status;
      if (typeof status !== 'string' || !['paid', 'pending', 'in_transit', 'canceled', 'failed'].includes(status)) {
        throw Error('Invalid Stripe payout status');
      }
      return { id, ...money(row, 'amount'), created, arrival: row.arrival_date == null ? null : timestamp(row.arrival_date), status };
    })),
    known(async () => {
      const balance = await read('/v1/balance', {});
      if (balance.livemode !== true || !Array.isArray(balance.available) || balance.available.length === 0) {
        throw Error('Invalid LIVE balance');
      }
      const values = balance.available.map(row => money(row, 'amount'));
      if (new Set(values.map(value => value.currency)).size !== values.length) throw Error('Duplicate balance currency');
      return values;
    }),
    known(() => loadList(read, 'invoices', { status: 'open' }, (row, id) => {
      if (row.status !== 'open') throw Error('Invalid invoice status');
      const remaining = money(row, 'amount_remaining');
      if (remaining.amount < 0) throw Error('Invalid invoice remainder');
      if (remaining.amount === 0) return null;
      return { id, ...remaining, due: row.due_date == null ? null : timestamp(row.due_date) };
    })),
  ]);
  return { payouts, available, invoices };
}

export function financeTreasuryRead(key: string) {
  const deadline = Date.now() + 12000;
  return createStripeReconciliationRead(key, fetch, () => deadline - Date.now());
}
export type AdminStripeTreasury = Awaited<ReturnType<typeof readAdminStripeTreasury>>;
