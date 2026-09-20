-- ══════════════════════════════════════════════════════════════
-- 057 — GLOALAUNCH10 BECOMES A REUSABLE CODE
--
-- Migration 056 built a one-use-per-email, first-order-only discount
-- with a claim ledger, a six-state lifecycle and a redemption that was
-- atomic with the order. It is APPLIED TO PRODUCTION and is therefore
-- immutable - which is why this is a 057 and not an edit.
--
-- THE COMMERCIAL DECISION CHANGED. GLOALAUNCH10 is now simply:
--
--   code          GLOALAUNCH10, one open code, anybody who knows it
--   value         10 % of the eligible merchandise
--   window        01.10.2026 12:00 Europe/Berlin (CEST, +02:00)
--                 to 31.10.2026 23:59:59.999 Europe/Berlin (CET, +01:00)
--   scope         the B2C ONE-TIME checkout only
--   eligible      GLOA-MATCHA-30G, GLOA-MATCHA-50G, GLOA-MATCHA-100G
--   not eligible  subscriptions, the prepaid annual plan, B2B, the metal
--                 case, and shipping
--   reuse         AS OFTEN AS THEY LIKE while it is active
--   first order   NO LONGER A CONDITION
--   one use       NO LONGER A CONDITION
--   minimum       none
--   stacking      none
--   shipping      the free-shipping threshold is measured BEFORE the
--                 discount, and shipping itself is never discounted
--
-- ── WHAT THAT DELETES, AND WHY DELETING IT IS THE POINT ───────
--
-- Every mechanism 056 built exists to answer two questions: has this
-- address used the code, and is this their first order. Neither
-- question is asked any more. What is left behind if they are simply
-- ignored is worse than either keeping or removing them: a claim ledger
-- nothing writes, a first-order function nothing calls, and eight
-- SECURITY DEFINER doors that still LOOK like the enforcement of a rule
-- that no longer exists. The next person to read this schema would
-- reasonably conclude the shop still limits the code.
--
-- So the claim architecture is removed rather than orphaned:
--
--   the ledger          public.launch_discount_claims - 0 rows in
--                       production, referenced by nothing else
--   the claim doors     claim / session_creating / session_open /
--                       payment_pending / three releases / redeem
--   the first-order     launch_discount_is_first_order, called only by
--   query               claim_launch_discount
--   its index           idx_orders_paid_customer_email_created_at,
--                       built exclusively for that query
--   the attempt's       checkout_attempts.discount_claim_id, which held
--   claim token         the token - 0 non-null values in production
--
-- ── WHAT SURVIVES, AND WHY ────────────────────────────────────
--
-- The money and its accounting, which were never about the limit:
--
--   checkout_attempts.discount_code          which code was applied
--   checkout_attempts.discount_gross_cents   what it was worth, frozen
--   orders.discount_code                     which code reduced it
--   orders.discount_total_cents              by how much (004's column)
--
-- and the three constraints that keep them honest:
--
--   checkout_attempts_discount_code_known     one code, spelled one way
--   checkout_attempts_discount_one_time_only  never a subscription, a
--                                             renewal invoice or one of
--                                             the annual boxes
--   orders_discount_code_paired               an amount and a name, or
--                                             neither
--
-- ── THE ONE THING THE PAIRED CHECK KEEPS ──────────────────────
--
-- customer_email. It is no longer a limit on anything - the code is
-- reusable - but since 055 the normalised checkout email IS the
-- authoritative B2C identity, and a discounted order that cannot be
-- attributed to one would be a reduction with nobody's name on it. The
-- claim id half of the old constraint goes; this half stays.
--
-- ── ORDER OF OPERATIONS, WHICH IS LOAD-BEARING ────────────────
--
-- create_order_from_paid_checkout calls redeem_launch_discount. So the
-- writer is REPLACED FIRST, in place and under the same six-argument
-- signature, and only then is the redemption dropped. Reversed, there
-- would be a moment inside this transaction where the live order writer
-- referenced a function that no longer exists.
--
-- Nothing is backfilled, nothing is deleted from a business table, no
-- order is recalculated, no price moves and SHOP_STATUS is not this
-- file's business. Production carries 0 claims, 0 discounted attempts
-- and 0 discounted orders, so every drop below is a drop of capacity
-- that was never used.
--
-- ── AND NO RUNTIME DEPENDS ON ANY OF IT ───────────────────────
--
-- 056 was phase A and stayed phase A: not one line of this repository
-- reads or writes a claim, a session state or the first-order function.
-- The suite proves it. That is what makes this cleanup a schema change
-- with no application change, and why the order writer's signature must
-- not move: lib/orderFulfillment.ts calls it with exactly six arguments
-- and knows nothing about any of this.
-- ══════════════════════════════════════════════════════════════

begin;

-- ══════════════════════════════════════════════════════════════
-- 1. THE ATTEMPT KEEPS TWO COLUMNS, NOT THREE
-- ══════════════════════════════════════════════════════════════
--
-- 056's constraint required a claim token on every discounted attempt.
-- It is replaced rather than loosened in place, because a CHECK is
-- replaced by dropping and re-adding it and doing that in two visible
-- statements is clearer than pretending there is an ALTER for it.
--
-- The new shape says exactly what a discounted attempt must now be:
--
--   UNDISCOUNTED  both columns null
--   DISCOUNTED    a code, a positive amount, and an address to
--                 attribute it to
--
-- The column drop itself waits until section 5: the constraint has to
-- stop referencing it first, and so does the order writer.

alter table public.checkout_attempts
  drop constraint if exists checkout_attempts_discount_snapshot_paired;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.checkout_attempts'::regclass
      and conname = 'checkout_attempts_discount_snapshot_paired'
  ) then
    alter table public.checkout_attempts
      add constraint checkout_attempts_discount_snapshot_paired
      check (
        (discount_code is null
         and discount_gross_cents is null)
        or (discount_code is not null
            and discount_gross_cents is not null
            and discount_gross_cents > 0
            and customer_email is not null)
      );
  end if;
