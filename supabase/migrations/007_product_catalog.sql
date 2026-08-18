-- ============================================================
-- GLOA – B2C Product Catalog Foundation
-- Run in Supabase SQL Editor AFTER 001 + 002 + 003 + 004 + 005 + 006
-- ============================================================

-- 1. PRODUCTS ────────────────────────────────────────────────────
create table public.products (
  id                  uuid primary key default gen_random_uuid(),

  slug                text not null unique
                      check (length(trim(slug)) > 0),

  name                text not null
                      check (length(trim(name)) > 0),

  short_description   text,
  description         text,
  primary_image_path  text,

  is_active           boolean not null default false,
  sort_order          integer not null default 0,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- Indexes (slug already has unique index)
create index idx_products_active     on public.products(is_active);
create index idx_products_sort       on public.products(sort_order);

-- Auto-update updated_at (reuse existing function from 001)
create trigger set_products_updated_at
  before update on public.products
  for each row execute function public.set_updated_at();

-- RLS
alter table public.products enable row level security;

create policy "Public read active products"
  on public.products for select
  using (is_active = true);

-- No INSERT/UPDATE/DELETE policies — products managed server-side

grant select on public.products to anon;
grant select on public.products to authenticated;

-- 2. PRODUCT VARIANTS ────────────────────────────────────────────
create table public.product_variants (
  id                  uuid primary key default gen_random_uuid(),

  product_id          uuid not null
                      references public.products(id) on delete cascade,

  sku                 text not null unique
                      check (length(trim(sku)) > 0),

  label               text not null
                      check (length(trim(label)) > 0),

  size_grams          integer
                      check (size_grams is null or size_grams > 0),

  price_gross_cents   integer
                      check (price_gross_cents is null or price_gross_cents >= 0),

  currency            text not null default 'EUR'
                      check (currency = 'EUR'),

  is_active           boolean not null default false,
  sort_order          integer not null default 0,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- Indexes (sku already has unique index)
create index idx_variants_product    on public.product_variants(product_id);
create index idx_variants_active     on public.product_variants(is_active);
create index idx_variants_sort       on public.product_variants(sort_order);

-- Auto-update updated_at
create trigger set_variants_updated_at
  before update on public.product_variants
  for each row execute function public.set_updated_at();

-- RLS
alter table public.product_variants enable row level security;

create policy "Public read active priced variants of active products"
  on public.product_variants for select
  using (
    is_active = true
    and price_gross_cents is not null
    and exists (
      select 1 from public.products
      where products.id = product_variants.product_id
        and products.is_active = true
    )
  );

-- No INSERT/UPDATE/DELETE policies — variants managed server-side

grant select on public.product_variants to anon;
grant select on public.product_variants to authenticated;

-- No seed data — products and variants will be added after confirmation
