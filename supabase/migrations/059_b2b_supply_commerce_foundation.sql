-- ══════════════════════════════════════════════════════════════
-- 059 — B2B SELF-SERVICE SUPPLY COMMERCE: THE AGREEMENT AND ITS ITEM
--
-- Packages 1 to 3 established the authorities in TypeScript and proved
-- them with focused suites:
--
--   lib/b2bPricingRules.ts      b2b-2026.1     500 g packs at 5250 net,
--                               1 to 10 packs, monthly at 0 % and annual
--                               at 15 % off the TWELVE-MONTH base
--   lib/b2bShippingRules.ts     dhl-de-2026.1  Berlin free, Germany by
--                               DHL reference, else unsupported
--   lib/b2bBerlinEligibility.ts berlin-2026.1
--   lib/tax.ts                  de-net-2026.1  net-origin VAT
--
-- This migration gives the DATABASE the same rules, for the agreement
-- and its canonical item. It creates no table. Payment instalments and
-- delivery history are a separate migration (060) and are NOT in 059.
--
-- ── WHAT THIS MIGRATION IS FOR ────────────────────────────────
--
-- b2b_supply_agreements was built by migration 006 for a NEGOTIATED
-- offer: an offer_model_id pointing at the 003 draft, eight money
-- columns defaulted to 0, and free-form intervals. None of that
-- describes a self-service contract a business signs at the till.
--
-- Rather than a second agreement table, 059 EVOLVES this one and splits
-- it by plan_type:
--
--   plan_type IS NULL       a legacy / negotiated agreement. 059 adds no
--                           rule to it beyond what 006 already said.
--   plan_type IS NOT NULL   a self-service agreement. Every commercial
--                           constant, both plan shapes and the whole
--                           cancellation vocabulary are enforced here.
--
-- The split is enforced in BOTH directions: a legacy row may not carry
-- half a self-service configuration, and a self-service row may not fall
-- back on a legacy accounting column.
--
-- ── FAIL CLOSED, DELIBERATELY ─────────────────────────────────
--
-- Production preflight proved every object below is absent. So this file
-- uses plain ADD COLUMN, ADD CONSTRAINT and CREATE INDEX - no
-- IF NOT EXISTS anywhere. If any of it already exists, the schema is not
-- what preflight said it was, and the right outcome is a failed
-- migration inside a rolled-back transaction rather than a silent
-- accept of unexplained drift.
--
-- Every CHECK added to an existing table is validated against existing
-- rows as it is added. Every self-service predicate is guarded by
-- `plan_type IS NULL OR ...`, so a legacy row satisfies it trivially.
-- The constraints that are NOT plan-guarded - the cancellation
-- vocabulary and ended_at >= started_at - are the only ones that could
-- reject an existing row, and that too is the correct outcome rather
-- than something to weaken.
--
-- ── WHAT THIS MIGRATION DOES NOT DO ───────────────────────────
--
--   NO DROP COLUMN, DROP TABLE, DROP INDEX, DROP CONSTRAINT
--   NO DELETE, UPDATE or INSERT of any business data
--   NO seed rows
--   NO change to the legacy anonymous status CHECK from 006
--   NO change to RLS, to any policy, or to any table privilege
--   NO callable function. The only functions created are one assertion
--      and two trigger wrappers, and none of them is executable by
--      PUBLIC, anon, authenticated or service_role
--   NO writer. Package 5 brings the write surface together with the
--      runtime that needs it
--
-- ── THREE-VALUED LOGIC, STATED ONCE ───────────────────────────
--
-- A PostgreSQL CHECK passes when its expression is TRUE **or NULL**. So
-- `quantity_packs BETWEEN 1 AND 10` does not require quantity_packs, and
-- a snapshot predicate reading a missing JSON key evaluates to UNKNOWN
-- and passes. Every compound predicate below is therefore terminated
-- with `) IS TRUE`, and every JSON key is proved present with ? / ?&
-- before its value is read. Without that, '{}' would satisfy the pricing
-- snapshot constraint.
--
-- ── AND EVALUATION ORDER IS NOT A GUARANTEE ───────────────────
--
-- PostgreSQL explicitly does not promise the order in which it
-- evaluates the operands of AND, nor the order in which it evaluates
-- one CHECK against another. So a type test placed to the LEFT of an
-- operation that raises is documentation, not a guard. Everything in
-- this file that CAN raise on a malformed-but-valid input therefore
-- carries its own guarantee where it is used:
--
--   jsonb_array_length / JSON casts  inside a CASE that proves the
--                                    jsonb_typeof first (section 6)
--   12 / instalment_count            nullif(instalment_count, 0),
--                                    because the IN (1, 2, 4) rule is a
--                                    DIFFERENT constraint (section 4)
--
-- Both still REJECT the bad row. The change is only that they reject it
-- as a constraint violation rather than as a raised error.
-- ══════════════════════════════════════════════════════════════

begin;

-- ══════════════════════════════════════════════════════════════
-- 1. THE SELF-SERVICE AGREEMENT COLUMNS
-- ══════════════════════════════════════════════════════════════
--
-- Seventeen columns. plan_type is the discriminator that turns every
-- rule below on.
--
-- DELIBERATELY NOT ADDED:
--
--   activated_at        started_at already exists (006) and means this.
--   term_end_at         commitment_end_at already exists (006) and
--                       means this.
--   stripe_customer_id  the canonical Stripe customer mapping is
--                       public.stripe_customers (022, hardened by 023),
--                       with checkout_attempts.stripe_customer_id as the
--                       per-attempt evidence and
--                       checkout_customer_identities (055) beside it. A
--                       fourth copy on this table would be the one that
--                       disagrees. The agreement stores CORRELATION -
--                       the attempt and the subscription - and resolves
--                       identity through the existing mapping.
--
-- Also reused rather than re-invented, all from 006: started_at,
-- commitment_months, commitment_end_at, next_delivery_at, ended_at.

alter table public.b2b_supply_agreements
  -- 'monthly' or 'annual'. NULL means a legacy / negotiated agreement.
  add column plan_type                      text,
  -- The pricing authority this row was priced by. Closed world: the only
  -- value 059 admits is 'b2b-2026.1'. A future price list arrives with a
  -- future migration that deliberately widens this and its formulas.
  add column pricing_rules_version          text,
  -- The physical product, frozen as data rather than assumed.
  add column pack_grams                     integer,
  add column pack_net_cents                 integer,
  add column quantity_packs                 integer,
  -- 0 for monthly, 15 for annual. Whole percent; the B2B price list has
  -- no fractional discount and numeric(5,2) would invite one.
  add column discount_percent               integer,
  -- 12 for annual. NULL for monthly: no term, therefore no count.
  add column delivery_count                 integer,
  -- quantity_packs x pack_net_cents. For MONTHLY this is the recurring
  -- monthly product net basis. For ANNUAL it is the UNDISCOUNTED monthly
  -- comparison base that the 15 % is measured against.
  add column base_monthly_product_net_cents integer,
  -- ANNUAL ONLY. The authoritative frozen discounted twelve-month
  -- product contract total. NULL for monthly, which has no lifetime
  -- total at all - see section 3.
  add column contract_product_net_cents     integer,
  -- ANNUAL ONLY. 1, 2 or 4.
  add column instalment_count               integer,
  -- The pricing builder's output plus the net-origin tax metadata,
  -- flat-merged. Section 6 pins the shape to what TypeScript emits.
  add column pricing_snapshot               jsonb,
  -- Provenance. No ON DELETE action: an attempt that produced an
  -- agreement is evidence, and deleting it must be refused rather than
  -- quietly blanking the link.
  add column checkout_attempt_id            uuid references public.checkout_attempts(id),
  -- MONTHLY ONLY. The Stripe subscription that bills it. An annual
  -- contract is instalments against a frozen total, not a subscription.
  add column stripe_subscription_id         text,
  -- The B2C vocabulary from 034, deliberately reused: requested is when
  -- the customer asked, effective is what they were promised.
  add column cancellation_requested_at      timestamptz,
  add column cancellation_effective_at      timestamptz,
  add column cancellation_reason            text,
  -- Exceptional termination. A different event from an ordinary
  -- cancellation, and anchored to ended_at rather than to a request.
  add column termination_reason             text;

