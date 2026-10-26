-- Read-only metadata gate; NULL and missing rows explicitly fail closed.
with expected_functions(signature) as (values
 ('finance_sync_claim_v1(text)'),
 ('finance_sync_checkpoint_v1(uuid,uuid,jsonb,text,text)'),
 ('finance_sync_stage_v1(uuid,uuid,jsonb)'),
 ('finance_sync_order_payment_v1(uuid,uuid,timestamptz)'),
 ('finance_sync_annual_payment_v1(uuid,uuid,timestamptz)'),
 ('finance_sync_refund_tax_v1(uuid,uuid,integer,text,uuid,text,uuid,timestamptz)'),
 ('finance_sync_discrepancy_v1(uuid,uuid,text,text)'),
 ('finance_sync_basis_v1()'),
 ('finance_sync_status_v1()'),
 ('finance_sync_provider_fee_v1(uuid,text,text,text,text,integer,text,timestamptz,text,timestamptz)'),
 ('finance_sync_source_read_v1(text,text)'),
 ('finance_sync_retry_ids_v1(text)'),
 ('finance_sync_record_v1(uuid,uuid,text)'),
 ('finance_sync_failure_v1(uuid,uuid,text)'),
 ('finance_sync_finish_v1(uuid,uuid,jsonb)'),
 ('finance_sync_period_v1(date,date)'),
 ('finance_sync_expense_guard_v1()'),
 ('finance_sync_details_v1()'),
 ('finance_sync_alert_v1(uuid,uuid,boolean)')
), function_checks as (
 select e.signature,
  (p.oid is not null
   and (select count(*)=1 from pg_proc overload
        where overload.pronamespace='public'::regnamespace
          and overload.proname=split_part(e.signature,'(',1))
   and p.prosecdef and p.proowner='postgres'::regrole
   and p.proconfig=array['search_path=""']
   and not has_function_privilege('anon',p.oid,'EXECUTE')
   and not has_function_privilege('authenticated',p.oid,'EXECUTE')
   and not exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
                  where a.grantee=0 and a.privilege_type='EXECUTE')) is true as ok
 from expected_functions e
 left join pg_proc p on p.oid=to_regprocedure('public.'||e.signature)
), checks(name,ok) as (values
 ('new_tables_rls',((select count(*)=7 and coalesce(bool_and(c.relrowsecurity and not has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE') and not has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE') and not has_table_privilege('service_role',c.oid,'INSERT,UPDATE,DELETE')),false) from pg_class c where c.relnamespace='public'::regnamespace and c.relname=any(array['finance_sync_config','finance_sync_periods','finance_sync_jobs','finance_sync_sources','finance_sync_approvals','finance_sync_alerts','finance_sync_discrepancies']) and c.relkind='r'))),
 ('function_security',((select count(*)=19 and coalesce(bool_and(ok is true),false) from function_checks))),
 ('unchanged_record_order_payment_event',(exists(select 1 from pg_proc p where p.oid=to_regprocedure('public.record_order_payment_event(uuid,uuid)') and p.prosecdef and p.proowner='postgres'::regrole and p.proconfig=array['search_path=""'] and md5(btrim(replace(p.prosrc,E'\r\n',E'\n'),E' \t\r\n'))='0f7507614db9c297cf3af3680ec04fbc'))),
 ('unchanged_record_annual_prepayment_event_v2',(exists(select 1 from pg_proc p where p.oid=to_regprocedure('public.record_annual_prepayment_event_v2(uuid,uuid)') and p.prosecdef and p.proowner='postgres'::regrole and p.proconfig=array['search_path=""'] and md5(btrim(replace(p.prosrc,E'\r\n',E'\n'),E' \t\r\n'))='d6d3ec0471d1950ceed926b1f49aca97'))),
 ('unchanged_refund_tax_record_v1',(exists(select 1 from pg_proc p where p.oid=to_regprocedure('public.refund_tax_record_v1(uuid,uuid,integer,text,uuid,text,uuid)') and p.prosecdef and p.proowner='postgres'::regrole and p.proconfig=array['search_path=""'] and md5(btrim(replace(p.prosrc,E'\r\n',E'\n'),E' \t\r\n'))='14698bad52633de531e091ff8fc66dbb'))),
 ('fee_rpc_exact_py_delta',(exists(select 1 from pg_proc p where p.oid=to_regprocedure('public.record_provider_fee_result_v1(uuid,text,text,text,text,integer,text,timestamptz,text)') and p.prosecdef and p.proowner='postgres'::regrole and p.proconfig=array['search_path=""'] and md5(btrim(replace(p.prosrc,E'\r\n',E'\n'),E' \t\r\n'))='3632276a9776c8d7669e1f433356ddc2'))),
 ('no_automatic_activation',(not exists(select 1 from public.finance_sync_config) and not exists(select 1 from public.finance_sync_sources) and not exists(select 1 from public.finance_sync_approvals)))
), summary as (select count(*)=7 and coalesce(bool_and(ok is true),false) as pass from checks)
select name,case when ok is true then 'PASS' else 'FAIL' end as result from checks
union all select 'function: public.'||signature,case when ok is true then 'PASS' else 'FAIL' end from function_checks
union all select 'SUMMARY',case when pass then '085 INSTALLED DISABLED' else 'REVIEW REQUIRED' end from summary;
