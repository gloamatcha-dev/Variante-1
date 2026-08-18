-- ============================================================
-- GLOA – Orders & Order Items
-- Run in Supabase SQL Editor AFTER 001 + 002 + 003
-- ============================================================

-- 1. ORDER NUMBER SEQUENCE ─────────────────────────────────────
create sequence public.order_number_seq start with 1 increment by 1;

create or replace function public.generate_order_number()
returns text
language sql
volatile
security definer set search_path = ''
as $$
  select 'GLOA-' || to_char(current_timestamp, 'YYYY') || '-' ||
         lpad(nextval('public.order_number_seq')::text, 6, '0');
$$;

-- 2. ORDERS TABLE ──────────────────────────────────────────────
create table public.orders (
  id                      uuid primary key default gen_random_uuid(),
  order_number            text unique not null default public.generate_order_number(),
  user_id                 uuid references auth.users(id) on delete set null,

  customer_type           text not null
                          check (customer_type in ('private', 'business')),

  status                  text not null default 'pending'
                          check (status in (
                            'pending', 'confirmed', 'processing',
                            'shipped', 'delivered', 'cancelled', 'refunded'
                          )),

  payment_status          text not null default 'pending'
                          check (payment_status in (
                            'pending', 'paid', 'failed',
                            'partially_refunded', 'refunded'
                          )),

  fulfillment_status      text not null default 'unfulfilled'
                          check (fulfillment_status in (
                            'unfulfilled', 'processing',
                            'shipped', 'delivered', 'cancelled'
                          )),

  currency                text not null default 'EUR'
                          check (currency = 'EUR'),

  -- Snapshots (immutable after order placement)
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

  placed_at               timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

-- Indexes
create index idx_orders_user       on public.orders(user_id);
create index idx_orders_created    on public.orders(created_at);
create index idx_orders_status     on public.orders(status);

-- Auto-update updated_at (reuse existing function from 001)
create trigger set_orders_updated_at
  before update on public.orders
  for each row execute function public.set_updated_at();

-- 3. ORDER ITEMS TABLE ─────────────────────────────────────────
create table public.order_items (
  id                      uuid primary key default gen_random_uuid(),
  order_id                uuid not null references public.orders(id) on delete cascade,

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
create index idx_order_items_order on public.order_items(order_id);

-- 4. ROW LEVEL SECURITY ───────────────────────────────────────

alter table public.orders enable row level security;
alter table public.order_items enable row level security;

-- Orders: authenticated users can only read their own
create policy "Users read own orders"
  on public.orders for select
  using (auth.uid() = user_id);

-- Order items: only if the parent order belongs to the user
create policy "Users read own order items"
  on public.order_items for select
  using (
    exists (
      select 1 from public.orders
      where orders.id = order_items.order_id
        and orders.user_id = auth.uid()
    )
  );

-- No INSERT/UPDATE/DELETE policies for authenticated clients
-- Orders will be created server-side during checkout

-- 5. GRANTS ────────────────────────────────────────────────────

grant select on public.orders to authenticated;
grant select on public.order_items to authenticated;

-- No grants to anon
-- No write grants to authenticated
