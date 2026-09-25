import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  B2B_ANNUAL_DELIVERY_COUNT,
  B2B_ANNUAL_DISCOUNT_PERCENT,
  B2B_ANNUAL_RETAINED_PERCENT,
  B2B_CURRENCY,
  B2B_INSTALMENT_COUNTS,
  B2B_MIN_PACKS,
  B2B_PACK_GRAMS,
  B2B_PRICING_RULES_VERSION,
  B2B_SELF_SERVICE_MAX_PACKS,
  PACK_NET_CENTS,
  annualProductNetCents,
  buildB2bAnnualPricing,
  buildB2bMonthlyPricing,
  monthlyProductNetCents,
} from "../lib/b2bPricingRules.ts";
import { NET_ORIGIN_TAX_CALCULATION_VERSION, netOriginTaxMetadata } from "../lib/tax.ts";

/**
 * 059 — B2B SELF-SERVICE SUPPLY COMMERCE FOUNDATION.
 *
 * Migration 059 evolves the two tables migration 006 built for a
 * NEGOTIATED wholesale agreement into the schema a self-service B2B
 * contract needs, and enforces in the database what Packages 1 to 3
 * established in TypeScript.
 *
 * ── WHAT THIS SUITE IS PROTECTING ─────────────────────────────
 *
 *   1. THE DATABASE AGREES WITH THE TYPESCRIPT. Every commercial
 *      constant in the SQL is compared against the exported constant it
 *      came from, and the annual contract formula is RE-EXECUTED in
 *      integer arithmetic against annualProductNetCents() for every
 *      admitted pack count. A literal that drifts from lib/ reds this
 *      suite rather than shipping two price lists.
 *
 *   2. THE PRICING SNAPSHOT CONSTRAINT REQUIRES WHAT THE BUILDERS
 *      ACTUALLY EMIT. The required key set is derived by CALLING
 *      buildB2bMonthlyPricing / buildB2bAnnualPricing and
 *      netOriginTaxMetadata, so a constraint demanding a key no producer
 *      writes - which would reject every real row - cannot pass here.
 *
 *   3. THREE-VALUED LOGIC. A PostgreSQL CHECK passes on TRUE **or
 *      NULL**, so every compound self-service predicate must terminate
 *      in `) is true`. That is asserted per constraint, not once.
 *
 *   4. NOTHING DESTRUCTIVE. No DROP COLUMN/TABLE/INDEX/CONSTRAINT, no
 *      DML, no seed row, no privilege or policy change, and the legacy
 *      anonymous status CHECK from 006 left completely alone.
 *
 *   5. THE DECISIONS THAT WERE MADE BY REMOVING SOMETHING. activated_at,
 *      term_end_at, stripe_customer_id and any one-agreement-per-user
 *      unique are each asserted ABSENT, because "we decided not to" is
 *      only durable if a test says so.
 *
 * SAFE: reads SQL, TypeScript and the git index. No database, no
 * network, no Stripe, no clock.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf-8");

const MIGRATION = "059_b2b_supply_commerce_foundation.sql";
const migration = read(`supabase/migrations/${MIGRATION}`);

/**
 * SQL with line comments stripped. Every assertion about what this
 * migration DOES runs against this, so the header - which deliberately
 * names the things it refuses to do, "NO DROP COLUMN" included - can
 * neither satisfy nor break one.
 */
const sql = migration.replace(/^\s*--.*$/gm, "");

/** One SQL string with runs of whitespace flattened, for predicate matching. */
const flat = sql.replace(/\s+/g, " ");

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

/* ══════════════════════════════════════════════════════════════
   1. THE FILE, AND ITS ONE TRANSACTION
   ══════════════════════════════════════════════════════════════ */

test("1: 059 owns its number, and only the reviewed 060 follows it", () => {
  const files = readdirSync(path.join(ROOT, "supabase/migrations")).filter(f => f.endsWith(".sql"));
  assert.ok(files.includes(MIGRATION), "059 is missing");

  // PACKAGE 4B ADDED MIGRATION 060: the B2B payment schedule and
  // delivery foundation, which 059 was deliberately written to be
  // followed by - its header names 060 as the owner of the instalment
  // and delivery tables. Re-pinned rather than deleted: what this guard
  // protects is that 059 still occupies its own number and that nothing
  // UNREVIEWED appeared above it. Reviewed in
  // tests/b2b-payment-delivery-foundation.test.mjs.
  const numbers = files.map(f => Number(f.slice(0, 3))).filter(n => Number.isInteger(n));
  assert.strictEqual(Math.max(...numbers), 60, "060 must be the newest migration");
  assert.deepStrictEqual(files.filter(f => Number(f.slice(0, 3)) > 59).sort(),
    ["060_b2b_payment_delivery_foundation.sql"],
    "a migration above 059 appeared that this suite has not been reviewed against");
  assert.strictEqual(files.filter(f => f.startsWith("061")).length, 0,
    "061 must NOT be authored in this package");
  assert.strictEqual(files.filter(f => f.startsWith("059")).length, 1,
    "there must be exactly one 059");
});

test("2: it is transactional - exactly one begin and one commit", () => {
  assert.strictEqual((sql.match(/^begin;$/gm) || []).length, 1);
  assert.strictEqual((sql.match(/^commit;$/gm) || []).length, 1);
  assert.ok(sql.indexOf("\nbegin;") < sql.indexOf("\ncommit;"));
  // No rollback and no savepoint games: it applies whole or not at all.
  assert.ok(!/\brollback\b/i.test(sql));
  assert.ok(!/\bsavepoint\b/i.test(sql));
});

test("3: nothing destructive, and no DML against business data", () => {
  // DROP is permitted in exactly two shapes, both of which only WIDEN a
  // domain: drop not null and drop default.
  const drops = (sql.match(/\bdrop\s+[a-z ]+/gi) || []).map(d => d.trim().toLowerCase());
  for (const d of drops) {
    assert.ok(/^drop (not null|default)\b/.test(d),
      `059 must not contain "${d}" - only "drop not null" and "drop default" are allowed`);
  }
  for (const forbidden of [
    /\bdrop\s+column\b/i, /\bdrop\s+table\b/i, /\bdrop\s+index\b/i,
    /\bdrop\s+constraint\b/i, /\bdrop\s+trigger\b/i, /\bdrop\s+function\b/i,
    /\bdrop\s+policy\b/i, /\btruncate\b/i,
    /\bdelete\s+from\b/i, /\binsert\s+into\b/i, /^\s*update\s+public\./im,
  ]) {
    assert.ok(!forbidden.test(sql), `059 must not contain ${forbidden}`);
  }
  // And no privilege or policy surface change of any kind on the tables.
  assert.ok(!/\bcreate\s+policy\b/i.test(sql));
  assert.ok(!/\balter\s+policy\b/i.test(sql));
  assert.ok(!/row\s+level\s+security/i.test(sql));
  assert.ok(!/\bgrant\b/i.test(sql), "059 grants nothing - not even execute");
  assert.ok(!/revoke[\s\S]*?on\s+table/i.test(sql), "059 changes no table privilege");
});

test("4: only the two existing tables are touched - no table is created", () => {
  assert.ok(!/\bcreate\s+table\b/i.test(sql),
    "the payment schedule and delivery tables belong to 060, not 059");
  const altered = new Set((sql.match(/alter table public\.(\w+)/g) || [])
    .map(m => m.replace("alter table public.", "")));
  assert.deepStrictEqual([...altered].sort(), ["b2b_supply_agreements", "b2b_supply_items"]);
});

/* ══════════════════════════════════════════════════════════════
   2. THE COLUMNS, AND THE THREE THAT MUST NOT EXIST
   ══════════════════════════════════════════════════════════════ */

const EXPECTED_COLUMNS = [
  "plan_type",
  "pricing_rules_version",
  "pack_grams",
  "pack_net_cents",
  "quantity_packs",
  "discount_percent",
  "delivery_count",
  "base_monthly_product_net_cents",
  "contract_product_net_cents",
  "instalment_count",
  "pricing_snapshot",
  "checkout_attempt_id",
  "stripe_subscription_id",
  "cancellation_requested_at",
  "cancellation_effective_at",
  "cancellation_reason",
  "termination_reason",
];

test("5: exactly the approved agreement columns are added, plus item_role", () => {
  const added = (sql.match(/add column (\w+)/g) || []).map(m => m.replace("add column ", ""));
  assert.deepStrictEqual(
    added.filter(c => c !== "item_role").sort(),
    [...EXPECTED_COLUMNS].sort(),
  );
  assert.strictEqual(added.filter(c => c === "item_role").length, 1);
  // No IF NOT EXISTS anywhere: preflight proved these are absent, so
  // unexpected drift must fail the migration rather than be accepted.
  assert.ok(!/if not exists/i.test(sql));
});

