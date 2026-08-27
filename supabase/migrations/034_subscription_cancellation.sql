-- ============================================================
-- GLOA – B2C subscription cancellation + 14 day cutoff (Phase 3C)
-- Run in Supabase SQL Editor AFTER 033
--
-- Phase 3A found the gap: a customer can start a subscription and has no
-- way to end one. public.subscriptions has carried cancel_at_period_end
-- and cancelled_at since migration 005 and NOTHING has ever written
-- either of them. There is no cancellation route, no Stripe scheduling
-- and no termination sync.
--
-- 034 IS THE NEXT FREE NUMBER. 022-033 are live and immutable and are not
-- touched. Task 21 (tax/VAT/OSS) still holds no migration file and
-- remains free to take a later number - this migration writes no tax
-- field and leaves every *_net_cents and tax_total_cents column exactly
-- as it is.
--
-- ══════════════════════════════════════════════════════════════
-- THE BINDING BUSINESS RULE
-- ══════════════════════════════════════════════════════════════
--
-- The cadence is every 4 weeks, exactly 28 days. It is NEVER monthly and
-- no column, constraint or comment here says otherwise.
--
--   nextBilling = subscriptions.current_period_end
--   cutoff      = nextBilling - 14 days
--
--   request_at <= cutoff   EARLY. The upcoming cycle must not happen.
--                          effective cancellation = nextBilling
--
--   request_at >  cutoff   LATE. The upcoming cycle still happens at the
--                          full normal amount, and the subscription ends
--                          after it.
--                          effective cancellation = nextBilling + 28 days
--
-- The late date is PROMISED immediately and SENT TO STRIPE later. See the
-- next block for why, and section 2B for how.
--
-- The arithmetic itself lives in lib/subscriptionCancellationRules.ts as
-- a pure, unit-tested helper. This migration stores the RESULT and
-- guards its consistency; it deliberately does not re-implement the rule
-- in SQL, because two implementations of one rule is one too many.
--
-- ══════════════════════════════════════════════════════════════
-- HOW EACH BRANCH REACHES STRIPE, AND WHY THEY DIFFER
-- ══════════════════════════════════════════════════════════════
--
-- EARLY: an absolute cancel_at, set at Stripe immediately.
--
--   cancel_at_period_end cannot express the late case, so it is not used
--   for either. An absolute timestamp expresses the early case exactly
--   and Stripe enforces it - no cron, no scheduler, no drift. The date is
--   the CURRENT period end, and proration_behavior is pinned to "none".
--
-- LATE: nothing is sent to Stripe until the extra cycle has been paid.
--
--   The first draft of this migration sent cancel_at = current period end
--   + one cadence, in the belief that proration_behavior "none" made that
--   safe. IT DOES NOT. The installed SDK documents cancel_at as:
--
--     "If set to a date before the current period ends, this will cause a
--      proration if prorations have been enabled using
--      proration_behavior. If set during a future period, this will
--      ALWAYS cause a proration for that period."
--
--   (stripe 22.5.0, OpenAPI v2349, API 2026-07-29.dahlia,
--    SubscriptionUpdateParams.cancel_at.)
--
--   "Always" is not qualified by proration_behavior, and a late
--   cancellation lands squarely in a future period. In GLOA that would
--   not merely have produced an unexpected credit line: migration 022's
--   fulfillment refuses any invoice whose total does not equal the frozen
--   subscription total, so a prorated renewal would have FAILED to
--   fulfill - no order, no delivery, no confirmation - for a cycle the
--   customer had already been charged for and is owed.
--
--   So the late branch stores the decision and applies it later. When the
--   one further cycle is genuinely paid, invoice.paid sets
--   cancel_at = the NOW-CURRENT period end. That is a current-period date,
--   which the clause above does not touch at all, and it is the same call
--   shape the early branch already uses.
--
--   A Subscription Schedule with end_behavior = cancel was evaluated and
--   rejected. from_subscription forbids every other parameter in the same
--   call, so it needs two; the update call then REQUIRES phases[].items,
--   which would make the cancellation path responsible for re-declaring
--   this subscription's merchandise price, its recurring shipping price
--   and their quantities. A cancellation that can mistype a price is a
--   worse failure than the one being fixed. Its update also defaults to
--   create_prorations, adding a second proration surface rather than
--   removing one.
--
-- public.subscriptions.cancel_at_period_end IS DELIBERATELY LEFT ALONE at
-- its default false. Setting it would be actively misleading: it is
-- Stripe's name for a different mechanism, the one we are NOT using, and
-- a reader who saw it true would reasonably conclude the subscription
-- ends at the current period end - which is wrong for every late
-- cancellation.
--
-- ══════════════════════════════════════════════════════════════
-- SCHEDULED IS NOT CANCELLED
-- ══════════════════════════════════════════════════════════════
--
-- A subscription with a scheduled cancellation is still ACTIVE. It bills
-- (in the late case), it ships, and the customer is still owed the goods
-- they are paying for. status becomes 'cancelled' at exactly one moment:
-- when Stripe reports the subscription genuinely terminated, through
-- customer.subscription.deleted.
--
--   active                          no cancellation
--   active + cancel_at              termination scheduled
--   cancelled + cancelled_at        Stripe has terminated it
--
-- No new status value is introduced. The 022 vocabulary
-- ('pending','active','paused','cancelled','past_due','unpaid') is
-- unchanged.
--
-- ══════════════════════════════════════════════════════════════
-- WHAT APPLYING THIS DOES
-- ══════════════════════════════════════════════════════════════
--
-- Three nullable columns with no default and no backfill, four CHECK
-- constraints, four SECURITY DEFINER functions, four function grants.
-- It reads no row for a decision, writes no row, cancels nothing,
-- schedules nothing, calls no Stripe API and sends no email. Applying it
-- changes the behaviour and the content of exactly zero existing
-- subscriptions. See verification (J).
-- ============================================================

