import assert from "node:assert/strict";
import test from "node:test";
import { evaluateStripeSessionPayment } from "../lib/stripeFulfillment.ts";

const ATTEMPT = { currency: "EUR", expected_total_gross_cents: 1999 };

test("evaluateStripeSessionPayment: valid paid session marks paid", () => {
  const result = evaluateStripeSessionPayment(
    { payment_status: "paid", currency: "eur", amount_total: 1999 },
    ATTEMPT
  );
  assert.deepEqual(result, { shouldMarkPaid: true });
});

test("evaluateStripeSessionPayment: unpaid session is not marked paid", () => {
  const result = evaluateStripeSessionPayment(
    { payment_status: "unpaid", currency: "eur", amount_total: 1999 },
    ATTEMPT
  );
  assert.equal(result.shouldMarkPaid, false);
  assert.match(result.reason, /payment_status/);
});

test("evaluateStripeSessionPayment: amount_total mismatch is not marked paid", () => {
  const result = evaluateStripeSessionPayment(
    { payment_status: "paid", currency: "eur", amount_total: 100 },
    ATTEMPT
  );
  assert.equal(result.shouldMarkPaid, false);
  assert.match(result.reason, /amount mismatch/);
});

test("evaluateStripeSessionPayment: currency mismatch is not marked paid", () => {
  const result = evaluateStripeSessionPayment(
    { payment_status: "paid", currency: "usd", amount_total: 1999 },
    ATTEMPT
  );
  assert.equal(result.shouldMarkPaid, false);
  assert.match(result.reason, /currency mismatch/);
});

test("evaluateStripeSessionPayment: missing amount_total is not marked paid", () => {
  const result = evaluateStripeSessionPayment(
    { payment_status: "paid", currency: "eur", amount_total: null },
    ATTEMPT
  );
  assert.equal(result.shouldMarkPaid, false);
  assert.match(result.reason, /amount_total/);
});

test("evaluateStripeSessionPayment: no_payment_required is not marked paid", () => {
  const result = evaluateStripeSessionPayment(
    { payment_status: "no_payment_required", currency: "eur", amount_total: 0 },
    { currency: "EUR", expected_total_gross_cents: 0 }
  );
  assert.equal(result.shouldMarkPaid, false);
});
