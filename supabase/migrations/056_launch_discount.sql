-- ══════════════════════════════════════════════════════════════
-- 056 — GLOALAUNCH10: THE DATABASE FOUNDATION
--
-- PHASE A. SCHEMA, STATE MACHINE AND PRIVILEGES ONLY. Nothing in this
-- repository reads or writes anything below when this migration is
-- applied, and that is the point: production must never run code that
-- expects a table it does not have, and it must never hold a table that
-- half a feature is already writing to. The runtime wiring - the code
-- field in the cart, the eligibility answer, the discounted Stripe
-- session - is phase B and lands separately.
--
-- ── WHAT THE BUSINESS RULE ACTUALLY IS ────────────────────────
--
--   code          GLOALAUNCH10, one open code, no per-customer secrets
--   value         10 % of the merchandise subtotal
--   window        01.10.2026 12:00 Europe/Berlin (CEST, +02:00)
--                 to 31.10.2026 23:59:59.999 Europe/Berlin (CET, +01:00)
--   scope         the B2C ONE-TIME checkout only
--   eligible      GLOA-MATCHA-30G, GLOA-MATCHA-50G, GLOA-MATCHA-100G
--   not eligible  subscriptions, the prepaid annual plan, B2B, the metal
--                 case, and shipping
--   one use       one successful redemption per normalised email
--   first order   no PAID order for that same normalised email created at
--                 or after 01.10.2026 12:00 Europe/Berlin. The August
--                 test orders are BEFORE that instant, so they do not
--                 make anybody ineligible and none of them is deleted.
--   refunded      the code stays used. A refund returns money, not an
--                 entitlement.
--   minimum       none
--   shipping      the free-shipping threshold is measured BEFORE the
--                 discount, and shipping itself is never discounted
--
-- The arithmetic half of this already exists and is already tested, in
-- lib/launchDiscount.ts: the code, the two instants, the ten percent,
-- the exact split across lines. That module is pure and has no database.
-- THIS migration owns the two facts it cannot answer from inputs alone:
-- has this person already used the code, and is this their first order.
--
-- ── WHY THE DATABASE HAS TO OWN "ONE USE" ─────────────────────
--
-- Because the alternative is a race. Two tabs, two devices, or one
-- double-tapped button produce two checkout requests for the same
-- address at the same moment. A read followed by a write - "has this
-- email used the code? no? then let them" - decides both with the same
-- answer and grants the discount twice. The server runs as several
-- instances that share no memory, so no variable, no mutex and no
-- disabled button can close that. The invariant has to be durable, and
-- durable here means a row and a constraint.
--
-- That is the same conclusion migration 049 reached for the refund lock
-- and 046 for the waitlist signup, and this follows 049's shape
-- deliberately: a claim id, a claimed-at, a lapse in the same statement,
-- and a release that only the current holder can perform. A second
-- design would be a second set of mistakes.
--
-- ── WHY ONE MUTABLE ROW PER (CODE, CUSTOMER), NOT ONE PER ATTEMPT ──
--
-- A row per attempt would be a log, and a log cannot be a lock: asking
-- "does an active claim exist?" of a log is a SELECT, and a SELECT
-- before an INSERT is the race this exists to prevent. One row per
-- (code, customer_key), with the pair as the PRIMARY KEY, moves the
-- decision into the index: the claim is taken by an INSERT that either
-- creates the row or is told by the database that somebody already has
-- it. No caller ever reads to decide.
--
-- ── WHY payment_pending IS A STATE AND NOT AN OVERSIGHT ───────
--
-- SEPA Direct Debit and the bank-transfer family complete a Checkout
-- Session immediately and confirm the money DAYS LATER. This repository
-- already handles that for one-time orders: the session arrives at
-- checkout.session.completed with payment_status "unpaid", no order is
-- created, and checkout.session.async_payment_succeeded is what later
-- says the money arrived (app/api/stripe/webhook/route.ts).
--
-- A reservation that simply expired after thirty minutes would therefore
-- be released while a payment that will SUCCEED is still in flight -
-- another checkout could take the code, and the person who actually paid
-- would find it gone. So a claim whose session has completed but whose
-- money is still travelling moves to 'payment_pending', where
-- expires_at is NULL and the state shape CHECK forbids it being
-- anything else. Nothing can lapse it. It leaves that state in exactly
-- two ways: forward to 'redeemed' when the money arrives, or back to
-- 'released' by the one function that exists for a payment Stripe has
-- told us FAILED.
--
-- ── WHAT IS DELIBERATELY NOT HERE ─────────────────────────────
--
-- No promotions engine. No percent column, no eligible-SKU table, no
-- audience rules, no stacking order, no coupon catalogue. There is one
-- code with one value in one window, and it is written as one code with
-- one value in one window - the CHECK constraints name the literal. A
-- second code is a later migration, which is a smaller price than a
-- generic engine nobody asked for.
--
-- No Stripe object: a migration cannot create one, and the discount is
-- applied to the line amounts BEFORE Stripe is called precisely because
-- a promotion code entered at the till would reduce amount_total and
-- lib/stripeFulfillment.ts would then refuse to fulfil a paid order.
-- No email. No business row: this migration adds capacity, not data.
-- Nothing is backfilled, nothing is deleted, no historical order is
-- recalculated, and SHOP_STATUS is not this file's business.
-- ══════════════════════════════════════════════════════════════

begin;

-- ══════════════════════════════════════════════════════════════
-- 1. THE CLAIM LEDGER
-- ══════════════════════════════════════════════════════════════
--
-- ONE ROW PER (code, customer_key), MUTATED IN PLACE. The primary key
-- is the lock.
--
-- customer_key is the normalised authoritative checkout email that
-- migration 055 put in front of Stripe - lower(btrim(...)) - and the
-- CHECK enforces that canonical form at the boundary rather than
-- trusting every caller to remember it, exactly as 051 does for
-- admin_users.email and 055 for checkout_attempts.customer_email. A
-- half-normalised address would be a second spelling of one person, and
-- two spellings is two discounts.
--
-- WHAT IS NOT IN HERE: no name, no address, no basket, no line, no
-- amount, no IP, no user agent. The email is the key and is unavoidable;
-- everything else about the person is already somewhere that owns it.
-- The money lives on the order, which is the accounting record.