-- 1. CANCELLATION STATE ────────────────────────────────────────
--
-- THREE columns, all nullable, no default, no backfill. Every existing
-- subscription reads NULL on all three, which honestly means "nobody has
-- asked to end this".
--
-- They answer three DIFFERENT questions, and Phase 3C.2 exists because
-- the first version collapsed two of them into one:
--
--   cancellation_requested_at   WHEN THE CUSTOMER ASKED.
--   cancellation_effective_at   WHEN THE SUBSCRIPTION IS PROMISED TO END.
--   cancel_at                   WHAT STRIPE ACTUALLY HOLDS RIGHT NOW.
--
-- cancellation_requested_at is the input to the cutoff comparison and a
-- historical fact: once NON NULL it is never moved, not by a repeat
-- request and not by a reconciliation. It may be FILLED IN exactly once
-- while still NULL, and only by an authenticated customer request
-- matching a cancellation already on the row - the reconciliation race
-- described at CASE C below. NULL never means "queued"; it means no
-- customer request was ever recorded, which is the permanent and correct
-- answer for a Stripe Dashboard cancellation.
--
-- cancellation_effective_at is what the customer is told and what the
-- account page will show. For an EARLY cancellation it is the current
-- period end and Stripe holds it immediately. For a LATE one it is one
-- further cadence beyond that, and Stripe does NOT hold it yet - see the
-- header. It is the identity of a standing cancellation: two requests
-- naming the same effective date are the same decision, two naming
-- different dates are a conflict.
--
-- cancel_at MIRRORS STRIPE AND NOTHING ELSE. It is non-NULL if and only
-- if a cancellation genuinely exists at Stripe, so the two can be
-- compared and so nothing here can ever claim Stripe has scheduled
-- something it has not. That truthfulness is the whole point of keeping
-- it separate:
--
--   requested + effective + NO cancel_at   a late cancellation is owed
--                                          one further paid cycle and
--                                          Stripe holds nothing yet
--   requested + effective + cancel_at      Stripe holds the termination
--   no request + effective + cancel_at     the owner cancelled it in the
--                                          Stripe Dashboard
--
-- Deliberately NOT added: a cancellation reason, a customer note, a
-- pause/resume field, a product or quantity change field, a remaining
-- cycle COUNTER. The count is not stored because it is not a variable:
-- the rule is exactly one further cycle, the pending decision is consumed
-- the moment it is applied, and a counter that could read 2 is a counter
-- that could one day bill someone twice.
alter table public.subscriptions
  add column if not exists cancellation_requested_at timestamptz,
  add column if not exists cancellation_effective_at timestamptz,
  add column if not exists cancel_at                 timestamptz;

-- ── INVARIANT 1: a request always has a promised end date ─────
--
-- One-directional on purpose, and the direction matters.
--
-- A customer REQUEST always produces a promised end, so
-- cancellation_requested_at NOT NULL implies cancellation_effective_at
-- NOT NULL.
--
-- The reverse is deliberately NOT required. A cancellation may
-- legitimately exist without a local request: the owner can schedule one
-- directly in the Stripe Dashboard, and sync_subscription_from_stripe
-- below will reconcile that into these columns. Forcing a paired
-- constraint would have made that sync either impossible or a liar - it
-- would have had to invent a cancellation_requested_at for a request that
-- never happened.
--
-- NOTE THE CHANGE FROM THE FIRST DRAFT. This used to require a cancel_at,
-- which was correct only while every cancellation reached Stripe
-- immediately. A late cancellation deliberately does not, so requiring
-- one would have forced the deferred state to lie about Stripe.
alter table public.subscriptions
  drop constraint if exists subscriptions_cancellation_request_scheduled_check;

alter table public.subscriptions
  add constraint subscriptions_cancellation_request_scheduled_check
    check (cancellation_requested_at is null or cancellation_effective_at is not null);

-- ── INVARIANT 2: Stripe cannot hold what nothing promised ─────
--
-- cancel_at NOT NULL implies cancellation_effective_at NOT NULL. A
-- termination scheduled at Stripe is by definition a promised end date,
-- whoever made it, so the pair is written together in every path.
alter table public.subscriptions
  drop constraint if exists subscriptions_cancel_at_promised_check;

alter table public.subscriptions
  add constraint subscriptions_cancel_at_promised_check
    check (cancel_at is null or cancellation_effective_at is not null);

-- ── INVARIANT 3: you cannot end before you asked ──────────────
--
-- Only checked when both exist, so a Stripe-originated cancellation with
-- no local request is unaffected. Strictly greater: an end that takes
-- effect at the very instant it was requested would mean an immediate
-- termination, which this feature never performs.
alter table public.subscriptions
  drop constraint if exists subscriptions_effective_after_request_check;

alter table public.subscriptions
  add constraint subscriptions_effective_after_request_check
    check (
      cancellation_requested_at is null
      or cancellation_effective_at is null
      or cancellation_effective_at > cancellation_requested_at
    );

-- ── INVARIANT 4: the same, for what Stripe holds ──────────────
--
-- cancel_at and cancellation_effective_at are equal in every path this
-- migration writes, but a Stripe Dashboard cancellation can set one
-- without the other having come from here, so it is checked in its own
-- right rather than inferred.
alter table public.subscriptions
  drop constraint if exists subscriptions_cancel_at_after_request_check;

alter table public.subscriptions
  add constraint subscriptions_cancel_at_after_request_check
    check (
      cancellation_requested_at is null
      or cancel_at is null
      or cancel_at > cancellation_requested_at
    );

