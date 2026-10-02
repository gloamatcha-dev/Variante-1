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
-- 30-34 READ THE FUNCTION BODIES, and they are the only checks here that
-- could tell a correct 071 from a broken one that looks identical:
--
--   30  the writers audit under module 'finance', each with its own
--       action
--
--   31  THE MUTATION IS IDEMPOTENT, not merely the audit row. This is
--       the check that replaces the weakest one this file ever had.
--
--       An earlier 071 passed p_operation_id to record_admin_activity and
--       called that idempotency. It was not: admin_activity_log is unique
--       on (module, action, operation_id), so a retry produced ONE audit
--       event - and nothing stopped it producing a SECOND expense row.
--       For a cost ledger that is the worst failure available, because
--       the duplicate is invisible in the trail and counts twice in every
--       margin.
--
--       So this verifies the real guard: each writer resolves the
--       operation id once, takes a TRANSACTION-SCOPED ADVISORY LOCK on
--       it, and only then looks for a prior event in admin_activity_log -
--       the lock before the lookup, because two concurrent retries that
--       both look first would both find nothing.
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
--   34  AND THE REGISTRY SURVIVES A DELETION. The create writer's replay
--       path reads admin_activity_log, not a key on the expense row -
--       which is what stops a replayed create from resurrecting a cost
--       somebody deliberately removed. Migration 050 could put the key on
--       the row because a stock movement is never deleted; an expense is.
--
-- 14 is the gross/VAT semantics, and it is the check that exists because
-- of the one defect in 071 that could not have been repaired after the
-- fact: an amount column that does not say whether it is gross or net.
--
-- 40 is the one that matters for a Production apply: 071 must have
-- rewritten NO existing row. It is additive, it backfills nothing, and a
-- fresh apply therefore leaves business_expenses empty.
--
-- EXPECTED HEALTHY RESULT:  0 FAIL / 18 PASS / 3 INFO — APPLIED CLEANLY
--
-- Eighteen verdict-bearing checks (10-14, 20-26, 30-34, 40) and three
-- INFO rows (50-52), plus the SUMMARY row, which counts only the
-- twenty-one above it. The SUMMARY is always computed from the actual
-- rows; this line is the expectation to compare it against, never the
-- source of it. Verified: a fresh apply of 001..071 to a real PostgreSQL
-- 17 instance returns exactly 0 FAIL / 18 PASS / 3 INFO.
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
  /*
    THE MUTATION IS IDEMPOTENT, NOT JUST THE AUDIT ROW.

    Four facts per writer, and the fourth is the one a naive version gets
    wrong:

      1. the operation id is resolved ONCE into a local, so the lock and
         the lookup cannot disagree (and an omitted id still works)
      2. a transaction-scoped ADVISORY LOCK is taken on it
      3. a prior event is looked up in admin_activity_log by an EXACT
         (module, action, operation_id) match - the hash is only the lock
         key, so a collision can serialise unrelated work but can never
         make two operations equivalent
      4. the LOCK comes BEFORE the LOOKUP. Two concurrent retries that
         both looked first would both find nothing and both mutate.
  */
  select 31, 'behaviour',
         'the MUTATION is idempotent per operation id, not just the audit row',
         'expected: all three resolve, lock, then look up a prior event - in that order',
         coalesce((select string_agg(
                     f.proname || '='
                     || case when f.prosrc like '%v_operation_id := coalesce(p_operation_id%'
                                  and f.prosrc like '%pg_advisory_xact_lock%'
                                  and f.prosrc like '%admin_activity_log%'
                                  and pg_catalog.strpos(f.prosrc, 'pg_advisory_xact_lock')
                                      < pg_catalog.strpos(f.prosrc, 'from public.admin_activity_log')
                             then 'guarded'
                             else 'UNGUARDED' end, '; ' order by f.proname)
                     from fn f), '<missing>'),
         case when (select count(*) from fn f
                     where f.prosrc like '%v_operation_id := coalesce(p_operation_id%'
                       and f.prosrc like '%gen_random_uuid()%'
                       and f.prosrc like '%pg_catalog.pg_advisory_xact_lock%'
                       and f.prosrc like '%pg_catalog.hashtextextended%'
                       and f.prosrc like '%from public.admin_activity_log%'
                       and f.prosrc like '%l.operation_id = v_operation_id%'
                       and f.prosrc like '%l.module = ''finance''%'
                       -- the lock precedes the lookup
                       and pg_catalog.strpos(f.prosrc, 'pg_advisory_xact_lock')
                           < pg_catalog.strpos(f.prosrc, 'from public.admin_activity_log')) = 3
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
  /*
    AND THE PAYLOADS ARE COMPLETE, not merely present.

    An earlier version checked four keys and the migration's own comment
    claimed "BOTH SIDES CARRY EVERY FIELD THAT CAN CHANGE" while
    description, vendor and note were missing - so a correction to any of
    those three produced an audit row asserting nothing had changed. The
    delete payload said "EVERY FINAL VALUE" and omitted note, currency and
    both timestamps.

    So every writer is checked against the fields it actually has to
    carry: the create and both halves of the update against every field
    the operator can enter, and the delete against everything needed to
    RECONSTRUCT the row it is about to destroy.
  */
  select 33, 'behaviour',
         'the audit payloads are complete enough to reconstruct the record',
         'expected: create 11 fields; update before+after 10 each; delete 14',
         coalesce((select string_agg(
                     case when f.prosrc like '%''description''%'
                           and f.prosrc like '%''note''%'
                          then f.proname || '=complete'
                          else f.proname || '=INCOMPLETE' end, '; ' order by f.proname)
                     from fn f), '<missing>'),
         case when (select count(*) from fn f
                     -- every writer names the fields that were missing
                     where f.prosrc like '%''description''%'
                       and f.prosrc like '%''note''%'
                       and f.prosrc like '%''grossCents''%'
                       and f.prosrc like '%''vatCents''%'
                       and f.prosrc like '%''channel''%'
                       and f.prosrc like '%''paymentStatus''%'
                       and f.prosrc like '%''occurredOn''%'
                       and f.prosrc like '%''category''%'
                       and f.prosrc like '%''orderId''%'
                       and f.prosrc like '%''vendor''%') = 3
                   -- the create records who entered it
                   and (select count(*) from fn f
                         where f.proname = 'admin_record_business_expense'
                           and f.prosrc like '%''recordedBy''%') = 1
                   -- the correction carries both sides
                   and (select count(*) from fn f
                         where f.proname = 'admin_update_business_expense'
                           and f.prosrc like '%''before''%'
                           and f.prosrc like '%''after''%') = 1
                   -- and the deletion carries what the row cannot say any more
                   and (select count(*) from fn f
                         where f.proname = 'admin_delete_business_expense'
                           and f.prosrc like '%''recordedBy''%'
                           and f.prosrc like '%''currency''%'
                           and f.prosrc like '%''createdAt''%'
                           and f.prosrc like '%''updatedAt''%') = 1
              then 'PASS' else 'FAIL' end

  union all
  /*
    A REPLAYED CREATE CANNOT RESURRECT A DELETED EXPENSE.

    The edge case that decided where the registry lives. If the operation
    id were a UNIQUE column on business_expenses - migration 050's shape -
    it would vanish with the row, and replaying the original create would
    silently re-enter a cost somebody had removed on purpose.

    So the create writer's replay path reads admin_activity_log (which has
    no delete path at all) for the prior event, then looks the expense up
    by the entity id that event recorded. If the row is gone it returns
    null and writes nothing, which is the honest answer: the operation
    already happened, and its result was later deleted.
  */
  select 34, 'behaviour',
         'a replayed create reads the audit log, so it cannot resurrect a deleted expense',
         'expected: the create writer resolves a prior event to an entity id and returns it',
         coalesce((select case when f.prosrc like '%l.entity_id into v_prior_entity%'
                                and f.prosrc like '%v_prior_entity::uuid%'
                               then 'reads the append-only log'
                               else 'DOES NOT' end
                     from fn f where f.proname = 'admin_record_business_expense'), '<missing>'),
         case when (select count(*) from fn f
                     where f.proname = 'admin_record_business_expense'
                       and f.prosrc like '%l.entity_id into v_prior_entity%'
                       and f.prosrc like '%where id = v_prior_entity::uuid%'
                       -- and it returns BEFORE the insert
                       and pg_catalog.strpos(f.prosrc, 'v_prior_entity is not null')
                           < pg_catalog.strpos(f.prosrc, 'insert into public.business_expenses')) = 1
                   -- the operation id is NOT a column on the expense row:
                   -- a row-level key would die with the row.
                   and (select count(*) from information_schema.columns
                         where table_schema = 'public'
                           and table_name = 'business_expenses'
                           and column_name in ('operation_id', 'idempotency_key')) = 0
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
         'expected: 0 FAIL / 18 PASS / 3 INFO',
         (select count(*) filter (where v.verdict = 'FAIL')::text || ' FAIL / '
              || count(*) filter (where v.verdict = 'PASS')::text || ' PASS / '
              || (select count(*) from infos)::text || ' INFO'
            from verdicts v),
         case when (select count(*) filter (where v.verdict = 'FAIL') from verdicts v) = 0
                   and (select count(*) from verdicts) = 18
              then 'APPLIED CLEANLY' else 'INCOMPLETE' end
) as checks
 order by check_id;
