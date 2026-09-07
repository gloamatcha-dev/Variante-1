-- ============================================================
-- GLOA - Atomic launch signup, and consent history that survives
-- Run in Supabase SQL Editor AFTER 043
--
-- DEPENDS ONLY ON 043, which is live. It does not read, write or alter
-- anything 044 or 045 create, so it can be applied before either of
-- them, after both, or in between.
--
-- 043 IS NOT MODIFIED. No column it created is dropped or retyped, no
-- constraint is altered, no policy is replaced, no row is deleted.
--
-- ============================================================
-- WHAT WAS WRONG
-- ============================================================
--
-- Signing up with an address already on the list was a read in the
-- application followed by an upsert. Two defects came out of that, and
-- both were observed in live data.
--
-- 1. THE CONFIRMED CONSENT WAS DESTROYED BY A FORM SUBMISSION.
--
--    consent_version, consent_text and consent_given_at are the record
--    of what a person was shown and agreed to. The upsert overwrote all
--    three with the CURRENT wording and cleared confirmed_at - so a
--    contact who had confirmed version 1 and later re-submitted the form
--    lost the evidence that they ever confirmed anything.
--
--    The consequences are not theoretical. That person had a valid
--    consent for the launch notification; after the overwrite they read
--    as unconfirmed, would have been skipped by the launch send, and
--    would have been deleted by the retention sweep fourteen days later
--    as "never confirmed". Article 7(1) GDPR requires the controller to
--    be able to DEMONSTRATE consent; a form re-submission had been
--    quietly deleting that demonstration.
--
-- 2. THE DECISION WAS NOT ATOMIC.
--
--    Read and write were separate statements. A confirmation click
--    landing between them could be overwritten by the upsert, undoing a
--    confirmation the person had just made.
--
-- ============================================================
-- HOW IT IS FIXED
-- ============================================================
--
-- THE CONFIRMED CONSENT AND THE PROPOSED ONE ARE NOW DIFFERENT COLUMNS.
--
--   consent_version / consent_text / consent_given_at
--       The consent that is IN FORCE. Written only when somebody
--       actually confirms. Never touched by a signup.
--
--   pending_consent_version / pending_consent_text /
--   pending_consent_given_at
--       A newer wording this person has been ASKED to accept and has
--       not yet confirmed. Carries no permission of any kind.
--
-- So a contact confirmed under version 1 who re-submits the form keeps
-- status 'confirmed' and keeps version 1 in force - they remain entitled
-- to exactly what they agreed to, the launch notification - while
-- version 2 sits in the pending columns until they click the new link.
-- If they never click it, nothing is lost and nothing is gained: no
-- demotion, no deletion, and no discount mail.
--
-- THE WHOLE DECISION IS ONE STATEMENT UNDER A ROW LOCK. Section 2 takes
-- `for update` on the existing row before deciding, so two concurrent
-- submissions are serialised rather than racing. There is always exactly
-- one valid confirmation link - the most recently issued one - and which
-- one that is is determined by lock order, not by chance.
--
-- THIS FILE IS EXPLICITLY TRANSACTIONAL. RUN IT AS ONE EXECUTION.
-- ============================================================

begin;

-- 1. THE PROPOSED CONSENT ---------------------------------------
--
-- All nullable. Every row 043 already holds stays valid, and a row with
-- nothing pending is the normal case.

alter table public.launch_waitlist
  add column if not exists pending_consent_version text
    check (pending_consent_version is null or length(pending_consent_version) between 1 and 200),
  add column if not exists pending_consent_text text
    check (pending_consent_text is null or length(pending_consent_text) between 1 and 4000),
  add column if not exists pending_consent_given_at timestamptz;