comment on column public.b2b_supply_agreements.plan_type is
  'B2B self-service plan: monthly or annual. NULL = legacy/negotiated agreement (migration 006), to which the 059 self-service rules deliberately do not apply.';
comment on column public.b2b_supply_agreements.pricing_rules_version is
  'Pricing authority that produced this row. Closed world: b2b-2026.1 only (lib/b2bPricingRules.ts B2B_PRICING_RULES_VERSION). A new price list needs a new migration.';
comment on column public.b2b_supply_agreements.pack_grams is
  'Frozen pack size in grams. 500 for every self-service agreement.';
comment on column public.b2b_supply_agreements.pack_net_cents is
  'Frozen net price of one pack in integer cents. 5250 for every self-service agreement.';
comment on column public.b2b_supply_agreements.quantity_packs is
  'Packs per monthly delivery, 1 to 10. Frozen for an active annual contract; changeable for monthly (Package 5), where the canonical supply item must move with it in the same transaction.';
comment on column public.b2b_supply_agreements.discount_percent is
  'Whole-percent product discount: 0 monthly, 15 annual.';
comment on column public.b2b_supply_agreements.delivery_count is
  'Deliveries in the contract term. 12 for annual, NULL for monthly (no term).';
comment on column public.b2b_supply_agreements.base_monthly_product_net_cents is
  'quantity_packs * pack_net_cents. Monthly: the recurring monthly product net basis. Annual: the undiscounted monthly comparison base.';
comment on column public.b2b_supply_agreements.contract_product_net_cents is
  'ANNUAL ONLY: the frozen discounted twelve-month product contract total, = divideRoundHalfUp(base_monthly_product_net_cents * 12 * 85, 100). NULL for monthly, which has no lifetime total.';
comment on column public.b2b_supply_agreements.instalment_count is
  'ANNUAL ONLY: 1, 2 or 4 instalments. Determines billing_interval_count (12, 6 or 3 months).';
comment on column public.b2b_supply_agreements.pricing_snapshot is
  'Flat merge of the pricing builder output (lib/b2bPricingRules.ts buildB2bMonthlyPricing / buildB2bAnnualPricing) and netOriginTaxMetadata() from lib/tax.ts. Shape and agreement with the first-class columns are enforced by b2b_supply_agreements_self_service_pricing_snapshot_check.';
comment on column public.b2b_supply_agreements.checkout_attempt_id is
  'The checkout attempt this self-service agreement was created for. Also the route to the canonical Stripe customer: this table deliberately stores no stripe_customer_id.';
comment on column public.b2b_supply_agreements.stripe_subscription_id is
  'MONTHLY ONLY: the Stripe subscription billing this agreement. Required once a monthly agreement is active; always NULL for annual.';
comment on column public.b2b_supply_agreements.cancellation_requested_at is
  'When the customer asked to end a MONTHLY agreement. Annual contracts have no ordinary cancellation.';
comment on column public.b2b_supply_agreements.cancellation_effective_at is
  'What the customer was promised as the end date. Never earlier than cancellation_requested_at. The 14-day cutoff that computes it depends on the Stripe period boundary and is Package 5 logic, deliberately not encoded in SQL.';
comment on column public.b2b_supply_agreements.cancellation_reason is
  'Optional free text accompanying a cancellation request. Requires cancellation_requested_at.';
comment on column public.b2b_supply_agreements.termination_reason is
  'Exceptional termination, not an ordinary cancellation. Requires ended_at.';


-- ══════════════════════════════════════════════════════════════
-- 2. THE CLOSED WORLD, AND THE TWO-WAY SPLIT
-- ══════════════════════════════════════════════════════════════
--
-- Row-local domain rules first, then the self-service identity rules.
--
-- The version literal is NOT plan-guarded. The column exists for exactly
-- one authority, and a row carrying 'b2b-2027.1' before a migration has
-- taught this file what that means is a row nothing can price.

alter table public.b2b_supply_agreements
  add constraint b2b_supply_agreements_plan_type_check
    check (plan_type is null or plan_type in ('monthly', 'annual')),

  add constraint b2b_supply_agreements_pricing_rules_version_check
    check (pricing_rules_version is null or pricing_rules_version = 'b2b-2026.1'),

  add constraint b2b_supply_agreements_pack_grams_check
    check (pack_grams is null or pack_grams > 0),

  add constraint b2b_supply_agreements_pack_net_cents_check
    check (pack_net_cents is null or pack_net_cents > 0),

  add constraint b2b_supply_agreements_quantity_packs_check
    check (quantity_packs is null or quantity_packs between 1 and 10),

  add constraint b2b_supply_agreements_discount_percent_check
    check (discount_percent is null or discount_percent between 0 and 100),

  add constraint b2b_supply_agreements_delivery_count_check
    check (delivery_count is null or delivery_count > 0),

  add constraint b2b_supply_agreements_instalment_count_check
    check (instalment_count is null or instalment_count in (1, 2, 4)),

  add constraint b2b_supply_agreements_base_monthly_net_check
    check (base_monthly_product_net_cents is null or base_monthly_product_net_cents > 0),

  add constraint b2b_supply_agreements_contract_net_check
    check (contract_product_net_cents is null or contract_product_net_cents > 0),

  -- Trimmed and bounded. A Stripe id is an opaque token, so the only
  -- honest rules are that it is not whitespace and not unbounded text.
  add constraint b2b_supply_agreements_stripe_subscription_id_format_check
    check (stripe_subscription_id is null
           or (char_length(btrim(stripe_subscription_id)) between 3 and 255
               and stripe_subscription_id = btrim(stripe_subscription_id)) is true),

  -- ── THE SPLIT, DIRECTION ONE: a legacy row carries no self-service
  --    data. Half a configuration is worse than none - it reads as a
  --    priced agreement to anything that checks one column and not the
  --    next.
  --
  --    The cancellation columns are deliberately NOT in this list. A
  --    legacy negotiated agreement can genuinely be cancelled, and the
  --    cancellation vocabulary in section 7 applies to every row.
  add constraint b2b_supply_agreements_legacy_row_has_no_self_service_data_check
    check (plan_type is not null
           or (pricing_rules_version is null
               and pack_grams is null
               and pack_net_cents is null
               and quantity_packs is null
               and discount_percent is null
               and delivery_count is null
               and base_monthly_product_net_cents is null
               and contract_product_net_cents is null
               and instalment_count is null
               and pricing_snapshot is null
               and checkout_attempt_id is null
               and stripe_subscription_id is null) is true),

  -- ── THE SPLIT, DIRECTION TWO: what a self-service row must be.
  --
  --    offer_model_id IS NULL is the load-bearing half. The 003 offer
  --    models are an unapproved first draft that migration 053 took away
  --    from every browser role; a self-service agreement pointing at one
  --    would re-import its discount as a second pricing authority.
  add constraint b2b_supply_agreements_self_service_identity_check
    check (plan_type is null
           or (customer_type = 'business'
               and currency = 'EUR'
               and offer_model_id is null
               and pricing_rules_version = 'b2b-2026.1'
               and checkout_attempt_id is not null) is true),

  -- ── THE PRODUCT, AND THE ONE ARITHMETIC IDENTITY THAT HOLDS FOR BOTH
  --    PLANS. bigint throughout: at today's ceiling of 10 packs the
  --    product is 52 500, comfortably inside integer, but the cast means
  --    a future ceiling cannot turn a CHECK into an overflow error.
  add constraint b2b_supply_agreements_self_service_pack_check
    check (plan_type is null
           or (pack_grams = 500
               and pack_net_cents = 5250
               and quantity_packs between 1 and 10) is true),

  add constraint b2b_supply_agreements_self_service_base_monthly_formula_check
    check (plan_type is null
           or (base_monthly_product_net_cents::bigint
                 = quantity_packs::bigint * 5250) is true),

  -- ── NO PAUSE FOR SELF-SERVICE. A paused agreement is a negotiated
  --    concept with no self-service meaning: payment trouble pauses
  --    DELIVERIES (060) and leaves the contract standing, and anything
  --    else is a cancellation. The legacy anonymous status CHECK from
  --    006 still admits 'paused' for legacy rows and is NOT touched.
  add constraint b2b_supply_agreements_self_service_status_check
    check (plan_type is null or status <> 'paused');


