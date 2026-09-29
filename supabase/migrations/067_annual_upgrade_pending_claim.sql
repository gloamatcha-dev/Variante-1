-- ============================================================
-- GLOA – the expiring pending claim on an annual upgrade
--
-- Phase 4B10. Run in the Supabase SQL Editor against the existing
-- production project, INSIDE the transaction below.
--
-- NOT YET APPLIED. This file exists so the code that needs it can be
-- reviewed against the exact schema it assumes.
-- ============================================================
--
-- ── THE RACE MIGRATION 066 DOES NOT CLOSE ────────────────────
--
-- 066 made two ACTIVE upgrade plans for one subscription impossible. It
-- said so itself, in section 3, and it was right about its own limit:
--
--     WHAT IT DOES NOT CLAIM TO PREVENT: two people paying twice in the
--     same few seconds.
--
-- The audit then proved what that costs. Two browser tabs mint two
-- request ids, so they mint two checkout attempts, two PENDING upgrade
-- plans and TWO PAYABLE STRIPE CHECKOUT SESSIONS. Stripe captures the
-- money when a session completes; every row this database holds is
-- written afterwards. So both charges land, the first settlement takes
-- the active-only unique index, the second meets it and is refused as
-- 'transition_conflict' - and the customer has paid twice and holds one
-- contract, with the loser sitting 'pending' where nothing renders it.
--
-- The index converted a duplicate CONTRACT into a silent duplicate
-- CHARGE. That is not an improvement, and no constraint on annual_plans
-- can fix it, because by the time a constraint is evaluated the money is
-- already gone.
--
-- ── SO THE GATE MOVES IN FRONT OF STRIPE ─────────────────────
--
-- The only moment this system still controls is the one before a
-- Checkout Session exists. This migration puts a claim there:
--
--     FOR ONE SOURCE SUBSCRIPTION, ONLY ONE PAYABLE ANNUAL-UPGRADE
--     CHECKOUT MAY EXIST AT A TIME.
--
-- ── WHY A PLAIN "NO PENDING ROW" GATE WOULD BE WRONG ─────────
--
-- Because that is the gate the repurchase work of Phase 4B8 deliberately
-- removed, and its reasoning still stands: nothing expires a pending
-- row, so one abandoned tab would veto that customer's upgrade for good.
-- lib/purchaseEligibility.ts states it plainly - "pending: not a
-- contract at all ... an abandoned checkout would otherwise veto every
-- future purchase".
--
-- What was missing was never a blockade. It was a LIFETIME. A claim that
-- expires on the same clock that makes the rival session unpayable
-- blocks exactly as long as it must and not one second longer, and it
-- needs no sweep, no cron and no webhook to be correct.
--
-- ── WHAT THIS DOES NOT DO ────────────────────────────────────
--
-- An ORDINARY annual purchase is untouched. pending_expires_at is NULL
-- for every existing row and for every plan bought without an upgrade,
-- the new argument must be NULL for it, and not one existing row is
-- read, rewritten or backfilled by this file.
--
-- It changes no price, no discount, no delivery count, no cadence, no
-- refund rule, nothing about migration 034's cancellation cutoff, and
-- nothing about 066's transition algorithm or its anchor. It does not
-- weaken, replace or re-create 066's active-only unique index: that
-- index remains, as the post-payment backstop behind this pre-payment
-- gate.
--
-- ============================================================

begin;

-- 1. THE CLAIM COLUMN ──────────────────────────────────────────
--
-- WHEN THIS UPGRADE CHECKOUT STOPS BEING PAYABLE, and therefore when it
-- stops standing in the way of another one.
--
-- It is written when the upgrade CHECKOUT is created - before Stripe,
-- before payment - because the whole point is to exist before a second
-- session can. It is the SAME instant the Stripe Checkout Session is
-- given as its own expires_at, passed down from one server-side value
-- rather than computed twice; see section 3 for why that identity is the
-- load-bearing property of this design and not a tidiness preference.
--
-- NULL means "holds no claim", and that is the state of every row that
-- exists today, every ordinary annual plan, and every upgrade that has
-- settled or ended.

