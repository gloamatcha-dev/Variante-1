import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ANNUAL_REFUND_WRITER_RESULTS,
  annualRefundWriterWroteAChange,
  interpretAnnualRefundWriterResult,
  runAnnualPlanRefundSync,
} from "../lib/annualPlanRefundRules.ts";
// THE PRODUCTION SUMMARISER, not a stand-in: every cumulative total and
// every currency refusal below is computed by the same function the
// one-time and subscription refund paths use.
import { summarizeStripeRefunds } from "../lib/stripeRefunds.ts";
import { runAnnualDeliveryWorker } from "../lib/annualDeliveryWorker.ts";
import { ANNUAL_DELIVERY_COUNT, ANNUAL_DELIVERY_INTERVAL_DAYS } from "../lib/annualPlanRules.ts";

/* ══════════════════════════════════════════════════════════════
   PHASE 4B7 - ANNUAL REFUND CORRELATION AND MONEY STATE

   SAFE DEFAULT SUITE: the pure refund flow driven through in-memory
   ports, an emulation of migration 039's installed writer, the real
   delivery worker against an emulated queue, and source-level checks on
   the wiring.

   NO Stripe client is constructed, NO refund is created, no Stripe
   object is retrieved, no Supabase client exists, no SQL runs, no RPC is
   invoked, no webhook is delivered and no email is sent. Nothing here
   reads a wall clock.

   What it protects: money that has already been taken and money that has
   already been given back. A refund against a prepaid year must land on
   the plan it belongs to and on nothing else, must never be counted
   twice, must never move backwards because an old event was redelivered,
   and must never quietly stop deliveries a customer is still owed.
   ══════════════════════════════════════════════════════════════ */

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf-8");
const NEWLINE = String.fromCharCode(10);

const withoutComments = source => source
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split(NEWLINE)
  .filter(line => {
    const t = line.trim();
    return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
  })
  .join(NEWLINE);

const MIGRATION_039 = "supabase/migrations/039_b2c_annual_plan_foundation.sql";
const m039 = read(MIGRATION_039);

const rulesCode = withoutComments(read("lib/annualPlanRefundRules.ts"));
const wiringCode = withoutComments(read("lib/annualPlanRefunds.ts"));
const routeCode = withoutComments(read("app/api/stripe/webhook/route.ts"));
const orderRefundsCode = withoutComments(read("lib/orderRefunds.ts"));

const PLAN_ID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const ANNUAL_PI = "pi_annual_2026";
const OTHER_PI = "pi_one_time_2026";

/** The three live annual totals, as FIXTURES. The runtime knows none of them. */
const TOTALS = { "30g": 31057, "50g": 35087, "100g": 64337 };

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const PURCHASED_AT = Date.parse("2026-01-05T10:00:00.000Z");

const refund = (amount, status = "succeeded", currency = "eur") => ({ amount, currency, status });

/** console.error is noise here; every assertion is about state. */
const quiet = async fn => {
  const original = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = original;
  }
};

/* ══════════════════════════════════════════════════════════════
   AN IN-MEMORY EMULATION OF MIGRATION 039's INSTALLED WRITER

   Faithful to the SQL: validation before the lock, resolution by the
   PaymentIntent alone, 'pending' has no refund story, a total above the
   plan's own is refused outright, zero walks back to 'paid', the full
   total is 'refunded', anything between is 'partially_refunded', and an
   identical restatement writes nothing at all. Cross-checked against the
   migration source further down.
   ══════════════════════════════════════════════════════════════ */

