import {Resend} from 'resend';
import type {FinanceSyncRpc} from './automaticFinanceSync.ts';
/** Same durable daily deduplication and provider-ID acknowledgement for both modes. */
export async function deliverFinanceSyncAlerts(rpc:FinanceSyncRpc) {
 let alertState='not_configured';
 const recipient=process.env.FINANCE_ALERT_EMAIL,mailKey=process.env.RESEND_API_KEY,from=process.env.FINANCE_ALERT_FROM;
 if(recipient&&mailKey&&from){
  const alert=await rpc('finance_sync_alert_v1',{}) as {id:string;lease_token:string;code:string}|null;
  if(alert){
   try {
    const status=await rpc('finance_sync_status_v1',{}) as Record<string,unknown>;
    const sent=await new Resend(mailKey).emails.send({from,to:recipient,subject:'GLOA: Finanzabgleich benötigt Aufmerksamkeit',text:`Der automatische Stripe-Abgleich meldet offene Vorgänge. Zahlungen: ${status.missing_payments??'unbekannt'}, Refunds: ${status.missing_refunds??'unbekannt'}, Gebühren: ${status.missing_fees??'unbekannt'}, Abweichungen: ${status.unresolved??'unbekannt'}. Bitte in GLOA Admin > Finanzen den Syncstatus und die Freigaben prüfen. Keine manuelle Stripe-/Dashboard-Gegenrechnung erforderlich.`},{idempotencyKey:'gloa-finance-sync-alert/'+alert.id});
    if(sent.error||typeof sent.data?.id!=='string'||!sent.data.id)throw Error('finance_alert_not_confirmed');
    await rpc('finance_sync_alert_v1',{p_id:alert.id,p_token:alert.lease_token,p_sent:true});alertState='sent';
   }catch{await rpc('finance_sync_alert_v1',{p_id:alert.id,p_token:alert.lease_token,p_sent:false});alertState='retry_required';}
  }else alertState='none_pending';
 }
 return alertState;
}
