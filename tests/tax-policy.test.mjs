import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  EU_B2C_TAX_MODE,
  EU_B2C_TAX_POLICY,
  resolveCheckoutTax,
  resolveTaxTreatment,
} from "../lib/tax.ts";
import { resolveTaxJurisdiction } from "../lib/taxJurisdiction.ts";

// SAFE DEFAULT SUITE: pure logic plus source-level contract checks on
// migration 021. No DB, no network, no Stripe. Nothing here connects to
// Supabase, so it cannot touch production.
//
// Task 21D.1: the EU B2C tax mode is an externally supplied instruction,
// not something this application derives. These tests pin both halves of
// that - the configured mode is applied faithfully, and none of the
// turnover monitoring, threshold reservation or OSS decision-making Task
// 21D had built is left anywhere in the application or the schema.

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const MIGRATIONS_DIR = path.join(ROOT, "supabase/migrations");
const migration021 = readFileSync(path.join(MIGRATIONS_DIR, "021_tax_snapshot.sql"), "utf-8");
const taxSource = readFileSync(path.join(ROOT, "lib/tax.ts"), "utf-8");
const attemptsSource = readFileSync(path.join(ROOT, "lib/checkoutAttempts.ts"), "utf-8");
const jurisdictionSource = readFileSync(path.join(ROOT, "lib/taxJurisdiction.ts"), "utf-8");
const sessionRoute = readFileSync(path.join(ROOT, "app/api/checkout/session/route.ts"), "utf-8");
const quoteRoute = readFileSync(path.join(ROOT, "app/api/checkout/quote/route.ts"), "utf-8");

/** A module's source with its import block removed, so an ordering check
 *  reads call sites rather than the imports that name them. */
const withoutImports = source => source.split(/\r?\n/).filter(line => !line.startsWith("import ")).join("\n");
const sessionBody = withoutImports(sessionRoute);

/** Source with its comment lines removed, so a "no machinery" scan reads
 *  code and does not trip over prose describing what is deliberately
 *  absent. */
const withoutComments = source => source
  .split(/\r?\n/)
  .filter(line => {
    const trimmed = line.trim();
    return !trimmed.startsWith("*") && !trimmed.startsWith("//") && !trimmed.startsWith("/*") && !trimmed.startsWith("--");
  })
  .join("\n");

const MATCHA_30G = { variantId: "11111111-1111-4111-8111-111111111111", sku: "GLOA-MATCHA-30G", productSlug: "matcha", quantity: 1, unitGrossCents: 1999, lineGrossCents: 1999 };

/* ── The configured tax mode ────────────────────────────────── */

test("mode: the configured EU B2C tax mode is German origin VAT", () => {
  assert.equal(EU_B2C_TAX_MODE, "german_origin");
  assert.deepEqual({ ...EU_B2C_TAX_POLICY }, { mode: "german_origin" });
  // One field, with no accounting facts smuggled in beside it.
  assert.deepEqual(Object.keys(EU_B2C_TAX_POLICY), ["mode"]);
  assert.ok(Object.isFrozen(EU_B2C_TAX_POLICY));
});

test("mode: the configuration is documented as an external tax instruction", () => {
  // The wording the owner asked for, kept next to the constant it
  // governs. It stays internal - no customer-facing surface repeats it.
  assert.match(taxSource, /Tax mode is supplied by Cara 2 GmbH.s tax\/accounting responsibility\./);
  assert.match(taxSource, /The application does not determine OSS or distance-sales threshold/);
  assert.match(taxSource, /Change this configuration only after receiving an updated tax/);
  // And the responsibility boundary itself.
  assert.match(taxSource, /tax\/accounting team is responsible for telling the application team/);
});

test("mode: an EU destination follows the configured mode, Germany is independent of it", () => {
  const de = resolveTaxTreatment(resolveTaxJurisdiction("DE").jurisdiction);
  assert.deepEqual(de, { applicable: true, treatment: "de_domestic", taxCountry: "DE" });

  const it = resolveTaxTreatment(resolveTaxJurisdiction("IT").jurisdiction);
  assert.deepEqual(it, { applicable: true, treatment: "de_origin_intra_eu", taxCountry: "DE" });
});

