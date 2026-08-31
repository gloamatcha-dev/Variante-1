import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateStripeSessionPayment } from "../lib/stripeFulfillment.ts";
import { routeAnnualSession } from "../lib/annualPlanWebhookRules.ts";

/* ══════════════════════════════════════════════════════════════
   PRE-GO-LIVE - DELAYED PAYMENT FOR A ONE-TIME ORDER

   SAFE DEFAULT SUITE: the pure payment evaluator driven with plain
   literals, plus source-level checks on the webhook's routing.

   No Stripe client is constructed, no Session is created or retrieved,
   no webhook is delivered, no Supabase client exists, no SQL runs and no
   email is sent. Nothing here reads a clock.

   What it protects: a customer who pays by SEPA Direct Debit or bank
   transfer. Their Checkout Session completes days before the money
   arrives, so checkout.session.completed carries payment_status
   "unpaid" - and until this phase nothing ever looked at that session
   again. They could pay in full and never receive an order.
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

const route = withoutComments(read("app/api/stripe/webhook/route.ts"));

/** The dispatcher arm for one event type, as written. */
const arm = (from, to) => {
  const a = route.indexOf(from);
  assert.notEqual(a, -1, `missing arm: ${from}`);
  const b = route.indexOf(to, a);
  assert.notEqual(b, -1, `missing arm end: ${to}`);
  return route.slice(a, b);
};

const COMPLETED = 'event.type === "checkout.session.completed"';
const ASYNC_OK = 'event.type === "checkout.session.async_payment_succeeded"';
const ASYNC_FAIL = 'event.type === "checkout.session.async_payment_failed"';
const INVOICE_PAID = 'event.type === "invoice.paid"';

const attempt = { currency: "EUR", expected_total_gross_cents: 3098 };
const paidSession = { payment_status: "paid", currency: "eur", amount_total: 3098 };

/* ══════════════════════════════════════════════════════════════
   1-4. WHAT "PAID" MEANS, AND WHERE IT COMES FROM
   ══════════════════════════════════════════════════════════════ */

test("1: an unpaid session is refused, so a completed-but-unsettled checkout mints nothing", () => {
  for (const status of ["unpaid", "no_payment_required", "", "processing"]) {
    const evaluation = evaluateStripeSessionPayment({ ...paidSession, payment_status: status }, attempt);
    assert.equal(evaluation.shouldMarkPaid, false, `payment_status ${status} was accepted`);
  }
  // And the paid case is the only one that settles.
  assert.deepEqual(evaluateStripeSessionPayment(paidSession, attempt), { shouldMarkPaid: true });
});

test("2: the frozen attempt is the authority on the money, not the session", () => {
  // A currency or amount that disagrees with what this attempt was priced
  // for is refused, whichever event delivered it.
  assert.equal(
    evaluateStripeSessionPayment({ ...paidSession, currency: "usd" }, attempt).shouldMarkPaid,
    false
  );
  assert.equal(
    evaluateStripeSessionPayment({ ...paidSession, amount_total: 3097 }, attempt).shouldMarkPaid,
    false
  );
  assert.equal(
    evaluateStripeSessionPayment({ ...paidSession, amount_total: null }, attempt).shouldMarkPaid,
    false
  );
  // Case is not a difference: Stripe answers lowercase, the attempt stores
  // uppercase.
  assert.equal(
    evaluateStripeSessionPayment({ ...paidSession, currency: "EUR" }, attempt).shouldMarkPaid,
    true
  );
});

