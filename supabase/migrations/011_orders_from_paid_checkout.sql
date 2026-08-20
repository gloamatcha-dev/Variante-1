-- ============================================================
-- GLOA – Real Order Creation from Verified-Paid Checkout Attempts
-- Run in Supabase SQL Editor AFTER 001–010
--
-- Adds what is needed to atomically and idempotently turn a
-- verified-paid checkout attempt into a real order + order_items, while
-- never fabricating shipping/tax/address data that is not decided yet.
-- ============================================================

-- 1. ORDERS: LINK TO THE CHECKOUT ATTEMPT / STRIPE SESSION ─────

alter table public.orders
  add column checkout_attempt_id     uuid references public.checkout_attempts(id),
  add column stripe_checkout_session_id text,
  add column stripe_payment_intent_id   text;

-- One checkout attempt -> at most one order.
create unique index orders_checkout_attempt_id_key
  on public.orders (checkout_attempt_id)
  where checkout_attempt_id is not null;

-- One Stripe Checkout Session -> at most one order.
create unique index orders_stripe_checkout_session_id_key
  on public.orders (stripe_checkout_session_id)
  where stripe_checkout_session_id is not null;

-- 2. ORDERS: SHIPPING / TAX / ADDRESS ARE NOT DECIDED YET ──────
--
-- Shipping cost and final tax logic are not finalized (separate task),
-- and checkout does not collect shipping/billing addresses yet. These
-- columns must stay NULL - genuinely unknown - instead of being filled
-- with fabricated zeros that would misrepresent a resolved order.
-- subtotal_gross_cents and total_gross_cents stay NOT NULL: those come
-- from the actually verified Stripe payment.

alter table public.orders
  alter column shipping_address_snapshot drop not null,
  alter column billing_address_snapshot  drop not null,
  alter column subtotal_net_cents        drop not null,
  alter column shipping_net_cents        drop not null,
  alter column shipping_gross_cents      drop not null,
  alter column tax_total_cents           drop not null,
  alter column total_net_cents           drop not null;

alter table public.order_items
  alter column unit_price_net_cents drop not null,
  alter column line_total_net_cents drop not null;

-- 3. GRANTS: service_role NEEDS ORDINARY TABLE GRANTS TOO ──────
--
-- Same lesson as 010: service_role bypasses RLS but still needs table
-- grants. The success lookup API reads orders/order_items directly with
-- the admin client (it must also work for guest checkouts, which have no
-- authenticated session for RLS to apply to).

grant select on public.orders to service_role;
grant select on public.order_items to service_role;

-- 4. ATOMIC, IDEMPOTENT ORDER CREATION ──────────────────────────
--
-- Turns one verified-paid checkout attempt into exactly one order + its
-- order_items, in a single DB call. Race-safe: locks the checkout attempt
-- row for the duration of the call (serializes concurrent webhook
-- deliveries for the same attempt) and additionally falls back to the
-- unique index above on a concurrent insert, so a retry or a duplicate
-- Stripe webhook delivery can never create a second order. Returns the
-- existing order unchanged if one already exists for this attempt.
--
-- Order items are built exclusively from checkout_attempts.items_snapshot
-- (the authoritative server-side quote locked in at checkout time) -
-- never from any client-supplied price. Net/tax fields are left NULL:
-- genuinely unknown, not fabricated as 0.

create or replace function public.create_order_from_paid_checkout(
  p_checkout_attempt_id uuid,
  p_customer_snapshot jsonb,
  p_stripe_payment_intent_id text
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
    return v_order;
  end if;

  select coalesce(sum((item->>'lineGrossCents')::integer), 0)
    into v_subtotal_gross_cents
  from jsonb_array_elements(v_attempt.items_snapshot) as item;

  begin
    insert into public.orders (
      user_id,
      customer_type,
      status,
      payment_status,
      currency,
      customer_snapshot,
      subtotal_gross_cents,
      total_gross_cents,
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
      v_subtotal_gross_cents,
      v_attempt.expected_total_gross_cents,
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
    insert into public.order_items (
      order_id,
      product_reference,
      sku,
      product_name,
      variant_name,
      quantity,
      unit_price_gross_cents,
      line_total_gross_cents,
      metadata
    ) values (
      v_order.id,
      v_item->>'variantId',
      v_item->>'sku',
      v_item->>'productName',
      v_item->>'variantLabel',
      (v_item->>'quantity')::integer,
      (v_item->>'unitGrossCents')::integer,
      (v_item->>'lineGrossCents')::integer,
      jsonb_build_object('sizeGrams', v_item->'sizeGrams', 'currency', v_item->'currency')
    );
  end loop;

  return v_order;
end;
$$;

revoke all on function public.create_order_from_paid_checkout(uuid, jsonb, text) from public;
grant execute on function public.create_order_from_paid_checkout(uuid, jsonb, text) to service_role;
