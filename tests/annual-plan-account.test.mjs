import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ANNUAL_ACCOUNT_CADENCE,
  ANNUAL_CHECKOUT_RETURN_PARAM,
  ANNUAL_ACCOUNT_PAYMENT_STATUSES,
  ANNUAL_ACCOUNT_STATUSES,
  ANNUAL_PLAN_ACCOUNT_SELECT,
  ANNUAL_PLAN_DELIVERY_ACCOUNT_SELECT,
  buildAnnualPlanAccountView,
  buildAnnualPlanProduct,
  findNextAnnualDelivery,
  isFulfilledAnnualDelivery,
  isPurchasedAnnualPlanRow,
  resolveAnnualCheckoutReturnState,
} from "../lib/annualPlanAccount.ts";
import { ANNUAL_DELIVERY_COUNT, ANNUAL_DELIVERY_INTERVAL_DAYS } from "../lib/annualPlanRules.ts";

/* ══════════════════════════════════════════════════════════════
   PHASE 4B8 - THE ANNUAL PLAN'S CUSTOMER READ MODEL

   SAFE DEFAULT SUITE: a pure mapper driven with plain row literals, plus
   source-level checks on what the account is allowed to select and what
   the mapper is allowed to import.

   No Supabase client is constructed, no SQL runs, no RPC is invoked, no
   Stripe object exists, no webhook is delivered, no email is sent and no
   page is rendered. Nothing here reads a wall clock - and neither does
   the module under test, which is the point of several assertions below.

   What it protects: a customer looking at a year they have already paid
   for sees what they bought, what it cost, what has shipped and what is
   still owed - and never sees the Stripe identity, the claim token or the
   snapshots that sit on the same row.
   ══════════════════════════════════════════════════════════════ */

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf-8");
const NEWLINE = String.fromCharCode(10);

const withoutComments = source => source
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split(NEWLINE)
  .filter(line => {
    const t = line.trim();
    return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
  })
  .join(NEWLINE);

const MIGRATION_039 = "supabase/migrations/039_b2c_annual_plan_foundation.sql";
const m039 = read(MIGRATION_039);
const accountCode = withoutComments(read("lib/annualPlanAccount.ts"));

const DAY_MS = 24 * 60 * 60 * 1000;
const PLAN_ID = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const PURCHASED_AT = "2026-01-05T10:00:00.000Z";

/** The frozen 30 g contract, exactly as activation leaves it. */
const planRow = (over = {}) => ({
  id: PLAN_ID,
  status: "active",
  payment_status: "paid",
  currency: "EUR",
  delivery_count: ANNUAL_DELIVERY_COUNT,
  catalog_unit_gross_cents: 2499,
  annual_unit_gross_cents: 2249,
  shipping_per_delivery_gross_cents: 249,
  merchandise_total_gross_cents: 29237,
  shipping_total_gross_cents: 3237,
  total_gross_cents: 31057,
  refunded_total_cents: 0,
  discount_percent_applied: "10.00",
  delivery_items_snapshot: [
    {
      variantId: "cccccccc-3333-4333-8333-cccccccccccc",
      sku: "GLOA-MATCHA-30G",
      productName: "GLOA Matcha Ceremonial",
      variantLabel: "30 g",
      sizeGrams: 30,
      quantity: 1,
      unitGrossCents: 2249,
      lineGrossCents: 2249,
      currency: "EUR",
    },
  ],
  purchased_at: PURCHASED_AT,
  plan_end_at: "2027-01-04T10:00:00.000Z",
  completed_at: null,
  cancelled_at: null,
  created_at: "2026-01-05T09:58:00.000Z",
  ...over,
});

/** Thirteen durable schedule rows, 28 days apart, as migration 039 wrote them. */
const schedule = (over = {}) =>
  Array.from({ length: ANNUAL_DELIVERY_COUNT }, (unused, i) => ({
    id: `d${i + 1}`,
    annual_plan_id: PLAN_ID,
    delivery_number: i + 1,
    scheduled_for: new Date(
      Date.parse(PURCHASED_AT) + i * ANNUAL_DELIVERY_INTERVAL_DAYS * DAY_MS
    ).toISOString(),
    state: "scheduled",
    fulfilled_at: null,
    order_id: null,
    ...(over[i + 1] ?? {}),
  }));

const shipped = n => ({
  state: "fulfilled",
  fulfilled_at: new Date(Date.parse(PURCHASED_AT) + (n - 1) * ANNUAL_DELIVERY_INTERVAL_DAYS * DAY_MS).toISOString(),
  order_id: `o${n}`,
});

const shippedThrough = last => {
  const over = {};
  for (let n = 1; n <= last; n++) over[n] = shipped(n);
  return over;
};

/* ══════════════════════════════════════════════════════════════
   1-4. THE ACTIVE PLAN
   ══════════════════════════════════════════════════════════════ */

