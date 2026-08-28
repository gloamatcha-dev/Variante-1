-- ============================================================
-- GLOA - Subscription email delivery foundation (Phase 3H.1)
-- Run in Supabase SQL Editor AFTER 034
--
-- Phase 3G audited the whole customer email lifecycle and found that a
-- B2C subscription produces exactly one email today, and it goes to the
-- internal fulfillment inbox. A customer can pay a first invoice, pay
-- twelve renewals, cancel, and watch the subscription end without GLOA
-- ever writing to them about the subscription itself. Phase 3H designed
-- the durable state that fixes that. This migration is that state, and
-- nothing else.
--
-- 035 IS THE NEXT FREE NUMBER. 022-034 are live and immutable and are
-- not touched: this migration adds no column to public.subscriptions,
-- adds no column to public.orders, creates no function, alters no
-- function, and changes no grant on any existing table. Task 21
-- (tax/VAT/OSS) still holds no migration file and remains free to take a
-- later number - this migration writes no tax field.
--
-- IT SENDS NOTHING AND TRIGGERS NOTHING. There is no template, no
-- webhook change, no route change and no cron change in this phase. The
-- table sits empty until application code written in a later phase
-- claims a genuine lifecycle event.
--
-- ══════════════════════════════════════════════════════════════
-- WHY A TABLE AND NOT ANOTHER PAIR OF COLUMNS
-- ══════════════════════════════════════════════════════════════
--
-- The six email flows before this one (017, 026, 027, 030, 031, 033)
-- each took columns on public.orders. Copying that shape onto
-- public.subscriptions was the Phase 3G proposal and Phase 3H proved it
-- unsafe. Three findings decided it, and extensibility was not one of
-- them.
--
-- 1. COLUMNS ON public.subscriptions ARE READABLE BY THE CUSTOMER.
--
--    Migration 005 grants table-wide SELECT on public.subscriptions to
--    authenticated, under an own-row RLS policy. The application's own
--    column list in app/AccountPortal.tsx is good discipline and
--    constrains nothing: the grant is on the TABLE, so a signed-in
--    customer can request any column of their own row directly. An email
--    delivery status is internal operational state and must never be one
--    of them. This table has RLS on, ZERO policies and no grant to anon
--    or authenticated, so the state is not merely undocumented - it is
--    unreachable from a browser.
--
-- 2. HISTORICAL SAFETY BECOMES STRUCTURAL RATHER THAN PROCEDURAL.
--
--    lib/transactionalEmailRetryRules.ts documents at length why the
--    sweep may key on 'failed' and on nothing else: the live database
--    holds hundreds of orders whose email columns are NULL because the
--    feature did not exist when they happened, and one of them carries a
--    genuinely settled refund. Under a column model every existing
--    subscription would acquire new NULL columns and safety would rest
--    on that rule never being broken. Here, existing subscriptions have
--    NO ROW AT ALL. A sweep over an empty table cannot reach them by any
--    mistake. Absence is a stronger guarantee than a nullable column.
--
-- 3. THE EVENT KEY DOUBLES AS THE CONTENT WATERMARK.
--
--    A cancellation confirmation states a date. Because the date is part
--    of the key, the row itself pins the exact date the message must
--    carry, and a retry the next morning cannot render a different one -
--    a different date is by definition a different row. A column model
--    would re-read a mutable column at send time and could deliver
--    content the original attempt never contained.
--
-- ══════════════════════════════════════════════════════════════
-- WHY THERE IS NO FUNCTION HERE
-- ══════════════════════════════════════════════════════════════
--
-- Migration 034 routes every write to public.subscriptions through
-- SECURITY DEFINER functions and leaves service_role holding SELECT and
-- nothing else. That was right, because that table holds business state
-- (money, snapshots, lifecycle) which service_role must not be able to
-- rewrite even by accident.
--
-- This table holds no business state. Every row is a fact about an
-- email. So the appropriate shape is the one public.stripe_webhook_events
-- (009) and public.stripe_customers (022) already use: a server-only
-- table with direct DML and no policies, where, in 009's own words, the
-- unique index "is the actual race-safety guard, not application-level
-- select then insert logic". A DEFINER layer here would add ceremony and
-- no safety.
--
-- ══════════════════════════════════════════════════════════════
-- WHAT IS DELIBERATELY NOT IN THIS MIGRATION
-- ══════════════════════════════════════════════════════════════
--
-- PAYMENT PROBLEM. There is no 'payment_problem' family and this
-- migration is not the place to add one. Phase 3H established that the
-- payment-failure message needs three guards the three families here
-- need none of: an event identity fixed BEFORE the send (the invoice
-- id), a live re-read of the invoice at send time (a failure that was
-- resolved overnight must not be mailed about the next morning), and a
-- supersession ordering that can only come from invoice.created, because
-- a Stripe invoice id carries no ordering guarantee. The last of those
-- would also force a Stripe client into the shared retry sweep that five
-- working email families depend on. It is additionally entangled with an
-- open question this migration does not answer: migration 022 added
-- 'past_due' and 'unpaid' to subscriptions_status_check, and 034's
-- sync_subscription_from_stripe deliberately never writes status at all,
-- so a subscription reads 'active' throughout dunning. That belongs to
-- one deliberate later phase, not to a fourth CHECK value here.
--
-- When it does arrive it costs no schema change: a family name and an
-- event key. That is a property of this design, not the reason for it.
--
-- REFUND CORRELATION. Phase 3G found that subscription orders are
-- created with stripe_payment_intent_id NULL, so a refund on a
-- subscription invoice can never find its order and no refund email is
-- sent. That defect is real and remains OPEN. It is not an email-state
-- problem, it needs no schema (create_order_from_paid_checkout already
-- takes the parameter), and it gets its own focused phase. Nothing here
-- touches it.
--
-- ORDER CONFIRMATION RETRY. Still excluded from automatic retry, for the
-- reason recorded in lib/transactionalEmailRetryRules.ts, and nothing
-- here reopens it.
--
-- NOR ANY OTHER ORDER EMAIL VOCABULARY. tests/transactional-email-retry.test.mjs
-- asserts that no migration after 033 mentions any of the six order
-- email-state column names ANYWHERE - a raw text scan, so a comment
-- counts just as much as a statement would. That is deliberate on its
-- part and correct: a scan that skipped comments could be fooled by a
-- commented-out ALTER, and the whole point is that those six
-- vocabularies are finished. So this file names none of them, and the
-- rule it is obeying is written here rather than discovered by whoever
-- next trips over it.
-- ============================================================


