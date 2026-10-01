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
-- Checks 10-26 are shape and vocabulary: the table, its fifteen columns,
-- the two named constraints, the four indexes, the grants, RLS, and the
-- three closed vocabularies. A schema comparison would find those.
--
-- 30-33 READ THE FUNCTION BODIES, and they are the only checks here that
-- could tell a correct 071 from a broken one that looks identical:
--
--   30  the writers audit under module 'finance', each with its own
--       action
--
--   31  the writers COALESCE the operation id. Not hypothetical:
--       admin_activity_log.operation_id is NOT NULL, the first version of
--       071 passed the parameter through unguarded, and every writer
--       raised the moment it was called without one. The table, the
--       columns, the indexes and the grants were all perfect.
--
--   32  THE CHANNEL OF AN ORDER-LINKED COST IS DERIVED FROM THE ORDER,
--       in both writing functions. This is the one rule that a caller
--       could otherwise defeat: if either writer ever took p_channel at
--       face value for a row carrying an order_id, a B2C cost could be
--       filed under B2B from a browser and every channel report would be
--       quietly wrong. The schema cannot express it, so it is checked
--       where it lives.
--
--   33  the audit payloads carry the new fields on both sides, so a
--       corrected or deleted figure can still be reconstructed.
--
-- 14 is the gross/VAT semantics, and it is the check that exists because
-- of the one defect in 071 that could not have been repaired after the
-- fact: an amount column that does not say whether it is gross or net.
--
-- 40 is the one that matters for a Production apply: 071 must have
-- rewritten NO existing row. It is additive, it backfills nothing, and a
-- fresh apply therefore leaves business_expenses empty.
--
-- EXPECTED HEALTHY RESULT:  0 FAIL / 17 PASS / 3 INFO — APPLIED CLEANLY
--
-- Seventeen verdict-bearing checks (10-14, 20-26, 30-33, 40) and three
-- INFO rows (50-52), plus the SUMMARY row, which counts only the twenty
-- above it. The SUMMARY is always computed from the actual rows; this
-- line is the expectation to compare it against, never the source of it.
-- Verified: a fresh apply of 001..071 to a real PostgreSQL 17 instance
-- returns exactly 0 FAIL / 17 PASS / 3 INFO.
--
-- ── RUN IT AFTER 071, NOT BEFORE ──────────────────────────────
--
-- Against a database where 071 has NOT been applied this does not report
-- failures - it ERRORS, on 'public.business_expenses'::regclass, because
-- the relation does not exist. That is deliberate and it is the right
-- behaviour: a postcheck that answered "INCOMPLETE" there would look like
-- a verdict about a migration that was never run. The preflight is the
-- file for that question, and it also reports WHICH draft it found.

