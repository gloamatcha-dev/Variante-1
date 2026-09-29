-- ============================================================
-- GLOA – the annual claim becomes the CUSTOMER'S, not the subscription's
--
-- Phase 4B11. Run in the Supabase SQL Editor against the existing
-- production project, INSIDE the transaction below.
--
-- NOT YET APPLIED. This file exists so the code that needs it can be
-- reviewed against the exact schema it assumes.
--
-- IT IS SAFE TO APPLY BEFORE THE CODE THAT USES IT SHIPS, and that is
-- deliberate - see section 7. The last two phases took annual checkout
-- down because code reached Production before its migration; this one
-- is built so the migration can go first and the old code keeps working
-- unchanged while it does.
-- ============================================================
--
-- ── THE RACE 067 DOES NOT CLOSE ──────────────────────────────
--
-- 067 keyed its claim on source_subscription_id, so it gates the UPGRADE
-- path and nothing else. An ordinary annual purchase names no
-- subscription, so it takes no claim, meets no claim, and is invisible
-- to the gate. The audit measured the result against real PostgreSQL:
--
--     tab_a: created        tab_b: created
--     settled_a: activated  settled_b: activated
--     active_annual_plans_one_user | boxes_owed | cents_charged
--                                2 |         26 |         28600
--
-- Two tabs, two ordinary annual checkouts, two payable sessions, two
-- charges, two live contracts and twenty-six boxes owed. The same holds
-- for one upgrade tab beside one ordinary tab, because the two paths do
-- not look at each other at all.
--
-- ── SO THE EXCLUSION DOMAIN BECOMES THE CUSTOMER ─────────────
--
--     ONE B2C USER MAY HAVE AT MOST ONE LIVE OR PAYABLE ANNUAL-PLAN
--     PURCHASE AT A TIME.
--
-- One domain, not two. 067's per-subscription claim is KEPT - it states
-- a narrower thing that is still true and still worth enforcing - but it
-- is no longer what stops a duplicate charge. The customer-level claim
-- is, and it sees every path because it is keyed on the one value every
-- annual plan has: user_id.
--
-- ── THE THING THIS MIGRATION ALMOST GOT WRONG ────────────────
--
-- The obvious invariant is "unique (user_id) where status = 'active'".
-- IT IS WRONG, and it would have been a silent regression.
--
-- A refund writes payment_status and NOTHING ELSE - migration 039's
-- record_annual_plan_refund sets payment_status and refunded_total_cents
-- and leaves status exactly as it was. So a FULLY REFUNDED plan sits at
-- status = 'active' forever. Under the obvious index, a customer who was
-- given their 252,07 EUR back could never buy another annual plan: their
-- refunded row would occupy the unique slot for good, and the refusal
-- would arrive at SETTLEMENT, after they had paid again.
--
-- lib/purchaseEligibility.ts already says this in prose - "a plan they
-- were refunded for must NOT keep consuming their right to buy another
-- one - it is the clearest case of history being mistaken for
-- entitlement, and it is the production case this module was written
-- for". The index below is that sentence, in the database, and its
-- predicate is isLiveAnnualPlan's predicate exactly:
--
--     status = 'active' AND payment_status <> 'refunded'
--
-- ── WHAT THIS DOES NOT DO ────────────────────────────────────
--
-- It changes no price, no discount, no delivery count, no cadence, no
-- refund rule, nothing about migration 034's cancellation cutoff, and
-- nothing about 066's anchor or 067's upgrade transition. It does not
-- touch activate_annual_plan_from_payment AT ALL - the function is left
-- byte-for-byte as 067 wrote it, and the new index is caught by the
-- unique_violation handler 067 already put around its UPDATE.
--
-- It backfills nothing and reads no existing row.
--
-- ============================================================

begin;

