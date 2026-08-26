-- ============================================================
-- GLOA – Open cancellation request shipment guard (Phase 2D-C)
-- Run in Supabase SQL Editor AFTER 031
--
-- One rule, added to one function: an order must not be marked shipped
-- while a customer is still waiting to hear whether it can be stopped.
--
-- ── WHY THIS COULD NOT BE BUILT BEFORE ────────────────────────
--
-- Phase 2D-A wanted this guard and deliberately refused to add it, and
-- the refusal was correct. At that point the only thing the schema could
-- say was "a cancellation request exists" (migration 019's
-- cancellation_requested_at). There was no way to say a request had been
-- ANSWERED, so a guard keyed on that column alone would have blocked an
-- order's shipment FOREVER the moment a customer asked - including every
-- request the owner looked at and decided not to grant.
--
-- Migration 031 fixed that by adding a terminal resolution. The rule
-- finally has a correct form, and it is the whole content of this
-- migration:
--
--   an OPEN request  =  cancellation_requested_at IS NOT NULL
--                       AND cancellation_request_resolution IS NULL
--
-- A DECLINED request is resolved. It does not block, and this migration
-- is careful to make that true rather than merely intended: the
-- predicate tests the resolution for NULL, not for any particular value,
-- so both 'approved' and 'declined' clear it.
--
-- 032 IS THE NEXT FREE NUMBER. 022-031 are live and immutable and are
-- not touched: 022 recurring subscription foundation, 023 stripe
-- customers grants, 024 subscription plan seed, 025 subscription plans
-- service_role grant, 026 internal order notification state, 027
-- shipment confirmation email state, 028 authorized shipment transition,
-- 029 authorized order cancellation, 030 cancellation request
-- notification state, 031 cancellation request resolution. Task 21
-- (tax/VAT/OSS) still holds no migration file and remains free to take a
-- later number - this migration writes no tax field.
--
-- ── WHY THE GUARD IS IN THE DATABASE AND NOT IN THE ROUTE ─────
--
-- This is the point of the whole migration, and a check in
-- app/api/internal/orders/ship/route.ts would not have been a smaller
-- version of it - it would have been a broken one.
--
-- A route-level check reads the order, decides, and then calls the RPC.
-- Between the read and the write another transaction can commit
-- request_order_cancellation, and the shipment would then proceed on a
-- stale read: the customer's request lands a millisecond before the
-- parcel is marked gone, and nothing notices. The window is small and it
-- is real, and the consequence is the exact failure this feature exists
-- to prevent.
--
-- Inside mark_order_shipped the check happens AFTER `select ... for
-- update` has taken a row lock on that specific order. Every other
-- writer of the relevant columns takes the same lock on the same row:
--
--   request_order_cancellation           (019) - for update
--   apply_order_refund_state             (019) - for update
--   cancel_order                         (029) - for update
--   resolve_order_cancellation_request   (031) - for update
--   mark_order_shipped                   (028, replaced here) - for update
--
-- so the five of them serialize against each other on that row. Whoever
-- gets the lock first commits first; whoever gets it second reads
-- post-commit state and decides on facts, never on a stale snapshot.
-- There is no interleaving in which an unresolved request and a fresh
-- shipment both succeed.
--
-- ── WHAT THIS MIGRATION CHANGES, EXACTLY ──────────────────────
--
-- It replaces public.mark_order_shipped with a body that is IDENTICAL to
-- migration 028's in every respect except for one added guard and one
-- added result value. Deliberately unchanged, line for line:
--
--   the signature            (text, text, text, text) -> jsonb
--   SECURITY DEFINER, search_path = '', language, volatility
--   the pre-lock input normalization and the three length ceilings
--   the tracking URL scheme check
--   the lookup, its btrim(upper(...)) normalization, and FOR UPDATE
--   the 'already_advanced' guard for delivered orders
--   the 'already_shipped' / 'conflict' idempotency pair
--   the cancelled/refunded guard
--   the payment guard, including that 'partially_refunded' still ships
--   the lifecycle guard
--   the six-column UPDATE and every value it writes
--   every existing result string and every returned jsonb field
--   the grants
--
-- 028 IS NOT EDITED. It stays exactly as it was applied and verified;
-- this migration supersedes its function definition through CREATE OR
-- REPLACE, which is the only mechanism available and which preserves the
-- function's ownership and ACL.
--
-- ── APPLYING THIS TOUCHES NO DATA ─────────────────────────────
--
-- One function replaced, its grants re-stated. No column is added, no
-- constraint changed, no trigger created, no row read for a decision,
-- written, or deleted. Nothing ships, nothing is cancelled, nothing is
-- resolved, no refund moves and no email is sent. See verification (I).
-- ============================================================

