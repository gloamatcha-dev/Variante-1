import type {StripeRead} from './stripeReconciliationRead.ts';
export class StripeReconciliationReadError extends Error {
 readonly status:number|null;readonly resource:string;
 constructor(resource:string,status:number|null){super('Stripe reconciliation GET unavailable');this.resource=resource;this.status=status;}
}
/** Server-side restricted-key adapter. GET only, fixed origin, no Connect
 * headers, redirects, raw provider errors, environment dumps or key logging. */
export function createStripeReconciliationRead(key:string,request:typeof fetch=fetch):StripeRead {
 if(!key.startsWith('rk_live_'))throw Error('Restricted LIVE read credential required');
 return async(resource,params)=>{
  if(!/^\/v1\/(payment_intents(?:\/pi_[A-Za-z0-9_]+)?|charges(?:\/(?:ch|py)_[A-Za-z0-9_]+)?|refunds(?:\/(?:re|pyr)_[A-Za-z0-9_]+)?|balance_transactions(?:\/txn_[A-Za-z0-9_]+)?|payouts|invoice_payments)$/.test(resource))throw Error('Unsupported reconciliation read resource');
  const url=new URL('https://api.stripe.com'+resource);
  for(const [name,value]of Object.entries(params)) {
   if(!['limit','created[gte]','created[lt]','starting_after','invoice','status','payment_intent'].includes(name))throw Error('Unsupported reconciliation read parameter');
   url.searchParams.set(name,value);
  }
  let response:Response;
  try{response=await request(url,{method:'GET',headers:{Authorization:`Bearer ${key}`},redirect:'error',signal:AbortSignal.timeout(20000)});}
  catch{throw new StripeReconciliationReadError(resource,null);}
  if(!response.ok){await response.body?.cancel().catch(()=>{});throw new StripeReconciliationReadError(resource,response.status);}
  try{return await response.json();}catch{throw new StripeReconciliationReadError(resource,response.status);}
 };
}
