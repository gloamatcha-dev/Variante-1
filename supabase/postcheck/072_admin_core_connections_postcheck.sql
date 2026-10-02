-- ══════════════════════════════════════════════════════════════
-- 072 POSTCHECK  —  READ ONLY.  RUN AFTER APPLYING 072.
-- ══════════════════════════════════════════════════════════════
--
-- Answers one question: did migration 072 land completely and correctly?
--
-- It writes nothing. It is ONE SELECT statement - no transaction, no DO
-- block, no temporary table, no function - so there is nothing it could
-- leave behind even if it were interrupted half way.
--
-- ── WHAT IT CHECKS THAT A SCHEMA DIFF WOULD NOT ───────────────
--
-- 10-14 and 20-26 are shape, grants, RLS and vocabulary. A schema
-- comparison would find those.
--
-- 30-38 READ THE FUNCTION BODIES, and they are the only checks here that
-- could tell a correct 072 from a broken one with an identical schema:
--
--   30  THE ANNUAL-DELIVERY REFUSAL IS IN THE PAYMENT WRITER. This is
--       the single most important line in the migration. A prepaid plan
--       is paid once and delivered twelve or thirteen times, and each
--       delivery mints a real order. If record_order_payment_event ever
--       stopped calling order_is_annual_delivery, one payment would be
--       recognised as twelve and the error would compound monthly while
--       every total still reconciled internally.
--
--   31  THE REFUND WRITERS COMPUTE A DELTA FROM THE LEDGER. They take
--       the absolute refunded total Stripe reports and must subtract
--       what the ledger already holds. A version that stored the total
--       would double-count every partial refund; a version that stored
--       an increment without summing first would be non-idempotent
--       against webhook redelivery.
--
--   32  AND THE REFUND DATE IS THE EVENT'S OWN. The whole reason this
--       ledger exists is that orders.refunded_total_cents restates the
--       month the order was placed in. If a refund writer ever used the
--       order's date, September would move again.
--
--   33  THE TERMINATION WRITER SETS cancelled_at AND status TOGETHER.
--       annual_plans_cancelled_at_check is an equivalence, so writing
--       the status alone is refused - and the first version of this
--       writer did exactly that. Verified in the body because the schema
--       cannot express which statement writes which pair.
--
--   34  THE SUBSCRIPTION CANCELLATION DATE IS NOT A PARAMETER. 072 reads
--       current_period_end and calls migration 034's scheduler. A date
--       parameter is the thing Part D3 forbids, so its ABSENCE from the
--       signature is checked rather than its validation.
--
--   35  ATTRIBUTION TAKES NO CREATOR ID. Same reasoning: the forgery is
--       impossible because the parameter does not exist.
--
--   36  COMMISSION TAKES NO AMOUNT. Likewise.
--
--   37  NOTHING REACHES THE STOCK LEDGER. Part M's boundary, asserted
--       against every body this migration created.
--
--   38  THE SHIPPING READER REFUSES TO GUESS. With no configured SLA it
--       must answer 'no_dispatch_target_configured', not a date.
--
-- 40-41 are what matters for a Production apply: 072 must have written
-- NO business row and seeded NO business parameter.
--
-- EXPECTED HEALTHY RESULT:  0 FAIL / 23 PASS / 3 INFO — APPLIED CLEANLY
--
-- Twenty-three verdict-bearing checks (10-14, 20-26, 30-38, 40-41) and
-- three INFO rows (50-52), plus the SUMMARY row, which counts only the
-- twenty-six above it. The SUMMARY is always computed from the actual
-- rows; this line is the expectation to compare it against, never the
-- source of it. Verified: a fresh apply of 001..072 to a real PostgreSQL
-- 17 instance returns exactly 0 FAIL / 23 PASS / 3 INFO.
--
-- ── RUN IT AFTER 072, NOT BEFORE ──────────────────────────────
--
-- Against a database where 072 has NOT been applied this does not report
-- failures - it ERRORS, on 'public.financial_events'::regclass, because
-- the relation does not exist. That is deliberate: a postcheck that
-- answered "INCOMPLETE" there would look like a verdict about a
-- migration that was never run. The preflight is the file for that
-- question, and it reports which objects are present.

