-- ══════════════════════════════════════════════════════════════
-- 064 — B2B ACCOUNT CHANGE MANAGEMENT
--
-- Package 5G is the customer's own control over a MONTHLY agreement,
-- and the two things they may actually change:
--
--   the pack count, for the NEXT billing cycle
--   the contract itself, ending at a Stripe period boundary
--
-- Everything else 5G does is READING what 059, 060 and 063 already
-- store. That is why this migration is small: the account screen, the
-- admin screen, the annual schedule view and the address change all
-- work against live schema and need nothing new.
--
-- ── WHAT NEEDED A COLUMN, AND WHAT DID NOT ────────────────────
--
-- CANCELLATION NEEDED NOTHING. 059 already has the whole vocabulary -
-- cancellation_requested_at, cancellation_effective_at,
-- cancellation_reason - with nine constraints over it, including
-- b2b_supply_agreements_annual_no_ordinary_cancellation_check, which
-- makes "an annual contract cannot be ordinarily cancelled" a database
-- guarantee rather than an application rule. 064 adds the WRITERS those
-- columns never had; it adds no cancellation state.
--
-- THE PENDING QUANTITY NEEDED TWO COLUMNS. The approved commercial rule
-- is that a new pack count takes effect NEXT cycle and never touches the
-- current one, so between the request and the next period boundary there
-- is a fact with nowhere to live:
--
--   quantity_packs          what the customer is billed and delivered
--                           NOW, and what the canonical supply item and
--                           the base monthly net must mirror
--   pending_quantity_packs  what they will be billed and delivered from
--                           the next boundary
--
-- Writing the new count straight into quantity_packs would have been the
-- alternative, and it is wrong twice over: 059's
-- b2b_supply_agreements_self_service_base_monthly_formula_check would
-- force base_monthly_product_net_cents to move with it, so the agreement
-- would immediately quote a price the customer is not yet paying; and
-- 062's settle_b2b_monthly_paid_invoice reads quantity_packs to create
-- each delivery, so the very next delivery would carry the new count
-- even if the invoice that paid for it carried the old one.
--
-- Keeping it in application memory was never an option: the boundary is
-- days or weeks away and arrives as a Stripe webhook in a different
-- process.
--
-- ── AND WHY 060 ALREADY AGREES WITH THIS ──────────────────────
--
-- 060's assert_b2b_commerce_integrity deliberately does NOT mirror
-- quantity_packs onto a monthly agreement's deliveries, and says so in
-- its own comment: "A monthly customer may change quantity". The
-- historical delivery rows are therefore already safe from a quantity
-- change by construction, which is why this migration adds no delivery
-- state and rewrites no delivery row.
--
-- ── THE PRIVILEGE POSTURE IS UNCHANGED ────────────────────────
--
-- Six SECURITY DEFINER writers, EXECUTE to service_role and to nobody
-- else. No table privilege is granted anywhere in this file, so
-- service_role still holds SELECT and only SELECT on the four commerce
-- tables, exactly as after 060. No policy, no RLS change, no index, and
-- 001-063 are referenced only to read.
--
-- The two new columns are covered by the existing SELECT grant and the
-- existing "Business users read own supply agreements" policy, which is
-- deliberate: a customer may see that their own change is pending.
--
-- ── WHAT 064 DELIBERATELY DOES NOT DO ─────────────────────────
--
--   * no annual quantity change and no annual early cancellation. Both
--     are refused here AND by 059's constraints, so an application bug
--     cannot produce either.
--   * no pause. 059's self_service_status_check forbids it.
--   * no Stripe call and no Stripe id beyond the subscription id that
--     059 already stores. The cutoff arithmetic that decides an
--     effective date depends on the Stripe period boundary and lives in
--     lib/b2bCancellationRules.ts, as 059's own comment on
--     cancellation_effective_at said it would.
--   * no proration, no price, no invoice. Money stays in Stripe and in
--     the 060 tables that already model it.
--   * no admin override. There is no writer here that an operator could
--     use to change a commercial term, because no such capability is
--     approved.
-- ══════════════════════════════════════════════════════════════