test("mode: a mode this build cannot apply fails closed for the EU and leaves Germany alone", () => {
  // This is how a future destination/OSS instruction arrives: the
  // configured mode changes before the calculation for it exists. EU
  // checkout must stop rather than keep charging German VAT the
  // instruction no longer calls for.
  const future = { mode: "destination_oss" };

  const eu = resolveTaxTreatment(resolveTaxJurisdiction("FR").jurisdiction, { policy: future });
  assert.equal(eu.applicable, false);
  assert.equal(eu.kind, "policy_unavailable");

  const outcome = resolveCheckoutTax({
    jurisdictionResult: resolveTaxJurisdiction("FR"),
    items: [MATCHA_30G],
    shippingGrossCents: 1290,
    policy: future,
  });
  assert.equal(outcome.kind, "blocked");

  // The German shop keeps working: a domestic supply does not depend on
  // how EU distance sales are taxed.
  const de = resolveTaxTreatment(resolveTaxJurisdiction("DE").jurisdiction, { policy: future });
  assert.equal(de.applicable, true);
  assert.equal(de.treatment, "de_domestic");
});

test("mode: under the current mode the EU is charged exactly what Germany is charged", () => {
  const de = resolveCheckoutTax({ jurisdictionResult: resolveTaxJurisdiction("DE"), items: [MATCHA_30G], shippingGrossCents: 0 });
  const it = resolveCheckoutTax({ jurisdictionResult: resolveTaxJurisdiction("IT"), items: [MATCHA_30G], shippingGrossCents: 0 });
  assert.equal(de.kind, "calculated");
  assert.equal(it.kind, "calculated");
  assert.equal(it.snapshot.taxCountry, "DE");
  assert.equal(it.snapshot.totals.taxTotalCents, de.snapshot.totals.taxTotalCents);
  assert.equal(it.snapshot.totals.totalGrossCents, 1999, "the fixed gross price does not move");
});

/* ── No turnover monitoring anywhere ────────────────────────── */

test("boundary: no EU distance-sales threshold machinery is left in the application", () => {
  assert.ok(!existsSync(path.join(ROOT, "lib/euThreshold.ts")), "lib/euThreshold.ts must be gone");

  const code = [taxSource, attemptsSource, jurisdictionSource, sessionRoute, quoteRoute]
    .map(withoutComments)
    .join("\n");
  for (const term of [
    "reserveEuDistanceSaleThreshold",
    "threshold_relevant_net_cents",
    "threshold_reserved_at",
    "thresholdRelevantNetCents",
    "evaluateThreshold",
    "safetyBuffer",
    "confirmedForYear",
    "unionOssRegistered",
    "destinationTaxElection",
    "berlinCalendarYear",
    "EU_VAT_TERRITORY_COUNTRIES",
  ]) {
    assert.ok(!code.includes(term), `threshold machinery survives: ${term}`);
  }

  // No monetary allowance and no OSS decision left in the tax module.
  const taxCode = withoutComments(taxSource);
  for (const amount of ["10000", "10_000", "1000000", "1_000_000"]) {
    assert.ok(!taxCode.includes(amount), `allowance amount found: ${amount}`);
  }
  assert.ok(!/\bOSS\b/.test(taxCode), "an OSS decision must not live in code");
});

test("boundary: checkout never queries accumulated turnover or reserves headroom", () => {
  for (const [name, source] of [["session", sessionRoute], ["quote", quoteRoute]]) {
    const code = withoutComments(source).toLowerCase();
    assert.ok(!code.includes(".rpc("), `${name} route calls an RPC`);
    for (const term of ["threshold", "turnover", "allowance", "distance_sale", "distancesale", "calendaryear"]) {
      assert.ok(!code.includes(term), `${name} route still knows about ${term}`);
    }
  }
});

test("boundary: the checkout attempt freezes a tax snapshot and nothing else about tax", () => {
  // NULL means unknown (a destination whose VAT is not implemented),
  // never a fabricated zero.
  assert.match(attemptsSource, /tax_snapshot: CartTaxSnapshot \| null;/);
  assert.match(attemptsSource, /tax_snapshot: taxSnapshot,/);
  assert.match(sessionRoute, /const attemptTaxSnapshot = taxOutcome\.kind === "calculated" \? taxOutcome\.snapshot : null;/);
});

/* ── Migration 021 contract ─────────────────────────────────── */

test("migration: 021 is the next free number and nothing else claims it", () => {
  const files = readdirSync(MIGRATIONS_DIR).filter(name => name.endsWith(".sql"));
  const numbered = files.filter(name => name.startsWith("021"));
  assert.deepEqual(numbered, ["021_tax_snapshot.sql"]);
  // 021 has never been applied, so it is corrected in place rather than
  // undone by a 022.
  assert.equal(files.filter(name => name.startsWith("022")).length, 0, "021 must be the newest migration");
});

