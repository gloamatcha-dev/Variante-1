-- ============================================================
-- GLOA – the annual plan becomes TWELVE CALENDAR-MONTHLY deliveries
--
-- Phase 4B12, stage 1. Run in the Supabase SQL Editor against the
-- existing production project, INSIDE the transaction below.
--
-- NOT YET APPLIED.
--
-- IT IS SAFE TO APPLY BEFORE ITS CODE SHIPS, and that is deliberate -
-- see section 7. Neither function changes its callable signature, and
-- the application running in Production right now keeps creating the
-- contract it already sells until the new code is deployed.
-- ============================================================
--
-- ── WHAT CHANGES, AND FOR WHOM ───────────────────────────────
--
-- The annual plan sold until today is THIRTEEN deliveries every 28 days,
-- a 364-day term frozen as 8736 hours by migration 039. The plan sold
-- after this file is TWELVE deliveries, one per CALENDAR MONTH, with a
-- term of one calendar year.
--
-- BOTH ARE REAL CONTRACTS. Plans bought under the first model are still
-- running, still owe deliveries on 28-day steps, and a customer looking
-- at one must be shown the terms THEY bought. So the model becomes a
-- value on the row and nothing reinterprets an existing plan:
--
--     * no row is backfilled, rewritten or re-scheduled
--     * every row that exists today is labelled v1, which is what it is
--     * the CHECK admits both counts rather than replacing one with the
--       other
--     * activation still builds a 28-day schedule for a v1 plan, from
--       the same paid_at, in the same 672-hour steps
--
-- ── WHY THE CALENDAR IS NOT AN INTERVAL ──────────────────────
--
-- "Once a month" cannot be expressed as a number of days. 28 drifts away
-- from the calendar, 30 and 31 do not exist in every month, and the
-- naive fix - add one month to the PREVIOUS date - drifts permanently
-- the first time it crosses February:
--
--     31 Jan -> 28 Feb -> 28 Mar -> 28 Apr ...   WRONG
--     31 Jan -> 28 Feb -> 31 Mar -> 30 Apr ...   RIGHT
--
-- Every date below is therefore ANCHOR + N MONTHS, never
-- previous + 1 month, so a short month clamps once and never moves the
-- month after it. PostgreSQL's own month arithmetic does the clamping,
-- including the leap year.
--
-- ── AND WHY IT IS COMPUTED IN BERLIN ─────────────────────────
--
-- A delivery is planned for a DAY. Adding months to a timestamptz uses
-- the SESSION's timezone, so the same plan would schedule differently
-- depending on who called it, and a late-evening anchor would land on
-- the wrong calendar day when the clocks change. The arithmetic below is
-- pinned to Europe/Berlin explicitly, which makes it independent of the
-- session and stable across DST.
--
-- ── WHAT THIS FILE DOES NOT DO ───────────────────────────────
--
-- It changes no price, no discount rate, no shipping amount and no
-- existing total. It adds no column for the regular retail price because
-- migration 039 already freezes one: catalog_unit_gross_cents is the
-- undiscounted catalog price at purchase, with a CHECK keeping the
-- annual unit at or below it - so a later website price change cannot
-- move a historical figure.
--
-- It does not touch 066's anchor rules, 067's expiring claim, 068's
-- customer claim or the one-live-plan index, and it grants nothing.
--
-- ============================================================

begin;

-- 1. WHICH CONTRACT THIS ROW IS ────────────────────────────────
--
-- NOT NULL WITH A DEFAULT OF v1, which is the whole preservation
-- guarantee in one line: every row that already exists is labelled as
-- the contract it actually was, without an UPDATE and without this file
-- reading a single existing row.
--
-- New rows get v2 because the writer in section 4 says so explicitly -
-- never because the default changed.

alter table public.annual_plans
  add column schedule_model text not null default 'v1_28d_13'
    check (schedule_model in ('v1_28d_13', 'v2_monthly_12'));

-- ── THE CALENDAR ANCHOR, FOR v2 ONLY ─────────────────────────
--
-- A DATE, not a timestamp, because the cadence is the calendar and the
-- thing being repeated is a day of the month. It is written at
-- activation from the settlement instant in Berlin, and it is what all
-- twelve delivery dates and the plan end are computed from - so a reader
-- can reproduce the whole schedule from this one column.
--
-- NULL on a v1 plan, which has no calendar anchor: its schedule steps
-- from paid_at in fixed 672-hour intervals.

