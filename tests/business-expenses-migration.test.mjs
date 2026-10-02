import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DIRECT_EXPENSE_CATEGORIES,
  EXPENSE_CATEGORIES,
  EXPENSE_CATEGORY_LABEL,
  EXPENSE_CHANNELS,
  EXPENSE_CHANNEL_LABEL,
  EXPENSE_PAYMENT_STATUSES,
  EXPENSE_PAYMENT_STATUS_LABEL,
  expenseNetCents,
  isExpenseChannel,
  isExpensePaymentStatus,
  berlinDateOf,
  buildFinanceSummary,
  expenseFallsInPeriod,
  isDirectExpenseCategory,
  isExpenseCategory,
  isIsoDate,
  monthPeriod,
  orderFallsInPeriod,
  previousMonthPeriod,
  validateFinancePeriod,
} from "../lib/financeSummary.ts";

/*
  ══════════════════════════════════════════════════════════════
  MIGRATION 071 — KOSTEN / SPESEN / DECKUNGSBEITRAG
  ══════════════════════════════════════════════════════════════

  GLOA has known what it EARNED since migration 004 and has never known
  what anything COST. 071 is the table migration 050 said would come, and
  this suite is mostly about one risk:

      A MARGIN COMPUTED FROM INCOMPLETE COSTS IS NOT A SMALLER MARGIN.
      It is a WRONG one, and it is wrong in the flattering direction -
      every cost nobody has typed in yet makes GLOA look more profitable.

  So the arithmetic is tested, and then the HONESTY is tested: that an
  unknown stays unknown, that the operating result is null rather than a
  number when the inputs do not support one, and that shipping revenue is
  never mistaken for a shipping cost.

  ── 071 IS PENDING ────────────────────────────────────────────

  It is written, reviewed and NOT applied to Production. Migration 070 is
  the newest APPLIED one. That is declared in exactly one place -
  tests/b2b-pending-agreement-writer.test.mjs's PENDING constant - and
  this file asserts the two halves that must hold while it is pending.
*/

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf8");

const MIGRATION_NAME = "071_business_expenses.sql";
const MIGRATION = read(`supabase/migrations/${MIGRATION_NAME}`);
const PREFLIGHT = read("supabase/preflight/071_business_expenses_preflight.sql");
const POSTCHECK = read("supabase/postcheck/071_business_expenses_postcheck.sql");
const ROUTE = read("app/api/admin/costs/route.ts");
const UI = read("app/AdminCosts.tsx");
const SHELL = read("app/AdminOverview.tsx");
const LIB = read("lib/financeSummary.ts");
const CSS = read("app/globals.css");

/** Executable region only: this repository's suites read code, not prose. */
const codeOnly = src => src
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split(/\r?\n/).filter(l => !l.trim().startsWith("//") && !l.trim().startsWith("--"))
  .join("\n");

/* ══════════════════════════════════════════════════════════════
   1. THE MIGRATION'S SHAPE
   ══════════════════════════════════════════════════════════════ */

test("1: it is the newest migration, owns its number alone, and is one transaction", () => {
  const files = readdirSync(path.join(ROOT, "supabase/migrations"))
    .filter(f => f.endsWith(".sql")).sort();
  assert.equal(files.at(-1), MIGRATION_NAME, "071 is not the newest migration");
  assert.equal(files.filter(f => f.startsWith("071")).length, 1);
  assert.equal(files.filter(f => Number(f.slice(0, 3)) > 71).length, 0);
  // One transaction, and nothing executable after the commit.
  assert.match(MIGRATION, /^-- ═+\r?\n-- 071 /);
  assert.equal((MIGRATION.match(/^begin;$/gm) || []).length, 1);
  assert.equal((MIGRATION.match(/^commit;$/gm) || []).length, 1);
  const after = MIGRATION.slice(MIGRATION.lastIndexOf("commit;") + "commit;".length);
  assert.equal(after.replace(/\s/g, ""), "", "something follows the commit");
});

test("1b: it creates ONE table and alters no existing one", () => {
  const code = codeOnly(MIGRATION);
  assert.equal((code.match(/create table if not exists public\.(\w+)/g) || []).length, 1);
  assert.match(code, /create table if not exists public\.business_expenses/);
  /*
    THE WHOLE POINT OF AN ADDITIVE MIGRATION. The only `alter table` here
    is on 071's own table, for its own named constraint. A column added
    to orders, a widened CHECK somewhere else or a dropped constraint
    would all make this a migration that rewrites live schema.
  */
  const alters = [...code.matchAll(/alter table (?:if exists )?public\.(\w+)/g)].map(m => m[1]);
  assert.deepEqual([...new Set(alters)], ["business_expenses"],
    "071 alters a table other than its own");
  for (const banned of ["drop table", "drop column", "alter column", "drop constraint"]) {
    // Its own constraint is dropped-if-exists before being added, which
    // is the idempotent form; nothing else may be.
    const hits = [...code.matchAll(new RegExp(banned, "gi"))];
    for (const h of hits) {
      const line = code.slice(Math.max(0, h.index - 200), h.index + 120);
      assert.ok(/business_expenses/.test(line),
        `071 performs "${banned}" on something that is not its own table`);
    }
  }
  // It backfills nothing: no insert, no update of an existing row.
  assert.ok(!/\binsert into public\.(?!business_expenses)/i.test(code),
    "071 writes a row into an existing table");
  assert.ok(!/\bupdate public\.(?!business_expenses)/i.test(code),
    "071 rewrites rows in an existing table");
});

test("1c: money is integer cents, strictly positive, EUR only", () => {
  /*
    THE AMOUNT IS NAMED GROSS, and the ambiguous name is gone.

    An earlier draft called it amount_cents and said nothing about gross
    or net. The margin subtracts it from GROSS revenue, so a net figure
    typed into it would have overstated the margin by the VAT -
    permanently, because what an entered number MEANT cannot be recovered.
    That is why this is the one change that had to happen before 071 was
    applied rather than in a later migration.
  */
  assert.match(MIGRATION, /gross_cents\s+integer not null check \(gross_cents > 0\)/);
  assert.ok(!/amount_cents\s+integer/.test(MIGRATION),
    "the ambiguous amount_cents column still exists");
  // Not >= 0: a zero cost was not incurred, and recording one only makes
  // the completeness count lie.
  assert.ok(!/gross_cents >= 0/.test(MIGRATION), "a zero-cost row is allowed");
  assert.match(MIGRATION, /currency\s+text not null default 'EUR' check \(currency = 'EUR'\)/);
  // No floating point anywhere near a money column.
  for (const banned of ["numeric(", "real", "double precision", "float"]) {
    assert.ok(!codeOnly(MIGRATION).includes(banned),
      `071 stores money as ${banned}`);
  }
});

test("1c2: VAT is NULLABLE, bounded, and never derived from a rate", () => {
  /*
    THE NULL IS THE FEATURE. null means "not known"; 0 means "known, and
    zero". A VAT overview built by reading null as zero would be a
    confident report of a figure nobody has, so the column must stay
    nullable and the bound must be the only arithmetic it gets.
  */
  assert.match(MIGRATION, /vat_cents\s+integer,/);
  assert.ok(!/vat_cents\s+integer not null/.test(MIGRATION),
    "vat_cents is NOT NULL - an unknown VAT cannot be expressed");
  assert.match(MIGRATION, /business_expenses_vat_bounds_check/);
  const bounds = MIGRATION.slice(MIGRATION.indexOf("add constraint business_expenses_vat_bounds_check"));
  assert.match(bounds, /vat_cents is null/);
  assert.match(bounds, /vat_cents >= 0 and vat_cents <= gross_cents/);

  // NO RATE IS ASSUMED ANYWHERE. Not in the migration, not in the lib.
  for (const [name, src] of Object.entries({ MIGRATION, LIB, ROUTE, UI })) {
    const code = codeOnly(src);
    for (const banned of ["1.19", "1.07", "0.19", "0.07", "* 19", "* 7 /", "/ 119", "/ 107"]) {
      assert.ok(!code.includes(banned), `${name} infers VAT with ${banned}`);
    }
  }
});

