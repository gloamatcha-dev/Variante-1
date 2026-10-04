-- READ ONLY. No application data or credentials are needed.
with roles as (
  select count(*)=3 as ok from pg_catalog.pg_roles where rolname in ('anon','authenticated','service_role')
), protected(name,tier) as (values
  ('creators','catalogue'),('creator_roles','catalogue'),('ugc_assignments','catalogue'),
  ('creator_commission_rules','catalogue'),('affiliate_links','catalogue'),('affiliate_codes','catalogue'),
  ('business_expenses','history'),('admin_activity_log','history'),('financial_events','history'),
  ('creator_commissions','history'),('order_attributions','history'),('creator_payouts','catalogue'),
  ('inventory_items','inventory'),('inventory_movements','inventory'),('inventory_categories','inventory'),('inventory_item_areas','inventory')
), tables as (
  select name,tier,pg_catalog.to_regclass('public.'||name) as oid from protected
), dependencies(signature) as (values
  ('public.record_admin_activity(uuid,text,text,text,text,text,uuid,jsonb)'),
  ('public.admin_record_business_expense(uuid,date,text,integer,text,text,text,integer,uuid,text,text,uuid)'),
  ('public.admin_update_business_expense(uuid,uuid,date,text,integer,text,text,text,integer,uuid,text,text,uuid)'),
  ('public.admin_save_affiliate_configuration(uuid,text,text,uuid,text,boolean,timestamptz,timestamptz,uuid,integer,integer,text,text,uuid,text)')
), columns(tbl,col,typ) as (values
  ('creators','id','uuid'),('creators','display_name','text'),('creators','email','text'),
  ('creators','instagram','text'),('creators','tiktok','text'),('creators','portfolio_url','text'),
  ('creators','country','text'),('creators','status','text'),('creators','notes','text'),
  ('creators','created_by','uuid'),('creators','updated_at','timestamp with time zone'),
  ('creator_roles','creator_id','uuid'),('creator_roles','role','text'),('ugc_assignments','id','uuid'),
  ('ugc_assignments','creator_id','uuid'),('business_expenses','ugc_assignment_id','uuid'),
  ('business_expenses','creator_commission_id','uuid'),('business_expenses','gross_cents','integer'),
  ('business_expenses','vat_cents','integer'),('business_expenses','occurred_on','date'),
  ('business_expenses','order_id','uuid'),('business_expenses','description','text'),
  ('business_expenses','category','text'),('business_expenses','channel','text'),
  ('business_expenses','payment_status','text'),('business_expenses','vendor','text'),('business_expenses','note','text'),
  ('admin_activity_log','actor_user_id','uuid'),('admin_activity_log','module','text'),
  ('admin_activity_log','action','text'),('admin_activity_log','entity_id','text'),
  ('admin_activity_log','operation_id','uuid'),('admin_activity_log','metadata','jsonb'),
  ('admin_users','user_id','uuid'),('admin_users','is_active','boolean'),('admin_users','role','text')
), checks(ord,name,ok,detail) as (
  select 1,'Required roles',(select ok from roles),'anon/authenticated/service_role exist'
  union all select 2,'073 dependencies and security',not exists(select 1 from dependencies d
    where not exists(select 1 from pg_catalog.pg_proc p where p.oid=pg_catalog.to_regprocedure(d.signature)
      and p.prosecdef and 'search_path=""'=any(p.proconfig))), 'Exact existing RPC signatures and safe definer configuration'
  union all select 3,'Required tables',not exists(select 1 from tables where oid is null),'Existing schema only'
  union all select 4,'Required columns and types',not exists(select 1 from columns e where not exists(
    select 1 from pg_catalog.pg_attribute a where a.attrelid=pg_catalog.to_regclass('public.'||e.tbl)
      and a.attname=e.col and not a.attisdropped and pg_catalog.format_type(a.atttypid,a.atttypmod)=e.typ)), 'Includes UGC association and actor/operation fields'
  union all select 5,'UGC FK and single source constraint',exists(select 1 from pg_catalog.pg_constraint k
    where k.conrelid=pg_catalog.to_regclass('public.business_expenses') and k.conname='business_expenses_ugc_assignment_id_fkey'
      and k.contype='f' and k.convalidated and k.confrelid=pg_catalog.to_regclass('public.ugc_assignments'))
    and exists(select 1 from pg_catalog.pg_constraint k where k.conrelid=pg_catalog.to_regclass('public.business_expenses')
      and k.conname='business_expenses_creator_source_check' and k.convalidated
      and pg_catalog.pg_get_constraintdef(k.oid) like '%creator_commission_id IS NULL%ugc_assignment_id IS NULL%'), 'Original FK and at-most-one creator source'
  union all select 6,'Unique obligation and email indexes',not exists(select 1 from (values
    ('idx_business_expenses_one_per_ugc','CREATE UNIQUE INDEX idx_business_expenses_one_per_ugc ON public.business_expenses USING btree (ugc_assignment_id) WHERE (ugc_assignment_id IS NOT NULL)'),
    ('idx_business_expenses_one_per_commission','CREATE UNIQUE INDEX idx_business_expenses_one_per_commission ON public.business_expenses USING btree (creator_commission_id) WHERE (creator_commission_id IS NOT NULL)'),
    ('idx_creators_email','CREATE UNIQUE INDEX idx_creators_email ON public.creators USING btree (lower(btrim(email)))')) e(name,definition)
    where not exists(select 1 from pg_catalog.pg_index i where i.indexrelid=pg_catalog.to_regclass('public.'||e.name)
      and i.indisunique and i.indisvalid and i.indisready and pg_catalog.pg_get_indexdef(i.indexrelid)=e.definition)), 'Exact existing uniqueness remains authoritative'
  union all select 7,'Audit uniqueness and vocabulary',exists(select 1 from pg_catalog.pg_constraint k
    where k.conrelid=pg_catalog.to_regclass('public.admin_activity_log') and k.conname='admin_activity_log_event_key'
      and k.contype='u' and pg_catalog.pg_get_constraintdef(k.oid)='UNIQUE (module, action, operation_id)')
    and exists(select 1 from pg_catalog.pg_constraint k where k.conrelid=pg_catalog.to_regclass('public.admin_activity_log')
      and k.conname='admin_activity_log_module_check' and pg_catalog.pg_get_constraintdef(k.oid) like '%creator%' and pg_catalog.pg_get_constraintdef(k.oid) like '%finance%'), 'Existing creator/finance audit modules'
  union all select 8,'Creator roles and status constraints',exists(select 1 from pg_catalog.pg_constraint k
    where k.conrelid=pg_catalog.to_regclass('public.creator_roles') and k.contype='p'
      and pg_catalog.pg_get_constraintdef(k.oid)='PRIMARY KEY (creator_id, role)')
    and exists(select 1 from pg_catalog.pg_constraint k where k.conrelid=pg_catalog.to_regclass('public.creator_roles')
      and k.contype='c' and pg_catalog.pg_get_constraintdef(k.oid) like '%influencer%ugc_creator%affiliate%')
    and exists(select 1 from pg_catalog.pg_constraint k where k.conrelid=pg_catalog.to_regclass('public.creators')
      and k.contype='c' and pg_catalog.pg_get_constraintdef(k.oid) like '%prospect%active%paused%ended%rejected%'), 'Existing multi-role/status model'
  union all select 9,'Browser table and column writes denied',case when (select ok from roles) then
    not exists(select 1 from tables t cross join (values('anon'),('authenticated')) r(name) where t.oid is null
      or pg_catalog.has_table_privilege(r.name,t.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      or pg_catalog.has_any_column_privilege(r.name,t.oid,'INSERT,UPDATE,REFERENCES')) else false end,'Protected tables remain server-owned'
  union all select 10,'072 read-only Finance and history ACL',case when (select ok from roles) then
    not exists(select 1 from tables t where tier='history' and (t.oid is null
      or not pg_catalog.has_table_privilege('service_role',t.oid,'SELECT')
      or pg_catalog.has_table_privilege('service_role',t.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      or pg_catalog.has_any_column_privilege('service_role',t.oid,'INSERT,UPDATE,REFERENCES'))) else false end,'Includes business_expenses remediation'
  union all select 11,'Catalogue DELETE denied',case when (select ok from roles) then
    not exists(select 1 from tables t where tier='catalogue' and (t.oid is null
      or pg_catalog.has_table_privilege('service_role',t.oid,'DELETE,TRUNCATE,REFERENCES,TRIGGER'))) else false end,'No configuration/history deletion grant'
  union all select 12,'Existing RPC execution authority',case when (select ok from roles) then
    not exists(select 1 from dependencies d where not exists(select 1 from pg_catalog.pg_proc p
      where p.oid=pg_catalog.to_regprocedure(d.signature) and pg_catalog.has_function_privilege('service_role',p.oid,'EXECUTE')
        and not exists(select 1 from pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
          where a.privilege_type='EXECUTE' and a.grantee not in (p.proowner,(select oid from pg_catalog.pg_roles where rolname='service_role'))))) else false end,'Service-role-only, including 073'
  union all select 13,'Protected RLS',not exists(select 1 from tables t where not exists(select 1 from pg_catalog.pg_class c where c.oid=t.oid and c.relrowsecurity)
    or exists(select 1 from pg_catalog.pg_policy p where p.polrelid=t.oid)), 'Protected tables retain RLS without browser policies'
  union all select 14,'No existing/conflicting 074 RPC',not exists(select 1 from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in
      ('admin_save_ugc_business_expense','admin_mutate_creator')), 'Already installed or overload collision means DO NOT APPLY'
  union all select 15,'Migration authority',pg_catalog.has_schema_privilege(current_user,'public','CREATE')
    and exists(select 1 from pg_catalog.pg_language l where l.lanname='plpgsql' and pg_catalog.has_language_privilege(current_user,l.oid,'USAGE')), 'Run with the trusted migration authority'
  union all select 16,'Existing manual Inventory permission posture',case when (select ok from roles) then
    -- Migration 050 grants table DML selectively and UPDATE only on editable columns.
    -- Ancillary privileges inherited from deployment defaults are not invented here.
    not exists(select 1 from (values
      ('inventory_categories',true,false,array['name','is_active','updated_at']::text[]),
      ('inventory_items',true,false,array['name','sku','category_id','unit','low_stock_threshold','supplier','notes','is_active','updated_at']::text[]),
      ('inventory_movements',false,false,array[]::text[]),
      ('inventory_item_areas',true,true,array[]::text[])
    ) expected(name,can_insert,can_delete,editable)
    left join tables t on t.name=expected.name
    where t.oid is null
      or not pg_catalog.has_table_privilege('service_role',t.oid,'SELECT')
      or pg_catalog.has_table_privilege('service_role',t.oid,'INSERT') is distinct from expected.can_insert
      or pg_catalog.has_table_privilege('service_role',t.oid,'DELETE') is distinct from expected.can_delete
      or pg_catalog.has_table_privilege('service_role',t.oid,'UPDATE')
      or exists(select 1 from pg_catalog.pg_attribute a where a.attrelid=t.oid and a.attnum>0 and not a.attisdropped
        and (pg_catalog.has_column_privilege('service_role',t.oid,a.attnum,'UPDATE') is distinct from (a.attname::text=any(expected.editable))
          or pg_catalog.has_column_privilege('service_role',t.oid,a.attnum,'INSERT') is distinct from expected.can_insert))
      or exists(select 1 from unnest(expected.editable) column_name where not exists(
        select 1 from pg_catalog.pg_attribute a where a.attrelid=t.oid and a.attname::text=column_name and a.attnum>0 and not a.attisdropped))) else false end,
    'Migration 050 table DML and editable-column UPDATE matrix; current_quantity and movement writes denied. Browser writes checked separately; before/after snapshots prove unchanged ancillary ACL.'
), results as (
  select ord,name,case when ok is true then 'PASS' else 'FAIL' end verdict,detail from checks
  union all select 90,'Scope','INFO','074 adds only two SECURITY DEFINER RPCs; no business data or table/grant changes.'
  union all select 91,'Inventory/Finance baseline','INFO','Before/after catalog and data snapshots are required to prove historical immutability; the local DB runner captures them.'
), final as (
  select * from results union all select 100,'SUMMARY',case when count(*) filter(where verdict='FAIL')=0 then 'SAFE TO APPLY' else 'DO NOT APPLY' end,
    count(*) filter(where verdict='FAIL')||' FAIL / '||count(*) filter(where verdict='PASS')||' PASS / '||count(*) filter(where verdict='INFO')||' INFO' from results
)
select name,verdict,detail from final order by ord;
