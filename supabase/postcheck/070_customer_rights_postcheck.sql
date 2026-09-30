-- ============================================================
-- GLOA · MIGRATION 070 PRODUCTION POSTCHECK  ·  READ ONLY
-- ONE statement. No writes. Run AFTER applying migration 070.
-- APPLIED CORRECTLY  <=>  the final SUMMARY row says 'APPLIED CLEANLY'
--                         (i.e. zero rows with verdict = 'FAIL').
-- Rows with verdict 'INFO' are context, never a blocker.
--
-- EXPECTED HEALTHY RESULT:  0 FAIL / 19 PASS / 4 INFO
--
-- Nineteen verdict-bearing checks - 10-14, 20-25, 30-33 and 40-43 - and
-- four INFO rows (50-53), plus the SUMMARY row, which counts only the
-- twenty-three above it. The SUMMARY is always computed from the actual
-- rows; this line is the expectation to compare it against, never the
-- source of it. Verified: a fresh apply of migrations 001-070 to a real
-- PostgreSQL 17 instance returns exactly 0 FAIL / 19 PASS / 4 INFO.
--
-- ══════════════════════════════════════════════════════════════
-- WHY A POSTCHECK AND NOT JUST THE PREFLIGHT
-- ══════════════════════════════════════════════════════════════
--
-- The preflight answers "may this be applied". It cannot answer "was
-- it applied, in full, and did it change nothing it promised not to".
-- Those are the two questions here, and they are not symmetric:
--
--   DID EVERYTHING ARRIVE. Every column, table, function, constraint
--   and index 070 creates, checked BY NAME - because a migration that
--   half-applied would leave a shop whose admin desk calls functions
--   that do not exist.
--
--   AND DID NOTHING ELSE MOVE. No order gained a delivery receipt, no
--   historical withdrawal declaration was advanced past 'submitted',
--   and the three new tables are empty. 070 backfills nothing, and
--   that claim is only worth as much as the check that verifies it.
--
-- IT IS SAFE TO RUN AT ANY TIME, repeatedly, on Production. It reads
-- catalogs and counts rows; it writes nothing and locks nothing.
-- ============================================================
with
fn as (
  select p.oid, p.proname::text as proname, p.prosecdef, p.proconfig, p.prosrc,
         pg_catalog.pg_get_function_identity_arguments(p.oid) as ident
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
),
-- THE TWENTY FUNCTIONS 070 OWNS AFTER APPLYING: the nineteen it
-- creates, plus claim_due_annual_plan_deliveries, which it re-creates
-- in place. Every one of them must be SECURITY DEFINER with an empty
-- search_path and executable by service_role alone.
owned_fn(name) as (
  values ('record_order_delivery'),
         ('admin_mark_order_delivered'),
         ('annual_plan_delivery_freeze_active'),
         ('claim_due_annual_plan_deliveries'),
         ('freeze_annual_deliveries_for_withdrawal'),
         ('admin_set_withdrawal_seal_state'),
         ('admin_set_withdrawal_return_requirement'),
         ('admin_record_withdrawal_return'),
         ('admin_confirm_withdrawal_value_loss'),
         ('admin_approve_withdrawal_refund'),
         ('admin_record_withdrawal_refund_execution'),
         ('admin_record_withdrawal_refund_failure'),
         ('admin_advance_complaint'),
         ('admin_review_termination'),
         ('admin_create_purchase_restriction'),
         ('admin_lift_purchase_restriction'),
         -- The residual pass: the structured item resolution a partial
         -- refund is derived from, and the three that make the
         -- completion mail send exactly once.
         ('admin_resolve_withdrawal_item'),
         ('claim_withdrawal_refund_completed_email'),
         ('mark_withdrawal_refund_completed_email_sent'),
         ('mark_withdrawal_refund_completed_email_failed')
),
tbl as (
  select table_name::text as table_name
  from information_schema.tables
  where table_schema = 'public' and table_type = 'BASE TABLE'
),
ord_cols as (
  select column_name::text as column_name from information_schema.columns
  where table_schema = 'public' and table_name = 'orders'
),
wr_cols as (
  select column_name::text as column_name from information_schema.columns
  where table_schema = 'public' and table_name = 'withdrawal_requests'
),
-- The four tables no browser role may touch at all after 070.
rights_tbl(name) as (
  values ('withdrawal_requests'), ('complaint_requests'),
         ('termination_requests'), ('purchase_restrictions')
),
checks as (

  -- ── DID EVERYTHING ARRIVE ─────────────────────────────────

  select 10 as ord, 'shape' as area,
         'all four receipt columns are on orders' as check_name,
         'delivered_at, delivery_receipt_source, delivery_recorded_at, delivery_recorded_by' as expected,
         (select coalesce(string_agg(column_name, ', ' order by column_name), '<none>')
            from ord_cols where column_name in
              ('delivered_at', 'delivery_receipt_source',
               'delivery_recorded_at', 'delivery_recorded_by')) as actual,
         case when (select count(*) from ord_cols where column_name in
                     ('delivered_at', 'delivery_receipt_source',
                      'delivery_recorded_at', 'delivery_recorded_by')) = 4
              then 'PASS' else 'FAIL' end as verdict

  -- Seventeen: the ten earlier passes established, plus the five that
  -- record WHICH goods and how many a case is about (with the partial
  -- outbound-shipping decision) and the two that track the completion
  -- mail. A missing one means a half-applied migration.
  union all
  select 11, 'shape',
         'all seventeen withdrawal case columns are present',
         'the ten case/refund columns, the five item-resolution columns and the two completion-mail columns',
         (select count(*)::text || ' of 17: '
                 || coalesce(string_agg(column_name, ', ' order by column_name), '<none>')
            from wr_cols where column_name in
              ('case_state', 'timeliness', 'deadline_date', 'seal_state',
               'return_requirement', 'refund_state', 'refund_provider_reference',
               'refund_failure_reason', 'deliveries_frozen_at',
               'deliveries_permanently_stopped_at',
               'resolved_order_item_id', 'resolved_item_quantity',
               'partial_shipping_treatment', 'item_resolution_by',
               'item_resolution_at', 'refund_completed_email_status',
               'refund_completed_email_sent_at')),
         case when (select count(*) from wr_cols where column_name in
                     ('case_state', 'timeliness', 'deadline_date', 'seal_state',
                      'return_requirement', 'refund_state', 'refund_provider_reference',
                      'refund_failure_reason', 'deliveries_frozen_at',
                      'deliveries_permanently_stopped_at',
                      'resolved_order_item_id', 'resolved_item_quantity',
                      'partial_shipping_treatment', 'item_resolution_by',
                      'item_resolution_at', 'refund_completed_email_status',
                      'refund_completed_email_sent_at')) = 17
              then 'PASS' else 'FAIL' end

  union all
  select 12, 'shape',
         'all three new tables exist',
         'complaint_requests, termination_requests, purchase_restrictions',
         (select coalesce(string_agg(table_name, ', ' order by table_name), '<none>')
            from tbl where table_name in
              ('complaint_requests', 'termination_requests', 'purchase_restrictions')),
         case when (select count(*) from tbl where table_name in
                     ('complaint_requests', 'termination_requests',
                      'purchase_restrictions')) = 3
              then 'PASS' else 'FAIL' end

  union all
  select 13, 'shape',
         'all twenty functions 070 owns exist, exactly once each',
         '20 names, each resolving to exactly one function',
         (select count(*)::text || ' of 20 present'
            from owned_fn o where exists (select 1 from fn where fn.proname = o.name)),
         case when (select count(*) from owned_fn o
                      where (select count(*) from fn where fn.proname = o.name) = 1) = 20
              then 'PASS' else 'FAIL' end

  -- SECURITY DEFINER WITH AN EMPTY search_path, ON ALL SIXTEEN.
  --
  -- A SECURITY DEFINER function whose search_path is not emptied can be
  -- redirected by whoever calls it, which for these twenty means
  -- redirecting a refund or a receipt. The empty value is rendered as
  -- search_path= or search_path="" depending on how it was written, so
  -- the value is extracted after the first '=', unquoted, and required
  -- to be empty - the same robust form the preflight uses, and for the
  -- same reason: matching one literal spelling would raise a false
  -- alarm on a function that is in fact configured correctly.
  --
  -- split_part, NOT substring(... from ...): the SQL-standard form
  -- cannot be schema-qualified, which makes it unsafe in a statement
  -- that must survive a hostile search_path.
  union all
  select 14, 'shape',
         'every one of the twenty is SECURITY DEFINER with an EMPTY search_path',
         'all 20 with prosecdef true and search_path set to the empty string',
         (select count(*)::text || ' of 20 correct - offenders: '
                 || coalesce((select string_agg(distinct f2.proname, ', ' order by f2.proname)
                                from fn f2
                                join owned_fn o2 on o2.name = f2.proname
                               where not f2.prosecdef
                                  or not exists (
                                       select 1 from unnest(coalesce(f2.proconfig, array[]::text[])) as cfg
                                       where cfg like 'search_path=%'
                                         and pg_catalog.btrim(pg_catalog.split_part(cfg, '=', 2), '"') = '')),
                             'none')
            from fn f
            join owned_fn o on o.name = f.proname
           where f.prosecdef
             and exists (
                   select 1 from unnest(coalesce(f.proconfig, array[]::text[])) as cfg
                   where cfg like 'search_path=%'
                     and pg_catalog.btrim(pg_catalog.split_part(cfg, '=', 2), '"') = '')),
         case when (select count(*) from fn f
                      join owned_fn o on o.name = f.proname
                     where not f.prosecdef
                        or not exists (
                             select 1 from unnest(coalesce(f.proconfig, array[]::text[])) as cfg
                             where cfg like 'search_path=%'
                               and pg_catalog.btrim(pg_catalog.split_part(cfg, '=', 2), '"') = '')) = 0
                   and (select count(*) from fn f
                          join owned_fn o on o.name = f.proname) = 20
              then 'PASS' else 'FAIL' end

  union all
  select 20, 'shape',
         'all nine constraints 070 adds exist',
         'the receipt pairing, the admin-source actor rule, the value-loss triple, the refund-execution evidence rule, the item-resolution quadruple, the partial-shipping scope rule, the completion-mail pairing, the extraordinary-reason rule, the lift-needs-actor rule',
         (select count(*)::text || ' of 9: '
                 || coalesce(string_agg(conname::text, ', ' order by conname::text), '<none>')
            from pg_catalog.pg_constraint
            where conname in ('orders_delivery_receipt_shape_check',
                              'orders_delivery_admin_source_requires_actor_check',
                              'withdrawal_requests_value_loss_decision_shape_check',
                              'withdrawal_requests_refund_execution_shape_check',
                              'withdrawal_requests_item_resolution_shape_check',
                              'withdrawal_requests_partial_shipping_scope_check',
                              'withdrawal_requests_refund_completed_email_shape_check',
                              'termination_requests_extraordinary_needs_reason_check',
                              'purchase_restrictions_lift_shape_check')),
         case when (select count(*) from pg_catalog.pg_constraint
                      where conname in ('orders_delivery_receipt_shape_check',
                                        'orders_delivery_admin_source_requires_actor_check',
                                        'withdrawal_requests_value_loss_decision_shape_check',
                                        'withdrawal_requests_refund_execution_shape_check',
                                        'withdrawal_requests_item_resolution_shape_check',
                                        'withdrawal_requests_partial_shipping_scope_check',
                                        'withdrawal_requests_refund_completed_email_shape_check',
                                        'termination_requests_extraordinary_needs_reason_check',
                                        'purchase_restrictions_lift_shape_check')) = 9
              then 'PASS' else 'FAIL' end

  union all
  select 21, 'shape',
         'all twelve indexes 070 creates exist',
         '12 indexes in schema public, including the two that enforce correctness',
         (select count(*)::text || ' of 12'
            from pg_indexes
            where schemaname = 'public'
              and indexname in (
                'idx_orders_delivered_at',
                'idx_withdrawal_requests_case_state',
                'idx_withdrawal_requests_resolved_order',
                'idx_withdrawal_requests_frozen_plan',
                'withdrawal_requests_idempotency_key',
                'withdrawal_requests_refund_operation_key',
                'complaint_requests_idempotency_key',
                'idx_complaint_requests_submitted_at',
                'termination_requests_idempotency_key',
                'idx_termination_requests_submitted_at',
                'purchase_restrictions_one_active_per_scope_key',
                'idx_purchase_restrictions_user')),
         case when (select count(*) from pg_indexes
                      where schemaname = 'public'
                        and indexname in (
                          'idx_orders_delivered_at',
                          'idx_withdrawal_requests_case_state',
                          'idx_withdrawal_requests_resolved_order',
                          'idx_withdrawal_requests_frozen_plan',
                          'withdrawal_requests_idempotency_key',
                          'withdrawal_requests_refund_operation_key',
                          'complaint_requests_idempotency_key',
                          'idx_complaint_requests_submitted_at',
                          'termination_requests_idempotency_key',
                          'idx_termination_requests_submitted_at',
                          'purchase_restrictions_one_active_per_scope_key',
                          'idx_purchase_restrictions_user')) = 12
              then 'PASS' else 'FAIL' end

  -- THE ONE CONSTRAINT 070 REPLACED RATHER THAN ADDED.
  --
  -- The mirror of preflight check 27. Before: six values. After: seven,
  -- with customer_rights. Without this widening every one of the eleven
  -- audited admin writers would raise and roll back - which is exactly
  -- how a real PostgreSQL apply found the problem in the first place.
  union all
  select 22, 'shape',
         'the audit module CHECK now admits customer_rights',
         'the seven-value version, including customer_rights',
         coalesce((select pg_catalog.pg_get_constraintdef(con.oid)
                     from pg_catalog.pg_constraint con
                     join pg_catalog.pg_class c on c.oid = con.conrelid
                     join pg_catalog.pg_namespace n on n.oid = c.relnamespace
                     where n.nspname = 'public' and c.relname = 'admin_activity_log'
                       and con.conname = 'admin_activity_log_module_check'), '<missing>'),
         case when (select count(*) from pg_catalog.pg_constraint con
                      join pg_catalog.pg_class c on c.oid = con.conrelid
                      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
                      where n.nspname = 'public' and c.relname = 'admin_activity_log'
                        and con.conname = 'admin_activity_log_module_check'
                        and pg_catalog.pg_get_constraintdef(con.oid) like '%customer_rights%'
                        and pg_catalog.pg_get_constraintdef(con.oid) like '%fulfillment%') = 1
              then 'PASS' else 'FAIL' end

  -- BOTH OF 070's QUEUE PREDICATES ARRIVED.
  --
  -- The delivery queue is the one pre-existing function 070 rewrites, so
  -- this is where a half-applied migration would be most expensive: a
  -- queue missing the freeze predicate keeps shipping to a customer who
  -- has withdrawn, and one missing the one-in-flight predicate mints a
  -- whole frozen backlog in a single pass.
  union all
  select 23, 'shape',
         'the delivery queue carries BOTH predicates 070 adds',
         'the freeze predicate AND the one-in-flight predicate',
         coalesce((select 'freeze=' || (prosrc like '%annual_plan_delivery_freeze_active%')::text
                        || ' one_in_flight=' || (prosrc like '%e.state in (''scheduled'', ''claimed'')%')::text
                     from fn where proname = 'claim_due_annual_plan_deliveries' limit 1), '<missing>'),
         case when (select count(*) from fn
                      where proname = 'claim_due_annual_plan_deliveries'
                        and prosrc like '%annual_plan_delivery_freeze_active%'
                        and prosrc like '%e.state in (''scheduled'', ''claimed'')%') = 1
              then 'PASS' else 'FAIL' end

  -- AND IT DID NOT LOSE ANYTHING MIGRATION 039 PUT THERE.
  union all
  select 24, 'shape',
         'the delivery queue still carries every marker 039 relied on',
         'skip locked, the refunded exclusion, the 6 hour lease, the limit clamp',
         coalesce((select 'skip_locked=' || (prosrc like '%skip locked%')::text
                        || ' refunded=' || (prosrc like '%payment_status <> ''refunded''%')::text
                        || ' lease=' || (prosrc like '%6 hours%')::text
                        || ' clamp=' || (prosrc like '%least(greatest%')::text
                     from fn where proname = 'claim_due_annual_plan_deliveries' limit 1), '<missing>'),
         case when (select count(*) from fn
                      where proname = 'claim_due_annual_plan_deliveries'
                        and prosrc like '%skip locked%'
                        and prosrc like '%payment_status <> ''refunded''%'
                        and prosrc like '%6 hours%'
                        and prosrc like '%least(greatest%') = 1
              then 'PASS' else 'FAIL' end

  union all
  select 25, 'shape',
         'and its identity and result type are unchanged, so the worker still resolves it',
         'claim_due_annual_plan_deliveries(p_limit integer) returning the five-column table',
         coalesce((select ident || ' -> ' || pg_catalog.pg_get_function_result(oid)
                     from fn where proname = 'claim_due_annual_plan_deliveries' limit 1), '<missing>'),
         case when (select count(*) from fn
                      where proname = 'claim_due_annual_plan_deliveries'
                        and ident = 'p_limit integer'
                        and pg_catalog.pg_get_function_result(oid) like '%delivery_id uuid%'
                        and pg_catalog.pg_get_function_result(oid) like '%reclaimed boolean%') = 1
              then 'PASS' else 'FAIL' end

  -- ── AND THE BROWSER GAINED NOTHING ────────────────────────
  --
  -- THE STRICT ONE. Before 070, anon and authenticated held REFERENCES,
  -- TRIGGER and TRUNCATE on withdrawal_requests - inherited from
  -- Supabase's ALTER DEFAULT PRIVILEGES when migration 018 created the
  -- table, never revoked, and missed by migration 023 which fixed the
  -- identical problem on three other tables. Section 6a/6b is what takes
  -- them back, on that table and on the three new ones.
  --
  -- ZERO privileges of ANY kind, not merely zero row privileges. RLS
  -- filters rows; it does not stop TRUNCATE, and a role that can
  -- truncate this table can destroy the evidence that a consumer ever
  -- declared a withdrawal.
  union all
  select 30, 'privs',
         'anon and authenticated hold ZERO privileges on all four rights tables',
         'not one row in table_privileges for either browser role',
         (select coalesce(string_agg(distinct table_name::text || ':' || grantee::text
                                     || ':' || privilege_type::text, ', '), 'none')
            from information_schema.table_privileges
            where table_schema = 'public'
              and table_name in (select name from rights_tbl)
              and grantee in ('anon', 'authenticated')),
         case when (select count(*) from information_schema.table_privileges
                      where table_schema = 'public'
                        and table_name in (select name from rights_tbl)
                        and grantee in ('anon', 'authenticated')) = 0
              then 'PASS' else 'FAIL' end

  union all
  select 31, 'privs',
         'service_role can still read and write all four rights tables',
         'SELECT and INSERT on each of the four',
         (select count(*)::text || ' of 8 (SELECT+INSERT x 4 tables)'
            from information_schema.table_privileges
            where table_schema = 'public'
              and table_name in (select name from rights_tbl)
              and grantee = 'service_role'
              and privilege_type in ('SELECT', 'INSERT')),
         case when (select count(*) from information_schema.table_privileges
                      where table_schema = 'public'
                        and table_name in (select name from rights_tbl)
                        and grantee = 'service_role'
                        and privilege_type in ('SELECT', 'INSERT')) = 8
              then 'PASS' else 'FAIL' end

  -- NO BROWSER ROLE MAY EXECUTE ANY OF THE SIXTEEN.
  --
  -- has_function_privilege is the authoritative answer here, because it
  -- accounts for the PUBLIC grant that EXECUTE carries by default - a
  -- revoke from anon alone would leave the function reachable through
  -- PUBLIC, which is why 070 revokes from public, anon AND authenticated.
  union all
  select 32, 'privs',
         'neither browser role can EXECUTE any of the twenty functions',
         'zero of 40 (20 functions x 2 roles)',
         (select count(*)::text || ' reachable: '
                 || coalesce((select string_agg(distinct f2.proname || ':' || r2.role, ', ')
                                from fn f2
                                join owned_fn o2 on o2.name = f2.proname
                                cross join (values ('anon'), ('authenticated')) as r2(role)
                               where pg_catalog.has_function_privilege(r2.role, f2.oid, 'EXECUTE')),
                             'none')
            from fn f
            join owned_fn o on o.name = f.proname
            cross join (values ('anon'), ('authenticated')) as r(role)
           where pg_catalog.has_function_privilege(r.role, f.oid, 'EXECUTE')),
         case when (select count(*) from fn f
                      join owned_fn o on o.name = f.proname
                      cross join (values ('anon'), ('authenticated')) as r(role)
                     where pg_catalog.has_function_privilege(r.role, f.oid, 'EXECUTE')) = 0
              then 'PASS' else 'FAIL' end

  union all
  select 33, 'privs',
         'service_role CAN execute all twenty - the server is the only caller',
         'all 20 executable by service_role',
         (select count(*)::text || ' of 20'
            from fn f join owned_fn o on o.name = f.proname
           where pg_catalog.has_function_privilege('service_role', f.oid, 'EXECUTE')),
         case when (select count(*) from fn f join owned_fn o on o.name = f.proname
                      where pg_catalog.has_function_privilege('service_role', f.oid, 'EXECUTE')) = 20
              then 'PASS' else 'FAIL' end

  -- ── AND NOTHING ELSE MOVED ────────────────────────────────

  union all
  select 40, 'data',
         'no order was backfilled with a delivery receipt',
         'zero orders carry delivered_at - a receipt is a fact somebody recorded, never a default',
         (select count(*)::text || ' of ' || (select count(*) from public.orders)::text
                 || ' orders carry delivered_at'
            from public.orders where delivered_at is not null),
         case when (select count(*) from public.orders where delivered_at is not null) = 0
              then 'PASS' else 'FAIL' end

  union all
  select 41, 'data',
         'every historical withdrawal declaration still sits at the defaults',
         'every row submitted / receipt_unknown / not_started - 070 advances no case',
         (select coalesce(string_agg(case_state || '/' || timeliness || '/' || refund_state
                                     || ' x' || n::text, ', '), 'no rows')
            from (select case_state, timeliness, refund_state, count(*) as n
                    from public.withdrawal_requests
                   group by 1, 2, 3) g),
         case when (select count(*) from public.withdrawal_requests
                      where case_state <> 'submitted'
                         or timeliness <> 'receipt_unknown'
                         or refund_state <> 'not_started') = 0
              then 'PASS' else 'FAIL' end

  -- THE EVIDENCE RULE HOLDS FOR EVERY ROW THAT EXISTS.
  --
  -- The constraint guarantees this going forward; this confirms it of
  -- the rows already there, which is the part a constraint added to an
  -- existing table can only promise if the data agreed.
  union all
  select 42, 'data',
         'no row claims an executed refund without the provider evidence',
         'zero rows where refund_state = executed but a reference or a timestamp is missing',
         (select count(*)::text || ' violating rows'
            from public.withdrawal_requests
           where (refund_state = 'executed'
                  and (refund_executed_at is null or refund_provider_reference is null))
              or (refund_state <> 'executed'
                  and (refund_executed_at is not null or refund_provider_reference is not null))),
         case when (select count(*) from public.withdrawal_requests
                      where (refund_state = 'executed'
                             and (refund_executed_at is null or refund_provider_reference is null))
                         or (refund_state <> 'executed'
                             and (refund_executed_at is not null
                                  or refund_provider_reference is not null))) = 0
              then 'PASS' else 'FAIL' end

  union all
  select 43, 'data',
         'the three new tables are empty, no plan stopped, nothing resolved, no mail sent',
         'zero of everything - 070 creates no case, resolves no item and sends no message',
         (select (select count(*) from public.complaint_requests)::text || ' complaints, '
                 || (select count(*) from public.termination_requests)::text || ' terminations, '
                 || (select count(*) from public.purchase_restrictions)::text || ' restrictions, '
                 || (select count(*) from public.withdrawal_requests
                      where deliveries_permanently_stopped_at is not null)::text || ' stops, '
                 || (select count(*) from public.withdrawal_requests
                      where resolved_order_item_id is not null)::text || ' resolved, '
                 || (select count(*) from public.withdrawal_requests
                      where refund_completed_email_status is not null)::text || ' mails'),
         case when (select count(*) from public.complaint_requests)
                 + (select count(*) from public.termination_requests)
                 + (select count(*) from public.purchase_restrictions)
                 + (select count(*) from public.withdrawal_requests
                     where deliveries_permanently_stopped_at is not null)
                 + (select count(*) from public.withdrawal_requests
                     where resolved_order_item_id is not null)
                 + (select count(*) from public.withdrawal_requests
                     where refund_completed_email_status is not null) = 0
              then 'PASS' else 'FAIL' end

  -- ── CONTEXT ───────────────────────────────────────────────

  union all
  select 50, 'data',
         'INFO: orders on hand, and how many were ever dispatched',
         'context only - the first receipt has to be recorded by a human',
         (select count(*)::text || ' orders, '
                 || (select count(*) from public.orders where shipped_at is not null)::text
                 || ' shipped' from public.orders),
         'INFO'

  union all
  select 51, 'data',
         'INFO: withdrawal declarations now carrying the case machinery',
         'each one starts at submitted and needs a receipt before a deadline exists',
         (select count(*)::text from public.withdrawal_requests),
         'INFO'

  union all
  select 52, 'data',
         'INFO: live annual plans, and how many are held by a withdrawal',
         'a held plan produces no new delivery until its case resolves',
         (select (select count(*) from public.annual_plans where status = 'active')::text
                 || ' active plans, '
                 || (select count(*) from public.withdrawal_requests
                      where deliveries_frozen_at is not null)::text || ' frozen'),
         'INFO'

  union all
  select 53, 'privs',
         'INFO: what service_role now holds on the four rights tables',
         'context only - the server is the only role that may touch them',
         (select coalesce(string_agg(distinct privilege_type::text, ', '
                                     order by privilege_type::text), 'none')
            from information_schema.table_privileges
            where table_schema = 'public'
              and table_name in (select name from rights_tbl)
              and grantee = 'service_role'),
         'INFO'
)
select ord, area, check_name, expected, actual, verdict from checks
union all
select 999, 'SUMMARY', 'migration 070 postcheck', 'zero FAIL rows',
       (count(*) filter (where verdict = 'FAIL'))::text || ' FAIL / '
         || (count(*) filter (where verdict = 'PASS'))::text || ' PASS / '
         || (count(*) filter (where verdict = 'INFO'))::text || ' INFO',
       case when count(*) filter (where verdict = 'FAIL') = 0
            then 'APPLIED CLEANLY' else 'SOMETHING IS WRONG' end
from checks
order by ord;
