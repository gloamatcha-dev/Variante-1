-- ============================================================
-- GLOA - Migration 037: subscription refund correlation
-- Run in Supabase SQL Editor AFTER 001-036
--
-- ONE FUNCTION. NOTHING ELSE.
--
-- No table, no column, no index, no trigger, no policy, no table
-- grant, no data. This migration adds a single narrow SECURITY
-- DEFINER capability and stops.
-- ============================================================

-- 1. THE GAP THIS CLOSES ───────────────────────────────────────
--
-- public.apply_order_refund_state (migration 019, live and immutable)
-- resolves its target order through exactly one identifier:
--
--   where stripe_payment_intent_id = p_payment_intent_id
--
-- and it is the only writer of the three refund-state columns 019
-- created. No role holds UPDATE on them, so there is no second way in.
--
-- Subscription orders are created with stripe_payment_intent_id NULL,
-- deliberately: this API version puts no payment intent on an invoice,
-- and the fulfillment path records the invoice relationship instead.
-- The consequence is that a refund on a subscription payment currently
-- has NO REACHABLE WRITER AT ALL. It is not that the wrong order is
-- updated; it is that the correlation returns 'order_not_found' and the
-- customer's payment record silently never moves.
--
-- The relationship that IS durable for those orders is the invoice:
--
--   public.orders.checkout_attempt_id
--     -> public.checkout_attempts.id
--     -> public.checkout_attempts.stripe_invoice_id
--
-- Both hops are already unique, by indexes that are live and are NOT
-- recreated here:
--
--   checkout_attempts_stripe_invoice_id_key   (migration 022)
--     unique (stripe_invoice_id) where stripe_invoice_id is not null
--
--   orders_checkout_attempt_id_key            (migration 011)
--     unique (checkout_attempt_id) where checkout_attempt_id is not null
--
-- So one Stripe invoice already resolves to at most one GLOA order, as
-- a database guarantee rather than as an application convention. This
-- migration does not create that guarantee. It only gives the server a
-- way to USE it to write refund state.

-- 2. WHY THE INVOICE IS THE KEY, AND NOT THE ORDER ID ──────────
--
-- The obvious signature would have been (p_order_id uuid, ...), because
-- the application performs the correlation anyway and already holds the
-- id. That was the first proposal and it is rejected.
--
-- A function taking an order id is a general-purpose "mutate the refund
-- state of ANY order" primitive, running as its owner, held permanently
-- by the server role, and reaching every order in the table including
-- every one-time purchase. Correlation would be proven in application
-- code and merely trusted in SQL, so a single wrong uuid - a bug, a
-- future caller, a refactor - would rewrite a stranger's payment record
-- with no database check standing in the way.
--
-- Keying on the invoice inverts that. The caller presents an external
-- Stripe fact and CANNOT NAME AN ORDER AT ALL; the database performs
-- the whole join itself and can only ever reach an order that it can
-- prove came from a paid subscription invoice. It is the same capability
-- shape migration 019 already has, which also takes an external Stripe
-- identifier rather than a local primary key.
--
-- TWO PROPERTIES MAKE THAT A REAL BOUNDARY, not a stylistic preference:
--
--   (a) A ONE-TIME ORDER IS UNREACHABLE THROUGH THIS FUNCTION. A
--       one-time checkout attempt never carries a stripe_invoice_id,
--       so a non-blank invoice id can never match it, and blank input
--       is refused before any lookup. Migration 019 keeps every
--       one-time order and this one keeps every subscription order.
--       The two functions partition the table and neither can reach
--       the other's rows.
--
--   (b) THE BINDING CANNOT BE FORGED. checkout_attempts.stripe_invoice_id
--       has exactly one writer in the entire system: migration 022's
--       activate_subscription_from_invoice, which sets it from a
--       re-read Stripe invoice, once, under the subscription's row
--       lock, and which refuses an invoice already bound to a different
--       subscription both on its lookup path and in its unique_violation
--       handler. The application never writes that column; it only ever
--       selects it. So the fact this function keys on was established by
--       the database, from Stripe, and cannot be manufactured by a
--       caller of this function.
--
-- What the caller may present is therefore ONLY the invoice id. There is
-- deliberately no order id, no checkout attempt id, no subscription id,
-- no customer id, no email and no metadata in this signature, and the
-- amount is an input to the transition, never a way to choose a row.