test("1c3: net is DISPLAYED where VAT is known, and is never stored", () => {
  // No net column exists at all: a persisted net would be a second
  // source for a derivable number, and a wrong one on every row whose
  // VAT nobody has entered.
  /*
    SCOPED TO THE TABLE DEFINITION. 071's closing notes legitimately
    mention orders.total_net_cents - that is the REVENUE net, which stays
    where it is. What must not exist is a net column on the expense table.
  */
  const table = MIGRATION.slice(
    MIGRATION.indexOf("create table if not exists public.business_expenses"),
    MIGRATION.indexOf("business_expenses_vat_bounds_check"));
  assert.ok(!/net_cents/.test(table), "071 persists a net expense figure");
  // The one place it is produced, and it returns null rather than
  // falling back to the gross.
  assert.equal(expenseNetCents({ grossCents: 1190, vatCents: 190 }), 1000);
  assert.equal(expenseNetCents({ grossCents: 1190, vatCents: 0 }), 1190);
  assert.equal(expenseNetCents({ grossCents: 1190, vatCents: null }), null);
});

test("1c4: the channel and payment-status vocabularies are closed and shared", () => {
  // The channel is migration 050's four values, spelled the same way.
  const m050 = read("supabase/migrations/050_inventory_foundation.sql");
  assert.match(m050, /area\s+text not null check \(area in \('b2c', 'b2b', 'event', 'internal'\)\)/);
  const channelCheck = MIGRATION.slice(MIGRATION.indexOf("channel       text not null check"));
  for (const ch of EXPENSE_CHANNELS) {
    assert.ok(channelCheck.includes(`'${ch}'`), `the channel CHECK does not accept ${ch}`);
  }
  assert.deepEqual([...EXPENSE_CHANNELS], ["b2c", "b2b", "event", "internal"]);
  // NOT "general": that word already means an expense category here, and
  // one word for two concepts is how a filter returns the wrong rows.
  assert.ok(!channelCheck.slice(0, channelCheck.indexOf(")")).includes("'general'"),
    "the channel vocabulary invented a synonym for internal");
  assert.equal(isExpenseChannel("general"), false);
  assert.equal(EXPENSE_CHANNEL_LABEL.internal, "Allgemein");

  // Payment status is exactly open/paid, and no accounting beyond it.
  assert.match(MIGRATION, /payment_status text not null check \(payment_status in \('open', 'paid'\)\)/);
  assert.deepEqual([...EXPENSE_PAYMENT_STATUSES], ["open", "paid"]);
  for (const invented of ["partial", "overdue", "cancelled", "refunded"]) {
    assert.equal(isExpensePaymentStatus(invented), false);
    assert.ok(!MIGRATION.includes(`'${invented}'`),
      `071 invented the payment state ${invented}`);
  }
  assert.equal(EXPENSE_PAYMENT_STATUS_LABEL.open, "Offen");
  assert.equal(EXPENSE_PAYMENT_STATUS_LABEL.paid, "Bezahlt");
});

test("1c5: the CHANNEL of an order-linked cost is DERIVED, in both writers", () => {
  /*
    The rule a caller could otherwise defeat. Both writing functions must
    read orders.customer_type for a row carrying an order_id and derive
    the channel, rather than inserting whatever arrived - otherwise a B2C
    cost could be filed under B2B from a browser and every channel report
    would be quietly wrong.
  */
  for (const fn of ["admin_record_business_expense", "admin_update_business_expense"]) {
    const body = MIGRATION.slice(
      MIGRATION.indexOf(`function public.${fn}(`),
      MIGRATION.indexOf("$$;", MIGRATION.indexOf(`function public.${fn}(`)));
    assert.match(body, /select o\.customer_type into v_customer_type/,
      `${fn} does not read the order's customer type`);
    assert.match(body, /when v_customer_type = 'business' then 'b2b' else 'b2c'/,
      `${fn} does not map the customer type to a channel`);
    assert.ok(body.includes("v_channel"), `${fn} does not use a derived channel`);
    // And a direct cost naming an order that does not exist is refused
    // HERE, before the channel is decided.
    assert.match(body, /raise exception 'business_expense_order_missing'/,
      `${fn} decides a channel for an order it never found`);
  }
  // The delete writer takes no channel at all - there is nothing to derive.
  const del = MIGRATION.slice(
    MIGRATION.indexOf("function public.admin_delete_business_expense("),
    MIGRATION.indexOf("$$;", MIGRATION.indexOf("function public.admin_delete_business_expense(")));
  assert.ok(!del.includes("p_channel"), "the delete writer takes a channel");
});

test("1d: a date, not a timestamp, decides which period a cost belongs to", () => {
  assert.match(MIGRATION, /occurred_on\s+date not null/);
  // An instant would move a cost between two months depending on the
  // reader's time zone. A date cannot.
  assert.ok(!/occurred_on\s+timestamptz/.test(MIGRATION));
});

test("1e: the two kinds of cost are kept apart by a CHECK, not a convention", () => {
  assert.match(MIGRATION, /business_expenses_order_scope_check/);
  const scope = MIGRATION.slice(MIGRATION.indexOf("business_expenses_order_scope_check"));
  assert.match(scope, /order_id is null and category = 'general'/);
  assert.match(scope, /order_id is not null and category <> 'general'/);
  // And the order cannot be deleted out from under a cost that counts
  // against its margin.
  assert.match(MIGRATION, /order_id\s+uuid references public\.orders\(id\) on delete restrict/);
});

test("1f: the category vocabulary is closed, and matches the lib exactly", () => {
  const check = MIGRATION.slice(MIGRATION.indexOf("category      text not null check"));
  for (const category of EXPENSE_CATEGORIES) {
    assert.ok(check.includes(`'${category}'`), `the CHECK does not accept ${category}`);
  }
  // The lib and the database agree on the SAME six, in the same split.
  assert.equal(EXPENSE_CATEGORIES.length, 6);
  assert.equal(DIRECT_EXPENSE_CATEGORIES.length, 5);
  assert.ok(!DIRECT_EXPENSE_CATEGORIES.includes("general"),
    "'general' is treated as a direct cost");
  for (const category of EXPENSE_CATEGORIES) {
    assert.ok(EXPENSE_CATEGORY_LABEL[category], `${category} has no German label`);
  }
  assert.equal(isExpenseCategory("marketing"), false);
  assert.equal(isDirectExpenseCategory("general"), false);
  assert.equal(isDirectExpenseCategory("payment_fee"), true);
});

/* ══════════════════════════════════════════════════════════════
   2. NO PRICE LEAKED INTO THE STOCK LEDGER
   ══════════════════════════════════════════════════════════════ */

test("2: 071 keeps migration 050's boundary - inventory still holds no money", () => {
  /*
    050's header is explicit: "Not one column here holds a price, a
    value, a cost or an amount... what something cost is a financial fact
    that belongs to accounting, and it arrives with its own package and
    its own tables." 071 IS that package, so it must not reach back.
  */
  const code = codeOnly(MIGRATION);
  for (const inventoryTable of ["inventory_items", "inventory_categories",
                                "inventory_movements", "inventory_item_areas"]) {
    assert.ok(!code.includes(inventoryTable),
      `071 touches ${inventoryTable} - inventory answers quantities, not money`);
  }
  // And nothing in 050 grew a price column in the meantime.
  const m050 = read("supabase/migrations/050_inventory_foundation.sql");
  for (const banned of ["cost_cents", "unit_cost", "purchase_price", "price_cents"]) {
    assert.ok(!m050.includes(banned), `050 gained ${banned}`);
  }
});

test("2b: a frozen cost is a ROW, never a lookup through a product", () => {
  /*
    THE REASON HISTORICAL MARGIN IS SAFE. amount_cents is what the
    invoice said, recorded once. If a direct cost were resolved through a
    product or an inventory item instead, last year's margin would change
    the next time matcha got dearer - which is exactly the mistake 050
    refused to make possible.
  */
  const code = codeOnly(MIGRATION);
  for (const banned of ["product_variants", "products", "variant_id", "sku"]) {
    assert.ok(!code.includes(banned),
      `071 resolves a cost through ${banned} instead of freezing it`);
  }
  // The lib never recomputes an amount either: it only sums.
  const lib = codeOnly(LIB);
  for (const banned of ["* quantity", "/ quantity", "unitCost", "pricePer", "Math.round"]) {
    assert.ok(!lib.includes(banned), `the summary derives an amount with ${banned}`);
  }
});

/* ══════════════════════════════════════════════════════════════
   3. SECURITY
   ══════════════════════════════════════════════════════════════ */