-- 1. THE TABLE ─────────────────────────────────────────────────
--
-- One row per (subscription, family, event). A row exists if and only if
-- some code has genuinely claimed the right to send that one message.
--
-- EIGHT COLUMNS, AND THE ABSENT ONES ARE DELIBERATE.
--
--   no recipient      The recipient is re-read from the subscription's
--                     own frozen customer_snapshot at send time, exactly
--                     as lib/shipmentConfirmationEmail.ts and
--                     lib/cancellationOutcomeEmail.ts already do. A
--                     stored recipient is a recipient somebody can
--                     change; a sender with no recipient parameter
--                     removes arbitrary-recipient as a category of bug
--                     rather than guarding against it.
--   no error text     Provider messages are logged by row id and never
--                     stored. Phase 3G's privacy constraint forbids
--                     internal error text reaching a customer, and the
--                     surest way to keep it out of an email is not to
--                     have it in a row the email is built from.
--   no Stripe id      None of these three messages is keyed on a Stripe
--                     object. The one that would be is deferred.
--   no webhook id     A Stripe event id is not delivery idempotency.
--                     stripe_webhook_events suppresses reprocessing of
--                     one delivery; it cannot suppress a second email
--                     after a crash, because recordStripeWebhookEvent
--                     runs after processing and its own failure is
--                     tolerated by design.
--   no attempt count  Eligibility is 'failed' and the batch is bounded
--                     at 25 per family per run. None of the five
--                     existing auto-retry families counts attempts.
--   no payload        The three families here rebuild every word from
--                     durable rows: plan_snapshot for the start message,
--                     the two cancellation timestamps for the
--                     confirmation, cancelled_at for the ending. Nothing
--                     is owed that the database cannot restate, so a
--                     payload would be a second copy of the truth, free
--                     to drift from the first.

create table public.subscription_email_deliveries (
  id              uuid primary key default gen_random_uuid(),

  -- Cascade because a delivery row is meaningless without its
  -- subscription. Nothing in this codebase deletes a subscription -
  -- mark_subscription_cancelled destroys nothing and leaves the row and
  -- its snapshots in place - so this is a correctness statement about an
  -- orphan that should never exist, not an expected path.
  subscription_id uuid not null
                  references public.subscriptions(id) on delete cascade,

  -- Which message. See the CHECK below for the closed vocabulary.
  family          text not null,

  -- WHICH OCCURRENCE OF THAT MESSAGE. See section 3.
  event_key       text not null,

  -- NO DEFAULT, deliberately. See section 2.
  status          text not null,

  -- Set if and only if status = 'sent'. See the biconditional CHECK.
  sent_at         timestamptz,

  created_at      timestamptz not null default now(),

  -- Maintained by the trigger in section 6. It is what makes stale
  -- recovery possible.
  updated_at      timestamptz not null default now()
);


