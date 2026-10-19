-- READ ONLY. Historical row and protected function fingerprints are compared
-- before/after by the permanent disposable database runner, not guessed here.
with writers(signature) as(values
 ('public.admin_save_product_v1(uuid,uuid,uuid,integer,jsonb)'),
 ('public.admin_product_sync_result_v1(uuid,uuid,uuid,integer,text,jsonb,text)'),
 ('public.admin_product_state_v1(uuid,uuid,uuid,integer,text)'),
 ('public.bind_product_checkout_prices_v1(uuid,jsonb)')
), checks(name,ok) as (
 select 'Exact eleven column types, nullability and rollout defaults',not exists(select 1 from (values
 ('products','product_type','text','NO'),('products','stripe_product_id','text','YES'),('products','archived_at','timestamptz','YES'),
 ('products','stripe_sync_status','text','NO'),('products','stripe_sync_revision','int4','NO'),('products','stripe_sync_error','text','YES'),
 ('product_variants','tax_category','text','YES'),('product_variants','stripe_price_id','text','YES'),('product_variants','availability','text','NO'),
 ('product_variants','inventory_item_id','uuid','YES'),('checkout_attempts','stripe_line_bindings','jsonb','YES')) w(t,c,typ,nullable)
 left join information_schema.columns x on x.table_schema='public' and x.table_name=w.t and x.column_name=w.c
 where x.udt_name is distinct from w.typ or x.is_nullable is distinct from w.nullable)
 and not exists(select 1 from (values('products','product_type',$d$'ACCESSORY'::text$d$),('products','stripe_sync_status',$d$'pending'::text$d$),('products','stripe_sync_revision','1'),('product_variants','availability',$d$'available'::text$d$)) w(t,c,def)
 left join information_schema.columns x on x.table_schema='public' and x.table_name=w.t and x.column_name=w.c where x.column_default is distinct from w.def)
 union all select 'All four writers locked to service role',not exists(select 1 from writers w left join pg_proc p on p.oid=to_regprocedure(w.signature)
 where p.oid is null or not p.prosecdef or not coalesce('search_path=""'=any(p.proconfig),false)
 or not has_function_privilege('service_role',p.oid,'EXECUTE') or has_function_privilege('anon',p.oid,'EXECUTE') or has_function_privilege('authenticated',p.oid,'EXECUTE')
 or exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee=0 and privilege_type='EXECUTE'))
 union all select 'No direct table or column catalogue mutations',not exists(select 1 from (values('products'),('product_variants')) t(n) cross join (values('anon'),('authenticated'),('service_role')) r(n) where has_table_privilege(r.n,'public.'||t.n,'INSERT,UPDATE,DELETE,TRUNCATE') or has_any_column_privilege(r.n,'public.'||t.n,'INSERT,UPDATE'))
 union all select 'Inventory FK preserves referenced items',exists(select 1 from pg_constraint where conrelid='public.product_variants'::regclass and confrelid='public.inventory_items'::regclass and contype='f' and confdeltype='a' and pg_get_constraintdef(oid) like 'FOREIGN KEY (inventory_item_id)%')
 union all select 'Exact Stripe unique mappings and Inventory lookup index',not exists(select 1 from (values
 ('products_stripe_product_id_key','products','stripe_product_id',true),
 ('product_variants_stripe_price_id_key','product_variants','stripe_price_id',true),
 ('product_variants_inventory_item_idx','product_variants','inventory_item_id',false)) w(idx,t,col,uniq)
 left join pg_class c on c.oid=to_regclass('public.'||w.idx) left join pg_index i on i.indexrelid=c.oid
 where i.indrelid is distinct from to_regclass('public.'||w.t) or i.indisunique is distinct from w.uniq or not coalesce(i.indisvalid,false)
 or pg_get_indexdef(i.indexrelid,1,true) is distinct from w.col or i.indnkeyatts<>1 or pg_get_expr(i.indpred,i.indrelid) is distinct from '('||w.col||' IS NOT NULL)')
 union all select 'Approved product types and sync constraints',exists(select 1 from pg_constraint where conrelid='public.products'::regclass and pg_get_constraintdef(oid) like '%MATCHA%MERCH%ACCESSORY%BUNDLE%') and exists(select 1 from pg_constraint where conrelid='public.products'::regclass and pg_get_constraintdef(oid) like '%pending%synced%error%')
 union all select 'Approved tax and availability constraints',exists(select 1 from pg_constraint where conrelid='public.product_variants'::regclass and pg_get_constraintdef(oid) like '%matcha_reduced_de%general_goods_de%') and exists(select 1 from pg_constraint where conrelid='public.product_variants'::regclass and pg_get_constraintdef(oid) like '%available%sold_out%')
 union all select 'Products activity module',exists(select 1 from pg_constraint where conrelid='public.admin_activity_log'::regclass and conname='admin_activity_log_module_check' and pg_get_constraintdef(oid) like '%products%')
 union all select 'Catalogue RLS remains enabled',(select count(*)=2 and bool_and(relrowsecurity) from pg_class where oid in ('public.products'::regclass,'public.product_variants'::regclass))
 union all select 'Staged published-only catalogue policies',(select count(*)=2 from pg_policies where schemaname='public' and tablename in ('products','product_variants') and cmd='SELECT' and qual like '%archived_at%' and qual like '%stripe_sync%')
 union all select 'Exact Matcha tax identities preserved',(select count(*)=3 and bool_and(v.tax_category='matcha_reduced_de' and p.product_type='MATCHA') from public.product_variants v join public.products p on p.id=v.product_id where p.slug='matcha' and v.sku in ('GLOA-MATCHA-30G','GLOA-MATCHA-50G','GLOA-MATCHA-100G'))
 union all select 'No catalogue triggers on Inventory',(select count(*)=0 from pg_trigger t join pg_proc p on p.oid=t.tgfoid where t.tgrelid in ('public.inventory_items'::regclass,'public.inventory_movements'::regclass) and p.proname like '%product%')
), results as(select name,coalesce(ok,false) ok from checks)
select case when ok then 'PASS ' else 'FAIL ' end||name from results
union all select count(*) filter(where not ok)||' FAIL / '||count(*) filter(where ok)||' PASS — '||case when bool_and(ok) then 'APPLIED CLEANLY' else 'REVIEW REQUIRED' end from results;
