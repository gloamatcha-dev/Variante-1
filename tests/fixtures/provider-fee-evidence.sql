begin;
create temporary table fee_ids(tag text primary key,id uuid default gen_random_uuid());
insert into fee_ids(tag) values('order'),('zero'),('other'),('annual'),('user');
create function pg_temp.rid(t text) returns uuid language sql as $$select id from fee_ids where tag=t$$;
create function pg_temp.check_fee(ok boolean) returns void language plpgsql as $$declare n integer:=coalesce(nullif(pg_catalog.current_setting('fee.check_count',true),''),'0')::integer+1; begin perform pg_catalog.set_config('fee.check_count',n::text,true); if ok is distinct from true then raise exception 'fee matrix check % failed',n; end if; end$$;
insert into auth.users(id,email) values(pg_temp.rid('user'),'079@example.invalid');
insert into checkout_attempts(id,request_id,user_id,expected_total_gross_cents,items_snapshot,status,stripe_payment_intent_id,paid_at)
select id,id,pg_temp.rid('user'),23268,'[]','paid','pi_079_'||tag,now() from fee_ids where tag in ('order','zero','other','annual');
insert into orders(id,checkout_attempt_id,customer_type,status,payment_status,customer_snapshot,total_gross_cents,stripe_payment_intent_id,placed_at)
select id,id,'private','confirmed','paid','{}',23268,'pi_079_'||tag,now() from fee_ids where tag in ('order','zero','other');
insert into annual_plans(id,user_id,payment_checkout_attempt_id,variant_id,status,payment_status,catalog_unit_gross_cents,annual_unit_gross_cents,shipping_per_delivery_gross_cents,delivery_count,merchandise_total_gross_cents,shipping_total_gross_cents,total_gross_cents,discount_percent_applied,customer_snapshot,shipping_address_snapshot,billing_address_snapshot,tax_snapshot,delivery_items_snapshot,delivery_tax_snapshot,schedule_model,stripe_payment_intent_id,purchased_at,plan_end_at,schedule_anchor_date)
values(pg_temp.rid('annual'),pg_temp.rid('user'),pg_temp.rid('annual'),(select id from product_variants where sku='GLOA-MATCHA-30G'),'active','paid',1499,1349,590,12,16188,7080,23268,10,'{}','{}','{}','{"totals":{"totalGrossCents":23268}}','[{"unitGrossCents":1349,"quantity":1,"lineGrossCents":1349}]','{"totals":{"shippingGrossCents":590,"totalGrossCents":1939}}','v2_monthly_12','pi_079_annual',now(),now()+interval '1 year',(now() at time zone 'Europe/Berlin')::date);
select public.record_order_payment_event(id) from fee_ids where tag in ('order','zero','other');
select public.record_annual_prepayment_event(pg_temp.rid('annual'));
select public.initialize_provider_fee_evidence_v1(id) from financial_events where order_id in(select id from fee_ids) or annual_plan_id=pg_temp.rid('annual');
create function pg_temp.eid(t text) returns uuid language sql as $$select id from provider_fee_evidence where order_id=pg_temp.rid(t) or annual_plan_id=pg_temp.rid(t)$$;
select pg_temp.check_fee((select capture_status='pending' and fee_cents is null from provider_fee_evidence where id=pg_temp.eid('zero')));
select public.record_provider_fee_result_v1(pg_temp.eid('zero'),'checked','pi_079_zero','ch_079_zero','txn_079_zero',0,'EUR','2026-10-09T12:00:00Z');
select pg_temp.check_fee((select capture_status='checked' and fee_cents=0 and fee_event_id is null from provider_fee_evidence where id=pg_temp.eid('zero')));
select public.record_provider_fee_result_v1(pg_temp.eid('order'),'unavailable_retryable',p_error_code=>'provider_unavailable');
select pg_temp.check_fee((select fee_cents is null and capture_status='unavailable_retryable' from provider_fee_evidence where id=pg_temp.eid('order')));
select public.record_provider_fee_result_v1(pg_temp.eid('order'),'checked','pi_079_order','ch_079_order','txn_079_order',73,'EUR','2026-10-09T12:00:00Z');
select pg_temp.check_fee(public.record_provider_fee_result_v1(pg_temp.eid('order'),'checked','pi_079_order','ch_079_order','txn_079_order',73,'EUR','2026-10-09T12:00:00Z')->>'result'='already_recorded');
select public.record_provider_fee_result_v1(pg_temp.eid('annual'),'checked','pi_079_annual','ch_079_annual','txn_079_annual',91,'EUR','2026-10-09T12:00:00Z');
select pg_temp.check_fee((select count(*)=1 from financial_events where kind='payment_fee' and annual_plan_id=pg_temp.rid('annual') and order_id is null));
do $$begin
 begin perform public.record_provider_fee_result_v1(pg_temp.eid('other'),'checked','pi_079_other','ch_079_other','txn_079_order',73,'EUR','2026-10-09T12:00:00Z'); raise exception 'expected conflict'; exception when others then if sqlerrm='expected conflict' then raise; end if; end;
 begin perform public.record_provider_fee_result_v1(pg_temp.eid('other'),'checked','pi_079_other','ch_079_other','txn_079_other',73,'USD','2026-10-09T12:00:00Z'); raise exception 'expected mismatch'; exception when others then if sqlerrm='expected mismatch' then raise; end if; end;
 begin perform public.record_provider_fee_result_v1(pg_temp.eid('other'),'checked','pi_079_other','ch_079_other',null,73,'EUR','2026-10-09T12:00:00Z'); raise exception 'expected missing reference'; exception when others then if sqlerrm='expected missing reference' then raise; end if; end;
 begin perform public.record_provider_fee_result_v1(pg_temp.eid('other'),'not_applicable'); raise exception 'expected unproven'; exception when others then if sqlerrm='expected unproven' then raise; end if; end;
end$$;
select pg_temp.check_fee((select count(*)=2 from financial_events where kind='payment_fee' and (order_id in(select id from fee_ids) or annual_plan_id=pg_temp.rid('annual'))));
select pg_temp.check_fee(not pg_catalog.has_table_privilege('authenticated','public.provider_fee_evidence','SELECT,INSERT,UPDATE,DELETE'));
select pg_temp.check_fee(not pg_catalog.has_function_privilege('anon','public.record_provider_fee_result_v1(uuid,text,text,text,text,integer,text,timestamptz,text)','EXECUTE'));
select 'matrix passed';
rollback;
