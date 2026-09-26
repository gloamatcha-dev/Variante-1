import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  B2B_ANNUAL_DELIVERY_COUNT,
  B2B_INSTALMENT_COUNTS,
  B2B_SELF_SERVICE_MAX_PACKS,
  B2B_MIN_PACKS,
  allocateInstalments,
  annualProductNetCents,
} from "../lib/b2bPricingRules.ts";
import {
  B2B_BERLIN_ELIGIBILITY_VERSION,
  resolveB2bBerlinEligibility,
} from "../lib/b2bBerlinEligibility.ts";
import {
  B2B_SHIPPING_RULES_VERSION,
  DHL_DE_TARIFFS,
  resolveB2bShipping,
} from "../lib/b2bShippingRules.ts";
import {
  NET_ORIGIN_TAX_CALCULATION_VERSION,
  TAX_CATEGORY_RATE_PERCENT,
  addTaxToNet,
} from "../lib/tax.ts";

/**
 * 060 — B2B PAYMENT SCHEDULE AND DELIVERY FOUNDATION.
 *
 * 059 gave the agreement its plan and its price. 060 gives it the two
 * schedules - what is owed, and what was supplied - and the cross-table
 * integrity that could not be written until those tables existed.
 *
 * ── WHAT THIS SUITE IS PROTECTING ─────────────────────────────
 *
 *   1. THE CHILDREN DO NOT RESTATE THE PARENT. instalment_count lives on
 *      the agreement and plan_type lives on the agreement; a copy on a
 *      child row would be the one that disagrees. Each is asserted
 *      ABSENT.
 *
 *   2. DELIVERY ROWS ARE HISTORY, NOT A MIRROR. Nothing in 060 may
 *      compare a delivery's quantity, routing or address against the
 *      agreement's CURRENT values - that is what makes a delivery
 *      survive a later quantity or address change. The integrity
 *      function is read column by column to prove it never looks.
 *
 *   3. THE SNAPSHOTS ARE THE TYPESCRIPT'S. The required key sets are
 *      derived by CALLING resolveB2bShipping and
 *      resolveB2bBerlinEligibility, so a constraint demanding a key no
 *      resolver emits - which would reject every real row - cannot pass
 *      here. That is also what stops `dhlProductCode` being quietly
 *      renamed to `productCode`.
 *
 *   4. RESOLUTION IS A ONE-WAY DOOR THAT MUST STILL OPEN. The freeze
 *      guard has to permit the single UPDATE that sets resolved_at and
 *      the routing together, and refuse every one after it. That hinges
 *      on reading OLD rather than NEW, and it is asserted directly.
 *
 *   5. THE TAX IS lib/tax.ts's. The gross formula in SQL is re-executed
 *      against addTaxToNet() for real amounts rather than eyeballed.
 *
 *   6. READ-ONLY, INCLUDING service_role. 4B is a foundation: no write
 *      privilege, no policy, no RPC, no Stripe.
 *
 * SAFE: reads SQL, TypeScript and the git index. No database, no
 * network, no Stripe, no clock.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf-8");

const MIGRATION = "060_b2b_payment_delivery_foundation.sql";
const MIGRATIONS = path.join(ROOT, "supabase/migrations");
const migration = read(`supabase/migrations/${MIGRATION}`);

/** SQL with whole-line comments stripped, so the header cannot satisfy a test. */
const sql = migration.replace(/^\s*--.*$/gm, "");
/** One string, whitespace flattened, for predicate matching. */
const flat = sql.replace(/\s+/g, " ");

const PAYMENTS = "public.b2b_payment_schedule";
const DELIVERIES = "public.b2b_deliveries";

/** The body of one named CHECK constraint, parens-balanced. */
const constraintBody = name => {
  const at = flat.indexOf(`add constraint ${name} check (`);
  assert.notStrictEqual(at, -1, `constraint ${name} is not in the migration`);
  const open = flat.indexOf("(", flat.indexOf("check", at));
  let depth = 0;
  for (let i = open; i < flat.length; i += 1) {
    if (flat[i] === "(") depth += 1;
    if (flat[i] === ")") {
      depth -= 1;
      if (depth === 0) return flat.slice(open + 1, i).trim();
    }
  }
  throw new Error(`constraint ${name} is not parens-balanced`);
};

/** The body of one plpgsql function, between its $$ delimiters. */
const functionBody = name => {
  const at = sql.indexOf(`create function public.${name}(`);
  assert.notStrictEqual(at, -1, `function ${name} is not in the migration`);
  const open = sql.indexOf("as $$", at);
  const close = sql.indexOf("$$;", open + 5);
  assert.ok(open !== -1 && close !== -1, `function ${name} has no $$ body`);
  return sql.slice(open + 5, close);
};

/** The CREATE TABLE body of one table. */
const tableBody = qualified => {
  const at = sql.indexOf(`create table ${qualified} (`);
  assert.notStrictEqual(at, -1, `${qualified} is not created`);
  const open = sql.indexOf("(", at);
  let depth = 0;
  for (let i = open; i < sql.length; i += 1) {
    if (sql[i] === "(") depth += 1;
    if (sql[i] === ")") {
      depth -= 1;
      if (depth === 0) return sql.slice(open + 1, i);
    }
  }
  throw new Error(`${qualified} is not parens-balanced`);
};

const paymentTable = tableBody(PAYMENTS);
const deliveryTable = tableBody(DELIVERIES);

/* ══════════════════════════════════════════════════════════════
   1. THE FILE, ITS TRANSACTION, AND WHAT IT REFUSES TO DO
   ══════════════════════════════════════════════════════════════ */

test("1: 060 exists, is the highest migration, and 061 is NOT authored", () => {
  const files = readdirSync(MIGRATIONS).filter(f => f.endsWith(".sql"));
  assert.ok(files.includes(MIGRATION), "060 is missing");
  const numbers = files.map(f => Number(f.slice(0, 3))).filter(Number.isInteger);
  assert.strictEqual(Math.max(...numbers), 63, "063 must be the newest migration");
  assert.strictEqual(files.filter(f => f.startsWith("060")).length, 1,
    "there must be exactly one 060");
  assert.strictEqual(files.filter(f => f.startsWith("064")).length, 0,
    "061 must NOT be authored in this package");
});

test("2: it is transactional - exactly one begin and one commit", () => {
  assert.strictEqual((sql.match(/^begin;$/gm) || []).length, 1);
  assert.strictEqual((sql.match(/^commit;$/gm) || []).length, 1);
  assert.ok(sql.indexOf("\nbegin;") < sql.indexOf("\ncommit;"));
  assert.ok(!/\brollback\b/i.test(sql));
  assert.ok(!/\bsavepoint\b/i.test(sql));
});

test("3: nothing destructive, and no DML against business data", () => {
  for (const forbidden of [
    /\bdrop\s+table\b/i, /\bdrop\s+column\b/i, /\bdrop\s+constraint\b/i,
    /\bdrop\s+index\b/i, /\bdrop\s+trigger\b/i, /\bdrop\s+function\b/i,
    /\bdrop\s+policy\b/i, /\bdrop\s+not\s+null\b/i, /\bdrop\s+default\b/i,
    /\btruncate\b/i, /\bdelete\s+from\b/i, /\binsert\s+into\b/i,
    /^\s*update\s+public\./im, /\balter\s+policy\b/i,
  ]) {
    assert.ok(!forbidden.test(sql), `060 must not contain ${forbidden}`);
  }
  // 060 is purely additive: the only DROP-shaped words 059 needed
  // (drop not null / drop default) are not needed here either, because
  // both tables are new.
  assert.strictEqual((sql.match(/\bdrop\b/gi) || []).length, 0,
    "060 creates two new tables and needs no DROP of any kind");
});

test("4: no existing 059 or 006 object is altered", () => {
  // The ONE thing 060 adds to an existing table is a constraint trigger,
  // which is a creation rather than an alteration.
  const alters = (flat.match(/alter table public\.(\w+)/g) || [])
    .map(m => /alter table public\.(\w+)/.exec(m)[1]);
  for (const t of alters) {
    assert.ok(["b2b_payment_schedule", "b2b_deliveries"].includes(t),
      `060 alters ${t}, which it does not own`);
  }
  // 059's and 006's constraints, policies and grants are never named.
  assert.ok(!/b2b_supply_items/.test(sql), "060 has no business with the canonical item table");
  for (const owned059 of [
    "b2b_supply_agreements_self_service", "b2b_supply_agreements_annual_shape",
    "b2b_supply_agreements_monthly_shape", "b2b_supply_agreements_immutability",
    "assert_b2b_self_service_item_integrity",
  ]) {
    assert.ok(!sql.includes(owned059), `060 touches 059's ${owned059}`);
  }
});

/* ══════════════════════════════════════════════════════════════
   2. THE TWO TABLES, AND WHAT THEY DELIBERATELY DO NOT CARRY
   ══════════════════════════════════════════════════════════════ */

test("5: exactly two tables are created, and they are the two", () => {
  const created = (sql.match(/create table public\.(\w+)/g) || [])
    .map(m => /create table public\.(\w+)/.exec(m)[1]);
  assert.deepStrictEqual(created.sort(), ["b2b_deliveries", "b2b_payment_schedule"]);
});

test("6: both foreign keys to the agreement RESTRICT - they never cascade", () => {
  for (const [label, body] of [["payment schedule", paymentTable], ["deliveries", deliveryTable]]) {
    const fk = /references public\.b2b_supply_agreements\(id\)\s*on delete (\w+)/.exec(body);
    assert.ok(fk, `${label} has no explicit ON DELETE on its agreement FK`);
    assert.ok(["restrict", "no"].includes(fk[1].toLowerCase()),
      `${label} uses ON DELETE ${fk[1]} - a payment or delivery history must not be deleted with its parent`);
    assert.ok(!/on delete cascade/i.test(body), `${label} cascades from the agreement`);
    assert.ok(/supply_agreement_id\s+uuid not null/.test(body),
      `${label} must be owned by an agreement`);
  }
});

