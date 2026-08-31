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
  classifyAnnualLinkReread,
  classifyAnnualPaidReread,
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
  assert.ok(at("verifyAnnualPaymentAttempt(") < at("await deps.linkSessionAtomically("));
  assert.ok(at("verifyAnnualPlanCorrelation(") < at("await deps.linkSessionAtomically("));
  assert.ok(at("verifyAnnualPlanCorrelation(") < at("await deps.settlePaidAtomically("));
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
  // The flow refuses a conflict before settling paid or activating.
  assert.ok(at('if (link.kind === "conflict")') < at("await deps.settlePaidAtomically("));
  assert.ok(flow.includes("throw new AnnualWebhookConflict(`annual attempt ${attempt.id}: ${link.reason}`)"));
  // Phase 4B4.1: through the ATOMIC writer, and never the unconditional
  // one. decideSessionLink above is a pre-read and is no longer what
  // makes this safe, so the compare-and-set runs unconditionally.
  assert.ok(flow.includes("await deps.linkSessionAtomically(attempt.id, session.id)"));
  assert.ok(!flow.includes("deps.linkSession("), "the flow still calls the unconditional link writer");
  assert.ok(depsCode.includes("linkSessionAtomically: linkAnnualStripeSessionAtomically"));
  assert.ok(!depsCode.includes("linkStripeSession"), "the wiring can still reach the unconditional writer");
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

  // This pre-read runs first, but it is NOT what makes settlement safe -
  // see tests 34 to 44. The durable write is the compare-and-set, and the
  // annual flow no longer reaches markAttemptPaid at all.
  assert.ok(at("decidePaidState(") < at("await deps.settlePaidAtomically("));
  assert.ok(!flow.includes("deps.markPaid("), "the flow still calls the unconditional paid writer");
  assert.ok(!depsCode.includes("markAttemptPaid"), "the wiring can still reach the unconditional writer");

  // And markAttemptPaid itself is UNCHANGED. It is the one-time and
  // subscription flows' settled behaviour, and the annual concurrency
  // problem was fixed beside it rather than inside it.
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

/* ══════════════════════════════════════════════════════════════
   34-47. PHASE 4B4.1: ATOMIC SETTLEMENT UNDER CONCURRENCY

   Phase 4B4 proved every REFUSAL. These prove the refusals still
   hold when two webhook invocations overlap.

   Stripe delivers concurrently and retries hard, so:

        A reads   session NULL, status not paid
        B reads   session NULL, status not paid   <- same stale row
        A links session_A, settles pi_A at t1
        B is still holding its stale decision

   is ordinary rather than exotic. A read, a JavaScript decision and
   an unconditional write cannot survive it. The two annual writers
   are therefore compare-and-set, and what follows drives them.
   ══════════════════════════════════════════════════════════════ */

const attemptsSource = read("lib/checkoutAttempts.ts");
const sliceBetween = (source, from, to) => {
  const a = source.indexOf(from);
  assert.notEqual(a, -1, `missing: ${from}`);
  const b = to ? source.indexOf(to, a) : source.length;
  assert.notEqual(b, -1, `missing: ${to}`);
  return source.slice(a, b);
};

const LINK_CAS = sliceBetween(
  attemptsSource,
  "export async function linkAnnualStripeSessionAtomically(",
  "export type AnnualPaidSettlementOutcome"
);
const PAID_CAS = sliceBetween(
  attemptsSource,
  "export async function settleAnnualAttemptPaidAtomically(",
  null
);

/**
 * The annual PAYMENT shape, restated as the seven predicates BOTH
 * compare-and-set writers carry. Pinned against the source below, so the
 * in-memory model underneath cannot drift away from the real statements.
 */
const ANNUAL_SHAPE_GUARDS = [
  '.not("annual_intent_fingerprint", "is", null)',
  '.not("annual_request_fingerprint", "is", null)',
  '.is("annual_plan_id", null)',
  '.is("annual_delivery_number", null)',
  '.is("subscription_id", null)',
  '.is("subscription_request_fingerprint", null)',
  '.is("subscription_intent_fingerprint", null)',
];

const isAnnualPaymentShape = r =>
  r.annual_intent_fingerprint !== null && r.annual_request_fingerprint !== null
  && r.annual_plan_id === null && r.annual_delivery_number === null
  && r.subscription_id === null
  && r.subscription_request_fingerprint === null
  && r.subscription_intent_fingerprint === null;

