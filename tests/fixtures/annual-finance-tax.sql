begin;
create temporary table tax_ids(tag text primary key,id uuid default gen_random_uuid());
insert into tax_ids(tag) values('user'),('valid'),('zero'),('missing'),('malformed'),('sum'),('currency'),('legacy'),('conflict'),('race'),('decimal'),('overflow');
create function pg_temp.tid(t text) returns uuid language sql as $$select id from tax_ids where tag=t$$;
create function pg_temp.verify_tax(ok boolean) returns void language plpgsql as $$begin if ok is distinct from true then raise exception '080 tax matrix failure'; end if; end$$;
insert into auth.users(id,email) select id,'tax080-'||tag||'@example.invalid' from tax_ids;
insert into checkout_attempts(id,request_id,user_id,expected_total_gross_cents,items_snapshot,status,stripe_payment_intent_id,paid_at)
select id,id,id,23268,'[]','paid','pi_080_'||tag,now() from tax_ids where tag<>'user';
insert into annual_plans(id,user_id,payment_checkout_attempt_id,variant_id,status,payment_status,catalog_unit_gross_cents,annual_unit_gross_cents,shipping_per_delivery_gross_cents,delivery_count,merchandise_total_gross_cents,shipping_total_gross_cents,total_gross_cents,discount_percent_applied,customer_snapshot,shipping_address_snapshot,billing_address_snapshot,tax_snapshot,delivery_items_snapshot,delivery_tax_snapshot,schedule_model,stripe_payment_intent_id,purchased_at,plan_end_at,schedule_anchor_date)
select id,id,id,(select id from product_variants where sku='GLOA-MATCHA-30G'),'active','paid',1499,1349,590,12,16188,7080,23268,10,'{}','{}','{}',
 '{"totals":{"totalGrossCents":23268,"totalNetCents":21746,"taxTotalCents":1522,"subtotalGrossCents":16188,"subtotalNetCents":15129,"subtotalTaxCents":1059,"shippingGrossCents":7080,"shippingNetCents":6617,"shippingTaxCents":463}}',
 '[{"unitGrossCents":1349,"quantity":1,"lineGrossCents":1349}]',
 '{"totals":{"shippingGrossCents":590,"totalGrossCents":1939,"taxTotalCents":127}}',
 'v2_monthly_12','pi_080_'||tag,now(),now()+interval '1 year',(now() at time zone 'Europe/Berlin')::date from tax_ids where tag<>'user';
select pg_temp.verify_tax(public.record_annual_prepayment_event_v2(pg_temp.tid('valid'))->>'result'='recorded');
select pg_temp.verify_tax((select gross_cents=23268 and net_cents=21746 and tax_cents=1522 and currency='EUR' and channel='b2c' and direction='inflow' from financial_events where annual_plan_id=pg_temp.tid('valid')));
select pg_temp.verify_tax(1522<>12*127);
select pg_temp.verify_tax(public.record_annual_prepayment_event_v2(pg_temp.tid('valid'),gen_random_uuid())->>'result'='already_recorded');
select pg_temp.verify_tax((select count(*)=1 from financial_events where annual_plan_id=pg_temp.tid('valid')));
update annual_plans set tax_snapshot=jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(tax_snapshot,'{totals,totalNetCents}','23268'),'{totals,taxTotalCents}','0'),'{totals,subtotalNetCents}','16188'),'{totals,subtotalTaxCents}','0'),'{totals,shippingNetCents}','7080'),'{totals,shippingTaxCents}','0') where id=pg_temp.tid('zero');
select pg_temp.verify_tax(public.record_annual_prepayment_event_v2(pg_temp.tid('zero'))->>'result'='recorded');
select pg_temp.verify_tax((select net_cents=23268 and tax_cents=0 from financial_events where annual_plan_id=pg_temp.tid('zero')));
update annual_plans set tax_snapshot=tax_snapshot #- '{totals,taxTotalCents}' where id=pg_temp.tid('missing');
update annual_plans set tax_snapshot=jsonb_set(tax_snapshot,'{totals,taxTotalCents}','"1522"') where id=pg_temp.tid('malformed');
update annual_plans set tax_snapshot=jsonb_set(tax_snapshot,'{totals,taxTotalCents}','1521') where id=pg_temp.tid('sum');
update annual_plans set tax_snapshot=tax_snapshot||'{"currency":"USD"}' where id=pg_temp.tid('currency');
update annual_plans set tax_snapshot=jsonb_set(tax_snapshot,'{totals,taxTotalCents}','1522.5') where id=pg_temp.tid('decimal');
update annual_plans set tax_snapshot=jsonb_set(tax_snapshot,'{totals,taxTotalCents}','99999999999999999999') where id=pg_temp.tid('overflow');
select pg_temp.verify_tax(public.record_annual_prepayment_event_v2(id)->>'result'='invalid_tax_snapshot') from tax_ids where tag in ('missing','malformed','sum','decimal','overflow');
select pg_temp.verify_tax(public.record_annual_prepayment_event_v2(pg_temp.tid('currency'))->>'result'='currency_mismatch');
select pg_temp.verify_tax((select count(*)=0 from financial_events where annual_plan_id in(select id from tax_ids where tag in ('missing','malformed','sum','currency','decimal','overflow'))));
select pg_temp.verify_tax(public.record_annual_prepayment_event(pg_temp.tid('legacy'))->>'result'='recorded');
select pg_temp.verify_tax(public.record_annual_prepayment_event_v2(pg_temp.tid('legacy'))->>'result'='already_recorded');
select pg_temp.verify_tax((select net_cents is null and tax_cents is null from financial_events where annual_plan_id=pg_temp.tid('legacy')));
select pg_temp.verify_tax(public.record_annual_prepayment_event_v2(pg_temp.tid('conflict'),(select operation_id from financial_events where annual_plan_id=pg_temp.tid('valid')))->>'result'='operation_conflict');
select pg_temp.verify_tax(not has_function_privilege('anon','public.record_annual_prepayment_event_v2(uuid,uuid)','EXECUTE'));
select pg_temp.verify_tax(not has_function_privilege('authenticated','public.record_annual_prepayment_event_v2(uuid,uuid)','EXECUTE'));
select pg_temp.verify_tax(has_function_privilege('service_role','public.record_annual_prepayment_event_v2(uuid,uuid)','EXECUTE'));
select '080 Annual tax matrix passed';
rollback;
