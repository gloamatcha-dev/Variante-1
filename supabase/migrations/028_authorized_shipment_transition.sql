-- ============================================================
-- GLOA – Authorized shipment transition (Phase 2B)
-- Run in Supabase SQL Editor AFTER 027
--
-- The missing half of the shipment confirmation. Migration 027 added the
-- email delivery state and said plainly that nothing could send it,
-- because nothing in the application could move an order into 'shipped':
-- migration 019 built the tracking columns for the owner to fill in by
-- hand and deliberately withheld write access to them from service_role.
-- This migration creates the one narrow, authorized way to make that
-- transition from code.
--
-- 028 IS THE NEXT FREE NUMBER. 022-027 are live and immutable and are
-- not touched: 022 recurring subscription foundation, 023 stripe
-- customers grants, 024 subscription plan seed, 025 subscription plans
-- service_role grant, 026 internal order notification state, 027
-- shipment confirmation email state. Task 21 (tax/VAT/OSS) still holds no
-- migration file and remains free to take a later number - this
-- migration writes no tax field and leaves every *_net_cents and
-- tax_total_cents column exactly as it is.
--
-- ── WHY A FUNCTION AND NOT A GRANT ────────────────────────────
--
-- The obvious alternative was to grant service_role UPDATE on
-- fulfillment_status, shipped_at and the three tracking columns, and let
-- the route write them. That would have been a much larger blast radius
-- for the same feature: every line of server code holding the
-- service-role key could then ship, un-ship, or rewrite the tracking of
-- any order, and the only thing standing between a bug and a corrupted
-- fulfillment record would be that no one had written that bug yet.
--
-- SECURITY DEFINER keeps the grant at zero. service_role still cannot
-- write a single one of those columns directly. It can only ask this
-- function, and this function will only ever perform the one transition
-- below, with the lifecycle rules, the payment guard and the conflict
-- check applied inside the same transaction as the write. The same
-- reasoning migration 011 used for create_order_from_paid_checkout and
-- migration 019 used for request_order_cancellation and
-- apply_order_refund_state.
--
-- ── WHAT THE CALLER MAY AND MAY NOT DECIDE ────────────────────
--
-- May: which order, and the three optional tracking facts.
-- May not: anything else, and in particular
--
--   fulfillment_status  this function sets 'shipped'. Not a parameter.
--   shipped_at          this function sets now(). Not a parameter, so a
--                       caller can neither backdate a shipment nor move
--                       an existing one.
--   status, payment_status, any *_cents column, customer_snapshot,
--   shipping_address_snapshot, billing_address_snapshot, any tax field,
--   any email state column
--                       never written here at all. A shipment is a
--                       fulfillment fact; it is not a repricing event,
--                       not a payment event, and not a notification.
--
-- The customer confirmation is NOT sent from here. There is no trigger,
-- no NOTIFY and no http call in this migration: the email is the
-- application's job, strictly after this transaction has committed. A
-- database trigger that mailed customers would fire on every future
-- backfill and correction anyone ever ran by hand.
--
-- ── NO DATA IS TOUCHED BY APPLYING THIS ───────────────────────
--
-- This migration creates one function and sets its grants. It reads no
-- row, writes no row, deletes no row, adds no column, changes no
-- constraint, sends no email, and ships nothing. Applying it changes the
-- behaviour of exactly zero existing orders. See verification (H) and
-- (I).
-- ============================================================

