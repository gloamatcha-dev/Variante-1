-- ══════════════════════════════════════════════════════════════
-- 055 — THE CHECKOUT KNOWS WHO IS BUYING, BEFORE STRIPE DOES
--
-- Today GLOA does not learn the customer's email until after they have
-- paid. The session route receives { items, requestId, shippingCountry }
-- and nothing else, the Checkout Session is created with no `customer`
-- and no `customer_email`, Stripe's hosted page collects the address,
-- and the webhook reads it back out of session.customer_details.email.
--
-- That is fine for an order. It is not fine for anything that has to be
-- true about a PERSON before they pay - a one-per-customer launch code
-- being the immediate example, since the identity it is enforced
-- against would be chosen by the customer after the discount was
-- already payable.
--
-- ── WHY A STRIPE CUSTOMER, AND NOT customer_email ─────────────
--
-- The installed SDK (stripe 22.5.0, API 2026-07-29.dahlia) is explicit,
-- and the distinction is the whole point of this migration:
--
--   customer_email  "Use this parameter to PREFILL customer data if you
--                    already have an email on file."
--                   -> the customer can type a different one.
--
--   customer        "If the Customer already has a valid email set, the
--                    email will be PREFILLED AND NOT EDITABLE in
--                    Checkout. If the Customer does not have a valid
--                    email, Checkout will set the email entered during
--                    the session on the Customer."
--
-- So the binding requires BOTH halves: a Stripe Customer, AND that
-- Customer already carrying the email. A Customer without one is not a
-- lock - Checkout simply fills it in from whatever the buyer types.
-- public.stripe_customers today creates Customers with metadata only and
-- no email at all, which is exactly that weaker case.
--
-- ── WHY A SECOND TABLE RATHER THAN WIDENING THE FIRST ─────────
--
-- public.stripe_customers is keyed `user_id uuid primary key references
-- auth.users`. A guest has no user id, so a guest cannot have a row -
-- and guests are not an edge case here: 6 of 458 orders carry a user id.
--
-- Widening that table would mean making its primary key nullable and
-- adding a second identity column to a table the subscription flow
-- depends on. This adds a separate one instead, so subscriptions keep
-- the table they have, unchanged, and the one-time path gets the
-- identity it needs. Two tables, two questions, neither answering the
-- other's.
--
-- ── WHAT THIS MIGRATION DOES NOT DO ───────────────────────────
--
-- It creates no Stripe object - a migration cannot, and the runtime
-- wiring that will is deliberately a separate phase. It does not touch
-- stripe_customers, subscriptions, orders, order_items, product prices
-- or any historical row. It adds no policy and no browser grant.
-- ══════════════════════════════════════════════════════════════

begin;

-- ── 1. THE GUEST IDENTITY MAP ─────────────────────────────────
--
-- One row per normalised email. The uniqueness is the point: it is what
-- makes two simultaneous checkouts by the same person converge on ONE
-- Stripe Customer instead of quietly creating two authoritative
-- identities, either of which could then claim a one-per-customer code.
--
-- The runtime pattern this is built for is the one lib/stripeCustomers.ts
-- already uses: create with a deterministic idempotency key, insert,
-- and on a 23505 adopt the winner rather than overwrite. That only works
-- if the database is the arbiter, which is what the constraint below is.
--
-- normalized_email is the canonical form - lower(btrim(...)) - and the
-- CHECK enforces it at the boundary rather than trusting every caller to
-- remember, exactly as migration 051 does for admin_users.email.
--
-- WHAT IS NOT HERE: no name, no address, no basket, no order, no user
-- id. This table answers one question - "which Stripe Customer is this
-- address?" - and holds nothing that would make it worth reading for
-- any other reason.

create table if not exists public.checkout_customer_identities (
  normalized_email    text primary key
                      check (normalized_email = lower(btrim(normalized_email)))
                      check (length(normalized_email) between 3 and 254)
                      check (position('@' in normalized_email) > 1),

  -- One Customer per address, and one address per Customer. The second
  -- half matters as much as the first: two rows pointing at one Stripe
  -- Customer would mean two "identities" that are really one, and the
  -- one-use guarantee would be enforced twice over the same person.
  stripe_customer_id  text not null unique
                      check (length(btrim(stripe_customer_id)) between 3 and 255),

  created_at          timestamptz not null default now()
);

