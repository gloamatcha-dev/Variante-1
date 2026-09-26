-- ══════════════════════════════════════════════════════════════
-- 063 — B2B RUNTIME: LATER INSTALMENTS, DELIVERY RESOLUTION, HOLDS
--
-- 061 created the pending agreement and 062 activated it. 063 is the
-- rest of the runtime those two deferred, and it is EIGHT NARROW
-- WRITERS rather than one:
--
--   Package 5D  b2b_annual_instalments_due          the work list
--               b2b_annual_instalments_unfinalized     the recovery list
--               record_b2b_annual_instalment_invoice   scheduled -> invoiced
--               settle_b2b_annual_paid_instalment      -> paid
--               record_b2b_annual_instalment_failure   -> payment_failed
--   Package 5E  resolve_b2b_delivery                   slot -> routed
--   Package 5F  hold_b2b_deliveries_for_payment        scheduled -> held
--               release_b2b_deliveries_after_payment   held -> scheduled
--
-- Narrow because each one is a different question with a different
-- replay key, and a single writer taking a mode would be one body the
-- reviewer has to hold four contracts in mind to read.
--
-- ── THE PRIVILEGE POSTURE IS UNCHANGED ────────────────────────
--
-- No table privilege is granted or revoked here, exactly as in 061 and
-- 062. service_role keeps SELECT and only SELECT on all four commerce
-- tables; the write authority is the definer's, reached only through
-- EXECUTE. RLS, policies, columns, indexes and constraints are all
-- untouched, and 001-062 are not referenced except to read.
--
-- ── WHAT 063 DELIBERATELY DOES NOT DO ─────────────────────────
--
--   NO Stripe call, no invoice creation. The SERVER creates the Stripe
--      invoice; this file records the correlation it comes back with.
--   NO customer shipping price and NO shipping VAT. Neither is approved,
--      so b2b_deliveries.customer_shipping_*_cents stay NULL for every
--      route except Berlin, where the approved price is zero.
--   NO parcel dimension, tare or weight. The DHL route cannot be
--      resolved until those are measured, and this file refuses to store
--      a route that was not.
--   NO dispatch, no tracking, no order, no delivery ROW creation. 062
--      created every slot an agreement will ever have; 063 only fills
--      them in.
--   NO cancellation, termination or contract end. A payment failure
--      holds deliveries and leaves the contract standing.
--   NO action_required transition - see section 4.
--
-- ── WHAT search_path = '' DOES AND DOES NOT REQUIRE ───────────
--
-- Every FUNCTION and TABLE is schema-qualified. COALESCE, NULLIF, CASE,
-- GREATEST and LEAST are SQL SYNTAX rather than functions and CANNOT be
-- qualified: `pg_catalog.greatest(...)` is a parse error, not a safer
-- spelling. btrim, count, max, now and jsonb_build_object are real
-- functions and are qualified. The two categories look identical in a
-- text editor and only a real PostgreSQL tells them apart, which is why
-- this file is applied to one before it is reviewed.
-- ══════════════════════════════════════════════════════════════

begin;


-- ══════════════════════════════════════════════════════════════
-- 1. THE WORK LIST: WHICH ANNUAL INSTALMENTS ARE DUE
-- ══════════════════════════════════════════════════════════════
--
-- ── THE DUE RULE, AND WHY IT NEVER CHARGES EARLY ──────────────
--
-- due_at <= now(). That is the whole rule, and it is deliberately not
-- widened by a "window".
--
-- The cron runs once a day (the Vercel Hobby plan permits one
-- invocation), so an instalment whose due_at falls at 03:00 is invoiced
-- at the next run rather than at the minute it matures. The consequence
-- is bounded and one-directional: an instalment may be invoiced UP TO
-- ONE CRON INTERVAL LATE, and can never be invoiced a single second
-- EARLY. Late is a business inconvenience; early is taking money before
-- it is owed, and only one of those is acceptable.
--
-- ── ONLY 2..n, AND ONLY 'scheduled' ───────────────────────────
--
-- Instalment 1 was settled by 062 at activation and is already 'paid';
-- it is excluded by instalment_number > 1 as well as by the status
-- filter, because two independent reasons are better than one.
--
-- A row that already carries a Stripe invoice id is excluded too. That
-- is the crash-safety half: if the server created the invoice and died
-- before recording it, the deterministic Stripe idempotency key makes
-- the retry return the SAME invoice rather than a second one, and this
-- filter stops the row being picked up again once it is recorded.

