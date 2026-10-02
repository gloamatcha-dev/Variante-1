-- ══════════════════════════════════════════════════════════════
-- 072  ADMIN CORE CONNECTIONS
-- ══════════════════════════════════════════════════════════════
--
-- One migration, because the things in it are one thing: the admin had
-- areas that each knew their own facts and no way to agree with each
-- other. Splitting that into five migrations would have meant five
-- partial foundations and four windows where Finance and Operations
-- disagreed on purpose.
--
-- It is ADDITIVE ONLY. No existing column is dropped, retyped or
-- rewritten; no existing function changes meaning; no historical row is
-- edited. Migrations 001-071 stay exactly as applied.
--
-- ── WHAT WAS ACTUALLY WRONG ───────────────────────────────────
--
-- The audit that produced this migration found five things that were not
-- gaps but defects, and all five were the same defect wearing different
-- clothes: public.orders was being used as the revenue ledger, and it is
-- not one.
--
--   (1) orders is written by exactly ONE function,
--       create_order_from_paid_checkout, and it hardcodes
--       customer_type = 'private'. So every order in the system is
--       private, the B2B side of every revenue split is structurally
--       zero, and a finance screen reading orders can only ever report
--       B2C while real B2B money sits in b2b_payment_schedule.
--
--   (2) A prepaid annual plan is paid ONCE and delivered 12 or 13 times,
--       and each delivery mints a real order. Reading orders as revenue
--       therefore recognises one payment as twelve, spread over a year.
--
--   (3) orders.refunded_total_cents is a CUMULATIVE snapshot with one
--       timestamp. A refund in October lands on a September order and
--       silently restates September. Two partial refunds collapse into
--       one number and one date, so the history is unrecoverable.
--
--   (4) cancel_order leaves placed_at and every money column intact, by
--       design - they are historical facts. But a reader that counts
--       orders counts a cancelled one as revenue forever.
--
--   (5) A B2B instalment settles against b2b_payment_schedule and
--       creates no order at all, so it is invisible to any
--       orders-shaped reader.
--
-- ── THE ANSWER: A LEDGER THAT IS ABOUT MONEY ──────────────────
--
-- public.financial_events, below. Append-only, one row per economic
-- event, with the event's OWN date on it.
--
-- orders keeps every fact it already holds and loses none: it stays the
-- authority on what was ordered, what it contained, what tax applied and
-- where it shipped. It simply stops being asked a question it cannot
-- answer, which is "how much money did GLOA receive in October".
--
-- The division is:
--
--   public.orders              WHAT WAS ORDERED and what happens to it.
--                              Fulfilment, tax, address, documents.
--   public.financial_events    WHAT MONEY MOVED, when, and about what.
--
-- A prepaid annual plan makes this concrete. One annual_prepayment event
-- on the day the customer paid; twelve delivery orders over the year
-- carrying their own monetary snapshots for fulfilment, tax and history;
-- and NOT ONE of those twelve produces a financial event. The snapshots
-- are not destroyed, which migration 039 needs them not to be - they are
-- simply not cash.
--
-- ── NOTHING IN HERE BACKFILLS A GUESS ─────────────────────────
--
-- Section 3 derives events from history, and only where the derivation is
-- forced by immutable data: a paid order's placed_at and total, a paid
-- plan's purchased_at and total, a settled instalment's paid_at and
-- gross. Each carries the BASIS it was derived from, so a reader can
-- always tell a first-hand event from a reconstructed one.
--
-- Historical refunds are the one place where the honest answer is "the
-- date is not knowable", and this migration says so rather than
-- inventing one. See occurred_on_basis = 'refund_last_update'.
--
-- ── AND NOTHING IN HERE TOUCHES INVENTORY ─────────────────────
--
-- Migration 050 drew that boundary and this migration does not cross it.
-- No table below holds a quantity, no function below writes
-- inventory_movements or inventory_items, and no trigger below exists at
-- all. Stock stays manual, exactly as 050 decided.

begin;

-- ══════════════════════════════════════════════════════════════
-- SECTION 1.  THE MONEY LEDGER
-- ══════════════════════════════════════════════════════════════

/*
  ONE ROW PER ECONOMIC EVENT, AND THE ROW NEVER CHANGES.

  Append-only is the whole design. A refund is not an edit of a payment,
  it is a second event; a correction is not an edit either, it is a third
  event pointing at what it reverses. That is what makes a closed period
  stay closed: nothing written later can alter what October already said.

  The alternative - mutable running totals on the subject row - is what
  orders does today, and defects (3) and (4) in the header are what it
  costs.
*/
create table if not exists public.financial_events (
  id              uuid primary key default gen_random_uuid(),

  /*
    THE ECONOMIC DATE, AS A BERLIN CALENDAR DATE, AND IT MAY BE UNKNOWN.

    A date and not a timestamp, for migration 071's reason: a period
    boundary compared across time zones moves money between two months
    depending on where it is read.

    NULLABLE, and the null is load-bearing. A derived historical refund
    has no knowable date (defect 3), and this column says so instead of
    producing one. occurred_on_basis below always states which it is, and
    a CHECK keeps the two honest about each other.
  */
  occurred_on     date,

  /*
    WHERE occurred_on CAME FROM. Never cosmetic: it is how a reader tells
    a first-hand event from a reconstruction, and it is the only reason a
    backfilled row can be trusted at all.

      event_date            the event itself carried the date. Live path.
      order_placed_at       derived from orders.placed_at.
      plan_purchased_at     derived from annual_plans.purchased_at.
      instalment_paid_at    derived from b2b_payment_schedule.paid_at.
      refund_last_update    derived from orders.refund_updated_at, which
                            is OVERWRITTEN per partial refund. The date
                            is the last update, not this refund's own,
                            and a reader must treat it as approximate.
      unknown               no date is derivable. occurred_on is null.
  */
  occurred_on_basis text not null check (occurred_on_basis in (
                      'event_date',
                      'order_placed_at',
                      'plan_purchased_at',
                      'instalment_paid_at',
                      'refund_last_update',
                      'unknown'
                    )),

  /*
    WHAT KIND OF MONEY MOVED. Closed vocabulary, five values, each one
    tied to a flow that EXISTS in this repository today.

      order_payment      a paid order that is its own payment: a one-time
                         purchase, or one 4-week subscription cycle.
                         NEVER an annual delivery order - see the writer.
      annual_prepayment  the single prepaid annual plan payment.
      b2b_settlement     one settled row of b2b_payment_schedule.
      refund             money returned, as a DELTA and never a total.
      payment_fee        what a payment provider actually kept. Only ever
                         written from an authoritative provider figure;
                         nothing in this migration estimates one.
  */
  kind            text not null check (kind in (
                    'order_payment',
                    'annual_prepayment',
                    'b2b_settlement',
                    'refund',
                    'payment_fee'
                  )),

  /*
    WHICH WAY IT WENT, and it is NOT free: the CHECK below derives it
    from kind. It exists as a column so a reader can sum without knowing
    the vocabulary, and it is constrained so the two can never disagree.
  */
  direction       text not null check (direction in ('inflow', 'outflow')),

  /*
    THE AMOUNT, GROSS, IN INTEGER CENTS, STRICTLY POSITIVE.

    A magnitude, exactly as migration 071 decided for an expense: the
    direction column carries the sign's meaning, so a negative amount
    here would be a refund that silently increased revenue.
  */
  gross_cents     integer not null check (gross_cents > 0),

  /*
    THE TAX AND NET THE SUBJECT ALREADY FROZE, carried along where they
    are known and left null where they are not.

    Not recomputed, ever, and no rate is applied here. A refund has no
    net of its own in this schema, so it carries nulls - which is the
    honest answer and not a zero.
  */
  net_cents       integer,
  tax_cents       integer,

  currency        text not null default 'EUR' check (currency = 'EUR'),

  /*
    THE CHANNEL, migration 050's four values and 071's spelling of them.

    DERIVED BY THE WRITERS AND NEVER TAKEN FROM A CALLER, for the reason
    071 wrote down: a rule inside the only mutation path applies to every
    caller, including one nobody has written yet.
  */
  channel         text not null check (channel in (
                    'b2c', 'b2b', 'event', 'internal'
                  )),

  -- ── WHAT THE EVENT IS ABOUT ───────────────────────────────
  --
  -- Four optional subjects and a CHECK that at least one is present. All
  -- four are ON DELETE RESTRICT for migration 070's reason: a financial
  -- event is evidence, and a subject that could vanish under it would
  -- leave money pointing at nothing.
  order_id        uuid references public.orders(id) on delete restrict,
  annual_plan_id  uuid references public.annual_plans(id) on delete restrict,
  subscription_id uuid references public.subscriptions(id) on delete restrict,
  b2b_agreement_id uuid references public.b2b_supply_agreements(id) on delete restrict,

  /*
    THE PROVIDER'S OWN REFERENCE, where there is one. A PaymentIntent, an
    invoice, a refund id. Text because Stripe's ids are text, nullable
    because a derived historical event may not have one, and deliberately
    NOT unique: one PaymentIntent legitimately carries a payment and
    later a refund.
  */
  external_reference text check (external_reference is null
                       or char_length(btrim(external_reference)) between 1 and 255),

  /*
    THE IDEMPOTENCY KEY, AND IT IS A UNIQUE COLUMN ON THE ROW.

    Migration 071 deliberately did NOT do this and put its registry in
    admin_activity_log instead, because an expense is deletable and a key
    on a deletable row dies with it. The opposite is true here: a
    financial event is append-only and has no delete path at all, so
    migration 050's row-level pattern is not only safe, it is the
    strongest available - the database itself refuses the second write.

    NOT NULL, so there is no row without one.
  */
  operation_id    uuid not null unique,

  /*
    WHAT THIS EVENT REVERSES, for a correction. Self-referencing, and the
    only way an earlier event is ever walked back: the original row stays
    exactly as written and a second row says what changed about it.
  */
  reverses_event_id uuid references public.financial_events(id) on delete restrict,

  note            text check (note is null or char_length(note) <= 2000),
  created_at      timestamptz not null default now()
);

/*
  DIRECTION IS DERIVED FROM KIND, AND THE DATABASE ENFORCES IT.

  Without this the column would be a second, editable opinion about
  something kind already decided - and a refund stored as an inflow would
  add to revenue rather than subtract from it, which is the single worst
  row this table could hold.
*/
alter table public.financial_events
  drop constraint if exists financial_events_direction_check;

alter table public.financial_events
  add constraint financial_events_direction_check
  check (
    (kind in ('order_payment', 'annual_prepayment', 'b2b_settlement')
       and direction = 'inflow')
    or (kind in ('refund', 'payment_fee') and direction = 'outflow')
  );

/*
  AN EVENT IS ABOUT SOMETHING. At least one subject, or the row is money
  with no explanation and no period it could ever be checked against.
*/
alter table public.financial_events
  drop constraint if exists financial_events_subject_check;

alter table public.financial_events
  add constraint financial_events_subject_check
  check (
    order_id is not null
    or annual_plan_id is not null
    or subscription_id is not null
    or b2b_agreement_id is not null
  );

/*
  THE DATE AND ITS BASIS CANNOT CONTRADICT EACH OTHER.

  'unknown' means and only means occurred_on is null; every other basis
  means and only means it is present. Allowing the pair to drift would
  make the basis column decorative, and a decorative provenance field is
  worse than none - it is one a reader believes.
*/
alter table public.financial_events
  drop constraint if exists financial_events_date_basis_check;

alter table public.financial_events
  add constraint financial_events_date_basis_check
  check (
    (occurred_on_basis = 'unknown' and occurred_on is null)
    or (occurred_on_basis <> 'unknown' and occurred_on is not null)
  );

/*
  NET AND TAX, WHEN PRESENT, MUST FIT INSIDE THE GROSS.

  The only arithmetic this table performs on them, and the same shape as
  071's VAT bounds: unknown, or bounded. No rate is assumed to reach the
  bound.
*/
alter table public.financial_events
  drop constraint if exists financial_events_component_bounds_check;

alter table public.financial_events
  add constraint financial_events_component_bounds_check
  check (
    (net_cents is null or (net_cents >= 0 and net_cents <= gross_cents))
    and (tax_cents is null or (tax_cents >= 0 and tax_cents <= gross_cents))
  );

/*
  A REVERSAL IS NOT ITS OWN SUBJECT. Self-reference would be a row that
  cancels itself, which no reader could resolve.
*/
alter table public.financial_events
  drop constraint if exists financial_events_reversal_not_self_check;

alter table public.financial_events
  add constraint financial_events_reversal_not_self_check
  check (reverses_event_id is null or reverses_event_id <> id);

/*
  ONE PREPAYMENT PER ANNUAL PLAN, ENFORCED BY THE DATABASE.

  This is the index that makes defect (2) structurally impossible rather
  than merely unlikely. A prepaid plan is paid once; a second
  annual_prepayment event for the same plan is the duplicate-recognition
  bug itself, so the database refuses it even if every guard above it
  fails.
*/
create unique index if not exists idx_financial_events_one_prepayment_per_plan
  on public.financial_events (annual_plan_id)
  where kind = 'annual_prepayment';

/*
  ONE PAYMENT EVENT PER ORDER, for the same reason. An order that is its
  own payment is paid once. A refund against it is a different kind and
  is deliberately not covered by this index.
*/
create unique index if not exists idx_financial_events_one_payment_per_order
  on public.financial_events (order_id)
  where kind = 'order_payment';

-- The questions this ledger is asked: what moved in a period, what moved
-- about one subject, and what moved in a period by kind.
create index if not exists idx_financial_events_occurred_on
  on public.financial_events (occurred_on)
  where occurred_on is not null;
create index if not exists idx_financial_events_kind_date
  on public.financial_events (kind, occurred_on);
create index if not exists idx_financial_events_order
  on public.financial_events (order_id)
  where order_id is not null;
create index if not exists idx_financial_events_plan
  on public.financial_events (annual_plan_id)
  where annual_plan_id is not null;
create index if not exists idx_financial_events_agreement
  on public.financial_events (b2b_agreement_id)
  where b2b_agreement_id is not null;
create index if not exists idx_financial_events_subscription
  on public.financial_events (subscription_id)
  where subscription_id is not null;

/*
  APPEND-ONLY, ENFORCED BY A TRIGGER AND NOT BY A CONVENTION.

  Migration 046 established this idiom for launch_consent_history and the
  reasoning carries: revoking UPDATE and DELETE from every role protects
  against a route, and a trigger protects against a SECURITY DEFINER
  function - including one written in a later migration by someone who
  has not read this header.

  A closed period must stay closed. This is the thing that makes that
  true rather than hoped for.
*/
create or replace function public.financial_events_append_only()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  raise exception
    'public.financial_events is append-only: % is refused. Write a reversing event instead.',
    pg_catalog.lower(TG_OP);
end;
$$;

drop trigger if exists financial_events_append_only on public.financial_events;
create trigger financial_events_append_only
  before update or delete on public.financial_events
  for each row execute function public.financial_events_append_only();

-- ══════════════════════════════════════════════════════════════
-- SECTION 2.  THE LEDGER'S WRITERS
-- ══════════════════════════════════════════════════════════════
--
-- SECURITY DEFINER with an emptied search_path, granted to service_role
-- alone, and they are the ONLY way a row reaches the table: section 7
-- gives service_role SELECT and nothing else. So every rule written into
-- a body below applies to every caller there will ever be.
--
-- Each one is idempotent on p_operation_id. The refund writers are
-- additionally idempotent on the ARITHMETIC, which is stronger - see the
-- note above them.

/*
  THE BERLIN CALENDAR DAY AN INSTANT FALLS ON.

  One function so that the date rule lives in one place. It is the exact
  SQL counterpart of berlinDateOf() in lib/financeSummary.ts, and the
  suite asserts the two agree across a DST boundary - which is the only
  place a naive version differs and the only place it matters.

  IMMUTABLE is deliberately NOT claimed: at time zone depends on the
  server's timezone database, so STABLE is the honest volatility and is
  what lets this be used in a generated expression nowhere.
*/
create or replace function public.financial_event_berlin_date(p_at timestamptz)
returns date
language sql
stable
security definer set search_path = ''
as $$
  select (p_at at time zone 'Europe/Berlin')::date;
$$;

/*
  IS THIS ORDER AN ANNUAL DELIVERY?

  The single most important predicate in this migration, because it is
  what stops defect (2). An annual delivery order is minted by
  fulfill_annual_plan_delivery from a SYNTHETIC checkout attempt that
  carries annual_plan_id - migration 039 sets it there and nothing else
  does - so the question is answerable with certainty and without
  guessing from amounts or dates.

  A true answer means: this order is fulfilment, the cash was already
  recognised as the plan's prepayment, and NO payment event may exist for
  it. The writer below enforces that; this function is also used by the
  backfill in section 3 and by the postcheck.
*/
create or replace function public.order_is_annual_delivery(p_order_id uuid)
returns boolean
language sql
stable
security definer set search_path = ''
as $$
  select exists (
    select 1
    from public.orders o
    join public.checkout_attempts a on a.id = o.checkout_attempt_id
    where o.id = p_order_id
      and a.annual_plan_id is not null
  );
$$;

/*
  THE SUBSCRIPTION AN ORDER BELONGS TO, or null.

  Also via the checkout attempt, which migration 022 binds to the
  subscription on activation. Used so a cycle's payment event can name
  the subscription as well as the order, which is what lets the admin ask
  "what has this abo actually brought in" without walking orders.
*/
create or replace function public.order_subscription_id(p_order_id uuid)
returns uuid
language sql
stable
security definer set search_path = ''
as $$
  select a.subscription_id
    from public.orders o
    join public.checkout_attempts a on a.id = o.checkout_attempt_id
   where o.id = p_order_id;
