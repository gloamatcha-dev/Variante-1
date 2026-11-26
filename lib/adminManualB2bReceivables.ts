import type { SupabaseClient } from '@supabase/supabase-js';
import { readPortalPages } from './adminPortalRead.ts';

export async function readManualB2bReceivables(admin: SupabaseClient) {
  try {
    const orders = await readPortalPages(admin, 'orders', query => query
      .not('manual_b2b', 'is', null).eq('status', 'confirmed').is('cancelled_at', null),
    'id', 'id,total_gross_cents,currency');
    const ids = orders.map(order => order.id);
    if (new Set(ids).size !== ids.length) throw Error('Duplicate manual B2B order');
    const totals = new Map<string, number>();
    for (let offset = 0; offset < ids.length; offset += 200) {
      const batch = ids.slice(offset, offset + 200);
      const { data, error } = await admin.rpc('read_manual_b2b_payment_totals_v1', { ids: batch });
      if (error || !Array.isArray(data)) throw Error('Manual B2B payment totals unavailable');
      for (const row of data) {
        const cents = row.received_cents;
        if (!batch.includes(row.order_id) || totals.has(row.order_id) ||
            !Number.isSafeInteger(cents) || cents < 0) throw Error('Invalid manual B2B payment total');
        totals.set(row.order_id, cents);
      }
    }
    const result = { openCount: 0, partialCount: 0, remainingCents: 0 };
    for (const order of orders) {
      const due = order.total_gross_cents;
      if (typeof order.id !== 'string' || order.currency !== 'EUR' ||
          typeof due !== 'number' || !Number.isSafeInteger(due) || due <= 0) throw Error('Invalid manual B2B order amount');
      const received = totals.get(order.id) ?? 0; // This successful RPC omits orders without recorded payments.
      if (received >= due) continue;
      result.remainingCents += due - received;
      if (received === 0) result.openCount++;
      else result.partialCount++;
    }
    if (!Number.isSafeInteger(result.remainingCents)) throw Error('Manual B2B balance out of range');
    return result;
  } catch {
    return null;
  }
}
