-- ══════════════════════════════════════════════════════════════
-- GLOA 058 - DISCOUNTED ORDER LINE ACCOUNTING
--
-- Run as ONE statement in the Supabase SQL Editor, after 057.
-- ══════════════════════════════════════════════════════════════
--
-- WHAT IS WRONG TODAY.
--
-- A discounted order line stores two numbers computed on two different
-- bases. One 50 g tin with GLOALAUNCH10, shipped to Germany:
--
--   unit_price_gross_cents   2299   the catalogue unit
--   unit_price_net_cents     2149   net OF THE CATALOGUE UNIT
--   line_total_gross_cents   2299   the catalogue line
--   line_total_net_cents     1934   net OF THE DISCOUNTED LINE (2069)
--
-- Read the row the obvious way - gross minus net - and it claims 365
-- cents of tax, an 18,87 % rate on a 7 % article. The true line tax is
-- 135 cents on an effective gross of 2069. And at quantity one, the
-- unit net (2149) does not equal the line net (1934); they differ by
-- the net component of the discount, and nothing in the row says so.
--
-- The ORDER level does not have this problem. It reconciles because
-- discount_total_cents sits between its pre-discount subtotal and its
-- post-discount net:
--
--   subtotal_gross - discount_total + shipping_gross = total_gross
--
-- order_items has no such column. That is the whole defect, and this
-- migration adds exactly the columns that close it.
--
-- ── WHAT THIS MIGRATION DOES NOT DO ───────────────────────────
--
-- It does not change the meaning of one existing column. It does not
-- rewrite one existing row. It does not touch the order level, which
-- already reconciles. It does not put discount data into
-- items_snapshot, which stays the frozen catalogue record. It does not
-- change the order writer's signature, because migration 039's
-- fulfill_annual_plan_delivery calls it positionally from inside SQL
-- and PostgreSQL does not track function-to-function dependencies - a
-- signature change would fail in the daily annual cron at runtime
-- rather than here at migration time.
--
-- AND IT DOES NOT REIMPLEMENT THE ALLOCATOR. lib/launchDiscount.ts's
-- splitDiscountAcrossLines is largest-remainder over a floating-point
-- intermediate with an index tie-break. A numeric port would be exact
-- where JavaScript is not and could legitimately disagree on a
-- near-tie, which is two implementations of one money rule - exactly
-- what migration 039 refused to do for VAT. TypeScript stays the only
-- allocation authority. This migration PERSISTS and VALIDATES what it
-- froze, and computes no share of its own.
--
-- ── WHY THE ALLOCATION IS FROZEN ON THE ATTEMPT ───────────────
--
-- Because the order writer needs a per-line figure for EVERY discounted
-- order, and the only other place one exists is the tax snapshot - the
-- difference between a catalogue line and its taxed line. That is exact
-- where it exists, and it does not exist at all for a destination whose
-- VAT is not implemented (UK, Switzerland, Norway, third countries),
-- where tax_snapshot is NULL. A discounted order to one of those is
-- reachable today: the session route prices the code BEFORE it resolves
-- tax. Sourcing the allocation from tax would leave such an order with
-- discount_total_cents > 0 and every line at zero - one inconsistency
-- traded for another.
--
-- So it is frozen where every other authoritative fact about a checkout
-- is already frozen: on the attempt, before Stripe is called, by the
-- code that computed it.
--
-- ── SCOPE ─────────────────────────────────────────────────────
--
-- Production carries 0 discounted attempts, 0 orders with a discount
-- code and 0 with a discount amount, verified read-only immediately
-- before this file was written. So no accounting row needs repair and
-- no backfill is written. Every historical order item becomes
-- discount_gross_cents = 0, which is a FACT about those orders and not
-- a default standing in for one.

begin;

-- ══════════════════════════════════════════════════════════════
-- 1. PRECONDITIONS
-- ══════════════════════════════════════════════════════════════
--
-- This migration assumes a specific starting state. Where the
-- assumption is wrong the transaction ABORTS; it never edits a business
-- row to make itself applicable. A discounted attempt that predates the
-- allocation column cannot be given one after the fact - nobody knows
-- which lines it belonged to - so its existence is a stop, not a repair
-- job.

do $$
declare
  v_discounted_attempts integer;
  v_discounted_orders integer;
  v_writers integer;
