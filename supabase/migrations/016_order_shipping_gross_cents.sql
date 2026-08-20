-- ============================================================
-- GLOA – Zone-Based Shipping Prices: orders.shipping_gross_cents
-- Run in Supabase SQL Editor AFTER 014 + 015
--
-- No table/column changes: orders.shipping_gross_cents already exists
-- as a nullable integer (migration 011). This migration only extends
-- create_order_from_paid_checkout to accept the checkout attempt's
-- frozen shipping price (checkout_attempts.shipping_gross_cents - see
-- migration 015) and store it on the order, instead of always NULL.
--
-- Adds exactly one new parameter (p_shipping_gross_cents) at the end,
-- so this changes the function's signature - CREATE OR REPLACE cannot
-- do that in place, so the old 5-arg version is dropped and replaced
-- with the new 6-arg one, same as 011 -> 013.
--
-- This body is otherwise byte-for-byte identical to migration 014's
-- (already-fixed) version, with exactly one value changed: the
-- shipping_gross_cents column of the orders INSERT now gets
-- p_shipping_gross_cents instead of a hardcoded null. subtotal_net_cents,
-- shipping_net_cents, tax_total_cents, and total_net_cents stay
-- explicitly null - still genuinely unknown pending Task 21 (tax).
-- total_gross_cents keeps coming from v_attempt.expected_total_gross_cents,
-- which the checkout session route now computes as merchandise subtotal
-- + shipping, so it already includes shipping correctly without any
-- change here.
-- ============================================================

drop function if exists public.create_order_from_paid_checkout(uuid, jsonb, text, jsonb, jsonb);

create function public.create_order_from_paid_checkout(
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
      shipping_address_snapshot,
      billing_address_snapshot,
      subtotal_gross_cents,
      subtotal_net_cents,
      shipping_net_cents,
      shipping_gross_cents,
      tax_total_cents,
      total_net_cents,
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
      null,
      null,
      p_shipping_gross_cents,
      null,
      null,
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

revoke all on function public.create_order_from_paid_checkout(uuid, jsonb, text, jsonb, jsonb, integer) from public;
grant execute on function public.create_order_from_paid_checkout(uuid, jsonb, text, jsonb, jsonb, integer) to service_role;
