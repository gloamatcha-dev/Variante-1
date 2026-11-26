begin;

alter table public.orders add column manual_b2b jsonb;
create unique index orders_manual_b2b_reference
  on public.orders ((manual_b2b->>'customer'), lower(manual_b2b->>'reference'))
  where manual_b2b is not null;

-- This intake workflow has no settlement, invoicing or dispatch authority.
alter table public.orders add constraint orders_manual_b2b_unreleased check (
  manual_b2b is null or (
    user_id is null and customer_type='business' and checkout_attempt_id is null
    and stripe_checkout_session_id is null and stripe_payment_intent_id is null
    and payment_status='pending' and fulfillment_status='unfulfilled'
    and status in ('pending','confirmed','cancelled')
  )
);

create function public.admin_manual_b2b_order_v1(actor uuid, target uuid, action text, payload jsonb)
returns uuid language plpgsql security definer set search_path='' as $$
declare
  existing public.orders;
  customer public.business_profiles;
  line record;
  lines jsonb := '[]'::jsonb;
  net integer := 0;
  gross integer := 0;
  shipping_net integer := 0;
  shipping_gross integer := 0;
  metadata jsonb;
begin
  if not exists(select 1 from public.admin_users where user_id=actor and is_active and role='owner') then
    raise exception 'manual_b2b_forbidden' using errcode='42501';
  end if;
  perform public.require_creator_b2b_release_writes_v1();
  if target is null or action is null or action not in ('create','confirm','cancel') then
    raise exception 'manual_b2b_invalid';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('manual-b2b:'||target::text,0));
  select * into existing from public.orders where id=target for update;
  if action<>'create' then
    if existing.manual_b2b is null then raise exception 'manual_b2b_unknown_order'; end if;
    if (action='confirm' and existing.status='confirmed') or (action='cancel' and existing.status='cancelled') then return target; end if;
    if existing.status not in ('pending','confirmed') then raise exception 'manual_b2b_invalid_state'; end if;
    update public.orders set status=case when action='confirm' then 'confirmed' else 'cancelled' end,
      cancelled_at=case when action='cancel' then now() else null end
      where id=target;
    perform public.record_admin_activity(actor,'orders','manual_b2b_'||action,'order',target::text,
      'Manual B2B order status changed',gen_random_uuid(),jsonb_build_object('previous_status',existing.status));
    return target;
  end if;
  if existing.id is not null then
    if existing.manual_b2b->'request'=payload then return target; end if;
    raise exception 'manual_b2b_conflict';
  end if;
  select * into strict customer from public.business_profiles where user_id=(payload->>'customer')::uuid;
  if nullif(btrim(customer.company_name),'') is null
    or coalesce(payload->>'source','') not in ('email','phone','in_person','other')
    or coalesce(payload->>'payment','') not in ('bank','cash')
    or coalesce(payload->>'delivery','') not in ('personal','pickup','carrier')
    or length(coalesce(btrim(payload->>'reference'),'')) not between 1 and 120
    or coalesce(payload->'billing'->>'country','')<>'DE'
    or coalesce(payload->'shipping'->>'country','')<>'DE'
    or coalesce(jsonb_array_length(payload->'lines'),0) not between 1 and 20
    or (payload->>'orderedOn')::date is null or (payload->>'orderedOn')::date>current_date
    then raise exception 'manual_b2b_invalid'; end if;
  for line in
    select l.*, v.sku, v.label, v.price_gross_cents, v.tax_category, p.name
    from jsonb_to_recordset(payload->'lines') l(variant uuid, quantity int, unit int, rate int, unit_net int, line_net int)
    left join public.product_variants v on v.id=l.variant and v.is_active
    left join public.products p on p.id=v.product_id and p.is_active
  loop
    if line.name is null or line.quantity is null or line.quantity not between 1 and 10000
      or line.unit is null or line.unit not between 1 and 1000000 or line.unit_net is null or line.line_net is null
      or line.unit_net not between 0 and line.unit or line.line_net not between 0 and line.unit::bigint*line.quantity
      or line.rate is null or line.tax_category is null
      or line.rate is distinct from (case line.tax_category when 'matcha_reduced_de' then 7 when 'general_goods_de' then 19 end)
      then raise exception 'manual_b2b_unknown_product_or_tax'; end if;
    net := net + line.line_net;
    gross := gross + line.unit*line.quantity;
    lines := lines||jsonb_build_object('sku',line.sku,'label',line.label,'name',line.name,'variant',line.variant,
       'quantity',line.quantity,'unit',line.unit,'unit_net',line.unit_net,'line_net',line.line_net,'rate',line.rate,'category',line.tax_category,
       'catalog_gross',line.price_gross_cents);
  end loop;
  shipping_net := (payload->>'shippingNet')::integer;
  shipping_gross := (payload->>'shippingGross')::integer;
  if shipping_net is null or shipping_gross is null or shipping_net not between 0 and shipping_gross
    or shipping_gross not between 0 and 1000000 or gross<=0 then raise exception 'manual_b2b_invalid'; end if;
  metadata := jsonb_build_object('customer',customer.user_id,'reference',btrim(payload->>'reference'),
    'source',payload->>'source','payment',payload->>'payment','delivery',payload->>'delivery','request',payload);
  insert into public.orders(id,customer_type,customer_snapshot,shipping_address_snapshot,billing_address_snapshot,
    subtotal_net_cents,subtotal_gross_cents,discount_total_cents,shipping_net_cents,shipping_gross_cents,
    tax_total_cents,total_net_cents,total_gross_cents,tax_treatment,tax_vat_country,tax_calculation_version,
    shipping_tax_allocation,manual_b2b)
  values(target,'business',jsonb_build_object('company',customer.company_name,'vatId',customer.vat_id,
      'contact',payload->>'contact','email',payload->>'email'),payload->'shipping',payload->'billing',
    net,gross,0,shipping_net,shipping_gross,gross+shipping_gross-net-shipping_net,
    net+shipping_net,gross+shipping_gross,'de_domestic','DE',payload->>'taxVersion',payload->'shippingTax',metadata);
  insert into public.order_items(order_id,product_reference,sku,product_name,variant_name,quantity,unit_price_net_cents,
    unit_price_gross_cents,tax_rate_percent,line_total_net_cents,line_total_gross_cents,line_total_tax_cents,tax_category,metadata)
  select target,l.variant::text,l.sku,l.name,l.label,l.quantity,l.unit_net,l.unit,l.rate,l.line_net,l.unit*l.quantity,l.unit*l.quantity-l.line_net,l.category,
    jsonb_build_object('catalogGrossCents',l.catalog_gross)
  from jsonb_to_recordset(lines) l(variant uuid,sku text,name text,label text,quantity int,unit_net int,unit int,
    rate int,line_net int,category text,catalog_gross int);
  perform public.record_admin_activity(actor,'orders','manual_b2b_created','order',target::text,
    'Manual B2B draft captured',gen_random_uuid(),jsonb_build_object('gross_cents',gross+shipping_gross,'positions',jsonb_array_length(lines)));
  return target;
end;
$$;
revoke all on function public.admin_manual_b2b_order_v1(uuid,uuid,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.admin_manual_b2b_order_v1(uuid,uuid,text,jsonb) to service_role;
commit;