alter table public.annual_plans
  add column pending_expires_at timestamptz;


-- 2. A CLAIM BELONGS ONLY TO A PENDING UPGRADE ─────────────────
--
-- Three things at once, and each of them is a state that would otherwise
-- be reachable by a future writer that simply forgot:
--
--     an ORDINARY plan may never hold one. There is no subscription for
--     it to be a claim against, so a value here would be a veto with no
--     subject.
--
--     a SETTLED upgrade may never hold one. Activation is the moment the
--     claim has done its work; carrying it forward would let a live
--     contract go on blocking the customer's next purchase for half an
--     hour after they already own the year.
--
--     a TERMINAL row may never hold one. 'completed' and 'cancelled' owe
--     nothing and can block nothing.
--
-- This is what the task means by "terminal rows must not hold a live
-- claim", made structural rather than conventional. It is also why
-- activation in section 5 clears the column in the same UPDATE that sets
-- the status: with this constraint standing, it could not do otherwise.

alter table public.annual_plans
  add constraint annual_plans_pending_claim_shape_check
  check (
    pending_expires_at is null
    or (status = 'pending' and source_subscription_id is not null)
  );


-- 3. THE CLAIM LOOKUP HAS AN INDEX ─────────────────────────────
--
-- The refusal in section 4 runs inside a transaction that is already
-- holding a row lock on the customer's subscription, so it is on the
-- critical path of every upgrade checkout and must not be a scan of
-- annual_plans.
--
-- Partial, on exactly the population the predicate asks about: pending
-- upgrades. Deliberately NOT unique - a unique index cannot express
-- "unique among the unexpired", which is the whole distinction this
-- migration exists to draw, and would reinstate the permanent veto.
-- Uniqueness among the LIVE claims is enforced by the predicate under
-- the subscription row lock, which is exact and needs no sweep.

create index annual_plans_pending_upgrade_claim_idx
  on public.annual_plans (source_subscription_id, pending_expires_at)
  where source_subscription_id is not null
    and status = 'pending';


-- 4. THE WRITER TAKES THE LOCK AND THE CLAIM ───────────────────
--
-- Seventeen arguments now. Dropped and recreated rather than overloaded,
-- exactly as migrations 040 and 066 did before it: a second overload
-- reachable with the old argument count would be ambiguous to resolve
-- and would silently keep the unguarded behaviour alive.
--
-- ── THE LOCK, AND WHY A READ WOULD NOT DO ─────────────────────
--
-- The source subscription is selected FOR UPDATE, and the claim question
-- is asked only after that lock is held. Without it the two tabs are two
-- transactions that both read "no live claim", both insert, and both go
-- on to Stripe - which is precisely the race, restated one table
-- earlier. A pre-check in the route cannot close it for the same reason.
--
-- With it, the two transactions serialize on ONE row that both of them
-- must touch, and the second one reads the first one's committed claim
-- rather than the state that existed before it:
--
--     Tab A   locks S, sees no live claim, inserts a pending upgrade
--             holding a claim until T, commits.
--     Tab B   blocks on S until A commits, then acquires it, sees A's
--             unexpired claim, and is refused 'upgrade_already_pending'
--             WITHOUT creating a plan - so the route never reaches
--             Stripe and no second payable session is ever minted.
--
-- LOCK ORDER, stated so a later writer does not invert it: this function
-- takes checkout_attempts first and subscriptions second. It is the only
-- function in the schema that holds both, and two concurrent upgrade
-- requests always hold DIFFERENT attempts, so they contend on the
-- subscription alone. There is no cycle and therefore no deadlock.
--
-- ── AND THE EXISTING PLAN STILL SHORT-CIRCUITS FIRST ──────────
--
-- The 'existing' return for this attempt's own plan is above all of
-- this, unchanged. A retry of the SAME request id therefore never
-- reaches the claim check and can never be blocked by the claim it
-- created itself - it gets its own plan back, with its own expiry, and
-- converges on its own Stripe session through the unchanged idempotency
-- key.

