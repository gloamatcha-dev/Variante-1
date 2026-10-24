import {getSupabaseAdmin} from './supabaseAdmin';
import {createStripeReconciliationRead} from './stripeReconciliationClient.ts';
import {runAutomaticFinanceSync,type FinanceSyncRpc,type FinanceSyncConfig} from './automaticFinanceSync.ts';
import {Resend} from 'resend';

/** No work at module import or build time. The dedicated READ key is never
 * substituted with the application's payment-capable Stripe secret. */
export async function runFinanceSyncServer() {
 const admin=getSupabaseAdmin();if(!admin)throw Error('finance_database_unavailable');
 const rpc:FinanceSyncRpc=async(name,args)=>{const result=await admin.rpc(name,args);if(result.error)throw Error('finance_database_operation_failed');return result.data;};
 const {data,error}=await admin.from('finance_sync_config').select('account_id,enabled,known_payment_intent,known_amount_cents').eq('enabled',true).maybeSingle();
 if(error)throw Error('finance_configuration_unavailable');if(!data)return {state:'disabled'};
 const key=process.env.STRIPE_RECONCILIATION_READ_KEY;
 const deadline=Date.now()+45000;let result:Awaited<ReturnType<typeof runAutomaticFinanceSync>>={state:'continuation_required'};
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
 // Durable daily-deduplicated notification, independently retryable. Merely
 // implementing this sender does not send emails during local/mock validation.
 let alertState='not_configured';
 const recipient=process.env.FINANCE_ALERT_EMAIL,mailKey=process.env.RESEND_API_KEY,from=process.env.FINANCE_ALERT_FROM;
 if(recipient&&mailKey&&from){
  const alert=await rpc('finance_sync_alert_v1',{}) as {id:string;lease_token:string;code:string}|null;
  if(alert){
   try {
    const status=await rpc('finance_sync_status_v1',{}) as Record<string,unknown>;
    const sent=await new Resend(mailKey).emails.send({from,to:recipient,subject:'GLOA: Finanzabgleich benötigt Aufmerksamkeit',text:`Der automatische Stripe-Abgleich meldet offene Vorgänge. Zahlungen: ${status.missing_payments??'unbekannt'}, Refunds: ${status.missing_refunds??'unbekannt'}, Gebühren: ${status.missing_fees??'unbekannt'}, Abweichungen: ${status.unresolved??'unbekannt'}. Bitte in GLOA Admin > Finanzen den Syncstatus und die Freigaben prüfen. Keine manuelle Stripe-/Dashboard-Gegenrechnung erforderlich.`},{idempotencyKey:'gloa-finance-sync-alert/'+alert.id});
    if(sent.error)throw Error('finance_alert_not_confirmed');
    await rpc('finance_sync_alert_v1',{p_id:alert.id,p_token:alert.lease_token,p_sent:true});alertState='sent';
   }catch{await rpc('finance_sync_alert_v1',{p_id:alert.id,p_token:alert.lease_token,p_sent:false});alertState='retry_required';}
  }else alertState='none_pending';
 }
 return {...result,alertState};
}