create table if not exists public.launch_discount_claims (
  -- The code, canonical and known. Two CHECKs on purpose: the first says
  -- what shape a code has, the second says which codes exist. Widening
  -- the second is a deliberate migration; forgetting the first would let
  -- 'gloalaunch10' and 'GLOALAUNCH10' be two codes.
  code                 text not null,
  customer_key         text not null,

  state                text not null,

  -- The CURRENT holder. A token minted per checkout attempt, not a
  -- counter: release and redemption both compare against it so a caller
  -- whose reservation lapsed cannot act on the claim that replaced it.
  claim_id             uuid,
  checkout_attempt_id  uuid references public.checkout_attempts(id),

  -- Set once, when the claim becomes terminal.
  order_id             uuid references public.orders(id),

  claimed_at           timestamptz,
  -- NULL means "cannot lapse", which is true of exactly three states:
  -- payment_pending, released and redeemed. See the shape CHECK.
  expires_at           timestamptz,
  released_at          timestamptz,
  redeemed_at          timestamptz,

  -- A REDEMPTION THAT ARRIVED AFTER THE CLAIM WAS ALREADY SPENT BY A
  -- DIFFERENT ORDER. It cannot be refused - see section 8 - so it is
  -- counted, because an invisible commercial leak is worse than a
  -- visible number. Zero forever means the state machine held.
  redemption_conflicts integer not null default 0,
  last_conflict_at     timestamptz,

  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  primary key (code, customer_key),

  constraint launch_discount_claims_code_canonical
    check (code = upper(btrim(code)) and length(code) between 3 and 64),

  -- ONE CODE. Not a configuration table wearing a CHECK.
  constraint launch_discount_claims_code_known
    check (code = 'GLOALAUNCH10'),

  constraint launch_discount_claims_customer_key_normalized
    check (customer_key = lower(btrim(customer_key))
           and length(customer_key) between 3 and 254
           and position('@' in customer_key) > 1),

  constraint launch_discount_claims_conflicts_nonnegative
    check (redemption_conflicts >= 0),

  -- ── THE STATE MACHINE, AS A CONSTRAINT ──────────────────────
  --
  -- Every state says which columns must be present and which must be
  -- absent, so an incoherent row cannot exist even if a future function
  -- forgets. The `else false` matters: it is what makes the list of
  -- states closed, so a mistyped state cannot be written by anything.
  --
  --   reserved         a checkout holds it; it CAN lapse
  --   payment_pending  a delayed payment is in flight; it CANNOT lapse
  --   released         nobody holds it; anybody with this email may take it
  --   redeemed         TERMINAL. An order exists. Never released, never
  --                    re-reserved, and a refund does not undo it.
  constraint launch_discount_claims_state_shape check (
    case state
      when 'reserved' then
        claim_id is not null and checkout_attempt_id is not null
        and claimed_at is not null and expires_at is not null
        and redeemed_at is null and order_id is null
      when 'payment_pending' then
        claim_id is not null and checkout_attempt_id is not null
        and claimed_at is not null and expires_at is null
        and redeemed_at is null and order_id is null
      when 'released' then
        claim_id is null and checkout_attempt_id is null
        and expires_at is null and released_at is not null
        and redeemed_at is null and order_id is null
      when 'redeemed' then
        claim_id is not null and checkout_attempt_id is not null
        and order_id is not null and redeemed_at is not null
        and expires_at is null
      else false
    end
  )
);

comment on table public.launch_discount_claims is
  'One mutable row per (launch code, normalised customer email). The durable one-use lock for GLOALAUNCH10. Not a redemption log and not a promotions engine.';
comment on column public.launch_discount_claims.customer_key is
  'Normalised authoritative checkout email - lower(btrim(...)), the same canonical form as checkout_attempts.customer_email.';
comment on column public.launch_discount_claims.expires_at is
  'When a reservation lapses. NULL means it cannot lapse, which is required for payment_pending: a delayed payment may still succeed.';
comment on column public.launch_discount_claims.redemption_conflicts is
  'Redemptions that arrived after a different order had already spent this claim. Expected to stay 0.';

-- updated_at, by the same trigger function every other table here uses.
-- Guarded because CREATE TRIGGER has no IF NOT EXISTS.
do $$
begin
  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.launch_discount_claims'::regclass
      and tgname = 'set_launch_discount_claims_updated_at'
  ) then
    create trigger set_launch_discount_claims_updated_at
      before update on public.launch_discount_claims
      for each row execute function public.set_updated_at();
  end if;
end $$;

-- ══════════════════════════════════════════════════════════════
-- 2. NOTHING MAY REACH IT - NOT EVEN THE SERVER
-- ══════════════════════════════════════════════════════════════
--
-- RLS ON WITH NOT ONE POLICY, and every privilege taken away from all
-- three roles WITHOUT ONE BEING GIVEN BACK.
--
-- Stated as an end state rather than a delta, for the reason 052 learned
-- and 053 then repeated one role along: Supabase carries DEFAULT
-- privileges for anon, authenticated and service_role on new tables in
-- `public`, so a table arrives already holding SELECT, REFERENCES,
-- TRIGGER and TRUNCATE for them. "Revoke what I granted" leaves whatever
-- arrived by default - including TRUNCATE, which would let the server
-- empty its own one-use ledger in a single statement and hand every
-- customer a second discount. So: take everything, from all three, and
-- give nothing back.
--
-- AND GENUINELY NOTHING BACK, which is stricter than 052 and 055 needed.
-- Every legitimate operation on this table is a state transition with
-- rules - who may release, what may never lapse, what is terminal - and
-- all five are the functions below, which are SECURITY DEFINER and
-- therefore do not need the caller to hold a privilege. A grant here
-- would only create a second way in that enforces nothing.
--
-- RLS is belt to that braces. service_role bypasses RLS in Supabase, so
-- the revoke is what actually stops the server; the policy-free RLS is
-- what stops anon and authenticated if a default grant is ever restored
-- by somebody else's migration.
--
-- The owner (postgres) is deliberately not named: revoking from the
-- owner would leave nobody able to administer the table.

alter table public.launch_discount_claims enable row level security;

revoke all privileges on table public.launch_discount_claims
  from anon, authenticated, service_role;

-- ══════════════════════════════════════════════════════════════
-- 3. THE ATTEMPT FREEZES WHICH DISCOUNT IT WAS QUOTED
-- ══════════════════════════════════════════════════════════════
--
-- The checkout attempt already freezes the prices, the shipping zone,
-- the tax and - since 055 - the customer identity, so that a retry
-- settles what the customer was actually quoted rather than whatever the
-- world looks like when they come back. The discount belongs in that
-- same snapshot and for the same reason.
--
-- THREE COLUMNS, WHICH IS THE MINIMUM THAT WORKS:
--
--   discount_code         which code was applied
--   discount_gross_cents  what it was worth, frozen
--   discount_claim_id     WHICH CLAIM this attempt holds - the token
--                         redemption is checked against. Without it the
--                         webhook would have to guess whether the claim
--                         it is about to spend is still this attempt's.
--
-- No percent (it is in the code), no eligibility verdict (it is implied
-- by the snapshot existing), no reason string (a refusal produces no
-- attempt).
--
-- ALL THREE NULLABLE, and that is not laziness: 729 attempts already
-- exist and every one of them must stay readable and settleable. NOT
-- NULL here would either rewrite history or refuse to apply. Old
-- attempts keep saying, truthfully, that no code was used.
--
-- checkout_attempts had its privileges hardened to (select, insert,
-- update) for service_role in migration 023, and new columns inherit the
-- table's grants, so nothing is granted or revoked here. Re-stating them
-- would risk changing a privilege set this migration has no business
-- touching.
--
-- discount_claim_id carries NO foreign key, deliberately: the claim's
-- identity is (code, customer_key) and claim_id is a rotating holder
-- token, not a key. A constraint pointing at it would need a unique
-- index on a column that is null for most of a row's life and is
-- replaced on every takeover.
--
-- ── ONE RULE THIS PUTS ON PHASE B ─────────────────────────────
--
-- discount_gross_cents must be > 0, so a discount worth NOTHING is
-- recorded as no discount rather than as a code that reduced zero. That
-- is only reachable at all on a basket of four cents or less -
-- discountGrossCents rounds half up, so 4 cents gives 0 - which no real
-- basket is (the smallest tin is 19,99 EUR). Stated as a constraint
-- anyway, because "a code was applied and changed nothing" is a row
-- nobody could explain later.

alter table public.checkout_attempts
  add column if not exists discount_code        text,
  add column if not exists discount_gross_cents integer,
  add column if not exists discount_claim_id    uuid;

