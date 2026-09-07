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
-- So the claim is one conditional UPDATE. Exactly one caller can move
-- the row from unclaimed to claimed; the other is told no and sends
-- nothing. The consent version is checked HERE as well as in the
-- application, so a caller that forgot cannot get a v1 row out of it.

create or replace function public.claim_welcome_email(
  p_id uuid,
  p_claim_id uuid,
  p_consent_version text,
  p_stale_seconds integer default 900
)
returns boolean
language plpgsql
security definer set search_path = ''
as $$
declare
  v_updated integer;
begin
  if p_claim_id is null or p_consent_version is null then
    raise exception 'welcome mail: a claim id and a consent version are required';
  end if;

  update public.launch_waitlist
     set welcome_email_claim_id   = p_claim_id,
         welcome_email_claimed_at = now()
   where id = p_id
     and status = 'confirmed'
     and purpose = 'launch_notification'
     and withdrawn_at is null
     -- THE CONSENT GATE. Only the wording that names this mail.
     and consent_version = p_consent_version
     and welcome_email_sent_at is null
     and welcome_email_needs_review is not true
     and (
       welcome_email_claim_id is null
       or welcome_email_claimed_at < now() - make_interval(secs => p_stale_seconds)
     );

  get diagnostics v_updated = row_count;
  return v_updated = 1;
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

revoke all on function public.claim_welcome_email(uuid, uuid, text, integer) from public;
revoke all on function public.claim_welcome_email(uuid, uuid, text, integer) from anon;
revoke all on function public.claim_welcome_email(uuid, uuid, text, integer) from authenticated;
grant execute on function public.claim_welcome_email(uuid, uuid, text, integer) to service_role;

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
