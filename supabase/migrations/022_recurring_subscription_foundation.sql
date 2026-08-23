-- ============================================================
-- GLOA – Recurring Subscription Foundation (Task 29D-B)
-- Run in Supabase SQL Editor AFTER 021
--
-- The database half of B2C recurring subscriptions. It creates NO Stripe
-- object, seeds NO plan, and processes NO webhook: those belong to later
-- phases. What it establishes is the part that has to be right before any
-- of that can be built safely.
--
-- The lifecycle this encodes:
--
--   1. An authenticated server route prices a subscription completely -
--      catalog price, cadence, shipping, tax - and calls
--      create_pending_subscription. The row exists, frozen, in status
--      'pending' BEFORE Stripe is ever contacted. That is what makes
--      every later Stripe event resolvable against trusted local data
--      rather than against anything a browser or a webhook payload says.
--
--   2. Only a paid invoice activates it. activate_subscription_from_invoice
--      moves 'pending' to 'active' and creates exactly one checkout
--      attempt for that invoice. checkout.session.completed must never
--      perform that transition on its own - payment activation belongs to
--      invoice.paid alone.
--
--   3. The order itself is still created by create_order_from_paid_checkout
--      from migration 021, unchanged. A subscription renewal becomes an
--      ordinary paid checkout attempt and then an ordinary order, so the
--      tax snapshot, the shipping snapshot and the one-order-per-attempt
--      guarantee are reused rather than reimplemented.
--
-- Historical data is not touched. No UPDATE runs against existing rows,
-- no address is rewritten, and no existing constraint is weakened.
-- ============================================================

-- 1. ONE STRIPE INVOICE, AT MOST ONE CHECKOUT ATTEMPT ──────────
--
-- The idempotency anchor for every recurring cycle. request_id stays what
-- it is (a client-generated uuid for the one-time flow), because a Stripe
-- invoice id is not a uuid and forcing one into that column would only
-- hide what the value actually is.
--
-- Partial unique: every existing one-time attempt keeps NULL here, and
-- NULLs do not collide, so no historical row is affected.

alter table public.checkout_attempts
  add column stripe_invoice_id text,
  -- Which local subscription this attempt bills. NULL for every one-time
  -- checkout, so no existing row needs a backfill and none is rewritten.
  --
  -- Deliberately NOT unique: each renewal invoice produces another attempt
  -- for the same subscription, which is the normal case rather than a
  -- conflict. Its job is correlation, and it is what lets the activation
  -- function prove an invoice belongs to THIS subscription. Comparing
  -- owners would not do: one customer may hold several subscriptions, and
  -- subscription A's invoice must never be accepted as B's work merely
  -- because both are theirs.
  --
  -- No index: nothing looks an attempt up by subscription today, and the
  -- only reader is the row already located by stripe_invoice_id. One can
  -- be added when a query actually needs it.
  add column subscription_id uuid references public.subscriptions(id);

create unique index checkout_attempts_stripe_invoice_id_key
  on public.checkout_attempts (stripe_invoice_id)
  where stripe_invoice_id is not null;

-- 2. STRIPE SUBSCRIPTION IDENTIFIER ────────────────────────────
--
-- How a Stripe lifecycle event finds its GLOA row. Deliberately NOT a
-- stripe_customer_id: a Stripe Customer belongs to the person, not to one
-- of their subscriptions, and duplicating it per subscription would
-- guarantee drift. It lives in stripe_customers below.

alter table public.subscriptions
  add column stripe_subscription_id text;

create unique index subscriptions_stripe_subscription_id_key
  on public.subscriptions (stripe_subscription_id)
  where stripe_subscription_id is not null;

-- 3. THE FROZEN TAX SNAPSHOT ───────────────────────────────────
--
-- Required, not convenience. The aggregate money columns on this table
-- cannot reproduce a renewal order: create_order_from_paid_checkout reads
-- treatment, jurisdiction, calculation version, the per-rate breakdown,
-- the shipping apportionment and each line's tax category out of the
-- snapshot document. Without it every renewal order would record NULL tax
-- metadata, which is exactly the fabricated-unknown Task 21D exists to
-- prevent. Same column, same shape and same purpose as
-- checkout_attempts.tax_snapshot.

alter table public.subscriptions
  add column tax_snapshot jsonb;

