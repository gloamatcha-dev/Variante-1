begin;
create table public.matcha_b2b_delivery_reservations (
  delivery_id uuid primary key references public.b2b_deliveries(id),
  item_id uuid not null references public.inventory_items(id),
  units integer not null check (units > 0),
  state text not null default 'held' check(state in ('held','released','shipped')),
  shipment_operation uuid not null unique default gen_random_uuid(),
  dispatch_actor uuid
);
alter table public.matcha_b2b_delivery_reservations enable row level security;
revoke all on public.matcha_b2b_delivery_reservations from public,anon,authenticated,service_role;
create index matcha_b2b_held_stock on public.matcha_b2b_delivery_reservations(item_id) where state='held';

create table public.matcha_b2b_refunded_payments (
  payment_intent_id text primary key,
  delivery_id uuid unique references public.b2b_deliveries(id),
  schedule_id uuid unique references public.b2b_payment_schedule(id),
  invoice_id text,
  captured_cents integer not null check (captured_cents > 0),
  recorded_at timestamptz not null default now(),
  check (num_nonnulls(delivery_id,schedule_id)=1)
);
alter table public.matcha_b2b_refunded_payments enable row level security;
revoke all on public.matcha_b2b_refunded_payments from public,anon,authenticated,service_role;

create function public.matcha_b2b_payment_verified_v1(target uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select coalesce((select a.status='active' and a.pack_grams=500
    and not exists(select 1 from public.financial_events f where f.kind='refund'
      and (f.b2b_agreement_id=a.id or f.order_id=d.order_id))
    and not exists(select 1 from public.matcha_b2b_refunded_payments r where r.delivery_id=d.id)
    and case a.plan_type
      when 'monthly' then exists(select 1 from public.financial_events f
        where f.kind='b2b_settlement' and f.direction='inflow' and f.b2b_agreement_id=a.id
          and f.external_reference=d.stripe_invoice_id and f.gross_cents>0
          and not exists(select 1 from public.financial_events x where x.reverses_event_id=f.id))
      when 'annual' then
        (select count(*) from public.b2b_payment_schedule p where p.supply_agreement_id=a.id)=a.instalment_count
        and exists(select 1 from public.b2b_payment_schedule p where p.supply_agreement_id=a.id
          and p.instalment_number=1 and p.status='paid' and p.paid_at is not null
          and not exists(select 1 from public.matcha_b2b_refunded_payments r where r.schedule_id=p.id))
        and not exists(select 1 from public.b2b_payment_schedule p where p.supply_agreement_id=a.id
          and (p.status in ('payment_failed','action_required','void') or
               (p.due_at<=greatest(d.scheduled_for,now()) and (p.status<>'paid' or p.paid_at is null or
                 exists(select 1 from public.matcha_b2b_refunded_payments r where r.schedule_id=p.id)))))
      else false end
    from public.b2b_deliveries d join public.b2b_supply_agreements a on a.id=d.supply_agreement_id
    where d.id=target),false)
$$;
revoke all on function public.matcha_b2b_payment_verified_v1(uuid) from public,anon,authenticated,service_role;

create function public.admin_matcha_b2b_delivery_v1(actor uuid,target uuid,action text) returns text
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
revoke all on function public.admin_matcha_b2b_delivery_v1(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.admin_matcha_b2b_delivery_v1(uuid,uuid,text) to service_role;

create function public.apply_matcha_b2b_delivery_stock_v1() returns trigger
language plpgsql security definer set search_path='' as $$
declare h public.matcha_b2b_delivery_reservations; result jsonb;
begin
  if new.status='dispatched' and old.status is distinct from new.status then
    select * into h from public.matcha_b2b_delivery_reservations where delivery_id=old.id for update;
    if old.status<>'scheduled' or old.resolved_at is null or old.scheduled_for>now()
       or h.state is distinct from 'held' or h.dispatch_actor is null or h.units<>old.quantity_packs
       or not public.matcha_b2b_payment_verified_v1(old.id)
    then raise exception 'inventory_b2b_dispatch_not_authorized'; end if;
    perform 1 from public.inventory_items where id=h.item_id and sku='GLOA-MATCHA-B2B-500G' and is_active for update;
    if not found then raise exception 'inventory_b2b_mapping_changed'; end if;
    update public.matcha_b2b_delivery_reservations set state='shipped' where delivery_id=old.id;
    result:=public.record_inventory_movement(h.shipment_operation,h.item_id,h.units,'withdrawal','b2b',
      p_reference=>old.id::text,p_allow_negative=>false);
    if result->>'result' is distinct from 'recorded' then raise exception 'inventory_b2b_shipment_failed'; end if;
  elsif new.status in ('held','cancelled') and old.status is distinct from new.status then
    update public.matcha_b2b_delivery_reservations set state='released',dispatch_actor=null
      where delivery_id=old.id and state='held';
  end if;
  return null;
end;
$$;
revoke all on function public.apply_matcha_b2b_delivery_stock_v1() from public,anon,authenticated,service_role;
create trigger matcha_b2b_delivery_stock after update on public.b2b_deliveries
for each row execute function public.apply_matcha_b2b_delivery_stock_v1();

-- Ledger refund entries alone do not prove full, delivery-specific loss of
-- payment coverage. The existing payment guard can still hold dispatch.
create function public.record_matcha_b2b_full_refund_v1(payment_intent text,invoice text,captured_cents integer)
returns text language plpgsql security definer set search_path='' as $$
declare
  matched record;
  delivery public.b2b_deliveries;
  installment public.b2b_payment_schedule;
  existing public.matcha_b2b_refunded_payments;
  agreement uuid;
begin
  if payment_intent is null or payment_intent !~ '^pi_[a-zA-Z0-9_]+$' or captured_cents is null
     or captured_cents<=0 or (invoice is not null and invoice !~ '^in_[a-zA-Z0-9_]+$')
  then return 'unverified'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('matcha:b2b:refund:'||payment_intent,0));

  for matched in
    select d.supply_agreement_id,d.id,false as annual
      from public.b2b_deliveries d where d.stripe_invoice_id=invoice
    union all
    select p.supply_agreement_id,p.id,true
      from public.b2b_payment_schedule p
      where p.stripe_payment_intent_id=payment_intent or p.stripe_invoice_id=invoice
  loop
    if agreement is not null then return 'ambiguous'; end if;
    agreement:=matched.supply_agreement_id;
    if matched.annual then installment.id:=matched.id;
    else delivery.id:=matched.id; end if;
  end loop;
  if agreement is null then return 'not_found'; end if;
  -- The same agreement lock serializes the refund with reserve and dispatch.
  perform 1 from public.b2b_supply_agreements a where a.id=agreement and a.pack_grams=500
    and a.plan_type=case when installment.id is null then 'monthly' else 'annual' end for update;
  if not found then return 'unverified'; end if;

  if installment.id is not null then
    select * into installment from public.b2b_payment_schedule p where p.id=installment.id for update;
    if not found or installment.supply_agreement_id<>agreement or installment.status<>'paid'
       or installment.paid_at is null or installment.gross_cents is distinct from captured_cents
       or (installment.stripe_payment_intent_id is not null and installment.stripe_payment_intent_id<>payment_intent)
       or installment.stripe_invoice_id is distinct from invoice
    then return 'unverified'; end if;
  else
    select * into delivery from public.b2b_deliveries d where d.id=delivery.id for update;
    if not found or delivery.supply_agreement_id<>agreement or delivery.stripe_invoice_id is distinct from invoice
       or not exists(select 1 from public.financial_events f
          where f.kind='b2b_settlement' and f.direction='inflow' and f.b2b_agreement_id=agreement
            and f.external_reference=invoice and f.gross_cents=captured_cents
            and not exists(select 1 from public.financial_events x where x.reverses_event_id=f.id))
    then return 'unverified'; end if;
  end if;

  select * into existing from public.matcha_b2b_refunded_payments r
    where r.payment_intent_id=payment_intent;
  if found then
    if existing.delivery_id is not distinct from delivery.id and existing.schedule_id is not distinct from installment.id
       and existing.invoice_id is not distinct from invoice and existing.captured_cents=captured_cents
    then return 'unchanged'; end if;
    return 'ambiguous';
  end if;

  insert into public.matcha_b2b_refunded_payments(payment_intent_id,delivery_id,schedule_id,invoice_id,captured_cents)
    values(payment_intent,delivery.id,installment.id,invoice,captured_cents) on conflict do nothing;
  if not found then return 'ambiguous'; end if;

  update public.matcha_b2b_delivery_reservations r set state='released',dispatch_actor=null
    from public.b2b_deliveries d
    where d.id=r.delivery_id and r.state='held' and d.status not in ('dispatched','delivered')
      and d.supply_agreement_id=agreement
      and (d.id=delivery.id or (installment.id is not null and
        (installment.instalment_number=1 or installment.due_at<=greatest(d.scheduled_for,now()))));
  return 'applied';
end;
$$;
revoke all on function public.record_matcha_b2b_full_refund_v1(text,text,integer) from public,anon,authenticated;
grant execute on function public.record_matcha_b2b_full_refund_v1(text,text,integer) to service_role;

create function public.guard_matcha_b2b_stock_v1() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if exists(select 1 from public.matcha_b2b_delivery_reservations where item_id=old.id and state='held')
    and (not new.is_active or new.current_quantity is null or new.unit is distinct from old.unit
      or new.sku is distinct from old.sku or new.current_quantity<
        (select sum(units) from public.matcha_b2b_delivery_reservations where item_id=old.id and state='held'))
  then raise exception 'inventory_b2b_stock_is_reserved'; end if;
  return new;
end;
$$;
revoke all on function public.guard_matcha_b2b_stock_v1() from public,anon,authenticated,service_role;
create trigger matcha_b2b_stock_guard before update on public.inventory_items
for each row execute function public.guard_matcha_b2b_stock_v1();

create function public.read_matcha_b2b_delivery_stock_v1(ids uuid[])
returns table (delivery_id uuid, payment_verified boolean, reservation_state text)
language sql stable security definer set search_path='' as $$
  select d.id,public.matcha_b2b_payment_verified_v1(d.id),r.state
  from public.b2b_deliveries d left join public.matcha_b2b_delivery_reservations r on r.delivery_id=d.id
  where d.id=any(ids)
$$;
revoke all on function public.read_matcha_b2b_delivery_stock_v1(uuid[]) from public,anon,authenticated;
grant execute on function public.read_matcha_b2b_delivery_stock_v1(uuid[]) to service_role;

create or replace function public.read_matcha_checkout_stock_v1(ids uuid[])
returns table (item_id uuid, physical numeric, reserved bigint, available numeric)
language sql stable security definer set search_path='' as $$
  select i.id,i.current_quantity,coalesce(h.units,0),i.current_quantity-coalesce(h.units,0)
  from public.inventory_items i
  left join lateral (
    select sum(r.units) units from (
      select units from public.matcha_checkout_reservations where item_id=i.id and state='held'
      union all
      select units from public.matcha_b2b_delivery_reservations where item_id=i.id and state='held'
    ) r
  ) h on true
  where i.id=any(ids) and i.sku in ('GLOA-MATCHA-30G','GLOA-MATCHA-50G','GLOA-MATCHA-100G','GLOA-MATCHA-B2B-500G')
$$;

commit;