-- 1. A CLAIM MAY BELONG TO ANY PENDING ANNUAL CHECKOUT ─────────
--
-- 067's CHECK tied pending_expires_at to an UPGRADE row, because an
-- upgrade was the only thing that could hold a claim. Now an ordinary
-- pending checkout holds one too, so the constraint widens by exactly
-- one clause and keeps everything else it promised:
--
--     status      source    claim    meaning
--     pending     NULL      set      an ordinary checkout, payable now
--     pending     set       set      an upgrade checkout, payable now
--     pending     either    NULL     a checkout that took no claim, which
--                                    is what the PRE-068 application
--                                    still creates (see section 7)
--     active      -         NULL     a settled plan; the claim is spent
--     completed   -         NULL     over
--     cancelled   -         NULL     over
--
-- A SETTLED OR TERMINAL ROW STILL MAY NOT HOLD ONE. That half is
-- unchanged and is what keeps a live contract from blocking the
-- customer's next purchase for half an hour after they already own it.
--
-- Dropped and re-added rather than edited, because PostgreSQL has no
-- ALTER CONSTRAINT for a CHECK. The new one is strictly weaker, so it
-- cannot fail against existing rows: every row that satisfied 067's
-- version satisfies this one.

alter table public.annual_plans
  drop constraint annual_plans_pending_claim_shape_check;

alter table public.annual_plans
  add constraint annual_plans_pending_claim_shape_check
  check (pending_expires_at is null or status = 'pending');


-- 2. ONE LIVE ANNUAL PLAN PER CUSTOMER ─────────────────────────
--
-- THE POST-PAYMENT HALF, and the backstop the pre-payment claim in
-- section 4 sits in front of. Two settlements can both pass every read
-- and only one can commit the row that takes this index.
--
-- The predicate is isLiveAnnualPlan's, for the reason set out at the top
-- of this file: 'active' alone would make a refunded plan a permanent
-- veto on repurchase. 'completed' and 'cancelled' are outside the
-- predicate too, so a finished year and an ended plan both allow
-- another one - which is requirement H and is the behaviour the account
-- and the checkout route already promise.
--
-- IT SUBSUMES 066'S INDEX FOR THE SAME CUSTOMER but does not replace it:
-- 066's is per SUBSCRIPTION and says something this one cannot, so it
-- stays exactly as it is. Neither is dropped, weakened or recreated.
--
-- THE LOSER IS ALREADY HANDLED. 067's activation wraps its UPDATE in an
-- exception block catching unique_violation and answers
-- 'transition_conflict' with every write rolled back, which the webhook
-- rules already treat as terminal and acknowledge rather than retry. So
-- this index needs no code change to be safe, and that is what lets it
-- be applied before any code ships.

create unique index annual_plans_one_live_per_user_key
  on public.annual_plans (user_id)
  where status = 'active'
    and payment_status <> 'refunded';


-- 3. THE CUSTOMER-KEYED CLAIM LOOKUP HAS AN INDEX ──────────────
--
-- Section 4's refusal runs while holding the customer's profile lock, so
-- it is on the critical path of every annual checkout and must not be a
-- scan. Partial, on exactly the population it asks about.
--
-- Deliberately NOT unique, for 067's reason restated: a unique index
-- cannot express "unique among the UNEXPIRED", and one here would
-- reinstate the permanent veto that an expiring claim exists to avoid.
--
-- 067's per-subscription claim index is left in place. It serves the
-- narrower question section 4 still asks afterwards.

create index annual_plans_pending_customer_claim_idx
  on public.annual_plans (user_id, pending_expires_at)
  where status = 'pending';


