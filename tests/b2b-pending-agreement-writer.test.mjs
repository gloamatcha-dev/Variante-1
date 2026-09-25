import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  B2B_INSTALMENT_COUNTS,
  B2B_SELF_SERVICE_MAX_PACKS,
  B2B_MIN_PACKS,
  PACK_NET_CENTS,
  B2B_PACK_GRAMS,
  B2B_PRICING_RULES_VERSION,
  B2B_ANNUAL_DISCOUNT_PERCENT,
  B2B_ANNUAL_DELIVERY_COUNT,
  annualProductNetCents,
  allocateInstalments,
} from "../lib/b2bPricingRules.ts";
import { NET_ORIGIN_TAX_CALCULATION_VERSION } from "../lib/tax.ts";
import { B2B_BERLIN_ELIGIBILITY_VERSION } from "../lib/b2bBerlinEligibility.ts";
import {
  B2B_CHECKOUT_VERSION,
  B2B_FOREIGN_ROUTING_KEYS,
  B2B_PLAN_TYPES,
  B2B_SESSION_AGREEMENT_METADATA_KEY,
  B2B_SUPPORTED_INSTALMENT_COUNTS,
  B2B_SELF_SERVICE_PACK_RANGE,
  buildB2bPricingSnapshot,
  buildB2bSessionMetadata,
  classifyB2bSessionMetadata,
  isB2bPlanType,
  validateB2bCheckoutRequest,
} from "../lib/b2bCheckoutRules.ts";

/**
 * 061 — THE B2B PENDING AGREEMENT WRITER, AND THE CHECKOUT CONTRACT.
 *
 * Package 5A is the first piece of the trusted write surface that 059
 * and 060 deliberately deferred. It is ONE function and ONE pure rules
 * module, and this suite exists to hold both to the narrow promise they
 * made.
 *
 * ── WHAT THIS SUITE IS PROTECTING ─────────────────────────────
 *
 *   1. RPC-ONLY WRITES. 060 left service_role with SELECT and nothing
 *      else on all four commerce tables. 061 must not widen that by a
 *      single verb; the write authority is the definer's, reached only
 *      through EXECUTE on one function. Section 4 reads the file for
 *      every grant it contains and proves the set is exactly one.
 *
 *   2. THE CALLER CANNOT INVENT A PRICE. Every amount is derived inside
 *      SQL from the same constants and the same rounding the TypeScript
 *      uses. Section 5 derives the expected figures BY CALLING the
 *      Package 1 authority and finds them in the migration, so a
 *      formula that drifts from lib/b2bPricingRules.ts fails here.
 *
 *   3. PENDING MEANS PENDING. No activation, no Stripe object, no
 *      payment row, no delivery row, no order. Section 6 asserts the
 *      absence of each by name, because an absence is the only thing a
 *      foundation writer can promise about the tables it does not touch.
 *
 *   4. ADDITIVE ONLY. 061 creates a function. It must not create,
 *      alter or drop a table, a column, an index, a policy or a
 *      constraint, and 001-060 must be byte-identical.
 *
 *   5. THE ROUTING KEY IS NEW AND DISJOINT. gloa_b2b_agreement_id is
 *      written by no other flow, and a B2B session carrying another
 *      flow's key is malformed rather than ambiguous.
 *
 * ── WHAT IT CANNOT PROVE, AND SAYS SO ─────────────────────────
 *
 * This suite reads SQL AS TEXT. It cannot prove the function runs, that
 * a replay converges, or that service_role is actually refused by the
 * server. Those are proved by applying 001-061 to a real PostgreSQL 17
 * cluster and exercising the writer there, which Package 5A does
 * separately; the properties asserted below are the ones that survive in
 * the repository and fail a review before anything is applied.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS = path.join(ROOT, "supabase", "migrations");
const MIGRATION = "061_b2b_pending_agreement_writer.sql";
const NEWLINE = /\r?\n/;

const read = rel => readFileSync(path.join(ROOT, rel), "utf-8");

const migration = read(`supabase/migrations/${MIGRATION}`);
/** The file with every comment line removed - what PostgreSQL actually sees. */
const sql = migration.replace(/^\s*--.*$/gm, "");
/** Whitespace-collapsed, for predicates that span lines. */
const flat = sql.replace(/\s+/g, " ");

const WRITER = "create_pending_b2b_agreement_for_attempt";
const rules = read("lib/b2bCheckoutRules.ts");

/* ══════════════════════════════════════════════════════════════
   1. THE MIGRATION EXISTS AND IS ADDITIVE ONLY
   ══════════════════════════════════════════════════════════════ */

test("1: 061 owns its number, and only the reviewed 062 follows it", () => {
  const files = readdirSync(MIGRATIONS).filter(f => f.endsWith(".sql")).sort();
  // PACKAGES 5B/5C ADDED MIGRATION 062: the settlement write surface -
  // two SECURITY DEFINER writers and their EXECUTE grants, no table, no
  // policy and no table privilege. Re-pinned rather than deleted: what
  // this guard protects is that 061 still occupies its own number and
  // that nothing UNREVIEWED appeared above it. Reviewed in
  // tests/b2b-checkout-settlement.test.mjs.
  assert.equal(files[files.length - 2], MIGRATION, "061 must be the one before the newest");
  assert.equal(files[files.length - 3], "060_b2b_payment_delivery_foundation.sql");
  assert.equal(files[files.length - 4], "059_b2b_supply_commerce_foundation.sql");
  assert.equal(files.length, 62);
  assert.deepStrictEqual(files.filter(f => Number(f.slice(0, 3)) > 61).sort(),
    ["062_b2b_checkout_settlement.sql"],
    "a migration above 061 appeared that this suite has not been reviewed against");
  assert.deepEqual(files.filter(f => Number(f.slice(0, 3)) > 62), [],
    "an unreviewed migration appeared after 062");
  // No number is used twice, which a copy-paste of a file name would do.
  const numbers = files.map(f => f.slice(0, 3));
  assert.equal(new Set(numbers).size, numbers.length, "a migration number is used twice");
});

test("2: migrations 001 through 061 are unmodified in the working tree", () => {
  // ── 061 IS APPLIED TO PRODUCTION. IT IS IMMUTABLE. ──────────
  //
  // Production is 058 + 059 + 060 + 061. This guard was written before
  // that migration reached production and correctly exempted it then;
  // the moment it was applied, the exemption became a hole over LIVE
  // schema - and a later pass widened the hole by listing it beside
  // 062. Both are corrected here: the ONLY exemption is 062.
  //
  // 062 has not been applied anywhere, which is why it is still the
  // right place to fix 062 and may be edited in place - the same terms
  // 038, 039 and 040 each had while pending. REMOVE THE 062 EXEMPTION
  // THE MOMENT 062 IS APPLIED; test 50 below is what stops this file
  // from ever again claiming that an applied migration is pending.
  const changed = execFileSync("git",
    ["diff", "--name-only", "--diff-filter=MD", "HEAD", "--", "supabase/migrations/"],
    { cwd: ROOT, encoding: "utf-8" }).trim();
  const touched = changed ? changed.split(NEWLINE) : [];
  const PENDING = ["062_b2b_checkout_settlement.sql"];
  const immutable = touched.filter(rel => !PENDING.some(u => rel.endsWith(u)));
  assert.deepEqual(immutable, [], "a live, immutable migration was edited");
  // And the exemption list may not quietly grow back.
  assert.deepEqual(PENDING, ["062_b2b_checkout_settlement.sql"],
    "a second migration was exempted from the immutability guard");
  assert.ok(!PENDING.some(u => u.startsWith("061")),
    "061 is applied to production and must never be exempt");
});

