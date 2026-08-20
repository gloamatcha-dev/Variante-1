-- ============================================================
-- GLOA – Bugfix: create_order_from_paid_checkout must leave net/tax/
-- shipping cents genuinely NULL, not silently default to 0
-- Run in Supabase SQL Editor AFTER 011
--
-- 011 dropped the NOT NULL constraint on subtotal_net_cents,
-- shipping_net_cents, shipping_gross_cents, tax_total_cents and
-- total_net_cents so they could stay "unknown" - but the function's
-- INSERT never listed those columns, so Postgres silently applied their
-- pre-existing `default 0` from migration 004 instead of NULL. That is
-- exactly the fabricated-zero the task explicitly forbids. This migration
-- only redefines the function (create or replace) to explicitly insert
-- NULL for those five columns; no schema/grant changes.
-- ============================================================

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
      v_subtotal_gross_cents,
      null,
      null,
      null,
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