-- 1b. THE PERMANENT RECORD OF CONFIRMED CONSENTS ----------------
--
-- WHY THE COLUMNS ON THE ROW ARE NOT ENOUGH.
--
-- consent_version, consent_text and consent_given_at describe the
-- consent CURRENTLY in force. When somebody confirms a newer wording,
-- those three are overwritten - correctly, because the newer wording is
-- now the one that governs. What is lost in that moment is the proof of
-- the EARLIER one: that this person confirmed version 1, on that day,
-- to that exact text.
--
-- Article 7(1) GDPR requires the controller to be able to demonstrate
-- that consent was given. "Was given" is past tense, and a column that
-- only ever holds the current value cannot answer it. A withdrawal
-- dispute, a complaint, or a question about who was entitled to the
-- launch mail three weeks ago all need the history, not the snapshot.
--
-- WHAT GOES IN, AND WHEN.
--
-- One row per CONFIRMATION, written by confirm_launch_signup at the
-- moment a consent takes effect - see section 3. Nothing else writes
-- here.
--
-- A PENDING WORDING NEVER REACHES THIS TABLE. Being shown a text and
-- ticking a box is a request; it becomes a consent when the link in the
-- mail is clicked, and not before. Recording proposals here would turn
-- the evidence log into a log of things people were asked, which is
-- exactly the confusion it exists to prevent.
--
-- IT IS APPEND-ONLY. service_role is granted select and insert and
-- nothing else - no update, no delete. Evidence that can be edited is
-- not evidence, and the grant is where that is enforced rather than in
-- a comment. The rows carry no token, no IP address and no marketing
-- flag: the address is reachable through waitlist_id and nothing here
-- duplicates it.

create table if not exists public.launch_consent_history (
  id              uuid primary key default gen_random_uuid(),

  -- Cascades, so deleting a waitlist entry - which the retention rule
  -- and an erasure request both do - takes its consent record with it.
  -- Keeping consent evidence for somebody whose data was erased would
  -- be the wrong kind of thorough.
  waitlist_id     uuid not null references public.launch_waitlist(id) on delete cascade,

  -- The wording that took effect, stored in full. Not a reference to a
  -- constant in a deployment that will be replaced.
  consent_version text not null check (length(consent_version) between 1 and 200),
  consent_text    text not null check (length(consent_text) between 1 and 4000),

  -- When the person submitted the form, and when they confirmed it. Two
  -- different facts, both required: the gap between them is the double
  -- opt-in, and collapsing them would hide it.
  given_at        timestamptz not null,
  confirmed_at    timestamptz not null,

  -- When this row was written. Distinct from confirmed_at so a backfill
  -- is visibly a backfill and never looks like a live confirmation.
  recorded_at     timestamptz not null default now()
);

create index if not exists idx_launch_consent_history_waitlist
  on public.launch_consent_history (waitlist_id, confirmed_at desc);

alter table public.launch_consent_history enable row level security;

-- Append-only, and server-side only. No update and no delete for
-- anybody, including service_role.
grant select, insert on public.launch_consent_history to service_role;

-- BACKFILL FOR CONSENTS ALREADY CONFIRMED.
--
-- Only rows that CARRY a confirmation already - confirmed_at is not
-- null - and only with the values those rows actually hold. Nothing is
-- invented, nothing is dated to a time that was not recorded, and a row
-- that was never confirmed gets no entry.
--
-- recorded_at is now(), not confirmed_at: this row is being written
-- today from evidence that already existed, and pretending otherwise
-- would be the one thing a consent log must never do.
--
-- Guarded by the not-exists, so re-running the migration cannot
-- duplicate an entry.
insert into public.launch_consent_history
  (waitlist_id, consent_version, consent_text, given_at, confirmed_at)
select w.id, w.consent_version, w.consent_text,
       coalesce(w.consent_given_at, w.confirmed_at), w.confirmed_at
  from public.launch_waitlist w
 where w.confirmed_at is not null
   and not exists (
     select 1 from public.launch_consent_history h
      where h.waitlist_id = w.id
        and h.confirmed_at = w.confirmed_at
   );

