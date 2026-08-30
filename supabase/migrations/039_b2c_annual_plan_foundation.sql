-- ============================================================
-- GLOA - B2C prepaid annual plan foundation (Phase 4B1)
-- Run in Supabase SQL Editor AFTER 038
--
-- The database half of the B2C PREPAID annual plan. It creates NO Stripe
-- object, prices NO plan, handles NO webhook, sends NO email and creates
-- NO order. What it establishes is the part that has to be right before
-- any of that can be built safely.
--
-- ── WHAT AN ANNUAL PLAN IS, AND WHAT IT IS NOT ────────────────
--
-- ONE upfront Stripe payment. THIRTEEN physical deliveries, 28 days
-- apart, delivery 1 on the purchase date and delivery 13 at purchase +
-- 336 days. No automatic renewal. No recurring Stripe charge. A card
-- that dies in month seven has no effect on deliveries eight to
-- thirteen, because after the single PaymentIntent succeeds Stripe holds
-- no further obligation and every remaining delivery is driven from
-- durable local state alone.
--
-- It is therefore NOT a Stripe Subscription, and it deliberately does
-- NOT reuse public.subscriptions:
--
--   * subscriptions.status is driven by customer.subscription.* events
--     that will never arrive for a plan with no Stripe subscription id.
--   * subscriptions.total_gross_cents means PER CYCLE - the account UI
--     renders it as "Pro Lieferung". An annual plan's total is the whole
--     prepayment, and storing 35087 there would misrender immediately.
--   * migration 034's cancellation machinery assumes a live Stripe
--     subscription that can be told cancel_at. There is nothing to tell.
--   * migration 024's b2c_plans_active_variant_cadence_key forbids a
--     second active plan on the same variant and cadence, so annual
--     plans cannot be seeded into b2c_subscription_plans either.
--
-- Reusing that table would corrupt its semantics in four places. A
-- dedicated parent is not duplication; it is the only honest option.
--
-- ── THE LIFECYCLE THIS ENCODES ────────────────────────────────
--
--   1. An authenticated server route prices the plan completely from the
--      catalog, the frozen annual discount, the annual shipping rule and
--      the existing tax calculation, writes ONE payment checkout attempt
--      (the existing idempotency anchor), and calls
--      create_pending_annual_plan_for_attempt. The parent row exists,
--      frozen, in status 'pending' BEFORE Stripe is ever contacted -
--      Model A, exactly as migration 022 established for subscriptions.
--      That is what lets a later Stripe event resolve against trusted
--      local data instead of against a webhook payload.
--
--   2. checkout.session.completed verifies the payment against the
--      attempt's frozen expected total (the existing
--      evaluateStripeSessionPayment path, unchanged) and calls
--      activate_annual_plan_from_payment. That, and only that, moves
--      'pending' to 'active', records the PaymentIntent, and creates
--      exactly 13 annual_plan_deliveries in one transaction.
--
--   3. The daily Vercel cron claims due deliveries, and each claimed
--      delivery is fulfilled by ONE call to fulfill_annual_plan_delivery.
--      That single transaction locks the parent, re-proves it is still
--      deliverable, creates the delivery's OWN synthetic paid checkout
--      attempt, calls the existing create_order_from_paid_checkout
--      (migration 021) unchanged, and records the resulting order on the
--      delivery row. The tax snapshot, the shipping snapshot, the order
--      number, the order items, the shipment flow and the four email
--      state machines are all reused rather than reimplemented.
--
--      IT IS ONE TRANSACTION ON PURPOSE. Phase 4B1.1 replaced a
--      three-call composition - prepare, then create the order, then
--      mark fulfilled - because the parent lock was released between the
--      guard and the order. A full refund committing in that window
--      would have produced a physical order for a plan that was no
--      longer deliverable. See section 9.
--
-- ── THE PAYMENT AND THE DELIVERIES ARE DIFFERENT THINGS ───────
--
-- This is the single most important correctness decision in this file,
-- and it is enforced by a CHECK rather than by convention.
--
-- The annual Stripe PaymentIntent belongs uniquely to ONE annual_plans
-- row and to nothing else. It must never reach a delivery order, because
-- migration 038's apply_order_refund_state resolves a refund by counting
-- orders that carry the payment intent and returns 'ambiguous_payment_
-- intent' the moment there is more than one. Thirteen delivery orders
-- sharing one PaymentIntent would make every refund for that payment
-- permanently unrecordable - the exact failure mode 038 documents
-- against 41 live rows.
--
-- So the payment attempt and the thirteen delivery attempts are disjoint
-- populations, and checkout_attempts_annual_delivery_no_stripe_payment_
-- check below makes it impossible for a synthetic delivery attempt to
-- carry a payment intent, an invoice id, a session id or a subscription
-- id at all. Delivery 1 is NOT an exception: it gets its own synthetic
-- attempt like every other delivery, because "the first one is special"
-- is precisely how a shared payment intent would leak in.
--
-- Annual refunds correlate to the PARENT instead, through
-- apply_annual_plan_refund_state in section 11, resolved by the unique
-- PaymentIntent on public.annual_plans and by nothing else.
--
-- ── WHAT THIS MIGRATION DELIBERATELY DOES NOT DO ──────────────
--
-- It applies no data change. It creates no order. It writes no status
-- 'completed' and no status 'cancelled': those transitions belong to the
-- completion rule and the administrative termination boundary, both of
-- which are later phases, and inventing them here would mean inventing
-- the commercial decisions behind them. It defines no endpoint, no
-- secret and no feature flag - B2C_ANNUAL_PLAN_ENABLED is application
-- configuration and stays OFF until the phase that reads it exists.
--
-- It does not touch lib/shipping.ts's 4900-cent German free-shipping
-- threshold, and it does not derive annual free shipping from it. The
-- annual shipping amount is a per-plan frozen integer supplied by the
-- server, which is what makes 50 g and 100 g free shipping an explicit
-- annual-plan benefit rather than a coincidence of a threshold that
-- could later move.
--
-- Migrations 001 through 038 are LIVE and IMMUTABLE and none is touched,
-- re-run, re-declared or weakened here. In particular 037 and 038 keep
-- their refund writers exactly as applied. 039 IS THE NEXT FREE NUMBER.
--
-- RUN THIS FILE AS ONE EXECUTION. Sections depend on each other: paste
-- the whole file into the SQL Editor and run it once, or wrap it in an
-- explicit begin; ... commit;. Do not run sections separately and do not
-- use "run selection".
-- ============================================================


-- 1. THE PARENT: ONE PREPAID PURCHASE ──────────────────────────
--
-- One row per annual plan, holding the entire frozen contract. Every
-- commercial fact a delivery will ever need is here, so no delivery
-- generated in month nine has to re-read a catalog price that may have
-- changed in month three.
--
-- ── WHY THERE ARE THREE FROZEN SNAPSHOTS AND NOT ONE ──────────
--
-- tax_snapshot describes the ANNUAL TRANSACTION: what Stripe charged,
-- once. delivery_tax_snapshot and delivery_items_snapshot describe ONE
-- DELIVERY, and they exist because migration 021's
-- create_order_from_paid_checkout validates a paid attempt's tax
-- snapshot against that attempt's own shipping and expected total:
--
--     if (v_totals->>'shippingGrossCents')::integer
--          is distinct from p_shipping_gross_cents  -> raise
--     if (v_totals->>'totalGrossCents')::integer
--          is distinct from v_attempt.expected_total_gross_cents -> raise
--
-- A delivery attempt therefore needs a tax snapshot for ONE delivery,
-- and the annual snapshot cannot serve: its totals are thirteen times
-- larger. The alternative would be re-deriving per-delivery VAT in
-- PL/pgSQL, which means reimplementing lib/tax.ts's category resolution,
-- shipping apportionment and round-half-up arithmetic in a second
-- language, where it would silently drift. Freezing the per-delivery
-- document at purchase, computed once by the code that owns tax, is
-- strictly safer and is what the CHECKs below then verify.
--
-- ── DISCOUNT ARITHMETIC IS NOT PERFORMED HERE ─────────────────
--
-- discount_percent_applied is numeric, not floating point, and it is
-- RECORDED rather than used: the frozen integer cents are the truth.
-- There is deliberately no CHECK asserting
-- annual_unit = round(catalog_unit * (100 - percent) / 100), because
-- that would write a rounding law into the schema for products that do
-- not exist yet. The invariant that IS asserted is the one that is
-- always true: an annual unit is positive and never above catalog.