test("7: neither child restates a parent authority", () => {
  // instalment_count, plan_type and the agreement's money are 059's, and
  // a copy here is the one that would disagree after an update.
  for (const forbidden of ["instalment_count", "contract_product_net_cents",
                           "base_monthly_product_net_cents", "pack_net_cents",
                           "pricing_rules_version", "pricing_snapshot"]) {
    assert.ok(!new RegExp(`^\\s*${forbidden}\\s`, "m").test(paymentTable),
      `b2b_payment_schedule declares ${forbidden}, which the agreement owns`);
  }
  for (const forbidden of ["plan_type", "instalment_count", "address_id",
                           "contract_product_net_cents", "pricing_snapshot"]) {
    assert.ok(!new RegExp(`^\\s*${forbidden}\\s`, "m").test(deliveryTable),
      `b2b_deliveries declares ${forbidden}, which it must not carry`);
  }
  // The address is a SNAPSHOT, because an address row is mutable and
  // would rewrite the history of every delivery pointing at it.
  assert.ok(/delivery_address_snapshot\s+jsonb/.test(deliveryTable));
  assert.ok(!/references public\.addresses/.test(sql), "a delivery must not point at a mutable address row");
});

/* ══════════════════════════════════════════════════════════════
   3. THE PAYMENT STATUS MODEL
   ══════════════════════════════════════════════════════════════ */

const PAYMENT_STATUSES = ["scheduled", "invoiced", "action_required",
                          "payment_failed", "paid", "void"];

/** The transition graph 4B approved, as data. */
const PAYMENT_TRANSITIONS = {
  scheduled: ["invoiced", "action_required", "payment_failed", "paid", "void"],
  invoiced: ["action_required", "payment_failed", "paid", "void"],
  action_required: ["payment_failed", "paid", "void"],
  payment_failed: ["action_required", "paid", "void"],
  paid: [],
  void: [],
};

test("8: the six payment statuses, and no seventh", () => {
  const body = constraintBody("b2b_payment_schedule_status_check");
  for (const s of PAYMENT_STATUSES) {
    assert.ok(body.includes(`'${s}'`), `payment status ${s} is missing`);
  }
  const quoted = (body.match(/'[a-z_]+'/g) || []).map(q => q.slice(1, -1));
  assert.deepStrictEqual(quoted.slice().sort(), PAYMENT_STATUSES.slice().sort(),
    "the payment status set is not exactly the six approved values");
  assert.ok(/status\s+text not null default 'scheduled'/.test(paymentTable));
});

test("9: the payment transition graph is complete, and matches the approved one", () => {
  const body = functionBody("b2b_payment_schedule_transition_guard");
  // A status that does not change is not a transition.
  assert.ok(/if new\.status = old\.status then\s*return new;/.test(body),
    "an update that does not change the status must not be treated as a transition");
  for (const [from, targets] of Object.entries(PAYMENT_TRANSITIONS)) {
    if (targets.length === 0) continue;
    const arm = new RegExp(`when '${from}'\\s*then array\\[([^\\]]*)\\]`).exec(body);
    assert.ok(arm, `the guard has no arm for ${from}`);
    const listed = (arm[1].match(/'[a-z_]+'/g) || []).map(q => q.slice(1, -1)).sort();
    assert.deepStrictEqual(listed, targets.slice().sort(),
      `${from} does not allow exactly ${targets.join(", ")}`);
  }
  assert.ok(/errcode = 'check_violation'/.test(body), "a refused transition must raise");
});

test("10: paid and void are TERMINAL - no arm, and the fallthrough is empty", () => {
  const body = functionBody("b2b_payment_schedule_transition_guard");
  assert.ok(!/when 'paid'\s*then/.test(body), "paid has an outgoing arm");
  assert.ok(!/when 'void'\s*then/.test(body), "void has an outgoing arm");
  // The else arm is what makes a missing arm mean "nothing is allowed"
  // rather than "everything is".
  assert.ok(/else array\[\]::text\[\]/.test(body),
    "the fallthrough must be the EMPTY array, so an unlisted status permits nothing");
  assert.ok(/not \(new\.status = any \(v_allowed\)\)/.test(body));
});

test("11: the transition guard is IMMEDIATE, not deferred", () => {
  const trigger = /create trigger b2b_payment_schedule_transition\s+([\s\S]*?);/.exec(sql);
  assert.ok(trigger, "the payment transition trigger is missing");
  assert.ok(/before update on public\.b2b_payment_schedule/.test(trigger[1]));
  assert.ok(/for each row/.test(trigger[1]));
  assert.ok(!/deferrable/i.test(trigger[1]),
    "a transition guard that fires at COMMIT cannot name the statement that broke the rule");
});

test("12: each payment status implies its own timestamp, and forces no other to NULL", () => {
  for (const [status, column] of [
    ["invoiced", "invoiced_at"], ["action_required", "action_required_at"],
    ["payment_failed", "failed_at"], ["paid", "paid_at"], ["void", "voided_at"],
  ]) {
    const body = constraintBody(`b2b_payment_schedule_${column}_check`);
    assert.ok(body.includes(`status <> '${status}'`), `${status} does not gate ${column}`);
    assert.ok(body.includes(`${column} is not null`), `${status} does not require ${column}`);
  }
  // A row that failed, recovered and paid keeps all three stamps: the
  // history is the point. No constraint may force an earlier one to NULL.
  for (const column of ["invoiced_at", "action_required_at", "failed_at", "paid_at"]) {
    for (const name of Object.keys(PAYMENT_TRANSITIONS)) {
      const guard = `status = '${name}'`;
      assert.ok(!flat.includes(`${guard} and ${column} is null`),
        `a status is forcing ${column} back to NULL, which deletes payment history`);
    }
  }
});

/* ══════════════════════════════════════════════════════════════
   4. THE MONEY AND ITS TAX LIFECYCLE
   ══════════════════════════════════════════════════════════════ */

test("13: an instalment is product money only, and always positive", () => {
  assert.ok(/net_cents\s+integer not null check \(net_cents > 0\)/.test(paymentTable),
    "net_cents must be present and positive on every instalment");
  // Shipping is a per-delivery fact and has no column here.
  for (const forbidden of ["shipping_net_cents", "shipping_gross_cents",
                           "shipping_tax_cents", "customer_shipping"]) {
    assert.ok(!paymentTable.includes(forbidden),
      `b2b_payment_schedule carries ${forbidden} - shipping is not billed on the instalment`);
  }
});

test("14: the tax rate is the exported Matcha rate, and the world is closed", () => {
  assert.strictEqual(TAX_CATEGORY_RATE_PERCENT.matcha_reduced_de, 7);
  const body = constraintBody("b2b_payment_schedule_tax_rate_check");
  assert.ok(body.includes(`tax_rate_percent = ${TAX_CATEGORY_RATE_PERCENT.matcha_reduced_de}`),
    "the SQL rate has drifted from TAX_CATEGORY_RATE_PERCENT.matcha_reduced_de");
  assert.ok(body.includes("tax_rate_percent is null or"),
    "a scheduled instalment must be allowed to have no rate yet");
  // A future German rate needs a future migration, not a row.
  assert.ok(!/tax_rate_percent\s+in \(/.test(flat), "the rate is a single closed value, not a list");
  assert.ok(!/tax_rate_percent between/.test(flat), "the rate is not a range");
});

test("15: net-origin, at the exported version, and closed to any other", () => {
  assert.strictEqual(NET_ORIGIN_TAX_CALCULATION_VERSION, "de-net-2026.1");
  assert.ok(constraintBody("b2b_payment_schedule_tax_calculation_version_check")
    .includes(`tax_calculation_version = '${NET_ORIGIN_TAX_CALCULATION_VERSION}'`));
  assert.ok(constraintBody("b2b_payment_schedule_price_origin_check")
    .includes("price_origin = 'net'"),
    "B2B is net-origin; a gross-origin instalment would be a different calculation");
  // The gross-origin version belongs to the B2C cart snapshots and must
  // not appear here. Anchored on the opening quote, because the shipping
  // rules version 'dhl-de-2026.1' legitimately ends in the same digits.
  assert.ok(!/'de-2026\.1'/.test(flat),
    "the gross-origin calculation version must not appear in a net-origin table");
  assert.ok(flat.includes("'dhl-de-2026.1'"),
    "the shipping rules version is what that near-miss string should be");
});

test("16: the tax facts are required once the instalment has been put to the customer", () => {
  const body = constraintBody("b2b_payment_schedule_tax_established_check");
  for (const status of ["invoiced", "action_required", "payment_failed", "paid"]) {
    assert.ok(body.includes(`'${status}'`), `${status} does not require established tax`);
  }
  // 'scheduled' may still be tax-free, and 'void' may have skipped it.
  assert.ok(!body.includes("'scheduled'"), "a scheduled instalment must not need tax yet");
  assert.ok(!body.includes("'void'"), "a voided instalment must not be forced to invent tax");
  for (const required of ["tax_rate_percent = 7", "tax_cents is not null",
                          "gross_cents is not null",
                          "tax_calculation_version = 'de-net-2026.1'",
                          "price_origin = 'net'"]) {
    assert.ok(body.includes(required), `the established tax fact is missing: ${required}`);
  }
  assert.ok(body.endsWith(") is true"), "a compound tax requirement that can pass as UNKNOWN");
});

test("17: void preserves whatever tax it had - nothing forces it back to NULL", () => {
  // The reconciliation rules are NOT status-guarded, so a voided row that
  // kept its tax facts must have kept CORRECT ones - but nothing demands
  // it drop them.
  assert.ok(!/status = 'void'[^)]*tax_cents is null/.test(flat),
    "void is being forced to discard established tax facts");
  const sum = constraintBody("b2b_payment_schedule_gross_sum_check");
  assert.ok(!sum.includes("status"), "the gross reconciliation must hold whatever the status is");
});

