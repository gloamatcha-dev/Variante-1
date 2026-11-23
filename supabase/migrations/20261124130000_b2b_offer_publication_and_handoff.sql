begin;
alter table public.b2b_offer_versions
  add column tax_region text check (tax_region in ('DE','EU','NON_EU')),
  add column tax_evidence_reference text check (length(btrim(tax_evidence_reference)) between 1 and 200),
  add column reviewed_by uuid;

create table public.b2b_offer_contract_handoffs (
  draft_id uuid not null,
  version integer not null,
  requested_at timestamptz not null default now(),
  primary key (draft_id,version),
  foreign key (draft_id,version) references public.b2b_offer_versions(draft_id,version)
);
alter table public.b2b_offer_contract_handoffs enable row level security;
revoke all on public.b2b_offer_contract_handoffs from public, anon, authenticated, service_role;
grant select on public.b2b_offer_contract_handoffs to service_role;

create function public.b2b_offer_publish_v1(p_draft uuid,p_version integer,p_actor uuid,p_evidence text)
returns timestamptz language plpgsql security definer set search_path='' as $$
declare v_offer public.b2b_offer_versions; v_now timestamptz;
begin
  if not exists (select 1 from public.admin_users where user_id=p_actor and is_active and role='owner') then
    raise exception 'offer_forbidden' using errcode='42501';
  end if;
  perform 1 from public.b2b_offer_drafts where id=p_draft for update;
  select * into v_offer from public.b2b_offer_versions where draft_id=p_draft and version=p_version;
  if not found then raise exception 'offer_not_available'; end if;
  if v_offer.state='published' and v_offer.tax_evidence_reference=btrim(p_evidence) then
    return v_offer.expires_at;
  end if;
  if v_offer.state <> 'draft' then raise exception 'offer_not_available'; end if;
  if v_offer.destination_country <> 'DE' or p_evidence is null or length(btrim(p_evidence)) not between 1 and 200 then
    raise exception 'offer_tax_review_required';
  end if;
  v_now := clock_timestamp();
  update public.b2b_offer_versions set state='published', published_at=v_now,
    expires_at=v_now + interval '336 hours', tax_region='DE',
    tax_evidence_reference=btrim(p_evidence), reviewed_by=p_actor
    where draft_id=p_draft and version=p_version;
  return v_now + interval '336 hours';
end $$;

create function public.b2b_offer_customer_list_v1()
returns table(draft_id uuid,version integer,pack_count integer,net_unit_cents integer,
  destination_country text,state text,expires_at timestamptz)
language sql stable security definer set search_path='' as $$
  select v.draft_id,v.version,v.pack_count,v.net_unit_cents,v.destination_country,
    case when v.state='published' and v.expires_at <= now() then 'expired' else v.state end, v.expires_at
  from public.b2b_offer_drafts d join public.b2b_offer_versions v on v.draft_id=d.id
  where d.customer_id=auth.uid() and v.state in ('published','accepted','declined')
  order by v.published_at desc limit 100
$$;

-- Existing decision RPC still provides authentication, version and expiry checks.
-- The handoff is part of that transaction and cannot create a payable agreement.
create function public.b2b_offer_capture_contract_handoff() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if new.tax_region is distinct from 'DE' or new.reviewed_by is null or new.tax_evidence_reference is null then
    raise exception 'offer_tax_review_required';
  end if;
  insert into public.b2b_offer_contract_handoffs(draft_id,version) values(new.draft_id,new.version)
    on conflict do nothing;
  return new;
end $$;
create trigger b2b_offer_capture_contract_handoff
after update of state on public.b2b_offer_versions
for each row when (old.state is distinct from new.state and new.state='accepted')
execute function public.b2b_offer_capture_contract_handoff();

revoke all on function public.b2b_offer_publish_v1(uuid,integer,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.b2b_offer_publish_v1(uuid,integer,uuid,text) to service_role;
revoke all on function public.b2b_offer_customer_list_v1() from public,anon,authenticated,service_role;
grant execute on function public.b2b_offer_customer_list_v1() to authenticated;
revoke all on function public.b2b_offer_capture_contract_handoff() from public,anon,authenticated,service_role;
commit;