end $$;

comment on column public.checkout_attempts.discount_gross_cents is
  'What the launch discount was worth, frozen before Stripe was called. Folded into the line amounts, never sent as a Stripe promotion code. No claim, no reservation: the code is reusable.';

-- ══════════════════════════════════════════════════════════════
-- 2. THE ORDER WRITER, WITHOUT THE REDEMPTION
-- ══════════════════════════════════════════════════════════════
--
-- SAME SIX-ARGUMENT SIGNATURE as 016, 021 and 056, so this is a true
-- in-place CREATE OR REPLACE: no second overload is left callable and
-- no caller changes. The body is 056's, and every line that is not
-- about the claim is byte-for-byte what production is running today -
-- the tax invariants, the frozen-total check, the immutability of an
-- already created order, the unique-violation race handler, the
-- per-line variant matching and the discount columns it copies onto the
-- order.
--
-- FOUR THINGS GO, AND NOTHING ELSE:
--
--   1. the v_redemption variable
--   2. the redeem_launch_discount call
--   3. the claim-id half of the accountability guard
--   4. the warning that read the redemption's outcome
--
-- WHAT THE GUARD STILL REFUSES. A discounted attempt with no amount, a
-- non-positive amount, or no address still aborts the order rather than
-- writing a reduction nobody can explain. The paired CHECK in section 1
-- already guarantees all three; this is the second lock, kept for the
-- reason 056 kept it - a constraint can be dropped by a later
-- migration, and a paid order is the wrong place to find out.

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
    -- against a newer tax state. The same is true of its discount - the
    -- amount was frozen on the attempt before Stripe was called, and a
    -- redelivery settles the order that exists rather than re-pricing
    -- it.
    return v_order;
  end if;

  -- A DISCOUNTED ATTEMPT MUST STILL BE ACCOUNTABLE. The paired CHECK in
  -- section 1 already guarantees this; the raise is here because a
  -- constraint can be dropped by a later migration and a discounted
  -- order with no amount to account for must fail loudly rather than
  -- quietly become an unexplained reduction.
  --
  -- The claim id is gone from this test and from the table, because the
  -- code is reusable and there is nothing to hold. The address is not:
  -- a discounted order stays attributable to the identity 055 froze,
  -- whether or not that identity limits anything.
  if v_attempt.discount_code is not null
     and (v_attempt.customer_email is null
          or v_attempt.discount_gross_cents is null
          or v_attempt.discount_gross_cents <= 0) then
    raise exception 'checkout attempt % carries discount code % without a customer email or a positive amount',
      p_checkout_attempt_id, v_attempt.discount_code;
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

  -- AND THAT IS THE WHOLE ORDER. No claim is spent, nothing is reserved
  -- and no second table is written: a reusable code has no ledger to
  -- update, so the discount is finished the moment the two columns
  -- above are on the row.
  return v_order;
end;
$$;