do $$
begin
  -- ALL THREE OR NONE, and a discounted attempt must know who it is.
  -- The redemption in section 9 needs the code, the customer key and the
  -- claim token; an attempt carrying two of the three would be a
  -- discount nothing can account for.
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.checkout_attempts'::regclass
      and conname = 'checkout_attempts_discount_snapshot_paired'
  ) then
    alter table public.checkout_attempts
      add constraint checkout_attempts_discount_snapshot_paired
      check (
        (discount_code is null
         and discount_gross_cents is null
         and discount_claim_id is null)
        or (discount_code is not null
            and discount_claim_id is not null
            and discount_gross_cents is not null
            and discount_gross_cents > 0
            and customer_email is not null)
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.checkout_attempts'::regclass
      and conname = 'checkout_attempts_discount_code_known'
  ) then
    alter table public.checkout_attempts
      add constraint checkout_attempts_discount_code_known
      check (discount_code is null or discount_code = 'GLOALAUNCH10');
  end if;

  -- ── THE SCOPE, ENFORCED RATHER THAN DOCUMENTED ──────────────
  --
  -- "B2C one-time only" is a sentence in a brief until something refuses
  -- to store the alternative. A subscription attempt carries
  -- subscription_id (022), a renewal carries stripe_invoice_id (022) and
  -- a prepaid annual delivery carries annual_plan_id (039). An attempt
  -- with any of the three cannot hold a discount snapshot at all, so no
  -- future wiring mistake can discount a recurring charge, a renewal
  -- invoice or one of the thirteen annual boxes.
  --
  -- B2B never comes near this: it has its own tables (006) and no
  -- checkout attempt.
  --
  -- The metal case and shipping are NOT expressible here - they are
  -- basket contents and a carriage charge, not attempt columns - and
  -- pretending otherwise would mean copying the catalogue into a CHECK.
  -- Those two belong to the eligibility decision in phase B, where the
  -- basket actually is.
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.checkout_attempts'::regclass
      and conname = 'checkout_attempts_discount_one_time_only'
  ) then
    alter table public.checkout_attempts
      add constraint checkout_attempts_discount_one_time_only
      check (
        discount_code is null
        or (subscription_id is null
            and annual_plan_id is null
            and stripe_invoice_id is null)
      );
  end if;
end $$;

comment on column public.checkout_attempts.discount_code is
  'The launch code this attempt was quoted with. Null on every attempt that used none, including all 729 predating 056.';
comment on column public.checkout_attempts.discount_gross_cents is
  'What the discount was worth, frozen before Stripe was called. Folded into the line amounts, never sent as a Stripe promotion code.';
comment on column public.checkout_attempts.discount_claim_id is
  'The claim token this attempt holds in public.launch_discount_claims. What redemption is checked against.';

-- ══════════════════════════════════════════════════════════════
-- 4. THE ORDER NAMES THE CODE
-- ══════════════════════════════════════════════════════════════
--
-- orders.discount_total_cents has existed since migration 004 (NOT NULL
-- DEFAULT 0, and 021 deliberately kept that default because no discount
-- is a real zero rather than an unknown). What was missing is WHICH
-- discount: an amount with no name is unauditable, and "10 % because of
-- what?" is the first question anybody asks of a paid order.
--
-- ONE COLUMN. Not a join to a promotions table, not a percent, not a
-- rules snapshot. The code identifies the offer; the offer's terms are
-- in lib/launchDiscount.ts and in this file's header.

alter table public.orders
  add column if not exists discount_code text;

-- A pre-check, so a production run that would fail says why in one
-- readable line instead of reporting a constraint name. Nothing in this
-- repository has ever written discount_total_cents - it is display-only
-- in AccountPortal and AdminOrders - so every existing order should be a
-- clean zero.
do $$
declare
  v_bad bigint;
begin
  select count(*) into v_bad
  from public.orders
  where discount_total_cents <> 0 and discount_code is null;
  if v_bad > 0 then
    raise exception '056: % existing order(s) carry a discount amount with no code. Investigate before adding the pairing constraint; do not weaken it.', v_bad;
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.orders'::regclass
      and conname = 'orders_discount_code_known'
  ) then
    alter table public.orders
      add constraint orders_discount_code_known
      check (discount_code is null or discount_code = 'GLOALAUNCH10');
  end if;

  -- AN AMOUNT AND A NAME, OR NEITHER. This is what makes the money
  -- auditable in both directions: no discounted order without a code to
  -- attribute it to, and no code recorded on an order that was charged
  -- in full.
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.orders'::regclass
      and conname = 'orders_discount_code_paired'
  ) then
    alter table public.orders
      add constraint orders_discount_code_paired
      check (
        (discount_code is null and discount_total_cents = 0)
        or (discount_code is not null and discount_total_cents > 0)
      );
  end if;
end $$;

comment on column public.orders.discount_code is
  'Which launch code reduced this order. Null on every order charged in full, including all 458 predating 056.';

-- ══════════════════════════════════════════════════════════════
-- 5. IS THIS THEIR FIRST ORDER?
-- ══════════════════════════════════════════════════════════════
--
-- "First order" is defined against the LAUNCH, not against all of time:
-- no PAID order for the same normalised email created at or after
-- 01.10.2026 12:00 Europe/Berlin. The August test orders sit before that
-- instant, so they make nobody ineligible - and not one of them is
-- deleted, edited or hidden to achieve that. The cutoff does the work
-- that data surgery would otherwise have been asked to do.
--
-- 01.10.2026 12:00 Europe/Berlin is CEST, +02:00, so the literal below
-- carries that offset explicitly. Writing it as a local-time string
-- would mean whatever the server's timezone happens to be, and the
-- window's other end is in a DIFFERENT offset because the clocks go back
-- on 25 October 2026 - the trap lib/launchDiscount.ts documents at
-- length. The start instant here is the same instant
-- LAUNCH_DISCOUNT_FROM_ISO names, and the suite asserts they agree.
--
-- THE INDEX. Partial on payment_status = 'paid', because an unpaid order
-- can never make anybody ineligible and there is no reason to index one.
-- Leading on the normalised email so the equality is an index seek, with
-- created_at second so the cutoff is satisfied from the index too. This
-- is an EXISTENCE question, so the cheapest possible plan matters more
-- than any row it would return.
--
-- lower(btrim(...)) over customer_snapshot->>'email' is the same
-- canonical form as everywhere else in this file. Every function in it
-- is IMMUTABLE, which is what makes the expression indexable at all.

create index if not exists idx_orders_paid_customer_email_created_at
  on public.orders (lower(btrim(customer_snapshot->>'email')), created_at)
  where payment_status = 'paid';

/**
 * Has this address NOT yet had a paid order inside the launch window?
 *
 * THE ONLY HOME OF THE CUTOFF INSTANT in the database. The claim
 * function below calls this rather than repeating the literal, so there
 * is exactly one place to be wrong.
 *
 * FAILS CLOSED. A missing, blank or unaddressed key returns false -
 * "not a first order" - because the question cannot be answered and
 * answering it wrongly in the generous direction gives away money.
 *
 * STABLE, not IMMUTABLE: it reads a table.
 */
create or replace function public.launch_discount_is_first_order(
  p_customer_key text
)
returns boolean
language plpgsql
stable
security definer set search_path = ''
as $$
declare
  v_key text;
begin
  v_key := lower(btrim(coalesce(p_customer_key, '')));

  if length(v_key) < 3 or position('@' in v_key) < 2 then
    return false;
  end if;

  return not exists (
    select 1
    from public.orders
    where payment_status = 'paid'
      and created_at >= timestamptz '2026-10-01 12:00:00+02'
      and lower(btrim(customer_snapshot->>'email')) = v_key
  );
end;
$$;

-- ══════════════════════════════════════════════════════════════
-- 6. TAKING THE CLAIM
-- ══════════════════════════════════════════════════════════════

