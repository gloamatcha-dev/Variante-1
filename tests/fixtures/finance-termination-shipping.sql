\set ON_ERROR_STOP on
begin;
create temporary table verification_results(name text primary key, passed boolean not null);
create function pg_temp.verify(name text, ok boolean) returns void language plpgsql as $$
begin
  if ok is distinct from true then raise exception 'FAILED: %',name; end if;
  insert into verification_results values(name,true);
end $$;
create temporary table ids(tag text primary key,id uuid not null default gen_random_uuid());
insert into ids(tag) values ('normal'),('unpaid_cancelled'),('paid_cancelled'),('affiliate_order'),('ordinary'),('extraordinary'),('rejected'),('email'),('refund_plan'),('creator'),('rule'),('link'),('b2b'),('settlement');
create function pg_temp.id(tag text) returns uuid language sql as $$select id from ids where ids.tag=$1$$;
insert into auth.users(email) select 'database-'||tag||'@example.invalid' from ids where tag in ('ordinary','extraordinary','rejected','email','refund_plan');

insert into orders(id,customer_type,status,payment_status,customer_snapshot,placed_at,total_gross_cents,total_net_cents,tax_total_cents,subtotal_gross_cents,subtotal_net_cents,shipping_gross_cents,shipping_net_cents)
select id,'private','confirmed','paid','{}',now()-interval '40 days',10000,9346,654,10000,9346,0,0 from ids where tag in ('normal','paid_cancelled','affiliate_order');
insert into orders(id,customer_type,status,payment_status,customer_snapshot,placed_at,total_gross_cents)
values(pg_temp.id('unpaid_cancelled'),'private','cancelled','pending','{}',now(),10000);

insert into checkout_attempts(request_id,expected_total_gross_cents,items_snapshot)
select id,13000,'[]' from ids where tag in ('ordinary','extraordinary','rejected','email','refund_plan');
insert into annual_plans(id,user_id,payment_checkout_attempt_id,variant_id,status,payment_status,catalog_unit_gross_cents,annual_unit_gross_cents,shipping_per_delivery_gross_cents,delivery_count,merchandise_total_gross_cents,shipping_total_gross_cents,total_gross_cents,discount_percent_applied,customer_snapshot,shipping_address_snapshot,billing_address_snapshot,tax_snapshot,delivery_items_snapshot,delivery_tax_snapshot,purchased_at,plan_end_at,stripe_payment_intent_id,schedule_model)
select i.id,(select id from auth.users where email='database-'||i.tag||'@example.invalid'),a.id,(select id from product_variants where sku='GLOA-MATCHA-30G'),'active','paid',1499,1000,0,13,13000,0,13000,20,'{}','{}','{}','{"totals":{"totalGrossCents":13000}}','[{"unitGrossCents":1000,"quantity":1,"lineGrossCents":1000}]','{"totals":{"shippingGrossCents":0,"totalGrossCents":1000}}',now()-interval '30 days',now()+interval '12 months','pi_local_'||i.tag,'v1_28d_13'
from ids i join checkout_attempts a on a.request_id=i.id where i.tag in ('ordinary','extraordinary','rejected','email','refund_plan');
insert into annual_plan_deliveries(annual_plan_id,delivery_number,scheduled_for)
select i.id,n,now()+n*interval '28 days' from ids i cross join generate_series(1,13) n where tag in ('ordinary','extraordinary','rejected');
create temporary table delivery_attempts as
select tag,gen_random_uuid() request_id from ids where tag in ('ordinary','extraordinary');
insert into checkout_attempts(request_id,expected_total_gross_cents,items_snapshot,annual_plan_id,annual_delivery_number)
select request_id,1000,'[]',pg_temp.id(tag),1 from delivery_attempts;
insert into orders(customer_type,status,payment_status,customer_snapshot,placed_at,total_gross_cents,checkout_attempt_id)
select 'private','confirmed','paid','{}',now(),1000,a.id from checkout_attempts a join delivery_attempts d on a.request_id=d.request_id;
update annual_plan_deliveries d set state='fulfilled',claimed_at=now(),fulfilled_at=now(),order_id=o.id
from orders o join checkout_attempts a on a.id=o.checkout_attempt_id
where d.annual_plan_id=a.annual_plan_id and d.delivery_number=1;

insert into b2b_supply_agreements(id,business_snapshot,customer_snapshot,shipping_address_snapshot,billing_address_snapshot)
values(pg_temp.id('b2b'),'{}','{}','{}','{}');
insert into b2b_payment_schedule(id,supply_agreement_id,instalment_number,due_at,net_cents,status,paid_at,tax_rate_percent,tax_cents,gross_cents,tax_calculation_version,price_origin,stripe_payment_intent_id)
values(pg_temp.id('settlement'),pg_temp.id('b2b'),1,now(),10000,'paid',now(),7,700,10700,'de-net-2026.1','net','pi_local_b2b');