-- 1. THE SHIPMENT TRANSITION ───────────────────────────────────
--
-- Keyed on order_number rather than the uuid, because the operational
-- identifier is what an operator actually has: it is what the internal
-- fulfillment email prints, and it is UNIQUE NOT NULL (migration 004), so
-- there is exactly one order behind one number and no ambiguity to
-- resolve. The durable uuid is RETURNED, so the caller can hand it to the
-- confirmation sender without ever having had to know it up front.
--
-- Returns jsonb rather than a bare status string - unlike
-- request_order_cancellation, the caller genuinely needs three facts
-- back: what happened, which order it happened to, and when it shipped.
-- Nothing in the returned object is a customer fact: no email, no name,
-- no address, no amount. The tracking values are not echoed either.
--
-- RESULT VOCABULARY (the route maps these to HTTP codes):
--   'not_found'         no order with that number
--   'not_shippable'     cancelled, or not in a payment state that ships
--   'already_advanced'  already 'delivered' - never moved backwards
--   'conflict'          already shipped, but with different tracking data
--   'already_shipped'   already shipped with IDENTICAL data - a true
--                       no-op, and shipped_at is not moved
--   'shipped'           applied now, for the first time
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
  -- make an idempotent repeat look like a conflict. The route normalizes
  -- first; this refuses to depend on it having done so.
  v_carrier := nullif(btrim(coalesce(p_carrier, '')), '');
  v_number  := nullif(btrim(coalesce(p_tracking_number, '')), '');
  v_url     := nullif(btrim(coalesce(p_tracking_url, '')), '');

  -- Technical ceilings, matching lib/shipmentTransitionRules.ts. Not a
  -- business rule - a bound, so no caller can push unbounded text into a
  -- column and into every email rendered from it.
  if char_length(coalesce(v_carrier, '')) > 100
     or char_length(coalesce(v_number, '')) > 100
     or char_length(coalesce(v_url, '')) > 500
  then
    return jsonb_build_object('result', 'not_shippable');
  end if;

  -- The same scheme rule as migration 019's CHECK constraint and as
  -- sanitizeTrackingUrl. Checked before the write so a bad URL is an
  -- ordinary refusal rather than a constraint violation surfacing as a
  -- 500. A carrier is never inferred from the number, and a URL is never
  -- built from a carrier: if the operator has no real link, the column
  -- stays NULL and the customer sees the bare number.
  if v_url is not null and v_url !~* '^https?://[^[:space:]]+$' then
    return jsonb_build_object('result', 'not_shippable');
  end if;

  -- FOR UPDATE is what makes two concurrent authorized requests safe:
  -- the second waits here, and by the time it reads the row the first
  -- has already committed its transition, so it sees 'shipped' and takes
  -- the idempotent or conflict path rather than writing a second time.
  select * into v_order
  from public.orders
  where order_number = btrim(upper(p_order_number))
  for update;

  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  -- ── ALREADY ADVANCED ────────────────────────────────────────
  -- 'delivered' is strictly later than 'shipped'. Moving an order
  -- backwards would destroy a real delivery confirmation to record
  -- something that already happened.
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
  -- persisted, and a conflict when it is not. IS NOT DISTINCT FROM
  -- rather than '=' so that NULL = NULL compares equal: three NULLs
  -- supplied against three NULLs stored is the commonest identical
  -- repeat there is, and '=' would have made it a conflict.
  --
  -- shipped_at is deliberately NOT touched on this path. The order
  -- shipped when it shipped, and a repeated call - which is exactly what
  -- a manual email retry is - must not rewrite that timestamp.
  --
  -- Conflicting data is refused rather than merged. Editing shipment data
  -- is genuinely a different operation with different consequences (a
  -- customer may already hold an email quoting the old number), and this
  -- task does not implement it.
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
  -- A cancelled order is never newly shipped, from either column. Both
  -- are checked because they are separately settable and either one
  -- saying 'cancelled' is a reason to stop.
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
  -- Derived from the vocabulary migration 019 settled on
  -- ('pending','paid','failed','refund_pending','partially_refunded',
  -- 'refunded'), not invented here.
  --
  -- 'paid' is the ordinary case: create_order_from_paid_checkout
  -- (migration 011) writes exactly that, so every order this shop has
  -- ever created starts there.
  --
  -- 'partially_refunded' IS allowed. A partial refund is routinely a
  -- goodwill correction on an order that still ships, and migration 019
  -- is explicit that a refund is a payment fact which does not decide
  -- whether an order is operationally finished - it "never writes status,
  -- fulfillment_status, or any money column". Blocking it would invent a
  -- rule the repository does not have.
  --
  -- 'refunded' is refused: the customer has their money back in full, and
  -- shipping would give the goods away.
  --
  -- 'refund_pending' is refused, and this is a deliberate fail-closed
  -- choice rather than a judgement that such orders never ship. A refund
  -- is in flight and its outcome is unknown; waiting is free and
  -- self-healing, because apply_order_refund_state writes 'paid' back if
  -- the refund is cancelled or fails, at which point the order ships
  -- normally. Shipping first is not reversible.
  --
  -- 'pending' and 'failed' were never paid.
  if v_order.payment_status not in ('paid', 'partially_refunded') then
    return jsonb_build_object(
      'result', 'not_shippable',
      'order_id', v_order.id,
      'order_number', v_order.order_number
    );
  end if;

  -- ── LIFECYCLE GUARD ─────────────────────────────────────────
  -- The only two fulfillment states a first shipment may come from.
  -- 'unfulfilled' is what migration 004 defaults every new order to and
  -- is therefore the real-world case; 'processing' is in that same
  -- vocabulary and is a legitimate place to ship from if the owner has
  -- set it. 'shipped', 'delivered' and 'cancelled' are all handled above.
  if v_order.fulfillment_status not in ('unfulfilled', 'processing') then
    return jsonb_build_object(
      'result', 'not_shippable',
      'order_id', v_order.id,
      'order_number', v_order.order_number
    );
  end if;

  -- ── THE TRANSITION ──────────────────────────────────────────
  -- Six columns, and not one of them is money, tax, a snapshot, a payment
  -- state or an email state. shipped_at is now() - server time, never a
  -- caller's value.
  --
  -- status is moved to 'shipped' alongside fulfillment_status because
  -- migration 004 gives both columns a 'shipped' value and the customer
  -- UI (lib/orderStatus.ts) reads either; leaving status at 'confirmed'
  -- would make the two disagree about the same order.
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
-- No browser role may ever call this. revoke from public first, because
-- a freshly created function is executable by PUBLIC by default and
-- anon/authenticated inherit that - revoking only the named roles would
-- leave the default in place and the function reachable from the
-- browser's own Supabase client.
--
-- service_role is the only grantee, and it holds the key that never
-- leaves the server (lib/supabaseAdmin.ts). Reaching this function
-- therefore requires the service-role key AND the separate
-- FULFILLMENT_ADMIN_SECRET the route checks first: two independent
-- secrets, neither of which is in a client bundle.
revoke all on function public.mark_order_shipped(text, text, text, text) from public;
revoke all on function public.mark_order_shipped(text, text, text, text) from anon;
revoke all on function public.mark_order_shipped(text, text, text, text) from authenticated;
grant execute on function public.mark_order_shipped(text, text, text, text) to service_role;

