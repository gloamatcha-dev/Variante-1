-- ============================================================
-- GLOA – Subscription checkout: server plan read + atomic claim
-- (Task 29D-D, corrected by 29D-D.1 and 29D-D.2)
-- Run in Supabase SQL Editor AFTER 024
--
-- Three things, and they belong together because they are all what one
-- authenticated subscription checkout request needs before it may talk to
-- Stripe.
--
--   1. The server may read a subscription plan. This is the grant
--      migration 024 promised would arrive with its caller.
--
--   2. A checkout attempt may claim AT MOST ONE local subscription, and
--      the database is what guarantees it. The first version of this flow
--      read checkout_attempts.subscription_id, created a subscription,
--      then linked it. Two genuinely concurrent requests could both read
--      NULL and both create one; only one won the link and the loser's
--      row was left unreferenced. That is not something application code
--      can fix - a second SELECT, a retry loop or an in-process mutex all
--      fail across server instances - so the claim moves into one
--      function that serialises on the attempt row.
--
--   3. A request_id may mean exactly one checkout intent. It is an
--      idempotency token, so a retry has to be provably the SAME request.
--      That turns out to be two questions rather than one, recorded in
--      two hashed columns:
--
--        WHICH checkout is this - customer, plan, saved address. True
--        always, or the request belongs to somebody else.
--
--        Are the priced terms still the frozen ones - address contents,
--        variant, amounts, tax. Only meaningful while nothing has been
--        frozen yet.
--
--      Collapsing them into one comparison was the 29D-D.1 shape and it
--      was wrong in a way that only shows up after a subscription exists:
--      a customer who edited their saved address, or whose catalog price
--      moved, could no longer reach the Stripe session for the pending
--      subscription they already had. Nothing was wrong with that
--      subscription. The world had moved on around it.
--
-- Migration 025 had not been applied when these corrections were written,
-- so it is expanded in place rather than followed by a 026. Migrations
-- 022, 023 and 024 are live and are not touched.
--
-- RUN THIS FILE AS ONE EXECUTION: paste the whole file into the SQL
-- Editor and run it once, or wrap it in an explicit begin; ... commit;.
--
-- No row is read, written or deleted by this migration.
-- ============================================================

-- 1. THE SERVER MAY READ A PLAN ────────────────────────────────
--
-- The caller migration 024 was waiting for now exists:
-- lib/subscriptionPlans.ts reads one plan row through the service-role
-- client on behalf of app/api/subscriptions/checkout/session/route.ts,
-- which must resolve the cadence, the linked variant and the absence of a
-- discount itself before anything is charged.
--
-- WHY service_role AND NOT THE CUSTOMER'S OWN SESSION. The route already
-- holds the customer's token and could have read the plan with it: the
-- policy from 005 allows any authenticated user to select active plans.
-- It deliberately does not. The plan decides the cadence and the billing
-- terms, so the server resolves it as its own authority rather than
-- through a filtered view that a policy edit could later narrow without
-- anyone noticing. The plan table holds no personal data, so reading it
-- with the service role exposes nothing about anybody.
--
-- The opposite choice was made for the customer's address and identity,
-- and for the same reason read the other way round: those ARE personal
-- data, one person's at a time. The route reads them through the
-- customer's own authenticated session, so RLS confines the read to that
-- customer's own rows. This migration therefore does NOT grant the server
-- blanket read access to public.addresses or public.profiles, and must
-- not be extended to do so.
--
-- SELECT only. Plans are seeded by migration and changed by a person,
-- never by a checkout.

grant select on table public.b2c_subscription_plans to service_role;

-- 2. ONE REQUEST ID IS ONE CHECKOUT INTENT ─────────────────────
--
-- Two hashes, written together when the attempt is created and computed
-- in lib/subscriptionCheckoutRules.ts.
--
-- subscription_request_fingerprint covers everything that describes the
-- priced intent: the customer, the plan, the saved address AND its
-- contents, the variant, the quantity, the currency, the destination and
-- every amount including the tax identity.
--
-- subscription_intent_fingerprint covers only what the caller named: the
-- customer, the plan, the saved address and the quantity.
--
-- Why a hash and not the values. The point of comparison is only "is this
-- the same intent", never "what was it", so nothing needs to be readable
-- afterwards. Storing the parts would put a customer's delivery details
-- into a second place they do not need to be, and would make every log
-- line and every error message a potential leak. A digest compares
-- exactly as well and says nothing.
--
-- Why the address CONTENTS and not just its id. The saved address can be
-- edited between a request and its retry. Binding only the id would let
-- "same request id" cover a different street, and the subscription
-- created by the retry would be delivered somewhere the first request
-- never described. Binding a digest of the contents means an edited
-- address makes the retry a different request, which fails closed and
-- asks for a new checkout. That is what makes one request id one frozen
-- delivery intent, and it is why no second address-snapshot column is
-- needed on this table.
--
-- Nullable, with no default, and no backfill: every checkout attempt
-- written before this migration is a ONE-TIME payment attempt and has no
-- subscription intent to describe. NULL therefore means exactly that, and
-- the subscription flow refuses an attempt whose fingerprint is NULL
-- rather than adopting a one-time attempt that happens to share a
-- request_id.
--
-- Not unique: request_id already is, and a fingerprint is a property of
-- the intent rather than an identifier of it.

