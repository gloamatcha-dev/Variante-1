import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  suggestedValueLossCents,
  isConfirmableValueLoss,
  computeRefund,
  refundHoldState,
  returnIsOverdue,
  withdrawalProtectsFutureDeliveries,
  WITHDRAWAL_RETURN_COST_SENTENCE,
  RETURN_WINDOW_DAYS,
} from "../lib/withdrawalCase.ts";

import {
  identifies,
  resolveReceipt,
  submitWithdrawal,
} from "../lib/withdrawalSubmission.ts";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf8");

/* The frozen retail prices the three packages were bought at. */
const RETAIL = { "30g": 1499, "50g": 2299, "100g": 3999 };

/* ══════════════════════════════════════════════════════════════
   WERTERSATZ - THE PROPOSAL
   ══════════════════════════════════════════════════════════════ */

test("opened: the proposal is the package's frozen retail price", () => {
  for (const [size, cents] of Object.entries(RETAIL)) {
    assert.equal(
      suggestedValueLossCents({
        sealState: "opened_seal_broken",
        catalogUnitGrossCentsAtPurchase: cents,
      }),
      cents,
      `${size} must propose ${cents}`
    );
  }
});

test("unopened: there is nothing to propose", () => {
  for (const cents of Object.values(RETAIL)) {
    assert.equal(
      suggestedValueLossCents({
        sealState: "sealed_unopened",
        catalogUnitGrossCentsAtPurchase: cents,
      }),
      0
    );
  }
});

test("the proposal uses the PURCHASE-TIME snapshot, never a later shop price", () => {
  // The same 30 g package, bought when it cost 1499. If the shop later
  // charges 1799, the historical case must still propose 1499.
  const historical = suggestedValueLossCents({
    sealState: "opened_seal_broken",
    catalogUnitGrossCentsAtPurchase: 1499,
  });
  const ifWeHadReadTodaysPrice = suggestedValueLossCents({
    sealState: "opened_seal_broken",
    catalogUnitGrossCentsAtPurchase: 1799,
  });
  assert.equal(historical, 1499);
  assert.notEqual(historical, ifWeHadReadTodaysPrice);
});

test("more than one package scales by whole packages, never by consumption", () => {
  assert.equal(
    suggestedValueLossCents({
      sealState: "opened_seal_broken",
      catalogUnitGrossCentsAtPurchase: 2299,
      packages: 3,
    }),
    6897
  );
});

test("the module has no consumption concept at all", () => {
  const src = read("lib/withdrawalCase.ts");
  const code = src.replace(/\/\*\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const forbidden of ["gramsUsed", "grams_used", "percentUsed", "percent_used",
                           "consumed", "halfEmpty", "fillLevel", "remainingGrams"]) {
    assert.ok(!code.includes(forbidden), `withdrawalCase.ts grew a ${forbidden} concept`);
  }
});

test("it is never called a fee, a penalty or a processing charge", () => {
  const src = read("lib/withdrawalCase.ts");
  const code = src.replace(/\/\*\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const forbidden of ["Widerrufsgebuehr", "Widerrufsgebühr", "Bearbeitungsgebühr",
                           "processingFee", "penaltyCents", "feeCents", "Strafe"]) {
    assert.ok(!code.includes(forbidden), `withdrawalCase.ts names a ${forbidden}`);
  }
  // And the legally correct concept is the one that IS named.
  assert.match(src, /Wertersatz wegen Wertverlust/);
});

/* ══════════════════════════════════════════════════════════════
   WERTERSATZ - THE DECISION
   ══════════════════════════════════════════════════════════════ */

test("an admin may confirm the proposal exactly", () => {
  assert.deepEqual(isConfirmableValueLoss({ confirmedCents: 1499, suggestedCents: 1499 }),
    { ok: true });
});

test("an admin may REDUCE it - that is the point of confirming", () => {
  assert.deepEqual(isConfirmableValueLoss({ confirmedCents: 500, suggestedCents: 1499 }),
    { ok: true });
  assert.deepEqual(isConfirmableValueLoss({ confirmedCents: 0, suggestedCents: 1499 }),
    { ok: true });
});

