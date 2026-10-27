import type { SupabaseClient } from '@supabase/supabase-js';
import { summarizeLedger, type portalPeriod } from './adminPortalFinance.ts';
import { costCompleteness } from './directCostCoverage.ts';
import { readPortalPages } from './adminPortalRead.ts';
import { financeSourceCoverage } from './financeSourceCoverage.ts';
import {financeSyncCoverage} from './financeSyncMonitoring.ts';
import {globalFinanceSyncStatus} from './globalFinanceSync.ts';
import {financeRefundEvidence} from './financeRefundEvidence.ts';
import type {PortalRow} from './adminPortalModel.ts';

/** Shared authoritative, read-only Finance basis for Finance and Dashboard. */
export async function readFinanceSummary(admin: SupabaseClient, period: ReturnType<typeof portalPeriod>) {
  const [baseRead,statusRead,periodRead]=await Promise.allSettled([
    admin.rpc('read_cost_finance_basis_v1',{p_from:period.from,p_to:period.to}),
    admin.rpc('finance_sync_global_status_v1'),
    admin.rpc('finance_sync_period_v1',{p_from:period.from,p_to:period.to}),
  ]);
  if(baseRead.status!=='fulfilled')throw new Error('Cost basis unavailable');
  const {data,error}=baseRead.value;
  const rawStatus=statusRead.status==='fulfilled'&&!statusRead.value.error?statusRead.value.data as Record<string,unknown>|null:null;
  const syncStatus=globalFinanceSyncStatus(rawStatus,process.env.FINANCE_RECONCILIATION_ENABLED==='true');
  const cash=periodRead.status==='fulfilled'&&!periodRead.value.error?periodRead.value.data as Record<string,unknown>|null:null;
  if (error || !data) throw new Error('Cost basis unavailable');
  const basis = data as NonNullable<Parameters<typeof summarizeLedger>[3]> & {
    events: Parameters<typeof summarizeLedger>[0];
    expenses: Parameters<typeof summarizeLedger>[1];
    providerEvidence: Parameters<typeof summarizeLedger>[2];
  };
  // Independent source reads catch legacy payments omitted from financial_events.
  // Failure must not turn an empty ledger into a certified zero month.
  try {
    const [orders, plans, attempts, ledger, sourceEvidence] = await Promise.all([
      readPortalPages(admin, 'orders', q => q.in('payment_status', ['paid','partially_refunded','refunded']), 'id', 'id,checkout_attempt_id,placed_at,payment_status,total_gross_cents,refunded_total_cents,refund_updated_at'),
      readPortalPages(admin, 'annual_plans', q => q.in('payment_status', ['paid','partially_refunded','refunded']), 'id', 'id,purchased_at,payment_status,total_gross_cents,refunded_total_cents,refund_updated_at'),
      readPortalPages(admin, 'checkout_attempts', q => q.not('annual_plan_id','is',null), 'id', 'id,annual_plan_id'),
      readPortalPages(admin, 'financial_events', q => q.in('kind',['order_payment','annual_prepayment','refund']), 'id', 'id,kind,order_id,annual_plan_id,gross_cents,occurred_on'),
      readPortalPages(admin, 'finance_sync_sources', q => q, 'source_key','account_id,source_key,payload,context'),
    ]);
    const deliveries = new Set(attempts.map(a => a.id));
    const reconciledIds=new Set(Array.isArray(cash?.bridges)?cash.bridges.map((r:Record<string,unknown>)=>r.event_id):[]);
    const refundFacts=financeRefundEvidence(sourceEvidence);
    const withRefundFacts=(row:PortalRow,kind:string)=>{const fact=refundFacts.get(kind+':'+row.id);return {...row,source_kind:kind,
      ...(fact?{verified_refund_total_cents:fact.total,verified_refund_updated_at:fact.at}:{})};};
    basis.sourceCoverage = financeSourceCoverage([
      ...orders.filter(o => !deliveries.has(o.checkout_attempt_id)).map(o => withRefundFacts(o,'order')),
      ...plans.map(p => withRefundFacts(p,'annual')),
    ], ledger.map(e=>({...e,reconciled_source:reconciledIds.has(e.id)})), period);
  } catch {
    basis.sourceCoverage = {status:'unavailable',complete:false,missingPayments:0,missingRefunds:0,conflicts:0};
  }
  const summary = summarizeLedger(basis.events, basis.expenses, basis.providerEvidence, basis);
  const sync=financeSyncCoverage(syncStatus,period);
  const cashCoverage=financeSyncCoverage(cash?{...sync.status,state:cash.unresolved===0?'complete':'attention',last_success_at:cash.last_scan_at,verified_from:cash.cash_from,verified_to:cash.cash_to,missing_payments:0,missing_refunds:0,missing_fees:0,persistent_failures:0,unbridged_events:0}:null,period);
  const monitoredSummary={...summary,stripeSync:{...sync.status,verified:sync.verified,stale:sync.stale,asOf:sync.asOf,
    cashVerified:cashCoverage.verified,cashAsOf:cash?.cash_to??null,cashIncomeCents:cashCoverage.verified?cash?.income_cents:null,cashRefundCents:cashCoverage.verified?cash?.refund_cents:null,
    cashFeeCents:cashCoverage.verified?cash?.fee_cents:null,cashUsageCents:cashCoverage.verified?cash?.usage_cents:null,approvedCorrections:cash?.corrections??null,
    ledgerIncomeCents:summary.incomeCents,ledgerRefundCents:summary.refundCents}};
  if(!sync.verified){
    monitoredSummary.contributionComplete=false;monitoredSummary.contributionMarginCents=null;monitoredSummary.resultCents=null;monitoredSummary.resultComplete=false;
    monitoredSummary.costBlockers=[...summary.costBlockers,'Stripe-Abgleich fehlt, ist veraltet oder enthält offene Vorgänge.'];
    monitoredSummary.providerFeeCoverage={...summary.providerFeeCoverage,complete:false};
    monitoredSummary.providerFeeCoverageLabel='Providergebühren nur aus vorhandenen Belegen; Stripe-Abgleich nicht bestätigt';
    if(monitoredSummary.providerFeeCents===0&&!basis.events.some(e=>e.kind==='payment_fee'))monitoredSummary.providerFeeCents=null;
  }
  const missingFulfilments = basis.subjects.filter(subject =>
    !costCompleteness([subject], basis.coverage, [], []).directComplete);
  return { basis, summary:monitoredSummary, missingFulfilments };
}