create table public.annual_plans (
  id                          uuid primary key default gen_random_uuid(),

  -- A prepaid plan belongs to a person. There is no guest path: the
  -- customer has to be reachable for twelve months of deliveries, so
  -- unlike the one-time flow this is NOT NULL and NOT "on delete set
  -- null" - a paid annual contract must not be able to lose its owner.
  user_id                     uuid not null references auth.users(id),

  -- THE IDEMPOTENCY ANCHOR, and the reason a retry cannot mint a second
  -- plan. One payment attempt, at most one annual plan. This is the
  -- PAYMENT attempt; it is never one of the thirteen delivery attempts,
  -- and section 3's paired CHECK makes that structural.
  payment_checkout_attempt_id uuid not null unique
                              references public.checkout_attempts(id),

  stripe_checkout_session_id  text,
  -- THE UNIQUE ANNUAL PAYMENT. Section 11's refund writer resolves by
  -- this column alone, which is only safe because it is unique.
  stripe_payment_intent_id    text,

  -- What is delivered. A real foreign key rather than a SKU string, for
  -- migration 024's reason: a renamed identifier must not be able to
  -- silently repoint a paid contract at a different product.
  variant_id                  uuid not null references public.product_variants(id),

  currency                    text not null default 'EUR'
                              check (currency = 'EUR'),

  -- ── LIFECYCLE, AND ONLY LIFECYCLE ─────────────────────────
  --
  -- Four values, and no refund word among them. Refund state is money
  -- state and lives in payment_status below; mixing the two would mean a
  -- partially refunded plan had to stop being 'active', which is false -
  -- it is still running and still owes deliveries.
  --
  -- 039 writes 'pending' and 'active' and nothing else. 'completed' and
  -- 'cancelled' are declared here so the vocabulary is fixed and
  -- reviewed, and are written by later phases that own the completion
  -- rule and the administrative termination boundary.
  status                      text not null default 'pending'
                              check (status in (
                                'pending', 'active', 'completed', 'cancelled'
                              )),

  -- ── MONEY STATE, SEPARATE ─────────────────────────────────
  --
  -- 'refund_pending' is deliberately NOT here. public.orders has it
  -- because a one-time order can sit between a requested and a settled
  -- refund; the parent of a prepaid plan has no such customer-facing
  -- state and no feature that would produce one, and adding a fifth
  -- value nobody asked for would be inventing a lifecycle.
  payment_status              text not null default 'pending'
                              check (payment_status in (
                                'pending', 'paid', 'partially_refunded', 'refunded'
                              )),

  -- ── MONEY, INTEGER CENTS, NO FLOATING POINT ANYWHERE ──────
  catalog_unit_gross_cents            integer not null
                                      check (catalog_unit_gross_cents > 0),
  annual_unit_gross_cents             integer not null
                                      check (annual_unit_gross_cents > 0),
  shipping_per_delivery_gross_cents   integer not null
                                      check (shipping_per_delivery_gross_cents >= 0),

  -- Thirteen. Stored so every derived total is arithmetic against a
  -- column rather than against a constant repeated in six places, and
  -- pinned by a CHECK so it can never become anything else.
  delivery_count                      integer not null default 13
                                      check (delivery_count = 13),

  merchandise_total_gross_cents       integer not null
                                      check (merchandise_total_gross_cents > 0),
  shipping_total_gross_cents          integer not null
                                      check (shipping_total_gross_cents >= 0),
  total_gross_cents                   integer not null
                                      check (total_gross_cents > 0),

  refunded_total_cents                integer not null default 0
                                      check (refunded_total_cents >= 0),

  discount_percent_applied            numeric(5,2) not null
                                      check (discount_percent_applied > 0
                                         and discount_percent_applied <= 100),

  -- ── FROZEN AT PURCHASE, REQUIRED FROM CREATION ────────────
  --
  -- NOT NULL rather than "required before activation", because all of
  -- them are computed before Stripe is contacted at all. A plan that
  -- cannot be taxed cannot be sold, which is the same stricter rule
  -- migration 022 applies to subscriptions.
  customer_snapshot           jsonb not null,
  shipping_address_snapshot   jsonb not null,
  billing_address_snapshot    jsonb not null,
  tax_snapshot                jsonb not null,
  delivery_items_snapshot     jsonb not null,
  delivery_tax_snapshot       jsonb not null,

  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  purchased_at                timestamptz,
  plan_end_at                 timestamptz,
  completed_at                timestamptz,
  cancelled_at                timestamptz,
  refund_updated_at           timestamptz,

  -- ── THE ANNUAL PURCHASE CONFIRMATION'S DURABLE STATE ──────
  --
  -- On the parent, in the shape migration 017 established for orders,
  -- rather than in a second deliveries table. There is exactly one such
  -- message per plan, so a table keyed on (subject, family, occurrence)
  -- would carry a family column with one value and an event key with one
  -- value. NULL means the row never entered the email flow, which is
  -- what every plan created before the sender exists will read as - and
  -- it is why the retry sweep selects 'failed' and never NULL.
  purchase_confirmation_email_status   text
                                       check (purchase_confirmation_email_status is null
                                          or purchase_confirmation_email_status in (
                                            'sending', 'sent', 'failed'
                                          )),
  purchase_confirmation_email_sent_at  timestamptz,

  -- ── THE MONEY IDENTITIES ──────────────────────────────────
  --
  -- Every total is the product of a per-delivery integer and the
  -- delivery count, so no total can drift from the unit price it was
  -- built from and no total can be supplied independently.
  constraint annual_plans_merchandise_total_check
    check (merchandise_total_gross_cents = annual_unit_gross_cents * delivery_count),
  constraint annual_plans_shipping_total_check
    check (shipping_total_gross_cents = shipping_per_delivery_gross_cents * delivery_count),
  constraint annual_plans_total_check
    check (total_gross_cents = merchandise_total_gross_cents + shipping_total_gross_cents),
  constraint annual_plans_discount_not_above_catalog_check
    check (annual_unit_gross_cents <= catalog_unit_gross_cents),

  -- ── THE REFUND RANGE, AND THE STATE IT IMPLIES ────────────
  --
  -- The range guard migration 019 gave orders, plus the biconditional
  -- 019 could not express there: each payment_status names exactly one
  -- band of refunded_total_cents. Section 11's writer therefore cannot
  -- record a total and a status that disagree even if its own arithmetic
  -- were wrong.
  constraint annual_plans_refunded_total_range_check
    check (refunded_total_cents <= total_gross_cents),
  constraint annual_plans_refund_state_check
    check (
      case payment_status
        when 'pending'            then refunded_total_cents = 0
        when 'paid'               then refunded_total_cents = 0
        when 'partially_refunded' then refunded_total_cents > 0
                                   and refunded_total_cents < total_gross_cents
        when 'refunded'           then refunded_total_cents = total_gross_cents
      end
    ),

  -- ── LIFECYCLE COHERENCE ───────────────────────────────────
  --
  -- A running or finished plan has a purchase date, an end date and
  -- proof of payment. Nothing here forbids a future phase from
  -- cancelling a plan that never got past 'pending' - that is a real
  -- case (an abandoned checkout) and boxing it out now would force a
  -- later migration to loosen a constraint.
  constraint annual_plans_purchase_dates_paired_check
    check ((purchased_at is null) = (plan_end_at is null)),
  constraint annual_plans_running_requires_purchase_check
    check (status not in ('active', 'completed')
        or (purchased_at is not null
            and plan_end_at is not null
            and payment_status <> 'pending'
            and stripe_payment_intent_id is not null)),
  -- BICONDITIONAL, not one-way. A terminal status and its timestamp are
  -- the same fact recorded twice, so neither may exist without the
  -- other: a 'completed' row with no completed_at would have no answer
  -- to "when", and a completed_at on an active row would claim an event
  -- that has not happened. status is NOT NULL, so neither side of these
  -- can be NULL and the equality is always a real decision.
  constraint annual_plans_completed_at_check
    check ((completed_at is not null) = (status = 'completed')),
  constraint annual_plans_cancelled_at_check
    check ((cancelled_at is not null) = (status = 'cancelled')),

  -- ── THE FROZEN PER-DELIVERY DOCUMENTS MUST AGREE ──────────
  --
  -- is not distinct from, never =, so a snapshot MISSING the key fails
  -- closed instead of passing on a NULL comparison. This is what makes
  -- migration 021's two raise-conditions unreachable for an annual
  -- delivery: the numbers were proved to agree at purchase.
  constraint annual_plans_delivery_items_shape_check
    check (jsonb_typeof(delivery_items_snapshot) = 'array'
       and jsonb_array_length(delivery_items_snapshot) = 1),
  constraint annual_plans_delivery_item_unit_check
    check ((delivery_items_snapshot->0->>'unitGrossCents')::integer
             is not distinct from annual_unit_gross_cents),
  constraint annual_plans_delivery_item_quantity_check
    check ((delivery_items_snapshot->0->>'quantity')::integer
             is not distinct from 1),
  constraint annual_plans_delivery_item_line_check
    check ((delivery_items_snapshot->0->>'lineGrossCents')::integer
             is not distinct from annual_unit_gross_cents),
  constraint annual_plans_delivery_tax_shipping_check
    check ((delivery_tax_snapshot->'totals'->>'shippingGrossCents')::integer
             is not distinct from shipping_per_delivery_gross_cents),
  constraint annual_plans_delivery_tax_total_check
    check ((delivery_tax_snapshot->'totals'->>'totalGrossCents')::integer
             is not distinct from annual_unit_gross_cents + shipping_per_delivery_gross_cents),
  constraint annual_plans_annual_tax_total_check
    check ((tax_snapshot->'totals'->>'totalGrossCents')::integer
             is not distinct from total_gross_cents),

  -- ── THE EMAIL BICONDITIONAL ───────────────────────────────
  --
  -- sent_at is set if and only if the status is 'sent'. Migration 035's
  -- rule, restated for a nullable column: a NULL status is "never
  -- entered the flow" and must not carry a timestamp.
  constraint annual_plans_purchase_email_sent_at_check
    check ((purchase_confirmation_email_sent_at is not null)
             = (purchase_confirmation_email_status is not distinct from 'sent'))
);

-- The two Stripe identities are unique where present. Partial, because
-- a 'pending' plan legitimately holds neither and NULLs must not be
-- forced to collide. This is the same shape as
-- subscriptions_stripe_subscription_id_key (022) and
-- orders_stripe_checkout_session_id_key (011).
create unique index annual_plans_stripe_checkout_session_id_key
  on public.annual_plans (stripe_checkout_session_id)
  where stripe_checkout_session_id is not null;

create unique index annual_plans_stripe_payment_intent_id_key
  on public.annual_plans (stripe_payment_intent_id)
  where stripe_payment_intent_id is not null;

create index idx_annual_plans_user   on public.annual_plans (user_id);
create index idx_annual_plans_status on public.annual_plans (status);

create trigger set_annual_plans_updated_at
  before update on public.annual_plans
  for each row execute function public.set_updated_at();


-- 2. THE THIRTEEN PLANNED DELIVERIES ───────────────────────────
--
-- One durable row per planned delivery, created at activation. NOT
-- thirteen orders: migration 028's authorized shipment transition makes
-- any order with payment_status = 'paid' shippable, and public.orders
-- has no 'scheduled' state in either status or fulfillment_status, so
-- thirteen paid orders on day one would all appear shippable at once in
-- the internal fulfillment flow. A schedule row is not an order and
-- cannot be mistaken for one.
--
-- The order arrives later, when the delivery is due, minted by the
-- existing create_order_from_paid_checkout from this row's own synthetic
-- attempt.

create table public.annual_plan_deliveries (
  id                  uuid primary key default gen_random_uuid(),

  -- No cascade. A delivery is evidence of what was owed and what was
  -- shipped, and nothing in this codebase deletes an annual plan; a
  -- cascade would quietly make deletion look survivable.
  annual_plan_id      uuid not null references public.annual_plans(id),

  delivery_number     integer not null
                      check (delivery_number between 1 and 13),

  -- Frozen at activation for all thirteen at once, never derived as
  -- "previous + 28 days" at run time. That is what makes a missed cron
  -- run self-correcting: a late run generates the deliveries that are
  -- due and shifts no later date.
  scheduled_for       timestamptz not null,

  state               text not null default 'scheduled'
                      check (state in ('scheduled', 'claimed', 'fulfilled', 'cancelled')),

  -- The synthetic paid attempt this delivery was prepared into, and the
  -- order that attempt produced. Both unique where present: one delivery
  -- has at most one attempt and at most one order, and the same value
  -- can never be claimed by two deliveries.
  checkout_attempt_id uuid references public.checkout_attempts(id),
  order_id            uuid references public.orders(id),

  claimed_at          timestamptz,
  fulfilled_at        timestamptz,

  created_at          timestamptz not null default now(),

  -- THE DUPLICATE-GENERATION GUARD. Thirteen, never fourteen, and it is
  -- a database guarantee rather than a select-then-insert. The
  -- activation function's insert relies on it directly.
  constraint annual_plan_deliveries_plan_number_key
    unique (annual_plan_id, delivery_number),

  -- A fulfilled delivery has an order and a timestamp; an unfulfilled
  -- one has neither. Section 10's stale-claim recovery reads exactly
  -- these two facts, so they must not be able to disagree with state.
  constraint annual_plan_deliveries_fulfilled_check
    check ((state = 'fulfilled')
             = (order_id is not null and fulfilled_at is not null)),
  -- A row that reached 'claimed' or 'fulfilled' was claimed at some
  -- point, and the lease in section 8 reads that timestamp. 'cancelled'
  -- is deliberately outside the predicate: a later phase may need to
  -- cancel a delivery that was never claimed, and boxing that out now
  -- would force a migration to loosen a constraint.
  constraint annual_plan_deliveries_claimed_at_check
    check (state not in ('claimed', 'fulfilled') or claimed_at is not null)
);

