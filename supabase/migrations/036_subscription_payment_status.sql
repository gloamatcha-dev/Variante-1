-- ============================================================
-- GLOA - Subscription payment failure foundation (Phase 3I.B1)
-- Run in Supabase SQL Editor AFTER 035
--
-- Phase 3I.A audited the payment-failure gap and found two things the
-- application cannot do today, both of them database facts rather than
-- missing code:
--
--   1. public.subscription_email_deliveries permits three families, and
--      'payment_problem' is not one of them. Migration 035 is live and
--      immutable, so the CHECK is replaced here rather than edited there.
--
--   2. service_role holds SELECT on public.subscriptions AND NOTHING
--      ELSE. Migration 022 granted exactly that, deliberately, and every
--      status write in this system goes through a SECURITY DEFINER
--      function. So a local past_due/unpaid reconciliation is not merely
--      unwritten - it is impossible without a new function, which is why
--      this migration exists at all rather than the phase being pure
--      application code.
--
-- THOSE ARE THE ONLY TWO CHANGES. No new table, no new column, no new
-- index, no new trigger, no new policy, no grant on any existing table.
--
-- IT RECONCILES NOTHING BY ITSELF. Applying this migration changes no
-- row. The function is defined and left unused: invoice.payment_failed
-- is not handled yet, the payment_problem sender does not exist yet, and
-- nothing in the repository calls this RPC. Phase 3I.B2 wires it.
--
-- 036 IS THE NEXT FREE NUMBER. 022-035 are live and immutable and are
-- not touched.
-- ============================================================


-- 1. THE FOURTH FAMILY ─────────────────────────────────────────
--
-- Migration 035's own note said 'payment_problem' would cost no schema
-- change beyond "a family name and an event key", and that this would be
-- a deliberate later step rather than a value left open. This is that
-- step, and it is deliberately a migration a human has to read.
--
-- ── WHY THE DROP IS NOT "IF EXISTS" ───────────────────────────
--
-- The constraint name is known: migration 035 created
-- subscription_email_deliveries_family_check and nothing since has
-- touched it. A DROP ... IF EXISTS would let this migration succeed
-- against a Production schema that had already drifted - silently
-- building a four-value CHECK on top of a table whose real shape nobody
-- had verified. Failing loudly on a schema that does not match the
-- reviewed contract is the whole point.
--
-- ── WHY THE VOCABULARY IS RESTATED IN FULL ────────────────────
--
-- Postgres has no "add a value to a CHECK". The replacement therefore
-- names all four, and the three existing ones must be re-stated exactly
-- as 035 wrote them. A typo here would silently narrow the vocabulary
-- and break a live family, so the focused suite asserts this list
-- against 035's own text rather than against a copy.

alter table public.subscription_email_deliveries
  drop constraint subscription_email_deliveries_family_check;

alter table public.subscription_email_deliveries
  add constraint subscription_email_deliveries_family_check
  check (family in (
    'subscription_started',
    'cancellation_confirmation',
    'subscription_ended',
    'payment_problem'
  ));

-- NOTHING ELSE ON THIS TABLE MOVES. The status CHECK, the event_key
-- CHECK, the biconditional sent_at CHECK, the unique claim guard, the
-- two partial indexes, RLS, the zero policies and the column-scoped
-- grants are all exactly as 035 left them. In particular the generic
-- length(btrim(event_key)) > 0 CHECK remains sufficient: the future
-- payment_problem event key is a Stripe invoice id, and a
-- family-specific key format CHECK would pin an external vendor's id
-- shape into the schema for no safety gain.


-- 2. THE PAYMENT STATUS RECONCILIATION FUNCTION ────────────────
--
-- The controlled write boundary for public.subscriptions.status.
--
-- ══════════════════════════════════════════════════════════════
-- WHY A FUNCTION AND NOT A GRANT
-- ══════════════════════════════════════════════════════════════
--
-- The obvious alternative is to grant service_role a column-scoped
-- UPDATE(status) on public.subscriptions. That was rejected: status is
-- the column that decides whether a customer is billed, shipped to and
-- allowed to cancel, and migration 034 deliberately routes every write
-- to this table through SECURITY DEFINER functions so that an
-- application bug cannot restate business state. A grant would put the
-- four guards below into application code, where nothing enforces them.
-- Here the database enforces them.
--
-- ── IT IS NOT THE ACTIVATION PATH AND NOT THE TERMINATION PATH ─
--
-- Three functions may now write this column and they own disjoint
-- transitions:
--
--   activate_subscription_from_invoice  (022)  pending -> active, and
--                                              ONLY from a paid first
--                                              invoice. First-payment
--                                              proof lives there.
--   mark_subscription_cancelled         (034)  anything -> cancelled,
--                                              from customer.subscription
--                                              .deleted. Terminal.
--   sync_subscription_payment_status    (036)  moves only among active,
--                                              past_due and unpaid.
--
-- This one can neither activate nor terminate, and the guards below make
-- that structural rather than conventional.
--
-- ── WHY STRIPE'S STATUS IS THE INPUT ──────────────────────────
--
-- Stripe owns dunning. Whether a failed payment produces past_due, and
-- whether past_due ever becomes unpaid, depends on Billing settings that
-- live in the Stripe Dashboard rather than in this repository. So this
-- function MIRRORS a status the caller re-read live from Stripe rather
-- than inferring one from invoice events, and it deliberately accepts
-- the full matrix among the three values rather than assuming a
-- particular dunning sequence.
--
-- The caller is responsible for that value being fresh. The Phase 3I.A
-- design puts the only call site in the customer.subscription.updated
-- handler, which already retrieves the subscription from Stripe rather
-- than trusting the webhook payload - so a late or duplicated event
-- still writes today's truth, not a stale one.

