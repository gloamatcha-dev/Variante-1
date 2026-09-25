import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 4A.4b — THE B2B COMMERCIAL DRAFT STOPS REACHING THE BROWSER.
 *
 * Migration 003 built three tables to describe a wholesale offer and let
 * every signed-in business account read all three. The account portal
 * did exactly that, rendering a price table, a discount per model and a
 * calculator built from both.
 *
 * What those tables hold is a FIRST DRAFT: one rate of 125.00/kg, which
 * is 31.25 for 250 g and 62.50 for 500 g - not what GLOA intends to
 * charge - with no 1 kg row at all, and a terms table that has never had
 * a row in it. A business customer signing in was shown conditions
 * nobody had approved, in the one place they would most reasonably be
 * treated as binding.
 *
 * This suite pins the two halves of the fix: the portal stopped reading
 * them, and 053 stopped them being readable.
 *
 * SAFE: reads source and SQL. No database, no network, no server.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf8");

const MIGRATION = "053_b2b_commercial_containment.sql";
const sql = read(`supabase/migrations/${MIGRATION}`).replace(/^\s*--.*$/gm, "");
const migration = read(`supabase/migrations/${MIGRATION}`);
const portal = read("app/AccountPortal.tsx");

/**
 * THE PORTAL WITH THE B2C ANNUAL PLAN CUT OUT.
 *
 * The prepaid annual plan is a B2C product that legitimately renders a
 * discount percentage of its own - its frozen discount_percent_applied,
 * written by migration 039 and never read from any B2B table. It sits in
 * one contiguous block between the marker below and PortalSubscriptions,
 * and tests/annual-plan-purchase-surface.test.mjs holds it to its own
 * rules.
 *
 * Everything OUTSIDE that block - the B2B pages, the supply agreement,
 * the orders and the recurring subscription - is still held to the
 * original containment rule, so the exemption is a hole of exactly one
 * component group rather than a looser pattern applied everywhere.
 *
 * Joined with a newline so the two halves cannot form a match across
 * the seam that exists in neither of them.
 */
const portalWithoutAnnual = (() => {
  const at = portal.indexOf("/* ══ JAHRESPLAN: DIE VORAUSBEZAHLTEN KOMPONENTEN ══");
  const end = portal.indexOf("function PortalSubscriptions()");
  assert.ok(at > -1 && end > at, "the annual block could not be located");
  return portal.slice(0, at) + "\n" + portal.slice(end);
})();

/** The three tables 003 created to describe a wholesale offer. */
const DRAFT_TABLES = ["b2b_product_sizes", "b2b_offer_models", "b2b_general_terms"];

/* ══════════════════════════════════════════════════════════════
   1. NO BROWSER ROLE MAY READ THE DRAFT
   ══════════════════════════════════════════════════════════════ */

test("1: EVERY role is stripped first - service_role included", () => {
  // The whole point of an end state. `grant select` ADDS a privilege and
  // removes none, so granting SELECT to a role that already held
  // INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES or TRIGGER leaves all
  // of them in place while the file appears to say otherwise.
  //
  // 052 made exactly this mistake with service_role's default
  // privileges, and the first draft of 053 repeated it one role along:
  // it revoked from anon and authenticated only, then granted SELECT to
  // service_role - which proves nothing about what service_role kept.
  for (const table of DRAFT_TABLES) {
    const re = new RegExp(`revoke all privileges on table public\\.${table}\\s+from ([a-z_, ]+);`);
    const m = re.exec(sql);
    assert.ok(m, `053 does not revoke all privileges on ${table}`);
    const roles = m[1].split(",").map(r => r.trim()).sort();
    assert.deepEqual(roles, ["anon", "authenticated", "service_role"],
      `${table} is not stripped for every role - a pre-existing privilege would survive`);
  }
});

test("1a2: and the strip happens BEFORE the re-grant, or it would undo it", () => {
  // Order is the whole mechanism: revoke then grant leaves SELECT;
  // grant then revoke leaves nothing at all.
  for (const table of DRAFT_TABLES) {
    const revokeAt = sql.indexOf(`revoke all privileges on table public.${table}`);
    const grantAt = sql.indexOf(`grant select on table public.${table}`);
    assert.ok(revokeAt > -1 && grantAt > -1, `${table} is missing a revoke or a grant`);
    assert.ok(revokeAt < grantAt,
      `${table} is granted before it is revoked, which leaves it with nothing`);
  }
});