create unique index annual_plan_deliveries_checkout_attempt_id_key
  on public.annual_plan_deliveries (checkout_attempt_id)
  where checkout_attempt_id is not null;

create unique index annual_plan_deliveries_order_id_key
  on public.annual_plan_deliveries (order_id)
  where order_id is not null;

-- The claim function's work list, in the order it reads it.
create index idx_annual_plan_deliveries_due
  on public.annual_plan_deliveries (state, scheduled_for);

create index idx_annual_plan_deliveries_plan
  on public.annual_plan_deliveries (annual_plan_id);


-- 3. THE CHECKOUT ATTEMPT LINK ─────────────────────────────────
--
-- ── INSERTION ORDER, AND WHY THERE IS NO CYCLE ────────────────
--
-- public.annual_plans references public.checkout_attempts, and
-- public.checkout_attempts now references public.annual_plans. That is a
-- cycle in the SCHEMA and it must not become a cycle in any INSERT
-- sequence. It does not, because the two directions are never used by
-- the same row:
--
--   step 1  the PAYMENT attempt is inserted with annual_plan_id NULL and
--           annual_delivery_number NULL. It references nothing.
--   step 2  the pending annual plan is inserted, referencing that
--           attempt. Its target already exists.
--   step 3  months later, a SYNTHETIC DELIVERY attempt is inserted with
--           annual_plan_id set. Its target already exists too.
--
-- No row ever needs a value that does not exist yet, so no deferred
-- constraint, no nullable-then-update dance and no ordering trick is
-- required. The paired CHECK below is what keeps it that way: it makes
-- annual_plan_id present exactly when annual_delivery_number is, so a
-- payment attempt can never acquire a back-reference and the two
-- populations stay disjoint by construction.
--
-- Nullable, no default, no backfill. Every attempt written before this
-- migration is a one-time or subscription attempt with no annual
-- delivery to describe, and NULL means exactly that.

alter table public.checkout_attempts
  add column annual_plan_id uuid references public.annual_plans(id),
  add column annual_delivery_number integer;

alter table public.checkout_attempts
  add constraint checkout_attempts_annual_delivery_paired_check
  check (
    (annual_plan_id is null and annual_delivery_number is null)
    or (annual_plan_id is not null and annual_delivery_number between 1 and 13)
  );

-- ONE FULFILLMENT ATTEMPT PER ANNUAL DELIVERY. Composed with
-- orders_checkout_attempt_id_key (011), which allows one order per
-- attempt, this makes "thirteen orders, never fourteen" a guarantee two
-- unique indexes hold jointly - the same construction migration 022 and
-- lib/subscriptionInvoiceFulfillment.ts rely on for renewals.
create unique index checkout_attempts_annual_delivery_key
  on public.checkout_attempts (annual_plan_id, annual_delivery_number)
  where annual_plan_id is not null and annual_delivery_number is not null;

-- ── THE ANNUAL PAYMENT IDENTITY NEVER REACHES A DELIVERY ──────
--
-- Stated as a constraint rather than trusted to the function in section
-- 9, because this is the invariant the whole refund architecture rests
-- on. A synthetic delivery attempt carries no payment intent, no
-- invoice, no checkout session and no subscription:
--
--   payment intent   would make migration 038's
--                    apply_order_refund_state count thirteen orders for
--                    one intent and answer 'ambiguous_payment_intent'
--                    forever, so the refund would never land anywhere.
--   invoice id       would enter migration 037's subscription
--                    correlation, which is for renewals and would
--                    attach an annual delivery to the wrong writer.
--   session id       would collide with
--                    orders_stripe_checkout_session_id_key (011) on the
--                    second delivery, since one session paid all of
--                    them.
--   subscription id  an annual plan is not a subscription and must
--                    never resolve as one.
--
-- The delivery order is correlated to its plan through this table -
-- checkout_attempts.annual_plan_id - and public.orders gains no annual
-- column at all. That keeps one place to disagree instead of two, and it
-- matters practically: app/AccountPortal.tsx reads orders with
-- select("*"), so any column added there is shipped to the browser the
-- moment it exists.

alter table public.checkout_attempts
  add constraint checkout_attempts_annual_delivery_no_stripe_payment_check
  check (
    annual_plan_id is null
    or (stripe_payment_intent_id is null
        and stripe_invoice_id is null
        and stripe_checkout_session_id is null
        and subscription_id is null)
  );


-- 4. ROW LEVEL SECURITY ────────────────────────────────────────
--
-- Read-only for the customer, and only their own rows. There is no
-- INSERT, UPDATE or DELETE policy for any client role, because there is
-- no client write path: every write in this file happens inside a
-- SECURITY DEFINER function called by the server.
--
-- The predicate is ownership and nothing else. public.subscriptions adds
-- "and not public.is_business_user()" because the ABOS navigation is
-- B2C-only; that is deliberately NOT copied here. An annual plan is a
-- paid contract, and a customer whose account type changes later must
-- not stop being able to see a purchase they made and are still owed
-- deliveries against.

alter table public.annual_plans           enable row level security;
alter table public.annual_plan_deliveries enable row level security;

create policy "Users read own annual plans"
  on public.annual_plans for select
  using (auth.uid() = user_id);

-- Ownership is inherited, never duplicated. Copying user_id onto the
-- delivery row would be a second place for it to disagree with the
-- parent, and a delivery whose owner drifted from its plan's owner would
-- be readable by the wrong person.
create policy "Users read own annual plan deliveries"
  on public.annual_plan_deliveries for select
  using (
    exists (
      select 1 from public.annual_plans p
      where p.id = annual_plan_deliveries.annual_plan_id
        and p.user_id = auth.uid()
    )
  );


-- 5. TABLE PRIVILEGES ──────────────────────────────────────────
--
-- REVOKE FIRST, THEN GRANT BACK ONLY WHAT IS AUDITED. Supabase ships
-- ALTER DEFAULT PRIVILEGES for the public schema, so a table created a
-- few statements ago already arrived with privileges handed to anon,
-- authenticated and service_role - REFERENCES, TRIGGER and TRUNCATE
-- among them. Migrations 023, 024 and 035 all record this in detail, and
-- all three found live grants nobody had written. RLS covers none of
-- those three: TRUNCATE empties a table without producing a row for a
-- policy to filter, REFERENCES lets another table point a foreign key at
-- it, and TRIGGER attaches code to it.
--
-- What is granted back:
--
--   authenticated  SELECT on both tables, under the own-row policies
--                  above. This is what the account area will read.
--   service_role   SELECT on both tables. NO INSERT, NO UPDATE, NO
--                  DELETE - deliberately, and this is the point of
--                  section 16's rule. The five functions below are the
--                  entire write surface, they are SECURITY DEFINER, and
--                  they therefore act with their owner's privileges
--                  rather than with service_role's. Granting a direct
--                  write here would be granting a way around every guard
--                  in them.
--   anon           NOTHING. A prepaid contract is an account-area
--                  concern and no public page reads one.
--
-- public.checkout_attempts keeps migration 023's model unchanged: select,
-- insert, update to service_role alone, nothing to anon or
-- authenticated. The two columns added in section 3 are therefore not
-- reachable from any browser role, and no grant is added for them.
--
-- public.orders is not touched by this migration in any way.

revoke all privileges on table public.annual_plans
  from anon, authenticated, service_role;
revoke all privileges on table public.annual_plan_deliveries
  from anon, authenticated, service_role;

grant select on table public.annual_plans           to authenticated;
grant select on table public.annual_plan_deliveries to authenticated;

grant select on table public.annual_plans           to service_role;
grant select on table public.annual_plan_deliveries to service_role;


-- 6. THE PENDING PLAN, CLAIMED ATOMICALLY ──────────────────────
--
-- Model A, before Stripe. The parent is frozen while nothing external
-- knows anything, so an event delivered in any order still has a local
-- row to resolve against.
--
-- ONE DATABASE CALL, and that is the point of it. The obvious shape -
-- read the attempt's plan, create one if absent, link it - has a window
-- in which two concurrent requests both read NULL and both create a
-- plan. That window cannot be closed from application code at all, so it
-- is closed here under a row lock on the attempt, exactly as migration
-- 025's claim_pending_subscription_for_attempt does.
--
-- THE TOTALS ARE NOT ARGUMENTS. merchandise, shipping and grand total
-- are computed here from the per-delivery integers and delivery_count,
-- so a caller cannot supply a total that disagrees with the unit price
-- it is built from. What the caller does supply is checked against the
-- attempt it already froze: if the plan's total is not the amount the
-- customer is about to be asked to pay, nothing is created.

create or replace function public.create_pending_annual_plan_for_attempt(
  p_checkout_attempt_id             uuid,
  p_user_id                         uuid,
  p_variant_id                      uuid,
  p_catalog_unit_gross_cents        integer,
  p_annual_unit_gross_cents         integer,
  p_shipping_per_delivery_gross_cents integer,
  p_discount_percent_applied        numeric,
  p_customer_snapshot               jsonb,
  p_shipping_address_snapshot       jsonb,
  p_billing_address_snapshot        jsonb,
  p_tax_snapshot                    jsonb,
  p_delivery_items_snapshot         jsonb,
  p_delivery_tax_snapshot           jsonb
)
returns jsonb
language plpgsql
volatile
security definer set search_path = ''
as $$
declare
  v_attempt public.checkout_attempts;
  v_plan    public.annual_plans;
  v_count   constant integer := 13;
  v_merch   integer;
  v_ship    integer;
  v_total   integer;
