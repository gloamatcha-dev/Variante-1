begin;

-- Each initial Checkout attempt owns its existing ledger rows until the
-- authoritative first invoice or delivery adopts them.
create table public.matcha_first_checkout (
  attempt_id uuid primary key references public.checkout_attempts(id),
  kind text not null check (kind in ('subscription','annual','b2b')),
  first_invoice text unique,
  transferred boolean not null default false
);
alter table public.matcha_first_checkout enable row level security;
revoke all on public.matcha_first_checkout from public, anon, authenticated, service_role;

create or replace function public.hold_matcha_attempt_stock_v1(target uuid, due_delivery boolean) returns boolean
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
     or (a.subscription_id is not null and not exists (select 1 from public.matcha_first_checkout where attempt_id=target and kind='subscription')) or a.annual_plan_id is not null
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

create or replace function public.admin_matcha_b2b_delivery_v1(actor uuid,target uuid,action text) returns text
language plpgsql security definer set search_path='' as $$
declare d public.b2b_deliveries; item public.inventory_items; h public.matcha_b2b_delivery_reservations; agreement uuid;
begin
  if not exists(select 1 from public.admin_users where user_id=actor and is_active and role in ('owner','admin'))
  then raise exception 'inventory_b2b_forbidden' using errcode='42501'; end if;
  if action is null or action not in ('reserve','dispatch') then raise exception 'inventory_b2b_action_invalid'; end if;
  select supply_agreement_id into strict agreement from public.b2b_deliveries where id=target;
  perform 1 from public.b2b_supply_agreements where id=agreement for update;
  select * into strict d from public.b2b_deliveries where id=target for update;
  select * into h from public.matcha_b2b_delivery_reservations where delivery_id=target for update;
  if d.supply_agreement_id<>agreement then raise exception 'inventory_b2b_delivery_changed'; end if;
  if action='dispatch' and h.state='shipped' and d.status in ('dispatched','delivered')
  then return 'already_dispatched'; end if;
  if d.status<>'scheduled' or d.resolved_at is null or d.scheduled_for>now()
      or d.cancelled_at is not null or not public.matcha_b2b_payment_verified_v1(target)
  then raise exception 'inventory_b2b_delivery_not_released'; end if;
  if action='reserve' then
    if h.state='held' and h.units=d.quantity_packs then return 'already_reserved'; end if;
    select * into item from public.inventory_items where sku='GLOA-MATCHA-B2B-500G' for update;
    if item.id is null or not item.is_active or lower(item.unit) not in ('stück','stueck')
      or item.current_quantity is null or item.current_quantity<>trunc(item.current_quantity)
      or item.current_quantity<d.quantity_packs+coalesce((select sum(units)
        from public.matcha_b2b_delivery_reservations where item_id=item.id and state='held'),0)
        +coalesce((select sum(units) from public.matcha_checkout_reservations where item_id=item.id and state='held'),0)
    then raise exception 'inventory_b2b_stock_unavailable'; end if;
    insert into public.matcha_b2b_delivery_reservations(delivery_id,item_id,units)
    values(target,item.id,d.quantity_packs)
    on conflict(delivery_id) do update set item_id=excluded.item_id,units=excluded.units,state='held',dispatch_actor=null
    where matcha_b2b_delivery_reservations.state='released';
    if not found then raise exception 'inventory_b2b_reservation_changed'; end if;
    perform public.record_admin_activity(actor,'inventory','b2b_stock_reserved','b2b_delivery',target::text,
      '500-g-Einheiten für B2B-Lieferung reserviert',gen_random_uuid(),jsonb_build_object('units',d.quantity_packs));
    return 'reserved';
  end if;
  if h.state is distinct from 'held' or h.units<>d.quantity_packs
  then raise exception 'inventory_b2b_reservation_required'; end if;
  update public.matcha_b2b_delivery_reservations set dispatch_actor=actor where delivery_id=target;
  update public.b2b_deliveries set status='dispatched',dispatched_at=now() where id=target;
  perform public.record_admin_activity(actor,'inventory','b2b_stock_dispatched','b2b_delivery',target::text,
    'Tatsächlicher B2B-Versand bestätigt',h.shipment_operation,jsonb_build_object('units',h.units));
  return 'dispatched';
end;
$$;

create or replace function public.guard_matcha_physical_stock_v1() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if new.sku in ('GLOA-MATCHA-RAW','GLOA-MATCHA-30G','GLOA-MATCHA-50G','GLOA-MATCHA-100G','GLOA-MATCHA-B2B-500G')
    and (new.current_quantity<0 or
      (new.sku<>'GLOA-MATCHA-RAW' and new.current_quantity<>trunc(new.current_quantity)))
  then raise exception 'inventory_invalid_matcha_balance'; end if;
  if tg_op='UPDATE' and old.sku='GLOA-MATCHA-B2B-500G' and new.current_quantity <
       coalesce((select sum(units) from public.matcha_checkout_reservations where item_id=old.id and state='held'),0)
       +coalesce((select sum(units) from public.matcha_b2b_delivery_reservations where item_id=old.id and state='held'),0)
  then raise exception 'inventory_b2b_stock_is_reserved'; end if;
  if tg_op='UPDATE' and exists(select 1 from public.matcha_checkout_reservations where item_id=old.id and state='held')
    and (not new.is_active or new.current_quantity is null or new.unit is distinct from old.unit
      or new.sku is distinct from old.sku
      or new.current_quantity < (select sum(units) from public.matcha_checkout_reservations where item_id=old.id and state='held'))
  then raise exception 'inventory_stock_is_reserved'; end if;
  return new;