insert into creators(id,display_name,email,status) values(pg_temp.id('creator'),'Local Creator','creator@example.invalid','active');
insert into creator_commission_rules(id,label,base,percent_basis_points) values(pg_temp.id('rule'),'Local explicit 10 percent','order_gross',1000);
insert into affiliate_links(id,creator_id,slug,commission_rule_id) values(pg_temp.id('link'),pg_temp.id('creator'),'local-creator',pg_temp.id('rule'));
insert into affiliate_codes(creator_id,code,commission_rule_id) values(pg_temp.id('creator'),'LOCALCODE',pg_temp.id('rule'));

-- Stock sentinels and a complete before snapshot, including all movement rows.
insert into inventory_items(name,category_id,unit,current_quantity)
select 'Verification sentinel',id,'g',123.456 from inventory_categories limit 1;
create temporary table inventory_before as select id,current_quantity from inventory_items;
create temporary table movements_before as select * from inventory_movements;

select pg_temp.verify('finance.normal paid income',record_order_payment_event(pg_temp.id('normal'))->>'result'='recorded');
select pg_temp.verify('finance.payment replay',record_order_payment_event(pg_temp.id('normal'))->>'result'='already_recorded');
select pg_temp.verify('finance.one normal event',(select count(*)=1 from financial_events where order_id=pg_temp.id('normal')));
select pg_temp.verify('finance.unpaid cancellation earns nothing',record_order_payment_event(pg_temp.id('unpaid_cancelled'))->>'result'='order_not_paid');
select pg_temp.verify('finance.annual prepayment',record_annual_prepayment_event(pg_temp.id('refund_plan'))->>'result'='recorded');
select pg_temp.verify('finance.annual prepayment replay',record_annual_prepayment_event(pg_temp.id('refund_plan'))->>'result'='already_recorded');
select pg_temp.verify('finance.annual delivery refused',record_order_payment_event((select o.id from orders o join checkout_attempts a on a.id=o.checkout_attempt_id where a.annual_plan_id=pg_temp.id('ordinary')))->>'result'='annual_delivery');
select pg_temp.verify('finance.no annual delivery cash',(select count(*)=0 from financial_events e join orders o on o.id=e.order_id join checkout_attempts a on a.id=o.checkout_attempt_id where a.annual_plan_id is not null));
select pg_temp.verify('finance.first partial refund',record_order_refund_event(pg_temp.id('normal'),2000)->>'gross_cents'='2000');
select pg_temp.verify('finance.second partial is delta',record_order_refund_event(pg_temp.id('normal'),3500)->>'gross_cents'='1500');
select pg_temp.verify('finance.refund replay no change',record_order_refund_event(pg_temp.id('normal'),3500)->>'result'='no_change');
select pg_temp.verify('finance.stale refund no change',record_order_refund_event(pg_temp.id('normal'),1000)->>'result'='no_change');
select pg_temp.verify('finance.history preserved',(select count(*)=3 and sum(case direction when 'inflow' then gross_cents else -gross_cents end)=6500 from financial_events where order_id=pg_temp.id('normal')));
select pg_temp.verify('finance.refund date belongs to refund',(select bool_and(occurred_on=(now() at time zone 'Europe/Berlin')::date and occurred_on_basis='event_date') from financial_events where order_id=pg_temp.id('normal') and kind='refund'));
select pg_temp.verify('finance.annual refund',record_annual_plan_refund_event(pg_temp.id('refund_plan'),13000)->>'gross_cents'='13000');
select pg_temp.verify('finance.annual refund replay',record_annual_plan_refund_event(pg_temp.id('refund_plan'),13000)->>'result'='no_change');
select pg_temp.verify('finance.annual balances to zero',(select count(*)=2 and sum(case direction when 'inflow' then gross_cents else -gross_cents end)=0 from financial_events where annual_plan_id=pg_temp.id('refund_plan')));
select record_order_payment_event(pg_temp.id('paid_cancelled'));
update orders set status='cancelled',payment_status='refunded',refunded_total_cents=10000 where id=pg_temp.id('paid_cancelled');
select record_order_refund_event(pg_temp.id('paid_cancelled'),10000);
select pg_temp.verify('finance.cancelled refunded order net zero',(select count(*)=2 and sum(case direction when 'inflow' then gross_cents else -gross_cents end)=0 from financial_events where order_id=pg_temp.id('paid_cancelled')));
select pg_temp.verify('finance.b2b settlement',record_b2b_settlement_event(pg_temp.id('settlement'))->>'gross_cents'='10700');
select pg_temp.verify('finance.b2b settlement replay',record_b2b_settlement_event(pg_temp.id('settlement'))->>'result'='already_recorded');
select pg_temp.verify('finance.b2b exactly once',(select count(*)=1 and sum(gross_cents)=10700 from financial_events where b2b_agreement_id=pg_temp.id('b2b')));