begin
  if to_regclass('public.checkout_attempts') is null
     or to_regclass('public.orders') is null
     or to_regclass('public.order_items') is null then
    raise exception '058: expected 004/009 tables are missing - is this the right database?';
  end if;

  -- 057 must be applied: these are the two columns this file builds on.
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'checkout_attempts'
      and column_name = 'discount_gross_cents'
  ) then
    raise exception '058: checkout_attempts.discount_gross_cents is missing - apply 056 and 057 first';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'orders'
      and column_name = 'discount_code'
  ) then
    raise exception '058: orders.discount_code is missing - apply 056 and 057 first';
  end if;

  -- 056's claim table must be gone. If it is still here, 057 was not
  -- applied and the order writer this file replaces is the wrong one.
  if to_regclass('public.launch_discount_claims') is not null then
    raise exception '058: public.launch_discount_claims still exists - 057 has not been applied';
  end if;

  select count(*) into v_discounted_attempts
  from public.checkout_attempts where discount_code is not null;
  if v_discounted_attempts <> 0 then
    raise exception '058: % discounted checkout attempt(s) exist and cannot be given a line allocation retroactively - which lines they belonged to is not recorded anywhere. Resolve by hand before applying.',
      v_discounted_attempts;
  end if;

  select count(*) into v_discounted_orders
  from public.orders
  where discount_code is not null or discount_total_cents <> 0;
  if v_discounted_orders <> 0 then
    raise exception '058: % discounted order(s) exist whose lines carry no discount. This migration does not repair accounting rows.',
      v_discounted_orders;
  end if;

  -- Exactly one order writer, and it is the six-argument one. An
  -- overload would mean the CREATE OR REPLACE below silently added a
  -- second writer instead of replacing the live one.
  select count(*) into v_writers
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'create_order_from_paid_checkout';
  if v_writers <> 1 then
    raise exception '058: public.create_order_from_paid_checkout exists % time(s), expected exactly 1', v_writers;
  end if;
  if to_regprocedure('public.create_order_from_paid_checkout(uuid, jsonb, text, jsonb, jsonb, integer)') is null then
    raise exception '058: the order writer does not have the expected six-argument signature';
  end if;

  -- The annual caller must still be here. If it is not, this database
  -- is not the one 039 was applied to and the signature promise below
  -- is protecting nothing.
  if to_regprocedure('public.fulfill_annual_plan_delivery(uuid, integer)') is null
     and not exists (
       select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'fulfill_annual_plan_delivery'
     ) then
    raise exception '058: public.fulfill_annual_plan_delivery is missing - 039 has not been applied';
  end if;
end $$;

-- ══════════════════════════════════════════════════════════════
-- 2. THE FROZEN ALLOCATION, ON THE ATTEMPT
-- ══════════════════════════════════════════════════════════════
--
-- One entry per authoritative cart line, keyed by variantId:
--
--   [{"variantId": "...", "discountGrossCents": 230}, ...]
--
-- KEYED, NOT ORDERED. The order writer matches on variantId and never
-- on array position - the same rule 057 already follows for the tax
-- snapshot, and for the same reason: the two arrays are built from one
-- quote today, and relying on that would be a silent mis-accounting the
-- day it stops being true. validateQuoteItems merges duplicate variant
-- ids before a quote is built, so one line per variant is guaranteed
-- upstream and a variantId is a usable key.
--
-- AN EXCLUDED LINE IS PRESENT AND ZERO, not absent. The Metal Case, or
-- anything a future catalogue adds outside the allowlist, carries
-- discountGrossCents = 0 - so "this line was considered and got
-- nothing" is distinguishable from "this line was forgotten", and the
-- writer can refuse the second.

alter table public.checkout_attempts
  add column if not exists discount_line_allocation jsonb;

comment on column public.checkout_attempts.discount_line_allocation is
  'The exact per-line discount split, frozen by lib/launchDiscountCart.ts before Stripe was called: [{variantId, discountGrossCents}], one entry per items_snapshot line, excluded lines carried as 0. Never recomputed, and never derived from the percentage. Null on every attempt that used no code.';

-- 057's pairing said code + amount. It now says code + amount +
-- allocation, because an amount nobody can attribute to a line is the
-- thing this migration exists to end.
--
-- VALIDATING, not NOT VALID: all 729 historical attempts carry no code,
-- so they satisfy the first branch and the scan is cheap and proves the
-- table is clean.
--
-- jsonb_typeof is as far as a CHECK can go. PostgreSQL forbids
-- subqueries and set-returning functions inside a CHECK, so "the
-- entries sum to the frozen amount" cannot live here. It lives in the
-- order writer, which is also the honest place for it: that is where a
-- bad allocation would otherwise become a paid order.

