begin;

create table public.matcha_checkout_reservations (
  attempt_id uuid not null references public.checkout_attempts(id),
  item_id uuid not null references public.inventory_items(id),
  units integer not null check (units > 0),
  state text not null default 'held' check (state in ('held','released','shipped')),
  shipment_operation uuid not null unique default gen_random_uuid(),
  primary key(attempt_id,item_id)
);
alter table public.matcha_checkout_reservations enable row level security;
revoke all on public.matcha_checkout_reservations from public,anon,authenticated,service_role;
create index matcha_checkout_held_stock on public.matcha_checkout_reservations(item_id) where state='held';

create function public.hold_matcha_attempt_stock_v1(target uuid, due_delivery boolean) returns boolean
language plpgsql security definer set search_path='' as $$
declare a public.checkout_attempts; lines jsonb; item record;
begin
  select * into strict a from public.checkout_attempts where id=target for update;
  -- Stripe idempotency keys have finite retention. Stale attempts cannot start another session.
  if due_delivery then
    if a.status<>'paid' or not coalesce(
      (a.subscription_id is not null and a.stripe_invoice_id is not null)
      or (a.annual_plan_id is not null and a.annual_delivery_number is not null),false)
    then return false; end if;
  elsif a.status not in ('created','stripe_session_created') or a.created_at <= now()-interval '30 minutes'
     or a.subscription_id is not null or a.annual_plan_id is not null
  then return false; end if;
  if exists(select 1 from public.matcha_checkout_reservations where attempt_id=target) then
    return not exists(select 1 from public.matcha_checkout_reservations where attempt_id=target and state<>'held');
  end if;
  if jsonb_typeof(a.items_snapshot) is distinct from 'array' or jsonb_array_length(a.items_snapshot)=0 then return false; end if;
  select jsonb_agg(to_jsonb(x)) into lines from (
    select i.id, sum(l.quantity)::integer units
    from jsonb_to_recordset(a.items_snapshot) l("variantId" uuid,sku text,quantity integer)
    left join public.product_variants v on v.id=l."variantId" and v.sku=l.sku and v.is_active
      and v.sku in ('GLOA-MATCHA-30G','GLOA-MATCHA-50G','GLOA-MATCHA-100G')
    left join public.inventory_items i on i.id=v.inventory_item_id and i.sku=v.sku
    group by i.id
  ) x;
  if exists(select 1 from jsonb_to_recordset(a.items_snapshot) l(quantity integer) where quantity is null or quantity<=0)
     or exists(select 1 from jsonb_to_recordset(lines) l(id uuid,units integer) where id is null or units is null)
  then return false; end if;

  -- All reservations and physical movements serialize on the same item locks.
  perform 1 from public.inventory_items where id in (select l.id from jsonb_to_recordset(lines) l(id uuid))
    order by id for update;
  for item in select i.*,l.units from jsonb_to_recordset(lines) l(id uuid,units integer)
    join public.inventory_items i on i.id=l.id
  loop
    if not item.is_active or lower(item.unit) not in ('stück','stueck')
      or item.current_quantity is null or item.current_quantity<>trunc(item.current_quantity)
      or item.current_quantity < item.units + coalesce((select sum(units) from public.matcha_checkout_reservations
        where item_id=item.id and state='held'),0)
    then return false; end if;
  end loop;
  insert into public.matcha_checkout_reservations(attempt_id,item_id,units)
    select target,l.id,l.units from jsonb_to_recordset(lines) l(id uuid,units integer);
  return true;
end;
$$;
revoke all on function public.hold_matcha_attempt_stock_v1(uuid,boolean) from public,anon,authenticated,service_role;

create function public.reserve_matcha_checkout_v1(target uuid) returns boolean
language sql security definer set search_path='' as $$
  select public.hold_matcha_attempt_stock_v1(target,false)
$$;

create function public.reserve_due_matcha_order_v1() returns trigger
language plpgsql security definer set search_path='' as $$
declare a public.checkout_attempts;
begin
  select * into a from public.checkout_attempts where id=new.checkout_attempt_id;
  if a.id is null or (a.subscription_id is null and a.annual_delivery_number is null) then return null; end if;
  if new.payment_status<>'paid' or new.cancelled_at is not null or new.historical_payment_unverified
     or not public.hold_matcha_attempt_stock_v1(a.id,true)
  then raise exception 'inventory_due_delivery_unavailable'; end if;
  return null;
