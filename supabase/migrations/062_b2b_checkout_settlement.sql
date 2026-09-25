-- ══════════════════════════════════════════════════════════════
-- 062 — B2B SELF-SERVICE: THE SETTLEMENT WRITE SURFACE
--
-- 061 created the PENDING agreement. 062 is what turns a proven payment
-- into an ACTIVE contract, and it is TWO NARROW WRITERS rather than one
-- mode-switching one:
--
--   activate_b2b_annual_from_payment   the annual first instalment
--   settle_b2b_monthly_paid_invoice    every paid monthly invoice
--
-- Two functions because the two plans settle on different Stripe
-- objects, produce different rows and have different replay keys. A
-- single writer taking a plan_type would have one body where every
-- second line is an if, and the reviewer would have to hold both
-- contracts at once to read either.
--
-- ── THE PRIVILEGE POSTURE IS UNCHANGED ────────────────────────
--
-- No table privilege is granted or revoked here, exactly as in 061.
-- service_role keeps SELECT and only SELECT on all four commerce tables;
-- the write authority is the definer's, reached only through EXECUTE.
-- RLS, policies, columns, indexes and constraints are all untouched.
--
-- ── WHAT COUNTS AS PAYMENT PROOF ──────────────────────────────
--
-- Not the caller's say-so. For ANNUAL it is that the agreement's own
-- checkout attempt is status 'paid', which in this system can only be
-- written by lib/checkoutAttempts.ts markAttemptPaid, which the webhook
-- reaches only after evaluateStripeSessionPayment has compared Stripe's
-- RE-READ amount_total and currency against that attempt's frozen
-- expected total. So a caller cannot activate a contract by asserting it
-- was paid; it can only activate one whose own frozen anchor already
-- says so. That is 039's rule, applied to B2B unchanged.
--
-- For MONTHLY the proof is the Stripe invoice id the caller carries,
-- which the webhook obtains by re-reading the invoice from Stripe, plus
-- the subscription correlation that must match what the agreement
-- already holds.
--
-- ── WHAT 062 DELIBERATELY DOES NOT DO ─────────────────────────
--
--   NO shipping resolution. Deliveries are created as UNRESOLVED SLOTS:
--      resolved_at, the address snapshot, the eligibility snapshot, the
--      shipping class and the shipping snapshot are all NULL. Package 5E
--      owns resolution, and 060 refuses to store a refusal as a route.
--   NO dispatch, no tracking, no order.
--   NO payment-failure or hold transition. Package 5F owns those, and
--      nothing here writes 'payment_failed', 'action_required' or 'held'.
--   NO invoicing of instalments 2..n. They are created 'scheduled' with
--      NULL tax facts; Package 5D invoices them.
--   NO payment_schedule row for a monthly agreement, ever. 060's
--      integrity assertion raises if an active monthly one has any.
--
-- ── FAIL CLOSED ───────────────────────────────────────────────
--
-- Plain CREATE FUNCTION, not CREATE OR REPLACE, for both.
--
-- ── WHAT search_path = '' DOES AND DOES NOT REQUIRE ───────────
--
-- Every FUNCTION and every TABLE below is schema-qualified, because an
-- empty search_path resolves neither. COALESCE, NULLIF and CASE are NOT
-- functions - they are SQL syntax, like an operator - so they resolve
-- whatever the search_path is and CANNOT be qualified:
-- `pg_catalog.coalesce(...)` is a parse error, not a safer spelling.
-- btrim, max, make_interval, now and jsonb_build_object are real
-- functions and are qualified. Found by applying this file to a real
-- PostgreSQL 17 cluster, which is the only thing that can tell the two
-- categories apart.
-- ══════════════════════════════════════════════════════════════

begin;