drop function public.create_pending_annual_plan_for_attempt(
  uuid, uuid, uuid, integer, integer, integer, numeric,
  jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, text, text, uuid
);

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
  --
  -- The identity half is compared ALWAYS. The priced half is compared
  -- only while no plan exists yet, because once one does it IS the
  -- answer and refusing the retry would strand the customer.
  if v_attempt.annual_intent_fingerprint is null
     or v_attempt.annual_intent_fingerprint is distinct from p_expected_annual_intent_fingerprint
  then
    return pg_catalog.jsonb_build_object('result', 'attempt_intent_mismatch');
  end if;

  select * into v_plan
  from public.annual_plans
  where payment_checkout_attempt_id = p_checkout_attempt_id;

  -- THIS CHECKOUT'S OWN PLAN, AND ITS OWN CLAIM. The expiry is returned
  -- alongside the id because the caller needs ONE authoritative value to
  -- give Stripe, and on a retry that value is the stored one rather than
  -- a freshly computed one. See section 6.
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

  -- ── THE CLAIM IS REQUIRED EXACTLY WHEN THE UPGRADE IS ─────
  --
  -- Both directions are refusals rather than fallbacks, for the same
  -- reason 066 refuses a mismatched anchor: a pending upgrade with no
  -- expiry would be the permanent veto this migration exists to avoid,
  -- and an ordinary purchase carrying one would be a claim against a
  -- subscription it does not name. Section 2's CHECK would refuse the
  -- second anyway; this says so in words the caller can read.
  --
  -- THE UPPER BOUND IS NOT DECORATION. It is the longest a Checkout
  -- Session may live at Stripe, so a caller that ever computed a wrong
  -- value cannot turn a thirty-minute gate into a day-long one.
  if p_source_subscription_id is null then
    if p_pending_expires_at is not null then
      return pg_catalog.jsonb_build_object('result', 'claim_not_expected');
    end if;
  else
    if p_pending_expires_at is null
       or p_pending_expires_at <= pg_catalog.now()
       or p_pending_expires_at > pg_catalog.now() + pg_catalog.make_interval(hours => 24)
    then
      return pg_catalog.jsonb_build_object('result', 'claim_expiry_invalid');
    end if;
  end if;

  -- ── THE SOURCE SUBSCRIPTION, WHEN THERE IS ONE ────────────
  --
  -- Absent is the ordinary purchase and is not checked at all. Present
  -- has to survive four questions now, and a failure at any of them
  -- creates NOTHING: it is better for an upgrade checkout to refuse than
  -- for a plan to exist pointing at a subscription that cannot hand over
  -- - or beside one that is already being handed over.
  if p_source_subscription_id is not null then
    -- FOR UPDATE, AND THIS IS THE WHOLE GATE. Everything below reads
    -- state that another transaction could otherwise still be changing.
    -- The lock is taken before the claim question is asked and is held
    -- until this transaction commits or rolls back.
    select * into v_sub
    from public.subscriptions
    where id = p_source_subscription_id
      and user_id = p_user_id
    for update;

    -- Somebody else's subscription is indistinguishable from one that
    -- does not exist, so this cannot be used to probe which ids are real.
    if not found then
      return pg_catalog.jsonb_build_object('result', 'source_not_found');
    end if;

    -- B2C only, exactly as migration 034's cancellation writer insists.
    -- The B2B supply agreements are a different system and must never be
    -- terminated through an annual upgrade.
    if v_sub.customer_type is distinct from 'private' then
      return pg_catalog.jsonb_build_object('result', 'source_not_eligible');
    end if;

    -- It has to be a subscription that can still hand something over: a
    -- live lifecycle state and a Stripe binding to stop. 'pending' has no
    -- Stripe subscription; 'cancelled' is over and owes nothing.
    if v_sub.status not in ('active', 'past_due', 'unpaid')
       or v_sub.cancelled_at is not null
       or v_sub.stripe_subscription_id is null
    then
      return pg_catalog.jsonb_build_object(
        'result', 'source_not_eligible',
        'status', v_sub.status
      );
    end if;

    -- ── IS ANOTHER UPGRADE CHECKOUT STILL PAYABLE? ──────────
    --
    -- The one new refusal, and the reason this file exists. Only a
    -- PENDING row with an expiry STILL IN THE FUTURE counts: an expired
    -- claim is not a claim, which is what makes an abandoned tab
    -- self-healing rather than a permanent veto, and what makes this
    -- correct without any cleanup job ever running.
    --
    -- The attempt exclusion is belt and braces - this attempt's own plan
    -- already returned 'existing' far above and cannot be here - but it
    -- states the intent at the point a later reader will ask about it.
    select * into v_rival
    from public.annual_plans
    where source_subscription_id = p_source_subscription_id
      and status = 'pending'
      and pending_expires_at > pg_catalog.now()
      and payment_checkout_attempt_id is distinct from p_checkout_attempt_id
    order by pending_expires_at desc
    limit 1;

    if found then
      -- ENOUGH FOR THE ROUTE TO SAY SOMETHING TRUE, AND NOTHING MORE.
      -- The expiry is the customer's own, on their own subscription, and
      -- it is what makes "or try again shortly" an honest sentence. No
      -- plan id, no attempt id, no Stripe identity and no amount leaves
      -- this refusal, and the row it found is provably this same
      -- customer's: it hangs off a subscription this function has
      -- already proved they own.
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
      -- MIGRATION 066. schedule_anchor_at is still deliberately NOT
      -- written here: nothing has been paid for yet, so there is no
      -- handover date to promise.
      source_subscription_id,
      -- MIGRATION 067. The claim, and it is durable from this moment -
      -- committed before the caller is allowed to contact Stripe.
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