test("nobody may raise it above the goods' frozen value", () => {
  const r = isConfirmableValueLoss({ confirmedCents: 1500, suggestedCents: 1499 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /never raised above/);
});

test("a negative or fractional deduction is refused", () => {
  assert.equal(isConfirmableValueLoss({ confirmedCents: -1, suggestedCents: 1499 }).ok, false);
  assert.equal(isConfirmableValueLoss({ confirmedCents: 10.5, suggestedCents: 1499 }).ok, false);
});

/* ══════════════════════════════════════════════════════════════
   THE REFUND
   ══════════════════════════════════════════════════════════════ */

test("an intact unopened return is refunded in full, shipping included", () => {
  // One 30 g delivery: 1349 goods + 590 outbound = 1939 paid.
  const r = computeRefund({
    paidGrossCents: 1939,
    merchandiseGrossCents: 1349,
    outboundShippingGrossCents: 590,
    confirmedValueLossCents: 0,
  });
  assert.equal(r.refundGrossCents, 1939, "BGB 357 Abs. 1 repays the delivery costs too");
  assert.equal(r.confirmedValueLossCents, 0);
});

test("the original outbound shipping is NEVER retained as a penalty", () => {
  const r = computeRefund({
    paidGrossCents: 1939, merchandiseGrossCents: 1349, outboundShippingGrossCents: 590,
  });
  assert.notEqual(r.refundGrossCents, 1939 - 590, "the 5,90 was kept back");
  assert.notEqual(r.refundGrossCents, 1349);
  assert.equal(r.refundGrossCents, 1939);
});

test("there is no hardcoded 'product price plus shipping retained' rule", () => {
  const src = read("lib/withdrawalCase.ts");
  const code = src.replace(/\/\*\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!code.includes("590"), "a shipping amount is hardcoded into the refund logic");
  // The only subtraction in the breakdown is the confirmed value loss.
  assert.match(code, /paidGrossCents - confirmed/);
});

test("a confirmed value loss is the only thing subtracted", () => {
  const r = computeRefund({
    paidGrossCents: 1939,
    merchandiseGrossCents: 1349,
    outboundShippingGrossCents: 590,
    confirmedValueLossCents: 1499,
  });
  assert.equal(r.refundGrossCents, 440);
});

test("the refund is floored at zero and never becomes an invoice", () => {
  const r = computeRefund({
    paidGrossCents: 1000, merchandiseGrossCents: 800, outboundShippingGrossCents: 200,
    confirmedValueLossCents: 3999,
  });
  assert.equal(r.refundGrossCents, 0);
});

test("return postage never appears as a deduction line", () => {
  const r = computeRefund({
    paidGrossCents: 1939, merchandiseGrossCents: 1349, outboundShippingGrossCents: 590,
  });
  assert.ok(!("returnShippingGrossCents" in r),
    "return postage is the consumer's own payment to a carrier, not our deduction");
  assert.deepEqual(Object.keys(r).sort(), [
    "confirmedValueLossCents", "merchandiseGrossCents", "outboundShippingGrossCents",
    "paidGrossCents", "refundGrossCents",
  ]);
});

test("the calculator refuses nonsense rather than coercing it", () => {
  assert.throws(() => computeRefund({
    paidGrossCents: -1, merchandiseGrossCents: 0, outboundShippingGrossCents: 0,
  }), /non-negative integer paidGrossCents/);
  assert.throws(() => computeRefund({
    paidGrossCents: 100, merchandiseGrossCents: 0, outboundShippingGrossCents: 0,
    confirmedValueLossCents: -5,
  }), /confirmedValueLossCents/);
});

/* ══════════════════════════════════════════════════════════════
   THE HOLD
   ══════════════════════════════════════════════════════════════ */

const DECLARED = "2026-06-01T10:00:00Z";

test("no return asked for: nothing to wait for", () => {
  const s = refundHoldState({
    returnRequirement: "return_not_required",
    returnDispatchProofAt: null, returnReceivedAt: null,
    declaredAt: DECLARED, now: "2026-06-02T10:00:00Z",
  });
  assert.equal(s.mayPayOut, true);
  assert.equal(s.refundState, "approved_for_payout");
});

test("waiting for goods holds the money", () => {
  const s = refundHoldState({
    returnRequirement: "return_requested",
    returnDispatchProofAt: null, returnReceivedAt: null,
    declaredAt: DECLARED, now: "2026-06-05T10:00:00Z",
  });
  assert.equal(s.caseState, "awaiting_return");
  assert.equal(s.refundState, "on_hold_awaiting_return");
  assert.equal(s.mayPayOut, false);
});

test("BGB 357 Abs. 4: proof of dispatch alone releases the hold", () => {
  const s = refundHoldState({
    returnRequirement: "return_requested",
    returnDispatchProofAt: "2026-06-04T09:00:00Z", returnReceivedAt: null,
    declaredAt: DECLARED, now: "2026-06-05T10:00:00Z",
  });
  assert.equal(s.caseState, "return_in_transit");
  assert.equal(s.mayPayOut, true);
});

test("goods back releases the hold", () => {
  const s = refundHoldState({
    returnRequirement: "return_requested",
    returnDispatchProofAt: null, returnReceivedAt: "2026-06-08T09:00:00Z",
    declaredAt: DECLARED, now: "2026-06-09T10:00:00Z",
  });
  assert.equal(s.caseState, "return_received");
  assert.equal(s.mayPayOut, true);
});

test("an OVERDUE return is still only a hold - never an automatic deduction", () => {
  const s = refundHoldState({
    returnRequirement: "return_requested",
    returnDispatchProofAt: null, returnReceivedAt: null,
    declaredAt: DECLARED, now: "2026-07-01T10:00:00Z",
  });
  assert.equal(s.caseState, "overdue_return");
  assert.equal(s.refundState, "on_hold_awaiting_return");
  assert.equal(s.mayPayOut, false);
  assert.match(s.reason, /never an automatic deduction/);
  // And crucially: it produced no value-loss figure of its own.
  assert.ok(!("valueLossCents" in s));
});

test("the return window is the statutory fourteen days", () => {
  assert.equal(RETURN_WINDOW_DAYS, 14);
  assert.equal(returnIsOverdue(DECLARED, "2026-06-14T10:00:00Z"), false);
  assert.equal(returnIsOverdue(DECLARED, "2026-06-20T10:00:00Z"), true);
});

/* ══════════════════════════════════════════════════════════════
   THE FREEZE DECISION
   ══════════════════════════════════════════════════════════════ */

test("everything except a provably late case freezes future deliveries", () => {
  assert.equal(withdrawalProtectsFutureDeliveries("timely"), true);
  assert.equal(withdrawalProtectsFutureDeliveries("receipt_unknown"), true);
  assert.equal(withdrawalProtectsFutureDeliveries("deadline_uncertain"), true);
  assert.equal(withdrawalProtectsFutureDeliveries("late"), false);
});

/* ══════════════════════════════════════════════════════════════
   THE RETURN-COST SENTENCE
   ══════════════════════════════════════════════════════════════ */

test("the EGBGB return-cost sentence is pinned exactly", () => {
  assert.equal(WITHDRAWAL_RETURN_COST_SENTENCE,
    "Sie tragen die unmittelbaren Kosten der Rücksendung der Waren.");
});

/* ══════════════════════════════════════════════════════════════
   IDENTIFICATION
   ══════════════════════════════════════════════════════════════ */

const CONTRACT = {
  orderId: "order-1",
  userId: "user-1",
  contactEmail: "Kundin@Example.com",
  annualPlanId: null,
  deliveredAt: "2026-06-01T09:00:00Z",
};

test("a signed-in owner is identified by the session", () => {
  const r = identifies(CONTRACT, { contactEmail: "someone-else@example.com", sessionUserId: "user-1" });
  assert.equal(r.resolved, true);
  assert.equal(r.method, "authenticated_session");
});

test("a guest is identified by reference plus the order's own address", () => {
  const r = identifies(CONTRACT, { contactEmail: "  kundin@example.COM " });
  assert.equal(r.resolved, true, "case and whitespace must not defeat identification");
  assert.equal(r.method, "order_number_and_email");
});

test("knowing the reference alone identifies nobody", () => {
  const r = identifies(CONTRACT, { contactEmail: "attacker@example.com" });
  assert.equal(r.resolved, false);
  assert.equal(r.method, "unresolved");
});

test("a different session does not identify", () => {
  const r = identifies(CONTRACT, { contactEmail: "attacker@example.com", sessionUserId: "user-2" });
  assert.equal(r.resolved, false);
});

/* ══════════════════════════════════════════════════════════════
   WHICH RECEIPT STARTS THE PERIOD
   ══════════════════════════════════════════════════════════════ */

test("an ordinary order dates from its own receipt", async () => {
  const r = await resolveReceipt({ annualPlanDeliveries: async () => [] }, CONTRACT);
  assert.equal(r.receiptAt, "2026-06-01T09:00:00Z");
  assert.equal(r.basis, "single_delivery_receipt");
});

test("an annual plan dates from delivery ONE, whatever else arrived", async () => {
  const deps = {
    annualPlanDeliveries: async () => [
      { deliveryNumber: 3, deliveredAt: "2026-08-01T09:00:00Z" },
      { deliveryNumber: 1, deliveredAt: "2026-06-01T09:00:00Z" },
      { deliveryNumber: 2, deliveredAt: "2026-07-01T09:00:00Z" },
    ],
  };
  const r = await resolveReceipt(deps, { ...CONTRACT, annualPlanId: "plan-1", deliveredAt: "2026-08-01T09:00:00Z" });
  assert.equal(r.receiptAt, "2026-06-01T09:00:00Z", "the order's own delivered_at must not win");
  assert.equal(r.basis, "first_delivery_receipt_regular_delivery");
});

test("an annual plan whose first box has no receipt is unknown, not dated from box two", async () => {
  const deps = {
    annualPlanDeliveries: async () => [
      { deliveryNumber: 1, deliveredAt: null },
      { deliveryNumber: 2, deliveredAt: "2026-07-01T09:00:00Z" },
    ],
  };
  const r = await resolveReceipt(deps, { ...CONTRACT, annualPlanId: "plan-1" });
  assert.equal(r.receiptAt, null);
});

/* ══════════════════════════════════════════════════════════════
   THE SUBMISSION
   ══════════════════════════════════════════════════════════════ */

function harness(overrides = {}) {
  const state = { inserted: [], frozen: [], confirmations: [], marks: [] };
  const deps = {
    findContractByReference: async () => null,
    annualPlanDeliveries: async () => [],
    findByIdempotencyKey: async () => null,
    insertCase: async row => {
      state.inserted.push(row);
      return { id: `case-${state.inserted.length}`, submittedAt: "2026-06-10T12:00:00Z" };
    },
    freezeDeliveries: async id => { state.frozen.push(id); },
    sendConfirmation: async input => { state.confirmations.push(input); return true; },
    markConfirmation: async (id, sent) => { state.marks.push({ id, sent }); },
    now: () => new Date("2026-06-10T12:00:00Z"),
    ...overrides,
  };
  return { deps, state };
}

const BASE = {
  customerName: "A. Kundin",
  contactEmail: "kundin@example.com",
  orderReference: "GLOA-2026-000462",
  scope: "whole_order",
};

test("a logged-out declaration with no matching order is still recorded", async () => {
  const { deps, state } = harness();
  const r = await submitWithdrawal(deps, BASE);
  assert.equal(r.ok, true);
  assert.equal(state.inserted.length, 1, "the declaration must survive a failed lookup");
  assert.equal(state.inserted[0].resolution_method, "unresolved");
  assert.equal(state.inserted[0].timeliness, "receipt_unknown");
  assert.equal(state.inserted[0].case_state, "submitted");
});

test("NO ENUMERATION: matched and unmatched references return an identical shape", async () => {
  const matched = harness({
    findContractByReference: async () => ({ ...CONTRACT, contactEmail: "kundin@example.com" }),
  });
  const unmatched = harness();
  const a = await submitWithdrawal(matched.deps, BASE);
  const b = await submitWithdrawal(unmatched.deps, BASE);
  assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort());
  assert.deepEqual(a, b, "the response differed between a real and an unknown reference");
});

