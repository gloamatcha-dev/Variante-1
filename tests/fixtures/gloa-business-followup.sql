-- Run only in a disposable database containing the preceding draft migration.
\set ON_ERROR_STOP on
create schema auth;
create function auth.uid() returns uuid language sql stable as
  'select nullif(current_setting(''test.user_id'',true),'''')::uuid';
create table public.admin_users (user_id uuid primary key, role text, is_active boolean);
create table public.orders (id uuid primary key, delivered_at timestamptz);
create table public.creator_commissions (
  id uuid primary key, creator_id uuid, order_id uuid, kind text, amount_cents integer,
  currency text, reverses_commission_id uuid, payout_state text, payout_id uuid
);
\ir ../../supabase/migrations/20261123170000_gloa_b2b_offer_versions.sql
\ir ../../supabase/migrations/20261123170100_gloa_creator_monthly_preview.sql

begin;
update public.operations_config set int_value=1 where key='creator_b2b_release_writes_enabled';
insert into public.admin_users values ('10000000-0000-0000-0000-000000000001','owner',true);
insert into public.business_profiles values ('20000000-0000-0000-0000-000000000001');
insert into public.b2b_offer_drafts(id, customer_id, created_by, inquiry_reference, destination_country, pack_count, net_unit_cents)
values ('30000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001',
        '10000000-0000-0000-0000-000000000001','synthetic','DE',1,100);

do $$
declare
  actor constant uuid := '10000000-0000-0000-0000-000000000001';
  draft constant uuid := '30000000-0000-0000-0000-000000000001';
begin
  if public.b2b_offer_revise_v1(draft,0,actor,1,100) <> 1 or
     public.b2b_offer_revise_v1(draft,1,actor,2,100) <> 2 then
    raise exception 'incorrect revision';
  end if;
  begin
    perform public.b2b_offer_revise_v1(draft,1,actor,3,100);
    raise exception 'stale revision accepted';
  exception when raise_exception then
    if sqlerrm <> 'offer_revision_conflict' then raise; end if;
  end;
  update public.b2b_offer_versions set state='published',
    published_at=statement_timestamp()-interval '337 hours',
    expires_at=statement_timestamp()-interval '1 hour'
    where draft_id=draft and version=2;
  perform set_config('test.user_id','20000000-0000-0000-0000-000000000001',true);
  begin
    perform public.b2b_offer_decide_v1(draft,2,'accepted');
    raise exception 'expired offer accepted';
  exception when raise_exception then
    if sqlerrm <> 'offer_not_available' then raise; end if;
  end;
  perform public.b2b_offer_revise_v1(draft,2,actor,3,100);
  update public.b2b_offer_versions set state='published',
    published_at=statement_timestamp(), expires_at=statement_timestamp()+interval '336 hours'
    where draft_id=draft and version=3;
  perform set_config('test.user_id','20000000-0000-0000-0000-000000000002',true);
  begin
    perform public.b2b_offer_decide_v1(draft,3,'accepted');
    raise exception 'cross-customer acceptance';
  exception when insufficient_privilege then null;
  end;
  perform set_config('test.user_id','20000000-0000-0000-0000-000000000001',true);
  if public.b2b_offer_decide_v1(draft,3,'accepted') <> 'accepted' or
     public.b2b_offer_decide_v1(draft,3,'accepted') <> 'accepted' then
    raise exception 'acceptance replay failed';
  end if;
  if has_table_privilege('authenticated','public.b2b_offer_versions','UPDATE') or
     has_function_privilege('anon','public.b2b_offer_decide_v1(uuid,integer,text)','EXECUTE') then
    raise exception 'offer privilege leak';
  end if;
end $$;

insert into public.orders values
  ('40000000-0000-0000-0000-000000000001','2026-08-15 12:00Z'),
  ('40000000-0000-0000-0000-000000000002',null);
insert into public.creator_commissions values
  ('50000000-0000-0000-0000-000000000001','60000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001','earned',800,'EUR',null,'pending',null),
  ('50000000-0000-0000-0000-000000000002','60000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001','reversal',250,'EUR','50000000-0000-0000-0000-000000000001','pending',null),
  ('50000000-0000-0000-0000-000000000003','60000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000002','earned',900,'EUR',null,'pending',null);
do $$
begin
  if (select array_agg(available_cents)
      from public.creator_monthly_preview_v1('10000000-0000-0000-0000-000000000001',
        '60000000-0000-0000-0000-000000000001','2026-09-01')) is distinct from array[550::bigint] then
    raise exception 'delivery gate or reversal calculation wrong';
  end if;
  begin
    perform public.creator_monthly_preview_v1('10000000-0000-0000-0000-000000000002',
      '60000000-0000-0000-0000-000000000001','2026-09-01');
    raise exception 'unverified owner allowed';
  exception when insufficient_privilege then null;
  end;
end $$;
rollback;
