import test from 'node:test';import assert from 'node:assert/strict';
import {readStripeReconciliation,readStripeInvoicePayments} from '../lib/stripeReconciliationRead.ts';
import {normalizeFinanceEvidence} from '../lib/financeReconciliationEvidence.ts';
import {synchronizeFinanceEvidence} from '../lib/financeEvidenceSynchronization.ts';
import {planFinanceReconciliation} from '../lib/financeReconciliation.ts';
import {createStripeReconciliationRead,StripeReconciliationReadError} from '../lib/stripeReconciliationClient.ts';

function fixture(){
 const created=Date.parse('2026-09-29T12:00:00Z')/1000,refunded=Date.parse('2026-10-02T12:00:00Z')/1000;
 const sources=[{id:'annual',kind:'annual',paymentIntentId:'pi_a',invoiceId:null,amountCents:1000,currency:'EUR',refundedCents:1000},{id:'order',kind:'order',paymentIntentId:null,invoiceId:'in_b',amountCents:500,currency:'EUR',refundedCents:500}];
 const objects={payment_intents:[],charges:[],refunds:[],balance_transactions:[],payouts:[{id:'po_s',amount:-50,created,livemode:true,status:'failed',balance_transaction:'txn_payout'}]};
 for(const [i,s]of sources.entries()){
  const suffix=i===0?'a':'b',pi='pi_'+suffix,charge='py_'+suffix,bt='txn_'+suffix,refund='pyr_'+suffix,rbt='txn_ref_'+suffix,fee=(i+1)*10;
  objects.payment_intents.push({id:pi,livemode:true,status:'succeeded',amount_received:s.amountCents,currency:'eur',latest_charge:charge});
  objects.charges.push({id:charge,livemode:true,paid:true,captured:true,amount:s.amountCents,amount_captured:s.amountCents,amount_refunded:s.amountCents,currency:'eur',payment_intent:pi,balance_transaction:bt,created});
  objects.refunds.push({id:refund,charge,payment_intent:pi,amount:s.amountCents,currency:'eur',status:'succeeded',created:refunded,balance_transaction:rbt});
  objects.balance_transactions.push({id:bt,source:charge,amount:s.amountCents,fee,net:s.amountCents-fee,currency:'eur',type:'payment',reporting_category:'charge',created},{id:rbt,source:refund,amount:-s.amountCents,fee:0,net:-s.amountCents,currency:'eur',type:'payment_refund',reporting_category:'refund',created:refunded});
 }
 objects.balance_transactions.push({id:'txn_usage',source:null,amount:-15,fee:0,net:-15,currency:'eur',type:'stripe_fee',reporting_category:'fee',created});
 const provider={accountId:'acct_synthetic',accountVerification:'operator_binding_and_known_live_payment',live:true,complete:true,objects,invoicePayments:[{invoiceId:'in_b',invoicePaymentId:'inpay_b',paymentIntentId:'pi_b',amountPaidCents:500,paidAt:created}]};
 const ledger=[{id:'old_income',kind:'annual_prepayment',annual_plan_id:'annual',gross_cents:1000,occurred_on:'2026-09-29',external_reference:'pi_a'},{id:'old_refund',kind:'refund',annual_plan_id:'annual',gross_cents:1000,occurred_on:'2026-10-02',external_reference:'pi_a'}];
 return [provider,sources,ledger,{'2026-09':'open','2026-10':'open'},true];
}
test('verified operator account binding and known LIVE object do not request Account or Connect',async()=>{
 const calls=[];const get=async(path)=>{calls.push(path);if(path==='/v1/payment_intents/pi_known')return {id:'pi_known',livemode:true,amount_received:100,status:'succeeded',currency:'eur'};assert.notEqual(path,'/v1/account');return {data:[],has_more:false};};
 const r=await readStripeReconciliation(get,1,2,{accountId:'acct_verified',paymentIntentId:'pi_known',amountCents:100});assert.equal(r.complete,true);assert.equal(r.accountId,'acct_verified');assert.equal(calls.length,6);
 await assert.rejects(readStripeReconciliation(get,1,2,{accountId:'',paymentIntentId:'pi_known',amountCents:100}),/invalid_identity/);
 await assert.rejects(readStripeReconciliation(async()=>({id:'pi_known',livemode:false,amount_received:100,status:'succeeded',currency:'eur'}),1,2,{accountId:'acct_verified',paymentIntentId:'pi_known',amountCents:100}),/live_identity_unverified/);
});
test('Invoice Payments use exact invoice/PI/status/LIVE/currency/amount/paid_at and paginate',async()=>{
 const row=id=>({id,invoice:'in_b',livemode:true,currency:'eur',amount_paid:500,status:'paid',status_transitions:{paid_at:1790683200},payment:{type:'payment_intent',payment_intent:'pi_b'}});
 const calls=[];const get=async(path,params)=>{calls.push({path,params});return {data:[row(params.starting_after?'inpay_2':'inpay_1')],has_more:!params.starting_after};};
 const r=await readStripeInvoicePayments(get,['in_b']);assert.equal(r.length,2);assert.equal(calls[1].params.starting_after,'inpay_1');
 for(const bad of [{invoice:'in_other'},{livemode:false},{status:'open'},{currency:'usd'},{amount_paid:null},{status_transitions:{paid_at:null}},{payment:{type:'payment_record'}}])await assert.rejects(readStripeInvoicePayments(async()=>({data:[{...row('inpay_1'),...bad}],has_more:false}),['in_b']));
 await assert.rejects(readStripeInvoicePayments(async()=>({data:[],has_more:true}),['in_b']),/incomplete_invoice_page/);
});
test('automatic exact-ID normalization links legacy rows and generates only missing effects',()=>{
 const args=fixture(),before=JSON.stringify(args),result=normalizeFinanceEvidence(...args);assert.deepEqual(result.blockers,[]);assert.equal(result.bridges.length,2);assert.equal(result.feeChecks.length,2);assert.equal(result.input.subjects[1].paymentIntentId,'pi_b');
 const plan=planFinanceReconciliation(result.input);assert.deepEqual(plan.blockers,[]);assert.equal(plan.entries.length,5);assert.equal(plan.excluded.length,1);assert.equal(JSON.stringify(args),before);
 assert.ok(plan.entries.some(e=>e.key.endsWith('refund:pyr_b')&&e.occurredOn==='2026-10-02'));
});

