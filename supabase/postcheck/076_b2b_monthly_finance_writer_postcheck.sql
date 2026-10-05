-- READ ONLY: catalog queries only; safe inside BEGIN READ ONLY.
with hardening as (-- READ ONLY: catalogs and effective privileges; no data or ACL changes.
-- 006/048 establish SELECT-only; 059/060 preserve parent grants, leaving inherited residue.
with baseline as (-- READ ONLY. No application data or credentials are needed.
with writers as (
 select p.*,pg_catalog.pg_get_functiondef(p.oid) definition from pg_catalog.pg_proc p
 join pg_catalog.pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
 and p.proname in ('admin_save_ugc_business_expense','admin_mutate_creator')
), roles as (
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
      or pg_catalog.has_table_privilege(r.name,t.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,REFERENCES,TRIGGER')
      or pg_catalog.has_any_column_privilege(r.name,t.oid,'INSERT,UPDATE,REFERENCES')) else false end,'Protected tables remain server-owned'
  union all select 10,'072 read-only Finance and history ACL',case when (select ok from roles) then
    not exists(select 1 from tables t where tier='history' and (t.oid is null
      or not pg_catalog.has_table_privilege('service_role',t.oid,'SELECT')
      or pg_catalog.has_table_privilege('service_role',t.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,REFERENCES,TRIGGER')
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
  union all select 14,'Exact 074 RPC signatures',(select count(*) from writers)=2
    and pg_catalog.to_regprocedure('public.admin_save_ugc_business_expense(uuid,uuid,uuid,date,text,integer,text,text,text,integer,uuid,text,text,uuid)') is not null
    and pg_catalog.to_regprocedure('public.admin_mutate_creator(uuid,text,uuid,jsonb,text[],uuid)') is not null, 'No overloads or missing writers'
  union all select 15,'Definer and safe search_path',(select count(*) from writers)=2 and not exists(select 1 from writers where not prosecdef
    or not coalesce('search_path=""'=any(proconfig),false) or provolatile<>'v'), 'Both volatile transactional writers use empty search_path'
  union all select 16,'074 RPC service_role-only execution',case when (select ok from roles) then (select count(*) from writers)=2
    and not exists(select 1 from writers p where not pg_catalog.has_function_privilege('service_role',p.oid,'EXECUTE')
      or exists(select 1 from pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
        where a.privilege_type='EXECUTE' and a.grantee not in (p.proowner,(select oid from pg_catalog.pg_roles where rolname='service_role')))) else false end, 'PUBLIC/anon/authenticated cannot execute'
  union all select 17,'Actor authorization and replay guards',(select count(*) from writers)=2 and not exists(select 1 from writers
    where definition not like '%public.admin_users%' or definition not like '%role in (''owner'',''admin'')%'
      or definition not like '%pg_advisory_xact_lock%' or definition not like '%operation_id=v_operation%'), 'Fresh active owner/admin checked inside each RPC; transaction locks serialize replay'
  union all select 18,'Mutation and audit rollback',(select count(*) from writers)=2 and not exists(select 1 from writers
    where definition not like '%public.record_admin_activity(%' or definition ~* 'exception[[:space:]]+when'), 'No swallowed error or standalone audit; full statement rolls back'
  union all select 19,'Narrow expense and Creator writes',(select count(*) from writers)=2 and not exists(select 1 from writers
    where definition ~* '(insert into|update|delete from) public\.(financial_events|creator_commissions|order_attributions|creator_payouts|inventory_[a-z_]+)'
      or definition ~* 'execute[[:space:]]')
    and exists(select 1 from writers where proname='admin_save_ugc_business_expense'
      and definition like '%public.admin_record_business_expense(%' and definition like '%public.admin_update_business_expense(%'
      and definition like '%set ugc_assignment_id=p_ugc_assignment_id%'), 'Reuses 071 money authority; historical Finance/commissions/inventory excluded'
  union all select 20,'Expected parameters and return types',exists(select 1 from writers where proname='admin_mutate_creator'
    and proargnames=array['p_actor_user_id','p_action','p_creator_id','p_profile','p_roles','p_operation_id']::text[]
    and prorettype=pg_catalog.to_regtype('jsonb')) and exists(select 1 from writers where proname='admin_save_ugc_business_expense'
    and proargnames=array['p_actor_user_id','p_expense_id','p_ugc_assignment_id','p_occurred_on','p_category','p_gross_cents','p_description','p_channel','p_payment_status','p_vat_cents','p_order_id','p_vendor','p_note','p_operation_id']::text[]
    and prorettype=pg_catalog.to_regtype('public.business_expenses')), 'Existing expense input only; no earned commission/order amount authority'
  union all select 21,'Existing manual Inventory permission posture',case when (select ok from roles) then
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
  select * from results union all select 100,'SUMMARY',case when count(*) filter(where verdict='FAIL')=0 then 'APPLIED CLEANLY' else 'DO NOT APPLY' end,
    count(*) filter(where verdict='FAIL')||' FAIL / '||count(*) filter(where verdict='PASS')||' PASS / '||count(*) filter(where verdict='INFO')||' INFO' from results
)
select name,verdict,detail from final order by ord), expected_writers(name,signature,args,digest) as (values
 ('activate_b2b_annual_from_payment','public.activate_b2b_annual_from_payment(uuid,uuid,text)',array['p_agreement_id','p_checkout_attempt_id','p_stripe_payment_intent_id'],'5fef590ed57fb25f9146014e3a3fd5f9'),
 ('record_b2b_settlement_event','public.record_b2b_settlement_event(uuid,uuid)',array['p_schedule_id','p_operation_id'],'2d4f426ba60a13565afea82d95024284'),
 ('settle_b2b_annual_paid_instalment','public.settle_b2b_annual_paid_instalment(uuid,text,text)',array['p_agreement_id','p_stripe_invoice_id','p_stripe_payment_intent_id'],'70c3bf54716c94e271424c952b470a19'),
 ('settle_b2b_monthly_paid_invoice','public.settle_b2b_monthly_paid_invoice(uuid,text,text)',array['p_agreement_id','p_stripe_subscription_id','p_stripe_invoice_id'],'aab1bfc7bdb28073a740459a85c466cc')), parent as (
 select * from pg_catalog.pg_class where oid=pg_catalog.to_regclass('public.b2b_supply_agreements')
), checks(name,ok,detail) as (
 select '074 protected baseline',not exists(select 1 from baseline where verdict='FAIL'),'Retains Finance/history/Inventory/Creator/Affiliate checks'
 union all select 'Existing agreement table and policy',exists(select 1 from parent where relkind='r' and relrowsecurity and not relforcerowsecurity)
 and (select count(*) from pg_catalog.pg_policy where polrelid=pg_catalog.to_regclass('public.b2b_supply_agreements'))=1
 and exists(select 1 from pg_catalog.pg_policy where polrelid=pg_catalog.to_regclass('public.b2b_supply_agreements')
 and polname='Business users read own supply agreements' and polcmd='r' and polpermissive
 and polroles=array[0::oid] and polwithcheck is null
 and pg_catalog.replace(pg_catalog.pg_get_expr(polqual,polrelid),'public.','')='((auth.uid() = user_id) AND is_business_user())'),'Exact original 006 owner-business SELECT policy and RLS posture'
 union all select 'Intended SELECT posture',exists(select 1 from parent where
 not pg_catalog.has_table_privilege('anon',oid,'SELECT')
 and pg_catalog.has_table_privilege('authenticated',oid,'SELECT')
 and pg_catalog.has_table_privilege('service_role',oid,'SELECT'))
 and not exists(select 1 from parent c cross join lateral pg_catalog.aclexplode(coalesce(c.relacl,pg_catalog.acldefault('r',c.relowner))) a where a.grantee=0 and a.privilege_type='SELECT'),'Anon/PUBLIC denied, authenticated and service_role SELECT preserved'
 union all select 'Existing trusted B2B identity',not exists(select 1 from expected_writers e where not exists(
 select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.proname=e.name and p.oid=pg_catalog.to_regprocedure(e.signature)
 and p.proargnames=e.args and p.prorettype='jsonb'::pg_catalog.regtype and not p.proretset
 and p.pronargdefaults=case when e.name='record_b2b_settlement_event' then 1 else 0 end
 and (p.pronargdefaults=0 or pg_catalog.pg_get_expr(p.proargdefaults,0)='NULL::uuid')
 and p.prolang=(select oid from pg_catalog.pg_language where lanname='plpgsql')
 and p.provolatile='v' and not p.proisstrict and p.proparallel='u' and not p.proleakproof
 and pg_catalog.md5(pg_catalog.replace(p.prosrc,pg_catalog.chr(13),''))=e.digest
 and p.prosecdef and p.proconfig=array['search_path=""']::text[]
 and (select count(*) from pg_catalog.pg_proc q where q.pronamespace=p.pronamespace and q.proname=p.proname)=1
 and pg_catalog.has_function_privilege('service_role',p.oid,'EXECUTE')
 and not exists(select 1 from pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
 where a.privilege_type='EXECUTE' and a.grantee not in(p.proowner,(select oid from pg_catalog.pg_roles where rolname='service_role'))))),'Reviewed normalized bodies, exact signatures/return/language/security and restrictive EXECUTE'
 union all select 'No unintended direct authority',not exists(select 1 from parent c cross join (values('anon'),('authenticated'),('service_role')) r(name)
 where pg_catalog.has_table_privilege(r.name,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,REFERENCES,TRIGGER')
 or pg_catalog.has_any_column_privilege(r.name,c.oid,'INSERT,UPDATE,REFERENCES'))
 and not exists(select 1 from parent c cross join lateral pg_catalog.aclexplode(coalesce(c.relacl,pg_catalog.acldefault('r',c.relowner))) a where a.grantee=0 and a.privilege_type in('INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER')),'No direct or column writes; TRUNCATE/REFERENCES/TRIGGER denied'
 
), results as (
 select name,case when ok is true then 'PASS' else 'FAIL' end verdict,detail from checks
 union all select 'Scope','INFO','075 revokes only six unintended parent privileges from PUBLIC/anon/authenticated/service_role. No SELECT grants, policies, RPCs or data change.'
 union all select 'Snapshot proof','INFO','Read-only catalog check cannot prove historical data/ACL equality. Local rollout compares complete data, policy, function and unrelated-ACL snapshots.'
), final as (
 select * from results union all select 'SUMMARY',case when count(*) filter(where verdict='FAIL')=0 then 'APPLIED CLEANLY' else 'DO NOT APPLY' end,
 count(*) filter(where verdict='FAIL')||' FAIL / '||count(*) filter(where verdict='PASS')||' PASS / '||count(*) filter(where verdict='INFO')||' INFO' from results
) select * from final order by case when name='SUMMARY' then 1 else 0 end,name), baseline as (-- READ ONLY. No application data or credentials are needed.
with writers as (
 select p.*,pg_catalog.pg_get_functiondef(p.oid) definition from pg_catalog.pg_proc p
 join pg_catalog.pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
 and p.proname in ('admin_save_ugc_business_expense','admin_mutate_creator')
), roles as (
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
      or pg_catalog.has_table_privilege(r.name,t.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,REFERENCES,TRIGGER')
      or pg_catalog.has_any_column_privilege(r.name,t.oid,'INSERT,UPDATE,REFERENCES')) else false end,'Protected tables remain server-owned'
  union all select 10,'072 read-only Finance and history ACL',case when (select ok from roles) then
    not exists(select 1 from tables t where tier='history' and (t.oid is null
      or not pg_catalog.has_table_privilege('service_role',t.oid,'SELECT')
      or pg_catalog.has_table_privilege('service_role',t.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,REFERENCES,TRIGGER')
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
  union all select 14,'Exact 074 RPC signatures',(select count(*) from writers)=2
    and pg_catalog.to_regprocedure('public.admin_save_ugc_business_expense(uuid,uuid,uuid,date,text,integer,text,text,text,integer,uuid,text,text,uuid)') is not null
    and pg_catalog.to_regprocedure('public.admin_mutate_creator(uuid,text,uuid,jsonb,text[],uuid)') is not null, 'No overloads or missing writers'
  union all select 15,'Definer and safe search_path',(select count(*) from writers)=2 and not exists(select 1 from writers where not prosecdef
    or not coalesce('search_path=""'=any(proconfig),false) or provolatile<>'v'), 'Both volatile transactional writers use empty search_path'
  union all select 16,'074 RPC service_role-only execution',case when (select ok from roles) then (select count(*) from writers)=2
    and not exists(select 1 from writers p where not pg_catalog.has_function_privilege('service_role',p.oid,'EXECUTE')
      or exists(select 1 from pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
        where a.privilege_type='EXECUTE' and a.grantee not in (p.proowner,(select oid from pg_catalog.pg_roles where rolname='service_role')))) else false end, 'PUBLIC/anon/authenticated cannot execute'
  union all select 17,'Actor authorization and replay guards',(select count(*) from writers)=2 and not exists(select 1 from writers
    where definition not like '%public.admin_users%' or definition not like '%role in (''owner'',''admin'')%'
      or definition not like '%pg_advisory_xact_lock%' or definition not like '%operation_id=v_operation%'), 'Fresh active owner/admin checked inside each RPC; transaction locks serialize replay'
  union all select 18,'Mutation and audit rollback',(select count(*) from writers)=2 and not exists(select 1 from writers
    where definition not like '%public.record_admin_activity(%' or definition ~* 'exception[[:space:]]+when'), 'No swallowed error or standalone audit; full statement rolls back'
  union all select 19,'Narrow expense and Creator writes',(select count(*) from writers)=2 and not exists(select 1 from writers
    where definition ~* '(insert into|update|delete from) public\.(financial_events|creator_commissions|order_attributions|creator_payouts|inventory_[a-z_]+)'
      or definition ~* 'execute[[:space:]]')
    and exists(select 1 from writers where proname='admin_save_ugc_business_expense'
      and definition like '%public.admin_record_business_expense(%' and definition like '%public.admin_update_business_expense(%'
      and definition like '%set ugc_assignment_id=p_ugc_assignment_id%'), 'Reuses 071 money authority; historical Finance/commissions/inventory excluded'
  union all select 20,'Expected parameters and return types',exists(select 1 from writers where proname='admin_mutate_creator'
    and proargnames=array['p_actor_user_id','p_action','p_creator_id','p_profile','p_roles','p_operation_id']::text[]
    and prorettype=pg_catalog.to_regtype('jsonb')) and exists(select 1 from writers where proname='admin_save_ugc_business_expense'
    and proargnames=array['p_actor_user_id','p_expense_id','p_ugc_assignment_id','p_occurred_on','p_category','p_gross_cents','p_description','p_channel','p_payment_status','p_vat_cents','p_order_id','p_vendor','p_note','p_operation_id']::text[]
    and prorettype=pg_catalog.to_regtype('public.business_expenses')), 'Existing expense input only; no earned commission/order amount authority'
  union all select 21,'Existing manual Inventory permission posture',case when (select ok from roles) then
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
  select * from results union all select 100,'SUMMARY',case when count(*) filter(where verdict='FAIL')=0 then 'APPLIED CLEANLY' else 'DO NOT APPLY' end,
    count(*) filter(where verdict='FAIL')||' FAIL / '||count(*) filter(where verdict='PASS')||' PASS / '||count(*) filter(where verdict='INFO')||' INFO' from results
)
select name,verdict,detail from final order by ord), expected_columns(tbl,col,typ) as (values ('b2b_supply_agreements','id','uuid'),
('b2b_supply_agreements','plan_type','text'),
('b2b_supply_agreements','pack_net_cents','integer'),
('b2b_supply_agreements','pricing_snapshot','jsonb'),
('b2b_supply_agreements','pricing_rules_version','text'),
('b2b_supply_agreements','currency','text'),
('b2b_supply_agreements','status','text'),
('b2b_supply_agreements','started_at','timestamp with time zone'),
('b2b_supply_agreements','stripe_subscription_id','text'),
('b2b_deliveries','id','uuid'),
('b2b_deliveries','supply_agreement_id','uuid'),
('b2b_deliveries','quantity_packs','integer'),
('b2b_deliveries','stripe_invoice_id','text'),
('b2b_deliveries','created_at','timestamp with time zone'),
('financial_events','id','uuid'),
('financial_events','gross_cents','integer'),
('financial_events','net_cents','integer'),
('financial_events','tax_cents','integer'),
('financial_events','operation_id','uuid'),
('financial_events','external_reference','text'),
('financial_events','b2b_agreement_id','uuid'),
('financial_events','occurred_on','date'),
('financial_events','occurred_on_basis','text'),
('financial_events','currency','text'),
('financial_events','channel','text'),
('financial_events','kind','text'),
('financial_events','direction','text'),
('financial_events','note','text')), expected_writers(name,signature,args,digest) as (values
 ('activate_b2b_annual_from_payment','public.activate_b2b_annual_from_payment(uuid,uuid,text)',array['p_agreement_id','p_checkout_attempt_id','p_stripe_payment_intent_id'],'5fef590ed57fb25f9146014e3a3fd5f9'),
 ('record_b2b_settlement_event','public.record_b2b_settlement_event(uuid,uuid)',array['p_schedule_id','p_operation_id'],'2d4f426ba60a13565afea82d95024284'),
 ('settle_b2b_annual_paid_instalment','public.settle_b2b_annual_paid_instalment(uuid,text,text)',array['p_agreement_id','p_stripe_invoice_id','p_stripe_payment_intent_id'],'70c3bf54716c94e271424c952b470a19'),
 ('settle_b2b_monthly_paid_invoice','public.settle_b2b_monthly_paid_invoice(uuid,text,text)',array['p_agreement_id','p_stripe_subscription_id','p_stripe_invoice_id'],'aab1bfc7bdb28073a740459a85c466cc')), writer as (
 select p.*,pg_catalog.pg_get_functiondef(p.oid) definition from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='record_b2b_monthly_invoice_event'
), checks(name,ok,detail) as (
 select '075 hardening prerequisite',not exists(select 1 from hardening where verdict='FAIL'),'Supply agreement safe SELECT-only posture, exact original policy and trusted writers required'
 union all select '074 baseline posture',not exists(select 1 from baseline where verdict='FAIL'),'All 074 dependencies, Finance/history, Creator and Inventory ACL/RLS checks retained'
 union all select 'Exact payment and Finance columns',not exists(select 1 from expected_columns e where not exists(select 1 from pg_catalog.pg_attribute a where a.attrelid=pg_catalog.to_regclass('public.'||e.tbl) and a.attname=e.col and not a.attisdropped and pg_catalog.format_type(a.atttypid,a.atttypmod)=e.typ)),'Identifier and server-owned monetary facts have expected types'
 union all select 'Existing B2B writers unchanged',not exists(select 1 from expected_writers e where not exists(
 select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.proname=e.name and p.oid=pg_catalog.to_regprocedure(e.signature)
 and p.proargnames=e.args and p.prorettype='jsonb'::pg_catalog.regtype and not p.proretset
 and p.pronargdefaults=case when e.name='record_b2b_settlement_event' then 1 else 0 end
 and (p.pronargdefaults=0 or pg_catalog.pg_get_expr(p.proargdefaults,0)='NULL::uuid')
 and p.prolang=(select oid from pg_catalog.pg_language where lanname='plpgsql')
 and p.provolatile='v' and not p.proisstrict and p.proparallel='u' and not p.proleakproof
 and pg_catalog.md5(pg_catalog.replace(p.prosrc,pg_catalog.chr(13),''))=e.digest
 and p.prosecdef and p.proconfig=array['search_path=""']::text[]
 and (select count(*) from pg_catalog.pg_proc q where q.pronamespace=p.pronamespace and q.proname=p.proname)=1
 and pg_catalog.has_function_privilege('service_role',p.oid,'EXECUTE')
 and not exists(select 1 from pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
 where a.privilege_type='EXECUTE' and a.grantee not in(p.proowner,(select oid from pg_catalog.pg_roles where rolname='service_role'))))),'Exact reviewed 062/063/072 normalized bodies, signatures and safe execution posture'
 union all select 'Invoice and operation uniqueness',exists(select 1 from pg_catalog.pg_index i where i.indexrelid=pg_catalog.to_regclass('public.b2b_deliveries_stripe_invoice_id_key') and i.indisunique and i.indisvalid and pg_catalog.pg_get_indexdef(i.indexrelid)='CREATE UNIQUE INDEX b2b_deliveries_stripe_invoice_id_key ON public.b2b_deliveries USING btree (stripe_invoice_id) WHERE (stripe_invoice_id IS NOT NULL)') and exists(select 1 from pg_catalog.pg_constraint c where c.conrelid=pg_catalog.to_regclass('public.financial_events') and c.contype='u' and pg_catalog.pg_get_constraintdef(c.oid)='UNIQUE (operation_id)'),'Global invoice settlement key plus existing append-only event operation uniqueness'
 union all select 'Monthly B2B table authority',not exists(select 1 from (values('b2b_supply_agreements'),('b2b_deliveries'),('b2b_payment_schedule')) t(name) cross join (values('anon'),('authenticated'),('service_role')) r(name) where pg_catalog.to_regclass('public.'||t.name) is null or pg_catalog.has_table_privilege(r.name,'public.'||t.name,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') or pg_catalog.has_any_column_privilege(r.name,'public.'||t.name,'INSERT,UPDATE,REFERENCES')),'All commerce writes remain through trusted RPCs'
 union all select 'Monthly integrity rule',exists(select 1 from pg_catalog.pg_proc p where p.oid=pg_catalog.to_regprocedure('public.assert_b2b_commerce_integrity(uuid)') and pg_catalog.pg_get_functiondef(p.oid) like '%monthly%' and pg_catalog.pg_get_functiondef(p.oid) like '%payment_schedule%'),'Monthly settlement function and integrity assertion preserve no-schedule model'
 union all select 'Existing monetary and event constraints',not exists(select 1 from (values('financial_events_subject_check'),('financial_events_direction_check'),('financial_events_component_bounds_check'),('financial_events_date_basis_check')) e(name) where not exists(select 1 from pg_catalog.pg_constraint c where c.conrelid=pg_catalog.to_regclass('public.financial_events') and c.conname=e.name and c.convalidated)),'Existing ledger subject, direction, component and date checks retained'
 union all select 'Migration authority',pg_catalog.has_schema_privilege(current_user,'public','CREATE') and pg_catalog.has_language_privilege(current_user,'plpgsql','USAGE'),'Trusted function creation authority'
union all select 'Exact 076 signature and definer', (select count(*)=1 from writer) and exists(select 1 from writer where oid=pg_catalog.to_regprocedure('public.record_b2b_monthly_invoice_event(uuid,text)') and prosecdef and proconfig=array['search_path=""']::text[]
 and prolang=(select oid from pg_catalog.pg_language where lanname='plpgsql') and not proretset
 and provolatile='v' and not proisstrict and proparallel='u' and not proleakproof and pronargdefaults=0
 and prorettype='jsonb'::pg_catalog.regtype and proargnames=array['p_agreement_id','p_stripe_invoice_id']::text[] and pg_catalog.md5(pg_catalog.replace(prosrc,pg_catalog.chr(13),''))='0dd755790a913513f68c0c28ebc7c1f8'),'Exact reviewed function body and identifiers only; no caller amounts or event type'
union all select 'Service-role-only EXECUTE',exists(select 1 from writer where pg_catalog.has_function_privilege('service_role',oid,'EXECUTE') and not exists(select 1 from pg_catalog.aclexplode(coalesce(proacl,pg_catalog.acldefault('f',proowner))) a where a.privilege_type='EXECUTE' and a.grantee not in (proowner,(select oid from pg_catalog.pg_roles where rolname='service_role')))),'PUBLIC, anon, authenticated and other roles denied'
union all select 'Authoritative sources and invoice locking',exists(select 1 from writer where definition like '%public.b2b_supply_agreements%' and definition like '%public.b2b_deliveries%' and definition like '%v_delivery.quantity_packs%' and definition like '%v_agreement.pack_net_cents%' and definition like '%pg_catalog.pg_advisory_xact_lock%' and definition like '%existing_event_conflict%' and definition not like '%insert into public.b2b_payment_schedule%'),'Historical quantity, immutable price, settled invoice and global invoice lock'
), results as (select name,case when ok is true then 'PASS' else 'FAIL' end verdict,detail from checks union all select 'Scope','INFO','076 adds only one RPC. No business data, tables, indices, policies or existing grants change.' union all select 'Snapshot proof','INFO','Local runner compares every existing schema object and business table before/after; a standalone read cannot prove historical equality.'), final as (select * from results union all select 'SUMMARY',case when count(*) filter(where verdict='FAIL')=0 then 'APPLIED CLEANLY' else 'DO NOT APPLY' end,count(*) filter(where verdict='FAIL')||' FAIL / '||count(*) filter(where verdict='PASS')||' PASS / '||count(*) filter(where verdict='INFO')||' INFO' from results) select * from final order by case when name='SUMMARY' then 1 else 0 end,name;