create or replace function public.sync_subscription_payment_status(
  p_stripe_subscription_id text,
  p_stripe_status          text
)
returns jsonb
language plpgsql
volatile
security definer set search_path = ''
as $$
declare
  v_sub    public.subscriptions;
  v_target text;
begin
  -- ── INPUT ──────────────────────────────────────────────────
  --
  -- Fails closed rather than throwing. A malformed argument is a caller
  -- bug, and the webhook that calls this must not be turned into a 500
  -- by one; it reports and moves on.
  if p_stripe_subscription_id is null
     or btrim(p_stripe_subscription_id) = ''
     or p_stripe_status is null
     or btrim(p_stripe_status) = ''
  then
    return jsonb_build_object('result', 'invalid_input');
  end if;

  -- ── THE ONLY THREE STATUSES THIS FUNCTION MAY MIRROR ───────
  --
  -- Checked BEFORE the row is read, so an unsupported status costs no
  -- lock. Stripe's subscription status union is larger than this on
  -- purpose:
  --
  --   canceled / incomplete_expired  termination. mark_subscription_
  --                                  cancelled owns it, driven by
  --                                  customer.subscription.deleted.
  --   incomplete                     a first invoice that has not been
  --                                  paid. There is no payment proof, so
  --                                  nothing here may act on it.
  --   trialing                       not offered by this product.
  --   paused                         the local CHECK permits 'paused'
  --                                  but no pause/resume feature exists,
  --                                  and this migration does not invent
  --                                  one.
  --   anything Stripe adds later     an unknown status must never be
  --                                  guessed into a billing state.
  v_target := btrim(p_stripe_status);
  if v_target not in ('active', 'past_due', 'unpaid') then
    return jsonb_build_object('result', 'ignored_status', 'status', v_target);
  end if;

  -- ── THE ROW, LOCKED ────────────────────────────────────────
  --
  -- Found by stripe_subscription_id, which migration 022 binds exactly
  -- once and never rebinds. NOT by customer email and NOT by metadata:
  -- either would let one customer's billing state be written onto
  -- another customer's subscription.
  --
  -- FOR UPDATE, so a concurrent reconciliation and a concurrent
  -- cancellation cannot interleave between the guards below and the
  -- write.
  select * into v_sub
  from public.subscriptions
  where stripe_subscription_id = btrim(p_stripe_subscription_id)
  for update;

  if not found then
    -- No row, and none is created. A Stripe subscription this system
    -- does not know about is not this function's business.
    return jsonb_build_object('result', 'not_found');
  end if;

  -- ── PENDING IS PROTECTED, AND THIS IS BINDING ──────────────
  --
  -- A 'pending' row has never had a successful first payment. Letting a
  -- customer.subscription.updated event move it anywhere would fabricate
  -- exactly the proof that activate_subscription_from_invoice exists to
  -- require - including 'active', which would mark an unpaid
  -- subscription as running and start shipping it.
  --
  -- It cannot be reached in practice either, because a pending row has
  -- no stripe_subscription_id to be found by. Asserted anyway, because
  -- the invariant is worth more than the assumption.
  if v_sub.status = 'pending' then
    return jsonb_build_object(
      'result', 'pending_no_payment_proof',
      'subscription_id', v_sub.id,
      'status', v_sub.status
    );
  end if;

  -- ── CANCELLED IS TERMINAL ──────────────────────────────────
  --
  -- Migration 022's activation already refuses to revive a cancelled
  -- row, and Phase 3H.4 rests on that being permanent. A payment-status
  -- reconciliation must not be the one path that walks it back.
  if v_sub.status = 'cancelled' then
    return jsonb_build_object(
      'result', 'terminal',
      'subscription_id', v_sub.id,
      'status', v_sub.status
    );
  end if;

  -- ── ANY OTHER LOCAL STATE IS NOT OURS ──────────────────────
  --
  -- Which today means 'paused' alone. No pause feature exists, so a
  -- paused row is either impossible or something a human created; either
  -- way this function does not resolve it.
  if v_sub.status not in ('active', 'past_due', 'unpaid') then
    return jsonb_build_object(
      'result', 'ignored_local_status',
      'subscription_id', v_sub.id,
      'status', v_sub.status
    );
  end if;

  -- ── ALREADY RIGHT ──────────────────────────────────────────
  --
  -- No UPDATE at all, so the updated_at trigger does not fire. That
  -- matters beyond tidiness: updated_at drives the stale-delivery and
  -- retry ordering elsewhere in this system, and a reconciliation that
  -- changed nothing must not look like activity.
  if v_sub.status = v_target then
    return jsonb_build_object(
      'result', 'unchanged',
      'subscription_id', v_sub.id,
      'previous_status', v_sub.status,
      'status', v_sub.status
    );
  end if;

  -- ── ONE COLUMN ─────────────────────────────────────────────
  --
  -- status, and nothing else. Not the periods, not cancelled_at, not
  -- started_at, not the cancellation pair, and above all not migration
  -- 034's payment-proof column - the one whose single writer is
  -- record_paid_subscription_period, fed from an actually paid invoice.
  -- A failed payment must never advance that proof, and this function
  -- deliberately does not name it: the Phase 3C.5 suite asserts that
  -- exactly ONE migration file in the repository mentions it at all, so
  -- the column is protected from even being discussed elsewhere.
  update public.subscriptions
     set status = v_target
   where id = v_sub.id;

  return jsonb_build_object(
    'result', 'updated',
    'subscription_id', v_sub.id,
    'previous_status', v_sub.status,
    'status', v_target
  );