-- 2. THE TWO CLOSED VOCABULARIES ───────────────────────────────

-- ── FAMILY ────────────────────────────────────────────────────
--
-- Exactly three. 'payment_problem' is absent for the reasons in the
-- header, and its absence is enforced rather than merely intended: a
-- later phase that wants it has to say so in a migration, which is
-- exactly the deliberate step it deserves.

alter table public.subscription_email_deliveries
  add constraint subscription_email_deliveries_family_check
  check (family in (
    'subscription_started',
    'cancellation_confirmation',
    'subscription_ended'
  ));

-- ── STATUS ────────────────────────────────────────────────────
--
-- Exactly four, and 'pending' is NOT one of them.
--
-- ABSENCE IS THE PENDING STATE. A row comes into existence only when
-- code is genuinely about to send, so there is no state between "owed"
-- and "in flight" for a row to sit in. This is the project convention
-- taken one step further: NEVER_ELIGIBLE_STATUSES in
-- lib/transactionalEmailRetryRules.ts already refuses 'pending', and the
-- comment there explains why: migration 017's email-state column was
-- declared NOT NULL DEFAULT 'pending', which is exactly how a historical
-- row becomes indistinguishable from queued work. Here the value cannot
-- be written at all, so that mistake is structurally impossible to
-- repeat.
--
--   'sending'     claimed, in flight, owned by whoever won the claim
--   'sent'        the provider accepted it. Terminal.
--   'failed'      an attempt was made and genuinely failed. THE ONLY
--                 STATUS ANY SWEEP MAY EVER ACT ON.
--   'superseded'  never sent, and must never be sent. Terminal.
--
-- 'queued', 'retrying' and 'cancelled' are deliberately absent: the
-- first two are what 'failed' plus a bounded sweep already mean, and the
-- third is a word about a subscription, not about an email.

alter table public.subscription_email_deliveries
  add constraint subscription_email_deliveries_status_check
  check (status in ('sending', 'sent', 'failed', 'superseded'));


-- 2B. WHY 'superseded' EXISTS ──────────────────────────────────
--
-- It is the difference between an email that could not be sent and an
-- email that must not be.
--
-- THE CASE THAT FORCED IT. A cancellation confirmation for effective
-- date A is claimed. The provider send fails and the row records
-- 'failed'. Before the next sweep runs, the cancellation is unscheduled
-- at Stripe, or its effective date moves. Migration 034 permits both:
-- sync_subscription_from_stripe sets cancellation_effective_at and
-- cancellation_requested_at back to NULL on a genuine unscheduling, and
-- apply_deferred_subscription_cancellation corrects the effective date
-- to whatever Stripe accepted for the late branch.
--
-- Without a fourth status that row has two futures and both are wrong:
-- it is either retried, and a customer is told their subscription ends
-- on a date that is no longer true, or it stays 'failed' forever and is
-- re-selected by every daily sweep for the rest of the system's life,
-- burning a slot in a bounded batch on work that can never succeed.
--
-- 'superseded' is the third answer, and it is honest: the message was
-- never sent, and the fact it described is no longer current.
--
-- IT IS TERMINAL AND NEVER RETRY ELIGIBLE. A sweep selects 'failed' and
-- nothing else, so 'superseded' leaves the work list permanently.
--
-- IT IS NOT A SUBSTITUTE FOR THE NEW MESSAGE. When the customer's
-- cancellation genuinely changes, that is a new customer-facing fact
-- with a new event key, and it gets its own row. Superseding the old one
-- closes the old row; it does not suppress the new one.


