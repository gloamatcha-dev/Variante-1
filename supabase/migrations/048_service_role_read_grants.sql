-- ============================================================
-- GLOA – service_role READ grants for the ten tables that have none
--
-- Paket 4A.0. Run in the Supabase SQL Editor against the existing
-- production project. Idempotent: GRANT is a no-op when the privilege
-- is already held, so this file is safe to run more than once.
-- ============================================================
--
-- ── WHAT WAS WRONG ───────────────────────────────────────────
--
-- The server-side Supabase client (lib/supabaseAdmin.ts) is answered
-- HTTP 403 by PostgREST on ten tables. Verified against production,
-- read-only, on 2026-09-15. PostgREST returns the diagnosis itself:
--
--   {"code":"42501", …,
--    "hint":"Grant the required privileges to the current role with:
--            GRANT SELECT ON public.products TO service_role;"}
--
-- The assumption that broke is a common one: with Supabase's newer API
-- key system (sb_secret_…), the secret key maps to the service_role
-- database role but does NOT bypass PostgreSQL table privileges. A
-- table therefore needs an explicit grant even for the service role.
--
-- Migrations 004 and 011 granted orders and order_items to service_role
-- explicitly, which is why the checkout and webhook paths work. The ten
-- tables below were written before that pattern existed, or were only
-- ever meant to be read from the browser, and never got one.
--
-- ── WHY SELECT AND NOTHING ELSE ──────────────────────────────
--
-- Least privilege, measured rather than assumed. There is TODAY no
-- server-side read or write of any of these ten tables:
--
--   products, product_variants   read by lib/catalogProducts.ts through
--                                the PUBLISHABLE key, which already has
--                                "grant select … to anon" (migration
--                                007). That path is unaffected by this
--                                file and keeps working either way.
--   profiles, business_profiles  read and written from the browser as
--                                the authenticated role, under RLS.
--   addresses                    the one server-side read
--                                (lib/annualPlanCheckoutDeps.ts) runs on
--                                a client built from the USER's JWT, so
--                                it is the authenticated role and is
--                                already granted by migration 002.
--   b2b_*                        read from the browser only. Nothing in
--                                the application writes them at all.
--
-- So no INSERT, no UPDATE, no DELETE, no TRUNCATE is granted here, and
-- none is needed. When a later package genuinely needs to write one of
-- these tables - an admin product editor, a B2B order writer - that
-- write gets its own migration, naming the table and the reason. A
-- blanket "grant all" now would hand out privileges nobody has asked
-- for and nobody would notice being used.
--
-- ── WHAT THIS DOES NOT CHANGE ────────────────────────────────
--
-- Nothing about anon or authenticated: their grants are untouched, so
-- no browser gains a single byte of new access. Row Level Security
-- stays enabled on every one of these tables and no policy is added,
-- dropped or altered. The service role's ability to read past RLS is a
-- property of that role, not of this file.
--
-- This is a privilege repair, not a feature. It makes future
-- server-side admin reads possible; it does not create one.
-- ============================================================

-- ── Catalog ──────────────────────────────────────────────────
grant select on public.products              to service_role;
grant select on public.product_variants      to service_role;

-- ── Customer records ─────────────────────────────────────────
grant select on public.profiles              to service_role;
grant select on public.business_profiles     to service_role;
grant select on public.addresses             to service_role;

-- ── B2B conditions and agreements ────────────────────────────
grant select on public.b2b_offer_models      to service_role;
grant select on public.b2b_product_sizes     to service_role;
grant select on public.b2b_general_terms     to service_role;
grant select on public.b2b_supply_agreements to service_role;
grant select on public.b2b_supply_items      to service_role;