-- 4. STRIPE CUSTOMER MAPPING ───────────────────────────────────
--
-- One GLOA user, one Stripe Customer. The primary key enforces that a
-- user cannot acquire a second Customer, and the unique constraint that a
-- Customer cannot be shared between users - which is what stops a Stripe
-- identifier from ever becoming a path into another account.
--
-- Server-only, in the same shape as stripe_webhook_events: RLS on, no
-- policies at all, and no grant to anon or authenticated. It is not that
-- the browser is denied a row it can see; the table is invisible to
-- client roles entirely. Identity is the GLOA user id, never an email.
--
-- The mapping is deleted with the user. The Stripe Customer itself is
-- not, and must not be: it carries invoices that have to survive for
-- accounting.

create table public.stripe_customers (
  user_id            uuid primary key references auth.users(id) on delete cascade,
  stripe_customer_id text not null unique,
  created_at         timestamptz not null default now()
);

alter table public.stripe_customers enable row level security;

-- No policies. No grants to anon or authenticated. Only server-side code
-- holding the service-role key reaches this table.
grant select, insert on public.stripe_customers to service_role;

-- 5. SUBSCRIPTION STATUS ───────────────────────────────────────
--
-- Extended by exactly two values, both of which a real failed renewal
-- produces and which the current constraint cannot express:
--
--   past_due  Stripe is retrying a failed renewal payment.
--   unpaid    Stripe's retry schedule gave up.
--
-- Nothing is removed and nothing is renamed. In particular 'cancelled'
-- keeps its British spelling, which the whole codebase uses; the Stripe
-- value 'canceled' is translated in application code, not by rewriting a
-- constraint and every row behind it.
--
-- Deliberately NOT added: trialing, incomplete, incomplete_expired.
-- Not because no local row exists yet - one does: create_pending_subscription
-- writes it before Stripe Checkout, and a failed or abandoned first
-- payment simply leaves it sitting in 'pending' forever. The reason is
-- that those Stripe states are not mapped into the GLOA lifecycle for the
-- minimum launch: a subscription is either waiting for its first paid
-- invoice ('pending') or it has had one ('active'). 'paused' stays in the
-- constraint from 005 but is not a launch feature and is never written.

alter table public.subscriptions
  drop constraint if exists subscriptions_status_check;

alter table public.subscriptions
  add constraint subscriptions_status_check
  check (status in (
    'pending', 'active', 'paused', 'cancelled', 'past_due', 'unpaid'
  ));

-- 6. CREATE THE PENDING SUBSCRIPTION ───────────────────────────
--
-- Called by an authenticated server route that has ALREADY resolved every
-- commercial value: the catalog price, the delivery cadence from an
-- active plan, the shipping zone from a verified address, and the tax
-- treatment. Nothing here reads a price or trusts an amount that was not
-- computed server-side - this function stores an already-made decision,
-- it does not make one.
--
-- The money columns are derived from the tax snapshot rather than passed
-- separately, for the same reason the order RPC derives them: two copies
-- of the same total are two chances to disagree. A destination whose VAT
-- is not implemented therefore cannot become a subscription at all, which
-- is the correct outcome - we cannot bill monthly for something we cannot
-- tax.
--
-- Parent and items are one transaction. A subscription with no items
-- would be a priced agreement for nothing, and the four NOT NULL
-- snapshots make a half-written row impossible to repair afterwards.

create or replace function public.create_pending_subscription(
  p_user_id uuid,
  p_plan_id uuid,
  p_plan_snapshot jsonb,
  p_customer_snapshot jsonb,
  p_shipping_address_snapshot jsonb,
  p_billing_address_snapshot jsonb,
  p_tax_snapshot jsonb,
  p_items jsonb
)
returns uuid
language plpgsql
volatile
security definer set search_path = ''
as $$
declare
  v_totals jsonb;
  v_subscription public.subscriptions;
  v_item jsonb;
  v_tax_item jsonb;