/** A fixed stamp. Nothing in this suite reads a clock. */
const PAID_AT = "2026-09-01T09:30:00.000Z";
const PAID_AT_LATER = "2026-09-01T09:31:00.000Z";

/**
 * ONE checkout_attempts row plus the two compare-and-set writers applied
 * to it exactly as lib/checkoutAttempts.ts applies them, and resolving a
 * lost race through the REAL classifiers imported above.
 *
 * Postgres serialises two concurrent UPDATEs of one row, so at most one
 * of them can find the row in the state its WHERE clause requires. A
 * single-threaded model reproduces that faithfully: both callers decide
 * from the same stale snapshot, then write in some order, and the second
 * one finds the row already moved.
 */
const casRow = (over = {}) => {
  const state = attempt({ stripe_checkout_session_id: null, ...over });
  // Any SECOND stamp would land a different value, so an assertion on
  // PAID_AT is a real write-once assertion rather than a tautology.
  let stamps = 0;
  return {
    read: () => ({ ...state }),
    linkSessionAtomically: async (attemptId, sessionId) => {
      const matched = state.id === attemptId
        && state.stripe_checkout_session_id === null
        && state.paid_at === null
        && state.status !== "paid"
        && isAnnualPaymentShape(state);
      if (matched) {
        state.stripe_checkout_session_id = sessionId;
        state.status = "stripe_session_created";
        return { kind: "linked" };
      }
      return classifyAnnualLinkReread({ attempt: { ...state }, expectedSessionId: sessionId });
    },
    settlePaidAtomically: async ({ attemptId, stripeCheckoutSessionId, stripePaymentIntentId }) => {
      const matched = state.id === attemptId
        && state.stripe_checkout_session_id === stripeCheckoutSessionId
        && state.paid_at === null
        && state.stripe_payment_intent_id === null
        && state.status !== "paid"
        && isAnnualPaymentShape(state);
      if (matched) {
        state.status = "paid";
        state.paid_at = stamps++ === 0 ? PAID_AT : PAID_AT_LATER;
        state.stripe_payment_intent_id = stripePaymentIntentId;
        return { kind: "settled" };
      }
      return classifyAnnualPaidReread({
        attempt: { ...state },
        expectedSessionId: stripeCheckoutSessionId,
        expectedPaymentIntentId: stripePaymentIntentId,
      });
    },
  };
};

/** One invocation's whole durable interaction, from a stale pre-read. */
const settleOnce = async (row, { sessionId, paymentIntentId }) => {
  const link = await row.linkSessionAtomically(ATTEMPT_ID, sessionId);
  if (link.kind === "conflict" || link.kind === "error") return { stopped: "link", link };
  const paid = await row.settlePaidAtomically({
    attemptId: ATTEMPT_ID,
    stripeCheckoutSessionId: sessionId,
    stripePaymentIntentId: paymentIntentId,
  });
  return { link, paid };
};

test("34: the annual settlement writers are compare-and-set, not blind writes", () => {
  // The predicate is the guarantee, so the predicate is what is pinned.
  for (const guard of [
    '.eq("id", attemptId)',
    '.is("stripe_checkout_session_id", null)',
    '.is("paid_at", null)',
    '.neq("status", "paid")',
    ...ANNUAL_SHAPE_GUARDS,
    '.select("id")',
  ]) {
    assert.ok(LINK_CAS.includes(guard), `the link CAS lost its guard: ${guard}`);
  }
  for (const guard of [
    '.eq("id", input.attemptId)',
    '.eq("stripe_checkout_session_id", input.stripeCheckoutSessionId)',
    '.is("paid_at", null)',
    '.is("stripe_payment_intent_id", null)',
    '.neq("status", "paid")',
    ...ANNUAL_SHAPE_GUARDS,
    '.select("id")',
  ]) {
    assert.ok(PAID_CAS.includes(guard), `the paid CAS lost its guard: ${guard}`);
  }
  // Zero rows is a QUESTION, answered from a fresh read of the row that
  // won - never assumed to be either success or failure.
  for (const cas of [LINK_CAS, PAID_CAS]) {
    assert.ok(cas.includes("await findAnnualPaymentAttemptById("), "a lost race is not re-read");
    assert.ok(cas.includes('(data?.length ?? 0) > 0'), "the affected-row count is not consulted");
  }
  assert.ok(LINK_CAS.includes("classifyAnnualLinkReread("));
  assert.ok(PAID_CAS.includes("classifyAnnualPaidReread("));
  // No migration was needed: these are UPDATEs on a table the existing
  // writers already update, with a narrower WHERE clause.
  for (const cas of [LINK_CAS, PAID_CAS]) {
    assert.ok(!cas.includes(".rpc("), "the settlement writer calls an RPC");
    assert.ok(cas.includes('from("checkout_attempts")'));
  }
});

