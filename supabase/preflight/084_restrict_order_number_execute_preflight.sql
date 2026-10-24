-- READ ONLY. Does not invoke the helper, its sequence or any order writer.
-- Verify external integrations and migration history separately before approval.
with f as (
 select p.*, r.rolname as owner_name from pg_catalog.pg_proc p
 join pg_catalog.pg_roles r on r.oid=p.proowner
 where p.oid in (
  pg_catalog.to_regprocedure('public.generate_order_number()'),
  pg_catalog.to_regprocedure('public.create_order_from_paid_checkout(uuid,jsonb,text,jsonb,jsonb,integer)'))
), checks as (
 select 'Exact reviewed functions and owners' as name,
  count(*)=2 and bool_and((owner_name='postgres' and prosecdef and proconfig=array['search_path=""']) is true) as passed
 from f
 union all select 'Helper is text-returning SQL volatile zero-arg function',
  exists(select from f where oid=pg_catalog.to_regprocedure('public.generate_order_number()')
   and pronargs=0 and prorettype='text'::pg_catalog.regtype and provolatile='v'
   and prolang=(select oid from pg_catalog.pg_language where lanname='sql')
   and pg_catalog.md5(pg_catalog.replace(prosrc,E'\r\n',E'\n'))='fcb7626b2ceb260c081d3f0660a487b8')
 union all select 'No unreviewed overloads',
  (select count(*)=1 from pg_catalog.pg_proc where pronamespace='public'::pg_catalog.regnamespace and proname='generate_order_number')
  and (select count(*)=1 from pg_catalog.pg_proc where pronamespace='public'::pg_catalog.regnamespace and proname='create_order_from_paid_checkout')
 union all select 'Existing order default depends on helper',
  exists(select from pg_catalog.pg_attrdef d
   join pg_catalog.pg_attribute a on a.attrelid=d.adrelid and a.attnum=d.adnum
   join pg_catalog.pg_depend dep on dep.classid='pg_attrdef'::pg_catalog.regclass and dep.objid=d.oid
   where d.adrelid=pg_catalog.to_regclass('public.orders') and a.attname='order_number'
    and dep.refclassid='pg_proc'::pg_catalog.regclass
    and dep.refobjid=pg_catalog.to_regprocedure('public.generate_order_number()'))
 union all select 'Number sequence exists and belongs to postgres',
  exists(select from pg_catalog.pg_class c where c.oid=pg_catalog.to_regclass('public.order_number_seq')
    and c.relkind='S' and c.relowner='postgres'::pg_catalog.regrole)
 union all select 'Outer paid-checkout writer stays service-only',
  exists(select from f where oid=pg_catalog.to_regprocedure('public.create_order_from_paid_checkout(uuid,jsonb,text,jsonb,jsonb,integer)')
    and pg_catalog.has_function_privilege('service_role',oid,'EXECUTE')
    and not pg_catalog.has_function_privilege('anon',oid,'EXECUTE')
    and not pg_catalog.has_function_privilege('authenticated',oid,'EXECUTE'))
 union all select 'Helper owner retains execution',
  exists(select from f where oid=pg_catalog.to_regprocedure('public.generate_order_number()')
    and pg_catalog.has_function_privilege('postgres',oid,'EXECUTE'))
)
select name,case when passed is true then 'PASS' else 'FAIL' end as verdict from checks
union all select 'SUMMARY',case when count(*)=7 and bool_and(passed is true) is true then 'SAFE TO APPLY' else 'DO NOT APPLY' end from checks;