with
/* The fifteen columns 071 promises, as data rather than as prose. */
expected_columns(name) as (
  values ('id'), ('occurred_on'), ('category'), ('order_id'), ('description'),
         ('gross_cents'), ('vat_cents'), ('currency'), ('channel'),
         ('payment_status'), ('vendor'), ('note'),
         ('created_by'), ('created_at'), ('updated_at')
),
expected_indexes(name) as (
  values ('idx_business_expenses_occurred_on'), ('idx_business_expenses_order'),
         ('idx_business_expenses_category'), ('idx_business_expenses_channel')
),
writers(name, action) as (
  values ('admin_record_business_expense', 'expense_recorded'),
         ('admin_update_business_expense', 'expense_updated'),
         ('admin_delete_business_expense', 'expense_deleted')
),
fn as (
  select p.proname, p.prosrc, p.prosecdef, p.proconfig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in (select name from writers)
),
con as (
  select conname, pg_get_constraintdef(oid) as def
    from pg_constraint
   where conrelid = 'public.business_expenses'::regclass
),
verdicts(check_id, area, question, expectation, found, verdict) as (

  /* ── 10-14. SHAPE AND SEMANTICS ─────────────────────────── */

  select 10, 'shape',
         'all fifteen business_expenses columns are present',
         'expected: 15 of 15',
         (select count(*)::text || ' of 15'
            from information_schema.columns c
           where c.table_schema = 'public' and c.table_name = 'business_expenses'
             and c.column_name in (select name from expected_columns)),
         case when (select count(*) from information_schema.columns c
                     where c.table_schema = 'public' and c.table_name = 'business_expenses'
                       and c.column_name in (select name from expected_columns)) = 15
              then 'PASS' else 'FAIL' end

  union all
  -- THE CONSTRAINT THAT KEEPS THE TWO KINDS OF COST APART. A direct cost
  -- with no order would count against the period while belonging to no
  -- order, so the breakdown and the total would disagree.
  select 11, 'shape',
         'the order-scope constraint exists and names both halves',
         'expected: general has no order, and a direct category has one',
         coalesce((select def from con
                    where conname = 'business_expenses_order_scope_check'), '<missing>'),
         case when (select count(*) from con
                     where conname = 'business_expenses_order_scope_check'
                       and def like '%order_id IS NULL%'
                       and def like '%order_id IS NOT NULL%'
                       and def like '%general%') = 1
              then 'PASS' else 'FAIL' end

  union all
  select 12, 'shape',
         'all four indexes are present',
         'expected: occurred_on, order (partial), category, channel',
         (select coalesce(string_agg(i.indexname, ', ' order by i.indexname), 'none')
            from pg_indexes i
           where i.schemaname = 'public'
             and i.indexname in (select name from expected_indexes)),
         case when (select count(*) from pg_indexes i
                     where i.schemaname = 'public'
                       and i.indexname in (select name from expected_indexes)) = 4
              then 'PASS' else 'FAIL' end

  union all
  select 13, 'shape',
         'the three writers exist, SECURITY DEFINER, with an empty search_path',
         'expected: 3 of 3, all prosecdef, all search_path=""',
         (select coalesce(string_agg(f.proname || '(' ||
                   case when f.prosecdef then 'definer' else 'INVOKER' end || ', ' ||
                   coalesce(array_to_string(f.proconfig, ' '), 'NO search_path') || ')',
                   '; ' order by f.proname), 'none') from fn f),
         case when (select count(*) from fn f
                     where f.prosecdef
                       and 'search_path=' = any(
                             select left(c, 12) from unnest(f.proconfig) as c)) = 3
              then 'PASS' else 'FAIL' end

  union all
  /*
    THE GROSS / VAT SEMANTICS. The reason this check exists:

    An earlier draft called the amount column amount_cents and said
    nothing about gross or net. The contribution margin subtracts it from
    GROSS revenue, so a net figure typed into it would have overstated the
    margin by the VAT - permanently, invisibly, and unrepairably, because
    what an already-entered number MEANT cannot be recovered.

    Three things have to hold. The amount is named gross. The ambiguous
    name is gone rather than merely unused. And vat_cents is NULLABLE,
    because "not known" has to stay distinguishable from a known zero
    forever - a VAT overview built by reading null as zero would be a
    confident report of a figure nobody has.
  */
  select 14, 'money',
         'the amount is gross, the ambiguous name is gone, and VAT may be unknown',
         'expected: gross_cents present; amount_cents absent; vat_cents nullable; bounds constraint',
         (select 'gross_cents=' || (count(*) filter (where c.column_name = 'gross_cents'))::text
              || ' amount_cents=' || (count(*) filter (where c.column_name = 'amount_cents'))::text
              || ' vat_nullable=' || coalesce(max(c.is_nullable) filter (where c.column_name = 'vat_cents'), '<missing>')
            from information_schema.columns c
           where c.table_schema = 'public' and c.table_name = 'business_expenses')
           || ' bounds=' || (select count(*)::text from con
                              where conname = 'business_expenses_vat_bounds_check'),
         case when (select count(*) from information_schema.columns c
                     where c.table_schema = 'public' and c.table_name = 'business_expenses'
                       and c.column_name = 'gross_cents') = 1
                   and (select count(*) from information_schema.columns c
                         where c.table_schema = 'public' and c.table_name = 'business_expenses'
                           and c.column_name = 'amount_cents') = 0
                   and (select c.is_nullable from information_schema.columns c
                         where c.table_schema = 'public' and c.table_name = 'business_expenses'
                           and c.column_name = 'vat_cents') = 'YES'
                   and (select count(*) from con
                         where conname = 'business_expenses_vat_bounds_check'
                           and def like '%vat_cents%'
                           and def like '%gross_cents%') = 1
              then 'PASS' else 'FAIL' end

  /* ── 20-26. SECURITY, MONEY RULES AND VOCABULARIES ──────── */

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
                'public.admin_record_business_expense(uuid,date,text,integer,text,text,text,integer,uuid,text,text,uuid)', 'execute')::text
           || ' auth_exec=' || has_function_privilege('authenticated',
                'public.admin_delete_business_expense(uuid,uuid,uuid)', 'execute')::text,
         case when not has_table_privilege('anon', 'public.business_expenses', 'select')
                   and not has_table_privilege('authenticated', 'public.business_expenses', 'select')
                   and not has_function_privilege('anon',
                         'public.admin_record_business_expense(uuid,date,text,integer,text,text,text,integer,uuid,text,text,uuid)', 'execute')
                   and not has_function_privilege('authenticated',
                         'public.admin_record_business_expense(uuid,date,text,integer,text,text,text,integer,uuid,text,text,uuid)', 'execute')
                   and not has_function_privilege('anon',
                         'public.admin_update_business_expense(uuid,uuid,date,text,integer,text,text,text,integer,uuid,text,text,uuid)', 'execute')
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
         'a gross amount must be strictly positive',
         'expected: gross_cents > 0',
         coalesce((select def from con where conname like '%gross_cents%'), '<missing>'),
         case when (select count(*) from con
                     where conname like '%gross_cents%' and def like '%> 0%') = 1
              then 'PASS' else 'FAIL' end

  union all
  select 24, 'vocabulary',
         'the category vocabulary is exactly the six 071 defines',
         'expected: matcha_cogs, packaging, shipping, payment_fee, other_direct, general',
         coalesce((select def from con where conname like '%category%'), '<missing>'),
         case when (select count(*) from con
                     where conname like '%category%'
                       and def like '%matcha_cogs%' and def like '%packaging%'
                       and def like '%shipping%' and def like '%payment_fee%'
                       and def like '%other_direct%' and def like '%general%') = 1
              then 'PASS' else 'FAIL' end

  union all
  /*
    THE CHANNEL VOCABULARY IS MIGRATION 050's, EXACTLY.

    050 settled these four for inventory areas and said why: "Four fixed
    values, because these are GLOA's sales channels and not a taxonomy the
    operator maintains." A second spelling of the same four things - a
    'general' where 050 says 'internal' - would mean two answers to "which
    channel" and a report that silently drops rows.
  */
  select 25, 'vocabulary',
         'the channel vocabulary is migration 050s four, and no synonym',
         'expected: b2c, b2b, event, internal - and NOT general',
         coalesce((select def from con where conname like '%channel%'), '<missing>'),
         case when (select count(*) from con
                     where conname like '%channel%'
                       and def like '%b2c%' and def like '%b2b%'
                       and def like '%event%' and def like '%internal%'
                       and def not like '%general%') = 1
              then 'PASS' else 'FAIL' end

  union all
  -- TWO VALUES, AND NO ACCOUNTING. No partial, no overdue, no cancelled:
  -- there is no fact in this schema that could support any of them.
  select 26, 'vocabulary',
         'the payment status vocabulary is exactly open/paid',
         'expected: open, paid - and nothing else',
         coalesce((select def from con where conname like '%payment_status%'), '<missing>'),
         case when (select count(*) from con
                     where conname like '%payment_status%'
                       and def like '%open%' and def like '%paid%'
                       and def not like '%partial%' and def not like '%overdue%'
                       and def not like '%cancelled%') = 1
              then 'PASS' else 'FAIL' end

  /* ── 30-33. THE FUNCTION BODIES ─────────────────────────── */

  union all
  select 30, 'behaviour',
         'every writer audits under module finance, with its own action',
         'expected: finance + expense_recorded/updated/deleted',
         coalesce((select string_agg(
                     case when f.prosrc like '%''finance''%' then f.proname || '=finance'
                          else f.proname || '=NO MODULE' end, '; ' order by f.proname)
                     from fn f), '<missing>'),
         case when (select count(*) from fn f
                     where f.prosrc like '%record_admin_activity%'
                       and f.prosrc like '%''finance''%') = 3
                   and (select count(*) from fn f join writers w on w.name = f.proname
                         where f.prosrc like '%''' || w.action || '''%') = 3
              then 'PASS' else 'FAIL' end

  union all
  -- THE BUG THIS CHECK EXISTS FOR. admin_activity_log.operation_id is NOT
  -- NULL; the first version of 071 passed the parameter through unguarded
  -- and every writer raised when it was omitted, while the table, the
  -- columns, the indexes, the grants and RLS were all exactly right.
  select 31, 'behaviour',
         'a writer called without an operation id still audits',
         'expected: all three coalesce p_operation_id to a fresh uuid',
         coalesce((select string_agg(
                     case when f.prosrc like '%coalesce(p_operation_id%'
                          then f.proname || '=guarded'
                          else f.proname || '=UNGUARDED' end, '; ' order by f.proname)
                     from fn f), '<missing>'),
         case when (select count(*) from fn f
                     where f.prosrc like '%coalesce(p_operation_id%'
                       and f.prosrc like '%gen_random_uuid()%') = 3
              then 'PASS' else 'FAIL' end

  union all
  /*
    THE CHANNEL OF AN ORDER-LINKED COST IS THE ORDER'S.

    The rule a caller could otherwise defeat, and the schema cannot
    express it: both WRITING functions must read orders.customer_type for
    a row that carries an order_id and derive the channel from it, rather
    than inserting whatever p_channel arrived. If either ever took the
    parameter at face value, a B2C cost could be filed under B2B from a
    browser and every channel report would be quietly wrong.

    Checked as three facts in each body: it reads customer_type from
    public.orders, it maps 'business' to b2b, and what it inserts is the
    derived local variable rather than the parameter.
  */
  select 32, 'behaviour',
         'both writing functions DERIVE the channel of an order-linked cost',
         'expected: both read orders.customer_type and insert the derived value',
         coalesce((select string_agg(
                     case when f.prosrc like '%customer_type%'
                           and f.prosrc like '%v_channel%'
                          then f.proname || '=derived'
                          else f.proname || '=TRUSTS CALLER' end, '; ' order by f.proname)
                     from fn f where f.proname <> 'admin_delete_business_expense'), '<missing>'),
         case when (select count(*) from fn f
                     where f.proname in ('admin_record_business_expense',
                                         'admin_update_business_expense')
                       and f.prosrc like '%from public.orders%'
                       and f.prosrc like '%customer_type%'
                       and f.prosrc like '%''business'' then ''b2b''%'
                       and f.prosrc like '%v_channel%') = 2
              then 'PASS' else 'FAIL' end

  union all
  -- A CORRECTED OR DELETED FIGURE MUST STILL BE RECONSTRUCTABLE. The
  -- update writer carries every changeable field on BOTH sides; the
  -- delete writer carries every final value, because the row is about to
  -- stop existing and that object becomes the only record it was there.
  select 33, 'behaviour',
         'the audit payloads carry gross, VAT, channel and payment status',
         'expected: update has before+after; delete has the final values',
         coalesce((select string_agg(
                     case when f.prosrc like '%''grossCents''%'
                           and f.prosrc like '%''vatCents''%'
                           and f.prosrc like '%''channel''%'
                           and f.prosrc like '%''paymentStatus''%'
                          then f.proname || '=complete'
                          else f.proname || '=INCOMPLETE' end, '; ' order by f.proname)
                     from fn f), '<missing>'),
         case when (select count(*) from fn f
                     where f.prosrc like '%''grossCents''%'
                       and f.prosrc like '%''vatCents''%'
                       and f.prosrc like '%''channel''%'
                       and f.prosrc like '%''paymentStatus''%') = 3
                   and (select count(*) from fn f
                         where f.proname = 'admin_update_business_expense'
                           and f.prosrc like '%''before''%'
                           and f.prosrc like '%''after''%') = 1
                   and (select count(*) from fn f
                         where f.proname = 'admin_delete_business_expense'
                           and f.prosrc like '%''recordedBy''%') = 1
              then 'PASS' else 'FAIL' end

  /* ── 40. 071 REWROTE NOTHING ────────────────────────────── */

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
),
infos(check_id, area, question, expectation, found, verdict) as (
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
)
select * from (
  select check_id, area, question, expectation, found, verdict from verdicts
  union all
  select check_id, area, question, expectation, found, verdict from infos
  union all
  select 999, 'SUMMARY',
         'migration 071 applied cleanly',
         'expected: 0 FAIL / 17 PASS / 3 INFO',
         (select count(*) filter (where v.verdict = 'FAIL')::text || ' FAIL / '
              || count(*) filter (where v.verdict = 'PASS')::text || ' PASS / '
              || (select count(*) from infos)::text || ' INFO'
            from verdicts v),
         case when (select count(*) filter (where v.verdict = 'FAIL') from verdicts v) = 0
                   and (select count(*) from verdicts) = 17
              then 'APPLIED CLEANLY' else 'INCOMPLETE' end
) as checks
 order by check_id;
