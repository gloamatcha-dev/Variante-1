-- ============================================================
-- GLOA – Customer Accounts: profiles, business_profiles, addresses
-- Run in Supabase SQL Editor (or via supabase db push)
-- ============================================================

-- 1. PROFILES ─────────────────────────────────────────────────
create table public.profiles (
  user_id       uuid primary key references auth.users(id) on delete cascade,
  customer_type text not null default 'private' check (customer_type in ('private','business')),
  first_name    text not null default '',
  last_name     text not null default '',
  phone         text,
  newsletter_opt_in boolean not null default false,
  terms_accepted_at  timestamptz,
  privacy_accepted_at timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "Users read own profile"
  on public.profiles for select
  using (auth.uid() = user_id);

create policy "Users update own profile"
  on public.profiles for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- No direct insert/delete by users – trigger handles insert

-- 2. BUSINESS_PROFILES ────────────────────────────────────────
create table public.business_profiles (
  user_id       uuid primary key references auth.users(id) on delete cascade,
  company_name  text not null default '',
  legal_form    text,
  tax_number    text not null default '',
  vat_id        text,
  website       text,
  authority_confirmed_at timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

alter table public.business_profiles enable row level security;

create policy "Users read own business profile"
  on public.business_profiles for select
  using (auth.uid() = user_id);

create policy "Users update own business profile"
  on public.business_profiles for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- 3. ADDRESSES ────────────────────────────────────────────────
create table public.addresses (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users(id) on delete cascade,
  first_name          text not null default '',
  last_name           text not null default '',
  company             text,
  street              text not null default '',
  house_number        text not null default '',
  zip                 text not null default '',
  city                text not null default '',
  country             text not null default 'Deutschland',
  is_default_shipping boolean not null default false,
  is_default_billing  boolean not null default false,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index idx_addresses_user on public.addresses(user_id);

-- Partial unique: max one default shipping per user
create unique index idx_addresses_default_shipping
  on public.addresses(user_id)
  where is_default_shipping = true;

-- Partial unique: max one default billing per user
create unique index idx_addresses_default_billing
  on public.addresses(user_id)
  where is_default_billing = true;

alter table public.addresses enable row level security;

create policy "Users read own addresses"
  on public.addresses for select
  using (auth.uid() = user_id);

create policy "Users insert own addresses"
  on public.addresses for insert
  with check (auth.uid() = user_id);

create policy "Users update own addresses"
  on public.addresses for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Users delete own addresses"
  on public.addresses for delete
  using (auth.uid() = user_id);

-- 4. TRIGGERS ─────────────────────────────────────────────────

-- 4a. Auto-create profile + optional business_profile on signup
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
declare
  _type text;
begin
  _type := coalesce(new.raw_user_meta_data->>'customer_type', 'private');
  if _type not in ('private','business') then _type := 'private'; end if;

  insert into public.profiles (
    user_id, customer_type,
    first_name, last_name, phone,
    newsletter_opt_in,
    terms_accepted_at, privacy_accepted_at
  ) values (
    new.id, _type,
    coalesce(new.raw_user_meta_data->>'first_name', ''),
    coalesce(new.raw_user_meta_data->>'last_name', ''),
    new.raw_user_meta_data->>'phone',
    coalesce((new.raw_user_meta_data->>'newsletter')::boolean, false),
    case when (new.raw_user_meta_data->>'accept_terms')::boolean then now() end,
    case when (new.raw_user_meta_data->>'accept_terms')::boolean then now() end
  );

  -- Business: create business_profile + first address
  if _type = 'business' then
    insert into public.business_profiles (
      user_id, company_name, legal_form, tax_number, vat_id, website,
      authority_confirmed_at
    ) values (
      new.id,
      coalesce(new.raw_user_meta_data->>'company_name', ''),
      new.raw_user_meta_data->>'legal_form',
      coalesce(new.raw_user_meta_data->>'tax_number', ''),
      new.raw_user_meta_data->>'vat_id',
      new.raw_user_meta_data->>'website',
      case when (new.raw_user_meta_data->>'confirm_company_auth')::boolean then now() end
    );
  end if;

  -- First address (both shipping + billing default)
  if coalesce(new.raw_user_meta_data->>'street', '') <> '' then
    insert into public.addresses (
      user_id, first_name, last_name, company,
      street, house_number, zip, city, country,
      is_default_shipping, is_default_billing
    ) values (
      new.id,
      coalesce(new.raw_user_meta_data->>'first_name', new.raw_user_meta_data->>'contact_first_name', ''),
      coalesce(new.raw_user_meta_data->>'last_name', new.raw_user_meta_data->>'contact_last_name', ''),
      new.raw_user_meta_data->>'company_name',
      new.raw_user_meta_data->>'street',
      coalesce(new.raw_user_meta_data->>'house_number', ''),
      coalesce(new.raw_user_meta_data->>'zip', ''),
      coalesce(new.raw_user_meta_data->>'city', ''),
      coalesce(new.raw_user_meta_data->>'country', 'Deutschland'),
      true, true
    );
  end if;

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 4b. Prevent customer_type change
create or replace function public.prevent_customer_type_change()
returns trigger
language plpgsql
as $$
begin
  if old.customer_type <> new.customer_type then
    raise exception 'customer_type cannot be changed';
  end if;
  return new;
end;
$$;

create trigger protect_customer_type
  before update on public.profiles
  for each row execute function public.prevent_customer_type_change();

-- 4c. Clear old default when setting new default address
create or replace function public.handle_default_address()
returns trigger
language plpgsql
as $$
begin
  if new.is_default_shipping = true then
    update public.addresses
      set is_default_shipping = false
      where user_id = new.user_id
        and id <> new.id
        and is_default_shipping = true;
  end if;
  if new.is_default_billing = true then
    update public.addresses
      set is_default_billing = false
      where user_id = new.user_id
        and id <> new.id
        and is_default_billing = true;
  end if;
  return new;
end;
$$;

create trigger before_address_upsert
  before insert or update on public.addresses
  for each row execute function public.handle_default_address();

-- 4d. Auto-update updated_at
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger set_profiles_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

create trigger set_business_profiles_updated_at
  before update on public.business_profiles
  for each row execute function public.set_updated_at();

create trigger set_addresses_updated_at
  before update on public.addresses
  for each row execute function public.set_updated_at();
