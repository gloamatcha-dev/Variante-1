-- Disposable local PostgreSQL ONLY. All synthetic fixtures roll back by default.
begin;
create temporary table refund_tax_checks(name text primary key);
create function pg_temp.verify(n text,ok boolean) returns void language plpgsql as $$begin
 if ok is distinct from true then raise exception '081 check failed: %',n; end if;
 insert into refund_tax_checks values(n);
end$$;
create function pg_temp.make_order() returns uuid language plpgsql as $$declare x uuid:=gen_random_uuid();begin
 insert into checkout_attempts(id,request_id,expected_total_gross_cents,items_snapshot,status,stripe_payment_intent_id,paid_at)
 values(x,x,240,'[]','paid','pi_081_'||x,now());
 insert into orders(id,checkout_attempt_id,customer_type,status,payment_status,customer_snapshot,placed_at,total_gross_cents,total_net_cents,tax_total_cents,subtotal_gross_cents,subtotal_net_cents,discount_total_cents,discount_code,shipping_gross_cents,shipping_net_cents,shipping_tax_allocation,stripe_payment_intent_id)
 values(x,x,'private','confirmed','paid','{}',now(),240,211,29,221,193,2,'GLOALAUNCH10',21,18,
 '[{"taxRatePercent":7,"grossCents":10,"netCents":9,"taxCents":1},{"taxRatePercent":19,"grossCents":11,"netCents":9,"taxCents":2}]','pi_081_'||x);
 insert into order_items(order_id,product_reference,product_name,variant_name,quantity,unit_price_gross_cents,line_total_gross_cents,line_total_net_cents,line_total_tax_cents,tax_rate_percent,discount_gross_cents)
 values(x,'081-matcha','Matcha','30 g',3,34,102,93,7,7,2),(x,'081-case','Case','Case',1,119,119,100,19,19,0);
 return x;
end$$;
create function pg_temp.make_case(x uuid,q integer,shipping text,amount integer,loss integer default 0,product text default '081-matcha')
returns uuid language plpgsql as $$declare w uuid:=gen_random_uuid();begin
 insert into withdrawal_requests(id,customer_name,order_reference,contact_email,scope,scope_note,resolved_order_id,resolution_method,timeliness,
 resolved_order_item_id,resolved_item_quantity,item_resolution_by,item_resolution_at,partial_shipping_treatment,
 confirmed_value_loss_cents,value_loss_confirmed_by,value_loss_confirmed_at,value_loss_reason,goods_status,return_status,
 refund_amount_cents,refund_state,refund_operation_id,case_state)
 values(w,'081 Test','081','081@example.invalid','partial','Selected original goods',x,'admin_manual','timely',
 (select id from order_items where order_id=x and product_reference=product),q,
 (select user_id from admin_users where is_active and role in ('owner','admin') limit 1),now(),shipping,
 loss,(select user_id from admin_users where is_active and role in ('owner','admin') limit 1),now(),case when loss>0 then 'Assessed loss' end,
 'returned','returned',amount,'approved_for_payout',gen_random_uuid(),'refund_pending');return w;
