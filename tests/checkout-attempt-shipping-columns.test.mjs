import assert from "node:assert/strict";
import test from "node:test";
import { getActiveVariantBySku } from "./helpers/catalog.mjs";
import { getTestSupabaseAdmin, getTestSupabasePublishable } from "./helpers/testSupabase.mjs";

// Schema-only checks for migration 015 (checkout_attempts.shipping_country /
// shipping_zone / shipping_gross_cents). No pricing logic exists yet (Task
// 20B) - this only proves the columns exist, are nullable, and reject an
// invalid zone key. Skips gracefully if migration 015 hasn't been applied.

let admin;
let variant;
let migrationApplied = true;
let skipReason = "";
const createdAttemptIds = [];

test.before(async () => {
  admin = getTestSupabaseAdmin();
  variant = await getActiveVariantBySku("GLOA-MATCHA-30G", getTestSupabasePublishable());

  const probe = await admin.from("checkout_attempts").select("shipping_country, shipping_zone, shipping_gross_cents").limit(1);
  if (probe.error) {
    migrationApplied = false;
    skipReason = `Migration 015 not applied yet (${probe.error.message}). Run supabase/migrations/015_checkout_attempt_shipping_snapshot.sql, then re-run tests.`;
  }
});

test.after(async () => {
  if (admin && createdAttemptIds.length > 0) {
    await admin.from("checkout_attempts").delete().in("id", createdAttemptIds);
  }
});

test("checkout_attempts: shipping snapshot columns exist and default to null", async (t) => {
  if (!migrationApplied) return t.skip(skipReason);

  const { data, error } = await admin
    .from("checkout_attempts")
    .insert({
      request_id: crypto.randomUUID(),
      currency: "EUR",
      expected_total_gross_cents: variant.price_gross_cents,
      items_snapshot: [{ variantId: variant.id, sku: variant.sku, productName: "GLOA Matcha", variantLabel: variant.label, sizeGrams: variant.size_grams, quantity: 1, unitGrossCents: variant.price_gross_cents, lineGrossCents: variant.price_gross_cents, currency: variant.currency }],
    })
    .select("id, shipping_country, shipping_zone, shipping_gross_cents")
    .single();

  assert.equal(error, null, error?.message);
  createdAttemptIds.push(data.id);
  assert.equal(data.shipping_country, null);
  assert.equal(data.shipping_zone, null);
  assert.equal(data.shipping_gross_cents, null);
});

test("checkout_attempts: shipping_zone rejects a value outside the four known zones", async (t) => {
  if (!migrationApplied) return t.skip(skipReason);

  const { error } = await admin
    .from("checkout_attempts")
    .insert({
      request_id: crypto.randomUUID(),
      currency: "EUR",
      expected_total_gross_cents: variant.price_gross_cents,
      items_snapshot: [{ variantId: variant.id, sku: variant.sku, productName: "GLOA Matcha", variantLabel: variant.label, sizeGrams: variant.size_grams, quantity: 1, unitGrossCents: variant.price_gross_cents, lineGrossCents: variant.price_gross_cents, currency: variant.currency }],
      shipping_zone: "not-a-real-zone",
    });

  assert.ok(error, "expected the check constraint to reject an unknown shipping_zone value");
});

test("checkout_attempts: shipping_gross_cents rejects a negative amount", async (t) => {
  if (!migrationApplied) return t.skip(skipReason);

  const { error } = await admin
    .from("checkout_attempts")
    .insert({
      request_id: crypto.randomUUID(),
      currency: "EUR",
      expected_total_gross_cents: variant.price_gross_cents,
      items_snapshot: [{ variantId: variant.id, sku: variant.sku, productName: "GLOA Matcha", variantLabel: variant.label, sizeGrams: variant.size_grams, quantity: 1, unitGrossCents: variant.price_gross_cents, lineGrossCents: variant.price_gross_cents, currency: variant.currency }],
      shipping_gross_cents: -100,
    });

  assert.ok(error, "expected the check constraint to reject a negative shipping_gross_cents value");
});
