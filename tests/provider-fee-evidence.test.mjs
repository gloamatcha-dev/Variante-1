import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {createRequire} from 'node:module';
import {captureProviderFee,retrieveProviderFee} from '../lib/providerFeeCapture.ts';
const require=createRequire(import.meta.url);const {summarizeLedger}=require('../lib/adminPortalFinance.ts');
const evidence={id:'local',payment_intent_id:'pi_test',invoice_id:null,currency:'EUR',capture_status:'pending'};
function provider(fee=73){return {paymentIntents:{retrieve:async id=>({id,status:'succeeded',currency:'eur',latest_charge:'ch_test'})},charges:{retrieve:async id=>({id,paid:true,captured:true,payment_intent:'pi_test',currency:'eur',balance_transaction:'txn_test'})},balanceTransactions:{retrieve:async id=>({id,source:'ch_test',type:'charge',fee,currency:'eur',created:1791547200})},invoices:{retrieve:async id=>({id,status:'paid',currency:'eur',paid_out_of_band:false})},invoicePayments:{list:async()=>({has_more:false,data:[{invoice:'in_test',payment:{type:'payment_intent',payment_intent:'pi_test'}}]})}};}
test('Provider-confirmed positive and zero fees are exact values, never percentage estimates',async()=>{
 for(const fee of [0,73,1349]){const result=await retrieveProviderFee(provider(fee),evidence);assert.equal(result.feeCents,fee);assert.equal(result.balanceTransactionId,'txn_test');assert.equal(result.status,'checked');}
});
test('Initial 4-week subscription, renewal and B2B invoice use exact invoice payment relation',async()=>{
 for(const flow of ['initial','renewal','b2b_monthly','b2b_instalment']){const result=await retrieveProviderFee(provider(),{...evidence,id:flow,payment_intent_id:null,invoice_id:'in_test'});assert.equal(result.paymentIntentId,'pi_test');assert.equal(result.feeCents,73);}
});
test('Authoritative out-of-band invoice is not applicable; missing evidence is never treated as zero',async()=>{
 const stripe=provider();stripe.invoices.retrieve=async id=>({id,status:'paid',currency:'eur',paid_out_of_band:true});stripe.invoicePayments.list=async()=>({has_more:false,data:[]});
 assert.equal((await retrieveProviderFee(stripe,{...evidence,payment_intent_id:null,invoice_id:'in_test'})).status,'not_applicable');
 stripe.invoices.retrieve=async id=>({id,status:'paid',currency:'eur',paid_out_of_band:false});await assert.rejects(retrieveProviderFee(stripe,{...evidence,payment_intent_id:null,invoice_id:'in_test'}));
});
test('Current Stripe custom PaymentRecord proves only Stripe non-applicability',async()=>{
 const stripe=provider();stripe.invoicePayments.list=async()=>({has_more:false,data:[{invoice:'in_test',status:'paid',payment:{type:'payment_record',payment_record:'pr_test'}}]});stripe.paymentRecords={retrieve:async id=>({id,processor_details:{type:'custom'},amount:{currency:'eur'}})};
 assert.equal((await retrieveProviderFee(stripe,{...evidence,payment_intent_id:null,invoice_id:'in_test'})).status,'not_applicable');
 stripe.paymentRecords.retrieve=async id=>({id,processor_details:{type:'stripe'},amount:{currency:'eur'}});await assert.rejects(retrieveProviderFee(stripe,{...evidence,payment_intent_id:null,invoice_id:'in_test'}));
});
test('Delayed fee stays retryable and subsequent attempt records exact original payment fee',async()=>{
 const stripe=provider();stripe.charges.retrieve=async id=>({id,paid:true,captured:true,payment_intent:'pi_test',currency:'eur',balance_transaction:null});const saved=[];
 assert.equal(await captureProviderFee(stripe,evidence,async r=>saved.push(r)),'retryable');assert.equal(saved[0].feeCents,undefined);
 assert.equal(await captureProviderFee(provider(),evidence,async r=>saved.push(r)),'checked');assert.equal(saved[1].balanceTransactionId,'txn_test');
});
test('Provider and evidence persistence outages cannot throw into successful customer payment',async()=>{
 const stripe=provider();stripe.paymentIntents.retrieve=async()=>{throw Error('temporary provider outage');};
 assert.equal(await captureProviderFee(stripe,evidence,async()=>{throw Error('DB unavailable');}),'failed');
 assert.equal(await captureProviderFee(provider(),evidence,async()=>{throw Error('DB unavailable');}),'failed');
});
test('Currency mismatch, wrong source, unconfirmed charge and multiple invoice payments fail closed',async()=>{
 const mismatch=provider();mismatch.balanceTransactions.retrieve=async id=>({id,source:'ch_test',type:'charge',fee:73,currency:'usd',created:1791547200});
 const saves=[];assert.equal(await captureProviderFee(mismatch,evidence,async r=>saves.push(r)),'retryable');assert.equal(saves[0].errorCode,'currency_mismatch');
 const wrong=provider();wrong.balanceTransactions.retrieve=async id=>({id,source:'ch_someone_else',type:'charge',fee:73,currency:'eur',created:1791547200});await assert.rejects(retrieveProviderFee(wrong,evidence));
 const multiple=provider();multiple.invoicePayments.list=async()=>({has_more:true,data:[]});await assert.rejects(retrieveProviderFee(multiple,{...evidence,invoice_id:'in_test'}));
});
test('Checked zero is complete, pending/missing stays incomplete, recorded fees sum only ledger money',()=>{
 const income={id:'income',kind:'order_payment',direction:'inflow',gross_cents:1000};
 const zero=summarizeLedger([income],[],[{income_event_id:'income',capture_status:'checked',fee_cents:0}]);assert.equal(zero.providerFeeCents,0);assert.equal(zero.providerFeeCoverage.complete,true);
 for(const rows of [[],[{income_event_id:'income',capture_status:'pending'}],[{income_event_id:'income',capture_status:'unavailable_retryable'}]]){const summary=summarizeLedger([income],[],rows);assert.equal(summary.providerFeeCents,null);assert.equal(summary.providerFeeCoverage.complete,false);}
 const events=[income,{kind:'payment_fee',direction:'outflow',gross_cents:73}];const summary=summarizeLedger(events,[],[{income_event_id:'income',capture_status:'checked',fee_cents:73,fee_event_id:'fee'}]);assert.equal(summary.providerFeeCents,73);assert.equal(summary.incomeCents,1000);
 assert.equal(summarizeLedger([income],[],[{income_event_id:'income',capture_status:'not_applicable'}]).providerFeeCoverage.complete,true);
});
test('Protected legacy, refunds, Inventory and annual delivery workers are untouched; new writers are privileged',()=>{
 const sql=fs.readFileSync('supabase/migrations/079_provider_fee_evidence.sql','utf8');assert.doesNotMatch(sql,/create or replace function|alter table public\.financial_events|inventory_items|inventory_movements|create table.*ledger/i);
 assert.match(sql,/gross_cents|p_fee_cents/);assert.match(sql,/fee_cents=0 and fee_event_id is null/);assert.match(sql,/for update/);assert.match(sql,/fee:stripe:/);assert.match(sql,/provider_fee_transaction_key/);assert.match(sql,/from public,anon,authenticated/);
 const source=fs.readFileSync('lib/providerFeeCapture.ts','utf8');assert.doesNotMatch(source,/\.refunds\.|\.create\(|\.update\(|percentage|basis_points/);assert.match(source,/transaction\.fee/);
 const worker=fs.readFileSync('lib/annualPlanWebhookDeps.ts','utf8');assert.doesNotMatch(worker,/providerFeeCapture|record_provider_fee/);
 const route=fs.readFileSync('app/api/admin/finance/route.ts','utf8');assert.match(route,/read_sensitive/);assert.doesNotMatch(route,/payment_intent_id|balance_transaction_id|charge_id/);
});
