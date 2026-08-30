import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ANNUAL_ACTIVATION_SUCCESS_RESULTS,
  ANNUAL_EXPECTED_DELIVERY_COUNT,
  ANNUAL_SESSION_CHECKOUT_VERSION,
  ANNUAL_SESSION_PLAN_METADATA_KEY,
  annualPaymentIntentId,
  decidePaidState,
  decideSessionLink,
  interpretAnnualActivationResult,
  routeAnnualSession,
  verifyAnnualPaymentAttempt,
  verifyAnnualPlanCorrelation,
} from "../lib/annualPlanWebhookRules.ts";
import {
  ANNUAL_DELIVERY_BATCH_LIMIT,
  ANNUAL_FULFILL_GUARDED_RESULTS,
  ANNUAL_FULFILL_SUCCESS_RESULTS,
  runAnnualDeliveryWorker,
} from "../lib/annualDeliveryWorker.ts";
import { evaluateStripeSessionPayment } from "../lib/stripeFulfillment.ts";
import { ANNUAL_CHECKOUT_VERSION } from "../lib/annualPlanCheckoutRules.ts";

// SAFE DEFAULT SUITE: pure decisions, an in-memory worker driven by fake
// ports, and source-level checks on the orchestration. No Stripe client
// is constructed, no Checkout Session is created or retrieved, no
// Supabase client exists, no SQL runs, no email is sent and no cron is
// invoked. Nothing here reads a clock.
//
// The split mirrors the two checkout flows: everything worth EXECUTING
// lives in lib/annualPlanWebhookRules.ts and lib/annualDeliveryWorker.ts
// and is imported below, while lib/annualPlanWebhook.ts value-imports its
// neighbours and cannot be loaded by the test runner - so its guarantees,
// which are about ORDER and about what it refuses to do, are asserted
// against its source.
//
// What it protects: money that has already been taken. A verified annual
// payment must activate exactly one plan with exactly thirteen
// deliveries, and a payment that cannot be proved to belong to this
// checkout must activate nothing at all.

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

const flow = withoutComments(read("lib/annualPlanWebhook.ts"));
const rulesCode = withoutComments(read("lib/annualPlanWebhookRules.ts"));
const workerCode = withoutComments(read("lib/annualDeliveryWorker.ts"));
const depsCode = withoutComments(read("lib/annualPlanWebhookDeps.ts"));
const routeCode = withoutComments(read("app/api/stripe/webhook/route.ts"));

const at = needle => {
  const i = flow.indexOf(needle);
  assert.notEqual(i, -1, `missing from the flow: ${needle}`);
  return i;
};

const ATTEMPT_ID = "11111111-1111-1111-1111-111111111111";
const REQUEST_ID = "22222222-2222-2222-2222-222222222222";
const PLAN_ID = "33333333-3333-3333-3333-333333333333";
const USER_ID = "44444444-4444-4444-4444-444444444444";
const OTHER_ID = "99999999-9999-9999-9999-999999999999";
const SESSION_A = "cs_test_AAAAAAAAAAAAAAAA";
const SESSION_B = "cs_test_BBBBBBBBBBBBBBBB";
const PI_A = "pi_3AAAAAAAAAAAAAAA";
const PI_B = "pi_3BBBBBBBBBBBBBBB";
const DELIVERY_ID = "55555555-5555-5555-5555-555555555555";

/** Annual session metadata exactly as Phase 4B3 writes it. */
const annualMetadata = (over = {}) => ({
  checkout_version: "1",
  request_id: REQUEST_ID,
  checkout_attempt_id: ATTEMPT_ID,
  gloa_annual_plan_id: PLAN_ID,
  ...over,
});

const META = {
  checkoutVersion: "1",
  requestId: REQUEST_ID,
  checkoutAttemptId: ATTEMPT_ID,
  annualPlanId: PLAN_ID,
};

/** A frozen annual PAYMENT attempt, as migration 040 leaves one. */
const attempt = (over = {}) => ({
  id: ATTEMPT_ID,
  request_id: REQUEST_ID,
  status: "stripe_session_created",
  currency: "EUR",
  expected_total_gross_cents: 35087,
  user_id: USER_ID,
  paid_at: null,
  stripe_checkout_session_id: SESSION_A,
  stripe_payment_intent_id: null,
  stripe_invoice_id: null,
  subscription_id: null,
  annual_plan_id: null,
  annual_delivery_number: null,
  annual_intent_fingerprint: "a".repeat(64),
  annual_request_fingerprint: "b".repeat(64),
  subscription_request_fingerprint: null,
  subscription_intent_fingerprint: null,
  ...over,
});

const plan = (over = {}) => ({ id: PLAN_ID, user_id: USER_ID, status: "pending", ...over });

const claimed = (over = {}) => ({
  delivery_id: DELIVERY_ID,
  annual_plan_id: PLAN_ID,
  delivery_number: 1,
  scheduled_for: "2026-09-01T09:30:00.000Z",
  reclaimed: false,
  ...over,
});

/** An in-memory worker port. Records every call. */
const workerPort = ({ rows = [], answers = {}, claimThrows = false, fulfillThrows = null } = {}) => {
  const calls = [];
  return {
    calls,
    deps: {
      claimDue: async limit => {
        calls.push(["claim", limit]);
        if (claimThrows) throw new Error("queue unreachable");
        return rows;
      },
      fulfillDelivery: async id => {
        calls.push(["fulfill", id]);
        if (fulfillThrows === id) throw new Error("database exploded");
        // `in`, not ??, so an explicitly null or undefined answer is
        // returned as-is rather than falling back to a success.
        return id in answers ? answers[id] : { result: "fulfilled", order_id: "order-" + id };
      },
    },
  };
};