-- ══════════════════════════════════════════════════════════════
-- 3. THE MONTHLY PLAN SHAPE
-- ══════════════════════════════════════════════════════════════
--
-- Monthly is the same B2B price on a rhythm - 0 % - monatlich kündbar.
-- Migration 053 already corrected the recurring model's discount from
-- 5 % to 0 and rewrote its description; this is that decision as a
-- constraint.
--
-- THE MONTHLY PLAN HAS NO LIFETIME PRODUCT CONTRACT TOTAL. It is a
-- Stripe subscription: what is owed is one month at a time. A
-- contract_product_net_cents on a monthly row would be a total nobody
-- agreed to and nothing could keep reconciled the moment the quantity
-- changed. Hence four NULLs, not four zeroes.

alter table public.b2b_supply_agreements
  add constraint b2b_supply_agreements_monthly_shape_check
    check (plan_type is distinct from 'monthly'
           or (discount_percent = 0
               and delivery_count is null
               and contract_product_net_cents is null
               and instalment_count is null
               and commitment_months is null
               and commitment_end_at is null
               and billing_interval_unit = 'month'
               and billing_interval_count = 1
               and delivery_interval_unit = 'month'
               and delivery_interval_count = 1) is true),

  add constraint b2b_supply_agreements_monthly_active_check
    check (plan_type is distinct from 'monthly'
           or status <> 'active'
           or (started_at is not null
               and stripe_subscription_id is not null) is true);


-- ══════════════════════════════════════════════════════════════
-- 4. THE ANNUAL PLAN SHAPE, AND THE ONE NUMBER THAT MATTERS
-- ══════════════════════════════════════════════════════════════
--
-- ── THE FORMULA, AND WHY IT IS THIS ONE ───────────────────────
--
-- Fifteen percent off the FULL TWELVE-MONTH BASE, rounded exactly once,
-- at the end. Discounting the monthly pack first does NOT produce 15 %:
-- 5250 x 85 / 100 = 4462,5 rounds up to 4463, and that half-cent is then
-- multiplied by the pack count and by twelve - at ten packs the contract
-- lands 60 cents above the agreed price, and the "15 %" on the page
-- stops being the 15 % in the contract.
--
-- lib/b2bPricingRules.ts annualProductNetCents() is the authority. Its
-- rounding primitive divideRoundHalfUp(n, d) is written as
-- floor((2n + d) / (2d)) so the half-up decision happens in integer
-- arithmetic rather than on a float that may already have drifted, and
-- the SQL below is that same expression with d = 100:
--
--   (2 * (base * 12 * 85) + 100) / 200
--
-- PostgreSQL integer division truncates toward zero and every operand
-- here is non-negative, so it is floor - identical to the TypeScript.
-- bigint keeps the intermediate exact: at ten packs
-- 2 * (52500 * 12 * 85) = 107 100 000, which fits in integer today but
-- is not something a future pack ceiling should be allowed to discover.
--
-- ── BILLING INTERVAL FROM INSTALMENT COUNT ────────────────────
--
--   1 instalment  -> every 12 months
--   2 instalments -> every 6 months
--   4 instalments -> every 3 months
--
-- 12 / instalment_count is exact for all three admitted values, and the
-- instalment_count CHECK in section 2 is what guarantees it stays exact.
--
-- ── AND NO STRIPE SUBSCRIPTION ────────────────────────────────
--
-- Annual instalments are charges against a frozen total on a schedule
-- this database owns (060), not a recurring price Stripe owns. An annual
-- row carrying a subscription id would mean two systems each believed
-- they were billing the contract.

alter table public.b2b_supply_agreements
  add constraint b2b_supply_agreements_annual_shape_check
    check (plan_type is distinct from 'annual'
           or (discount_percent = 15
               and delivery_count = 12
               and commitment_months = 12
               and instalment_count in (1, 2, 4)
               and contract_product_net_cents is not null
               and stripe_subscription_id is null
               and billing_interval_unit = 'month'
               and delivery_interval_unit = 'month'
               and delivery_interval_count = 1) is true),

  -- nullif(instalment_count, 0) rather than a bare instalment_count.
  -- instalment_count IN (1, 2, 4) is a SEPARATE constraint, and
  -- PostgreSQL does not promise to evaluate one CHECK before another -
  -- so a row presenting 0 could reach this division before the domain
  -- rule refused it, and division by zero is an ERROR rather than a
  -- constraint violation. nullif turns that single case into NULL,
  -- 12 / NULL is NULL, and the ) IS TRUE terminator collapses it to
  -- FALSE. A zero instalment count is REJECTED either way; this only
  -- decides whether it is rejected as a violation or as a crash.
  -- 1 -> 12, 2 -> 6, 4 -> 3 are all unchanged.
  add constraint b2b_supply_agreements_annual_billing_interval_check
    check (plan_type is distinct from 'annual'
           or (billing_interval_count = 12 / nullif(instalment_count, 0)) is true),

  add constraint b2b_supply_agreements_annual_contract_amount_check
    check (plan_type is distinct from 'annual'
           or (contract_product_net_cents::bigint
                 = (2 * (base_monthly_product_net_cents::bigint * 12 * 85) + 100) / 200) is true),

  add constraint b2b_supply_agreements_annual_active_check
    check (plan_type is distinct from 'annual'
           or status <> 'active'
           or (started_at is not null
               and commitment_end_at is not null) is true);


-- ══════════════════════════════════════════════════════════════
-- 5. THE EIGHT LEGACY MONEY COLUMNS ARE SUPERSEDED
-- ══════════════════════════════════════════════════════════════
--
-- 006 gave this table a whole order's worth of accounting - subtotal,
-- discount, shipping, tax and total, net and gross - each NOT NULL
-- DEFAULT 0. For a self-service agreement every one of those defaults
-- would be A LIE THAT LOOKS LIKE ACCOUNTING: a row reading
-- tax_total_cents = 0 does not say "no tax has been established yet", it
-- says "the tax on this agreement is zero".
--
-- Where the money actually lives now:
--
--   product, recurring        base_monthly_product_net_cents
--   product, annual contract  contract_product_net_cents
--   instalment tax            b2b_payment_schedule (060)
--   customer shipping         b2b_deliveries (060)
--
-- So the eight are RELAXED and DEPRECATED rather than dropped: the
-- NOT NULL and the DEFAULT come off, the columns and their own >= 0
-- CHECKs stay exactly as they are, every existing legacy value is
-- preserved untouched, and a self-service row must carry NULL in all
-- eight.
--
-- NOT DESTRUCTIVE BY CONSTRUCTION: dropping a NOT NULL and a DEFAULT
-- only widens the domain. No UPDATE runs anywhere in this file.

alter table public.b2b_supply_agreements
  alter column subtotal_net_cents   drop not null,
  alter column subtotal_net_cents   drop default,
  alter column subtotal_gross_cents drop not null,
  alter column subtotal_gross_cents drop default,
  alter column discount_total_cents drop not null,
  alter column discount_total_cents drop default,
  alter column shipping_net_cents   drop not null,
  alter column shipping_net_cents   drop default,
  alter column shipping_gross_cents drop not null,
  alter column shipping_gross_cents drop default,
  alter column tax_total_cents      drop not null,
  alter column tax_total_cents      drop default,
  alter column total_net_cents      drop not null,
  alter column total_net_cents      drop default,
  alter column total_gross_cents    drop not null,
  alter column total_gross_cents    drop default;

alter table public.b2b_supply_agreements
  add constraint b2b_supply_agreements_self_service_legacy_money_null_check
    check (plan_type is null
           or (subtotal_net_cents is null
               and subtotal_gross_cents is null
               and discount_total_cents is null
               and shipping_net_cents is null
               and shipping_gross_cents is null
               and tax_total_cents is null
               and total_net_cents is null
               and total_gross_cents is null) is true);

comment on column public.b2b_supply_agreements.subtotal_net_cents is
  'LEGACY (006), superseded for self-service B2B commerce. NULL on every plan_type IS NOT NULL row - see b2b_supply_agreements_self_service_legacy_money_null_check.';
comment on column public.b2b_supply_agreements.subtotal_gross_cents is
  'LEGACY (006), superseded for self-service B2B commerce. NULL on every plan_type IS NOT NULL row.';
