-- ============================================================
-- GLOA - THE CUSTOMER RIGHTS FOUNDATION
--
-- Phase 4C, stage 1. Run in the Supabase SQL Editor against the
-- existing production project, INSIDE the transaction below.
--
-- NOT YET APPLIED.
--
-- ONE migration, because these tables are one subject: a withdrawal
-- case needs an authoritative receipt date, a receipt date is only
-- meaningful against a deadline, and the deadline decides whether the
-- annual plan's remaining deliveries must be frozen. Splitting them
-- would create a window in which a case row can exist with no way to
-- date it.
-- ============================================================
--
-- WHAT THIS FILE ADDS, AND WHY EACH PIECE EXISTS
--
--   1. orders.delivered_at        the authoritative receipt instant
--   2. withdrawal_requests.*      the case, on top of the declaration
--   3. complaint_requests         Reklamation - a DIFFERENT right
--   4. termination_requests       the BGB 312k Kuendigungsbutton
--   5. purchase_restrictions      manual, admin-only abuse control
--
-- WHAT IT DOES NOT DO
--
-- It backfills nothing. It rewrites no existing row. It grants the
-- browser nothing. It changes no price, no order total and no refund
-- that already happened. Migrations 066, 067, 068 and 069 are not
-- touched, and no function they created is dropped here.
--
-- EVERY COLUMN ADDED TO AN EXISTING TABLE IS NULLABLE OR CARRIES A
-- DEFAULT, so every row that exists today stays legal the moment this
-- commits. That is what makes it safe to apply before its code ships.
--
-- ============================================================

begin;

-- 1. THE AUTHORITATIVE RECEIPT INSTANT ─────────────────────────
--
-- BGB 356 Abs. 2 Nr. 1 starts the withdrawal period when the consumer
-- RECEIVED the goods - not when we created the order, not when we
-- handed the parcel to the carrier, and not shipped_at plus a guessed
-- number of days. Migration 019 gave orders shipped_at, tracking and a
-- carrier. None of those is receipt, and inferring receipt from them
-- would silently date a statutory deadline from an event the law does
-- not name.
--
-- So receipt becomes its own column, written only by the server.
--
-- A timestamptz, NOT a date. The instant has to stay auditable: an
-- administrator marking receipt by hand, and one day a carrier
-- webhook, must both be able to record WHEN, exactly, and be
-- questioned about it later. The civil calendar date the deadline is
-- actually computed on is derived from this instant in Europe/Berlin
-- at the point of calculation - see lib/withdrawalDeadline.ts - rather
-- than stored pre-rounded, because rounding early would throw away the
-- evidence and bake one timezone into the row forever.

alter table public.orders
  add column if not exists delivered_at timestamptz;

-- WHERE THE CLAIM CAME FROM. A deadline that can send a consumer's
-- request away as late must be able to say who said so. 'admin_manual'
-- is what exists today; the carrier values exist now so that a later
-- integration writes THIS column rather than inventing a second one
-- beside it, which is the whole point of naming them before they are
-- used.

alter table public.orders
  add column if not exists delivery_receipt_source text
    check (delivery_receipt_source in (
      'admin_manual',
      'admin_customer_reported',
      'carrier_webhook',
      'carrier_api'
    ));

-- THE AUDIT PAIR. When we recorded it, and which administrator did.
-- Null actor is legitimate and expected for a carrier-sourced receipt,
-- which has no human actor - so this is deliberately not NOT NULL.

alter table public.orders
  add column if not exists delivery_recorded_at timestamptz;

alter table public.orders
  add column if not exists delivery_recorded_by uuid
    references public.admin_users(user_id) on delete set null;

-- THE THREE TRAVEL TOGETHER. A receipt instant with no source is an
-- assertion with no author, and a source with no instant is an author
-- with no assertion. Either alone would be a half-written fact that a
-- deadline calculation might still read.

