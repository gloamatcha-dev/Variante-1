import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { parseEnv } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { getActiveVariantBySku } from "./helpers/catalog.mjs";
import { getAdminSupabaseClient } from "./helpers/supabaseAdmin.mjs";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
function loadLocalEnv() {
  const envLocalPath = path.join(ROOT, ".env.local");
  return existsSync(envLocalPath) ? parseEnv(readFileSync(envLocalPath, "utf-8")) : {};
}
function requireEnv(name) {
  const value = process.env[name] || loadLocalEnv()[name];
  if (!value) throw new Error(`Missing ${name}. Set it in the environment or .env.local to run checkout identity tests.`);
  return value;
}

// These tests exercise the DB-level identity guarantees behind
// checkout_attempts.user_id / orders.user_id directly against the real
// schema and RLS policies - the same guarantees lib/checkoutAttempts.ts's
// getOrCreateCheckoutAttempt() (upsert + ignoreDuplicates) and
// lib/verifyUser.ts's verifyUserId() (supabase.auth.getUser) rely on.
// Those two lib files can't be imported directly here: they read
// import.meta.env.VITE_SUPABASE_URL, a Vite build-time transform that
// plain Node ESM (used by `node --test`) doesn't provide, so importing
// them would crash at module load - the project's existing convention
// (see order-fulfillment.test.mjs) is to test this class of behavior
// against the live schema/RPC directly instead of through the wrapper.

let admin;
let anonUrl;
let anonKey;
let variant;

let userA; // { id, email, password }
let userB;

const seededRequestIds = [];
const seededUserIds = [];

async function createThrowawayUser() {
  const email = `gloa-test-${randomUUID()}@example.invalid`;
  const password = `${randomUUID()}Aa1!`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error) throw new Error(`test setup: failed to create throwaway auth user: ${error.message}`);
  seededUserIds.push(data.user.id);
  return { id: data.user.id, email, password };
}

async function upsertAttempt(requestId, userId, expectedTotalGrossCents, itemsSnapshot) {
  // Mirrors getOrCreateCheckoutAttempt's exact upsert shape/options.
  return admin.from("checkout_attempts").upsert(
    {
      request_id: requestId,
      user_id: userId,
      currency: "EUR",
      expected_total_gross_cents: expectedTotalGrossCents,
      items_snapshot: itemsSnapshot,
    },
    { onConflict: "request_id", ignoreDuplicates: true }
  );
}

test.before(async () => {
  admin = getAdminSupabaseClient();
  variant = await getActiveVariantBySku("GLOA-MATCHA-30G");
  anonUrl = requireEnv("VITE_SUPABASE_URL");
  anonKey = requireEnv("VITE_SUPABASE_PUBLISHABLE_KEY");

  [userA, userB] = await Promise.all([createThrowawayUser(), createThrowawayUser()]);
});

test.after(async () => {
  if (admin && seededRequestIds.length > 0) {
    const { data: attempts } = await admin.from("checkout_attempts").select("id").in("request_id", seededRequestIds);
    const attemptIds = (attempts ?? []).map(a => a.id);
    if (attemptIds.length > 0) {
      const { data: orders } = await admin.from("orders").select("id").in("checkout_attempt_id", attemptIds);
      const orderIds = (orders ?? []).map(o => o.id);
      if (orderIds.length > 0) {
        await admin.from("order_items").delete().in("order_id", orderIds);
        await admin.from("orders").delete().in("id", orderIds);
      }
    }
    await admin.from("checkout_attempts").delete().in("request_id", seededRequestIds);
  }
  for (const id of seededUserIds) {
    await admin.auth.admin.deleteUser(id).catch(() => {});
  }
});

test("checkout_attempts identity: an authenticated upsert sets user_id", async () => {
  const requestId = randomUUID();
  seededRequestIds.push(requestId);
  const { error } = await upsertAttempt(requestId, userA.id, variant.price_gross_cents, [
    { variantId: variant.id, sku: variant.sku, productName: "GLOA Matcha", variantLabel: variant.label, sizeGrams: variant.size_grams, quantity: 1, unitGrossCents: variant.price_gross_cents, lineGrossCents: variant.price_gross_cents, currency: variant.currency },
  ]);
  assert.equal(error, null, error?.message);

  const { data } = await admin.from("checkout_attempts").select("user_id").eq("request_id", requestId).single();
  assert.equal(data.user_id, userA.id);
});

test("checkout_attempts identity: a guest upsert leaves user_id null", async () => {
  const requestId = randomUUID();
  seededRequestIds.push(requestId);
  const { error } = await upsertAttempt(requestId, null, variant.price_gross_cents, [
    { variantId: variant.id, sku: variant.sku, productName: "GLOA Matcha", variantLabel: variant.label, sizeGrams: variant.size_grams, quantity: 1, unitGrossCents: variant.price_gross_cents, lineGrossCents: variant.price_gross_cents, currency: variant.currency },
  ]);
  assert.equal(error, null, error?.message);

  const { data } = await admin.from("checkout_attempts").select("user_id").eq("request_id", requestId).single();
  assert.equal(data.user_id, null);
});