comment on column public.b2b_supply_agreements.discount_total_cents is
  'LEGACY (006), superseded for self-service B2B commerce. The self-service discount is discount_percent plus the frozen contract total.';
comment on column public.b2b_supply_agreements.shipping_net_cents is
  'LEGACY (006), superseded for self-service B2B commerce. Customer shipping is billed per delivery (migration 060), never on the agreement.';
comment on column public.b2b_supply_agreements.shipping_gross_cents is
  'LEGACY (006), superseded for self-service B2B commerce. Customer shipping is billed per delivery (migration 060).';
comment on column public.b2b_supply_agreements.tax_total_cents is
  'LEGACY (006), superseded for self-service B2B commerce. VAT is established per instalment when it is invoiced (migration 060), not frozen on the agreement.';
comment on column public.b2b_supply_agreements.total_net_cents is
  'LEGACY (006), superseded for self-service B2B commerce. Use base_monthly_product_net_cents (monthly) or contract_product_net_cents (annual).';
comment on column public.b2b_supply_agreements.total_gross_cents is
  'LEGACY (006), superseded for self-service B2B commerce. No gross total is frozen on a self-service agreement; gross exists per invoiced instalment (migration 060).';


-- ══════════════════════════════════════════════════════════════
-- 6. THE PRICING SNAPSHOT, PINNED TO WHAT TYPESCRIPT ACTUALLY EMITS
-- ══════════════════════════════════════════════════════════════
--
-- The stored object is a FLAT MERGE of two current producers, and
-- nothing else:
--
--   buildB2bMonthlyPricing(...).pricing   or
--   buildB2bAnnualPricing(...).pricing    from lib/b2bPricingRules.ts
--   netOriginTaxMetadata()                from lib/tax.ts
--
-- MONTHLY keys, exactly what B2bMonthlyPricing has:
--   rulesVersion currency packs kilograms packNetCents
--   monthlyProductNetCents
--   + calculationVersion priceOrigin
--
-- ANNUAL keys, exactly what B2bAnnualPricing has:
--   rulesVersion currency packs kilograms packNetCents deliveryCount
--   discountPercent baseAnnualNetCents annualProductNetCents
--   savingNetCents instalmentCount instalmentNetCents monthlyEquivalent
--   + calculationVersion priceOrigin
--
-- monthlyEquivalent is { averageNetCents, isExact, deliveryCount } and is
-- DISPLAY ONLY - averageNetCents x 12 does not return the contract
-- amount at 1 or 3 packs, which is exactly why the builder returns a
-- structure with an isExact flag rather than a bare integer.
--
-- NO key is required that no producer emits, and NO gross total is
-- invented: the B2B snapshot is net-origin, and the gross of an
-- instalment is established when that instalment is invoiced.
--
-- ── WHY EVERY PREDICATE IS SPELLED OUT THIS WAY ───────────────
--
-- `snapshot->>'packs' = quantity_packs` alone is worthless here: on '{}'
-- the left side is NULL, the comparison is UNKNOWN, and a CHECK PASSES
-- on UNKNOWN. So each key is proved present with ?& (jsonb_exists_all,
-- which returns a real boolean for an absent key), then type-asserted
-- with jsonb_typeof, then compared - and the whole conjunction is
-- terminated with ) IS TRUE so any residual UNKNOWN collapses to FALSE.
--
-- '{}'::jsonb and '{"packs":2}'::jsonb are both rejected by this
-- constraint, and that is a property of the SQL rather than of a comment.
--
-- ── AND WHY NO PREDICATE RELIES ON AND ORDER ──────────────────
--
-- PostgreSQL DOES NOT PROMISE to evaluate the operands of AND left to
-- right. "jsonb_typeof(x) = 'array' and jsonb_array_length(x) = n" is
-- therefore NOT a guard: the planner is free to reach the second
-- operand first, and jsonb_array_length() on a non-array RAISES rather
-- than returning false. The same is true of every cast out of a JSON
-- value - (x->>'k')::numeric on a JSON string raises.
--
-- So every operation below that CAN raise carries its own type
-- guarantee in a CASE, and is unreachable unless that CASE proved the
-- type first:
--
--   case when jsonb_typeof(v) = 'array' then jsonb_array_length(v) = n
--        else false end
--
-- The CASE is exception-safe WHATEVER the evaluation order, because a
-- CASE evaluates its WHEN before its THEN by definition rather than by
-- convention. ELSE FALSE, never ELSE NULL: a wrong type is a rejection,
-- not an unknown.
--
-- The standalone jsonb_typeof assertions are KEPT ALONGSIDE the CASEs
-- and are deliberately redundant. They are the DECLARED SHAPE - what a
-- snapshot must be - and the CASE is the MECHANISM that reads it
-- safely. Each CASE has to restate the type because it may be the
-- operand evaluated first, so the duplication is the property, not an
-- oversight.
--
-- ── ::numeric RATHER THAN ::bigint, FOR JSON VALUES ONLY ──────
--
-- jsonb_typeof(v) = 'number' is NOT enough to make (v->>'k')::bigint
-- safe: JSON numbers may be fractional, and '4462.5'::bigint raises.
-- The text of a JSON number is ALWAYS a valid numeric literal, so
-- ::numeric is total once the CASE has established 'number' and
-- ::bigint is not. Numeric comparison is exact - these are integer
-- cent amounts - so every figure this constraint admits or refuses is
-- unchanged; a fractional value is now FALSE instead of an error, and
-- was rejected either way. Casts of the INTEGER COLUMNS keep their
-- meaning: a column cast cannot raise.