-- 3. THE EVENT KEY CONTRACT ────────────────────────────────────
--
-- The event key answers "which occurrence of this message is this",
-- which is a different question from "which subscription is this".
-- Getting the difference wrong is how a customer either receives a
-- duplicate or, worse, silently receives nothing.
--
-- IT MUST NOT BE BLANK. Enforced below, because an empty key would
-- collapse every occurrence of a family into one row through the unique
-- constraint, which is the exact failure this column exists to prevent.
--
-- ── subscription_started: derived from subscriptions.id ───────
--
-- SUFFICIENT, AND PROVEN SO BY MIGRATION 022 RATHER THAN ASSUMED.
-- activate_subscription_from_invoice binds stripe_subscription_id ONCE
-- (it writes coalesce(existing, new) and raises on a conflicting id),
-- and it refuses to activate any status outside pending/active/past_due/
-- unpaid, so a cancelled row can never be revived. create_pending_
-- subscription performs a plain INSERT, so a customer who subscribes
-- again gets a NEW subscriptions.id and correctly a new start message.
-- One local row therefore maps to one Stripe subscription, which raises
-- one subscription_create invoice.
--
-- It also fails in the safe direction if that ever ceased to hold: a
-- second start event would find the key already claimed and send
-- nothing. At most one, never two.
--
-- ── cancellation_confirmation: BOTH timestamps, from the row ──
--
-- Derived from the PERSISTED values of
--
--     subscriptions.cancellation_requested_at
--     subscriptions.cancellation_effective_at
--
-- read back AFTER the cancellation write has committed. Never from a
-- browser value, never from the timestamp the route computed before
-- calling the RPC, and never from what the RPC was passed - only from
-- what the row actually holds. schedule_subscription_cancellation has
-- four outcomes that write different things (CASE A writes all three
-- columns, CASE C writes one, CASE B writes none, CASE D refuses), so
-- the argument a caller sent is not reliably the value that landed.
--
-- BOTH ARE REQUIRED. Neither alone is correct:
--
--   requested_at alone  misses a legitimate change of the effective
--                       date by apply_deferred_subscription_cancellation
--                       or by sync_subscription_from_stripe, leaving the
--                       customer holding a date that has since moved.
--   effective_at alone  misses a genuine second cancellation. A
--                       Stripe-side unscheduling nulls BOTH timestamps,
--                       after which the customer may cancel again; if
--                       the new request happens to land on the same
--                       date, a key made only of the date would be
--                       already-claimed and the second confirmation
--                       would be silently suppressed.
--
-- The pair catches both. An ordinary idempotent repeat - pressing cancel
-- twice, which 034 answers 'already_scheduled' with zero writes - leaves
-- both values identical, produces the same key, and is correctly
-- suppressed.
--
-- ── CANONICALIZATION ──────────────────────────────────────────
--
-- Both columns are timestamptz. A timestamptz is an EXACT INSTANT, not a
-- calendar date and not a local wall-clock reading, and the key must be
-- built from that instant with a deterministic, machine-readable
-- rendering - one instant, one string, on every machine, in every
-- process, forever.
--
-- NEVER a locale-formatted date. NEVER German display formatting.
-- "3. Oktober 2026" is a presentation of an instant, not the instant: it
-- is lossy (it discards the time of day, so two genuinely different
-- effective instants on one day collide into one key), it depends on a
-- timezone the sending process happens to hold, and it depends on an ICU
-- locale database that can change under the application. Every one of
-- those is a way for the same event to produce two keys, or for two
-- events to produce one. A date the customer READS is a rendering
-- decision made in the template; it is never the idempotency key.
--
-- ── subscription_ended: derived from subscriptions.id ─────────
--
-- SUFFICIENT, AND PROVEN SO BY MIGRATION 034.
-- mark_subscription_cancelled is the only writer of status = 'cancelled',
-- it is strictly idempotent (an already-cancelled row returns
-- 'already_cancelled' and cancelled_at is deliberately never moved), and
-- 022's activation refuses to revive a cancelled subscription. A local
-- row can therefore terminate exactly once, permanently.
--
-- ── NO WIRING IN THIS PHASE ───────────────────────────────────
--
-- These are contracts for the senders a later phase will write. This
-- migration creates no function that builds a key and no code path that
-- claims a row.

alter table public.subscription_email_deliveries
  add constraint subscription_email_deliveries_event_key_check
  check (length(btrim(event_key)) > 0);


-- 4. THE sent_at INVARIANT, IN BOTH DIRECTIONS ─────────────────
--
-- status = 'sent'  if and only if  sent_at is not null
--
-- The forward direction is obvious: a sent message has a send time. The
-- REVERSE direction is the one worth enforcing, and it is why this is a
-- biconditional rather than the one-way check first proposed.
--
-- A row that says 'failed' while still carrying a sent_at from an
-- earlier attempt is a row that contradicts itself, and the
-- contradiction points the dangerous way: an operator, a support query
-- or a future sweep reading sent_at as evidence of delivery would
-- conclude the customer has the message when the row's own status says
-- they do not. Requiring the timestamp to be cleared makes the state
-- machine self-describing at every point instead of only at the end.
--
-- status is NOT NULL, so this check is total: every row is covered by
-- exactly one branch, and no combination escapes it.