-- 5. ACTIVATION RELEASES THE CLAIM ─────────────────────────────
--
-- CREATE OR REPLACE, not drop and create: the signature is byte-for-byte
-- migration 066's, so the existing grants survive and no caller has to
-- change. Every line of 066's body is preserved exactly - the anchor
-- rules, the idempotent already-active branch including its anchor
-- comparison, the transition_conflict handler, the 8736-hour term, the
-- 672-hour steps and the thirteen-row assertion.
--
-- ONE STATEMENT CHANGES, and it adds one assignment:
--
--     pending_expires_at = null
--
-- in the same UPDATE that sets the status to 'active'. Atomic with the
-- activation by construction, so there is no window in which a live
-- contract still holds a claim, and section 2's CHECK would refuse the
-- row if there were.
--
-- THE LOSER OF A TRANSITION CONFLICT KEEPS ITS CLAIM, and that is
-- correct: its UPDATE is rolled back whole, so the row stays 'pending'
-- with the expiry it was created with and stops blocking on its own
-- schedule. Nothing has to remember to release it.

create or replace function public.activate_annual_plan_from_payment(
  p_annual_plan_id             uuid,
  p_stripe_checkout_session_id text,
  p_stripe_payment_intent_id   text,
  p_schedule_anchor_at         timestamptz
)
returns jsonb
language plpgsql
volatile
security definer set search_path = ''
as $$
declare
  v_plan      public.annual_plans;
  v_attempt   public.checkout_attempts;
  v_purchased timestamptz;
  v_anchor    timestamptz;
  v_intent    text;
  v_session   text;
  v_created   integer;
