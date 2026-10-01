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

-- ── WHAT STRIPE SAID, AND WHEN ────────────────────────────────
--
-- The payout happens at Stripe, not here, so 'executed' is a claim
-- about something that happened OUTSIDE this database. A claim with no
-- evidence is worthless, so the state cannot be reached without the
-- provider's own identifier for the refund.
--
-- refund_provider_reference is that identifier - re_... from Stripe. It
-- is written by exactly one function, after the API call returned, and
-- the CHECK below makes the state and the evidence inseparable: no row
-- can say 'executed' without both a timestamp and a reference, and no
-- row that never executed can carry either.
--
-- refund_failure_reason holds the provider's error when the call did
-- not succeed, so a failed payout is a state an administrator can see
-- and retry rather than a silence.

alter table public.withdrawal_requests
  add column if not exists refund_provider_reference text
    check (refund_provider_reference is null
           or char_length(btrim(refund_provider_reference)) > 0);

alter table public.withdrawal_requests
  add column if not exists refund_failure_reason text;

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'withdrawal_requests_refund_execution_shape_check'
      and conrelid = 'public.withdrawal_requests'::regclass
  ) then
    alter table public.withdrawal_requests
      add constraint withdrawal_requests_refund_execution_shape_check
      check (
        (refund_state = 'executed'
         and refund_executed_at is not null
         and refund_provider_reference is not null
         and refund_amount_cents is not null)
        or
        (refund_state <> 'executed'
         and refund_executed_at is null
         and refund_provider_reference is null)
      );
  end if;
end
$$;

-- ── WHICH GOODS, AND HOW MANY OF THEM ─────────────────────────
--
-- MIGRATION 018 GAVE THE CONSUMER TWO SCOPES AND ONE FREE-TEXT BOX.
-- scope is 'whole_order' or 'partial', and for a partial case the form
-- requires scope_note - which the customer types by hand:
--
--   "z. B. 1x GLOA Matcha 50 g"
--
-- That is the right thing to ask a person and the wrong thing to base
-- money on. It is a sentence, not a foreign key: it carries no order
-- item id, no quantity a database can read, and no defence against
-- "alles" or a typo. NOTHING IN THIS FILE PARSES IT. A refund derived
-- from customer prose would be a refund the consumer computed.
--
-- So a partial case gets a SECOND, STRUCTURED statement, made by an
-- administrator through admin_resolve_withdrawal_item and stored here:
-- an authoritative order_items reference and a quantity. The writer
-- proves the line actually belongs to the resolved order and that the
-- quantity does not exceed what was sold, so even the administrator
-- cannot point this at another customer's purchase or at more units
-- than exist.
--
-- THE SAME COLUMNS SERVE THE WERTERSATZ CEILING. A line reading
-- "30 g Matcha x 2" against a case-level seal_state of
-- 'opened_seal_broken' does not say whether both units were opened or
-- one - and multiplying a ceiling by two would charge the consumer for
-- a sealed package. The resolution is how a human states which units
-- the case is actually about.
--
-- on delete restrict, deliberately. order_items cascades from orders,
-- so this reference is what stops a resolved case's evidence being
-- deleted out from under it.

alter table public.withdrawal_requests
  add column if not exists resolved_order_item_id uuid
    references public.order_items(id) on delete restrict;

alter table public.withdrawal_requests
  add column if not exists resolved_item_quantity integer
    check (resolved_item_quantity is null or resolved_item_quantity > 0);

-- THE ONE THING ABOUT A PARTIAL REFUND THAT IS NOT ARITHMETIC.
--
-- BGB 357 Abs. 1 repays the delivery costs. For a WHOLE-ORDER
-- withdrawal that is settled and needs no decision: the order's own
-- total_gross_cents already contains the outbound shipping, and the
-- whole of it goes back.
--
-- A PARTIAL withdrawal is genuinely unsettled. The consumer keeps part
-- of the order, that part would have been shipped anyway, and whether
-- the outbound cost is still owed back is a question about THIS
-- contract and THIS order - not something derivable from any column.
--
-- This migration therefore does not decide it and does not guess. It
-- records a human's decision as one of exactly two values, and then
-- derives the money from a purchase-time snapshot either way. Nobody
-- types an amount; the choice is between refunding the historic
-- orders.shipping_gross_cents and refunding none of it.
--
-- Only meaningful for a partial case, and the CHECK below says so.

alter table public.withdrawal_requests
  add column if not exists partial_shipping_treatment text
    check (partial_shipping_treatment is null
           or partial_shipping_treatment in ('refund_outbound_shipping',
                                             'retain_outbound_shipping'));

alter table public.withdrawal_requests
  add column if not exists item_resolution_by uuid
    references public.admin_users(user_id) on delete restrict;

alter table public.withdrawal_requests
  add column if not exists item_resolution_at timestamptz;

-- THE RESOLUTION MOVES AS ONE FACT.
--
-- Same shape as the Wertersatz decision triple above: either nobody has
-- resolved the goods, or somebody has and is named with the moment they
-- did it. A half-written resolution would let a payout be derived from
-- an item nobody signed for.
do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'withdrawal_requests_item_resolution_shape_check'
      and conrelid = 'public.withdrawal_requests'::regclass
  ) then
    alter table public.withdrawal_requests
      add constraint withdrawal_requests_item_resolution_shape_check
      check (
        (resolved_order_item_id is null
         and resolved_item_quantity is null
         and item_resolution_by is null
         and item_resolution_at is null)
        or
        (resolved_order_item_id is not null
         and resolved_item_quantity is not null
         and item_resolution_by is not null
         and item_resolution_at is not null)
      );
  end if;
end
$$;

-- AND THE SHIPPING DECISION EXISTS ONLY WHERE THERE IS ONE TO MAKE.
--
-- A whole-order case carrying a retention decision would be a
-- contradiction: its refund is the order total, which already settles
-- the shipping. Refusing the combination in the database means no route
-- can create a row whose two halves disagree about what kind of case
-- it is.
do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'withdrawal_requests_partial_shipping_scope_check'
      and conrelid = 'public.withdrawal_requests'::regclass
  ) then
    alter table public.withdrawal_requests
      add constraint withdrawal_requests_partial_shipping_scope_check
      check (partial_shipping_treatment is null or scope = 'partial');
  end if;
end
$$;

-- ── AND THE MAIL THAT SAYS THE MONEY ACTUALLY WENT ────────────
--
-- Six customer mails belong to this feature, and two of them are about
-- the refund. They are not the same message and they are not sent at
-- the same moment:
--
--   "Deine Erstattung ist veranlasst"  at APPROVAL. True then: a human
--                                      decided, and the amount is fixed.
--   "Deine Erstattung ist durchgeführt" after STRIPE CONFIRMED and this
--                                      database persisted 'executed'.
--
-- The second one is a claim about the outside world, so it must not be
-- sendable until the outside world has answered. What makes that
-- structural rather than careful is the claim below: it can only be won
-- from refund_state = 'executed', a state that itself cannot exist
-- without a provider reference.
--
-- THE SHAPE IS THE ONE THIS REPOSITORY ALREADY USES for its six other
-- transactional senders - a status column and a sent-at instant, claimed
-- by conditional UPDATE, exactly as migrations 017, 026, 027, 030, 031
-- and 033 do. No new email architecture, and deliberately NOT the
-- consumer's own confirmation_status, which belongs to a different event
-- (their declaration arriving) and would be destroyed by reuse.
--
-- 'sending' is a lease, 'sent' is terminal, 'failed' is retryable, and
-- NULL means this case was never part of the flow - which is what keeps
-- every historical row out of it.
--
-- ONE DIFFERENCE FROM MIGRATION 033, AND IT MATTERS. There, 'sent' is
-- re-claimable because a refund TOTAL can grow and a second, larger
-- refund is a new fact deserving a new message; a watermark column
-- decides. Here a case has exactly one payout - the unique index on
-- refund_operation_id guarantees it - so there is no second fact to
-- announce, no watermark to compare, and 'sent' is final. Making it
-- re-claimable would only ever produce a duplicate.

