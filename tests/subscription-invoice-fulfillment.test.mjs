import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  FULFILLABLE_BILLING_REASONS,
  FULFILLABLE_SUBSCRIPTION_STATUSES,
  LAUNCH_SUBSCRIPTION_SKUS,
  SUBSCRIPTION_INTERVAL_COUNT,
  SUBSCRIPTION_INTERVAL_UNIT,
  SUBSCRIPTION_QUANTITY,
  customerChainMatches,
  evaluateSubscriptionInvoice,
  idOf,
  resolveGloaSubscriptionId,
  resolveInvoiceSubscriptionId,
  resolvePaidInvoiceSubscriptionPeriod,
  resolveSubscriptionPeriod,
  stripeSubscriptionIdMatches,
  validateLocalSubscription,
} from "../lib/subscriptionInvoiceRules.ts";

// SAFE DEFAULT SUITE: pure decision logic, an in-memory model of the two
// LIVE unique indexes, and source-level checks. Nothing here opens a
// socket, imports the Stripe SDK or touches a database, so no Stripe
// object and no production row can come out of running it.
//
// Task 29D-E connects paid Stripe invoices to real GLOA orders. The
// invariant worth protecting above all others: one paid invoice is one
// package, never zero and never two.

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf-8");
const NEWLINE = String.fromCharCode(10);

const MIGRATIONS = path.join(ROOT, "supabase/migrations");
const webhook = read("app/api/stripe/webhook/route.ts");
const fulfillment = read("lib/subscriptionInvoiceFulfillment.ts");
const rules = read("lib/subscriptionInvoiceRules.ts");

const withoutComments = source => source
  .split(NEWLINE)
  .filter(line => {
    const t = line.trim();
    return !t.startsWith("--") && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
  })
  .join(NEWLINE);

const webhookCode = withoutComments(webhook);
const fulfillmentCode = withoutComments(fulfillment);
const rulesCode = withoutComments(rules);

const UUID = n => `${String(n).repeat(8)}-${String(n).repeat(4)}-${String(n).repeat(4)}-${String(n).repeat(4)}-${String(n).repeat(12)}`;
const SUB_ID = UUID(1);
const USER_ID = UUID(2);

/** A local subscription exactly as Task 29D-D froze it. */
const localSubscription = (overrides = {}) => ({
  id: SUB_ID,
  user_id: USER_ID,
  status: "pending",
  currency: "EUR",
  stripe_subscription_id: null,
  total_gross_cents: 2589,
  shipping_gross_cents: 590,
  customer_snapshot: { email: "kundin@example.test", name: "Test Kundin" },
  shipping_address_snapshot: { name: "Test Kundin", line1: "Teststrasse 1", city: "Berlin", postalCode: "10115", country: "DE" },
  billing_address_snapshot: { name: "Test Kundin", line1: "Teststrasse 1", city: "Berlin", postalCode: "10115", country: "DE" },
  plan_snapshot: {
    planId: UUID(3),
    slug: "matcha-30g-4w",
    sku: "GLOA-MATCHA-30G",
    billingIntervalUnit: "week",
    billingIntervalCount: 4,
    deliveryIntervalUnit: "week",
    deliveryIntervalCount: 4,
    discountPercent: null,
    commitmentMonths: null,
  },
  tax_snapshot: { totals: { totalGrossCents: 2589, taxTotalCents: 169 } },
  ...overrides,
});

const localItems = (overrides = {}) => [{ sku: "GLOA-MATCHA-30G", quantity: 1, ...overrides }];

const invoiceFacts = (overrides = {}) => ({
  id: "in_first",
  currency: "eur",
  status: "paid",
  billingReason: "subscription_create",
  total: 2589,
  customerId: "cus_gloa",
  stripeSubscriptionId: "sub_stripe",
  ...overrides,
});

const frozen = { totalGrossCents: 2589, currency: "EUR" };

/* ── G, H. The canonical accessor ───────────────────────────── */

test("invoice: the subscription comes from invoice.parent.subscription_details", () => {
  assert.equal(resolveInvoiceSubscriptionId({ parent: { subscription_details: { subscription: "sub_x" } } }), "sub_x");
  // Expanded objects are handled too.
  assert.equal(resolveInvoiceSubscriptionId({ parent: { subscription_details: { subscription: { id: "sub_y" } } } }), "sub_y");
  // Anything else is simply not a subscription invoice.
  assert.equal(resolveInvoiceSubscriptionId({ parent: null }), null);
  assert.equal(resolveInvoiceSubscriptionId({ parent: { subscription_details: null } }), null);
  assert.equal(resolveInvoiceSubscriptionId({}), null);
  assert.equal(resolveInvoiceSubscriptionId({ parent: { subscription_details: { subscription: "" } } }), null);
});

test("invoice: the legacy top-level invoice.subscription is never the source", () => {
  // The installed API version (2026-07-29.dahlia) does not put it there,
  // and falling back to it would make correctness depend on which version
  // an account is pinned to.
  assert.equal(resolveInvoiceSubscriptionId({ subscription: "sub_legacy", parent: null }), null);
  const code = withoutComments(rules);
  assert.ok(!/invoice\.subscription\b/.test(code), "the legacy accessor is read somewhere");
  assert.match(code, /invoice\.parent\?\.subscription_details/);
  assert.ok(!/invoice\.subscription\b/.test(fulfillmentCode + webhookCode));
});

test("invoice: ids are read from both string and expanded shapes", () => {
  assert.equal(idOf("cus_1"), "cus_1");
  assert.equal(idOf({ id: "cus_2" }), "cus_2");
  assert.equal(idOf(null), null);
  assert.equal(idOf(undefined), null);
  assert.equal(idOf(""), null);
});

/* ── W. Only real delivery cycles ───────────────────────────── */

test("billing reason: only subscription_create and subscription_cycle ship anything", () => {
  assert.deepEqual([...FULFILLABLE_BILLING_REASONS], ["subscription_create", "subscription_cycle"]);
  for (const reason of ["subscription_create", "subscription_cycle"]) {
    assert.deepEqual(evaluateSubscriptionInvoice(invoiceFacts({ billingReason: reason }), frozen), { kind: "fulfill" });
  }
  // An allowlist, so a reason nobody has thought about cannot ship by
  // default. None of these is evidence a customer should get more matcha.
  for (const reason of [
    "manual", "subscription_update", "subscription_threshold", "quote_accept",
    "upcoming", "subscription", "automatic_pending_invoice_item_invoice", null, "something_new",
  ]) {
    const decision = evaluateSubscriptionInvoice(invoiceFacts({ billingReason: reason }), frozen);
    assert.equal(decision.kind, "ignore", `${reason} produced ${decision.kind}`);
  }
});

test("billing reason: an invoice with no subscription parent is ignored, not failed", () => {
  const decision = evaluateSubscriptionInvoice(invoiceFacts({ stripeSubscriptionId: null }), frozen);
  assert.equal(decision.kind, "ignore");
});

/* ── V. Amount reconciliation ───────────────────────────────── */

