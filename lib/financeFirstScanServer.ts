import {getSupabaseAdmin} from './supabaseAdmin';
import {runAutomaticFinanceSync,type FinanceSyncRpc,type FinanceSyncConfig} from './automaticFinanceSync.ts';
import {parseFirstScanScope,assertFirstScanJob,firstScanReceiptVerifier} from './financeFirstScanScope.ts';
import {financeScanBudget} from './financeScanBudget.ts';
import {incrementalFinanceDiscovery} from './financeIncrementalDiscovery.ts';
import {createStripeReconciliationRead} from './stripeReconciliationClient.ts';

/** Explicit authenticated route only. Does not need or enable normal finance gates.
 * Consume commits before any GET. Lost consume response is deliberately not retried. */
export async function runFirstScanDiscovery() {
 const scope=parseFirstScanScope(process.env.FINANCE_FIRST_SCAN_SCOPE);
 if(!scope)throw Error('first_scan_scope_required');
 if(['FINANCE_RECONCILIATION_ENABLED','FINANCE_SCAN_MODES_ENABLED','FINANCE_SYNC_MANUAL_ENABLED'].some(k=>process.env[k]==='true'))throw Error('first_scan_requires_disabled_flags');
 const key=process.env.STRIPE_RECONCILIATION_READ_KEY;if(!key?.startsWith('rk_live_'))throw Error('read_key_missing');
 const admin=getSupabaseAdmin();if(!admin)throw Error('finance_database_unavailable');
 const rpc:FinanceSyncRpc=async(name,args)=>{const r=await admin.rpc(name,args);if(r.error)throw Error('first_scan_database_operation_failed');return r.data;};
 const consumed=await rpc('finance_first_scan_consume_v3',{p_account:scope.accountId,p_job:scope.jobId,p_from:scope.scanFrom,p_to:scope.scanTo,p_max:scope.maxReads,p_expiry:scope.expiresAt}) as {
  job:Record<string,unknown>;reservation:{id:string;granted:number};config:FinanceSyncConfig;
 };
 assertFirstScanJob(scope,consumed.job);
 if(consumed.job.status!=='claimed'||typeof consumed.job.lease_token!=='string'||!consumed.job.lease_token||!consumed.reservation?.id||consumed.reservation.granted!==scope.maxReads||consumed.config.account_id!==scope.accountId)throw Error('first_scan_consume_invalid');
 let claimed=false,readDeadline=Infinity;
 const budget=financeScanBudget(createStripeReconciliationRead(key,fetch,()=>Math.min(budget.remainingMs(),readDeadline-Date.now())),{maxReads:scope.maxReads,budgetMs:Math.min(40000,Date.parse(scope.expiresAt)-Date.now())});
 const mapped:FinanceSyncRpc=async(name,args)=>{
  if(name==='finance_sync_claim_v1'){
   if(claimed)throw Error('first_scan_replay_forbidden');claimed=true;return consumed.job;
  }
  if(name==='finance_sync_finish_v1'){
   // The normal finalizer mutates alert state and advances ordinary coverage.
   // Preserve this isolated result without certifying full reconciliation.
   await rpc('finance_sync_checkpoint_v1',{...args,p_state:'retry',p_error:null});
   return {state:'discovery_completed'};
  }
  if(name==='finance_sync_discrepancy_v1')return rpc('finance_first_scan_issue_v3',args);
  if(!['finance_sync_checkpoint_v1','finance_sync_basis_v1','finance_sync_retry_ids_v1','finance_sync_source_read_v1','finance_sync_known_balances_v2'].includes(name))throw Error('first_scan_money_write_forbidden');
  return rpc(name,args);
 };
 try{
  const result=await runAutomaticFinanceSync({rpc:mapped,config:consumed.config,budgetMs:budget.remainingMs(),
   read:async(path,params)=>{
    if(budget.remainingMs()<250||budget.metrics().requests>=scope.maxReads)throw Error('finance_sync_yield');
    const started=Date.now();
    const permit=await rpc('finance_first_scan_read_v3',{p_job:scope.jobId,p_token:consumed.job.lease_token}) as {remainingMs:number};
    if(!Number.isFinite(permit?.remainingMs)||permit.remainingMs<=0)throw Error('first_scan_read_denied');
    // Subtract the whole RPC round trip conservatively. No dependency on DB vs
    // Function clock alignment; an already in-flight GET cannot be recalled.
    readDeadline=started+Math.min(40000,permit.remainingMs);
    if(readDeadline-Date.now()<250)throw Error('finance_sync_yield');
    return budget.read(path,params);
   },
   discovery:incrementalFinanceDiscovery(async ids=>await mapped('finance_sync_known_balances_v2',{p_account:scope.accountId,p_ids:ids}) as string[]),
   receiptVerifier:firstScanReceiptVerifier(scope,mapped)});
  return {...result,alertState:'suppressed_first_scan',reconciliationVerified:false,metrics:budget.metrics()};
 }finally{
  // Accounting only; expiry never blocks recording measurements. If lost,
  // reserved reads remain conservatively charged; consumed authorization persists.
  await rpc('finance_sync_read_measure_v2',{p_id:consumed.reservation.id,p_actual:budget.metrics().requests,p_mode:'incremental',p_jobs:{[scope.jobId]:budget.metrics().requests}});
 }
}
