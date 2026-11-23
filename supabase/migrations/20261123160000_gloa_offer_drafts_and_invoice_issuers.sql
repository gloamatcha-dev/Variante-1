begin;

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

commit;
