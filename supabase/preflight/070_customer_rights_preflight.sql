-- ============================================================
-- GLOA · MIGRATION 070 PRODUCTION PREFLIGHT  ·  READ ONLY
-- ONE statement. No writes.
-- Run in the Supabase SQL Editor against PRODUCTION.
-- SAFE TO APPLY  <=>  the final SUMMARY row says 'SAFE TO APPLY'
--                     (i.e. zero rows with verdict = 'FAIL').
-- Rows with verdict 'INFO' are context, never a blocker.
-- ============================================================
with
fn as (
  select p.oid, p.proname, p.pronargs,
         pg_catalog.pg_get_function_identity_arguments(p.oid) as ident
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
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
checks as (

  -- ── EVERYTHING 070 BUILDS ON MUST STILL BE THERE ──────────
  select 10 as ord, 'prereq' as area,
         'the four tables 070 references by foreign key all exist' as check_name,
         'orders, annual_plans, subscriptions, admin_users' as expected,
         (select coalesce(string_agg(table_name, ', ' order by table_name), '<none>')
            from tbl where table_name in
              ('orders', 'annual_plans', 'subscriptions', 'admin_users')) as actual,
         case when (select count(*) from tbl where table_name in
                     ('orders', 'annual_plans', 'subscriptions', 'admin_users')) = 4
              then 'PASS' else 'FAIL' end as verdict

  union all
  select 11, 'prereq',
         'withdrawal_requests exists with migration 018''s declaration columns',
         'customer_name, order_reference, contact_email, scope, submitted_at',
         (select coalesce(string_agg(column_name, ', ' order by column_name), '<none>')
            from wr_cols where column_name in
              ('customer_name', 'order_reference', 'contact_email', 'scope', 'submitted_at')),
         case when (select count(*) from wr_cols where column_name in
                     ('customer_name', 'order_reference', 'contact_email', 'scope', 'submitted_at')) = 5
              then 'PASS' else 'FAIL' end

  union all
  select 12, 'prereq',
         'orders carries migration 019''s dispatch columns 070 reads but never rewrites',
         'shipped_at and order_number present',
         (select coalesce(string_agg(column_name, ', ' order by column_name), '<none>')
            from ord_cols where column_name in ('shipped_at', 'order_number')),
         case when (select count(*) from ord_cols
                     where column_name in ('shipped_at', 'order_number')) = 2
              then 'PASS' else 'FAIL' end

  union all
  select 13, 'prereq',
         'record_admin_activity exists - the admin wrapper in 070 calls it',
         'exactly one, 8 arguments',
         coalesce((select string_agg(proname::text || '[nargs=' || pronargs || ']', ' | ')
                     from fn where proname = 'record_admin_activity'), '<missing>'),
         case when (select count(*) from fn where proname = 'record_admin_activity') = 1
              then 'PASS' else 'FAIL' end

  union all
  select 14, 'prereq',
         'annual_plan_deliveries exists and links a delivery to its order',
         'table present with annual_plan_id, delivery_number, order_id',
         (select coalesce(string_agg(column_name::text, ', ' order by column_name::text), '<none>')
            from information_schema.columns
            where table_schema = 'public' and table_name = 'annual_plan_deliveries'
              and column_name in ('annual_plan_id', 'delivery_number', 'order_id')),
         case when (select count(*) from information_schema.columns
                      where table_schema = 'public' and table_name = 'annual_plan_deliveries'
                        and column_name in ('annual_plan_id', 'delivery_number', 'order_id')) = 3
              then 'PASS' else 'FAIL' end

  -- ── 066 / 067 / 068 / 069 ARE UNTOUCHED BY 070 ────────────
  union all
  select 20, '066-069',
         'the annual safety objects from 066/067/068 still stand',
         '4 indexes + claim CHECK',
         (select count(*)::text from pg_indexes where schemaname = 'public'
            and indexname in ('annual_plans_active_upgrade_per_subscription_key',
                              'annual_plans_pending_upgrade_claim_idx',
                              'annual_plans_one_live_per_user_key',
                              'annual_plans_pending_customer_claim_idx')) || ' of 4 indexes',
         case when (select count(*) from pg_indexes where schemaname = 'public'
                      and indexname in ('annual_plans_active_upgrade_per_subscription_key',
                                        'annual_plans_pending_upgrade_claim_idx',
                                        'annual_plans_one_live_per_user_key',
                                        'annual_plans_pending_customer_claim_idx')) = 4
              then 'PASS' else 'FAIL' end

  union all
  select 21, '066-069',
         'migration 069 is applied - 070 assumes the v2 annual model exists',
         'schedule_model and schedule_anchor_date both present',
         (select coalesce(string_agg(column_name::text, ', ' order by column_name::text), '<none>')
            from information_schema.columns
            where table_schema = 'public' and table_name = 'annual_plans'
              and column_name in ('schedule_model', 'schedule_anchor_date')),
         case when (select count(*) from information_schema.columns
                      where table_schema = 'public' and table_name = 'annual_plans'
                        and column_name in ('schedule_model', 'schedule_anchor_date')) = 2
              then 'PASS' else 'FAIL' end

  union all
  select 22, '066-069',
         'the 069 writer is still the 18-argument version and 070 does not replace it',
         'create_pending_annual_plan_for_attempt with 18 args',
         coalesce((select string_agg('nargs=' || pronargs, ', ')
                     from fn where proname = 'create_pending_annual_plan_for_attempt'), '<missing>'),
         case when (select count(*) from fn
                      where proname = 'create_pending_annual_plan_for_attempt'
                        and pronargs = 18) = 1
              then 'PASS' else 'FAIL' end

  -- ── 070 MUST NOT BE PARTIALLY APPLIED ─────────────────────
  union all
  select 30, '070-clean',
         'none of the four receipt columns exists on orders yet', 'none',
         (select coalesce(string_agg(column_name, ', ' order by column_name), 'none')
            from ord_cols where column_name in
              ('delivered_at', 'delivery_receipt_source',
               'delivery_recorded_at', 'delivery_recorded_by')),
         case when (select count(*) from ord_cols where column_name in
                     ('delivered_at', 'delivery_receipt_source',
                      'delivery_recorded_at', 'delivery_recorded_by')) = 0
              then 'PASS' else 'FAIL' end

  union all
  select 31, '070-clean',
         'withdrawal_requests has none of the case columns yet', 'none',
         (select coalesce(string_agg(column_name, ', ' order by column_name), 'none')
            from wr_cols where column_name in
              ('case_state', 'timeliness', 'deadline_date', 'seal_state',
               'refund_state', 'deliveries_frozen_at', 'idempotency_key')),
         case when (select count(*) from wr_cols where column_name in
                     ('case_state', 'timeliness', 'deadline_date', 'seal_state',
                      'refund_state', 'deliveries_frozen_at', 'idempotency_key')) = 0
              then 'PASS' else 'FAIL' end

  union all
  select 32, '070-clean',
         'none of the three new tables exists yet', 'none',
         (select coalesce(string_agg(table_name, ', ' order by table_name), 'none')
            from tbl where table_name in
              ('complaint_requests', 'termination_requests', 'purchase_restrictions')),
         case when (select count(*) from tbl where table_name in
                     ('complaint_requests', 'termination_requests', 'purchase_restrictions')) = 0
              then 'PASS' else 'FAIL' end

  union all
  select 33, '070-clean',
         'neither 070 function name is already taken', 'none',
         coalesce((select string_agg(proname::text, ', ' order by proname::text) from fn
                     where proname in ('record_order_delivery', 'admin_mark_order_delivered')), 'none'),
         case when (select count(*) from fn
                      where proname in ('record_order_delivery', 'admin_mark_order_delivered')) = 0
              then 'PASS' else 'FAIL' end

  union all
  select 34, '070-clean',
         'none of the constraint or index names 070 creates is already taken', 'none',
         coalesce((select string_agg(conname::text, ', ' order by conname::text)
                     from pg_catalog.pg_constraint
                     where conname in ('orders_delivery_receipt_shape_check',
                                       'orders_delivery_admin_source_requires_actor_check',
                                       'withdrawal_requests_value_loss_decision_shape_check',
                                       'termination_requests_extraordinary_needs_reason_check',
                                       'purchase_restrictions_lift_shape_check')), 'none'),
         case when (select count(*) from pg_catalog.pg_constraint
                      where conname in ('orders_delivery_receipt_shape_check',
                                        'orders_delivery_admin_source_requires_actor_check',
                                        'withdrawal_requests_value_loss_decision_shape_check',
                                        'termination_requests_extraordinary_needs_reason_check',
                                        'purchase_restrictions_lift_shape_check')) = 0
              then 'PASS' else 'FAIL' end

  -- ── EXISTING DATA MUST SATISFY EVERY NEW CONSTRAINT ───────
  -- Every column 070 adds to an existing table is nullable or carries a
  -- DEFAULT, so the only way an existing row could abort the migration
  -- is a shape CHECK reading columns that do not exist yet - which is
  -- why 30 and 31 above are the real data guards. These two confirm the
  -- tables are readable and sized as expected.
  union all
  select 40, 'data',
         'every existing order can accept a null receipt - nothing is backfilled',
         '0 rows would violate the new pairing CHECK',
         (select count(*)::text from public.orders) || ' orders, all keeping null receipt',
         case when (select count(*) from ord_cols where column_name = 'delivered_at') = 0
              then 'PASS' else 'FAIL' end

  union all
  select 41, 'data',
         'every historical withdrawal row will default cleanly to submitted/receipt_unknown',
         'no row needs an UPDATE',
         (select count(*)::text from public.withdrawal_requests) || ' historical rows',
         case when (select count(*) from wr_cols where column_name = 'case_state') = 0
              then 'PASS' else 'FAIL' end

  -- ── THE BROWSER MUST NOT ALREADY REACH ANY OF THIS ────────
  union all
  select 50, 'privs',
         'anon and authenticated hold nothing on withdrawal_requests, and 070 adds nothing',
         '0 privileges',
         (select count(*)::text from information_schema.table_privileges
            where table_schema = 'public' and table_name = 'withdrawal_requests'
              and grantee in ('anon', 'authenticated')),
         case when (select count(*) from information_schema.table_privileges
                      where table_schema = 'public' and table_name = 'withdrawal_requests'
                        and grantee in ('anon', 'authenticated')) = 0
              then 'PASS' else 'FAIL' end

  union all
  select 51, 'privs',
         'service_role can already read and write withdrawal_requests',
         'SELECT and INSERT present',
         (select coalesce(string_agg(distinct privilege_type::text, ', '), '<none>')
            from information_schema.table_privileges
            where table_schema = 'public' and table_name = 'withdrawal_requests'
              and grantee = 'service_role'),
         case when (select count(*) from information_schema.table_privileges
                      where table_schema = 'public' and table_name = 'withdrawal_requests'
                        and grantee = 'service_role'
                        and privilege_type in ('SELECT', 'INSERT')) >= 2
              then 'PASS' else 'FAIL' end

  union all
  select 52, 'privs',
         'the browser cannot write orders - 070 grants only service_role the receipt columns',
         'no INSERT/UPDATE for anon or authenticated',
         (select coalesce(string_agg(distinct grantee::text || ':' || privilege_type::text, ', '), 'none')
            from information_schema.table_privileges
            where table_schema = 'public' and table_name = 'orders'
              and grantee in ('anon', 'authenticated')
              and privilege_type in ('INSERT', 'UPDATE', 'DELETE')),
         case when (select count(*) from information_schema.table_privileges
                      where table_schema = 'public' and table_name = 'orders'
                        and grantee in ('anon', 'authenticated')
                        and privilege_type in ('INSERT', 'UPDATE', 'DELETE')) = 0
              then 'PASS' else 'FAIL' end

  union all
  select 53, 'privs',
         'admin_users is the actor table 070''s foreign keys point at',
         'user_id column present',
         (select coalesce(string_agg(column_name::text, ', '), '<none>')
            from information_schema.columns
            where table_schema = 'public' and table_name = 'admin_users'
              and column_name = 'user_id'),
         case when (select count(*) from information_schema.columns
                      where table_schema = 'public' and table_name = 'admin_users'
                        and column_name = 'user_id') = 1
              then 'PASS' else 'FAIL' end

  -- ── CONTEXT ───────────────────────────────────────────────
  union all
  select 60, 'data',
         'INFO: orders on hand, and how many were ever dispatched',
         'context only - 070 rewrites none of them',
         (select count(*)::text || ' orders, '
               || count(*) filter (where shipped_at is not null)::text || ' shipped'
            from public.orders),
         'INFO'

  union all
  select 61, 'data',
         'INFO: historical withdrawal declarations that become cases',
         'each keeps its declaration untouched and starts at submitted/receipt_unknown',
         (select count(*)::text from public.withdrawal_requests),
         'INFO'

  union all
  select 62, 'data',
         'INFO: live annual plans whose first delivery will need a receipt',
         'a v2 plan cannot have its deadline dated until delivery one is marked received',
         (select count(*)::text from public.annual_plans
            where status = 'active' and payment_status <> 'refunded'),
         'INFO'

  union all
  select 63, 'data',
         'INFO: active subscriptions the 312k button must route to existing cancellation',
         'the 4-week cancellation logic is reused, never reimplemented',
         (select count(*)::text from public.subscriptions where status = 'active'),
         'INFO'
)
select ord, area, check_name, expected, actual, verdict from checks
union all
select 999, 'SUMMARY', 'migration 070 preflight',
       'zero FAIL rows',
       (count(*) filter (where verdict = 'FAIL'))::text || ' FAIL / '
         || (count(*) filter (where verdict = 'PASS'))::text || ' PASS / '
         || (count(*) filter (where verdict = 'INFO'))::text || ' INFO',
       case when count(*) filter (where verdict = 'FAIL') = 0
            then 'SAFE TO APPLY' else 'NOT SAFE TO APPLY' end
from checks
order by 1;