end$$;
create temporary table refund_tax_ids(tag text primary key,id uuid);
insert into refund_tax_ids(tag,id) select t,pg_temp.make_order() from unnest(array['full','partial','item19','mixed','legacy','zero','null','loss','shipping','retained','ambiguous','operation','race'])t;
update orders o set customer_snapshot=pg_catalog.jsonb_build_object('test081',r.tag) from refund_tax_ids r where o.id=r.id;
create function pg_temp.rid(t text) returns uuid language sql as $$select id from refund_tax_ids where tag=t$$;
select pg_temp.verify('full mixed order',record_order_refund_event_v2(pg_temp.rid('full'),240,null,null,'full_remaining')->>'tax_status'='allocated');
select pg_temp.verify('full total exact',(select gross_cents=240 and net_cents=211 and tax_cents=29 from financial_events where order_id=pg_temp.rid('full') and kind='refund'));
select pg_temp.verify('full line 7 exact',(select gross_cents=100 and net_cents=93 and tax_cents=7 from refund_tax_allocation_evidence e join order_items i on i.id=e.order_item_id where e.order_id=pg_temp.rid('full') and i.product_reference='081-matcha'));
select pg_temp.verify('full line 19 exact',(select e.gross_cents=119 and e.net_cents=100 and e.tax_cents=19 from refund_tax_allocation_evidence e join order_items i on i.id=e.order_item_id where e.order_id=pg_temp.rid('full') and i.product_reference='081-case'));
select pg_temp.verify('full shipping exact',(select gross_cents=21 and net_cents=18 and tax_cents=3 from refund_tax_allocation_evidence where order_id=pg_temp.rid('full') and component='shipping'));
select pg_temp.verify('random operation replay',record_order_refund_event_v2(pg_temp.rid('full'),240,null,gen_random_uuid(),'full_remaining')->>'result'='no_change');
select pg_temp.verify('bounds',record_order_refund_event_v2(pg_temp.rid('full'),241,null,null,'full_remaining')->>'result'='refund_exceeds_subject');
do $$declare x uuid:=pg_temp.rid('partial');w uuid;op uuid;r jsonb;begin
 w:=pg_temp.make_case(x,1,'retain_outbound_shipping',34);select refund_operation_id into op from withdrawal_requests where id=w;
 r:=record_order_refund_event_v2(x,34,null,op,'withdrawal',w);perform pg_temp.verify('first quantity allocated',r->>'tax_status'='allocated');
 perform pg_temp.verify('first quantity exact',(r->>'net_cents')::integer=32 and (r->>'tax_cents')::integer=2);
 perform pg_temp.verify('same operation replay',record_order_refund_event_v2(x,34,null,op,'withdrawal',w)->>'result'='already_recorded');
 w:=pg_temp.make_case(x,1,'retain_outbound_shipping',33);select refund_operation_id into op from withdrawal_requests where id=w;
 r:=record_order_refund_event_v2(x,67,null,op,'withdrawal',w);perform pg_temp.verify('second quantity allocated',r->>'tax_status'='allocated');
 w:=pg_temp.make_case(x,1,'retain_outbound_shipping',33);select refund_operation_id into op from withdrawal_requests where id=w;
 r:=record_order_refund_event_v2(x,100,null,op,'withdrawal',w);perform pg_temp.verify('final quantity remainder',r->>'tax_status'='allocated' and (r->>'net_cents')::integer=30 and (r->>'tax_cents')::integer=3);
 perform pg_temp.verify('line conservation',(select sum(e.gross_cents)=100 and sum(e.net_cents)=93 and sum(e.tax_cents)=7 and sum(e.quantity)=3 from refund_tax_allocation_evidence e where order_id=x));
 perform pg_temp.verify('remaining whole after partial',record_order_refund_event_v2(x,240,null,null,'full_remaining')->>'tax_status'='allocated');
 perform pg_temp.verify('order conservation after partial',(select sum(gross_cents)=240 and sum(net_cents)=211 and sum(tax_cents)=29 from financial_events where order_id=x and kind='refund'));
end$$;
select pg_temp.verify('arbitrary mixed gross retained',record_order_refund_event_v2(pg_temp.rid('mixed'),15)->>'tax_status'='tax_allocation_required');
select pg_temp.verify('arbitrary mixed no blended tax',(select gross_cents=15 and net_cents is null and tax_cents is null from financial_events where order_id=pg_temp.rid('mixed')));
select record_order_refund_event(pg_temp.rid('legacy'),10);
select pg_temp.verify('prior legacy blocks',record_order_refund_event_v2(pg_temp.rid('legacy'),240,null,null,'full_remaining')->>'tax_reason'='prior_tax_allocation_unknown');
update orders set tax_total_cents=0,total_net_cents=240,subtotal_net_cents=219,shipping_net_cents=21 where id=pg_temp.rid('zero');
update order_items set line_total_net_cents=line_total_gross_cents-discount_gross_cents,line_total_tax_cents=0 where order_id=pg_temp.rid('zero');
select pg_temp.verify('known zero',record_order_refund_event_v2(pg_temp.rid('zero'),240,null,null,'full_remaining')->>'tax_cents'='0');
update orders set total_net_cents=null,tax_total_cents=null where id=pg_temp.rid('null');
select pg_temp.verify('unknown remains unknown',record_order_refund_event_v2(pg_temp.rid('null'),240,null,null,'full_remaining')->>'tax_status'='tax_allocation_required');
do $$declare x uuid;w uuid;op uuid;r jsonb;begin
 x:=pg_temp.rid('item19');w:=pg_temp.make_case(x,1,'retain_outbound_shipping',119,0,'081-case');select refund_operation_id into op from withdrawal_requests where id=w;
 r:=record_order_refund_event_v2(x,119,null,op,'withdrawal',w);
 perform pg_temp.verify('exact selected 19 percent item',r->>'tax_status'='allocated' and r->>'net_cents'='100' and r->>'tax_cents'='19');
 x:=pg_temp.rid('loss');w:=pg_temp.make_case(x,1,'retain_outbound_shipping',20,14);select refund_operation_id into op from withdrawal_requests where id=w;
 r:=record_order_refund_event_v2(x,20,null,op,'withdrawal',w);
 perform pg_temp.verify('Wertersatz gross survives',r->>'result'='recorded' and r->>'tax_reason'='wertersatz_tax_allocation_required' and r->>'net_cents' is null and r->>'tax_cents' is null);
 x:=pg_temp.rid('shipping');w:=pg_temp.make_case(x,3,'refund_outbound_shipping',121);select refund_operation_id into op from withdrawal_requests where id=w;
 perform pg_temp.verify('partial explicit shipping',record_order_refund_event_v2(x,121,null,op,'withdrawal',w)->>'tax_status'='allocated');
 x:=pg_temp.rid('retained');w:=pg_temp.make_case(x,3,'retain_outbound_shipping',100);select refund_operation_id into op from withdrawal_requests where id=w;
 perform pg_temp.verify('retained shipping',record_order_refund_event_v2(x,100,null,op,'withdrawal',w)->>'tax_status'='allocated');
 perform pg_temp.verify('no shipping evidence when retained',not exists(select 1 from refund_tax_allocation_evidence where order_id=x and component='shipping'));
 x:=pg_temp.rid('ambiguous');w:=pg_temp.make_case(x,1,null,34);select refund_operation_id into op from withdrawal_requests where id=w;
 perform pg_temp.verify('ambiguous shipping',record_order_refund_event_v2(x,34,null,op,'withdrawal',w)->>'tax_reason'='partial_scope_unresolved');
