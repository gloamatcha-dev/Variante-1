-- ============================================================
-- GLOA – Cancellation request resolution + customer outcome email
-- state (Phase 2D-B)
-- Run in Supabase SQL Editor AFTER 030
--
-- The gap this closes. Since Phase 2A a customer can ask to stop an
-- order (migration 019 writes cancellation_requested_at and a note).
-- Since Phase 2C an operator can cancel an order (migration 029's
-- cancel_order). Since Phase 2D-A the fulfillment inbox is told a request
-- exists (migration 030). What has never existed is a durable ANSWER:
-- nothing in the schema can say whether a request was approved or
-- declined.
--
-- The concrete damage that causes is visible in the customer's account
-- today. lib/orderStatus.ts renders "Wir prüfen, ob die Bestellung noch
-- gestoppt werden kann." for any paid order with a
-- cancellation_requested_at, and because nothing can ever resolve that
-- request, a customer whose request was declined sees "wir prüfen"
-- FOREVER. This migration gives the request a terminal answer.
--
-- 031 IS THE NEXT FREE NUMBER. 022-030 are live and immutable and are
-- not touched: 022 recurring subscription foundation, 023 stripe
-- customers grants, 024 subscription plan seed, 025 subscription plans
-- service_role grant, 026 internal order notification state, 027
-- shipment confirmation email state, 028 authorized shipment transition,
-- 029 authorized order cancellation, 030 cancellation request
-- notification state. Task 21 (tax/VAT/OSS) still holds no migration file
-- and remains free to take a later number - this migration writes no tax
-- field and leaves every *_net_cents and tax_total_cents column exactly
-- as it is.
--
-- ── THE CENTRAL DESIGN DECISION: 029 IS REUSED, NOT REWRITTEN ──
--
-- Approving a cancellation request means the order must actually be
-- cancelled, and there is already exactly one correct way to cancel an
-- order in this system: public.cancel_order (migration 029). It holds
-- the shipped/delivered guard, the already-cancelled idempotency, the
-- lifecycle guard, the row lock and the three-column write.
--
-- resolve_order_cancellation_request CALLS IT. It does not reimplement
-- it, does not copy its guards, and does not touch status,
-- fulfillment_status or cancelled_at itself. Those three columns are
-- written in exactly one place in this entire schema, and that place is
-- still 029.
--
-- THIS IS SAFE AND ATOMIC, and the reasons are worth stating because
-- they are what the whole approach rests on:
--
--   * SAME TRANSACTION. A plpgsql function called from another plpgsql
--     function runs inside the caller's transaction. There is no commit
--     between the resolution write and the cancellation write, so an
--     order can never end up approved-but-not-cancelled or
--     cancelled-but-not-approved.
--   * THE ROW LOCK COMPOSES. This function takes FOR UPDATE on the order
--     first; cancel_order then takes FOR UPDATE on the same row in the
--     same transaction, which is a no-op on a lock already held. No
--     deadlock, no second wait.
--   * THE EXECUTE GRANT IS NOT AN OBSTACLE. cancel_order is revoked from
--     public/anon/authenticated and granted to service_role, but a
--     SECURITY DEFINER function runs as its OWNER, and the owner of both
--     functions is the same role. Revoking from PUBLIC never revokes
--     from the owner.
--   * 029 STAYS UNEDITED. Its guards cannot be weakened from here,
--     because they are not restated here. If cancel_order refuses -
--     shipped, delivered, or a lifecycle state it does not accept - this
--     function refuses too, and the request stays UNRESOLVED rather than
--     being marked approved on a cancellation that never happened.
--
-- ── APPROVAL IS NOT A REFUND ──────────────────────────────────
--
-- Nothing here creates, requests or records a refund. This function
-- never writes payment_status, refunded_total_cents or
-- refund_updated_at, exactly as 029 does not. Refunds are still
-- initiated by hand in the Stripe Dashboard and reconciled by migration
-- 019's apply_order_refund_state from an absolute re-read of the payment
-- intent. An approved cancellation on a paid order is a real, expected,
-- temporary state: fulfillment has stopped, the money has not moved back
-- yet. The customer email says exactly that and no more.
--
-- ── NOTHING IS SENT FROM HERE ─────────────────────────────────
--
-- No trigger, no NOTIFY, no http call. The customer outcome email is the
-- application's job, strictly after this transaction has committed. A
-- database trigger that mailed customers would fire on every future
-- backfill and correction anyone ever ran by hand.
--
-- ── APPLYING THIS CHANGES NOTHING ─────────────────────────────
--
-- Four nullable columns with no default and no backfill, two CHECK
-- constraints, one function, one column-scoped grant. It reads no row
-- for a decision, writes no row, deletes no row, cancels nothing, resolves
-- nothing and mails nobody. See verification (K) and (L).
-- ============================================================