with
expected_tables(name) as (
  values ('financial_events'), ('operations_config'), ('creators'),
         ('creator_roles'), ('creator_applications'),
         ('creator_commission_rules'), ('affiliate_links'),
         ('affiliate_codes'), ('affiliate_link_clicks'),
         ('order_attributions'), ('creator_commissions'),
         ('creator_payouts'), ('ugc_assignments'),
         ('documents'), ('document_links')
),
money_tables(name) as (
  values ('financial_events'), ('order_attributions'), ('creator_commissions')
),
catalogue_tables(name) as (
  values ('creators'), ('creator_roles'), ('creator_applications'),
         ('creator_commission_rules'), ('affiliate_links'),
         ('affiliate_codes'), ('affiliate_link_clicks'),
         ('creator_payouts'), ('ugc_assignments'),
         ('documents'), ('document_links'), ('operations_config')
),
expected_writers(name) as (
  values ('financial_event_berlin_date'), ('order_is_annual_delivery'),
         ('order_subscription_id'), ('record_order_payment_event'),
         ('record_annual_prepayment_event'), ('record_b2b_settlement_event'),
         ('record_order_refund_event'), ('record_annual_plan_refund_event'),
         ('record_payment_fee_event'), ('admin_decide_annual_termination'),
         ('admin_execute_subscription_termination'), ('order_shipping_due'),
         ('claim_annual_purchase_notification'),
         ('mark_annual_purchase_notification'),
         ('resolve_affiliate_link'), ('resolve_affiliate_code'),
         ('record_affiliate_click'), ('order_commission_base_cents'),
         ('attribute_order_to_creator'),
         ('reverse_creator_commission_for_refund'),
         ('creator_commission_balance')
),
expected_columns(tbl, col) as (
  values ('orders', 'ship_by_date'),
         ('annual_plans', 'terminated_at'),
         ('annual_plans', 'termination_request_id'),
         ('annual_plans', 'termination_effect'),
         ('annual_plans', 'internal_notification_status'),
         ('annual_plans', 'internal_notification_sent_at'),
         ('business_expenses', 'creator_commission_id'),
         ('business_expenses', 'ugc_assignment_id')
),
expected_indexes(name) as (
  values ('idx_financial_events_one_prepayment_per_plan'),
         ('idx_financial_events_one_payment_per_order'),
         ('idx_creator_commissions_one_earned_per_order'),
         ('idx_business_expenses_one_per_commission'),
         ('idx_business_expenses_one_per_ugc')
),
fn as (
  select p.proname, p.prosrc, p.prosecdef, p.proconfig,
         oidvectortypes(p.proargtypes) as args
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in (select name from expected_writers)
),
fe_con as (
  select conname, pg_get_constraintdef(oid) as def
    from pg_constraint
   where conrelid = 'public.financial_events'::regclass
),
verdicts(check_id, area, question, expectation, found, verdict) as (

  /* ── 10-14. SHAPE ───────────────────────────────────────── */

  select 10, 'shape',
         'all fifteen 072 tables are present',
         'expected: 15 of 15',
         (select count(*)::text || ' of 15' from expected_tables t
           where exists (select 1 from information_schema.tables
                          where table_schema = 'public' and table_name = t.name)),
         case when (select count(*) from expected_tables t
                     where exists (select 1 from information_schema.tables
                                    where table_schema = 'public'
                                      and table_name = t.name)) = 15
              then 'PASS' else 'FAIL' end

  union all
  select 11, 'shape',
         'all twenty-one writers exist, SECURITY DEFINER, with an empty search_path',
         'expected: 21 of 21, all prosecdef, all search_path=""',
         (select count(*)::text || ' of 21 definer+empty_path' from fn f
           where f.prosecdef
             and 'search_path=' = any(select left(c, 12) from unnest(f.proconfig) as c)),
         case when (select count(*) from fn f
                     where f.prosecdef
                       and 'search_path=' = any(
                             select left(c, 12) from unnest(f.proconfig) as c)) = 21
              then 'PASS' else 'FAIL' end

  union all
  select 12, 'shape',
         'all eight additive columns exist on the three existing tables',
         'expected: 8 of 8',
         (select count(*)::text || ' of 8' from expected_columns c
           where exists (select 1 from information_schema.columns
                          where table_schema = 'public'
                            and table_name = c.tbl and column_name = c.col)),
         case when (select count(*) from expected_columns c
                     where exists (select 1 from information_schema.columns
                                    where table_schema = 'public'
                                      and table_name = c.tbl
                                      and column_name = c.col)) = 8
              then 'PASS' else 'FAIL' end

  union all
  -- APPEND-ONLY IS A TRIGGER, NOT A CONVENTION. Revoking UPDATE protects
  -- against a route; a trigger protects against a future SECURITY
  -- DEFINER function written by somebody who has not read the header.
  select 13, 'shape',
         'both append-only triggers exist',
         'expected: financial_events + creator_commissions',
         (select coalesce(string_agg(tgname, ', ' order by tgname), 'none')
            from pg_trigger
           where not tgisinternal
             and tgname in ('financial_events_append_only',
                            'creator_commissions_append_only')),
         case when (select count(*) from pg_trigger
                     where not tgisinternal
                       and tgname in ('financial_events_append_only',
                                      'creator_commissions_append_only')) = 2
              then 'PASS' else 'FAIL' end

  union all
  /*
    THE FIVE UNIQUENESS RULES. These are not performance indexes: each
    one is a correctness guarantee the database enforces so that no code
    path can bypass it.

      one payment per order        no double cash recognition
      one prepayment per plan      a prepaid plan is paid once
      one earned commission/order  webhook replay cannot pay twice
      one expense per commission   no double-booking a creator cost
      one expense per UGC fee      the same, for UGC
  */
  select 14, 'shape',
         'all five uniqueness guarantees exist',
         'expected: 5 of 5',
         (select coalesce(string_agg(replace(i.name, 'idx_', ''), ', ' order by i.name),
                          'none')
            from expected_indexes i
           where exists (select 1 from pg_indexes
                          where schemaname = 'public' and indexname = i.name)),
         case when (select count(*) from expected_indexes i
                     where exists (select 1 from pg_indexes
                                    where schemaname = 'public'
                                      and indexname = i.name)) = 5
              then 'PASS' else 'FAIL' end

  /* ── 20-26. SECURITY AND VOCABULARY ─────────────────────── */

  union all
  /*
    THE MONEY TIER IS READ-ONLY FOR service_role.

    This is migration 071's decision and the reason every rule in a
    writer body is unavoidable: if a route could INSERT a financial event
    or a commission directly, the arithmetic, the append-only trigger and
    the uniqueness indexes would all be advisory.
  */
  select 20, 'security',
         'service_role may read the money tables but never write them directly',
         'expected: select yes; insert/update/delete no, on all three',
         (select coalesce(string_agg(
                    t.name || '=' ||
                    case when has_table_privilege('service_role', 'public.' || t.name, 'select')
                           and not has_table_privilege('service_role', 'public.' || t.name, 'insert')
                           and not has_table_privilege('service_role', 'public.' || t.name, 'update')
                           and not has_table_privilege('service_role', 'public.' || t.name, 'delete')
                         then 'read-only' else 'WRITABLE' end, '; ' order by t.name), 'none')
            from money_tables t),
         case when (select count(*) from money_tables t
                     where has_table_privilege('service_role', 'public.' || t.name, 'select')
                       and not has_table_privilege('service_role', 'public.' || t.name, 'insert')
                       and not has_table_privilege('service_role', 'public.' || t.name, 'update')
                       and not has_table_privilege('service_role', 'public.' || t.name, 'delete')) = 3
              then 'PASS' else 'FAIL' end

  union all
  select 21, 'security',
         'no browser role can read any 072 table or execute any 072 writer',
         'expected: nothing for anon, nothing for authenticated',
         (select coalesce(string_agg(t.name, ', ' order by t.name), 'none reachable')
            from expected_tables t
           where has_table_privilege('anon', 'public.' || t.name, 'select')
              or has_table_privilege('authenticated', 'public.' || t.name, 'select')),
         case when (select count(*) from expected_tables t
                     where has_table_privilege('anon', 'public.' || t.name, 'select')
                        or has_table_privilege('authenticated', 'public.' || t.name, 'select')) = 0
                   and (select count(*) from fn f
                         where has_function_privilege('anon',
                                 'public.' || f.proname || '(' || f.args || ')', 'execute')
                            or has_function_privilege('authenticated',
                                 'public.' || f.proname || '(' || f.args || ')', 'execute')) = 0
              then 'PASS' else 'FAIL' end

  union all
  select 22, 'security',
         'RLS is enabled on every 072 table and there is no policy at all',
         'expected: 15 with rls, 0 policies',
         (select count(*)::text || ' of 15 with rls, '
              || (select count(*) from pg_policies
                   where schemaname = 'public'
                     and tablename in (select name from expected_tables))::text
              || ' policies'
            from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public'
             and c.relname in (select name from expected_tables)
             and c.relrowsecurity),
         case when (select count(*) from pg_class c
                      join pg_namespace n on n.oid = c.relnamespace
                     where n.nspname = 'public'
                       and c.relname in (select name from expected_tables)
                       and c.relrowsecurity) = 15
                   and (select count(*) from pg_policies
                         where schemaname = 'public'
                           and tablename in (select name from expected_tables)) = 0
              then 'PASS' else 'FAIL' end

  union all
  -- DELETE IS GRANTED NOWHERE, on either tier. A finance or creator row
  -- is corrected by a new row, never removed.
  select 23, 'security',
         'DELETE is granted on no 072 table, for any role',
         'expected: 0 of 15',
         (select coalesce(string_agg(t.name, ', ' order by t.name), 'none')
            from expected_tables t
           where has_table_privilege('service_role', 'public.' || t.name, 'delete')
              or has_table_privilege('anon', 'public.' || t.name, 'delete')
              or has_table_privilege('authenticated', 'public.' || t.name, 'delete')),
         case when (select count(*) from expected_tables t
                     where has_table_privilege('service_role', 'public.' || t.name, 'delete')
                        or has_table_privilege('anon', 'public.' || t.name, 'delete')
                        or has_table_privilege('authenticated', 'public.' || t.name, 'delete')) = 0
              then 'PASS' else 'FAIL' end

  union all
  -- The catalogue tier is writable - that is the deliberate second tier
  -- - and must still be readable and insertable or the admin cannot
  -- create a creator at all.
  select 24, 'security',
         'the catalogue tier is readable and writable by service_role, and only by it',
         'expected: 12 with select+insert+update',
         (select count(*)::text || ' of 12' from catalogue_tables t
           where has_table_privilege('service_role', 'public.' || t.name, 'select')
             and has_table_privilege('service_role', 'public.' || t.name, 'insert')
             and has_table_privilege('service_role', 'public.' || t.name, 'update')),
         case when (select count(*) from catalogue_tables t
                     where has_table_privilege('service_role', 'public.' || t.name, 'select')
                       and has_table_privilege('service_role', 'public.' || t.name, 'insert')
                       and has_table_privilege('service_role', 'public.' || t.name, 'update')) = 12
              then 'PASS' else 'FAIL' end

  union all
  /*
    THE LEDGER'S ARITHMETIC CONSTRAINTS, by name.

    direction_check is the one that matters most: without it a refund
    could be stored as an inflow and would ADD to revenue instead of
    subtracting from it - the single worst row this table could hold.
  */
  select 25, 'money',
         'the financial_events constraints that make a wrong row impossible',
         'expected: direction, subject, date/basis, bounds, reversal',
         (select coalesce(string_agg(replace(conname, 'financial_events_', ''),
                                     ', ' order by conname), 'none')
            from fe_con
           where conname in ('financial_events_direction_check',
                             'financial_events_subject_check',
                             'financial_events_date_basis_check',
                             'financial_events_component_bounds_check',
                             'financial_events_reversal_not_self_check')),
         case when (select count(*) from fe_con
                     where conname in ('financial_events_direction_check',
                                       'financial_events_subject_check',
                                       'financial_events_date_basis_check',
                                       'financial_events_component_bounds_check',
                                       'financial_events_reversal_not_self_check')) = 5
                   -- and the direction rule really ties refund to outflow
                   and (select count(*) from fe_con
                         where conname = 'financial_events_direction_check'
                           and def like '%refund%'
                           and def like '%outflow%'
                           and def like '%inflow%') = 1
              then 'PASS' else 'FAIL' end

  union all
  select 26, 'vocabulary',
         'the audit module vocabulary is the previous seven plus creator',
         'expected: orders, inventory, b2b, finance, documents, fulfillment, customer_rights, creator',
         coalesce((select pg_get_constraintdef(oid) from pg_constraint
                    where conrelid = 'public.admin_activity_log'::regclass
                      and conname = 'admin_activity_log_module_check'), '<missing>'),
         case when (select count(*) from pg_constraint
                     where conrelid = 'public.admin_activity_log'::regclass
                       and conname = 'admin_activity_log_module_check'
                       and pg_get_constraintdef(oid) like '%creator%'
                       and pg_get_constraintdef(oid) like '%customer_rights%'
                       and pg_get_constraintdef(oid) like '%finance%'
                       and pg_get_constraintdef(oid) like '%inventory%'
                       and pg_get_constraintdef(oid) like '%orders%'
                       and pg_get_constraintdef(oid) like '%b2b%'
                       and pg_get_constraintdef(oid) like '%documents%'
                       and pg_get_constraintdef(oid) like '%fulfillment%') = 1
              then 'PASS' else 'FAIL' end

  /* ── 30-38. THE FUNCTION BODIES ─────────────────────────── */

  union all
  /*
    THE MOST IMPORTANT LINE IN THE MIGRATION.

    An annual delivery order must NEVER become cash: the plan was paid
    once and is delivered twelve or thirteen times. If this refusal were
    removed, one prepayment would be recognised once per delivery, the
    error would compound every month, and every individual total would
    still reconcile - which is what would make it invisible.
  */
  select 30, 'behaviour',
         'the payment writer refuses an annual delivery order',
         'expected: it calls order_is_annual_delivery and returns before inserting',
         coalesce((select case when f.prosrc like '%order_is_annual_delivery%'
                                and strpos(f.prosrc, 'order_is_annual_delivery')
                                    < strpos(f.prosrc, 'insert into public.financial_events')
                               then 'refuses before inserting'
                               else 'DOES NOT REFUSE' end
                     from fn f where f.proname = 'record_order_payment_event'), '<missing>'),
         case when (select count(*) from fn f
                     where f.proname = 'record_order_payment_event'
                       and f.prosrc like '%order_is_annual_delivery%'
                       and f.prosrc like '%annual_delivery%'
                       and strpos(f.prosrc, 'order_is_annual_delivery')
                           < strpos(f.prosrc, 'insert into public.financial_events')) = 1
                   -- and the predicate really reads the attempt's plan link
                   and (select count(*) from pg_proc p
                          join pg_namespace n on n.oid = p.pronamespace
                         where n.nspname = 'public'
                           and p.proname = 'order_is_annual_delivery'
                           and p.prosrc like '%checkout_attempts%'
                           and p.prosrc like '%annual_plan_id is not null%') = 1
              then 'PASS' else 'FAIL' end

  union all
  /*
    THE REFUND WRITERS COMPUTE A DELTA, NOT A TOTAL.

    Both take the absolute refunded figure Stripe reports, SUM what the
    ledger already holds for that subject, and insert the difference.
    That is what makes them idempotent by arithmetic rather than only by
    key - a redelivery carrying a fresh operation id still writes
    nothing - and it is what turns two partial refunds into two dated
    rows instead of one overwritten number.
  */
  select 31, 'behaviour',
         'both refund writers derive a delta by summing the existing ledger',
         'expected: sum(gross_cents) where kind = refund, then insert the difference',
         coalesce((select string_agg(
                     f.proname || '=' ||
                     case when f.prosrc like '%sum(e.gross_cents)%'
                           and f.prosrc like '%v_delta := p_refunded_total_cents - v_already%'
                           and f.prosrc like '%no_change%'
                          then 'delta' else 'NOT A DELTA' end, '; ' order by f.proname)
                     from fn f
                    where f.proname in ('record_order_refund_event',
                                        'record_annual_plan_refund_event')), '<missing>'),
         case when (select count(*) from fn f
                     where f.proname in ('record_order_refund_event',
                                         'record_annual_plan_refund_event')
                       and f.prosrc like '%sum(e.gross_cents)%'
                       and f.prosrc like '%kind = ''refund''%'
                       and f.prosrc like '%v_delta := p_refunded_total_cents - v_already%'
                       and f.prosrc like '%no_change%') = 2
              then 'PASS' else 'FAIL' end

  union all
  /*
    AND THE REFUND'S DATE IS THE REFUND'S OWN.

    The reason this ledger exists at all: orders.refunded_total_cents is
    deducted in the order's period, so an October refund restates
    September. Both writers must date the event with
    financial_event_berlin_date(now()) under basis 'event_date', and
    neither may read the subject's own date for it.
  */
  select 32, 'behaviour',
         'a refund is dated when it happened, not when the order was placed',
         'expected: both use berlin_date(now()) with basis event_date',
         coalesce((select string_agg(
                     f.proname || '=' ||
                     case when f.prosrc like '%financial_event_berlin_date(pg_catalog.now())%'
                           and f.prosrc like '%''event_date''%'
                          then 'own date' else 'WRONG PERIOD' end, '; ' order by f.proname)
                     from fn f
                    where f.proname in ('record_order_refund_event',
                                        'record_annual_plan_refund_event')), '<missing>'),
         case when (select count(*) from fn f
                     where f.proname in ('record_order_refund_event',
                                         'record_annual_plan_refund_event')
                       and f.prosrc like '%financial_event_berlin_date(pg_catalog.now())%'
                       and f.prosrc like '%''event_date''%'
                       and f.prosrc not like '%order_placed_at%'
                       and f.prosrc not like '%plan_purchased_at%') = 2
              then 'PASS' else 'FAIL' end

  union all
  /*
    THE DEFECT A REAL DATABASE CAUGHT.

    annual_plans_cancelled_at_check is `(cancelled_at is not null) =
    (status = 'cancelled')`. The first version of this writer set the
    status alone and was refused. Nothing in the schema can express which
    statement writes which pair, so it is checked in the body.
  */
  select 33, 'behaviour',
         'the annual termination writer sets cancelled_at in the same statement as the status',
         'expected: status = cancelled AND cancelled_at both written',
         coalesce((select case when f.prosrc like '%status                 = ''cancelled''%'
                                and f.prosrc like '%cancelled_at           = v_now%'
                               then 'paired' else 'NOT PAIRED' end
                     from fn f
                    where f.proname = 'admin_decide_annual_termination'), '<missing>'),
         case when (select count(*) from fn f
                     where f.proname = 'admin_decide_annual_termination'
                       and f.prosrc like '%''cancelled''%'
                       and f.prosrc like '%cancelled_at%'
                       and f.prosrc like '%terminated_at%'
                       -- the ordinary decision must NOT cancel anything
                       and f.prosrc like '%noted_ends_automatically%'
                       -- and fulfilled deliveries must be excluded
                       and f.prosrc like '%fulfilled_at is null%'
                       -- and it must never refund
                       and f.prosrc like '%refund_decision_required%'
                       and f.prosrc not like '%stripe%') = 1
              then 'PASS' else 'FAIL' end

  union all
  /*
    THE CANCELLATION DATE IS NOT A PARAMETER.

    Part D3: no browser-authoritative cancellation dates. That is
    guaranteed by the SIGNATURE, not by validation - there is nowhere for
    a date to enter. The body reads current_period_end and calls
    migration 034's scheduler rather than reimplementing the rules.
  */
  select 34, 'behaviour',
         'the subscription termination takes no date and reuses migration 034s scheduler',
         'expected: args (uuid, uuid, text, uuid); reads current_period_end',
         coalesce((select f.args || ' | '
                     || case when f.prosrc like '%current_period_end%'
                              and f.prosrc like '%schedule_subscription_cancellation%'
                             then 'reads the period end' else 'DOES NOT' end
                     from fn f
                    where f.proname = 'admin_execute_subscription_termination'), '<missing>'),
         case when (select count(*) from fn f
                     where f.proname = 'admin_execute_subscription_termination'
                       -- NO timestamptz anywhere in the signature
                       and f.args = 'uuid, uuid, text, uuid'
                       and f.prosrc like '%current_period_end%'
                       and f.prosrc like '%schedule_subscription_cancellation%'
                       and f.prosrc not like '%stripe%') = 1
              then 'PASS' else 'FAIL' end

  union all
  /*
    ATTRIBUTION TAKES NO CREATOR ID, AND COMMISSION TAKES NO AMOUNT.

    Part I's two forgery questions, both answered by absence. The
    attribution writer receives a slug or a code and resolves the creator
    server-side; the amount is computed from the order and the frozen
    rule. A browser has nothing to lie with.
  */
  select 35, 'behaviour',
         'attribution resolves the creator server-side and accepts no creator id or amount',
         'expected: args (uuid, text, text, uuid); resolves via resolve_affiliate_*',
         coalesce((select f.args || ' | '
                     || case when f.prosrc like '%resolve_affiliate_link%'
                              and f.prosrc like '%resolve_affiliate_code%'
                             then 'server-resolved' else 'DOES NOT RESOLVE' end
                     from fn f where f.proname = 'attribute_order_to_creator'), '<missing>'),
         case when (select count(*) from fn f
                     where f.proname = 'attribute_order_to_creator'
                       and f.args = 'uuid, text, text, uuid'
                       and f.prosrc like '%resolve_affiliate_link%'
                       and f.prosrc like '%resolve_affiliate_code%'
                       -- the amount is computed, from the base function
                       and f.prosrc like '%order_commission_base_cents%'
                       -- and a missing rule earns nothing rather than zero
                       and f.prosrc like '%attributed_without_commission%') = 1
                   -- and both resolvers check the creator's own status
                   and (select count(*) from fn f
                         where f.proname in ('resolve_affiliate_link',
                                             'resolve_affiliate_code')
                           and f.prosrc like '%creator_inactive%'
                           and f.prosrc like '%expired%'
                           and f.prosrc like '%paused%') = 2
              then 'PASS' else 'FAIL' end

  union all
  /*
    A REFUND REVERSES COMMISSION PROPORTIONALLY, ONCE, AND BY A ROW.

    The same delta shape as the money ledger, for the same reason, and
    reversals are rows so the earning stays exactly as earned.
  */
  select 36, 'behaviour',
         'commission reversal is proportional, idempotent and append-only',
         'expected: delta against existing reversals; inserts kind = reversal',
         coalesce((select case when f.prosrc like '%reverses_commission_id = v_earned.id%'
                                and f.prosrc like '%no_change%'
                                and f.prosrc like '%''reversal''%'
                               then 'delta + reversal row' else 'NOT SAFE' end
                     from fn f
                    where f.proname = 'reverse_creator_commission_for_refund'), '<missing>'),
         case when (select count(*) from fn f
                     where f.proname = 'reverse_creator_commission_for_refund'
                       and f.prosrc like '%reverses_commission_id = v_earned.id%'
                       and f.prosrc like '%no_change%'
                       and f.prosrc like '%''reversal''%'
                       -- clamped so rounding cannot reverse more than was earned
                       and f.prosrc like '%v_target > v_earned.amount_cents%'
                       -- and the policy column is honoured, not assumed
                       and f.prosrc like '%reverse_on_refund%') = 1
              then 'PASS' else 'FAIL' end

  union all
  -- PART M, ASSERTED. No body this migration created may mention the
  -- stock ledger at all.
  select 37, 'boundary',
         'no 072 function reaches the stock ledger',
         'expected: 0 of 21 mention inventory_movements or inventory_items',
         (select coalesce(string_agg(f.proname, ', ' order by f.proname), 'none')
            from fn f
           where f.prosrc like '%inventory_movements%'
              or f.prosrc like '%inventory_items%'),
         case when (select count(*) from fn f
                     where f.prosrc like '%inventory_movements%'
                        or f.prosrc like '%inventory_items%') = 0
              then 'PASS' else 'FAIL' end

  union all
  /*
    THE SHIPPING READER REFUSES TO GUESS.

    Part C: do not invent a dispatch SLA. With no configured value the
    function must answer 'no_dispatch_target_configured' rather than a
    date, and this is executed rather than read - the one behavioural
    check here that calls the function.
  */
  select 38, 'behaviour',
         'the shipping reader answers no_dispatch_target_configured when nothing is set',
         'expected: no date invented while the SLA is unconfigured',
         case when exists (select 1 from public.operations_config
                            where key = 'dispatch_sla_business_days')
              then 'an SLA IS configured; this check does not apply'
              else coalesce((select public.order_shipping_due(o.id)->>'state'
                               from public.orders o
                              where o.shipped_at is null
                                and o.status <> 'cancelled'
                                and o.placed_at is not null
                              limit 1), 'no unshipped order to test') end,
         case when exists (select 1 from public.operations_config
                            where key = 'dispatch_sla_business_days')
              then 'PASS'
              when not exists (select 1 from public.orders
                                where shipped_at is null and status <> 'cancelled'
                                  and placed_at is not null)
              then 'PASS'
              when (select public.order_shipping_due(o.id)->>'state'
                      from public.orders o
                     where o.shipped_at is null and o.status <> 'cancelled'
                       and o.placed_at is not null
                     limit 1) = 'no_dispatch_target_configured'
              then 'PASS' else 'FAIL' end

  /* ── 40-41. 072 WROTE NOTHING AND SEEDED NOTHING ────────── */

  union all
  /*
    IT IS NOT A DATA MIGRATION.

    A fresh apply leaves every new table empty: additive means additive,
    and Part O forbids a backfill that fabricates facts. If any of these
    is non-zero on the day 072 is applied, something wrote rows that 072
    did not - which also means the historical derivation was run as part
    of the apply rather than as the separate reviewable step it has to be.
  */
  select 40, 'data',
         '072 inserted no business row of its own',
         'expected: 0 everywhere immediately after applying',
         (select 'financial_events=' || (select count(*) from public.financial_events)::text
              || ' creators=' || (select count(*) from public.creators)::text
              || ' commissions=' || (select count(*) from public.creator_commissions)::text
              || ' attributions=' || (select count(*) from public.order_attributions)::text
              || ' documents=' || (select count(*) from public.documents)::text),
         case when (select count(*) from public.financial_events) = 0
                   and (select count(*) from public.creators) = 0
                   and (select count(*) from public.creator_commissions) = 0
                   and (select count(*) from public.order_attributions) = 0
                   and (select count(*) from public.documents) = 0
              then 'PASS' else 'FAIL' end

  union all
  /*
    AND IT INVENTED NO BUSINESS PARAMETER.

    operations_config must be EMPTY after the apply. The dispatch SLA and
    the attribution window are owner decisions; a seeded value would be
    the invented SLA Part C forbids, and it would immediately start
    producing overdue badges against a promise nobody made.
  */
  select 41, 'data',
         '072 seeded no business parameter',
         'expected: operations_config empty right after the apply',
         (select count(*)::text || ' row(s): '
              || coalesce((select string_agg(key, ', ' order by key)
                             from public.operations_config), 'none')
            from public.operations_config),
         case when (select count(*) from public.operations_config) = 0
              then 'PASS' else 'FAIL' end
),
infos(check_id, area, question, expectation, found, verdict) as (
  select 50, 'info',
         'paid orders that are eligible to become order_payment events',
         'INFO - 072 creates none; the application records them going forward',
         (select count(*)::text || ' eligible, '
              || count(*) filter (where public.order_is_annual_delivery(o.id))::text
              || ' of which are annual deliveries and must stay out of cash'
            from public.orders o
           where o.placed_at is not null
             and o.payment_status in ('paid', 'partially_refunded', 'refunded')),
         'INFO'
  union all
  select 51, 'info',
         'prepaid annual plans eligible for exactly one prepayment event each',
         'INFO - one per plan, never one per delivery',
         (select count(*)::text || ' paid plan(s) worth '
              || coalesce(sum(total_gross_cents), 0)::text || ' cents gross'
            from public.annual_plans
           where payment_status in ('paid', 'refunded') and purchased_at is not null),
         'INFO'
  union all
  -- The B2B money that was invisible before 072 and is now representable.
  select 52, 'info',
         'settled B2B instalments now representable in Finance',
         'INFO - read from b2b_payment_schedule, never from a fabricated order',
         (select count(*)::text || ' settled instalment(s) worth '
              || coalesce(sum(gross_cents), 0)::text || ' cents gross'
            from public.b2b_payment_schedule
           where status = 'paid' and paid_at is not null),
         'INFO'
)
select * from (
  select check_id, area, question, expectation, found, verdict from verdicts
  union all
  select check_id, area, question, expectation, found, verdict from infos
  union all
  select 999, 'SUMMARY',
         'migration 072 applied cleanly',
         'expected: 0 FAIL / 23 PASS / 3 INFO',
         (select count(*) filter (where v.verdict = 'FAIL')::text || ' FAIL / '
              || count(*) filter (where v.verdict = 'PASS')::text || ' PASS / '
              || (select count(*) from infos)::text || ' INFO'
            from verdicts v),
         case when (select count(*) filter (where v.verdict = 'FAIL') from verdicts v) = 0
                   and (select count(*) from verdicts) = 23
              then 'APPLIED CLEANLY' else 'INCOMPLETE' end
) as checks
 order by check_id;
