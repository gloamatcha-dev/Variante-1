import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Block 1 — 072 security invariants and inventory boundary tests.
 *
 * Source-level checks. No database, no network, no email.
 *
 * CRITICAL CONSTRAINTS:
 * - Keep inventory 100% manually quantity-mutated
 * - No arbitrary creator id or commission amount from the browser
 * - Do not make the browser authoritative for Finance totals
 * - Every SECURITY DEFINER function has search_path = ''
 * - Every 072 function is granted to service_role only
 */

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf-8");

const migration072 = read("supabase/migrations/072_admin_core_connections.sql");

/* ── SECURITY DEFINER + search_path = '' ───────────────────────── */

const EXPECTED_FUNCTIONS = [
  "financial_event_berlin_date",
  "order_is_annual_delivery",
  "order_subscription_id",
  "record_order_payment_event",
  "record_annual_prepayment_event",
  "record_b2b_settlement_event",
  "record_order_refund_event",
  "record_annual_plan_refund_event",
  "record_payment_fee_event",
  "admin_decide_annual_termination",
  "admin_execute_subscription_termination",
  "order_shipping_due",
  "claim_annual_purchase_notification",
  "mark_annual_purchase_notification",
  "resolve_affiliate_link",
  "resolve_affiliate_code",
  "record_affiliate_click",
  "order_commission_base_cents",
  "attribute_order_to_creator",
  "reverse_creator_commission_for_refund",
  "creator_commission_balance",
];

test("072: every function is SECURITY DEFINER with search_path = ''", () => {
  for (const fn of EXPECTED_FUNCTIONS) {
    const pattern = new RegExp(
      `function public\\.${fn}[\\s\\S]*?security definer[\\s\\S]*?set search_path\\s*=\\s*''`,
      "i"
    );
    assert.match(migration072, pattern,
      `${fn} must be SECURITY DEFINER with search_path = ''`);
  }
});

test("072: the REVOKE/GRANT block covers all 072 functions for service_role only", () => {
  for (const fn of EXPECTED_FUNCTIONS) {
    assert.ok(migration072.includes(`'${fn}'`),
      `${fn} must appear in the REVOKE/GRANT block`);
  }
  assert.match(migration072, /grant execute on function.*to service_role/,
    "functions must be granted to service_role");
  assert.match(migration072, /revoke all on function.*from public, anon, authenticated/,
    "functions must be revoked from public, anon, authenticated");
});

/* ── financial_events append-only trigger ──────────────────────── */

test("072: financial_events has an append-only trigger preventing UPDATE and DELETE", () => {
  assert.match(migration072, /financial_events_append_only/,
    "the append-only trigger must exist");
  assert.match(migration072, /before update or delete on public\.financial_events/,
    "the trigger must fire on UPDATE and DELETE");
  assert.match(migration072, /TG_OP/,
    "the trigger function must reference TG_OP");
});

/* ── Integer cents, no floating point ──────────────────────────── */

test("072: financial_events money columns are integer, never numeric or real", () => {
  const tableStart = migration072.indexOf("create table if not exists public.financial_events");
  const tableEnd = migration072.indexOf(");", tableStart) + 2;
  const tableDef = migration072.slice(tableStart, tableEnd);
  // The three _cents columns must be declared as integer.
  for (const col of ["gross_cents", "net_cents", "tax_cents"]) {
    const colPattern = new RegExp(`${col}\\s+integer`, "i");
    assert.match(tableDef, colPattern,
      `financial_events.${col} must be declared as integer`);
  }
  // None of them may be numeric, real, or double precision.
  for (const bad of ["numeric", "real", "double precision", "float"]) {
    const badPattern = new RegExp(`_cents\\s+${bad}`, "i");
    assert.ok(!badPattern.test(tableDef),
      `financial_events must not use ${bad} for money`);
  }
});

/* ── Inventory boundary: no 072 function mutates inventory ─────── */