alter table public.b2b_supply_agreements
  add constraint b2b_supply_agreements_self_service_pricing_snapshot_check
    check (
      plan_type is null
      or (
             pricing_snapshot is not null
         and jsonb_typeof(pricing_snapshot) = 'object'
         and pricing_snapshot ?& array['rulesVersion', 'currency', 'packs', 'kilograms',
                                       'packNetCents', 'calculationVersion', 'priceOrigin']
         -- the authorities the row claims to have been priced by
         and pricing_snapshot->>'rulesVersion'       = pricing_rules_version
         and pricing_snapshot->>'currency'           = currency
         and pricing_snapshot->>'calculationVersion' = 'de-net-2026.1'
         and pricing_snapshot->>'priceOrigin'        = 'net'
         -- and the product, agreeing with the first-class columns
         and jsonb_typeof(pricing_snapshot->'packs')        = 'number'
         and jsonb_typeof(pricing_snapshot->'kilograms')    = 'number'
         and jsonb_typeof(pricing_snapshot->'packNetCents') = 'number'
         and case when jsonb_typeof(pricing_snapshot->'packs') = 'number'
                  then (pricing_snapshot->>'packs')::numeric = quantity_packs::numeric
                  else false end
         and case when jsonb_typeof(pricing_snapshot->'packNetCents') = 'number'
                  then (pricing_snapshot->>'packNetCents')::numeric = pack_net_cents::numeric
                  else false end
         and case when jsonb_typeof(pricing_snapshot->'kilograms') = 'number'
                  then (pricing_snapshot->>'kilograms')::numeric
                         = (quantity_packs::numeric * pack_grams::numeric) / 1000
                  else false end
         and (
           -- MONTHLY: the recurring basis, and no annual figure anywhere
           -- near it. A monthly snapshot carrying a contract total would
           -- be a monthly agreement quoting a twelve-month price.
           (    plan_type = 'monthly'
            and pricing_snapshot ? 'monthlyProductNetCents'
            and jsonb_typeof(pricing_snapshot->'monthlyProductNetCents') = 'number'
            and case when jsonb_typeof(pricing_snapshot->'monthlyProductNetCents') = 'number'
                     then (pricing_snapshot->>'monthlyProductNetCents')::numeric
                            = base_monthly_product_net_cents::numeric
                     else false end
            and not pricing_snapshot ?| array['annualProductNetCents', 'baseAnnualNetCents',
                                              'instalmentCount', 'instalmentNetCents',
                                              'savingNetCents', 'monthlyEquivalent'])
           or
           -- ANNUAL: the whole contract, including the schedule length.
           (    plan_type = 'annual'
            and pricing_snapshot ?& array['deliveryCount', 'discountPercent',
                                          'baseAnnualNetCents', 'annualProductNetCents',
                                          'savingNetCents', 'instalmentCount',
                                          'instalmentNetCents', 'monthlyEquivalent']
            and jsonb_typeof(pricing_snapshot->'deliveryCount')         = 'number'
            and jsonb_typeof(pricing_snapshot->'discountPercent')       = 'number'
            and jsonb_typeof(pricing_snapshot->'baseAnnualNetCents')    = 'number'
            and jsonb_typeof(pricing_snapshot->'annualProductNetCents') = 'number'
            and jsonb_typeof(pricing_snapshot->'savingNetCents')        = 'number'
            and jsonb_typeof(pricing_snapshot->'instalmentCount')       = 'number'
            and jsonb_typeof(pricing_snapshot->'instalmentNetCents')    = 'array'
            and jsonb_typeof(pricing_snapshot->'monthlyEquivalent')     = 'object'
            and pricing_snapshot->'monthlyEquivalent'
                  ?& array['averageNetCents', 'isExact', 'deliveryCount']
            and jsonb_typeof(pricing_snapshot->'monthlyEquivalent'->'averageNetCents') = 'number'
            and jsonb_typeof(pricing_snapshot->'monthlyEquivalent'->'isExact')         = 'boolean'
            and jsonb_typeof(pricing_snapshot->'monthlyEquivalent'->'deliveryCount')   = 'number'
            and case when jsonb_typeof(pricing_snapshot->'deliveryCount') = 'number'
                     then (pricing_snapshot->>'deliveryCount')::numeric = delivery_count::numeric
                     else false end
            and case when jsonb_typeof(pricing_snapshot->'discountPercent') = 'number'
                     then (pricing_snapshot->>'discountPercent')::numeric = discount_percent::numeric
                     else false end
            and case when jsonb_typeof(pricing_snapshot->'annualProductNetCents') = 'number'
                     then (pricing_snapshot->>'annualProductNetCents')::numeric
                            = contract_product_net_cents::numeric
                     else false end
            and case when jsonb_typeof(pricing_snapshot->'instalmentCount') = 'number'
                     then (pricing_snapshot->>'instalmentCount')::numeric = instalment_count::numeric
                     else false end
            and case when jsonb_typeof(pricing_snapshot->'baseAnnualNetCents') = 'number'
                     then (pricing_snapshot->>'baseAnnualNetCents')::numeric
                            = base_monthly_product_net_cents::numeric * 12
                     else false end
            -- saving is DERIVED, never stated: base minus contract. All
            -- THREE JSON numbers are proved in the one WHEN, because
            -- any of the three casts could be the operand evaluated
            -- first.
            and case when jsonb_typeof(pricing_snapshot->'savingNetCents')        = 'number'
                      and jsonb_typeof(pricing_snapshot->'baseAnnualNetCents')    = 'number'
                      and jsonb_typeof(pricing_snapshot->'annualProductNetCents') = 'number'
                     then (pricing_snapshot->>'savingNetCents')::numeric
                            = (pricing_snapshot->>'baseAnnualNetCents')::numeric
                              - (pricing_snapshot->>'annualProductNetCents')::numeric
                     else false end
            -- one net amount per instalment, and the display average
            -- knows the same term length as the agreement
            and case when jsonb_typeof(pricing_snapshot->'instalmentNetCents') = 'array'
                     then jsonb_array_length(pricing_snapshot->'instalmentNetCents')
                            = instalment_count
                     else false end
            and case when jsonb_typeof(pricing_snapshot->'monthlyEquivalent'->'deliveryCount') = 'number'
                     then (pricing_snapshot->'monthlyEquivalent'->>'deliveryCount')::numeric
                            = delivery_count::numeric
                     else false end)
         )
      ) is true
    );


-- ══════════════════════════════════════════════════════════════
-- 7. CANCELLATION AND TERMINATION
-- ══════════════════════════════════════════════════════════════
--
-- Nine constraints, stated separately rather than merged into one, so a
-- failure names the rule that was broken.
--
-- ── THE TWO EVENTS ARE NOT THE SAME EVENT ─────────────────────
--
--   cancellation_*      the customer ended a MONTHLY agreement.
--                       Anchored to a request and a promise.
--   termination_reason  the agreement ended exceptionally. Anchored to
--                       ended_at, which is the fact rather than the
--                       promise.
--
-- ── ANNUAL HAS NO ORDINARY CANCELLATION ───────────────────────
--
-- A twelve-month commitment at 15 % off is the thing the customer
-- bought. "Cancel in month three and keep the annual price" is not an
-- offer GLOA makes, so the schema does not let the columns describe it.
-- An annual contract that must end ends through termination_reason and
-- ended_at, which is a different and visible act.
--
-- ── WHAT IS DELIBERATELY NOT HERE ─────────────────────────────
--
-- The 14-day cutoff. It compares the request against the Stripe billing
-- period boundary, which this table does not hold and must not guess.
-- 034 computes the B2C equivalent in application code for exactly that
-- reason, and Package 5 owns the B2B one.
--
-- No withdrawal_* fields: statutory withdrawal is a consumer right and
-- does not apply to a business-to-business supply agreement.

alter table public.b2b_supply_agreements
  -- 1. a request always carries the promise it produced
  add constraint b2b_supply_agreements_cancellation_requested_requires_effective_check
    check (cancellation_requested_at is null or cancellation_effective_at is not null),

  -- 2. and a promise always carries the request that asked for it
  add constraint b2b_supply_agreements_cancellation_effective_requires_requested_check
    check (cancellation_effective_at is null or cancellation_requested_at is not null),

  -- 3. nothing ends before it was asked to end
  add constraint b2b_supply_agreements_cancellation_effective_order_check
    check (cancellation_effective_at is null
           or cancellation_effective_at >= cancellation_requested_at),

  -- 4. a reason without a request is a note about nothing
  add constraint b2b_supply_agreements_cancellation_reason_requires_request_check
    check (cancellation_reason is null or cancellation_requested_at is not null),

  -- 5. and it is real text rather than whitespace
  add constraint b2b_supply_agreements_cancellation_reason_length_check
    check (cancellation_reason is null
           or char_length(btrim(cancellation_reason)) between 1 and 500),

  -- 6. THE ANNUAL RULE
  add constraint b2b_supply_agreements_annual_no_ordinary_cancellation_check
    check (plan_type is distinct from 'annual'
           or (cancellation_requested_at is null
               and cancellation_effective_at is null
               and cancellation_reason is null) is true),

  -- 7. termination is anchored to the fact, not to a promise
  add constraint b2b_supply_agreements_termination_reason_requires_ended_check
    check (termination_reason is null or ended_at is not null),

  -- 8. and is also real text
  add constraint b2b_supply_agreements_termination_reason_length_check
    check (termination_reason is null
           or char_length(btrim(termination_reason)) between 1 and 500),

  -- 9. an agreement does not end before it starts. Not plan-guarded:
  --    it is true of a negotiated agreement as well, and a legacy row
  --    that breaks it should stop this migration rather than be
  --    grandfathered.
  add constraint b2b_supply_agreements_ended_after_started_check
    check (ended_at is null or started_at is null or ended_at >= started_at);


-- ══════════════════════════════════════════════════════════════
-- 8. THE CANONICAL SUPPLY ITEM
-- ══════════════════════════════════════════════════════════════
--
-- b2b_supply_items (006) was built as an ORDER LINE: a unit price, a
-- gross, a line total, a tax rate and a discount per row. A
-- self-service supply agreement has none of that on the item, because
-- the money is on the agreement (sections 3 to 5) and the tax is per
-- invoiced instalment (060).
--
-- What the item is FOR now is the answer to "what is actually being
-- supplied": one row, 500 g packs, this many of them.
--
--   item_role IS NULL          a legacy line from a negotiated
--                              agreement. Untouched, still governed by
--                              what 006 said about it.
--   item_role = 'canonical_matcha'
--                              the one line of a self-service
--                              agreement. Mirrors the agreement.
--
-- MULTI-SKU REMAINS DEFERRED, and the CHECK says so: item_role admits
-- exactly one value today, and a second product is introduced by a
-- future migration that deliberately widens it.
--
-- ── THE FOUR RELAXATIONS ──────────────────────────────────────
--
-- Exactly the four columns 006 made NOT NULL and a self-service line
-- must not carry. discount_percent and tax_rate_percent are already
-- nullable in 006 and need no relaxation - only a comment.
--
-- No value is changed. No column is dropped. product_size_id keeps its
-- column, its type and its 006 foreign key, including its ON DELETE
-- behaviour: rewriting that FK would be a drop-and-add on a legacy table
-- for no Package 4 benefit.

