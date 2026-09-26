import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { B2B_INSTALMENT_COUNTS, allocateInstalments, annualProductNetCents }
  from "../lib/b2bPricingRules.ts";
import { addTaxToNet } from "../lib/tax.ts";
import {
  B2B_INVOICE_AGREEMENT_METADATA_KEY,
  B2B_INVOICE_INSTALMENT_METADATA_KEY,
  b2bInstalmentInvoiceIdempotencyKey,
  b2bInstalmentItemIdempotencyKey,
  buildB2bInstalmentInvoiceParams,
  buildB2bInstalmentItemParams,
  invoiceAmountMatches,
  routeB2bAnnualInvoice,
} from "../lib/b2bInstalmentRules.ts";
import {
  B2B_NON_BERLIN_BLOCKERS,
  resolveB2bDeliveryRoute,
} from "../lib/b2bDeliveryResolutionRules.ts";
import {
  B2B_RESOLUTION_HORIZON_DAYS,
  runB2bDeliveryResolution,
  runB2bInstalmentInvoicing,
} from "../lib/b2bRuntime.ts";

/**
 * PACKAGES 5D + 5E + 5F — INSTALMENTS, RESOLUTION, FAILURE AND HOLDS.
 *
 * ── WHAT THIS SUITE IS PROTECTING ─────────────────────────────
 *
 *   1. NEVER CHARGE EARLY, AND NEVER CHARGE TWICE. The due rule is
 *      due_at <= now() with no window, and both Stripe calls carry a
 *      deterministic idempotency key derived from the agreement and the
 *      instalment number.
 *
 *   2. RECORD BEFORE FINALIZE. The invoice is created as a draft, the
 *      correlation is written, and only then does Stripe start
 *      collecting. A crash between any two steps leaves a draft that
 *      charged nobody.
 *
 *   3. THE NON-BERLIN REFUSAL IS REAL. resolveB2bDeliveryRoute must
 *      refuse every address it cannot price, and migration 063 must
 *      refuse to store a route it is handed anyway.
 *
 *   4. A FAILURE HOLDS SUPPLY AND NOTHING ELSE. No cancellation, no
 *      termination, no fake payment - and a release that cannot touch
 *      a hold this package did not place.
 *
 *   5. B2C IS UNTOUCHED, and the annual invoice branch is tried before
 *      the monthly one, which is tried before the consumer handler.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS = path.join(ROOT, "supabase", "migrations");
const MIGRATION = "063_b2b_instalment_delivery_failure_runtime.sql";
const NEWLINE = /\r?\n/;
const read = rel => readFileSync(path.join(ROOT, rel), "utf-8");
/** The same file with every comment removed - see the 5B/5C suite. */
const readCode = rel =>
  read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const migration = read(`supabase/migrations/${MIGRATION}`);
const sql = migration.replace(/^\s*--.*$/gm, "");
/**
 * The executable SQL with the `comment on ... is '...'` documentation
 * removed as well.
 *
 * Several assertions below forbid a WORD - "dhl", "dispatched" - and the
 * migration's own COMMENT ON strings deliberately name those words in
 * order to explain why the thing is absent. Scanning them would forbid
 * the explanation rather than the fabrication.
 */
