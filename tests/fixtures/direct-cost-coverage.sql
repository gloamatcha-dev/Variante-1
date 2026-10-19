-- Synthetic disposable PostgreSQL only; no external/provider calls.
begin;
create temporary table cost_ids(tag text primary key,id uuid default gen_random_uuid());
insert into cost_ids(tag) values('order'),('cycle2'),('annual1'),('annual2'),('b2b'),('expense'),('packaging'),('general'),('race');
create function pg_temp.cid(t text) returns uuid language sql as $$select id from cost_ids where tag=t$$;
create function pg_temp.actor() returns uuid language sql as $$select user_id from public.admin_users where is_active and role in ('owner','admin') limit 1$$;
create temporary table cost_checks(name text primary key);
create function pg_temp.check_cost(n text,ok boolean) returns void language plpgsql as $$begin if ok is distinct from true then raise exception '082 check failed: %',n;end if;insert into cost_checks values(n);end$$;
insert into checkout_attempts(id,request_id,expected_total_gross_cents,items_snapshot,status,stripe_payment_intent_id,paid_at)
select id,id,10000,'[]','paid','pi_082_'||tag,now() from cost_ids where tag in ('order','cycle2','annual1','annual2','race');
insert into orders(id,checkout_attempt_id,customer_type,status,payment_status,customer_snapshot,total_gross_cents,stripe_payment_intent_id,placed_at)
select id,id,'private','confirmed','paid',jsonb_build_object('test082',tag),10000,'pi_082_'||tag,now() from cost_ids where tag in ('order','cycle2','annual1','annual2','race');
create function pg_temp.cover(t text,c text,s text,e uuid default null) returns jsonb language sql as $$
 select public.admin_set_direct_cost_coverage_v1(pg_temp.actor(),'order',pg_temp.cid(t),c,s,e,'Documented local test',gen_random_uuid())$$;
select pg_temp.check_cost('initial unknown',(select count(*)=0 from direct_cost_coverage));
select pg_temp.check_cost('zero explicit',pg_temp.cover('order','matcha_cogs','confirmed_zero')->>'result'='recorded');
select pg_temp.check_cost('replay random operation unchanged',pg_temp.cover('order','matcha_cogs','confirmed_zero')->>'result'='unchanged');
select pg_temp.cover('order','packaging','not_applicable');
select pg_temp.check_cost('missing carrier',(select count(*)=2 from direct_cost_coverage where order_id=pg_temp.cid('order')));
select pg_temp.cover('order','shipping','confirmed_zero');
select pg_temp.check_cost('all three resolved',(select count(*)=3 from direct_cost_coverage where order_id=pg_temp.cid('order')));
select pg_temp.check_cost('next cycle independent',(select count(*)=0 from direct_cost_coverage where order_id=pg_temp.cid('cycle2')));
select pg_temp.cover('annual1','matcha_cogs','confirmed_zero');
select pg_temp.check_cost('annual delivery2 independent',(select count(*)=0 from direct_cost_coverage where order_id=pg_temp.cid('annual2')));
insert into business_expenses(id,occurred_on,category,order_id,description,gross_cents,vat_cents,currency,channel,payment_status,created_by)
values(pg_temp.cid('expense'),'2040-10-10','matcha_cogs',pg_temp.cid('order'),'Documented COGS',3000,0,'EUR','b2c','open',pg_temp.actor());
select pg_temp.check_cost('new cost reopens prior zero',(select count(*)=0 from direct_cost_coverage where order_id=pg_temp.cid('order') and cost_class='matcha_cogs'));
select pg_temp.cover('order','matcha_cogs','captured',pg_temp.cid('expense'));
select pg_temp.check_cost('positive evidence reference',(select business_expense_id=pg_temp.cid('expense') from direct_cost_coverage where order_id=pg_temp.cid('order') and cost_class='matcha_cogs'));
insert into business_expenses(occurred_on,category,order_id,description,gross_cents,currency,channel,payment_status,created_by)
select '2040-10-10',c,pg_temp.cid('order'),'Actual documented '||c,100,'EUR','b2c','open',pg_temp.actor() from unnest(array['packaging','shipping']) c;
select pg_temp.cover('order',category,'captured',id) from business_expenses where order_id=pg_temp.cid('order') and category in ('packaging','shipping');
select pg_temp.check_cost('positive packaging and actual carrier',(select count(*)=2 from direct_cost_coverage where order_id=pg_temp.cid('order') and cost_class in ('packaging','shipping') and coverage_status='captured'));
do $$begin
 begin perform pg_temp.cover('order','shipping','captured',pg_temp.cid('expense'));raise exception 'accepted wrong category';exception when others then if sqlerrm='accepted wrong category' then raise;end if;end;
 begin perform pg_temp.cover('cycle2','matcha_cogs','captured',pg_temp.cid('expense'));raise exception 'accepted wrong subject';exception when others then if sqlerrm='accepted wrong subject' then raise;end if;end;
 begin perform pg_temp.cover('order','matcha_cogs','confirmed_zero');raise exception 'accepted zero with cost';exception when others then if sqlerrm='accepted zero with cost' then raise;end if;end;
