-- ============================================================
-- GLOA – B2C subscription launch plans: every 4 weeks (Task 29D-C)
-- Run in Supabase SQL Editor AFTER 023
--
-- Migration 005 created b2c_subscription_plans with no rows, because the
-- cadence and the conditions were not confirmed. They are now: exactly
-- one cadence at launch, every 4 weeks, which is 28 days. Not a calendar
-- month, and not "monatlich" - a month is 28 to 31 days and would make
-- the delivery rhythm drift against what the customer was told.
--
-- Three things happen here.
--
--   1. The plan table gains the product reference it never had. A plan
--      row could describe a cadence but not say what was being delivered,
--      so "30 g every 4 weeks" was not expressible. That is added as a
--      real foreign key rather than encoded in the slug, because a
--      renamed slug must not be able to silently repoint a plan at a
--      different product.
--
--   2. The three launch plans are seeded, resolved by SKU, refusing to
--      run if a SKU is missing rather than seeding a plan for a product
--      that is not there, and refusing to run if the plan table already
--      holds anything other than exactly these plans.
--
--   3. The table's privileges are corrected. A live read-only query found
--      anon, authenticated and service_role each holding REFERENCES,
--      TRIGGER and TRUNCATE on it, for the reason migration 023 records
--      in detail: Supabase ships ALTER DEFAULT PRIVILEGES for the public
--      schema, so a table created by migration 005 arrived with
--      privileges already handed out before 005 granted anything. RLS
--      does not cover any of the three, because none of them is a row
--      read or a row write.
--
-- What this migration deliberately does NOT contain: any price. The plan
-- table has no amount column and none is added. The catalog
-- (product_variants.price_gross_cents) stays the single commercial truth,
-- read server-side at subscription creation and frozen into the
-- subscription's own snapshot from there. A price stored on a plan would
-- be a second editable source that could silently disagree with the shop.
--
-- No discount of any kind is seeded. There is no B2C subscription
-- discount; discount_percent is left NULL, meaning not applicable rather
-- than "a discount of zero was configured".
--
-- No commitment term is seeded either. Cancellation rules are a separate
-- decision and are not invented here.
--
-- RUN THIS FILE AS ONE EXECUTION. Every section below depends on the
-- others: paste the whole file into the SQL Editor and run it once, or
-- wrap it in an explicit begin; ... commit;. Do not run the sections
-- separately and do not use "run selection". If any precondition fails,
-- the whole thing must roll back, leaving the plan table exactly as it
-- was.
-- ============================================================

-- 1. A PLAN NEEDS TO SAY WHAT IT DELIVERS ──────────────────────
--
-- Nullable, because the column is being added to a table whose future
-- shapes are not all decided - a bundle plan spanning several variants
-- would have no single one. Every launch plan sets it, and section 2
-- refuses to run if an existing row would end up active without one.

alter table public.b2c_subscription_plans
  add column variant_id uuid references public.product_variants(id);

-- The correctness constraint the seed needs, and the smallest one that
-- provides it: one active plan per variant per cadence. Without it a
-- second run with a different slug, or a later hand-written row, could
-- offer the same product on the same rhythm twice and the account UI
-- would have no way to choose between them. Partial on is_active, so a
-- retired plan can be superseded rather than blocking its replacement.
--
-- Note what it cannot do on its own: a row whose variant_id is NULL is
-- outside the predicate entirely, so the index alone would not stop an
-- old unlinked plan from offering the same product twice. That gap is
-- closed by the preconditions in section 2, not by this index.

create unique index b2c_plans_active_variant_cadence_key
  on public.b2c_subscription_plans
     (variant_id, billing_interval_unit, billing_interval_count)
  where is_active and variant_id is not null;

-- 2. THE THREE LAUNCH PLANS ────────────────────────────────────
--
-- Resolved by SKU. product_variants.sku is unique, so this is exact, and
-- it survives a database restore that reassigns UUIDs in a way a
-- hardcoded id would not.
--
-- The slug is WRITTEN here, next to the SKU it belongs to, rather than
-- derived from product_variants.label. A label is display text: renaming
-- "30 g" to "30 g Dose" in the catalog is an ordinary marketing edit,
-- and it must not be able to change a plan's identity or mint a fourth
-- slug. SKU resolves the product; the table below fixes the name.
--
-- billing and delivery cadence are deliberately identical: the customer
-- is charged for the delivery they are receiving, so a divergence between
-- the two would be a different product than the one that was agreed.
--
-- FAIL CLOSED. Before anything is written, every existing row is checked
-- against the launch set. An existing row is tolerated only if it is
-- already exactly the intended launch plan, which makes a re-run of this
-- file harmless; anything else - a plan under one of these slugs with a
-- different cadence, an inactive one, an unlinked one, or a different
-- slug already offering a 4-week Matcha subscription - raises and rolls
-- the whole migration back. Nothing here overwrites a commercial plan and
-- nothing here UPDATEs an existing row into shape: an unexpected plan is
-- a decision for a person, not a row for a migration to bulldoze.

