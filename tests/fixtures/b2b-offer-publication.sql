-- Run only against a fresh disposable PostgreSQL database.
\set ON_ERROR_STOP on
create role anon;
create role authenticated;
create role service_role;
create schema auth;
create function auth.uid() returns uuid language sql stable as
  'select nullif(current_setting(''test.user_id'',true),'''')::uuid';
create table public.business_profiles(user_id uuid primary key);
create table public.admin_users(user_id uuid primary key,role text,is_active boolean);
\ir ../../supabase/migrations/20261123160000_gloa_offer_drafts_and_invoice_issuers.sql
\ir ../../supabase/migrations/20261123170000_gloa_b2b_offer_versions.sql
\ir ../../supabase/migrations/20261124130000_b2b_offer_publication_and_handoff.sql
do $$
declare
  owner_id constant uuid := '10000000-0000-0000-0000-000000000001';
  customer_id constant uuid := '20000000-0000-0000-0000-000000000001';
  other_id constant uuid := '20000000-0000-0000-0000-000000000002';
  local_draft constant uuid := '30000000-0000-0000-0000-000000000001';
  foreign_id constant uuid := '30000000-0000-0000-0000-000000000002';
  expiry timestamptz;
begin
  insert into public.admin_users values(owner_id,'owner',true),(other_id,'admin',true);
  insert into public.business_profiles values(customer_id),(other_id);
  insert into public.b2b_offer_drafts(id,customer_id,created_by,inquiry_reference,destination_country,pack_count,net_unit_cents)
    values(local_draft,customer_id,owner_id,'fixture','DE',3,800),(foreign_id,customer_id,owner_id,'foreign','CH',3,800);
  perform public.b2b_offer_revise_v1(local_draft,0,owner_id,3,800);
  perform public.b2b_offer_revise_v1(foreign_id,0,owner_id,3,800);
  begin
    perform public.b2b_offer_publish_v1(local_draft,1,other_id,'fixture');
    raise exception 'non-owner published';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.b2b_offer_publish_v1(foreign_id,1,owner_id,'fixture');
    raise exception 'international offer published';
  exception when raise_exception then
    if sqlerrm <> 'offer_tax_review_required' then raise; end if;
  end;
  expiry := public.b2b_offer_publish_v1(local_draft,1,owner_id,'fixture');
  if expiry is distinct from public.b2b_offer_publish_v1(local_draft,1,owner_id,'fixture') then
    raise exception 'publication replay changed expiry';
  end if;
  if not exists (select 1 from public.b2b_offer_versions v where v.draft_id=local_draft and
      v.expires_at-v.published_at=interval '336 hours') then raise exception 'bad expiry'; end if;
  perform public.b2b_offer_revise_v1(local_draft,1,owner_id,4,900);
  perform set_config('test.user_id',customer_id::text,true);
  begin
    perform public.b2b_offer_decide_v1(local_draft,1,'accepted');
    raise exception 'superseded offer accepted';
  exception when raise_exception then
    if sqlerrm <> 'offer_not_available' then raise; end if;
  end;
  perform public.b2b_offer_publish_v1(local_draft,2,owner_id,'fixture');
  perform set_config('test.user_id',other_id::text,true);
  if exists (select 1 from public.b2b_offer_customer_list_v1()) then raise exception 'foreign offer visible'; end if;
  perform set_config('test.user_id',customer_id::text,true);
  if (select count(*) from public.b2b_offer_customer_list_v1()) <> 1 then raise exception 'current offer missing'; end if;
  perform public.b2b_offer_decide_v1(local_draft,2,'accepted');
  perform public.b2b_offer_decide_v1(local_draft,2,'accepted');
  if (select count(*) from public.b2b_offer_contract_handoffs) <> 1 then raise exception 'handoff was not unique'; end if;
end $$;
