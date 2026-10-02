-- ══════════════════════════════════════════════════════════════
-- 072 PREFLIGHT  —  READ ONLY.  RUN BEFORE APPLYING 072.
-- ══════════════════════════════════════════════════════════════
--
-- Answers one question: may migration 072 be applied to THIS database?
--
-- It writes nothing. It is ONE SELECT statement - no transaction, no DO
-- block, no temporary table, no function - so there is nothing it could
-- leave behind even if it were interrupted half way.
--
-- ── WHAT IT CHECKS ────────────────────────────────────────────
--
-- 10-13  THE COLLISION CHECK. None of 072's fifteen tables, twenty-one
--        functions, two triggers or eight additive columns may already
--        exist. Check 10 reports WHICH of them are present, so a partial
--        or interrupted earlier apply is named rather than guessed at.
--
-- 20-29  THE REAL DEPENDENCIES, and every one of them is something a
--        072 writer actually reads:
--
--   20  public.orders and the nine money and state columns the payment,
--       refund, commission and shipping readers use.
--   21  public.annual_plans and the seven columns the prepayment,
--       refund and termination writers use.
--   22  THE annual_plans cancelled_at EQUIVALENCE. This check exists
--       because of a real defect: the first version of 072's termination
--       writer set status = 'cancelled' alone and was refused by
--       annual_plans_cancelled_at_check, which is
--       `(cancelled_at is not null) = (status = 'cancelled')`. Reading
--       migration 039 shows a nullable timestamp and nothing that says
--       it is mandatory. If that constraint is ever absent or different
--       here, the writer's paired UPDATE is wrong in a way no amount of
--       code review would reveal.
--   23  public.subscriptions.current_period_end, which is the ONLY
--       source of a cancellation date - 072 deliberately has no date
--       parameter, so if this column is missing the subscription
--       termination path cannot work at all.
--   24  schedule_subscription_cancellation, with its five-argument
--       signature. 072 calls it and does not reimplement it.
--   25  public.b2b_payment_schedule and the five columns the B2B
--       settlement writer reads. This is the dependency that makes B2B
--       revenue possible WITHOUT fabricating an order.
--   26  checkout_attempts.annual_plan_id and .subscription_id, which are
--       how order_is_annual_delivery and order_subscription_id answer.
--       If annual_plan_id were missing, every annual delivery order
--       would be recognised as cash and the prepaid amount would be
--       counted twelve times.
--   27  claim_due_annual_plan_deliveries STILL FILTERS status = 'active'.
--       The whole annual termination stop rests on this: 072 sets the
--       plan to 'cancelled' and changes no existing function, which is
--       only sufficient while that filter is there.
--   28  termination_requests and the four case states 072 writes.
--   29  record_admin_activity, admin_activity_log.operation_id, and the
--       module CHECK that 072 widens.
--
--   30  public.business_expenses (migration 071) exists, because 072
--       adds two creator columns to it.
--   31  auth.users exists; eight new columns reference it.
--
-- EXPECTED HEALTHY RESULT:  0 FAIL / 17 PASS / 4 INFO — SAFE TO APPLY
--
-- Seventeen verdict-bearing checks (10-13, 20-32) and four INFO rows
-- (50-53), plus the SUMMARY row, which counts only the twenty-one above
-- it. The SUMMARY is always computed from the actual rows; this line is
-- the expectation to compare it against, never the source of it.
-- Verified: a database carrying 001..071 and not 072 returns exactly
-- 0 FAIL / 17 PASS / 4 INFO.
--
-- ── IT REFUSES AFTER 072 IS APPLIED ───────────────────────────
--
-- Check 10 FAILS the moment any 072 object exists, and the SUMMARY turns
-- to DO NOT APPLY. That is deliberate and it is the right behaviour: a
-- preflight that said SAFE TO APPLY against a database already carrying
-- 072 would invite a second apply. The postcheck is the file for that
-- question.

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
expected_functions(name) as (
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
         ('creator_commission_balance'),
         ('financial_events_append_only'),
         ('creator_commissions_append_only')
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
order_columns(name) as (
  values ('placed_at'), ('customer_type'), ('status'), ('payment_status'),
         ('total_gross_cents'), ('total_net_cents'), ('shipping_gross_cents'),
         ('shipping_net_cents'), ('refunded_total_cents'), ('shipped_at'),
         ('checkout_attempt_id'), ('currency')
),
plan_columns(name) as (
  values ('purchased_at'), ('payment_status'), ('status'),
         ('total_gross_cents'), ('cancelled_at'), ('currency'),
         ('stripe_payment_intent_id')
),
b2b_columns(name) as (
  values ('supply_agreement_id'), ('status'), ('paid_at'),
         ('gross_cents'), ('net_cents'), ('tax_cents'), ('instalment_number')
),
verdicts(check_id, area, question, expectation, found, verdict) as (

  /* ── 10-13. NOTHING FROM 072 MAY ALREADY EXIST ──────────── */

  select 10, 'collision',
         'none of 072s fifteen tables exist yet',
         'expected: 0 of 15 present',
         (select coalesce(string_agg(t.name, ', ' order by t.name), 'none present')
            from expected_tables t
           where exists (select 1 from information_schema.tables
                          where table_schema = 'public' and table_name = t.name)),
         case when (select count(*) from expected_tables t
                     where exists (select 1 from information_schema.tables
                                    where table_schema = 'public'
                                      and table_name = t.name)) = 0
              then 'PASS' else 'FAIL' end

  union all
  select 11, 'collision',
         'none of 072s functions exist yet',
         'expected: 0 of 23 present',
         (select coalesce(string_agg(f.name, ', ' order by f.name), 'none present')
            from expected_functions f
           where exists (select 1 from pg_proc p
                           join pg_namespace n on n.oid = p.pronamespace
                          where n.nspname = 'public' and p.proname = f.name)),
         case when (select count(*) from expected_functions f
                     where exists (select 1 from pg_proc p
                                     join pg_namespace n on n.oid = p.pronamespace
                                    where n.nspname = 'public'
                                      and p.proname = f.name)) = 0
              then 'PASS' else 'FAIL' end

  union all
  -- The additive columns on the three EXISTING tables. 072 uses
  -- `add column if not exists`, so a half-applied earlier attempt would
  -- pass silently through the migration and is worth naming here.
  select 12, 'collision',
         'none of 072s additive columns exist yet',
         'expected: 0 of 8 present',
         (select coalesce(string_agg(c.tbl || '.' || c.col, ', ' order by c.tbl, c.col),
                          'none present')
            from expected_columns c
           where exists (select 1 from information_schema.columns
                          where table_schema = 'public'
                            and table_name = c.tbl and column_name = c.col)),
         case when (select count(*) from expected_columns c
                     where exists (select 1 from information_schema.columns
                                    where table_schema = 'public'
                                      and table_name = c.tbl
                                      and column_name = c.col)) = 0
              then 'PASS' else 'FAIL' end

  union all
  select 13, 'collision',
         'neither append-only trigger exists yet',
         'expected: 0 of 2 present',
         (select coalesce(string_agg(t.tgname, ', ' order by t.tgname), 'none present')
            from pg_trigger t
           where not t.tgisinternal
             and t.tgname in ('financial_events_append_only',
                              'creator_commissions_append_only')),
         case when (select count(*) from pg_trigger t
                     where not t.tgisinternal
                       and t.tgname in ('financial_events_append_only',
                                        'creator_commissions_append_only')) = 0
              then 'PASS' else 'FAIL' end

  /* ── 20-31. THE DEPENDENCIES 072 ACTUALLY READS ─────────── */

  union all
  select 20, 'dependency',
         'orders carries every money and state column 072 reads',
         'expected: 12 of 12',
         (select count(*)::text || ' of 12' from order_columns c
           where exists (select 1 from information_schema.columns
                          where table_schema = 'public' and table_name = 'orders'
                            and column_name = c.name)),
         case when (select count(*) from order_columns c
                     where exists (select 1 from information_schema.columns
                                    where table_schema = 'public'
                                      and table_name = 'orders'
                                      and column_name = c.name)) = 12
              then 'PASS' else 'FAIL' end

  union all
  select 21, 'dependency',
         'annual_plans carries every column 072 reads',
         'expected: 7 of 7',
         (select count(*)::text || ' of 7' from plan_columns c
           where exists (select 1 from information_schema.columns
                          where table_schema = 'public' and table_name = 'annual_plans'
                            and column_name = c.name)),
         case when (select count(*) from plan_columns c
                     where exists (select 1 from information_schema.columns
                                    where table_schema = 'public'
                                      and table_name = 'annual_plans'
                                      and column_name = c.name)) = 7
              then 'PASS' else 'FAIL' end

  union all
  /*
    THE CONSTRAINT THAT CAUGHT A REAL DEFECT.

    annual_plans_cancelled_at_check is an EQUIVALENCE, not a one-way
    implication: cancelled_at is not null if and only if status is
    'cancelled'. 072's termination writer therefore has to set both in
    the same UPDATE, and its first version did not. If this constraint is
    absent or has a different shape in the target database, that paired
    write is either unnecessary or insufficient - and either way the
    writer's behaviour here would differ from the behaviour that was
    tested.
  */
  select 22, 'dependency',
         'the annual_plans cancelled_at rule is the equivalence 072 was written against',
         'expected: (cancelled_at IS NOT NULL) = (status = cancelled)',
         coalesce((select pg_get_constraintdef(oid) from pg_constraint
                    where conrelid = 'public.annual_plans'::regclass
                      and conname = 'annual_plans_cancelled_at_check'), '<missing>'),
         case when (select count(*) from pg_constraint
                     where conrelid = 'public.annual_plans'::regclass
                       and conname = 'annual_plans_cancelled_at_check'
                       and pg_get_constraintdef(oid) like '%cancelled_at IS NOT NULL%'
                       and pg_get_constraintdef(oid) like '%= (status%') = 1
              then 'PASS' else 'FAIL' end

  union all
  -- The ONLY source of a cancellation date. 072 has no date parameter, so
  -- without this column the subscription termination path cannot run.
  select 23, 'dependency',
         'subscriptions carries current_period_end and user_id',
         'expected: both present',
         (select coalesce(string_agg(column_name, ', ' order by column_name), 'none')
            from information_schema.columns
           where table_schema = 'public' and table_name = 'subscriptions'
             and column_name in ('current_period_end', 'user_id',
                                 'cancellation_effective_at', 'status')),
         case when (select count(*) from information_schema.columns
                     where table_schema = 'public' and table_name = 'subscriptions'
                       and column_name in ('current_period_end', 'user_id',
                                           'cancellation_effective_at', 'status')) = 4
              then 'PASS' else 'FAIL' end

  union all
  select 24, 'dependency',
         'schedule_subscription_cancellation exists with its five-argument signature',
         'expected: (uuid, uuid, timestamptz, timestamptz, timestamptz) returning jsonb',
         coalesce((select oidvectortypes(p.proargtypes) || ' -> '
                          || pg_get_function_result(p.oid)
                     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'public'
                      and p.proname = 'schedule_subscription_cancellation'
                    limit 1), '<missing>'),
         case when (select count(*) from pg_proc p
                      join pg_namespace n on n.oid = p.pronamespace
                     where n.nspname = 'public'
                       and p.proname = 'schedule_subscription_cancellation'
                       and oidvectortypes(p.proargtypes)
                           = 'uuid, uuid, timestamp with time zone, '
                             || 'timestamp with time zone, timestamp with time zone'
                       and pg_get_function_result(p.oid) = 'jsonb') = 1
              then 'PASS' else 'FAIL' end

  union all
  /*
    THE B2B SOURCE OF TRUTH. 072 reads settled instalments directly and
    deliberately creates no order for them - Part J's instruction and the
    only way B2B revenue can appear without a second truth about the same
    money.
  */
  select 25, 'dependency',
         'b2b_payment_schedule carries every column the settlement writer reads',
         'expected: 7 of 7',
         (select count(*)::text || ' of 7' from b2b_columns c
           where exists (select 1 from information_schema.columns
                          where table_schema = 'public'
                            and table_name = 'b2b_payment_schedule'
                            and column_name = c.name)),
         case when (select count(*) from b2b_columns c
                     where exists (select 1 from information_schema.columns
                                    where table_schema = 'public'
                                      and table_name = 'b2b_payment_schedule'
                                      and column_name = c.name)) = 7
              then 'PASS' else 'FAIL' end

  union all
  /*
    THE COLUMN THAT PREVENTS TWELVEFOLD RECOGNITION.

    order_is_annual_delivery answers by joining the order's checkout
    attempt and testing annual_plan_id. If that column were absent, every
    annual delivery order would be recorded as cash and one prepaid
    payment would be counted once per delivery.
  */
  select 26, 'dependency',
         'checkout_attempts can identify an annual delivery and a subscription',
         'expected: annual_plan_id and subscription_id both present',
         (select coalesce(string_agg(column_name, ', ' order by column_name), 'none')
            from information_schema.columns
           where table_schema = 'public' and table_name = 'checkout_attempts'
             and column_name in ('annual_plan_id', 'subscription_id')),
         case when (select count(*) from information_schema.columns
                     where table_schema = 'public' and table_name = 'checkout_attempts'
                       and column_name in ('annual_plan_id', 'subscription_id')) = 2
              then 'PASS' else 'FAIL' end

  union all
  /*
    THE WHOLE ANNUAL TERMINATION STOP RESTS ON THIS LINE.

    072 ends a plan by setting status = 'cancelled' and changes NO
    existing function - which is correct precisely because 070's claim
    queue filters status = 'active' and 039's fulfiller refuses anything
    else. If either filter were gone, a terminated plan would keep
    shipping and 072's termination would be cosmetic.
  */
  select 27, 'dependency',
         'the delivery claim queue and the fulfiller still gate on status = active',
         'expected: both bodies filter an active plan',
         coalesce((select string_agg(p.proname || '=' ||
                     case when p.prosrc like '%status = ''active''%'
                            or p.prosrc like '%status <> ''active''%'
                          then 'gated' else 'UNGATED' end, '; ' order by p.proname)
                     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'public'
                      and p.proname in ('claim_due_annual_plan_deliveries',
                                        'fulfill_annual_plan_delivery')), '<missing>'),
         case when (select count(*) from pg_proc p
                      join pg_namespace n on n.oid = p.pronamespace
                     where n.nspname = 'public'
                       and p.proname in ('claim_due_annual_plan_deliveries',
                                         'fulfill_annual_plan_delivery')
                       and (p.prosrc like '%status = ''active''%'
                            or p.prosrc like '%status <> ''active''%')) = 2
              then 'PASS' else 'FAIL' end

  union all
  select 28, 'dependency',
         'termination_requests exists and permits the four case states 072 writes',
         'expected: acknowledged_ends_automatically, effective, rejected, closed, scheduled',
         coalesce((select pg_get_constraintdef(oid) from pg_constraint
                    where conrelid = 'public.termination_requests'::regclass
                      and contype = 'c'
                      and pg_get_constraintdef(oid) like '%case_state%'
                    limit 1), '<missing>'),
         case when (select count(*) from pg_constraint
                     where conrelid = 'public.termination_requests'::regclass
                       and contype = 'c'
                       and pg_get_constraintdef(oid) like '%case_state%'
                       and pg_get_constraintdef(oid) like '%acknowledged_ends_automatically%'
                       and pg_get_constraintdef(oid) like '%effective%'
                       and pg_get_constraintdef(oid) like '%rejected%'
                       and pg_get_constraintdef(oid) like '%closed%'
                       and pg_get_constraintdef(oid) like '%scheduled%') >= 1
                   and (select count(*) from information_schema.columns
                         where table_schema = 'public'
                           and table_name = 'termination_requests'
                           and column_name in ('resolved_annual_plan_id',
                                               'resolved_subscription_id',
                                               'termination_kind',
                                               'internal_note')) = 4
              then 'PASS' else 'FAIL' end

  union all
  select 29, 'dependency',
         'the audit registry 072 writes to, and the module CHECK it widens',
         'expected: record_admin_activity + operation_id + the seven current modules',
         coalesce((select oidvectortypes(p.proargtypes)
                     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'public' and p.proname = 'record_admin_activity'
                    limit 1), '<missing>')
           || ' | modules='
           || coalesce((select case when pg_get_constraintdef(oid) like '%creator%'
                                    then 'ALREADY WIDENED' else 'seven' end
                          from pg_constraint
                         where conrelid = 'public.admin_activity_log'::regclass
                           and conname = 'admin_activity_log_module_check'), 'MISSING'),
         case when (select count(*) from pg_proc p
                      join pg_namespace n on n.oid = p.pronamespace
                     where n.nspname = 'public'
                       and p.proname = 'record_admin_activity') = 1
                   and (select count(*) from information_schema.columns
                         where table_schema = 'public'
                           and table_name = 'admin_activity_log'
                           and column_name in ('module', 'action',
                                               'operation_id', 'entity_id')) = 4
                   and (select count(*) from pg_constraint
                         where conrelid = 'public.admin_activity_log'::regclass
                           and conname = 'admin_activity_log_module_check'
                           and pg_get_constraintdef(oid) like '%customer_rights%'
                           and pg_get_constraintdef(oid) not like '%creator%') = 1
              then 'PASS' else 'FAIL' end

  union all
  -- Migration 071's table, which 072 extends with two creator pointers.
  select 30, 'dependency',
         'business_expenses exists (migration 071 is applied)',
         'expected: present, with gross_cents and channel',
         (select coalesce(string_agg(column_name, ', ' order by column_name), 'MISSING')
            from information_schema.columns
           where table_schema = 'public' and table_name = 'business_expenses'
             and column_name in ('gross_cents', 'vat_cents', 'channel',
                                 'payment_status')),
         case when (select count(*) from information_schema.columns
                     where table_schema = 'public' and table_name = 'business_expenses'
                       and column_name in ('gross_cents', 'vat_cents', 'channel',
                                           'payment_status')) = 4
              then 'PASS' else 'FAIL' end

  union all
  select 31, 'dependency',
         'auth.users exists (eight new columns reference it)',
         'expected: present',
         case when exists (select 1 from information_schema.tables
                            where table_schema = 'auth' and table_name = 'users')
              then 'present' else 'MISSING' end,
         case when exists (select 1 from information_schema.tables
                            where table_schema = 'auth' and table_name = 'users')
              then 'PASS' else 'FAIL' end

  union all
  select 32, 'security', '071 remediation dependencies and unrelated ACL collisions',
         'expected: RLS, three service-only audited writers; no other or column ACLs',
         'known service_role table grants are permitted and remediated by 072',
         case when exists (select 1 from pg_class where oid=to_regclass('public.business_expenses') and relrowsecurity)
           and (select count(*) from pg_proc p join (values ('admin_record_business_expense(uuid,date,text,integer,text,text,text,integer,uuid,text,text,uuid)'),
             ('admin_update_business_expense(uuid,uuid,date,text,integer,text,text,text,integer,uuid,text,text,uuid)'),
             ('admin_delete_business_expense(uuid,uuid,uuid)')) signatures(sig)
                  on p.oid=to_regprocedure(signatures.sig)
                where p.prosecdef and 'search_path=' = any(select left(c,12) from unnest(p.proconfig) c)
                  and has_function_privilege('service_role',p.oid,'EXECUTE')
                  and not has_function_privilege('anon',p.oid,'EXECUTE')
                  and not has_function_privilege('authenticated',p.oid,'EXECUTE')
                  and not exists (select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
                                   where a.grantee not in (p.proowner,(select oid from pg_roles where rolname='service_role'))))=3 and not exists (select 1 from pg_class c cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
                             where c.oid=to_regclass('public.business_expenses')
                               and a.grantee not in (c.relowner,(select oid from pg_roles where rolname='service_role')))
           and not exists (select 1 from pg_attribute where attrelid=to_regclass('public.business_expenses')
                             and attacl is not null and cardinality(attacl)>0) then 'PASS' else 'FAIL' end

  union all
  select 53, 'info', 'pre-072 business_expenses service_role direct writes',
         'INFO - known excess is explicitly revoked by 072',
         coalesce(has_table_privilege('service_role',to_regclass('public.business_expenses'),'INSERT,UPDATE,DELETE'),false)::text,
         'INFO'

  /* ── 50-52. INFO. Context, never a verdict. ─────────────── */

  union all
  select 50, 'info',
         'paid orders that will become order_payment events',
         'INFO - 072 writes none of them; it only makes them possible',
         (select count(*)::text || ' paid order(s), of which '
              || count(*) filter (
                   where exists (select 1 from public.checkout_attempts a
                                  where a.id = o.checkout_attempt_id
                                    and a.annual_plan_id is not null))::text
              || ' are annual deliveries and must NOT become cash'
            from public.orders o
           where o.placed_at is not null
             and o.payment_status in ('paid', 'partially_refunded', 'refunded')),
         'INFO'

  union all
  select 51, 'info',
         'prepaid annual plans that will become one event each',
         'INFO - one event per plan, not one per delivery',
         (select count(*)::text || ' paid plan(s)'
            from public.annual_plans
           where payment_status in ('paid', 'refunded') and purchased_at is not null),
         'INFO'

  union all
  -- The B2B money that is invisible to Finance today, and the figure
  -- that proves defect (5) is real in this database rather than only in
  -- the design note.
  select 52, 'info',
         'settled B2B instalments Finance cannot currently see',
         'INFO - 072 is what makes them visible',
         (select count(*)::text || ' settled instalment(s) worth '
              || coalesce(sum(gross_cents), 0)::text || ' cents gross'
            from public.b2b_payment_schedule
           where status = 'paid' and paid_at is not null),
         'INFO'
)
select * from (
  select check_id, area, question, expectation, found, verdict from verdicts
  union all
  select 999, 'SUMMARY',
         'migration 072 may be applied',
         'expected: 0 FAIL / 17 PASS / 4 INFO',
         (select count(*) filter (where v.verdict = 'FAIL')::text || ' FAIL / '
              || count(*) filter (where v.verdict = 'PASS')::text || ' PASS / '
              || count(*) filter (where v.verdict = 'INFO')::text || ' INFO'
            from verdicts v),
         -- COMPUTED FROM THE ROWS, so it cannot disagree with them.
         case when (select count(*) filter (where v.verdict = 'FAIL') from verdicts v) = 0
                   and (select count(*) filter (where v.verdict = 'PASS') from verdicts v) = 17
              then 'SAFE TO APPLY' else 'DO NOT APPLY' end
) as checks
 order by check_id;
