-- ══════════════════════════════════════════════════════════════
-- 061 — B2B SELF-SERVICE: THE PENDING AGREEMENT WRITER
--
-- 059 gave the self-service agreement its shape and 060 gave the
-- contract its payment and delivery tables. Both deliberately shipped
-- WITHOUT a writer and WITHOUT a write privilege:
--
--   059 section 11  "NO writer. Package 5 brings the write surface
--                    together with the runtime that needs it."
--   060 section 15  "Package 5 brings the trusted write surface and
--                    grants exactly the privileges that surface needs,
--                    at the same time and in the same review."
--
-- This is the first instalment of that surface, and it is deliberately
-- ONE FUNCTION. Package 5A creates a PENDING agreement for a checkout
-- attempt and nothing else. Activation, instalments, deliveries,
-- invoicing, holds and quantity changes are later subpackages and get
-- later migration numbers; putting them here would mean granting a
-- capability before the runtime that calls it exists to be reviewed
-- beside it.
--
-- ── WHAT THIS MIGRATION CREATES ───────────────────────────────
--
--   public.create_pending_b2b_agreement_for_attempt(...)
--
-- and nothing else. No table, no column, no index, no policy, no RLS
-- change, and NO TABLE PRIVILEGE OF ANY KIND.
--
-- ── RPC-ONLY WRITES, STATED AS A PROPERTY ─────────────────────
--
-- service_role holds SELECT on the four commerce tables and NOTHING
-- MORE - 060 revoked everything and granted back exactly one privilege,
-- and this migration does not widen that by a single verb. The write
-- authority is the FUNCTION OWNER, reached only through SECURITY
-- DEFINER, and the only role that may reach it is service_role via
-- EXECUTE.
--
-- So the posture after 061 is:
--
--   anon           no read, no write, no EXECUTE
--   authenticated  SELECT through RLS on own rows; no write, no EXECUTE
--   service_role   SELECT; NO direct INSERT/UPDATE/DELETE; EXECUTE on
--                  exactly this one writer
--   browser        never writes a commerce table, by privilege rather
--                  than by convention
--
-- A direct `insert into public.b2b_supply_agreements` issued with the
-- service key fails with insufficient_privilege (42501) after this
-- migration exactly as it did before it. That is the point.
--
-- ── WHAT THE CALLER MAY NOT DECIDE ────────────────────────────
--
-- Almost everything is DERIVED IN SQL rather than accepted:
--
--   user_id                          from the locked checkout attempt
--   currency                         from the locked checkout attempt
--   pricing_rules_version            constant 'b2b-2026.1'
--   pack_grams / pack_net_cents      constants 500 / 5250
--   base_monthly_product_net_cents   packs x 5250
--   discount_percent                 0 monthly / 15 annual
--   delivery_count                   NULL monthly / 12 annual
--   contract_product_net_cents       NULL monthly / the 059 formula
--   commitment_months                NULL monthly / 12 annual
--   billing / delivery intervals     from plan_type and instalment_count
--   status                           always 'pending'
--   the eight legacy money columns   always NULL
--   offer_model_id                   always NULL
--   the canonical item's product     constants mirroring the agreement
--
-- THE CALLER CANNOT INVENT A PRICE. It supplies the configuration -
-- which plan, how many packs, how many instalments - and the database
-- computes every amount from the same constants and the same rounding
-- that lib/b2bPricingRules.ts uses. The one money-shaped input is
-- pricing_snapshot, and 059's
-- b2b_supply_agreements_self_service_pricing_snapshot_check
-- cross-validates every figure in it against the columns derived here,
-- so a snapshot that disagrees with the derivation is a CHECK violation
-- rather than a stored disagreement.
--
-- ── AND WHAT IT DELIBERATELY DOES NOT DO ──────────────────────
--
--   NO activation. status is 'pending', started_at stays NULL.
--   NO stripe_subscription_id, and no Stripe object of any kind.
--   NO b2b_payment_schedule row. NO b2b_deliveries row. NO order.
--   NO shipping resolution, no shipping_class, no routing snapshot and
--      no package dimension - 060 forbids storing a refusal as a route
--      and Package 5E owns resolution.
--   NO entitlement. A pending agreement is a priced intent waiting for
--      a payment that has not been asked for yet.
--   NO total cross-check against the attempt. 039 compares the annual
--      plan's total with checkout_attempts.expected_total_gross_cents,
--      and the B2B equivalent cannot be written yet: WHICH gross an
--      attempt freezes - a monthly period, the first annual instalment,
--      or the whole contract - is a Package 5B decision about the
--      Stripe flow. Asserting one here would design 5A into a model
--      5B has not chosen. It is recorded as owed, not guessed.
--
-- ── FAIL CLOSED ───────────────────────────────────────────────
--
-- Plain CREATE FUNCTION, not CREATE OR REPLACE. If a function of this
-- name already exists the schema is not what it is believed to be, and
-- a failed migration inside a rolled-back transaction is the right
-- outcome rather than silently redefining a writer.
-- ══════════════════════════════════════════════════════════════