begin
  if p_annual_plan_id is null
     or p_stripe_payment_intent_id is null
     or pg_catalog.btrim(p_stripe_payment_intent_id) = ''
     or p_stripe_checkout_session_id is null
     or pg_catalog.btrim(p_stripe_checkout_session_id) = ''
  then
    return pg_catalog.jsonb_build_object('result', 'invalid_input');
  end if;

  v_intent  := pg_catalog.btrim(p_stripe_payment_intent_id);
  v_session := pg_catalog.btrim(p_stripe_checkout_session_id);

  select * into v_plan
  from public.annual_plans
  where id = p_annual_plan_id
  for update;

  if not found then
    return pg_catalog.jsonb_build_object('result', 'not_found');
  end if;

  if v_plan.status in ('completed', 'cancelled') then
    return pg_catalog.jsonb_build_object(
      'result', 'terminal', 'annual_plan_id', v_plan.id, 'status', v_plan.status
    );
  end if;

  -- ── ALREADY ACTIVE: IDEMPOTENT, FOR THE SAME PAYMENT ──────
  --
  -- And for the same HANDOVER DATE. A redelivery that arrived with a
  -- different anchor is a correlation error, not a retry: adopting it
  -- would move thirteen dates the customer has already been shown and
  -- already been emailed. Unchanged from 066, including that this branch
  -- writes nothing at all - the claim was already cleared by the
  -- activation this is a replay of.
  if v_plan.status = 'active' then
    if v_plan.stripe_payment_intent_id is distinct from v_intent then
      return pg_catalog.jsonb_build_object(
        'result', 'payment_intent_conflict', 'annual_plan_id', v_plan.id
      );
    end if;
    if v_plan.stripe_checkout_session_id is distinct from v_session then
      return pg_catalog.jsonb_build_object(
        'result', 'checkout_session_conflict', 'annual_plan_id', v_plan.id
      );
    end if;
    if v_plan.schedule_anchor_at is distinct from p_schedule_anchor_at then
      return pg_catalog.jsonb_build_object(
        'result', 'anchor_conflict', 'annual_plan_id', v_plan.id
      );
    end if;
    select pg_catalog.count(*) into v_created
    from public.annual_plan_deliveries
    where annual_plan_id = v_plan.id;
    return pg_catalog.jsonb_build_object(
      'result', 'already_active',
      'annual_plan_id', v_plan.id,
      'deliveries', v_created
    );
  end if;

  select * into v_attempt
  from public.checkout_attempts
  where id = v_plan.payment_checkout_attempt_id
  for update;

  if not found then
    return pg_catalog.jsonb_build_object('result', 'attempt_not_found');
  end if;
  if v_attempt.status <> 'paid' then
    return pg_catalog.jsonb_build_object(
      'result', 'attempt_not_paid', 'attempt_status', v_attempt.status
    );
  end if;
  if v_attempt.expected_total_gross_cents is distinct from v_plan.total_gross_cents then
    return pg_catalog.jsonb_build_object('result', 'total_mismatch');
  end if;
  if v_attempt.user_id is distinct from v_plan.user_id then
    return pg_catalog.jsonb_build_object('result', 'attempt_owner_mismatch');
  end if;

  if v_attempt.stripe_payment_intent_id is null
     or pg_catalog.btrim(v_attempt.stripe_payment_intent_id) = ''
  then
    return pg_catalog.jsonb_build_object('result', 'attempt_payment_intent_missing');
  end if;
  if v_attempt.stripe_checkout_session_id is null
     or pg_catalog.btrim(v_attempt.stripe_checkout_session_id) = ''
  then
    return pg_catalog.jsonb_build_object('result', 'attempt_checkout_session_missing');
  end if;
  if pg_catalog.btrim(v_attempt.stripe_payment_intent_id) is distinct from v_intent then
    return pg_catalog.jsonb_build_object('result', 'payment_intent_conflict');
  end if;
  if pg_catalog.btrim(v_attempt.stripe_checkout_session_id) is distinct from v_session then
    return pg_catalog.jsonb_build_object('result', 'checkout_session_conflict');
  end if;

  if v_attempt.paid_at is null then
    return pg_catalog.jsonb_build_object('result', 'attempt_paid_at_missing');
  end if;
  v_purchased := v_attempt.paid_at;

  -- ── WHICH ANCHOR, AND IS IT THE RIGHT KIND (066) ──────────
  if v_plan.source_subscription_id is null then
    if p_schedule_anchor_at is not null then
      return pg_catalog.jsonb_build_object('result', 'anchor_not_expected');
    end if;
    v_anchor := v_purchased;
  else
    if p_schedule_anchor_at is null then
      return pg_catalog.jsonb_build_object('result', 'anchor_required');
    end if;
    if p_schedule_anchor_at < v_purchased then
      return pg_catalog.jsonb_build_object('result', 'anchor_before_purchase');
    end if;
    v_anchor := p_schedule_anchor_at;
  end if;

  -- ONE UPGRADE PER SUBSCRIPTION, still enforced by migration 066's
  -- partial unique index rather than by a read, and still the backstop
  -- behind the pre-payment claim rather than a replacement for it. The
  -- insert-style race is the whole point: two settlements can both see
  -- no active plan and only one can commit the UPDATE that makes one.
  begin
    update public.annual_plans
       set status                     = 'active',
           payment_status             = 'paid',
           purchased_at               = v_purchased,
           schedule_anchor_at         = p_schedule_anchor_at,
           plan_end_at                = v_anchor + pg_catalog.make_interval(hours => 8736),
           -- MIGRATION 067. The claim has done its work the moment this
           -- row stops being pending, and section 2's CHECK will not
           -- allow it to survive the transition anyway.
           pending_expires_at         = null,
           stripe_payment_intent_id   = pg_catalog.btrim(v_attempt.stripe_payment_intent_id),
           stripe_checkout_session_id = pg_catalog.btrim(v_attempt.stripe_checkout_session_id)
     where id = v_plan.id
    returning * into v_plan;
  exception
    when unique_violation then
      -- Another annual plan is already the active upgrade of this
      -- subscription. Nothing is written, the plan stays 'pending' WITH
      -- ITS CLAIM INTACT, and the caller must not treat this as a
      -- retryable fault.
      return pg_catalog.jsonb_build_object(
        'result', 'transition_conflict',
        'annual_plan_id', v_plan.id,
        'source_subscription_id', v_plan.source_subscription_id
      );
  end;

  insert into public.annual_plan_deliveries (
    annual_plan_id,
    delivery_number,
    scheduled_for,
    state
  )
  select v_plan.id,
         n,
         v_anchor + pg_catalog.make_interval(hours => 672 * (n - 1)),
         'scheduled'
  from pg_catalog.generate_series(1, v_plan.delivery_count) as n
  on conflict on constraint annual_plan_deliveries_plan_number_key do nothing;

  select pg_catalog.count(*) into v_created
  from public.annual_plan_deliveries
  where annual_plan_id = v_plan.id;

  if v_created <> v_plan.delivery_count then
    raise exception 'annual plan % has % delivery rows, expected %',
      v_plan.id, v_created, v_plan.delivery_count;
  end if;

  return pg_catalog.jsonb_build_object(
    'result', 'activated',
    'annual_plan_id', v_plan.id,
    'purchased_at', v_plan.purchased_at,
    'schedule_anchor_at', v_plan.schedule_anchor_at,
    'plan_end_at', v_plan.plan_end_at,
    'deliveries', v_created
  );