/**
 * Reserves GLOALAUNCH10 for one normalised address, or says who has it.
 *
 * ── ONE STATEMENT. NO SELECT-THEN-INSERT. ─────────────────────
 *
 * The whole decision is an INSERT ... ON CONFLICT DO UPDATE whose WHERE
 * decides, so the database arbitrates under the primary key's row lock.
 * Two concurrent callers for the same address serialise there and
 * EXACTLY ONE is told it reserved anything: the second finds the row the
 * first just wrote, fails the WHERE, and affects zero rows.
 *
 * A caller never reads to decide. The read afterwards exists ONLY to put
 * a word in the answer, and nothing acts on it.
 *
 * ── WHEN A CLAIM MAY BE TAKEN ─────────────────────────────────
 *
 *   the row does not exist      nobody has ever used the code here
 *   state = 'released'          a checkout was abandoned, or a delayed
 *                               payment failed
 *   state = 'reserved' and the  the SAME request again. Idempotent: the
 *   claim id is the caller's    reservation is refreshed and the caller
 *                               is told it holds it. A retried checkout
 *                               must not be refused its own claim.
 *   state = 'reserved' and the  the previous reservation lapsed
 *   reservation has lapsed
 *
 * AND NEVER OTHERWISE. 'redeemed' is terminal, and 'payment_pending' is
 * excluded ENTIRELY - not "unless it is old", not "unless the same
 * caller asks", but excluded - because a payment that may still succeed
 * must never lose its claim, and because moving back to 'reserved' would
 * restore an expires_at that could then lapse it.
 *
 * ── THE LAPSE, AND WHY IT IS SAFE HERE ────────────────────────
 *
 * The row is keyed by the EMAIL, so a takeover is always the same person
 * starting another checkout - never a stranger taking their discount.
 * The only cost of a lapse is that this person's abandoned session, if
 * they ever pay it, redeems a claim somebody else's reservation now
 * holds; section 8 makes that a counted conflict rather than a lost
 * order. The TTL therefore trades a lockout after abandonment against
 * that rare double settlement, and 30 minutes is the middle of it.
 * Floored at 300 seconds so a caller cannot pass a value small enough to
 * make the reservation meaningless, and capped at a day so one cannot
 * hold the code hostage.
 *
 * ── AND IT IS THE FIRST-ORDER GATE TOO ────────────────────────
 *
 * Checked here rather than left to the caller, so the two halves of
 * eligibility cannot be enforced in two places with two answers. The
 * check sits before the upsert: two simultaneous callers can both read
 * "no paid order yet", but only one of them can then take the claim,
 * which is the invariant that matters.
 *
 * Returns { claimed, state, outcome }.
 */
create or replace function public.claim_launch_discount(
  p_code text,
  p_customer_key text,
  p_claim_id uuid,
  p_checkout_attempt_id uuid,
  p_ttl_seconds integer default 1800
)
returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_code  text;
  v_key   text;
  v_ttl   integer;
  v_now   timestamptz := now();
  v_rows  integer;
  v_state text;
begin
  if p_code is null or p_customer_key is null
     or p_claim_id is null or p_checkout_attempt_id is null then
    raise exception 'launch discount claim: a code, a customer key, a claim id and a checkout attempt are all required';
  end if;

  v_code := upper(btrim(p_code));
  v_key  := lower(btrim(p_customer_key));
  v_ttl  := least(greatest(coalesce(p_ttl_seconds, 1800), 300), 86400);

  if not public.launch_discount_is_first_order(v_key) then
    return jsonb_build_object('claimed', false, 'state', null, 'outcome', 'not_first_order');
  end if;

  insert into public.launch_discount_claims as c (
    code, customer_key, state, claim_id, checkout_attempt_id,
    claimed_at, expires_at, released_at
  ) values (
    v_code, v_key, 'reserved', p_claim_id, p_checkout_attempt_id,
    v_now, v_now + make_interval(secs => v_ttl), null
  )
  on conflict (code, customer_key) do update
     set state               = 'reserved',
         claim_id            = excluded.claim_id,
         checkout_attempt_id = excluded.checkout_attempt_id,
         claimed_at          = excluded.claimed_at,
         expires_at          = excluded.expires_at,
         released_at         = null
   where c.state = 'released'
      or (c.state = 'reserved'
          and (c.claim_id = excluded.claim_id
               or c.expires_at <= excluded.claimed_at));

  get diagnostics v_rows = row_count;

  if v_rows = 1 then
    return jsonb_build_object('claimed', true, 'state', 'reserved', 'outcome', 'reserved');
  end if;

  -- The decision is already made and cannot be revisited. This read only
  -- names the reason, so a route can say something true to a customer.
  select state into v_state
  from public.launch_discount_claims
  where code = v_code and customer_key = v_key;

  return jsonb_build_object(
    'claimed', false,
    'state', v_state,
    'outcome', case v_state
                 when 'redeemed'        then 'already_redeemed'
                 when 'payment_pending' then 'payment_pending'
                 when 'reserved'        then 'held_by_another_checkout'
                 else 'unavailable'
               end
  );
end;
$$;

-- ══════════════════════════════════════════════════════════════
-- 7. THE DELAYED PAYMENT, AND GIVING THE CLAIM BACK
-- ══════════════════════════════════════════════════════════════

/**
 * The session completed but the money is still travelling.
 *
 * Moves a reservation to 'payment_pending' and CLEARS expires_at, which
 * the shape CHECK then keeps NULL. From here nothing can lapse the
 * claim: not this function, not claim_launch_discount, not time.
 *
 * ONLY THE CURRENT HOLDER, and idempotent for a redelivered webhook -
 * 'payment_pending' is an accepted starting state, so a second delivery
 * of the same event reports success rather than a failure somebody has
 * to interpret.
 *
 * Never from 'redeemed': a paid order does not go back to waiting.
 */
create or replace function public.mark_launch_discount_payment_pending(
  p_code text,
  p_customer_key text,
  p_claim_id uuid
)
returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_code  text;
  v_key   text;
  v_rows  integer;
  v_state text;
begin
  if p_code is null or p_customer_key is null or p_claim_id is null then
    raise exception 'launch discount payment pending: a code, a customer key and a claim id are required';
  end if;

  v_code := upper(btrim(p_code));
  v_key  := lower(btrim(p_customer_key));

  update public.launch_discount_claims
     set state      = 'payment_pending',
         expires_at = null
   where code = v_code
     and customer_key = v_key
     and claim_id = p_claim_id
     and state in ('reserved', 'payment_pending');

  get diagnostics v_rows = row_count;

  if v_rows = 1 then
    return jsonb_build_object('pending', true, 'state', 'payment_pending', 'outcome', 'payment_pending');
  end if;

  select state into v_state
  from public.launch_discount_claims
  where code = v_code and customer_key = v_key;

  return jsonb_build_object(
    'pending', false,
    'state', v_state,
    'outcome', case
                 when v_state is null      then 'no_claim'
                 when v_state = 'redeemed' then 'already_redeemed'
                 else 'not_holder'
               end
  );
end;
$$;

/**
 * The ordinary release: the customer abandoned the checkout, or the
 * session could not be created.
 *
 * ONLY FROM 'reserved', AND ONLY BY THE HOLDER. Two separate rules and
 * both matter:
 *
 *   the claim id must match    a caller whose reservation lapsed and was
 *                              taken over must not be able to release
 *                              the NEW holder's claim on its way out.
 *                              This is migration 049's rule, for the
 *                              same reason.
 *
 *   the state must be          a payment that may still succeed must
 *   'reserved'                 never lose its claim, and this path
 *                              cannot tell whether one is in flight. So
 *                              it simply cannot touch 'payment_pending'
 *                              at all - the guarantee is structural
 *                              rather than a condition somebody has to
 *                              get right. The one caller that KNOWS a
 *                              payment failed uses the next function.
 *
 * And never 'redeemed', which is terminal.
 *
 * A second call reports 'already_released' rather than a failure: a
 * release is a cleanup, and cleanup that complains about being done
 * twice produces noise instead of information.
 */
create or replace function public.release_launch_discount(
  p_code text,
  p_customer_key text,
  p_claim_id uuid
)
returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_code  text;
  v_key   text;
  v_rows  integer;
  v_state text;
begin
  if p_code is null or p_customer_key is null or p_claim_id is null then
    raise exception 'launch discount release: a code, a customer key and a claim id are required';
  end if;

  v_code := upper(btrim(p_code));
  v_key  := lower(btrim(p_customer_key));

  update public.launch_discount_claims
     set state               = 'released',
         claim_id            = null,
         checkout_attempt_id = null,
         expires_at          = null,
         released_at         = now()
   where code = v_code
     and customer_key = v_key
     and claim_id = p_claim_id
     and state = 'reserved';

  get diagnostics v_rows = row_count;

  if v_rows = 1 then
    return jsonb_build_object('released', true, 'state', 'released', 'outcome', 'released');
  end if;

  select state into v_state
  from public.launch_discount_claims
  where code = v_code and customer_key = v_key;

  return jsonb_build_object(
    'released', false,
    'state', v_state,
    'outcome', case
                 when v_state is null             then 'no_claim'
                 when v_state = 'released'        then 'already_released'
                 when v_state = 'redeemed'        then 'already_redeemed'
                 when v_state = 'payment_pending' then 'payment_pending'
                 else 'not_holder'
               end
  );