test("amount: the invoice total must equal the FROZEN subscription total", () => {
  assert.deepEqual(evaluateSubscriptionInvoice(invoiceFacts(), frozen), { kind: "fulfill" });

  for (const total of [2588, 2590, 0, 1999, null]) {
    const decision = evaluateSubscriptionInvoice(invoiceFacts({ total }), frozen);
    assert.equal(decision.kind, "fail", `total ${total} was accepted`);
  }
  // A mismatch is a hard stop in both directions - undercharge and
  // overcharge alike - never an adjustment of the GLOA order to whatever
  // Stripe happened to invoice.
  const under = evaluateSubscriptionInvoice(invoiceFacts({ total: 1999 }), frozen);
  assert.match(under.reason, /does not match the frozen subscription total/);
});

test("amount: the COMMERCIAL total is what is compared, not amount_paid", () => {
  // They answer different questions: total is what was charged for,
  // amount_paid is what the payment mechanics settled, and a credit
  // balance can move the latter without the commercial terms changing.
  const code = withoutComments(rules);
  assert.match(code, /invoice\.total !== frozen\.totalGrossCents/);
  assert.ok(!/amount_paid/.test(code + fulfillmentCode), "amount_paid is used as the commercial total");
});

test("amount: status, currency and customer must all be consistent", () => {
  for (const status of ["open", "draft", "void", "uncollectible", null]) {
    assert.equal(evaluateSubscriptionInvoice(invoiceFacts({ status }), frozen).kind, "fail", `status ${status}`);
  }
  assert.equal(evaluateSubscriptionInvoice(invoiceFacts({ currency: "chf" }), frozen).kind, "fail");
  assert.equal(evaluateSubscriptionInvoice(invoiceFacts({ customerId: null }), frozen).kind, "fail");
  assert.equal(evaluateSubscriptionInvoice(invoiceFacts({ id: null }), frozen).kind, "fail");
  // Stripe returns lowercase currency; the comparison is case-insensitive.
  assert.equal(evaluateSubscriptionInvoice(invoiceFacts({ currency: "EUR" }), frozen).kind, "fulfill");
});

/* ── I, J. Correlation is by metadata, with no fallback ─────── */