create function public.b2b_annual_instalments_due(p_limit integer default 25)
returns table (
  agreement_id      uuid,
  payment_id        uuid,
  instalment_number smallint,
  net_cents         integer,
  due_at            timestamptz,
  user_id           uuid,
  currency          text
)
language sql
stable
security definer
set search_path = ''
as $$
  select a.id, p.id, p.instalment_number, p.net_cents, p.due_at, a.user_id, a.currency
    from public.b2b_payment_schedule p
    join public.b2b_supply_agreements a on a.id = p.supply_agreement_id
   where a.plan_type = 'annual'
     and a.status = 'active'
     and p.status = 'scheduled'
     and p.instalment_number > 1
     and p.stripe_invoice_id is null
     and p.due_at <= pg_catalog.now()
     and a.user_id is not null
   order by p.due_at, p.instalment_number
   limit least(greatest(p_limit, 1), 200);
$$;

comment on function public.b2b_annual_instalments_due(integer) is
  'Package 5D. The bounded work list of annual instalments 2..n that are due (due_at <= now()) and not yet invoiced. Read-only: it claims nothing and mutates nothing. Never returns instalment 1, which migration 062 settles at activation.';


-- ══════════════════════════════════════════════════════════════
-- 1b. THE RECOVERY LIST: CORRELATED BUT NOT YET COLLECTING
-- ══════════════════════════════════════════════════════════════
--
-- ── THE CRASH WINDOW THIS EXISTS TO CLOSE ─────────────────────
--
-- Section 1 deliberately stops offering a row once it carries a Stripe
-- invoice id, because re-offering it would risk a second invoice for one
-- instalment. That is right, and on its own it left a hole: the server
-- creates a DRAFT invoice, records the correlation, and dies before
-- finalizing. The row now says 'invoiced', the money is owed, the draft
-- has collected nothing - and no code path would ever look at it again.
--
-- So this is a SECOND read over exactly that population: status
-- 'invoiced' with an invoice id. The caller retrieves that invoice from
-- Stripe and brings it to the intended state; it never creates one.
--
-- ── AND THE ROW IS NEVER MOVED BACK TO 'scheduled' ────────────
--
-- That would be the obvious repair and the wrong one. 'scheduled' means
-- "no Stripe object exists for this instalment", so a row whose
-- stripe_invoice_id is set would become eligible for a SECOND invoice the
-- moment section 1 saw it. The status stays where it is and the recovery
-- reads it from here instead.
--
-- 'payment_failed' and 'action_required' are deliberately NOT included: a
-- row in either state has a finalized invoice that Stripe is already
-- dunning, so there is nothing to finalize and nothing for this pass to
-- do. 'paid' and 'void' are terminal.

create function public.b2b_annual_instalments_unfinalized(p_limit integer default 25)
returns table (
  agreement_id      uuid,
  payment_id        uuid,
  instalment_number smallint,
  net_cents         integer,
  due_at            timestamptz,
  user_id           uuid,
  currency          text,
  stripe_invoice_id text
)
language sql
stable
security definer
set search_path = ''
as $$
  select a.id, p.id, p.instalment_number, p.net_cents, p.due_at, a.user_id, a.currency,
         p.stripe_invoice_id
    from public.b2b_payment_schedule p
    join public.b2b_supply_agreements a on a.id = p.supply_agreement_id
   where a.plan_type = 'annual'
     and a.status = 'active'
     and p.status = 'invoiced'
     and p.instalment_number > 1
     and p.stripe_invoice_id is not null
     and a.user_id is not null
   order by p.due_at, p.instalment_number
   limit least(greatest(p_limit, 1), 200);
$$;

comment on function public.b2b_annual_instalments_unfinalized(integer) is
  'Package 5D. The bounded list of annual instalments whose Stripe invoice is correlated but may not have reached collection - status invoiced with an invoice id. Read-only. The caller retrieves that exact invoice and finalizes it; it never creates one, and the row is never returned to scheduled because that would make a second invoice possible.';