begin
  if p_checkout_attempt_id is null
     or p_user_id is null
     or p_variant_id is null
     or p_catalog_unit_gross_cents is null
     or p_annual_unit_gross_cents is null
     or p_shipping_per_delivery_gross_cents is null
     or p_discount_percent_applied is null
     or p_customer_snapshot is null
     or p_shipping_address_snapshot is null
     or p_billing_address_snapshot is null
     or p_tax_snapshot is null
     or p_delivery_items_snapshot is null
     or p_delivery_tax_snapshot is null
  then
    return pg_catalog.jsonb_build_object('result', 'invalid_input');
  end if;

  -- THE LOCK, FIRST. Everything below decides whether a plan exists and
  -- creates one if it does not; both halves must see the same attempt.
  select * into v_attempt
  from public.checkout_attempts
  where id = p_checkout_attempt_id
  for update;

  if not found then
    return pg_catalog.jsonb_build_object('result', 'attempt_not_found');
  end if;

  -- ── OWNERSHIP FIRST, BEFORE ANY PLAN IS RESOLVED OR REPORTED ──
  --
  -- Order matters here and it is a security property, not tidiness.
  -- Answering the existing-plan branch before proving ownership would
  -- turn a guessed request id into an oracle: a caller holding somebody
  -- else's attempt id would learn that an annual plan exists for it, and
  -- learn its uuid and its lifecycle status. Proving ownership first
  -- means an attempt that is not this caller's produces exactly one
  -- answer, carrying no plan id and no status, whether or not a plan
  -- exists behind it.
  if v_attempt.user_id is distinct from p_user_id then
    return pg_catalog.jsonb_build_object('result', 'attempt_not_owned');
  end if;

  -- Already claimed. Idempotent, and the ONLY safe answer to a retry:
  -- the plan that exists IS the answer to this request and nothing may
  -- rebuild it from a freshly computed price. Reached only by the
  -- attempt's own owner, and reached BEFORE the pre-Stripe test below,
  -- because a legitimate retry after the Stripe session was created has
  -- an attempt that is no longer pre-Stripe and must still be answered.
  select * into v_plan
  from public.annual_plans
  where payment_checkout_attempt_id = p_checkout_attempt_id;

  if found then
    return pg_catalog.jsonb_build_object(
      'result', 'existing',
      'annual_plan_id', v_plan.id,
      'status', v_plan.status
    );
  end if;

  -- ── NO PLAN YET, SO THE ATTEMPT MUST STILL BE PRE-STRIPE ──────
  --
  -- From here on a NEW parent would be created, and the contract is
  -- strictly ordered:
  --
  --     payment attempt  ->  pending annual parent  ->  Stripe session
  --
  -- The parent has to exist before the session so its id can go into
  -- subscription-free Stripe metadata as gloa_annual_plan_id, which is
  -- what lets the payment webhook resolve the plan against trusted local
  -- data instead of against anything the payload says.
  --
  -- 'created' is the EXACT pre-Stripe state in this architecture, not an
  -- assumption: migration 009 defaults checkout_attempts.status to
  -- 'created', lib/checkoutAttempts.ts inserts without a status, and
  -- linkStripeSession is the thing that moves it to
  -- 'stripe_session_created' at the moment a Stripe session first
  -- exists. 'failed' and 'expired' are past states and 'paid' is a
  -- settled payment; none of them may mint a parent.
  --
  -- The four Stripe identity columns are checked as well as the status,
  -- because the status is a workflow marker while those are evidence
  -- that an external object already exists. An attempt that carries a
  -- session, a payment intent, an invoice, a subscription binding or an
  -- annual delivery binding belongs to something else, and minting a
  -- fresh parent for it would be minting a contract against a payment
  -- nobody priced as an annual plan.
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

  v_merch := p_annual_unit_gross_cents * v_count;
  v_ship  := p_shipping_per_delivery_gross_cents * v_count;
  v_total := v_merch + v_ship;

  -- THE PRICE THE CUSTOMER IS ABOUT TO BE ASKED FOR. The attempt froze
  -- it before Stripe was contacted; if the plan is not that number, the
  -- two were computed from different inputs and neither is trustworthy.
  if v_attempt.expected_total_gross_cents is distinct from v_total then
    return pg_catalog.jsonb_build_object(
      'result', 'total_mismatch',
      'attempt_total_gross_cents', v_attempt.expected_total_gross_cents,
      'plan_total_gross_cents', v_total
    );
  end if;

  begin
    insert into public.annual_plans (
      user_id,
      payment_checkout_attempt_id,
      variant_id,
      currency,
      status,
      payment_status,
      catalog_unit_gross_cents,
      annual_unit_gross_cents,
      shipping_per_delivery_gross_cents,
      delivery_count,
      merchandise_total_gross_cents,
      shipping_total_gross_cents,
      total_gross_cents,
      discount_percent_applied,
      customer_snapshot,
      shipping_address_snapshot,
      billing_address_snapshot,
      tax_snapshot,
      delivery_items_snapshot,
      delivery_tax_snapshot
    ) values (
      p_user_id,
      p_checkout_attempt_id,
      p_variant_id,
      v_attempt.currency,
      'pending',
      'pending',
      p_catalog_unit_gross_cents,
      p_annual_unit_gross_cents,
      p_shipping_per_delivery_gross_cents,
      v_count,
      v_merch,
      v_ship,
      v_total,
      p_discount_percent_applied,
      p_customer_snapshot,
      p_shipping_address_snapshot,
      p_billing_address_snapshot,
      p_tax_snapshot,
      p_delivery_items_snapshot,
      p_delivery_tax_snapshot
    )
    returning * into v_plan;
  exception
    when unique_violation then
      -- A concurrent caller won the race between the lookup and this
      -- insert. annual_plans_payment_checkout_attempt_id_key is the real
      -- guard; this adopts its winner rather than raising.
      select * into v_plan
      from public.annual_plans
      where payment_checkout_attempt_id = p_checkout_attempt_id;
      if found then
        return pg_catalog.jsonb_build_object(
          'result', 'existing',
          'annual_plan_id', v_plan.id,
          'status', v_plan.status
        );
      end if;
      raise;
  end;

  return pg_catalog.jsonb_build_object(
    'result', 'created',
    'annual_plan_id', v_plan.id,
    'status', v_plan.status,
    'total_gross_cents', v_plan.total_gross_cents
  );
end;
$$;


-- 7. ACTIVATION: PAYMENT PROOF BECOMES THIRTEEN DATES ──────────
--
-- The ONLY path that moves an annual plan out of 'pending', and the only
-- path that creates a delivery row.
--
-- ── WHAT COUNTS AS PAYMENT PROOF ──────────────────────────────
--
-- Not the argument list. The proof is that the plan's own PAYMENT
-- checkout attempt is status 'paid', which in this system can only be
-- written by lib/checkoutAttempts.ts's markAttemptPaid, which the
-- webhook reaches only after evaluateStripeSessionPayment has compared
-- Stripe's re-read amount_total and currency against that attempt's
-- frozen expected total. This function then re-proves the last link
-- itself: the attempt's expected total must equal the plan's total. So
-- the caller cannot activate a plan by asserting that it was paid; it
-- can only activate one whose own frozen anchor already says so.
--
-- ── AND THE STRIPE IDENTITY MUST MATCH, EXACTLY ───────────────
--
-- Phase 4B1.1 tightened this. markAttemptPaid persists BOTH facts on the
-- attempt - stripe_payment_intent_id and paid_at - and linkStripeSession
-- persists stripe_checkout_session_id before the customer is ever handed
-- the session URL, with the webhook re-linking it if that first write
-- failed. So the attempt is the authority on which Stripe objects settled
-- it, and both arguments are CROSS-CHECKED against it rather than
-- believed:
--
--     supplied session id  =  attempt.stripe_checkout_session_id
--     supplied intent id   =  attempt.stripe_payment_intent_id
--
-- Both must be present and non-blank on the attempt, and both must match
-- after trimming, or the function returns a conflict and MUTATES
-- NOTHING. What is then written onto the plan is the ATTEMPT's value, not
-- the caller's, so the PaymentIntent that section 11's refund writer
-- resolves by provably came from the one paid attempt that belongs to
-- this plan.
--
-- A missing session id on a paid attempt is refused rather than waived.
-- It is an internal inconsistency for a thirteen-delivery prepaid
-- contract, and it self-heals: the webhook re-links the session on every
-- redelivery, so a refusal here becomes an activation on the next one,
-- whereas activating without it would permanently record a plan whose
-- Stripe identity could not be fully proved.
--
-- Nothing is correlated by customer, email, amount alone, SKU or
-- timestamp. An annual plan bills one customer one amount once, so every
-- one of those would eventually match the wrong plan.
--
-- ── THE PURCHASE DATE IS NOT THE CALLER'S TO CHOOSE ───────────
--
-- purchased_at is read from the attempt's paid_at and from nowhere else.
-- Phase 4B1.1 removed the p_purchased_at argument entirely rather than
-- defaulting it, because this one timestamp positions thirteen future
-- shipments and the plan's end date: a caller that could pass it could
-- move every delivery. paid_at is written by markAttemptPaid at the
-- moment payment was verified, so it is evidence rather than input, and
-- it is REQUIRED - a 'paid' attempt without one is refused.
--
-- ── THE SCHEDULE, AND WHY IT IS HOURS AND NOT DAYS ────────────
--
--   delivery 1   paid_at
--   delivery n   paid_at + 672 hours * (n - 1)
--   delivery 13  paid_at + 8064 hours   = +336 days
--   plan_end_at  paid_at + 8736 hours   = +364 days
--
-- 672 hours is 28 days and 8736 is 364 days, expressed as an absolute
-- duration. timestamptz + interval '28 days' is CALENDAR arithmetic: it
-- converts to the session time zone, adds 28 calendar days and converts
-- back, so across a DST boundary it is 27 days 23 hours or 28 days 1
-- hour of real time and the answer depends on a session setting this
-- function has deliberately given up (search_path is empty and TimeZone
-- is not ours to assume). An hour interval has no such dependency.
--
-- It also matches the application exactly:
-- lib/subscriptionCancellationRules.ts pins the cadence as
-- "28 days is always 2 419 200 000 ms" for the same reason, and a
-- delivery rhythm that drifts against what the customer was told is not
-- the rhythm they agreed to.
--
-- The whole sequence is frozen NOW, not derived later. A missed cron run
-- therefore cannot push delivery 9 into October; it only makes it late.
--
-- ── IDEMPOTENT ───────────────────────────────────────────────
--
-- A webhook replay finds status 'active', proves the PaymentIntent is
-- the same one, and returns. Even if two deliveries of the same event
-- raced past that check, the insert is
-- on conflict (annual_plan_id, delivery_number) do nothing - so the
-- database, not the code, is what makes fourteen rows impossible.
--
-- IT CREATES NO ORDER. Delivery 1 is scheduled at paid_at and is
-- therefore immediately due, but it is fulfilled through the same claim
-- and fulfill path as the other twelve. "The first one is special" is
-- exactly how the annual PaymentIntent would leak onto a delivery order.

create or replace function public.activate_annual_plan_from_payment(
  p_annual_plan_id             uuid,
  p_stripe_checkout_session_id text,
  p_stripe_payment_intent_id   text
)
returns jsonb
language plpgsql
volatile
security definer set search_path = ''
as $$
declare
  v_plan      public.annual_plans;
  v_attempt   public.checkout_attempts;
  v_purchased timestamptz;
  v_intent    text;
  v_session   text;
  v_created   integer;