do $$
declare
  -- Position i in both arrays describes one launch plan. SKU is the
  -- stable identity, the slug is fixed data, and neither is derived from
  -- anything a catalog edit can change.
  v_skus  constant text[] := array['GLOA-MATCHA-30G', 'GLOA-MATCHA-50G', 'GLOA-MATCHA-100G'];
  v_slugs constant text[] := array['matcha-30g-4w',   'matcha-50g-4w',   'matcha-100g-4w'];

  v_i         integer;
  v_variant   public.product_variants;
  v_existing  public.b2c_subscription_plans;
  v_missing   text[] := '{}';
  v_conflicts text[] := '{}';
  v_found     text[];
begin
  -- (a) The catalog must be what we expect. Seeding a plan for a product
  --     that does not exist would put an unbuyable option in front of a
  --     customer, so this runs to completion before anything is written.
  for v_i in 1 .. array_length(v_skus, 1) loop
    if not exists (
      select 1 from public.product_variants
      where sku = v_skus[v_i] and is_active
    ) then
      v_missing := v_missing || v_skus[v_i];
    end if;
  end loop;

  if array_length(v_missing, 1) is not null then
    raise exception 'cannot seed subscription plans: no active product variant for %', v_missing;
  end if;

  -- (b) A row already using one of the launch slugs is only acceptable if
  --     it IS the launch plan, in every field this migration would write.
  --     coalesce(..., false) matters: billing_interval_count is nullable,
  --     so an unset cadence makes the comparison NULL, and a NULL must
  --     read as "not the intended plan" rather than as "no conflict".
  for v_i in 1 .. array_length(v_skus, 1) loop
    select * into v_variant
    from public.product_variants
    where sku = v_skus[v_i] and is_active;

    select * into v_existing
    from public.b2c_subscription_plans
    where slug = v_slugs[v_i];

    if found and not coalesce(
           v_existing.variant_id is not distinct from v_variant.id
       and v_existing.billing_interval_unit   = 'week'
       and v_existing.billing_interval_count  = 4
       and v_existing.delivery_interval_unit  = 'week'
       and v_existing.delivery_interval_count = 4
       and v_existing.is_active
       and v_existing.discount_percent  is null
       and v_existing.commitment_months is null,
       false) then
      v_conflicts := v_conflicts
        || format('plan %L already exists and is not the intended launch plan', v_slugs[v_i]);
    end if;
  end loop;

  -- (c) Any other active plan already on a 4-week rhythm would become a
  --     second offer for the same cadence. The partial unique index does
  --     not catch this one, because such a row has no variant_id yet.
  select coalesce(array_agg(
           format('active plan %L already offers a 4-week cadence', slug)
           order by slug), '{}')
    into v_found
  from public.b2c_subscription_plans
  where is_active
    and not (slug = any(v_slugs))
    and ((billing_interval_unit  = 'week' and billing_interval_count  = 4)
      or (delivery_interval_unit = 'week' and delivery_interval_count = 4));

  v_conflicts := v_conflicts || v_found;

  -- (d) And any other active plan already pointing at one of the three
  --     launch variants, on any cadence, would mean the customer is
  --     offered that product twice.
  select coalesce(array_agg(
           format('active plan %L already points at launch variant %L', p.slug, v.sku)
           order by p.slug), '{}')
    into v_found
  from public.b2c_subscription_plans p
  join public.product_variants v on v.id = p.variant_id
  where p.is_active
    and v.sku = any(v_skus)
    and not (p.slug = any(v_slugs));

  v_conflicts := v_conflicts || v_found;

  if array_length(v_conflicts, 1) is not null then
    raise exception
      'existing B2C subscription plan data requires manual review before this migration can run: %',
      array_to_string(v_conflicts, '; ');
  end if;

  -- (e) Only now, with the plan table proven to hold nothing unexpected,
  --     are the launch plans written. on conflict (slug) do nothing can
  --     only fire for a row (b) already proved identical to what would be
  --     inserted, so it is genuine idempotency rather than a silent skip.
  for v_i in 1 .. array_length(v_skus, 1) loop
    select * into v_variant
    from public.product_variants
    where sku = v_skus[v_i] and is_active;

    insert into public.b2c_subscription_plans (
      slug,
      name,
      description,
      variant_id,
      billing_interval_unit,
      billing_interval_count,
      delivery_interval_unit,
      delivery_interval_count,
      is_active,
      sort_order
    ) values (
      v_slugs[v_i],
      -- The label is fine HERE: this is display text, and a later catalog
      -- rename leaving a stale plan name is a cosmetic problem, not an
      -- identity one.
      'GLOA Matcha ' || v_variant.label || ' · alle 4 Wochen',
      'Lieferung alle 4 Wochen (28 Tage). Preis wie im Shop, kein Abo-Rabatt.',
      v_variant.id,
      'week',
      4,
      'week',
      4,
      true,
      coalesce(v_variant.size_grams, 0)
    )
    on conflict (slug) do nothing;
  end loop;
