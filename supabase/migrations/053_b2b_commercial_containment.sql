-- ══════════════════════════════════════════════════════════════
-- 053 — THE B2B COMMERCIAL DRAFT STOPS REACHING THE BROWSER
--
-- Migration 003 created three tables to describe a wholesale offer:
--
--   b2b_product_sizes   a rate per kilo, for 250 g and 500 g
--   b2b_offer_models    single / recurring / annual, with discounts
--   b2b_general_terms   free-text conditions
--
-- It also gave every signed-in business account permission to read all
-- three, and the account portal did exactly that - rendering a price
-- table, a discount per model and a calculator built from both.
--
-- ── WHAT WAS ACTUALLY BEING SHOWN ─────────────────────────────
--
-- A first draft. The sizes table holds ONE rate of 125.00/kg, which
-- works out to 31.25 for 250 g and 62.50 for 500 g - not the prices
-- GLOA intends to charge - and there is no 1 kg row at all. The terms
-- table has never had a single row in it.
--
-- So a business customer signing in saw wholesale prices and discount
-- tiers nobody had approved, in the one place a customer would most
-- reasonably treat them as binding. The public page has always said
-- "Preise und Konditionen auf Anfrage"; the signed-in portal quietly
-- said something else.
--
-- ── WHAT THIS MIGRATION DOES, AND DOES NOT DO ─────────────────
--
-- The application stopped reading these tables first - that change is
-- deployed before this runs, so there is no window in which the portal
-- asks for something it may no longer have. This closes the door behind
-- it: no browser role may read any of the three.
--
-- IT DOES NOT REWRITE THE PRICES. Making 250 g say 35.00 would mean
-- adopting "a rate per kilo" as the shape of GLOA's price list, and the
-- intended prices are not a single rate - 35.00 / 65.00 / 125.00 are
-- 140, 130 and 125 per kilo, a rate that falls with volume. The real
-- price list belongs in the B2B commerce package, as explicit pack
-- prices in net cents. Guessing its shape here to silence an audit
-- would be the more expensive mistake.
--
-- IT DELETES NOTHING. The rows stay for internal reference until that
-- package replaces or retires them.
--
-- ── THE ONE DATA CORRECTION ───────────────────────────────────
--
-- Section 3 changes exactly one number, on an explicit product decision:
-- the recurring model's discount goes from 5 % to 0 %. See the note
-- there for why that is a correction rather than a price change.
-- ══════════════════════════════════════════════════════════════

begin;

-- ── 1. NO BROWSER ROLE MAY READ THE DRAFT ─────────────────────
--
-- The policies come off first. A policy that grants SELECT to
-- is_business_user() is not made harmless by revoking the grant - both
-- are needed, and leaving either behind is how this comes back.
--
-- Stated as an end state rather than a delta, for the reason 052
-- learned the hard way: Supabase carries default privileges for these
-- roles on tables in `public`, so "revoke the thing I granted" leaves
-- whatever arrived by default. Take everything away, then give back
-- exactly what is needed.
--
-- ── AND service_role IS REVOKED TOO, NOT JUST THE BROWSER ────
--
-- The first draft of this migration revoked from anon and authenticated
-- and then granted SELECT to service_role - which is the SAME mistake
-- 052 made, one role along. `grant select` adds a privilege; it removes
-- none. If service_role already held INSERT, UPDATE, DELETE, TRUNCATE,
-- REFERENCES or TRIGGER on these tables - from migration 048, from a
-- Supabase default, or from anything else - that grant would have left
-- every one of them in place while the file appeared to say otherwise.
--
-- TRUNCATE is again the one that matters: a role that can empty a table
-- is not a role that can only read it.
--
-- So all three roles are stripped first and exactly one privilege is
-- given back. The end state is then a property of these two statements
-- rather than of whatever the table happened to arrive with.

drop policy if exists "Business users can read product sizes" on public.b2b_product_sizes;
drop policy if exists "Business users can read offer models"  on public.b2b_offer_models;
drop policy if exists "Business users can read general terms" on public.b2b_general_terms;

revoke all privileges on table public.b2b_product_sizes  from anon, authenticated, service_role;
revoke all privileges on table public.b2b_offer_models   from anon, authenticated, service_role;
revoke all privileges on table public.b2b_general_terms  from anon, authenticated, service_role;

-- RLS stays on. With no policy and no grant, a browser role now gets
-- nothing from any of the three, whichever way it asks.
alter table public.b2b_product_sizes  enable row level security;
alter table public.b2b_offer_models   enable row level security;
alter table public.b2b_general_terms  enable row level security;

-- ── 2. AND EXACTLY ONE PRIVILEGE GOES BACK ────────────────────
--
-- Migration 048 granted service_role SELECT on all three, and reading
-- them is still legitimate: the rows are the only written record of
-- what the first draft said, and trusted server code - or a future
-- admin screen - has reason to look at it.
--
-- Reading is ALL it gets. Section 1 took everything away from
-- service_role as well, so after these three statements its privileges
-- on these tables are exactly SELECT, whatever they were before this
-- migration ran. No WITH GRANT OPTION, so it cannot pass even that on.
--
-- No role gains INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES or TRIGGER
-- here, and section 3's own writes run as the migration's owner rather
-- than as service_role.