test("35: same Session and same PaymentIntent, two concurrent invocations", async () => {
  const row = casRow();
  // Both start from the same stale unlinked, unsettled read.
  const [a, b] = await Promise.all([
    settleOnce(row, { sessionId: SESSION_A, paymentIntentId: PI_A }),
    settleOnce(row, { sessionId: SESSION_A, paymentIntentId: PI_A }),
  ]);

  // Exactly one of each write lands.
  const linked = [a, b].filter(r => r.link.kind === "linked");
  const settled = [a, b].filter(r => r.paid?.kind === "settled");
  assert.equal(linked.length, 1, "both invocations linked");
  assert.equal(settled.length, 1, "both invocations settled");
  // And the loser is a clean idempotent success, not an error.
  assert.equal([a, b].filter(r => r.link.kind === "already_linked").length, 1);
  assert.equal([a, b].filter(r => r.paid?.kind === "already_settled").length, 1);

  const final = row.read();
  assert.equal(final.stripe_checkout_session_id, SESSION_A);
  assert.equal(final.stripe_payment_intent_id, PI_A);
  assert.equal(final.status, "paid");
  assert.equal(final.paid_at, PAID_AT, "paid_at was stamped more than once");
});

test("36: a replay after settlement changes nothing at all", async () => {
  const row = casRow();
  await settleOnce(row, { sessionId: SESSION_A, paymentIntentId: PI_A });
  const afterFirst = row.read();

  // Stripe redelivers the same event. Twice.
  for (let i = 0; i < 2; i++) {
    const replay = await settleOnce(row, { sessionId: SESSION_A, paymentIntentId: PI_A });
    assert.equal(replay.link.kind, "already_linked");
    assert.equal(replay.paid.kind, "already_settled");
  }
  assert.deepEqual(row.read(), afterFirst, "a replay mutated the settled attempt");
  assert.equal(row.read().paid_at, PAID_AT);
});

test("37: session_A against session_B from one unlinked row - exactly one wins", async () => {
  for (const [first, second] of [[SESSION_A, SESSION_B], [SESSION_B, SESSION_A]]) {
    const row = casRow();
    const winner = await settleOnce(row, { sessionId: first, paymentIntentId: PI_A });
    const loser = await settleOnce(row, { sessionId: second, paymentIntentId: PI_B });

    assert.equal(winner.link.kind, "linked");
    assert.equal(winner.paid.kind, "settled");
    // The loser NEVER overwrites, and never reaches the paid write.
    assert.equal(loser.stopped, "link");
    assert.equal(loser.link.kind, "conflict");
    assert.match(loser.link.reason, /different Stripe session/);

    const final = row.read();
    assert.equal(final.stripe_checkout_session_id, first, "last write won");
    assert.equal(final.stripe_payment_intent_id, PI_A);
    assert.equal(final.paid_at, PAID_AT);
  }
});

test("38: pi_A against pi_B on one linked row - exactly one becomes authoritative", async () => {
  for (const [first, second] of [[PI_A, PI_B], [PI_B, PI_A]]) {
    // Both invocations carry the SAME session, so both pass the link, and
    // only the paid compare-and-set can separate them.
    const row = casRow({ stripe_checkout_session_id: SESSION_A });
    const winner = await settleOnce(row, { sessionId: SESSION_A, paymentIntentId: first });
    const loser = await settleOnce(row, { sessionId: SESSION_A, paymentIntentId: second });

    assert.equal(winner.link.kind, "already_linked");
    assert.equal(winner.paid.kind, "settled");
    assert.equal(loser.paid.kind, "conflict");
    assert.match(loser.paid.reason, /different payment/);

    const final = row.read();
    assert.equal(final.stripe_payment_intent_id, first, "the second PaymentIntent overwrote the first");
    assert.equal(final.paid_at, PAID_AT);
  }
});