comment on table public.checkout_customer_identities is
  'Normalised checkout email -> Stripe Customer. Guest-capable; the mapping that makes the Checkout email non-editable. Not a customer record.';

-- ── 2. NOTHING IN A BROWSER MAY READ OR WRITE IT ──────────────
--
-- RLS on with NOT ONE POLICY, and every privilege taken away from all
-- three roles before exactly the needed ones are given back.
--
-- Stated as an end state rather than a delta, for the reason 052 and 053
-- both learned: Supabase carries default privileges for these roles on
-- new tables in `public`, so "revoke what I granted" leaves whatever
-- arrived by default - including TRUNCATE. Take everything, then give
-- back two verbs.
--
-- SELECT and INSERT only. No UPDATE, deliberately: a mapping that
-- already points somewhere is an integrity fact, not something a later
-- request should be able to repoint - the same decision
-- public.stripe_customers made in migration 022, for the same reason.
-- No DELETE either; an erasure request is a deliberate operation, not
-- something the checkout path should be able to do by accident.

alter table public.checkout_customer_identities enable row level security;

revoke all privileges on table public.checkout_customer_identities
  from anon, authenticated, service_role;

grant select, insert on table public.checkout_customer_identities to service_role;

-- ── 3. THE ATTEMPT FREEZES THE EXPECTED IDENTITY ──────────────
--
-- The attempt already freezes the prices, the shipping zone and the tax
-- so a retry settles what the customer was quoted rather than whatever
-- the world looks like when they come back. The identity belongs in
-- that same snapshot and for the same reason.
--
-- It is also what gives the webhook something to check against. Stripe
-- should make divergence impossible (section 2 of the header); this
-- column is what lets fulfilment NOTICE if that ever stops being true,
-- which is a different and weaker job - defence in depth, not the
-- defence.
--
-- Both columns are nullable, and that is not laziness: 729 attempts
-- already exist with no identity, and every one of them must stay
-- readable. A NOT NULL here would either rewrite history or refuse to
-- apply. New attempts get the columns filled by the runtime wiring; old
-- ones keep saying, truthfully, that nobody asked.
--
-- checkout_attempts already had its privileges hardened to
-- (select, insert, update) for service_role in migration 023. New
-- columns inherit the table's grants, so nothing is re-granted here -
-- re-stating them would risk changing a privilege set this migration
-- has no business touching.

alter table public.checkout_attempts
  add column if not exists customer_email      text,
  add column if not exists stripe_customer_id  text;

-- Canonical or absent. A half-normalised address would be a second
-- spelling of the same person, which is precisely what the whole
-- identity model exists to prevent.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.checkout_attempts'::regclass
      and conname = 'checkout_attempts_customer_email_normalized'
  ) then
    alter table public.checkout_attempts
      add constraint checkout_attempts_customer_email_normalized
      check (
        customer_email is null
        or (customer_email = lower(btrim(customer_email))
            and length(customer_email) between 3 and 254
            and position('@' in customer_email) > 1)
      );
  end if;
end $$;

comment on column public.checkout_attempts.customer_email is
  'Normalised email this attempt was created for. Frozen before Stripe; the identity fulfilment verifies against. Null on attempts predating 055.';
comment on column public.checkout_attempts.stripe_customer_id is
  'The Stripe Customer the session was created against, so the email is prefilled and not editable. Null on attempts predating 055.';

-- ── 4. FINDING A PERSON'S ATTEMPTS ────────────────────────────
--
-- Partial, because an attempt without an identity is never something
-- anybody looks up by identity - and there are 729 of those today. The
-- index covers only the rows the question can actually be asked about.

create index if not exists idx_checkout_attempts_customer_email
  on public.checkout_attempts (customer_email)
  where customer_email is not null;

-- ── 5. AND THE END STATE IS PROVEN BEFORE COMMIT ──────────────
--
-- Asserting the result rather than counting what changed, so a second
-- run passes unchanged. A partially-applied identity foundation is
-- worse than none: the runtime would write into columns whose
-- constraints it cannot rely on.

do $$
declare
  v_missing text;