begin
  -- BOTH identities are required input. Neither has a default and
  -- neither may be blank: they exist to be cross-checked against the
  -- attempt, and an absent one would check nothing.
  if p_annual_plan_id is null
     or p_stripe_payment_intent_id is null
     or pg_catalog.btrim(p_stripe_payment_intent_id) = ''
     or p_stripe_checkout_session_id is null
     or pg_catalog.btrim(p_stripe_checkout_session_id) = ''
  then
    return pg_catalog.jsonb_build_object('result', 'invalid_input');
  end if;

  v_intent  := pg_catalog.btrim(p_stripe_payment_intent_id);
  v_session := pg_catalog.btrim(p_stripe_checkout_session_id);

  select * into v_plan
  from public.annual_plans
  where id = p_annual_plan_id
  for update;

  if not found then
    return pg_catalog.jsonb_build_object('result', 'not_found');
  end if;

  -- Terminal states are terminal. Migration 022 refuses to revive a
  -- cancelled subscription and this refuses the same way: a replayed
  -- payment event must never restart a plan somebody ended.
  if v_plan.status in ('completed', 'cancelled') then
    return pg_catalog.jsonb_build_object(
      'result', 'terminal', 'annual_plan_id', v_plan.id, 'status', v_plan.status
    );
  end if;

  -- ALREADY ACTIVE. Idempotent, but only for the SAME payment: a second
  -- PaymentIntent or a second Checkout Session claiming an active plan is
  -- a correlation error, and adopting either would overwrite the identity
  -- section 11's refund writer resolves by.
  if v_plan.status = 'active' then
    if v_plan.stripe_payment_intent_id is distinct from v_intent then
      return pg_catalog.jsonb_build_object(
        'result', 'payment_intent_conflict', 'annual_plan_id', v_plan.id
      );
    end if;
    if v_plan.stripe_checkout_session_id is distinct from v_session then
      return pg_catalog.jsonb_build_object(
        'result', 'checkout_session_conflict', 'annual_plan_id', v_plan.id
      );
    end if;
    select pg_catalog.count(*) into v_created
    from public.annual_plan_deliveries
    where annual_plan_id = v_plan.id;
    return pg_catalog.jsonb_build_object(
      'result', 'already_active',
      'annual_plan_id', v_plan.id,
      'deliveries', v_created
    );
  end if;

  -- ── PAYMENT PROOF, RE-PROVED HERE ─────────────────────────
  select * into v_attempt
  from public.checkout_attempts
  where id = v_plan.payment_checkout_attempt_id
  for update;

  if not found then
    return pg_catalog.jsonb_build_object('result', 'attempt_not_found');
  end if;
  if v_attempt.status <> 'paid' then
    return pg_catalog.jsonb_build_object(
      'result', 'attempt_not_paid', 'attempt_status', v_attempt.status
    );
  end if;
  if v_attempt.expected_total_gross_cents is distinct from v_plan.total_gross_cents then
    return pg_catalog.jsonb_build_object('result', 'total_mismatch');
  end if;

  -- THE ATTEMPT AND THE PLAN MUST BELONG TO THE SAME PERSON. The plan
  -- names the attempt and the attempt names a user; a disagreement means
  -- one of the two was written against the wrong customer, and neither is
  -- then trustworthy. Checked even though the creation function proved it
  -- once: this is the transaction that turns money into a contract.
  if v_attempt.user_id is distinct from v_plan.user_id then
    return pg_catalog.jsonb_build_object('result', 'attempt_owner_mismatch');
  end if;

  -- ── THE EXACT STRIPE IDENTITIES, FROM THE ATTEMPT ─────────
  --
  -- Present, non-blank, and equal to what the caller re-read from
  -- Stripe. Any failure returns before the UPDATE below, so a
  -- correlation error mutates nothing at all.
  if v_attempt.stripe_payment_intent_id is null
     or pg_catalog.btrim(v_attempt.stripe_payment_intent_id) = ''
  then
    return pg_catalog.jsonb_build_object('result', 'attempt_payment_intent_missing');
  end if;
  if v_attempt.stripe_checkout_session_id is null
     or pg_catalog.btrim(v_attempt.stripe_checkout_session_id) = ''
  then
    return pg_catalog.jsonb_build_object('result', 'attempt_checkout_session_missing');
  end if;
  if pg_catalog.btrim(v_attempt.stripe_payment_intent_id) is distinct from v_intent then
    return pg_catalog.jsonb_build_object('result', 'payment_intent_conflict');
  end if;
  if pg_catalog.btrim(v_attempt.stripe_checkout_session_id) is distinct from v_session then
    return pg_catalog.jsonb_build_object('result', 'checkout_session_conflict');
  end if;

  -- ── THE PURCHASE DATE, FROM THE ATTEMPT ───────────────────
  --
  -- Required, never defaulted to now(). A 'paid' attempt with no paid_at
  -- cannot say when the thirteen deliveries start, and inventing that
  -- answer would silently move every one of them.
  if v_attempt.paid_at is null then
    return pg_catalog.jsonb_build_object('result', 'attempt_paid_at_missing');
  end if;
  v_purchased := v_attempt.paid_at;

  update public.annual_plans
     set status                     = 'active',
         payment_status             = 'paid',
         purchased_at               = v_purchased,
         plan_end_at                = v_purchased + pg_catalog.make_interval(hours => 8736),
         -- THE ATTEMPT'S VALUES, not the caller's. They were proved
         -- identical above, and taking them from the evidence rather
         -- than from the argument is what makes the provenance
         -- unambiguous when this row is read back by the refund writer.
         stripe_payment_intent_id   = pg_catalog.btrim(v_attempt.stripe_payment_intent_id),
         stripe_checkout_session_id = pg_catalog.btrim(v_attempt.stripe_checkout_session_id)
   where id = v_plan.id
  returning * into v_plan;

  -- THE THIRTEEN. One statement, one transaction with the activation
  -- above, and the unique constraint as the backstop.
  insert into public.annual_plan_deliveries (
    annual_plan_id,
    delivery_number,
    scheduled_for,
    state
  )
  select v_plan.id,
         n,
         v_purchased + pg_catalog.make_interval(hours => 672 * (n - 1)),
         'scheduled'
  from pg_catalog.generate_series(1, v_plan.delivery_count) as n
  on conflict on constraint annual_plan_deliveries_plan_number_key do nothing;

  select pg_catalog.count(*) into v_created
  from public.annual_plan_deliveries
  where annual_plan_id = v_plan.id;

  -- Fail loudly rather than leave a plan active with a partial schedule.
  -- Raising rolls the whole activation back, the webhook answers 500 and
  -- Stripe redelivers against a plan that is still 'pending'.
  if v_created <> v_plan.delivery_count then
    raise exception 'annual plan % has % delivery rows, expected %',
      v_plan.id, v_created, v_plan.delivery_count;
  end if;

  return pg_catalog.jsonb_build_object(
    'result', 'activated',
    'annual_plan_id', v_plan.id,
    'purchased_at', v_plan.purchased_at,
    'plan_end_at', v_plan.plan_end_at,
    'deliveries', v_created
  );
end;
$$;


-- 8. CLAIMING DUE DELIVERIES ───────────────────────────────────
--
-- The cron's work list, and the act of taking it, in one statement.
-- Selecting due rows and then updating them separately would let two
-- invocations both read the same row as due.
--
-- IT CREATES NOTHING. No order, no attempt, no email, no Stripe call.
-- All it does is move 'scheduled' to 'claimed' and stamp claimed_at.
--
-- ── STALE CLAIM RECOVERY, AND THE SIX HOUR LEASE ──────────────
--
-- A worker that wins a claim and then dies leaves a row at 'claimed'
-- that nothing would ever look at again. This is the same failure the
-- transactional email cron solves by returning stale 'sending' rows to
-- 'failed', and it is solved the same way: a claim is a LEASE, not a
-- permanent assignment.
--
-- The threshold is SIX HOURS, pinned here and asserted in the focused
-- suite. It is chosen from both sides:
--
--   far ABOVE any in-flight processing. The claimer is a serverless
--   function invocation measured in seconds; nothing legitimate holds a
--   claim for six hours, so the lease can never expire under a worker
--   that is still working.
--
--   far BELOW the retry interval. vercel.json schedules exactly one
--   invocation per day ("20 5 * * *"), because the Vercel Hobby plan
--   permits one. Six hours is well inside that, so a row abandoned by
--   one run is reclaimable by the very next one and a delivery is at
--   most one day late.
--
-- ── WHY RECLAIMING IS SAFE, AND NOT MERELY LIKELY TO BE ───────
--
-- Reclaim requires order_id IS NULL and fulfilled_at IS NULL. It can
-- therefore never touch a delivery that already shipped.
--
-- And a reclaimed row cannot produce a second order even if the original
-- worker were somehow still alive: both workers resolve the SAME
-- synthetic attempt, because checkout_attempts_annual_delivery_key makes
-- (plan, delivery_number) unique, and the same order, because
-- orders_checkout_attempt_id_key makes one order per attempt. The lease
-- prevents wasted concurrent work; the unique indexes prevent
-- duplication. The correctness does not rest on the lease at all.
--
-- ── THE PLAN GUARD HERE IS ADVISORY ───────────────────────────
--
-- The plan is read without a lock, so a refund committing at the same
-- instant could in principle be missed by this predicate. That is
-- deliberate: locking the parent here would serialise every claim in a
-- batch behind one row. The AUTHORITATIVE gate is in section 9, which
-- re-reads the plan FOR UPDATE before anything is created, so a claim is
-- only ever permission to look again.

create or replace function public.claim_due_annual_plan_deliveries(
  p_limit integer
)
returns table (
  delivery_id     uuid,
  annual_plan_id  uuid,
  delivery_number integer,
  scheduled_for   timestamptz,
  reclaimed       boolean
)
language sql
volatile
security definer set search_path = ''
as $$
  with due as (
    select d.id, (d.state = 'claimed') as was_claimed
    from public.annual_plan_deliveries d
    join public.annual_plans p on p.id = d.annual_plan_id
    where p.status = 'active'
      -- A FULLY REFUNDED PLAN GENERATES NOTHING FURTHER. See section 12
      -- for why this predicate, and not a lifecycle change, is the
      -- chosen contract.
      and p.payment_status <> 'refunded'
      and d.order_id is null
      and d.fulfilled_at is null
      and (
        (d.state = 'scheduled' and d.scheduled_for <= pg_catalog.now())
        or
        -- THE SIX HOUR LEASE. Pinned here as a literal, and asserted by
        -- the focused suite so it cannot drift silently.
        (d.state = 'claimed'
         and d.claimed_at is not null
         and d.claimed_at < pg_catalog.now() - interval '6 hours')
      )
    order by d.scheduled_for asc, d.delivery_number asc, d.id asc
    limit least(greatest(coalesce(p_limit, 25), 1), 100)
    -- OF d, so only the delivery rows are locked. Locking the parent
    -- too would let this function and section 9 acquire the same two
    -- rows in opposite orders and deadlock. Section 9 always takes the
    -- parent first and the delivery second; this one takes the delivery
    -- only, so no cycle exists.
    for update of d skip locked
  )
  update public.annual_plan_deliveries t
     set state      = 'claimed',
         claimed_at = pg_catalog.now()
    from due
   where t.id = due.id
  returning t.id, t.annual_plan_id, t.delivery_number, t.scheduled_for, due.was_claimed;