-- 1. THE SHIPMENT TRANSITION, PLUS ONE GUARD ───────────────────
--
-- RESULT VOCABULARY. Migration 028's six, unchanged, plus exactly one:
--
--   'not_found'              no order with that number
--   'not_shippable'          cancelled, or not in a payment/lifecycle
--                            state that ships
--   'already_advanced'       already 'delivered' - never moved backwards
--   'conflict'               already shipped, with DIFFERENT tracking
--   'already_shipped'        already shipped with IDENTICAL data - a
--                            true no-op, and shipped_at is not moved
--   'shipped'                applied now, for the first time
--
--   'cancellation_request_open'   NEW. The customer has asked whether
--                            this order can still be stopped and nobody
--                            has answered yet. THE ORDER IS NOT
--                            CANCELLED, no refund is implied, and
--                            nothing about the order has changed. The
--                            operator must resolve the request
--                            (POST /api/internal/orders/cancellation-request/resolve)
--                            and may then ship it if they declined it.
--
-- The name says REQUEST and says OPEN, deliberately. A result called
-- 'cancellation_pending' would read as "this order is being cancelled",
-- which is not a fact that follows from an unanswered question.
create or replace function public.mark_order_shipped(
  p_order_number    text,
  p_carrier         text default null,
  p_tracking_number text default null,
  p_tracking_url    text default null
)
returns jsonb
language plpgsql
volatile
security definer set search_path = ''
as $$
declare
  v_order    public.orders;
  v_carrier  text;
  v_number   text;
  v_url      text;