const annualWorld = ({
  total = TOTALS["30g"],
  paymentStatus = "paid",
  refundedTotalCents = 0,
  paymentIntentId = ANNUAL_PI,
  deliveries = null,
} = {}) => {
  const plan = {
    id: PLAN_ID,
    status: "active",
    currency: "EUR",
    total_gross_cents: total,
    payment_status: paymentStatus,
    refunded_total_cents: refundedTotalCents,
    refund_updated_at: null,
    stripe_payment_intent_id: paymentIntentId,
  };

  const rows = deliveries ?? Array.from({ length: ANNUAL_DELIVERY_COUNT }, (unused, i) => ({
    id: `d${i + 1}`,
    annual_plan_id: PLAN_ID,
    delivery_number: i + 1,
    scheduled_for: PURCHASED_AT + i * ANNUAL_DELIVERY_INTERVAL_DAYS * DAY_MS,
    state: "scheduled",
    checkout_attempt_id: null,
    order_id: null,
    claimed_at: null,
    fulfilled_at: null,
  }));

  const writes = [];
  const orders = new Map();
  const attempts = new Map();
  let clock = PURCHASED_AT + DAY_MS;

  /** public.apply_annual_plan_refund_state(text, integer). */
  const applyRefundState = async ({ paymentIntentId: intent, refundedTotalCents: cents }) => {
    if (typeof intent !== "string" || intent.trim() === "") return "invalid_input";
    if (typeof cents !== "number" || !Number.isInteger(cents) || cents < 0) return "invalid_input";
    if (intent.trim() !== plan.stripe_payment_intent_id) return "plan_not_found";
    if (plan.payment_status === "pending") return "not_applicable";
    if (cents > plan.total_gross_cents) return "invalid_amount";

    const next = cents === 0
      ? "paid"
      : cents >= plan.total_gross_cents ? "refunded" : "partially_refunded";

    if (plan.payment_status === next && plan.refunded_total_cents === cents) return "unchanged";

    writes.push({ payment_status: next, refunded_total_cents: cents });
    plan.payment_status = next;
    plan.refunded_total_cents = cents;
    plan.refund_updated_at = clock;
    return "applied";
  };

  /** public.claim_due_annual_plan_deliveries(p_limit), predicates included. */
  const claimDue = async limit => {
    const bounded = Math.min(Math.max(limit ?? 25, 1), 100);
    return rows
      .filter(d =>
        plan.status === "active"
        && plan.payment_status !== "refunded"
        && d.order_id === null
        && d.fulfilled_at === null
        && (
          (d.state === "scheduled" && d.scheduled_for <= clock)
          || (d.state === "claimed" && d.claimed_at !== null && d.claimed_at < clock - 6 * HOUR_MS)
        ))
      .sort((a, b) => a.scheduled_for - b.scheduled_for)
      .slice(0, bounded)
      .map(d => {
        const reclaimed = d.state === "claimed";
        d.state = "claimed";
        d.claimed_at = clock;
        return {
          delivery_id: d.id,
          annual_plan_id: PLAN_ID,
          delivery_number: d.delivery_number,
          scheduled_for: new Date(d.scheduled_for).toISOString(),
          reclaimed,
        };
      });
  };

  /** public.fulfill_annual_plan_delivery(p_delivery_id), guards included. */
  const fulfillDelivery = async deliveryId => {
    const d = rows.find(row => row.id === deliveryId);
    if (!d) return { result: "not_found" };
    if (d.state === "fulfilled") {
      return {
        result: "already_fulfilled",
        delivery_id: d.id,
        delivery_number: d.delivery_number,
        checkout_attempt_id: d.checkout_attempt_id,
        order_id: d.order_id,
      };
    }
    // THE AUTHORITATIVE GUARD, re-read under the parent lock.
    if (plan.status !== "active") return { result: "plan_not_active", status: plan.status };
    if (plan.payment_status === "refunded") return { result: "plan_refunded" };
    if (d.state !== "claimed") return { result: "delivery_not_claimed", state: d.state };

    const attempt = {
      id: `a${d.delivery_number}`,
      annual_plan_id: PLAN_ID,
      annual_delivery_number: d.delivery_number,
      // The synthetic attempt carries NO Stripe identity. This is the
      // property that makes an annual delivery order useless for refund
      // correlation, and migration 039's CHECK is what enforces it.
      stripe_payment_intent_id: null,
      stripe_invoice_id: null,
      stripe_checkout_session_id: null,
      subscription_id: null,
    };
    attempts.set(attempt.id, attempt);
    const order = {
      id: `o${d.delivery_number}`,
      checkout_attempt_id: attempt.id,
      stripe_payment_intent_id: null,
    };
    orders.set(order.id, order);

    d.state = "fulfilled";
    d.checkout_attempt_id = attempt.id;
    d.order_id = order.id;
    d.fulfilled_at = clock;
    return { result: "fulfilled", delivery_id: d.id, order_id: order.id };
  };

  return {
    plan,
    rows,
    writes,
    orders,
    attempts,
    setNow: value => { clock = value; },
    applyRefundState,
    workerDeps: { claimDue, fulfillDelivery },
  };
};

/**
 * The annual refund flow, wired exactly as lib/annualPlanRefunds.ts wires
 * it: the world's plan lookup, a Stripe refund list, the PRODUCTION
 * summariser, and the emulated writer.
 */
const refundPorts = (w, { refunds = [], plans = null, onList } = {}) => {
  const calls = { list: 0, lookup: 0, write: 0 };
  return {
    calls,
    ports: {
      findPlanByPaymentIntent: async intent => {
        calls.lookup += 1;
        const table = plans ?? [w.plan];
        const match = table.filter(p => p.stripe_payment_intent_id === intent);
        return match.length === 1
          ? { id: match[0].id, currency: match[0].currency, total_gross_cents: match[0].total_gross_cents }
          : null;
      },
      listRefunds: async intent => {
        calls.list += 1;
        if (onList) onList(intent);
        return refunds;
      },
      summarizeRefunds: (list, expectedCurrency) => summarizeStripeRefunds(list, expectedCurrency),
      applyRefundState: async input => {
        calls.write += 1;
        return w.applyRefundState(input);
      },
    },
  };
};

/* ══════════════════════════════════════════════════════════════
   1-4. THE VOCABULARY, READ OFF THE INSTALLED FUNCTION
   ══════════════════════════════════════════════════════════════ */

test("1: every word the installed writer can answer is mapped, and no other", () => {
  const fn = m039.slice(
    m039.indexOf("create or replace function public.apply_annual_plan_refund_state"),
    m039.indexOf("-- 12. THE ANNUAL PURCHASE CONFIRMATION'S WRITE SURFACE")
  );
  assert.ok(fn.length > 0, "the refund writer moved");

  const returned = [...fn.matchAll(/return '([a-z_]+)';/g)].map(m => m[1]);
  assert.deepEqual([...new Set(returned)].sort(), [...ANNUAL_REFUND_WRITER_RESULTS].sort(),
    "the migration and the runtime disagree about the refund vocabulary");
  assert.equal(ANNUAL_REFUND_WRITER_RESULTS.length, 6);
});

