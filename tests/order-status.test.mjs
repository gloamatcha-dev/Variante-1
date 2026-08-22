import assert from "node:assert/strict";
import test from "node:test";
import {
  canRequestCancellation,
  getCancellationView,
  getLifecycleSteps,
  getPaymentStatusLabel,
  getPrimaryStatusLabel,
  getRefundView,
  getStatusDetailText,
  getTrackingView,
  sanitizeTrackingUrl,
} from "../lib/orderStatus.ts";

// SAFE DEFAULT SUITE: pure logic only. No DB, no network, no Stripe.
// lib/orderStatus.ts is a leaf module (no relative imports, no
// import.meta.env), so it imports directly here the same way
// lib/shipping.ts does in tests/shipping.test.mjs.

const order = (over = {}) => ({
  status: "confirmed",
  payment_status: "paid",
  fulfillment_status: "unfulfilled",
  total_gross_cents: 2589,
  refunded_total_cents: null,
  shipping_carrier: null,
  tracking_number: null,
  tracking_url: null,
  shipped_at: null,
  cancellation_requested_at: null,
  ...over,
});

/* ── Status labels ──────────────────────────────────────────── */

test("status: a paid, unfulfilled order reads as confirmed", () => {
  assert.equal(getPrimaryStatusLabel(order()), "Bestätigt");
});

test("status: a paid order being prepared says so", () => {
  assert.equal(getPrimaryStatusLabel(order({ fulfillment_status: "processing" })), "In Vorbereitung");
});

test("status: a shipped order reads as Versendet", () => {
  assert.equal(getPrimaryStatusLabel(order({ fulfillment_status: "shipped" })), "Versendet");
});

test("status: cancelled beats every other signal", () => {
  assert.equal(getPrimaryStatusLabel(order({ status: "cancelled" })), "Storniert");
  assert.equal(getPrimaryStatusLabel(order({ fulfillment_status: "cancelled" })), "Storniert");
});

test("status: an unpaid order never claims to be confirmed", () => {
  assert.equal(getPrimaryStatusLabel(order({ payment_status: "pending", status: "pending" })), "Zahlung ausstehend");
  assert.equal(getPrimaryStatusLabel(order({ payment_status: "failed" })), "Zahlung fehlgeschlagen");
});

test("status: labels are customer German, never a raw column value", () => {
  const rawValues = [
    "pending", "paid", "failed", "refund_pending", "partially_refunded", "refunded",
    "unfulfilled", "processing", "shipped", "delivered", "cancelled", "confirmed",
  ];
  for (const payment_status of ["pending", "paid", "failed", "refund_pending", "partially_refunded", "refunded"]) {
    for (const fulfillment_status of ["unfulfilled", "processing", "shipped", "delivered", "cancelled"]) {
      const o = order({ payment_status, fulfillment_status, refunded_total_cents: 100 });
      const label = getPrimaryStatusLabel(o);
      assert.ok(label.length > 0);
      assert.ok(!rawValues.includes(label), `leaked raw value: ${label}`);
      assert.ok(!/_/.test(label), `leaked snake_case: ${label}`);
    }
  }
});

test("status: payment labels never print a raw column value", () => {
  for (const payment_status of ["pending", "paid", "failed", "refund_pending", "partially_refunded", "refunded", "something_new"]) {
    const label = getPaymentStatusLabel(order({ payment_status }));
    assert.ok(!/_/.test(label), `leaked raw value: ${label}`);
  }
});

/* ── Delivered is never inferred ────────────────────────────── */

test("status: 'Zugestellt' is never inferred from how long ago it shipped", () => {
  const longAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const shippedLongAgo = order({ fulfillment_status: "shipped", shipped_at: longAgo });
  assert.equal(getPrimaryStatusLabel(shippedLongAgo), "Versendet");
  assert.ok(!getLifecycleSteps(shippedLongAgo).some(step => step.key === "delivered"));
});

test("status: 'Zugestellt' appears only on an explicit delivered signal", () => {
  const delivered = order({ fulfillment_status: "delivered" });
  assert.equal(getPrimaryStatusLabel(delivered), "Zugestellt");
  assert.ok(getLifecycleSteps(delivered).some(step => step.key === "delivered"));
});