alter table public.checkout_attempts
  add column subscription_request_fingerprint text,
  -- The IDENTITY half, and the reason there are two columns rather than
  -- one. It holds only what the caller named: the customer, the plan, the
  -- saved address and the quantity. No price, no address content, nothing
  -- that server state can change underneath a request.
  --
  -- A retry has to answer two different questions, and they stop having
  -- the same answer the moment a subscription exists. "Is this the same
  -- checkout" must always be true, or the request is somebody else's.
  -- "Are the priced terms still the ones that were frozen" only matters
  -- while nothing has been frozen yet: once a subscription exists it IS
  -- the answer, and refusing the retry because the catalog price or the
  -- saved address changed afterwards would lock the customer out of a
  -- checkout they already started, for something that is not their doing.
  --
  -- Same shape as the column above: nullable, no default, no backfill.
  add column subscription_intent_fingerprint text;

-- 3. AT MOST ONE SUBSCRIPTION PER CHECKOUT ATTEMPT ─────────────
--
-- The atomic claim. Everything about this function exists to make the
-- decision "does this attempt already have a subscription" and the act of
-- creating one indivisible.
--
--   select ... for update  is the serialisation point. Two concurrent
--   callers for the same attempt queue on that row. Under READ COMMITTED
--   the second one re-reads the row version the first one committed, so
--   it sees the subscription_id that was just written and returns it
--   without creating anything. There is no window between the read and
--   the write for a second creation to slip into, which is exactly what
--   the previous read-create-link sequence could not promise.
--
--   The subscription itself is still created by
--   create_pending_subscription from migration 022, called rather than
--   copied. That function is unchanged and remains the only place a
--   subscription and its items are written, so the atomicity, the tax
--   snapshot requirement and the item matching it already guarantees
--   apply here unaltered.
--
-- Ownership is checked, not assumed. The attempt must belong to the user
-- the caller claims, because a subscription created against somebody
-- else's attempt would be billed to the wrong person. The route resolves
-- that user from a verified token, and this is the second check.
--
-- Nothing here activates anything. The subscription is 'pending' and only
-- invoice.paid may move it.

create or replace function public.claim_pending_subscription_for_attempt(
  p_checkout_attempt_id uuid,
  p_user_id uuid,
  p_plan_id uuid,
  -- The two digests the application verified for THIS request, re-checked
  -- below under the row lock. Without them the function trusts that the
  -- attempt id it was handed is the one the caller actually validated,
  -- and nothing in the transaction proves it. With them the claim is
  -- self-verifying: a caller that passes the wrong attempt, or an attempt
  -- whose intent no longer matches, is refused by the database rather
  -- than by the caller remembering to check.
  p_expected_intent_fingerprint text,
  p_expected_request_fingerprint text,
  p_plan_snapshot jsonb,
  p_customer_snapshot jsonb,
  p_shipping_address_snapshot jsonb,
  p_billing_address_snapshot jsonb,
  p_tax_snapshot jsonb,
  p_items jsonb
)
returns uuid
language plpgsql
volatile
security definer set search_path = ''
as $$
declare
  v_attempt public.checkout_attempts;
  v_subscription_id uuid;
