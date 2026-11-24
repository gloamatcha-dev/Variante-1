begin;
create table public.b2b_offer_checkout_links (
  draft_id uuid not null,
  version integer not null,
  request_id uuid not null unique default gen_random_uuid(),
  address_id uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (draft_id, version),
  foreign key (draft_id, version) references public.b2b_offer_contract_handoffs(draft_id, version)
);
alter table public.b2b_offer_checkout_links enable row level security;
revoke all on public.b2b_offer_checkout_links from public,anon,authenticated,service_role;
grant select on public.b2b_offer_checkout_links to service_role;

-- A NULL address reads the already accepted offer; a supplied address claims
-- exactly one existing-checkout request key. This never creates a payment.
create function public.b2b_offer_checkout_context_v1(p_draft uuid,p_version integer,p_customer uuid,p_address uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare terms jsonb; link public.b2b_offer_checkout_links;
begin
  if p_address is not null then perform public.require_creator_b2b_release_writes_v1(); end if;
  perform 1 from public.b2b_offer_drafts where id=p_draft and customer_id=p_customer for update;
  if not found then return null; end if;
  select h.contract_terms into terms from public.b2b_offer_contract_handoffs h
    join public.b2b_offer_versions v using(draft_id,version)
    where h.draft_id=p_draft and h.version=p_version and v.state='accepted'
      and v.decided_by=p_customer and v.destination_country='DE' and v.tax_region='DE'
      and v.reviewed_by is not null and v.tax_evidence_reference is not null;
  if not found or terms is null then return null; end if;
  if p_address is null then return jsonb_build_object('terms',terms); end if;
  perform 1 from public.addresses where id=p_address and user_id=p_customer;
  if not found then return null; end if;
  insert into public.b2b_offer_checkout_links(draft_id,version,address_id)
    values(p_draft,p_version,p_address) on conflict (draft_id,version) do nothing;
  select * into link from public.b2b_offer_checkout_links where draft_id=p_draft and version=p_version;
  if link.address_id<>p_address then return jsonb_build_object('addressConflict',true); end if;
  return jsonb_build_object('terms',terms,'requestId',link.request_id,'createdAt',link.created_at);
end $$;

revoke all on function public.b2b_offer_checkout_context_v1(uuid,integer,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.b2b_offer_checkout_context_v1(uuid,integer,uuid,uuid) to service_role;
commit;