begin;

-- ══════════════════════════════════════════════════════════════
-- 1. THE PENDING QUANTITY
-- ══════════════════════════════════════════════════════════════

alter table public.b2b_supply_agreements
  -- MONTHLY ONLY. The pack count that takes effect at the next Stripe
  -- billing boundary. NULL means no change is pending, which is the
  -- normal state of every agreement.
  add column pending_quantity_packs        integer,
  -- When the customer asked. Separate from the value so "a change is
  -- pending" and "when it was requested" cannot disagree.
  add column pending_quantity_requested_at timestamptz;

comment on column public.b2b_supply_agreements.pending_quantity_packs is
  'MONTHLY ONLY: the pack count that becomes quantity_packs at the next Stripe billing boundary, applied by apply_b2b_monthly_quantity_change. NULL = no pending change. Never equal to quantity_packs - a request for the current count clears the pending change instead of storing a no-op.';
comment on column public.b2b_supply_agreements.pending_quantity_requested_at is
  'When the customer requested the pending quantity change. Pairwise with pending_quantity_packs.';

alter table public.b2b_supply_agreements
  -- Both or neither. A value with no timestamp is a change nobody can
  -- date, and a timestamp with no value is a change with no content.
  add constraint b2b_supply_agreements_pending_quantity_pairwise_check
    check ((pending_quantity_packs is null) = (pending_quantity_requested_at is null)),

  -- The same self-service range the current quantity has.
  add constraint b2b_supply_agreements_pending_quantity_range_check
    check (pending_quantity_packs is null
           or pending_quantity_packs between 1 and 10),

  -- MONTHLY ONLY, and therefore never on an annual contract or on a
  -- legacy row. The annual quantity is frozen for the term.
  add constraint b2b_supply_agreements_pending_quantity_monthly_check
    check (pending_quantity_packs is null or plan_type = 'monthly'),

  -- A PENDING CHANGE IS A CHANGE. Storing the count the customer
  -- already has would make the next boundary rewrite the agreement to
  -- the value it already held, and would show the customer a pending
  -- change that changes nothing.
  add constraint b2b_supply_agreements_pending_quantity_differs_check
    check (pending_quantity_packs is null
           or pending_quantity_packs is distinct from quantity_packs);


-- ══════════════════════════════════════════════════════════════
-- 2. REQUEST A MONTHLY QUANTITY CHANGE
-- ══════════════════════════════════════════════════════════════
--
-- ── LAST REQUEST BEFORE THE BOUNDARY WINS ─────────────────────
--
-- Two requests before the same boundary are not a conflict to refuse:
-- the customer changed their mind, and the honest answer is the one they
-- asked for most recently. So this OVERWRITES a pending change rather
-- than rejecting the second request, and the rule is stated here rather
-- than left to whichever call arrived last by accident.
--
-- It is deterministic because the row is locked: two concurrent requests
-- serialise, and the one that commits second is the one that stands.
--
-- ── AND A CONTRACT THAT IS ENDING DOES NOT CHANGE QUANTITY ────
--
-- Once a cancellation is requested, the remaining periods are the ones
-- the customer was promised at the quantity they were promised. Raising
-- the count for a final period nobody wants more of is not a service.