begin;


-- ══════════════════════════════════════════════════════════════
-- 1. THE WRITER
-- ══════════════════════════════════════════════════════════════
--
-- ── OWNERSHIP IS DERIVED, NOT ASSERTED ────────────────────────
--
-- 039's create_pending_annual_plan_for_attempt takes a p_user_id and
-- REFUSES when it disagrees with the attempt. This one goes further: the
-- agreement's user_id is READ OFF THE LOCKED ATTEMPT and the parameter
-- is only ever a claim to be checked. A caller pairing user A's attempt
-- with user B is therefore not merely refused, it is unrepresentable -
-- there is no code path on which p_expected_user_id reaches a column.
--
-- The claim is still required, and still checked first, for 039's
-- reason: answering the existing-agreement branch before proving
-- ownership would turn a guessed attempt id into an oracle that leaks
-- an agreement id and its status.
--
-- A GUEST ATTEMPT IS REFUSED OUTRIGHT. checkout_attempts.user_id is
-- nullable (009) because the one-time B2C flow allows guest checkout. A
-- supply agreement is a commercial contract between GLOA and a named
-- business and has nowhere to put an anonymous buyer, so a NULL user_id
-- is rejected rather than propagated.
--
-- AND THE ACCOUNT MUST BE A BUSINESS ACCOUNT. public.is_business_user()
-- cannot be used here: it reads auth.uid(), which is NULL inside a
-- service_role RPC, so it would answer false for every caller. The same
-- question is asked directly of public.profiles instead - the exact
-- predicate 003's function uses, against the derived user id.