begin
  -- The two attempt columns exist.
  select string_agg(c.needed, ', ')
    into v_missing
  from (values ('customer_email'), ('stripe_customer_id')) as c(needed)
  where not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'checkout_attempts'
      and column_name = c.needed
  );
  if v_missing is not null then
    raise exception '055: checkout_attempts is missing column(s): %', v_missing;
  end if;

  -- The map exists with its uniqueness intact.
  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'checkout_customer_identities'
  ) then
    raise exception '055: public.checkout_customer_identities was not created';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.checkout_customer_identities'::regclass
      and contype = 'p'
  ) then
    raise exception '055: the identity map has no primary key';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.checkout_customer_identities'::regclass
      and contype = 'u'
  ) then
    raise exception '055: stripe_customer_id is not unique - two addresses could share one Customer';
  end if;

  -- RLS on, and no policy anywhere near it.
  if not (select relrowsecurity from pg_class
          where oid = 'public.checkout_customer_identities'::regclass) then
    raise exception '055: row level security is not enabled on the identity map';
  end if;

  if exists (select 1 from pg_policies
             where schemaname = 'public' and tablename = 'checkout_customer_identities') then
    raise exception '055: the identity map has a policy - it must have none';
  end if;

  -- No browser role holds anything on it.
  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'checkout_customer_identities'
      and grantee in ('anon', 'authenticated')
  ) then
    raise exception '055: a browser role holds a privilege on the identity map';
  end if;
end $$;

commit;

-- ══════════════════════════════════════════════════════════════
-- VERIFYING THIS MIGRATION, read-only:
--
--   1. THE EXACT PRIVILEGE SET on the identity map. Grouped by role and
--      printing the grant option, because a per-row query is what missed
--      the problem in 052 and a list without is_grantable does not say
--      whether a role can pass on what it holds:
--        select grantee,
--               string_agg(privilege_type, ', ' order by privilege_type) as privileges,
--               string_agg(distinct is_grantable, ',') as grantable
--        from information_schema.role_table_grants
--        where table_schema = 'public'
--          and table_name = 'checkout_customer_identities'
--          and grantee in ('anon', 'authenticated', 'service_role')
--        group by grantee;
--      -> EXACTLY one row: service_role | INSERT, SELECT | NO
--      -> anon and authenticated do not appear at all.
--
--   1b. And no write verb survives anywhere, asked the other way round:
--        select grantee, privilege_type
--        from information_schema.role_table_grants
--        where table_schema = 'public'
--          and table_name = 'checkout_customer_identities'
--          and privilege_type in ('UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER');
--      -> NO ROWS.
--
--   2. Nothing in a browser can reach it the other way either:
--        select relrowsecurity from pg_class
--        where oid = 'public.checkout_customer_identities'::regclass;   -> true
--        select count(*) from pg_policies
--        where tablename = 'checkout_customer_identities';              -> 0
--
--   3. The attempt can hold an identity, and it is canonical or absent:
--        select column_name, data_type, is_nullable
--        from information_schema.columns
--        where table_schema = 'public' and table_name = 'checkout_attempts'
--          and column_name in ('customer_email', 'stripe_customer_id');
--      -> two rows, text, YES (nullable - see section 3).
--        select conname from pg_constraint
--        where conrelid = 'public.checkout_attempts'::regclass
--          and conname = 'checkout_attempts_customer_email_normalized';
--      -> one row.
--
--   4. checkout_attempts kept the privileges 023 gave it, unchanged:
--        select grantee, string_agg(privilege_type, ', ' order by privilege_type)
--        from information_schema.role_table_grants
--        where table_schema = 'public' and table_name = 'checkout_attempts'
--          and grantee in ('anon','authenticated','service_role')
--        group by grantee;
--      -> service_role | INSERT, SELECT, UPDATE     (anon/authenticated absent)
--
--   5. NOTHING ELSE MOVED. This migration adds capacity, not data:
--        select count(*) from public.checkout_customer_identities;  -> 0
--        select count(*) from public.checkout_attempts;             -> unchanged (729)
--        select count(*) from public.orders;                        -> unchanged (458)
--        select count(*) from public.order_items;                   -> unchanged (458)
--        select count(*) from public.subscriptions;                 -> unchanged (4)
--        select count(*) from public.stripe_customers;              -> unchanged (3)
--        select count(*) from public.product_variants;              -> unchanged (4)
--      And every existing attempt still says it has no identity, which
--      is true and must stay true:
--        select count(*) from public.checkout_attempts
--        where customer_email is not null;                          -> 0
-- ══════════════════════════════════════════════════════════════
