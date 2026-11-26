begin;

create function public.manual_b2b_verified_customers_v1(actor uuid,exact_email text default null)
returns table(user_id uuid,company_name text)
language plpgsql stable security definer set search_path='' as $$
begin
  if not exists(select 1 from public.admin_users where admin_users.user_id=actor and is_active and role='owner')
  then raise exception 'manual_b2b_forbidden' using errcode='42501'; end if;
  return query
    select business.user_id,business.company_name
    from public.business_profiles business
    join public.profiles profile on profile.user_id=business.user_id
    join auth.users account on account.id=business.user_id
    where profile.customer_type='business' and profile.terms_accepted_at is not null
      and profile.privacy_accepted_at is not null and business.authority_confirmed_at is not null
      and account.email_confirmed_at is not null and btrim(business.company_name)<>''
      and (exact_email is null or lower(account.email)=lower(btrim(exact_email)))
    order by business.company_name,business.user_id limit 501;
end;
$$;

create function public.guard_manual_b2b_verified_customer_v1() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if not exists(select 1 from public.business_profiles business
    join public.profiles profile on profile.user_id=business.user_id
    join auth.users account on account.id=business.user_id
    where business.user_id=(new.manual_b2b->>'customer')::uuid
      and profile.customer_type='business' and profile.terms_accepted_at is not null
      and profile.privacy_accepted_at is not null and business.authority_confirmed_at is not null
      and account.email_confirmed_at is not null and btrim(business.company_name)<>'')
  then raise exception 'manual_b2b_customer_unverified'; end if;
  return new;
end;
$$;
create trigger manual_b2b_verified_customer before insert on public.orders
  for each row when(new.manual_b2b is not null) execute function public.guard_manual_b2b_verified_customer_v1();

-- A reference answers where the commercial terms are maintained. It never creates
-- an order, claims a checkout, copies installments or changes a contract.
alter table public.orders add column manual_b2b_offer_id uuid, add column manual_b2b_offer_version int,
  add constraint orders_manual_offer_pair check (
    num_nonnulls(manual_b2b_offer_id,manual_b2b_offer_version)=0 or
    (manual_b2b is not null and num_nonnulls(manual_b2b_offer_id,manual_b2b_offer_version)=2)),
  add constraint orders_manual_offer_reference foreign key(manual_b2b_offer_id,manual_b2b_offer_version)
    references public.b2b_offer_contract_handoffs(draft_id,version);
create unique index orders_manual_offer_reference_once on public.orders(manual_b2b_offer_id,manual_b2b_offer_version)
  where manual_b2b_offer_id is not null;

create function public.manual_b2b_offer_context_v1(actor uuid,target uuid,draft uuid default null,revision int default null)
returns table(offer_id uuid,offer_version int,terms jsonb,checkout_claimed boolean,agreement_id uuid,
  contract_status text,started_at timestamptz,ended_at timestamptz,linked boolean)
language plpgsql security definer set search_path='' as $$
declare sale public.orders;
begin
  if not exists(select 1 from public.admin_users where user_id=actor and is_active and role='owner')
  then raise exception 'manual_b2b_forbidden' using errcode='42501'; end if;
  if num_nonnulls(draft,revision)=1 then raise exception 'manual_b2b_offer_invalid'; end if;
  if draft is not null then
    perform public.require_creator_b2b_release_writes_v1();
    select * into strict sale from public.orders where id=target and manual_b2b is not null for update;
    if sale.status='cancelled' then raise exception 'manual_b2b_offer_invalid'; end if;
    if sale.manual_b2b_offer_id is not null and
      (sale.manual_b2b_offer_id,sale.manual_b2b_offer_version) is distinct from (draft,revision)
    then raise exception 'manual_b2b_offer_reference_frozen'; end if;
    if not exists(select 1 from public.b2b_offer_contract_handoffs h
      join public.b2b_offer_versions v using(draft_id,version)
      join public.b2b_offer_drafts d on d.id=h.draft_id
      where h.draft_id=draft and h.version=revision and v.state='accepted' and h.contract_terms is not null
        and d.customer_id=(sale.manual_b2b->>'customer')::uuid and v.decided_by=d.customer_id)
    then raise exception 'manual_b2b_offer_invalid'; end if;
    if sale.manual_b2b_offer_id is null then
      update public.orders set manual_b2b_offer_id=draft,manual_b2b_offer_version=revision where id=target;
      perform public.record_admin_activity(actor,'b2b','manual_order_offer_referenced','order',target::text,
        'Context reference only; no contract or checkout changed',gen_random_uuid(),jsonb_build_object('draft',draft,'version',revision));
    end if;
  end if;
  return query select h.draft_id,h.version,h.contract_terms,l.request_id is not null,c.id,c.status,c.started_at,c.ended_at,
       coalesce(o.manual_b2b_offer_id=h.draft_id and o.manual_b2b_offer_version=h.version,false)
    from public.orders o
    join public.b2b_offer_drafts d on d.customer_id=(o.manual_b2b->>'customer')::uuid
    join public.b2b_offer_contract_handoffs h on h.draft_id=d.id
    join public.b2b_offer_versions v on v.draft_id=h.draft_id and v.version=h.version and v.decided_by=d.customer_id and v.state='accepted'
    left join public.b2b_offer_checkout_links l on l.draft_id=h.draft_id and l.version=h.version
    left join public.checkout_attempts a on a.request_id=l.request_id and a.user_id=d.customer_id
    left join public.b2b_supply_agreements c on c.checkout_attempt_id=a.id and c.user_id=d.customer_id
    where o.id=target and o.manual_b2b is not null and h.contract_terms is not null
    order by (o.manual_b2b_offer_id=h.draft_id and o.manual_b2b_offer_version=h.version) desc nulls last,h.draft_id,h.version limit 101;
end;
$$;

revoke all on function public.manual_b2b_verified_customers_v1(uuid,text),
  public.guard_manual_b2b_verified_customer_v1(),public.manual_b2b_offer_context_v1(uuid,uuid,uuid,int)
  from public,anon,authenticated,service_role;
grant execute on function public.manual_b2b_verified_customers_v1(uuid,text),
  public.manual_b2b_offer_context_v1(uuid,uuid,uuid,int) to service_role;
commit;