insert into termination_requests(termination_kind,customer_name,contract_reference,contact_email,contract_kind,resolved_annual_plan_id,extraordinary_reason)
select case tag when 'ordinary' then 'ordinary' else 'extraordinary' end,'Local Customer',tag,'database-customer@example.invalid','annual_plan',id,case tag when 'ordinary' then null else 'Local extraordinary case' end from ids where tag in ('ordinary','extraordinary','rejected');
create temporary table decisions as select t.id,gen_random_uuid() operation_id,i.tag from termination_requests t join ids i on i.id=t.resolved_annual_plan_id;
select admin_decide_annual_termination('00000000-0000-4000-8000-000000000001',d.id,'note_ordinary',null,d.operation_id) from decisions d where tag='ordinary';
select pg_temp.verify('termination.ordinary linked and active',(select p.status='active' and p.termination_request_id=t.id and p.termination_effect='noted_ends_automatically' and t.case_state='acknowledged_ends_automatically' from annual_plans p join termination_requests t on t.resolved_annual_plan_id=p.id where p.id=pg_temp.id('ordinary')));
select pg_temp.verify('termination.ordinary keeps paid schedule',(select count(*)=12 from annual_plan_deliveries where annual_plan_id=pg_temp.id('ordinary') and state='scheduled'));
select admin_decide_annual_termination('00000000-0000-4000-8000-000000000001',d.id,'accept_extraordinary',null,d.operation_id) from decisions d where tag='extraordinary';
select pg_temp.verify('termination.accepted cancelled with timestamps',(select status='cancelled' and cancelled_at is not null and terminated_at is not null and termination_effect='ended_extraordinary' from annual_plans where id=pg_temp.id('extraordinary')));
select pg_temp.verify('termination.accepted stops all unfulfilled',(select count(*)=12 from annual_plan_deliveries where annual_plan_id=pg_temp.id('extraordinary') and state='cancelled' and order_id is null));
select pg_temp.verify('termination.fulfilled history survives',(select count(*)=1 from annual_plan_deliveries where annual_plan_id=pg_temp.id('extraordinary') and state='fulfilled' and order_id is not null));
select pg_temp.verify('termination.repeated action idempotent',(select admin_decide_annual_termination('00000000-0000-4000-8000-000000000001',id,'accept_extraordinary',null,operation_id)->>'result'='already_decided' from decisions where tag='extraordinary'));
select pg_temp.verify('termination.one audit',(select count(*)=1 from admin_activity_log l join decisions d on d.operation_id=l.operation_id where d.tag='extraordinary'));
select admin_decide_annual_termination('00000000-0000-4000-8000-000000000001',d.id,'reject_extraordinary',null,d.operation_id) from decisions d where tag='rejected';
select pg_temp.verify('termination.rejected plan untouched',(select status='active' and termination_request_id is null and terminated_at is null from annual_plans where id=pg_temp.id('rejected')));
select pg_temp.verify('termination.rejected schedule untouched',(select count(*)=13 from annual_plan_deliveries where annual_plan_id=pg_temp.id('rejected') and state='scheduled'));
update annual_plan_deliveries set scheduled_for=now()-interval '1 day' where delivery_number=2;
create temporary table claimed_queue as select * from claim_due_annual_plan_deliveries(100);
select pg_temp.verify('termination.ordinary still claimable',(select count(*)=1 from claimed_queue where annual_plan_id=pg_temp.id('ordinary')));
select pg_temp.verify('termination.rejected still claimable',(select count(*)=1 from claimed_queue where annual_plan_id=pg_temp.id('rejected')));
select pg_temp.verify('termination.accepted absent from queue',(select count(*)=0 from claimed_queue where annual_plan_id=pg_temp.id('extraordinary')));
select pg_temp.verify('termination.accepted fulfillment refused',fulfill_annual_plan_delivery((select id from annual_plan_deliveries where annual_plan_id=pg_temp.id('extraordinary') and delivery_number=2))->>'result'='plan_not_active');