-- 2. THE ONE WAY TO SIGN UP -------------------------------------
--
-- Replaces the read-then-upsert entirely. Returns what it did, so the
-- caller knows whether to send a confirmation mail - and nothing else,
-- so the caller cannot learn anything about an address it did not
-- already have.
--
-- THE FIVE OUTCOMES
--
--   created          no such row. Inserted as pending. Send the mail.
--
--   refreshed        the row needs this person to confirm: either it was
--                    never confirmed, or it is confirmed under an older
--                    wording than the one just shown. New tokens, the
--                    proposed consent is stored in the pending columns,
--                    and THE IN-FORCE CONSENT IS LEFT ALONE. Send the
--                    mail.
--
--   already_current  confirmed (or notified) under exactly this wording.
--                    Nothing is written. Send nothing: this person is on
--                    the list, and another confirmation link is how
--                    somebody ends up clicking one that changes their
--                    state for the worse.
--
--   withdrawn        consent was taken back. A withdrawal is not undone
--                    by typing an address into a form. Nothing written,
--                    nothing sent.
--
-- Note that 'notified' is treated exactly like 'confirmed' throughout:
-- it is a confirmed row whose one launch mail has been used, and a
-- re-submission must never reopen it.

create or replace function public.submit_launch_signup(
  p_email text,
  p_first_name text,
  p_audience_type text,
  p_source text,
  p_consent_version text,
  p_consent_text text,
  p_confirmation_token_hash text,
  p_withdrawal_token_hash text
)
returns text
language plpgsql
security definer set search_path = ''
as $$
declare
  v_row  public.launch_waitlist%rowtype;
  v_now  timestamptz := now();
begin
  if p_email is null or p_consent_version is null or p_consent_text is null then
    raise exception 'launch signup: email and consent are required';
  end if;
  if p_confirmation_token_hash !~ '^[0-9a-f]{64}$'
     or p_withdrawal_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'launch signup: token hashes must be 64-character hex digests';
  end if;

  -- THE LOCK. Everything below is decided against a row nobody else can
  -- change until this transaction ends.
  select * into v_row
    from public.launch_waitlist
   where email = p_email
     for update;

  -- ── NEW ADDRESS ─────────────────────────────────────────────
  if not found then
    insert into public.launch_waitlist (
      email, first_name, audience_type, purpose, status, source,
      consent_version, consent_text, consent_given_at,
      confirmation_token_hash, confirmation_sent_at, withdrawal_token_hash
    ) values (
      p_email, p_first_name, p_audience_type, 'launch_notification', 'pending', p_source,
      -- A brand new row has no consent in force yet. The wording it was
      -- shown goes straight into the in-force columns because confirming
      -- is what will put it into force, and there is nothing older to
      -- protect.
      p_consent_version, p_consent_text, v_now,
      p_confirmation_token_hash, v_now, p_withdrawal_token_hash
    )
    -- Belt and braces against a concurrent insert that beat the lock:
    -- the unique constraint on email is still the real guard.
    on conflict (email) do nothing;

    if not found then
      -- Somebody else inserted it between the select and the insert.
      -- Report it as already current rather than pretending to have
      -- created it; the caller sends nothing and the other request's
      -- mail carries the live token.
      return 'already_current';
    end if;
    return 'created';
  end if;

  -- ── WITHDRAWN ───────────────────────────────────────────────
  -- Checked on both marks: either alone means withdrawn.
  if v_row.status = 'withdrawn' or v_row.withdrawn_at is not null then
    return 'withdrawn';
  end if;

  -- ── ALREADY ON THE LIST UNDER THIS EXACT WORDING ────────────
  if v_row.status in ('confirmed', 'notified')
     and v_row.consent_version = p_consent_version then
    return 'already_current';
  end if;

  -- ── NEEDS CONFIRMING ────────────────────────────────────────
  --
  -- Either unconfirmed, or confirmed under an older wording. The
  -- difference between those two is the whole point of this branch:
  --
  --   unconfirmed        status stays 'pending'. There is no consent in
  --                      force, so the wording just shown may occupy the
  --                      in-force columns - confirming is what will
  --                      activate it.
  --
  --   confirmed under    STATUS IS LEFT AS IT IS and the in-force
  --   an older wording   consent is LEFT AS IT IS. This person is still
  --                      entitled to exactly what they agreed to. The
  --                      new wording waits in the pending columns and
  --                      becomes real only when they confirm it.
  --
  -- This is what stops a form submission from either demoting somebody
  -- or silently widening their consent.
  if v_row.status in ('confirmed', 'notified') then
    update public.launch_waitlist
       set first_name               = coalesce(p_first_name, first_name),
           audience_type            = coalesce(p_audience_type, audience_type),
           pending_consent_version  = p_consent_version,
           pending_consent_text     = p_consent_text,
           pending_consent_given_at = v_now,
           confirmation_token_hash  = p_confirmation_token_hash,
           confirmation_sent_at     = v_now,
           withdrawal_token_hash    = p_withdrawal_token_hash
     where id = v_row.id;
  else
    update public.launch_waitlist
       set first_name               = p_first_name,
           audience_type            = p_audience_type,
           source                   = p_source,
           status                   = 'pending',
           consent_version          = p_consent_version,
           consent_text             = p_consent_text,
           consent_given_at         = v_now,
           -- An unconfirmed row has nothing in force, so nothing waits.
           pending_consent_version  = null,
           pending_consent_text     = null,
           pending_consent_given_at = null,
           -- Pending means unconfirmed. A confirmed_at here would be the
           -- inconsistency this migration exists to end.
           confirmed_at             = null,
           confirmation_token_hash  = p_confirmation_token_hash,
           confirmation_sent_at     = v_now,
           withdrawal_token_hash    = p_withdrawal_token_hash
     where id = v_row.id;
  end if;

  return 'refreshed';