-- 3. THE FUNCTION ──────────────────────────────────────────────
--
-- The refund-state transition below is migration 019's, reproduced arm
-- for arm rather than reinterpreted. That is the point: a subscription
-- order and a one-time order must reach the same payment_status from
-- the same facts, or the account page and the customer's email would
-- eventually disagree about what happened to the same money.
--
-- The only intended differences are:
--   * correlation identity (invoice instead of payment intent)
--   * 'ambiguous_payment_intent' becomes 'ambiguous_invoice_correlation'
--   * 'order_missing_for_attempt', which 019 has no analogue for because
--     it does not traverse a second table
--
-- NO CURRENCY ARGUMENT, and this is deliberate. Migration 019 is
-- currency-independent and deals only in integer cents; the currency
-- check lives in the application, in summarizeStripeRefunds, which
-- compares every Stripe refund against the order's own currency and
-- refuses the entire summary on a mismatch. Adding a currency parameter
-- here would create a second, divergent refund arithmetic for exactly
-- one class of order.
--
-- Absolute, not incremental. The caller passes the total settled refund
-- for this payment, so a duplicated or out-of-order webhook delivery
-- converges on the same row rather than accumulating - the same property
-- that makes 019 safe.

create or replace function public.apply_order_refund_state_by_invoice(
  p_stripe_invoice_id    text,
  p_refunded_total_cents integer,
  p_has_pending_refund   boolean
)
returns text
language plpgsql
volatile
security definer set search_path = ''
as $$
declare
  v_invoice_id  text;
  v_attempt_id  uuid;
  v_match_count integer;
  v_order       public.orders;
  v_new_status  text;