test("3: RLS is on, no policy exists, and no browser role is granted anything", () => {
  assert.match(MIGRATION, /alter table public\.business_expenses enable row level security/);
  assert.match(MIGRATION, /revoke all privileges on table public\.business_expenses from anon, authenticated/);
  assert.match(MIGRATION, /revoke all privileges on table public\.business_expenses from public/);
  // Not one create policy anywhere - the browser has no read path at all.
  assert.ok(!/create policy/i.test(MIGRATION), "071 declares an RLS policy");
  assert.ok(!/to authenticated|to anon/.test(
    MIGRATION.split("grant").slice(1).join("grant")),
    "071 grants something to a browser role");
});

test("3b: service_role may READ the table and may not write it directly", () => {
  assert.match(MIGRATION, /grant select on table public\.business_expenses to service_role/);
  /*
    AND NOTHING MORE. If service_role could insert, a route could record
    a cost without an audit row and the writers' one-transaction
    guarantee would be advisory rather than structural.
  */
  const grants = [...MIGRATION.matchAll(/grant ([^;]*?) on table public\.business_expenses[^;]*;/g)]
    .map(m => m[1].trim());
  assert.deepEqual(grants, ["select"], "service_role was granted more than select");
});

test("3c: all three writers are SECURITY DEFINER with an emptied search_path", () => {
  for (const fn of ["admin_record_business_expense",
                    "admin_update_business_expense",
                    "admin_delete_business_expense"]) {
    const body = MIGRATION.slice(MIGRATION.indexOf(`function public.${fn}(`));
    assert.match(body.slice(0, 2000), /security definer set search_path = ''/,
      `${fn} is not a definer with an empty search_path`);
    assert.ok(MIGRATION.includes(`revoke all on function public.${fn}(`),
      `${fn} is not revoked from public/anon/authenticated`);
    assert.ok(MIGRATION.includes(`grant execute on function public.${fn}(`),
      `${fn} is not granted to service_role`);
  }
});

test("3d: the admin route is the only door, and it declares its capabilities", () => {
  // Both literally, so the classification audit in
  // tests/admin-identity.test.mjs can read them.
  assert.match(ROUTE, /requireAdminIdentity\(request, "read_sensitive"\)/);
  assert.match(ROUTE, /requireAdminIdentity\(request, "write"\)/);
  // The gate runs before the body decides anything.
  const gate = ROUTE.indexOf("requireAdminIdentity");
  const firstWrite = ROUTE.indexOf("admin.rpc(");
  assert.ok(gate > -1 && firstWrite > gate, "a write is reachable before the gate");
  // Every write leaves through an RPC, never a direct table write.
  for (const banned of [".insert(", ".update(", ".upsert(", ".delete("]) {
    assert.ok(!codeOnly(ROUTE).includes(banned),
      `the costs route writes the table directly with ${banned}`);
  }
  // POST only: there is no GET to leak finance into a URL or a cache.
  const handlers = [...ROUTE.matchAll(/export async function ([A-Z]+)\(/g)].map(m => m[1]);
  assert.deepEqual(handlers, ["POST"]);
});

test("3e: no credential, and no finance read for a viewer", () => {
  for (const secret of ["SUPABASE_SERVICE_ROLE_KEY", "service_role", "STRIPE_SECRET"]) {
    assert.ok(!UI.includes(secret), `the finance screen names ${secret}`);
  }
  // The screen is mounted only behind the same predicate as the other
  // commercial sections, which resolves to owner and admin.
  assert.match(SHELL, /view === "costs" && maySeeSubscriptions && <AdminCosts/);
  assert.match(SHELL, /key === "costs"\) && !maySeeSubscriptions \? null :/);
});