test("18: the gross is lib/tax.ts's, asserted twice and re-executed", () => {
  // Rule one: the three amounts add up.
  assert.ok(constraintBody("b2b_payment_schedule_gross_sum_check").includes(
    "gross_cents::bigint = net_cents::bigint + tax_cents::bigint"),
    "net + tax = gross is not enforced");
  // Rule two: the gross is the half-up net-origin result, not any pair
  // that happens to add up.
  const formula = constraintBody("b2b_payment_schedule_gross_formula_check");
  assert.ok(formula.includes(
    "gross_cents::bigint = (2 * (net_cents::bigint * (100 + tax_rate_percent::bigint)) + 100) / 200"),
    "the SQL gross formula is not divideRoundHalfUp(net * (100 + rate), 100)");
  // AND IT IS THE SAME NUMBER THE TYPESCRIPT PRODUCES, for every annual
  // contract amount this shop can actually sell, split every approved way.
  const rate = TAX_CATEGORY_RATE_PERCENT.matcha_reduced_de;
  for (let packs = B2B_MIN_PACKS; packs <= B2B_SELF_SERVICE_MAX_PACKS; packs += 1) {
    for (const count of B2B_INSTALMENT_COUNTS) {
      const total = annualProductNetCents(packs);
      const base = Math.floor(total / count);
      for (const net of [base, total - base * (count - 1)]) {
        const fromSql = Math.floor((2 * (net * (100 + rate)) + 100) / 200);
        const fromTs = addTaxToNet(net, rate);
        assert.strictEqual(fromSql, fromTs.grossCents,
          `the SQL gross differs from addTaxToNet at net=${net}`);
        assert.strictEqual(fromSql - net, fromTs.taxCents,
          `the SQL tax remainder differs from addTaxToNet at net=${net}`);
      }
    }
  }
});

/* ══════════════════════════════════════════════════════════════
   5. PAYMENT CORRELATION
   ══════════════════════════════════════════════════════════════ */

test("19: the two Stripe identifiers are INDEPENDENTLY unique, and both partial", () => {
  for (const column of ["stripe_invoice_id", "stripe_payment_intent_id"]) {
    const index = new RegExp(
      `create unique index b2b_payment_schedule_${column}_key on public\\.b2b_payment_schedule \\(${column}\\) where ${column} is not null`);
    assert.ok(index.test(flat), `${column} has no partial unique index of its own`);
  }
  // Not a composite: an instalment may carry either, both, or neither.
  assert.ok(!/\(stripe_invoice_id, stripe_payment_intent_id\)/.test(flat),
    "the two identifiers must not be unique only as a pair");
});

test("20: an invoiced row has an invoice; an attempted row has SOMETHING", () => {
  assert.ok(constraintBody("b2b_payment_schedule_invoiced_requires_invoice_check")
    .includes("status <> 'invoiced' or stripe_invoice_id is not null"));
  const attempt = constraintBody("b2b_payment_schedule_attempt_requires_correlation_check");
  for (const status of ["action_required", "payment_failed", "paid"]) {
    assert.ok(attempt.includes(`'${status}'`), `${status} needs a correlation identifier`);
  }
  assert.ok(attempt.includes("stripe_invoice_id is not null or stripe_payment_intent_id is not null"),
    "either identifier must satisfy it - Checkout-first instalments carry no invoice");
  // And crucially NOT "paid requires an invoice", which would make the
  // Checkout path unrepresentable.
  assert.ok(!/status <> 'paid' or stripe_invoice_id is not null/.test(flat),
    "a paid instalment must not be forced to have an invoice id");
});

test("21: 060 makes no Stripe call and defines no writer", () => {
  for (const forbidden of [/api\.stripe\.com/i, /\bhttp:/i, /\bhttps:/i, /pg_net/i,
                           /\bcreate\s+extension\b/i, /\bcopy\b/i]) {
    assert.ok(!forbidden.test(sql), `060 must not contain ${forbidden}`);
  }
  // Every function it creates is an assertion or a guard - none returns
  // data and none is a callable writer.
  const fns = (sql.match(/create function public\.(\w+)/g) || [])
    .map(m => /create function public\.(\w+)/.exec(m)[1]);
  for (const fn of fns) {
    assert.ok(/_trigger$|_guard$|^assert_/.test(fn),
      `${fn} is neither a trigger wrapper, a guard nor an assertion - 4B adds no writer`);
  }
});

/* ══════════════════════════════════════════════════════════════
   6. THE DELIVERY STATUS MODEL
   ══════════════════════════════════════════════════════════════ */

const DELIVERY_STATUSES = ["scheduled", "held", "dispatched", "delivered", "cancelled"];

const DELIVERY_TRANSITIONS = {
  scheduled: ["held", "dispatched", "cancelled"],
  held: ["scheduled", "dispatched", "cancelled"],
  dispatched: ["delivered"],
  delivered: [],
  cancelled: [],
};

test("22: the five delivery statuses, and 'held' is one of them", () => {
  const body = constraintBody("b2b_deliveries_status_check");
  const quoted = (body.match(/'[a-z_]+'/g) || []).map(q => q.slice(1, -1));
  assert.deepStrictEqual(quoted.slice().sort(), DELIVERY_STATUSES.slice().sort());
  // HELD IS LOAD-BEARING: a payment failure pauses deliveries and leaves
  // the contract standing. Without it the only way to stop a delivery
  // would be to cancel it, which ends something that has not ended.
  assert.ok(quoted.includes("held"), "there is no way to pause a delivery without ending it");
  assert.ok(constraintBody("b2b_deliveries_hold_reason_requires_held_check")
    .includes("status <> 'held' or hold_reason is not null"),
    "a held delivery must say why");
  assert.ok(constraintBody("b2b_deliveries_hold_reason_length_check")
    .includes("char_length(btrim(hold_reason)) between 1 and 500"),
    "the hold reason must be real text rather than whitespace");
});

test("23: the delivery transition graph is conservative and terminal-correct", () => {
  const body = functionBody("b2b_deliveries_transition_guard");
  assert.ok(/if new\.status = old\.status then\s*return new;/.test(body));
  for (const [from, targets] of Object.entries(DELIVERY_TRANSITIONS)) {
    if (targets.length === 0) {
      assert.ok(!new RegExp(`when '${from}'\\s*then`).test(body), `${from} must be terminal`);
      continue;
    }
    const arm = new RegExp(`when '${from}'\\s*then array\\[([^\\]]*)\\]`).exec(body);
    assert.ok(arm, `the guard has no arm for ${from}`);
    const listed = (arm[1].match(/'[a-z_]+'/g) || []).map(q => q.slice(1, -1)).sort();
    assert.deepStrictEqual(listed, targets.slice().sort(),
      `${from} does not allow exactly ${targets.join(", ")}`);
  }
  // A hold is reversible; a dispatch is not. No returns flow is invented.
  assert.ok(DELIVERY_TRANSITIONS.held.includes("scheduled"), "a hold must be releasable");
  assert.ok(!DELIVERY_TRANSITIONS.dispatched.includes("cancelled"),
    "cancelling a dispatched parcel is a RETURN, and no returns flow is approved");
  assert.ok(/else array\[\]::text\[\]/.test(body));
});

test("24: each delivery status implies its timestamp, and nothing dispatches unrouted", () => {
  for (const [status, column] of [
    ["dispatched", "dispatched_at"], ["delivered", "delivered_at"], ["cancelled", "cancelled_at"],
  ]) {
    const body = constraintBody(`b2b_deliveries_${column}_check`);
    assert.ok(body.includes(`status <> '${status}'`));
    assert.ok(body.includes(`${column} is not null`));
  }
  const dispatch = constraintBody("b2b_deliveries_dispatch_requires_resolution_check");
  assert.ok(dispatch.includes("resolved_at is not null"));
  assert.ok(dispatch.includes("shipping_snapshot is not null"));
  for (const status of ["dispatched", "delivered"]) {
    assert.ok(dispatch.includes(`'${status}'`), `${status} may leave without a resolved route`);
  }
});

/* ══════════════════════════════════════════════════════════════
   7. HISTORY, NOT A MIRROR
   ══════════════════════════════════════════════════════════════ */

/**
 * The cross-table assertion, cut into the three regions whose rules are
 * deliberately different. The status gate is the boundary that matters:
 * everything above it binds a PENDING agreement too, and the two plan
 * branches below it bind only an ACTIVE one.
 */
const assertionRegions = () => {
  const body = functionBody("assert_b2b_commerce_integrity");
  const gate = body.indexOf("if v_status <> 'active' then");
  const monthly = body.indexOf("if v_plan_type = 'monthly' then");
  const annual = body.indexOf("if v_plan_type = 'annual' then");
  assert.ok(gate !== -1 && monthly !== -1 && annual !== -1 && gate < monthly && monthly < annual,
    "the assertion no longer has a status gate followed by the two plan branches");
  const squash = s => s.replace(/\s+/g, " ");
  return {
    body,
    everyStatus: body.slice(0, gate),
    monthly: body.slice(monthly, annual),
    annual: body.slice(annual),
    // Whitespace-flattened, for predicates that span several lines in
    // the SQL the way the allocation CASE does.
    annualFlat: squash(body.slice(annual)),
  };
};

test("25: a delivery's ROUTING history is never reconciled against the agreement", () => {
  // THE FAILURE MODE THIS CATCHES: an integrity rule that reconciles a
  // delivery's frozen routing against the agreement's current address or
  // class. The customer moves, and every past delivery becomes invalid.
  const { body } = assertionRegions();
  for (const historical of ["shipping_class", "delivery_address_snapshot",
                            "berlin_eligibility_snapshot", "shipping_snapshot",
                            "scheduled_for", "resolved_at"]) {
    assert.ok(!body.includes(historical),
      `the cross-table assertion reads ${historical} - frozen routing must not be reconciled`);
  }
  assert.ok(!/delivery_interval|next_delivery_at/.test(sql),
    "060 must not re-derive the agreement's delivery cadence");
  // The agreement columns it may read, and no others.
  const selected = /select ([\s\S]*?)\s+into/.exec(body);
  assert.ok(selected, "the assertion does not read the agreement");
  assert.deepStrictEqual(selected[1].split(",").map(s => s.trim()),
    ["plan_type", "status", "instalment_count", "contract_product_net_cents", "quantity_packs"],
    "the assertion reads an agreement column it has no business reconciling");
});

