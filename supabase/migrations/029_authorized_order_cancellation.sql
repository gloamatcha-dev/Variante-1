-- ============================================================
-- GLOA – Authorized order cancellation transition (Phase 2C)
-- Run in Supabase SQL Editor AFTER 028
--
-- The audit that preceded this migration established the gap plainly:
-- a customer can ASK for a cancellation (migration 019's
-- request_order_cancellation writes cancellation_requested_at and an
-- optional note, and nothing else), but nothing in this repository could
-- actually cancel an order. Cancelling meant hand-written UPDATE
-- statements against a live public.orders, with no lifecycle guard, no
-- idempotency, no row lock and no audit. This migration replaces that
-- with one narrow, authorized transition.
--
-- 029 IS THE NEXT FREE NUMBER. 022-028 are live and immutable and are
-- not touched: 022 recurring subscription foundation, 023 stripe
-- customers grants, 024 subscription plan seed, 025 subscription plans
-- service_role grant, 026 internal order notification state, 027
-- shipment confirmation email state, 028 authorized shipment transition.
-- Task 21 (tax/VAT/OSS) still holds no migration file and remains free to
-- take a later number - this migration writes no tax field and leaves
-- every *_net_cents and tax_total_cents column exactly as it is.
--
-- ── WHY A FUNCTION AND NOT A GRANT ────────────────────────────
--
-- Identical reasoning to 028, and it has to be, because the alternative
-- is worse here than it was there. Granting service_role UPDATE on
-- status and fulfillment_status would let every line of server code
-- holding the service-role key cancel any order, un-cancel any order, or
-- push any order into any state in the migration 004 vocabulary. A
-- cancellation is more destructive than a shipment: it stops
-- fulfillment.
--
-- SECURITY DEFINER keeps the grant at zero. After this migration
-- service_role STILL cannot write status or fulfillment_status directly
-- - its UPDATE grant on public.orders remains column-scoped to the six
-- email-state columns from 017, 026 and 027. It can only ask this
-- function, and this function performs exactly the one transition below,
-- with every guard applied inside the same transaction as the write.
-- Same pattern as create_order_from_paid_checkout (011),
-- request_order_cancellation and apply_order_refund_state (019), and
-- mark_order_shipped (028).
--
-- ── WHAT THE CALLER MAY AND MAY NOT DECIDE ────────────────────
--
-- May: which order. That is the entire input surface - one order number,
-- and not one further parameter.
--
-- May not: anything else, and in particular
--
--   status              this function sets 'cancelled'. Not a parameter.
--   fulfillment_status  this function sets 'cancelled'. Not a parameter.
--   cancelled_at        this function sets now(). Not a parameter, so a
--                       caller can neither backdate a cancellation nor
--                       move an existing one.
--   payment_status, refunded_total_cents, refund_updated_at
--                       NEVER WRITTEN HERE. See the next section.
--   every *_cents column, every tax field, customer_snapshot,
--   shipping_address_snapshot, billing_address_snapshot,
--   shipping_carrier, tracking_number, tracking_url, shipped_at,
--   confirmation_email_status, internal_notification_status,
--   shipment_email_status and their timestamps
--                       never written here at all.
--
-- ── CANCELLATION AND REFUND ARE SEPARATE FACTS ────────────────
--
-- This function creates no refund, and it must never learn to. GLOA does
-- not call Stripe's refund-creation API anywhere (verified by audit);
-- refunds are initiated by hand in the Stripe Dashboard, and migration
-- 019's apply_order_refund_state then reconciles the result from an
-- absolute re-read of the payment intent's refunds. That pipeline is
-- already idempotent and is deliberately left completely untouched here.
--
-- So a cancelled order may legitimately still read payment_status =
-- 'paid'. That is not a bug and it is not a state to "fix" by writing
-- payment_status from here. It is an honest description of the world:
-- fulfillment has stopped, and the money has not moved back yet. Writing
-- payment_status = 'refunded' from a cancellation would be the
-- application asserting a refund that nobody performed, and the very
-- next refund webhook - which re-reads Stripe and finds zero settled
-- refunds - would correctly write it straight back to 'paid'. The two
-- systems would fight. They do not, because this one does not write that
-- column.
--
-- ── NO CUSTOMER EMAIL FROM HERE ───────────────────────────────
--
-- There is no trigger, no NOTIFY and no http call in this migration. The
-- cancellation customer email does not exist yet (Phase 2D); when it
-- does it will be the application's job, strictly after this transaction
-- has committed, exactly as 028 does it for the shipment confirmation. A
-- database trigger that mailed customers would fire on every future
-- backfill and correction anyone ever ran by hand.
--
-- ── NO DATA IS TOUCHED BY APPLYING THIS ───────────────────────
--
-- This migration adds one nullable column with no default and no
-- backfill, creates one function, and sets that function's grants. It
-- reads no row for a decision, writes no row, deletes no row, changes no
-- existing constraint, drops nothing, sends no email, and cancels
-- nothing. Applying it changes the behaviour and the content of exactly
-- zero existing orders. See verification (M) and (N).
-- ============================================================

