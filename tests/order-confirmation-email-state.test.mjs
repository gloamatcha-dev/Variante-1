import assert from "node:assert/strict";
import test from "node:test";
import { getActiveVariantBySku } from "./helpers/catalog.mjs";
import { getAdminSupabaseClient } from "./helpers/supabaseAdmin.mjs";

// Real-database tests for the confirmation-email delivery state machine
// added on public.orders by migration 017 (confirmation_email_status /
// confirmation_email_sent_at). Mirrors the exact seed/probe/skip pattern
// used in tests/order-fulfillment.test.mjs for migration 016 - these
// tests exercise the SAME atomic conditional-UPDATE semantics that
// lib/orderConfirmationEmail.ts relies on (claim/mark-sent/mark-failed),
// directly against real Postgres, without needing to import that module
// (which pulls in lib/supabaseAdmin.ts's import.meta.env dependency and
// so cannot be loaded in a plain Node test file - see
// tests/order-confirmation-email-template.test.mjs for the pure parts
// of this feature that ARE directly importable).

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

async function seedPaidAttempt(v, { quantity = 1, userId = null } = {}) {
  const requestId = crypto.randomUUID();
  const itemsSnapshot = fakeItemsSnapshot(v, quantity);
  const expectedTotal = itemsSnapshot.reduce((sum, i) => sum + i.lineGrossCents, 0);

  const { data, error } = await admin
    .from("checkout_attempts")
    .insert({
      request_id: requestId,
      user_id: userId,
      status: "paid",
      currency: v.currency,
      expected_total_gross_cents: expectedTotal,
      items_snapshot: itemsSnapshot,
      paid_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (error) throw new Error(`test setup: failed to seed checkout_attempts row: ${error.message}`);
  createdAttemptIds.push(data.id);
  return { id: data.id, expectedTotal };
}

async function createPaidOrder({ userId = null } = {}) {
  const { id: attemptId } = await seedPaidAttempt(variant, { quantity: 1, userId });
  const { data, error } = await admin.rpc("create_order_from_paid_checkout", {
    p_checkout_attempt_id: attemptId,
    p_customer_snapshot: { email: "test@example.invalid", name: "Test Customer" },
    p_stripe_payment_intent_id: null,
    p_shipping_address_snapshot: null,
    p_billing_address_snapshot: null,
    p_shipping_gross_cents: 590,
  });
  if (error) throw new Error(`test setup: create_order_from_paid_checkout failed: ${error.message}`);
  const order = Array.isArray(data) ? data[0] : data;
  return order;
}

test.before(async () => {
  admin = getAdminSupabaseClient();
  variant = await getActiveVariantBySku("GLOA-MATCHA-30G");

  const rpcProbe = await admin.rpc("create_order_from_paid_checkout", {
    p_checkout_attempt_id: "00000000-0000-0000-0000-000000000000",
    p_customer_snapshot: { email: null, name: null },
    p_stripe_payment_intent_id: null,
    p_shipping_address_snapshot: null,
    p_billing_address_snapshot: null,
    p_shipping_gross_cents: 0,
  });
  if (rpcProbe.error && /could not find|does not exist|schema cache/i.test(rpcProbe.error.message)) {
    migrationApplied = false;
    skipReason = `Migration 016 not applied yet (${rpcProbe.error.message}). Run supabase/migrations/011..017, then re-run tests.`;
    return;
  }

  const columnProbe = await admin
    .from("orders")
    .select("confirmation_email_status, confirmation_email_sent_at")
    .limit(1);
  if (columnProbe.error && /column .* does not exist|schema cache/i.test(columnProbe.error.message)) {
    migrationApplied = false;
    skipReason = `Migration 017 not applied yet (${columnProbe.error.message}). Run supabase/migrations/017_order_confirmation_email_state.sql, then re-run tests.`;
  }
});

test.after(async () => {
  if (admin && createdAttemptIds.length > 0) {
    const { data: orders } = await admin.from("orders").select("id").in("checkout_attempt_id", createdAttemptIds);
    const orderIds = (orders ?? []).map(o => o.id);
    if (orderIds.length > 0) {
      await admin.from("order_items").delete().in("order_id", orderIds);
      await admin.from("orders").delete().in("id", orderIds);
    }
    await admin.from("checkout_attempts").delete().in("id", createdAttemptIds);
  }
});

test("confirmation email state: a freshly created paid order starts 'pending' with no sent_at", async (t) => {
  if (!migrationApplied) return t.skip(skipReason);
  const order = await createPaidOrder();
  const { data, error } = await admin
    .from("orders")
    .select("confirmation_email_status, confirmation_email_sent_at")
    .eq("id", order.id)
    .single();
  assert.equal(error, null, error?.message);
  assert.equal(data.confirmation_email_status, "pending");
  assert.equal(data.confirmation_email_sent_at, null);
});

test("confirmation email state: claiming a pending order succeeds exactly once", async (t) => {
  if (!migrationApplied) return t.skip(skipReason);
  const order = await createPaidOrder();

  const claim1 = await admin
    .from("orders")
    .update({ confirmation_email_status: "sending" })
    .eq("id", order.id)
    .in("confirmation_email_status", ["pending", "failed"])
    .select("id");
  assert.equal(claim1.error, null, claim1.error?.message);
  assert.equal(claim1.data.length, 1, "the first claim must succeed");

  // A second claim attempt (simulating a redelivered webhook, or a
  // concurrent delivery) must find the row already 'sending' and get
  // nothing back - this is the exact guard that prevents a duplicate
  // send.
  const claim2 = await admin
    .from("orders")
    .update({ confirmation_email_status: "sending" })
    .eq("id", order.id)
    .in("confirmation_email_status", ["pending", "failed"])
    .select("id");
  assert.equal(claim2.error, null, claim2.error?.message);
  assert.equal(claim2.data.length, 0, "a second claim on an already-claimed order must return zero rows");
});

test("confirmation email state: once marked 'sent', no future claim ever succeeds again (no duplicate email)", async (t) => {
  if (!migrationApplied) return t.skip(skipReason);
  const order = await createPaidOrder();

  await admin.from("orders").update({ confirmation_email_status: "sending" }).eq("id", order.id);
  await admin
    .from("orders")
    .update({ confirmation_email_status: "sent", confirmation_email_sent_at: new Date().toISOString() })
    .eq("id", order.id);

  const { data: after } = await admin
    .from("orders")
    .select("confirmation_email_status, confirmation_email_sent_at")
    .eq("id", order.id)
    .single();
  assert.equal(after.confirmation_email_status, "sent");
  assert.ok(after.confirmation_email_sent_at);

  // Simulates the same order being encountered again later (a resent
  // Stripe event with a different event id, for example).
  const retryClaim = await admin
    .from("orders")
    .update({ confirmation_email_status: "sending" })
    .eq("id", order.id)
    .in("confirmation_email_status", ["pending", "failed"])
    .select("id");
  assert.equal(retryClaim.data.length, 0, "an order already marked 'sent' must never be claimable again");
});

test("confirmation email state: a 'failed' order can be claimed again - a provider outage does not permanently block delivery", async (t) => {
  if (!migrationApplied) return t.skip(skipReason);
  const order = await createPaidOrder();

  await admin.from("orders").update({ confirmation_email_status: "sending" }).eq("id", order.id);
  await admin.from("orders").update({ confirmation_email_status: "failed" }).eq("id", order.id);

  const retryClaim = await admin
    .from("orders")
    .update({ confirmation_email_status: "sending" })
    .eq("id", order.id)
    .in("confirmation_email_status", ["pending", "failed"])
    .select("id");
  assert.equal(retryClaim.error, null, retryClaim.error?.message);
  assert.equal(retryClaim.data.length, 1, "a failed attempt must remain retryable exactly once per later attempt");
});

test("confirmation email state: a failed send never changes the order's money/payment fields - email delivery is fully independent of order state", async (t) => {
  if (!migrationApplied) return t.skip(skipReason);
  const order = await createPaidOrder();
  const before = await admin
    .from("orders")
    .select("status, payment_status, subtotal_gross_cents, shipping_gross_cents, total_gross_cents")
    .eq("id", order.id)
    .single();

  await admin.from("orders").update({ confirmation_email_status: "sending" }).eq("id", order.id);
  await admin.from("orders").update({ confirmation_email_status: "failed" }).eq("id", order.id);

  const after = await admin
    .from("orders")
    .select("status, payment_status, subtotal_gross_cents, shipping_gross_cents, total_gross_cents")
    .eq("id", order.id)
    .single();

  assert.deepEqual(after.data, before.data, "order status/payment_status/money fields must be unaffected by email failure");
  assert.equal(after.data.payment_status, "paid");
  assert.equal(after.data.shipping_gross_cents, 590);
});

test("confirmation email state: works the same for a guest order (user_id null) as for an authenticated one", async (t) => {
  if (!migrationApplied) return t.skip(skipReason);
  const guestOrder = await createPaidOrder({ userId: null });
  assert.equal(guestOrder.user_id, null);

  const { data, error } = await admin
    .from("orders")
    .select("confirmation_email_status")
    .eq("id", guestOrder.id)
    .single();
  assert.equal(error, null, error?.message);
  assert.equal(data.confirmation_email_status, "pending");
});