test("25b: quantity is compared ONLY in the annual branch - never for monthly", () => {
  // ══════════════════════════════════════════════════════════
  // WHY THIS ASYMMETRY IS CORRECT AND NOT AN OVERSIGHT
  // ══════════════════════════════════════════════════════════
  // 059's immutability guard FREEZES quantity_packs on an ACTIVE ANNUAL
  // agreement, so "the agreement's current quantity" and "the quantity
  // every delivery was created under" are the same value permanently -
  // a mismatch there is a defect.
  //
  // A MONTHLY agreement may change quantity, and 059 permits it. If the
  // comparison applied to monthly, the very transaction that changed the
  // quantity would be refused by the delivery history it is not allowed
  // to rewrite. So the monthly branch must never look.
  const { everyStatus, monthly, annual } = assertionRegions();

  assert.ok(!everyStatus.includes("is distinct from v_quantity_packs"),
    "quantity is compared before the status gate, which would bind a PENDING agreement");
  assert.ok(!/quantity_packss*(<>|=)s*v_quantity_packs/.test(everyStatus),
    "quantity is compared before the status gate");
  assert.ok(!monthly.includes("quantity_packs"),
    "the MONTHLY branch compares quantity - a future cycle change would invalidate old deliveries");
  assert.ok(annual.includes("d.quantity_packs is distinct from v_quantity_packs"),
    "the ANNUAL branch does not validate its delivery quantities against the frozen agreement quantity");
  assert.ok(/v_del_qty_mismatch > 0/.test(annual),
    "an annual quantity mismatch is counted but never raised");
  // IS DISTINCT FROM, so a NULL on either side is a mismatch rather than
  // an UNKNOWN that disappears.
  assert.ok(!/d\.quantity_packs <> v_quantity_packs/.test(annual),
    "a <> comparison would let a NULL quantity pass silently");
  // The comparison is against the DELIVERY table only - no monthly row
  // is reachable from the annual branch, because the branch is entered
  // on plan_type and an agreement has exactly one plan.
  assert.ok(/from public\.b2b_deliveries d/.test(annual));
  // 059 is the authority for the freeze this rests on, and it still says so.
  const migration059 = read("supabase/migrations/059_b2b_supply_commerce_foundation.sql");
  assert.ok(/old\.plan_type = 'annual' and old\.status = 'active'/.test(migration059)
    && /new\.quantity_packs is distinct from old\.quantity_packs/.test(migration059),
    "059 no longer freezes quantity_packs on an active annual agreement, so this rule is unsound");
});

