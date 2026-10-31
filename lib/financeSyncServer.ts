import {getSupabaseAdmin} from './supabaseAdmin';
import {createStripeReconciliationRead} from './stripeReconciliationClient.ts';
import {runAutomaticFinanceSync,type FinanceSyncRpc,type FinanceSyncConfig} from './automaticFinanceSync.ts';
import {deliverFinanceSyncAlerts} from './financeSyncAlerts.server.ts';
import {globalFinanceSyncStatus} from './globalFinanceSync';
import {withFinanceHeartbeat} from './financeHeartbeat.server';

/** No work at module import or build time. The dedicated READ key is never
 * substituted with the application's payment-capable Stripe secret. */
export async function runFinanceSyncServer(options:{invocation?:'scheduled'|'manual';firstScanOnly?:boolean}={}) {
 if(process.env.FINANCE_RECONCILIATION_ENABLED!=='true')return {state:'disabled'};
 // While a temporary scope exists, ordinary cron/manual calls must not claim it.
 if(process.env.FINANCE_FIRST_SCAN_SCOPE!==undefined&&!options.firstScanOnly)throw Error('first_scan_explicit_request_required');
 if(options.firstScanOnly&&(!process.env.FINANCE_FIRST_SCAN_SCOPE||process.env.FINANCE_SCAN_MODES_ENABLED!=='true'))throw Error('first_scan_scope_required');
 if(process.env.FINANCE_SCAN_MODES_ENABLED==='true'){
  const {runFinanceScanMode}=await import('./financeScanModes.server.ts');
  const started=Date.now(),manual=options.invocation==='manual';
  const result=await runFinanceScanMode('incremental',manual);
  if(!process.env.FINANCE_FIRST_SCAN_SCOPE&&!manual&&result.caughtUp===true&&Date.now()-started<35000){
   // Only resume the audit that the daily trigger already started. A frequent
   // tick cannot disguise a missing daily invocation by starting a new audit.
   try{await runFinanceScanMode('daily',false,Math.max(1,40000-(Date.now()-started)),true);}catch{/* Daily heartbeat records its own failure. */}
  }
  return result;
 }
 // Owner activity must not hide an absent daily scheduler heartbeat.
 return options.invocation==='manual'?runEnabledFinanceSync():withFinanceHeartbeat(runEnabledFinanceSync,{deferStart:true});
}
async function runEnabledFinanceSync(onClaim?:()=>Promise<void>) {
 const admin=getSupabaseAdmin();if(!admin)throw Error('finance_database_unavailable');
 const rpc:FinanceSyncRpc=async(name,args)=>{const result=await admin.rpc(name,args);if(result.error)throw Error('finance_database_operation_failed');
  if(name==='finance_sync_claim_v1'&&result.data?.status==='claimed')await onClaim?.();return result.data;};
 const {data,error}=await admin.from('finance_sync_config').select('account_id,enabled,known_payment_intent,known_amount_cents').eq('enabled',true).maybeSingle();
 if(error)throw Error('finance_configuration_unavailable');if(!data)return {state:'disabled'};
 const key=process.env.STRIPE_RECONCILIATION_READ_KEY;
 const deadline=Date.now()+45000;let result:Awaited<ReturnType<typeof runAutomaticFinanceSync>>={state:'continuation_required'};
 let workError:unknown;let workFailed=false;
 try {
 if(!key?.startsWith('rk_live_')){
  const job=await rpc('finance_sync_claim_v1',{p_account:data.account_id}) as Record<string,unknown>;
  if(job.status==='busy')result={state:'busy'};
  else {
   const auth={p_job:job.id,p_token:job.lease_token};
   await rpc('finance_sync_discrepancy_v1',{...auth,p_source:'configuration',p_code:'read_key_missing'});
   await rpc('finance_sync_checkpoint_v1',{...auth,p_checkpoint:job.checkpoint??{},p_state:'retry',p_error:'read_key_missing'});
   result={state:'retry_required'};
  }
 } else for(let i=0;i<16&&Date.now()<deadline-1000;i++){
  result=await runAutomaticFinanceSync({rpc,read:createStripeReconciliationRead(key),config:data as FinanceSyncConfig,budgetMs:Math.max(1,deadline-Date.now())});
  if(result.caughtUp||!['verified','attention'].includes(result.state))break;
 }
 }catch(error){workFailed=true;workError=error;}
 // Durable daily-deduplicated notification, independently retryable. Merely
 // implementing this sender does not send emails during local/mock validation.
 const alertState=await deliverFinanceSyncAlerts(rpc);
 if(workFailed)throw workError;
 let reconciliationVerified=false;
 if(result.caughtUp===true&&result.state==='verified'){
  try{reconciliationVerified=globalFinanceSyncStatus(await rpc('finance_sync_global_status_v1',{}) as Record<string,unknown>,true).verified;}
  catch{/* A status-read outage cannot rerun already completed finance work. */}
 }
 return {...result,alertState,reconciliationVerified};
}
