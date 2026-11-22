begin;

-- The reviewed cohort is fixed. A placeholder on a different order is not part of it.
alter table public.orders add column historical_payment_unverified boolean
generated always as (coalesce(
  stripe_payment_intent_id = 'pi_test_first'
  and stripe_checkout_session_id is null
  and placed_at >= timestamptz '2026-08-20 00:00:00+00'
  and placed_at < timestamptz '2026-08-22 00:00:00+00'
  and order_number in (
    'GLOA-2026-000002', 'GLOA-2026-000005', 'GLOA-2026-000009', 'GLOA-2026-000012', 'GLOA-2026-000016',
    'GLOA-2026-000021', 'GLOA-2026-000028', 'GLOA-2026-000035', 'GLOA-2026-000042', 'GLOA-2026-000050',
    'GLOA-2026-000058', 'GLOA-2026-000068', 'GLOA-2026-000076', 'GLOA-2026-000085', 'GLOA-2026-000093',
    'GLOA-2026-000101', 'GLOA-2026-000111', 'GLOA-2026-000124', 'GLOA-2026-000135', 'GLOA-2026-000145',
    'GLOA-2026-000155', 'GLOA-2026-000165', 'GLOA-2026-000175', 'GLOA-2026-000185', 'GLOA-2026-000195',
    'GLOA-2026-000206', 'GLOA-2026-000215', 'GLOA-2026-000238', 'GLOA-2026-000251', 'GLOA-2026-000267',
    'GLOA-2026-000287', 'GLOA-2026-000303', 'GLOA-2026-000319', 'GLOA-2026-000335', 'GLOA-2026-000351',
    'GLOA-2026-000367', 'GLOA-2026-000382', 'GLOA-2026-000399', 'GLOA-2026-000415', 'GLOA-2026-000431',
    'GLOA-2026-000447'
  ), false)
) stored;

create function public.guard_historical_unverified_order_shipping() returns trigger
language plpgsql set search_path='' as $$
begin
  -- AFTER UPDATE observes generated columns and rolls back the transition before callers send mail.
  if (old.historical_payment_unverified or new.historical_payment_unverified) and (
    (old.historical_payment_unverified and not new.historical_payment_unverified)
    or (new.fulfillment_status is distinct from old.fulfillment_status
      and new.fulfillment_status in ('processing','shipped','delivered'))
    or (new.status is distinct from old.status and new.status in ('processing','shipped','delivered'))
    or new.shipped_at is distinct from old.shipped_at
    or new.delivered_at is distinct from old.delivered_at
    or new.shipping_carrier is distinct from old.shipping_carrier
    or new.tracking_number is distinct from old.tracking_number
    or new.tracking_url is distinct from old.tracking_url
  ) then
    raise exception 'historical_order_payment_unverified' using errcode='23514';
  end if;
  return null;
end;
$$;

create trigger historical_unverified_order_shipping_guard after update on public.orders
for each row when (old.historical_payment_unverified or new.historical_payment_unverified)
execute function public.guard_historical_unverified_order_shipping();

commit;
