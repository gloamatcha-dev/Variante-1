-- ============================================================
-- GLOA - Annual checkout retry intent (Phase 4B3.2)
-- Run in Supabase SQL Editor AFTER 039
--
-- Closes ONE gap, found and reproduced in Phase 4B3.1: an annual
-- checkout could be retried with the same request_id after the customer
-- edited their saved address, and nothing would notice.
--
-- ── THE GAP, EXACTLY ──────────────────────────────────────────
--
-- The annual PAYMENT attempt freezes the customer, the product, the
-- money, the destination country and the tax. Every one of those is
-- INVARIANT under a within-Germany address edit: annual shipping is
-- decided by the product size rather than by the address, so 590/0/0
-- does not move; the country stays DE; the jurisdiction stays domestic.
--
-- So this sequence produced two different delivery contracts from one
-- request_id:
--
--   1. the payment attempt is created and frozen
--   2. create_pending_annual_plan_for_attempt fails, or the request dies
--   3. the customer edits their street, postcode, city, recipient or
--      company - or picks a different saved German address entirely
--   4. the browser retries with the SAME request_id
--   5. every existing check passes, and the annual plan is frozen with
--      the NEW address
--
-- Reproduced against the live runtime before this migration was written:
-- all six edits changed the frozen snapshot and none was detected, and
-- the selected address id was not persisted anywhere at all.
--
-- No customer was exposed. B2C_ANNUAL_PLAN_ENABLED has never been
-- opened, so no annual checkout has ever run and
-- public.annual_plans is empty.
--
-- ── WHY THIS NEEDS A MIGRATION AT ALL ─────────────────────────
--
-- Phase 4B3.1 audited every column on public.checkout_attempts for a
-- durable place to bind the missing facts. The only free text columns
-- are subscription_request_fingerprint and
-- subscription_intent_fingerprint, and they cannot be borrowed. Migration
-- 025's claim_pending_subscription_for_attempt reads their non-NULL-ness
-- as the DEFINITION of what an attempt is:
--
--   if v_attempt.subscription_request_fingerprint is null
--      or v_attempt.subscription_intent_fingerprint is null then
--     raise exception 'checkout attempt % is not a subscription checkout'
--
-- An annual payment attempt writing there would satisfy that definition.
-- It would still be refused two lines later by digest inequality, but
-- that is an accident of values rather than a structural guarantee, and
-- 025 is live and immutable. Migration 022 likewise documents NULL as
-- meaning "came from the one-time payment flow", which would silently
-- stop being true.
--
-- So the annual flow gets its own two columns, and after this migration
-- the four attempt populations are structurally distinguishable:
--
--   one-time             both families NULL
--   subscription         subscription_* set, annual_* NULL
--   annual payment       annual_* set, subscription_* NULL
--   annual delivery      both families NULL, annual_plan_id set
--
-- ── AND WHY THE FUNCTION CHANGES TOO ──────────────────────────
--
-- Two columns alone would only let the APPLICATION compare digests, and
-- the decision they guard is taken under a row lock inside the database.
-- An application check followed by a separate RPC call is two
-- transactions with a window between them, which is the same shape of
-- mistake Phase 4B1.1 removed from the fulfillment path.
--
-- So section 3 replaces create_pending_annual_plan_for_attempt with a
-- hardened signature that takes both expected fingerprints and compares
-- them against the STORED ones under the same lock that decides whether
-- to create the plan. Every invariant 039 established is preserved
-- verbatim; two gates are added and nothing is removed or weakened.
--
-- 039 IS NOT EDITED. It is live and immutable, and this file is the only
-- thing that changes. 040 IS THE NEXT FREE NUMBER.
--
-- THIS FILE IS EXPLICITLY TRANSACTIONAL. Every executable statement sits
-- between the begin; below and the commit; at the end of section 4, so
-- the whole migration applies or none of it does.
--
-- That is not a convenience. Section 3 DROPS the pending-plan function
-- and then creates its replacement: between those two statements the
-- annual checkout has no pending-plan function at all, and a failure in
-- between would leave the schema in exactly that state. Relying on a
-- client to wrap the file would make the guarantee a property of
-- whatever tool happened to run it - the Supabase SQL Editor, psql, a CI
-- step - rather than of the migration itself.
--
-- RUN THE WHOLE FILE AS ONE EXECUTION. Do not run sections separately
-- and do not use "run selection": a partial run would send a BEGIN with
-- no COMMIT, or a COMMIT with no BEGIN. Do not add a second wrapping
-- transaction around it either; Postgres does not nest them.
--
-- The VERIFY section after the commit is read-only and commented out.
-- ============================================================


