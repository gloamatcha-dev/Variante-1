-- ══════════════════════════════════════════════════════════════
-- 050  MANUAL INVENTORY: CATEGORIES, ITEMS, AREAS, MOVEMENTS
-- ══════════════════════════════════════════════════════════════
--
-- GLOA needs to know what it has, what came in, what went out and what
-- it went out FOR. Nothing more: this is a stock account, not an ERP.
-- There is no bill of materials, no FIFO valuation, no reservation, no
-- purchase order and no automatic anything.
--
-- ── WHY NEW TABLES AND NOT public.products ────────────────────
--
-- public.products and public.product_variants (migration 007) are the
-- SELLABLE CATALOG: slug, name, description, price, SKU, size. They
-- carry no stock column and should not grow one. Inventory is a
-- different domain and mostly a different set of things - raw matcha,
-- empty pouches, shipping cartons, flyers, event cups, stickers - only a
-- few of which are ever sold as themselves. Attaching stock to the
-- catalog would mean inventing catalog rows for cardboard.
--
-- Audited before writing: the repository contains no inventory, stock,
-- warehouse, movement or ledger table, and every occurrence of the word
-- "inventory" in the source is a comment saying inventory is NOT
-- touched. There is nothing to reuse and nothing to duplicate.
--
-- ── MANUAL, AND STRUCTURALLY SO ───────────────────────────────
--
-- Nothing here is called by the checkout, the webhook, the shipment
-- transition, a refund or a cancellation. Shipping an order removes
-- nothing from a shelf. That separation is the point of this package and
-- tests/inventory.test.mjs asserts it against the source of every one of
-- those paths.
--
-- ── STOCK IS NEVER SET, ONLY MOVED ────────────────────────────
--
-- inventory_items.current_quantity is a cache of the ledger, and
-- service_role holds NO UPDATE GRANT ON IT. The only writer is
-- record_inventory_movement, which locks the row, applies a delta and
-- writes the movement carrying the balance that resulted - in one
-- transaction. A browser cannot set stock, and neither can the server
-- except by recording why.
--
-- ── NOTHING IS REACHABLE WITHOUT THE ADMIN SESSION ────────────
--
-- Every table has RLS enabled and NOT ONE POLICY, so anon and
-- authenticated can read and write nothing regardless of grants. The
-- admin API reads with the service role behind verifyAdminRequest, the
-- same shape /api/admin/orders already uses.

begin;

-- ── 1. CATEGORIES ─────────────────────────────────────────────
--
-- The operator invents their own. "Café Samples", "Messeausstattung",
-- whatever the business turns out to need - so this is a table, not a
-- CHECK constraint, and the seed list is a convenience rather than the
-- vocabulary.

create table if not exists public.inventory_categories (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(btrim(name)) between 1 and 80),
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- "Event", " event " and "EVENT" are one category, not three. Normalised
-- in the index rather than in the column, so the operator's own
-- capitalisation is what they see back.
create unique index if not exists idx_inventory_categories_name
  on public.inventory_categories (lower(btrim(name)));

drop trigger if exists set_inventory_categories_updated_at on public.inventory_categories;
create trigger set_inventory_categories_updated_at
  before update on public.inventory_categories
  for each row execute function public.set_updated_at();

-- ── 2. ITEMS ──────────────────────────────────────────────────
--
-- One row per thing GLOA keeps. The unit is the item's own and fixed:
-- no conversion table, no "kg or g depending". Raw matcha is counted in
-- g, pouches in Stück, and a delivery of 10 kg is entered as 10000.

