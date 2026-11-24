-- Run only in fresh disposable PostgreSQL. No existing roles or data are changed.
\set ON_ERROR_STOP on
do $$ begin
  if current_database() <> 'gloa_activation_test'
     or inet_server_addr() is distinct from inet '127.0.0.1'
     or current_user <> 'postgres' then
    raise exception 'disposable loopback activation test required';
  end if;
end $$;
do $$ begin
  if not exists (select from pg_roles where rolname='anon') then create role anon; end if;
  if not exists (select from pg_roles where rolname='authenticated') then create role authenticated; end if;
  if not exists (select from pg_roles where rolname='service_role') then create role service_role bypassrls; end if;
end $$;
create schema auth;
create function auth.uid() returns uuid language sql stable as
  'select nullif(current_setting(''test.user_id'',true),'''')::uuid';
create table public.operations_config(key text primary key, int_value integer, text_value text);
grant select,insert,update on public.operations_config to service_role;
create table public.business_profiles(user_id uuid primary key);
create table public.addresses(id uuid primary key,user_id uuid);
create table public.admin_users(user_id uuid primary key,role text,is_active boolean);
create table public.creators(id uuid primary key);
create table public.creator_payouts(
  id uuid primary key default gen_random_uuid(),creator_id uuid,total_cents bigint,state text default 'draft',
  created_by uuid,approved_by uuid,updated_at timestamptz,reference text,paid_at timestamptz
);
grant select,insert,update on public.creator_payouts to service_role;
create table public.orders(
  id uuid primary key,delivered_at timestamptz,cancelled_at timestamptz,status text,total_gross_cents integer,
  refunded_total_cents integer,payment_status text
);
create table public.creator_commissions(
  id uuid primary key,creator_id uuid,order_id uuid,kind text,amount_cents integer,currency text,
  reverses_commission_id uuid,payout_state text,payout_id uuid,created_at timestamptz
);
create table public.documents(id uuid primary key,cleanup_operation_id uuid,storage_path text,file_sha256 text);

\ir ../../supabase/migrations/20261123160000_gloa_offer_drafts_and_invoice_issuers.sql
\ir ../../supabase/migrations/20261123170000_gloa_b2b_offer_versions.sql
\ir ../../supabase/migrations/20261123170100_gloa_creator_monthly_preview.sql
\ir ../../supabase/migrations/20261123190000_creator_monthly_payout_workflow.sql
\ir ../../supabase/migrations/20261124130000_b2b_offer_publication_and_handoff.sql
\ir ../../supabase/migrations/20261124140000_b2b_offer_contract_terms.sql
\ir ../../supabase/migrations/20261124180000_b2b_offer_checkout_link.sql

begin;
insert into public.admin_users values ('10000000-0000-4000-8000-000000000001','owner',true);
insert into public.creators values ('10000000-0000-4000-8000-000000000002');
insert into public.business_profiles values ('10000000-0000-4000-8000-000000000003');
insert into public.addresses values ('10000000-0000-4000-8000-000000000004','10000000-0000-4000-8000-000000000003');
insert into public.orders values ('10000000-0000-4000-8000-000000000005','2020-01-01',null,'delivered',5000,0,'paid');
insert into public.creator_commissions values (
  '10000000-0000-4000-8000-000000000006','10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000005','earned',500,'EUR',null,'eligible',null,'2020-01-01'
);
insert into public.documents values ('10000000-0000-4000-8000-000000000007',null,'fixture.pdf','fixture');

create function pg_temp.expect_refusal(statement text, state text, message text) returns void language plpgsql as $$
begin
  begin
    execute statement;
    raise exception 'expected refusal';
  exception when others then
    if sqlstate <> state or sqlerrm <> message then raise; end if;
  end;
end $$;

set local role service_role;
select pg_temp.expect_refusal(
  $$insert into public.operations_config(key,int_value) values ('creator_b2b_release_writes_enabled',1)
    on conflict(key) do update set int_value=excluded.int_value$$,'42501','release_config_reserved');
insert into public.operations_config(key,int_value) values ('dispatch_sla_business_days',2);
select pg_temp.expect_refusal(
  $$insert into public.b2b_offer_drafts(id,customer_id,created_by,inquiry_reference,destination_country,pack_count,net_unit_cents)
    values('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000001','fixture','DE',3,5250)$$,
    '55000','release_writes_disabled');
select pg_temp.expect_refusal(
  $$select public.admin_creator_payout_v1('10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002','2020-03-01','create','20000000-0000-4000-8000-000000000002')$$,
    '55000','release_writes_disabled');
select public.admin_creator_payout_v1('10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002','2020-03-01','read');
reset role;

set local role authenticated;
select pg_temp.expect_refusal(
  $$select public.b2b_offer_decide_v1('20000000-0000-4000-8000-000000000001',1,'accepted')$$,
    '55000','release_writes_disabled');
reset role;

update public.operations_config set int_value=1 where key='creator_b2b_release_writes_enabled';
set local role service_role;
insert into public.b2b_offer_drafts(id,customer_id,created_by,inquiry_reference,destination_country,pack_count,net_unit_cents)
values ('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000003',
  '10000000-0000-4000-8000-000000000001','fixture','DE',3,5250);
select public.b2b_offer_revise_v1('20000000-0000-4000-8000-000000000001',0,'10000000-0000-4000-8000-000000000001',3,5250);
select public.b2b_offer_publish_with_terms_v1('20000000-0000-4000-8000-000000000001',1,
  '10000000-0000-4000-8000-000000000001','fixture evidence',
  '{"packs":3,"packNetCents":5250,"country":"DE","planType":"monthly","postcode":"10115","deliveryIntervalMonths":1,"shippingGrossCents":0,"pricing":{},"charges":[{"netCents":15750,"taxCents":1103,"grossCents":16853}]}');
select public.claim_b2b_offer_notification_v1('20000000-0000-4000-8000-000000000001',1);
select public.admin_creator_payout_v1('10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000002','2020-03-01','create','20000000-0000-4000-8000-000000000002');
reset role;

set local role authenticated;
set local test.user_id = '10000000-0000-4000-8000-000000000003';
select public.b2b_offer_decide_v1('20000000-0000-4000-8000-000000000001',1,'accepted');
reset role;

set local role service_role;
select public.b2b_offer_checkout_context_v1('20000000-0000-4000-8000-000000000001',1,
  '10000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000004');
reset role;
update public.operations_config set int_value=0 where key='creator_b2b_release_writes_enabled';

insert into public.creator_payouts(id,creator_id,total_cents) values
 ('20000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000002',100);
set local role service_role;
update public.creator_payouts set reference='ordinary' where id='20000000-0000-4000-8000-000000000003';
select pg_temp.expect_refusal(
  $$update public.creator_payouts set state='approved' where id<>'20000000-0000-4000-8000-000000000003'$$,
    '55000','release_writes_disabled');
reset role;

set local role service_role;
select pg_temp.expect_refusal(
  $$update public.b2b_offer_notifications set status='sent' where draft_id='20000000-0000-4000-8000-000000000001'$$,
    '55000','release_writes_disabled');
select pg_temp.expect_refusal(
  $$select public.b2b_offer_checkout_context_v1('20000000-0000-4000-8000-000000000001',1,
    '10000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000004')$$,
    '55000','release_writes_disabled');
select pg_temp.expect_refusal(
  $$select public.b2b_offer_publish_with_terms_v1('20000000-0000-4000-8000-000000000001',1,
    '10000000-0000-4000-8000-000000000001','fixture evidence','{}')$$,
    '55000','release_writes_disabled');
select pg_temp.expect_refusal(
  $$select public.b2b_offer_revise_v1('20000000-0000-4000-8000-000000000001',1,'10000000-0000-4000-8000-000000000001',3,5250)$$,
    '55000','release_writes_disabled');
select pg_temp.expect_refusal(
  $$select public.claim_b2b_offer_notification_v1('20000000-0000-4000-8000-000000000001',1)$$,
    '55000','release_writes_disabled');
reset role;

update public.documents set storage_path='ordinary-edit.pdf';
do $$ begin
  if (select count(*) from public.creator_payout_events) <> 1
    or (select count(*) from public.b2b_offer_contract_handoffs) <> 1
    or (select count(*) from public.b2b_offer_checkout_links) <> 1
    or not exists(select 1 from public.b2b_offer_notifications where status='sending')
    or not exists(select 1 from public.operations_config where key='dispatch_sla_business_days' and int_value=2) then
    raise exception 'unexpected business data after re-lock';
  end if;
end $$;
rollback;