test("2: an unrecognised answer fails closed rather than passing as success", () => {
  for (const word of ANNUAL_REFUND_WRITER_RESULTS) {
    assert.equal(interpretAnnualRefundWriterResult(word), word);
  }
  for (const junk of ["ok", "success", "APPLIED", "", null, undefined, 42, {}, ["applied"]]) {
    assert.equal(interpretAnnualRefundWriterResult(junk), "unknown", `a junk answer passed: ${String(junk)}`);
  }
  // And only one word means the row moved.
  assert.equal(annualRefundWriterWroteAChange("applied"), true);
  for (const word of ["unchanged", "not_applicable", "invalid_amount", "plan_not_found", "invalid_input", "unknown"]) {
    assert.equal(annualRefundWriterWroteAChange(word), false);
  }
});

test("3: an unknown writer answer throws, and nothing is reported as done", async () => {
  const w = annualWorld();
  const { ports } = refundPorts(w, { refunds: [refund(5000)] });
  await assert.rejects(
    () => runAnnualPlanRefundSync({ ...ports, applyRefundState: async () => "something_new" }, ANNUAL_PI),
    /unrecognised writer result/
  );
  assert.equal(w.plan.payment_status, "paid");
});

test("4: the writer is asked with the PaymentIntent, never a plan uuid", () => {
  assert.match(wiringCode, /p_stripe_payment_intent_id: input\.paymentIntentId/);
  assert.match(wiringCode, /p_refunded_total_cents: input\.refundedTotalCents/);
  const call = wiringCode.slice(wiringCode.indexOf('admin.rpc("apply_annual_plan_refund_state"'));
  assert.ok(!call.includes("annualPlanId"), "a plan uuid is passed to the writer");
  assert.ok(!call.includes("plan.id"), "a plan uuid is passed to the writer");
});

/* ══════════════════════════════════════════════════════════════
   5-8. ROUTING
   ══════════════════════════════════════════════════════════════ */

test("5: an annual PaymentIntent reaches the annual writer", async () => {
  const w = annualWorld();
  const { calls, ports } = refundPorts(w, { refunds: [refund(5000)] });

  const outcome = await runAnnualPlanRefundSync(ports, ANNUAL_PI);

  assert.equal(outcome.kind, "annual");
  assert.equal(outcome.annualPlanId, PLAN_ID);
  assert.equal(outcome.result, "applied");
  assert.equal(outcome.refundedTotalCents, 5000);
  assert.equal(calls.write, 1);
});

test("6: a NON-annual PaymentIntent writes nothing and reads nothing from Stripe", async () => {
  const w = annualWorld();
  const { calls, ports } = refundPorts(w, { refunds: [refund(5000)] });

  const outcome = await runAnnualPlanRefundSync(ports, OTHER_PI);

  assert.deepEqual(outcome, { kind: "not_annual" });
  assert.equal(calls.lookup, 1);
  // The Stripe request is not even issued: an ordinary one-time or
  // subscription refund pays nothing for the annual branch existing.
  assert.equal(calls.list, 0);
  assert.equal(calls.write, 0);
  assert.deepEqual(w.writes, []);
});