/* ── Lifecycle steps ────────────────────────────────────────── */

test("steps: a cancelled order shows no progress track", () => {
  assert.deepEqual(getLifecycleSteps(order({ status: "cancelled" })), []);
});

test("steps: an unpaid order has payment as the current step", () => {
  const steps = getLifecycleSteps(order({ payment_status: "pending" }));
  assert.equal(steps.find(s => s.key === "paid").state, "current");
  assert.equal(steps.find(s => s.key === "preparing").state, "upcoming");
  assert.equal(steps.find(s => s.key === "shipped").state, "upcoming");
});

test("steps: a shipped order marks preparation done and shipping current", () => {
  const steps = getLifecycleSteps(order({ fulfillment_status: "shipped" }));
  assert.equal(steps.find(s => s.key === "preparing").state, "done");
  assert.equal(steps.find(s => s.key === "shipped").state, "current");
});

/* ── Tracking URL safety ────────────────────────────────────── */

test("tracking: unsafe URL schemes are rejected", () => {
  const unsafe = [
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "  javascript:alert(1)  ",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "mailto:info@gloamatcha.com",
    "ftp://example.com/x",
    "//evil.example.com/track",
    "/relative/path",
    "example.com/track",
    "",
    "   ",
    "https://",
  ];
  for (const value of unsafe) {
    assert.equal(sanitizeTrackingUrl(value), null, `should be rejected: ${JSON.stringify(value)}`);
  }
});

test("tracking: ordinary http(s) tracking URLs are accepted", () => {
  assert.equal(sanitizeTrackingUrl("https://tracking.example.com/xyz"), "https://tracking.example.com/xyz");
  assert.equal(sanitizeTrackingUrl("  https://tracking.example.com/xyz  "), "https://tracking.example.com/xyz");
  assert.ok(sanitizeTrackingUrl("http://tracking.example.com/xyz"));
});

test("tracking: non-string input is rejected rather than coerced", () => {
  for (const value of [null, undefined, 42, {}, []]) {
    assert.equal(sanitizeTrackingUrl(value), null);
  }
});

/* ── Tracking display ───────────────────────────────────────── */

test("tracking: nothing is shown when there is no tracking data", () => {
  assert.equal(getTrackingView(order()), null);
  assert.equal(getTrackingView(order({ tracking_number: "   ", shipping_carrier: "" })), null);
});

test("tracking: an unknown carrier is left unknown, never guessed", () => {
  // A DHL-shaped number must not produce a carrier name or a DHL URL.
  const view = getTrackingView(order({ tracking_number: "00340434161094042557" }));
  assert.equal(view.carrier, null);
  assert.equal(view.url, null);
  assert.equal(view.trackingNumber, "00340434161094042557");
});

test("tracking: a stored unsafe URL never reaches the view", () => {
  const view = getTrackingView(order({ tracking_number: "ABC123", tracking_url: "javascript:alert(1)" }));
  assert.equal(view.url, null);
  assert.equal(view.trackingNumber, "ABC123");
});

/* ── Refunds ────────────────────────────────────────────────── */

test("refund: an untouched order reports no refund", () => {
  assert.deepEqual(getRefundView(order()), { kind: "none" });
});

test("refund: a full refund reports the real amount", () => {
  const view = getRefundView(order({ payment_status: "refunded", refunded_total_cents: 2589 }));
  assert.deepEqual(view, { kind: "full", amountCents: 2589 });
});

test("refund: a partial refund reports the actual amount, not the order total", () => {
  const view = getRefundView(order({ payment_status: "partially_refunded", refunded_total_cents: 590 }));
  assert.deepEqual(view, { kind: "partial", amountCents: 590 });
  assert.notEqual(view.amountCents, 2589);
});

