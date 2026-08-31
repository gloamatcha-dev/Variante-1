-- ============================================================
-- GLOA - Annual account read surface, narrowed to columns (Phase 4B8.1)
-- Run in Supabase SQL Editor AFTER 040
--
-- Migrations 001-040 are LIVE, VERIFIED and IMMUTABLE. This file edits
-- none of them. It creates no table, no column, no index, no function,
-- no policy and no row: it is PRIVILEGES ONLY, and it only ever narrows
-- what a browser may read.
--
-- ── WHAT WENT WRONG, EXACTLY ──────────────────────────────────
--
-- Migration 039 gave the account area what it needed like this:
--
--     grant select on table public.annual_plans           to authenticated;
--     grant select on table public.annual_plan_deliveries to authenticated;
--
-- plus two owner-scoped RLS policies. RLS decides WHICH ROWS a customer
-- may read. It says nothing at all about WHICH COLUMNS.
--
-- So today an authenticated customer, holding their own Supabase client,
-- may run
--
--     select stripe_payment_intent_id,
--            purchase_confirmation_email_claim_token,
--            customer_snapshot
--     from annual_plans;
--
-- against their OWN plan and get all of it. Phase 4B8 added a named
-- column list in lib/annualPlanAccount.ts and a mapper that strips
-- everything else, and that is good application design - but it is not
-- authorization. The browser owns the client. It can ask for a different
-- select, and until this migration the database would answer.
--
-- What that currently hands over, per row a customer owns:
--
--   stripe_payment_intent_id        the refund identity of the plan. It
--                                   is what apply_annual_plan_refund_state
--                                   resolves by.
--   stripe_checkout_session_id      the Checkout Session.
--   payment_checkout_attempt_id     the idempotency anchor of the payment.
--   purchase_confirmation_email_
--     claim_token                   AUTHORITY TO RECORD AN EMAIL OUTCOME.
--                                   record_annual_plan_purchase_email_result
--                                   accepts this token as proof of
--                                   ownership of a live claim.
--   customer_snapshot,              frozen personal data, re-served to a
--     shipping/billing_address_       browser that never needed it from
--     snapshot                        here.
--   tax_snapshot,                   raw calculation input.
--     delivery_tax_snapshot
--   checkout_attempt_id (delivery)  internal fulfillment correlation.
--   claimed_at (delivery)           the worker lease. Queue state.
--
-- None of it is customer-facing, and the claim token is genuinely
-- dangerous: it is the one value in these tables that is a capability
-- rather than a fact.
--
-- ── WHAT THIS MIGRATION DOES ──────────────────────────────────
--
-- Replaces the two table-level SELECT grants with COLUMN-LEVEL SELECT
-- grants naming exactly the columns the account read model needs. After
-- it, `select *` fails for authenticated - a star expands to every
-- column, including ones with no grant - and each forbidden column fails
-- by name. The database becomes the boundary, and the application's
-- select list becomes what it should always have been: a convenience
-- that agrees with the ACL rather than a substitute for one.
--
-- ── WHAT IT DELIBERATELY DOES NOT DO ──────────────────────────
--
--   * It does not touch RLS. Both tables keep row-level security enabled
--     and keep migration 039's two SELECT policies, byte for byte. Rows
--     stay owner-scoped: annual_plans by auth.uid() = user_id, deliveries
--     by inheritance through the parent. COLUMN GRANTS AND RLS ARE NOT
--     ALTERNATIVES - after this file both are required, and each one
--     answers a different question.
--   * It does not touch service_role, whose table-level SELECT on both
--     tables is what the cron, the settlement path and the refund writer
--     read with. Narrowing that would break the server, and the server
--     never exposes these rows to a browser.
--   * It grants anon nothing. 039 revoked everything from anon and gave
--     it nothing back; that stays exactly as it is.
--   * It grants no INSERT, UPDATE or DELETE to any role. The eight
--     SECURITY DEFINER functions in 039 remain the entire write surface
--     for a prepaid contract.
--   * It changes no data. No UPDATE, no INSERT, no DELETE, no backfill.
--
-- ── ONE TRANSACTION ───────────────────────────────────────────
--
-- begin/commit around every privilege statement, so there is no window
-- in which the table grant is gone and the column grants are not yet
-- there. A customer's account page either reads the old surface or the
-- new one, never nothing.
--
-- ── THE ONE THING TO CONFIRM WHEN APPLYING ────────────────────
--
-- The deliveries policy from 039 reads the PARENT to decide ownership:
--
--     exists (select 1 from public.annual_plans p
--             where p.id = annual_plan_deliveries.annual_plan_id
--               and p.user_id = auth.uid())
--
-- PostgreSQL evaluates a policy expression's own table references with
-- the policy table's owner rights rather than the caller's, which is why
-- this file does not grant authenticated any privilege on
-- annual_plans.user_id - a column the account has no business reading.
--
-- Verify section E below PROVES that on the live database, as the
-- authenticated role, inside a rolled-back transaction. If, and only if,
-- that probe fails with a permission error naming public.annual_plans,
-- the minimal follow-up is one line in a later migration:
--
--     grant select (user_id) on public.annual_plans to authenticated;
--
-- which leaks nothing - RLS already restricts every readable row to the
-- caller's own user_id, so the only value they could ever read is the one
-- their own JWT already carries. Do not add it pre-emptively; run E first.
-- ============================================================