test("1b: and no policy lets a browser role in the other way", () => {
  // A grant and a policy are two separate doors. 003 opened both, so
  // both have to close - revoking the grant alone would leave a policy
  // that grants SELECT to is_business_user().
  for (const table of DRAFT_TABLES) {
    assert.match(sql, new RegExp(`drop policy if exists "[^"]+"\\s+on public\\.${table};`),
      `053 leaves a policy on ${table}`);
  }
  // Nothing is created to replace them.
  assert.ok(!/create policy/i.test(sql), "053 creates a policy");
  // And RLS stays on, so the absence of a policy denies rather than
  // being irrelevant.
  for (const table of DRAFT_TABLES) {
    assert.match(sql, new RegExp(`alter table public\\.${table}\\s+enable row level security`),
      `${table} does not have RLS enabled`);
  }
});

test("1c: exactly one privilege goes back, and it is SELECT to service_role", () => {
  const grants = [...sql.matchAll(/grant ([a-z, ]+) on table public\.(b2b_\w+)\s+to (\w+)/g)]
    .map(m => [m[2], m[3], m[1].trim()]);
  assert.equal(grants.length, 3, "053 grants something other than the three server reads");
  for (const [table, role, privilege] of grants) {
    assert.ok(DRAFT_TABLES.includes(table), `053 grants on an unexpected table: ${table}`);
    assert.equal(role, "service_role", `${table} is granted to ${role}`);
    assert.equal(privilege, "select", `${table} grants ${privilege} rather than select`);
  }
  for (const write of ["insert", "update", "delete", "truncate", "all privileges"]) {
    assert.ok(!new RegExp(`grant[^;]*\\b${write}\\b[^;]*on table public\\.b2b_`, "i").test(sql),
      `053 grants ${write} on a commercial table`);
  }
  assert.ok(!/with grant option/i.test(sql), "a privilege is grantable onward");
  assert.ok(!/revoke[^;]*from[^;]*\bpostgres\b/i.test(sql), "053 revokes the owner's own privileges");

  // THE END STATE, ASSERTED AS A PAIR. For each table the file must
  // contain both halves: everything taken from all three roles, and
  // SELECT given back to exactly one. Either alone is not a contract.
  for (const table of DRAFT_TABLES) {
    assert.match(sql, new RegExp(
      `revoke all privileges on table public\\.${table}\\s+from anon, authenticated, service_role;`),
      `${table} does not state its end state`);
    assert.match(sql, new RegExp(`grant select on table public\\.${table}\\s+to service_role;`),
      `${table} does not give SELECT back`);
    // And nothing else is granted on it, to anyone.
    const grantsForTable = [...sql.matchAll(
      new RegExp(`grant ([a-z, ]+) on table public\\.${table}\\s+to (\\w+)`, "g"))];
    assert.equal(grantsForTable.length, 1, `${table} is granted more than once`);
    assert.equal(grantsForTable[0][1].trim(), "select");
    assert.equal(grantsForTable[0][2], "service_role");
  }
});