alter table public.withdrawal_requests
  add column if not exists refund_completed_email_status text
    check (refund_completed_email_status is null
           or refund_completed_email_status in ('sending', 'sent', 'failed'));

alter table public.withdrawal_requests
  add column if not exists refund_completed_email_sent_at timestamptz;

-- A sent-at instant exists exactly when the mail was sent. 'sending'
-- and 'failed' have not sent anything, so neither may carry one.
do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'withdrawal_requests_refund_completed_email_shape_check'
      and conrelid = 'public.withdrawal_requests'::regclass
  ) then
    alter table public.withdrawal_requests
      add constraint withdrawal_requests_refund_completed_email_shape_check
      check (
        (refund_completed_email_status = 'sent'
         and refund_completed_email_sent_at is not null)
        or
        (refund_completed_email_status is distinct from 'sent'
         and refund_completed_email_sent_at is null)
      );
  end if;
end
$$;

-- ── THE FREEZE ────────────────────────────────────────────────
--
-- When a protected withdrawal is open, the annual plan stops producing
-- new deliveries. Recorded as an instant rather than a boolean so the
-- moment is auditable, and so setting it twice is visibly the same
-- fact rather than a second event.

alter table public.withdrawal_requests
  add column if not exists deliveries_frozen_at timestamptz;

-- ── AND THE STOP THAT DOES NOT LIFT ───────────────────────────
--
-- A FREEZE IS TEMPORARY. It holds while a case is open and lets go
-- when the case ends - which is right for a case that turns out to be
-- late, and catastrophic for one that turns out to be VALID. A
-- customer whose withdrawal was accepted and refunded must not start
-- receiving boxes again because the case reached a terminal state.
--
-- So a valid outcome writes a SECOND, separate instant. Nothing clears
-- it: annual_plan_delivery_freeze_active treats it as stopping the
-- plan regardless of case_state, so 'refunded' and 'closed' - the very
-- states that end a freeze - cannot resume anything once this is set.
--
-- Two columns rather than one because they answer different questions.
-- deliveries_frozen_at says "we are holding while we work this out".
-- This says "the contract was undone; there is nothing left to send".

alter table public.withdrawal_requests
  add column if not exists deliveries_permanently_stopped_at timestamptz;

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
  refund_provider_reference,
  refund_failure_reason,
  deliveries_frozen_at,
  deliveries_permanently_stopped_at,
  resolved_order_item_id,
  resolved_item_quantity,
  partial_shipping_treatment,
  item_resolution_by,
  item_resolution_at,
  refund_completed_email_status,
  refund_completed_email_sent_at,
  idempotency_key,
  internal_note,
  updated_at
) on public.withdrawal_requests to service_role;

-- WHAT THIS GRANT IS, AND WHAT IT IS NOT.
--
-- It is a CEILING, not the mechanism. Every write in this file goes
-- through a SECURITY DEFINER function, which runs as the function's
-- owner and would work whether or not service_role held these columns.
-- The list exists so that the blast radius of a bug anywhere in the
-- consumer-rights code is these columns and no others - and so that an
-- operator reading it learns exactly which facts the server may touch.
--
-- Which is why it enumerates every column the case machinery advances,
-- including the payout evidence and the completion-mail state. A list
-- that silently omitted some of them would still be safe, and would
-- stop being documentation.
--
-- The seven declaration columns from migration 018 are still absent, and
-- that absence is load-bearing: customer_name, order_reference,
-- contact_email, scope, scope_note, customer_note and submitted_at
-- cannot be rewritten by any code path, so what the consumer actually
-- declared stays what they declared.

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
      and (
        -- THE TEMPORARY HOLD, while the case is still being worked.
        (w.deliveries_frozen_at is not null
         and w.case_state not in ('refunded', 'rejected_late', 'closed'))
        or
        -- THE PERMANENT STOP, which no case_state lifts. A valid
        -- withdrawal that has been refunded and closed still stops the
        -- plan - those two states end the hold above, and this is what
        -- keeps the boxes from resuming anyway.
        w.deliveries_permanently_stopped_at is not null
      )
  );
$$;

revoke all on function public.annual_plan_delivery_freeze_active(uuid) from public;
revoke all on function public.annual_plan_delivery_freeze_active(uuid) from anon;
revoke all on function public.annual_plan_delivery_freeze_active(uuid) from authenticated;
grant execute on function public.annual_plan_delivery_freeze_active(uuid) to service_role;

