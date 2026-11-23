import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../lib/matchaFirstCheckout.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const calls = [];
const module = { exports: {} };
vm.runInNewContext(compiled, {
  module, exports: module.exports, require: () => ({
    getSupabaseAdmin: () => ({ rpc: async (name, args) => { calls.push({ name, args }); return { error: null }; } }),
  }),
});
const { releaseTerminalFirstMatchaCheckout: release } = module.exports;
const session = {
  id: "cs_first", mode: "subscription", status: "expired", payment_status: "unpaid",
  invoice: null, subscription: null, payment_intent: null,
  metadata: { gloa_first_matcha: "subscription", checkout_attempt_id: "attempt", request_id: "request" },
};
function stripe(current, intentStatus = "canceled") {
  return {
    checkout: { sessions: { retrieve: async id => { assert.equal(id, session.id); return current; } } },
    paymentIntents: { retrieve: async id => ({ id, status: intentStatus }) },
  };
}

test("an expired, unpaid Subscription Session without any payment object releases the exact hold", async () => {
  await release(stripe(session), session);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.target, session.metadata.checkout_attempt_id);
  assert.equal(calls[0].args.session_key, session.id);
  assert.equal(calls[0].args.terminal_state, "expired");
  calls.length = 0;
});

test("open, paid and uncertain first Sessions retain stock", async () => {
  for (const update of [
    { status: "open" }, { status: "complete" }, { payment_status: "paid" },
    { subscription: "sub_payable" }, { invoice: "in_payable" }, { payment_intent: "pi_payable" },
  ]) await release(stripe({ ...session, ...update }), session);
  await assert.rejects(release(stripe({ ...session, metadata: { ...session.metadata, request_id: "other" } }), session), /identity mismatch/i);
  await assert.rejects(release({ checkout: { sessions: { retrieve: async () => { throw new Error("timeout"); } } } }, session), /timeout/);
  assert.equal(calls.length, 0);
});

test("a closed first payment Session releases only after its PaymentIntent is canceled", async () => {
  for (const kind of ["annual", "b2b"]) {
    const payment = {
      ...session, mode: "payment", status: "complete", payment_intent: "pi_first",
      metadata: { ...session.metadata, gloa_first_matcha: kind },
    };
    await release(stripe(payment, "processing"), payment);
    await release(stripe({ ...payment, status: "open" }), payment);
    assert.equal(calls.length, 0);
    await release(stripe(payment), payment);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].args.terminal_state, "failed");
    calls.length = 0;
  }
});
