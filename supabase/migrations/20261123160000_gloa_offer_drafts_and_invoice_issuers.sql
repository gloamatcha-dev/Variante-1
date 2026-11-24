begin;

-- This reserved operations_config key is administered only over the postgres SQL path.
-- Application-controlled operations_config keys retain their existing behavior.
create function public.guard_creator_b2b_release_config_v1() returns trigger
language plpgsql set search_path='' as $$
begin
  if current_user <> 'postgres' and (
    (tg_op <> 'INSERT' and old.key = 'creator_b2b_release_writes_enabled') or
    (tg_op <> 'DELETE' and new.key = 'creator_b2b_release_writes_enabled')
  ) then
    raise exception 'release_config_reserved' using errcode='42501';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
revoke all on function public.guard_creator_b2b_release_config_v1() from public,anon,authenticated,service_role;
create trigger creator_b2b_release_config_reserved before insert or update or delete
on public.operations_config for each row execute function public.guard_creator_b2b_release_config_v1();

-- A collision aborts the migration instead of inheriting an existing value.
insert into public.operations_config(key,int_value) values('creator_b2b_release_writes_enabled',0);

create function public.require_creator_b2b_release_writes_v1() returns void
language plpgsql security definer set search_path='' as $$
begin
  -- Serialize explicit disable with granted writes that are still in flight.
  perform 1 from public.operations_config
    where key='creator_b2b_release_writes_enabled' and int_value=1 for share;
  if not found then
    raise exception 'release_writes_disabled' using errcode='55000';
  end if;
end $$;
revoke all on function public.require_creator_b2b_release_writes_v1() from public,anon,authenticated,service_role;

create function public.guard_creator_b2b_release_write_v1() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  perform public.require_creator_b2b_release_writes_v1();
  return new;
end $$;
revoke all on function public.guard_creator_b2b_release_write_v1() from public,anon,authenticated,service_role;

-- New configuration only. No issuer is seeded or approved by this migration.
create table public.invoice_issuer_versions (
  version bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  effective_from timestamptz not null unique,
  legal_name text not null check (length(btrim(legal_name)) between 1 and 250),
  street_address text not null check (length(btrim(street_address)) between 1 and 250),
  postal_code text not null check (length(btrim(postal_code)) between 1 and 30),
  city text not null check (length(btrim(city)) between 1 and 150),
  country_code text not null check (country_code ~ '^[A-Z]{2}$'),
  tax_number text,
  vat_id text,
  approved_by uuid not null,
  check (coalesce(length(btrim(tax_number)), 0) > 0 or coalesce(length(btrim(vat_id)), 0) > 0)
);

alter table public.invoice_issuer_versions enable row level security;
revoke all on public.invoice_issuer_versions from public, anon, authenticated, service_role;
grant select on public.invoice_issuer_versions to service_role;

-- Drafts are internal and have no path to checkout or payment. Each ID
-- represents one immutable draft, so retries cannot overwrite its terms.
create table public.b2b_offer_drafts (
  id uuid primary key,
  customer_id uuid not null references public.business_profiles(user_id),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  inquiry_reference text not null check (length(btrim(inquiry_reference)) between 1 and 200),
  destination_country text not null check (destination_country ~ '^[A-Z]{2}$'),
  valid_days smallint not null default 14 check (valid_days = 14),
  currency text not null default 'EUR' check (currency = 'EUR'),
  pack_count integer not null check (pack_count between 1 and 100000),
  net_unit_cents integer not null check (net_unit_cents between 1 and 10000000)
);

alter table public.b2b_offer_drafts enable row level security;
revoke all on public.b2b_offer_drafts from public, anon, authenticated, service_role;
grant select, insert on public.b2b_offer_drafts to service_role;
create trigger b2b_offer_draft_release_required before insert on public.b2b_offer_drafts
  for each row execute function public.guard_creator_b2b_release_write_v1();

commit;
