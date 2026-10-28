import {GLOA_FROM_HELLO} from './emailSenders.ts';

type Options={ownerEmail:string;databaseEnabled:boolean;probeId:string;env?:Record<string,string|undefined>;request?:typeof fetch};
/** Explicit owner-only email probe. No financial worker, RPC, queue write or watchdog. */
export async function financeAlertDeliveryProbe(options:Options) {
 const env=options.env??process.env,request=options.request??fetch;
 if(options.databaseEnabled!==false||env.FINANCE_RECONCILIATION_ENABLED==='true'||env.FINANCE_SYNC_MANUAL_ENABLED==='true')return {state:'blocked',reason:'finance_must_remain_disabled'};
 if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(options.probeId))return {state:'blocked',reason:'probe_identity_required'};
 const to=env.FINANCE_ALERT_EMAIL?.trim(),from=env.FINANCE_ALERT_FROM?.trim(),key=env.RESEND_API_KEY;
 if(!to||!key||from!==GLOA_FROM_HELLO||to.toLowerCase()!==options.ownerEmail.trim().toLowerCase())return {state:'blocked',reason:'approved_email_configuration_required'};
 try {
  const response=await request('https://api.resend.com/emails',{method:'POST',redirect:'error',signal:AbortSignal.timeout(8000),headers:{Authorization:'Bearer '+key,'Content-Type':'application/json','Idempotency-Key':'gloa-finance-delivery-probe/'+options.probeId},body:JSON.stringify({from,to,subject:'GLOA Finance — monitoring delivery test',text:'Owner-approved monitoring delivery test only. No Stripe reconciliation, financial booking, historical repair or activation was performed.'})});
  if(!response.ok){await response.body?.cancel();return {state:'unverified',httpStatus:response.status};}
  const data=await response.json();
  if(typeof data.id!=='string'||!data.id.trim())return {state:'unverified',httpStatus:response.status};
  // Provider acceptance is not proof of mailbox delivery. Owner must verify receipt.
  return {state:'accepted',messageId:data.id,httpStatus:response.status};
 }catch{return {state:'unverified',httpStatus:null};}
}