test("refund: a refunded order with no recorded amount never invents one", () => {
  const full = getRefundView(order({ payment_status: "refunded", refunded_total_cents: null }));
  assert.deepEqual(full, { kind: "unknown_amount", partial: false });
  assert.equal(getPrimaryStatusLabel(order({ payment_status: "refunded", refunded_total_cents: null })), "Erstattet");

  const partial = getRefundView(order({ payment_status: "partially_refunded", refunded_total_cents: null }));
  assert.deepEqual(partial, { kind: "unknown_amount", partial: true });
});

test("refund: a zero recorded amount is not treated as a refund", () => {
  assert.deepEqual(getRefundView(order({ refunded_total_cents: 0 })), { kind: "none" });
});

test("refund: a pending refund never claims the money is back", () => {
  const o = order({ payment_status: "refund_pending" });
  assert.deepEqual(getRefundView(o), { kind: "pending" });
  assert.equal(getPrimaryStatusLabel(o), "Erstattung läuft");
  assert.ok(!/^Erstattet$/.test(getPrimaryStatusLabel(o)));
  assert.ok(getStatusDetailText(o).includes("angestoßen"));
});

/* ── Cancellation ───────────────────────────────────────────── */

test("cancellation: a paid, unshipped order may be asked about", () => {
  assert.equal(getCancellationView(order()).state, "eligible");
  assert.equal(canRequestCancellation(order()), true);
});

test("cancellation: a shipped order is too late and points at the withdrawal right", () => {
  for (const o of [order({ fulfillment_status: "shipped" }), order({ fulfillment_status: "delivered" }), order({ status: "shipped" })]) {
    assert.equal(getCancellationView(o).state, "too_late");
    assert.equal(canRequestCancellation(o), false);
  }
});

test("cancellation: an unpaid or cancelled or refunded order offers nothing", () => {
  for (const o of [
    order({ payment_status: "pending" }),
    order({ payment_status: "failed" }),
    order({ status: "cancelled" }),
    order({ fulfillment_status: "cancelled" }),
    order({ payment_status: "refunded", refunded_total_cents: 2589 }),
    order({ payment_status: "partially_refunded", refunded_total_cents: 590 }),
  ]) {
    assert.equal(getCancellationView(o).state, "unavailable");
    assert.equal(canRequestCancellation(o), false);
  }
});

test("cancellation: a request is reported as under review, never as cancelled", () => {
  const requested = order({ cancellation_requested_at: "2026-08-22T10:00:00.000Z" });
  assert.equal(getCancellationView(requested).state, "requested");
  assert.equal(canRequestCancellation(requested), false);

  // The crucial guarantee: asking must not make the order look cancelled.
  assert.notEqual(getPrimaryStatusLabel(requested), "Storniert");
  assert.equal(getPrimaryStatusLabel(requested), "Bestätigt");

  const detail = getStatusDetailText(requested);
  assert.ok(detail.includes("prüfen"), detail);
  assert.ok(!detail.includes("storniert"), detail);
});

/* ── No internal identifiers ────────────────────────────────── */

test("status: no internal identifier can reach customer-facing text", () => {
  const secrets = {
    id: "6b1f0a3c-6f4e-4a1e-9a1a-2f8a2b6c1d3e",
    checkout_attempt_id: "9f2c1b7e-1111-2222-3333-444455556666",
    stripe_payment_intent_id: "pi_3NotARealPaymentIntent",
    stripe_checkout_session_id: "cs_test_NotARealSession",
    user_id: "11111111-2222-3333-4444-555555555555",
  };
  const o = order({
    ...secrets,
    payment_status: "partially_refunded",
    refunded_total_cents: 590,
    fulfillment_status: "shipped",
    tracking_number: "ABC123",
    tracking_url: "https://tracking.example.com/ABC123",
    shipping_carrier: "DHL",
  });

  const rendered = [
    getPrimaryStatusLabel(o),
    getPaymentStatusLabel(o),
    getStatusDetailText(o) ?? "",
    JSON.stringify(getLifecycleSteps(o)),
    JSON.stringify(getTrackingView(o)),
    JSON.stringify(getRefundView(o)),
    JSON.stringify(getCancellationView(o)),
  ].join("\n");

  for (const [field, value] of Object.entries(secrets)) {
    assert.ok(!rendered.includes(value), `${field} leaked into customer-facing output`);
  }
});