-- 1. TWO ANNUAL-OWNED FINGERPRINT COLUMNS ──────────────────────
--
-- Nullable, no default, NO BACKFILL. Every checkout attempt written
-- before this migration is a one-time cart, a subscription cycle or an
-- annual delivery, and none of them has an annual payment intent to
-- describe. NULL therefore means exactly that, and the hardened function
-- in section 3 refuses a NULL rather than adopting the row - so an
-- attempt that predates this file can never be retroactively treated as
-- an annual checkout.
--
-- ── WHY TWO AND NOT ONE ───────────────────────────────────────
--
-- They answer different questions and they stop being the same question
-- the moment an annual plan exists. Migration 025 records the same split
-- for subscriptions and the reasoning carries over exactly:
--
--   annual_intent_fingerprint   WHICH checkout this is. Customer,
--                               product and selected address, with no
--                               priced value in it. Compared on EVERY
--                               retry, including one that finds an
--                               existing plan - a different customer, a
--                               different product or a different address
--                               is a different checkout whatever has
--                               already been created.
--
--   annual_request_fingerprint  The TERMS. The identity above plus the
--                               address CONTENTS and every frozen
--                               commercial fact. Compared only while no
--                               plan exists yet, because once the
--                               contract is frozen it IS the answer, and
--                               refusing the retry because the customer
--                               has since edited their street would lock
--                               them out of a plan they already hold for
--                               something that is not their doing.
--
-- ── NO INDEX, NO UNIQUE CONSTRAINT ────────────────────────────
--
-- Neither column is ever looked up by. request_id is already unique and
-- is how an attempt is found; a fingerprint is a PROPERTY of the request
-- that gets compared once the row is already in hand. An index would be
-- write cost for a query nobody makes, and a unique constraint would be
-- wrong outright - two customers ordering the same product to the same
-- address legitimately produce the same content digest.
--
-- ── NO ADDRESS TEXT ───────────────────────────────────────────
--
-- Both columns hold a SHA-256 hex digest and nothing else. The address
-- is reduced to a digest before it reaches the database, so no street,
-- name, company, postcode or city is ever stored here, and nothing
-- readable about a delivery can reach a log line through them. No token
-- and no key goes in either.

-- ── THE TRANSACTION OPENS HERE ────────────────────────────────
--
-- Everything from this line to the commit; at the end of section 4 is
-- one unit. DDL is transactional in PostgreSQL, so the two columns, the
-- dropped function, its hardened replacement and the four privilege
-- statements all land together or not at all.

begin;

alter table public.checkout_attempts
  add column annual_intent_fingerprint  text,
  add column annual_request_fingerprint text;


-- 2. NO PRIVILEGE CHANGE ───────────────────────────────────────
--
-- Deliberately empty of DDL.
--
-- public.checkout_attempts keeps exactly the privileges migration 023
-- audited: select, insert and update to service_role, and nothing at all
-- to anon or authenticated. Two columns added to a table inherit that
-- table's grants, so the columns above are reachable by the server and
-- invisible to every browser role - which is what they must be, because
-- they are internal correlation state and not customer-facing data.
--
-- No RLS change either. public.checkout_attempts has RLS enabled with no
-- policies at all (migration 009), so it is invisible to client roles
-- entirely rather than filtered for them.


