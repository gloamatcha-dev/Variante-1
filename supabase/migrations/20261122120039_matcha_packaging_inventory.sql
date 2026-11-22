begin;

create function public.admin_pack_matcha_inventory_v1(
  actor uuid, operation uuid, variant_sku text, units integer
) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  grams integer;
  raw_id uuid;
  packed_id uuid;
  withdrawal_id uuid;
  receipt_id uuid;
  prior_out public.inventory_movements;
  prior_in public.inventory_movements;
  out_result jsonb;
  in_result jsonb;
begin
  if not exists(select 1 from public.admin_users where user_id=actor and is_active and role in ('owner','admin'))
  then raise exception 'inventory_pack_forbidden' using errcode='42501'; end if;
  grams := case variant_sku when 'GLOA-MATCHA-30G' then 30
    when 'GLOA-MATCHA-50G' then 50 when 'GLOA-MATCHA-100G' then 100
    when 'GLOA-MATCHA-B2B-500G' then 500 end;
  if operation is null or grams is null or units is null or units not between 1 and 1000000
  then raise exception 'inventory_pack_invalid' using errcode='22023'; end if;

  perform pg_advisory_xact_lock(hashtextextended('matcha:pack:'||operation::text,0));
  withdrawal_id := md5('matcha:pack:out:'||operation::text)::uuid;
  receipt_id := md5('matcha:pack:in:'||operation::text)::uuid;
  select * into prior_out from public.inventory_movements where operation_id=withdrawal_id;
  select * into prior_in from public.inventory_movements where operation_id=receipt_id;
  if prior_out.id is not null or prior_in.id is not null then
    if prior_out.id is null or prior_in.id is null
      or prior_out.quantity_delta is distinct from -(grams::numeric*units)
      or prior_in.quantity_delta is distinct from units::numeric
      or prior_out.reference is distinct from ('Abpackung '||variant_sku||' '||operation::text)
      or prior_in.reference is distinct from prior_out.reference
    then raise exception 'inventory_pack_operation_conflict' using errcode='23505'; end if;
    return jsonb_build_object('result','already_recorded');
  end if;

  if grams=500 then
    select id into packed_id from public.inventory_items where sku='GLOA-MATCHA-B2B-500G';
  else
    select v.inventory_item_id into packed_id from public.product_variants v
    where v.sku=variant_sku and v.size_grams=grams and v.is_active for share;
  end if;
  select id into raw_id from public.inventory_items where sku='GLOA-MATCHA-RAW';
  if raw_id is null or packed_id is null or raw_id=packed_id
  then raise exception 'inventory_pack_mapping_missing'; end if;
  perform 1 from public.inventory_items where id in (raw_id,packed_id) order by id for update;
  if not exists(select 1 from public.inventory_items where id=raw_id and sku='GLOA-MATCHA-RAW' and unit='g' and is_active)
    or not exists(select 1 from public.inventory_items where id=packed_id and sku=variant_sku
                  and lower(unit) in ('stück','stueck') and is_active
                  and current_quantity>=0 and current_quantity=trunc(current_quantity))
  then raise exception 'inventory_pack_mapping_invalid'; end if;

  out_result := public.admin_record_inventory_movement(actor,withdrawal_id,raw_id,grams::numeric*units,
    'withdrawal','bottling',p_reference=>'Abpackung '||variant_sku||' '||operation::text,p_allow_negative=>false);
  if out_result->>'result' is distinct from 'recorded' then raise exception 'inventory_pack_raw_unavailable'; end if;
  in_result := public.admin_record_inventory_movement(actor,receipt_id,packed_id,units,
    'receipt','goods_receipt',p_reference=>'Abpackung '||variant_sku||' '||operation::text,p_allow_negative=>false);
  if in_result->>'result' is distinct from 'recorded' then raise exception 'inventory_pack_receipt_failed'; end if;
  return jsonb_build_object('result','recorded','raw_after',out_result->'balance_after','packed_after',in_result->'balance_after');
end;
$$;

revoke all on function public.admin_pack_matcha_inventory_v1(uuid,uuid,text,integer) from public,anon,authenticated;
grant execute on function public.admin_pack_matcha_inventory_v1(uuid,uuid,text,integer) to service_role;

commit;
