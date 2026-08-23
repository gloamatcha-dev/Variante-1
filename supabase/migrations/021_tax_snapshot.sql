-- ============================================================
-- GLOA – Tax Snapshot (Task 21D, corrected by 21D.1)
-- Run in Supabase SQL Editor AFTER 020
--
-- Two things, in this order:
--
--   1. Removes the leftover `default 0` on the nullable net/tax columns
--      of public.orders. Migration 011 dropped their NOT NULL so they
--      could mean "unknown", but the migration-004 defaults survived, so
--      any INSERT that omits a column still fabricates a 0. Migrations
--      012/014/016 worked around this by listing every column explicitly
--      and passing NULL - one forgotten column away from the bug coming
--      back a third time. This fixes the cause.
--
--   2. Adds the fields an immutable customer tax snapshot needs and that
--      do not already exist. Existing columns are reused, not duplicated:
--      orders.subtotal_net_cents / shipping_net_cents / tax_total_cents /
--      total_net_cents and order_items.unit_price_net_cents /
--      line_total_net_cents / tax_rate_percent all stay as they are. Per
--      line and per shipping share, tax cents are deliberately NOT stored
--      separately - they are exactly gross - net.
--
-- What this migration deliberately does NOT contain: any accumulation of
-- EU distance-sale turnover, any reservation, and any threshold or OSS
-- decision. The applicable EU VAT treatment is a tax/accounting
-- responsibility of Cara 2 GmbH, supplied to the application as the
-- configured tax mode in lib/tax.ts. The database records what was
-- charged; it does not decide what should be.
--
-- Historical data is not touched. No UPDATE runs against existing rows,
-- no legacy 0 is converted to NULL, and no paid order is recalculated.
-- NULL keeps meaning "unknown" and 0 keeps meaning "known to be zero".
-- ============================================================

-- 1. NULLABLE MEANS UNKNOWN, SO IT MUST NOT DEFAULT TO ZERO ────
--
-- Only the columns that are genuinely nullable-and-unknown are touched.
-- subtotal_gross_cents, total_gross_cents and discount_total_cents keep
-- their NOT NULL default 0: those are never "unknown" (the first two come
-- from a verified Stripe payment, and no discount is a real zero).

alter table public.orders
  alter column subtotal_net_cents   drop default,
  alter column shipping_net_cents   drop default,
  alter column shipping_gross_cents drop default,
  alter column tax_total_cents      drop default,
  alter column total_net_cents      drop default;

-- public.order_items.unit_price_net_cents / line_total_net_cents were
-- declared in 004 without a default and made nullable in 011, so they
-- already behave correctly. Nothing to drop there.

-- 2. TAX SNAPSHOT ON THE CHECKOUT ATTEMPT ──────────────────────
--
-- The attempt is where tax is frozen, for the same reason prices and
-- shipping already are: it is computed BEFORE Stripe is called, and a
-- retry must reuse it rather than recompute against a possibly newer tax
-- state. tax_snapshot is the whole authoritative result from lib/tax.ts
-- (items, shipping apportionment, totals, per-rate breakdown, treatment,
-- calculation version) - a working record, so one document is right here.
--
-- NULL means the destination's VAT is genuinely not implemented (UK,
-- Switzerland, Norway, third countries): unknown, never a fabricated 0.

alter table public.checkout_attempts
  add column tax_snapshot jsonb;

-- 3. TAX SNAPSHOT ON THE PAID ORDER ────────────────────────────
--
-- The order is the accounting record, so it gets queryable columns
-- rather than one blob. Together with order_items (below) these
-- reproduce exactly how a paid order was taxed:
--   which rules applied      -> tax_treatment, tax_jurisdiction_kind,
--                               tax_vat_country, tax_calculation_version
--   what each line was       -> order_items
--   what shipping was        -> shipping_gross_cents / shipping_net_cents
--                               + shipping_tax_allocation

