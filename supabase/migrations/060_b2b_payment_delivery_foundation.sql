-- ══════════════════════════════════════════════════════════════
-- 060 — B2B SELF-SERVICE SUPPLY COMMERCE: PAYMENTS AND DELIVERIES
--
-- 059 gave the AGREEMENT its plan, its price and its canonical item.
-- 060 gives the agreement its two schedules - what is owed and when, and
-- what is delivered and when - plus the cross-table integrity that could
-- not be written until these two tables existed.
--
-- ── WHAT 059 STILL OWNS, AND 060 DOES NOT RESTATE ─────────────
--
--   plan_type and the monthly/annual shape
--   pricing_rules_version, pack_grams, pack_net_cents, quantity_packs
--   base_monthly_product_net_cents, contract_product_net_cents
--   instalment_count                 <- THE PARENT OWNS THIS
--   the pricing snapshot
--   the cancellation and termination vocabulary
--   agreement <-> canonical item integrity
--
-- Neither new table carries a copy of any of those. b2b_payment_schedule
-- has no instalment_count and b2b_deliveries has no plan_type: a child
-- row that restated its parent's configuration would be the copy that
-- disagrees, and both are one join away from the authority.
--
-- ── THE TWO TABLES ARE NOT THE SAME KIND OF THING ─────────────
--
--   b2b_payment_schedule  WHAT IS OWED. Annual only: an annual contract
--                         is instalments against a frozen total this
--                         database owns. A MONTHLY agreement has ZERO
--                         rows here, because a monthly agreement is
--                         billed by a Stripe subscription and Stripe is
--                         the schedule.
--
--   b2b_deliveries        WHAT WAS SUPPLIED. Both plans. Every row is a
--                         HISTORICAL FACT about one delivery, and
--                         section 9 below is the whole reason this table
--                         does not mirror the agreement.
--
-- ── HISTORICAL, NOT MIRRORED. THE RULE THIS TABLE EXISTS FOR ──
--
-- A delivery row records what WAS delivered, to WHERE, under WHICH
-- routing. The agreement records what is delivered NEXT. Those are
-- different facts and they are allowed to differ:
--
--   delivery #1 shipped 2 packs. The customer later moves to 3 packs.
--   Delivery #1 still shipped 2 packs, and nothing may rewrite it.
--
--   delivery #1 went to a Berlin address for free. The customer later
--   moves to Hamburg. Delivery #1 was still a Berlin local delivery.
--
-- So NOTHING in this migration compares a delivery's quantity_packs,
-- shipping_class or address snapshot against the agreement's CURRENT
-- values. 059's canonical item is the mirror of the current
-- configuration; these rows are the archive, and an archive that is
-- kept in sync with the present is not an archive.
--
-- ── FAIL CLOSED, DELIBERATELY ─────────────────────────────────
--
-- Both tables are NEW, so every object below is created outright - no
-- IF NOT EXISTS anywhere. If any of it already exists, the schema is not
-- what it is believed to be, and a failed migration inside a rolled-back
-- transaction is the right outcome.
--
-- ── THREE-VALUED LOGIC AND EVALUATION ORDER, AS IN 059 ────────
--
-- A PostgreSQL CHECK passes on TRUE **or NULL**, so every compound
-- predicate here terminates in `) IS TRUE` and every JSON key is proved
-- present with ? / ?& before its value is read.
--
-- And PostgreSQL does not promise the order in which it evaluates AND's
-- operands, so a jsonb_typeof() test to the LEFT of a cast is not a
-- guard. Every operation below that can RAISE for a well-formed jsonb
-- value of the wrong type carries its own guarantee in a CASE:
--
--   case when jsonb_typeof(v) = 'number' then (v->>'k')::numeric = x
--        else false end
--
-- ELSE FALSE, never ELSE NULL. ::numeric rather than ::bigint for JSON
-- values, because a JSON number may be fractional and '4462.5'::bigint
-- raises while ::numeric is total once 'number' is proved.
--
-- ── WHAT THIS MIGRATION DOES NOT DO ───────────────────────────
--
--   NO DROP of any kind. NO DELETE, UPDATE or INSERT of business data.
--   NO change to any 059 or 006 object, constraint, policy or grant.
--   NO Stripe call, no invoice creation, no settlement, no retry or
--      dunning worker, no delivery generator, no activation RPC, no
--      cancellation endpoint, no email, no order, no inventory effect.
--   NO write privilege for anybody. Package 5 brings the trusted write
--      surface together with the runtime that needs it, and grants the
--      privileges it needs at the same time.
--   NO customer shipping price. Section 15 says why.
-- ══════════════════════════════════════════════════════════════

begin;

-- ══════════════════════════════════════════════════════════════
-- 1. THE PAYMENT SCHEDULE
-- ══════════════════════════════════════════════════════════════
--
-- One row per instalment of an ANNUAL contract. The parent's
-- instalment_count says how many there must be; this table does not
-- restate it.
--
-- ON DELETE RESTRICT, not CASCADE. 006 gave b2b_supply_items a CASCADE
-- because an order line has no meaning without its order. A payment
-- instalment is different: it is money that was owed, invoiced and
-- possibly paid, and deleting the agreement out from under it must be
-- REFUSED rather than silently taking the payment history with it.

