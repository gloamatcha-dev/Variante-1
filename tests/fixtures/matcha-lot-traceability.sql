-- Run with psql against a disposable database containing the complete migration chain.
\set ON_ERROR_STOP on
begin;
update public.operations_config set int_value=1 where key='matcha_lot_release_writes_enabled';
do $$
declare
  actor uuid; category uuid; raw uuid; packed uuid; variant uuid;
  raw_early uuid; raw_late uuid; raw_expired uuid; finished uuid; receipt_op uuid;
  op uuid := gen_random_uuid(); attempt uuid := gen_random_uuid(); shipment uuid := gen_random_uuid();
  cancellation uuid := gen_random_uuid(); unverified uuid := gen_random_uuid();
  customer uuid; payload jsonb; trace jsonb;
  b2b_item uuid; b2b_raw uuid; b2b_lot uuid; b2b_op uuid:=gen_random_uuid();
  b2b_attempt uuid:=gen_random_uuid(); agreement uuid:=gen_random_uuid(); delivery uuid:=gen_random_uuid();
  berlin jsonb:='{"eligible":true,"reason":"eligible","normalizedCountry":"DE","normalizedPostcode":"10115","rulesVersion":"berlin-2026.1"}';
  today date := (clock_timestamp() at time zone 'Europe/Berlin')::date;