test("1: an active plan with delivery 1 shipped reads 1 of 13", () => {
  const view = buildAnnualPlanAccountView(planRow(), schedule(shippedThrough(1)));

  assert.equal(view.status, "active");
  assert.equal(view.paymentStatus, "paid");
  assert.equal(view.fulfilledDeliveries, 1);
  assert.equal(view.deliveryCount, 13);
  assert.equal(view.scheduleComplete, true);

  // The commercial facts, so no browser has to know them as arithmetic.
  assert.equal(view.prepaid, true);
  assert.equal(view.autoRenews, false);
  assert.equal(view.cadence, "every_4_weeks");
  assert.equal(ANNUAL_ACCOUNT_CADENCE, "every_4_weeks");

  // The money is the FROZEN money, cent for cent.
  assert.equal(view.totalGrossCents, 31057);
  assert.equal(view.annualUnitGrossCents, 2249);
  assert.equal(view.catalogUnitGrossCents, 2499);
  assert.equal(view.shippingPerDeliveryGrossCents, 249);
  assert.equal(view.merchandiseTotalGrossCents, 29237);
  assert.equal(view.shippingTotalGrossCents, 3237);
  assert.equal(view.refundedTotalCents, 0);
  assert.equal(view.discountPercentApplied, 10);
  assert.equal(view.currency, "EUR");

  // The next delivery is READ from delivery 2's own row.
  assert.equal(view.nextDelivery.deliveryNumber, 2);
  assert.equal(view.nextDelivery.scheduledFor, schedule()[1].scheduled_for);
  assert.equal(view.nextDelivery.state, "scheduled");
  assert.equal(view.nextDelivery.fulfilledAt, null);
});

test("2: mid-plan progress is COUNTED from the rows, not from elapsed time", () => {
  const view = buildAnnualPlanAccountView(planRow(), schedule(shippedThrough(6)));

  assert.equal(view.fulfilledDeliveries, 6);
  assert.equal(view.nextDelivery.deliveryNumber, 7);
  assert.equal(view.nextDelivery.scheduledFor, schedule()[6].scheduled_for);
  // Thirteen boxes, never "month 6 of 12".
  assert.equal(view.deliveries.length, 13);
  assert.equal(view.deliveries[0].orderId, "o1");
  assert.equal(view.deliveries[6].orderId, null);
});

test("3: the next delivery comes from the SCHEDULE ROWS, not from purchased_at", () => {
  const rows = schedule(shippedThrough(6));
  const original = buildAnnualPlanAccountView(planRow(), rows);

  // Move the purchase date by a month and change nothing else. A reader
  // that derived dates would move the answer; this one must not.
  const moved = buildAnnualPlanAccountView(
    planRow({ purchased_at: "2025-11-01T00:00:00.000Z", plan_end_at: "2026-10-31T00:00:00.000Z" }),
    rows
  );

  assert.equal(moved.nextDelivery.scheduledFor, original.nextDelivery.scheduledFor);
  assert.deepEqual(
    moved.deliveries.map(d => d.scheduledFor),
    original.deliveries.map(d => d.scheduledFor)
  );
  // And the mapper does no schedule arithmetic at all.
  for (const banned of [
    "672", "364", "28 *", "* 28", "DAY_MS", "Date.now", "new Date(",
    "getTime()", "setDate(", "addDays",
  ]) {
    assert.ok(!accountCode.includes(banned), `the account mapper computes a schedule: ${banned}`);
  }
});

test("4: a CLAIMED delivery is the next one, and is never reported as shipped", () => {
  const rows = schedule({ ...shippedThrough(6), 7: { state: "claimed" } });
  const view = buildAnnualPlanAccountView(planRow(), rows);

  assert.equal(view.fulfilledDeliveries, 6, "a claimed delivery was counted as fulfilled");
  assert.equal(view.nextDelivery.deliveryNumber, 7);
  // Its durable state is passed through truthfully, not translated into a
  // promise the database has not made.
  assert.equal(view.nextDelivery.state, "claimed");
  assert.equal(view.nextDelivery.fulfilledAt, null);
  assert.equal(view.nextDelivery.orderId, null);
  assert.equal(isFulfilledAnnualDelivery({ state: "claimed", order_id: null }), false);
  // A 'fulfilled' row without its durable order is not progress either -
  // the same census complete_due_annual_plans runs.
  assert.equal(isFulfilledAnnualDelivery({ state: "fulfilled", order_id: null }), false);
  assert.equal(isFulfilledAnnualDelivery({ state: "fulfilled", order_id: "o1" }), true);
  assert.match(m039, /d\.state = 'fulfilled' and d\.order_id is not null/);
});

/* ══════════════════════════════════════════════════════════════
   5-8. REFUNDS, COMPLETION, CANCELLATION
   ══════════════════════════════════════════════════════════════ */

test("5: a PARTIAL refund keeps the plan active and the schedule intact", () => {
  const view = buildAnnualPlanAccountView(
    planRow({ payment_status: "partially_refunded", refunded_total_cents: 2498 }),
    schedule(shippedThrough(3))
  );

  assert.equal(view.status, "active");
  assert.equal(view.paymentStatus, "partially_refunded");
  assert.equal(view.refundedTotalCents, 2498);
  // The customer is still owed the rest, and the view says so.
  assert.equal(view.nextDelivery.deliveryNumber, 4);
  assert.equal(view.deliveries.length, 13);
  assert.equal(view.autoRenews, false);
  assert.equal(view.cancelledAt, null);
});