create table if not exists public.inventory_items (
  id                    uuid primary key default gen_random_uuid(),
  name                  text not null check (length(btrim(name)) between 1 and 120),
  sku                   text check (sku is null or length(btrim(sku)) between 1 and 60),
  category_id           uuid not null references public.inventory_categories(id),

  -- Free text on purpose. A fixed list would be wrong the first time
  -- something arrives in Rollen or Bögen, and the value is only ever
  -- displayed - nothing computes with it.
  unit                  text not null check (length(btrim(unit)) between 1 and 20),

  -- THE CACHE. Written by record_inventory_movement and by nothing else;
  -- service_role is deliberately granted no UPDATE on this column.
  -- numeric(14,3): three decimals is enough for 125.500 g and exact,
  -- which a float is not.
  current_quantity      numeric(14,3) not null default 0,

  low_stock_threshold   numeric(14,3) check (low_stock_threshold is null or low_stock_threshold >= 0),
  supplier              text check (supplier is null or length(btrim(supplier)) <= 120),
  purchase_price_cents  integer check (purchase_price_cents is null or purchase_price_cents >= 0),
  notes                 text check (notes is null or length(notes) <= 2000),
  is_active             boolean not null default true,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create unique index if not exists idx_inventory_items_sku
  on public.inventory_items (lower(btrim(sku))) where sku is not null;
create index if not exists idx_inventory_items_category on public.inventory_items (category_id);
create index if not exists idx_inventory_items_active   on public.inventory_items (is_active);
create index if not exists idx_inventory_items_name     on public.inventory_items (lower(name));

drop trigger if exists set_inventory_items_updated_at on public.inventory_items;
create trigger set_inventory_items_updated_at
  before update on public.inventory_items
  for each row execute function public.set_updated_at();

/**
 * The unit may not change once movements exist.
 *
 * "-3000" means three thousand grams or three thousand pieces depending
 * on this column, so changing it retroactively rewrites the meaning of
 * every row in the ledger without touching one of them. Blocked in the
 * database because it is a data-integrity rule, not a UI preference.
 *
 * An item with no movements yet - a typo during setup - is still free to
 * be corrected.
 */
create or replace function public.inventory_item_unit_is_locked()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  if new.unit is distinct from old.unit
     and exists (select 1 from public.inventory_movements m where m.inventory_item_id = old.id)
  then
    raise exception 'inventory: the unit cannot change once movements exist (item %)', old.id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

-- ── 3. AREAS ──────────────────────────────────────────────────
--
-- A relation, not a JSON array: raw matcha genuinely serves B2C, B2B and
-- events at once, and "which items matter for an event" has to be a
-- query rather than a scan. Four fixed values, because these are GLOA's
-- sales channels and not a taxonomy the operator maintains.

create table if not exists public.inventory_item_areas (
  inventory_item_id uuid not null references public.inventory_items(id) on delete cascade,
  area              text not null check (area in ('b2c', 'b2b', 'event', 'internal')),
  primary key (inventory_item_id, area)
);

create index if not exists idx_inventory_item_areas_area on public.inventory_item_areas (area);

-- ── 4. MOVEMENTS ──────────────────────────────────────────────
--
-- The ledger. Append-only: no UPDATE and no DELETE grant is issued for
-- it anywhere in this migration, so a mistake is corrected by a second
-- movement rather than by editing the first. That is what makes the
-- history worth reading.

create table if not exists public.inventory_movements (
  id                   uuid primary key default gen_random_uuid(),
  inventory_item_id    uuid not null references public.inventory_items(id),

  -- THE IDEMPOTENCY KEY. One intended booking, one id, chosen by the
  -- client before it asks. A double click, a retry and a lost response
  -- all present the same one and the unique index below turns the second
  -- and third into a no-op. A disabled button is not a guarantee.
  operation_id         uuid not null,

  -- Signed. A receipt is positive, a withdrawal negative; the RPC
  -- decides the sign from the movement type so a caller cannot book a
  -- "withdrawal" that adds stock.
  quantity_delta       numeric(14,3) not null check (quantity_delta <> 0),

  -- What the item stood at AFTER this row. Written in the same
  -- transaction as the delta, so the history can be read without
  -- replaying it.
  balance_after        numeric(14,3) not null,

  -- WHAT KIND of movement. Kept separate from the reason on purpose:
  -- "receipt" and "goods_receipt" answer different questions, and
  -- collapsing them makes both unusable for counting.
  movement_type        text not null
                       check (movement_type in ('receipt', 'withdrawal', 'correction', 'stocktake')),

  -- WHY. Deliberately a wider, flatter list.
  reason               text not null
                       check (reason in (
                         'goods_receipt', 'initial_stock', 'b2c', 'b2b', 'event', 'sample',
                         'bottling', 'own_use', 'damaged', 'loss',
                         'stocktake_correction', 'correction', 'other'
                       )),

  -- WHICH CHANNEL it went to. Null for a receipt, which comes from
  -- outside rather than going anywhere.
  area                 text check (area is null or area in ('b2c', 'b2b', 'event', 'internal')),

  note                 text check (note is null or length(note) <= 500),
  -- A FREE TEXT REFERENCE, not a foreign key. Linking a movement to an
  -- order is a later, deliberate decision; inventing the column now
  -- would invite exactly the automatic coupling this package forbids.
  reference            text check (reference is null or length(reference) <= 120),

  supplier             text check (supplier is null or length(supplier) <= 120),
  batch_number         text check (batch_number is null or length(batch_number) <= 80),
  best_before_date     date,
  purchase_price_cents integer check (purchase_price_cents is null or purchase_price_cents >= 0),

  -- When it happened in the world, which is not always when it was
  -- typed in.
  occurred_at          timestamptz not null default now(),
  created_at           timestamptz not null default now(),
  -- The operator's own address, from the admin session. Answers "who",
  -- which is half of what a ledger is for.
  actor_email          text check (actor_email is null or length(actor_email) <= 200)
);

create unique index if not exists idx_inventory_movements_operation
  on public.inventory_movements (operation_id);
create index if not exists idx_inventory_movements_item
  on public.inventory_movements (inventory_item_id, occurred_at desc, created_at desc);
create index if not exists idx_inventory_movements_area
  on public.inventory_movements (area) where area is not null;

-- The unit trigger has to come after the movements table exists.
drop trigger if exists inventory_items_unit_lock on public.inventory_items;
create trigger inventory_items_unit_lock
  before update on public.inventory_items
  for each row execute function public.inventory_item_unit_is_locked();

-- ── 5. THE ONE WAY STOCK MOVES ────────────────────────────────

/**
 * Records one movement and moves the item's stock, atomically.
 *
 * WHY THIS IS A FUNCTION AND NOT THREE STATEMENTS. Read the quantity,
 * add in JavaScript, write it back, insert the movement: two tabs doing
 * that at the same moment both read the same starting figure and the
 * second one's write erases the first one's. The `for update` below is
 * what makes them queue instead.
 *
 * IDEMPOTENT BY CONSTRUCTION. p_operation_id is chosen by the caller
 * before it asks. If a movement already carries it, the existing one is
 * returned untouched - so a double click, a retry and a lost response
 * are one booking, not three.
 *
 * THE SIGN IS NOT THE CALLER'S. p_quantity is always positive and the
 * movement type decides the direction, so there is no way to book a
 * withdrawal that adds stock or a receipt that removes it. 'correction'
 * is the one type that may go either way, because that is what a
 * correction is.
 *
 * NEGATIVE STOCK IS ALLOWED, DELIBERATELY, BUT NEVER BY ACCIDENT. A
 * movement entered late can legitimately take an item below zero, and
 * refusing it would only push the operator into faking a number. So it
 * is permitted - but only when the caller says it meant to, which is
 * what p_allow_negative carries up from the confirmation the screen
 * shows. Without it the function refuses and writes nothing.
 */
create or replace function public.record_inventory_movement(
  p_operation_id         uuid,
  p_item_id              uuid,
  p_quantity             numeric,
  p_movement_type        text,
  p_reason               text,
  p_area                 text default null,
  p_note                 text default null,
  p_reference            text default null,
  p_supplier             text default null,
  p_batch_number         text default null,
  p_best_before_date     date default null,
  p_purchase_price_cents integer default null,
  p_occurred_at          timestamptz default null,
  p_actor_email          text default null,
  p_allow_negative       boolean default false
)
returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_item      public.inventory_items%rowtype;
  v_existing  public.inventory_movements%rowtype;
  v_delta     numeric(14,3);
  v_balance   numeric(14,3);
  v_movement  public.inventory_movements%rowtype;
begin
  if p_operation_id is null or p_item_id is null then
    raise exception 'inventory: an operation id and an item id are required';
  end if;

  -- The idempotent repeat, answered before anything is locked.
  select * into v_existing
    from public.inventory_movements
   where operation_id = p_operation_id;
  if found then
    return jsonb_build_object(
      'result', 'already_recorded',
      'movement_id', v_existing.id,
      'balance_after', v_existing.balance_after,
      'quantity_delta', v_existing.quantity_delta
    );
  end if;

  if p_quantity is null or p_quantity <= 0 then
    return jsonb_build_object('result', 'invalid_quantity');
  end if;
  if p_quantity > 100000000 then
    return jsonb_build_object('result', 'invalid_quantity');
  end if;
  if p_movement_type not in ('receipt', 'withdrawal', 'correction') then
    -- 'stocktake' is written by record_inventory_stocktake alone, so
    -- that a count can never be entered as if it were a delta.
    return jsonb_build_object('result', 'invalid_movement_type');
  end if;

  -- THE LOCK. Everything after this line sees a row nobody else can
  -- move until this transaction ends.
  select * into v_item
    from public.inventory_items
   where id = p_item_id
     for update;

  if not found then
    return jsonb_build_object('result', 'item_not_found');
  end if;

  v_delta := case
    when p_movement_type = 'receipt'    then  round(p_quantity, 3)
    when p_movement_type = 'withdrawal' then -round(p_quantity, 3)
    else round(p_quantity, 3)   -- 'correction': the caller's sign, taken as given
  end;

  v_balance := v_item.current_quantity + v_delta;

  if v_balance < 0 and coalesce(p_allow_negative, false) is not true then
    return jsonb_build_object(
      'result', 'would_go_negative',
      'current_quantity', v_item.current_quantity,
      'balance_after', v_balance
    );
  end if;

  update public.inventory_items
     set current_quantity = v_balance
   where id = p_item_id;

  insert into public.inventory_movements (
    inventory_item_id, operation_id, quantity_delta, balance_after,
    movement_type, reason, area, note, reference, supplier,
    batch_number, best_before_date, purchase_price_cents,
    occurred_at, actor_email
  ) values (
    p_item_id, p_operation_id, v_delta, v_balance,
    p_movement_type, p_reason, p_area, p_note, p_reference, p_supplier,
    p_batch_number, p_best_before_date, p_purchase_price_cents,
    coalesce(p_occurred_at, now()), p_actor_email
  )
  returning * into v_movement;

  return jsonb_build_object(
    'result', 'recorded',
    'movement_id', v_movement.id,
    'balance_after', v_balance,
    'quantity_delta', v_delta,
    'went_negative', v_balance < 0
  );
exception
  when unique_violation then
    -- Two identical requests that raced past the read above. The winner
    -- wrote it; report theirs rather than failing.
    select * into v_existing
      from public.inventory_movements
     where operation_id = p_operation_id;
    return jsonb_build_object(
      'result', 'already_recorded',
      'movement_id', v_existing.id,
      'balance_after', v_existing.balance_after,
      'quantity_delta', v_existing.quantity_delta
    );
end;
$$;

/**
 * Records a physical count.
 *
 * THE COUNT IS THE INPUT, THE DELTA IS DERIVED. An operator counts 481
 * and types 481; the difference against whatever the system happens to
 * say at that moment is computed under the lock, so a movement recorded
 * by somebody else a second earlier is included rather than overwritten.
 *
 * Still a movement, never an assignment: the ledger gets a row with the
 * difference and the balance, so "the system was 6 short on the 16th" is
 * still readable next year.
 */
create or replace function public.record_inventory_stocktake(
  p_operation_id  uuid,
  p_item_id       uuid,
  p_physical      numeric,
  p_note          text default null,
  p_reference     text default null,
  p_occurred_at   timestamptz default null,
  p_actor_email   text default null
)
returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_item     public.inventory_items%rowtype;
  v_existing public.inventory_movements%rowtype;
  v_delta    numeric(14,3);
  v_movement public.inventory_movements%rowtype;
begin
  if p_operation_id is null or p_item_id is null then
    raise exception 'inventory: an operation id and an item id are required';
  end if;

  select * into v_existing
    from public.inventory_movements
   where operation_id = p_operation_id;
  if found then
    return jsonb_build_object(
      'result', 'already_recorded',
      'movement_id', v_existing.id,
      'balance_after', v_existing.balance_after,
      'quantity_delta', v_existing.quantity_delta
    );
  end if;

  if p_physical is null or p_physical < 0 or p_physical > 100000000 then
    return jsonb_build_object('result', 'invalid_quantity');
  end if;

  select * into v_item
    from public.inventory_items
   where id = p_item_id
     for update;

  if not found then
    return jsonb_build_object('result', 'item_not_found');
  end if;

  v_delta := round(p_physical, 3) - v_item.current_quantity;

  if v_delta = 0 then
    -- Nothing moved. Writing a zero row would be noise, and the CHECK on
    -- quantity_delta refuses it anyway.
    return jsonb_build_object(
      'result', 'no_change',
      'balance_after', v_item.current_quantity,
      'quantity_delta', 0
    );
  end if;

  update public.inventory_items
     set current_quantity = round(p_physical, 3)
   where id = p_item_id;

  insert into public.inventory_movements (
    inventory_item_id, operation_id, quantity_delta, balance_after,
    movement_type, reason, note, reference, occurred_at, actor_email
  ) values (
    p_item_id, p_operation_id, v_delta, round(p_physical, 3),
    'stocktake', 'stocktake_correction', p_note, p_reference,
    coalesce(p_occurred_at, now()), p_actor_email
  )
  returning * into v_movement;

  return jsonb_build_object(
    'result', 'recorded',
    'movement_id', v_movement.id,
    'balance_after', round(p_physical, 3),
    'quantity_delta', v_delta,
    'went_negative', false
  );
exception
  when unique_violation then
    select * into v_existing
      from public.inventory_movements
     where operation_id = p_operation_id;
    return jsonb_build_object(
      'result', 'already_recorded',
      'movement_id', v_existing.id,
      'balance_after', v_existing.balance_after,
      'quantity_delta', v_existing.quantity_delta
    );
end;
$$;

-- ── 6. SECURITY ───────────────────────────────────────────────
--
-- RLS ON, AND NOT ONE POLICY. A table with RLS enabled and no policy is
-- readable and writable by nobody except a role that bypasses RLS, which
-- is service_role. So anon and authenticated - the browser's two roles -
-- can do nothing here whatever grants say, and a signed-in customer
-- gains nothing by being signed in.

alter table public.inventory_categories  enable row level security;
alter table public.inventory_items       enable row level security;
alter table public.inventory_item_areas  enable row level security;
alter table public.inventory_movements   enable row level security;

-- Nothing for the browser roles, ever.
revoke all on public.inventory_categories  from anon, authenticated;
revoke all on public.inventory_items       from anon, authenticated;
revoke all on public.inventory_item_areas  from anon, authenticated;
revoke all on public.inventory_movements   from anon, authenticated;

grant select, insert on public.inventory_categories to service_role;
grant update (name, is_active, updated_at) on public.inventory_categories to service_role;

grant select, insert on public.inventory_items to service_role;
-- EVERY EDITABLE COLUMN IS LISTED, AND current_quantity IS NOT ONE.
-- Stock can only move through the two functions above. This is the
-- structural half of "no silent stock field".
grant update (
  name, sku, category_id, unit, low_stock_threshold,
  supplier, purchase_price_cents, notes, is_active, updated_at
) on public.inventory_items to service_role;

grant select, insert, delete on public.inventory_item_areas to service_role;

-- SELECT ONLY. The ledger is append-only and it is written by the two
-- security-definer functions, which run as the owner - so even the
-- server cannot insert a movement without recording the balance it
-- produced, and nobody can edit or delete one at all.
grant select on public.inventory_movements to service_role;

revoke all on function public.record_inventory_movement(uuid, uuid, numeric, text, text, text, text, text, text, text, date, integer, timestamptz, text, boolean) from public;
revoke all on function public.record_inventory_movement(uuid, uuid, numeric, text, text, text, text, text, text, text, date, integer, timestamptz, text, boolean) from anon;
revoke all on function public.record_inventory_movement(uuid, uuid, numeric, text, text, text, text, text, text, text, date, integer, timestamptz, text, boolean) from authenticated;
grant execute on function public.record_inventory_movement(uuid, uuid, numeric, text, text, text, text, text, text, text, date, integer, timestamptz, text, boolean) to service_role;

revoke all on function public.record_inventory_stocktake(uuid, uuid, numeric, text, text, timestamptz, text) from public;
revoke all on function public.record_inventory_stocktake(uuid, uuid, numeric, text, text, timestamptz, text) from anon;
revoke all on function public.record_inventory_stocktake(uuid, uuid, numeric, text, text, timestamptz, text) from authenticated;
grant execute on function public.record_inventory_stocktake(uuid, uuid, numeric, text, text, timestamptz, text) to service_role;

revoke all on function public.inventory_item_unit_is_locked() from public;
revoke all on function public.inventory_item_unit_is_locked() from anon;
revoke all on function public.inventory_item_unit_is_locked() from authenticated;

-- ── 7. STARTER CATEGORIES ─────────────────────────────────────
--
-- CATEGORIES ONLY. No items, no quantities, no suppliers and no prices:
-- inventing stock GLOA does not have would be worse than an empty
-- screen, and the operator's first real count is the only honest first
-- number. These nine are a starting point and every one of them can be
-- renamed or archived.

insert into public.inventory_categories (name)
values
  ('Rohware'), ('Verkaufsware'), ('Produktverpackung'), ('Versandverpackung'),
  ('Print'), ('Zubehör'), ('Eventmaterial'), ('Verbrauchsmaterial'), ('Sonstiges')
on conflict do nothing;

commit;

-- ══════════════════════════════════════════════════════════════
-- VERIFICATION (read-only, run by hand after applying)
-- ══════════════════════════════════════════════════════════════
--
--   1. The four tables exist and RLS is on for all of them:
--
--      select relname, relrowsecurity
--        from pg_class
--       where relname in ('inventory_categories','inventory_items',
--                         'inventory_item_areas','inventory_movements')
--       order by relname;
--
--      Expected: 4 rows, relrowsecurity = true for each.
--
--   2. NOT ONE POLICY exists on them:
--
--      select tablename, policyname from pg_policies
--       where tablename like 'inventory%';
--
--      Expected: 0 rows.
--
--   3. service_role cannot write stock directly:
--
--      select has_column_privilege('service_role', 'public.inventory_items',
--                                  'current_quantity', 'update') as can_set_stock,
--             has_column_privilege('service_role', 'public.inventory_items',
--                                  'name', 'update')             as can_rename;
--
--      Expected: can_set_stock false, can_rename true.
--
--   4. The ledger cannot be edited or emptied:
--
--      select has_table_privilege('service_role','public.inventory_movements','insert') as ins,
--             has_table_privilege('service_role','public.inventory_movements','update') as upd,
--             has_table_privilege('service_role','public.inventory_movements','delete') as del;
--
--      Expected: false, false, false. (The functions write it as owner.)
--
--   5. The two functions exist, are security definer, and only
--      service_role may run them:
--
--      select p.proname, p.prosecdef,
--             has_function_privilege('service_role', p.oid, 'execute') as service_role,
--             has_function_privilege('anon',         p.oid, 'execute') as anon,
--             has_function_privilege('authenticated',p.oid, 'execute') as authenticated
--        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--       where n.nspname = 'public'
--         and p.proname in ('record_inventory_movement','record_inventory_stocktake');
--
--      Expected: prosecdef true, service_role true, anon false,
--                authenticated false.
--
--   6. The browser roles hold nothing:
--
--      select has_table_privilege('anon','public.inventory_items','select')          as anon_read,
--             has_table_privilege('authenticated','public.inventory_items','insert') as auth_write;
--
--      Expected: false, false.
--
--   7. Nine starter categories and NO items:
--
--      select (select count(*) from public.inventory_categories) as categories,
--             (select count(*) from public.inventory_items)      as items,
--             (select count(*) from public.inventory_movements)  as movements;
--
--      Expected: 9, 0, 0.
--
--   8. Nothing else was touched:
--
--      select count(*) from public.orders;
--
--      Expected: 458, unchanged.