alter table public.orders
  add constraint orders_delivery_receipt_shape_check
  check (
    (delivered_at is null and delivery_receipt_source is null
       and delivery_recorded_at is null)
    or
    (delivered_at is not null and delivery_receipt_source is not null
       and delivery_recorded_at is not null)
  );

-- A HUMAN SOURCE NEEDS A HUMAN. The carrier sources may have no actor;
-- the admin sources must have one, or the audit trail is a claim
-- nobody signed.

alter table public.orders
  add constraint orders_delivery_admin_source_requires_actor_check
  check (
    delivery_receipt_source is null
    or delivery_receipt_source in ('carrier_webhook', 'carrier_api')
    or delivery_recorded_by is not null
  );

create index if not exists idx_orders_delivered_at
  on public.orders(delivered_at)
  where delivered_at is not null;


-- 2. THE WITHDRAWAL CASE ───────────────────────────────────────
--
-- Migration 018 deliberately kept withdrawal_requests decoupled from
-- orders: customer_name and order_reference are what the CONSUMER
-- declared, free text, never joined, because BGB 356a requires the
-- function to work for a guest who has no account and may mistype the
-- order number. That decision is preserved exactly. The declaration
-- columns are not touched, not re-typed and not made NOT NULL.
--
-- What is added beside them is our RESOLUTION of that declaration -
-- our best identification, marked as ours, always nullable, so an
-- unresolvable guest submission remains a valid row. The consumer's
-- words stay the consumer's words; our match stays our match.

alter table public.withdrawal_requests
  add column if not exists resolved_order_id uuid
    references public.orders(id) on delete set null;

alter table public.withdrawal_requests
  add column if not exists resolved_user_id uuid
    references auth.users(id) on delete set null;

alter table public.withdrawal_requests
  add column if not exists resolved_annual_plan_id uuid
    references public.annual_plans(id) on delete set null;

alter table public.withdrawal_requests
  add column if not exists resolution_method text
    check (resolution_method in (
      'unresolved',
      'order_number_and_email',
      'authenticated_session',
      'admin_manual'
    ));

-- ── THE CASE STATE ────────────────────────────────────────────
--
-- DEFAULT 'submitted', which is what every historical row in this
-- table already is: migration 018 only ever wrote a declaration and
-- tracked whether the confirmation mail went out. Labelling them
-- 'submitted' is a description of what they are, not a rewrite - and
-- it costs no UPDATE.
--
-- 'rejected_late' is the only rejecting state, and section 2's
-- timeliness column is what may justify it. There is deliberately no
-- state meaning "rejected automatically".

alter table public.withdrawal_requests
  add column if not exists case_state text not null default 'submitted'
    check (case_state in (
      'submitted',
      'under_review',
      'awaiting_return',
      'overdue_return',
      'return_in_transit',
      'return_received',
      'opened_item_review',
      'approved',
      'refund_pending',
      'refunded',
      'rejected_late',
      'closed'
    ));

-- ── TIMELINESS: FOUR ANSWERS, AND TWO OF THEM ARE "WE DO NOT KNOW" ─
--
-- The deadline engine may not answer only timely/late. If we never
-- recorded receipt, or if the final day lands somewhere we cannot
-- safely resolve against BGB 193, the honest answer is that we do not
-- know - and the consequence of not knowing must be a human looking at
-- it, never a refusal. A wrongly refused withdrawal is a lost
-- statutory right; a wrongly reviewed one costs an administrator a
-- minute.
--
-- DEFAULT 'receipt_unknown' is therefore the correct label for every
-- historical row: those cases were taken before this system existed
-- and nothing about their receipt was ever recorded.

alter table public.withdrawal_requests
  add column if not exists timeliness text not null default 'receipt_unknown'
    check (timeliness in (
      'timely',
      'late',
      'receipt_unknown',
      'deadline_uncertain'
    ));

-- The instant the period started from, the civil date it ended on, and
-- which rule produced it. Stored so a case can be re-read years later
-- without re-running today's code against today's holiday table.