test("6: a FULL refund stays visible as history, with no next delivery promised", () => {
  const view = buildAnnualPlanAccountView(
    planRow({ payment_status: "refunded", refunded_total_cents: 31057 }),
    schedule(shippedThrough(2))
  );

  // The plan is history, not hidden.
  assert.equal(view.id, PLAN_ID);
  assert.equal(view.paymentStatus, "refunded");
  assert.equal(view.refundedTotalCents, 31057);
  assert.equal(view.totalGrossCents, 31057);
  // What shipped, shipped.
  assert.equal(view.fulfilledDeliveries, 2);
  assert.equal(view.deliveries.filter(d => d.state === "fulfilled").length, 2);
  // The remaining schedule is preserved as history...
  assert.equal(view.deliveries.length, 13);
  // ...but nothing is presented as still coming, because the database's
  // own claim function will never hand one of those rows out again.
  assert.equal(view.nextDelivery, null);
  assert.match(m039, /p\.payment_status <> 'refunded'/);
});

test("7: a COMPLETED plan reads 13 of 13 with no next delivery", () => {
  const view = buildAnnualPlanAccountView(
    planRow({ status: "completed", completed_at: "2027-01-04T11:00:00.000Z" }),
    schedule(shippedThrough(13))
  );

  assert.equal(view.status, "completed");
  assert.equal(view.fulfilledDeliveries, 13);
  assert.equal(view.deliveryCount, 13);
  assert.equal(view.nextDelivery, null);
  assert.equal(view.completedAt, "2027-01-04T11:00:00.000Z");
  assert.equal(view.autoRenews, false);
  // No renewal, no upsell and no offer is invented by the read model.
  // `autoRenews: false` is the one place the word may appear, and it is a
  // statement that there is no renewal - so it is removed before the scan
  // rather than special-cased inside it.
  const withoutTheFalseFact = accountCode.split("autoRenews").join("");
  for (const banned of ["renew", "Renew", "upsell", "offer", "cta", "resubscribe"]) {
    assert.ok(!withoutTheFalseFact.includes(banned), `the read model invents a ${banned}`);
  }
});

test("8: an active plan with everything shipped promises nothing further", () => {
  // Thirteen fulfilled but the term has not ended, so the completion
  // sweep has not run yet. There is still nothing owed.
  const view = buildAnnualPlanAccountView(planRow(), schedule(shippedThrough(13)));
  assert.equal(view.status, "active");
  assert.equal(view.fulfilledDeliveries, 13);
  assert.equal(view.nextDelivery, null);

  // A cancelled plan is owed nothing either. The vocabulary is 039's, and
  // this phase adds no fifth word and no cancellation action.
  const cancelled = buildAnnualPlanAccountView(
    planRow({ status: "cancelled", cancelled_at: "2026-06-01T00:00:00.000Z" }),
    schedule(shippedThrough(5))
  );
  assert.equal(cancelled.nextDelivery, null);
  assert.equal(cancelled.fulfilledDeliveries, 5);
  assert.deepEqual([...ANNUAL_ACCOUNT_STATUSES], ["pending", "active", "completed", "cancelled"]);
  assert.deepEqual([...ANNUAL_ACCOUNT_PAYMENT_STATUSES],
    ["pending", "paid", "partially_refunded", "refunded"]);
  for (const banned of ["cancelSubscription", "requestCancellation", "terminate", "withdraw"]) {
    assert.ok(!accountCode.includes(banned), `the read model offers ${banned}`);
  }
});

test("9: the vocabularies match the CHECK constraints migration 039 installed", () => {
  const table = m039.slice(m039.indexOf("create table public.annual_plans"));
  for (const status of ANNUAL_ACCOUNT_STATUSES) {
    assert.ok(table.includes(`'${status}'`), `039 does not know the status ${status}`);
  }
  for (const status of ANNUAL_ACCOUNT_PAYMENT_STATUSES) {
    assert.ok(table.includes(`'${status}'`), `039 does not know the payment status ${status}`);
  }
  assert.match(table, /payment_status[\s\S]{0,200}'pending', 'paid', 'partially_refunded', 'refunded'/);
});

/* ══════════════════════════════════════════════════════════════
   10-12. THE FROZEN PRODUCT
   ══════════════════════════════════════════════════════════════ */

test("10: the product is the one that was BOUGHT, whatever the catalog says today", () => {
  const view = buildAnnualPlanAccountView(planRow(), schedule());

  assert.equal(view.product.name, "GLOA Matcha Ceremonial");
  assert.equal(view.product.variantLabel, "30 g");
  assert.equal(view.product.sizeGrams, 30);
  assert.equal(view.product.quantityPerDelivery, 1);

  // The catalog is relabelled to 35 g tomorrow. The purchase does not
  // change, because the mapper reads the frozen snapshot and nothing else.
  // Even when the snapshot is the only thing that still knows the label:
  // there is no variant id in the view, so nothing downstream could look
  // one up either.
  assert.equal(view.product.variantLabel, "30 g");
  assert.ok(!JSON.stringify(view).includes("variantId"));
  // catalog_unit_gross_cents is a FROZEN column on the plan - the price
  // the customer would have paid without the annual discount - so the
  // word appears legitimately. What must not appear is a way to reach
  // today's catalog.
  for (const banned of [
    "product_variants", 'from("products")', "useCatalog", "catalogPrice",
    "priceFor", "variant_id", "getVariant",
  ]) {
    assert.ok(!accountCode.includes(banned), `the mapper reads the catalog: ${banned}`);
  }
});

