import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AREA_LABEL,
  CATEGORY_COLUMNS,
  DEFAULT_ITEM_PAGE_SIZE,
  INVENTORY_AREAS,
  ITEM_COLUMNS,
  MAX_ITEM_PAGE_SIZE,
  MAX_QUANTITY,
  MOVEMENT_COLUMNS,
  MOVEMENT_REASONS,
  MOVEMENT_REASON_LABEL,
  MOVEMENT_TYPES,
  MOVEMENT_TYPE_LABEL,
  REASONS_FOR_TYPE,
  REQUESTABLE_MOVEMENT_TYPES,
  STOCK_STATUSES,
  STOCK_STATUS_LABEL,
  cleanAreas,
  cleanOptionalText,
  cleanRequiredText,
  formatDelta,
  formatQuantity,
  hasControlCharacter,
  isUuid,
  itemsPageRange,
  normalizeInventorySearch,
  parseQuantity,
  resolveItemsQuery,
  stockStatus,
  validateCategoryRequest,
  validateCreateItemRequest,
  validateMovementRequest,
  validateStocktakeRequest,
  validateUpdateItemRequest,
} from "../lib/inventoryRules.ts";

/**
 * THE MANUAL INVENTORY.
 *
 * Two claims carry this package and both are easy to lose by accident:
 *
 *   IT IS MANUAL       no order, shipment, refund or cancellation may
 *                      move stock. Section 7 asserts that against the
 *                      source of every one of those paths, because the
 *                      moment one of them "helpfully" books a
 *                      withdrawal, the stock figure becomes something
 *                      nobody can reconcile by hand.
 *   STOCK IS NEVER SET the quantity is a cache of a ledger. There is no
 *                      input that writes it, no route that accepts it
 *                      and - the half that actually holds - no grant
 *                      that would let the server try.
 *
 * SAFE: this suite makes no request to production, touches no database
 * and starts no server. It reads source and runs the pure leaf.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf8");
/** Source with comments removed, so prose cannot satisfy an assertion. */
const codeOnly = src => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
/**
 * SQL with BOTH comment forms removed.
 *
 * Migration 050 documents its functions in /** *\/ blocks as well as in
 * -- lines, and a sentence explaining `for update` must not count as an
 * occurrence of it. Prose can neither satisfy an assertion here nor
 * break one.
 */
const sqlOnly = src => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*--.*$/gm, "");

/**
 * The migration with every function BODY removed.
 *
 * `insert into public.inventory_movements` inside record_inventory_movement
 * is the ledger being written by the thing that is supposed to write it -
 * not seed data. Only statements at the top level are the migration
 * putting rows in the database.
 */
const topLevelSql = src => src.replace(/\$\$[\s\S]*?\$\$/g, "$$BODY$$");

const migration = read("supabase/migrations/050_inventory_foundation.sql");
const sql = sqlOnly(migration);
const rules = read("lib/inventoryRules.ts");
const admin = read("lib/inventoryAdmin.ts");
const adminCode = codeOnly(admin);
const ui = read("app/AdminInventory.tsx");
const uiCode = codeOnly(ui);
const shell = read("app/AdminOverview.tsx");
const css = read("app/globals.css");

const ROUTES = {
  items: "app/api/admin/inventory/items/route.ts",
  detail: "app/api/admin/inventory/items/detail/route.ts",
  create: "app/api/admin/inventory/items/create/route.ts",
  update: "app/api/admin/inventory/items/update/route.ts",
  archive: "app/api/admin/inventory/items/archive/route.ts",
  movement: "app/api/admin/inventory/movement/route.ts",
  stocktake: "app/api/admin/inventory/stocktake/route.ts",
  categories: "app/api/admin/inventory/categories/route.ts",
  categoriesSave: "app/api/admin/inventory/categories/save/route.ts",
};
const routeSources = Object.fromEntries(Object.entries(ROUTES).map(([k, v]) => [k, read(v)]));

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";

/* ══════════════════════════════════════════════════════════════
   1. THE SCHEMA
   ══════════════════════════════════════════════════════════════ */

test("1: migration 050 creates four tables and nothing destructive", () => {
  for (const table of ["inventory_categories", "inventory_items", "inventory_item_areas", "inventory_movements"]) {
    assert.match(sql, new RegExp(`create table if not exists public\\.${table}`), `${table} is missing`);
    assert.match(sql, new RegExp(`alter table public\\.${table}\\s+enable row level security`),
      `${table} has no row level security`);
  }
  for (const forbidden of [/drop table/i, /drop column/i, /alter column/i, /truncate/i,
                           /drop function/i, /drop policy/i]) {
    assert.ok(!forbidden.test(sql), `050 contains a destructive statement: ${forbidden}`);
  }
  // It touches no existing table.
  const altered = [...sql.matchAll(/alter table public\.(\w+)/g)].map(m => m[1]);
  assert.deepEqual([...new Set(altered)].sort(),
    ["inventory_categories", "inventory_item_areas", "inventory_items", "inventory_movements"],
    "050 alters a table it did not create");
});

test("1b: not one policy, and nothing at all for a browser role", () => {
  // RLS on with NO policy means anon and authenticated can reach nothing
  // regardless of grants. That is the whole access model.
  assert.ok(!/create policy/i.test(sql), "050 creates a policy, which would open a browser path");
  for (const table of ["inventory_categories", "inventory_items", "inventory_item_areas", "inventory_movements"]) {
    assert.match(sql, new RegExp(`revoke all on public\\.${table}\\s+from anon, authenticated`),
      `${table} does not revoke the browser roles`);
  }
  assert.ok(!/grant[^;]*\bto (anon|authenticated)\b/i.test(sql.replace(/revoke[^;]*;/gi, "")),
    "050 grants something to a browser role");
});

test("1c: THE STOCK COLUMN IS NOT WRITABLE, and the ledger is append-only", () => {
  // The structural half of "no silent stock field": every column
  // service_role may update is listed, and current_quantity is not one.
  // [^)] and not [\s\S]*? : the categories grant appears first, and a
  // lazy match happily ran from THAT opening paren to the items suffix,
  // which quietly made the column list three entries too long.
  const itemGrant = sql.match(/grant update \(([^)]*)\) on public\.inventory_items to service_role/);
  assert.ok(itemGrant, "the item update grant is missing");
  const columns = itemGrant[1].split(",").map(c => c.trim());
  assert.ok(!columns.includes("current_quantity"),
    "service_role can set stock directly, which makes the ledger optional");
  for (const editable of ["name", "sku", "category_id", "unit", "low_stock_threshold",
                          "supplier", "notes", "is_active"]) {
    assert.ok(columns.includes(editable), `${editable} cannot be edited`);
  }
  // The grant is the WHOLE list, so a price could not be edited into
  // existence either - see section 10.
  assert.equal(columns.length, 9, `the item update grant changed: ${columns.join(",")}`);

  // The ledger: SELECT and nothing else. The functions write it as owner.
  assert.match(sql, /grant select on public\.inventory_movements to service_role/);
  assert.ok(!/grant[^;]*(insert|update|delete)[^;]*on public\.inventory_movements to service_role/i.test(sql),
    "the movement ledger can be written, edited or emptied directly");
});

