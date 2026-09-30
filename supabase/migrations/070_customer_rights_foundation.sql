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

-- THE FOUR TRAVEL TOGETHER. A receipt instant with no source is an
-- assertion with no author, and a source with no instant is an author
-- with no assertion. Either alone would be a half-written fact that a
-- deadline calculation might still read.
--
-- delivery_recorded_by IS PART OF THE "NO RECEIPT" SIDE. Without it an
-- order could carry an administrator's id while holding no receipt at
-- all - an orphan actor attached to nothing, which reads in the admin
-- desk as "somebody recorded this" when nobody did.
--
-- On the receipt side it stays optional, because a carrier-sourced
-- receipt genuinely has no human actor. The separate
-- orders_delivery_admin_source_requires_actor_check below is what
-- demands one for the two admin sources.

alter table public.orders
  add constraint orders_delivery_receipt_shape_check
  check (
    (delivered_at is null and delivery_receipt_source is null
       and delivery_recorded_at is null and delivery_recorded_by is null)
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

-- The index the delivery queue's freeze predicate reads on every pass.
create index if not exists idx_withdrawal_requests_frozen_plan
  on public.withdrawal_requests(resolved_annual_plan_id)
  where deliveries_frozen_at is not null;


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

-- A REASON MUST BE A REASON. char_length > 0 accepted '   ', which
-- satisfies BGB 312k Abs. 2 Satz 3 Nr. 2 on paper and tells an
-- administrator nothing. btrim first, so whitespace is the same as
-- nothing. An ORDINARY termination still needs no reason at all.

alter table public.termination_requests
  add constraint termination_requests_extraordinary_needs_reason_check
  check (
    termination_kind <> 'extraordinary'
    or char_length(btrim(coalesce(extraordinary_reason, ''))) > 0
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

-- A LIFT HAS AN AUTHOR AND A MOMENT, BOTH. The writer always sets
-- both, and the constraint used to allow lifted_at without lifted_by -
-- a restriction that ended with nobody's name on it. Lifting is a
-- decision about a customer, so it is signed like every other one.

alter table public.purchase_restrictions
  add constraint purchase_restrictions_lift_shape_check
  check (
    (active = true and lifted_at is null and lifted_by is null)
    or
    (active = false and lifted_at is not null and lifted_by is not null)
  );

-- One LIVE restriction per user per scope. A second one would make
-- "is this customer restricted" a question with two answers.
--
-- THE PREDICATE IS active, NOT "active and unexpired", and it has to
-- be: a partial index predicate must be IMMUTABLE, and now() is not.
-- So an expired row keeps occupying this slot until somebody closes
-- it. That does NOT block the customer - lib/purchaseRestrictions.ts
-- treats an expired row as not live, so their purchases go through -
-- but it would block an administrator from recording a NEW restriction
-- for the same scope. admin_create_purchase_restriction closes an
-- expired row explicitly, with an audit entry, rather than leaving the
-- slot jammed. See section 9.
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
--
-- ── 6a. THE GAP MIGRATION 023 MISSED ─────────────────────────
--
-- A read-only preflight against Production found anon and authenticated
-- each holding REFERENCES, TRIGGER and TRUNCATE on
-- public.withdrawal_requests.
--
-- WHERE THEY CAME FROM. Supabase ships ALTER DEFAULT PRIVILEGES for the
-- public schema, so a table arrives with privileges already handed to
-- anon, authenticated and service_role before any migration grants
-- anything. Migration 018 created this table and granted only what
-- service_role needed; it never took the inherited ones back.
--
-- Migration 023 diagnosed exactly this - same three privileges, same
-- cause - and hardened stripe_customers, checkout_attempts and
-- stripe_webhook_events. It enumerated the tables from 009 and 022 and
-- did not reach 018's, so withdrawal_requests kept them. This section
-- closes that, four migrations' worth of the same lesson later.
--
-- WHY RLS DID NOT COVER IT, in 023's words: row-level security filters
-- ROWS. TRUNCATE removes every row without producing any, REFERENCES
-- lets another table point a foreign key at this one, and TRIGGER
-- attaches code to it. None of those is a row read or a row write, so
-- no policy - and no absence of policies - constrains them. On a table
-- holding statutory withdrawal declarations, a browser role able to
-- TRUNCATE is able to destroy the evidence that a consumer ever
-- exercised the right.
--
-- THE ORDER MATTERS. The revoke runs BEFORE every grant below, so
-- nothing this file hands out is taken back again.

revoke all privileges on table public.withdrawal_requests
  from anon, authenticated, service_role;

revoke all privileges on table public.withdrawal_requests from public;

-- And back, deriving the set from what the code actually does rather
-- than from what is convenient:
--
--   SELECT  lib/withdrawalSubmissionDeps.ts reads by idempotency key,
--           reads back the row it just inserted, and the admin desk
--           lists cases and loads a case's contact details.
--   INSERT  the declaration itself, once per submission.
--
-- NOT DELETE, and not TRUNCATE: nothing in this application removes a
-- withdrawal declaration, and nothing should be able to.
-- NOT REFERENCES, and not TRIGGER: no code needs either.
--
-- UPDATE stays COLUMN-SCOPED and is granted below - migration 018's two
-- confirmation columns plus the case columns this migration adds - so
-- the consumer's own declaration remains unwritable by anything.

grant select, insert on table public.withdrawal_requests to service_role;

grant update (confirmation_status, confirmed_at)
  on public.withdrawal_requests to service_role;

-- ── 6b. AND THE SAME DEFAULTS ON THE THREE NEW TABLES ────────
--
-- The three tables created above arrive with the identical inherited
-- privileges - that is what 6a just finished cleaning up on an
-- eight-migration-old table. Granting service_role what it needs
-- without first taking back what Supabase handed out would create the
-- exact bug this migration exists to close, three more times.
--
-- So each is emptied and then given precisely what the server uses:
-- SELECT to list and read a case, INSERT to open one, UPDATE to
-- advance it. No DELETE, no TRUNCATE, no REFERENCES, no TRIGGER, and
-- nothing at all for anon or authenticated.

revoke all privileges on table public.complaint_requests
  from anon, authenticated, service_role;
revoke all privileges on table public.complaint_requests from public;

revoke all privileges on table public.termination_requests
  from anon, authenticated, service_role;
revoke all privileges on table public.termination_requests from public;

revoke all privileges on table public.purchase_restrictions
  from anon, authenticated, service_role;
revoke all privileges on table public.purchase_restrictions from public;

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


-- 8. THE FREEZE ────────────────────────────────────────────────
--
-- A protected withdrawal stops the annual plan producing NEW
-- deliveries. "Protected" is deliberately wider than "timely": a case
-- we cannot safely reject - receipt never recorded, or a last day we
-- could not decide - freezes exactly as a timely one does. Shipping
-- box four while arguing about whether box one arrived in time is the
-- one outcome nobody can undo.
--
-- WHERE THE GUARD LIVES, AND WHY IT IS THE QUEUE
--
-- It is a predicate on which deliveries are DUE, not an exception
-- thrown while fulfilling one. That choice is what makes it safe:
--
--   idempotent      a frozen plan is simply never claimed. Running the
--                   worker a hundred times changes nothing.
--   duplicate-free  nothing is claimed, so there is nothing half-done
--                   to reconcile, and no lease to expire.
--   reversible      the delivery rows stay 'scheduled' with the
--                   scheduled_for migration 039 froze at activation. When
--                   the case closes they become due again and the worker
--                   mints exactly what is owed - it does not replay a
--                   backlog, because a delivery already minted has an
--                   order_id and is excluded anyway.
--   historical-safe it touches no delivery that already happened.
--
-- THE SOURCE OF TRUTH IS THE CASE ROW, not a flag copied onto the plan.
-- A denormalised boolean would be one more thing to keep in step, and
-- the failure mode of it drifting is shipping goods during a live
-- withdrawal.
--
-- A CLOSED CASE NO LONGER FREEZES. refunded, rejected_late and closed
-- are end states; anything before them is still open.

create or replace function public.annual_plan_delivery_freeze_active(
  p_annual_plan_id uuid
)
returns boolean
language sql
stable
security definer set search_path = ''
as $$
  select exists (
    select 1
    from public.withdrawal_requests w
    where w.resolved_annual_plan_id = p_annual_plan_id
      and w.deliveries_frozen_at is not null
      and w.case_state not in ('refunded', 'rejected_late', 'closed')
  );
$$;

revoke all on function public.annual_plan_delivery_freeze_active(uuid) from public;
revoke all on function public.annual_plan_delivery_freeze_active(uuid) from anon;
revoke all on function public.annual_plan_delivery_freeze_active(uuid) from authenticated;
grant execute on function public.annual_plan_delivery_freeze_active(uuid) to service_role;

-- Migration 039's queue, re-stated with ONE added predicate.
--
-- Everything else is byte-for-byte what 039 wrote: the same active and
-- not-refunded plan filter, the same order_id/fulfilled_at exclusions,
-- the same six-hour lease, the same ordering, the same
-- least(greatest(...)) clamp, and the same `for update of d skip
-- locked` that keeps this function and 039's section 9 from deadlocking.
-- Re-created rather than patched because a SQL function body cannot be
-- altered in place.

create or replace function public.claim_due_annual_plan_deliveries(
  p_limit integer
)
returns table (
  delivery_id     uuid,
  annual_plan_id  uuid,
  delivery_number integer,
  scheduled_for   timestamptz,
  reclaimed       boolean
)
language sql
volatile
security definer set search_path = ''
as $$
  with due as (
    select d.id, (d.state = 'claimed') as was_claimed
    from public.annual_plan_deliveries d
    join public.annual_plans p on p.id = d.annual_plan_id
    where p.status = 'active'
      and p.payment_status <> 'refunded'
      -- MIGRATION 070. A plan with a protected, unresolved withdrawal
      -- is not due for anything.
      and not public.annual_plan_delivery_freeze_active(p.id)
      and d.order_id is null
      and d.fulfilled_at is null
      and (
        (d.state = 'scheduled' and d.scheduled_for <= pg_catalog.now())
        or
        (d.state = 'claimed'
         and d.claimed_at is not null
         and d.claimed_at < pg_catalog.now() - interval '6 hours')
      )
    order by d.scheduled_for asc, d.delivery_number asc, d.id asc
    limit least(greatest(coalesce(p_limit, 25), 1), 100)
    for update of d skip locked
  )
  update public.annual_plan_deliveries t
     set state      = 'claimed',
         claimed_at = pg_catalog.now()
    from due
   where t.id = due.id
  returning t.id, t.annual_plan_id, t.delivery_number, t.scheduled_for, due.was_claimed;
$$;

revoke all on function public.claim_due_annual_plan_deliveries(integer) from public;
revoke all on function public.claim_due_annual_plan_deliveries(integer) from anon;
revoke all on function public.claim_due_annual_plan_deliveries(integer) from authenticated;
grant execute on function public.claim_due_annual_plan_deliveries(integer) to service_role;

-- SETTING the freeze. Idempotent by returning 'unchanged' rather than
-- re-stamping, so the instant stays the moment it first applied.

create or replace function public.freeze_annual_deliveries_for_withdrawal(
  p_withdrawal_id uuid
)
returns jsonb
language plpgsql
volatile
security definer set search_path = ''
as $$
declare
  v_case public.withdrawal_requests;
begin
  if p_withdrawal_id is null then
    return pg_catalog.jsonb_build_object('result', 'invalid_input');
  end if;

  select * into v_case
  from public.withdrawal_requests
  where id = p_withdrawal_id
  for update;

  if not found then
    return pg_catalog.jsonb_build_object('result', 'not_found');
  end if;

  if v_case.resolved_annual_plan_id is null then
    return pg_catalog.jsonb_build_object('result', 'no_annual_plan');
  end if;

  -- Only a case we cannot safely reject may freeze. A clearly late one
  -- has no claim on future deliveries.
  if v_case.timeliness not in ('timely', 'receipt_unknown', 'deadline_uncertain') then
    return pg_catalog.jsonb_build_object('result', 'not_protected',
                                         'timeliness', v_case.timeliness);
  end if;

  if v_case.deliveries_frozen_at is not null then
    return pg_catalog.jsonb_build_object('result', 'unchanged',
                                         'frozen_at', v_case.deliveries_frozen_at);
  end if;

  update public.withdrawal_requests
     set deliveries_frozen_at = pg_catalog.now(),
         updated_at           = pg_catalog.now()
   where id = v_case.id
  returning * into v_case;

  return pg_catalog.jsonb_build_object('result', 'frozen',
                                       'frozen_at', v_case.deliveries_frozen_at,
                                       'annual_plan_id', v_case.resolved_annual_plan_id);
end;
$$;

revoke all on function public.freeze_annual_deliveries_for_withdrawal(uuid) from public;
revoke all on function public.freeze_annual_deliveries_for_withdrawal(uuid) from anon;
revoke all on function public.freeze_annual_deliveries_for_withdrawal(uuid) from authenticated;
grant execute on function public.freeze_annual_deliveries_for_withdrawal(uuid) to service_role;


-- 9. THE AUDIT MODULE THIS SUBSYSTEM WRITES UNDER ──────────────
--
-- Migration 052 constrains admin_activity_log.module to six values -
-- orders, inventory, b2b, finance, documents, fulfillment - and its own
-- comment says the unimplemented ones are listed "so a later package
-- needs no migration to use them".
--
-- None of them means consumer rights. A withdrawal, a Reklamation, a
-- Kuendigung and a Kaufsperre are not order operations: folding them
-- into 'orders' would make the activity log say an operator did
-- something to an order when they decided a statutory question about a
-- contract. So the list gains a seventh value instead.
--
-- CAUGHT BY APPLYING THIS MIGRATION TO A REAL POSTGRES, not by reading
-- it. Every one of the nine writers below calls record_admin_activity
-- with 'customer_rights', so without this widening each of them would
-- raise check_violation the first time an administrator used it - and
-- because the audit call sits inside the same transaction as the
-- change, the whole action would roll back. The migration would have
-- applied perfectly and the desk would have been inert.
--
-- WIDENING ONLY. No existing value becomes illegal, so no row in the
-- log can violate the new constraint.

alter table public.admin_activity_log
  drop constraint admin_activity_log_module_check;

alter table public.admin_activity_log
  add constraint admin_activity_log_module_check
  check (module in ('orders', 'inventory', 'b2b', 'finance',
                    'documents', 'fulfillment', 'customer_rights'));


-- 10. THE ADMIN WRITERS ────────────────────────────────────────
--
-- Every authoritative decision on a case goes through a function here,
-- in migration 052's shape: do the thing, then record WHO did it, and
-- only when it actually happened.
--
-- WHY FUNCTIONS AND NOT UPDATES FROM A ROUTE. Three reasons, and the
-- third is the one that matters:
--
--   * the rules live next to the columns, so every caller gets them
--   * the audit entry cannot be forgotten, because it is in the same
--     function as the change
--   * A BROWSER CANNOT REACH THEM. Each is revoked from anon and
--     authenticated and granted to service_role alone, so "the customer
--     confirmed their own value loss" is not a bug that can be written.
--
-- The actor is always the FIRST argument and always comes from a
-- verified admin session. record_admin_activity refuses an actor that is
-- not an active admin_users row, so a deactivated administrator cannot
-- be made to appear to have decided something.

-- ── THE SEAL ──────────────────────────────────────────────────
create or replace function public.admin_set_withdrawal_seal_state(
  p_actor_user_id uuid,
  p_withdrawal_id uuid,
  p_seal_state    text
)
returns jsonb
language plpgsql
volatile
security definer set search_path = ''
as $$
declare
  v_case public.withdrawal_requests;
begin
  if p_seal_state not in ('sealed_unopened', 'opened_seal_broken') then
    return pg_catalog.jsonb_build_object('result', 'seal_state_unknown');
  end if;

  update public.withdrawal_requests
     set seal_state = p_seal_state,
         case_state = case when p_seal_state = 'opened_seal_broken'
                           then 'opened_item_review' else case_state end,
         updated_at = pg_catalog.now()
   where id = p_withdrawal_id
  returning * into v_case;

  if not found then
    return pg_catalog.jsonb_build_object('result', 'not_found');
  end if;

  perform public.record_admin_activity(
    p_actor_user_id, 'customer_rights', 'withdrawal.seal_state', 'withdrawal',
    p_withdrawal_id::text, 'Zustand der Ware erfasst', gen_random_uuid(),
    pg_catalog.jsonb_build_object('seal_state', p_seal_state)
  );

  return pg_catalog.jsonb_build_object('result', 'set', 'seal_state', v_case.seal_state);
end;
$$;

-- ── WHETHER THE GOODS MUST COME BACK ──────────────────────────
--
-- A DECISION, never a consequence of the seal. A broken seal does not
-- automatically demand a return: sometimes the cheapest and kindest
-- answer is to let the customer keep an opened tin.
create or replace function public.admin_set_withdrawal_return_requirement(
  p_actor_user_id uuid,
  p_withdrawal_id uuid,
  p_requirement   text
)
returns jsonb
language plpgsql
volatile
security definer set search_path = ''
as $$
declare
  v_case public.withdrawal_requests;
begin
  if p_requirement not in ('return_requested', 'return_not_required') then
    return pg_catalog.jsonb_build_object('result', 'requirement_unknown');
  end if;

  update public.withdrawal_requests
     set return_requirement = p_requirement,
         case_state = case when p_requirement = 'return_requested'
                           then 'awaiting_return' else 'approved' end,
         updated_at = pg_catalog.now()
   where id = p_withdrawal_id
  returning * into v_case;

  if not found then
    return pg_catalog.jsonb_build_object('result', 'not_found');
  end if;

  perform public.record_admin_activity(
    p_actor_user_id, 'customer_rights', 'withdrawal.return_requirement', 'withdrawal',
    p_withdrawal_id::text, 'Rücksendepflicht entschieden', gen_random_uuid(),
    pg_catalog.jsonb_build_object('return_requirement', p_requirement)
  );

  return pg_catalog.jsonb_build_object('result', 'set', 'return_requirement', v_case.return_requirement);
end;
$$;

-- ── THE RETURN ITSELF ─────────────────────────────────────────
--
-- Proof of dispatch and actual arrival are separate facts and separate
-- calls, because BGB 357 Abs. 4 makes EITHER of them enough to end our
-- right to withhold the money.
create or replace function public.admin_record_withdrawal_return(
  p_actor_user_id uuid,
  p_withdrawal_id uuid,
  p_event         text,
  p_at            timestamptz default null
)
returns jsonb
language plpgsql
volatile
security definer set search_path = ''
as $$
declare
  v_case public.withdrawal_requests;
  v_at   timestamptz := coalesce(p_at, pg_catalog.now());
begin
  if p_event not in ('dispatch_proof', 'received') then
    return pg_catalog.jsonb_build_object('result', 'event_unknown');
  end if;
  if v_at > pg_catalog.now() then
    return pg_catalog.jsonb_build_object('result', 'timestamp_in_future');
  end if;

  select * into v_case from public.withdrawal_requests where id = p_withdrawal_id for update;
  if not found then
    return pg_catalog.jsonb_build_object('result', 'not_found');
  end if;

  if p_event = 'dispatch_proof' then
    if v_case.return_dispatch_proof_at is not null then
      return pg_catalog.jsonb_build_object('result', 'unchanged');
    end if;
    update public.withdrawal_requests
       set return_dispatch_proof_at = v_at,
           case_state               = 'return_in_transit',
           updated_at               = pg_catalog.now()
     where id = p_withdrawal_id
    returning * into v_case;
  else
    if v_case.return_received_at is not null then
      return pg_catalog.jsonb_build_object('result', 'unchanged');
    end if;
    update public.withdrawal_requests
       set return_received_at = v_at,
           case_state         = 'return_received',
           updated_at         = pg_catalog.now()
     where id = p_withdrawal_id
    returning * into v_case;
  end if;

  perform public.record_admin_activity(
    p_actor_user_id, 'customer_rights', 'withdrawal.return_' || p_event, 'withdrawal',
    p_withdrawal_id::text, 'Rücksendung erfasst', gen_random_uuid(),
    pg_catalog.jsonb_build_object('event', p_event)
  );

  return pg_catalog.jsonb_build_object('result', 'recorded', 'case_state', v_case.case_state);
end;
$$;

-- ── WERTERSATZ: THE DECISION, BOUNDED IN SQL ──────────────────
--
-- THE CEILING IS COMPUTED HERE, from the price the plan froze at
-- purchase, and is not accepted from the caller. An administrator may
-- confirm the proposal or reduce it; raising it above the goods' frozen
-- retail value is refused by the database, so no route, no screen and no
-- future script can do it either.
--
-- Sealed goods have a ceiling of zero, which is the same rule stated as
-- arithmetic rather than as a special case.
create or replace function public.admin_confirm_withdrawal_value_loss(
  p_actor_user_id uuid,
  p_withdrawal_id uuid,
  p_confirmed_cents integer
)
returns jsonb
language plpgsql
volatile
security definer set search_path = ''
as $$
declare
  v_case      public.withdrawal_requests;
  v_plan      public.annual_plans;
  v_ceiling   integer;
begin
  if p_confirmed_cents is null or p_confirmed_cents < 0 then
    return pg_catalog.jsonb_build_object('result', 'invalid_amount');
  end if;

  select * into v_case from public.withdrawal_requests where id = p_withdrawal_id for update;
  if not found then
    return pg_catalog.jsonb_build_object('result', 'not_found');
  end if;

  if v_case.seal_state is null then
    return pg_catalog.jsonb_build_object('result', 'seal_state_unknown');
  end if;

  if v_case.seal_state = 'sealed_unopened' then
    v_ceiling := 0;
  else
    if v_case.resolved_annual_plan_id is null then
      return pg_catalog.jsonb_build_object('result', 'no_price_snapshot');
    end if;
    select * into v_plan from public.annual_plans where id = v_case.resolved_annual_plan_id;
    if not found then
      return pg_catalog.jsonb_build_object('result', 'no_price_snapshot');
    end if;
    -- THE FROZEN RETAIL PRICE OF ONE PACKAGE. Never a live catalogue
    -- read, so a historical case is never re-priced by a later change.
    v_ceiling := v_plan.catalog_unit_gross_cents;
  end if;

  if p_confirmed_cents > v_ceiling then
    return pg_catalog.jsonb_build_object(
      'result', 'above_ceiling',
      'ceiling_cents', v_ceiling
    );
  end if;

  update public.withdrawal_requests
     set suggested_value_loss_cents = v_ceiling,
         confirmed_value_loss_cents = p_confirmed_cents,
         value_loss_confirmed_by    = p_actor_user_id,
         value_loss_confirmed_at    = pg_catalog.now(),
         updated_at                 = pg_catalog.now()
   where id = p_withdrawal_id
  returning * into v_case;

  perform public.record_admin_activity(
    p_actor_user_id, 'customer_rights', 'withdrawal.value_loss', 'withdrawal',
    p_withdrawal_id::text, 'Wertersatz bestätigt', gen_random_uuid(),
    pg_catalog.jsonb_build_object('confirmed_cents', p_confirmed_cents, 'ceiling_cents', v_ceiling)
  );

  return pg_catalog.jsonb_build_object(
    'result', 'confirmed',
    'confirmed_cents', v_case.confirmed_value_loss_cents,
    'ceiling_cents', v_ceiling
  );
end;
$$;

-- ── THE REFUND, PREPARED BUT NOT PAID ─────────────────────────
--
-- IT COMPUTES THE AMOUNT. No caller supplies one, and there is no
-- parameter for it - the figure is the plan's own total minus the
-- confirmed value loss, floored at zero.
--
-- IT DOES NOT MOVE MONEY. This marks a case approved_for_payout and
-- stamps one refund_operation_id; the Stripe call is a separate,
-- explicit step outside the database. The unique index on
-- refund_operation_id is what makes a second approval impossible, so a
-- double-click cannot become a double refund.
create or replace function public.admin_approve_withdrawal_refund(
  p_actor_user_id uuid,
  p_withdrawal_id uuid
)
returns jsonb
language plpgsql
volatile
security definer set search_path = ''
as $$
declare
  v_case   public.withdrawal_requests;
  v_plan   public.annual_plans;
  v_paid   integer;
  v_loss   integer;
  v_refund integer;
begin
  select * into v_case from public.withdrawal_requests where id = p_withdrawal_id for update;
  if not found then
    return pg_catalog.jsonb_build_object('result', 'not_found');
  end if;

  if v_case.refund_state in ('approved_for_payout', 'executed') then
    return pg_catalog.jsonb_build_object(
      'result', 'already_approved',
      'refund_amount_cents', v_case.refund_amount_cents,
      'refund_operation_id', v_case.refund_operation_id
    );
  end if;

  -- A case that may still be refused is not ready to be paid.
  if v_case.timeliness = 'late' then
    return pg_catalog.jsonb_build_object('result', 'case_is_late');
  end if;

  -- BGB 357 Abs. 4: the goods, or proof they were sent - unless we never
  -- asked for them back.
  if v_case.return_requirement = 'return_requested'
     and v_case.return_received_at is null
     and v_case.return_dispatch_proof_at is null then
    return pg_catalog.jsonb_build_object('result', 'return_outstanding');
  end if;

  if v_case.resolved_annual_plan_id is null then
    return pg_catalog.jsonb_build_object('result', 'no_contract_resolved');
  end if;

  select * into v_plan from public.annual_plans where id = v_case.resolved_annual_plan_id;
  if not found then
    return pg_catalog.jsonb_build_object('result', 'no_contract_resolved');
  end if;

  -- EVERYTHING PAID, INCLUDING THE OUTBOUND SHIPPING. BGB 357 Abs. 1
  -- repays the delivery costs too; there is no rule here that keeps them.
  v_paid   := v_plan.total_gross_cents;
  v_loss   := coalesce(v_case.confirmed_value_loss_cents, 0);
  v_refund := greatest(0, v_paid - v_loss);

  update public.withdrawal_requests
     set refund_amount_cents = v_refund,
         refund_state        = 'approved_for_payout',
         refund_operation_id = coalesce(refund_operation_id, gen_random_uuid()),
         case_state          = 'refund_pending',
         updated_at          = pg_catalog.now()
   where id = p_withdrawal_id
  returning * into v_case;

  perform public.record_admin_activity(
    p_actor_user_id, 'customer_rights', 'withdrawal.refund_approved', 'withdrawal',
    p_withdrawal_id::text, 'Erstattung freigegeben', v_case.refund_operation_id,
    pg_catalog.jsonb_build_object(
      'paid_cents', v_paid, 'value_loss_cents', v_loss, 'refund_cents', v_refund
    )
  );

  return pg_catalog.jsonb_build_object(
    'result', 'approved',
    'paid_cents', v_paid,
    'value_loss_cents', v_loss,
    'refund_amount_cents', v_refund,
    'refund_operation_id', v_case.refund_operation_id
  );
end;
$$;

-- ── COMPLAINTS AND TERMINATIONS ───────────────────────────────
create or replace function public.admin_advance_complaint(
  p_actor_user_id uuid,
  p_complaint_id  uuid,
  p_case_state    text,
  p_internal_note text default null
)
returns jsonb
language plpgsql
volatile
security definer set search_path = ''
as $$
declare
  v_row public.complaint_requests;
begin
  if p_case_state not in ('under_review', 'evidence_requested', 'remedy_offered',
                          'replacement_sent', 'refunded', 'rejected', 'closed') then
    return pg_catalog.jsonb_build_object('result', 'state_unknown');
  end if;

  update public.complaint_requests
     set case_state    = p_case_state,
         internal_note = coalesce(p_internal_note, internal_note),
         updated_at    = pg_catalog.now()
   where id = p_complaint_id
  returning * into v_row;

  if not found then
    return pg_catalog.jsonb_build_object('result', 'not_found');
  end if;

  perform public.record_admin_activity(
    p_actor_user_id, 'customer_rights', 'complaint.advanced', 'complaint',
    p_complaint_id::text, 'Reklamation bearbeitet', gen_random_uuid(),
    pg_catalog.jsonb_build_object('case_state', p_case_state)
  );

  return pg_catalog.jsonb_build_object('result', 'advanced', 'case_state', v_row.case_state);
end;
$$;

create or replace function public.admin_review_termination(
  p_actor_user_id uuid,
  p_termination_id uuid,
  p_case_state    text,
  p_internal_note text default null
)
returns jsonb
language plpgsql
volatile
security definer set search_path = ''
as $$
declare
  v_row public.termination_requests;
begin
  if p_case_state not in ('under_review', 'acknowledged_ends_automatically',
                          'scheduled', 'effective', 'rejected', 'closed') then
    return pg_catalog.jsonb_build_object('result', 'state_unknown');
  end if;

  update public.termination_requests
     set case_state    = p_case_state,
         internal_note = coalesce(p_internal_note, internal_note),
         updated_at    = pg_catalog.now()
   where id = p_termination_id
  returning * into v_row;

  if not found then
    return pg_catalog.jsonb_build_object('result', 'not_found');
  end if;

  perform public.record_admin_activity(
    p_actor_user_id, 'customer_rights', 'termination.reviewed', 'termination',
    p_termination_id::text, 'Kündigung geprüft', gen_random_uuid(),
    pg_catalog.jsonb_build_object('case_state', p_case_state)
  );

  return pg_catalog.jsonb_build_object('result', 'reviewed', 'case_state', v_row.case_state);
end;
$$;

-- ── PURCHASE RESTRICTIONS ─────────────────────────────────────
--
-- Created by a named administrator or not at all. There is no trigger,
-- no counter and no automatic path into this table anywhere in the
-- migration - exercising a statutory right may not cost a customer
-- their ability to shop.
create or replace function public.admin_create_purchase_restriction(
  p_actor_user_id  uuid,
  p_user_id        uuid,
  p_scope          text,
  p_reason_category text,
  p_internal_note  text default null,
  p_expires_at     timestamptz default null
)
returns jsonb
language plpgsql
volatile
security definer set search_path = ''
as $$
declare
  v_row public.purchase_restrictions;
  v_expired public.purchase_restrictions;
begin
  if p_scope not in ('annual_plan', 'recurring_subscription', 'all_new_plan_purchases') then
    return pg_catalog.jsonb_build_object('result', 'scope_unknown');
  end if;
  if p_reason_category not in ('repeated_withdrawal_pattern', 'payment_abuse',
                               'chargeback_history', 'manual_review', 'other') then
    return pg_catalog.jsonb_build_object('result', 'reason_unknown');
  end if;
  if p_expires_at is not null and p_expires_at <= pg_catalog.now() then
    return pg_catalog.jsonb_build_object('result', 'expiry_in_past');
  end if;

  -- AN EXPIRED ROW STILL OCCUPIES THE SLOT.
  --
  -- purchase_restrictions_one_active_per_scope_key is partial on
  -- active = true and cannot also test expiry, because a partial index
  -- predicate must be IMMUTABLE and now() is not. So a restriction that
  -- lapsed last month still holds the (user_id, scope) slot.
  --
  -- That never blocked the CUSTOMER - lib/purchaseRestrictions.ts reads
  -- an expired row as not live, so their purchases go through - but it
  -- would block an ADMINISTRATOR from recording a new restriction for
  -- the same scope, for ever, with a row that no longer does anything.
  --
  -- So a lapsed row is closed out explicitly, with its own audit entry
  -- and this administrator's name on it, and then the new one is
  -- written. Nothing is deleted, nothing is silently reused, and the
  -- history still shows both. A row that has NOT expired is left alone
  -- and the caller is told it is already restricted.
  update public.purchase_restrictions
     set active    = false,
         lifted_at = pg_catalog.now(),
         lifted_by = p_actor_user_id
   where user_id = p_user_id
     and scope   = p_scope
     and active  = true
     and expires_at is not null
     and expires_at <= pg_catalog.now()
  returning * into v_expired;

  if found then
    perform public.record_admin_activity(
      p_actor_user_id, 'customer_rights', 'restriction.expired_closed', 'customer',
      p_user_id::text, 'Abgelaufene Kaufsperre geschlossen', gen_random_uuid(),
      pg_catalog.jsonb_build_object('scope', p_scope, 'expired_at', v_expired.expires_at)
    );
  end if;

  begin
    insert into public.purchase_restrictions
      (user_id, scope, reason_category, internal_note, created_by, expires_at)
    values
      (p_user_id, p_scope, p_reason_category, p_internal_note, p_actor_user_id, p_expires_at)
    returning * into v_row;
  exception
    when unique_violation then
      return pg_catalog.jsonb_build_object('result', 'already_restricted');
  end;

  perform public.record_admin_activity(
    p_actor_user_id, 'customer_rights', 'restriction.created', 'customer',
    p_user_id::text, 'Kaufsperre gesetzt', gen_random_uuid(),
    -- The CATEGORY, never the note: the note is prose about a person.
    pg_catalog.jsonb_build_object('scope', p_scope, 'reason_category', p_reason_category)
  );

  return pg_catalog.jsonb_build_object('result', 'created', 'restriction_id', v_row.id);
end;
$$;

create or replace function public.admin_lift_purchase_restriction(
  p_actor_user_id  uuid,
  p_restriction_id uuid
)
returns jsonb
language plpgsql
volatile
security definer set search_path = ''
as $$
declare
  v_row public.purchase_restrictions;
begin
  update public.purchase_restrictions
     set active    = false,
         lifted_at = pg_catalog.now(),
         lifted_by = p_actor_user_id
   where id = p_restriction_id and active = true
  returning * into v_row;

  if not found then
    return pg_catalog.jsonb_build_object('result', 'not_found_or_already_lifted');
  end if;

  perform public.record_admin_activity(
    p_actor_user_id, 'customer_rights', 'restriction.lifted', 'customer',
    v_row.user_id::text, 'Kaufsperre aufgehoben', gen_random_uuid(),
    pg_catalog.jsonb_build_object('scope', v_row.scope)
  );

  return pg_catalog.jsonb_build_object('result', 'lifted');
end;
$$;

-- ── AND NONE OF THEM IS REACHABLE FROM A BROWSER ──────────────

revoke all on function public.admin_set_withdrawal_seal_state(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.admin_set_withdrawal_return_requirement(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.admin_record_withdrawal_return(uuid, uuid, text, timestamptz) from public, anon, authenticated;
revoke all on function public.admin_confirm_withdrawal_value_loss(uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.admin_approve_withdrawal_refund(uuid, uuid) from public, anon, authenticated;
revoke all on function public.admin_advance_complaint(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.admin_review_termination(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.admin_create_purchase_restriction(uuid, uuid, text, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.admin_lift_purchase_restriction(uuid, uuid) from public, anon, authenticated;

grant execute on function public.admin_set_withdrawal_seal_state(uuid, uuid, text) to service_role;
grant execute on function public.admin_set_withdrawal_return_requirement(uuid, uuid, text) to service_role;
grant execute on function public.admin_record_withdrawal_return(uuid, uuid, text, timestamptz) to service_role;
grant execute on function public.admin_confirm_withdrawal_value_loss(uuid, uuid, integer) to service_role;
grant execute on function public.admin_approve_withdrawal_refund(uuid, uuid) to service_role;
grant execute on function public.admin_advance_complaint(uuid, uuid, text, text) to service_role;
grant execute on function public.admin_review_termination(uuid, uuid, text, text) to service_role;
grant execute on function public.admin_create_purchase_restriction(uuid, uuid, text, text, text, timestamptz) to service_role;
grant execute on function public.admin_lift_purchase_restriction(uuid, uuid) to service_role;


-- 11. WHY THIS MAY BE APPLIED BEFORE ITS CODE ──────────────────
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
-- 12. VERIFY - READ ONLY, AFTER APPLYING. NOTHING BELOW RUNS.
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