/* ══════════════════════════════════════════════════════════════
   1-5. ROUTING: WHICH SESSIONS ARE ANNUAL
   ══════════════════════════════════════════════════════════════ */

test("1: the annual routing key is metadata, and it agrees with what 4B3 writes", () => {
  assert.equal(ANNUAL_SESSION_PLAN_METADATA_KEY, "gloa_annual_plan_id");
  // Restated across two leaf modules that cannot import each other, so
  // the agreement is asserted rather than assumed.
  assert.equal(ANNUAL_SESSION_CHECKOUT_VERSION, ANNUAL_CHECKOUT_VERSION);
  const r = routeAnnualSession(annualMetadata());
  assert.equal(r.kind, "annual");
  assert.deepEqual(r.metadata, META);
});

test("2: a one-time or subscription session is not annual", () => {
  // The one-time flow writes exactly these three keys and no plan id.
  assert.equal(routeAnnualSession({
    checkout_version: "1", request_id: REQUEST_ID, checkout_attempt_id: ATTEMPT_ID,
  }).kind, "not_annual");
  assert.ok(read("app/api/checkout/session/route.ts").includes("checkout_version: \"1\","));
  assert.ok(!read("app/api/checkout/session/route.ts").includes("gloa_annual_plan_id"));
  // The subscription flow writes gloa_subscription_id.
  assert.equal(routeAnnualSession({
    checkout_version: "1", request_id: REQUEST_ID, checkout_attempt_id: ATTEMPT_ID,
    gloa_subscription_id: OTHER_ID,
  }).kind, "not_annual");
  // And no metadata at all.
  for (const empty of [null, undefined, {}]) {
    assert.equal(routeAnnualSession(empty).kind, "not_annual", String(empty));
  }
});

