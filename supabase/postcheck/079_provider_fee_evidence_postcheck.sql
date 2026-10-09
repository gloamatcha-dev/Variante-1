-- READ ONLY. Canonical REFUND TOKEN FINGERPRINT V1; ignores only comments/insignificant whitespace.
with checks(name,ok) as (
 select 'Legacy 072 writer body signature security unchanged',(exists(select 1 from pg_catalog.pg_proc p where p.oid=pg_catalog.to_regprocedure('public.record_payment_fee_event(uuid,integer,timestamp with time zone,text,uuid)') and p.prosecdef and 'search_path=""'=any(p.proconfig) and pg_catalog.format_type(p.prorettype,null)='jsonb' and (with recursive lex(pos,mode,depth,clean) as (
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
 from tokens where token !~ $space$^\s+$$space$)='2f36cdfe8b11ffbfefe30d3eefb974fb' and pg_catalog.has_function_privilege('service_role',p.oid,'EXECUTE') and not pg_catalog.has_function_privilege('anon',p.oid,'EXECUTE') and not pg_catalog.has_function_privilege('authenticated',p.oid,'EXECUTE') and not exists(select 1 from pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) x where x.grantee=0 and x.privilege_type='EXECUTE')))
 union all
 select '078 and monthly finance authorities installed',(pg_catalog.to_regprocedure('public.admin_assign_withdrawal_contract_v1(uuid,uuid,text,uuid)') is not null and pg_catalog.to_regprocedure('public.record_b2b_monthly_invoice_event(uuid,text)') is not null)
 union all
 select 'Finance RLS and browser mutation denial',(exists(select 1 from pg_catalog.pg_class where oid='public.financial_events'::pg_catalog.regclass and relrowsecurity) and not exists(select 1 from (values('anon'),('authenticated'),('service_role')) r(role) where pg_catalog.has_table_privilege(r.role,'public.financial_events','INSERT,UPDATE,DELETE,TRUNCATE') or pg_catalog.has_any_column_privilege(r.role,'public.financial_events','INSERT,UPDATE')))
 union all
 select 'Canonical subject columns',((select count(*) from information_schema.columns where table_schema='public' and ((table_name='financial_events' and column_name in ('order_id','annual_plan_id','b2b_agreement_id','currency','operation_id','external_reference')) or (table_name='b2b_payment_schedule' and column_name in ('stripe_invoice_id','stripe_payment_intent_id','paid_at')) or (table_name='b2b_deliveries' and column_name in ('stripe_invoice_id','supply_agreement_id')) or (table_name='orders' and column_name in ('checkout_attempt_id','stripe_payment_intent_id')) or (table_name='annual_plans' and column_name in ('payment_checkout_attempt_id','stripe_payment_intent_id'))))=15)
 union all
 select 'Positive ledger amount and fee vocabulary',(exists(select 1 from pg_catalog.pg_constraint where conrelid='public.financial_events'::pg_catalog.regclass and pg_catalog.pg_get_constraintdef(oid) like '%gross_cents > 0%') and exists(select 1 from pg_catalog.pg_constraint where conrelid='public.financial_events'::pg_catalog.regclass and pg_catalog.pg_get_constraintdef(oid) like '%payment_fee%'))
 union all
 select 'New RPC canonical signatures token bodies and ACL',(exists(select 1 from pg_catalog.pg_proc p where p.oid=pg_catalog.to_regprocedure('public.initialize_provider_fee_evidence_v1(uuid)') and p.prosecdef and 'search_path=""'=any(p.proconfig) and pg_catalog.format_type(p.prorettype,null)='jsonb' and (with recursive lex(pos,mode,depth,clean) as (
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
 from tokens where token !~ $space$^\s+$$space$)='bed4f2a158f5b1a92ead5e6d48b10e9f' and pg_catalog.has_function_privilege('service_role',p.oid,'EXECUTE') and not pg_catalog.has_function_privilege('anon',p.oid,'EXECUTE') and not pg_catalog.has_function_privilege('authenticated',p.oid,'EXECUTE') and not exists(select 1 from pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) x where x.grantee=0 and x.privilege_type='EXECUTE')) and exists(select 1 from pg_catalog.pg_proc p where p.oid=pg_catalog.to_regprocedure('public.record_provider_fee_result_v1(uuid,text,text,text,text,integer,text,timestamp with time zone,text)') and p.prosecdef and 'search_path=""'=any(p.proconfig) and pg_catalog.format_type(p.prorettype,null)='jsonb' and (with recursive lex(pos,mode,depth,clean) as (
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
 from tokens where token !~ $space$^\s+$$space$)='d279bb3bb597efb3e235aa9fb500263e' and pg_catalog.has_function_privilege('service_role',p.oid,'EXECUTE') and not pg_catalog.has_function_privilege('anon',p.oid,'EXECUTE') and not pg_catalog.has_function_privilege('authenticated',p.oid,'EXECUTE') and not exists(select 1 from pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) x where x.grantee=0 and x.privilege_type='EXECUTE')) and exists(select 1 from pg_catalog.pg_proc p where p.oid=pg_catalog.to_regprocedure('public.discover_provider_fee_evidence_v1(integer)') and p.prosecdef and 'search_path=""'=any(p.proconfig) and pg_catalog.format_type(p.prorettype,null)='jsonb' and (with recursive lex(pos,mode,depth,clean) as (
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
 from tokens where token !~ $space$^\s+$$space$)='d1a8beaf6853e16e05b65c4ffcd3f9d1' and pg_catalog.has_function_privilege('service_role',p.oid,'EXECUTE') and not pg_catalog.has_function_privilege('anon',p.oid,'EXECUTE') and not pg_catalog.has_function_privilege('authenticated',p.oid,'EXECUTE') and not exists(select 1 from pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) x where x.grantee=0 and x.privilege_type='EXECUTE')))
 union all
 select 'No overloads',((select count(*) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('initialize_provider_fee_evidence_v1','record_provider_fee_result_v1','discover_provider_fee_evidence_v1'))=3)
 union all
 select 'Evidence RLS read-only service role and browser denial',(exists(select 1 from pg_catalog.pg_class where oid=pg_catalog.to_regclass('public.provider_fee_evidence') and relrowsecurity) and pg_catalog.has_table_privilege('service_role','public.provider_fee_evidence','SELECT') and not exists(select 1 from (values('anon'),('authenticated')) r(role) where pg_catalog.has_table_privilege(r.role,'public.provider_fee_evidence','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') or pg_catalog.has_any_column_privilege(r.role,'public.provider_fee_evidence','SELECT,INSERT,UPDATE')) and not pg_catalog.has_table_privilege('service_role','public.provider_fee_evidence','INSERT,UPDATE,DELETE,TRUNCATE'))
 union all
 select 'Evidence 22 columns and validated FKs/checks',((select count(*) from information_schema.columns where table_schema='public' and table_name='provider_fee_evidence')=22 and (select count(*) from pg_catalog.pg_constraint where conrelid='public.provider_fee_evidence'::pg_catalog.regclass and contype='f')=6 and not exists(select 1 from pg_catalog.pg_constraint where conrelid='public.provider_fee_evidence'::pg_catalog.regclass and not convalidated))
 union all
 select 'Stable provider and subject uniqueness',((select count(*) from pg_catalog.pg_index where indrelid='public.provider_fee_evidence'::pg_catalog.regclass and indisunique)=10)
 union all
 select 'No evidence Inventory triggers',(not exists(select 1 from pg_catalog.pg_trigger where tgrelid='public.provider_fee_evidence'::pg_catalog.regclass and not tgisinternal))
) select name,case when ok is true then 'PASS' else 'FAIL' end as result from checks union all select (select count(*) filter(where ok is not true)||' FAIL / '||count(*) filter(where ok is true)||' PASS' from checks),case when (select bool_and(ok is true) from checks) then 'APPLIED CLEANLY' else 'DO NOT APPLY' end;