end;
$$;

-- 3. CONFIRMING -------------------------------------------------
--
-- Promotes the proposed consent to the one in force, in the same
-- statement that spends the token.
--
-- IT IS THE ONLY PLACE A CONSENT BECOMES EFFECTIVE. Not the signup, not
-- the form, not an admin - clicking the link in a mail sent to that
-- address. That is what makes it a double opt-in.
--
-- Returns the outcome and, for the caller's benefit, the consent version
-- that is now in force. The caller uses that to decide whether a welcome
-- mail is due; it does not decide it here, so this function stays
-- independent of migration 045.

create or replace function public.confirm_launch_signup(
  p_token_hash text,
  p_ttl_days integer default 14
)
returns table (outcome text, row_id uuid, effective_consent_version text)
language plpgsql
security definer set search_path = ''
as $$
declare
  v_row     public.launch_waitlist%rowtype;
  v_now     timestamptz := now();
  v_status  text;
  v_version text;
  v_text    text;
  v_given   timestamptz;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    return query select 'invalid'::text, null::uuid, null::text;
    return;
  end if;

  select * into v_row
    from public.launch_waitlist
   where confirmation_token_hash = p_token_hash
     for update;

  if not found then
    return query select 'invalid'::text, null::uuid, null::text;
    return;
  end if;

  if v_row.status = 'withdrawn' or v_row.withdrawn_at is not null then
    return query select 'withdrawn'::text, v_row.id, v_row.consent_version;
    return;
  end if;

  if v_row.confirmation_sent_at is null
     or v_row.confirmation_sent_at < v_now - make_interval(days => p_ttl_days) then
    return query select 'expired'::text, v_row.id, v_row.consent_version;
    return;
  end if;

  -- ── THE STATUS A CONFIRMATION MAY SET ───────────────────────
  --
  -- 'notified' IS TERMINAL AND STAYS TERMINAL.
  --
  -- This function used to write 'confirmed' unconditionally, which was
  -- wrong for one row in particular: somebody who has already received
  -- the launch announcement, then re-submits the form (getting a fresh
  -- token while keeping status 'notified'), then clicks it. That would
  -- have moved a spent row back to 'confirmed'.
  --
  -- The launch send itself would still have refused them -
  -- launch_notification_sent_at is set and both the claim in 044 and
  -- mayReceiveLaunchNotification() test it - so no second announcement
  -- could have gone out. But the status would have been a lie, and
  -- mayReceiveWelcomeEmail() reads exactly that status: a spent contact
  -- would have become eligible for the welcome mail and its discount
  -- code, weeks after the launch it was written for.
  --
  -- So a consent confirmation records the consent and nothing else. It
  -- never rewinds the lifecycle.
  v_status := case when v_row.status = 'notified' then 'notified' else 'confirmed' end;

  -- What is actually taking effect. Null-safe: an ordinary first
  -- confirmation has nothing pending and the in-force columns already
  -- hold the right values.
  v_version := coalesce(v_row.pending_consent_version, v_row.consent_version);
  v_text    := coalesce(v_row.pending_consent_text, v_row.consent_text);
  v_given   := coalesce(v_row.pending_consent_given_at, v_row.consent_given_at);

  update public.launch_waitlist
     set status = v_status,
         confirmed_at = v_now,
         consent_version = v_version,
         consent_text = v_text,
         consent_given_at = v_given,
         pending_consent_version = null,
         pending_consent_text = null,
         pending_consent_given_at = null,
         -- Spent in the same statement, so the link works exactly once.
         confirmation_token_hash = null
   where id = v_row.id;

  -- ── THE PERMANENT RECORD ────────────────────────────────────
  --
  -- Written HERE and only here, because this is the only moment a
  -- consent becomes effective. A row in launch_consent_history means
  -- "this person confirmed this wording at this time" and nothing else -
  -- a pending wording never reaches it, because a pending wording is not
  -- a consent.
  --
  -- The columns above will be overwritten by the NEXT confirmation; this
  -- table is what makes the earlier one still provable afterwards.
  insert into public.launch_consent_history
    (waitlist_id, consent_version, consent_text, given_at, confirmed_at)
  values
    (v_row.id, v_version, v_text, v_given, v_now);

  return query select 'confirmed'::text, v_row.id, v_version;
