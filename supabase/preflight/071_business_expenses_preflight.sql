-- ══════════════════════════════════════════════════════════════
-- 071 PREFLIGHT  —  READ ONLY.  SAFE TO RUN AGAINST PRODUCTION.
-- ══════════════════════════════════════════════════════════════
--
-- Answers one question: would migration 071 apply cleanly, right now,
-- to THIS database?
--
-- It writes nothing. It is ONE SELECT statement - no transaction, no DO
-- block, no temporary table, no function - so there is nothing it could
-- leave behind even if it were interrupted half way.
--
-- ── WHAT A FAIL MEANS ─────────────────────────────────────────
--
-- 071 is additive: one table, one constraint, three indexes, three
-- SECURITY DEFINER functions, and a handful of grants. It alters no
-- existing table and rewrites no existing row. So the things that could
-- stop it are narrow and specific:
--
--   10  the name business_expenses is already taken
--   11  one of the three function names is already taken
--   12  one of the three index names is already taken
--   13  the constraint name is already taken
--   20  public.orders is missing (the FK target)
--   21  auth.users is missing (the created_by target)
--   22  record_admin_activity is missing (the writers call it)
--   23  admin_activity_log does not accept module 'finance'
--   24  the three roles 071 grants to do not all exist
--
-- Anything else that 071 needs, it creates itself.
--
-- EXPECTED HEALTHY RESULT:  0 FAIL / 9 PASS / 3 INFO — SAFE TO APPLY
--
-- Nine verdict-bearing checks (10-13, 20-24) and three INFO rows
-- (50-52), plus the SUMMARY row, which counts only the twelve above it.
-- The SUMMARY is always computed from the actual rows; this line is the
-- expectation to compare it against, never the source of it. Verified: a
-- database carrying 001..070 and not 071 returns exactly
-- 0 FAIL / 9 PASS / 3 INFO.