test("6: activated_at, term_end_at and stripe_customer_id are NOT added", () => {
  // Three deliberate removals. started_at and commitment_end_at already
  // mean the first two; the canonical Stripe customer mapping already
  // exists in stripe_customers / checkout_attempts / the identity table.
  for (const absent of ["activated_at", "term_end_at", "stripe_customer_id"]) {
    assert.ok(!new RegExp(`add column ${absent}\\b`).test(sql),
      `${absent} must not be added by 059`);
  }
});

test("7: the existing 006 lifecycle columns are reused, never re-declared", () => {
  for (const reused of ["started_at", "commitment_months", "commitment_end_at", "ended_at"]) {
    assert.ok(!new RegExp(`add column ${reused}\\b`).test(sql));
    assert.ok(flat.includes(reused), `${reused} must actually be used by 059's rules`);
  }
  // next_delivery_at exists and is deliberately left to Package 5's
  // scheduler; 059 neither re-declares nor constrains it.
  assert.ok(!/add column next_delivery_at\b/.test(sql));
});

/* ══════════════════════════════════════════════════════════════
   3. THE CLOSED WORLD AGREES WITH lib/b2bPricingRules.ts
   ══════════════════════════════════════════════════════════════ */

test("8: the pricing authority is the exported version, and nothing else", () => {
  assert.strictEqual(B2B_PRICING_RULES_VERSION, "b2b-2026.1");
  assert.ok(constraintBody("b2b_supply_agreements_pricing_rules_version_check")
    .includes(`pricing_rules_version = '${B2B_PRICING_RULES_VERSION}'`));
  // Unguarded by plan_type on purpose: the column exists for one
  // authority, so an unknown version is rejected on every row.
  assert.ok(!constraintBody("b2b_supply_agreements_pricing_rules_version_check")
    .includes("plan_type"));
  // And no second version string is admitted anywhere.
  const versions = new Set(sql.match(/'b2b-\d{4}\.\d+'/g) || []);
  assert.deepStrictEqual([...versions], [`'${B2B_PRICING_RULES_VERSION}'`]);
});

test("9: the physical product matches the exported constants", () => {
  assert.strictEqual(B2B_PACK_GRAMS, 500);
  assert.strictEqual(PACK_NET_CENTS, 5250);
  assert.strictEqual(B2B_MIN_PACKS, 1);
  assert.strictEqual(B2B_SELF_SERVICE_MAX_PACKS, 10);
  assert.strictEqual(B2B_CURRENCY, "EUR");

  const pack = constraintBody("b2b_supply_agreements_self_service_pack_check");
  assert.ok(pack.includes(`pack_grams = ${B2B_PACK_GRAMS}`));
  assert.ok(pack.includes(`pack_net_cents = ${PACK_NET_CENTS}`));
  assert.ok(pack.includes(
    `quantity_packs between ${B2B_MIN_PACKS} and ${B2B_SELF_SERVICE_MAX_PACKS}`));
  assert.ok(pack.endsWith(") is true"), "a missing quantity must not pass as UNKNOWN");
});

test("10: a self-service row is business, EUR, and carries no 003 offer model", () => {
  const identity = constraintBody("b2b_supply_agreements_self_service_identity_check");
  assert.ok(identity.includes("customer_type = 'business'"));
  assert.ok(identity.includes(`currency = '${B2B_CURRENCY}'`));
  // The load-bearing half: the 003 offer models are the unapproved draft
  // migration 053 took away from every browser role. A self-service
  // agreement pointing at one would re-import its discount.
  assert.ok(identity.includes("offer_model_id is null"));
  assert.ok(identity.includes("checkout_attempt_id is not null"));
  assert.ok(identity.endsWith(") is true"));
});

test("11: base_monthly_product_net_cents is packs x pack price, in bigint", () => {
  const body = constraintBody("b2b_supply_agreements_self_service_base_monthly_formula_check");
  assert.ok(body.includes("base_monthly_product_net_cents::bigint"));
  assert.ok(body.includes(`quantity_packs::bigint * ${PACK_NET_CENTS}`));
  assert.ok(body.endsWith(") is true"));

  // And the formula is the one lib/ computes, at every admitted quantity.
  for (let packs = B2B_MIN_PACKS; packs <= B2B_SELF_SERVICE_MAX_PACKS; packs += 1) {
    assert.strictEqual(packs * PACK_NET_CENTS, monthlyProductNetCents(packs));
  }
});

/* ══════════════════════════════════════════════════════════════
   4. MONTHLY HAS NO CONTRACT TOTAL
   ══════════════════════════════════════════════════════════════ */

test("12: the monthly shape - four NULLs, not four zeroes, and month/1 intervals", () => {
  const body = constraintBody("b2b_supply_agreements_monthly_shape_check");
  assert.ok(body.startsWith("plan_type is distinct from 'monthly'"));
  assert.ok(body.includes("discount_percent = 0"));
  // THE REGRESSION THIS TEST EXISTS FOR: a monthly agreement is a Stripe
  // subscription and has no lifetime product contract total. A zero here
  // would be a total nobody agreed to.
  assert.ok(body.includes("contract_product_net_cents is null"));
  assert.ok(body.includes("instalment_count is null"));
  assert.ok(body.includes("delivery_count is null"));
  assert.ok(body.includes("commitment_months is null"));
  assert.ok(body.includes("commitment_end_at is null"));
  assert.ok(body.includes("billing_interval_unit = 'month'"));
  assert.ok(body.includes("billing_interval_count = 1"));
  assert.ok(body.includes("delivery_interval_unit = 'month'"));
  assert.ok(body.includes("delivery_interval_count = 1"));
  assert.ok(body.endsWith(") is true"));
});

test("13: an ACTIVE monthly agreement has a start and a Stripe subscription", () => {
  const body = constraintBody("b2b_supply_agreements_monthly_active_check");
  assert.ok(body.includes("status <> 'active'"));
  assert.ok(body.includes("started_at is not null"));
  assert.ok(body.includes("stripe_subscription_id is not null"));
  assert.ok(body.endsWith(") is true"));
});

/* ══════════════════════════════════════════════════════════════
   5. THE ANNUAL CONTRACT AMOUNT
   ══════════════════════════════════════════════════════════════ */

test("14: the annual shape - 15 %, twelve deliveries, twelve months, no subscription", () => {
  assert.strictEqual(B2B_ANNUAL_DISCOUNT_PERCENT, 15);
  assert.strictEqual(B2B_ANNUAL_DELIVERY_COUNT, 12);
  assert.strictEqual(B2B_ANNUAL_RETAINED_PERCENT, 85);

  const body = constraintBody("b2b_supply_agreements_annual_shape_check");
  assert.ok(body.includes(`discount_percent = ${B2B_ANNUAL_DISCOUNT_PERCENT}`));
  assert.ok(body.includes(`delivery_count = ${B2B_ANNUAL_DELIVERY_COUNT}`));
  assert.ok(body.includes(`commitment_months = ${B2B_ANNUAL_DELIVERY_COUNT}`));
  assert.ok(body.includes(`instalment_count in (${B2B_INSTALMENT_COUNTS.join(", ")})`));
  assert.ok(body.includes("contract_product_net_cents is not null"));
  // Annual instalments are charges against a frozen total on a schedule
  // this database owns. A subscription id would mean two systems each
  // believed they were billing the contract.
  assert.ok(body.includes("stripe_subscription_id is null"));
  assert.ok(body.includes("delivery_interval_unit = 'month'"));
  assert.ok(body.includes("delivery_interval_count = 1"));
  assert.ok(body.endsWith(") is true"));
});

test("15: THE CONTRACT AMOUNT - the SQL integer formula IS annualProductNetCents", () => {
  const body = constraintBody("b2b_supply_agreements_annual_contract_amount_check");
  // floor((2n + d) / 2d) with d = 100, exactly as divideRoundHalfUp is
  // written in lib/b2bPricingRules.ts, and in bigint so a future pack
  // ceiling cannot overflow the intermediate.
  assert.ok(body.includes(
    "(2 * (base_monthly_product_net_cents::bigint * 12 * 85) + 100) / 200"));
  assert.ok(body.includes("contract_product_net_cents::bigint"));
  assert.ok(body.endsWith(") is true"));

  // RE-EXECUTED, not eyeballed. PostgreSQL integer division truncates
  // toward zero and every operand is non-negative, so Math.trunc is the
  // same operation.
  for (let packs = B2B_MIN_PACKS; packs <= B2B_SELF_SERVICE_MAX_PACKS; packs += 1) {
    const base = packs * PACK_NET_CENTS;
    const sqlResult = Math.trunc((2 * (base * 12 * 85) + 100) / 200);
    assert.strictEqual(sqlResult, annualProductNetCents(packs),
      `the SQL formula disagrees with lib/ at ${packs} packs`);
  }
  // And the discount really is exactly 15 % of the twelve-month base.
  assert.strictEqual(annualProductNetCents(1), Math.trunc((2 * (5250 * 12 * 85) + 100) / 200));
  assert.strictEqual(annualProductNetCents(2), 107100);
});

