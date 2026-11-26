begin;

create table public.manual_b2b_deliveries (
  id uuid primary key,
  order_id uuid not null references public.orders(id),
  order_item_id uuid not null references public.order_items(id),
  inventory_item_id uuid not null references public.inventory_items(id),
  receipt_id uuid not null references public.matcha_lots(receipt_id),
  proof_id uuid not null unique references public.documents(id),
  occurred_on date not null,
  units integer not null check(units>0),
  method text not null check(method in ('personal','pickup','carrier')),
  recipient text not null,
  reference text not null,
  actor uuid not null,
  created_at timestamptz not null default now()
);
create index manual_b2b_deliveries_order on public.manual_b2b_deliveries(order_id,order_item_id);
create unique index manual_b2b_deliveries_reference on public.manual_b2b_deliveries(order_id,lower(reference));
alter table public.manual_b2b_deliveries enable row level security;
revoke all on public.manual_b2b_deliveries from public,anon,authenticated,service_role;
grant select on public.manual_b2b_deliveries to service_role;

create function public.record_manual_b2b_delivery_v1(actor uuid,target uuid,operation uuid,line_id uuid,lot uuid,proof uuid,
  amount integer,delivered_on date,recipient text,reference text)
returns uuid language plpgsql security definer set search_path='' as $$
declare
  sale public.orders;
  line public.order_items;
  item public.inventory_items;
  evidence public.documents;
  prior public.manual_b2b_deliveries;
  outcome jsonb;
begin
  if not exists(select 1 from public.admin_users where user_id=actor and is_active and role='owner')
  then raise exception 'manual_b2b_delivery_forbidden' using errcode='42501'; end if;
  perform public.require_creator_b2b_release_writes_v1();
  perform public.require_release_writes_v1('matcha_lot_release_writes_enabled');
  if operation is null or amount is null or amount not between 1 and 10000
    or delivered_on is null or delivered_on>(now() at time zone 'Europe/Berlin')::date
    or length(coalesce(btrim(recipient),'')) not between 2 and 80
    or length(coalesce(btrim(reference),'')) not between 3 and 80
  then raise exception 'manual_b2b_delivery_invalid'; end if;
  select * into strict sale from public.orders where id=target for update;
  select * into prior from public.manual_b2b_deliveries where id=operation;
  if found then
    if (prior.order_id,prior.order_item_id,prior.receipt_id,prior.proof_id,prior.units,prior.occurred_on,prior.recipient,prior.reference)
      is distinct from (target,line_id,lot,proof,amount,delivered_on,btrim(recipient),btrim(reference))
    then raise exception 'manual_b2b_delivery_conflict'; end if;
    return operation;
  end if;
  if sale.manual_b2b is null or sale.status<>'confirmed' or sale.cancelled_at is not null
    or coalesce(sale.manual_b2b->>'delivery','') not in ('personal','pickup','carrier')
    or delivered_on < (sale.manual_b2b->'request'->>'orderedOn')::date
    or coalesce((select sum(gross_cents) from public.financial_events
        where order_id=target and kind='manual_b2b_payment'),0)<sale.total_gross_cents
    or exists(select 1 from public.financial_events where order_id=target and kind='refund')
    then raise exception 'manual_b2b_delivery_payment_unconfirmed'; end if;
  select * into strict line from public.order_items where id=line_id and order_id=target;
  if line.sku not in ('GLOA-MATCHA-30G','GLOA-MATCHA-50G','GLOA-MATCHA-100G','GLOA-MATCHA-B2B-500G')
    or amount+coalesce((select sum(units) from public.manual_b2b_deliveries where order_item_id=line_id),0)>line.quantity
  then raise exception 'manual_b2b_delivery_units_invalid'; end if;
  select * into strict evidence from public.documents where id=proof for update;
  if evidence.kind not in ('other','b2b_document') or evidence.cleanup_operation_id is not null
    or evidence.file_sha256 is null or evidence.storage_path !~ ('^'||proof::text||'/original[.](pdf|jpg|png)$')
    or not exists(select 1 from storage.buckets b join storage.objects o on o.bucket_id=b.id
        where b.id='gloa-finance-documents' and not b.public and o.name=evidence.storage_path)
    or exists(select 1 from public.document_links where document_id=proof and not(subject_type='order' and subject_id=target))
  then raise exception 'manual_b2b_delivery_document_invalid'; end if;
  select * into item from public.inventory_items where sku=line.sku and is_active for update;
  if item.id is null or item.current_quantity is null or item.current_quantity<>trunc(item.current_quantity)
    or item.current_quantity<amount
      +coalesce((select sum(units) from public.matcha_checkout_reservations where item_id=item.id and state='held'),0)
      +coalesce((select sum(units) from public.matcha_b2b_delivery_reservations where item_id=item.id and state='held'),0)
    or not exists(select 1 from public.matcha_lots l join public.inventory_movements m on m.id=l.receipt_id
              where l.receipt_id=lot and l.lot_kind='packed' and m.inventory_item_id=item.id)
  then raise exception 'manual_b2b_delivery_stock_unavailable'; end if;
  insert into public.manual_b2b_deliveries(id,order_id,order_item_id,inventory_item_id,receipt_id,proof_id,
    occurred_on,units,method,recipient,reference,actor)
    values(operation,target,line_id,item.id,lot,proof,delivered_on,amount,sale.manual_b2b->>'delivery',
           btrim(recipient),btrim(reference),actor);
  insert into public.matcha_lot_picks(movement_operation,actor,receipt_quantities)
    values(operation,actor,jsonb_build_object(lot::text,amount));
  outcome:=public.record_inventory_movement(operation,item.id,amount,'withdrawal','b2b',
    p_reference=>target::text,p_allow_negative=>false);
  if outcome->>'result' is distinct from 'recorded' then raise exception 'manual_b2b_movement_failed'; end if;
  insert into public.document_links(document_id,subject_type,subject_id) values(proof,'order',target)
    on conflict do nothing;
  perform public.record_admin_activity(actor,'fulfillment','manual_b2b_delivery_recorded','order',target::text,
    'Manual B2B handover documented',operation,jsonb_build_object('units',amount,'line',line_id,'proof',proof));
  return operation;
end;
$$;
revoke all on function public.record_manual_b2b_delivery_v1(uuid,uuid,uuid,uuid,uuid,uuid,integer,date,text,text)
  from public,anon,authenticated,service_role;
grant execute on function public.record_manual_b2b_delivery_v1(uuid,uuid,uuid,uuid,uuid,uuid,integer,date,text,text)
  to service_role;

create or replace function public.apply_matcha_lot_movement_v1() returns trigger
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
  if v_order is null and v_delivery is null and new.reason='b2b' then
    select d.order_id into v_order from public.manual_b2b_deliveries d
      where d.id=new.operation_id and d.inventory_item_id=new.inventory_item_id and d.units=-new.quantity_delta;
  end if;
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

commit;