-- VERIFY ───────────────────────────────────────────────────────
--
-- Read-only. Run after applying. No statement below writes a row.
--
-- (A) THE FUNCTION EXISTS, with the expected four text arguments and a
--     jsonb return type. Expected: exactly one row.
--
--   select p.proname,
--          pg_get_function_identity_arguments(p.oid) as arguments,
--          pg_get_function_result(p.oid)             as returns
--   from pg_proc p
--   join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public' and p.proname = 'mark_order_shipped';
--
--   Expected arguments: text, text, text, text
--   Expected returns:   jsonb
--
-- (B) SECURITY DEFINER IS TRUE. Expected: security_definer = true.
--     If this is false the function runs as the caller, service_role has
--     no write access to the shipment columns, and every call fails.
--
--   select p.proname, p.prosecdef as security_definer
--   from pg_proc p
--   join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public' and p.proname = 'mark_order_shipped';
--
-- (C) SAFE search_path. Expected: proconfig contains exactly
--     {"search_path="} - an EMPTY search path. A SECURITY DEFINER
--     function without this can be hijacked by a caller who creates a
--     same-named table or function in a schema that resolves first.
--
--   select p.proname, p.proconfig
--   from pg_proc p
--   join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public' and p.proname = 'mark_order_shipped';
--
-- (D)(E)(F)(G) WHO MAY EXECUTE IT. The important block.
--     Expected: false, false, false, true - in that order.
--
--   select
--     has_function_privilege('public',        'public.mark_order_shipped(text,text,text,text)', 'execute') as public_can,
--     has_function_privilege('anon',          'public.mark_order_shipped(text,text,text,text)', 'execute') as anon_can,
--     has_function_privilege('authenticated', 'public.mark_order_shipped(text,text,text,text)', 'execute') as authenticated_can,
--     has_function_privilege('service_role',  'public.mark_order_shipped(text,text,text,text)', 'execute') as service_role_can;
--
--     And the raw ACL, which should name service_role and nothing else:
--
--   select p.proname, p.proacl
--   from pg_proc p
--   join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public' and p.proname = 'mark_order_shipped';
--
-- (H) THE SHIPMENT BUSINESS COLUMNS WERE NOT MODIFIED. This migration
--     adds no column and changes no constraint. Expected: the four
--     migration 019 columns still present and nullable, and 027's two
--     email columns still nullable with no default.
--
--   select column_name, data_type, is_nullable, column_default
--   from information_schema.columns
--   where table_schema = 'public' and table_name = 'orders'
--     and column_name in ('fulfillment_status', 'shipped_at',
--                         'shipping_carrier', 'tracking_number',
--                         'tracking_url', 'shipment_email_status',
--                         'shipment_email_sent_at')
--   order by column_name;
--
--     Expected: fulfillment_status NOT NULL default 'unfulfilled'; the
--     other six nullable with no default.
--
--     And migration 019's constraints are untouched:
--
--   select conname, pg_get_constraintdef(oid) as definition
--   from pg_constraint
--   where conrelid = 'public.orders'::regclass
--     and contype = 'c'
--     and conname in ('orders_tracking_url_scheme_check',
--                     'orders_tracking_number_not_blank_check',
--                     'orders_shipping_carrier_not_blank_check')
--   order by conname;
--
-- (I) NO EXISTING ORDER WAS CHANGED. THE IMPORTANT ONE. Applying this
--     migration ships nothing and queues no email.
--
--     Expected: newly_shipped and with_email_state both 0, and
--     shipped_orders exactly whatever it was before you applied this.
--     If shipped_orders is non-zero those are shipments the owner made by
--     hand before this existed - correct, and still invisible to any
--     email flow because their shipment_email_status is NULL.
--
--   select count(*)                                                   as orders,
--          count(*) filter (where fulfillment_status = 'shipped')      as shipped_orders,
--          count(*) filter (where shipped_at > now() - interval '1 hour') as newly_shipped,
--          count(shipment_email_status)                                as with_email_state
--   from public.orders;
--
-- (J) NOTHING ELSE MOVED. No trigger was added to orders by this
--     migration, and in particular nothing that could mail a customer.
--     Expected: only the set_orders_updated_at trigger from migration
--     004.
--
--   select tgname, pg_get_triggerdef(oid) as definition
--   from pg_trigger
--   where tgrelid = 'public.orders'::regclass and not tgisinternal
--   order by tgname;
--
--     And table grants are unchanged - service_role still holds SELECT
--     plus column-scoped UPDATE on the six email-state columns only, and
--     still has NO write access to fulfillment_status, shipped_at or the
--     tracking columns. That is the point of the function.
--
--   select grantee, column_name, privilege_type
--   from information_schema.column_privileges
--   where table_schema = 'public' and table_name = 'orders'
--     and privilege_type = 'UPDATE'
--     and grantee in ('anon', 'authenticated', 'service_role')
--   order by grantee, column_name;