-- 3. THE HARDENED PENDING-PLAN FUNCTION ────────────────────────
--
-- ── THE OLD SIGNATURE IS DROPPED, NOT LEFT BESIDE THE NEW ONE ─
--
-- PostgreSQL overloads on the argument list, so a create-or-replace with
-- two extra parameters would leave BOTH functions callable: the hardened
-- one, and the 13-argument version that cannot check a fingerprint. A
-- caller that forgot to pass them would silently get the unsafe one.
-- That is not a hazard worth documenting around, so the old signature is
-- removed first and exactly one remains afterwards.
--
-- Nothing depends on it. It is called from application code only -
-- lib/annualPlanCheckoutDeps.ts, updated in the same change - and no
-- view, trigger, default, constraint or other function references it.
-- DROP without CASCADE, deliberately: if anything did depend on it, this
-- migration must fail loudly rather than quietly removing that too.
--
-- No IF EXISTS. The function is known to be there: migration 039 created
-- it and nothing since has touched it. IF EXISTS would let this file
-- succeed against a schema that had already drifted, and failing on a
-- schema that does not match the reviewed contract is the whole point.

drop function public.create_pending_annual_plan_for_attempt(
  uuid, uuid, uuid, integer, integer, integer, numeric,
  jsonb, jsonb, jsonb, jsonb, jsonb, jsonb
);

-- ── WHAT CHANGED, AND WHAT DID NOT ────────────────────────────
--
-- Two arguments and two gates. Everything else below is migration 039's
-- body, unchanged: the same input validation, the same row lock, the
-- same ownership check, the same existing-plan adoption, the same
-- pre-Stripe state test, the same server-side computation of the three
-- totals, the same expected-total comparison, the same insert, and the
-- same unique-violation adoption. No 039 invariant is relaxed.
--
-- ── THE ORDER OF THE TWO NEW GATES IS THE CONTRACT ────────────
--
-- The intent gate runs BEFORE the existing-plan lookup, and the terms
-- gate runs AFTER it and only when no plan was found. That ordering is
-- what makes the two cases behave differently, and inverting it would
-- reintroduce the very lockout the second column exists to avoid:
--
--   plan already exists, address edited afterwards
--       intent still matches   -> 'existing', the frozen plan is
--       returned untouched and the terms are never consulted
--
--   no plan yet, address edited
--       intent still matches, terms differ -> 'attempt_request_mismatch',
--       and nothing is created
--
-- ── FAIL CLOSED ON NULL ───────────────────────────────────────
--
-- A stored fingerprint that is NULL is a refusal, not a pass. An attempt
-- written before this migration, or by the one-time or subscription
-- flow, has NULL here and must never be adopted as an annual checkout.
-- `is distinct from` rather than `<>` so a NULL on either side refuses
-- instead of falling through as unknown.
--
-- ── NOTHING IS ECHOED ─────────────────────────────────────────
--
-- The mismatch results carry a word and the attempt's status, never the
-- stored digest and never the expected one. A caller that guessed a
-- request_id learns that it does not own the checkout, and learns
-- nothing it could use to construct one that does.

create or replace function public.create_pending_annual_plan_for_attempt(
  p_checkout_attempt_id             uuid,
  p_user_id                         uuid,
  p_variant_id                      uuid,
  p_catalog_unit_gross_cents        integer,
  p_annual_unit_gross_cents         integer,
  p_shipping_per_delivery_gross_cents integer,
  p_discount_percent_applied        numeric,
  p_customer_snapshot               jsonb,
  p_shipping_address_snapshot       jsonb,
  p_billing_address_snapshot        jsonb,
  p_tax_snapshot                    jsonb,
  p_delivery_items_snapshot         jsonb,
  p_delivery_tax_snapshot           jsonb,
  p_expected_annual_intent_fingerprint  text,
  p_expected_annual_request_fingerprint text
)
returns jsonb
language plpgsql
volatile
security definer set search_path = ''
as $$
declare
  v_attempt public.checkout_attempts;
  v_plan    public.annual_plans;
  v_count   constant integer := 13;
  v_merch   integer;
  v_ship    integer;
  v_total   integer;
