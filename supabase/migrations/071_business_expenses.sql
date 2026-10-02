-- ══════════════════════════════════════════════════════════════
-- 071  BUSINESS EXPENSES: THE COST SIDE, MANUALLY ENTERED
-- ══════════════════════════════════════════════════════════════
--
-- GLOA can say what it EARNED since migration 004: every order freezes
-- its own net, gross, tax, discount, shipping and - since 019 - whatever
-- was refunded. It has never been able to say what anything COST.
--
-- This migration is the table migration 050 said would come. Its header
-- is worth quoting, because it decided the shape of this one:
--
--     "Not one column here holds a price, a value, a cost or an amount.
--      That is a deliberate boundary, not an omission: what something
--      cost is a financial fact that belongs to accounting, and it
--      arrives with its own package and its own tables."
--
-- So inventory still answers quantities and this answers money, and
-- neither grows a column belonging to the other. A margin computed from
-- the stock ledger's purchase prices would have been the second source
-- of truth 050 refused to create.
--
-- ── ONE TABLE, TWO KINDS OF COST ──────────────────────────────
--
-- The distinction the business actually makes is not "physical vs not",
-- it is "does this belong to one order":
--
--   order_id IS NOT NULL   a DIRECT cost of that order. Matcha, the
--                          pouch and carton it shipped in, what the
--                          carrier actually charged, what the payment
--                          provider actually kept.
--
--   order_id IS NULL       a GENERAL business expense. Software, fees,
--                          travel, an accountant, a sample sent to a
--                          cafe. It belongs to a PERIOD, not an order.
--
-- Two tables would have been two places to look for one number and two
-- chances to count a cost twice. One table with a nullable order and a
-- CHECK that keeps the two kinds apart is smaller and cannot drift.
--
-- ── WHY MANUAL, AND WHY THAT IS NOT A COMPROMISE ──────────────
--
-- Nothing in this repository knows a cost. There is no supplier price
-- anywhere in migrations 001-070, no packaging cost, no carrier invoice,
-- and the Stripe webhook has never read a balance_transaction - so no
-- payment fee has ever been persisted either.
--
-- A cost therefore arrives the way it actually arrives: a person reads an
-- invoice and records what it says. This migration does NOT derive, model
-- or estimate any of them, and deliberately offers no hook to:
--
--   no "cost per gram" on a product
--   no fee percentage
--   no shipping price table
--   no allocation of a general expense across orders
--   no valuation, average cost, FIFO or LIFO
--
-- Every one of those would be this system inventing a number. A missing
-- cost stays MISSING, and the finance screen is required to say so
-- rather than present a margin that looks exact and is not.
--
-- ── WHAT IS FROZEN AND WHAT IS NOT ────────────────────────────
--
-- gross_cents is the amount on the invoice, recorded once, in integer
-- cents, and never recomputed. This is the whole reason a direct cost is
-- a ROW against an order rather than a lookup through a product: last
-- year's margin must not change because this year's matcha is dearer.
--
-- ── GROSS, AND VAT ONLY WHERE IT IS KNOWN ─────────────────────
--
-- The amount is GROSS - what the document says was payable - and it is
-- named gross_cents so that nobody has to guess. An earlier draft called
-- it amount_cents and said nothing, which was the one defect here that
-- could not have been repaired later: the contribution margin subtracts
-- it from GROSS revenue, so a net figure typed into it would have
-- overstated the margin by the VAT, permanently and invisibly.
--
-- vat_cents is the input VAT, and it is NULLABLE on purpose:
--
--   NULL   the VAT amount is not known. A supplier statement that has
--          not arrived, a receipt with no VAT line. This is the honest
--          default and it must stay distinguishable from zero forever.
--   0      the VAT amount is KNOWN, from the source document or the
--          applicable treatment, to be exactly zero.
--   > 0    the VAT amount is known.
--
-- No tax treatment is named or implied here. This column records what a
-- document says; deciding WHY a document shows no VAT is an accounting
-- question this system cannot answer and does not try to.
--
-- NO VAT RATE IS EVER ASSUMED. There is no 19, no 7, no /1.19 and no
-- /1.07 anywhere in this migration or in lib/financeSummary.ts. A net
-- figure is DISPLAYED as gross_cents - vat_cents only where vat_cents is
-- known, and it is never stored - a persisted net would be a second
-- source for a number that is already derivable, and a wrong one on
-- every row whose VAT is unknown.
--
-- ── CHANNEL: THE SAME FOUR VALUES MIGRATION 050 ESTABLISHED ───
--
-- 050 settled this vocabulary for inventory areas and said why: "Four
-- fixed values, because these are GLOA's sales channels and not a
-- taxonomy the operator maintains." This table reuses it exactly -
-- 'b2c', 'b2b', 'event', 'internal' - rather than inventing a second
-- spelling of the same four things. 'internal' is what the finance
-- screen labels Allgemein.
--
-- FOR AN ORDER-LINKED COST THE CHANNEL IS THE ORDER'S, and the writers
-- derive it rather than accepting it: public.orders.customer_type is
-- 'private' or 'business', so a direct cost is b2c or b2b and can be
-- neither event nor internal. A caller that sends a conflicting channel
-- is overruled, not obeyed.
--
-- And where the order cannot represent Event, this does not pretend it
-- can: an event expense has no order, which is exactly the shape the
-- scope CHECK already requires of a general expense.
--
-- ── PAYMENT STATUS: TWO VALUES, AND NO ACCOUNTING ─────────────
--
-- 'open' or 'paid', and nothing else. No partial payment, no overdue, no
-- cancelled, no refund state - there is no fact in this schema that
-- could support any of them, and a status nobody can derive is a status
-- that goes stale silently.
--
-- IT CHANGES NO TOTAL. An open expense counts against the period exactly
-- like a paid one: this is a cost ledger, not cash-flow accounting, and
-- quietly excluding unpaid invoices from a margin would make the margin
-- depend on when somebody got round to paying.
--
-- ── NOTHING IS REACHABLE WITHOUT THE ADMIN SESSION ────────────
--
-- RLS on, no policy for anon or authenticated, no grant to either, and
-- the three writers are SECURITY DEFINER and granted to service_role
-- alone. Finance is the most sensitive screen GLOA has; a browser role
-- cannot read one row of it.

