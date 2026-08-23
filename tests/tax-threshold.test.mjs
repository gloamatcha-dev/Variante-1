import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  EU_ORIGIN_TAX_POLICY,
  berlinCalendarYear,
  evaluateThreshold,
  resolveCheckoutTax,
  resolveTaxTreatment,
} from "../lib/tax.ts";
import { EU_VAT_TERRITORY_COUNTRIES, resolveTaxJurisdiction } from "../lib/taxJurisdiction.ts";

// SAFE DEFAULT SUITE: pure logic plus source-level contract checks on
// migration 021. No DB, no network, no Stripe. Nothing here connects to
// Supabase, so it cannot touch production.
//
// Task 21D: the § 3c Abs. 4 UStG allowance, the dated policy facts it
// rests on, and the guarantees the migration has to keep.

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const MIGRATIONS_DIR = path.join(ROOT, "supabase/migrations");
const migration021 = readFileSync(path.join(MIGRATIONS_DIR, "021_tax_snapshot.sql"), "utf-8");
const sessionRoute = readFileSync(path.join(ROOT, "app/api/checkout/session/route.ts"), "utf-8");
const quoteRoute = readFileSync(path.join(ROOT, "app/api/checkout/quote/route.ts"), "utf-8");

/** A module's source with its import block removed, so an ordering check
 *  reads call sites rather than the imports that name them. */
const withoutImports = source => source.split(/\r?\n/).filter(line => !line.startsWith("import ")).join("\n");
const sessionBody = withoutImports(sessionRoute);

const MATCHA_30G = { variantId: "11111111-1111-4111-8111-111111111111", sku: "GLOA-MATCHA-30G", productSlug: "matcha", quantity: 1, unitGrossCents: 1999, lineGrossCents: 1999 };

const policyWith = overrides => ({ ...EU_ORIGIN_TAX_POLICY, ...overrides });

const thresholdWith = overrides => evaluateThreshold({
  thresholdNetCents: 1_000_000,
  safetyBufferNetCents: 0,
  externalNetCents: 0,
  paidNetCents: 0,
  pendingNetCents: 0,
  proposedNetCents: 0,
  ...overrides,
});

/* ── The confirmed policy ───────────────────────────────────── */

test("policy: the confirmed 2026 facts are recorded exactly as the owner stated them", () => {
  assert.equal(EU_ORIGIN_TAX_POLICY.confirmedForYear, 2026);
  assert.equal(EU_ORIGIN_TAX_POLICY.unionOssRegistered, false);
  assert.equal(EU_ORIGIN_TAX_POLICY.destinationTaxElection, false);
  assert.equal(EU_ORIGIN_TAX_POLICY.externalRelevantNetCentsBeforeLaunch, 0);
  assert.equal(EU_ORIGIN_TAX_POLICY.previousYearExternalRelevantNetCents, 0);
  // 10 000 EUR, EU-wide, § 3c Abs. 4 Satz 1 UStG.
  assert.equal(EU_ORIGIN_TAX_POLICY.thresholdNetCents, 1_000_000);
});

test("policy: the opening balance is dated, not a timeless magic zero", () => {
  // The zero is only usable together with the year it was confirmed for.
  const stale = policyWith({ confirmedForYear: 2025 });
  const outcome = resolveTaxTreatment(resolveTaxJurisdiction("IT").jurisdiction, { calendarYear: 2026, policy: stale });
  assert.equal(outcome.applicable, false);
  assert.equal(outcome.kind, "policy_unavailable");
});

test("policy: a stale policy year fails closed for every EU destination", () => {
  for (const country of ["IT", "FR", "NL", "MC", "AT", "ES"]) {
    const outcome = resolveCheckoutTax({
      jurisdictionResult: resolveTaxJurisdiction(country),
      items: [MATCHA_30G],
      shippingGrossCents: 1290,
      calendarYear: EU_ORIGIN_TAX_POLICY.confirmedForYear + 1,
    });
    assert.equal(outcome.kind, "blocked", country);
    assert.match(outcome.reason, /must be reviewed/, country);
  }
});

test("policy: a stale policy year does NOT take the German shop offline", () => {
  // A domestic supply is taxed at German rates whatever the EU allowance
  // is doing, so 1 January must not stop German checkout.
  const outcome = resolveCheckoutTax({
    jurisdictionResult: resolveTaxJurisdiction("DE"),
    items: [MATCHA_30G],
    shippingGrossCents: 590,
    calendarYear: EU_ORIGIN_TAX_POLICY.confirmedForYear + 5,
  });
  assert.equal(outcome.kind, "calculated");
  assert.equal(outcome.snapshot.treatment, "de_domestic");
  assert.equal(outcome.snapshot.items[0].taxRatePercent, 7);
});