alter table public.withdrawal_requests
  add column if not exists deadline_start_at timestamptz;

alter table public.withdrawal_requests
  add column if not exists deadline_date date;

alter table public.withdrawal_requests
  add column if not exists deadline_basis text
    check (deadline_basis in (
      'single_delivery_receipt',
      'first_delivery_receipt_regular_delivery',
      'last_item_receipt',
      'unknown'
    ));

-- ── THE GOODS, IN EXACTLY TWO STATES ──────────────────────────
--
-- Sealed or not. There is no third value and no number, because the
-- moment a column can hold "how much was used" somebody will compute a
-- deduction from it, and a proportional-consumption deduction is not
-- what BGB 357a Abs. 1 provides for. The seal is the only fact that
-- matters for Wertersatz here.

alter table public.withdrawal_requests
  add column if not exists seal_state text
    check (seal_state in ('sealed_unopened', 'opened_seal_broken'));

-- ── THE RETURN ────────────────────────────────────────────────
--
-- Whether we asked for the goods back is an ADMIN decision, not an
-- automatic consequence of a broken seal.

alter table public.withdrawal_requests
  add column if not exists return_requirement text
    check (return_requirement in ('return_requested', 'return_not_required'));

alter table public.withdrawal_requests
  add column if not exists return_dispatch_proof_at timestamptz;

alter table public.withdrawal_requests
  add column if not exists return_received_at timestamptz;

-- ── WERTERSATZ: A PROPOSAL AND A DECISION, NEVER ONE COLUMN ───
--
-- suggested_* is what the server computed from the price snapshot
-- frozen at purchase. confirmed_* is what an administrator decided.
-- They are separate columns precisely so that the proposal can never
-- be mistaken for the decision, and so that a case shows both what was
-- offered up and what was actually applied.
--
-- Neither is reachable from the browser: see the grants in section 6.

alter table public.withdrawal_requests
  add column if not exists suggested_value_loss_cents integer
    check (suggested_value_loss_cents is null or suggested_value_loss_cents >= 0);

alter table public.withdrawal_requests
  add column if not exists confirmed_value_loss_cents integer
    check (confirmed_value_loss_cents is null or confirmed_value_loss_cents >= 0);

alter table public.withdrawal_requests
  add column if not exists value_loss_confirmed_by uuid
    references public.admin_users(user_id) on delete set null;

alter table public.withdrawal_requests
  add column if not exists value_loss_confirmed_at timestamptz;

-- A confirmed figure is a decision, and a decision has an author and a
-- moment. All three or none.

alter table public.withdrawal_requests
  add constraint withdrawal_requests_value_loss_decision_shape_check
  check (
    (confirmed_value_loss_cents is null
       and value_loss_confirmed_by is null
       and value_loss_confirmed_at is null)
    or
    (confirmed_value_loss_cents is not null
       and value_loss_confirmed_by is not null
       and value_loss_confirmed_at is not null)
  );

-- ── THE REFUND ────────────────────────────────────────────────
--
-- The amount the SERVER computed, the state of the payout, and the
-- moment it actually happened. No amount that ever arrives from a
-- browser is written here.
--
-- 'not_started' is the correct default for every historical row.

alter table public.withdrawal_requests
  add column if not exists refund_amount_cents integer
    check (refund_amount_cents is null or refund_amount_cents >= 0);

alter table public.withdrawal_requests
  add column if not exists refund_state text not null default 'not_started'
    check (refund_state in (
      'not_started',
      'on_hold_awaiting_return',
      'approved_for_payout',
      'executed',
      'failed'
    ));

alter table public.withdrawal_requests
  add column if not exists refund_executed_at timestamptz;

-- THE DOUBLE-REFUND GUARD. One payout per case, enforced by the
-- database rather than by remembering to check. Partial, so the many
-- cases that never pay out do not collide with each other on null.

alter table public.withdrawal_requests
  add column if not exists refund_operation_id uuid;