grant select on table public.b2b_product_sizes  to service_role;
grant select on table public.b2b_offer_models   to service_role;
grant select on table public.b2b_general_terms  to service_role;

-- ── 3. RECURRING SUPPLY IS NOT DISCOUNTED ─────────────────────
--
-- 003 seeded the recurring model at 5 % off, and that is no longer the
-- offer. The decision is:
--
--   single      0 %   a normal order, no commitment
--   recurring   0 %   the SAME B2B price, delivered on a fixed rhythm,
--                     monatlich kündbar. What the customer gets is not
--                     a lower price - it is not having to reorder, and
--                     not running out. Calling that a discount was
--                     always the weaker pitch as well as the wrong one.
--   annual     10 %   unchanged as an intention. The term, the payment
--                     and the delivery mechanics are NOT decided, and
--                     nothing here implements any of them.
--
-- Corrected rather than left stale even though nothing customer-facing
-- reads this table any more, because the row is the written record of
-- what GLOA offers, and a wrong record is how a wrong number comes back
-- later through a different door.
--
-- Idempotent by construction: it matches on the value being replaced,
-- so a second run changes nothing, and a row somebody has already
-- corrected by hand is left alone.

update public.b2b_offer_models
   set discount_pct = 0
 where slug = 'recurring'
   and discount_pct <> 0;

-- The description promised the discount too, so it would have outlived
-- the number it described. Replaced with what the model actually is.
update public.b2b_offer_models
   set description = 'Feste Lieferintervalle nach Absprache, zum normalen B2B-Preis. Monatlich kündbar.'
 where slug = 'recurring'
   and description is distinct from 'Feste Lieferintervalle nach Absprache, zum normalen B2B-Preis. Monatlich kündbar.';

commit;

-- ══════════════════════════════════════════════════════════════
-- VERIFYING THIS MIGRATION, read-only:
--
--   1. THE EXACT PRIVILEGE SET. Grouped by role and printing the
--      grant option too, because a per-row query is what missed the
--      052 problem and a privilege list without is_grantable does not
--      say whether a role can pass what it holds to another:
--        select table_name, grantee,
--               string_agg(privilege_type, ', ' order by privilege_type) as privileges,
--               string_agg(distinct is_grantable, ',') as grantable
--        from information_schema.role_table_grants
--        where table_schema = 'public'
--          and table_name in ('b2b_product_sizes','b2b_offer_models','b2b_general_terms')
--          and grantee in ('anon','authenticated','service_role')
--        group by table_name, grantee
--        order by table_name, grantee;
--      -> EXACTLY three rows:
--           b2b_general_terms  | service_role | SELECT | NO
--           b2b_offer_models   | service_role | SELECT | NO
--           b2b_product_sizes  | service_role | SELECT | NO
--      -> anon and authenticated do not appear at all.
--      -> the privileges column is the single word SELECT, never
--         "INSERT, SELECT" or anything longer.
--
--   1b. The same thing asked the other way round, so a missed
--       privilege cannot hide inside an aggregate:
--         select table_name, grantee, privilege_type
--         from information_schema.role_table_grants
--         where table_schema = 'public'
--           and table_name in ('b2b_product_sizes','b2b_offer_models','b2b_general_terms')
--           and privilege_type in
--               ('INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER')
--           and grantee in ('anon','authenticated','service_role');
--       -> NO ROWS. Not one write, reference or trigger privilege
--          survives on any of the three, for any of the three roles.
--
--   2. And no policy lets them in the other way:
--        select tablename, count(*) from pg_policies
--        where tablename in ('b2b_product_sizes','b2b_offer_models','b2b_general_terms')
--        group by tablename;                                   -> no rows
--        select relname, relrowsecurity from pg_class
--        where relname in ('b2b_product_sizes','b2b_offer_models','b2b_general_terms');
--      -> relrowsecurity true for all three.
--
--   3. The offer models now read as the current decision:
--        select slug, discount_pct from public.b2b_offer_models order by sort_order;
--      -> single 0.00, recurring 0.00, annual 10.00
--
--   4. Nothing was deleted, and no price was rewritten:
--        select count(*) from public.b2b_product_sizes;        -> 2
--        select grams, price_per_kg_net from public.b2b_product_sizes
--        order by sort_order;              -> 250 | 125.00 and 500 | 125.00
--        select count(*) from public.b2b_offer_models;         -> 3
--        select count(*) from public.b2b_general_terms;        -> 0
--
--   5. No customer data moved:
--        select count(*) from public.business_profiles;        -> unchanged
--        select count(*) from public.orders;                   -> unchanged
-- ══════════════════════════════════════════════════════════════
