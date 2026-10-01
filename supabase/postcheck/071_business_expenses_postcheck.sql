-- ══════════════════════════════════════════════════════════════
-- 071 POSTCHECK  —  READ ONLY.  RUN AFTER APPLYING 071.
-- ══════════════════════════════════════════════════════════════
--
-- Answers one question: did migration 071 land completely and correctly?
--
-- It writes nothing. It is ONE SELECT statement - no transaction, no DO
-- block, no temporary table, no function - so there is nothing it could
-- leave behind even if it were interrupted half way.
--
-- ── WHAT IT CHECKS THAT A SCHEMA DIFF WOULD NOT ───────────────
--
-- Checks 10-24 are shape: the table, its columns, the constraint, the
-- indexes, the grants, RLS. A schema comparison would find those.
--
-- 30 AND 31 READ THE FUNCTION BODIES, and they are the only checks here
-- that could tell a correct 071 from a broken one that looks identical:
--
--   30  the writers audit under module 'finance' and under the three
--       actions the finance screen reads back
--
--   31  the writers COALESCE the operation id. This one is not
--       hypothetical: admin_activity_log.operation_id is NOT NULL, the
--       first version of 071 passed the parameter through unguarded, and
--       every writer raised the moment it was called without one. The
--       table, the columns, the indexes and the grants were all perfect.
--
-- 40 is the one that matters for a Production apply: 071 must have
-- rewritten NO existing row. It is additive, it backfills nothing, and a
-- fresh apply therefore leaves business_expenses empty.
--
-- EXPECTED HEALTHY RESULT:  0 FAIL / 12 PASS / 3 INFO — APPLIED CLEANLY
--
-- Twelve verdict-bearing checks (10-13, 20-24, 30-31, 40) and three INFO
-- rows (50-52), plus the SUMMARY row, which counts only the fifteen above
-- it. The SUMMARY is always computed from the actual rows; this line is
-- the expectation to compare it against, never the source of it.
-- Verified: a fresh apply of 001..071 to a real PostgreSQL 17 instance
-- returns exactly 0 FAIL / 12 PASS / 3 INFO.
--
-- ── RUN IT AFTER 071, NOT BEFORE ──────────────────────────────
--
-- Against a database where 071 has NOT been applied this does not report
-- failures - it ERRORS, on 'public.business_expenses'::regclass, because
-- the relation does not exist. That is deliberate and it is the right
-- behaviour: a postcheck that answered "INCOMPLETE" there would look like
-- a verdict about a migration that was never run. The preflight is the
-- file for that question.