begin;

-- ── 1. THE TABLE ──────────────────────────────────────────────

create table if not exists public.business_expenses (
  id            uuid primary key default gen_random_uuid(),

  -- WHEN THE COST BELONGS, as a DATE and not a timestamp.
  --
  -- An invoice has a date, not an instant, and a period filter that
  -- compared instants across a time zone would move a cost between two
  -- months depending on where it was read. A date cannot.
  occurred_on   date not null,

  /*
    WHAT KIND OF COST. Six values, and the vocabulary is closed on
    purpose: a free-text category becomes thirty spellings of "Verpackung"
    and no breakdown at all.

    The first five are DIRECT - they belong to an order. 'general' is the
    only one that does not, and the CHECK below makes that structural
    rather than a convention somebody remembers.

    'shipping' here is what the CARRIER charged. It is never what the
    customer paid for shipping: that amount is revenue and already lives
    in orders.shipping_gross_cents. Confusing the two would subtract
    income from income.
  */
  category      text not null check (category in (
                  'matcha_cogs',    -- the product itself
                  'packaging',      -- pouch, carton, filler, label
                  'shipping',       -- what the CARRIER charged us
                  'payment_fee',    -- what the provider kept
                  'other_direct',   -- any other cost of that one order
                  'general'         -- a period cost, belonging to no order
                )),

  /*
    THE ORDER THIS COST BELONGS TO, or null for a general expense.

    ON DELETE RESTRICT, for migration 070's reason: a cost is evidence of
    what an order cost, and an order that could be deleted out from under
    it would leave a direct cost pointing at nothing while still counting
    against the margin. Nothing in this repository deletes an order, and
    this makes that structural rather than lucky.
  */
  order_id      uuid references public.orders(id) on delete restrict,

  description   text not null check (char_length(btrim(description)) between 1 and 300),

  /*
    THE GROSS AMOUNT, IN INTEGER CENTS, AND STRICTLY POSITIVE.

    GROSS means what the supplier document says was payable, including
    VAT. The name carries that, because the margin subtracts this figure
    from gross revenue and a net number here would overstate it.

    A cost is a magnitude; the fact that it is subtracted is the reader's
    job, not the sign's. Allowing a negative here would mean a "cost" that
    silently increases a margin, which is how a credit note gets booked as
    income.

    SUPPLIER CREDITS ARE NOT SUPPORTED BY THIS FOUNDATION, and must not be
    worked around. Every row here is a POSITIVE cost, so entering a credit
    note as an expense would INCREASE costs rather than reduce them -
    exactly backwards. An earlier version of this comment suggested
    recording one "as its own row", which would have been that mistake.

    A credit or an adjustment needs an explicit model of its own - a signed
    adjustment, or a credit table with its own rules about which period it
    belongs to - and this migration deliberately does not pretend to
    account for one. Until that exists, a supplier credit belongs outside
    this ledger.

    Zero is excluded too: a cost of nothing is a cost that was not
    incurred, and recording it only makes the completeness count lie.
  */
  gross_cents   integer not null check (gross_cents > 0),

  /*
    THE INPUT VAT, OR NOTHING AT ALL.

    Nullable, and the null is load-bearing: it means "the amount is not
    known", which is a different statement from "the amount is zero" and
    must stay different forever. A VAT overview built by treating null as
    zero would be a confident report of a figure nobody has.

    A known zero is just that - the document, or the treatment that
    applies to it, puts the VAT at nothing. This column makes no claim
    about which treatment that was.

    No rate is assumed anywhere. The bounds are the only arithmetic:
    between zero and the gross amount, because input VAT cannot exceed
    what was payable.
  */
  vat_cents     integer,

  currency      text not null default 'EUR' check (currency = 'EUR'),

  /*
    WHICH CHANNEL THE COST BELONGS TO.

    Migration 050's exact four values, for 050's exact reason. 'internal'
    is Allgemein on the finance screen. For an order-linked cost the
    writers DERIVE this from the order and ignore what the caller sent -
    see section 2.
  */
  channel       text not null check (channel in (
                  'b2c',        -- B2C
                  'b2b',        -- B2B
                  'event',      -- Event
                  'internal'    -- Allgemein
                )),

  /*
    WHETHER IT HAS BEEN PAID. Descriptive state, two values, and it
    changes no total: see the header.
  */
  payment_status text not null check (payment_status in ('open', 'paid')),

  vendor        text check (vendor is null
                  or char_length(btrim(vendor)) between 1 and 160),
  note          text check (note is null or char_length(note) <= 2000),

  /*
    WHO RECORDED IT. The admin's auth user, NOT NULL: a manually entered
    financial figure with no author is not auditable, and this screen is
    the one where that matters most. The full who/when/what trail is
    migration 052's admin_activity_log, written by the three writers below
    in the same transaction as the row itself.

    No ON DELETE clause, exactly like annual_plans.user_id: a recorded
    expense must not be able to lose its author.
  */
  created_by    uuid not null references auth.users(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz
);

/*
  THE VAT BOUNDS, AS A NAMED CONSTRAINT.

  Declared here rather than inline so the verify block, the preflight and
  the postcheck can all refer to it by a name this file chose instead of
  one Postgres derived. The rule is the only arithmetic VAT gets: it is
  unknown, or it is between nothing and the gross amount. Input VAT cannot
  exceed what was payable, and no rate is assumed to reach that bound.
*/
alter table public.business_expenses
  drop constraint if exists business_expenses_vat_bounds_check;

alter table public.business_expenses
  add constraint business_expenses_vat_bounds_check
  check (
    vat_cents is null
    or (vat_cents >= 0 and vat_cents <= gross_cents)
  );

/*
  THE TWO KINDS STAY APART.

  'general' means "belongs to a period, not an order", so a general
  expense with an order is a contradiction - and a direct cost without one
  is the more dangerous half: it would be counted as a direct cost of the
  period while belonging to no order, so the per-order breakdown and the
  total would disagree and neither would be wrong on its own terms.

  Declared as a named table-level constraint so the preflight, the
  postcheck and the suite can all refer to it by a name this file chose.
*/
alter table public.business_expenses
  drop constraint if exists business_expenses_order_scope_check;

alter table public.business_expenses
  add constraint business_expenses_order_scope_check
  check (
    (order_id is null and category = 'general')
    or (order_id is not null and category <> 'general')
  );

-- The four questions this table is ever asked: what did a period cost,
-- what did one order cost, and how does a period split by kind and by
-- channel.
create index if not exists idx_business_expenses_occurred_on
  on public.business_expenses (occurred_on);
create index if not exists idx_business_expenses_order
  on public.business_expenses (order_id)
  where order_id is not null;
create index if not exists idx_business_expenses_category
  on public.business_expenses (category, occurred_on);
-- The fourth question: what one channel cost in a period.
create index if not exists idx_business_expenses_channel
  on public.business_expenses (channel, occurred_on);

-- ── 2. THE WRITERS ────────────────────────────────────────────
--
-- Migration 052's shape, and for its reasons: do the thing, then record
-- WHO did it, in ONE transaction, so an audited mutation cannot exist
-- without its audit row and vice versa.
--
-- They are also the only way the row can be written at all - service_role
-- gets SELECT on the table and no INSERT, UPDATE or DELETE - so there is
-- no second path that skips the audit.

/*
  -- ONE OPERATION ID IS ONE LOGICAL MUTATION -----------------

  p_operation_id is the caller's idempotency key, and all three writers
  honour it for the MUTATION and not merely for the audit row.

  THE DEFECT THIS REPLACES. An earlier version passed p_operation_id
  straight to record_admin_activity and called that idempotency. It was
  not: admin_activity_log is unique on (module, action, operation_id) and
  inserts ON CONFLICT DO NOTHING, so a retry produced ONE audit event -
  and nothing stopped it producing a SECOND business_expenses row. For a
  cost ledger that is the worst possible failure, because the duplicate is
  invisible in the audit trail and counts twice in every margin.

  -- WHY THE REGISTRY IS THE AUDIT LOG, NOT THE EXPENSE ROW ---

  Migration 050 solved the same problem for stock with a UNIQUE
  operation_id on inventory_movements, and that is correct THERE because
  nothing ever deletes a movement. An expense IS deletable, so a key
  living on the row would vanish with it - and replaying the old create
  would silently resurrect a cost somebody had deliberately removed.

  admin_activity_log has no delete path at all. It is append-only, so it
  is the one place an operation's identity survives the deletion of what
  it created. The lookup below is therefore against the log, not the row.

  -- HOW IT IS MADE CONCURRENCY-SAFE -------------------------

  A bare "look, then insert" is not enough: two simultaneous retries can
  both observe absence and both proceed. So each writer takes a
  TRANSACTION-SCOPED ADVISORY LOCK keyed on its own module/action plus the
  operation id, before it looks.

  The hash is ONLY the lock key. The decision is an exact comparison on
  (module, action, operation_id), so a hash collision can at worst make
  two unrelated operations queue behind each other - it can never make
  them count as the same operation.

  -- WHEN NO OPERATION ID IS SUPPLIED -----------------------

  It coalesces to a fresh uuid, which preserves the convenience of calling
  a writer without one: a fresh id matches nothing, so the mutation
  proceeds exactly as before. coalesce is deliberately BARE rather than
  pg_catalog-qualified, because it is a SQL construct and not a function -
  pg_catalog.coalesce() does not exist, and under search_path = '' the bare
  spelling is the correct one. Migration 070 spells it the same way.

  Separately, and this is the fact that first forced the coalesce:
  admin_activity_log.operation_id is NOT NULL, so passing the parameter
  through unguarded made every writer raise the moment it was omitted.
  Found by calling these functions against a real PostgreSQL - nothing
  that reads this file could have known that column's nullability.
*/
/*
  -- THE CHANNEL OF AN ORDER-LINKED COST IS NOT THE CALLER'S ---

  Both writing functions resolve it the same way, and the rule is worth
  stating once:

    order_id IS NOT NULL   the channel is DERIVED from
                           public.orders.customer_type. 'business' is
                           b2b, anything else is b2c. Whatever the caller
                           sent is discarded - that is what makes it
                           impossible to file a B2C cost under B2B, from
                           a browser or from anywhere else.

    order_id IS NULL       the channel is the caller's, and the CHECK is
                           what keeps it to the four values. A general
                           expense is the only shape that can be 'event'
                           or 'internal', because an order can represent
                           neither.

  The lookup also means a direct cost naming an order that does not exist
  fails HERE, with a message the route can turn into a sentence, instead
  of arriving as a foreign-key violation after the channel has already
  been decided.
*/
create or replace function public.admin_record_business_expense(
  p_actor_user_id uuid,
  p_occurred_on   date,
  p_category      text,
  p_gross_cents   integer,
  p_description   text,
  p_channel       text,
  p_payment_status text,
  p_vat_cents     integer default null,
  p_order_id      uuid default null,
  p_vendor        text default null,
  p_note          text default null,
  p_operation_id  uuid default null
)
returns public.business_expenses
language plpgsql
security definer set search_path = ''
as $$
declare
  v_row           public.business_expenses;
  v_customer_type text;
  v_channel       text;
  v_operation_id  uuid;
  v_prior_entity  text;
begin
  if p_actor_user_id is null then
    raise exception 'an expense needs an author';
  end if;

  /*
    THE OPERATION, RESOLVED THEN SERIALISED THEN CHECKED.

    In that order, and the order is the whole guarantee. Resolving first
    means the lock and the lookup both see the same id; locking before
    looking means two concurrent retries cannot both find nothing.
  */
  v_operation_id := coalesce(p_operation_id, pg_catalog.gen_random_uuid());

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'finance:expense_recorded:' || v_operation_id::pg_catalog.text, 0));

  select l.entity_id into v_prior_entity
    from public.admin_activity_log l
   where l.module = 'finance'
     and l.action = 'expense_recorded'
     and l.operation_id = v_operation_id
   limit 1;

  if v_prior_entity is not null then
    /*
      THIS OPERATION ALREADY HAPPENED. Return what it produced and write
      NOTHING - no second expense, no second audit row.

      If that expense has since been deleted the select finds nothing and
      this returns null, which is the deliberate answer: a replay of an
      old create must never resurrect a cost somebody removed. The audit
      log still holds both the creation and the deletion, so the history
      is intact even though the row is gone.
    */
    select * into v_row
      from public.business_expenses
     where id = v_prior_entity::uuid;
    return v_row;
  end if;

  -- The channel, decided here and never taken on trust. See the note
  -- above this function.
  if p_order_id is not null then
    select o.customer_type into v_customer_type
      from public.orders o
     where o.id = p_order_id;
    if v_customer_type is null then
      raise exception 'business_expense_order_missing';
    end if;
    v_channel := case when v_customer_type = 'business' then 'b2b' else 'b2c' end;
  else
    if p_channel is null then
      raise exception 'a general expense needs a channel';
    end if;
    v_channel := p_channel;
  end if;

  /*
    THE ROW IS WRITTEN FIRST AND THE AUDIT SECOND, which is the order
    migration 052 established: every CHECK on the table has to have passed
    before anything claims the mutation happened. A bad amount, a VAT
    figure larger than the gross, an unknown channel or payment status, a
    bad category or a general expense carrying an order all raise here,
    the transaction goes, and no audit row survives to say otherwise.
  */
  insert into public.business_expenses (
    occurred_on, category, order_id, description,
    gross_cents, vat_cents, channel, payment_status,
    vendor, note, created_by
  )
  values (
    p_occurred_on,
    p_category,
    p_order_id,
    pg_catalog.btrim(p_description),
    p_gross_cents,
    p_vat_cents,
    v_channel,
    p_payment_status,
    case when p_vendor is null or pg_catalog.btrim(p_vendor) = ''
         then null else pg_catalog.btrim(p_vendor) end,
    case when p_note is null or pg_catalog.btrim(p_note) = ''
         then null else pg_catalog.btrim(p_note) end,
    p_actor_user_id
  )
  returning * into v_row;

  perform public.record_admin_activity(
    p_actor_user_id,
    'finance',
    'expense_recorded',
    'business_expense',
    v_row.id::text,
    'Kosten erfasst: ' || v_row.category || ' ' || v_row.gross_cents::text || ' Cent brutto',
    v_operation_id,
    /*
      EVERY MATERIAL FIELD THE OPERATOR TYPED, so the audit row describes
      the whole record rather than a summary of it. description and note
      were missing before, which made "what was recorded" unanswerable
      from the log alone.

      NULL GOES IN AS NULL. jsonb_build_object keeps a SQL null as a JSON
      null rather than dropping the key, so an unknown VAT, an absent
      vendor and an empty note all survive as STATED unknowns instead of
      absent fields somebody later reads as zero or as "".

      The expense's own uuid is the audit row's entity_id and is not
      duplicated in here.
    */
    pg_catalog.jsonb_build_object(
      'occurredOn', v_row.occurred_on,
      'category', v_row.category,
      'description', v_row.description,
      'grossCents', v_row.gross_cents,
      'vatCents', v_row.vat_cents,
      'channel', v_row.channel,
      'paymentStatus', v_row.payment_status,
      'orderId', v_row.order_id,
      'vendor', v_row.vendor,
      'note', v_row.note,
      'recordedBy', v_row.created_by
    )
  );

  return v_row;