-- 1. RESOLUTION STATE ──────────────────────────────────────────
--
-- NULL means the request is still OPEN. That is the load-bearing
-- meaning, and it is what the next phase's shipment guard will key on:
--
--   an open request  =  cancellation_requested_at IS NOT NULL
--                       AND cancellation_request_resolution IS NULL
--
-- Nullable with no default and no backfill, so every order that predates
-- this migration reads NULL. For an order with no request that is
-- meaningless and harmless; for an order WITH an unanswered request it is
-- the truth - nobody has answered it yet.
--
-- Only two values are permitted, and they are terminal. There is no
-- 'pending' and no 'reviewing': "under review" is already expressed by
-- NULL alongside a non-NULL cancellation_requested_at, and a second way
-- to say the same thing is a second thing that can disagree.
alter table public.orders
  add column if not exists cancellation_request_resolution text
    check (cancellation_request_resolution in ('approved', 'declined')),
  add column if not exists cancellation_request_resolved_at timestamptz;

-- The two columns are written together or not at all. The function below
-- is the only writer and always sets both, so this constraint documents
-- an invariant rather than guarding against a caller - but it also means
-- no future backfill can create a resolution with no date, or a date
-- with no resolution, either of which would be a half-answered request.
--
-- Every pre-existing row has both NULL and therefore satisfies it.
alter table public.orders
  drop constraint if exists orders_cancellation_resolution_paired_check;

alter table public.orders
  add constraint orders_cancellation_resolution_paired_check
    check ((cancellation_request_resolution is null) = (cancellation_request_resolved_at is null));

-- 2. CUSTOMER OUTCOME EMAIL STATE ──────────────────────────────
--
-- The fifth message in the family and the fifth pair of columns, for the
-- same reason the previous four have their own: a different fate. This
-- one is a CUSTOMER email about a terminal decision, and it can fail
-- while the internal request notification (030) has long since
-- succeeded.
--
-- Three values only: 'sending', 'sent', 'failed'. NULL means "never part
-- of this flow", and no 'pending' exists, for exactly the reason
-- migration 030 sets out at length: production holds orders that predate
-- this feature, and a sweep keying on NULL would mail all of them at
-- once. Any future sweep must key on 'failed' and nothing else.
alter table public.orders
  add column if not exists cancellation_outcome_email_status text
    check (cancellation_outcome_email_status in ('sending', 'sent', 'failed')),
  add column if not exists cancellation_outcome_email_sent_at timestamptz;

-- 3. THE AUTHORIZED RESOLUTION ─────────────────────────────────
--
-- Keyed on order_number, matching 028 and 029: the operational
-- identifier is what an operator actually has, and it is UNIQUE NOT NULL
-- (migration 004), so there is exactly one order behind one number.
--
-- TWO PARAMETERS, and the second is a tightly closed vocabulary. The
-- caller says WHICH order and WHETHER the answer is yes or no. It cannot
-- say what "yes" means: that is cancel_order's job, and it cannot supply
-- a status, a timestamp, a lifecycle value or an amount, because there is
-- no parameter for one.
--
-- WHAT THIS FUNCTION WRITES ITSELF: exactly two columns,
-- cancellation_request_resolution and cancellation_request_resolved_at.
-- Nothing else. status, fulfillment_status and cancelled_at are written
-- only by cancel_order, which it calls; payment_status,
-- refunded_total_cents, refund_updated_at, every money and tax column,
-- every snapshot, every tracking column and every email-state column are
-- never written here at all. In particular
-- cancellation_requested_at and cancellation_request_note are NEVER
-- touched: they are what the customer asked and when, they remain true
-- after the answer is given, and destroying them would destroy the only
-- record of why this happened.
--
-- RESULT VOCABULARY (the route maps these to HTTP codes):
--   'invalid_decision'        p_decision was not 'approve' or 'decline'
--   'not_found'               no order with that number
--   'no_request'              the order exists but nobody asked to stop
--                             it. Neutral: this is not a way to probe
--                             which orders exist, because the caller is
--                             already an authorized operator
--   'approved'                approved now, and the order is cancelled
--   'declined'                declined now, lifecycle untouched
--   'already_approved'        idempotent repeat. resolved_at NOT moved
--   'already_declined'        idempotent repeat. resolved_at NOT moved
--   'conflict'                a DIFFERENT terminal decision already
--                             stands. Never overwritten
--   'not_cancellable'         approve was asked for, but cancel_order
--                             refused (shipped/delivered). THE REQUEST
--                             STAYS UNRESOLVED
--   'order_already_cancelled' decline was asked for, but the order is
--                             already cancelled. Refused rather than
--                             recording an answer that contradicts the
--                             order's own state
create or replace function public.resolve_order_cancellation_request(
  p_order_number text,
  p_decision     text
)
returns jsonb
language plpgsql
volatile
security definer set search_path = ''
as $$
declare
  v_order      public.orders;
  v_decision   text;
  v_cancel     jsonb;
  v_cancel_res text;
  v_now        timestamptz;