create function public.request_b2b_monthly_quantity_change(
  p_agreement_id      uuid,
  p_expected_user_id  uuid,
  p_quantity_packs    integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_agreement public.b2b_supply_agreements;
begin
  if p_agreement_id is null or p_expected_user_id is null then
    return pg_catalog.jsonb_build_object('result', 'invalid_request');
  end if;

  select * into v_agreement
    from public.b2b_supply_agreements
   where id = p_agreement_id
     for update;

  if not found then
    return pg_catalog.jsonb_build_object('result', 'agreement_not_found');
  end if;

  -- OWNERSHIP FIRST, and never used as a value: the caller's claimed
  -- user id is only ever compared, exactly as in 061.
  if v_agreement.user_id is distinct from p_expected_user_id then
    return pg_catalog.jsonb_build_object('result', 'not_owner');
  end if;

  if v_agreement.plan_type is distinct from 'monthly' then
    -- An annual contract's quantity is frozen for the term, and 059's
    -- immutability trigger refuses it too.
    return pg_catalog.jsonb_build_object('result', 'not_monthly');
  end if;

  if v_agreement.status is distinct from 'active' then
    return pg_catalog.jsonb_build_object('result', 'agreement_not_active');
  end if;

  if v_agreement.cancellation_requested_at is not null then
    return pg_catalog.jsonb_build_object('result', 'cancellation_pending',
      'cancellation_effective_at', v_agreement.cancellation_effective_at);
  end if;

  if p_quantity_packs is null or p_quantity_packs < 1 or p_quantity_packs > 10 then
    return pg_catalog.jsonb_build_object('result', 'quantity_out_of_range');
  end if;

  -- THE CURRENT COUNT IS NOT A CHANGE. Clearing is the right answer:
  -- a customer who asks for what they already have has cancelled any
  -- pending change, which is exactly what they mean.
  if p_quantity_packs = v_agreement.quantity_packs then
    update public.b2b_supply_agreements
       set pending_quantity_packs        = null,
           pending_quantity_requested_at = null
     where id = p_agreement_id;

    return pg_catalog.jsonb_build_object('result', 'unchanged',
      'quantity_packs', v_agreement.quantity_packs);
  end if;

  update public.b2b_supply_agreements
     set pending_quantity_packs        = p_quantity_packs,
         pending_quantity_requested_at = pg_catalog.now()
   where id = p_agreement_id;

  return pg_catalog.jsonb_build_object('result', 'requested',
    'quantity_packs', v_agreement.quantity_packs,
    'pending_quantity_packs', p_quantity_packs);
end;
$$;

comment on function public.request_b2b_monthly_quantity_change(uuid, uuid, integer) is
  'PACKAGE 5G: records a MONTHLY pack-count change for the next billing boundary. Overwrites a pending change (last request before the boundary wins); the current count clears it. Refuses annual, inactive and cancelling agreements, and any caller who is not the owner. Writes no money and touches no delivery.';


-- ══════════════════════════════════════════════════════════════
-- 3. APPLY IT AT THE BOUNDARY
-- ══════════════════════════════════════════════════════════════
--
-- Called from the monthly invoice.paid branch of the webhook, BEFORE
-- 062's settle_b2b_monthly_paid_invoice creates that period's delivery -
-- which is what makes the new count reach the delivery as well as the
-- price, in one transaction, without 062 being touched.
--
-- ── FOUR FACTS MOVE TOGETHER OR NOT AT ALL ────────────────────
--
--   quantity_packs                   the agreement's current count
--   base_monthly_product_net_cents   059 forces it to be packs x 5250
--   pricing_snapshot                 059 forces packs, kilograms and
--                                    monthlyProductNetCents to agree
--   the canonical supply item        059 forces its quantity to mirror
--
-- All four are written in one transaction. The item integrity trigger is
-- DEFERRABLE INITIALLY DEFERRED, so the intermediate state where the
-- agreement has moved and the item has not is never observed.
--
-- kilograms is computed in FLOAT8 rather than numeric on purpose. The
-- producer is TypeScript - (packs * packGrams) / 1000 in
-- lib/b2bPricingRules.ts - so the stored JSON must be the same number a
-- JS float produces. numeric division would store 1.0000000000000000
-- where the builder stores 1, and although 059's check compares
-- numerically and would pass, the snapshot would stop being the thing
-- the builder emits. Every value this produces is a multiple of 0.5 and
-- therefore exact in binary.
--
-- base_monthly_product_net_cents multiplies by the row's OWN
-- pack_net_cents rather than by a literal 5250. If a row ever carried a
-- different pack price the formula check would reject the update, which
-- is the fail-closed outcome; hard-coding 5250 here would instead write
-- a figure that disagrees with the row.

create function public.apply_b2b_monthly_quantity_change(
  p_agreement_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_agreement public.b2b_supply_agreements;
  v_new_packs integer;
  v_kilograms double precision;
  v_new_net   integer;
begin
  if p_agreement_id is null then
    return pg_catalog.jsonb_build_object('result', 'invalid_request');
  end if;

  select * into v_agreement
    from public.b2b_supply_agreements
   where id = p_agreement_id
     for update;

  if not found then
    return pg_catalog.jsonb_build_object('result', 'agreement_not_found');
  end if;

  -- IDEMPOTENT BY CONSTRUCTION. A replayed webhook finds no pending
  -- change and says so; it does not apply anything a second time.
  if v_agreement.pending_quantity_packs is null then
    return pg_catalog.jsonb_build_object('result', 'no_pending_change',
      'quantity_packs', v_agreement.quantity_packs);
  end if;

  if v_agreement.plan_type is distinct from 'monthly' then
    return pg_catalog.jsonb_build_object('result', 'not_monthly');
  end if;

  v_new_packs := v_agreement.pending_quantity_packs;
  v_kilograms := (v_new_packs::double precision * v_agreement.pack_grams::double precision) / 1000;
  v_new_net   := v_new_packs * v_agreement.pack_net_cents;

  update public.b2b_supply_agreements
     set quantity_packs                 = v_new_packs,
         base_monthly_product_net_cents = v_new_net,
         pricing_snapshot               = pg_catalog.jsonb_set(
           pg_catalog.jsonb_set(
             pg_catalog.jsonb_set(
               v_agreement.pricing_snapshot,
               '{packs}', pg_catalog.to_jsonb(v_new_packs), true),
             '{kilograms}', pg_catalog.to_jsonb(v_kilograms), true),
           '{monthlyProductNetCents}', pg_catalog.to_jsonb(v_new_net), true),
         pending_quantity_packs        = null,
         pending_quantity_requested_at = null
   where id = p_agreement_id;

  -- THE CANONICAL LINE MOVES WITH IT, as 059's comment on
  -- quantity_packs requires: "the canonical supply item must move with
  -- it in the same transaction".
  update public.b2b_supply_items
     set quantity = v_new_packs
   where supply_agreement_id = p_agreement_id
     and item_role = 'canonical_matcha';

  return pg_catalog.jsonb_build_object('result', 'applied',
    'previous_quantity_packs', v_agreement.quantity_packs,
    'quantity_packs', v_new_packs,
    'base_monthly_product_net_cents', v_new_net);
end;
$$;

comment on function public.apply_b2b_monthly_quantity_change(uuid) is
  'PACKAGE 5G: promotes pending_quantity_packs to quantity_packs at a billing boundary, moving base_monthly_product_net_cents, the three quantity-dependent pricing_snapshot keys and the canonical supply item in the same transaction. Idempotent: no pending change is a reported no-op. Rewrites no historical delivery.';


-- ══════════════════════════════════════════════════════════════
-- 4. REQUEST A MONTHLY CANCELLATION
-- ══════════════════════════════════════════════════════════════
--
-- ── FIRST REQUEST WINS, AND THE PROMISE DOES NOT MOVE ─────────
--
-- The opposite rule from the quantity change above, and deliberately so.
-- cancellation_effective_at is a PROMISE: it is the date the customer
-- was told their supply ends and their billing stops. A second request
-- returning a different date would let the promise drift - forward if
-- the 14-day cutoff has since passed, which costs the customer another
-- period they were told they did not owe.
--
-- So a repeated request is answered with the date already promised and
-- changes nothing. Idempotent replay converges on the FIRST answer,
-- which is the only one the customer has seen.
--
-- ── THE EFFECTIVE DATE IS NOT COMPUTED HERE ───────────────────
--
-- It is handed in, because it depends on the authoritative Stripe
-- billing-period boundary and on the 14-day calendar cutoff measured
-- against it - neither of which SQL can see. 059's own comment on
-- cancellation_effective_at says exactly this: "the 14-day cutoff that
-- computes it depends on the Stripe period boundary and is Package 5
-- logic, deliberately not encoded in SQL".
--
-- What IS enforced here is that the date is a future one, and 059's
-- constraints enforce the rest: effective >= requested, both or
-- neither, a reason only with a request, and no ordinary cancellation on
-- an annual contract at all.

create function public.request_b2b_monthly_cancellation(
  p_agreement_id     uuid,
  p_expected_user_id uuid,
  p_effective_at     timestamptz,
  p_reason           text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_agreement public.b2b_supply_agreements;
  v_reason    text;
begin
  if p_agreement_id is null or p_expected_user_id is null then
    return pg_catalog.jsonb_build_object('result', 'invalid_request');
  end if;

  select * into v_agreement
    from public.b2b_supply_agreements
   where id = p_agreement_id
     for update;

  if not found then
    return pg_catalog.jsonb_build_object('result', 'agreement_not_found');
  end if;

  if v_agreement.user_id is distinct from p_expected_user_id then
    return pg_catalog.jsonb_build_object('result', 'not_owner');
  end if;

  if v_agreement.plan_type is distinct from 'monthly' then
    -- An annual contract has no ordinary cancellation. 059's
    -- annual_no_ordinary_cancellation_check refuses the write as well,
    -- so this is a clear answer rather than the only defence.
    return pg_catalog.jsonb_build_object('result', 'not_monthly');
  end if;

  if v_agreement.status is distinct from 'active' then
    return pg_catalog.jsonb_build_object('result', 'agreement_not_active');
  end if;

  -- ALREADY PROMISED. Return the promise, move nothing.
  if v_agreement.cancellation_requested_at is not null then
    return pg_catalog.jsonb_build_object('result', 'already_requested',
      'cancellation_requested_at', v_agreement.cancellation_requested_at,
      'cancellation_effective_at', v_agreement.cancellation_effective_at);
  end if;

  if p_effective_at is null or p_effective_at <= pg_catalog.now() then
    return pg_catalog.jsonb_build_object('result', 'effective_not_in_future');
  end if;

  v_reason := nullif(pg_catalog.btrim(coalesce(p_reason, '')), '');
  if v_reason is not null and pg_catalog.length(v_reason) > 500 then
    -- 059 caps it at 500; refusing beats letting the constraint abort a
    -- transaction that has already started.
    return pg_catalog.jsonb_build_object('result', 'reason_too_long');
  end if;

  update public.b2b_supply_agreements
     set cancellation_requested_at = pg_catalog.now(),
         cancellation_effective_at = p_effective_at,
         cancellation_reason       = v_reason,
         -- A CONTRACT THAT IS ENDING DOES NOT CHANGE QUANTITY. Any
         -- pending change is dropped rather than applied to a period
         -- the customer has asked not to have.
         pending_quantity_packs        = null,
         pending_quantity_requested_at = null
   where id = p_agreement_id;

  return pg_catalog.jsonb_build_object('result', 'requested',
    'cancellation_effective_at', p_effective_at);
end;
$$;

comment on function public.request_b2b_monthly_cancellation(uuid, uuid, timestamptz, text) is
  'PACKAGE 5G: records a MONTHLY cancellation request and the effective boundary the customer was promised. FIRST REQUEST WINS - a repeat returns the existing promise unchanged, so replay converges on the date the customer has already seen. Refuses annual, inactive and non-owner. The effective date is computed from the Stripe period boundary by lib/b2bCancellationRules.ts, never here.';


-- ══════════════════════════════════════════════════════════════
-- 5. RECONCILE THE BOUNDARY AGAINST STRIPE
-- ══════════════════════════════════════════════════════════════
--
-- THE CRASH WINDOW. The request above writes the database first and
-- Stripe second, because that order fails safely: a database write with
-- no Stripe update means the customer keeps their supply and keeps being
-- billed, which a retry fixes, whereas a Stripe update with no database
-- record means a subscription silently stops while every screen still
-- says active.
--
-- This is the other half. It is called with what Stripe ACTUALLY holds -
-- the subscription's cancel_at - and makes the database agree:
--
--   nothing recorded         record it, dated now
--   the same boundary        already_recorded, write nothing
--   a different boundary     Stripe is authoritative; move ours
--
-- It is NOT a customer surface and takes no expected user id: the only
-- caller is the webhook or the reconcile pass, both of which are already
-- acting on a Stripe object that names the subscription.
--
-- It deliberately refuses a boundary EARLIER than the request, because
-- 059 requires effective >= requested and because a cancellation cannot
-- have taken effect before it was asked for.

create function public.reconcile_b2b_monthly_cancellation(
  p_agreement_id uuid,
  p_effective_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_agreement public.b2b_supply_agreements;
begin
  if p_agreement_id is null or p_effective_at is null then
    return pg_catalog.jsonb_build_object('result', 'invalid_request');
  end if;

  select * into v_agreement
    from public.b2b_supply_agreements
   where id = p_agreement_id
     for update;

  if not found then
    return pg_catalog.jsonb_build_object('result', 'agreement_not_found');
  end if;

  if v_agreement.plan_type is distinct from 'monthly' then
    return pg_catalog.jsonb_build_object('result', 'not_monthly');
  end if;

  if v_agreement.cancellation_requested_at is null then
    -- STRIPE KNEW AND WE DID NOT. Record it now, which is the truthful
    -- request time as far as this system can establish it.
    update public.b2b_supply_agreements
       set cancellation_requested_at = pg_catalog.now(),
           cancellation_effective_at = greatest(p_effective_at, pg_catalog.now()),
           pending_quantity_packs        = null,
           pending_quantity_requested_at = null
     where id = p_agreement_id;

    return pg_catalog.jsonb_build_object('result', 'recorded',
      'cancellation_effective_at', greatest(p_effective_at, pg_catalog.now()));
  end if;

  if v_agreement.cancellation_effective_at = p_effective_at then
    return pg_catalog.jsonb_build_object('result', 'already_recorded',
      'cancellation_effective_at', v_agreement.cancellation_effective_at);
  end if;

  if p_effective_at < v_agreement.cancellation_requested_at then
    return pg_catalog.jsonb_build_object('result', 'effective_before_request',
      'cancellation_effective_at', v_agreement.cancellation_effective_at);
  end if;

  update public.b2b_supply_agreements
     set cancellation_effective_at = p_effective_at
   where id = p_agreement_id;

  return pg_catalog.jsonb_build_object('result', 'effective_moved',
    'previous_cancellation_effective_at', v_agreement.cancellation_effective_at,
    'cancellation_effective_at', p_effective_at);
end;
$$;

comment on function public.reconcile_b2b_monthly_cancellation(uuid, timestamptz) is
  'PACKAGE 5G: makes the database agree with the cancel_at Stripe actually holds for a MONTHLY subscription. Records an unrecorded cancellation, converges silently on an identical boundary, and moves ours when Stripe differs. Refuses a boundary earlier than the request. Not a customer surface.';


-- ══════════════════════════════════════════════════════════════
-- 6. THE AGREEMENT BEHIND A SUBSCRIPTION
-- ══════════════════════════════════════════════════════════════
--
-- The webhook receives a Stripe subscription id and needs the agreement.
-- service_role can already SELECT the table, so this exists for ONE
-- reason: the definer sees the row whatever the policy says, and the
-- caller gets exactly five fields rather than a whole commercial row
-- with two address snapshots in it.

create function public.b2b_monthly_agreement_for_subscription(
  p_stripe_subscription_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_agreement public.b2b_supply_agreements;
  v_sub       text;
begin
  v_sub := nullif(pg_catalog.btrim(coalesce(p_stripe_subscription_id, '')), '');
  if v_sub is null then
    return pg_catalog.jsonb_build_object('result', 'invalid_request');
  end if;

  select * into v_agreement
    from public.b2b_supply_agreements
   where stripe_subscription_id = v_sub;

  if not found then
    return pg_catalog.jsonb_build_object('result', 'agreement_not_found');
  end if;

  return pg_catalog.jsonb_build_object('result', 'found',
    'agreement_id', v_agreement.id,
    'plan_type', v_agreement.plan_type,
    'status', v_agreement.status,
    'quantity_packs', v_agreement.quantity_packs,
    'pending_quantity_packs', v_agreement.pending_quantity_packs,
    'cancellation_effective_at', v_agreement.cancellation_effective_at);
end;
$$;

comment on function public.b2b_monthly_agreement_for_subscription(text) is
  'PACKAGE 5G: the six facts a webhook needs about the agreement behind a Stripe subscription id. A narrow read, not a row: no address snapshot, no business snapshot, no pricing snapshot.';


-- ══════════════════════════════════════════════════════════════
-- 7. THE TERMINATION ITSELF
-- ══════════════════════════════════════════════════════════════
--
-- The ONLY writer of status = 'cancelled' for a self-service monthly
-- agreement, and it is driven by customer.subscription.deleted - the one
-- Stripe event that means the subscription has actually ended. The same
-- posture Phase 3C took for B2C subscriptions, and for the same reason:
-- a local timer can be wrong about whether Stripe stopped billing, and
-- the event cannot.
--
-- IT WRITES NO termination_reason. That column is for an exceptional
-- termination GLOA performs; an ordinary cancellation the customer asked
-- for is described by the cancellation_* columns and by nothing else.
--
-- It does not cancel deliveries. A monthly delivery only exists because
-- an invoice was paid for it, so an ended agreement has no unpaid future
-- slot to withdraw - and withdrawing a paid one would be taking back
-- something the customer has already bought.

create function public.settle_b2b_monthly_cancelled_subscription(
  p_stripe_subscription_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_agreement public.b2b_supply_agreements;
  v_sub       text;
begin
  v_sub := nullif(pg_catalog.btrim(coalesce(p_stripe_subscription_id, '')), '');
  if v_sub is null then
    return pg_catalog.jsonb_build_object('result', 'invalid_request');
  end if;

  select * into v_agreement
    from public.b2b_supply_agreements
   where stripe_subscription_id = v_sub
     for update;

  if not found then
    return pg_catalog.jsonb_build_object('result', 'agreement_not_found');
  end if;

  if v_agreement.plan_type is distinct from 'monthly' then
    return pg_catalog.jsonb_build_object('result', 'not_monthly');
  end if;

  -- IDEMPOTENT. A redelivered event finds the agreement already ended.
  if v_agreement.status = 'cancelled' then
    return pg_catalog.jsonb_build_object('result', 'already_cancelled',
      'agreement_id', v_agreement.id,
      'ended_at', v_agreement.ended_at);
  end if;

  update public.b2b_supply_agreements
     set status  = 'cancelled',
         ended_at = coalesce(v_agreement.ended_at, pg_catalog.now()),
         -- Nothing is pending on an ended contract.
         pending_quantity_packs        = null,
         pending_quantity_requested_at = null,
         next_delivery_at              = null
   where id = v_agreement.id;

  return pg_catalog.jsonb_build_object('result', 'cancelled',
    'agreement_id', v_agreement.id);
end;
$$;

comment on function public.settle_b2b_monthly_cancelled_subscription(text) is
  'PACKAGE 5G: the only writer of status = cancelled for a self-service MONTHLY agreement, driven by customer.subscription.deleted. Idempotent. Writes no termination_reason - an ordinary cancellation is described by the cancellation_* columns - and withdraws no delivery the customer has already paid for.';


-- ══════════════════════════════════════════════════════════════
-- 8. PRIVILEGES
-- ══════════════════════════════════════════════════════════════
--
-- REVOKE FIRST, then grant back the one privilege that is wanted.
-- PostgreSQL grants EXECUTE on a new function to PUBLIC by default, so
-- without the revokes below anon and authenticated would hold it.
--
-- NO TABLE PRIVILEGE IS GRANTED IN THIS FILE. service_role keeps SELECT
-- and only SELECT; the write authority is the definer's and is reached
-- only through EXECUTE on these six functions.

revoke all on function public.request_b2b_monthly_quantity_change(uuid, uuid, integer) from public;
revoke all on function public.request_b2b_monthly_quantity_change(uuid, uuid, integer) from anon;
revoke all on function public.request_b2b_monthly_quantity_change(uuid, uuid, integer) from authenticated;

revoke all on function public.apply_b2b_monthly_quantity_change(uuid) from public;
revoke all on function public.apply_b2b_monthly_quantity_change(uuid) from anon;
revoke all on function public.apply_b2b_monthly_quantity_change(uuid) from authenticated;

revoke all on function public.request_b2b_monthly_cancellation(uuid, uuid, timestamptz, text) from public;
revoke all on function public.request_b2b_monthly_cancellation(uuid, uuid, timestamptz, text) from anon;
revoke all on function public.request_b2b_monthly_cancellation(uuid, uuid, timestamptz, text) from authenticated;

revoke all on function public.reconcile_b2b_monthly_cancellation(uuid, timestamptz) from public;
revoke all on function public.reconcile_b2b_monthly_cancellation(uuid, timestamptz) from anon;
revoke all on function public.reconcile_b2b_monthly_cancellation(uuid, timestamptz) from authenticated;

revoke all on function public.b2b_monthly_agreement_for_subscription(text) from public;
revoke all on function public.b2b_monthly_agreement_for_subscription(text) from anon;
revoke all on function public.b2b_monthly_agreement_for_subscription(text) from authenticated;

revoke all on function public.settle_b2b_monthly_cancelled_subscription(text) from public;
revoke all on function public.settle_b2b_monthly_cancelled_subscription(text) from anon;
revoke all on function public.settle_b2b_monthly_cancelled_subscription(text) from authenticated;

grant execute on function public.request_b2b_monthly_quantity_change(uuid, uuid, integer) to service_role;
grant execute on function public.apply_b2b_monthly_quantity_change(uuid) to service_role;
grant execute on function public.request_b2b_monthly_cancellation(uuid, uuid, timestamptz, text) to service_role;
grant execute on function public.reconcile_b2b_monthly_cancellation(uuid, timestamptz) to service_role;
grant execute on function public.b2b_monthly_agreement_for_subscription(text) to service_role;
grant execute on function public.settle_b2b_monthly_cancelled_subscription(text) to service_role;


-- ══════════════════════════════════════════════════════════════
-- 9. WHAT TO VERIFY AFTER APPLYING
-- ══════════════════════════════════════════════════════════════
--
--   select p.proname, p.prosecdef, p.proconfig
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public'
--      and p.proname in ('request_b2b_monthly_quantity_change',
--                        'apply_b2b_monthly_quantity_change',
--                        'request_b2b_monthly_cancellation',
--                        'reconcile_b2b_monthly_cancellation',
--                        'b2b_monthly_agreement_for_subscription',
--                        'settle_b2b_monthly_cancelled_subscription');
--   -- expect: six rows, all prosecdef = t, all {search_path=""}
--
--   select table_name, grantee, privilege_type
--     from information_schema.role_table_grants
--    where table_schema = 'public'
--      and table_name in ('b2b_supply_agreements', 'b2b_supply_items',
--                         'b2b_payment_schedule', 'b2b_deliveries')
--      and privilege_type in ('INSERT', 'UPDATE', 'DELETE');
--   -- expect: ZERO ROWS.
--
--   select column_name from information_schema.columns
--    where table_schema = 'public' and table_name = 'b2b_supply_agreements'
--      and column_name like 'pending_quantity%';
--   -- expect: pending_quantity_packs, pending_quantity_requested_at

commit;
