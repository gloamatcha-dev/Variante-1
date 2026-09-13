-- ============================================================
-- GLOA – Withhold the standalone Metal Case from the launch catalog
-- Run in the Supabase SQL Editor AFTER 046
--
-- BUSINESS DECISION (2026-09-13): the GLOA Metal Case is not a launch
-- product and must not be sold on 01.10.2026. Migration 020 published it
-- as an active product with one active variant; this withdraws it.
--
-- DEACTIVATES, NEVER DELETES. Both rows keep their id, slug, SKU, name,
-- description, image, price and sort order. Selling the case later is
-- flipping these two booleans back - no re-seed, no new id, and every
-- order line that ever referenced the variant stays intact.
--
-- WHY is_active AND NOT A DELETE: product_variants.id is what a cart
-- item, a checkout attempt snapshot and an order line all carry. Deleting
-- the row would orphan historical orders and break their detail pages;
-- deactivating it removes the product from every purchasable surface
-- while leaving history readable.
--
-- SCOPE: exactly two rows, matched by their natural keys. GLOA Matcha and
-- its three variants are not referenced and cannot be touched by this
-- file - the verification at the bottom proves that after the fact.
--
-- IDEMPOTENT: re-running sets the same two booleans to the same value and
-- reports the same result. There is no state in which running this twice
-- differs from running it once.
--
-- WHAT THE APPLICATION ALREADY DOES, WITH OR WITHOUT THIS MIGRATION:
-- lib/catalogAvailability.ts withholds the slug in the shop listing, on
-- the product detail route and in the authoritative checkout quote, so
-- the case is already unlistable, unreachable and unsellable in code.
-- This migration makes the CATALOG agree with that, which is what stops
-- the row from being published by anything that reads Supabase directly.
-- The two are deliberately independent.
-- ============================================================

-- 0. PRE-FLIGHT: read the current state before changing it ─────
--
--   select p.slug, p.is_active as product_active,
--          v.sku, v.is_active as variant_active, v.price_gross_cents
--   from public.products p
--   left join public.product_variants v on v.product_id = p.id
--   where p.slug = 'metal-case';
--
-- Expected before this migration: product_active = true,
-- variant_active = true, price_gross_cents = 999.

-- 1. THE VARIANT ───────────────────────────────────────────────
--
-- The variant first, then the product. Order matters only for the brief
-- window inside the transaction, but in that window the shop must never
-- see an active variant under an inactive product - the catalog read
-- (app/useCatalog.ts) drops a product with no purchasable variant, so
-- deactivating the variant first is the state that degrades cleanly.
update public.product_variants v
set is_active = false
from public.products p
where v.product_id = p.id
  and p.slug = 'metal-case'
  and v.sku = 'GLOA-CASE-01';

-- 2. THE PRODUCT ───────────────────────────────────────────────
update public.products
set is_active = false
where slug = 'metal-case';

-- 3. VERIFY ───────────────────────────────────────────────────
--
-- Run these after the statements above and read both results.
--
-- (a) The case is off, and everything about it is still here:
--
--   select p.slug, p.name, p.is_active as product_active,
--          v.sku, v.label, v.price_gross_cents, v.currency,
--          v.is_active as variant_active
--   from public.products p
--   join public.product_variants v on v.product_id = p.id
--   where p.slug = 'metal-case';
--
--   Expected: one row, product_active = false, variant_active = false,
--   price_gross_cents = 999, currency = 'EUR'. A price of 999 still
--   being there is the point: nothing was zeroed or removed.
--
-- (b) Matcha is untouched and still sellable:
--
--   select p.slug, p.is_active as product_active,
--          v.sku, v.is_active as variant_active, v.price_gross_cents
--   from public.products p
--   join public.product_variants v on v.product_id = p.id
--   where p.slug = 'matcha'
--   order by v.sort_order;
--
--   Expected: three rows, all active, 1999 / 2999 / 5499.
--
-- (c) The public catalog no longer offers the case at all. With the
--     publishable key (RLS as an anonymous visitor):
--
--   select slug from public.products order by sort_order;
--
--   Expected: 'matcha' only.
