import assert from "node:assert/strict";
import test from "node:test";
import { getActiveVariantBySku, getReadOnlySupabaseClient } from "./helpers/catalog.mjs";
import { getAdminSupabaseClient } from "./helpers/supabaseAdmin.mjs";

// DB-level tests for create_order_from_paid_checkout (migration 011).
//
// Migration 011 is NOT auto-applied (see task 18 scope) - until a human
// runs it in the Supabase SQL Editor, orders.checkout_attempt_id and the
// RPC function do not exist yet. Every test below detects that up front
// and skips with a clear message instead of failing, so `npm test` stays
// green both before and after the migration is applied.

let admin;
let variant;
let migrationApplied = true;
let skipReason = "";

const createdAttemptIds = [];

function fakeItemsSnapshot(v, quantity = 1) {
  return [
    {
      variantId: v.id,
      sku: v.sku,
      productName: "GLOA Matcha",
      variantLabel: v.label,
      sizeGrams: v.size_grams,
      quantity,
      unitGrossCents: v.price_gross_cents,
      lineGrossCents: v.price_gross_cents * quantity,
      currency: v.currency,
    },
  ];
}

async function seedPaidAttempt(v, { quantity = 1, status = "paid" } = {}) {
  const requestId = crypto.randomUUID();
  const itemsSnapshot = fakeItemsSnapshot(v, quantity);
  const expectedTotal = itemsSnapshot.reduce((sum, i) => sum + i.lineGrossCents, 0);

  const { data, error } = await admin
    .from("checkout_attempts")
    .insert({
      request_id: requestId,
      status,
      currency: v.currency,
      expected_total_gross_cents: expectedTotal,
      items_snapshot: itemsSnapshot,
      paid_at: status === "paid" ? new Date().toISOString() : null,
    })
    .select("id")
    .single();

  if (error) throw new Error(`test setup: failed to seed checkout_attempts row: ${error.message}`);
  createdAttemptIds.push(data.id);
  return { id: data.id, expectedTotal, itemsSnapshot };
}

test.before(async () => {
  admin = getAdminSupabaseClient();
  variant = await getActiveVariantBySku("GLOA-MATCHA-30G");

  // Cheap existence probe for the migration-011 schema.
  const probe = await admin.from("orders").select("checkout_attempt_id").limit(1);
  if (probe.error) {
    migrationApplied = false;
    skipReason = `Migration 011 not applied yet (${probe.error.message}). Run supabase/migrations/011_orders_from_paid_checkout.sql, then re-run tests.`;
  }
});

test.after(async () => {
  if (!admin || createdAttemptIds.length === 0) return;
  // Best-effort cleanup: delete any orders/order_items created from our
  // seeded attempts, then the attempts themselves.
  const { data: orders } = await admin.from("orders").select("id").in("checkout_attempt_id", createdAttemptIds);
  const orderIds = (orders ?? []).map(o => o.id);
  if (orderIds.length > 0) {
    await admin.from("order_items").delete().in("order_id", orderIds);
    await admin.from("orders").delete().in("id", orderIds);
  }
  await admin.from("checkout_attempts").delete().in("id", createdAttemptIds);
});

test("create_order_from_paid_checkout: a paid attempt produces exactly one order with matching items", async (t) => {
  if (!migrationApplied) return t.skip(skipReason);

  const { id: attemptId, expectedTotal, itemsSnapshot } = await seedPaidAttempt(variant, { quantity: 2 });

  const { data, error } = await admin.rpc("create_order_from_paid_checkout", {
    p_checkout_attempt_id: attemptId,
    p_customer_snapshot: { email: "test@example.com", name: null },
    p_stripe_payment_intent_id: null,
  });

  assert.equal(error, null, error?.message);
  const order = Array.isArray(data) ? data[0] : data;
  assert.ok(order.id);
  assert.match(order.order_number, /^GLOA-\d{4}-\d{6}$/);
  assert.equal(order.total_gross_cents, expectedTotal);
  assert.equal(order.subtotal_gross_cents, expectedTotal);
  assert.equal(order.payment_status, "paid");
  assert.equal(order.checkout_attempt_id, attemptId);
  // Net/tax/shipping are genuinely unknown at this stage - never fabricated as 0.
  assert.equal(order.subtotal_net_cents, null);
  assert.equal(order.shipping_net_cents, null);
  assert.equal(order.shipping_gross_cents, null);
  assert.equal(order.tax_total_cents, null);
  assert.equal(order.total_net_cents, null);
  assert.equal(order.shipping_address_snapshot, null);
  assert.equal(order.billing_address_snapshot, null);

  const { data: items, error: itemsError } = await admin
    .from("order_items")
    .select("*")
    .eq("order_id", order.id);
  assert.equal(itemsError, null, itemsError?.message);
  assert.equal(items.length, itemsSnapshot.length);
  assert.equal(items[0].sku, itemsSnapshot[0].sku);
  assert.equal(items[0].quantity, itemsSnapshot[0].quantity);
  assert.equal(items[0].unit_price_gross_cents, itemsSnapshot[0].unitGrossCents);
  assert.equal(items[0].line_total_gross_cents, itemsSnapshot[0].lineGrossCents);
  // Never fabricated - net price/tax split is not decided yet.
  assert.equal(items[0].unit_price_net_cents, null);
  assert.equal(items[0].line_total_net_cents, null);
});

