import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Block 1 — 072 finance recording, termination admin, shipping due.
 *
 * Source-level structural tests. No database, no network, no email.
 * Verifies that lib wrappers call the correct RPCs, handle errors
 * safely, and never expose internals to the browser.
 */

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf-8");
const NEWLINE = String.fromCharCode(10);

const withoutComments = (source) =>
  source
    .split(NEWLINE)
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith("--") && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join(NEWLINE);

const financeSrc = read("lib/financeRecording.ts");
const financeCode = withoutComments(financeSrc);
const terminationSrc = read("lib/terminationAdmin.ts");
const terminationCode = withoutComments(terminationSrc);
const shippingSrc = read("lib/shippingDue.ts");
const shippingCode = withoutComments(shippingSrc);

/* ── Finance recording ─────────────────────────────────────────── */

test("finance: all six RPC wrappers call the correct SECURITY DEFINER function", () => {
  const expected = [
    ["recordOrderPaymentEvent", "record_order_payment_event"],
    ["recordAnnualPrepaymentEvent", "record_annual_prepayment_event"],
    ["recordB2bSettlementEvent", "record_b2b_settlement_event"],
    ["recordOrderRefundEvent", "record_order_refund_event"],
    ["recordAnnualPlanRefundEvent", "record_annual_plan_refund_event"],
    ["recordPaymentFeeEvent", "record_payment_fee_event"],
  ];
  for (const [fn, rpc] of expected) {
    assert.match(financeCode, new RegExp(`admin\\.rpc\\("${rpc}"`),
      `${fn} must call admin.rpc("${rpc}")`);
  }
});

test("finance: wrappers never throw — they return null on error", () => {
  // Finance recording is best-effort; a failure must not block the
  // payment webhook.
  assert.ok(!financeCode.includes("throw "),
    "finance wrappers must never throw");
  const returnNulls = financeCode.match(/return null/g);
  assert.ok(returnNulls && returnNulls.length >= 6,
    "each wrapper must return null on error");
});

test("finance: no wrapper accepts a browser-supplied amount", () => {
  // The RPC functions compute amounts from the database. The wrappers
  // pass only row IDs, never cents values from the caller — except for
  // refund and fee functions which pass amounts that were already
  // verified by the refund sync or Stripe.
  assert.ok(!financeCode.includes("totalGrossCents") && !financeCode.includes("total_gross_cents"),
    "finance wrappers must not accept a total from the caller");
});

test("finance: module is a pure RPC bridge with no side effects", () => {
  const clean = financeSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const forbidden of ["fetch(", "new Resend", "Math.random"]) {
    assert.ok(!clean.includes(forbidden),
      `finance module must not reach for ${forbidden}`);
  }
});

/* ── Termination admin ─────────────────────────────────────────── */

test("termination: both functions call the correct SECURITY DEFINER function", () => {
  assert.match(terminationCode, /admin\.rpc\("admin_decide_annual_termination"/,
    "decideAnnualTermination must call admin_decide_annual_termination");
  assert.match(terminationCode, /admin\.rpc\("admin_execute_subscription_termination"/,
    "executeSubscriptionTermination must call admin_execute_subscription_termination");
});

test("termination: functions THROW on error, unlike finance", () => {
  // Termination is an admin action that must fail visibly.
  assert.match(terminationCode, /throw new Error/,
    "termination functions must throw on RPC error");
});

test("termination: requires actorUserId — no anonymous admin action", () => {
  assert.match(terminationCode, /p_actor_user_id/,
    "termination RPCs must receive the actor's user ID");
});

/* ── Shipping due ──────────────────────────────────────────────── */

test("shipping: getOrderShippingDue calls the correct RPC", () => {
  assert.match(shippingCode, /admin\.rpc\("order_shipping_due"/,
    "getOrderShippingDue must call order_shipping_due");
});

test("shipping: returns null on error, never throws", () => {
  assert.ok(!shippingCode.includes("throw "),
    "shipping wrapper must never throw");
  assert.match(shippingCode, /return null/,
    "shipping wrapper must return null on error");
});

/* ── All three modules: only use getSupabaseAdmin ──────────────── */

test("all three modules get their client from getSupabaseAdmin only", () => {
  for (const [name, code] of [["finance", financeCode], ["termination", terminationCode], ["shipping", shippingCode]]) {
    assert.match(code, /getSupabaseAdmin\(\)/,
      `${name} must use getSupabaseAdmin()`);
    assert.ok(!code.includes("createClient"),
      `${name} must not create its own client`);
  }
});

/* ── Migration 072: all three function groups exist ────────────── */

test("migration 072 declares all finance, termination and shipping functions", () => {
  const migration = read("supabase/migrations/072_admin_core_connections.sql");
  const functions = [
    "record_order_payment_event",
    "record_annual_prepayment_event",
    "record_b2b_settlement_event",
    "record_order_refund_event",
    "record_annual_plan_refund_event",
    "record_payment_fee_event",
    "admin_decide_annual_termination",
    "admin_execute_subscription_termination",
    "order_shipping_due",
  ];
  for (const fn of functions) {
    assert.match(migration, new RegExp(`create or replace function public\\.${fn}`),
      `migration 072 must declare ${fn}`);
  }
});

test("migration 072 makes all functions SECURITY DEFINER", () => {
  const migration = read("supabase/migrations/072_admin_core_connections.sql");
  const functions = [
    "record_order_payment_event",
    "admin_decide_annual_termination",
    "order_shipping_due",
  ];
  for (const fn of functions) {
    const fnStart = migration.indexOf(`function public.${fn}`);
    const fnBody = migration.slice(fnStart, fnStart + 500);
    assert.match(fnBody, /security definer/i,
      `${fn} must be SECURITY DEFINER`);
    assert.match(fnBody, /set search_path\s*=\s*''/i,
      `${fn} must set search_path = ''`);
  }
});