test("11: an unusable item snapshot answers null instead of a plausible guess", () => {
  assert.equal(buildAnnualPlanProduct([]), null);
  assert.equal(buildAnnualPlanProduct(null), null);
  assert.equal(buildAnnualPlanProduct("30 g"), null);
  assert.equal(buildAnnualPlanProduct([{ productName: "   " }]), null);
  assert.equal(buildAnnualPlanProduct([{ variantLabel: "30 g" }]), null);

  // A named product with a missing label is still a product.
  const partial = buildAnnualPlanProduct([{ productName: "GLOA Matcha" }]);
  assert.equal(partial.name, "GLOA Matcha");
  assert.equal(partial.variantLabel, null);
  assert.equal(partial.sizeGrams, null);
  assert.equal(partial.quantityPerDelivery, 1);

  // And the plan still renders without it.
  const view = buildAnnualPlanAccountView(planRow({ delivery_items_snapshot: [] }), schedule());
  assert.equal(view.product, null);
  assert.equal(view.totalGrossCents, 31057);
});

test("12: the discount percent survives PostgREST's numeric-as-string", () => {
  assert.equal(buildAnnualPlanAccountView(planRow({ discount_percent_applied: "10.00" }), []).discountPercentApplied, 10);
  assert.equal(buildAnnualPlanAccountView(planRow({ discount_percent_applied: 12.5 }), []).discountPercentApplied, 12.5);
  assert.equal(buildAnnualPlanAccountView(planRow({ discount_percent_applied: "" }), []).discountPercentApplied, null);
  assert.equal(buildAnnualPlanAccountView(planRow({ discount_percent_applied: "nope" }), []).discountPercentApplied, null);
});

/* ══════════════════════════════════════════════════════════════
   13-15. FAIL CLOSED
   ══════════════════════════════════════════════════════════════ */

test("13: a parent row this mapper cannot describe answers null", () => {
  assert.equal(buildAnnualPlanAccountView(null, schedule()), null);
  assert.equal(buildAnnualPlanAccountView(undefined, schedule()), null);
  assert.equal(buildAnnualPlanAccountView(planRow({ id: "" }), schedule()), null);
  assert.equal(buildAnnualPlanAccountView(planRow({ status: "paused" }), schedule()), null);
  assert.equal(buildAnnualPlanAccountView(planRow({ payment_status: "refund_pending" }), schedule()), null);
  assert.equal(buildAnnualPlanAccountView(planRow({ delivery_count: 0 }), schedule()), null);
  assert.equal(buildAnnualPlanAccountView(planRow({ total_gross_cents: -1 }), schedule()), null);
  assert.equal(buildAnnualPlanAccountView(planRow({ total_gross_cents: "31057" }), schedule()), null);
});

test("14: a schedule that does not match the parent is reported, never fabricated", () => {
  // Nine rows where the plan claims thirteen.
  const short = schedule().slice(0, 9);
  const view = buildAnnualPlanAccountView(planRow(), short);

  assert.equal(view.scheduleComplete, false, "an incomplete schedule looked complete");
  assert.equal(view.deliveries.length, 9, "the mapper padded the schedule");
  assert.equal(view.deliveryCount, 13, "the parent's own count was rewritten");
  assert.equal(view.fulfilledDeliveries, 0);

  // A duplicated delivery number is not a complete schedule either.
  const duplicated = schedule();
  duplicated[12] = { ...duplicated[12], delivery_number: 12 };
  assert.equal(buildAnnualPlanAccountView(planRow(), duplicated).scheduleComplete, false);

  // A missing schedule is empty, not invented.
  const none = buildAnnualPlanAccountView(planRow(), null);
  assert.deepEqual(none.deliveries, []);
  assert.equal(none.nextDelivery, null);
  assert.equal(none.scheduleComplete, false);
});

test("15: deliveries are returned in schedule order, whatever order they arrive in", () => {
  const shuffled = [...schedule(shippedThrough(2))].reverse();
  const view = buildAnnualPlanAccountView(planRow(), shuffled);

  assert.deepEqual(view.deliveries.map(d => d.deliveryNumber),
    Array.from({ length: 13 }, (unused, i) => i + 1));
  assert.equal(view.nextDelivery.deliveryNumber, 3);

  // Ties on the instant are broken by the lower delivery number, so the
  // answer is deterministic rather than dependent on row order.
  const sameInstant = [
    { id: "b", delivery_number: 5, scheduled_for: PURCHASED_AT, state: "scheduled", fulfilled_at: null, order_id: null },
    { id: "a", delivery_number: 4, scheduled_for: PURCHASED_AT, state: "scheduled", fulfilled_at: null, order_id: null },
  ];
  assert.equal(findNextAnnualDelivery({ status: "active", payment_status: "paid" }, sameInstant).delivery_number, 4);
});

/* ══════════════════════════════════════════════════════════════
   16-19. WHAT THE BROWSER MAY SELECT, AND WHAT IT MAY NEVER SEE
   ══════════════════════════════════════════════════════════════ */