begin
  if p_checkout_attempt_id is null or p_user_id is null then
    raise exception 'claiming a subscription needs an attempt and an owner';
  end if;

  -- THE serialisation point. Held until this function's transaction
  -- commits, so a concurrent caller cannot read a stale NULL.
  select * into v_attempt
  from public.checkout_attempts
  where id = p_checkout_attempt_id
  for update;

  if not found then
    raise exception 'checkout attempt % not found', p_checkout_attempt_id;
  end if;

  -- A subscription created against another customer's attempt would be
  -- billed to the wrong person, so this is a hard stop rather than a
  -- filter. is distinct from, because a one-time attempt's user_id may be
  -- NULL and NULL must not compare equal to anything.
  if v_attempt.user_id is distinct from p_user_id then
    raise exception 'checkout attempt % does not belong to this user', p_checkout_attempt_id;
  end if;

  -- Only a subscription checkout writes this. A NULL means the attempt is
  -- a one-time payment attempt, and starting a subscription on one would
  -- attach a recurring charge to a snapshot that was never priced for it.
  if v_attempt.subscription_request_fingerprint is null
     or v_attempt.subscription_intent_fingerprint is null then
    raise exception 'checkout attempt % is not a subscription checkout', p_checkout_attempt_id;
  end if;

  if v_attempt.status = 'paid' then
    raise exception 'checkout attempt % is already paid', p_checkout_attempt_id;
  end if;

  -- WHICH checkout this is, checked on every path and under the lock. A
  -- different customer, plan or saved address is a different checkout
  -- whatever has already been created.
  if p_expected_intent_fingerprint is null
     or v_attempt.subscription_intent_fingerprint <> p_expected_intent_fingerprint then
    raise exception 'checkout attempt % is a different checkout than the one claimed', p_checkout_attempt_id;
  end if;

  -- Already claimed: return the winner and create NOTHING. This is the
  -- branch a concurrent second caller and every ordinary retry take, and
  -- it is deliberately reached BEFORE the priced comparison below: the
  -- existing subscription is the frozen answer, so a catalog, shipping or
  -- address change afterwards must not be able to refuse the retry.
  if v_attempt.subscription_id is not null then
    return v_attempt.subscription_id;
  end if;

  -- The PRICED half, and only here, because this is the branch that is
  -- about to freeze those terms. They must be exactly the ones this
  -- attempt was created with.
  if p_expected_request_fingerprint is null
     or v_attempt.subscription_request_fingerprint <> p_expected_request_fingerprint then
    raise exception 'checkout attempt % was priced for different terms', p_checkout_attempt_id;
  end if;

  -- Unclaimed, and nobody else can be here at the same time for this
  -- attempt. create_pending_subscription enforces the rest: a tax
  -- snapshot must exist, there must be at least one item, and parent and
  -- items are written in one transaction.
  v_subscription_id := public.create_pending_subscription(
    p_user_id,
    p_plan_id,
    p_plan_snapshot,
    p_customer_snapshot,
    p_shipping_address_snapshot,
    p_billing_address_snapshot,
    p_tax_snapshot,
    p_items
  );

  if v_subscription_id is null then
    raise exception 'create_pending_subscription returned no subscription';
  end if;

  update public.checkout_attempts
     set subscription_id = v_subscription_id
   where id = p_checkout_attempt_id;

  return v_subscription_id;
end;
$$;

-- Server-only, in exactly the shape migration 022 uses for its two RPCs.
-- revoke from public first: a function is executable by PUBLIC by
-- default, so granting service_role without revoking would leave anon and
-- authenticated able to create subscriptions.

revoke all on function public.claim_pending_subscription_for_attempt(
  uuid, uuid, uuid, text, text, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb
) from public, anon, authenticated;

grant execute on function public.claim_pending_subscription_for_attempt(
  uuid, uuid, uuid, text, text, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb
) to service_role;