-- ══════════════════════════════════════════════════════════════
-- 3. THE CLAIM DOORS ARE CLOSED AND REMOVED
-- ══════════════════════════════════════════════════════════════
--
-- redeem_launch_discount FIRST, and only now: section 2 has already
-- replaced its one caller. Dropping it earlier would have left the live
-- order writer pointing at a function that no longer existed for the
-- rest of this transaction.
--
-- The other eight had no caller at all. 056 granted EXECUTE on seven of
-- them to service_role and on none of them to a browser role; dropping
-- a function takes its ACL with it, so there is nothing to revoke
-- afterwards and nothing left for anybody to call.
--
-- Exact signatures, because a bare name would refuse to drop if an
-- overload had ever been created - and 056's own pre-commit block
-- proved there is exactly one of each.

drop function if exists public.redeem_launch_discount(text, text, uuid, uuid, uuid);
drop function if exists public.claim_launch_discount(text, text, uuid, uuid, integer);
drop function if exists public.mark_launch_discount_session_creating(text, text, uuid, uuid);
drop function if exists public.mark_launch_discount_session_open(text, text, uuid, uuid, text);
drop function if exists public.mark_launch_discount_payment_pending(text, text, uuid, uuid);
drop function if exists public.release_launch_discount(text, text, uuid, uuid);
drop function if exists public.release_launch_discount_after_expired_session(text, text, uuid, uuid, text);
drop function if exists public.release_launch_discount_after_failed_payment(text, text, uuid, uuid);

-- The first-order query, whose only caller was claim_launch_discount
-- and whose only reason to exist was the condition that has been
-- dropped.
drop function if exists public.launch_discount_is_first_order(text);

-- ══════════════════════════════════════════════════════════════
-- 4. THE LEDGER ITSELF
-- ══════════════════════════════════════════════════════════════
--
-- 0 rows in production, and now 0 functions that could write one. The
-- table takes its own dependents with it: the state-shape CHECK, the
-- code and customer-key CHECKs, the conflicts CHECK, the
-- set_launch_discount_claims_updated_at trigger, its RLS setting and
-- its two foreign keys into checkout_attempts and orders.
--
-- Deliberately NOT cascade. Nothing outside the table depends on it -
-- the foreign keys point OUT of it, not in - so a plain drop is both
-- sufficient and honest: if something unexpected did depend on it, this
-- migration should fail here rather than quietly remove that too.

drop table if exists public.launch_discount_claims;

-- ══════════════════════════════════════════════════════════════
-- 5. THE ATTEMPT'S CLAIM TOKEN
-- ══════════════════════════════════════════════════════════════
--
-- Last of the three, and in this order on purpose: the constraint that
-- required it was replaced in section 1, the order writer that read it
-- was replaced in section 2, and the functions that minted it are gone.
-- Production holds 0 non-null values.

alter table public.checkout_attempts
  drop column if exists discount_claim_id;

-- ══════════════════════════════════════════════════════════════
-- 6. THE FIRST-ORDER INDEX
-- ══════════════════════════════════════════════════════════════
--
-- A partial index on the normalised email of paid orders, built for one
-- question that is no longer asked. Nothing else in this schema uses
-- it, and an index kept "in case" is an index nobody knows the purpose
-- of the next time somebody reads the table. Re-creating it later is
-- one statement.

drop index if exists public.idx_orders_paid_customer_email_created_at;

-- ══════════════════════════════════════════════════════════════
-- 7. WHO MAY CALL WHAT
-- ══════════════════════════════════════════════════════════════
--
-- One function is left to have an opinion about, and its ACL is
-- re-stated rather than inherited: CREATE OR REPLACE keeps whatever
-- privileges the function already had, so this file must be able to say
-- what that ACL IS.
--
-- END STATE, NOT A DELTA - the 052/053 lesson. Everything is revoked
-- from all four names first and exactly one grant is given back.
--
-- NOTHING IS ADDED. No policy, no table privilege, no browser access.
-- After this migration there is no launch-discount RPC of any kind for
-- anybody to call, which is the strongest form the security model can
-- take: the doors are not locked, they are gone.

