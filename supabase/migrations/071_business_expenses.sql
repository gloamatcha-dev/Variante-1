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
-- amount_cents is the amount on the invoice, recorded once, in integer
-- cents, and never recomputed. This is the whole reason a direct cost is
-- a ROW against an order rather than a lookup through a product: last
-- year's margin must not change because this year's matcha is dearer.
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
    THE AMOUNT, IN INTEGER CENTS, AND STRICTLY POSITIVE.

    A cost is a magnitude; the fact that it is subtracted is the reader's
    job, not the sign's. Allowing a negative here would mean a "cost" that
    silently increases a margin, which is how a credit note gets booked as
    income. A supplier credit is recorded as what it is - its own row,
    with its own date - and never as a negative cost.

    Zero is excluded too: a cost of nothing is a cost that was not
    incurred, and recording it only makes the completeness count lie.
  */
  amount_cents  integer not null check (amount_cents > 0),

  currency      text not null default 'EUR' check (currency = 'EUR'),

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

-- The three questions this table is ever asked: what did a period cost,
-- what did one order cost, and how does a period split by kind.
create index if not exists idx_business_expenses_occurred_on
  on public.business_expenses (occurred_on);
create index if not exists idx_business_expenses_order
  on public.business_expenses (order_id)
  where order_id is not null;
create index if not exists idx_business_expenses_category
  on public.business_expenses (category, occurred_on);

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
  -- THE AUDIT'S IDEMPOTENCY KEY, ON ALL THREE WRITERS ---------

  admin_activity_log is unique on (module, action, operation_id) and
  inserts ON CONFLICT DO NOTHING, so a caller that passes a STABLE
  p_operation_id audits ONE event however many times its request is
  retried. That is why the parameter exists and why the route supplies it.

  It coalesces to a fresh uuid rather than defaulting to NULL because
  admin_activity_log.operation_id is NOT NULL: passing the parameter
  through unguarded made every writer raise the moment it was omitted.

  coalesce is deliberately BARE and not pg_catalog-qualified. It is a SQL
  construct rather than a function, so pg_catalog.coalesce() does not
  exist - under search_path = '' the bare spelling is the correct one, and
  it is what migration 070 uses for the same reason.
  Found by calling these functions against a real PostgreSQL - nothing
  that reads this file could have known that column's nullability.
*/
create or replace function public.admin_record_business_expense(
  p_actor_user_id uuid,
  p_occurred_on   date,
  p_category      text,
  p_amount_cents  integer,
  p_description   text,
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
  v_row public.business_expenses;
begin
  if p_actor_user_id is null then
    raise exception 'an expense needs an author';
  end if;

  /*
    THE ROW IS WRITTEN FIRST AND THE AUDIT SECOND, which is the order
    migration 052 established: every CHECK on the table has to have passed
    before anything claims the mutation happened. A bad amount, a bad
    category or a general expense carrying an order raises here, the
    transaction goes, and no audit row survives to say otherwise.
  */
  insert into public.business_expenses (
    occurred_on, category, order_id, description,
    amount_cents, vendor, note, created_by
  )
  values (
    p_occurred_on,
    p_category,
    p_order_id,
    pg_catalog.btrim(p_description),
    p_amount_cents,
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
    'Kosten erfasst: ' || v_row.category || ' ' || v_row.amount_cents::text || ' Cent',
    coalesce(p_operation_id, pg_catalog.gen_random_uuid()),
    pg_catalog.jsonb_build_object(
      'occurredOn', v_row.occurred_on,
      'category', v_row.category,
      'amountCents', v_row.amount_cents,
      'orderId', v_row.order_id,
      'vendor', v_row.vendor
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
  p_amount_cents  integer,
  p_description   text,
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
  v_before public.business_expenses;
  v_row    public.business_expenses;
begin
  if p_actor_user_id is null then
    raise exception 'an expense needs an author';
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
     set occurred_on  = p_occurred_on,
         category     = p_category,
         order_id     = p_order_id,
         description  = pg_catalog.btrim(p_description),
         amount_cents = p_amount_cents,
         vendor       = case when p_vendor is null or pg_catalog.btrim(p_vendor) = ''
                             then null else pg_catalog.btrim(p_vendor) end,
         note         = case when p_note is null or pg_catalog.btrim(p_note) = ''
                             then null else pg_catalog.btrim(p_note) end,
         updated_at   = pg_catalog.now()
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
    'Kosten korrigiert: ' || v_row.category || ' ' || v_row.amount_cents::text || ' Cent',
    coalesce(p_operation_id, pg_catalog.gen_random_uuid()),
    pg_catalog.jsonb_build_object(
      'before', pg_catalog.jsonb_build_object(
        'occurredOn', v_before.occurred_on,
        'category', v_before.category,
        'amountCents', v_before.amount_cents,
        'orderId', v_before.order_id
      ),
      'after', pg_catalog.jsonb_build_object(
        'occurredOn', v_row.occurred_on,
        'category', v_row.category,
        'amountCents', v_row.amount_cents,
        'orderId', v_row.order_id
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
  v_before public.business_expenses;
begin
  if p_actor_user_id is null then
    raise exception 'a deletion needs an author';
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
    'Kosten gelöscht: ' || v_before.category || ' ' || v_before.amount_cents::text || ' Cent',
    coalesce(p_operation_id, pg_catalog.gen_random_uuid()),
    pg_catalog.jsonb_build_object(
      'occurredOn', v_before.occurred_on,
      'category', v_before.category,
      'amountCents', v_before.amount_cents,
      'orderId', v_before.order_id,
      'description', v_before.description,
      'vendor', v_before.vendor,
      'recordedBy', v_before.created_by
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

/*
  SELECT ONLY, plus the three functions.

  service_role is deliberately NOT granted insert, update or delete on the
  table: if it were, a route could write an expense without an audit row,
  and the one-transaction guarantee above would be advisory. The writers
  are SECURITY DEFINER, so they carry the privilege the caller does not.
*/
grant select on table public.business_expenses to service_role;

revoke all on function public.admin_record_business_expense(uuid, date, text, integer, text, uuid, text, text, uuid)
  from public, anon, authenticated;
grant execute on function public.admin_record_business_expense(uuid, date, text, integer, text, uuid, text, text, uuid)
  to service_role;

revoke all on function public.admin_update_business_expense(uuid, uuid, date, text, integer, text, uuid, text, text, uuid)
  from public, anon, authenticated;
grant execute on function public.admin_update_business_expense(uuid, uuid, date, text, integer, text, uuid, text, text, uuid)
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
-- it to seven modules and this needed none of them added.
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
      ('amount_cents'), ('currency'), ('vendor'), ('note'),
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

  -- the constraint that keeps the two kinds of cost apart
  select pg_catalog.count(*) into v_count
    from pg_catalog.pg_constraint
   where conname = 'business_expenses_order_scope_check'
     and conrelid = 'public.business_expenses'::pg_catalog.regclass;
  if v_count <> 1 then
    raise exception '071: business_expenses_order_scope_check is missing';
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