-- ══════════════════════════════════════════════════════════════
-- 2. RECORDING THE INVOICE: scheduled -> invoiced
-- ══════════════════════════════════════════════════════════════
--
-- ── THE CALLER BRINGS AN ID, NOT AN AMOUNT ────────────────────
--
-- The Stripe invoice id and nothing else. Every figure is derived here
-- from the row's own frozen net_cents, using the net-origin expression
-- 060's b2b_payment_schedule_gross_formula_check validates:
--
--   gross = (2 * (net * 107) + 100) / 200
--   tax   = gross - net
--
-- so the tax is the REMAINDER of one rounding and net + tax = gross is
-- exact. 060 requires ALL FIVE tax facts once a row leaves 'scheduled',
-- which is why they are written in the same statement as the status.
--
-- ── IDEMPOTENCY IS THE UNIQUE INDEX ───────────────────────────
--
-- 060 created b2b_payment_schedule_stripe_invoice_id_key, a partial
-- UNIQUE. A replay carrying the same invoice id finds the row already
-- recorded and returns 'already_invoiced'; a DIFFERENT invoice id for a
-- row that already has one is refused outright rather than overwriting
-- the correlation to a charge that may already have been collected.

create function public.record_b2b_annual_instalment_invoice(
  p_agreement_id      uuid,
  p_instalment_number smallint,
  p_stripe_invoice_id text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_agreement public.b2b_supply_agreements;
  v_payment   public.b2b_payment_schedule;
  v_invoice   text;
  v_net       bigint;
  v_gross     bigint;
  v_tax       bigint;
begin
  v_invoice := nullif(pg_catalog.btrim(coalesce(p_stripe_invoice_id, '')), '');
  if p_agreement_id is null or p_instalment_number is null or v_invoice is null then
    return pg_catalog.jsonb_build_object('result', 'invalid_input');
  end if;

  select * into v_agreement
  from public.b2b_supply_agreements where id = p_agreement_id for update;
  if not found then
    return pg_catalog.jsonb_build_object('result', 'agreement_not_found');
  end if;
  if v_agreement.plan_type is distinct from 'annual' or v_agreement.status <> 'active' then
    return pg_catalog.jsonb_build_object('result', 'agreement_not_active_annual',
      'plan_type', v_agreement.plan_type, 'status', v_agreement.status);
  end if;

  select * into v_payment
  from public.b2b_payment_schedule
  where supply_agreement_id = p_agreement_id
    and instalment_number = p_instalment_number
  for update;
  if not found then
    return pg_catalog.jsonb_build_object('result', 'instalment_not_found');
  end if;

  -- Instalment 1 is 062's, settled at activation. It is never invoiced.
  if v_payment.instalment_number <= 1 then
    return pg_catalog.jsonb_build_object('result', 'instalment_one_is_not_invoiced');
  end if;

  -- ── ALREADY CORRELATED? ──────────────────────────────────────
  if v_payment.stripe_invoice_id is not null then
    if v_payment.stripe_invoice_id = v_invoice then
      return pg_catalog.jsonb_build_object('result', 'already_invoiced',
        'payment_id', v_payment.id, 'status', v_payment.status);
    end if;
    -- A SECOND invoice for one instalment would be a second charge.
    return pg_catalog.jsonb_build_object('result', 'invoice_conflict',
      'existing_stripe_invoice_id', v_payment.stripe_invoice_id);
  end if;

  if v_payment.status <> 'scheduled' then
    return pg_catalog.jsonb_build_object('result', 'instalment_not_scheduled',
      'status', v_payment.status);
  end if;

  if v_payment.due_at > pg_catalog.now() then
    -- NEVER EARLY. See section 1.
    return pg_catalog.jsonb_build_object('result', 'not_due_yet', 'due_at', v_payment.due_at);
  end if;

  v_net   := v_payment.net_cents::bigint;
  v_gross := (2 * (v_net * 107) + 100) / 200;
  v_tax   := v_gross - v_net;

  update public.b2b_payment_schedule
     set status                  = 'invoiced',
         invoiced_at             = pg_catalog.now(),
         stripe_invoice_id       = v_invoice,
         tax_rate_percent        = 7,
         tax_cents               = v_tax::integer,
         gross_cents             = v_gross::integer,
         tax_calculation_version = 'de-net-2026.1',
         price_origin            = 'net'
   where id = v_payment.id;

  return pg_catalog.jsonb_build_object(
    'result', 'invoiced',
    'payment_id', v_payment.id,
    'instalment_number', v_payment.instalment_number,
    'net_cents', v_net::integer,
    'tax_cents', v_tax::integer,
    'gross_cents', v_gross::integer
  );
end;
$$;

comment on function public.record_b2b_annual_instalment_invoice(uuid, smallint, text) is
  'Package 5D. Records the Stripe invoice for one due annual instalment 2..n and moves it scheduled -> invoiced, deriving the net-origin 7% tax facts itself. Takes no amount. Idempotent on the invoice id; a different invoice for an already-correlated instalment is refused.';


-- ══════════════════════════════════════════════════════════════
-- 3. SETTLEMENT: invoiced -> paid
-- ══════════════════════════════════════════════════════════════
--
-- Resolved BY THE STRIPE INVOICE ID, which is unique across the table,
-- so the caller cannot settle the wrong instalment even if it passes the
-- wrong agreement - the agreement is checked against the row that the
-- invoice actually belongs to.
--
-- IT CREATES NO DELIVERY. An annual agreement received all twelve slots
-- at activation; a later instalment pays for deliveries that already
-- exist. This is the single most important difference from the monthly
-- settlement in 062, and it is why the two are separate functions.

create function public.settle_b2b_annual_paid_instalment(
  p_agreement_id             uuid,
  p_stripe_invoice_id        text,
  p_stripe_payment_intent_id text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_payment public.b2b_payment_schedule;
  v_invoice text;
  v_intent  text;
  v_now     timestamptz;
begin
  v_invoice := nullif(pg_catalog.btrim(coalesce(p_stripe_invoice_id, '')), '');
  v_intent  := nullif(pg_catalog.btrim(coalesce(p_stripe_payment_intent_id, '')), '');
  if p_agreement_id is null or v_invoice is null then
    return pg_catalog.jsonb_build_object('result', 'invalid_input');
  end if;

  select * into v_payment
  from public.b2b_payment_schedule where stripe_invoice_id = v_invoice for update;
  if not found then
    return pg_catalog.jsonb_build_object('result', 'instalment_not_found');
  end if;
  if v_payment.supply_agreement_id is distinct from p_agreement_id then
    return pg_catalog.jsonb_build_object('result', 'agreement_mismatch');
  end if;

  if v_payment.status = 'paid' then
    return pg_catalog.jsonb_build_object('result', 'already_settled',
      'payment_id', v_payment.id, 'instalment_number', v_payment.instalment_number);
  end if;
  if v_payment.status = 'void' then
    return pg_catalog.jsonb_build_object('result', 'instalment_void');
  end if;

  v_now := pg_catalog.now();

  -- The tax facts were established at invoicing and are NOT recomputed:
  -- what was invoiced is what was charged. They are only filled in if a
  -- settlement somehow arrives for a row that never went through
  -- section 2, which 060 would otherwise refuse for a 'paid' row.
  update public.b2b_payment_schedule
     set status                  = 'paid',
         paid_at                 = v_now,
         stripe_payment_intent_id = coalesce(v_intent, stripe_payment_intent_id),
         tax_rate_percent        = coalesce(tax_rate_percent, 7),
         tax_cents               = coalesce(tax_cents, ((2 * (net_cents::bigint * 107) + 100) / 200
                                                          - net_cents::bigint)::integer),
         gross_cents             = coalesce(gross_cents, ((2 * (net_cents::bigint * 107) + 100) / 200)::integer),
         tax_calculation_version = coalesce(tax_calculation_version, 'de-net-2026.1'),
         price_origin            = coalesce(price_origin, 'net'),
         invoiced_at             = coalesce(invoiced_at, v_now)
   where id = v_payment.id;

  return pg_catalog.jsonb_build_object(
    'result', 'settled',
    'payment_id', v_payment.id,
    'instalment_number', v_payment.instalment_number
  );
end;
$$;

comment on function public.settle_b2b_annual_paid_instalment(uuid, text, text) is
  'Package 5D. Marks one annual instalment paid, resolved by its unique Stripe invoice id. Creates NO delivery: an annual agreement already owns all twelve slots. Idempotent - a replay answers already_settled.';


-- ══════════════════════════════════════════════════════════════
-- 4. FAILURE: -> payment_failed
-- ══════════════════════════════════════════════════════════════
--
-- ── STRIPE DUNNING STAYS AUTHORITATIVE ────────────────────────
--
-- This records a fact; it does not decide a retry. The invoice remains
-- open in Stripe, Smart Retries keep running, and a later success comes
-- back through section 3 - 060's transition graph admits
-- payment_failed -> paid precisely so that recovery needs no special
-- case here.
--
-- ── AND action_required IS DELIBERATELY NOT WRITTEN ───────────
--
-- 060 has the state, and it is the right state for an invoice waiting on
-- SCA. But invoice.payment_failed does not carry authoritative evidence
-- that the customer specifically must act: the same event covers an
-- expired card, insufficient funds and a bank decline, none of which the
-- customer can resolve by authenticating. Inferring action_required from
-- a failure would put a row into a state that tells the customer to do
-- something they cannot do.
--
-- The authoritative signals are elsewhere - the invoice's
-- payment_intent.status of 'requires_action', or the
-- invoice.payment_action_required event, neither of which this package
-- subscribes to. So action_required is DEFERRED, payment_failed is
-- written, and 060 keeps the state ready for the package that adds the
-- event. The transition graph already admits payment_failed ->
-- action_required, so nothing has to be undone later.
--
-- NO CONTRACT CHANGE. The agreement is not read for update, not
-- cancelled, not terminated and not ended. A failed payment holds
-- deliveries (section 6) and leaves the contract standing.

create function public.record_b2b_annual_instalment_failure(
  p_agreement_id      uuid,
  p_stripe_invoice_id text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_payment public.b2b_payment_schedule;
  v_invoice text;
begin
  v_invoice := nullif(pg_catalog.btrim(coalesce(p_stripe_invoice_id, '')), '');
  if p_agreement_id is null or v_invoice is null then
    return pg_catalog.jsonb_build_object('result', 'invalid_input');
  end if;

  select * into v_payment
  from public.b2b_payment_schedule where stripe_invoice_id = v_invoice for update;
  if not found then
    return pg_catalog.jsonb_build_object('result', 'instalment_not_found');
  end if;
  if v_payment.supply_agreement_id is distinct from p_agreement_id then
    return pg_catalog.jsonb_build_object('result', 'agreement_mismatch');
  end if;

  -- Terminal states are facts. A failure notice arriving after the money
  -- settled does not un-settle it.
  if v_payment.status in ('paid', 'void') then
    return pg_catalog.jsonb_build_object('result', 'instalment_terminal',
      'status', v_payment.status);
  end if;
  if v_payment.status = 'payment_failed' then
    return pg_catalog.jsonb_build_object('result', 'already_failed',
      'payment_id', v_payment.id, 'instalment_number', v_payment.instalment_number);
  end if;

  update public.b2b_payment_schedule
     set status    = 'payment_failed',
         failed_at = pg_catalog.now()
   where id = v_payment.id;

  return pg_catalog.jsonb_build_object(
    'result', 'failed',
    'payment_id', v_payment.id,
    'instalment_number', v_payment.instalment_number
  );
end;
$$;

comment on function public.record_b2b_annual_instalment_failure(uuid, text) is
  'Package 5F. Moves one annual instalment to payment_failed, resolved by its unique Stripe invoice id. Writes no contract change: Stripe dunning keeps retrying and 060 admits payment_failed -> paid for the recovery. Never writes action_required - invoice.payment_failed is not authoritative evidence that the customer must act.';


-- ══════════════════════════════════════════════════════════════
-- 5. DELIVERY RESOLUTION: A SLOT BECOMES A ROUTE
-- ══════════════════════════════════════════════════════════════
--
-- ── THE ONE-WAY DOOR, OPENED EXACTLY ONCE ─────────────────────
--
-- 060 section 7: resolved_at is the discriminator. A slot freezes
-- nothing; a resolved delivery has all four routing facts and is frozen
-- from then on by b2b_deliveries_resolution_freeze. This function is the
-- only thing that opens that door, and it refuses to touch a row that
-- has already been through it - which is what makes an address change
-- affect the NEXT unresolved delivery and never rewrite a past one.
--
-- ── THE CALLER BRINGS SNAPSHOTS, NOT DECISIONS ────────────────
--
-- The two snapshots are the verbatim output of the canonical resolvers
-- (lib/b2bBerlinEligibility.ts and lib/b2bShippingRules.ts), which run
-- on the server. This function does not re-derive routing - it could
-- not; the tariff tables are TypeScript - but 060's own CHECK
-- constraints validate the SHAPE of both, and the two rules below
-- validate the only things that can be checked here and matter most:
--
--   1. a Berlin route is free. customer_shipping_* is 0/0/0 and the
--      class is berlin_local. That is the one approved customer shipping
--      price in the system.
--   2. EVERY OTHER ROUTE IS REFUSED. No packed weight, no carton and no
--      approved customer shipping charge or VAT treatment exists for
--      DHL, so a dhl class arriving here is a route somebody computed
--      from facts nobody has approved. It is rejected rather than
--      stored, and the delivery stays an unresolved slot - which 060
--      already makes undispatchable.
--
-- Rule 2 is TEMPORARY and is the only thing standing between this
-- function and nationwide self-service. It comes out when the
-- measurement and the shipping price are approved, and nothing else in
-- this file changes when it does.

create function public.resolve_b2b_delivery(
  p_delivery_id                 uuid,
  p_delivery_address_snapshot   jsonb,
  p_berlin_eligibility_snapshot jsonb,
  p_shipping_class              text,
  p_shipping_snapshot           jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_delivery public.b2b_deliveries;
begin
  if p_delivery_id is null
     or p_delivery_address_snapshot is null
     or p_berlin_eligibility_snapshot is null
     or p_shipping_class is null
     or p_shipping_snapshot is null
  then
    return pg_catalog.jsonb_build_object('result', 'invalid_input');
  end if;

  if pg_catalog.jsonb_typeof(p_delivery_address_snapshot) <> 'object'
     or pg_catalog.jsonb_typeof(p_berlin_eligibility_snapshot) <> 'object'
     or pg_catalog.jsonb_typeof(p_shipping_snapshot) <> 'object'
  then
    return pg_catalog.jsonb_build_object('result', 'invalid_snapshot_shape');
  end if;

  -- ── RULE 2, BEFORE ANY LOCK: only Berlin resolves today. ─────
  if p_shipping_class <> 'berlin_local' then
    return pg_catalog.jsonb_build_object('result', 'shipping_not_yet_supported',
      'shipping_class', p_shipping_class);
  end if;
  if p_berlin_eligibility_snapshot->>'eligible' is distinct from 'true' then
    return pg_catalog.jsonb_build_object('result', 'not_berlin_eligible');
  end if;
  if p_shipping_snapshot->>'chargeStatus' is distinct from 'free_local_delivery' then
    return pg_catalog.jsonb_build_object('result', 'shipping_not_yet_supported',
      'charge_status', p_shipping_snapshot->>'chargeStatus');
  end if;

  select * into v_delivery
  from public.b2b_deliveries where id = p_delivery_id for update;
  if not found then
    return pg_catalog.jsonb_build_object('result', 'delivery_not_found');
  end if;

  -- ── ALREADY RESOLVED IS THE IDEMPOTENT ANSWER ────────────────
  --
  -- Never an overwrite. The freeze guard would raise, and raising is a
  -- worse answer than reporting for a caller that is simply retrying.
  if v_delivery.resolved_at is not null then
    return pg_catalog.jsonb_build_object(
      'result', 'already_resolved',
      'delivery_id', v_delivery.id,
      'shipping_class', v_delivery.shipping_class,
      'resolved_at', v_delivery.resolved_at
    );
  end if;

  -- A held or terminal delivery is not routed. Holding is 5F's, and a
  -- cancelled or delivered row has nothing left to decide.
  if v_delivery.status <> 'scheduled' then
    return pg_catalog.jsonb_build_object('result', 'delivery_not_schedulable',
      'status', v_delivery.status);
  end if;

  update public.b2b_deliveries
     set delivery_address_snapshot   = p_delivery_address_snapshot,
         berlin_eligibility_snapshot = p_berlin_eligibility_snapshot,
         shipping_class              = 'berlin_local',
         shipping_snapshot           = p_shipping_snapshot,
         resolved_at                 = pg_catalog.now(),
         -- THE ONE APPROVED CUSTOMER SHIPPING PRICE: Berlin is free.
         -- Zero here is a price, not a placeholder; every other route is
         -- refused above precisely so that no other zero is ever stored.
         customer_shipping_net_cents   = 0,
         customer_shipping_tax_cents   = 0,
         customer_shipping_gross_cents = 0
   where id = v_delivery.id;

  return pg_catalog.jsonb_build_object(
    'result', 'resolved',
    'delivery_id', v_delivery.id,
    'delivery_number', v_delivery.delivery_number,
    'shipping_class', 'berlin_local'
  );
end;
$$;

comment on function public.resolve_b2b_delivery(uuid, jsonb, jsonb, text, jsonb) is
  'Package 5E. Routes one UNRESOLVED delivery slot, once. Today only the Berlin free-local-delivery route is accepted: no packed measurement, customer shipping charge or shipping VAT is approved for DHL, so any other class is refused and the slot stays unresolved. Idempotent - an already-resolved delivery is returned untouched and never rewritten.';


-- ══════════════════════════════════════════════════════════════
-- 6. HOLD AND RELEASE
-- ══════════════════════════════════════════════════════════════
--
-- ── ONE MACHINE-READABLE REASON, SO RELEASE IS DETERMINISTIC ──
--
-- 060 requires a hold_reason and bounds it to 1..500 characters, but
-- says nothing about its vocabulary - which means a release that matched
-- loosely could clear a hold an operator placed by hand. So this package
-- owns exactly one namespaced token and releases ONLY that token:
--
--   'b2b:payment_failed'
--
-- Anything else in hold_reason - an operator note, a future package's
-- reason - is invisible to the release below and survives it.
--
-- ── WHAT IS HELD ──────────────────────────────────────────────
--
-- UNRESOLVED, SCHEDULED deliveries only. A resolved delivery has been
-- routed and may already be in a picking list, and a dispatched one has
-- left; neither is this function's to reverse. That also keeps the hold
-- aligned with what a payment failure actually threatens - future
-- supply, not supply already on its way.

create function public.hold_b2b_deliveries_for_payment(p_agreement_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_agreement public.b2b_supply_agreements;
  v_held      integer;
begin
  if p_agreement_id is null then
    return pg_catalog.jsonb_build_object('result', 'invalid_input');
  end if;

  select * into v_agreement
  from public.b2b_supply_agreements where id = p_agreement_id for update;
  if not found then
    return pg_catalog.jsonb_build_object('result', 'agreement_not_found');
  end if;
  if v_agreement.plan_type is null then
    return pg_catalog.jsonb_build_object('result', 'not_a_self_service_agreement');
  end if;

  -- THE CONTRACT IS NOT TOUCHED. No status, no ended_at, no termination.
  with held as (
    update public.b2b_deliveries
       set status      = 'held',
           hold_reason = 'b2b:payment_failed'
     where supply_agreement_id = p_agreement_id
       and status = 'scheduled'
       and resolved_at is null
    returning 1
  )
  select pg_catalog.count(*)::integer into v_held from held;

  return pg_catalog.jsonb_build_object(
    'result', 'held', 'agreement_id', p_agreement_id, 'held', v_held);
end;
$$;

comment on function public.hold_b2b_deliveries_for_payment(uuid) is
  'Package 5F. Holds every UNRESOLVED scheduled delivery of one agreement with the reason b2b:payment_failed. Touches no resolved or dispatched delivery and makes no contract change - the agreement stays active and Stripe keeps dunning. Idempotent: an already-held delivery is not re-held.';


create function public.release_b2b_deliveries_after_payment(p_agreement_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_open     integer;
  v_released integer;
begin
  if p_agreement_id is null then
    return pg_catalog.jsonb_build_object('result', 'invalid_input');
  end if;

  -- ── RELEASE ONLY WHEN NOTHING IS STILL OWED ──────────────────
  --
  -- An annual agreement can have several instalments outstanding. One of
  -- them recovering does not mean the contract is current, so the hold
  -- stays until no instalment is in payment_failed or action_required.
  -- A monthly agreement has no payment rows at all, so this count is
  -- zero and the first recovered invoice releases it.
  select pg_catalog.count(*)::integer into v_open
    from public.b2b_payment_schedule
   where supply_agreement_id = p_agreement_id
     and status in ('payment_failed', 'action_required');

  if v_open > 0 then
    return pg_catalog.jsonb_build_object('result', 'still_owed',
      'agreement_id', p_agreement_id, 'open_instalments', v_open);
  end if;

  -- ONLY THIS PACKAGE'S OWN REASON. An operator hold, or a reason a
  -- future package introduces, is left exactly where it is.
  with released as (
    update public.b2b_deliveries
       set status      = 'scheduled',
           hold_reason = null
     where supply_agreement_id = p_agreement_id
       and status = 'held'
       and hold_reason = 'b2b:payment_failed'
    returning 1
  )
  select pg_catalog.count(*)::integer into v_released from released;

  return pg_catalog.jsonb_build_object(
    'result', 'released', 'agreement_id', p_agreement_id, 'released', v_released);
end;
$$;

comment on function public.release_b2b_deliveries_after_payment(uuid) is
  'Package 5F. Releases deliveries held by this package, and ONLY those: the match is the exact reason b2b:payment_failed, so an operator hold survives. Refuses while any instalment is still payment_failed or action_required.';


-- ══════════════════════════════════════════════════════════════
-- 7. FUNCTION PRIVILEGES
-- ══════════════════════════════════════════════════════════════
--
-- REVOKE FROM public FIRST, then the named browser roles, then grant
-- EXECUTE to service_role alone - the shape 039 established and 061 and
-- 062 both follow. A freshly created function is executable by PUBLIC by
-- default and anon and authenticated inherit that.

revoke all on function public.b2b_annual_instalments_due(integer) from public;
revoke all on function public.b2b_annual_instalments_due(integer) from anon;
revoke all on function public.b2b_annual_instalments_due(integer) from authenticated;
grant execute on function public.b2b_annual_instalments_due(integer) to service_role;

revoke all on function public.b2b_annual_instalments_unfinalized(integer) from public;
revoke all on function public.b2b_annual_instalments_unfinalized(integer) from anon;
revoke all on function public.b2b_annual_instalments_unfinalized(integer) from authenticated;
grant execute on function public.b2b_annual_instalments_unfinalized(integer) to service_role;

revoke all on function public.record_b2b_annual_instalment_invoice(uuid, smallint, text) from public;
revoke all on function public.record_b2b_annual_instalment_invoice(uuid, smallint, text) from anon;
revoke all on function public.record_b2b_annual_instalment_invoice(uuid, smallint, text) from authenticated;
grant execute on function public.record_b2b_annual_instalment_invoice(uuid, smallint, text) to service_role;

revoke all on function public.settle_b2b_annual_paid_instalment(uuid, text, text) from public;
revoke all on function public.settle_b2b_annual_paid_instalment(uuid, text, text) from anon;
revoke all on function public.settle_b2b_annual_paid_instalment(uuid, text, text) from authenticated;
grant execute on function public.settle_b2b_annual_paid_instalment(uuid, text, text) to service_role;

revoke all on function public.record_b2b_annual_instalment_failure(uuid, text) from public;
revoke all on function public.record_b2b_annual_instalment_failure(uuid, text) from anon;
revoke all on function public.record_b2b_annual_instalment_failure(uuid, text) from authenticated;
grant execute on function public.record_b2b_annual_instalment_failure(uuid, text) to service_role;

revoke all on function public.resolve_b2b_delivery(uuid, jsonb, jsonb, text, jsonb) from public;
revoke all on function public.resolve_b2b_delivery(uuid, jsonb, jsonb, text, jsonb) from anon;
revoke all on function public.resolve_b2b_delivery(uuid, jsonb, jsonb, text, jsonb) from authenticated;
grant execute on function public.resolve_b2b_delivery(uuid, jsonb, jsonb, text, jsonb) to service_role;

revoke all on function public.hold_b2b_deliveries_for_payment(uuid) from public;
revoke all on function public.hold_b2b_deliveries_for_payment(uuid) from anon;
revoke all on function public.hold_b2b_deliveries_for_payment(uuid) from authenticated;
grant execute on function public.hold_b2b_deliveries_for_payment(uuid) to service_role;

revoke all on function public.release_b2b_deliveries_after_payment(uuid) from public;
revoke all on function public.release_b2b_deliveries_after_payment(uuid) from anon;
revoke all on function public.release_b2b_deliveries_after_payment(uuid) from authenticated;
grant execute on function public.release_b2b_deliveries_after_payment(uuid) to service_role;


-- ══════════════════════════════════════════════════════════════
-- 8. WHAT THIS MIGRATION DID NOT DO
-- ══════════════════════════════════════════════════════════════
--
--   NO create/alter/drop table, column, index, constraint or trigger
--   NO policy change, no RLS change
--   NO table privilege: not one grant, not one revoke, on any table
--   NO change to 001-062 or to anything they defined
--   NO delivery ROW creation - 062 created every slot
--   NO order, no dispatch, no tracking
--   NO cancellation or termination of any agreement
--   NO customer shipping price outside the approved Berlin zero
--   NO action_required transition - deferred, see section 4
--
-- ── READ-ONLY VERIFICATION ────────────────────────────────────
--
--   select p.proname, p.prosecdef, p.proconfig
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public' and p.proname in (
--      'b2b_annual_instalments_due', 'record_b2b_annual_instalment_invoice',
--      'settle_b2b_annual_paid_instalment', 'record_b2b_annual_instalment_failure',
--      'resolve_b2b_delivery', 'hold_b2b_deliveries_for_payment',
--      'release_b2b_deliveries_after_payment');
--   -- expect: seven rows, all prosecdef = t, all {search_path=""}
--
--   select table_name, grantee, privilege_type
--     from information_schema.role_table_grants
--    where table_schema = 'public'
--      and table_name in ('b2b_supply_agreements', 'b2b_supply_items',
--                         'b2b_payment_schedule', 'b2b_deliveries')
--      and privilege_type in ('INSERT', 'UPDATE', 'DELETE');
--   -- expect: ZERO ROWS.

commit;