$$;


-- 9. FULFILLING ONE DELIVERY, IN ONE TRANSACTION ───────────────
--
-- The whole of a delivery's fulfillment, from the parent guard to the
-- persisted order, inside a single database transaction that never lets
-- go of the annual plan's row lock.
--
-- ── WHY IT IS ONE FUNCTION AND NOT THREE ──────────────────────
--
-- The first draft of this migration exposed three service-role calls -
-- prepare the attempt, then let application code call
-- create_order_from_paid_checkout, then mark the delivery fulfilled.
-- Each was individually atomic, and the composition was not. Between the
-- first call committing and the second one running, the parent row lock
-- was released, and in that window this could happen:
--
--     t0  prepare: parent is 'active', payment_status 'paid'  -> ok
--     t1  prepare commits, parent lock released
--     t2  apply_annual_plan_refund_state: full refund commits
--     t3  application calls create_order_from_paid_checkout
--     t4  a physical order now exists for a fully refunded plan
--
-- The guard at t0 was true and irrelevant by t3. No amount of re-reading
-- inside the application closes that: any check it performs is also
-- outside the transaction that creates the order.
--
-- So the guard and the order creation are now the same transaction. The
-- parent is locked FOR UPDATE at the start and the lock is held until
-- the order exists and the delivery row records it. See section 10 for
-- the proof that this makes the sequence above impossible.
--
-- ── IT DOES NOT REDEFINE THE ORDER CREATOR ────────────────────
--
-- public.create_order_from_paid_checkout (migrations 011 through 021) is
-- live and immutable and it already does its job correctly: it locks the
-- attempt, refuses one that is not paid, validates the tax snapshot
-- against the shipping and the expected total, mints the order and its
-- items from the frozen snapshot, and returns the EXISTING order on a
-- retry rather than creating a second one. Teaching it about annual
-- plans would put a live one-time and subscription path at risk for a
-- case it does not need to know about.
--
-- It is therefore CALLED, not replaced, and called from inside this
-- transaction so its work commits or rolls back with the guard above it.
-- Both functions are SECURITY DEFINER owned by the same role, so the
-- inner call runs with its owner's privileges exactly as it does today;
-- migration 016's grant to service_role is untouched and unnecessary
-- here, because the owner's own EXECUTE is what this uses.
--
-- The compatibility was checked field by field and there is no
-- incompatibility to report:
--
--   status 'paid'          permitted by 009's CHECK, and already used
--                          this way by activate_subscription_from_invoice
--                          (022), which mints a paid attempt for a
--                          renewal the same way.
--   request_id             uuid not null unique; a fresh uuid, exactly
--                          as 022 does.
--   items_snapshot         the plan's frozen delivery line, one item,
--                          quantity 1, at the frozen annual unit price.
--   shipping_gross_cents   the plan's frozen per-delivery shipping. 590
--                          for 30 g on every one of the thirteen orders;
--                          0 for 50 g and 100 g. Zero is a REAL, KNOWN
--                          price here, never NULL, which 011 reserves
--                          for genuinely unknown.
--   shipping_zone          NULL. It is a presentation detail of a
--                          one-time Stripe session and nothing reads it
--                          on this path - the same choice 022 made.
--   tax_snapshot           the plan's frozen PER-DELIVERY document,
--                          whose totals the section 1 CHECKs already
--                          proved equal to this attempt's shipping and
--                          expected total. 021's two raise-conditions
--                          are therefore unreachable here.
--
-- ── NOTHING FRESH IS READ ─────────────────────────────────────
--
-- Not the catalog, not lib/shipping.ts's threshold, not a current tax
-- rate. Every value comes from the plan's frozen columns, which is what
-- makes a price change in month three unable to touch delivery nine.
--
-- ── IDEMPOTENT, AND THE DATABASE IS THE BACKSTOP ──────────────
--
-- A retry after a successful fulfillment returns the SAME attempt and
-- the SAME order and creates neither again. That is not a code
-- convention; three constraints hold it jointly:
--
--   checkout_attempts_annual_delivery_key      one attempt per delivery
--   orders_checkout_attempt_id_key   (011)     one order per attempt
--   annual_plan_deliveries_order_id_key        one delivery per order
--
-- A retry after a PARTIAL failure converges too, because every step
-- resolves an existing row rather than assuming it must create one.
--
-- ── AND IT STILL CREATES NO PAYMENT IDENTITY ──────────────────
--
-- The synthetic attempt names no PaymentIntent, no invoice, no session
-- and no subscription, and section 3's CHECK refuses the row if it ever
-- did. p_stripe_payment_intent_id is passed to the order creator as
-- NULL for the same reason: an annual delivery order that carried the
-- annual intent would make migration 038 answer
-- 'ambiguous_payment_intent' for every refund of that payment.

create or replace function public.fulfill_annual_plan_delivery(
  p_delivery_id uuid
)
returns jsonb
language plpgsql
volatile
security definer set search_path = ''
as $$
declare
  v_delivery public.annual_plan_deliveries;
  v_plan     public.annual_plans;
  v_attempt  public.checkout_attempts;
  v_order    public.orders;
  v_expected integer;
begin
  if p_delivery_id is null then
    return pg_catalog.jsonb_build_object('result', 'invalid_input');
  end if;

  -- Unlocked read, only to learn which parent to lock. Nothing is
  -- decided from it; the row is read again under the lock below.
  select * into v_delivery
  from public.annual_plan_deliveries
  where id = p_delivery_id;

  if not found then
    return pg_catalog.jsonb_build_object('result', 'not_found');
  end if;

  -- ── THE PARENT LOCK. EVERYTHING BELOW HAPPENS UNDER IT. ───
  --
  -- Taken FIRST, and held for the rest of this transaction - through the
  -- guards, through the attempt insert, through the order creation and
  -- through the delivery update. apply_annual_plan_refund_state locks
  -- the same row the same way, so the two serialise on it and there is
  -- no window between the guard and the order.
  select * into v_plan
  from public.annual_plans
  where id = v_delivery.annual_plan_id
  for update;

  if not found then
    return pg_catalog.jsonb_build_object('result', 'plan_not_found');
  end if;

  -- ── THE CHILD LOCK, ALWAYS SECOND ─────────────────────────
  --
  -- One consistent order across every function in this file. The claim
  -- function deliberately locks only delivery rows (for update of d), so
  -- no pair of these can acquire the same two rows in opposite orders.
  select * into v_delivery
  from public.annual_plan_deliveries
  where id = p_delivery_id
  for update;

  -- ── ALREADY FULFILLED: RETURN THE SAME ORDER ──────────────
  --
  -- Checked before the parent guards, deliberately. A delivery that
  -- already shipped is a historical fact, and a later refund or
  -- termination does not un-ship it - so a retry must be able to report
  -- what happened even when the plan is no longer deliverable.
  if v_delivery.state = 'fulfilled' then
    return pg_catalog.jsonb_build_object(
      'result', 'already_fulfilled',
      'delivery_id', v_delivery.id,
      'delivery_number', v_delivery.delivery_number,
      'checkout_attempt_id', v_delivery.checkout_attempt_id,
      'order_id', v_delivery.order_id
    );
  end if;

  -- ── THE AUTHORITATIVE PARENT GUARD ────────────────────────
  --
  -- The claim function read these two facts without a lock, which made
  -- them advisory. Here they are true under the lock or NOTHING is
  -- created: no attempt, no order, no state change.
  --
  -- status covers future administrative termination as well as the
  -- states 039 writes: whatever moves a plan out of 'active', this stops
  -- generating orders for it without that phase having to find this
  -- function.
  if v_plan.status <> 'active' then
    return pg_catalog.jsonb_build_object(
      'result', 'plan_not_active', 'status', v_plan.status
    );
  end if;
  if v_plan.payment_status = 'refunded' then
    return pg_catalog.jsonb_build_object('result', 'plan_refunded');
  end if;

  -- FAIL CLOSED ON ANYTHING THAT IS NOT A LIVE CLAIM. A 'scheduled' row
  -- was never claimed and must go through section 8 first; a 'cancelled'
  -- one is owed nothing.
  if v_delivery.state <> 'claimed' then
    return pg_catalog.jsonb_build_object(
      'result', 'delivery_not_claimed', 'state', v_delivery.state
    );
  end if;

  v_expected := v_plan.annual_unit_gross_cents + v_plan.shipping_per_delivery_gross_cents;

  -- ── STEP 1: THE SYNTHETIC PAID ATTEMPT, CREATED OR RESOLVED ──
  if v_delivery.checkout_attempt_id is not null then
    select * into v_attempt
    from public.checkout_attempts
    where id = v_delivery.checkout_attempt_id;
    if not found then
      return pg_catalog.jsonb_build_object('result', 'attempt_missing');
    end if;
  else
    begin
      insert into public.checkout_attempts (
        request_id,
        user_id,
        status,
        currency,
        expected_total_gross_cents,
        items_snapshot,
        shipping_country,
        shipping_gross_cents,
        tax_snapshot,
        annual_plan_id,
        annual_delivery_number,
        paid_at
      ) values (
        -- Schema-qualified for migration 022's reason: this body runs
        -- with search_path emptied and request_id has no column default
        -- to fall back on, so an unqualified name would depend on a
        -- resolution order this function has given up.
        pg_catalog.gen_random_uuid(),
        v_plan.user_id,
        'paid',
        v_plan.currency,
        v_expected,
        v_plan.delivery_items_snapshot,
        v_plan.shipping_address_snapshot->>'country',
        v_plan.shipping_per_delivery_gross_cents,
        v_plan.delivery_tax_snapshot,
        v_plan.id,
        v_delivery.delivery_number,
        pg_catalog.now()
        -- stripe_payment_intent_id, stripe_invoice_id,
        -- stripe_checkout_session_id and subscription_id are all left
        -- unset. Section 3's CHECK would refuse the row otherwise, which
        -- is the point: the annual PaymentIntent belongs to the plan.
      )
      returning * into v_attempt;
    exception
      when unique_violation then
        -- checkout_attempts_annual_delivery_key won the race. Adopt its
        -- winner, but only after proving the winner is THIS delivery's.
        select * into v_attempt
        from public.checkout_attempts
        where annual_plan_id = v_plan.id
          and annual_delivery_number = v_delivery.delivery_number;
        if not found then
          raise;
        end if;
    end;
  end if;

  -- ── STEP 2: THE ORDER, FROM THE LIVE CREATOR, SAME TRANSACTION ──
  --
  -- Positional arguments against the signature migrations 016 and 021
  -- established: (attempt, customer snapshot, payment intent, shipping
  -- address, billing address, shipping cents). NULL::text for the
  -- payment intent, explicitly typed so the call cannot resolve
  -- anywhere unintended.
  --
  -- It is idempotent in its own right: given an attempt that already has
  -- an order, it returns that order untouched. So a retry that got this
  -- far before dying resolves the same row rather than creating another.
  v_order := public.create_order_from_paid_checkout(
    v_attempt.id,
    v_plan.customer_snapshot,
    null::text,
    v_plan.shipping_address_snapshot,
    v_plan.billing_address_snapshot,
    v_plan.shipping_per_delivery_gross_cents
  );

  if v_order.id is null then
    -- Unreachable: the creator raises rather than returning nothing.
    -- Refusing anyway means a future change there cannot silently mark a
    -- delivery fulfilled against no order.
    raise exception 'create_order_from_paid_checkout returned no order for annual delivery %',
      v_delivery.id;
  end if;

  -- ── STEP 3: THE DELIVERY RECORDS WHAT HAPPENED ────────────
  update public.annual_plan_deliveries
     set state               = 'fulfilled',
         checkout_attempt_id = v_attempt.id,
         order_id            = v_order.id,
         fulfilled_at        = pg_catalog.now()
   where id = v_delivery.id;

  -- NOTHING HERE COMPLETES THE PLAN. See section 13.
  return pg_catalog.jsonb_build_object(
    'result', 'fulfilled',
    'delivery_id', v_delivery.id,
    'delivery_number', v_delivery.delivery_number,
    'checkout_attempt_id', v_attempt.id,
    'order_id', v_order.id,
    'order_number', v_order.order_number
  );