test("policy: an OSS registration or a destination-tax election blocks origin taxation", () => {
  const italy = resolveTaxJurisdiction("IT").jurisdiction;
  for (const policy of [policyWith({ unionOssRegistered: true }), policyWith({ destinationTaxElection: true })]) {
    const outcome = resolveTaxTreatment(italy, { calendarYear: 2026, policy });
    assert.equal(outcome.applicable, false);
    assert.equal(outcome.kind, "policy_unavailable");
  }
});

test("policy: exceeding the allowance in the previous year removes the exception", () => {
  const policy = policyWith({ previousYearExternalRelevantNetCents: 1_000_001 });
  const outcome = resolveTaxTreatment(resolveTaxJurisdiction("IT").jurisdiction, { calendarYear: 2026, policy });
  assert.equal(outcome.applicable, false);
  assert.equal(outcome.kind, "policy_unavailable");
  assert.match(outcome.reason, /previous calendar year/);

  // Exactly at the allowance in the previous year is still inside it.
  const atLimit = policyWith({ previousYearExternalRelevantNetCents: 1_000_000 });
  assert.equal(resolveTaxTreatment(resolveTaxJurisdiction("IT").jurisdiction, { calendarYear: 2026, policy: atLimit }).applicable, true);
});

test("policy: the calendar year is Germany's, not the server's", () => {
  // 1 January 2027, 00:30 in Berlin is still 31 December 2026 in UTC.
  assert.equal(berlinCalendarYear(new Date("2026-12-31T23:30:00Z")), 2027);
  assert.equal(berlinCalendarYear(new Date("2026-12-31T22:30:00Z")), 2026);
  assert.equal(berlinCalendarYear(new Date("2026-06-15T12:00:00Z")), 2026);
});

/* ── Threshold arithmetic ───────────────────────────────────── */

test("threshold: landing exactly on 10 000 EUR is still inside the allowance", () => {
  // § 3c Abs. 4 Satz 1 applies while the total is "nicht überschritten".
  const exactly = thresholdWith({ paidNetCents: 900_000, proposedNetCents: 100_000 });
  assert.equal(exactly.totalNetCents, 1_000_000);
  assert.equal(exactly.withinAllowance, true);

  const oneCentOver = thresholdWith({ paidNetCents: 900_000, proposedNetCents: 100_001 });
  assert.equal(oneCentOver.withinAllowance, false);
});

test("threshold: an order that would cross the allowance is refused", () => {
  const result = thresholdWith({ paidNetCents: 995_000, proposedNetCents: 6_000 });
  assert.equal(result.withinAllowance, false);
  // ... while one that fits is not.
  assert.equal(thresholdWith({ paidNetCents: 995_000, proposedNetCents: 5_000 }).withinAllowance, true);
});

test("threshold: every source of consumed allowance is counted", () => {
  const result = thresholdWith({
    externalNetCents: 250_000,
    paidNetCents: 250_000,
    pendingNetCents: 250_000,
    proposedNetCents: 250_001,
  });
  assert.equal(result.totalNetCents, 1_000_001);
  assert.equal(result.withinAllowance, false);
});

test("threshold: the safety buffer only ever narrows the allowance", () => {
  const buffered = evaluateThreshold({
    thresholdNetCents: 1_000_000,
    safetyBufferNetCents: 50_000,
    externalNetCents: 0,
    paidNetCents: 960_000,
    pendingNetCents: 0,
    proposedNetCents: 0,
  });
  assert.equal(buffered.allowanceNetCents, 950_000);
  assert.equal(buffered.withinAllowance, false);
  assert.ok(EU_ORIGIN_TAX_POLICY.safetyBufferNetCents > 0, "a buffer of 0 would leave no margin at all");
  assert.ok(EU_ORIGIN_TAX_POLICY.safetyBufferNetCents < EU_ORIGIN_TAX_POLICY.thresholdNetCents);
});

test("threshold: the EU country list the guard uses comes from the Task 21C resolver", () => {
  assert.ok(EU_VAT_TERRITORY_COUNTRIES.includes("MC"), "Monaco is EU VAT territory and must be counted");
  assert.ok(!EU_VAT_TERRITORY_COUNTRIES.includes("DE"), "Germany is not an intra-EU distance sale destination");
  for (const country of ["GB", "CH", "NO", "LI", "IS", "RS"]) {
    assert.ok(!EU_VAT_TERRITORY_COUNTRIES.includes(country), country);
  }
  // Every entry really does resolve as EU through the resolver itself.
  for (const country of EU_VAT_TERRITORY_COUNTRIES) {
    assert.equal(resolveTaxJurisdiction(country).jurisdiction.kind, "eu", country);
  }
  assert.equal(EU_VAT_TERRITORY_COUNTRIES.length, 27, "26 member states besides Germany, plus Monaco");
});

/* ── What counts, at the source ─────────────────────────────── */