test('cash dates follow capture/refund balance transactions rather than earlier requests',()=>{
 const args=fixture();args[2]=[];
 args[0].objects.charges[0].created=Date.parse('2026-08-31T12:00:00Z')/1000;
 args[0].objects.refunds[0].created=Date.parse('2026-09-30T12:00:00Z')/1000;
 const result=normalizeFinanceEvidence(...args);assert.deepEqual(result.blockers,[]);
 const receipts=result.input.receipts.filter(r=>r.paymentIntentId==='pi_a');
 assert.equal(receipts.find(r=>r.kind==='payment').occurredAt,'2026-09-29T12:00:00.000Z');
 assert.equal(receipts.find(r=>r.kind==='refund').occurredAt,'2026-10-02T12:00:00.000Z');
});
test('normalization refuses missing invoice links, amount-only mapping, partial evidence and conflicts',()=>{
 const changes=[a=>a[0].invoicePayments=[],a=>a[0].invoicePayments.push(a[0].invoicePayments[0]),a=>a[0].invoicePayments[0].paymentIntentId='pi_other',a=>a[0].invoicePayments[0].amountPaidCents=1,a=>a[0].complete=false,a=>a[0].objects.balance_transactions[0].net=0,a=>a[1][0].refundedCents=99999,a=>a[2][0].external_reference='pi_other',a=>a[2][1].occurred_on='2026-09-29',a=>a[4]=false];
 for(const change of changes){const args=fixture();change(args);const r=normalizeFinanceEvidence(...args);assert.equal(r.input,null);assert.ok(r.blockers.length);assert.deepEqual(r.bridges,[]);}
});
test('unknown/closed periods block the integrated pipeline before the storage port',async()=>{
 for(const periods of [{},{'2026-09':'closed','2026-10':'open'}]){const args=fixture();args[3]=periods;let calls=0;const result=await synchronizeFinanceEvidence(args,{read:async()=>{calls++;throw Error('must not read');},record:async()=>{calls++;throw Error('must not write');}});assert.equal(result.status,'blocked');assert.equal(calls,0);}
});
test('integrated dry run cannot write; mocked automatic processing is idempotent with confirmed legacy bridges',async()=>{
 const args=fixture(),dry=await synchronizeFinanceEvidence(args);assert.equal(dry.status,'review_required');assert.equal(dry.confirmed,0);assert.equal(dry.proposed,5);
 const normalized=normalizeFinanceEvidence(...args),rows=new Map(normalized.input.existing.map(e=>[e.key,e]));let writes=0;
 const store={read:async key=>rows.get(key)??null,record:async entry=>{writes++;rows.set(entry.key,entry);return entry;}};
 assert.equal((await synchronizeFinanceEvidence(args,store)).status,'confirmed');assert.equal(writes,5);assert.equal((await synchronizeFinanceEvidence(args,store)).status,'confirmed');assert.equal(writes,5);
});
test('restricted read adapter is GET-only without Account/Connect, redirects or secret error disclosure',async()=>{
 const syntheticKey=['rk','live','synthetic_not_a_credential'].join('_');let calls=0;
 const get=createStripeReconciliationRead(syntheticKey,async(url,options)=>{calls++;assert.equal(url.origin,'https://api.stripe.com');assert.equal(options.method,'GET');assert.equal(options.redirect,'error');assert.deepEqual(Object.keys(options.headers),['Authorization']);return Response.json({data:[],has_more:false});});
 await get('/v1/invoice_payments',{invoice:'in_synthetic',status:'paid',limit:'100'});assert.equal(calls,1);
 for(const resource of ['/v1/account','/v1/refunds/create','https://other.invalid','/v1/transfers'])await assert.rejects(get(resource,{}));
 await assert.rejects(get('/v1/refunds',{'Stripe-Account':'acct_other'}));assert.equal(calls,1);
 const failed=createStripeReconciliationRead(syntheticKey,async()=>new Response('sensitive provider error',{status:403}));
 await assert.rejects(failed('/v1/invoice_payments',{}),e=>e instanceof StripeReconciliationReadError&&e.status===403&&!e.message.includes('sensitive')&&!e.message.includes(syntheticKey));
 assert.throws(()=>createStripeReconciliationRead('not-a-key'));
});
