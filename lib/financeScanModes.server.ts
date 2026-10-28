import {getSupabaseAdmin} from './supabaseAdmin';
import {createStripeReconciliationRead} from './stripeReconciliationClient.ts';
import {runAutomaticFinanceSync,type FinanceSyncRpc} from './automaticFinanceSync.ts';
import {financeScanBudget} from './financeScanBudget.ts';
import {incrementalFinanceDiscovery} from './financeIncrementalDiscovery.ts';
import {withFinanceHeartbeat} from './financeHeartbeat.server.ts';
import {deliverFinanceSyncAlerts} from './financeSyncAlerts.server.ts';
import {globalFinanceSyncStatus} from './globalFinanceSync.ts';

export type FinanceScanMode='incremental'|'daily';
type ScanOutcome={state:string;caughtUp?:boolean;alertState?:string;reason?:string;reconciliationVerified?:boolean;metrics?:{requests:number;maxReads:number;elapsedMs:number;jobReads?:Record<string,number>}};
/** Explicitly gated forward schema. Daily dispatch never maps to a money writer. */
export async function runFinanceScanMode(mode:FinanceScanMode,manual=false,budgetMs=40000,resumeOnly=false):Promise<ScanOutcome> {
 if(process.env.FINANCE_RECONCILIATION_ENABLED!=='true'||process.env.FINANCE_SCAN_MODES_ENABLED!=='true')return {state:'disabled'};
 if(manual&&process.env.FINANCE_SYNC_MANUAL_ENABLED!=='true')return {state:'disabled'};
 const work=async(onClaim:()=>Promise<void>)=>{
  const admin=getSupabaseAdmin();if(!admin)throw Error('finance_database_unavailable');
  const rpc:FinanceSyncRpc=async(name,args)=>{const r=await admin.rpc(name,args);if(r.error)throw Error('finance_database_operation_failed');return r.data;};
  const config=await admin.from('finance_sync_config').select('account_id,known_payment_intent,known_amount_cents').eq('enabled',true).maybeSingle();
  if(config.error)throw Error('finance_configuration_unavailable');if(!config.data)return {state:'disabled'};
  const identity=config.data;
  const key=process.env.STRIPE_RECONCILIATION_READ_KEY;if(!key?.startsWith('rk_live_'))throw Error('read_key_missing');
  const reservation=await rpc('finance_sync_read_reserve_v2',{p_account:config.data.account_id,p_requested:80}) as {id:string;granted:number};
  let activeJob='';const jobReads:Record<string,number>={};
  const read=createStripeReconciliationRead(key,fetch,()=>budget.remainingMs());
  const budget=financeScanBudget(read,{budgetMs,maxReads:reservation.granted});
  if(reservation.granted===0){
   await rpc('finance_sync_read_measure_v2',{p_id:reservation.id,p_actual:0,p_mode:mode});
   await rpc('finance_sync_modes_alert_v2',{p_account:identity.account_id,p_code:'read_budget_exhausted'});
   const alertState=await deliverFinanceSyncAlerts(rpc);
   return {state:'retry_required',reason:'read_budget_exhausted',alertState,metrics:budget.metrics()};
  }
  const mapped:FinanceSyncRpc=async(name,args)=>{
   const daily:Record<string,string>={finance_sync_claim_v1:'finance_sync_audit_claim_v2',finance_sync_checkpoint_v1:'finance_sync_audit_checkpoint_v2',finance_sync_discrepancy_v1:'finance_sync_audit_issue_v2',finance_sync_finish_v1:'finance_sync_audit_finish_v2'};
   if(mode==='daily'&&['finance_sync_stage_v1','finance_sync_record_v1','finance_sync_failure_v1'].includes(name))throw Error('audit_money_write_forbidden');
   const result=await rpc(mode==='daily'?(daily[name]??name):name,mode==='daily'&&name==='finance_sync_claim_v1'?{...args,p_resume_only:resumeOnly}:args);
   if(name==='finance_sync_claim_v1'&&(result as {status:string})?.status==='claimed'){
    activeJob=String((result as {id:string}).id);jobReads[activeJob]??=0;
    // A continuation must not extend the daily watchdog's original deadline.
    if(!(mode==='daily'&&resumeOnly))await onClaim();
   }
   return result;
  };
  try{
   let result:Awaited<ReturnType<typeof runAutomaticFinanceSync>>={state:'continuation_required'};
   for(let i=0;i<16&&budget.remainingMs()>1000;i++){
    result=await runAutomaticFinanceSync({rpc:mapped,read:async(path,params)=>{const before=budget.metrics().requests;try{return await budget.read(path,params);}finally{if(activeJob)jobReads[activeJob]+=budget.metrics().requests-before;}},config:config.data,budgetMs:budget.remainingMs(),verification:mode==='daily',
     discovery:mode==='incremental'?incrementalFinanceDiscovery(async ids=>await rpc('finance_sync_known_balances_v2',{p_account:identity.account_id,p_ids:ids}) as string[]):undefined});
    if(result.caughtUp||!['verified','attention','continuation_required'].includes(result.state)||budget.metrics().requests>=reservation.granted)break;
   }
   // A daily result verifies its own frozen range; it cannot certify incremental freshness.
   if(['retry_required','attention'].includes(result.state))await rpc('finance_sync_modes_alert_v2',{p_account:config.data.account_id,p_code:mode+'_'+result.state});
   const alertState=await deliverFinanceSyncAlerts(rpc);
   let reconciliationVerified=result.caughtUp===true&&result.state==='verified';
   if(reconciliationVerified&&mode==='incremental')try{
    const raw=await rpc('finance_sync_global_status_v1',{}) as Record<string,unknown>;
    raw.scan_modes=await rpc('finance_sync_modes_status_v2',{});
    reconciliationVerified=globalFinanceSyncStatus(raw,true).verified;
   }catch{reconciliationVerified=false;}
   return {...result,alertState,reconciliationVerified,metrics:{...budget.metrics(),jobReads}};
  }finally{await rpc('finance_sync_read_measure_v2',{p_id:reservation.id,p_actual:budget.metrics().requests,p_mode:mode,p_jobs:jobReads});}
 };
 const result=manual?await work(async()=>{}):await withFinanceHeartbeat(work,{mode,deferStart:true});
 // Resume a pending daily window after incremental work, bounded by its OWN
 // invocation budget. Scheduling it is deliberate; failures remain daily-only.
 return result;
}