test("25c: no CHECK constraint mirrors the agreement onto a delivery row", () => {
  // The row-local constraints cannot see the agreement at all, and must
  // not try: a delivery's quantity is bounded by the product, not by the
  // parent row.
  for (const name of (flat.match(/add constraint (\w+) check \(/g) || [])
    .map(m => /add constraint (\w+)/.exec(m)[1])) {
    assert.ok(!/b2b_supply_agreements/.test(constraintBody(name)),
      `${name} reaches into the agreement from a row-local CHECK`);
  }
});

test("26: a delivery's own quantity is bounded by the product, not by the parent row", () => {
  assert.ok(new RegExp(
    `quantity_packs\\s+integer not null check \\(quantity_packs between ${B2B_MIN_PACKS} and ${B2B_SELF_SERVICE_MAX_PACKS}\\)`)
    .test(deliveryTable),
    "the historical quantity is not bounded by the Package 1 pack ceiling");
});

/* ══════════════════════════════════════════════════════════════
   8. RESOLUTION: THE ONE-WAY DOOR THAT MUST STILL OPEN
   ══════════════════════════════════════════════════════════════ */

test("27: an unresolved delivery is a slot - it freezes nothing", () => {
  const body = constraintBody("b2b_deliveries_unresolved_is_unrouted_check");
  assert.ok(body.includes("resolved_at is not null or"));
  assert.ok(body.includes("shipping_class is null"));
  assert.ok(body.includes("shipping_snapshot is null"));
  assert.ok(body.endsWith(") is true"));
});

test("28: a resolved delivery is resolved COMPLETELY", () => {
  const body = constraintBody("b2b_deliveries_resolved_is_complete_check");
  for (const required of ["delivery_address_snapshot is not null",
                          "berlin_eligibility_snapshot is not null",
                          "shipping_class in ('berlin_local', 'dhl')",
                          "shipping_snapshot is not null"]) {
    assert.ok(body.includes(required), `resolution does not require: ${required}`);
  }
  assert.ok(body.endsWith(") is true"));
});

test("29: THE FREEZE READS OLD - so the resolving UPDATE itself is allowed", () => {
  // ══════════════════════════════════════════════════════════
  // THE BUG THIS TEST EXISTS FOR
  // ══════════════════════════════════════════════════════════
  // Resolving is ONE UPDATE that sets resolved_at AND the routing.
  // A guard written as `if new.resolved_at is not null then <freeze>`
  // would look at that very statement and refuse the resolution it is
  // supposed to permit. The only correct question is about OLD.
  const body = functionBody("b2b_deliveries_resolution_freeze_guard");
  assert.ok(/if old\.resolved_at is null then\s*return new;\s*end if;/.test(body),
    "the guard must return early when the row was NOT already resolved");
  assert.ok(!/if new\.resolved_at is not null then/.test(body),
    "the guard gates on NEW, which would refuse the one UPDATE that performs the resolution");
  // The early return must come before any frozen-field comparison.
  const earlyReturn = body.indexOf("if old.resolved_at is null");
  const firstFreeze = body.indexOf("is distinct from old.");
  assert.ok(earlyReturn !== -1 && earlyReturn < firstFreeze,
    "a frozen-field comparison runs before the not-yet-resolved escape");
});

test("30: after resolution all six routing facts freeze, including un-resolving", () => {
  const body = functionBody("b2b_deliveries_resolution_freeze_guard");
  for (const column of ["resolved_at", "delivery_address_snapshot", "berlin_eligibility_snapshot",
                        "shipping_class", "shipping_snapshot", "quantity_packs"]) {
    assert.ok(body.includes(`new.${column} is distinct from old.${column}`),
      `${column} is not frozen after resolution`);
  }
  // IS DISTINCT FROM rather than <>, so setting a frozen value back to
  // NULL is as much a violation as changing it.
  assert.ok(!/new\.\w+ <> old\.\w+/.test(body),
    "a <> comparison would let a frozen value be nulled out without tripping the guard");
  assert.ok((body.match(/errcode = 'check_violation'/g) || []).length >= 6);
});

test("31: the freeze guard is IMMEDIATE", () => {
  const trigger = /create trigger b2b_deliveries_resolution_freeze\s+([\s\S]*?);/.exec(sql);
  assert.ok(trigger);
  assert.ok(/before update on public\.b2b_deliveries/.test(trigger[1]));
  assert.ok(!/deferrable/i.test(trigger[1]));
});

/* ══════════════════════════════════════════════════════════════
   9. THE SNAPSHOTS ARE THE TYPESCRIPT'S
   ══════════════════════════════════════════════════════════════ */

const berlinCheck = constraintBody("b2b_deliveries_berlin_snapshot_check");
const shippingCheck = constraintBody("b2b_deliveries_shipping_snapshot_check");

/** A real eligible and a real ineligible verdict, from the authority. */
const berlinEligible = resolveB2bBerlinEligibility({ country: "DE", postcode: "10115" });
const berlinRejected = resolveB2bBerlinEligibility({ country: "DE", postcode: "20095" });

/** A real resolved Berlin route and a real resolved DHL route. */
const berlinRoute = resolveB2bShipping({ packs: 2, address: { country: "DE", postcode: "10115" } });
const dhlRoute = resolveB2bShipping({
  packs: 2,
  address: { country: "DE", postcode: "20095" },
  measurement: { packTareGrams: 60, outerPackagingGrams: 250, lengthMm: 400, widthMm: 200, heightMm: 150 },
});

test("32: the fixtures this suite reasons about are the real resolver outputs", () => {
  assert.strictEqual(berlinEligible.eligible, true);
  assert.strictEqual(berlinRejected.eligible, false);
  assert.strictEqual(berlinRoute.mode, "berlin_local");
  assert.strictEqual(berlinRoute.chargeStatus, "free_local_delivery");
  assert.strictEqual(dhlRoute.mode, "dhl");
  assert.strictEqual(dhlRoute.chargeStatus, "carrier_reference_resolved");
});

test("33: the Berlin snapshot requires exactly the resolver's keys, and BOTH verdicts", () => {
  for (const key of Object.keys(berlinEligible)) {
    assert.ok(berlinCheck.includes(`'${key}'`), `the Berlin snapshot key ${key} is not required`);
  }
  assert.ok(berlinCheck.includes(`'rulesVersion'`));
  assert.ok(berlinCheck.includes(`= '${B2B_BERLIN_ELIGIBILITY_VERSION}'`),
    "the Berlin rules version is not pinned to the exported constant");
  // Every reason the resolver can produce is admitted - including the
  // three negatives, which are real decisions rather than missing ones.
  for (const reason of ["eligible", "country_not_germany", "postcode_malformed",
                        "postcode_outside_berlin"]) {
    assert.ok(berlinCheck.includes(`'${reason}'`), `the reason ${reason} is not admitted`);
  }
  assert.ok(!/eligible'\)::boolean|'eligible' = 'true' and/.test(berlinCheck));
  // eligible=false must be storable: nothing requires the verdict to be true.
  assert.ok(!/->>'eligible' = 'true'\s*\)/.test(berlinCheck.replace(/= \(\(berlin_eligibility_snapshot->>'reason'\) = 'eligible'\)/g, "")),
    "the constraint refuses a negative Berlin verdict");
  // And the verdict agrees with its reason.
  assert.ok(berlinCheck.includes("= ((berlin_eligibility_snapshot->>'reason') = 'eligible')"),
    "a snapshot could claim eligible=true with a negative reason");
  assert.ok(berlinCheck.endsWith(") is true"));
});

test("34: the shipping snapshot requires exactly the resolver's keys - dhlProductCode included", () => {
  for (const key of Object.keys(berlinRoute)) {
    assert.ok(shippingCheck.includes(`'${key}'`),
      `the resolved Berlin key ${key} is not required by the constraint`);
  }
  for (const key of Object.keys(dhlRoute)) {
    assert.ok(shippingCheck.includes(`'${key}'`),
      `the resolved DHL key ${key} is not required by the constraint`);
  }
  // THE RENAME THAT MUST NOT HAPPEN. The tariff calls it productCode and
  // the RESOLUTION calls it dhlProductCode; the snapshot stores the
  // resolution.
  assert.ok(shippingCheck.includes("'dhlProductCode'"));
  assert.ok(!/'productCode'/.test(shippingCheck),
    "dhlProductCode has been renamed to productCode, which no resolver emits");
  // And the constraint invents no key the resolver does not write.
  const allowed = new Set([
    ...Object.keys(berlinRoute), ...Object.keys(dhlRoute),
    ...Object.keys(dhlRoute.dimensions), ...Object.keys(dhlRoute.tariffSource),
  ]);
  const values = new Set(["object", "number", "boolean", "array", "string", "null",
                          B2B_SHIPPING_RULES_VERSION, B2B_BERLIN_ELIGIBILITY_VERSION,
                          "berlin_local", "dhl", "free_local_delivery",
                          "carrier_reference_resolved",
                          ...DHL_DE_TARIFFS.map(t => t.productCode)]);
  for (const quoted of shippingCheck.match(/'[A-Za-z][A-Za-z0-9_.-]*'/g) || []) {
    const token = quoted.slice(1, -1);
    if (values.has(token)) continue;
    assert.ok(allowed.has(token),
      `the shipping snapshot constraint references '${token}', which no resolver emits`);
  }
  assert.ok(shippingCheck.endsWith(") is true"));
});

test("35: only a COMMERCIALLY USABLE route may be frozen", () => {
  // measurement_required and the unsupported_* answers are REFUSALS. A
  // snapshot carrying one would record "this delivery is routed" about a
  // delivery nobody can ship.
  for (const refusal of ["measurement_required", "unsupported_shipment",
                         "unsupported_country", "unsupported_quantity"]) {
    assert.ok(!shippingCheck.includes(refusal),
      `${refusal} is storable as a resolved shipping snapshot`);
  }
  assert.ok(shippingCheck.includes("'free_local_delivery'"));
  assert.ok(shippingCheck.includes("'carrier_reference_resolved'"));
  // The column and the snapshot are one decision written twice.
  assert.ok(constraintBody("b2b_deliveries_shipping_class_matches_snapshot_check")
    .includes("shipping_snapshot->>'mode' = shipping_class"));
});

test("36: a resolved DHL route carries the measured shipment; Berlin does not", () => {
  // DHL: every measured field the resolved variant emits is required.
  for (const measured of ["shipmentWeightGrams", "dimensions", "girthMm",
                          "maxWeightGrams", "maxGirthMm", "tariffSource"]) {
    assert.ok(shippingCheck.includes(`'${measured}'`), `a resolved DHL route may omit ${measured}`);
    assert.ok(Object.prototype.hasOwnProperty.call(dhlRoute, measured),
      `${measured} is required by SQL but not emitted by the resolver`);
  }
  for (const axis of ["lengthMm", "widthMm", "heightMm"]) {
    assert.ok(shippingCheck.includes(`'${axis}'`), `the parcel dimension ${axis} is not required`);
  }
  // maxGirthMm is REQUIRED TO BE PRESENT but may be JSON null - the 2 kg
  // product states no girth limit, and null records "not stated".
  assert.ok(DHL_DE_TARIFFS.some(t => t.maxGirthMm === null),
    "the fixture assumption that some tariff states no girth is stale");
  assert.ok(/jsonb_typeof\(shipping_snapshot->'maxGirthMm'\) in \('number', 'null'\)/.test(shippingCheck),
    "maxGirthMm must be present but may be null");
  // BERLIN needs none of it: GLOA drives, nothing is measured.
  const berlinArm = /\(\s*shipping_snapshot->>'mode' = 'berlin_local'([\s\S]*?)\) or/.exec(shippingCheck);
  assert.ok(berlinArm, "the Berlin arm of the shipping constraint is missing");
  for (const measured of ["shipmentWeightGrams", "dimensions", "dhlProductCode", "girthMm"]) {
    assert.ok(!berlinArm[1].includes(measured),
      `the Berlin arm demands ${measured}, which a local delivery never has`);
  }
  // And a Berlin route costs the carrier nothing, because there is no carrier.
  assert.strictEqual(berlinRoute.carrierRetailGrossCents, 0);
  assert.ok(berlinArm[1].includes("(shipping_snapshot->>'carrierRetailGrossCents')::numeric = 0"));
});

test("37: '{}' and partial snapshots cannot pass either snapshot constraint", () => {
  for (const [label, body, root] of [
    ["berlin", berlinCheck, "berlin_eligibility_snapshot"],
    ["shipping", shippingCheck, "shipping_snapshot"],
  ]) {
    assert.ok(body.includes(`jsonb_typeof(${root}) = 'object'`), `${label}: no object type proof`);
    assert.ok(body.includes("?&"), `${label}: no key-existence proof`);
    assert.ok(body.endsWith(") is true"), `${label}: UNKNOWN can pass`);
    // Every key read with -> or ->> is also proved present.
    const proved = new Set((body.match(/\?&? ?array\[[^\]]+\]/g) || [])
      .flatMap(m => m.match(/'[a-zA-Z][a-zA-Z0-9]*'/g) || [])
      .map(q => q.slice(1, -1)));
    const readKeys = new Set((body.match(/->>?'([a-zA-Z][a-zA-Z0-9]*)'/g) || [])
      .map(m => m.replace(/->>?'/, "").replace("'", "")));
    for (const key of readKeys) {
      assert.ok(proved.has(key), `${label}: ${key} is read without being proved present`);
    }
  }
});

/* ══════════════════════════════════════════════════════════════
   10. EXCEPTION SAFETY — NOTHING DEPENDS ON EVALUATION ORDER
   ══════════════════════════════════════════════════════════════ */

const CASE_SPANS = (() => {
  const spans = [];
  const re = /case when ([\s\S]*?) then ([\s\S]*?) else false end/g;
  for (let m = re.exec(flat); m; m = re.exec(flat)) {
    spans.push({
      when: m[1], then: m[2],
      thenStart: m.index + m[0].indexOf(" then ") + " then ".length,
      end: re.lastIndex,
    });
  }
  return spans;
})();

test("38: every raise-capable JSON operation sits inside a type-proving CASE", () => {
  // PostgreSQL does not promise the evaluation order of AND's operands,
  // so a jsonb_typeof() to the LEFT of a cast is documentation, not a
  // guard. 059 was patched for exactly this; 060 must not reintroduce it.
  const raiseCapable = /jsonb_array_length\s*\(|\((?:shipping_snapshot|berlin_eligibility_snapshot|delivery_address_snapshot)[^()]*\)::[a-z]+/g;
  const found = [...flat.matchAll(raiseCapable)];
  assert.ok(found.length >= 3, `expected the snapshot value reads, found ${found.length}`);
  for (const m of found) {
    assert.ok(CASE_SPANS.some(s => m.index >= s.thenStart && m.index < s.end),
      `this can raise and is not inside a type-proving CASE: ${flat.slice(m.index, m.index + 80)}`);
  }
});

test("39: each guarding CASE proves the type with an expression that cannot itself raise", () => {
  assert.ok(CASE_SPANS.length >= 3);
  for (const span of CASE_SPANS) {
    assert.ok(/jsonb_typeof/.test(span.when), `a CASE guards nothing: ${span.when}`);
    assert.ok(!/::|jsonb_array_length/.test(span.when),
      `a CASE's WHEN can itself raise: ${span.when}`);
    for (const path of span.then.match(
      /(?:shipping_snapshot|berlin_eligibility_snapshot)(?:->'[a-zA-Z][a-zA-Z0-9]*')*->>'[a-zA-Z][a-zA-Z0-9]*'/g) || []) {
      const proved = path.replace("->>'", "->'");
      assert.ok(span.when.includes(`jsonb_typeof(${proved}) = 'number'`),
        `${path} is read in a THEN whose WHEN never proved it is a number`);
    }
  }
  assert.strictEqual((flat.match(/\belse false end\b/g) || []).length, CASE_SPANS.length);
  assert.ok(!/\belse null end\b/.test(flat), "a guard falls through to NULL rather than FALSE");
  assert.ok(!/\belse true end\b/.test(flat), "a guard falls through to TRUE");
});

test("40: no JSON value is cast to bigint, and no division meets an unguarded zero", () => {
  assert.ok(!/\((?:shipping_snapshot|berlin_eligibility_snapshot)[^()]*\)::bigint/.test(flat),
    "a JSON value is cast to bigint, which raises on a fractional number");
  const names = (flat.match(/add constraint (\w+) check \(/g) || [])
    .map(m => /add constraint (\w+)/.exec(m)[1]);
  for (const name of names) {
    for (const m of constraintBody(name).matchAll(/\/\s*([a-z0-9_]+\(?[^\s)]*|\d+)/gi)) {
      assert.ok(/^\d+$/.test(m[1]) || m[1].startsWith("nullif("),
        `${name} divides by "${m[1]}", which is neither a literal nor nullif-guarded`);
    }
  }
  // AND NO CONSTRAINT CARRIES AN ESCAPE HATCH. Every rule in this file
  // is a conjunction of real requirements; a tautological disjunct
  // appended to any of them would satisfy a substring assertion while
  // admitting every row. This is the one shape that makes a guard look
  // present and be absent.
  for (const name of names) {
    const body = constraintBody(name);
    assert.ok(!/\bor true\b/i.test(body), `${name} contains an "or true" escape hatch`);
    assert.ok(!/\bor 1 = 1\b/.test(body), `${name} contains a tautology`);
    assert.ok(!/\bor not false\b/i.test(body), `${name} contains a tautology`);
  }
  // Nor may a plpgsql guard be short-circuited the same way.
  for (const fn of (sql.match(/create function public\.(\w+)/g) || [])
    .map(m => /create function public\.(\w+)/.exec(m)[1])) {
    assert.ok(!/\bor true\b|\band false\b/i.test(functionBody(fn)),
      `${fn} contains a tautological short-circuit`);
  }
});

/* ══════════════════════════════════════════════════════════════
   11. CUSTOMER SHIPPING IS DELIBERATELY UNPRICED
   ══════════════════════════════════════════════════════════════ */

test("41: the three customer shipping columns are nullable with NO default", () => {
  for (const column of ["customer_shipping_net_cents", "customer_shipping_tax_cents",
                        "customer_shipping_gross_cents"]) {
    const declaration = new RegExp(`${column}\\s+integer([^,\\n]*)`).exec(deliveryTable);
    assert.ok(declaration, `${column} is missing`);
    assert.ok(!/not null/i.test(declaration[1]), `${column} must be nullable - no price rule exists`);
    assert.ok(!/default/i.test(declaration[1]), `${column} must have no default`);
  }
});

test("42: nothing derives a customer shipping price, and Berlin is not defaulted to zero", () => {
  // The carrier reference cost is DHL's RETAIL price INCLUDING VAT. It is
  // not a B2B net price and it is not a VAT base.
  assert.ok(!/customer_shipping_[a-z_]+\s*=\s*[^;]*carrierRetailGrossCents/.test(flat),
    "the carrier retail cost is being copied into a customer charge");
  assert.ok(!/customer_shipping_net_cents\s+integer[^,]*default\s*0/.test(deliveryTable),
    "Berlin is being defaulted to a zero customer charge");
  // No tax rate is assigned to shipping anywhere.
  assert.ok(!/customer_shipping_tax_cents[^,;]*=\s*\(2 \*/.test(flat),
    "a VAT determination is being made for shipping, which lib/tax.ts has not approved");
  assert.ok(!/customer_shipping[a-z_]*\s*=\s*7\b/.test(flat));
});

test("43: if they are written at all, they are written coherently - and only that", () => {
  const allOrNone = constraintBody("b2b_deliveries_customer_shipping_all_or_none_check");
  assert.ok(allOrNone.includes("(customer_shipping_net_cents is null) = (customer_shipping_tax_cents is null)"));
  assert.ok(allOrNone.includes("(customer_shipping_net_cents is null) = (customer_shipping_gross_cents is null)"));
  const nonNegative = constraintBody("b2b_deliveries_customer_shipping_non_negative_check");
  for (const column of ["customer_shipping_net_cents", "customer_shipping_tax_cents",
                        "customer_shipping_gross_cents"]) {
    assert.ok(nonNegative.includes(`${column} >= 0`), `${column} may go negative`);
  }
  // Zero IS allowed here, unlike an instalment: a shipping charge of
  // nothing is a real charge, an instalment of nothing is not.
  assert.ok(!/customer_shipping_net_cents > 0/.test(flat));
  assert.ok(constraintBody("b2b_deliveries_customer_shipping_sum_check").includes(
    "customer_shipping_gross_cents::bigint = customer_shipping_net_cents::bigint + customer_shipping_tax_cents::bigint"));
});

/* ══════════════════════════════════════════════════════════════
   12. CARDINALITY AND THE CROSS-TABLE ASSERTION
   ══════════════════════════════════════════════════════════════ */

test("44: the two identity uniques exist, and the correlation uniques are partial", () => {
  assert.ok(flat.includes(
    "create unique index b2b_payment_schedule_agreement_instalment_key on public.b2b_payment_schedule (supply_agreement_id, instalment_number)"));
  assert.ok(flat.includes(
    "create unique index b2b_deliveries_agreement_number_key on public.b2b_deliveries (supply_agreement_id, delivery_number)"));
  for (const [table, column] of [["b2b_deliveries", "order_id"],
                                 ["b2b_deliveries", "stripe_invoice_id"]]) {
    assert.ok(new RegExp(`create unique index \\w+ on public\\.${table} \\(${column}\\) where ${column} is not null`)
      .test(flat), `${table}.${column} has no partial unique index`);
  }
  // No ordinary index duplicating a unique on the same columns.
  const ordinary = (flat.match(/create index (\w+) on public\.\w+ \(([^)]*)\)/g) || []);
  assert.strictEqual(ordinary.length, 2, "only the two worker indexes may be non-unique");
  assert.ok(flat.includes("create index idx_b2b_payment_schedule_due on public.b2b_payment_schedule (status, due_at) where status in"),
    "the payment worker index must be partial on the non-terminal statuses");
  assert.ok(flat.includes("create index idx_b2b_deliveries_scheduled on public.b2b_deliveries (status, scheduled_for) where status in"),
    "the delivery worker index must be partial on the non-terminal statuses");
});

test("45: ACTIVE ANNUAL - exact instalment cardinality, contiguity and net sum", () => {
  const body = functionBody("assert_b2b_commerce_integrity");
  assert.ok(body.includes("v_pay_count <> v_instalment_count"),
    "the payment row count is not tied to the parent's instalment_count");
  assert.ok(body.includes("v_pay_sum is distinct from v_contract_net_cents::bigint"),
    "the instalment net sum is not reconciled against the frozen contract total");
  // IS DISTINCT FROM, so a NULL contract total is a violation rather than
  // an UNKNOWN that passes.
  assert.ok(!/v_pay_sum <> v_contract_net_cents/.test(body),
    "a <> comparison would let a NULL contract total pass silently");
  assert.ok(body.includes("v_pay_min <> 1 or v_pay_max <> v_pay_count"),
    "instalment numbering contiguity is not asserted");
  // n is whatever 059 admitted - this file does not restate 1, 2, 4.
  assert.deepStrictEqual(B2B_INSTALMENT_COUNTS.slice(), [1, 2, 4]);
  assert.ok(!/instalment_count in \(1, 2, 4\)/.test(sql),
    "060 restates 059's instalment authority instead of reading it");
});

test("46: ACTIVE ANNUAL - exactly twelve deliveries, from the Package 1 constant", () => {
  const body = functionBody("assert_b2b_commerce_integrity");
  assert.strictEqual(B2B_ANNUAL_DELIVERY_COUNT, 12);
  assert.ok(body.includes(`v_del_count <> ${B2B_ANNUAL_DELIVERY_COUNT}`),
    "the annual delivery count has drifted from B2B_ANNUAL_DELIVERY_COUNT");
  assert.ok(body.includes("v_del_min <> 1 or v_del_max <> v_del_count"),
    "delivery numbering contiguity is not asserted");
});

test("47: ACTIVE MONTHLY - zero payment rows, and rolling deliveries", () => {
  const body = functionBody("assert_b2b_commerce_integrity");
  const monthly = /if v_plan_type = 'monthly' then([\s\S]*?)end if;/.exec(body);
  assert.ok(monthly, "the monthly branch is missing");
  assert.ok(monthly[1].includes("v_pay_count <> 0"),
    "an active monthly agreement may carry payment schedule rows - Stripe already bills it");
  // Monthly deliveries roll. No fixed count is imposed.
  assert.ok(!/v_plan_type = 'monthly'[\s\S]{0,400}v_del_count <> \d+/.test(body),
    "a monthly agreement is being forced to a fixed delivery count");
  // But contiguity still holds, and it is asserted BEFORE the status gate
  // so it applies to pending agreements too.
  const contiguity = body.indexOf("v_del_min <> 1");
  const statusGate = body.indexOf("if v_status <> 'active' then");
  assert.ok(contiguity !== -1 && statusGate !== -1 && contiguity < statusGate,
    "numbering contiguity must hold regardless of status");
});

test("48: a PENDING agreement can still be built transactionally", () => {
  const body = functionBody("assert_b2b_commerce_integrity");
  assert.ok(/if v_status <> 'active' then\s*return;/.test(body),
    "the cardinality rules must not bind before activation");
  // A legacy agreement gets no new rule at all, exactly as in 059.
  assert.ok(/if v_plan_type is null then\s*return;/.test(body));
  // And a missing agreement is not an error: ON DELETE RESTRICT means it
  // cannot vanish under live children.
  assert.ok(/if not found then\s*return;/.test(body));
});

test("49: the deferred assertion is triggered from the PARENT and BOTH children", () => {
  for (const [table, events] of [
    ["b2b_supply_agreements", "after insert or update"],
    ["b2b_payment_schedule", "after insert or update or delete"],
    ["b2b_deliveries", "after insert or update or delete"],
  ]) {
    const trigger = new RegExp(
      `create constraint trigger (\\w+) ${events} on public\\.${table} deferrable initially deferred for each row execute function public\\.(\\w+)\\(\\)`);
    assert.ok(trigger.test(flat),
      `${table} has no DEFERRABLE INITIALLY DEFERRED constraint trigger for the cross-table assertion`);
  }
  // Deferred, because one transaction builds the agreement, its schedule
  // and its deliveries in whatever order it likes and is only coherent at
  // COMMIT.
  assert.strictEqual((flat.match(/deferrable initially deferred/g) || []).length, 3);
});

test("50: OLD and NEW are only read inside the TG_OP branch that assigns them", () => {
  for (const fn of ["b2b_payment_schedule_integrity_trigger", "b2b_deliveries_integrity_trigger"]) {
    const body = functionBody(fn);
    // The DELETE branch returns before anything reads NEW.
    const deleteArm = /if tg_op = 'DELETE' then([\s\S]*?)end if;/.exec(body);
    assert.ok(deleteArm, `${fn} has no DELETE branch`);
    assert.ok(!deleteArm[1].includes("new."), `${fn} reads NEW on DELETE`);
    assert.ok(/return null;/.test(deleteArm[1]), `${fn}'s DELETE branch must return`);
    // OLD is read only under a nested tg_op = 'UPDATE' test - never in a
    // single condition that would evaluate OLD on INSERT.
    assert.ok(/if tg_op = 'UPDATE' then\s*if old\./.test(body),
      `${fn} must nest the OLD test inside the TG_OP test`);
    assert.ok(!/tg_op = 'UPDATE' and old\./.test(body),
      `${fn} evaluates OLD in a conjunction that also fires on INSERT`);
    // A row moved between agreements leaves one parent and joins another.
    assert.ok(body.includes("old.supply_agreement_id is distinct from new.supply_agreement_id"),
      `${fn} does not revalidate the parent a row moved away from`);
  }
  // The parent wrapper fires on INSERT and UPDATE only, so it never
  // touches OLD at all.
  const parent = functionBody("b2b_supply_agreements_commerce_integrity_trigger");
  assert.ok(!parent.includes("old."), "the parent wrapper reads OLD but also fires on INSERT");
});

/* ══════════════════════════════════════════════════════════════
   13. RLS, PRIVILEGES AND THE ABSENT WRITE SURFACE
   ══════════════════════════════════════════════════════════════ */

test("51: RLS is enabled on both tables", () => {
  for (const table of [PAYMENTS, DELIVERIES]) {
    assert.ok(flat.includes(`alter table ${table} enable row level security`),
      `${table} has no RLS`);
  }
});

test("52: the only policy is own-business SELECT, through the parent agreement", () => {
  const policies = (flat.match(/create policy "([^"]+)" on public\.(\w+) for (\w+)/g) || []);
  assert.strictEqual(policies.length, 2, "060 must create exactly two policies");
  for (const p of policies) {
    assert.ok(/ for select$/.test(p), `a non-SELECT policy exists: ${p}`);
  }
  for (const table of ["b2b_payment_schedule", "b2b_deliveries"]) {
    const policy = new RegExp(
      `create policy "[^"]+" on public\\.${table} for select using \\(([\\s\\S]*?)\\);`).exec(flat);
    assert.ok(policy, `${table} has no SELECT policy`);
    assert.ok(policy[1].includes("from public.b2b_supply_agreements a"),
      `${table}'s policy does not resolve ownership through the parent agreement`);
    assert.ok(policy[1].includes("a.user_id = auth.uid()"),
      `${table}'s policy does not restrict to the caller's own rows`);
    assert.ok(policy[1].includes("public.is_business_user()"),
      `${table}'s policy is missing the business gate 006 established`);
    assert.ok(policy[1].includes(`a.id = ${table}.supply_agreement_id`),
      `${table}'s policy does not join on its own agreement id`);
  }
  for (const forbidden of ["for insert", "for update", "for delete", "for all"]) {
    assert.ok(!flat.includes(`create policy "${forbidden}`) && !new RegExp(`for ${forbidden.slice(4)} `).test(
      (flat.match(/create policy[\s\S]*?using/g) || []).join(" ")),
      `a ${forbidden} policy exists - Package 4B adds no write surface`);
  }
});

test("53: privileges are revoked first, then SELECT only - and anon gets nothing", () => {
  for (const table of [PAYMENTS, DELIVERIES]) {
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      assert.ok(flat.includes(`revoke all privileges on table ${table} from ${role}`),
        `${table} does not revoke from ${role} before granting`);
    }
    assert.ok(flat.includes(`grant select on table ${table} to authenticated`));
    assert.ok(flat.includes(`grant select on table ${table} to service_role`));
    // The revoke must come before the grant, or it undoes it.
    assert.ok(flat.indexOf(`revoke all privileges on table ${table} from service_role`)
      < flat.indexOf(`grant select on table ${table} to authenticated`),
      `${table} grants before it revokes`);
  }
  // NO write privilege for anybody, including service_role. Package 5
  // brings the writer and its privileges together.
  for (const verb of ["insert", "update", "delete", "truncate", "all privileges", "all"]) {
    assert.ok(!new RegExp(`grant ${verb} on table`).test(flat),
      `060 grants ${verb} on a table - 4B is read-only`);
  }
  // And anon is never a grantee of anything.
  assert.ok(!/grant [a-z ]+ on table [\w.]+ to anon/.test(flat),
    "anon must hold no privilege on a B2B commercial contract");
});

test("54: every function is SECURITY DEFINER with a pinned empty search_path", () => {
  const fns = (sql.match(/create function public\.(\w+)/g) || [])
    .map(m => /create function public\.(\w+)/.exec(m)[1]);
  assert.strictEqual(fns.length, 7, "060 creates exactly seven functions");
  for (const fn of fns) {
    const header = new RegExp(
      `create function public\\.${fn}\\([^)]*\\)[\\s\\S]*?as \\$\\$`).exec(sql);
    assert.ok(header, `${fn} has no header`);
    assert.ok(/security definer/.test(header[0]), `${fn} is not SECURITY DEFINER`);
    assert.ok(/set search_path = ''/.test(header[0]), `${fn} has no pinned empty search_path`);
  }
  // With search_path = '' every reference must be schema-qualified.
  for (const fn of fns) {
    const body = functionBody(fn);
    for (const relation of ["b2b_supply_agreements", "b2b_payment_schedule", "b2b_deliveries"]) {
      const bare = new RegExp(`(?<!public\\.)\\b${relation}\\b`);
      assert.ok(!bare.test(body),
        `${fn} references ${relation} without a schema, which fails under search_path = ''`);
    }
  }
});

test("55: EXECUTE is revoked from all four roles on all seven, and granted to nobody", () => {
  const fns = (sql.match(/create function public\.(\w+)\(([^)]*)\)/g) || [])
    .map(m => {
      const parsed = /create function public\.(\w+)\(([^)]*)\)/.exec(m);
      // The REVOKE names the SIGNATURE, so an argument type that drifts
      // would silently revoke on nothing.
      const args = parsed[2].trim() === ""
        ? ""
        : parsed[2].split(",").map(a => a.trim().split(/\s+/).pop()).join(", ");
      return `${parsed[1]}(${args})`;
    });
  for (const signature of fns) {
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      assert.ok(flat.includes(`revoke all on function public.${signature} from ${role}`),
        `EXECUTE on ${signature} is not revoked from ${role}`);
    }
  }
  assert.ok(!/grant execute on function/.test(flat),
    "060 grants EXECUTE to somebody - none of its functions is callable by design");
});

/* ══════════════════════════════════════════════════════════════
   14. NO WORKFLOW, AND THE SUITE IS WIRED IN
   ══════════════════════════════════════════════════════════════ */

test("56: 060 is schema and integrity only - no workflow of any kind", () => {
  for (const forbidden of [
    "create_", "activate_", "cancel_", "claim_", "retry_", "dunning",
    "send_", "email", "invoice_create", "checkout", "order_status",
    "inventory", "reserve_", "fulfil", "fulfill",
  ]) {
    assert.ok(!new RegExp(`function public\\.\\w*${forbidden}`, "i").test(sql),
      `060 defines a ${forbidden} function - that is Package 5's work`);
  }
  // No view, no materialized view, no scheduled job, no extension.
  for (const forbidden of [/create\s+(or replace\s+)?view/i, /materialized view/i,
                           /cron\./i, /create\s+extension/i, /create\s+type/i,
                           /create\s+sequence/i]) {
    assert.ok(!forbidden.test(sql), `060 must not contain ${forbidden}`);
  }
});

test("57: no migration up to 059 is modified in the working tree", () => {
  const changed = execFileSync("git",
    ["diff", "--name-only", "--diff-filter=MD", "HEAD", "--", "supabase/migrations/"],
    { cwd: ROOT, encoding: "utf-8" }).trim();
  // 063 IS NOT APPLIED ANYWHERE. Production is 058+059+060+061+062, so
  // 063 is still the right place to fix 063 and may be edited in place -
  // the terms every pending migration has had. Everything BELOW it is
  // live. Remove this the moment 063 is applied;
  // tests/b2b-pending-agreement-writer.test.mjs test 50 enforces that.
  assert.deepEqual(
    (changed ? changed.split(/\r?\n/) : [])
      .filter(r => !r.endsWith("063_b2b_instalment_delivery_failure_runtime.sql")),
    [], `060 must add a file, not edit a live migration: ${changed}`);
  // And 059 is exactly where it was left.
  const files = readdirSync(MIGRATIONS).filter(f => f.endsWith(".sql")).sort();
  assert.strictEqual(files[files.length - 5], "059_b2b_supply_commerce_foundation.sql");
  assert.strictEqual(files[files.length - 4], MIGRATION);
  assert.strictEqual(files.length, 63);
});

test("58: 060 is registered in the npm test script", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.ok(pkg.scripts.test.includes("tests/b2b-payment-delivery-foundation.test.mjs"),
    "the focused 060 suite does not run in the gate");
});