alter table public.subscription_email_deliveries
  add constraint subscription_email_deliveries_sent_at_check
  check (
    (status =  'sent' and sent_at is not null) or
    (status <> 'sent' and sent_at is null)
  );


-- 5. THE CLAIM GUARD ───────────────────────────────────────────
--
-- THE UNIQUE CONSTRAINT IS THE RACE GUARD. Not a function, not a
-- transaction pattern, and not application-level "select then insert" -
-- the same statement migration 009 makes about stripe_webhook_events'
-- primary key, for the same reason.
--
-- The first claim a later phase will write is, conceptually:
--
--   insert into public.subscription_email_deliveries
--     (subscription_id, family, event_key, status)
--   values ($1, $2, $3, 'sending')
--   on conflict (subscription_id, family, event_key) do nothing
--   returning id
--
-- One row back: the claim is won, and this caller is the only one that
-- may send.
--
-- ══════════════════════════════════════════════════════════════
-- ZERO ROWS BACK MEANS ALREADY CLAIMED. IT DOES NOT MEAN ALREADY SENT.
-- ══════════════════════════════════════════════════════════════
--
-- This distinction is written here because getting it wrong is invisible
-- in testing and wrong in production. The existing row may be in ANY of
-- the four states:
--
--   'sending'     another worker holds it right now, or held it and died
--                 and it is awaiting stale recovery
--   'sent'        genuinely delivered
--   'failed'      an attempt failed and the message is still owed
--   'superseded'  the fact is gone and the message must never be sent
--
-- Application code must therefore not report a conflict as "already
-- sent". Three of those four states mean the opposite. The five existing
-- senders can be looser about this because their claim is an UPDATE that
-- encodes eligibility in its own WHERE clause; here the insert cannot,
-- because there is no row yet to test. Read the row and decide, or
-- report "already claimed" and leave it to the sweep.

alter table public.subscription_email_deliveries
  add constraint subscription_email_deliveries_event_key
  unique (subscription_id, family, event_key);


-- 6. updated_at ────────────────────────────────────────────────
--
-- Reuses public.set_updated_at() from migration 001 unchanged. That
-- function is not modified here, and neither is the
-- set_subscriptions_updated_at trigger it already serves on
-- public.subscriptions.
--
-- It sets new.updated_at = now() on every update, unconditionally, which
-- is precisely the property isStaleSending in
-- lib/transactionalEmailRetryRules.ts depends on: the claim is an
-- update, so updated_at is at least as recent as the claim, a freshly
-- claimed row can never look stale, and a genuinely stale row that looks
-- fresh merely delays recovery - the harmless direction.

create trigger set_subscription_email_deliveries_updated_at
  before update on public.subscription_email_deliveries
  for each row execute function public.set_updated_at();


-- 7. INDEXES ───────────────────────────────────────────────────
--
-- Two, plus the unique constraint's own index. Each one exists for a
-- query a later phase will actually run, and none is speculative.
--
-- The unique constraint above serves the claim and every point lookup by
-- (subscription_id, family, event_key).
--
-- These two serve the sweep, whose two work-list queries are already
-- specified by the shape of runFamilyRetrySweep and
-- runFamilyStaleRecovery: bounded, per family, oldest first.
--
-- Both are PARTIAL. On a healthy day nothing is eligible at all, so
-- these indexes should be nearly empty regardless of how many messages
-- have been sent, which is the point. A full index on
-- (family, status, updated_at) would grow with every 'sent' row forever
-- to answer a question that is only ever asked about the small failing
-- minority.

--   where family = $1 and status = 'failed'
--   order by updated_at
--   limit 25
create index subscription_email_deliveries_failed_idx
  on public.subscription_email_deliveries (family, updated_at)
  where status = 'failed';

--   where family = $1 and status = 'sending' and updated_at <= $2
--   order by updated_at
--   limit 25
create index subscription_email_deliveries_sending_idx
  on public.subscription_email_deliveries (family, updated_at)
  where status = 'sending';


