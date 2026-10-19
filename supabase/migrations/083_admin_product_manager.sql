-- Product Manager V1. Apply only after reviewed 083 preflight. No provider calls.
begin;
alter table public.products
  add column product_type text not null default 'ACCESSORY' check (product_type in ('MATCHA','MERCH','ACCESSORY','BUNDLE')),
  add column stripe_product_id text check (stripe_product_id is null or stripe_product_id ~ '^prod_[A-Za-z0-9]+$'),
  add column archived_at timestamptz,
  add column stripe_sync_status text not null default 'pending' check (stripe_sync_status in ('pending','synced','error')),
  add column stripe_sync_revision integer not null default 1 check (stripe_sync_revision >= 0),
  add column stripe_sync_error text check (length(stripe_sync_error) <= 500);
alter table public.product_variants
  add column tax_category text check (tax_category in ('matcha_reduced_de','general_goods_de')),
  add column stripe_price_id text check (stripe_price_id is null or stripe_price_id ~ '^price_[A-Za-z0-9]+$'),
  add column availability text not null default 'available' check (availability in ('available','sold_out')),
  add column inventory_item_id uuid references public.inventory_items(id);
-- Revision zero is a finite identity-scoped compatibility bridge, never assigned by a writer.
update public.products set product_type='MATCHA',stripe_sync_revision=0 where slug='matcha';
update public.products set stripe_sync_revision=0 where slug='metal-case';
update public.product_variants v set tax_category='matcha_reduced_de'
from public.products p where p.id=v.product_id and p.slug='matcha'
and v.sku in ('GLOA-MATCHA-30G','GLOA-MATCHA-50G','GLOA-MATCHA-100G');
update public.product_variants v set tax_category='general_goods_de'
from public.products p where p.id=v.product_id and p.slug='metal-case' and v.sku='GLOA-CASE-01';
create unique index products_stripe_product_id_key on public.products(stripe_product_id) where stripe_product_id is not null;
create unique index product_variants_stripe_price_id_key on public.product_variants(stripe_price_id) where stripe_price_id is not null;
create index product_variants_inventory_item_idx on public.product_variants(inventory_item_id) where inventory_item_id is not null;
-- Frozen additional payment bindings, NULL for all historical attempts. Never rewrite items/tax.
alter table public.checkout_attempts add column stripe_line_bindings jsonb;

alter table public.admin_activity_log drop constraint admin_activity_log_module_check;
alter table public.admin_activity_log add constraint admin_activity_log_module_check check
 (module in ('orders','inventory','b2b','finance','documents','fulfillment','customer_rights','creator','products'));
revoke insert,update,delete,truncate,references,trigger on public.products,public.product_variants from public,anon,authenticated,service_role;
grant select on public.products,public.product_variants to service_role;

drop policy "Public read active products" on public.products;
create policy "Public read active products" on public.products for select to anon,authenticated using
 (is_active and archived_at is null and
 ((stripe_sync_status='synced' and stripe_product_id is not null)
 or (stripe_sync_revision=0 and slug in ('matcha','metal-case'))));
drop policy "Public read active priced variants of active products" on public.product_variants;
create policy "Public read active priced variants of active products" on public.product_variants for select to anon,authenticated using
 (is_active and price_gross_cents>0 and currency='EUR'
 and tax_category in ('matcha_reduced_de','general_goods_de')
 and exists(select 1 from public.products p where p.id=product_id and p.is_active and p.archived_at is null
 and ((p.stripe_sync_status='synced' and p.stripe_product_id is not null and stripe_price_id is not null)
 or (p.stripe_sync_revision=0 and p.slug='matcha' and sku in ('GLOA-MATCHA-30G','GLOA-MATCHA-50G','GLOA-MATCHA-100G')))));