alter table public.annual_plans
  add column schedule_anchor_date date;


-- 2. TWELVE OR THIRTEEN, AND THE MODEL DECIDES WHICH ───────────
--
-- Migration 039 pinned delivery_count to exactly 13. That CHECK is
-- replaced rather than dropped: the count is still pinned, to the two
-- values that now exist, and the model and the count must agree.
--
-- The pairing CHECK is what stops a v2 plan with thirteen deliveries or
-- a v1 plan with twelve - either would be a contract nobody sold, and
-- either would make the customer's card and their schedule disagree.

alter table public.annual_plans
  drop constraint annual_plans_delivery_count_check;

alter table public.annual_plans
  add constraint annual_plans_delivery_count_check
  check (delivery_count in (12, 13));

alter table public.annual_plans
  add constraint annual_plans_schedule_model_count_check
  check (
    (schedule_model = 'v1_28d_13'     and delivery_count = 13)
    or (schedule_model = 'v2_monthly_12' and delivery_count = 12)
  );

-- ── AN ANCHOR DATE IMPLIES v2, AND v2 IMPLIES ONE ONCE PAID ──
--
-- One-directional in the same way 066's anchor CHECK is. A v1 plan may
-- never carry a calendar anchor, and a v2 plan that has been PAID FOR
-- must carry one - because that is the moment activation computes it,
-- and a settled v2 plan without one would be twelve dates nobody could
-- reproduce. A pending v2 plan has no anchor yet, which is honest.

alter table public.annual_plans
  add constraint annual_plans_anchor_date_requires_v2_check
  check (schedule_anchor_date is null or schedule_model = 'v2_monthly_12');

alter table public.annual_plans
  add constraint annual_plans_v2_purchase_requires_anchor_date_check
  check (
    schedule_model <> 'v2_monthly_12'
    or purchased_at is null
    or schedule_anchor_date is not null
  );


-- 3. THE CALENDAR RULE, IN ONE PLACE ───────────────────────────
--
-- IMMUTABLE and pure, so it can be used in an index or a generated
-- column later and so the focused suite can drive it directly against
-- the TypeScript helper that mirrors it.
--
-- The clamping is PostgreSQL's own: date + interval 'N months' lands on
-- the last day of a short month and handles February in a leap year
-- without a special case. What matters is that N is counted from the
-- ORIGINAL anchor every time, which is why this takes an anchor and an
-- index rather than a previous date.

create or replace function public.annual_monthly_delivery_date(
  p_anchor_date date,
  p_delivery_number integer
)
returns date
language sql
immutable
strict
set search_path = ''
as $$
  select (p_anchor_date + pg_catalog.make_interval(months => p_delivery_number - 1))::date;
$$;

revoke all on function public.annual_monthly_delivery_date(date, integer) from public;
revoke all on function public.annual_monthly_delivery_date(date, integer) from anon;
revoke all on function public.annual_monthly_delivery_date(date, integer) from authenticated;
grant execute on function public.annual_monthly_delivery_date(date, integer) to service_role;


-- 4. THE WRITER LEARNS WHICH CONTRACT IT IS SELLING ────────────
--
-- AN EIGHTEENTH ARGUMENT, WITH A DEFAULT, and the default is the whole
-- reason this migration can go first.
--
--   * the application running in Production sends SEVENTEEN named
--     arguments. PostgreSQL resolves that to this function using the
--     default, so it keeps selling v1 - thirteen deliveries, the totals
--     it computed, unchanged - until its own code is deployed.
--
--   * the new code sends 'v2_monthly_12' and gets twelve.
--
-- THE COUNT IS DERIVED FROM THE MODEL, never passed. One source of
-- truth, and no caller - browser or server - can ask for a count that
-- does not belong to a contract GLOA sells. The totals are still
-- computed here and still compared against the attempt's frozen
-- expectation, so a caller whose arithmetic disagrees is refused rather
-- than believed.
--
-- Dropped and recreated because adding a parameter changes the
-- signature; the grants are restated in section 6.