end;
$$;


-- 6. PRIVILEGES ────────────────────────────────────────────────
--
-- Only the pending-plan writer was dropped, so only it lost its grants.
-- They are restated exactly as 039, 040 and 066 held them: revoked from
-- public, anon and authenticated, executable by service_role alone.
--
-- activate_annual_plan_from_payment was REPLACED rather than dropped and
-- therefore kept every grant 066 gave it. Restating them would be
-- harmless and is deliberately not done: a reader should be able to see
-- from this file which function's privileges actually changed.

revoke all on function public.create_pending_annual_plan_for_attempt(
  uuid, uuid, uuid, integer, integer, integer, numeric,
  jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, text, text, uuid, timestamptz
) from public;
revoke all on function public.create_pending_annual_plan_for_attempt(
  uuid, uuid, uuid, integer, integer, integer, numeric,
  jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, text, text, uuid, timestamptz
) from anon;
revoke all on function public.create_pending_annual_plan_for_attempt(
  uuid, uuid, uuid, integer, integer, integer, numeric,
  jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, text, text, uuid, timestamptz
) from authenticated;
grant execute on function public.create_pending_annual_plan_for_attempt(
  uuid, uuid, uuid, integer, integer, integer, numeric,
  jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, text, text, uuid, timestamptz
) to service_role;