end;
$$;


-- 10. WHY THE FULL-REFUND RACE IS IMPOSSIBLE ───────────────────
--
-- Two functions may act on a live annual plan, and both take the SAME
-- row lock on public.annual_plans FOR UPDATE before deciding anything:
--
--   fulfill_annual_plan_delivery        section 9
--   apply_annual_plan_refund_state      section 11
--
-- Each runs as one transaction, so exactly one of them holds that lock
-- at a time and the other waits. There are only two orders:
--
--   FULFILLMENT FIRST
--     It holds the parent lock, reads status 'active' and payment_status
--     not 'refunded', creates the attempt, creates the order and records
--     it on the delivery - all before releasing. The refund cannot
--     commit in the middle because it cannot acquire the lock at all. It
--     applies afterwards, against a plan whose delivery is genuinely
--     fulfilled, and every LATER delivery then sees 'refunded' and
--     creates nothing.
--
--   REFUND FIRST
--     It holds the parent lock and sets payment_status = 'refunded'.
--     Fulfillment waits, then reads the COMMITTED row - FOR UPDATE
--     re-reads the latest version rather than the snapshot it started
--     with - sees 'refunded', and returns 'plan_refunded' having created
--     no attempt and no order.
--
-- The window the first draft had - guard commits, refund commits, order
-- is created - required the guard and the order to be in different
-- transactions. They no longer are.
--
-- THE SAME ARGUMENT COVERS FUTURE ADMINISTRATIVE TERMINATION. Whatever
-- later phase moves a plan out of 'active' will take the same parent
-- lock to write it, and the status guard in section 9 is evaluated under
-- that lock, so a terminated plan cannot produce another order either.
-- That is why the guard tests status generally rather than naming the
-- states 039 happens to write.
--
-- THE CLAIM FUNCTION IS DELIBERATELY OUTSIDE THIS. It reads the parent
-- without a lock, which is safe precisely because it creates nothing: a
-- stale 'active' read there produces at worst a claimed delivery that
-- section 9 then refuses, and a refused delivery returns to being
-- reclaimable once its lease expires.


-- 11. THE ANNUAL REFUND WRITER ─────────────────────────────────
--
-- Resolves by the unique annual Stripe PaymentIntent ON THE PARENT, and
-- by absolutely nothing else. Not the customer, not the email, not the
-- amount, not the date, not the SKU, not a delivery order and not a
-- subscription id: an annual plan bills one customer one amount once,
-- and every one of those would eventually attach one plan's refund to
-- another plan's record.
--
-- ── WHY IT EXISTS AT ALL ──────────────────────────────────────
--
-- Because neither live writer can answer for an annual payment.
-- apply_order_refund_state (038) counts ORDERS carrying the payment
-- intent - and no annual delivery order carries it, by the CHECK in
-- section 3, so it answers 'order_not_found'. apply_order_refund_state_
-- by_invoice (037) walks a Stripe INVOICE, and a one-time annual payment
-- raises none. Both remain untouched.
--
-- ── WHY THERE IS NO TABLE LOCK, UNLIKE 038 ────────────────────
--
-- 038 takes "lock table public.orders in exclusive mode" because
-- public.orders has no unique index on stripe_payment_intent_id and 41
-- live rows already share one value, so cardinality has to be PROVEN
-- under a lock that excludes writers.
--
-- annual_plans_stripe_payment_intent_id_key makes that impossible here:
-- at most one row can ever carry a given intent, so there is nothing to
-- count and nothing to be raced into ambiguity. A row lock is therefore
-- both sufficient and correct, and a table lock would be strictly worse -
-- it would serialise every annual write in the system behind one refund.
-- The discipline 038 teaches is kept: no business decision is taken
-- before the row is locked.
--
-- ── WHY THERE IS NO p_has_pending_refund ──────────────────────
--
-- The parent's vocabulary is pending / paid / partially_refunded /
-- refunded. There is no 'refund_pending', because there is no annual
-- feature that produces one, and accepting an argument with no state to
-- write would be an argument that lies about what it does.
--
-- ── ABSOLUTE, NOT INCREMENTAL ─────────────────────────────────
--
-- The caller passes the CUMULATIVE settled total, summarised from
-- Stripe. The same Stripe state therefore always produces the same row,
-- so a duplicate or out-of-order webhook delivery converges instead of
-- accumulating - and a refund that is later cancelled at Stripe walks
-- the row back to 'paid' with 0, which is a real outcome and is
-- deliberately permitted.
--
-- ── WHAT IT REFUSES TO DECIDE ─────────────────────────────────
--
-- It never touches lifecycle status, purchased_at, plan_end_at, a
-- snapshot, a money total or a delivery row. A partial refund is
-- RECORDED TRUTHFULLY and stops nothing: a customer who was refunded one
-- delivery is still owed the other twelve, and cancelling them would be
-- inventing a commercial rule. Only a FULL refund stops future
-- generation, and section 12 records why that is one predicate in the
-- claim function rather than a forced lifecycle transition.

create or replace function public.apply_annual_plan_refund_state(
  p_stripe_payment_intent_id text,
  p_refunded_total_cents     integer
)
returns text
language plpgsql
volatile
security definer set search_path = ''
as $$
declare
  v_plan       public.annual_plans;
  v_new_status text;
  v_intent     text;
begin
  -- Validation runs BEFORE any lock, for 038's reason: a caller that
  -- passes nothing usable must not stall a row on its way to a refusal.
  if p_stripe_payment_intent_id is null
     or pg_catalog.btrim(p_stripe_payment_intent_id) = ''
     or p_refunded_total_cents is null
     or p_refunded_total_cents < 0
  then
    return 'invalid_input';
  end if;

  v_intent := pg_catalog.btrim(p_stripe_payment_intent_id);

  -- THE FIRST STATEMENT THAT TOUCHES THE TABLE, AND IT IS THE LOCK. The
  -- unique index guarantees at most one row, so this cannot be
  -- ambiguous and there is no ORDER BY and no LIMIT 1 manufacturing an
  -- answer where a refusal would be honest.
  select * into v_plan
  from public.annual_plans
  where stripe_payment_intent_id = v_intent
  for update;

  if not found then
    -- A payment intent this system holds no annual plan for. Not an
    -- error: it may belong to a one-time order or a subscription cycle,
    -- both of which have their own writers.
    return 'plan_not_found';
  end if;

  -- A plan that was never paid has no refund story to tell.
  if v_plan.payment_status = 'pending' then
    return 'not_applicable';
  end if;

  if p_refunded_total_cents > v_plan.total_gross_cents then
    return 'invalid_amount';
  end if;

  if p_refunded_total_cents = 0 then
    v_new_status := 'paid';
  elsif p_refunded_total_cents >= v_plan.total_gross_cents then
    v_new_status := 'refunded';
  else
    v_new_status := 'partially_refunded';
  end if;

  -- No UPDATE at all when nothing changed, so the updated_at trigger
  -- does not fire and a reconciliation that changed nothing does not
  -- look like activity.
  if v_plan.payment_status = v_new_status
     and v_plan.refunded_total_cents is not distinct from p_refunded_total_cents
  then
    return 'unchanged';
  end if;

  update public.annual_plans
     set payment_status       = v_new_status,
         refunded_total_cents = p_refunded_total_cents,
         refund_updated_at    = pg_catalog.now()
   where id = v_plan.id;

  return 'applied';
end;
$$;


-- 12. THE FULL-REFUND CONTRACT, STATED ONCE ────────────────────
--
-- Two designs could stop deliveries after a full refund. The smaller one
-- is used:
--
--   CHOSEN   claim_due_annual_plan_deliveries and
--            fulfill_annual_plan_delivery both refuse a plan whose
--            payment_status is 'refunded'. One predicate, in the two
--            functions that could create work, evaluated fresh every
--            time - and in the one that actually creates the order, it
--            is evaluated under the parent row lock it holds until the
--            order exists. Section 10 proves why that closes the race
--            the first draft of this file had.
--
--   REJECTED forcing status = 'cancelled' inside the refund writer.
--            Section 5's rule is that refund state is not lifecycle
--            state, and this would break it in the most damaging
--            direction: 'cancelled' is terminal, so a refund that Stripe
--            later reverses could not be walked back and the plan would
--            be permanently dead for a payment that is once again
--            complete. It would also make the refund writer the second
--            path that writes lifecycle status, which is exactly the
--            kind of overlapping authority migration 036 documents as
--            worth avoiding.
--
-- The chosen contract is reversible for free: absolute totals mean a
-- reversed refund returns payment_status to 'paid', and claims resume on
-- the next cron run with no repair step.
--
-- ALREADY FULFILLED DELIVERIES ARE NEVER TOUCHED. Nothing here deletes a
-- delivery row, a checkout attempt or an order. A shipped box is a
-- historical fact and a refund does not un-ship it.