drop function public.create_pending_annual_plan_for_attempt(
  uuid, uuid, uuid, integer, integer, integer, numeric,
  jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, text, text, uuid, timestamptz
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
  p_pending_expires_at              timestamptz,
  p_schedule_model                  text default 'v1_28d_13'
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

  -- WHICH CONTRACT, AND THEREFORE HOW MANY DELIVERIES. Decided before
  -- anything is read, because an unknown model must not reach a row.
  if p_schedule_model = 'v2_monthly_12' then
    v_count := 12;
  elsif p_schedule_model = 'v1_28d_13' then
    v_count := 13;
  else
    return pg_catalog.jsonb_build_object('result', 'schedule_model_unknown');
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
      'pending_expires_at', v_plan.pending_expires_at,
      'schedule_model', v_plan.schedule_model,
      'delivery_count', v_plan.delivery_count
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

  if p_pending_expires_at is not null
     and (p_pending_expires_at <= pg_catalog.now()
          or p_pending_expires_at > pg_catalog.now() + pg_catalog.make_interval(hours => 24))
  then
    return pg_catalog.jsonb_build_object('result', 'claim_expiry_invalid');
  end if;

  -- ── THE CUSTOMER LOCK (migration 068), UNCHANGED ──────────
  select * into v_profile
  from public.profiles
  where user_id = p_user_id
  for update;

  if not found then
    return pg_catalog.jsonb_build_object('result', 'customer_profile_missing');
  end if;

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

  select * into v_rival
  from public.annual_plans
  where user_id = p_user_id
    and status = 'active'
    and payment_status <> 'refunded'
  limit 1;

  if found then
    return pg_catalog.jsonb_build_object('result', 'annual_plan_already_live');
  end if;

  -- ── THE SOURCE SUBSCRIPTION (066/067), UNCHANGED ──────────
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

  v_merch := p_annual_unit_gross_cents * v_count;
  v_ship  := p_shipping_per_delivery_gross_cents * v_count;
  v_total := v_merch + v_ship;

  if v_attempt.expected_total_gross_cents is distinct from v_total then
    return pg_catalog.jsonb_build_object(
      'result', 'total_mismatch',
      'attempt_total_gross_cents', v_attempt.expected_total_gross_cents,
      'plan_total_gross_cents', v_total,
      'schedule_model', p_schedule_model
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
      pending_expires_at,
      -- MIGRATION 069. Which contract this is, recorded with the plan
      -- rather than inferred later from its count.
      schedule_model
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
      p_pending_expires_at,
      p_schedule_model
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
          'pending_expires_at', v_plan.pending_expires_at,
          'schedule_model', v_plan.schedule_model,
          'delivery_count', v_plan.delivery_count
        );
      end if;
      raise;
  end;

  return pg_catalog.jsonb_build_object(
    'result', 'created',
    'annual_plan_id', v_plan.id,
    'status', v_plan.status,
    'total_gross_cents', v_plan.total_gross_cents,
    'pending_expires_at', v_plan.pending_expires_at,
    'schedule_model', v_plan.schedule_model,
    'delivery_count', v_plan.delivery_count
  );
end;
$$;


-- 5. ACTIVATION BUILDS WHICHEVER SCHEDULE THE PLAN BOUGHT ──────
--
-- CREATE OR REPLACE at 066's exact signature, so the grants survive and
-- no caller changes. The v1 path is byte-for-byte what 067 left: the
-- same anchor rules, the same 8736-hour term, the same 672-hour steps,
-- the same thirteen-row assertion, the same transition_conflict handler.
--
-- The v2 path is the only addition:
--
--     anchor date   the settlement instant, or the handover date for an
--                   upgrade, read as a Berlin calendar DAY
--     deliveries    that day in each of twelve consecutive months,
--                   clamped, every one counted from the anchor
--     term          one calendar YEAR from the anchor, which still ends
--                   after the twelfth delivery rather than during it
--
-- The clock time of each delivery is the anchor's own Berlin wall clock,
-- preserved across DST, so the dates are calendar-stable and the
-- delivery worker's "scheduled_for <= now()" still means what it says.

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
  v_plan        public.annual_plans;
  v_attempt     public.checkout_attempts;
  v_purchased   timestamptz;
  v_anchor      timestamptz;
  v_anchor_local timestamp;
  v_anchor_date date;
  v_end         timestamptz;
  v_intent      text;
  v_session     text;
  v_created     integer;
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

  -- ── THE TERM, PER MODEL ───────────────────────────────────
  --
  -- THE BERLIN WALL CLOCK IS THE CALENDAR. Converting once here is what
  -- makes every date below independent of the session's timezone and
  -- stable when the clocks change.
  if v_plan.schedule_model = 'v2_monthly_12' then
    v_anchor_local := v_anchor at time zone 'Europe/Berlin';
    v_anchor_date  := v_anchor_local::date;
    v_end := (v_anchor_local + pg_catalog.make_interval(months => 12)) at time zone 'Europe/Berlin';
  else
    v_anchor_date := null;
    v_end := v_anchor + pg_catalog.make_interval(hours => 8736);
  end if;

  begin
    update public.annual_plans
       set status                     = 'active',
           payment_status             = 'paid',
           purchased_at               = v_purchased,
           schedule_anchor_at         = p_schedule_anchor_at,
           schedule_anchor_date       = v_anchor_date,
           plan_end_at                = v_end,
           pending_expires_at         = null,
           stripe_payment_intent_id   = pg_catalog.btrim(v_attempt.stripe_payment_intent_id),
           stripe_checkout_session_id = pg_catalog.btrim(v_attempt.stripe_checkout_session_id)
     where id = v_plan.id
    returning * into v_plan;
  exception
    when unique_violation then
      return pg_catalog.jsonb_build_object(
        'result', 'transition_conflict',
        'annual_plan_id', v_plan.id,
        'source_subscription_id', v_plan.source_subscription_id
      );
  end;

  -- ── THE SCHEDULE, PER MODEL ───────────────────────────────
  if v_plan.schedule_model = 'v2_monthly_12' then
    -- ANCHOR + N MONTHS, every time. Never previous + 1 month, which
    -- would drift permanently past February.
    insert into public.annual_plan_deliveries (
      annual_plan_id, delivery_number, scheduled_for, state
    )
    select v_plan.id,
           n,
           (v_anchor_local + pg_catalog.make_interval(months => n - 1)) at time zone 'Europe/Berlin',
           'scheduled'
    from pg_catalog.generate_series(1, v_plan.delivery_count) as n
    on conflict on constraint annual_plan_deliveries_plan_number_key do nothing;
  else
    insert into public.annual_plan_deliveries (
      annual_plan_id, delivery_number, scheduled_for, state
    )
    select v_plan.id,
           n,
           v_anchor + pg_catalog.make_interval(hours => 672 * (n - 1)),
           'scheduled'
    from pg_catalog.generate_series(1, v_plan.delivery_count) as n
    on conflict on constraint annual_plan_deliveries_plan_number_key do nothing;
  end if;

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
    'schedule_model', v_plan.schedule_model,
    'schedule_anchor_at', v_plan.schedule_anchor_at,
    'schedule_anchor_date', v_plan.schedule_anchor_date,
    'plan_end_at', v_plan.plan_end_at,
    'deliveries', v_created
  );