test("072: no function in migration 072 mutates inventory_levels", () => {
  // Split into individual function bodies.
  const functions = migration072.split(/create or replace function public\./);
  for (const fn of functions.slice(1)) {
    const fnName = fn.match(/^(\w+)/)?.[1] ?? "unknown";
    const fnBody = fn.slice(0, fn.indexOf("$$;") + 3);
    assert.ok(!fnBody.includes("inventory_levels") ||
      fnBody.includes("select") && !fnBody.includes("update public.inventory_levels") && !fnBody.includes("insert into public.inventory_levels"),
      `${fnName} must not mutate inventory_levels`);
  }
});

test("072: no lib wrapper references inventory", () => {
  const wrappers = [
    "lib/financeRecording.ts",
    "lib/terminationAdmin.ts",
    "lib/shippingDue.ts",
    "lib/annualPurchaseNotification.ts",
    "lib/creatorAffiliate.ts",
  ];
  for (const file of wrappers) {
    const src = read(file);
    assert.ok(!src.includes("inventory"),
      `${file} must not reference inventory`);
  }
});

/* ── No browser-authoritative finance totals ───────────────────── */

test("072: finance RPCs compute amounts from the database, not from parameters", () => {
  // The finance recording functions take only IDs, never cent amounts
  // (except the refund and fee functions, which take verified amounts).
  const fns = [
    "record_order_payment_event",
    "record_annual_prepayment_event",
    "record_b2b_settlement_event",
  ];
  for (const fn of fns) {
    const fnStart = migration072.indexOf(`function public.${fn}`);
    const fnEnd = migration072.indexOf("$$;", fnStart) + 3;
    const fnBody = migration072.slice(fnStart, fnEnd);
    const params = fnBody.match(/\(\s*([\s\S]*?)\)/)?.[1] ?? "";
    assert.ok(!params.includes("_cents"),
      `${fn} must not accept a cents parameter — it reads from the DB`);
  }
});

/* ── Admin routes require authentication ───────────────────────── */

test("072: all new admin routes require requireAdminIdentity", () => {
  const adminRoutes = [
    "app/api/admin/finance/route.ts",
    "app/api/admin/shipping/route.ts",
    "app/api/admin/creators/route.ts",
    "app/api/admin/documents/route.ts",
    "app/api/admin/dashboard-summary/route.ts",
  ];
  for (const route of adminRoutes) {
    const src = read(route);
    assert.match(src, /requireAdminIdentity/,
      `${route} must use requireAdminIdentity`);
  }
});

test("072: the public affiliate routes do NOT use admin authentication", () => {
  const publicRoutes = [
    "app/api/affiliate/route.ts",
    "app/r/[slug]/route.ts",
  ];
  for (const route of publicRoutes) {
    const src = read(route);
    assert.ok(!src.includes("requireAdminIdentity"),
      `${route} must be public, not admin-gated`);
    assert.ok(!src.includes("requireAuth"),
      `${route} must be unauthenticated`);
  }
});

/* ── No new tables reference creator_id from the browser ──────── */

test("072: order_attributions.creator_id comes from the server, never the browser", () => {
  const attrFnStart = migration072.indexOf("function public.attribute_order_to_creator");
  const attrFnEnd = migration072.indexOf("$$;", attrFnStart) + 3;
  const attrFn = migration072.slice(attrFnStart, attrFnEnd);
  // The function receives source and reference, not creator_id.
  const params = attrFn.match(/\(\s*([\s\S]*?)\)\s*$/m)?.[0] ?? "";
  assert.ok(!params.includes("p_creator_id"),
    "attribute_order_to_creator must not accept a creator_id parameter");
});

/* ── 072 self-check block exists ───────────────────────────────── */

test("072: the migration has a DO $$ self-check block verifying all objects", () => {
  assert.match(migration072, /do \$\$/i,
    "migration must have a self-check block");
  assert.match(migration072, /072: tables missing/,
    "self-check must verify tables");
  assert.match(migration072, /072: writers missing/,
    "self-check must verify functions");
  assert.match(migration072, /072: additive columns missing/,
    "self-check must verify additive columns");
});