const sqlLogic = sql.replace(/comment on [a-z ]+ public\.[\s\S]*?';/gi, "");
const flat = sql.replace(/\s+/g, " ");
const webhookSource = read("app/api/stripe/webhook/route.ts");
const cronSource = read("app/api/cron/retry-order-notifications/route.ts");

const AGREEMENT = "33333333-3333-4333-8333-333333333333";
const BERLIN = { company: "Test GmbH", firstName: "A", lastName: "B", street: "Str",
                 houseNumber: "1", zip: "10115", city: "Berlin", country: "DE" };
const MUNICH = { ...BERLIN, zip: "80331", city: "München" };
const PARIS = { ...BERLIN, zip: "75001", city: "Paris", country: "FR" };

/* ══════════════════════════════════════════════════════════════
   1. PACKAGE 5D — THE ANNUAL INSTALMENT INVOICE
   ══════════════════════════════════════════════════════════════ */

const charge = net => {
  const t = addTaxToNet(net, 7);
  return { netCents: t.netCents, taxCents: t.taxCents, grossCents: t.grossCents, taxRatePercent: 7 };
};

function instalmentStubs(overrides = {}) {
  const calls = [];
  const state = { recorded: new Map(), invoiceSeq: 0, itemKeys: new Set(), invoiceKeys: new Set() };
  const deps = {
    calls, state,
    listDue: async () => [{
      agreement_id: AGREEMENT, payment_id: "p1", instalment_number: 2,
      net_cents: 13387, due_at: "2026-12-25T00:00:00Z",
      user_id: "11111111-1111-4111-8111-111111111111", currency: "EUR",
    }],
    findStripeCustomerId: async () => "cus_canonical",
    chargeFor: charge,
    instalmentCountFor: async () => 4,
    createInvoiceItem: async (params, options) => {
      calls.push({ name: "createInvoiceItem", params, options });
      state.itemKeys.add(options.idempotencyKey);
      return { id: "ii_1" };
    },
    createInvoice: async (params, options) => {
      calls.push({ name: "createInvoice", params, options });
      // A deterministic key replays the SAME invoice, as Stripe does.
      if (state.invoiceKeys.has(options.idempotencyKey)) return { id: "in_1" };
      state.invoiceKeys.add(options.idempotencyKey);
      state.invoiceSeq += 1;
      return { id: `in_${state.invoiceSeq}` };
    },
    finalizeInvoice: async invoiceId => {
      calls.push({ name: "finalizeInvoice", invoiceId });
      return { id: invoiceId, status: "open" };
    },
    recordInvoice: async input => {
      calls.push({ name: "recordInvoice", input });
      const key = `${input.agreementId}:${input.instalmentNumber}`;
      if (state.recorded.has(key)) return { result: "already_invoiced" };
      state.recorded.set(key, input.stripeInvoiceId);
      return { result: "invoiced" };
    },
    ...overrides,
  };
  return deps;
}

test("1: the instalment charge is the frozen net plus canonical 7% VAT", () => {
  for (let packs = 1; packs <= 10; packs += 1) {
    for (const n of B2B_INSTALMENT_COUNTS) {
      for (const net of allocateInstalments(annualProductNetCents(packs), n)) {
        const c = charge(net);
        assert.equal(c.netCents, net);
        assert.equal(c.netCents + c.taxCents, c.grossCents, "net + tax must be exact");
        assert.equal(c.grossCents, addTaxToNet(net, 7).grossCents);
      }
    }
  }
  // The worked example: instalment 2 of 4 on a 1-pack contract.
  assert.equal(charge(13387).grossCents, 14324);
});

test("2: the Stripe parameters are exactly the approved shape", async () => {
  const deps = instalmentStubs();
  await runB2bInstalmentInvoicing(deps);

  const item = deps.calls.find(c => c.name === "createInvoiceItem").params;
  assert.equal(item.customer, "cus_canonical");
  assert.equal(item.currency, "eur");
  assert.equal(item.amount, charge(13387).grossCents, "the item is not the instalment gross");
  assert.deepEqual(item.metadata, {
    [B2B_INVOICE_AGREEMENT_METADATA_KEY]: AGREEMENT,
    [B2B_INVOICE_INSTALMENT_METADATA_KEY]: "2",
  });

  const invoice = deps.calls.find(c => c.name === "createInvoice").params;
  assert.equal(invoice.collection_method, "charge_automatically",
    "Stripe dunning is not authoritative");
  assert.equal(invoice.auto_advance, false, "the invoice starts collecting before it is recorded");
  assert.equal(invoice.pending_invoice_items_behavior, "exclude",
    "the invoice could sweep in an unrelated pending item");
  assert.equal(invoice.customer, "cus_canonical");
  assert.equal(invoice.currency, "eur");
  assert.deepEqual(invoice.metadata, item.metadata);

  // NET-ORIGIN: Stripe is never asked to compute tax.
  const rules = readCode("lib/b2bInstalmentRules.ts");
  for (const forbidden of [/automatic_tax/, /tax_behavior/, /tax_rates/]) {
    assert.ok(!forbidden.test(rules), `the invoice asks Stripe for tax: ${forbidden}`);
  }
});

test("3: RECORD BEFORE FINALIZE - the ordering that makes a crash safe", async () => {
  const deps = instalmentStubs();
  await runB2bInstalmentInvoicing(deps);
  const order = deps.calls.map(c => c.name);
  assert.deepEqual(order,
    ["createInvoiceItem", "createInvoice", "recordInvoice", "finalizeInvoice"],
    "the invoice is finalized before the correlation is recorded");
});

test("4: a database refusal finalizes nothing - nobody is charged", async () => {
  for (const result of ["not_due_yet", "instalment_not_scheduled", "invoice_conflict",
                        "agreement_not_active_annual", "rpc_error"]) {
    const deps = instalmentStubs({ recordInvoice: async () => ({ result }) });
    const summary = await runB2bInstalmentInvoicing(deps);
    assert.equal(summary.skipped, 1, result);
    assert.equal(deps.calls.filter(c => c.name === "finalizeInvoice").length, 0,
      `a ${result} answer still finalized the invoice`);
  }
});

test("5: two runs produce ONE invoice - the idempotency key replays it", async () => {
  const deps = instalmentStubs();
  await runB2bInstalmentInvoicing(deps);
  await runB2bInstalmentInvoicing(deps);

  assert.equal(deps.state.invoiceSeq, 1, "a second run minted a second Stripe invoice");
  assert.equal(deps.state.invoiceKeys.size, 1);
  assert.equal(deps.state.itemKeys.size, 1);
  // The keys are derived, not random.
  assert.equal(b2bInstalmentInvoiceIdempotencyKey(AGREEMENT, 2),
    `gloa-b2b-invoice-${AGREEMENT}-2`);
  assert.equal(b2bInstalmentItemIdempotencyKey(AGREEMENT, 2),
    `gloa-b2b-invoice-item-${AGREEMENT}-2`);
  // Different instalments get different keys; same instalment, same key.
  assert.notEqual(b2bInstalmentInvoiceIdempotencyKey(AGREEMENT, 2),
    b2bInstalmentInvoiceIdempotencyKey(AGREEMENT, 3));
  // No personal data in a key that Stripe echoes into its logs.
  for (const bad of ["@", "GmbH", "13387", "14324"]) {
    assert.ok(!b2bInstalmentInvoiceIdempotencyKey(AGREEMENT, 2).includes(bad));
  }
});

test("6: no canonical Stripe customer means SKIP, never create one", async () => {
  const deps = instalmentStubs({ findStripeCustomerId: async () => null });
  const summary = await runB2bInstalmentInvoicing(deps);
  assert.equal(summary.skipped, 1);
  assert.equal(deps.calls.filter(c => c.name === "createInvoice").length, 0);
  // And the wiring resolves it from the ONE canonical mapping, never a
  // fourth copy on the agreement.
  const deps_ = readCode("lib/b2bRuntimeDeps.ts");
  assert.ok(deps_.includes('.from("stripe_customers")'),
    "the canonical customer mapping is not the source");
  assert.ok(!/customers\.create/.test(deps_), "a scheduled job can mint a Stripe customer");
  assert.ok(!/stripe_customer_id/.test(readCode("supabase/migrations/" + MIGRATION)),
    "063 added a customer id to the commerce schema");
});

test("7: one instalment's failure does not stop the batch", async () => {
  const deps = instalmentStubs({
    listDue: async () => [
      { agreement_id: AGREEMENT, payment_id: "p1", instalment_number: 2, net_cents: 13387,
        due_at: "x", user_id: "u1", currency: "EUR" },
      { agreement_id: AGREEMENT, payment_id: "p2", instalment_number: 3, net_cents: 13387,
        due_at: "x", user_id: "u1", currency: "EUR" },
    ],
    createInvoice: async (params, options) => {
      if (options.idempotencyKey.endsWith("-2")) throw new Error("stripe down");
      return { id: "in_3" };
    },
  });
  const summary = await runB2bInstalmentInvoicing(deps);
  assert.equal(summary.failed, 1);
  assert.equal(summary.invoiced, 1, "the second instalment was not attempted");
});

test("8: the work list is bounded and never loops until empty", () => {
  const runtime = readCode("lib/b2bRuntime.ts");
  assert.ok(!/while\s*\(/.test(runtime), "a job loops until empty");
  // LEAST and GREATEST are SQL syntax, not pg_catalog functions - a real
  // PostgreSQL refused the qualified spelling, which is why the migration
  // documents the distinction.
  assert.match(sql, /limit least\(greatest\(p_limit, 1\), 200\)/,
    "the work list is unbounded");
  assert.ok(!/pg_catalog\.(least|greatest)\(/.test(sql),
    "LEAST/GREATEST are qualified, which does not parse");
});

/* ══════════════════════════════════════════════════════════════
   2. THE DUE RULE — NEVER EARLY
   ══════════════════════════════════════════════════════════════ */

test("9: due is due_at <= now(), with no early window anywhere", () => {
  assert.match(sql, /p\.due_at <= pg_catalog\.now\(\)/,
    "the work list does not use the canonical due rule");
  assert.match(sql, /v_payment\.due_at > pg_catalog\.now\(\)/,
    "the writer does not re-check the due date");
  assert.ok(sql.includes("'not_due_yet'"), "an early instalment is not refused");
  // No window, in either direction, anywhere in the executable SQL.
  for (const forbidden of [/interval\s*'\s*-?\d+\s*(day|hour|minute)/i,
                           /now\(\)\s*\+\s*interval/i,
                           /due_at\s*<=\s*pg_catalog\.now\(\)\s*\+/i]) {
    assert.ok(!forbidden.test(sql), `063 widens the due window: ${forbidden}`);
  }
  // And the runtime adds none of its own.
  const runtime = readCode("lib/b2bRuntime.ts");
  assert.ok(!/dueWindow|earlyDays|graceDays/.test(runtime));
});

test("10: instalment 1 is never invoiced - it was settled at activation", () => {
  assert.match(sql, /p\.instalment_number > 1/, "the work list can pick up instalment 1");
  assert.ok(sql.includes("'instalment_one_is_not_invoiced'"),
    "the writer does not refuse instalment 1");
  // And a row that already carries an invoice is excluded, which is the
  // crash-safety half of the idempotency.
  assert.match(sql, /p\.stripe_invoice_id is null/,
    "an already-invoiced instalment can be picked up again");
});

/* ══════════════════════════════════════════════════════════════
   3. ANNUAL INVOICE ROUTING
   ══════════════════════════════════════════════════════════════ */

test("11: an annual invoice is recognised by its OWN metadata", () => {
  const good = {
    [B2B_INVOICE_AGREEMENT_METADATA_KEY]: AGREEMENT,
    [B2B_INVOICE_INSTALMENT_METADATA_KEY]: "2",
  };
  const routed = routeB2bAnnualInvoice(good);
  assert.equal(routed.kind, "annual");
  assert.equal(routed.agreementId, AGREEMENT);
  assert.equal(routed.instalmentNumber, 2);

  // Everything else is not annual and keeps its existing handler.
  for (const meta of [null, undefined, {},
                      { gloa_subscription_id: "sub_1" },
                      { gloa_annual_plan_id: AGREEMENT },
                      { [B2B_INVOICE_AGREEMENT_METADATA_KEY]: "" }]) {
    assert.equal(routeB2bAnnualInvoice(meta).kind, "not_annual", JSON.stringify(meta));
  }
  // But a corrupted annual invoice is MALFORMED, never not_annual.
  for (const meta of [
    { ...good, [B2B_INVOICE_AGREEMENT_METADATA_KEY]: "nope" },
    { ...good, [B2B_INVOICE_INSTALMENT_METADATA_KEY]: "1" },
    { ...good, [B2B_INVOICE_INSTALMENT_METADATA_KEY]: "9" },
    { ...good, [B2B_INVOICE_INSTALMENT_METADATA_KEY]: "x" },
    { [B2B_INVOICE_AGREEMENT_METADATA_KEY]: AGREEMENT },
  ]) {
    assert.equal(routeB2bAnnualInvoice(meta).kind, "malformed", JSON.stringify(meta));
  }
});

test("12: the two leaves agree on the routing key", () => {
  const webhookRules = read("lib/b2bWebhookRules.ts");
  assert.ok(webhookRules.includes('B2B_SESSION_AGREEMENT_METADATA_KEY = "gloa_b2b_agreement_id"'));
  assert.equal(B2B_INVOICE_AGREEMENT_METADATA_KEY, "gloa_b2b_agreement_id");
  assert.equal(B2B_INVOICE_INSTALMENT_METADATA_KEY, "gloa_b2b_instalment_number");
});

test("13: an invoice whose total is not the owed gross is refused", () => {
  const c = charge(13387);
  assert.equal(invoiceAmountMatches({ total: 14324, currency: "eur" }, c, "EUR"), true);
  for (const bad of [{ total: 14325, currency: "eur" }, { total: 13387, currency: "eur" },
                     { total: 14324, currency: "usd" }, { total: null, currency: "eur" }]) {
    assert.equal(invoiceAmountMatches(bad, c, "EUR"), false, JSON.stringify(bad));
  }
});

/* ══════════════════════════════════════════════════════════════
   4. PACKAGE 5E — DELIVERY RESOLUTION
   ══════════════════════════════════════════════════════════════ */

test("14: a Berlin address resolves to free local delivery, at zero", () => {
  for (const zip of ["10115", "14199", "12047"]) {
    const route = resolveB2bDeliveryRoute({ address: { ...BERLIN, zip }, packs: 2 });
    assert.equal(route.ok, true, zip);
    assert.equal(route.shippingClass, "berlin_local");
    assert.equal(route.customerShippingGrossCents, 0);
    assert.equal(route.shippingSnapshot.chargeStatus, "free_local_delivery");
    assert.equal(route.berlinSnapshot.eligible, true);
    // THE SHAPE MIGRATION 060 REQUIRES, not the checkout's own shape.
    // b2b_deliveries_address_snapshot_shape_check demands exactly these
    // eight keys, each a string or null - the same object
    // lib/orderAddressSnapshot.ts produces for a B2C order. A real
    // PostgreSQL refused the untranslated version.
    assert.deepEqual(Object.keys(route.addressSnapshot).sort(),
      ["city", "company", "country", "line1", "line2", "name", "postalCode", "state"]);
    // NORMALIZED, so the two snapshots describe the same place.
    assert.equal(route.addressSnapshot.postalCode, zip);
    assert.equal(route.addressSnapshot.country, "DE");
    // Translated, not copied: a name and a line1 are assembled.
    assert.equal(route.addressSnapshot.name, "A B");
    assert.equal(route.addressSnapshot.line1, "Str 1");
    assert.equal(route.addressSnapshot.line2, null);
    assert.equal(route.addressSnapshot.state, null);
  }
});

test("15: a German NON-BERLIN address FAILS CLOSED - no fabricated route", () => {
  const route = resolveB2bDeliveryRoute({ address: MUNICH, packs: 2 });
  assert.equal(route.ok, false);
  assert.equal(route.reason, "shipping_not_yet_supported");
  // The Berlin decision is still carried, including its negative answer.
  assert.equal(route.berlin.eligible, false);
  assert.equal(route.berlin.reason, "postcode_outside_berlin");
  // NOTHING was invented on the way to refusing.
  // Scanned with the BLOCKER LIST removed: that constant deliberately
  // names the missing facts so whoever supplies them can see the list,
  // and forbidding it would forbid saying what is missing.
  const rules = readCode("lib/b2bDeliveryResolutionRules.ts")
    .replace(/B2B_NON_BERLIN_BLOCKERS[\s\S]*?\]\);/, "");
  for (const forbidden of [/measurement\s*:/, /weightGrams\s*[:=]/, /dimensions\s*[:=]/,
                           /tare/i, /carton/i, /girth\s*[:=]/, /dhlProductCode\s*[:=]/,
                           /carrierRetailGrossCents\s*:\s*[1-9]/]) {
    assert.ok(!forbidden.test(rules), `resolution invents a shipping fact: ${forbidden}`);
  }
});

test("16: a non-German address is its own refusal", () => {
  const route = resolveB2bDeliveryRoute({ address: PARIS, packs: 2 });
  assert.equal(route.ok, false);
  assert.equal(route.reason, "country_not_supported");
  const malformed = resolveB2bDeliveryRoute({ address: { ...BERLIN, zip: "1011" }, packs: 2 });
  assert.equal(malformed.reason, "postcode_malformed");
});

test("17: migration 063 refuses to STORE any route but the Berlin one", () => {
  assert.ok(sql.includes("'shipping_not_yet_supported'"),
    "063 accepts a route it cannot price");
  assert.match(sql, /if p_shipping_class <> 'berlin_local' then/,
    "063 does not gate on the shipping class");
  assert.match(sql, /p_shipping_snapshot->>'chargeStatus' is distinct from 'free_local_delivery'/,
    "063 does not gate on the charge status");
  // Zero is the APPROVED Berlin price, written only on that branch.
  assert.match(sql, /customer_shipping_net_cents\s*=\s*0/);
  assert.match(sql, /customer_shipping_gross_cents = 0/);
  // And 063 invents no physical fact either.
  for (const forbidden of [/weight/i, /dimension/i, /tare/i, /carton/i, /girth/i, /\bdhl\b/i]) {
    assert.ok(!forbidden.test(sqlLogic), `063 names a shipping fact: ${forbidden}`);
  }
});

test("18: the blocker list is explicit, so nobody has to guess it", () => {
  assert.equal(B2B_NON_BERLIN_BLOCKERS.length, 3);
  assert.match(B2B_NON_BERLIN_BLOCKERS[0], /weight|tare|carton/i);
  assert.match(B2B_NON_BERLIN_BLOCKERS[1], /shipping charge/i);
  assert.match(B2B_NON_BERLIN_BLOCKERS[2], /VAT/i);
});

test("19: resolution is idempotent and never rewrites a resolved delivery", async () => {
  const seen = new Map();
  const deps = {
    listResolvable: async () => [{
      delivery_id: "d1", agreement_id: AGREEMENT, delivery_number: 1,
      quantity_packs: 2, scheduled_for: "2026-10-01T00:00:00Z",
      shipping_address_snapshot: BERLIN,
    }],
    resolveDelivery: async input => {
      if (seen.has(input.deliveryId)) return { result: "already_resolved" };
      seen.set(input.deliveryId, input);
      return { result: "resolved" };
    },
  };
  const first = await runB2bDeliveryResolution(deps);
  const second = await runB2bDeliveryResolution(deps);
  assert.equal(first.resolved, 1);
  assert.equal(second.resolved, 0);
  assert.equal(second.alreadyResolved, 1);
  assert.equal(seen.size, 1);

  // 063 answers already_resolved rather than raising, and never updates.
  assert.ok(sql.includes("'already_resolved'"));
  const resolver = sql.slice(sql.indexOf("create function public.resolve_b2b_delivery"));
  assert.match(resolver, /if v_delivery\.resolved_at is not null then/,
    "the resolver can overwrite a resolved row");
});

test("20: a refused address mutates nothing, and the reason is reported", async () => {
  const deps = {
    listResolvable: async () => [
      { delivery_id: "d1", agreement_id: AGREEMENT, delivery_number: 1, quantity_packs: 2,
        scheduled_for: "x", shipping_address_snapshot: MUNICH },
      { delivery_id: "d2", agreement_id: AGREEMENT, delivery_number: 2, quantity_packs: 2,
        scheduled_for: "x", shipping_address_snapshot: PARIS },
      { delivery_id: "d3", agreement_id: AGREEMENT, delivery_number: 3, quantity_packs: 2,
        scheduled_for: "x", shipping_address_snapshot: null },
    ],
    resolveDelivery: async () => { throw new Error("must not be called for a refused address"); },
  };
  const summary = await runB2bDeliveryResolution(deps);
  assert.equal(summary.resolved, 0);
  assert.equal(summary.refused, 3);
  assert.equal(summary.failed, 0, "a refusal was reported as a failure");
  assert.equal(summary.refusals.shipping_not_yet_supported, 1);
  assert.equal(summary.refusals.country_not_supported, 1);
  assert.equal(summary.refusals.agreement_has_no_address, 1);
});

test("21: resolution dispatches nothing and creates no order", () => {
  for (const forbidden of [/dispatched/i, /tracking/i, /\border_id\b/, /create_order/i,
                           /delivered_at/, /insert into public\.b2b_deliveries/i]) {
    assert.ok(!forbidden.test(sqlLogic), `063 does more than route: ${forbidden}`);
  }
  const runtime = readCode("lib/b2bRuntime.ts");
  assert.ok(!/dispatch|tracking|createOrder/i.test(runtime));
});

test("22: the resolution horizon is short, so an address stays changeable", () => {
  // Resolution FREEZES the address. Routing months ahead would freeze an
  // address the customer has not used and defeat the approved rule that
  // a change affects the next UNRESOLVED delivery.
  assert.equal(B2B_RESOLUTION_HORIZON_DAYS, 14);
  assert.ok(B2B_RESOLUTION_HORIZON_DAYS >= 1 && B2B_RESOLUTION_HORIZON_DAYS <= 31);
  // And the address comes from the agreement, read at resolution time.
  assert.ok(readCode("lib/b2bRuntimeDeps.ts").includes("shipping_address_snapshot"));
});

/* ══════════════════════════════════════════════════════════════
   5. PACKAGE 5F — FAILURE AND HOLDS
   ══════════════════════════════════════════════════════════════ */

test("23: a failure holds supply and changes NO contract", () => {
  const holder = sql.slice(sql.indexOf("create function public.hold_b2b_deliveries_for_payment"));
  assert.match(holder, /status\s*=\s*'held'/);
  assert.match(holder, /hold_reason = 'b2b:payment_failed'/);
  // ONLY unresolved, scheduled slots.
  assert.match(holder, /and status = 'scheduled'/);
  assert.match(holder, /and resolved_at is null/);
  // No contract change anywhere in 063.
  for (const forbidden of [/'cancelled'/, /'completed'/, /ended_at\s*=/, /termination_reason\s*=/,
                           /set\s+status\s*=\s*'paused'/]) {
    assert.ok(!forbidden.test(sql), `063 ends a contract: ${forbidden}`);
  }
});

test("24: a monthly failure writes NO payment row - 060 forbids one", () => {
  // The monthly failure path is the hold and nothing else.
  assert.ok(!/insert into public\.b2b_payment_schedule/i.test(sql),
    "063 creates a payment schedule row");
  const flow = readCode("lib/b2bWebhook.ts");
  assert.ok(flow.includes("holdB2bMonthlyForFailure"));
  const monthly = flow.slice(flow.indexOf("export async function holdB2bMonthlyForFailure"));
  assert.ok(!/payment|instalment/i.test(monthly.slice(0, monthly.indexOf("}"))),
    "the monthly failure path touches a payment row");
});

test("25: release clears ONLY this package's own hold reason", () => {
  const rel = sql.slice(sql.indexOf("create function public.release_b2b_deliveries_after_payment"));
  assert.match(rel, /and hold_reason = 'b2b:payment_failed'/,
    "release matches loosely and could clear an operator hold");
  assert.ok(!/hold_reason\s+like/i.test(rel), "release matches with LIKE");
  assert.ok(!/hold_reason\s+is not null/i.test(rel), "release clears any hold");
  // And it refuses while anything is still owed.
  assert.match(rel, /status in \('payment_failed', 'action_required'\)/);
  assert.ok(rel.includes("'still_owed'"));
});

test("26: action_required is DEFERRED, not inferred from a failure", () => {
  // 060 has the state and the transition graph admits payment_failed ->
  // action_required, so nothing has to be undone when the authoritative
  // event is added. What must not happen is inferring it from
  // invoice.payment_failed, which covers declines the customer cannot fix.
  assert.ok(!/=\s*'action_required'/.test(sql),
    "063 writes action_required without authoritative evidence");
  assert.match(migration, /action_required IS DELIBERATELY NOT WRITTEN|DEFERRED/,
    "the deferral is not documented");
  // The failure writer only ever writes payment_failed.
  const fail = sql.slice(sql.indexOf("create function public.record_b2b_annual_instalment_failure"));
  assert.match(fail, /status\s*=\s*'payment_failed'/);
});

test("27: a terminal instalment is never un-settled by a late failure", () => {
  const fail = sql.slice(sql.indexOf("create function public.record_b2b_annual_instalment_failure"));
  assert.match(fail, /if v_payment\.status in \('paid', 'void'\) then/,
    "a failure notice can overwrite settled money");
  assert.ok(fail.includes("'already_failed'"), "a replayed failure is not idempotent");
});

/* ══════════════════════════════════════════════════════════════
   6. WEBHOOK ORDER AND B2C CONTAINMENT
   ══════════════════════════════════════════════════════════════ */

test("28: invoice.paid tries ANNUAL, then MONTHLY, then the consumer handler", () => {
  const arm = webhookSource.slice(webhookSource.indexOf('event.type === "invoice.paid"'));
  const iAnnual = arm.indexOf("handleB2bAnnualInvoicePaid");
  const iMonthly = arm.indexOf("handleB2bInvoicePaid");
  const iB2c = arm.indexOf("await handleInvoicePaid(stripe, event);");
  assert.ok(iAnnual >= 0 && iAnnual < iMonthly,
    "the annual invoice branch does not precede the monthly one");
  assert.ok(iMonthly < iB2c, "a B2B invoice can reach the consumer handler first");
  // Each is reached only when the previous did not handle it.
  assert.ok(arm.includes("if (!b2bAnnual.handled) {"));
  assert.ok(arm.includes("if (!b2bInvoice.handled) {"));
});

test("29: invoice.payment_failed is 5F now, and still guards the consumer path", () => {
  const arm = webhookSource.slice(webhookSource.indexOf('event.type === "invoice.payment_failed"'));
  const iB2b = arm.indexOf("handleB2bInvoiceFailed");
  const iB2c = arm.indexOf("await handleInvoicePaymentFailed(stripe, event);");
  assert.ok(iB2b >= 0 && iB2b < iB2c);
  assert.ok(arm.includes("if (!b2bFailure.handled) {"));
  // The 5C no-op is gone: the handler now holds.
  const handler = webhookSource.slice(webhookSource.indexOf("async function handleB2bInvoiceFailed"));
  assert.ok(handler.includes("holdB2bMonthlyForFailure"), "the monthly failure does not hold");
  assert.ok(handler.includes("recordB2bAnnualInvoiceFailure"), "the annual failure is not recorded");
  assert.ok(!handler.includes("acknowledgeB2bPaymentFailure"),
    "the temporary 5C no-op is still in the failure path");
});

test("30: every B2C handler survives verbatim", () => {
  for (const call of [
    "await settleAnnualCheckoutSession(session.id, annual.metadata, annualWebhookDeps(stripe));",
    "await handleSubscriptionSessionCompleted(stripe, session);",
    "await handleCheckoutSessionCompleted(stripe, session);",
    "await handleInvoicePaid(stripe, event);",
    "await handleInvoicePaymentFailed(stripe, event);",
    "await handleRefundEvent(stripe, event);",
    "await handleSubscriptionUpdated(stripe, event);",
    "await handleSubscriptionDeleted(event);",
  ]) {
    assert.ok(webhookSource.includes(call), `a B2C call disappeared: ${call}`);
  }
  // The event is still recorded only AFTER processing succeeds.
  const iCatch = webhookSource.indexOf("Stripe webhook processing failed for event");
  const iRecord = webhookSource.indexOf("const recorded = await recordStripeWebhookEvent");
  assert.ok(iCatch >= 0 && iCatch < iRecord);
});

/* ══════════════════════════════════════════════════════════════
   7. THE CRON
   ══════════════════════════════════════════════════════════════ */

test("31: both jobs live in the EXISTING daily cron - no second schedule", () => {
  const vercel = JSON.parse(read("vercel.json"));
  assert.equal(vercel.crons.length, 1, "a second Vercel cron was registered");
  assert.equal(vercel.crons[0].path, "/api/cron/retry-order-notifications",
    "the cron path changed, which re-registers the deployed job");
  assert.ok(cronSource.includes("runB2bInstalmentJob"), "the instalment job is not scheduled");
  assert.ok(cronSource.includes("runB2bResolutionJob"), "the resolution job is not scheduled");
});

test("32: each B2B job has its own error boundary and cannot starve the others", () => {
  const b2bBlock = cronSource.slice(cronSource.indexOf("PACKAGE 5D: DUE ANNUAL INSTALMENTS"),
                                    cronSource.indexOf("Counts only, exactly like the email families"));
  assert.equal((b2bBlock.match(/try \{/g) ?? []).length, 2, "the two jobs share one try");
  assert.equal((b2bBlock.match(/catch \(err\)/g) ?? []).length, 2);
  assert.ok(b2bBlock.includes("emptyB2bInstalmentSummary()"));
  assert.ok(b2bBlock.includes("emptyB2bResolutionSummary()"));
});

test("33: the B2B cron work is gated by the same closed flag as the checkout", () => {
  assert.ok(cronSource.includes("isB2bSelfServiceEnabled()"),
    "the B2B jobs run even with the offer closed");
  // Compared in the FUNCTION BODY: the import line names the job near
  // the top of the file and would otherwise match before the call site.
  const body = cronSource.slice(cronSource.indexOf("export async function"));
  const iFlag = body.indexOf("if (isB2bSelfServiceEnabled())");
  const iJob = body.indexOf("runB2bInstalmentJob(");
  assert.ok(iFlag >= 0, "the cron never consults the flag");
  assert.ok(iFlag < iJob, "the job runs before the flag is consulted");
});

test("34: the cron response carries counts only - no customer fact", () => {
  // Exactly the two B2B blocks. The neighbouring subscriptionEmails key
  // is another job's and is not this assertion's subject.
  const start = cronSource.indexOf("b2bInstalments: {");
  const end = cronSource.indexOf("},", cronSource.indexOf("refusals: b2bDeliveries.refusals"));
  const response = cronSource.slice(start, end);
  for (const forbidden of ["email", "company", "address", "amount", "cents",
                           "stripe", "customer", "name"]) {
    assert.ok(!response.includes(forbidden), `the cron response leaks ${forbidden}`);
  }
});

/* ══════════════════════════════════════════════════════════════
   8. MIGRATION 063
   ══════════════════════════════════════════════════════════════ */

test("35: 063 is the highest migration and 064 does not exist", () => {
  const files = readdirSync(MIGRATIONS).filter(f => f.endsWith(".sql")).sort();
  assert.equal(files[files.length - 1], MIGRATION);
  assert.equal(files[files.length - 2], "062_b2b_checkout_settlement.sql");
  assert.equal(files.length, 63);
  assert.deepEqual(files.filter(f => Number(f.slice(0, 3)) > 63), []);
  const numbers = files.map(f => f.slice(0, 3));
  assert.equal(new Set(numbers).size, numbers.length);
});

test("36: migrations 001 through 062 are unmodified - all are live", () => {
  const changed = execFileSync("git",
    ["diff", "--name-only", "--diff-filter=MD", "HEAD", "--", "supabase/migrations/"],
    { cwd: ROOT, encoding: "utf-8" }).trim();
  const touched = changed ? changed.split(NEWLINE) : [];
  // 063 is the ONLY pending migration and may be edited in place.
  assert.deepEqual(touched.filter(rel => !rel.endsWith(MIGRATION)), [],
    "a live, immutable migration was edited");
});

test("37: 063 is additive only - no table, policy, RLS, DROP or privilege", () => {
  for (const forbidden of [
    /create\s+table/i, /alter\s+table/i, /add\s+column/i, /add\s+constraint/i,
    /create\s+(unique\s+)?index/i, /create\s+(constraint\s+)?trigger/i,
    /create\s+policy/i, /alter\s+policy/i, /drop\s+policy/i,
    /row\s+level\s+security/i, /\bdrop\s+/i, /\btruncate\b/i, /\bdelete\s+from\b/i,
    /alter default privileges/i, /create\s+role/i, /alter\s+role/i,
    /create\s+or\s+replace\s+function/i, /alter\s+function/i,
  ]) {
    assert.ok(!forbidden.test(sql), `063 contains ${forbidden}`);
  }
  assert.ok(!/\bon\s+table\b/i.test(sql), "063 names a table in a privilege statement");
  for (const verb of ["insert", "update", "delete", "truncate", "references", "trigger"]) {
    assert.ok(!new RegExp(`grant[^;]*\\b${verb}\\b[^;]*\\bto\\b`, "i").test(sql),
      `063 grants ${verb.toUpperCase()}`);
  }
  assert.match(sql, /^\s*begin;/m);
  assert.match(sql, /^\s*commit;\s*$/m);
});

test("38: seven writers, all definer, all with a pinned empty search_path", () => {
  const defined = [...sql.matchAll(/create\s+function\s+public\.([a-z0-9_]+)/gi)].map(m => m[1]);
  assert.deepEqual(defined.sort(), [
    "b2b_annual_instalments_due",
    "hold_b2b_deliveries_for_payment",
    "record_b2b_annual_instalment_failure",
    "record_b2b_annual_instalment_invoice",
    "release_b2b_deliveries_after_payment",
    "resolve_b2b_delivery",
    "settle_b2b_annual_paid_instalment",
  ]);
  assert.equal((sql.match(/security\s+definer/gi) ?? []).length, 7);
  assert.equal((sql.match(/set search_path = ''/g) ?? []).length, 7);
  for (const table of ["b2b_supply_agreements", "b2b_payment_schedule", "b2b_deliveries",
                       "checkout_attempts"]) {
    assert.ok(!new RegExp(`(from|into|join|update)\\s+${table}\\b`, "i").test(sql),
      `${table} is referenced without its schema`);
  }
});

test("39: service_role is the only grantee, and only EXECUTE, on all seven", () => {
  const grants = [...flat.matchAll(/grant\s+([a-z ,]+?)\s+on\s+(function|table)\s+([a-z0-9_.]+)[^;]*?\s+to\s+([a-z0-9_]+);/gi)]
    .map(m => ({ privilege: m[1].trim(), kind: m[2], grantee: m[4] }));
  assert.equal(grants.length, 7, `063 issues ${grants.length} grants, expected 7`);
  for (const g of grants) {
    assert.equal(g.privilege, "execute");
    assert.equal(g.kind, "function");
    assert.equal(g.grantee, "service_role");
  }
  for (const role of ["public", "anon", "authenticated"]) {
    assert.equal((flat.match(new RegExp(`from ${role};`, "gi")) ?? []).length, 7,
      `EXECUTE is not revoked from ${role} on all seven`);
  }
  const iPublic = flat.search(/revoke all on function[^;]*from public;/i);
  const iGrant = flat.search(/grant execute on function/i);
  assert.ok(iPublic >= 0 && iPublic < iGrant);
});

test("40: no identifier in 063 exceeds 63 UTF-8 bytes, and none collides", () => {
  const names = [
    ...[...migration.matchAll(/create\s+function\s+public\.([a-z0-9_]+)/gi)].map(m => m[1]),
    ...[...migration.matchAll(/\b(v_[a-z0-9_]+|p_[a-z0-9_]+)\b/gi)].map(m => m[1]),
  ];
  assert.ok(names.length > 10);
  const truncated = new Map();
  for (const name of names) {
    const bytes = Buffer.byteLength(name, "utf8");
    assert.ok(bytes <= 63, `"${name}" is ${bytes} bytes`);
    const key = Buffer.from(name, "utf8").subarray(0, 63).toString("utf8");
    const prior = truncated.get(key);
    assert.ok(prior === undefined || prior === name, `"${name}" and "${prior}" collide`);
    truncated.set(key, name);
  }
});

test("41: 063 contains no Stripe call and creates no delivery row", () => {
  for (const forbidden of [/stripe\.[a-z]/i, /checkout\.session/i, /invoices\./i,
                           /insert into public\.b2b_deliveries/i,
                           /insert into public\.b2b_supply_agreements/i]) {
    assert.ok(!forbidden.test(sql), `063 contains ${forbidden}`);
  }
  // The ONLY insert is none: 063 updates rows that 062 created.
  assert.equal((sql.match(/insert\s+into/gi) ?? []).length, 0,
    "063 inserts a row - every slot and instalment already exists");
});

test("42: every write goes through an RPC, never a direct table write", () => {
  for (const f of ["lib/b2bRuntimeDeps.ts", "lib/b2bWebhookDeps.ts"]) {
    const src = readCode(f);
    for (const table of ["b2b_supply_agreements", "b2b_payment_schedule", "b2b_deliveries",
                         "b2b_supply_items"]) {
      assert.ok(!new RegExp(`from\\("${table}"\\)[\\s\\S]{0,80}\\.(insert|update|delete|upsert)\\(`).test(src),
        `${f} writes ${table} directly`);
    }
  }
  const deps = readCode("lib/b2bRuntimeDeps.ts");
  for (const rpc of ["b2b_annual_instalments_due", "record_b2b_annual_instalment_invoice",
                     "resolve_b2b_delivery"]) {
    assert.ok(deps.includes(rpc), `${rpc} is never called`);
  }
});

test("43: the focused suite is registered in the npm test script", () => {
  const pkg = JSON.parse(read("package.json"));
  for (const suite of ["tests/b2b-instalment-delivery-failure.test.mjs",
                       "tests/b2b-checkout-settlement.test.mjs",
                       "tests/b2b-pending-agreement-writer.test.mjs"]) {
    assert.ok(pkg.scripts.test.includes(suite), `${suite} does not run in the gate`);
  }
});
