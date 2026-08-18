-- ============================================================
-- GLOA – B2B Pricing: offer models, product sizes, general terms
-- Run in Supabase SQL Editor AFTER 001 + 002
-- ============================================================

-- 0. HELPER: is current user a business customer?
create or replace function public.is_business_user()
returns boolean
language sql
stable
security definer set search_path = ''
as $$
  select exists (
    select 1 from public.profiles
    where user_id = auth.uid()
      and customer_type = 'business'
  );
$$;

-- 1. OFFER MODELS ──────────────────────────────────────────────
create table public.b2b_offer_models (
  id           serial primary key,
  slug         text not null unique,
  label        text not null,
  discount_pct numeric(5,2) not null default 0,
  description  text,
  sort_order   int not null default 0
);

alter table public.b2b_offer_models enable row level security;

create policy "Business users can read offer models"
  on public.b2b_offer_models for select
  using (public.is_business_user());

-- No insert/update/delete for anyone via API

grant select on public.b2b_offer_models to authenticated;

-- Seed
insert into public.b2b_offer_models (slug, label, discount_pct, description, sort_order) values
  ('single',    'Einzelbestellung',         0,  'Kein Mindestabnahme-Zeitraum. Bestelle, wenn du Matcha brauchst.', 1),
  ('recurring', 'Regelmäßige Belieferung',  5,  'Festes Lieferintervall nach Absprache. 5 % Rabatt auf den Basispreis.', 2),
  ('annual',    '12-Monats-Partnerschaft', 10,  'Jahresvereinbarung mit garantiertem Preis. 10 % Rabatt auf den Basispreis.', 3);

-- 2. PRODUCT SIZES ─────────────────────────────────────────────
create table public.b2b_product_sizes (
  id              serial primary key,
  grams           int not null,
  label           text not null,
  price_per_kg_net numeric(8,2) not null,
  sort_order      int not null default 0
);

alter table public.b2b_product_sizes enable row level security;

create policy "Business users can read product sizes"
  on public.b2b_product_sizes for select
  using (public.is_business_user());

grant select on public.b2b_product_sizes to authenticated;

-- Seed: 125.00 €/kg net base price
insert into public.b2b_product_sizes (grams, label, price_per_kg_net, sort_order) values
  (250,  '250 g', 125.00, 1),
  (500,  '500 g', 125.00, 2);

-- 3. GENERAL TERMS ─────────────────────────────────────────────
create table public.b2b_general_terms (
  id         serial primary key,
  key        text not null unique,
  label      text not null,
  value      text not null,
  sort_order int not null default 0
);

alter table public.b2b_general_terms enable row level security;

create policy "Business users can read general terms"
  on public.b2b_general_terms for select
  using (public.is_business_user());

grant select on public.b2b_general_terms to authenticated;

-- No seed data – terms will be added once confirmed
