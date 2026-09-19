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
-- ══════════════════════════════════════════════════════════════
-- THE INVARIANT THIS FILE EXISTS TO HOLD
-- ══════════════════════════════════════════════════════════════
--
--   AT MOST ONE PAYABLE DISCOUNTED STRIPE CHECKOUT SESSION PER
--   (code, normalised customer email) AT ANY MOMENT.
--
-- Not "rarely two". Not "two, but counted". One. Everything below is
-- shaped by that sentence, and the state model exists because a
-- reservation with a timeout CANNOT hold it.
--
-- ── WHY A TIMEOUT ALONE IS NOT ENOUGH ─────────────────────────
--
-- A Stripe Checkout Session is payable from the moment it is created
-- until Stripe expires it, which is up to 24 hours later - NOT until
-- the customer closes the tab, and not until some reservation of ours
-- runs out. So a claim that merely lapsed after thirty minutes would
-- become takeable by a second checkout while the FIRST checkout's
-- session was still sitting in a browser tab, still payable, still
-- discounted. Both could then be paid. That is two discounted orders
-- for one address, and no amount of counting afterwards turns it back
-- into one.
--
-- Protecting only the delayed-payment window is not enough either:
-- 'payment_pending' begins at checkout.session.completed, and the
-- dangerous interval starts long BEFORE that - the moment Stripe hands
-- back a payable session.
--
-- ══════════════════════════════════════════════════════════════
-- WHAT A NULL SESSION ID DOES AND DOES NOT PROVE
-- ══════════════════════════════════════════════════════════════
--
-- THIS IS THE CORRECTION THIS FILE IS BUILT AROUND, and it is worth
-- stating as bluntly as possible:
--
--   stripe_checkout_session_id IS NULL
--   does NOT mean "Stripe has no payable session for this claim".
--   It means "PostgreSQL has not been told of one".
--
-- Those are different sentences, and the difference is a crash. Stripe
-- can create a Session, return 200, and have the process die before the
-- id reaches a committed row - or during the request, or in the network
-- in between. In every one of those the database holds NULL and a
-- payable discounted session exists in the world.
--
-- So a state whose only evidence is a NULL column can never be allowed
-- to lapse into takeability once a Stripe create request might have
-- started. The database cannot learn the truth after the fact; it can
-- only be told BEFORE, and that is what 'session_creating' is for.
--
-- ── THE STATE MODEL, AND WHAT EACH STATE PROMISES ─────────────
--
--   reserved         The claim is held and NO STRIPE CREATE REQUEST HAS
--                    BEEN STARTED for it. That is not inferred from a
--                    NULL column - it is guaranteed by the ordering
--                    rule below, which the database enforces by
--                    refusing to record a session for any claim that
--                    did not first commit 'session_creating'. This is
--                    the ONLY state that can lapse, and its TTL is
--                    short: it covers the moment between taking the
--                    claim and declaring the intent to call Stripe.
--
--   session_creating A Stripe create request MAY BE IN FLIGHT, MAY HAVE
--                    ALREADY SUCCEEDED, or may never have left - the
--                    database deliberately cannot tell, and does not
--                    need to. Committed BEFORE Stripe is called, so it
--                    covers every crash point around the call.
--                    expires_at is NULL and the shape CHECK forbids
--                    anything else: it cannot lapse, and it is absent
--                    from every takeover condition. This is the state
--                    that closes the process-crash race.
--
--   session_open     The Session id is durably recorded. Still
--                    unexpirable, still un-takeable. It leaves only on
--                    an authoritative Stripe signal: completed (to
--                    payment_pending or to redeemed), expired (to
--                    released), or a failed asynchronous payment (to
--                    released).
--
--   payment_pending  The session completed but the money is still
--                    travelling - SEPA Direct Debit and the
--                    bank-transfer family confirm DAYS later. Also
--                    unexpirable and also not takeable: a payment that
--                    will SUCCEED must never lose its claim.
--
--   released         Nobody holds it. Safely available again, and the
--                    only way back to it is a signal that says the
--                    previous session can no longer be paid.
--
--   redeemed         TERMINAL. An order exists. Never released, never
--                    re-reserved, and a refund does not undo it.
--
-- ── THE ORDERING RULE PHASE B MUST OBEY ───────────────────────
--
--   1. claim_launch_discount                  -> reserved
--   2. mark_launch_discount_session_creating  -> session_creating
--      AND THAT COMMIT MUST LAND BEFORE the Stripe create request is
--      issued. Not concurrently, not afterwards, not best-effort.
--   3. call Stripe
--   4. mark_launch_discount_session_open      -> session_open
--
-- The database enforces step 2 rather than trusting it:
-- mark_launch_discount_session_open accepts 'session_creating' (and a
-- same-session retry of 'session_open') and NOTHING ELSE. A claim that
-- went straight from 'reserved' to a created Session is refused with
-- 'session_creating_required', loudly, in phase B's tests - rather than
-- being silently recorded and leaving the crash window open.
--
-- ── WHO "THE HOLDER" IS, AND IT IS A PAIR ────────────────────
--
-- A claim is held by (claim_id, checkout_attempt_id) TOGETHER, never by
-- the token alone. The token is minted per checkout attempt, so in
-- ordinary operation the two always travel together - but "ordinarily"
-- is not a security property, and a rule with an exception is a rule
-- somebody will get wrong. Every function that acts on an ACTIVE claim
-- therefore proves both, including the idempotent retry path of
-- claim_launch_discount itself: a second attempt presenting the same
-- token is NOT the holder, and it does not get to move the claim onto
-- itself.
--
-- The one place the pair is not required is acquisition from a state
-- nobody holds - 'released', or a 'reserved' row whose expiry has
-- passed - because there is no holder there to impersonate.
--
-- ── STRIPE IDEMPOTENCY IS PART OF THE INVARIANT ───────────────
--
-- Retrying step 3 must retry the SAME Stripe create operation, not
-- start a second one. Phase B must send a deterministic
-- Idempotency-Key derived from the checkout attempt and the claim
-- token, so that a retry after an ambiguous failure returns the session
-- that may already exist instead of minting a rival. Two payable
-- sessions produced by our own retry loop would defeat everything
-- below.
--
-- ── AMBIGUOUS FAILURE: KEEP THE CLAIM LOCKED ──────────────────
--
-- A network timeout, a dropped connection or a dead process does not
-- tell us whether Stripe created anything. session_creating is
-- therefore NOT released because a call threw. It is released only when
-- something authoritative says the session cannot be paid: Stripe's own
-- expiry event, or a failed asynchronous payment. If Stripe definitively
-- proves no session exists, a controlled release is possible - but
-- ambiguity is never resolved in the generous direction.
--
-- ── PROCESS-CRASH BEHAVIOUR, CHOSEN DELIBERATELY ──────────────
--
-- A process that dies inside the Stripe call leaves a claim in
-- 'session_creating' with no timer that will ever free it. That
-- customer's discount is locked until an authoritative Stripe signal
-- arrives (the session expires within 24 hours and Stripe says so), or
-- until a controlled reconciliation releases it.
--
-- THAT IS THE INTENDED TRADE. A temporarily locked discount is a
-- support conversation. Two independently payable discounted sessions
-- is money out of the door and an accounting record that cannot be
-- explained. Phase A buys the first and refuses the second; automatic
-- recovery belongs to a later, deliberate reconciliation path, not to a
-- timeout that cannot know what it is freeing.
--
-- AND A PAID CUSTOMER IS NEVER STRANDED BY IT. If the crash happened
-- after Stripe created the session, the paid webhook still carries the
-- authoritative Session id: phase B moves the same holder
-- 'session_creating' -> 'session_open' with that id and settles
-- normally, and redemption accepts a claim held in 'session_creating'
-- as well. The lock costs a retry, never an order.
--
-- There is no accepted trade anywhere in this design that permits two
-- payable discounted sessions for one address. redemption_conflicts
-- below is ANOMALY TELEMETRY, NOT A BUDGET - a number that must stay
-- zero and that an operator can alert on - and it is never a licence
-- for a second discounted order.
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
  -- counter: every transition compares against it, so a caller whose
  -- reservation lapsed cannot act on the claim that replaced it.
  claim_id             uuid,
  checkout_attempt_id  uuid references public.checkout_attempts(id),

  -- WHEN THE HOLDER DECLARED IT WAS ABOUT TO CALL STRIPE. Written
  -- BEFORE the call, which is the whole point: from this instant the
  -- claim is no longer takeable, because from this instant a payable
  -- session may exist whether or not we ever hear about it. It is also
  -- the "stuck since" an operator needs when a crashed checkout has to
  -- be reconciled by hand.
  session_creating_at  timestamptz,

  -- THE PAYABLE SESSION, ONCE WE DURABLY KNOW ITS ID. Its being NULL
  -- proves nothing about Stripe - see the header - which is exactly why
  -- the state, and not this column, is what governs takeability.
  stripe_checkout_session_id text,
  session_opened_at    timestamptz,

  -- Set once, when the claim becomes terminal.
  order_id             uuid references public.orders(id),

  claimed_at           timestamptz,
  -- NULL means "cannot lapse", which is true of every state except
  -- 'reserved'. See the shape CHECK.
  expires_at           timestamptz,
  released_at          timestamptz,
  redeemed_at          timestamptz,

  -- ANOMALY TELEMETRY, NOT A BUDGET. A redemption that met a claim a
  -- DIFFERENT order had already spent, or one held by a different
  -- holder. The state machine makes both unreachable in normal
  -- operation, so this must stay 0 forever and a non-zero value is an
  -- incident rather than an accepted cost. It is recorded rather than
  -- raised for one reason: by the time it can happen the customer HAS
  -- PAID, and refusing the order would strand a real payment. See
  -- section 8.
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
  -- THE LINES THAT CARRY THE WHOLE INVARIANT:
  --
  --   'reserved'         expires_at NOT NULL, session_creating_at NULL.
  --                      The only lapsable state, and the only one in
  --                      which no Stripe create request has been
  --                      declared.
  --   'session_creating' expires_at NULL, session_creating_at NOT NULL.
  --                      A Stripe create request may be in flight or
  --                      may already have succeeded. Nothing lapses it
  --                      and nothing takes it.
  --   'session_open'     expires_at NULL, stripe_checkout_session_id
  --                      NOT NULL, and session_creating_at NOT NULL -
  --                      which makes "every open session was declared
  --                      before it was created" a property of the row
  --                      rather than a hope about the caller.
  --
  --   reserved         a checkout holds it, no Stripe call declared;
  --                    it CAN lapse
  --   session_creating a Stripe create request may exist; it CANNOT
  --                    lapse and CANNOT be taken over
  --   session_open     a payable discounted Stripe session is recorded;
  --                    it CANNOT lapse and CANNOT be taken over
  --   payment_pending  a delayed payment is in flight; it CANNOT lapse
  --                    and CANNOT be taken over
  --   released         nobody holds it; anybody with this email may take it
  --   redeemed         TERMINAL. An order exists. Never released, never
  --                    re-reserved, and a refund does not undo it.
  constraint launch_discount_claims_state_shape check (
    case state
      when 'reserved' then
        claim_id is not null and checkout_attempt_id is not null
        and claimed_at is not null and expires_at is not null
        and session_creating_at is null
        and stripe_checkout_session_id is null and session_opened_at is null
        and released_at is null
        and redeemed_at is null and order_id is null
      when 'session_creating' then
        claim_id is not null and checkout_attempt_id is not null
        and claimed_at is not null and expires_at is null
        and session_creating_at is not null
        and stripe_checkout_session_id is null and session_opened_at is null
        and released_at is null
        and redeemed_at is null and order_id is null
      when 'session_open' then
        claim_id is not null and checkout_attempt_id is not null
        and claimed_at is not null and expires_at is null
        and session_creating_at is not null
        and stripe_checkout_session_id is not null and session_opened_at is not null
        and released_at is null
        and redeemed_at is null and order_id is null
      when 'payment_pending' then
        claim_id is not null and checkout_attempt_id is not null
        and claimed_at is not null and expires_at is null
        and released_at is null
        and redeemed_at is null and order_id is null
      when 'released' then
        claim_id is null and checkout_attempt_id is null
        and expires_at is null and released_at is not null
        and session_creating_at is null
        and stripe_checkout_session_id is null and session_opened_at is null
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
  'One mutable row per (launch code, normalised customer email). The durable one-use lock for GLOALAUNCH10, and the guarantee that at most one discounted Stripe session is payable for an address at a time. Not a redemption log and not a promotions engine.';
comment on column public.launch_discount_claims.customer_key is
  'Normalised authoritative checkout email - lower(btrim(...)), the same canonical form as checkout_attempts.customer_email.';
comment on column public.launch_discount_claims.session_creating_at is
  'When the holder declared it was about to call Stripe. Written BEFORE the call, so the claim stops being takeable before any session can exist. Also the stuck-since instant for reconciling a crashed checkout.';
comment on column public.launch_discount_claims.stripe_checkout_session_id is
  'The payable discounted Checkout Session, once its id is durably known. NULL proves only that this database has not been told of one - never that Stripe has none.';
comment on column public.launch_discount_claims.expires_at is
  'When a reservation lapses. Only reserved ever carries one: once a Stripe create request has been declared, nothing may lapse the claim.';
comment on column public.launch_discount_claims.redemption_conflicts is
  'Anomaly telemetry. Redemptions that met a claim already spent by another order or held by another checkout. The state machine makes both unreachable in normal operation, so this must stay 0; a non-zero value is an incident, not an allowance.';

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
-- basket is (the smallest tin is 14,99 EUR). Stated as a constraint
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
 * ── WHAT 'reserved' MEANS, EXACTLY ────────────────────────────
 *
 * NO STRIPE CREATE REQUEST HAS BEEN DECLARED FOR THIS CLAIM. That is
 * the claim being made, and it is NOT an inference from a NULL session
 * id - a NULL id proves only that this database has not been told of a
 * session. It is guaranteed instead by ordering, which the database
 * enforces: mark_launch_discount_session_open refuses to record a
 * session for any claim that has not first committed 'session_creating',
 * so a 'reserved' row cannot be the predecessor of a recorded session.
 *
 * That is what makes a lapse safe here and in no other state.
 *
 * Phase B must move the claim to 'session_creating' BEFORE it issues
 * the Stripe create request. From that commit onwards nothing can lapse
 * or take the claim, whatever happens to the process.
 *
 * ── WHEN A CLAIM MAY BE TAKEN ─────────────────────────────────
 *
 *   the row does not exist      nobody has ever used the code here
 *   state = 'released'          an authoritative Stripe signal said the
 *                               previous session can never be paid
 *   state = 'reserved' and the  the SAME request again. Idempotent: the
 *   claim id AND the attempt    reservation is refreshed and the caller
 *   are both the caller's       is told it holds it. A retried checkout
 *                               must not be refused its own claim.
 *   state = 'reserved' and the  the previous reservation lapsed BEFORE
 *   reservation has lapsed      any Stripe work was declared
 *
 * THE PAIR IS REQUIRED, NOT JUST THE TOKEN. An ACTIVE reservation held
 * by attempt A must not be moved onto attempt B because B happened to
 * present A's claim id - that is not a retry, it is a different
 * checkout taking over a live claim, and the row would silently start
 * pointing at the wrong attempt. Such a caller affects zero rows and is
 * told 'held_by_another_attempt'. Acquisition from 'released' or from a
 * LAPSED 'reserved' row needs no pair, because there is no holder there
 * to impersonate.
 *
 * AND NEVER OTHERWISE. Four states are excluded ENTIRELY - not "unless
 * they are old", not "unless the same caller asks":
 *
 *   'session_creating' a Stripe create request may be in flight or may
 *                      already have succeeded. This is the state that
 *                      exists because a crash between the call and the
 *                      commit is invisible to us; taking the claim here
 *                      is exactly the bug it closes.
 *   'session_open'     a discounted session is payable RIGHT NOW.
 *   'payment_pending'  a payment that may still succeed must never lose
 *                      its claim.
 *   'redeemed'         terminal.
 *
 * Moving any of them back to 'reserved' would also restore an
 * expires_at, which could then lapse them - so their absence from the
 * WHERE is doing two jobs.
 *
 * ── THE LAPSE, AND WHY IT IS SHORT ────────────────────────────
 *
 * The only thing a lapse recovers from is a process that died between
 * taking the claim and declaring 'session_creating'. Both are database
 * round trips with no external call between them, so the TTL is sized
 * for that: five minutes by default, floored at 60 seconds so a caller
 * cannot pass a value small enough to make the reservation meaningless,
 * and capped at an hour so a crash cannot hold the code hostage for a
 * day.
 *
 * It is deliberately NOT sized for an abandoned basket, and extending
 * it is not how any of this is made safe. An abandoned basket has a
 * payable session behind it, and a payable session is released by
 * Stripe telling us it is finished - never by a timer of ours guessing.
 *
 * ── AND IT IS THE FIRST-ORDER GATE TOO ────────────────────────
 *
 * Checked here rather than left to the caller, so the two halves of
 * eligibility cannot be enforced in two places with two answers. The
 * check sits before the upsert: two simultaneous callers can both read
 * "no paid order yet", but only one of them can then take the claim,
 * which is the invariant that matters.
 *
 * Returns { claimed, state, outcome, holder }.
 */
create or replace function public.claim_launch_discount(
  p_code text,
  p_customer_key text,
  p_claim_id uuid,
  p_checkout_attempt_id uuid,
  p_ttl_seconds integer default 300
)
returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_code       text;
  v_key        text;
  v_ttl        integer;
  v_now        timestamptz := now();
  v_rows       integer;
  v_state      text;
  v_claim_id   uuid;
  v_attempt_id uuid;
begin
  if p_code is null or p_customer_key is null
     or p_claim_id is null or p_checkout_attempt_id is null then
    raise exception 'launch discount claim: a code, a customer key, a claim id and a checkout attempt are all required';
  end if;

  v_code := upper(btrim(p_code));
  v_key  := lower(btrim(p_customer_key));
  v_ttl  := least(greatest(coalesce(p_ttl_seconds, 300), 60), 3600);

  if not public.launch_discount_is_first_order(v_key) then
    return jsonb_build_object('claimed', false, 'state', null, 'outcome', 'not_first_order');
  end if;

  insert into public.launch_discount_claims as c (
    code, customer_key, state, claim_id, checkout_attempt_id,
    claimed_at, expires_at, released_at,
    session_creating_at, stripe_checkout_session_id, session_opened_at
  ) values (
    v_code, v_key, 'reserved', p_claim_id, p_checkout_attempt_id,
    v_now, v_now + make_interval(secs => v_ttl), null,
    null, null, null
  )
  on conflict (code, customer_key) do update
     set state                      = 'reserved',
         claim_id                   = excluded.claim_id,
         checkout_attempt_id        = excluded.checkout_attempt_id,
         claimed_at                 = excluded.claimed_at,
         expires_at                 = excluded.expires_at,
         released_at                = null,
         -- A NEW RESERVATION HAS DECLARED NOTHING AND OWNS NO SESSION.
         -- Written explicitly rather than relied upon: the shape CHECK
         -- forbids 'reserved' from carrying either, and a takeover must
         -- never inherit the previous holder's Stripe work.
         session_creating_at        = null,
         stripe_checkout_session_id = null,
         session_opened_at          = null
   where c.state = 'released'
      or (c.state = 'reserved'
          and ((c.claim_id = excluded.claim_id
                and c.checkout_attempt_id = excluded.checkout_attempt_id)
               or c.expires_at <= excluded.claimed_at));

  get diagnostics v_rows = row_count;

  if v_rows = 1 then
    return jsonb_build_object('claimed', true, 'state', 'reserved', 'outcome', 'reserved');
  end if;

  -- The decision is already made and cannot be revisited. This read only
  -- names the reason, so a route can say something true to a customer -
  -- and says whether the refusing row belongs to this caller, which is
  -- what lets a retried checkout recognise its own Stripe work instead
  -- of trying to start a second lot of it.
  select state, claim_id, checkout_attempt_id
    into v_state, v_claim_id, v_attempt_id
  from public.launch_discount_claims
  where code = v_code and customer_key = v_key;

  return jsonb_build_object(
    'claimed', false,
    'state', v_state,
    -- THE PAIR, not the token: a caller holding somebody else's claim id
    -- with its own attempt is not the holder and is not told it is.
    'holder', (v_claim_id is not null and v_claim_id = p_claim_id
               and v_attempt_id = p_checkout_attempt_id),
    'outcome', case
                 when v_state = 'redeemed'         then 'already_redeemed'
                 when v_state = 'payment_pending'  then 'payment_pending'
                 when v_state = 'session_open'     then 'session_open'
                 when v_state = 'session_creating' then 'session_creating'
                 when v_state = 'reserved'
                      and v_claim_id = p_claim_id  then 'held_by_another_attempt'
                 when v_state = 'reserved'         then 'held_by_another_checkout'
                 else 'unavailable'
               end
  );
end;
$$;

-- ══════════════════════════════════════════════════════════════
-- 7. THE STRIPE CALL, THE DELAYED PAYMENT, AND GIVING IT BACK
-- ══════════════════════════════════════════════════════════════

/**
 * ABOUT TO CALL STRIPE. Close the claim to everybody else FIRST.
 *
 * THIS IS THE FUNCTION THAT CLOSES THE PROCESS-CRASH RACE, and it does
 * it by being called BEFORE the thing it protects against exists.
 *
 * The race it closes: Stripe creates a payable discounted session, the
 * process dies before the id can be committed, the database still holds
 * a lapsable 'reserved' row, the reservation times out, a second
 * checkout takes the code and opens a SECOND payable session. Nothing
 * observed after the fact can prevent that, because the database is
 * never told the first session exists. The only cure is to stop being
 * takeable BEFORE the call, and that is all this function does.
 *
 * ── PHASE B'S ORDERING OBLIGATION ─────────────────────────────
 *
 *   commit this transition, THEN issue the Stripe create request.
 *
 * Not concurrently. Not afterwards. Not best-effort. The transition is
 * one round trip against a primary-key lookup, and it is the price of
 * the invariant.
 *
 * ── WHAT THE STATE DELIBERATELY DOES NOT CLAIM ────────────────
 *
 * 'session_creating' does not assert that a session exists, or that one
 * does not. It asserts that one MIGHT, which is the only honest thing
 * the database can hold across an external call. That is why it carries
 * no session id, and why nothing about it may be resolved by a timer.
 *
 * ── OWNERSHIP AND IDEMPOTENCY ─────────────────────────────────
 *
 * The claim token AND the attempt it was minted for must both match. A
 * same-holder retry is idempotent and keeps the FIRST
 * session_creating_at, so the stuck-since instant an operator would
 * reconcile against is the real one. A foreign claim id affects zero
 * rows and is told 'not_holder'.
 *
 * It never runs backwards: 'session_open' (the id is already known),
 * 'payment_pending' (the session already completed) and 'redeemed' (an
 * order exists) are all refused, each with its own outcome word so a
 * retried checkout can recognise its own progress.
 */
create or replace function public.mark_launch_discount_session_creating(
  p_code text,
  p_customer_key text,
  p_claim_id uuid,
  p_checkout_attempt_id uuid
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
  v_state    text;
  v_claim_id uuid;
begin
  if p_code is null or p_customer_key is null or p_claim_id is null
     or p_checkout_attempt_id is null then
    raise exception 'launch discount session creating: a code, a customer key, a claim id and a checkout attempt are all required';
  end if;

  v_code := upper(btrim(p_code));
  v_key  := lower(btrim(p_customer_key));

  update public.launch_discount_claims
     set state               = 'session_creating',
         expires_at          = null,
         -- The FIRST declaration, kept across retries.
         session_creating_at = coalesce(session_creating_at, v_now)
   where code = v_code
     and customer_key = v_key
     and claim_id = p_claim_id
     and checkout_attempt_id = p_checkout_attempt_id
     and state in ('reserved', 'session_creating');

  get diagnostics v_rows = row_count;

  if v_rows = 1 then
    return jsonb_build_object('creating', true, 'state', 'session_creating', 'outcome', 'session_creating');
  end if;

  select state, claim_id into v_state, v_claim_id
  from public.launch_discount_claims
  where code = v_code and customer_key = v_key;

  return jsonb_build_object(
    'creating', false,
    'state', v_state,
    'outcome', case
                 when v_state is null             then 'no_claim'
                 when v_state = 'redeemed'        then 'already_redeemed'
                 when v_state = 'payment_pending' then 'payment_pending'
                 when v_state = 'session_open'
                      and v_claim_id = p_claim_id then 'session_already_open'
                 else 'not_holder'
               end
  );
end;
$$;

/**
 * STRIPE'S SESSION ID IS NOW DURABLY KNOWN. Record it.
 *
 * The claim was already un-takeable before this ran - that is
 * mark_launch_discount_session_creating's job, and it happened before
 * Stripe was called. This function adds the identity of the session, so
 * that Stripe's later expiry notice can be matched to the claim that
 * opened it and so that an operator can see what is outstanding.
 *
 * ── IT ACCEPTS 'session_creating', AND NOT 'reserved' ─────────
 *
 * That refusal is the ordering rule made structural. A claim that went
 * straight from 'reserved' to a created Stripe session skipped the only
 * step that protects the crash window, and recording its id would paper
 * over a checkout that is still racing. So it is refused with
 * 'session_creating_required' - loudly, where phase B's tests will see
 * it - rather than accepted because accepting looks more forgiving.
 *
 * The only other accepted starting state is 'session_open' with the
 * SAME session id, which is a retry.
 *
 * ── IT IS ALSO THE CRASH-RECOVERY DOOR ────────────────────────
 *
 * If the process died after Stripe created the session, the claim is
 * sitting in 'session_creating' with no id. The paid webhook carries
 * the authoritative id, so phase B calls exactly this function with it
 * and the claim converges on the truth: same holder, same attempt,
 * 'session_creating' -> 'session_open'. A real paid customer is never
 * stranded by the lock; the lock costs a retry, not an order.
 *
 * ── OWNERSHIP IS PROVEN THREE WAYS ────────────────────────────
 *
 *   claim_id             the rotating holder token, as everywhere else
 *   checkout_attempt_id  the attempt that token was minted for
 *   state                'session_creating', or 'session_open' with the
 *                        SAME session id
 *
 * A different claim id cannot mark, cannot overwrite and cannot learn
 * anything: it affects zero rows, is told 'not_holder', and is told
 * nothing about the session that does hold it.
 *
 * A DIFFERENT session id while one is already open is refused -
 * 'session_already_open'. Two payable sessions for one claim is exactly
 * the thing that must not exist, so the database will not record the
 * second; phase B must expire it through the Stripe API, and must use a
 * deterministic idempotency key so that its retries cannot mint one in
 * the first place.
 *
 * Never from 'payment_pending' and never from 'redeemed'.
 */
create or replace function public.mark_launch_discount_session_open(
  p_code text,
  p_customer_key text,
  p_claim_id uuid,
  p_checkout_attempt_id uuid,
  p_stripe_checkout_session_id text
)
returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_code       text;
  v_key        text;
  v_session    text;
  v_now        timestamptz := now();
  v_rows       integer;
  v_state      text;
  v_claim_id   uuid;
  v_open       text;
begin
  if p_code is null or p_customer_key is null or p_claim_id is null
     or p_checkout_attempt_id is null then
    raise exception 'launch discount session open: a code, a customer key, a claim id and a checkout attempt are all required';
  end if;

  v_session := btrim(coalesce(p_stripe_checkout_session_id, ''));
  if v_session = '' then
    raise exception 'launch discount session open: a stripe checkout session id is required - a session that cannot be named cannot be accounted for';
  end if;

  v_code := upper(btrim(p_code));
  v_key  := lower(btrim(p_customer_key));

  update public.launch_discount_claims
     set state                      = 'session_open',
         expires_at                 = null,
         stripe_checkout_session_id = v_session,
         -- The FIRST time it opened, kept across retries.
         session_opened_at          = coalesce(session_opened_at, v_now)
   where code = v_code
     and customer_key = v_key
     and claim_id = p_claim_id
     and checkout_attempt_id = p_checkout_attempt_id
     and (state = 'session_creating'
          or (state = 'session_open' and stripe_checkout_session_id = v_session));

  get diagnostics v_rows = row_count;

  if v_rows = 1 then
    return jsonb_build_object('opened', true, 'state', 'session_open', 'outcome', 'session_open');
  end if;

  select state, claim_id, stripe_checkout_session_id
    into v_state, v_claim_id, v_open
  from public.launch_discount_claims
  where code = v_code and customer_key = v_key;

  return jsonb_build_object(
    'opened', false,
    'state', v_state,
    'outcome', case
                 when v_state is null              then 'no_claim'
                 when v_state = 'redeemed'         then 'already_redeemed'
                 when v_state = 'payment_pending'  then 'payment_pending'
                 when v_state = 'session_open'
                      and v_claim_id = p_claim_id  then 'session_already_open'
                 when v_state = 'reserved'
                      and v_claim_id = p_claim_id  then 'session_creating_required'
                 else 'not_holder'
               end,
    -- Only ever to the holder: a caller that does not hold the claim
    -- learns nothing about the session that does.
    'stripe_checkout_session_id',
      case when v_claim_id = p_claim_id then v_open else null end
  );
end;
$$;

/**
 * The session completed but the money is still travelling.
 *
 * Moves the claim to 'payment_pending' and CLEARS expires_at, which the
 * shape CHECK then keeps NULL. From here nothing can lapse the claim:
 * not this function, not claim_launch_discount, not time.
 *
 * ── WHY EVERY NON-TERMINAL STATE IS ACCEPTED ──────────────────
 *
 * The ordinary predecessor is 'session_open'. 'session_creating' is
 * accepted because a completion can arrive for a session whose id never
 * reached us, and 'reserved' because the model must not assume its own
 * ordering rule was obeyed when the consequence of being wrong is a
 * LAPSABLE claim with a delayed payment in flight. Every one of these
 * transitions only ever makes the claim more protected, which is the
 * direction this function is allowed to move it.
 *
 * ONLY THE CURRENT HOLDER - the claim id AND the attempt, like every
 * other transition that acts on an active claim. This one cannot free
 * anything, so an impersonator could at worst lock a claim that was
 * already locked; the pair is required anyway, because a holder rule
 * with an exception is a rule somebody will apply to the wrong
 * function. The webhook resolves the claim through the attempt, so it
 * has both in hand.
 *
 * Idempotent for a redelivered webhook - 'payment_pending' is an
 * accepted starting state, so a second delivery of the same event
 * reports success rather than a failure somebody has to interpret.
 *
 * Never from 'redeemed': a paid order does not go back to waiting.
 */
create or replace function public.mark_launch_discount_payment_pending(
  p_code text,
  p_customer_key text,
  p_claim_id uuid,
  p_checkout_attempt_id uuid
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
  if p_code is null or p_customer_key is null or p_claim_id is null
     or p_checkout_attempt_id is null then
    raise exception 'launch discount payment pending: a code, a customer key, a claim id and a checkout attempt are all required';
  end if;

  v_code := upper(btrim(p_code));
  v_key  := lower(btrim(p_customer_key));

  update public.launch_discount_claims
     set state      = 'payment_pending',
         expires_at = null
   where code = v_code
     and customer_key = v_key
     and claim_id = p_claim_id
     and checkout_attempt_id = p_checkout_attempt_id
     and state in ('reserved', 'session_creating', 'session_open', 'payment_pending');

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
 * The ordinary release: no Stripe work was ever declared.
 *
 * ONLY FROM 'reserved', AND ONLY BY THE HOLDER. Two separate rules and
 * both matter:
 *
 *   the claim id AND the       a caller whose reservation lapsed and was
 *   attempt must both match    taken over must not be able to release
 *                              the NEW holder's claim on its way out.
 *                              This is migration 049's rule, for the
 *                              same reason - and the attempt is checked
 *                              alongside the token because a holder is
 *                              the PAIR: a different checkout that
 *                              somehow presents this token is not
 *                              entitled to free this reservation.
 *
 *   the state must be          'reserved' is the only state in which no
 *   'reserved'                 Stripe create request has been declared,
 *                              so it is the only one a caller may free
 *                              on its own say-so. This path is for the
 *                              customer who left before checkout began,
 *                              or for a refusal that happened before
 *                              Stripe was ever going to be called.
 *
 * 'session_creating', 'session_open' and 'payment_pending' are
 * therefore unreachable from here - structurally, not by a condition
 * somebody has to remember. A flag on one function would have been one
 * wrong argument away from freeing a claim whose session may be
 * payable.
 *
 * AND THAT IS ALSO WHY THIS FUNCTION MUST NOT BE USED AS A STRIPE-ERROR
 * HANDLER. A create request that threw does not prove that no session
 * was created; only Stripe can say that. Phase B must retry with the
 * same idempotency key, and must let an authoritative signal - expiry,
 * or a failed asynchronous payment - end the claim.
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
  p_claim_id uuid,
  p_checkout_attempt_id uuid
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
  if p_code is null or p_customer_key is null or p_claim_id is null
     or p_checkout_attempt_id is null then
    raise exception 'launch discount release: a code, a customer key, a claim id and a checkout attempt are all required';
  end if;

  v_code := upper(btrim(p_code));
  v_key  := lower(btrim(p_customer_key));

  update public.launch_discount_claims
     set state                      = 'released',
         claim_id                   = null,
         checkout_attempt_id        = null,
         expires_at                 = null,
         session_creating_at        = null,
         stripe_checkout_session_id = null,
         session_opened_at          = null,
         released_at                = now()
   where code = v_code
     and customer_key = v_key
     and claim_id = p_claim_id
     and checkout_attempt_id = p_checkout_attempt_id
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
                 when v_state is null              then 'no_claim'
                 when v_state = 'released'         then 'already_released'
                 when v_state = 'redeemed'         then 'already_redeemed'
                 when v_state = 'session_creating' then 'session_creating'
                 when v_state = 'session_open'     then 'session_open'
                 when v_state = 'payment_pending'  then 'payment_pending'
                 else 'not_holder'
               end
  );
end;
$$;

/**
 * STRIPE SAID THE SESSION EXPIRED. It can never be paid again.
 *
 * This is the authoritative end of a payable session, and therefore the
 * ONLY ordinary way out of 'session_open' - and the ordinary way out of
 * a 'session_creating' claim left behind by a crash. checkout.session.
 * expired is Stripe telling us the thing we could not observe
 * ourselves: that an unpaid session is finished. Nothing else - no
 * timer, no cleanup job, no second checkout - is allowed to make that
 * judgement, which is why the ordinary release cannot reach either
 * state.
 *
 * ── TWO CASES, AND HOW EACH IS BOUND ──────────────────────────
 *
 *   'session_open'      the row knows the session id, so the holder,
 *                       the attempt AND the id must all match. An
 *                       expiry for some other session cannot touch it.
 *
 *   'session_creating'  the row has no id to compare, because the
 *                       process died before one was recorded. The
 *                       binding is therefore the ATTEMPT: phase B
 *                       resolves the expired session to a checkout
 *                       attempt (checkout_attempts.
 *                       stripe_checkout_session_id) and thence to the
 *                       claim it holds, so a session belonging to a
 *                       different checkout resolves to a different
 *                       attempt and cannot match. Holder and attempt
 *                       must both be the caller's.
 *
 * This is the recovery path the crash policy promises: a locked claim
 * frees itself once Stripe says the session it was protecting is dead,
 * without any timer ever guessing.
 *
 * Idempotent: a redelivered expiry reports 'already_released'.
 * Never from 'payment_pending' (Stripe expires unpaid sessions; a
 * completed one with money in flight is not this event's business) and
 * never from 'redeemed'.
 *
 * PHASE B USES THIS, AND NOTHING USES IT YET. The webhook does not
 * subscribe to checkout.session.expired today; wiring it is phase B's
 * job, and this function is the door it will need to exist.
 */
create or replace function public.release_launch_discount_after_expired_session(
  p_code text,
  p_customer_key text,
  p_claim_id uuid,
  p_checkout_attempt_id uuid,
  p_stripe_checkout_session_id text
)
returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_code    text;
  v_key     text;
  v_session text;
  v_rows    integer;
  v_state   text;
begin
  if p_code is null or p_customer_key is null or p_claim_id is null
     or p_checkout_attempt_id is null then
    raise exception 'launch discount release after expired session: a code, a customer key, a claim id and a checkout attempt are all required';
  end if;

  v_session := btrim(coalesce(p_stripe_checkout_session_id, ''));
  if v_session = '' then
    raise exception 'launch discount release after expired session: the expired stripe checkout session id is required';
  end if;

  v_code := upper(btrim(p_code));
  v_key  := lower(btrim(p_customer_key));

  update public.launch_discount_claims
     set state                      = 'released',
         claim_id                   = null,
         checkout_attempt_id        = null,
         expires_at                 = null,
         session_creating_at        = null,
         stripe_checkout_session_id = null,
         session_opened_at          = null,
         released_at                = now()
   where code = v_code
     and customer_key = v_key
     and claim_id = p_claim_id
     and checkout_attempt_id = p_checkout_attempt_id
     and ((state = 'session_open' and stripe_checkout_session_id = v_session)
          or state = 'session_creating');

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
 * The other authoritative ending, and a separate function from the
 * ordinary release for the same reason as the one above: the abandon
 * path must not be able to reach a protected state even by passing the
 * wrong argument.
 *
 * Reachable from 'payment_pending', which is where a completed session
 * with travelling money sits; from 'session_open' and
 * 'session_creating', because a failure can arrive before anything
 * recorded the completion or even the session id; and from 'reserved',
 * because it can arrive before anything recorded any of it. In every
 * one of those, STRIPE has said the money will not arrive, so the claim
 * is genuinely free - which is the distinction that matters. A local
 * exception is not this event.
 *
 * Still only by the holder - the claim id AND the attempt, because this
 * one DOES free a claim and a different checkout presenting this token
 * must not be able to. Still never from 'redeemed' - if an order
 * exists, the money arrived, whatever a later event says.
 */
create or replace function public.release_launch_discount_after_failed_payment(
  p_code text,
  p_customer_key text,
  p_claim_id uuid,
  p_checkout_attempt_id uuid
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
  if p_code is null or p_customer_key is null or p_claim_id is null
     or p_checkout_attempt_id is null then
    raise exception 'launch discount release after failed payment: a code, a customer key, a claim id and a checkout attempt are all required';
  end if;

  v_code := upper(btrim(p_code));
  v_key  := lower(btrim(p_customer_key));

  update public.launch_discount_claims
     set state                      = 'released',
         claim_id                   = null,
         checkout_attempt_id        = null,
         expires_at                 = null,
         session_creating_at        = null,
         stripe_checkout_session_id = null,
         session_opened_at          = null,
         released_at                = now()
   where code = v_code
     and customer_key = v_key
     and claim_id = p_claim_id
     and checkout_attempt_id = p_checkout_attempt_id
     and state in ('reserved', 'session_creating', 'session_open', 'payment_pending');

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
-- 8. SPENDING THE CLAIM - TERMINAL, AND HELD BY THE PAYER
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
 * ── THE NORMAL PATH REDEEMS THE PAYER'S OWN CLAIM ─────────────
 *
 * The upsert moves the row only when it is free - no row at all, or
 * 'released' - or when the claim is held by THIS attempt: the claim id
 * AND the checkout_attempt_id, both. That is the ordinary lifecycle: a
 * paid order settles the very claim its own checkout opened, from
 * 'session_open' or 'payment_pending'.
 *
 * "SAME TOKEN, DIFFERENT ATTEMPT" IS NOT ORDINARY OWNERSHIP. It falls
 * through to the anomaly path below, where the paid order still wins -
 * money is not refused for bookkeeping - but the conflict is COUNTED
 * and reported rather than settled silently as if it were normal.
 *
 * 'session_creating' IS IN THAT SET TOO, and deliberately: the crashed
 * checkout whose session id never reached us is still the same holder,
 * and its customer may still have paid. Refusing there would strand a
 * real payment for the sake of bookkeeping the crash already cost us.
 *
 * A webhook redelivery for the SAME order is idempotent: the row is
 * already 'redeemed' with that order id, and the answer says so.
 *
 * ── THE TWO ANOMALIES, AND WHY NEITHER RAISES ─────────────────
 *
 * Both are INVARIANT VIOLATIONS, not tolerated behaviour. With
 * 'session_creating' and 'session_open' in the model there is no
 * ordinary sequence that reaches either: from the moment a Stripe
 * create request is declared the claim cannot lapse, cannot be taken
 * over, and cannot be released by anything but Stripe saying the
 * session is finished. If one of them happens, something outside this
 * state machine has gone wrong and an operator must know.
 *
 *   held by a DIFFERENT holder   - a different claim token, or the same
 *                                token on a different attempt - the
 *                                paying order wins. Money outranks
 *                                an unpaid reservation, and leaving the
 *                                other holder live would let it redeem
 *                                later and produce a SECOND discounted
 *                                order. Taking it over makes any such
 *                                later attempt hit a terminal row and
 *                                be refused.
 *
 *   already spent by a DIFFERENT the row stays as it is. The earlier
 *   order                        order keeps the claim; this one is
 *                                reported as unredeemed.
 *
 * Neither raises, and that is deliberate: by the time this runs the
 * customer HAS PAID a discounted amount. Raising would roll back the
 * order and strand a real payment with nothing to show for it - the
 * worst outcome available. So each is COUNTED on the row
 * (redemption_conflicts, last_conflict_at) and reported to the caller.
 *
 * THAT COUNTER IS TELEMETRY, NOT A BUDGET. It must stay 0. It is not a
 * mechanism for allowing a second discounted order and it is never the
 * thing standing between two customers and two discounts - the state
 * machine is. A non-zero value is an incident to investigate.
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
  v_state    text;
  v_claim_id uuid;
  v_order_id uuid;
begin
  if p_code is null or p_customer_key is null or p_claim_id is null
     or p_checkout_attempt_id is null or p_order_id is null then
    raise exception 'launch discount redemption: a code, a customer key, a claim id, a checkout attempt and an order are all required';
  end if;

  v_code := upper(btrim(p_code));
  v_key  := lower(btrim(p_customer_key));

  -- THE NORMAL PATH. Free, or held by the attempt that paid.
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
   where c.state = 'released'
      or (c.state in ('reserved', 'session_creating', 'session_open', 'payment_pending')
          and c.claim_id = excluded.claim_id
          and c.checkout_attempt_id = excluded.checkout_attempt_id);

  get diagnostics v_rows = row_count;

  if v_rows = 1 then
    return jsonb_build_object('redeemed', true, 'state', 'redeemed', 'outcome', 'redeemed');
  end if;

  select state, claim_id, order_id into v_state, v_claim_id, v_order_id
  from public.launch_discount_claims
  where code = v_code and customer_key = v_key;

  -- A replay of this very order.
  if v_state = 'redeemed' and v_order_id = p_order_id then
    return jsonb_build_object('redeemed', true, 'state', 'redeemed', 'outcome', 'already_redeemed');
  end if;

  -- ANOMALY 1: a different order already spent it. The earlier order
  -- keeps the claim; this one is counted and reported.
  if v_state = 'redeemed' then
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
  end if;

  -- ANOMALY 2: a different, UNPAID holder has it. The paid order takes
  -- it, because the alternative is leaving a live claim that could be
  -- redeemed a second time - two discounted orders instead of one
  -- counted anomaly.
  update public.launch_discount_claims
     set state                = 'redeemed',
         claim_id             = p_claim_id,
         checkout_attempt_id  = p_checkout_attempt_id,
         order_id             = p_order_id,
         claimed_at           = coalesce(claimed_at, v_now),
         expires_at           = null,
         released_at          = null,
         redeemed_at          = v_now,
         redemption_conflicts = redemption_conflicts + 1,
         last_conflict_at     = v_now
   where code = v_code and customer_key = v_key
     and state <> 'redeemed';

  get diagnostics v_rows = row_count;

  if v_rows = 1 then
    return jsonb_build_object(
      'redeemed', true,
      'state', 'redeemed',
      'outcome', 'redeemed_over_foreign_holder',
      'previous_claim_id', v_claim_id
    );
  end if;

  -- The row became terminal between the two statements. Whoever won,
  -- the paid order still must not be refused.
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

    -- ANY OUTCOME BUT THE TWO ORDINARY ONES IS AN INVARIANT VIOLATION,
    -- and it is said out loud. 'redeemed' is the normal settlement and
    -- 'already_redeemed' is this same order's webhook arriving twice;
    -- everything else means the claim was held or spent by somebody
    -- else, which the state machine in section 1 is supposed to make
    -- unreachable. Counted on the claim row by the function itself, and
    -- still not fatal - the money has already moved, and refusing the
    -- order now would strand a real payment.
    if v_redemption->>'outcome' not in ('redeemed', 'already_redeemed') then
      raise warning 'launch discount: order % settled attempt % against a claim it did not hold alone (%) - the one-payable-session invariant was broken upstream',
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
-- take one, release one, declare a Stripe call on one, open a session
-- on one, mark one payment_pending, redeem one, ask whether somebody is
-- a first-time buyer, or influence the discount amount. Not "does not";
-- cannot. The claims table has no grant at all (section 2) and every
-- door is revoked below.
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
    'public.mark_launch_discount_session_creating(text, text, uuid, uuid)',
    'public.mark_launch_discount_session_open(text, text, uuid, uuid, text)',
    'public.mark_launch_discount_payment_pending(text, text, uuid, uuid)',
    'public.release_launch_discount(text, text, uuid, uuid)',
    'public.release_launch_discount_after_expired_session(text, text, uuid, uuid, text)',
    'public.release_launch_discount_after_failed_payment(text, text, uuid, uuid)'
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
  v_shape   text;
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
  select pg_get_constraintdef(oid) into v_shape
  from pg_constraint
  where conrelid = 'public.launch_discount_claims'::regclass
    and conname = 'launch_discount_claims_state_shape';

  if v_shape is null then
    raise exception '056: the claim ledger has no state shape constraint';
  end if;

  -- AND IT KNOWS ABOUT THE STRIPE CALL BEFORE IT HAPPENS. Without this
  -- state a process dying around the Stripe request leaves a lapsable
  -- claim while a payable session exists, which is the whole race.
  if position('session_creating' in v_shape) = 0 then
    raise exception '056: the state machine has no session_creating - a crash around the Stripe call would leave the claim takeable';
  end if;

  -- AND ABOUT THE PAYABLE SESSION ONCE IT IS KNOWN.
  if position('session_open' in v_shape) = 0 then
    raise exception '056: the state machine has no session_open - a payable Stripe session would be lapsable';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'launch_discount_claims'
      and column_name = 'session_creating_at'
  ) then
    raise exception '056: the claim ledger cannot record that a Stripe call was declared';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'launch_discount_claims'
      and column_name = 'stripe_checkout_session_id'
  ) then
    raise exception '056: the claim ledger cannot name the payable session it is protecting';
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

  -- Ten functions, every one of them SECURITY DEFINER with an empty
  -- search_path, and no older overload left callable beside them.
  for v_missing in
    select unnest(array['launch_discount_is_first_order',
                        'claim_launch_discount',
                        'mark_launch_discount_session_creating',
                        'mark_launch_discount_session_open',
                        'mark_launch_discount_payment_pending',
                        'release_launch_discount',
                        'release_launch_discount_after_expired_session',
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
                        'mark_launch_discount_session_creating',
                        'mark_launch_discount_session_open',
                        'mark_launch_discount_payment_pending',
                        'release_launch_discount',
                        'release_launch_discount_after_expired_session',
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

-- ══════════════════════════════════════════════════════════════
-- 11b. AND THE SHAPES THAT CARRY THE INVARIANT ARE TRIED
-- ══════════════════════════════════════════════════════════════
--
-- A constraint that exists is not the same as a constraint that
-- refuses. These six rows are the exact incoherences the model is here
-- to forbid, and each one is attempted for real inside a subtransaction
-- that is then rolled back - so nothing is left behind and the ledger
-- is still empty when the checks above are re-run on a second
-- application.
--
--   1. session_creating carrying an expires_at    it could lapse while
--                                                 a Stripe session may
--                                                 already exist: THE BUG
--   2. session_creating holding a session id      that is session_open;
--                                                 the ambiguous state
--                                                 must stay ambiguous
--   3. session_open carrying an expires_at        it could lapse
--   4. session_open with no session named         nothing to expire
--   5. reserved already holding a session         lapsable while payable
--   6. reserved that already declared a call      lapsable after the
--                                                 Stripe request began
--
-- An existing checkout attempt is borrowed for the foreign key so the
-- CHECK is what refuses, not the reference. If there is no attempt to
-- borrow - an empty database - the probes are skipped rather than
-- weakened into something that proves less.

do $$
declare
  v_attempt uuid;
  v_probe   uuid := '00000000-0000-0000-0000-000000000056';
  v_key     text := 'state-machine-probe@gloa.invalid';
  v_ok      boolean;
begin
  select id into v_attempt from public.checkout_attempts limit 1;
  if v_attempt is null then
    raise notice '056: no checkout attempt to borrow - the state machine probes were skipped';
    return;
  end if;

  -- 1. session_creating MUST NOT be able to carry an expiry.
  v_ok := false;
  begin
    insert into public.launch_discount_claims
      (code, customer_key, state, claim_id, checkout_attempt_id, claimed_at,
       expires_at, session_creating_at, stripe_checkout_session_id, session_opened_at)
    values ('GLOALAUNCH10', v_key, 'session_creating', v_probe, v_attempt, now(),
            now() + interval '30 minutes', now(), null, null);
  exception when check_violation then
    v_ok := true;
  end;
  if not v_ok then
    raise exception '056: a session_creating claim was allowed to carry an expiry - a crash around the Stripe call could still free it';
  end if;

  -- 2. session_creating MUST stay the state that knows no session id.
  v_ok := false;
  begin
    insert into public.launch_discount_claims
      (code, customer_key, state, claim_id, checkout_attempt_id, claimed_at,
       expires_at, session_creating_at, stripe_checkout_session_id, session_opened_at)
    values ('GLOALAUNCH10', v_key, 'session_creating', v_probe, v_attempt, now(),
            null, now(), 'cs_test_probe', now());
  exception when check_violation then
    v_ok := true;
  end;
  if not v_ok then
    raise exception '056: a session_creating claim was allowed to name a session - a known session id is session_open';
  end if;

  -- 3. session_open MUST NOT be able to carry an expiry.
  v_ok := false;
  begin
    insert into public.launch_discount_claims
      (code, customer_key, state, claim_id, checkout_attempt_id, claimed_at,
       expires_at, session_creating_at, stripe_checkout_session_id, session_opened_at)
    values ('GLOALAUNCH10', v_key, 'session_open', v_probe, v_attempt, now(),
            now() + interval '30 minutes', now(), 'cs_test_probe', now());
  exception when check_violation then
    v_ok := true;
  end;
  if not v_ok then
    raise exception '056: a session_open claim was allowed to carry an expiry - a payable session could still lapse';
  end if;

  -- 4. session_open MUST name the session it is protecting.
  v_ok := false;
  begin
    insert into public.launch_discount_claims
      (code, customer_key, state, claim_id, checkout_attempt_id, claimed_at,
       expires_at, session_creating_at, stripe_checkout_session_id, session_opened_at)
    values ('GLOALAUNCH10', v_key, 'session_open', v_probe, v_attempt, now(),
            null, now(), null, now());
  exception when check_violation then
    v_ok := true;
  end;
  if not v_ok then
    raise exception '056: a session_open claim was allowed with no Stripe session - nothing could ever expire it';
  end if;

  -- 5. reserved MUST NOT hold a session id.
  v_ok := false;
  begin
    insert into public.launch_discount_claims
      (code, customer_key, state, claim_id, checkout_attempt_id, claimed_at,
       expires_at, session_creating_at, stripe_checkout_session_id, session_opened_at)
    values ('GLOALAUNCH10', v_key, 'reserved', v_probe, v_attempt, now(),
            now() + interval '5 minutes', null, 'cs_test_probe', now());
  exception when check_violation then
    v_ok := true;
  end;
  if not v_ok then
    raise exception '056: a reserved claim was allowed to hold a Stripe session - it would be lapsable while payable';
  end if;

  -- 6. AND reserved MUST NOT already have declared a Stripe call. This
  -- is the one that keeps the lapsable state and the ambiguous state
  -- from ever being the same row.
  v_ok := false;
  begin
    insert into public.launch_discount_claims
      (code, customer_key, state, claim_id, checkout_attempt_id, claimed_at,
       expires_at, session_creating_at, stripe_checkout_session_id, session_opened_at)
    values ('GLOALAUNCH10', v_key, 'reserved', v_probe, v_attempt, now(),
            now() + interval '5 minutes', now(), null, null);
  exception when check_violation then
    v_ok := true;
  end;
  if not v_ok then
    raise exception '056: a reserved claim was allowed to have declared a Stripe call - it would be lapsable after the request began';
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
--                            'mark_launch_discount_session_creating',
--                            'mark_launch_discount_session_open',
--                            'mark_launch_discount_payment_pending',
--                            'release_launch_discount',
--                            'release_launch_discount_after_expired_session',
--                            'release_launch_discount_after_failed_payment',
--                            'redeem_launch_discount',
--                            'create_order_from_paid_checkout')
--        order by p.proname;
--      -> prosecdef true and proconfig {search_path=} for all ten.
--      -> anon false and authenticated false for all ten.
--      -> service_role true for nine, and FALSE for redeem_launch_discount.
--
--   3b. No overload was left behind. Every name above must return
--       exactly ONE row:
--        select proname, count(*) from pg_proc p
--        join pg_namespace n on n.oid = p.pronamespace
--        where n.nspname = 'public' and proname in (
--          'launch_discount_is_first_order','claim_launch_discount',
--          'mark_launch_discount_session_creating',
--          'mark_launch_discount_session_open',
--          'mark_launch_discount_payment_pending','release_launch_discount',
--          'release_launch_discount_after_expired_session',
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
--   4b. THE INVARIANT, ASKED OF THE CONSTRAINT ITSELF. Read the shape
--       and confirm that every state after the Stripe call was declared
--       is unexpirable, and that 'reserved' has declared nothing:
--        select pg_get_constraintdef(oid)
--        from pg_constraint
--        where conrelid = 'public.launch_discount_claims'::regclass
--          and conname = 'launch_discount_claims_state_shape';
--      -> 'reserved'         ... expires_at IS NOT NULL
--                            ... session_creating_at IS NULL
--                            ... stripe_checkout_session_id IS NULL
--      -> 'session_creating' ... expires_at IS NULL
--                            ... session_creating_at IS NOT NULL
--                            ... stripe_checkout_session_id IS NULL
--      -> 'session_open'     ... expires_at IS NULL
--                            ... session_creating_at IS NOT NULL
--                            ... stripe_checkout_session_id IS NOT NULL
--      -> 'payment_pending'  ... expires_at IS NULL
--      The migration itself tries all six forbidden rows before it
--      commits (section 11b), so a database that reached this point has
--      already refused them.
--
--   4c. AND NOTHING CAN TAKE A CLAIM ONCE STRIPE WORK WAS DECLARED.
--       Read the claim function's conflict clause:
--        select pg_get_functiondef('public.claim_launch_discount(text, text, uuid, uuid, integer)'::regprocedure);
--      -> the WHERE names only 'released' and 'reserved'. Neither
--         'session_creating' nor 'session_open' nor 'payment_pending'
--         nor 'redeemed' appears.
--
--   4c-bis. AND AN ACTIVE CLAIM CANNOT BE MOVED ONTO A DIFFERENT
--       ATTEMPT BY REUSING ITS TOKEN. The idempotent retry branch of
--       the same conflict clause requires the PAIR:
--      -> (c.claim_id = excluded.claim_id
--          and c.checkout_attempt_id = excluded.checkout_attempt_id)
--         or c.expires_at <= excluded.claimed_at
--      The second disjunct needs no pair because a lapsed reservation
--      has no holder left to impersonate.
--
--   4d. AND A SESSION CANNOT BE RECORDED FOR A CLAIM THAT NEVER
--       DECLARED ONE. Read the session-open transition:
--        select pg_get_functiondef('public.mark_launch_discount_session_open(text, text, uuid, uuid, text)'::regprocedure);
--      -> the WHERE accepts 'session_creating', or 'session_open' with
--         the SAME session id. 'reserved' is refused, with the outcome
--         'session_creating_required'.
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
--
--   7. AND THE TELEMETRY THAT MUST STAY ZERO. Not a budget, not an
--      allowance - a number that is 0 for as long as the state machine
--      holds, and an incident the moment it is not:
--        select code, customer_key, redemption_conflicts, last_conflict_at
--        from public.launch_discount_claims
--        where redemption_conflicts > 0;
--      -> NO ROWS.
--
--   8. THE OPERATIONAL QUERY THE CRASH POLICY IMPLIES. A claim stuck in
--      'session_creating' is a checkout whose process died around the
--      Stripe call. It frees itself when Stripe says the session it was
--      protecting expired; until then it is deliberately locked, and
--      this is how an operator finds one:
--        select code, customer_key, checkout_attempt_id, session_creating_at,
--               now() - session_creating_at as stuck_for
--        from public.launch_discount_claims
--        where state = 'session_creating'
--        order by session_creating_at;
--      -> NO ROWS in ordinary operation. A row older than a day is worth
--         reconciling against Stripe by hand; it is never worth freeing
--         on a timer.
-- ══════════════════════════════════════════════════════════════