test("3f: every mutation is audited under module finance, in the same transaction", () => {
  for (const [fn, action] of [
    ["admin_record_business_expense", "expense_recorded"],
    ["admin_update_business_expense", "expense_updated"],
    ["admin_delete_business_expense", "expense_deleted"],
  ]) {
    const body = MIGRATION.slice(
      MIGRATION.indexOf(`function public.${fn}(`),
      MIGRATION.indexOf("$$;", MIGRATION.indexOf(`function public.${fn}(`)));
    assert.match(body, /perform public\.record_admin_activity\(/, `${fn} does not audit`);
    assert.ok(body.includes("'finance'"), `${fn} audits under the wrong module`);
    assert.ok(body.includes(`'${action}'`), `${fn} does not audit as ${action}`);
    /*
      AND IT SURVIVES A MISSING OPERATION ID. admin_activity_log
      .operation_id is NOT NULL, so passing the parameter through
      unguarded made every writer RAISE when it was omitted. Found by
      calling these functions against a real PostgreSQL; nothing that
      reads this file could have known that column's nullability.
    */
    assert.ok(body.includes("coalesce(p_operation_id"),
      `${fn} passes a null operation id straight to a NOT NULL column`);
    assert.ok(body.includes("pg_catalog.gen_random_uuid()"),
      `${fn} has no fallback operation id`);
  }
  // 'finance' needed no CHECK widening: 070 already allowed it.
  const m070 = read("supabase/migrations/070_customer_rights_foundation.sql");
  assert.match(m070, /admin_activity_log_module_check[\s\S]{0,400}'finance'/);
  // 071 only NAMES that CHECK, in a comment explaining why it needed no
  // widening. The executable region must not touch it: 070's first
  // version audited under a module the CHECK did not allow, and widening
  // it again here would be re-deciding a question 070 already settled.
  assert.ok(!/admin_activity_log_module_check/.test(codeOnly(MIGRATION)),
    "071 alters the audit module CHECK");
  assert.ok(MIGRATION.includes("admin_activity_log_module_check"),
    "071 no longer explains why it needs no CHECK widening");
});

test("3f2: the audit payloads are complete, as their comments claim", () => {
  /*
    The comments said "BOTH SIDES CARRY EVERY FIELD THAT CAN CHANGE" and
    "EVERY FINAL VALUE" while description, vendor, note, currency and both
    timestamps were missing. A correction to any of the first three
    produced an audit row asserting nothing had changed.
  */
  const create = MIGRATION.slice(
    MIGRATION.indexOf("function public.admin_record_business_expense("),
    MIGRATION.indexOf("$$;", MIGRATION.indexOf("function public.admin_record_business_expense(")));
  for (const field of ["occurredOn", "category", "description", "grossCents", "vatCents",
                       "channel", "paymentStatus", "orderId", "vendor", "note", "recordedBy"]) {
    assert.ok(create.includes(`'${field}'`), `the create audit omits ${field}`);
  }

  const upd = MIGRATION.slice(
    MIGRATION.indexOf("function public.admin_update_business_expense("),
    MIGRATION.indexOf("$$;", MIGRATION.indexOf("function public.admin_update_business_expense(")));
  // EVERY column the UPDATE statement writes has to appear on both sides.
  const MUTABLE = ["occurredOn", "category", "description", "grossCents", "vatCents",
                   "channel", "paymentStatus", "orderId", "vendor", "note"];
  const before = upd.slice(upd.indexOf("'before'"), upd.indexOf("'after'"));
  const after = upd.slice(upd.indexOf("'after'"));
  for (const field of MUTABLE) {
    assert.ok(before.includes(`'${field}'`), `the update audit's BEFORE omits ${field}`);
    assert.ok(after.includes(`'${field}'`), `the update audit's AFTER omits ${field}`);
  }
  // created_by and created_at are not mutable, so they are not here.
  assert.ok(!before.includes("'recordedBy'"), "the correction audit claims the author changed");

  const del = MIGRATION.slice(
    MIGRATION.indexOf("function public.admin_delete_business_expense("),
    MIGRATION.indexOf("$$;", MIGRATION.indexOf("function public.admin_delete_business_expense(")));
  for (const field of [...MUTABLE, "currency", "recordedBy", "createdAt", "updatedAt"]) {
    assert.ok(del.includes(`'${field}'`), `the delete audit omits ${field}`);
  }
  // The uuid is the audit row's entity_id and is not duplicated inside.
  assert.ok(!/'expenseId'|'id', v_/.test(create + upd + del),
    "an audit payload duplicates the entity id");
});

test("3g: a correction keeps the author and records BOTH amounts", () => {
  const body = MIGRATION.slice(
    MIGRATION.indexOf("function public.admin_update_business_expense("),
    MIGRATION.indexOf("$$;", MIGRATION.indexOf("function public.admin_update_business_expense(")));
  // created_by is who RECORDED it, which a correction does not change.
  assert.ok(!/set[\s\S]*created_by\s*=/.test(body), "a correction rewrites the author");
  // Locked before read, so two operators cannot interleave.
  assert.match(body, /for update/);
  // The audit holds before AND after: a correction IS the pair.
  assert.match(body, /'before', pg_catalog\.jsonb_build_object\(/);
  assert.match(body, /'after', pg_catalog\.jsonb_build_object\(/);
});

test("3h: a deletion is hard, and the values survive in the audit", () => {
  const body = MIGRATION.slice(
    MIGRATION.indexOf("function public.admin_delete_business_expense("),
    MIGRATION.indexOf("$$;", MIGRATION.indexOf("function public.admin_delete_business_expense(")));
  assert.match(body, /delete from public\.business_expenses where id = p_expense_id/);
  // Every value goes into the audit BEFORE the row goes.
  for (const kept of ["'grossCents'", "'vatCents'", "'channel'", "'paymentStatus'",
                      "'description'", "'occurredOn'", "'recordedBy'"]) {
    assert.ok(body.includes(kept), `the deletion audit drops ${kept}`);
  }
  const del = body.indexOf("delete from public.business_expenses");
  const audit = body.indexOf("record_admin_activity");
  assert.ok(del < audit, "the audit runs before the delete, so a failure loses the trail");
});

/* ══════════════════════════════════════════════════════════════
   3x. IDEMPOTENCY: ONE OPERATION ID IS ONE LOGICAL MUTATION
   ══════════════════════════════════════════════════════════════ */

test("3i: every writer guards the MUTATION, not merely the audit row", () => {
  /*
    THE DEFECT THIS REPLACES. An earlier 071 passed p_operation_id to
    record_admin_activity and called that idempotency. It was not:
    admin_activity_log is unique on (module, action, operation_id), so a
    retry produced ONE audit event - and nothing stopped it producing a
    SECOND business_expenses row. In a cost ledger the duplicate is
    invisible in the trail and counts twice in every margin.
  */
  for (const [fn, action] of [
    ["admin_record_business_expense", "expense_recorded"],
    ["admin_update_business_expense", "expense_updated"],
    ["admin_delete_business_expense", "expense_deleted"],
  ]) {
    const body = MIGRATION.slice(
      MIGRATION.indexOf(`function public.${fn}(`),
      MIGRATION.indexOf("$$;", MIGRATION.indexOf(`function public.${fn}(`)));

    // 1. resolved ONCE, so the lock and the lookup cannot disagree
    assert.match(body, /v_operation_id := coalesce\(p_operation_id, pg_catalog\.gen_random_uuid\(\)\);/,
      `${fn} does not resolve the operation id into a local`);
    // 2. serialised
    assert.match(body, /pg_catalog\.pg_advisory_xact_lock\(/,
      `${fn} takes no lock, so two concurrent retries both proceed`);
    // 3. decided by an EXACT match, with the hash only as the lock key
    assert.ok(body.includes(`'finance:${action}:' || v_operation_id`),
      `${fn} does not scope its lock to its own module and action`);
    assert.match(body, /from public\.admin_activity_log l/, `${fn} consults no registry`);
    assert.match(body, /l\.operation_id = v_operation_id/,
      `${fn} does not compare the operation id exactly`);
    assert.ok(body.includes("l.module = 'finance'") && body.includes(`l.action = '${action}'`),
      `${fn} would match another module's or action's operation`);
    // 4. THE LOCK COMES BEFORE THE LOOKUP.
    assert.ok(body.indexOf("pg_advisory_xact_lock") < body.indexOf("from public.admin_activity_log l"),
      `${fn} looks before it locks, so a race can pass both callers`);
    /*
      AND THE AUDIT USES THE RESOLVED LOCAL, not a second coalesce. If it
      coalesced again it could mint a DIFFERENT uuid from the one the lock
      and the lookup used, which would defeat both.
    */
    assert.ok(body.includes("    v_operation_id,"),
      `${fn} does not pass the resolved operation id to the audit`);
    assert.equal((body.match(/coalesce\(p_operation_id/g) || []).length, 1,
      `${fn} resolves the operation id more than once`);
  }
});

test("3j: the registry is the append-only audit log, never a key on the row", () => {
  /*
    THE EDGE CASE THAT DECIDED THIS. Migration 050 puts a UNIQUE
    operation_id on inventory_movements, which is correct there because a
    stock movement is never deleted. An expense IS deletable, so a key on
    the row would vanish with it - and replaying the original create would
    silently resurrect a cost somebody removed on purpose.
  */
  assert.ok(!/operation_id/.test(
    MIGRATION.slice(MIGRATION.indexOf("create table if not exists public.business_expenses"),
                    MIGRATION.indexOf("business_expenses_vat_bounds_check"))),
    "071 puts an operation id on the expense row, which dies with the row");
  assert.ok(!/idempotency_key/.test(MIGRATION), "071 adds a row-level idempotency key");

  // The create writer resolves the prior event to an entity id and
  // returns whatever that entity is NOW - null if it was deleted.
  const create = MIGRATION.slice(
    MIGRATION.indexOf("function public.admin_record_business_expense("),
    MIGRATION.indexOf("$$;", MIGRATION.indexOf("function public.admin_record_business_expense(")));
  assert.match(create, /select l\.entity_id into v_prior_entity/);
  assert.match(create, /where id = v_prior_entity::uuid/);
  assert.ok(create.indexOf("v_prior_entity is not null")
            < create.indexOf("insert into public.business_expenses"),
    "the replay check runs after the insert, so a replay would duplicate");

  // 050's row-level pattern is still intact where it belongs.
  const m050 = read("supabase/migrations/050_inventory_foundation.sql");
  assert.match(m050, /create unique index if not exists idx_inventory_movements_operation/);
  // And nothing deletes a movement, which is why that works there.
  assert.ok(!/delete from public\.inventory_movements/.test(m050));
});

test("3k: a replay performs no second mutation", () => {
  // The update writer returns the row as it stands, without an UPDATE, so
  // updated_at does not advance and no second audit event is written.
  const upd = MIGRATION.slice(
    MIGRATION.indexOf("function public.admin_update_business_expense("),
    MIGRATION.indexOf("$$;", MIGRATION.indexOf("function public.admin_update_business_expense(")));
  assert.ok(upd.indexOf("v_prior_entity is not null") < upd.indexOf("update public.business_expenses"),
    "the update writer mutates before it checks for a replay");
  // The delete writer answers true without a second delete.
  const del = MIGRATION.slice(
    MIGRATION.indexOf("function public.admin_delete_business_expense("),
    MIGRATION.indexOf("$$;", MIGRATION.indexOf("function public.admin_delete_business_expense(")));
  assert.ok(del.indexOf("v_prior_entity is not null")
            < del.indexOf("delete from public.business_expenses"),
    "the delete writer deletes before it checks for a replay");
  // Reusing one operation id for a DIFFERENT expense is a misuse, not a
  // silent no-op: both row-scoped writers refuse it.
  for (const body of [upd, del]) {
    assert.match(body, /raise exception 'business_expense_operation_reused'/);
  }
});

test("3l: one user action gets one stable operation id, reused across retries", () => {
  /*
    THE UI HALF OF THE SAME GUARD. The first version called
    crypto.randomUUID() inside submit(), so a retry after a dropped
    response was a DIFFERENT operation - and the database would correctly
    have treated it as a second expense. The id has to be as stable as the
    intent is.
  */
  assert.match(UI, /const submitOpRef = useRef<string>\(""\);/);
  assert.match(UI, /const deleteOpRef = useRef<Record<string, string>>\(\{\}\);/);
  assert.match(UI, /if \(!submitOpRef\.current\) submitOpRef\.current = crypto\.randomUUID\(\);/);
  assert.match(UI, /operationId: submitOpRef\.current,/);
  assert.match(UI, /operationId: deleteOpRef\.current\[row\.id\],/);
  // Cleared when the intent changes or completes, kept on failure.
  assert.match(UI, /submitOpRef\.current = "";\s*\n\s*setEditing\(null\);/);
  assert.match(UI, /submitOpRef\.current = "";\s*\n\s*setEditing\(row\);/);
  assert.match(UI, /delete deleteOpRef\.current\[row\.id\];/);
  // No id is minted at call time any more.
  assert.ok(!/operationId: crypto\.randomUUID\(\)/.test(UI),
    "the screen still mints a fresh operation id per request");
  // And a double press cannot start a second request.
  assert.match(UI, /onClick=\{submit\} disabled=\{saving\}/);
});

test("3m: no heuristic duplicate detection anywhere", () => {
  /*
    Two real expenses may legitimately be identical - the same carrier
    charging the same amount on the same day for two parcels. Only the
    operation id may decide sameness.
  */
  for (const [name, src] of Object.entries({ ROUTE, UI, LIB })) {
    const code = codeOnly(src);
    for (const banned of ["isDuplicate", "looksLikeDuplicate", "sameAmount",
                          "alreadyExists", "findSimilar"]) {
      assert.ok(!code.includes(banned), `${name} guesses at duplicates with ${banned}`);
    }
  }
  // The route passes the id through and validates only its shape.
  assert.match(ROUTE, /UUID_RE\.test\(body\.operationId\.trim\(\)\)/);
  assert.match(ROUTE, /p_operation_id: operationId,/);
});

/* ══════════════════════════════════════════════════════════════
   4. THE ARITHMETIC — EXECUTED, NOT READ
   ══════════════════════════════════════════════════════════════ */

const PERIOD = { from: "2026-09-01", to: "2026-09-30" };

const order = (over = {}) => ({
  id: "o1",
  placedAt: "2026-09-15T10:00:00.000Z",
  customerType: "private",
  totalGrossCents: 2975,
  totalNetCents: 2500,
  taxTotalCents: 475,
  discountTotalCents: 0,
  shippingGrossCents: 595,
  refundedTotalCents: null,
  ...over,
});

const expense = (over = {}) => ({
  id: "e1",
  occurredOn: "2026-09-15",
  category: "matcha_cogs",
  orderId: "o1",
  grossCents: 900,
  /*
    DEFAULT null, deliberately: "not known" is the honest starting state
    for an input VAT, and a fixture that defaulted to 0 would make every
    test here accidentally assert the complete-VAT path.
  */
  vatCents: null,
  channel: "b2c",
  paymentStatus: "paid",
  ...over,
});

test("4: revenue is the orders' own frozen figures, summed and nothing else", () => {
  const s = buildFinanceSummary({ period: PERIOD, orders: [order()], expenses: [] });
  assert.equal(s.revenue.orderCount, 1);
  assert.equal(s.revenue.grossCents, 2975);
  assert.equal(s.revenue.netCents, 2500);
  assert.equal(s.revenue.taxCents, 475);
  assert.equal(s.revenue.customerPaidShippingCents, 595);
  assert.equal(s.revenue.refundedCents, 0);
  // NULL means "no figure was ever recorded", not "zero was refunded" -
  // migration 019 left it null for every order that predates it.
  assert.equal(s.revenue.ordersWithRefundFigure, 0);
  const withFigure = buildFinanceSummary({
    period: PERIOD, orders: [order({ refundedTotalCents: 0 })], expenses: [],
  });
  assert.equal(withFigure.revenue.ordersWithRefundFigure, 1);
});

test("4b: a refund is subtracted exactly once", () => {
  const s = buildFinanceSummary({
    period: PERIOD,
    orders: [order({ refundedTotalCents: 1000 })],
    expenses: [],
  });
  assert.equal(s.revenue.grossCents, 2975, "revenue was adjusted as well as refunded");
  assert.equal(s.revenue.refundedCents, 1000);
  // gross - refund - direct costs
  assert.equal(s.contributionMarginCents, 2975 - 1000 - 0);
});

test("4c: AN UNPAID ORDER IS NOT REVENUE", () => {
  /*
    placed_at is set to now() by the order writer ONLY when an order is
    created from a PAID checkout, so its absence means the order was
    never paid. Counting it would book a cart as revenue.
  */
  const s = buildFinanceSummary({
    period: PERIOD, orders: [order({ placedAt: null })], expenses: [],
  });
  assert.equal(s.revenue.orderCount, 0);
  assert.equal(s.revenue.grossCents, 0);
  assert.equal(orderFallsInPeriod(order({ placedAt: null }), PERIOD), false);
});

test("4d: CUSTOMER-PAID SHIPPING IS REVENUE AND IS NEVER A COST", () => {
  /*
    The one confusion that would silently invert a margin. The customer's
    shipping is already inside grossCents and is reported separately only
    so the screen can show it; the CARRIER's invoice is the cost, and it
    arrives as a 'shipping' expense row.
  */
  const noCost = buildFinanceSummary({ period: PERIOD, orders: [order()], expenses: [] });
  assert.equal(noCost.directCostsByCategory.shipping, 0,
    "customer-paid shipping was counted as a shipping cost");
  assert.equal(noCost.contributionMarginCents, 2975);

  const withCarrier = buildFinanceSummary({
    period: PERIOD,
    orders: [order()],
    expenses: [expense({ category: "shipping", grossCents: 420 })],
  });
  assert.equal(withCarrier.directCostsByCategory.shipping, 420);
  assert.equal(withCarrier.revenue.customerPaidShippingCents, 595,
    "the carrier's invoice changed what the customer paid");
  assert.equal(withCarrier.contributionMarginCents, 2975 - 420);
});

test("4e: a general expense belongs to the period and never to an order", () => {
  const s = buildFinanceSummary({
    period: PERIOD,
    orders: [order()],
    expenses: [
      expense({ id: "d", category: "packaging", grossCents: 120 }),
      expense({ id: "g", category: "general", orderId: null, grossCents: 4900 }),
    ],
  });
  assert.equal(s.generalExpensesCents, 4900);
  assert.equal(s.directCostsTotalCents, 120, "a general expense was counted as direct");
  // It is not in any direct category either.
  for (const c of DIRECT_EXPENSE_CATEGORIES) {
    assert.ok(s.directCostsByCategory[c] <= 120);
  }
  assert.equal(s.contributionMarginCents, 2975 - 120,
    "general expenses were subtracted from the contribution margin");
});

/* ══════════════════════════════════════════════════════════════
   5. WHAT IS UNKNOWN STAYS UNKNOWN
   ══════════════════════════════════════════════════════════════ */

test("5: with no costs at all, the margin is partial and the result is null", () => {
  const s = buildFinanceSummary({ period: PERIOD, orders: [order()], expenses: [] });
  assert.equal(s.isPartial, true);
  assert.equal(s.operatingResultCents, null,
    "an operating result was invented on top of costs nobody entered");
  assert.equal(s.completeness.ordersTotal, 1);
  assert.equal(s.completeness.ordersWithDirectCost, 0);
  assert.deepEqual(s.completeness.missingCategories, [...DIRECT_EXPENSE_CATEGORIES]);
  assert.equal(s.completeness.directCostsComplete, false);
});

test("5b: one missing COMPONENT is enough to keep it partial", () => {
  /*
    The subtle gap. Payment fees typically arrive on a provider statement
    a month later, so every order can carry four of the five costs and
    the margin is still an upper bound.
  */
  const all = DIRECT_EXPENSE_CATEGORIES
    .filter(c => c !== "payment_fee")
    .map((c, i) => expense({ id: `e${i}`, category: c, grossCents: 100 }));
  const s = buildFinanceSummary({ period: PERIOD, orders: [order()], expenses: all });
  assert.equal(s.completeness.ordersWithDirectCost, 1);
  assert.deepEqual(s.completeness.missingCategories, ["payment_fee"]);
  assert.equal(s.isPartial, true);
  assert.equal(s.operatingResultCents, null);
});

test("5c: and one uncovered ORDER is enough as well", () => {
  const complete = DIRECT_EXPENSE_CATEGORIES
    .map((c, i) => expense({ id: `e${i}`, category: c, grossCents: 100 }));
  const s = buildFinanceSummary({
    period: PERIOD,
    orders: [order(), order({ id: "o2" })],
    expenses: complete,
  });
  assert.equal(s.completeness.ordersTotal, 2);
  assert.equal(s.completeness.ordersWithDirectCost, 1);
  assert.equal(s.isPartial, true);
  assert.equal(s.operatingResultCents, null);
});

test("5d: only a genuinely complete period yields an operating result", () => {
  const complete = DIRECT_EXPENSE_CATEGORIES
    .map((c, i) => expense({ id: `e${i}`, category: c, grossCents: 100 }));
  const s = buildFinanceSummary({
    period: PERIOD,
    orders: [order()],
    expenses: [...complete, expense({ id: "g", category: "general", orderId: null, grossCents: 1000 })],
  });
  assert.equal(s.completeness.directCostsComplete, true);
  assert.equal(s.isPartial, false);
  assert.equal(s.directCostsTotalCents, 500);
  assert.equal(s.contributionMarginCents, 2975 - 500);
  assert.equal(s.operatingResultCents, 2975 - 500 - 1000);
});

test("5e: an EMPTY period is partial, not complete", () => {
  // Nothing earned and nothing spent is not a proven break-even.
  const s = buildFinanceSummary({ period: PERIOD, orders: [], expenses: [] });
  assert.equal(s.completeness.ordersTotal, 0);
  assert.equal(s.completeness.directCostsComplete, false);
  assert.equal(s.isPartial, true);
  assert.equal(s.operatingResultCents, null);
});

test("5f: the screen says so, above the figures rather than below them", () => {
  assert.match(UI, /\{s\.isPartial && \(/);
  assert.ok(UI.includes("Unvollständig."), "the screen never says it is incomplete");
  assert.ok(UI.includes("eine Obergrenze, kein Ergebnis"),
    "the screen does not say the margin is an upper bound");
  // The null result is rendered as a word, not as a zero.
  assert.match(UI, /s\.operatingResultCents === null/);
  assert.ok(UI.includes("unbekannt"), "an unknown result is shown as a number");
  // And the disclosure is rendered BEFORE the counts block.
  assert.ok(UI.indexOf("ops-costs-partial") < UI.indexOf('className="ops-counts"'),
    "the disclosure sits below the figures it qualifies");
});

test("5g: no tax accounting and no net profit is invented anywhere", () => {
  const lib = codeOnly(LIB);
  for (const banned of ["netProfit", "profitAfterTax", "vatOwed", "taxDue",
                        "* 0.19", "/ 1.19", "0.19"]) {
    assert.ok(!lib.includes(banned), `the summary derives tax with ${banned}`);
  }
  // Tax is reported as the frozen figure and used in no subtraction.
  assert.match(lib, /taxCents \+= order\.taxTotalCents/);
  assert.ok(!/taxCents\s*[-*/]/.test(lib), "tax is used in arithmetic");
  for (const banned of ["Gewinn", "Nettogewinn", "Steuerlast", "Umsatzsteuer schuld"]) {
    assert.ok(!UI.includes(banned), `the screen claims ${banned}`);
  }
});

/* ══════════════════════════════════════════════════════════════
   6. PERIOD BOUNDARIES
   ══════════════════════════════════════════════════════════════ */

test("6: a month is its own first and last day, and February is not 30 days", () => {
  assert.deepEqual(monthPeriod("2026-09-15"), { from: "2026-09-01", to: "2026-09-30" });
  assert.deepEqual(monthPeriod("2026-02-10"), { from: "2026-02-01", to: "2026-02-28" });
  assert.deepEqual(monthPeriod("2028-02-10"), { from: "2028-02-01", to: "2028-02-29" });
  assert.deepEqual(monthPeriod("2026-12-31"), { from: "2026-12-01", to: "2026-12-31" });
  assert.deepEqual(previousMonthPeriod("2026-01-15"), { from: "2025-12-01", to: "2025-12-31" });
  assert.deepEqual(previousMonthPeriod("2026-03-05"), { from: "2026-02-01", to: "2026-02-28" });
});

test("6b: both ends are inclusive", () => {
  for (const day of ["2026-09-01", "2026-09-30"]) {
    assert.equal(expenseFallsInPeriod(expense({ occurredOn: day }), PERIOD), true, day);
  }
  for (const day of ["2026-08-31", "2026-10-01"]) {
    assert.equal(expenseFallsInPeriod(expense({ occurredOn: day }), PERIOD), false, day);
  }
});

test("6c: an order belongs to the BERLIN day it was paid on", () => {
  /*
    An order paid at 00:30 Berlin time on 1 October is October revenue.
    Comparing the raw instant against a UTC boundary would file it under
    September, which is the kind of error that moves money between two
    reports and is invisible in both.
  */
  assert.equal(berlinDateOf("2026-09-30T22:30:00.000Z"), "2026-10-01");
  assert.equal(orderFallsInPeriod(order({ placedAt: "2026-09-30T22:30:00.000Z" }), PERIOD), false,
    "a Berlin-October order was counted as September revenue");
  assert.equal(berlinDateOf("2026-09-01T00:30:00.000Z"), "2026-09-01");
  assert.equal(orderFallsInPeriod(order({ placedAt: "2026-09-01T00:30:00.000Z" }), PERIOD), true);
  // Winter time, where Berlin is UTC+1 rather than UTC+2.
  assert.equal(berlinDateOf("2026-11-30T23:30:00.000Z"), "2026-12-01");
  assert.equal(berlinDateOf("garbage"), null);
});

test("6d: a period is validated, and a reversed one is refused", () => {
  assert.equal(validateFinancePeriod("2026-09-01", "2026-09-30").ok, true);
  assert.equal(validateFinancePeriod("2026-09-30", "2026-09-01").ok, false);
  assert.equal(validateFinancePeriod("2026-02-30", "2026-03-01").ok, false);
  assert.equal(validateFinancePeriod("nonsense", "2026-09-01").ok, false);
  assert.equal(validateFinancePeriod(null, undefined).ok, false);
  assert.equal(isIsoDate("2026-13-01"), false);
  assert.equal(isIsoDate("2026-09-31"), false);
  assert.equal(isIsoDate("2026-09-30"), true);
});

test("6e: the route widens the SQL window and lets the lib decide exactly", () => {
  // The window must be wider than the answer, or a Berlin-day order at
  // the edge is clipped before the lib can place it.
  assert.match(ROUTE, /from\.setUTCDate\(from\.getUTCDate\(\) - 1\)/);
  assert.match(ROUTE, /to\.setUTCDate\(to\.getUTCDate\(\) \+ 2\)/);
  assert.match(ROUTE, /buildFinanceSummary\(\{ period: period\.period, orders, expenses \}\)/);
});

/* ══════════════════════════════════════════════════════════════
   7. THE B2C / B2B SPLIT
   ══════════════════════════════════════════════════════════════ */

test("7: the split uses the order's own customer_type and adds up", () => {
  const s = buildFinanceSummary({
    period: PERIOD,
    orders: [order(), order({ id: "o2", customerType: "business", totalGrossCents: 10000 })],
    expenses: [],
  });
  assert.equal(s.b2c.orderCount, 1);
  assert.equal(s.b2b.orderCount, 1);
  assert.equal(s.b2c.grossCents, 2975);
  assert.equal(s.b2b.grossCents, 10000);
  assert.equal(s.b2c.grossCents + s.b2b.grossCents, s.revenue.grossCents);
  // An unknown customer type counts as private rather than vanishing.
  const odd = buildFinanceSummary({
    period: PERIOD, orders: [order({ customerType: "" })], expenses: [],
  });
  assert.equal(odd.b2c.orderCount, 1);
  assert.equal(odd.revenue.grossCents, odd.b2c.grossCents + odd.b2b.grossCents);
});

/* ══════════════════════════════════════════════════════════════
   8. THE ROUTE'S INPUT SURFACE
   ══════════════════════════════════════════════════════════════ */

test("8: no COMPUTED figure is ever accepted from a browser", () => {
  /*
    AN INPUT IS NOT A RESULT, and the distinction is the whole point.

    body.grossCents and body.vatCents ARE read - they are what the
    operator typed off a supplier document, and there is nowhere else they
    could come from. What may never arrive from a browser is anything this
    module DERIVES: a total, a margin, an operating result, a completeness
    flag. Those are computed server-side from durable rows, so a screen
    cannot post a Deckungsbeitrag of its own choosing.
  */
  const code = codeOnly(ROUTE);
  for (const banned of ["body.contributionMargin", "body.summary", "body.total",
                        "body.isPartial", "body.operatingResult",
                        "body.directCostsTotal", "body.expenseVat", "body.byChannel",
                        "body.netCents", "body.openExpenses"]) {
    assert.ok(!code.includes(banned), `the route reads the derived ${banned}`);
  }
  // The figures it DOES take are the two off the document, and both are
  // validated as integer cents before they reach a writer.
  assert.match(code, /const amount = body\.grossCents;/);
  assert.match(code, /body\.vatCents !== undefined && body\.vatCents !== null/);
  // The client's whole influence on a derived figure is the period.
  assert.match(code, /validateFinancePeriod\(body\.from, body\.to\)/);
  // And the summary is built here, from rows, not from the request.
  assert.match(code, /buildFinanceSummary\(\{ period: period\.period, orders, expenses \}\)/);
});

test("8e: VAT validation keeps unknown and zero apart, and bounds the known", () => {
  // Absent means unknown; a number means known, 0 included.
  assert.match(ROUTE, /let vatCents: number \| null = null;/);
  assert.match(ROUTE, /if \(vat > amount\)/);
  assert.match(ROUTE, /!Number\.isInteger\(vat\) \|\| vat < 0/);
  // The form asks whether it is known BEFORE asking how much, so the two
  // are never one keystroke apart.
  assert.match(UI, /value=\{fVatKnown \? "known" : "unknown"\}/);
  assert.match(UI, /let vatCents: number \| null = null;/);
  assert.ok(UI.includes("Vorsteuer unbekannt"),
    "the screen has no words for an unknown VAT");
});

test("8f: the channel and payment status are validated, not invented", () => {
  assert.match(ROUTE, /isExpenseChannel\(body\.channel\)/);
  assert.match(ROUTE, /isExpensePaymentStatus\(body\.paymentStatus\)/);
  /*
    AND THE ROUTE DOES NOT DECIDE THE CHANNEL. For an order-linked cost
    migration 071's writer derives it; this route only checks the shape.
    A route that resolved it itself would be a second authority, and the
    one inside the database is the one every caller gets.
  */
  /*
    THE ROUTE DOES SELECT customer_type - it is how revenue is split B2C
    from B2B, and that read is unrelated. What it must not do is MAP it to
    a channel: no 'business' -> 'b2b' anywhere here, because that mapping
    is the writer's and a second copy of it is a second authority.
  */
  const code = codeOnly(ROUTE);
  assert.ok(!/["']business["']\s*(\?|:|===)/.test(code)
            && !code.includes("b2b\"") && !code.includes("'b2b'"),
    "the route maps a customer type to a channel instead of leaving it to the writer");
  // The writer's own refusal for a missing order is mapped to a sentence.
  assert.match(ROUTE, /business_expense_order_missing/);
});

test("8b: an amount must be a positive integer, and is bounded", () => {
  assert.match(ROUTE, /!Number\.isInteger\(amount\)/);
  assert.match(ROUTE, /amount <= 0/);
  assert.match(ROUTE, /amount > MAX_AMOUNT_CENTS/);
  assert.ok(UI.includes("Bruttobetrag in Cent"),
    "the form does not ask for a gross amount in cents");
  assert.ok(!UI.includes("Nettobetrag"), "the form asks the operator to type net");
  // The form posts cents, so nothing parses a decimal on either side.
  assert.ok(!/parseFloat|toFixed\(2\)/.test(codeOnly(UI)),
    "the finance form parses a decimal amount");
});

test("8c: the route refuses the two combinations the CHECK refuses", () => {
  assert.match(ROUTE, /body\.category === "general" && orderId/);
  assert.match(ROUTE, /body\.category !== "general" && !orderId/);
  // And the UI never offers them: the order field appears only for a
  // direct cost.
  assert.match(UI, /\{fCategory !== "general" && \(/);
});

test("8d: it reaches no payment provider and sends no mail", () => {
  for (const banned of ["stripe", "Stripe", "resend", "Resend", "emails.send"]) {
    assert.ok(!ROUTE.includes(banned), `the costs route reaches ${banned}`);
  }
  // And it writes nothing but expenses.
  const rpcs = [...ROUTE.matchAll(/admin\.rpc\(\s*\n?\s*(?:isUpdate \?\s*)?"([a-z_]+)"/g)].map(m => m[1]);
  for (const rpc of rpcs) {
    assert.ok(rpc.includes("business_expense"), `the route calls ${rpc}`);
  }
});

test("8g: the contribution margin subtracts the GROSS expense figure", () => {
  // Gross revenue minus refunds minus gross direct costs. Nothing here
  // nets anything down first, which is why the column had to be named.
  const s = buildFinanceSummary({
    period: PERIOD,
    orders: [order({ refundedTotalCents: 500 })],
    expenses: [expense({ grossCents: 1190, vatCents: 190 })],
  });
  assert.equal(s.directCostsTotalCents, 1190, "the margin used a net expense figure");
  assert.equal(s.contributionMarginCents, 2975 - 500 - 1190);
  // The known VAT is reported, and it is NOT subtracted anywhere.
  assert.equal(s.expenseVat.knownCents, 190);
  assert.equal(s.contributionMarginCents + 190, 2975 - 500 - 1000,
    "the VAT was netted off the cost instead of being reported beside it");
});

test("8h: expense VAT is summed only where it is known, with its coverage", () => {
  const s = buildFinanceSummary({
    period: PERIOD,
    orders: [order()],
    expenses: [
      expense({ id: "a", grossCents: 1190, vatCents: 190 }),
      expense({ id: "b", grossCents: 1000, vatCents: 0, category: "packaging" }),
      expense({ id: "c", grossCents: 5000, vatCents: null, category: "shipping" }),
    ],
  });
  // 190 + 0, and the null contributes nothing.
  assert.equal(s.expenseVat.knownCents, 190);
  // A KNOWN ZERO COUNTS AS KNOWN - that is the whole reason the column is
  // nullable rather than defaulting to 0.
  assert.equal(s.expenseVat.rowsWithVat, 2);
  assert.equal(s.expenseVat.rowsTotal, 3);
  assert.equal(s.expenseVat.complete, false);
  // All three gross figures are still in the cost total.
  assert.equal(s.directCostsTotalCents, 1190 + 1000 + 5000);
});

test("8i: VAT coverage is complete only when every row carries a figure", () => {
  const complete = buildFinanceSummary({
    period: PERIOD, orders: [order()],
    expenses: [expense({ vatCents: 0 }), expense({ id: "b", vatCents: 7, category: "packaging" })],
  });
  assert.equal(complete.expenseVat.complete, true);
  // AN EMPTY PERIOD IS NOT COMPLETE. Nothing recorded is not a verified
  // zero, and a screen that called it complete would claim one.
  const empty = buildFinanceSummary({ period: PERIOD, orders: [order()], expenses: [] });
  assert.equal(empty.expenseVat.complete, false);
  assert.equal(empty.expenseVat.rowsTotal, 0);
  assert.equal(empty.expenseVat.knownCents, 0);
});

test("8j: costs split by channel, and the split adds up", () => {
  const s = buildFinanceSummary({
    period: PERIOD,
    orders: [order()],
    expenses: [
      expense({ id: "a", grossCents: 900, channel: "b2c" }),
      expense({ id: "b", grossCents: 120, channel: "b2b", category: "packaging" }),
      expense({ id: "c", grossCents: 700, channel: "event", category: "general", orderId: null }),
      expense({ id: "d", grossCents: 4900, channel: "internal", category: "general", orderId: null }),
    ],
  });
  assert.equal(s.byChannel.b2c.directCents, 900);
  assert.equal(s.byChannel.b2b.directCents, 120);
  assert.equal(s.byChannel.event.generalCents, 700);
  assert.equal(s.byChannel.internal.generalCents, 4900);
  // Direct and general stay apart inside a channel, and both land in its total.
  assert.equal(s.byChannel.event.directCents, 0);
  assert.equal(s.byChannel.internal.totalCents, 4900);
  // Every channel appears, at zero where it has nothing.
  for (const ch of EXPENSE_CHANNELS) assert.ok(s.byChannel[ch], `${ch} is missing`);
  // And the four channels sum to the two period totals.
  const summed = EXPENSE_CHANNELS.reduce((n, ch) => n + s.byChannel[ch].totalCents, 0);
  assert.equal(summed, s.directCostsTotalCents + s.generalExpensesCents);
});

test("8k: an OPEN expense is reported but never excluded from a total", () => {
  /*
    This is a cost ledger, not cash-flow accounting. A margin that dropped
    unpaid invoices would change whenever somebody got round to paying
    one, which is the opposite of a frozen figure.
  */
  const paid = buildFinanceSummary({
    period: PERIOD, orders: [order()],
    expenses: [expense({ grossCents: 900, paymentStatus: "paid" })],
  });
  const open = buildFinanceSummary({
    period: PERIOD, orders: [order()],
    expenses: [expense({ grossCents: 900, paymentStatus: "open" })],
  });
  assert.equal(open.directCostsTotalCents, paid.directCostsTotalCents);
  assert.equal(open.contributionMarginCents, paid.contributionMarginCents);
  // Reported separately, so the screen can show what is outstanding.
  assert.equal(open.openExpenses.cents, 900);
  assert.equal(open.openExpenses.rows, 1);
  assert.equal(paid.openExpenses.cents, 0);
});

test("8l: the screen filters the LEDGER and never the totals", () => {
  // Two different Deckungsbeiträge depending on which dropdown is open
  // would be worse than no filter at all.
  assert.match(UI, /const visible = expenses\.filter\(e =>/);
  assert.match(UI, /channelFilter === "all" \|\| e\.channel === channelFilter/);
  assert.match(UI, /statusFilter === "all" \|\| e\.paymentStatus === statusFilter/);
  // The totals come from the summary, which is computed for the PERIOD.
  assert.ok(!/visible\.reduce|visible\.length \* /.test(UI),
    "the screen computes a total from the filtered list");
  assert.match(UI, /\{visible\.length\} von \{expenses\.length\} Positionen/);
});

/* ══════════════════════════════════════════════════════════════
   9. THE SCREEN IS REAL
   ══════════════════════════════════════════════════════════════ */

test("9: the Kosten tab opens the finance screen and is no longer 'bald'", () => {
  assert.match(SHELL, /\["costs", "Kosten"\]/);
  assert.match(SHELL, /import \{ AdminCosts \} from "\.\/AdminCosts"/);
  assert.match(SHELL, /costs: "Kosten"/);
  // The "bald" list is empty rather than deleted.
  assert.match(SHELL, /\(\[\] as string\[\]\)\.map/);
  assert.ok(!/\["Kosten"\]\.map/.test(SHELL), "Kosten is still advertised as coming");
});

test("9b: it offers a period filter and a cost breakdown", () => {
  for (const option of ["Aktueller Monat", "Vorheriger Monat", "Eigener Zeitraum"]) {
    assert.ok(UI.includes(option), `the screen has no ${option} filter`);
  }
  // The German labels come from the shared constant rather than being
  // retyped in the markup, so the screen and the breakdown cannot drift.
  assert.ok(UI.includes("EXPENSE_CATEGORY_LABEL"),
    "the screen retypes the category labels");
  for (const label of Object.values(EXPENSE_CATEGORY_LABEL)) {
    assert.ok(!UI.includes(`"${label}"`),
      `the screen hardcodes the label ${label}`);
  }
  // The breakdown names every direct category, from the shared constant.
  assert.match(UI, /DIRECT_EXPENSE_CATEGORIES\.map/);
  // And it distinguishes a real zero from an unrecorded component.
  assert.ok(UI.includes("nicht erfasst"), "a missing component reads as zero");
  // The channel table, from the shared constant.
  assert.match(UI, /EXPENSE_CHANNELS\.map/);
  assert.ok(UI.includes("Kosten nach Kanal"), "the screen has no channel breakdown");
  /*
    AND IT SAYS WHY THE CHANNEL TABLE IS COST-ONLY. orders.customer_type
    knows only private and business, so Event has costs and no revenue
    side - and claiming otherwise would be the dishonest half of a
    channel P&L.
  */
  assert.ok(UI.includes("eine Bestellung kennt keinen"),
    "the screen does not disclose that revenue has no Event channel");
});

test("9b2: the ledger shows gross, VAT, net and status - and never a fake zero", () => {
  for (const header of ["Brutto", "Vorsteuer", "Netto", "Status", "Kanal"]) {
    assert.ok(UI.includes(`<th>${header}</th>`), `the ledger has no ${header} column`);
  }
  // An unknown VAT is words in BOTH places it can appear.
  assert.match(UI, /row\.vatCents === null\s*\?\s*<i className="ops-costs-unknown">\{VAT_UNKNOWN\}/);
  assert.match(UI, /s\.expenseVat\.rowsWithVat === 0/);
  // Net comes from the shared leaf, which returns null rather than guessing.
  assert.match(UI, /const net = expenseNetCents\(row\);/);
  assert.match(UI, /net === null/);
  // The channel shown is the STORED one, not anything the form chose.
  assert.match(UI, /EXPENSE_CHANNEL_LABEL\[row\.channel\]/);
  // For a direct cost the form offers no channel at all.
  assert.match(UI, /Kanal wird aus der Bestellung bestimmt/);
});

test("9c: the ledger offers create, change and remove, and says it is audited", () => {
  assert.match(UI, /action: editing \? "update_expense" : "record_expense"/);
  assert.match(UI, /action: "delete_expense"/);
  assert.ok(UI.includes("Ändern") && UI.includes("Entfernen"));
  assert.ok(UI.includes("Aktivitätsprotokoll"),
    "the screen does not say that changes are audited");
  // Its styles exist, so the honesty markers are visible rather than
  // merely present.
  for (const rule of [".ops-costs-partial{", ".ops-costs-unknown{", ".ops-costs-flag{"]) {
    assert.ok(CSS.includes(rule), `${rule} is missing`);
  }
});

/* ══════════════════════════════════════════════════════════════
   10. THE CHECK FILES
   ══════════════════════════════════════════════════════════════ */

test("10: both check files are exactly one read-only statement", () => {
  for (const [name, src] of Object.entries({ PREFLIGHT, POSTCHECK })) {
    const code = codeOnly(src).replace(/'[^']*'/g, "''");
    assert.equal(code.split(";").length - 1, 1, `${name} is not one statement`);
    for (const banned of ["insert", "update", "delete", "create", "drop", "alter",
                          "grant", "revoke", "truncate", "begin", "commit"]) {
      assert.ok(!new RegExp(`\\b${banned}\\b`, "i").test(code),
        `${name} contains ${banned} outside a string literal`);
    }
  }
});

test("10b: each states the result it expects, and they differ", () => {
  assert.match(PREFLIGHT, /EXPECTED HEALTHY RESULT:\s+0 FAIL \/ 11 PASS \/ 3 INFO/);
  assert.match(POSTCHECK, /EXPECTED HEALTHY RESULT:\s+0 FAIL \/ 18 PASS \/ 3 INFO/);
  assert.ok(PREFLIGHT.includes("SAFE TO APPLY"));
  assert.ok(POSTCHECK.includes("APPLIED CLEANLY"));
  // The preflight asks whether 071 is ABSENT; the postcheck assumes it.
  assert.match(PREFLIGHT, /the business_expenses table does not exist yet/);
  assert.match(POSTCHECK, /all fifteen business_expenses columns are present/);
});

test("10c: the postcheck verifies the things only a function body can tell", () => {
  /*
    Every other check in that file would pass against a 071 whose writers
    raise, duplicate on retry, trust a caller's channel or audit half a
    record. These four are the ones that read prosrc.
  */
  // THE MUTATION guard, not merely an audited one.
  assert.match(POSTCHECK, /the MUTATION is idempotent per operation id, not just the audit row/);
  assert.match(POSTCHECK, /pg_advisory_xact_lock/);
  assert.match(POSTCHECK, /l\.operation_id = v_operation_id/);
  // the lock before the lookup, asserted positionally
  assert.match(POSTCHECK, /pg_catalog\.strpos\(f\.prosrc, 'pg_advisory_xact_lock'\)/);
  // the registry survives a deletion
  assert.match(POSTCHECK, /cannot resurrect a deleted expense/);
  assert.match(POSTCHECK, /column_name in \('operation_id', 'idempotency_key'\)\) = 0/);
  // the channel is derived, and the audit is complete
  assert.match(POSTCHECK, /every writer audits under module finance/);
  assert.match(POSTCHECK, /DERIVE the channel of an order-linked cost/);
  assert.match(POSTCHECK, /complete enough to reconstruct the record/);
  // And that 071 wrote no row of its own.
  assert.match(POSTCHECK, /071 inserted no expense of its own/);
});

/* ══════════════════════════════════════════════════════════════
   11. IT IS PENDING
   ══════════════════════════════════════════════════════════════ */

test("11: 071 is declared pending in exactly one place, and is the newest", () => {
  const guard = read("tests/b2b-pending-agreement-writer.test.mjs");
  assert.match(guard, /const PENDING = "071_business_expenses\.sql";/,
    "071 is not declared as the pending migration");
  assert.match(guard, /const appliedFiles = onDisk\.filter\(f => f !== PENDING\);/);
  // Exactly one may be pending, and it has to be last.
  assert.match(guard, /the pending migration is not the newest one - the declaration is stale/);
});

test("11b: this suite is registered, so it actually runs", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.ok(pkg.scripts.test.includes("tests/business-expenses-migration.test.mjs"),
    "this suite is not in the test script");
});