test("1d: the verification query proves the privilege set, not just its shape", () => {
  // A privilege list without is_grantable does not say whether a role
  // can pass what it holds to another, and an aggregate can hide an
  // extra privilege inside a comma. The migration asks both ways.
  assert.match(migration, /is_grantable/,
    "the verification does not check the grant option");
  assert.match(migration, /string_agg\(privilege_type, ', ' order by privilege_type\)/);
  // The explicit no-write query, naming every privilege that must not
  // survive for any of the three roles.
  for (const privilege of ["INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) {
    assert.ok(migration.includes(`'${privilege}'`),
      `the verification does not look for a surviving ${privilege}`);
  }
  assert.match(migration, /-> NO ROWS\./,
    "the verification does not state the expected empty result");
  assert.match(migration, /service_role \| SELECT \| NO/,
    "the verification does not state the expected privilege row");
});

/* ══════════════════════════════════════════════════════════════
   2. NOTHING IS DELETED, AND NO PRICE IS REWRITTEN
   ══════════════════════════════════════════════════════════════ */

test("2: 053 deletes nothing and drops no table", () => {
  for (const banned of ["delete from", "drop table", "truncate", "drop column"]) {
    assert.ok(!sql.toLowerCase().includes(banned), `053 performs a ${banned}`);
  }
  // No schema is created either - this is a permission migration.
  assert.ok(!/create table|create function|alter table[^;]*add column/i.test(sql),
    "053 creates schema");
});

test("2b: THE STALE PRICES ARE NOT REWRITTEN TO THE NEW ONES", () => {
  // The intended prices are 35.00 / 65.00 / 125.00 net, which are 140,
  // 130 and 125 per kilo - a rate that FALLS with volume. The old table
  // stores one rate for everything, so making it say 35.00 would mean
  // adopting a shape that cannot express the intended list. The real
  // price list belongs in the B2B commerce package.
  assert.ok(!/update public\.b2b_product_sizes/i.test(sql),
    "053 rewrites the product sizes");
  for (const price of ["35.00", "65.00", "125.00", "3500", "6500", "12500", "140", "130"]) {
    assert.ok(!new RegExp(`price_per_kg_net\\s*=\\s*${price}`).test(sql),
      `053 writes ${price} into the old per-kilo column`);
  }
  // And it says why, where the next person will read it.
  assert.match(migration, /IT DOES NOT REWRITE THE PRICES/);
});

/* ══════════════════════════════════════════════════════════════
   3. THE ONE DATA CORRECTION: RECURRING IS NOT DISCOUNTED
   ══════════════════════════════════════════════════════════════ */

test("3: recurring supply goes to 0 %, and only recurring", () => {
  // The product decision: regular monthly supply is the SAME B2B price,
  // delivered on a rhythm and monatlich kündbar. The customer's benefit
  // is not having to reorder - not a lower price.
  assert.match(sql, /update public\.b2b_offer_models\s+set discount_pct = 0\s+where slug = 'recurring'/,
    "053 does not correct the recurring discount");
  // Idempotent: it matches on the value being replaced, so a second run
  // changes nothing and a hand-corrected row is left alone.
  assert.match(sql, /where slug = 'recurring'\s+and discount_pct <> 0;/,
    "the correction is not idempotent");

  // single and annual are NOT touched. annual stays 10 % as an
  // intention; its mechanics are undecided and nothing here implements
  // them.
  for (const slug of ["single", "annual"]) {
    assert.ok(!new RegExp(`set discount_pct[^;]*slug = '${slug}'`).test(sql),
      `053 changes the ${slug} model's discount`);
  }
  // No row is added or removed from the offer models either.
  assert.ok(!/insert into public\.b2b_offer_models|delete from public\.b2b_offer_models/i.test(sql),
    "053 adds or removes an offer model");
});

test("3b: the description stops promising the discount too", () => {
  // A description that still said "5 % Rabatt" would outlive the number
  // it described, which is how a wrong figure comes back through a
  // different door.
  assert.match(sql, /set description = 'Feste Lieferintervalle nach Absprache, zum normalen B2B-Preis\. Monatlich kündbar\.'/);
  assert.ok(!/5 ?% Rabatt|5 ?Prozent Rabatt/i.test(sql), "053 still writes a 5 % discount");
});

/* ══════════════════════════════════════════════════════════════
   4. AND THE PORTAL NO LONGER NEEDS ANY OF IT
   ══════════════════════════════════════════════════════════════ */

test("4: the account portal reads none of the three tables", () => {
  // The order matters operationally: the application stopped reading
  // them BEFORE the migration removes access, so there is no window in
  // which the portal asks for something it may no longer have.
  for (const table of DRAFT_TABLES) {
    assert.ok(!portal.includes(`from("${table}")`),
      `the portal still reads ${table} from the browser`);
  }
});

test("4b: and renders no price, no per-kilo rate and no discount", () => {
  for (const banned of [
    "price_per_kg_net", "discount_pct", "calcPrice", "<B2bCalculator",
    "b2b-pricing-table", "b2b-model-discount", "b2b-pricing-note",
    "DEINE B2B-PREISE", "BEZUGSMODELLE", "PREISMODELL",
  ]) {
    assert.ok(!portal.includes(banned), `the portal still renders ${banned}`);
  }
  // The values the old table produced, by value rather than by name.
  for (const price of ["31,25", "62,50", "31.25", "62.50"]) {
    assert.ok(!portal.includes(price), `the portal prints the stale price ${price}`);
  }
  /*
    NO DISCOUNT-LIKE FIELD IS RENDERED AS A PERCENTAGE.

    THE ORIGINAL RULE, UNCHANGED - applied to the portal with the B2C
    annual block cut out rather than to a looser pattern applied to the
    whole file. The annual plan owns a legitimate B2C discount of its
    own; B2B containment still applies to everything else, so a line
    like {item.discount_percent} % anywhere outside that block still
    fails here.

    That column is not hypothetical: b2b_supply_items.discount_percent
    exists (migration 006), is declared as a read type in the portal and
    arrives in the browser through the agreement's select(*). It is
    currently never printed, and this is what keeps it that way.
  */
  assert.ok(!/\{[^}]*discount[^}]*\} ?%/.test(portalWithoutAnnual),
    "the portal prints a discount percentage");
  // Restated as a named check, so a failure says which source it came
  // from rather than only that some percentage appeared.
  assert.ok(!/\{[^}]*discount_percent[^}]*\} ?%/.test(portalWithoutAnnual),
    "the portal prints the B2B supply item's discount_percent");
  // THE SAME RULE, CASE-INSENSITIVELY. The original pattern is
  // lower-case only, so a camelCase field - b2bDiscount, offerDiscount -
  // would have slipped past it. The source is clean under /i today, so
  // closing that gap costs nothing and is strictly additional to the
  // rule above rather than a replacement for it.
  assert.ok(!/\{[^}]*discount[^}]*\} ?%/i.test(portalWithoutAnnual),
    "the portal prints a discount percentage under a camelCase name");
  assert.ok(!/\{[^}]*offer_model[^}]*\} ?%/.test(portal),
    "the portal prints an offer model percentage");
  // AND THE EXEMPTION IS EXACTLY ONE BLOCK WIDE. If the annual
  // components were ever moved or the marker renamed, this collapses
  // rather than silently widening the hole.
  assert.ok(portalWithoutAnnual.length < portal.length, "the annual block was not excluded");
  assert.ok(portalWithoutAnnual.includes('from("b2b_supply_items")'),
    "the B2B surface fell outside the assertion");
  assert.ok(portalWithoutAnnual.includes("function PortalSubscriptions()"),
    "the recurring subscription fell outside the assertion");
  assert.ok(!portalWithoutAnnual.includes("function AnnualPlanStartForm()"),
    "the annual block is still inside the assertion");
});

