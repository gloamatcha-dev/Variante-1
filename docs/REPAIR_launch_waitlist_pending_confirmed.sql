-- ============================================================
-- ONE-OFF REPAIR, NOT A MIGRATION
--
-- STATE AS VERIFIED ON 8 SEPTEMBER 2026, AFTER 045 AND 046 WERE
-- APPLIED. Migration 046 stops this defect happening again; it does
-- not repair the row that already carries it, which is what this file
-- is for. 044 is still unapplied and is irrelevant here.
--
-- DO NOT RUN THIS WITHOUT AN EXPLICIT DECISION. It is not part of the
-- migration sequence, it is not idempotent by number, and it changes a
-- live row. It lives in docs/ rather than supabase/migrations/ for
-- exactly that reason.
--
-- ============================================================
-- WHAT IS WRONG WITH THE ROW
-- ============================================================
--
-- id                   a103c9d8-3d7a-45b1-9e5d-ca05a2f7af85
-- status               pending
-- consent_version      2026-09-06.launch-notification.v1
-- consent_given_at     2026-09-07 19:32:40.902+00
-- confirmation_sent_at 2026-09-07 19:32:40.902+00
-- confirmed_at         2026-09-07 18:23:30.401+00     <-- the evidence
-- withdrawn_at         null
--
-- A row cannot honestly be 'pending' and carry a confirmed_at. This one
-- does, and the timeline says why:
--
--   18:22:03  signed up
--   18:23:30  CONFIRMED - clicked the link. confirmed_at written.
--   19:32:40  submitted the form a second time. The old upsert wrote
--             status='pending' over a confirmed row and left
--             confirmed_at standing, because that column was not in its
--             payload.
--
-- consent_given_at being LATER than confirmed_at is the fingerprint of
-- that second submission. Migration 046 makes this impossible in
-- future; it does not repair the row that already has it.
--
-- ============================================================
-- WHY THIS REPAIR INVENTS NOTHING
-- ============================================================
--
-- confirmed_at is a real, recorded confirmation. This person clicked a
-- real link sent to their own address, and the database wrote the
-- timestamp at that moment. The repair asserts nothing that was not
-- already recorded:
--
--   * The consent version is UNCHANGED. It was version 1 at 18:23 and it
--     is version 1 now - the second submission on 7 September was also
--     version 1, because version 2 did not exist until later that
--     evening. Nobody is being moved to a newer wording.
--
--   * consent_given_at is NOT touched. Back-dating it to 18:22 would be
--     rewriting a record, and the 19:32 value is a true statement about
--     when this person last submitted the form.
--
--   * NO new consent, no marketing permission and no version 2 rights
--     are created. After this repair the row is exactly what it was at
--     18:23:31: confirmed, under version 1, entitled to the launch
--     notification and to nothing else. In particular it still cannot
--     receive the welcome mail with the discount code, because
--     claim_welcome_email pins version 2.
--
--   * Nothing is deleted.
--
-- The only claim being made is the one the row already makes twice over:
-- this address was confirmed.
--
-- ============================================================
-- THE ALTERNATIVE, WHICH IS BETTER IF IT IS STILL AVAILABLE
-- ============================================================
--
-- The row still holds a valid, unused confirmation token from 19:32, and
-- the mail carrying it is in that person's inbox. Clicking that link
-- confirms the row through the ordinary path - by the person's own
-- action, recorded as such, with no operator touching anything.
--
-- That link expires 14 days after 19:32 on 7 September, so around
-- 21 September, and the retention sweep deletes unconfirmed rows on the
-- same clock. PREFER THE CLICK while it is still possible. Use this
-- script only if the link has expired or the mail is gone.
--
-- ============================================================
-- BEFORE
-- ============================================================
--
--   select id, status, consent_version, consent_given_at,
--          confirmed_at, withdrawn_at, launch_notification_sent_at
--     from public.launch_waitlist
--    where id = 'a103c9d8-3d7a-45b1-9e5d-ca05a2f7af85';
--
-- Expected: status 'pending', confirmed_at 2026-09-07 18:23:30.401+00,
-- withdrawn_at null. If withdrawn_at is NOT null, STOP - a withdrawal
-- outranks everything here and this script must not run.
--
-- ============================================================

begin;

-- The guard is in the WHERE clause, not in a comment. Every condition
-- describes the row as it was audited, so if anything has changed since
-- - a withdrawal, a confirmation, a deletion - this updates nothing at
-- all rather than acting on a row it was not written for.
update public.launch_waitlist
   set status = 'confirmed',
       -- The token from 19:32 is spent by this repair. Leaving it live
       -- would let a later click re-enter the confirm path on a row that
       -- is already confirmed; clearing it is the same thing the normal
       -- confirmation does.
       confirmation_token_hash = null
 where id = 'a103c9d8-3d7a-45b1-9e5d-ca05a2f7af85'
   and status = 'pending'
   and confirmed_at is not null
   and withdrawn_at is null
   and launch_notification_sent_at is null
   -- Pinned: this repair is only valid for the version that was in force
   -- when the confirmation happened.
   and consent_version = '2026-09-06.launch-notification.v1'
   -- Added after 046: there must be no unconfirmed newer wording
   -- waiting on this row. If there were, promoting the row to
   -- 'confirmed' would leave a proposed consent stranded beside a
   -- confirmation that did not cover it. Verified as null on 8 September.
   and pending_consent_version is null;

-- Expect exactly one row. If it is zero, the row changed after the audit
-- and this transaction should be rolled back and the state re-checked.

commit;

-- ============================================================
-- AFTER
-- ============================================================
--
--   select id, status, consent_version, consent_given_at, confirmed_at
--     from public.launch_waitlist
--    where id = 'a103c9d8-3d7a-45b1-9e5d-ca05a2f7af85';
--
-- Expected: status 'confirmed', consent_version still v1, confirmed_at
-- and consent_given_at both unchanged.
--
--   -- No row may read as pending while carrying a confirmed_at:
--   select count(*) from public.launch_waitlist
--    where status = 'pending' and confirmed_at is not null;   -- 0
--
--   -- Still not eligible for the discount mail:
--   select consent_version from public.launch_waitlist
--    where id = 'a103c9d8-3d7a-45b1-9e5d-ca05a2f7af85';       -- v1
--
-- THE CONSENT HISTORY IS NOT TOUCHED, and must not be. 046's backfill
-- already wrote one row for this contact from the same evidence -
-- version 1, confirmed 18:23:30 - and that row remains the proof.
--
-- This repair records NO new confirmation, because none happened: it
-- corrects a status that was overwritten, it does not assert that
-- somebody clicked something. Writing a history row here would be
-- inventing an event, which is the one thing a consent log must never
-- contain.
--
--   select consent_version, confirmed_at, recorded_at
--     from public.launch_consent_history
--    where waitlist_id = 'a103c9d8-3d7a-45b1-9e5d-ca05a2f7af85';
--   -- Expect exactly one row, unchanged, before and after.