-- 2. RECORD A CUSTOMER CANCELLATION ────────────────────────────
--
-- Called by POST /api/subscriptions/cancel.
--
-- For an EARLY cancellation it is called strictly AFTER Stripe has
-- accepted the schedule, and p_cancel_at carries what Stripe now holds.
-- For a LATE one Stripe is deliberately not touched yet and p_cancel_at
-- is NULL - see the header. Either way this function records only what is
-- true at the moment it runs.
--
-- WHY A FUNCTION AND NOT A GRANT. service_role holds SELECT and nothing
-- else on public.subscriptions (migration 022). Granting it UPDATE would
-- let every line of server code holding the service-role key rewrite any
-- subscription's status, money, snapshots or Stripe binding. SECURITY
-- DEFINER keeps that grant at zero: after this migration service_role
-- STILL cannot write a single column of public.subscriptions directly.
-- The same reasoning migrations 011, 019, 028, 029 and 031 apply.
--
-- WHAT THE CALLER MAY AND MAY NOT DECIDE
--
-- May: which subscription, on whose behalf, when they asked, when it is
--      promised to end, and what Stripe holds - the last three computed
--      server-side from durable data.
-- May not: anything else. status, current_period_start/end,
--      next_delivery_at, stripe_subscription_id, every money column,
--      every snapshot, cancel_at_period_end and cancelled_at are never
--      written here at all.
--
-- IDENTITY IS cancellation_effective_at, NOT cancel_at. Two requests
-- naming the same end date are the same decision whether or not Stripe
-- holds it yet; that is what keeps a late cancellation idempotent during
-- the whole cycle before it reaches Stripe.
--
-- RESULT VOCABULARY (the route maps these to HTTP codes):
--   'scheduled'          recorded now, for the first time
--   'already_scheduled'  the same effective date already stands. Two
--                        sub-cases, both reported under this one result:
--                        a genuine repeat is a true no-op and moves
--                        NOTHING, while a request whose cancellation was
--                        already reconciled in from Stripe fills the
--                        still-NULL cancellation_requested_at and nothing
--                        else. The returned cancellation_requested_at is
--                        always the one now durably stored, and the
--                        second case additionally reports
--                        'request_recorded' = true
--   'conflict'           a DIFFERENT effective date already stands.
--                        Never silently overwritten
--   'not_found'          no such subscription, or not this user's
--   'not_eligible'       a lifecycle state that cannot be cancelled
--   'period_moved'       current_period_end changed since the caller
--                        computed the schedule
create or replace function public.schedule_subscription_cancellation(
  p_subscription_id uuid,
  p_user_id         uuid,
  p_requested_at    timestamptz,
  p_effective_at    timestamptz,
  p_cancel_at       timestamptz
)
returns jsonb
language plpgsql
volatile
security definer set search_path = ''
as $$
declare
  v_sub public.subscriptions;
