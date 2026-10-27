import test from 'node:test';
import assert from 'node:assert/strict';
import {financeSourceCoverage} from '../lib/financeSourceCoverage.ts';
import {financeRefundEvidence} from '../lib/financeRefundEvidence.ts';
import {summarizeLedger} from '../lib/adminPortalFinance.ts';

const period={from:'2026-10-01',to:'2026-11-01'};
const source=(extra={})=>({id:'order',source_kind:'order',payment_status:'paid',placed_at:'2026-10-02T10:00:00Z',total_gross_cents:1000,refunded_total_cents:0,refund_updated_at:null,...extra});
const payment={id:'payment',kind:'order_payment',order_id:'order',gross_cents:1000,occurred_on:'2026-10-02'};
const refund=(amount,date='2026-10-04')=>({id:'refund-'+date,kind:'refund',order_id:'order',gross_cents:amount,occurred_on:date});
const cover=(s,rows=[payment])=>financeSourceCoverage([s],rows,period);

test('known no-refund source has no expected refund or conflict',()=>{
 const r=cover(source());assert.equal(r.complete,true);assert.equal(r.missingRefunds,0);assert.equal(r.localDataWarnings,0);
});
test('NULL paid snapshot without refund signal is local uncertainty, not a Stripe discrepancy or assumed zero',()=>{
 const r=cover(source({refunded_total_cents:null}));assert.equal(r.conflicts,0);assert.equal(r.missingRefunds,0);assert.equal(r.noRefundIndication,1);assert.equal(r.localDataWarnings,1);assert.equal(r.complete,false);
});
test('partial refunds retain each historical date and compare cumulative evidence',()=>{
 const s=source({payment_status:'partially_refunded',refunded_total_cents:400,refund_updated_at:'2026-10-04T12:00:00Z'});
 assert.equal(cover(s,[payment,refund(100,'2026-10-03'),refund(300)]).complete,true);
 assert.equal(cover(s,[payment,refund(100,'2026-10-03')]).missingRefunds,1);
});
test('full refund must have exactly the cumulative ledger amount',()=>{
 const s=source({payment_status:'refunded',refunded_total_cents:1000,refund_updated_at:'2026-10-04T12:00:00Z'});
 assert.equal(cover(s,[payment,refund(1000)]).complete,true);assert.equal(cover(s).missingRefunds,1);
});
test('unknown refund state remains a data warning and cannot certify complete finance',()=>{
 const r=cover(source({payment_status:'refunded',refunded_total_cents:null}));assert.equal(r.unknownRefundStates,1);assert.equal(r.conflicts,0);assert.equal(r.complete,false);
});
test('actual verified Stripe refund stays missing when local paid/NULL snapshot has missed the webhook',()=>{
 const r=cover(source({refunded_total_cents:null,verified_refund_total_cents:1000,verified_refund_updated_at:'2026-10-04T12:00:00Z'}));assert.equal(r.missingRefunds,1);assert.equal(r.complete,false);
});
test('stale zero-provider evidence cannot erase a newer positive local refund',()=>{
 const r=cover(source({refunded_total_cents:1000,verified_refund_total_cents:0,refund_updated_at:'2026-10-04T12:00:00Z'}));assert.equal(r.missingRefunds,1);assert.equal(r.localDataWarnings,1);
});
test('historical annual payment and October refund are assigned to separate months',()=>{
 const s=source({id:'annual',source_kind:'annual',payment_status:'refunded',purchased_at:'2026-09-29T21:37:35Z',refunded_total_cents:1000,refund_updated_at:'2026-10-02T10:00:00Z'});
 const rows=[{id:'annual-payment',kind:'annual_prepayment',annual_plan_id:'annual',gross_cents:1000,occurred_on:'2026-09-29'}];
 const r=cover(s,rows);assert.equal(r.missingPayments,0);assert.equal(r.missingRefunds,1);
 assert.equal(cover(s,[...rows,{kind:'refund',annual_plan_id:'annual',gross_cents:1000,occurred_on:'2026-10-02'}]).complete,true);
});
test('duplicate or oversized actual ledger refunds remain monetary conflicts',()=>{
 const r=cover(source({refunded_total_cents:1000}),[payment,refund(1000),refund(1000,'2026-10-05')]);assert.equal(r.conflicts,1);
});
test('durable refund facts require LIVE EUR identity and valid complete cumulative counters',()=>{
 const row={account_id:'acct_verified',payload:{accountId:'acct_verified',live:true,currency:'EUR',localSubjectKind:'order',localSubjectId:'order',verifiedPaymentCents:1000,kind:'refund',occurredAt:'2026-10-04T12:00:00Z'},context:{verifiedRefundTotalCents:400,verifiedRefundCount:1}};
 const r=financeRefundEvidence([row,{...row,context:{verifiedRefundTotalCents:0,verifiedRefundCount:0}}]);assert.deepEqual(r.get('order:order'),{total:400,at:'2026-10-04T12:00:00Z'});
 for(const invalid of [{...row,payload:{...row.payload,live:false}},{...row,payload:{...row.payload,currency:'USD'}},{...row,account_id:'acct_wrong'},{...row,context:{verifiedRefundTotalCents:400}},{...row,context:{verifiedRefundTotalCents:1001,verifiedRefundCount:1}}])assert.equal(financeRefundEvidence([invalid]).size,0);
});
test('Dashboard summary labels snapshot uncertainty separately from local monetary contradictions',()=>{
 const coverage=cover(source({refunded_total_cents:null}));const s=summarizeLedger([],[],[],{subjects:[],coverage:[],months:[],generalCoverage:[],undatedEvents:0,undatedFulfilments:0,sourceCoverage:coverage});
 assert.match(s.costBlockers.join(' '),/Lokale Datenvollständigkeit/);assert.match(s.costBlockers.join(' '),/nicht die Zahl der Stripe-Abweichungen/);assert.equal(s.resultCents,null);assert.equal(s.providerFeeCents,null);
});