begin
  -- ── DECISION VOCABULARY ─────────────────────────────────────
  -- Closed set, normalized, checked before anything is read. The route
  -- validates this too; refusing here as well means the database is
  -- never the reason an unrecognised decision became a write.
  v_decision := case lower(btrim(coalesce(p_decision, '')))
                  when 'approve' then 'approved'
                  when 'decline' then 'declined'
                  else null
                end;

  if v_decision is null then
    return jsonb_build_object('result', 'invalid_decision');
  end if;

  if p_order_number is null or btrim(p_order_number) = '' then
    return jsonb_build_object('result', 'not_found');
  end if;

  -- FOR UPDATE first, so the whole resolution is serialized against a
  -- concurrent resolution, a concurrent cancel_order call, and a
  -- concurrent customer request. Normalized with btrim(upper(...))
  -- exactly as 028 and 029 do, so the three lookups cannot drift.
  select * into v_order
  from public.orders
  where order_number = btrim(upper(p_order_number))
  for update;

  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  -- ── A REQUEST MUST EXIST ────────────────────────────────────
  -- This function ANSWERS a customer's question. Where no question was
  -- asked there is nothing to answer, and inventing a resolution would
  -- later cause an outcome email to a customer who never wrote in.
  --
  -- An operator who simply wants to cancel an order nobody asked about
  -- uses POST /api/internal/orders/cancel (Phase 2C) instead. The two
  -- endpoints are deliberately different things.
  if v_order.cancellation_requested_at is null then
    return jsonb_build_object(
      'result', 'no_request',
      'order_id', v_order.id,
      'order_number', v_order.order_number
    );
  end if;

  -- ── TERMINAL MEANS TERMINAL ─────────────────────────────────
  -- A decision, once given, is the decision. The customer has already
  -- been emailed about it.
  --
  -- The same decision repeated is an idempotent no-op and performs ZERO
  -- writes: resolved_at is NOT moved, which would misrepresent when the
  -- answer was actually given. That is what makes a repeated authorized
  -- call the safe retry path for a failed outcome email.
  --
  -- A DIFFERENT decision is refused outright. approved -> declined and
  -- declined -> approved are both impossible, in both directions, and no
  -- parameter exists to force either.
  if v_order.cancellation_request_resolution is not null then
    if v_order.cancellation_request_resolution = v_decision then
      return jsonb_build_object(
        'result', 'already_' || v_decision,
        'order_id', v_order.id,
        'order_number', v_order.order_number,
        'resolution', v_order.cancellation_request_resolution,
        'resolved_at', v_order.cancellation_request_resolved_at
      );
    end if;

    return jsonb_build_object(
      'result', 'conflict',
      'order_id', v_order.id,
      'order_number', v_order.order_number,
      'resolution', v_order.cancellation_request_resolution,
      'resolved_at', v_order.cancellation_request_resolved_at
    );
  end if;

  v_now := now();

  -- ── DECLINE ─────────────────────────────────────────────────
  -- Writes two columns and nothing else. status, fulfillment_status,
  -- cancelled_at, payment_status and every refund column are untouched
  -- by construction: they do not appear in the UPDATE below.
  if v_decision = 'declined' then
    -- A decline on an order that is already cancelled would record an
    -- answer contradicting the order's own state, and would then email
    -- the customer "we could not stop it" about an order that is
    -- visibly stopped. Refused.
    if v_order.status = 'cancelled' or v_order.fulfillment_status = 'cancelled' then
      return jsonb_build_object(
        'result', 'order_already_cancelled',
        'order_id', v_order.id,
        'order_number', v_order.order_number
      );
    end if;

    update public.orders
       set cancellation_request_resolution  = 'declined',
           cancellation_request_resolved_at = v_now
     where id = v_order.id;

    return jsonb_build_object(
      'result', 'declined',
      'order_id', v_order.id,
      'order_number', v_order.order_number,
      'resolution', 'declined',
      'resolved_at', v_now
    );
  end if;

  -- ── APPROVE ─────────────────────────────────────────────────
  -- Delegated to migration 029, in this transaction, on this locked row.
  -- Every lifecycle rule that decides whether an order may be cancelled
  -- lives there and only there.
  v_cancel     := public.cancel_order(v_order.order_number);
  v_cancel_res := v_cancel ->> 'result';

  -- 'cancelled'          applied now
  -- 'already_cancelled'  coherent: the order is already in the state the
  --                      approval asks for, so the answer is still yes
  --
  -- Anything else - 'not_cancellable' for a shipped or delivered order,
  -- or the unreachable 'not_found' - means the approval CANNOT be
  -- honoured. The request is deliberately LEFT UNRESOLVED: recording
  -- 'approved' for a cancellation that did not happen would be a lie
  -- that then gets emailed to the customer. The operator must decline it
  -- instead, or ship it.
  if v_cancel_res is null or v_cancel_res not in ('cancelled', 'already_cancelled') then
    return jsonb_build_object(
      'result', 'not_cancellable',
      'order_id', v_order.id,
      'order_number', v_order.order_number,
      'cancel_result', v_cancel_res
    );
  end if;

  update public.orders
     set cancellation_request_resolution  = 'approved',
         cancellation_request_resolved_at = v_now
   where id = v_order.id;

  return jsonb_build_object(
    'result', 'approved',
    'order_id', v_order.id,
    'order_number', v_order.order_number,
    'resolution', 'approved',
    'resolved_at', v_now,
    'cancel_result', v_cancel_res
  );
