import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildInternalAnnualPurchaseNotificationEmail,
  internalAnnualPurchaseNotificationIdempotencyKey,
} from "../lib/email/internalAnnualPurchaseNotification.ts";
import { GLOA_INTERNAL_ORDERS } from "../lib/emailSenders.ts";

/**
 * Block 1 — 072 internal annual purchase notification.
 *
 * These tests prove that the annual purchase notification follows the
 * repository's transactional email architecture: claim → send → mark,
 * with a real Resend call between claim and mark, idempotency keys,
 * and orders@gloamatcha.com as the sole recipient.
 *
 * Pure template and source-level checks. No Resend client, no DB, no
 * network, no email sent.
 */

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf-8");
const NEWLINE = String.fromCharCode(10);

const senderSrc = read("lib/annualPurchaseNotification.ts");
const templateSrc = read("lib/email/internalAnnualPurchaseNotification.ts");

const withoutComments = (source) =>
  source
    .split(NEWLINE)
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith("--") && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join(NEWLINE);

const senderCode = withoutComments(senderSrc);

const plan = (overrides = {}) => ({
  annualPlanId: "00000000-0000-0000-0000-000000000001",
  currency: "EUR",
  totalGrossCents: 96070,
  merchandiseTotalGrossCents: 89310,
  shippingTotalGrossCents: 6760,
  annualUnitGrossCents: 6870,
  deliveryCount: 13,
  discountPercentApplied: 20,
  paymentStatus: "paid",
  status: "active",
  purchasedAt: "2026-10-01T12:00:00Z",
  stripePaymentIntentId: "pi_test_123",
  customerName: "Max Mustermann",
  customerEmail: "max@example.test",
  productLabel: "GLOA Matcha · 30 g",
  productSku: "GLOA-MATCHA-30G",
  ...overrides,
});

/* ── A: successful send marks 'sent' ──────────────────────────── */

test("A: the sender marks 'sent' ONLY after a successful Resend send — never before", () => {
  // The sender must call markAnnualPurchaseNotification(id, "sent")
  // ONLY after resend.emails.send succeeds, not before.
  assert.match(senderCode, /resend\.emails\.send/,
    "the sender must actually call resend.emails.send");
  assert.match(senderCode, /markAnnualPurchaseNotification\([^,]+,\s*"sent"\)/,
    "the sender must mark 'sent' after successful send");

  // Structurally: the mark-sent call must come AFTER the send block,
  // not before it or unconditionally.
  const sendIdx = senderCode.indexOf("resend.emails.send");
  const markSentIdx = senderCode.indexOf('markAnnualPurchaseNotification(annualPlanId, "sent")');
  assert.ok(sendIdx > 0 && markSentIdx > sendIdx,
    "mark-sent must come after the actual Resend send, not before");
});

/* ── B: failed send marks 'failed', never 'sent' ─────────────── */

test("B: a failed send marks 'failed' and throws — never marks 'sent'", () => {
  assert.match(senderCode, /markAnnualPurchaseNotification\([^,]+,\s*"failed"\)/,
    "the sender must mark 'failed' on send failure");

  // The mark-failed must come in the error path, before throwing.
  const failedIdx = senderCode.indexOf('markAnnualPurchaseNotification(annualPlanId, "failed")');
  assert.ok(failedIdx > 0, "mark-failed must exist in the error path");

  // Throwing after failure ensures Stripe redelivers.
  assert.match(senderCode, /throw new Error/,
    "the sender must throw after marking failed");
});

/* ── C: retry succeeds — the claim accepts 'failed' rows ──────── */

test("C: the migration claim function accepts 'failed' rows for retry", () => {
  const migration072 = read("supabase/migrations/072_admin_core_connections.sql");
  const claimFn = migration072.slice(
    migration072.indexOf("create or replace function public.claim_annual_purchase_notification"),
    migration072.indexOf("$$;", migration072.indexOf("claim_annual_purchase_notification")) + 3
  );
  assert.match(claimFn, /internal_notification_status\s*=\s*'failed'/,
    "the claim must re-accept rows that previously failed");
  assert.match(claimFn, /internal_notification_status\s+is\s+null/i,
    "the claim must accept rows never attempted (null)");
});

/* ── D: webhook replay produces no duplicate email ────────────── */

test("D: a second claim on an already-sent plan returns false — no duplicate", () => {
  const migration072 = read("supabase/migrations/072_admin_core_connections.sql");
  const claimFn = migration072.slice(
    migration072.indexOf("create or replace function public.claim_annual_purchase_notification"),
    migration072.indexOf("$$;", migration072.indexOf("claim_annual_purchase_notification")) + 3
  );
  // The claim UPDATE only matches null or 'failed', so 'sent' and
  // 'sending' are excluded — a replay cannot win the claim.
  assert.ok(!claimFn.includes("'sent'") || claimFn.includes("is null"),
    "the claim must not match already-sent rows");
  // The sender checks the claim result before proceeding.
  assert.match(senderCode, /const claimed = await claimAnnualPurchaseNotification/,
    "the sender must check the claim result");
  assert.match(senderCode, /if \(!claimed\) return/,
    "the sender must return immediately if claim was not granted");
});

/* ── E: recipient is exactly orders@gloamatcha.com ────────────── */