end;
$$;

/**
 * Stripe said the delayed payment FAILED. The money is not coming.
 *
 * The ONLY way out of 'payment_pending' other than redemption, and it
 * exists as a separate function rather than a flag on the one above so
 * that the ordinary abandon path CANNOT reach that state even by passing
 * the wrong argument. Reachable from 'reserved' too, because a failure
 * can arrive before anything marked the claim pending.
 *
 * Still only by the holder, and still never from 'redeemed' - if an
 * order exists, the money arrived, whatever a later event says.
 */
create or replace function public.release_launch_discount_after_failed_payment(
  p_code text,
  p_customer_key text,
  p_claim_id uuid
)
returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_code  text;
  v_key   text;
  v_rows  integer;
  v_state text;
begin
  if p_code is null or p_customer_key is null or p_claim_id is null then
    raise exception 'launch discount release after failed payment: a code, a customer key and a claim id are required';
  end if;

  v_code := upper(btrim(p_code));
  v_key  := lower(btrim(p_customer_key));

  update public.launch_discount_claims
     set state               = 'released',
         claim_id            = null,
         checkout_attempt_id = null,
         expires_at          = null,
         released_at         = now()
   where code = v_code
     and customer_key = v_key
     and claim_id = p_claim_id
     and state in ('reserved', 'payment_pending');

  get diagnostics v_rows = row_count;

  if v_rows = 1 then
    return jsonb_build_object('released', true, 'state', 'released', 'outcome', 'released');
  end if;

  select state into v_state
  from public.launch_discount_claims
  where code = v_code and customer_key = v_key;

  return jsonb_build_object(
    'released', false,
    'state', v_state,
    'outcome', case
                 when v_state is null      then 'no_claim'
                 when v_state = 'released' then 'already_released'
                 when v_state = 'redeemed' then 'already_redeemed'
                 else 'not_holder'
               end
  );
end;
$$;

-- ══════════════════════════════════════════════════════════════
-- 8. SPENDING THE CLAIM - TERMINAL, AND IT WINS
-- ══════════════════════════════════════════════════════════════

/**
 * Marks the claim spent by one order. TERMINAL.
 *
 * ── IT IS NOT GRANTED TO ANYBODY ──────────────────────────────
 *
 * There is exactly one door: create_order_from_paid_checkout calls it,
 * in the same transaction that creates the order. Being SECURITY
 * DEFINER, that call runs as the owner, so this function needs no grant
 * at all - and having none is the point. A redemption without an order,
 * or an order without its redemption, cannot be produced by the server
 * even by accident. That is 049's decision not to grant the refund lock
 * columns to service_role, applied to a function.
 *
 * ── REDEMPTION WINS OVER RESERVATION ──────────────────────────
 *
 * It succeeds from 'reserved', from 'payment_pending', from 'released',
 * and from no row at all - it does NOT require the caller to still be
 * the holder. That is deliberate, and it is the only defensible answer:
 * by the time this is called the customer HAS PAID a discounted amount.
 * Refusing to record the redemption because a reservation lapsed in the
 * meantime would leave a paid discounted order with no accounting of the
 * discount it used, which is strictly worse than recording it.
 *
 * ── AND IT NEVER ABORTS AN ORDER ──────────────────────────────
 *
 * The one case it cannot satisfy is a claim ALREADY redeemed by a
 * DIFFERENT order. It does not raise: the order being created has been
 * paid for, and raising would strand a real payment with no order - the
 * worst outcome available. So it counts the conflict on the row
 * (redemption_conflicts, last_conflict_at) and reports it, leaving a
 * number an operator can find. Expected to stay zero: reaching it needs
 * one person to pay two separately-discounted sessions for one address,
 * which the lapse window is sized to make rare and the first-order gate
 * independently discourages.
 *
 * A REDELIVERED WEBHOOK IS NOT THAT CASE. The same order id reports
 * 'already_redeemed' with redeemed true, and in practice does not even
 * get here: create_order_from_paid_checkout returns the existing order
 * before reaching this call.
 *
 * A REFUND DOES NOT COME BACK HERE. Nothing releases a redeemed claim,
 * by construction, so a refunded order leaves the code used - which is
 * the business rule.
 */
create or replace function public.redeem_launch_discount(
  p_code text,
  p_customer_key text,
  p_claim_id uuid,
  p_checkout_attempt_id uuid,
  p_order_id uuid
)
returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_code     text;
  v_key      text;
  v_now      timestamptz := now();
  v_rows     integer;
  v_order_id uuid;
begin
  if p_code is null or p_customer_key is null or p_claim_id is null
     or p_checkout_attempt_id is null or p_order_id is null then
    raise exception 'launch discount redemption: a code, a customer key, a claim id, a checkout attempt and an order are all required';
  end if;

  v_code := upper(btrim(p_code));
  v_key  := lower(btrim(p_customer_key));

  insert into public.launch_discount_claims as c (
    code, customer_key, state, claim_id, checkout_attempt_id, order_id,
    claimed_at, expires_at, redeemed_at
  ) values (
    v_code, v_key, 'redeemed', p_claim_id, p_checkout_attempt_id, p_order_id,
    v_now, null, v_now
  )
  on conflict (code, customer_key) do update
     set state               = 'redeemed',
         claim_id            = excluded.claim_id,
         checkout_attempt_id = excluded.checkout_attempt_id,
         order_id            = excluded.order_id,
         claimed_at          = coalesce(c.claimed_at, excluded.claimed_at),
         expires_at          = null,
         redeemed_at         = excluded.redeemed_at
   where c.state <> 'redeemed';

  get diagnostics v_rows = row_count;

  if v_rows = 1 then
    return jsonb_build_object('redeemed', true, 'state', 'redeemed', 'outcome', 'redeemed');
  end if;

  -- Already terminal. Either this very order settled it - a replay - or
  -- a different one did, which is the counted conflict.
  select order_id into v_order_id
  from public.launch_discount_claims
  where code = v_code and customer_key = v_key;

  if v_order_id = p_order_id then
    return jsonb_build_object('redeemed', true, 'state', 'redeemed', 'outcome', 'already_redeemed');
  end if;

  update public.launch_discount_claims
     set redemption_conflicts = redemption_conflicts + 1,
         last_conflict_at     = v_now
   where code = v_code and customer_key = v_key;

  return jsonb_build_object(
    'redeemed', false,
    'state', 'redeemed',
    'outcome', 'already_redeemed_by_another_order',
    'order_id', v_order_id
  );
end;
$$;

