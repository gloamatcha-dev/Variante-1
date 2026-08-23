-- ============================================================
-- GLOA – Tax Snapshot + § 3c Abs. 4 UStG Threshold Guard (Task 21D)
-- Run in Supabase SQL Editor AFTER 020
--
-- Three things, in this order:
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
--   3. Adds the concurrency-safe reservation used to keep intra-EU B2C
--      distance sales inside the 10 000 EUR allowance of § 3c Abs. 4.
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
-- threshold_relevant_net_cents is pulled out as its own column because
-- it is the one value SQL has to aggregate under a lock (section 3).
-- Its NULL contract matters:
--   NULL = this attempt predates Task 21D, relevance unknown
--   0    = known not to count (Germany, and every non-EU destination:
--          an export is not an intra-EU distance sale)
--   > 0  = counts toward the allowance

alter table public.checkout_attempts
  add column tax_snapshot                 jsonb,
  add column threshold_relevant_net_cents integer
                                          check (threshold_relevant_net_cents is null
                                                 or threshold_relevant_net_cents >= 0),
  -- Set when the threshold guard admits this attempt. Acts as a soft,
  -- self-expiring reservation: an abandoned checkout stops consuming the
  -- allowance once the reservation window lapses, so merely quoting or
  -- starting a checkout never permanently burns threshold headroom.
  add column threshold_reserved_at        timestamptz;

create index idx_checkout_attempts_threshold_reserved
  on public.checkout_attempts (threshold_reserved_at)
  where threshold_reserved_at is not null;

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
--   what it meant for § 3c   -> threshold_relevant_net_cents

alter table public.orders
  add column tax_treatment           text
                                     check (tax_treatment is null or tax_treatment in (
                                       'de_domestic', 'de_origin_intra_eu_3c4'
                                     )),
  add column tax_jurisdiction_kind   text,
  -- The country whose VAT was actually charged (DE here), which is not
  -- the destination country for an intra-EU origin-taxed distance sale.
  add column tax_vat_country         text,
  add column tax_calculation_version text,
  -- How the shipping charge was apportioned across differently taxed
  -- supplies: [{taxCategory, taxRatePercent, grossCents, netCents,
  -- taxCents}]. NULL when tax was never calculated for this order.
  add column shipping_tax_allocation jsonb,
  add column threshold_relevant_net_cents integer
                                     check (threshold_relevant_net_cents is null
                                            or threshold_relevant_net_cents >= 0);

create index idx_orders_placed_at on public.orders (placed_at);

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
      threshold_relevant_net_cents,
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
      v_attempt.threshold_relevant_net_cents,
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

-- 5. § 3c ABS. 4 THRESHOLD RESERVATION ─────────────────────────
--
-- The race this closes: two EU checkouts each read "there is room below
-- 10 000 EUR", each is allowed, and together they cross it. Reading the
-- running total from the application and then deciding cannot fix that,
-- however carefully it is written.
--
-- So the read and the reservation happen together, inside one
-- transaction, behind a transaction-scoped advisory lock. Every EU
-- checkout decision serializes on that lock, and the winner's
-- reservation is visible to the next caller before it evaluates.
--
-- What counts, and what deliberately does not:
--
--   counted   paid B2C orders of this calendar year whose recorded
--             relevant net value is > 0 (i.e. destinations the Task 21C
--             resolver placed in an EU VAT territory other than Germany)
--   counted   live reservations from other checkout attempts that have
--             not yet become an order
--   counted   the proposed order itself
--   NOT       Germany, UK, Switzerland, Norway, third countries - all
--             recorded as a known 0 by the application
--   NOT       B2B (customer_type <> 'private')
--   NOT       unpaid, failed or abandoned checkouts, and quotes, which
--             never reach this function at all
--   NOT       any other calendar year
--
-- Refunded orders are counted at their original value rather than
-- reduced. That overstates the running total slightly, which narrows the
-- allowance - the safe direction.
--
-- p_eu_country_codes comes from lib/taxJurisdiction.ts, the Task 21C
-- resolver. It is used only to detect paid EU orders from before this
-- migration, whose relevant turnover was never recorded: their value is
-- genuinely unknown, so the allowance cannot be computed and the function
-- refuses instead of assuming they were worth nothing.
--
-- A KNOWN GAP, stated rather than hidden. At the time this migration was
-- written the shop had 450 paid orders, all placed in 2026: 142 with a
-- German shipping address and 308 with no shipping address snapshot at
-- all, because address collection only arrived with migration 013. None
-- has an EU destination, so the qualifying turnover recognised here is
-- 0 EUR - which matches the owner's confirmed opening balance.
--
-- The 308 addressless orders cannot be attributed by destination, so
-- this function does not treat them as unclassified EU turnover; doing so
-- would refuse every intra-EU sale forever over rows that predate
-- international shipping entirely. What makes that safe is the owner's
-- dated confirmation in EU_ORIGIN_TAX_POLICY, not an assumption made
-- here. If those orders ever turn out to include EU B2C distance sales,
-- the correct fix is to raise externalRelevantNetCentsBeforeLaunch, not
-- to loosen anything below.