-- 1. CANCELLATION TIMESTAMP ────────────────────────────────────
--
-- Nullable, no default, no backfill. An order that predates this
-- migration reads NULL, which honestly means "we do not know when, or it
-- never happened" - never a fabricated timestamp. Migration 004 has
-- carried 'cancelled' in both the status and fulfillment_status
-- vocabularies since the beginning but has never had anywhere to record
-- WHEN, so a hand-cancelled historical row (if one exists) keeps its
-- status and gains a NULL here rather than being rewritten.
--
-- Deliberately the ONLY column this migration adds. No cancellation
-- reason column: the customer's own words already have a home in
-- migration 019's cancellation_request_note, and an operator-side reason
-- has no reader anywhere in the application yet. A column nothing reads
-- is a column that silently rots.
alter table public.orders
  add column if not exists cancelled_at timestamptz;

-- 2. THE CANCELLATION TRANSITION ───────────────────────────────
--
-- Keyed on order_number rather than the uuid, matching 028 exactly and
-- for the same reason: the operational identifier is what an operator
-- actually has in front of them. It is what the internal fulfillment
-- email prints, and it is UNIQUE NOT NULL (migration 004), so there is
-- exactly one order behind one number and no ambiguity to resolve. The
-- durable uuid is RETURNED so the caller can log and correlate it
-- without ever having had to know it up front.
--
-- SIGNATURE IS ONE PARAMETER. No p_reason: the audit found no persisted
-- destination for an operator-supplied reason and no reader for one, so
-- accepting a string only to discard it - or adding a column nothing
-- displays - would be inventing a requirement. The customer's own
-- cancellation_request_note (019) remains the only cancellation free
-- text this system stores.
--
-- Returns jsonb rather than a bare status string, like 028 and unlike
-- 019's request_order_cancellation, because the caller genuinely needs
-- three facts back: what happened, which order it happened to, and when
-- it was cancelled. Nothing in the returned object is a customer fact:
-- no email, no name, no address, no amount, no snapshot, and not the
-- customer's cancellation note.
--
-- RESULT VOCABULARY (the route maps these to HTTP codes):
--   'not_found'         no order with that number
--   'not_cancellable'   already shipped or delivered - fulfillment
--                       cannot be un-done, so the honest answer is the
--                       statutory withdrawal route, not a cancellation
--   'already_cancelled' already cancelled - a true no-op, and
--                       cancelled_at is NOT moved
--   'cancelled'         applied now, for the first time
create or replace function public.cancel_order(
  p_order_number text
)
returns jsonb
language plpgsql
volatile
security definer set search_path = ''
as $$
declare
  v_order public.orders;