end;
$$;

create or replace function public.release_ended_annual_matcha_stock_v1() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  update public.matcha_checkout_reservations r set state='released'
    from public.checkout_attempts a where a.id=r.attempt_id
      and (a.annual_plan_id=new.id or (a.id=new.payment_checkout_attempt_id and a.status='paid' and exists
        (select 1 from public.matcha_first_checkout f where f.attempt_id=a.id and f.kind='annual'))) and r.state='held';
  return null;
end;
$$;

create function public.reserve_matcha_first_checkout(target uuid, checkout_kind text)
returns boolean language plpgsql security definer set search_path='' as $$
declare
  a public.checkout_attempts;
  agreement public.b2b_supply_agreements;
  item public.inventory_items;
begin
  select * into strict a from public.checkout_attempts where id=target for update;
  if checkout_kind is null or checkout_kind not in ('subscription','annual','b2b')
     or a.status not in ('created','stripe_session_created')
     or a.created_at <= now()-interval '30 minutes'
     or a.stripe_invoice_id is not null or a.annual_delivery_number is not null
     or ((checkout_kind='subscription') is distinct from (a.subscription_id is not null))
  then return false; end if;

  insert into public.matcha_first_checkout(attempt_id,kind) values(target,checkout_kind)
  on conflict(attempt_id) do nothing;
  if not exists (select from public.matcha_first_checkout where attempt_id=target
      and kind=checkout_kind and not transferred)
  then return false; end if;

  if checkout_kind='annual' and not exists (select 1 from public.annual_plans where payment_checkout_attempt_id=target)
  then return false; end if;
  if checkout_kind <> 'b2b' then
    return public.hold_matcha_attempt_stock_v1(target,false);
  end if;

  select * into agreement from public.b2b_supply_agreements where checkout_attempt_id=target;
  if agreement.id is null or agreement.status <> 'pending' or agreement.pack_grams <> 500
     or agreement.quantity_packs is null or agreement.quantity_packs <= 0
  then return false; end if;
  if exists(select from public.matcha_checkout_reservations where attempt_id=target) then
    return exists(select from public.matcha_checkout_reservations r
      join public.inventory_items i on i.id=r.item_id
      where r.attempt_id=target and r.state='held' and r.units=agreement.quantity_packs and i.sku='GLOA-MATCHA-B2B-500G');
  end if;

  select * into item from public.inventory_items where sku='GLOA-MATCHA-B2B-500G' for update;
  if item.id is null or not item.is_active or lower(item.unit) not in ('stück','stueck')
     or item.current_quantity is null or item.current_quantity<>trunc(item.current_quantity)
     or item.current_quantity<agreement.quantity_packs
       +coalesce((select sum(units) from public.matcha_checkout_reservations where item_id=item.id and state='held'),0)
       +coalesce((select sum(units) from public.matcha_b2b_delivery_reservations where item_id=item.id and state='held'),0)
  then return false; end if;

  insert into public.matcha_checkout_reservations(attempt_id,item_id,units)
  values(target,item.id,agreement.quantity_packs);
  return true;
end;
$$;

-- Called only after the payment processor re-read the paid initial invoice.
create function public.bind_matcha_first_invoice(checkout_kind text, contract_id uuid, invoice_id text)
returns void language plpgsql security definer set search_path='' as $$
declare target uuid;
begin
  if invoice_id is null or left(invoice_id,3)<>'in_' or length(invoice_id)<=3 then raise exception 'invalid_initial_invoice'; end if;
  if checkout_kind='subscription' then
    target := (select f.attempt_id from public.matcha_first_checkout f join public.checkout_attempts a on a.id=f.attempt_id
    where f.kind=checkout_kind and a.subscription_id=contract_id);
  elsif checkout_kind='b2b' then
    select a.checkout_attempt_id into target from public.b2b_supply_agreements a
    join public.matcha_first_checkout f on f.attempt_id=a.checkout_attempt_id and f.kind=checkout_kind
    where a.id=contract_id and a.plan_type='monthly';
  else raise exception 'invalid_initial_invoice_kind';
  end if;
  if target is null then return; end if;
  perform 1 from public.checkout_attempts where id=target for update;
  update public.matcha_first_checkout set first_invoice=invoice_id where attempt_id=target
    and (first_invoice is null or first_invoice=invoice_id);
  if not found then raise exception 'initial_invoice_mismatch'; end if;
