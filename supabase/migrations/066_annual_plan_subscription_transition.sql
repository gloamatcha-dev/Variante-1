-- ============================================================
-- GLOA – the 4-week subscription → annual plan upgrade
--
-- Phase 4B9. Run in the Supabase SQL Editor against the existing
-- production project, INSIDE the transaction below.
--
-- NOT YET APPLIED. This file exists so the code that needs it can be
-- reviewed against the exact schema it assumes.
-- ============================================================
--
-- ── WHAT THIS EXISTS FOR ─────────────────────────────────────
--
-- A customer holding a live 4-week subscription buys an annual plan and
-- expects the two to hand over cleanly:
--
--     * the period they have already paid for is still delivered
--     * that subscription does not renew again afterwards
--     * the annual plan's thirteen deliveries begin at the first date
--       the subscription no longer covers
--     * no box arrives twice, and no cycle is charged twice
--
-- Migration 039 cannot express that. activate_annual_plan_from_payment
-- anchors the whole schedule on ONE value and hard-codes which one:
--
--     v_purchased := v_attempt.paid_at;
--     ... plan_end_at = v_purchased + interval '8736 hours'
--     insert into annual_plan_deliveries
--     select v_plan.id, n, v_purchased + interval '672 hours' * (n - 1)
--     from generate_series(1, v_plan.delivery_count) n;
--
-- So delivery 1 is always the moment the money settled, and the claim
-- worker ships it on its next pass. There is no column, no argument and
-- no writable path that could say otherwise: service_role holds SELECT
-- and nothing else on both annual tables (039 section 5), every write is
-- a SECURITY DEFINER function, and not one of them ever moves a
-- scheduled_for. A deferred start therefore cannot be represented at
-- all, which is why this migration exists rather than a code change.
--
-- ── WHAT IT DOES NOT DO ──────────────────────────────────────
--
-- An ORDINARY annual purchase is bit-for-bit unchanged. Both new columns
-- are NULL for every existing row and for every plan bought without an
-- upgrade, the anchor falls back to paid_at exactly as before, and no
-- existing row is read, rewritten or backfilled by this file.
--
-- It changes no price, no discount, no delivery count, no cadence, no
-- refund rule, and nothing at all about migration 034's cancellation
-- cutoff - see section 4 for why the upgrade can bypass that cutoff
-- without touching it.
--
-- ============================================================

begin;

-- 1. THE TWO COLUMNS ───────────────────────────────────────────
--
-- ── source_subscription_id ────────────────────────────────────
--
-- WHICH subscription this plan is taking over from, written when the
-- upgrade CHECKOUT is created - before Stripe, before payment - because
-- it is part of what the customer is buying and the settlement needs to
-- know it without trusting anything a webhook payload says.
--
-- A real foreign key rather than a copied id, for migration 039's own
-- reason: a relation that can point at nothing is a relation that will.
-- ON DELETE is deliberately omitted, so it defaults to NO ACTION and a
-- subscription that an annual plan grew out of cannot be deleted while
-- that plan exists. Subscriptions are never deleted in this system
-- anyway; this makes that structural rather than a habit.
--
-- ── schedule_anchor_at ────────────────────────────────────────
--
-- The first date the source subscription no longer covers, and the
-- origin of all thirteen delivery dates when it is set.
--
-- IT IS WRITTEN AT SETTLEMENT, NOT AT CHECKOUT. A pending upgrade has a
-- source subscription and NO anchor, which is the honest shape: until
-- the money is durable nothing may be promised, and an asynchronous
-- payment method can settle days after the review screen was shown - by
-- which time the subscription may have renewed and the true handover
-- date moved with it. The anchor is therefore re-derived from Stripe's
-- own period at the moment of settlement and frozen in the same
-- transaction that activates the plan.
--
-- NULL on an active ordinary plan means "anchored on paid_at", which is
-- what every plan bought before this migration is.

alter table public.annual_plans
  add column source_subscription_id uuid references public.subscriptions(id),
  add column schedule_anchor_at     timestamptz;