-- 8. ROW LEVEL SECURITY AND PRIVILEGES ─────────────────────────
--
-- SERVER ONLY. RLS on, ZERO policies, and no grant to any browser role.
-- It is not that the customer is denied a row they can see; the table is
-- invisible to them. Same shape as public.stripe_webhook_events (009)
-- and public.stripe_customers (022).
--
-- The REVOKEs are explicit rather than assumed. Supabase projects carry
-- default privileges that can grant new tables to anon and authenticated
-- automatically, and migration 023 exists in this repository precisely
-- because that assumption failed once already for
-- public.stripe_customers. Stating the removal costs three lines and
-- does not depend on what a project's ALTER DEFAULT PRIVILEGES happens
-- to say today.

alter table public.subscription_email_deliveries enable row level security;

-- No policies. Deliberately. With RLS enabled and no policy, no role
-- subject to RLS can read or write a single row, whatever grants it may
-- otherwise hold. service_role bypasses RLS, which is what makes the
-- combination correct rather than merely restrictive.

revoke all on public.subscription_email_deliveries from public;
revoke all on public.subscription_email_deliveries from anon;
revoke all on public.subscription_email_deliveries from authenticated;

-- AND FROM service_role TOO, BEFORE GRANTING IT WHAT IT ACTUALLY NEEDS.
--
-- This one is easy to leave out and it is the one that matters most for
-- the DELETE decision below. Granting three privileges does not remove a
-- fourth: if this project's ALTER DEFAULT PRIVILEGES hands service_role
-- ALL on new tables in public, then DELETE would already be there and
-- the grant beneath would simply not mention it. Revoking first makes
-- the final privilege set exactly what the next statement says, rather
-- than that plus whatever the default happened to add.
--
-- Migration 023 is in this repository for precisely this reason: the
-- assumption that a new table starts with no grants failed once already,
-- for public.stripe_customers, and had to be corrected afterwards. This
-- is the same revoke-then-grant it settled on, applied at creation time
-- instead of as a later repair.
revoke all on public.subscription_email_deliveries from service_role;

-- THREE GRANTS, NOT ONE, AND TWO OF THEM ARE COLUMN-SCOPED.
--
-- A table-wide `grant insert, update` would let service_role rewrite the
-- delivery identity itself. That is wider than any sender needs, and the
-- columns it would expose are the ones this whole design rests on.
--
-- ── SELECT: the whole table ───────────────────────────────────
--
-- Reading is not the risk here, and the sweep needs it in full: it
-- filters on family, status and updated_at, re-reads a claimed row
-- before calling the provider, and every claim ends in `returning id`.
-- Column-scoping it would buy nothing - by the design in section 1 this
-- table holds no recipient, no customer text and no error message - and
-- would break an operator's `select *` for no gain.
grant select on public.subscription_email_deliveries to service_role;

-- ── INSERT: exactly the four columns a claim supplies ─────────
--
-- The first claim writes these four and nothing else:
--
--   insert into public.subscription_email_deliveries
--     (subscription_id, family, event_key, status)
--   values ($1, $2, $3, 'sending')
--   on conflict (subscription_id, family, event_key) do nothing
--   returning id
--
-- id, created_at and updated_at are omitted deliberately. All three have
-- database defaults, and a column-scoped INSERT still applies the
-- default of every column it does not name. A sender that cannot name
-- them cannot supply a colliding id, cannot backdate a claim, and cannot
-- open a row that already looks stale to the recovery sweep.
--
-- sent_at is omitted too. A row is born 'sending', and the biconditional
-- CHECK in section 4 requires sent_at to be NULL there, so the only
-- INSERT that could name it is one the constraint would reject anyway.
-- Withholding the privilege refuses it one layer earlier.
--
-- ON CONFLICT DO NOTHING needs no privilege beyond INSERT. DO UPDATE
-- would additionally need UPDATE on the columns it assigns, which is a
-- second reason the claim in section 5 is DO NOTHING.
grant insert (subscription_id, family, event_key, status)
  on public.subscription_email_deliveries to service_role;