end;
$$;

create or replace function public.admin_update_business_expense(
  p_actor_user_id uuid,
  p_expense_id    uuid,
  p_occurred_on   date,
  p_category      text,
  p_gross_cents   integer,
  p_description   text,
  p_channel       text,
  p_payment_status text,
  p_vat_cents     integer default null,
  p_order_id      uuid default null,
  p_vendor        text default null,
  p_note          text default null,
  p_operation_id  uuid default null
)
returns public.business_expenses
language plpgsql
security definer set search_path = ''
as $$
declare
  v_before        public.business_expenses;
  v_row           public.business_expenses;
  v_customer_type text;
  v_channel       text;
  v_operation_id  uuid;
  v_prior_entity  text;
begin
  if p_actor_user_id is null then
    raise exception 'an expense needs an author';
  end if;

  -- The same resolve/serialise/check as the create writer.
  v_operation_id := coalesce(p_operation_id, pg_catalog.gen_random_uuid());

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'finance:expense_updated:' || v_operation_id::pg_catalog.text, 0));

  select l.entity_id into v_prior_entity
    from public.admin_activity_log l
   where l.module = 'finance'
     and l.action = 'expense_updated'
     and l.operation_id = v_operation_id
   limit 1;

  if v_prior_entity is not null then
    /*
      THIS CORRECTION ALREADY HAPPENED.

      Returning the row as it stands now, without touching it: no second
      UPDATE, so updated_at does not advance, and no second audit event.
      A retried request is the same correction, not another one.
    */
    if v_prior_entity <> p_expense_id::pg_catalog.text then
      raise exception 'business_expense_operation_reused';
    end if;
    select * into v_row
      from public.business_expenses
     where id = p_expense_id;
    return v_row;
  end if;

  -- The SAME derivation as the create writer, for the same reason: a
  -- correction must not be a way round it. Re-resolved from the order the
  -- correction names, so moving a cost to another order moves its channel
  -- with it.
  if p_order_id is not null then
    select o.customer_type into v_customer_type
      from public.orders o
     where o.id = p_order_id;
    if v_customer_type is null then
      raise exception 'business_expense_order_missing';
    end if;
    v_channel := case when v_customer_type = 'business' then 'b2b' else 'b2c' end;
  else
    if p_channel is null then
      raise exception 'a general expense needs a channel';
    end if;
    v_channel := p_channel;
  end if;

  /*
    LOCKED BEFORE IT IS READ, so two operators correcting the same typo
    cannot interleave into a row neither of them described. The BEFORE
    values go into the audit metadata: what a correction actually is, is
    the pair of amounts, and an audit entry holding only the new one
    cannot answer "what was it changed from".
  */
  select * into v_before
    from public.business_expenses
   where id = p_expense_id
     for update;

  if v_before.id is null then
    return null;
  end if;

  update public.business_expenses
     set occurred_on    = p_occurred_on,
         category       = p_category,
         order_id       = p_order_id,
         description    = pg_catalog.btrim(p_description),
         gross_cents    = p_gross_cents,
         /*
           vat_cents IS SET, NOT MERGED. A correction that omits it is a
           correction saying the VAT is not known - which is a real thing
           to say, and coalescing to the old value would make "I no longer
           know this" impossible to express.
         */
         vat_cents      = p_vat_cents,
         channel        = v_channel,
         payment_status = p_payment_status,
         vendor         = case when p_vendor is null or pg_catalog.btrim(p_vendor) = ''
                               then null else pg_catalog.btrim(p_vendor) end,
         note           = case when p_note is null or pg_catalog.btrim(p_note) = ''
                               then null else pg_catalog.btrim(p_note) end,
         updated_at     = pg_catalog.now()
   where id = p_expense_id
  returning * into v_row;

  /*
    created_by IS NOT TOUCHED. It is who RECORDED the expense, which a
    correction does not change; who corrected it is in the audit row.
  */
  perform public.record_admin_activity(
    p_actor_user_id,
    'finance',
    'expense_updated',
    'business_expense',
    v_row.id::text,
    'Kosten korrigiert: ' || v_row.category || ' ' || v_row.gross_cents::text || ' Cent brutto',
    v_operation_id,
    /*
      BOTH SIDES CARRY EVERY FIELD THAT CAN CHANGE, and now that is
      literally true: the UPDATE above writes occurred_on, category,
      order_id, description, gross_cents, vat_cents, channel,
      payment_status, vendor and note, so all ten appear on each side.

      An earlier version said this sentence while omitting description,
      vendor and note - so a correction to any of those three left an
      audit row claiming nothing had changed. A correction IS the pair;
      half a pair cannot answer "what was it before".

      created_by and created_at are deliberately absent: they are not
      mutable, so they belong to the creation's own audit row.
    */
    pg_catalog.jsonb_build_object(
      'before', pg_catalog.jsonb_build_object(
        'occurredOn', v_before.occurred_on,
        'category', v_before.category,
        'description', v_before.description,
        'grossCents', v_before.gross_cents,
        'vatCents', v_before.vat_cents,
        'channel', v_before.channel,
        'paymentStatus', v_before.payment_status,
        'orderId', v_before.order_id,
        'vendor', v_before.vendor,
        'note', v_before.note
      ),
      'after', pg_catalog.jsonb_build_object(
        'occurredOn', v_row.occurred_on,
        'category', v_row.category,
        'description', v_row.description,
        'grossCents', v_row.gross_cents,
        'vatCents', v_row.vat_cents,
        'channel', v_row.channel,
        'paymentStatus', v_row.payment_status,
        'orderId', v_row.order_id,
        'vendor', v_row.vendor,
        'note', v_row.note
      )
    )
  );

  return v_row;