begin
  select user_id into strict actor from public.admin_users where is_active and role='owner' limit 1;
  customer := actor;
  insert into public.inventory_categories(name) values('Synthetic Lot Test') returning id into category;
  insert into public.inventory_items(name,sku,category_id,unit)
    values('Synthetic Raw','GLOA-MATCHA-RAW',category,'g') returning id into raw;
  insert into public.inventory_items(name,sku,category_id,unit)
    values('Synthetic 30 g','GLOA-MATCHA-30G',category,'Stueck') returning id into packed;
  update public.product_variants set inventory_item_id=packed where sku='GLOA-MATCHA-30G' returning id into strict variant;
  begin
    perform public.admin_record_inventory_movement(actor,gen_random_uuid(),packed,1,'receipt','goods_receipt');
    raise exception 'untracked finished stock created';
  exception when raise_exception then
    if sqlerrm<>'inventory_lot_positive_movement_unverified' then raise; end if;
  end;

  receipt_op:=gen_random_uuid();
  perform public.admin_record_inventory_movement(actor,receipt_op,raw,35,'receipt','goods_receipt',
    p_supplier=>'Synthetic Supplier',p_batch_number=>'LOT-EARLY',p_best_before_date=>today+10);
  select id into strict raw_early from public.inventory_movements where operation_id=receipt_op;
  receipt_op:=gen_random_uuid();
  perform public.admin_record_inventory_movement(actor,receipt_op,raw,70,'receipt','goods_receipt',
    p_supplier=>'Synthetic Supplier',p_batch_number=>'LOT-LATE',p_best_before_date=>today+30);
  select id into strict raw_late from public.inventory_movements where operation_id=receipt_op;
  receipt_op:=gen_random_uuid();
  perform public.admin_record_inventory_movement(actor,receipt_op,raw,30,'receipt','goods_receipt',
    p_supplier=>'Synthetic Supplier',p_batch_number=>'LOT-EXPIRED',p_best_before_date=>today-1);
  select id into strict raw_expired from public.inventory_movements where operation_id=receipt_op;
  trace:=public.admin_read_matcha_lot_v1(actor,'GLOA-MATCHA-RAW');
  if jsonb_path_query_array(trace->'lots','$[*] ? (@.eligible == true)')->0->>'lot_code' <> 'LOT-EARLY'
    then raise exception 'eligible FEFO recommendation is not first'; end if;
  begin
    perform public.admin_pack_traced_matcha_v1(actor,gen_random_uuid(),'GLOA-MATCHA-30G',1,jsonb_build_object(raw_expired,30));
    raise exception 'expired lot packed';
  exception when raise_exception then
    if sqlerrm<>'inventory_lot_stock_unavailable' then raise; end if;
  end;
  payload:=jsonb_build_object(raw_early,35,raw_late,25);
  if public.admin_pack_traced_matcha_v1(actor,op,'GLOA-MATCHA-30G',2,payload)->>'result'<>'recorded'
    or public.admin_pack_traced_matcha_v1(actor,op,'GLOA-MATCHA-30G',2,payload)->>'result'<>'already_recorded' then
    raise exception 'packing replay changed stock';
  end if;
  select receipt_id into strict finished from public.matcha_lots where lot_code=op::text and lot_kind='packed';
  if (select best_before from public.matcha_lots where receipt_id=finished)<>today+10
    or (select remaining_quantity from public.matcha_lot_balances where receipt_id=raw_early)<>0
    or (select current_quantity from public.inventory_items where id=raw)<>75
    or (select current_quantity from public.inventory_items where id=packed)<>2 then
    raise exception 'raw/packed balance or inherited shelf life wrong';
  end if;

  insert into public.checkout_attempts(id,request_id,expected_total_gross_cents,items_snapshot)
    values(attempt,gen_random_uuid(),2000,jsonb_build_array(jsonb_build_object('variantId',variant,'sku','GLOA-MATCHA-30G','quantity',1)));
  if not public.reserve_matcha_checkout_v1(attempt) then raise exception 'original reservation failed'; end if;
  insert into public.orders(id,checkout_attempt_id,order_number,user_id,customer_type,status,payment_status,
    customer_snapshot,shipping_address_snapshot,billing_address_snapshot)
  values(shipment,attempt,'LOT-TEST-ORDER',customer,'private','confirmed','paid',
    '{"email":"synthetic@example.invalid"}','{}','{}');
  insert into public.order_items(order_id,sku,product_name,quantity,unit_price_net_cents,unit_price_gross_cents,
    line_total_net_cents,line_total_gross_cents,line_total_tax_cents)
  values(shipment,'GLOA-MATCHA-30G','Synthetic',1,1000,1000,1000,1000,0);
  begin
    perform public.mark_order_shipped('LOT-TEST-ORDER');
    raise exception 'unconfirmed pick shipped';
  exception when raise_exception then
    if sqlerrm<>'inventory_lot_pick_required' then raise; end if;
  end;
  perform public.admin_set_matcha_lot_pick_v1(actor,'LOT-TEST-ORDER','GLOA-MATCHA-30G',jsonb_build_object(finished,1));
  receipt_op:=gen_random_uuid();
  perform public.admin_set_matcha_lot_status_v1(actor,raw_late,receipt_op,true,'Synthetic quarantine');
  perform public.admin_set_matcha_lot_status_v1(actor,raw_late,receipt_op,true,'Synthetic quarantine');
  begin
    perform public.mark_order_shipped('LOT-TEST-ORDER');
    raise exception 'descendant of blocked raw lot shipped';
  exception when raise_exception then
    if sqlerrm<>'inventory_lot_stock_unavailable' then raise; end if;
  end;
  perform public.admin_set_matcha_lot_status_v1(actor,raw_late,gen_random_uuid(),false,'Synthetic release');
  if public.mark_order_shipped('LOT-TEST-ORDER')->>'result' <> 'shipped' then raise exception 'B2C shipment not committed'; end if;
  if public.mark_order_shipped('LOT-TEST-ORDER')->>'result' <> 'already_shipped' then raise exception 'B2C shipment replay failed'; end if;
  if (select current_quantity from public.inventory_items where id=packed)<>1 then
    raise exception 'shipment replay changed inventory';
  end if;
  trace:=public.admin_read_matcha_lot_v1(actor,'LOT-EARLY');
  if jsonb_array_length(trace->'sources')<>2 or jsonb_array_length(trace->'shipments')<>1
     or trace->'shipments'->0->>'order_number'<>'LOT-TEST-ORDER' then
    raise exception 'recall lineage missing';
  end if;
  trace:=public.admin_read_matcha_lot_v1(actor,op::text);
  if jsonb_array_length(trace->'sources')<>2 then raise exception 'backward lineage missing'; end if;
  trace:=public.admin_read_matcha_lot_v1(actor,'LOT-TEST-ORDER');
  if jsonb_array_length(trace->'lots')<>3 then raise exception 'shipment provenance lookup missing'; end if;
  if has_function_privilege('authenticated','public.admin_read_matcha_lot_v1(uuid,text)','EXECUTE')
     or has_table_privilege('service_role','public.matcha_lot_allocations','INSERT') then
    raise exception 'lot privilege leak';
  end if;
  insert into public.checkout_attempts(id,request_id,expected_total_gross_cents,items_snapshot)
    values(cancellation,gen_random_uuid(),1000,jsonb_build_array(jsonb_build_object('variantId',variant,'sku','GLOA-MATCHA-30G','quantity',1)));
  if not public.reserve_matcha_checkout_v1(cancellation) then raise exception 'second hold failed'; end if;
  if public.reserve_matcha_checkout_v1(attempt) then raise exception 'shipped reservation repeated'; end if;
  insert into public.checkout_attempts(id,request_id,expected_total_gross_cents,items_snapshot)
    values(unverified,gen_random_uuid(),1000,jsonb_build_array(jsonb_build_object('variantId',variant,'sku','GLOA-MATCHA-30G','quantity',1)));
  if public.reserve_matcha_checkout_v1(unverified) then raise exception 'last pack double reserved'; end if;
  insert into public.orders(checkout_attempt_id,order_number,customer_type,status,customer_snapshot,shipping_address_snapshot,billing_address_snapshot)
    values(cancellation,'LOT-TEST-CANCEL','private','confirmed','{}','{}','{}');
  update public.orders set status='cancelled' where order_number='LOT-TEST-CANCEL';
  if not public.reserve_matcha_checkout_v1(unverified) then raise exception 'cancellation did not free hold'; end if;
  receipt_op:=gen_random_uuid();
  perform public.admin_correct_matcha_lot_v1(actor,raw_late,receipt_op,5,'Synthetic damage');
  perform public.admin_correct_matcha_lot_v1(actor,raw_late,receipt_op,5,'Synthetic damage');
  if (select current_quantity from public.inventory_items where id=raw)<>70
    or (select remaining_quantity from public.matcha_lot_balances where receipt_id=raw_late)<>40 then
    raise exception 'correction moved stock twice or wrong lot';
  end if;
  insert into public.orders(id,checkout_attempt_id,order_number,user_id,customer_type,status,payment_status,
    customer_snapshot,shipping_address_snapshot,billing_address_snapshot)
  values(gen_random_uuid(),unverified,'LOT-TEST-PARALLEL',customer,'private','confirmed','paid','{}','{}','{}');
  insert into public.order_items(order_id,sku,product_name,quantity,unit_price_net_cents,unit_price_gross_cents,
    line_total_net_cents,line_total_gross_cents,line_total_tax_cents)
  select id,'GLOA-MATCHA-30G','Synthetic parallel',1,1000,1000,1000,1000,0 from public.orders
    where order_number='LOT-TEST-PARALLEL';
  perform public.admin_set_matcha_lot_pick_v1(actor,'LOT-TEST-PARALLEL','GLOA-MATCHA-30G',jsonb_build_object(finished,1));

  insert into public.inventory_items(name,sku,category_id,unit)
    values('Synthetic 500 g','GLOA-MATCHA-B2B-500G',category,'Stueck') returning id into b2b_item;
  receipt_op:=gen_random_uuid();
  perform public.admin_record_inventory_movement(actor,receipt_op,raw,500,'receipt','goods_receipt',
    p_supplier=>'Synthetic Supplier',p_batch_number=>'LOT-B2B',p_best_before_date=>today+20);
  select id into strict b2b_raw from public.inventory_movements where operation_id=receipt_op;
  perform public.admin_pack_traced_matcha_v1(actor,b2b_op,'GLOA-MATCHA-B2B-500G',1,jsonb_build_object(b2b_raw,500));
  select receipt_id into strict b2b_lot from public.matcha_lots where lot_code=b2b_op::text and lot_kind='packed';
  insert into public.checkout_attempts(id,request_id,expected_total_gross_cents,items_snapshot)
    values(b2b_attempt,gen_random_uuid(),5618,'[]');
  insert into public.b2b_supply_agreements(id,user_id,status,business_snapshot,customer_snapshot,shipping_address_snapshot,
    billing_address_snapshot,plan_type,pricing_rules_version,checkout_attempt_id,pack_grams,pack_net_cents,
    quantity_packs,discount_percent,base_monthly_product_net_cents,billing_interval_unit,billing_interval_count,
    delivery_interval_unit,delivery_interval_count,started_at,stripe_subscription_id,pricing_snapshot)
  values(agreement,customer,'active','{}','{}','{}','{}','monthly','b2b-2026.1',b2b_attempt,500,5250,
    1,0,5250,'month',1,'month',1,now(),'sub_synthetic_lot',
    '{"rulesVersion":"b2b-2026.1","currency":"EUR","packs":1,"kilograms":0.5,"packNetCents":5250,"calculationVersion":"de-net-2026.1","priceOrigin":"net","monthlyProductNetCents":5250}');
  insert into public.b2b_supply_items(supply_agreement_id,item_role,sku,product_name,grams,quantity,base_unit_price_net_cents)
    values(agreement,'canonical_matcha','GLOA-MATCHA-B2B-500G','Synthetic 500 g',500,1,5250);
  insert into public.b2b_deliveries(id,supply_agreement_id,delivery_number,scheduled_for,quantity_packs,
    delivery_address_snapshot,berlin_eligibility_snapshot,shipping_class,shipping_snapshot,resolved_at,stripe_invoice_id)
  values(delivery,agreement,1,now()-interval '1 day',1,
    '{"name":null,"company":"Synthetic","line1":"Testweg 1","line2":null,"city":"Berlin","postalCode":"10115","state":null,"country":"DE"}',
    berlin,'berlin_local',
    '{"rulesVersion":"dhl-de-2026.1","berlinEligibilityVersion":"berlin-2026.1","packs":1,"mode":"berlin_local","chargeStatus":"free_local_delivery","carrierRetailGrossCents":0}'::jsonb
      ||jsonb_build_object('berlin',berlin),now(),'in_synthetic_lot');
  insert into public.financial_events(occurred_on,occurred_on_basis,kind,direction,b2b_agreement_id,external_reference,gross_cents,channel,operation_id)
    values(today,'event_date','b2b_settlement','inflow',agreement,'in_synthetic_lot',5618,'b2b',gen_random_uuid());
  if public.admin_matcha_b2b_delivery_v1(actor,delivery,'reserve')<>'reserved' then raise exception 'B2B hold not created'; end if;
  perform public.admin_set_matcha_lot_pick_v1(actor,delivery::text,'GLOA-MATCHA-B2B-500G',jsonb_build_object(b2b_lot,1));
  if public.admin_matcha_b2b_delivery_v1(actor,delivery,'dispatch')<>'dispatched'
    then raise exception 'B2B dispatch failed'; end if;
  if public.admin_matcha_b2b_delivery_v1(actor,delivery,'dispatch')<>'already_dispatched'
    then raise exception 'B2B dispatch replay failed'; end if;
  if (select current_quantity from public.inventory_items where id=b2b_item)<>0
    then raise exception 'B2B dispatch quantity wrong'; end if;
  trace:=public.admin_read_matcha_lot_v1(actor,'LOT-B2B');
  if trace->'shipments'->0->>'delivery_id' is distinct from delivery::text
    or trace->'shipments'->0->>'customer_id' is distinct from customer::text then
    raise exception 'B2B recall missing';
  end if;
end $$;
\if :{?concurrent}
do $$
declare actor uuid; raw_late uuid; variant uuid;
begin
  select user_id into strict actor from public.admin_users where is_active and role='owner' limit 1;
  select receipt_id into strict raw_late from public.matcha_lots where lot_code='LOT-LATE';
  select id into strict variant from public.product_variants where sku='GLOA-MATCHA-30G';
  perform public.admin_pack_traced_matcha_v1(actor,gen_random_uuid(),'GLOA-MATCHA-30G',1,jsonb_build_object(raw_late,30));
  insert into public.checkout_attempts(id,request_id,expected_total_gross_cents,items_snapshot)
  select id,gen_random_uuid(),1000,jsonb_build_array(jsonb_build_object('variantId',variant,'sku','GLOA-MATCHA-30G','quantity',1))
  from (values ('00000000-0000-4000-8000-000000000011'::uuid),('00000000-0000-4000-8000-000000000012'::uuid)) v(id);
end $$;
commit;
\else
rollback;
\endif
