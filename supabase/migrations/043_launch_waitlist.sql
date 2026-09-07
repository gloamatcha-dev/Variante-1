-- ============================================================
-- GLOA - Launch Waitlist (one-time launch notification)
-- Run in Supabase SQL Editor AFTER 001-042
--
-- Additive only. No existing table, policy, grant or migration is
-- touched by this file.
--
-- WHAT THIS TABLE IS
-- ------------------
-- A list of people who asked to be told, ONCE, that GLOA has opened.
-- Nothing more. It is not a newsletter list, and the privacy notice
-- states in as many words that GLOA does not run a newsletter.
--
-- The purpose is written onto every row and pinned by a CHECK
-- constraint, so a row carrying any other purpose cannot physically
-- exist here. Anything that later wants to send marketing mail needs
-- its own, separately obtained consent and its own table: these rows
-- may not be migrated into a newsletter, CRM, event or retargeting
-- audience, and the constraint is what makes that a schema-level fact
-- rather than a promise in a comment.
--
-- DATA MINIMISATION
-- -----------------
-- Email is required because the notification is an email. First name
-- and audience type are optional and nullable. There is no surname, no
-- phone number, no address, no date of birth, no tracking identifier
-- and no free-text field of any kind - a person can join this list
-- while telling GLOA one thing about themselves.
--
-- THE SECOND TABLE
-- ----------------
-- Section 4 adds public.launch_rate_limit, which is NOT a list of
-- people and shares nothing with the one above. Its reasons are set
-- out where it is defined. It is in this file rather than in a 044
-- because 043 has not been applied anywhere yet, and this repository's
-- rule for that case is written down in
-- tests/one-time-refund-writer-concurrency.test.mjs: an unapplied
-- migration is still the right place to fix itself, and "a hardening
-- pass must not become a second migration".
--
-- THIS FILE IS EXPLICITLY TRANSACTIONAL. Every executable statement
-- sits between the begin; below and the commit; at the end, so the
-- whole migration applies or none of it does. It now creates two
-- tables, four indexes, a trigger and a function, and a partial run
-- would leave the signup endpoint talking to half a schema.
--
-- RUN THE WHOLE FILE AS ONE EXECUTION. Do not run sections separately
-- and do not use "run selection": a partial run would send a BEGIN with
-- no COMMIT, or a COMMIT with no BEGIN. Do not add a second wrapping
-- transaction around it either; Postgres does not nest them.
-- ============================================================

begin;

-- 1. THE TABLE -------------------------------------------------