alter table public.b2b_supply_items
  add column item_role text;

alter table public.b2b_supply_items
  alter column unit_price_net_cents   drop not null,
  alter column unit_price_gross_cents drop not null,
  alter column line_total_net_cents   drop not null,
  alter column line_total_gross_cents drop not null;

alter table public.b2b_supply_items
  add constraint b2b_supply_items_item_role_check
    check (item_role is null or item_role = 'canonical_matcha'),

  -- The canonical line, stated as one predicate terminated with IS TRUE
  -- so a missing quantity cannot slip through as UNKNOWN.
  --
  -- product_size_id IS NULL matters as much as the money NULLs: the 003
  -- product sizes are the unapproved 125.00/kg draft, and a canonical
  -- line pointing at one would tie the launch price list to it.
  add constraint b2b_supply_items_canonical_shape_check
    check (item_role is distinct from 'canonical_matcha'
           or (product_size_id is null
               and grams = 500
               and base_unit_price_net_cents = 5250
               and quantity between 1 and 10
               and unit_price_net_cents is null
               and unit_price_gross_cents is null
               and line_total_net_cents is null
               and line_total_gross_cents is null
               and tax_rate_percent is null
               and discount_percent is null) is true);

-- AT MOST ONE canonical line per agreement, as a database guarantee
-- rather than a select-then-insert. EXACTLY one for an ACTIVE
-- self-service agreement is section 9's job, because "at least one"
-- cannot be expressed as an index.
create unique index b2b_supply_items_canonical_per_agreement_key
  on public.b2b_supply_items (supply_agreement_id)
  where item_role = 'canonical_matcha';

comment on column public.b2b_supply_items.item_role is
  'canonical_matcha = the single supplied line of a self-service B2B agreement, mirroring the agreement configuration. NULL = legacy order-line row from migration 006. Multi-SKU is deliberately deferred: a second value needs a future migration.';
comment on column public.b2b_supply_items.product_size_id is
  'LEGACY / RETIRED reference to the unapproved b2b_product_sizes draft (003, contained by 053). Non-authoritative and always NULL on a canonical_matcha row.';
comment on column public.b2b_supply_items.unit_price_net_cents is
  'LEGACY order-line accounting, non-authoritative for self-service commerce. NULL on a canonical_matcha row; the price is pack_net_cents on the agreement.';
comment on column public.b2b_supply_items.unit_price_gross_cents is
  'LEGACY order-line accounting, non-authoritative for self-service commerce. NULL on a canonical_matcha row; B2B pricing is net-origin.';
comment on column public.b2b_supply_items.line_total_net_cents is
  'LEGACY order-line accounting, non-authoritative for self-service commerce. NULL on a canonical_matcha row; totals live on the agreement.';
comment on column public.b2b_supply_items.line_total_gross_cents is
  'LEGACY order-line accounting, non-authoritative for self-service commerce. NULL on a canonical_matcha row.';
comment on column public.b2b_supply_items.tax_rate_percent is
  'LEGACY order-line accounting, non-authoritative for self-service commerce. NULL on a canonical_matcha row; VAT is established per invoiced instalment (migration 060).';
comment on column public.b2b_supply_items.discount_percent is
  'LEGACY order-line accounting, non-authoritative for self-service commerce. NULL on a canonical_matcha row; the discount is discount_percent on the agreement.';


-- ══════════════════════════════════════════════════════════════
-- 9. AGREEMENT <-> CANONICAL ITEM INTEGRITY
-- ══════════════════════════════════════════════════════════════
--
-- Two facts no row-local CHECK can express, because both span tables:
--
--   1. an ACTIVE self-service agreement has EXACTLY ONE canonical line
--   2. that line MIRRORS THE CURRENT agreement configuration
--
-- Only these two. 059 deliberately asserts nothing about payment
-- instalments or deliveries: those tables do not exist yet, and an
-- assertion that reads a missing table is a migration that cannot be
-- applied.
--
-- ── WHY MIRROR AND NOT SNAPSHOT ───────────────────────────────
--
-- The canonical item is the CURRENT commercial configuration, not a
-- historical fact. When a monthly customer changes quantity, the item
-- changes with the agreement. Historical facts - what a given month
-- actually shipped - belong to the delivery rows in 060, which freeze
-- their own snapshots and are deliberately never compared to the
-- agreement's current values.
--
-- ── WHY DEFERRED, FROM BOTH SIDES ─────────────────────────────
--
-- A legitimate transaction updates the agreement and its item in EITHER
-- ORDER, and an activation inserts both and flips the status. An
-- immediate trigger would make that transaction order-dependent and
-- would fail on every ordering but one. DEFERRABLE INITIALLY DEFERRED
-- moves the question to COMMIT, which is the only moment at which
-- "is this agreement coherent?" actually has an answer.
--
-- Both sides are needed: an agreement UPDATE that changes quantity and
-- an item UPDATE that changes it back must each be caught, and neither
-- trigger sees the other table's statement.
--
-- ── SECURITY DEFINER, AND NO WAY TO CALL IT ───────────────────
--
-- SECURITY DEFINER with search_path pinned to '' - so every reference is
-- schema-qualified and nothing can be shadowed by a search_path the
-- caller controls. Definer also matters for a second reason: an
-- invariant that a caller's RLS policy can reduce to "zero rows,
-- therefore consistent" is not an invariant.
--
-- EXECUTE is then revoked from PUBLIC, anon, authenticated AND
-- service_role, with no grant back to anybody. PostgreSQL does not check
-- EXECUTE when firing a trigger - it checks TRIGGER on the table at
-- creation time - so the functions still fire while being callable by
-- nobody but their owner. This adds no browser-reachable surface and no
-- commerce writer.

