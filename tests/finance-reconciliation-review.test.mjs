import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeLedger,portalPeriod} from '../lib/adminPortalFinance.ts';
const e=(id,kind,direction,gross)=>({id,kind,direction,gross_cents:gross,channel:'b2c',tax_cents:null});
const oct=[e('annual','annual_prepayment','inflow',23268),...['a','b','c'].map(id=>e(id,'order_payment','inflow',2089)),e('ra','refund','outflow',23268),...['a','b','c'].map(id=>e('r'+id,'refund','outflow',2089))];
const basis={subjects:[],coverage:[],months:['2026-10-01'],generalCoverage:[],undatedEvents:0,undatedFulfilments:0,sourceCoverage:{status:'checked',complete:true,missingPayments:0,missingRefunds:0,conflicts:0}};
test('stored October ledger totals do not certify complete economic reconciliation',()=>{
 const s=summarizeLedger(oct,[],[],basis);assert.equal(s.incomeCents,29535);assert.equal(s.refundCents,29535);
 assert.equal(s.providerFeeCents,null);assert.equal(s.providerFeeCoverage.missing,4);assert.equal(s.contributionMarginCents,null);assert.equal(s.resultCents,null);assert.equal(s.resultComplete,false);
});
test('unknown direct and general costs are not returned as zero for an uncosted fulfillment',()=>{
 const s=summarizeLedger(oct,[],[],{...basis,subjects:[{id:'synthetic_shipped',kind:'order'}]});
 assert.equal(s.directCostCents,null);assert.equal(s.generalCostCents,null);assert.equal(s.contributionComplete,false);
});
test('September payment and October refund remain separate period events',()=>{
 const sep=portalPeriod({period:'custom',from:'2026-09-01',to:'2026-09-30'});const october=portalPeriod({period:'custom',from:'2026-10-01',to:'2026-10-31'});
 assert.deepEqual(sep,{from:'2026-09-01',to:'2026-10-01'});assert.deepEqual(october,{from:'2026-10-01',to:'2026-11-01'});
 const paid={...e('legacy','annual_prepayment','inflow',25207),occurred_on:'2026-09-29'};
 const refunded={...e('legacy_refund','refund','outflow',25207),occurred_on:'2026-10-02'};
 const select=p=>[paid,refunded].filter(x=>x.occurred_on>=p.from&&x.occurred_on<p.to);
 assert.equal(summarizeLedger(select(sep),[],[],basis).incomeCents,25207);assert.equal(summarizeLedger(select(sep),[],[],basis).refundCents,0);
 assert.equal(summarizeLedger(select(october),[],[],basis).incomeCents,0);assert.equal(summarizeLedger(select(october),[],[],basis).refundCents,25207);
});
test('synthetic confirmed inputs reconcile contribution and operating result without fee duplication',()=>{
 const events=[e('income','order_payment','inflow',10000),e('refund','refund','outflow',1000),e('fee','payment_fee','outflow',10)];
 const expenses=[{category:'packaging',gross_cents:100,vat_cents:0,channel:'b2c'},{category:'general',gross_cents:1000,vat_cents:0,channel:'b2c'}];
 const evidence=[{income_event_id:'income',capture_status:'checked',fee_cents:10,fee_event_id:'fee'}];
 const complete={...basis,subjects:[{id:'o',kind:'order'}],coverage:['matcha_cogs','packaging','shipping'].map(cost_class=>({order_id:'o',cost_class,coverage_status:cost_class==='packaging'?'captured':'confirmed_zero'})),generalCoverage:[{period_start:'2026-10-01',coverage_status:'confirmed_complete'}]};
 const s=summarizeLedger(events,expenses,evidence,complete);assert.equal(s.providerFeeCents,10);assert.equal(s.contributionMarginCents,8890);assert.equal(s.resultCents,7890);assert.equal(s.resultComplete,true);
});
test('missing fee event invalidates completeness even when a positive provider fee is known',()=>{
 const s=summarizeLedger([e('income','order_payment','inflow',1000)],[],[{income_event_id:'income',capture_status:'checked',fee_cents:25,fee_event_id:'missing'}],basis);
 assert.equal(s.contributionComplete,false);assert.equal(s.resultCents,null);assert.ok(s.costBlockers.includes('Providergebühren-Ereignisse nicht vollständig zugeordnet'));
});
