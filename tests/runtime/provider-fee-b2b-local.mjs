/** Exact existing synthetic B2B settlements only, disposable PostgreSQL. */
import assert from 'node:assert/strict';import fs from 'node:fs';import {randomUUID} from 'node:crypto';import {sql,snapshot} from '../helpers/affiliateAtomicDatabase.mjs';
const db=process.env.GLOA_ATOMIC_LOCAL_DATABASE;assert.match(db??'',/^gloa_073_[a-f0-9]+$/);
const before=snapshot(db);const quote=s=>"'"+String(s).replaceAll("'","''")+"'";
const schedules=JSON.parse(sql("select coalesce(jsonb_agg(to_jsonb(s)),'[]') from (select * from b2b_payment_schedule where status='paid' order by id limit 2)s",db));assert.ok(schedules.length);
const results=[];
for(const schedule of schedules){
 const income=JSON.parse(sql(`select public.record_b2b_settlement_event('${schedule.id}')`,db)).event_id;assert.ok(income);
 const initialized=JSON.parse(sql(`select public.initialize_provider_fee_evidence_v1('${income}')`,db));
 const evidence=JSON.parse(sql(`select to_jsonb(e) from provider_fee_evidence e where id='${initialized.evidence_id}'`,db));assert.equal(evidence.b2b_schedule_id,schedule.id);assert.equal(evidence.order_id,null);
 if(evidence.capture_status==='checked')continue;
 const suffix=randomUUID().replaceAll('-',''),intent=evidence.payment_intent_id??'pi_079_'+suffix;
 const fee=JSON.parse(sql(`select public.record_provider_fee_result_v1('${evidence.id}','checked',${quote(intent)},'ch_079_${suffix}','txn_079_${suffix}',87,${quote(evidence.currency)},'2026-10-09T12:00:00Z')`,db));
 const event=JSON.parse(sql(`select to_jsonb(f) from financial_events f where id='${fee.fee_event_id}'`,db));assert.equal(event.b2b_agreement_id,schedule.supply_agreement_id);assert.equal(event.order_id,null);assert.equal(event.gross_cents,87);results.push('annual instalment');
}
const delivery=JSON.parse(sql("select to_jsonb(d) from b2b_deliveries d join b2b_supply_agreements a on a.id=d.supply_agreement_id where a.plan_type='monthly' and d.stripe_invoice_id is not null order by d.created_at desc limit 1",db));assert.ok(delivery);
const income=JSON.parse(sql(`select public.record_b2b_monthly_invoice_event('${delivery.supply_agreement_id}',${quote(delivery.stripe_invoice_id)})`,db)).event_id;
const init=JSON.parse(sql(`select public.initialize_provider_fee_evidence_v1('${income}')`,db));const monthly=JSON.parse(sql(`select to_jsonb(e) from provider_fee_evidence e where id='${init.evidence_id}'`,db));assert.equal(monthly.b2b_delivery_id,delivery.id);assert.equal(monthly.b2b_schedule_id,null);
if(monthly.capture_status!=='checked'&&monthly.capture_status!=='not_applicable'){
 const suffix=randomUUID().replaceAll('-','');const result=JSON.parse(sql(`select public.record_provider_fee_result_v1('${monthly.id}','checked','pi_079_${suffix}','ch_079_${suffix}','txn_079_${suffix}',49,'EUR','2026-10-09T12:00:00Z')`,db));assert.equal(result.result,'recorded');
 assert.equal(sql(`select count(*) from financial_events where operation_id='${monthly.id}' and b2b_agreement_id='${delivery.supply_agreement_id}'`,db),'1');results.push('monthly Stripe-backed payment');
}
const other=JSON.parse(sql(`select to_jsonb(d) from b2b_deliveries d join b2b_supply_agreements a on a.id=d.supply_agreement_id where a.plan_type='monthly' and d.stripe_invoice_id is not null and d.id<>'${delivery.id}' and not exists(select 1 from provider_fee_evidence f where f.b2b_delivery_id=d.id and f.capture_status in ('checked','not_applicable')) order by d.created_at desc limit 1`,db));assert.ok(other);
const otherIncome=JSON.parse(sql(`select public.record_b2b_monthly_invoice_event('${other.supply_agreement_id}',${quote(other.stripe_invoice_id)})`,db)).event_id;
const otherEvidence=JSON.parse(sql(`select public.initialize_provider_fee_evidence_v1('${otherIncome}')`,db)).evidence_id;
assert.equal(JSON.parse(sql(`select public.record_provider_fee_result_v1('${otherEvidence}','not_applicable',p_error_code=>'invoice_paid_out_of_band')`,db)).result,'recorded');
assert.equal(sql(`select count(*) from financial_events where operation_id='${otherEvidence}'`,db),'0');results.push('monthly proven out-of-band');
const after=snapshot(db);assert.equal(after.inventory_items,before.inventory_items);assert.equal(after.inventory_movements,before.inventory_movements);
fs.writeFileSync('outputs/provider-fee-079-b2b.json',JSON.stringify({database:db,results,monthlyPaymentSubject:delivery.id},null,2));console.log('079 B2B paid schedule and invoice/delivery subjects, no fake orders/schedules, non-Stripe evidence and Inventory PASS');