test("16: the select lists name their columns and never star", () => {
  for (const [name, select] of [
    ["plan", ANNUAL_PLAN_ACCOUNT_SELECT],
    ["delivery", ANNUAL_PLAN_DELIVERY_ACCOUNT_SELECT],
  ]) {
    assert.ok(!select.includes("*"), `the ${name} select is a star select`);
    const columns = select.split(",").map(c => c.trim());
    assert.ok(columns.length > 0);
    for (const column of columns) {
      assert.match(column, /^[a-z_]+$/, `the ${name} select carries an expression: ${column}`);
    }
  }
  // Every column named actually exists in migration 039's tables.
  const plansTable = m039.slice(
    m039.indexOf("create table public.annual_plans"),
    m039.indexOf("create table public.annual_plan_deliveries")
  );
  const deliveriesTable = m039.slice(m039.indexOf("create table public.annual_plan_deliveries"));
  for (const column of ANNUAL_PLAN_ACCOUNT_SELECT.split(",").map(c => c.trim())) {
    assert.ok(plansTable.includes(column), `annual_plans has no column ${column}`);
  }
  for (const column of ANNUAL_PLAN_DELIVERY_ACCOUNT_SELECT.split(",").map(c => c.trim())) {
    assert.ok(deliveriesTable.includes(column), `annual_plan_deliveries has no column ${column}`);
  }
});

test("17: NO Stripe identity, token or raw snapshot may be selected", () => {
  const forbidden = [
    "stripe_payment_intent_id", "stripe_checkout_session_id", "payment_checkout_attempt_id",
    "purchase_confirmation_email_status", "purchase_confirmation_email_claim_token",
    "purchase_confirmation_email_claimed_at", "purchase_confirmation_email_sent_at",
    "customer_snapshot", "shipping_address_snapshot", "billing_address_snapshot",
    "tax_snapshot", "delivery_tax_snapshot", "user_id", "variant_id",
    "checkout_attempt_id", "claimed_at", "refund_updated_at",
  ];
  for (const column of forbidden) {
    assert.ok(!ANNUAL_PLAN_ACCOUNT_SELECT.includes(column),
      `the plan select exposes ${column}`);
    assert.ok(!ANNUAL_PLAN_DELIVERY_ACCOUNT_SELECT.includes(column),
      `the delivery select exposes ${column}`);
  }
  // delivery_items_snapshot is the ONE snapshot that may be read, because
  // it is what the customer bought.
  assert.ok(ANNUAL_PLAN_ACCOUNT_SELECT.includes("delivery_items_snapshot"));
});

test("18: the serialised view carries no security material, even if a row does", () => {
  // A row that arrived carrying everything, as it would if a future caller
  // used a star select by mistake. None of it may reach the view.
  const contaminated = {
    ...planRow(),
    user_id: "44444444-4444-4444-4444-444444444444",
    stripe_payment_intent_id: "pi_secret_123",
    stripe_checkout_session_id: "cs_test_secret",
    payment_checkout_attempt_id: "aaaa-attempt",
    purchase_confirmation_email_claim_token: "tok_secret",
    purchase_confirmation_email_status: "sent",
    customer_snapshot: { email: "kundin@example.com", name: "Kundin Beispiel" },
    shipping_address_snapshot: { line1: "Teststrasse 1", city: "Berlin" },
    billing_address_snapshot: { line1: "Teststrasse 1" },
    tax_snapshot: { rate: 19 },
    delivery_tax_snapshot: { rate: 7 },
    variant_id: "cccccccc-3333-4333-8333-cccccccccccc",
  };
  const contaminatedDeliveries = schedule(shippedThrough(2)).map(d => ({
    ...d,
    checkout_attempt_id: `attempt-${d.delivery_number}`,
    claimed_at: "2026-01-05T10:00:01.000Z",
  }));

  const serialised = JSON.stringify(buildAnnualPlanAccountView(contaminated, contaminatedDeliveries));

  for (const leak of [
    "pi_secret", "cs_test", "stripe", "payment_intent", "checkout_session", "checkout_attempt",
    "claim_token", "tok_secret", "customer_snapshot", "tax_snapshot",
    "billing_address", "shipping_address", "kundin@example.com", "Teststrasse",
    "44444444-4444", "fingerprint", "claimed_at", "aaaa-attempt",
  ]) {
    assert.ok(!serialised.includes(leak), `the customer view carries ${leak}`);
  }
  // What it DOES carry: the contract, the money and the schedule.
  const view = JSON.parse(serialised);
  assert.equal(view.id, PLAN_ID);
  assert.equal(view.totalGrossCents, 31057);
  assert.equal(view.deliveries.length, 13);
  assert.equal(view.deliveries[0].orderId, "o1");
});

test("19: the delivery view exposes the ordinary order id and nothing else internal", () => {
  const view = buildAnnualPlanAccountView(planRow(), schedule(shippedThrough(1)));
  assert.deepEqual(Object.keys(view.deliveries[0]).sort(),
    ["deliveryNumber", "fulfilledAt", "orderId", "scheduledFor", "state"]);
  // The physical delivery stays an ORDINARY order: the account links to
  // the order page it already has, rather than to a second annual-only
  // representation of the same box.
  assert.equal(view.deliveries[0].orderId, "o1");
  assert.ok(!accountCode.includes("order_number"), "the read model duplicates the order representation");
  assert.ok(!accountCode.includes("order_items"));
});