alter table public.orders
  -- What was actually charged, not a legal determination made here.
  -- de_origin_intra_eu records German VAT on a B2C supply into EU VAT
  -- territory, which is the tax mode currently configured in lib/tax.ts.
  add column tax_treatment           text
                                     check (tax_treatment is null or tax_treatment in (
                                       'de_domestic', 'de_origin_intra_eu'
                                     )),
  add column tax_jurisdiction_kind   text,
  -- The country whose VAT was actually charged (DE here), which is not
  -- the destination country for an EU supply taxed at origin.
  add column tax_vat_country         text,
  add column tax_calculation_version text,
  -- How the shipping charge was apportioned across differently taxed
  -- supplies: [{taxCategory, taxRatePercent, grossCents, netCents,
  -- taxCents}]. NULL when tax was never calculated for this order.
  add column shipping_tax_allocation jsonb;

alter table public.order_items
  -- The tax category the line was classified under, kept alongside the
  -- rate so a later reclassification is visible instead of implied.
  add column tax_category text;

-- 4. ORDER CREATION NOW CARRIES THE FROZEN TAX SNAPSHOT ────────
--
-- Same 6-argument signature as migration 016, so this is a true in-place
-- CREATE OR REPLACE. The body is 016's, with the tax snapshot copied out
-- of the checkout attempt. Nothing is recomputed here and no argument
-- carries tax: the authoritative values are the ones frozen on the
-- attempt before Stripe was ever called.
--
-- Two invariants are re-checked and fail closed by raising, which aborts
-- order creation rather than persisting a snapshot that disagrees with
-- what the customer actually paid.

create or replace function public.create_order_from_paid_checkout(
  p_checkout_attempt_id uuid,
  p_customer_snapshot jsonb,
  p_stripe_payment_intent_id text,
  p_shipping_address_snapshot jsonb,
  p_billing_address_snapshot jsonb,
  p_shipping_gross_cents integer
)
returns public.orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempt public.checkout_attempts;
  v_order public.orders;
  v_item jsonb;
  v_tax jsonb;
  v_tax_item jsonb;
  v_totals jsonb;
  v_subtotal_gross_cents integer := 0;
