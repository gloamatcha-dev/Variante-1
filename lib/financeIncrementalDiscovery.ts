import type {readStripeReconciliation,StripeRead,StripeReadCheckpoint} from './stripeReconciliationRead.ts';
type FullReader=typeof readStripeReconciliation;
/** Balance discovery keeps the established overlap. Recorded immutable money is
 * re-audited daily; new refund IDs always hydrate their original payment. */
export function incrementalFinanceDiscovery(known:(ids:string[])=>Promise<string[]>):FullReader {
 return async(get:StripeRead,from,to,identity,progress)=>{
  const knownPayment=await get('/v1/payment_intents/'+identity.paymentIntentId,{});
  if(knownPayment.id!==identity.paymentIntentId||knownPayment.livemode!==true||knownPayment.status!=='succeeded'||knownPayment.currency!=='eur'||knownPayment.amount_received!==identity.amountCents)throw Error('live_identity_unverified');
  const saved=progress?.load('balance_transactions');
  const state:StripeReadCheckpoint={rows:[...(saved?.rows??[])],cursor:saved?.cursor??'',done:saved?.done??false};
  const seen=new Set(state.rows.map(r=>String(r.id)));
  while(!state.done){
   const page=await get('/v1/balance_transactions',{limit:'100','created[gte]':String(from),'created[lt]':String(to),...(state.cursor?{starting_after:state.cursor}:{})});
   if(!Array.isArray(page.data)||typeof page.has_more!=='boolean')throw Error('balance_page_invalid');
   for(const row of page.data){if(typeof row.id!=='string'||seen.has(row.id))throw Error('balance_page_duplicate');seen.add(row.id);state.rows.push(Object.fromEntries(['id','amount','fee','net','currency','created','available_on','source','type','reporting_category','status'].filter(k=>k in row).map(k=>[k,row[k]])));}
   const next=page.data.at(-1)?.id;
   if(page.has_more&&(!next||next===state.cursor))throw Error('balance_page_incomplete');
   state.cursor=next??state.cursor;state.done=!page.has_more;await progress?.save('balance_transactions',state);
  }
  const skip=new Set(await known(state.rows.map(r=>String(r.id))));
  const objects={payment_intents:[],charges:[],refunds:[],balance_transactions:state.rows.filter(r=>!skip.has(String(r.id))),payouts:[]};
  // Finish authority expects all five discovery checkpoints, including empty lists.
  for(const name of ['payment_intents','charges','refunds','payouts'])await progress?.save(name,{rows:[],cursor:'',done:true});
  return {accountId:identity.accountId,accountVerification:'operator_binding_and_known_live_payment' as const,live:true,from,to,complete:true,failures:[],objects};
 };
}
