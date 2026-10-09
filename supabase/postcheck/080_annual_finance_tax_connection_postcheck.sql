-- READ ONLY. 080 Annual-only; REFUND TOKEN FINGERPRINT V1, canonical single bodies.
-- Catalog guards do not prove historical row integrity without a before-snapshot; permanent DB tests do.
with checks(name,ok) as (
 select 'Protected legacy 072 payment and refund authorities unchanged',coalesce((not exists(select 1 from (values ('public.record_annual_prepayment_event(uuid,uuid)','29f753c043034dc90dd2014ed50f7a0a'),('public.record_order_payment_event(uuid,uuid)','ea73b6350fbac1ba948e73fd23505cb0'),('public.record_order_refund_event(uuid,integer,text,uuid)','c588167f517765aebaeae871d72b016d'),('public.record_annual_plan_refund_event(uuid,integer,text,uuid)','3539b6aec38bf67e4e1c44f44bf5e6e5'),('public.record_b2b_settlement_event(uuid,uuid)','01eba8a78d3e771e1669ee45400776b3')) wanted(signature,hash)
 left join pg_catalog.pg_proc p on p.oid=pg_catalog.to_regprocedure(wanted.signature)
 where p.oid is null or p.prosecdef is not true or not coalesce('search_path=""'=any(p.proconfig),false)
 or pg_catalog.format_type(p.prorettype,null)<>'jsonb' or (with recursive lex(pos,mode,depth,clean) as (
  select 1,'code'::text collate pg_catalog."C",0,''::text collate pg_catalog."C"
  union all
  select pos+case
    when mode='code' and pair in ('--','/*') then 2
    when mode='single' and pair=$q$''$q$ then 2
    when mode='double' and pair='""' then 2
    when mode='block' and pair in ('/*','*/') then 2 else 1 end,
   case
    when mode='code' and pair='--' then 'line'
    when mode='code' and pair='/*' then 'block'
    when mode='code' and c=$q$'$q$ then 'single'
    when mode='code' and c='"' then 'double'
    when mode='single' and c=$q$'$q$ and pair<>$q$''$q$ then 'code'
    when mode='double' and c='"' and pair<>'""' then 'code'
    when mode='line' and c in (pg_catalog.chr(10),pg_catalog.chr(13)) then 'code'
    when mode='block' and pair='*/' and depth=1 then 'code' else mode end,
   case when mode='code' and pair='/*' then 1
    when mode='block' and pair='/*' then depth+1
    when mode='block' and pair='*/' then depth-1 else depth end,
   clean||case
    when mode='code' and pair in ('--','/*') then ' '
    when mode in ('line','block') then ''
    when mode='single' and pair=$q$''$q$ then pair
    when mode='double' and pair='""' then pair else c end
  from lex cross join lateral (select pg_catalog.substr(p.prosrc,pos,1) c,pg_catalog.substr(p.prosrc,pos,2) pair) ch
  where pos<=pg_catalog.length(p.prosrc)
 ), cleaned as(select clean from lex where pos>pg_catalog.length(p.prosrc) and mode in ('code','line') and depth=0),
 tokens as(select m[1] token,ord from cleaned cross join lateral pg_catalog.regexp_matches(clean,
  $tokens$'(?:''|[^'])*'|"(?:""|[^"])*"|[A-Za-z_][A-Za-z_0-9$]*|[0-9]+(?:\.[0-9]+)?|->>|->|::|:=|<>|>=|<=|!=|\|\||\s+|.$tokens$,'g') with ordinality r(m,ord))
 select pg_catalog.md5(pg_catalog.string_agg(pg_catalog.octet_length(token)::text||':'||token,'' order by ord))
 from tokens where token !~ $space$^\s+$$space$) is distinct from wanted.hash
 or not pg_catalog.has_function_privilege('service_role',p.oid,'EXECUTE')
 or pg_catalog.has_function_privilege('anon',p.oid,'EXECUTE') or pg_catalog.has_function_privilege('authenticated',p.oid,'EXECUTE')
 or exists(select 1 from pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a where a.grantee=0 and a.privilege_type='EXECUTE'))),false)
 union all
 select '079 installed provider evidence dependencies unchanged',coalesce((not exists(select 1 from (values ('public.initialize_provider_fee_evidence_v1(uuid)','bed4f2a158f5b1a92ead5e6d48b10e9f'),('public.record_provider_fee_result_v1(uuid,text,text,text,text,integer,text,timestamp with time zone,text)','d279bb3bb597efb3e235aa9fb500263e'),('public.discover_provider_fee_evidence_v1(integer)','d1a8beaf6853e16e05b65c4ffcd3f9d1')) wanted(signature,hash)
 left join pg_catalog.pg_proc p on p.oid=pg_catalog.to_regprocedure(wanted.signature)
 where p.oid is null or p.prosecdef is not true or not coalesce('search_path=""'=any(p.proconfig),false)
 or pg_catalog.format_type(p.prorettype,null)<>'jsonb' or (with recursive lex(pos,mode,depth,clean) as (
  select 1,'code'::text collate pg_catalog."C",0,''::text collate pg_catalog."C"
  union all
  select pos+case
    when mode='code' and pair in ('--','/*') then 2
    when mode='single' and pair=$q$''$q$ then 2
    when mode='double' and pair='""' then 2
    when mode='block' and pair in ('/*','*/') then 2 else 1 end,
   case
    when mode='code' and pair='--' then 'line'
    when mode='code' and pair='/*' then 'block'
    when mode='code' and c=$q$'$q$ then 'single'
    when mode='code' and c='"' then 'double'
    when mode='single' and c=$q$'$q$ and pair<>$q$''$q$ then 'code'
    when mode='double' and c='"' and pair<>'""' then 'code'
    when mode='line' and c in (pg_catalog.chr(10),pg_catalog.chr(13)) then 'code'
    when mode='block' and pair='*/' and depth=1 then 'code' else mode end,
   case when mode='code' and pair='/*' then 1
    when mode='block' and pair='/*' then depth+1
    when mode='block' and pair='*/' then depth-1 else depth end,
   clean||case
    when mode='code' and pair in ('--','/*') then ' '
    when mode in ('line','block') then ''
    when mode='single' and pair=$q$''$q$ then pair
    when mode='double' and pair='""' then pair else c end
  from lex cross join lateral (select pg_catalog.substr(p.prosrc,pos,1) c,pg_catalog.substr(p.prosrc,pos,2) pair) ch
  where pos<=pg_catalog.length(p.prosrc)
 ), cleaned as(select clean from lex where pos>pg_catalog.length(p.prosrc) and mode in ('code','line') and depth=0),
 tokens as(select m[1] token,ord from cleaned cross join lateral pg_catalog.regexp_matches(clean,
  $tokens$'(?:''|[^'])*'|"(?:""|[^"])*"|[A-Za-z_][A-Za-z_0-9$]*|[0-9]+(?:\.[0-9]+)?|->>|->|::|:=|<>|>=|<=|!=|\|\||\s+|.$tokens$,'g') with ordinality r(m,ord))
 select pg_catalog.md5(pg_catalog.string_agg(pg_catalog.octet_length(token)::text||':'||token,'' order by ord))
 from tokens where token !~ $space$^\s+$$space$) is distinct from wanted.hash
 or not pg_catalog.has_function_privilege('service_role',p.oid,'EXECUTE')
 or pg_catalog.has_function_privilege('anon',p.oid,'EXECUTE') or pg_catalog.has_function_privilege('authenticated',p.oid,'EXECUTE')
 or exists(select 1 from pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a where a.grantee=0 and a.privilege_type='EXECUTE')) and pg_catalog.to_regclass('public.provider_fee_evidence') is not null),false)
 union all
 select 'Original Annual snapshot and Finance monetary columns',coalesce((not exists(select 1 from (values ('annual_plans','tax_snapshot','jsonb'),('annual_plans','currency','text'),('annual_plans','total_gross_cents','integer'),('annual_plans','merchandise_total_gross_cents','integer'),('annual_plans','shipping_total_gross_cents','integer'),('financial_events','gross_cents','integer'),('financial_events','net_cents','integer'),('financial_events','tax_cents','integer')) w(tab,col,typ)
 left join information_schema.columns c on c.table_schema='public' and c.table_name=w.tab and c.column_name=w.col where c.data_type is distinct from w.typ)
 and exists(select 1 from pg_catalog.pg_constraint where conrelid='public.annual_plans'::regclass and conname='annual_plans_annual_tax_total_check' and convalidated)
 and exists(select 1 from pg_catalog.pg_constraint where conrelid='public.annual_plans'::regclass and pg_catalog.pg_get_constraintdef(oid) like '%currency%EUR%')),false)
 union all
 select 'One Annual prepayment per plan uniqueness intact',coalesce((exists(select 1 from pg_catalog.pg_index where indexrelid=pg_catalog.to_regclass('public.idx_financial_events_one_prepayment_per_plan') and indisunique and indisvalid and pg_catalog.pg_get_indexdef(indexrelid)='CREATE UNIQUE INDEX idx_financial_events_one_prepayment_per_plan ON public.financial_events USING btree (annual_plan_id) WHERE (kind = ''annual_prepayment''::text)')),false)
 union all
 select 'Browser monetary and Annual mutation denied; RLS enabled',coalesce((not exists(select 1 from (values ('anon'),('authenticated')) roles(name) cross join (values ('public.financial_events'),('public.annual_plans')) tabs(name)
 where pg_catalog.has_table_privilege(roles.name,tabs.name,'INSERT,UPDATE,DELETE,TRUNCATE')
 or pg_catalog.has_any_column_privilege(roles.name,tabs.name,'INSERT,UPDATE'))
 and not exists(select 1 from pg_catalog.pg_class where oid in ('public.financial_events'::regclass,'public.annual_plans'::regclass) and not relrowsecurity)),false)
 union all
 select 'Inventory trigger catalog unchanged',coalesce(((select coalesce(jsonb_agg(jsonb_build_array(c.relname,t.tgname,pg_catalog.pg_get_triggerdef(t.oid)) order by c.relname,t.tgname),'[]') from pg_catalog.pg_trigger t join pg_catalog.pg_class c on c.oid=t.tgrelid join pg_catalog.pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname in ('inventory_items','inventory_movements') and not t.tgisinternal)='[["inventory_items", "inventory_items_unit_lock", "CREATE TRIGGER inventory_items_unit_lock BEFORE UPDATE ON public.inventory_items FOR EACH ROW EXECUTE FUNCTION inventory_item_unit_is_locked()"], ["inventory_items", "set_inventory_items_updated_at", "CREATE TRIGGER set_inventory_items_updated_at BEFORE UPDATE ON public.inventory_items FOR EACH ROW EXECUTE FUNCTION set_updated_at()"]]'::jsonb),false)
 union all
 select 'Exact new signature canonical body and privileged ACL',coalesce((not exists(select 1 from (values ('public.record_annual_prepayment_event_v2(uuid,uuid)','0533bf506b220a8597002698f4fee691')) wanted(signature,hash)
 left join pg_catalog.pg_proc p on p.oid=pg_catalog.to_regprocedure(wanted.signature)
 where p.oid is null or p.prosecdef is not true or not coalesce('search_path=""'=any(p.proconfig),false)
 or pg_catalog.format_type(p.prorettype,null)<>'jsonb' or (with recursive lex(pos,mode,depth,clean) as (
  select 1,'code'::text collate pg_catalog."C",0,''::text collate pg_catalog."C"
  union all
  select pos+case
    when mode='code' and pair in ('--','/*') then 2
    when mode='single' and pair=$q$''$q$ then 2
    when mode='double' and pair='""' then 2
    when mode='block' and pair in ('/*','*/') then 2 else 1 end,
   case
    when mode='code' and pair='--' then 'line'
    when mode='code' and pair='/*' then 'block'
    when mode='code' and c=$q$'$q$ then 'single'
    when mode='code' and c='"' then 'double'
    when mode='single' and c=$q$'$q$ and pair<>$q$''$q$ then 'code'
    when mode='double' and c='"' and pair<>'""' then 'code'
    when mode='line' and c in (pg_catalog.chr(10),pg_catalog.chr(13)) then 'code'
    when mode='block' and pair='*/' and depth=1 then 'code' else mode end,
   case when mode='code' and pair='/*' then 1
    when mode='block' and pair='/*' then depth+1
    when mode='block' and pair='*/' then depth-1 else depth end,
   clean||case
    when mode='code' and pair in ('--','/*') then ' '
    when mode in ('line','block') then ''
    when mode='single' and pair=$q$''$q$ then pair
    when mode='double' and pair='""' then pair else c end
  from lex cross join lateral (select pg_catalog.substr(p.prosrc,pos,1) c,pg_catalog.substr(p.prosrc,pos,2) pair) ch
  where pos<=pg_catalog.length(p.prosrc)
 ), cleaned as(select clean from lex where pos>pg_catalog.length(p.prosrc) and mode in ('code','line') and depth=0),
 tokens as(select m[1] token,ord from cleaned cross join lateral pg_catalog.regexp_matches(clean,
  $tokens$'(?:''|[^'])*'|"(?:""|[^"])*"|[A-Za-z_][A-Za-z_0-9$]*|[0-9]+(?:\.[0-9]+)?|->>|->|::|:=|<>|>=|<=|!=|\|\||\s+|.$tokens$,'g') with ordinality r(m,ord))
 select pg_catalog.md5(pg_catalog.string_agg(pg_catalog.octet_length(token)::text||':'||token,'' order by ord))
 from tokens where token !~ $space$^\s+$$space$) is distinct from wanted.hash
 or not pg_catalog.has_function_privilege('service_role',p.oid,'EXECUTE')
 or pg_catalog.has_function_privilege('anon',p.oid,'EXECUTE') or pg_catalog.has_function_privilege('authenticated',p.oid,'EXECUTE')
 or exists(select 1 from pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a where a.grantee=0 and a.privilege_type='EXECUTE')) and (select count(*) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='record_annual_prepayment_event_v2')=1),false)
), results as(select name,case when ok then 'PASS' else 'FAIL' end status from checks)
select name,status from results
union all select 'SUMMARY',count(*) filter(where status='FAIL')||' FAIL / '||count(*) filter(where status='PASS')||' PASS' from results
union all select 'VERDICT',case when bool_and(ok) then 'APPLIED CLEANLY' else 'DO NOT APPLY' end from checks;