/* ══════════════════════════════════════════════════════════════
   15. THE FINAL INTEGRITY CORRECTIONS
   ══════════════════════════════════════════════════════════════ */

test("59: the annual split is the Package 1 allocation, not merely the right total", () => {
  // ══════════════════════════════════════════════════════════
  // THE FAILURE MODE THIS CATCHES
  // ══════════════════════════════════════════════════════════
  // SUM(net_cents) = contract_product_net_cents is necessary and NOT
  // sufficient. 53551 across four instalments sums correctly as
  // 13387/13387/13387/13390 and equally correctly as 53548/1/1/1 - and
  // only the first is the schedule the customer agreed to.
  const { annual, annualFlat } = assertionRegions();
  assert.ok(annualFlat.includes("v_base_cents := v_contract_net_cents::bigint / v_instalment_count::bigint"),
    "the base instalment is not floor(T / n) in bigint");
  assert.ok(annualFlat.includes("p.instalment_number < v_instalment_count"),
    "the allocation does not distinguish the last instalment from the rest");
  assert.ok(annualFlat.includes("v_contract_net_cents::bigint - v_base_cents * (v_instalment_count::bigint - 1)"),
    "the last instalment is not T - base * (n - 1), so the remainder lands in the wrong place");
  assert.ok(annualFlat.includes("p.net_cents::bigint is distinct from"),
    "the per-row allocation is not compared, or compares with <> and loses NULLs");
  assert.ok(/v_alloc_mismatch > 0/.test(annual), "an allocation mismatch is counted but never raised");
  // The sum rule is KEPT as well - it is cheap and it names a different
  // defect than a per-row mismatch does.
  assert.ok(annualFlat.includes("v_pay_sum is distinct from v_contract_net_cents::bigint"));

  // AND THE SQL RULE IS THE TYPESCRIPT'S, re-executed for every annual
  // contract this shop can sell, split every approved way.
  let rows = 0;
  for (let packs = B2B_MIN_PACKS; packs <= B2B_SELF_SERVICE_MAX_PACKS; packs += 1) {
    for (const n of B2B_INSTALMENT_COUNTS) {
      const total = annualProductNetCents(packs);
      const fromTs = allocateInstalments(total, n);
      const base = Math.floor(total / n);
      for (let i = 1; i <= n; i += 1) {
        rows += 1;
        const fromSql = i < n ? base : total - base * (n - 1);
        assert.strictEqual(fromSql, fromTs[i - 1],
          `the SQL allocation differs from allocateInstalments at ${packs} packs, ${n} instalments, row ${i}`);
      }
    }
  }
  assert.ok(rows >= 70, `expected every instalment row to be checked, got ${rows}`);
  // The worked example from the review, stated so it cannot drift.
  const base53551 = Math.floor(53551 / 4);
  assert.deepStrictEqual([1, 2, 3, 4].map(i => (i < 4 ? base53551 : 53551 - base53551 * 3)),
    [13387, 13387, 13387, 13390]);
  assert.deepStrictEqual(allocateInstalments(53551, 4), [13387, 13387, 13387, 13390]);
});

