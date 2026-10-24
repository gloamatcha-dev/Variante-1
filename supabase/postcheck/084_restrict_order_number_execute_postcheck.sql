-- READ ONLY. Never consumes an order number or creates a commercial record.
with helper as (
 select * from pg_catalog.pg_proc
 where oid=pg_catalog.to_regprocedure('public.generate_order_number()')
), checks as (
 select 'PUBLIC EXECUTE absent' as name,
  count(*)=1 and not exists(select from helper h cross join lateral
   pg_catalog.aclexplode(coalesce(h.proacl,pg_catalog.acldefault('f',h.proowner))) a
   where a.grantee=0 and a.privilege_type='EXECUTE') as passed from helper
 union all select 'Direct API helper execution denied',
  count(*)=1 and bool_and((not pg_catalog.has_function_privilege('anon',oid,'EXECUTE')
    and not pg_catalog.has_function_privilege('authenticated',oid,'EXECUTE')
    and not pg_catalog.has_function_privilege('service_role',oid,'EXECUTE')) is true) from helper
 union all select 'Postgres owner and definer context preserved',
  count(*)=1 and bool_and((proowner='postgres'::pg_catalog.regrole and prosecdef
    and proconfig=array['search_path=""'] and pg_catalog.has_function_privilege('postgres',oid,'EXECUTE')) is true) from helper
 union all select 'Outer paid-checkout writer remains service-only',
  count(*)=1 and bool_and((proowner='postgres'::pg_catalog.regrole and prosecdef
    and proconfig=array['search_path=""']
    and pg_catalog.has_function_privilege('service_role',oid,'EXECUTE')
    and not pg_catalog.has_function_privilege('anon',oid,'EXECUTE')
    and not pg_catalog.has_function_privilege('authenticated',oid,'EXECUTE')) is true)
 from pg_catalog.pg_proc where oid=pg_catalog.to_regprocedure('public.create_order_from_paid_checkout(uuid,jsonb,text,jsonb,jsonb,integer)')
 union all select 'Helper definition and signature unchanged',
  count(*)=1 and bool_and((pronargs=0 and prorettype='text'::pg_catalog.regtype and provolatile='v'
   and prolang=(select oid from pg_catalog.pg_language where lanname='sql')
   and pg_catalog.md5(pg_catalog.replace(prosrc,E'\r\n',E'\n'))='fcb7626b2ceb260c081d3f0660a487b8') is true) from helper
)
select name,case when passed is true then 'PASS' else 'FAIL' end as verdict from checks
union all select 'SUMMARY',case when count(*)=5 and bool_and(passed is true) is true then 'APPLIED CLEANLY' else 'REVIEW REQUIRED' end from checks;