test("39: a link retry after another invocation settled cannot regress paid", async () => {
  const row = casRow();
  await settleOnce(row, { sessionId: SESSION_A, paymentIntentId: PI_A });
  assert.equal(row.read().status, "paid");

  // A stale invocation now resumes and tries the link it decided on
  // before any of that happened. The UPDATE carries status <> 'paid' and
  // stripe_checkout_session_id IS NULL, so it does not run.
  const stale = await row.linkSessionAtomically(ATTEMPT_ID, SESSION_A);
  assert.equal(stale.kind, "already_linked");
  assert.equal(row.read().status, "paid", "the link write regressed a settled attempt");
  assert.equal(row.read().paid_at, PAID_AT);

  // Even the pure pre-read agrees, but it is not what stopped it: the
  // link writer would refuse a paid row on its own predicate.
  assert.ok(LINK_CAS.includes('.neq("status", "paid")'));
  assert.ok(LINK_CAS.includes('.is("paid_at", null)'));
});

test("40: after activation, a stale writer cannot drift the plan's identity", async () => {
  // Activation has happened. The plan's purchased_at IS this paid_at, and
  // its refund correlation IS this PaymentIntent, so neither may move.
  const row = casRow();
  await settleOnce(row, { sessionId: SESSION_A, paymentIntentId: PI_A });
  const activated = row.read();

  // Two stale writers resume: one with the same facts, one with different
  // ones. Neither may touch the row.
  const replay = await settleOnce(row, { sessionId: SESSION_A, paymentIntentId: PI_A });
  assert.equal(replay.paid.kind, "already_settled");
  const impostor = await settleOnce(row, { sessionId: SESSION_B, paymentIntentId: PI_B });
  assert.equal(impostor.link.kind, "conflict");

  assert.deepEqual(row.read(), activated, "the settled attempt drifted after activation");

  // And the activation RPC re-proves the same equalities under its own
  // row lock, so this is the earlier of two independent refusals.
  const m039 = read("supabase/migrations/039_b2c_annual_plan_foundation.sql");
  assert.ok(m039.includes("payment_intent_conflict"));
  assert.ok(m039.includes("checkout_session_conflict"));
  assert.ok(m039.includes("v_purchased := v_attempt.paid_at;"),
    "039 stopped freezing purchased_at from the attempt");
});

test("41: a lost race is only a success when the durable row agrees exactly", () => {
  // The link re-read.
  assert.deepEqual(
    classifyAnnualLinkReread({ attempt: { stripe_checkout_session_id: SESSION_A }, expectedSessionId: SESSION_A }),
    { kind: "already_linked" });
  for (const [row, pattern] of [
    [{ stripe_checkout_session_id: SESSION_B }, /different Stripe session/],
    [{ stripe_checkout_session_id: null }, /not a settleable annual payment/],
    [null, /disappeared/],
  ]) {
    const out = classifyAnnualLinkReread({ attempt: row, expectedSessionId: SESSION_A });
    assert.equal(out.kind, "conflict");
    assert.match(out.reason, pattern);
  }

  // The paid re-read. All four facts must agree.
  const settledRow = {
    status: "paid", paid_at: PAID_AT,
    stripe_checkout_session_id: SESSION_A, stripe_payment_intent_id: PI_A,
  };
  const ask = over => classifyAnnualPaidReread({
    attempt: over === null ? null : { ...settledRow, ...over },
    expectedSessionId: SESSION_A,
    expectedPaymentIntentId: PI_A,
  });
  assert.deepEqual(ask({}), { kind: "already_settled" });
  for (const [over, pattern] of [
    [{ stripe_checkout_session_id: SESSION_B }, /different Stripe session/],
    [{ stripe_payment_intent_id: PI_B }, /different payment/],
    [{ stripe_payment_intent_id: null }, /different payment/],
    [{ status: "stripe_session_created" }, /did not reach a settled state/],
    [{ paid_at: null }, /did not reach a settled state/],
    [null, /disappeared/],
  ]) {
    const out = ask(over);
    assert.equal(out.kind, "conflict", JSON.stringify(over));
    assert.match(out.reason, pattern);
  }
});