create unique index if not exists withdrawal_requests_refund_operation_key
  on public.withdrawal_requests(refund_operation_id)
  where refund_operation_id is not null;

-- ── THE FREEZE ────────────────────────────────────────────────
--
-- When a protected withdrawal is open, the annual plan stops producing
-- new deliveries. Recorded as an instant rather than a boolean so the
-- moment is auditable, and so setting it twice is visibly the same
-- fact rather than a second event.

alter table public.withdrawal_requests
  add column if not exists deliveries_frozen_at timestamptz;

-- ── IDEMPOTENCY ───────────────────────────────────────────────
--
-- A consumer who clicks the button twice, or whose phone retries the
-- request on a flaky connection, has made ONE declaration. Unique
-- where present, so historical rows - which have no key - do not
-- collide.

alter table public.withdrawal_requests
  add column if not exists idempotency_key text
    check (idempotency_key is null or char_length(idempotency_key) between 8 and 200);

create unique index if not exists withdrawal_requests_idempotency_key
  on public.withdrawal_requests(idempotency_key)
  where idempotency_key is not null;

alter table public.withdrawal_requests
  add column if not exists internal_note text
    check (internal_note is null or char_length(internal_note) <= 4000);

alter table public.withdrawal_requests
  add column if not exists updated_at timestamptz;

create index if not exists idx_withdrawal_requests_case_state
  on public.withdrawal_requests(case_state);

create index if not exists idx_withdrawal_requests_resolved_order
  on public.withdrawal_requests(resolved_order_id)
  where resolved_order_id is not null;


-- 3. REKLAMATION - A DIFFERENT RIGHT, A DIFFERENT TABLE ────────
--
-- A defect claim under BGB 437/439 is not a withdrawal. Different
-- trigger, different remedy, different cost rules: under BGB 439 Abs.
-- 2 the SELLER bears the necessary transport costs of cure, which is
-- the exact opposite of the withdrawal return-cost wording. Putting
-- both in one table would invite one code path to apply the other's
-- rules - which is precisely the mistake this separation prevents.

create table if not exists public.complaint_requests (
  id                uuid primary key default gen_random_uuid(),

  -- Declared by the customer, same reasoning as migration 018: this
  -- must work for a guest.
  customer_name     text not null check (char_length(customer_name) between 1 and 200),
  order_reference   text not null check (char_length(order_reference) between 1 and 200),
  contact_email     text not null check (char_length(contact_email) between 3 and 254),

  -- Our resolution of the above, never the customer's claim about it.
  resolved_order_id uuid references public.orders(id) on delete set null,
  resolved_user_id  uuid references auth.users(id) on delete set null,

  reason            text not null check (reason in (
                      'arrived_damaged',
                      'seal_already_broken_on_arrival',
                      'wrong_size',
                      'wrong_item',
                      'missing_goods',
                      'quality_defect',
                      'other'
                    )),

  customer_note     text check (customer_note is null or char_length(customer_note) <= 2000),

  case_state        text not null default 'submitted'
                    check (case_state in (
                      'submitted',
                      'under_review',
                      'evidence_requested',
                      'remedy_offered',
                      'replacement_sent',
                      'refunded',
                      'rejected',
                      'closed'
                    )),

  -- BGB 439 Abs. 2. Recorded explicitly so that a justified defect
  -- case can never silently inherit the withdrawal wording.
  seller_bears_transport_cost boolean not null default true,

  submitted_at      timestamptz not null default now(),
  updated_at        timestamptz,

  confirmation_status text not null default 'pending'
                      check (confirmation_status in ('pending', 'sent', 'failed')),
  confirmed_at        timestamptz,

  idempotency_key   text check (idempotency_key is null
                      or char_length(idempotency_key) between 8 and 200),

  internal_note     text check (internal_note is null or char_length(internal_note) <= 4000)
);