end;
$$;

-- 4. EXECUTE PRIVILEGES ────────────────────────────────────────
--
-- No browser role may ever call this. revoke from public FIRST, because
-- a freshly created function is executable by PUBLIC by default and
-- anon/authenticated inherit that - revoking only the named roles would
-- leave the default in place and the function reachable from the
-- browser's own Supabase client with nothing but an anon key.
--
-- service_role is the only grantee, and it holds the key that never
-- leaves the server (lib/supabaseAdmin.ts). Reaching this function
-- therefore requires the service-role key AND the CANCELLATION_ADMIN_SECRET
-- the route checks first: two independent secrets, neither in a client
-- bundle. The secret is the SAME one Phase 2C's cancel endpoint uses,
-- deliberately - both are "an operator decides the fate of an order",
-- one blast radius, one credential. No new secret is introduced.
revoke all on function public.resolve_order_cancellation_request(text, text) from public;
revoke all on function public.resolve_order_cancellation_request(text, text) from anon;
revoke all on function public.resolve_order_cancellation_request(text, text) from authenticated;
grant execute on function public.resolve_order_cancellation_request(text, text) to service_role;

-- 5. GRANTS: ONLY THE EMAIL STATE ──────────────────────────────
--
-- The two RESOLUTION columns receive NO grant. They are written only
-- from inside the SECURITY DEFINER function above, which is the same
-- reasoning 028 and 029 apply to the lifecycle columns: if the only
-- legitimate writer is a function that enforces the rules, then no
-- direct write privilege should exist for anything to bypass them with.
--
-- The two EMAIL STATE columns do receive a column-scoped grant, because
-- their state machine genuinely runs in application code
-- (lib/cancellationOutcomeEmail.ts) after the transaction has committed
-- - the same shape as 017, 026, 027 and 030.
--
-- After this migration service_role holds column-scoped UPDATE on
-- exactly ten columns, all of them email state:
--
--   confirmation_email_status, confirmation_email_sent_at                (017)
--   internal_notification_status, internal_notification_sent_at          (026)
--   shipment_email_status, shipment_email_sent_at                        (027)
--   cancellation_request_notification_status, ..._sent_at                (030)
--   cancellation_outcome_email_status, cancellation_outcome_email_sent_at (031)
--
-- and no write access whatsoever to status, fulfillment_status,
-- cancelled_at, cancellation_request_resolution,
-- cancellation_request_resolved_at, cancellation_requested_at,
-- cancellation_request_note, payment_status, refunded_total_cents,
-- refund_updated_at, any money or tax column, any snapshot, or any
-- tracking column.
grant update (cancellation_outcome_email_status, cancellation_outcome_email_sent_at)
  on public.orders to service_role;