-- 13. COMPLETION IS NOT WRITTEN HERE ───────────────────────────
--
-- delivery 13 lands at purchased_at + 336 days and plan_end_at is
-- purchased_at + 364 days. The plan is therefore still running for 28
-- days after the last box, which is the final delivery's own period and
-- is why the two dates differ.
--
-- THE INTENDED LATER RULE, recorded so the next phase implements the one
-- that was reviewed rather than one it invents:
--
--   a plan becomes status 'completed', with completed_at set, once ALL
--   of its delivery rows are 'fulfilled' AND now() >= plan_end_at.
--
-- Both halves matter. Completing on the thirteenth fulfilment alone
-- would end the contract 28 days early and contradict plan_end_at;
-- completing on the date alone would call a plan complete while a
-- delivery was still owed.
--
-- NO FUNCTION IN 039 WRITES 'completed', and no completion cron is
-- created. The value exists in the CHECK so the vocabulary is fixed and
-- reviewed in one place, and annual_plans_completed_at_check already
-- makes completed_at impossible without it. Leaving a finished plan at
-- 'active' until that phase exists is not a contradictory state: it is
-- an unfinished feature, and the claim function simply finds no
-- scheduled rows for it.
--
-- Administrative termination is likewise absent. Section 15 of the phase
-- brief is explicit: no endpoint, no new secret, and the future path
-- reuses the established cancellation-admin boundary. 039 writes no
-- 'cancelled' either.


-- 14. EXECUTE PRIVILEGES ───────────────────────────────────────
--
-- REVOKE FROM public FIRST. A freshly created function is executable by
-- PUBLIC by default and anon and authenticated inherit that, so revoking
-- only the named roles would leave the default in place and every
-- function below reachable from the browser's own Supabase client with
-- nothing but an anon key.
--
-- service_role is the only grantee, and it still holds no INSERT, UPDATE
-- or DELETE on either annual table. These FIVE functions are the entire
-- write surface for the annual plan, and there is deliberately no sixth:
-- Phase 4B1.1 removed prepare_annual_plan_delivery_attempt and
-- mark_annual_plan_delivery_fulfilled rather than keeping them alongside
-- fulfill_annual_plan_delivery. Leaving them callable would have left a
-- second, non-atomic way to reach the same rows - the exact composition
-- whose transaction gap section 9 exists to close - and a guard that can
-- be bypassed by calling a different function is not a guard. 039 is not
-- live, so nothing depended on them.

revoke all on function public.create_pending_annual_plan_for_attempt(uuid, uuid, uuid, integer, integer, integer, numeric, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb) from public;
revoke all on function public.create_pending_annual_plan_for_attempt(uuid, uuid, uuid, integer, integer, integer, numeric, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb) from anon;
revoke all on function public.create_pending_annual_plan_for_attempt(uuid, uuid, uuid, integer, integer, integer, numeric, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb) from authenticated;
grant execute on function public.create_pending_annual_plan_for_attempt(uuid, uuid, uuid, integer, integer, integer, numeric, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb) to service_role;

revoke all on function public.activate_annual_plan_from_payment(uuid, text, text) from public;
revoke all on function public.activate_annual_plan_from_payment(uuid, text, text) from anon;
revoke all on function public.activate_annual_plan_from_payment(uuid, text, text) from authenticated;
grant execute on function public.activate_annual_plan_from_payment(uuid, text, text) to service_role;

revoke all on function public.claim_due_annual_plan_deliveries(integer) from public;
revoke all on function public.claim_due_annual_plan_deliveries(integer) from anon;
revoke all on function public.claim_due_annual_plan_deliveries(integer) from authenticated;
grant execute on function public.claim_due_annual_plan_deliveries(integer) to service_role;

revoke all on function public.fulfill_annual_plan_delivery(uuid) from public;
revoke all on function public.fulfill_annual_plan_delivery(uuid) from anon;
revoke all on function public.fulfill_annual_plan_delivery(uuid) from authenticated;
grant execute on function public.fulfill_annual_plan_delivery(uuid) to service_role;

revoke all on function public.apply_annual_plan_refund_state(text, integer) from public;
revoke all on function public.apply_annual_plan_refund_state(text, integer) from anon;
revoke all on function public.apply_annual_plan_refund_state(text, integer) from authenticated;
grant execute on function public.apply_annual_plan_refund_state(text, integer) to service_role;


-- 15. NO DATA CHANGE ───────────────────────────────────────────
--
-- Applying this migration inserts no row, updates no row and deletes no
-- row. It creates two empty tables, adds two nullable columns to
-- public.checkout_attempts with no default and no backfill, and defines
-- five functions that it calls zero times.
--
-- No existing order, subscription, checkout attempt, plan, product,
-- address, email state or refund state changes as a result. Nothing in
-- the repository calls any of these functions yet: the checkout route,
-- the webhook branch, the cron job, the emails and the account UI are
-- later phases, and B2C_ANNUAL_PLAN_ENABLED does not exist yet and stays
-- OFF when it does.


-- ══════════════════════════════════════════════════════════════
-- VERIFY AFTER APPLYING (read-only, run in the SQL Editor)
-- ══════════════════════════════════════════════════════════════
--
-- (a) Both tables exist, RLS is on, and each has exactly one SELECT
--     policy and no write policy.
--
--   select relname, relrowsecurity, relforcerowsecurity
--   from pg_class
--   where relnamespace = 'public'::regnamespace
--     and relname in ('annual_plans', 'annual_plan_deliveries');
--
--   select tablename, policyname, cmd, roles, qual
--   from pg_policies
--   where schemaname = 'public'
--     and tablename in ('annual_plans', 'annual_plan_deliveries')
--   order by tablename, policyname;
--   -- expect exactly two rows, both cmd = SELECT
--
-- (b) The privileges are what section 5 audited. Expect EXACTLY four
--     rows: authenticated SELECT and service_role SELECT on each table.
--     No anon, and no INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES or
--     TRIGGER anywhere.
--
--   select table_name, grantee, privilege_type
--   from information_schema.role_table_grants
--   where table_schema = 'public'
--     and table_name in ('annual_plans', 'annual_plan_deliveries')
--     and grantee in ('anon', 'authenticated', 'service_role')
--   order by table_name, grantee, privilege_type;
--
-- (c) The same question asked of the raw ACL, which would also reveal a
--     grant to PUBLIC as a leading "=" entry.
--
--   select relname,
--          coalesce(array_to_string(relacl, E'\n'), '(no explicit acl)') as acl
--   from pg_class
--   where relnamespace = 'public'::regnamespace
--     and relname in ('annual_plans', 'annual_plan_deliveries');
--
-- (d) checkout_attempts gained exactly two columns and its privileges
--     are UNCHANGED from migration 023. Expect service_role with
--     INSERT, SELECT, UPDATE and no other grantee.
--
--   select column_name, data_type, is_nullable, column_default
--   from information_schema.columns
--   where table_schema = 'public' and table_name = 'checkout_attempts'
--     and column_name in ('annual_plan_id', 'annual_delivery_number');
--
--   select grantee, privilege_type
--   from information_schema.role_table_grants
--   where table_schema = 'public' and table_name = 'checkout_attempts'
--     and grantee in ('anon', 'authenticated', 'service_role')
--   order by grantee, privilege_type;
--
-- (e) public.orders gained NOTHING. Expect zero rows.
--
--   select column_name
--   from information_schema.columns
--   where table_schema = 'public' and table_name = 'orders'
--     and column_name like '%annual%';
--
-- (f) The uniqueness guarantees are in place. Expect four index rows.
--
--   select indexname, indexdef
--   from pg_indexes
--   where schemaname = 'public'
--     and indexname in ('annual_plans_stripe_payment_intent_id_key',
--                       'annual_plans_stripe_checkout_session_id_key',
--                       'checkout_attempts_annual_delivery_key',
--                       'annual_plan_deliveries_checkout_attempt_id_key')
--   order by indexname;
--
--   select conname, pg_get_constraintdef(oid)
--   from pg_constraint
--   where conrelid = 'public.annual_plan_deliveries'::regclass
--     and conname = 'annual_plan_deliveries_plan_number_key';
--
-- (g) The two CHECKs that keep the annual PaymentIntent off a delivery.
--
--   select conname, pg_get_constraintdef(oid)
--   from pg_constraint
--   where conrelid = 'public.checkout_attempts'::regclass
--     and conname in ('checkout_attempts_annual_delivery_paired_check',
--                     'checkout_attempts_annual_delivery_no_stripe_payment_check')
--   order by conname;
--
-- (h) delivery_count is pinned to 13 and the money identities hold.
--
--   select conname, pg_get_constraintdef(oid)
--   from pg_constraint
--   where conrelid = 'public.annual_plans'::regclass
--     and contype = 'c'
--   order by conname;
--
-- (i) Every new function is SECURITY DEFINER with an empty search_path,
--     and executable by service_role alone. Expect six rows, each with
--     prosecdef = true and proconfig = {search_path=}.
--
--   select p.proname, p.prosecdef, p.proconfig,
--          pg_get_function_identity_arguments(p.oid) as args,
--          coalesce(array_to_string(p.proacl, E'\n'), '(no explicit acl)') as acl
--   from pg_proc p
--   where p.pronamespace = 'public'::regnamespace
--     and p.proname in (
--       'create_pending_annual_plan_for_attempt',
--       'activate_annual_plan_from_payment',
--       'claim_due_annual_plan_deliveries',
--       'fulfill_annual_plan_delivery',
--       'apply_annual_plan_refund_state')
--   order by p.proname;
--   -- expect FIVE rows. prepare_annual_plan_delivery_attempt and
--   -- mark_annual_plan_delivery_fulfilled must NOT exist: Phase 4B1.1
--   -- replaced them with the atomic function above.
--
--   select count(*) as removed_composition_functions
--   from pg_proc
--   where pronamespace = 'public'::regnamespace
--     and proname in ('prepare_annual_plan_delivery_attempt',
--                     'mark_annual_plan_delivery_fulfilled');
--   -- expect 0
--
-- (j) Nothing was applied to data. Expect zero and zero.
--
--   select count(*) from public.annual_plans;
--   select count(*) from public.annual_plan_deliveries;
--
-- (k) The live refund writers are untouched and still exist exactly as
--     037 and 038 defined them. Expect two rows.
--
--   select p.proname, pg_get_function_identity_arguments(p.oid) as args
--   from pg_proc p
--   where p.pronamespace = 'public'::regnamespace
--     and p.proname in ('apply_order_refund_state',
--                       'apply_order_refund_state_by_invoice')
--   order by p.proname;
--
-- (l) The catalog is unchanged. Expect 30 g = 1999, 50 g = 2999,
--     100 g = 5499, all still active.
--
--   select v.sku, v.label, v.size_grams, v.price_gross_cents, v.is_active
--   from public.products p
--   join public.product_variants v on v.product_id = p.id
--   where p.slug = 'matcha'
--   order by v.sort_order;