test("3: 061 is wrapped in one transaction", () => {
  assert.match(sql, /^\s*begin;/m, "061 does not open a transaction");
  assert.match(sql, /^\s*commit;\s*$/m, "061 does not commit");
  // One of each. A second begin would leave the first unclosed.
  assert.equal((sql.match(/^\s*begin;/gm) ?? []).length, 1);
  assert.equal((sql.match(/^\s*commit;/gm) ?? []).length, 1);
  assert.ok(!/rollback/i.test(sql), "061 contains a rollback");
});

test("4: 061 creates no table, column, index, constraint, trigger or policy", () => {
  for (const forbidden of [
    /create\s+table/i, /alter\s+table/i, /add\s+column/i, /drop\s+column/i,
    /create\s+(unique\s+)?index/i, /add\s+constraint/i, /drop\s+constraint/i,
    /create\s+(constraint\s+)?trigger/i, /drop\s+trigger/i,
    /create\s+policy/i, /alter\s+policy/i, /drop\s+policy/i,
    /row\s+level\s+security/i, /create\s+type/i, /create\s+sequence/i,
    /create\s+extension/i, /create\s+(or\s+replace\s+)?view/i,
  ]) {
    assert.ok(!forbidden.test(sql), `061 must not contain ${forbidden}`);
  }
});

test("5: 061 drops nothing and deletes no business data", () => {
  for (const forbidden of [/\bdrop\s+/i, /\bdelete\s+from\b/i, /\btruncate\b/i]) {
    assert.ok(!forbidden.test(sql), `061 contains ${forbidden}`);
  }
  // The only INSERTs are inside the writer's body, into the two tables
  // it exists to write. No seed row, no backfill.
  const inserts = [...sql.matchAll(/insert\s+into\s+([a-z0-9_.]+)/gi)].map(m => m[1]);
  assert.deepEqual([...new Set(inserts)].sort(),
    ["public.b2b_supply_agreements", "public.b2b_supply_items"],
    "061 inserts into something other than the agreement and its item");
  // And NO UPDATE anywhere: a replay returns the existing agreement, it
  // never overwrites one.
  assert.ok(!/\bupdate\s+public\./i.test(sql), "061 updates a table");
});

test("6: 061 changes no role model and touches no other migration's objects", () => {
  for (const forbidden of [
    "alter default privileges", "create role", "alter role", "drop role",
    "security label", "alter function", "create or replace function",
  ]) {
    assert.ok(!sql.toLowerCase().includes(forbidden), `061 contains ${forbidden}`);
  }
  // Plain CREATE FUNCTION, so an existing function of this name fails
  // the migration instead of being silently redefined.
  assert.match(sql, new RegExp(`create function public\\.${WRITER}`),
    "the writer is not created with a plain CREATE FUNCTION");
});

/* ══════════════════════════════════════════════════════════════
   2. THE SECURITY CONTRACT
   ══════════════════════════════════════════════════════════════ */

test("7: the writer is SECURITY DEFINER with an empty pinned search_path", () => {
  const header = sql.slice(sql.indexOf(`create function public.${WRITER}`),
                           sql.indexOf("as $$"));
  assert.match(header, /security\s+definer/i, "the writer is not SECURITY DEFINER");
  assert.match(header, /set\s+search_path\s*=\s*''/i, "search_path is not pinned to empty");
  assert.match(header, /\bvolatile\b/i, "a writer must be volatile");
  assert.match(header, /returns\s+jsonb/i, "the writer does not return jsonb");
});