begin
  if p_user_id is null then
    raise exception 'a subscription needs an owner';
  end if;

  if p_tax_snapshot is null or p_tax_snapshot->'totals' is null then
    raise exception 'a subscription needs a tax snapshot; an untaxable destination cannot be billed recurrently';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'a subscription needs at least one item';
  end if;

  if p_plan_snapshot is null
     or p_customer_snapshot is null
     or p_shipping_address_snapshot is null
     or p_billing_address_snapshot is null then
    raise exception 'a subscription needs its plan, customer, shipping and billing snapshots';
  end if;

  v_totals := p_tax_snapshot->'totals';

  insert into public.subscriptions (
    user_id,
    customer_type,
    plan_id,
    status,
    currency,
    customer_snapshot,
    shipping_address_snapshot,
    billing_address_snapshot,
    plan_snapshot,
    tax_snapshot,
    subtotal_net_cents,
    subtotal_gross_cents,
    shipping_net_cents,
    shipping_gross_cents,
    tax_total_cents,
    total_net_cents,
    total_gross_cents
  ) values (
    p_user_id,
    'private',
    p_plan_id,
    'pending',
    'EUR',
    p_customer_snapshot,
    p_shipping_address_snapshot,
    p_billing_address_snapshot,
    p_plan_snapshot,
    p_tax_snapshot,
    (v_totals->>'subtotalNetCents')::integer,
    (v_totals->>'subtotalGrossCents')::integer,
    (v_totals->>'shippingNetCents')::integer,
    (v_totals->>'shippingGrossCents')::integer,
    (v_totals->>'taxTotalCents')::integer,
    (v_totals->>'totalNetCents')::integer,
    (v_totals->>'totalGrossCents')::integer
  )
  returning * into v_subscription;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    -- Matched on variantId, not position, for the same reason order
    -- creation does: the two arrays come from one calculation, but
    -- depending on their order would be a silent mis-pricing the day
    -- that stops being true.
    select tax_item into v_tax_item
    from jsonb_array_elements(coalesce(p_tax_snapshot->'items', '[]'::jsonb)) as tax_item
    where tax_item->>'variantId' = v_item->>'variantId'
    limit 1;

    if v_tax_item is null then
      raise exception 'tax snapshot has no line for variant %', v_item->>'variantId';
    end if;

    insert into public.subscription_items (
      subscription_id,
      product_reference,
      sku,
      product_name,
      variant_name,
      quantity,
      unit_price_net_cents,
      unit_price_gross_cents,
      tax_rate_percent,
      line_total_net_cents,
      line_total_gross_cents,
      metadata
    ) values (
      v_subscription.id,
      v_item->>'variantId',
      v_item->>'sku',
      v_item->>'productName',
      v_item->>'variantLabel',
      (v_item->>'quantity')::integer,
      (v_tax_item->>'unitNetCents')::integer,
      (v_item->>'unitGrossCents')::integer,
      (v_tax_item->>'taxRatePercent')::numeric,
      (v_tax_item->>'lineNetCents')::integer,
      (v_item->>'lineGrossCents')::integer,
      jsonb_build_object('sizeGrams', v_item->'sizeGrams', 'currency', v_item->'currency')
    );
  end loop;

  return v_subscription.id;
end;
$$;

revoke all on function public.create_pending_subscription(uuid, uuid, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb) from public;
grant execute on function public.create_pending_subscription(uuid, uuid, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb) to service_role;

-- 7. ACTIVATE FROM A PAID INVOICE ──────────────────────────────
--
-- The future invoice.paid handler's single database write. It takes only
-- identifiers and timestamps: every price, tax figure, item, quantity and
-- address comes from the subscription row that was frozen before payment.
-- A webhook payload is never a source of commercial truth here, only a
-- source of "which subscription, which invoice, which period".
--
-- Idempotency is the database's job, in two places. The checkout attempt
-- is looked up by stripe_invoice_id under the subscription's row lock,
-- and the unique index behind it is what actually decides the race - a
-- concurrent redelivery that slips past the lookup hits unique_violation
-- and is answered with the winner's row, not with a second attempt. One
-- invoice therefore yields at most one attempt, and the unique index from
-- migration 011 turns that into at most one order.
--
-- The order itself is NOT created here. create_order_from_paid_checkout
-- remains the one function that creates orders.

create or replace function public.activate_subscription_from_invoice(
  p_subscription_id uuid,
  p_stripe_subscription_id text,
  p_stripe_invoice_id text,
  p_current_period_start timestamptz,
  p_current_period_end timestamptz,
  p_next_delivery_at timestamptz
)
returns uuid
language plpgsql
volatile
security definer set search_path = ''
as $$
declare
  v_subscription public.subscriptions;
  v_attempt public.checkout_attempts;
  v_items jsonb;
