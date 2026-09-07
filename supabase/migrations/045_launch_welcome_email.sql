-- ============================================================
-- GLOA - The welcome mail carrying the launch discount code
-- Run in Supabase SQL Editor AFTER 001-044
--
-- Additive only. 043 IS LIVE AND IS NOT TOUCHED. 044 is a separate,
-- still-unapplied migration for the launch SEND; this file does not
-- depend on it, does not alter anything it creates, and the two can be
-- applied in either order.
--
-- WHAT THIS IS FOR
-- ----------------
-- After somebody confirms their address, GLOA now sends ONE more
-- message: a welcome mail carrying the shared launch discount code.
-- That is a second mail, and it carries an offer, so it needed a new
-- consent wording before it needed a column - see
-- LAUNCH_CONSENT_VERSION in lib/launchWaitlist.ts.
--
-- THIS MIGRATION DOES NOT GRANT ANYTHING. It adds a watermark and a
-- claim. Whether a given person may receive the mail at all is decided
-- by mayReceiveWelcomeEmail() in lib/launchWaitlist.ts, and the decisive
-- condition is the consent version stored on their own row:
--
--   v2  yes - they were shown a wording that names this mail
--   v1  NO  - they were promised one launch notification and no offers
--
-- Rows signed under v1 are therefore untouched by this feature forever.
-- Nothing here rewrites a consent_version, and nothing may: that column
-- is the record of what a person was actually shown.
--
-- THIS FILE IS EXPLICITLY TRANSACTIONAL. RUN IT AS ONE EXECUTION.
-- ============================================================

begin;

-- 1. THE WATERMARK ---------------------------------------------
--
-- Null means the welcome mail has not gone out. Set once, never reset -
-- the same shape as launch_notification_sent_at, and for the same
-- reason: it is what makes "send this once" a fact about the row rather
-- than a hope about the code.

alter table public.launch_waitlist
  add column if not exists welcome_email_sent_at timestamptz,

  -- Held between deciding to send and the provider answering. A claim
  -- older than the caller's window is treated as abandoned, exactly as
  -- in 044.
  add column if not exists welcome_email_claim_id uuid,
  add column if not exists welcome_email_claimed_at timestamptz,

  -- Set when an attempt ended without a usable answer. Excluded from the
  -- claim below and never retried automatically, for the reason written
  -- out in 044 section 5b: the provider's idempotency key expires after
  -- 24 hours, so a blind retry past that point is a second mail.
  add column if not exists welcome_email_needs_review boolean not null default false,
  add column if not exists welcome_email_failed_reason text;

-- Supports the claim: confirmed, consented under v2, not yet sent.
create index if not exists idx_launch_waitlist_welcome_pending
  on public.launch_waitlist (confirmed_at)
  where status = 'confirmed' and welcome_email_sent_at is null;

-- 2. CLAIMING ONE WELCOME MAIL ---------------------------------
--
-- The welcome mail is sent from the CONFIRM route, immediately after a
-- person clicks their link - so unlike the launch send there is no
-- batch, no worker and no queue. What there is, is a double click.
--
-- A confirmation link opened twice, or opened once by a mail client's
-- link scanner and once by the person, arrives as two concurrent
-- requests for the same row. Without a claim both would see
-- welcome_email_sent_at as null and both would send.
--
-- ── THE CONSENT VERSION IS NOT A PARAMETER ANY MORE ───────────
--
-- It used to be, and that was a hole. `and consent_version =
-- p_consent_version` lets the CALLER decide which wording counts, so
-- anything able to execute this function could pass the version 1 string
-- and claim a version 1 contact for a mail carrying an offer they never
-- agreed to receive. A gate the caller supplies the key to is not a
-- gate.
--
-- The version that permits this mail is therefore written here, as a
-- literal. It must equal LAUNCH_CONSENT_VERSION in lib/launchWaitlist.ts
-- and tests/launch-waitlist.test.mjs asserts that the two agree, so the
-- repetition is checked on every run rather than trusted.
--
-- ── AN EXPIRED CLAIM IS NOT A FREE RETRY ──────────────────────
--
-- The stale window used to hand an abandoned claim to the next caller.
-- That is right for work that was never started and wrong for work that
-- may already have finished: a worker that died AFTER the provider
-- accepted the message leaves exactly the same trace as one that died
-- before it, and the difference cannot be recovered from this table.
--
-- Resend keeps an idempotency key for 24 hours. Inside that window a
-- repeat is genuinely safe. A stale claim can be far older than that -
-- a process that crashed and was replaced hours later - so re-sending
-- on the strength of an expired claim is a coin flip between a missing
-- mail and a duplicate one.
--
-- So an expired claim is PARKED, not reissued: the row is marked for
-- review, this call returns claimed=false, and a person reconciles it
-- against the provider's delivery log. That is deliberately
-- conservative - a crash before the send also parks the row - because
-- the cost of being wrong in the other direction is a mail somebody
-- never consented to receive twice.

