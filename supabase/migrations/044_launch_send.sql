-- ============================================================
-- GLOA - The one-time launch announcement send
-- Run in Supabase SQL Editor AFTER 001-043
--
-- Additive only. 043 IS ALREADY APPLIED IN PRODUCTION AND IS NOT
-- TOUCHED BY THIS FILE: no column it created is dropped or retyped, no
-- constraint it wrote is altered, no policy it set is replaced, and no
-- row it holds is deleted. This file adds columns, one table, three
-- functions and two indexes, and nothing else.
--
-- WHAT PROBLEM THIS SOLVES
-- ------------------------
-- 043 gave the waitlist everything needed to decide WHETHER a person may
-- receive the launch mail: status, purpose, launch_notification_sent_at,
-- and mayReceiveLaunchNotification() in lib/launchWaitlist.ts as the one
-- gate. What it did not give is a safe way to actually run the send.
--
-- The naive version - select the confirmed rows, loop, send, update - is
-- wrong in production in four separate ways, and every one of them ends
-- with somebody receiving the same announcement twice:
--
--   1. TWO WORKERS. A serverless platform will happily run two copies of
--      the same request. Both select the same rows, both send.
--   2. A RETRY. The runtime times out at 60s after 900 mails have gone
--      out, the caller retries, and those 900 are still unmarked.
--   3. A DEPLOY. A new deployment lands mid-send and the old instance is
--      discarded between "sent" and "updated".
--   4. A CRASH between the send and the update, for any reason at all.
--
-- What is missing in all four is a RESERVATION: a row must be claimed by
-- exactly one worker, atomically, before any mail is sent - and a claim
-- that dies has to become reclaimable without a human deciding which of
-- 2000 rows were really delivered.
--
-- Section 3 is that reservation. It is one UPDATE ... FROM (SELECT ...
-- FOR UPDATE SKIP LOCKED) statement, which is the standard Postgres
-- queue claim: concurrent callers skip each other's locked rows instead
-- of blocking on them or racing through them, so two workers cannot
-- claim the same row no matter how they are scheduled.
--
-- THE SEND IS STILL NOT ALLOWED TO START BY ITSELF
-- ------------------------------------------------
-- Section 2 adds public.launch_release: one row, holding one boolean
-- that a person sets. Reaching 1 October at 12:00 does not set it, no
-- cron sets it, and no code in this repository sets it. A timer that
-- mailed the entire list because a clock rolled over - while the shop
-- was down, or the stock was wrong, or the payment path was broken -
-- is precisely the failure this table exists to make impossible.
--
-- The release is a fact about the world (the shop works, and we say go),
-- so it is recorded the way facts are: written once, deliberately, by
-- somebody who is accountable for it, and readable afterwards.
--
-- THIS FILE IS EXPLICITLY TRANSACTIONAL. Every executable statement
-- sits between the begin; below and the commit; at the end.
--
-- RUN THE WHOLE FILE AS ONE EXECUTION. Do not run sections separately
-- and do not use "run selection". Do not wrap it in a second
-- transaction; Postgres does not nest them.
-- ============================================================

begin;

-- 1. THE CLAIM COLUMNS -----------------------------------------
--
-- Added to the existing table rather than kept in a side table, because
-- the claim and the "already sent" watermark have to be decided in ONE
-- statement against ONE row. Split across two tables they would need a
-- transaction spanning both, which is the gap this is meant to close.
--
-- All four are nullable or defaulted, so every row 043 already holds
-- stays valid and no existing read is affected.

alter table public.launch_waitlist
  -- Which worker holds this row. Null means unclaimed. A worker may only
  -- mark a row sent if it still holds the claim it was given.
  add column if not exists launch_send_claim_id uuid,

  -- When the claim was taken. A claim older than the caller's stale
  -- window is treated as abandoned and may be taken again - that is what
  -- makes a crashed worker recoverable without a human.
  add column if not exists launch_send_claimed_at timestamptz,

  -- How many times this row has been claimed. Bounded retries: a row
  -- that keeps failing must not be retried forever, and the count is
  -- what lets the caller stop.
  add column if not exists launch_send_attempts integer not null default 0,

  -- Why the last attempt failed. A PROVIDER MESSAGE ONLY - never an
  -- address, never a token, never a name. It exists so an operator can
  -- tell "mailbox full" from "domain not verified" without opening a log.
  add column if not exists launch_send_failed_reason text;