test("create_order_from_paid_checkout: called twice for the same attempt still yields exactly one order", async (t) => {
  if (!migrationApplied) return t.skip(skipReason);

  const { id: attemptId } = await seedPaidAttempt(variant, { quantity: 1 });

  const first = await admin.rpc("create_order_from_paid_checkout", {
    p_checkout_attempt_id: attemptId,
    p_customer_snapshot: { email: null, name: null },
    p_stripe_payment_intent_id: "pi_test_first",
  });
  const second = await admin.rpc("create_order_from_paid_checkout", {
    p_checkout_attempt_id: attemptId,
    p_customer_snapshot: { email: null, name: null },
    p_stripe_payment_intent_id: "pi_test_second",
  });

  assert.equal(first.error, null, first.error?.message);
  assert.equal(second.error, null, second.error?.message);
  const firstOrder = Array.isArray(first.data) ? first.data[0] : first.data;
  const secondOrder = Array.isArray(second.data) ? second.data[0] : second.data;
  assert.equal(firstOrder.id, secondOrder.id);
  // The second call must not have overwritten the first payment intent.
  assert.equal(secondOrder.stripe_payment_intent_id, "pi_test_first");

  const { data: orders, error } = await admin.from("orders").select("id").eq("checkout_attempt_id", attemptId);
  assert.equal(error, null, error?.message);
  assert.equal(orders.length, 1);
});

test("create_order_from_paid_checkout: an unpaid attempt is rejected and creates no order", async (t) => {
  if (!migrationApplied) return t.skip(skipReason);

  const { id: attemptId } = await seedPaidAttempt(variant, { quantity: 1, status: "created" });

  const { error } = await admin.rpc("create_order_from_paid_checkout", {
    p_checkout_attempt_id: attemptId,
    p_customer_snapshot: { email: null, name: null },
    p_stripe_payment_intent_id: null,
  });

  assert.ok(error, "expected an error for a non-paid checkout attempt");

  const { data: orders } = await admin.from("orders").select("id").eq("checkout_attempt_id", attemptId);
  assert.equal(orders.length, 0);
});

test("create_order_from_paid_checkout: an unknown checkout attempt is rejected", async (t) => {
  if (!migrationApplied) return t.skip(skipReason);

  const { error } = await admin.rpc("create_order_from_paid_checkout", {
    p_checkout_attempt_id: "00000000-0000-0000-0000-000000000000",
    p_customer_snapshot: { email: null, name: null },
    p_stripe_payment_intent_id: null,
  });

  assert.ok(error, "expected an error for an unknown checkout attempt id");
});

test("orders/order_items: anonymous (unauthenticated) access is denied by grants/RLS", async (t) => {
  if (!migrationApplied) return t.skip(skipReason);

  const { id: attemptId } = await seedPaidAttempt(variant, { quantity: 1 });
  const { data } = await admin.rpc("create_order_from_paid_checkout", {
    p_checkout_attempt_id: attemptId,
    p_customer_snapshot: { email: null, name: null },
    p_stripe_payment_intent_id: null,
  });
  const order = Array.isArray(data) ? data[0] : data;

  const anon = getReadOnlySupabaseClient();
  const { data: foreignRead, error } = await anon.from("orders").select("id").eq("id", order.id).maybeSingle();
  // Either an explicit permission error, or RLS silently returning nothing -
  // either way, no order data must be visible to an unauthenticated client.
  assert.ok(error || !foreignRead, "an unauthenticated client must not be able to read another customer's order");
});
