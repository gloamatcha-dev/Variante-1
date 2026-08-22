-- ============================================================
-- GLOA – Standalone Metal Case (B2C catalog publication)
-- Run in Supabase SQL Editor AFTER 019
--
-- Follows the convention set by migration 008, which seeded the Matcha
-- launch product the same way. No schema change: the catalog has
-- supported a non-food accessory since migration 007
-- (product_variants.size_grams is nullable), and the application code has
-- supported one since Task 27A.
--
-- This publishes the EMPTY GLOA Metal Case, sold as an accessory. It is a
-- different product from GLOA Matcha, which ships IN a metal case. Only
-- confirmed data appears below: name, slug, price, SKU and the reused
-- product image. No material, dimensions, capacity, coating, origin,
-- weight, airtightness or food-safety claim is stated anywhere, because
-- none of those are confirmed.
--
-- No tax field is written. Task 21 (VAT/OSS) remains paused, and
-- 9,99 EUR is a customer-facing gross price only.
--
-- Migrations 017, 018 and 019 are untouched, as is the Matcha product.
-- ============================================================

-- 0. PRE-FLIGHT: RUN THIS FIRST AND READ THE RESULT ────────────
--
-- service_role has no SELECT grant on the catalog tables (migration 007
-- granted select to anon and authenticated only), so an INACTIVE draft
-- product cannot be detected from the application side. Run this in the
-- SQL Editor before the inserts below and check what, if anything,
-- already exists:
--
--   select id, slug, name, is_active, sort_order, primary_image_path
--   from public.products
--   where slug = 'metal-case';
--
--   select id, sku, label, size_grams, price_gross_cents, is_active
--   from public.product_variants
--   where sku = 'GLOA-CASE-01';
--
-- Expected before this migration: zero rows from both.
--
-- If rows DO come back, read them before continuing. The statements below
-- are written as upserts precisely so that a pre-existing draft is
-- brought up to the confirmed launch values rather than left behind in a
-- half-published state - but you should know what you are overwriting.

-- 1. PRODUCT ───────────────────────────────────────────────────
--
-- sort_order 10 keeps GLOA Matcha (sort_order 0) first in the shop.
--
-- primary_image_path deliberately reuses the SAME asset already used for
-- the Matcha product. That image also depicts Matcha packaging, which is
-- exactly why the "Matcha nicht enthalten" disclosure is rendered
-- prominently next to the price on both the product card and the product
-- page (see lib/productPresentation.ts). The short description repeats it
-- in the customer's own reading flow.
insert into public.products (
  slug,
  name,
  short_description,
  primary_image_path,
  is_active,
  sort_order
)
values (
  'metal-case',
  'GLOA Metal Case',
  'Die GLOA Metal Case für unterwegs, zuhause oder als zweite Dose für deinen Matcha. Leer verkauft. Matcha nicht enthalten.',
  '/img/gloa-hero-packaging.jpg',
  true,
  10
)
on conflict (slug) do update set
  name               = excluded.name,
  short_description  = excluded.short_description,
  primary_image_path = excluded.primary_image_path,
  is_active          = excluded.is_active,
  sort_order         = excluded.sort_order;

-- 2. VARIANT ───────────────────────────────────────────────────
--
-- Exactly one purchasable variant, sold as a unit.
--
-- size_grams stays NULL. It is NOT 0 and not any invented weight: the
-- product is not sold by weight, and a zero would make the shop render a
-- meaningless "0,00 € / 100 g" base price. lib/productPresentation.ts
-- reads this NULL as "not a weighed product" and therefore suppresses the
-- base price and every food field.
insert into public.product_variants (
  product_id,
  sku,
  label,
  size_grams,
  price_gross_cents,
  currency,
  is_active,
  sort_order
)
select
  p.id,
  'GLOA-CASE-01',
  'Metal Case',
  null,
  999,
  'EUR',
  true,
  10
from public.products p
where p.slug = 'metal-case'
on conflict (sku) do update set
  product_id        = excluded.product_id,
  label             = excluded.label,
  size_grams        = excluded.size_grams,
  price_gross_cents = excluded.price_gross_cents,
  currency          = excluded.currency,
  is_active         = excluded.is_active,
  sort_order        = excluded.sort_order;

-- 3. VERIFY ────────────────────────────────────────────────────
--
-- Run this after the inserts. Expected exactly one row:
--   metal-case | GLOA Metal Case | true | GLOA-CASE-01 | Metal Case |
--   size_grams NULL | 999 | EUR | true
--
-- A non-NULL size_grams here means something went wrong - stop and say so
-- rather than letting a fabricated weight reach the shop.
select
  p.slug,
  p.name,
  p.is_active   as product_active,
  p.sort_order  as product_sort,
  v.sku,
  v.label,
  v.size_grams,
  v.price_gross_cents,
  v.currency,
  v.is_active   as variant_active
from public.products p
join public.product_variants v on v.product_id = p.id
where p.slug = 'metal-case';

-- 4. MATCHA MUST BE UNCHANGED ──────────────────────────────────
--
-- Expected: 30 g = 1999, 50 g = 2999, 100 g = 5499, all still active.
select v.sku, v.label, v.size_grams, v.price_gross_cents, v.is_active
from public.products p
join public.product_variants v on v.product_id = p.id
where p.slug = 'matcha'
order by v.sort_order;

-- 5. NO NEW PRIVILEGES ─────────────────────────────────────────
--
-- No grant, policy or RLS change. The new rows are readable by anon and
-- authenticated through the existing "Public read active products" /
-- "Public read active priced variants of active products" policies from
-- migration 007, which is exactly how GLOA Matcha is already served.