begin
  -- 039's validation, plus the two new arguments. Both are REQUIRED:
  -- they exist to be compared, and a NULL would compare against nothing.
  if p_checkout_attempt_id is null
     or p_user_id is null
     or p_variant_id is null
     or p_catalog_unit_gross_cents is null
     or p_annual_unit_gross_cents is null
     or p_shipping_per_delivery_gross_cents is null
     or p_discount_percent_applied is null
     or p_customer_snapshot is null
     or p_shipping_address_snapshot is null
     or p_billing_address_snapshot is null
     or p_tax_snapshot is null
     or p_delivery_items_snapshot is null
     or p_delivery_tax_snapshot is null
     or p_expected_annual_intent_fingerprint is null
     or pg_catalog.btrim(p_expected_annual_intent_fingerprint) = ''
     or p_expected_annual_request_fingerprint is null
     or pg_catalog.btrim(p_expected_annual_request_fingerprint) = ''
  then
    return pg_catalog.jsonb_build_object('result', 'invalid_input');
  end if;

  -- THE LOCK, FIRST. Everything below decides whether a plan exists and
  -- creates one only if it does not; both halves must see the same
  -- attempt, and so must both fingerprint comparisons.
  select * into v_attempt
  from public.checkout_attempts
  where id = p_checkout_attempt_id
  for update;

  if not found then
    return pg_catalog.jsonb_build_object('result', 'attempt_not_found');
  end if;

  -- OWNERSHIP FIRST, BEFORE ANY PLAN IS RESOLVED OR REPORTED. 039's
  -- rule, unchanged: answering the existing-plan branch before proving
  -- ownership would turn a guessed attempt id into an oracle for a
  -- plan's uuid and its status.
  if v_attempt.user_id is distinct from p_user_id then
    return pg_catalog.jsonb_build_object('result', 'attempt_not_owned');
  end if;

  -- ── GATE ONE: IS THIS STILL THE SAME CHECKOUT? ────────────
  --
  -- Compared on EVERY retry, including the one that is about to find an
  -- existing plan. A different customer, a different product or a
  -- different selected address is a different checkout whatever has
  -- already been created - so this cannot be skipped once a contract
  -- exists, the way the terms gate below deliberately is.
  --
  -- NULL fails. An attempt from the one-time or subscription flow, or
  -- one written before this migration, has no annual intent and is not
  -- adopted into one.
  if v_attempt.annual_intent_fingerprint is null
     or v_attempt.annual_intent_fingerprint is distinct from p_expected_annual_intent_fingerprint
  then
    return pg_catalog.jsonb_build_object(
      'result', 'attempt_intent_mismatch',
      'attempt_status', v_attempt.status
    );
  end if;

  -- ALREADY CLAIMED. Idempotent, and the ONLY safe answer to a retry:
  -- the plan that exists IS the answer to this request and nothing may
  -- rebuild it from freshly read data.
  --
  -- Reached BEFORE the terms gate, deliberately. A customer who edited
  -- their saved address after the contract was frozen must still be able
  -- to return to the Stripe session for the plan they already hold; the
  -- frozen snapshots on that plan remain authoritative and are not
  -- touched here.
  select * into v_plan
  from public.annual_plans
  where payment_checkout_attempt_id = p_checkout_attempt_id;

  if found then
    return pg_catalog.jsonb_build_object(
      'result', 'existing',
      'annual_plan_id', v_plan.id,
      'status', v_plan.status
    );
  end if;

  -- ── GATE TWO: ARE THE TERMS STILL THE FROZEN ONES? ────────
  --
  -- Only from here on, because only from here on could a NEW contract be
  -- written. This is the gate that catches the Phase 4B3.1 gap: the
  -- address contents, the catalog price, the discount, the annual unit
  -- price, the shipping, the totals and the tax identity are all inside
  -- this digest, so an edit to any of them refuses the retry instead of
  -- freezing something the customer never agreed to.
  if v_attempt.annual_request_fingerprint is null
     or v_attempt.annual_request_fingerprint is distinct from p_expected_annual_request_fingerprint
  then
    return pg_catalog.jsonb_build_object(
      'result', 'attempt_request_mismatch',
      'attempt_status', v_attempt.status
    );
  end if;

  -- ── 039'S REMAINING VALIDATION, UNCHANGED ─────────────────
  --
  -- The attempt must still be in the exact pre-Stripe state. The
  -- contract is strictly ordered - payment attempt, then pending parent,
  -- then Stripe session - because the parent's id has to exist before
  -- the session so it can travel as trusted correlation metadata.
  if v_attempt.status <> 'created'
     or v_attempt.stripe_checkout_session_id is not null
     or v_attempt.stripe_payment_intent_id is not null
     or v_attempt.stripe_invoice_id is not null
     or v_attempt.subscription_id is not null
     or v_attempt.annual_plan_id is not null
     or v_attempt.annual_delivery_number is not null
  then
    return pg_catalog.jsonb_build_object(
      'result', 'attempt_not_pre_stripe',
      'attempt_status', v_attempt.status
    );
  end if;

  -- THE TOTALS ARE NOT ARGUMENTS. Computed here from the per-delivery
  -- integers, so a caller cannot supply a total that disagrees with the
  -- unit price it is built from.
  v_merch := p_annual_unit_gross_cents * v_count;
  v_ship  := p_shipping_per_delivery_gross_cents * v_count;
  v_total := v_merch + v_ship;

  -- THE PRICE THE CUSTOMER IS ABOUT TO BE ASKED FOR. The attempt froze
  -- it before Stripe was contacted; if the plan is not that number, the
  -- two were computed from different inputs and neither is trustworthy.
  if v_attempt.expected_total_gross_cents is distinct from v_total then
    return pg_catalog.jsonb_build_object(
      'result', 'total_mismatch',
      'attempt_total_gross_cents', v_attempt.expected_total_gross_cents,
      'plan_total_gross_cents', v_total
    );
  end if;

  begin
    insert into public.annual_plans (
      user_id,
      payment_checkout_attempt_id,
      variant_id,
      currency,
      status,
      payment_status,
      catalog_unit_gross_cents,
      annual_unit_gross_cents,
      shipping_per_delivery_gross_cents,
      delivery_count,
      merchandise_total_gross_cents,
      shipping_total_gross_cents,
      total_gross_cents,
      discount_percent_applied,
      customer_snapshot,
      shipping_address_snapshot,
      billing_address_snapshot,
      tax_snapshot,
      delivery_items_snapshot,
      delivery_tax_snapshot
    ) values (
      p_user_id,
      p_checkout_attempt_id,
      p_variant_id,
      v_attempt.currency,
      'pending',
      'pending',
      p_catalog_unit_gross_cents,
      p_annual_unit_gross_cents,
      p_shipping_per_delivery_gross_cents,
      v_count,
      v_merch,
      v_ship,
      v_total,
      p_discount_percent_applied,
      p_customer_snapshot,
      p_shipping_address_snapshot,
      p_billing_address_snapshot,
      p_tax_snapshot,
      p_delivery_items_snapshot,
      p_delivery_tax_snapshot
    )
    returning * into v_plan;
  exception
    when unique_violation then
      -- A concurrent caller won the race between the lookup above and
      -- this insert. annual_plans_payment_checkout_attempt_id_key is the
      -- real guard; this adopts its winner rather than raising.
      select * into v_plan
      from public.annual_plans
      where payment_checkout_attempt_id = p_checkout_attempt_id;
      if found then
        return pg_catalog.jsonb_build_object(
          'result', 'existing',
          'annual_plan_id', v_plan.id,
          'status', v_plan.status
        );
      end if;
      raise;
  end;

  return pg_catalog.jsonb_build_object(
    'result', 'created',
    'annual_plan_id', v_plan.id,
    'status', v_plan.status,
    'total_gross_cents', v_plan.total_gross_cents
  );