test("60: the allocation cannot divide by zero, and says so before it tries", () => {
  const { annualFlat } = assertionRegions();
  const guard = annualFlat.indexOf("v_instalment_count is null or v_instalment_count <= 0");
  const division = annualFlat.indexOf("v_contract_net_cents::bigint / v_instalment_count::bigint");
  assert.ok(guard !== -1, "nothing refuses a null or zero instalment count before the division");
  assert.ok(guard < division,
    "the division runs before the guard, so a zero instalment count raises division_by_zero rather than a named violation");
  assert.ok(annualFlat.includes("v_contract_net_cents is null"),
    "a null contract total would make every row mismatch rather than naming the real defect");
});

test("61: the five tax facts are ALL NULL or ALL populated - no partial row", () => {
  // THE FAILURE MODE THIS CATCHES: a scheduled row carrying
  // tax_rate_percent = 7 and nothing else. Every per-column rule admits
  // it, and every pairwise reconciliation only fires when BOTH of its
  // operands exist, so half a tax fact would pass as "not established".
  const body = constraintBody("b2b_payment_schedule_tax_facts_all_or_none_check");
  for (const column of ["tax_rate_percent", "tax_cents", "gross_cents",
                        "tax_calculation_version", "price_origin"]) {
    assert.ok(body.includes(`(${column} is null)::int`),
      `${column} is not part of the all-or-none count`);
  }
  assert.ok(/in \(0, 5\)/.test(body),
    "the all-or-none rule must admit exactly zero or five NULLs");
  // (x IS NULL) is a boolean that is never itself NULL, so this rule
  // cannot evaluate to UNKNOWN - which is why it needs no IS TRUE.
  assert.ok(!/is null or/.test(body), "the rule must not be short-circuited by a null escape");

  // AND THE STATUS RULES ARE UNCHANGED ON TOP OF IT.
  const established = constraintBody("b2b_payment_schedule_tax_established_check");
  for (const status of ["invoiced", "action_required", "payment_failed", "paid"]) {
    assert.ok(established.includes(`'${status}'`), `${status} no longer requires complete tax facts`);
  }
  assert.ok(!established.includes("'scheduled'") && !established.includes("'void'"),
    "scheduled and void must still be allowed to carry no tax at all");
  // Both remain reconciled whenever they exist, whatever the status - so
  // a void row that preserved its facts preserved correct ones.
  assert.ok(!constraintBody("b2b_payment_schedule_gross_sum_check").includes("status"));
  assert.ok(!constraintBody("b2b_payment_schedule_gross_formula_check").includes("status"));
});