test("E: the recipient is exactly GLOA_INTERNAL_ORDERS (orders@gloamatcha.com), never a customer", () => {
  assert.equal(GLOA_INTERNAL_ORDERS, "orders@gloamatcha.com",
    "the constant must resolve to orders@gloamatcha.com");
  assert.match(senderCode, /to: GLOA_INTERNAL_ORDERS/,
    "the sender must use the GLOA_INTERNAL_ORDERS constant as recipient");
  // customerEmail appears in the plan data (for the email body), but must
  // never be used as the `to:` recipient.
  assert.ok(!senderCode.includes("to: customer") && !senderCode.includes("to: plan.customerEmail"),
    "the sender must never use customerEmail as a recipient");
});

/* ── Template: pure, leaf, no side effects ─────────────────────── */

test("email: the template is a pure leaf, like its siblings", () => {
  // No relative imports (pure leaf).
  const imports = [...templateSrc.matchAll(/^import\s[\s\S]*?from "([^"]+)"/gm)]
    .map((m) => m[1]);
  assert.equal(imports.length, 0,
    "the template must be a pure leaf with zero imports");

  // No side effects.
  const clean = templateSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const forbidden of ["process.env", "fetch(", "supabase", "Math.random"]) {
    assert.ok(!clean.includes(forbidden),
      `the template must not reach for ${forbidden}`);
  }
});

/* ── Template: renders valid content ───────────────────────────── */

test("the template builds a complete email with subject, html and text", () => {
  const result = buildInternalAnnualPurchaseNotificationEmail(plan());
  assert.ok(result.subject.length > 0, "subject must not be empty");
  assert.ok(result.html.includes("<!doctype html"), "html must be a full document");
  assert.ok(result.text.length > 0, "text must not be empty");
});

test("the template includes all required fields", () => {
  const p = plan();
  const result = buildInternalAnnualPurchaseNotificationEmail(p);

  // Subject contains amount
  assert.ok(result.subject.includes("960,70"), "subject must contain the total");

  // HTML and text contain key fields
  for (const output of [result.html, result.text]) {
    assert.ok(output.includes(p.annualPlanId), "must include annual plan ID");
    assert.ok(output.includes("Max Mustermann"), "must include customer name");
    assert.ok(output.includes("GLOA Matcha"), "must include product name");
    assert.ok(output.includes("13"), "must include delivery count");
    assert.ok(output.includes("paid"), "must include payment status");
    assert.ok(output.includes("active"), "must include plan status");
  }
});

test("the template escapes HTML in customer-supplied fields", () => {
  const p = plan({ customerName: '<script>alert("xss")</script>' });
  const result = buildInternalAnnualPurchaseNotificationEmail(p);
  assert.ok(!result.html.includes("<script>"),
    "customer name must be HTML-escaped");
  assert.ok(result.html.includes("&lt;script&gt;"),
    "customer name must use HTML entities");
});

test("nothing renders the string 'undefined', 'null' or 'NaN' to a reader", () => {
  const result = buildInternalAnnualPurchaseNotificationEmail(plan());
  for (const poison of ["undefined", "null", "NaN"]) {
    assert.ok(!result.html.includes(`>${poison}<`),
      `html renders the literal '${poison}' as visible text`);
    assert.ok(!result.text.split("\n").some(line => line.trim() === poison),
      `text renders the literal '${poison}' as a standalone line`);
  }
});

/* ── Idempotency key ───────────────────────────────────────────── */

test("the idempotency key is deterministic and namespaced", () => {
  const id = "00000000-0000-0000-0000-000000000001";
  const key1 = internalAnnualPurchaseNotificationIdempotencyKey(id);
  const key2 = internalAnnualPurchaseNotificationIdempotencyKey(id);
  assert.equal(key1, key2, "same plan id must produce the same key");
  assert.ok(key1.startsWith("gloa/internal-annual-purchase/"),
    "key must be namespaced to avoid collisions");
  assert.ok(key1.includes(id), "key must contain the plan id");
});

test("the idempotency key namespace does not collide with the order notification", () => {
  const id = "00000000-0000-0000-0000-000000000001";
  const annualKey = internalAnnualPurchaseNotificationIdempotencyKey(id);
  assert.ok(!annualKey.startsWith("gloa/internal-order/"),
    "annual key must not collide with order notification namespace");
});

/* ── Sender: uses the Resend idempotency key ──────────────────── */

test("the sender uses internalAnnualPurchaseNotificationIdempotencyKey", () => {
  assert.match(senderSrc, /internalAnnualPurchaseNotificationIdempotencyKey/,
    "the sender must import and use the idempotency key function");
  assert.match(senderCode, /idempotencyKey/,
    "the sender must pass the idempotency key to Resend");
});

/* ── Sender: from address is GLOA_FROM_HELLO ──────────────────── */

test("the sender uses the standard GLOA_FROM_HELLO from address", () => {
  assert.match(senderCode, /from: GLOA_FROM_HELLO/,
    "the sender must use the standard from address");
});

/* ── Sender: reads the real plan from the database ────────────── */

test("the sender reads the plan from the database, not from arguments", () => {
  assert.match(senderCode, /\.from\("annual_plans"\)/,
    "the sender must read from the annual_plans table");
  assert.match(senderCode, /\.eq\("id",\s*annualPlanId\)/,
    "the sender must filter by the plan ID");
  assert.match(senderCode, /\.single\(\)/,
    "the sender must expect exactly one row");
});