create unique index if not exists complaint_requests_idempotency_key
  on public.complaint_requests(idempotency_key)
  where idempotency_key is not null;

create index if not exists idx_complaint_requests_submitted_at
  on public.complaint_requests(submitted_at);

alter table public.complaint_requests enable row level security;


-- 4. THE TERMINATION BUTTON - BGB 312k ─────────────────────────
--
-- BGH 22.05.2025 - I ZR 161/24 decided this for a contract shaped
-- almost exactly like the annual plan: a single payment, a fixed
-- twelve-month term, automatic ending, no renewal. The court held that
-- what makes a Dauerschuldverhaeltnis is the TRADER's continuing
-- obligation to perform, not the consumer's payment rhythm - so the
-- button is required anyway. Twelve monthly deliveries is a continuing
-- obligation to perform. The annual plan is in scope, and this table
-- exists because of that judgment rather than in spite of it.
--
-- A termination is NOT a withdrawal and must never become one: it ends
-- a contract going forward, it triggers no refund, and it reverses
-- nothing. Separate table, no refund columns at all - the strongest
-- way to say that is to give this table no way to express one.

create table if not exists public.termination_requests (
  id                uuid primary key default gen_random_uuid(),

  -- BGB 312k Abs. 2 Satz 3: the confirmation page must collect the
  -- kind of termination, the reason for an extraordinary one, details
  -- identifying the consumer and the contract, the intended end, and
  -- an electronic address for the confirmation.
  termination_kind  text not null check (termination_kind in ('ordinary', 'extraordinary')),

  customer_name     text not null check (char_length(customer_name) between 1 and 200),
  contract_reference text not null check (char_length(contract_reference) between 1 and 200),
  contact_email     text not null check (char_length(contact_email) between 3 and 254),

  resolved_user_id         uuid references auth.users(id) on delete set null,
  resolved_subscription_id uuid references public.subscriptions(id) on delete set null,
  resolved_annual_plan_id  uuid references public.annual_plans(id) on delete set null,

  contract_kind     text check (contract_kind in ('subscription_4w', 'annual_plan', 'unresolved')),

  -- Null means "at the earliest possible date", which is what the
  -- button offers by default.
  requested_end_at  timestamptz,

  -- Required for an extraordinary termination, meaningless for an
  -- ordinary one - BGB 312k Abs. 2 Satz 3 Nr. 2 asks for it only in
  -- the extraordinary case.
  extraordinary_reason text,

  case_state        text not null default 'submitted'
                    check (case_state in (
                      'submitted',
                      'under_review',
                      'acknowledged_ends_automatically',
                      'scheduled',
                      'effective',
                      'rejected',
                      'closed'
                    )),

  submitted_at      timestamptz not null default now(),
  updated_at        timestamptz,

  confirmation_status text not null default 'pending'
                      check (confirmation_status in ('pending', 'sent', 'failed')),
  confirmed_at        timestamptz,

  idempotency_key   text check (idempotency_key is null
                      or char_length(idempotency_key) between 8 and 200),

  internal_note     text check (internal_note is null or char_length(internal_note) <= 4000)
);

alter table public.termination_requests
  add constraint termination_requests_extraordinary_needs_reason_check
  check (
    termination_kind <> 'extraordinary'
    or char_length(coalesce(extraordinary_reason, '')) > 0
  );

create unique index if not exists termination_requests_idempotency_key
  on public.termination_requests(idempotency_key)
  where idempotency_key is not null;

create index if not exists idx_termination_requests_submitted_at
  on public.termination_requests(submitted_at);

alter table public.termination_requests enable row level security;


-- 5. PURCHASE RESTRICTIONS - MANUAL, AND ONLY MANUAL ───────────
--
-- The abuse this guards against is real: buy the annual plan at ten
-- percent off, take the first delivery, withdraw, buy again. But the
-- defence must never be automatic, because exercising a statutory
-- right is not evidence of anything. There is deliberately no counter
-- column, no threshold and no trigger in this table: a restriction
-- exists because a named administrator created it, or it does not
-- exist.
--
-- It blocks NEW purchases in its scope and nothing else. A restricted
-- customer keeps every right they had: log in, read old orders,
-- withdraw, complain, terminate, be refunded. That is enforced by this
-- table having no relationship whatsoever to those paths.

