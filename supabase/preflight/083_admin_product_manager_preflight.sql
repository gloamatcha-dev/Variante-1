-- READ ONLY. File SHA256 and historical before/after proof are performed by
-- tests/runtime/product-manager-db-local.mjs; SQL cannot read repository bytes.
with checks(name,ok) as (
 select 'No partial 083 columns or writers',not exists(select 1 from information_schema.columns where table_schema='public' and
 ((table_name='products' and column_name in ('product_type','stripe_product_id','archived_at','stripe_sync_status','stripe_sync_revision','stripe_sync_error'))
 or (table_name='product_variants' and column_name in ('tax_category','stripe_price_id','availability','inventory_item_id'))
 or (table_name='checkout_attempts' and column_name='stripe_line_bindings')))
 and not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in
 ('admin_save_product_v1','admin_product_sync_result_v1','admin_product_state_v1','bind_product_checkout_prices_v1'))
 and not exists(select 1 from pg_constraint where conrelid='public.admin_activity_log'::regclass and conname='admin_activity_log_module_check' and pg_get_constraintdef(oid) like '%products%')
 union all select 'Exact original product columns',(select array_agg(column_name::text order by ordinal_position)=array['id','slug','name','short_description','description','primary_image_path','is_active','sort_order','created_at','updated_at'] from information_schema.columns where table_schema='public' and table_name='products')
 union all select 'Exact original variant columns',(select array_agg(column_name::text order by ordinal_position)=array['id','product_id','sku','label','size_grams','price_gross_cents','currency','is_active','sort_order','created_at','updated_at'] from information_schema.columns where table_schema='public' and table_name='product_variants')
 union all select 'Known Matcha identities and weights',(select count(*)=3 and bool_and(v.size_grams=case v.sku when 'GLOA-MATCHA-30G' then 30 when 'GLOA-MATCHA-50G' then 50 when 'GLOA-MATCHA-100G' then 100 end) from public.product_variants v join public.products p on p.id=v.product_id where p.slug='matcha' and v.sku in ('GLOA-MATCHA-30G','GLOA-MATCHA-50G','GLOA-MATCHA-100G'))
 union all select 'No unknown active catalogue identities',not exists(select 1 from public.products where is_active and slug not in ('matcha','metal-case'))
 union all select 'Inventory, activity and 082 dependencies',to_regclass('public.inventory_items') is not null and to_regclass('public.inventory_movements') is not null and to_regclass('public.admin_activity_log') is not null and to_regprocedure('public.read_cost_finance_basis_v1(date,date)') is not null
 union all select 'Catalogue RLS enabled',(select count(*)=2 and bool_and(relrowsecurity) from pg_class where oid in ('public.products'::regclass,'public.product_variants'::regclass))
 union all select 'Expected catalogue read policies',(select count(*)=2 from pg_policies where schemaname='public' and (tablename,policyname) in (('products','Public read active products'),('product_variants','Public read active priced variants of active products')) and cmd='SELECT')
 union all select 'No browser catalogue write policies',not exists(select 1 from pg_policies where schemaname='public' and tablename in ('products','product_variants') and cmd<>'SELECT')
 union all select 'Order tax and discount snapshots installed',exists(select 1 from information_schema.columns where table_schema='public' and table_name='order_items' and column_name='tax_category') and exists(select 1 from information_schema.columns where table_schema='public' and table_name='order_items' and column_name='discount_gross_cents')
 union all select 'Service role and admin actor infrastructure',exists(select 1 from pg_roles where rolname='service_role') and to_regprocedure('public.record_admin_activity(uuid,text,text,text,text,text,uuid,jsonb)') is not null
 union all select 'Applying role owns catalogue and can create writers',has_schema_privilege(current_user,'public','CREATE') and (exists(select 1 from pg_roles where rolname=current_user and rolsuper) or (select pg_has_role(current_user,relowner,'USAGE') from pg_class where oid='public.products'::regclass))
), results as(select name,coalesce(ok,false) ok from checks)
select case when ok then 'PASS ' else 'FAIL ' end||name from results
union all select count(*) filter(where not ok)||' FAIL / '||count(*) filter(where ok)||' PASS — '||case when bool_and(ok) then 'SAFE TO APPLY' else 'DO NOT APPLY' end from results;