begin
  if p_subscription_id is null or p_user_id is null
     or p_requested_at is null or p_effective_at is null then
    return jsonb_build_object('result', 'not_found');
  end if;

  -- p_cancel_at is OPTIONAL - NULL is the deferred late case - but when
  -- it is supplied it must be the same date Stripe was given. Anything
  -- else would mean this row and Stripe disagree about when the
  -- subscription ends, which is the one thing these columns exist to
  -- prevent.
  if p_cancel_at is not null and p_cancel_at <> p_effective_at then
    return jsonb_build_object('result', 'not_found');
  end if;

  -- Ownership is enforced HERE, in the database, against the user id the
  -- route already verified against Supabase Auth - never against anything
  -- the browser claimed. A subscription that does not belong to the
  -- caller is indistinguishable from one that does not exist, so this
  -- cannot be used to probe which subscription ids are real.
  select * into v_sub
  from public.subscriptions
  where id = p_subscription_id
    and user_id = p_user_id
  for update;

  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  -- B2C only. The B2B supply agreements are a different system with a
  -- different contract and must never be terminated through this route.
  if v_sub.customer_type is distinct from 'private' then
    return jsonb_build_object('result', 'not_found');
  end if;

  -- ── TERMINAL AND IDEMPOTENT ─────────────────────────────────
  -- Already ended. Nothing to schedule, and re-scheduling a dead
  -- subscription would be meaningless rather than merely harmless.
  if v_sub.status = 'cancelled' then
    return jsonb_build_object(
      'result', 'not_eligible',
      'subscription_id', v_sub.id,
      'status', v_sub.status
    );
  end if;

  -- ── ELIGIBLE LIFECYCLE STATES ───────────────────────────────
  -- 'active' is the real case today.
  --
  -- 'past_due' and 'unpaid' are accepted deliberately even though nothing
  -- currently writes them: Stripe moves a subscription into those states
  -- when a renewal payment fails, Phase 3E will synchronise them, and a
  -- customer whose card failed must still be able to cancel. Accepting
  -- them now costs nothing and means 3E will not have to edit this
  -- migration, which by then will be immutable.
  --
  -- 'pending' is refused: checkout never completed, so there is no Stripe
  -- subscription to schedule anything on.
  -- 'paused' is refused: pausing is not a launch feature and no code can
  -- produce that state, so a cancellation from it is not a case anyone
  -- has designed.
  if v_sub.status not in ('active', 'past_due', 'unpaid') then
    return jsonb_build_object(
      'result', 'not_eligible',
      'subscription_id', v_sub.id,
      'status', v_sub.status
    );
  end if;

  -- A subscription with no Stripe binding cannot be cancelled at Stripe
  -- at all, now or one cycle from now, so persisting a cancellation for
  -- it would record a fact that exists nowhere else.
  if v_sub.stripe_subscription_id is null then
    return jsonb_build_object(
      'result', 'not_eligible',
      'subscription_id', v_sub.id,
      'status', v_sub.status
    );
  end if;

  -- ── THE PERIOD MUST NOT HAVE MOVED ──────────────────────────
  -- The route computed p_effective_at from current_period_end. If a
  -- renewal committed in between, that computation is stale and applying
  -- it would promise the wrong date. Refusing lets the caller recompute
  -- against the row it now sees, rather than storing a date derived from
  -- a period that has already ended.
  --
  -- The comparison is >= rather than = because the LATE branch
  -- deliberately promises a full cadence beyond the period end.
  if v_sub.current_period_end is null or p_effective_at < v_sub.current_period_end then
    return jsonb_build_object(
      'result', 'period_moved',
      'subscription_id', v_sub.id,
      'current_period_end', v_sub.current_period_end
    );
  end if;

  -- ── A CANCELLATION ALREADY STANDS ─────────────────────────────
  --
  -- Three genuinely different situations hide behind "this subscription
  -- already has an end date", and collapsing them is how the customer's
  -- request gets lost. They are separated here deliberately.
  --
  -- The one that forced this structure is the RECONCILIATION RACE.
  -- POST /api/subscriptions/cancel writes an EARLY cancellation to Stripe
  -- FIRST and only then calls this function - a cancellation is not real
  -- until Stripe has accepted it. But Stripe emits
  -- customer.subscription.updated for that very change, and that webhook
  -- can reach this system BEFORE the HTTP request gets here.
  -- sync_subscription_from_stripe then writes cancel_at and
  -- cancellation_effective_at with cancellation_requested_at left NULL,
  -- because Stripe has no idea when a customer asked. If this function
  -- then treated the matching date as a finished repeat and wrote
  -- nothing, the fact that an authenticated customer requested the
  -- cancellation would be lost permanently - the row would be
  -- indistinguishable from a cancellation the owner made in the Stripe
  -- Dashboard.
  if v_sub.cancellation_effective_at is not null then

    -- ── CASE D: a DIFFERENT date already stands ───────────────
    -- Refused outright rather than merged. Silently moving a
    -- cancellation the customer has already been told about is exactly
    -- the kind of change that must never happen quietly. ZERO writes.
    if v_sub.cancellation_effective_at <> p_effective_at then
      return jsonb_build_object(
        'result', 'conflict',
        'subscription_id', v_sub.id,
        'cancellation_requested_at', v_sub.cancellation_requested_at,
        'cancellation_effective_at', v_sub.cancellation_effective_at,
        'cancel_at', v_sub.cancel_at
      );
    end if;

    -- ── CASE B: a genuine repeat ──────────────────────────────
    -- The same date AND the request is already on record. A true no-op
    -- performing ZERO writes. cancellation_requested_at is deliberately
    -- NOT moved: the customer asked when they asked, and that timestamp
    -- is the input to the cutoff comparison. Moving it would rewrite the
    -- reason the effective date is what it is.
    --
    -- cancel_at is NOT written here either, and that matters for the
    -- deferred late case: pressing cancel again during the cycle before
    -- the renewal must not fabricate a Stripe schedule that does not
    -- exist. Only apply_deferred_subscription_cancellation may set it,
    -- and only after Stripe has accepted it.
    if v_sub.cancellation_requested_at is not null then
      return jsonb_build_object(
        'result', 'already_scheduled',
        'subscription_id', v_sub.id,
        'cancellation_requested_at', v_sub.cancellation_requested_at,
        'cancellation_effective_at', v_sub.cancellation_effective_at,
        'cancel_at', v_sub.cancel_at
      );
    end if;

    -- ── CASE C: the reconciliation race ───────────────────────
    -- The same effective date already stands, but the customer request
    -- fact has never been recorded. This is the only place a NULL
    -- cancellation_requested_at is ever filled in, it can only ever
    -- happen ONCE per row (CASE B catches every later attempt), and it
    -- writes exactly ONE column.
    --
    -- Neither date is rewritten even though they match: the row already
    -- holds the correct schedule, and an assignment that cannot change a
    -- value can only obscure which path wrote it.
    --
    -- INVARIANT 3 (cancellation_effective_at > cancellation_requested_at)
    -- has to hold for this write, and it cannot be assumed: the standing
    -- date may have been set from a period that has since elapsed. A date
    -- that does not lie ahead of the request would raise a constraint
    -- violation out of this function and turn a customer's cancellation
    -- into a 500, so it is refused as 'period_moved' - the accurate
    -- answer, and the one that tells the caller to recompute.
    if p_effective_at <= p_requested_at then
      return jsonb_build_object(
        'result', 'period_moved',
        'subscription_id', v_sub.id,
        'current_period_end', v_sub.current_period_end
      );
    end if;

    update public.subscriptions
       set cancellation_requested_at = p_requested_at
     where id = v_sub.id;

    return jsonb_build_object(
      'result', 'already_scheduled',
      'subscription_id', v_sub.id,
      'cancellation_requested_at', p_requested_at,
      'cancellation_effective_at', v_sub.cancellation_effective_at,
      'cancel_at', v_sub.cancel_at,
      'request_recorded', true
    );
  end if;

  -- ── CASE A: THE WRITE ─────────────────────────────────────────
  -- Nothing stands yet, so the request and the promised end are written
  -- together. cancel_at follows only what Stripe actually holds: the
  -- early path passes the date it just accepted, the late path passes
  -- NULL and the row honestly says Stripe has scheduled nothing.
  --
  -- The same INVARIANT 3 guard as CASE C, for the same reason: a
  -- current_period_end that has already elapsed produces an effective
  -- date behind the request, and writing it would raise a constraint
  -- violation rather than record a cancellation.
  if p_effective_at <= p_requested_at then
    return jsonb_build_object(
      'result', 'period_moved',
      'subscription_id', v_sub.id,
      'current_period_end', v_sub.current_period_end
    );
  end if;

  -- THREE columns. Not status - a scheduled cancellation is still active.
  -- Not cancelled_at - that belongs to actual termination. Not
  -- cancel_at_period_end - we are not using that mechanism. Not the
  -- period columns, not the Stripe binding, not one money column, not one
  -- snapshot.
  update public.subscriptions
     set cancellation_requested_at = p_requested_at,
         cancellation_effective_at = p_effective_at,
         cancel_at                 = p_cancel_at
   where id = v_sub.id;

  return jsonb_build_object(
    'result', 'scheduled',
    'subscription_id', v_sub.id,
    'cancellation_requested_at', p_requested_at,
    'cancellation_effective_at', p_effective_at,
    'cancel_at', p_cancel_at
  );
end;
$$;