test("threshold: Germany contributes a known zero, an EU destination a real value", () => {
  const de = resolveCheckoutTax({ jurisdictionResult: resolveTaxJurisdiction("DE"), items: [MATCHA_30G], shippingGrossCents: 590, calendarYear: 2026 });
  assert.equal(de.thresholdRelevantNetCents, 0);

  const it = resolveCheckoutTax({ jurisdictionResult: resolveTaxJurisdiction("IT"), items: [MATCHA_30G], shippingGrossCents: 1290, calendarYear: 2026 });
  assert.equal(it.thresholdRelevantNetCents, it.snapshot.totals.totalNetCents);
  assert.ok(it.thresholdRelevantNetCents > 0);
});

test("threshold: a third-country order is recorded as a known zero, not as unknown", () => {
  for (const country of ["GB", "CH", "NO", "IS", "RS"]) {
    const outcome = resolveCheckoutTax({ jurisdictionResult: resolveTaxJurisdiction(country), items: [MATCHA_30G], shippingGrossCents: 1790, calendarYear: 2026 });
    assert.equal(outcome.kind, "not_implemented", country);
  }
  // The route turns that outcome into an unknown tax snapshot but a
  // known-zero threshold contribution: an export is not a distance sale.
  assert.match(sessionRoute, /snapshot: null, thresholdRelevantNetCents: 0/);
});

test("threshold: only paid, private, current-year turnover is summed in SQL", () => {
  const paidSum = migration021.slice(
    migration021.indexOf("into v_paid_net_cents"),
    migration021.indexOf("into v_unclassified_orders")
  );
  assert.match(paidSum, /o\.customer_type = 'private'/, "B2B must not count");
  assert.match(paidSum, /o\.payment_status in \('paid', 'partially_refunded', 'refunded'\)/, "unpaid must not count");
  assert.match(paidSum, /extract\(year from \(o\.placed_at at time zone 'Europe\/Berlin'\)\) = p_calendar_year/);
  assert.match(paidSum, /o\.threshold_relevant_net_cents is not null/);
});

test("threshold: unpaid and abandoned checkouts release their reservation", () => {
  const pendingSum = migration021.slice(
    migration021.indexOf("into v_pending_net_cents"),
    migration021.indexOf("v_allowance_net_cents :=")
  );
  // A reservation older than the window stops counting, so an abandoned
  // cart cannot permanently consume the allowance.
  assert.match(pendingSum, /threshold_reserved_at > now\(\) - make_interval\(hours => p_reservation_window_hours\)/);
  // An attempt that became an order is counted as paid turnover instead,
  // so the handover neither double counts nor leaves a gap.
  assert.match(pendingSum, /not exists \(\s*select 1 from public\.orders o where o\.checkout_attempt_id = a\.id\s*\)/);
  // Only attempts that were actually admitted hold a reservation, so a
  // mere quote never consumes anything.
  assert.match(pendingSum, /a\.threshold_reserved_at is not null/);
  assert.ok(!quoteRoute.includes("reserveEuDistanceSaleThreshold"), "quoting must not reserve threshold headroom");
});

test("threshold: paid EU turnover the shop cannot value fails the guard closed", () => {
  assert.match(migration021, /'unclassified_paid_eu_turnover'/);
  const unknownScan = migration021.slice(
    migration021.indexOf("into v_unclassified_orders"),
    migration021.indexOf("if v_unclassified_orders > 0")
  );
  assert.match(unknownScan, /o\.threshold_relevant_net_cents is null/);
  assert.match(unknownScan, /upper\(coalesce\(o\.shipping_address_snapshot->>'country', ''\)\) = any\(p_eu_country_codes\)/);
});

test("threshold: the decision is serialized, so two checkouts cannot both slip through", () => {
  assert.match(migration021, /pg_advisory_xact_lock\(hashtext\('gloa:eu_distance_sale_threshold'\)\)/);
  // The lock is taken before anything is read, and the reservation is
  // written inside the same transaction.
  const fn = migration021.slice(migration021.indexOf("create or replace function public.reserve_eu_distance_sale_threshold"));
  assert.ok(fn.indexOf("pg_advisory_xact_lock") < fn.indexOf("into v_paid_net_cents"));
  assert.ok(fn.indexOf("into v_pending_net_cents") < fn.indexOf("set threshold_reserved_at = now()"));
  // Exactly at the allowance is inside it, in SQL as well as in TS.
  assert.match(fn, /if v_total_net_cents > v_allowance_net_cents then/);
});

test("threshold: the proposed value is read from the persisted row, never from an argument", () => {
  const fn = migration021.slice(migration021.indexOf("create or replace function public.reserve_eu_distance_sale_threshold"));
  assert.match(fn, /v_proposed_net_cents := v_attempt\.threshold_relevant_net_cents;/);
  assert.ok(!/p_proposed/.test(fn), "the caller must not be able to state its own proposed value");
});

