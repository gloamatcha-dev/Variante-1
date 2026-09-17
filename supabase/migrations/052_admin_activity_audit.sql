-- ══════════════════════════════════════════════════════════════
-- 052 — THE ADMIN ACTIVITY LOG
--
-- 051 answered "who is an administrator". This answers "what did they
-- do". Two different questions, and this table is emphatically NOT the
-- domain history:
--
--   DOMAIN HISTORY    inventory_movements is the ledger. It is the
--                     source of truth for stock, it carries the balance
--                     each movement produced, and nothing here replaces
--                     or duplicates it. The same is true of the order
--                     state columns.
--   ACTIVITY LOG      one line per deliberate administrative act:
--                     WHO did WHAT to WHICH entity, WHEN, plus a small
--                     safe fact or two. It exists to answer "who
--                     shipped this" months later.
--
-- ── WHY THE BUSINESS FUNCTIONS ARE NOT TOUCHED ────────────────
--
-- The obvious design - write the audit row inside mark_order_shipped,
-- cancel_order and the rest - was investigated and rejected, because
-- every one of those functions has a SECOND caller with no
-- administrator behind it:
--
--   mark_order_shipped                    also /api/internal/orders/ship
--   cancel_order                          also /api/internal/orders/cancel
--   resolve_order_cancellation_request    also the internal resolve route
--   apply_order_refund_state              also the STRIPE WEBHOOK
--
-- The three internal routes authorise with a bearer secret and name no
-- person; the webhook is not a person at all. Auditing those as
-- administrative acts would put a name on something nobody did, and an
-- audit trail that lies once is worth nothing afterwards.
--
-- So 052 adds WRAPPERS under new names. The existing functions keep
-- their exact signatures, their exact behaviour and their other
-- callers. A wrapper runs the business function and writes the audit
-- row IN THE SAME TRANSACTION, so for those paths there is no window in
-- which one happened and the other did not.
--
-- Nothing here creates an overload: every function below is a NEW name.
-- No signature of an existing function is changed, so no older, less
-- safe overload can be left callable.
--
-- ── WHAT IS DELIBERATELY NOT AUDITED ATOMICALLY ───────────────
--
-- Stated here rather than hidden behind a passing test:
--
--   refunds       Stripe cannot join a Postgres transaction. The audit
--                 records the state GLOA COMMITTED after Stripe
--                 confirmed, keyed on the existing refund claim id, so
--                 a retry cannot produce a second row.
--   item and      inventory item create/update/archive and category
--   category      save are several direct statements today, not one
--                 function. Wrapping them would mean rewriting working
--                 code; they record their audit immediately after the
--                 write succeeds. A crash between the two would lose
--                 the audit line, not the data.
--
-- ── NO RETROACTIVE HISTORY ────────────────────────────────────
--
-- Not one row is inserted here. The 458 existing orders, the inventory
-- setup and every earlier administrative act stay unrecorded, because
-- nobody captured who performed them and inventing an actor would be
-- the one thing this table must never contain. Audit starts at
-- deployment.
-- ══════════════════════════════════════════════════════════════

begin;

-- ── 1. THE TABLE ──────────────────────────────────────────────