create function public.create_pending_b2b_agreement_for_attempt(
  p_checkout_attempt_id       uuid,
  p_expected_user_id          uuid,
  p_plan_type                 text,
  p_quantity_packs            integer,
  p_instalment_count          integer,
  p_pricing_snapshot          jsonb,
  p_business_snapshot         jsonb,
  p_customer_snapshot         jsonb,
  p_shipping_address_snapshot jsonb,
  p_billing_address_snapshot  jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_attempt     public.checkout_attempts;
  v_agreement   public.b2b_supply_agreements;
  v_user_id     uuid;
  v_is_business boolean;

  -- The launch constants, restated here because a function that reads
  -- them from a table would be reading a second pricing authority.
  -- 059's CHECKs hold the same three values and will refuse any row
  -- that disagrees with them.
  v_pack_grams     constant integer := 500;
  v_pack_net_cents constant integer := 5250;
  v_rules_version  constant text    := 'b2b-2026.1';

  v_base_monthly   integer;
  v_discount       integer;
  v_delivery_count integer;
  v_contract_net   integer;
  v_commitment     integer;
  v_billing_count  integer;
begin
  -- ── INPUT DOMAIN, BEFORE ANYTHING IS LOCKED ─────────────────
  --
  -- Cheap, total, and it keeps a malformed call from taking a row lock.
  if p_checkout_attempt_id is null
     or p_expected_user_id is null
     or p_plan_type is null
     or p_quantity_packs is null
     or p_pricing_snapshot is null
     or p_business_snapshot is null
     or p_customer_snapshot is null
     or p_shipping_address_snapshot is null
     or p_billing_address_snapshot is null
  then
    return pg_catalog.jsonb_build_object('result', 'invalid_input');
  end if;

  if p_plan_type not in ('monthly', 'annual') then
    return pg_catalog.jsonb_build_object('result', 'invalid_plan_type');
  end if;

  if p_quantity_packs < 1 or p_quantity_packs > 10 then
    return pg_catalog.jsonb_build_object('result', 'invalid_quantity');
  end if;

  -- The instalment count belongs to the annual plan and to nothing else.
  -- A monthly agreement carrying one would be a monthly contract
  -- claiming a payment schedule that 060 forbids it to have.
  if p_plan_type = 'monthly' and p_instalment_count is not null then
    return pg_catalog.jsonb_build_object('result', 'monthly_takes_no_instalments');
  end if;

  if p_plan_type = 'annual'
     and (p_instalment_count is null or p_instalment_count not in (1, 2, 4))
  then
    return pg_catalog.jsonb_build_object('result', 'invalid_instalment_count');
  end if;

  -- Every snapshot 006 declared NOT NULL must be an OBJECT. A jsonb
  -- 'null', a number or an array would satisfy the NOT NULL and store
  -- something no reader could use.
  if pg_catalog.jsonb_typeof(p_pricing_snapshot) <> 'object'
     or pg_catalog.jsonb_typeof(p_business_snapshot) <> 'object'
     or pg_catalog.jsonb_typeof(p_customer_snapshot) <> 'object'
     or pg_catalog.jsonb_typeof(p_shipping_address_snapshot) <> 'object'
     or pg_catalog.jsonb_typeof(p_billing_address_snapshot) <> 'object'
  then
    return pg_catalog.jsonb_build_object('result', 'invalid_snapshot_shape');
  end if;

  -- ── THE LOCK, FIRST ─────────────────────────────────────────
  --
  -- Everything below decides whether an agreement exists and creates one
  -- if it does not. Both halves must see the same attempt, and two
  -- concurrent callers must not both reach the insert believing they are
  -- the first.
  select * into v_attempt
  from public.checkout_attempts
  where id = p_checkout_attempt_id
  for update;

  if not found then
    return pg_catalog.jsonb_build_object('result', 'attempt_not_found');
  end if;

  -- ── OWNERSHIP, BEFORE ANY AGREEMENT IS RESOLVED OR REPORTED ──
  if v_attempt.user_id is null then
    return pg_catalog.jsonb_build_object('result', 'attempt_not_account_bound');
  end if;

  if v_attempt.user_id is distinct from p_expected_user_id then
    return pg_catalog.jsonb_build_object('result', 'attempt_not_owned');
  end if;

  -- THE AGREEMENT'S OWNER IS THE ATTEMPT'S OWNER. The parameter was a
  -- claim; this is the fact, and it is the only value that reaches a
  -- column.
  v_user_id := v_attempt.user_id;

  select exists (
    select 1 from public.profiles
    where user_id = v_user_id
      and customer_type = 'business'
  ) into v_is_business;

  if not v_is_business then
    return pg_catalog.jsonb_build_object('result', 'not_business_account');
  end if;

  -- ── THE DERIVATION. No caller input reaches any of these. ────
  --
  -- The annual contract amount is 059's formula, which is
  -- lib/b2bPricingRules.ts annualProductNetCents() written as integer
  -- arithmetic: fifteen percent off the full twelve-month base, rounded
  -- half-up exactly once, at the end. divideRoundHalfUp(n, d) is
  -- floor((2n + d) / 2d), so with d = 100 it is
  --
  --   (2 * (base * 12 * 85) + 100) / 200
  --
  -- PostgreSQL integer division truncates toward zero and every operand
  -- is non-negative, so `/` is floor - identical to Math.floor. bigint
  -- keeps the intermediate exact.
  v_base_monthly := p_quantity_packs * v_pack_net_cents;

  if p_plan_type = 'monthly' then
    v_discount       := 0;
    v_delivery_count := null;
    v_contract_net   := null;
    v_commitment     := null;
    v_billing_count  := 1;
  else
    v_discount       := 15;
    v_delivery_count := 12;
    v_contract_net   := ((2 * (v_base_monthly::bigint * 12 * 85) + 100) / 200)::integer;
    v_commitment     := 12;
    -- 1 -> 12, 2 -> 6, 4 -> 3. Exact for all three admitted values, and
    -- the domain check above is what keeps it exact.
    v_billing_count  := 12 / p_instalment_count;
  end if;

  -- ── ALREADY CLAIMED? ────────────────────────────────────────
  --
  -- Reached only by the attempt's own owner, and BEFORE the pre-Stripe
  -- test below: a legitimate retry after a Stripe session already exists
  -- has an attempt that is no longer pre-Stripe and must still be
  -- answered with the agreement it already has.
  select * into v_agreement
  from public.b2b_supply_agreements
  where checkout_attempt_id = p_checkout_attempt_id;

  if found then
    -- THE REPLAY IS ONLY A REPLAY IF IT ASKS FOR THE SAME CONTRACT.
    --
    -- Same attempt + same commercial inputs  -> the existing agreement
    -- Same attempt + different inputs        -> refused, nothing mutated
    --
    -- The comparison is on the DERIVED figures as well as the raw
    -- inputs, so a caller cannot reach a different contract through a
    -- different route to the same arguments. Nothing is overwritten on
    -- either branch: this function has no UPDATE in it at all.
    if v_agreement.plan_type is distinct from p_plan_type
       or v_agreement.quantity_packs is distinct from p_quantity_packs
       or v_agreement.instalment_count is distinct from p_instalment_count
       or v_agreement.base_monthly_product_net_cents is distinct from v_base_monthly
       or v_agreement.contract_product_net_cents is distinct from v_contract_net
       or v_agreement.discount_percent is distinct from v_discount
       or v_agreement.delivery_count is distinct from v_delivery_count
       or v_agreement.user_id is distinct from v_user_id
    then
      return pg_catalog.jsonb_build_object(
        'result', 'conflicting_agreement',
        'agreement_id', v_agreement.id,
        'existing_plan_type', v_agreement.plan_type,
        'existing_quantity_packs', v_agreement.quantity_packs,
        'existing_instalment_count', v_agreement.instalment_count
      );
    end if;

    return pg_catalog.jsonb_build_object(
      'result', 'existing',
      'agreement_id', v_agreement.id,
      'status', v_agreement.status
    );
  end if;

  -- ── NO AGREEMENT YET, SO THE ATTEMPT MUST STILL BE PRE-STRIPE ─
  --
  -- The ordering contract, exactly as 039 states it for the annual plan:
  --
  --     checkout attempt  ->  pending agreement  ->  Stripe session
  --
  -- The agreement has to exist before the session so its id can go into
  -- the session's metadata as gloa_b2b_agreement_id, which is what lets
  -- the future webhook resolve the contract against trusted local data
  -- rather than against anything the payload claims.
  --
  -- 'created' is the exact pre-Stripe state: 009 defaults the column to
  -- it, lib/checkoutAttempts.ts inserts without a status, and
  -- linkStripeSession is what moves it on. 'failed' and 'expired' are
  -- past states and 'paid' is a settled payment; none of them may mint a
  -- contract.
  --
  -- The Stripe and cross-flow identity columns are checked as well as
  -- the status, because the status is a workflow marker while those are
  -- evidence that another object already owns this attempt.
  if v_attempt.status <> 'created'
     or v_attempt.stripe_checkout_session_id is not null
     or v_attempt.stripe_payment_intent_id is not null
     or v_attempt.stripe_invoice_id is not null
     or v_attempt.subscription_id is not null
     or v_attempt.annual_plan_id is not null
     or v_attempt.annual_delivery_number is not null
  then
    return pg_catalog.jsonb_build_object(
      'result', 'attempt_not_pre_stripe',
      'attempt_status', v_attempt.status
    );
  end if;

  -- ── THE WRITE ───────────────────────────────────────────────
  --
  -- The agreement and its canonical line, in one transaction and in one
  -- function. 059 section 9's assertion is DEFERRABLE INITIALLY
  -- DEFERRED, so the order of the two inserts is not a correctness
  -- question; what it checks at COMMIT is that the line mirrors the
  -- agreement, which it does by construction here.
  --
  -- The canonical item is created NOW rather than at activation. 059's
  -- assertion requires exactly one only once the agreement is ACTIVE,
  -- but it requires any line that EXISTS to mirror the agreement at
  -- every status - so creating it here is permitted, and it means
  -- activation has one less thing to get right.
  begin
    insert into public.b2b_supply_agreements (
      user_id,
      customer_type,
      offer_model_id,
      status,
      currency,
      offer_model_snapshot,
      business_snapshot,
      customer_snapshot,
      shipping_address_snapshot,
      billing_address_snapshot,
      plan_type,
      pricing_rules_version,
      pack_grams,
      pack_net_cents,
      quantity_packs,
      discount_percent,
      delivery_count,
      base_monthly_product_net_cents,
      contract_product_net_cents,
      instalment_count,
      pricing_snapshot,
      checkout_attempt_id,
      billing_interval_unit,
      billing_interval_count,
      delivery_interval_unit,
      delivery_interval_count,
      commitment_months
    ) values (
      v_user_id,
      'business',
      null,
      'pending',
      v_attempt.currency,
      '{}'::jsonb,
      p_business_snapshot,
      p_customer_snapshot,
      p_shipping_address_snapshot,
      p_billing_address_snapshot,
      p_plan_type,
      v_rules_version,
      v_pack_grams,
      v_pack_net_cents,
      p_quantity_packs,
      v_discount,
      v_delivery_count,
      v_base_monthly,
      v_contract_net,
      p_instalment_count,
      p_pricing_snapshot,
      p_checkout_attempt_id,
      'month',
      v_billing_count,
      'month',
      1,
      v_commitment
    )
    returning * into v_agreement;
  exception
    when unique_violation then
      -- A concurrent caller won the race between the lookup above and
      -- this insert. b2b_supply_agreements_checkout_attempt_id_key is
      -- the real guard; this adopts its winner rather than raising, and
      -- re-applies the same conflict comparison so a racing caller
      -- asking for a DIFFERENT contract is still refused.
      select * into v_agreement
      from public.b2b_supply_agreements
      where checkout_attempt_id = p_checkout_attempt_id;

      if found then
        if v_agreement.plan_type is distinct from p_plan_type
           or v_agreement.quantity_packs is distinct from p_quantity_packs
           or v_agreement.instalment_count is distinct from p_instalment_count
           or v_agreement.base_monthly_product_net_cents is distinct from v_base_monthly
           or v_agreement.contract_product_net_cents is distinct from v_contract_net
           or v_agreement.discount_percent is distinct from v_discount
           or v_agreement.delivery_count is distinct from v_delivery_count
           or v_agreement.user_id is distinct from v_user_id
        then
          return pg_catalog.jsonb_build_object(
            'result', 'conflicting_agreement',
            'agreement_id', v_agreement.id,
            'existing_plan_type', v_agreement.plan_type,
            'existing_quantity_packs', v_agreement.quantity_packs,
            'existing_instalment_count', v_agreement.instalment_count
          );
        end if;

        return pg_catalog.jsonb_build_object(
          'result', 'existing',
          'agreement_id', v_agreement.id,
          'status', v_agreement.status
        );
      end if;
      raise;
  end;

  -- THE CANONICAL LINE. Every value mirrors the agreement or is a
  -- constant; 059's b2b_supply_items_canonical_shape_check requires
  -- product_size_id NULL, grams 500, base_unit_price_net_cents 5250,
  -- quantity 1..10 and all six accounting columns NULL, and the
  -- deferred assertion requires the mirror at COMMIT.
  insert into public.b2b_supply_items (
    supply_agreement_id,
    product_size_id,
    product_name,
    grams,
    quantity,
    base_unit_price_net_cents,
    item_role,
    metadata
  ) values (
    v_agreement.id,
    null,
    'GLOA Matcha',
    v_pack_grams,
    p_quantity_packs,
    v_pack_net_cents,
    'canonical_matcha',
    '{}'::jsonb
  );

  return pg_catalog.jsonb_build_object(
    'result', 'created',
    'agreement_id', v_agreement.id,
    'status', v_agreement.status,
    'plan_type', v_agreement.plan_type,
    'quantity_packs', v_agreement.quantity_packs,
    'base_monthly_product_net_cents', v_agreement.base_monthly_product_net_cents,
    'contract_product_net_cents', v_agreement.contract_product_net_cents,
    'instalment_count', v_agreement.instalment_count
  );
end;
$$;

comment on function public.create_pending_b2b_agreement_for_attempt(
  uuid, uuid, text, integer, integer, jsonb, jsonb, jsonb, jsonb, jsonb
) is
  'Package 5A. Creates or returns the PENDING self-service B2B supply agreement for one checkout attempt, with its canonical Matcha line. Derives user_id, currency and every commercial amount itself; activates nothing, touches no Stripe object and creates no payment, delivery or order row. Idempotent on checkout_attempt_id; a replay with different commercial inputs is refused and mutates nothing.';


-- ══════════════════════════════════════════════════════════════
-- 2. FUNCTION PRIVILEGES
-- ══════════════════════════════════════════════════════════════
--
-- REVOKE FROM public FIRST. A freshly created function is executable by
-- PUBLIC by default and anon and authenticated inherit that, so revoking
-- only the named roles would leave the default in place and this writer
-- reachable from the browser's own Supabase client with nothing but an
-- anon key.
--
-- Then the named browser roles explicitly - belt and braces, and it is
-- what makes the intent readable rather than implied.
--
-- service_role is the ONE grantee, because it is the one role the
-- server's admin client authenticates as. This follows the 039 writer
-- convention exactly; 059 and 060 granted to nobody only because their
-- functions were triggers and assertions with no caller.

revoke all on function public.create_pending_b2b_agreement_for_attempt(
  uuid, uuid, text, integer, integer, jsonb, jsonb, jsonb, jsonb, jsonb
) from public;

revoke all on function public.create_pending_b2b_agreement_for_attempt(
  uuid, uuid, text, integer, integer, jsonb, jsonb, jsonb, jsonb, jsonb
) from anon;

revoke all on function public.create_pending_b2b_agreement_for_attempt(
  uuid, uuid, text, integer, integer, jsonb, jsonb, jsonb, jsonb, jsonb
) from authenticated;

grant execute on function public.create_pending_b2b_agreement_for_attempt(
  uuid, uuid, text, integer, integer, jsonb, jsonb, jsonb, jsonb, jsonb
) to service_role;


-- ══════════════════════════════════════════════════════════════
-- 3. WHAT THIS MIGRATION DID NOT DO
-- ══════════════════════════════════════════════════════════════
--
-- Stated as a list because the absence is the reviewable part:
--
--   NO create table, alter table, add column, drop anything
--   NO insert, update or delete of business data
--   NO seed row
--   NO RLS change, no enable/disable, no new policy, no altered policy
--   NO table privilege: not one grant, not one revoke, on any table.
--      service_role still holds SELECT and only SELECT on
--      b2b_supply_agreements, b2b_supply_items, b2b_payment_schedule
--      and b2b_deliveries
--   NO change to 001-060, to any function they defined, or to any
--      constraint, index or trigger they created
--   NO second writer. The seven other Package 5 RPCs the architecture
--      audit named are deliberately absent and belong to later
--      migrations reviewed beside the runtime that calls them
--
-- ── READ-ONLY VERIFICATION ────────────────────────────────────
--
-- Run after applying. Nothing here writes.
--
--   -- 1. the writer exists, is definer, and pins an empty search_path
--   select p.proname, p.prosecdef, p.proconfig
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public'
--      and p.proname = 'create_pending_b2b_agreement_for_attempt';
--   -- expect: t, {search_path=""}
--
--   -- 2. exactly one grantee, and it is service_role
--   select grantee, privilege_type
--     from information_schema.routine_privileges
--    where routine_schema = 'public'
--      and routine_name = 'create_pending_b2b_agreement_for_attempt';
--   -- expect: service_role / EXECUTE, and the owner. Never anon,
--   --         authenticated or PUBLIC.
--
--   -- 3. AND service_role still has no direct write anywhere
--   select table_name, grantee, privilege_type
--     from information_schema.role_table_grants
--    where table_schema = 'public'
--      and table_name in ('b2b_supply_agreements', 'b2b_supply_items',
--                         'b2b_payment_schedule', 'b2b_deliveries')
--      and privilege_type in ('INSERT', 'UPDATE', 'DELETE')
--    order by table_name, grantee;
--   -- expect: ZERO ROWS for anon, authenticated and service_role.

commit;