test("the result exposes no case id, timeliness or resolution", async () => {
  const { deps } = harness({
    findContractByReference: async () => ({ ...CONTRACT, contactEmail: "kundin@example.com" }),
  });
  const r = await submitWithdrawal(deps, BASE);
  for (const leak of ["caseId", "id", "timeliness", "deadlineDate", "resolvedOrderId",
                      "resolutionMethod", "refundGrossCents"]) {
    assert.ok(!(leak in r), `the public result leaks ${leak}`);
  }
});

test("a resolved order is linked, dated and stored", async () => {
  const { deps, state } = harness({
    findContractByReference: async () => ({ ...CONTRACT, contactEmail: "kundin@example.com" }),
  });
  await submitWithdrawal(deps, BASE);
  const row = state.inserted[0];
  assert.equal(row.resolved_order_id, "order-1");
  assert.equal(row.resolved_user_id, "user-1");
  assert.equal(row.resolution_method, "order_number_and_email");
  // Received 1 June, declared 10 June -> comfortably in time.
  assert.equal(row.timeliness, "timely");
  assert.equal(row.deadline_date, "2026-06-15");
  assert.equal(row.deadline_basis, "single_delivery_receipt");
});

test("IDEMPOTENCY: the same key returns the first submission and inserts nothing", async () => {
  const { deps, state } = harness({
    findByIdempotencyKey: async () => ({ id: "case-existing", submittedAt: "2026-06-10T11:00:00Z" }),
  });
  const r = await submitWithdrawal(deps, { ...BASE, idempotencyKey: "abcdefgh1234" });
  assert.equal(r.duplicate, true);
  assert.equal(r.submittedAt, "2026-06-10T11:00:00Z");
  assert.equal(state.inserted.length, 0, "a double click created a second declaration");
  assert.equal(state.confirmations.length, 0, "a double click sent a second confirmation");
});