begin;


-- 1. REMOVE THE BROAD TABLE-LEVEL READ ─────────────────────────
--
-- The grant migration 039 made. Removing it is what makes a column
-- grant meaningful: a table-level SELECT would otherwise keep answering
-- for every column regardless of what is named below.
--
-- FROM authenticated ONLY. service_role's own table-level SELECT on both
-- tables is untouched by this file and must stay - it is how the daily
-- maintenance job, the settlement path and the refund correlation read.

revoke select on table public.annual_plans           from authenticated;
revoke select on table public.annual_plan_deliveries from authenticated;


-- 2. THE ACCOUNT'S PARENT COLUMNS, AND ONLY THESE ──────────────
--
-- Every column here is something the customer paid for, agreed to, or is
-- owed - and every one of them is consumed by
-- buildAnnualPlanAccountView in lib/annualPlanAccount.ts. Nothing is
-- granted because it might be useful later.
--
--   id                       identifies the plan, and is what the detail
--                            read filters on. A filter needs SELECT on
--                            the column it filters by.
--   status, payment_status   the two vocabularies the account renders:
--                            lifecycle and money.
--   currency                 EUR by CHECK, still read rather than assumed.
--   delivery_count           thirteen, from the row, so no browser has to
--                            know it as arithmetic.
--   catalog_unit_gross_cents the price without the annual discount, which
--                            is what makes the discount legible.
--   annual_unit_gross_cents  what a box actually cost.
--   shipping_per_delivery_
--     gross_cents            what shipping actually cost.
--   merchandise_total_,      the three frozen totals of the contract.
--     shipping_total_,
--     total_gross_cents
--   refunded_total_cents     truthful refund state, partial or full.
--   discount_percent_applied what was agreed, not what is on offer today.
--   delivery_items_snapshot  THE ONLY SNAPSHOT GRANTED, because it is the
--                            only truthful source of what was bought. A
--                            relabelled catalog must not rewrite a paid
--                            year. It holds product name, variant label,
--                            size, quantity and the frozen unit price -
--                            the customer's own purchase, and no address,
--                            no email and no tax working.
--   purchased_at, plan_end_at  the term. Also the account list's sort key
--                            and its "is this a contract yet" filter.
--   completed_at, cancelled_at  how it ended, when it has.
--
-- created_at is NOT granted: the account sorts by purchased_at and shows
-- the purchase date, so the row's creation time - which for an abandoned
-- checkout is not a purchase at all - has no reader.

grant select (
  id,
  status,
  payment_status,
  currency,
  delivery_count,
  catalog_unit_gross_cents,
  annual_unit_gross_cents,
  shipping_per_delivery_gross_cents,
  merchandise_total_gross_cents,
  shipping_total_gross_cents,
  total_gross_cents,
  refunded_total_cents,
  discount_percent_applied,
  delivery_items_snapshot,
  purchased_at,
  plan_end_at,
  completed_at,
  cancelled_at
) on table public.annual_plans to authenticated;