create function public.admin_save_product_v1(p_actor uuid,p_operation uuid,p_product_id uuid,p_expected_revision integer,p_document jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare p public.products; v public.product_variants; j jsonb; old_doc jsonb;
  fingerprint text:=pg_catalog.md5(p_document::text); prior jsonb; v_action text;
begin
 if not exists(select 1 from public.admin_users where user_id=p_actor and is_active and role in ('owner','admin')) then raise exception 'Not authorized' using errcode='42501'; end if;
 if p_operation is null or p_product_id is null then raise exception 'IDs required'; end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_product_id::text,83));
 select metadata into prior from public.admin_activity_log where module='products' and operation_id=p_operation and actor_user_id=p_actor and action in ('product.created','product.updated');
 if found then
  if prior->>'request_hash' is distinct from fingerprint or prior->>'product_id' is distinct from p_product_id::text then raise exception 'Operation conflict'; end if;
  return pg_catalog.jsonb_build_object('id',p_product_id,'revision',(prior->>'revision')::integer,'replayed',true);
 end if;
 select * into p from public.products where id=p_product_id for update;
 if found then
  if p.archived_at is not null or p.stripe_sync_revision<>p_expected_revision then raise exception 'Stale revision or archived' using errcode='PT409'; end if;
  old_doc:=pg_catalog.to_jsonb(p);
 else
  if p_expected_revision<>0 then raise exception 'Stale revision' using errcode='PT409'; end if;
 end if;
 if p_document->>'name' is null or length(btrim(p_document->>'name')) not between 1 and 120
 or coalesce(p_document->>'slug','') !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or length(p_document->>'slug')>64
 or coalesce(p_document->>'product_type','') not in ('MATCHA','MERCH','ACCESSORY','BUNDLE')
 or length(coalesce(p_document->>'short_description',''))>500 or length(coalesce(p_document->>'description',''))>10000
 or coalesce(p_document->>'primary_image_path','') !~ '^(|/img/[A-Za-z0-9_./-]+\.(webp|png|jpg|jpeg|avif|gif)|https://[^[:space:]]+)$'
 or coalesce(p_document->>'primary_image_path','') like '%..%'
 or length(coalesce(p_document->>'primary_image_path',''))>2048
 or pg_catalog.jsonb_typeof(p_document->'variants') is distinct from 'array'
 or pg_catalog.jsonb_array_length(p_document->'variants') not between 1 and 100 then raise exception 'Invalid product'; end if;
 if p.slug in ('matcha','metal-case') and (p_document->>'slug'<>p.slug or p_document->>'product_type'<>p.product_type) then raise exception 'Protected catalogue identity'; end if;
 if exists(select 1 from public.product_variants x where x.product_id=p_product_id and not exists
 (select 1 from pg_catalog.jsonb_array_elements(p_document->'variants') e where e->>'id'=x.id::text)) then raise exception 'Persisted variants must be retained; deactivate instead'; end if;
 if old_doc is null then
  insert into public.products(id,slug,name) values(p_product_id,p_document->>'slug',btrim(p_document->>'name'));
 end if;
 update public.products set slug=p_document->>'slug',name=btrim(p_document->>'name'),product_type=p_document->>'product_type',
 short_description=nullif(p_document->>'short_description',''),description=nullif(p_document->>'description',''),
 primary_image_path=nullif(p_document->>'primary_image_path',''),sort_order=coalesce((p_document->>'sort_order')::integer,0),
 is_active=false,stripe_sync_status='pending',stripe_sync_error=null,stripe_sync_revision=p_expected_revision+1
 where id=p_product_id returning * into p;
 for j in select value from pg_catalog.jsonb_array_elements(p_document->'variants') loop
  if coalesce(j->>'sku','') !~ '^[A-Z0-9][A-Z0-9_-]{0,59}$' or length(btrim(coalesce(j->>'label',''))) not between 1 and 120
  or coalesce(j->>'currency','EUR')<>'EUR' or coalesce((j->>'price_gross_cents')::integer,0) not between 1 and 100000000
  or (j->>'size_grams' is not null and (j->>'size_grams')::integer<=0)
  or coalesce(j->>'tax_category','') not in ('matcha_reduced_de','general_goods_de')
  or coalesce(j->>'availability','') not in ('available','sold_out') then raise exception 'Invalid variant'; end if;
  select * into v from public.product_variants where id=(j->>'id')::uuid;
  if found and (v.product_id<>p_product_id or v.sku<>j->>'sku') then raise exception 'Variant identity is immutable'; end if;
  if v.sku in ('GLOA-MATCHA-30G','GLOA-MATCHA-50G','GLOA-MATCHA-100G') and
   ((j->>'size_grams')::integer is distinct from v.size_grams or j->>'tax_category'<>'matcha_reduced_de') then raise exception 'Protected Matcha configuration'; end if;
  if v.id is not null and v.price_gross_cents is distinct from (j->>'price_gross_cents')::integer then
   perform public.record_admin_activity(p_actor,'products','product.price_changed','variant',v.id::text,'Produktpreis geändert',
    pg_catalog.md5(p_operation::text||v.id::text)::uuid,pg_catalog.jsonb_build_object('revision',p.stripe_sync_revision,'old_gross_cents',v.price_gross_cents,'new_gross_cents',(j->>'price_gross_cents')::integer));
  end if;
  if v.id is not null and v.availability is distinct from j->>'availability' then
   perform public.record_admin_activity(p_actor,'products','product.availability_changed','variant',v.id::text,'Verfügbarkeit geändert',
    pg_catalog.md5(p_operation::text||v.id::text)::uuid,pg_catalog.jsonb_build_object('revision',p.stripe_sync_revision,'old',v.availability,'new',j->>'availability'));
  end if;
  perform public.record_admin_activity(p_actor,'products','product.updated','variant',j->>'id','Variante gespeichert',
   pg_catalog.md5(p_operation::text||(j->>'id'))::uuid,
   pg_catalog.jsonb_build_object('revision',p.stripe_sync_revision,
    'old',case when v.id is null then null else pg_catalog.jsonb_build_object('gross',v.price_gross_cents,'tax',v.tax_category,'grams',v.size_grams,'active',v.is_active,'availability',v.availability,'inventory',v.inventory_item_id) end,
    'new',pg_catalog.jsonb_build_object('gross',j->'price_gross_cents','tax',j->'tax_category','grams',j->'size_grams','active',j->'is_active','availability',j->'availability','inventory',j->'inventory_item_id')));
  insert into public.product_variants(id,product_id,sku,label,size_grams,price_gross_cents,currency,is_active,sort_order,tax_category,availability,inventory_item_id)
  values((j->>'id')::uuid,p.id,j->>'sku',btrim(j->>'label'),(j->>'size_grams')::integer,(j->>'price_gross_cents')::integer,'EUR',
  coalesce((j->>'is_active')::boolean,true),coalesce((j->>'sort_order')::integer,0),j->>'tax_category',j->>'availability',(j->>'inventory_item_id')::uuid)
  on conflict(id) do update set label=excluded.label,size_grams=excluded.size_grams,price_gross_cents=excluded.price_gross_cents,
  is_active=excluded.is_active,sort_order=excluded.sort_order,tax_category=excluded.tax_category,availability=excluded.availability,inventory_item_id=excluded.inventory_item_id;
 end loop;
 -- Missing/duplicate ids are rejected before committing any changes.
 if (select count(distinct e->>'id') from pg_catalog.jsonb_array_elements(p_document->'variants') e)<>pg_catalog.jsonb_array_length(p_document->'variants') then raise exception 'Duplicate variants'; end if;
 v_action:=case when old_doc is null then 'product.created' else 'product.updated' end;
 perform public.record_admin_activity(p_actor,'products',v_action,'product',p.id::text,v_action,p_operation,
 pg_catalog.jsonb_build_object('request_hash',fingerprint,'product_id',p.id,'revision',p.stripe_sync_revision,
 'changed_fields',(select pg_catalog.jsonb_agg(k order by k) from pg_catalog.jsonb_object_keys(p_document) k where k='variants' or old_doc is null or p_document->k is distinct from old_doc->k),
 'previous_revision',p_expected_revision));
 return pg_catalog.jsonb_build_object('id',p.id,'revision',p.stripe_sync_revision);