-- Migration 039's queue, re-stated with TWO changes.
--
-- Everything else is byte-for-byte what 039 wrote: the same active and
-- not-refunded plan filter, the same order_id/fulfilled_at exclusions,
-- the same six-hour lease, the same ordering, the same
-- least(greatest(...)) clamp, and the same `for update of d skip
-- locked` that keeps this function and 039's section 9 from deadlocking.
-- Re-created rather than patched because a SQL function body cannot be
-- altered in place.
--
-- (1) THE FREEZE PREDICATE, above.
--
-- (2) AT MOST ONE DELIVERY PER PLAN PER PASS - the no-catch-up rule.
--
-- 039's queue took every due row. That is correct on a healthy day,
-- where a plan has at most one, but it becomes a BURST the moment a
-- plan has been held: a withdrawal frozen across three monthly dates
-- and then rejected as late would leave three rows with scheduled_for
-- in the past, and the next worker pass would mint all three orders at
-- once - three boxes and three charges arriving together.
--
-- The added `not exists` keeps only the EARLIEST UNFINISHED past-due
-- row per plan: a row qualifies when no earlier row of the same plan is
-- still open, under exactly the (scheduled_for, delivery_number, id)
-- order 039 already used. So a plan contributes at most one row per
-- pass, and the row it contributes is the one 039 would have taken
-- first anyway.
--
-- "UNFINISHED" IS 'scheduled' OR 'claimed', AND THAT WORDING MATTERS.
-- The obvious version of this predicate reuses the DUE condition above,
-- and it is wrong: a row claimed one second ago is no longer due (its
-- six-hour lease is live), so it would drop out of the comparison and
-- let the NEXT row through. Two worker passes in a row would then mint
-- two orders, which is the exact burst this rule exists to prevent. A
-- real database demonstrated it. 'cancelled' and 'fulfilled' rows are
-- finished and correctly do not block anything.
--
-- So the rule is really ONE DELIVERY IN FLIGHT PER PLAN: the next one
-- is minted when its predecessor is fulfilled, or when a stuck claim's
-- lease expires and that row becomes claimable again itself.
--
-- IT IS WRITTEN AS A PREDICATE AND NOT AS `distinct on` BECAUSE
-- POSTGRES REFUSES THE LATTER HERE: "FOR UPDATE is not allowed with
-- DISTINCT clause". The lease depends on `for update of d skip locked`,
-- so the de-duplication had to go into the WHERE clause instead. A real
-- database refused the first version of this; the note is here so
-- nobody reintroduces it.
--
-- The customer is still owed the other rows and still gets them: the
-- worker runs again, and the next pass takes the next one. The backlog
-- drains at the worker's cadence instead of arriving in one delivery.
--
-- WHAT THIS DELIBERATELY DOES NOT DO: it does not cancel a delivery,
-- does not move a scheduled_for, and does not re-anchor the calendar.
-- Migration 069's monthly dates stay exactly where activation froze
-- them, and a rejected-late customer keeps every box they paid for.
-- The only thing that changes is how many can be minted in one pass.

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
      -- MIGRATION 070. A plan with a protected, unresolved withdrawal -
      -- or one permanently stopped by a valid one - is not due for
      -- anything.
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
      -- MIGRATION 070. ONE DELIVERY IN FLIGHT PER PLAN: no EARLIER row
      -- of this plan is still unfinished. Note 'claimed' is included -
      -- a live lease blocks the next row, or two passes in a row would
      -- drain a backlog that took a freeze to create.
      and not exists (
        select 1
        from public.annual_plan_deliveries e
        where e.annual_plan_id = d.annual_plan_id
          and e.state in ('scheduled', 'claimed')
          and e.order_id is null
          and e.fulfilled_at is null
          and e.scheduled_for <= pg_catalog.now()
          and (e.scheduled_for, e.delivery_number, e.id)
            < (d.scheduled_for, d.delivery_number, d.id)
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
--
-- ══════════════════════════════════════════════════════════════
-- WHICH STATES EACH WRITER MAY MUTATE, AND WHY
-- ══════════════════════════════════════════════════════════════
--
-- A case has two lifecycles that must both be respected: the CASE
-- lifecycle (case_state) and the PAYOUT lifecycle (refund_state). The
-- five writers below record ordinary case FACTS - the seal, whether the
-- goods must come back, that they came back, which goods the case is
-- about, and the Wertersatz. Every one of them therefore obeys the same
-- two guards, in the same order, before touching anything:
--
--   case_state in ('refund_pending', 'refunded',
--                  'rejected_late', 'closed')      -> case_closed
--   refund_state in ('approved_for_payout',
--                    'executed', 'failed')         -> refund_already_approved
--
-- THE FIRST GUARD EXISTS BECAUSE A DECIDED CASE IS A RECORD, NOT A
-- DRAFT. Without it, admin_set_withdrawal_seal_state could set
-- case_state = 'opened_item_review' on a case that was refunded weeks
-- ago; admin_set_withdrawal_return_requirement could move a closed case
-- to 'awaiting_return'; and admin_record_withdrawal_return could push a
-- refunded one back to 'return_in_transit'. Each of those reopens a
-- finished statutory case by accident - the operator was recording a
-- late fact, not trying to undo an outcome - and the case then sits in
-- the desk looking live, with money already gone.
--
-- THE SECOND GUARD EXISTS BECAUSE THESE FACTS ARE THE PAYOUT BASIS.
-- admin_approve_withdrawal_refund derives its figure from the seal, the
-- return requirement, the resolved item and the confirmed Wertersatz.
-- Once it has run, refund_amount_cents is fixed, refund_operation_id is
-- stamped, and the customer has been told an amount. Changing any input
-- afterwards would leave the row disagreeing with the money - and, once
-- Stripe has the idempotency key, disagreeing with the payment provider
-- too.
--
-- 'failed' IS INCLUDED IN THE PAYOUT LOCK, AND THAT IS DELIBERATE. A
-- declined card does not un-approve a refund: the money is still owed,
-- the amount still stands and the operation id is still the retry's
-- idempotency key. Re-cutting the basis while a retry is pending is how
-- the row and Stripe come to disagree about what was refunded. The
-- retry itself is unaffected - admin_record_withdrawal_refund_execution
-- accepts 'failed' precisely so a decline can be retried.
--
-- WHAT THE GUARDS DELIBERATELY DO NOT BLOCK. Everything an OPEN case
-- legitimately needs:
--
--   * the seal may be decided, and re-decided, during review
--   * the return requirement may be set and changed before payout
--   * dispatch proof and arrival may be recorded while the case is
--     awaiting a return, in transit, or overdue
--   * the resolved item and quantity may be corrected as often as an
--     operator needs, right up to approval
--   * the Wertersatz may be confirmed and reduced before approval
--
-- ONE HONEST CONSEQUENCE. Goods that arrive AFTER an early payout - BGB
-- 357 Abs. 4 permits paying on dispatch proof alone - can no longer be
-- recorded through admin_record_withdrawal_return, because that would
-- move a refund_pending case backwards. The arrival is a true fact and
-- belongs in internal_note; what it must not do is make a paid case
-- look unfinished.
--
-- THE PAYOUT WRITERS KEEP THEIR OWN GUARDS, which are about the payout
-- lifecycle rather than the case facts, and are not changed into this
-- shape: approval refuses an already-approved payout, and the execution
-- and failure writers refuse anything that is not awaiting one.

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

  -- READ AND LOCK FIRST. This used to be a blind UPDATE ... RETURNING,
  -- which cannot refuse a state it never looked at.
  select * into v_case from public.withdrawal_requests where id = p_withdrawal_id for update;
  if not found then
    return pg_catalog.jsonb_build_object('result', 'not_found');
  end if;

  if v_case.case_state in ('refund_pending', 'refunded', 'rejected_late', 'closed') then
    return pg_catalog.jsonb_build_object('result', 'case_closed',
                                         'case_state', v_case.case_state);
  end if;
  if v_case.refund_state in ('approved_for_payout', 'executed', 'failed') then
    return pg_catalog.jsonb_build_object('result', 'refund_already_approved',
                                         'refund_state', v_case.refund_state);
  end if;

  update public.withdrawal_requests
     set seal_state = p_seal_state,
         case_state = case when p_seal_state = 'opened_seal_broken'
                           then 'opened_item_review' else case_state end,
         updated_at = pg_catalog.now()
   where id = p_withdrawal_id
  returning * into v_case;

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

  -- READ AND LOCK FIRST, for the same reason as the seal writer: this
  -- sets case_state to 'awaiting_return' or 'approved', and doing that
  -- to a refunded or closed case reopens it.
  select * into v_case from public.withdrawal_requests where id = p_withdrawal_id for update;
  if not found then
    return pg_catalog.jsonb_build_object('result', 'not_found');
  end if;

  if v_case.case_state in ('refund_pending', 'refunded', 'rejected_late', 'closed') then
    return pg_catalog.jsonb_build_object('result', 'case_closed',
                                         'case_state', v_case.case_state);
  end if;
  if v_case.refund_state in ('approved_for_payout', 'executed', 'failed') then
    return pg_catalog.jsonb_build_object('result', 'refund_already_approved',
                                         'refund_state', v_case.refund_state);
  end if;

  update public.withdrawal_requests
     set return_requirement = p_requirement,
         case_state = case when p_requirement = 'return_requested'
                           then 'awaiting_return' else 'approved' end,
         updated_at = pg_catalog.now()
   where id = p_withdrawal_id
  returning * into v_case;

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

  -- A RETURN EVENT MOVES case_state to 'return_in_transit' or
  -- 'return_received'. On a decided case that is a reopening, and on a
  -- case whose payout is already approved it is a step backwards.
  if v_case.case_state in ('refund_pending', 'refunded', 'rejected_late', 'closed') then
    return pg_catalog.jsonb_build_object('result', 'case_closed',
                                         'case_state', v_case.case_state);
  end if;
  if v_case.refund_state in ('approved_for_payout', 'executed', 'failed') then
    return pg_catalog.jsonb_build_object('result', 'refund_already_approved',
                                         'refund_state', v_case.refund_state);
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

-- ── WHICH GOODS THIS CASE IS ACTUALLY ABOUT ───────────────────
--
-- The consumer's scope_note is a sentence. This is the structured
-- statement that replaces reading it: an administrator names an
-- order_items row and a quantity, and from then on both the Wertersatz
-- ceiling and a partial refund are derived from purchase-time snapshots
-- rather than from prose.
--
-- ══════════════════════════════════════════════════════════════
-- WHAT THE ADMINISTRATOR CANNOT DO HERE
-- ══════════════════════════════════════════════════════════════
--
-- POINT AT SOMEBODY ELSE'S PURCHASE. p_order_item_id is required to
-- belong to the case's OWN resolved_order_id. An item id from another
-- order - guessed, pasted or enumerated - returns item_not_in_order and
-- writes nothing.
--
-- CLAIM MORE UNITS THAN WERE SOLD. p_quantity is bounded by the line's
-- own quantity. Two units cannot be withdrawn from a line that sold one,
-- which is what stops a ceiling or a refund being inflated by arithmetic
-- rather than by a price.
--
-- SUPPLY AN AMOUNT. There is no money parameter. Every figure stays
-- derived, here as everywhere else in this migration.
--
-- DECIDE THE SHIPPING FOR A WHOLE-ORDER CASE. That question is already
-- settled by BGB 357 Abs. 1 and by the order total; offering a choice
-- would invent a decision the law does not leave open.
--
-- RE-CUT A DECIDED CASE. Once the money is approved or paid, the goods
-- this case was about are part of the record.
--
-- ── AND WHY IT IS ALLOWED TO BE RE-STATED BEFORE THEN ──────────
--
-- An operator who resolves the wrong line must be able to correct it, so
-- this overwrites while the case is still open and re-stamps the actor
-- and the moment. Each attempt is one audit entry, so the sequence of
-- corrections stays visible rather than being flattened to the last one.
create or replace function public.admin_resolve_withdrawal_item(
  p_actor_user_id uuid,
  p_withdrawal_id uuid,
  p_order_item_id uuid,
  p_quantity integer,
  p_shipping_treatment text default null
)
returns jsonb
language plpgsql
volatile
security definer set search_path = ''
as $$
declare
  v_case public.withdrawal_requests;
  v_item public.order_items;
begin
  select * into v_case from public.withdrawal_requests where id = p_withdrawal_id for update;
  if not found then
    return pg_catalog.jsonb_build_object('result', 'not_found');
  end if;

  if v_case.case_state in ('refund_pending', 'refunded', 'rejected_late', 'closed') then
    return pg_catalog.jsonb_build_object('result', 'case_closed', 'case_state', v_case.case_state);
  end if;
  -- 'failed' TOO: a declined card does not un-approve the refund, and
  -- re-cutting the goods under a live idempotency key is how the row and
  -- Stripe come to disagree about what was refunded.
  if v_case.refund_state in ('approved_for_payout', 'executed', 'failed') then
    return pg_catalog.jsonb_build_object('result', 'refund_already_approved',
                                         'refund_state', v_case.refund_state);
  end if;

  if v_case.resolved_order_id is null then
    -- An annual plan resolves through its own frozen figures and has no
    -- order items to point at; a case that resolved to nothing has
    -- nothing to point at either.
    return pg_catalog.jsonb_build_object('result', 'no_order_resolved');
  end if;

  -- THE LINE MUST BE THIS ORDER'S. Both predicates in one statement, so
  -- there is no window in which the id is trusted before it is checked.
  select * into v_item
    from public.order_items
   where id = p_order_item_id
     and order_id = v_case.resolved_order_id;
  if not found then
    return pg_catalog.jsonb_build_object('result', 'item_not_in_order');
  end if;

  if p_quantity is null or p_quantity < 1 or p_quantity > v_item.quantity then
    return pg_catalog.jsonb_build_object(
      'result', 'quantity_out_of_range',
      'line_quantity', v_item.quantity
    );
  end if;

  -- THE SHIPPING DECISION BELONGS TO A PARTIAL CASE AND ONLY TO ONE.
  if v_case.scope = 'partial' then
    if p_shipping_treatment is null
       or p_shipping_treatment not in ('refund_outbound_shipping', 'retain_outbound_shipping') then
      return pg_catalog.jsonb_build_object('result', 'shipping_treatment_required');
    end if;
  else
    if p_shipping_treatment is not null then
      return pg_catalog.jsonb_build_object('result', 'shipping_treatment_not_applicable');
    end if;
  end if;

  update public.withdrawal_requests
     set resolved_order_item_id     = v_item.id,
         resolved_item_quantity     = p_quantity,
         partial_shipping_treatment = case when v_case.scope = 'partial'
                                          then p_shipping_treatment else null end,
         item_resolution_by         = p_actor_user_id,
         item_resolution_at         = pg_catalog.now(),
         updated_at                 = pg_catalog.now()
   where id = p_withdrawal_id
  returning * into v_case;

  perform public.record_admin_activity(
    p_actor_user_id, 'customer_rights', 'withdrawal.item_resolved', 'withdrawal',
    p_withdrawal_id::text, 'Widerrufsgegenstand zugeordnet', gen_random_uuid(),
    pg_catalog.jsonb_build_object(
      'order_item_id', v_item.id,
      'product_name', v_item.product_name,
      'resolved_quantity', p_quantity,
      'line_quantity', v_item.quantity,
      'scope', v_case.scope,
      'shipping_treatment', v_case.partial_shipping_treatment
    )
  );

  return pg_catalog.jsonb_build_object(
    'result', 'resolved',
    'order_item_id', v_item.id,
    'resolved_quantity', v_case.resolved_item_quantity,
    'line_quantity', v_item.quantity,
    'shipping_treatment', v_case.partial_shipping_treatment
  );
end;
$$;

revoke all on function public.admin_resolve_withdrawal_item(uuid, uuid, uuid, integer, text)
  from public, anon, authenticated;
grant execute on function public.admin_resolve_withdrawal_item(uuid, uuid, uuid, integer, text)
  to service_role;

-- ── WERTERSATZ: THE DECISION, BOUNDED IN SQL ──────────────
--
-- THE CEILING IS COMPUTED HERE, from a price this shop froze at the
-- moment of purchase, and is not accepted from the caller. An
-- administrator may confirm the proposal or reduce it; raising it above
-- the goods' frozen retail value is refused by the database, so no
-- route, no screen and no future script can do it either.
--
-- Sealed goods have a ceiling of zero, which is the same rule stated as
-- arithmetic rather than as a special case - and it holds for ANY
-- quantity, because nothing that was never opened can have lost value.
--
-- THREE KINDS OF CASE REACH THIS FUNCTION, because three kinds of
-- purchase exist and the public form accepts all of them:
--
--   AN ANNUAL PLAN. The plan carries catalog_unit_gross_cents - the
--   retail price of ONE package, frozen at activation. The ceiling is
--   that one package, not the twelve, because the withdrawal period
--   runs from the FIRST goods (BGB 356 Abs. 2 Nr. 1 lit. d) and a
--   timely case therefore concerns the first box. If later boxes were
--   also received and opened, this understates the ceiling - which
--   errs in the CUSTOMER'S favour, and is the only direction an
--   automatic bound may err in.
--
--   A ONE-OFF ORDER, or an order a recurring subscription generated.
--   Both are rows in public.orders with rows in public.order_items,
--   and order_items.unit_price_gross_cents is the undiscounted retail
--   price per unit AS CHARGED THEN. That is the figure used. Never a
--   live catalogue read - a case from March must not be re-priced by
--   an April price change. Never a browser-supplied amount.
--
--   AND A CASE THIS FUNCTION CANNOT PRICE, which it refuses to price.
--   See below; it returns manual_review_required and writes NOTHING.
--
-- ══════════════════════════════════════════════════════════════
-- ONE UNIT, OR NO AUTOMATIC DEDUCTION
-- ══════════════════════════════════════════════════════════════
--
-- withdrawal_requests carries ONE seal_state for the whole case. That is
-- the right granularity for the question a consumer can answer, and it
-- is not enough to price a line that sold more than one package:
--
--   30 g Matcha, quantity 2, seal_state 'opened_seal_broken'
--
-- says at least one package was opened. It does not say both were. A
-- ceiling of unit_price x 2 would therefore charge Wertersatz for a
-- package that may still be sealed - a real deduction from a real
-- person, derived from something nobody actually stated.
--
-- So an automatic ceiling on opened goods requires the case to concern
-- EXACTLY ONE UNIT, established either by
--
--   an administrator's structured resolution (resolved_item_quantity),
--   which is the honest way to say "this case is about one of the two",
--
-- or, where no resolution exists, by the order itself being
-- unambiguous: exactly one item line, and that line having sold exactly
-- one unit.
--
-- Anything else - several lines, several units, a quantity nobody has
-- narrowed - returns manual_review_required with the reason named, and
-- writes nothing. The consequence is deliberate and worth stating
-- plainly: such a case CANNOT then be paid out automatically either,
-- because an opened case with no confirmed Wertersatz is refused by
-- admin_approve_withdrawal_refund. A human finishes it. That is the
-- correct outcome for a case whose facts are genuinely unknown, and it
-- is much better than a deduction the shop invented.
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
  v_order     public.orders;
  v_item      public.order_items;
  v_lines     integer;
  v_units     integer;
  v_ceiling   integer;
  v_basis     text;
begin
  if p_confirmed_cents is null or p_confirmed_cents < 0 then
    return pg_catalog.jsonb_build_object('result', 'invalid_amount');
  end if;

  select * into v_case from public.withdrawal_requests where id = p_withdrawal_id for update;
  if not found then
    return pg_catalog.jsonb_build_object('result', 'not_found');
  end if;

  -- A decided case is not re-decided. Wertersatz set after the money
  -- moved would change a figure the customer was already told.
  --
  -- 'refund_pending' IS IN THIS LIST NOW, and its absence was a real
  -- hole: the payout is approved at that point and refund_amount_cents
  -- is already fixed, so re-pricing the deduction here would leave the
  -- row's arithmetic disagreeing with the amount that was released.
  if v_case.case_state in ('refund_pending', 'refunded', 'rejected_late', 'closed') then
    return pg_catalog.jsonb_build_object('result', 'case_closed', 'case_state', v_case.case_state);
  end if;

  -- And the payout lock itself, which this writer previously had none
  -- of. The Wertersatz IS the deduction the payout was computed from.
  if v_case.refund_state in ('approved_for_payout', 'executed', 'failed') then
    return pg_catalog.jsonb_build_object('result', 'refund_already_approved',
                                         'refund_state', v_case.refund_state);
  end if;

  if v_case.seal_state is null then
    return pg_catalog.jsonb_build_object('result', 'seal_state_unknown');
  end if;

  if v_case.seal_state = 'sealed_unopened' then
    -- ANY quantity, any number of lines. Nothing was opened, so there is
    -- no ambiguity to resolve and nothing to deduct.
    v_ceiling := 0;
    v_basis   := 'sealed_no_value_loss';

  elsif v_case.resolved_annual_plan_id is not null then
    select * into v_plan from public.annual_plans where id = v_case.resolved_annual_plan_id;
    if not found or v_plan.catalog_unit_gross_cents is null
       or v_plan.catalog_unit_gross_cents <= 0 then
      return pg_catalog.jsonb_build_object('result', 'no_price_snapshot');
    end if;
    v_ceiling := v_plan.catalog_unit_gross_cents;
    v_basis   := 'annual_plan_catalog_unit';

  elsif v_case.resolved_order_id is not null then
    select * into v_order from public.orders where id = v_case.resolved_order_id;
    if not found then
      return pg_catalog.jsonb_build_object('result', 'no_price_snapshot');
    end if;

    if v_case.resolved_order_item_id is not null then
      -- AN ADMINISTRATOR HAS SAID WHICH LINE AND HOW MANY. Re-read with
      -- the order predicate anyway: the resolution was validated when it
      -- was made, and this function does not assume it still holds.
      select * into v_item
        from public.order_items
       where id = v_case.resolved_order_item_id
         and order_id = v_order.id;
      if not found then
        return pg_catalog.jsonb_build_object('result', 'no_price_snapshot');
      end if;
      v_units := v_case.resolved_item_quantity;
      v_basis := 'order_item_resolved_unit';
    else
      select pg_catalog.count(*) into v_lines
        from public.order_items where order_id = v_order.id;

      if v_lines is null or v_lines = 0 then
        return pg_catalog.jsonb_build_object(
          'result', 'manual_review_required',
          'reason', 'order_has_no_items'
        );
      end if;

      if v_lines > 1 then
        -- WHICH of them was opened? The database does not know, and a
        -- guess here becomes a charge against a real customer.
        return pg_catalog.jsonb_build_object(
          'result', 'manual_review_required',
          'reason', 'order_has_multiple_items',
          'item_line_count', v_lines
        );
      end if;

      select * into v_item from public.order_items where order_id = v_order.id;
      if not found then
        return pg_catalog.jsonb_build_object('result', 'no_price_snapshot');
      end if;
      v_units := v_item.quantity;
      v_basis := 'order_item_single_unit';
    end if;

    if v_item.unit_price_gross_cents is null or v_item.unit_price_gross_cents <= 0 then
      return pg_catalog.jsonb_build_object('result', 'no_price_snapshot');
    end if;

    -- THE ONE-UNIT RULE. See the header: a case-level seal_state cannot
    -- describe two packages, so two packages get no automatic ceiling.
    if v_units is null or v_units <> 1 then
      return pg_catalog.jsonb_build_object(
        'result', 'manual_review_required',
        'reason', 'quantity_needs_unit_resolution',
        'units_in_scope', v_units,
        'line_quantity', v_item.quantity
      );
    end if;

    -- THE HISTORICAL GROSS RETAIL PRICE OF THE ONE UNIT. Any discount
    -- granted on top is deliberately NOT deducted here: Wertersatz is
    -- measured against the goods' value, and keeping the undiscounted
    -- figure keeps this an upper bound.
    v_ceiling := v_item.unit_price_gross_cents;

  else
    return pg_catalog.jsonb_build_object('result', 'no_contract_resolved');
  end if;

  if p_confirmed_cents > v_ceiling then
    return pg_catalog.jsonb_build_object(
      'result', 'above_ceiling',
      'ceiling_cents', v_ceiling,
      'ceiling_basis', v_basis
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
    p_withdrawal_id::text, 'Wertersatz bestaetigt', gen_random_uuid(),
    pg_catalog.jsonb_build_object(
      'confirmed_cents', p_confirmed_cents,
      'ceiling_cents', v_ceiling,
      'ceiling_basis', v_basis
    )
  );

  return pg_catalog.jsonb_build_object(
    'result', 'confirmed',
    'confirmed_cents', v_case.confirmed_value_loss_cents,
    'ceiling_cents', v_ceiling,
    'ceiling_basis', v_basis
  );
end;
$$;

-- ── THE REFUND, PREPARED BUT NOT PAID ─────────────────────
--
-- IT COMPUTES THE AMOUNT. No caller supplies one, and there is no
-- parameter for it - the figure is what the customer actually paid for
-- what they actually withdrew, minus the confirmed value loss, floored
-- at zero.
--
-- ══════════════════════════════════════════════════════════════
-- WHAT "WHAT THEY PAID" MEANS DEPENDS ON THE SCOPE
-- ══════════════════════════════════════════════════════════════
--
-- AN ANNUAL PLAN: the plan's own total_gross_cents. Unchanged.
--
-- A WHOLE-ORDER WITHDRAWAL: the order's total_gross_cents. That column
-- is the gross the customer was charged, outbound shipping included,
-- and BGB 357 Abs. 1 repays the delivery costs too - so the whole of it
-- goes back and nothing is withheld from it.
--
-- A PARTIAL WITHDRAWAL: NOT the order total. This is the correctness
-- hole this section exists to close. scope = 'partial' means the
-- consumer withdrew part of the order and is keeping the rest; refunding
-- orders.total_gross_cents would hand back money for goods they still
-- have. The order total is therefore not merely imprecise for a partial
-- case, it is wrong, and it is never reached by one.
--
-- Instead a partial case is paid from its STRUCTURED RESOLUTION - an
-- order_items row and a quantity an administrator named through
-- admin_resolve_withdrawal_item - and from purchase-time snapshots only:
--
--   the line's EFFECTIVE gross, which migration 058 defines as
--     line_total_gross_cents - discount_gross_cents
--   ...apportioned to the withdrawn units, then
--   plus the historic outbound shipping if, and only if, a human
--     decided it goes back.
--
-- WITHOUT THAT RESOLUTION A PARTIAL CASE CANNOT BE PAID. It returns
-- manual_review_required, because the only other thing the database has
-- is scope_note - a sentence the customer typed - and deriving money
-- from customer prose is not something this file will do.
--
-- ── THE APPORTIONMENT, AND WHICH WAY IT ROUNDS ────────────────
--
-- ceil, not floor, then capped at the line's effective gross.
--
-- Withdrawing 1 of 3 units of a line that cost 1000 cents net of
-- discount is 333.33 cents. Rounding down would keep a cent of the
-- consumer's money on a statutory refund, which is the one direction a
-- rounding rule must not err in. Rounding up costs the shop at most one
-- cent per case and is defensible to anybody. The cap makes the
-- all-units case exact rather than one cent high.
--
-- ── AND THE OUTBOUND SHIPPING, WHICH IS NOT ARITHMETIC ────────
--
-- For a whole-order case the law settles it. For a partial one it does
-- not: the consumer keeps goods that would have been shipped anyway.
-- This function does not invent a retention rule and does not guess. It
-- reads partial_shipping_treatment - a human's recorded decision between
-- two values - and then takes the money from orders.shipping_gross_cents
-- or takes none. Nobody types an amount either way.
--
-- IT WILL NOT APPROVE A CASE THAT IS NOT ACTUALLY DECIDED. Eight
-- questions must already have answers, and each missing one names
-- itself in the result rather than being skipped:
--
--   is the case still open?                  case_closed
--   was it in time?                          timeliness_unresolved
--   do we know the seal?                     seal_state_unknown
--   did we decide about the return?          return_requirement_undecided
--   if we asked for it, is it back?          return_outstanding
--   if it was opened, is Wertersatz set?     value_loss_undecided
--   for a partial case, WHICH goods?         manual_review_required
--   do we know what they paid?               no_payment_snapshot
--
-- timeliness must be exactly 'timely'. 'receipt_unknown' and
-- 'deadline_uncertain' are the fail-open answers the deadline engine
-- gives when it cannot be sure - they must never block a customer, and
-- they must equally never be mistaken for a decision. A human resolves
-- the receipt first; only then is there something to approve.
--
-- IT DOES NOT MOVE MONEY. This marks a case approved_for_payout and
-- stamps one refund_operation_id; the Stripe call is a separate,
-- explicit step outside the database. The unique index on
-- refund_operation_id is what makes a second approval impossible, so a
-- double-click cannot become a double refund.
--
-- AND IT STOPS THE DELIVERIES FOR GOOD. An approved withdrawal means
-- the contract is undone, so deliveries_permanently_stopped_at is
-- stamped in the SAME transaction that approves the money. Not at
-- execution - between approval and Stripe returning there is a window,
-- and a delivery worker running inside that window must not mint
-- another box for a contract that no longer exists.
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
  v_case      public.withdrawal_requests;
  v_plan      public.annual_plans;
  v_order     public.orders;
  v_item      public.order_items;
  v_effective integer;
  v_goods     integer;
  v_shipping  integer;
  v_paid      integer;
  v_basis     text;
  v_loss      integer;
  v_refund    integer;
begin
  select * into v_case from public.withdrawal_requests where id = p_withdrawal_id for update;
  if not found then
    return pg_catalog.jsonb_build_object('result', 'not_found');
  end if;

  -- ONE APPROVAL PER CASE, EVER - 'failed' included. A declined card is
  -- retried through admin_record_withdrawal_refund_execution, which
  -- accepts 'failed' for exactly that purpose. Re-approving instead
  -- would re-derive the amount under the SAME refund_operation_id, so a
  -- figure that had moved would be sent to Stripe under a key Stripe
  -- already knows - and the row would then disagree with the payout.
  if v_case.refund_state in ('approved_for_payout', 'executed', 'failed') then
    return pg_catalog.jsonb_build_object(
      'result', 'already_approved',
      'refund_state', v_case.refund_state,
      'refund_amount_cents', v_case.refund_amount_cents,
      'refund_operation_id', v_case.refund_operation_id
    );
  end if;

  if v_case.case_state in ('rejected_late', 'closed') then
    return pg_catalog.jsonb_build_object('result', 'case_closed', 'case_state', v_case.case_state);
  end if;

  -- IN TIME, AND KNOWN TO BE IN TIME.
  if v_case.timeliness is distinct from 'timely' then
    return pg_catalog.jsonb_build_object(
      'result', 'timeliness_unresolved',
      'timeliness', v_case.timeliness
    );
  end if;

  if v_case.seal_state is null then
    return pg_catalog.jsonb_build_object('result', 'seal_state_unknown');
  end if;

  -- BGB 357 Abs. 4 only lets us wait for goods we actually asked for,
  -- so the decision has to have been MADE before it can be applied.
  if v_case.return_requirement is null then
    return pg_catalog.jsonb_build_object('result', 'return_requirement_undecided');
  end if;

  if v_case.return_requirement = 'return_requested'
     and v_case.return_received_at is null
     and v_case.return_dispatch_proof_at is null then
    return pg_catalog.jsonb_build_object('result', 'return_outstanding');
  end if;

  -- OPENED GOODS NEED A WERTERSATZ DECISION, even when that decision is
  -- zero. The coalesce further down would otherwise turn "nobody has
  -- looked at it yet" into "we waive it" - never in our favour, but
  -- also without anyone having chosen it.
  if v_case.seal_state = 'opened_seal_broken'
     and v_case.confirmed_value_loss_cents is null then
    return pg_catalog.jsonb_build_object('result', 'value_loss_undecided');
  end if;

  if v_case.resolved_annual_plan_id is not null then
    select * into v_plan from public.annual_plans where id = v_case.resolved_annual_plan_id;
    if not found then
      return pg_catalog.jsonb_build_object('result', 'no_contract_resolved');
    end if;
    v_paid  := v_plan.total_gross_cents;
    v_basis := 'annual_plan_total_gross';

  elsif v_case.resolved_order_id is not null then
    select * into v_order from public.orders where id = v_case.resolved_order_id;
    if not found then
      return pg_catalog.jsonb_build_object('result', 'no_contract_resolved');
    end if;

    if v_case.scope = 'partial' then
      -- ── A PARTIAL CASE NEVER REACHES THE ORDER TOTAL ──────────
      if v_case.resolved_order_item_id is null
         or v_case.resolved_item_quantity is null then
        return pg_catalog.jsonb_build_object(
          'result', 'manual_review_required',
          'reason', 'partial_item_not_resolved',
          'scope', v_case.scope
        );
      end if;
      if v_case.partial_shipping_treatment is null then
        return pg_catalog.jsonb_build_object(
          'result', 'manual_review_required',
          'reason', 'partial_shipping_treatment_undecided'
        );
      end if;

      select * into v_item
        from public.order_items
       where id = v_case.resolved_order_item_id
         and order_id = v_order.id;
      if not found then
        return pg_catalog.jsonb_build_object(
          'result', 'manual_review_required',
          'reason', 'resolved_item_no_longer_in_order'
        );
      end if;
      if v_item.quantity is null or v_item.quantity < 1
         or v_case.resolved_item_quantity > v_item.quantity then
        return pg_catalog.jsonb_build_object(
          'result', 'manual_review_required',
          'reason', 'resolved_quantity_out_of_range',
          'line_quantity', v_item.quantity
        );
      end if;

      -- WHAT THIS LINE ACTUALLY COST, per migration 058.
      v_effective := v_item.line_total_gross_cents
                   - coalesce(v_item.discount_gross_cents, 0);
      if v_effective is null or v_effective <= 0 then
        return pg_catalog.jsonb_build_object(
          'result', 'no_payment_snapshot',
          'payment_basis', 'order_item_effective_gross'
        );
      end if;

      -- Apportioned, rounded the consumer's way, capped at the line.
      v_goods := least(
        v_effective,
        pg_catalog.ceil(
          v_effective::numeric * v_case.resolved_item_quantity::numeric
            / v_item.quantity::numeric
        )::integer
      );

      v_shipping := case when v_case.partial_shipping_treatment = 'refund_outbound_shipping'
                         then coalesce(v_order.shipping_gross_cents, 0)
                         else 0 end;

      v_paid  := v_goods + v_shipping;
      v_basis := 'order_item_partial_' || v_case.partial_shipping_treatment;

      -- A partial refund can never exceed what the whole order took.
      if v_order.total_gross_cents is not null then
        v_paid := least(v_paid, v_order.total_gross_cents);
      end if;

    else
      -- EVERYTHING THE ORDER CHARGED, outbound shipping included.
      v_paid  := v_order.total_gross_cents;
      v_basis := 'order_total_gross';
    end if;

  else
    return pg_catalog.jsonb_build_object('result', 'no_contract_resolved');
  end if;

  if v_paid is null or v_paid <= 0 then
    return pg_catalog.jsonb_build_object(
      'result', 'no_payment_snapshot',
      'payment_basis', v_basis
    );
  end if;

  v_loss   := coalesce(v_case.confirmed_value_loss_cents, 0);
  v_refund := greatest(0, v_paid - v_loss);

  update public.withdrawal_requests
     set refund_amount_cents               = v_refund,
         refund_state                      = 'approved_for_payout',
         refund_operation_id               = coalesce(refund_operation_id, gen_random_uuid()),
         case_state                        = 'refund_pending',
         deliveries_permanently_stopped_at = coalesce(deliveries_permanently_stopped_at,
                                                      pg_catalog.now()),
         updated_at                        = pg_catalog.now()
   where id = p_withdrawal_id
  returning * into v_case;

  perform public.record_admin_activity(
    p_actor_user_id, 'customer_rights', 'withdrawal.refund_approved', 'withdrawal',
    p_withdrawal_id::text, 'Erstattung freigegeben', v_case.refund_operation_id,
    pg_catalog.jsonb_build_object(
      'paid_cents', v_paid,
      'payment_basis', v_basis,
      'scope', v_case.scope,
      'goods_cents', v_goods,
      'shipping_cents', v_shipping,
      'value_loss_cents', v_loss,
      'refund_cents', v_refund,
      'deliveries_permanently_stopped_at', v_case.deliveries_permanently_stopped_at
    )
  );

  return pg_catalog.jsonb_build_object(
    'result', 'approved',
    'paid_cents', v_paid,
    'payment_basis', v_basis,
    'scope', v_case.scope,
    'goods_cents', v_goods,
    'shipping_cents', v_shipping,
    'value_loss_cents', v_loss,
    'refund_amount_cents', v_refund,
    'refund_operation_id', v_case.refund_operation_id,
    'deliveries_permanently_stopped', true
  );
end;
$$;

-- ── AND ONLY THEN, WHAT STRIPE DID ────────────────────────
--
-- THE DATABASE STILL DOES NOT CALL STRIPE. It cannot, and that is the
-- point: the network call belongs to the server, and this function is
-- how the server REPORTS BACK what the provider said. Splitting it this
-- way means the row can never claim a payout that no API call made.
--
-- IT RE-READS THE CASE AND RE-CHECKS THE AMOUNT. The caller passes the
-- figure Stripe actually refunded, and if that is not exactly the
-- amount this database approved, the execution is REFUSED and reported
-- as a mismatch. A server bug, a stale screen or a hand-edited request
-- cannot make the row agree with a payout it did not authorise.
--
-- IT REQUIRES AN APPROVED OR A FAILED CASE - the second because a
-- declined card must be retryable. refund_operation_id was stamped at
-- approval and is the idempotency basis for the Stripe call itself: the
-- server sends it as the idempotency key, so a retry after a timeout
-- reaches the same refund at Stripe rather than creating a second one.
-- Here it is required to be present and returned for the audit trail.
--
-- AND IT IS IDEMPOTENT. Called twice with the same provider reference
-- it reports the same success; called twice with a DIFFERENT reference
-- it refuses, because that would mean two refunds for one case.
create or replace function public.admin_record_withdrawal_refund_execution(
  p_actor_user_id uuid,
  p_withdrawal_id uuid,
  p_provider_reference text,
  p_provider_amount_cents integer
)
returns jsonb
language plpgsql
volatile
security definer set search_path = ''
as $$
declare
  v_case public.withdrawal_requests;
  v_ref  text := btrim(coalesce(p_provider_reference, ''));
begin
  if char_length(v_ref) = 0 then
    return pg_catalog.jsonb_build_object('result', 'missing_provider_reference');
  end if;

  select * into v_case from public.withdrawal_requests where id = p_withdrawal_id for update;
  if not found then
    return pg_catalog.jsonb_build_object('result', 'not_found');
  end if;

  -- THE SECOND CALL WITH THE SAME ANSWER IS THE SAME ANSWER.
  if v_case.refund_state = 'executed' then
    if v_case.refund_provider_reference = v_ref then
      return pg_catalog.jsonb_build_object(
        'result', 'already_executed',
        'refund_amount_cents', v_case.refund_amount_cents,
        'refund_provider_reference', v_case.refund_provider_reference,
        'refund_executed_at', v_case.refund_executed_at
      );
    end if;
    return pg_catalog.jsonb_build_object(
      'result', 'conflicting_provider_reference',
      'refund_provider_reference', v_case.refund_provider_reference
    );
  end if;

  -- 'failed' IS ALSO EXECUTABLE, and has to be. A declined card or a
  -- timed-out call leaves the case owed and its state 'failed'; if only
  -- 'approved_for_payout' could be paid, the retry would be impossible
  -- and the customer's money would be stuck behind a state machine.
  -- The operation id is unchanged, so the retry is the SAME idempotent
  -- Stripe call rather than a second refund.
  if v_case.refund_state not in ('approved_for_payout', 'failed') then
    return pg_catalog.jsonb_build_object(
      'result', 'not_approved_for_payout',
      'refund_state', v_case.refund_state
    );
  end if;

  if v_case.refund_operation_id is null then
    return pg_catalog.jsonb_build_object('result', 'missing_refund_operation');
  end if;

  if p_provider_amount_cents is null
     or v_case.refund_amount_cents is null
     or p_provider_amount_cents <> v_case.refund_amount_cents then
    return pg_catalog.jsonb_build_object(
      'result', 'amount_mismatch',
      'approved_cents', v_case.refund_amount_cents,
      'provider_cents', p_provider_amount_cents
    );
  end if;

  update public.withdrawal_requests
     set refund_state                      = 'executed',
         refund_executed_at                = pg_catalog.now(),
         refund_provider_reference         = v_ref,
         refund_failure_reason             = null,
         case_state                        = 'refunded',
         deliveries_permanently_stopped_at = coalesce(deliveries_permanently_stopped_at,
                                                      pg_catalog.now()),
         updated_at                        = pg_catalog.now()
   where id = p_withdrawal_id
  returning * into v_case;

  perform public.record_admin_activity(
    p_actor_user_id, 'customer_rights', 'withdrawal.refund_executed', 'withdrawal',
    p_withdrawal_id::text, 'Erstattung ausgefuehrt', v_case.refund_operation_id,
    pg_catalog.jsonb_build_object(
      'refund_cents', v_case.refund_amount_cents,
      'provider_reference', v_ref
    )
  );

  return pg_catalog.jsonb_build_object(
    'result', 'executed',
    'refund_amount_cents', v_case.refund_amount_cents,
    'refund_provider_reference', v_case.refund_provider_reference,
    'refund_executed_at', v_case.refund_executed_at,
    'refund_operation_id', v_case.refund_operation_id
  );
end;
$$;

-- A FAILED PAYOUT IS A STATE, NOT A SILENCE.
--
-- If Stripe refuses, the case must not sit in 'approved_for_payout'
-- forever with nobody knowing why. This records the failure and the
-- provider's reason, keeps case_state at refund_pending because the
-- customer is still owed the money, and leaves refund_operation_id in
-- place so a retry is the SAME idempotent operation rather than a new
-- one. deliveries_permanently_stopped_at is untouched: the withdrawal
-- was still approved, so the boxes still stop.
create or replace function public.admin_record_withdrawal_refund_failure(
  p_actor_user_id uuid,
  p_withdrawal_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
volatile
security definer set search_path = ''
as $$
declare
  v_case   public.withdrawal_requests;
  v_reason text := pg_catalog.left(btrim(coalesce(p_reason, '')), 500);
begin
  select * into v_case from public.withdrawal_requests where id = p_withdrawal_id for update;
  if not found then
    return pg_catalog.jsonb_build_object('result', 'not_found');
  end if;

  if v_case.refund_state = 'executed' then
    return pg_catalog.jsonb_build_object('result', 'already_executed');
  end if;

  if v_case.refund_state not in ('approved_for_payout', 'failed') then
    return pg_catalog.jsonb_build_object(
      'result', 'not_approved_for_payout',
      'refund_state', v_case.refund_state
    );
  end if;

  update public.withdrawal_requests
     set refund_state          = 'failed',
         refund_failure_reason = nullif(v_reason, ''),
         updated_at            = pg_catalog.now()
   where id = p_withdrawal_id
  returning * into v_case;

  perform public.record_admin_activity(
    p_actor_user_id, 'customer_rights', 'withdrawal.refund_failed', 'withdrawal',
    p_withdrawal_id::text, 'Erstattung fehlgeschlagen', gen_random_uuid(),
    pg_catalog.jsonb_build_object(
      'refund_cents', v_case.refund_amount_cents,
      'reason', v_case.refund_failure_reason
    )
  );

  return pg_catalog.jsonb_build_object(
    'result', 'recorded_failure',
    'refund_state', v_case.refund_state,
    'refund_operation_id', v_case.refund_operation_id
  );
end;
$$;

-- ── AND THE MAIL THAT SAYS THE MONEY WENT ─────────────────
--
-- Three functions, and between them they are the whole send-once
-- guarantee for "Deine Erstattung ist durchgeführt".
--
-- They are NOT admin writers. Nobody decides anything here: sending a
-- transactional mail is plumbing that follows from a fact already
-- recorded, which is why there is no actor parameter and no audit entry -
-- exactly as the six senders migrations 017, 026, 027, 030, 031 and 033
-- already work. The audit trail for the payout itself is
-- withdrawal.refund_executed, written when the money moved.
--
-- ══════════════════════════════════════════════════════════════
-- WHY THE CLAIM IS A CONDITIONAL UPDATE AND NOT A READ
-- ══════════════════════════════════════════════════════════════
--
-- Two requests arriving together would both READ 'nothing sent yet' and
-- both send. One UPDATE ... WHERE cannot: PostgreSQL serialises the row,
-- the first caller's predicate matches, and the second finds a status of
-- 'sending' or 'sent' and matches nothing. The winner is whoever the
-- database says it is, not whoever read first.
--
-- THE PREDICATE IS ALSO THE TRIGGER CONDITION. It requires
-- refund_state = 'executed' AND a provider reference, which together
-- cannot exist unless Stripe answered and this database persisted it.
-- So the mail is structurally unsendable:
--
--   at approval            refund_state is 'approved_for_payout'  -> no claim
--   when Stripe fails      refund_state is 'failed'               -> no claim
--   on amount_mismatch     nothing was written at all             -> no claim
--
-- There is no ordering for a caller to get wrong, because getting it
-- wrong is not expressible.

create or replace function public.claim_withdrawal_refund_completed_email(
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
  update public.withdrawal_requests
     set refund_completed_email_status = 'sending',
         refund_completed_email_sent_at = null,
         updated_at = pg_catalog.now()
   where id = p_withdrawal_id
     -- THE MONEY REALLY MOVED, and this database really recorded it.
     and refund_state = 'executed'
     and refund_provider_reference is not null
     -- NOT ALREADY SENT, AND NOT CURRENTLY HELD. 'sent' is deliberately
     -- NOT claimable, unlike migration 033's order refund mail: there,
     -- a growing refund total is a new fact worth a second message and a
     -- watermark column decides. A withdrawal case has exactly one
     -- payout - the unique index on refund_operation_id guarantees it -
     -- so there is no second fact, no watermark, and re-claiming 'sent'
     -- could only ever produce a duplicate.
     and (refund_completed_email_status is null
          or refund_completed_email_status = 'failed')
  returning * into v_case;

  if not found then
    -- Deliberately ONE answer for "already sent", "being sent" and "not
    -- executed". The caller's only correct behaviour is the same in all
    -- three - do not send - and a caller that could tell them apart
    -- would eventually branch on it.
    return pg_catalog.jsonb_build_object('result', 'not_claimable');
  end if;

  return pg_catalog.jsonb_build_object(
    'result', 'claimed',
    'contact_email', v_case.contact_email,
    'customer_name', v_case.customer_name,
    'order_reference', v_case.order_reference,
    'refund_amount_cents', v_case.refund_amount_cents,
    'value_loss_cents', coalesce(v_case.confirmed_value_loss_cents, 0),
    'refund_provider_reference', v_case.refund_provider_reference,
    'refund_executed_at', v_case.refund_executed_at
  );
end;
$$;

-- THE PROVIDER ACCEPTED THE MESSAGE.
--
-- Not conditional on the row still saying 'sending', and that asymmetry
-- is the same one all six existing senders have: 'sent' records that
-- Resend took it, which is true whatever the row says by now. Suppressing
-- the write would leave a row that looks unsent and invite a duplicate
-- rather than prevent one.
create or replace function public.mark_withdrawal_refund_completed_email_sent(
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
  update public.withdrawal_requests
     set refund_completed_email_status  = 'sent',
         refund_completed_email_sent_at = pg_catalog.now(),
         updated_at                     = pg_catalog.now()
   where id = p_withdrawal_id
  returning * into v_case;

  if not found then
    return pg_catalog.jsonb_build_object('result', 'not_found');
  end if;
  return pg_catalog.jsonb_build_object(
    'result', 'sent',
    'refund_completed_email_sent_at', v_case.refund_completed_email_sent_at
  );
end;
$$;

-- THE SEND DID NOT HAPPEN, AND THE REFUND STILL DID.
--
-- 'failed' is claimable again, which is the entire retry mechanism: a
-- second attempt re-wins the claim and sends, WITHOUT going anywhere
-- near Stripe - the money already moved and refund_state is untouched
-- here. A failed message is a fact about a message; it is never a reason
-- to restate what happened to the money.
--
-- Only from 'sending', so a late failure report cannot overwrite a
-- success that a concurrent attempt already recorded.
create or replace function public.mark_withdrawal_refund_completed_email_failed(
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
  update public.withdrawal_requests
     set refund_completed_email_status  = 'failed',
         refund_completed_email_sent_at = null,
         updated_at                     = pg_catalog.now()
   where id = p_withdrawal_id
     and refund_completed_email_status = 'sending'
  returning * into v_case;

  if not found then
    return pg_catalog.jsonb_build_object('result', 'not_sending');
  end if;
  return pg_catalog.jsonb_build_object('result', 'recorded_failure');
end;
$$;

revoke all on function public.claim_withdrawal_refund_completed_email(uuid)
  from public, anon, authenticated;
revoke all on function public.mark_withdrawal_refund_completed_email_sent(uuid)
  from public, anon, authenticated;
revoke all on function public.mark_withdrawal_refund_completed_email_failed(uuid)
  from public, anon, authenticated;

grant execute on function public.claim_withdrawal_refund_completed_email(uuid) to service_role;
grant execute on function public.mark_withdrawal_refund_completed_email_sent(uuid) to service_role;
grant execute on function public.mark_withdrawal_refund_completed_email_failed(uuid) to service_role;

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
revoke all on function public.admin_record_withdrawal_refund_execution(uuid, uuid, text, integer) from public, anon, authenticated;
revoke all on function public.admin_record_withdrawal_refund_failure(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.admin_advance_complaint(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.admin_review_termination(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.admin_create_purchase_restriction(uuid, uuid, text, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.admin_lift_purchase_restriction(uuid, uuid) from public, anon, authenticated;

grant execute on function public.admin_set_withdrawal_seal_state(uuid, uuid, text) to service_role;
grant execute on function public.admin_set_withdrawal_return_requirement(uuid, uuid, text) to service_role;
grant execute on function public.admin_record_withdrawal_return(uuid, uuid, text, timestamptz) to service_role;
grant execute on function public.admin_confirm_withdrawal_value_loss(uuid, uuid, integer) to service_role;
grant execute on function public.admin_approve_withdrawal_refund(uuid, uuid) to service_role;
grant execute on function public.admin_record_withdrawal_refund_execution(uuid, uuid, text, integer) to service_role;
grant execute on function public.admin_record_withdrawal_refund_failure(uuid, uuid, text) to service_role;
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