-- The claim query's index: confirmed, not yet notified, ordered by when
-- consent was given so the earliest supporters are mailed first.
create index if not exists idx_launch_waitlist_send_claimable
  on public.launch_waitlist (confirmed_at)
  where status = 'confirmed' and launch_notification_sent_at is null;

-- Lets a stuck claim be found without scanning the table.
create index if not exists idx_launch_waitlist_send_claimed
  on public.launch_waitlist (launch_send_claimed_at)
  where launch_send_claim_id is not null;

-- 2. THE HUMAN RELEASE -----------------------------------------
--
-- One row, forever. The primary key is a boolean constrained to true, so
-- a second row cannot be inserted: there is one launch, and "is the
-- launch released?" must have exactly one answer rather than becoming a
-- question about which row to read.

create table if not exists public.launch_release (
  id           boolean primary key default true check (id),

  -- The gate. False until a person sets it.
  released     boolean not null default false,

  -- When, and who said so. Free text on purpose: this is an operator's
  -- name or initials for the record, not an identifier the code reads.
  released_at  timestamptz,
  released_by  text check (released_by is null or length(released_by) between 1 and 200),

  -- Why it was released, or why it was stopped again. The audit trail a
  -- post-mortem would want.
  note         text check (note is null or length(note) <= 2000),

  updated_at   timestamptz not null default now()
);

insert into public.launch_release (id, released)
values (true, false)
on conflict (id) do nothing;

alter table public.launch_release enable row level security;

-- Same posture as 043: server-only. No policy and no grant for anon or
-- authenticated, so no browser can read whether the launch is released -
-- and, far more importantly, none can set it.
grant select, insert, update on public.launch_release to service_role;

-- 3. THE CLAIM -------------------------------------------------
--
-- THE ONLY WAY A ROW MAY BE PREPARED FOR SENDING.
--
-- One statement. The inner SELECT takes row locks with SKIP LOCKED, so a
-- second worker arriving at the same instant sees those rows as taken
-- and moves past them rather than waiting or duplicating. The outer
-- UPDATE stamps the claim. There is no window between deciding and
-- claiming, because they are the same statement.
--
-- IT REFUSES TO CLAIM ANYTHING AT ALL UNLESS THE LAUNCH IS RELEASED.
-- That check is here, inside the function, rather than only in the
-- application: a caller that forgot it - a stray script, a future
-- endpoint, a retry against an old deployment - still cannot get a row
-- out of this function.
--
-- WHO IT SELECTS, and the rule is exactly mayReceiveLaunchNotification:
--
--   status = 'confirmed'                double opt-in completed
--   purpose = 'launch_notification'     the only purpose these rows carry
--   launch_notification_sent_at is null this consent is unused
--   withdrawn_at is null                belt and braces with the status
--
-- so pending, withdrawn and already-notified rows are unreachable from
-- here by construction, not by the caller remembering to filter.
--
-- A WITHDRAWAL THAT LANDS FIRST WINS. The withdraw route sets status to
-- 'withdrawn' in its own transaction; from that moment this function
-- cannot see the row. The window that remains is the milliseconds
-- between a claim and the provider accepting that one message, which no
-- design can close - and it is small because the caller sends
-- immediately after claiming rather than claiming the whole list up
-- front.

create or replace function public.claim_launch_notifications(
  p_claim_id uuid,
  p_limit integer,
  p_stale_seconds integer default 900,
  p_max_attempts integer default 3
)
returns table (id uuid, email text, first_name text, attempts integer)
language plpgsql
security definer set search_path = ''
as $$
declare
  v_released boolean;
begin
  if p_claim_id is null then
    raise exception 'launch send: a claim id is required';
  end if;

  if p_limit is null or p_limit < 1 or p_limit > 500 then
    raise exception 'launch send: batch size must be between 1 and 500';
  end if;

  if p_stale_seconds is null or p_stale_seconds < 60 then
    raise exception 'launch send: the stale window must be at least 60 seconds';
  end if;

  -- THE GATE. No release, no rows - whatever the caller intended.
  select r.released into v_released from public.launch_release r where r.id is true;
  if v_released is not true then
    return;
  end if;

  return query
  update public.launch_waitlist w
     set launch_send_claim_id   = p_claim_id,
         launch_send_claimed_at = now(),
         launch_send_attempts   = w.launch_send_attempts + 1
    from (
      select c.id
        from public.launch_waitlist c
       where c.status = 'confirmed'
         and c.purpose = 'launch_notification'
         and c.launch_notification_sent_at is null
         and c.withdrawn_at is null
         and c.launch_send_attempts < p_max_attempts
         -- Unclaimed, or claimed by a worker that has since died.
         and (
           c.launch_send_claim_id is null
           or c.launch_send_claimed_at < now() - make_interval(secs => p_stale_seconds)
         )
       order by c.confirmed_at
       limit p_limit
       for update skip locked
    ) picked
   where w.id = picked.id
  returning w.id, w.email, w.first_name, w.launch_send_attempts;