create table if not exists public.admin_activity_log (
  id                   uuid primary key default gen_random_uuid(),

  -- WHO, STABLY. The user id, which does not move when an address does.
  --
  -- RESTRICT, matching 051: an admin row is never deleted (access is
  -- withdrawn with is_active), and an audit row must certainly not
  -- disappear because somebody's account was tidied up later. Deleting
  -- an admin who has history now fails, loudly, which is correct.
  actor_user_id        uuid not null references public.admin_users(user_id) on delete restrict,

  -- WHO, AS THEY WERE AT THE TIME.
  --
  -- Snapshots, not a join. Resolving these from admin_users when the log
  -- is READ would rewrite history: promote somebody to owner today and
  -- every line they ever wrote would claim they were an owner then. The
  -- database fills these from admin_users at INSERT time - the browser
  -- never supplies them.
  actor_email_snapshot text not null check (length(btrim(actor_email_snapshot)) between 3 and 200),
  actor_name_snapshot  text not null check (length(btrim(actor_name_snapshot)) between 1 and 120),
  actor_role_snapshot  text not null check (actor_role_snapshot in ('owner', 'admin', 'viewer')),

  -- WHAT, in a small controlled vocabulary rather than free text.
  -- b2b, finance, documents and fulfillment are listed so a later
  -- package needs no migration to use them - none of them is
  -- implemented, and nothing writes them today.
  module               text not null check (module in
                         ('orders', 'inventory', 'b2b', 'finance', 'documents', 'fulfillment')),
  action               text not null check (length(btrim(action)) between 1 and 80),

  -- WHICH entity. The id, never a copy of the entity.
  entity_type          text not null check (length(btrim(entity_type)) between 1 and 40),
  entity_id            text not null check (length(btrim(entity_id)) between 1 and 120),

  -- One operational German sentence, written by the server from state
  -- it already trusts. Not a payload dump.
  summary              text not null check (length(btrim(summary)) between 1 and 300),

  -- A FEW SAFE FACTS, AND A HARD CEILING ON THEM.
  --
  -- The size limit is the point: it is what stops this column quietly
  -- becoming somewhere a full order, a customer record or a Stripe
  -- object gets parked. Anything that does not fit in 1 kB of JSON was
  -- never a "small fact".
  metadata             jsonb not null default '{}'::jsonb
                         check (jsonb_typeof(metadata) = 'object'
                                and length(metadata::text) <= 1024),

  -- IDEMPOTENCY. See section 4 for where each module's value comes from.
  operation_id         uuid not null,

  created_at           timestamptz not null default now(),

  -- ── ONE LOGICAL EVENT IS module + action + operation_id ────
  --
  -- The ACTION belongs in the key, and leaving it out was a real defect.
  -- One thing an operator does can legitimately be more than one
  -- recordable act in the same module: creating an item WITH an opening
  -- stock is an item_created AND a movement_recorded, both genuinely
  -- part of operation X. Keyed on (module, operation_id) the second one
  -- would hit the constraint and be dropped - silently, because a
  -- do-nothing conflict is not an error - and the log would be missing a
  -- line while every call reported success.
  --
  -- So the rule is stated as what it actually means:
  --
  --   same module + same action + same operation_id  = the same event,
  --                                                    i.e. a retry
  --   same module + same operation_id, OTHER action  = a different
  --                                                    event of the same
  --                                                    operation
  --
  -- Named, so record_admin_activity below can target this exact
  -- constraint rather than a column list that might drift from it.
  constraint admin_activity_log_event_key
    unique (module, action, operation_id)
);

-- Newest first is how the screen reads it, and the module filter is the
-- only filter there is. One index serves both.
create index if not exists idx_admin_activity_created
  on public.admin_activity_log (created_at desc, id desc);
create index if not exists idx_admin_activity_module_created
  on public.admin_activity_log (module, created_at desc, id desc);
-- "What happened to this order?" without scanning the table.
create index if not exists idx_admin_activity_entity
  on public.admin_activity_log (entity_type, entity_id, created_at desc);

comment on table public.admin_activity_log is
  'Append-only record of deliberate administrative acts. Not the domain history; inventory_movements and the order columns remain the source of truth.';

-- ── 2. NOTHING MAY REACH IT, AND NOTHING MAY CHANGE IT ────────
--
-- RLS on with NOT ONE POLICY, and every grant revoked from the browser
-- roles - the same shape as 050 and 051. A customer is an
-- `authenticated` Supabase user, so without this they could read who
-- did what inside GLOA.
--
-- AND THE SERVER ONLY READS. service_role ends with SELECT and nothing
-- else. That is what makes the log append-only in the strong sense -
-- not "we agreed not to", but "the role the application runs as
-- cannot". The ONLY way a row appears is record_admin_activity below,
-- and there is no way at all for one to change or disappear.
--
-- A correction is therefore a NEW event, which is what an audit trail
-- means by correction.
--
-- ── WHY THIS REVOKES FROM service_role FIRST ──────────────────
--
-- The first version of this section only revoked from anon and
-- authenticated and then granted SELECT to service_role - and that was
-- WRONG, which the applied database proved. Supabase carries default
-- privileges for service_role on new tables in `public`, so the table
-- arrived already holding SELECT, REFERENCES, TRIGGER and TRUNCATE for
-- it. The `grant select` added nothing, revoked nothing, and the
-- append-only claim above was true only about INSERT/UPDATE/DELETE.
--
-- TRUNCATE is the one that mattered: the server could have emptied its
-- own audit log in a single statement.
--
-- So the privileges are taken away FIRST, from all three roles and
-- without naming them, and exactly one is given back. Stating the end
-- state rather than the delta is the only form of this that cannot be
-- defeated by a default somebody set elsewhere.
--
-- The owner (postgres) is deliberately not named: revoking from the
-- owner would leave nobody able to administer the table.

