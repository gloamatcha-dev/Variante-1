begin;

-- Lots describe existing ledger receipts. Quantities are derived from those
-- receipts and allocations, while inventory_items remains the stock authority.
create table public.matcha_lots (
  receipt_id uuid primary key references public.inventory_movements(id),
  lot_kind text not null check (lot_kind in ('raw','packed')),
  lot_code text not null,
  best_before date not null,
  packing_withdrawal_id uuid unique references public.inventory_movements(id),
  check ((lot_kind='packed') = (packing_withdrawal_id is not null))
);

create table public.matcha_lot_allocations (
  withdrawal_id uuid not null references public.inventory_movements(id),
  receipt_id uuid not null references public.matcha_lots(receipt_id),
  quantity numeric(14,3) not null check (quantity>0),
  order_id uuid references public.orders(id),
  delivery_id uuid references public.b2b_deliveries(id),
  primary key (withdrawal_id,receipt_id),
  check (num_nonnulls(order_id,delivery_id)<=1)
);
create index matcha_lot_allocations_receipt on public.matcha_lot_allocations(receipt_id);

create table public.matcha_lot_status_events (
  id bigint generated always as identity primary key,
  receipt_id uuid not null references public.matcha_lots(receipt_id),
  operation_id uuid unique not null,
  actor uuid not null,
  blocked boolean not null,
  reason text not null check (length(btrim(reason)) between 1 and 500),
  recorded_at timestamptz not null default clock_timestamp()
);
create index matcha_lot_status_events_receipt on public.matcha_lot_status_events(receipt_id,id desc);

create table public.matcha_lot_picks (
  movement_operation uuid primary key,
  actor uuid not null,
  receipt_quantities jsonb not null,
  recorded_at timestamptz not null default clock_timestamp()
);

alter table public.matcha_lots enable row level security;
alter table public.matcha_lot_allocations enable row level security;
alter table public.matcha_lot_status_events enable row level security;
alter table public.matcha_lot_picks enable row level security;
revoke all on public.matcha_lots,public.matcha_lot_allocations,public.matcha_lot_status_events,public.matcha_lot_picks
  from public,anon,authenticated,service_role;

create view public.matcha_lot_balances with (security_invoker=true) as
select l.*, m.inventory_item_id, m.supplier, m.occurred_at, m.quantity_delta as received_quantity,
  m.quantity_delta-coalesce(used.quantity,0) as remaining_quantity,
  coalesce(last_event.blocked,false) as blocked
from public.matcha_lots l
join public.inventory_movements m on m.id=l.receipt_id
left join lateral (
  select sum(a.quantity) as quantity from public.matcha_lot_allocations a where a.receipt_id=l.receipt_id
) used on true
left join lateral (
  select e.blocked from public.matcha_lot_status_events e where e.receipt_id=l.receipt_id order by e.id desc limit 1
) last_event on true;
revoke all on public.matcha_lot_balances from public,anon,authenticated,service_role;

create function public.apply_matcha_lot_movement_v1() returns trigger
language plpgsql security definer set search_path='' as $$
declare
  v_sku text; v_operation uuid; v_source uuid; v_order uuid; v_delivery uuid;
  v_mhd date; v_quantity numeric; v_part numeric; v_lot record; v_pack boolean; v_pick jsonb;
  v_pack_withdrawal boolean; v_correction boolean;
  v_today date := (clock_timestamp() at time zone 'Europe/Berlin')::date;