begin
  if p_subscription_id is null or p_stripe_invoice_id is null then
    raise exception 'activation needs a subscription and an invoice';
  end if;

  select * into v_subscription
  from public.subscriptions
  where id = p_subscription_id
  for update;

  if not found then
    raise exception 'subscription % not found', p_subscription_id;
  end if;

  -- A cancelled subscription is not revived by a late invoice. Every
  -- other state a paid invoice can legitimately arrive in - the first
  -- payment, a normal renewal, or a recovery after a failed one - is
  -- allowed to become active.
  if v_subscription.status not in ('pending', 'active', 'past_due', 'unpaid') then
    raise exception 'subscription % cannot be activated from status %', p_subscription_id, v_subscription.status;
  end if;

  -- The Stripe subscription is bound once. A different id arriving later
  -- means two Stripe subscriptions are pointing at one local row, which
  -- must never be quietly accepted.
  if v_subscription.stripe_subscription_id is not null
     and p_stripe_subscription_id is not null
     and v_subscription.stripe_subscription_id <> p_stripe_subscription_id then
    raise exception 'subscription % is already bound to a different stripe subscription', p_subscription_id;
  end if;

  -- Has this invoice already been handled? Asked BEFORE anything is
  -- written, so a redelivery cannot move lifecycle state a second time
  -- and a mismatched pair cannot mutate a subscription at all.
  select * into v_attempt
  from public.checkout_attempts
  where stripe_invoice_id = p_stripe_invoice_id;

  if found then
    -- The invoice must belong to THIS subscription. Comparing the owner
    -- would not be enough: one customer may hold several subscriptions,
    -- and invoice A must never be accepted as subscription B's work just
    -- because both are theirs.
    if v_attempt.subscription_id is distinct from p_subscription_id then
      raise exception 'stripe invoice % already belongs to subscription %, not %',
        p_stripe_invoice_id, v_attempt.subscription_id, p_subscription_id;
    end if;
    return v_attempt.id;
  end if;

  -- First time for this invoice: now the lifecycle may move.
  update public.subscriptions
     set stripe_subscription_id = coalesce(v_subscription.stripe_subscription_id, p_stripe_subscription_id),
         status                 = 'active',
         started_at             = coalesce(v_subscription.started_at, now()),
         current_period_start   = coalesce(p_current_period_start, v_subscription.current_period_start),
         current_period_end     = coalesce(p_current_period_end, v_subscription.current_period_end),
         next_delivery_at       = coalesce(p_next_delivery_at, v_subscription.next_delivery_at)
   where id = p_subscription_id
  returning * into v_subscription;

  -- Rebuilt from the frozen items rather than stored twice, so the
  -- subscription's own lines stay the single source of what is billed.
  select jsonb_agg(
           jsonb_build_object(
             'variantId', si.product_reference,
             'sku', si.sku,
             'productName', si.product_name,
             'variantLabel', si.variant_name,
             'sizeGrams', si.metadata->'sizeGrams',
             'quantity', si.quantity,
             'unitGrossCents', si.unit_price_gross_cents,
             'lineGrossCents', si.line_total_gross_cents,
             'currency', v_subscription.currency
           )
           order by si.created_at
         )
    into v_items
  from public.subscription_items si
  where si.subscription_id = p_subscription_id;

  if v_items is null then
    raise exception 'subscription % has no items to bill', p_subscription_id;
  end if;

  begin
    insert into public.checkout_attempts (
      request_id,
      subscription_id,
      user_id,
      status,
      currency,
      expected_total_gross_cents,
      items_snapshot,
      shipping_country,
      shipping_gross_cents,
      tax_snapshot,
      stripe_invoice_id,
      paid_at
    ) values (
      -- Schema-qualified deliberately. This body runs with search_path
      -- emptied, and checkout_attempts.request_id has no column default
      -- to fall back on, so an unqualified lookup would depend on a
      -- resolution order this function has given up. pg_catalog is always
      -- searched, and no migration in this project installs pgcrypto, so
      -- the core function is the one every existing gen_random_uuid()
      -- default already resolves to.
      pg_catalog.gen_random_uuid(),
      p_subscription_id,
      v_subscription.user_id,
      'paid',
      v_subscription.currency,
      v_subscription.total_gross_cents,
      v_items,
      -- The destination this delivery is priced for, taken from the
      -- frozen address. shipping_zone stays NULL: it is a presentation
      -- detail of the one-time Stripe session and nothing reads it here.
      v_subscription.shipping_address_snapshot->>'country',
      v_subscription.shipping_gross_cents,
      v_subscription.tax_snapshot,
      p_stripe_invoice_id,
      now()
    )
    returning * into v_attempt;
  exception
    when unique_violation then
      -- A concurrent redelivery won the race between the lookup above and
      -- this insert. The index is the real guard; this adopts its winner,
      -- but only after proving the winner is this subscription's.
      select * into v_attempt
      from public.checkout_attempts
      where stripe_invoice_id = p_stripe_invoice_id;
      if not found then
        raise;
      end if;
      if v_attempt.subscription_id is distinct from p_subscription_id then
        raise exception 'stripe invoice % already belongs to subscription %, not %',
          p_stripe_invoice_id, v_attempt.subscription_id, p_subscription_id;
      end if;
      return v_attempt.id;
  end;

  return v_attempt.id;