create function public.assert_b2b_self_service_item_integrity(p_agreement_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_plan_type        text;
  v_status           text;
  v_quantity_packs   integer;
  v_pack_grams       integer;
  v_pack_net_cents   integer;
  v_canonical_count  integer;
  v_mismatch_count   integer;
begin
  select plan_type, status, quantity_packs, pack_grams, pack_net_cents
    into v_plan_type, v_status, v_quantity_packs, v_pack_grams, v_pack_net_cents
    from public.b2b_supply_agreements
   where id = p_agreement_id;

  -- The agreement is not there. Nothing to assert, and nothing to
  -- invent: the legacy ON DELETE CASCADE on b2b_supply_items means the
  -- lines went with it.
  if not found then
    return;
  end if;

  -- A legacy / negotiated agreement. 059 adds no rule about its lines.
  if v_plan_type is null then
    return;
  end if;

  select count(*)
    into v_canonical_count
    from public.b2b_supply_items
   where supply_agreement_id = p_agreement_id
     and item_role = 'canonical_matcha';

  -- EXACTLY ONE, and only once the agreement is active. A pending
  -- agreement is mid-build; requiring the line before activation would
  -- make the order of two inserts a correctness question.
  if v_status = 'active' and v_canonical_count <> 1 then
    raise exception
      'b2b integrity: active self-service agreement % must have exactly one canonical_matcha item, found %',
      p_agreement_id, v_canonical_count
      using errcode = 'check_violation';
  end if;

  -- AND WHENEVER ONE EXISTS IT MIRRORS THE AGREEMENT, whatever the
  -- status. `is distinct from` so a NULL on either side counts as a
  -- mismatch rather than disappearing into UNKNOWN.
  select count(*)
    into v_mismatch_count
    from public.b2b_supply_items
   where supply_agreement_id = p_agreement_id
     and item_role = 'canonical_matcha'
     and (quantity                  is distinct from v_quantity_packs
          or grams                  is distinct from v_pack_grams
          or base_unit_price_net_cents is distinct from v_pack_net_cents);

  if v_mismatch_count > 0 then
    raise exception
      'b2b integrity: canonical_matcha item does not mirror agreement % (expected quantity %, grams %, base_unit_price_net_cents %)',
      p_agreement_id, v_quantity_packs, v_pack_grams, v_pack_net_cents
      using errcode = 'check_violation';
  end if;
end;
$$;

create function public.b2b_supply_agreements_item_integrity_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.assert_b2b_self_service_item_integrity(new.id);
  return null;
end;
$$;

create function public.b2b_supply_items_integrity_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    perform public.assert_b2b_self_service_item_integrity(old.supply_agreement_id);
    return null;
  end if;

  -- A line moved between agreements leaves one agreement as well as
  -- joining another, and the one it left may now have no canonical line.
  --
  -- NESTED rather than one `tg_op = 'UPDATE' and old.… ` condition on
  -- purpose. plpgsql compiles a condition into a single SQL expression
  -- and PostgreSQL does not promise to short-circuit AND, so the one-line
  -- form would evaluate OLD on INSERT - where it is not assigned - and
  -- fail with "record old is not assigned yet" on the first insert.
  if tg_op = 'UPDATE' then
    if old.supply_agreement_id is distinct from new.supply_agreement_id then
      perform public.assert_b2b_self_service_item_integrity(old.supply_agreement_id);
    end if;
  end if;

  perform public.assert_b2b_self_service_item_integrity(new.supply_agreement_id);
  return null;
end;
$$;

create constraint trigger b2b_supply_agreements_item_integrity
  after insert or update on public.b2b_supply_agreements
  deferrable initially deferred
  for each row
  execute function public.b2b_supply_agreements_item_integrity_trigger();

create constraint trigger b2b_supply_items_integrity
  after insert or update or delete on public.b2b_supply_items
  deferrable initially deferred
  for each row
  execute function public.b2b_supply_items_integrity_trigger();


-- ══════════════════════════════════════════════════════════════
-- 10. IMMUTABILITY
-- ══════════════════════════════════════════════════════════════
--
-- IMMEDIATE, not deferred. An immutability guard that fires at COMMIT
-- tells you that something changed a frozen column but not which
-- statement did it.
--
-- ── ALWAYS IMMUTABLE ONCE ASSIGNED ────────────────────────────
--
--   plan_type pricing_rules_version pack_grams pack_net_cents currency
--   checkout_attempt_id
--
-- "Once assigned" is the operative phrase: each is compared only when
-- the OLD value is non-null, so a legacy row may still be adopted into
-- self-service, and each comparison uses IS DISTINCT FROM, so reverting
-- a frozen value to NULL is as much a violation as changing it.
--
-- A plan change is a NEW AGREEMENT, never an UPDATE. That is what lets
-- the 060 delivery rows carry a plan-shaped meaning without mirroring
-- plan_type onto every one of them.
--
--   stripe_subscription_id  once non-null it may not become a different
--                           subscription, and it may not go back to
--                           NULL. Two agreements silently sharing one
--                           subscription, or an active monthly agreement
--                           with none, are both billing bugs.
--   started_at              once populated it may not move at all.
--                           "Must not move backwards" is a special case
--                           of that, and the stronger rule is the easier
--                           one to prove.
--
-- ── ACTIVE ANNUAL FREEZES THE CONTRACT ────────────────────────
--
-- Nine more columns. A fixed twelve-month contract whose quantity can
-- change while its price is frozen is a contract for an unknown thing -
-- and quantity_packs is the one this rule previously missed.
--
-- commitment_end_at is frozen for ANNUAL as soon as it is populated,
-- whatever the status: it is the contract end the customer was told, and
-- it must not be re-derived later.
--
-- ── AND MONTHLY IS DELIBERATELY DIFFERENT ─────────────────────
--
-- quantity_packs and base_monthly_product_net_cents may change on a
-- monthly agreement. Section 9's deferred assertion is what makes that
-- safe: the canonical item must move in the SAME transaction, in either
-- order. Nothing here implements the cycle-change endpoint that decides
-- WHEN a new quantity takes effect - that is Package 5 - and no delivery
-- history exists in 059 to be affected by it.

create function public.b2b_supply_agreements_immutability_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- A legacy agreement that is not becoming a self-service one. 059 adds
  -- no immutability rule to it.
  if old.plan_type is null and new.plan_type is null then
    return new;
  end if;

  if old.plan_type is not null and new.plan_type is distinct from old.plan_type then
    raise exception 'b2b immutability: plan_type is frozen on a self-service agreement (% -> %)',
      old.plan_type, new.plan_type using errcode = 'check_violation';
  end if;

  if old.pricing_rules_version is not null
     and new.pricing_rules_version is distinct from old.pricing_rules_version then
    raise exception 'b2b immutability: pricing_rules_version is frozen (% -> %)',
      old.pricing_rules_version, new.pricing_rules_version using errcode = 'check_violation';
  end if;

  if old.pack_grams is not null and new.pack_grams is distinct from old.pack_grams then
    raise exception 'b2b immutability: pack_grams is frozen (% -> %)',
      old.pack_grams, new.pack_grams using errcode = 'check_violation';
  end if;

  if old.pack_net_cents is not null and new.pack_net_cents is distinct from old.pack_net_cents then
    raise exception 'b2b immutability: pack_net_cents is frozen (% -> %)',
      old.pack_net_cents, new.pack_net_cents using errcode = 'check_violation';
  end if;

  if old.currency is not null and new.currency is distinct from old.currency then
    raise exception 'b2b immutability: currency is frozen (% -> %)',
      old.currency, new.currency using errcode = 'check_violation';
  end if;

  if old.checkout_attempt_id is not null
     and new.checkout_attempt_id is distinct from old.checkout_attempt_id then
    raise exception 'b2b immutability: checkout_attempt_id is frozen on a self-service agreement'
      using errcode = 'check_violation';
  end if;

  if old.stripe_subscription_id is not null
     and new.stripe_subscription_id is distinct from old.stripe_subscription_id then
    raise exception 'b2b immutability: stripe_subscription_id may not change or be cleared once set'
      using errcode = 'check_violation';
  end if;

  if old.started_at is not null and new.started_at is distinct from old.started_at then
    raise exception 'b2b immutability: started_at may not move once populated'
      using errcode = 'check_violation';
  end if;

  -- ANNUAL: the contract end is frozen as soon as it exists.
  if old.plan_type = 'annual'
     and old.commitment_end_at is not null
     and new.commitment_end_at is distinct from old.commitment_end_at then
    raise exception 'b2b immutability: commitment_end_at is the frozen annual contract end'
      using errcode = 'check_violation';
  end if;

  -- ACTIVE ANNUAL: the whole commercial configuration is frozen.
  if old.plan_type = 'annual' and old.status = 'active' then
    if new.quantity_packs is distinct from old.quantity_packs
       or new.base_monthly_product_net_cents is distinct from old.base_monthly_product_net_cents
       or new.contract_product_net_cents is distinct from old.contract_product_net_cents
       or new.discount_percent is distinct from old.discount_percent
       or new.delivery_count is distinct from old.delivery_count
       or new.instalment_count is distinct from old.instalment_count
       or new.pricing_snapshot is distinct from old.pricing_snapshot
       or new.commitment_months is distinct from old.commitment_months then
      raise exception
        'b2b immutability: the commercial configuration of an active annual agreement is frozen (agreement %)',
        old.id using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

create trigger b2b_supply_agreements_immutability
  before update on public.b2b_supply_agreements
  for each row
  execute function public.b2b_supply_agreements_immutability_guard();


-- ══════════════════════════════════════════════════════════════
-- 11. FUNCTION PRIVILEGES
-- ══════════════════════════════════════════════════════════════
--
-- REVOKE FROM public FIRST. A freshly created function is executable by
-- PUBLIC by default and anon and authenticated inherit that, so revoking
-- only the named roles would leave the default in place and every
-- function above reachable from the browser's own Supabase client with
-- nothing but an anon key.
--
-- Then service_role too, and NOTHING IS GRANTED BACK. This is stricter
-- than the 039 convention on purpose: those were writer functions that
-- service_role had to call, and these are not callable at all. A trigger
-- fires on the table's TRIGGER privilege, not on EXECUTE, so an
-- assertion with no grantee still runs on every statement while being
-- invocable by nobody but the owner.
--
-- No table privilege and no policy changes anywhere in this migration:
-- b2b_supply_agreements and b2b_supply_items keep exactly the RLS and
-- the SELECT grants 006 and 048 gave them.

revoke all on function public.assert_b2b_self_service_item_integrity(uuid) from public;
revoke all on function public.assert_b2b_self_service_item_integrity(uuid) from anon;
revoke all on function public.assert_b2b_self_service_item_integrity(uuid) from authenticated;
revoke all on function public.assert_b2b_self_service_item_integrity(uuid) from service_role;

revoke all on function public.b2b_supply_agreements_item_integrity_trigger() from public;
revoke all on function public.b2b_supply_agreements_item_integrity_trigger() from anon;
revoke all on function public.b2b_supply_agreements_item_integrity_trigger() from authenticated;
revoke all on function public.b2b_supply_agreements_item_integrity_trigger() from service_role;

revoke all on function public.b2b_supply_items_integrity_trigger() from public;
revoke all on function public.b2b_supply_items_integrity_trigger() from anon;
revoke all on function public.b2b_supply_items_integrity_trigger() from authenticated;
revoke all on function public.b2b_supply_items_integrity_trigger() from service_role;

revoke all on function public.b2b_supply_agreements_immutability_guard() from public;
revoke all on function public.b2b_supply_agreements_immutability_guard() from anon;
revoke all on function public.b2b_supply_agreements_immutability_guard() from authenticated;
revoke all on function public.b2b_supply_agreements_immutability_guard() from service_role;


-- ══════════════════════════════════════════════════════════════
-- 12. INDEXES
-- ══════════════════════════════════════════════════════════════
--
-- Two partial uniques and one worker index. NOTHING ELSE, and in
-- particular NO per-user uniqueness: no commercial rule limits a
-- business to one agreement, and a business with two sites will need
-- two. An index is a poor place to discover a rule nobody approved.

-- One agreement per checkout attempt, one attempt per agreement.
create unique index b2b_supply_agreements_checkout_attempt_id_key
  on public.b2b_supply_agreements (checkout_attempt_id)
  where checkout_attempt_id is not null;

-- And one Stripe subscription can never bill two agreements.
create unique index b2b_supply_agreements_stripe_subscription_id_key
  on public.b2b_supply_agreements (stripe_subscription_id)
  where stripe_subscription_id is not null;

-- The shape every self-service worker query starts from.
create index idx_b2b_supply_agreements_plan_status
  on public.b2b_supply_agreements (plan_type, status)
  where plan_type is not null;

commit;

-- ══════════════════════════════════════════════════════════════
-- VERIFYING THIS MIGRATION, read-only. Nothing below is executed by
-- this file; it is the query set a reviewer runs afterwards.
--
--   1. THE COLUMNS ARRIVED, AND THE THREE THAT MUST NOT EXIST DO NOT:
--        select column_name, data_type, is_nullable, column_default
--        from information_schema.columns
--        where table_schema = 'public'
--          and table_name = 'b2b_supply_agreements'
--        order by column_name;
--      -> plan_type, pricing_rules_version, pack_grams, pack_net_cents,
--         quantity_packs, discount_percent, delivery_count,
--         base_monthly_product_net_cents, contract_product_net_cents,
--         instalment_count, pricing_snapshot, checkout_attempt_id,
--         stripe_subscription_id, cancellation_requested_at,
--         cancellation_effective_at, cancellation_reason,
--         termination_reason         ALL PRESENT, all is_nullable = YES
--      -> activated_at, term_end_at, stripe_customer_id   ABSENT
--
--   2. THE EIGHT LEGACY MONEY COLUMNS ARE RELAXED:
--        select column_name, is_nullable, column_default
--        from information_schema.columns
--        where table_schema = 'public'
--          and table_name = 'b2b_supply_agreements'
--          and column_name in ('subtotal_net_cents','subtotal_gross_cents',
--              'discount_total_cents','shipping_net_cents','shipping_gross_cents',
--              'tax_total_cents','total_net_cents','total_gross_cents');
--      -> eight rows, is_nullable = YES and column_default IS NULL on
--         every one. The columns still exist, which is the point.
--
--   3. THE LEGACY STATUS CHECK IS UNTOUCHED, and still anonymous:
--        select conname, pg_get_constraintdef(oid)
--        from pg_constraint
--        where conrelid = 'public.b2b_supply_agreements'::regclass
--          and contype = 'c'
--          and pg_get_constraintdef(oid) like '%pending%'
--        order by conname;
--      -> exactly one row, named b2b_supply_agreements_status_check
--         (006's system-generated name), listing pending, active,
--         paused, cancelled, completed. 059 neither drops nor replaces
--         it; its own no-pause rule is the separately named
--         b2b_supply_agreements_self_service_status_check.
--
--   4. EVERY NEW CONSTRAINT, AS INSTALLED rather than as described:
--        select conname, pg_get_constraintdef(oid)
--        from pg_constraint
--        where conrelid in ('public.b2b_supply_agreements'::regclass,
--                           'public.b2b_supply_items'::regclass)
--          and contype = 'c'
--        order by conrelid, conname;
--      -> read the predicates. Every self-service one ends in IS TRUE or
--         is a single comparison that cannot be UNKNOWN.
--
--   5. THE FOUR FUNCTIONS ARE DEFINER, PINNED AND UNREACHABLE:
--        select p.proname, p.prosecdef, p.proconfig, p.proacl
--        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--        where n.nspname = 'public'
--          and p.proname in ('assert_b2b_self_service_item_integrity',
--                            'b2b_supply_agreements_item_integrity_trigger',
--                            'b2b_supply_items_integrity_trigger',
--                            'b2b_supply_agreements_immutability_guard');
--      -> prosecdef true on all four
--      -> proconfig contains search_path= on all four
--      -> proacl grants EXECUTE to NOBODY: no =X/ entry for public, and
--         no anon, authenticated or service_role entry. Asked directly:
--           select has_function_privilege('anon',
--             'public.assert_b2b_self_service_item_integrity(uuid)', 'execute');
--         -> false, and the same for authenticated and service_role.
--
--   6. THE TRIGGERS, AND WHICH OF THEM ARE DEFERRED:
--        select tgname, tgdeferrable, tginitdeferred, tgconstraint <> 0 as is_constraint
--        from pg_trigger
--        where tgrelid in ('public.b2b_supply_agreements'::regclass,
--                          'public.b2b_supply_items'::regclass)
--          and not tgisinternal
--        order by tgrelid, tgname;
--      -> b2b_supply_agreements_item_integrity   deferrable, initdeferred
--      -> b2b_supply_items_integrity             deferrable, initdeferred
--      -> b2b_supply_agreements_immutability     NOT deferrable
--      -> plus 006's two set_updated_at triggers, untouched.
--
--   7. THE INDEXES, AND THE ONE THAT MUST NOT EXIST:
--        select indexname, indexdef from pg_indexes
--        where schemaname = 'public'
--          and tablename in ('b2b_supply_agreements','b2b_supply_items')
--        order by indexname;
--      -> the two partial uniques, the plan/status index and
--         b2b_supply_items_canonical_per_agreement_key are present.
--      -> NO index unique on user_id, with or without a status
--         predicate. There is no one-agreement-per-user rule.
--
--   8. NOTHING MOVED, AND NO PRIVILEGE CHANGED:
--        select count(*) from public.b2b_supply_agreements;   -> unchanged
--        select count(*) from public.b2b_supply_items;        -> unchanged
--        select grantee, privilege_type
--        from information_schema.role_table_grants
--        where table_schema = 'public'
--          and table_name in ('b2b_supply_agreements','b2b_supply_items')
--          and grantee in ('anon','authenticated','service_role')
--        order by table_name, grantee, privilege_type;
--      -> exactly what 006 and 048 left: SELECT for authenticated and
--         SELECT for service_role. No anon. No write privilege.
--
--   9. AND THE THREE-VALUED-LOGIC CASES, on a SCRATCH database only -
--      these are INSERTs and have no business on Production:
--        pricing_snapshot = '{}'                          -> rejected
--        pricing_snapshot = '{"packs":2}'                 -> rejected
--        a monthly snapshot carrying annualProductNetCents -> rejected
--        an annual contract amount one cent off the formula -> rejected
--        pricing_rules_version = 'b2b-2027.1'             -> rejected
--        plan_type='annual' with cancellation_requested_at -> rejected
--        an active annual agreement with no canonical item -> rejected
--                                                            at COMMIT
-- ══════════════════════════════════════════════════════════════