revoke all on function public.create_order_from_paid_checkout(uuid, jsonb, text, jsonb, jsonb, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.create_order_from_paid_checkout(uuid, jsonb, text, jsonb, jsonb, integer)
  to service_role;

-- ══════════════════════════════════════════════════════════════
-- 8. THE END STATE IS PROVEN BEFORE COMMIT
-- ══════════════════════════════════════════════════════════════
--
-- Asserting the RESULT rather than counting what changed, so a second
-- run passes unchanged. A half-applied cleanup is the one outcome worth
-- refusing: an order writer that still redeems, or a ledger that half
-- exists, is worse than either end of this migration.

do $$
declare
  v_name  text;
  v_check text;
begin
  -- ── THE CLAIM ARCHITECTURE IS GONE ──────────────────────────
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'launch_discount_claims'
  ) then
    raise exception '057: public.launch_discount_claims still exists - the one-use ledger was not removed';
  end if;

  for v_name in
    select unnest(array['claim_launch_discount',
                        'redeem_launch_discount',
                        'launch_discount_is_first_order',
                        'mark_launch_discount_session_creating',
                        'mark_launch_discount_session_open',
                        'mark_launch_discount_payment_pending',
                        'release_launch_discount',
                        'release_launch_discount_after_expired_session',
                        'release_launch_discount_after_failed_payment'])
  loop
    if exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = v_name
    ) then
      raise exception '057: public.% still exists - a claim door survived the cleanup', v_name;
    end if;
  end loop;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'checkout_attempts'
      and column_name = 'discount_claim_id'
  ) then
    raise exception '057: checkout_attempts.discount_claim_id still exists - the attempt still carries a claim token';
  end if;

  if exists (
    select 1 from pg_indexes
    where schemaname = 'public' and indexname = 'idx_orders_paid_customer_email_created_at'
  ) then
    raise exception '057: the first-order index still exists - nothing asks that question any more';
  end if;

  -- ── THE MONEY AND ITS ACCOUNTING SURVIVE ────────────────────
  for v_name in
    select unnest(array['discount_code', 'discount_gross_cents'])
  loop
    if not exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'checkout_attempts'
        and column_name = v_name
    ) then
      raise exception '057: checkout_attempts lost column %', v_name;
    end if;
  end loop;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'orders' and column_name = 'discount_code'
  ) then
    raise exception '057: orders lost column discount_code';
  end if;

  for v_name in
    select unnest(array['checkout_attempts_discount_code_known',
                        'checkout_attempts_discount_one_time_only',
                        'checkout_attempts_discount_snapshot_paired'])
  loop
    if not exists (
      select 1 from pg_constraint
      where conrelid = 'public.checkout_attempts'::regclass and conname = v_name
    ) then
      raise exception '057: checkout_attempts is missing constraint %', v_name;
    end if;
  end loop;

  for v_name in
    select unnest(array['orders_discount_code_known', 'orders_discount_code_paired'])
  loop
    if not exists (
      select 1 from pg_constraint
      where conrelid = 'public.orders'::regclass and conname = v_name
    ) then
      raise exception '057: orders is missing constraint %', v_name;
    end if;
  end loop;

  -- ── AND THE NEW SHAPE SAYS WHAT IT SHOULD ───────────────────
  select pg_get_constraintdef(oid) into v_check
  from pg_constraint
  where conrelid = 'public.checkout_attempts'::regclass
    and conname = 'checkout_attempts_discount_snapshot_paired';

  if position('discount_claim_id' in v_check) > 0 then
    raise exception '057: the discount snapshot constraint still requires a claim token';
  end if;
  if position('customer_email' in v_check) = 0 then
    raise exception '057: a discounted attempt is no longer attributable to a customer email';
  end if;

  -- ── THE ORDER WRITER IS INTACT, AND ALONE ───────────────────
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'create_order_from_paid_checkout') <> 1 then
    raise exception '057: public.create_order_from_paid_checkout does not exist exactly once - an overload would be a second, unreviewed order writer';
  end if;

  if not (select p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'create_order_from_paid_checkout') then
    raise exception '057: public.create_order_from_paid_checkout is not security definer';
  end if;

  -- Both serialisations of the EMPTY search_path are accepted, for the
  -- reason 056 wrote down: what is asserted is the empty value, not one
  -- particular way PostgreSQL happens to store it. 'search_path=public'
  -- still fails, which is the thing that matters.
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace,
         unnest(coalesce(p.proconfig, array[]::text[])) as cfg(v)
    where n.nspname = 'public' and p.proname = 'create_order_from_paid_checkout'
      and cfg.v in ('search_path=', 'search_path=""')
  ) then
    raise exception '057: public.create_order_from_paid_checkout does not pin an empty search_path';
  end if;

  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'create_order_from_paid_checkout'
      and (has_function_privilege('anon', p.oid, 'execute')
           or has_function_privilege('authenticated', p.oid, 'execute'))
  ) then
    raise exception '057: a browser role may execute the order writer';
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'create_order_from_paid_checkout'
      and has_function_privilege('service_role', p.oid, 'execute')
  ) then
    raise exception '057: service_role cannot execute the order writer';
  end if;

  -- ── AND NOTHING MOVED ───────────────────────────────────────
  -- This migration removes capacity, not data. Production carries no
  -- discounted attempt and no discounted order, and none is created,
  -- deleted or rewritten here.
  if exists (select 1 from public.checkout_attempts where discount_code is not null) then
    raise exception '057: an attempt was backfilled with a discount code';
  end if;

  if exists (select 1 from public.orders where discount_code is not null) then
    raise exception '057: an order was backfilled with a discount code';
  end if;

  if exists (select 1 from public.orders where discount_total_cents <> 0) then
    raise exception '057: an order was backfilled with a discount amount';
  end if;
