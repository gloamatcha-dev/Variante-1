-- Disposable PostgreSQL only. No provider, email or Production credentials.
begin;
create temporary table review_checks(name text primary key);
create function pg_temp.verify(name text,ok boolean) returns void language plpgsql as $$begin
 if ok is distinct from true then raise exception 'FAILED: %',name; end if;
 insert into review_checks values(name);
end$$;
create temporary table review_ids(tag text primary key,id uuid default gen_random_uuid());
insert into review_ids(tag) values('annual'),('once'),('sub'),('w_annual'),('w_once'),('w_sub'),('w_other');
create function pg_temp.rid(tag text) returns uuid language sql as $$select id from review_ids where review_ids.tag=$1$$;
insert into auth.users(id,email) values(pg_temp.rid('sub'),'077-sub@example.invalid');
insert into subscriptions(id,user_id,status,customer_snapshot,shipping_address_snapshot,billing_address_snapshot,plan_snapshot,stripe_subscription_id)
values(pg_temp.rid('sub'),pg_temp.rid('sub'),'active','{}','{}','{}','{"interval_days":28}','sub_077');
insert into stripe_customers(user_id,stripe_customer_id) values(pg_temp.rid('sub'),'cus_077');
insert into checkout_attempts(id,request_id,user_id,expected_total_gross_cents,items_snapshot,status,stripe_payment_intent_id,stripe_invoice_id,stripe_customer_id,subscription_id,paid_at)
select id,id,case when tag='sub' then id end,23268,'[]','paid','pi_077_'||tag,case when tag='sub' then 'in_077' end,case when tag='sub' then 'cus_077' end,case when tag='sub' then id end,now() from review_ids where tag in ('annual','once','sub');
insert into orders(id,user_id,checkout_attempt_id,customer_type,status,payment_status,customer_snapshot,placed_at,total_gross_cents,subtotal_gross_cents,shipping_gross_cents,stripe_payment_intent_id)
select id,case when tag='sub' then id end,id,'private','confirmed','paid','{}',now(),23268,16188,7080,'pi_077_'||tag from review_ids where tag in ('once','sub');
insert into annual_plans(id,user_id,payment_checkout_attempt_id,variant_id,status,payment_status,catalog_unit_gross_cents,annual_unit_gross_cents,shipping_per_delivery_gross_cents,delivery_count,merchandise_total_gross_cents,shipping_total_gross_cents,total_gross_cents,discount_percent_applied,customer_snapshot,shipping_address_snapshot,billing_address_snapshot,tax_snapshot,delivery_items_snapshot,delivery_tax_snapshot,schedule_model,stripe_payment_intent_id,purchased_at,plan_end_at,schedule_anchor_date)
values(pg_temp.rid('annual'),pg_temp.rid('sub'),pg_temp.rid('annual'),(select id from product_variants where sku='GLOA-MATCHA-30G'),'active','paid',1499,1349,590,12,16188,7080,23268,10,'{}','{}','{}','{"totals":{"totalGrossCents":23268}}','[{"unitGrossCents":1349,"quantity":1,"lineGrossCents":1349}]','{"totals":{"shippingGrossCents":590,"totalGrossCents":1939}}','v2_monthly_12','pi_077_annual',now(),now()+interval '1 year',(now() at time zone 'Europe/Berlin')::date);
insert into annual_plan_deliveries(annual_plan_id,delivery_number,scheduled_for)
select pg_temp.rid('annual'),n,now()+make_interval(months=>n-1) from generate_series(1,12)n;
insert into withdrawal_requests(id,customer_name,order_reference,contact_email,scope,resolved_order_id,resolved_annual_plan_id,timeliness)
select id,'077 Test',tag,'077-sub@example.invalid','whole_order',case tag when 'w_once' then pg_temp.rid('once') when 'w_other' then pg_temp.rid('once') when 'w_sub' then pg_temp.rid('sub') end,case when tag='w_annual' then pg_temp.rid('annual') end,'timely' from review_ids where tag like 'w_%';
create temporary table review_inventory_before as select * from inventory_items;
create temporary table review_movements_before as select * from inventory_movements;
select pg_temp.verify('A Annual full suggestion',(withdrawal_refund_review_basis_v1(pg_temp.rid('w_annual'))->>'suggested_refund_cents')::integer=23268);
select pg_temp.verify('Submission does not approve',(select refund_state='not_started' from withdrawal_requests where id=pg_temp.rid('w_annual')));
with a as(insert into checkout_attempts(request_id,expected_total_gross_cents,items_snapshot,status,annual_plan_id,annual_delivery_number)
 values(gen_random_uuid(),1939,'[]','paid',pg_temp.rid('annual'),1) returning id),
 o as(insert into orders(checkout_attempt_id,customer_type,status,payment_status,customer_snapshot,placed_at,total_gross_cents,shipped_at,fulfillment_status)
 select id,'private','shipped','paid','{}',now(),1939,now(),'shipped' from a returning id)