-- 2B. APPLY A DEFERRED LATE CANCELLATION ───────────────────────
--
-- THE OTHER HALF OF THE LATE PATH, and the reason no future-period
-- cancel_at is ever sent to Stripe.
--
-- Driven by invoice.paid, strictly after fulfillPaidSubscriptionInvoice
-- has advanced current_period_end and created the order for the cycle
-- that was just paid, and strictly after Stripe has accepted the
-- cancel_at. By then the promised end date is the end of the CURRENT
-- period, so setting it prorates nothing.
--
-- EXACTLY ONE FURTHER CYCLE is enforced by two conditions and no counter:
--
--   1. the pending decision is CONSUMED. It applies only while cancel_at
--      is still NULL, and applying it sets cancel_at. Every later
--      delivery of the same event, and every later renewal, finds a
--      non-NULL cancel_at and answers 'already_scheduled' with zero
--      writes and no Stripe call.
--   2. it will not fire EARLY. p_cancel_at is the now-current period end;
--      it must have reached the promised date. A redelivered invoice.paid
--      for the cycle the customer was in when they asked carries the
--      earlier period end and is refused as 'too_early', so a redelivery
--      inside Stripe's retry window cannot rob the customer of the cycle
--      they are owed.
--
-- The comparison fails toward NOT cancelling early: if the two dates ever
-- disagreed, the customer would keep the subscription one more cycle
-- rather than lose one they paid for. They do not disagree in practice -
-- the cadence is exactly 28 days and both sides derive from the same
-- Stripe timestamps - but the direction of the failure was chosen, not
-- inherited.
--
-- IT NEVER WRITES status. A subscription with a scheduled cancellation is
-- still active; termination has its own function below.
--
-- RESULT VOCABULARY:
--   'not_found'          no local subscription for that stripe id
--   'nothing_pending'    no customer request, or none awaiting Stripe
--   'too_early'          the promised date has not been reached yet
--   'already_scheduled'  Stripe already holds it. Idempotent, ZERO writes
--   'applied'            cancel_at recorded now
create or replace function public.apply_deferred_subscription_cancellation(
  p_stripe_subscription_id text,
  p_cancel_at              timestamptz
)
returns jsonb
language plpgsql
volatile
security definer set search_path = ''
as $$
declare
  v_sub public.subscriptions;
begin
  if p_stripe_subscription_id is null or btrim(p_stripe_subscription_id) = ''
     or p_cancel_at is null then
    return jsonb_build_object('result', 'not_found');
  end if;

  select * into v_sub
  from public.subscriptions
  where stripe_subscription_id = btrim(p_stripe_subscription_id)
  for update;

  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  -- No customer ever asked. An owner-initiated Stripe Dashboard
  -- cancellation is NOT a deferred decision and must not be re-applied
  -- from here.
  if v_sub.cancellation_requested_at is null or v_sub.cancellation_effective_at is null then
    return jsonb_build_object('result', 'nothing_pending', 'subscription_id', v_sub.id);
  end if;

  -- Already at Stripe. The decision was consumed - by an earlier delivery
  -- of this event, by an earlier renewal, or because the cancellation was
  -- early and never deferred at all.
  if v_sub.cancel_at is not null then
    return jsonb_build_object(
      'result', 'already_scheduled',
      'subscription_id', v_sub.id,
      'cancel_at', v_sub.cancel_at
    );
  end if;

  -- The cycle the customer was still owed has not been reached yet.
  if p_cancel_at < v_sub.cancellation_effective_at then
    return jsonb_build_object(
      'result', 'too_early',
      'subscription_id', v_sub.id,
      'cancellation_effective_at', v_sub.cancellation_effective_at
    );
  end if;

  -- INVARIANT 4 has to hold, and p_cancel_at comes from Stripe rather
  -- than from the promise, so it is checked rather than assumed.
  if p_cancel_at <= v_sub.cancellation_requested_at then
    return jsonb_build_object('result', 'too_early', 'subscription_id', v_sub.id);
  end if;

  -- TWO columns. The promised date is corrected to what Stripe actually
  -- accepted, because from this moment Stripe is the authority on when
  -- this subscription ends and two fields quietly disagreeing is worse
  -- than either one being slightly off.
  --
  -- Not status, not cancelled_at, not the period columns, not the Stripe
  -- binding, not one money column, not one snapshot, and nothing at all
  -- on public.orders - the cycle that was just paid for ships normally.
  update public.subscriptions
     set cancel_at                 = p_cancel_at,
         cancellation_effective_at = p_cancel_at
   where id = v_sub.id;

  return jsonb_build_object(
    'result', 'applied',
    'subscription_id', v_sub.id,
    'cancel_at', p_cancel_at
  );
end;
$$;

-- 3. RECONCILE SCHEDULING FACTS FROM STRIPE ────────────────────
--
-- Driven by customer.subscription.updated, from a subscription the
-- handler re-read from Stripe rather than from the event payload. Stripe
-- is the source of truth for these facts and this is how they come home.
--
-- IT CLOSES THE STRIPE-SUCCEEDED-DATABASE-FAILED WINDOW. If the early
-- path schedules at Stripe and then fails to persist locally, the
-- customer.subscription.updated event Stripe emits for that very change
-- arrives moments later and writes the cancellation anyway. The local
-- record self-heals without any retry, any cron or any customer action.
--
-- KEYED ON stripe_subscription_id, which carries a partial unique index
-- (migration 022), so there is exactly one local row behind one Stripe
-- subscription and no ambiguity to resolve.
--
-- DELIBERATELY NARROW. It refuses to be a general Stripe mirror:
--
--   * NEVER status. Stripe's status vocabulary and GLOA's are different
--     concepts, and letting an arbitrary Stripe update rewrite the local
--     lifecycle is precisely how a subscription silently changes state
--     nobody decided. Termination has its own function below; billing
--     failure states are Phase 3E's to design.
--   * NEVER money, snapshots, plan, items, addresses or tax. Those are
--     frozen at checkout by contract.
--   * NEVER invents a cancellation_requested_at. Stripe does not know
--     when a customer asked, and inventing one would break the cutoff
--     audit trail.
--   * NEVER cancel_at_period_end.
--
-- ── WHY "NO CANCELLATION AT STRIPE" IS NOT ENOUGH TO CLEAR ────
--
-- The first draft cleared the local request whenever Stripe reported no
-- cancel_at. That was safe only while every cancellation reached Stripe
-- immediately. It is now actively wrong: a LATE cancellation deliberately
-- holds no cancel_at at Stripe for the whole cycle before the renewal, so
-- any customer.subscription.updated during that cycle - a card update, a
-- renewal, anything at all - would have silently deleted the customer's
-- cancellation.
--
-- Clearing is therefore keyed on a TRANSITION, not on a value: only a
-- cancellation this row already recorded as living at Stripe, which
-- Stripe now reports as gone, is an unscheduling. A deferred request that
-- Stripe never held is left completely alone.
--
-- The period columns use coalesce so a partial event cannot erase a
-- timestamp we already had.
--
-- RESULT VOCABULARY:
--   'not_found'  no local subscription for that stripe id (normal for a
--                subscription this system did not create)
--   'unchanged'  nothing differed
--   'synced'     one or more of the reconciled facts was updated
create or replace function public.sync_subscription_from_stripe(
  p_stripe_subscription_id text,
  p_current_period_start   timestamptz,
  p_current_period_end     timestamptz,
  p_cancel_at              timestamptz
)
returns jsonb
language plpgsql
volatile
security definer set search_path = ''
as $$
declare
  v_sub public.subscriptions;
  v_new_start     timestamptz;
  v_new_end       timestamptz;
  v_new_effective timestamptz;
  v_new_requested timestamptz;
  v_unscheduled   boolean;