-- 7. THE BROWSER IS GRANTED NOTHING ────────────────────────────
--
-- Migration 041 replaced the table-level SELECT `authenticated` held
-- with COLUMN grants naming exactly what the account renders, so a new
-- column is invisible to the browser unless it is named here.
--
-- IT IS DELIBERATELY NOT NAMED. pending_expires_at is machinery: it
-- exists so one server-side writer can refuse another, and no account
-- surface reads it. 041's rule is that the grant list and the account's
-- select list are the same list - a column granted with no reader would
-- make that false on the day it was added, and the focused suite
-- asserts the two against each other precisely so nobody can.
--
-- The customer is told about a live claim by the checkout route, in a
-- sentence, without a date. That needs no column privilege at all.

commit;


-- ============================================================
-- 8. VERIFY - READ ONLY, AFTER APPLYING. NOTHING BELOW RUNS.
-- ============================================================
--
--   A. THE COLUMN EXISTS AND EVERY EXISTING ROW IS UNTOUCHED.
--
--   select count(*)                                                   as plans,
--          count(*) filter (where pending_expires_at is not null)     as claims
--   from public.annual_plans;
--
--     EXPECT claims = 0 immediately after applying.
--
--   B. NO SETTLED OR TERMINAL ROW HOLDS A CLAIM, EVER.
--
--   select count(*) from public.annual_plans
--   where pending_expires_at is not null
--     and (status <> 'pending' or source_subscription_id is null);
--
--     EXPECT 0. The CHECK makes it structural; this reads it back.
--
--   C. MIGRATION 066'S BACKSTOP IS STILL THERE, UNCHANGED.
--
--   select indexdef from pg_indexes
--   where indexname = 'annual_plans_active_upgrade_per_subscription_key';
--
--     EXPECT the same active-only partial unique index 066 created. This
--     file must not have touched it.
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
--     EXPECT two rows. create_pending... ends in
--     "p_source_subscription_id uuid, p_pending_expires_at timestamp with
--     time zone"; activate... is unchanged from 066. A THIRD ROW MEANS AN
--     OLD OVERLOAD SURVIVED THE DROP.
--
--   E. THE BROWSER'S PRIVILEGES DID NOT MOVE AT ALL.
--
--   select column_name from information_schema.column_privileges
--   where table_schema = 'public' and table_name = 'annual_plans'
--     and grantee = 'authenticated' and privilege_type = 'SELECT'
--   order by column_name;
--
--     EXPECT exactly the twenty-one columns migration 066 left, and
--     pending_expires_at NOT among them.
--
--   F. THE CLAIM INDEX IS PARTIAL AND NOT UNIQUE.
--
--   select indexdef from pg_indexes
--   where indexname = 'annual_plans_pending_upgrade_claim_idx';
--
--     EXPECT a NON-unique index with a WHERE clause naming both
--     source_subscription_id IS NOT NULL and status = 'pending'. A
--     UNIQUE index here would be the permanent veto this file exists to
--     avoid.
