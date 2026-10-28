import {createStripeReconciliationRead,StripeReconciliationReadError} from './stripeReconciliationClient.ts';

type Config={account_id:string;known_payment_intent:string;known_amount_cents:number;enabled?:boolean;auto_open_current_period?:boolean};
type Environment=Record<string,string|undefined>;
/** Owner-authorized diagnostics only. No database RPC, worker, alert or provider write. */
export async function financeSyncPreflight(config:Config,env:Environment=process.env,request:typeof fetch=fetch) {
 const names=['STRIPE_RECONCILIATION_READ_KEY','CRON_SECRET','SUPABASE_SECRET_KEY','FINANCE_ALERT_EMAIL','FINANCE_ALERT_FROM','RESEND_API_KEY','FINANCE_HEALTHCHECK_SCAN_URL','FINANCE_HEALTHCHECK_RECONCILED_URL'];
 const secrets=Object.fromEntries(names.map(name=>[name,env[name]?'PRESENT':'ABSENT']));
 const activation={automatic:env.FINANCE_RECONCILIATION_ENABLED==='true',manual:env.FINANCE_SYNC_MANUAL_ENABLED==='true'};
 const checks:{resource:string;status:'PASS'|'UNVERIFIED';httpStatus?:number|null}[]=[];
 const result={readOnly:true,secrets,activation,database:{enabled:config.enabled??'UNVERIFIED',autoOpen:config.auto_open_current_period??'UNVERIFIED'},accountBinding:'UNVERIFIED',connectivity:'UNVERIFIED',checks};
 const key=env.STRIPE_RECONCILIATION_READ_KEY;
 if(!key?.startsWith('rk_live_')||!/^acct_[A-Za-z0-9_]+$/.test(config.account_id)||!/^pi_[A-Za-z0-9_]+$/.test(config.known_payment_intent)||!Number.isSafeInteger(config.known_amount_cents)||config.known_amount_cents<=0)return result;
 const deadline=AbortSignal.timeout(12000);
 const read=createStripeReconciliationRead(key,(url,options)=>request(url,{...options,signal:options?.signal?AbortSignal.any([options.signal,deadline]):deadline}));
 const probe=async(resource:string,params:Record<string,string>,valid:(data:Record<string,unknown>)=>boolean)=>{
  try{const data=await read(resource,params);const pass=valid(data);checks.push({resource:resource.replace(/\/pi_.*/, '/known-payment'),status:pass?'PASS':'UNVERIFIED'});return pass;}
  catch(error){checks.push({resource:resource.replace(/\/pi_.*/, '/known-payment'),status:'UNVERIFIED',httpStatus:error instanceof StripeReconciliationReadError?error.status:null});return false;}
 };
 const bound=await probe('/v1/payment_intents/'+config.known_payment_intent,{},data=>data.id===config.known_payment_intent&&data.livemode===true&&data.currency==='eur'&&data.status==='succeeded'&&data.amount_received===config.known_amount_cents);
 if(!bound)return result;
 result.accountBinding='KNOWN_PAYMENT_VERIFIED';
 const resources=['payment_intents','charges','refunds','balance_transactions','payouts','invoice_payments'];
 const passed=await Promise.all(resources.map(resource=>probe('/v1/'+resource,{limit:'1'},data=>Array.isArray(data.data)&&typeof data.has_more==='boolean')));
 result.connectivity=passed.every(Boolean)?'PASS':'UNVERIFIED';
 // A successful GET proves read access, never the absence of write permissions.
 return result;
}