end;
$$;

-- 4. FINISHING A ROW -------------------------------------------
--
-- Marks the one message this consent covers as delivered, and closes the
-- row for good: status becomes 'notified', which
-- mayReceiveLaunchNotification() already refuses to send to.
--
-- THE CLAIM IS CHECKED. A worker whose claim expired and was taken by
-- somebody else cannot mark the row - it updates nothing and reports
-- false, and the caller knows its send was a duplicate rather than
-- silently overwriting the other worker's work.
--
-- IT IS IDEMPOTENT. A row already carrying launch_notification_sent_at
-- is not written again, so a retry cannot move the watermark or reset
-- the status.

create or replace function public.mark_launch_notification_sent(
  p_id uuid,
  p_claim_id uuid
)
returns boolean
language plpgsql
security definer set search_path = ''
as $$
declare
  v_updated integer;
begin
  update public.launch_waitlist
     set launch_notification_sent_at = now(),
         status                      = 'notified',
         launch_send_claim_id        = null,
         launch_send_claimed_at      = null,
         launch_send_failed_reason   = null
   where id = p_id
     and launch_send_claim_id = p_claim_id
     and launch_notification_sent_at is null;

  get diagnostics v_updated = row_count;
  return v_updated = 1;
end;
$$;

-- 5. GIVING A ROW BACK -----------------------------------------
--
-- The provider refused, or the worker is stopping. The claim is dropped
-- so the row can be retried, and the reason is recorded.
--
-- The attempt count is NOT decremented: a row that fails repeatedly must
-- eventually stop being retried, and that is what p_max_attempts above
-- reads. The reason is truncated here rather than trusted - it comes
-- from a provider and has no business being unbounded - and the caller
-- is responsible for passing a provider message and not an address.

create or replace function public.release_launch_notification_claim(
  p_id uuid,
  p_claim_id uuid,
  p_reason text default null
)
returns boolean
language plpgsql
security definer set search_path = ''
as $$
declare
  v_updated integer;
begin
  update public.launch_waitlist
     set launch_send_claim_id      = null,
         launch_send_claimed_at    = null,
         launch_send_failed_reason = left(p_reason, 500)
   where id = p_id
     and launch_send_claim_id = p_claim_id
     and launch_notification_sent_at is null;

  get diagnostics v_updated = row_count;
  return v_updated = 1;
end;
$$;

-- 6. PRIVILEGES ------------------------------------------------
--
-- Only the server-side secret key may claim, mark or release. anon and
-- authenticated are revoked explicitly rather than relying on the
-- default, exactly as 038, 040 and 043 do.

revoke all on function public.claim_launch_notifications(uuid, integer, integer, integer) from public;
revoke all on function public.claim_launch_notifications(uuid, integer, integer, integer) from anon;
revoke all on function public.claim_launch_notifications(uuid, integer, integer, integer) from authenticated;
grant execute on function public.claim_launch_notifications(uuid, integer, integer, integer) to service_role;

revoke all on function public.mark_launch_notification_sent(uuid, uuid) from public;
revoke all on function public.mark_launch_notification_sent(uuid, uuid) from anon;
revoke all on function public.mark_launch_notification_sent(uuid, uuid) from authenticated;
grant execute on function public.mark_launch_notification_sent(uuid, uuid) to service_role;

revoke all on function public.release_launch_notification_claim(uuid, uuid, text) from public;
revoke all on function public.release_launch_notification_claim(uuid, uuid, text) from anon;
revoke all on function public.release_launch_notification_claim(uuid, uuid, text) from authenticated;
grant execute on function public.release_launch_notification_claim(uuid, uuid, text) to service_role;

commit;

-- VERIFY (read-only, commented out; run separately):
--
--   select released, released_at, released_by from public.launch_release;
--
--   -- Who would receive the announcement, as a count and nothing more:
--   select status, count(*) from public.launch_waitlist group by status;
--
--   -- The claim returns NOTHING while the launch is unreleased, which is
--   -- the whole point. This is safe to run today:
--   select * from public.claim_launch_notifications(gen_random_uuid(), 1);