test("42: neither settlement writer can reach another attempt population", async () => {
  // A one-time attempt, a subscription attempt and migration 039's
  // synthetic DELIVERY attempt all fail the shape predicate, so the
  // UPDATE does not run and the re-read refuses.
  const populations = {
    "one-time": { annual_intent_fingerprint: null, annual_request_fingerprint: null },
    subscription: { subscription_request_fingerprint: "c".repeat(64), subscription_id: "sub_1" },
    delivery: { annual_plan_id: PLAN_ID, annual_delivery_number: 1 },
  };
  for (const [name, over] of Object.entries(populations)) {
    const row = casRow(over);
    const out = await settleOnce(row, { sessionId: SESSION_A, paymentIntentId: PI_A });
    assert.equal(out.link.kind, "conflict", name);
    assert.equal(row.read().stripe_checkout_session_id, null, `${name} was linked`);
    assert.equal(row.read().paid_at, null, `${name} was settled`);
  }
});

test("43: the VALID annual payment shape has no plan id and no delivery number", () => {
  // The annual PLAN points at the payment attempt through
  // annual_plans.payment_checkout_attempt_id. The payment attempt does
  // NOT point back, so both annual link columns are null on it.
  const valid = attempt();
  assert.equal(valid.annual_plan_id, null);
  assert.equal(valid.annual_delivery_number, null);
  assert.notEqual(valid.annual_intent_fingerprint, null);
  assert.notEqual(valid.annual_request_fingerprint, null);
  assert.equal(valid.subscription_request_fingerprint, null);
  assert.equal(valid.subscription_intent_fingerprint, null);
  assert.equal(valid.subscription_id, null);
  assert.notEqual(valid.user_id, null);
  assert.deepEqual(verifyAnnualPaymentAttempt({ attempt: valid, metadata: META }), { ok: true });

  // The relationship direction is 039's, not this suite's invention.
  const m039 = read("supabase/migrations/039_b2c_annual_plan_foundation.sql");
  assert.ok(m039.includes("payment_checkout_attempt_id"));

  // A synthetic DELIVERY attempt is the mirror image, and the PAYMENT
  // webhook rejects it - it has no Stripe payment identity to settle.
  const delivery = attempt({
    annual_plan_id: PLAN_ID, annual_delivery_number: 1,
    annual_intent_fingerprint: null, annual_request_fingerprint: null,
    stripe_checkout_session_id: null,
  });
  const refused = verifyAnnualPaymentAttempt({ attempt: delivery, metadata: META });
  assert.equal(refused.ok, false);
  // Refused for being unsettleable, whichever check catches it first.
  assert.match(refused.reason, /annual delivery|no annual payment intent/);
});

test("44: an infrastructure failure is retryable, a business guard is not", async () => {
  // INFRASTRUCTURE: the queue is unreachable, one fulfillment throws, or
  // the RPC answers a word nobody recognises. All three are failures.
  const unreachable = await runAnnualDeliveryWorker(workerPort({ claimThrows: true }).deps);
  assert.ok(unreachable.failed > 0);
  const threw = await runAnnualDeliveryWorker(
    workerPort({ rows: [claimed()], fulfillThrows: DELIVERY_ID }).deps);
  assert.ok(threw.failed > 0);
  const unknown = await runAnnualDeliveryWorker(
    workerPort({ rows: [claimed()], answers: { [DELIVERY_ID]: { result: "who_knows" } } }).deps);
  assert.ok(unknown.failed > 0);

  // BUSINESS GUARD: the parent said no after the claim. Nothing was
  // created, retrying would not change the answer, and manufacturing an
  // order would defeat the guard. Counted, reported, never escalated.
  for (const word of ANNUAL_FULFILL_GUARDED_RESULTS) {
    const guarded = await runAnnualDeliveryWorker(
      workerPort({ rows: [claimed()], answers: { [DELIVERY_ID]: { result: word } } }).deps);
    assert.equal(guarded.guarded, 1, word);
    assert.equal(guarded.failed, 0, `${word} was escalated to a failure`);
    assert.equal(guarded.fulfilled, 0, `${word} was counted as a fulfillment`);
    assert.ok(guarded.outcomes.every(o => o.orderId === null), `${word} produced an order id`);
  }

  // And the flow escalates on `failed` ALONE. A guarded refusal must
  // never become an endless Stripe retry.
  const escalation = sliceBetween(flow, "if (worker.failed > 0) {", "return {");
  assert.ok(escalation.includes("throw new Error("), "a worker failure is swallowed");
  assert.ok(!escalation.includes("worker.guarded"), "a business guard triggers a Stripe retry");
  assert.ok(!flow.includes("if (worker.guarded"), "a business guard is escalated");
});