test("migration: 021 contains no threshold reservation machinery at all", () => {
  const sql = withoutComments(migration021);
  for (const term of [
    "threshold_relevant_net_cents",
    "threshold_reserved_at",
    "reserve_eu_distance_sale_threshold",
    "pg_advisory_xact_lock",
    "p_calendar_year",
    "p_eu_country_codes",
    "p_threshold_net_cents",
    "p_safety_buffer_net_cents",
    "p_reservation_window_hours",
    "v_paid_net_cents",
    "v_pending_net_cents",
    "idx_checkout_attempts_threshold_reserved",
  ]) {
    assert.ok(!sql.includes(term), `threshold machinery survives in 021: ${term}`);
  }
  // The only aggregate left is this one order's own merchandise lines:
  // no turnover is accumulated across orders or attempts, and no
  // calendar year is bucketed by the schema.
  assert.equal((sql.match(/sum\(/gi) ?? []).length, 1, "021 aggregates more than this order's own lines");
  assert.match(sql, /sum\(\(item->>'lineGrossCents'\)::integer\)/);
  assert.ok(!/extract\(year from/i.test(sql), "021 buckets orders by calendar year");
  // Exactly one function is defined, and it is the order creation one.
  const created = sql.match(/create or replace function public\.\w+/g) ?? [];
  assert.deepEqual(created, ["create or replace function public.create_order_from_paid_checkout"]);
});

test("migration: the stored treatment matches the treatments the code can produce", () => {
  assert.match(migration021, /tax_treatment in \(\s*'de_domestic', 'de_origin_intra_eu'\s*\)/);
  // The SQL constraint and the TypeScript union must not drift apart.
  assert.match(taxSource, /\| "de_domestic"/);
  assert.match(taxSource, /\| "de_origin_intra_eu";/);
});

test("migration: the fabricated-zero defaults are removed at the source", () => {
  for (const column of ["subtotal_net_cents", "shipping_net_cents", "shipping_gross_cents", "tax_total_cents", "total_net_cents"]) {
    assert.match(migration021, new RegExp(`alter column ${column}\\s+drop default`), column);
  }
});

test("migration: no tax or net field is given a new default of 0", () => {
  const added = migration021.split("\n").filter(line => /add column/.test(line) || /alter column/.test(line));
  for (const line of added) {
    assert.ok(!/default\s+0/.test(line), `a zero default came back: ${line.trim()}`);
  }
});

test("migration: historical orders are never rewritten", () => {
  const statements = withoutComments(migration021);
  assert.ok(!/\bupdate\s+public\.orders\b/.test(statements), "migration rewrites existing orders");
  assert.ok(!/\bupdate\s+public\.order_items\b/.test(statements), "migration rewrites existing order items");
  assert.ok(!/\bdelete\s+from\b/.test(statements), "migration deletes historical rows");
  // With the reservation gone, the migration contains no UPDATE at all.
  assert.deepEqual(statements.match(/\bupdate\s+public\.\w+/g) ?? [], []);
});

test("migration: a legacy zero is not converted to NULL and a NULL is not filled in", () => {
  const statements = withoutComments(migration021);
  // No money column is ever assigned by an UPDATE, in either direction.
  assert.ok(!/set\s+\w*_cents\s*=/i.test(statements), "a money column is rewritten");
  // And no default is put back on a column whose NULL means "unknown".
  assert.ok(!/set\s+default/i.test(statements));
  // The unknown-tax values are inserted raw, with no coalesce to soften
  // a NULL into a 0 on the way in.
  for (const field of ["subtotalNetCents", "shippingNetCents", "taxTotalCents", "totalNetCents"]) {
    assert.ok(statements.includes(`(v_totals->>'${field}')::integer`), field);
    assert.ok(
      !statements.includes(`coalesce((v_totals->>'${field}'`),
      `${field} is coalesced instead of left unknown`
    );
  }
});

test("migration: an order with no tax snapshot still stores NULL, never 0", () => {
  // The INSERT reads the net/tax values out of the snapshot document, so
  // a missing snapshot yields SQL NULL for every one of them.
  for (const field of ["subtotalNetCents", "shippingNetCents", "taxTotalCents", "totalNetCents"]) {
    assert.match(migration021, new RegExp(`\\(v_totals->>'${field}'\\)::integer`), field);
  }
  assert.match(migration021, /v_totals := v_tax->'totals';/);
});

test("migration: the paid order's tax snapshot is frozen and never recomputed", () => {
  const fn = migration021.slice(
    migration021.indexOf("create or replace function public.create_order_from_paid_checkout"),
    migration021.indexOf("-- 5. VERIFY")
  );
  // Everything comes off the attempt that was frozen before Stripe ran.
  assert.match(fn, /v_tax := v_attempt\.tax_snapshot;/);
  // A redelivered webhook returns the existing order untouched.
  assert.match(fn, /if found then[\s\S]{0,400}return v_order;/);
  // Both revalidation checks fail closed by aborting the whole creation.
  assert.match(fn, /raise exception 'tax snapshot shipping/);
  assert.match(fn, /raise exception 'tax snapshot total/);
  assert.match(fn, /raise exception 'tax snapshot for attempt % has no line for variant/);
  // Lines are matched by variant id, not by array position.
  assert.match(fn, /tax_item->>'variantId' = v_item->>'variantId'/);
});

test("migration: order creation keeps its 6-argument signature", () => {
  // Same signature as migration 016, so this is a true in-place replace
  // and lib/orderFulfillment.ts needs no change.
  const fulfillment = readFileSync(path.join(ROOT, "lib/orderFulfillment.ts"), "utf-8");
  for (const param of ["p_checkout_attempt_id", "p_customer_snapshot", "p_stripe_payment_intent_id", "p_shipping_address_snapshot", "p_billing_address_snapshot", "p_shipping_gross_cents"]) {
    assert.match(migration021, new RegExp(`${param}`), param);
    assert.match(fulfillment, new RegExp(`${param}:`), param);
  }
  assert.ok(!/p_tax_snapshot/.test(fulfillment), "tax must not be passed in from the application at fulfillment");
});

/* ── Customer-facing refusal ────────────────────────────────── */

test("refusal: the customer is told the destination is unavailable and nothing more", () => {
  const message = "Bestellungen in dieses Lieferland sind momentan vorübergehend nicht verfügbar. Bitte kontaktiere uns.";
  assert.match(sessionRoute, /TAX_DESTINATION_UNAVAILABLE_MESSAGE/);
  assert.ok(taxSource.includes(message), "the confirmed wording must be the one that ships");

  // Nothing about tax law, OSS, thresholds, internal numbers or the
  // database may appear in what the customer is shown.
  for (const leak of ["OSS", "3c", "UStG", "Schwelle", "threshold", "10.000", "10000", "Umsatz", "Supabase", "VAT"]) {
    assert.ok(!message.includes(leak), `customer message leaks "${leak}"`);
  }
});

test("refusal: the internal reason is logged, not returned to the customer", () => {
  const branch = sessionRoute.slice(
    sessionRoute.indexOf('if (taxOutcome.kind === "blocked")'),
    sessionRoute.indexOf("const attemptTaxSnapshot")
  );
  assert.match(branch, /console\.error\(/);
  assert.match(branch, /error: TAX_DESTINATION_UNAVAILABLE_MESSAGE/);
  assert.ok(!/error: `[^`]*\$\{taxOutcome\.reason\}/.test(branch), "the internal reason must not be sent to the customer");
});

/* ── Stripe stays out of it ─────────────────────────────────── */

test("stripe: Stripe Tax is not enabled and no tax rate is sent to Stripe", () => {
  assert.ok(!/automatic_tax/.test(sessionRoute), "Stripe Tax must stay off in this task");
  assert.ok(!/tax_rates/.test(sessionRoute));
  assert.ok(!/tax_behavior/.test(sessionRoute));
  assert.ok(!/taxRegistrations|tax_registrations/.test(sessionRoute));
  // Stripe line items still carry the authoritative gross amounts.
  assert.match(sessionRoute, /unit_amount: item\.unitGrossCents/);
});

/* ── Server authority ───────────────────────────────────────── */

test("security: the browser can state a destination country and nothing else about tax", () => {
  // Exactly three fields are read off the request body, and none of them
  // is a tax value. `body` is not referenced anywhere else.
  assert.match(sessionRoute, /const \{ items, requestId, shippingCountry \} = body as \{ items\?: unknown; requestId\?: unknown; shippingCountry\?: unknown \};/);
  assert.ok(
    sessionBody.lastIndexOf("body") < sessionBody.indexOf("const validatedItems"),
    "the raw request body is read after validation"
  );
  for (const field of ["taxRate", "tax_rate", "netCents", "taxCents", "taxCategory", "taxTotal", "taxSnapshot"]) {
    assert.ok(!sessionBody.includes(field), `session route handles a client "${field}"`);
  }
  // The quote route accepts a country too, and derives everything else.
  assert.match(quoteRoute, /const \{ items, shippingCountry \} = body/);
  assert.match(quoteRoute, /ALLOWED_SHIPPING_COUNTRIES\.includes\(country\)/);
});

test("security: tax is derived after the authoritative quote, from the validated country", () => {
  const steps = [
    "await buildAuthoritativeQuote",
    "resolveCheckoutTax({",
    "await getOrCreateCheckoutAttempt(",
    "stripe.checkout.sessions.create",
  ];
  const positions = steps.map(step => {
    const at = sessionBody.indexOf(step);
    assert.notEqual(at, -1, `missing step: ${step}`);
    return at;
  });
  for (let i = 1; i < positions.length; i++) {
    assert.ok(positions[i - 1] < positions[i], `"${steps[i]}" must come after "${steps[i - 1]}"`);
  }
});