begin
  -- Expected bad input is answered, not raised. A caller that passes
  -- nothing usable must get a deterministic word back, exactly as 019
  -- does, so the webhook can log it and acknowledge rather than 500.
  if p_stripe_invoice_id is null
     or btrim(p_stripe_invoice_id) = ''
     or p_refunded_total_cents is null
     or p_refunded_total_cents < 0
  then
    return 'invalid_input';
  end if;

  v_invoice_id := btrim(p_stripe_invoice_id);

  -- 3a. INVOICE -> CHECKOUT ATTEMPT
  --
  -- The partial unique index from 022 already makes more than one row
  -- impossible. Counting anyway is the same defence 019 applies to an
  -- UNindexed column: if that index were ever dropped, this refuses
  -- instead of silently picking a row.
  select count(*) into v_match_count
  from public.checkout_attempts
  where stripe_invoice_id = v_invoice_id;

  if v_match_count = 0 then
    -- An invoice this system has no paid attempt for. Not an error: the
    -- Stripe account may hold invoices that were never fulfilled here.
    return 'order_not_found';
  end if;

  if v_match_count > 1 then
    return 'ambiguous_invoice_correlation';
  end if;

  select id into v_attempt_id
  from public.checkout_attempts
  where stripe_invoice_id = v_invoice_id;

  -- 3b. CHECKOUT ATTEMPT -> ORDER
  --
  -- Same reasoning against orders_checkout_attempt_id_key (011).
  select count(*) into v_match_count
  from public.orders
  where checkout_attempt_id = v_attempt_id;

  if v_match_count = 0 then
    -- Distinguished from 'order_not_found' on purpose. An unknown
    -- invoice is ordinary; a PAID attempt with no order is an internal
    -- inconsistency that deserves to be visible in a log rather than
    -- flattened into the same word. Both mutate nothing.
    return 'order_missing_for_attempt';
  end if;

  if v_match_count > 1 then
    return 'ambiguous_invoice_correlation';
  end if;

  -- 3c. LOCK, BEFORE ANY DECISION IS MADE
  --
  -- Every branch below reads payment_status, total_gross_cents and
  -- refunded_total_cents. All three are read from the LOCKED row, so a
  -- concurrent refund delivery for the same order serialises here rather
  -- than deciding from a snapshot that another transaction is changing.
  select * into v_order
  from public.orders
  where checkout_attempt_id = v_attempt_id
  for update;

  -- 3d. MIGRATION 019'S TRANSITION, UNCHANGED ──────────────────

  -- An order that was never paid has no refund story to tell.
  if v_order.payment_status not in ('paid', 'refund_pending', 'partially_refunded', 'refunded') then
    return 'not_applicable';
  end if;

  -- Never clamp. A total above what was actually charged means the
  -- inputs disagree with reality, and a half-understood refund state is
  -- worse than none.
  if p_refunded_total_cents > v_order.total_gross_cents then
    return 'invalid_amount';
  end if;

  if p_refunded_total_cents >= v_order.total_gross_cents and v_order.total_gross_cents > 0 then
    v_new_status := 'refunded';
  elsif p_refunded_total_cents > 0 then
    v_new_status := 'partially_refunded';
  elsif coalesce(p_has_pending_refund, false) then
    v_new_status := 'refund_pending';
  else
    -- No settled and no pending refund: any earlier refund attempt was
    -- cancelled or failed, so the order is simply paid again.
    v_new_status := 'paid';
  end if;

  -- NULL-safe on purpose. refunded_total_cents is nullable and NULL
  -- means "never observed", so a plain = would answer NULL for the
  -- first refund ever recorded on an order and fall through to an
  -- UPDATE that writes the same values it already holds.
  if v_order.payment_status = v_new_status
     and v_order.refunded_total_cents is not distinct from p_refunded_total_cents
  then
    return 'unchanged';
  end if;

  -- THREE COLUMNS. Not the snapshots, not the money totals, not the tax
  -- fields, not the shipment or cancellation state, not the checkout
  -- identifiers, not the order number, not the items, and not anything
  -- belonging to the subscription. A refund is a payment fact; whether
  -- the order is operationally cancelled stays the owner's decision.
  update public.orders
     set payment_status       = v_new_status,
         refunded_total_cents = p_refunded_total_cents,
         refund_updated_at    = now()
   where id = v_order.id;

  return 'applied';
end;
$$;

-- 4. PRIVILEGES ────────────────────────────────────────────────
--
-- Postgres grants EXECUTE on a new function to PUBLIC by default, so
-- the revoke is not decoration: without it every role in the database,
-- including the browser roles, could call a SECURITY DEFINER function
-- that writes payment state. The browser roles are revoked explicitly
-- as well, so the intent is stated rather than inherited, and the owner
-- role is revoked before being granted back the single privilege it
-- needs.
--
-- No table privilege is created, widened or touched by this migration.
-- The function runs as its owner and therefore needs none.

revoke all on function public.apply_order_refund_state_by_invoice(text, integer, boolean) from public;
revoke all on function public.apply_order_refund_state_by_invoice(text, integer, boolean) from anon;
revoke all on function public.apply_order_refund_state_by_invoice(text, integer, boolean) from authenticated;
revoke all on function public.apply_order_refund_state_by_invoice(text, integer, boolean) from service_role;

grant execute on function public.apply_order_refund_state_by_invoice(text, integer, boolean) to service_role;