test("45: a worker failure reaches Stripe as a retry, and marks nothing processed", () => {
  // The chain, asserted where each link actually lives.
  //
  // 1. the flow throws rather than returning a summary
  assert.ok(at("const worker = await runAnnualDeliveryWorker(") < at("if (worker.failed > 0) {"));
  assert.ok(sliceBetween(flow, "if (worker.failed > 0) {", "return {").includes("throw new Error("),
    "the worker failure does not stop the handler");
  // 2. the route calls it INSIDE the try whose catch answers 500
  const guarded = sliceBetween(routeCode,
    'if (event.type === "checkout.session.completed") {',
    "const recorded = await recordStripeWebhookEvent(");
  assert.ok(guarded.includes("await settleAnnualCheckoutSession("),
    "the annual settlement moved out of the guarded block");
  assert.ok(guarded.includes("} catch (err) {"));
  assert.ok(guarded.includes("{ status: 500 }"), "a handler failure no longer answers 5xx");
  // 3. and the processed-event marker is written only AFTER that block,
  //    so a throw skips it and Stripe redelivers against fresh state.
  assert.ok(routeCode.indexOf("} catch (err) {")
    < routeCode.indexOf("const recorded = await recordStripeWebhookEvent("),
    "the event is marked processed before the handler can fail");
  // lastIndexOf, because the same 200 also short-circuits an event that
  // was ALREADY recorded. The one that matters here is the final one.
  assert.ok(routeCode.lastIndexOf("return Response.json({ received: true }, { status: 200 });")
    > routeCode.indexOf("const recorded = await recordStripeWebhookEvent("),
    "the route acknowledges before recording");
  // 4. which is safe only because every step is idempotent - tests 35-40.
});

test("46: a session that is not yet paid activates nothing", () => {
  // The frozen attempt is the amount authority and evaluateStripeSessionPayment
  // is the same evaluator the one-time flow uses. Anything that is not a
  // completed payment is refused, and the refusal is BEFORE any write.
  for (const status of ["unpaid", "no_payment_required", "processing", ""]) {
    const out = evaluateStripeSessionPayment(
      { payment_status: status, currency: "eur", amount_total: 35087 },
      { currency: "EUR", expected_total_gross_cents: 35087 }
    );
    assert.equal(out.shouldMarkPaid, false, status);
  }
  assert.ok(at("evaluateStripeSessionPayment(") < at("await deps.settlePaidAtomically("));
  assert.ok(at("if (!evaluation.shouldMarkPaid)") < at("await deps.activatePlan("));
});

test("47: asynchronous payment methods remain an open product decision", () => {
  // AUDIT, PINNED. The annual Checkout Session names no payment methods,
  // exactly like the one-time and subscription flows: all three inherit
  // whatever the Stripe Dashboard has enabled.
  const annualCheckout = read("lib/annualPlanCheckout.ts");
  assert.ok(annualCheckout.includes('mode: "payment",'));
  for (const key of ["payment_method_types", "payment_method_options", "payment_method_configuration"]) {
    assert.ok(!annualCheckout.includes(key), `the annual checkout now constrains ${key}`);
    assert.ok(!read("app/api/checkout/session/route.ts").includes(key));
  }
  // So whether a delayed-notification method can be used is a Dashboard
  // fact, not a repository fact, and this phase deliberately did not
  // change it: doing so would change which payment methods customers are
  // offered.
  //
  // The consequence is recorded rather than hidden. The route handles
  // NEITHER async event, for any product, and says so:
  assert.ok(!routeCode.includes("async_payment_succeeded"),
    "the route now handles async payments - this guard needs rewriting, not deleting");
  assert.ok(read("app/api/stripe/webhook/route.ts").includes("checkout.session.async_payment_succeeded"),
    "the open question stopped being documented in the route");
  // If such a method is ever enabled, checkout.session.completed arrives
  // not-yet-paid, test 46 refuses it, and the later success event is
  // unhandled - for one-time purchases exactly as for annual ones. That
  // is a product-wide decision and it is reported, not silently patched.
});