end $$;

commit;

-- ══════════════════════════════════════════════════════════════
-- VERIFYING THIS MIGRATION, read-only:
--
--   1. THE CLAIM ARCHITECTURE IS GONE. All three must return NO ROWS:
--        select to_regclass('public.launch_discount_claims');   -> null
--        select proname from pg_proc p
--        join pg_namespace n on n.oid = p.pronamespace
--        where n.nspname = 'public'
--          and (proname like '%launch_discount%');
--        select column_name from information_schema.columns
--        where table_schema = 'public' and table_name = 'checkout_attempts'
--          and column_name = 'discount_claim_id';
--
--   1b. And the index built for the first-order question:
--        select indexname from pg_indexes
--        where schemaname = 'public'
--          and indexname = 'idx_orders_paid_customer_email_created_at';
--      -> NO ROWS.
--
--   2. THE MONEY SURVIVED. Two columns on the attempt, two on the order:
--        select column_name from information_schema.columns
--        where table_schema = 'public' and table_name = 'checkout_attempts'
--          and column_name in ('discount_code', 'discount_gross_cents')
--        order by column_name;
--      -> discount_code, discount_gross_cents
--        select column_name from information_schema.columns
--        where table_schema = 'public' and table_name = 'orders'
--          and column_name in ('discount_code', 'discount_total_cents')
--        order by column_name;
--      -> discount_code, discount_total_cents
--
--   3. THE NEW SHAPE OF A DISCOUNTED ATTEMPT:
--        select pg_get_constraintdef(oid) from pg_constraint
--        where conrelid = 'public.checkout_attempts'::regclass
--          and conname = 'checkout_attempts_discount_snapshot_paired';
--      -> mentions discount_code, discount_gross_cents and
--         customer_email, and does NOT mention discount_claim_id.
--
--   3b. And the two scope constraints are untouched:
--        select conname from pg_constraint
--        where conrelid = 'public.checkout_attempts'::regclass
--          and conname in ('checkout_attempts_discount_code_known',
--                          'checkout_attempts_discount_one_time_only')
--        order by conname;
--
--   4. THE ORDER WRITER: one row, security definer, empty search_path,
--      service_role only.
--        select p.proname, p.prosecdef, p.proconfig,
--               has_function_privilege('service_role',  p.oid, 'execute') as service_role,
--               has_function_privilege('anon',          p.oid, 'execute') as anon,
--               has_function_privilege('authenticated', p.oid, 'execute') as authenticated
--        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--        where n.nspname = 'public' and p.proname = 'create_order_from_paid_checkout';
--      -> exactly ONE row, prosecdef true, proconfig {search_path=},
--         service_role true, anon false, authenticated false.
--
--   4b. AND IT NO LONGER REDEEMS ANYTHING:
--        select pg_get_functiondef('public.create_order_from_paid_checkout(uuid, jsonb, text, jsonb, jsonb, integer)'::regprocedure);
--      -> no redeem_launch_discount, no discount_claim_id, no
--         v_redemption. It still copies discount_total_cents and
--         discount_code onto the order.
--
--   5. NOTHING ELSE MOVED. This migration removes capacity, not data:
--        select count(*) from public.checkout_attempts;       -> unchanged (729)
--        select count(*) from public.orders;                  -> unchanged (458)
--        select count(*) from public.order_items;             -> unchanged (458)
--        select count(*) from public.subscriptions;           -> unchanged (4)
--        select count(*) from public.stripe_customers;        -> unchanged (3)
--        select count(*) from public.product_variants;        -> unchanged (4)
--        select count(*) from public.checkout_customer_identities; -> unchanged (0)
--      And nothing carries a discount:
--        select count(*) from public.checkout_attempts
--        where discount_code is not null;                     -> 0
--        select count(*) from public.orders
--        where discount_code is not null;                     -> 0
--        select count(*) from public.orders
--        where discount_total_cents <> 0;                     -> 0
--
--   6. AND THE SHOP IS STILL SHUT. 057 does not open it, and does not
--      wire a single line of runtime:
--        SHOP_STATUS in app/content.ts is still "prelaunch", and no
--        module in this repository references a discount column, a
--        discount code field or a claim function. The runtime half is a
--        later package.
-- ══════════════════════════════════════════════════════════════