/* ── Customer-facing refusal ────────────────────────────────── */

test("refusal: the customer is told the destination is unavailable and nothing more", () => {
  const message = "Bestellungen in dieses Lieferland sind momentan vorübergehend nicht verfügbar. Bitte kontaktiere uns.";
  assert.match(sessionRoute, /TAX_DESTINATION_UNAVAILABLE_MESSAGE/);
  const tax = readFileSync(path.join(ROOT, "lib/tax.ts"), "utf-8");
  assert.ok(tax.includes(message), "the confirmed wording must be the one that ships");

  // Nothing about tax law, OSS, thresholds, internal numbers or the
  // database may appear in what the customer is shown.
  for (const leak of ["OSS", "3c", "UStG", "Schwelle", "threshold", "10.000", "10000", "Umsatz", "Supabase", "VAT"]) {
    assert.ok(!message.includes(leak), `customer message leaks "${leak}"`);
  }
});

test("refusal: the internal reason is logged, not returned to the customer", () => {
  // The refusal branch logs the reason and responds with the generic
  // message - the reason string never reaches the response body.
  const branch = sessionRoute.slice(
    sessionRoute.indexOf("const reservation = await reserveEuDistanceSaleThreshold"),
    sessionRoute.indexOf("const lineItems")
  );
  assert.match(branch, /console\.error\(/);
  assert.match(branch, /error: TAX_DESTINATION_UNAVAILABLE_MESSAGE/);
  assert.ok(!/error: `[^`]*\$\{reservation\.reason\}/.test(branch), "the internal reason must not be sent to the customer");
});

/* ── Migration 021 contract ─────────────────────────────────── */

test("migration: 021 is the next free number and nothing else claims it", () => {
  const files = readdirSync(MIGRATIONS_DIR).filter(name => name.endsWith(".sql"));
  const numbered = files.filter(name => name.startsWith("021"));
  assert.deepEqual(numbered, ["021_tax_snapshot.sql"]);
  assert.equal(files.filter(name => name.startsWith("022")).length, 0, "021 must be the newest migration");
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
  // And the new nullable money columns are only constrained to be
  // non-negative WHEN they are known, so NULL still means unknown.
  assert.match(migration021, /threshold_relevant_net_cents is null\s*\n?\s*or threshold_relevant_net_cents >= 0/);
});

test("migration: historical orders are never rewritten", () => {
  const statements = migration021
    .split("\n")
    .filter(line => !line.trim().startsWith("--"))
    .join("\n");
  // No bulk data statement of any kind against the historical tables.
  assert.ok(!/\bupdate\s+public\.orders\b/.test(statements), "migration rewrites existing orders");
  assert.ok(!/\bupdate\s+public\.order_items\b/.test(statements), "migration rewrites existing order items");
  assert.ok(!/\bdelete\s+from\b/.test(statements), "migration deletes historical rows");
  // The only UPDATE in the file is the reservation write inside the RPC.
  const updates = statements.match(/\bupdate\s+public\.\w+/g) ?? [];
  assert.deepEqual(updates, ["update public.checkout_attempts"]);
});

test("migration: a legacy zero is not converted to NULL and a NULL is not filled in", () => {
  const statements = migration021.replace(/^\s*--.*$/gm, "");
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
    migration021.indexOf("-- 5. § 3c ABS. 4 THRESHOLD RESERVATION")
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

test("migration: the reservation function is not reachable by anon or authenticated", () => {
  assert.match(migration021, /revoke all on function public\.reserve_eu_distance_sale_threshold\([^)]*\) from public;/);
  assert.match(migration021, /grant execute on function public\.reserve_eu_distance_sale_threshold\([^)]*\) to service_role;/);
  assert.ok(!/to anon/.test(migration021));
  assert.ok(!/to authenticated/.test(migration021));
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

test("security: the browser can state a destination country and nothing else about tax", () => {
  // Exactly three fields are read off the request body, and none of them
  // is a tax value. `body` is not referenced anywhere else.
  assert.match(sessionRoute, /const \{ items, requestId, shippingCountry \} = body as \{ items\?: unknown; requestId\?: unknown; shippingCountry\?: unknown \};/);
  // Nothing downstream ever touches the raw request body again: the last
  // reference to it is the destructure above, so no later step can pick
  // up a field the validation did not name.
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
    "await reserveEuDistanceSaleThreshold(",
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

test("security: an attempt with an unknown threshold value is re-evaluated, not waved through", () => {
  assert.match(sessionRoute, /frozenThresholdRelevantNetCents === null \|\| frozenThresholdRelevantNetCents > 0/);
  assert.match(migration021, /'attempt_has_no_threshold_value'/);
});