end;
$$;


-- 6. PRIVILEGES ────────────────────────────────────────────────
--
-- Only the pending-plan writer was dropped, so only it lost its grants.
-- Restated exactly as 039, 040, 066, 067 and 068 held them: revoked from
-- public, anon and authenticated, executable by service_role alone.
--
-- activate_annual_plan_from_payment was REPLACED and kept every grant.
-- NO BROWSER GRANT IS ADDED: schedule_model and schedule_anchor_date are
-- not named here, so migration 041's rule - that the column grants and
-- the account's select list are the same list - still holds. Stage 2
-- grants schedule_model when the account starts rendering it.

revoke all on function public.create_pending_annual_plan_for_attempt(
  uuid, uuid, uuid, integer, integer, integer, numeric,
  jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, text, text, uuid, timestamptz, text
) from public;
revoke all on function public.create_pending_annual_plan_for_attempt(
  uuid, uuid, uuid, integer, integer, integer, numeric,
  jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, text, text, uuid, timestamptz, text
) from anon;
revoke all on function public.create_pending_annual_plan_for_attempt(
  uuid, uuid, uuid, integer, integer, integer, numeric,
  jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, text, text, uuid, timestamptz, text
) from authenticated;
grant execute on function public.create_pending_annual_plan_for_attempt(
  uuid, uuid, uuid, integer, integer, integer, numeric,
  jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, text, text, uuid, timestamptz, text
) to service_role;