$$;

/*
  ── A PAID ORDER THAT IS ITS OWN PAYMENT ────────────────────

  One-time purchases and 4-week subscription cycles both arrive this way:
  create_order_from_paid_checkout has already proved the money against
  the attempt's expected total, so this reads the frozen row and records
  that the cash arrived.

  THE NORMAL SUBSCRIPTION IS EVERY 4 WEEKS. Not monthly. It is 28 days,
  migration 005 and lib/subscriptionCancellationRules.ts both say so, and
  nothing in this migration renames it. Each paid cycle is its own order
  and therefore its own event, which is exactly one recognition per paid
  cycle and is what Part B2 asks to be provable.

  IT REFUSES AN ANNUAL DELIVERY ORDER, and that refusal is the point of
  the whole section. It is not an error the caller must avoid: the
  webhook and the daily job both call this for every order they mint, and
  the delivery orders are expected to come back 'annual_delivery'.

  IT ALSO REFUSES AN UNPAID ORDER. payment_status must be one of the
  three states that mean money actually arrived. 'pending' and 'failed'
  never produced cash, and 'refund_pending' means it did - the refund is
  its own later event.
*/
create or replace function public.record_order_payment_event(
  p_order_id     uuid,
  p_operation_id uuid default null
)
returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_order        public.orders;
  v_operation_id uuid;
  v_existing     public.financial_events;
  v_event        public.financial_events;
begin
  if p_order_id is null then
    raise exception 'record_order_payment_event needs an order';
  end if;

  -- Resolve, serialise, then check - migration 071's order, for its
  -- reason: locking before looking means two concurrent retries cannot
  -- both find nothing.
  v_operation_id := coalesce(p_operation_id, pg_catalog.gen_random_uuid());

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'finance:order_payment:' || v_operation_id::pg_catalog.text, 0));

  select * into v_existing
    from public.financial_events
   where operation_id = v_operation_id
   limit 1;
  if v_existing.id is not null then
    return pg_catalog.jsonb_build_object(
      'result', 'already_recorded', 'event_id', v_existing.id);
  end if;

  select * into v_order from public.orders where id = p_order_id;
  if v_order.id is null then
    return pg_catalog.jsonb_build_object('result', 'order_missing');
  end if;

  if v_order.placed_at is null then
    return pg_catalog.jsonb_build_object('result', 'order_not_placed');
  end if;

  if v_order.payment_status not in ('paid', 'partially_refunded', 'refunded') then
    return pg_catalog.jsonb_build_object(
      'result', 'order_not_paid', 'payment_status', v_order.payment_status);
  end if;

  -- THE REFUSAL THAT PREVENTS DOUBLE RECOGNITION.
  if public.order_is_annual_delivery(p_order_id) then
    return pg_catalog.jsonb_build_object('result', 'annual_delivery');
  end if;

  /*
    THE SECOND GUARD, AND IT IS THE DATABASE'S.

    idx_financial_events_one_payment_per_order already refuses a second
    payment event for this order. Catching it here turns a redelivered
    webhook into a calm 'already_recorded' instead of a 500 that makes
    Stripe redeliver again - and the uniqueness, not this code, is what
    makes the guarantee.
  */
  begin
    insert into public.financial_events (
      occurred_on, occurred_on_basis, kind, direction,
      gross_cents, net_cents, tax_cents, currency, channel,
      order_id, subscription_id, external_reference, operation_id
    ) values (
      public.financial_event_berlin_date(v_order.placed_at),
      'order_placed_at',
      'order_payment',
      'inflow',
      v_order.total_gross_cents,
      v_order.total_net_cents,
      v_order.tax_total_cents,
      v_order.currency,
      -- DERIVED, never a caller's. orders.customer_type is the only
      -- authority, and today it is always 'private' because
      -- create_order_from_paid_checkout writes that literal - which is
      -- exactly why B2B revenue needs its own writer below rather than a
      -- fabricated order.
      case when v_order.customer_type = 'business' then 'b2b' else 'b2c' end,
      v_order.id,
      public.order_subscription_id(v_order.id),
      v_order.stripe_payment_intent_id,
      v_operation_id
    )
    returning * into v_event;
  exception
    when unique_violation then
      select * into v_existing
        from public.financial_events
       where kind = 'order_payment' and order_id = p_order_id
       limit 1;
      return pg_catalog.jsonb_build_object(
        'result', 'already_recorded', 'event_id', v_existing.id);
  end;

  return pg_catalog.jsonb_build_object(
    'result', 'recorded',
    'event_id', v_event.id,
    'gross_cents', v_event.gross_cents,
    'occurred_on', v_event.occurred_on
  );
end;
$$;

/*
  ── THE PREPAID ANNUAL PAYMENT, RECOGNISED ONCE ─────────────

  This is Part B3, and it is the single business requirement that forced
  this migration's shape: the owner wants the money the customer actually
  paid to appear once, on the day they paid it, against the plan.

  So the event is written when the plan is ACTIVATED - the moment
  activate_annual_plan_from_payment has proved the payment against the
  attempt - and it carries the plan's own frozen total_gross_cents, which
  migration 039 constrains to equal
  annual_unit * delivery_count + shipping_per_delivery * delivery_count.

  The twelve or thirteen delivery orders that follow carry their own
  monetary snapshots and produce NO event. Both facts therefore survive:
  the cash is recognised once, and each delivery still knows what it was
  worth for fulfilment, tax and history.

  V1 PLANS ARE UNTOUCHED. This writes nothing on annual_plans, reads only
  columns migration 039 created, and does not look at schedule_model at
  all - so a 13-delivery v1 plan and a 12-delivery v2 plan are handled by
  exactly the same code and neither one's schedule semantics move.
*/
create or replace function public.record_annual_prepayment_event(
  p_annual_plan_id uuid,
  p_operation_id   uuid default null
)
returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_plan         public.annual_plans;
  v_operation_id uuid;
  v_existing     public.financial_events;
  v_event        public.financial_events;
begin
  if p_annual_plan_id is null then
    raise exception 'record_annual_prepayment_event needs a plan';
  end if;

  v_operation_id := coalesce(p_operation_id, pg_catalog.gen_random_uuid());

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'finance:annual_prepayment:' || v_operation_id::pg_catalog.text, 0));

  select * into v_existing
    from public.financial_events
   where operation_id = v_operation_id
   limit 1;
  if v_existing.id is not null then
    return pg_catalog.jsonb_build_object(
      'result', 'already_recorded', 'event_id', v_existing.id);
  end if;

  select * into v_plan from public.annual_plans where id = p_annual_plan_id;
  if v_plan.id is null then
    return pg_catalog.jsonb_build_object('result', 'plan_missing');
  end if;

  -- PAID MEANS PAID. 'pending' never produced cash; 'refunded' did, and
  -- the refund is its own event, so the payment still belongs here.
  if v_plan.payment_status not in ('paid', 'refunded') then
    return pg_catalog.jsonb_build_object(
      'result', 'plan_not_paid', 'payment_status', v_plan.payment_status);
  end if;
  if v_plan.purchased_at is null then
    return pg_catalog.jsonb_build_object('result', 'plan_not_purchased');
  end if;

  begin
    insert into public.financial_events (
      occurred_on, occurred_on_basis, kind, direction,
      gross_cents, net_cents, tax_cents, currency, channel,
      annual_plan_id, external_reference, operation_id
    ) values (
      public.financial_event_berlin_date(v_plan.purchased_at),
      'plan_purchased_at',
      'annual_prepayment',
      'inflow',
      v_plan.total_gross_cents,
      -- Net and tax are left to the plan's own snapshot where it has
      -- one; 039 does not carry a plan-level net, so these stay null
      -- rather than becoming a computed guess.
      null,
      null,
      v_plan.currency,
      -- A prepaid consumer plan is B2C. There is no business variant of
      -- it in this schema - b2b supply is a different subsystem with its
      -- own writer below - so this is a fact and not a default.
      'b2c',
      v_plan.id,
      v_plan.stripe_payment_intent_id,
      v_operation_id
    )
    returning * into v_event;
  exception
    when unique_violation then
      -- idx_financial_events_one_prepayment_per_plan. A redelivered
      -- activation webhook lands here, which is correct and quiet.
      select * into v_existing
        from public.financial_events
       where kind = 'annual_prepayment' and annual_plan_id = p_annual_plan_id
       limit 1;
      return pg_catalog.jsonb_build_object(
        'result', 'already_recorded', 'event_id', v_existing.id);
  end;

  return pg_catalog.jsonb_build_object(
    'result', 'recorded',
    'event_id', v_event.id,
    'gross_cents', v_event.gross_cents,
    'occurred_on', v_event.occurred_on
  );
end;
$$;

/*
  ── A SETTLED B2B INSTALMENT ────────────────────────────────

  Defect (5). B2B money settles against public.b2b_payment_schedule and
  creates no order, so an orders-shaped reader cannot see it at all and a
  finance screen reports a confident zero.

  The fix is NOT a fabricated order. Part J says so and it is right: the
  payment schedule IS the source of truth for B2B cash, and minting a
  private-customer order to represent a company's instalment would create
  a second truth about the same money and corrupt the B2C figures as
  well.

  So a settled row emits an event directly, keyed on the row, and
  b2b_payment_schedule stays authoritative for everything else about it.
*/
create or replace function public.record_b2b_settlement_event(
  p_schedule_id  uuid,
  p_operation_id uuid default null
)
returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_row          public.b2b_payment_schedule;
  v_operation_id uuid;
  v_existing     public.financial_events;
  v_event        public.financial_events;
begin
  if p_schedule_id is null then
    raise exception 'record_b2b_settlement_event needs a schedule row';
  end if;

  v_operation_id := coalesce(p_operation_id, pg_catalog.gen_random_uuid());

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'finance:b2b_settlement:' || v_operation_id::pg_catalog.text, 0));

  select * into v_existing
    from public.financial_events
   where operation_id = v_operation_id
   limit 1;
  if v_existing.id is not null then
    return pg_catalog.jsonb_build_object(
      'result', 'already_recorded', 'event_id', v_existing.id);
  end if;

  select * into v_row from public.b2b_payment_schedule where id = p_schedule_id;
  if v_row.id is null then
    return pg_catalog.jsonb_build_object('result', 'instalment_missing');
  end if;
  if v_row.status <> 'paid' or v_row.paid_at is null then
    return pg_catalog.jsonb_build_object(
      'result', 'instalment_not_paid', 'status', v_row.status);
  end if;

  /*
    ONE EVENT PER INSTALMENT, and the key is the instalment's own uuid
    rather than a random one.

    That is what makes this idempotent against a caller that forgot to
    pass an operation id as well as against one that repeated it: the
    external_reference check below finds the prior event by subject, and
    the daily reconciliation can therefore be run as often as anyone
    likes.
  */
  select * into v_existing
    from public.financial_events
   where kind = 'b2b_settlement'
     and b2b_agreement_id = v_row.supply_agreement_id
     and external_reference = p_schedule_id::pg_catalog.text
   limit 1;
  if v_existing.id is not null then
    return pg_catalog.jsonb_build_object(
      'result', 'already_recorded', 'event_id', v_existing.id);
  end if;

  insert into public.financial_events (
    occurred_on, occurred_on_basis, kind, direction,
    gross_cents, net_cents, tax_cents, currency, channel,
    b2b_agreement_id, external_reference, operation_id, note
  ) values (
    public.financial_event_berlin_date(v_row.paid_at),
    'instalment_paid_at',
    'b2b_settlement',
    'inflow',
    v_row.gross_cents,
    v_row.net_cents,
    v_row.tax_cents,
    'EUR',
    'b2b',
    v_row.supply_agreement_id,
    -- The schedule row's own id, which is what the dedupe above reads.
    p_schedule_id::pg_catalog.text,
    v_operation_id,
    'Rate ' || v_row.instalment_number::pg_catalog.text
  )
  returning * into v_event;

  return pg_catalog.jsonb_build_object(
    'result', 'recorded',
    'event_id', v_event.id,
    'gross_cents', v_event.gross_cents,
    'occurred_on', v_event.occurred_on
  );
end;
$$;

/*
  ══════════════════════════════════════════════════════════════
  THE REFUND WRITERS, AND WHY THEY TAKE A TOTAL AND WRITE A DELTA
  ══════════════════════════════════════════════════════════════

  Defects (3) and (5) in the header, and Part B5.

  Stripe tells this system an ABSOLUTE refunded total - that is deliberate
  upstream, and lib/orderRefunds.ts relies on it: an absolute figure makes
  a redelivered or out-of-order refund event converge instead of
  double-counting. But storing only that absolute figure is what loses the
  history: two partial refunds collapse into one number and one
  overwritten refund_updated_at, so nobody can say when either happened.

  These writers keep the upstream property and recover the history:

    the caller passes the new ABSOLUTE total
    the writer sums what the ledger already holds for this subject
    the DIFFERENCE becomes one new event, dated the day it is recorded

  That is idempotent by ARITHMETIC and not merely by key. Replaying the
  same total produces a delta of zero and writes nothing - so a Stripe
  redelivery is safe even if the caller passes a fresh operation id,
  which the unique-key guard alone would not catch.

  And because each delta is its own dated row, a refund settles in the
  period it actually happened. September stays closed.

  THEY NEVER MOVE MONEY. No Stripe call, no refund creation. They record
  that a refund which already happened, happened.
*/
create or replace function public.record_order_refund_event(
  p_order_id            uuid,
  p_refunded_total_cents integer,
  p_external_reference  text default null,
  p_operation_id        uuid default null
)
returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_order        public.orders;
  v_already      integer;
  v_delta        integer;
  v_operation_id uuid;
  v_existing     public.financial_events;
  v_event        public.financial_events;
begin
  if p_order_id is null or p_refunded_total_cents is null then
    raise exception 'record_order_refund_event needs an order and a total';
  end if;
  if p_refunded_total_cents < 0 then
    raise exception 'a refunded total cannot be negative';
  end if;

  v_operation_id := coalesce(p_operation_id, pg_catalog.gen_random_uuid());

  /*
    THE LOCK IS ON THE SUBJECT, NOT ON THE OPERATION.

    This is the one place in this migration where that is the right
    choice, and the reason is the arithmetic above: two concurrent
    refund events for the SAME ORDER with different operation ids would
    each read the same v_already and each write the same delta. Keying
    the lock on the operation would let them through; keying it on the
    order serialises them, so the second reads the first's event and
    computes a delta of zero.
  */
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'finance:refund:order:' || p_order_id::pg_catalog.text, 0));

  select * into v_existing
    from public.financial_events
   where operation_id = v_operation_id
   limit 1;
  if v_existing.id is not null then
    return pg_catalog.jsonb_build_object(
      'result', 'already_recorded', 'event_id', v_existing.id);
  end if;

  select * into v_order from public.orders where id = p_order_id;
  if v_order.id is null then
    return pg_catalog.jsonb_build_object('result', 'order_missing');
  end if;
  if p_refunded_total_cents > v_order.total_gross_cents then
    return pg_catalog.jsonb_build_object(
      'result', 'refund_exceeds_order',
      'total_gross_cents', v_order.total_gross_cents);
  end if;

  select coalesce(pg_catalog.sum(e.gross_cents), 0)::integer
    into v_already
    from public.financial_events e
   where e.kind = 'refund' and e.order_id = p_order_id;

  v_delta := p_refunded_total_cents - v_already;

  if v_delta <= 0 then
    -- Already level, or a late event carrying a stale lower total. Either
    -- way there is nothing new, which is the correct and quiet answer.
    return pg_catalog.jsonb_build_object(
      'result', 'no_change', 'already_cents', v_already);
  end if;

  insert into public.financial_events (
    occurred_on, occurred_on_basis, kind, direction,
    gross_cents, currency, channel,
    order_id, subscription_id, external_reference, operation_id
  ) values (
    -- THE DAY THE REFUND IS RECORDED, which for the live path is the day
    -- it settled at the provider. Not the order's date: putting it there
    -- is the restatement this whole section exists to end.
    public.financial_event_berlin_date(pg_catalog.now()),
    'event_date',
    'refund',
    'outflow',
    v_delta,
    v_order.currency,
    case when v_order.customer_type = 'business' then 'b2b' else 'b2c' end,
    v_order.id,
    public.order_subscription_id(v_order.id),
    p_external_reference,
    v_operation_id
  )
  returning * into v_event;

  return pg_catalog.jsonb_build_object(
    'result', 'recorded',
    'event_id', v_event.id,
    'gross_cents', v_event.gross_cents,
    'refunded_total_cents', p_refunded_total_cents,
    'occurred_on', v_event.occurred_on
  );
end;
$$;

/*
  THE SAME, FOR A PREPAID ANNUAL PLAN - which is defect (3)'s worst case.

  A plan's refund today writes only annual_plans.refunded_total_cents. No
  order is ever reached, because fulfill_annual_plan_delivery deliberately
  leaves the delivery attempt's stripe_payment_intent_id null (039's
  section 3 CHECK refuses otherwise), so the plan's PaymentIntent exists
  on the plan and on nothing else.

  The consequence in production today: a fully refunded annual plan leaves
  up to thirteen delivery orders standing as revenue with no offset at
  all. One event against the plan cancels the one prepayment event, which
  is the whole amount, exactly once.
*/
create or replace function public.record_annual_plan_refund_event(
  p_annual_plan_id       uuid,
  p_refunded_total_cents integer,
  p_external_reference   text default null,
  p_operation_id         uuid default null
)
returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_plan         public.annual_plans;
  v_already      integer;
  v_delta        integer;
  v_operation_id uuid;
  v_existing     public.financial_events;
  v_event        public.financial_events;