update annual_plan_deliveries set state='fulfilled',claimed_at=now(),fulfilled_at=now(),order_id=o.id from o where annual_plan_id=pg_temp.rid('annual') and delivery_number=1;
select pg_temp.verify('B Actual shipment not inferred delivery',withdrawal_refund_review_basis_v1(pg_temp.rid('w_annual'))->'deliveries'->>'shipped'='1' and withdrawal_refund_review_basis_v1(pg_temp.rid('w_annual'))->'deliveries'->>'delivered'='0');
select pg_temp.verify('Review dispatched pending',admin_review_withdrawal_v1('00000000-0000-4000-8000-000000000001',pg_temp.rid('w_annual'),'dispatched_not_received','pending','TRACK',0,null,'Review') ->>'result'='reviewed');
select pg_temp.verify('B Pending return blocks approval',admin_approve_withdrawal_refund_v1('00000000-0000-4000-8000-000000000001',pg_temp.rid('w_annual'),23268)->>'result'='return_outstanding');
select pg_temp.verify('Goods label is not return proof',(select return_received_at is null from withdrawal_requests where id=pg_temp.rid('w_annual')));
savepoint unopened_return;
select admin_review_withdrawal_v1('00000000-0000-4000-8000-000000000001',pg_temp.rid('w_annual'),'received_unopened','returned','RETURN-077',0,null,null);
select admin_record_withdrawal_return_v1('00000000-0000-4000-8000-000000000001',pg_temp.rid('w_annual'),'received',now());
select pg_temp.verify('C Returned unopened approval proof',admin_approve_withdrawal_refund_v1('00000000-0000-4000-8000-000000000001',pg_temp.rid('w_annual'),23268)->>'result'='approved');
rollback to savepoint unopened_return;
select pg_temp.verify('C Returned unopened full approval',true);
savepoint late_return;
select admin_review_withdrawal_v1('00000000-0000-4000-8000-000000000001',pg_temp.rid('w_annual'),'received_unopened','requested',null,0,null,null);
select admin_record_withdrawal_return_v1('00000000-0000-4000-8000-000000000001',pg_temp.rid('w_annual'),'dispatch_proof',now());
select admin_approve_withdrawal_refund_v1('00000000-0000-4000-8000-000000000001',pg_temp.rid('w_annual'),23268);
select admin_record_withdrawal_refund_execution('00000000-0000-4000-8000-000000000001',pg_temp.rid('w_annual'),'re_local_return_fixture',23268);
select admin_record_withdrawal_return_v1('00000000-0000-4000-8000-000000000001',pg_temp.rid('w_annual'),'received',now());
select pg_temp.verify('Late return proof',(select refund_state='executed' and case_state='refunded' and refund_amount_cents=23268 and return_status='returned' from withdrawal_requests where id=pg_temp.rid('w_annual')));
select pg_temp.verify('Late return replay',admin_record_withdrawal_return_v1('00000000-0000-4000-8000-000000000001',pg_temp.rid('w_annual'),'received',now())->>'result'='unchanged');
rollback to savepoint late_return;
select pg_temp.verify('Late return updates facts without reopening refund',true);
select admin_review_withdrawal_v1('00000000-0000-4000-8000-000000000001',pg_temp.rid('w_annual'),'received_unopened','not_required',null,0,null,null);
select pg_temp.verify('C Unopened remains eligible',(withdrawal_refund_review_basis_v1(pg_temp.rid('w_annual'))->>'suggested_refund_cents')::integer=23268);
select pg_temp.verify('D Consumed no automatic loss',admin_review_withdrawal_v1('00000000-0000-4000-8000-000000000001',pg_temp.rid('w_annual'),'fully_consumed','not_required',null,0,null,null)->>'result'='reviewed');
select pg_temp.verify('D Zero default',(withdrawal_refund_review_basis_v1(pg_temp.rid('w_annual'))->>'value_loss_cents')::integer=0);
select pg_temp.verify('Nonzero requires reason',admin_review_withdrawal_v1('00000000-0000-4000-8000-000000000001',pg_temp.rid('w_annual'),'fully_consumed','not_required',null,1349,null,null)->>'result'='value_loss_reason_required');
select admin_review_withdrawal_v1('00000000-0000-4000-8000-000000000001',pg_temp.rid('w_annual'),'fully_consumed','not_required',null,1349,'Assessed consumed pack',null);
select pg_temp.verify('E Fixture arithmetic',(withdrawal_refund_review_basis_v1(pg_temp.rid('w_annual'))->>'suggested_refund_cents')::integer=21919);
select pg_temp.verify('F Over-basis loss rejected',admin_review_withdrawal_v1('00000000-0000-4000-8000-000000000001',pg_temp.rid('w_annual'),'fully_consumed','not_required',null,23269,'Too much',null)->>'result'='above_ceiling');
select admin_review_withdrawal_v1('00000000-0000-4000-8000-000000000001',pg_temp.rid('w_once'),'not_dispatched','not_required',null,0,null,null);
update orders set refunded_total_cents=5000,payment_status='partially_refunded' where id=pg_temp.rid('once');
select pg_temp.verify('F Prior refund leaves 18268',(withdrawal_refund_review_basis_v1(pg_temp.rid('w_once'))->>'remaining_cents')::integer=18268);
select admin_review_withdrawal_v1('00000000-0000-4000-8000-000000000001',pg_temp.rid('w_once'),'fully_consumed','not_required',null,1349,'Explicit fixture loss',null);
select pg_temp.verify('Prior refund plus assessed loss leaves 16919',(withdrawal_refund_review_basis_v1(pg_temp.rid('w_once'))->>'suggested_refund_cents')::integer=16919);
select admin_review_withdrawal_v1('00000000-0000-4000-8000-000000000001',pg_temp.rid('w_once'),'not_dispatched','not_required',null,0,null,null);
select pg_temp.verify('Explicit final upper bound',admin_approve_withdrawal_refund_v1('00000000-0000-4000-8000-000000000001',pg_temp.rid('w_once'),18269)->>'result'='above_remaining_refund');
select admin_review_withdrawal_v1('00000000-0000-4000-8000-000000000001',pg_temp.rid('w_other'),'not_dispatched','not_required',null,0,null,null);
select pg_temp.verify('O One-time final approval',admin_approve_withdrawal_refund_v1('00000000-0000-4000-8000-000000000001',pg_temp.rid('w_once'),10000)->>'result'='approved');
select pg_temp.verify('H Reserved approval reduces other case',(withdrawal_refund_review_basis_v1(pg_temp.rid('w_other'))->>'remaining_cents')::integer=8268);
select pg_temp.verify('H Cannot over-approve other case',admin_approve_withdrawal_refund_v1('00000000-0000-4000-8000-000000000001',pg_temp.rid('w_other'),10000)->>'result'='above_remaining_refund');
select pg_temp.verify('Approval replay',admin_approve_withdrawal_refund_v1('00000000-0000-4000-8000-000000000001',pg_temp.rid('w_once'),10000)->>'result'='already_approved');
update orders set refunded_total_cents=15000 where id=pg_temp.rid('once');
select pg_temp.verify('Stale approval blocked',admin_validate_withdrawal_payout_v1(pg_temp.rid('w_once'))->>'result'='stale_approval');
select pg_temp.verify('Annual explicit approval',admin_approve_withdrawal_refund_v1('00000000-0000-4000-8000-000000000001',pg_temp.rid('w_annual'),21919)->>'result'='approved');
select pg_temp.verify('K Future deliveries stopped',annual_plan_delivery_freeze_active(pg_temp.rid('annual')));
select pg_temp.verify('K Schedule history retained',(select count(*)=12 from annual_plan_deliveries where annual_plan_id=pg_temp.rid('annual')));
select pg_temp.verify('R No ordinary termination',(select count(*)=0 from termination_requests where resolved_annual_plan_id=pg_temp.rid('annual')));
select admin_review_withdrawal_v1('00000000-0000-4000-8000-000000000001',pg_temp.rid('w_sub'),'not_dispatched','not_required',null,0,null,null);
select admin_approve_withdrawal_refund_v1('00000000-0000-4000-8000-000000000001',pg_temp.rid('w_sub'),23268);
select pg_temp.verify('Subscription invoice identity',withdrawal_refund_review_basis_v1(pg_temp.rid('w_sub'))->>'invoice_id'='in_077');
select pg_temp.verify('Q Failed provider stop retryable',admin_record_withdrawal_subscription_stop_v1('00000000-0000-4000-8000-000000000001',pg_temp.rid('w_sub'),false,null,'Failure')->>'result'='retryable');
select pg_temp.verify('Q Not falsely cancelled',(select status='active' from subscriptions where id=pg_temp.rid('sub')));
select pg_temp.verify('P Provider stop confirmed',admin_record_withdrawal_subscription_stop_v1('00000000-0000-4000-8000-000000000001',pg_temp.rid('w_sub'),true,now(),null)->>'result'='stopped');
select pg_temp.verify('S Immediate stop not period end',(select status='cancelled' and cancelled_at is not null and not cancel_at_period_end and cancel_at is null from subscriptions where id=pg_temp.rid('sub')));
select admin_record_withdrawal_subscription_stop_v1('00000000-0000-4000-8000-000000000001',pg_temp.rid('w_sub'),true,now(),null);
select pg_temp.verify('T Provider Activity once',(select count(*)=1 from admin_activity_log where entity_id=pg_temp.rid('w_sub')::text and action='withdrawal.subscription_stop_succeeded'));
select pg_temp.verify('U Inventory unchanged',not exists((select * from inventory_items except select * from review_inventory_before) union all(select * from review_inventory_before except select * from inventory_items)));
select pg_temp.verify('U Movements unchanged',not exists((select * from inventory_movements except select * from review_movements_before) union all(select * from review_movements_before except select * from inventory_movements)));
select name||'|PASS' from review_checks order by name;
rollback;