test("8: with an empty search_path every reference is schema-qualified", () => {
  const body = sql.slice(sql.indexOf(`create function public.${WRITER}`));
  // Every table this body touches, by name, must carry its schema.
  for (const table of ["checkout_attempts", "b2b_supply_agreements",
                       "b2b_supply_items", "profiles"]) {
    const bare = new RegExp(`(from|into|join|update)\\s+${table}\\b`, "i");
    assert.ok(!bare.test(body), `${table} is referenced without its schema`);
    assert.ok(body.includes(`public.${table}`), `public.${table} is never referenced`);
  }
  // And the built-ins too: with search_path = '' an unqualified
  // jsonb_build_object does not resolve at all.
  assert.ok(!/[^.]\bjsonb_build_object\(/.test(body.replace(/pg_catalog\.jsonb_build_object\(/g, "")),
    "jsonb_build_object is called without pg_catalog");
  assert.ok(!/[^.]\bjsonb_typeof\(/.test(body.replace(/pg_catalog\.jsonb_typeof\(/g, "")),
    "jsonb_typeof is called without pg_catalog");
});

test("9: EXECUTE is revoked from PUBLIC, anon and authenticated", () => {
  for (const role of ["public", "anon", "authenticated"]) {
    const re = new RegExp(`revoke all on function public\\.${WRITER}\\s*\\([^)]*\\)\\s*from ${role};`, "i");
    assert.match(flat.replace(/ \( /g, " ("), new RegExp(
      `revoke all on function public\\.${WRITER}\\s*\\([^)]*\\)\\s*from ${role};`, "i"),
      `EXECUTE is not revoked from ${role}`);
    assert.ok(re.source.length > 0);
  }
  // public FIRST. Revoking the named roles while leaving the PUBLIC
  // default in place would leave the writer reachable with an anon key.
  const iPublic = flat.search(/revoke all on function[^;]*from public;/i);
  const iGrant = flat.search(/grant execute on function/i);
  assert.ok(iPublic >= 0 && iPublic < iGrant,
    "the PUBLIC revoke does not precede the grant");
});

test("10: service_role is the ONLY grantee, and only EXECUTE", () => {
  const grants = [...flat.matchAll(/grant\s+([a-z ,]+?)\s+on\s+(function|table)\s+([a-z0-9_.]+)[^;]*?\s+to\s+([a-z0-9_]+);/gi)]
    .map(m => ({ privilege: m[1].trim(), kind: m[2], object: m[3], grantee: m[4] }));
  assert.equal(grants.length, 1, `061 issues ${grants.length} grants, expected exactly 1`);
  assert.deepEqual(grants[0], {
    privilege: "execute",
    kind: "function",
    object: `public.${WRITER}`,
    grantee: "service_role",
  });
});

test("11: NO table privilege is granted to anybody, by any route", () => {
  // THE SECURITY CORRECTION THIS PACKAGE WAS GIVEN, AS AN ASSERTION.
  // service_role must keep SELECT and only SELECT on the commerce
  // tables; the write authority is the definer's, never a table grant.
  assert.ok(!/grant[^;]*\bon\s+table\b/i.test(sql), "061 grants a table privilege");
  assert.ok(!/grant[^;]*\ball\s+tables\b/i.test(sql), "061 grants on all tables");
  for (const verb of ["insert", "update", "delete", "truncate", "references", "trigger"]) {
    const re = new RegExp(`grant[^;]*\\b${verb}\\b[^;]*\\bto\\b`, "i");
    assert.ok(!re.test(sql), `061 grants ${verb.toUpperCase()}`);
  }
  // And it does not revoke one either: touching the 060 posture at all,
  // in either direction, is out of scope for this migration.
  assert.ok(!/revoke[^;]*\bon\s+table\b/i.test(sql), "061 revokes a table privilege");
});

test("12: the four commerce tables are never named in a privilege statement", () => {
  for (const stmt of flat.split(";")) {
    if (!/^\s*(grant|revoke)\b/i.test(stmt)) continue;
    for (const table of ["b2b_supply_agreements", "b2b_supply_items",
                         "b2b_payment_schedule", "b2b_deliveries",
                         "checkout_attempts", "profiles"]) {
      assert.ok(!stmt.includes(table),
        `a grant/revoke statement names ${table}: ${stmt.trim().slice(0, 120)}`);
    }
  }
});

/* ══════════════════════════════════════════════════════════════
   3. OWNERSHIP IS DERIVED, NEVER ASSERTED
   ══════════════════════════════════════════════════════════════ */

test("13: the attempt is locked FOR UPDATE before anything is decided", () => {
  const body = sql.slice(sql.indexOf(`create function public.${WRITER}`));
  assert.match(body.replace(/\s+/g, " "),
    /from public\.checkout_attempts where id = p_checkout_attempt_id for update/i,
    "the checkout attempt is not locked FOR UPDATE");
  // The lock precedes both the existence lookup and the insert.
  const flatBody = body.replace(/\s+/g, " ");
  const iLock = flatBody.search(/for update/i);
  const iLookup = flatBody.search(/from public\.b2b_supply_agreements/i);
  const iInsert = flatBody.search(/insert into public\.b2b_supply_agreements/i);
  assert.ok(iLock < iLookup, "the agreement is read before the attempt is locked");
  assert.ok(iLock < iInsert, "the agreement is inserted before the attempt is locked");
});

test("14: the agreement's user_id comes from the attempt, never from a parameter", () => {
  const body = sql.slice(sql.indexOf(`create function public.${WRITER}`));
  // The derivation exists...
  assert.match(body.replace(/\s+/g, " "), /v_user_id := v_attempt\.user_id;/,
    "user_id is not derived from the locked attempt");
  // ...and the claim parameter NEVER reaches a column. This is the
  // property that makes pairing user A's attempt with user B
  // unrepresentable rather than merely refused.
  const insertBlock = body.slice(body.indexOf("insert into public.b2b_supply_agreements"),
                                 body.indexOf("returning * into v_agreement"));
  assert.ok(!insertBlock.includes("p_expected_user_id"),
    "the caller-supplied user id reaches the INSERT");
  assert.ok(insertBlock.includes("v_user_id"), "the derived user id is not inserted");
});

test("15: ownership is proved BEFORE any agreement is resolved or reported", () => {
  const flatBody = sql.slice(sql.indexOf(`create function public.${WRITER}`)).replace(/\s+/g, " ");
  const iOwned = flatBody.search(/attempt_not_owned/);
  const iLookup = flatBody.search(/from public\.b2b_supply_agreements where checkout_attempt_id/i);
  assert.ok(iOwned >= 0 && iOwned < iLookup,
    "the existing-agreement branch is reachable before ownership is proved - a guessed "
    + "attempt id would become an oracle for somebody else's agreement id and status");
});

test("16: a guest attempt and a non-business account are both refused", () => {
  const body = sql.slice(sql.indexOf(`create function public.${WRITER}`));
  assert.ok(body.includes("attempt_not_account_bound"),
    "a NULL checkout_attempts.user_id is not refused - 009 makes that column nullable");
  assert.ok(body.includes("not_business_account"),
    "a non-business account is not refused");
  // is_business_user() reads auth.uid(), which is NULL inside a
  // service_role RPC, so it would answer false for every caller. The
  // same predicate must be asked of profiles directly.
  assert.ok(!/public\.is_business_user\s*\(/.test(body),
    "the writer calls is_business_user(), which cannot work in a definer RPC");
  assert.match(body.replace(/\s+/g, " "),
    /from public\.profiles where user_id = v_user_id and customer_type = 'business'/i,
    "the business check does not ask profiles directly");
});

/* ══════════════════════════════════════════════════════════════
   4. IDEMPOTENCY, AND THE CONFLICT THAT MUST NOT BE SILENT
   ══════════════════════════════════════════════════════════════ */

test("17: a replay with the same inputs returns the existing agreement", () => {
  const body = sql.slice(sql.indexOf(`create function public.${WRITER}`));
  assert.ok(body.includes("'result', 'existing'"), "there is no idempotent 'existing' answer");
  assert.ok(body.includes("'result', 'created'"), "there is no 'created' answer");
  // Resolved by the checkout attempt, which is what 059's unique index
  // b2b_supply_agreements_checkout_attempt_id_key guarantees is unique.
  assert.match(body.replace(/\s+/g, " "),
    /from public\.b2b_supply_agreements where checkout_attempt_id = p_checkout_attempt_id/i,
    "the replay is not resolved by checkout_attempt_id");
});

test("18: a replay with DIFFERENT commercial inputs is refused, twice over", () => {
  const body = sql.slice(sql.indexOf(`create function public.${WRITER}`));
  const conflicts = [...body.matchAll(/'result', 'conflicting_agreement'/g)];
  // Once on the ordinary lookup path and once inside the
  // unique_violation handler: a caller that LOSES the insert race must
  // be held to the same comparison as one that never raced.
  assert.equal(conflicts.length, 2,
    "the conflict comparison is missing from one of the two paths");
  // And every commercial field is compared, not just the plan.
  for (const column of ["plan_type", "quantity_packs", "instalment_count",
                        "base_monthly_product_net_cents", "contract_product_net_cents",
                        "discount_percent", "delivery_count", "user_id"]) {
    const re = new RegExp(`v_agreement\\.${column} is distinct from`, "g");
    assert.equal((body.match(re) ?? []).length, 2,
      `${column} is not compared on both conflict paths`);
  }
});

test("19: the race is resolved by adopting the winner, never by raising blindly", () => {
  const body = sql.slice(sql.indexOf(`create function public.${WRITER}`));
  assert.match(body, /exception\s+when unique_violation then/i,
    "the insert has no unique_violation handler");
  // The handler re-reads and returns; `raise` remains only as the
  // last resort when the winner cannot be found at all.
  const handler = body.slice(body.indexOf("when unique_violation then"));
  assert.ok(handler.includes("select * into v_agreement"), "the handler does not re-read");
  assert.ok(handler.includes("raise;"), "the handler swallows a violation it cannot explain");
});

test("20: nothing is overwritten on any path - the writer contains no UPDATE", () => {
  const body = sql.slice(sql.indexOf(`create function public.${WRITER}`));
  assert.ok(!/\bupdate\s+public\./i.test(body), "the writer updates a row");
  // `for update` is a lock clause, not an UPDATE statement, and is the
  // only place the word may appear.
  const updates = [...body.matchAll(/\bupdate\b/gi)];
  for (const m of updates) {
    const before = body.slice(Math.max(0, m.index - 4), m.index).toLowerCase();
    assert.ok(before.endsWith("for "), `an UPDATE statement appears at offset ${m.index}`);
  }
});

/* ══════════════════════════════════════════════════════════════
   5. THE CALLER CANNOT INVENT A PRICE
   ══════════════════════════════════════════════════════════════ */

test("21: the launch constants in the writer are the Package 1 constants", () => {
  const body = sql.slice(sql.indexOf(`create function public.${WRITER}`));
  const flatBody = body.replace(/\s+/g, " ");
  assert.ok(flatBody.includes(`v_pack_grams constant integer := ${B2B_PACK_GRAMS};`),
    "pack_grams is not the Package 1 constant");
  assert.ok(flatBody.includes(`v_pack_net_cents constant integer := ${PACK_NET_CENTS};`),
    "pack_net_cents is not the Package 1 constant");
  assert.ok(flatBody.includes(`v_rules_version constant text := '${B2B_PRICING_RULES_VERSION}';`),
    "the rules version is not the Package 1 version");
});

test("22: the annual contract formula is the Package 1 formula, per pack count", () => {
  const body = sql.slice(sql.indexOf(`create function public.${WRITER}`)).replace(/\s+/g, " ");
  // The SQL expression, exactly as 059 states it.
  assert.ok(body.includes("((2 * (v_base_monthly::bigint * 12 * 85) + 100) / 200)::integer"),
    "the annual amount is not derived by the canonical half-up expression");
  // And it agrees with the TypeScript authority for every admitted pack
  // count - computed here rather than copied, so a drift in either
  // direction fails.
  for (let packs = B2B_MIN_PACKS; packs <= B2B_SELF_SERVICE_MAX_PACKS; packs += 1) {
    const base = packs * PACK_NET_CENTS;
    const sqlResult = Math.floor((2 * (base * 12 * 85) + 100) / 200);
    assert.equal(sqlResult, annualProductNetCents(packs),
      `the SQL expression and annualProductNetCents disagree at ${packs} packs`);
  }
});

test("23: the discount, delivery count and commitment are derived, not accepted", () => {
  const body = sql.slice(sql.indexOf(`create function public.${WRITER}`)).replace(/\s+/g, " ");
  assert.ok(body.includes(`v_discount := ${B2B_ANNUAL_DISCOUNT_PERCENT};`),
    "the annual discount is not the Package 1 constant");
  assert.ok(body.includes("v_discount := 0;"), "the monthly discount is not zero");
  assert.ok(body.includes(`v_delivery_count := ${B2B_ANNUAL_DELIVERY_COUNT};`),
    "the annual delivery count is not the Package 1 constant");
  assert.ok(body.includes("v_base_monthly := p_quantity_packs * v_pack_net_cents;"),
    "the monthly basis is not derived from the pack constant");
  // 1 -> 12, 2 -> 6, 4 -> 3.
  assert.ok(body.includes("v_billing_count := 12 / p_instalment_count;"),
    "the annual billing interval is not derived from the instalment count");
  for (const n of B2B_INSTALMENT_COUNTS) {
    assert.equal(12 % n, 0, `12 / ${n} is not exact, so the derivation would truncate`);
  }
});

test("24: the writer takes no amount of any kind as a parameter", () => {
  const header = sql.slice(sql.indexOf(`create function public.${WRITER}`),
                           sql.indexOf("returns jsonb"));
  for (const forbidden of ["cents", "amount", "total", "price", "net", "gross", "discount"]) {
    assert.ok(!header.toLowerCase().includes(forbidden),
      `the writer accepts a money parameter containing "${forbidden}": ${header}`);
  }
  // Exactly the ten reviewed parameters, no more.
  const params = [...header.matchAll(/\bp_[a-z_]+/g)].map(m => m[0]);
  assert.deepEqual(params, [
    "p_checkout_attempt_id", "p_expected_user_id", "p_plan_type", "p_quantity_packs",
    "p_instalment_count", "p_pricing_snapshot", "p_business_snapshot",
    "p_customer_snapshot", "p_shipping_address_snapshot", "p_billing_address_snapshot",
  ], "the parameter list changed");
});

test("25: the status is always 'pending' and the legacy money columns are never set", () => {
  const body = sql.slice(sql.indexOf(`create function public.${WRITER}`));
  const insertBlock = body.slice(body.indexOf("insert into public.b2b_supply_agreements"),
                                 body.indexOf("returning * into v_agreement"));
  assert.ok(insertBlock.includes("'pending'"), "the agreement is not created pending");
  assert.ok(!insertBlock.includes("'active'"), "the writer can create an active agreement");
  // 059 requires all eight to be NULL on a self-service row, so naming
  // one at all would be naming a column that must not be written.
  for (const legacy of ["subtotal_net_cents", "subtotal_gross_cents", "discount_total_cents",
                        "shipping_net_cents", "shipping_gross_cents", "tax_total_cents",
                        "total_net_cents", "total_gross_cents"]) {
    assert.ok(!insertBlock.includes(legacy),
      `the writer sets the superseded legacy column ${legacy}`);
  }
  // offer_model_id must be NULL: 059's identity check requires it, so
  // the 003 draft cannot re-enter as a second pricing authority.
  assert.match(insertBlock.replace(/\s+/g, " "), /offer_model_id,/);
  assert.match(insertBlock.replace(/\s+/g, " "), / null,/);
});

/* ══════════════════════════════════════════════════════════════
   6. PENDING MEANS PENDING
   ══════════════════════════════════════════════════════════════ */

test("26: the writer creates no payment row, no delivery row and no order", () => {
  for (const table of ["b2b_payment_schedule", "b2b_deliveries", "orders", "order_items",
                       "annual_plans", "subscriptions", "annual_plan_deliveries"]) {
    assert.ok(!sql.includes(table), `061 references ${table}`);
  }
});

test("27: the writer sets no activation fact and no Stripe identity", () => {
  const body = sql.slice(sql.indexOf(`create function public.${WRITER}`));
  const insertBlock = body.slice(body.indexOf("insert into public.b2b_supply_agreements"),
                                 body.indexOf("returning * into v_agreement"));
  for (const column of ["started_at", "stripe_subscription_id", "ended_at",
                        "next_delivery_at", "commitment_end_at",
                        "cancellation_requested_at", "cancellation_effective_at",
                        "cancellation_reason", "termination_reason"]) {
    assert.ok(!insertBlock.includes(column),
      `a pending agreement is created carrying ${column}`);
  }
});

test("28: 061 contains no Stripe logic and no shipping resolution", () => {
  // The attempt's own Stripe columns are READ below as a pre-Stripe
  // guard, and reading a column is not Stripe logic - so they are
  // blanked before this scan rather than being allowed to defeat it.
  const withoutAttemptColumns = sql
    .replace(/v_attempt\.[a-z0-9_]+/g, "v_attempt.column")
    .replace(/stripe_(checkout_session|payment_intent|invoice)_id/g, "attempt_column");
  for (const forbidden of [/stripe_customer/i, /price_id/i, /checkout\.session/i,
                           /stripe\.[a-z]/i, /setup_future_usage/i, /line_items/i,
                           /shipping_class/i, /shipping_snapshot/i,
                           /berlin_eligibility_snapshot/i, /delivery_address_snapshot/i,
                           /carrier/i, /\bdhl\b/i, /parcel/i, /girth/i, /tare/i]) {
    assert.ok(!forbidden.test(withoutAttemptColumns), `061 contains ${forbidden}`);
  }
  // The attempt's Stripe columns are READ as a pre-Stripe guard, which
  // is not Stripe logic - and reading them is required, so they are
  // asserted PRESENT rather than absent.
  const body = sql.slice(sql.indexOf(`create function public.${WRITER}`));
  for (const column of ["stripe_checkout_session_id", "stripe_payment_intent_id",
                        "stripe_invoice_id", "subscription_id",
                        "annual_plan_id", "annual_delivery_number"]) {
    assert.ok(body.includes(`v_attempt.${column} is not null`),
      `the pre-Stripe guard does not check ${column}`);
  }
  assert.ok(body.includes("attempt_not_pre_stripe"), "there is no pre-Stripe refusal");
});

test("29: the canonical item is created in the 059-authoritative shape", () => {
  const body = sql.slice(sql.indexOf(`create function public.${WRITER}`));
  const itemBlock = body.slice(body.indexOf("insert into public.b2b_supply_items"));
  assert.ok(itemBlock.includes("'canonical_matcha'"), "the item has no canonical role");
  assert.ok(itemBlock.includes("v_pack_grams"), "the item does not mirror pack_grams");
  assert.ok(itemBlock.includes("p_quantity_packs"), "the item does not mirror the quantity");
  assert.ok(itemBlock.includes("v_pack_net_cents"), "the item does not mirror the pack price");
  // 059's canonical shape requires all six accounting columns NULL and
  // product_size_id NULL, so none may be named at all.
  // Word-anchored: base_unit_price_net_cents legitimately CONTAINS
  // unit_price_net_cents, and it is the one column that must be there.
  for (const column of ["unit_price_net_cents", "unit_price_gross_cents",
                        "line_total_net_cents", "line_total_gross_cents",
                        "tax_rate_percent", "discount_percent", "sku",
                        "product_reference", "variant_name"]) {
    const re = new RegExp(`(^|[^a-z0-9_])${column}([^a-z0-9_]|$)`, "m");
    assert.ok(!re.test(itemBlock), `the canonical item sets ${column}`);
  }
  assert.ok(/(^|[^a-z0-9_])base_unit_price_net_cents([^a-z0-9_]|$)/m.test(itemBlock),
    "the canonical item does not state base_unit_price_net_cents");
  assert.ok(itemBlock.includes("product_size_id"), "product_size_id is not stated");
});

/* ══════════════════════════════════════════════════════════════
   7. IDENTIFIER LENGTH
   ══════════════════════════════════════════════════════════════
   The defect class a suite reading SQL as text is otherwise blind to:
   PostgreSQL TRUNCATES an identifier over 63 bytes and creates the
   object under a name nobody declared. 059 was caught by it once. */

const PG_MAX_IDENTIFIER_BYTES = 63;

const declaredIdentifiers = migrationSql => {
  const text = migrationSql.replace(/^\s*--.*$/gm, "");
  const patterns = [
    ["function", /create\s+(?:or replace\s+)?function\s+public\.([a-z0-9_]+)/gi],
    ["constraint", /add constraint\s+([a-z0-9_]+)/gi],
    ["index", /create\s+(?:unique\s+)?index\s+(?:if not exists\s+)?([a-z0-9_]+)/gi],
    ["trigger", /create\s+(?:constraint\s+)?trigger\s+([a-z0-9_]+)/gi],
    ["table", /create\s+table\s+(?:if not exists\s+)?public\.([a-z0-9_]+)/gi],
    ["variable", /\b(v_[a-z0-9_]+|p_[a-z0-9_]+)\b/gi],
  ];
  const found = [];
  for (const [kind, re] of patterns) {
    for (const m of text.matchAll(re)) found.push({ kind, name: m[1] });
  }
  return found;
};

test("30: no identifier in 061 exceeds PostgreSQL's 63-byte limit", () => {
  const declared = declaredIdentifiers(migration);
  assert.ok(declared.length > 10,
    `expected the declared identifiers to be found, got ${declared.length}`);
  for (const { kind, name } of declared) {
    const bytes = Buffer.byteLength(name, "utf8");
    assert.ok(bytes <= PG_MAX_IDENTIFIER_BYTES,
      `${kind} "${name}" is ${bytes} bytes - PostgreSQL would silently truncate it to `
      + `"${Buffer.from(name, "utf8").subarray(0, PG_MAX_IDENTIFIER_BYTES).toString("utf8")}"`);
  }
});

test("31: no two declared identifiers collide when truncated", () => {
  const truncated = new Map();
  for (const { kind, name } of declaredIdentifiers(migration)) {
    const key = `${kind}|${Buffer.from(name, "utf8").subarray(0, PG_MAX_IDENTIFIER_BYTES).toString("utf8")}`;
    const prior = truncated.get(key);
    assert.ok(prior === undefined || prior === name,
      `"${name}" and "${prior}" collide when truncated to ${PG_MAX_IDENTIFIER_BYTES} bytes`);
    truncated.set(key, name);
  }
  assert.ok(Buffer.byteLength(WRITER, "utf8") <= PG_MAX_IDENTIFIER_BYTES);
});

/* ══════════════════════════════════════════════════════════════
   8. THE PURE RULES MODULE
   ══════════════════════════════════════════════════════════════ */

test("32: the rules leaf imports no Stripe, no Supabase, no env and no network", () => {
  for (const forbidden of [/from "stripe"/, /from "@supabase/, /process\.env/,
                           /import\.meta\.env/, /\bfetch\(/, /require\(/,
                           /from "\.\/stripe/, /from "\.\/supabase/]) {
    assert.ok(!forbidden.test(rules), `lib/b2bCheckoutRules.ts contains ${forbidden}`);
  }
  // No clock and no randomness either: both would make the contract
  // untestable and the snapshot unreproducible.
  assert.ok(!/\bDate\.now\(|\bnew Date\(|Math\.random\(/.test(rules),
    "the rules leaf reads a clock or a random source");
});

test("33: the rules leaf never reaches the B2C gross-origin quote", () => {
  // THE CONTAINMENT THAT MATTERS MOST. lib/checkoutQuote.ts prices a
  // gross-origin cart with catalog prices, shipping zones and a launch
  // discount. B2B is net-origin and contractual, and the two pricing
  // models must not meet.
  // Asserted against the IMPORT STATEMENTS, not the prose: the file's
  // comments deliberately name lib/checkoutQuote.ts in order to say
  // that B2B must never reach it, and a scan of the whole text would
  // make that explanation impossible to write.
  const importBlock = [...rules.matchAll(/from "([^"]+)"/g)].map(m => m[1]).join("\n");
  for (const forbidden of ["checkoutQuote", "launchDiscount", "catalogProducts",
                           "subscriptionPlans", "annualPlanRules", "shipping.ts",
                           "orderAddressSnapshot", "checkoutAttempts"]) {
    assert.ok(!importBlock.includes(forbidden),
      `lib/b2bCheckoutRules.ts imports ${forbidden}`);
  }
  // What it DOES import is exactly the three approved authorities.
  const imports = [...rules.matchAll(/from "(\.\/[^"]+)"/g)].map(m => m[1]).sort();
  assert.deepEqual([...new Set(imports)],
    ["./b2bBerlinEligibility.ts", "./b2bPricingRules.ts", "./tax.ts"],
    "the rules leaf imports something other than the three approved authorities");
  // Explicit .ts extensions, or the Node test runner cannot load it.
  for (const spec of imports) {
    assert.ok(spec.endsWith(".ts"), `${spec} has no explicit .ts extension`);
  }
});

test("34: the rules leaf restates no pricing formula of its own", () => {
  // Package 1 owns every amount. A multiplication or a rounding here
  // would be a second authority that 059's snapshot CHECK could not see.
  const body = rules.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const forbidden of [/Math\.floor/, /Math\.round/, /Math\.ceil/,
                           /\* *12\b/, /\* *85\b/, /\/ *100\b/, /5250/, /0\.85/]) {
    assert.ok(!forbidden.test(body),
      `lib/b2bCheckoutRules.ts computes a price itself: ${forbidden}`);
  }
});

test("35: exactly two plan types, and the quantity window is Package 1's", () => {
  assert.deepEqual([...B2B_PLAN_TYPES], ["monthly", "annual"]);
  assert.equal(isB2bPlanType("monthly"), true);
  assert.equal(isB2bPlanType("annual"), true);
  for (const bad of ["MONTHLY", "weekly", "", null, undefined, 1, {}]) {
    assert.equal(isB2bPlanType(bad), false, `${String(bad)} was accepted as a plan type`);
  }
  assert.equal(B2B_SELF_SERVICE_PACK_RANGE.min, B2B_MIN_PACKS);
  assert.equal(B2B_SELF_SERVICE_PACK_RANGE.max, B2B_SELF_SERVICE_MAX_PACKS);
  assert.deepEqual([...B2B_SUPPORTED_INSTALMENT_COUNTS], [...B2B_INSTALMENT_COUNTS]);
});

test("36: the quantity window is enforced at both ends and admits no non-integer", () => {
  const de = { country: "DE", postcode: "10115" };
  for (const packs of [0, -1, 11, 100, 1.5, "2", null, undefined, NaN, Infinity]) {
    const r = validateB2bCheckoutRequest({ planType: "monthly", packs, deliveryAddress: de });
    assert.equal(r.ok, false, `${String(packs)} packs was accepted`);
    assert.equal(r.reason, "quantity_not_self_service");
  }
  for (let packs = B2B_MIN_PACKS; packs <= B2B_SELF_SERVICE_MAX_PACKS; packs += 1) {
    assert.equal(validateB2bCheckoutRequest({ planType: "monthly", packs, deliveryAddress: de }).ok,
      true, `${packs} packs was refused`);
  }
});

test("37: monthly carries no instalment count, annual admits only 1, 2 and 4", () => {
  const de = { country: "DE", postcode: "10115" };
  for (const n of [1, 2, 4, 0, 3, 12]) {
    const r = validateB2bCheckoutRequest({
      planType: "monthly", packs: 2, instalmentCount: n, deliveryAddress: de,
    });
    assert.equal(r.ok, false, `monthly accepted instalmentCount ${n}`);
    assert.equal(r.reason, "monthly_takes_no_instalments");
  }
  // undefined and null are the absence, and are accepted.
  for (const absent of [undefined, null]) {
    assert.equal(validateB2bCheckoutRequest({
      planType: "monthly", packs: 2, instalmentCount: absent, deliveryAddress: de,
    }).ok, true);
  }
  for (const n of B2B_INSTALMENT_COUNTS) {
    const r = validateB2bCheckoutRequest({
      planType: "annual", packs: 2, instalmentCount: n, deliveryAddress: de,
    });
    assert.equal(r.ok, true, `annual refused the approved instalment count ${n}`);
    assert.equal(r.quote.instalmentCount, n);
  }
  for (const n of [0, 3, 5, 6, 12, -1, 2.5, "2", null, undefined]) {
    const r = validateB2bCheckoutRequest({
      planType: "annual", packs: 2, instalmentCount: n, deliveryAddress: de,
    });
    assert.equal(r.ok, false, `annual accepted instalmentCount ${String(n)}`);
    assert.equal(r.reason, "instalment_count_unsupported");
  }
});

test("38: Germany only, and the country is decided by the canonical resolver", () => {
  for (const country of ["FR", "AT", "CH", "US", "", null, undefined, 42]) {
    const r = validateB2bCheckoutRequest({
      planType: "monthly", packs: 2, deliveryAddress: { country, postcode: "10115" },
    });
    assert.equal(r.ok, false, `${String(country)} was accepted as a delivery country`);
    assert.equal(r.reason, "country_not_supported");
  }
  // A malformed German postcode is a THIRD answer, not "wrong country".
  const bad = validateB2bCheckoutRequest({
    planType: "monthly", packs: 2, deliveryAddress: { country: "DE", postcode: "1011" },
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, "postcode_malformed");
  // And a missing address is its own answer again.
  for (const address of [null, undefined]) {
    const r = validateB2bCheckoutRequest({ planType: "monthly", packs: 2, deliveryAddress: address });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "delivery_address_missing");
  }
});

test("39: a non-Berlin German address is accepted - Berlin is a route, not a gate", () => {
  // 0.5 to 5 kg anywhere in Germany. Berlin decides free local delivery
  // versus DHL at DELIVERY RESOLUTION (Package 5E); it must never be a
  // reason to refuse a contract.
  const munich = validateB2bCheckoutRequest({
    planType: "monthly", packs: 3, deliveryAddress: { country: "DE", postcode: "80331" },
  });
  assert.equal(munich.ok, true, "a Munich business was refused a supply contract");
  assert.equal(munich.quote.berlinEligibility.eligible, false);
  assert.equal(munich.quote.berlinEligibility.reason, "postcode_outside_berlin");
  assert.equal(munich.quote.berlinEligibility.rulesVersion, B2B_BERLIN_ELIGIBILITY_VERSION);
  // The negative decision is CARRIED, not discarded: 060 stores it.
  assert.equal(munich.quote.normalizedCountry, "DE");
  assert.equal(munich.quote.normalizedPostcode, "80331");

  const berlin = validateB2bCheckoutRequest({
    planType: "monthly", packs: 3, deliveryAddress: { country: "de", postcode: " 10115 " },
  });
  assert.equal(berlin.ok, true);
  assert.equal(berlin.quote.berlinEligibility.eligible, true);
  // NORMALIZED, so the future shipping resolver and the Berlin snapshot
  // on one delivery row cannot disagree about the address they describe.
  assert.equal(berlin.quote.normalizedPostcode, "10115");
});

test("40: the quote's amounts are the Package 1 authority's, never recomputed", () => {
  const de = { country: "DE", postcode: "10115" };
  for (let packs = B2B_MIN_PACKS; packs <= B2B_SELF_SERVICE_MAX_PACKS; packs += 1) {
    const monthly = validateB2bCheckoutRequest({ planType: "monthly", packs, deliveryAddress: de });
    assert.equal(monthly.quote.pricing.monthlyProductNetCents, packs * PACK_NET_CENTS);
    for (const n of B2B_INSTALMENT_COUNTS) {
      const annual = validateB2bCheckoutRequest({
        planType: "annual", packs, instalmentCount: n, deliveryAddress: de,
      });
      assert.equal(annual.quote.pricing.annualProductNetCents, annualProductNetCents(packs));
      assert.deepEqual(annual.quote.pricing.instalmentNetCents,
        allocateInstalments(annualProductNetCents(packs), n));
      // The sum is exact - no cent is lost or invented by the split.
      assert.equal(annual.quote.pricing.instalmentNetCents.reduce((a, b) => a + b, 0),
        annualProductNetCents(packs));
    }
  }
});

test("41: the approved worked example survives, to the cent", () => {
  // 1 pack, annual, 4 instalments. 5250 x 12 = 63000, less 15 % = 53550,
  // split as 13387 / 13387 / 13387 / 13389 with the remainder on the
  // LAST instalment - so the first payment is the one quoted on the page.
  const r = validateB2bCheckoutRequest({
    planType: "annual", packs: 1, instalmentCount: 4,
    deliveryAddress: { country: "DE", postcode: "10115" },
  });
  assert.equal(r.ok, true);
  assert.equal(r.quote.pricing.baseAnnualNetCents, 63000);
  assert.equal(r.quote.pricing.annualProductNetCents, 53550);
  assert.deepEqual(r.quote.pricing.instalmentNetCents, [13387, 13387, 13387, 13389]);
});

test("42: the pricing snapshot is exactly what migration 059 validates", () => {
  const de = { country: "DE", postcode: "10115" };
  const monthly = validateB2bCheckoutRequest({ planType: "monthly", packs: 4, deliveryAddress: de }).quote;
  const annual = validateB2bCheckoutRequest({
    planType: "annual", packs: 4, instalmentCount: 2, deliveryAddress: de,
  }).quote;

  // The exact key sets 059's b2b_supply_agreements_self_service_
  // pricing_snapshot_check requires, and no key it forbids.
  assert.deepEqual(Object.keys(monthly.pricingSnapshot).sort(), [
    "calculationVersion", "currency", "kilograms", "monthlyProductNetCents",
    "packNetCents", "packs", "priceOrigin", "rulesVersion",
  ]);
  assert.deepEqual(Object.keys(annual.pricingSnapshot).sort(), [
    "annualProductNetCents", "baseAnnualNetCents", "calculationVersion", "currency",
    "deliveryCount", "discountPercent", "instalmentCount", "instalmentNetCents",
    "kilograms", "monthlyEquivalent", "packNetCents", "packs", "priceOrigin",
    "rulesVersion", "savingNetCents",
  ]);
  // A MONTHLY snapshot may carry no annual figure - 059 rejects the row
  // outright if it does.
  for (const forbidden of ["annualProductNetCents", "baseAnnualNetCents", "instalmentCount",
                           "instalmentNetCents", "savingNetCents", "monthlyEquivalent"]) {
    assert.ok(!(forbidden in monthly.pricingSnapshot),
      `the monthly snapshot carries ${forbidden}`);
  }
  // The two authority markers, which 059 pins to literal values.
  for (const snap of [monthly.pricingSnapshot, annual.pricingSnapshot]) {
    assert.equal(snap.rulesVersion, B2B_PRICING_RULES_VERSION);
    assert.equal(snap.calculationVersion, NET_ORIGIN_TAX_CALCULATION_VERSION);
    assert.equal(snap.calculationVersion, "de-net-2026.1");
    assert.equal(snap.priceOrigin, "net");
    assert.equal(snap.currency, "EUR");
  }
  // And the derived identities 059 re-checks in SQL.
  assert.equal(annual.pricingSnapshot.savingNetCents,
    annual.pricingSnapshot.baseAnnualNetCents - annual.pricingSnapshot.annualProductNetCents);
  assert.equal(annual.pricingSnapshot.instalmentNetCents.length,
    annual.pricingSnapshot.instalmentCount);
  assert.equal(annual.pricingSnapshot.monthlyEquivalent.deliveryCount,
    annual.pricingSnapshot.deliveryCount);
  assert.equal(buildB2bPricingSnapshot(annual.pricing).annualProductNetCents,
    annual.pricing.annualProductNetCents);
});

/* ══════════════════════════════════════════════════════════════
   9. THE METADATA CONTRACT
   ══════════════════════════════════════════════════════════════ */

test("43: the routing key is new, and no existing key changed", () => {
  assert.equal(B2B_SESSION_AGREEMENT_METADATA_KEY, "gloa_b2b_agreement_id");
  // The three existing flows keep their keys, verbatim, in their own
  // source. This is the assertion that a B2B package did not reach into
  // B2C routing.
  const annualRules = read("lib/annualPlanWebhookRules.ts");
  assert.ok(annualRules.includes('export const ANNUAL_SESSION_PLAN_METADATA_KEY = "gloa_annual_plan_id"'),
    "the annual routing key changed");
  assert.ok(read("lib/subscriptionCheckout.ts").includes("gloa_subscription_id"),
    "the subscription routing key changed");
  assert.ok(read("app/api/checkout/session/route.ts").includes('checkout_version: "1"'),
    "the one-time metadata changed");
  // And the B2B key is not any of theirs.
  assert.ok(!B2B_FOREIGN_ROUTING_KEYS.includes(B2B_SESSION_AGREEMENT_METADATA_KEY));
  assert.ok(!annualRules.includes(B2B_SESSION_AGREEMENT_METADATA_KEY),
    "the annual flow now mentions the B2B routing key");
});

test("44: the built metadata carries correlation ids only - no money, no identity", () => {
  const meta = buildB2bSessionMetadata({
    requestId: "11111111-1111-4111-8111-111111111111",
    checkoutAttemptId: "22222222-2222-4222-8222-222222222222",
    agreementId: "33333333-3333-4333-8333-333333333333",
  });
  assert.deepEqual(Object.keys(meta).sort(),
    ["checkout_attempt_id", "checkout_version", "gloa_b2b_agreement_id", "request_id"]);
  assert.equal(meta.checkout_version, B2B_CHECKOUT_VERSION);
  assert.equal(meta.checkout_version, "1");
  const serialized = JSON.stringify(meta);
  for (const forbidden of ["cents", "packs", "plan", "amount", "company", "email", "@"]) {
    assert.ok(!serialized.includes(forbidden), `the metadata carries ${forbidden}`);
  }
});

test("45: a session without the key is not B2B, and nothing else is consulted", () => {
  for (const meta of [null, undefined, {},
                      { checkout_version: "1", request_id: "x", checkout_attempt_id: "y" },
                      { gloa_annual_plan_id: "33333333-3333-4333-8333-333333333333" },
                      { gloa_subscription_id: "sub_123" },
                      { gloa_b2b_agreement_id: "" },
                      { gloa_b2b_agreement_id: "   " },
                      { gloa_b2b_agreement_id: 42 }]) {
    assert.equal(classifyB2bSessionMetadata(meta).kind, "not_b2b",
      `misrouted as B2B: ${JSON.stringify(meta)}`);
  }
});

test("46: a session WITH the key is B2B, and a bad one is malformed - never not_b2b", () => {
  const good = {
    checkout_version: "1",
    request_id: "11111111-1111-4111-8111-111111111111",
    checkout_attempt_id: "22222222-2222-4222-8222-222222222222",
    gloa_b2b_agreement_id: "33333333-3333-4333-8333-333333333333",
  };
  const routed = classifyB2bSessionMetadata(good);
  assert.equal(routed.kind, "b2b");
  assert.equal(routed.metadata.agreementId, good.gloa_b2b_agreement_id);
  assert.equal(routed.metadata.requestId, good.request_id);
  assert.equal(routed.metadata.checkoutAttemptId, good.checkout_attempt_id);

  // EVERY corruption is "malformed", because falling through would hand
  // a paid business supply contract to a handler written for a cart.
  const corruptions = [
    { ...good, gloa_b2b_agreement_id: "not-a-uuid" },
    { ...good, checkout_version: "2" },
    { ...good, checkout_version: undefined },
    { ...good, request_id: "nope" },
    { ...good, request_id: undefined },
    { ...good, checkout_attempt_id: "nope" },
    { ...good, checkout_attempt_id: undefined },
    { ...good, gloa_annual_plan_id: "44444444-4444-4444-8444-444444444444" },
    { ...good, gloa_subscription_id: "sub_123" },
  ];
  for (const meta of corruptions) {
    const r = classifyB2bSessionMetadata(meta);
    assert.equal(r.kind, "malformed", `not malformed: ${JSON.stringify(meta)}`);
    assert.ok(typeof r.reason === "string" && r.reason.length > 0);
  }
});

/* ══════════════════════════════════════════════════════════════
   10. SCOPE
   ══════════════════════════════════════════════════════════════ */

test("47: Package 5A defines exactly one writer, and none of the later ones", () => {
  const defined = [...sql.matchAll(/create\s+function\s+public\.([a-z0-9_]+)/gi)].map(m => m[1]);
  assert.deepEqual(defined, [WRITER], "061 defines more than the one reviewed writer");
  // The seven RPCs the architecture audit named for later subpackages
  // must not appear - each belongs with the runtime that calls it.
  for (const later of ["activate_b2b_agreement_from_invoice",
                       "activate_b2b_annual_agreement_from_payment",
                       "record_b2b_instalment", "resolve_b2b_delivery",
                       "claim_due_b2b_deliveries", "hold_b2b_deliveries",
                       "apply_b2b_quantity_change"]) {
    assert.ok(!sql.includes(later), `061 defines or names ${later}, which belongs to a later package`);
  }
});

test("48: Package 5A's own writer is still callable by nothing in 5A", () => {
  // ── WHY THIS GUARD CHANGED SHAPE ────────────────────────────
  //
  // It began as "no application module was edited", which was exactly
  // right for 5A: that package created a writer and a pure leaf and had
  // no runtime at all, so a webhook branch or a B2C checkout change
  // would have meant something had gone wrong.
  //
  // PACKAGES 5B AND 5C legitimately add that runtime - an endpoint, and
  // a B2B branch in the canonical Stripe webhook - so the diff-shaped
  // version of this guard now fails on work it was never written to
  // judge. Re-pinned rather than deleted, and narrowed to the invariant
  // that actually belongs to 5A and still holds after a commit: the
  // PENDING writer is reached only through the checkout deps, and 062's
  // settlement writers never call it.
  const deps = read("lib/b2bCheckoutDeps.ts");
  assert.ok(deps.includes(`admin.rpc("${WRITER}"`),
    "the pending writer is no longer reached through the checkout deps");

  // It is called from exactly one place in the repository.
  const callers = ["lib/b2bCheckoutDeps.ts", "lib/b2bCheckout.ts", "lib/b2bWebhook.ts",
                   "lib/b2bWebhookDeps.ts", "app/api/stripe/webhook/route.ts"]
    .filter(rel => read(rel).includes(`"${WRITER}"`));
  assert.deepEqual(callers, ["lib/b2bCheckoutDeps.ts"],
    "the pending writer gained a second caller");

  // And no route writes the agreement table directly, which is the
  // posture 059 to 062 were all built around.
  for (const rel of ["lib/b2bCheckoutDeps.ts", "lib/b2bWebhookDeps.ts",
                     "app/api/stripe/webhook/route.ts"]) {
    assert.ok(!/from\("b2b_supply_agreements"\)/.test(read(rel)),
      `${rel} writes the agreement table directly`);
  }
});

test("49: the focused suite is registered in the npm test script", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.ok(pkg.scripts.test.includes("tests/b2b-pending-agreement-writer.test.mjs"),
    "the focused 061 suite does not run in the gate");
  // The npm test script is an explicit file list, so a suite that is not
  // named there never runs and never reports that it did not.
  for (const sibling of ["tests/b2b-supply-commerce-foundation.test.mjs",
                         "tests/b2b-payment-delivery-foundation.test.mjs"]) {
    assert.ok(pkg.scripts.test.includes(sibling), `${sibling} fell out of the gate`);
  }
});

test("50: NO SUITE MAY CLAIM THAT 061 IS STILL UNAPPLIED", () => {
  // ── THE GUARD THAT STOPS THIS BUG COMING BACK ───────────────
  //
  // 061 is applied to production. Every migration guard in this
  // repository exempts a PENDING migration from immutability, and the
  // exemption is correct exactly until the migration is applied - after
  // which it is a hole over live schema. That transition has no natural
  // trigger, so it is enforced here instead: a repository-wide scan for
  // any suite still describing 061 as unapplied, or still listing it
  // beside a genuinely pending migration.
  //
  // Modelled on the identical guard tests/launch-discount-migration.mjs
  // holds over 056, and assembled from pieces for the same reason: a
  // literal pattern would match this file's own source and fail forever.
  const NL = String.fromCharCode(10);
  const claims = [
    new RegExp("061" + "[^" + NL + "]{0,80}" + "NOT APP" + "LIED", "i"),
    new RegExp("061" + "[^" + NL + "]{0,80}" + "still " + "pending", "i"),
    new RegExp("NEITHER " + "061", "i"),
  ];
  for (const rel of readdirSync(path.join(ROOT, "tests")).filter(f => f.endsWith(".test.mjs"))) {
    const source = read(`tests/${rel}`);
    for (const claim of claims) {
      assert.ok(!claim.test(source),
        `tests/${rel} still describes 061 as unapplied - it is live in production`);
    }
  }

  // AND NO GUARD MAY EXEMPT IT IN CODE, whatever the prose says. The
  // exemption lists are the thing that actually decides, so they are
  // read directly: no test file may filter 061 out of a migration diff.
  const exemptsInCode = new RegExp(
    "endsWith\(\"" + "061" + "_b2b_pending_agreement_writer\.sql\"\)", "i");
  for (const rel of readdirSync(path.join(ROOT, "tests")).filter(f => f.endsWith(".test.mjs"))) {
    const code = read(`tests/${rel}`)
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.ok(!exemptsInCode.test(code),
      `tests/${rel} exempts the applied migration 061 from an immutability guard`);
  }

  // The one migration that IS pending, stated once so the next reader
  // knows which exemption is legitimate today.
  const files = readdirSync(MIGRATIONS).filter(f => f.endsWith(".sql")).sort();
  assert.equal(files[files.length - 1], "062_b2b_checkout_settlement.sql",
    "the pending migration is no longer the highest - re-check every exemption");
});