select pg_temp.verify('email.initial unclaimed',(select internal_notification_status is null from annual_plans where id=pg_temp.id('email')));
select pg_temp.verify('email.claim',claim_annual_purchase_notification(pg_temp.id('email')));
select pg_temp.verify('email.sending',(select internal_notification_status='sending' and internal_notification_sent_at is null from annual_plans where id=pg_temp.id('email')));
select pg_temp.verify('email.duplicate in-flight claim refused',not claim_annual_purchase_notification(pg_temp.id('email')));
-- Mock provider failure: no provider client or network is involved.
select pg_temp.verify('email.mock failure marked',mark_annual_purchase_notification(pg_temp.id('email'),'failed'));
select pg_temp.verify('email.failed no send time',(select internal_notification_status='failed' and internal_notification_sent_at is null from annual_plans where id=pg_temp.id('email')));
select pg_temp.verify('email.duplicate failure refused',not mark_annual_purchase_notification(pg_temp.id('email'),'failed'));
select pg_temp.verify('email.failed reclaimable',claim_annual_purchase_notification(pg_temp.id('email')));
-- Mock successful retry: persist the simulated provider acknowledgement.
select pg_temp.verify('email.retry sent',mark_annual_purchase_notification(pg_temp.id('email'),'sent'));
select pg_temp.verify('email.sent timestamp',(select internal_notification_status='sent' and internal_notification_sent_at is not null from annual_plans where id=pg_temp.id('email')));
select pg_temp.verify('email.sent cannot reclaim',not claim_annual_purchase_notification(pg_temp.id('email')));
select pg_temp.verify('email.duplicate sent refused',not mark_annual_purchase_notification(pg_temp.id('email'),'sent'));

select pg_temp.verify('affiliate.active link resolves',resolve_affiliate_link('local-creator')->>'result'='active');
select pg_temp.verify('affiliate.active code resolves',resolve_affiliate_code('localcode')->>'result'='active');
update affiliate_links set active=false where id=pg_temp.id('link');
select pg_temp.verify('affiliate.paused link refused',resolve_affiliate_link('local-creator')->>'result'='paused');
update affiliate_links set active=true,starts_at=now()-interval '2 days',ends_at=now()-interval '1 day' where id=pg_temp.id('link');
select pg_temp.verify('affiliate.expired link refused',resolve_affiliate_link('local-creator')->>'result'='expired');
update affiliate_links set ends_at=null where id=pg_temp.id('link');
update creators set status='paused' where id=pg_temp.id('creator');
select pg_temp.verify('affiliate.paused creator refused',resolve_affiliate_link('local-creator')->>'result'='creator_inactive');
update creators set status='active' where id=pg_temp.id('creator');
select pg_temp.verify('affiliate.safe click',record_affiliate_click(pg_temp.id('link')));
select pg_temp.verify('affiliate.unknown click refused',not record_affiliate_click(gen_random_uuid()));
select pg_temp.verify('affiliate.click only aggregate',(select count(*)=1 and sum(click_count)=1 from affiliate_link_clicks where affiliate_link_id=pg_temp.id('link')));
select pg_temp.verify('affiliate.paid attribution',attribute_order_to_creator(pg_temp.id('affiliate_order'),'affiliate_link','local-creator')->>'commission_cents'='1000');
select pg_temp.verify('affiliate.replay refused',attribute_order_to_creator(pg_temp.id('affiliate_order'),'affiliate_code','LOCALCODE')->>'result'='already_attributed');
select pg_temp.verify('affiliate.one attribution',(select count(*)=1 from order_attributions where order_id=pg_temp.id('affiliate_order')));
select pg_temp.verify('affiliate.one earned commission',(select count(*)=1 and sum(amount_cents)=1000 from creator_commissions where order_id=pg_temp.id('affiliate_order')));
select pg_temp.verify('affiliate.refund proportional',reverse_creator_commission_for_refund(pg_temp.id('affiliate_order'),2500)->>'result'='reversed');
select pg_temp.verify('affiliate.refund replay no change',reverse_creator_commission_for_refund(pg_temp.id('affiliate_order'),2500)->>'result'='no_change');
select pg_temp.verify('affiliate.reversal once',(select count(*)=1 and sum(amount_cents)=250 from creator_commissions where order_id=pg_temp.id('affiliate_order') and kind='reversal'));
select pg_temp.verify('affiliate.cancelled cannot attribute',attribute_order_to_creator(pg_temp.id('paid_cancelled'),'affiliate_link','local-creator')->>'result'='order_cancelled');

select pg_temp.verify('inventory.quantity identical',not exists((select id,current_quantity from inventory_items except select * from inventory_before) union all (select * from inventory_before except select id,current_quantity from inventory_items)));
select pg_temp.verify('inventory.movements identical',not exists((select * from inventory_movements except select * from movements_before) union all (select * from movements_before except select * from inventory_movements)));
select pg_temp.verify('security.service money tables read-only',not exists(select from unnest(array['financial_events','order_attributions','creator_commissions','business_expenses']) t where has_table_privilege('service_role','public.'||t,'insert') or has_table_privilege('service_role','public.'||t,'update') or has_table_privilege('service_role','public.'||t,'delete')));
select split_part(name,'.',1) category,count(*) passed from verification_results group by 1 order by 1;
select name||'|PASS' from verification_results order by name;
select count(*)||' PASS / 0 FAIL' as total from verification_results;
rollback;