-- 2. THE TWO INVARIANTS ────────────────────────────────────────
--
-- ── AN ANCHOR IMPLIES AN UPGRADE ──────────────────────────────
--
-- Deliberately one-directional. The pair is NOT required to be
-- all-or-nothing, because the legitimate intermediate state - an upgrade
-- checkout that has been created and not yet paid - has the source and
-- no anchor:
--
--     source  anchor   meaning
--     NULL    NULL     an ordinary annual plan, anchored on paid_at
--     set     NULL     an upgrade that has not settled yet
--     set     set      a settled upgrade, anchored on the handover date
--     NULL    set      IMPOSSIBLE, and this is what forbids it
--
-- The fourth row is what the constraint is for: a schedule deferred away
-- from paid_at with nothing on the row explaining what it is deferred
-- to would be a set of dates no later reader could justify.

alter table public.annual_plans
  add constraint annual_plans_anchor_requires_source_check
  check (schedule_anchor_at is null or source_subscription_id is not null);

-- ── AND AN ANCHOR IMPLIES A PURCHASE ──────────────────────────
--
-- Stronger than the audit first proposed, and it is the constraint that
-- makes "written at settlement" structural instead of conventional.
-- purchased_at is written by activate_annual_plan_from_payment and by
-- nothing else, so an anchor cannot exist on a plan that has not been
-- paid for - which also means a pending upgrade can never carry a
-- promised handover date the customer has not bought yet.

alter table public.annual_plans
  add constraint annual_plans_anchor_requires_purchase_check
  check (schedule_anchor_at is null or purchased_at is not null);


-- 3. ONE SUBSCRIPTION, ONE UPGRADE ─────────────────────────────
--
-- THE RACE THIS CLOSES. Two browser tabs mint two request ids, so they
-- mint two checkout attempts and two PENDING upgrade plans for the same
-- subscription - and the repurchase work of the previous phase left
-- pending rows deliberately non-blocking, because nothing expires them
-- and a gate built on them would let one abandoned tab veto a purchase
-- for good. That decision is right and stands. It does mean the
-- application cannot be the thing that stops two paid upgrades.
--
-- So the database is. ACTIVE only: a pending row still blocks nothing,
-- a cancelled or completed upgrade still allows another one later, and
-- the one state that must be unique genuinely is. The second activation
-- meets this index inside activate_annual_plan_from_payment's own
-- transaction and is refused as 'transition_conflict' with every write
-- rolled back - never two live plans taking over one subscription.
--
-- WHAT IT DOES NOT CLAIM TO PREVENT: two people paying twice in the same
-- few seconds. No pre-payment gate can, here or in the ordinary annual
-- flow, and inventing a refund path for it is a commercial decision
-- nobody has taken. The money is visible in admin and the second plan
-- stays 'pending' rather than silently becoming a second contract.

create unique index annual_plans_active_upgrade_per_subscription_key
  on public.annual_plans (source_subscription_id)
  where source_subscription_id is not null
    and status = 'active';


-- 4. WHY NO CANCELLATION RULE IS TOUCHED ───────────────────────
--
-- The upgrade has to stop the old subscription renewing, and it must do
-- that WITHOUT the 14-day cutoff migration 034 applies to an ordinary
-- customer cancellation. Under that cutoff an upgrade bought inside the
-- final fortnight would bill and ship one more cycle, which is not what
-- an upgrade means: the customer has just paid for a year.
--
-- NOTHING HERE HAS TO CHANGE FOR THAT, and that is worth stating.
-- schedule_subscription_cancellation takes p_effective_at and
-- p_cancel_at as ARGUMENTS and applies no cutoff of its own; the 14-day
-- rule lives entirely in resolveCancellationSchedule in TypeScript, and
-- only the ordinary cancel route calls it. The upgrade passes the
-- subscription's own current_period_end instead, which satisfies 034's
-- one guard on that argument (p_effective_at >= current_period_end,
-- with equality being exactly this case).
--
-- A subscription that ALREADY has a cancellation standing is left
-- completely alone: 034 answers 'conflict' for a different date and
-- writes nothing, so the upgrade adopts the standing date as its anchor
-- rather than moving an end the customer has already been told about.


-- 5. THE PENDING-PLAN WRITER LEARNS THE SOURCE ─────────────────
--
-- Sixteen arguments now. Dropped and recreated rather than overloaded,
-- exactly as migration 040 did when it added the two fingerprints: a
-- second overload reachable with the old argument count would be
-- ambiguous to resolve and would silently keep the old behaviour alive.
--
-- THE SOURCE IS VALIDATED HERE, under the same transaction that creates
-- the plan, and not merely in the route. The route has already proved
-- ownership; this proves it again against the database's own rows,
-- because the argument arrives as a uuid like any other and a function
-- that takes a relation on trust is a function that can be pointed
-- anywhere.