-- 6. NO NEW CLIENT PRIVILEGES ──────────────────────────────────
--
-- No grant, policy or privilege is created for anon or authenticated. A
-- customer keeps the SELECT-only access migration 004 gave them under
-- the "Users read own orders" RLS policy, which now also covers these
-- four columns.
--
-- Reading the RESOLUTION is correct and intended: the account page needs
-- it to stop saying "Wir prüfen" forever after a decline. Reading the
-- EMAIL STATE is harmless but pointless, and the UI deliberately does not
-- - whether a mail provider accepted a message is an operational fact,
-- not an order status, and showing it would invite reading "sent" as
-- "handled".

-- VERIFY ───────────────────────────────────────────────────────
--
-- Read-only. Run after applying. No statement below writes a row,
-- resolves a request, cancels an order, creates a refund or sends mail.
--
-- (A)(B)(C) ALL FOUR COLUMNS EXIST, ARE NULLABLE, AND HAVE NO DEFAULT.
--     Expected: exactly four rows, every is_nullable = YES and every
--     column_default = NULL.
--
--     A non-NULL default on the resolution would mark every order in the
--     shop as answered; a non-NULL default on the email status would make
--     every historical order look like queued work.
--
--   select column_name, data_type, is_nullable, column_default
--   from information_schema.columns
--   where table_schema = 'public' and table_name = 'orders'
--     and column_name in ('cancellation_request_resolution',
--                         'cancellation_request_resolved_at',
--                         'cancellation_outcome_email_status',
--                         'cancellation_outcome_email_sent_at')
--   order by column_name;
--
--     Expected: 4 rows. ..._resolution and ..._email_status are text;
--     ..._resolved_at and ..._email_sent_at are timestamp with time zone.
--
-- (D) THE RESOLUTION CONSTRAINT ALLOWS EXACTLY TWO VALUES.
--     Expected: a definition naming 'approved' and 'declined' and
--     nothing else. In particular NOT 'pending' and NOT 'open' - an open
--     request is expressed by NULL.
--
--   select conname, pg_get_constraintdef(oid) as definition
--   from pg_constraint
--   where conrelid = 'public.orders'::regclass and contype = 'c'
--     and pg_get_constraintdef(oid) like '%cancellation_request_resolution%'
--   order by conname;
--
--     Expected TWO rows here: the value CHECK, and
--     orders_cancellation_resolution_paired_check, which enforces that
--     the resolution and its timestamp are both set or both NULL.
--
-- (E) THE EMAIL STATUS CONSTRAINT ALLOWS EXACTLY THREE VALUES.
--     Expected: 'sending', 'sent', 'failed'. No 'pending'.
--
--   select conname, pg_get_constraintdef(oid) as definition
--   from pg_constraint
--   where conrelid = 'public.orders'::regclass and contype = 'c'
--     and pg_get_constraintdef(oid) like '%cancellation_outcome_email_status%';
--
-- (F) THE FUNCTION EXISTS, with exactly TWO text arguments and a jsonb
--     return type. Two is the number that matters: a third parameter
--     would mean a caller can influence something beyond which order and
--     which answer.
--
--   select p.proname,
--          pg_get_function_identity_arguments(p.oid) as arguments,
--          pg_get_function_result(p.oid)             as returns
--   from pg_proc p
--   join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public' and p.proname = 'resolve_order_cancellation_request';
--
--   Expected arguments: text, text
--   Expected returns:   jsonb
--
-- (G) SECURITY DEFINER IS TRUE, AND THE search_path IS EMPTY.
--     If prosecdef is false the function runs as the caller, cannot
--     execute cancel_order, cannot write the resolution columns, and
--     every call fails. If proconfig is not {"search_path="} the function
--     can be hijacked by a caller who creates a same-named object in a
--     schema that resolves first.
--
--   select p.proname, p.prosecdef as security_definer, p.proconfig
--   from pg_proc p
--   join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public'
--     and p.proname in ('resolve_order_cancellation_request', 'cancel_order')
--   order by p.proname;
--
--     Expected: BOTH rows security_definer = true, proconfig = {"search_path="}.
--
-- (H) BOTH FUNCTIONS HAVE THE SAME OWNER. This is what makes the
--     delegation in (I) work: a SECURITY DEFINER function runs as its
--     owner, and revoking EXECUTE from PUBLIC never revokes it from the
--     owner. Expected: two rows, identical owner.
--
--   select p.proname, pg_get_userbyid(p.proowner) as owner
--   from pg_proc p
--   join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public'
--     and p.proname in ('resolve_order_cancellation_request', 'cancel_order')
--   order by p.proname;
--
-- (I) WHO MAY EXECUTE IT. The important block.
--     Expected: false, false, false, true - in that order.
--
--   select
--     has_function_privilege('public',        'public.resolve_order_cancellation_request(text,text)', 'execute') as public_can,
--     has_function_privilege('anon',          'public.resolve_order_cancellation_request(text,text)', 'execute') as anon_can,
--     has_function_privilege('authenticated', 'public.resolve_order_cancellation_request(text,text)', 'execute') as authenticated_can,
--     has_function_privilege('service_role',  'public.resolve_order_cancellation_request(text,text)', 'execute') as service_role_can;
--
--     And the raw ACL, which should name service_role and nothing else:
--
--   select p.proname, p.proacl
--   from pg_proc p
--   join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public'
--     and p.proname in ('resolve_order_cancellation_request', 'cancel_order')
--   order by p.proname;
--
-- (J) WHO MAY UPDATE WHAT. The other important block.
--
--     Expected: service_role holds column-scoped UPDATE on EXACTLY these
--     ten columns and no others -
--
--       confirmation_email_status, confirmation_email_sent_at            (017)
--       internal_notification_status, internal_notification_sent_at      (026)
--       shipment_email_status, shipment_email_sent_at                    (027)
--       cancellation_request_notification_status, ..._sent_at            (030)
--       cancellation_outcome_email_status, ..._email_sent_at             (031)
--
--     THESE MUST NOT APPEAR: 'status', 'fulfillment_status',
--     'cancelled_at', 'cancellation_request_resolution',
--     'cancellation_request_resolved_at', 'cancellation_requested_at',
--     'cancellation_request_note', 'payment_status',
--     'refunded_total_cents', 'refund_updated_at', and every *_cents,
--     tax, snapshot and tracking column.
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
--     Expected: service_role SELECT only, authenticated SELECT only,
--     anon absent entirely.
--
-- (K) NO EXISTING ORDER WAS MODIFIED, AND NOTHING WAS BACKFILLED.
--     THE IMPORTANT ONE. Applying this resolves nothing, cancels nothing
--     and queues no mail.
--
--     Expected: resolved = 0, resolved_dated = 0, outcome_status = 0,
--     outcome_dated = 0. cancelled_orders and open_requests are expected
--     to be exactly whatever they already were.
--
--     open_requests_unresolved is the number this feature exists to
--     drain - requests with no answer. After applying, it equals
--     open_requests, because nothing has been answered yet.
--
--   select count(*)                                                  as orders,
--          count(*) filter (where status = 'cancelled')               as cancelled_orders,
--          count(cancellation_requested_at)                           as open_requests,
--          count(*) filter (where cancellation_requested_at is not null
--                             and cancellation_request_resolution is null)
--                                                                     as open_requests_unresolved,
--          count(cancellation_request_resolution)                     as resolved,
--          count(cancellation_request_resolved_at)                    as resolved_dated,
--          count(cancellation_outcome_email_status)                   as outcome_status,
--          count(cancellation_outcome_email_sent_at)                  as outcome_dated
--   from public.orders;
--
-- (L) THE PAIRED INVARIANT HOLDS FOR EVERY EXISTING ROW.
--     Expected: 0. A non-zero result means a row has a resolution
--     without a date or a date without a resolution, which the CHECK
--     should have made impossible.
--
--   select count(*) as broken_pairs
--   from public.orders
--   where (cancellation_request_resolution is null)
--      <> (cancellation_request_resolved_at is null);
--
-- (M) NOTHING IS SWEEP ELIGIBLE. There is no retry cron in this phase,
--     and if one is ever built it may key on 'failed' and nothing else.
--     Expected: 0.
--
--   select count(*) as sweep_eligible
--   from public.orders
--   where cancellation_outcome_email_status = 'failed';
--
-- (N) NO TRIGGER ADDED. Nothing was attached to public.orders by this
--     migration, and in particular nothing that could mail a customer or
--     resolve a request automatically. Expected: only the
--     set_orders_updated_at trigger from migration 004.
--
--   select tgname, pg_get_triggerdef(oid) as definition
--   from pg_trigger
--   where tgrelid = 'public.orders'::regclass and not tgisinternal
--   order by tgname;
--
-- (O) MIGRATIONS 022 THROUGH 030 ARE UNTOUCHED. Their objects still
--     exist with their own privileges. Expected: all five functions
--     present, all SECURITY DEFINER with an empty search_path,
--     anon_can false and service_role_can true for every one.
--
--   select p.proname,
--          p.prosecdef as security_definer,
--          p.proconfig,
--          has_function_privilege('anon',         p.oid, 'execute') as anon_can,
--          has_function_privilege('service_role', p.oid, 'execute') as service_role_can
--   from pg_proc p
--   join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public'
--     and p.proname in ('cancel_order',                        -- 029
--                       'mark_order_shipped',                  -- 028
--                       'request_order_cancellation',          -- 019
--                       'apply_order_refund_state',            -- 019
--                       'resolve_order_cancellation_request')  -- 031, this one
--   order by p.proname;
--
--     And 019's refund model plus every email vocabulary are exactly as
--     they were. Nothing in this migration touches any of them.
--
--   select conname, pg_get_constraintdef(oid) as definition
--   from pg_constraint
--   where conrelid = 'public.orders'::regclass and contype = 'c'
--     and conname in ('orders_payment_status_check',
--                     'orders_refunded_total_cents_range_check',
--                     'orders_cancellation_request_note_length_check')
--   order by conname;
--
--     Expected: orders_payment_status_check still allows
--     'pending','paid','failed','refund_pending','partially_refunded',
--     'refunded'.
--
-- (P) A SPOT CHECK OF THE DELEGATION, READ-ONLY. This confirms the
--     function body genuinely calls cancel_order rather than
--     reimplementing it. Expected: the source contains
--     'public.cancel_order(' exactly once, and contains NO assignment to
--     status, fulfillment_status, cancelled_at, payment_status or any
--     refund column.
--
--   select p.proname, p.prosrc like '%public.cancel_order(%' as delegates_to_029
--   from pg_proc p
--   join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public' and p.proname = 'resolve_order_cancellation_request';
--
--     Expected: delegates_to_029 = true.