-- ══════════════════════════════════════════════════════════════
-- 1. ANNUAL: ONE PAYMENT BECOMES A TWELVE-MONTH CONTRACT
-- ══════════════════════════════════════════════════════════════
--
-- ── THE MONEY IS DERIVED, NOT ACCEPTED ────────────────────────
--
-- The caller passes correlation identifiers and NOTHING ELSE. Every
-- amount is computed here from the agreement's own frozen
-- contract_product_net_cents and instalment_count, using the same
-- allocation lib/b2bPricingRules.ts allocateInstalments performs:
--
--   base = floor(T / n)
--   instalments 1 .. n-1   base
--   instalment  n          T - base * (n - 1)
--
-- The remainder lands on the LAST instalment, so the customer's FIRST
-- payment is the one quoted on the page. 060's
-- assert_b2b_commerce_integrity re-derives this per row at COMMIT, so a
-- drift between this function and that assertion is a failed transaction
-- rather than a wrong schedule.
--
-- The tax on instalment 1 is the net-origin result of lib/tax.ts
-- addTaxToNet(net, 7), written as the integer expression 060's
-- b2b_payment_schedule_gross_formula_check uses:
--
--   gross = (2 * (net * 107) + 100) / 200
--   tax   = gross - net
--
-- so the tax is the REMAINDER of one rounding rather than a second
-- independently rounded figure, which is what makes net + tax = gross
-- exact for every input.
--
-- ── THE DATES ─────────────────────────────────────────────────
--
-- One activation instant, read once into v_now so every derived date in
-- this transaction agrees:
--
--   started_at         v_now
--   commitment_end_at  v_now + 12 months
--   delivery k         v_now + (k - 1) months, k = 1 .. 12
--   instalment j       v_now + (j - 1) * (12 / n) months
--                      n=1 -> only j=1; n=2 -> 0, 6; n=4 -> 0, 3, 6, 9
--
-- `interval '1 month'` is calendar-correct: it lands on the same day of
-- the following month and clamps at a short month end, which is what a
-- monthly supply contract means. Multiplying an interval by an integer
-- is exact for months.