begin
  if p_order_number is null or btrim(p_order_number) = '' then
    return jsonb_build_object('result', 'not_found');
  end if;

  -- FOR UPDATE is what makes two concurrent authorized requests safe:
  -- the second waits here, and by the time it reads the row the first
  -- has already committed its transition, so it sees 'cancelled' and
  -- takes the idempotent path rather than writing a second time and
  -- moving cancelled_at. Normalized with btrim(upper(...)) exactly as
  -- mark_order_shipped does, so the two lookups cannot drift.
  select * into v_order
  from public.orders
  where order_number = btrim(upper(p_order_number))
  for update;

  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  -- ── ALREADY CANCELLED ───────────────────────────────────────
  -- Checked FIRST, before the shipped/delivered guard, so that an order
  -- which is already cancelled always reports 'already_cancelled' and
  -- never 'not_cancellable'. Both columns are tested because they are
  -- separately settable and either one saying 'cancelled' means the
  -- order is already stopped.
  --
  -- cancelled_at is deliberately NOT touched on this path. The order was
  -- cancelled when it was cancelled, and a repeated call - which is
  -- exactly what an operator retry looks like - must not rewrite that
  -- timestamp. Nothing else is written either: no payment state, no
  -- refund state, no snapshot, no email state. This branch performs zero
  -- writes.
  --
  -- A row cancelled by hand before this migration existed has a NULL
  -- cancelled_at, and this branch returns that NULL rather than
  -- backfilling a "now" that would be a lie.
  if v_order.status = 'cancelled' or v_order.fulfillment_status = 'cancelled' then
    return jsonb_build_object(
      'result', 'already_cancelled',
      'order_id', v_order.id,
      'order_number', v_order.order_number,
      'cancelled_at', v_order.cancelled_at
    );
  end if;

  -- ── SHIPPED / DELIVERED GUARD ───────────────────────────────
  -- The one rule this transition genuinely must never break. A parcel
  -- that has left cannot be un-shipped, and a delivery confirmation is a
  -- real-world fact that no operator action should be able to erase.
  -- Cancelling here would move the order BACKWARDS out of a state it has
  -- genuinely reached and would destroy shipped_at's meaning.
  --
  -- Both columns again, and this mirrors the existing repository rule:
  -- request_order_cancellation (019) already refuses the customer for
  -- status in ('shipped','delivered') or fulfillment_status in
  -- ('shipped','delivered'), and lib/orderStatus.ts renders exactly that
  -- case as 'too_late' with a pointer to /widerruf. The operator-side
  -- rule is the same rule; an operator does not get a bigger hammer for
  -- a thing that is physically impossible.
  if v_order.status in ('shipped', 'delivered')
     or v_order.fulfillment_status in ('shipped', 'delivered')
  then
    return jsonb_build_object(
      'result', 'not_cancellable',
      'order_id', v_order.id,
      'order_number', v_order.order_number
    );
  end if;

  -- ── LIFECYCLE GUARD ─────────────────────────────────────────
  -- The only two fulfillment states a cancellation may come from.
  -- 'unfulfilled' is what migration 004 defaults every new order to and
  -- is therefore the real-world case; 'processing' is in that same
  -- vocabulary and is a legitimate place to cancel from. 'shipped',
  -- 'delivered' and 'cancelled' are all handled above, so this is
  -- belt-and-braces against a future value being added to the
  -- fulfillment_status vocabulary without this function being revisited:
  -- an unrecognised state fails closed rather than being cancelled on a
  -- guess. Same defensive shape as 028's lifecycle guard.
  if v_order.fulfillment_status not in ('unfulfilled', 'processing') then
    return jsonb_build_object(
      'result', 'not_cancellable',
      'order_id', v_order.id,
      'order_number', v_order.order_number
    );
  end if;

  -- ── DELIBERATELY NO PAYMENT GUARD ───────────────────────────
  -- Unlike mark_order_shipped, this function does NOT gate on
  -- payment_status, and that asymmetry is intentional in both
  -- directions.
  --
  -- Shipping is irreversible and gives goods away, so 028 fails closed
  -- on anything but 'paid' and 'partially_refunded'. Cancelling is the
  -- protective direction: it STOPS fulfillment. Refusing to stop an
  -- order because of its payment state would be refusing to apply the
  -- brake.
  --
  -- Concretely, every payment_status in the 019 vocabulary may be
  -- cancelled:
  --   'pending'            never paid, and stopping it is obviously fine
  --   'failed'             never paid
  --   'paid'               THE ORDINARY CASE, and the whole point. The
  --                        refund is a separate Stripe Dashboard action.
  --                        A cancelled-but-still-paid order is a real,
  --                        expected, temporary state
  --   'refund_pending'     money is on its way back; stopping the parcel
  --                        is exactly right
  --   'partially_refunded' a goodwill correction on an order the owner
  --                        has now decided not to send at all
  --   'refunded'           money already back. Cancelling closes the
  --                        operational side of a row that would
  --                        otherwise sit at 'unfulfilled' forever
  --
  -- There is deliberately no rule that a refund must happen first.
  -- Requiring one would invent a constraint the repository does not have
  -- and would make the brake depend on a manual dashboard action.

  -- ── THE TRANSITION ──────────────────────────────────────────
  -- THREE columns, and not one of them is money, tax, a snapshot, a
  -- payment state, a refund state, a tracking field or an email state.
  -- cancelled_at is now() - server time, never a caller's value.
  --
  -- status and fulfillment_status move TOGETHER, in one statement, in
  -- one transaction. Migration 004 gives both columns a 'cancelled'
  -- value and lib/orderStatus.ts reads either (isCancelled checks both),
  -- so setting only one would leave the two disagreeing about the same
  -- order and would make the customer's label depend on which column a
  -- given code path happened to consult. Because both move, the existing
  -- account UI renders 'Storniert' and an empty lifecycle step list with
  -- no UI change whatsoever.
  --
  -- cancellation_requested_at and cancellation_request_note are NOT
  -- cleared. They are historical facts about what the customer asked and
  -- when, they remain true after the cancellation is granted, and
  -- destroying them would destroy the only record of why this happened.
  update public.orders
     set status             = 'cancelled',
         fulfillment_status = 'cancelled',
         cancelled_at       = now()
   where id = v_order.id;

  return jsonb_build_object(
    'result', 'cancelled',
    'order_id', v_order.id,
    'order_number', v_order.order_number,
    'cancelled_at', now()
  );