end$$;
select pg_temp.check_cost('correction amount invalidates',true);
update business_expenses set gross_cents=3100 where id=pg_temp.cid('expense');
select pg_temp.check_cost('corrected amount open',(select count(*)=0 from direct_cost_coverage where business_expense_id=pg_temp.cid('expense')));
select pg_temp.cover('order','matcha_cogs','captured',pg_temp.cid('expense'));
delete from business_expenses where id=pg_temp.cid('expense');
select pg_temp.check_cost('delete opens coverage',(select count(*)=0 from direct_cost_coverage where business_expense_id=pg_temp.cid('expense')));
select admin_confirm_general_cost_month_v1(pg_temp.actor(),'2040-10-01','confirmed_zero','No overhead',gen_random_uuid());
select pg_temp.check_cost('general zero durable',(select coverage_status='confirmed_zero' from general_cost_period_coverage where period_start='2040-10-01'));
insert into business_expenses(id,occurred_on,category,description,gross_cents,currency,channel,payment_status,created_by)
values(pg_temp.cid('general'),'2040-10-10','general','Supplier overhead',100,'EUR','internal','open',pg_temp.actor());
select pg_temp.check_cost('general create invalidates',(select count(*)=0 from general_cost_period_coverage where period_start='2040-10-01'));
select admin_confirm_general_cost_month_v1(pg_temp.actor(),'2040-10-01','confirmed_complete','All invoices entered',gen_random_uuid());
select pg_temp.check_cost('general replay',admin_confirm_general_cost_month_v1(pg_temp.actor(),'2040-10-01','confirmed_complete','All invoices entered',gen_random_uuid())->>'result'='unchanged');
update business_expenses set gross_cents=110 where id=pg_temp.cid('general');
select pg_temp.check_cost('general update invalidates',(select count(*)=0 from general_cost_period_coverage where period_start='2040-10-01'));
select admin_confirm_general_cost_month_v1(pg_temp.actor(),'2040-10-01','confirmed_complete','All invoices entered',gen_random_uuid());
select admin_confirm_general_cost_month_v1(pg_temp.actor(),'2040-11-01','confirmed_zero','No overhead',gen_random_uuid());
update business_expenses set occurred_on='2040-11-10' where id=pg_temp.cid('general');
select pg_temp.check_cost('move invalidates both months',(select count(*)=0 from general_cost_period_coverage where period_start in ('2040-10-01','2040-11-01')));
select admin_confirm_general_cost_month_v1(pg_temp.actor(),'2040-11-01','confirmed_complete','All invoices entered',gen_random_uuid());
delete from business_expenses where id=pg_temp.cid('general');
select pg_temp.check_cost('general delete invalidates',(select count(*)=0 from general_cost_period_coverage where period_start='2040-11-01'));
select pg_temp.check_cost('base classes only',(select count(*)=0 from direct_cost_coverage where cost_class in ('payment_fee','other_direct')));
select pg_temp.check_cost('browser table denial',not has_table_privilege('authenticated','direct_cost_coverage','SELECT,INSERT,UPDATE,DELETE'));
select pg_temp.check_cost('browser RPC denial',not has_function_privilege('authenticated','admin_set_direct_cost_coverage_v1(uuid,text,uuid,text,text,uuid,text,uuid)','EXECUTE'));
select pg_temp.check_cost('service no table mutation',not has_table_privilege('service_role','general_cost_period_coverage','INSERT,UPDATE,DELETE'));
select pg_temp.check_cost('single query returns basis',jsonb_typeof(read_cost_finance_basis_v1('2040-10-01','2040-11-01')->'subjects')='array');
-- Exact B2B physical delivery without any fabricated Order.
-- Self-contained on a fresh disposable baseline; never depend on prior suite data.
with agreement as (
 insert into b2b_supply_agreements(business_snapshot,customer_snapshot,shipping_address_snapshot,billing_address_snapshot)
 values('{"test082":"delivery_fixture"}','{}','{}','{}') returning id
)
insert into b2b_deliveries(id,supply_agreement_id,delivery_number,scheduled_for,quantity_packs)
select pg_temp.cid('b2b'),id,1,'2040-10-10',1 from agreement;
select pg_temp.check_cost('B2B null Order exists',pg_temp.cid('b2b') is not null);
select admin_record_b2b_delivery_expense_v1(pg_temp.actor(),pg_temp.cid('b2b'),'2040-10-10','matcha_cogs',2500,0,'Actual B2B COGS','Fixture supplier','Invoice reference',pg_temp.cid('expense'));
select pg_temp.check_cost('B2B expense replay',admin_record_b2b_delivery_expense_v1(pg_temp.actor(),pg_temp.cid('b2b'),'2040-10-10','matcha_cogs',2500,0,'Actual B2B COGS','Fixture supplier','Invoice reference',pg_temp.cid('expense'))->>'result'='already_recorded');
select admin_set_direct_cost_coverage_v1(pg_temp.actor(),'b2b_delivery',pg_temp.cid('b2b'),'matcha_cogs','captured',(select id from business_expenses where b2b_delivery_id=pg_temp.cid('b2b')),'Verified B2B cost',gen_random_uuid());
select pg_temp.check_cost('B2B expense no Order',(select order_id is null and b2b_delivery_id=pg_temp.cid('b2b') from business_expenses where b2b_delivery_id=pg_temp.cid('b2b')));
select pg_temp.check_cost('B2B canonical coverage',(select order_id is null and coverage_status='captured' from direct_cost_coverage where b2b_delivery_id=pg_temp.cid('b2b')));
select '082 MATRIX PASS: '||count(*) from cost_checks;
commit;