test("16: billing interval follows the instalment count - 12, 6 or 3 months", () => {
  const body = constraintBody("b2b_supply_agreements_annual_billing_interval_check");
  // THE DENOMINATOR IS GUARDED AT THE POINT OF DIVISION. instalment_count
  // IN (1, 2, 4) is a SEPARATE constraint, and PostgreSQL does not
  // promise to evaluate one CHECK before another - so a row presenting 0
  // could reach this division first, and division by zero RAISES rather
  // than failing the check. nullif makes the expression total.
  assert.ok(body.includes("billing_interval_count = 12 / nullif(instalment_count, 0)"),
    "the annual billing division must not divide by an unchecked instalment_count");
  assert.ok(!/12 \/ instalment_count/.test(body),
    "a bare 12 / instalment_count can raise division_by_zero");
  assert.ok(body.endsWith(") is true"));
  // Exact for every admitted count, and nullif changes none of them.
  for (const count of B2B_INSTALMENT_COUNTS) {
    assert.strictEqual(12 % count, 0);
    assert.ok([12, 6, 3].includes(12 / count));
    // nullif(count, 0) is count for every admitted value, so the whole
    // mapping 1 -> 12, 2 -> 6, 4 -> 3 is byte-for-byte what it was.
    assert.strictEqual(12 / (count === 0 ? null : count), 12 / count);
  }
  // And the domain authority is still stated separately rather than
  // replaced by the nullif: zero is REJECTED, never quietly accepted.
  assert.ok(constraintBody("b2b_supply_agreements_instalment_count_check")
    .includes("instalment_count in (1, 2, 4)"),
    "the IN (1, 2, 4) authority must remain a constraint of its own");
  assert.ok(constraintBody("b2b_supply_agreements_annual_shape_check")
    .includes("instalment_count in (1, 2, 4)"),
    "the annual shape must still require an approved instalment count");
});

test("17: an ACTIVE annual agreement has a start and a frozen contract end", () => {
  const body = constraintBody("b2b_supply_agreements_annual_active_check");
  assert.ok(body.includes("started_at is not null"));
  assert.ok(body.includes("commitment_end_at is not null"));
  assert.ok(body.endsWith(") is true"));
});

/* ══════════════════════════════════════════════════════════════
   6. THE EIGHT LEGACY MONEY COLUMNS
   ══════════════════════════════════════════════════════════════ */

const LEGACY_MONEY = [
  "subtotal_net_cents", "subtotal_gross_cents", "discount_total_cents",
  "shipping_net_cents", "shipping_gross_cents", "tax_total_cents",
  "total_net_cents", "total_gross_cents",
];

test("18: all eight legacy money columns lose NOT NULL and DEFAULT - and survive", () => {
  for (const col of LEGACY_MONEY) {
    assert.ok(flat.includes(`alter column ${col} drop not null`), `${col} keeps NOT NULL`);
    assert.ok(flat.includes(`alter column ${col} drop default`), `${col} keeps its DEFAULT`);
    // Relaxed, never removed: the legacy values are the written record of
    // what a negotiated agreement said.
    assert.ok(!new RegExp(`drop column ${col}`).test(sql));
    // And each one is labelled, so the next reader does not treat it as live.
    assert.ok(new RegExp(`comment on column public\\.b2b_supply_agreements\\.${col}`).test(sql));
  }
  // Exactly eight relaxations, no more: a ninth would be a column nobody
  // decided about.
  assert.strictEqual((sql.match(/alter column \w+ +drop not null/g) || []).length,
    LEGACY_MONEY.length + 4, "eight agreement money columns plus the four item ones");
});

test("19: a self-service row carries NULL in all eight - no fake zero accounting", () => {
  const body = constraintBody("b2b_supply_agreements_self_service_legacy_money_null_check");
  for (const col of LEGACY_MONEY) {
    assert.ok(body.includes(`${col} is null`), `${col} may still be written on a self-service row`);
  }
  assert.ok(body.startsWith("plan_type is null"));
  assert.ok(body.endsWith(") is true"));
});

test("20: and the split runs the other way too - a legacy row carries no plan data", () => {
  const body = constraintBody("b2b_supply_agreements_legacy_row_has_no_self_service_data_check");
  for (const col of EXPECTED_COLUMNS) {
    if (col === "plan_type") continue;
    // The cancellation vocabulary deliberately applies to legacy rows as
    // well - a negotiated agreement can genuinely be cancelled.
    if (col.startsWith("cancellation_") || col === "termination_reason") {
      assert.ok(!body.includes(`${col} is null`),
        `${col} must stay available to a legacy agreement`);
      continue;
    }
    assert.ok(body.includes(`${col} is null`), `a legacy row could still carry ${col}`);
  }
  assert.ok(body.endsWith(") is true"));
});

/* ══════════════════════════════════════════════════════════════
   7. THE PRICING SNAPSHOT, AGAINST THE REAL BUILDERS
   ══════════════════════════════════════════════════════════════ */

const monthlySnapshotKeys = (() => {
  const built = buildB2bMonthlyPricing({ packs: 2 });
  assert.ok(built.ok);
  return Object.keys({ ...built.pricing, ...netOriginTaxMetadata() });
})();

const annualSnapshotKeys = (() => {
  const built = buildB2bAnnualPricing({ packs: 2, instalmentCount: 2 });
  assert.ok(built.ok);
  return Object.keys({ ...built.pricing, ...netOriginTaxMetadata() });
})();

const snapshotCheck = constraintBody(
  "b2b_supply_agreements_self_service_pricing_snapshot_check");

/**
 * THE EXCEPTION-SAFE SHAPE every JSON value comparison must take.
 *
 * PostgreSQL does not promise the evaluation order of AND's operands, so
 * a jsonb_typeof() test sitting to the LEFT of a cast is documentation
 * rather than a guard: the planner may reach the cast first, and a cast
 * out of a JSON string RAISES. A CASE evaluates its WHEN before its THEN
 * by definition, so the type has to be re-proved inside the CASE that
 * uses it - and ELSE is FALSE, never NULL, so a wrong type is a
 * rejection rather than an unknown.
 */
const numericCase = (jsonPath, rhs) =>
  `case when jsonb_typeof(${jsonPath}) = 'number' `
  + `then (${jsonPath.replace(/->(?!.*->)/, "->>")})::numeric = ${rhs} else false end`;

/** The same, for a snapshot key read directly off the snapshot object. */
const snapshotNumericCase = (key, rhs) =>
  numericCase(`pricing_snapshot->'${key}'`, rhs);

test("21: the snapshot constraint requires only keys a builder actually emits", () => {
  // THE FAILURE MODE THIS CATCHES: a constraint demanding a key the
  // producer does not write rejects every real row. The allowed set is
  // derived by CALLING the builders, not from memory.
  const allowed = new Set([
    ...monthlySnapshotKeys,
    ...annualSnapshotKeys,
    // monthlyEquivalent's own three keys, read from the real structure.
    ...Object.keys(buildB2bAnnualPricing({ packs: 1, instalmentCount: 1 }).pricing.monthlyEquivalent),
  ]);
  const referenced = new Set((snapshotCheck.match(/'[a-zA-Z][a-zA-Z0-9]*'/g) || [])
    .map(q => q.slice(1, -1))
    // string VALUES compared against, not keys
    .filter(k => !["object", "number", "boolean", "array", "string", "net",
                   NET_ORIGIN_TAX_CALCULATION_VERSION, "monthly", "annual"].includes(k)));
  for (const key of referenced) {
    assert.ok(allowed.has(key),
      `the snapshot constraint references '${key}', which no pricing builder emits`);
  }
  // The two keys an earlier draft invented, named so the mistake cannot
  // come back silently.
  assert.ok(!referenced.has("totals"));
  assert.ok(!referenced.has("grossCents"));
});