begin
  if p_order_number is null or btrim(p_order_number) = '' then
    return jsonb_build_object('result', 'not_found');
  end if;

  -- Normalized here as well as in the route, so the two representations
  -- of "no carrier" - '' and NULL - can never both reach a column and
  -- make an idempotent repeat look like a conflict.
  v_carrier := nullif(btrim(coalesce(p_carrier, '')), '');
  v_number  := nullif(btrim(coalesce(p_tracking_number, '')), '');
  v_url     := nullif(btrim(coalesce(p_tracking_url, '')), '');

  -- Technical ceilings, matching lib/shipmentTransitionRules.ts.
  if char_length(coalesce(v_carrier, '')) > 100
     or char_length(coalesce(v_number, '')) > 100
     or char_length(coalesce(v_url, '')) > 500
  then
    return jsonb_build_object('result', 'not_shippable');
  end if;

  -- The same scheme rule as migration 019's CHECK constraint and as
  -- sanitizeTrackingUrl.
  if v_url is not null and v_url !~* '^https?://[^[:space:]]+$' then
    return jsonb_build_object('result', 'not_shippable');
  end if;

  -- ── THE ROW LOCK ────────────────────────────────────────────
  -- Everything below this line decides on post-commit facts. A
  -- concurrent request_order_cancellation, resolve_order_cancellation_request
  -- or cancel_order either committed before this lock was granted - in
  -- which case its effect is visible below - or waits here until this
  -- transaction commits. There is no third case, and that is what makes
  -- the new guard sound rather than merely likely.
  select * into v_order
  from public.orders
  where order_number = btrim(upper(p_order_number))
  for update;

  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  -- ── ALREADY ADVANCED ────────────────────────────────────────
  -- 'delivered' is strictly later than 'shipped'.
  if v_order.fulfillment_status = 'delivered' or v_order.status = 'delivered' then
    return jsonb_build_object(
      'result', 'already_advanced',
      'order_id', v_order.id,
      'order_number', v_order.order_number,
      'shipped_at', v_order.shipped_at
    );
  end if;

  -- ── ALREADY SHIPPED ─────────────────────────────────────────
  -- Idempotent when the supplied normalized data is identical to what is
  -- persisted, and a conflict when it is not. shipped_at is deliberately
  -- NOT touched on this path.
  --
  -- THIS BRANCH DELIBERATELY SITS ABOVE THE NEW CANCELLATION GUARD, and
  -- the ordering is load-bearing rather than incidental. See the long
  -- note on placement below.
  if v_order.fulfillment_status = 'shipped' then
    if v_order.shipping_carrier is not distinct from v_carrier
       and v_order.tracking_number is not distinct from v_number
       and v_order.tracking_url    is not distinct from v_url
    then
      return jsonb_build_object(
        'result', 'already_shipped',
        'order_id', v_order.id,
        'order_number', v_order.order_number,
        'shipped_at', v_order.shipped_at
      );
    end if;

    return jsonb_build_object(
      'result', 'conflict',
      'order_id', v_order.id,
      'order_number', v_order.order_number,
      'shipped_at', v_order.shipped_at
    );
  end if;

  -- ── CANCELLATION GUARD ──────────────────────────────────────
  -- A cancelled order is never newly shipped, from either column.
  --
  -- This is also what covers an APPROVED cancellation request, and it is
  -- why this migration adds no approved-specific rule: approving a
  -- request runs cancel_order in the same transaction (migration 031
  -- delegates to 029), so an approved order is a cancelled order and is
  -- refused right here, exactly as it was before this migration existed.
  if v_order.fulfillment_status = 'cancelled'
     or v_order.status in ('cancelled', 'refunded')
  then
    return jsonb_build_object(
      'result', 'not_shippable',
      'order_id', v_order.id,
      'order_number', v_order.order_number
    );
  end if;

  -- ── PAYMENT GUARD ───────────────────────────────────────────
  -- 'partially_refunded' IS allowed; 'refunded', 'refund_pending',
  -- 'pending' and 'failed' are refused. Unchanged from 028.
  if v_order.payment_status not in ('paid', 'partially_refunded') then
    return jsonb_build_object(
      'result', 'not_shippable',
      'order_id', v_order.id,
      'order_number', v_order.order_number
    );
  end if;

  -- ── LIFECYCLE GUARD ─────────────────────────────────────────
  -- The only two fulfillment states a first shipment may come from.
  if v_order.fulfillment_status not in ('unfulfilled', 'processing') then
    return jsonb_build_object(
      'result', 'not_shippable',
      'order_id', v_order.id,
      'order_number', v_order.order_number
    );
  end if;

  -- ── OPEN CANCELLATION REQUEST GUARD (NEW IN 032) ────────────
  --
  -- THE PREDICATE. Nothing broader:
  --
  --   cancellation_requested_at        IS NOT NULL   the customer asked
  --   cancellation_request_resolution  IS NULL       nobody has answered
  --
  -- Both halves are required. An order nobody asked about has a NULL
  -- timestamp and is unaffected. A DECLINED request has a non-NULL
  -- resolution and is unaffected - which is the entire reason migration
  -- 031 had to exist before this guard could. An APPROVED request also
  -- has a non-NULL resolution and would clear this test, but never
  -- reaches it: the cancelled guard above already refused it.
  --
  -- WHY THIS IS THE LAST GUARD, IMMEDIATELY BEFORE THE WRITE. Two
  -- separate reasons, and both matter.
  --
  -- 1. IDEMPOTENCY IS PRESERVED EXACTLY. 'already_advanced',
  --    'already_shipped' and 'conflict' are all decided above this
  --    point, so an order that has ALREADY shipped answers precisely
  --    what it answered before this migration - byte for byte, including
  --    its shipped_at. That matters concretely: repeating an identical
  --    authorized request is the manual retry path for a shipment
  --    confirmation email that failed, and it works because
  --    'already_shipped' is a durable result the route re-enters the
  --    sender on. If this guard sat above that branch, a historical row
  --    that is genuinely shipped AND carries an unanswered request - a
  --    row the owner could have created by hand before any of this
  --    existed - would suddenly start reporting
  --    'cancellation_request_open', the operator would be told a
  --    delivered parcel was blocked, and the email retry path would
  --    silently stop working. A later cancellation request must never be
  --    able to rewrite a historical shipment result.
  --
  -- 2. IT CHANGES THE ANSWER FOR THE SMALLEST POSSIBLE SET OF ORDERS.
  --    Placed last, the only orders whose result differs from 028 are
  --    exactly those that would otherwise have SHIPPED. An order that is
  --    cancelled, unpaid, refunded or in a lifecycle state that cannot
  --    ship still returns 'not_shippable' for the reason it always did,
  --    rather than having its diagnosis replaced by a newer one. The
  --    more fundamental fact keeps priority.
  --
  -- IT WRITES NOTHING. This branch performs zero UPDATEs. It does not
  -- touch fulfillment_status, status, shipped_at or any tracking column;
  -- it does not touch the customer's cancellation_requested_at or
  -- cancellation_request_note, nor the resolution columns - answering
  -- the request is the operator's decision and this function must never
  -- make it; it does not touch payment_status, refunded_total_cents,
  -- refund_updated_at, any money or tax column, any snapshot, or any of
  -- the ten email-state columns. The order is returned to the caller in
  -- exactly the state it was read in.
  --
  -- NO EMAIL FOLLOWS. The route only attempts the shipment confirmation
  -- for a result that left the order durably shipped ('shipped' or
  -- 'already_shipped'), and this is neither.
  if v_order.cancellation_requested_at is not null
     and v_order.cancellation_request_resolution is null
  then
    return jsonb_build_object(
      'result', 'cancellation_request_open',
      'order_id', v_order.id,
      'order_number', v_order.order_number
    );
  end if;

  -- ── THE TRANSITION ──────────────────────────────────────────
  -- Six columns, unchanged from 028. Not one of them is money, tax, a
  -- snapshot, a payment state, a cancellation column or an email state.
  update public.orders
     set fulfillment_status = 'shipped',
         status             = 'shipped',
         shipped_at         = now(),
         shipping_carrier   = v_carrier,
         tracking_number    = v_number,
         tracking_url       = v_url
   where id = v_order.id;

  return jsonb_build_object(
    'result', 'shipped',
    'order_id', v_order.id,
    'order_number', v_order.order_number,
    'shipped_at', now()
  );
