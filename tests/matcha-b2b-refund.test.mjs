import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { hasMatchaB2bInvoiceHint, verifyMatchaB2bRefund } from "../lib/matchaB2bRefund.ts";

function stripeFixture(overrides = {}) {
  const payment = {
    invoice: "in_monthly", payment: { type: "payment_intent", payment_intent: "pi_b2b" },
    status: "paid", amount_paid: 500,
  };
  const charge = {
    id: "ch_b2b", livemode: false, payment_intent: "pi_b2b", paid: true, captured: true,
    currency: "eur", amount_captured: 500, amount_refunded: 500, refunded: true,
    ...overrides.charge,
  };
  return {
    paymentIntents: { retrieve: async () => ({
      id: "pi_b2b", status: "succeeded", livemode: false, currency: "eur",
      amount_received: 500, latest_charge: charge,
    }) },
    refunds: { list: async () => {
      assert.equal(overrides.expectNoRefundRead, undefined);
      return { has_more: false, data: [{
        id: "re_b2b", charge: charge.id, payment_intent: "pi_b2b", currency: "eur",
        amount: 500, status: "succeeded", ...overrides.refund,
      }] };
    } },
    invoicePayments: { list: async ({ invoice }) => ({
      has_more: false,
      data: invoice ? (overrides.invoicePayments ?? [payment]) : (overrides.intentPayments ?? [payment]),
    }) },
  };
}

test("only settled full refunds with unique payment coverage qualify", async () => {
  assert.deepEqual(await verifyMatchaB2bRefund(stripeFixture(), "pi_b2b", false),
    { status: "full", invoiceId: "in_monthly", capturedCents: 500, b2bHint: false });
  assert.deepEqual(await verifyMatchaB2bRefund(stripeFixture({ intentPayments: [] }), "pi_b2b", false),
    { status: "full", invoiceId: null, capturedCents: 500, b2bHint: false });
  assert.deepEqual(await verifyMatchaB2bRefund(stripeFixture({
    charge: { refunded: false, amount_refunded: 100 }, expectNoRefundRead: true,
  }), "pi_b2b", false), { status: "not_full" });
  for (const options of [
    { refund: { status: "pending" } },
    { refund: { charge: "ch_other" } },
    { refund: { amount: 499 } },
    { invoicePayments: [{}, {}] },
    { intentPayments: [
      { invoice: "in_first", payment: { type: "payment_intent", payment_intent: "pi_b2b" } },
      { invoice: "in_second", payment: { type: "payment_intent", payment_intent: "pi_b2b" } },
    ] },
  ]) {
    assert.deepEqual(await verifyMatchaB2bRefund(stripeFixture(options), "pi_b2b", false),
      { status: "unverified" });
  }
});

test("B2B lookup runs only after both B2C lookup paths find no order", () => {
  const route = readFileSync(new URL("../app/api/stripe/webhook/route.ts", import.meta.url), "utf8");
  assert.match(route, /if \(annual.kind === "annual"\) \{[\s\S]*?return;\s*\}\s*const outcome = await syncOrderRefundStateFromStripe/);
  assert.match(route, /if \(outcome.result === "order_not_found" && !outcome.orderId\) \{\s*const proof = await verifyMatchaB2bRefund/);
  assert.match(route, /outcome.orderId && outcome.refundedTotalCents[^\n]*\{\s*requireBusinessEffect\('order refund'/);
});

test("an out-of-order invoice refund retains the existing B2B routing hint for retry", async () => {
  const subscriptions = { retrieve: async id => {
    assert.equal(id, "sub_b2b");
    return { metadata: { gloa_b2b_agreement_id: "agreement" } };
  } };
  const recurring = { invoices: { retrieve: async () => ({
    parent: { subscription_details: { subscription: "sub_b2b" } },
  }) }, subscriptions };
  assert.equal(await hasMatchaB2bInvoiceHint(recurring, "in_monthly"), true);
  assert.equal(await hasMatchaB2bInvoiceHint({
    invoices: { retrieve: async () => ({ metadata: {} }) }, subscriptions,
  }, "in_unrelated"), false);
});