create table if not exists public.purchase_restrictions (
  id           uuid primary key default gen_random_uuid(),

  user_id      uuid not null references auth.users(id) on delete cascade,

  scope        text not null check (scope in (
                 'annual_plan',
                 'recurring_subscription',
                 'all_new_plan_purchases'
               )),

  -- A category, not free prose, so that what gets counted and reported
  -- is a category. The prose belongs in internal_note, which never
  -- leaves the server.
  reason_category text not null check (reason_category in (
                 'repeated_withdrawal_pattern',
                 'payment_abuse',
                 'chargeback_history',
                 'manual_review',
                 'other'
               )),

  internal_note text check (internal_note is null or char_length(internal_note) <= 4000),

  created_at   timestamptz not null default now(),
  created_by   uuid not null references public.admin_users(user_id) on delete restrict,

  -- Null means it does not expire on its own.
  expires_at   timestamptz,

  -- Lifted rather than deleted: a restriction that was in force is a
  -- fact about the past, and deleting it would erase why a purchase
  -- was refused.
  active       boolean not null default true,
  lifted_at    timestamptz,
  lifted_by    uuid references public.admin_users(user_id) on delete set null
);

alter table public.purchase_restrictions
  add constraint purchase_restrictions_lift_shape_check
  check (
    (active = true and lifted_at is null and lifted_by is null)
    or
    (active = false and lifted_at is not null)
  );

-- One LIVE restriction per user per scope. A second one would make
-- "is this customer restricted" a question with two answers.
create unique index if not exists purchase_restrictions_one_active_per_scope_key
  on public.purchase_restrictions(user_id, scope)
  where active = true;

create index if not exists idx_purchase_restrictions_user
  on public.purchase_restrictions(user_id);

alter table public.purchase_restrictions enable row level security;


-- 6. PRIVILEGES ────────────────────────────────────────────────
--
-- NO BROWSER GRANT IS ADDED ANYWHERE IN THIS FILE.
--
-- Every table here holds something a customer must not be able to
-- write and mostly must not be able to read: when their goods were
-- received, what their goods are worth, what we will refund, why they
-- are restricted and what an administrator wrote about them. All of it
-- is reached through the server-side routes on service_role, exactly
-- as migration 018 established for withdrawal_requests and migration
-- 009/010 for checkout_attempts.
--
-- RLS is on and carries no policy for anon or authenticated, so even
-- if a grant were added by mistake later, there is still no policy to
-- let a row through.

grant select, insert, update on public.complaint_requests to service_role;
grant select, insert, update on public.termination_requests to service_role;
grant select, insert, update on public.purchase_restrictions to service_role;

-- withdrawal_requests already had SELECT and INSERT from migration 018
-- and a column-scoped UPDATE for the confirmation columns only. The
-- case now advances through many more columns, all of them written by
-- the server. The original declaration columns are deliberately NOT in
-- this list: customer_name, order_reference, contact_email, scope,
-- scope_note, customer_note and submitted_at stay unwritable, so no
-- code path can edit what the consumer actually declared.

grant update (
  resolved_order_id,
  resolved_user_id,
  resolved_annual_plan_id,
  resolution_method,
  case_state,
  timeliness,
  deadline_start_at,
  deadline_date,
  deadline_basis,
  seal_state,
  return_requirement,
  return_dispatch_proof_at,
  return_received_at,
  suggested_value_loss_cents,
  confirmed_value_loss_cents,
  value_loss_confirmed_by,
  value_loss_confirmed_at,
  refund_amount_cents,
  refund_state,
  refund_executed_at,
  refund_operation_id,
  deliveries_frozen_at,
  idempotency_key,
  internal_note,
  updated_at
) on public.withdrawal_requests to service_role;