alter table public.checkout_attempts
  drop constraint if exists checkout_attempts_discount_snapshot_paired;

alter table public.checkout_attempts
  add constraint checkout_attempts_discount_snapshot_paired
  check (
    (discount_code is null
     and discount_gross_cents is null
     and discount_line_allocation is null)
    or (discount_code is not null
        and discount_gross_cents is not null
        and discount_gross_cents > 0
        and customer_email is not null
        and discount_line_allocation is not null
        and jsonb_typeof(discount_line_allocation) = 'array'
        and jsonb_array_length(discount_line_allocation) > 0)
  );

-- ══════════════════════════════════════════════════════════════
-- 3. THE PER-LINE FACTS, ON THE ORDER ITEM
-- ══════════════════════════════════════════════════════════════
--
-- discount_gross_cents  NOT NULL DEFAULT 0. Zero is a FACT for every
--   existing row: Production has never had a discounted order, so the
--   default states what is true rather than filling a gap. It is also
--   correct by construction for every subscription and annual line -
--   056's checkout_attempts_discount_one_time_only refuses a discount
--   code on any attempt carrying a subscription_id, annual_plan_id or
--   stripe_invoice_id, so those flows cannot produce a non-zero value.
--
-- line_total_tax_cents  NULLABLE, no default, no backfill. The line tax
--   was never stored; it was only ever derivable. For a historical row
--   it is not zero and it is not unknown-in-principle - it simply was
--   not written down, and inventing it now would be fabricating an
--   accounting fact. NULL, exactly as line_total_net_cents has meant
--   "not taxed" since migration 011.
--
-- WHY STORE TAX AT ALL when gross, net and discount would give it? To
-- close the trap in this file's header. After this migration the
-- correct derivation is (gross - discount) - net, and the obvious one
-- (gross - net) is wrong by the discount. Storing the figure the tax
-- engine actually produced removes the choice, and it is what makes the
-- reconciliation below expressible as a database constraint instead of
-- a convention.

alter table public.order_items
  add column if not exists discount_gross_cents integer not null default 0;

alter table public.order_items
  add column if not exists line_total_tax_cents integer;

comment on column public.order_items.discount_gross_cents is
  'What the launch discount took off THIS line, in whole cents, copied from the attempt''s frozen allocation. 0 on every line charged in full - including all 458 order items predating 058, which is a fact about them and not a placeholder.';
comment on column public.order_items.line_total_tax_cents is
  'The tax on this line''s EFFECTIVE gross (line_total_gross_cents - discount_gross_cents), from the frozen tax snapshot. NULL where the destination''s VAT is not implemented - unknown, never a fabricated zero - and NULL on every row predating 058, which was never given one.';

-- A line cannot be discounted by more than it costs. Validating: every
-- existing row is 0 against a non-negative gross.
alter table public.order_items
  drop constraint if exists order_items_discount_within_line;
alter table public.order_items
  add constraint order_items_discount_within_line
  check (discount_gross_cents >= 0
         and discount_gross_cents <= line_total_gross_cents);

-- Matching the shape every other money column in 004 has. Validating:
-- every existing row is NULL.
alter table public.order_items
  drop constraint if exists order_items_line_tax_non_negative;
alter table public.order_items
  add constraint order_items_line_tax_non_negative
  check (line_total_tax_cents is null or line_total_tax_cents >= 0);

