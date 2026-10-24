import test from 'node:test';
import assert from 'node:assert/strict';
import {planFinanceReconciliation} from '../lib/financeReconciliation.ts';
import {financeSourceCoverage} from '../lib/financeSourceCoverage.ts';
import {summarizeLedger} from '../lib/adminPortalFinance.ts';
import {readFinanceSummary} from '../lib/adminPortalFinanceRead.ts';
import {retrieveProviderFee} from '../lib/providerFeeCapture.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {runFinanceReconciliation} from '../lib/financeReconciliationWorker.ts';
import {readStripeReconciliation} from '../lib/stripeReconciliationRead.ts';

// All IDs are synthetic. Dates/amount distribution tests the supplied controls;
// this fixture is not a provider export or an approved accounting import.
function fixture() {
 const amounts=[2089,2089,25207,25207,23268,2089,2089,2089];
 const paymentDays=['09-27','09-28','09-28','09-29','10-06','10-06','10-06','10-06'];
 const refundDays=['09-28','09-28','09-28','10-02','10-08','10-06','10-06','10-08'];
 const receipts=amounts.flatMap((amountCents,i)=>{
  const base={accountId:'acct_synthetic',live:true,currency:'EUR',amountCents,paymentIntentId:`pi_synthetic_${i}`,chargeId:`ch_synthetic_${i}`,status:'succeeded',localSubjectId:`local_${i}`,localSubjectKind:i===2||i===3||i===4?'annual':'order'};
  return [{...base,kind:'payment',sourceId:base.paymentIntentId,parentId:base.chargeId,balanceTransactionId:`txn_pay_${i}`,occurredAt:`2026-${paymentDays[i]}T12:00:00Z`},
   {...base,kind:'refund',sourceId:`re_synthetic_${i}`,parentId:base.chargeId,balanceTransactionId:`txn_refund_${i}`,occurredAt:`2026-${refundDays[i]}T12:00:00Z`}];
 });
 const subjects=receipts.filter(r=>r.kind==='payment').map(r=>({id:r.localSubjectId,kind:r.localSubjectKind,paymentIntentId:r.paymentIntentId,amountCents:r.amountCents}));
 return {accountId:'acct_synthetic',receipts,subjects,unmappedLegacyEventIds:[],existing:[],periods:{'2026-09':'open','2026-10':'open'}};
}
test('all eight synthetic payments and refunds reconcile separate months without inventing provider IDs',()=>{
 const input=fixture(), p=planFinanceReconciliation(input);assert.deepEqual(p.blockers,[]);assert.equal(p.entries.length,16);
 const total=(kind,month)=>p.entries.filter(e=>e.key.includes(`:${kind}:`)&&e.occurredOn.startsWith(month)).reduce((n,e)=>n+e.amountCents,0);
 assert.equal(total('payment','2026-09'),54592);assert.equal(total('refund','2026-09'),29385);
 assert.equal(total('payment','2026-10'),29535);assert.equal(total('refund','2026-10'),54742);
 assert.equal(total('payment','2026'),84127);assert.equal(total('refund','2026'),84127);
});
test('repeated webhook evidence and partial reconciliation recovery never propose committed entries twice',()=>{
 const input=fixture(), first=planFinanceReconciliation(input);
 for(const count of [1,7,16]){const existing=first.entries.slice(0,count);const next=planFinanceReconciliation({...input,existing});assert.deepEqual(next.blockers,[]);assert.equal(next.entries.length,16-count);assert.ok(next.entries.every(e=>!existing.some(old=>old.key===e.key)));}
 assert.ok(planFinanceReconciliation({...input,receipts:[...input.receipts,input.receipts[0]]}).blockers.some(x=>x.includes('duplicate_source')));
});
test('unknown old ledger mapping, wrong amounts and source conflicts block entire plan',()=>{
 const input=fixture();assert.equal(planFinanceReconciliation({...input,unmappedLegacyEventIds:['legacy_refund']}).entries.length,0);
 input.subjects[0].amountCents++;assert.ok(planFinanceReconciliation(input).blockers.some(x=>x.includes('local_snapshot_conflict')));
 const valid=fixture(), old=planFinanceReconciliation(valid).entries[0];
 assert.ok(planFinanceReconciliation({...valid,existing:[{...old,amountCents:1}]}).blockers.some(x=>x.includes('existing_conflict')));
});
test('missing balance transactions, unknown/closed periods, pending refunds and over-refunds fail closed',()=>{
 for(const change of [x=>x.receipts[0].balanceTransactionId=null,x=>x.receipts[1].status='pending',x=>x.receipts[1].amountCents=999999,x=>x.periods['2026-09']='closed',x=>delete x.periods['2026-10']]){
  const input=fixture();change(input);const result=planFinanceReconciliation(input);assert.ok(result.blockers.length);assert.deepEqual(result.entries,[]);
 }
});
test('wrong account, mode, currency, timestamps or missing invoice-resolved mapping never pass',()=>{
 for(const change of [x=>x.receipts[0].accountId='acct_other',x=>x.receipts[0].live=false,x=>x.receipts[0].currency='USD',x=>x.receipts[0].occurredAt='2026-10-01',x=>x.subjects=[]]){const input=fixture();change(input);assert.ok(planFinanceReconciliation(input).blockers.length);}
});
test('payment fees have unique Balance Transaction keys; usage fees and failed payouts stay separate',()=>{
 const input=fixture(), payment=input.receipts[0];
 const fee={...payment,kind:'payment_fee',sourceId:payment.balanceTransactionId,parentId:payment.balanceTransactionId,amountCents:100};
 const usage={accountId:input.accountId,live:true,currency:'EUR',kind:'usage_fee',sourceId:'txn_usage',parentId:'provider_invoice_synthetic',balanceTransactionId:'txn_usage',amountCents:30,status:'succeeded',occurredAt:'2026-10-09T12:00:00Z'};
 const payout={...usage,kind:'payout',sourceId:'po_failed',status:'failed',amountCents:1787};
 input.receipts.push(fee,usage,payout);const first=planFinanceReconciliation(input);assert.deepEqual(first.blockers,[]);assert.equal(first.entries.length,18);assert.equal(first.excluded.length,1);
 assert.equal(planFinanceReconciliation({...input,existing:first.entries}).entries.length,0);
 input.receipts.push({...usage,sourceId:fee.sourceId,balanceTransactionId:fee.balanceTransactionId});assert.ok(planFinanceReconciliation(input).blockers.some(x=>x.includes('usage_is_payment_or_refund_transaction')));
});
test('original Berlin accounting dates survive retry; closed periods require a separately approved adjustment',()=>{
 const input=fixture();input.receipts[1].occurredAt='2026-09-30T22:30:00Z';
 const result=planFinanceReconciliation(input);assert.equal(result.entries.find(e=>e.key.includes('re_synthetic_0')).occurredOn,'2026-10-01');
 const prior=JSON.stringify(input);planFinanceReconciliation({...input,periods:{}});assert.equal(JSON.stringify(input),prior);
});
const source=(id,amount,paid,refunded)=>({id,source_kind:'annual',total_gross_cents:amount,refunded_total_cents:amount,purchased_at:paid,refund_updated_at:refunded});
const september={from:'2026-09-01',to:'2026-10-01'},october={from:'2026-10-01',to:'2026-11-01'};
test('empty September ledger with historical paid/refunded sources is incomplete, never zero-fee confirmed',()=>{
 const sources=[source('a',25207,'2026-09-28T12:00:00Z','2026-09-28T13:00:00Z'),source('b',25207,'2026-09-29T12:00:00Z','2026-10-02T12:00:00Z')];
 const c=financeSourceCoverage(sources,[],september);assert.equal(c.missingPayments,2);assert.equal(c.missingRefunds,1);assert.equal(c.complete,false);
 const s=summarizeLedger([],[],[],{subjects:[],coverage:[],months:[],generalCoverage:[],undatedEvents:0,undatedFulfilments:0,sourceCoverage:c});
 assert.equal(s.providerFeeCents,null);assert.equal(s.contributionMarginCents,null);assert.equal(s.resultComplete,false);assert.match(s.costBlockers.join(' '),/Ledger-Abgleich/);
 const oct=financeSourceCoverage(sources,[],october);assert.equal(oct.missingPayments,0);assert.equal(oct.missingRefunds,1);
});
test('partial refunds compare all historical events without redating or duplicating them',()=>{
 const sources=[source('a',1000,'2026-09-28T12:00:00Z','2026-10-02T12:00:00Z')];
 const rows=[{id:'p',annual_plan_id:'a',kind:'annual_prepayment',gross_cents:1000,occurred_on:'2026-09-28'},{id:'r1',annual_plan_id:'a',kind:'refund',gross_cents:400,occurred_on:'2026-09-29'},{id:'r2',annual_plan_id:'a',kind:'refund',gross_cents:600,occurred_on:'2026-10-02'}];
 const before=JSON.stringify(rows);assert.equal(financeSourceCoverage(sources,rows,october).complete,true);assert.equal(JSON.stringify(rows),before);
 assert.equal(financeSourceCoverage(sources,rows.slice(0,2),october).missingRefunds,1);
 assert.equal(financeSourceCoverage(sources,[...rows,{...rows[2],id:'duplicate'}],october).conflicts,1);
});
test('shared Finance/Overview read fails closed on source outage, and excludes prepaid delivery orders',async()=>{
 const basis={events:[],expenses:[],providerEvidence:[],subjects:[],coverage:[],months:[],generalCoverage:[],undatedEvents:0,undatedFulfilments:0};
 const read=async(fail)=>readFinanceSummary({rpc:async()=>({data:structuredClone(basis),error:null}),from:table=>{
  const data=table==='orders'?[{id:'delivery',checkout_attempt_id:'attempt',total_gross_cents:1939,refunded_total_cents:0,placed_at:'2026-10-02T12:00:00Z'}]:table==='checkout_attempts'?[{id:'attempt',annual_plan_id:'plan'}]:[];
  const query=new Proxy({then:resolve=>Promise.resolve({data,error:fail?Error('unavailable'):null,count:data.length}).then(resolve)},{get:(target,key)=>key==='then'?target.then:()=>query});return query;
 }},october);
 assert.equal((await read(false)).summary.sourceCoverage.complete,true);
 const failed=await read(true);assert.equal(failed.summary.sourceCoverage.status,'unavailable');assert.equal(failed.summary.providerFeeCents,null);assert.equal(failed.summary.resultCents,null);
});
test('fee capture rejects inconsistent provider amounts/net, leaving missing data retryable',async()=>{
 const base={paymentIntents:{retrieve:async()=>({id:'pi_s',status:'succeeded',amount_received:1000,currency:'eur',latest_charge:'ch_s'})},charges:{retrieve:async()=>({id:'ch_s',paid:true,captured:true,amount:1000,payment_intent:'pi_s',currency:'eur',balance_transaction:'txn_s'})},balanceTransactions:{retrieve:async()=>({id:'txn_s',source:'ch_s',type:'charge',amount:1000,fee:100,net:900,currency:'eur',created:1791547200})}};
 const e={id:'local',payment_intent_id:'pi_s',invoice_id:null,currency:'EUR',capture_status:'pending'};
 assert.equal((await retrieveProviderFee(base,e)).feeCents,100);
 for(const bad of [{net:1000},{amount:999},{net:null},{fee:null}]){const provider={...base,balanceTransactions:{retrieve:async()=>({...await base.balanceTransactions.retrieve(),...bad})}};await assert.rejects(retrieveProviderFee(provider,e));}
});
test('offline CLI emits review-only plans, refuses overwrite and cannot apply records',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gloa-finance-plan-'));
 const input=path.join(dir,'input.json'),output=path.join(dir,'plan.json');
 try {
  fs.writeFileSync(input,JSON.stringify(fixture()));
  const run=()=>spawnSync(process.execPath,['scripts/finance-reconciliation-plan.mjs',input,output],{encoding:'utf8'});
  const success=run();assert.equal(success.status,0,success.stderr);const plan=JSON.parse(fs.readFileSync(output,'utf8'));assert.equal(plan.mode,'DRY_RUN_ONLY');assert.equal(plan.readyForDatabaseExecution,false);assert.equal(plan.entries.length,16);
  const before=fs.readFileSync(output,'utf8');assert.equal(run().status,1);assert.equal(fs.readFileSync(output,'utf8'),before);
  fs.unlinkSync(output);const blocked=fixture();blocked.receipts[0].balanceTransactionId=null;fs.writeFileSync(input,JSON.stringify(blocked));assert.equal(run().status,2);assert.equal(JSON.parse(fs.readFileSync(output,'utf8')).entries.length,0);
 } finally {for(const file of [input,output])if(fs.existsSync(file))fs.unlinkSync(file);fs.rmdirSync(dir);}
});
test('real provider payment/py/pyr shapes pass without changing original correlation rules',async()=>{
 const input=fixture();for(const r of input.receipts){r.chargeId=r.chargeId.replace('ch_','py_');r.parentId=r.parentId.replace('ch_','py_');if(r.kind==='refund')r.sourceId=r.sourceId.replace('re_','pyr_');}
 assert.deepEqual(planFinanceReconciliation(input).blockers,[]);
 const e={id:'local',payment_intent_id:'pi_s',invoice_id:null,currency:'EUR',capture_status:'pending'};
 const provider={paymentIntents:{retrieve:async()=>({id:'pi_s',status:'succeeded',amount_received:1000,currency:'eur',latest_charge:'py_s'})},charges:{retrieve:async()=>({id:'py_s',paid:true,captured:true,amount:1000,payment_intent:'pi_s',currency:'eur',balance_transaction:'txn_s'})},balanceTransactions:{retrieve:async()=>({id:'txn_s',source:'py_s',type:'payment',reporting_category:'charge',amount:1000,fee:100,net:900,currency:'eur',created:1791547200})}};
 assert.equal((await retrieveProviderFee(provider,e)).chargeId,'py_s');
 provider.balanceTransactions.retrieve=async()=>({id:'txn_s',source:'py_s',type:'payment',reporting_category:'refund',amount:1000,fee:100,net:900,currency:'eur',created:1791547200});await assert.rejects(retrieveProviderFee(provider,e));
});
test('scheduled financial worker resumes partial failures; lost successful response is resolved read-only',async()=>{
 const input=fixture(), rows=new Map();let writes=0,fail=true;
 const store={read:async key=>rows.get(key)??null,record:async entry=>{writes++;if(writes===3&&fail)throw Error('before_commit');rows.set(entry.key,entry);if(writes===1)throw Error('lost_response_after_commit');return entry;}};
 const first=await runFinanceReconciliation(input,store);assert.equal(first.status,'retry_required');assert.equal(first.confirmed,2);assert.equal(writes,3);
 fail=false;const retry=await runFinanceReconciliation(input,store);assert.equal(retry.status,'confirmed');assert.equal(rows.size,16);assert.equal(writes,17);
 assert.equal((await runFinanceReconciliation(input,store)).status,'confirmed');assert.equal(writes,17);
});
test('empty unverified account or stale claimed completion cannot report synchronization success',async()=>{
 const input=fixture(),existing=planFinanceReconciliation(input).entries;
 assert.ok(planFinanceReconciliation({...input,accountId:null,receipts:[]}).blockers.includes('verified_account_id_required'));
 let writes=0;const result=await runFinanceReconciliation({...input,existing},{read:async()=>null,record:async()=>{writes++;throw Error('must not write');}});assert.equal(result.status,'retry_required');assert.equal(writes,0);
});
test('read collector paginates without PII and declares missing READ scopes or truncated pages',async()=>{
 const calls=[];const get=async(path,params)=>{calls.push({path,params});if(path.endsWith('/pi_identity'))return {id:'pi_identity',livemode:true,amount_received:100,currency:'eur',status:'succeeded'};if(path==='/v1/account')throw Error('403');if(path==='/v1/charges')return params.starting_after?{data:[{id:'py_b',livemode:true,amount:100,customer:'PII-MUST-NOT-LEAK'}],has_more:false}:{data:[{id:'py_a',livemode:true,amount:100,customer:'PII-MUST-NOT-LEAK'}],has_more:true};return {data:[],has_more:false};};
 const result=await readStripeReconciliation(get,1,2,{accountId:'acct_synthetic',paymentIntentId:'pi_identity',amountCents:100});assert.equal(result.complete,true);assert.deepEqual(result.failures,[]);assert.equal(calls.some(c=>c.path==='/v1/account'),false);assert.equal(result.objects.charges.length,2);assert.doesNotMatch(JSON.stringify(result),/PII-MUST-NOT-LEAK/);
 assert.equal(calls.filter(c=>c.path==='/v1/charges').length,2);
 const broken=await readStripeReconciliation(async(path,params)=>path==='/v1/refunds'?{data:[],has_more:true}:get(path,params),1,2,{accountId:'acct_synthetic',paymentIntentId:'pi_identity',amountCents:100});assert.ok(broken.failures.includes('refunds'));assert.equal(broken.objects.refunds,undefined);
});