test("22: every monthly snapshot key is required, and no annual figure is tolerated", () => {
  for (const key of monthlySnapshotKeys) {
    assert.ok(snapshotCheck.includes(`'${key}'`),
      `the monthly snapshot key ${key} is not required by the constraint`);
  }
  // A monthly snapshot quoting a twelve-month price is a contradiction.
  const forbidden = ["annualProductNetCents", "baseAnnualNetCents", "instalmentCount",
                     "instalmentNetCents", "savingNetCents", "monthlyEquivalent"];
  const exclusion = /not pricing_snapshot \?\| array\[([^\]]+)\]/.exec(snapshotCheck);
  assert.ok(exclusion, "the monthly branch must exclude the annual keys");
  for (const key of forbidden) {
    assert.ok(exclusion[1].includes(`'${key}'`), `${key} is not excluded from a monthly snapshot`);
  }
  // The recurring basis is still tied to the first-class column, now
  // through the exception-safe CASE rather than a bare cast.
  assert.ok(snapshotCheck.includes(
    snapshotNumericCase("monthlyProductNetCents", "base_monthly_product_net_cents::numeric")),
    "the monthly basis is no longer tied to base_monthly_product_net_cents");
});

test("23: every annual snapshot key is required and agrees with a first-class column", () => {
  for (const key of annualSnapshotKeys) {
    assert.ok(snapshotCheck.includes(`'${key}'`),
      `the annual snapshot key ${key} is not required by the constraint`);
  }
  // Every one of these is still tied to its first-class column - the
  // pairing is unchanged, only the reading of the JSON value is now
  // exception-safe.
  for (const [key, column] of [
    ["packs", "quantity_packs::numeric"],
    ["packNetCents", "pack_net_cents::numeric"],
    ["deliveryCount", "delivery_count::numeric"],
    ["discountPercent", "discount_percent::numeric"],
    ["annualProductNetCents", "contract_product_net_cents::numeric"],
    ["instalmentCount", "instalment_count::numeric"],
  ]) {
    assert.ok(snapshotCheck.includes(snapshotNumericCase(key, column)),
      `the snapshot is not tied to the column: ${key} = ${column}`);
  }
  // instalmentNetCents is one amount per instalment - and the length is
  // only read once the CASE has proved it really is an array.
  assert.ok(snapshotCheck.includes(
    "case when jsonb_typeof(pricing_snapshot->'instalmentNetCents') = 'array' "
    + "then jsonb_array_length(pricing_snapshot->'instalmentNetCents') = instalment_count "
    + "else false end"),
    "the instalment count must be read from a proved array");
  // And the builder really does produce that many.
  for (const count of B2B_INSTALMENT_COUNTS) {
    const built = buildB2bAnnualPricing({ packs: 3, instalmentCount: count });
    assert.strictEqual(built.pricing.instalmentNetCents.length, count);
  }
});

test("24: the tax metadata is the net-origin authority, closed to other versions", () => {
  assert.strictEqual(NET_ORIGIN_TAX_CALCULATION_VERSION, "de-net-2026.1");
  assert.deepStrictEqual(netOriginTaxMetadata(),
    { calculationVersion: "de-net-2026.1", priceOrigin: "net" });
  assert.ok(snapshotCheck.includes(
    `pricing_snapshot->>'calculationVersion' = '${NET_ORIGIN_TAX_CALCULATION_VERSION}'`));
  assert.ok(snapshotCheck.includes("pricing_snapshot->>'priceOrigin' = 'net'"));
  // No gross total is invented: B2B pricing is net-origin and the gross
  // of an instalment is established when that instalment is invoiced.
  assert.ok(!/grossCents/.test(snapshotCheck));
});

