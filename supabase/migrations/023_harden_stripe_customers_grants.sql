-- ============================================================
-- GLOA – Bugfix: make the server-only tables genuinely server-only
-- (Task 29D-B.1)
-- Run in Supabase SQL Editor AFTER 022
--
-- Three tables in this project are meant to be reachable only by
-- server-side code holding the service-role key:
--
--   public.stripe_customers       (022)
--   public.checkout_attempts      (009)
--   public.stripe_webhook_events  (009)
--
-- All three were created the same way: RLS enabled, no policies, and
-- grants written only for service_role. That looked like enough, and on
-- stock PostgreSQL it would be. On Supabase it is not: the project ships
-- ALTER DEFAULT PRIVILEGES for the public schema, so a newly created
-- table arrives with privileges already handed to anon, authenticated and
-- service_role before any migration grants anything. A read-only query
-- against the live database confirmed it on all three - anon and
-- authenticated each holding REFERENCES, TRIGGER and TRUNCATE, and
-- service_role holding those on top of the privileges it was actually
-- given.
--
-- Why RLS did not cover this. Row-level security filters ROWS. TRUNCATE
-- removes every row without producing any, REFERENCES lets another table
-- point a foreign key at this one, and TRIGGER attaches code to it. None
-- of those are row reads or row writes, so neither a policy nor the
-- absence of policies constrains them. Table privileges and RLS are two
-- separate mechanisms - migration 010 already had to learn the mirror
-- image of that, when RLS without grants blocked service_role outright.
--
-- The pattern below is the same for each table: take everything back from
-- the three Supabase roles, then hand back only the privileges the
-- application actually uses. Those were read out of the code rather than
-- assumed; see the note above each grant.
--
-- Deliberately NOT done here: nothing touches the table owner, no policy
-- is created, no function privilege is altered, and schema-wide default
-- privileges are left alone. Changing those would silently affect every
-- other table in the project, present and future, and that belongs in a
-- dedicated audit rather than in a targeted fix.
--
-- Data is not touched. No row is read, written or deleted.
-- ============================================================

-- 1. STRIPE CUSTOMERS ──────────────────────────────────────────
--
-- The GLOA user to Stripe Customer mapping.
--
-- select  - read an existing mapping.
-- insert  - record one the first time a customer subscribes.
--
-- No update or delete. A mapping is written once; a user id that appears
-- to need a different Stripe Customer is a bug to investigate, not a row
-- to overwrite. The mapping disappears with the user through the cascade
-- from auth.users, which the owner performs, not service_role.

revoke all privileges on table public.stripe_customers
  from anon, authenticated, service_role;

grant select, insert on table public.stripe_customers to service_role;

-- 2. CHECKOUT ATTEMPTS ─────────────────────────────────────────
--
-- The authoritative pre-payment snapshot behind every order.
--
-- select  - lib/checkoutAttempts.ts reads attempts back by request id,
--           by session id and by id.
-- insert  - getOrCreateCheckoutAttempt creates the attempt.
-- update  - linkStripeSession and the paid transition both write to an
--           existing row.
--
-- No delete: nothing in the codebase removes an attempt, and an attempt
-- is the evidence behind a paid order.
--
-- This restores exactly what migration 010 granted. The revoke is what
-- changes: 010 added privileges without taking the default ones away.
--
-- Note that create_order_from_paid_checkout and
-- activate_subscription_from_invoice are unaffected either way. They are
-- security definer functions, so they act with their owner's privileges,
-- not with service_role's.

revoke all privileges on table public.checkout_attempts
  from anon, authenticated, service_role;

grant select, insert, update on table public.checkout_attempts to service_role;

-- 3. STRIPE WEBHOOK EVENTS ─────────────────────────────────────
--
-- The processed-event ledger that makes webhook delivery idempotent.
--
-- select  - hasStripeWebhookEventBeenProcessed checks for the id.
-- insert  - recordStripeWebhookEvent writes it after processing.
--
-- No update and no delete, deliberately, and 010 said why: a processed
-- marker that could be erased or rewritten would let an already-handled
-- Stripe event be replayed. The primary key is the race guard, and it
-- only works if nobody can undo it.

revoke all privileges on table public.stripe_webhook_events
  from anon, authenticated, service_role;

grant select, insert on table public.stripe_webhook_events to service_role;

-- 4. VERIFY ────────────────────────────────────────────────────
--
-- Read-only. Run after applying.
--
-- (a) The whole intended end state in one query, and the same query that
--     found the problem. Expected: exactly these seven rows, in this
--     order, with no anon row, no authenticated row, and no other
--     service_role privilege.
--
--       checkout_attempts      | service_role | INSERT
--       checkout_attempts      | service_role | SELECT
--       checkout_attempts      | service_role | UPDATE
--       stripe_customers       | service_role | INSERT
--       stripe_customers       | service_role | SELECT
--       stripe_webhook_events  | service_role | INSERT
--       stripe_webhook_events  | service_role | SELECT
--
--   select table_name, grantee, privilege_type
--   from information_schema.role_table_grants
--   where table_schema = 'public'
--     and table_name in ('stripe_customers', 'checkout_attempts',
--                        'stripe_webhook_events')
--     and grantee in ('anon', 'authenticated', 'service_role')
--   order by table_name, grantee, privilege_type;
--
-- (b) The same question asked of the raw ACL, which also shows the owner.
--     Expected: a service_role entry holding only r/a on stripe_customers
--     and stripe_webhook_events, and r/a/w on checkout_attempts. No anon
--     or authenticated entry on any of the three.
--
--   select relname,
--          coalesce(array_to_string(relacl, E'\n'), '(no explicit acl)') as acl
--   from pg_class
--   where relnamespace = 'public'::regnamespace
--     and relname in ('stripe_customers', 'checkout_attempts',
--                     'stripe_webhook_events')
--   order by relname;
--
-- (c) RLS is untouched and still has no policies on any of the three.
--     This migration changes neither, and both must remain true.
--
--   select relname, relrowsecurity, relforcerowsecurity
--   from pg_class
--   where relnamespace = 'public'::regnamespace
--     and relname in ('stripe_customers', 'checkout_attempts',
--                     'stripe_webhook_events')
--   order by relname;
--
--   select tablename, count(*) as policy_count
--   from pg_policies
--   where schemaname = 'public'
--     and tablename in ('stripe_customers', 'checkout_attempts',
--                       'stripe_webhook_events')
--   group by tablename
--   order by tablename;
--
-- (d) Nothing else moved. Expected: unchanged from before this migration -
--     authenticated keeps SELECT on the customer-facing tables, and anon
--     appears nowhere.
--
--   select table_name, grantee, privilege_type
--   from information_schema.role_table_grants
--   where table_schema = 'public'
--     and table_name in ('subscriptions', 'subscription_items',
--                        'orders', 'order_items', 'addresses', 'profiles')
--     and grantee in ('anon', 'authenticated')
--   order by table_name, grantee, privilege_type;
--
-- (e) The RPCs are untouched by this migration. Expected: service_role
--     only, on both, exactly as 022 left them.
--
--   select p.proname,
--          coalesce(array_to_string(p.proacl, E'\n'),
--                   '(default - PUBLIC can execute)') as acl
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public'
--     and p.proname in ('create_pending_subscription',
--                       'activate_subscription_from_invoice',
--                       'create_order_from_paid_checkout')
--   order by p.proname;