-- 7. WHY THIS MAY BE APPLIED BEFORE ITS CODE ───────────────────
--
-- The 066 and 067 phases shipped code first and took annual checkout
-- down; 068 and this file are built so the opposite order is the safe
-- one. Nothing here requires a caller to change:
--
--   THE NEW ARGUMENT HAS A DEFAULT. The running application sends
--   seventeen named arguments; PostgreSQL resolves that to this function
--   with p_schedule_model = 'v1_28d_13', so it goes on creating exactly
--   the thirteen-delivery contract it computed totals for.
--
--   THE ACTIVATION SIGNATURE IS UNCHANGED, and for a v1 plan its body
--   takes the same branch it always did.
--
--   THE NEW COLUMNS ARE OPTIONAL. schedule_model defaults to v1 and
--   schedule_anchor_date is NULL, so an INSERT that names neither - which
--   is every INSERT the old writer made - still satisfies every CHECK.
--
--   THE COUNT CHECK WIDENED. Nothing that was legal became illegal.
--
-- SO THE ORDER IS: apply this migration, confirm it, then ship the code
-- that starts sending 'v2_monthly_12'. Between the two steps Production
-- sells exactly what it sells today.
--
-- THE REVERSE ORDER IS NOT SAFE: the new code prices twelve deliveries,
-- and this migration is what teaches the writer that twelve is a
-- contract. Without it the writer computes thirteen, the totals
-- disagree, and every annual checkout is refused 'total_mismatch'.

commit;


-- ============================================================
-- 8. VERIFY - READ ONLY, AFTER APPLYING. NOTHING BELOW RUNS.
-- ============================================================
--
--   A. EVERY EXISTING PLAN IS LABELLED v1 AND UNCHANGED.
--
--   select schedule_model, delivery_count, count(*),
--          count(*) filter (where schedule_anchor_date is not null) as anchored
--   from public.annual_plans group by 1, 2 order by 1, 2;
--
--     EXPECT only ('v1_28d_13', 13) immediately after applying, with
--     anchored = 0. Any v2 row means the new code already ran.
--
--   B. THE LIVE 13-DELIVERY PLAN STILL HAS ITS OWN SCHEDULE.
--
--   select p.id, p.delivery_count, p.schedule_model,
--          count(d.*) as rows,
--          min(d.scheduled_for)::date as first,
--          max(d.scheduled_for)::date as last,
--          (max(d.scheduled_for) - min(d.scheduled_for)) as span
--   from public.annual_plans p
--   join public.annual_plan_deliveries d on d.annual_plan_id = p.id
--   where p.status = 'active'
--   group by 1, 2, 3;
--
--     EXPECT 13 rows and a span of exactly 336 days (12 x 28) for the
--     existing plan. Nothing in this file rewrote a scheduled_for.
--
--   C. BOTH COUNTS ARE LEGAL AND THE MODEL PAIRS WITH THEM.
--
--   select conname, pg_catalog.pg_get_constraintdef(oid)
--   from pg_catalog.pg_constraint
--   where conrelid = 'public.annual_plans'::regclass
--     and conname in ('annual_plans_delivery_count_check',
--                     'annual_plans_schedule_model_count_check')
--   order by conname;
--
--     EXPECT delivery_count IN (12, 13) and the pairing CHECK.
--
--   D. THE WRITER TOOK ITS EIGHTEENTH ARGUMENT, WITH A DEFAULT.
--
--   select p.proname, p.pronargs, p.pronargdefaults,
--          pg_catalog.pg_get_function_identity_arguments(p.oid)
--   from pg_catalog.pg_proc p
--   join pg_catalog.pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public'
--     and p.proname in ('create_pending_annual_plan_for_attempt',
--                       'activate_annual_plan_from_payment',
--                       'annual_monthly_delivery_date')
--   order by 1;
--
--     EXPECT create_pending... with pronargs 18 and pronargdefaults 1,
--     activate... unchanged at four arguments, and the calendar helper.
--
--   E. THE CALENDAR RULE CLAMPS AND DOES NOT DRIFT.
--
--   select n, public.annual_monthly_delivery_date(date '2026-01-31', n)
--   from generate_series(1, 6) n;
--
--     EXPECT 31 Jan, 28 Feb, 31 MAR, 30 Apr, 31 MAY, 30 Jun. If March
--     reads the 28th the schedule is drifting and the arithmetic is
--     chaining instead of anchoring.
--
--   F. THE BROWSER'S PRIVILEGES DID NOT MOVE.
--
--   select count(*) from information_schema.column_privileges
--   where table_schema = 'public' and table_name = 'annual_plans'
--     and grantee = 'authenticated' and privilege_type = 'SELECT';
--
--     EXPECT 21, exactly as after 066.
