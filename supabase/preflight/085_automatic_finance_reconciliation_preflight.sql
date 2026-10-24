-- Read-only metadata gate; NULL and missing rows explicitly fail closed.
with checks(name,ok) as (values
 ('roles',((select count(*) from pg_roles where rolname in ('anon','authenticated','service_role'))=3)),
 ('new_tables_absent',((select count(*)=7 and bool_and(to_regclass('public.'||n) is null) from unnest(array['finance_sync_config','finance_sync_periods','finance_sync_jobs','finance_sync_sources','finance_sync_approvals','finance_sync_alerts','finance_sync_discrepancies']) n))),
 ('ledger_rls',(exists(select 1 from pg_class where oid=to_regclass('public.financial_events') and relrowsecurity))),
 ('ledger_append_only',(exists(select 1 from pg_trigger where tgrelid=to_regclass('public.financial_events') and tgname='financial_events_append_only' and tgenabled='O'))),
 ('original_record_order_payment_event',(exists(select 1 from pg_proc p where p.oid=to_regprocedure('public.record_order_payment_event(uuid,uuid)') and p.prosecdef and p.proowner='postgres'::regrole and p.proconfig=array['search_path=""'] and md5(btrim(replace(p.prosrc,E'\r\n',E'\n'),E' \t\r\n'))='0f7507614db9c297cf3af3680ec04fbc'))),
 ('original_record_annual_prepayment_event_v2',(exists(select 1 from pg_proc p where p.oid=to_regprocedure('public.record_annual_prepayment_event_v2(uuid,uuid)') and p.prosecdef and p.proowner='postgres'::regrole and p.proconfig=array['search_path=""'] and md5(btrim(replace(p.prosrc,E'\r\n',E'\n'),E' \t\r\n'))='d6d3ec0471d1950ceed926b1f49aca97'))),
 ('original_refund_tax_record_v1',(exists(select 1 from pg_proc p where p.oid=to_regprocedure('public.refund_tax_record_v1(uuid,uuid,integer,text,uuid,text,uuid)') and p.prosecdef and p.proowner='postgres'::regrole and p.proconfig=array['search_path=""'] and md5(btrim(replace(p.prosrc,E'\r\n',E'\n'),E' \t\r\n'))='14698bad52633de531e091ff8fc66dbb'))),
 ('original_record_provider_fee_result_v1',(exists(select 1 from pg_proc p where p.oid=to_regprocedure('public.record_provider_fee_result_v1(uuid,text,text,text,text,integer,text,timestamptz,text)') and p.prosecdef and p.proowner='postgres'::regrole and p.proconfig=array['search_path=""'] and md5(btrim(replace(p.prosrc,E'\r\n',E'\n'),E' \t\r\n'))='253d214c47712644555bf052042ae428')))
), summary as (select count(*)=8 and coalesce(bool_and(ok is true),false) as pass from checks)
select name,case when ok is true then 'PASS' else 'FAIL' end as result from checks
union all select 'SUMMARY',case when pass then 'SAFE TO PREPARE 085' else 'DO NOT APPLY' end from summary;