end;
$$;

-- 2. EXECUTE PRIVILEGES ────────────────────────────────────────
--
-- CREATE OR REPLACE FUNCTION preserves the existing owner and ACL, so
-- these statements are strictly a re-assertion of what migration 028
-- already established. They are re-issued anyway, for two reasons: this
-- migration is then self-contained if it is ever applied to a rebuilt
-- database, and the privilege model of a SECURITY DEFINER function that
-- can move fulfillment state should be stated where the function is
-- defined rather than left implicit one migration back.
--
-- revoke from public FIRST - anon and authenticated inherit PUBLIC's
-- default EXECUTE, so revoking only the named roles would leave the
-- function reachable from the browser's own Supabase client.
revoke all on function public.mark_order_shipped(text, text, text, text) from public;
revoke all on function public.mark_order_shipped(text, text, text, text) from anon;
revoke all on function public.mark_order_shipped(text, text, text, text) from authenticated;
grant execute on function public.mark_order_shipped(text, text, text, text) to service_role;

-- VERIFY ───────────────────────────────────────────────────────
--
-- Read-only. Run after applying. No statement below ships an order,
-- cancels one, resolves a request, creates a refund or sends an email.
--
-- (A) THE FUNCTION STILL HAS THE SAME SIGNATURE. Expected: exactly one
--     row, four text arguments, jsonb return. A different signature would
--     mean a SECOND overload now exists alongside the old one, and the
--     route would be calling whichever Postgres resolved - the single
--     most dangerous way this migration could go wrong.
--
--   select p.proname,
--          pg_get_function_identity_arguments(p.oid) as arguments,
--          pg_get_function_result(p.oid)             as returns
--   from pg_proc p
--   join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public' and p.proname = 'mark_order_shipped';
--
--     Expected: EXACTLY ONE ROW. arguments = text, text, text, text.
--     returns = jsonb. If two rows come back, STOP: an overload was
--     created and must be dropped.
--
-- (B) SECURITY DEFINER IS STILL TRUE, AND THE search_path IS STILL EMPTY.
--     Expected: security_definer = true, proconfig = {"search_path="}.
--
--   select p.proname, p.prosecdef as security_definer, p.proconfig
--   from pg_proc p
--   join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public' and p.proname = 'mark_order_shipped';
--
-- (C) WHO MAY EXECUTE IT. Expected: false, false, false, true.
--
--   select
--     has_function_privilege('public',        'public.mark_order_shipped(text,text,text,text)', 'execute') as public_can,
--     has_function_privilege('anon',          'public.mark_order_shipped(text,text,text,text)', 'execute') as anon_can,
--     has_function_privilege('authenticated', 'public.mark_order_shipped(text,text,text,text)', 'execute') as authenticated_can,
--     has_function_privilege('service_role',  'public.mark_order_shipped(text,text,text,text)', 'execute') as service_role_can;
--
--     And the raw ACL, which should name service_role and nothing else:
--
--   select p.proname, p.proacl, pg_get_userbyid(p.proowner) as owner
--   from pg_proc p
--   join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public' and p.proname = 'mark_order_shipped';
--
-- (D) THE NEW GUARD IS PRESENT AND THE PREDICATE IS EXACTLY RIGHT.
--     Expected: has_guard = true, tests_resolution_for_null = true.
--
--     tests_resolution_for_null is the assertion that matters. The guard
--     must test the resolution for NULL, NOT for a particular value: a
--     predicate of the form "resolution <> 'approved'" would block every
--     DECLINED request forever, which is the exact bug Phase 2D-A
--     withheld this guard to avoid.
--
--   select
--     p.prosrc like '%cancellation_request_open%'                     as has_guard,
--     p.prosrc like '%cancellation_request_resolution is null%'       as tests_resolution_for_null,
--     p.prosrc like '%cancellation_requested_at is not null%'         as tests_request_exists
--   from pg_proc p
--   join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public' and p.proname = 'mark_order_shipped';
--
--     Expected: true, true, true.
--
-- (E) THE GUARD IS AFTER THE LOCK AND AFTER THE IDEMPOTENCY BRANCH.
--     Expected: all three true. This is the placement argument, checked
--     against the live function body rather than against this file.
--
--   select
--     position('for update'                in p.prosrc)
--       < position('cancellation_request_open' in p.prosrc)   as guard_after_lock,
--     position('already_shipped'           in p.prosrc)
--       < position('cancellation_request_open' in p.prosrc)   as guard_after_idempotency,
--     position('cancellation_request_open' in p.prosrc)
--       < position('update public.orders'  in p.prosrc)       as guard_before_write
--   from pg_proc p
--   join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public' and p.proname = 'mark_order_shipped';
--
-- (F) EVERY PRE-EXISTING GUARD SURVIVED. Expected: all true.
--
--   select
--     p.prosrc like '%already_advanced%'                                            as delivered_guard,
--     p.prosrc like '%is not distinct from%'                                        as idempotency_guard,
--     p.prosrc like '%v_order.status in (''cancelled'', ''refunded'')%'             as cancelled_guard,
--     p.prosrc like '%payment_status not in (''paid'', ''partially_refunded'')%'    as payment_guard,
--     p.prosrc like '%fulfillment_status not in (''unfulfilled'', ''processing'')%' as lifecycle_guard,
--     p.prosrc like '%shipped_at         = now()%'                                  as writes_server_time
--   from pg_proc p
--   join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public' and p.proname = 'mark_order_shipped';
--
-- (G) THE GRANTS DID NOT MOVE. THE IMPORTANT ONE.
--
--     Expected: service_role holds column-scoped UPDATE on EXACTLY the
--     ten email-state columns and no others -
--
--       confirmation_email_status, confirmation_email_sent_at            (017)
--       internal_notification_status, internal_notification_sent_at      (026)
--       shipment_email_status, shipment_email_sent_at                    (027)
--       cancellation_request_notification_status, ..._sent_at            (030)
--       cancellation_outcome_email_status, ..._email_sent_at             (031)
--
--     MUST NOT appear: 'status', 'fulfillment_status', 'shipped_at',
--     'shipping_carrier', 'tracking_number', 'tracking_url',
--     'cancelled_at', 'cancellation_requested_at',
--     'cancellation_request_note', 'cancellation_request_resolution',
--     'cancellation_request_resolved_at', 'payment_status',
--     'refunded_total_cents', 'refund_updated_at', and every *_cents,
--     tax and snapshot column.
--
--     anon and authenticated must not appear as UPDATE grantees at all.
--     This migration adds no grant of any kind; it only re-states 028's
--     four function-privilege statements.
--
--   select grantee, column_name, privilege_type
--   from information_schema.column_privileges
--   where table_schema = 'public' and table_name = 'orders'
--     and privilege_type = 'UPDATE'
--     and grantee in ('anon', 'authenticated', 'service_role')
--   order by grantee, column_name;
--
--   select grantee, privilege_type
--   from information_schema.role_table_grants
--   where table_schema = 'public' and table_name = 'orders'
--     and grantee in ('anon', 'authenticated', 'service_role')
--   order by grantee, privilege_type;
--
--     Expected: service_role SELECT only, authenticated SELECT only,
--     anon absent entirely.
--
-- (H) NO TRIGGER ADDED. Expected: only set_orders_updated_at from 004.
--
--   select tgname, pg_get_triggerdef(oid) as definition
--   from pg_trigger
--   where tgrelid = 'public.orders'::regclass and not tgisinternal
--   order by tgname;
--
-- (I) NO ORDER WAS TOUCHED BY APPLYING THIS. THE IMPORTANT ONE.
--     Applying this migration ships nothing, blocks nothing
--     retroactively, cancels nothing and resolves nothing.
--
--     Expected: newly_shipped = 0. Every other count is expected to be
--     exactly whatever it was before you applied this.
--
--     blocked_from_now_on is the number of orders that WOULD now be
--     refused a first shipment by the new guard. After 031's verification
--     reported zero cancellation requests in production, this is expected
--     to be 0. A non-zero value is not an error - it is precisely the set
--     of orders someone must now make a decision about.
--
--   select count(*)                                                        as orders,
--          count(*) filter (where fulfillment_status = 'shipped')           as shipped_orders,
--          count(*) filter (where shipped_at > now() - interval '1 hour')   as newly_shipped,
--          count(cancellation_requested_at)                                 as requests,
--          count(cancellation_request_resolution)                           as resolved,
--          count(*) filter (where cancellation_requested_at is not null
--                             and cancellation_request_resolution is null
--                             and fulfillment_status in ('unfulfilled', 'processing'))
--                                                                           as blocked_from_now_on
--   from public.orders;
--
-- (J) NO ALREADY-SHIPPED ORDER BECAME BLOCKED. The idempotency claim,
--     checked against real data. Expected: 0.
--
--     These would be orders that are genuinely shipped AND carry an
--     unanswered request. The guard sits below the already_shipped
--     branch precisely so such a row keeps reporting 'already_shipped';
--     this query just confirms how many exist so the claim can be
--     verified rather than assumed.
--
--   select count(*) as shipped_with_open_request
--   from public.orders
--   where fulfillment_status in ('shipped', 'delivered')
--     and cancellation_requested_at is not null
--     and cancellation_request_resolution is null;
--
-- (K) MIGRATIONS 022 THROUGH 031 ARE UNTOUCHED. Their objects still
--     exist with their own privileges. Expected: all five functions
--     present, SECURITY DEFINER, empty search_path, anon_can false,
--     service_role_can true.
--
--   select p.proname,
--          p.prosecdef as security_definer,
--          p.proconfig,
--          has_function_privilege('anon',         p.oid, 'execute') as anon_can,
--          has_function_privilege('service_role', p.oid, 'execute') as service_role_can
--   from pg_proc p
--   join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public'
--     and p.proname in ('mark_order_shipped',                 -- 028, replaced here
--                       'cancel_order',                       -- 029
--                       'request_order_cancellation',         -- 019
--                       'apply_order_refund_state',           -- 019
--                       'resolve_order_cancellation_request') -- 031
--   order by p.proname;
--
--     And every column and constraint those migrations own is unchanged -
--     this migration adds no column and alters no constraint.
--
--   select column_name, data_type, is_nullable, column_default
--   from information_schema.columns
--   where table_schema = 'public' and table_name = 'orders'
--     and column_name in ('cancellation_requested_at',
--                         'cancellation_request_note',
--                         'cancellation_request_resolution',
--                         'cancellation_request_resolved_at',
--                         'cancelled_at', 'shipped_at',
--                         'shipping_carrier', 'tracking_number', 'tracking_url')
--   order by column_name;
--
--   select conname, pg_get_constraintdef(oid) as definition
--   from pg_constraint
--   where conrelid = 'public.orders'::regclass and contype = 'c'
--     and conname in ('orders_payment_status_check',
--                     'orders_refunded_total_cents_range_check',
--                     'orders_cancellation_resolution_paired_check',
--                     'orders_tracking_url_scheme_check')
--   order by conname;
--
-- (L) THE FIVE WRITERS ALL TAKE THE SAME ROW LOCK. The concurrency
--     claim, checked against the live function bodies. Expected: five
--     rows, all locks_row = true.
--
--   select p.proname, p.prosrc like '%for update%' as locks_row
--   from pg_proc p
--   join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public'
--     and p.proname in ('mark_order_shipped',
--                       'cancel_order',
--                       'request_order_cancellation',
--                       'apply_order_refund_state',
--                       'resolve_order_cancellation_request')
--   order by p.proname;

-- ══════════════════════════════════════════════════════════════
-- WHAT AN OPERATOR DOES WHEN A SHIPMENT IS BLOCKED
-- ══════════════════════════════════════════════════════════════
--
-- 'cancellation_request_open' is not a dead end and not an error. It
-- means a customer asked a question and it is still unanswered, so the
-- next action is to answer it:
--
--   POST /api/internal/orders/cancellation-request/resolve
--   Authorization: Bearer <CANCELLATION_ADMIN_SECRET>
--   { "orderNumber": "GLOA-2026-000123", "decision": "decline" }
--
-- Declining resolves the request, emails the customer that the order
-- stands, and leaves the order shippable through the ordinary path -
-- the guard above tests the resolution for NULL, so a declined request
-- clears it. Approving instead cancels the order, at which point the
-- cancelled guard refuses the shipment for the right reason.
--
-- Nothing here is automatic and nothing should be. A parcel that has not
-- yet gone is the one moment where a customer's request can still be
-- honoured cheaply, and the whole purpose of this guard is to make a
-- human look before that moment passes.
-- ══════════════════════════════════════════════════════════════