end;
$$;

-- ── PRIVILEGES ────────────────────────────────────────────────
--
-- A new function receives EXECUTE from PUBLIC by default, which for a
-- SECURITY DEFINER function that writes billing state would mean any
-- role in the database could move a customer between billing states.
-- The revokes are explicit and come first, for the same reason migration
-- 035 revokes before it grants: a default privilege that is not removed
-- is a privilege that survives the grant beneath it.

revoke all on function public.sync_subscription_payment_status(text, text) from public;
revoke all on function public.sync_subscription_payment_status(text, text) from anon;
revoke all on function public.sync_subscription_payment_status(text, text) from authenticated;
revoke all on function public.sync_subscription_payment_status(text, text) from service_role;

-- The server, and only the server. anon and authenticated are the
-- browser's roles and must never reach a function that writes status.
grant execute on function public.sync_subscription_payment_status(text, text) to service_role;

-- ── TABLE PRIVILEGES ARE UNCHANGED ────────────────────────────
--
-- public.subscriptions keeps exactly what migrations 005 and 022 gave
-- it: SELECT to authenticated under its own-row RLS policy, SELECT to
-- service_role, and no INSERT, UPDATE or DELETE to either. The function
-- above is the entire new write surface.
--
-- public.subscription_email_deliveries keeps migration 035's grants
-- unchanged: table SELECT, column-scoped INSERT on
-- (subscription_id, family, event_key, status) and column-scoped UPDATE
-- on (status, sent_at), all to service_role alone, with no DELETE.


-- 3. NO DATA CHANGE ────────────────────────────────────────────
--
-- This migration inserts nothing, updates no subscription row, deletes
-- nothing and calls the new function zero times. The UPDATE above exists
-- only inside a function body; applying this file executes it never.
--
-- Every existing delivery row keeps its family and its status. No
-- subscription changes billing state as a result of applying this. The
-- first real reconciliation happens when Phase 3I.B2 wires the
-- customer.subscription.updated handler and a genuine Stripe event
-- arrives.