test("checkout_attempts identity: a later retry can never upgrade a guest attempt to authenticated", async () => {
  const requestId = randomUUID();
  seededRequestIds.push(requestId);
  const snapshot = [{ variantId: variant.id, sku: variant.sku, productName: "GLOA Matcha", variantLabel: variant.label, sizeGrams: variant.size_grams, quantity: 1, unitGrossCents: variant.price_gross_cents, lineGrossCents: variant.price_gross_cents, currency: variant.currency }];

  await upsertAttempt(requestId, null, variant.price_gross_cents, snapshot);
  await upsertAttempt(requestId, userA.id, variant.price_gross_cents, snapshot);

  const { data } = await admin.from("checkout_attempts").select("user_id").eq("request_id", requestId).single();
  assert.equal(data.user_id, null, "a later authenticated retry must not overwrite an already-established guest identity");
});

test("checkout_attempts identity: a later retry can never reassign an already-authenticated attempt to a different user", async () => {
  const requestId = randomUUID();
  seededRequestIds.push(requestId);
  const snapshot = [{ variantId: variant.id, sku: variant.sku, productName: "GLOA Matcha", variantLabel: variant.label, sizeGrams: variant.size_grams, quantity: 1, unitGrossCents: variant.price_gross_cents, lineGrossCents: variant.price_gross_cents, currency: variant.currency }];

  await upsertAttempt(requestId, userA.id, variant.price_gross_cents, snapshot);
  await upsertAttempt(requestId, userB.id, variant.price_gross_cents, snapshot);

  const { data } = await admin.from("checkout_attempts").select("user_id").eq("request_id", requestId).single();
  assert.equal(data.user_id, userA.id, "a later retry must not reassign an already-established authenticated identity");
});

test("token verification: no Authorization header yields no trusted identity (guest)", async () => {
  const anon = createClient(anonUrl, anonKey);
  const { data, error } = await anon.auth.getUser();
  assert.ok(error || !data.user, "a client with no session must not resolve to a trusted user");
});

test("token verification: a garbage bearer token is rejected, never trusted", async () => {
  const anon = createClient(anonUrl, anonKey);
  const { data, error } = await anon.auth.getUser("not-a-real-jwt-at-all");
  assert.ok(error, "an invalid token must be rejected by Supabase Auth");
  assert.ok(!data?.user);
});

test("orders RLS: the authenticated owner can read their own order via the real RPC + real session", async () => {
  const requestId = randomUUID();
  seededRequestIds.push(requestId);
  const snapshot = [{ variantId: variant.id, sku: variant.sku, productName: "GLOA Matcha", variantLabel: variant.label, sizeGrams: variant.size_grams, quantity: 1, unitGrossCents: variant.price_gross_cents, lineGrossCents: variant.price_gross_cents, currency: variant.currency }];

  const { data: attempt, error: attemptErr } = await admin
    .from("checkout_attempts")
    .insert({ request_id: requestId, user_id: userA.id, status: "paid", currency: "EUR", expected_total_gross_cents: variant.price_gross_cents, items_snapshot: snapshot, paid_at: new Date().toISOString() })
    .select("id")
    .single();
  assert.equal(attemptErr, null, attemptErr?.message);

  const { data: order, error: rpcErr } = await admin.rpc("create_order_from_paid_checkout", {
    p_checkout_attempt_id: attempt.id,
    p_customer_snapshot: { email: null, name: null },
    p_stripe_payment_intent_id: null,
  });
  assert.equal(rpcErr, null, rpcErr?.message);
  const orderRow = Array.isArray(order) ? order[0] : order;
  assert.equal(orderRow.user_id, userA.id);

  const asUserA = createClient(anonUrl, anonKey);
  const { error: signInErrA } = await asUserA.auth.signInWithPassword({ email: userA.email, password: userA.password });
  assert.equal(signInErrA, null, signInErrA?.message);

  const { data: ownRead, error: ownReadErr } = await asUserA.from("orders").select("id").eq("id", orderRow.id).maybeSingle();
  assert.equal(ownReadErr, null, ownReadErr?.message);
  assert.ok(ownRead, "the authenticated owner must be able to read their own order");

  const asUserB = createClient(anonUrl, anonKey);
  const { error: signInErrB } = await asUserB.auth.signInWithPassword({ email: userB.email, password: userB.password });
  assert.equal(signInErrB, null, signInErrB?.message);

  const { data: foreignRead } = await asUserB.from("orders").select("id").eq("id", orderRow.id).maybeSingle();
  assert.equal(foreignRead, null, "a different authenticated user must not be able to read another user's order (IDOR)");
});
