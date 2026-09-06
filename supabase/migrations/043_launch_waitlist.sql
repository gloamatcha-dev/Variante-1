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
-- ============================================================

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