end;
$$;


-- 4. EXECUTE PRIVILEGES ────────────────────────────────────────
--
-- The dropped function took its ACL with it, so the replacement needs
-- its own. Same model as 039 and as every other function in this
-- project: REVOKE FROM public FIRST, because a freshly created function
-- is executable by PUBLIC by default and anon and authenticated inherit
-- that - revoking only the named roles would leave the default in place
-- and the function reachable from the browser's own Supabase client with
-- nothing but an anon key.
--
-- service_role is the only grantee, and it still holds no INSERT, UPDATE
-- or DELETE on public.annual_plans.

revoke all on function public.create_pending_annual_plan_for_attempt(uuid, uuid, uuid, integer, integer, integer, numeric, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, text, text) from public;
revoke all on function public.create_pending_annual_plan_for_attempt(uuid, uuid, uuid, integer, integer, integer, numeric, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, text, text) from anon;
revoke all on function public.create_pending_annual_plan_for_attempt(uuid, uuid, uuid, integer, integer, integer, numeric, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, text, text) from authenticated;
grant execute on function public.create_pending_annual_plan_for_attempt(uuid, uuid, uuid, integer, integer, integer, numeric, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, text, text) to service_role;

-- ── AND CLOSES HERE ───────────────────────────────────────────
--
-- The last executable statement of the migration. Everything after this
-- line is a comment: section 5 records what the file does NOT do, and
-- the VERIFY block is read-only and stays commented out.