end;
$$;
-- The existing paid-invoice and due-delivery writers create the order in
-- a transaction. A failed hold rolls back fulfilment without changing payment facts.
create trigger reserve_due_matcha_order after insert on public.orders
for each row execute function public.reserve_due_matcha_order_v1();

create function public.release_failed_matcha_checkout_v1(target uuid, request_key uuid, session_key text, terminal_state text) returns boolean
language plpgsql security definer set search_path='' as $$
declare a public.checkout_attempts;
begin
  if terminal_state is null or terminal_state not in ('failed','expired')
  then raise exception 'inventory_checkout_terminal_state_invalid'; end if;
  if not exists(select 1 from public.matcha_checkout_reservations where attempt_id=target) then return false; end if;
  select * into strict a from public.checkout_attempts where id=target for update;
  if request_key is distinct from a.request_id or session_key is null or
     (a.stripe_checkout_session_id is not null and a.stripe_checkout_session_id<>session_key)
  then raise exception 'inventory_checkout_session_mismatch'; end if;
  if a.status='paid' or exists(select 1 from public.matcha_checkout_reservations where attempt_id=target and state='shipped')
  then return false; end if;
  update public.matcha_checkout_reservations set state='released' where attempt_id=target and state='held';
  update public.checkout_attempts set status=terminal_state where id=target and status not in ('failed','expired');
  return true;
end;
$$;

create function public.guard_matcha_physical_stock_v1() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if new.sku in ('GLOA-MATCHA-RAW','GLOA-MATCHA-30G','GLOA-MATCHA-50G','GLOA-MATCHA-100G','GLOA-MATCHA-B2B-500G')
    and (new.current_quantity<0 or
      (new.sku<>'GLOA-MATCHA-RAW' and new.current_quantity<>trunc(new.current_quantity)))
  then raise exception 'inventory_invalid_matcha_balance'; end if;
  if tg_op='UPDATE' and exists(select 1 from public.matcha_checkout_reservations where item_id=old.id and state='held')
    and (not new.is_active or new.current_quantity is null or new.unit is distinct from old.unit
      or new.sku is distinct from old.sku
      or new.current_quantity < (select sum(units) from public.matcha_checkout_reservations where item_id=old.id and state='held'))
  then raise exception 'inventory_stock_is_reserved'; end if;
  return new;
end;
$$;
create trigger matcha_physical_stock_guard before insert or update on public.inventory_items
for each row execute function public.guard_matcha_physical_stock_v1();

create function public.apply_matcha_checkout_order_stock_v1() returns trigger
language plpgsql security definer set search_path='' as $$
declare r public.matcha_checkout_reservations; booked jsonb;
begin
  if not exists(select 1 from public.matcha_checkout_reservations where attempt_id=old.checkout_attempt_id)
  then return null; end if;
  if new.checkout_attempt_id is distinct from old.checkout_attempt_id
  then raise exception 'inventory_order_attempt_is_fixed'; end if;
  if old.shipped_at is not null or old.fulfillment_status in ('shipped','delivered') then return null; end if;
  if new.shipped_at is not null or new.fulfillment_status in ('shipped','delivered') then
    if new.historical_payment_unverified or new.payment_status not in ('paid','partially_refunded')
       or new.cancelled_at is not null or new.status in ('cancelled','refunded')
       or exists(select 1 from public.matcha_checkout_reservations where attempt_id=old.checkout_attempt_id and state<>'held')
    then raise exception 'inventory_order_not_shippable'; end if;
    perform 1 from public.inventory_items where id in (
      select item_id from public.matcha_checkout_reservations where attempt_id=old.checkout_attempt_id)
      order by id for update;
    for r in select * from public.matcha_checkout_reservations where attempt_id=old.checkout_attempt_id order by item_id loop
      update public.matcha_checkout_reservations set state='shipped'
        where attempt_id=r.attempt_id and item_id=r.item_id and state='held';
      if not found then raise exception 'inventory_reservation_changed'; end if;
      booked:=public.record_inventory_movement(r.shipment_operation,r.item_id,r.units,'withdrawal','b2c',
        p_reference=>new.order_number,p_allow_negative=>false);
      if booked->>'result' is distinct from 'recorded' then raise exception 'inventory_shipment_failed'; end if;
    end loop;
  elsif new.cancelled_at is not null or new.status in ('cancelled','refunded')
        or new.fulfillment_status='cancelled' or new.payment_status='refunded' then
    update public.matcha_checkout_reservations set state='released'
      where attempt_id=old.checkout_attempt_id and state='held';
  end if;
  return null;