end;
$$;

create or replace function public.admin_delete_business_expense(
  p_actor_user_id uuid,
  p_expense_id    uuid,
  p_operation_id  uuid default null
)
returns boolean
language plpgsql
security definer set search_path = ''
as $$
declare
  v_before       public.business_expenses;
  v_operation_id uuid;
  v_prior_entity text;
begin
  if p_actor_user_id is null then
    raise exception 'a deletion needs an author';
  end if;

  -- The same resolve/serialise/check as the other two writers.
  v_operation_id := coalesce(p_operation_id, pg_catalog.gen_random_uuid());

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'finance:expense_deleted:' || v_operation_id::pg_catalog.text, 0));

  select l.entity_id into v_prior_entity
    from public.admin_activity_log l
   where l.module = 'finance'
     and l.action = 'expense_deleted'
     and l.operation_id = v_operation_id
   limit 1;

  if v_prior_entity is not null then
    /*
      THIS DELETION ALREADY HAPPENED. true, deterministically, with no
      second delete and no second audit event - the row is already gone,
      which is exactly what the caller asked for.
    */
    if v_prior_entity <> p_expense_id::pg_catalog.text then
      raise exception 'business_expense_operation_reused';
    end if;
    return true;
  end if;

  select * into v_before
    from public.business_expenses
   where id = p_expense_id
     for update;

  if v_before.id is null then
    return false;
  end if;

  delete from public.business_expenses where id = p_expense_id;

  /*
    A HARD DELETE, AND THE TRAIL IS THE AUDIT ROW.

    A manually typed figure has to be removable - the alternative is a
    finance screen carrying somebody's slip forever. What must not be
    removable is the RECORD that it existed, so every value goes into the
    audit metadata before the row goes. admin_activity_log is append-only
    and has no delete path, so this is the durable half.
  */
  perform public.record_admin_activity(
    p_actor_user_id,
    'finance',
    'expense_deleted',
    'business_expense',
    v_before.id::text,
    'Kosten gelöscht: ' || v_before.category || ' ' || v_before.gross_cents::text || ' Cent brutto',
    v_operation_id,
    /*
      EVERY FINAL VALUE, because the row is about to stop existing - and
      this object then becomes the only record that the expense was ever
      there, so it has to be enough to RECONSTRUCT it.

      All fourteen: when it happened, what kind it was, what it said, what
      it cost gross, what VAT was known, its currency, its channel,
      whether it had been paid, which order it belonged to, its vendor,
      its note, who recorded it, and both timestamps. note, currency,
      created_at and updated_at were missing before, which left a deleted
      expense only partly recoverable.

      The expense's own uuid is the audit row's entity_id.
    */
    pg_catalog.jsonb_build_object(
      'occurredOn', v_before.occurred_on,
      'category', v_before.category,
      'description', v_before.description,
      'grossCents', v_before.gross_cents,
      'vatCents', v_before.vat_cents,
      'currency', v_before.currency,
      'channel', v_before.channel,
      'paymentStatus', v_before.payment_status,
      'orderId', v_before.order_id,
      'vendor', v_before.vendor,
      'note', v_before.note,
      'recordedBy', v_before.created_by,
      'createdAt', v_before.created_at,
      'updatedAt', v_before.updated_at
    )
  );

  return true;
