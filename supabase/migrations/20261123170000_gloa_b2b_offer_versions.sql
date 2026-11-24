begin;

create table public.b2b_offer_versions (
  draft_id uuid not null references public.b2b_offer_drafts(id),
  version integer not null check (version > 0),
  pack_count integer not null check (pack_count between 1 and 100000),
  net_unit_cents integer not null check (net_unit_cents between 1 and 10000000),
  destination_country text not null check (destination_country ~ '^[A-Z]{2}$'),
  state text not null default 'draft'
    check (state in ('draft','published','superseded','accepted','declined')),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  published_at timestamptz,
  expires_at timestamptz,
  decided_at timestamptz,
  decided_by uuid,
  check ((published_at is null and expires_at is null) or
         (published_at is not null and expires_at = published_at + interval '336 hours'))
);

alter table public.b2b_offer_versions add primary key (draft_id, version);
create unique index b2b_offer_one_published_version on public.b2b_offer_versions(draft_id)
where state in ('published','accepted');
alter table public.b2b_offer_versions enable row level security;
revoke all on public.b2b_offer_versions from public, anon, authenticated, service_role;
grant select on public.b2b_offer_versions to service_role;

-- A revision carries its own terms. Existing drafts are left intact.
create function public.b2b_offer_revise_v1(
  p_draft uuid, p_expected integer, p_actor uuid, p_quantity integer, p_net integer
) returns integer language plpgsql security definer set search_path='' as $$
declare v_draft public.b2b_offer_drafts; v_latest integer;
begin
  if not exists (select 1 from public.admin_users
                 where user_id=p_actor and is_active and role in ('admin','owner')) then
    raise exception 'offer_forbidden' using errcode='42501';
  end if;
  perform public.require_creator_b2b_release_writes_v1();
  select * into v_draft from public.b2b_offer_drafts where id=p_draft for update;
  if not found then raise exception 'offer_not_found'; end if;
  select coalesce(max(version),0) into v_latest from public.b2b_offer_versions where draft_id=p_draft;
  if p_expected is distinct from v_latest then raise exception 'offer_revision_conflict'; end if;
  if exists (select 1 from public.b2b_offer_versions where draft_id=p_draft and state='accepted') then
    raise exception 'offer_already_accepted';
  end if;
  update public.b2b_offer_versions set state='superseded'
    where draft_id=p_draft and state in ('draft','published');
  insert into public.b2b_offer_versions
    (draft_id, version, pack_count, net_unit_cents, destination_country, created_by)
    values(p_draft,v_latest+1,p_quantity,p_net,v_draft.destination_country,p_actor);
  return v_latest+1;
end $$;

-- Release remains fail-closed until an authoritative tax/contract adapter
-- can confirm the terms. No role can publish a version by writing the table.
create function public.b2b_offer_decide_v1(p_draft uuid, p_version integer, p_action text)
returns text language plpgsql security definer set search_path='' as $$
declare v_customer uuid; v_offer public.b2b_offer_versions; v_now timestamptz;
begin
  if p_action is null or p_action not in ('accepted','declined') then
    raise exception 'offer_invalid_decision' using errcode='22023';
  end if;
  perform public.require_creator_b2b_release_writes_v1();
  select customer_id into v_customer from public.b2b_offer_drafts
    where id=p_draft and customer_id=auth.uid() for update;
  if not found then raise exception 'offer_forbidden' using errcode='42501'; end if;
  select * into v_offer from public.b2b_offer_versions where draft_id=p_draft and version=p_version;
  if not found then raise exception 'offer_not_available'; end if;
  if v_offer.state=p_action and v_offer.decided_by=v_customer then return v_offer.state; end if;
  v_now := clock_timestamp();
  if v_offer.state <> 'published' or v_offer.expires_at is null or v_offer.expires_at <= v_now then
    raise exception 'offer_not_available';
  end if;
  update public.b2b_offer_versions set state=p_action, decided_at=v_now, decided_by=v_customer
    where draft_id=p_draft and version=p_version;
  return p_action;
end $$;

revoke all on function public.b2b_offer_revise_v1(uuid,integer,uuid,integer,integer)
  from public, anon, authenticated, service_role;
grant execute on function public.b2b_offer_revise_v1(uuid,integer,uuid,integer,integer) to service_role;
revoke all on function public.b2b_offer_decide_v1(uuid,integer,text)
  from public, anon, authenticated, service_role;
grant execute on function public.b2b_offer_decide_v1(uuid,integer,text) to authenticated;

commit;