-- ── UPDATE: exactly the two columns a result writes ───────────
--
-- Every write after the claim is one of four, and between them they
-- touch two columns:
--
--   sent         status = 'sent',       sent_at = now()
--   failed       status = 'failed',     sent_at = null
--   superseded   status = 'superseded', sent_at = null
--   recovery     status = 'sending'     (a stale claim, retaken)
--
-- ══════════════════════════════════════════════════════════════
-- THE DELIVERY IDENTITY IS NOT WRITABLE AFTER THE CLAIM.
-- ══════════════════════════════════════════════════════════════
--
-- subscription_id, family and event_key are INSERT-ONLY. Once a row
-- exists, no application statement can move it to another subscription,
-- relabel which message it is, or re-point it at a different occurrence.
-- That is not tidiness. Four properties argued elsewhere in this file
-- depend on it, and each one silently weakens if the identity is
-- writable:
--
--   idempotency   the unique constraint in section 5 guards
--                 (subscription_id, family, event_key). If those three
--                 can be updated, the guard is only as strong as the
--                 code that happens not to touch them: a claimed key
--                 could be edited aside and the same message claimed,
--                 and sent, a second time.
--   watermark     section 1 argues the key pins the exact date a
--                 cancellation confirmation must carry, so a retry
--                 cannot render a different one. That holds only while
--                 the key cannot be rewritten between the failure and
--                 the retry.
--   preflight     the preflight compares the two live cancellation
--                 timestamps against the key. A mutable key could be
--                 made to match, instead of being correctly found not
--                 to and superseded.
--   history       a 'superseded' row records that a message was owed and
--                 deliberately never sent. Editable identity makes that
--                 record unusable as an audit trail.
--
-- created_at is likewise not writable: when a claim happened is a fact
-- about the past. id is not writable because a primary key that can move
-- is not an identity.
--
-- updated_at IS DELIBERATELY ABSENT FROM THIS GRANT, AND THE TRIGGER
-- STILL WORKS. PostgreSQL checks UPDATE privilege against the columns
-- the STATEMENT assigns - its SET list - and it checks them once, before
-- row processing begins. The BEFORE UPDATE trigger from section 6
-- assigns new.updated_at later, inside the row, and a trigger's
-- assignment to NEW is not a privilege-checked assignment. So
-- `update ... set status = 'sent', sent_at = now()` is authorised by
-- (status, sent_at) alone and updated_at is still stamped.
--
-- The column is therefore maintained by the database and unwritable by
-- the application at the same time, which is what section 6's
-- stale-recovery argument actually needs: if a sender could set
-- updated_at itself, a stuck row could be kept looking fresh forever and
-- recovery would never reach it.
--
-- The WHERE clauses these updates carry - `where id = $1 and status =
-- 'sending'`, `where family = $1 and status = 'failed'` - read columns
-- rather than assign them, and reading is covered by the table SELECT
-- above.
--
-- NO DELETE, and that is a decision rather than an omission. Delivery
-- history is append-and-amend: what GLOA sent a customer, and when, is
-- exactly the kind of record that must survive an operator's bad day.
-- Nothing in the designed lifecycle needs to remove a row - a fact that
-- stops being current is superseded, not erased.
grant update (status, sent_at)
  on public.subscription_email_deliveries to service_role;

-- Nothing else is touched. In particular the grants on
-- public.subscriptions (service_role SELECT only, authenticated SELECT
-- under RLS) and on public.orders (service_role's column-scoped UPDATE
-- covering exactly the eleven email-state columns) are exactly as
-- migrations 005, 017, 022, 026, 027, 030, 031, 033 and 034 left them.


-- 9. HISTORICAL ROWS ───────────────────────────────────────────
--
-- THE TABLE IS CREATED EMPTY AND STAYS EMPTY UNTIL REAL CODE CLAIMS A
-- REAL EVENT.
--
-- There is no backfill in this file. No insert ... select, no insert
-- from public.subscriptions, no insert from public.orders, no default on
-- status, and no reachable 'pending' value. Every subscription that
-- exists when this migration is applied has zero rows here, in every
-- family, and therefore cannot be selected by any sweep, cannot be
-- claimed by any recovery, and cannot be mailed about.
--
-- That is the whole of the protection and it needs no rule to be obeyed.
-- A backfill would have been the natural-looking mistake: it would have
-- created a queue of "owed" messages about subscriptions that started,
-- were cancelled, or ended long before any of this existed, and the
-- first cron run after deployment would have sent all of them.