-- 4. THE WRITER SERIALIZES BY CUSTOMER ─────────────────────────
--
-- SEVENTEEN ARGUMENTS, UNCHANGED, and that is the whole deployment
-- story. CREATE OR REPLACE at 067's exact signature: no DROP, so every
-- grant survives, no caller has to change, and the application that is
-- running in Production right now keeps resolving to this function and
-- keeps working the moment this file commits. See section 7.
--
-- ── WHICH ROW IS LOCKED, AND WHY THAT ONE ─────────────────────
--
-- public.profiles, by user_id. The decision was between three
-- candidates and it is worth recording why:
--
--   auth.users          FK-guaranteed to exist, but it is Supabase's
--                       table, not ours. Taking a row lock on it from
--                       our transaction couples annual checkout to
--                       GoTrue's own writes, which is a deadlock surface
--                       nobody here controls or can observe.
--
--   an advisory lock    needs no row and cannot fail, but it is invisible
--                       to anyone reading the schema, and a future writer
--                       that forgets it loses the exclusion silently.
--
--   public.profiles     OURS. Exactly one row per user, primary key on
--                       user_id, created by migration 001's trigger on
--                       signup and removed only by ON DELETE CASCADE
--                       when the user is. It is a real row lock, visible
--                       in pg_locks against a named relation, and it
--                       contends with nothing but an edit to the
--                       customer's own name.
--
-- AND IT FAILS CLOSED. profiles is created by a trigger rather than by a
-- foreign key, so "the row is always there" is a strong convention and
-- not a proof. A SELECT ... FOR UPDATE that matches nothing locks
-- nothing and would let both tabs through - the one failure mode this
-- whole migration exists to prevent - so a missing profile REFUSES the
-- checkout instead. A B2C customer without a profile row is a data fault
-- and not a purchase.
--
-- ── LOCK ORDER, stated so a later writer does not invert it ───
--
--     checkout_attempts  →  profiles  →  subscriptions
--
-- Every caller takes them in that order and this is the only function
-- that holds more than one of them, so there is no cycle and no
-- deadlock. Two ordinary checkouts contend on profiles alone; two
-- upgrades of one subscription contend on profiles first and would
-- contend on the subscription second if they ever got that far.
--
-- ── THE EXISTING PLAN STILL SHORT-CIRCUITS FIRST ──────────────
--
-- The 'existing' return for this attempt's own plan is above all of
-- this, unchanged, so a retry of the SAME request id never takes the
-- customer lock and can never be blocked by the claim it created itself.

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
  p_expected_annual_request_fingerprint text,
  p_source_subscription_id          uuid,
  p_pending_expires_at              timestamptz
)
returns jsonb
language plpgsql
volatile
security definer set search_path = ''
as $$
declare
  v_attempt public.checkout_attempts;
  v_plan    public.annual_plans;
  v_sub     public.subscriptions;
  v_rival   public.annual_plans;
  v_profile public.profiles;
  v_count   integer;
  v_merch   integer;
  v_ship    integer;
  v_total   integer;