alter table public.admin_activity_log enable row level security;

revoke all privileges on table public.admin_activity_log
  from anon, authenticated, service_role;

grant select on table public.admin_activity_log to service_role;

-- ── 3. THE ONLY WAY A ROW IS WRITTEN ──────────────────────────
--
-- SECURITY DEFINER because it must insert into a table its caller has
-- no INSERT grant on - which is exactly the property that makes it the
-- only door. search_path is pinned empty and every object is
-- schema-qualified, so nothing it touches can be shadowed.
--
-- THE ACTOR IS LOOKED UP, NOT ACCEPTED. The caller passes a user id and
-- nothing else about who they are; the email, the name and the role are
-- read here from admin_users. A server that wanted to log somebody
-- else's name could not, and a browser cannot reach this function at
-- all.
--
-- The actor must exist and be ACTIVE. A deactivated administrator
-- cannot be made to appear to have done something.

create or replace function public.record_admin_activity(
  p_actor_user_id uuid,
  p_module        text,
  p_action        text,
  p_entity_type   text,
  p_entity_id     text,
  p_summary       text,
  p_operation_id  uuid,
  p_metadata      jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer set search_path = ''
as $$
declare
  v_email    text;
  v_name     text;
  v_role     text;
  v_id       uuid;
  v_existing record;
begin
  select a.email, a.display_name, a.role
    into v_email, v_name, v_role
  from public.admin_users a
  where a.user_id = p_actor_user_id
    and a.is_active;

  if v_email is null then
    -- No row, or not active. Refusing is the only honest answer: the
    -- alternative is an audit line attributed to nobody.
    raise exception 'record_admin_activity: no active admin_users row for the given actor'
      using errcode = '42501';
  end if;

  insert into public.admin_activity_log (
    actor_user_id, actor_email_snapshot, actor_name_snapshot, actor_role_snapshot,
    module, action, entity_type, entity_id, summary, metadata, operation_id
  ) values (
    p_actor_user_id, v_email, v_name, v_role,
    p_module, p_action, p_entity_type, p_entity_id, p_summary,
    coalesce(p_metadata, '{}'::jsonb), p_operation_id
  )
  on conflict on constraint admin_activity_log_event_key do nothing
  returning id into v_id;

  if v_id is not null then
    return v_id;
  end if;

  -- ── A CONFLICT IS EITHER A RETRY OR A BUG. TELL THEM APART. ──
  --
  -- A bare "do nothing" would treat both the same way and return
  -- success, so a caller that reused one idempotency key for a
  -- DIFFERENT act would quietly lose the second act forever - the exact
  -- failure this key was widened to prevent, reappearing one level up.
  --
  -- So the existing row is read back and checked against what this call
  -- claims. Identity only: the same person, the same kind of thing, the
  -- same thing.
  --
  -- ── WHERE THIS RAISE CAN AND CANNOT REACH ────────────────
  --
  -- Raising inside one of the wrappers below would roll back the
  -- BUSINESS change with it, so it is worth being exact about when that
  -- can happen. It cannot:
  --
  --   the three order wrappers  mint their operation id with
  --                             gen_random_uuid(), so they never
  --                             present a key that already exists.
  --   the two inventory         pass the caller's operation id, but
  --   wrappers                  050 owns a GLOBAL unique index on
  --                             inventory_movements.operation_id and
  --                             answers 'already_recorded' before it
  --                             locks anything. The wrappers record only
  --                             on 'recorded', so a reused id skips the
  --                             audit entirely rather than reaching it.
  --
  -- What is left is the application-level path (item and category CRUD,
  -- and the refund), where this arrives as an error to
  -- lib/adminAuditDeps.ts: logged loudly, reported as false, and the
  -- business change left standing. Which is the point - the collision is
  -- a programming error, and it is now visible instead of silent.

  select l.id, l.actor_user_id, l.entity_type, l.entity_id
    into v_existing
  from public.admin_activity_log l
  where l.module = p_module
    and l.action = p_action
    and l.operation_id = p_operation_id;

  if not found then
    -- The conflicting row is not visible to this transaction: a
    -- concurrent insert that has not committed. Refusing is the only
    -- honest answer - the caller can retry once it has.
    raise exception 'record_admin_activity: a concurrent event holds %/%/% and is not yet visible',
      p_module, p_action, p_operation_id
      using errcode = '40001';
  end if;

  if v_existing.actor_user_id is distinct from p_actor_user_id
     or v_existing.entity_type  is distinct from p_entity_type
     or v_existing.entity_id    is distinct from p_entity_id then
    raise exception 'record_admin_activity: idempotency key %/%/% already describes a different act (actor %, entity %:%)',
      p_module, p_action, p_operation_id,
      v_existing.actor_user_id, v_existing.entity_type, v_existing.entity_id
      using errcode = '23505';
  end if;

  -- SAME PERSON, SAME ENTITY, SAME ACT. A retry. The summary and the
  -- metadata are NOT compared: a safe derived fact or a reformatted
  -- sentence may legitimately differ between attempts, and refusing over
  -- that would turn a harmless retry into an error.
  --
  -- The stored row is returned UNCHANGED. Nothing here updates or
  -- deletes it - the first telling of an event is the one that stands.
  return v_existing.id;
end;
$$;

revoke all on function public.record_admin_activity(uuid, text, text, text, text, text, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.record_admin_activity(uuid, text, text, text, text, text, uuid, jsonb)
  to service_role;

-- ── 4. THE WRAPPERS: BUSINESS MUTATION AND AUDIT, ONE TRANSACTION ──
--
-- Each of these runs the EXISTING business function unchanged and then
-- records the act. Both statements are inside one function call, so
-- they are inside one transaction: there is no state in which the order
-- moved and the log does not say who moved it.
--
-- AUDIT ONLY WHAT ACTUALLY HAPPENED. Each business function already
-- distinguishes "I did it" from "it was already done" - 'shipped' vs
-- 'already_shipped', 'cancelled' vs 'already_cancelled'. The wrapper
-- audits only the first. That is the idempotency: a replay returns the
-- "already" result and writes no second row, using the business rule
-- that was there before this migration rather than a new one invented
-- beside it.
--
-- The operation id is generated HERE rather than accepted from the
-- browser, because the guard above already prevents a duplicate.

create or replace function public.admin_mark_order_shipped(
  p_actor_user_id   uuid,
  p_order_number    text,
  p_carrier         text default null,
  p_tracking_number text default null,
  p_tracking_url    text default null
)
returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_payload jsonb;
  v_result  text;
begin
  v_payload := public.mark_order_shipped(
    p_order_number, p_carrier, p_tracking_number, p_tracking_url
  );
  v_result := v_payload ->> 'result';

  if v_result = 'shipped' then
    perform public.record_admin_activity(
      p_actor_user_id, 'orders', 'order.shipped', 'order', p_order_number,
      'Bestellung ' || p_order_number || ' als versendet markiert',
      gen_random_uuid(),
      jsonb_build_object(
        'carrier', p_carrier,
        -- Whether a number exists, never the number itself.
        'tracking_added', p_tracking_number is not null
      )
    );
  end if;

  return v_payload;
end;
$$;

create or replace function public.admin_cancel_order(
  p_actor_user_id uuid,
  p_order_number  text
)
returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_payload jsonb;
begin
  v_payload := public.cancel_order(p_order_number);

  if v_payload ->> 'result' = 'cancelled' then
    perform public.record_admin_activity(
      p_actor_user_id, 'orders', 'order.cancelled', 'order', p_order_number,
      'Bestellung ' || p_order_number || ' storniert',
      gen_random_uuid(), '{}'::jsonb
    );
  end if;

  return v_payload;
end;
$$;

create or replace function public.admin_resolve_order_cancellation_request(
  p_actor_user_id uuid,
  p_order_number  text,
  p_decision      text
)
returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_payload jsonb;
  v_result  text;
begin
  v_payload := public.resolve_order_cancellation_request(p_order_number, p_decision);
  v_result := v_payload ->> 'result';

  -- Only a decision that was actually taken here. A request already
  -- resolved reports so and is not recorded a second time.
  if v_result in ('approved', 'declined') then
    perform public.record_admin_activity(
      p_actor_user_id, 'orders', 'order.cancellation_request_resolved', 'order', p_order_number,
      'Stornierungsanfrage zu ' || p_order_number
        || case when v_result = 'approved' then ' angenommen' else ' abgelehnt' end,
      gen_random_uuid(),
      jsonb_build_object('decision', v_result)
    );
  end if;

  return v_payload;
end;
$$;

-- ── INVENTORY ─────────────────────────────────────────────────
--
-- The 050 functions are untouched and still do all the work: the row
-- lock, the balance, the append-only ledger entry, the negative-stock
-- rule. The wrapper adds two things and changes nothing:
--
--   1. The actor's EMAIL for the ledger's actor_email column is read
--      from admin_users here, using the verified user id. The server
--      no longer passes an address at all, so a client-supplied address
--      cannot reach the ledger even in principle.
--   2. The activity row, in the same transaction.
--
-- Idempotency reuses the ledger's own. p_operation_id carries a UNIQUE
-- index on inventory_movements, and 050 CATCHES that violation itself:
-- a replay returns 'already_recorded' rather than raising. The wrapper
-- therefore audits only 'recorded', and the audit's own
-- the event key - module + action + the same operation id - is the
-- second belt.

create or replace function public.admin_record_inventory_movement(
  p_actor_user_id    uuid,
  p_operation_id     uuid,
  p_item_id          uuid,
  p_quantity         numeric,
  p_movement_type    text,
  p_reason           text,
  p_area             text default null,
  p_note             text default null,
  p_reference        text default null,
  p_supplier         text default null,
  p_batch_number     text default null,
  p_best_before_date date default null,
  p_occurred_at      timestamptz default null,
  p_allow_negative   boolean default false
)
returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_actor_email text;
  v_payload     jsonb;
  v_item_name   text;
  v_unit        text;
begin
  select a.email into v_actor_email
  from public.admin_users a
  where a.user_id = p_actor_user_id and a.is_active;

  if v_actor_email is null then
    raise exception 'admin_record_inventory_movement: no active admin_users row for the given actor'
      using errcode = '42501';
  end if;

  v_payload := public.record_inventory_movement(
    p_operation_id, p_item_id, p_quantity, p_movement_type, p_reason,
    p_area, p_note, p_reference, p_supplier, p_batch_number,
    p_best_before_date, p_occurred_at, v_actor_email, p_allow_negative
  );

  -- 'recorded' only. 'already_recorded' is 050 reporting that an
  -- identical operation id already wrote the movement, and the audit row
  -- for it exists from that first call.
  if v_payload ->> 'result' = 'recorded' then
    select i.name, i.unit into v_item_name, v_unit
    from public.inventory_items i where i.id = p_item_id;

    perform public.record_admin_activity(
      p_actor_user_id, 'inventory', 'inventory.movement_recorded',
      'inventory_item', p_item_id::text,
      'Bestandsbewegung für ' || coalesce(v_item_name, 'Artikel') || ' erfasst',
      p_operation_id,
      jsonb_build_object(
        'movement_type', p_movement_type,
        'reason', p_reason,
        'quantity', p_quantity,
        'unit', v_unit
      )
    );
  end if;

  return v_payload;
end;
$$;

create or replace function public.admin_record_inventory_stocktake(
  p_actor_user_id uuid,
  p_operation_id  uuid,
  p_item_id       uuid,
  p_physical      numeric,
  p_note          text default null,
  p_reference     text default null,
  p_occurred_at   timestamptz default null
)
returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_actor_email text;
  v_payload     jsonb;
  v_item_name   text;
  v_unit        text;
begin
  select a.email into v_actor_email
  from public.admin_users a
  where a.user_id = p_actor_user_id and a.is_active;

  if v_actor_email is null then
    raise exception 'admin_record_inventory_stocktake: no active admin_users row for the given actor'
      using errcode = '42501';
  end if;

  v_payload := public.record_inventory_stocktake(
    p_operation_id, p_item_id, p_physical, p_note, p_reference, p_occurred_at, v_actor_email
  );

  -- 'recorded' only. 'already_recorded' is a replay, and 'no_change' is
  -- a count that matched the books exactly - it wrote no ledger entry,
  -- so this log, which is about changes, does not claim one.
  if v_payload ->> 'result' = 'recorded' then
    select i.name, i.unit into v_item_name, v_unit
    from public.inventory_items i where i.id = p_item_id;

    perform public.record_admin_activity(
      p_actor_user_id, 'inventory', 'inventory.stocktake_recorded',
      'inventory_item', p_item_id::text,
      'Inventur für ' || coalesce(v_item_name, 'Artikel') || ' erfasst',
      p_operation_id,
      jsonb_build_object('counted', p_physical, 'unit', v_unit)
    );
  end if;

  return v_payload;
end;
$$;

-- ── 5. WHO MAY CALL THE WRAPPERS ──────────────────────────────
--
-- The same shape as 050's: nothing for a browser role, execute for the
-- server. A customer session cannot reach any of them.

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.admin_mark_order_shipped(uuid, text, text, text, text)',
    'public.admin_cancel_order(uuid, text)',
    'public.admin_resolve_order_cancellation_request(uuid, text, text)',
    'public.admin_record_inventory_movement(uuid, uuid, uuid, numeric, text, text, text, text, text, text, text, date, timestamptz, boolean)',
    'public.admin_record_inventory_stocktake(uuid, uuid, uuid, numeric, text, text, timestamptz)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end $$;

commit;

-- ══════════════════════════════════════════════════════════════
-- VERIFYING THIS MIGRATION, read-only:
--
--   1. Append-only in the strong sense - the server cannot write it,
--      and cannot TRUNCATE it either. Grouped by role, because the
--      failure this caught was a privilege nobody granted on purpose:
--        select grantee, string_agg(privilege_type, ', ' order by privilege_type)
--        from information_schema.role_table_grants
--        where table_schema = 'public' and table_name = 'admin_activity_log'
--          and grantee in ('anon', 'authenticated', 'service_role')
--        group by grantee;
--      -> ONE row: service_role | SELECT
--      -> anon and authenticated do not appear at all.
--      And nothing may be passed on:
--        select is_grantable from information_schema.role_table_grants
--        where table_name = 'admin_activity_log' and grantee = 'service_role';
--      -> NO
--
--   2. Nothing in a browser can reach it:
--        select relrowsecurity from pg_class
--        where oid = 'public.admin_activity_log'::regclass;      -> true
--        select count(*) from pg_policies
--        where tablename = 'admin_activity_log';                 -> 0
--
--   3. No insecure overload was left behind. Every name below must
--      return exactly ONE row:
--        select proname, count(*) from pg_proc p
--        join pg_namespace n on n.oid = p.pronamespace
--        where n.nspname = 'public' and proname in (
--          'record_admin_activity','admin_mark_order_shipped','admin_cancel_order',
--          'admin_resolve_order_cancellation_request',
--          'admin_record_inventory_movement','admin_record_inventory_stocktake')
--        group by proname;
--
--   4. The 050 and 028-032 functions are untouched and still single:
--        ... same query for 'record_inventory_movement',
--            'record_inventory_stocktake','mark_order_shipped','cancel_order',
--            'resolve_order_cancellation_request'    -> one row each.
--
--   5. Nothing was backfilled:
--        select count(*) from public.admin_activity_log;         -> 0
--
--   6. Inventory is untouched:
--        select count(*) from public.inventory_movements;        -> unchanged
-- ══════════════════════════════════════════════════════════════