end;
$$;

-- 3. EXECUTE PRIVILEGES ────────────────────────────────────────
--
-- No browser role may ever call this. revoke from public FIRST, because
-- a freshly created function is executable by PUBLIC by default and
-- anon/authenticated inherit that - revoking only the named roles would
-- leave the default in place and the function reachable from the
-- browser's own Supabase client with nothing but an anon key.
--
-- service_role is the only grantee, and it holds the key that never
-- leaves the server (lib/supabaseAdmin.ts). Reaching this function
-- therefore requires the service-role key AND the separate
-- CANCELLATION_ADMIN_SECRET the route checks first: two independent
-- secrets, neither of which is in a client bundle.
--
-- CANCELLATION_ADMIN_SECRET is deliberately NOT FULFILLMENT_ADMIN_SECRET.
-- Shipping and cancelling are two different destructive operational
-- capabilities, and a secret shared between two endpoints makes each of
-- them as reachable as the most widely copied instance of that value.
revoke all on function public.cancel_order(text) from public;
revoke all on function public.cancel_order(text) from anon;
revoke all on function public.cancel_order(text) from authenticated;
grant execute on function public.cancel_order(text) to service_role;

-- VERIFY ───────────────────────────────────────────────────────
--
-- Read-only. Run after applying. No statement below writes a row,
-- cancels an order, creates a refund or sends an email.
--
-- (A)(B)(C) THE COLUMN EXISTS, IS NULLABLE, AND HAS NO DEFAULT.
--     Expected: exactly one row - cancelled_at, timestamp with time
--     zone, is_nullable = YES, column_default = NULL.
--
--     A non-NULL column_default here would mean every future order is
--     born with a cancellation timestamp, which would make cancelled_at
--     meaningless. is_nullable = NO would mean the ALTER had to invent a
--     value for every historical row.
--
--   select column_name, data_type, is_nullable, column_default
--   from information_schema.columns
--   where table_schema = 'public'
--     and table_name   = 'orders'
--     and column_name  = 'cancelled_at';
--
-- (D)(E)(F) THE FUNCTION EXISTS, with exactly ONE text argument and a
--     jsonb return type. Expected: exactly one row.
--
--     One argument is the check that matters: a second parameter would
--     mean a caller can influence something beyond which order.
--
--   select p.proname,
--          pg_get_function_identity_arguments(p.oid) as arguments,
--          pg_get_function_result(p.oid)             as returns
--   from pg_proc p
--   join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public' and p.proname = 'cancel_order';
--
--   Expected arguments: text
--   Expected returns:   jsonb
--
-- (G) SECURITY DEFINER IS TRUE. Expected: security_definer = true.
--     If this is false the function runs as the caller, service_role has
--     no write access to status or fulfillment_status, and every call
--     fails.
--
--   select p.proname, p.prosecdef as security_definer
--   from pg_proc p
--   join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public' and p.proname = 'cancel_order';
--
-- (H) SAFE search_path. Expected: proconfig contains exactly
--     {"search_path="} - an EMPTY search path. A SECURITY DEFINER
--     function without this can be hijacked by a caller who creates a
--     same-named table or function in a schema that resolves first.
--
--   select p.proname, p.proconfig
--   from pg_proc p
--   join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public' and p.proname = 'cancel_order';
--
-- (I)(J)(K)(L) WHO MAY EXECUTE IT. The important block.
--     Expected: false, false, false, true - in that order.
--
--   select
--     has_function_privilege('public',        'public.cancel_order(text)', 'execute') as public_can,
--     has_function_privilege('anon',          'public.cancel_order(text)', 'execute') as anon_can,
--     has_function_privilege('authenticated', 'public.cancel_order(text)', 'execute') as authenticated_can,
--     has_function_privilege('service_role',  'public.cancel_order(text)', 'execute') as service_role_can;
--
--     And the raw ACL, which should name service_role and nothing else:
--
--   select p.proname, p.proacl
--   from pg_proc p
--   join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public' and p.proname = 'cancel_order';
--
-- (M) NO EXISTING ORDER WAS MODIFIED BY APPLYING THIS MIGRATION.
--     THE IMPORTANT ONE. Applying this cancels nothing.
--
--     Expected: newly_cancelled = 0, and cancelled_orders exactly
--     whatever it was before you applied this. If cancelled_orders is
--     non-zero those are cancellations the owner made by hand before
--     this function existed - correct, and untouched.
--
--   select count(*)                                                        as orders,
--          count(*) filter (where status = 'cancelled')                    as cancelled_orders,
--          count(*) filter (where fulfillment_status = 'cancelled')        as cancelled_fulfillment,
--          count(*) filter (where cancelled_at > now() - interval '1 hour') as newly_cancelled
--   from public.orders;
--
-- (N) NO HISTORICAL cancelled_at BACKFILL. Expected: with_cancelled_at
--     = 0 immediately after applying. Every pre-existing row, including
--     any that was already cancelled by hand, must read NULL - the
--     column was added without a default and nothing populated it.
--
--   select count(cancelled_at) as with_cancelled_at,
--          count(*)            as total_orders
--   from public.orders;
--
-- (O) NO TRIGGER ADDED. Nothing was attached to public.orders by this
--     migration, and in particular nothing that could mail a customer or
--     cancel an order automatically. Expected: only the
--     set_orders_updated_at trigger from migration 004.
--
--   select tgname, pg_get_triggerdef(oid) as definition
--   from pg_trigger
--   where tgrelid = 'public.orders'::regclass and not tgisinternal
--   order by tgname;
--
-- (P)(Q)(R) THE GRANTS DID NOT MOVE. THE OTHER IMPORTANT ONE.
--
--     Expected: service_role holds column-scoped UPDATE on EXACTLY these
--     six columns and no others -
--
--       confirmation_email_status, confirmation_email_sent_at   (017)
--       internal_notification_status, internal_notification_sent_at (026)
--       shipment_email_status, shipment_email_sent_at           (027)
--
--     (P) 'status' MUST NOT appear in that list.
--     (Q) 'fulfillment_status' MUST NOT appear in that list.
--     (R) 'payment_status', 'refunded_total_cents', 'refund_updated_at',
--         'cancelled_at' and every *_cents / tax column MUST NOT appear
--         either. This migration adds no column grant at all: cancelled_at
--         is written only from inside the SECURITY DEFINER function.
--
--     anon and authenticated must not appear as UPDATE grantees at all.
--
--   select grantee, column_name, privilege_type
--   from information_schema.column_privileges
--   where table_schema = 'public' and table_name = 'orders'
--     and privilege_type = 'UPDATE'
--     and grantee in ('anon', 'authenticated', 'service_role')
--   order by grantee, column_name;
--
--     And no table-level write privilege appeared:
--
--   select grantee, privilege_type
--   from information_schema.role_table_grants
--   where table_schema = 'public' and table_name = 'orders'
--     and grantee in ('anon', 'authenticated', 'service_role')
--   order by grantee, privilege_type;
--
--     Expected: service_role SELECT only (plus the column-scoped UPDATE
--     above, which does not appear in role_table_grants), authenticated
--     SELECT only, anon absent entirely.
--
-- (S) MIGRATIONS 022 THROUGH 028 ARE UNTOUCHED. Their objects still
--     exist with their own privileges, unchanged by this migration.
--     Expected: all four functions present, all SECURITY DEFINER, all
--     executable by service_role only.
--
--   select p.proname,
--          p.prosecdef as security_definer,
--          p.proconfig,
--          has_function_privilege('anon',         p.oid, 'execute') as anon_can,
--          has_function_privilege('service_role', p.oid, 'execute') as service_role_can
--   from pg_proc p
--   join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public'
--     and p.proname in ('mark_order_shipped',            -- 028
--                       'request_order_cancellation',    -- 019
--                       'apply_order_refund_state',      -- 019
--                       'cancel_order')                  -- 029, this one
--   order by p.proname;
--
--     And 019's refund state model is exactly as it was - the payment
--     vocabulary still carries all six values and the refund range check
--     still stands. Nothing in this migration touches either.
--
--   select conname, pg_get_constraintdef(oid) as definition
--   from pg_constraint
--   where conrelid = 'public.orders'::regclass
--     and contype = 'c'
--     and conname in ('orders_payment_status_check',
--                     'orders_refunded_total_cents_range_check',
--                     'orders_cancellation_request_note_length_check',
--                     'orders_tracking_url_scheme_check')
--   order by conname;
--
--     Expected: orders_payment_status_check still allows
--     'pending','paid','failed','refund_pending','partially_refunded',
--     'refunded'.
--
--     And 019's customer cancellation REQUEST columns are still present
--     and still nullable - this migration neither reads nor clears them:
--
--   select column_name, data_type, is_nullable, column_default
--   from information_schema.columns
--   where table_schema = 'public' and table_name = 'orders'
--     and column_name in ('cancellation_requested_at',
--                         'cancellation_request_note',
--                         'refunded_total_cents',
--                         'refund_updated_at',
--                         'payment_status')
--   order by column_name;