drop function public.create_pending_annual_plan_for_attempt(
  uuid, uuid, uuid, integer, integer, integer, numeric,
  jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, text, text
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
  p_source_subscription_id          uuid
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

  if found then
    return pg_catalog.jsonb_build_object(
      'result', 'existing',
      'annual_plan_id', v_plan.id,
      'status', v_plan.status
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

  -- ── THE SOURCE SUBSCRIPTION, WHEN THERE IS ONE ────────────
  --
  -- Absent is the ordinary purchase and is not checked at all. Present
  -- has to survive three questions, and a failure at any of them creates
  -- NOTHING: it is better for an upgrade checkout to refuse than for a
  -- plan to exist pointing at a subscription that cannot hand over.
  if p_source_subscription_id is not null then
    select * into v_sub
    from public.subscriptions
    where id = p_source_subscription_id
      and user_id = p_user_id;

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
      -- THE ONE NEW VALUE. schedule_anchor_at is deliberately NOT written
      -- here: nothing has been paid for yet, so there is no handover date
      -- to promise, and section 2's CHECK would refuse one anyway.
      source_subscription_id
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
      p_source_subscription_id
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


-- 6. ACTIVATION LEARNS THE ANCHOR ──────────────────────────────
--
-- One new argument, and it decides where the thirteen dates start.
--
--     no source subscription   the anchor MUST be absent, and the
--                              schedule is paid_at exactly as before
--     a source subscription    the anchor is REQUIRED, and it is the
--                              handover date the caller re-derived from
--                              Stripe at settlement
--
-- Both directions are refusals rather than fallbacks. An upgrade
-- activated without an anchor would silently ship box one into a period
-- the subscription still covers - the exact duplicate this whole
-- migration exists to prevent - and an ordinary plan activated WITH one
-- would be a deferred schedule nobody bought.
--
-- THE ANCHOR MAY NOT PRECEDE THE PURCHASE. A handover date earlier than
-- the moment the money settled would put deliveries before the contract
-- existed; the caller resolves that case to the payment date itself and
-- this refuses anything else.
--
-- plan_end_at follows the anchor rather than paid_at, so the term still
-- covers all thirteen deliveries and complete_due_annual_plans still
-- sees the plan end after the last of them rather than during.

drop function public.activate_annual_plan_from_payment(uuid, text, text);

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
  -- And now also for the same HANDOVER DATE. A redelivery that arrived
  -- with a different anchor is a correlation error, not a retry:
  -- adopting it would move thirteen dates the customer has already been
  -- shown and already been emailed.
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

  -- ── WHICH ANCHOR, AND IS IT THE RIGHT KIND ────────────────
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

  -- ONE UPGRADE PER SUBSCRIPTION, enforced by the partial unique index
  -- in section 3 rather than by a read. The insert-style race is the
  -- whole point: two settlements can both see no active plan and only
  -- one can commit the UPDATE that makes one.
  begin
    update public.annual_plans
       set status                     = 'active',
           payment_status             = 'paid',
           purchased_at               = v_purchased,
           schedule_anchor_at         = p_schedule_anchor_at,
           plan_end_at                = v_anchor + pg_catalog.make_interval(hours => 8736),
           stripe_payment_intent_id   = pg_catalog.btrim(v_attempt.stripe_payment_intent_id),
           stripe_checkout_session_id = pg_catalog.btrim(v_attempt.stripe_checkout_session_id)
     where id = v_plan.id
    returning * into v_plan;
  exception
    when unique_violation then
      -- Another annual plan is already the active upgrade of this
      -- subscription. Nothing is written, the plan stays 'pending', and
      -- the caller must not treat this as a retryable fault.
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


-- 7. PRIVILEGES ────────────────────────────────────────────────
--
-- Both recreated functions lose their grants when dropped, so both are
-- restated exactly as 039 and 040 held them: revoked from public and
-- anon, executable by service_role alone. Neither is reachable from a
-- browser, before or after this file.

revoke all on function public.create_pending_annual_plan_for_attempt(
  uuid, uuid, uuid, integer, integer, integer, numeric,
  jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, text, text, uuid
) from public;
revoke all on function public.create_pending_annual_plan_for_attempt(
  uuid, uuid, uuid, integer, integer, integer, numeric,
  jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, text, text, uuid
) from anon;
revoke all on function public.create_pending_annual_plan_for_attempt(
  uuid, uuid, uuid, integer, integer, integer, numeric,
  jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, text, text, uuid
) from authenticated;
grant execute on function public.create_pending_annual_plan_for_attempt(
  uuid, uuid, uuid, integer, integer, integer, numeric,
  jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, text, text, uuid
) to service_role;

revoke all on function public.activate_annual_plan_from_payment(uuid, text, text, timestamptz) from public;
revoke all on function public.activate_annual_plan_from_payment(uuid, text, text, timestamptz) from anon;
revoke all on function public.activate_annual_plan_from_payment(uuid, text, text, timestamptz) from authenticated;
grant execute on function public.activate_annual_plan_from_payment(uuid, text, text, timestamptz) to service_role;


-- 8. WHAT THE ACCOUNT MAY READ ─────────────────────────────────
--
-- Migration 041 replaced the table-level SELECT `authenticated` held
-- with COLUMN grants naming exactly what the account renders, so a new
-- column is invisible to the browser until it is named here.
--
-- Both are added, and both are things the customer is entitled to know
-- about their own contract: WHICH subscription their plan took over from
-- (so the account can say so rather than showing two contracts that look
-- simultaneously live) and WHEN it starts.
--
-- Nothing else is widened. The Stripe identities, the claim token and
-- the four snapshots remain unreadable from a browser.

grant select (source_subscription_id, schedule_anchor_at) on table public.annual_plans to authenticated;

commit;


-- ============================================================
-- 9. VERIFY - READ ONLY, AFTER APPLYING. NOTHING BELOW RUNS.
-- ============================================================
--
--   A. THE COLUMNS EXIST AND EVERY EXISTING ROW IS UNTOUCHED.
--
--   select count(*)                                   as plans,
--          count(*) filter (where source_subscription_id is not null) as upgrades,
--          count(*) filter (where schedule_anchor_at is not null)     as anchored
--   from public.annual_plans;
--
--     EXPECT upgrades = 0 and anchored = 0 immediately after applying.
--
--   B. THE ORDINARY PLAN IS UNCHANGED. For every plan that existed
--      before this file, the schedule still starts at the purchase.
--
--   select p.id, p.purchased_at, p.schedule_anchor_at,
--          min(d.scheduled_for) as first_delivery
--   from public.annual_plans p
--   join public.annual_plan_deliveries d on d.annual_plan_id = p.id
--   where p.status = 'active'
--   group by p.id, p.purchased_at, p.schedule_anchor_at;
--
--     EXPECT schedule_anchor_at NULL and first_delivery = purchased_at.
--
--   C. THE UNIQUE INDEX IS PARTIAL AND ACTIVE-ONLY.
--
--   select indexdef from pg_indexes
--   where indexname = 'annual_plans_active_upgrade_per_subscription_key';
--
--     EXPECT a WHERE clause naming both source_subscription_id IS NOT
--     NULL and status = 'active'.
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
--     EXPECT two rows. create_pending... ends in "text, text, uuid";
--     activate... is exactly "uuid, text, text, timestamp with time zone".
--     A THIRD ROW MEANS AN OLD OVERLOAD SURVIVED THE DROP and the
--     application may be resolving to it.
--
--   E. THE BROWSER CAN READ THE TWO NEW COLUMNS AND NOTHING MORE.
--
--   select column_name from information_schema.column_privileges
--   where table_schema = 'public' and table_name = 'annual_plans'
--     and grantee = 'authenticated' and privilege_type = 'SELECT'
--   order by column_name;
--
--     EXPECT the nineteen columns migration 041 granted, plus
--     schedule_anchor_at and source_subscription_id. Twenty-one, and no
--     stripe_*, no purchase_confirmation_*, no *_snapshot.
--
--   F. THE CANCELLATION RULES ARE UNTOUCHED.
--
--   select pg_catalog.pg_get_functiondef(p.oid) like '%14%'
--   from pg_catalog.pg_proc p
--   join pg_catalog.pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public'
--     and p.proname = 'schedule_subscription_cancellation';
--
--     This file does not touch that function at all; the query is here
--     only so a reviewer can confirm it for themselves.