-- 4. VERIFY ────────────────────────────────────────────────────
--
-- Read-only. Run after applying. Nothing below writes a row.
--
-- (a) A. The plan table's grants. Expected EXACTLY two rows:
--
--       b2c_subscription_plans | authenticated | SELECT
--       b2c_subscription_plans | service_role  | SELECT
--
--     No anon row. No INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES or
--     TRIGGER for anyone.
--
--   select table_name, grantee, privilege_type
--   from information_schema.role_table_grants
--   where table_schema = 'public' and table_name = 'b2c_subscription_plans'
--     and grantee in ('anon', 'authenticated', 'service_role')
--   order by grantee, privilege_type;
--
-- (b) The same question asked of the raw ACL, which would also reveal a
--     grant to PUBLIC as a leading "=" entry. Expected: authenticated and
--     service_role each holding only r, and no anon or PUBLIC entry.
--
--   select relname,
--          coalesce(array_to_string(relacl, E'\n'), '(no explicit acl)') as acl
--   from pg_class
--   where relnamespace = 'public'::regnamespace
--     and relname = 'b2c_subscription_plans';
--
-- (c) RLS and the policy are untouched. Expected: relrowsecurity true,
--     and exactly the one SELECT policy from migration 005.
--
--   select relrowsecurity, relforcerowsecurity
--   from pg_class where oid = 'public.b2c_subscription_plans'::regclass;
--
--   select policyname, cmd, roles, qual, with_check
--   from pg_policies
--   where schemaname = 'public' and tablename = 'b2c_subscription_plans';
--
-- (d) B, C, D. The new RPC exists, is SECURITY DEFINER, and has its
--     search path pinned empty. Expected exactly one row:
--     prosecdef = true, proconfig = {search_path=""}.
--
--   select p.proname, p.prosecdef as security_definer, p.proconfig,
--          pg_get_function_identity_arguments(p.oid) as arguments
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public'
--     and p.proname = 'claim_pending_subscription_for_attempt';
--
--     Expected arguments, in this order:
--       p_checkout_attempt_id uuid, p_user_id uuid, p_plan_id uuid,
--       p_expected_intent_fingerprint text,
--       p_expected_request_fingerprint text,
--       p_plan_snapshot jsonb, p_customer_snapshot jsonb,
--       p_shipping_address_snapshot jsonb, p_billing_address_snapshot jsonb,
--       p_tax_snapshot jsonb, p_items jsonb
--
--     Exactly ONE overload must exist. create or replace does not remove a
--     function with a different signature, so if an earlier draft of this
--     file was ever run, the older 9-argument version would still be
--     there and would still be callable. Expected: one row.
--
--   select count(*) as overloads
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public'
--     and p.proname = 'claim_pending_subscription_for_attempt';
--
-- (e) E, F, G. Who may execute it. Expected: service_role TRUE, anon and
--     authenticated FALSE, PUBLIC FALSE.
--
--   select 'anon'          as role, has_function_privilege('anon',          p.oid, 'EXECUTE') as can_execute
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public' and p.proname = 'claim_pending_subscription_for_attempt'
--   union all
--   select 'authenticated', has_function_privilege('authenticated', p.oid, 'EXECUTE')
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public' and p.proname = 'claim_pending_subscription_for_attempt'
--   union all
--   select 'service_role',  has_function_privilege('service_role',  p.oid, 'EXECUTE')
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public' and p.proname = 'claim_pending_subscription_for_attempt'
--   order by role;
--
--     And the raw ACL, where a bare "=X/" entry would mean PUBLIC can
--     still execute. Expected: no such entry.
--
--   select p.proname,
--          coalesce(array_to_string(p.proacl, E'\n'),
--                   '(default - PUBLIC can execute)') as acl
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public'
--     and p.proname in ('claim_pending_subscription_for_attempt',
--                       'create_pending_subscription',
--                       'activate_subscription_from_invoice')
--   order by p.proname;
--
-- (f) H. The two new columns. Expected TWO rows, both text, both
--     is_nullable = YES, both column_default NULL.
--
--   select column_name, data_type, is_nullable, column_default
--   from information_schema.columns
--   where table_schema = 'public'
--     and table_name = 'checkout_attempts'
--     and column_name in ('subscription_request_fingerprint',
--                         'subscription_intent_fingerprint')
--   order by column_name;
--
--     And no existing attempt acquired either. Expected: both counts 0 on
--     a database where no subscription checkout has run yet, and attempts
--     equal to whatever the one-time flow has already written.
--
--   select count(*)                                    as attempts,
--          count(subscription_request_fingerprint)     as with_request_fingerprint,
--          count(subscription_intent_fingerprint)      as with_intent_fingerprint
--   from public.checkout_attempts;
--
-- (g) I. The checkout_attempts privilege model is unchanged from 023.
--     Expected exactly: service_role INSERT, SELECT, UPDATE, and no anon
--     or authenticated row.
--
--   select grantee, privilege_type
--   from information_schema.role_table_grants
--   where table_schema = 'public' and table_name = 'checkout_attempts'
--     and grantee in ('anon', 'authenticated', 'service_role')
--   order by grantee, privilege_type;
--
-- (h) Migration 022's own RPCs are untouched by this migration.
--     Expected: both still security definer, both still service_role only.
--
--   select p.proname, p.prosecdef as security_definer, p.proconfig
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public'
--     and p.proname in ('create_pending_subscription',
--                       'activate_subscription_from_invoice')
--   order by p.proname;
--
-- (i) The personal-data tables did NOT gain a server-side read.
--     Expected: no service_role row for either table.
--
--   select table_name, grantee, privilege_type
--   from information_schema.role_table_grants
--   where table_schema = 'public'
--     and table_name in ('addresses', 'profiles')
--     and grantee in ('anon', 'authenticated', 'service_role')
--   order by table_name, grantee, privilege_type;
--
-- (j) The three launch plans are still exactly what 024 seeded, and the
--     catalog still holds the only price. Expected: three rows, week | 4.
--
--   select p.slug, v.sku, v.price_gross_cents,
--          p.billing_interval_unit, p.billing_interval_count,
--          p.delivery_interval_unit, p.delivery_interval_count,
--          p.discount_percent, p.commitment_months, p.is_active
--   from public.b2c_subscription_plans p
--   join public.product_variants v on v.id = p.variant_id
--   where p.is_active
--   order by p.sort_order;