end;
$$;

-- 4. PRIVILEGES -------------------------------------------------
--
-- Server-only, same posture as 043. A browser role that could call
-- submit_launch_signup could write consent records for addresses it does
-- not control; one that could call confirm_launch_signup could confirm
-- somebody else's entry by guessing.

revoke all on function public.submit_launch_signup(text, text, text, text, text, text, text, text) from public;
revoke all on function public.submit_launch_signup(text, text, text, text, text, text, text, text) from anon;
revoke all on function public.submit_launch_signup(text, text, text, text, text, text, text, text) from authenticated;
grant execute on function public.submit_launch_signup(text, text, text, text, text, text, text, text) to service_role;

revoke all on function public.confirm_launch_signup(text, integer) from public;
revoke all on function public.confirm_launch_signup(text, integer) from anon;
revoke all on function public.confirm_launch_signup(text, integer) from authenticated;
grant execute on function public.confirm_launch_signup(text, integer) to service_role;

commit;

-- VERIFY (read-only, commented out; run separately):
--
--   -- The new columns exist and every existing row has nothing pending:
--   select count(*) filter (where pending_consent_version is null) as nothing_pending,
--          count(*) as total
--     from public.launch_waitlist;
--
--   -- No row may read as pending while carrying a confirmed_at. This
--   -- must be zero, now and after every signup:
--   select count(*) from public.launch_waitlist
--    where status = 'pending' and confirmed_at is not null;
--
--   -- Which consent is actually in force, per version:
--   select consent_version, status, count(*)
--     from public.launch_waitlist
--    group by consent_version, status
--    order by consent_version, status;