begin
  if p_stripe_subscription_id is null or btrim(p_stripe_subscription_id) = '' then
    return jsonb_build_object('result', 'not_found');
  end if;

  select * into v_sub
  from public.subscriptions
  where stripe_subscription_id = btrim(p_stripe_subscription_id)
  for update;

  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  v_new_start := coalesce(p_current_period_start, v_sub.current_period_start);
  v_new_end   := coalesce(p_current_period_end,   v_sub.current_period_end);

  -- A cancellation this row knew Stripe was holding, which Stripe now
  -- reports as gone. THAT is an unscheduling - not the mere absence of a
  -- cancel_at, which is the normal resting state of a deferred late
  -- cancellation.
  v_unscheduled := v_sub.cancel_at is not null and p_cancel_at is null;

  v_new_effective := case
                       when p_cancel_at is not null then p_cancel_at
                       when v_unscheduled then null
                       else v_sub.cancellation_effective_at
                     end;

  -- The request is a customer's historical fact and survives everything
  -- except a genuine unscheduling, which removes the cancellation it
  -- belonged to.
  v_new_requested := case
                       when v_unscheduled then null
                       else v_sub.cancellation_requested_at
                     end;

  if v_sub.current_period_start is not distinct from v_new_start
     and v_sub.current_period_end is not distinct from v_new_end
     and v_sub.cancel_at is not distinct from p_cancel_at
     and v_sub.cancellation_effective_at is not distinct from v_new_effective
     and v_sub.cancellation_requested_at is not distinct from v_new_requested
  then
    return jsonb_build_object('result', 'unchanged', 'subscription_id', v_sub.id);
  end if;

  update public.subscriptions
     set current_period_start     = v_new_start,
         current_period_end       = v_new_end,
         cancel_at                = p_cancel_at,
         cancellation_effective_at = v_new_effective,
         cancellation_requested_at = v_new_requested
   where id = v_sub.id;

  return jsonb_build_object(
    'result', 'synced',
    'subscription_id', v_sub.id,
    'cancel_at', p_cancel_at
  );
end;
$$;

-- 4. RECORD ACTUAL TERMINATION ─────────────────────────────────
--
-- Driven by customer.subscription.deleted, which Stripe emits when the
-- subscription genuinely ends - whether that is the cancel_at this
-- feature scheduled, a dashboard cancellation, or dunning exhaustion.
--
-- THIS IS THE ONLY PLACE status BECOMES 'cancelled'. Scheduling never
-- does it, and neither does the customer's request. Until Stripe says it
-- has ended, the customer is still paying for and receiving a service and
-- the record must say so.
--
-- IT DESTROYS NOTHING. The local subscription row survives, its
-- snapshots survive, every durable order from every past cycle survives
-- untouched, and the scheduling fields are left in place as the history
-- of how the termination came about.
--
-- RESULT VOCABULARY:
--   'not_found'          no local subscription for that stripe id
--   'already_cancelled'  idempotent repeat. cancelled_at is NOT moved
--   'cancelled'          recorded now
create or replace function public.mark_subscription_cancelled(
  p_stripe_subscription_id text,
  p_cancelled_at           timestamptz
)
returns jsonb
language plpgsql
volatile
security definer set search_path = ''
as $$
declare
  v_sub public.subscriptions;
begin
  if p_stripe_subscription_id is null or btrim(p_stripe_subscription_id) = '' then
    return jsonb_build_object('result', 'not_found');
  end if;

  select * into v_sub
  from public.subscriptions
  where stripe_subscription_id = btrim(p_stripe_subscription_id)
  for update;

  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  -- Idempotent, and cancelled_at is deliberately NOT moved: the
  -- subscription ended when it ended, and a redelivered event must not
  -- rewrite that.
  if v_sub.status = 'cancelled' then
    return jsonb_build_object(
      'result', 'already_cancelled',
      'subscription_id', v_sub.id,
      'cancelled_at', v_sub.cancelled_at
    );
  end if;

  -- TWO columns. Not the period fields, not cancel_at, not one money
  -- column, not one snapshot, and nothing at all on public.orders - the
  -- deliveries that were paid for happened and stay exactly as they are.
  update public.subscriptions
     set status       = 'cancelled',
         cancelled_at = coalesce(p_cancelled_at, now())
   where id = v_sub.id;

  return jsonb_build_object(
    'result', 'cancelled',
    'subscription_id', v_sub.id,
    'cancelled_at', coalesce(p_cancelled_at, now())
  );
end;
$$;

-- 5. EXECUTE PRIVILEGES ────────────────────────────────────────
--
-- No browser role may call any of these. revoke from public FIRST,
-- because a freshly created function is executable by PUBLIC by default
-- and anon/authenticated inherit that - revoking only the named roles
-- would leave the default in place and the functions reachable from the
-- browser's own Supabase client with nothing but an anon key.
--
-- service_role is the only grantee. It holds the key that never leaves
-- the server (lib/supabaseAdmin.ts), and it still holds NO direct write
-- privilege on public.subscriptions - this migration adds no table grant
-- and no column grant of any kind.
revoke all on function public.schedule_subscription_cancellation(uuid, uuid, timestamptz, timestamptz, timestamptz) from public;
revoke all on function public.schedule_subscription_cancellation(uuid, uuid, timestamptz, timestamptz, timestamptz) from anon;
revoke all on function public.schedule_subscription_cancellation(uuid, uuid, timestamptz, timestamptz, timestamptz) from authenticated;
grant execute on function public.schedule_subscription_cancellation(uuid, uuid, timestamptz, timestamptz, timestamptz) to service_role;