create table public.launch_waitlist (
  id                          uuid primary key default gen_random_uuid(),

  -- Stored already trimmed and lowercased by lib/launchWaitlist.ts.
  -- The unique constraint is therefore on the normalised value, which
  -- is what stops "Anna@Example.COM" and "anna@example.com" becoming
  -- two rows and two confirmation mails for one person.
  email                       text not null unique
                              check (email = lower(btrim(email))
                                     and length(email) between 3 and 254),

  -- Optional courtesy field. Only used to greet in the mail.
  first_name                  text check (first_name is null or length(first_name) between 1 and 100),

  -- Optional, coarse, self-selected. For internal understanding of who
  -- is waiting - explicitly NOT a lead qualification. Someone picking
  -- 'cafe' has not made a B2B enquiry and must not be routed into one.
  audience_type               text check (audience_type is null or audience_type in (
                                'private', 'cafe', 'studio', 'business', 'other'
                              )),

  -- PURPOSE LIMITATION, ENFORCED BY THE DATABASE.
  purpose                     text not null default 'launch_notification'
                              check (purpose = 'launch_notification'),

  status                      text not null default 'pending'
                              check (status in ('pending', 'confirmed', 'withdrawn', 'notified')),

  -- Closed set, whitelisted server-side before it ever reaches here, so
  -- a QR code can be told from the website without `?source=` becoming
  -- a free-text column any caller can write into.
  source                      text not null default 'launch_page'
                              check (source in ('launch_page', 'homepage', 'qr_flyer', 'event')),

  -- WHAT THIS PERSON ACTUALLY AGREED TO, kept with the row rather than
  -- only in the build that rendered the form. Wording changes bump the
  -- version; older rows keep the text they were really shown.
  consent_version             text not null,
  consent_text                text not null,
  consent_given_at            timestamptz not null default now(),

  -- SHA-256 hex of the opaque token, never the token itself. A dump of
  -- this table must not let anyone confirm or cancel another person's
  -- entry.
  confirmation_token_hash     text check (confirmation_token_hash is null or confirmation_token_hash ~ '^[0-9a-f]{64}$'),
  confirmation_sent_at        timestamptz,
  confirmed_at                timestamptz,

  -- Same shape, separate secret: the one-click withdrawal link in the
  -- mail. Kept after withdrawal so a second click is idempotent rather
  -- than an error.
  withdrawal_token_hash       text check (withdrawal_token_hash is null or withdrawal_token_hash ~ '^[0-9a-f]{64}$'),
  withdrawn_at                timestamptz,

  -- Set when the single launch message this consent covers has gone
  -- out. Once set, this row is done: lib/launchWaitlist.ts
  -- (mayReceiveLaunchNotification) refuses to send to it again, and no
  -- other message is permitted by this consent at all.
  launch_notification_sent_at timestamptz,

  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

-- Token lookup goes through the hash, so it needs to be indexed. Partial,
-- because a withdrawn row keeps a null confirmation hash.
create unique index launch_waitlist_confirmation_token_hash_key
  on public.launch_waitlist (confirmation_token_hash)
  where confirmation_token_hash is not null;

create unique index launch_waitlist_withdrawal_token_hash_key
  on public.launch_waitlist (withdrawal_token_hash)
  where withdrawal_token_hash is not null;

-- Supports the retention job below: find pending rows older than N days.
create index idx_launch_waitlist_pending_created
  on public.launch_waitlist (created_at)
  where status = 'pending';

-- Supports the eventual launch send: the confirmed, not-yet-notified set.
create index idx_launch_waitlist_sendable
  on public.launch_waitlist (confirmed_at)
  where status = 'confirmed' and launch_notification_sent_at is null;

-- Reuses the trigger function created in 001.
create trigger set_launch_waitlist_updated_at
  before update on public.launch_waitlist
  for each row execute function public.set_updated_at();

-- 2. ROW LEVEL SECURITY ----------------------------------------

alter table public.launch_waitlist enable row level security;

-- No SELECT/INSERT/UPDATE/DELETE policy for anon or authenticated, and
-- no grant to either role. This is consent data: it is written and read
-- exclusively by server-side code using the server-only Supabase secret
-- key (lib/supabaseAdmin.ts), exactly as 009 does for checkout attempts.
--
-- In particular there is deliberately NO public insert policy. An
-- anonymous client that could insert here could write arbitrary consent
-- records - including a consent_text that was never shown to anyone -
-- which would make every row in this table worthless as evidence of
-- consent. The signup goes through POST /api/launch instead, where the
-- consent text and version are set by the server from
-- lib/launchWaitlist.ts and never taken from the request body.

-- RLS bypass and table privileges are separate mechanisms; service_role
-- needs the grant as well (this is the bug 010 had to fix for 009).
-- DELETE is granted because the retention rule below is a real deletion.
grant select, insert, update, delete on public.launch_waitlist to service_role;

-- 3. RETENTION -------------------------------------------------
--
-- This table is not allowed to keep addresses indefinitely.
--
--   pending    An entry nobody confirmed is not consent, so it may not
--              be kept. Delete after 14 days
--              (lib/launchWaitlist.ts: PENDING_RETENTION_DAYS), which is
--              also when the confirmation link expires
--              (CONFIRMATION_TOKEN_TTL_DAYS). The two are the same
--              number on purpose: a link that no longer works must not
--              leave a row behind that still holds an address.
--
--   withdrawn  Never written to again by this flow. Kept only as long
--              as it is needed to prove the entry was withdrawn rather
--              than quietly dropped, then deleted.
--
--   notified   The consent has been used up. After the launch send is
--              done and reconciled, the list is deleted or anonymised
--              as a whole - it has no further purpose, and no marketing
--              use may be derived from it.
--
-- The deletion itself is deliberately NOT a trigger or a cron job in
-- this migration: nothing may start silently deleting rows on a
-- schedule that was never reviewed against the real launch date. The
-- rule is recorded here and implemented as an operational job. The
-- indexes above exist so that job is a cheap query:
--
--   delete from public.launch_waitlist
--    where status = 'pending'
--      and created_at < now() - interval '14 days';


-- 4. THE RATE LIMIT COUNTER ------------------------------------
--
-- WHY THIS IS HERE AT ALL
-- -----------------------
-- POST /api/launch is public, unauthenticated, and it sends mail to an
-- address the caller chose. Its first rate limit was a fixed window in
-- the server process's memory. On a single long-lived server that
-- would have been an honest speed bump.
--
-- This site is not deployed as one. It is deployed to a serverless
-- platform, where the process holding that counter is created per
-- instance, frozen between requests and discarded without warning. So
-- the limit was per instance, reset by every cold start, and weakest
-- against exactly the traffic pattern it exists to stop: sustained
-- load is what makes the platform hand out fresh instances with empty
-- counters.
--
-- A shared counter has to live somewhere every instance can see. This
-- project already has exactly one such place - this database - and
-- adding a second datastore (Redis, Upstash, a rate-limit SaaS) for one
-- form would add a vendor, a credential, a failure mode and a
-- data-processing agreement to a repository that needs none of them.
--
-- THIS IS NOT A SECOND PURPOSE FOR THE LIST ABOVE
-- -----------------------------------------------
-- The two tables share no key, no column and no foreign key. A row here
-- cannot be joined to a person, to a waitlist entry or to an order, and
-- nothing in this section reads or writes public.launch_waitlist. The
-- consent recorded above still permits exactly one message and nothing
-- else.
--
-- THE KEY IS NOT AN IP ADDRESS
-- ----------------------------
-- An IP address is personal data, and a rate limit has no need of one:
-- it only ever has to answer "is this the same caller as a moment
-- ago?", which a stable pseudonym answers exactly as well.
--
-- lib/launchRateLimit.ts therefore HMACs the client address with a
-- server-side secret before it ever leaves the request handler, and
-- only the digest is sent here. A plain hash would not have done - the
-- IPv4 space is small enough to enumerate, so an unkeyed SHA-256 of an
-- address is reversible by brute force and would be personal data in
-- everything but name. The secret is what makes the digest a pseudonym.
--
-- The CHECK constraint below pins the column to a 64-character hex
-- digest, so a raw address cannot be written into this table even by
-- mistake: '203.0.113.9' does not match the pattern and the insert
-- fails.
--
-- There is no email column, no name, no user id, no user agent, no
-- request path, no per-attempt timestamp and no free-text field.
--
-- RETENTION IS AUTOMATIC HERE, AND THAT IS THE POINT
-- --------------------------------------------------
-- Unlike the list above, this is not consent evidence and there is
-- nothing to prove later. A window that has closed is worthless, so the
-- function in section 5 deletes closed windows as it goes, in bounded
-- batches. The steady state of this table is "the callers of the last
-- ten minutes", and a bucket that stops calling disappears on its own.

create table public.launch_rate_limit (
  -- Hex SHA-256 of an HMAC over the client address, keyed with a
  -- server-only secret. Never a raw address - see above, and see
  -- pseudonymizeBucketKey in lib/launchRateLimit.ts.
  bucket_key        text primary key
                    check (bucket_key ~ '^[0-9a-f]{64}$'),

  -- Start of the window this counter belongs to. A window older than
  -- the caller's window length is treated as closed and replaced.
  window_started_at timestamptz not null default now(),

  attempt_count     integer not null default 0 check (attempt_count >= 0),

  -- Set explicitly by the function below rather than by 001's trigger:
  -- this table is written on a hot public path and does not need a
  -- per-row trigger to keep one column current.
  updated_at        timestamptz not null default now()
);

-- Supports the bounded cleanup inside the function.
create index idx_launch_rate_limit_window_started
  on public.launch_rate_limit (window_started_at);

-- Same posture as section 2: RLS on, and no SELECT/INSERT/UPDATE/DELETE
-- policy for anon or authenticated, so neither role can read or write
-- this table at all. A client that could write here could zero its own
-- counter, which is the whole limit; a client that could read it could
-- test whether a given address digest has been seen recently.
alter table public.launch_rate_limit enable row level security;

grant select, insert, update, delete on public.launch_rate_limit to service_role;

-- 5. THE ONE WAY TO SPEND AN ATTEMPT ---------------------------
--
-- Read-modify-write from application code would be two statements with
-- a gap between them, and two instances racing through that gap is
-- precisely the situation a shared counter exists to fix. So the whole
-- decision is one INSERT ... ON CONFLICT DO UPDATE: the row is locked,
-- incremented and read back in a single atomic statement, whatever
-- number of instances arrive at once.
--
-- COUNTS EVERY ATTEMPT, INCLUDING REFUSED ONES. A caller that is
-- already over the limit must not be able to hold its window open or
-- reset it by continuing to knock.
--
-- The deletion inside this function is the ONLY deletion in this file,
-- it names only public.launch_rate_limit, and it can never reach the
-- consent table above.

create or replace function public.consume_launch_rate_limit(
  p_bucket_key text,
  p_max integer,
  p_window_seconds integer
)
returns table (allowed boolean, retry_after_seconds integer)
language plpgsql
security definer set search_path = ''
as $$
declare
  v_now     timestamptz := now();
  v_window  interval;
  v_count   integer;
  v_started timestamptz;
begin
  -- The digest shape is checked here as well as by the CHECK
  -- constraint, so a caller that passed a raw address is refused before
  -- any row is written rather than leaving a constraint violation - and
  -- a raw address - in the database logs.
  if p_bucket_key is null or p_bucket_key !~ '^[0-9a-f]{64}$' then
    raise exception 'launch rate limit: bucket key must be a 64-character hex digest';
  end if;

  if p_max is null or p_max < 1 then
    raise exception 'launch rate limit: max must be at least 1';
  end if;

  if p_window_seconds is null or p_window_seconds < 1 or p_window_seconds > 86400 then
    raise exception 'launch rate limit: window must be between 1 and 86400 seconds';
  end if;

  v_window := make_interval(secs => p_window_seconds);

  -- Closed windows carry no information. Bounded, so this stays a cheap
  -- indexed delete on a hot path rather than an unbounded sweep.
  delete from public.launch_rate_limit
   where ctid in (
     select l.ctid
       from public.launch_rate_limit l
      where l.window_started_at < v_now - v_window
      limit 100
   );

  insert into public.launch_rate_limit as l (bucket_key, window_started_at, attempt_count, updated_at)
  values (p_bucket_key, v_now, 1, v_now)
  on conflict (bucket_key) do update
     set attempt_count = case
           when l.window_started_at <= v_now - v_window then 1
           else l.attempt_count + 1
         end,
         window_started_at = case
           when l.window_started_at <= v_now - v_window then v_now
           else l.window_started_at
         end,
         updated_at = v_now
  returning l.attempt_count, l.window_started_at
  into v_count, v_started;

  if v_count > p_max then
    return query
      select false,
             greatest(1, ceil(extract(epoch from (v_started + v_window - v_now)))::integer);
    return;
  end if;

  return query select true, 0;
end;
$$;

-- Only the server-side secret key may spend an attempt. anon and
-- authenticated are revoked explicitly rather than relying on the
-- default, the same way 038 and 040 do.
revoke all on function public.consume_launch_rate_limit(text, integer, integer) from public;
revoke all on function public.consume_launch_rate_limit(text, integer, integer) from anon;
revoke all on function public.consume_launch_rate_limit(text, integer, integer) from authenticated;

grant execute on function public.consume_launch_rate_limit(text, integer, integer) to service_role;

commit;

-- VERIFY (read-only, commented out; run separately if you want to see
-- the limiter work, then drop the probe row):
--
--   select * from public.consume_launch_rate_limit(repeat('a', 64), 5, 600);
--   select bucket_key, attempt_count, window_started_at
--     from public.launch_rate_limit;