begin
  if p_checkout_attempt_id is null or p_user_id is null or p_variant_id is null then
    return pg_catalog.jsonb_build_object('result', 'invalid_input');
  end if;

  select * into v_attempt
  from public.checkout_attempts
  where id = p_checkout_attempt_id
  for update;

  if not found then
    return pg_catalog.jsonb_build_object('result', 'attempt_not_found');
  end if;

  if v_attempt.user_id is distinct from p_user_id then
    return pg_catalog.jsonb_build_object('result', 'attempt_not_owned');
  end if;

  -- ── THE TWO FINGERPRINT GATES (migration 040) ─────────────
  if v_attempt.annual_intent_fingerprint is null
     or v_attempt.annual_intent_fingerprint is distinct from p_expected_annual_intent_fingerprint
  then
    return pg_catalog.jsonb_build_object('result', 'attempt_intent_mismatch');
  end if;

  select * into v_plan
  from public.annual_plans
  where payment_checkout_attempt_id = p_checkout_attempt_id;

  if found then
    return pg_catalog.jsonb_build_object(
      'result', 'existing',
      'annual_plan_id', v_plan.id,
      'status', v_plan.status,
      'pending_expires_at', v_plan.pending_expires_at
    );
  end if;

  if v_attempt.annual_request_fingerprint is null
     or v_attempt.annual_request_fingerprint is distinct from p_expected_annual_request_fingerprint
  then
    return pg_catalog.jsonb_build_object('result', 'attempt_request_mismatch');
  end if;

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

  -- ── THE CLAIM WINDOW, IF ONE WAS OFFERED ──────────────────
  --
  -- 067 REQUIRED one for an upgrade and REFUSED one for an ordinary
  -- purchase. Both halves change here, and in opposite directions:
  --
  --   an ordinary purchase MAY now hold a claim, which is the point of
  --   this migration.
  --
  --   an upgrade may now arrive WITHOUT one, which is not a loosening of
  --   the invariant but the rollout seam. The application running in
  --   Production before this file's own code ships sends NULL for every
  --   ordinary purchase, and refusing that would take annual checkout
  --   down the moment this migration committed. A call that offers no
  --   claim simply TAKES no claim - it is still refused below by every
  --   claim somebody else holds, so it can never be the second payable
  --   checkout. It can only fail to be the first.
  --
  -- The bounds are unchanged: a claim must be in the future and may not
  -- outlast the longest Checkout Session Stripe will issue.
  if p_pending_expires_at is not null
     and (p_pending_expires_at <= pg_catalog.now()
          or p_pending_expires_at > pg_catalog.now() + pg_catalog.make_interval(hours => 24))
  then
    return pg_catalog.jsonb_build_object('result', 'claim_expiry_invalid');
  end if;

  -- ── THE CUSTOMER LOCK. EVERYTHING BELOW READS UNDER IT ────
  --
  -- Taken before the first question about what else this customer has,
  -- so two tabs cannot both read "nothing in the way" and both proceed.
  select * into v_profile
  from public.profiles
  where user_id = p_user_id
  for update;

  if not found then
    -- Fails closed. See the note above: an unlocked checkout is exactly
    -- the thing this function exists to make impossible.
    return pg_catalog.jsonb_build_object('result', 'customer_profile_missing');
  end if;

  -- ── IS ANOTHER ANNUAL CHECKOUT STILL PAYABLE? ─────────────
  --
  -- THE ONE REFUSAL THAT COVERS ALL FOUR COMBINATIONS - ordinary beside
  -- ordinary, upgrade beside ordinary, ordinary beside upgrade, upgrade
  -- beside upgrade - because it is keyed on the only value all four
  -- share. Only an UNEXPIRED claim counts, which is what makes an
  -- abandoned tab self-healing and needs no sweep to be correct.
  select * into v_rival
  from public.annual_plans
  where user_id = p_user_id
    and status = 'pending'
    and pending_expires_at > pg_catalog.now()
    and payment_checkout_attempt_id is distinct from p_checkout_attempt_id
  order by pending_expires_at desc
  limit 1;

  if found then
    return pg_catalog.jsonb_build_object(
      'result', 'annual_checkout_already_pending',
      'pending_expires_at', v_rival.pending_expires_at
    );
  end if;

  -- ── AND IS ONE ALREADY RUNNING? ───────────────────────────
  --
  -- isLiveAnnualPlan's predicate, under the lock, so the route's own
  -- refusal and this one cannot disagree and a race between them cannot
  -- produce two live contracts. A refunded, completed or cancelled plan
  -- is history and blocks nothing - see the header.
  select * into v_rival
  from public.annual_plans
  where user_id = p_user_id
    and status = 'active'
    and payment_status <> 'refunded'
  limit 1;

  if found then
    return pg_catalog.jsonb_build_object('result', 'annual_plan_already_live');
  end if;

  -- ── THE SOURCE SUBSCRIPTION, WHEN THERE IS ONE ────────────
  --
  -- Unchanged from 067 except that the lock is now taken SECOND. Absent
  -- is the ordinary purchase and is not checked at all.
  if p_source_subscription_id is not null then
    select * into v_sub
    from public.subscriptions
    where id = p_source_subscription_id
      and user_id = p_user_id
    for update;

    if not found then
      return pg_catalog.jsonb_build_object('result', 'source_not_found');
    end if;

    if v_sub.customer_type is distinct from 'private' then
      return pg_catalog.jsonb_build_object('result', 'source_not_eligible');
    end if;

    if v_sub.status not in ('active', 'past_due', 'unpaid')
       or v_sub.cancelled_at is not null
       or v_sub.stripe_subscription_id is null
    then
      return pg_catalog.jsonb_build_object(
        'result', 'source_not_eligible',
        'status', v_sub.status
      );
    end if;

    -- MIGRATION 067'S NARROWER QUESTION, KEPT. The customer-level
    -- refusal above already covers every duplicate payment; this states
    -- the additional thing 067 promised - one upgrade per subscription -
    -- and is left standing rather than quietly absorbed.
    select * into v_rival
    from public.annual_plans
    where source_subscription_id = p_source_subscription_id
      and status = 'pending'
      and pending_expires_at > pg_catalog.now()
      and payment_checkout_attempt_id is distinct from p_checkout_attempt_id
    order by pending_expires_at desc
    limit 1;

    if found then
      return pg_catalog.jsonb_build_object(
        'result', 'upgrade_already_pending',
        'pending_expires_at', v_rival.pending_expires_at
      );
    end if;
  end if;

  v_count := 13;
  v_merch := p_annual_unit_gross_cents * v_count;
  v_ship  := p_shipping_per_delivery_gross_cents * v_count;
  v_total := v_merch + v_ship;

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
      delivery_tax_snapshot,
      source_subscription_id,
      pending_expires_at
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
      p_delivery_tax_snapshot,
      p_source_subscription_id,
      p_pending_expires_at
    )
    returning * into v_plan;
  exception
    when unique_violation then
      select * into v_plan
      from public.annual_plans
      where payment_checkout_attempt_id = p_checkout_attempt_id;
      if found then
        return pg_catalog.jsonb_build_object(
          'result', 'existing',
          'annual_plan_id', v_plan.id,
          'status', v_plan.status,
          'pending_expires_at', v_plan.pending_expires_at
        );
      end if;
      raise;
  end;

  return pg_catalog.jsonb_build_object(
    'result', 'created',
    'annual_plan_id', v_plan.id,
    'status', v_plan.status,
    'total_gross_cents', v_plan.total_gross_cents,
    'pending_expires_at', v_plan.pending_expires_at
  );