-- ══════════════════════════════════════════════════════════════
-- VERIFY AFTER APPLYING (read-only, run in the SQL Editor)
-- ══════════════════════════════════════════════════════════════
--
--   -- The table exists, RLS is on, and it has zero policies.
--   select relname, relrowsecurity
--   from pg_class
--   where relname = 'subscription_email_deliveries';
--
--   select count(*) as policy_count
--   from pg_policies
--   where schemaname = 'public'
--     and tablename = 'subscription_email_deliveries';
--   -- expect 0
--
--   -- TABLE-LEVEL grants. Only service_role, and only SELECT: the
--   -- INSERT and UPDATE privileges are column-scoped and deliberately
--   -- do NOT appear in this view. anon and authenticated must not
--   -- appear at all, and DELETE must appear for nobody.
--   select grantee, privilege_type
--   from information_schema.role_table_grants
--   where table_schema = 'public'
--     and table_name = 'subscription_email_deliveries'
--   order by grantee, privilege_type;
--   -- expect exactly one row: service_role, SELECT
--
--   -- COLUMN-LEVEL grants, which is where INSERT and UPDATE now live.
--   -- A column-scoped privilege is stored on the column, not the table,
--   -- so the query above cannot see it and this one must be run too.
--   select grantee, column_name, privilege_type
--   from information_schema.column_privileges
--   where table_schema = 'public'
--     and table_name = 'subscription_email_deliveries'
--     and privilege_type in ('INSERT', 'UPDATE')
--   order by privilege_type, column_name;
--   -- expect INSERT: event_key, family, status, subscription_id
--   --        UPDATE: sent_at, status
--   -- and NOTHING for id, created_at or updated_at in either.
--
--   -- The same thing asked as the question that actually matters.
--   select
--     has_table_privilege('service_role',
--       'public.subscription_email_deliveries', 'SELECT')        as sel,
--     has_table_privilege('service_role',
--       'public.subscription_email_deliveries', 'DELETE')        as del,
--     has_column_privilege('service_role',
--       'public.subscription_email_deliveries', 'status',
--       'UPDATE')                                                as upd_status,
--     has_column_privilege('service_role',
--       'public.subscription_email_deliveries', 'event_key',
--       'UPDATE')                                                as upd_event_key,
--     has_column_privilege('service_role',
--       'public.subscription_email_deliveries', 'updated_at',
--       'UPDATE')                                                as upd_updated_at;
--   -- expect t, f, t, f, f
--
--   -- The four constraints and the two partial indexes.
--   select conname, pg_get_constraintdef(oid)
--   from pg_constraint
--   where conrelid = 'public.subscription_email_deliveries'::regclass
--   order by conname;
--
--   select indexname, indexdef
--   from pg_indexes
--   where schemaname = 'public'
--     and tablename = 'subscription_email_deliveries'
--   order by indexname;
--
--   -- The trigger is attached and reuses the existing function.
--   select tgname, pg_get_triggerdef(oid)
--   from pg_trigger
--   where tgrelid = 'public.subscription_email_deliveries'::regclass
--     and not tgisinternal;
--
--   -- IT IS EMPTY.
--   select count(*) from public.subscription_email_deliveries;
--   -- expect 0
--
--   -- AND 034 IS UNDISTURBED. public.subscriptions gained no column,
--   -- and service_role still holds SELECT on it and nothing more.
--   select grantee, privilege_type
--   from information_schema.role_table_grants
--   where table_schema = 'public'
--     and table_name = 'subscriptions'
--     and grantee in ('anon', 'authenticated', 'service_role')
--   order by grantee, privilege_type;
--
--   select column_name
--   from information_schema.columns
--   where table_schema = 'public'
--     and table_name = 'subscriptions'
--     and column_name like '%email%';
--   -- expect zero rows
--
-- ══════════════════════════════════════════════════════════════
-- WHAT IS STILL DEFERRED AFTER THIS MIGRATION
-- ══════════════════════════════════════════════════════════════
--
-- EVERYTHING THAT SENDS. No template, no sender, no webhook branch, no
-- route change, no cron change. This table is inert until a later phase
-- writes the code that claims a row, and until then applying this
-- migration changes nothing a customer can observe.
--
-- THE SWEEP. lib/transactionalEmailRetry.ts drives the order families
-- through columns on public.orders. Extending it to these three is a
-- code change in a later phase, and it must keep the one rule that has
-- never moved: eligibility is status = 'failed', and nothing else, ever.
-- 'sending', 'sent' and 'superseded' are all ineligible, and there is no
-- NULL to be tempted by, because a row that does not exist cannot be
-- selected.
--
-- THE PREFLIGHT. Before any provider call, a sender must re-prove that
-- the fact behind its event key is still current: the two cancellation
-- timestamps still match the key, the subscription is still terminally
-- cancelled, the start is still the right thing to say. Where it is not,
-- the row becomes 'superseded' and Resend is never contacted. That is
-- what section 2B exists to make possible, and it is not implemented
-- here.
-- ══════════════════════════════════════════════════════════════
