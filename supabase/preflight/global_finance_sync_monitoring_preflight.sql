-- Separate release gate AFTER approved 085; read-only, no worker invocation.
with checks as (
 select '085 job table and base status exist' name,
  to_regclass('public.finance_sync_jobs') is not null and to_regprocedure('public.finance_sync_status_v1()') is not null passed
 union all select 'Monitoring extension not already installed',
  to_regprocedure('public.finance_sync_global_status_v1()') is null
  and not exists(select from pg_attribute where attrelid=to_regclass('public.finance_sync_jobs') and attname in ('last_attempt_at','last_failure_at','last_failure_code') and not attisdropped)
 union all select 'Job table owned by postgres with RLS',
  exists(select from pg_class where oid=to_regclass('public.finance_sync_jobs') and relowner='postgres'::regrole and relrowsecurity)
)
select name,case when passed is true then 'PASS' else 'FAIL' end verdict from checks
union all select 'SUMMARY',case when count(*)=3 and bool_and(passed is true) then 'READY FOR SEPARATE APPROVAL' else 'STOP' end from checks;