begin
  select sku into v_sku from public.inventory_items where id=new.inventory_item_id;
  if v_sku is null or v_sku not in ('GLOA-MATCHA-RAW','GLOA-MATCHA-30G','GLOA-MATCHA-50G',
    'GLOA-MATCHA-100G','GLOA-MATCHA-B2B-500G') then return null; end if;

  if not public.release_writes_enabled_v1('matcha_lot_release_writes_enabled') then
    -- Before activation leave legacy inventory alone. After traced intake,
    -- freeze tracked movements so a rollback cannot make the lot ledger diverge.
    if exists(select 1 from public.matcha_lots) then
      raise exception 'inventory_lot_traceability_paused' using errcode='55000';
    end if;
    return null;
  end if;

  -- Existing movement writers hold this item lock before they change stock.
  perform 1 from public.inventory_items where id=new.inventory_item_id for update;
  perform pg_advisory_xact_lock(hashtextextended('matcha:lot:eligibility',0));
  v_pack := coalesce(new.reference ~ '^Abpackung GLOA-MATCHA-(30G|50G|100G|B2B-500G) [0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$',false);
  if v_pack then v_operation := right(new.reference,36)::uuid; end if;
  if new.quantity_delta>0 then
    if v_sku='GLOA-MATCHA-RAW' and new.movement_type='receipt' and new.reason='goods_receipt' then
      if nullif(btrim(new.supplier),'') is null or nullif(btrim(new.batch_number),'') is null
         or new.best_before_date is null then raise exception 'inventory_lot_receipt_metadata_required'; end if;
      insert into public.matcha_lots(receipt_id,lot_kind,lot_code,best_before)
        values(new.id,'raw',new.batch_number,new.best_before_date);
    elsif v_pack and v_sku<>'GLOA-MATCHA-RAW'
      and new.operation_id=md5('matcha:pack:in:'||v_operation::text)::uuid then
      select m.id into v_source from public.inventory_movements m
        where m.operation_id=md5('matcha:pack:out:'||v_operation::text)::uuid
          and m.reason='bottling' and m.reference=new.reference;
      select min(l.best_before) into v_mhd
        from public.matcha_lot_allocations a join public.matcha_lots l on l.receipt_id=a.receipt_id
        where a.withdrawal_id=v_source;
      if v_mhd is null then raise exception 'inventory_lot_packing_source_missing'; end if;
      insert into public.matcha_lots(receipt_id,lot_kind,lot_code,best_before,packing_withdrawal_id)
        values(new.id,'packed',v_operation::text,v_mhd,v_source);
    else
      raise exception 'inventory_lot_positive_movement_unverified';
    end if;
    return null;
  end if;

  select o.id into v_order from public.matcha_checkout_reservations r
    join public.orders o on o.checkout_attempt_id=r.attempt_id
    where r.shipment_operation=new.operation_id and r.item_id=new.inventory_item_id and r.state='shipped';
  select r.delivery_id into v_delivery from public.matcha_b2b_delivery_reservations r
    where r.shipment_operation=new.operation_id and r.item_id=new.inventory_item_id and r.state='shipped';
  v_quantity := -new.quantity_delta;
  v_pack_withdrawal := v_pack and v_sku='GLOA-MATCHA-RAW' and new.reason='bottling'
    and new.operation_id=md5('matcha:pack:out:'||v_operation::text)::uuid;
  select receipt_quantities into v_pick from public.matcha_lot_picks where movement_operation=new.operation_id;
  v_correction := new.movement_type='withdrawal' and new.reason='correction' and v_pick is not null;
  if v_pack_withdrawal or v_order is not null or v_delivery is not null then
    if v_pick is null then raise exception 'inventory_lot_pick_required'; end if;
  end if;

  if v_pack_withdrawal or v_order is not null or v_delivery is not null or v_correction then
    for v_lot in
      select b.receipt_id,b.remaining_quantity from public.matcha_lot_balances b
      where b.inventory_item_id=new.inventory_item_id and b.remaining_quantity>0
        and (v_pick is null or v_pick ? b.receipt_id::text)
        and (v_correction or (not b.blocked and b.best_before>=greatest(v_today,(new.occurred_at at time zone 'Europe/Berlin')::date)
        and not exists (
          select 1 from public.matcha_lot_allocations a
          join public.matcha_lot_balances raw on raw.receipt_id=a.receipt_id
          where a.withdrawal_id=b.packing_withdrawal_id and raw.blocked
        )))
      order by b.best_before,b.occurred_at,b.receipt_id
    loop
      v_part := (v_pick->>v_lot.receipt_id::text)::numeric;
      if v_part>v_lot.remaining_quantity or v_part>v_quantity then
        raise exception 'inventory_lot_stock_unavailable';
      end if;
      insert into public.matcha_lot_allocations(withdrawal_id,receipt_id,quantity,order_id,delivery_id)
        values(new.id,v_lot.receipt_id,v_part,v_order,v_delivery);
      v_quantity := v_quantity-v_part;
      exit when v_quantity=0;
    end loop;
    if v_quantity<>0 then raise exception 'inventory_lot_stock_unavailable'; end if;
  elsif coalesce((select sum(remaining_quantity) from public.matcha_lot_balances
                  where inventory_item_id=new.inventory_item_id),0)>new.balance_after then
    -- An unlabelled reduction must not silently change a confirmed lot.
    raise exception 'inventory_lot_correction_requires_assignment';
  end if;
  return null;