test("7: the ordinary refund flow runs unchanged when the intent is not annual", () => {
  const handler = routeCode.slice(
    routeCode.indexOf("async function handleRefundEvent"),
    routeCode.indexOf("async function handleCheckoutSessionCompleted")
  );
  const guard = handler.indexOf("if (!paymentIntentId) {");
  const annual = handler.indexOf("syncAnnualPlanRefundStateFromStripe(stripe, paymentIntentId)");
  const ordinary = handler.indexOf("syncOrderRefundStateFromStripe(stripe, paymentIntentId)");
  const email = handler.indexOf("sendRefundConfirmationIfNeeded(outcome.orderId)");

  // The payment-intent guard still precedes everything.
  assert.ok(guard > -1 && annual > guard, "the annual branch runs before the payment intent is proved");
  // Annual first, then the untouched ordinary flow, then its email.
  assert.ok(annual < ordinary, "an annual intent could fall into the order refund flow");
  assert.ok(ordinary < email, "the email is attempted before the refund state is durable");
  // The annual arm returns rather than continuing into the order flow.
  const arm = handler.slice(annual, ordinary);
  assert.match(arm, /if \(annual\.kind === "annual"\) \{/);
  assert.ok(arm.includes("return;"), "the annual arm falls through into the order refund flow");
  // And the ordinary path's own calls are byte-identical to what they were.
  assert.ok(orderRefundsCode.includes("stripe.refunds.list({ payment_intent: trimmedId, limit: 100 })"));
  assert.ok(orderRefundsCode.includes("summarizeStripeRefunds(refunds.data, order[0].currency)"));
  assert.ok(orderRefundsCode.includes('admin.rpc("apply_order_refund_state"'));
  assert.ok(orderRefundsCode.includes('admin.rpc("apply_order_refund_state_by_invoice"'));
});

test("8: the existing refund modules know nothing about the annual plan", () => {
  // CONTENT, not a working-tree diff: after this phase is committed a
  // `git diff HEAD` guard would pass vacuously. What must stay true is
  // that the annual path is ADDITIVE - the one-time and subscription
  // refund modules neither import it, name it, nor branch on it.
  for (const rel of [
    "lib/orderRefunds.ts",
    "lib/stripeRefunds.ts",
    "lib/refundConfirmationRules.ts",
    "lib/refundConfirmationEmail.ts",
  ]) {
    const source = read(rel);
    for (const banned of [
      "annual", "Annual", "annual_plans", "apply_annual_plan_refund_state",
    ]) {
      assert.ok(!source.includes(banned), `${rel} was taught about the annual plan: ${banned}`);
    }
  }
  // And the subscription correlation still resolves the way 3J.B2 left it.
  assert.match(orderRefundsCode, /stripe\.invoicePayments\.list\(/);
  assert.match(orderRefundsCode, /correlateInvoiceFromInvoicePayments\(/);
  assert.match(orderRefundsCode, /\.eq\("stripe_payment_intent_id", trimmedId\)/);
  // The working tree agrees too, while it still can.
  const changed = execFileSync("git", ["diff", "--name-only", "HEAD", "--"],
    { cwd: ROOT, encoding: "utf-8" }).trim();
  for (const rel of changed ? changed.split(NEWLINE) : []) {
    assert.ok(!rel.startsWith("lib/orderRefunds") && !rel.startsWith("lib/stripeRefunds"),
      `this phase edited ${rel}`);
  }
});

/* ══════════════════════════════════════════════════════════════
   9-12. PARTIAL, FULL, CUMULATIVE, REPLAY
   ══════════════════════════════════════════════════════════════ */

test("9: a partial refund is recorded truthfully for every live annual total", async () => {
  for (const [label, total] of Object.entries(TOTALS)) {
    const w = annualWorld({ total });
    const { ports } = refundPorts(w, { refunds: [refund(1000)] });

    const outcome = await runAnnualPlanRefundSync(ports, ANNUAL_PI);

    assert.equal(outcome.result, "applied", label);
    assert.equal(w.plan.payment_status, "partially_refunded", label);
    assert.equal(w.plan.refunded_total_cents, 1000, label);
    // One cent short of the total is still partial.
    const edge = annualWorld({ total });
    const near = refundPorts(edge, { refunds: [refund(total - 1)] });
    await runAnnualPlanRefundSync(near.ports, ANNUAL_PI);
    assert.equal(edge.plan.payment_status, "partially_refunded", label);
  }
});

test("10: a full refund is exactly the plan total, and it is the only thing that refunds", async () => {
  for (const [label, total] of Object.entries(TOTALS)) {
    const w = annualWorld({ total });
    const { ports } = refundPorts(w, { refunds: [refund(total)] });

    const outcome = await runAnnualPlanRefundSync(ports, ANNUAL_PI);

    assert.equal(outcome.result, "applied", label);
    assert.equal(w.plan.payment_status, "refunded", label);
    assert.equal(w.plan.refunded_total_cents, total, label);
  }
});

test("11: several refunds record the CUMULATIVE total, never a delta and never a sum of events", async () => {
  const w = annualWorld({ total: TOTALS["30g"] });

  // First event: Stripe holds one settled refund of 5000.
  const first = refundPorts(w, { refunds: [refund(5000)] });
  await runAnnualPlanRefundSync(first.ports, ANNUAL_PI);
  assert.equal(w.plan.refunded_total_cents, 5000);
  assert.equal(w.plan.payment_status, "partially_refunded");

  // Second event: Stripe now holds 5000 AND 3000. The writer must receive
  // 8000 - not the new refund's 3000, and not 5000 + 8000.
  const second = refundPorts(w, { refunds: [refund(5000), refund(3000)] });
  const outcome = await runAnnualPlanRefundSync(second.ports, ANNUAL_PI);

  assert.equal(outcome.refundedTotalCents, 8000);
  assert.equal(w.plan.refunded_total_cents, 8000);
  assert.equal(w.plan.payment_status, "partially_refunded");
  assert.deepEqual(w.writes.map(v => v.refunded_total_cents), [5000, 8000]);

  // A pending refund is NOT counted: the customer has not been refunded
  // until Stripe says the money went back.
  const third = refundPorts(w, { refunds: [refund(5000), refund(3000), refund(2000, "pending")] });
  const pending = await runAnnualPlanRefundSync(third.ports, ANNUAL_PI);
  assert.equal(pending.refundedTotalCents, 8000);
  assert.equal(pending.hasPendingRefund, true);
  assert.equal(pending.result, "unchanged");
});

test("12: the same cumulative total delivered twice writes nothing the second time", async () => {
  const w = annualWorld({ total: TOTALS["50g"] });
  const refunds = [refund(5000), refund(3000)];

  const first = await runAnnualPlanRefundSync(refundPorts(w, { refunds }).ports, ANNUAL_PI);
  const second = await runAnnualPlanRefundSync(refundPorts(w, { refunds }).ports, ANNUAL_PI);
  const third = await runAnnualPlanRefundSync(refundPorts(w, { refunds }).ports, ANNUAL_PI);

  assert.equal(first.result, "applied");
  assert.equal(second.result, "unchanged");
  assert.equal(third.result, "unchanged");
  assert.equal(w.writes.length, 1, "a replay wrote a second time");
  assert.equal(w.plan.refunded_total_cents, 8000);
});

/* ══════════════════════════════════════════════════════════════
   13-16. OUT OF ORDER, IMPOSSIBLE, ZERO, CURRENCY
   ══════════════════════════════════════════════════════════════ */

test("13: an OLD redelivered event cannot move the total backwards", async () => {
  const w = annualWorld({ total: TOTALS["30g"] });

  // Today's truth: two settled refunds, 8000 in total.
  const now = [refund(5000), refund(3000)];
  await runAnnualPlanRefundSync(refundPorts(w, { refunds: now }).ports, ANNUAL_PI);
  assert.equal(w.plan.refunded_total_cents, 8000);

  // An hour-old event is redelivered. Its payload describes the world as
  // it was when only 5000 had been refunded - and that payload is NEVER
  // read: the flow takes the PaymentIntent from it and re-reads Stripe,
  // which still answers 8000.
  const stalePayload = { object: "refund", payment_intent: ANNUAL_PI, amount: 5000, status: "succeeded" };
  const replay = refundPorts(w, { refunds: now });
  const outcome = await runAnnualPlanRefundSync(replay.ports, stalePayload.payment_intent);

  assert.equal(outcome.refundedTotalCents, 8000, "the event's own amount reached the writer");
  assert.equal(outcome.result, "unchanged");
  assert.equal(w.plan.refunded_total_cents, 8000);
  assert.equal(w.writes.length, 1);

  // MONOTONICITY IS A PROPERTY OF THE RE-READ, and it is enforced by the
  // shape of the code: no amount, status or currency is ever taken from
  // an event object anywhere in the annual refund path.
  for (const [name, source] of [["rules", rulesCode], ["wiring", wiringCode]]) {
    for (const banned of [
      "event.data", "event.type", "data.object", ".amount", "amount_refunded",
      "eventObject", "payload",
    ]) {
      assert.ok(!source.includes(banned), `${name} reads a refund fact from the event: ${banned}`);
    }
  }
  // The route hands over the payment intent id and nothing else.
  assert.match(routeCode, /syncAnnualPlanRefundStateFromStripe\(stripe, paymentIntentId\)/);
});

test("14: a total larger than the plan is refused, never clamped", async () => {
  const total = TOTALS["30g"];
  const w = annualWorld({ total });
  const { ports } = refundPorts(w, { refunds: [refund(total + 1)] });

  const outcome = await runAnnualPlanRefundSync(ports, ANNUAL_PI);

  assert.equal(outcome.result, "invalid_amount");
  assert.equal(outcome.refundedTotalCents, total + 1, "the impossible total was quietly reduced");
  // Nothing was written, and the plan still says what it said.
  assert.deepEqual(w.writes, []);
  assert.equal(w.plan.payment_status, "paid");
  assert.equal(w.plan.refunded_total_cents, 0);
  // No clamping anywhere in the runtime.
  for (const [name, source] of [["rules", rulesCode], ["wiring", wiringCode]]) {
    for (const banned of ["Math.min", "Math.max", "> total", "total_gross_cents)"]) {
      assert.ok(!source.includes(banned), `${name} clamps the refunded total: ${banned}`);
    }
  }
});

test("15: zero follows the INSTALLED contract, which walks the row back to paid", async () => {
  const w = annualWorld({ total: TOTALS["30g"] });

  // A settled refund, then Stripe cancels it: the list now holds one
  // canceled refund, which counts for nothing.
  await runAnnualPlanRefundSync(refundPorts(w, { refunds: [refund(5000)] }).ports, ANNUAL_PI);
  assert.equal(w.plan.payment_status, "partially_refunded");

  const reversed = await runAnnualPlanRefundSync(
    refundPorts(w, { refunds: [refund(5000, "canceled")] }).ports, ANNUAL_PI
  );

  assert.equal(reversed.refundedTotalCents, 0);
  assert.equal(reversed.result, "applied");
  assert.equal(w.plan.payment_status, "paid");
  assert.equal(w.plan.refunded_total_cents, 0);

  // That is migration 039's own stated rule, not an invention here: the
  // absolute contract is deliberately reversible.
  const fn = m039.slice(m039.indexOf("create or replace function public.apply_annual_plan_refund_state"));
  assert.match(fn.slice(0, 3000), /if p_refunded_total_cents = 0 then\s*v_new_status := 'paid';/);
  assert.match(m039, /reversed refund returns payment_status to 'paid'/);
  // The runtime does not decide this: it has no 'paid' literal at all.
  for (const [name, source] of [["rules", rulesCode], ["wiring", wiringCode]]) {
    for (const banned of ['"paid"', '"refunded"', '"partially_refunded"', "payment_status"]) {
      assert.ok(!source.includes(banned), `${name} decides the money state itself: ${banned}`);
    }
  }
});

test("16: a refund in another currency refuses, and no writer is called", async () => {
  const w = annualWorld({ total: TOTALS["30g"] });
  const { calls, ports } = refundPorts(w, { refunds: [refund(5000, "succeeded", "usd")] });

  await assert.rejects(() => runAnnualPlanRefundSync(ports, ANNUAL_PI), /currency/);
  assert.equal(calls.write, 0, "a mismatched currency reached the writer");
  assert.deepEqual(w.writes, []);
  assert.equal(w.plan.payment_status, "paid");

  // An unrecognised refund status refuses the whole summary too, rather
  // than being read as "no refund".
  const unknown = refundPorts(w, { refunds: [refund(5000, "sort_of_maybe")] });
  await assert.rejects(() => runAnnualPlanRefundSync(unknown.ports, ANNUAL_PI), /unrecognised refund status/);
  assert.equal(unknown.calls.write, 0);

  // The currency compared is the PLAN's own frozen one, never a constant.
  assert.match(rulesCode, /ports\.summarizeRefunds\(refunds, plan\.currency\)/);
  assert.ok(!rulesCode.includes('"eur"') && !rulesCode.includes('"EUR"'),
    "the runtime hardcodes a currency instead of reading the plan");
});

/* ══════════════════════════════════════════════════════════════
   17-20. WHAT A REFUND DOES TO DELIVERIES
   ══════════════════════════════════════════════════════════════ */

test("17: a PARTIAL refund does not stop a single delivery", async () => {
  const w = annualWorld({ total: TOTALS["30g"] });
  await runAnnualPlanRefundSync(refundPorts(w, { refunds: [refund(5000)] }).ports, ANNUAL_PI);
  assert.equal(w.plan.payment_status, "partially_refunded");

  // The very next delivery run proceeds exactly as it would have.
  const summary = await quiet(() => runAnnualDeliveryWorker(w.workerDeps));

  assert.equal(summary.claimed, 1);
  assert.equal(summary.fulfilled, 1);
  assert.equal(summary.guarded, 0);
  assert.equal(w.orders.size, 1);
  // No schedule row was cancelled, and no date moved.
  assert.equal(w.rows.filter(d => d.state === "cancelled").length, 0);
  assert.equal(w.rows[1].scheduled_for, PURCHASED_AT + ANNUAL_DELIVERY_INTERVAL_DAYS * DAY_MS);
  // And nothing in the runtime knows how to cancel one.
  for (const [name, source] of [["rules", rulesCode], ["wiring", wiringCode]]) {
    for (const banned of ["cancel", "annual_plan_deliveries", "scheduled_for", "complete_due"]) {
      assert.ok(!source.includes(banned), `${name} reaches into the delivery schedule: ${banned}`);
    }
  }
});

test("18: a FULL refund stops future claims through the database's own guard", async () => {
  const w = annualWorld({ total: TOTALS["30g"] });

  // One delivery has already shipped before the refund.
  await quiet(() => runAnnualDeliveryWorker(w.workerDeps));
  assert.equal(w.orders.size, 1);
  const shippedOrder = w.rows[0].order_id;

  w.setNow(PURCHASED_AT + (ANNUAL_DELIVERY_INTERVAL_DAYS + 1) * DAY_MS);
  await runAnnualPlanRefundSync(refundPorts(w, { refunds: [refund(TOTALS["30g"])] }).ports, ANNUAL_PI);
  assert.equal(w.plan.payment_status, "refunded");

  // Delivery 2 is due, and the queue refuses to hand it out.
  const summary = await quiet(() => runAnnualDeliveryWorker(w.workerDeps));
  assert.equal(summary.claimed, 0);
  assert.equal(summary.fulfilled, 0);
  assert.equal(w.orders.size, 1, "a refunded plan produced another order");

  // THE ALREADY SHIPPED BOX IS A HISTORICAL FACT AND SURVIVES INTACT.
  assert.equal(w.rows[0].state, "fulfilled");
  assert.equal(w.rows[0].order_id, shippedOrder);
  assert.ok(w.rows[0].fulfilled_at !== null);
  assert.ok(w.orders.has(shippedOrder));
  assert.equal(w.attempts.size, 1);
});

test("19: a delivery already CLAIMED when the full refund lands cannot be fulfilled", async () => {
  const w = annualWorld({ total: TOTALS["30g"] });

  // A worker wins the claim first.
  const claimed = await w.workerDeps.claimDue(25);
  assert.equal(claimed.length, 1);

  // The full refund commits before fulfillment starts.
  await runAnnualPlanRefundSync(refundPorts(w, { refunds: [refund(TOTALS["30g"])] }).ports, ANNUAL_PI);

  const summary = await quiet(() => runAnnualDeliveryWorker({
    claimDue: async () => claimed,
    fulfillDelivery: w.workerDeps.fulfillDelivery,
  }));

  // The parent guard refuses under its own lock: no order, and it is
  // reported as GUARDED rather than as a failure to be retried.
  assert.equal(summary.guarded, 1);
  assert.equal(summary.failed, 0);
  assert.equal(summary.fulfilled, 0);
  assert.equal(summary.outcomes[0].result, "plan_refunded");
  assert.equal(w.orders.size, 0);
});

test("20: both functions take the SAME parent row lock before deciding", () => {
  const refundFn = m039.slice(
    m039.indexOf("create or replace function public.apply_annual_plan_refund_state"),
    m039.indexOf("-- 12. THE ANNUAL PURCHASE CONFIRMATION'S WRITE SURFACE")
  );
  const fulfillFn = m039.slice(
    m039.indexOf("create or replace function public.fulfill_annual_plan_delivery"),
    m039.indexOf("-- 10. WHY THE FULL-REFUND RACE IS IMPOSSIBLE")
  );
  assert.ok(refundFn.length > 0 && fulfillFn.length > 0);

  for (const [name, fn] of [["refund writer", refundFn], ["fulfillment", fulfillFn]]) {
    assert.match(fn, /from public\.annual_plans[\s\S]{0,200}for update/, `${name} decides without the parent lock`);
  }
  // The refund writer's FIRST statement against the table is the lock,
  // and the guard it protects is read after it.
  assert.ok(refundFn.indexOf("for update") < refundFn.indexOf("if p_refunded_total_cents > v_plan.total_gross_cents"));
  // The fulfillment re-reads payment_status under that same lock.
  assert.ok(fulfillFn.indexOf("for update") < fulfillFn.indexOf("v_plan.payment_status = 'refunded'"));
  // And the claim function's own refund predicate is still there.
  assert.match(m039, /p\.payment_status <> 'refunded'/);
  // No application lock is emulated anywhere.
  for (const [name, source] of [["rules", rulesCode], ["wiring", wiringCode]]) {
    for (const banned of ["lock", "mutex", "advisory", "setTimeout", "sleep"]) {
      assert.ok(!source.toLowerCase().includes(banned), `${name} implements a lock of its own: ${banned}`);
    }
  }
});

/* ══════════════════════════════════════════════════════════════
   21-26. WHAT THE PHASE REFUSES TO DO
   ══════════════════════════════════════════════════════════════ */

test("21: a delivery order can never be used to correlate an annual refund", async () => {
  const w = annualWorld({ total: TOTALS["30g"] });
  await quiet(() => runAnnualDeliveryWorker(w.workerDeps));

  // The synthetic attempt and its order carry no Stripe payment identity
  // at all, so there is nothing on them a refund could match.
  for (const attempt of w.attempts.values()) {
    assert.equal(attempt.stripe_payment_intent_id, null);
    assert.equal(attempt.stripe_invoice_id, null);
  }
  for (const order of w.orders.values()) {
    assert.equal(order.stripe_payment_intent_id, null);
  }
  assert.ok(m039.includes("checkout_attempts_annual_delivery_no_stripe_payment_check"));

  // And the resolver never walks a delivery, an order or an attempt.
  for (const [name, source] of [["rules", rulesCode], ["wiring", wiringCode]]) {
    for (const banned of [
      'from("orders")', 'from("checkout_attempts")', 'from("annual_plan_deliveries")',
      "order_id", "checkout_attempt_id", "delivery", "invoicePayments", "stripe_invoice_id",
      "customer", "email", "sku",
    ]) {
      assert.ok(!source.includes(banned), `${name} correlates through ${banned}`);
    }
  }
  // The one correlation there is.
  assert.match(wiringCode, /\.eq\("stripe_payment_intent_id", paymentIntentId\)/);
  assert.match(wiringCode, /\.from\("annual_plans"\)/);
  assert.ok(m039.includes("create unique index annual_plans_stripe_payment_intent_id_key"));
});

test("22: no Checkout metadata is required to correlate a refund", () => {
  for (const [name, source] of [["rules", rulesCode], ["wiring", wiringCode]]) {
    for (const banned of [
      "metadata", "checkout_version", "gloa_annual_plan_id", "request_id",
      "routeAnnualSession", "checkout.sessions",
    ]) {
      assert.ok(!source.includes(banned), `${name} needs ${banned} to correlate a refund`);
    }
  }
});

test("23: the annual refund path writes no table directly", () => {
  for (const [name, source] of [["rules", rulesCode], ["wiring", wiringCode]]) {
    for (const banned of [".update(", ".insert(", ".upsert(", ".delete(", "update ", "insert into"]) {
      assert.ok(!source.includes(banned), `${name} writes a table directly: ${banned}`);
    }
  }
  // Exactly one RPC, and it is the installed writer.
  const rpcs = [...wiringCode.matchAll(/admin\.rpc\("([a-z_]+)"/g)].map(m => m[1]);
  assert.deepEqual(rpcs, ["apply_annual_plan_refund_state"]);
  assert.ok(m039.includes("grant execute on function public.apply_annual_plan_refund_state(text, integer) to service_role;"));
});

test("24: no message is invented for an annual refund", () => {
  for (const [name, source] of [["rules", rulesCode], ["wiring", wiringCode]]) {
    for (const banned of [
      "sendRefundConfirmationIfNeeded", "refundConfirmation", "sendAnnualPurchaseConfirmationEmail",
      "sendInternalOrderNotification", "shipmentConfirmation", "resend", "Resend", "@gloamatcha",
    ]) {
      assert.ok(!source.includes(banned), `${name} sends ${banned}`);
    }
  }
  // The route's annual arm returns before the ordinary refund email.
  const handler = routeCode.slice(
    routeCode.indexOf("async function handleRefundEvent"),
    routeCode.indexOf("async function handleCheckoutSessionCompleted")
  );
  const arm = handler.slice(
    handler.indexOf("syncAnnualPlanRefundStateFromStripe"),
    handler.indexOf("syncOrderRefundStateFromStripe")
  );
  assert.ok(!arm.includes("sendRefundConfirmationIfNeeded"));
  assert.ok(!arm.includes("throw"), "the annual arm throws inside the handler");
  // Exactly one refund email call site survives, on the ordinary path.
  assert.equal([...handler.matchAll(/sendRefundConfirmationIfNeeded\(/g)].length, 1);
});

test("25: no lifecycle, completion or cancellation semantics are invented", () => {
  for (const [name, source] of [["rules", rulesCode], ["wiring", wiringCode]]) {
    for (const banned of [
      "complete_due_annual_plans", "completed_at", "'cancelled'", "cancelled",
      "status =", "withdrawal", "terminate",
    ]) {
      assert.ok(!source.includes(banned), `${name} decides a lifecycle: ${banned}`);
    }
  }
  // The completion function is untouched by this phase.
  const changed = execFileSync("git", ["diff", "--name-only", "HEAD", "--", "supabase/migrations/"],
    { cwd: ROOT, encoding: "utf-8" }).trim();
  assert.equal(changed, "", "a live, immutable migration was edited");
});

test("26: the sales feature flag cannot gate refund truth", () => {
  for (const [name, source] of [["rules", rulesCode], ["wiring", wiringCode]]) {
    assert.ok(!source.includes("B2C_ANNUAL_PLAN_ENABLED"), `${name} gates refunds on the sales flag`);
    assert.ok(!/process\.env/.test(source), `${name} reads the environment`);
  }
  // A refund can arrive months after new annual sales were switched off.
  const handler = routeCode.slice(
    routeCode.indexOf("async function handleRefundEvent"),
    routeCode.indexOf("async function handleCheckoutSessionCompleted")
  );
  assert.ok(!handler.includes("B2C_ANNUAL_PLAN_ENABLED"));
});

/* ══════════════════════════════════════════════════════════════
   27-29. SHAPE, SCOPE AND BOUNDARY
   ══════════════════════════════════════════════════════════════ */

test("27: the money totals are fixtures, and the runtime hardcodes none of them", () => {
  const runtime = [
    "lib/annualPlanRefundRules.ts", "lib/annualPlanRefunds.ts",
    "app/api/stripe/webhook/route.ts",
  ];
  for (const rel of runtime) {
    const source = read(rel);
    for (const total of Object.values(TOTALS)) {
      assert.ok(!source.includes(String(total)), `${rel} hardcodes the annual total ${total}`);
    }
  }
});

test("28: the rules module is a leaf, and the wiring is where the effects are", () => {
  assert.ok(!/^import /m.test(read("lib/annualPlanRefundRules.ts")), "the rules gained an import");
  assert.match(read("lib/annualPlanRefunds.ts"), /^import /m);
  // The summariser is the shared one, not a second copy.
  assert.match(wiringCode, /import \{ summarizeStripeRefunds/);
  for (const banned of ["SETTLED_STATUSES", "PENDING_STATUSES", "refundedTotalCents +="]) {
    assert.ok(!rulesCode.includes(banned) && !wiringCode.includes(banned),
      `the annual path reimplements the refund summary: ${banned}`);
  }
  // One resolver in the repository, and one caller of it.
  const definitions = readdirSync(path.join(ROOT, "lib"))
    .filter(f => f.endsWith(".ts"))
    .filter(f => read(path.join("lib", f)).includes("export async function syncAnnualPlanRefundStateFromStripe"));
  assert.deepEqual(definitions, ["annualPlanRefunds.ts"]);
  assert.equal([...routeCode.matchAll(/syncAnnualPlanRefundStateFromStripe\(/g)].length, 1);
});

test("29: this phase adds no migration, no route and no customer action", () => {
  const migrations = readdirSync(path.join(ROOT, "supabase/migrations"))
    .filter(f => f.endsWith(".sql")).sort();
  assert.equal(migrations.length, 41);
  assert.equal(migrations[migrations.length - 1], "041_annual_account_column_privileges.sql");
  assert.equal(migrations[migrations.length - 2], "040_annual_checkout_retry_fingerprints.sql");
  assert.deepEqual(migrations.filter(f => Number(f.slice(0, 3)) > 41), [], "a 042 appeared");

  // No annual refund endpoint, and no browser-triggered refund anywhere.
  const annualRoutes = readdirSync(path.join(ROOT, "app/api/annual-plan"), { withFileTypes: true })
    .filter(entry => entry.isDirectory()).map(entry => entry.name);
  assert.deepEqual(annualRoutes, ["checkout"], "an annual refund endpoint appeared");
  for (const [name, source] of [["rules", rulesCode], ["wiring", wiringCode]]) {
    for (const banned of ["refunds.create", "createRefund", "stripe.refunds.create"]) {
      assert.ok(!source.includes(banned), `${name} issues a refund: ${banned}`);
    }
  }
  // The only Stripe call the annual path makes is the read-only list.
  const stripeCalls = [...wiringCode.matchAll(/stripe\.[a-zA-Z.]+\(/g)].map(m => m[0]);
  assert.deepEqual(stripeCalls, ["stripe.refunds.list("]);
  // The cron knows nothing about refunds, and the schedule is unchanged -
  // asserted by content, so this stays true after the commit.
  const cron = withoutComments(read("app/api/cron/retry-order-notifications/route.ts"));
  for (const banned of ["Refund", "refund_", "apply_annual_plan_refund_state", "annualPlanRefunds"]) {
    assert.ok(!cron.includes(banned), `the cron gained refund work: ${banned}`);
  }
  const vercel = JSON.parse(read("vercel.json"));
  assert.equal(vercel.crons.length, 1);
  assert.equal(vercel.crons[0].schedule, "20 5 * * *");
});
