/** Permanent local-only verification: real PostgreSQL/routes, doubled providers, no Production access. */
import fs from 'node:fs';

const {sql}=await import('../helpers/affiliateAtomicDatabase.mjs');
const extra=`
insert into ids(tag) values ('schedule_v1'),('schedule_v2');
insert into auth.users(email) select 'database-'||tag||'@example.invalid' from ids where tag in ('schedule_v1','schedule_v2');
insert into checkout_attempts(request_id,user_id,expected_total_gross_cents,items_snapshot,status,stripe_payment_intent_id,stripe_checkout_session_id,paid_at)
select id,(select id from auth.users where email='database-'||tag||'@example.invalid'),case tag when 'schedule_v1' then 13000 else 12000 end,'[]','paid','pi_'||tag,'cs_'||tag,'2026-01-31T09:00:00Z' from ids where tag in ('schedule_v1','schedule_v2');
insert into annual_plans(id,user_id,payment_checkout_attempt_id,variant_id,status,payment_status,catalog_unit_gross_cents,annual_unit_gross_cents,shipping_per_delivery_gross_cents,delivery_count,merchandise_total_gross_cents,shipping_total_gross_cents,total_gross_cents,discount_percent_applied,customer_snapshot,shipping_address_snapshot,billing_address_snapshot,tax_snapshot,delivery_items_snapshot,delivery_tax_snapshot,schedule_model)
select i.id,a.user_id,a.id,(select id from product_variants where sku='GLOA-MATCHA-30G'),'pending','pending',1499,1000,0,case tag when 'schedule_v1' then 13 else 12 end,a.expected_total_gross_cents,0,a.expected_total_gross_cents,20,'{}','{}','{}',jsonb_build_object('totals',jsonb_build_object('totalGrossCents',a.expected_total_gross_cents)),'[{"unitGrossCents":1000,"quantity":1,"lineGrossCents":1000}]','{"totals":{"shippingGrossCents":0,"totalGrossCents":1000}}',case tag when 'schedule_v1' then 'v1_28d_13' else 'v2_monthly_12' end from ids i join checkout_attempts a on a.request_id=i.id where tag in ('schedule_v1','schedule_v2');
select pg_temp.verify('schedule.v1 actual activation',activate_annual_plan_from_payment(pg_temp.id('schedule_v1'),'cs_schedule_v1','pi_schedule_v1',null)->>'result'='activated');
select pg_temp.verify('schedule.v2 actual activation',activate_annual_plan_from_payment(pg_temp.id('schedule_v2'),'cs_schedule_v2','pi_schedule_v2',null)->>'result'='activated');
select pg_temp.verify('schedule.v1 thirteen rows',(select count(*)=13 from annual_plan_deliveries where annual_plan_id=pg_temp.id('schedule_v1')));
select pg_temp.verify('schedule.v1 exact 28 days',(select bool_and(scheduled_for='2026-01-31T09:00:00Z'::timestamptz+make_interval(hours=>672*(delivery_number-1))) from annual_plan_deliveries where annual_plan_id=pg_temp.id('schedule_v1')));
select pg_temp.verify('schedule.v2 twelve rows',(select count(*)=12 from annual_plan_deliveries where annual_plan_id=pg_temp.id('schedule_v2')));
select pg_temp.verify('schedule.v2 February clamped and March reanchored',(select bool_and((scheduled_for at time zone 'Europe/Berlin')::date=case delivery_number when 2 then '2026-02-28'::date when 3 then '2026-03-31'::date end) from annual_plan_deliveries where annual_plan_id=pg_temp.id('schedule_v2') and delivery_number in (2,3)));
select pg_temp.verify('schedule.v2 fixed year end',(select (plan_end_at at time zone 'Europe/Berlin')::date='2027-01-31' from annual_plans where id=pg_temp.id('schedule_v2')));
select pg_temp.verify('schedule.v2 replay no duplicates',activate_annual_plan_from_payment(pg_temp.id('schedule_v2'),'cs_schedule_v2','pi_schedule_v2',null)->>'result'='already_active');
select pg_temp.verify('schedule.v2 prepaid once',record_annual_prepayment_event(pg_temp.id('schedule_v2'))->>'result'='recorded');
select pg_temp.verify('schedule.v2 prepaid replay',record_annual_prepayment_event(pg_temp.id('schedule_v2'))->>'result'='already_recorded');
select pg_temp.verify('schedule.v2 cash ledger one row',(select count(*)=1 and sum(gross_cents)=12000 from financial_events where annual_plan_id=pg_temp.id('schedule_v2')));
select name||'|PASS' from verification_results where name like 'schedule.%' order by name;
`;
const source=fs.readFileSync('tests/fixtures/finance-termination-shipping.sql','utf8').replace('select split_part(name',extra+'\nselect split_part(name');
let result;
try{result=sql(source);}catch(error){const prefix=source.slice(0,source.indexOf("select pg_temp.verify('schedule.v1 actual activation'"));console.log(sql(prefix+"select activate_annual_plan_from_payment(pg_temp.id('schedule_v1'),'cs_schedule_v1','pi_schedule_v1',null);rollback;").split('\n').slice(-4).join('\n'));throw error;}
fs.writeFileSync('outputs/final-verification/annual-db.log',result);console.log(result.split('\n').slice(-14).join('\n'));