create or replace function public.reserve_eu_distance_sale_threshold(
  p_checkout_attempt_id uuid,
  p_calendar_year integer,
  p_eu_country_codes text[],
  p_external_net_cents bigint,
  p_threshold_net_cents bigint,
  p_safety_buffer_net_cents bigint,
  p_reservation_window_hours integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempt public.checkout_attempts;
  v_paid_net_cents bigint := 0;
  v_pending_net_cents bigint := 0;
  v_unclassified_orders bigint := 0;
  v_proposed_net_cents bigint;
  v_total_net_cents bigint;
  v_allowance_net_cents bigint;
begin
  -- Serializes every threshold decision for the whole shop. Held until
  -- this transaction ends, so the reservation written below is committed
  -- before the next caller can evaluate.
  perform pg_advisory_xact_lock(hashtext('gloa:eu_distance_sale_threshold'));

  select * into v_attempt
  from public.checkout_attempts
  where id = p_checkout_attempt_id
  for update;

  if not found then
    return jsonb_build_object('allowed', false, 'reason', 'attempt_not_found');
  end if;

  if v_attempt.threshold_relevant_net_cents is null then
    -- An attempt with no recorded relevant value cannot be evaluated.
    return jsonb_build_object('allowed', false, 'reason', 'attempt_has_no_threshold_value');
  end if;

  v_proposed_net_cents := v_attempt.threshold_relevant_net_cents;

  if v_proposed_net_cents = 0 then
    -- Nothing to reserve; the caller should not have asked, but saying so
    -- is better than writing a meaningless reservation.
    return jsonb_build_object('allowed', true, 'reason', 'not_threshold_relevant');
  end if;

  select coalesce(sum(o.threshold_relevant_net_cents), 0)
    into v_paid_net_cents
  from public.orders o
  where o.customer_type = 'private'
    and o.payment_status in ('paid', 'partially_refunded', 'refunded')
    and o.placed_at is not null
    and extract(year from (o.placed_at at time zone 'Europe/Berlin')) = p_calendar_year
    and o.threshold_relevant_net_cents is not null;

  select count(*)
    into v_unclassified_orders
  from public.orders o
  where o.customer_type = 'private'
    and o.payment_status in ('paid', 'partially_refunded', 'refunded')
    and o.placed_at is not null
    and extract(year from (o.placed_at at time zone 'Europe/Berlin')) = p_calendar_year
    and o.threshold_relevant_net_cents is null
    and upper(coalesce(o.shipping_address_snapshot->>'country', '')) = any(p_eu_country_codes);

  if v_unclassified_orders > 0 then
    return jsonb_build_object(
      'allowed', false,
      'reason', 'unclassified_paid_eu_turnover',
      'unclassifiedOrders', v_unclassified_orders
    );
  end if;

  -- Live reservations from OTHER attempts. Excluding this attempt and
  -- then adding its own value back makes re-running the guard for the
  -- same attempt idempotent instead of double counting it.
  --
  -- An attempt drops out of this pool the moment its order exists, which
  -- is when it starts being counted as paid turnover above - so the
  -- handover happens with neither a gap nor an overlap.
  select coalesce(sum(a.threshold_relevant_net_cents), 0)
    into v_pending_net_cents
  from public.checkout_attempts a
  where a.id <> p_checkout_attempt_id
    and a.threshold_reserved_at is not null
    and a.threshold_reserved_at > now() - make_interval(hours => p_reservation_window_hours)
    and coalesce(a.threshold_relevant_net_cents, 0) > 0
    and not exists (
      select 1 from public.orders o where o.checkout_attempt_id = a.id
    );

  v_allowance_net_cents := p_threshold_net_cents - p_safety_buffer_net_cents;
  v_total_net_cents := p_external_net_cents + v_paid_net_cents + v_pending_net_cents + v_proposed_net_cents;

  -- § 3c Abs. 4 Satz 1 holds while the total is not EXCEEDED, so landing
  -- exactly on the allowance is still inside it.
  if v_total_net_cents > v_allowance_net_cents then
    return jsonb_build_object('allowed', false, 'reason', 'threshold_would_be_exceeded');
  end if;

  update public.checkout_attempts
     set threshold_reserved_at = now()
   where id = p_checkout_attempt_id;

  return jsonb_build_object('allowed', true, 'reason', 'reserved');
end;
$$;

revoke all on function public.reserve_eu_distance_sale_threshold(uuid, integer, text[], bigint, bigint, bigint, integer) from public;
grant execute on function public.reserve_eu_distance_sale_threshold(uuid, integer, text[], bigint, bigint, bigint, integer) to service_role;

-- 6. VERIFY ────────────────────────────────────────────────────
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