test("3: malformed annual metadata FAILS CLOSED, it does not fall through", () => {
  // Falling through would hand a paid annual purchase to the one-time
  // handler, which would mint one order for thirteen boxes carrying the
  // annual PaymentIntent.
  const cases = [
    [{ gloa_annual_plan_id: "not-a-uuid" }, /not a uuid/],
    [annualMetadata({ checkout_version: "2" }), /checkout version/],
    [annualMetadata({ checkout_version: undefined }), /checkout version/],
    [annualMetadata({ request_id: "nope" }), /request id/],
    [annualMetadata({ request_id: undefined }), /request id/],
    [annualMetadata({ checkout_attempt_id: "nope" }), /checkout attempt id/],
    [annualMetadata({ checkout_attempt_id: undefined }), /checkout attempt id/],
    [annualMetadata({ gloa_subscription_id: OTHER_ID }), /both an annual plan and a subscription/],
  ];
  for (const [meta, reason] of cases) {
    const r = routeAnnualSession(meta);
    assert.equal(r.kind, "malformed", JSON.stringify(meta));
    assert.match(r.reason, reason);
  }
  // The route treats malformed as an error rather than a fall-through.
  assert.ok(routeCode.includes('if (annual.kind === "malformed")'));
  assert.match(routeCode.slice(routeCode.indexOf('if (annual.kind === "malformed")')),
    /throw new Error\(/);
});

test("4: nothing about the money, the product or the customer routes a session", () => {
  // A session with an annual-looking amount, SKU, quantity and email but
  // no annual metadata is NOT annual.
  const disguised = {
    checkout_version: "1", request_id: REQUEST_ID, checkout_attempt_id: ATTEMPT_ID,
    amount_total: "35087", sku: "GLOA-MATCHA-50G", quantity: "13",
    email: "mira@example.com", product_name: "GLOA Matcha · 50 g · Jahresabo",
  };
  assert.equal(routeAnnualSession(disguised).kind, "not_annual");
  // And the router reads no such key.
  const fn = rulesCode.slice(rulesCode.indexOf("export function routeAnnualSession"));
  for (const banned of ["amount", "sku", "quantity", "email", "customer", "price", "product"]) {
    assert.ok(!fn.slice(0, fn.indexOf("\n}")).includes(banned), `routing reads ${banned}`);
  }
});

test("5: the annual branch is checked FIRST, and the other two are untouched", () => {
  const annualAt = routeCode.indexOf("const annual = routeAnnualSession(session.metadata);");
  const subAt = routeCode.indexOf("handleSubscriptionSessionCompleted(stripe, session)");
  const oneTimeAt = routeCode.indexOf("handleCheckoutSessionCompleted(stripe, session)");
  assert.ok(annualAt > 0, "the annual branch is missing from the dispatcher");
  assert.ok(annualAt < subAt && annualAt < oneTimeAt,
    "an annual session could reach another branch first");
  // Both existing handlers still exist and are still reachable.
  assert.ok(routeCode.includes('} else if (session.mode === "subscription") {'));
  assert.ok(routeCode.includes("await handleSubscriptionSessionCompleted(stripe, session);"));
  assert.ok(routeCode.includes("await handleCheckoutSessionCompleted(stripe, session);"));
  assert.ok(routeCode.includes("async function handleCheckoutSessionCompleted("));
  assert.ok(routeCode.includes("async function handleSubscriptionSessionCompleted("));
  // Only ONE Stripe webhook endpoint exists.
  const apiDirs = readdirSync(path.join(ROOT, "app/api"));
  assert.ok(apiDirs.includes("stripe"));
  assert.ok(!readdirSync(path.join(ROOT, "app/api/annual-plan")).includes("webhook"),
    "a second Stripe webhook endpoint appeared");
});

/* ══════════════════════════════════════════════════════════════
   6-8. SIGNATURE AND THE TRUSTED RE-READ
   ══════════════════════════════════════════════════════════════ */

test("6: the signature is verified before any branch runs", () => {
  const verify = routeCode.indexOf("stripe.webhooks.constructEvent(rawBody, signature, webhookSecret)");
  assert.ok(verify > 0, "signature verification is missing");
  assert.ok(verify < routeCode.indexOf("const annual = routeAnnualSession("),
    "the annual branch runs before the signature is verified");
  // A bad signature returns 400 and never reaches the dispatcher.
  const failure = routeCode.slice(verify, verify + 400);
  assert.match(failure, /return Response\.json\([\s\S]*?status: 400/);
});

test("7: the event's own Session is never the payment authority", () => {
  // The event supplies an ID. Everything else comes from the re-read.
  assert.ok(routeCode.includes("settleAnnualCheckoutSession(session.id, annual.metadata,"),
    "the event's Session object is passed into settlement");
  assert.ok(flow.includes("const session = await deps.retrieveSession(eventSessionId);"),
    "the session is not re-retrieved");
  assert.ok(depsCode.includes("retrieveSession: (sessionId: string) => stripe.checkout.sessions.retrieve(sessionId)"));
  // Every payment field read afterwards comes from the retrieved object.
  const evaluation = flow.slice(at("evaluateStripeSessionPayment("), at("if (!evaluation.shouldMarkPaid)"));
  assert.ok(evaluation.includes("payment_status: session.payment_status"));
  assert.ok(evaluation.includes("currency: session.currency"));
  assert.ok(evaluation.includes("amount_total: session.amount_total"));
  // ...and the authority it is compared against is the frozen attempt.
  assert.ok(evaluation.includes("currency: attempt.currency"));
  assert.ok(evaluation.includes("expected_total_gross_cents: attempt.expected_total_gross_cents"));
  // The retrieve happens before anything is read locally.
  assert.ok(at("await deps.retrieveSession(") < at("await deps.findAttempt("));
});

test("8: the frozen expected total is the amount authority, for all three sizes", () => {
  // Test fixtures, not runtime constants: the webhook never computes them.
  for (const [size, total] of [["30g", 31057], ["50g", 35087], ["100g", 64337]]) {
    const ok = evaluateStripeSessionPayment(
      { payment_status: "paid", currency: "eur", amount_total: total },
      { currency: "EUR", expected_total_gross_cents: total });
    assert.equal(ok.shouldMarkPaid, true, size);
    // A forged amount fails, whichever way it differs.
    for (const wrong of [total - 1, total + 1, 0, 100]) {
      const bad = evaluateStripeSessionPayment(
        { payment_status: "paid", currency: "eur", amount_total: wrong },
        { currency: "EUR", expected_total_gross_cents: total });
      assert.equal(bad.shouldMarkPaid, false, `${size} ${wrong}`);
    }
  }
  // Wrong currency, unpaid, and a missing amount all fail.
  assert.equal(evaluateStripeSessionPayment(
    { payment_status: "paid", currency: "usd", amount_total: 35087 },
    { currency: "EUR", expected_total_gross_cents: 35087 }).shouldMarkPaid, false);
  assert.equal(evaluateStripeSessionPayment(
    { payment_status: "unpaid", currency: "eur", amount_total: 35087 },
    { currency: "EUR", expected_total_gross_cents: 35087 }).shouldMarkPaid, false);
  assert.equal(evaluateStripeSessionPayment(
    { payment_status: "paid", currency: "eur", amount_total: null },
    { currency: "EUR", expected_total_gross_cents: 35087 }).shouldMarkPaid, false);
  // And the webhook hardcodes none of the totals.
  for (const total of [31057, 35087, 64337, 1799, 2699, 4949]) {
    assert.ok(!flow.includes(String(total)), `the flow hardcodes ${total}`);
    assert.ok(!rulesCode.includes(String(total)), `the rules hardcode ${total}`);
  }
});

/* ══════════════════════════════════════════════════════════════
   9-12. LOCAL CORRELATION
   ══════════════════════════════════════════════════════════════ */

test("9: a valid annual payment attempt is accepted", () => {
  assert.equal(verifyAnnualPaymentAttempt({ attempt: attempt(), metadata: META }).ok, true);
});

test("10: the request id is cross-checked, and three impostors are refused", () => {
  const cases = [
    [null, /no checkout attempt/],
    [attempt({ request_id: OTHER_ID }), /request id/],
    [attempt({ user_id: null }), /no owner/],
    [attempt({ currency: "USD" }), /EUR/],
    // pre-040: no annual payment intent to adopt
    [attempt({ annual_intent_fingerprint: null }), /no annual payment intent/],
    [attempt({ annual_request_fingerprint: null }), /no annual payment intent/],
    // a subscription attempt
    [attempt({ subscription_request_fingerprint: "x" }), /subscription/],
    [attempt({ subscription_intent_fingerprint: "x" }), /subscription/],
    [attempt({ subscription_id: OTHER_ID }), /subscription/],
    [attempt({ stripe_invoice_id: "in_123" }), /subscription/],
    // a synthetic annual DELIVERY attempt
    [attempt({ annual_plan_id: PLAN_ID }), /annual delivery/],
    [attempt({ annual_delivery_number: 3 }), /annual delivery/],
  ];
  for (const [row, reason] of cases) {
    const r = verifyAnnualPaymentAttempt({ attempt: row, metadata: META });
    assert.equal(r.ok, false, JSON.stringify(row));
    assert.match(r.reason, reason);
  }
});

test("11: the plan is resolved BY the payment attempt, never by the metadata id", () => {
  // The wiring queries payment_checkout_attempt_id, which 039 makes unique.
  assert.ok(depsCode.includes('.eq("payment_checkout_attempt_id", checkoutAttemptId)'),
    "the plan is not resolved through the payment attempt relationship");
  assert.ok(!depsCode.includes('.eq("id", input.annualPlanId)'),
    "the plan is resolved by the metadata id");
  assert.ok(flow.includes("await deps.findPlanByAttempt(attempt.id)"));
  // The metadata id is then a CLAIM to check.
  assert.equal(verifyAnnualPlanCorrelation({
    plan: plan(), metadata: META, attemptUserId: USER_ID }).ok, true);
  const cases = [
    [{ plan: null }, /no annual plan/],
    [{ plan: plan({ id: OTHER_ID }) }, /different annual plan/],
    [{ plan: plan({ user_id: OTHER_ID }) }, /another customer/],
  ];
  for (const over of cases) {
    const r = verifyAnnualPlanCorrelation({
      plan: plan(), metadata: META, attemptUserId: USER_ID, ...over[0] });
    assert.equal(r.ok, false, JSON.stringify(over[0]));
    assert.match(r.reason, over[1]);
  }
});

test("12: nothing is correlated by email, amount, SKU or customer", () => {
  for (const banned of ["email", "customer_details", "amount_total ===", "sku", "product"]) {
    assert.ok(!rulesCode.includes(banned), `the rules correlate by ${banned}`);
  }
  assert.ok(!depsCode.includes("email"));
  // Correlation happens before any write.
  assert.ok(at("verifyAnnualPaymentAttempt(") < at("await deps.linkSession("));
  assert.ok(at("verifyAnnualPlanCorrelation(") < at("await deps.linkSession("));
  assert.ok(at("verifyAnnualPlanCorrelation(") < at("await deps.markPaid("));
  assert.ok(at("verifyAnnualPlanCorrelation(") < at("await deps.activatePlan("));
});

/* ══════════════════════════════════════════════════════════════
   13-15. SESSION LINK AND PAYMENT INTENT
   ══════════════════════════════════════════════════════════════ */

test("13: the session link self-heals, is idempotent, and never overwrites", () => {
  // A. the checkout route died before linking
  assert.deepEqual(decideSessionLink({ storedSessionId: null, retrievedSessionId: SESSION_A }),
    { kind: "link" });
  // B. already linked to the same session
  assert.deepEqual(decideSessionLink({ storedSessionId: SESSION_A, retrievedSessionId: SESSION_A }),
    { kind: "already_linked" });
  // C. a DIFFERENT session
  const conflict = decideSessionLink({ storedSessionId: SESSION_A, retrievedSessionId: SESSION_B });
  assert.equal(conflict.kind, "conflict");
  assert.match(conflict.reason, /different Stripe session/);
  // The flow refuses a conflict before marking paid or activating.
  assert.ok(at('if (link.kind === "conflict")') < at("await deps.markPaid("));
  assert.ok(flow.includes("throw new AnnualWebhookConflict(`annual attempt ${attempt.id}: ${link.reason}`)"));
  // And it uses the existing helper rather than writing the column.
  assert.ok(flow.includes("await deps.linkSession(attempt.id, session.id)"));
  assert.ok(depsCode.includes("linkSession: linkStripeSession"));
  assert.ok(!flow.includes("stripe_checkout_session_id:"), "the flow writes the column directly");
});

test("14: a PaymentIntent is required, in both Stripe shapes", () => {
  assert.equal(annualPaymentIntentId({ payment_intent: PI_A }), PI_A);
  assert.equal(annualPaymentIntentId({ payment_intent: { id: PI_A } }), PI_A);
  for (const missing of [null, undefined, "", "   ", {}, { id: "" }, 5]) {
    assert.equal(annualPaymentIntentId({ payment_intent: missing }), null, String(missing));
  }
  assert.equal(annualPaymentIntentId({}), null);
  // No substitute is accepted.
  assert.ok(flow.includes("if (!paymentIntentId)"));
  assert.ok(!flow.includes("session.invoice"), "an invoice id is used as payment identity");
  assert.ok(!flow.includes("session.customer"), "a customer id is used as payment identity");
});

test("15: an attempt already settled against a different PaymentIntent is refused", () => {
  // Not yet paid: settle.
  assert.deepEqual(decidePaidState({
    attemptStatus: "stripe_session_created", storedPaymentIntentId: null, verifiedPaymentIntentId: PI_A,
  }), { kind: "settle" });
  // Paid with the same PI: idempotent, no second write.
  assert.deepEqual(decidePaidState({
    attemptStatus: "paid", storedPaymentIntentId: PI_A, verifiedPaymentIntentId: PI_A,
  }), { kind: "already_settled" });
  // Paid with a DIFFERENT PI: conflict.
  const conflict = decidePaidState({
    attemptStatus: "paid", storedPaymentIntentId: PI_A, verifiedPaymentIntentId: PI_B,
  });
  assert.equal(conflict.kind, "conflict");
  assert.match(conflict.reason, /different payment/);

  // The guard sits IN FRONT of the existing writer, which stays an
  // unconditional write for the one-time and subscription flows.
  assert.ok(at("decidePaidState(") < at("await deps.markPaid("));
  const marker = read("lib/checkoutAttempts.ts");
  assert.ok(marker.includes("export async function markAttemptPaid(attemptId: string, stripePaymentIntentId: string | null)"),
    "markAttemptPaid's signature changed");
  assert.ok(marker.includes('status: "paid",') && marker.includes("paid_at: new Date().toISOString(),"),
    "markAttemptPaid's behaviour changed");
  // And the webhook never WRITES those columns itself - it only reads
  // them off the frozen attempt and hands the id to the existing writer.
  for (const write of [
    ".update(", ".upsert(", ".insert(", 'from("checkout_attempts")',
    "paid_at:", "status: \"paid\"",
  ]) {
    assert.ok(!flow.includes(write), `the flow writes the attempt directly: ${write}`);
  }
});

/* ══════════════════════════════════════════════════════════════
   16-19. ACTIVATION
   ══════════════════════════════════════════════════════════════ */

test("16: only 'activated' and 'already_active' with thirteen deliveries succeed", () => {
  assert.deepEqual([...ANNUAL_ACTIVATION_SUCCESS_RESULTS], ["activated", "already_active"]);
  assert.equal(ANNUAL_EXPECTED_DELIVERY_COUNT, 13);
  for (const result of ["activated", "already_active"]) {
    const r = interpretAnnualActivationResult({ result, annual_plan_id: PLAN_ID, deliveries: 13 });
    assert.equal(r.ok, true, result);
    assert.equal(r.annualPlanId, PLAN_ID);
    assert.equal(r.deliveries, 13);
  }
});

test("17: a delivery count that is not thirteen is corruption, not idempotency", () => {
  for (const deliveries of [0, 1, 12, 14, 26]) {
    const r = interpretAnnualActivationResult({
      result: "already_active", annual_plan_id: PLAN_ID, deliveries });
    assert.equal(r.ok, false, String(deliveries));
    assert.equal(r.terminal, false);
    assert.match(r.reason, /expected 13/);
  }
  // A missing count is refused too.
  const missing = interpretAnnualActivationResult({ result: "activated", annual_plan_id: PLAN_ID });
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /no delivery count/);
});

test("18: every conflict word and every unknown word fails closed", () => {
  for (const result of [
    "payment_intent_conflict", "checkout_session_conflict", "attempt_not_paid",
    "attempt_owner_mismatch", "total_mismatch", "attempt_payment_intent_missing",
    "attempt_checkout_session_missing", "attempt_paid_at_missing", "attempt_not_found",
    "invalid_input", "not_found", "some_future_word", "", "ok", "success",
  ]) {
    const r = interpretAnnualActivationResult({ result, annual_plan_id: PLAN_ID, deliveries: 13 });
    assert.equal(r.ok, false, result);
    assert.equal(r.terminal, false, result);
  }
  for (const bad of [null, undefined, "activated", [], 5]) {
    assert.equal(interpretAnnualActivationResult(bad).ok, false, String(bad));
  }
  // A success word with an unusable plan id is still a refusal.
  for (const badId of [undefined, null, "", "not-a-uuid", 7]) {
    assert.equal(interpretAnnualActivationResult({
      result: "activated", annual_plan_id: badId, deliveries: 13 }).ok, false);
  }
  // And every 039 word this list names really is one 039 can answer.
  const m039 = read("supabase/migrations/039_b2c_annual_plan_foundation.sql");
  for (const word of [
    "payment_intent_conflict", "checkout_session_conflict", "attempt_not_paid",
    "attempt_owner_mismatch", "total_mismatch", "attempt_payment_intent_missing",
    "attempt_checkout_session_missing", "attempt_paid_at_missing", "terminal",
    "activated", "already_active",
  ]) {
    assert.ok(m039.includes(`'${word}'`), `039 does not answer with ${word}`);
  }
});

test("19: 'terminal' is acknowledged only after the correlation is fully proved", () => {
  const t = interpretAnnualActivationResult({ result: "terminal", annual_plan_id: PLAN_ID });
  assert.equal(t.ok, false);
  assert.equal(t.terminal, true);
  // In the flow, the terminal branch is reached only after the attempt,
  // the plan, the session and the PaymentIntent have all been proved.
  const terminalAt = at("if (activation.terminal)");
  for (const proof of [
    "verifyAnnualPaymentAttempt(", "verifyAnnualPlanCorrelation(",
    "decideSessionLink(", "if (!paymentIntentId)", "decidePaidState(",
  ]) {
    assert.ok(at(proof) < terminalAt, `terminal is acknowledged before ${proof}`);
  }
  // It returns rather than throwing, so Stripe stops redelivering.
  assert.match(flow.slice(terminalAt, terminalAt + 700), /return \{[\s\S]*?activation: "terminal"/);
});

/* ══════════════════════════════════════════════════════════════
   20-21. THE SCHEDULE STAYS IN THE DATABASE
   ══════════════════════════════════════════════════════════════ */

test("20: the webhook computes no date and no money", () => {
  for (const source of [flow, rulesCode, workerCode, depsCode]) {
    for (const banned of [
      "672", "8736", "336", "364", "28 *", "* 28", "make_interval",
      "setDate", "setMonth", "getTime()", "Date.now()", "new Date(",
      "buildAnnualPricing", "annualUnitGrossCents", "computeShippingGrossCents",
      "resolveCheckoutTax", "buildAnnualDeliverySchedule", "annualPlanEndAt",
    ]) {
      assert.ok(!source.includes(banned), `the annual webhook layer contains ${banned}`);
    }
  }
  // It passes three arguments and no date at all.
  const rpc = depsCode.slice(depsCode.indexOf('admin.rpc("activate_annual_plan_from_payment"'));
  const call = rpc.slice(0, rpc.indexOf("});"));
  assert.equal((call.match(/p_[a-z_]+:/g) || []).length, 3, "activation is not called with exactly 3 arguments");
  assert.ok(call.includes("p_annual_plan_id:"));
  assert.ok(call.includes("p_stripe_checkout_session_id:"));
  assert.ok(call.includes("p_stripe_payment_intent_id:"));
  assert.ok(!call.includes("purchased_at") && !call.includes("plan_end"));
});

test("21: 039 still owns the schedule, and this phase did not touch it", () => {
  const m039 = read("supabase/migrations/039_b2c_annual_plan_foundation.sql");
  assert.ok(m039.includes("pg_catalog.make_interval(hours => 672 * (n - 1))"));
  assert.ok(m039.includes("pg_catalog.make_interval(hours => 8736)"));
  assert.ok(m039.includes("v_purchased := v_attempt.paid_at;"),
    "039 no longer derives purchased_at from the attempt");
});

/* ══════════════════════════════════════════════════════════════
   22-27. THE SHARED DELIVERY WORKER
   ══════════════════════════════════════════════════════════════ */

test("22: no due rows is a clean no-op", async () => {
  const port = workerPort({ rows: [] });
  const s = await runAnnualDeliveryWorker(port.deps);
  assert.deepEqual(port.calls, [["claim", ANNUAL_DELIVERY_BATCH_LIMIT]]);
  assert.equal(s.claimed, 0);
  assert.equal(s.fulfilled, 0);
  assert.equal(s.failed, 0);
  assert.deepEqual(s.outcomes, []);
});

test("23: one due delivery is claimed and fulfilled through the two RPCs", async () => {
  const port = workerPort({ rows: [claimed()] });
  const s = await runAnnualDeliveryWorker(port.deps);
  assert.deepEqual(port.calls, [["claim", 25], ["fulfill", DELIVERY_ID]]);
  assert.equal(s.claimed, 1);
  assert.equal(s.fulfilled, 1);
  assert.equal(s.outcomes[0].deliveryNumber, 1);
  assert.equal(s.outcomes[0].result, "fulfilled");
  assert.equal(s.outcomes[0].orderId, "order-" + DELIVERY_ID);
});

test("24: every claimed row is processed, including another plan's", async () => {
  // The queue is GLOBAL. A pass triggered by one payment may claim an
  // older due delivery belonging to somebody else; discarding it would
  // strand it for the six-hour lease for no reason.
  const other = claimed({ delivery_id: "d2", annual_plan_id: OTHER_ID, delivery_number: 7 });
  const third = claimed({ delivery_id: "d3", delivery_number: 2 });
  const port = workerPort({
    rows: [claimed(), other, third],
    answers: { d2: { result: "already_fulfilled", order_id: "order-old" } },
  });
  const s = await runAnnualDeliveryWorker(port.deps);
  assert.equal(s.claimed, 3);
  assert.equal(s.fulfilled, 3, "a claimed row was skipped");
  assert.deepEqual(port.calls.map(c => c[0]), ["claim", "fulfill", "fulfill", "fulfill"]);
  assert.deepEqual(s.outcomes.map(o => o.deliveryId), [DELIVERY_ID, "d2", "d3"]);
  // 'already_fulfilled' is a success and returns the historical order.
  assert.deepEqual([...ANNUAL_FULFILL_SUCCESS_RESULTS], ["fulfilled", "already_fulfilled"]);
  assert.equal(s.outcomes[1].orderId, "order-old");
});

test("25: a parent guard after the claim is a safe outcome, not a failure", async () => {
  // The claim reads the plan WITHOUT a lock, so a refund or a
  // termination can commit in between and 039's fulfillment refuses
  // under its own lock. Nothing was created; retrying would not help.
  assert.deepEqual([...ANNUAL_FULFILL_GUARDED_RESULTS],
    ["plan_not_active", "plan_refunded", "delivery_not_claimed"]);
  for (const result of ANNUAL_FULFILL_GUARDED_RESULTS) {
    const port = workerPort({ rows: [claimed()], answers: { [DELIVERY_ID]: { result } } });
    const s = await runAnnualDeliveryWorker(port.deps);
    assert.equal(s.guarded, 1, result);
    assert.equal(s.failed, 0, result);
    assert.equal(s.fulfilled, 0, result);
    assert.deepEqual(s.errors, [], result);
  }
  // 039 really does answer with those words.
  const m039 = read("supabase/migrations/039_b2c_annual_plan_foundation.sql");
  for (const word of ANNUAL_FULFILL_GUARDED_RESULTS) {
    assert.ok(m039.includes(`'${word}'`), `039 does not answer with ${word}`);
  }
});

test("26: an unknown result or a database error is surfaced, never swallowed", async () => {
  for (const answer of [{ result: "who_knows" }, {}, null, "nope", { result: 5 }]) {
    const port = workerPort({ rows: [claimed()], answers: { [DELIVERY_ID]: answer } });
    const s = await runAnnualDeliveryWorker(port.deps);
    assert.equal(s.failed, 1, JSON.stringify(answer));
    assert.equal(s.fulfilled, 0);
    assert.match(s.errors[0], /unexpected fulfillment result/);
  }
  // A throwing fulfillment is reported and does not abandon the rest.
  const port = workerPort({
    rows: [claimed(), claimed({ delivery_id: "d2", delivery_number: 4 })],
    fulfillThrows: DELIVERY_ID,
  });
  const s = await runAnnualDeliveryWorker(port.deps);
  assert.equal(s.failed, 1);
  assert.equal(s.fulfilled, 1, "one failure abandoned the other claimed row");
  assert.match(s.errors[0], /fulfillment failed/);
  // A throwing claim is reported and nothing is fulfilled.
  const dead = workerPort({ claimThrows: true });
  const t = await runAnnualDeliveryWorker(dead.deps);
  assert.equal(t.claimed, 0);
  assert.equal(t.failed, 1);
  assert.match(t.errors[0], /claim failed/);
  assert.deepEqual(dead.calls, [["claim", 25]]);
});

test("27: the worker is bounded, writes nothing, and never loops", async () => {
  assert.equal(ANNUAL_DELIVERY_BATCH_LIMIT, 25);
  const many = Array.from({ length: 25 }, (_, i) => claimed({ delivery_id: `d${i}`, delivery_number: i + 1 }));
  const port = workerPort({ rows: many });
  const s = await runAnnualDeliveryWorker(port.deps);
  // Exactly ONE claim call: one pass, never "until empty".
  assert.equal(port.calls.filter(c => c[0] === "claim").length, 1);
  assert.equal(s.claimed, 25);
  assert.equal(s.fulfilled, 25);
  // A caller may lower the bound but the RPC clamps it regardless.
  const small = workerPort({ rows: [] });
  await runAnnualDeliveryWorker(small.deps, { limit: 5 });
  assert.deepEqual(small.calls, [["claim", 5]]);
  assert.ok(read("supabase/migrations/039_b2c_annual_plan_foundation.sql")
    .includes("least(greatest(coalesce(p_limit, 25), 1), 100)"));
  // Zero imports, and no write of its own.
  assert.ok(!/^import /m.test(read("lib/annualDeliveryWorker.ts")),
    "the worker gained an import");
  for (const banned of [
    "insert into", "update ", "supabase", "stripe", "create_order_from_paid_checkout",
    "checkout_attempts", "annual_plan_deliveries", "select ",
  ]) {
    assert.ok(!workerCode.toLowerCase().includes(banned.toLowerCase()),
      `the worker does ${banned}`);
  }
});

/* ══════════════════════════════════════════════════════════════
   28-30. DELIVERY 1 IS NOT SPECIAL
   ══════════════════════════════════════════════════════════════ */

test("28: delivery 1 goes through the same claim and fulfill path", () => {
  // The worker runs AFTER activation, and it is the shared one.
  assert.ok(at("await deps.activatePlan(") < at("runAnnualDeliveryWorker(deps.worker)"));
  assert.ok(flow.includes("const worker = await runAnnualDeliveryWorker(deps.worker);"));
  // It calls the two RPCs and nothing else.
  assert.ok(depsCode.includes('admin.rpc("claim_due_annual_plan_deliveries"'));
  assert.ok(depsCode.includes('admin.rpc("fulfill_annual_plan_delivery"'));
  // And NOT the order creator, an attempt insert or a delivery update.
  for (const source of [flow, rulesCode, workerCode, depsCode]) {
    for (const banned of [
      "create_order_from_paid_checkout", "createOrderFromPaidCheckoutAttempt",
      "getOrCreateAnnualCheckoutAttempt",
      "prepare_annual_plan_delivery_attempt", "mark_annual_plan_delivery_fulfilled",
      // A TABLE access, not the RPC name that happens to contain it.
      'from("annual_plan_deliveries")', 'from("orders")',
    ]) {
      assert.ok(!source.includes(banned), `the annual webhook layer calls ${banned}`);
    }
    // public.annual_plans may be READ - that is how the plan is resolved
    // from its payment attempt - but never written. Every annual write
    // goes through an RPC that holds a row lock.
    for (const write of [".update(", ".upsert(", ".insert(", ".delete("]) {
      assert.ok(!source.includes(write), `the annual webhook layer writes a table: ${write}`);
    }
  }
});

test("29: a freshly activated plan's delivery 1 is claimed and fulfilled", async () => {
  // 039 schedules delivery 1 at paid_at, so it is due immediately.
  const port = workerPort({ rows: [claimed({ delivery_number: 1 })] });
  const s = await runAnnualDeliveryWorker(port.deps);
  assert.equal(s.outcomes[0].deliveryNumber, 1);
  assert.equal(s.fulfilled, 1);
  assert.deepEqual(port.calls, [["claim", 25], ["fulfill", DELIVERY_ID]]);
  // The synthetic delivery attempt 039 mints carries no Stripe identity,
  // and nothing here adds one.
  const m039 = read("supabase/migrations/039_b2c_annual_plan_foundation.sql");
  assert.ok(m039.includes("checkout_attempts_annual_delivery_no_stripe_payment_check"));
  // The flow never touches a delivery row itself: it hands the whole
  // queue to the worker, which only calls the two RPCs (test 28).
  assert.ok(!flow.includes("delivery_id"), "the flow addresses a delivery directly");
});

test("30: a worker failure after activation is retryable, a guarded refusal is not", () => {
  // The plan is durable by then, so a throw makes Stripe redeliver into
  // an idempotent activation plus another worker pass.
  assert.ok(flow.includes("if (worker.failed > 0)"));
  const block = flow.slice(at("if (worker.failed > 0)"));
  assert.match(block.slice(0, 400), /throw new Error\(/);
  // 'guarded' is deliberately not part of that condition.
  assert.ok(!flow.includes("worker.guarded > 0"),
    "a business-safe guarded refusal is escalated");
});

/* ══════════════════════════════════════════════════════════════
   31-33. FEATURE FLAG, REPLAY, PHASE BOUNDARIES
   ══════════════════════════════════════════════════════════════ */

test("31: settlement is NOT gated by B2C_ANNUAL_PLAN_ENABLED", () => {
  // The flag stops NEW SALES. A customer can open a session while it is
  // on and pay after an operator turns it off, and Stripe can redeliver
  // for days; gating settlement would mean money accepted and no plan
  // activated.
  for (const source of [flow, rulesCode, workerCode, depsCode, routeCode]) {
    assert.ok(!source.includes("isAnnualPlanCheckoutEnabled"),
      "the settlement path reads the annual feature flag");
    assert.ok(!source.includes("B2C_ANNUAL_PLAN_ENABLED"),
      "the settlement path names the annual feature flag");
  }
  // Meanwhile the CHECKOUT route is still gated, and still closed by
  // default.
  const checkout = withoutComments(read("lib/annualPlanCheckout.ts"));
  assert.ok(checkout.includes("if (!deps.isEnabled())"), "the annual checkout lost its gate");
  assert.ok(read("lib/annualPlanCheckoutDeps.ts")
    .includes("isEnabled: () => isAnnualPlanCheckoutEnabled()"));
  assert.ok(read("lib/annualPlans.ts").includes('return env[ANNUAL_PLAN_FEATURE_FLAG] === "true";'));
  assert.match(read(".env.example"), /^B2C_ANNUAL_PLAN_ENABLED=$/m);
});

test("32: a redelivered event converges instead of duplicating", () => {
  // Every step is idempotent by construction, and each is a decision this
  // suite already pins:
  //   the session link      already_linked        (test 13)
  //   marking paid          already_settled       (test 15)
  //   activation            already_active + 13   (test 16)
  //   fulfillment           already_fulfilled     (test 24)
  assert.deepEqual(decideSessionLink({ storedSessionId: SESSION_A, retrievedSessionId: SESSION_A }),
    { kind: "already_linked" });
  assert.equal(decidePaidState({
    attemptStatus: "paid", storedPaymentIntentId: PI_A, verifiedPaymentIntentId: PI_A }).kind,
    "already_settled");
  assert.equal(interpretAnnualActivationResult({
    result: "already_active", annual_plan_id: PLAN_ID, deliveries: 13 }).ok, true);
  assert.ok(ANNUAL_FULFILL_SUCCESS_RESULTS.includes("already_fulfilled"));
  // The database is the backstop: 039's uniqueness makes a second plan,
  // a fourteenth delivery, a second synthetic attempt and a second order
  // impossible regardless of what the application does.
  const m039 = read("supabase/migrations/039_b2c_annual_plan_foundation.sql");
  for (const guarantee of [
    "annual_plans_payment_checkout_attempt_id_key",
    "annual_plan_deliveries_plan_number_key",
    "checkout_attempts_annual_delivery_key",
    "annual_plan_deliveries_order_id_key",
  ]) {
    assert.ok(m039.includes(guarantee), `039 lost ${guarantee}`);
  }
  // And the route still records processed events so a redelivery is
  // skipped entirely where possible.
  assert.ok(routeCode.includes("hasStripeWebhookEventBeenProcessed(event.id)"));
});

test("33: this phase stays inside its boundaries", () => {
  const migrations = readdirSync(path.join(ROOT, "supabase/migrations"))
    .filter(f => f.endsWith(".sql")).sort();
  assert.equal(migrations.length, 40);
  assert.equal(migrations[migrations.length - 1], "040_annual_checkout_retry_fingerprints.sql");
  assert.deepEqual(migrations.filter(f => Number(f.slice(0, 3)) > 40), [], "a 041 appeared");
  // 039 and 040 are both live now: no migration may be edited at all.
  const changed = execFileSync("git", ["diff", "--name-only", "HEAD", "--", "supabase/migrations/"],
    { cwd: ROOT, encoding: "utf-8" }).trim();
  assert.equal(changed, "", "a live, immutable migration was edited");

  // Out of scope, and provably not called.
  for (const source of [flow, rulesCode, workerCode, depsCode]) {
    for (const banned of [
      "claim_annual_plan_purchase_email", "record_annual_plan_purchase_email_result",
      "apply_annual_plan_refund_state", "complete_due_annual_plans",
      "Resend", "resend", "sendOrder", "cron",
    ]) {
      assert.ok(!source.includes(banned), `this phase calls ${banned}`);
    }
  }
  // No cron route was added and vercel.json is unchanged.
  assert.match(read("vercel.json"), /"path":\s*"\/api\/cron\/retry-order-notifications"/);
  assert.equal((read("vercel.json").match(/"path":/g) || []).length, 1, "a second cron appeared");
  // The existing refund handling is untouched.
  assert.ok(routeCode.includes("await handleRefundEvent(stripe, event);"));
  assert.ok(routeCode.includes("async function handleRefundEvent("));
});