end;
$$;

-- ── 3. SECURITY ───────────────────────────────────────────────
--
-- Finance is admin-only, and "admin" in this repository means the
-- service_role behind an admin session - never a browser role. anon and
-- authenticated get nothing at all: not select, not the functions, and no
-- RLS policy that could ever let one row through.

alter table public.business_expenses enable row level security;

revoke all privileges on table public.business_expenses from anon, authenticated;
revoke all privileges on table public.business_expenses from public;
revoke all privileges on table public.business_expenses from service_role;

/*
  SELECT ONLY, plus the three functions.

  service_role is deliberately NOT granted insert, update or delete on the
  table: if it were, a route could write an expense without an audit row,
  and the one-transaction guarantee above would be advisory. The writers
  are SECURITY DEFINER, so they carry the privilege the caller does not.
*/
grant select on table public.business_expenses to service_role;

revoke all on function public.admin_record_business_expense(uuid, date, text, integer, text, text, text, integer, uuid, text, text, uuid)
  from public, anon, authenticated;
grant execute on function public.admin_record_business_expense(uuid, date, text, integer, text, text, text, integer, uuid, text, text, uuid)
  to service_role;

revoke all on function public.admin_update_business_expense(uuid, uuid, date, text, integer, text, text, text, integer, uuid, text, text, uuid)
  from public, anon, authenticated;
