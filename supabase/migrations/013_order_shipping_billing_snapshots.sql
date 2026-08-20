-- ============================================================
-- GLOA – Order Shipping/Billing Address Snapshots
-- Run in Supabase SQL Editor AFTER 011 + 012
--
-- No table/column changes: orders.shipping_address_snapshot and
-- billing_address_snapshot already exist as nullable jsonb (migration
-- 011) and are flexible enough to hold Stripe's actual address shape.
-- This migration only extends create_order_from_paid_checkout to accept
-- and persist those two snapshots, so it changes function parameters:
-- CREATE OR REPLACE cannot change a function's parameter list in place,
-- so the old 3-arg version is dropped and replaced with the new 5-arg
-- one, atomically, in the same statement group.
-- ============================================================

drop function if exists public.create_order_from_paid_checkout(uuid, jsonb, text);

create function public.create_order_from_paid_checkout(
  p_checkout_attempt_id uuid,
  p_customer_snapshot jsonb,
  p_stripe_payment_intent_id text,
  p_shipping_address_snapshot jsonb,
  p_billing_address_snapshot jsonb
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

  -- Idempotent: an already-existing order is returned unchanged. This is
  -- also what keeps a later (possibly stale/incomplete) webhook retry
  -- from ever overwriting an order's already-persisted snapshots - the
  -- snapshots are only ever written once, on the single INSERT below.
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
      shipping_address_snapshot,
      billing_address_snapshot,
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
      p_shipping_address_snapshot,
      p_billing_address_snapshot,
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

revoke all on function public.create_order_from_paid_checkout(uuid, jsonb, text, jsonb, jsonb) from public;
grant execute on function public.create_order_from_paid_checkout(uuid, jsonb, text, jsonb, jsonb) to service_role;