test("FREEZE: a timely annual withdrawal freezes future deliveries", async () => {
  const { deps, state } = harness({
    findContractByReference: async () => ({
      ...CONTRACT, contactEmail: "kundin@example.com", annualPlanId: "plan-1",
    }),
    annualPlanDeliveries: async () => [{ deliveryNumber: 1, deliveredAt: "2026-06-01T09:00:00Z" }],
  });
  await submitWithdrawal(deps, BASE);
  assert.deepEqual(state.frozen, ["case-1"]);
  assert.equal(state.inserted[0].resolved_annual_plan_id, "plan-1");
});

test("FREEZE: an UNKNOWN receipt freezes too - we cannot safely refuse it", async () => {
  const { deps, state } = harness({
    findContractByReference: async () => ({
      ...CONTRACT, contactEmail: "kundin@example.com", annualPlanId: "plan-1",
    }),
    annualPlanDeliveries: async () => [{ deliveryNumber: 1, deliveredAt: null }],
  });
  await submitWithdrawal(deps, BASE);
  assert.equal(state.inserted[0].timeliness, "receipt_unknown");
  assert.deepEqual(state.frozen, ["case-1"], "an undateable case must still stop the boxes");
});

test("FREEZE: a provably late annual withdrawal does NOT freeze", async () => {
  const { deps, state } = harness({
    findContractByReference: async () => ({
      ...CONTRACT, contactEmail: "kundin@example.com", annualPlanId: "plan-1",
    }),
    // Received in January, declared in June.
    annualPlanDeliveries: async () => [{ deliveryNumber: 1, deliveredAt: "2026-01-05T09:00:00Z" }],
  });
  await submitWithdrawal(deps, BASE);
  assert.equal(state.inserted[0].timeliness, "late");
  assert.deepEqual(state.frozen, []);
});