create table public.b2b_payment_schedule (
  id                       uuid primary key default gen_random_uuid(),

  supply_agreement_id      uuid not null
                           references public.b2b_supply_agreements(id) on delete restrict,

  -- 1-based, contiguous, unique per agreement. smallint: the approved
  -- schedules are 1, 2 and 4 instalments.
  instalment_number        smallint not null check (instalment_number > 0),

  due_at                   timestamptz not null,

  status                   text not null default 'scheduled',

  -- The product net owed by THIS instalment. Always present, always
  -- positive: an instalment of zero is not an instalment.
  net_cents                integer not null check (net_cents > 0),

  -- ESTABLISHED WHEN THE INSTALMENT IS INVOICED, not when it is
  -- scheduled. A tax_cents of 0 on a scheduled row would read as "the
  -- VAT on this instalment is zero" rather than "no VAT has been
  -- established yet", which is why all four are nullable.
  tax_rate_percent         smallint,
  tax_cents                integer,
  gross_cents              integer,

  tax_calculation_version  text,
  price_origin             text,

  -- Both, because instalment 1 may settle through Checkout while later
  -- instalments are invoiced. Neither is assumed.
  stripe_invoice_id        text,
  stripe_payment_intent_id text,

  invoiced_at              timestamptz,
  action_required_at       timestamptz,
  failed_at                timestamptz,
  paid_at                  timestamptz,
  voided_at                timestamptz,

  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

comment on table public.b2b_payment_schedule is
  'ANNUAL ONLY: one row per instalment of a B2B self-service annual contract. A monthly agreement has zero rows here - it is billed by its Stripe subscription. instalment_count lives on the parent agreement (migration 059) and is deliberately not copied here.';
comment on column public.b2b_payment_schedule.net_cents is
  'Product net owed by this instalment, integer cents. The sum across an active annual agreement equals b2b_supply_agreements.contract_product_net_cents.';
comment on column public.b2b_payment_schedule.tax_rate_percent is
  'NULL until the instalment is invoiced. 7 once established: Matcha is the only product this schedule bills, at the reduced German rate (lib/tax.ts TAX_CATEGORY_RATE_PERCENT.matcha_reduced_de).';
comment on column public.b2b_payment_schedule.gross_cents is
  'net_cents + tax_cents, and equal to the net-origin half-up result of lib/tax.ts addTaxToNet(net_cents, 7). NULL until invoiced.';
comment on column public.b2b_payment_schedule.stripe_invoice_id is
  'Set once the instalment is invoiced. Checkout-first instalments may instead carry only stripe_payment_intent_id.';
comment on column public.b2b_payment_schedule.stripe_payment_intent_id is
  'The payment attempt behind this instalment, where the settlement was a PaymentIntent rather than an invoice.';


-- ══════════════════════════════════════════════════════════════
-- 2. THE PAYMENT STATUS MODEL
-- ══════════════════════════════════════════════════════════════
--
--   scheduled        owed, nothing attempted
--   invoiced         an invoice exists
--   action_required  the customer must authenticate (SCA) or act
--   payment_failed   an attempt failed and may be retried
--   paid             TERMINAL
--   void             TERMINAL
--
-- The transition graph is enforced by an IMMEDIATE BEFORE UPDATE
-- trigger in section 11 - immediate, because a guard that fires at
-- COMMIT tells you a forbidden transition happened but not which
-- statement did it.
--
-- ── TIMESTAMPS ARE A LOG, NOT A STATE ─────────────────────────
--
-- Each status IMPLIES its own timestamp, and nothing more. A row that
-- failed, then required action, then paid keeps failed_at,
-- action_required_at AND paid_at, because all three happened. Requiring
-- the earlier ones to become NULL would delete the history of a payment
-- that is exactly the history somebody will need to read.

alter table public.b2b_payment_schedule
  add constraint b2b_payment_schedule_status_check
    check (status in ('scheduled', 'invoiced', 'action_required',
                      'payment_failed', 'paid', 'void')),

  add constraint b2b_payment_schedule_invoiced_at_check
    check (status <> 'invoiced' or invoiced_at is not null),

  add constraint b2b_payment_schedule_action_required_at_check
    check (status <> 'action_required' or action_required_at is not null),

  add constraint b2b_payment_schedule_failed_at_check
    check (status <> 'payment_failed' or failed_at is not null),

  add constraint b2b_payment_schedule_paid_at_check
    check (status <> 'paid' or paid_at is not null),

  add constraint b2b_payment_schedule_voided_at_check
    check (status <> 'void' or voided_at is not null);


-- ══════════════════════════════════════════════════════════════
-- 3. THE MONEY AND ITS TAX LIFECYCLE
-- ══════════════════════════════════════════════════════════════
--
-- THIS TABLE BILLS PRODUCT INSTALMENTS AND NOTHING ELSE. Customer
-- shipping is a per-delivery fact and lives on b2b_deliveries, where it
-- is deliberately still unpriced - see section 15. A shipping amount
-- here would be a second answer to a question this table is not asked.
--
-- ── THE CLOSED WORLD ──────────────────────────────────────────
--
-- 7 %, net-origin, de-net-2026.1. All three are launch facts, and all
-- three are closed: a German rate change or a new calculation version
-- arrives with a future migration that deliberately widens these
-- constraints, not with a row that quietly claims a rate nobody
-- approved.
--
-- ── THE GROSS IS NOT A SECOND OPINION ─────────────────────────
--
-- lib/tax.ts addTaxToNet(net, rate) computes
--
--   gross = divideRoundHalfUp(net * (100 + rate), 100)
--   tax   = gross - net
--
-- so the tax is the REMAINDER of one rounding rather than a second
-- independently rounded figure - which is what makes net + tax = gross
-- exact for every input. divideRoundHalfUp(n, d) is floor((2n + d) / 2d),
-- so at rate 7 the SQL below is that same expression with d = 100:
--
--   (2 * (net * 107) + 100) / 200
--
-- PostgreSQL integer division truncates toward zero and every operand is
-- non-negative, so it is floor - identical to the TypeScript. bigint
-- keeps the intermediate exact.
--
-- BOTH facts are asserted: gross = net + tax AND gross = the formula.
-- Either alone would admit a pair the other refuses.

alter table public.b2b_payment_schedule
  -- ══════════════════════════════════════════════════════════
  -- ALL FIVE, OR NONE. THE RULE THE PER-COLUMN CHECKS DO NOT GIVE.
  -- ══════════════════════════════════════════════════════════
  --
  -- Each column below is individually "null or valid", and each pairwise
  -- reconciliation only fires when BOTH of its operands exist. Together
  -- that admits a row carrying tax_rate_percent = 7 and nothing else -
  -- a row that claims a rate was established while the amount, the gross,
  -- the version and the origin are all still missing. Half a tax fact is
  -- worse than none: it reads as established to anything that checks one
  -- column and not the next.
  --
  -- So the five are ATOMIC, whatever the status. Counting the NULLs is
  -- the whole rule: five means nothing has been established yet, zero
  -- means all of it has, and every number in between is refused.
  -- (x IS NULL) is a boolean that is never itself NULL, so this
  -- predicate cannot evaluate to UNKNOWN and needs no IS TRUE.
  add constraint b2b_payment_schedule_tax_facts_all_or_none_check
    check (((tax_rate_percent        is null)::int
            + (tax_cents             is null)::int
            + (gross_cents           is null)::int
            + (tax_calculation_version is null)::int
            + (price_origin          is null)::int) in (0, 5)),

  -- Domain rules next, and they hold whatever the status is - including
  -- on a voided row that kept the tax facts it had established.
  add constraint b2b_payment_schedule_tax_rate_check
    check (tax_rate_percent is null or tax_rate_percent = 7),

  add constraint b2b_payment_schedule_tax_cents_check
    check (tax_cents is null or tax_cents >= 0),

  add constraint b2b_payment_schedule_gross_cents_check
    check (gross_cents is null or gross_cents > 0),

  add constraint b2b_payment_schedule_tax_calculation_version_check
    check (tax_calculation_version is null or tax_calculation_version = 'de-net-2026.1'),

  add constraint b2b_payment_schedule_price_origin_check
    check (price_origin is null or price_origin = 'net'),

  -- WHENEVER a gross and a tax both exist, they reconcile - and they
  -- reconcile the way lib/tax.ts produces them. Not status-guarded on
  -- purpose: a voided row that preserved its tax facts must preserve
  -- CORRECT ones.
  add constraint b2b_payment_schedule_gross_sum_check
    check (tax_cents is null
           or gross_cents is null
           or (gross_cents::bigint = net_cents::bigint + tax_cents::bigint) is true),

  add constraint b2b_payment_schedule_gross_formula_check
    check (tax_cents is null
           or gross_cents is null
           or tax_rate_percent is null
           or (gross_cents::bigint
                 = (2 * (net_cents::bigint * (100 + tax_rate_percent::bigint)) + 100) / 200) is true),

  -- ── AND ONCE THE INSTALMENT HAS BEEN PUT TO THE CUSTOMER, THE
  --    WHOLE TAX FACT MUST BE THERE. 'scheduled' is the only status
  --    that may still be tax-free, and 'void' is the only one that may
  --    have skipped it.
  add constraint b2b_payment_schedule_tax_established_check
    check (status not in ('invoiced', 'action_required', 'payment_failed', 'paid')
           or (tax_rate_percent = 7
               and tax_cents is not null
               and gross_cents is not null
               and tax_calculation_version = 'de-net-2026.1'
               and price_origin = 'net') is true);


-- ══════════════════════════════════════════════════════════════
-- 4. PAYMENT CORRELATION
-- ══════════════════════════════════════════════════════════════
--
-- TWO identifiers, independently unique, and NEITHER is assumed to be
-- the one a given instalment uses. Instalment 1 may settle through a
-- Checkout Session and carry a PaymentIntent; instalment 2 may be
-- invoiced and carry an Invoice. Requiring an invoice id on every paid
-- row would make the Checkout path unrepresentable.
--
-- What IS required is that a row which has been put to the customer can
-- be traced back to the Stripe object that did it.

alter table public.b2b_payment_schedule
  add constraint b2b_payment_schedule_stripe_invoice_id_format_check
    check (stripe_invoice_id is null
           or (char_length(btrim(stripe_invoice_id)) between 3 and 255
               and stripe_invoice_id = btrim(stripe_invoice_id)) is true),

  add constraint b2b_payment_schedule_stripe_payment_intent_id_format_check
    check (stripe_payment_intent_id is null
           or (char_length(btrim(stripe_payment_intent_id)) between 3 and 255
               and stripe_payment_intent_id = btrim(stripe_payment_intent_id)) is true),

  -- An invoice status means an invoice exists.
  add constraint b2b_payment_schedule_invoiced_requires_invoice_check
    check (status <> 'invoiced' or stripe_invoice_id is not null),

  -- A payment was attempted, so SOMETHING at Stripe knows about it.
  add constraint b2b_payment_schedule_attempt_requires_correlation_check
    check (status not in ('action_required', 'payment_failed', 'paid')
           or (stripe_invoice_id is not null
               or stripe_payment_intent_id is not null) is true);


-- ══════════════════════════════════════════════════════════════
-- 5. THE DELIVERIES
-- ══════════════════════════════════════════════════════════════
--
-- NO plan_type column. The plan is the parent's fact, and a delivery row
-- that carried a copy would be the one that disagreed after a plan
-- change - which 059's immutability guard makes impossible anyway, since
-- a plan change is a NEW agreement.
--
-- NO address_id. An address row is MUTABLE: the customer edits it and
-- every delivery that ever pointed at it silently changes where it went.
-- delivery_address_snapshot is the historical truth, frozen at
-- resolution, and it is the only address this table believes.

create table public.b2b_deliveries (
  id                           uuid primary key default gen_random_uuid(),

  supply_agreement_id          uuid not null
                               references public.b2b_supply_agreements(id) on delete restrict,

  delivery_number              integer not null check (delivery_number > 0),

  scheduled_for                timestamptz not null,

  -- HISTORICAL. What THIS delivery carries. Deliberately NOT compared
  -- to the agreement's current quantity_packs - see the header.
  quantity_packs               integer not null check (quantity_packs between 1 and 10),

  status                       text not null default 'scheduled',

  -- Required when held, because "why is this customer not receiving
  -- their Matcha" must have an answer on the row.
  hold_reason                  text,

  -- ── THE RESOLUTION FACTS. All NULL on a schedule slot, all present
  --    once resolved, and frozen from then on.
  delivery_address_snapshot    jsonb,
  berlin_eligibility_snapshot  jsonb,
  shipping_class               text,
  shipping_snapshot            jsonb,
  resolved_at                  timestamptz,

  -- ── WHAT GLOA CHARGES THE CUSTOMER FOR DELIVERY. Unpriced by
  --    decision - see section 15. Nullable, no default, no derivation.
  customer_shipping_net_cents   integer,
  customer_shipping_tax_cents   integer,
  customer_shipping_gross_cents integer,

  order_id                     uuid,
  stripe_invoice_id            text,
  tracking_number              text,

  dispatched_at                timestamptz,
  delivered_at                 timestamptz,
  cancelled_at                 timestamptz,

  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now()
);

comment on table public.b2b_deliveries is
  'One row per B2B supply delivery. Every row is a HISTORICAL fact: quantity_packs, the address snapshot and the routing are what THIS delivery was, and are never reconciled against the agreement''s current configuration.';
comment on column public.b2b_deliveries.quantity_packs is
  'HISTORICAL: the packs THIS delivery carries. A later change to the agreement quantity does not and must not rewrite it.';
comment on column public.b2b_deliveries.delivery_address_snapshot is
  'The historical address truth for this delivery, frozen at resolution. Deliberately a snapshot rather than an address_id: an address row is mutable and would rewrite history.';
comment on column public.b2b_deliveries.berlin_eligibility_snapshot is
  'The canonical resolveB2bBerlinEligibility() result (lib/b2bBerlinEligibility.ts), including the negative decisions - eligible=false is a real answer, not a missing one.';
comment on column public.b2b_deliveries.shipping_snapshot is
  'The canonical resolveB2bShipping() result (lib/b2bShippingRules.ts), and ONLY a commercially usable one: free_local_delivery or carrier_reference_resolved. measurement_required and unsupported_* are refusals, not routes, and are never stored here.';
comment on column public.b2b_deliveries.customer_shipping_net_cents is
  'What GLOA charges the CUSTOMER for this delivery. NULL because no B2B customer shipping price or VAT treatment is approved yet. Distinct from shipping_snapshot.carrierRetailGrossCents, which is what the carrier would charge GLOA.';


-- ══════════════════════════════════════════════════════════════
-- 6. THE DELIVERY STATUS MODEL
-- ══════════════════════════════════════════════════════════════
--
--   scheduled   a slot, or a resolved delivery awaiting dispatch
--   held        paused. REQUIRED: a payment failure pauses DELIVERIES
--               and leaves the contract standing. Without this status
--               the only way to stop a delivery would be to cancel it,
--               which would end something that has not ended.
--   dispatched  it left
--   delivered   it arrived. TERMINAL.
--   cancelled   it will not happen. TERMINAL.
--
-- Conservative on purpose. There is no returns flow, no partial
-- shipment and no re-delivery here: those are fulfilment decisions
-- nobody has made, and inventing them in a foundation migration would
-- be inventing the business process too.

alter table public.b2b_deliveries
  add constraint b2b_deliveries_status_check
    check (status in ('scheduled', 'held', 'dispatched', 'delivered', 'cancelled')),

  add constraint b2b_deliveries_hold_reason_requires_held_check
    check (status <> 'held' or hold_reason is not null),

  add constraint b2b_deliveries_hold_reason_length_check
    check (hold_reason is null
           or char_length(btrim(hold_reason)) between 1 and 500),

  add constraint b2b_deliveries_dispatched_at_check
    check (status <> 'dispatched' or dispatched_at is not null),

  add constraint b2b_deliveries_delivered_at_check
    check (status <> 'delivered' or delivered_at is not null),

  add constraint b2b_deliveries_cancelled_at_check
    check (status <> 'cancelled' or cancelled_at is not null),

  -- A delivery cannot leave before it was scheduled to, and cannot
  -- arrive before it left.
  add constraint b2b_deliveries_delivered_after_dispatched_check
    check (delivered_at is null or dispatched_at is null or delivered_at >= dispatched_at),

  -- Nothing may be dispatched that was never routed. This is the one
  -- operational readiness rule the schema states, and it is what makes
  -- "shipping_snapshot stays NULL when DHL measurements are missing"
  -- into a real refusal rather than a comment.
  add constraint b2b_deliveries_dispatch_requires_resolution_check
    check (status not in ('dispatched', 'delivered')
           or (resolved_at is not null and shipping_snapshot is not null) is true);


-- ══════════════════════════════════════════════════════════════
-- 7. SCHEDULE SLOT versus RESOLVED DELIVERY
-- ══════════════════════════════════════════════════════════════
--
-- An ACTIVE annual agreement has all twelve delivery rows from the
-- moment it activates. Eleven of them are SLOTS: nobody knows yet which
-- address delivery #7 goes to, because the customer may move in March.
-- Resolving them all at activation would freeze eleven routing decisions
-- against an address that has not been used yet.
--
-- So a row has two shapes, and resolved_at is the discriminator:
--
--   resolved_at IS NULL      a slot. No address, no eligibility, no
--                            class, no snapshot. Nothing frozen.
--   resolved_at IS NOT NULL  routed. All four present, mutually
--                            consistent, and immutable from here
--                            (section 12).
--
-- THE TRANSITION NULL -> RESOLVED IS ALLOWED EXACTLY ONCE, and section
-- 12 is written so that the UPDATE which performs it is not treated as
-- an attempt to change an already-frozen row.

alter table public.b2b_deliveries
  add constraint b2b_deliveries_shipping_class_check
    check (shipping_class is null or shipping_class in ('berlin_local', 'dhl')),

  -- A slot freezes nothing.
  add constraint b2b_deliveries_unresolved_is_unrouted_check
    check (resolved_at is not null
           or (shipping_class is null and shipping_snapshot is null) is true),

  -- And a routed delivery is routed completely. All four, or it is not
  -- resolved - including shipping_snapshot, which is what makes a DHL
  -- delivery with no measurements impossible to resolve at all.
  add constraint b2b_deliveries_resolved_is_complete_check
    check (resolved_at is null
           or (delivery_address_snapshot is not null
               and berlin_eligibility_snapshot is not null
               and shipping_class in ('berlin_local', 'dhl')
               and shipping_snapshot is not null) is true),

  -- ══════════════════════════════════════════════════════════
  -- THE ADDRESS SNAPSHOT IS THE REPOSITORY'S, AND IT FAILS CLOSED
  -- ══════════════════════════════════════════════════════════
  --
  -- The canonical shape already exists and is NOT invented here. It is
  -- AddressSnapshot from lib/orderAddressSnapshot.ts - the same eight
  -- keys lib/subscriptionCheckoutRules.ts's SubscriptionAddressSnapshot
  -- declares, and the same object migrations 001-039 already store in
  -- orders.shipping_address_snapshot and the annual plan's:
  --
  --   name company line1 line2 city postalCode state country
  --
  -- ALL EIGHT ARE REQUIRED TO BE PRESENT because both producers -
  -- buildShippingAddressSnapshot and buildBillingAddressSnapshot - emit
  -- all eight on every call, spreading fromStripeAddress over an
  -- explicit name and company. Each MAY be JSON null: Stripe returns
  -- nulls, and a required key whose value may be null is a different
  -- rule from an optional key. No key is required that no producer
  -- writes, and none is renamed - postalCode is not postcode here, even
  -- though lib/b2bBerlinEligibility.ts calls its own input postcode.
  --
  -- '{}', '[]' and '"Berlin"' are each refused: the first by ?&, the
  -- other two by the object type test. The <> '{}' test is kept as the
  -- explicit statement of that, so the intent survives an edit to the
  -- key list.
  add constraint b2b_deliveries_address_snapshot_shape_check
    check (
      delivery_address_snapshot is null
      or (
             jsonb_typeof(delivery_address_snapshot) = 'object'
         and delivery_address_snapshot <> '{}'::jsonb
         and delivery_address_snapshot ?& array['name', 'company', 'line1', 'line2',
                                                'city', 'postalCode', 'state', 'country']
         and jsonb_typeof(delivery_address_snapshot->'name')       in ('string', 'null')
         and jsonb_typeof(delivery_address_snapshot->'company')    in ('string', 'null')
         and jsonb_typeof(delivery_address_snapshot->'line1')      in ('string', 'null')
         and jsonb_typeof(delivery_address_snapshot->'line2')      in ('string', 'null')
         and jsonb_typeof(delivery_address_snapshot->'city')       in ('string', 'null')
         and jsonb_typeof(delivery_address_snapshot->'postalCode') in ('string', 'null')
         and jsonb_typeof(delivery_address_snapshot->'state')      in ('string', 'null')
         and jsonb_typeof(delivery_address_snapshot->'country')    in ('string', 'null')
      ) is true
    ),

  -- AND A ROUTED DELIVERY NEEDS AN ADDRESS SOMETHING CAN BE CARRIED TO.
  -- A snapshot whose line1, postalCode or country is null is a valid
  -- AddressSnapshot and an undeliverable one - and it could not have
  -- produced the Berlin verdict frozen beside it, which is derived from
  -- exactly the country and the postcode. Nullable in general, required
  -- once the delivery is routed.
  add constraint b2b_deliveries_resolved_address_is_deliverable_check
    check (resolved_at is null
           or (jsonb_typeof(delivery_address_snapshot->'line1')      = 'string'
               and jsonb_typeof(delivery_address_snapshot->'postalCode') = 'string'
               and jsonb_typeof(delivery_address_snapshot->'country')    = 'string') is true),

  add constraint b2b_deliveries_tracking_number_format_check
    check (tracking_number is null
           or (char_length(btrim(tracking_number)) between 3 and 255
               and tracking_number = btrim(tracking_number)) is true),

  add constraint b2b_deliveries_stripe_invoice_id_format_check
    check (stripe_invoice_id is null
           or (char_length(btrim(stripe_invoice_id)) between 3 and 255
               and stripe_invoice_id = btrim(stripe_invoice_id)) is true);


-- ══════════════════════════════════════════════════════════════
-- 8. THE BERLIN ELIGIBILITY SNAPSHOT
-- ══════════════════════════════════════════════════════════════
--
-- The canonical output of resolveB2bBerlinEligibility() from
-- lib/b2bBerlinEligibility.ts, key for key:
--
--   eligible            boolean
--   reason              'eligible' | 'country_not_germany'
--                       | 'postcode_malformed' | 'postcode_outside_berlin'
--   normalizedCountry   string or null  (null when unrecognised)
--   normalizedPostcode  string or null  (five digits, never repaired)
--   rulesVersion        'berlin-2026.1'
--
-- BOTH VERDICTS ARE STORED. eligible=false is a decision - this address
-- is not entitled to free local delivery - and it is the decision that
-- costs the customer money. A constraint that only admitted eligible
-- snapshots would force every DHL delivery to record nothing about why
-- it was a DHL delivery.
--
-- eligible and reason are cross-checked against each other: reason
-- 'eligible' means eligible, and the three negative reasons mean not
-- eligible. That is the one internal contradiction a snapshot could
-- carry, and it is exactly the one a reader would trust.

alter table public.b2b_deliveries
  add constraint b2b_deliveries_berlin_snapshot_check
    check (
      berlin_eligibility_snapshot is null
      or (
             jsonb_typeof(berlin_eligibility_snapshot) = 'object'
         and berlin_eligibility_snapshot ?& array['eligible', 'reason', 'normalizedCountry',
                                                  'normalizedPostcode', 'rulesVersion']
         and jsonb_typeof(berlin_eligibility_snapshot->'eligible') = 'boolean'
         and berlin_eligibility_snapshot->>'rulesVersion' = 'berlin-2026.1'
         and berlin_eligibility_snapshot->>'reason' in ('eligible', 'country_not_germany',
                                                        'postcode_malformed', 'postcode_outside_berlin')
         and jsonb_typeof(berlin_eligibility_snapshot->'normalizedCountry')  in ('string', 'null')
         and jsonb_typeof(berlin_eligibility_snapshot->'normalizedPostcode') in ('string', 'null')
         -- the verdict and its reason agree
         and ((berlin_eligibility_snapshot->>'eligible') = 'true')
               = ((berlin_eligibility_snapshot->>'reason') = 'eligible')
      ) is true
    );


-- ══════════════════════════════════════════════════════════════
-- 9. THE SHIPPING SNAPSHOT
-- ══════════════════════════════════════════════════════════════
--
-- The canonical output of resolveB2bShipping() from
-- lib/b2bShippingRules.ts - and ONLY the two variants that describe a
-- route GLOA can actually use:
--
--   mode='berlin_local'  chargeStatus='free_local_delivery'
--   mode='dhl'           chargeStatus='carrier_reference_resolved'
--
-- ── WHAT IS DELIBERATELY NOT STORABLE ─────────────────────────
--
-- measurement_required is a REFUSAL, not a route. It means nobody has
-- weighed the parcel, and the resolver returns it precisely so the
-- caller fails closed. Freezing it into shipping_snapshot would record
-- "this delivery is routed" about a delivery that is not. The same goes
-- for unsupported_shipment, unsupported_country and unsupported_quantity.
--
-- So a non-Berlin delivery with no measurements simply CANNOT be
-- resolved: shipping_snapshot stays NULL, resolved_at stays NULL, and
-- section 6's dispatch rule refuses to let it leave. No weight and no
-- dimension is ever invented here.
--
-- ── THE DHL FIELD NAMES ARE THE RESOLVER'S, NOT THIS FILE'S ───
--
-- dhlProductCode, NOT productCode - the tariff table calls it
-- productCode and the RESOLUTION renames it, and this constraint
-- follows the resolution because the resolution is what gets stored.
--
-- maxGirthMm is required to be PRESENT but may be JSON null: the 2 kg
-- product states no girth limit, and null there records "not stated"
-- rather than "unlimited". A required key whose value may be null is a
-- different rule from an optional key, and this is the former.
--
-- ── WHAT IS NOT REQUIRED ──────────────────────────────────────
--
-- maxDimensions is NOT required, because resolveB2bShipping() does not
-- emit it. The tariff carries maxDimensionsMm; the resolution carries
-- the parcel's own `dimensions`, `maxWeightGrams` and `maxGirthMm` and
-- stops there. Requiring a key no producer writes would reject every
-- real snapshot.

alter table public.b2b_deliveries
  add constraint b2b_deliveries_shipping_snapshot_check
    check (
      shipping_snapshot is null
      or (
             jsonb_typeof(shipping_snapshot) = 'object'
         and shipping_snapshot ?& array['rulesVersion', 'berlinEligibilityVersion',
                                        'berlin', 'packs', 'mode', 'chargeStatus',
                                        'carrierRetailGrossCents']
         and shipping_snapshot->>'rulesVersion'              = 'dhl-de-2026.1'
         and shipping_snapshot->>'berlinEligibilityVersion'  = 'berlin-2026.1'
         and jsonb_typeof(shipping_snapshot->'berlin') = 'object'
         and jsonb_typeof(shipping_snapshot->'packs')  = 'number'
         -- the snapshot describes THIS delivery's own historical packs
         and case when jsonb_typeof(shipping_snapshot->'packs') = 'number'
                  then (shipping_snapshot->>'packs')::numeric = quantity_packs::numeric
                  else false end
         and jsonb_typeof(shipping_snapshot->'carrierRetailGrossCents') = 'number'
         and (
           -- BERLIN: GLOA drives. Nothing is measured, and the carrier
           -- reference cost is zero because there is no carrier.
           (    shipping_snapshot->>'mode'         = 'berlin_local'
            and shipping_snapshot->>'chargeStatus' = 'free_local_delivery'
            and case when jsonb_typeof(shipping_snapshot->'carrierRetailGrossCents') = 'number'
                     then (shipping_snapshot->>'carrierRetailGrossCents')::numeric = 0
                     else false end)
           or
           -- DHL: a measured parcel against a named tariff.
           (    shipping_snapshot->>'mode'         = 'dhl'
            and shipping_snapshot->>'chargeStatus' = 'carrier_reference_resolved'
            and shipping_snapshot ?& array['shipmentWeightGrams', 'dimensions', 'girthMm',
                                           'dhlProductCode', 'maxWeightGrams', 'maxGirthMm',
                                           'tariffSource']
            and jsonb_typeof(shipping_snapshot->'shipmentWeightGrams') = 'number'
            and jsonb_typeof(shipping_snapshot->'girthMm')             = 'number'
            and jsonb_typeof(shipping_snapshot->'maxWeightGrams')      = 'number'
            and jsonb_typeof(shipping_snapshot->'maxGirthMm')          in ('number', 'null')
            and jsonb_typeof(shipping_snapshot->'tariffSource')        = 'object'
            and shipping_snapshot->>'dhlProductCode' in ('DHL_PAKET_2KG', 'DHL_PAKET_5KG',
                                                         'DHL_PAKET_10KG')
            and jsonb_typeof(shipping_snapshot->'dimensions') = 'object'
            and shipping_snapshot->'dimensions' ?& array['lengthMm', 'widthMm', 'heightMm']
            and jsonb_typeof(shipping_snapshot->'dimensions'->'lengthMm') = 'number'
            and jsonb_typeof(shipping_snapshot->'dimensions'->'widthMm')  = 'number'
            and jsonb_typeof(shipping_snapshot->'dimensions'->'heightMm') = 'number'
            -- the provenance the resolver attaches, whole
            and shipping_snapshot->'tariffSource' ?& array['carrier', 'product', 'priceBasis',
                                                           'market', 'recordedOn', 'effectiveFrom']
            and jsonb_typeof(shipping_snapshot->'tariffSource'->'effectiveFrom') in ('string', 'null')
            -- a carrier shipment costs something
            and case when jsonb_typeof(shipping_snapshot->'carrierRetailGrossCents') = 'number'
                     then (shipping_snapshot->>'carrierRetailGrossCents')::numeric > 0
                     else false end)
         )
      ) is true
    ),

  -- The column and the snapshot are the same decision written twice, so
  -- they must not disagree.
  add constraint b2b_deliveries_shipping_class_matches_snapshot_check
    check (shipping_snapshot is null
           or shipping_class is null
           or (shipping_snapshot->>'mode' = shipping_class) is true),

  -- ══════════════════════════════════════════════════════════
  -- THREE AUTHORITIES, ONE DECISION
  -- ══════════════════════════════════════════════════════════
  --
  -- A routed delivery records the SAME routing decision three times:
  --
  --   A  shipping_class                        the column
  --   B  berlin_eligibility_snapshot.eligible  WHY it was routed that way
  --   C  shipping_snapshot.mode/chargeStatus   HOW it will be carried
  --
  -- A and C already could not disagree - the constraint above ties the
  -- class to the mode, and the snapshot constraint ties each mode to its
  -- one legal chargeStatus. B WAS NOT TIED TO EITHER, which left a row
  -- able to say "this address qualifies for free Berlin delivery" while
  -- being routed and charged as a DHL parcel, or the reverse: a
  -- non-Berlin address taking free local delivery. Both are money.
  --
  -- eligible = true  <=>  berlin_local, and nothing else.
  --
  -- ->>'eligible' reads a JSON boolean as the text 'true' or 'false', so
  -- there is no cast here that could raise; an absent key yields NULL,
  -- the equality is UNKNOWN, and the IS TRUE terminator refuses it. Both
  -- verdicts stay storable - the negative one is what a DHL delivery
  -- carries as its reason for being a DHL delivery.
  add constraint b2b_deliveries_routing_decision_agrees_check
    check (shipping_class is null
           or (
                (    shipping_class = 'berlin_local'
                 and (berlin_eligibility_snapshot is null
                      or berlin_eligibility_snapshot->>'eligible' = 'true')
                 and (shipping_snapshot is null
                      or (shipping_snapshot->>'mode' = 'berlin_local'
                          and shipping_snapshot->>'chargeStatus' = 'free_local_delivery')))
                or
                (    shipping_class = 'dhl'
                 and (berlin_eligibility_snapshot is null
                      or berlin_eligibility_snapshot->>'eligible' = 'false')
                 and (shipping_snapshot is null
                      or (shipping_snapshot->>'mode' = 'dhl'
                          and shipping_snapshot->>'chargeStatus' = 'carrier_reference_resolved')))
              ) is true);


-- ══════════════════════════════════════════════════════════════
-- 10. CUSTOMER SHIPPING IS DELIBERATELY UNPRICED
-- ══════════════════════════════════════════════════════════════
--
-- THREE NULLABLE COLUMNS AND NO DEFAULT, BECAUSE NO RULE EXISTS YET.
--
-- What GLOA charges a business customer for delivery, and how that
-- charge is taxed, has not been decided. So this migration deliberately
-- does NOT:
--
--   * copy shipping_snapshot.carrierRetailGrossCents into them. That is
--     DHL's RETAIL END PRICE INCLUDING VAT - what a private person pays
--     at the counter. It is a carrier cost reference, not a B2B net
--     price, and treating it as one would invent both a price and a VAT
--     base in a single assignment.
--   * default Berlin to 0. Free CARRIAGE is not the same statement as
--     "the customer was charged 0,00 for delivery", and only one of
--     those is an accounting fact.
--   * assign a tax rate. Whether B2B delivery follows the Matcha rate as
--     an ancillary supply or stands on its own is a VAT determination,
--     and lib/tax.ts is the only place that may make one.
--
-- What IS enforced is that if they are ever written, they are written
-- COHERENTLY: all three or none, non-negative, and reconciling.
-- Zero is allowed here, unlike on the payment schedule - a shipping
-- charge of nothing is a real charge, whereas an instalment of nothing
-- is not an instalment.

alter table public.b2b_deliveries
  add constraint b2b_deliveries_customer_shipping_all_or_none_check
    check ((customer_shipping_net_cents is null)   = (customer_shipping_tax_cents is null)
       and (customer_shipping_net_cents is null)   = (customer_shipping_gross_cents is null)),

  add constraint b2b_deliveries_customer_shipping_non_negative_check
    check ((customer_shipping_net_cents   is null or customer_shipping_net_cents   >= 0)
       and (customer_shipping_tax_cents   is null or customer_shipping_tax_cents   >= 0)
       and (customer_shipping_gross_cents is null or customer_shipping_gross_cents >= 0)),

  add constraint b2b_deliveries_customer_shipping_sum_check
    check (customer_shipping_net_cents is null
           or (customer_shipping_gross_cents::bigint
                 = customer_shipping_net_cents::bigint
                   + customer_shipping_tax_cents::bigint) is true);


-- ══════════════════════════════════════════════════════════════
-- 11. THE TRANSITION GUARDS — IMMEDIATE
-- ══════════════════════════════════════════════════════════════
--
-- Both are BEFORE UPDATE and IMMEDIATE. A transition guard that fires at
-- COMMIT tells you a forbidden move happened but not which statement
-- made it, and the whole value of a state machine is knowing that.
--
-- A status that does not change is always allowed: an UPDATE that only
-- writes tax fields onto a scheduled row is not a transition.

create function public.b2b_payment_schedule_transition_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_allowed text[];
begin
  if new.status = old.status then
    return new;
  end if;

  v_allowed := case old.status
    when 'scheduled'       then array['invoiced', 'action_required', 'payment_failed', 'paid', 'void']
    when 'invoiced'        then array['action_required', 'payment_failed', 'paid', 'void']
    when 'action_required' then array['payment_failed', 'paid', 'void']
    when 'payment_failed'  then array['action_required', 'paid', 'void']
    -- paid and void are TERMINAL. Money that has settled, and a charge
    -- that was withdrawn, are both facts rather than states.
    else array[]::text[]
  end;

  if not (new.status = any (v_allowed)) then
    raise exception
      'b2b payment transition: % -> % is not permitted (instalment % of agreement %)',
      old.status, new.status, old.instalment_number, old.supply_agreement_id
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger b2b_payment_schedule_transition
  before update on public.b2b_payment_schedule
  for each row
  execute function public.b2b_payment_schedule_transition_guard();

create function public.b2b_deliveries_transition_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_allowed text[];
begin
  if new.status = old.status then
    return new;
  end if;

  v_allowed := case old.status
    -- A hold is reversible: payment recovers and the delivery resumes.
    when 'scheduled'  then array['held', 'dispatched', 'cancelled']
    when 'held'       then array['scheduled', 'dispatched', 'cancelled']
    -- Once it has left, the only ordinary outcome is arrival. A parcel
    -- that comes back is a RETURN, and no returns flow is approved.
    when 'dispatched' then array['delivered']
    else array[]::text[]
  end;

  if not (new.status = any (v_allowed)) then
    raise exception
      'b2b delivery transition: % -> % is not permitted (delivery % of agreement %)',
      old.status, new.status, old.delivery_number, old.supply_agreement_id
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger b2b_deliveries_transition
  before update on public.b2b_deliveries
  for each row
  execute function public.b2b_deliveries_transition_guard();


-- ══════════════════════════════════════════════════════════════
-- 12. THE RESOLUTION FREEZE — AND THE ONE UPDATE IT MUST ALLOW
-- ══════════════════════════════════════════════════════════════
--
-- ══════════════════════════════════════════════════════════════
-- THE SUBTLETY THIS TRIGGER EXISTS TO GET RIGHT
-- ══════════════════════════════════════════════════════════════
--
-- Resolving a delivery is ONE UPDATE that sets resolved_at AND the four
-- routing fields together. A guard written as
--
--   if new.resolved_at is not null then <freeze the four> end if;
--
-- would look at that very statement, see a non-null resolved_at, and
-- refuse the resolution it is supposed to permit. The only correct
-- question is about the row's PRIOR state:
--
--   if OLD.resolved_at is not null then <freeze> end if;
--
-- NULL -> resolved is therefore allowed exactly once, and every
-- subsequent UPDATE finds a non-null OLD.resolved_at and freezes.
--
-- quantity_packs is frozen with them: once a delivery has been routed,
-- what it carries is part of what was routed, and a later change to the
-- agreement's quantity must create the NEXT delivery rather than rewrite
-- this one.
--
-- Un-resolving is a violation too, not an escape hatch: IS DISTINCT FROM
-- treats a change back to NULL exactly like a change to a new value.

create function public.b2b_deliveries_resolution_freeze_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- The row was NOT resolved before this statement. Resolving it now is
  -- the whole point, so nothing is frozen yet.
  if old.resolved_at is null then
    return new;
  end if;

  if new.resolved_at is distinct from old.resolved_at then
    raise exception 'b2b delivery %: resolved_at is frozen once routing is established', old.id
      using errcode = 'check_violation';
  end if;
  if new.delivery_address_snapshot is distinct from old.delivery_address_snapshot then
    raise exception 'b2b delivery %: the delivery address snapshot is frozen at resolution', old.id
      using errcode = 'check_violation';
  end if;
  if new.berlin_eligibility_snapshot is distinct from old.berlin_eligibility_snapshot then
    raise exception 'b2b delivery %: the Berlin eligibility snapshot is frozen at resolution', old.id
      using errcode = 'check_violation';
  end if;
  if new.shipping_class is distinct from old.shipping_class then
    raise exception 'b2b delivery %: shipping_class is frozen at resolution', old.id
      using errcode = 'check_violation';
  end if;
  if new.shipping_snapshot is distinct from old.shipping_snapshot then
    raise exception 'b2b delivery %: the shipping snapshot is frozen at resolution', old.id
      using errcode = 'check_violation';
  end if;
  if new.quantity_packs is distinct from old.quantity_packs then
    raise exception 'b2b delivery %: quantity_packs is frozen once the delivery is routed', old.id
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger b2b_deliveries_resolution_freeze
  before update on public.b2b_deliveries
  for each row
  execute function public.b2b_deliveries_resolution_freeze_guard();


-- ══════════════════════════════════════════════════════════════
-- 13. CROSS-TABLE INTEGRITY — DEFERRED
-- ══════════════════════════════════════════════════════════════
--
-- Three facts no row-local CHECK can express, because all three span
-- tables and all three are about a SET of rows:
--
--   ACTIVE MONTHLY  zero payment rows
--   ACTIVE ANNUAL   exactly instalment_count payment rows, numbered
--                   1..n, whose net sum is contract_product_net_cents;
--                   and exactly 12 delivery rows numbered 1..12
--   ALWAYS          if child rows exist at all, their numbering starts
--                   at 1 and is contiguous
--
-- ── WHY DEFERRED, AND WHY FROM BOTH SIDES ─────────────────────
--
-- Activating an annual agreement is ONE transaction that inserts twelve
-- deliveries, inserts n payment rows and flips the status - in whatever
-- order the writer finds natural. An immediate trigger would fail on
-- every ordering but one, and the correct moment to ask "is this
-- agreement coherent?" is COMMIT, when it is the only moment the
-- question has an answer.
--
-- Both sides are needed because neither sees the other's statement: an
-- agreement UPDATE that changes instalment_count and a payment DELETE
-- that removes a row must each be caught.
--
-- PENDING is deliberately unconstrained beyond contiguity, so an
-- agreement can be built up before it is activated.
--
-- ── WHAT IT DELIBERATELY DOES NOT ASSERT ──────────────────────
--
-- The canonical item. That is 059's assertion, it already fires on its
-- own triggers, and restating it here would give one invariant two
-- owners.

create function public.assert_b2b_commerce_integrity(p_agreement_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_plan_type          text;
  v_status             text;
  v_instalment_count   integer;
  v_contract_net_cents integer;
  v_quantity_packs     integer;
  v_pay_count          integer;
  v_pay_min            integer;
  v_pay_max            integer;
  v_pay_sum            bigint;
  v_base_cents         bigint;
  v_alloc_mismatch     integer;
  v_del_count          integer;
  v_del_min            integer;
  v_del_max            integer;
  v_del_qty_mismatch   integer;
begin
  -- quantity_packs is read here but USED ONLY IN THE ANNUAL BRANCH. See
  -- the comment on that branch: mirroring it on a monthly agreement
  -- would invalidate every past delivery the moment a monthly customer
  -- changes quantity.
  select plan_type, status, instalment_count, contract_product_net_cents, quantity_packs
    into v_plan_type, v_status, v_instalment_count, v_contract_net_cents, v_quantity_packs
    from public.b2b_supply_agreements
   where id = p_agreement_id;

  -- The agreement is not there. Nothing to assert: both child tables
  -- reference it with ON DELETE RESTRICT, so it cannot have been deleted
  -- out from under surviving rows.
  if not found then
    return;
  end if;

  -- A legacy / negotiated agreement. 060 adds no rule to it, exactly as
  -- 059 added none.
  if v_plan_type is null then
    return;
  end if;

  select count(*), coalesce(min(instalment_number), 0), coalesce(max(instalment_number), 0),
         coalesce(sum(net_cents), 0)
    into v_pay_count, v_pay_min, v_pay_max, v_pay_sum
    from public.b2b_payment_schedule
   where supply_agreement_id = p_agreement_id;

  select count(*), coalesce(min(delivery_number), 0), coalesce(max(delivery_number), 0)
    into v_del_count, v_del_min, v_del_max
    from public.b2b_deliveries
   where supply_agreement_id = p_agreement_id;

  -- ── CONTIGUITY, WHATEVER THE STATUS. The unique indexes make the
  --    numbers distinct, so "starts at 1 and the largest is the count"
  --    is exactly "contiguous 1..count".
  if v_pay_count > 0 and (v_pay_min <> 1 or v_pay_max <> v_pay_count) then
    raise exception
      'b2b integrity: payment instalment numbers must be contiguous from 1 (agreement %, count %, min %, max %)',
      p_agreement_id, v_pay_count, v_pay_min, v_pay_max
      using errcode = 'check_violation';
  end if;

  if v_del_count > 0 and (v_del_min <> 1 or v_del_max <> v_del_count) then
    raise exception
      'b2b integrity: delivery numbers must be contiguous from 1 (agreement %, count %, min %, max %)',
      p_agreement_id, v_del_count, v_del_min, v_del_max
      using errcode = 'check_violation';
  end if;

  -- ── AND THE CARDINALITY RULES, WHICH ONLY BIND ONCE ACTIVE.
  if v_status <> 'active' then
    return;
  end if;

  if v_plan_type = 'monthly' then
    -- Stripe owns a monthly agreement's billing. A row here would be a
    -- second schedule for the same money.
    if v_pay_count <> 0 then
      raise exception
        'b2b integrity: an active monthly agreement has no payment schedule rows (agreement %, found %)',
        p_agreement_id, v_pay_count
        using errcode = 'check_violation';
    end if;
    -- Monthly deliveries roll: 0..n rows, already proved contiguous.
    return;
  end if;

  if v_plan_type = 'annual' then
    if v_pay_count <> v_instalment_count then
      raise exception
        'b2b integrity: an active annual agreement needs exactly % payment rows (agreement %, found %)',
        v_instalment_count, p_agreement_id, v_pay_count
        using errcode = 'check_violation';
    end if;

    if v_pay_sum is distinct from v_contract_net_cents::bigint then
      raise exception
        'b2b integrity: payment net sum % does not equal the frozen contract total % (agreement %)',
        v_pay_sum, v_contract_net_cents, p_agreement_id
        using errcode = 'check_violation';
    end if;

    -- ══════════════════════════════════════════════════════════
    -- AND THE SPLIT ITSELF, NOT MERELY ITS TOTAL
    -- ══════════════════════════════════════════════════════════
    --
    -- The sum is necessary and NOT sufficient. 53551 across four
    -- instalments sums correctly as 13387/13387/13387/13390 and equally
    -- correctly as 53548/1/1/1 - and only the first is the schedule the
    -- customer agreed to. So the allocation is asserted PER ROW against
    -- the Package 1 authority, lib/b2bPricingRules.ts allocateInstalments:
    --
    --   base = floor(T / n)
    --   instalments 1 .. n-1   base
    --   instalment  n          T - base * (n - 1)
    --
    -- THE REMAINDER LANDS ON THE LAST INSTALMENT, deliberately: the
    -- customer's FIRST payment is the one quoted on the page, and a
    -- first instalment two cents above the quoted figure is the one
    -- place it would be noticed.
    --
    -- PostgreSQL integer division truncates toward zero and T is
    -- positive, so `/` here is floor - the same operation Math.floor
    -- performs in the TypeScript. bigint throughout.
    --
    -- The guard before the division is not decoration: instalment_count
    -- is 059's column, and a NULL or zero reaching this line would be a
    -- division_by_zero ERROR rather than a named violation.
    if v_instalment_count is null or v_instalment_count <= 0
       or v_contract_net_cents is null then
      raise exception
        'b2b integrity: an active annual agreement needs an instalment count and a contract total (agreement %)',
        p_agreement_id
        using errcode = 'check_violation';
    end if;

    v_base_cents := v_contract_net_cents::bigint / v_instalment_count::bigint;

    select count(*)
      into v_alloc_mismatch
      from public.b2b_payment_schedule p
     where p.supply_agreement_id = p_agreement_id
       and p.net_cents::bigint is distinct from
           (case when p.instalment_number < v_instalment_count
                 then v_base_cents
                 else v_contract_net_cents::bigint
                        - v_base_cents * (v_instalment_count::bigint - 1)
            end);

    if v_alloc_mismatch > 0 then
      raise exception
        'b2b integrity: % instalment(s) do not match the canonical allocation of % across % (agreement %)',
        v_alloc_mismatch, v_contract_net_cents, v_instalment_count, p_agreement_id
        using errcode = 'check_violation';
    end if;

    -- Twelve deliveries, because 059 fixes delivery_count at 12 for
    -- every annual contract.
    if v_del_count <> 12 then
      raise exception
        'b2b integrity: an active annual agreement needs exactly 12 delivery rows (agreement %, found %)',
        p_agreement_id, v_del_count
        using errcode = 'check_violation';
    end if;

    -- ══════════════════════════════════════════════════════════
    -- AND FOR ANNUAL - AND ONLY ANNUAL - THE DELIVERIES CARRY THE
    -- CONTRACTED QUANTITY
    -- ══════════════════════════════════════════════════════════
    --
    -- This is the one place a delivery is compared against the
    -- agreement's CURRENT quantity, and it is sound here for a reason
    -- that does not hold anywhere else: 059's immutability guard FREEZES
    -- quantity_packs on an active annual agreement. The "current" value
    -- and the value every delivery was created under are therefore the
    -- same value, permanently, and a mismatch is a real defect rather
    -- than the trace of a legitimate change.
    --
    -- IT IS DELIBERATELY NOT APPLIED TO MONTHLY. A monthly customer may
    -- change quantity, 059 permits it, and the moment they do, every
    -- past delivery would fail this comparison - the transaction that
    -- changed the quantity would be refused by the history it is not
    -- allowed to rewrite. Monthly delivery rows stay what they were.
    select count(*)
      into v_del_qty_mismatch
      from public.b2b_deliveries d
     where d.supply_agreement_id = p_agreement_id
       and d.quantity_packs is distinct from v_quantity_packs;

    if v_del_qty_mismatch > 0 then
      raise exception
        'b2b integrity: % delivery row(s) do not carry the frozen annual quantity of % packs (agreement %)',
        v_del_qty_mismatch, v_quantity_packs, p_agreement_id
        using errcode = 'check_violation';
    end if;
  end if;
end;
$$;


-- ── THE TRIGGER WRAPPERS ──────────────────────────────────────
--
-- OLD and NEW are read ONLY inside the TG_OP branch that assigns them.
-- The nested `if tg_op = ...` shape is deliberate: plpgsql compiles a
-- condition into one SQL expression and PostgreSQL does not promise to
-- short-circuit AND, so `tg_op = 'UPDATE' and old.x <> new.x` would
-- evaluate OLD on INSERT and fail with "record old is not assigned yet".

create function public.b2b_supply_agreements_commerce_integrity_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.assert_b2b_commerce_integrity(new.id);
  return null;
end;
$$;

create function public.b2b_payment_schedule_integrity_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    perform public.assert_b2b_commerce_integrity(old.supply_agreement_id);
    return null;
  end if;

  -- A row moved between agreements leaves one as well as joining
  -- another, and the one it left may now have a gap in its numbering.
  if tg_op = 'UPDATE' then
    if old.supply_agreement_id is distinct from new.supply_agreement_id then
      perform public.assert_b2b_commerce_integrity(old.supply_agreement_id);
    end if;
  end if;

  perform public.assert_b2b_commerce_integrity(new.supply_agreement_id);
  return null;
end;
$$;

create function public.b2b_deliveries_integrity_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    perform public.assert_b2b_commerce_integrity(old.supply_agreement_id);
    return null;
  end if;

  if tg_op = 'UPDATE' then
    if old.supply_agreement_id is distinct from new.supply_agreement_id then
      perform public.assert_b2b_commerce_integrity(old.supply_agreement_id);
    end if;
  end if;

  perform public.assert_b2b_commerce_integrity(new.supply_agreement_id);
  return null;
end;
$$;

-- THE PARENT SIDE. A new constraint trigger on the 059/006 table - an
-- ADDITIVE creation, which changes nothing about the two triggers those
-- migrations already put there.
create constraint trigger b2b_supply_agreements_commerce_integrity
  after insert or update on public.b2b_supply_agreements
  deferrable initially deferred
  for each row
  execute function public.b2b_supply_agreements_commerce_integrity_trigger();

create constraint trigger b2b_payment_schedule_integrity
  after insert or update or delete on public.b2b_payment_schedule
  deferrable initially deferred
  for each row
  execute function public.b2b_payment_schedule_integrity_trigger();

create constraint trigger b2b_deliveries_integrity
  after insert or update or delete on public.b2b_deliveries
  deferrable initially deferred
  for each row
  execute function public.b2b_deliveries_integrity_trigger();

-- The house updated_at triggers, reusing 001's function.
create trigger set_b2b_payment_schedule_updated_at
  before update on public.b2b_payment_schedule
  for each row execute function public.set_updated_at();

create trigger set_b2b_deliveries_updated_at
  before update on public.b2b_deliveries
  for each row execute function public.set_updated_at();


-- ══════════════════════════════════════════════════════════════
-- 14. INDEXES
-- ══════════════════════════════════════════════════════════════
--
-- The two identity uniques, three partial correlation uniques, and one
-- worker index per table. Nothing else: an index is a poor place to
-- discover a rule nobody approved.
--
-- No ordinary index is created beside a UNIQUE on the same columns - the
-- unique index already serves every lookup an ordinary one would.

create unique index b2b_payment_schedule_agreement_instalment_key
  on public.b2b_payment_schedule (supply_agreement_id, instalment_number);

-- INDEPENDENT uniques. An instalment may carry either identifier, both,
-- or - while still merely scheduled - neither.
create unique index b2b_payment_schedule_stripe_invoice_id_key
  on public.b2b_payment_schedule (stripe_invoice_id)
  where stripe_invoice_id is not null;

create unique index b2b_payment_schedule_stripe_payment_intent_id_key
  on public.b2b_payment_schedule (stripe_payment_intent_id)
  where stripe_payment_intent_id is not null;

-- The sweep every billing worker starts from. Partial: paid and void are
-- terminal, and a worker never asks about them.
create index idx_b2b_payment_schedule_due
  on public.b2b_payment_schedule (status, due_at)
  where status in ('scheduled', 'invoiced', 'action_required', 'payment_failed');

create unique index b2b_deliveries_agreement_number_key
  on public.b2b_deliveries (supply_agreement_id, delivery_number);

create unique index b2b_deliveries_order_id_key
  on public.b2b_deliveries (order_id)
  where order_id is not null;

create unique index b2b_deliveries_stripe_invoice_id_key
  on public.b2b_deliveries (stripe_invoice_id)
  where stripe_invoice_id is not null;

-- The sweep every fulfilment worker starts from. Partial for the same
-- reason: delivered and cancelled are terminal.
create index idx_b2b_deliveries_scheduled
  on public.b2b_deliveries (status, scheduled_for)
  where status in ('scheduled', 'held');


-- ══════════════════════════════════════════════════════════════
-- 15. RLS AND PRIVILEGES
-- ══════════════════════════════════════════════════════════════
--
-- READ-ONLY FOR EVERYBODY, INCLUDING service_role.
--
-- Package 4B is a foundation: nothing writes these tables yet, so
-- nothing needs a write privilege yet. Package 5 brings the trusted
-- write surface and grants exactly the privileges that surface needs, at
-- the same time and in the same review. A write grant issued now would
-- be a capability with no caller and no reviewer.
--
-- REVOKE FIRST, then grant back the one privilege that is wanted. A
-- freshly created table can pick up privileges from DEFAULT PRIVILEGES
-- that nobody wrote down, and revoking only what is expected to be there
-- leaves whatever was not expected.
--
-- anon gets nothing at all - not even SELECT. A supply agreement is a
-- commercial contract between GLOA and a named business.
--
-- 059's and 006's own policies and grants are NOT touched.

alter table public.b2b_payment_schedule enable row level security;
alter table public.b2b_deliveries       enable row level security;

-- Own rows only, through the parent agreement, and only for a business
-- profile. Both halves matter: the parent join is the ownership, and
-- is_business_user() is the same second gate 006 put on the agreement.
create policy "Business users read own payment schedule"
  on public.b2b_payment_schedule for select
  using (
    exists (
      select 1 from public.b2b_supply_agreements a
      where a.id = b2b_payment_schedule.supply_agreement_id
        and a.user_id = auth.uid()
    )
    and public.is_business_user()
  );

create policy "Business users read own deliveries"
  on public.b2b_deliveries for select
  using (
    exists (
      select 1 from public.b2b_supply_agreements a
      where a.id = b2b_deliveries.supply_agreement_id
        and a.user_id = auth.uid()
    )
    and public.is_business_user()
  );

-- No INSERT, UPDATE or DELETE policy exists for any role. Without a
-- policy, RLS refuses the statement outright - and the privileges below
-- refuse it before RLS is even consulted.

revoke all privileges on table public.b2b_payment_schedule from public;
revoke all privileges on table public.b2b_payment_schedule from anon;
revoke all privileges on table public.b2b_payment_schedule from authenticated;
revoke all privileges on table public.b2b_payment_schedule from service_role;

revoke all privileges on table public.b2b_deliveries from public;
revoke all privileges on table public.b2b_deliveries from anon;
revoke all privileges on table public.b2b_deliveries from authenticated;
revoke all privileges on table public.b2b_deliveries from service_role;

grant select on table public.b2b_payment_schedule to authenticated;
grant select on table public.b2b_deliveries       to authenticated;

grant select on table public.b2b_payment_schedule to service_role;
grant select on table public.b2b_deliveries       to service_role;


-- ══════════════════════════════════════════════════════════════
-- 16. FUNCTION PRIVILEGES
-- ══════════════════════════════════════════════════════════════
--
-- Seven functions, none of them callable by anybody.
--
-- REVOKE FROM public FIRST: a freshly created function is executable by
-- PUBLIC by default and anon and authenticated inherit that, so revoking
-- only the named roles would leave every guard below reachable from a
-- browser holding nothing but an anon key.
--
-- Then service_role too, and NOTHING is granted back. PostgreSQL does
-- not check EXECUTE when firing a trigger - it checks TRIGGER on the
-- table at creation time - so these still fire on every statement while
-- being invocable by nobody but their owner. No browser-reachable
-- surface, and no commerce writer RPC.

revoke all on function public.assert_b2b_commerce_integrity(uuid) from public;
revoke all on function public.assert_b2b_commerce_integrity(uuid) from anon;
revoke all on function public.assert_b2b_commerce_integrity(uuid) from authenticated;
revoke all on function public.assert_b2b_commerce_integrity(uuid) from service_role;

revoke all on function public.b2b_supply_agreements_commerce_integrity_trigger() from public;
revoke all on function public.b2b_supply_agreements_commerce_integrity_trigger() from anon;
revoke all on function public.b2b_supply_agreements_commerce_integrity_trigger() from authenticated;
revoke all on function public.b2b_supply_agreements_commerce_integrity_trigger() from service_role;

revoke all on function public.b2b_payment_schedule_integrity_trigger() from public;
revoke all on function public.b2b_payment_schedule_integrity_trigger() from anon;
revoke all on function public.b2b_payment_schedule_integrity_trigger() from authenticated;
revoke all on function public.b2b_payment_schedule_integrity_trigger() from service_role;

revoke all on function public.b2b_deliveries_integrity_trigger() from public;
revoke all on function public.b2b_deliveries_integrity_trigger() from anon;
revoke all on function public.b2b_deliveries_integrity_trigger() from authenticated;
revoke all on function public.b2b_deliveries_integrity_trigger() from service_role;

revoke all on function public.b2b_payment_schedule_transition_guard() from public;
revoke all on function public.b2b_payment_schedule_transition_guard() from anon;
revoke all on function public.b2b_payment_schedule_transition_guard() from authenticated;
revoke all on function public.b2b_payment_schedule_transition_guard() from service_role;

revoke all on function public.b2b_deliveries_transition_guard() from public;
revoke all on function public.b2b_deliveries_transition_guard() from anon;
revoke all on function public.b2b_deliveries_transition_guard() from authenticated;
revoke all on function public.b2b_deliveries_transition_guard() from service_role;

revoke all on function public.b2b_deliveries_resolution_freeze_guard() from public;
revoke all on function public.b2b_deliveries_resolution_freeze_guard() from anon;
revoke all on function public.b2b_deliveries_resolution_freeze_guard() from authenticated;
revoke all on function public.b2b_deliveries_resolution_freeze_guard() from service_role;

commit;

-- ══════════════════════════════════════════════════════════════
-- VERIFYING THIS MIGRATION, read-only. Nothing below is executed by
-- this file; it is the query set a reviewer runs afterwards.
--
--   1. EXACTLY TWO NEW TABLES, AND THEIR FOREIGN KEYS DO NOT CASCADE:
--        select c.conrelid::regclass as child, c.confdeltype
--        from pg_constraint c
--        where c.contype = 'f'
--          and c.conrelid in ('public.b2b_payment_schedule'::regclass,
--                             'public.b2b_deliveries'::regclass)
--          and c.confrelid = 'public.b2b_supply_agreements'::regclass;
--      -> confdeltype = 'r' (RESTRICT) on both. NEVER 'c'.
--
--   2. NEITHER CHILD COPIES A PARENT AUTHORITY:
--        select table_name, column_name from information_schema.columns
--        where table_schema = 'public'
--          and table_name in ('b2b_payment_schedule','b2b_deliveries')
--          and column_name in ('instalment_count','plan_type','address_id',
--                              'pack_net_cents','contract_product_net_cents');
--      -> zero rows.
--
--   3. THE TAX LIFECYCLE, AS INSTALLED:
--        select conname, pg_get_constraintdef(oid) from pg_constraint
--        where conrelid = 'public.b2b_payment_schedule'::regclass and contype = 'c'
--        order by conname;
--      -> the closed world (7, de-net-2026.1, net), both gross rules,
--         and the established-once-invoiced rule.
--
--   4. THE SEVEN FUNCTIONS ARE DEFINER, PINNED AND UNREACHABLE:
--        select p.proname, p.prosecdef, p.proconfig, p.proacl
--        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--        where n.nspname = 'public' and p.proname like 'b2b_%trigger'
--           or p.proname in ('assert_b2b_commerce_integrity',
--                            'b2b_payment_schedule_transition_guard',
--                            'b2b_deliveries_transition_guard',
--                            'b2b_deliveries_resolution_freeze_guard');
--      -> prosecdef true, proconfig contains search_path=, and proacl
--         grants EXECUTE to NOBODY. Asked directly:
--           select has_function_privilege('anon',
--             'public.assert_b2b_commerce_integrity(uuid)', 'execute');
--         -> false, and the same for authenticated and service_role.
--
--   5. WHICH TRIGGERS ARE DEFERRED AND WHICH ARE NOT:
--        select tgrelid::regclass, tgname, tgdeferrable, tginitdeferred
--        from pg_trigger
--        where tgrelid in ('public.b2b_supply_agreements'::regclass,
--                          'public.b2b_payment_schedule'::regclass,
--                          'public.b2b_deliveries'::regclass)
--          and not tgisinternal order by 1, 2;
--      -> the three *_integrity triggers deferrable + initdeferred
--      -> the transition and freeze guards NOT deferrable
--      -> 059's and 006's triggers present and untouched.
--
--   6. PRIVILEGES ARE READ-ONLY, AND anon HAS NONE:
--        select grantee, privilege_type from information_schema.role_table_grants
--        where table_schema = 'public'
--          and table_name in ('b2b_payment_schedule','b2b_deliveries')
--        order by table_name, grantee;
--      -> SELECT for authenticated and service_role. No anon row at all.
--         No INSERT, UPDATE or DELETE for anybody.
--
--   7. AND THE STATE CASES, on a SCRATCH database only - these are
--      INSERTs and UPDATEs and have no business on Production:
--        paid -> invoiced                               -> rejected
--        void -> paid                                   -> rejected
--        status='invoiced' with no tax facts            -> rejected
--        gross_cents one cent off addTaxToNet           -> rejected
--        an active monthly agreement with a payment row -> rejected at COMMIT
--        an active annual agreement with 11 deliveries  -> rejected at COMMIT
--        payment net sum one cent off the contract      -> rejected at COMMIT
--        resolving a slot in one UPDATE                 -> ACCEPTED
--        changing shipping_snapshot after resolution    -> rejected
--        a shipping_snapshot with chargeStatus
--          'measurement_required'                       -> rejected
--        berlin snapshot '{}' or partial                -> rejected
-- ══════════════════════════════════════════════════════════════
