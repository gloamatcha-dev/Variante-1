import assert from "node:assert/strict";
import test from "node:test";
import {
  REFUND_EVENT_TYPES,
  isRefundEventType,
  paymentIntentIdFromRefundEvent,
  summarizeStripeRefunds,
} from "../lib/stripeRefunds.ts";

// SAFE DEFAULT SUITE: pure logic only. No Stripe API call is made from
// this file, no refund is ever created, and no DB is touched.

const refund = (over = {}) => ({ amount: 590, currency: "eur", status: "succeeded", ...over });

/* ── Amounts ────────────────────────────────────────────────── */

test("refunds: no refunds means nothing refunded and nothing pending", () => {
  assert.deepEqual(summarizeStripeRefunds([], "EUR"), {
    ok: true,
    refundedTotalCents: 0,
    hasPendingRefund: false,
  });
});

test("refunds: a full refund sums to the charged amount", () => {
  const result = summarizeStripeRefunds([refund({ amount: 2589 })], "eur");
  assert.deepEqual(result, { ok: true, refundedTotalCents: 2589, hasPendingRefund: false });
});

test("refunds: multiple partial refunds add up rather than being flattened to a boolean", () => {
  const result = summarizeStripeRefunds([refund({ amount: 590 }), refund({ amount: 400 })], "eur");
  assert.equal(result.refundedTotalCents, 990);
});

test("refunds: a pending refund is not counted as money returned", () => {
  const result = summarizeStripeRefunds([refund({ status: "pending" })], "eur");
  assert.deepEqual(result, { ok: true, refundedTotalCents: 0, hasPendingRefund: true });
});

test("refunds: requires_action counts as pending, not settled", () => {
  const result = summarizeStripeRefunds([refund({ status: "requires_action" })], "eur");
  assert.equal(result.refundedTotalCents, 0);
  assert.equal(result.hasPendingRefund, true);
});

test("refunds: failed and cancelled refunds return the order to a plain paid state", () => {
  const result = summarizeStripeRefunds([refund({ status: "failed" }), refund({ status: "canceled" })], "eur");
  assert.deepEqual(result, { ok: true, refundedTotalCents: 0, hasPendingRefund: false });
});

test("refunds: settled and pending refunds coexist correctly", () => {
  const result = summarizeStripeRefunds(
    [refund({ amount: 590 }), refund({ amount: 400, status: "pending" })],
    "eur"
  );
  assert.deepEqual(result, { ok: true, refundedTotalCents: 590, hasPendingRefund: true });
});

/* ── Idempotency ────────────────────────────────────────────── */

test("refunds: the same refund list always produces the same absolute total", () => {
  // This is what makes duplicate/redelivered webhook events safe: the
  // total is recomputed from Stripe's own list, never incremented.
  const refunds = [refund({ amount: 590 }), refund({ amount: 400 })];
  const first = summarizeStripeRefunds(refunds, "eur");
  const second = summarizeStripeRefunds(refunds, "eur");
  const third = summarizeStripeRefunds([...refunds].reverse(), "eur");
  assert.deepEqual(first, second);
  assert.deepEqual(first, third, "order of delivery must not change the result");
});

/* ── Fail-closed guards ─────────────────────────────────────── */

test("refunds: a currency mismatch refuses the whole summary", () => {
  const result = summarizeStripeRefunds([refund({ currency: "usd" })], "eur");
  assert.equal(result.ok, false);
  assert.match(result.reason, /currency/);
});

test("refunds: a missing or malformed amount is refused, never treated as zero", () => {
  for (const amount of [null, undefined, "590", 5.5, -1, NaN]) {
    const result = summarizeStripeRefunds([refund({ amount })], "eur");
    assert.equal(result.ok, false, `should refuse amount ${String(amount)}`);
  }
});

test("refunds: an unknown status is refused rather than silently ignored", () => {
  const result = summarizeStripeRefunds([refund({ status: "something_new" })], "eur");
  assert.equal(result.ok, false);
  assert.match(result.reason, /unrecognised refund status/);
});

test("refunds: a missing status or currency is refused", () => {
  assert.equal(summarizeStripeRefunds([refund({ status: null })], "eur").ok, false);
  assert.equal(summarizeStripeRefunds([refund({ currency: null })], "eur").ok, false);
});

test("refunds: a missing expected currency is refused", () => {
  assert.equal(summarizeStripeRefunds([refund()], "").ok, false);
});

test("refunds: a non-array refund list is refused", () => {
  assert.equal(summarizeStripeRefunds(null, "eur").ok, false);
});

/* ── Event types ────────────────────────────────────────────── */

test("refund events: the handled set matches the pinned Stripe SDK", () => {
  // Verified against stripe@22.5.0 (API version 2026-07-29.dahlia), not
  // from memory: both the modern refund.* lifecycle and the charge-level
  // events are covered, so a dashboard-issued refund is picked up either
  // way.
  assert.deepEqual([...REFUND_EVENT_TYPES].sort(), [
    "charge.refund.updated",
    "charge.refunded",
    "refund.created",
    "refund.failed",
    "refund.updated",
  ]);
});

test("refund events: unrelated event types are not treated as refunds", () => {
  for (const type of ["checkout.session.completed", "payment_intent.succeeded", "ping", "charge.succeeded"]) {
    assert.equal(isRefundEventType(type), false, type);
  }
  for (const type of REFUND_EVENT_TYPES) {
    assert.equal(isRefundEventType(type), true, type);
  }
});

test("refund events: the payment intent id is read from either payload shape", () => {
  assert.equal(paymentIntentIdFromRefundEvent({ payment_intent: "pi_123" }), "pi_123");
  assert.equal(paymentIntentIdFromRefundEvent({ payment_intent: { id: "pi_123" } }), "pi_123");
  assert.equal(paymentIntentIdFromRefundEvent({ payment_intent: "  pi_123  " }), "pi_123");
});

test("refund events: a payload without a payment intent yields null rather than a guess", () => {
  for (const payload of [{}, null, undefined, { payment_intent: null }, { payment_intent: "" }, { payment_intent: {} }, { payment_intent: 42 }]) {
    assert.equal(paymentIntentIdFromRefundEvent(payload), null);
  }
});