/* ══════════════════════════════════════════════════════════════
   20-22. WHAT THE MAPPER MAY NOT DO
   ══════════════════════════════════════════════════════════════ */

test("20: the mapper is a leaf and cannot re-price a historical contract", () => {
  assert.ok(!/^import /m.test(read("lib/annualPlanAccount.ts")), "the account mapper gained an import");
  // The frozen money columns legitimately carry the words "shipping" and
  // "tax" in their names. What must not exist is a way to RECOMPUTE any
  // of it, so the scan targets the modules and the functions that price.
  for (const banned of [
    "annualPlanRules", "annualPlanCheckoutRules", "checkoutQuote",
    "./shipping", "./tax", "shippingForCountry", "calculateTax", "taxFor",
    "priceAnnual", "quoteFor", "getSupabaseAdmin", "supabase",
    "ANNUAL_DISCOUNT", "ANNUAL_DELIVERY_INTERVAL_DAYS", "ANNUAL_DELIVERY_COUNT",
  ]) {
    assert.ok(!accountCode.includes(banned), `the account mapper reaches for ${banned}`);
  }
  // No arithmetic on money at all: every cent is passed through.
  for (const banned of ["* 13", "13 *", "/ 100", "Math.round", "Math.floor", "cents +", "cents *"]) {
    assert.ok(!accountCode.includes(banned), `the account mapper computes money: ${banned}`);
  }
});

test("21: the sales feature flag cannot hide a plan somebody already paid for", () => {
  assert.ok(!accountCode.includes("B2C_ANNUAL_PLAN_ENABLED"), "the read model gates history on the sales flag");
  assert.ok(!/process\.env/.test(accountCode), "the read model reads the environment");
  assert.ok(!/import\.meta\.env/.test(accountCode));
  // The flag still lives where it belongs: the checkout path.
  const checkout = read("lib/annualPlanCheckoutRules.ts") + read("lib/annualPlans.ts");
  assert.ok(checkout.includes("B2C_ANNUAL_PLAN_ENABLED"), "the sales flag left the checkout path");
});

test("22: only purchased plans belong in the account list", () => {
  assert.equal(isPurchasedAnnualPlanRow(planRow()), true);
  assert.equal(isPurchasedAnnualPlanRow(planRow({ purchased_at: null })), false);
  assert.equal(isPurchasedAnnualPlanRow(planRow({ purchased_at: "   " })), false);
  assert.equal(isPurchasedAnnualPlanRow(null), false);
  assert.equal(isPurchasedAnnualPlanRow(undefined), false);
  assert.equal(isPurchasedAnnualPlanRow({}), false);
  // An abandoned checkout leaves a pending row. It is not a contract.
  assert.equal(
    isPurchasedAnnualPlanRow({ status: "pending", purchased_at: null }),
    false
  );
});

/* ══════════════════════════════════════════════════════════════
   23-25. THE POST-CHECKOUT RETURN
   ══════════════════════════════════════════════════════════════ */

const PLAN_B = "dddddddd-4444-4444-8444-dddddddddddd";

const returnRow = (over = {}) => ({
  id: PLAN_ID,
  status: "active",
  payment_status: "paid",
  purchased_at: PURCHASED_AT,
  ...over,
});

test("23: the return state describes THE NAMED PLAN, and only it", () => {
  const target = { targetAnnualPlanId: PLAN_ID };

  // A plan created but not yet activated: the money is settling.
  assert.equal(
    resolveAnnualCheckoutReturnState({
      ...target,
      plans: [returnRow({ status: "pending", payment_status: "pending", purchased_at: null })],
    }),
    "processing"
  );
  // Purchased and live.
  assert.equal(resolveAnnualCheckoutReturnState({ ...target, plans: [returnRow()] }), "active");
  // An extraordinary delayed return onto a finished plan: truthful,
  // rather than squeezed into "active".
  assert.equal(
    resolveAnnualCheckoutReturnState({ ...target, plans: [returnRow({ status: "completed" })] }),
    "completed"
  );
  // Fully refunded is NEVER reported as a successful purchase.
  assert.equal(
    resolveAnnualCheckoutReturnState({ ...target, plans: [returnRow({ payment_status: "refunded" })] }),
    "refunded"
  );
  // A partial refund is still a live contract.
  assert.equal(
    resolveAnnualCheckoutReturnState({ ...target, plans: [returnRow({ payment_status: "partially_refunded" })] }),
    "active"
  );
  assert.equal(
    resolveAnnualCheckoutReturnState({ ...target, plans: [returnRow({ status: "cancelled" })] }),
    "ended"
  );
});