-- 5. WHAT THIS MIGRATION DELIBERATELY DOES NOT DO ──────────────
--
-- IT CHANGES NO DATA. It does not call the function it creates, does
-- not update, insert or delete a row, does not backfill a payment
-- intent onto any historical order and does not touch historical refund
-- or subscription data. It is capability creation only.
--
-- IT DOES NOT MODIFY MIGRATION 019. apply_order_refund_state keeps its
-- text, its behaviour and its grant, and remains the writer for every
-- one-time order. Nothing here replaces or drops it.
--
-- IT ADDS NO SCHEMA. No ALTER TABLE, no CREATE TABLE, no CREATE INDEX,
-- no CREATE TRIGGER, no CREATE POLICY. The two unique indexes this
-- function relies on already exist, in 011 and 022, and are left alone.
--
-- IT WIRES NOTHING UP. No application code calls this function yet.
-- The runtime refund fallback - the reverse lookup from a refund's
-- payment intent to the invoice that payment settled - is a separate
-- phase, and until it exists this function is unreachable from the
-- server by anything except a deliberate call.
--
-- IT IS NOT A SECOND WRITER FOR ONE-TIME ORDERS. See section 2(a): the
-- partition is structural, not a rule anybody has to remember.

-- 6. VERIFY ────────────────────────────────────────────────────
--
-- Read-only. Run after applying. Nothing below writes.
--
-- (a) The function exists exactly once, with the intended signature,
--     and is SECURITY DEFINER with an emptied search_path.
--
--     select p.proname,
--            pg_get_function_identity_arguments(p.oid) as args,
--            p.prosecdef,
--            p.proconfig
--       from pg_proc p
--       join pg_namespace n on n.oid = p.pronamespace
--      where n.nspname = 'public'
--        and p.proname = 'apply_order_refund_state_by_invoice';
--
--     Expect one row: args 'p_stripe_invoice_id text,
--     p_refunded_total_cents integer, p_has_pending_refund boolean',
--     prosecdef true, proconfig {search_path=}.
--
-- (b) Only the server role may execute it. Expect exactly one row,
--     for service_role.
--
--     select r.rolname, has_function_privilege(r.rolname,
--              'public.apply_order_refund_state_by_invoice(text, integer, boolean)',
--              'EXECUTE') as can_execute
--       from pg_roles r
--      where r.rolname in ('anon', 'authenticated', 'service_role', 'public')
--        and has_function_privilege(r.rolname,
--              'public.apply_order_refund_state_by_invoice(text, integer, boolean)',
--              'EXECUTE');
--
-- (c) PUBLIC holds nothing. Expect zero rows mentioning '=X/' for the
--     empty grantee, which is how PUBLIC appears in an ACL.
--
--     select p.proacl
--       from pg_proc p
--       join pg_namespace n on n.oid = p.pronamespace
--      where n.nspname = 'public'
--        and p.proname = 'apply_order_refund_state_by_invoice';
--
-- (d) Migration 019's function is still there, still keyed on the
--     payment intent, and was not replaced. Expect one row.
--
--     select p.proname, pg_get_function_identity_arguments(p.oid) as args
--       from pg_proc p
--       join pg_namespace n on n.oid = p.pronamespace
--      where n.nspname = 'public'
--        and p.proname = 'apply_order_refund_state';
--
-- (e) The two unique indexes this function rests on are present and
--     were not redefined. Expect exactly two rows.
--
--     select indexname, indexdef
--       from pg_indexes
--      where schemaname = 'public'
--        and indexname in ('orders_checkout_attempt_id_key',
--                          'checkout_attempts_stripe_invoice_id_key');
--
-- (f) Nothing was mutated by applying this migration. Both counts
--     should be exactly what they were before.
--
--     select count(*) filter (where payment_status = 'partially_refunded') as partial,
--            count(*) filter (where payment_status = 'refunded')           as full
--       from public.orders;
--
-- (g) No role gained a table privilege. Expect the same rows as before
--     this migration: service_role SELECT on orders, plus the
--     column-scoped UPDATEs earlier migrations granted.
--
--     select grantee, privilege_type
--       from information_schema.role_table_grants
--      where table_schema = 'public'
--        and table_name = 'orders'
--      order by grantee, privilege_type;
