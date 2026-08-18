-- ============================================================
-- GLOA – B2C Subscriptions Foundation
-- Run in Supabase SQL Editor AFTER 001 + 002 + 003 + 004
-- ============================================================

-- 1. SUBSCRIPTION PLANS TABLE ─────────────────────────────────
create table public.b2c_subscription_plans (
  id                  uuid primary key default gen_random_uuid(),
  slug                text not null unique,
  name                text not null,
  description         text,

  discount_percent    numeric(5,2) not null default 0
                      check (discount_percent >= 0 and discount_percent <= 100),

  commitment_months   integer not null default 0
                      check (commitment_months >= 0),

  billing_interval    text not null default 'monthly'
                      check (billing_interval in ('monthly', 'bimonthly', 'quarterly', 'semiannual', 'annual')),

  delivery_interval   text not null default 'monthly'
                      check (delivery_interval in ('weekly', 'biweekly', 'monthly', 'bimonthly', 'quarterly')),

  is_active           boolean not null default true,
  sort_order          integer not null default 0,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index idx_b2c_plans_active on public.b2c_subscription_plans(is_active);

create trigger set_b2c_plans_updated_at
  before update on public.b2c_subscription_plans
  for each row execute function public.set_updated_at();

-- RLS: authenticated private users can read active plans
alter table public.b2c_subscription_plans enable row level security;

create policy "Authenticated users read active plans"
  on public.b2c_subscription_plans for select
  using (is_active = true);

grant select on public.b2c_subscription_plans to authenticated;

-- NO seed data – plans, prices, intervals are not yet confirmed

-- 2. SUBSCRIPTIONS TABLE ──────────────────────────────────────
create table public.subscriptions (
  id                      uuid primary key default gen_random_uuid(),
  user_id                 uuid references auth.users(id) on delete set null,

  -- B2C only: private customers
  customer_type           text not null default 'private'
                          check (customer_type = 'private'),

  plan_id                 uuid references public.b2c_subscription_plans(id) on delete set null,

  status                  text not null default 'pending'
                          check (status in (
                            'pending', 'active', 'paused', 'cancelled'
                          )),

  currency                text not null default 'EUR'
                          check (currency = 'EUR'),

  -- Snapshots (immutable after subscription creation)
  customer_snapshot       jsonb not null,
  shipping_address_snapshot jsonb not null,
  billing_address_snapshot  jsonb not null,
  plan_snapshot            jsonb not null,

  -- Money in integer cents (EUR)
  subtotal_net_cents      integer not null default 0 check (subtotal_net_cents >= 0),
  subtotal_gross_cents    integer not null default 0 check (subtotal_gross_cents >= 0),
  discount_total_cents    integer not null default 0 check (discount_total_cents >= 0),
  shipping_net_cents      integer not null default 0 check (shipping_net_cents >= 0),
  shipping_gross_cents    integer not null default 0 check (shipping_gross_cents >= 0),
  tax_total_cents         integer not null default 0 check (tax_total_cents >= 0),
  total_net_cents         integer not null default 0 check (total_net_cents >= 0),
  total_gross_cents       integer not null default 0 check (total_gross_cents >= 0),

  -- Period & delivery
  current_period_start    timestamptz,
  current_period_end      timestamptz,
  next_delivery_at        timestamptz,

  -- Lifecycle
  started_at              timestamptz,
  paused_at               timestamptz,
  cancelled_at            timestamptz,
  cancel_at_period_end    boolean not null default false,

  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

-- Indexes
create index idx_subscriptions_user     on public.subscriptions(user_id);
create index idx_subscriptions_status   on public.subscriptions(status);
create index idx_subscriptions_delivery on public.subscriptions(next_delivery_at);

-- Auto-update updated_at
create trigger set_subscriptions_updated_at
  before update on public.subscriptions
  for each row execute function public.set_updated_at();

-- RLS: own-user SELECT only
alter table public.subscriptions enable row level security;

create policy "Users read own subscriptions"
  on public.subscriptions for select
  using (auth.uid() = user_id);

-- No INSERT/UPDATE/DELETE policies for authenticated clients
-- Subscriptions will be created server-side

grant select on public.subscriptions to authenticated;

-- 3. SUBSCRIPTION ITEMS TABLE ─────────────────────────────────
create table public.subscription_items (
  id                      uuid primary key default gen_random_uuid(),
  subscription_id         uuid not null references public.subscriptions(id) on delete cascade,

  product_reference       text,
  sku                     text,
  product_name            text not null,
  variant_name            text,

  quantity                integer not null check (quantity > 0),

  unit_price_net_cents    integer not null check (unit_price_net_cents >= 0),
  unit_price_gross_cents  integer not null check (unit_price_gross_cents >= 0),
  tax_rate_percent        numeric(5,2),

  line_total_net_cents    integer not null check (line_total_net_cents >= 0),
  line_total_gross_cents  integer not null check (line_total_gross_cents >= 0),

  metadata                jsonb not null default '{}'::jsonb,

  created_at              timestamptz not null default now()
);

-- Indexes
create index idx_sub_items_subscription on public.subscription_items(subscription_id);

-- RLS: only if the parent subscription belongs to the user
alter table public.subscription_items enable row level security;

create policy "Users read own subscription items"
  on public.subscription_items for select
  using (
    exists (
      select 1 from public.subscriptions
      where subscriptions.id = subscription_items.subscription_id
        and subscriptions.user_id = auth.uid()
    )
  );

grant select on public.subscription_items to authenticated;

-- No grants to anon
-- No write grants to authenticated