-- ══════════════════════════════════════════════════════════════
-- 9. THE PAID ORDER AND THE REDEMPTION, IN ONE TRANSACTION
-- ══════════════════════════════════════════════════════════════
--
-- SAME SIX-ARGUMENT SIGNATURE as migrations 016 and 021, so this is a
-- true in-place CREATE OR REPLACE: no second overload is left callable,
-- and no caller changes. The body is 021's, unchanged except for the
-- discount, and the discount needs no argument because the checkout
-- attempt already froze it - which is the same reason tax needs none.
--
-- WHAT IS ADDED, AND NOTHING ELSE:
--
--   1. the order records the discount it was charged with
--      (discount_total_cents, discount_code), copied from the attempt
--   2. if the attempt held a claim, the claim is spent HERE - inside the
--      same transaction as the INSERT, so there is no window in which an
--      order exists whose claim is unspent, and none in which a claim is
--      spent for an order that failed to be created. Atomic because it
--      is one transaction, not because anything retries.
--
-- BACKWARD COMPATIBLE BY CONSTRUCTION. An attempt with no discount has
-- discount_code NULL, so discount_total_cents is written as 0 -
-- identical to the column default this function relied on before -
-- discount_code stays NULL, and no redemption is attempted. Every one of
-- the 458 existing orders, and every undiscounted order after them, is
-- created exactly as it was.
--
-- The tax invariants, the subtotal, the immutability of an already
-- created order, the unique-violation race handler and the per-line
-- variant matching are 021's and are reproduced verbatim. Nothing about
-- them is relaxed: the frozen total is still the one Stripe was held to,
-- and the discount is inside it because lib/launchDiscount.ts folds the
-- discount into the line amounts BEFORE the attempt is written.
--
-- IT DOES NOT VALIDATE THE ARITHMETIC OF THE DISCOUNT. How the discount
-- is distributed - whether items_snapshot carries gross lines or lines
-- already net of it - is phase B's decision, and a cross-check written
-- here against a convention that does not exist yet would either be
-- wrong or would freeze the wrong one. What IS checked is that a
-- discounted attempt is coherent enough to account for: it names a code,
-- an amount, a claim and a customer.

create or replace function public.create_order_from_paid_checkout(
  p_checkout_attempt_id uuid,
  p_customer_snapshot jsonb,
  p_stripe_payment_intent_id text,
  p_shipping_address_snapshot jsonb,
  p_billing_address_snapshot jsonb,
  p_shipping_gross_cents integer
)
returns public.orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempt public.checkout_attempts;
  v_order public.orders;
  v_item jsonb;
  v_tax jsonb;
  v_tax_item jsonb;
  v_totals jsonb;
  v_subtotal_gross_cents integer := 0;
  v_redemption jsonb;
begin
  select * into v_attempt
  from public.checkout_attempts
  where id = p_checkout_attempt_id
  for update;

  if not found then
    raise exception 'checkout attempt % not found', p_checkout_attempt_id;
  end if;

  if v_attempt.status <> 'paid' then
    raise exception 'checkout attempt % is not paid (status=%)', p_checkout_attempt_id, v_attempt.status;
  end if;

  select * into v_order
  from public.orders
  where checkout_attempt_id = p_checkout_attempt_id;

  if found then
    -- Already created. A paid order's tax snapshot is immutable: a
    -- webhook redelivery returns it untouched, it is never refreshed
    -- against a newer tax state. The same is now true of its discount,
    -- and the claim it spent was spent in the transaction that created
    -- it - so a redelivery must not reach the redemption again either.
    return v_order;
  end if;

  -- A DISCOUNTED ATTEMPT MUST BE ACCOUNTABLE. The paired CHECK in
  -- section 3 already guarantees this; the raise is here because a
  -- constraint can be dropped by a later migration and a discounted
  -- order with no claim to spend must fail loudly rather than quietly
  -- become an unexplained reduction.
  if v_attempt.discount_code is not null
     and (v_attempt.discount_claim_id is null
          or v_attempt.customer_email is null
          or v_attempt.discount_gross_cents is null) then
    raise exception 'checkout attempt % carries discount code % without a claim id, a customer email or an amount',
      p_checkout_attempt_id, v_attempt.discount_code;
  end if;

  select coalesce(sum((item->>'lineGrossCents')::integer), 0)
    into v_subtotal_gross_cents
  from jsonb_array_elements(v_attempt.items_snapshot) as item;

  v_tax := v_attempt.tax_snapshot;
  v_totals := v_tax->'totals';

  if v_tax is not null then
    -- The tax snapshot must describe the very transaction being settled.
    -- A disagreement means the two were computed from different inputs,
    -- which is exactly the case where guessing would be worst.
    if (v_totals->>'shippingGrossCents')::integer is distinct from p_shipping_gross_cents then
      raise exception 'tax snapshot shipping (%) does not match the paid shipping (%) for attempt %',
        v_totals->>'shippingGrossCents', p_shipping_gross_cents, p_checkout_attempt_id;
    end if;
    if (v_totals->>'totalGrossCents')::integer is distinct from v_attempt.expected_total_gross_cents then
      raise exception 'tax snapshot total (%) does not match the expected total (%) for attempt %',
        v_totals->>'totalGrossCents', v_attempt.expected_total_gross_cents, p_checkout_attempt_id;
    end if;
  end if;

  begin
    insert into public.orders (
      user_id,
      customer_type,
      status,
      payment_status,
      currency,
      customer_snapshot,
      shipping_address_snapshot,
      billing_address_snapshot,
      subtotal_gross_cents,
      subtotal_net_cents,
      discount_total_cents,
      discount_code,
      shipping_net_cents,
      shipping_gross_cents,
      tax_total_cents,
      total_net_cents,
      total_gross_cents,
      tax_treatment,
      tax_jurisdiction_kind,
      tax_vat_country,
      tax_calculation_version,
      shipping_tax_allocation,
      placed_at,
      checkout_attempt_id,
      stripe_checkout_session_id,
      stripe_payment_intent_id
    ) values (
      v_attempt.user_id,
      'private',
      'confirmed',
      'paid',
      v_attempt.currency,
      coalesce(p_customer_snapshot, jsonb_build_object('email', null, 'name', null)),
      p_shipping_address_snapshot,
      p_billing_address_snapshot,
      v_subtotal_gross_cents,
      -- Still explicitly NULL when no tax was calculated (every non-EU
      -- destination): unknown, never a fabricated zero.
      (v_totals->>'subtotalNetCents')::integer,
      -- Zero, not NULL, when nothing was discounted: no discount is a
      -- real zero rather than an unknown, which is the decision 021
      -- wrote down and 004's NOT NULL default 0 already encoded.
      coalesce(v_attempt.discount_gross_cents, 0),
      v_attempt.discount_code,
      (v_totals->>'shippingNetCents')::integer,
      p_shipping_gross_cents,
      (v_totals->>'taxTotalCents')::integer,
      (v_totals->>'totalNetCents')::integer,
      v_attempt.expected_total_gross_cents,
      v_tax->>'treatment',
      v_tax->>'jurisdictionKind',
      v_tax->>'taxCountry',
      v_tax->>'calculationVersion',
      v_tax->'shipping'->'allocations',
      now(),
      v_attempt.id,
      v_attempt.stripe_checkout_session_id,
      p_stripe_payment_intent_id
    )
    returning * into v_order;
  exception
    when unique_violation then
      -- A concurrent call won the race between our lookup and insert.
      -- It also spent the claim, in its own transaction, so there is
      -- nothing to redeem here.
      select * into v_order from public.orders where checkout_attempt_id = p_checkout_attempt_id;
      if found then
        return v_order;
      end if;
      raise;
  end;

  for v_item in select * from jsonb_array_elements(v_attempt.items_snapshot)
  loop
    -- Matched on variantId, not position: the two arrays are built from
    -- the same quote, but relying on their order would be a silent
    -- mis-taxation the day that stops being true.
    select tax_item into v_tax_item
    from jsonb_array_elements(coalesce(v_tax->'items', '[]'::jsonb)) as tax_item
    where tax_item->>'variantId' = v_item->>'variantId'
    limit 1;

    if v_tax is not null and v_tax_item is null then
      raise exception 'tax snapshot for attempt % has no line for variant %',
        p_checkout_attempt_id, v_item->>'variantId';
    end if;

    insert into public.order_items (
      order_id,
      product_reference,
      sku,
      product_name,
      variant_name,
      quantity,
      unit_price_gross_cents,
      unit_price_net_cents,
      line_total_gross_cents,
      line_total_net_cents,
      tax_rate_percent,
      tax_category,
      metadata
    ) values (
      v_order.id,
      v_item->>'variantId',
      v_item->>'sku',
      v_item->>'productName',
      v_item->>'variantLabel',
      (v_item->>'quantity')::integer,
      (v_item->>'unitGrossCents')::integer,
      (v_tax_item->>'unitNetCents')::integer,
      (v_item->>'lineGrossCents')::integer,
      (v_tax_item->>'lineNetCents')::integer,
      (v_tax_item->>'taxRatePercent')::numeric,
      v_tax_item->>'taxCategory',
      jsonb_build_object('sizeGrams', v_item->'sizeGrams', 'currency', v_item->'currency')
    );
  end loop;

  -- ── THE CLAIM IS SPENT HERE, OR NOWHERE ─────────────────────
  --
  -- Same transaction as the order. If anything above raised, this never
  -- ran and the claim is untouched; if this raises, the order is rolled
  -- back with it. The one thing it will not do is refuse the order: see
  -- redeem_launch_discount's contract. The outcome is read into a
  -- variable so the intent is explicit rather than a discarded call.
  if v_attempt.discount_code is not null then
    v_redemption := public.redeem_launch_discount(
      v_attempt.discount_code,
      v_attempt.customer_email,
      v_attempt.discount_claim_id,
      v_attempt.id,
      v_order.id
    );

    if not (v_redemption->>'redeemed')::boolean then
      -- Counted on the claim row by the function itself. Not fatal, by
      -- design: the money has already moved.
      raise warning 'launch discount: order % settled attempt % but the claim was already spent (%)',
        v_order.id, v_attempt.id, v_redemption->>'outcome';
    end if;
  end if;

  return v_order;