end;
$$;

-- 3. THE PLAN TABLE IS NOT A BROWSER-WRITABLE TABLE ────────────
--
-- Same targeted pattern as migration 023, and the same reason: take
-- everything back from the three Supabase roles, then hand back only what
-- was audited as necessary. Confirmed live state before this migration:
--
--   anon           REFERENCES, TRIGGER, TRUNCATE
--   authenticated  REFERENCES, SELECT, TRIGGER, TRUNCATE
--   service_role   REFERENCES, TRIGGER, TRUNCATE
--
-- Of those, exactly one was ever granted on purpose: migration 005's
-- "grant select on public.b2c_subscription_plans to authenticated". The
-- rest are Supabase's schema defaults. TRUNCATE would empty the plan
-- table without producing a row for RLS to filter, REFERENCES lets
-- another table point a foreign key at it, and TRIGGER attaches code to
-- it - none of which any client needs, and none of which a policy can
-- restrain.
--
-- WHAT WAS AUDITED, and what it produced:
--
--   authenticated  SELECT. The account area reads active plans through
--                  the policy from 005. This is the one intended grant
--                  and it is restored unchanged.
--
--   anon           NOTHING. No repository evidence of a public plan read
--                  exists: the shop pages read products and variants, not
--                  plans, and migration 005 never granted anon anything.
--                  Subscription plans are an account-area concern.
--
--   service_role   NOTHING. Searched for, and there is no caller: no file
--                  in lib/ or app/ queries b2c_subscription_plans at all
--                  (the only mention anywhere is a comment in
--                  app/AccountPortal.tsx explaining why no booking form
--                  exists yet). create_pending_subscription takes a
--                  plan_id but is security definer, so it acts with its
--                  owner's privileges and does not need one either -
--                  exactly the point migration 023 records about the
--                  order and activation functions.
--
--                  When Task 29D-D adds the server route that resolves a
--                  cadence from an active plan, THAT migration grants
--                  select to service_role, next to the code that needs
--                  it. Granting it here in advance would be granting a
--                  privilege no caller has asked for.
--
-- Deliberately NOT done here, for the same reasons as 023: nothing
-- touches the table owner, nothing is granted to PUBLIC, no policy is
-- created or altered, RLS is left enabled, and schema-wide
-- ALTER DEFAULT PRIVILEGES are left alone. Changing those would silently
-- affect every other table in the project and belongs in a dedicated
-- audit.
--
-- No row is read, written or deleted by this section.

revoke all privileges on table public.b2c_subscription_plans
  from anon, authenticated, service_role;

grant select on table public.b2c_subscription_plans to authenticated;