test("a later annual delivery cannot revive a late case or re-freeze it", async () => {
  const { deps, state } = harness({
    findContractByReference: async () => ({
      ...CONTRACT, contactEmail: "kundin@example.com", annualPlanId: "plan-1",
    }),
    annualPlanDeliveries: async () => [
      { deliveryNumber: 1, deliveredAt: "2026-01-05T09:00:00Z" },
      { deliveryNumber: 6, deliveredAt: "2026-06-09T09:00:00Z" }, // yesterday
    ],
  });
  await submitWithdrawal(deps, BASE);
  assert.equal(state.inserted[0].timeliness, "late", "delivery six restarted the period");
  assert.deepEqual(state.frozen, []);
});

test("an unresolved declaration freezes nothing - there is no plan to freeze", async () => {
  const { deps, state } = harness();
  await submitWithdrawal(deps, BASE);
  assert.deepEqual(state.frozen, []);
});

test("a failed freeze still keeps the declaration", async () => {
  const { deps, state } = harness({
    findContractByReference: async () => ({
      ...CONTRACT, contactEmail: "kundin@example.com", annualPlanId: "plan-1",
    }),
    annualPlanDeliveries: async () => [{ deliveryNumber: 1, deliveredAt: "2026-06-01T09:00:00Z" }],
    freezeDeliveries: async () => { throw new Error("db down"); },
  });
  const r = await submitWithdrawal(deps, BASE);
  assert.equal(r.ok, true);
  assert.equal(state.inserted.length, 1);
});