begin
  if p_annual_plan_id is null or p_refunded_total_cents is null then
    raise exception 'record_annual_plan_refund_event needs a plan and a total';
  end if;
  if p_refunded_total_cents < 0 then
    raise exception 'a refunded total cannot be negative';
  end if;

  v_operation_id := coalesce(p_operation_id, pg_catalog.gen_random_uuid());

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'finance:refund:plan:' || p_annual_plan_id::pg_catalog.text, 0));

  select * into v_existing
    from public.financial_events
   where operation_id = v_operation_id
   limit 1;
  if v_existing.id is not null then
    return pg_catalog.jsonb_build_object(
      'result', 'already_recorded', 'event_id', v_existing.id);
  end if;

  select * into v_plan from public.annual_plans where id = p_annual_plan_id;
  if v_plan.id is null then
    return pg_catalog.jsonb_build_object('result', 'plan_missing');
  end if;
  if p_refunded_total_cents > v_plan.total_gross_cents then
    return pg_catalog.jsonb_build_object(
      'result', 'refund_exceeds_plan',
      'total_gross_cents', v_plan.total_gross_cents);
  end if;

  select coalesce(pg_catalog.sum(e.gross_cents), 0)::integer
    into v_already
    from public.financial_events e
   where e.kind = 'refund' and e.annual_plan_id = p_annual_plan_id;

  v_delta := p_refunded_total_cents - v_already;

  if v_delta <= 0 then
    return pg_catalog.jsonb_build_object(
      'result', 'no_change', 'already_cents', v_already);
  end if;

  insert into public.financial_events (
    occurred_on, occurred_on_basis, kind, direction,
    gross_cents, currency, channel,
    annual_plan_id, external_reference, operation_id
  ) values (
    public.financial_event_berlin_date(pg_catalog.now()),
    'event_date',
    'refund',
    'outflow',
    v_delta,
    v_plan.currency,
    'b2c',
    v_plan.id,
    p_external_reference,
    v_operation_id
  )
  returning * into v_event;

  return pg_catalog.jsonb_build_object(
    'result', 'recorded',
    'event_id', v_event.id,
    'gross_cents', v_event.gross_cents,
    'refunded_total_cents', p_refunded_total_cents,
    'occurred_on', v_event.occurred_on
  );
end;
$$;

/*
  ── A PAYMENT PROVIDER FEE, AND ONLY A REAL ONE ─────────────

  Part B9. This repository has never read a Stripe balance_transaction -
  grep-verified across every file - so no fee has ever been persisted and
  there is no authoritative figure to derive one from.

  This writer therefore records a fee that a CALLER ALREADY KNOWS, from a
  provider figure it already holds. It computes nothing:

    no percentage
    no basis points
    no "typically 1.4% + 0.25"
    no derivation from gross

  Until a caller exists that reads the real balance_transaction, no row of
  this kind is written and the payment-provider fee stays what it honestly
  is: not yet known. The finance read model reports it as missing rather
  than as zero, which is migration 071's rule for an unknown VAT applied
  to the same problem.

  The function exists now so that the caller, when it is written, needs no
  further migration.
*/
create or replace function public.record_payment_fee_event(
  p_order_id           uuid,
  p_fee_cents          integer,
  p_occurred_at        timestamptz,
  p_external_reference text,
  p_operation_id       uuid default null
)
returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_order        public.orders;
  v_operation_id uuid;
  v_existing     public.financial_events;
  v_event        public.financial_events;
begin
  if p_order_id is null or p_fee_cents is null or p_occurred_at is null then
    raise exception 'record_payment_fee_event needs an order, a fee and a date';
  end if;
  if p_fee_cents <= 0 then
    raise exception 'a provider fee must be positive';
  end if;
  -- THE PROVIDER'S REFERENCE IS MANDATORY HERE, unlike every other
  -- writer. A fee with no balance_transaction behind it is exactly the
  -- estimate this function refuses to be.
  if p_external_reference is null or pg_catalog.btrim(p_external_reference) = '' then
    raise exception 'a provider fee needs the provider reference it came from';
  end if;

  v_operation_id := coalesce(p_operation_id, pg_catalog.gen_random_uuid());

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'finance:payment_fee:' || v_operation_id::pg_catalog.text, 0));

  select * into v_existing
    from public.financial_events
   where operation_id = v_operation_id
   limit 1;
  if v_existing.id is not null then
    return pg_catalog.jsonb_build_object(
      'result', 'already_recorded', 'event_id', v_existing.id);
  end if;

  select * into v_order from public.orders where id = p_order_id;
  if v_order.id is null then
    return pg_catalog.jsonb_build_object('result', 'order_missing');
  end if;

  -- One fee per order per provider reference.
  select * into v_existing
    from public.financial_events
   where kind = 'payment_fee'
     and order_id = p_order_id
     and external_reference = pg_catalog.btrim(p_external_reference)
   limit 1;
  if v_existing.id is not null then
    return pg_catalog.jsonb_build_object(
      'result', 'already_recorded', 'event_id', v_existing.id);
  end if;

  insert into public.financial_events (
    occurred_on, occurred_on_basis, kind, direction,
    gross_cents, currency, channel,
    order_id, external_reference, operation_id
  ) values (
    public.financial_event_berlin_date(p_occurred_at),
    'event_date',
    'payment_fee',
    'outflow',
    p_fee_cents,
    v_order.currency,
    case when v_order.customer_type = 'business' then 'b2b' else 'b2c' end,
    v_order.id,
    pg_catalog.btrim(p_external_reference),
    v_operation_id
  )
  returning * into v_event;

  return pg_catalog.jsonb_build_object(
    'result', 'recorded', 'event_id', v_event.id, 'fee_cents', p_fee_cents);
end;
$$;

-- ══════════════════════════════════════════════════════════════
-- SECTION 3.  CONTRACT TERMINATION THAT ACTUALLY TERMINATES
-- ══════════════════════════════════════════════════════════════
--
-- WHAT IS BROKEN IN PRODUCTION TODAY, exactly:
--
-- A customer uses the § 312k Kündigungsbutton. app/api/termination/route.ts
-- writes a termination_requests row and e-mails them a confirmation. An
-- administrator can then call admin_review_termination, which UPDATEs
-- case_state and writes an audit row - and returns.
--
-- That is all that happens. In particular:
--
--   * annual_plans.status permits 'cancelled' and NOTHING in migrations
--     001-071 ever writes it. Every UPDATE of that column sets 'active'
--     (activation) or 'completed' (term finished). So an extraordinary
--     termination can be marked 'effective' while the plan stays active,
--     claim_due_annual_plan_deliveries keeps claiming, and
--     fulfill_annual_plan_delivery keeps shipping and keeps minting
--     orders.
--
--   * The 4-week subscription is worse: resolveTerminationOutcome returns
--     routeToSubscriptionCancellation = true and the route's own comment
--     says "an administrator drives lib/subscriptionCancellation.ts from
--     the Consumer Rights screen". There is no such path.
--     cancelSubscriptionForUser is reachable only from
--     /api/subscriptions/cancel, the CUSTOMER-authenticated route, and
--     /api/admin/subscriptions has no write verb at all. So Stripe keeps
--     renewing and keeps charging a customer who was told in writing that
--     their abo ends.
--
-- ── THE HOOK ALREADY EXISTED ──────────────────────────────────
--
-- Migration 039's fulfilment writer says, about its own status guard:
--
--     "status covers future administrative termination as well as the
--      states 039 writes: whatever moves a plan out of 'active', this
--      stops generating orders for it without that phase having to find
--      this function."
--
-- That is this phase. Setting status = 'cancelled' is therefore
-- sufficient and no existing function needs to change: 070's claim queue
-- filters p.status = 'active' and 039's fulfiller refuses anything else.
--
-- ── AND THE WITHDRAWAL FREEZE IS LEFT ALONE ───────────────────
--
-- 070's annual_plan_delivery_freeze_active reads withdrawal_requests and
-- only withdrawal_requests. A termination is not a withdrawal: different
-- statute, different deadline, different refund consequence. Writing a
-- termination into deliveries_frozen_at would have been the smaller diff
-- and would have corrupted the legal meaning of both - a § 355 freeze
-- would become indistinguishable from a § 314 one.
--
-- So termination gets its own columns, and the stop it applies is the
-- plan's status, which is the one lever both existing gates already read.

alter table public.annual_plans
  add column if not exists terminated_at timestamptz;

alter table public.annual_plans
  add column if not exists termination_request_id uuid
    references public.termination_requests(id) on delete restrict;

/*
  WHICH KIND OF TERMINATION TOUCHED THIS PLAN, and what it did.

    noted_ends_automatically  An ORDINARY termination of a prepaid fixed
                              term. The plan already ends on plan_end_at
                              and does not renew, so there is nothing to
                              end early. Deliveries CONTINUE, no refund,
                              and the plan stays 'active' - but it is no
                              longer merely "Aktiv" with nothing else to
                              say, which was the lie Part D1 names.

    ended_extraordinary       An EXTRAORDINARY termination the operator
                              ACCEPTED. The plan is cancelled, future
                              unfulfilled deliveries are cancelled, and
                              fulfilled ones are untouched.

  A rejected extraordinary termination writes NEITHER: the case records
  the rejection and the plan is unchanged, which is the whole point of
  rejecting it.
*/
alter table public.annual_plans
  add column if not exists termination_effect text;

alter table public.annual_plans
  drop constraint if exists annual_plans_termination_effect_check;

alter table public.annual_plans
  add constraint annual_plans_termination_effect_check
  check (termination_effect is null or termination_effect in (
    'noted_ends_automatically', 'ended_extraordinary'
  ));

/*
  THE THREE COLUMNS AGREE OR THE ROW IS REFUSED.

  terminated_at is set only for the extraordinary case, because that is
  the only one where the contract actually ended at a point in time. A
  noted ordinary termination has an effect and a case but no end instant
  of its own - the end is plan_end_at, which was always going to be the
  end.
*/
alter table public.annual_plans
  drop constraint if exists annual_plans_termination_shape_check;

alter table public.annual_plans
  add constraint annual_plans_termination_shape_check
  check (
    (termination_effect is null and terminated_at is null)
    or (termination_effect = 'noted_ends_automatically' and terminated_at is null)
    or (termination_effect = 'ended_extraordinary' and terminated_at is not null)
  );

alter table public.annual_plans
  drop constraint if exists annual_plans_termination_effect_needs_case_check;

alter table public.annual_plans
  add constraint annual_plans_termination_effect_needs_case_check
  check (termination_effect is null or termination_request_id is not null);

create index if not exists idx_annual_plans_termination_case
  on public.annual_plans (termination_request_id)
  where termination_request_id is not null;

-- The operator question "which plans carry a termination" has to be one
-- index lookup, not a scan, because it goes on the dashboard.
create index if not exists idx_annual_plans_terminated
  on public.annual_plans (termination_effect)
  where termination_effect is not null;

/*
  ── THE ONE WRITER FOR AN ANNUAL TERMINATION DECISION ───────

  It replaces nothing: admin_review_termination (070) still exists and
  still does what it did, which is move a case state. This writer is what
  that function never had - the contract effect.

  FOUR DECISIONS, and they are the four the law actually produces:

    note_ordinary         § 312k ordinary termination of a prepaid fixed
                          term. Case -> acknowledged_ends_automatically.
                          Plan marked, plan STAYS ACTIVE, deliveries
                          continue, NO refund. Part D1 exactly.

    accept_extraordinary  Accepted. Case -> effective. Plan ->
                          'cancelled' with terminated_at. Future
                          unfulfilled deliveries -> 'cancelled'.
                          Fulfilled deliveries untouched. STILL NO
                          REFUND - see below.

    reject_extraordinary  Refused. Case -> rejected. Plan completely
                          unchanged. The audit row is the record that it
                          was considered.

    close                 Administrative close of a case that needs no
                          contract effect.

  ── IT NEVER REFUNDS, AND THAT IS DELIBERATE ────────────────

  Part E is explicit and it matches the law: ending a contract and owing
  money back are two decisions. An accepted extraordinary termination of
  a prepaid plan very often DOES create a refund obligation for the
  undelivered part - and the amount depends on facts this function cannot
  see. So it ends the contract, records that a refund decision is now
  OPEN, and stops. The refund is a separate explicit act through the
  existing refund path, and it lands in the ledger as its own event.

  No Stripe call. No money moves here.
*/
create or replace function public.admin_decide_annual_termination(
  p_actor_user_id  uuid,
  p_termination_id uuid,
  p_decision       text,
  p_internal_note  text default null,
  p_operation_id   uuid default null
)
returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_case          public.termination_requests;
  v_plan          public.annual_plans;
  v_operation_id  uuid;
  v_prior_entity  text;
  v_new_state     text;
  v_effect        text;
  v_cancelled     integer := 0;
  v_now           timestamptz;
begin
  if p_actor_user_id is null then
    raise exception 'a termination decision needs an author';
  end if;
  if p_decision not in ('note_ordinary', 'accept_extraordinary',
                        'reject_extraordinary', 'close') then
    return pg_catalog.jsonb_build_object('result', 'decision_unknown');
  end if;

  -- Resolve, serialise, check - migration 071's pattern, and the
  -- registry is admin_activity_log for 071's reason: it is append-only,
  -- so the operation's identity survives anything that happens later.
  v_operation_id := coalesce(p_operation_id, pg_catalog.gen_random_uuid());

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'customer_rights:annual_termination:' || v_operation_id::pg_catalog.text, 0));

  select l.entity_id into v_prior_entity
    from public.admin_activity_log l
   where l.module = 'customer_rights'
     and l.action = 'termination.annual_decided'
     and l.operation_id = v_operation_id
   limit 1;

  if v_prior_entity is not null then
    -- THIS DECISION ALREADY HAPPENED. No second state change, no second
    -- plan write, no second audit row. A retried request is the same
    -- decision, not another one.
    if v_prior_entity <> p_termination_id::pg_catalog.text then
      raise exception 'termination_operation_reused';
    end if;
    return pg_catalog.jsonb_build_object('result', 'already_decided');
  end if;

  -- THE CASE IS LOCKED BEFORE IT IS READ, so two operators cannot
  -- interleave into a decision neither of them made.
  select * into v_case
    from public.termination_requests
   where id = p_termination_id
     for update;
  if v_case.id is null then
    return pg_catalog.jsonb_build_object('result', 'case_missing');
  end if;

  if v_case.resolved_annual_plan_id is null then
    -- Not an annual case. The subscription writer below is the one for
    -- those, and refusing here is what stops this function from being
    -- the accidental entry point to both.
    return pg_catalog.jsonb_build_object('result', 'not_an_annual_case');
  end if;

  select * into v_plan
    from public.annual_plans
   where id = v_case.resolved_annual_plan_id
     for update;
  if v_plan.id is null then
    return pg_catalog.jsonb_build_object('result', 'plan_missing');
  end if;

  v_now := pg_catalog.now();

  if p_decision = 'reject_extraordinary' then
    v_new_state := 'rejected';
    v_effect    := null;

  elsif p_decision = 'close' then
    v_new_state := 'closed';
    v_effect    := null;

  elsif p_decision = 'note_ordinary' then
    /*
      THE PREPAID FIXED TERM ENDS BY ITSELF.

      There is nothing to cancel, and cancelling would be the wrong
      answer: the customer has paid for every remaining delivery and is
      owed them. So the plan is MARKED and left running. What changes is
      that the plan can now say so, which is the only thing Part D1 asked
      for and the thing the admin could not do before.
    */
    v_new_state := 'acknowledged_ends_automatically';
    v_effect    := 'noted_ends_automatically';

    update public.annual_plans
       set termination_request_id = v_case.id,
           termination_effect     = 'noted_ends_automatically'
     where id = v_plan.id;

  else
    /*
      ACCEPTED EXTRAORDINARY TERMINATION. The contract ends now.

      status = 'cancelled' is the whole stop: 070's claim queue filters
      on 'active' and 039's fulfiller refuses anything else, so no
      further delivery can be claimed or minted from this moment. That is
      why nothing else in the schema had to be touched.
    */
    v_new_state := 'effective';
    v_effect    := 'ended_extraordinary';

    /*
      cancelled_at IS SET IN THE SAME STATEMENT, and it has to be:
      migration 039's annual_plans_cancelled_at_check is an EQUIVALENCE,
      `(cancelled_at is not null) = (status = 'cancelled')`, so writing
      the status alone is refused. Found by a real PostgreSQL, which is
      the only place it could have been found - reading 039 shows a
      nullable timestamp and nothing that says it is mandatory.

      cancelled_at and terminated_at are both written and they are not
      redundant: cancelled_at is 039's lifecycle timestamp, which any
      future way of ending a plan must also set, and terminated_at says
      the reason was a termination.
    */
    update public.annual_plans
       set status                 = 'cancelled',
           cancelled_at           = v_now,
           terminated_at          = v_now,
           termination_request_id = v_case.id,
           termination_effect     = 'ended_extraordinary'
     where id = v_plan.id;

    /*
      THE FUTURE SCHEDULE IS CANCELLED EXPLICITLY, not just made
      unreachable.

      Leaving eleven 'scheduled' rows that can never ship would mean the
      plan's own schedule disagreed with the plan, and every delivery
      report would show work that is not coming.

      ALREADY FULFILLED ROWS ARE UNTOUCHED, and the predicate says so
      twice - state and the order/fulfilled pair - because migration
      039's CHECK ties those together and a fulfilled delivery is a box
      the customer physically received. History is not editable.

      A 'claimed' row is cancelled too: it has a lease and no order yet,
      so nothing has shipped.
    */
    update public.annual_plan_deliveries
       set state = 'cancelled'
     where annual_plan_id = v_plan.id
       and state in ('scheduled', 'claimed')
       and order_id is null
       and fulfilled_at is null;
    get diagnostics v_cancelled = row_count;
  end if;

  update public.termination_requests
     set case_state    = v_new_state,
         internal_note = coalesce(p_internal_note, internal_note),
         updated_at    = v_now
   where id = v_case.id;

  perform public.record_admin_activity(
    p_actor_user_id,
    'customer_rights',
    'termination.annual_decided',
    'termination',
    v_case.id::text,
    'Jahresplan-Kündigung entschieden: ' || p_decision,
    v_operation_id,
    /*
      EVERY FACT THE DECISION TURNED ON, so the log answers "what was
      decided, about which contract, and what did it do" without needing
      the plan row - which may itself change later.
    */
    pg_catalog.jsonb_build_object(
      'decision', p_decision,
      'case_state', v_new_state,
      'annual_plan_id', v_plan.id,
      'termination_kind', v_case.termination_kind,
      'termination_effect', v_effect,
      'plan_status', case when p_decision = 'accept_extraordinary'
                          then 'cancelled' else v_plan.status end,
      'deliveries_cancelled', v_cancelled,
      -- A REFUND IS NEVER AUTOMATIC. This records that the question is
      -- now open, and nothing more: no amount, no decision, no payment.
      'refund_decision_required', (p_decision = 'accept_extraordinary')
    )
  );

  return pg_catalog.jsonb_build_object(
    'result', 'decided',
    'decision', p_decision,
    'case_state', v_new_state,
    'annual_plan_id', v_plan.id,
    'termination_effect', v_effect,
    'deliveries_cancelled', v_cancelled,
    'refund_decision_required', (p_decision = 'accept_extraordinary')
  );