test("24: a missing, malformed or unknown target answers the same neutral 'none'", () => {
  for (const targetAnnualPlanId of [null, undefined, "", "   ", "not-a-uuid", PLAN_B]) {
    assert.equal(
      resolveAnnualCheckoutReturnState({ targetAnnualPlanId, plans: [returnRow()] }),
      "none",
      `target ${String(targetAnnualPlanId)} was resolved`
    );
  }
  // No rows at all is the same answer as a stranger's id: the account
  // cannot tell a customer whether somebody else's plan exists, because
  // RLS returned nothing in either case.
  assert.equal(resolveAnnualCheckoutReturnState({ targetAnnualPlanId: PLAN_ID, plans: [] }), "none");
  assert.equal(resolveAnnualCheckoutReturnState({ targetAnnualPlanId: PLAN_ID, plans: null }), "none");
  assert.equal(resolveAnnualCheckoutReturnState({ targetAnnualPlanId: PLAN_ID, plans: undefined }), "none");
  assert.equal(resolveAnnualCheckoutReturnState({}), "none");
});

test("25: an OLD active plan can never make a NEW pending plan look paid", () => {
  // The regression this phase exists for. Plan A was bought months ago
  // and is running; plan B was created by the checkout the customer is
  // returning from right now.
  const planA = returnRow({ id: PLAN_ID, status: "active", purchased_at: "2025-03-01T10:00:00.000Z" });
  const planB = returnRow({ id: PLAN_B, status: "pending", payment_status: "pending", purchased_at: null });

  assert.equal(
    resolveAnnualCheckoutReturnState({ targetAnnualPlanId: PLAN_B, plans: [planA, planB] }),
    "processing",
    "an older plan answered for a brand-new checkout"
  );
  // Row order must not matter either.
  assert.equal(
    resolveAnnualCheckoutReturnState({ targetAnnualPlanId: PLAN_B, plans: [planB, planA] }),
    "processing"
  );
  // Once B genuinely activates, B says so - and A still has no say.
  assert.equal(
    resolveAnnualCheckoutReturnState({
      targetAnnualPlanId: PLAN_B,
      plans: [planA, { ...planB, status: "active", payment_status: "paid", purchased_at: "2026-09-01T08:00:00.000Z" }],
    }),
    "active"
  );
  // And asking about A still answers for A.
  assert.equal(
    resolveAnnualCheckoutReturnState({ targetAnnualPlanId: PLAN_ID, plans: [planA, planB] }),
    "active"
  );
});

test("26: two checkouts open at once resolve independently, with no heuristic", () => {
  const first = returnRow({ id: PLAN_ID, status: "pending", payment_status: "pending", purchased_at: null });
  const second = returnRow({ id: PLAN_B, status: "pending", payment_status: "pending", purchased_at: null });

  assert.equal(
    resolveAnnualCheckoutReturnState({ targetAnnualPlanId: PLAN_B, plans: [first, second] }),
    "processing"
  );
  // Now the SECOND one settles. Returning from the first must still say
  // processing: it is a different contract.
  const settled = { ...second, status: "active", payment_status: "paid", purchased_at: "2026-09-01T08:00:00.000Z" };
  assert.equal(
    resolveAnnualCheckoutReturnState({ targetAnnualPlanId: PLAN_ID, plans: [first, settled] }),
    "processing"
  );
  assert.equal(
    resolveAnnualCheckoutReturnState({ targetAnnualPlanId: PLAN_B, plans: [first, settled] }),
    "active"
  );

  // No "latest row", no purchased_at ordering, no amount or SKU matching.
  const resolver = accountCode.slice(accountCode.indexOf("export function resolveAnnualCheckoutReturnState"));
  for (const banned of [
    "sort", "reduce", "slice", "purchased_at >", "Math.max", "total_gross_cents",
    "sku", "amount", "[0]", "at(-1)", "pop()",
  ]) {
    assert.ok(!resolver.includes(banned), `the resolver guesses with ${banned}`);
  }
  assert.ok(resolver.includes("rows.find(row => typeof row?.id === \"string\" && row.id === target)"));
});

test("27: a status word alone cannot promote a plan, and neither can the URL", () => {
  // The dangerous shape: a row claiming to be active that was never paid
  // for. It is reported as still settling, never as a held contract.
  assert.equal(
    resolveAnnualCheckoutReturnState({
      targetAnnualPlanId: PLAN_ID,
      plans: [returnRow({ status: "active", purchased_at: null })],
    }),
    "processing"
  );
  assert.equal(
    resolveAnnualCheckoutReturnState({
      targetAnnualPlanId: PLAN_ID,
      plans: [returnRow({ status: "completed", purchased_at: "" })],
    }),
    "processing"
  );
  // Migration 039 refuses that row anyway.
  assert.match(m039, /annual_plans_running_requires_purchase_check/);

  // The resolver takes an id and rows. There is nothing else it could be
  // handed - no session, no PaymentIntent, no amount, no query string.
  const resolver = accountCode.slice(accountCode.indexOf("export function resolveAnnualCheckoutReturnState"));
  for (const banned of [
    "annual=processing", "annual=cancelled", "searchParams", "URLSearchParams", "location",
    "window", "sessionId", "session_id", "paymentIntent", "payment_intent", "stripe", "fetch(",
  ]) {
    assert.ok(!resolver.includes(banned), `the resolver accepts ${banned} from the browser`);
  }
});