test("the durable record is written before the confirmation is attempted", async () => {
  const order = [];
  const { deps } = harness({
    insertCase: async () => { order.push("insert"); return { id: "c1", submittedAt: "t" }; },
    sendConfirmation: async () => { order.push("send"); return true; },
  });
  await submitWithdrawal(deps, BASE);
  assert.deepEqual(order, ["insert", "send"]);
});

test("a failed confirmation does not lose the declaration, and is reported honestly", async () => {
  const { deps, state } = harness({
    sendConfirmation: async () => { throw new Error("resend down"); },
  });
  const r = await submitWithdrawal(deps, BASE);
  assert.equal(r.ok, true);
  assert.equal(r.confirmationEmailSent, false, "it must not claim a mail it did not send");
  assert.equal(state.inserted.length, 1);
  assert.deepEqual(state.marks, [{ id: "case-1", sent: false }]);
});

test("a lookup that throws does not lose the declaration", async () => {
  const { deps, state } = harness({
    findContractByReference: async () => { throw new Error("db down"); },
  });
  const r = await submitWithdrawal(deps, BASE);
  assert.equal(r.ok, true);
  assert.equal(state.inserted[0].resolution_method, "unresolved");
});

/* ══════════════════════════════════════════════════════════════
   WHAT THE BROWSER MAY NEVER SUPPLY
   ══════════════════════════════════════════════════════════════ */

test("the submission input type accepts no authoritative field", () => {
  const src = read("lib/withdrawalSubmission.ts");
  const iface = src.slice(
    src.indexOf("export interface WithdrawalSubmissionInput"),
    src.indexOf("}", src.indexOf("export interface WithdrawalSubmissionInput"))
  );
  for (const forbidden of ["timeliness", "deadline", "deliveredAt", "receiptAt", "refund",
                           "valueLoss", "sealState", "returnReceived", "caseState"]) {
    assert.ok(!iface.includes(forbidden),
      `a client may supply ${forbidden}, which the server must decide`);
  }
});

test("extra client-supplied fields are ignored, not written through", async () => {
  const { deps, state } = harness();
  await submitWithdrawal(deps, {
    ...BASE,
    timeliness: "timely",
    deadline_date: "2099-01-01",
    refund_amount_cents: 999999,
    seal_state: "sealed_unopened",
    case_state: "refunded",
  });
  const row = state.inserted[0];
  assert.equal(row.timeliness, "receipt_unknown", "a client set the timeliness");
  assert.equal(row.deadline_date, null, "a client set the deadline");
  assert.equal(row.case_state, "submitted", "a client set the case state");
  assert.ok(!("refund_amount_cents" in row), "a client-supplied refund reached the row");
  assert.ok(!("seal_state" in row), "a client-supplied seal state reached the row");
});
