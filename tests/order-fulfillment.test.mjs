import assert from "node:assert/strict";
import test from "node:test";
import { getActiveVariantBySku, getReadOnlySupabaseClient } from "./helpers/catalog.mjs";
import { getAdminSupabaseClient } from "./helpers/supabaseAdmin.mjs";

// DB-level tests for create_order_from_paid_checkout (migrations
// 011/012/013).
//
// These migrations are NOT auto-applied (see task 18/19 scope) - until a
// human runs them in the Supabase SQL Editor, the 5-arg RPC function
// (checkout_attempt_id, customer_snapshot, payment_intent_id,
// shipping_address_snapshot, billing_address_snapshot) does not exist
// yet. Every test below detects that up front and skips with a clear
// message instead of failing, so `npm test` stays green whether or not
// the migrations have been applied yet.

let admin;
let variant;
let migrationApplied = true;
let skipReason = "";

const createdAttemptIds = [];
const createdUserIds = [];

// Synthetic test data only - never a real person's address.
const SYNTHETIC_SHIPPING = {
  name: "Max Mustermann",
  company: null,
  line1: "Musterstraße 1",
  line2: null,
  city: "Berlin",
  postalCode: "10115",
  state: null,
  country: "DE",
};

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

async function seedPaidAttempt(v, { quantity = 1, status = "paid", userId = null } = {}) {
  const requestId = crypto.randomUUID();
  const itemsSnapshot = fakeItemsSnapshot(v, quantity);
  const expectedTotal = itemsSnapshot.reduce((sum, i) => sum + i.lineGrossCents, 0);

  const { data, error } = await admin
    .from("checkout_attempts")
    .insert({
      request_id: requestId,
      user_id: userId,
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

function callRpc(attemptId, overrides = {}) {
  return admin.rpc("create_order_from_paid_checkout", {
    p_checkout_attempt_id: attemptId,
    p_customer_snapshot: { email: null, name: null },
    p_stripe_payment_intent_id: null,
    p_shipping_address_snapshot: null,
    p_billing_address_snapshot: null,
    ...overrides,
  });
}

test.before(async () => {
  admin = getAdminSupabaseClient();
  variant = await getActiveVariantBySku("GLOA-MATCHA-30G");

  // Cheap existence probe for the migration-013 (5-arg) RPC signature.
  // An unknown-attempt error means the function exists and ran; a
  // "could not find function" / missing-overload error means it doesn't.
  const probe = await callRpc("00000000-0000-0000-0000-000000000000");
  if (probe.error && /could not find|does not exist|schema cache/i.test(probe.error.message)) {
    migrationApplied = false;
    skipReason = `Migration 013 not applied yet (${probe.error.message}). Run supabase/migrations/011..013, then re-run tests.`;
  }
});

test.after(async () => {
  if (admin && createdAttemptIds.length > 0) {
    // Best-effort cleanup: delete any orders/order_items created from our
    // seeded attempts, then the attempts themselves.
    const { data: orders } = await admin.from("orders").select("id").in("checkout_attempt_id", createdAttemptIds);
    const orderIds = (orders ?? []).map(o => o.id);
    if (orderIds.length > 0) {
      await admin.from("order_items").delete().in("order_id", orderIds);
      await admin.from("orders").delete().in("id", orderIds);
    }
    await admin.from("checkout_attempts").delete().in("id", createdAttemptIds);
  }
  for (const id of createdUserIds) {
    await admin.auth.admin.deleteUser(id).catch(() => {});
  }
});

test("create_order_from_paid_checkout: a paid attempt produces exactly one order with matching items", async (t) => {
  if (!migrationApplied) return t.skip(skipReason);

  const { id: attemptId, expectedTotal, itemsSnapshot } = await seedPaidAttempt(variant, { quantity: 2 });

  const { data, error } = await callRpc(attemptId, { p_customer_snapshot: { email: "test@example.com", name: null } });

  assert.equal(error, null, error?.message);
  const order = Array.isArray(data) ? data[0] : data;
  assert.ok(order.id);
  assert.match(order.order_number, /^GLOA-\d{4}-\d{6}$/);
  assert.equal(order.total_gross_cents, expectedTotal);
  assert.equal(order.subtotal_gross_cents, expectedTotal);
  assert.equal(order.payment_status, "paid");
  assert.equal(order.checkout_attempt_id, attemptId);
  // Net/tax/shipping are genuinely unknown at this stage - never fabricated
  // as 0. This exact null-heavy shape is real and reaches the account UI -
  // app/AccountPortal.tsx's OrderDetail must render it without crashing
  // (it once did: TypeError reading 'first_name' off a null address
  // snapshot; see the "fix: load authenticated order details" commit).
  assert.equal(order.subtotal_net_cents, null);
  assert.equal(order.shipping_net_cents, null);
  assert.equal(order.shipping_gross_cents, null);
  assert.equal(order.tax_total_cents, null);
  assert.equal(order.total_net_cents, null);
  // No shipping/billing snapshot was passed for this attempt either.
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

test("create_order_from_paid_checkout: a real shipping address snapshot is stored as-is", async (t) => {
  if (!migrationApplied) return t.skip(skipReason);

  const { id: attemptId } = await seedPaidAttempt(variant, { quantity: 1 });

  const { data, error } = await callRpc(attemptId, { p_shipping_address_snapshot: SYNTHETIC_SHIPPING });
  assert.equal(error, null, error?.message);
  const order = Array.isArray(data) ? data[0] : data;
  assert.deepEqual(order.shipping_address_snapshot, SYNTHETIC_SHIPPING);
  // Never split into street/house_number - Stripe's line1 stays whole.
  assert.equal(order.shipping_address_snapshot.line1, "Musterstraße 1");
});

test("create_order_from_paid_checkout: guest order (user_id null) can still have a shipping snapshot", async (t) => {
  if (!migrationApplied) return t.skip(skipReason);

  const { id: attemptId } = await seedPaidAttempt(variant, { quantity: 1, userId: null });

  const { data, error } = await callRpc(attemptId, { p_shipping_address_snapshot: SYNTHETIC_SHIPPING });
  assert.equal(error, null, error?.message);
  const order = Array.isArray(data) ? data[0] : data;
  assert.equal(order.user_id, null);
  assert.deepEqual(order.shipping_address_snapshot, SYNTHETIC_SHIPPING);
});

test("create_order_from_paid_checkout: called twice for the same attempt still yields exactly one order", async (t) => {
  if (!migrationApplied) return t.skip(skipReason);

  const { id: attemptId } = await seedPaidAttempt(variant, { quantity: 1 });

  const first = await callRpc(attemptId, { p_stripe_payment_intent_id: "pi_test_first" });
  const second = await callRpc(attemptId, { p_stripe_payment_intent_id: "pi_test_second" });

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

test("create_order_from_paid_checkout: a retry with different snapshot data never overwrites the original snapshots", async (t) => {
  if (!migrationApplied) return t.skip(skipReason);

  const { id: attemptId } = await seedPaidAttempt(variant, { quantity: 1 });

  const first = await callRpc(attemptId, {
    p_customer_snapshot: { email: "first@example.invalid", name: "First Name" },
    p_shipping_address_snapshot: SYNTHETIC_SHIPPING,
  });
  assert.equal(first.error, null, first.error?.message);

  const differentShipping = { ...SYNTHETIC_SHIPPING, name: "Someone Else", city: "Hamburg" };
  const second = await callRpc(attemptId, {
    p_customer_snapshot: { email: "second@example.invalid", name: "Second Name" },
    p_shipping_address_snapshot: differentShipping,
  });
  assert.equal(second.error, null, second.error?.message);

  const { data: order, error } = await admin
    .from("orders")
    .select("customer_snapshot, shipping_address_snapshot")
    .eq("checkout_attempt_id", attemptId)
    .single();
  assert.equal(error, null, error?.message);
  assert.deepEqual(order.customer_snapshot, { email: "first@example.invalid", name: "First Name" });
  assert.deepEqual(order.shipping_address_snapshot, SYNTHETIC_SHIPPING);
});

test("create_order_from_paid_checkout: an unpaid attempt is rejected and creates no order", async (t) => {
  if (!migrationApplied) return t.skip(skipReason);

  const { id: attemptId } = await seedPaidAttempt(variant, { quantity: 1, status: "created" });

  const { error } = await callRpc(attemptId);

  assert.ok(error, "expected an error for a non-paid checkout attempt");

  const { data: orders } = await admin.from("orders").select("id").eq("checkout_attempt_id", attemptId);
  assert.equal(orders.length, 0);
});

test("create_order_from_paid_checkout: an unknown checkout attempt is rejected", async (t) => {
  if (!migrationApplied) return t.skip(skipReason);

  const { error } = await callRpc("00000000-0000-0000-0000-000000000000");

  assert.ok(error, "expected an error for an unknown checkout attempt id");
});

test("orders/order_items: anonymous (unauthenticated) access is denied by grants/RLS", async (t) => {
  if (!migrationApplied) return t.skip(skipReason);

  const { id: attemptId } = await seedPaidAttempt(variant, { quantity: 1 });
  const { data } = await callRpc(attemptId);
  const order = Array.isArray(data) ? data[0] : data;

  const anon = getReadOnlySupabaseClient();
  const { data: foreignRead, error } = await anon.from("orders").select("id").eq("id", order.id).maybeSingle();
  // Either an explicit permission error, or RLS silently returning nothing -
  // either way, no order data must be visible to an unauthenticated client.
  assert.ok(error || !foreignRead, "an unauthenticated client must not be able to read another customer's order");
});

test("order shipping snapshot: independent of the account's current address book (no live FK)", async (t) => {
  if (!migrationApplied) return t.skip(skipReason);

  const email = `gloa-snapshot-test-${crypto.randomUUID()}@example.invalid`;
  const password = `${crypto.randomUUID()}Aa1!`;
  const { data: created, error: createErr } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  assert.equal(createErr, null, createErr?.message);
  createdUserIds.push(created.user.id);

  const { id: attemptId } = await seedPaidAttempt(variant, { quantity: 1, userId: created.user.id });
  const { data, error } = await callRpc(attemptId, { p_shipping_address_snapshot: SYNTHETIC_SHIPPING });
  assert.equal(error, null, error?.message);
  const order = Array.isArray(data) ? data[0] : data;

  // Now change the account's address book after the order was created.
  const { error: addrErr } = await admin.from("addresses").insert({
    user_id: created.user.id,
    first_name: "Changed",
    last_name: "Later",
    street: "Andere Straße",
    house_number: "9",
    zip: "20095",
    city: "Hamburg",
    country: "Deutschland",
    is_default_shipping: true,
    is_default_billing: true,
  });
  assert.equal(addrErr, null, addrErr?.message);

  const { data: reread, error: rereadErr } = await admin
    .from("orders")
    .select("shipping_address_snapshot")
    .eq("id", order.id)
    .single();
  assert.equal(rereadErr, null, rereadErr?.message);
  // The historical order snapshot must be completely unaffected.
  assert.deepEqual(reread.shipping_address_snapshot, SYNTHETIC_SHIPPING);

  await admin.from("addresses").delete().eq("user_id", created.user.id);
});