revoke all on function public.apply_deferred_subscription_cancellation(text, timestamptz) from public;
revoke all on function public.apply_deferred_subscription_cancellation(text, timestamptz) from anon;
revoke all on function public.apply_deferred_subscription_cancellation(text, timestamptz) from authenticated;
grant execute on function public.apply_deferred_subscription_cancellation(text, timestamptz) to service_role;

revoke all on function public.sync_subscription_from_stripe(text, timestamptz, timestamptz, timestamptz) from public;
revoke all on function public.sync_subscription_from_stripe(text, timestamptz, timestamptz, timestamptz) from anon;
revoke all on function public.sync_subscription_from_stripe(text, timestamptz, timestamptz, timestamptz) from authenticated;
grant execute on function public.sync_subscription_from_stripe(text, timestamptz, timestamptz, timestamptz) to service_role;

revoke all on function public.mark_subscription_cancelled(text, timestamptz) from public;
revoke all on function public.mark_subscription_cancelled(text, timestamptz) from anon;
revoke all on function public.mark_subscription_cancelled(text, timestamptz) from authenticated;
grant execute on function public.mark_subscription_cancelled(text, timestamptz) to service_role;

-- 6. NO NEW CLIENT PRIVILEGES ──────────────────────────────────
--
-- No grant, policy or privilege is created for anon or authenticated. A
-- customer keeps the SELECT-only access migration 005 gave them under the
-- "Private users read own subscriptions" RLS policy, which now also
-- covers these two columns - so the account page can show a scheduled
-- cancellation without any new privilege. anon still has no access at
-- all, and no browser can write a cancellation.