end $$;
revoke all on function public.apply_matcha_lot_movement_v1() from public,anon,authenticated,service_role;
create trigger matcha_lot_movement after insert on public.inventory_movements
for each row execute function public.apply_matcha_lot_movement_v1();

create function public.guard_matcha_lot_item_identity_v1() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if (old.sku,old.unit) is distinct from (new.sku,new.unit)
    and exists(select 1 from public.matcha_lot_balances where inventory_item_id=old.id)
  then raise exception 'inventory_lot_item_identity_fixed'; end if;
  return new;
end $$;
revoke all on function public.guard_matcha_lot_item_identity_v1() from public,anon,authenticated,service_role;
create trigger matcha_lot_item_identity before update of sku,unit on public.inventory_items
for each row execute function public.guard_matcha_lot_item_identity_v1();

create function public.admin_pack_traced_matcha_v1(
  p_actor uuid,p_operation uuid,p_sku text,p_units integer,p_quantities jsonb
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_withdrawal uuid; v_saved jsonb; v_grams integer;
begin
  perform public.require_release_writes_v1('matcha_lot_release_writes_enabled');
  if not exists(select 1 from public.admin_users where user_id=p_actor and is_active
    and role in ('owner','admin')) then raise exception 'inventory_lot_forbidden' using errcode='42501'; end if;
  v_grams := case p_sku when 'GLOA-MATCHA-30G' then 30 when 'GLOA-MATCHA-50G' then 50
    when 'GLOA-MATCHA-100G' then 100 when 'GLOA-MATCHA-B2B-500G' then 500 end;
  if p_operation is null or v_grams is null or p_units is null or p_units not between 1 and 1000000
    or jsonb_typeof(p_quantities) is distinct from 'object' then raise exception 'inventory_lot_pick_invalid'; end if;
  if exists(select 1 from jsonb_each_text(p_quantities) pick
    where pick.value is null or pick.value !~ '^[0-9]{1,9}(\.[0-9]{1,3})?$')
    then raise exception 'inventory_lot_pick_invalid'; end if;
  if exists(select 1 from jsonb_each_text(p_quantities) pick where pick.value::numeric<=0)
    or (select sum(value::numeric) from jsonb_each_text(p_quantities)) is distinct from v_grams::numeric*p_units
    then raise exception 'inventory_lot_pick_invalid'; end if;
  perform pg_advisory_xact_lock(hashtextextended('matcha:pack:'||p_operation::text,0));
  v_withdrawal := md5('matcha:pack:out:'||p_operation::text)::uuid;
  select receipt_quantities into v_saved from public.matcha_lot_picks where movement_operation=v_withdrawal;
  if found and v_saved is distinct from p_quantities then raise exception 'inventory_pack_operation_conflict'; end if;
  if not found then
    if exists(select 1 from public.inventory_movements where operation_id=v_withdrawal) then
      raise exception 'inventory_lot_packing_source_missing';
    end if;
    insert into public.matcha_lot_picks(movement_operation,actor,receipt_quantities)
      values(v_withdrawal,p_actor,p_quantities);
  end if;
  return public.admin_pack_matcha_inventory_v1(p_actor,p_operation,p_sku,p_units);
end $$;
revoke all on function public.admin_pack_traced_matcha_v1(uuid,uuid,text,integer,jsonb)
  from public,anon,authenticated,service_role;
grant execute on function public.admin_pack_traced_matcha_v1(uuid,uuid,text,integer,jsonb) to service_role;

create function public.admin_correct_matcha_lot_v1(
  p_actor uuid,p_receipt uuid,p_operation uuid,p_quantity numeric,p_reason text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_item uuid; v_pick jsonb; v_saved public.matcha_lot_picks; v_prior public.inventory_movements; v_result jsonb;
begin
  perform public.require_release_writes_v1('matcha_lot_release_writes_enabled');
  if not exists(select 1 from public.admin_users where user_id=p_actor and is_active
    and role in ('owner','admin')) then raise exception 'inventory_lot_forbidden' using errcode='42501'; end if;
  select inventory_item_id into v_item from public.matcha_lot_balances
  where receipt_id=p_receipt and (lot_kind='raw' or p_quantity=trunc(p_quantity));
  if v_item is null or p_operation is null or p_quantity is null or p_quantity<=0 or p_quantity>100000000
    or p_quantity<>round(p_quantity,3) or coalesce(length(btrim(p_reason)),0) not between 1 and 500
    then raise exception 'inventory_lot_correction_invalid'; end if;
  perform pg_advisory_xact_lock(hashtextextended('matcha:lot:correction:'||p_operation::text,0));
  v_pick := jsonb_build_object(p_receipt::text,p_quantity);
  select * into v_saved from public.matcha_lot_picks where movement_operation=p_operation;
  if found then
    select * into v_prior from public.inventory_movements where operation_id=p_operation;
    if v_saved.actor is distinct from p_actor or v_saved.receipt_quantities is distinct from v_pick
       or v_prior.note is distinct from btrim(p_reason) then raise exception 'inventory_lot_correction_invalid'; end if;
  else
    if exists(select 1 from public.inventory_movements where operation_id=p_operation) then
      raise exception 'inventory_lot_correction_invalid'; end if;
    insert into public.matcha_lot_picks(movement_operation,actor,receipt_quantities)
      values(p_operation,p_actor,v_pick);
  end if;
  v_result := public.admin_record_inventory_movement(p_actor,p_operation,v_item,p_quantity,
    'withdrawal','correction',p_note=>btrim(p_reason),p_reference=>p_receipt::text,p_allow_negative=>false);
  if v_result->>'result' not in ('recorded','already_recorded') or v_result->>'result' is null then
    raise exception 'inventory_lot_correction_invalid'; end if;
  return v_result;
end $$;
revoke all on function public.admin_correct_matcha_lot_v1(uuid,uuid,uuid,numeric,text)
  from public,anon,authenticated,service_role;
grant execute on function public.admin_correct_matcha_lot_v1(uuid,uuid,uuid,numeric,text) to service_role;

create function public.guard_matcha_lot_shipment_v1() returns trigger
language plpgsql security definer set search_path='' as $$
declare missing_hold boolean; invalid_quantity boolean;
begin
  if old.shipped_at is null and old.fulfillment_status not in ('shipped','delivered')
    and (new.shipped_at is not null or new.fulfillment_status in ('shipped','delivered')) then
    select coalesce(bool_or(hold.units is null),false), coalesce(bool_or(item.units is distinct from hold.units),false)
      into missing_hold, invalid_quantity
    from (
      select oi.sku,sum(oi.quantity) units from public.order_items oi
      where oi.order_id=old.id and oi.sku in ('GLOA-MATCHA-30G','GLOA-MATCHA-50G','GLOA-MATCHA-100G')
      group by oi.sku
    ) item
    cross join lateral (
      select sum(r.units) units from public.matcha_checkout_reservations r
      join public.inventory_items i on i.id=r.item_id
      where r.attempt_id=old.checkout_attempt_id and i.sku=item.sku and r.state='held'
    ) hold;
    if missing_hold then raise exception 'inventory_lot_shipment_reservation_missing'; end if;
    if invalid_quantity then raise exception 'inventory_lot_shipment_unverified'; end if;
  end if;
  return new;
end $$;
revoke all on function public.guard_matcha_lot_shipment_v1() from public,anon,authenticated,service_role;
create trigger matcha_lot_shipment_guard before update on public.orders
for each row execute function public.guard_matcha_lot_shipment_v1();

create function public.admin_set_matcha_lot_pick_v1(
  p_actor uuid,p_reference text,p_sku text,p_quantities jsonb
) returns boolean language plpgsql security definer set search_path='' as $$
declare v_operation uuid; v_units integer; v_item uuid; v_total numeric; v_candidates integer;
begin
  perform public.require_release_writes_v1('matcha_lot_release_writes_enabled');
  if not exists(select 1 from public.admin_users where user_id=p_actor and is_active
    and role in ('owner','admin')) then raise exception 'inventory_lot_forbidden' using errcode='42501'; end if;
  if p_sku='GLOA-MATCHA-B2B-500G' then
    select r.shipment_operation,r.units,r.item_id into v_operation,v_units,v_item
    from public.matcha_b2b_delivery_reservations r join public.inventory_items i on i.id=r.item_id
    where r.delivery_id::text=p_reference and r.state='held' and i.sku=p_sku for update of r;
  else
    select r.shipment_operation,r.units,r.item_id into v_operation,v_units,v_item
    from public.orders o join public.matcha_checkout_reservations r on r.attempt_id=o.checkout_attempt_id
    join public.inventory_items i on i.id=r.item_id
    where o.order_number=upper(p_reference) and r.state='held' and i.sku=p_sku
      and p_sku in ('GLOA-MATCHA-30G','GLOA-MATCHA-50G','GLOA-MATCHA-100G') for update of o;
  end if;
  if v_operation is null or jsonb_typeof(p_quantities) is distinct from 'object' then
    raise exception 'inventory_lot_pick_invalid';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('matcha:lot:eligibility',0));
  if exists (select 1 from jsonb_each_text(p_quantities) pick where pick.value is null
    or pick.value !~ '^[1-9][0-9]{0,8}$') then raise exception 'inventory_lot_pick_invalid'; end if;
  select count(*),sum(pick.value::numeric) into v_candidates,v_total
    from jsonb_each_text(p_quantities) pick join public.matcha_lot_balances b on b.receipt_id::text=pick.key
    where b.inventory_item_id=v_item and b.lot_kind='packed' and not b.blocked
      and b.remaining_quantity>=pick.value::numeric
      and b.best_before >= (clock_timestamp() at time zone 'Europe/Berlin')::date
      and not exists(select 1 from public.matcha_lot_allocations a
        join public.matcha_lot_balances raw on raw.receipt_id=a.receipt_id
        where a.withdrawal_id=b.packing_withdrawal_id and raw.blocked);
  if v_candidates<>(select count(*) from jsonb_object_keys(p_quantities)) or v_total is distinct from v_units::numeric then
    raise exception 'inventory_lot_pick_invalid';
  end if;
  insert into public.matcha_lot_picks(movement_operation,actor,receipt_quantities)
    values(v_operation,p_actor,p_quantities)
    on conflict(movement_operation) do update set actor=excluded.actor,
      receipt_quantities=excluded.receipt_quantities,recorded_at=clock_timestamp()
    where public.matcha_lot_picks.receipt_quantities is distinct from excluded.receipt_quantities;
  return true;
end $$;
revoke all on function public.admin_set_matcha_lot_pick_v1(uuid,text,text,jsonb)
  from public,anon,authenticated,service_role;
grant execute on function public.admin_set_matcha_lot_pick_v1(uuid,text,text,jsonb) to service_role;

create function public.admin_set_matcha_lot_status_v1(
  p_actor uuid,p_receipt uuid,p_operation uuid,p_blocked boolean,p_reason text
) returns boolean
language plpgsql security definer set search_path='' as $$
declare v_prior public.matcha_lot_status_events;
begin
  perform public.require_release_writes_v1('matcha_lot_release_writes_enabled');
  if not exists(select 1 from public.admin_users where user_id=p_actor and is_active
    and role in ('owner','admin')) then raise exception 'inventory_lot_forbidden' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('matcha:lot:eligibility',0));
  select * into v_prior from public.matcha_lot_status_events where operation_id=p_operation;
  if found then
    if (v_prior.actor,v_prior.receipt_id,v_prior.blocked,v_prior.reason)
      is distinct from (p_actor,p_receipt,p_blocked,btrim(p_reason))
    then raise exception 'inventory_lot_status_conflict'; end if;
    return true;
  end if;
  insert into public.matcha_lot_status_events(receipt_id,operation_id,actor,blocked,reason)
    values(p_receipt,p_operation,p_actor,p_blocked,btrim(p_reason));
  return true;
