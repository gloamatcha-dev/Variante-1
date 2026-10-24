import test from 'node:test';import assert from 'node:assert/strict';
import {runAutomaticFinanceSync} from '../lib/automaticFinanceSync.ts';
import {financeSyncCoverage} from '../lib/financeSyncMonitoring.ts';
import fs from 'node:fs';import vm from 'node:vm';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),ts=require('typescript');
const epoch=s=>Date.parse(s)/1000;
function setup(){
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
  const direct={'/v1/payment_intents/pi_test':intent,'/v1/charges/py_test':charge,...Object.fromEntries(bt.map(b=>['/v1/balance_transactions/'+b.id,b]))};if(direct[path])return structuredClone(direct[path]);
  const lists={'/v1/payment_intents':[intent],'/v1/charges':[charge],'/v1/refunds':[refund],'/v1/balance_transactions':bt,'/v1/payouts':[{id:'po_failed',livemode:true,amount:-1787,status:'failed',created:paid,balance_transaction:'txn_payout'}]};
  if(lists[path])return {data:structuredClone(lists[path]),has_more:false};throw Error('Unexpected GET '+path);
 };
 const run=()=>runAutomaticFinanceSync({rpc,read,config,now:()=>state.now,budgetMs:45000});
 return {state,run,read,rpc,config,source,intent,refund};
}
test('independent scheduler repairs missing payment/refund webhook effects and excludes failed payout',async()=>{
 const {state,run}=setup();assert.equal((await run()).state,'verified',JSON.stringify({rpc:state.rpcCalls,reads:state.readCalls}));assert.equal(state.records.size,4);assert.equal(state.writes,4);assert.ok([...state.records.values()].every(e=>e.receipt.kind!=='payout'));
 assert.equal(state.ledger.find(e=>e.kind==='refund').occurred_on,'2026-10-02');assert.equal(state.ledger.find(e=>e.kind==='order_payment').occurred_on,'2026-09-29');
 const totals=kind=>state.ledger.filter(e=>e.kind===kind).reduce((n,e)=>n+e.gross_cents,0);assert.equal(totals('order_payment'),1070);assert.equal(totals('refund'),1070);assert.equal(totals('payment_fee'),23);
 assert.equal((await run()).state,'verified');assert.equal(state.writes,4);assert.ok(!state.rpcCalls.some(n=>n.includes('webhook')));
});
test('processed webhook or existing ledger never prevents independent reconciliation or creates duplicate income',async()=>{
 const {state,run}=setup();state.ledger.push({id:'existing',kind:'order_payment',order_id:'00000000-0000-0000-0000-000000000001',gross_cents:1070,occurred_on:'2026-09-29',external_reference:'pi_test'});
 await run();await run();assert.equal(state.ledger.filter(e=>e.kind==='order_payment').length,1);assert.equal(state.ledger.filter(e=>e.kind==='refund').length,1);
});
test('parallel scheduler runs do not overlap and lost committed response is reconciled by read',async()=>{
 const {state,run}=setup();state.loseResponse=true;const results=await Promise.all([run(),run()]);assert.ok(results.some(r=>r.state==='busy'));assert.ok(results.some(r=>r.state==='verified'));assert.equal(state.writes,4);assert.ok(state.rpcCalls.includes('finance_sync_source_read_v1'));
});
test('interruption after a committed effect resumes durable page checkpoint without duplicate writes',async()=>{
 const {state,run}=setup();state.expireAfterRecord=true;assert.equal((await run()).state,'continuation_required');assert.equal(state.writes,1);assert.ok(state.checkpoint.resources.payment_intents.done);
 const listCalls=state.readCalls.filter(c=>c.path==='/v1/payment_intents').length;assert.equal((await run()).state,'verified');assert.equal(state.writes,4);assert.equal(state.readCalls.filter(c=>c.path==='/v1/payment_intents').length,listCalls);
});
test('Stripe and Supabase failures remain explicit, queued and automatically retry on next invocation',async()=>{
 const one=setup();one.state.failRead=true;assert.equal((await one.run()).state,'retry_required');assert.equal(one.state.writes,0);one.state.failRead=false;assert.equal((await one.run()).state,'verified');
 const two=setup();two.state.failRecord=true;assert.equal((await two.run()).state,'attention');assert.equal(two.state.issues.size,1);assert.equal((await two.run()).state,'verified');assert.equal(two.state.writes,4);
});
test('closed/historical accounting review never writes financial effects or claims completeness',async()=>{
 const {state,run}=setup();state.review=true;assert.equal((await run()).state,'attention');assert.equal(state.writes,0);assert.ok([...state.records.values()].every(e=>e.state==='review'));
});
test('unmapped or non-final money facts generate durable discrepancies without guessed records',async()=>{
 const a=setup();a.source.paymentIntentId='pi_other';assert.equal((await a.run()).state,'attention');assert.equal(a.state.ledger.length,0);
 const b=setup();b.intent.status='processing';assert.equal((await b.run()).state,'attention');assert.equal(b.state.ledger.length,0);
});
test('malformed checkpoint index is rejected instead of declaring an empty successful scan',async()=>{
 const {state,run}=setup();state.checkpoint={paymentIds:['pi_test'],paymentIndex:999};assert.equal((await run()).state,'retry_required');assert.equal(state.writes,0);
});
test('dashboard refuses stale, missing, partial or historical-only scan coverage',()=>{
 const now=Date.parse('2026-10-24T12:00:00Z');const good={configured:true,state:'complete',last_success_at:'2026-10-24T11:00:00Z',verified_from:'2026-09-01T00:00:00Z',verified_to:'2026-10-24T11:00:00Z',missing_payments:0,missing_refunds:0,missing_fees:0,unresolved:0,persistent_failures:0,unbridged_events:0};const period={from:'2026-10-01',to:'2026-11-01'};
 assert.equal(financeSyncCoverage(good,period,now).verified,true);
 for(const bad of [null,{...good,state:'retry'},{...good,missing_refunds:1},{...good,missing_fees:null},{...good,last_success_at:'2026-10-20T00:00:00Z'},{...good,verified_to:'2026-09-08T00:00:00Z'}])assert.equal(financeSyncCoverage(bad,period,now).verified,false);
});
test('cron authenticates server-side before enable flag, READ key or database work',async()=>{
 const code=ts.transpileModule(fs.readFileSync('app/api/cron/finance-reconciliation/route.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const env={},compiled={exports:{}};let calls=0;
 vm.runInNewContext(code,{module:compiled,exports:compiled.exports,process:{env},Response,console,require:name=>name.includes('serverSecretAuth')?{isBearerSecretAuthorized:(req,key)=>req.headers.get('authorization')==='Bearer '+key}:name.includes('financeSyncServer')?{runFinanceSyncServer:async()=>{calls++;return {state:'verified'};}}:require(name)});
 const call=key=>compiled.exports.GET(new Request('http://127.0.0.1/api/cron/finance-reconciliation',{headers:key?{authorization:'Bearer '+key}:{}}));
 assert.equal((await call()).status,503);env.CRON_SECRET='synthetic-cron';assert.equal((await call()).status,401);assert.equal(calls,0);assert.equal((await (await call('synthetic-cron')).json()).state,'disabled');env.FINANCE_RECONCILIATION_ENABLED='true';assert.equal((await call('synthetic-cron')).status,200);assert.equal(calls,1);
});
test('durable alert sender uses daily source idempotency and retries unconfirmed delivery',async()=>{
 const code=ts.transpileModule(fs.readFileSync('lib/financeSyncServer.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 for(const fail of [false,true]){
  const sent=[],acks=[];const compiled={exports:{}};const admin={from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:{account_id:'acct_test',enabled:true},error:null})})})}),rpc:async(name,args)=>({data:name==='finance_sync_alert_v1'&&!args.p_id?{id:'alert_synthetic',lease_token:'lease'}:name==='finance_sync_status_v1'?{missing_payments:1,missing_refunds:1,missing_fees:1,unresolved:1}:(acks.push(args),{}),error:null})};
  vm.runInNewContext(code,{module:compiled,exports:compiled.exports,process:{env:{STRIPE_RECONCILIATION_READ_KEY:['rk','live','synthetic'].join('_'),FINANCE_ALERT_EMAIL:'finance@example.invalid',FINANCE_ALERT_FROM:'GLOA <local@example.invalid>',RESEND_API_KEY:'synthetic-not-a-credential'}},Date,require:name=>name.includes('supabaseAdmin')?{getSupabaseAdmin:()=>admin}:name.includes('stripeReconciliationClient')?{createStripeReconciliationRead:()=>{}}:name.includes('automaticFinanceSync')?{runAutomaticFinanceSync:async()=>({state:'attention',caughtUp:true})}:name==='resend'?{Resend:class{emails={send:async(message,options)=>{sent.push({message,options});return fail?{error:{}}:{data:{id:'mail_synthetic'}};}}}}:require(name)});
  const result=await compiled.exports.runFinanceSyncServer();assert.equal(sent.length,1);assert.equal(sent[0].options.idempotencyKey,'gloa-finance-sync-alert/alert_synthetic');assert.equal(result.alertState,fail?'retry_required':'sent');assert.equal(acks.at(-1).p_sent,!fail);
 }
});
