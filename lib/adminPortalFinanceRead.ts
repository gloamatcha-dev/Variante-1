import type { SupabaseClient } from '@supabase/supabase-js';
import { summarizeLedger, type portalPeriod } from './adminPortalFinance.ts';
import { costCompleteness } from './directCostCoverage.ts';

/** Shared authoritative, read-only Finance basis for Finance and Dashboard. */
export async function readFinanceSummary(admin: SupabaseClient, period: ReturnType<typeof portalPeriod>) {
  const { data, error } = await admin.rpc('read_cost_finance_basis_v1', { p_from: period.from, p_to: period.to });
  if (error || !data) throw new Error('Cost basis unavailable');
  const basis = data as NonNullable<Parameters<typeof summarizeLedger>[3]> & {
    events: Parameters<typeof summarizeLedger>[0];
    expenses: Parameters<typeof summarizeLedger>[1];
    providerEvidence: Parameters<typeof summarizeLedger>[2];
  };
  const summary = summarizeLedger(basis.events, basis.expenses, basis.providerEvidence, basis);
  const missingFulfilments = basis.subjects.filter(subject =>
    !costCompleteness([subject], basis.coverage, [], []).directComplete);
  return { basis, summary, missingFulfilments };
}
