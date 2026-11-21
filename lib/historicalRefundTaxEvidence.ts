import type { SupabaseClient } from '@supabase/supabase-js';
import type { PortalRow } from './adminPortalModel.ts';

/** An absent migration or inaccessible evidence leaves existing unknowns intact. */
export async function readHistoricalRefundTaxEvidence(admin: SupabaseClient): Promise<PortalRow[]> {
  try {
    const { data, error } = await admin.from('historical_refund_tax_evidence')
      .select('financial_event_id,gross_cents,net_cents,tax_cents');
    return !error && Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

/** Apply the proof only to an in-memory reporting copy of the original event. */
export function withHistoricalRefundTaxEvidence(events: PortalRow[], evidence: PortalRow[]) {
  if (!evidence.length) return events;
  const byEvent = new Map<unknown, PortalRow | null>();
  for (const proof of evidence) {
    const id = proof.financial_event_id;
    if (typeof id === 'string') byEvent.set(id, byEvent.has(id) ? null : proof);
  }
  return events.map(event => {
    if (event.kind !== 'refund' || event.currency !== 'EUR' || event.net_cents != null || event.tax_cents != null) return event;
    const proof = byEvent.get(event.id);
    if (!proof) return event;
    const { gross_cents: gross, net_cents: net, tax_cents: tax } = proof;
    if (typeof gross !== 'number' || typeof net !== 'number' || typeof tax !== 'number' ||
        !Number.isSafeInteger(gross) || !Number.isSafeInteger(net) || !Number.isSafeInteger(tax) ||
        gross <= 0 || net < 0 || tax < 0 || gross !== event.gross_cents || gross !== net + tax) return event;
    return { ...event, net_cents: net, tax_cents: tax };
  });
}