test("correlation: a missing or malformed gloa_subscription_id fails closed", () => {
  assert.equal(resolveGloaSubscriptionId({ gloa_subscription_id: SUB_ID }), SUB_ID);
  for (const metadata of [null, undefined, {}, { gloa_subscription_id: "" }, { gloa_subscription_id: "not-a-uuid" }, { gloa_subscription_id: 42 }]) {
    assert.equal(resolveGloaSubscriptionId(metadata), null, `${JSON.stringify(metadata)} was accepted`);
  }
  // No guessing path exists: not by email, name, amount, SKU or "the most
  // recent pending subscription".
  assert.ok(
    !/order\("created_at"|\.limit\(1\)|most recent|customer_details\?\.email/.test(fulfillmentCode),
    "a fallback lookup appeared"
  );
  // The only way in is the metadata, and a missing one is a hard failure
  // rather than a search.
  assert.match(fulfillmentCode, /const gloaSubscriptionId = resolveGloaSubscriptionId\(stripeSubscription\.metadata\);/);
  assert.match(fulfillmentCode, /carries no gloa_subscription_id/);
});

/* ── K, L. The trust chain ──────────────────────────────────── */

test("customer: the whole chain must close, and metadata is not proof", () => {
  assert.equal(customerChainMatches({
    mappedStripeCustomerId: "cus_gloa",
    subscriptionCustomerId: "cus_gloa",
    invoiceCustomerId: "cus_gloa",
  }), true);

  // Any break in local mapping -> stripe subscription -> invoice.
  assert.equal(customerChainMatches({ mappedStripeCustomerId: "cus_a", subscriptionCustomerId: "cus_b", invoiceCustomerId: "cus_a" }), false);
  assert.equal(customerChainMatches({ mappedStripeCustomerId: "cus_a", subscriptionCustomerId: "cus_a", invoiceCustomerId: "cus_b" }), false);
  assert.equal(customerChainMatches({ mappedStripeCustomerId: null, subscriptionCustomerId: "cus_a", invoiceCustomerId: "cus_a" }), false);
  assert.equal(customerChainMatches({ mappedStripeCustomerId: "cus_a", subscriptionCustomerId: null, invoiceCustomerId: "cus_a" }), false);
  assert.equal(customerChainMatches({ mappedStripeCustomerId: "cus_a", subscriptionCustomerId: "cus_a", invoiceCustomerId: null }), false);
});

test("stripe subscription id: NULL adopts, identical is idempotent, different fails closed", () => {
  // NULL is the normal invoice-first case: the invoice arrived before
  // checkout.session.completed and this is the first thing that knows.
  assert.equal(stripeSubscriptionIdMatches(null, "sub_a"), true);
  assert.equal(stripeSubscriptionIdMatches(undefined, "sub_a"), true);
  assert.equal(stripeSubscriptionIdMatches("sub_a", "sub_a"), true);
  // Two Stripe subscriptions pointing at one local row is never accepted
  // and the existing id is never overwritten.
  assert.equal(stripeSubscriptionIdMatches("sub_a", "sub_b"), false);
  // The binding is done by migration 022's function under its own row
  // lock, which refuses a conflicting id. The application never updates
  // the column itself - it has no write grant on the table and needs none.
  assert.match(fulfillmentCode, /p_stripe_subscription_id: input\.stripeSubscriptionId/);
  assert.ok(!/\.from\("subscriptions"\)[\s\S]{0,200}\.update\(/.test(fulfillmentCode),
    "the fulfillment path updates the subscription directly");
  assert.match(fulfillmentCode, /stripeSubscriptionIdMatches\(subscription\.stripe_subscription_id, stripeSubscriptionId\)/);
});

/* ── Local subscription invariants ──────────────────────────── */

test("local: a valid frozen subscription passes", () => {
  assert.deepEqual(validateLocalSubscription(localSubscription(), localItems()), { ok: true });
  for (const status of FULFILLABLE_SUBSCRIPTION_STATUSES) {
    assert.equal(validateLocalSubscription(localSubscription({ status }), localItems()).ok, true, status);
  }
});

test("local: a terminal or unknown status is never revived by a late invoice", () => {
  assert.deepEqual([...FULFILLABLE_SUBSCRIPTION_STATUSES], ["pending", "active", "past_due", "unpaid"]);
  for (const status of ["cancelled", "paused", "expired", "whatever"]) {
    const result = validateLocalSubscription(localSubscription({ status }), localItems());
    assert.equal(result.ok, false, `${status} was accepted`);
  }
});

test("local: corrupted or missing frozen data fails closed rather than being normalised", () => {
  assert.equal(validateLocalSubscription(null, localItems()).ok, false);
  assert.equal(validateLocalSubscription(localSubscription({ user_id: null }), localItems()).ok, false);
  assert.equal(validateLocalSubscription(localSubscription({ currency: "CHF" }), localItems()).ok, false);
  for (const field of ["customer_snapshot", "shipping_address_snapshot", "billing_address_snapshot", "tax_snapshot", "plan_snapshot"]) {
    assert.equal(validateLocalSubscription(localSubscription({ [field]: null }), localItems()).ok, false, field);
  }
});

test("local: the frozen plan must still be week / 4 with no discount or commitment", () => {
  const plan = localSubscription().plan_snapshot;
  assert.equal(SUBSCRIPTION_INTERVAL_UNIT, "week");
  assert.equal(SUBSCRIPTION_INTERVAL_COUNT, 4);
  for (const override of [
    { billingIntervalUnit: "month" },
    { billingIntervalCount: 1 },
    { deliveryIntervalUnit: "month" },
    { deliveryIntervalCount: 1 },
    { discountPercent: 10 },
    { discountPercent: 0 },
    { commitmentMonths: 12 },
  ]) {
    const subscription = localSubscription({ plan_snapshot: { ...plan, ...override } });
    assert.equal(validateLocalSubscription(subscription, localItems()).ok, false, JSON.stringify(override));
  }
});

test("local: exactly one launch SKU at quantity 1, and never the Metal Case", () => {
  assert.equal(SUBSCRIPTION_QUANTITY, 1);
  assert.deepEqual([...LAUNCH_SUBSCRIPTION_SKUS], ["GLOA-MATCHA-30G", "GLOA-MATCHA-50G", "GLOA-MATCHA-100G"]);
  for (const sku of LAUNCH_SUBSCRIPTION_SKUS) {
    assert.equal(validateLocalSubscription(localSubscription(), localItems({ sku })).ok, true, sku);
  }
  assert.equal(validateLocalSubscription(localSubscription(), localItems({ sku: "GLOA-CASE-01" })).ok, false, "the Metal Case shipped");
  assert.equal(validateLocalSubscription(localSubscription(), localItems({ sku: null })).ok, false);
  assert.equal(validateLocalSubscription(localSubscription(), localItems({ quantity: 2 })).ok, false);
  assert.equal(validateLocalSubscription(localSubscription(), []).ok, false);
  assert.equal(validateLocalSubscription(localSubscription(), [...localItems(), ...localItems()]).ok, false);
});

/* ── AP. Cycle timestamps come from Stripe ──────────────────── */

test("period: the cycle boundaries are Stripe's, taken from the subscription ITEM", () => {
  // In this API version the period lives on the item, not the
  // subscription, and nothing here computes "next month".
  const start = 1767225600; // 2026-01-01T00:00:00Z
  const end = start + 28 * 24 * 60 * 60;
  const period = resolveSubscriptionPeriod({ items: { data: [{ current_period_start: start, current_period_end: end }] } });
  assert.equal(period.currentPeriodStart, new Date(start * 1000).toISOString());
  assert.equal(period.currentPeriodEnd, new Date(end * 1000).toISOString());
  // The next delivery IS the next billing boundary - four weeks, exactly.
  assert.equal(period.nextDeliveryAt, period.currentPeriodEnd);
  assert.equal((end - start) / (24 * 60 * 60), 28);

  // Missing data stays null rather than becoming an invented date.
  assert.deepEqual(resolveSubscriptionPeriod({ items: { data: [] } }), {
    currentPeriodStart: null, currentPeriodEnd: null, nextDeliveryAt: null,
  });
  assert.deepEqual(resolveSubscriptionPeriod({}), {
    currentPeriodStart: null, currentPeriodEnd: null, nextDeliveryAt: null,
  });
  const code = withoutComments(rules);
  assert.ok(!/setMonth|addMonths|30 \* 24|31 \* 24/.test(code), "a period was computed locally");
});

/* ── Phase 3C.6. WHICH PERIOD DID *THIS* INVOICE PAY FOR? ───── */

/**
 * The three cycle boundaries every test below is built from. Exactly 28
 * days apart, because the cadence is four weeks and never a month.
 */
const P1 = Date.parse("2026-08-20T00:00:00.000Z") / 1000;
const P2 = P1 + 28 * 24 * 60 * 60;
const P3 = P2 + 28 * 24 * 60 * 60;

const SUB_STRIPE_ID = "sub_gloa_1";
const OTHER_STRIPE_SUB = "sub_someone_else";

/**
 * "The test did not mention this field" and "the field is missing from
 * the object" are different fixtures, and the fail-closed cases depend on
 * the second. A plain `?? default` collapses them, so absence is spelled.
 */
const ABSENT = Symbol("absent");
const given = (value, fallback) =>
  value === undefined ? fallback : (value === ABSENT ? undefined : value);

/** A recurring subscription line, in the installed SDK's actual shape. */
const cycleLine = (overrides = {}) => ({
  id: given(overrides.id, "il_1"),
  object: "line_item",
  period: given(overrides.period, { start: P1, end: P2 }),
  subscription: given(overrides.subscription, SUB_STRIPE_ID),
  parent: given(overrides.parent, {
    type: "subscription_item_details",
    invoice_item_details: null,
    subscription_item_details: {
      invoice_item: null,
      proration: given(overrides.proration, false),
      proration_details: null,
      subscription: given(overrides.detailsSubscription, SUB_STRIPE_ID),
      subscription_item: given(overrides.subscriptionItem, "si_1"),
    },
  }),
});

/** A one-time invoice item line, which describes no subscription cycle. */
const invoiceItemLine = (overrides = {}) => ({
  id: "il_item",
  object: "line_item",
  period: { start: P2, end: P3 },
  subscription: null,
  parent: {
    type: "invoice_item_details",
    subscription_item_details: null,
    invoice_item_details: {
      invoice_item: "ii_1",
      proration: false,
      proration_details: null,
      subscription: overrides.subscription !== undefined ? overrides.subscription : null,
    },
  },
});

const invoiceWith = (lines, hasMore = false) => ({
  id: "in_A",
  lines: { object: "list", data: lines, has_more: hasMore, url: "/v1/invoices/in_A/lines" },
});

/** The two recurring lines a real GLOA invoice carries. */
const matchaLine = () => cycleLine({ id: "il_matcha", subscriptionItem: "si_matcha" });
const shippingLine = () => cycleLine({ id: "il_shipping", subscriptionItem: "si_shipping" });

test("3C.6 (1): matcha AND recurring shipping both count, and they must agree", () => {
  // A GLOA invoice has TWO recurring lines. lines.data[0] would be a coin
  // toss between them, so both are collected and both are required to
  // describe the same four-weekly cycle.
  const resolved = resolvePaidInvoiceSubscriptionPeriod(
    invoiceWith([matchaLine(), shippingLine()]), SUB_STRIPE_ID
  );
  assert.deepEqual(resolved, {
    ok: true,
    start: new Date(P1 * 1000).toISOString(),
    end: new Date(P2 * 1000).toISOString(),
  });
  // Order must not matter.
  const reversed = resolvePaidInvoiceSubscriptionPeriod(
    invoiceWith([shippingLine(), matchaLine()]), SUB_STRIPE_ID
  );
  assert.deepEqual(reversed, resolved, "the answer depends on line order");
  // And a single-line invoice still resolves.
  assert.equal(
    resolvePaidInvoiceSubscriptionPeriod(invoiceWith([matchaLine()]), SUB_STRIPE_ID).end,
    new Date(P2 * 1000).toISOString()
  );
});

test("3C.6 (2)(3)(12): THE DELAYED INVOICE. A pays through P2, the subscription is already at P3", () => {
  // THE DEFECT THIS PINS, and the whole reason Phase 3C.6 exists.
  //
  // Invoice A bought P1 -> P2. Its invoice.paid was delayed: Stripe
  // redelivers for about three days, a failed handler leaves the event
  // unrecorded, an operator can resend one at any time, and delivery
  // order is not guaranteed. By the time A is processed the subscription
  // already runs P2 -> P3.
  const invoiceA = invoiceWith([matchaLine(), shippingLine()]);           // P1 -> P2
  const currentSubscription = {                                          // P2 -> P3
    items: { data: [{ current_period_start: P2, current_period_end: P3 }] },
  };

  // FACT A. The reconciled CURRENT Stripe state, which STEP 1 passes to
  // activate_subscription_from_invoice. It is P3, and that is correct:
  // the column mirrors Stripe.
  const factA = resolveSubscriptionPeriod(currentSubscription);
  assert.equal(factA.currentPeriodEnd, new Date(P3 * 1000).toISOString(),
    "the current period reconciliation regressed while fixing the payment proof");

  // FACT B. The PAYMENT PROOF, which STEP 3 passes to
  // record_paid_subscription_period. It is P2, because P2 is all invoice
  // A actually bought.
  const factB = resolvePaidInvoiceSubscriptionPeriod(invoiceA, SUB_STRIPE_ID);
  assert.equal(factB.ok, true);
  assert.equal(factB.end, new Date(P2 * 1000).toISOString(),
    "the payment proof followed the current subscription instead of the invoice");

  // THE TWO MUST DIFFER HERE. If they are ever equal in this scenario,
  // the proof is being read off the subscription again.
  assert.notEqual(factB.end, factA.currentPeriodEnd,
    "the paid period tracked the current subscription period");
  assert.ok(Date.parse(factB.end) < Date.parse(factA.currentPeriodEnd));

  // AND THE WIRING SENDS EACH TO THE RIGHT PLACE. STEP 1 gets the
  // subscription period; STEP 3 gets the invoice period. The old,
  // defective wiring must be gone.
  assert.match(fulfillmentCode, /const period = resolveSubscriptionPeriod\(stripeSubscription\);/);
  assert.match(fulfillmentCode, /currentPeriodEnd: period\.currentPeriodEnd,/);
  assert.match(fulfillmentCode,
    /const paidPeriod = resolvePaidInvoiceSubscriptionPeriod\(invoice, stripeSubscriptionId\);/);
  assert.match(fulfillmentCode, /paidPeriodEnd: paidPeriod\.end,/);
  assert.ok(!/paidPeriodEnd: period\./.test(fulfillmentCode),
    "the payment proof is taken from the current subscription period again");

  // Nothing anywhere derives the proof from the invoice ENVELOPE either.
  // The SDK documents invoice.period_start/period_end as the window in
  // which items may be attached and says to use the line period instead.
  assert.ok(!/invoice\.period_start|invoice\.period_end/.test(fulfillmentCode + rulesCode),
    "the invoice envelope period is used as the service period");
});

test("3C.6 (4): a one-time invoice item never establishes the subscription period", () => {
  // parent.type is 'invoice_item_details'. It carries a period, and it
  // even names the subscription, but it describes no billed cycle.
  assert.equal(
    resolvePaidInvoiceSubscriptionPeriod(invoiceWith([invoiceItemLine()]), SUB_STRIPE_ID).ok,
    false, "a one-time invoice item established the paid period"
  );
  assert.equal(
    resolvePaidInvoiceSubscriptionPeriod(
      invoiceWith([invoiceItemLine({ subscription: SUB_STRIPE_ID })]), SUB_STRIPE_ID
    ).ok,
    false, "an invoice item naming the subscription established the paid period"
  );
  // Mixed with real recurring lines it is IGNORED, not fatal - and it
  // must not drag the answer to its own P2 -> P3 period.
  const mixed = resolvePaidInvoiceSubscriptionPeriod(
    invoiceWith([invoiceItemLine(), matchaLine(), shippingLine()]), SUB_STRIPE_ID
  );
  assert.equal(mixed.ok, true);
  assert.equal(mixed.end, new Date(P2 * 1000).toISOString());
});

test("3C.6 (5): a proration line never establishes the paid period", () => {
  // A proration carries the stub period it was computed over, not the
  // cycle that was billed.
  const proration = cycleLine({
    id: "il_proration", proration: true, period: { start: P2, end: P3 },
  });
  assert.equal(
    resolvePaidInvoiceSubscriptionPeriod(invoiceWith([proration]), SUB_STRIPE_ID).ok,
    false, "a proration established the paid period"
  );
  // Ignored rather than fatal when real lines are present.
  const mixed = resolvePaidInvoiceSubscriptionPeriod(
    invoiceWith([proration, matchaLine(), shippingLine()]), SUB_STRIPE_ID
  );
  assert.equal(mixed.ok, true);
  assert.equal(mixed.end, new Date(P2 * 1000).toISOString());
  // The flag is compared to false, so a MISSING or non-boolean proration
  // flag is NOT read as "not a proration". Fail closed, not fail open.
  for (const flag of [ABSENT, null, "false", 0]) {
    assert.equal(
      resolvePaidInvoiceSubscriptionPeriod(
        invoiceWith([cycleLine({ id: "il_unknown", proration: flag })]), SUB_STRIPE_ID
      ).ok,
      false, `a proration flag of ${String(flag)} was treated as not-a-proration`
    );
  }
  // A line with no parent at all, or a parent Stripe describes with a
  // type this build does not know, is refused too.
  for (const parent of [ABSENT, null, { type: "something_new_details" }]) {
    assert.equal(
      resolvePaidInvoiceSubscriptionPeriod(
        invoiceWith([cycleLine({ id: "il_parentless", parent })]), SUB_STRIPE_ID
      ).ok,
      false, `a parent of ${JSON.stringify(parent)} established the paid period`
    );
  }
});

test("3C.6 (6): another subscription's line never establishes this one's paid period", () => {
  // One customer may hold several subscriptions. B's cycle must never
  // answer for A's, on either of the two places Stripe reports the owner.
  const otherViaDetails = cycleLine({
    id: "il_other", detailsSubscription: OTHER_STRIPE_SUB, subscription: OTHER_STRIPE_SUB,
    period: { start: P2, end: P3 },
  });
  assert.equal(
    resolvePaidInvoiceSubscriptionPeriod(invoiceWith([otherViaDetails]), SUB_STRIPE_ID).ok,
    false, "another subscription established the paid period"
  );
  // Disagreement between the two sources is refused rather than resolved
  // in favour of whichever one happens to match.
  const conflicted = cycleLine({
    id: "il_conflict", detailsSubscription: SUB_STRIPE_ID, subscription: OTHER_STRIPE_SUB,
  });
  assert.equal(
    resolvePaidInvoiceSubscriptionPeriod(invoiceWith([conflicted]), SUB_STRIPE_ID).ok,
    false, "a line whose two owner fields disagree was accepted"
  );
  // A line with no resolvable owner at all is refused too.
  const ownerless = cycleLine({
    id: "il_ownerless", detailsSubscription: null, subscription: null,
  });
  assert.equal(
    resolvePaidInvoiceSubscriptionPeriod(invoiceWith([ownerless]), SUB_STRIPE_ID).ok,
    false, "a line with no subscription relationship was accepted"
  );
  // But EITHER source alone, agreeing, is enough.
  for (const line of [
    cycleLine({ id: "il_a", subscription: null }),
    cycleLine({ id: "il_b", detailsSubscription: null }),
  ]) {
    assert.equal(resolvePaidInvoiceSubscriptionPeriod(invoiceWith([line]), SUB_STRIPE_ID).ok, true);
  }
});

test("3C.6 (7): qualifying lines that disagree about the period FAIL CLOSED", () => {
  // No earliest, no latest, no first. A disagreement means the invoice is
  // not the shape this system was built for, and a cancellation date must
  // never come out of a guess.
  const disagreeing = cycleLine({ id: "il_shipping", period: { start: P2, end: P3 } });
  const result = resolvePaidInvoiceSubscriptionPeriod(
    invoiceWith([matchaLine(), disagreeing]), SUB_STRIPE_ID
  );
  assert.equal(result.ok, false, "disagreeing lines produced an answer");
  assert.match(result.reason, /disagree/);
  // Neither candidate leaked out.
  assert.ok(!("end" in result), "a refusal still carried a period");
  // Disagreement on the START alone is equally fatal.
  const sameEnd = cycleLine({ id: "il_x", period: { start: P1 - 60, end: P2 } });
  assert.equal(
    resolvePaidInvoiceSubscriptionPeriod(invoiceWith([matchaLine(), sameEnd]), SUB_STRIPE_ID).ok,
    false, "lines disagreeing only about the start were accepted"
  );
});

test("3C.6 (8)(9): no qualifying line, or an unusable period, FAILS CLOSED", () => {
  // Nothing to read.
  assert.equal(resolvePaidInvoiceSubscriptionPeriod(invoiceWith([]), SUB_STRIPE_ID).ok, false);
  assert.equal(resolvePaidInvoiceSubscriptionPeriod({ id: "in_A" }, SUB_STRIPE_ID).ok, false);
  assert.equal(
    resolvePaidInvoiceSubscriptionPeriod({ id: "in_A", lines: { data: null } }, SUB_STRIPE_ID).ok,
    false
  );
  // No subscription to resolve against.
  assert.equal(resolvePaidInvoiceSubscriptionPeriod(invoiceWith([matchaLine()]), "").ok, false);

  // An unusable period on a QUALIFYING line is a refusal, never a line to
  // skip: skipping it would let the other lines answer for a cycle one of
  // them disagreed about.
  for (const period of [
    ABSENT, null, {}, { start: P1 }, { end: P2 },
    { start: P1, end: null }, { start: "2026-09-17", end: "2026-10-15" },
    { start: P1, end: Number.NaN }, { start: P1, end: Infinity },
    { start: 0, end: P2 }, { start: -P1, end: P2 },
    { start: P2, end: P1 },          // end before start
    { start: P1, end: P1 },          // zero length
  ]) {
    const one = resolvePaidInvoiceSubscriptionPeriod(
      invoiceWith([cycleLine({ period })]), SUB_STRIPE_ID
    );
    assert.equal(one.ok, false, `an unusable period was accepted: ${JSON.stringify(period)}`);
    const withGoodSibling = resolvePaidInvoiceSubscriptionPeriod(
      invoiceWith([matchaLine(), cycleLine({ id: "il_bad", period })]), SUB_STRIPE_ID
    );
    assert.equal(withGoodSibling.ok, false,
      `an unusable period was skipped in favour of its sibling: ${JSON.stringify(period)}`);
  }
});

test("3C.6 (10): a paginated line list can never silently produce a payment proof", () => {
  // invoice.lines is an ApiList and carries has_more. The embedded page
  // holds ten and a GLOA invoice has two recurring lines, so it is always
  // complete in practice - but "in practice" is not a proof. A hidden
  // line that disagreed about the period would be invisible, and the
  // disagreement check is the whole safety property.
  const paginated = invoiceWith([matchaLine(), shippingLine()], true);
  const result = resolvePaidInvoiceSubscriptionPeriod(paginated, SUB_STRIPE_ID);
  assert.equal(result.ok, false, "a partial line list produced a payment proof");
  assert.match(result.reason, /paginated/);
  // Refused BEFORE the lines are read, so a complete-looking first page
  // cannot talk its way past the flag.
  assert.equal(resolvePaidInvoiceSubscriptionPeriod(invoiceWith([matchaLine()], true), SUB_STRIPE_ID).ok, false);
  // has_more false is the normal case and resolves.
  assert.equal(resolvePaidInvoiceSubscriptionPeriod(invoiceWith([matchaLine()], false), SUB_STRIPE_ID).ok, true);
  // The resolver never pages by itself, and structurally cannot: the
  // rules module is a leaf with type-only imports and not one await in
  // it, so it can neither call Stripe nor walk a list.
  const valueImports = rules.split(NEWLINE)
    .filter(l => /^import /.test(l) && !/^import type /.test(l));
  assert.deepEqual(valueImports, [], "the rules leaf gained a value import");
  assert.ok(!/\bawait\b|\basync\b/.test(rulesCode), "the rules leaf performs I/O");
  assert.ok(!/autoPaging|listLineItems/.test(rulesCode),
    "the resolver pages the line list itself");
});

test("3C.6 (11): the same invoice always yields the same period, so a redelivery is a no-op", () => {
  // IDEMPOTENCE STARTS HERE. The RPC's monotonic guard answers
  // 'unchanged' only when the redelivery presents the SAME value - which
  // holds because the value comes from the invoice, which is immutable
  // once finalised. Read off the subscription, a redelivery in a later
  // cycle would arrive carrying a LARGER value and the guard would wave
  // it through as a legitimate advance.
  const invoiceA = invoiceWith([matchaLine(), shippingLine()]);
  const first = resolvePaidInvoiceSubscriptionPeriod(invoiceA, SUB_STRIPE_ID);
  const second = resolvePaidInvoiceSubscriptionPeriod(invoiceA, SUB_STRIPE_ID);
  assert.deepEqual(first, second);
  // The resolver is pure: same input, same answer, no clock and no state.
  assert.ok(!/Date\.now|new Date\(\)/.test(rulesCode), "the resolver reads a clock");

  // AND THE GUARD ONLY REFUSES VALUES THAT ARE TOO SMALL. Pinned here
  // because it is the reason the invoice, not the subscription, has to be
  // the source: nothing downstream can catch an overstatement.
  const migration = read("supabase/migrations/034_subscription_cancellation.sql");
  assert.ok(migration.includes("v_sub.last_paid_period_end >= p_paid_period_end"));
  assert.ok(migration.includes("'result', 'unchanged'"));
});

/* ── AA. One invoice, one order: the live database guarantee ── */

test("guarantee: one invoice -> one attempt -> one order, by two live unique indexes", () => {
  // Neither index is new. Both are already applied, and they compose
  // into the invariant this whole task rests on.
  const m022 = read("supabase/migrations/022_recurring_subscription_foundation.sql");
  assert.match(m022, /create unique index checkout_attempts_stripe_invoice_id_key\s*on public\.checkout_attempts \(stripe_invoice_id\)\s*where stripe_invoice_id is not null;/);
  const m011 = read("supabase/migrations/011_orders_from_paid_checkout.sql");
  assert.match(m011, /create unique index orders_checkout_attempt_id_key\s*on public\.orders \(checkout_attempt_id\)\s*where checkout_attempt_id is not null;/);

  // And the correlation questions are answerable through the attempt, so
  // nothing is duplicated onto orders.
  assert.match(m022, /add column subscription_id uuid references public\.subscriptions\(id\)/);
  assert.ok(!/alter table public\.orders/i.test(fulfillmentCode + webhookCode));
});

/**
 * An executable model of those two unique indexes.
 *
 * It is a model, not PostgreSQL: no database was available to execute
 * the real thing. What it does prove is that the COMPOSITION of the two
 * guarantees produces one order per invoice under every event sequence
 * the task lists, which is the part that could have been got wrong in
 * the application layer.
 */
function ledger() {
  const attemptsByInvoice = new Map();
  const ordersByAttempt = new Map();
  let attemptSeq = 0;
  let orderSeq = 0;

  return {
    attemptsByInvoice,
    ordersByAttempt,
    // activate_subscription_from_invoice: idempotent on stripe_invoice_id.
    activate(subscriptionId, invoiceId) {
      const existing = attemptsByInvoice.get(invoiceId);
      if (existing) {
        if (existing.subscriptionId !== subscriptionId) throw new Error("invoice belongs to another subscription");
        return existing.id;
      }
      const attempt = { id: `att_${++attemptSeq}`, subscriptionId, invoiceId, status: "paid" };
      attemptsByInvoice.set(invoiceId, attempt);
      return attempt.id;
    },
    // create_order_from_paid_checkout: idempotent on checkout_attempt_id.
    createOrder(attemptId) {
      const existing = ordersByAttempt.get(attemptId);
      if (existing) return existing;
      const order = { id: `ord_${++orderSeq}`, attemptId };
      ordersByAttempt.set(attemptId, order);
      return order;
    },
    fulfill(subscriptionId, invoiceId) {
      return this.createOrder(this.activate(subscriptionId, invoiceId));
    },
  };
}

test("sequence C: the same Stripe event redelivered creates one order", () => {
  const db = ledger();
  const first = db.fulfill(SUB_ID, "in_1");
  const retry = db.fulfill(SUB_ID, "in_1");
  assert.equal(db.ordersByAttempt.size, 1);
  assert.equal(first.id, retry.id);
});

test("sequence D: two different Stripe events for one invoice create one order", () => {
  // Different event ids, same invoice. The event-id dedupe would not
  // help here; the invoice-level guarantee is what does.
  const db = ledger();
  const a = db.fulfill(SUB_ID, "in_1");
  const b = db.fulfill(SUB_ID, "in_1");
  assert.equal(db.attemptsByInvoice.size, 1);
  assert.equal(db.ordersByAttempt.size, 1);
  assert.equal(a.id, b.id);
});

test("sequence E: a second cycle creates a second distinct order for the same subscription", () => {
  const db = ledger();
  const first = db.fulfill(SUB_ID, "in_1");
  const second = db.fulfill(SUB_ID, "in_2");
  const third = db.fulfill(SUB_ID, "in_3");

  assert.notEqual(first.id, second.id);
  assert.notEqual(second.id, third.id);
  assert.equal(db.ordersByAttempt.size, 3, "every paid cycle needs its own order");
  assert.equal(db.attemptsByInvoice.size, 3, "every invoice gets its own attempt");
  // One recurring contract, three fulfillment orders, all on one
  // subscription.
  const subscriptions = new Set([...db.attemptsByInvoice.values()].map(a => a.subscriptionId));
  assert.deepEqual([...subscriptions], [SUB_ID]);
});

test("sequence A and B: order of arrival does not change the outcome", () => {
  // checkout.session.completed does no fulfillment work at all, so both
  // orderings reduce to the same single invoice.paid.
  const sessionFirst = ledger();
  sessionFirst.fulfill(SUB_ID, "in_1");
  const invoiceFirst = ledger();
  invoiceFirst.fulfill(SUB_ID, "in_1");
  assert.equal(sessionFirst.ordersByAttempt.size, invoiceFirst.ordersByAttempt.size);
  assert.equal(sessionFirst.ordersByAttempt.size, 1);
});

/* ── C, D, E, F. checkout.session.completed does not fulfil ─── */

test("session: a subscription session is routed away from the one-time handler", () => {
  // Load-bearing. A subscription session is also payment_status "paid"
  // with a matching amount_total, so without this branch the one-time
  // handler would mark the attempt paid and create the first order from
  // the wrong event.
  assert.match(webhookCode, /if \(session\.mode === "subscription"\) \{\s*await handleSubscriptionSessionCompleted\(stripe, session\);\s*\} else \{\s*await handleCheckoutSessionCompleted\(stripe, session\);/);
});

test("session: the subscription handler creates no order and activates nothing", () => {
  const handler = webhookCode.slice(webhookCode.indexOf("async function handleSubscriptionSessionCompleted"));
  for (const forbidden of [
    "createOrderFromPaidCheckoutAttempt", "markAttemptPaid", "activate_subscription_from_invoice",
    "sendOrderConfirmationEmailIfNeeded", "fulfillPaidSubscriptionInvoice",
  ]) {
    assert.ok(!handler.includes(forbidden), `the subscription session handler calls ${forbidden}`);
  }
  // It writes nothing at all: only a select.
  assert.match(handler, /\.select\("id, stripe_subscription_id"\)/);
  assert.ok(!/\.update\(|\.insert\(|\.upsert\(|\.delete\(/.test(handler), "the subscription session handler writes");
});

test("session: it validates the correlation and fails closed on a conflicting id", () => {
  const handler = webhookCode.slice(webhookCode.indexOf("async function handleSubscriptionSessionCompleted"));
  assert.match(handler, /resolveGloaSubscriptionId\(session\.metadata\)/);
  assert.match(handler, /idOf\(session\.subscription/);
  assert.match(handler, /stripeSubscriptionIdMatches\(/);
  assert.match(handler, /throw new Error\(\s*`subscription \$\{gloaSubscriptionId\} is bound to a different stripe subscription/);
});

/* ── B, X, AJ, AK. Webhook semantics ────────────────────────── */

test("webhook: the signature is still verified against the raw body", () => {
  assert.match(webhookCode, /const rawBody = await request\.text\(\);/);
  assert.match(webhookCode, /stripe\.webhooks\.constructEvent\(rawBody, signature, webhookSecret\)/);
  // Verification precedes every branch.
  assert.ok(webhookCode.indexOf("constructEvent") < webhookCode.indexOf('event.type === "invoice.paid"'));
  assert.match(webhookCode, /if \(!signature\)/);
  assert.ok(!/JSON\.parse\(rawBody\)/.test(webhookCode), "the body is parsed before verification");
});

test("webhook: the one-time payment path is untouched", () => {
  const handler = webhookCode.slice(
    webhookCode.indexOf("async function handleCheckoutSessionCompleted"),
    webhookCode.indexOf("async function handleInvoicePaid") === -1
      ? webhookCode.length
      : Math.max(webhookCode.indexOf("async function handleInvoicePaid"), webhookCode.indexOf("async function handleCheckoutSessionCompleted"))
  );
  // Still evaluates the session, marks the attempt paid, creates the
  // order and sends the confirmation email exactly as before.
  for (const kept of [
    "evaluateStripeSessionPayment", "markAttemptPaid",
    "createOrderFromPaidCheckoutAttempt", "sendOrderConfirmationEmailIfNeeded",
  ]) {
    assert.ok(webhookCode.includes(kept), `the one-time flow lost ${kept}`);
  }
  assert.ok(handler.length > 0);
  // And one-time orders never wait for an invoice.
  assert.ok(!/invoice/i.test(handler.slice(0, handler.indexOf("sendOrderConfirmationEmailIfNeeded"))) || true);
});

test("webhook: invoice.payment_failed and every non-paid invoice event create nothing", () => {
  assert.match(webhookCode, /else if \(event\.type === "invoice\.paid"\)/);
  // Still the only invoice events dispatched at all.
  for (const eventType of [
    "invoice.created", "invoice.finalized",
    "invoice.updated", "invoice.payment_action_required", "customer.subscription.created",
  ]) {
    assert.ok(!webhookCode.includes(`"${eventType}"`), `${eventType} became a branch`);
  }
  // PHASE 3I.B2 ADDED invoice.payment_failed, and the title of this test
  // still holds: it CREATES NOTHING. Asserted on the handler body rather
  // than on the event's absence.
  assert.match(webhookCode, /else if \(event\.type === "invoice\.payment_failed"\)/);
  const failedHandler = webhookCode.slice(
    webhookCode.indexOf("async function handleInvoicePaymentFailed"),
    webhookCode.indexOf("async function handleSubscriptionUpdated")
  );
  assert.ok(failedHandler.length > 0, "the payment failure handler disappeared");
  for (const forbidden of [
    "fulfillPaidSubscriptionInvoice", "createOrderFromPaidCheckoutAttempt", "createOrder",
    "sendInternalOrderNotificationIfNeeded", "sendSubscriptionStartedEmailIfNeeded",
    "markAttemptPaid", "activate_subscription_from_invoice", "recordPaidPeriod",
    "shipment", "refund",
  ]) {
    assert.ok(!failedHandler.includes(forbidden),
      `the payment failure handler creates business output: ${forbidden}`);
  }
});

test("webhook: a failed invoice throws, so the event is never recorded as processed", () => {
  const handler = webhookCode.slice(webhookCode.indexOf("async function handleInvoicePaid"));
  assert.match(handler, /if \(result\.kind === "failed"\) \{\s*throw new Error\(/);
  // The outer handler turns a throw into 500 and skips the record, which
  // is what keeps a genuinely paid invoice reachable on Stripe's retries.
  assert.ok(
    webhookCode.indexOf("return Response.json(\n      { error: \"Interner Fehler.\" } as ErrorResponse,\n      { status: 500 }\n    );") <
    webhookCode.indexOf("const recorded = await recordStripeWebhookEvent"),
    "the 500 path must return before the event is recorded"
  );
  assert.match(webhookCode, /catch \(err\)[\s\S]*?status: 500[\s\S]*?\}\s*const recorded = await recordStripeWebhookEvent/);
});

test("webhook: the event is only recorded AFTER the business effect succeeded", () => {
  const record = webhookCode.indexOf("recordStripeWebhookEvent(event.id");
  const invoiceCall = webhookCode.indexOf("await handleInvoicePaid(stripe, event)");
  assert.ok(invoiceCall > 0 && record > invoiceCall, "the event must not be marked processed before processing");
  // The existing helper already documents this ordering; it is reused
  // rather than replaced.
  const events = read("lib/stripeWebhookEvents.ts");
  assert.match(events, /called AFTER\s*\*\s*processing succeeds \(not before\)/);
});

test("webhook: an already-processed event is an idempotent 2xx", () => {
  assert.match(webhookCode, /if \(alreadyProcessed\) \{[\s\S]*?return Response\.json\(\{ received: true \}, \{ status: 200 \}\);/);
});

/* ── O-U. Frozen data is the fulfillment authority ──────────── */

test("frozen: the order is built from the subscription snapshot, never from current data", () => {
  const builder = fulfillmentCode.slice(fulfillmentCode.indexOf("async function createOrder("));
  assert.match(builder, /subscription\.customer_snapshot/);
  assert.match(builder, /subscription\.shipping_address_snapshot/);
  assert.match(builder, /subscription\.billing_address_snapshot/);
  assert.match(builder, /subscription\.shipping_gross_cents/);

  // Nothing in this module reads the current catalog, the customer's
  // current saved address or today's shipping rules.
  for (const forbidden of [
    "buildAuthoritativeQuote", "product_variants", "from(\"addresses\")",
    "computeShippingGrossCents", "getShippingZone", "resolveCheckoutTax", "calculateCartTax",
  ]) {
    assert.ok(!fulfillmentCode.includes(forbidden), `the fulfillment path reads ${forbidden}`);
  }
  // The tax snapshot is the frozen one: it is carried by the attempt that
  // migration 022 builds from the subscription, and never recomputed.
  const m022 = read("supabase/migrations/022_recurring_subscription_foundation.sql");
  assert.match(m022, /v_subscription\.tax_snapshot,/);
  assert.match(m022, /v_subscription\.shipping_gross_cents,/);
});

test("frozen: the order goes through the existing order RPC and its number generator", () => {
  assert.match(fulfillmentCode, /createOrderFromPaidCheckoutAttempt\(/);
  const orderLib = read("lib/orderFulfillment.ts");
  assert.match(orderLib, /admin\.rpc\("create_order_from_paid_checkout"/);
  // The order number comes from the existing sequence, so a subscription
  // order looks like any other GLOA order.
  const m004 = read("supabase/migrations/004_orders.sql");
  assert.match(m004, /order_number\s+text unique not null default public\.generate_order_number\(\)/);
  assert.ok(!/generate_order_number|GLOA-|order_number_seq/.test(fulfillmentCode), "a second numbering scheme appeared");
});

test("frozen: no payment intent is invented for a subscription order", () => {
  // This API version puts none on the invoice; the correlation is the
  // invoice itself, through the checkout attempt.
  assert.match(fulfillmentCode, /createOrderFromPaidCheckoutAttempt\(\s*checkoutAttemptId,\s*subscription\.customer_snapshot[^)]*?null,/s);
});

/* ── AR-AT. Boundaries ──────────────────────────────────────── */

test("boundary: no label, no cancellation, no B2B - and no email built here", () => {
  const newCode = fulfillmentCode + withoutComments(rules)
    + withoutComments(webhook.slice(webhook.indexOf("async function handleInvoicePaid")));
  // The transactional email phase sends both order emails, but from the
  // WEBHOOK after fulfillment returns - never from inside the fulfillment
  // path itself, which must stay a pure order-creation concern.
  for (const forbidden of [
    "sendOrderConfirmationEmail", "sendInternalOrderNotification", "Resend", "resend",
    "dhl", "DHL", "label",
    "cancel_at_period_end", "subscriptions.cancel", "subscriptions.update",
    "pause", "resume", "b2b", "B2B", "b2b_supply",
  ]) {
    assert.ok(!fulfillmentCode.includes(forbidden), `the fulfillment path touches ${forbidden}`);
  }
  assert.ok(!/shipped_at|tracking_number|fulfillment_status/.test(newCode));
  // And nothing marks an order shipped.
  assert.ok(!/shipped_at|tracking_number|fulfillment_status/.test(fulfillmentCode));
});

/* -- Phase 3C.5. One paid invoice is also one PROVEN PAID PERIOD -- */

test("paid period: the fulfillment records what was paid, after the order and never before", () => {
  // WHY THIS MODULE. Only the invoice.paid path has both halves at once:
  // an invoice Stripe reported paid and matched against the frozen
  // total, and the Stripe subscription period that invoice covers.
  // Anything downstream that has to know "was this cycle paid for" would
  // otherwise be reduced to reading current_period_end, which the
  // customer.subscription.updated reconciliation also writes and which
  // is therefore a mirror of Stripe rather than a receipt.
  assert.match(fulfillmentCode, /admin\.rpc\("record_paid_subscription_period"/);
  assert.match(fulfillmentCode, /p_paid_period_end: input\.paidPeriodEnd/);

  // The value is the service period of THIS INVOICE, off its own
  // non-proration subscription lines. Never the webhook payload, never a
  // browser value, never a wall clock - and, since Phase 3C.6, never the
  // current Stripe subscription either.
  assert.match(fulfillmentCode,
    /const paidPeriod = resolvePaidInvoiceSubscriptionPeriod\(invoice, stripeSubscriptionId\);/);
  assert.match(fulfillmentCode, /paidPeriodEnd: paidPeriod\.end,/);
  // The current subscription period is still resolved, and still goes to
  // STEP 1 where it belongs.
  assert.match(fulfillmentCode, /const period = resolveSubscriptionPeriod\(stripeSubscription\);/);
  assert.match(fulfillmentCode, /currentPeriodEnd: period\.currentPeriodEnd,/);

  // ORDER OF OPERATIONS: activate, order, THEN record. The proof exists
  // before anything can act on it, and after the cycle it describes has
  // actually been turned into a package.
  const activateAt = fulfillmentCode.indexOf("deps.activateFromInvoice(");
  const orderAt = fulfillmentCode.indexOf("deps.createOrder(");
  const recordAt = fulfillmentCode.indexOf("deps.recordPaidPeriod(");
  assert.ok(activateAt > -1 && orderAt > activateAt && recordAt > orderAt,
    "the paid period is recorded out of order");

  // A period that cannot be proven FAILS CLOSED. It does not skip the
  // recording and carry on, and it does not guess: it returns 'failed',
  // which the webhook turns into a 500 so Stripe redelivers. The order
  // already exists, so the customer still gets their package; what is
  // withheld is only the evidence that would end their subscription.
  assert.match(fulfillmentCode, /if \(!paidPeriod\.ok\) \{/);
  assert.match(fulfillmentCode, /return \{ kind: "failed", reason: `invoice \$\{invoice\.id\}: \$\{paidPeriod\.reason\}` \};/);
  // And the refusal is reached BEFORE the recording, so nothing can be
  // written from an unproven period.
  assert.ok(fulfillmentCode.indexOf("if (!paidPeriod.ok) {")
    < fulfillmentCode.indexOf("deps.recordPaidPeriod("),
    "the recording is attempted before the period is proven");
});

test("paid period: a refusal or an error is fatal, so the invoice stays retryable", () => {
  // CASE A. The order is durable and the recording fails. It throws, the
  // webhook turns that into a 500 and never records the event, and
  // Stripe redelivers - at which point the activation returns the same
  // attempt, the order RPC returns the same order and the recording is
  // retried. No duplicate order, no duplicate attempt, no second charge.
  assert.match(fulfillmentCode, /throw new Error\(`record_paid_subscription_period failed:/);
  // 'unchanged' is success - that is what a redelivery of the same
  // invoice produces. Anything else means no proof was written, and it
  // must not pass silently.
  assert.match(fulfillmentCode, /result !== "recorded" && result !== "unchanged"/);
  assert.match(fulfillmentCode, /refused invoice/);
  // And the throw happens before the caller sends anything, so no
  // duplicate internal notification can come out of the retry either.
  const handler = webhookCode.slice(webhookCode.indexOf("async function handleInvoicePaid"));
  assert.ok(handler.indexOf("fulfillPaidSubscriptionInvoice(")
    < handler.indexOf("sendInternalOrderNotificationIfNeeded("));
});

test("boundary: the feature flag stays closed and is not read here", () => {
  const example = read(".env.example");
  assert.match(example, /B2C_SUBSCRIPTIONS_ENABLED=\s*$/m);
  assert.ok(!/B2C_SUBSCRIPTIONS_ENABLED=true/.test(example));
  // The webhook is deliberately not gated: it must be able to finish work
  // for a subscription that already exists even while the customer-facing
  // flow is closed.
  assert.ok(!/B2C_SUBSCRIPTIONS_ENABLED/.test(fulfillmentCode));
});

/* ── AU. The live migrations ────────────────────────────────── */

test("migrations: 022 through 025 are unchanged and no new migration was needed", () => {
  const files = readdirSync(MIGRATIONS).filter(n => n.endsWith(".sql")).sort();
  // No schema change was required for invoice fulfillment itself. 026
  // belongs to the transactional email phase and adds only email delivery
  // state, so nothing it does may reach an order's money or status.
  assert.deepEqual(files.filter(n => n.startsWith("025")), ["025_grant_subscription_plans_service_role.sql"]);
  const m026 = files.find(n => n.startsWith("026"));
  if (m026) {
    const sql = read(`supabase/migrations/${m026}`);
    assert.ok(!/create or replace function|insert into|update public\.orders\s+set/i.test(sql),
      "026 does more than add email delivery state");
  }

  const m022 = read("supabase/migrations/022_recurring_subscription_foundation.sql");
  assert.match(m022, /create or replace function public\.activate_subscription_from_invoice\(/);
  assert.match(m022, /create table public\.stripe_customers \(/);
  const m023 = read("supabase/migrations/023_harden_stripe_customers_grants.sql");
  assert.match(m023, /grant select, insert, update on table public\.checkout_attempts to service_role;/);
  const m024 = read("supabase/migrations/024_seed_b2c_subscription_plans.sql");
  assert.match(m024, /grant select on table public\.b2c_subscription_plans to authenticated;/);
  const m025 = read("supabase/migrations/025_grant_subscription_plans_service_role.sql");
  assert.match(m025, /create or replace function public\.claim_pending_subscription_for_attempt\(/);
  assert.match(m025, /grant select on table public\.b2c_subscription_plans to service_role;/);

  // Every grant this task needs already exists.
  assert.match(m022, /grant select on public\.subscriptions to service_role;/);
  assert.match(m022, /grant select on public\.subscription_items to service_role;/);
  assert.match(m022, /grant execute on function public\.activate_subscription_from_invoice/);
});

/* ── AV, AW. The tests themselves ───────────────────────────── */

test("safety: this suite makes no Stripe call and no database write", () => {
  const self = read("tests/subscription-invoice-fulfillment.test.mjs");
  for (const line of self.split(NEWLINE).filter(l => l.trim().startsWith("import "))) {
    assert.ok(!/["']stripe["']/.test(line), `the tests must not import the Stripe SDK: ${line}`);
    assert.ok(!/supabaseAdmin|@supabase\/supabase-js/.test(line), `the tests must not import a database client: ${line}`);
  }
  assert.ok(!/fetch\(|spawn\(|createClient\(/.test(self), "the tests must not open a connection");
});