-- The receipt columns on orders. Narrow on purpose: this grant lets
-- the server record a delivery and nothing else about an order.
grant update (
  delivered_at,
  delivery_receipt_source,
  delivery_recorded_at,
  delivery_recorded_by
) on public.orders to service_role;


-- 7. THE RECEIPT WRITER ────────────────────────────────────────
--
-- Receipt is recorded through a function, not through an UPDATE from
-- the route, for the same reason migration 052 wrapped shipping: the
-- rules about what a legal receipt looks like belong next to the
-- column, where every caller gets them, rather than in whichever route
-- happens to be writing today.
--
-- IT REFUSES A RECEIPT IN THE FUTURE. A deadline that has already
-- started cannot start later, and a future receipt date is always
-- either a typo or an attempt to move a deadline.
--
-- IT IS IDEMPOTENT. Recording the same receipt twice is the same fact,
-- so it returns 'unchanged' rather than moving the instant - which
-- would silently shift a statutory deadline that may already have been
-- communicated to the consumer.

create or replace function public.record_order_delivery(
  p_order_number  text,
  p_delivered_at  timestamptz,
  p_source        text,
  p_actor_user_id uuid default null
)
returns jsonb
language plpgsql
volatile
security definer set search_path = ''
as $$
declare
  v_order public.orders;
begin
  if p_order_number is null or p_delivered_at is null or p_source is null then
    return pg_catalog.jsonb_build_object('result', 'invalid_input');
  end if;

  if p_source not in ('admin_manual', 'admin_customer_reported',
                      'carrier_webhook', 'carrier_api') then
    return pg_catalog.jsonb_build_object('result', 'source_unknown');
  end if;

  if p_source in ('admin_manual', 'admin_customer_reported')
     and p_actor_user_id is null then
    return pg_catalog.jsonb_build_object('result', 'actor_required');
  end if;

  if p_delivered_at > pg_catalog.now() then
    return pg_catalog.jsonb_build_object('result', 'delivered_at_in_future');
  end if;

  select * into v_order
  from public.orders
  where order_number = p_order_number
  for update;

  if not found then
    return pg_catalog.jsonb_build_object('result', 'order_not_found');
  end if;

  -- Receipt cannot precede dispatch. If shipped_at exists and the
  -- claimed receipt is older, one of the two is wrong and a statutory
  -- deadline must not be computed from either until a human says which.
  if v_order.shipped_at is not null and p_delivered_at < v_order.shipped_at then
    return pg_catalog.jsonb_build_object('result', 'delivered_before_shipped');
  end if;

  if v_order.delivered_at is not null then
    if v_order.delivered_at = p_delivered_at then
      return pg_catalog.jsonb_build_object(
        'result', 'unchanged',
        'order_number', v_order.order_number,
        'delivered_at', v_order.delivered_at
      );
    end if;
    return pg_catalog.jsonb_build_object(
      'result', 'already_recorded',
      'order_number', v_order.order_number,
      'delivered_at', v_order.delivered_at
    );
  end if;

  update public.orders
     set delivered_at            = p_delivered_at,
         delivery_receipt_source = p_source,
         delivery_recorded_at    = pg_catalog.now(),
         delivery_recorded_by    = p_actor_user_id
   where id = v_order.id
  returning * into v_order;

  return pg_catalog.jsonb_build_object(
    'result', 'recorded',
    'order_number', v_order.order_number,
    'delivered_at', v_order.delivered_at,
    'source', v_order.delivery_receipt_source
  );
end;
$$;

revoke all on function public.record_order_delivery(text, timestamptz, text, uuid) from public;
revoke all on function public.record_order_delivery(text, timestamptz, text, uuid) from anon;
revoke all on function public.record_order_delivery(text, timestamptz, text, uuid) from authenticated;
grant execute on function public.record_order_delivery(text, timestamptz, text, uuid) to service_role;

