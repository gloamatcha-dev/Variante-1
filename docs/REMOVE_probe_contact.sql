-- ============================================================
-- REMOVING A PROBE ROW THAT SHOULD NEVER HAVE EXISTED
--
-- DO NOT RUN THIS WITHOUT AN EXPLICIT DECISION. It deletes a row from a
-- live table. It is in docs/ rather than supabase/migrations/ because it
-- is a one-off cleanup, not a schema change.
--
-- ============================================================
-- WHAT THIS ROW IS, AND HOW IT GOT THERE
-- ============================================================
--
-- email       probe-compat-check@example.com
-- id          d6d780ab-…
-- status      pending
-- version     2026-09-07.launch-notification-with-code.v2
-- created_at  2026-09-07 21:59:09+00
-- confirmed   never
--
-- It is not a person. It was created by a verification request against
-- the live signup endpoint, made to confirm that the outage caused by
-- deploying code ahead of migration 046 had actually been fixed.
--
-- The same request had been made minutes earlier and written nothing,
-- because the endpoint was returning 503 at the time. After the fix it
-- worked - which was the point of the check and also the mistake: a
-- successful signup writes a row and sends a confirmation mail. The mail
-- went to example.com, a reserved domain that accepts nothing, so it
-- bounced.
--
-- ============================================================
-- WHY IT IS SAFE TO DELETE, AND WHY IT IS WORTH DELETING
-- ============================================================
--
-- SAFE, because there is nothing attached to it:
--
--   * It has no confirmed_at, so migration 046's backfill wrote no
--     consent history row for it. Verified: the history holds exactly
--     two rows, both belonging to the two real contacts.
--   * It has never been notified and never received a welcome mail.
--   * example.com is reserved by RFC 2606 and cannot belong to anybody.
--
-- WORTH DELETING, because it is currently the only version 2 row on the
-- list. Every count of "who could receive the welcome mail" includes it,
-- and it will appear in the admin overview looking like a signup. Left
-- alone the retention sweep removes it fourteen days after 7 September,
-- around 21 September - so doing nothing also works, just more slowly
-- and with a misleading counter until then.
--
-- ============================================================
-- WHAT IT DOES NOT TOUCH
-- ============================================================
--
-- The two real contacts. The WHERE clause pins the exact address, the
-- pending status and the absence of a confirmation, so it cannot match
-- either of them: one is confirmed, the other carries a confirmed_at.
-- If this row has changed since it was audited - somebody confirmed it,
-- it was already deleted - the statement affects nothing.
--
-- ============================================================
-- BEFORE
-- ============================================================
--
--   select id, email, status, consent_version, confirmed_at, created_at
--     from public.launch_waitlist
--    where email = 'probe-compat-check@example.com';
--
--   -- And confirm it has no consent history, which is what makes the
--   -- delete a clean removal rather than a loss of evidence:
--   select count(*) from public.launch_consent_history h
--     join public.launch_waitlist w on w.id = h.waitlist_id
--    where w.email = 'probe-compat-check@example.com';   -- expect 0
--
-- ============================================================

begin;

delete from public.launch_waitlist
 where email = 'probe-compat-check@example.com'
   and status = 'pending'
   and confirmed_at is null
   and withdrawn_at is null
   and launch_notification_sent_at is null
   and welcome_email_sent_at is null;

-- Expect exactly one row. Zero means it had already changed or gone, and
-- the transaction should be rolled back and the state re-checked.

commit;

-- ============================================================
-- AFTER
-- ============================================================
--
--   select count(*) as total from public.launch_waitlist;          -- 2
--   select count(*) as history from public.launch_consent_history; -- 2
--
--   -- No version 2 row remains, so nobody is eligible for the welcome
--   -- mail until a real person confirms one:
--   select consent_version, status, count(*)
--     from public.launch_waitlist group by 1, 2 order by 1, 2;
