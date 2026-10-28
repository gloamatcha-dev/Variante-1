import {runAutomaticFinanceSync} from '../../lib/automaticFinanceSync.ts';
const epoch=s=>Date.parse(s)/1000;
export function setup(){
 const paid=epoch('2026-09-29T12:00:00Z'),refunded=epoch('2026-10-02T12:00:00Z');
 const config={account_id:'acct_test',known_payment_intent:'pi_known',known_amount_cents:1070};
 const intent={id:'pi_test',livemode:true,status:'succeeded',amount:1070,amount_received:1070,currency:'eur',created:paid,latest_charge:'py_test'};
 const charge={id:'py_test',livemode:true,paid:true,captured:true,amount:1070,amount_captured:1070,amount_refunded:1070,currency:'eur',created:paid,payment_intent:'pi_test',balance_transaction:'txn_pay'};
 const refund={id:'pyr_test',payment_intent:'pi_test',charge:'py_test',currency:'eur',status:'succeeded',amount:1070,created:refunded,balance_transaction:'txn_ref'};
 const bt=[{id:'txn_pay',source:'py_test',type:'payment',reporting_category:'charge',amount:1070,fee:23,net:1047,currency:'eur',created:paid},{id:'txn_ref',source:'pyr_test',type:'payment_refund',reporting_category:'refund',amount:-1070,fee:0,net:-1070,currency:'eur',created:refunded},{id:'txn_usage',source:null,type:'stripe_fee',reporting_category:'fee',amount:-15,fee:0,net:-15,currency:'eur',created:paid},{id:'txn_payout',source:'po_failed',type:'payout',reporting_category:'payout',amount:1787,fee:0,net:1787,currency:'eur',created:paid},{id:'txn_failure',source:'po_failed',type:'payout_failure',reporting_category:'payout_reversal',amount:-1787,fee:0,net:-1787,currency:'eur',created:paid}];
 const source={id:'00000000-0000-0000-0000-000000000001',kind:'order',paymentIntentId:'pi_test',invoiceId:null,amountCents:1070,currency:'EUR',refundedCents:0};
 const state={active:false,completed:false,checkpoint:{},token:0,records:new Map(),ledger:[],issues:new Map(),writes:0,readCalls:[],rpcCalls:[],failRead:false,failRecord:false,loseResponse:false,review:false,now:Date.now(),expireAfterRecord:false};
 const rpc=async(name,args)=>{
  state.rpcCalls.push(name);
  if(name==='finance_sync_claim_v1'){if(state.active)return {status:'busy'};state.active=true;if(state.completed){state.checkpoint={};state.completed=false;}return {status:'claimed',id:'job',lease_token:'token_'+(++state.token),scan_from:'2026-09-01T00:00:00Z',scan_to:new Date(state.now).toISOString(),checkpoint:structuredClone(state.checkpoint)};}
  if(name==='finance_sync_checkpoint_v1'){state.checkpoint=structuredClone(args.p_checkpoint);if(args.p_state==='retry')state.active=false;return {status:args.p_state};}
  if(name==='finance_sync_basis_v1')return {sources:[source],ledger:structuredClone(state.ledger)};
  if(name==='finance_sync_retry_ids_v1')return {payments:[...state.issues.keys()].filter(id=>id.startsWith('pi_')).map(id=>({id})),fees:[]};
  if(name==='finance_sync_stage_v1'){const r=args.p_receipt;const k=`${r.accountId}:live:${r.kind}:${r.sourceId}`;if(!state.records.has(k))state.records.set(k,{receipt:r,state:'queued'});return k;}
  if(name==='finance_sync_record_v1'){
   const entry=state.records.get(args.p_key);if(state.failRecord){state.failRecord=false;throw Error('DB unavailable');}
   if(state.review){entry.state='review';return {result:'review_required'};}
   if(entry.state!=='recorded'){
    const r=entry.receipt;const kind=r.kind==='payment'?'order_payment':r.kind;
    if(r.kind!=='usage_fee'&&!state.ledger.some(e=>e.kind===kind&&e.order_id===r.localSubjectId))state.ledger.push({id:'ledger_'+r.sourceId,kind,order_id:r.localSubjectId,gross_cents:r.amountCents,occurred_on:r.occurredAt.slice(0,10),external_reference:r.kind==='payment'?r.paymentIntentId:r.sourceId});
    entry.state='recorded';state.writes++;
   }
   if(state.expireAfterRecord){state.now+=100000;state.expireAfterRecord=false;}
   if(state.loseResponse){state.loseResponse=false;throw Error('response lost after COMMIT');}
   return {result:'recorded',parentVerified:true};
  }
  if(name==='finance_sync_source_read_v1'){const e=state.records.get(args.p_key);return e?.state==='recorded'?{state:'recorded',amountCents:e.receipt.amountCents,occurredOn:e.receipt.occurredAt.slice(0,10),parentVerified:true}:null;}
  if(name==='finance_sync_failure_v1')return null;
  if(name==='finance_sync_discrepancy_v1'){if(args.p_code===null)state.issues.delete(args.p_source);else state.issues.set(args.p_source,args.p_code);return null;}
  if(name==='finance_sync_finish_v1'){state.active=false;state.completed=true;return {state:state.issues.size||state.review?'attention':'verified'};}
  throw Error('Unexpected RPC '+name);
 };
 const read=async(path,params)=>{
  state.readCalls.push({path,params});if(path==='/v1/payment_intents/pi_known'&&!state.failRead)return {id:'pi_known',livemode:true,status:'succeeded',currency:'eur',amount_received:1070};if(state.failRead)throw Error('Stripe unavailable');
  const direct={'/v1/refunds/pyr_test':refund,'/v1/payment_intents/pi_test':intent,'/v1/charges/py_test':charge,...Object.fromEntries(bt.map(b=>['/v1/balance_transactions/'+b.id,b]))};if(direct[path])return structuredClone(direct[path]);
  const lists={'/v1/payment_intents':[intent],'/v1/charges':[charge],'/v1/refunds':[refund],'/v1/balance_transactions':bt,'/v1/payouts':[{id:'po_failed',livemode:true,amount:-1787,status:'failed',created:paid,balance_transaction:'txn_payout'}]};
  if(lists[path])return {data:structuredClone(lists[path]),has_more:false};throw Error('Unexpected GET '+path);
 };
 const run=()=>runAutomaticFinanceSync({rpc,read,config,now:()=>state.now,budgetMs:45000});
 return {state,run,read,rpc,config,source,intent,refund};
}