end;
$$;
create trigger matcha_checkout_order_stock after update on public.orders
for each row execute function public.apply_matcha_checkout_order_stock_v1();

create function public.release_ended_annual_matcha_stock_v1() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  update public.matcha_checkout_reservations r set state='released'
    from public.checkout_attempts a where a.id=r.attempt_id
      and a.annual_plan_id=new.id and r.state='held';
  return null;
end;
$$;
create trigger release_ended_annual_matcha_stock after update on public.annual_plans
for each row when ((new.payment_status='refunded' and old.payment_status is distinct from new.payment_status)
  or (new.status='cancelled' and old.status is distinct from new.status))
execute function public.release_ended_annual_matcha_stock_v1();

revoke all on function public.reserve_matcha_checkout_v1(uuid) from public,anon,authenticated;
revoke all on function public.release_failed_matcha_checkout_v1(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.reserve_matcha_checkout_v1(uuid) to service_role;
grant execute on function public.release_failed_matcha_checkout_v1(uuid,uuid,text,text) to service_role;

create function public.read_matcha_checkout_stock_v1(ids uuid[])
returns table (item_id uuid, physical numeric, reserved bigint, available numeric)
language sql stable security definer set search_path='' as $$
  select i.id, i.current_quantity, coalesce(sum(r.units),0),
    i.current_quantity-coalesce(sum(r.units),0)
  from public.inventory_items i
  left join public.matcha_checkout_reservations r on r.item_id=i.id and r.state='held'
  where i.id=any(ids) and i.sku in ('GLOA-MATCHA-30G','GLOA-MATCHA-50G','GLOA-MATCHA-100G')
  group by i.id
$$;
revoke all on function public.read_matcha_checkout_stock_v1(uuid[]) from public,anon,authenticated;
grant execute on function public.read_matcha_checkout_stock_v1(uuid[]) to service_role;

create function public.read_matcha_delivery_demand_v1()
returns table (sku text, annual_units bigint, next_subscription_units bigint, b2b_units bigint)
language sql stable security definer set search_path='' as $$
  with sizes(sku) as (values ('GLOA-MATCHA-30G'),('GLOA-MATCHA-50G'),
    ('GLOA-MATCHA-100G'),('GLOA-MATCHA-B2B-500G'))
  select s.sku,
    (select count(*) from public.annual_plan_deliveries d join public.annual_plans p on p.id=d.annual_plan_id
      join public.product_variants v on v.id=p.variant_id where v.sku=s.sku
      and d.state in ('scheduled','claimed') and p.status='active' and p.payment_status in ('paid','partially_refunded')),
    (select count(*) from public.subscriptions a join public.b2c_subscription_plans p on p.id=a.plan_id
      join public.product_variants v on v.id=p.variant_id where v.sku=s.sku
      and a.status='active' and not a.cancel_at_period_end and a.next_delivery_at is not null),
    case when s.sku='GLOA-MATCHA-B2B-500G' then
      coalesce((select sum(d.quantity_packs) from public.b2b_deliveries d
        join public.b2b_supply_agreements a on a.id=d.supply_agreement_id
        where a.pack_grams=500 and a.status='active' and d.status in ('scheduled','held')),0)
      else 0 end
  from sizes s
$$;
revoke all on function public.read_matcha_delivery_demand_v1() from public,anon,authenticated;
grant execute on function public.read_matcha_delivery_demand_v1() to service_role;

commit;