commit;


-- 5. NO DATA CHANGE ────────────────────────────────────────────
--
-- Applying this migration inserts no row, updates no row and deletes no
-- row. It adds two nullable columns with no default and no backfill,
-- drops one function and creates its hardened replacement, which it
-- calls zero times.
--
-- public.annual_plans and public.annual_plan_deliveries are empty and
-- stay empty: B2C_ANNUAL_PLAN_ENABLED has never been opened, so no
-- annual checkout has ever run. Every existing checkout_attempt keeps
-- its columns and gains two NULLs, which is exactly what "this row has
-- no annual payment intent" means.
--
-- The other seven annual functions from 039 are untouched, as are 037's
-- and 038's refund writers and migration 021's order creator.


-- ══════════════════════════════════════════════════════════════
-- VERIFY AFTER APPLYING (read-only, run in the SQL Editor)
-- ══════════════════════════════════════════════════════════════
--
-- (a) Both columns exist, nullable, with no default. Expect two rows,
--     data_type text, is_nullable YES, column_default null.
--
--   select column_name, data_type, is_nullable, column_default
--   from information_schema.columns
--   where table_schema = 'public' and table_name = 'checkout_attempts'
--     and column_name in ('annual_intent_fingerprint',
--                         'annual_request_fingerprint')
--   order by column_name;
--
-- (b) NOTHING WAS BACKFILLED. Every pre-existing attempt has NULL in
--     both. Expect populated = 0 and total = the row count you had
--     before applying.
--
--   select count(*) filter (
--            where annual_intent_fingerprint is not null
--               or annual_request_fingerprint is not null) as populated,
--          count(*) as total
--   from public.checkout_attempts;
--
-- (c) The four attempt populations are structurally distinguishable, and
--     no row belongs to two of them. Expect zero rows.
--
--   select id
--   from public.checkout_attempts
--   where (annual_intent_fingerprint is not null
--          or annual_request_fingerprint is not null)
--     and (subscription_request_fingerprint is not null
--          or subscription_intent_fingerprint is not null);
--
-- (d) NO INDEX was created for either column. Expect zero rows.
--
--   select indexname, indexdef
--   from pg_indexes
--   where schemaname = 'public'
--     and tablename = 'checkout_attempts'
--     and (indexdef like '%annual_intent_fingerprint%'
--       or indexdef like '%annual_request_fingerprint%');
--
-- (e) EXACTLY ONE create_pending_annual_plan_for_attempt remains, and it
--     is the hardened one. Expect ONE row whose args end in
--     "..., jsonb, text, text".
--
--   select p.proname,
--          pg_get_function_identity_arguments(p.oid) as args,
--          p.prosecdef,
--          p.proconfig
--   from pg_proc p
--   where p.pronamespace = 'public'::regnamespace
--     and p.proname = 'create_pending_annual_plan_for_attempt';
--
-- (f) The old 13-argument signature is GONE. Expect 0.
--
--   select count(*) as old_unsafe_overloads
--   from pg_proc
--   where pronamespace = 'public'::regnamespace
--     and proname = 'create_pending_annual_plan_for_attempt'
--     and pg_get_function_identity_arguments(oid) =
--         'uuid, uuid, uuid, integer, integer, integer, numeric, '
--         || 'jsonb, jsonb, jsonb, jsonb, jsonb, jsonb';
--
-- (g) The new signature takes both expected fingerprints. Expect 2.
--
--   select count(*) as fingerprint_arguments
--   from pg_proc p,
--        unnest(p.proargnames) as argname
--   where p.pronamespace = 'public'::regnamespace
--     and p.proname = 'create_pending_annual_plan_for_attempt'
--     and argname in ('p_expected_annual_intent_fingerprint',
--                     'p_expected_annual_request_fingerprint');
--
-- (h) Still SECURITY DEFINER with an emptied search_path. Expect
--     prosecdef = true and proconfig = {search_path=}.
--
--   select proname, prosecdef, proconfig
--   from pg_proc
--   where pronamespace = 'public'::regnamespace
--     and proname = 'create_pending_annual_plan_for_attempt';
--
-- (i) Only service_role may execute it, and PUBLIC may not. Expect an
--     acl showing service_role=X and no leading "=" entry, no anon and
--     no authenticated.
--
--   select proname,
--          coalesce(array_to_string(proacl, E'\n'), '(no explicit acl)') as acl
--   from pg_proc
--   where pronamespace = 'public'::regnamespace
--     and proname = 'create_pending_annual_plan_for_attempt';
--
--     And the same question asked EFFECTIVELY rather than by reading the
--     ACL, which is what actually decides a call. has_function_privilege
--     resolves inheritance, so a privilege reaching a role through a
--     grant this file never made would still show up here.
--
--     Expect exactly:
--       public         false
--       anon           false
--       authenticated  false
--       service_role   true
--
--   select role_name,
--          has_function_privilege(
--            role_name,
--            'public.create_pending_annual_plan_for_attempt(uuid, uuid, '
--            || 'uuid, integer, integer, integer, numeric, jsonb, jsonb, '
--            || 'jsonb, jsonb, jsonb, jsonb, text, text)',
--            'EXECUTE') as can_execute
--   from (values ('public'), ('anon'), ('authenticated'), ('service_role'))
--        as r(role_name)
--   order by role_name;
--
-- (j) The other seven annual functions from 039 are untouched. Expect
--     SEVEN rows, every one prosecdef = true.
--
--   select proname, prosecdef, pg_get_function_identity_arguments(oid) as args
--   from pg_proc
--   where pronamespace = 'public'::regnamespace
--     and proname in ('activate_annual_plan_from_payment',
--                     'claim_due_annual_plan_deliveries',
--                     'fulfill_annual_plan_delivery',
--                     'apply_annual_plan_refund_state',
--                     'claim_annual_plan_purchase_email',
--                     'record_annual_plan_purchase_email_result',
--                     'complete_due_annual_plans')
--   order by proname;
--
-- (k) TABLE PRIVILEGES ARE UNCHANGED from migration 023. Expect exactly
--     service_role with INSERT, SELECT and UPDATE, and no anon or
--     authenticated row at all.
--
--   select grantee, privilege_type
--   from information_schema.role_table_grants
--   where table_schema = 'public' and table_name = 'checkout_attempts'
--     and grantee in ('anon', 'authenticated', 'service_role')
--   order by grantee, privilege_type;
--
--     And no column-scoped grant was introduced for the two new columns.
--     Expect zero rows.
--
--   select grantee, privilege_type, column_name
--   from information_schema.column_privileges
--   where table_schema = 'public' and table_name = 'checkout_attempts'
--     and column_name in ('annual_intent_fingerprint',
--                         'annual_request_fingerprint')
--     and grantee in ('anon', 'authenticated');
--
-- (l) RLS on public.checkout_attempts is untouched: still enabled, still
--     with no policies at all. Expect relrowsecurity = true and zero
--     policy rows.
--
--   select relrowsecurity, relforcerowsecurity
--   from pg_class where oid = 'public.checkout_attempts'::regclass;
--
--   select policyname from pg_policies
--   where schemaname = 'public' and tablename = 'checkout_attempts';
--
-- (m) 039's tables and constraints are untouched. Expect the annual
--     tables still empty and their CHECK constraints still present.
--
--   select count(*) from public.annual_plans;
--   select count(*) from public.annual_plan_deliveries;
--
--   select conname
--   from pg_constraint
--   where conrelid = 'public.checkout_attempts'::regclass
--     and conname in ('checkout_attempts_annual_delivery_paired_check',
--                     'checkout_attempts_annual_delivery_no_stripe_payment_check')
--   order by conname;