-- 3. THE ACCOUNT'S DELIVERY COLUMNS, AND ONLY THESE ────────────
--
--   annual_plan_id    NOT rendered, but REQUIRED: the account reads a
--                     plan's deliveries with a filter on it, and
--                     PostgreSQL needs SELECT on a column used in a
--                     WHERE clause just as much as on one that is
--                     returned.
--   delivery_number   which of the thirteen, and the sort key.
--   scheduled_for     the durable date. The account never derives one.
--   state             'scheduled' / 'claimed' / 'fulfilled' / 'cancelled',
--                     passed through truthfully - a claimed box is being
--                     prepared and is not a shipped box.
--   fulfilled_at      when it actually went.
--   order_id          the ORDINARY order it became, so the account links
--                     to the order page it already has instead of
--                     inventing a second representation of one delivery.
--
-- id is NOT granted: nothing reads a delivery by its own uuid. The pair
-- (annual_plan_id, delivery_number) is unique and is what the account
-- uses.
--
-- checkout_attempt_id is NOT granted: it names the synthetic attempt
-- migration 039 mints, which is internal fulfillment machinery.
--
-- claimed_at is NOT granted: it is the six-hour worker lease. A queue
-- lease is not a customer fact, and showing one invites reading it as a
-- shipping promise.

grant select (
  annual_plan_id,
  delivery_number,
  scheduled_for,
  state,
  fulfilled_at,
  order_id
) on table public.annual_plan_deliveries to authenticated;


commit;


