-- READ ONLY. Does not invoke a reconciliation worker or sequence.
with checks as (
 select 'Monitoring columns exist' name,count(*)=3 passed from pg_attribute
 where attrelid=to_regclass('public.finance_sync_jobs') and attname in ('last_attempt_at','last_failure_at','last_failure_code') and not attisdropped
 union all select 'Monitoring trigger enabled',exists(select from pg_trigger where tgrelid=to_regclass('public.finance_sync_jobs') and tgname='finance_sync_monitor_job' and tgenabled='O' and not tgisinternal)
 union all select 'Owner and pinned definer context',count(*)=2 and bool_and((proowner='postgres'::regrole and prosecdef and proconfig=array['search_path=""']) is true)
 from pg_proc where oid in (to_regprocedure('public.finance_sync_monitor_job_v1()'),to_regprocedure('public.finance_sync_global_status_v1()'))
 union all select 'Service-only status',exists(select from pg_proc p where p.oid=to_regprocedure('public.finance_sync_global_status_v1()') and has_function_privilege('service_role',p.oid,'EXECUTE') and not has_function_privilege('anon',p.oid,'EXECUTE') and not has_function_privilege('authenticated',p.oid,'EXECUTE') and not exists(select from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee=0 and a.privilege_type='EXECUTE'))
 union all select 'Trigger function not callable by API',exists(select from pg_proc p where p.oid=to_regprocedure('public.finance_sync_monitor_job_v1()') and not has_function_privilege('service_role',p.oid,'EXECUTE') and not has_function_privilege('anon',p.oid,'EXECUTE') and not has_function_privilege('authenticated',p.oid,'EXECUTE') and not exists(select from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee=0 and a.privilege_type='EXECUTE'))
)
select name,case when passed is true then 'PASS' else 'FAIL' end verdict from checks
union all select 'SUMMARY',case when count(*)=5 and bool_and(passed is true) then 'MONITORING INSTALLED' else 'STOP' end from checks;