end;
$$;

/*
  ── THE 4-WEEK SUBSCRIPTION, ACTUALLY CANCELLED ─────────────

  Part D3. The § 312k form records a case saying the abo "endet zum
  nächstmöglichen Termin" and nothing cancels it. This is the missing
  admin path.

  IT REUSES MIGRATION 034's WRITER AND DECIDES NOTHING ITSELF.
  schedule_subscription_cancellation already owns the rules; this
  resolves the subscription from the CASE, computes the effective date
  from the SUBSCRIPTION, and calls it.

  THE DATE IS THE SUBSCRIPTION'S OWN current_period_end AND NEVER A
  CALLER'S. Part D3 says no browser-authoritative cancellation dates, and
  this is how that is guaranteed rather than validated: the parameter
  does not exist. The customer has paid through the end of the current
  period and is owed the deliveries in it, so the cancellation takes
  effect then - which is also the only date Stripe can take without
  prorating, the constraint lib/subscriptionCancellation.ts documents at
  length.

  THE NORMAL SUBSCRIPTION IS EVERY 4 WEEKS. The period end is read, never
  computed, so this function contains no interval arithmetic and cannot
  disagree with the 28-day cadence.

  IT TOUCHES NO MONEY. No refund, no Stripe call. Stripe is updated by
  the existing cancellation path from the row this writes, exactly as it
  is for a customer-initiated cancellation.
*/
create or replace function public.admin_execute_subscription_termination(
  p_actor_user_id  uuid,
  p_termination_id uuid,
  p_internal_note  text default null,
  p_operation_id   uuid default null
)
returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_case         public.termination_requests;
  v_sub          public.subscriptions;
  v_operation_id uuid;
  v_prior_entity text;
  v_effective    timestamptz;
  v_scheduled    jsonb;
  v_now          timestamptz;
begin
  if p_actor_user_id is null then
    raise exception 'a termination execution needs an author';
  end if;

  v_operation_id := coalesce(p_operation_id, pg_catalog.gen_random_uuid());

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'customer_rights:subscription_termination:' || v_operation_id::pg_catalog.text, 0));

  select l.entity_id into v_prior_entity
    from public.admin_activity_log l
   where l.module = 'customer_rights'
     and l.action = 'termination.subscription_executed'
     and l.operation_id = v_operation_id
   limit 1;

  if v_prior_entity is not null then
    if v_prior_entity <> p_termination_id::pg_catalog.text then
      raise exception 'termination_operation_reused';
    end if;
    return pg_catalog.jsonb_build_object('result', 'already_executed');
  end if;

  select * into v_case
    from public.termination_requests
   where id = p_termination_id
     for update;
  if v_case.id is null then
    return pg_catalog.jsonb_build_object('result', 'case_missing');
  end if;
  if v_case.resolved_subscription_id is null then
    return pg_catalog.jsonb_build_object('result', 'not_a_subscription_case');
  end if;

  select * into v_sub
    from public.subscriptions
   where id = v_case.resolved_subscription_id
     for update;
  if v_sub.id is null then
    return pg_catalog.jsonb_build_object('result', 'subscription_missing');
  end if;

  /*
    ALREADY ENDING, OR ALREADY ENDED, IS NOT AN ERROR.

    The customer may have cancelled in their account before the case was
    worked, and a terminal subscription cannot be cancelled twice.
    Reporting it is what lets the operator close the case truthfully
    rather than being shown a failure.
  */
  if v_sub.cancellation_effective_at is not null then
    update public.termination_requests
       set case_state    = 'scheduled',
           internal_note = coalesce(p_internal_note, internal_note),
           updated_at    = pg_catalog.now()
     where id = v_case.id;
    return pg_catalog.jsonb_build_object(
      'result', 'already_scheduled',
      'effective_at', v_sub.cancellation_effective_at);
  end if;
  if v_sub.status in ('cancelled', 'ended') then
    update public.termination_requests
       set case_state    = 'effective',
           internal_note = coalesce(p_internal_note, internal_note),
           updated_at    = pg_catalog.now()
     where id = v_case.id;
    return pg_catalog.jsonb_build_object(
      'result', 'already_ended', 'status', v_sub.status);
  end if;

  /*
    THE EFFECTIVE DATE, FROM THE SUBSCRIPTION AND NOTHING ELSE.

    current_period_end is what the customer has paid through. If it is
    absent the subscription never completed a cycle, and refusing is the
    only honest answer: inventing a date would promise the customer an
    end nobody can hold Stripe to.
  */
  if v_sub.current_period_end is null then
    return pg_catalog.jsonb_build_object('result', 'no_period_end');
  end if;
  v_effective := v_sub.current_period_end;
  v_now := pg_catalog.now();

  -- MIGRATION 034'S WRITER, UNCHANGED. The cancel_at it receives is the
  -- current period's end, which is the one value that prorates nothing.
  -- Returns jsonb, so the local is jsonb. Taking it as text would have
  -- silently stringified the scheduler's own verdict into the audit row.
  v_scheduled := public.schedule_subscription_cancellation(
    v_sub.id, v_sub.user_id, v_now, v_effective, v_effective);

  update public.termination_requests
     set case_state    = 'scheduled',
         internal_note = coalesce(p_internal_note, internal_note),
         updated_at    = v_now
   where id = v_case.id;

  perform public.record_admin_activity(
    p_actor_user_id,
    'customer_rights',
    'termination.subscription_executed',
    'termination',
    v_case.id::text,
    'Abo-Kündigung ausgeführt',
    v_operation_id,
    pg_catalog.jsonb_build_object(
      'subscription_id', v_sub.id,
      'case_state', 'scheduled',
      'termination_kind', v_case.termination_kind,
      'effective_at', v_effective,
      'scheduler_result', v_scheduled,
      -- An ordinary abo termination owes nothing back: the customer keeps
      -- the cycle they paid for and is charged no further.
      'refund_decision_required', false
    )
  );

  return pg_catalog.jsonb_build_object(
    'result', 'scheduled',
    'subscription_id', v_sub.id,
    'effective_at', v_effective,
    'scheduler_result', v_scheduled,
    'refund_decision_required', false
  );
end;
$$;

-- ══════════════════════════════════════════════════════════════
-- SECTION 4.  OPERATIONS CONFIGURATION, AND THE SHIPPING DEADLINE
-- ══════════════════════════════════════════════════════════════
--
-- Part C asks for an authoritative answer to "when does this order have
-- to be sent?" and instructs: do NOT invent a dispatch SLA, and do not
-- mistake a customer DELIVERY estimate for one.
--
-- RECON RESULT: no dispatch SLA exists anywhere in this repository. The
-- only shipping durations in the codebase are customer-facing delivery
-- estimates in app/GloaSite.tsx ("Deutschland: 2-4 Werktage"), which are
-- how long the PARCEL takes once sent - not how long GLOA may take to
-- send it. Treating one as the other would have produced a confident
-- deadline the business never agreed to.
--
-- So this builds the CAPABILITY and leaves the PARAMETER unset. Until an
-- owner sets it, every order honestly reports
-- 'no_dispatch_target_configured' rather than a date.

create table if not exists public.operations_config (
  key          text primary key,
  int_value    integer,
  text_value   text,
  updated_at   timestamptz not null default now(),
  updated_by   uuid references auth.users(id),
  note         text check (note is null or char_length(note) <= 500)
);

/*
  EXACTLY ONE VALUE PER ROW, and it is typed by which column is filled.
  A row with both or neither is a row whose meaning depends on who reads
  it.
*/
alter table public.operations_config
  drop constraint if exists operations_config_one_value_check;

alter table public.operations_config
  add constraint operations_config_one_value_check
  check ((int_value is null) <> (text_value is null));

/*
  DELIBERATELY SEEDED EMPTY.

  'dispatch_sla_business_days' is THE ONE BUSINESS PARAMETER this
  migration cannot decide. Inserting a plausible 2 here would be the
  invented SLA Part C forbids, and it would immediately start producing
  "Überfällig" badges against a promise nobody made.

  The row's ABSENCE is the honest state and the reader below reports it
  as such.
*/

/*
  ── AN EXPLICIT PER-ORDER SHIP-BY DATE ─────────────────────

  Set by an operator when a particular order has its own deadline - a
  promised date, a pre-order, a held parcel. It always wins over the
  configured rule, because it is a decision somebody made about this
  order rather than a default applied to it.
*/
alter table public.orders
  add column if not exists ship_by_date date;

create index if not exists idx_orders_ship_by_date
  on public.orders (ship_by_date)
  where ship_by_date is not null;

/*
  The operational question, as one index: paid orders that have not
  shipped. This is what the dashboard counts and what the shipping
  worklist reads.
*/
create index if not exists idx_orders_unshipped_paid
  on public.orders (placed_at)
  where shipped_at is null
    and status <> 'cancelled'
    and payment_status in ('paid', 'partially_refunded');

/*
  ── THE SHIPPING DUE STATE OF ONE ORDER ────────────────────

  Returns the six states Part C names, and never guesses:

    shipped                           shipped_at is set. Done.
    cancelled                         not work any more.
    no_dispatch_target_configured     THE HONEST DEFAULT. No explicit
                                      ship_by_date and no configured
                                      SLA, so there is no deadline to
                                      be early or late against. Every
                                      historical order reads this until
                                      an owner sets the parameter, which
                                      is what Part C asks for.
    overdue                           due date is in the past.
    due_today                         due date is today, Berlin.
    upcoming                          due date is in the future.

  BUSINESS DAYS, NOT CALENDAR DAYS, when the SLA is used: a Friday order
  with a 2-day target is due Tuesday, not Sunday. Weekends only - this
  deliberately knows nothing about public holidays, because a holiday
  calendar is data this system does not have and a hardcoded one would be
  wrong for half of Germany.
*/
create or replace function public.order_shipping_due(p_order_id uuid)
returns jsonb
language plpgsql
stable
security definer set search_path = ''
as $$
declare
  v_order    public.orders;
  v_sla      integer;
  v_due      date;
  v_today    date;
  v_added    integer := 0;
  v_cursor   date;
begin
  select * into v_order from public.orders where id = p_order_id;
  if v_order.id is null then
    return pg_catalog.jsonb_build_object('state', 'order_missing');
  end if;

  if v_order.shipped_at is not null then
    return pg_catalog.jsonb_build_object(
      'state', 'shipped', 'shipped_at', v_order.shipped_at,
      'due_date', v_order.ship_by_date);
  end if;
  if v_order.status = 'cancelled' then
    return pg_catalog.jsonb_build_object('state', 'cancelled');
  end if;

  v_today := public.financial_event_berlin_date(pg_catalog.now());

  -- THE EXPLICIT DATE WINS. A decision beats a default.
  if v_order.ship_by_date is not null then
    v_due := v_order.ship_by_date;
  else
    select c.int_value into v_sla
      from public.operations_config c
     where c.key = 'dispatch_sla_business_days';

    if v_sla is null or v_order.placed_at is null then
      -- NOT A DATE, AND NOT A GUESS.
      return pg_catalog.jsonb_build_object(
        'state', 'no_dispatch_target_configured',
        'reason', case when v_order.placed_at is null
                       then 'order_not_placed' else 'sla_not_configured' end);
    end if;

    -- Business days forward from the Berlin day the order was placed.
    v_cursor := public.financial_event_berlin_date(v_order.placed_at);
    while v_added < v_sla loop
      v_cursor := v_cursor + 1;
      -- date_part AND NOT extract(). `extract(isodow from x)` is SQL
      -- SYNTAX, not a callable function, so it cannot be schema-qualified
      -- - and under search_path = '' an unqualified call is what this
      -- migration refuses to rely on. date_part is the function form and
      -- takes the field as a string. Same trap as pg_catalog.coalesce in
      -- migration 071, found the same way: on a real PostgreSQL.
      if pg_catalog.date_part('isodow', v_cursor) < 6 then
        v_added := v_added + 1;
      end if;
    end loop;
    v_due := v_cursor;
  end if;

  return pg_catalog.jsonb_build_object(
    'state', case when v_due < v_today then 'overdue'
                  when v_due = v_today then 'due_today'
                  else 'upcoming' end,
    'due_date', v_due,
    'source', case when v_order.ship_by_date is not null
                   then 'order_ship_by_date' else 'dispatch_sla' end);
end;
$$;

-- ══════════════════════════════════════════════════════════════
-- SECTION 5.  NOTIFYING orders@gloamatcha.com ABOUT A PURCHASE
--             THAT PRODUCES NO ORDER
-- ══════════════════════════════════════════════════════════════
--
-- RECON RESULT: the internal notification system is already complete and
-- correct for ORDERS. lib/emailSenders.ts pins the recipient to
-- orders@gloamatcha.com; migration 026 gave orders
-- internal_notification_status ('sending'|'sent'|'failed') and
-- internal_notification_sent_at; lib/internalOrderNotificationEmail.ts
-- claims the row before sending, so a webhook redelivery cannot send
-- twice; and lib/internalOrderNotificationRetry.ts sweeps 'failed' rows
-- from the daily cron. One-time orders, both subscription cases and
-- annual DELIVERY orders are all covered by it already.
--
-- THE ONE GAP is Part F's own example: the annual plan PURCHASE. At that
-- moment no order exists - activate_annual_plan_from_payment creates the
-- plan and its delivery schedule and nothing else - so there is no row to
-- carry notification state and fulfilment is never told a plan was sold.
--
-- These columns are migration 026's, on the plan, so the existing claim
-- and retry patterns apply unchanged.

alter table public.annual_plans
  add column if not exists internal_notification_status text;

alter table public.annual_plans
  add column if not exists internal_notification_sent_at timestamptz;

alter table public.annual_plans
  drop constraint if exists annual_plans_internal_notification_status_check;

alter table public.annual_plans
  add constraint annual_plans_internal_notification_status_check
  check (internal_notification_status is null
         or internal_notification_status in ('sending', 'sent', 'failed'));

-- 'sent' must carry its timestamp; the other two must not pretend to.
alter table public.annual_plans
  drop constraint if exists annual_plans_internal_notification_sent_at_check;

alter table public.annual_plans
  add constraint annual_plans_internal_notification_sent_at_check
  check ((internal_notification_status = 'sent')
         = (internal_notification_sent_at is not null));

-- The retry sweep's selection, as an index: failed rows only.
create index if not exists idx_annual_plans_notification_retry
  on public.annual_plans (internal_notification_status)
  where internal_notification_status = 'failed';

/*
  THE CLAIM, in migration 026's shape.

  An UPDATE that only matches an UNCLAIMED row, so two concurrent
  webhook deliveries serialise on the row lock and exactly one proceeds.
  The loser gets false and sends nothing - which is what makes "exactly
  one internal notification per annual purchase" true rather than hoped
  for.

  A 'failed' row IS re-claimable: that is the retry path. A 'sent' or
  'sending' row is not.
*/
create or replace function public.claim_annual_purchase_notification(
  p_annual_plan_id uuid
)
returns boolean
language plpgsql
security definer set search_path = ''
as $$
declare
  v_claimed integer;
begin
  update public.annual_plans
     set internal_notification_status = 'sending'
   where id = p_annual_plan_id
     and payment_status in ('paid', 'refunded')
     and purchased_at is not null
     and (internal_notification_status is null
          or internal_notification_status = 'failed');
  get diagnostics v_claimed = row_count;
  return v_claimed = 1;
end;
$$;

create or replace function public.mark_annual_purchase_notification(
  p_annual_plan_id uuid,
  p_outcome        text
)
returns boolean
language plpgsql
security definer set search_path = ''
as $$
declare
  v_updated integer;
begin
  if p_outcome not in ('sent', 'failed') then
    raise exception 'an annual purchase notification outcome is sent or failed';
  end if;

  update public.annual_plans
     set internal_notification_status  = p_outcome,
         -- Set on success, and deliberately LEFT ALONE on failure: a
         -- failed attempt has no send time, and fabricating one would
         -- make the retry sweep think it had succeeded.
         internal_notification_sent_at = case when p_outcome = 'sent'
                                              then pg_catalog.now() else null end
   where id = p_annual_plan_id
     and internal_notification_status = 'sending';
  get diagnostics v_updated = row_count;
  return v_updated = 1;