-- ============================================================
-- 4. VERIFY - READ ONLY, AFTER APPLYING. NOTHING BELOW RUNS.
-- ============================================================
--
--   A. THE BROAD TABLE GRANT IS GONE, in both metadata representations.
--      information_schema answers from the catalog; has_table_privilege
--      answers what the planner would actually enforce, including
--      privileges inherited from PUBLIC. Checking only one of them has
--      missed a live grant in this project before.
--
--   select table_name, grantee, privilege_type
--   from information_schema.role_table_grants
--   where table_schema = 'public'
--     and table_name in ('annual_plans', 'annual_plan_deliveries')
--     and grantee in ('anon', 'authenticated', 'service_role')
--   order by table_name, grantee, privilege_type;
--
--     EXPECT exactly two rows, both service_role SELECT.
--     EXPECT no authenticated row and no anon row at all.
--
--   select has_table_privilege('authenticated', 'public.annual_plans', 'select')            as plans_auth,
--          has_table_privilege('authenticated', 'public.annual_plan_deliveries', 'select')  as deliveries_auth,
--          has_table_privilege('service_role',  'public.annual_plans', 'select')            as plans_service,
--          has_table_privilege('service_role',  'public.annual_plan_deliveries', 'select')  as deliveries_service,
--          has_table_privilege('anon',          'public.annual_plans', 'select')            as plans_anon,
--          has_table_privilege('anon',          'public.annual_plan_deliveries', 'select')  as deliveries_anon;
--
--     EXPECT false, false, true, true, false, false.
--
--     has_table_privilege is TRUE only when the privilege covers the
--     WHOLE table, which is exactly the question here: a column-level
--     grant must not make it true again.
--
--
--   B. THE COLUMN GRANTS ARE EXACTLY THE ALLOWLIST.
--
--   select table_name, column_name
--   from information_schema.column_privileges
--   where table_schema = 'public'
--     and table_name in ('annual_plans', 'annual_plan_deliveries')
--     and grantee = 'authenticated'
--     and privilege_type = 'SELECT'
--   order by table_name, column_name;
--
--     EXPECT for annual_plan_deliveries, in this order:
--       annual_plan_id, delivery_number, fulfilled_at, order_id,
--       scheduled_for, state
--
--     EXPECT for annual_plans, in this order:
--       annual_unit_gross_cents, cancelled_at, catalog_unit_gross_cents,
--       completed_at, currency, delivery_count, delivery_items_snapshot,
--       discount_percent_applied, id, merchandise_total_gross_cents,
--       payment_status, plan_end_at, purchased_at, refunded_total_cents,
--       shipping_per_delivery_gross_cents, shipping_total_gross_cents,
--       status, total_gross_cents
--
--     EXPECT 18 rows for annual_plans and 6 for annual_plan_deliveries,
--     and NOTHING ELSE.
--
--
--   C. THE FORBIDDEN COLUMNS ARE NOT READABLE, ASKED DIRECTLY.
--
--   select column_name,
--          has_column_privilege('authenticated', 'public.annual_plans', column_name, 'select') as readable
--   from (values
--     ('user_id'), ('payment_checkout_attempt_id'),
--     ('stripe_checkout_session_id'), ('stripe_payment_intent_id'),
--     ('variant_id'), ('customer_snapshot'), ('shipping_address_snapshot'),
--     ('billing_address_snapshot'), ('tax_snapshot'), ('delivery_tax_snapshot'),
--     ('refund_updated_at'), ('created_at'), ('updated_at'),
--     ('purchase_confirmation_email_status'),
--     ('purchase_confirmation_email_sent_at'),
--     ('purchase_confirmation_email_claimed_at'),
--     ('purchase_confirmation_email_claim_token')
--   ) as forbidden(column_name)
--   order by column_name;
--
--     EXPECT readable = false for every row. The claim token especially:
--     it is authority to record an email outcome, not a fact.
--
--   select column_name,
--          has_column_privilege('authenticated', 'public.annual_plan_deliveries', column_name, 'select') as readable
--   from (values ('id'), ('checkout_attempt_id'), ('claimed_at'), ('created_at')) as forbidden(column_name)
--   order by column_name;
--
--     EXPECT readable = false for all four.
--
--
--   D. RLS IS UNCHANGED. This file must not have created, dropped or
--      altered a policy, and row security must still be on.
--
--   select relname, relrowsecurity, relforcerowsecurity
--   from pg_class
--   where relnamespace = 'public'::regnamespace
--     and relname in ('annual_plans', 'annual_plan_deliveries');
--
--     EXPECT relrowsecurity = true for both.
--
--   select tablename, policyname, cmd, roles, qual
--   from pg_policies
--   where schemaname = 'public'
--     and tablename in ('annual_plans', 'annual_plan_deliveries')
--   order by tablename, policyname;
--
--     EXPECT exactly two rows, both cmd = SELECT:
--       "Users read own annual plan deliveries"  and
--       "Users read own annual plans"
--     with the same quals migration 039 installed - auth.uid() = user_id,
--     and the EXISTS through the parent. No INSERT, UPDATE or DELETE
--     policy may appear.
--
--
--   E. THE ACCOUNT READ STILL WORKS, AS THE BROWSER ROLE.
--
--      Run inside an explicit transaction and ROLL BACK. It reads only.
--      Substitute a real user's uuid and one of their plan ids.
--
--   begin;
--   set local role authenticated;
--   set local request.jwt.claims = '{"sub":"<a real auth user uuid>","role":"authenticated"}';
--
--   -- E1. The allowed parent read succeeds and returns only own rows.
--   select id, status, payment_status, total_gross_cents, purchased_at
--   from public.annual_plans
--   order by purchased_at desc nulls last;
--
--   -- E2. The delivery read succeeds. THIS IS THE PROBE THAT MATTERS:
--   --     the deliveries policy reads the parent's user_id, which
--   --     authenticated has no grant on. Expect rows, not
--   --     "permission denied for table annual_plans".
--   select annual_plan_id, delivery_number, scheduled_for, state, order_id
--   from public.annual_plan_deliveries
--   order by annual_plan_id, delivery_number;
--
--   -- E3. The star select is now refused.
--   --     EXPECT: ERROR permission denied for table annual_plans
--   select * from public.annual_plans;
--
--   -- E4. Each capability column is refused by name.
--   --     EXPECT: ERROR permission denied for table annual_plans
--   select stripe_payment_intent_id from public.annual_plans;
--   select purchase_confirmation_email_claim_token from public.annual_plans;
--   select customer_snapshot from public.annual_plans;
--   select claimed_at from public.annual_plan_deliveries;
--
--   rollback;
--
--      Each refused statement aborts the transaction, so run E3 and E4
--      one at a time, each in its own begin/rollback.
--
--
--   F. NOTHING ELSE MOVED. This file wrote no row, so every count and
--      every money column is exactly what it was before it ran.
--
--   select count(*) as plans, count(*) filter (where status = 'active') as active
--   from public.annual_plans;
--
--   select count(*) as deliveries,
--          count(*) filter (where state = 'fulfilled') as fulfilled
--   from public.annual_plan_deliveries;
--
--     EXPECT both to match what they were before applying.
-- ============================================================