test("1d: the two booking functions are locked down and lock the row", () => {
  for (const fn of ["record_inventory_movement", "record_inventory_stocktake"]) {
    assert.match(sql, new RegExp(`create or replace function public\\.${fn}`), `${fn} is missing`);
    for (const role of ["public", "anon", "authenticated"]) {
      assert.ok(sql.includes(`revoke all on function public.${fn}`) &&
                new RegExp(`revoke all on function public\\.${fn}\\([^)]*\\) from ${role}`).test(sql),
        `${fn} is not revoked from ${role}`);
    }
    assert.match(sql, new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\) to service_role`));
  }
  // security definer with an empty search_path, the house pattern.
  assert.equal((sql.match(/security definer set search_path = ''/g) ?? []).length, 3,
    "a function is not security definer with a pinned search_path");
  // THE LOCK. Without `for update` two tabs both read the same starting
  // figure and the second write erases the first.
  assert.equal((sql.match(/for update/g) ?? []).length, 2,
    "a booking function does not lock the item row");
});

test("1e: idempotency is a database constraint, not a disabled button", () => {
  assert.match(sql, /operation_id\s+uuid not null/);
  assert.match(sql, /create unique index if not exists idx_inventory_movements_operation\s*\n?\s*on public\.inventory_movements \(operation_id\)/);
  // Both functions answer a repeat with the movement that already
  // exists, before and after the race.
  assert.equal((sql.match(/'result', 'already_recorded'/g) ?? []).length, 4,
    "a repeat is not answered with the existing movement on every path");
  assert.equal((sql.match(/when unique_violation then/g) ?? []).length, 2,
    "a race past the pre-check is not handled");
});

test("1f: the direction of a movement is the type's, not the caller's", () => {
  // A caller cannot book a "withdrawal" that adds stock: the sign is
  // decided inside the function.
  assert.match(sql, /when p_movement_type = 'receipt'\s+then\s+round\(p_quantity, 3\)/);
  assert.match(sql, /when p_movement_type = 'withdrawal' then -round\(p_quantity, 3\)/);
  // And a stocktake cannot be entered as if it were a delta.
  assert.match(sql, /if p_movement_type not in \('receipt', 'withdrawal', 'correction'\) then/);
});

test("1g: negative stock is allowed, but never by accident", () => {
  assert.match(sql, /if v_balance < 0 and coalesce\(p_allow_negative, false\) is not true then/);
  assert.match(sql, /'result', 'would_go_negative'/);
  // The refusal happens BEFORE the write.
  const guardAt = sql.indexOf("would_go_negative");
  const writeAt = sql.indexOf("update public.inventory_items\n     set current_quantity = v_balance");
  assert.ok(guardAt > -1 && writeAt > -1 && guardAt < writeAt,
    "stock is written before the negative check runs");
});

test("1h: a stocktake derives its delta under the lock", () => {
  const fn = sql.slice(sql.indexOf("function public.record_inventory_stocktake"));
  assert.match(fn, /v_delta := round\(p_physical, 3\) - v_item\.current_quantity/,
    "the count is stored as a delta instead of being compared to the system");
  const lockAt = fn.indexOf("for update");
  const deltaAt = fn.indexOf("v_delta :=");
  assert.ok(lockAt > -1 && lockAt < deltaAt, "the difference is computed before the row is locked");
  // A count that matches writes no row rather than a zero one.
  assert.match(fn, /'result', 'no_change'/);
});

test("1i: the unit cannot change once movements exist", () => {
  assert.match(sql, /create or replace function public\.inventory_item_unit_is_locked/);
  assert.match(sql, /if new\.unit is distinct from old\.unit[\s\S]*?exists \(select 1 from public\.inventory_movements/);
  assert.match(sql, /create trigger inventory_items_unit_lock/);
  // The screen says the same thing, and disables the field.
  assert.ok(ui.includes('disabled={busy || Boolean(item)}'), "the unit stays editable on an existing item");
  assert.match(ui, /Einheit lässt sich nach der ersten Bewegung nicht mehr ändern/);
});

test("1j: starter CATEGORIES only - no items, no quantities, no suppliers", () => {
  // TOP LEVEL ONLY. The two inserts inside the booking functions are the
  // ledger being written by the thing that exists to write it.
  const inserts = [...topLevelSql(sql).matchAll(/insert into public\.(\w+)/g)].map(m => m[1]);
  assert.deepEqual(inserts, ["inventory_categories"],
    "050 seeds something other than categories");
  for (const invented of ["Matcha", "Beutel", "Karton", "purchase_price", "current_quantity"]) {
    const seed = sql.slice(sql.indexOf("insert into public.inventory_categories"));
    assert.ok(!seed.includes(invented), `050 invents inventory data: ${invented}`);
  }
  assert.match(sql, /\('Rohware'\), \('Verkaufsware'\)/);
});

/* ══════════════════════════════════════════════════════════════
   2. THE VOCABULARIES ARE THE DATABASE'S
   ══════════════════════════════════════════════════════════════ */

test("2: every type, reason and area the code knows is one the CHECK allows", () => {
  const checkValues = (column) => {
    const at = sql.indexOf(`check (${column} in (`);
    assert.notEqual(at, -1, `no CHECK for ${column}`);
    const block = sql.slice(at, sql.indexOf("))", at));
    // [a-z0-9_] and not [a-z_]: 'b2c' and 'b2b' carry a digit, and a
    // pattern that drops them would have quietly compared two shorter
    // lists and called them equal.
    return [...block.matchAll(/'([a-z0-9_]+)'/g)].map(m => m[1]);
  };
  assert.deepEqual([...MOVEMENT_TYPES].sort(), checkValues("movement_type").sort());
  assert.deepEqual([...MOVEMENT_REASONS].sort(), checkValues("reason").sort());
  // The area CHECK appears twice - on the item relation and on the
  // movement - and both must agree with the code.
  const areaChecks = [...sql.matchAll(/check \(area (?:is null or area )?in \(([^)]*)\)/g)]
    .map(m => [...m[1].matchAll(/'([a-z0-9_]+)'/g)].map(x => x[1]));
  assert.equal(areaChecks.length, 2, "the area vocabulary is not defined in both places");
  for (const values of areaChecks) {
    assert.deepEqual([...INVENTORY_AREAS].sort(), values.sort());
  }
});

test("2b: every value has a German label and no label invents a value", () => {
  for (const t of MOVEMENT_TYPES) assert.ok(MOVEMENT_TYPE_LABEL[t], `no label for ${t}`);
  for (const r of MOVEMENT_REASONS) assert.ok(MOVEMENT_REASON_LABEL[r], `no label for ${r}`);
  for (const a of INVENTORY_AREAS) assert.ok(AREA_LABEL[a], `no label for ${a}`);
  for (const s of STOCK_STATUSES) assert.ok(STOCK_STATUS_LABEL[s], `no label for ${s}`);
  assert.equal(Object.keys(MOVEMENT_TYPE_LABEL).length, MOVEMENT_TYPES.length);
  assert.equal(Object.keys(MOVEMENT_REASON_LABEL).length, MOVEMENT_REASONS.length);
  assert.equal(Object.keys(AREA_LABEL).length, INVENTORY_AREAS.length);
  // A stocktake is not requestable: the count is the input, not a delta.
  assert.deepEqual([...REQUESTABLE_MOVEMENT_TYPES], ["receipt", "withdrawal", "correction"]);
  assert.ok(!REQUESTABLE_MOVEMENT_TYPES.includes("stocktake"));
  for (const [type, reasons] of Object.entries(REASONS_FOR_TYPE)) {
    for (const r of reasons) assert.ok(MOVEMENT_REASONS.includes(r), `${type} offers an unknown reason ${r}`);
  }
});

/* ══════════════════════════════════════════════════════════════
   3. QUANTITIES AND STATUS
   ══════════════════════════════════════════════════════════════ */

test("3: a quantity is parsed exactly, with three decimals and no float trick", () => {
  assert.equal(parseQuantity("10000"), 10000);
  assert.equal(parseQuantity("125,5"), 125.5);
  assert.equal(parseQuantity("125.500"), 125.5);
  assert.equal(parseQuantity("1.250,75"), 1250.75);
  assert.equal(parseQuantity(" 12 "), 12);
  assert.equal(parseQuantity("-6"), -6, "a correction may be negative");
  assert.equal(parseQuantity(12.5), 12.5);
  for (const bad of ["", "   ", "abc", "1,2345", "1.2.3", "1e3", "12,", "∞", {}, [], null, undefined, NaN, Infinity]) {
    assert.equal(parseQuantity(bad), null, `${JSON.stringify(bad)} parsed as a quantity`);
  }
  // Nothing in the path multiplies a decimal to fake precision.
  for (const [name, src] of [["rules", codeOnly(rules)], ["ui", uiCode], ["admin", adminCode]]) {
    assert.ok(!src.includes("parseFloat"), `${name} parses a quantity as a float`);
    assert.ok(!/\d+\.\d+\s*\*\s*1000/.test(src), `${name} scales a decimal by 1000`);
  }
});

test("3b: a quantity is displayed without zeros nobody asked for", () => {
  assert.equal(formatQuantity(12), "12");
  assert.equal(formatQuantity(125.5), "125,5");
  assert.equal(formatQuantity(10000), "10.000");
  assert.equal(formatQuantity("9700"), "9.700");
  assert.equal(formatQuantity(null), "—");
  assert.equal(formatQuantity("nonsense"), "—");
  assert.equal(formatDelta(10000), "+10.000");
  assert.equal(formatDelta(-300), "−300");
  assert.equal(formatDelta(0), "0");
  assert.equal(formatDelta(null), "—");
});

test("3c: the stock status answers the questions in the order they matter", () => {
  assert.equal(stockStatus({ current_quantity: 500, low_stock_threshold: 100 }), "ok");
  assert.equal(stockStatus({ current_quantity: 75, low_stock_threshold: 100 }), "low");
  assert.equal(stockStatus({ current_quantity: 100, low_stock_threshold: 100 }), "low",
    "reaching the threshold is already low");
  assert.equal(stockStatus({ current_quantity: 0, low_stock_threshold: 100 }), "out");
  assert.equal(stockStatus({ current_quantity: -6, low_stock_threshold: 100 }), "negative",
    "a negative stock is hidden behind 'low'");
  // NEGATIVE BEATS EVERYTHING. It is a bookkeeping error waiting to be
  // explained, not a shade of running out.
  assert.equal(stockStatus({ current_quantity: -6 }), "negative");
  // No threshold means "low" was never defined, so it is never claimed.
  assert.equal(stockStatus({ current_quantity: 1 }), "ok");
  assert.equal(stockStatus({ current_quantity: "0" }), "out", "a string quantity is misread");
  assert.equal(stockStatus({}), "ok");
});

/* ══════════════════════════════════════════════════════════════
   4. VALIDATION
   ══════════════════════════════════════════════════════════════ */

const goodMovement = {
  operationId: UUID_A, itemId: UUID_B, quantity: "300",
  movementType: "withdrawal", reason: "event", area: "event",
  note: "Opening", reference: "EVENT-2026-09-20",
};

test("4: a well-formed booking survives, normalised", () => {
  const out = validateMovementRequest(goodMovement);
  assert.equal(out.ok, true);
  assert.equal(out.request.quantity, 300);
  assert.equal(out.request.area, "event");
  assert.equal(out.request.allowNegative, false, "allowNegative defaults to on");
});

test("4b: a hostile or malformed booking is refused with a code, not a guess", () => {
  for (const [patch, code, why] of [
    [{ operationId: "not-a-uuid" }, "invalid_operation_id", "a malformed operation id"],
    [{ itemId: 42 }, "invalid_item_id", "a numeric item id"],
    [{ movementType: "stocktake" }, "invalid_movement_type", "a stocktake smuggled in as a delta"],
    [{ movementType: "delete" }, "invalid_movement_type", "an invented type"],
    [{ reason: "because" }, "invalid_reason", "an invented reason"],
    [{ quantity: "0" }, "invalid_quantity", "zero"],
    [{ quantity: "-5" }, "invalid_quantity", "a negative withdrawal"],
    [{ quantity: "abc" }, "invalid_quantity", "a non-number"],
    [{ quantity: String(MAX_QUANTITY + 1) }, "invalid_quantity", "an absurd quantity"],
    [{ area: "warehouse" }, "invalid_area", "an invented area"],
    [{ note: "x".repeat(600) }, "invalid_note", "an over-long note"],
    [{ note: "a b" }, "invalid_note", "a NUL in the note"],
    [{ reference: "a\nb" }, "invalid_reference", "a newline in the reference"],
    [{ batchNumber: "x".repeat(200) }, "invalid_batch_number", "an over-long batch"],
    [{ bestBeforeDate: "31.12.2026" }, "invalid_best_before_date", "a German date"],
  ]) {
    const out = validateMovementRequest({ ...goodMovement, ...patch });
    assert.equal(out.ok, false, `${why} was accepted`);
    assert.equal(out.code, code, `${why} produced the wrong code`);
  }
  for (const body of [null, "string", [], 42]) {
    assert.equal(validateMovementRequest(body).ok, false);
  }
});

test("4c: a correction may go either way, and only a correction", () => {
  const correction = { ...goodMovement, movementType: "correction", reason: "correction" };
  assert.equal(validateMovementRequest({ ...correction, quantity: "90" }).request.quantity, 90);
  assert.equal(validateMovementRequest({ ...correction, quantity: "-90" }).request.quantity, -90);
  assert.equal(validateMovementRequest({ ...correction, quantity: "0" }).ok, false);
  // A receipt and a withdrawal stay positive - the sign is the type's.
  assert.equal(validateMovementRequest({ ...goodMovement, quantity: "-1" }).ok, false);
  assert.equal(validateMovementRequest({ ...goodMovement, movementType: "receipt", reason: "goods_receipt", quantity: "-1" }).ok, false);
});

test("4d: a stocktake takes a COUNT, and a count is never negative", () => {
  const good = { operationId: UUID_A, itemId: UUID_B, physicalQuantity: "481" };
  assert.equal(validateStocktakeRequest(good).request.physicalQuantity, 481);
  assert.equal(validateStocktakeRequest({ ...good, physicalQuantity: "0" }).ok, true,
    "counting zero is a legitimate count");
  for (const bad of ["-1", "abc", String(MAX_QUANTITY + 1), ""]) {
    assert.equal(validateStocktakeRequest({ ...good, physicalQuantity: bad }).ok, false, `${bad} accepted`);
  }
});

test("4e: THE EDIT FORM CANNOT TOUCH STOCK", () => {
  const fields = {
    itemId: UUID_A, name: "Matcha Rohware", unit: "g", categoryId: UUID_B, areas: ["b2c", "event"],
  };
  assert.equal(validateUpdateItemRequest(fields).ok, true);
  // The two spellings a client might reach for are both refused by name,
  // and the database would refuse them again.
  for (const key of ["currentQuantity", "current_quantity"]) {
    const out = validateUpdateItemRequest({ ...fields, [key]: 500 });
    assert.equal(out.ok, false, `${key} was accepted on an edit`);
    assert.equal(out.code, "stock_is_not_editable");
  }
  // And the update writer never sends it either.
  const updateFn = adminCode.slice(adminCode.indexOf("export async function updateInventoryItem"));
  assert.ok(!updateFn.slice(0, 900).includes("current_quantity"),
    "the item update writes the stock column");
});

test("4f: item fields are trimmed, bounded and control-character free", () => {
  const base = { operationId: UUID_A, name: "Beutel", unit: "Stück", categoryId: UUID_B };
  assert.equal(validateCreateItemRequest(base).ok, true);
  for (const [patch, code, why] of [
    [{ name: "   " }, "invalid_name", "a blank name"],
    [{ name: "x".repeat(200) }, "invalid_name", "an over-long name"],
    [{ name: "a b" }, "invalid_name", "a NUL in the name"],
    [{ unit: "" }, "invalid_unit", "no unit"],
    [{ categoryId: "none" }, "invalid_category", "a malformed category"],
    [{ sku: "x".repeat(100) }, "invalid_sku", "an over-long SKU"],
    [{ lowStockThreshold: "-5" }, "invalid_threshold", "a negative threshold"],
    [{ initialQuantity: "-1" }, "invalid_quantity", "a negative opening stock"],
  ]) {
    const out = validateCreateItemRequest({ ...base, ...patch });
    assert.equal(out.ok, false, `${why} was accepted`);
    assert.equal(out.code, code);
  }
  assert.equal(validateCreateItemRequest({ ...base, name: "  Matcha  " }).request.name, "Matcha");
  assert.equal(validateCreateItemRequest({ ...base, sku: "" }).request.sku, null);
  assert.equal(cleanRequiredText("  x  ", 5), "x");
  assert.equal(cleanOptionalText("", 5), null);
  assert.equal(cleanOptionalText("toolong", 3), undefined);
  assert.equal(hasControlCharacter("Matcha"), false);
  assert.equal(hasControlCharacter("Matcha"), true);
});

test("4g: areas are allowlisted, de-duplicated and may be several", () => {
  assert.deepEqual(cleanAreas(["b2c", "event", "b2c", "WAREHOUSE", 42, null]), ["b2c", "event"]);
  assert.deepEqual(cleanAreas("b2c"), [], "a bare string is not a list of areas");
  assert.deepEqual(cleanAreas([]), []);
  // ONE ITEM, SEVERAL AREAS - raw matcha genuinely serves all three, and
  // duplicating it per channel would split its history in three.
  const out = validateCreateItemRequest({
    operationId: UUID_A, name: "Matcha Rohware", unit: "g", categoryId: UUID_B,
    areas: ["b2c", "b2b", "event"],
  });
  assert.deepEqual(out.request.areas, ["b2c", "b2b", "event"]);
  // The relation allows it: the primary key is the PAIR.
  assert.match(sql, /primary key \(inventory_item_id, area\)/);
});

test("4h: a category is created, renamed or archived - never nothing", () => {
  assert.equal(validateCategoryRequest({ name: "Café Samples" }).request.name, "Café Samples");
  assert.equal(validateCategoryRequest({ categoryId: UUID_A, name: "Neu" }).ok, true);
  assert.equal(validateCategoryRequest({ categoryId: UUID_A, isActive: false }).ok, true);
  assert.equal(validateCategoryRequest({}).ok, false, "a nameless new category was accepted");
  assert.equal(validateCategoryRequest({ categoryId: UUID_A }).code, "nothing_to_change");
  assert.equal(validateCategoryRequest({ categoryId: "nope", name: "x" }).code, "invalid_category");
  assert.equal(validateCategoryRequest({ name: "  " }).code, "invalid_name");
  // Case and padding do not make a second category.
  assert.match(sql, /create unique index if not exists idx_inventory_categories_name\s*\n?\s*on public\.inventory_categories \(lower\(btrim\(name\)\)\)/);
});

test("4i: the list query allowlists everything and bounds the page", () => {
  const q = resolveItemsQuery({
    area: "'; drop table inventory_items; --",
    status: "whatever",
    categoryId: "not-a-uuid",
    archived: "everything",
    search: "%,name.ilike.%",
    page: -3,
    pageSize: 99999,
  });
  assert.deepEqual(q, {
    area: "all", status: "all", categoryId: "all", archived: "active",
    search: "name.ilike.", page: 1, pageSize: MAX_ITEM_PAGE_SIZE,
  });
  const good = resolveItemsQuery({ area: "event", status: "low", archived: "archived", page: 2 });
  assert.equal(good.area, "event");
  assert.equal(good.status, "low");
  assert.equal(good.archived, "archived");
  assert.equal(good.pageSize, DEFAULT_ITEM_PAGE_SIZE);
  assert.deepEqual(itemsPageRange({ page: 2, pageSize: 50 }), { from: 50, to: 99 });

  // The search cannot carry PostgREST grammar.
  for (const hostile of ["%", "_", "*", "a,b", "')--", 'x" or "1"="1', "(area.eq.b2c)"]) {
    const out = normalizeInventorySearch(hostile);
    for (const ch of [",", "(", ")", "%", "_", "*", "\\", '"', "'"]) {
      assert.ok(!out.includes(ch), `${JSON.stringify(hostile)} kept ${ch}`);
    }
  }
  assert.equal(normalizeInventorySearch("Matcha Rohware"), "Matcha Rohware");
  assert.equal(normalizeInventorySearch("x".repeat(500)).length, 120);

  // A category id that is not a uuid becomes "all" rather than reaching
  // the database as a filter, which is what isUuid is for.
  assert.equal(isUuid(UUID_A), true);
  for (const bad of ["", "abc", "1111-1111", 42, null, undefined, {}]) {
    assert.equal(isUuid(bad), false, `${JSON.stringify(bad)} passed as a uuid`);
  }
  assert.equal(resolveItemsQuery({ categoryId: UUID_A }).categoryId, UUID_A);
});

/* ══════════════════════════════════════════════════════════════
   5. THE WRITE PATH
   ══════════════════════════════════════════════════════════════ */

test("5: stock moves through the two functions and through nothing else", () => {
  const rpcs = [...new Set([...adminCode.matchAll(/\.rpc\("(\w+)"/g)].map(m => m[1]))].sort();
  assert.deepEqual(rpcs, ["record_inventory_movement", "record_inventory_stocktake"]);
  // No update of the items table ever names the quantity.
  for (const m of adminCode.matchAll(/\.from\("inventory_items"\)[\s\S]{0,200}?\.update\(\{([\s\S]*?)\}\)/g)) {
    assert.ok(!m[1].includes("current_quantity"),
      "the admin module writes the stock column directly");
  }
  // And the movement ledger is never written outside the functions.
  assert.ok(!/\.from\("inventory_movements"\)[\s\S]{0,120}?\.(insert|update|delete)\(/.test(adminCode),
    "the ledger is written outside the booking functions");
});

test("5b: the opening stock is a movement, not a column write", () => {
  const create = adminCode.slice(adminCode.indexOf("export async function createInventoryItem"));
  assert.ok(!create.slice(0, 1200).includes("current_quantity:"),
    "the opening stock is written into the item row");
  assert.match(create, /recordMovement\(/, "the opening stock is not booked as a movement");
  assert.match(create, /reason: "initial_stock"/);
  assert.match(create, /movementType: "receipt"/);
  // It reuses the request's own operation id, so a double click cannot
  // open the account twice.
  assert.match(create, /operationId: request\.operationId/);
  assert.ok(MOVEMENT_REASONS.includes("initial_stock"));
});

test("5c: every booking carries an operation id chosen before the request", () => {
  assert.match(ui, /const newOperationId = \(\)/);
  assert.match(uiCode, /useState\(newOperationId\)/, "the id is regenerated on every render");
  // A NEW id only after a REFUSAL, where the booking provably did not
  // happen. Re-rolling it after a timeout would turn one intent into two.
  const refusal = uiCode.slice(uiCode.indexOf("if (status !== 200)"), uiCode.indexOf("const after"));
  assert.ok(refusal.includes("setOperationId(newOperationId())"),
    "a refused booking reuses an id the server may already have seen");
  const success = uiCode.slice(uiCode.indexOf("const after"));
  assert.ok(!success.slice(0, 400).includes("setOperationId"),
    "the id is rolled after a success, which would allow a duplicate");
});

test("5d: archiving never deletes, and neither does anything else", () => {
  for (const [name, src] of Object.entries(routeSources)) {
    assert.ok(!codeOnly(src).includes(".delete("), `${name} deletes rows`);
  }
  // The one delete in the admin module is the area relation, which is
  // rewritten wholesale on save - it carries no history.
  const deletes = [...adminCode.matchAll(/\.from\("(\w+)"\)\s*\.delete\(\)/g)].map(m => m[1]);
  assert.deepEqual(deletes, ["inventory_item_areas"],
    "something other than the area relation is deleted");
  assert.match(adminCode, /setItemActive/);
  assert.ok(!adminCode.includes('.from("inventory_items").delete()'), "items can be hard deleted");
});

test("5e: a category still in use cannot be archived silently", () => {
  const save = adminCode.slice(adminCode.indexOf("export async function saveInventoryCategory"));
  assert.match(save, /if \(request\.isActive === false\)/);
  assert.match(save, /\.eq\("category_id", request\.categoryId\)/);
  assert.match(save, /\.eq\("is_active", true\)/);
  assert.match(save, /status: 409/);
  // The refusal says how many, so it is actionable.
  assert.match(save, /\$\{count\} aktiven Artikel/);
});

/* ══════════════════════════════════════════════════════════════
   6. SECURITY
   ══════════════════════════════════════════════════════════════ */

test("6: every route checks the admin session before anything else", () => {
  for (const [name, src] of Object.entries(routeSources)) {
    const code = codeOnly(src);
    const gateAt = code.indexOf("const gate = await openAdminAction(request)");
    assert.notEqual(gateAt, -1, `${name} does not open through the shared gate`);
    const before = code.slice(code.indexOf("export async function POST"), gateAt);
    assert.ok(!/await|\.from\(|\.rpc\(|console\./.test(before), `${name} does work before the session check`);
  }
});

test("6b: POST only - no other verb is a surface", () => {
  for (const [name, src] of Object.entries(routeSources)) {
    const handlers = [...src.matchAll(/export async function (\w+)/g)].map(m => m[1]);
    assert.deepEqual(handlers, ["POST"], `${name} exports something other than POST`);
  }
});

test("6c: no secret and no direct database access reaches the browser", () => {
  for (const [name, src] of [["ui", uiCode], ["shell", codeOnly(shell)],
                             ...Object.entries(routeSources).map(([n, s]) => [n, codeOnly(s)])]) {
    for (const banned of [
      "SUPABASE_SECRET_KEY", "service_role", "getSupabaseAdmin", "STRIPE_SECRET_KEY",
      "record_inventory_movement", "record_inventory_stocktake",
      "FULFILLMENT_ADMIN_SECRET", "CANCELLATION_ADMIN_SECRET",
    ]) {
      assert.ok(!src.includes(banned), `${name} names ${banned}`);
    }
  }
  // The screen talks to admin endpoints and nothing else.
  const endpoints = [...new Set([...ui.matchAll(/"(\/api\/[^"]+)"/g)].map(m => m[1]))].sort();
  assert.deepEqual(endpoints, [
    "/api/admin/inventory/categories/save",
    "/api/admin/inventory/items",
    "/api/admin/inventory/items/archive",
    "/api/admin/inventory/items/create",
    "/api/admin/inventory/items/detail",
    "/api/admin/inventory/items/update",
    "/api/admin/inventory/movement",
    "/api/admin/inventory/stocktake",
  ]);
});

test("6d: the rules leaf stays a leaf", () => {
  assert.equal((rules.match(/^import /gm) ?? []).length, 0,
    "lib/inventoryRules.ts gained an import and can no longer be tested directly");
  // It validates a date STRING - new Date("2026-13-45") is how you find
  // out that is not a date - which is parsing, not reading a clock. What
  // it must not do is ask what time it is now, or reach the network.
  for (const banned of ["supabase", "stripe", "process.env", "fetch(", "Date.now()", "new Date()"]) {
    assert.ok(!codeOnly(rules).includes(banned), `the rules leaf reaches for ${banned}`);
  }
  assert.ok(!/new Date\(\s*\)/.test(codeOnly(rules)), "the rules leaf reads the clock");
});

test("6e: the columns the code reads all exist in the migration", () => {
  for (const column of [...ITEM_COLUMNS.split(","), ...MOVEMENT_COLUMNS.split(","),
                        ...CATEGORY_COLUMNS.split(",")]) {
    const name = column.trim();
    if (name === "id") continue;
    assert.ok(sql.includes(name), `the code reads ${name}, which migration 050 does not create`);
  }
});

/* ══════════════════════════════════════════════════════════════
   7. NO AUTOMATIC COUPLING

   The claim this whole package rests on. If one of these ever
   starts booking a movement "helpfully", the stock figure stops
   being something a human can reconcile - and nobody finds out
   until the first count disagrees.
   ══════════════════════════════════════════════════════════════ */

test("7: NOT ONE ORDER PATH TOUCHES INVENTORY", () => {
  const ORDER_PATHS = [
    "app/api/stripe/webhook/route.ts",
    "app/api/internal/orders/ship/route.ts",
    "app/api/internal/orders/cancel/route.ts",
    "app/api/internal/orders/cancellation-request/resolve/route.ts",
    "app/api/admin/orders/route.ts",
    "app/api/admin/orders/detail/route.ts",
    "app/api/admin/orders/ship/route.ts",
    "app/api/admin/orders/cancel/route.ts",
    "app/api/admin/orders/refund/route.ts",
    "app/api/admin/orders/resolve-request/route.ts",
    "lib/adminOrderActions.ts",
    "lib/adminRefundFlow.ts",
    "lib/orderRefunds.ts",
    "lib/orderFulfillment.ts",
    "lib/stripeFulfillment.ts",
  ];
  for (const rel of ORDER_PATHS) {
    const source = codeOnly(read(rel));
    for (const banned of [
      "inventory_items", "inventory_movements", "inventory_categories", "inventory_item_areas",
      "record_inventory_movement", "record_inventory_stocktake",
      "inventoryAdmin", "inventoryRules", "/api/admin/inventory",
    ]) {
      assert.ok(!source.includes(banned), `${rel} reaches inventory: ${banned}`);
    }
  }
});

test("7b: and no migration wires an order trigger into stock", () => {
  // A trigger on orders or order_items that wrote a movement would be
  // automatic coupling hidden in the schema rather than the code.
  for (const file of readdirSync(path.join(ROOT, "supabase/migrations")).sort()) {
    if (!file.endsWith(".sql")) continue;
    const source = sqlOnly(read(`supabase/migrations/${file}`));
    if (!/inventory_/.test(source)) continue;
    assert.equal(file, "050_inventory_foundation.sql",
      `${file} touches inventory and is not the inventory migration`);
  }
  // 050 itself creates no trigger on an order table.
  assert.ok(!/create trigger[^;]*on public\.(orders|order_items)/i.test(sql),
    "050 hangs a trigger on the order tables");
  assert.ok(!/\border_items\b|\borders\b/.test(sql.replace(/inventory_\w+/g, "")),
    "050 mentions the order tables at all");
});

test("7c: the inventory module knows nothing about orders either", () => {
  for (const banned of ["orders", "order_items", "checkout", "stripe", "shipment", "refund", "cancellation"]) {
    assert.ok(!adminCode.toLowerCase().includes(banned), `the inventory module reaches ${banned}`);
  }
  const tables = [...new Set([...adminCode.matchAll(/\.from\("(\w+)"\)/g)].map(m => m[1]))].sort();
  assert.deepEqual(tables, ["inventory_categories", "inventory_item_areas", "inventory_items", "inventory_movements"]);
});

/* ══════════════════════════════════════════════════════════════
   8. THE SCREEN
   ══════════════════════════════════════════════════════════════ */

test("8: there is no stock input anywhere in the item form", () => {
  const form = uiCode.slice(uiCode.indexOf("function ItemForm"), uiCode.indexOf("function ItemDialog"));
  for (const banned of ["currentQuantity", "current_quantity", "setStock", "setCurrent"]) {
    assert.ok(!form.includes(banned), `the item form can set stock: ${banned}`);
  }
  // The only quantity it accepts is an OPENING one, and that becomes a
  // movement on the server.
  assert.ok(form.includes("initialQuantity"), "an opening stock cannot be entered at all");
  assert.match(ui, /Anfangsbestand wird als Bewegung/);
});

test("8b: a booking needs a second, separate confirmation", () => {
  const movementForm = uiCode.slice(uiCode.indexOf("function MovementForm"), uiCode.indexOf("function ItemForm"));
  assert.ok(movementForm.includes("setConfirming(true)"), "the first click books immediately");
  assert.ok(movementForm.includes('onClick={() => void submit()}'), "the confirmation does not book");
  assert.equal([...movementForm.matchAll(/void submit\(\)/g)].length, 1,
    "a booking can be started from more than one control");
  // Before/after is shown before anything is sent.
  assert.match(movementForm, /Bestand vorher/);
  assert.match(movementForm, /Bestand danach/);
  assert.match(movementForm, /kann nicht gelöscht werden/);
  assert.ok(movementForm.includes("if (busy || !valid) return;"), "a double click is not refused");
});

test("8c: negative stock warns, and cannot be booked without ticking it", () => {
  const movementForm = uiCode.slice(uiCode.indexOf("function MovementForm"), uiCode.indexOf("function ItemForm"));
  assert.match(movementForm, /goesNegative/);
  assert.ok(movementForm.includes("disabled={busy || !valid || (goesNegative && !allowNegative)}"),
    "a booking that goes negative can be confirmed without acknowledging it");
  assert.match(ui, /Bestand wird nach dieser Buchung negativ/);
  assert.match(ui, /ausdrücklich bestätigen/);
  // And the server refuses it too, rather than trusting the checkbox.
  assert.match(sql, /coalesce\(p_allow_negative, false\) is not true/);
  assert.ok(codeOnly(routeSources.movement).includes("validateMovementRequest"));
});

test("8d: nothing is optimistic - the server is asked again", () => {
  for (const b of ["setData(prev", "optimistic", "current_quantity ="]) {
    assert.ok(!uiCode.includes(b), `the screen patches stock locally: ${b}`);
  }
  assert.ok(uiCode.includes("await onDone()"), "a booking does not refresh anything");
  assert.match(uiCode, /const reloadAll = useCallback/);
  // A failure shows the server's sentence and no internals.
  assert.ok(uiCode.includes('typeof data.error === "string" ? data.error'));
  for (const leak of ["stack", "console.log"]) {
    assert.ok(!uiCode.includes(leak), `the screen can expose ${leak}`);
  }
});

test("8e: the history is shown newest first and says it cannot be edited", () => {
  assert.match(adminCode, /\.order\("occurred_at", \{ ascending: false \}\)/);
  assert.match(ui, /Bewegungshistorie/);
  assert.match(ui, /Bestand danach/);
  assert.match(ui, /lassen sich nicht ändern oder löschen/);
  assert.match(ui, /Korrekturbuchung/);
});

test("8j: A NEW ARTICLE PRESELECTS NO CATEGORY", () => {
  const form = uiCode.slice(uiCode.indexOf("function ItemForm"), uiCode.indexOf("function ItemDialog"));

  // The bug this locks out: falling back to the first option attached
  // whichever category happened to sort first to every item filed in a
  // hurry, and a wrong category is harder to spot later than an empty one.
  assert.ok(!/useState\(item\?\.category_id \?\? categories\[0\]/.test(form),
    "a new article still preselects the first category");
  assert.ok(!form.includes("categories[0]?.id"),
    "some other path still reaches for the first category");
  assert.match(form, /useState\(item\?\.category_id \?\? ""\)/,
    "a new article does not start without a category");

  // Neutral placeholder, shown only while nothing is chosen and never
  // selectable - it admits the field is empty, it is not a storable value.
  assert.match(form, /Kategorie auswählen …/, "the placeholder is missing");
  assert.match(form, /categoryId === "" && <option value="" disabled>/,
    "the placeholder is either always present or selectable");

  // Required stays required, and the button is the actual enforcement.
  assert.match(form, /<select value=\{categoryId\} disabled=\{busy\} required/,
    "the category select lost its required flag");
  assert.ok(form.includes("categoryId.length > 0"),
    "an article can be created without a category");
  assert.match(form, /disabled=\{busy \|\| !valid\}/,
    "the create button is not gated on a valid form");

  // Editing is untouched: a saved item still arrives with its own.
  assert.ok(form.includes("item?.category_id ??"),
    "editing no longer preselects the stored category");

  // A freshly created category is still the sensible selection.
  assert.ok(form.includes("setCategoryId(created.id)"),
    "creating a category no longer selects it");
});

test("8f: the empty state invites a first item rather than inventing one", () => {
  assert.match(ui, /Dein Inventar ist noch leer/);
  assert.match(ui, /Lege deinen ersten Artikel an/);
  // NO DEMO DATA. A placeholder inside an empty input is not data -
  // "z. B. Matcha Rohware" is a hint about what to type, and nothing is
  // stored until somebody types it. What must not exist is a seeded
  // array, a default item or a pre-filled quantity.
  for (const invented of ["const DEMO", "demoItems", "seedItems", "Beispielartikel",
                          "useState(\"10000\")", "useState(10000)"]) {
    assert.ok(!uiCode.includes(invented), `the screen ships invented data: ${invented}`);
  }
  // Every quantity input starts empty.
  for (const m of uiCode.matchAll(/const \[(quantity|initial|threshold)[^\]]*\] = useState\(([^)]*)\)/g)) {
    assert.ok(m[2] === '""' || m[2].includes("item?.") || m[2] === "",
      `${m[1]} starts with an invented value: ${m[2]}`);
  }
});

test("8g: the filters cover area, status, category and archived", () => {
  for (const id of ["inv-area", "inv-status", "inv-category", "inv-archived", "inv-search"]) {
    assert.ok(ui.includes(`id="${id}"`), `no filter control for ${id}`);
  }
  for (const label of ["B2C", "B2B", "Event", "Intern"]) {
    assert.ok(Object.values(AREA_LABEL).includes(label), `${label} is not an area label`);
  }
  assert.match(ui, /Artikel, SKU oder Lieferant/);
});

test("8h: the list reads areas and last movement in ONE query each", () => {
  assert.equal([...adminCode.matchAll(/\.from\("inventory_item_areas"\)[\s\S]{0,200}?\.in\("inventory_item_id", ids\)/g)].length, 1,
    "the areas are read per row instead of per page");
  assert.match(adminCode, /\.from\("inventory_movements"\)[\s\S]{0,300}?\.in\("inventory_item_id", ids\)/);
  assert.match(adminCode, /MOVEMENTS_SCANNED_PER_ITEM/, "the last-movement read is unbounded");
  // The browser never fetches per row.
  const fetches = [...new Set([...uiCode.matchAll(/post\("([^"]+)"/g)].map(m => m[1]))];
  assert.ok(!fetches.some(f => f.includes("movements")), "the screen fetches movements per row");
});

test("8i: the inventory tab is real and no longer advertised as coming", () => {
  assert.match(shell, /view === "inventory" && <AdminInventory/);
  assert.match(shell, /\["B2B", "Kosten"\]\.map/);
  const soon = shell.slice(shell.indexOf("ops-nav-soon") - 400, shell.indexOf("ops-nav-soon"));
  assert.ok(!soon.includes("Inventar"), "Inventar is still listed as coming");
});

/* ══════════════════════════════════════════════════════════════
   9. MOBILE
   ══════════════════════════════════════════════════════════════ */

test("9: the inventory tables become cards on a phone, and nothing scrolls sideways", () => {
  const mobile = mobileRules(css);
  assert.ok(mobile.includes(".ops-inventory thead"), "the item header is not hidden on mobile");
  assert.ok(mobile.includes(".ops-movements"), "the history table is not adapted for mobile");
  assert.match(mobile, /\.ops-inventory tbody td::before,\.ops-movements tbody td::before\{\s*content:attr\(data-label\)/);
  assert.ok(mobile.includes("overflow-wrap:anywhere"), "a long item name cannot wrap");
  assert.ok(mobile.includes("min-width:0"), "a cell can set the track width and push the card sideways");
  // THE BASE RULE SETS min-width:840px so seven columns never crush
  // themselves on desktop. display:block does not undo that, and without
  // this reset the table stayed 840px wide inside a 350px wrapper - 490px
  // of content the operator could not reach. Found by measuring.
  assert.match(mobile, /\.ops-inventory,\.ops-movements\{ min-width:0; \}/,
    "the inventory tables keep the desktop minimum width on a phone");
  // Every cell carries the label its header would have given it.
  const labels = [...ui.matchAll(/data-label="([^"]+)"/g)].map(m => m[1]);
  for (const header of ["Artikel", "Kategorie", "Bereich", "Bestand", "Mindestbestand", "Status",
                        "Letzte Bewegung", "Datum", "Typ", "Grund", "Änderung", "Bestand danach"]) {
    assert.ok(labels.includes(header), `no data-label for ${header}`);
  }
});

test("9b: THE 4A.1B OVERFLOW RULES ARE INTACT", () => {
  // The drawer fix that took two passes to get right. A new tab that
  // quietly reintroduced the overflow would be a regression nobody
  // noticed until they opened it on a phone.
  const always = outsideMediaQueries(css);
  assert.match(always, /\.ops-facts div,\.ops-facts dt,\.ops-facts dd\{ min-width:0; overflow-wrap:anywhere; \}/);
  const drawer = always.slice(always.indexOf(".ops-drawer{"), always.indexOf("}", always.indexOf(".ops-drawer{")));
  assert.match(drawer, /overflow-x:hidden/);
  assert.match(always, /\.ops-drawer \.ops-items\{ table-layout:fixed; width:100%; \}/);
  assert.match(always, /\.ops-emails\{ grid-template-columns:repeat\(2,minmax\(0,1fr\)\); \}/);
});

test("9c: the category select is styled BY the input rule, not beside it", () => {
  // The select had no box at all next to bordered text fields. It is
  // fixed by JOINING the input declaration block - one block, so border,
  // height, background, padding and type cannot drift apart later - and
  // a lookalike copy would defeat the point.
  const always = outsideMediaQueries(css);
  const i = always.indexOf(".ops-action-fields input[type=text],");
  assert.ok(i >= 0, "the shared field rule is gone");
  const rule = always.slice(i, always.indexOf("}", i) + 1);
  assert.match(rule, /\.ops-action-fields select\{/,
    "the select is not in the input's own declaration block");
  for (const decl of ["border:1px solid var(--line)", "background:transparent",
                      "padding:9px 11px", "font:inherit", "font-size:14px",
                      "width:100%", "min-width:0"]) {
    assert.ok(rule.includes(decl), `the shared field rule lost ${decl}`);
  }

  // Disabled parity: the select is disabled while a save is in flight.
  assert.match(always, /\.ops-action-fields input:disabled,\s*\.ops-action-fields select:disabled\{ opacity:\.55; \}/,
    "a disabled select no longer dims like a disabled input");

  // SCOPE. The filter bar keeps its own select rule, and nothing global
  // was restyled - every select rule in the file is scoped to one of the
  // two admin containers.
  assert.match(always, /\.ops-filter-row select\{/, "the filter bar lost its own select rule");
  // Every ADMIN select rule names one of the two containers. Scoped to
  // `.ops-` on purpose: the rest of the stylesheet has its own select
  // rules for the contact, account, lead and launch forms, and none of
  // them is this package's business.
  for (const m of css.matchAll(/(^|[},])\s*([^{},]*\bselect\b[^{},]*)\{/g)) {
    const sel = m[2].trim();
    if (!sel.includes(".ops-")) continue;
    assert.ok(/\.ops-action-fields|\.ops-filter-row/.test(sel),
      `an admin select rule escaped the two containers: ${sel}`);
  }
});


/* ════════════════════════════════════════════════════════════════════
   10. INVENTORY IS NOT ACCOUNTING
   ════════════════════════════════════════════════════════════════════ */

/**
 * THE BOUNDARY THIS SECTION DEFENDS.
 *
 * The inventory answers what GLOA has, what came in, what went out and
 * what it went out for. It does not answer what any of it cost - that is
 * a financial question, it belongs to accounting, and accounting arrives
 * with its own package and its own tables.
 *
 * The boundary erodes by accident rather than by decision: the price is
 * printed on the delivery note the operator is already holding when they
 * book a receipt, so "while we are here" is always one field away. The
 * damage shows up much later, when somebody reports a margin computed
 * from a number no invoice ever agreed to and nobody can say which of
 * the two sources is the wrong one.
 *
 * So the ban is asserted against the SOURCE of every layer at once - the
 * migration, the pure leaf, the writer, all nine routes and the screen -
 * and comments are stripped first. That is what lets those files explain
 * the boundary in prose without prose satisfying or breaking a check.
 *
 * SUPPLIER, BATCH AND BEST-BEFORE ARE NOT MONEY and stay: they answer
 * where something came from and when it stops being usable, which is
 * what somebody standing at a shelf needs. 10d guards them, because a
 * removal is as easy to overdo as to underdo.
 */
const MONEY_TERMS = [
  [/purchase[_ ]?price/i, "a purchase price"],
  [/price[_ ]?cents|priceCents/i, "a price in cents"],
  [/\bprices?\b/i, "a price"],
  [/\bcents?\b/i, "an amount in cents"],
  [/\bcosts?\b/i, "a cost"],
  [/\bmargins?\b/i, "a margin"],
  [/\binvoices?\b/i, "an invoice"],
  [/\bexpenses?\b/i, "an expense"],
  [/financ/i, "a finance field"],
  [/accounting/i, "an accounting field"],
  [/valuation|\bfifo\b|\blifo\b|average_cost|avg_cost/i, "a stock valuation"],
  [/Einkaufspreis|Verkaufspreis|Warenwert|Bestandswert|Buchhaltung|Rechnung|Kosten/i,
    "a German money field"],
  [/\u20ac|\bEUR\b/, "a currency amount"],
];

/** Assert that not one money term appears in `source`. */
function assertHoldsNoMoney(label, source) {
  for (const [pattern, what] of MONEY_TERMS) {
    const hit = source.match(pattern);
    assert.equal(hit, null, `${label} carries ${what}: ${JSON.stringify(hit?.[0])}`);
  }
}

test("10: MIGRATION 050 HOLDS NO MONEY - no column, no parameter, no grant", () => {
  assertHoldsNoMoney("migration 050", sql);
  // The two tables a price would have hung on do exist, so this is an
  // absent column and not an absent table.
  assert.match(sql, /create table if not exists public\.inventory_items/);
  assert.match(sql, /create table if not exists public\.inventory_movements/);
  // The booking function takes fourteen arguments and none is an amount.
  // The signature is asserted as a WHOLE: a price added back as a
  // defaulted parameter would be invisible to a term scan of the call
  // sites, because no caller would have to pass it.
  const signature = sql.slice(sql.indexOf("function public.record_inventory_movement("));
  const params = signature.slice(signature.indexOf("(") + 1, signature.indexOf(")")).trim();
  const names = params.split(",").map(one => one.trim().split(/\s+/)[0]).filter(Boolean);
  assert.deepEqual(names,
    ["p_operation_id", "p_item_id", "p_quantity", "p_movement_type", "p_reason",
     "p_area", "p_note", "p_reference", "p_supplier", "p_batch_number",
     "p_best_before_date", "p_occurred_at", "p_actor_email", "p_allow_negative"],
    "the booking function's parameters changed");
  // ...and its four grant/revoke statements name that same arity, so a
  // parameter cannot be added without the grants pointing at nothing.
  const arity = "(uuid, uuid, numeric, text, text, text, text, text, text, text, date, timestamptz, text, boolean)";
  assert.equal(sql.split(`record_inventory_movement${arity}`).length - 1, 4,
    "the booking function's grants no longer match its signature");
});

test("10b: NO LAYER OF THE INVENTORY CODE KNOWS A PRICE", () => {
  const layers = {
    "lib/inventoryRules.ts": codeOnly(rules),
    "lib/inventoryAdmin.ts": adminCode,
    "app/AdminInventory.tsx": uiCode,
    ...Object.fromEntries(Object.entries(routeSources).map(([key, src]) => [ROUTES[key], codeOnly(src)])),
  };
  assert.equal(Object.keys(layers).length, 12, "a layer stopped being checked");
  for (const [file, source] of Object.entries(layers)) {
    assert.ok(source.length > 200, `${file} read as empty, so it proves nothing`);
    assertHoldsNoMoney(file, source);
  }
  // No layer turns cents into euros, which is the shape a price takes
  // even when it is not called one.
  const everything = Object.values(layers).join("\n");
  assert.ok(!/\/ *100\b|\* *0?\.01\b/.test(everything), "something converts cents somewhere");
  assert.ok(!/toLocaleString\([^)]*currency/i.test(everything), "something formats a currency");
});

test("10c: there is no PREPARATORY link to a finance table either", () => {
  // Not "we will need it later, so here is the column already". A spare
  // foreign key is an invitation, and the next person to read it takes it
  // for a decision that has already been made.
  const code = codeOnly(rules) + adminCode + uiCode;
  for (const id of ["finance_id", "expense_id", "invoice_id", "accounting_reference_id",
                    "cost_center", "cost_centre", "ledger_account", "booking_id",
                    "journal_entry_id"]) {
    assert.ok(!sql.includes(id), `050 prepares a finance link: ${id}`);
    assert.ok(!code.includes(id), `the inventory code prepares a finance link: ${id}`);
  }
  // Every foreign key 050 declares points back into the inventory.
  const targets = [...sql.matchAll(/references\s+public\.(\w+)/g)].map(m => m[1]);
  assert.ok(targets.length >= 3, `the foreign keys disappeared: ${targets.length}`);
  for (const target of targets) {
    assert.ok(target.startsWith("inventory_"), `050 points a foreign key at ${target}`);
  }
});

test("10d: THE OPERATIONAL FIELDS SURVIVED THE REMOVAL", () => {
  // Taking the price out must not take the delivery facts with it. Where
  // a batch came from and when it expires are the first two questions
  // asked when something turns out wrong, and neither is financial.
  for (const column of ["supplier", "batch_number", "best_before_date", "sku",
                        "category_id", "area", "quantity_delta", "unit",
                        "low_stock_threshold", "note", "reference"]) {
    assert.ok(sql.includes(column), `${column} was removed along with the price`);
  }
  for (const column of ["supplier", "batch_number", "best_before_date"]) {
    assert.ok(MOVEMENT_COLUMNS.split(",").includes(column), `the ledger stopped reading ${column}`);
  }
  for (const column of ["supplier", "low_stock_threshold", "notes"]) {
    assert.ok(ITEM_COLUMNS.split(",").includes(column), `the item stopped reading ${column}`);
  }
  for (const [label, columns] of [["ITEM_COLUMNS", ITEM_COLUMNS],
                                  ["MOVEMENT_COLUMNS", MOVEMENT_COLUMNS],
                                  ["CATEGORY_COLUMNS", CATEGORY_COLUMNS]]) {
    assertHoldsNoMoney(label, columns);
  }

  // A receipt still carries everything a receipt is for...
  const receipt = {
    operationId: UUID_A, itemId: UUID_B, movementType: "receipt", reason: "goods_receipt",
    quantity: "500", supplier: "Uji Tea", batchNumber: "L-2026-04", bestBeforeDate: "2027-04-01",
  };
  const booked = validateMovementRequest(receipt);
  assert.equal(booked.ok, true);
  assert.equal(booked.request.supplier, "Uji Tea");
  assert.equal(booked.request.batchNumber, "L-2026-04");
  assert.equal(booked.request.bestBeforeDate, "2027-04-01");

  // ...and a price sent anyway is not validated, not carried and not
  // echoed back. It is not an error either: refusing it by name would
  // tell a client the field is known here.
  const withPrice = validateMovementRequest({ ...receipt, purchasePriceCents: 4999, priceCents: 4999 });
  assert.equal(withPrice.ok, true, "an unknown field must not break a valid booking");
  assert.ok(!Object.keys(withPrice.request).some(key => /price|cost|cent/i.test(key)),
    `the validator carried a price through: ${Object.keys(withPrice.request).join(",")}`);
  assert.ok(!JSON.stringify(withPrice.request).includes("4999"),
    "a client-sent price survived validation");

  const item = validateCreateItemRequest({
    operationId: UUID_A, name: "Matcha Rohware", unit: "g", categoryId: UUID_B,
    supplier: "Uji Tea", purchasePriceCents: 4999,
  });
  assert.equal(item.ok, true);
  assert.equal(item.request.supplier, "Uji Tea", "the supplier was removed from the item form");
  assert.ok(!JSON.stringify(item.request).includes("4999"), "a new item stored a price");
});

test("10e: NOTHING ON THE SCREEN ASKS FOR OR SHOWS A PRICE", () => {
  const MONEY_WORD = /preis|kosten|betrag|wert$|\u20ac|\beur\b/i;
  // Every field label the operator can read.
  const labels = [...ui.matchAll(/<span>([^<{]+)<\/span>/g)].map(m => m[1]);
  assert.ok(labels.length >= 14, `the form labels stopped being found: ${labels.length}`);
  for (const label of labels) assert.ok(!MONEY_WORD.test(label), `a form field asks for: ${label}`);
  assert.ok(labels.includes("Lieferant"), "the supplier field went with the price");
  assert.ok(labels.includes("Chargennummer"), "the batch field went with the price");
  assert.ok(labels.includes("Mindestens haltbar bis"), "the best-before field went with the price");

  // Every row the detail drawer prints.
  const rows = [...ui.matchAll(/\["([^"]+)", /g)].map(m => m[1]);
  assert.ok(rows.length >= 10, `the drawer rows stopped being found: ${rows.length}`);
  for (const row of rows) assert.ok(!MONEY_WORD.test(row), `the drawer shows: ${row}`);
  assert.ok(rows.includes("Lieferant"), "the drawer stopped showing the supplier");

  // No input on the screen is a money input.
  for (const input of uiCode.match(/<input[^>]*>/g) ?? []) {
    assert.ok(!/price|cost|betrag|preis/i.test(input), `a money input exists: ${input}`);
  }
  // The procurement block is still there - it simply has no price in it.
  assert.ok(uiCode.includes('title="Beschaffung"'), "the procurement block disappeared entirely");
});

/** Every @media (max-width:760px) block, concatenated. */
function mobileRules(source) {
  let out = "", i = 0;
  const marker = "@media (max-width:760px){";
  while ((i = source.indexOf(marker, i)) !== -1) {
    let depth = 1, j = i + marker.length;
    while (j < source.length && depth > 0) {
      if (source[j] === "{") depth += 1;
      else if (source[j] === "}") depth -= 1;
      j += 1;
    }
    out += source.slice(i, j) + "\n";
    i = j;
  }
  return out;
}

/** CSS with every @media block removed. */
function outsideMediaQueries(source) {
  let out = "", i = 0;
  while (i < source.length) {
    if (source.startsWith("@media", i)) {
      const open = source.indexOf("{", i);
      let d = 1, j = open + 1;
      while (j < source.length && d > 0) {
        if (source[j] === "{") d += 1;
        else if (source[j] === "}") d -= 1;
        j += 1;
      }
      i = j;
      continue;
    }
    out += source[i];
    i += 1;
  }
  return out;
}