test("28: the return URLs carry the LOCAL plan id and nothing else", () => {
  const checkout = read("lib/annualPlanCheckout.ts");
  assert.ok(checkout.includes(
    "success_url: `${origin}/account?annual=processing&annualPlanId=${encodeURIComponent(annualPlanId)}`"
  ));
  assert.ok(checkout.includes(
    "cancel_url: `${origin}/account?annual=cancelled&annualPlanId=${encodeURIComponent(annualPlanId)}`"
  ));
  assert.equal(ANNUAL_CHECKOUT_RETURN_PARAM, "annualPlanId");
  // The value is the LOCAL row created before Stripe was contacted - the
  // same id the session metadata already carries.
  assert.ok(checkout.includes("annualPlanId,"));
  // Nothing that could be mistaken for payment proof travels in a URL.
  const urls = [...checkout.matchAll(/(?:success|cancel)_url: `[^`]*`/g)].map(m => m[0]);
  assert.equal(urls.length, 2);
  for (const url of urls) {
    for (const leak of [
      "payment_intent", "paymentIntent", "session.id", "CHECKOUT_SESSION_ID",
      "email", "requestId", "fingerprint", "token", "amount", "total",
    ]) {
      assert.ok(!url.includes(leak), `a return URL carries ${leak}`);
    }
  }
});

/* ══════════════════════════════════════════════════════════════
   29-31. OWNERSHIP, AND THE BOUNDARY
   ══════════════════════════════════════════════════════════════ */

test("29: ownership is enforced by RLS in Postgres, not by this module", () => {
  // The account reads its own rows with the USER'S client, exactly as the
  // portal already reads orders and subscriptions. Both policies scope to
  // the signed-in user, and a wrong id therefore returns ZERO ROWS - the
  // same answer as an id that never existed, so no existence leaks.
  assert.match(m039, /alter table public\.annual_plans\s+enable row level security;/);
  assert.match(m039, /alter table public\.annual_plan_deliveries enable row level security;/);
  assert.match(m039, /create policy "Users read own annual plans"[\s\S]{0,200}using \(auth\.uid\(\) = user_id\)/);
  assert.match(m039, /create policy "Users read own annual plan deliveries"[\s\S]{0,400}p\.user_id = auth\.uid\(\)/);
  // authenticated may only SELECT; anon holds nothing at all.
  assert.match(m039, /grant select on table public\.annual_plans\s+to authenticated;/);
  assert.match(m039, /revoke all privileges on table public\.annual_plans\s+from anon, authenticated, service_role;/);
  const grants = [...m039.matchAll(/grant [a-z, ()_]+ on table public\.annual_plan[a-z_]* +to ([a-z_]+);/g)]
    .map(m => m[1]);
  assert.ok(!grants.includes("anon"), "anon was granted access to a prepaid contract");
  for (const write of ["for insert", "for update", "for delete"]) {
    assert.ok(!m039.includes(`on public.annual_plans ${write}`), `a browser write policy exists: ${write}`);
  }
  // And this module holds no client of its own to bypass any of it.
  assert.ok(!accountCode.includes("service_role"));
  assert.ok(!accountCode.includes("getSupabaseAdmin"));
});

test("30: the account architecture stays as it is: no endpoint, no portal redesign", () => {
  // PHASE 4B8.1 added exactly one migration, and it grants privileges
  // only - no table, no column, no function, no policy, no row.
  const migrations = readdirSync(path.join(ROOT, "supabase/migrations"))
    .filter(f => f.endsWith(".sql")).sort();
  assert.equal(migrations.length, 41);
  assert.equal(migrations[40], "041_annual_account_column_privileges.sql");
  assert.deepEqual(migrations.filter(f => Number(f.slice(0, 3)) > 41), [], "a 042 appeared");

  // The API surface is unchanged: no account endpoint exists, because the
  // portal reads its own rows under RLS.
  const apiDirs = [];
  const walk = dir => {
    for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      if (entry.isDirectory()) walk(dir + "/" + entry.name);
      else if (entry.name === "route.ts") apiDirs.push(dir.replace("app/api", ""));
    }
  };
  walk("app/api");
  assert.deepEqual(apiDirs.sort(), [
    "/annual-plan/checkout/session",
    "/checkout/quote",
    "/checkout/session",
    "/contact",
    "/cron/retry-order-notifications",
    "/internal/orders/cancel",
    "/internal/orders/cancellation-request/resolve",
    "/internal/orders/ship",
    "/orders/cancellation-request",
    "/orders/success",
    "/stripe/webhook",
    "/subscriptions/cancel",
    "/subscriptions/checkout/session",
    "/withdrawal",
  ], "the API surface changed in a read-model phase");
});

test("31: the account portal was not redesigned by this phase", () => {
  // The read model exists to be wired up by the UI phase that follows.
  // Nothing in this one renders it, and the portal's existing reads are
  // untouched.
  const portal = read("app/AccountPortal.tsx");
  assert.ok(!portal.includes("annualPlanAccount"), "the portal was wired up in a read-model phase");
  assert.ok(!portal.includes("ANNUAL_PLAN_ACCOUNT_SELECT"));
  // Its established pattern - the user's own client, named column lists -
  // is what this module is shaped for.
  assert.ok(portal.includes("const SUBSCRIPTION_SELECT"));
  assert.match(portal, /import \{ supabase \} from "\.\.\/lib\/supabase"/);
});
