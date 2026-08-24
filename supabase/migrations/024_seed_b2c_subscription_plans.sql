-- ============================================================
-- GLOA – B2C subscription launch plans: every 4 weeks (Task 29D-C)
-- Run in Supabase SQL Editor AFTER 023
--
-- Migration 005 created b2c_subscription_plans with no rows, because the
-- cadence and the conditions were not confirmed. They are now: exactly
-- one cadence at launch, every 4 weeks, which is 28 days. Not a calendar
-- month, and not "monatlich" - a month is 28 to 31 days and would make
-- the delivery rhythm drift against what the customer was told.
--
-- Two things happen here.
--
--   1. The plan table gains the product reference it never had. A plan
--      row could describe a cadence but not say what was being delivered,
--      so "30 g every 4 weeks" was not expressible. That is added as a
--      real foreign key rather than encoded in the slug, because a
--      renamed slug must not be able to silently repoint a plan at a
--      different product.
--
--   2. The three launch plans are seeded, resolved by SKU rather than by
--      hardcoded UUID, and the migration refuses to run if a SKU is
--      missing rather than seeding a plan for a product that is not there.
--
-- What this migration deliberately does NOT contain: any price. The plan
-- table has no amount column and none is added. The catalog
-- (product_variants.price_gross_cents) stays the single commercial truth,
-- read server-side at subscription creation and frozen into the
-- subscription's own snapshot from there. A price stored on a plan would
-- be a second editable source that could silently disagree with the shop.
--
-- No discount of any kind is seeded. There is no B2C subscription
-- discount; discount_percent is left NULL, meaning not applicable rather
-- than "a discount of zero was configured".
--
-- No commitment term is seeded either. Cancellation rules are a separate
-- decision and are not invented here.
-- ============================================================

-- 1. A PLAN NEEDS TO SAY WHAT IT DELIVERS ──────────────────────
--
-- Nullable, because the column is being added to a table whose future
-- shapes are not all decided - a bundle plan spanning several variants
-- would have no single one. Every launch plan sets it.

alter table public.b2c_subscription_plans
  add column variant_id uuid references public.product_variants(id);

-- The correctness constraint the seed needs, and the smallest one that
-- provides it: one active plan per variant per cadence. Without it a
-- second run with a different slug, or a later hand-written row, could
-- offer the same product on the same rhythm twice and the account UI
-- would have no way to choose between them. Partial on is_active, so a
-- retired plan can be superseded rather than blocking its replacement.

create unique index b2c_plans_active_variant_cadence_key
  on public.b2c_subscription_plans
     (variant_id, billing_interval_unit, billing_interval_count)
  where is_active and variant_id is not null;

-- 2. THE THREE LAUNCH PLANS ────────────────────────────────────
--
-- Resolved by SKU. product_variants.sku is unique, so this is exact, and
-- it survives a database restore that reassigns UUIDs in a way a
-- hardcoded id would not.
--
-- billing and delivery cadence are deliberately identical: the customer
-- is charged for the delivery they are receiving, so a divergence between
-- the two would be a different product than the one that was agreed.
--
-- on conflict (slug) do nothing makes a re-run harmless. The unique index
-- above covers the other direction, where the same variant and cadence
-- arrive under a different slug.

do $$
declare
  v_variant record;
  v_expected text[] := array['GLOA-MATCHA-30G', 'GLOA-MATCHA-50G', 'GLOA-MATCHA-100G'];
  v_sku text;
  v_missing text[] := '{}';
begin
  -- Fail before writing anything if the catalog is not what we expect.
  -- Seeding a plan for a product that does not exist would put an
  -- unbuyable option in front of a customer.
  foreach v_sku in array v_expected loop
    if not exists (
      select 1 from public.product_variants
      where sku = v_sku and is_active
    ) then
      v_missing := v_missing || v_sku;
    end if;
  end loop;

  if array_length(v_missing, 1) is not null then
    raise exception 'cannot seed subscription plans: no active product variant for %', v_missing;
  end if;

  for v_variant in
    select id, sku, label, size_grams
    from public.product_variants
    where sku = any(v_expected) and is_active
    order by size_grams
  loop
    insert into public.b2c_subscription_plans (
      slug,
      name,
      description,
      variant_id,
      billing_interval_unit,
      billing_interval_count,
      delivery_interval_unit,
      delivery_interval_count,
      is_active,
      sort_order
    ) values (
      'matcha-' || lower(replace(v_variant.label, ' ', '')) || '-4w',
      'GLOA Matcha ' || v_variant.label || ' · alle 4 Wochen',
      'Lieferung alle 4 Wochen (28 Tage). Preis wie im Shop, kein Abo-Rabatt.',
      v_variant.id,
      'week',
      4,
      'week',
      4,
      true,
      coalesce(v_variant.size_grams, 0)
    )
    on conflict (slug) do nothing;
  end loop;
end;
$$;

-- 3. VERIFY ────────────────────────────────────────────────────
--
-- Read-only. Run after applying.
--
-- (a) Exactly three active plans, all week/4, each on a real Matcha SKU,
--     none carrying a discount or a commitment.
--
--   select p.slug, p.name, v.sku, v.price_gross_cents,
--          p.billing_interval_unit, p.billing_interval_count,
--          p.delivery_interval_unit, p.delivery_interval_count,
--          p.discount_percent, p.commitment_months, p.is_active
--   from public.b2c_subscription_plans p
--   join public.product_variants v on v.id = p.variant_id
--   where p.is_active
--   order by p.sort_order;
--
-- (b) No other cadence exists. Expected: one row, week | 4 | 3.
--
--   select billing_interval_unit, billing_interval_count, count(*)
--   from public.b2c_subscription_plans
--   where is_active
--   group by 1, 2
--   order by 1, 2;
--
-- (c) The Metal Case has no plan. Expected: zero rows.
--
--   select p.slug, v.sku
--   from public.b2c_subscription_plans p
--   join public.product_variants v on v.id = p.variant_id
--   where v.sku not like 'GLOA-MATCHA-%';
--
-- (d) The correctness constraint is in place.
--
--   select indexname, indexdef
--   from pg_indexes
--   where schemaname = 'public'
--     and indexname = 'b2c_plans_active_variant_cadence_key';
--
-- (e) The plan table still stores no price, so the catalog stays the one
--     commercial truth. Expected: zero rows.
--
--   select column_name
--   from information_schema.columns
--   where table_schema = 'public'
--     and table_name = 'b2c_subscription_plans'
--     and (column_name like '%price%' or column_name like '%amount%'
--          or column_name like '%cents%');
--
-- (f) Reading plans is unchanged: authenticated may select, nothing more.
--
--   select grantee, privilege_type
--   from information_schema.role_table_grants
--   where table_schema = 'public' and table_name = 'b2c_subscription_plans'
--     and grantee in ('anon', 'authenticated', 'service_role')
--   order by grantee, privilege_type;