end $$;

create function public.admin_product_sync_result_v1(p_actor uuid,p_operation uuid,p_product_id uuid,p_expected_revision integer,p_stripe_product_id text,p_prices jsonb,p_error text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare p public.products; j jsonb;
begin
 if not exists(select 1 from public.admin_users where user_id=p_actor and is_active and role in ('owner','admin')) then raise exception 'Not authorized' using errcode='42501'; end if;
 select * into p from public.products where id=p_product_id for update;
 if not found or p.archived_at is not null or p.stripe_sync_revision<>p_expected_revision then raise exception 'Stale revision' using errcode='PT409'; end if;
 -- Success cannot be downgraded by a late failed concurrent sync.
 if p.stripe_sync_status='synced' then return pg_catalog.jsonb_build_object('id',p.id,'revision',p.stripe_sync_revision,'replayed',true); end if;
 if p_error is null then
  if p_stripe_product_id is null or p_stripe_product_id !~ '^prod_[A-Za-z0-9]+$' or pg_catalog.jsonb_typeof(p_prices) is distinct from 'array' then raise exception 'Invalid sync binding'; end if;
  if exists(select 1 from public.product_variants v where v.product_id=p.id and v.is_active and not exists
   (select 1 from pg_catalog.jsonb_array_elements(p_prices) e where e->>'variant_id'=v.id::text and (e->>'amount')::integer=v.price_gross_cents and e->>'price_id' ~ '^price_[A-Za-z0-9]+$')) then raise exception 'Incomplete sync'; end if;
  for j in select value from pg_catalog.jsonb_array_elements(p_prices) loop
   update public.product_variants set stripe_price_id=j->>'price_id' where id=(j->>'variant_id')::uuid and product_id=p.id and price_gross_cents=(j->>'amount')::integer;
   if not found then raise exception 'Foreign or stale variant'; end if;
  end loop;
 end if;
 update public.products set stripe_product_id=case when p_error is null then p_stripe_product_id else stripe_product_id end,
 stripe_sync_status=case when p_error is null then 'synced' else 'error' end,stripe_sync_error=left(p_error,500),
 stripe_sync_revision=case when p_error is null and stripe_sync_revision=0 then 1 else stripe_sync_revision end
 where id=p.id returning * into p;
 perform public.record_admin_activity(p_actor,'products','product.sync_result','product',p.id::text,'Stripe-Abgleich',p_operation,
 pg_catalog.jsonb_build_object('revision',p.stripe_sync_revision,'status',p.stripe_sync_status));
 return pg_catalog.jsonb_build_object('id',p.id,'revision',p.stripe_sync_revision,'status',p.stripe_sync_status);
end $$;

create function public.admin_product_state_v1(p_actor uuid,p_operation uuid,p_product_id uuid,p_expected_revision integer,p_action text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare p public.products;
begin
 if not exists(select 1 from public.admin_users where user_id=p_actor and is_active and role in ('owner','admin')) then raise exception 'Not authorized' using errcode='42501'; end if;
 select * into p from public.products where id=p_product_id for update;
 if not found then raise exception 'Missing product'; end if;
 if exists(select 1 from public.admin_activity_log where actor_user_id=p_actor and operation_id=p_operation and module='products' and action='product.'||p_action and entity_id=p.id::text) then return pg_catalog.jsonb_build_object('id',p.id,'replayed',true); end if;
 if p.stripe_sync_revision<>p_expected_revision or p.archived_at is not null then raise exception 'Stale revision or archived' using errcode='PT409'; end if;
 if p_action='published' then
  if p.slug='metal-case' or p.stripe_sync_status<>'synced' or p.stripe_product_id is null
  or not exists(select 1 from public.product_variants where product_id=p.id and is_active)
  or exists(select 1 from public.product_variants where product_id=p.id and is_active and
   (price_gross_cents is null or price_gross_cents<=0 or currency<>'EUR' or tax_category is null or stripe_price_id is null)) then raise exception 'Product not ready to publish'; end if;
  update public.products set is_active=true where id=p.id;
 elsif p_action='archived' then
  update public.products set is_active=false,archived_at=pg_catalog.now(),stripe_sync_revision=stripe_sync_revision+1 where id=p.id;
 else raise exception 'Invalid action'; end if;
 perform public.record_admin_activity(p_actor,'products','product.'||p_action,'product',p.id::text,'Produktstatus geändert',p_operation,
 pg_catalog.jsonb_build_object('revision',p.stripe_sync_revision));
 return pg_catalog.jsonb_build_object('id',p.id,'action',p_action);
end $$;

create function public.bind_product_checkout_prices_v1(p_attempt uuid,p_bindings jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.checkout_attempts; b jsonb; item jsonb;
begin
 select * into a from public.checkout_attempts where id=p_attempt for update;
 if not found then raise exception 'Missing attempt'; end if;
 if a.stripe_line_bindings is not null then
  if a.stripe_line_bindings<>p_bindings then raise exception 'Frozen binding conflict'; end if;
  return a.stripe_line_bindings;
 end if;
 if a.status<>'created' or pg_catalog.jsonb_typeof(p_bindings) is distinct from 'array' or pg_catalog.jsonb_array_length(p_bindings)=0 then raise exception 'Invalid binding state'; end if;
 for b in select value from pg_catalog.jsonb_array_elements(p_bindings) loop
  if b->>'sourceIndex' is null or (b->>'sourceIndex')::integer<0 or (b->>'sourceIndex')::integer>=pg_catalog.jsonb_array_length(a.items_snapshot)
   or b->>'quantity' is null or b->>'unitGrossCents' is null then raise exception 'Invalid binding shape'; end if;
  item:=a.items_snapshot->((b->>'sourceIndex')::integer);
  if item is null or item->>'variantId' is distinct from b->>'variantId' or item->>'stripeProductId' is distinct from b->>'productId'
   or coalesce(b->>'priceId','') !~ '^price_[A-Za-z0-9]+$' or (b->>'quantity')::integer<=0 or (b->>'unitGrossCents')::integer<0 then raise exception 'Invalid frozen binding'; end if;
 end loop;
 if exists(select 1 from pg_catalog.jsonb_array_elements(a.items_snapshot) with ordinality s(item,n)
  where s.item->>'stripeProductId' is not null and
  ((select coalesce(sum((e->>'quantity')::integer),0) from pg_catalog.jsonb_array_elements(p_bindings) e where (e->>'sourceIndex')::integer=s.n-1)<>(s.item->>'quantity')::integer
  or (select coalesce(sum((e->>'quantity')::bigint*(e->>'unitGrossCents')::bigint),0) from pg_catalog.jsonb_array_elements(p_bindings) e where (e->>'sourceIndex')::integer=s.n-1)
  <> (s.item->>'lineGrossCents')::bigint-coalesce((select (d->>'discountGrossCents')::bigint from pg_catalog.jsonb_array_elements(a.discount_line_allocation) d where d->>'variantId'=s.item->>'variantId'),0))) then raise exception 'Binding quantities or cents mismatch'; end if;
 update public.checkout_attempts set stripe_line_bindings=p_bindings where id=a.id;
 return p_bindings;
end $$;

revoke all on function public.admin_save_product_v1(uuid,uuid,uuid,integer,jsonb),
 public.admin_product_sync_result_v1(uuid,uuid,uuid,integer,text,jsonb,text),
 public.admin_product_state_v1(uuid,uuid,uuid,integer,text),public.bind_product_checkout_prices_v1(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.admin_save_product_v1(uuid,uuid,uuid,integer,jsonb),
 public.admin_product_sync_result_v1(uuid,uuid,uuid,integer,text,jsonb,text),
 public.admin_product_state_v1(uuid,uuid,uuid,integer,text),public.bind_product_checkout_prices_v1(uuid,jsonb) to service_role;
commit;