-- The admin wrapper, in migration 052's shape: do the thing, then
-- record WHO did it, and only when it actually happened.

create or replace function public.admin_mark_order_delivered(
  p_actor_user_id uuid,
  p_order_number  text,
  p_delivered_at  timestamptz,
  p_source        text default 'admin_manual'
)
returns jsonb
language plpgsql
volatile
security definer set search_path = ''
as $$
declare
  v_payload jsonb;
begin
  if p_source not in ('admin_manual', 'admin_customer_reported') then
    return pg_catalog.jsonb_build_object('result', 'source_not_admin_writable');
  end if;

  v_payload := public.record_order_delivery(
    p_order_number, p_delivered_at, p_source, p_actor_user_id
  );

  if v_payload ->> 'result' = 'recorded' then
    perform public.record_admin_activity(
      p_actor_user_id, 'orders', 'order.delivered', 'order', p_order_number,
      'Zustellung fuer Bestellung ' || p_order_number || ' erfasst',
      gen_random_uuid(),
      pg_catalog.jsonb_build_object('source', p_source)
    );
  end if;

  return v_payload;
end;
$$;

revoke all on function public.admin_mark_order_delivered(uuid, text, timestamptz, text) from public;
revoke all on function public.admin_mark_order_delivered(uuid, text, timestamptz, text) from anon;
revoke all on function public.admin_mark_order_delivered(uuid, text, timestamptz, text) from authenticated;
grant execute on function public.admin_mark_order_delivered(uuid, text, timestamptz, text) to service_role;


-- 8. WHY THIS MAY BE APPLIED BEFORE ITS CODE ───────────────────
--
--   EVERY ADDED COLUMN IS NULLABLE OR DEFAULTED. The application
--   running in Production writes none of them and continues to work
--   unchanged.
--
--   EVERY NEW TABLE IS EMPTY AND UNREFERENCED until its routes ship.
--
--   NO EXISTING CONSTRAINT WAS TIGHTENED. Nothing that was legal
--   before this file became illegal after it.
--
--   NO EXISTING FUNCTION WAS DROPPED OR RE-SIGNED, so no caller
--   resolves differently.
--
-- The reverse order is also safe here, unlike migration 069: the new
-- code cannot run without these tables, so it must not ship first.

commit;


-- ============================================================
-- 9. VERIFY - READ ONLY, AFTER APPLYING. NOTHING BELOW RUNS.
-- ============================================================
--
--   A. THE RECEIPT COLUMNS EXIST AND NOTHING WAS BACKFILLED.
--
--   select count(*) as orders_total,
--          count(delivered_at) as with_receipt
--   from public.orders;
--
--     EXPECT with_receipt = 0 immediately after applying.
--
--   B. EVERY HISTORICAL WITHDRAWAL ROW IS STILL VALID.
--
--   select case_state, timeliness, refund_state, count(*)
--   from public.withdrawal_requests group by 1, 2, 3;
--
--     EXPECT only ('submitted', 'receipt_unknown', 'not_started').
--
--   C. THE BROWSER GAINED NOTHING.
--
--   select table_name, privilege_type, grantee
--   from information_schema.table_privileges
--   where table_schema = 'public'
--     and table_name in ('complaint_requests', 'termination_requests',
--                        'purchase_restrictions', 'withdrawal_requests')
--     and grantee in ('anon', 'authenticated');
--
--     EXPECT zero rows.
--
--   D. THE RECEIPT WRITER REFUSES A FUTURE DATE.
--
--   select public.record_order_delivery(
--     'GLOA-0000-000000', now() + interval '1 day', 'admin_manual',
--     '00000000-0000-0000-0000-000000000000'::uuid);
--
--     EXPECT {"result": "delivered_at_in_future"} - and note it
--     refuses BEFORE looking the order up, so a wrong order number
--     still returns the future-date refusal.