end;
$$;


-- 5. PRIVILEGES ────────────────────────────────────────────────
--
-- NOTHING TO RESTATE, and that is the point. The function was REPLACED
-- rather than dropped, so it kept every grant 067 gave it: revoked from
-- public, anon and authenticated, executable by service_role alone.
-- activate_annual_plan_from_payment was not touched at all.
--
-- NO BROWSER GRANT IS ADDED. pending_expires_at is still machinery with
-- no reader, and migration 041's rule - that the column grants and the
-- account's select list are the same list - still holds exactly.


-- 6. WHAT THE FUNCTION NOW NEEDS TO READ ───────────────────────
--
-- public.profiles, as the lock target. The function is SECURITY DEFINER
-- and runs as its owner, so it does not need a grant to read it and no
-- role's privileges change. RLS on profiles is not consulted for the
-- owner either, which is why this is a lock and not a leak: the function
-- returns nothing from the row, not the name, not the customer type,
-- not even that it exists beyond one refusal word.


-- 7. WHY THIS MAY BE APPLIED BEFORE ITS CODE ───────────────────
--
-- THE LAST TWO PHASES SHIPPED CODE FIRST AND TOOK ANNUAL CHECKOUT DOWN.
-- This file is arranged so the opposite order is the safe one, and the
-- reason is that nothing here requires a caller to change:
--
--   THE SIGNATURE IS IDENTICAL. Seventeen arguments, same names, same
--   types, same order. PostgREST resolves the running application's call
--   to this function exactly as it resolved it to 067's.
--
--   A NULL CLAIM IS STILL ACCEPTED. The pre-068 application sends NULL
--   for every ordinary purchase. That call still succeeds; it simply
--   takes no claim of its own, and it is still refused by any claim
--   another tab holds.
--
--   THE NEW INDEX NEEDS NO NEW HANDLER. 067's activation already catches
--   unique_violation and answers 'transition_conflict', which the
--   webhook rules already treat as terminal and acknowledge.
--
--   THE NEW CHECK IS STRICTLY WEAKER than the one it replaces, so no
--   existing row and no row the old code writes can violate it.
--
-- SO THE ORDER IS: apply this migration, confirm it, then ship the code
-- that starts sending a claim for ordinary purchases. Between the two,
-- Production is strictly SAFER than it is today - it already has the
-- one-live-plan-per-user index and the customer-level refusals - and
-- nothing that worked before stops working.
--
-- THE REVERSE ORDER IS NOT SAFE, and it is worth saying plainly: the new
-- code sends a claim for an ordinary purchase, and 067's function
-- answers 'claim_not_expected' to that, which is a 409. Shipping the
-- code first would refuse every ordinary annual checkout in Production.