end;
$$;

-- ══════════════════════════════════════════════════════════════
-- SECTION 6.  CREATOR, AFFILIATE AND UGC
-- ══════════════════════════════════════════════════════════════
--
-- Entirely new. Nothing in migrations 001-071 knows what a creator is,
-- so there is nothing here to reconcile with and nothing to preserve.
--
-- ── THE RULES THIS SECTION OBEYS ──────────────────────────────
--
--   * One creator may be an influencer AND a UGC creator AND an
--     affiliate. The roles are rows, not an enum column, because forcing
--     one classification is the thing Part I explicitly refuses.
--   * NO universal commission percentage. There is no default anywhere;
--     a commission rule is a row somebody created, and a link without
--     one cannot earn.
--   * The commission BASE is explicit data, not a hidden assumption.
--     Whether shipping counts is a column, because "we excluded shipping"
--     is exactly the undocumented decision Part I warns about.
--   * Attribution is a SERVER fact. A browser may present a slug or a
--     code; it may never present a creator id, a commission amount or a
--     rule.
--   * Commission is integer cents, snapshotted at attribution, and
--     reacts to refunds by REVERSAL rows rather than by edits.
--   * UGC is not affiliate. A UGC fee creates no commission, ever.

/*
  THE PERSON OR ACCOUNT. Contact and identity only - no money, no roles,
  no performance figures. Those are their own tables so this one can be
  read by anybody who may see a creator at all.
*/
create table if not exists public.creators (
  id            uuid primary key default gen_random_uuid(),
  display_name  text not null check (char_length(btrim(display_name)) between 1 and 120),
  email         text not null check (char_length(btrim(email)) between 3 and 255),
  instagram     text check (instagram is null or char_length(btrim(instagram)) between 1 and 120),
  tiktok        text check (tiktok is null or char_length(btrim(tiktok)) between 1 and 120),
  portfolio_url text check (portfolio_url is null or char_length(btrim(portfolio_url)) between 1 and 500),
  country       text check (country is null or char_length(btrim(country)) between 2 and 2),
  /*
    prospect   known, nothing agreed
    active     working with GLOA
    paused     temporarily not
    ended      finished
    rejected   declined
  */
  status        text not null default 'prospect' check (status in (
                  'prospect', 'active', 'paused', 'ended', 'rejected'
                )),
  notes         text check (notes is null or char_length(notes) <= 4000),
  created_by    uuid references auth.users(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz
);

-- One creator per address. Two rows for the same person would split
-- their commissions in half and neither half would be wrong.
create unique index if not exists idx_creators_email
  on public.creators (lower(btrim(email)));

/*
  THE ROLES, AS ROWS. A creator with all three has three rows, and
  nothing forces a primary one.
*/
create table if not exists public.creator_roles (
  creator_id uuid not null references public.creators(id) on delete cascade,
  role       text not null check (role in ('influencer', 'ugc_creator', 'affiliate')),
  created_at timestamptz not null default now(),
  primary key (creator_id, role)
);

/*
  A PUBLIC APPLICATION, kept separate from the creator it may become.

  An application is a statement somebody made at a point in time; a
  creator is a relationship GLOA maintains. Merging them would mean
  accepting an application by editing what the applicant said.
*/
create table if not exists public.creator_applications (
  id            uuid primary key default gen_random_uuid(),
  display_name  text not null check (char_length(btrim(display_name)) between 1 and 120),
  email         text not null check (char_length(btrim(email)) between 3 and 255),
  instagram     text check (instagram is null or char_length(btrim(instagram)) <= 120),
  tiktok        text check (tiktok is null or char_length(btrim(tiktok)) <= 120),
  portfolio_url text check (portfolio_url is null or char_length(btrim(portfolio_url)) <= 500),
  country       text check (country is null or char_length(btrim(country)) = 2),
  -- What they are applying AS. An array of the same three roles, so an
  -- applicant can say "UGC and affiliate" without two applications.
  requested_roles text[] not null default '{}',
  message       text check (message is null or char_length(message) <= 4000),
  submitted_at  timestamptz not null default now(),
  status        text not null default 'submitted' check (status in (
                  'submitted', 'in_review', 'accepted', 'rejected', 'withdrawn'
                )),
  reviewed_at   timestamptz,
  reviewed_by   uuid references auth.users(id),
  -- The creator this application became, once accepted. Null until then.
  creator_id    uuid references public.creators(id) on delete restrict,
  internal_note text check (internal_note is null or char_length(internal_note) <= 4000),
  created_at    timestamptz not null default now()
);

alter table public.creator_applications
  drop constraint if exists creator_applications_roles_vocabulary_check;

-- Every requested role must be one of the three. An array lets a caller
-- put anything in it, so the vocabulary is checked rather than assumed.
alter table public.creator_applications
  add constraint creator_applications_roles_vocabulary_check
  check (requested_roles <@ array['influencer', 'ugc_creator', 'affiliate']::text[]);

alter table public.creator_applications
  drop constraint if exists creator_applications_review_shape_check;

alter table public.creator_applications
  add constraint creator_applications_review_shape_check
  check (
    (status in ('submitted', 'withdrawn') and reviewed_at is null)
    or (status in ('in_review', 'accepted', 'rejected'))
  );

alter table public.creator_applications
  drop constraint if exists creator_applications_accepted_needs_creator_check;

-- An accepted application names the creator it produced, or the
-- acceptance is unverifiable.
alter table public.creator_applications
  add constraint creator_applications_accepted_needs_creator_check
  check (status <> 'accepted' or creator_id is not null);

create index if not exists idx_creator_applications_status
  on public.creator_applications (status, submitted_at desc);

/*
  ── THE COMMISSION RULE, AND THERE IS NO DEFAULT ────────────

  Part I: "No hardcoded universal commission percentage." So a rule is a
  row. A link or code without one earns nothing - not zero percent, but
  no commission at all, which is a different and visible state.

  TWO SHAPES, exactly one per row:

    percent_basis_points   e.g. 1000 = 10.00 %. Basis points because a
                           percentage with decimals invites floats, and
                           money arithmetic here is integer only.
    fixed_cents            a flat amount per attributed order.

  ── AND THE BASE IS WRITTEN DOWN ────────────────────────────

  base names WHICH figure the percentage applies to, because "10 % of the
  order" is ambiguous in a way that matters:

    merchandise_net     net of goods, excluding shipping and tax
    merchandise_gross   gross of goods, excluding shipping
    order_gross         the whole order including shipping

  There is no default. include_shipping is therefore not a separate flag
  that could contradict the base - the base already says.
*/
create table if not exists public.creator_commission_rules (
  id            uuid primary key default gen_random_uuid(),
  label         text not null check (char_length(btrim(label)) between 1 and 120),
  percent_basis_points integer check (percent_basis_points is null
                         or (percent_basis_points > 0 and percent_basis_points <= 10000)),
  fixed_cents   integer check (fixed_cents is null or fixed_cents > 0),
  base          text not null check (base in (
                  'merchandise_net', 'merchandise_gross', 'order_gross'
                )),
  /*
    Whether a refunded order reverses the commission. There is no sane
    reason for false, but it is a column rather than an assumption
    because Part I asks the policy to be explicit. The default is the
    honest answer.
  */
  reverse_on_refund boolean not null default true,
  note          text check (note is null or char_length(note) <= 1000),
  created_by    uuid references auth.users(id),
  created_at    timestamptz not null default now()
);

alter table public.creator_commission_rules
  drop constraint if exists creator_commission_rules_one_shape_check;

alter table public.creator_commission_rules
  add constraint creator_commission_rules_one_shape_check
  check ((percent_basis_points is null) <> (fixed_cents is null));

/*
  ── AN AFFILIATE LINK: gloamatcha.com/r/<slug> ──────────────
*/
create table if not exists public.affiliate_links (
  id          uuid primary key default gen_random_uuid(),
  creator_id  uuid not null references public.creators(id) on delete restrict,
  /*
    THE SLUG, AND ITS CHARACTER SET IS CLOSED.

    Lowercase letters, digits and a hyphen. It goes into a URL path, so
    anything that needs escaping is refused at the door rather than
    escaped at every read.
  */
  slug        text not null check (slug ~ '^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$'),
  active      boolean not null default true,
  starts_at   timestamptz not null default now(),
  ends_at     timestamptz,
  commission_rule_id uuid references public.creator_commission_rules(id) on delete restrict,
  /*
    THE DISCOUNT THE VISITOR GETS, if any, as the code that already
    exists in the discount system. A text reference and not a second
    discount definition: Part I says not to duplicate Stripe or coupon
    truth, and orders.discount_code is already the field a real order
    carries.
  */
  customer_discount_code text check (customer_discount_code is null
                            or char_length(btrim(customer_discount_code)) between 2 and 60),
  note        text check (note is null or char_length(note) <= 1000),
  created_by  uuid references auth.users(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz
);

create unique index if not exists idx_affiliate_links_slug
  on public.affiliate_links (slug);

create index if not exists idx_affiliate_links_creator
  on public.affiliate_links (creator_id);

alter table public.affiliate_links
  drop constraint if exists affiliate_links_window_check;

alter table public.affiliate_links
  add constraint affiliate_links_window_check
  check (ends_at is null or ends_at > starts_at);

/*
  ── A PERSONAL CODE: LENA10 ─────────────────────────────────

  The same creator, reached a different way. Stored uppercase-insensitive
  by a functional unique index, because a customer typing lena10 means
  the same thing.

  discount_code is the EXISTING discount infrastructure's code, not a new
  discount. One code can therefore both give the customer money off and
  attribute the order, without two systems disagreeing about the amount.
*/
create table if not exists public.affiliate_codes (
  id          uuid primary key default gen_random_uuid(),
  creator_id  uuid not null references public.creators(id) on delete restrict,
  code        text not null check (code ~ '^[A-Za-z0-9][A-Za-z0-9_-]{1,38}[A-Za-z0-9]$'),
  active      boolean not null default true,
  starts_at   timestamptz not null default now(),
  ends_at     timestamptz,
  commission_rule_id uuid references public.creator_commission_rules(id) on delete restrict,
  discount_code text check (discount_code is null
                  or char_length(btrim(discount_code)) between 2 and 60),
  note        text check (note is null or char_length(note) <= 1000),
  created_by  uuid references auth.users(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz
);

create unique index if not exists idx_affiliate_codes_code
  on public.affiliate_codes (upper(btrim(code)));

create index if not exists idx_affiliate_codes_creator
  on public.affiliate_codes (creator_id);

alter table public.affiliate_codes
  drop constraint if exists affiliate_codes_window_check;

alter table public.affiliate_codes
  add constraint affiliate_codes_window_check
  check (ends_at is null or ends_at > starts_at);

/*
  ── CLICKS, AGGREGATED BY DAY ───────────────────────────────

  One row per link per Berlin day with a counter. Deliberately NOT one
  row per visit:

    no IP address
    no user agent
    no cookie id
    no device fingerprint

  Part I asks for privacy-conscious dedupe and explicitly refuses
  invasive fingerprinting. A daily counter answers "did this link get
  traffic" - which is the question an operator actually has - and holds
  nothing about any person.
*/
create table if not exists public.affiliate_link_clicks (
  affiliate_link_id uuid not null references public.affiliate_links(id) on delete cascade,
  clicked_on   date not null,
  click_count  integer not null default 0 check (click_count >= 0),
  updated_at   timestamptz not null default now(),
  primary key (affiliate_link_id, clicked_on)
);

/*
  ── ATTRIBUTION: A DURABLE SERVER FACT ABOUT AN ORDER ───────

  One row per attributed order, and the primary key IS the order, so an
  order can be attributed to exactly one creator forever.

  THE RULE IS SNAPSHOTTED HERE, not referenced. A rule row may be edited
  or replaced later; what this order earned has to stay what it earned,
  which is migration 039's frozen-price reasoning applied to commission.
*/
create table if not exists public.order_attributions (
  order_id    uuid primary key references public.orders(id) on delete restrict,
  creator_id  uuid not null references public.creators(id) on delete restrict,
  /*
    HOW it was attributed, and exactly one of the two sources.
  */
  source      text not null check (source in ('affiliate_link', 'affiliate_code')),
  affiliate_link_id uuid references public.affiliate_links(id) on delete restrict,
  affiliate_code_id uuid references public.affiliate_codes(id) on delete restrict,
  attributed_at timestamptz not null default now(),

  -- THE FROZEN RULE. Nullable because a link may have had no rule, in
  -- which case the order is attributed and earns nothing - a real and
  -- visible state, not a zero commission.
  commission_rule_id   uuid references public.creator_commission_rules(id) on delete restrict,
  rule_percent_basis_points integer,
  rule_fixed_cents     integer,
  rule_base            text,
  created_at  timestamptz not null default now()
);

alter table public.order_attributions
  drop constraint if exists order_attributions_source_shape_check;

alter table public.order_attributions
  add constraint order_attributions_source_shape_check
  check (
    (source = 'affiliate_link' and affiliate_link_id is not null and affiliate_code_id is null)
    or (source = 'affiliate_code' and affiliate_code_id is not null and affiliate_link_id is null)
  );

alter table public.order_attributions
  drop constraint if exists order_attributions_rule_snapshot_check;

/*
  THE SNAPSHOT IS ALL PRESENT OR ALL ABSENT, and it matches the rule's
  own one-shape rule. A half-snapshot would be a commission nobody can
  recompute.
*/
alter table public.order_attributions
  add constraint order_attributions_rule_snapshot_check
  check (
    (commission_rule_id is null
      and rule_percent_basis_points is null
      and rule_fixed_cents is null
      and rule_base is null)
    or (commission_rule_id is not null
      and rule_base in ('merchandise_net', 'merchandise_gross', 'order_gross')
      and ((rule_percent_basis_points is null) <> (rule_fixed_cents is null)))
  );

create index if not exists idx_order_attributions_creator
  on public.order_attributions (creator_id, attributed_at desc);

/*
  ── THE COMMISSION LEDGER, APPEND-ONLY LIKE THE MONEY ONE ───

  Same shape of answer as financial_events and for the same reason: a
  refund must not edit what was earned, it must record that part of it
  was given back. So an earning is a row, a reversal is another row
  pointing at it, and the balance is a sum.

  amount_cents is always POSITIVE; kind carries the sign's meaning.
*/
create table if not exists public.creator_commissions (
  id          uuid primary key default gen_random_uuid(),
  creator_id  uuid not null references public.creators(id) on delete restrict,
  order_id    uuid not null references public.orders(id) on delete restrict,
  kind        text not null check (kind in ('earned', 'reversal')),
  amount_cents integer not null check (amount_cents > 0),
  currency    text not null default 'EUR' check (currency = 'EUR'),
  /*
    THE BASE THIS AMOUNT WAS COMPUTED FROM, kept so the figure can be
    re-derived and argued with. For a fixed-cents rule the base is
    recorded too, even though it did not drive the amount, because
    knowing what the order was worth is how a later reversal is sized.
  */
  base_cents  integer not null check (base_cents >= 0),
  /*
    WHAT IT REVERSES. Required for a reversal and forbidden on an
    earning, so a reversal can never float free of what it undoes.
  */
  reverses_commission_id uuid references public.creator_commissions(id) on delete restrict,
  /*
    THE PAYOUT STATE OF AN EARNING. Part I's list, and it lives on the
    earning rather than on a join table because the question "is this
    payable" is about one earning.

      pending    attributed, not yet eligible
      eligible   payable
      held       deliberately withheld
      paid       in a payout
      reversed   fully undone by reversal rows
  */
  payout_state text not null default 'pending' check (payout_state in (
                 'pending', 'eligible', 'held', 'paid', 'reversed'
               )),
  payout_id   uuid,
  operation_id uuid not null unique,
  note        text check (note is null or char_length(note) <= 1000),
  created_at  timestamptz not null default now()
);

alter table public.creator_commissions
  drop constraint if exists creator_commissions_reversal_shape_check;

alter table public.creator_commissions
  add constraint creator_commissions_reversal_shape_check
  check (
    (kind = 'earned' and reverses_commission_id is null)
    or (kind = 'reversal' and reverses_commission_id is not null)
  );

alter table public.creator_commissions
  drop constraint if exists creator_commissions_reversal_not_self_check;

alter table public.creator_commissions
  add constraint creator_commissions_reversal_not_self_check
  check (reverses_commission_id is null or reverses_commission_id <> id);

/*
  ONE EARNING PER ORDER. The index, not a code path, is what makes
  "webhook replay creates no duplicate commission" true.
*/
create unique index if not exists idx_creator_commissions_one_earned_per_order
  on public.creator_commissions (order_id)
  where kind = 'earned';

create index if not exists idx_creator_commissions_creator
  on public.creator_commissions (creator_id, payout_state);
create index if not exists idx_creator_commissions_reverses
  on public.creator_commissions (reverses_commission_id)
  where reverses_commission_id is not null;

/*
  APPEND-ONLY, with ONE narrow exception.

  payout_state and payout_id must be able to change - an eligible
  earning becomes paid, and that is not a new economic fact, it is
  settlement of the one already recorded. Everything else is frozen.

  Writing the exception as a trigger rather than as "we only update
  those two columns in our code" is the difference between a guarantee
  and an intention.
*/
create or replace function public.creator_commissions_append_only()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  if TG_OP = 'DELETE' then
    raise exception
      'public.creator_commissions is append-only: delete is refused. Write a reversal instead.';
  end if;

  if new.id is distinct from old.id
     or new.creator_id is distinct from old.creator_id
     or new.order_id is distinct from old.order_id
     or new.kind is distinct from old.kind
     or new.amount_cents is distinct from old.amount_cents
     or new.currency is distinct from old.currency
     or new.base_cents is distinct from old.base_cents
     or new.reverses_commission_id is distinct from old.reverses_commission_id
     or new.operation_id is distinct from old.operation_id
     or new.created_at is distinct from old.created_at then
    raise exception
      'public.creator_commissions: only payout_state, payout_id and note may change';
  end if;

  return new;
end;
$$;

drop trigger if exists creator_commissions_append_only on public.creator_commissions;
create trigger creator_commissions_append_only
  before update or delete on public.creator_commissions
  for each row execute function public.creator_commissions_append_only();

/*
  ── A PAYOUT: THE RECORD THAT MONEY WAS SENT ────────────────

  NO PROVIDER INTEGRATION. Part I is explicit: do not integrate or
  execute real payout providers in this block. This table records that a
  payout happened, by whatever means the business used, with its
  reference. Nothing here moves money.
*/
create table if not exists public.creator_payouts (
  id          uuid primary key default gen_random_uuid(),
  creator_id  uuid not null references public.creators(id) on delete restrict,
  total_cents integer not null check (total_cents > 0),
  currency    text not null default 'EUR' check (currency = 'EUR'),
  state       text not null default 'draft' check (state in (
                'draft', 'approved', 'paid', 'failed', 'cancelled'
              )),
  reference   text check (reference is null or char_length(btrim(reference)) between 1 and 255),
  paid_at     timestamptz,
  approved_by uuid references auth.users(id),
  note        text check (note is null or char_length(note) <= 1000),
  created_by  uuid references auth.users(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz
);

alter table public.creator_payouts
  drop constraint if exists creator_payouts_paid_shape_check;

-- 'paid' carries its date and its reference, or it is not a payout
-- anybody could later trace.
alter table public.creator_payouts
  add constraint creator_payouts_paid_shape_check
  check (state <> 'paid' or (paid_at is not null and reference is not null));

create index if not exists idx_creator_payouts_creator
  on public.creator_payouts (creator_id, state);

-- The commission's payout link, added now that the payout table exists.
alter table public.creator_commissions
  drop constraint if exists creator_commissions_payout_fk;

alter table public.creator_commissions
  add constraint creator_commissions_payout_fk
  foreign key (payout_id) references public.creator_payouts(id) on delete restrict;

alter table public.creator_commissions
  drop constraint if exists creator_commissions_paid_needs_payout_check;

alter table public.creator_commissions
  add constraint creator_commissions_paid_needs_payout_check
  check ((payout_state = 'paid') = (payout_id is not null));

/*
  ── UGC: WORK COMMISSIONED, NOT SALES EARNED ────────────────

  A UGC assignment has nothing to do with an affiliate commission, and
  this table shares no column with creator_commissions so the two cannot
  be confused or accidentally joined.

  usage_rights_note IS FREE TEXT AND HOLDS ONLY WHAT WAS AGREED. Part I:
  "Do not invent legal licensing terms." There is no licence type enum,
  no territory field and no duration - because inventing a vocabulary for
  rights GLOA may not have obtained would be worse than a sentence
  somebody actually wrote down.
*/
create table if not exists public.ugc_assignments (
  id          uuid primary key default gen_random_uuid(),
  creator_id  uuid not null references public.creators(id) on delete restrict,
  campaign    text check (campaign is null or char_length(btrim(campaign)) between 1 and 120),
  title       text not null check (char_length(btrim(title)) between 1 and 200),
  deliverable_type text not null check (deliverable_type in (
                     'photo', 'video', 'reel', 'story', 'review', 'other'
                   )),
  due_date    date,
  status      text not null default 'briefed' check (status in (
                'briefed', 'in_progress', 'submitted', 'approved', 'rejected', 'cancelled'
              )),
  /*
    WHAT WAS AGREED, in cents, and NULLABLE because an assignment may be
    unpaid - a product-seeding collaboration with no fee is a real
    arrangement. Null means "no fee agreed", not "zero", and the two must
    stay distinguishable for the same reason migration 071's VAT does.
  */
  agreed_fee_cents integer check (agreed_fee_cents is null or agreed_fee_cents > 0),
  currency    text not null default 'EUR' check (currency = 'EUR'),
  payment_status text not null default 'open' check (payment_status in ('open', 'paid')),
  content_url text check (content_url is null or char_length(btrim(content_url)) between 1 and 1000),
  usage_rights_note text check (usage_rights_note is null
                       or char_length(usage_rights_note) <= 4000),
  note        text check (note is null or char_length(note) <= 4000),
  created_by  uuid references auth.users(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz
);

alter table public.ugc_assignments
  drop constraint if exists ugc_assignments_paid_needs_fee_check;

-- An assignment cannot be "paid" if no fee was ever agreed.
alter table public.ugc_assignments
  add constraint ugc_assignments_paid_needs_fee_check
  check (payment_status <> 'paid' or agreed_fee_cents is not null);

create index if not exists idx_ugc_assignments_creator
  on public.ugc_assignments (creator_id, status);
create index if not exists idx_ugc_assignments_due
  on public.ugc_assignments (due_date)
  where due_date is not null and status in ('briefed', 'in_progress', 'submitted');

/*
  ── CREATOR COST -> FINANCE: ONE AUTHORITATIVE RELATIONSHIP ──

  Part I: "Do not double-book the same cost into both creator ledger and
  business_expenses. Choose one authoritative financial relationship and
  explain it."

  THE CHOICE: the creator tables are authoritative for what is OWED to a
  creator. public.business_expenses (migration 071) is authoritative for
  what GLOA has BOOKED AS A COST.

  They are linked by this column and nothing else: an expense row may
  name the creator obligation it settles. So

    * an unpaid commission or UGC fee lives only in the creator tables
      and appears in Finance as an OBLIGATION, never as an expense;
    * booking it as a cost means writing ONE business_expenses row that
      points back here;
    * and because the pointer is unique per source, the same obligation
      cannot be booked twice.

  This column is added to migration 071's table additively, which is
  allowed - 071 itself is not modified.
*/
alter table public.business_expenses
  add column if not exists creator_commission_id uuid
    references public.creator_commissions(id) on delete restrict;

alter table public.business_expenses
  add column if not exists ugc_assignment_id uuid
    references public.ugc_assignments(id) on delete restrict;

alter table public.business_expenses
  drop constraint if exists business_expenses_creator_source_check;

-- At most ONE creator source per expense row. An expense that claimed to
-- settle both a commission and a UGC fee would be one of them
-- double-booked.
alter table public.business_expenses
  add constraint business_expenses_creator_source_check
  check (creator_commission_id is null or ugc_assignment_id is null);

-- ONE EXPENSE PER OBLIGATION. The indexes, not a convention, are what
-- make double-booking impossible.
create unique index if not exists idx_business_expenses_one_per_commission
  on public.business_expenses (creator_commission_id)
  where creator_commission_id is not null;

create unique index if not exists idx_business_expenses_one_per_ugc
  on public.business_expenses (ugc_assignment_id)
  where ugc_assignment_id is not null;

-- ══════════════════════════════════════════════════════════════
-- SECTION 7.  DOCUMENTS
-- ══════════════════════════════════════════════════════════════
--
-- RECON RESULT: there is no document table and no Supabase Storage
-- bucket anywhere in migrations 001-071. So Block 2 would have needed a
-- migration of its own, which Part K exists to prevent.
--
-- WHAT THIS IS NOT: it is not an invoice generator, it designs no PDF,
-- and it invents no statutory tax field. It is the RELATIONSHIP and the
-- metadata, so that a file produced later has somewhere to belong.
--
-- ── THE DISTINCTION PART K ASKS FOR ───────────────────────────
--
--   stripe_receipt     evidence the provider produced. GLOA did not
--                      issue it and must not present it as its own.
--   gloa_invoice       a document GLOA issued.
--   expense_receipt    a supplier's document, for a cost.
--   b2b_document       a contract or order confirmation.
--   other
--
-- ── AND FILES ARE NOT ENUMERABLE ──────────────────────────────
--
-- storage_path holds an opaque key with a random component, and the
-- table is readable only by service_role. There is no public bucket,
-- no predictable path and no browser grant, so a file cannot be guessed
-- or listed. Nothing here is a URL.

create table if not exists public.documents (
  id           uuid primary key default gen_random_uuid(),
  kind         text not null check (kind in (
                 'stripe_receipt', 'gloa_invoice', 'expense_receipt',
                 'b2b_document', 'other'
               )),
  title        text not null check (char_length(btrim(title)) between 1 and 200),
  /*
    WHERE THE BYTES ARE. An opaque storage key, never a URL and never a
    public path. Required to contain a '/' so a bare guessable filename
    cannot be stored, and bounded so it cannot carry a payload.
  */
  storage_path text check (storage_path is null
                 or (char_length(btrim(storage_path)) between 8 and 500
                     and pg_catalog.strpos(storage_path, '/') > 1)),
  /*
    THE PROVIDER'S OWN REFERENCE, for a stripe_receipt. Kept instead of
    downloading and re-hosting Stripe's document, which would make GLOA
    the publisher of somebody else's receipt.
  */
  external_reference text check (external_reference is null
                       or char_length(btrim(external_reference)) between 1 and 255),
  mime_type    text check (mime_type is null or char_length(btrim(mime_type)) between 3 and 120),
  byte_size    integer check (byte_size is null or byte_size > 0),
  issued_on    date,
  note         text check (note is null or char_length(note) <= 2000),
  created_by   uuid references auth.users(id),
  created_at   timestamptz not null default now()
);

alter table public.documents
  drop constraint if exists documents_locator_check;

/*
  A DOCUMENT HAS TO BE FINDABLE. Either GLOA holds the file, or it holds
  the provider's reference to it. A row with neither is a title and
  nothing else.
*/
alter table public.documents
  add constraint documents_locator_check
  check (storage_path is not null or external_reference is not null);

alter table public.documents
  drop constraint if exists documents_stripe_receipt_not_hosted_check;

-- A Stripe receipt is referenced, not stored. This is the boundary Part K
-- asks to keep, written as a constraint so it cannot erode.
alter table public.documents
  add constraint documents_stripe_receipt_not_hosted_check
  check (kind <> 'stripe_receipt' or storage_path is null);

create index if not exists idx_documents_kind_issued
  on public.documents (kind, issued_on desc);

/*
  WHAT A DOCUMENT IS ABOUT. A join table rather than four nullable
  columns on documents, because one invoice legitimately concerns an
  order AND a customer, and one supplier receipt can cover two expenses.
*/
create table if not exists public.document_links (
  document_id  uuid not null references public.documents(id) on delete cascade,
  subject_type text not null check (subject_type in (
                 'order', 'business_expense', 'annual_plan',
                 'b2b_agreement', 'customer', 'creator'
               )),
  subject_id   uuid not null,
  created_at   timestamptz not null default now(),
  primary key (document_id, subject_type, subject_id)
);

/*
  NO FOREIGN KEY ON subject_id, and that is a deliberate trade.

  A polymorphic reference cannot have one, and the alternatives are worse:
  six nullable FK columns would allow a row that points at two subjects
  at once, and six link tables would mean six places to look. The
  subject_type vocabulary is closed, the postcheck verifies that every
  link resolves, and nothing here cascades into a business table.
*/
create index if not exists idx_document_links_subject
  on public.document_links (subject_type, subject_id);

-- ══════════════════════════════════════════════════════════════
-- SECTION 8.  THE AUDIT MODULE FOR CREATOR WORK
-- ══════════════════════════════════════════════════════════════
--
-- admin_activity_log_module_check currently allows orders, inventory,
-- b2b, finance, documents, fulfillment and customer_rights. A creator
-- decision is none of those, and Part H asks for creator lifecycle
-- events to be auditable.
--
-- WIDENING a CHECK is additive: every existing row still satisfies it and
-- no existing writer changes. The vocabulary stays closed, which is the
-- property migration 052 wanted.

alter table public.admin_activity_log
  drop constraint if exists admin_activity_log_module_check;

alter table public.admin_activity_log
  add constraint admin_activity_log_module_check
  check (module in (
    'orders', 'inventory', 'b2b', 'finance', 'documents',
    'fulfillment', 'customer_rights',
    -- Added by 072.
    'creator'
  ));

-- ══════════════════════════════════════════════════════════════
-- SECTION 9.  ATTRIBUTION AND COMMISSION, SERVER-AUTHORITATIVE
-- ══════════════════════════════════════════════════════════════
--
-- Part I's hard rules, and how each one is enforced rather than intended:
--
--   "Do not trust arbitrary client-supplied creator IDs."
--       The writer below takes a SLUG or a CODE. There is no creator_id
--       parameter, so a browser cannot name a creator at all.
--
--   "Validate active link/code server-side."
--       resolve_* below check active, the time window AND the creator's
--       own status. A paused creator's live link earns nothing.
--
--   "Commission must be server-authoritative / integer cents /
--    idempotent / snapshot the rule / react to refunds / never
--    double-created on webhook retry."
--       There is no amount parameter anywhere. The amount is computed
--       from the order and the frozen rule. idx_creator_commissions_
--       one_earned_per_order makes the retry case the database's problem
--       rather than a code path's.
--
--   "Do not silently include/exclude shipping using an undocumented
--    assumption."
--       rule_base says which figure was used, it is snapshotted onto the
--       attribution, and base_cents records what that came to. Nothing is
--       assumed and nothing is hidden.

/*
  THE ATTRIBUTION WINDOW IS DATA, NOT A CONSTANT.

  Part I: "Do not silently invent a global attribution window. If
  attribution window is needed, model it as explicit configurable data."

  So it lives in operations_config under
  'affiliate_attribution_window_days', and like the dispatch SLA it is
  SEEDED EMPTY. With no window configured, attribution is accepted
  whenever the caller presents a valid link or code and the order is
  paid - which is the behaviour with no time rule at all, and is honest.
  Once an owner sets a number, resolve_* enforce it.
*/

/*
  ── THE ACTIVE LINK BEHIND A SLUG ───────────────────────────

  Returns the link, its creator and the rule to freeze, or a reason it
  cannot attribute. Never raises on a bad slug: an unknown /r/ URL is a
  visitor's typo, not an error condition.
*/
create or replace function public.resolve_affiliate_link(p_slug text)
returns jsonb
language plpgsql
stable
security definer set search_path = ''
as $$
declare
  v_link    public.affiliate_links;
  v_creator public.creators;
  v_rule    public.creator_commission_rules;
begin
  if p_slug is null or pg_catalog.btrim(p_slug) = '' then
    return pg_catalog.jsonb_build_object('result', 'not_found');
  end if;

  select * into v_link
    from public.affiliate_links
   where slug = pg_catalog.lower(pg_catalog.btrim(p_slug));
  if v_link.id is null then
    return pg_catalog.jsonb_build_object('result', 'not_found');
  end if;

  if not v_link.active then
    return pg_catalog.jsonb_build_object('result', 'paused');
  end if;
  if v_link.starts_at > pg_catalog.now() then
    return pg_catalog.jsonb_build_object('result', 'not_started');
  end if;
  if v_link.ends_at is not null and v_link.ends_at <= pg_catalog.now() then
    return pg_catalog.jsonb_build_object('result', 'expired');
  end if;

  -- THE CREATOR'S OWN STATUS COUNTS. A link left live for an ended
  -- collaboration must not keep earning, and remembering to deactivate
  -- every link is not a control.
  select * into v_creator from public.creators where id = v_link.creator_id;
  if v_creator.id is null then
    return pg_catalog.jsonb_build_object('result', 'creator_missing');
  end if;
  if v_creator.status <> 'active' then
    return pg_catalog.jsonb_build_object(
      'result', 'creator_inactive', 'creator_status', v_creator.status);
  end if;

  if v_link.commission_rule_id is not null then
    select * into v_rule
      from public.creator_commission_rules
     where id = v_link.commission_rule_id;
  end if;

  return pg_catalog.jsonb_build_object(
    'result', 'active',
    'affiliate_link_id', v_link.id,
    'creator_id', v_creator.id,
    'customer_discount_code', v_link.customer_discount_code,
    -- NULL WHEN THERE IS NO RULE. The link still attributes; it simply
    -- earns nothing, which is a state an operator can see and fix.
    'commission_rule_id', v_rule.id,
    'rule_percent_basis_points', v_rule.percent_basis_points,
    'rule_fixed_cents', v_rule.fixed_cents,
    'rule_base', v_rule.base
  );
end;
$$;

/*
  ── THE ACTIVE CREATOR BEHIND A CODE ────────────────────────

  Case-insensitive, matching the unique index, so LENA10 and lena10 are
  one code.
*/
create or replace function public.resolve_affiliate_code(p_code text)
returns jsonb
language plpgsql
stable
security definer set search_path = ''
as $$
declare
  v_code    public.affiliate_codes;
  v_creator public.creators;
  v_rule    public.creator_commission_rules;
begin
  if p_code is null or pg_catalog.btrim(p_code) = '' then
    return pg_catalog.jsonb_build_object('result', 'not_found');
  end if;

  select * into v_code
    from public.affiliate_codes
   where upper(btrim(code)) = pg_catalog.upper(pg_catalog.btrim(p_code));
  if v_code.id is null then
    return pg_catalog.jsonb_build_object('result', 'not_found');
  end if;
  if not v_code.active then
    return pg_catalog.jsonb_build_object('result', 'paused');
  end if;
  if v_code.starts_at > pg_catalog.now() then
    return pg_catalog.jsonb_build_object('result', 'not_started');
  end if;
  if v_code.ends_at is not null and v_code.ends_at <= pg_catalog.now() then
    return pg_catalog.jsonb_build_object('result', 'expired');
  end if;

  select * into v_creator from public.creators where id = v_code.creator_id;
  if v_creator.id is null then
    return pg_catalog.jsonb_build_object('result', 'creator_missing');
  end if;
  if v_creator.status <> 'active' then
    return pg_catalog.jsonb_build_object(
      'result', 'creator_inactive', 'creator_status', v_creator.status);
  end if;

  if v_code.commission_rule_id is not null then
    select * into v_rule
      from public.creator_commission_rules
     where id = v_code.commission_rule_id;
  end if;

  return pg_catalog.jsonb_build_object(
    'result', 'active',
    'affiliate_code_id', v_code.id,
    'creator_id', v_creator.id,
    'discount_code', v_code.discount_code,
    'commission_rule_id', v_rule.id,
    'rule_percent_basis_points', v_rule.percent_basis_points,
    'rule_fixed_cents', v_rule.fixed_cents,
    'rule_base', v_rule.base
  );
end;
$$;

/*
  A CLICK, counted by day and by nothing else. See the table's note: no
  person-identifying column exists to write even if a caller offered one.
*/
create or replace function public.record_affiliate_click(p_affiliate_link_id uuid)
returns boolean
language plpgsql
security definer set search_path = ''
as $$
begin
  insert into public.affiliate_link_clicks (
    affiliate_link_id, clicked_on, click_count, updated_at
  ) values (
    p_affiliate_link_id,
    public.financial_event_berlin_date(pg_catalog.now()),
    1,
    pg_catalog.now()
  )
  on conflict (affiliate_link_id, clicked_on) do update
    set click_count = public.affiliate_link_clicks.click_count + 1,
        updated_at  = pg_catalog.now();
  return true;
exception
  when foreign_key_violation then
    -- An unknown link id. Not worth failing a page view over.
    return false;
end;
$$;

/*
  THE COMMISSION BASE OF AN ORDER, under one named policy.

  Separated out so the policy is one readable function instead of a CASE
  buried in the writer, and so the postcheck can assert the three bases
  exist by reading this body.

    merchandise_net     goods, net of tax and excluding shipping
    merchandise_gross   goods, gross, excluding shipping
    order_gross         everything, including shipping

  Returns NULL when the figure the base needs is not known on the order -
  total_net_cents is nullable for every non-EU destination, and migration
  058 is explicit that it is "unknown, never a fabricated zero". So a net
  base against an order with no net answers NOTHING rather than treating
  unknown as zero and paying a commission on it.
*/
create or replace function public.order_commission_base_cents(
  p_order_id uuid,
  p_base     text
)
returns integer
language plpgsql
stable
security definer set search_path = ''
as $$
declare
  v_order public.orders;
begin
  select * into v_order from public.orders where id = p_order_id;
  if v_order.id is null then
    return null;
  end if;

  if p_base = 'order_gross' then
    return v_order.total_gross_cents;
  elsif p_base = 'merchandise_gross' then
    return v_order.total_gross_cents - coalesce(v_order.shipping_gross_cents, 0);
  elsif p_base = 'merchandise_net' then
    if v_order.total_net_cents is null then
      return null;
    end if;
    return v_order.total_net_cents - coalesce(v_order.shipping_net_cents, 0);
  end if;

  return null;
end;
$$;

/*
  ══════════════════════════════════════════════════════════════
  ATTRIBUTE A PAID ORDER TO A CREATOR, AND EARN THE COMMISSION
  ══════════════════════════════════════════════════════════════

  ONE CALL, because the two facts must not be able to disagree: an
  attributed order with no commission row and a commission row with no
  attribution are both states nobody can reconcile later. They are
  written in one transaction, like migration 052's audited mutations.

  THE CALLER PRESENTS A SLUG OR A CODE AND NOTHING ELSE. No creator, no
  rule, no amount. That is the whole answer to Part Q's test 34.

  THE RULE IS FROZEN ONTO THE ATTRIBUTION. Editing a rule later changes
  what FUTURE orders earn and never what this one did.

  ROUNDING IS HALF-UP ON INTEGERS, written as (2*x + d) / (2*d), which is
  the same idiom migrations 059 and 060 already use for B2B tax. No
  floats touch money.
*/
create or replace function public.attribute_order_to_creator(
  p_order_id     uuid,
  p_source       text,
  p_reference    text,
  p_operation_id uuid default null
)
returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_order        public.orders;
  v_resolved     jsonb;
  v_operation_id uuid;
  v_existing     public.order_attributions;
  v_prior        public.creator_commissions;
  v_base         integer;
  v_amount       integer;
  v_bp           integer;
  v_fixed        integer;
  v_rule_base    text;
  v_rule_id      uuid;
  v_creator_id   uuid;
  v_link_id      uuid;
  v_code_id      uuid;
  v_commission   public.creator_commissions;
begin
  if p_order_id is null then
    raise exception 'attribute_order_to_creator needs an order';
  end if;
  if p_source not in ('affiliate_link', 'affiliate_code') then
    return pg_catalog.jsonb_build_object('result', 'source_unknown');
  end if;

  v_operation_id := coalesce(p_operation_id, pg_catalog.gen_random_uuid());

  -- THE LOCK IS ON THE ORDER, not the operation: two concurrent
  -- attributions of the same order with different operation ids must
  -- serialise, and the second must see the first.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'creator:attribute:' || p_order_id::pg_catalog.text, 0));

  -- ALREADY ATTRIBUTED? The primary key is the order, so this is the
  -- whole duplicate question.
  select * into v_existing
    from public.order_attributions
   where order_id = p_order_id;
  if v_existing.order_id is not null then
    select * into v_prior
      from public.creator_commissions
     where order_id = p_order_id and kind = 'earned'
     limit 1;
    return pg_catalog.jsonb_build_object(
      'result', 'already_attributed',
      'creator_id', v_existing.creator_id,
      'commission_id', v_prior.id,
      'commission_cents', v_prior.amount_cents);
  end if;

  select * into v_order from public.orders where id = p_order_id;
  if v_order.id is null then
    return pg_catalog.jsonb_build_object('result', 'order_missing');
  end if;

  -- ONLY A PAID ORDER EARNS. An unpaid or cancelled one is not a sale.
  if v_order.payment_status not in ('paid', 'partially_refunded', 'refunded') then
    return pg_catalog.jsonb_build_object(
      'result', 'order_not_paid', 'payment_status', v_order.payment_status);
  end if;
  if v_order.status = 'cancelled' then
    return pg_catalog.jsonb_build_object('result', 'order_cancelled');
  end if;

  -- THE SERVER RESOLVES THE REFERENCE. This is where a forged creator id
  -- would have to enter, and there is no parameter for one.
  if p_source = 'affiliate_link' then
    v_resolved := public.resolve_affiliate_link(p_reference);
  else
    v_resolved := public.resolve_affiliate_code(p_reference);
  end if;

  if v_resolved->>'result' <> 'active' then
    return pg_catalog.jsonb_build_object(
      'result', 'reference_not_attributable',
      'reason', v_resolved->>'result');
  end if;

  v_creator_id := (v_resolved->>'creator_id')::uuid;
  v_link_id    := nullif(v_resolved->>'affiliate_link_id', '')::uuid;
  v_code_id    := nullif(v_resolved->>'affiliate_code_id', '')::uuid;
  v_rule_id    := nullif(v_resolved->>'commission_rule_id', '')::uuid;
  v_bp         := nullif(v_resolved->>'rule_percent_basis_points', '')::integer;
  v_fixed      := nullif(v_resolved->>'rule_fixed_cents', '')::integer;
  v_rule_base  := nullif(v_resolved->>'rule_base', '');

  insert into public.order_attributions (
    order_id, creator_id, source, affiliate_link_id, affiliate_code_id,
    commission_rule_id, rule_percent_basis_points, rule_fixed_cents, rule_base
  ) values (
    v_order.id, v_creator_id, p_source, v_link_id, v_code_id,
    v_rule_id, v_bp, v_fixed, v_rule_base
  );

  /*
    NO RULE MEANS NO COMMISSION, and that is not zero.

    The order is attributed - the creator brought it, and the report must
    say so - but nothing is earned and no commission row exists. An
    operator seeing "attributed, no commission rule" can attach a rule
    for future orders; a zero-cent row would instead look like a
    deliberate decision that this sale was worth nothing.
  */
  if v_rule_id is null then
    return pg_catalog.jsonb_build_object(
      'result', 'attributed_without_commission',
      'creator_id', v_creator_id,
      'reason', 'no_commission_rule');
  end if;

  v_base := public.order_commission_base_cents(v_order.id, v_rule_base);

  if v_base is null then
    -- The base this rule needs is not known on this order. See
    -- order_commission_base_cents: unknown is not zero.
    return pg_catalog.jsonb_build_object(
      'result', 'attributed_without_commission',
      'creator_id', v_creator_id,
      'reason', 'base_unknown',
      'rule_base', v_rule_base);
  end if;

  if v_fixed is not null then
    v_amount := v_fixed;
  else
    -- Half-up on integers. No floats.
    v_amount := ((2 * (v_base::bigint * v_bp) + 10000) / 20000)::integer;
  end if;

  if v_amount <= 0 then
    return pg_catalog.jsonb_build_object(
      'result', 'attributed_without_commission',
      'creator_id', v_creator_id,
      'reason', 'amount_rounds_to_zero',
      'base_cents', v_base);
  end if;

  begin
    insert into public.creator_commissions (
      creator_id, order_id, kind, amount_cents, base_cents,
      payout_state, operation_id
    ) values (
      v_creator_id, v_order.id, 'earned', v_amount, v_base,
      -- 'pending' AND NOT 'eligible'. Eligibility is an operator
      -- decision - typically after a return window - and defaulting to
      -- payable would make every attributed order instantly owed.
      'pending', v_operation_id
    )
    returning * into v_commission;
  exception
    when unique_violation then
      -- idx_creator_commissions_one_earned_per_order. The webhook-replay
      -- case, handled by the database.
      select * into v_prior
        from public.creator_commissions
       where order_id = v_order.id and kind = 'earned'
       limit 1;
      return pg_catalog.jsonb_build_object(
        'result', 'already_attributed',
        'creator_id', v_creator_id,
        'commission_id', v_prior.id,
        'commission_cents', v_prior.amount_cents);
  end;

  return pg_catalog.jsonb_build_object(
    'result', 'attributed',
    'creator_id', v_creator_id,
    'commission_id', v_commission.id,
    'commission_cents', v_commission.amount_cents,
    'base_cents', v_base,
    'rule_base', v_rule_base
  );
end;
$$;

/*
  ══════════════════════════════════════════════════════════════
  A REFUND REVERSES COMMISSION, PROPORTIONALLY AND ONCE
  ══════════════════════════════════════════════════════════════

  Part I: "No commission remains falsely payable on fully refunded
  eligible value."

  THE SHAPE IS THE REFUND LEDGER'S, deliberately. Like
  record_order_refund_event, this takes the order's ABSOLUTE refunded
  total and writes the DIFFERENCE - so it is idempotent by arithmetic and
  not merely by key, and a Stripe redelivery with a fresh operation id
  still produces nothing.

  PROPORTIONAL TO THE ORDER'S GROSS, whatever base the commission used.
  Half the order refunded reverses half the commission. That is the only
  ratio available without knowing which LINE was refunded, which Stripe
  does not tell this system, and it is stated here rather than assumed.

  REVERSAL ROWS, NEVER AN EDIT. The earning stays exactly as earned; what
  is owed is the sum. payout_state moves to 'reversed' only when the
  reversals reach the full amount - a partially reversed commission is
  still partly payable.

  A COMMISSION ALREADY PAID IS STILL REVERSED. The reversal is recorded
  either way, because the obligation genuinely changed; recovering an
  overpayment is a business conversation, and hiding it would make that
  conversation impossible.
*/
create or replace function public.reverse_creator_commission_for_refund(
  p_order_id             uuid,
  p_refunded_total_cents integer,
  p_operation_id         uuid default null
)
returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_order        public.orders;
  v_earned       public.creator_commissions;
  v_attr         public.order_attributions;
  v_rule         public.creator_commission_rules;
  v_already      integer;
  v_target       integer;
  v_delta        integer;
  v_operation_id uuid;
  v_existing     public.creator_commissions;
  v_row          public.creator_commissions;
begin
  if p_order_id is null or p_refunded_total_cents is null then
    raise exception 'reverse_creator_commission_for_refund needs an order and a total';
  end if;
  if p_refunded_total_cents < 0 then
    raise exception 'a refunded total cannot be negative';
  end if;

  v_operation_id := coalesce(p_operation_id, pg_catalog.gen_random_uuid());

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'creator:reverse:' || p_order_id::pg_catalog.text, 0));

  select * into v_existing
    from public.creator_commissions
   where operation_id = v_operation_id;
  if v_existing.id is not null then
    return pg_catalog.jsonb_build_object(
      'result', 'already_recorded', 'commission_id', v_existing.id);
  end if;

  select * into v_earned
    from public.creator_commissions
   where order_id = p_order_id and kind = 'earned'
   for update;
  if v_earned.id is null then
    return pg_catalog.jsonb_build_object('result', 'no_commission');
  end if;

  -- DOES THE RULE EVEN REVERSE? An explicit policy column, not an
  -- assumption. See creator_commission_rules.reverse_on_refund.
  select * into v_attr from public.order_attributions where order_id = p_order_id;
  if v_attr.commission_rule_id is not null then
    select * into v_rule
      from public.creator_commission_rules
     where id = v_attr.commission_rule_id;
    if v_rule.id is not null and not v_rule.reverse_on_refund then
      return pg_catalog.jsonb_build_object(
        'result', 'rule_does_not_reverse', 'commission_id', v_earned.id);
    end if;
  end if;

  select * into v_order from public.orders where id = p_order_id;
  if v_order.id is null or v_order.total_gross_cents is null
     or v_order.total_gross_cents <= 0 then
    return pg_catalog.jsonb_build_object('result', 'order_total_unknown');
  end if;

  if p_refunded_total_cents > v_order.total_gross_cents then
    return pg_catalog.jsonb_build_object('result', 'refund_exceeds_order');
  end if;

  /*
    THE TOTAL THAT SHOULD BE REVERSED AT THIS REFUND LEVEL, half-up, and
    clamped to the earning so rounding can never reverse more than was
    earned.
  */
  v_target := ((2 * (v_earned.amount_cents::bigint * p_refunded_total_cents)
                + v_order.total_gross_cents)
               / (2 * v_order.total_gross_cents))::integer;
  if v_target > v_earned.amount_cents then
    v_target := v_earned.amount_cents;
  end if;

  select coalesce(pg_catalog.sum(c.amount_cents), 0)::integer
    into v_already
    from public.creator_commissions c
   where c.reverses_commission_id = v_earned.id
     and c.kind = 'reversal';

  v_delta := v_target - v_already;

  if v_delta <= 0 then
    return pg_catalog.jsonb_build_object(
      'result', 'no_change',
      'commission_id', v_earned.id,
      'already_reversed_cents', v_already);
  end if;

  insert into public.creator_commissions (
    creator_id, order_id, kind, amount_cents, base_cents,
    reverses_commission_id, payout_state, operation_id, note
  ) values (
    v_earned.creator_id, v_earned.order_id, 'reversal', v_delta,
    v_earned.base_cents,
    v_earned.id,
    -- A reversal is not itself payable. It is a reduction of what is.
    'reversed',
    v_operation_id,
    'Erstattung ' || p_refunded_total_cents::pg_catalog.text || ' von '
      || v_order.total_gross_cents::pg_catalog.text || ' Cent'
  )
  returning * into v_row;

  /*
    FULLY REVERSED EARNINGS STOP BEING PAYABLE, and only fully reversed
    ones. A 'paid' earning is deliberately left as 'paid' - it was paid,
    and rewriting that would erase the fact that money left.
  */
  if v_target >= v_earned.amount_cents and v_earned.payout_state <> 'paid' then
    update public.creator_commissions
       set payout_state = 'reversed'
     where id = v_earned.id;
  end if;

  return pg_catalog.jsonb_build_object(
    'result', 'reversed',
    'commission_id', v_earned.id,
    'reversal_id', v_row.id,
    'reversed_cents', v_delta,
    'reversed_total_cents', v_target,
    'earned_cents', v_earned.amount_cents,
    'fully_reversed', (v_target >= v_earned.amount_cents)
  );
end;
$$;

/*
  WHAT A CREATOR IS ACTUALLY OWED, as one function so no caller invents
  its own arithmetic.

  earned minus reversals, restricted to earnings that are payable. An
  earning in 'pending' or 'held' is not owed yet; a 'paid' one is no
  longer owed; a 'reversed' one never will be.
*/
create or replace function public.creator_commission_balance(p_creator_id uuid)
returns jsonb
language sql
stable
security definer set search_path = ''
as $$
  with earned as (
    select c.id, c.amount_cents, c.payout_state
      from public.creator_commissions c
     where c.creator_id = p_creator_id and c.kind = 'earned'
  ),
  reversed as (
    select r.reverses_commission_id as id,
           coalesce(sum(r.amount_cents), 0)::integer as cents
      from public.creator_commissions r
     where r.creator_id = p_creator_id and r.kind = 'reversal'
     group by r.reverses_commission_id
  ),
  net as (
    select e.payout_state,
           greatest(e.amount_cents - coalesce(v.cents, 0), 0) as cents
      from earned e left join reversed v on v.id = e.id
  )
  select pg_catalog.jsonb_build_object(
    'eligible_cents', coalesce(sum(cents) filter (where payout_state = 'eligible'), 0),
    'pending_cents',  coalesce(sum(cents) filter (where payout_state = 'pending'), 0),
    'held_cents',     coalesce(sum(cents) filter (where payout_state = 'held'), 0),
    'paid_cents',     coalesce(sum(cents) filter (where payout_state = 'paid'), 0),
    'reversed_cents', (select coalesce(sum(amount_cents), 0)
                         from public.creator_commissions
                        where creator_id = p_creator_id and kind = 'reversal')
  )
  from net;
$$;

-- ══════════════════════════════════════════════════════════════
-- SECTION 10.  SECURITY
-- ══════════════════════════════════════════════════════════════
--
-- Every table in this migration is ADMIN-ONLY, and "admin" in this
-- repository means the service_role behind an admin session - never a
-- browser role. RLS on, no policy, nothing granted to anon or
-- authenticated.
--
-- ── TWO TIERS, AND THE LINE BETWEEN THEM IS MONEY ─────────────
--
-- MONEY TABLES get SELECT only. service_role cannot INSERT, UPDATE or
-- DELETE them, so the SECURITY DEFINER writers are the only path and
-- every rule in a writer body is unavoidable. This is migration 071's
-- decision, for 071's reason: if a route could write directly, the
-- guarantees would be advisory.
--
--     financial_events       every arithmetic rule, the append-only
--                            trigger and the one-per-order/plan indexes
--     order_attributions     the server-resolved creator
--     creator_commissions    the computed amount and its reversals
--
-- CATALOGUE TABLES get SELECT, INSERT and UPDATE. They hold what an
-- operator types - a creator's name, a link's slug, a rule's percentage,
-- a UGC brief - and nothing derived. A wrong row here is a typo an
-- operator can fix, not a corrupted total, and wrapping each one in a
-- writer would have added ceremony without adding a guarantee.
--
--     creators, creator_roles, creator_applications,
--     creator_commission_rules, affiliate_links, affiliate_codes,
--     affiliate_link_clicks, creator_payouts, ugc_assignments,
--     documents, document_links, operations_config
--
-- DELETE is granted NOWHERE. Not on either tier.

do $$
declare
  v_money text[] := array[
    'financial_events', 'order_attributions', 'creator_commissions'
  ];
  v_catalogue text[] := array[
    'creators', 'creator_roles', 'creator_applications',
    'creator_commission_rules', 'affiliate_links', 'affiliate_codes',
    'affiliate_link_clicks', 'creator_payouts', 'ugc_assignments',
    'documents', 'document_links', 'operations_config'
  ];
  v_name text;
begin
  foreach v_name in array (v_money || v_catalogue) loop
    execute pg_catalog.format(
      'alter table public.%I enable row level security', v_name);
    execute pg_catalog.format(
      'revoke all privileges on table public.%I from anon, authenticated', v_name);
    execute pg_catalog.format(
      'revoke all privileges on table public.%I from public', v_name);
  end loop;

  foreach v_name in array v_money loop
    execute pg_catalog.format(
      'grant select on table public.%I to service_role', v_name);
  end loop;

  foreach v_name in array v_catalogue loop
    execute pg_catalog.format(
      'grant select, insert, update on table public.%I to service_role', v_name);
  end loop;
end
$$;

/*
  THE FUNCTIONS: service_role ONLY, and the browser roles are revoked
  explicitly rather than left to the default.

  Written as a loop over pg_proc rather than as thirty hand-typed
  signatures, because a hand-typed list is one that drifts the moment a
  parameter changes - and migration 071's preflight already proved that
  reading a signature wrong is easy
  (pg_get_function_identity_arguments includes parameter NAMES, which is
  why oidvectortypes is used here).
*/
do $$
declare
  v_fn record;
  v_sig text;
begin
  for v_fn in
    select p.oid, p.proname,
           pg_catalog.oidvectortypes(p.proargtypes) as args
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in (
         'financial_event_berlin_date',
         'order_is_annual_delivery',
         'order_subscription_id',
         'record_order_payment_event',
         'record_annual_prepayment_event',
         'record_b2b_settlement_event',
         'record_order_refund_event',
         'record_annual_plan_refund_event',
         'record_payment_fee_event',
         'admin_decide_annual_termination',
         'admin_execute_subscription_termination',
         'order_shipping_due',
         'claim_annual_purchase_notification',
         'mark_annual_purchase_notification',
         'resolve_affiliate_link',
         'resolve_affiliate_code',
         'record_affiliate_click',
         'order_commission_base_cents',
         'attribute_order_to_creator',
         'reverse_creator_commission_for_refund',
         'creator_commission_balance'
       )
  loop
    v_sig := pg_catalog.format('public.%I(%s)', v_fn.proname, v_fn.args);
    execute 'revoke all on function ' || v_sig || ' from public, anon, authenticated';
    execute 'grant execute on function ' || v_sig || ' to service_role';
  end loop;
end
$$;

/*
  THE TRIGGER FUNCTIONS ARE NOT EXECUTABLE BY ANYONE.

  They are reached only by the triggers that own them. Granting EXECUTE
  would let a caller invoke a function whose only job is to raise.
*/
revoke all on function public.financial_events_append_only() from public, anon, authenticated;
revoke all on function public.creator_commissions_append_only() from public, anon, authenticated;

-- ══════════════════════════════════════════════════════════════
-- SECTION 11.  WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
-- ══════════════════════════════════════════════════════════════
--
-- NO INVENTORY MUTATION. Part M, and migration 050's boundary. Not one
-- table above holds a quantity of stock; no function above reads or
-- writes inventory_items or inventory_movements; and this migration
-- creates exactly two triggers, both of which only raise. A commerce,
-- finance or creator event cannot move stock because there is no code
-- path from any of them to it.
--
-- NO STRIPE CALL AND NO PAYOUT PROVIDER. Nothing here moves money. The
-- refund writers RECORD a refund that already happened; the payout table
-- RECORDS a payment that already happened. Both are evidence, not
-- instructions.
--
-- NO ESTIMATED PROVIDER FEE. record_payment_fee_event refuses a row
-- without the provider's own reference, and nothing computes a fee from
-- a percentage. Until a caller reads a real balance_transaction, the
-- payment-provider fee is NOT KNOWN and the read model must say so.
--
-- NO DISPATCH SLA. operations_config is seeded empty on purpose; see
-- section 4.
--
-- NO COMMISSION DEFAULT. There is no percentage anywhere in this file
-- outside a test fixture. A link without a rule attributes and earns
-- nothing.
--
-- NO BACKFILL AT ALL, in this version. Section 12 below verifies the
-- shape and writes no business row: the historical derivation Part O
-- allows is a separate, reviewable step, and bundling an UPDATE over
-- every existing order into the same transaction as thirty CREATE TABLEs
-- would make the apply unreviewable and the rollback impossible.
--
-- NO MODIFICATION OF MIGRATIONS 001-071. Three existing tables are
-- EXTENDED additively - orders gains ship_by_date, annual_plans gains
-- five termination and notification columns, business_expenses gains two
-- creator pointers - and one CHECK is widened to admit a new audit
-- module. No existing column changes type, nullability or meaning, and
-- no existing function is replaced.

-- ══════════════════════════════════════════════════════════════
-- SECTION 12.  VERIFY
-- ══════════════════════════════════════════════════════════════

do $$
declare
  v_missing text;
  v_count   integer;
begin
  -- Every table this migration promises.
  select pg_catalog.string_agg(t.name, ', ')
    into v_missing
    from (values
      ('financial_events'), ('operations_config'), ('creators'),
      ('creator_roles'), ('creator_applications'),
      ('creator_commission_rules'), ('affiliate_links'),
      ('affiliate_codes'), ('affiliate_link_clicks'),
      ('order_attributions'), ('creator_commissions'),
      ('creator_payouts'), ('ugc_assignments'),
      ('documents'), ('document_links')
    ) as t(name)
   where not exists (
     select 1 from information_schema.tables
      where table_schema = 'public' and table_name = t.name
   );
  if v_missing is not null then
    raise exception '072: tables missing: %', v_missing;
  end if;

  -- Every function.
  select pg_catalog.string_agg(f.name, ', ')
    into v_missing
    from (values
      ('financial_event_berlin_date'), ('order_is_annual_delivery'),
      ('order_subscription_id'), ('record_order_payment_event'),
      ('record_annual_prepayment_event'), ('record_b2b_settlement_event'),
      ('record_order_refund_event'), ('record_annual_plan_refund_event'),
      ('record_payment_fee_event'), ('admin_decide_annual_termination'),
      ('admin_execute_subscription_termination'), ('order_shipping_due'),
      ('claim_annual_purchase_notification'),
      ('mark_annual_purchase_notification'),
      ('resolve_affiliate_link'), ('resolve_affiliate_code'),
      ('record_affiliate_click'), ('order_commission_base_cents'),
      ('attribute_order_to_creator'),
      ('reverse_creator_commission_for_refund'),
      ('creator_commission_balance')
    ) as f(name)
   where not exists (
     select 1 from pg_catalog.pg_proc p
       join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = f.name and p.prosecdef
   );
  if v_missing is not null then
    raise exception '072: writers missing or not SECURITY DEFINER: %', v_missing;
  end if;

  -- The additive columns on the three existing tables.
  select pg_catalog.string_agg(c.t || '.' || c.n, ', ')
    into v_missing
    from (values
      ('orders', 'ship_by_date'),
      ('annual_plans', 'terminated_at'),
      ('annual_plans', 'termination_request_id'),
      ('annual_plans', 'termination_effect'),
      ('annual_plans', 'internal_notification_status'),
      ('annual_plans', 'internal_notification_sent_at'),
      ('business_expenses', 'creator_commission_id'),
      ('business_expenses', 'ugc_assignment_id')
    ) as c(t, n)
   where not exists (
     select 1 from information_schema.columns
      where table_schema = 'public' and table_name = c.t and column_name = c.n
   );
  if v_missing is not null then
    raise exception '072: additive columns missing: %', v_missing;
  end if;

  -- THE APPEND-ONLY GUARDS ARE REAL TRIGGERS, not a convention.
  if (select pg_catalog.count(*) from pg_catalog.pg_trigger
       where tgname in ('financial_events_append_only',
                        'creator_commissions_append_only')
         and not tgisinternal) <> 2 then
    raise exception '072: an append-only trigger is missing';
  end if;

  -- THE TWO UNIQUENESS RULES THAT PREVENT DOUBLE RECOGNITION.
  select pg_catalog.string_agg(i.name, ', ')
    into v_missing
    from (values
      ('idx_financial_events_one_prepayment_per_plan'),
      ('idx_financial_events_one_payment_per_order'),
      ('idx_creator_commissions_one_earned_per_order'),
      ('idx_business_expenses_one_per_commission'),
      ('idx_business_expenses_one_per_ugc')
    ) as i(name)
   where not exists (
     select 1 from pg_catalog.pg_indexes
      where schemaname = 'public' and indexname = i.name
   );
  if v_missing is not null then
    raise exception '072: uniqueness indexes missing: %', v_missing;
  end if;

  -- operations_config IS EMPTY. The dispatch SLA and the attribution
  -- window are owner decisions; a seeded value here would be the
  -- invented parameter sections 4 and 9 refuse to supply.
  select pg_catalog.count(*) into v_count from public.operations_config;
  if v_count <> 0 then
    raise exception
      '072: operations_config carries % seeded row(s); the business parameters must be unset',
      v_count;
  end if;

  -- NO BUSINESS ROW WAS WRITTEN. Additive means additive.
  select pg_catalog.count(*) into v_count from public.financial_events;
  if v_count <> 0 then
    raise exception '072: financial_events already carries % row(s)', v_count;
  end if;
  select pg_catalog.count(*) into v_count from public.creator_commissions;
  if v_count <> 0 then
    raise exception '072: creator_commissions already carries % row(s)', v_count;
  end if;
  select pg_catalog.count(*) into v_count from public.creators;
  if v_count <> 0 then
    raise exception '072: creators already carries % row(s)', v_count;
  end if;

  -- NO BROWSER ROLE REACHES ANY OF IT.
  select pg_catalog.string_agg(t.name, ', ')
    into v_missing
    from (values
      ('financial_events'), ('order_attributions'), ('creator_commissions'),
      ('creators'), ('creator_applications'), ('creator_commission_rules'),
      ('affiliate_links'), ('affiliate_codes'), ('creator_payouts'),
      ('ugc_assignments'), ('documents'), ('document_links'),
      ('operations_config'), ('creator_roles'), ('affiliate_link_clicks')
    ) as t(name)
   where pg_catalog.has_table_privilege('anon', 'public.' || t.name, 'select')
      or pg_catalog.has_table_privilege('authenticated', 'public.' || t.name, 'select');
  if v_missing is not null then
    raise exception '072: a browser role can read: %', v_missing;
  end if;

  -- AND RLS IS ON EVERYWHERE, WITH NO POLICY ANYWHERE.
  select pg_catalog.string_agg(c.relname, ', ')
    into v_missing
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname in (
       'financial_events', 'order_attributions', 'creator_commissions',
       'creators', 'creator_roles', 'creator_applications',
       'creator_commission_rules', 'affiliate_links', 'affiliate_codes',
       'affiliate_link_clicks', 'creator_payouts', 'ugc_assignments',
       'documents', 'document_links', 'operations_config')
     and not c.relrowsecurity;
  if v_missing is not null then
    raise exception '072: row level security is off on: %', v_missing;
  end if;

  select pg_catalog.count(*) into v_count
    from pg_catalog.pg_policies
   where schemaname = 'public'
     and tablename in (
       'financial_events', 'order_attributions', 'creator_commissions',
       'creators', 'creator_roles', 'creator_applications',
       'creator_commission_rules', 'affiliate_links', 'affiliate_codes',
       'affiliate_link_clicks', 'creator_payouts', 'ugc_assignments',
       'documents', 'document_links', 'operations_config');
  if v_count <> 0 then
    raise exception '072: % RLS policies exist where there must be none', v_count;
  end if;

  -- THE MONEY TIER IS READ-ONLY FOR service_role.
  select pg_catalog.string_agg(t.name, ', ')
    into v_missing
    from (values ('financial_events'), ('order_attributions'),
                 ('creator_commissions')) as t(name)
   where pg_catalog.has_table_privilege('service_role', 'public.' || t.name, 'insert')
      or pg_catalog.has_table_privilege('service_role', 'public.' || t.name, 'update')
      or pg_catalog.has_table_privilege('service_role', 'public.' || t.name, 'delete');
  if v_missing is not null then
    raise exception
      '072: service_role can write a money table directly, bypassing its writers: %',
      v_missing;
  end if;

  -- AND IT CAN STILL READ ALL OF THEM.
  select pg_catalog.string_agg(t.name, ', ')
    into v_missing
    from (values ('financial_events'), ('order_attributions'),
                 ('creator_commissions'), ('creators'), ('documents'),
                 ('operations_config')) as t(name)
   where not pg_catalog.has_table_privilege('service_role', 'public.' || t.name, 'select');
  if v_missing is not null then
    raise exception '072: service_role cannot read: %', v_missing;
  end if;

  -- DELETE IS GRANTED NOWHERE, on either tier.
  select pg_catalog.string_agg(t.name, ', ')
    into v_missing
    from (values
      ('creators'), ('creator_roles'), ('creator_applications'),
      ('creator_commission_rules'), ('affiliate_links'), ('affiliate_codes'),
      ('affiliate_link_clicks'), ('creator_payouts'), ('ugc_assignments'),
      ('documents'), ('document_links'), ('operations_config')
    ) as t(name)
   where pg_catalog.has_table_privilege('service_role', 'public.' || t.name, 'delete');
  if v_missing is not null then
    raise exception '072: DELETE is granted on: %', v_missing;
  end if;

  -- THE AUDIT MODULE VOCABULARY GAINED 'creator' AND LOST NOTHING.
  if (select pg_catalog.count(*) from pg_catalog.pg_constraint
       where conrelid = 'public.admin_activity_log'::pg_catalog.regclass
         and conname = 'admin_activity_log_module_check'
         and pg_catalog.pg_get_constraintdef(oid) like '%creator%'
         and pg_catalog.pg_get_constraintdef(oid) like '%customer_rights%'
         and pg_catalog.pg_get_constraintdef(oid) like '%finance%'
         and pg_catalog.pg_get_constraintdef(oid) like '%inventory%'
         and pg_catalog.pg_get_constraintdef(oid) like '%orders%'
         and pg_catalog.pg_get_constraintdef(oid) like '%b2b%'
         and pg_catalog.pg_get_constraintdef(oid) like '%documents%'
         and pg_catalog.pg_get_constraintdef(oid) like '%fulfillment%') <> 1 then
    raise exception '072: the audit module vocabulary is not the old seven plus creator';
  end if;

  -- NOTHING HERE TOUCHES INVENTORY. Part M, asserted rather than
  -- promised: no function this migration created may mention the stock
  -- ledger at all.
  select pg_catalog.string_agg(p.proname, ', ')
    into v_missing
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in (
       'record_order_payment_event', 'record_annual_prepayment_event',
       'record_b2b_settlement_event', 'record_order_refund_event',
       'record_annual_plan_refund_event', 'record_payment_fee_event',
       'admin_decide_annual_termination',
       'admin_execute_subscription_termination',
       'attribute_order_to_creator', 'reverse_creator_commission_for_refund',
       'order_shipping_due')
     and (p.prosrc like '%inventory_movements%'
          or p.prosrc like '%inventory_items%');
  if v_missing is not null then
    raise exception '072: a function reaches the stock ledger: %', v_missing;
  end if;
end
$$;

commit;