-- ── THE RECONCILIATION, AS A CONSTRAINT ─────────────────────
--
--   line_total_gross_cents - discount_gross_cents
--     = line_total_net_cents + line_total_tax_cents
--
-- STRICT: both tax fields present, or both absent. A row with a net but
-- no tax is exactly the half-stated shape this migration exists to stop
-- being creatable.
--
-- NOT VALID, and this is the load-bearing decision of the whole file.
--
-- NOT VALID means PostgreSQL does not scan the existing rows, but DOES
-- enforce the constraint on every INSERT and UPDATE from now on. That
-- is precisely the pair of properties wanted here:
--
--   * The 458 historical order items have a net and no tax. Under the
--     strict rule they do not reconcile - not because they are wrong,
--     but because the tax figure was never recorded. A validating
--     constraint would refuse to be added, and the only ways to add it
--     would be to weaken it into a rule that permits the half-stated
--     shape forever, or to backfill 458 accounting rows with computed
--     numbers. Both are worse than leaving history alone.
--
--   * Every NEW row must satisfy the strict rule in full. There is no
--     window and no grandfathering: the writer below cannot insert a
--     row the constraint rejects.
--
-- This is safe against a later UPDATE too, but only because
-- public.order_items is INSERT-ONLY - the four readers in the
-- application (the account portal, the admin list, the admin detail and
-- the order success lookup) issue SELECTs and nothing else, and no
-- migration in this repository updates it either. Were that to change,
-- an UPDATE of a historical row would be checked and would fail, which
-- is the correct failure: it would mean somebody was editing an
-- accounting record that cannot state its own tax.
--
-- A deliberate future backfill could run VALIDATE CONSTRAINT and close
-- the gap for good. That is a separate decision with the accountant,
-- not something this file assumes.

alter table public.order_items
  drop constraint if exists order_items_effective_gross_reconciles;
alter table public.order_items
  add constraint order_items_effective_gross_reconciles
  check (
    (line_total_net_cents is null and line_total_tax_cents is null)
    or (line_total_net_cents is not null
        and line_total_tax_cents is not null
        and line_total_net_cents + line_total_tax_cents
            = line_total_gross_cents - discount_gross_cents)
  )
  not valid;