-- VERIFY ───────────────────────────────────────────────────────
--
-- Read-only. Run after applying. No statement below writes a row,
-- schedules a cancellation, cancels a subscription, calls Stripe or
-- sends an email.
--
-- (A)(B) ALL THREE COLUMNS EXIST, ARE NULLABLE, AND HAVE NO DEFAULT.
--     Expected: exactly three rows, all timestamp with time zone, all
--     is_nullable = YES, all column_default = NULL.
--
--     A non-NULL default here would mark every subscription in the shop
--     as cancelled-pending, which is the worst possible failure.
--
--   select column_name, data_type, is_nullable, column_default
--   from information_schema.columns
--   where table_schema = 'public' and table_name = 'subscriptions'
--     and column_name in ('cancellation_requested_at',
--                         'cancellation_effective_at', 'cancel_at')
--   order by column_name;
--
-- (C) ALL FOUR INVARIANTS EXIST. Expected: exactly four rows.
--
--   select conname, pg_get_constraintdef(oid) as definition
--   from pg_constraint
--   where conrelid = 'public.subscriptions'::regclass and contype = 'c'
--     and conname in ('subscriptions_cancellation_request_scheduled_check',
--                     'subscriptions_cancel_at_promised_check',
--                     'subscriptions_effective_after_request_check',
--                     'subscriptions_cancel_at_after_request_check')
--   order by conname;
--
-- (D) THE STATUS VOCABULARY IS UNCHANGED. This migration introduces no
--     new status. Expected: the 022 constraint, still naming exactly
--     'pending','active','paused','cancelled','past_due','unpaid'.
--
--   select conname, pg_get_constraintdef(oid) as definition
--   from pg_constraint
--   where conrelid = 'public.subscriptions'::regclass and contype = 'c'
--     and conname = 'subscriptions_status_check';
--
-- (E)(F) ALL FOUR FUNCTIONS EXIST, SECURITY DEFINER, EMPTY search_path.
--     Expected: four rows, security_definer = true for all four, and
--     proconfig = {"search_path="} for all four.
--
--   select p.proname,
--          pg_get_function_identity_arguments(p.oid) as arguments,
--          pg_get_function_result(p.oid)             as returns,
--          p.prosecdef                               as security_definer,
--          p.proconfig
--   from pg_proc p
--   join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public'
--     and p.proname in ('schedule_subscription_cancellation',
--                       'apply_deferred_subscription_cancellation',
--                       'sync_subscription_from_stripe',
--                       'mark_subscription_cancelled')
--   order by p.proname;
--
--     Expected arguments:
--       apply_deferred_subscription_cancellation  text, timestamp with time zone
--       mark_subscription_cancelled               text, timestamp with time zone
--       schedule_subscription_cancellation        uuid, uuid, timestamp with time zone, timestamp with time zone, timestamp with time zone
--       sync_subscription_from_stripe             text, timestamp with time zone, timestamp with time zone, timestamp with time zone
--     Expected returns: jsonb for all four.
--
-- (G) WHO MAY EXECUTE THEM. The important block.
--     Expected: false, false, false, true - for each of the four.
--
--   select
--     has_function_privilege('public',        'public.schedule_subscription_cancellation(uuid,uuid,timestamptz,timestamptz)', 'execute') as public_can,
--     has_function_privilege('anon',          'public.schedule_subscription_cancellation(uuid,uuid,timestamptz,timestamptz)', 'execute') as anon_can,
--     has_function_privilege('authenticated', 'public.schedule_subscription_cancellation(uuid,uuid,timestamptz,timestamptz)', 'execute') as authenticated_can,
--     has_function_privilege('service_role',  'public.schedule_subscription_cancellation(uuid,uuid,timestamptz,timestamptz)', 'execute') as service_role_can;
--
--   select
--     has_function_privilege('anon',          'public.sync_subscription_from_stripe(text,timestamptz,timestamptz,timestamptz)', 'execute') as anon_can,
--     has_function_privilege('authenticated', 'public.sync_subscription_from_stripe(text,timestamptz,timestamptz,timestamptz)', 'execute') as authenticated_can,
--     has_function_privilege('service_role',  'public.sync_subscription_from_stripe(text,timestamptz,timestamptz,timestamptz)', 'execute') as service_role_can;
--
--   select
--     has_function_privilege('anon',          'public.apply_deferred_subscription_cancellation(text,timestamptz)', 'execute') as anon_can,
--     has_function_privilege('authenticated', 'public.apply_deferred_subscription_cancellation(text,timestamptz)', 'execute') as authenticated_can,
--     has_function_privilege('service_role',  'public.apply_deferred_subscription_cancellation(text,timestamptz)', 'execute') as service_role_can;
--
--   select
--     has_function_privilege('anon',          'public.mark_subscription_cancelled(text,timestamptz)', 'execute') as anon_can,
--     has_function_privilege('authenticated', 'public.mark_subscription_cancelled(text,timestamptz)', 'execute') as authenticated_can,
--     has_function_privilege('service_role',  'public.mark_subscription_cancelled(text,timestamptz)', 'execute') as service_role_can;
--
-- (H) THE BROWSER STILL CANNOT WRITE A SUBSCRIPTION. THE IMPORTANT ONE.
--
--     Expected: authenticated holds SELECT only; anon absent entirely;
--     service_role holds SELECT only. This migration adds no table grant
--     and no column grant, so nothing here should have changed.
--
--   select grantee, privilege_type
--   from information_schema.role_table_grants
--   where table_schema = 'public' and table_name = 'subscriptions'
--     and grantee in ('anon', 'authenticated', 'service_role')
--   order by grantee, privilege_type;
--
--   select grantee, column_name, privilege_type
--   from information_schema.column_privileges
--   where table_schema = 'public' and table_name = 'subscriptions'
--     and privilege_type = 'UPDATE'
--     and grantee in ('anon', 'authenticated', 'service_role')
--   order by grantee, column_name;
--
--     Expected: the second query returns ZERO ROWS.
--
-- (I) RLS IS STILL ON AND STILL SELECT-ONLY FOR CUSTOMERS.
--     Expected: rowsecurity = true, and exactly the one SELECT policy
--     migration 005 created.
--
--   select relrowsecurity as rowsecurity
--   from pg_class where oid = 'public.subscriptions'::regclass;
--
--   select polname, polcmd, pg_get_expr(polqual, polrelid) as using_expr
--   from pg_policy where polrelid = 'public.subscriptions'::regclass
--   order by polname;
--
-- (J) NO SUBSCRIPTION WAS TOUCHED OR BACKFILLED. THE OTHER IMPORTANT ONE.
--     Applying this schedules nothing and cancels nothing.
--
--     Expected: requested = 0 and scheduled = 0 immediately after
--     applying. Every other count is expected to be exactly whatever it
--     already was.
--
--   select count(*)                                            as subscriptions,
--          count(cancellation_effective_at)                     as promised,
--          count(*) filter (where status = 'active')            as active,
--          count(*) filter (where status = 'pending')           as pending,
--          count(*) filter (where status = 'cancelled')         as cancelled,
--          count(cancellation_requested_at)                     as requested,
--          count(cancel_at)                                     as scheduled,
--          count(cancelled_at)                                  as terminated,
--          count(*) filter (where cancel_at_period_end)         as period_end_flagged
--   from public.subscriptions;
--
--     requested, promised and scheduled are all expected to be 0
--     immediately after applying.
--
--     period_end_flagged is expected to be 0 and to STAY 0: this feature
--     never sets cancel_at_period_end. See the header for why.
--
-- (M) NO ROW EVER CLAIMS STRIPE HOLDS SOMETHING IT DOES NOT.
--     The deferred late state is legitimate and expected to appear once
--     the feature is live; the reverse never is.
--     Expected: zero rows, always.
--
--   select id, cancellation_requested_at, cancellation_effective_at, cancel_at
--   from public.subscriptions
--   where (cancel_at is not null and cancellation_effective_at is null)
--      or (cancellation_requested_at is not null and cancellation_effective_at is null);
--
--     And the deferred state itself, which is what a late cancellation
--     looks like while it waits for its last paid cycle:
--
--   select count(*) as awaiting_final_cycle
--   from public.subscriptions
--   where cancellation_requested_at is not null and cancel_at is null;
--
-- (K) NO TRIGGER ADDED. Expected: only set_subscriptions_updated_at from
--     migration 005.
--
--   select tgname, pg_get_triggerdef(oid) as definition
--   from pg_trigger
--   where tgrelid = 'public.subscriptions'::regclass and not tgisinternal
--   order by tgname;
--
-- (L) MIGRATIONS 022 THROUGH 033 ARE UNTOUCHED. The subscription
--     foundation still stands exactly as it was.
--     Expected: all three pre-existing subscription functions present,
--     SECURITY DEFINER, empty search_path, service_role only.
--
--   select p.proname,
--          p.prosecdef as security_definer,
--          p.proconfig,
--          has_function_privilege('anon',         p.oid, 'execute') as anon_can,
--          has_function_privilege('service_role', p.oid, 'execute') as service_role_can
--   from pg_proc p
--   join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public'
--     and p.proname in ('create_pending_subscription',            -- 022
--                       'activate_subscription_from_invoice',     -- 022
--                       'claim_pending_subscription_for_attempt') -- 025
--   order by p.proname;
--
--     And the unique bindings 022 established are intact:
--
--   select indexname, indexdef
--   from pg_indexes
--   where schemaname = 'public'
--     and indexname in ('subscriptions_stripe_subscription_id_key',
--                       'checkout_attempts_stripe_invoice_id_key')
--   order by indexname;

-- ══════════════════════════════════════════════════════════════
-- WHAT IS DELIBERATELY NOT HERE
-- ══════════════════════════════════════════════════════════════
--
-- NO BILLING FAILURE HANDLING. invoice.payment_failed, dunning and the
-- 'past_due'/'unpaid' transitions are Phase 3E. This migration only makes
-- sure it has not made that work harder: those two statuses are already
-- accepted as cancellable above, and sync_subscription_from_stripe
-- deliberately refuses to write status so 3E can own that decision
-- outright.
--
-- NO PAUSE, NO RESUME, NO PRODUCT SWITCH, NO QUANTITY CHANGE, NO ADDRESS
-- CHANGE. None is an approved launch feature, and none has a column here.
--
-- NO CANCELLATION REASON. Not collected, so never stored and never shown.
--
-- NO CUSTOMER EMAIL. Subscription lifecycle mail is a separate decision.
-- There is no trigger, no NOTIFY and no http call in this migration.
-- ══════════════════════════════════════════════════════════════