test("3: BOTH paid triggers re-retrieve the Session and never trust the payload", () => {
  // One settlement function, and it opens by re-reading Stripe.
  const handler = route.slice(route.indexOf("async function handleCheckoutSessionCompleted"));
  assert.match(handler.slice(0, 400), /const session = await stripe\.checkout\.sessions\.retrieve\(eventSession\.id\);/);
  assert.match(handler, /evaluateStripeSessionPayment\(\s*\{\s*payment_status: session\.payment_status,/);

  // The event's own object is used for its ID and its routing metadata
  // only. No arm reads a payment fact off the payload.
  for (const [name, block] of [["completed", arm(COMPLETED, ASYNC_OK)], ["async success", arm(ASYNC_OK, ASYNC_FAIL)]]) {
    for (const banned of [
      "eventSession.payment_status", "event.data.object.payment_status",
      "session.payment_status ===", "session.amount_total", "session.currency",
    ]) {
      assert.ok(!block.includes(banned), `the ${name} arm trusts the payload: ${banned}`);
    }
  }
});

test("4: nothing in the settlement path takes payment truth from a browser", () => {
  for (const banned of ["searchParams", "request.json()", "?success=", "session_id=", "req.query"]) {
    assert.ok(!route.includes(banned), `the webhook reads ${banned}`);
  }
  // The one Stripe read is the Session retrieval; the signature check
  // stays upstream of every handler.
  assert.ok(route.indexOf("stripe.webhooks.constructEvent") < route.indexOf("checkout.session.completed"));
});

/* ══════════════════════════════════════════════════════════════
   5-8. THE ROUTING, AND THAT IT IS ONE PATH
   ══════════════════════════════════════════════════════════════ */

test("5: a delayed ONE-TIME payment now settles, through the SAME handler", () => {
  const block = arm(ASYNC_OK, ASYNC_FAIL);
  // The gap this phase closed: the arm used to acknowledge a non-annual
  // async payment and do nothing at all.
  assert.ok(block.includes("await handleCheckoutSessionCompleted(stripe, session);"),
    "a delayed one-time payment is still dropped");
  // The SAME function the ordinary paid event calls - not a second
  // "async order creation path".
  const completed = arm(COMPLETED, ASYNC_OK);
  assert.ok(completed.includes("await handleCheckoutSessionCompleted(stripe, session);"));
  assert.equal(
    [...route.matchAll(/async function handleCheckoutSessionCompleted\(/g)].length, 1,
    "a second one-time settlement function appeared"
  );
  assert.equal(
    [...route.matchAll(/createOrderFromPaidCheckoutAttempt\(/g)].length, 1,
    "a second one-time order creator appeared"
  );
});

test("6: annual is routed first on BOTH events, and never into the one-time handler", () => {
  for (const [name, block] of [["completed", arm(COMPLETED, ASYNC_OK)], ["async success", arm(ASYNC_OK, ASYNC_FAIL)]]) {
    const annualAt = block.indexOf("routeAnnualSession(session.metadata)");
    const oneTimeAt = block.indexOf("handleCheckoutSessionCompleted(stripe, session)");
    assert.ok(annualAt > -1, `${name} does not route annual sessions`);
    if (oneTimeAt > -1) {
      assert.ok(annualAt < oneTimeAt, `${name} can send an annual session to the one-time handler`);
    }
    // Malformed annual metadata fails closed on both, rather than
    // falling through to a handler written for another product.
    assert.ok(block.includes('if (annual.kind === "malformed") {'), `${name} does not fail closed`);
    assert.ok(block.includes("throw new Error("));
  }
  // The router keys on metadata, never on amount, SKU or customer.
  assert.equal(routeAnnualSession(undefined).kind, "not_annual");
  assert.equal(routeAnnualSession({}).kind, "not_annual");
  assert.equal(routeAnnualSession({ gloa_annual_plan_id: "not-a-uuid" }).kind, "malformed");
});

test("7: a SUBSCRIPTION session is not settled by this event, on either trigger", () => {
  const block = arm(ASYNC_OK, ASYNC_FAIL);
  assert.match(block, /else if \(session\.mode === "subscription"\) \{/);
  // invoice.paid remains the canonical fulfillment event: the arm logs
  // and creates nothing.
  // The arm itself, bounded at the one-time branch that follows it.
  const armStart = block.indexOf('session.mode === "subscription"');
  const subscriptionArm = block.slice(armStart, block.indexOf("} else {", armStart));
  assert.ok(subscriptionArm.length > 0, "the subscription arm could not be isolated");
  for (const banned of [
    "handleSubscriptionSessionCompleted", "handleCheckoutSessionCompleted",
    "fulfillPaidSubscriptionInvoice", "createOrder", "markAttemptPaid", "activate_subscription",
    "await ",
  ]) {
    assert.ok(!subscriptionArm.includes(banned), `the subscription async arm calls ${banned}`);
  }
  assert.ok(route.includes(INVOICE_PAID), "invoice.paid is no longer handled");
});

test("8: async FAILURE creates nothing, for any product", () => {
  const block = arm(ASYNC_FAIL, INVOICE_PAID);
  for (const banned of [
    "handleCheckoutSessionCompleted", "settleAnnualCheckoutSession", "markAttemptPaid",
    "createOrderFromPaidCheckoutAttempt", "create_order_from_paid_checkout",
    "sendOrderConfirmationEmailIfNeeded", "sendInternalOrderNotificationIfNeeded",
    "activatePlan", "runAnnualDeliveryWorker", "paid", "await ",
  ]) {
    assert.ok(!block.includes(banned), `the async failure arm reaches for ${banned}`);
  }
  // It acknowledges, so Stripe does not redeliver a permanently failed
  // payment forever.
  assert.ok(!block.includes("throw new Error(`annual async failure") || block.includes("malformed"));
});

/* ══════════════════════════════════════════════════════════════
   9-11. EXACTLY ONE ORDER, WHICHEVER EVENT ARRIVES
   ══════════════════════════════════════════════════════════════ */

test("9: the order is minted by an idempotent, row-locking database function", () => {
  const creator = read("supabase/migrations/021_tax_snapshot.sql");
  const fn = creator.slice(creator.indexOf("create or replace function public.create_order_from_paid_checkout"));
  // It locks the attempt, so two concurrent settlements serialise.
  assert.match(fn.slice(0, 1200), /from public\.checkout_attempts\s+where id = p_checkout_attempt_id\s+for update/);
  // It refuses an unpaid attempt outright.
  assert.match(fn.slice(0, 1400), /if v_attempt\.status <> 'paid' then/);
  // And an attempt that already has an order gets that order back.
  assert.match(fn, /select \* into v_order\s+from public\.orders\s+where checkout_attempt_id = p_checkout_attempt_id;/);
  assert.match(fn, /if found then[\s\S]{0,400}return v_order;/);
  // Backed by a unique index, so even a lost race cannot produce a second.
  const m011 = read("supabase/migrations/011_orders_from_paid_checkout.sql");
  assert.match(m011, /create unique index orders_checkout_attempt_id_key\s+on public\.orders \(checkout_attempt_id\)/);
  assert.match(m011, /create unique index orders_stripe_checkout_session_id_key/);
});

test("10: the attempt is resolved by durable identity, never by customer facts", () => {
  const handler = route.slice(
    route.indexOf("async function handleCheckoutSessionCompleted"),
    route.indexOf("async function handleInvoicePaid")
  );
  assert.ok(handler.includes("findAttemptByStripeSessionId(session.id)"));
  assert.ok(handler.includes("findAttemptByRequestId(requestId)"));
  assert.ok(handler.includes("linkStripeSession(attempt.id, session.id)"));
  // The attempt is looked up by exactly two durable identities and by
  // nothing else. (The frozen line snapshot legitimately carries a sku,
  // which is data the notification prints - never a lookup key.)
  const lookups = [...handler.matchAll(/findAttemptBy[A-Za-z]+\(/g)].map(m => m[0]);
  assert.deepEqual([...new Set(lookups)].sort(),
    ["findAttemptByRequestId(", "findAttemptByStripeSessionId("]);
  for (const banned of [
    "customer_details.email,", "customerEmail ===", "amount_total ===",
    "by_email", 'eq("email"', 'eq("sku"', "findAttemptByEmail", "findAttemptByAmount",
  ]) {
    assert.ok(!handler.includes(banned), `the one-time settlement correlates by ${banned}`);
  }
  // A session nobody has an attempt for is acknowledged, not guessed at.
  assert.match(handler, /no checkout attempt found for session/);
});

test("11: the eventual paid order still runs the ordinary post-order path", () => {
  const handler = route.slice(
    route.indexOf("async function handleCheckoutSessionCompleted"),
    route.indexOf("async function handleInvoicePaid")
  );
  const order = handler.indexOf("const order = await createOrderFromPaidCheckoutAttempt");
  const confirmation = handler.indexOf("await sendOrderConfirmationEmailIfNeeded(");
  const internal = handler.indexOf("await sendInternalOrderNotificationIfNeeded(");
  assert.ok(order > -1 && confirmation > order, "the customer confirmation runs before the order exists");
  assert.ok(confirmation < internal, "the customer's own message lost its first attempt");
  assert.ok(handler.includes('source: "one_time"'));
  // Because the async event enters the SAME function, a delayed payment
  // gets exactly this, and each sender keeps its own claim.
  const sender = read("lib/orderConfirmationEmail.ts");
  assert.match(sender, /\.in\("confirmation_email_status", \["pending", "failed"\]\)/);
  const internalSender = read("lib/internalOrderNotificationEmail.ts");
  assert.match(internalSender, /\.or\("internal_notification_status\.is\.null,internal_notification_status\.eq\.failed"\)/);
});

/* ══════════════════════════════════════════════════════════════
   12-13. THE EVENT SURFACE, AND WHAT STILL GUARDS IT
   ══════════════════════════════════════════════════════════════ */

test("12: the handled event surface is exactly what the runtime expects", () => {
  const handled = [...route.matchAll(/event\.type === "([a-z_.]+)"/g)].map(m => m[1]);
  assert.deepEqual([...new Set(handled)].sort(), [
    "checkout.session.async_payment_failed",
    "checkout.session.async_payment_succeeded",
    "checkout.session.completed",
    "customer.subscription.deleted",
    "customer.subscription.updated",
    "invoice.paid",
    "invoice.payment_failed",
  ]);
  // Plus the refund family, which is matched by helper rather than by ==.
  const refunds = read("lib/stripeRefunds.ts");
  assert.match(refunds, /export const REFUND_EVENT_TYPES = \[/);
  for (const type of [
    "charge.refunded", "charge.refund.updated", "refund.created", "refund.updated", "refund.failed",
  ]) {
    assert.ok(refunds.includes(`"${type}"`), `the refund family lost ${type}`);
  }
  assert.ok(route.includes("isRefundEventType(event.type)"));
});

test("13: event-id dedupe still runs first, and business idempotency is the real guard", () => {
  // The event-id dedupe short-circuits an identical redelivery...
  assert.ok(route.indexOf("hasStripeWebhookEventBeenProcessed(event.id)") < route.indexOf(COMPLETED));
  assert.ok(route.includes("recordStripeWebhookEvent(event.id, event.type, checkoutSessionId)"));
  // ...but completed and async_payment_succeeded are DIFFERENT event ids
  // describing the same payment, so the dedupe cannot be what makes them
  // safe. That is the attempt lock plus the unique index in test 9, and
  // the two email claims in test 11.
  const recorded = route.slice(route.indexOf("const recorded = await recordStripeWebhookEvent"));
  assert.ok(recorded.length > 0);
  assert.ok(route.indexOf("recordStripeWebhookEvent(event.id") > route.indexOf("await handleCheckoutSessionCompleted"),
    "the event is recorded before its work is done");
});