test("25: the snapshot constraint is NULL-safe - {} cannot pass", () => {
  // Key existence is proved with ?& / ? before any value is read, the
  // type is asserted, and the whole conjunction ends in ) is true, so a
  // missing key is FALSE rather than UNKNOWN.
  assert.ok(snapshotCheck.includes("pricing_snapshot is not null"));
  assert.ok(snapshotCheck.includes("jsonb_typeof(pricing_snapshot) = 'object'"));
  assert.ok((snapshotCheck.match(/\?&/g) || []).length >= 3);
  assert.ok((snapshotCheck.match(/jsonb_typeof/g) || []).length >= 12);
  assert.ok(snapshotCheck.endsWith(") is true"));
  // Every key that is read with ->> or -> is also proved present.
  const proved = new Set(
    (snapshotCheck.match(/\?&? ?(array\[[^\]]+\]|'[a-zA-Z][a-zA-Z0-9]*')/g) || [])
      .flatMap(m => (m.match(/'[a-zA-Z][a-zA-Z0-9]*'/g) || []))
      .map(q => q.slice(1, -1)));
  const readKeys = new Set((snapshotCheck.match(/->>?'([a-zA-Z][a-zA-Z0-9]*)'/g) || [])
    .map(m => m.replace(/->>?'/, "").replace("'", "")));
  for (const key of readKeys) {
    assert.ok(proved.has(key), `${key} is read without being proved present first`);
  }
});

/**
 * THE CONSTRAINTS WHOSE PREDICATE MUST COLLAPSE UNKNOWN TO FALSE.
 *
 * Every one of these says "when this row is X, ALL of the following
 * hold". A missing column makes the conjunction UNKNOWN, and a CHECK
 * passes on UNKNOWN - so the `) is true` terminator is the difference
 * between requiring the values and merely describing them.
 */
const MUST_END_IS_TRUE = [
  "b2b_supply_agreements_stripe_subscription_id_format_check",
  "b2b_supply_agreements_legacy_row_has_no_self_service_data_check",
  "b2b_supply_agreements_self_service_identity_check",
  "b2b_supply_agreements_self_service_pack_check",
  "b2b_supply_agreements_self_service_base_monthly_formula_check",
  "b2b_supply_agreements_monthly_shape_check",
  "b2b_supply_agreements_monthly_active_check",
  "b2b_supply_agreements_annual_shape_check",
  "b2b_supply_agreements_annual_billing_interval_check",
  "b2b_supply_agreements_annual_contract_amount_check",
  "b2b_supply_agreements_annual_active_check",
  "b2b_supply_agreements_self_service_legacy_money_null_check",
  "b2b_supply_agreements_self_service_pricing_snapshot_check",
  "b2b_supply_agreements_annual_no_ordinary_cancellation_check",
  "b2b_supply_items_canonical_shape_check",
];

/**
 * And the ones that deliberately do NOT, because each is a single
 * NULL-permissive domain rule: the column is optional by design, so
 * "NULL passes" is the intended reading rather than an accident.
 */
const DELIBERATELY_NULL_PERMISSIVE = [
  "b2b_supply_agreements_plan_type_check",
  "b2b_supply_agreements_pricing_rules_version_check",
  "b2b_supply_agreements_pack_grams_check",
  "b2b_supply_agreements_pack_net_cents_check",
  "b2b_supply_agreements_quantity_packs_check",
  "b2b_supply_agreements_discount_percent_check",
  "b2b_supply_agreements_delivery_count_check",
  "b2b_supply_agreements_instalment_count_check",
  "b2b_supply_agreements_base_monthly_net_check",
  "b2b_supply_agreements_contract_net_check",
  "b2b_supply_agreements_self_service_status_check",
  "b2b_supply_agreements_cancellation_requested_requires_effective",
  "b2b_supply_agreements_cancellation_effective_requires_requested",
  "b2b_supply_agreements_cancellation_effective_order_check",
  "b2b_supply_agreements_cancellation_reason_requires_request",
  "b2b_supply_agreements_cancellation_reason_length_check",
  "b2b_supply_agreements_termination_reason_requires_ended_check",
  "b2b_supply_agreements_termination_reason_length_check",
  "b2b_supply_agreements_ended_after_started_check",
  "b2b_supply_items_item_role_check",
];

test("26: and every self-service compound predicate ends in IS TRUE", () => {
  for (const name of MUST_END_IS_TRUE) {
    assert.ok(constraintBody(name).endsWith(") is true"),
      `${name} has a compound predicate that can pass as UNKNOWN`);
  }
  // A NULL-permissive rule must genuinely be one: one column, and the
  // NULL spelled out rather than left to three-valued logic.
  for (const name of DELIBERATELY_NULL_PERMISSIVE) {
    const body = constraintBody(name);
    assert.ok(!body.endsWith(") is true"), `${name} is in the wrong list`);
    assert.ok(/ is null| is distinct from | <> /.test(body),
      `${name} does not read as a deliberate NULL-permissive domain rule: ${body}`);
  }
  // EVERY constraint 059 adds is in exactly one of the two lists, so a
  // future constraint cannot arrive un-triaged.
  const all = (flat.match(/add constraint (\w+) check \(/g) || [])
    .map(m => /add constraint (\w+)/.exec(m)[1]);
  assert.strictEqual(all.length, MUST_END_IS_TRUE.length + DELIBERATELY_NULL_PERMISSIVE.length);
  for (const name of all) {
    assert.ok(MUST_END_IS_TRUE.includes(name) || DELIBERATELY_NULL_PERMISSIVE.includes(name),
      `${name} has not been triaged for three-valued logic`);
  }
});

/* ══════════════════════════════════════════════════════════════
   7B. EXCEPTION SAFETY: NOTHING DEPENDS ON EVALUATION ORDER
   ══════════════════════════════════════════════════════════════

   PostgreSQL does not promise the order in which it evaluates AND's
   operands, nor the order in which it evaluates one CHECK against
   another. So a type test placed to the LEFT of an operation that can
   RAISE is documentation, not a guard:

     jsonb_typeof(v) = 'array' and jsonb_array_length(v) = n

   is not safe, because jsonb_array_length() on a non-array raises
   rather than returning false, and it may be the operand evaluated
   first.

   The rule these tests enforce is that every raise-capable operation in
   059 carries its OWN type guarantee where it is used - a CASE whose
   WHEN cannot itself raise, falling through to FALSE - so a malformed
   snapshot is refused by the constraint rather than by an error, under
   ANY evaluation order a planner may choose. */

/** All non-nested `case when … then … else false end` spans in 059. */
const CASE_SPANS = (() => {
  const spans = [];
  const re = /case when ([\s\S]*?) then ([\s\S]*?) else false end/g;
  for (let m = re.exec(flat); m; m = re.exec(flat)) {
    spans.push({
      when: m[1],
      then: m[2],
      thenStart: m.index + m[0].indexOf(" then ") + " then ".length,
      end: re.lastIndex,
    });
  }
  return spans;
})();

/** Is this character offset inside the THEN arm of a guarding CASE? */
const insideGuardedThen = index =>
  CASE_SPANS.some(s => index >= s.thenStart && index < s.end);

/**
 * Every operation in 059 that can RAISE for a well-formed jsonb value
 * carrying the wrong JSON type: the array-length function, and any cast
 * whose operand is extracted out of the snapshot.
 */
const RAISE_CAPABLE = /jsonb_array_length\s*\(|\(pricing_snapshot[^()]*\)::[a-z]+/g;

test("47: every raise-capable JSON operation sits inside a type-proving CASE", () => {
  const found = [...flat.matchAll(RAISE_CAPABLE)];
  // The patch must not have quietly deleted the operations themselves.
  assert.ok(found.length >= 14,
    `expected the snapshot constraint's JSON reads to survive, found ${found.length}`);
  for (const m of found) {
    assert.ok(insideGuardedThen(m.index),
      `this can raise and is not inside a CASE that proved the type: ${flat.slice(m.index, m.index + 80)}`);
  }
  // At least one of each kind is actually present, so the regex cannot
  // pass by matching nothing.
  assert.ok(flat.includes("jsonb_array_length("), "the array length read disappeared");
  assert.ok(/\(pricing_snapshot[^()]*\)::numeric/.test(flat), "the snapshot value casts disappeared");
});

test("48: each guarding CASE proves the type with an expression that cannot itself raise", () => {
  assert.ok(CASE_SPANS.length >= 12, `expected the guarding CASEs, found ${CASE_SPANS.length}`);
  for (const span of CASE_SPANS) {
    // The WHEN is the guarantee, so the WHEN may not be the thing that
    // needs one: jsonb_typeof() is total for every jsonb input.
    assert.ok(/jsonb_typeof/.test(span.when),
      `a CASE guards nothing - its WHEN proves no JSON type: ${span.when}`);
    assert.ok(!/::|jsonb_array_length/.test(span.when),
      `a CASE's WHEN can itself raise, so it cannot be the guard: ${span.when}`);
    // And every type the THEN relies on is proved by that same WHEN.
    // A value read with ->> must have been proved with -> at the SAME
    // path, so the guard and the read cannot be about different keys.
    const reads = span.then.match(
      /pricing_snapshot(?:->'[a-zA-Z][a-zA-Z0-9]*')*->>'[a-zA-Z][a-zA-Z0-9]*'/g) || [];
    for (const path of reads) {
      const proved = path.replace(/->>(?=')/, "->").replace("->>'", "->'");
      assert.ok(span.when.includes(`jsonb_typeof(${proved}) = 'number'`),
        `${path} is read in a THEN whose WHEN never proved it is a number: ${span.when}`);
    }
    for (const call of span.then.match(/jsonb_array_length\(([^)]*)\)/g) || []) {
      const inner = /jsonb_array_length\(([^)]*)\)/.exec(call)[1];
      assert.ok(span.when.includes(`jsonb_typeof(${inner}) = 'array'`),
        `${call} is called in a THEN whose WHEN never proved it is an array: ${span.when}`);
    }
    assert.ok(reads.length > 0 || /jsonb_array_length/.test(span.then),
      `a CASE guards nothing it then reads: ${span.then}`);
  }
  // ELSE is FALSE on every one. ELSE NULL would put the whole
  // conjunction back into UNKNOWN, which a CHECK passes on.
  assert.strictEqual((flat.match(/\belse false end\b/g) || []).length, CASE_SPANS.length);
  assert.ok(!/\belse null end\b/.test(flat), "a guard falls through to NULL rather than FALSE");
  assert.ok(!/\belse true end\b/.test(flat), "a guard falls through to TRUE");
  assert.ok(!/\bcase when\b(?![\s\S]*?\belse false end\b)/.test(flat),
    "a CASE has no ELSE at all, so a wrong type is UNKNOWN rather than FALSE");
});

test("49: no JSON value is cast to bigint - a JSON number may be fractional", () => {
  // jsonb_typeof(v) = 'number' does NOT make (v->>'k')::bigint safe:
  // '4462.5'::bigint raises. The text of a JSON number is always a valid
  // NUMERIC literal, so ::numeric is total once the type is proved and
  // ::bigint is not. Numeric comparison of integer cent amounts is
  // exact, so nothing this constraint admits or refuses changed.
  assert.ok(!/\(pricing_snapshot[^()]*\)::bigint/.test(flat),
    "a JSON value is still cast to bigint, which can raise on a fractional number");
  // Casts of the INTEGER COLUMNS are untouched and cannot raise - the
  // contract amount formula still does its arithmetic in bigint.
  assert.ok(flat.includes("contract_product_net_cents::bigint"),
    "the contract amount formula must keep its bigint arithmetic");
  assert.ok(flat.includes("base_monthly_product_net_cents::bigint"),
    "the base monthly formula must keep its bigint arithmetic");
});

test("50: no division in 059 can meet an unguarded zero denominator", () => {
  const names = (flat.match(/add constraint (\w+) check \(/g) || [])
    .map(m => /add constraint (\w+)/.exec(m)[1]);
  let divisions = 0;
  for (const name of names) {
    for (const m of constraintBody(name).matchAll(/\/\s*([a-z0-9_]+\(?[^\s)]*|\d+)/gi)) {
      divisions += 1;
      const denominator = m[1];
      assert.ok(/^\d+$/.test(denominator) || denominator.startsWith("nullif("),
        `${name} divides by "${denominator}", which is neither a literal nor nullif-guarded`);
    }
  }
  assert.ok(divisions >= 3, `expected the three divisions, found ${divisions}`);
  // The one variable denominator, named so it cannot silently go back.
  assert.ok(flat.includes("12 / nullif(instalment_count, 0)"));
  assert.ok(!/12 \/ instalment_count/.test(flat));
});

test("51: the required snapshot shape is unchanged - presence AND type, per key", () => {
  // THE FAILURE MODE THIS CATCHES: a safety patch that makes a predicate
  // total by making it permissive. Every key a builder emits must still
  // be proved PRESENT, and every key whose VALUE is read must still have
  // its type proved before the read.
  for (const key of new Set([...monthlySnapshotKeys, ...annualSnapshotKeys])) {
    assert.ok(new RegExp(`\\?[&|]? ?array\\[[^\\]]*'${key}'|\\? '${key}'`).test(snapshotCheck),
      `${key} lost its presence proof`);
  }
  // monthlyEquivalent's three own keys keep theirs too.
  for (const key of Object.keys(
    buildB2bAnnualPricing({ packs: 1, instalmentCount: 1 }).pricing.monthlyEquivalent)) {
    assert.ok(snapshotCheck.includes(`'${key}'`), `monthlyEquivalent.${key} lost its requirement`);
  }
  // The declared shape - the standalone jsonb_typeof assertions - is
  // kept ALONGSIDE the CASEs rather than replaced by them.
  for (const typed of [
    "jsonb_typeof(pricing_snapshot) = 'object'",
    "jsonb_typeof(pricing_snapshot->'packs') = 'number'",
    "jsonb_typeof(pricing_snapshot->'kilograms') = 'number'",
    "jsonb_typeof(pricing_snapshot->'packNetCents') = 'number'",
    "jsonb_typeof(pricing_snapshot->'instalmentNetCents') = 'array'",
    "jsonb_typeof(pricing_snapshot->'monthlyEquivalent') = 'object'",
    "jsonb_typeof(pricing_snapshot->'monthlyEquivalent'->'isExact') = 'boolean'",
  ]) {
    assert.ok(snapshotCheck.includes(typed), `the declared shape lost: ${typed}`);
  }
  // A monthly snapshot still may not quote a twelve-month price, and the
  // whole predicate still collapses UNKNOWN to FALSE - which together
  // are what refuse '{}' and every partial snapshot.
  assert.ok(snapshotCheck.includes("not pricing_snapshot ?|"));
  assert.ok(snapshotCheck.includes("pricing_snapshot is not null"));
  assert.ok(snapshotCheck.endsWith(") is true"));
});

test("52: the safety patch changed no commercial figure", () => {
  // The annual contract amount is still the Package 1 authority,
  // re-executed here rather than trusted: the SQL formula is unchanged
  // and the patch touched neither of its bigint casts.
  assert.ok(constraintBody("b2b_supply_agreements_annual_contract_amount_check").includes(
    "contract_product_net_cents::bigint = "
    + "(2 * (base_monthly_product_net_cents::bigint * 12 * 85) + 100) / 200"));
  for (let packs = B2B_MIN_PACKS; packs <= B2B_SELF_SERVICE_MAX_PACKS; packs += 1) {
    const base = monthlyProductNetCents(packs);
    const fromSql = Math.floor((2 * (base * B2B_ANNUAL_DELIVERY_COUNT * B2B_ANNUAL_RETAINED_PERCENT) + 100) / 200);
    assert.strictEqual(fromSql, annualProductNetCents(packs),
      `the SQL contract formula drifted from annualProductNetCents at ${packs} packs`);
  }
  // And every commercial constant the constraints state is still the
  // exported one.
  assert.ok(flat.includes(`pricing_rules_version = '${B2B_PRICING_RULES_VERSION}'`));
  assert.ok(flat.includes(`pack_grams = ${B2B_PACK_GRAMS}`));
  assert.ok(flat.includes(`pack_net_cents = ${PACK_NET_CENTS}`));
  assert.ok(flat.includes(`quantity_packs between ${B2B_MIN_PACKS} and ${B2B_SELF_SERVICE_MAX_PACKS}`));
  assert.ok(flat.includes(`discount_percent = ${B2B_ANNUAL_DISCOUNT_PERCENT}`));
  assert.ok(flat.includes(`delivery_count = ${B2B_ANNUAL_DELIVERY_COUNT}`));
  assert.ok(flat.includes(`currency = '${B2B_CURRENCY}'`));
  // No constraint was added, removed or renamed by a safety patch.
  const names = (flat.match(/add constraint (\w+) check \(/g) || [])
    .map(m => /add constraint (\w+)/.exec(m)[1]);
  assert.strictEqual(names.length, MUST_END_IS_TRUE.length + DELIBERATELY_NULL_PERMISSIVE.length);
});

/* ══════════════════════════════════════════════════════════════
   8. CANCELLATION AND TERMINATION
   ══════════════════════════════════════════════════════════════ */

test("27: the nine cancellation and termination invariants are all present", () => {
  const P = "b2b_supply_agreements_";
  assert.ok(constraintBody(`${P}cancellation_requested_requires_effective`)
    .includes("cancellation_requested_at is null or cancellation_effective_at is not null"));
  assert.ok(constraintBody(`${P}cancellation_effective_requires_requested`)
    .includes("cancellation_effective_at is null or cancellation_requested_at is not null"));
  assert.ok(constraintBody(`${P}cancellation_effective_order_check`)
    .includes("cancellation_effective_at >= cancellation_requested_at"));
  assert.ok(constraintBody(`${P}cancellation_reason_requires_request`)
    .includes("cancellation_reason is null or cancellation_requested_at is not null"));
  assert.ok(constraintBody(`${P}cancellation_reason_length_check`)
    .includes("char_length(btrim(cancellation_reason)) between 1 and 500"));
  assert.ok(constraintBody(`${P}termination_reason_requires_ended_check`)
    .includes("termination_reason is null or ended_at is not null"));
  assert.ok(constraintBody(`${P}termination_reason_length_check`)
    .includes("char_length(btrim(termination_reason)) between 1 and 500"));
  assert.ok(constraintBody(`${P}ended_after_started_check`)
    .includes("ended_at >= started_at"));
});

test("28: ANNUAL has no ordinary cancellation - the columns cannot describe one", () => {
  const body = constraintBody("b2b_supply_agreements_annual_no_ordinary_cancellation_check");
  assert.ok(body.startsWith("plan_type is distinct from 'annual'"));
  assert.ok(body.includes("cancellation_requested_at is null"));
  assert.ok(body.includes("cancellation_effective_at is null"));
  assert.ok(body.includes("cancellation_reason is null"));
  assert.ok(body.endsWith(") is true"));
});

test("29: the 14-day cutoff is NOT in SQL, and there are no withdrawal fields", () => {
  // The cutoff compares the request against the Stripe billing period
  // boundary, which this table does not hold. 034 computes the B2C
  // equivalent in application code for the same reason.
  assert.ok(!/interval\s*'14/i.test(sql));
  assert.ok(!/\b14\s*(days?|tage)\b/i.test(sql));
  assert.ok(!/withdrawal/i.test(sql));
  // The B2C vocabulary is reused, not reinvented.
  for (const legacy of ["cancel_requested_at", "cancel_effective_at", "cancel_reason"]) {
    assert.ok(!sql.includes(legacy), `${legacy} is the rejected naming`);
  }
});

/* ══════════════════════════════════════════════════════════════
   9. THE CANONICAL SUPPLY ITEM
   ══════════════════════════════════════════════════════════════ */

test("30: item_role admits exactly one value - multi-SKU stays deferred", () => {
  assert.ok(constraintBody("b2b_supply_items_item_role_check")
    .includes("item_role is null or item_role = 'canonical_matcha'"));
  const roles = new Set(sql.match(/'canonical_[a-z_]+'/g) || []);
  assert.deepStrictEqual([...roles], ["'canonical_matcha'"]);
});

test("31: exactly the four NOT NULL item accounting columns are relaxed", () => {
  const four = ["unit_price_net_cents", "unit_price_gross_cents",
                "line_total_net_cents", "line_total_gross_cents"];
  for (const col of four) {
    assert.ok(flat.includes(`alter column ${col} drop not null`));
    assert.ok(new RegExp(`comment on column public\\.b2b_supply_items\\.${col}`).test(sql));
  }
  // discount_percent and tax_rate_percent are ALREADY nullable in 006, so
  // relaxing them would be a statement about a constraint that does not
  // exist. They are commented instead.
  for (const already of ["tax_rate_percent", "discount_percent"]) {
    assert.ok(!flat.includes(`alter table public.b2b_supply_items alter column ${already} drop`));
    assert.ok(new RegExp(`comment on column public\\.b2b_supply_items\\.${already}`).test(sql));
  }
});

test("32: the canonical item mirrors the product and carries no accounting", () => {
  const body = constraintBody("b2b_supply_items_canonical_shape_check");
  assert.ok(body.startsWith("item_role is distinct from 'canonical_matcha'"));
  // The 003 product sizes are the unapproved 125.00/kg draft.
  assert.ok(body.includes("product_size_id is null"));
  assert.ok(body.includes(`grams = ${B2B_PACK_GRAMS}`));
  assert.ok(body.includes(`base_unit_price_net_cents = ${PACK_NET_CENTS}`));
  assert.ok(body.includes(
    `quantity between ${B2B_MIN_PACKS} and ${B2B_SELF_SERVICE_MAX_PACKS}`));
  for (const deprecated of ["unit_price_net_cents", "unit_price_gross_cents",
                            "line_total_net_cents", "line_total_gross_cents",
                            "tax_rate_percent", "discount_percent"]) {
    assert.ok(body.includes(`${deprecated} is null`), `${deprecated} may still be written`);
  }
  assert.ok(body.endsWith(") is true"));
});

test("33: product_size_id keeps its column and its 006 foreign key", () => {
  assert.ok(!/drop column product_size_id/i.test(sql));
  assert.ok(!/product_size_id[\s\S]{0,80}references/i.test(sql),
    "059 must not re-declare or rewrite the legacy FK");
  assert.ok(/comment on column public\.b2b_supply_items\.product_size_id/.test(sql));
});

test("34: at most one canonical item per agreement, as an index", () => {
  assert.ok(flat.includes(
    "create unique index b2b_supply_items_canonical_per_agreement_key "
    + "on public.b2b_supply_items (supply_agreement_id) "
    + "where item_role = 'canonical_matcha'"));
});

/* ══════════════════════════════════════════════════════════════
   10. INTEGRITY, IMMUTABILITY AND THE FUNCTION ACL
   ══════════════════════════════════════════════════════════════ */

const FUNCTIONS = [
  "assert_b2b_self_service_item_integrity",
  "b2b_supply_agreements_item_integrity_trigger",
  "b2b_supply_items_integrity_trigger",
  "b2b_supply_agreements_immutability_guard",
];

test("35: exactly four functions, all definer with a pinned search_path", () => {
  const created = (sql.match(/create function public\.(\w+)/g) || [])
    .map(m => m.replace("create function public.", ""));
  assert.deepStrictEqual(created.sort(), [...FUNCTIONS].sort());
  // No OR REPLACE: an existing function means unexplained drift.
  assert.ok(!/create or replace function/i.test(sql));
  assert.strictEqual((sql.match(/security definer/g) || []).length, FUNCTIONS.length);
  assert.strictEqual((sql.match(/set search_path = ''/g) || []).length, FUNCTIONS.length);
});

test("36: EXECUTE is revoked from all four roles on all four, and granted to nobody", () => {
  for (const fn of FUNCTIONS) {
    const signature = fn === "assert_b2b_self_service_item_integrity" ? "(uuid)" : "()";
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      assert.ok(flat.includes(
        `revoke all on function public.${fn}${signature} from ${role};`),
        `${fn} is still executable by ${role}`);
    }
  }
  // A trigger fires on the table's TRIGGER privilege, not on EXECUTE, so
  // zero grantees is not a broken trigger - it is an uncallable function.
  assert.ok(!/grant execute/i.test(sql));
});

test("37: the cross-table assertion is deferred, from BOTH sides", () => {
  // A legitimate transaction updates the agreement and its item in
  // either order. An immediate trigger would make that order-dependent.
  for (const trigger of ["b2b_supply_agreements_item_integrity",
                         "b2b_supply_items_integrity"]) {
    const at = flat.indexOf(`create constraint trigger ${trigger}`);
    assert.notStrictEqual(at, -1, `${trigger} is missing`);
    const body = flat.slice(at, flat.indexOf(";", at));
    assert.ok(body.includes("deferrable initially deferred"), `${trigger} is not deferred`);
    assert.ok(body.includes("for each row"));
    assert.ok(body.includes("after"));
  }
  assert.ok(flat.includes("after insert or update or delete on public.b2b_supply_items"),
    "an item DELETE must be checked too - it can leave an active agreement without a line");
});

test("38: and it asserts exactly one canonical item, mirroring the CURRENT agreement", () => {
  const fn = sql.slice(sql.indexOf("create function public.assert_b2b_self_service_item_integrity"));
  const body = fn.slice(0, fn.indexOf("$$;")).replace(/\s+/g, " ");
  assert.ok(body.includes("v_status = 'active' and v_canonical_count <> 1"));
  assert.ok(body.includes("quantity is distinct from v_quantity_packs"));
  assert.ok(body.includes("grams is distinct from v_pack_grams"));
  assert.ok(body.includes("base_unit_price_net_cents is distinct from v_pack_net_cents"));
  // A legacy agreement is left alone, and a missing agreement is not an
  // occasion to invent a rule.
  assert.ok(body.includes("if v_plan_type is null then return; end if;"));
  assert.ok(body.includes("if not found then return; end if;"));
  // 059 asserts nothing about tables 060 creates.
  assert.ok(!/b2b_payment_schedule|b2b_deliveries/.test(sql));
});

test("39: the immutability guard is IMMEDIATE and freezes the right columns", () => {
  const at = flat.indexOf("create trigger b2b_supply_agreements_immutability");
  assert.notStrictEqual(at, -1);
  const trigger = flat.slice(at, flat.indexOf(";", at));
  assert.ok(trigger.includes("before update on public.b2b_supply_agreements"));
  assert.ok(!trigger.includes("deferrable"),
    "an immutability guard that fires at COMMIT cannot name the statement that broke it");

  const guard = sql.slice(sql.indexOf("create function public.b2b_supply_agreements_immutability_guard"));
  const body = guard.slice(0, guard.indexOf("$$;")).replace(/\s+/g, " ");
  // Always frozen once assigned.
  for (const col of ["plan_type", "pricing_rules_version", "pack_grams", "pack_net_cents",
                     "currency", "checkout_attempt_id"]) {
    assert.ok(body.includes(`old.${col} is not null`), `${col} is not frozen once assigned`);
    assert.ok(body.includes(`new.${col} is distinct from old.${col}`),
      `${col} could be reverted to NULL`);
  }
  // Stripe subscription and started_at have their own rules.
  assert.ok(body.includes("new.stripe_subscription_id is distinct from old.stripe_subscription_id"));
  assert.ok(body.includes("new.started_at is distinct from old.started_at"));
  // ACTIVE ANNUAL freezes the whole commercial configuration - quantity
  // included, which is the gap this rule was corrected to close.
  const annual = body.slice(body.indexOf("old.plan_type = 'annual' and old.status = 'active'"));
  for (const col of ["quantity_packs", "base_monthly_product_net_cents",
                     "contract_product_net_cents", "discount_percent", "delivery_count",
                     "instalment_count", "pricing_snapshot", "commitment_months"]) {
    assert.ok(annual.includes(`new.${col} is distinct from old.${col}`),
      `an active annual agreement could still change ${col}`);
  }
  // commitment_end_at is frozen for annual as soon as it exists.
  assert.ok(body.includes("old.plan_type = 'annual' and old.commitment_end_at is not null"));
});

test("40: a MONTHLY quantity change is deliberately still possible", () => {
  const guard = sql.slice(sql.indexOf("create function public.b2b_supply_agreements_immutability_guard"));
  const body = guard.slice(0, guard.indexOf("$$;")).replace(/\s+/g, " ");
  const annualAt = body.indexOf("old.plan_type = 'annual' and old.status = 'active'");
  // quantity_packs must be frozen ONLY inside the active-annual branch.
  const beforeAnnual = body.slice(0, annualAt);
  assert.ok(!beforeAnnual.includes("new.quantity_packs is distinct from old.quantity_packs"),
    "a monthly agreement must be able to change quantity for a future cycle");
});

/* ══════════════════════════════════════════════════════════════
   11. THE INDEXES, AND THE RULE NOBODY APPROVED
   ══════════════════════════════════════════════════════════════ */

test("41: exactly the justified uniques, both partial", () => {
  assert.ok(flat.includes("create unique index b2b_supply_agreements_checkout_attempt_id_key "
    + "on public.b2b_supply_agreements (checkout_attempt_id) "
    + "where checkout_attempt_id is not null"));
  assert.ok(flat.includes("create unique index b2b_supply_agreements_stripe_subscription_id_key "
    + "on public.b2b_supply_agreements (stripe_subscription_id) "
    + "where stripe_subscription_id is not null"));
  assert.strictEqual((sql.match(/create unique index/g) || []).length, 3,
    "two agreement uniques plus the canonical item one");
});

test("42: NO one-agreement-per-user uniqueness anywhere", () => {
  // No such commercial rule was approved, and a business with two sites
  // will need two agreements. An index is a poor place to discover a rule.
  for (const index of sql.match(/create unique index[\s\S]*?;/g) || []) {
    assert.ok(!/\(user_id\)|\(user_id[,\s]/.test(index),
      `a unique index on user_id would invent a one-agreement-per-user rule: ${index}`);
  }
  assert.ok(!/unique[\s\S]{0,120}user_id/i.test(sql));
});

/* ══════════════════════════════════════════════════════════════
   12. THE LEGACY STATUS CHECK, AND THE APPLIED MIGRATIONS
   ══════════════════════════════════════════════════════════════ */

test("43: the legacy anonymous status CHECK is completely untouched", () => {
  // 006's CHECK still owns pending/active/paused/cancelled/completed.
  // 059 adds only its own named no-pause rule beside it - zero DROP, and
  // no re-declaration of the five legacy values.
  assert.ok(!/drop constraint/i.test(sql));
  assert.ok(!/'pending'/.test(sql), "059 must not re-state the legacy status list");
  assert.ok(!/'completed'/.test(sql));
  const body = constraintBody("b2b_supply_agreements_self_service_status_check");
  assert.strictEqual(body, "plan_type is null or status <> 'paused'");
});

test("44: no migration up to 058 is modified in the working tree", () => {
  // 058 and everything before it are APPLIED TO PRODUCTION. Editing one
  // would make the file and the database disagree for good.
  const changed = execFileSync("git", ["status", "--porcelain", "--", "supabase/migrations"],
    { cwd: ROOT, encoding: "utf-8" }).trim();
  for (const line of changed ? changed.split(/\r?\n/) : []) {
    const file = line.slice(3).trim().replace(/^"|"$/g, "");
    const number = Number(path.basename(file).slice(0, 3));
    assert.ok(Number.isInteger(number) && number >= 59,
      `an applied migration has an uncommitted edit: ${line}`);
  }
});

test("45: OLD is never read in a condition that also fires on INSERT", () => {
  // plpgsql compiles a condition into ONE SQL expression and PostgreSQL
  // does not promise to short-circuit AND, so
  //   if tg_op = 'UPDATE' and old.x is distinct from new.x then
  // evaluates OLD on an INSERT - where it is not assigned - and fails
  // with "record old is not assigned yet" on the very first row. The
  // guarded reference has to be NESTED inside its own `if tg_op` block.
  const items = sql.slice(sql.indexOf("create function public.b2b_supply_items_integrity_trigger"));
  const body = items.slice(0, items.indexOf("$$;")).replace(/\s+/g, " ");
  assert.ok(!/if tg_op = 'UPDATE' and old\./.test(body),
    "OLD is read in a compound condition that an INSERT also evaluates");
  assert.ok(body.includes("if tg_op = 'UPDATE' then if old.supply_agreement_id is distinct from"),
    "the OLD reference must be nested inside its own tg_op test");
  // The DELETE branch returns before anything reads NEW, for the mirror
  // reason.
  assert.ok(body.indexOf("if tg_op = 'DELETE' then") < body.indexOf("old.supply_agreement_id"));
});

test("46: 059 is registered in the npm test script", () => {
  // The test script is an explicit file list with no glob, so a suite
  // that is not named here never runs at all.
  const pkg = JSON.parse(read("package.json"));
  assert.ok(pkg.scripts.test.includes("tests/b2b-supply-commerce-foundation.test.mjs"));
});

/* ══════════════════════════════════════════════════════════════
   10. POSTGRESQL IDENTIFIER LENGTH
   ══════════════════════════════════════════════════════════════

   PostgreSQL's NAMEDATALEN is 64, which gives an effective identifier
   limit of 63 BYTES. Over that it does not fail - it TRUNCATES, emits a
   NOTICE, and creates the object under a name nobody declared.

   That is the one defect class a suite reading SQL as TEXT is
   structurally blind to: the migration says one name, the catalogue
   holds another, and every assertion here would still pass. It was found
   by applying 059 to a real PostgreSQL 17.10 cluster, where three
   constraint names were silently shortened.

   So the rule is asserted on the bytes, for every identifier BOTH
   migrations declare. */

/** The effective identifier limit: NAMEDATALEN (64) minus the terminator. */
const PG_MAX_IDENTIFIER_BYTES = 63;

/** Every identifier a migration explicitly declares, by kind. */
const declaredIdentifiers = migrationSql => {
  const text = migrationSql.replace(/^\s*--.*$/gm, "");
  const patterns = [
    ["constraint", /add constraint\s+([a-z0-9_]+)/gi],
    ["constraint", /(?:^|,)\s*constraint\s+([a-z0-9_]+)\s+(?:check|unique|primary|foreign)/gim],
    ["index", /create\s+(?:unique\s+)?index\s+(?:if not exists\s+)?([a-z0-9_]+)/gi],
    ["function", /create\s+(?:or replace\s+)?function\s+public\.([a-z0-9_]+)/gi],
    ["trigger", /create\s+(?:constraint\s+)?trigger\s+([a-z0-9_]+)/gi],
    ["policy", /create\s+policy\s+"([^"]+)"/gi],
    ["table", /create\s+table\s+(?:if not exists\s+)?public\.([a-z0-9_]+)/gi],
  ];
  const found = [];
  for (const [kind, re] of patterns) {
    for (const m of text.matchAll(re)) found.push({ kind, name: m[1] });
  }
  return found;
};

const MIGRATION_060 = "060_b2b_payment_delivery_foundation.sql";

test("53: no identifier in 059 or 060 exceeds PostgreSQL's 63-byte limit", () => {
  for (const [label, sqlText] of [
    [MIGRATION, migration],
    [MIGRATION_060, read(`supabase/migrations/${MIGRATION_060}`)],
  ]) {
    const declared = declaredIdentifiers(sqlText);
    assert.ok(declared.length > 30,
      `${label}: expected the declared identifiers to be found, got ${declared.length}`);
    for (const { kind, name } of declared) {
      const bytes = Buffer.byteLength(name, "utf8");
      assert.ok(bytes <= PG_MAX_IDENTIFIER_BYTES,
        `${label}: ${kind} "${name}" is ${bytes} bytes - PostgreSQL would silently truncate it to `
        + `"${Buffer.from(name, "utf8").subarray(0, PG_MAX_IDENTIFIER_BYTES).toString("utf8")}", `
        + `so the catalogue name would not be the declared name`);
    }
  }
});

test("54: the three shortened cancellation constraints are exactly these names", () => {
  // Real PostgreSQL truncated all three. The replacements drop the
  // redundant trailing _check, which for the first two happens to be
  // character-for-character what the server already produced - so the
  // rename is also the name anyone who inspected the truncated catalogue
  // would already have seen.
  const SHORTENED = [
    ["b2b_supply_agreements_cancellation_requested_requires_effective", 63],
    ["b2b_supply_agreements_cancellation_effective_requires_requested", 63],
    ["b2b_supply_agreements_cancellation_reason_requires_request", 58],
  ];
  for (const [name, bytes] of SHORTENED) {
    assert.strictEqual(Buffer.byteLength(name, "utf8"), bytes,
      `${name} is no longer ${bytes} bytes`);
    assert.ok(flat.includes(`add constraint ${name} check (`),
      `the shortened constraint ${name} is not declared in 059`);
  }
  // AND THE OVERLONG ORIGINALS ARE GONE. Each is DERIVED by putting the
  // redundant suffix back rather than written out, so this assertion
  // does not contain the very strings it forbids - which is what made an
  // earlier version of it match its own source.
  for (const [name] of SHORTENED) {
    const gone = `${name}_check`;
    assert.ok(Buffer.byteLength(gone, "utf8") > PG_MAX_IDENTIFIER_BYTES,
      `${gone} is not actually overlong, so this regression guard proves nothing`);
    assert.ok(!migration.includes(gone),
      `the overlong name ${gone} (${Buffer.byteLength(gone, "utf8")} bytes) is back in 059`);
  }
});

test("55: every declared identifier is unique within its kind", () => {
  for (const [label, sqlText] of [
    [MIGRATION, migration],
    [MIGRATION_060, read(`supabase/migrations/${MIGRATION_060}`)],
  ]) {
    const seen = new Map();
    for (const { kind, name } of declaredIdentifiers(sqlText)) {
      const key = `${kind}|${name}`;
      assert.ok(!seen.has(key), `${label}: ${kind} "${name}" is declared twice`);
      seen.set(key, true);
    }
    // And no two names collide once truncated to the limit, which is the
    // silent-corruption case: two distinct declarations becoming one
    // object. Constraint names share a per-table namespace, so this is
    // the check that matters even though all names are now short enough.
    const truncated = new Map();
    for (const { kind, name } of declaredIdentifiers(sqlText)) {
      const t = `${kind}|${Buffer.from(name, "utf8").subarray(0, PG_MAX_IDENTIFIER_BYTES).toString("utf8")}`;
      assert.ok(!truncated.has(t),
        `${label}: "${name}" and "${truncated.get(t)}" collide when truncated to ${PG_MAX_IDENTIFIER_BYTES} bytes`);
      truncated.set(t, name);
    }
  }
});