-- 4. VERIFY ────────────────────────────────────────────────────
--
-- Read-only. Run after applying.
--
-- (a) Exactly three active plans, all week/4, each on a real Matcha SKU,
--     none carrying a discount or a commitment.
--
--   select p.slug, p.name, v.sku, v.price_gross_cents,
--          p.billing_interval_unit, p.billing_interval_count,
--          p.delivery_interval_unit, p.delivery_interval_count,
--          p.discount_percent, p.commitment_months, p.is_active
--   from public.b2c_subscription_plans p
--   join public.product_variants v on v.id = p.variant_id
--   where p.is_active
--   order by p.sort_order;
--
-- (b) The slugs are the intended ones and every plan carries its variant.
--     Expected: three rows, and active_without_variant = 0.
--
--   select count(*) filter (where is_active)                        as active_total,
--          count(*) filter (where is_active and variant_id is null) as active_without_variant,
--          count(*)                                                 as total
--   from public.b2c_subscription_plans;
--
--   select slug, variant_id is not null as linked
--   from public.b2c_subscription_plans
--   order by slug;
--
-- (c) No other cadence exists. Expected: one row, week | 4 | 3.
--
--   select billing_interval_unit, billing_interval_count, count(*)
--   from public.b2c_subscription_plans
--   where is_active
--   group by 1, 2
--   order by 1, 2;
--
-- (d) The Metal Case has no plan. Expected: zero rows.
--
--   select p.slug, v.sku
--   from public.b2c_subscription_plans p
--   join public.product_variants v on v.id = p.variant_id
--   where v.sku not like 'GLOA-MATCHA-%';
--
-- (e) The correctness constraint is in place, and nothing escaped it.
--     Expected: one index row, zero duplicate rows.
--
--   select indexname, indexdef
--   from pg_indexes
--   where schemaname = 'public'
--     and indexname = 'b2c_plans_active_variant_cadence_key';
--
--   select variant_id, billing_interval_unit, billing_interval_count, count(*)
--   from public.b2c_subscription_plans
--   where is_active and variant_id is not null
--   group by 1, 2, 3
--   having count(*) > 1;
--
-- (f) The plan table still stores no price, so the catalog stays the one
--     commercial truth. Expected: zero rows.
--
--   select column_name
--   from information_schema.columns
--   where table_schema = 'public'
--     and table_name = 'b2c_subscription_plans'
--     and (column_name like '%price%' or column_name like '%amount%'
--          or column_name like '%cents%');
--
-- (g) The grants are now what section 3 audited. Expected EXACTLY one
--     row: authenticated | SELECT. No anon row, no service_role row, and
--     no REFERENCES, TRIGGER or TRUNCATE anywhere.
--
--   select grantee, privilege_type
--   from information_schema.role_table_grants
--   where table_schema = 'public' and table_name = 'b2c_subscription_plans'
--     and grantee in ('anon', 'authenticated', 'service_role')
--   order by grantee, privilege_type;
--
-- (h) The same question asked of the raw ACL, which also shows the owner
--     and would reveal a grant to PUBLIC as a leading "=" entry.
--     Expected: an authenticated entry holding only r, and no anon,
--     service_role or PUBLIC entry.
--
--   select relname,
--          coalesce(array_to_string(relacl, E'\n'), '(no explicit acl)') as acl
--   from pg_class
--   where relnamespace = 'public'::regnamespace
--     and relname = 'b2c_subscription_plans';
--
-- (i) RLS is untouched: still enabled, still exactly the one SELECT
--     policy from migration 005, and still no write policy.
--
--     Note for the reader: that policy carries no TO clause, so it
--     nominally applies to every role. anon still cannot read a plan,
--     because after section 3 it holds no SELECT privilege at all, and a
--     policy cannot grant what the privilege layer denies. This migration
--     deliberately does not narrow the policy - changing the RLS model is
--     not what it is for.
--
--   select relrowsecurity, relforcerowsecurity
--   from pg_class where oid = 'public.b2c_subscription_plans'::regclass;
--
--   select policyname, cmd, roles, qual, with_check
--   from pg_policies
--   where schemaname = 'public' and tablename = 'b2c_subscription_plans';
--
-- (j) The catalog is unchanged. Expected: 30 g = 1999, 50 g = 2999,
--     100 g = 5499, all still active, same as before this migration.
--
--   select v.sku, v.label, v.size_grams, v.price_gross_cents, v.is_active
--   from public.products p
--   join public.product_variants v on v.product_id = p.id
--   where p.slug = 'matcha'
--   order by v.sort_order;
--
-- (k) Nothing else moved. Expected: identical to migration 023's verify
--     (d) - authenticated keeps SELECT on the customer-facing tables and
--     anon appears nowhere.
--
--   select table_name, grantee, privilege_type
--   from information_schema.role_table_grants
--   where table_schema = 'public'
--     and table_name in ('subscriptions', 'subscription_items',
--                        'stripe_customers', 'checkout_attempts',
--                        'products', 'product_variants')
--     and grantee in ('anon', 'authenticated')
--   order by table_name, grantee, privilege_type;