grant execute on function public.admin_update_business_expense(uuid, uuid, date, text, integer, text, text, text, integer, uuid, text, text, uuid)
  to service_role;

revoke all on function public.admin_delete_business_expense(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.admin_delete_business_expense(uuid, uuid, uuid)
  to service_role;

-- ── 4. WHAT THIS MIGRATION DELIBERATELY DOES NOT DO ───────────
--
-- It writes NO existing row. No order is touched, no inventory item, no
-- plan, no case. 070's tables are not read and not altered, and
-- admin_activity_log_module_check already allows 'finance' - 070 widened
-- it, and this migration needed nothing added to it. The preflight
-- verifies that dependency rather than this comment asserting it.
--
-- It also adds no revenue column. Revenue is already authoritative in
-- public.orders and must stay there: total_gross_cents, total_net_cents,
-- tax_total_cents, discount_total_cents, shipping_gross_cents and
-- refunded_total_cents are frozen per order, and a second copy of any of
-- them here would be the same mistake 050 refused to make with prices.

-- ── 5. VERIFY ─────────────────────────────────────────────────

do $$
declare
  v_missing text;
  v_count   integer;
begin
  -- the table and every column it promises
  select pg_catalog.string_agg(c.name, ', ')
    into v_missing
    from (values
      ('id'), ('occurred_on'), ('category'), ('order_id'), ('description'),
      ('gross_cents'), ('vat_cents'), ('currency'), ('channel'),
      ('payment_status'), ('vendor'), ('note'),
      ('created_by'), ('created_at'), ('updated_at')
    ) as c(name)
   where not exists (
     select 1 from information_schema.columns
      where table_schema = 'public'
        and table_name = 'business_expenses'
        and column_name = c.name
   );
  if v_missing is not null then
    raise exception '071: business_expenses is missing columns: %', v_missing;
  end if;

  -- AND THE AMBIGUOUS COLUMN MUST NOT EXIST. An earlier draft of this
  -- migration called the amount column amount_cents and said nothing
  -- about gross or net. If both ever existed at once, every reader would
  -- have to guess which one the margin used.
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name = 'business_expenses'
       and column_name = 'amount_cents'
  ) then
    raise exception '071: the ambiguous amount_cents column exists alongside gross_cents';
  end if;

  -- vat_cents is NULLABLE, and that is load-bearing: null means "not
  -- known" and must stay distinguishable from a known zero.
  if (select is_nullable from information_schema.columns
       where table_schema = 'public' and table_name = 'business_expenses'
         and column_name = 'vat_cents') <> 'YES' then
    raise exception '071: vat_cents is NOT NULL - an unknown VAT cannot be expressed';
  end if;

  -- channel and payment_status are both NOT NULL: an expense with no
  -- channel could not be reported on, and one with no payment status
  -- would be a third state nobody declared.
  if (select pg_catalog.count(*) from information_schema.columns
       where table_schema = 'public' and table_name = 'business_expenses'
         and column_name in ('channel', 'payment_status')
         and is_nullable = 'NO') <> 2 then
    raise exception '071: channel or payment_status is nullable';
  end if;

  -- THE TWO NAMED CONSTRAINTS, by name. The two closed vocabularies are
  -- CHECKs Postgres named itself, so they are verified separately below
  -- by their contents rather than listed here.
  select pg_catalog.string_agg(c.name, ', ')
    into v_missing
    from (values
      ('business_expenses_order_scope_check'),
      ('business_expenses_vat_bounds_check')
    ) as c(name)
   where not exists (
     select 1 from pg_catalog.pg_constraint
      where conname = c.name
        and conrelid = 'public.business_expenses'::pg_catalog.regclass
   );
  if v_missing is not null then
    raise exception '071: constraints missing: %', v_missing;
  end if;

  -- the channel vocabulary is migration 050's four values, exactly
  if (select pg_catalog.count(*) from pg_catalog.pg_constraint
       where conrelid = 'public.business_expenses'::pg_catalog.regclass
         and pg_catalog.pg_get_constraintdef(oid) like '%channel%'
         and pg_catalog.pg_get_constraintdef(oid) like '%b2c%'
         and pg_catalog.pg_get_constraintdef(oid) like '%b2b%'
         and pg_catalog.pg_get_constraintdef(oid) like '%event%'
         and pg_catalog.pg_get_constraintdef(oid) like '%internal%') < 1 then
    raise exception '071: the channel CHECK does not name all four of 050s channels';
  end if;

  -- and payment_status is exactly open/paid
  if (select pg_catalog.count(*) from pg_catalog.pg_constraint
       where conrelid = 'public.business_expenses'::pg_catalog.regclass
         and pg_catalog.pg_get_constraintdef(oid) like '%payment_status%'
         and pg_catalog.pg_get_constraintdef(oid) like '%open%'
         and pg_catalog.pg_get_constraintdef(oid) like '%paid%') < 1 then
    raise exception '071: the payment_status CHECK is not open/paid';
  end if;

  -- the three writers, each one SECURITY DEFINER
  select pg_catalog.string_agg(f.name, ', ')
    into v_missing
    from (values
      ('admin_record_business_expense'),
      ('admin_update_business_expense'),
      ('admin_delete_business_expense')
    ) as f(name)
   where not exists (
     select 1 from pg_catalog.pg_proc p
       join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname = f.name
        and p.prosecdef
   );
  if v_missing is not null then
    raise exception '071: writers missing or not SECURITY DEFINER: %', v_missing;
  end if;

  -- no browser role may reach the table or the writers
  if pg_catalog.has_table_privilege('anon', 'public.business_expenses', 'select')
     or pg_catalog.has_table_privilege('authenticated', 'public.business_expenses', 'select') then
    raise exception '071: a browser role can read business_expenses';
  end if;

  -- and service_role may read but never write directly
  if not pg_catalog.has_table_privilege('service_role', 'public.business_expenses', 'select') then
    raise exception '071: service_role cannot read business_expenses';
  end if;
  if pg_catalog.has_table_privilege('service_role', 'public.business_expenses', 'insert')
     or pg_catalog.has_table_privilege('service_role', 'public.business_expenses', 'update')
     or pg_catalog.has_table_privilege('service_role', 'public.business_expenses', 'delete') then
    raise exception '071: service_role can write business_expenses without an audit row';
  end if;

  -- RLS is on, and there is no policy at all
  if not exists (
    select 1 from pg_catalog.pg_class
     where oid = 'public.business_expenses'::pg_catalog.regclass
       and relrowsecurity
  ) then
    raise exception '071: row level security is not enabled on business_expenses';
  end if;
  select pg_catalog.count(*) into v_count
    from pg_catalog.pg_policies
   where schemaname = 'public' and tablename = 'business_expenses';
  if v_count <> 0 then
    raise exception '071: business_expenses carries % RLS policies', v_count;
  end if;
end
$$;

commit;