end;
$$;

-- ══════════════════════════════════════════════════════════════
-- 10. WHO MAY CALL WHAT
-- ══════════════════════════════════════════════════════════════
--
-- END STATE, NOT A DELTA - the 052/053 lesson applied to functions.
-- Every function in PostgreSQL is created with EXECUTE granted to
-- PUBLIC, and Supabase may hold defaults for anon and authenticated on
-- top of that, so a bare `grant execute to service_role` would leave the
-- browser roles able to call it. Everything is revoked from all four
-- names first, and exactly what is needed is given back.
--
-- WHAT THE BROWSER CANNOT DO, as a consequence: it cannot read a claim,
-- take one, release one, mark one payment_pending, redeem one, ask
-- whether somebody is a first-time buyer, or influence the discount
-- amount. Not "does not"; cannot. The claims table has no grant at all
-- (section 2) and every door is revoked below.
--
-- AND redeem_launch_discount IS GRANTED TO NOBODY. Not even the server.
-- Its only caller is create_order_from_paid_checkout, which is SECURITY
-- DEFINER and therefore executes as the owner, so redemption is
-- reachable exclusively through creating the order it pays for.

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.launch_discount_is_first_order(text)',
    'public.claim_launch_discount(text, text, uuid, uuid, integer)',
    'public.mark_launch_discount_payment_pending(text, text, uuid)',
    'public.release_launch_discount(text, text, uuid)',
    'public.release_launch_discount_after_failed_payment(text, text, uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end $$;

revoke all on function public.redeem_launch_discount(text, text, uuid, uuid, uuid)
  from public, anon, authenticated, service_role;

-- Re-stated for the replaced function, because CREATE OR REPLACE keeps
-- whatever ACL the function already had and this file must be able to
-- say what that ACL IS rather than what it inherited.
revoke all on function public.create_order_from_paid_checkout(uuid, jsonb, text, jsonb, jsonb, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.create_order_from_paid_checkout(uuid, jsonb, text, jsonb, jsonb, integer)
  to service_role;

-- ══════════════════════════════════════════════════════════════
-- 11. THE END STATE IS PROVEN BEFORE COMMIT
-- ══════════════════════════════════════════════════════════════
--
-- Asserting the RESULT rather than counting what changed, so a second
-- run passes unchanged. A half-applied discount foundation is worse than
-- none: the runtime would take claims a state machine does not enforce.

do $$
declare
  v_missing text;
begin
  -- The ledger exists, keyed on the pair.
  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'launch_discount_claims'
  ) then
    raise exception '056: public.launch_discount_claims was not created';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.launch_discount_claims'::regclass
      and contype = 'p'
      and conkey = array[
        (select attnum from pg_attribute
          where attrelid = 'public.launch_discount_claims'::regclass and attname = 'code'),
        (select attnum from pg_attribute
          where attrelid = 'public.launch_discount_claims'::regclass and attname = 'customer_key')
      ]::smallint[]
  ) then
    raise exception '056: the claim ledger is not keyed on (code, customer_key) - one row per attempt is not a lock';
  end if;

  -- The state machine is a constraint, not a convention.
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.launch_discount_claims'::regclass
      and conname = 'launch_discount_claims_state_shape'
  ) then
    raise exception '056: the claim ledger has no state shape constraint';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.launch_discount_claims'::regclass
      and conname = 'launch_discount_claims_customer_key_normalized'
  ) then
    raise exception '056: the claim ledger does not force a canonical customer key';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.launch_discount_claims'::regclass
      and conname = 'launch_discount_claims_code_known'
  ) then
    raise exception '056: the claim ledger accepts a code other than GLOALAUNCH10';
  end if;

  -- RLS on, no policy, and no role holds anything.
  if not (select relrowsecurity from pg_class
          where oid = 'public.launch_discount_claims'::regclass) then
    raise exception '056: row level security is not enabled on the claim ledger';
  end if;

  if exists (select 1 from pg_policies
             where schemaname = 'public' and tablename = 'launch_discount_claims') then
    raise exception '056: the claim ledger has a policy - it must have none';
  end if;

  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'launch_discount_claims'
      and grantee in ('anon', 'authenticated', 'service_role')
  ) then
    raise exception '056: a role holds a privilege on the claim ledger - every door is a function';
  end if;

  -- The attempt can freeze a discount, coherently or not at all.
  select string_agg(c.needed, ', ')
    into v_missing
  from (values ('discount_code'), ('discount_gross_cents'), ('discount_claim_id')) as c(needed)
  where not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'checkout_attempts'
      and column_name = c.needed
  );
  if v_missing is not null then
    raise exception '056: checkout_attempts is missing column(s): %', v_missing;
  end if;

  for v_missing in
    select unnest(array['checkout_attempts_discount_snapshot_paired',
                        'checkout_attempts_discount_code_known',
                        'checkout_attempts_discount_one_time_only'])
  loop
    if not exists (
      select 1 from pg_constraint
      where conrelid = 'public.checkout_attempts'::regclass and conname = v_missing
    ) then
      raise exception '056: checkout_attempts is missing constraint %', v_missing;
    end if;
  end loop;

  -- The order names the code, and cannot name one without an amount.
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'orders'
      and column_name = 'discount_code'
  ) then
    raise exception '056: orders is missing column discount_code';
  end if;

  for v_missing in
    select unnest(array['orders_discount_code_known', 'orders_discount_code_paired'])
  loop
    if not exists (
      select 1 from pg_constraint
      where conrelid = 'public.orders'::regclass and conname = v_missing
    ) then
      raise exception '056: orders is missing constraint %', v_missing;
    end if;
  end loop;

  -- The first-order question has an index to answer it with.
  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and tablename = 'orders'
      and indexname = 'idx_orders_paid_customer_email_created_at'
  ) then
    raise exception '056: the paid-order-by-email index is missing';
  end if;

  -- Seven functions, every one of them SECURITY DEFINER with an empty
  -- search_path, and no older overload left callable beside them.
  for v_missing in
    select unnest(array['launch_discount_is_first_order',
                        'claim_launch_discount',
                        'mark_launch_discount_payment_pending',
                        'release_launch_discount',
                        'release_launch_discount_after_failed_payment',
                        'redeem_launch_discount',
                        'create_order_from_paid_checkout'])
  loop
    if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = v_missing) <> 1 then
      raise exception '056: public.% does not exist exactly once - an overload would be a second, unreviewed door', v_missing;
    end if;
    if not (select p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and p.proname = v_missing) then
      raise exception '056: public.% is not security definer', v_missing;
    end if;
    -- Both spellings are accepted because what is being asserted is the
    -- EMPTY search_path, not one particular way PostgreSQL happens to
    -- serialise it into proconfig. A check that guessed wrong would abort
    -- a correct migration, which is a worse failure than the one it was
    -- trying to catch. 'search_path=public' still fails, which is the
    -- thing that matters.
    if not exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace,
           unnest(coalesce(p.proconfig, array[]::text[])) as cfg(v)
      where n.nspname = 'public' and p.proname = v_missing
        and cfg.v in ('search_path=', 'search_path=""')
    ) then
      raise exception '056: public.% does not pin an empty search_path', v_missing;
    end if;
    -- And no browser role may call it.
    if exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = v_missing
        and (has_function_privilege('anon', p.oid, 'execute')
             or has_function_privilege('authenticated', p.oid, 'execute'))
    ) then
      raise exception '056: a browser role may execute public.%', v_missing;
    end if;
  end loop;

  -- Redemption has exactly one door, and it is not the server.
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'redeem_launch_discount'
      and has_function_privilege('service_role', p.oid, 'execute')
  ) then
    raise exception '056: service_role may execute redeem_launch_discount directly - redemption must only happen with an order';
  end if;

  -- AND THAT DOOR MUST ACTUALLY OPEN. redeem_launch_discount is granted
  -- to nobody, so the only reason the order writer can call it is that
  -- both are SECURITY DEFINER functions owned by the SAME role: inside
  -- the writer, current_user is that owner, and an owner keeps EXECUTE
  -- on its own function.
  --
  -- If 011's writer were owned by somebody else, the call would be
  -- refused at runtime and the refusal would roll back a PAID order -
  -- a customer charged with nothing to show for it. That must be found
  -- now, before commit, and not by a customer.
  if (select p.proowner from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'redeem_launch_discount')
     is distinct from
     (select p.proowner from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'create_order_from_paid_checkout') then
    raise exception '056: the order writer and the redemption have different owners - the redemption would be refused at runtime and would roll back a paid order';
  end if;

  -- And the server can still do its job.
  for v_missing in
    select unnest(array['launch_discount_is_first_order',
                        'claim_launch_discount',
                        'mark_launch_discount_payment_pending',
                        'release_launch_discount',
                        'release_launch_discount_after_failed_payment',
                        'create_order_from_paid_checkout'])
  loop
    if not exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = v_missing
        and has_function_privilege('service_role', p.oid, 'execute')
    ) then
      raise exception '056: service_role cannot execute public.%', v_missing;
    end if;
  end loop;

  -- This migration adds capacity, not data.
  if (select count(*) from public.launch_discount_claims) <> 0 then
    raise exception '056: the claim ledger is not empty - no business row belongs to a migration';
  end if;

  if exists (select 1 from public.checkout_attempts where discount_code is not null) then
    raise exception '056: an attempt was backfilled with a discount code';
  end if;

  if exists (select 1 from public.orders where discount_code is not null) then
    raise exception '056: an order was backfilled with a discount code';
  end if;