begin
  select * into v_attempt
  from public.checkout_attempts
  where id = p_checkout_attempt_id
  for update;

  if not found then
    raise exception 'checkout attempt % not found', p_checkout_attempt_id;
  end if;

  if v_attempt.status <> 'paid' then
    raise exception 'checkout attempt % is not paid (status=%)', p_checkout_attempt_id, v_attempt.status;
  end if;

  select * into v_order
  from public.orders
  where checkout_attempt_id = p_checkout_attempt_id;

  if found then
    -- Already created. A paid order's tax snapshot is immutable: a
    -- webhook redelivery returns it untouched, it is never refreshed
    -- against a newer tax state.
    return v_order;
  end if;

  select coalesce(sum((item->>'lineGrossCents')::integer), 0)
    into v_subtotal_gross_cents
  from jsonb_array_elements(v_attempt.items_snapshot) as item;

  v_tax := v_attempt.tax_snapshot;
  v_totals := v_tax->'totals';

  if v_tax is not null then
    -- The tax snapshot must describe the very transaction being settled.
    -- A disagreement means the two were computed from different inputs,
    -- which is exactly the case where guessing would be worst.
    if (v_totals->>'shippingGrossCents')::integer is distinct from p_shipping_gross_cents then
      raise exception 'tax snapshot shipping (%) does not match the paid shipping (%) for attempt %',
        v_totals->>'shippingGrossCents', p_shipping_gross_cents, p_checkout_attempt_id;
    end if;
    if (v_totals->>'totalGrossCents')::integer is distinct from v_attempt.expected_total_gross_cents then
      raise exception 'tax snapshot total (%) does not match the expected total (%) for attempt %',
        v_totals->>'totalGrossCents', v_attempt.expected_total_gross_cents, p_checkout_attempt_id;
    end if;
  end if;

  begin
    insert into public.orders (
      user_id,
      customer_type,
      status,
      payment_status,
      currency,
      customer_snapshot,
      shipping_address_snapshot,
      billing_address_snapshot,
      subtotal_gross_cents,
      subtotal_net_cents,
      shipping_net_cents,
      shipping_gross_cents,
      tax_total_cents,
      total_net_cents,
      total_gross_cents,
      tax_treatment,
      tax_jurisdiction_kind,
      tax_vat_country,
      tax_calculation_version,
      shipping_tax_allocation,
      placed_at,
      checkout_attempt_id,
      stripe_checkout_session_id,
      stripe_payment_intent_id
    ) values (
      v_attempt.user_id,
      'private',
      'confirmed',
      'paid',
      v_attempt.currency,
      coalesce(p_customer_snapshot, jsonb_build_object('email', null, 'name', null)),
      p_shipping_address_snapshot,
      p_billing_address_snapshot,
      v_subtotal_gross_cents,
      -- Still explicitly NULL when no tax was calculated (every non-EU
      -- destination): unknown, never a fabricated zero.
      (v_totals->>'subtotalNetCents')::integer,
      (v_totals->>'shippingNetCents')::integer,
      p_shipping_gross_cents,
      (v_totals->>'taxTotalCents')::integer,
      (v_totals->>'totalNetCents')::integer,
      v_attempt.expected_total_gross_cents,
      v_tax->>'treatment',
      v_tax->>'jurisdictionKind',
      v_tax->>'taxCountry',
      v_tax->>'calculationVersion',
      v_tax->'shipping'->'allocations',
      now(),
      v_attempt.id,
      v_attempt.stripe_checkout_session_id,
      p_stripe_payment_intent_id
    )
    returning * into v_order;
  exception
    when unique_violation then
      -- A concurrent call won the race between our lookup and insert.
      select * into v_order from public.orders where checkout_attempt_id = p_checkout_attempt_id;
      if found then
        return v_order;
      end if;
      raise;
  end;

  for v_item in select * from jsonb_array_elements(v_attempt.items_snapshot)
  loop
    -- Matched on variantId, not position: the two arrays are built from
    -- the same quote, but relying on their order would be a silent
    -- mis-taxation the day that stops being true.
    select tax_item into v_tax_item
    from jsonb_array_elements(coalesce(v_tax->'items', '[]'::jsonb)) as tax_item
    where tax_item->>'variantId' = v_item->>'variantId'
    limit 1;

    if v_tax is not null and v_tax_item is null then
      raise exception 'tax snapshot for attempt % has no line for variant %',
        p_checkout_attempt_id, v_item->>'variantId';
    end if;

    insert into public.order_items (
      order_id,
      product_reference,
      sku,
      product_name,
      variant_name,
      quantity,
      unit_price_gross_cents,
      unit_price_net_cents,
      line_total_gross_cents,
      line_total_net_cents,
      tax_rate_percent,
      tax_category,
      metadata
    ) values (
      v_order.id,
      v_item->>'variantId',
      v_item->>'sku',
      v_item->>'productName',
      v_item->>'variantLabel',
      (v_item->>'quantity')::integer,
      (v_item->>'unitGrossCents')::integer,
      (v_tax_item->>'unitNetCents')::integer,
      (v_item->>'lineGrossCents')::integer,
      (v_tax_item->>'lineNetCents')::integer,
      (v_tax_item->>'taxRatePercent')::numeric,
      v_tax_item->>'taxCategory',
      jsonb_build_object('sizeGrams', v_item->'sizeGrams', 'currency', v_item->'currency')
    );
  end loop;

  return v_order;
end;
$$;

-- 5. VERIFY ────────────────────────────────────────────────────
--
-- (a) No nullable unknown column defaults to 0 any more. Expected: five
--     rows, every column_default NULL.
--
--   select column_name, is_nullable, column_default
--   from information_schema.columns
--   where table_schema = 'public' and table_name = 'orders'
--     and column_name in ('subtotal_net_cents', 'shipping_net_cents',
--                         'shipping_gross_cents', 'tax_total_cents',
--                         'total_net_cents')
--   order by column_name;
--
-- (b) Historical orders are untouched. Expected: the same counts as
--     before this migration ran.
--
--   select count(*) filter (where tax_total_cents is null)  as tax_unknown,
--          count(*) filter (where tax_total_cents = 0)      as tax_zero,
--          count(*) filter (where total_net_cents is null)  as net_unknown,
--          count(*)                                         as orders
--   from public.orders;
--
-- (c) The new columns exist and are empty for every existing row.
--
--   select count(*) as orders_with_tax_treatment
--   from public.orders where tax_treatment is not null;
