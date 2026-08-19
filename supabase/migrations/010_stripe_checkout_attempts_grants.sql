-- ============================================================
-- GLOA – Bugfix: grant service_role access to Stripe checkout tables
-- Run in Supabase SQL Editor AFTER 009
--
-- 009 enabled RLS on checkout_attempts / stripe_webhook_events and
-- intentionally added no policies for anon/authenticated, relying on the
-- server-only Supabase admin client (lib/supabaseAdmin.ts, using
-- SUPABASE_SECRET_KEY) for all reads/writes. That client authenticates as
-- service_role, which bypasses RLS but still requires ordinary table
-- GRANTs - RLS bypass and table-level privileges are separate mechanisms.
-- 009 did not grant those, so every checkout_attempts / stripe_webhook_events
-- access failed with "permission denied for table ...".
-- ============================================================

grant select, insert, update on public.checkout_attempts to service_role;
grant select, insert on public.stripe_webhook_events to service_role;