end $$;
revoke all on function public.admin_set_matcha_lot_status_v1(uuid,uuid,uuid,boolean,text)
  from public,anon,authenticated,service_role;
grant execute on function public.admin_set_matcha_lot_status_v1(uuid,uuid,uuid,boolean,text) to service_role;

create function public.admin_read_matcha_lot_v1(p_actor uuid,p_code text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if not exists(select 1 from public.admin_users where user_id=p_actor and is_active
    and role in ('owner','admin')) then raise exception 'inventory_lot_forbidden' using errcode='42501'; end if;
  return (
    with selected as (
      select b.* from public.matcha_lot_balances b
      join public.inventory_items i on i.id=b.inventory_item_id
      where b.lot_code=p_code or i.sku=p_code or exists (
        select 1 from public.matcha_lot_allocations a
        left join public.orders o on o.id=a.order_id
        where a.receipt_id=b.receipt_id and (o.order_number=upper(p_code) or a.delivery_id::text=p_code)
      )
    ), packed as (
      select b.* from public.matcha_lot_balances b
      where b.lot_kind='packed' and (b.receipt_id in (select receipt_id from selected)
        or exists(select 1 from public.matcha_lot_allocations a
          join selected s on s.receipt_id=a.receipt_id where a.withdrawal_id=b.packing_withdrawal_id))
    ), relevant as (
      select * from selected union select * from packed
      union
      select raw.* from public.matcha_lot_balances raw where exists(
        select 1 from packed p join public.matcha_lot_allocations a on a.withdrawal_id=p.packing_withdrawal_id
        where a.receipt_id=raw.receipt_id
      )
    )
    select jsonb_build_object(
      'lots',coalesce((select jsonb_agg(to_jsonb(r)||jsonb_build_object('sku',i.sku,'eligible',
        r.remaining_quantity>0 and not r.blocked and i.is_active
        and r.best_before>=(statement_timestamp() at time zone 'Europe/Berlin')::date
        and not exists(select 1 from public.matcha_lot_allocations a
          join public.matcha_lot_balances raw on raw.receipt_id=a.receipt_id
          where a.withdrawal_id=r.packing_withdrawal_id and raw.blocked))
        order by r.best_before,r.occurred_at,r.receipt_id) from relevant r join public.inventory_items i on i.id=r.inventory_item_id),'[]'),
      'sources',coalesce((select jsonb_agg(jsonb_build_object(
        'packed_code',p.lot_code,'raw_code',raw.lot_code,'raw_receipt_id',raw.receipt_id,'grams',a.quantity))
        from packed p join public.matcha_lot_allocations a on a.withdrawal_id=p.packing_withdrawal_id
        join public.matcha_lots raw on raw.receipt_id=a.receipt_id),'[]'),
      'shipments',coalesce((select jsonb_agg(jsonb_build_object(
        'lot_code',p.lot_code,'quantity',a.quantity,'order_number',o.order_number,
        'delivery_id',a.delivery_id,'customer_id',coalesce(o.user_id,ag.user_id),
        'customer_email',coalesce(o.customer_snapshot->>'email',ag.customer_snapshot->>'email')))
        from packed p join public.matcha_lot_allocations a on a.receipt_id=p.receipt_id
        left join public.orders o on o.id=a.order_id
        left join public.b2b_deliveries d on d.id=a.delivery_id
        left join public.b2b_supply_agreements ag on ag.id=d.supply_agreement_id
        where a.order_id is not null or a.delivery_id is not null),'[]'),
      'history',coalesce((select jsonb_agg(to_jsonb(e) order by e.id desc)
        from public.matcha_lot_status_events e join relevant r on r.receipt_id=e.receipt_id),'[]'),
      'corrections',coalesce((select jsonb_agg(jsonb_build_object(
        'movement_id',m.id,'code',r.lot_code,'quantity',a.quantity,'reason',m.note,
        'actor',m.actor_email,'occurred_at',m.occurred_at) order by m.occurred_at desc)
        from relevant r join public.matcha_lot_allocations a on a.receipt_id=r.receipt_id
        join public.inventory_movements m on m.id=a.withdrawal_id
        where m.reason='correction'),'[]')
    )
  );
end $$;
revoke all on function public.admin_read_matcha_lot_v1(uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.admin_read_matcha_lot_v1(uuid,text) to service_role;

commit;
