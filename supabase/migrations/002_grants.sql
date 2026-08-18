-- ============================================================
-- GLOA – Table Grants for authenticated and anon roles
-- Required: PostgreSQL GRANT must be set BEFORE RLS can filter rows
-- Without these, even authenticated users get "permission denied"
-- ============================================================

-- profiles: authenticated can read + update own (RLS filters)
grant select, update on public.profiles to authenticated;

-- business_profiles: authenticated can read + update own (RLS filters)
grant select, update on public.business_profiles to authenticated;

-- addresses: authenticated full CRUD on own (RLS filters)
grant select, insert, update, delete on public.addresses to authenticated;

-- anon: no access to any personal data tables (intentional)
-- RLS would block anyway, but no GRANT = extra layer of security