end$$;
select pg_temp.verify('browser cannot write evidence',not has_table_privilege('authenticated','refund_tax_allocation_evidence','INSERT,UPDATE,DELETE'));
select pg_temp.verify('service cannot edit evidence directly',not has_table_privilege('service_role','refund_tax_allocation_evidence','INSERT,UPDATE,DELETE'));
select pg_temp.verify('browser cannot invoke writer',not has_function_privilege('authenticated','record_order_refund_event_v2(uuid,integer,text,uuid,text,uuid)','EXECUTE'));
select pg_temp.verify('helper internal only',not has_function_privilege('service_role','refund_tax_record_v1(uuid,uuid,integer,text,uuid,text,uuid)','EXECUTE'));
create function pg_temp.make_annual() returns uuid language plpgsql as $$declare x uuid:=gen_random_uuid();begin
 insert into auth.users(id,email) values(x,'annual081-'||x||'@example.invalid');
 insert into checkout_attempts(id,request_id,user_id,expected_total_gross_cents,items_snapshot,status,stripe_payment_intent_id,paid_at)
 values(x,x,x,23268,'[]','paid','pi_081_annual_'||x,now());
 insert into annual_plans(id,user_id,payment_checkout_attempt_id,variant_id,status,payment_status,catalog_unit_gross_cents,annual_unit_gross_cents,shipping_per_delivery_gross_cents,delivery_count,merchandise_total_gross_cents,shipping_total_gross_cents,total_gross_cents,discount_percent_applied,customer_snapshot,shipping_address_snapshot,billing_address_snapshot,tax_snapshot,delivery_items_snapshot,delivery_tax_snapshot,schedule_model,stripe_payment_intent_id,purchased_at,plan_end_at,schedule_anchor_date)
 values(x,x,x,(select id from product_variants where sku='GLOA-MATCHA-30G'),'active','paid',1499,1349,590,12,16188,7080,23268,10,'{}','{}','{}',
 '{"totals":{"totalGrossCents":23268,"totalNetCents":21746,"taxTotalCents":1522,"subtotalGrossCents":16188,"subtotalNetCents":15129,"subtotalTaxCents":1059,"shippingGrossCents":7080,"shippingNetCents":6617,"shippingTaxCents":463}}',
 '[{"unitGrossCents":1349,"quantity":1,"lineGrossCents":1349}]',
 '{"totals":{"shippingGrossCents":590,"totalGrossCents":1939,"taxTotalCents":127}}',
 'v2_monthly_12','pi_081_annual_'||x,now(),now()+interval '1 year',(now() at time zone 'Europe/Berlin')::date);return x;
end$$;
do $$declare x uuid; r jsonb;begin
 x:=pg_temp.make_annual();perform record_annual_prepayment_event_v2(x);
 r:=record_annual_plan_refund_event_v2(x,23268,null,null,'full_remaining');
 perform pg_temp.verify('Annual original total exact',r->>'tax_status'='allocated' and (r->>'net_cents')::integer=21746 and (r->>'tax_cents')::integer=1522);
 perform pg_temp.verify('Annual not delivery rounding',(r->>'tax_cents')::integer<>12*127);
 perform pg_temp.verify('Annual original income remains',(select count(*)=1 from financial_events where annual_plan_id=x and kind='annual_prepayment'));
 perform pg_temp.verify('Annual replay',record_annual_plan_refund_event_v2(x,23268,null,null,'full_remaining')->>'result'='no_change');
 x:=pg_temp.make_annual();r:=record_annual_plan_refund_event_v2(x,1349,null,null,'full_remaining');
 perform pg_temp.verify('Annual partial unknown',r->>'tax_reason'='unsupported_partial_allocation' and r->>'net_cents' is null and r->>'tax_cents' is null);
 x:=pg_temp.make_annual();perform record_annual_plan_refund_event(x,5000);
 perform pg_temp.verify('Annual legacy prior unknown',record_annual_plan_refund_event_v2(x,23268,null,null,'full_remaining')->>'tax_reason'='prior_tax_allocation_unknown');
end$$;
do $$begin
 begin update refund_tax_allocation_evidence set gross_cents=gross_cents;raise exception 'mutation accepted';exception when insufficient_privilege then null;end;
end$$;
select '081 refund tax matrix PASS: '||count(*) from refund_tax_checks;
rollback;
