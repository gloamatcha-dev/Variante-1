-- ============================================================
-- GLOA – B2B Recurring Supply Agreements
-- Run in Supabase SQL Editor AFTER 001 + 002 + 003 + 004 + 005
-- ============================================================

-- 1. B2B SUPPLY AGREEMENTS ────────────────────────────────────
create table public.b2b_supply_agreements (
  id                      uuid primary key default gen_random_uuid(),
  user_id                 uuid references auth.users(id) on delete set null,

  -- B2B only
  customer_type           text not null default 'business'
                          check (customer_type = 'business'),

  -- FK to existing offer models (serial = integer in 003)
  offer_model_id          integer references public.b2b_offer_models(id) on delete set null,

  status                  text not null default 'pending'
                          check (status in (
                            'pending', 'active', 'paused', 'cancelled', 'completed'
                          )),

  currency                text not null default 'EUR'
                          check (currency = 'EUR'),

  -- Snapshots (immutable after agreement creation)
  offer_model_snapshot    jsonb not null default '{}'::jsonb,
  business_snapshot       jsonb not null,
  customer_snapshot       jsonb not null,
  shipping_address_snapshot jsonb not null,
  billing_address_snapshot  jsonb not null,

  -- Money in integer cents (EUR)
  subtotal_net_cents      integer not null default 0 check (subtotal_net_cents >= 0),
  subtotal_gross_cents    integer not null default 0 check (subtotal_gross_cents >= 0),
  discount_total_cents    integer not null default 0 check (discount_total_cents >= 0),
  shipping_net_cents      integer not null default 0 check (shipping_net_cents >= 0),
  shipping_gross_cents    integer not null default 0 check (shipping_gross_cents >= 0),
  tax_total_cents         integer not null default 0 check (tax_total_cents >= 0),
  total_net_cents         integer not null default 0 check (total_net_cents >= 0),
  total_gross_cents       integer not null default 0 check (total_gross_cents >= 0),

  -- Intervals (nullable, no defaults, pairwise consistency)
  billing_interval_unit   text
                          check (billing_interval_unit is null or billing_interval_unit in ('day', 'week', 'month', 'year')),
  billing_interval_count  integer
                          check (billing_interval_count is null or billing_interval_count > 0),

  delivery_interval_unit  text
                          check (delivery_interval_unit is null or delivery_interval_unit in ('day', 'week', 'month', 'year')),
  delivery_interval_count integer
                          check (delivery_interval_count is null or delivery_interval_count > 0),

  -- Pairwise consistency
  check ((billing_interval_unit is null) = (billing_interval_count is null)),
  check ((delivery_interval_unit is null) = (delivery_interval_count is null)),

  -- Commitment (nullable, no default)
  commitment_months       integer
                          check (commitment_months is null or commitment_months > 0),

  -- Lifecycle
  started_at              timestamptz,
  commitment_end_at       timestamptz,
  next_delivery_at        timestamptz,
  ended_at                timestamptz,

  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

-- Indexes
create index idx_b2b_supply_user      on public.b2b_supply_agreements(user_id);
create index idx_b2b_supply_status    on public.b2b_supply_agreements(status);
create index idx_b2b_supply_delivery  on public.b2b_supply_agreements(next_delivery_at);
create index idx_b2b_supply_created   on public.b2b_supply_agreements(created_at);
create index idx_b2b_supply_model     on public.b2b_supply_agreements(offer_model_id);

-- Auto-update updated_at (reuse existing function from 001)
create trigger set_b2b_supply_updated_at
  before update on public.b2b_supply_agreements
  for each row execute function public.set_updated_at();

-- RLS
alter table public.b2b_supply_agreements enable row level security;

create policy "Business users read own supply agreements"
  on public.b2b_supply_agreements for select
  using (
    auth.uid() = user_id
    and public.is_business_user()
  );

-- No INSERT/UPDATE/DELETE policies for authenticated clients
-- Agreements will be created server-side

grant select on public.b2b_supply_agreements to authenticated;

-- 2. B2B SUPPLY ITEMS ─────────────────────────────────────────
create table public.b2b_supply_items (
  id                      uuid primary key default gen_random_uuid(),
  supply_agreement_id     uuid not null references public.b2b_supply_agreements(id) on delete cascade,

  -- FK to existing product sizes (serial = integer in 003)
  product_size_id         integer references public.b2b_product_sizes(id) on delete set null,

  product_reference       text,
  sku                     text,
  product_name            text not null,
  variant_name            text,

  grams                   integer check (grams is null or grams > 0),
  quantity                integer not null check (quantity > 0),

  -- Price snapshot fields
  base_unit_price_net_cents integer not null check (base_unit_price_net_cents >= 0),
  discount_percent        numeric(5,2)
                          check (discount_percent is null or (discount_percent >= 0 and discount_percent <= 100)),
  unit_price_net_cents    integer not null check (unit_price_net_cents >= 0),
  unit_price_gross_cents  integer not null check (unit_price_gross_cents >= 0),
  tax_rate_percent        numeric(5,2)
                          check (tax_rate_percent is null or (tax_rate_percent >= 0 and tax_rate_percent <= 100)),

  line_total_net_cents    integer not null check (line_total_net_cents >= 0),
  line_total_gross_cents  integer not null check (line_total_gross_cents >= 0),

  metadata                jsonb not null default '{}'::jsonb,

  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

-- Indexes
create index idx_b2b_supply_items_agreement on public.b2b_supply_items(supply_agreement_id);

-- Auto-update updated_at
create trigger set_b2b_supply_items_updated_at
  before update on public.b2b_supply_items
  for each row execute function public.set_updated_at();

-- RLS
alter table public.b2b_supply_items enable row level security;

create policy "Business users read own supply items"
  on public.b2b_supply_items for select
  using (
    exists (
      select 1 from public.b2b_supply_agreements
      where b2b_supply_agreements.id = b2b_supply_items.supply_agreement_id
        and b2b_supply_agreements.user_id = auth.uid()
    )
    and public.is_business_user()
  );

-- No INSERT/UPDATE/DELETE policies for authenticated clients

grant select on public.b2b_supply_items to authenticated;

-- No grants to anon
-- No write grants to authenticated
-- No seed data