test("62: the three routing authorities cannot disagree", () => {
  // A: shipping_class   B: berlin_eligibility_snapshot.eligible
  // C: shipping_snapshot.mode / chargeStatus
  const body = constraintBody("b2b_deliveries_routing_decision_agrees_check");
  // Berlin: eligible = true, and the free-local pair.
  assert.ok(body.includes("shipping_class = 'berlin_local'"));
  assert.ok(body.includes("berlin_eligibility_snapshot->>'eligible' = 'true'"),
    "a Berlin-classed delivery does not require an eligible verdict");
  assert.ok(body.includes("shipping_snapshot->>'chargeStatus' = 'free_local_delivery'"));
  // DHL: eligible = false, and the carrier-resolved pair. The NEGATIVE
  // verdict is REQUIRED here, not merely tolerated - it is the reason
  // the delivery is a DHL delivery.
  assert.ok(body.includes("shipping_class = 'dhl'"));
  assert.ok(body.includes("berlin_eligibility_snapshot->>'eligible' = 'false'"),
    "a DHL-classed delivery does not require an ineligible verdict");
  assert.ok(body.includes("shipping_snapshot->>'chargeStatus' = 'carrier_reference_resolved'"));
  assert.ok(body.endsWith(") is true"), "an absent key would pass as UNKNOWN");
  // ->> on a JSON boolean yields 'true'/'false' text, so nothing here
  // can raise: no cast, no jsonb function that needs a type.
  assert.ok(!/::/.test(body), "the routing agreement must not depend on a cast");
  // BOTH verdicts stay storable - the constraint requires agreement, not
  // eligibility.
  assert.ok(berlinCheck.includes("'country_not_germany'"),
    "the negative Berlin reasons must remain storable");
  // And the class is still tied to the mode by its own constraint.
  assert.ok(constraintBody("b2b_deliveries_shipping_class_matches_snapshot_check")
    .includes("shipping_snapshot->>'mode' = shipping_class"));
});

test("63: a resolved delivery's address is the repo's canonical snapshot, not an empty object", () => {
  const body = constraintBody("b2b_deliveries_address_snapshot_shape_check");
  // THE SHAPE IS NOT INVENTED. It is AddressSnapshot from
  // lib/orderAddressSnapshot.ts, which the order and subscription
  // snapshots already use - read from the file rather than from memory.
  const addressModule = read("lib/orderAddressSnapshot.ts");
  const declared = /export type AddressSnapshot = \{([\s\S]*?)\};/.exec(addressModule);
  assert.ok(declared, "lib/orderAddressSnapshot.ts no longer declares AddressSnapshot");
  const keys = (declared[1].match(/^\s*(\w+):/gm) || []).map(k => k.trim().replace(":", ""));
  assert.deepStrictEqual(keys.slice().sort(),
    ["city", "company", "country", "line1", "line2", "name", "postalCode", "state"],
    "the canonical address shape moved - 060 pins a shape that no longer exists");
  // The key-EXISTENCE proof is what refuses a partial object, so every
  // canonical key must be inside the ?& array itself - not merely
  // mentioned somewhere further down in a type test, which a partial
  // object would never reach.
  const existence = /\?& array\[([^\]]*)\]/.exec(body);
  assert.ok(existence, "the address constraint has no ?& key-existence proof");
  const proved = (existence[1].match(/'[a-zA-Z][a-zA-Z0-9]*'/g) || []).map(q => q.slice(1, -1));
  assert.deepStrictEqual(proved.slice().sort(), keys.slice().sort(),
    "the ?& array does not prove exactly the canonical address keys");
  for (const key of keys) {
    assert.ok(body.includes(`jsonb_typeof(delivery_address_snapshot->'${key}') in ('string', 'null')`),
      `${key} is required without a type - and it may legitimately be null`);
  }
  // No key is demanded that the producer does not emit, and none is renamed.
  for (const quoted of body.match(/'[a-zA-Z][a-zA-Z0-9]*'/g) || []) {
    const token = quoted.slice(1, -1);
    if (["string", "null", "object"].includes(token)) continue;
    assert.ok(keys.includes(token),
      `the address constraint references '${token}', which AddressSnapshot does not declare`);
  }
  assert.ok(!body.includes("'postcode'"),
    "postalCode must not be renamed to postcode - that is the Berlin resolver's input name, not the snapshot's");

  // An empty object, an array and a bare string are all refused.
  assert.ok(body.includes("jsonb_typeof(delivery_address_snapshot) = 'object'"),
    "an array or a bare string could pass as an address");
  assert.ok(body.includes("delivery_address_snapshot <> '{}'::jsonb"),
    "the empty object is not explicitly refused");
  assert.ok(body.includes("?&"), "an empty or partial object is not refused by key existence");
  assert.ok(body.endsWith(") is true"));

  // AND A ROUTED DELIVERY NEEDS AN ADDRESS THAT CAN BE CARRIED TO.
  const deliverable = constraintBody("b2b_deliveries_resolved_address_is_deliverable_check");
  assert.ok(deliverable.startsWith("resolved_at is null or"),
    "the deliverability rule must bind only once the delivery is routed");
  for (const key of ["line1", "postalCode", "country"]) {
    assert.ok(deliverable.includes(`jsonb_typeof(delivery_address_snapshot->'${key}') = 'string'`),
      `a routed delivery may still have a null ${key}`);
  }
  assert.ok(deliverable.endsWith(") is true"));
  // The Berlin verdict frozen beside it was derived from exactly these.
  assert.strictEqual(typeof berlinEligible.normalizedCountry, "string");
  assert.strictEqual(typeof berlinEligible.normalizedPostcode, "string");
});