-- ══════════════════════════════════════════════════════════════
-- 4. THE ORDER WRITER, REPLACED IN PLACE
-- ══════════════════════════════════════════════════════════════
--
-- SAME SIX-ARGUMENT SIGNATURE as 016, 021, 056 and 057, so this is a
-- true in-place CREATE OR REPLACE: no second overload is left callable,
-- and migration 039's fulfill_annual_plan_delivery keeps working
-- unchanged because its positional call still resolves to this
-- function.
--
-- 057's body is preserved line for line - the paid check, the
-- already-created short circuit, the discount accountability guard, the
-- tax invariants, the frozen-total check, the unique-violation race
-- handler, the variantId matching and every column it writes. THREE
-- THINGS ARE ADDED, and nothing else:
--
--   1. validation of the frozen allocation, before anything is written
--   2. discount_gross_cents on each order item, read from that
--      allocation and from nowhere else
--   3. line_total_tax_cents on each order item, from the same frozen
--      tax snapshot the net already comes from
--
-- NOTHING HERE COMPUTES A DISCOUNT. There is no percentage, no clock,
-- no allowlist and no share arithmetic in this function. It copies what
-- TypeScript froze, and refuses the order if what it froze does not add
-- up.

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
  v_alloc jsonb;
  v_alloc_count integer;
  v_alloc_distinct integer;
  v_alloc_sum integer;
  v_items_count integer;
  v_line_discount integer;
  v_line_gross integer;
  v_line_net integer;
  v_line_tax integer;
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
    -- against a newer tax state. The same is true of its discount - the
    -- amount and its allocation were frozen on the attempt before
    -- Stripe was called, and a redelivery settles the order that exists
    -- rather than re-pricing it.
    return v_order;
  end if;

  -- A DISCOUNTED ATTEMPT MUST STILL BE ACCOUNTABLE. The paired CHECK in
  -- section 2 already guarantees this; the raise is here because a
  -- constraint can be dropped by a later migration and a discounted
  -- order with no amount to account for must fail loudly rather than
  -- quietly become an unexplained reduction.
  if v_attempt.discount_code is not null
     and (v_attempt.customer_email is null
          or v_attempt.discount_gross_cents is null
          or v_attempt.discount_gross_cents <= 0) then
    raise exception 'checkout attempt % carries discount code % without a customer email or a positive amount',
      p_checkout_attempt_id, v_attempt.discount_code;
  end if;

  -- ── THE ALLOCATION IS PROVED BEFORE ANYTHING IS WRITTEN ─────
  --
  -- Every one of these could instead have been a shrug and a zero. A
  -- missing line silently coalesced to 0 would produce an order whose
  -- lines do not sum to its own discount_total_cents - a quiet
  -- accounting error in a paid record, which is worse in every way than
  -- a webhook that retries. Stripe redelivers on a 500; a wrong order
  -- is forever.

  v_alloc := v_attempt.discount_line_allocation;

  if v_attempt.discount_code is null then
    if v_alloc is not null then
      raise exception 'checkout attempt % carries a discount line allocation but no discount code',
        p_checkout_attempt_id;
    end if;
  else
    if v_alloc is null or jsonb_typeof(v_alloc) <> 'array' then
      raise exception 'checkout attempt % is discounted but carries no discount line allocation array',
        p_checkout_attempt_id;
    end if;

    -- Shape: an object per entry, a string variantId, and a
    -- discountGrossCents that is a NON-NEGATIVE INTEGER. The regex is
    -- what rejects 230.5 and -5 in one test: jsonb renders a numeric,
    -- so anything with a sign or a point fails it.
    if exists (
      select 1
      from jsonb_array_elements(v_alloc) as e
      where jsonb_typeof(e) <> 'object'
         or jsonb_typeof(e->'variantId') <> 'string'
         or jsonb_typeof(e->'discountGrossCents') <> 'number'
         or (e->>'discountGrossCents') !~ '^[0-9]+$'
    ) then
      raise exception 'checkout attempt % has a malformed discount line allocation entry', p_checkout_attempt_id;
    end if;

    select count(*), count(distinct e->>'variantId')
      into v_alloc_count, v_alloc_distinct
    from jsonb_array_elements(v_alloc) as e;

    if v_alloc_count <> v_alloc_distinct then
      raise exception 'checkout attempt % allocates a discount to the same variant more than once',
        p_checkout_attempt_id;
    end if;

    select count(*) into v_items_count
    from jsonb_array_elements(v_attempt.items_snapshot) as i;

    if v_alloc_count <> v_items_count then
      raise exception 'checkout attempt % allocates % discount line(s) for % basket line(s)',
        p_checkout_attempt_id, v_alloc_count, v_items_count;
    end if;

    -- Every basket line is represented...
    if exists (
      select 1
      from jsonb_array_elements(v_attempt.items_snapshot) as i
      where not exists (
        select 1 from jsonb_array_elements(v_alloc) as e
        where e->>'variantId' = i->>'variantId'
      )
    ) then
      raise exception 'checkout attempt % has a basket line with no discount allocation entry',
        p_checkout_attempt_id;
    end if;

    -- ...and nothing else is.
    if exists (
      select 1
      from jsonb_array_elements(v_alloc) as e
      where not exists (
        select 1 from jsonb_array_elements(v_attempt.items_snapshot) as i
        where i->>'variantId' = e->>'variantId'
      )
    ) then
      raise exception 'checkout attempt % allocates a discount to a variant that is not in the basket',
        p_checkout_attempt_id;
    end if;

    -- No line may be discounted past its own catalogue value.
    if exists (
      select 1
      from jsonb_array_elements(v_alloc) as e,
           jsonb_array_elements(v_attempt.items_snapshot) as i
      where i->>'variantId' = e->>'variantId'
        and (e->>'discountGrossCents')::integer > (i->>'lineGrossCents')::integer
    ) then
      raise exception 'checkout attempt % allocates more discount to a line than the line is worth',
        p_checkout_attempt_id;
    end if;

    -- And the parts are the whole.
    select coalesce(sum((e->>'discountGrossCents')::integer), 0)
      into v_alloc_sum
    from jsonb_array_elements(v_alloc) as e;

    if v_alloc_sum <> v_attempt.discount_gross_cents then
      raise exception 'checkout attempt % allocates % cents across its lines but froze a discount of % cents',
        p_checkout_attempt_id, v_alloc_sum, v_attempt.discount_gross_cents;
    end if;
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
      discount_total_cents,
      discount_code,
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
      -- STILL THE PRE-DISCOUNT CATALOGUE MERCHANDISE. Unchanged by this
      -- migration, and deliberately: the order level already reconciles
      -- through discount_total_cents, and moving this would break
      -- subtotal - discount + shipping = total.
      v_subtotal_gross_cents,
      -- Still explicitly NULL when no tax was calculated (every non-EU
      -- destination): unknown, never a fabricated zero.
      (v_totals->>'subtotalNetCents')::integer,
      -- Zero, not NULL, when nothing was discounted: no discount is a
      -- real zero rather than an unknown, which is the decision 021
      -- wrote down and 004's NOT NULL default 0 already encoded.
      coalesce(v_attempt.discount_gross_cents, 0),
      v_attempt.discount_code,
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
      -- Its order carries the same frozen discount this one would have
      -- written, because both read the same attempt.
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

    v_line_gross := (v_item->>'lineGrossCents')::integer;

    -- THE LINE'S SHARE OF THE DISCOUNT, from the frozen allocation and
    -- from nowhere else. Matched by variantId, exactly like the tax
    -- line above. NEVER coalesced: section 4's validation has already
    -- proved every basket line has an entry, so a NULL here means that
    -- proof was wrong and the order must not be written.
    if v_attempt.discount_code is null then
      v_line_discount := 0;
    else
      select (alloc->>'discountGrossCents')::integer
        into v_line_discount
      from jsonb_array_elements(v_attempt.discount_line_allocation) as alloc
      where alloc->>'variantId' = v_item->>'variantId'
      limit 1;

      if v_line_discount is null then
        raise exception 'attempt % has no discount allocation for variant % at insert time',
          p_checkout_attempt_id, v_item->>'variantId';
      end if;
    end if;

    v_line_net := (v_tax_item->>'lineNetCents')::integer;
    v_line_tax := (v_tax_item->>'lineTaxCents')::integer;

    -- THE LINE RECONCILES, OR THERE IS NO ORDER.
    --
    -- The constraint added in section 3 would catch this on its own,
    -- but a constraint violation names a constraint and not a reason.
    -- This says which attempt, which variant, and by how much - and it
    -- is the one place where the two independent freezes (the tax
    -- snapshot's discounted line, and the allocation's share of the
    -- catalogue line) are checked against each other.
    if v_line_net is not null or v_line_tax is not null then
      if v_line_net is null or v_line_tax is null then
        raise exception 'attempt % has a half-stated tax line for variant % (net %, tax %)',
          p_checkout_attempt_id, v_item->>'variantId', v_line_net, v_line_tax;
      end if;
      if v_line_net + v_line_tax <> v_line_gross - v_line_discount then
        raise exception 'attempt % line for variant % does not reconcile: % catalogue gross - % discount <> % net + % tax',
          p_checkout_attempt_id, v_item->>'variantId', v_line_gross, v_line_discount, v_line_net, v_line_tax;
      end if;
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
      line_total_tax_cents,
      discount_gross_cents,
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
      -- THE CATALOGUE UNIT AND THE CATALOGUE LINE, unchanged. What the
      -- customer was shown, kept as history, with the reduction now
      -- named beside it instead of implied by a smaller net.
      (v_item->>'unitGrossCents')::integer,
      (v_tax_item->>'unitNetCents')::integer,
      v_line_gross,
      v_line_net,
      v_line_tax,
      v_line_discount,
      (v_tax_item->>'taxRatePercent')::numeric,
      v_tax_item->>'taxCategory',
      jsonb_build_object('sizeGrams', v_item->'sizeGrams', 'currency', v_item->'currency')
    );
  end loop;

  -- AND THAT IS THE WHOLE ORDER. Every line now states four figures
  -- that add up on their own - catalogue gross, the discount taken off
  -- it, the net and the tax - and their discounts sum to the order's
  -- discount_total_cents because the writer refused to proceed unless
  -- they did.
  return v_order;