-- ══════════════════════════════════════════════════════════════
-- WHAT THIS UNBLOCKS, AND WHAT IS STILL DEFERRED
-- ══════════════════════════════════════════════════════════════
--
-- THE SHIPMENT GUARD IS NOW EXPRESSIBLE, and it was not before. Phase
-- 2D-A had to withhold it because "an order with a cancellation request"
-- had no terminal state: a request the owner decided NOT to grant would
-- have blocked that order's shipment forever. With this migration the
-- rule finally has a correct form:
--
--   an OPEN request  =  cancellation_requested_at IS NOT NULL
--                       AND cancellation_request_resolution IS NULL
--
-- A declined request is resolved and must NOT block shipment. That guard
-- is the next phase and is deliberately not added here:
-- mark_order_shipped (migration 028) is untouched by this migration.
--
-- THERE IS STILL NO RETRY CRON. The interim retry for a failed outcome
-- email is a repeated authorized resolution with the SAME decision,
-- which returns 'already_approved' or 'already_declined' without moving
-- resolved_at and re-enters the email sender, whose claim picks the row
-- up only when it is 'failed'. If a sweep is ever built it must key on
-- 'failed' and nothing else - never NULL, or its first run would mail
-- every historical order at once.
--
-- REFUNDS ARE STILL MANUAL. Approving a cancellation stops fulfillment.
-- It does not move money, and the customer email says so explicitly
-- rather than implying a refund that nobody has issued.
-- ══════════════════════════════════════════════════════════════