select *
  from (

  -- ── 10-13. IS 071 ALREADY HERE, IN WHOLE OR IN PART ─────────
  --
  -- Every object 071 creates uses IF NOT EXISTS or CREATE OR REPLACE, so
  -- a re-run would not error. That is exactly why these are checked: a
  -- silent success against a half-applied database is worse than a loud
  -- refusal, because it leaves nobody knowing which half is live.

  select 10 as check_id, 'collision' as area,
         'the business_expenses table does not exist yet' as question,
         'expected: absent' as expectation,
         (select count(*)::text || ' table(s) named business_expenses'
            from information_schema.tables
           where table_schema = 'public' and table_name = 'business_expenses') as found,
         case when (select count(*) from information_schema.tables
                     where table_schema = 'public'
                       and table_name = 'business_expenses') = 0
              then 'PASS' else 'FAIL' end as verdict

  union all
  select 11, 'collision',
         'none of the three writer names is taken',
         'expected: 0 of admin_record/update/delete_business_expense',
         coalesce((select string_agg(p.proname, ', ' order by p.proname)
                     from pg_proc p
                     join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'public'
                      and p.proname in ('admin_record_business_expense',
                                        'admin_update_business_expense',
                                        'admin_delete_business_expense')),
                  'none'),
         case when (select count(*) from pg_proc p
                      join pg_namespace n on n.oid = p.pronamespace
                     where n.nspname = 'public'
                       and p.proname in ('admin_record_business_expense',
                                         'admin_update_business_expense',
                                         'admin_delete_business_expense')) = 0
              then 'PASS' else 'FAIL' end

  union all
  select 12, 'collision',
         'none of the three index names is taken',
         'expected: 0 of idx_business_expenses_occurred_on/order/category',
         coalesce((select string_agg(indexname, ', ' order by indexname)
                     from pg_indexes
                    where schemaname = 'public'
                      and indexname in ('idx_business_expenses_occurred_on',
                                        'idx_business_expenses_order',
                                        'idx_business_expenses_category')),
                  'none'),
         case when (select count(*) from pg_indexes
                     where schemaname = 'public'
                       and indexname in ('idx_business_expenses_occurred_on',
                                         'idx_business_expenses_order',
                                         'idx_business_expenses_category')) = 0
              then 'PASS' else 'FAIL' end

  union all
  select 13, 'collision',
         'the order-scope constraint name is free',
         'expected: absent',
         coalesce((select conname from pg_constraint
                    where conname = 'business_expenses_order_scope_check'
                    limit 1), 'none'),
         case when (select count(*) from pg_constraint
                     where conname = 'business_expenses_order_scope_check') = 0
              then 'PASS' else 'FAIL' end

  -- ── 20-24. WHAT 071 DEPENDS ON AND DOES NOT CREATE ──────────

  union all
  select 20, 'dependency',
         'public.orders exists, with the id column the FK points at',
         'expected: 1 table, 1 column named id',
         (select count(*)::text || ' orders.id column(s)'
            from information_schema.columns
           where table_schema = 'public' and table_name = 'orders'
             and column_name = 'id'),
         case when (select count(*) from information_schema.columns
                     where table_schema = 'public' and table_name = 'orders'
                       and column_name = 'id') = 1
              then 'PASS' else 'FAIL' end

  union all
  select 21, 'dependency',
         'auth.users exists, for created_by',
         'expected: 1 table',
         (select count(*)::text || ' auth.users table(s)'
            from information_schema.tables
           where table_schema = 'auth' and table_name = 'users'),
         case when (select count(*) from information_schema.tables
                     where table_schema = 'auth' and table_name = 'users') = 1
              then 'PASS' else 'FAIL' end

  union all
  select 22, 'dependency',
         'record_admin_activity exists with the 8-argument signature',
         'expected: 1 function (uuid, text, text, text, text, text, uuid, jsonb)',
         -- The TYPE vector, not pg_get_function_identity_arguments: that
         -- one includes parameter NAMES ("p_actor_user_id uuid, ...") and
         -- never matches a bare type list.
         coalesce((select count(*)::text || ' matching function(s)'
                     from pg_proc p
                     join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'public'
                      and p.proname = 'record_admin_activity'
                      and pg_catalog.oidvectortypes(p.proargtypes)
                          = 'uuid, text, text, text, text, text, uuid, jsonb'),
                  '0'),
         case when (select count(*) from pg_proc p
                      join pg_namespace n on n.oid = p.pronamespace
                     where n.nspname = 'public'
                       and p.proname = 'record_admin_activity'
                       and pg_catalog.oidvectortypes(p.proargtypes)
                           = 'uuid, text, text, text, text, text, uuid, jsonb') = 1
              then 'PASS' else 'FAIL' end

  union all
  -- THE ONE THAT BIT 070. Its first version audited under a module the
  -- CHECK did not allow, and only a real database said so. 071 audits
  -- under 'finance', which 070 itself added to the list - so this
  -- verifies the dependency rather than assuming it.
  select 23, 'dependency',
         'admin_activity_log accepts the module 071 audits under',
         'expected: the module CHECK contains finance',
         coalesce((select case when pg_get_constraintdef(oid) like '%''finance''%'
                               then 'finance is allowed'
                               else 'finance is NOT in: ' || pg_get_constraintdef(oid) end
                     from pg_constraint
                    where conname = 'admin_activity_log_module_check'
                    limit 1),
                  'the module CHECK is missing entirely'),
         case when (select count(*) from pg_constraint
                     where conname = 'admin_activity_log_module_check'
                       and pg_get_constraintdef(oid) like '%''finance''%') = 1
              then 'PASS' else 'FAIL' end

  union all
  select 24, 'dependency',
         'the three roles 071 grants to all exist',
         'expected: anon, authenticated, service_role',
         (select coalesce(string_agg(r.rolname, ', ' order by r.rolname), 'none')
            from pg_roles r
           where r.rolname in ('anon', 'authenticated', 'service_role')),
         case when (select count(*) from pg_roles
                     where rolname in ('anon', 'authenticated', 'service_role')) = 3
              then 'PASS' else 'FAIL' end

  -- ── 50-52. INFO. Context for the operator, never a verdict. ──
  --
  -- 071 reads none of these and changes none of them. They are here so
  -- the person applying it knows what the finance screen will have to
  -- work with on the other side - in particular how much revenue exists
  -- with no cost recorded against it yet, which on the first day is all
  -- of it.

  union all
  select 50, 'info',
         'how many paid orders exist (the revenue side, already authoritative)',
         'INFO - 071 reads and writes none of them',
         (select count(*)::text || ' order(s) with placed_at set'
            from public.orders where placed_at is not null),
         'INFO'

  union all
  select 51, 'info',
         'what those orders total, gross',
         'INFO - frozen per order since migration 004',
         (select coalesce(sum(total_gross_cents), 0)::text || ' cents gross'
            from public.orders where placed_at is not null),
         'INFO'

  union all
  select 52, 'info',
         'how much of that has been refunded',
         'INFO - orders.refunded_total_cents, null where never recorded',
         (select coalesce(sum(coalesce(refunded_total_cents, 0)), 0)::text
                 || ' cents refunded across '
                 || count(*) filter (where refunded_total_cents is not null)::text
                 || ' order(s) carrying a figure'
            from public.orders where placed_at is not null),
         'INFO'

  union all
  select 999, 'SUMMARY',
         'migration 071 may be applied',
         'expected: 0 FAIL / 9 PASS / 3 INFO',
         (select count(*) filter (where v.verdict = 'FAIL')::text || ' FAIL / '
              || count(*) filter (where v.verdict = 'PASS')::text || ' PASS / '
              || count(*) filter (where v.verdict = 'INFO')::text || ' INFO'
            from (
              select case when (select count(*) from information_schema.tables
                                 where table_schema = 'public'
                                   and table_name = 'business_expenses') = 0
                          then 'PASS' else 'FAIL' end as verdict
              union all
              select case when (select count(*) from pg_proc p
                                  join pg_namespace n on n.oid = p.pronamespace
                                 where n.nspname = 'public'
                                   and p.proname in ('admin_record_business_expense',
                                                     'admin_update_business_expense',
                                                     'admin_delete_business_expense')) = 0
                          then 'PASS' else 'FAIL' end
              union all
              select case when (select count(*) from pg_indexes
                                 where schemaname = 'public'
                                   and indexname in ('idx_business_expenses_occurred_on',
                                                     'idx_business_expenses_order',
                                                     'idx_business_expenses_category')) = 0
                          then 'PASS' else 'FAIL' end
              union all
              select case when (select count(*) from pg_constraint
                                 where conname = 'business_expenses_order_scope_check') = 0
                          then 'PASS' else 'FAIL' end
              union all
              select case when (select count(*) from information_schema.columns
                                 where table_schema = 'public' and table_name = 'orders'
                                   and column_name = 'id') = 1
                          then 'PASS' else 'FAIL' end
              union all
              select case when (select count(*) from information_schema.tables
                                 where table_schema = 'auth' and table_name = 'users') = 1
                          then 'PASS' else 'FAIL' end
              union all
              select case when (select count(*) from pg_proc p
                                  join pg_namespace n on n.oid = p.pronamespace
                                 where n.nspname = 'public'
                                   and p.proname = 'record_admin_activity'
                                   and pg_catalog.oidvectortypes(p.proargtypes)
                                       = 'uuid, text, text, text, text, text, uuid, jsonb') = 1
                          then 'PASS' else 'FAIL' end
              union all
              select case when (select count(*) from pg_constraint
                                 where conname = 'admin_activity_log_module_check'
                                   and pg_get_constraintdef(oid) like '%''finance''%') = 1
                          then 'PASS' else 'FAIL' end
              union all
              select case when (select count(*) from pg_roles
                                 where rolname in ('anon', 'authenticated', 'service_role')) = 3
                          then 'PASS' else 'FAIL' end
              union all select 'INFO' union all select 'INFO' union all select 'INFO'
            ) as v),
         case when (select count(*) from information_schema.tables
                     where table_schema = 'public' and table_name = 'business_expenses') = 0
                   and (select count(*) from pg_proc p
                          join pg_namespace n on n.oid = p.pronamespace
                         where n.nspname = 'public'
                           and p.proname in ('admin_record_business_expense',
                                             'admin_update_business_expense',
                                             'admin_delete_business_expense')) = 0
                   and (select count(*) from pg_indexes
                         where schemaname = 'public'
                           and indexname in ('idx_business_expenses_occurred_on',
                                             'idx_business_expenses_order',
                                             'idx_business_expenses_category')) = 0
                   and (select count(*) from pg_constraint
                         where conname = 'business_expenses_order_scope_check') = 0
                   and (select count(*) from information_schema.columns
                         where table_schema = 'public' and table_name = 'orders'
                           and column_name = 'id') = 1
                   and (select count(*) from information_schema.tables
                         where table_schema = 'auth' and table_name = 'users') = 1
                   and (select count(*) from pg_proc p
                          join pg_namespace n on n.oid = p.pronamespace
                         where n.nspname = 'public'
                           and p.proname = 'record_admin_activity'
                           and pg_catalog.oidvectortypes(p.proargtypes)
                               = 'uuid, text, text, text, text, text, uuid, jsonb') = 1
                   and (select count(*) from pg_constraint
                         where conname = 'admin_activity_log_module_check'
                           and pg_get_constraintdef(oid) like '%''finance''%') = 1
                   and (select count(*) from pg_roles
                         where rolname in ('anon', 'authenticated', 'service_role')) = 3
              then 'SAFE TO APPLY' else 'DO NOT APPLY' end

  ) as checks
 order by check_id;