test("4c: what stands in their place says what is actually true", () => {
  // The same position the public page has always taken.
  assert.match(portal, /PREISE &amp; KONDITIONEN/);
  assert.match(portal, /individuell mit dir ab/);
  assert.match(portal, /\/for-cafes#lead/, "there is no way to ask for conditions");
});

test("4d: the business ACCOUNT itself is untouched", () => {
  // Only misleading commercial data was removed. Everything that makes
  // the account an account still has to be there.
  for (const kept of [
    "UNTERNEHMENSDATEN", "company_name", "legal_form", "tax_number", "vat_id", "website",
    'from("b2b_supply_agreements")', 'from("orders")',
    'profile?.customer_type === "business"',
  ]) {
    assert.ok(portal.includes(kept), `the business account lost ${kept}`);
  }
  // The B2B area is still business-only, and the private portal is
  // unaffected.
  assert.match(portal, /\{ key: "business", label: "B2B", b2bOnly: true \}/);
});

test("4e: the calculator survives as code, unrendered", () => {
  // The component and its pure module are kept for the B2B commerce
  // package. What changed is that no customer screen calls them - so the
  // logic is not lost, only unpublished.
  assert.match(read("app/B2bCalculator.tsx"), /export function B2bCalculator\(/);
  assert.ok(read("lib/b2bCalculator.ts").length > 0, "the calculator library went missing");
  assert.ok(!portal.includes("B2bCalculator"),
    "the portal still imports or renders the calculator");
});

/* ══════════════════════════════════════════════════════════════
   5. THE MIGRATION STACK
   ══════════════════════════════════════════════════════════════ */

test("5: 053 owns its number, and 001-052 are untouched by it", () => {
  const files = readdirSync(path.join(ROOT, "supabase/migrations"))
    .filter(f => f.endsWith(".sql")).sort();
  // 057 SIMPLIFIED THE LAUNCH DISCOUNT: the one-use claim architecture
  // 056 built is removed, because the code became reusable. Re-pinned
  // rather than deleted - what this guard protects is that nothing
  // UNREVIEWED appeared. Reviewed in
  // tests/launch-discount-migration.test.mjs.
  // PACKAGE 4A ADDED MIGRATION 059: the B2B self-service supply
  // commerce foundation - it evolves the two tables 006 built for a
  // negotiated agreement and adds no table of its own. Re-pinned rather
  // than deleted - what this guard protects is that nothing UNREVIEWED
  // appeared. Reviewed in tests/b2b-supply-commerce-foundation.test.mjs.
  assert.equal(files.length, 61);
  // 054 (the B2C price alignment) now sits above it, so 053 is no longer
  // the newest. What this guard is about is that 053 occupies its own
  // number and nothing was slipped in beside it.
  assert.deepEqual(files.filter(f => f.startsWith("053")), [MIGRATION],
    "there must be exactly one migration 053");
  assert.deepEqual(files.filter(f => Number(f.slice(0, 3)) > 61), [],
    "a migration 062 or beyond appeared");
  // It names none of them as something to change.
  for (const f of files.slice(0, -1)) {
    assert.ok(!sql.includes(f), `053 refers to ${f} as something to change`);
  }
  // One transaction, so a half-applied containment cannot exist.
  assert.match(sql, /^\s*begin;/m);
  assert.match(sql, /^\s*commit;/m);
});

test("5b: it carries its own read-only verification", () => {
  // Grouped by role, because a per-row query is exactly what missed the
  // grant problem in 052.
  assert.match(migration, /string_agg\(privilege_type/);
  assert.match(migration, /select slug, discount_pct from public\.b2b_offer_models/);
  assert.match(migration, /select count\(\*\) from public\.b2b_product_sizes;\s*-> 2/);
});