commit;


-- ============================================================
-- 8. VERIFY - READ ONLY, AFTER APPLYING. NOTHING BELOW RUNS.
-- ============================================================
--
--   A. NO CUSTOMER HOLDS TWO LIVE ANNUAL PLANS.
--
--   select user_id, count(*)
--   from public.annual_plans
--   where status = 'active' and payment_status <> 'refunded'
--   group by user_id having count(*) > 1;
--
--     EXPECT no rows. If this returns anything the CREATE INDEX above
--     would have failed and the whole transaction rolled back, so seeing
--     rows here means the migration did not apply.
--
--   B. A REFUNDED PLAN STILL ALLOWS A REPURCHASE.
--
--   select count(*) from public.annual_plans
--   where status = 'active' and payment_status = 'refunded';
--
--     However many there are, none of them occupies the unique slot -
--     that is the whole reason the index carries the payment_status
--     clause. Confirm the count is unchanged from before the migration.
--
--   C. THE CLAIM SHAPE WIDENED AND NOTHING ELSE DID.
--
--   select conname, pg_catalog.pg_get_constraintdef(oid)
--   from pg_catalog.pg_constraint
--   where conrelid = 'public.annual_plans'::regclass and contype = 'c'
--     and conname like '%claim%' or conname like '%anchor%'
--   order by conname;
--
--     EXPECT annual_plans_pending_claim_shape_check to read
--     "pending_expires_at IS NULL OR status = 'pending'", and BOTH 066
--     anchor constraints to be exactly as 066 wrote them.
--
--   D. EXACTLY ONE OVERLOAD OF EACH FUNCTION SURVIVES.
--
--   select p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid)
--   from pg_catalog.pg_proc p
--   join pg_catalog.pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public'
--     and p.proname in ('create_pending_annual_plan_for_attempt',
--                       'activate_annual_plan_from_payment')
--   order by 1;
--
--     EXPECT two rows, both with 067's argument lists unchanged. This
--     migration adds no argument to either.
--
--   E. ALL FOUR INDEXES STAND.
--
--   select indexname from pg_indexes
--   where schemaname = 'public' and tablename = 'annual_plans'
--     and indexname in ('annual_plans_active_upgrade_per_subscription_key',
--                       'annual_plans_pending_upgrade_claim_idx',
--                       'annual_plans_one_live_per_user_key',
--                       'annual_plans_pending_customer_claim_idx')
--   order by indexname;
--
--     EXPECT all four. The first two are 066's and 067's and must not
--     have been touched.
--
--   F. THE BROWSER'S PRIVILEGES DID NOT MOVE.
--
--   select count(*) from information_schema.column_privileges
--   where table_schema = 'public' and table_name = 'annual_plans'
--     and grantee = 'authenticated' and privilege_type = 'SELECT';
--
--     EXPECT 21, exactly as after 066, with pending_expires_at still
--     not among them.