end $$;

commit;

-- ══════════════════════════════════════════════════════════════
-- VERIFYING THIS MIGRATION, read-only:
--
--   1. THE EXACT PRIVILEGE SET on the claim ledger. Grouped by role and
--      printing the grant option, because a per-row query is what missed
--      the problem in 052 and a list without is_grantable does not say
--      whether a role can pass on what it holds:
--        select grantee,
--               string_agg(privilege_type, ', ' order by privilege_type) as privileges,
--               string_agg(distinct is_grantable, ',') as grantable
--        from information_schema.role_table_grants
--        where table_schema = 'public'
--          and table_name = 'launch_discount_claims'
--          and grantee in ('anon', 'authenticated', 'service_role')
--        group by grantee;
--      -> NO ROWS. Not one of the three holds anything.
--
--   1b. And no write verb survives anywhere, asked the other way round:
--        select grantee, privilege_type
--        from information_schema.role_table_grants
--        where table_schema = 'public'
--          and table_name = 'launch_discount_claims'
--          and privilege_type in ('UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER');
--      -> NO ROWS.
--
--   2. Nothing in a browser can reach it the other way either:
--        select relrowsecurity from pg_class
--        where oid = 'public.launch_discount_claims'::regclass;   -> true
--        select count(*) from pg_policies
--        where tablename = 'launch_discount_claims';              -> 0
--
--   3. Every door, and who may open it:
--        select p.proname, p.prosecdef, p.proconfig,
--               has_function_privilege('service_role',  p.oid, 'execute') as service_role,
--               has_function_privilege('anon',          p.oid, 'execute') as anon,
--               has_function_privilege('authenticated', p.oid, 'execute') as authenticated
--        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--        where n.nspname = 'public'
--          and p.proname in ('launch_discount_is_first_order',
--                            'claim_launch_discount',
--                            'mark_launch_discount_payment_pending',
--                            'release_launch_discount',
--                            'release_launch_discount_after_failed_payment',
--                            'redeem_launch_discount',
--                            'create_order_from_paid_checkout')
--        order by p.proname;
--      -> prosecdef true and proconfig {search_path=} for all seven.
--      -> anon false and authenticated false for all seven.
--      -> service_role true for six, and FALSE for redeem_launch_discount.
--
--   3b. No overload was left behind. Every name above must return
--       exactly ONE row:
--        select proname, count(*) from pg_proc p
--        join pg_namespace n on n.oid = p.pronamespace
--        where n.nspname = 'public' and proname in (
--          'launch_discount_is_first_order','claim_launch_discount',
--          'mark_launch_discount_payment_pending','release_launch_discount',
--          'release_launch_discount_after_failed_payment',
--          'redeem_launch_discount','create_order_from_paid_checkout')
--        group by proname order by proname;
--
--   4. The state machine is a constraint. This should REFUSE:
--        insert into public.launch_discount_claims
--          (code, customer_key, state) values
--          ('GLOALAUNCH10', 'a@b.de', 'reserved');
--      -> new row violates check constraint
--         "launch_discount_claims_state_shape"   (no claim id, no expiry)
--      And so should a code that is not the code, and a key that is not
--      canonical:
--        ... values ('SOMETHINGELSE', 'a@b.de', 'released');   -> refused
--        ... values ('GLOALAUNCH10', 'A@B.de', 'released');    -> refused
--
--   5. The first-order cutoff sees the August test orders as history:
--        select count(*) from public.orders
--        where payment_status = 'paid'
--          and created_at >= timestamptz '2026-10-01 12:00:00+02';
--      -> 0 today, which is why every address is still a first order:
--        select public.launch_discount_is_first_order('nobody@example.com');
--      -> true
--      And the index is the one answering it:
--        explain (costs off) select 1 from public.orders
--        where payment_status = 'paid'
--          and lower(btrim(customer_snapshot->>'email')) = 'nobody@example.com'
--          and created_at >= timestamptz '2026-10-01 12:00:00+02';
--      -> Index Scan using idx_orders_paid_customer_email_created_at
--
--   6. NOTHING ELSE MOVED. This migration adds capacity, not data:
--        select count(*) from public.launch_discount_claims;  -> 0
--        select count(*) from public.checkout_attempts;       -> unchanged (729)
--        select count(*) from public.orders;                  -> unchanged (458)
--        select count(*) from public.order_items;             -> unchanged (458)
--        select count(*) from public.subscriptions;           -> unchanged (4)
--        select count(*) from public.stripe_customers;        -> unchanged (3)
--        select count(*) from public.product_variants;        -> unchanged (4)
--        select count(*) from public.checkout_customer_identities; -> unchanged (0)
--      And nothing was backfilled:
--        select count(*) from public.checkout_attempts
--        where discount_code is not null;                     -> 0
--        select count(*) from public.orders
--        where discount_code is not null;                     -> 0
--        select count(*) from public.orders
--        where discount_total_cents <> 0;                     -> 0
-- ══════════════════════════════════════════════════════════════
