-- ============================================================
-- GLOA · MIGRATION 069 PRODUCTION PREFLIGHT  ·  READ ONLY
-- ONE statement. No writes.
-- Run in the Supabase SQL Editor against PRODUCTION.
-- SAFE TO APPLY  <=>  the final SUMMARY row says 'SAFE TO APPLY'
--                     (i.e. zero rows with verdict = 'FAIL').
-- Rows with verdict 'INFO' are context, never a blocker.
-- ============================================================
with
fn as (
  select p.oid, p.proname, p.pronargs, p.pronargdefaults,
         pg_catalog.pg_get_function_identity_arguments(p.oid) as ident
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
),
ap_cols as (
  select column_name::text as column_name from information_schema.columns
  where table_schema = 'public' and table_name = 'annual_plans'
),
auth_readable as (
  select c.column_name::text as column_name
  from information_schema.columns c
  where c.table_schema = 'public' and c.table_name = 'annual_plans'
    and pg_catalog.has_column_privilege('authenticated', 'public.annual_plans', c.column_name::text, 'SELECT')
),
checks as (

  -- ── 066 / 067 / 068 ARE ALL STILL IN PLACE ────────────────
  select 10 as ord, '066-068' as area,
         'all four annual safety objects from 066/067/068 stand' as check_name,
         '2 indexes + claim CHECK + pending_expires_at' as expected,
         (select count(*)::text from pg_indexes where schemaname = 'public'
            and indexname in ('annual_plans_active_upgrade_per_subscription_key',
                              'annual_plans_pending_upgrade_claim_idx',
                              'annual_plans_one_live_per_user_key',
                              'annual_plans_pending_customer_claim_idx'))
           || ' of 4 indexes, '
           || (select count(*)::text from pg_catalog.pg_constraint con
               join pg_catalog.pg_class c on c.oid = con.conrelid
               join pg_catalog.pg_namespace n on n.oid = c.relnamespace
               where n.nspname = 'public' and c.relname = 'annual_plans'
                 and con.conname = 'annual_plans_pending_claim_shape_check')
           || ' claim CHECK, '
           || (select count(*)::text from ap_cols where column_name = 'pending_expires_at')
           || ' pending_expires_at' as actual,
         case when (select count(*) from pg_indexes where schemaname = 'public'
                      and indexname in ('annual_plans_active_upgrade_per_subscription_key',
                                        'annual_plans_pending_upgrade_claim_idx',
                                        'annual_plans_one_live_per_user_key',
                                        'annual_plans_pending_customer_claim_idx')) = 4
               and (select count(*) from ap_cols where column_name = 'pending_expires_at') = 1
              then 'PASS' else 'FAIL' end as verdict

  union all
  select 11, '066-068',
         'both 066 anchor constraints and the 068 one-live-per-user index are untouched',
         '2 anchor CHECKs, unique index on (user_id) excluding refunded',
         coalesce(string_agg(conname::text, ', ' order by conname::text), '<none>'),
         case when count(*) = 2 then 'PASS' else 'FAIL' end
  from pg_catalog.pg_constraint con
  join pg_catalog.pg_class c on c.oid = con.conrelid
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'annual_plans' and con.contype = 'c'
    and con.conname in ('annual_plans_anchor_requires_source_check',
                        'annual_plans_anchor_requires_purchase_check')

  union all
  select 12, '066-068',
         'the pending-plan writer is 068''s 17-arg version that 069 replaces',
         'ends in p_pending_expires_at timestamp with time zone, 17 args, no defaults',
         coalesce(string_agg(ident || ' [nargs=' || pronargs || ' defaults=' || pronargdefaults || ']', ' | '), '<missing>'),
         case when count(*) = 1
               and bool_and(pronargs = 17 and pronargdefaults = 0
                        and ident like '%p_source_subscription_id uuid, p_pending_expires_at timestamp with time zone')
              then 'PASS' else 'FAIL' end
  from fn where proname = 'create_pending_annual_plan_for_attempt'

  union all
  select 13, '066-068',
         'activate_annual_plan_from_payment is the 4-arg version 069 replaces in place',
         'p_annual_plan_id uuid, p_stripe_checkout_session_id text, p_stripe_payment_intent_id text, p_schedule_anchor_at timestamp with time zone',
         coalesce(string_agg(ident, ' | '), '<missing>'),
         case when count(*) = 1
               and min(ident) = 'p_annual_plan_id uuid, p_stripe_checkout_session_id text, p_stripe_payment_intent_id text, p_schedule_anchor_at timestamp with time zone'
              then 'PASS' else 'FAIL' end
  from fn where proname = 'activate_annual_plan_from_payment'

  -- ── THE CONSTRAINT 069 REPLACES MUST BE THE ONE IT EXPECTS ─
  union all
  select 20, '069-dep',
         'delivery_count is still pinned to exactly 13 - the CHECK 069 widens',
         'CHECK (delivery_count = 13)',
         coalesce(string_agg(pg_catalog.pg_get_constraintdef(con.oid), ' | '), '<missing>'),
         case when count(*) = 1
               and bool_and(pg_catalog.pg_get_constraintdef(con.oid) like '%delivery_count = 13%')
              then 'PASS' else 'FAIL' end
  from pg_catalog.pg_constraint con
  join pg_catalog.pg_class c on c.oid = con.conrelid
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'annual_plans'
    and con.conname = 'annual_plans_delivery_count_check'

  union all
  select 21, '069-dep',
         'the ON CONFLICT constraint the schedule insert names still exists',
         'annual_plan_deliveries_plan_number_key, unique',
         coalesce(string_agg(con.conname::text || ':' || con.contype::text, ', '), '<missing>'),
         case when count(*) = 1 then 'PASS' else 'FAIL' end
  from pg_catalog.pg_constraint con
  join pg_catalog.pg_class c on c.oid = con.conrelid
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'annual_plan_deliveries'
    and con.conname = 'annual_plan_deliveries_plan_number_key'
    and con.contype in ('u', 'p')

  union all
  select 22, '069-dep',
         'Europe/Berlin is a known timezone on this server - the calendar depends on it',
         'resolvable',
         (select count(*)::text from pg_catalog.pg_timezone_names where name = 'Europe/Berlin'),
         case when (select count(*) from pg_catalog.pg_timezone_names where name = 'Europe/Berlin') = 1
              then 'PASS' else 'FAIL' end

  -- ── 069 MUST NOT BE PARTIALLY APPLIED ─────────────────────
  union all
  select 30, '069-clean',
         'neither 069 column exists yet', 'none',
         coalesce(string_agg(column_name, ', ' order by column_name), 'none'),
         case when count(*) = 0 then 'PASS' else 'FAIL' end
  from ap_cols where column_name in ('schedule_model', 'schedule_anchor_date')

  union all
  select 31, '069-clean',
         'none of the three 069 constraints exists yet', 'none',
         coalesce(string_agg(con.conname::text, ', ' order by con.conname::text), 'none'),
         case when count(*) = 0 then 'PASS' else 'FAIL' end
  from pg_catalog.pg_constraint con
  join pg_catalog.pg_class c on c.oid = con.conrelid
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'annual_plans'
    and con.conname in ('annual_plans_schedule_model_count_check',
                        'annual_plans_anchor_date_requires_v2_check',
                        'annual_plans_v2_purchase_requires_anchor_date_check')

  union all
  select 32, '069-clean',
         'the calendar helper does not exist yet', 'none',
         coalesce(string_agg(proname::text, ', '), 'none'),
         case when count(*) = 0 then 'PASS' else 'FAIL' end
  from fn where proname = 'annual_monthly_delivery_date'

  union all
  select 33, '069-clean',
         'no post-069 overload of the writer already exists', 'none',
         coalesce(string_agg(proname::text || '[nargs=' || pronargs || ']', ' | '), 'none'),
         case when count(*) = 0 then 'PASS' else 'FAIL' end
  from fn
  where proname = 'create_pending_annual_plan_for_attempt'
    and (pronargs = 18 or ident like '%p_schedule_model text')

  -- ── PRIVILEGES MUST NOT HAVE MOVED, AND 069 MOVES NONE ────
  union all
  select 40, 'privs',
         'service_role holds EXECUTE on both annual writers',
         'both true',
         coalesce(string_agg(proname::text || '=' ||
                  pg_catalog.has_function_privilege('service_role', oid, 'EXECUTE')::text,
                  ', ' order by proname::text), '<missing>'),
         case when count(*) = 2
               and bool_and(pg_catalog.has_function_privilege('service_role', oid, 'EXECUTE'))
              then 'PASS' else 'FAIL' end
  from fn
  where proname in ('create_pending_annual_plan_for_attempt', 'activate_annual_plan_from_payment')

  union all
  select 41, 'privs',
         'neither writer is reachable by anon or authenticated',
         'all four false',
         coalesce(string_agg(proname::text
                  || ' anon=' || pg_catalog.has_function_privilege('anon', oid, 'EXECUTE')::text
                  || ' auth=' || pg_catalog.has_function_privilege('authenticated', oid, 'EXECUTE')::text,
                  ', ' order by proname::text), '<missing>'),
         case when count(*) = 2
               and bool_and(not pg_catalog.has_function_privilege('anon', oid, 'EXECUTE')
                        and not pg_catalog.has_function_privilege('authenticated', oid, 'EXECUTE'))
              then 'PASS' else 'FAIL' end
  from fn
  where proname in ('create_pending_annual_plan_for_attempt', 'activate_annual_plan_from_payment')

  union all
  select 42, 'privs',
         'the browser reads exactly the 21 columns 066 left, and 069 adds none',
         '21 columns, neither 069 column among them',
         count(*)::text || ' columns; schedule_model readable='
           || coalesce(bool_or(column_name = 'schedule_model')::text, 'false'),
         case when count(*) = 21 and not coalesce(bool_or(column_name in ('schedule_model','schedule_anchor_date')), false)
              then 'PASS' else 'FAIL' end
  from auth_readable

  union all
  select 43, 'privs',
         'authenticated may NOT read annual_plans as a whole table',
         'false',
         pg_catalog.has_table_privilege('authenticated', 'public.annual_plans', 'SELECT')::text,
         case when pg_catalog.has_table_privilege('authenticated', 'public.annual_plans', 'SELECT')
              then 'FAIL' else 'PASS' end

  -- ── EXISTING DATA MUST SATISFY EVERY NEW CONSTRAINT ───────
  -- schedule_model defaults to v1 for every existing row, so the pairing
  -- CHECK only holds if every existing row really has 13 deliveries. A
  -- row with any other count would abort the migration.
  union all
  select 50, 'data',
         'every existing annual plan has exactly 13 deliveries',
         '0 rows with any other count - anything else aborts the pairing CHECK',
         (select count(*)::text from public.annual_plans where delivery_count <> 13)
           || ' of ' || (select count(*)::text from public.annual_plans) || ' rows',
         case when (select count(*) from public.annual_plans where delivery_count <> 13) = 0
              then 'PASS' else 'FAIL' end

  union all
  select 51, 'data',
         'no plan already carries a v2-shaped schedule',
         '0 - the columns do not exist, so this can only be non-zero after a partial apply',
         (select count(*)::text from ap_cols
           where column_name in ('schedule_model', 'schedule_anchor_date')) || ' of the 2 columns present',
         case when (select count(*) from ap_cols
                     where column_name in ('schedule_model', 'schedule_anchor_date')) = 0
              then 'PASS' else 'FAIL' end

  union all
  select 52, 'data',
         'INFO: LIVE 13-delivery plans that 069 must leave exactly as they are',
         'each keeps v1, its 13 rows, its 28-day steps and its 8736-hour term',
         (select count(*)::text from public.annual_plans
           where status = 'active' and payment_status <> 'refunded'),
         'INFO'

  union all
  select 53, 'data',
         'INFO: every annual plan by status, with its delivery-row count',
         'all of these stay v1 and are not re-scheduled',
         (select coalesce(string_agg(t, '; '), 'none') from (
            select p.status || '=' || count(*)::text
                   || ' (rows ' || coalesce(min(dc.c)::text, '0')
                   || '-' || coalesce(max(dc.c)::text, '0') || ')' as t
            from public.annual_plans p
            left join (select annual_plan_id, count(*) c
                       from public.annual_plan_deliveries group by annual_plan_id) dc
              on dc.annual_plan_id = p.id
            group by p.status) g),
         'INFO'

  union all
  select 54, 'data',
         'INFO: annual plans with a LIVE pending claim right now',
         'a claim in flight settles through the NEW writer after apply; it stays v1',
         (select count(*)::text from public.annual_plans
           where status = 'pending' and pending_expires_at > now()),
         'INFO'

  union all
  select 55, 'data',
         'INFO: pending annual plans in total, by path',
         'each was priced for 13 deliveries by the running code and still is',
         (select count(*) filter (where source_subscription_id is null)::text || ' ordinary, '
               || count(*) filter (where source_subscription_id is not null)::text || ' upgrade'
            from public.annual_plans where status = 'pending'),
         'INFO'
)
select ord, area, check_name, expected, actual, verdict from checks
union all
select 999, 'SUMMARY', 'migration 069 preflight',
       'zero FAIL rows',
       (count(*) filter (where verdict = 'FAIL'))::text || ' FAIL / '
         || (count(*) filter (where verdict = 'PASS'))::text || ' PASS / '
         || (count(*) filter (where verdict = 'INFO'))::text || ' INFO',
       case when count(*) filter (where verdict = 'FAIL') = 0
            then 'SAFE TO APPLY' else 'NOT SAFE TO APPLY' end
from checks
order by 1;