create function public.activate_b2b_annual_from_payment(
  p_agreement_id             uuid,
  p_checkout_attempt_id      uuid,
  p_stripe_payment_intent_id text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_agreement public.b2b_supply_agreements;
  v_attempt   public.checkout_attempts;
  v_now       timestamptz;
  v_n         integer;
  v_total     integer;
  v_base      bigint;
  v_net       bigint;
  v_gross     bigint;
  v_tax       bigint;
  v_spacing   integer;
  v_i         integer;
  v_pay_rows  integer;
  v_del_rows  integer;
begin
  if p_agreement_id is null or p_checkout_attempt_id is null then
    return pg_catalog.jsonb_build_object('result', 'invalid_input');
  end if;

  -- THE LOCK, FIRST. Two concurrent deliveries of the same Stripe event
  -- must not both reach the inserts believing they are the first.
  select * into v_agreement
  from public.b2b_supply_agreements
  where id = p_agreement_id
  for update;

  if not found then
    return pg_catalog.jsonb_build_object('result', 'agreement_not_found');
  end if;

  if v_agreement.plan_type is distinct from 'annual' then
    return pg_catalog.jsonb_build_object('result', 'not_an_annual_agreement',
      'plan_type', v_agreement.plan_type);
  end if;

  -- THE CORRELATION. The agreement must be the one this attempt minted.
  if v_agreement.checkout_attempt_id is distinct from p_checkout_attempt_id then
    return pg_catalog.jsonb_build_object('result', 'attempt_mismatch');
  end if;

  -- ── ALREADY SETTLED? The idempotent answer, BEFORE any write. ──
  --
  -- Reached by a redelivery of checkout.session.completed, by
  -- async_payment_succeeded arriving after it, or by either arriving
  -- twice. All four orders converge here.
  if v_agreement.status = 'active' then
    select count(*) into v_pay_rows
      from public.b2b_payment_schedule where supply_agreement_id = p_agreement_id;
    select count(*) into v_del_rows
      from public.b2b_deliveries where supply_agreement_id = p_agreement_id;
    return pg_catalog.jsonb_build_object(
      'result', 'already_active',
      'agreement_id', v_agreement.id,
      'payment_rows', v_pay_rows,
      'delivery_rows', v_del_rows
    );
  end if;

  if v_agreement.status <> 'pending' then
    return pg_catalog.jsonb_build_object('result', 'agreement_not_pending',
      'status', v_agreement.status);
  end if;

  -- ── PAYMENT PROOF: THE ATTEMPT'S OWN FROZEN ANCHOR ────────────
  select * into v_attempt
  from public.checkout_attempts
  where id = p_checkout_attempt_id
  for update;

  if not found then
    return pg_catalog.jsonb_build_object('result', 'attempt_not_found');
  end if;

  if v_attempt.status <> 'paid' or v_attempt.paid_at is null then
    return pg_catalog.jsonb_build_object('result', 'attempt_not_paid',
      'attempt_status', v_attempt.status);
  end if;

  if v_attempt.user_id is distinct from v_agreement.user_id then
    return pg_catalog.jsonb_build_object('result', 'attempt_owner_mismatch');
  end if;

  v_n     := v_agreement.instalment_count;
  v_total := v_agreement.contract_product_net_cents;

  -- 059's annual CHECK already guarantees both, so this is a belt-and-
  -- braces refusal rather than an expected branch - and it keeps the
  -- division below from ever meeting a NULL or a zero.
  if v_n is null or v_n not in (1, 2, 4) or v_total is null or v_total <= 0 then
    return pg_catalog.jsonb_build_object('result', 'agreement_not_priced');
  end if;

  v_now     := pg_catalog.now();
  v_base    := v_total::bigint / v_n::bigint;
  v_spacing := 12 / v_n;

  -- ── THE ACTIVATION ────────────────────────────────────────────
  --
  -- stripe_subscription_id is deliberately left NULL: 059's annual shape
  -- CHECK forbids it, because an annual contract billed by a Stripe
  -- subscription would mean two systems each believed they owned the
  -- billing.
  update public.b2b_supply_agreements
     set status            = 'active',
         started_at        = v_now,
         commitment_end_at = v_now + interval '12 months',
         next_delivery_at  = v_now
   where id = p_agreement_id;

  -- ── THE PAYMENT SCHEDULE. Exactly instalment_count rows, 1..n. ──
  for v_i in 1 .. v_n loop
    if v_i < v_n then
      v_net := v_base;
    else
      v_net := v_total::bigint - v_base * (v_n::bigint - 1);
    end if;

    if v_i = 1 then
      -- INSTALMENT 1 IS PAID, and it is the only row that carries tax
      -- facts. gross first, tax as its remainder.
      v_gross := (2 * (v_net * 107) + 100) / 200;
      v_tax   := v_gross - v_net;

      insert into public.b2b_payment_schedule (
        supply_agreement_id, instalment_number, due_at, status, net_cents,
        tax_rate_percent, tax_cents, gross_cents,
        tax_calculation_version, price_origin,
        stripe_payment_intent_id, invoiced_at, paid_at
      ) values (
        p_agreement_id, 1, v_now, 'paid', v_net::integer,
        7, v_tax::integer, v_gross::integer,
        'de-net-2026.1', 'net',
        nullif(pg_catalog.btrim(coalesce(p_stripe_payment_intent_id, '')), ''),
        v_now, v_now
      );
    else
      -- 2..n ARE MERELY OWED. Every tax column NULL - 060 reads a
      -- tax_cents of 0 as "the VAT on this instalment is zero" rather
      -- than "no VAT has been established yet", and only the invoicing
      -- in Package 5D may establish it.
      insert into public.b2b_payment_schedule (
        supply_agreement_id, instalment_number, due_at, status, net_cents
      ) values (
        p_agreement_id, v_i, v_now + (make_interval(months => v_spacing) * (v_i - 1)),
        'scheduled', v_net::integer
      );
    end if;
  end loop;

  -- ── THE TWELVE DELIVERY SLOTS ─────────────────────────────────
  --
  -- All twelve at activation, because 059 fixes delivery_count at 12 for
  -- every annual contract and 060's integrity assertion requires exactly
  -- twelve on an active one. ELEVEN OF THEM ARE SLOTS: nobody knows yet
  -- which address delivery #7 goes to, so nothing is resolved and
  -- nothing is frozen. quantity_packs is the agreement's frozen quantity,
  -- which for an ACTIVE annual agreement can no longer change (059's
  -- immutability guard).
  for v_i in 1 .. 12 loop
    insert into public.b2b_deliveries (
      supply_agreement_id, delivery_number, scheduled_for, quantity_packs, status
    ) values (
      p_agreement_id, v_i, v_now + (interval '1 month' * (v_i - 1)),
      v_agreement.quantity_packs, 'scheduled'
    );
  end loop;

  return pg_catalog.jsonb_build_object(
    'result', 'activated',
    'agreement_id', p_agreement_id,
    'instalment_count', v_n,
    'payment_rows', v_n,
    'delivery_rows', 12,
    'first_instalment_net_cents', (case when v_n = 1 then v_total::bigint else v_base end)::integer
  );
end;
$$;

comment on function public.activate_b2b_annual_from_payment(uuid, uuid, text) is
  'Package 5C. Activates a PENDING annual B2B supply agreement once its own checkout attempt is provably paid: sets status/started_at/commitment_end_at, writes exactly instalment_count payment rows with the canonical allocation (instalment 1 paid with net-origin 7% tax facts, the rest scheduled with NULL tax facts) and twelve UNRESOLVED delivery slots. Derives every amount and date itself. Idempotent: an already-active agreement is returned untouched.';


-- ══════════════════════════════════════════════════════════════
-- 2. MONTHLY: EVERY PAID INVOICE IS ONE MORE DELIVERY
-- ══════════════════════════════════════════════════════════════
--
-- ── THE REPLAY KEY IS THE STRIPE INVOICE ──────────────────────
--
-- 060 created b2b_deliveries_stripe_invoice_id_key, a partial UNIQUE on
-- stripe_invoice_id. That index IS the idempotency: one paid invoice can
-- correspond to at most one delivery row, whatever the webhook does. The
-- lookup below is the fast path and the index is the guarantee, so two
-- concurrent deliveries of the same invoice.paid converge on one row.
--
-- This matters more than the usual amount of care, because the event
-- dedup table keys on the STRIPE EVENT ID, and Stripe can legitimately
-- emit two different event ids for the same invoice. The event table
-- catches the redelivery; this index catches the re-emission.
--
-- ── AND THERE IS NEVER A PAYMENT SCHEDULE ROW ─────────────────
--
-- Stripe owns a monthly agreement's billing. 060's integrity assertion
-- raises if an ACTIVE monthly agreement holds a single instalment row,
-- so this function does not write one and could not.
--
-- ── QUANTITY IS HISTORICAL ────────────────────────────────────
--
-- quantity_packs is read from the agreement AT SETTLEMENT TIME and
-- frozen onto the delivery. A later quantity change moves the agreement
-- and its canonical item; it must never rewrite a delivery that has
-- already been paid for, which is why 060 deliberately does not compare
-- the two.

create function public.settle_b2b_monthly_paid_invoice(
  p_agreement_id            uuid,
  p_stripe_subscription_id  text,
  p_stripe_invoice_id       text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_agreement public.b2b_supply_agreements;
  v_delivery  public.b2b_deliveries;
  v_sub       text;
  v_invoice   text;
  v_now       timestamptz;
  v_next      integer;
  v_activated boolean := false;
begin
  v_sub     := nullif(pg_catalog.btrim(coalesce(p_stripe_subscription_id, '')), '');
  v_invoice := nullif(pg_catalog.btrim(coalesce(p_stripe_invoice_id, '')), '');

  if p_agreement_id is null or v_sub is null or v_invoice is null then
    return pg_catalog.jsonb_build_object('result', 'invalid_input');
  end if;

  select * into v_agreement
  from public.b2b_supply_agreements
  where id = p_agreement_id
  for update;

  if not found then
    return pg_catalog.jsonb_build_object('result', 'agreement_not_found');
  end if;

  if v_agreement.plan_type is distinct from 'monthly' then
    return pg_catalog.jsonb_build_object('result', 'not_a_monthly_agreement',
      'plan_type', v_agreement.plan_type);
  end if;

  -- ── ALREADY SETTLED? Keyed on the invoice, not on the status. ──
  select * into v_delivery
  from public.b2b_deliveries
  where stripe_invoice_id = v_invoice;

  if found then
    if v_delivery.supply_agreement_id is distinct from p_agreement_id then
      -- The same invoice cannot belong to two agreements. Refusing is
      -- the only safe answer; creating a second delivery would double-
      -- supply one paid period.
      return pg_catalog.jsonb_build_object('result', 'invoice_belongs_elsewhere');
    end if;
    return pg_catalog.jsonb_build_object(
      'result', 'already_settled',
      'agreement_id', p_agreement_id,
      'delivery_id', v_delivery.id,
      'delivery_number', v_delivery.delivery_number
    );
  end if;

  v_now := pg_catalog.now();

  if v_agreement.status = 'pending' then
    -- ── THE FIRST PAID INVOICE ACTIVATES THE CONTRACT ───────────
    --
    -- 059's monthly active CHECK requires both started_at and
    -- stripe_subscription_id, so they are written together.
    update public.b2b_supply_agreements
       set status                = 'active',
           started_at            = v_now,
           stripe_subscription_id = v_sub,
           next_delivery_at      = v_now
     where id = p_agreement_id;
    v_activated := true;

  elsif v_agreement.status = 'active' then
    -- ── A LATER CYCLE. The subscription must be the same one. ────
    --
    -- 059's immutability guard would refuse a change anyway; refusing
    -- here means the mismatch is reported rather than raised, and
    -- nothing is written on the way to finding out.
    if v_agreement.stripe_subscription_id is distinct from v_sub then
      return pg_catalog.jsonb_build_object('result', 'subscription_mismatch');
    end if;

    update public.b2b_supply_agreements
       set next_delivery_at = v_now
     where id = p_agreement_id;

  else
    -- cancelled / completed. A paid invoice against an ended contract is
    -- a real problem, but it is not this function's to resolve: it
    -- creates nothing and says so.
    return pg_catalog.jsonb_build_object('result', 'agreement_not_billable',
      'status', v_agreement.status);
  end if;

  -- ── THE NEXT CONTIGUOUS DELIVERY ──────────────────────────────
  --
  -- 060's assertion requires delivery numbers to be contiguous from 1,
  -- and b2b_deliveries_agreement_number_key makes the number unique per
  -- agreement - so a concurrent caller that computed the same next
  -- number loses on the index rather than creating a gap or a duplicate.
  select coalesce(pg_catalog.max(delivery_number), 0) + 1
    into v_next
    from public.b2b_deliveries
   where supply_agreement_id = p_agreement_id;

  insert into public.b2b_deliveries (
    supply_agreement_id, delivery_number, scheduled_for,
    quantity_packs, status, stripe_invoice_id
  ) values (
    p_agreement_id, v_next, v_now,
    v_agreement.quantity_packs, 'scheduled', v_invoice
  )
  returning * into v_delivery;

  return pg_catalog.jsonb_build_object(
    'result', case when v_activated then 'activated' else 'settled' end,
    'agreement_id', p_agreement_id,
    'delivery_id', v_delivery.id,
    'delivery_number', v_delivery.delivery_number,
    'quantity_packs', v_delivery.quantity_packs
  );
end;
$$;

comment on function public.settle_b2b_monthly_paid_invoice(uuid, text, text) is
  'Package 5C. Settles one paid Stripe invoice for a monthly B2B supply agreement: activates a pending agreement (status, started_at, stripe_subscription_id) on the first invoice and creates exactly one next contiguous UNRESOLVED delivery slot carrying the quantity frozen at settlement time. Never writes a payment schedule row. Idempotent on the Stripe invoice id, which 060 makes unique across deliveries.';


-- ══════════════════════════════════════════════════════════════
-- 3. FUNCTION PRIVILEGES
-- ══════════════════════════════════════════════════════════════
--
-- REVOKE FROM public FIRST, then the named browser roles, then grant
-- EXECUTE to service_role alone - the same shape 061 used and 039
-- established. A freshly created function is executable by PUBLIC by
-- default and anon and authenticated inherit that, so revoking only the
-- named roles would leave these writers reachable from the browser's own
-- Supabase client with nothing but an anon key.

revoke all on function public.activate_b2b_annual_from_payment(uuid, uuid, text) from public;
revoke all on function public.activate_b2b_annual_from_payment(uuid, uuid, text) from anon;
revoke all on function public.activate_b2b_annual_from_payment(uuid, uuid, text) from authenticated;
grant execute on function public.activate_b2b_annual_from_payment(uuid, uuid, text) to service_role;

revoke all on function public.settle_b2b_monthly_paid_invoice(uuid, text, text) from public;
revoke all on function public.settle_b2b_monthly_paid_invoice(uuid, text, text) from anon;
revoke all on function public.settle_b2b_monthly_paid_invoice(uuid, text, text) from authenticated;
grant execute on function public.settle_b2b_monthly_paid_invoice(uuid, text, text) to service_role;


-- ══════════════════════════════════════════════════════════════
-- 4. WHAT THIS MIGRATION DID NOT DO
-- ══════════════════════════════════════════════════════════════
--
--   NO create/alter/drop table, column, index, constraint or trigger
--   NO policy change, no RLS change
--   NO table privilege: not one grant, not one revoke, on any table
--   NO change to 001-061 or to anything they defined
--   NO insert, update or delete of business data outside the two
--      writers' own bodies
--   NO failure or hold transition - Package 5F owns those
--   NO instalment invoicing - Package 5D owns that
--   NO shipping resolution or dispatch - Package 5E owns those
--
-- ── READ-ONLY VERIFICATION ────────────────────────────────────
--
--   select p.proname, p.prosecdef, p.proconfig
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public'
--      and p.proname in ('activate_b2b_annual_from_payment',
--                        'settle_b2b_monthly_paid_invoice');
--   -- expect: both t, both {search_path=""}
--
--   select routine_name, grantee, privilege_type
--     from information_schema.routine_privileges
--    where routine_schema = 'public'
--      and routine_name in ('activate_b2b_annual_from_payment',
--                           'settle_b2b_monthly_paid_invoice');
--   -- expect: service_role / EXECUTE and the owner. Never anon,
--   --         authenticated or PUBLIC.
--
--   select table_name, grantee, privilege_type
--     from information_schema.role_table_grants
--    where table_schema = 'public'
--      and table_name in ('b2b_supply_agreements', 'b2b_supply_items',
--                         'b2b_payment_schedule', 'b2b_deliveries')
--      and privilege_type in ('INSERT', 'UPDATE', 'DELETE');
--   -- expect: ZERO ROWS.

commit;