end;
$$;

-- ══════════════════════════════════════════════════════════════
-- 5. THE ACL, RE-STATED
-- ══════════════════════════════════════════════════════════════
--
-- CREATE OR REPLACE keeps whatever privileges the function already had,
-- so this file must be able to say what that ACL IS rather than inherit
-- it silently. END STATE, NOT A DELTA - the 052/053/057 lesson:
-- everything is revoked from all four names first and exactly one grant
-- is given back.
--
-- NOTHING IS ADDED anywhere in this migration. No policy, no table
-- privilege, no browser access, no new function.

revoke all on function public.create_order_from_paid_checkout(uuid, jsonb, text, jsonb, jsonb, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.create_order_from_paid_checkout(uuid, jsonb, text, jsonb, jsonb, integer)
  to service_role;

-- public.checkout_attempts keeps RLS on with ZERO policies and no
-- grants to anon or authenticated, so discount_line_allocation is
-- server-only by inheritance and no grant statement is needed or
-- wanted.
--
-- public.order_items keeps its TABLE-level `grant select ... to
-- authenticated` from 004 and to service_role from 011, under the
-- ownership-scoped SELECT policy. RECORDED DELIBERATELY: a table-level
-- grant covers columns added later, so discount_gross_cents and
-- line_total_tax_cents become readable by the customer who owns the
-- order - which is correct. They are that customer's own money, the
-- order already shows them the discount as a Rabatt row, and the
-- account portal reads the row with select("*") and will simply carry
-- the new fields. No write access is created for any client role.

-- ══════════════════════════════════════════════════════════════
-- 6. THE END STATE IS PROVEN BEFORE COMMIT
-- ══════════════════════════════════════════════════════════════
--
-- Everything above has run. This block asserts the shape it was
-- supposed to produce, and rolls the whole transaction back if any part
-- of it is not there - so a half-applied 058 cannot be committed and
-- then discovered later by a paid order.

do $$
declare
  v_count integer;
  v_orders_before integer;
  v_items_before integer;
  v_attempts_before integer;
  v_con record;
begin
  -- ── the attempt's allocation ──────────────────────────────
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'checkout_attempts'
      and column_name = 'discount_line_allocation' and data_type = 'jsonb'
  ) then
    raise exception '058: checkout_attempts.discount_line_allocation is missing or not jsonb';
  end if;

  select * into v_con
  from pg_constraint
  where conrelid = 'public.checkout_attempts'::regclass
    and conname = 'checkout_attempts_discount_snapshot_paired';
  if not found then
    raise exception '058: checkout_attempts_discount_snapshot_paired is missing';
  end if;
  if not v_con.convalidated then
    raise exception '058: checkout_attempts_discount_snapshot_paired was not validated';
  end if;
  if position('discount_line_allocation' in pg_get_constraintdef(v_con.oid)) = 0 then
    raise exception '058: the attempt pairing constraint does not mention the allocation';
  end if;

  -- ── the order item's two columns ──────────────────────────
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'order_items'
      and column_name = 'discount_gross_cents'
      and is_nullable = 'NO'
      and column_default = '0'
  ) then
    raise exception '058: order_items.discount_gross_cents is missing, nullable, or not defaulted to 0';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'order_items'
      and column_name = 'line_total_tax_cents'
      and is_nullable = 'YES'
      and column_default is null
  ) then
    raise exception '058: order_items.line_total_tax_cents is missing, NOT NULL, or carries a default';
  end if;

  -- ── the three constraints, and their validation states ────
  for v_con in
    select unnest(array['order_items_discount_within_line',
                        'order_items_line_tax_non_negative']) as name
  loop
    if not exists (
      select 1 from pg_constraint
      where conrelid = 'public.order_items'::regclass
        and conname = v_con.name and convalidated
    ) then
      raise exception '058: % is missing or was not validated', v_con.name;
    end if;
  end loop;

  select * into v_con
  from pg_constraint
  where conrelid = 'public.order_items'::regclass
    and conname = 'order_items_effective_gross_reconciles';
  if not found then
    raise exception '058: order_items_effective_gross_reconciles is missing';
  end if;
  -- NOT VALID ON PURPOSE. If this is ever found validated it means
  -- somebody backfilled or weakened it; either is a decision that
  -- belongs in its own migration, not a surprise here.
  if v_con.convalidated then
    raise exception '058: order_items_effective_gross_reconciles is validated - 058 adds it NOT VALID so the 458 historical rows are neither rewritten nor scanned';
  end if;

  -- ── the writer ────────────────────────────────────────────
  select count(*) into v_count
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'create_order_from_paid_checkout';
  if v_count <> 1 then
    raise exception '058: public.create_order_from_paid_checkout exists % time(s) - an overload would be a second, unreviewed order writer', v_count;
  end if;

  if to_regprocedure('public.create_order_from_paid_checkout(uuid, jsonb, text, jsonb, jsonb, integer)') is null then
    raise exception '058: the order writer no longer has the six-argument signature migration 039 calls positionally';
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'create_order_from_paid_checkout' and p.prosecdef
  ) then
    raise exception '058: public.create_order_from_paid_checkout is not security definer';
  end if;

  -- BOTH SERIALISATIONS OF THE EMPTY search_path ARE ACCEPTED, which is
  -- what 056 and 057 already do - and the first attempt at applying 058
  -- is why their wording is quoted rather than paraphrased here.
  --
  -- This check originally read `proconfig @> array['search_path=']`, and
  -- it aborted a correct migration in Production. The function DOES pin
  -- an empty search_path; this server simply serialises `SET search_path
  -- = ''` into pg_proc.proconfig as
  --
  --     search_path=""
  --
  -- rather than as `search_path=`. A read-only query confirmed it:
  -- prosecdef true, proconfig {"search_path=\"\""}, six arguments.
  --
  -- 056 wrote down the reason in advance: "A check that guessed wrong
  -- would abort a correct migration, which is a worse failure than the
  -- one it was trying to catch." That is exactly what happened, so this
  -- now matches the form that has already applied successfully against
  -- this very database - twice.
  --
  -- NOT WEAKENED. It is still an equality test against the two empty
  -- spellings and nothing else: a NULL proconfig fails, an absent entry
  -- fails, and 'search_path=public' or 'search_path=public,extensions'
  -- fails. What is asserted is the EMPTY VALUE, not one particular way
  -- PostgreSQL happens to store it.
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace,
         unnest(coalesce(p.proconfig, array[]::text[])) as cfg(v)
    where n.nspname = 'public' and p.proname = 'create_order_from_paid_checkout'
      and cfg.v in ('search_path=', 'search_path=""')
  ) then
    raise exception '058: public.create_order_from_paid_checkout does not pin an empty search_path';
  end if;

  -- Exactly one grantee, and it is service_role.
  if exists (
    select 1
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'create_order_from_paid_checkout'
      and (has_function_privilege('anon', p.oid, 'EXECUTE')
           or has_function_privilege('authenticated', p.oid, 'EXECUTE'))
  ) then
    raise exception '058: a browser role can execute the order writer';
  end if;
  if not exists (
    select 1
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'create_order_from_paid_checkout'
      and has_function_privilege('service_role', p.oid, 'EXECUTE')
  ) then
    raise exception '058: service_role cannot execute the order writer';
  end if;

  -- ── AND NOT ONE BUSINESS ROW WAS TOUCHED ──────────────────
  --
  -- The counts this migration expects to find, and to leave exactly as
  -- it found them. There is no INSERT, UPDATE or DELETE against any
  -- business table anywhere above; this proves it rather than asserting
  -- it in a comment.
  select count(*) into v_orders_before from public.orders;
  select count(*) into v_items_before from public.order_items;
  select count(*) into v_attempts_before from public.checkout_attempts;

  if exists (select 1 from public.orders where discount_code is not null or discount_total_cents <> 0) then
    raise exception '058: a discounted order exists after the migration - nothing here should have created one';
  end if;
  if exists (select 1 from public.order_items where discount_gross_cents <> 0) then
    raise exception '058: an order item carries a discount after the migration - the new column must default to 0 for every historical row';
  end if;
  if exists (select 1 from public.order_items where line_total_tax_cents is not null) then
    raise exception '058: an order item carries a line tax after the migration - 058 backfills nothing';
  end if;
  if exists (select 1 from public.checkout_attempts where discount_line_allocation is not null) then
    raise exception '058: a checkout attempt carries a line allocation after the migration - 058 backfills nothing';
  end if;

  raise notice '058 OK: % orders, % order items, % checkout attempts, all unchanged.',
    v_orders_before, v_items_before, v_attempts_before;