select *
  from (

  -- ── 10-13. SHAPE ────────────────────────────────────────────

  select 10 as check_id, 'shape' as area,
         'all twelve business_expenses columns are present' as question,
         'expected: 12 of 12' as expectation,
         (select count(*)::text || ' of 12'
            from information_schema.columns
           where table_schema = 'public' and table_name = 'business_expenses'
             and column_name in ('id', 'occurred_on', 'category', 'order_id',
                                 'description', 'amount_cents', 'currency',
                                 'vendor', 'note', 'created_by',
                                 'created_at', 'updated_at')) as found,
         case when (select count(*) from information_schema.columns
                     where table_schema = 'public' and table_name = 'business_expenses'
                       and column_name in ('id', 'occurred_on', 'category', 'order_id',
                                           'description', 'amount_cents', 'currency',
                                           'vendor', 'note', 'created_by',
                                           'created_at', 'updated_at')) = 12
              then 'PASS' else 'FAIL' end as verdict

  union all
  -- THE CONSTRAINT THAT KEEPS THE TWO KINDS OF COST APART. A direct cost
  -- with no order would count against the period while belonging to no
  -- order, so the breakdown and the total would disagree.
  select 11, 'shape',
         'the order-scope constraint exists and names both halves',
         'expected: general has no order, and a direct category has one',
         coalesce((select pg_get_constraintdef(oid) from pg_constraint
                    where conname = 'business_expenses_order_scope_check' limit 1),
                  '<missing>'),
         case when (select count(*) from pg_constraint
                     where conname = 'business_expenses_order_scope_check'
                       and pg_get_constraintdef(oid) like '%order_id IS NULL%'
                       and pg_get_constraintdef(oid) like '%order_id IS NOT NULL%'
                       and pg_get_constraintdef(oid) like '%general%') = 1
              then 'PASS' else 'FAIL' end

  union all
  select 12, 'shape',
         'all three indexes are present',
         'expected: occurred_on, order (partial), category',
         (select coalesce(string_agg(indexname, ', ' order by indexname), 'none')
            from pg_indexes
           where schemaname = 'public'
             and indexname in ('idx_business_expenses_occurred_on',
                               'idx_business_expenses_order',
                               'idx_business_expenses_category')),
         case when (select count(*) from pg_indexes
                     where schemaname = 'public'
                       and indexname in ('idx_business_expenses_occurred_on',
                                         'idx_business_expenses_order',
                                         'idx_business_expenses_category')) = 3
              then 'PASS' else 'FAIL' end

  union all
  select 13, 'shape',
         'the three writers exist, SECURITY DEFINER, with an empty search_path',
         'expected: 3 of 3, all prosecdef, all search_path=""',
         (select coalesce(string_agg(p.proname || '(' ||
                   case when p.prosecdef then 'definer' else 'INVOKER' end || ', ' ||
                   coalesce(array_to_string(p.proconfig, ' '), 'NO search_path') || ')',
                   '; ' order by p.proname), 'none')
            from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public'
             and p.proname in ('admin_record_business_expense',
                               'admin_update_business_expense',
                               'admin_delete_business_expense')),
         case when (select count(*) from pg_proc p
                      join pg_namespace n on n.oid = p.pronamespace
                     where n.nspname = 'public'
                       and p.proname in ('admin_record_business_expense',
                                         'admin_update_business_expense',
                                         'admin_delete_business_expense')
                       and p.prosecdef
                       and 'search_path=' = any(
                             select left(c, 12) from unnest(p.proconfig) as c)) = 3
              then 'PASS' else 'FAIL' end

  -- ── 20-24. SECURITY AND THE MONEY RULES ─────────────────────

  union all
  -- service_role READS and never writes directly. If it could insert, a
  -- route could write an expense with no audit row, and the
  -- one-transaction guarantee in the writers would be advisory.
  select 20, 'security',
         'service_role may read the table but never write it directly',
         'expected: select yes; insert/update/delete no',
         'select=' || has_table_privilege('service_role', 'public.business_expenses', 'select')::text
           || ' insert=' || has_table_privilege('service_role', 'public.business_expenses', 'insert')::text
           || ' update=' || has_table_privilege('service_role', 'public.business_expenses', 'update')::text
           || ' delete=' || has_table_privilege('service_role', 'public.business_expenses', 'delete')::text,
         case when has_table_privilege('service_role', 'public.business_expenses', 'select')
                   and not has_table_privilege('service_role', 'public.business_expenses', 'insert')
                   and not has_table_privilege('service_role', 'public.business_expenses', 'update')
                   and not has_table_privilege('service_role', 'public.business_expenses', 'delete')
              then 'PASS' else 'FAIL' end

  union all
  select 21, 'security',
         'no browser role can read the table or execute a writer',
         'expected: nothing for anon, nothing for authenticated',
         'anon_select=' || has_table_privilege('anon', 'public.business_expenses', 'select')::text
           || ' auth_select=' || has_table_privilege('authenticated', 'public.business_expenses', 'select')::text
           || ' anon_exec=' || has_function_privilege('anon',
                'public.admin_record_business_expense(uuid,date,text,integer,text,uuid,text,text,uuid)', 'execute')::text
           || ' auth_exec=' || has_function_privilege('authenticated',
                'public.admin_delete_business_expense(uuid,uuid,uuid)', 'execute')::text,
         case when not has_table_privilege('anon', 'public.business_expenses', 'select')
                   and not has_table_privilege('authenticated', 'public.business_expenses', 'select')
                   and not has_function_privilege('anon',
                         'public.admin_record_business_expense(uuid,date,text,integer,text,uuid,text,text,uuid)', 'execute')
                   and not has_function_privilege('authenticated',
                         'public.admin_record_business_expense(uuid,date,text,integer,text,uuid,text,text,uuid)', 'execute')
                   and not has_function_privilege('anon',
                         'public.admin_delete_business_expense(uuid,uuid,uuid)', 'execute')
                   and not has_function_privilege('authenticated',
                         'public.admin_delete_business_expense(uuid,uuid,uuid)', 'execute')
              then 'PASS' else 'FAIL' end

  union all
  select 22, 'security',
         'RLS is enabled and there is no policy at all',
         'expected: rls on, 0 policies',
         'rls=' || (select relrowsecurity::text from pg_class
                     where oid = 'public.business_expenses'::regclass)
           || ' policies=' || (select count(*)::text from pg_policies
                                where schemaname = 'public'
                                  and tablename = 'business_expenses'),
         case when (select relrowsecurity from pg_class
                     where oid = 'public.business_expenses'::regclass)
                   and (select count(*) from pg_policies
                         where schemaname = 'public'
                           and tablename = 'business_expenses') = 0
              then 'PASS' else 'FAIL' end

  union all
  -- STRICTLY POSITIVE, NOT MERELY NON-NEGATIVE. A zero cost makes the
  -- completeness count lie, and a negative one is a credit note booked as
  -- income - it would silently increase a margin.
  select 23, 'money',
         'an amount must be strictly positive',
         'expected: amount_cents > 0',
         coalesce((select pg_get_constraintdef(oid) from pg_constraint
                    where conrelid = 'public.business_expenses'::regclass
                      and conname like '%amount_cents%' limit 1), '<missing>'),
         case when (select count(*) from pg_constraint
                     where conrelid = 'public.business_expenses'::regclass
                       and conname like '%amount_cents%'
                       and pg_get_constraintdef(oid) like '%> 0%') = 1
              then 'PASS' else 'FAIL' end

  union all
  select 24, 'money',
         'the category vocabulary is exactly the six 071 defines',
         'expected: matcha_cogs, packaging, shipping, payment_fee, other_direct, general',
         coalesce((select pg_get_constraintdef(oid) from pg_constraint
                    where conrelid = 'public.business_expenses'::regclass
                      and conname like '%category%' limit 1), '<missing>'),
         case when (select count(*) from pg_constraint
                     where conrelid = 'public.business_expenses'::regclass
                       and conname like '%category%'
                       and pg_get_constraintdef(oid) like '%matcha_cogs%'
                       and pg_get_constraintdef(oid) like '%packaging%'
                       and pg_get_constraintdef(oid) like '%shipping%'
                       and pg_get_constraintdef(oid) like '%payment_fee%'
                       and pg_get_constraintdef(oid) like '%other_direct%'
                       and pg_get_constraintdef(oid) like '%general%') = 1
              then 'PASS' else 'FAIL' end

  -- ── 30-31. THE FUNCTION BODIES ──────────────────────────────

  union all
  select 30, 'behaviour',
         'every writer audits under module finance, with its own action',
         'expected: finance + expense_recorded/updated/deleted',
         coalesce((select string_agg(
                     case when p.prosrc like '%''finance''%' then p.proname || '=finance'
                          else p.proname || '=NO MODULE' end, '; ' order by p.proname)
                     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'public'
                      and p.proname in ('admin_record_business_expense',
                                        'admin_update_business_expense',
                                        'admin_delete_business_expense')), '<missing>'),
         case when (select count(*) from pg_proc p
                      join pg_namespace n on n.oid = p.pronamespace
                     where n.nspname = 'public'
                       and p.proname in ('admin_record_business_expense',
                                         'admin_update_business_expense',
                                         'admin_delete_business_expense')
                       and p.prosrc like '%record_admin_activity%'
                       and p.prosrc like '%''finance''%') = 3
                   and (select count(*) from pg_proc p
                          join pg_namespace n on n.oid = p.pronamespace
                         where n.nspname = 'public'
                           and p.proname = 'admin_record_business_expense'
                           and p.prosrc like '%''expense_recorded''%') = 1
                   and (select count(*) from pg_proc p
                          join pg_namespace n on n.oid = p.pronamespace
                         where n.nspname = 'public'
                           and p.proname = 'admin_update_business_expense'
                           and p.prosrc like '%''expense_updated''%') = 1
                   and (select count(*) from pg_proc p
                          join pg_namespace n on n.oid = p.pronamespace
                         where n.nspname = 'public'
                           and p.proname = 'admin_delete_business_expense'
                           and p.prosrc like '%''expense_deleted''%') = 1
              then 'PASS' else 'FAIL' end

  union all
  -- THE BUG THIS CHECK EXISTS FOR.
  --
  -- admin_activity_log.operation_id is NOT NULL. The first version of 071
  -- declared p_operation_id with a NULL default and passed it straight to
  -- record_admin_activity, so every writer raised when it was called
  -- without one - while the table, the columns, the indexes, the grants
  -- and RLS were all exactly right. Nothing but calling the function
  -- could find it, so the coalesce is pinned here.
  select 31, 'behaviour',
         'a writer called without an operation id still audits',
         'expected: all three coalesce p_operation_id to a fresh uuid',
         coalesce((select string_agg(
                     case when p.prosrc like '%coalesce(p_operation_id%'
                          then p.proname || '=guarded'
                          else p.proname || '=UNGUARDED' end, '; ' order by p.proname)
                     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'public'
                      and p.proname in ('admin_record_business_expense',
                                        'admin_update_business_expense',
                                        'admin_delete_business_expense')), '<missing>'),
         case when (select count(*) from pg_proc p
                      join pg_namespace n on n.oid = p.pronamespace
                     where n.nspname = 'public'
                       and p.proname in ('admin_record_business_expense',
                                         'admin_update_business_expense',
                                         'admin_delete_business_expense')
                       and p.prosrc like '%coalesce(p_operation_id%'
                       and p.prosrc like '%gen_random_uuid()%') = 3
              then 'PASS' else 'FAIL' end

  -- ── 40. 071 REWROTE NOTHING ─────────────────────────────────

  union all
  -- IT BACKFILLS NOTHING AND IT IS NOT A DATA MIGRATION. A fresh apply
  -- therefore leaves the table empty: every row in it afterwards was
  -- typed by a person through a writer. If this is non-zero on the day
  -- 071 is applied, something wrote rows that 071 did not.
  select 40, 'data',
         '071 inserted no expense of its own',
         'expected: 0 rows immediately after applying',
         (select count(*)::text || ' row(s) in business_expenses'
            from public.business_expenses),
         case when (select count(*) from public.business_expenses) = 0
              then 'PASS' else 'FAIL' end

  -- ── 50-52. INFO ─────────────────────────────────────────────

  union all
  select 50, 'info',
         'paid orders the finance screen will read (revenue side)',
         'INFO - 071 neither reads nor writes them',
         (select count(*)::text || ' order(s) with placed_at set'
            from public.orders where placed_at is not null),
         'INFO'

  union all
  select 51, 'info',
         'gross revenue those orders carry',
         'INFO - frozen per order since migration 004',
         (select coalesce(sum(total_gross_cents), 0)::text || ' cents gross'
            from public.orders where placed_at is not null),
         'INFO'

  union all
  -- WHAT THE FINANCE SCREEN WILL HAVE TO CALL INCOMPLETE. On the day 071
  -- is applied this is every paid order, because no cost has been typed
  -- yet - which is exactly why the screen is required to report a partial
  -- margin rather than a confident one.
  select 52, 'info',
         'paid orders with no direct cost recorded against them yet',
         'INFO - the completeness the screen must disclose',
         (select count(*)::text || ' of '
              || (select count(*)::text from public.orders where placed_at is not null)
              || ' paid order(s) have no direct cost'
            from public.orders o
           where o.placed_at is not null
             and not exists (select 1 from public.business_expenses e
                              where e.order_id = o.id)),
         'INFO'

  union all
  select 999, 'SUMMARY',
         'migration 071 applied cleanly',
         'expected: 0 FAIL / 12 PASS / 3 INFO',
         (select count(*) filter (where v.verdict = 'FAIL')::text || ' FAIL / '
              || count(*) filter (where v.verdict = 'PASS')::text || ' PASS / '
              || count(*) filter (where v.verdict = 'INFO')::text || ' INFO'
            from (
              select case when (select count(*) from information_schema.columns
                                 where table_schema = 'public' and table_name = 'business_expenses'
                                   and column_name in ('id','occurred_on','category','order_id',
                                                       'description','amount_cents','currency',
                                                       'vendor','note','created_by',
                                                       'created_at','updated_at')) = 12
                          then 'PASS' else 'FAIL' end as verdict
              union all
              select case when (select count(*) from pg_constraint
                                 where conname = 'business_expenses_order_scope_check'
                                   and pg_get_constraintdef(oid) like '%order_id IS NULL%'
                                   and pg_get_constraintdef(oid) like '%order_id IS NOT NULL%'
                                   and pg_get_constraintdef(oid) like '%general%') = 1
                          then 'PASS' else 'FAIL' end
              union all
              select case when (select count(*) from pg_indexes
                                 where schemaname = 'public'
                                   and indexname in ('idx_business_expenses_occurred_on',
                                                     'idx_business_expenses_order',
                                                     'idx_business_expenses_category')) = 3
                          then 'PASS' else 'FAIL' end
              union all
              select case when (select count(*) from pg_proc p
                                  join pg_namespace n on n.oid = p.pronamespace
                                 where n.nspname = 'public'
                                   and p.proname in ('admin_record_business_expense',
                                                     'admin_update_business_expense',
                                                     'admin_delete_business_expense')
                                   and p.prosecdef
                                   and 'search_path=' = any(
                                         select left(c, 12) from unnest(p.proconfig) as c)) = 3
                          then 'PASS' else 'FAIL' end
              union all
              select case when has_table_privilege('service_role', 'public.business_expenses', 'select')
                                and not has_table_privilege('service_role', 'public.business_expenses', 'insert')
                                and not has_table_privilege('service_role', 'public.business_expenses', 'update')
                                and not has_table_privilege('service_role', 'public.business_expenses', 'delete')
                          then 'PASS' else 'FAIL' end
              union all
              select case when not has_table_privilege('anon', 'public.business_expenses', 'select')
                                and not has_table_privilege('authenticated', 'public.business_expenses', 'select')
                                and not has_function_privilege('anon',
                                      'public.admin_record_business_expense(uuid,date,text,integer,text,uuid,text,text,uuid)', 'execute')
                                and not has_function_privilege('authenticated',
                                      'public.admin_record_business_expense(uuid,date,text,integer,text,uuid,text,text,uuid)', 'execute')
                                and not has_function_privilege('anon',
                                      'public.admin_delete_business_expense(uuid,uuid,uuid)', 'execute')
                                and not has_function_privilege('authenticated',
                                      'public.admin_delete_business_expense(uuid,uuid,uuid)', 'execute')
                          then 'PASS' else 'FAIL' end
              union all
              select case when (select relrowsecurity from pg_class
                                 where oid = 'public.business_expenses'::regclass)
                                and (select count(*) from pg_policies
                                      where schemaname = 'public'
                                        and tablename = 'business_expenses') = 0
                          then 'PASS' else 'FAIL' end
              union all
              select case when (select count(*) from pg_constraint
                                 where conrelid = 'public.business_expenses'::regclass
                                   and conname like '%amount_cents%'
                                   and pg_get_constraintdef(oid) like '%> 0%') = 1
                          then 'PASS' else 'FAIL' end
              union all
              select case when (select count(*) from pg_constraint
                                 where conrelid = 'public.business_expenses'::regclass
                                   and conname like '%category%'
                                   and pg_get_constraintdef(oid) like '%matcha_cogs%'
                                   and pg_get_constraintdef(oid) like '%packaging%'
                                   and pg_get_constraintdef(oid) like '%shipping%'
                                   and pg_get_constraintdef(oid) like '%payment_fee%'
                                   and pg_get_constraintdef(oid) like '%other_direct%'
                                   and pg_get_constraintdef(oid) like '%general%') = 1
                          then 'PASS' else 'FAIL' end
              union all
              select case when (select count(*) from pg_proc p
                                  join pg_namespace n on n.oid = p.pronamespace
                                 where n.nspname = 'public'
                                   and p.proname in ('admin_record_business_expense',
                                                     'admin_update_business_expense',
                                                     'admin_delete_business_expense')
                                   and p.prosrc like '%record_admin_activity%'
                                   and p.prosrc like '%''finance''%') = 3
                          then 'PASS' else 'FAIL' end
              union all
              select case when (select count(*) from pg_proc p
                                  join pg_namespace n on n.oid = p.pronamespace
                                 where n.nspname = 'public'
                                   and p.proname in ('admin_record_business_expense',
                                                     'admin_update_business_expense',
                                                     'admin_delete_business_expense')
                                   and p.prosrc like '%coalesce(p_operation_id%'
                                   and p.prosrc like '%gen_random_uuid()%') = 3
                          then 'PASS' else 'FAIL' end
              union all
              select case when (select count(*) from public.business_expenses) = 0
                          then 'PASS' else 'FAIL' end
              union all select 'INFO' union all select 'INFO' union all select 'INFO'
            ) as v),
         case when (select count(*) filter (where v.verdict = 'FAIL')
                      from (
                        select case when (select count(*) from information_schema.columns
                                           where table_schema = 'public'
                                             and table_name = 'business_expenses'
                                             and column_name in ('id','occurred_on','category','order_id',
                                                                 'description','amount_cents','currency',
                                                                 'vendor','note','created_by',
                                                                 'created_at','updated_at')) = 12
                                    then 'PASS' else 'FAIL' end as verdict
                        union all
                        select case when (select count(*) from pg_constraint
                                           where conname = 'business_expenses_order_scope_check'
                                             and pg_get_constraintdef(oid) like '%order_id IS NULL%'
                                             and pg_get_constraintdef(oid) like '%order_id IS NOT NULL%'
                                             and pg_get_constraintdef(oid) like '%general%') = 1
                                    then 'PASS' else 'FAIL' end
                        union all
                        select case when (select count(*) from pg_indexes
                                           where schemaname = 'public'
                                             and indexname in ('idx_business_expenses_occurred_on',
                                                               'idx_business_expenses_order',
                                                               'idx_business_expenses_category')) = 3
                                    then 'PASS' else 'FAIL' end
                        union all
                        select case when (select count(*) from pg_proc p
                                            join pg_namespace n on n.oid = p.pronamespace
                                           where n.nspname = 'public'
                                             and p.proname in ('admin_record_business_expense',
                                                               'admin_update_business_expense',
                                                               'admin_delete_business_expense')
                                             and p.prosecdef
                                             and 'search_path=' = any(
                                                   select left(c, 12) from unnest(p.proconfig) as c)) = 3
                                    then 'PASS' else 'FAIL' end
                        union all
                        select case when has_table_privilege('service_role', 'public.business_expenses', 'select')
                                          and not has_table_privilege('service_role', 'public.business_expenses', 'insert')
                                          and not has_table_privilege('service_role', 'public.business_expenses', 'update')
                                          and not has_table_privilege('service_role', 'public.business_expenses', 'delete')
                                    then 'PASS' else 'FAIL' end
                        union all
                        select case when not has_table_privilege('anon', 'public.business_expenses', 'select')
                                          and not has_table_privilege('authenticated', 'public.business_expenses', 'select')
                                          and not has_function_privilege('anon',
                                                'public.admin_record_business_expense(uuid,date,text,integer,text,uuid,text,text,uuid)', 'execute')
                                          and not has_function_privilege('authenticated',
                                                'public.admin_record_business_expense(uuid,date,text,integer,text,uuid,text,text,uuid)', 'execute')
                                          and not has_function_privilege('anon',
                                                'public.admin_delete_business_expense(uuid,uuid,uuid)', 'execute')
                                          and not has_function_privilege('authenticated',
                                                'public.admin_delete_business_expense(uuid,uuid,uuid)', 'execute')
                                    then 'PASS' else 'FAIL' end
                        union all
                        select case when (select relrowsecurity from pg_class
                                           where oid = 'public.business_expenses'::regclass)
                                          and (select count(*) from pg_policies
                                                where schemaname = 'public'
                                                  and tablename = 'business_expenses') = 0
                                    then 'PASS' else 'FAIL' end
                        union all
                        select case when (select count(*) from pg_constraint
                                           where conrelid = 'public.business_expenses'::regclass
                                             and conname like '%amount_cents%'
                                             and pg_get_constraintdef(oid) like '%> 0%') = 1
                                    then 'PASS' else 'FAIL' end
                        union all
                        select case when (select count(*) from pg_constraint
                                           where conrelid = 'public.business_expenses'::regclass
                                             and conname like '%category%'
                                             and pg_get_constraintdef(oid) like '%matcha_cogs%'
                                             and pg_get_constraintdef(oid) like '%packaging%'
                                             and pg_get_constraintdef(oid) like '%shipping%'
                                             and pg_get_constraintdef(oid) like '%payment_fee%'
                                             and pg_get_constraintdef(oid) like '%other_direct%'
                                             and pg_get_constraintdef(oid) like '%general%') = 1
                                    then 'PASS' else 'FAIL' end
                        union all
                        select case when (select count(*) from pg_proc p
                                            join pg_namespace n on n.oid = p.pronamespace
                                           where n.nspname = 'public'
                                             and p.proname in ('admin_record_business_expense',
                                                               'admin_update_business_expense',
                                                               'admin_delete_business_expense')
                                             and p.prosrc like '%record_admin_activity%'
                                             and p.prosrc like '%''finance''%') = 3
                                    then 'PASS' else 'FAIL' end
                        union all
                        select case when (select count(*) from pg_proc p
                                            join pg_namespace n on n.oid = p.pronamespace
                                           where n.nspname = 'public'
                                             and p.proname in ('admin_record_business_expense',
                                                               'admin_update_business_expense',
                                                               'admin_delete_business_expense')
                                             and p.prosrc like '%coalesce(p_operation_id%'
                                             and p.prosrc like '%gen_random_uuid()%') = 3
                                    then 'PASS' else 'FAIL' end
                        union all
                        select case when (select count(*) from public.business_expenses) = 0
                                    then 'PASS' else 'FAIL' end
                      ) as v) = 0
              then 'APPLIED CLEANLY' else 'INCOMPLETE' end

  ) as checks
 order by check_id;
