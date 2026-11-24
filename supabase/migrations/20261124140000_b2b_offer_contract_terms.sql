begin;
create table public.b2b_offer_contract_terms (
  draft_id uuid not null,
  version integer not null,
  terms jsonb not null check (jsonb_typeof(terms)='object'),
  primary key(draft_id,version),
  foreign key(draft_id,version) references public.b2b_offer_versions(draft_id,version)
);
alter table public.b2b_offer_contract_terms enable row level security;
revoke all on public.b2b_offer_contract_terms from public,anon,authenticated,service_role;
grant select on public.b2b_offer_contract_terms to service_role;
alter table public.b2b_offer_contract_handoffs add column contract_terms jsonb;

create table public.b2b_offer_notifications (
  draft_id uuid not null,
  version integer not null,
  status text not null default 'pending' check (status in ('pending','sending','sent')),
  primary key(draft_id,version),
  foreign key(draft_id,version) references public.b2b_offer_versions(draft_id,version)
);
alter table public.b2b_offer_notifications enable row level security;
revoke all on public.b2b_offer_notifications from public,anon,authenticated,service_role;
grant select,update(status) on public.b2b_offer_notifications to service_role;
create trigger b2b_offer_notification_release_required before update of status on public.b2b_offer_notifications
  for each row execute function public.guard_creator_b2b_release_write_v1();

create function public.b2b_offer_publish_with_terms_v1(
  p_draft uuid,p_version integer,p_actor uuid,p_evidence text,p_terms jsonb
) returns timestamptz language plpgsql security definer set search_path='' as $$
declare v_offer public.b2b_offer_versions; v_expiry timestamptz; v_terms jsonb;
begin
  perform public.require_creator_b2b_release_writes_v1();
  perform 1 from public.b2b_offer_drafts where id=p_draft for update;
  select * into v_offer from public.b2b_offer_versions where draft_id=p_draft and version=p_version;
  if not found then raise exception 'offer_not_available'; end if;
  if jsonb_typeof(p_terms) is distinct from 'object' or
      p_terms->>'packs' is distinct from v_offer.pack_count::text or
      p_terms->>'packNetCents' is distinct from v_offer.net_unit_cents::text or
      p_terms->>'country' is distinct from v_offer.destination_country or
      coalesce(p_terms->>'planType','') not in ('monthly','annual') or
      coalesce(p_terms->>'postcode','') !~ '^[0-9]{5}$' or
      p_terms->>'deliveryIntervalMonths' is distinct from '1' or
      jsonb_typeof(p_terms->'shippingGrossCents') is distinct from 'number' or
      jsonb_typeof(p_terms->'pricing') is distinct from 'object' or
      jsonb_typeof(p_terms->'charges') is distinct from 'array' then
    raise exception 'offer_contract_terms_mismatch';
  end if;
  if (p_terms->>'planType'='monthly' and
        (p_terms->>'instalmentCount' is not null or jsonb_array_length(p_terms->'charges')<>1)) or
      (p_terms->>'planType'='annual' and
        (coalesce(p_terms->>'instalmentCount','') not in ('1','2','4') or
         p_terms->>'instalmentCount' is distinct from jsonb_array_length(p_terms->'charges')::text)) or
      exists (select 1 from jsonb_array_elements(p_terms->'charges') c
        where jsonb_typeof(c->'netCents') is distinct from 'number'
          or jsonb_typeof(c->'taxCents') is distinct from 'number'
          or jsonb_typeof(c->'grossCents') is distinct from 'number') then
    raise exception 'offer_contract_terms_mismatch';
  end if;
  select terms into v_terms from public.b2b_offer_contract_terms where draft_id=p_draft and version=p_version;
  if found and v_terms is distinct from p_terms then raise exception 'offer_contract_terms_mismatch'; end if;
  v_expiry := public.b2b_offer_publish_v1(p_draft,p_version,p_actor,p_evidence);
  insert into public.b2b_offer_contract_terms values(p_draft,p_version,p_terms) on conflict do nothing;
  insert into public.b2b_offer_notifications(draft_id,version) values(p_draft,p_version) on conflict do nothing;
  return v_expiry;
end $$;

create or replace function public.b2b_offer_capture_contract_handoff() returns trigger
language plpgsql security definer set search_path='' as $$
declare v_terms jsonb;
begin
  if new.tax_region is distinct from 'DE' or new.reviewed_by is null or new.tax_evidence_reference is null then
    raise exception 'offer_tax_review_required';
  end if;
  select terms into v_terms from public.b2b_offer_contract_terms where draft_id=new.draft_id and version=new.version;
  if not found then raise exception 'offer_contract_terms_missing'; end if;
  insert into public.b2b_offer_contract_handoffs(draft_id,version,contract_terms)
    values(new.draft_id,new.version,v_terms) on conflict do nothing;
  return new;
end $$;

-- Keep the existing customer access grant while adding the public contract terms.
drop function public.b2b_offer_customer_list_v1();
create function public.b2b_offer_customer_list_v1()
returns table(draft_id uuid,version integer,pack_count integer,net_unit_cents integer,
  destination_country text,state text,expires_at timestamptz,contract_terms jsonb)
language sql stable security definer set search_path='' as $$
  select v.draft_id,v.version,v.pack_count,v.net_unit_cents,v.destination_country,
    case when v.state='published' and v.expires_at <= now() then 'expired' else v.state end,
    v.expires_at,t.terms
  from public.b2b_offer_drafts d join public.b2b_offer_versions v on v.draft_id=d.id
  left join public.b2b_offer_contract_terms t on t.draft_id=v.draft_id and t.version=v.version
  where d.customer_id=auth.uid() and v.state in ('published','accepted','declined')
  order by v.published_at desc limit 100
$$;

create function public.claim_b2b_offer_notification_v1(p_draft uuid,p_version integer)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_customer uuid;
begin
  perform public.require_creator_b2b_release_writes_v1();
  select customer_id into v_customer from public.b2b_offer_drafts where id=p_draft for update;
  if not exists (select 1 from public.b2b_offer_versions where draft_id=p_draft and version=p_version
      and state='published' and expires_at>clock_timestamp()) then return null; end if;
  update public.b2b_offer_notifications set status='sending'
    where draft_id=p_draft and version=p_version and status='pending';
  if not found then return null; end if;
  return v_customer;
end $$;

revoke all on function public.b2b_offer_publish_v1(uuid,integer,uuid,text) from service_role;
revoke all on function public.b2b_offer_publish_with_terms_v1(uuid,integer,uuid,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.b2b_offer_publish_with_terms_v1(uuid,integer,uuid,text,jsonb) to service_role;
revoke all on function public.b2b_offer_customer_list_v1() from public,anon,authenticated,service_role;
grant execute on function public.b2b_offer_customer_list_v1() to authenticated;
revoke all on function public.claim_b2b_offer_notification_v1(uuid,integer) from public,anon,authenticated,service_role;
grant execute on function public.claim_b2b_offer_notification_v1(uuid,integer) to service_role;
commit;