end $$;

commit;

-- ══════════════════════════════════════════════════════════════
-- VERIFY AFTER APPLYING (read-only, run separately)
-- ══════════════════════════════════════════════════════════════
--
--   -- the three new/changed constraints and their validation state
--   select conname, convalidated, pg_get_constraintdef(oid)
--     from pg_constraint
--    where conrelid in ('public.order_items'::regclass,
--                       'public.checkout_attempts'::regclass)
--      and conname in ('order_items_discount_within_line',
--                      'order_items_line_tax_non_negative',
--                      'order_items_effective_gross_reconciles',
--                      'checkout_attempts_discount_snapshot_paired');
--   -- expect order_items_effective_gross_reconciles -> convalidated = false
--
--   -- nothing was backfilled
--   select count(*) filter (where discount_gross_cents <> 0)      as discounted_items,
--          count(*) filter (where line_total_tax_cents is not null) as taxed_items,
--          count(*)                                               as total_items
--     from public.order_items;
--   -- expect 0 | 0 | 458
--
--   -- one writer, six arguments, locked down
--   select p.proname, p.prosecdef, p.proconfig,
--          pg_get_function_identity_arguments(p.oid)
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public' and p.proname = 'create_order_from_paid_checkout';
--   -- expect ONE row, prosecdef true, proconfig {"search_path=\"\""},
--   -- and the six arguments unchanged.