end;
$$;

revoke all on function public.activate_subscription_from_invoice(uuid, text, text, timestamptz, timestamptz, timestamptz) from public;
grant execute on function public.activate_subscription_from_invoice(uuid, text, text, timestamptz, timestamptz, timestamptz) to service_role;

-- Read-back for the server, mirroring how 011 grants the order tables.
-- No insert or update grant: both writes go through the functions above,
-- which run as their owner.
grant select on public.subscriptions to service_role;
grant select on public.subscription_items to service_role;

-- 8. VERIFY ────────────────────────────────────────────────────
--
-- Read-only. Run after applying. Query (c) matters most: if the drop in
-- section 5 did not match the constraint 005 actually created, the old
-- four-value check survives alongside the new one and past_due would
-- still be rejected - at runtime, not here.
--
-- (a) The new columns exist, all nullable, none with a default.
--     Expected: four rows, is_nullable = YES, column_default NULL.
--
--   select table_name, column_name, data_type, is_nullable, column_default
--   from information_schema.columns
--   where table_schema = 'public'
--     and ((table_name = 'checkout_attempts'
--           and column_name in ('stripe_invoice_id', 'subscription_id'))
--       or (table_name = 'subscriptions'
--           and column_name in ('stripe_subscription_id', 'tax_snapshot')))
--   order by table_name, column_name;
--
-- (b) Both unique indexes exist and are partial on non-null. Expected:
--     two rows, each with a WHERE clause. subscription_id must NOT appear
--     in any unique index - a subscription has many renewal attempts.
--
--   select indexname, indexdef
--   from pg_indexes
--   where schemaname = 'public'
--     and tablename in ('checkout_attempts', 'subscriptions')
--   order by indexname;
--
-- (c) EVERY check constraint on subscriptions. Expected: exactly one
--     mentioning status, listing all six values.
--
--   select conname, pg_get_constraintdef(oid) as definition
--   from pg_constraint
--   where conrelid = 'public.subscriptions'::regclass and contype = 'c'
--   order by conname;
--
-- (d) The correlation foreign key points where it should.
--
--   select conname, pg_get_constraintdef(oid) as definition
--   from pg_constraint
--   where conrelid = 'public.checkout_attempts'::regclass and contype = 'f'
--   order by conname;
--
-- (e) Every existing subscription still satisfies the constraint.
--
--   select status, count(*) from public.subscriptions
--   group by status order by status;
--
-- (f) Historical checkout attempts are untouched: both counts equal, and
--     no existing row acquired an invoice or a subscription.
--
--   select count(*)                                          as attempts,
--          count(*) filter (where stripe_invoice_id is null) as without_invoice,
--          count(*) filter (where subscription_id is null)   as without_subscription
--   from public.checkout_attempts;
--
-- (g) stripe_customers is server-only: RLS on, zero policies, and no
--     grantee besides service_role and the owner.
--
--   select relrowsecurity, relforcerowsecurity
--   from pg_class where oid = 'public.stripe_customers'::regclass;
--
--   select count(*) as policy_count from pg_policies
--   where schemaname = 'public' and tablename = 'stripe_customers';
--
--   select grantee, privilege_type
--   from information_schema.role_table_grants
--   where table_schema = 'public' and table_name = 'stripe_customers'
--   order by grantee, privilege_type;
--
-- (h) Both functions are security definer with the search path pinned.
--     Expected: prosecdef true, proconfig {search_path=""}.
--
--   select p.proname, p.prosecdef as security_definer, p.proconfig
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public'
--     and p.proname in ('create_pending_subscription',
--                       'activate_subscription_from_invoice')
--   order by p.proname;
--
-- (i) Function ACLs: service_role only. A bare "=X/" entry would mean
--     PUBLIC can still execute.
--
--   select p.proname,
--          coalesce(array_to_string(p.proacl, E'\n'),
--                   '(default - PUBLIC can execute)') as acl
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public'
--     and p.proname in ('create_pending_subscription',
--                       'activate_subscription_from_invoice')
--   order by p.proname;
--
-- (j) No browser role gained anything. Expected: authenticated keeps
--     SELECT only on subscriptions and subscription_items, and nothing
--     at all on checkout_attempts; anon appears nowhere.
--
--   select table_name, grantee, privilege_type
--   from information_schema.role_table_grants
--   where table_schema = 'public'
--     and table_name in ('subscriptions', 'subscription_items',
--                        'checkout_attempts', 'stripe_customers')
--     and grantee in ('anon', 'authenticated')
--   order by table_name, grantee, privilege_type;