create or replace function public.claim_welcome_email(
  p_id uuid,
  p_claim_id uuid,
  p_stale_seconds integer default 900
)
-- Returns the recipient WITH the claim, so a successful claim and the
-- data needed to send are one round trip rather than two. A caller that
-- did not win the claim gets claimed=false and no address at all - it
-- has no business knowing who it lost to.
returns table (claimed boolean, email text, first_name text)
language plpgsql
security definer set search_path = ''
as $$
declare
  v_updated integer;
  v_email text;
  v_first_name text;
  v_stale integer;
begin
  if p_claim_id is null then
    raise exception 'welcome mail: a claim id is required';
  end if;

  v_stale := greatest(coalesce(p_stale_seconds, 900), 60);

  -- ── EXPIRED CLAIMS ARE PARKED FIRST ─────────────────────────
  -- Before anything can be claimed, an abandoned claim on this row is
  -- turned into a review case. It is never simply taken over.
  update public.launch_waitlist
     set welcome_email_needs_review  = true,
         welcome_email_failed_reason = 'claim expired with an unknown send outcome',
         welcome_email_claim_id      = null,
         welcome_email_claimed_at    = null
   where id = p_id
     and welcome_email_sent_at is null
     and welcome_email_claim_id is not null
     and welcome_email_claimed_at < now() - make_interval(secs => v_stale);

  update public.launch_waitlist
     set welcome_email_claim_id   = p_claim_id,
         welcome_email_claimed_at = now()
   where id = p_id
     and status = 'confirmed'
     and purpose = 'launch_notification'
     and withdrawn_at is null
     -- THE CONSENT GATE, as a literal. Only the wording that names this
     -- mail, and the caller cannot widen it.
     and consent_version = '2026-09-07.launch-notification-with-code.v2'
     and welcome_email_sent_at is null
     and welcome_email_needs_review is not true
     -- Unclaimed only. An expired claim was parked above and is now
     -- excluded by needs_review, so there is no stale branch here.
     and welcome_email_claim_id is null
   returning launch_waitlist.email, launch_waitlist.first_name
        into v_email, v_first_name;

  get diagnostics v_updated = row_count;
  if v_updated = 1 then
    return query select true, v_email, v_first_name;
  else
    return query select false, null::text, null::text;
  end if;
end;
$$;

-- 3. FINISHING, AND PARKING ------------------------------------

create or replace function public.mark_welcome_email_sent(
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
     set welcome_email_sent_at    = now(),
         welcome_email_claim_id   = null,
         welcome_email_claimed_at = null,
         welcome_email_failed_reason = null
   where id = p_id
     and welcome_email_claim_id = p_claim_id
     and welcome_email_sent_at is null;

  get diagnostics v_updated = row_count;
  return v_updated = 1;
end;
$$;

-- Gives the claim back after a refusal that may safely be retried.
create or replace function public.release_welcome_email_claim(
  p_id uuid,
  p_claim_id uuid,
  p_reason text default null,
  p_needs_review boolean default false
)
returns boolean
language plpgsql
security definer set search_path = ''
as $$
declare
  v_updated integer;
begin
  update public.launch_waitlist
     set welcome_email_claim_id      = null,
         welcome_email_claimed_at    = null,
         welcome_email_failed_reason = left(p_reason, 500),
         welcome_email_needs_review  = coalesce(p_needs_review, false)
   where id = p_id
     and welcome_email_claim_id = p_claim_id
     and welcome_email_sent_at is null;

  get diagnostics v_updated = row_count;
  return v_updated = 1;
end;
$$;

-- 4. PRIVILEGES ------------------------------------------------

revoke all on function public.claim_welcome_email(uuid, uuid, integer) from public;
revoke all on function public.claim_welcome_email(uuid, uuid, integer) from anon;
revoke all on function public.claim_welcome_email(uuid, uuid, integer) from authenticated;
grant execute on function public.claim_welcome_email(uuid, uuid, integer) to service_role;

revoke all on function public.mark_welcome_email_sent(uuid, uuid) from public;
revoke all on function public.mark_welcome_email_sent(uuid, uuid) from anon;
revoke all on function public.mark_welcome_email_sent(uuid, uuid) from authenticated;
grant execute on function public.mark_welcome_email_sent(uuid, uuid) to service_role;

revoke all on function public.release_welcome_email_claim(uuid, uuid, text, boolean) from public;
revoke all on function public.release_welcome_email_claim(uuid, uuid, text, boolean) from anon;
revoke all on function public.release_welcome_email_claim(uuid, uuid, text, boolean) from authenticated;
grant execute on function public.release_welcome_email_claim(uuid, uuid, text, boolean) to service_role;

commit;

-- VERIFY (read-only, commented out; run separately):
--
--   -- Nobody signed under v1 can ever be claimed for this mail:
--   select consent_version, count(*) from public.launch_waitlist
--    group by consent_version;
--
--   -- The claim refuses a v1 row even when asked directly:
--   -- select public.claim_welcome_email(
--   --   '<a v1 row id>', gen_random_uuid(),
--   --   '2026-09-07.launch-notification-with-code.v2');   -- returns false