end;
$$;

create or replace function public.reserve_due_matcha_order_v1() returns trigger
language plpgsql security definer set search_path='' as $$
declare a public.checkout_attempts; target uuid;
begin
  select * into a from public.checkout_attempts where id=new.checkout_attempt_id;
  if a.id is null or (a.subscription_id is null and a.annual_delivery_number is null) then return null; end if;
  if new.payment_status<>'paid' or new.cancelled_at is not null or new.historical_payment_unverified then
    raise exception 'inventory_due_delivery_unavailable';
  end if;
  if a.annual_delivery_number=1 then
    select f.attempt_id into target from public.annual_plans p
    join public.matcha_first_checkout f on f.attempt_id=p.payment_checkout_attempt_id and f.kind='annual'
    where p.id=a.annual_plan_id;
  elsif a.subscription_id is not null then
    select f.attempt_id into target from public.matcha_first_checkout f
    join public.checkout_attempts origin on origin.id=f.attempt_id
    where f.kind='subscription' and origin.subscription_id=a.subscription_id and f.first_invoice=a.stripe_invoice_id;
  end if;

  if target is null then
    if not public.hold_matcha_attempt_stock_v1(a.id,true) then raise exception 'inventory_due_delivery_unavailable'; end if;
  else
    perform 1 from public.checkout_attempts where id=target for update;
    if jsonb_typeof(a.items_snapshot) is distinct from 'array' or jsonb_array_length(a.items_snapshot)=0 then
      raise exception 'inventory_first_delivery_items_missing';
    end if;
    if exists (
      with expected as (
        select i.id as item_id, sum(l.quantity)::bigint as units
        from jsonb_to_recordset(a.items_snapshot) l("variantId" uuid,sku text,quantity integer)
        left join public.product_variants v on v.id=l."variantId" and v.sku=l.sku
        left join public.inventory_items i on i.id=v.inventory_item_id and i.sku=v.sku
        group by i.id
      ), held as (
        select item_id, units::bigint from public.matcha_checkout_reservations where attempt_id=target and state='held'
      ) select 1 from expected e full join held h using(item_id) where e.units is distinct from h.units or e.item_id is null
    ) then raise exception 'inventory_first_delivery_items_mismatch'; end if;
    update public.matcha_first_checkout set transferred=true where attempt_id=target and not transferred;
    if not found then raise exception 'inventory_first_delivery_already_transferred'; end if;
    update public.matcha_checkout_reservations set attempt_id=a.id
      where attempt_id=target and state='held';
    if not found then raise exception 'inventory_first_delivery_hold_missing'; end if;
  end if;
  return null;
end;
$$;

create function public.adopt_matcha_first_b2b_delivery() returns trigger
language plpgsql security definer set search_path='' as $$
declare a public.b2b_supply_agreements; target uuid; reservation public.matcha_checkout_reservations;
begin
  select * into a from public.b2b_supply_agreements where id=new.supply_agreement_id;
  select f.attempt_id into target from public.matcha_first_checkout f
    where f.attempt_id=a.checkout_attempt_id and f.kind='b2b'
      and ((a.plan_type='annual' and new.delivery_number=1)
        or (a.plan_type='monthly' and f.first_invoice=new.stripe_invoice_id));
  if target is null then return null; end if;
  perform 1 from public.checkout_attempts where id=target for update;
  if a.plan_type='annual' and not exists(select 1 from public.checkout_attempts where id=target and status='paid')
  then raise exception 'inventory_first_b2b_payment_missing'; end if;
  update public.matcha_first_checkout set transferred=true where attempt_id=target and not transferred;
  if not found then raise exception 'inventory_first_b2b_delivery_already_transferred'; end if;
  select * into strict reservation from public.matcha_checkout_reservations where attempt_id=target and state='held';
  if reservation.units<>new.quantity_packs then raise exception 'inventory_first_b2b_quantity_mismatch'; end if;
  perform 1 from public.inventory_items where id=reservation.item_id and sku='GLOA-MATCHA-B2B-500G' for update;
  if not found then raise exception 'inventory_first_b2b_item_mismatch'; end if;
  insert into public.matcha_b2b_delivery_reservations(delivery_id,item_id,units,shipment_operation)
    values(new.id,reservation.item_id,reservation.units,reservation.shipment_operation);
  delete from public.matcha_checkout_reservations where attempt_id=target and item_id=reservation.item_id;
  return null;
end;
$$;
create trigger adopt_matcha_first_b2b_delivery after insert on public.b2b_deliveries
for each row execute function public.adopt_matcha_first_b2b_delivery();

revoke all on function public.adopt_matcha_first_b2b_delivery() from public, anon, authenticated, service_role;
revoke all on function public.reserve_matcha_first_checkout(uuid,text),public.bind_matcha_first_invoice(text,uuid,text)
  from public, anon, authenticated;
grant execute on function public.reserve_matcha_first_checkout(uuid,text),public.bind_matcha_first_invoice(text,uuid,text) to service_role;

commit;