-- ══════════════════════════════════════════════════════════════
-- VERIFY AFTER APPLYING (read-only, run in the SQL Editor)
-- ══════════════════════════════════════════════════════════════
--
--   -- A. The family CHECK now names exactly four families.
--   select pg_get_constraintdef(oid) as family_check
--   from pg_constraint
--   where conrelid = 'public.subscription_email_deliveries'::regclass
--     and conname  = 'subscription_email_deliveries_family_check';
--   -- expect the four values, including 'payment_problem'
--
--   -- B. And every other constraint on the table survived.
--   select conname, contype, pg_get_constraintdef(oid)
--   from pg_constraint
--   where conrelid = 'public.subscription_email_deliveries'::regclass
--   order by contype, conname;
--   -- expect 7: 4 check, 1 foreign key, 1 primary key, 1 unique
--
--   -- C + D. RLS still on, still zero policies.
--   select c.relrowsecurity as rls_enabled,
--          (select count(*) from pg_policies p
--            where p.schemaname = 'public'
--              and p.tablename  = 'subscription_email_deliveries') as policy_count
--   from pg_class c
--   join pg_namespace n on n.oid = c.relnamespace
--   where n.nspname = 'public'
--     and c.relname = 'subscription_email_deliveries';
--   -- expect t, 0
--
--   -- E. Delivery table grants unchanged.
--   select grantee, privilege_type
--   from information_schema.role_table_grants
--   where table_schema = 'public'
--     and table_name   = 'subscription_email_deliveries'
--   order by grantee, privilege_type;
--   -- expect exactly one row: service_role, SELECT
--
--   select grantee, privilege_type, column_name
--   from information_schema.column_privileges
--   where table_schema   = 'public'
--     and table_name     = 'subscription_email_deliveries'
--     and privilege_type in ('INSERT', 'UPDATE')
--     and grantee        = 'service_role'
--   order by privilege_type, column_name;
--   -- expect INSERT: event_key, family, status, subscription_id
--   --        UPDATE: sent_at, status
--
--   -- F..J. The function exists with the expected shape.
--   select p.proname,
--          pg_get_function_identity_arguments(p.oid) as args,
--          pg_get_function_result(p.oid)             as returns,
--          l.lanname                                  as language,
--          p.provolatile                              as volatility,
--          p.prosecdef                                as security_definer,
--          p.proconfig                                as config
--   from pg_proc p
--   join pg_namespace n on n.oid = p.pronamespace
--   join pg_language  l on l.oid = p.prolang
--   where n.nspname = 'public'
--     and p.proname = 'sync_subscription_payment_status';
--   -- expect args 'text, text', returns 'jsonb', language 'plpgsql',
--   --        volatility 'v', security_definer t,
--   --        config {"search_path="}
--
--   -- K..N. Only the server may execute it.
--   select r.rolname,
--          has_function_privilege(
--            r.rolname,
--            'public.sync_subscription_payment_status(text, text)',
--            'EXECUTE') as can_execute
--   from (values ('anon'), ('authenticated'), ('service_role')) as r(rolname);
--   -- expect anon f, authenticated f, service_role t
--
--   select coalesce(
--     has_function_privilege(
--       'public.sync_subscription_payment_status(text, text)', 'EXECUTE'),
--     false) as public_can_execute
--   where false;  -- PUBLIC is checked by the acl below instead
--
--   select proacl
--   from pg_proc p
--   join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public'
--     and p.proname = 'sync_subscription_payment_status';
--   -- expect exactly one grant, to service_role. No "=X/" entry (PUBLIC).
--
--   -- O. public.subscriptions grants are untouched.
--   select grantee, privilege_type
--   from information_schema.role_table_grants
--   where table_schema = 'public'
--     and table_name   = 'subscriptions'
--     and grantee in ('anon', 'authenticated', 'service_role')
--   order by grantee, privilege_type;
--   -- expect authenticated SELECT and service_role SELECT, nothing else
--
--   -- P. The function body writes status and nothing else.
--   select prosrc
--   from pg_proc p
--   join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public'
--     and p.proname = 'sync_subscription_payment_status';
--   -- expect exactly one UPDATE, setting status alone, and no reference
--   -- to started_at, cancelled_at, cancel_at, the payment-proof column
--   -- migration 034 owns, cancellation_requested_at,
--   -- cancellation_effective_at or any snapshot column
--
--   -- Q. Applying 036 backfilled nothing.
--   select family, status, count(*)
--   from public.subscription_email_deliveries
--   group by family, status
--   order by family, status;
--   -- expect zero payment_problem rows: the family is now legal, and
--   -- nothing has written one
--
--   -- And no subscription changed billing state.
--   select status, count(*)
--   from public.subscriptions
--   group by status
--   order by status;
--   -- expect the same distribution as before the apply
-- ══════════════════════════════════════════════════════════════
-- WHAT IS STILL DEFERRED AFTER THIS MIGRATION
-- ══════════════════════════════════════════════════════════════
--
-- EVERYTHING THAT REACTS. invoice.payment_failed is still unhandled, the
-- payment_problem sender does not exist, the retry sweep still knows
-- three families, and nothing calls the function above. Applying this
-- migration changes no customer-visible behaviour at all.
--
-- THE CALL SITE. Phase 3I.B2 puts it in the
-- customer.subscription.updated handler, which already re-reads the
-- subscription from Stripe - so a duplicated or out-of-order event
-- reconciles to today's truth rather than to the event's stale copy.
--
-- THE EMAIL. Phase 3I.B2's payment_problem delivery is keyed on the
-- Stripe invoice id, and its preflight re-reads that invoice live before
-- contacting Resend: paid, void, uncollectible or draft supersede it,
-- and a re-read that fails leaves the delivery 'sending' rather than
-- claiming a lifecycle fact it could not prove.
-- ============================================================
