import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ACTION_PAYMENT_STATUSES,
  ADMIN_ORDER_ACTIONS,
  CANCELLABLE_FULFILLMENT_STATUSES,
  EMAIL_STATUS_LABEL,
  ORDER_EMAIL_STATE_COLUMNS,
  REFUNDABLE_PAYMENT_STATUSES,
  RESOLUTION_DECISIONS,
  RESOLUTION_OUTCOMES,
  SHIPPABLE_PAYMENT_STATUSES,
  canCancel,
  canRefund,
  canResolveRequest,
  canShip,
  cancellationRefundState,
  emailStatusLabel,
  hasOpenCancellationRequest,
  maxRefundableCents,
  parseEuroToCents,
  refundIdempotencyKey,
  resolveRefundAmount,
} from "../lib/adminOrderActionRules.ts";
import { validateShipmentRequest } from "../lib/shipmentTransitionRules.ts";

/**
 * THE ADMIN ORDER ACTIONS: WHAT MAY MOVE, AND WHO MAY MOVE IT.
 *
 * Paket 4A.1B is the point at which the operations screen stops being a
 * window and becomes a control. Four things follow from that, and this
 * file is about all four:
 *
 *   ONE AUTHORITY      every transition is decided by the database
 *                      function that also writes it, under a row lock.
 *                      The admin path calls the SAME function the
 *                      authorized internal route calls. Two callers,
 *                      one rule.
 *   ONE EMAIL          each confirmation is sent by the existing state
 *                      machine, which claims the right to send
 *                      atomically. No second sender, no second template,
 *                      and no way for two clicks to become two messages.
 *   MONEY IS DIFFERENT the refund is the one thing here that cannot be
 *                      undone by a later correction, so its maximum is
 *                      computed on the server, its amount is integer
 *                      cents, and its Stripe key is deterministic.
 *   NOTHING IS ASSUMED the screen never shows an order as shipped,
 *                      refunded or cancelled until the server said so.
 *
 * And one thing that must NOT change: the purchase confirmation still
 * belongs to the checkout webhook alone. No action here can send it.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf8");
/** Source with comments removed, so prose cannot satisfy an assertion. */
const codeOnly = src => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

const rules = read("lib/adminOrderActionRules.ts");
const actions = read("lib/adminOrderActions.ts");
// PAKET 4A.1B (FINAL SAFETY) split the refund SEQUENCE into its own
// module so it could be run against fakes - a claim about two
// overlapping calls cannot be proved by reading source. The two are
// checked together wherever the property spans both: adminOrderActions
// supplies the real dependencies, adminRefundFlow decides the order.
const flow = read("lib/adminRefundFlow.ts");
const flowCode = codeOnly(flow);
const gate = read("lib/adminActionRoute.ts");
const actionsCode = codeOnly(actions);
const ui = read("app/AdminOrderActions.tsx");
const uiCode = codeOnly(ui);
const list = read("app/AdminOrders.tsx");
const css = read("app/globals.css");

const ACTION_ROUTES = {
  ship: "app/api/admin/orders/ship/route.ts",
  cancel: "app/api/admin/orders/cancel/route.ts",
  refund: "app/api/admin/orders/refund/route.ts",
  "resolve-request": "app/api/admin/orders/resolve-request/route.ts",
};
const routeSources = Object.fromEntries(
  Object.entries(ACTION_ROUTES).map(([name, rel]) => [name, read(rel)])
);

/* ══════════════════════════════════════════════════════════════
   1. THE PURCHASE CONFIRMATION IS NOT TOUCHED

   The one flow this package must leave exactly alone: paid ->
   webhook -> order -> confirmation. An admin action that could
   re-send it would mail a customer a second "thank you for your
   order" for an order they placed weeks ago.
   ══════════════════════════════════════════════════════════════ */

test("1: no admin action can send an order confirmation", () => {
  for (const [name, src] of [["actions", actionsCode], ["ui", uiCode], ...Object.entries(routeSources)]) {
    for (const banned of [
      "orderConfirmation", "sendOrderConfirmation", "OrderConfirmationEmail",
      "create_order_from_paid_checkout", "checkout.session.completed",
    ]) {
      assert.ok(!codeOnly(src).includes(banned), `${name} reaches the purchase confirmation: ${banned}`);
    }
  }
  // And the webhook still owns it, unchanged.
  const webhook = codeOnly(read("app/api/stripe/webhook/route.ts"));
  assert.ok(webhook.includes("create_order_from_paid_checkout") || webhook.includes("createOrderFromPaidCheckout"),
    "the webhook no longer creates the order");
});

test("1b: the three senders this package uses are the existing ones", () => {
  // Imported, never re-implemented. If any of these becomes a local
  // function the exactly-once claim stops being shared.
  for (const sender of [
    'import { sendShipmentConfirmationIfNeeded } from "./shipmentConfirmationEmail"',
    'import { sendCancellationOutcomeEmailIfNeeded } from "./cancellationOutcomeEmail"',
    'import { sendRefundConfirmationIfNeeded } from "./refundConfirmationEmail"',
  ]) {
    assert.ok(actions.includes(sender), `a sender is not imported from its existing module: ${sender}`);
  }
  for (const banned of ["resend.emails.send", "getResendClient", "RESEND_API_KEY", "buildShipmentConfirmation"]) {
    assert.ok(!actionsCode.includes(banned), `the action module sends mail itself: ${banned}`);
  }
});

/* ══════════════════════════════════════════════════════════════
   2. AUTHORIZATION
   ══════════════════════════════════════════════════════════════ */

test("2: every action route checks the admin session before anything else", () => {
  for (const [name, src] of Object.entries(routeSources)) {
    const code = codeOnly(src);
    const gateAt = code.indexOf("const gate = await openAdminAction(request)");
    assert.notEqual(gateAt, -1, `${name} does not open through the shared gate`);
    // Nothing runs before it - not a read, not a parse, not a log. The
    // slice stops at the START of the gate statement, so the gate's own
    // `await` is not what this finds.
    const body = code.slice(code.indexOf("export async function POST"), gateAt);
    assert.ok(!/await|\.from\(|\.rpc\(|console\./.test(body),
      `${name} does work before the session check`);
  }
  // And the gate itself checks the session before it touches the body.
  const gateCode = codeOnly(gate);
  assert.ok(gateCode.indexOf("verifyAdminRequest(request)") < gateCode.indexOf("request.text()"),
    "the gate parses a body for a caller with no session");
  assert.ok(gateCode.includes('{ error: "Nicht autorisiert." }, 401'),
    "the gate does not answer 401");
});

test("2b: POST only - no other verb is a surface", () => {
  for (const [name, src] of Object.entries(routeSources)) {
    const handlers = [...src.matchAll(/export async function (\w+)/g)].map(m => m[1]);
    assert.deepEqual(handlers, ["POST"], `${name} exports something other than POST`);
  }
});

test("2c: no internal bearer secret and no Stripe key is anywhere near the browser", () => {
  for (const [name, src] of [["ui", uiCode], ["list", codeOnly(list)], ...Object.entries(routeSources).map(([n, s]) => [n, codeOnly(s)])]) {
    for (const banned of [
      "FULFILLMENT_ADMIN_SECRET", "CANCELLATION_ADMIN_SECRET", "CRON_SECRET",
      "STRIPE_SECRET_KEY", "SUPABASE_SECRET_KEY", "service_role",
      "isBearerSecretAuthorized", "/api/internal/",
    ]) {
      assert.ok(!src.includes(banned), `${name} names ${banned}`);
    }
  }
  // The client component talks to admin endpoints and nothing else.
  const endpoints = [...new Set([...ui.matchAll(/"(\/api\/[^"]+)"/g)].map(m => m[1]))].sort();
  assert.deepEqual(endpoints, [
    "/api/admin/orders/cancel",
    "/api/admin/orders/refund",
    "/api/admin/orders/resolve-request",
    "/api/admin/orders/ship",
  ]);
});

test("2d: no internal HTTP loop - the admin path calls the functions directly", () => {
  // Calling /api/internal/* from the server would mean holding one of
  // those bearer secrets in this process's request path for no gain.
  assert.ok(!actionsCode.includes("fetch("), "the action module makes an HTTP call");
  for (const rpc of ["mark_order_shipped", "cancel_order", "resolve_order_cancellation_request"]) {
    assert.ok(actionsCode.includes(`.rpc("${rpc}"`), `the action module does not call ${rpc} directly`);
  }
});

/* ══════════════════════════════════════════════════════════════
   3. ONE AUTHORITY PER TRANSITION
   ══════════════════════════════════════════════════════════════ */

test("3: every transition goes through its database function, never a table write", () => {
  // service_role's UPDATE grant on public.orders covers only the email
  // state columns, so a direct write could not work - but asserting it
  // keeps the intent visible rather than relying on a grant nobody sees.
  for (const write of ['.from("orders").update(', ".insert(", ".upsert(", ".delete("]) {
    assert.ok(!actionsCode.includes(write), `the action module writes a table directly: ${write}`);
  }
  const rpcs = [...new Set([...actionsCode.matchAll(/\.rpc\("(\w+)"/g)].map(m => m[1]))].sort();
  assert.deepEqual(rpcs, [
    // The refund lock (migration 049). Not a transition: these decide
    // WHO may proceed, never what happens to the order.
    "cancel_order",
    "claim_order_refund",
    "mark_order_shipped",
    "release_order_refund",
    "resolve_order_cancellation_request",
  ]);
  // The refund's write is apply_order_refund_state, reached through the
  // existing sync rather than called here - which is what makes it an
  // absolute re-read instead of a delta this module invents.
  assert.ok(actionsCode.includes("syncOrderRefundStateFromStripe("));
  assert.ok(!actionsCode.includes("apply_order_refund_state"),
    "the action module writes refund state itself instead of using the existing sync");
});

test("3b: the shared validators are reused, not re-implemented", () => {
  for (const validator of ["validateShipmentRequest", "validateCancellationRequest", "validateResolutionRequest"]) {
    assert.ok(actions.includes(`import {`) && actions.includes(validator),
      `${validator} is not reused`);
  }
  // No second definition of any of them.
  for (const validator of ["validateShipmentRequest", "validateCancellationRequest", "validateResolutionRequest"]) {
    assert.ok(!new RegExp(`function ${validator}\\b`).test(actions),
      `${validator} was re-implemented in the action module`);
  }
});

test("3c: a refused transition mails nothing", () => {
  for (const [fn, durable] of [["adminShipOrder", "shipmentIsDurable"], ["adminResolveCancellationRequest", "resolutionIsDurable"]]) {
    const at = actionsCode.indexOf(`export async function ${fn}`);
    const body = actionsCode.slice(at, actionsCode.indexOf("\n}", at));
    const guardAt = body.indexOf(durable);
    const sendAt = body.search(/send\w+IfNeeded\(/);
    assert.ok(guardAt > -1 && sendAt > -1, `${fn} lost its durability guard or its send`);
    assert.ok(guardAt < sendAt, `${fn} can mail a refused transition`);
  }
});

test("3d: an email failure never reverses a transition", () => {
  // There is no rollback path and there must not be one: the RPCs have
  // no reverse operation, and inventing one in application code would be
  // a second writer of the same columns.
  for (const banned of ["rollback", "unship", "uncancel", "revert"]) {
    assert.ok(!actionsCode.toLowerCase().includes(banned), `the action module tries to undo a transition: ${banned}`);
  }
  // The outcome is DATA on a successful response, not an error.
  assert.match(actionsCode, /emailOutcome,?\s*\n?\s*\}/);
  assert.ok(actionsCode.includes("emailOutcome: \"failed\""),
    "a shipment whose order id is missing does not report the mail as failed");
});

/* ══════════════════════════════════════════════════════════════
   4. SHIPMENT
   ══════════════════════════════════════════════════════════════ */

test("4: the shipment guards mirror migration 028 and 032", () => {
  const paid = { status: "confirmed", payment_status: "paid", fulfillment_status: "unfulfilled" };
  assert.equal(canShip(paid).allowed, true);
  assert.equal(canShip({ ...paid, payment_status: "partially_refunded" }).allowed, true);

  for (const [patch, why] of [
    [{ fulfillment_status: "delivered" }, "delivered"],
    [{ status: "delivered" }, "delivered order"],
    [{ fulfillment_status: "shipped" }, "already shipped"],
    [{ status: "cancelled" }, "cancelled"],
    [{ status: "refunded" }, "fully refunded"],
    [{ fulfillment_status: "cancelled" }, "cancelled fulfillment"],
    [{ payment_status: "pending" }, "never paid"],
    [{ payment_status: "failed" }, "failed payment"],
    [{ payment_status: "refunded" }, "refunded"],
    [{ payment_status: "refund_pending" }, "refund in flight"],
    [{ cancellation_requested_at: "2026-09-01T10:00:00Z" }, "open cancellation request"],
  ]) {
    const verdict = canShip({ ...paid, ...patch });
    assert.equal(verdict.allowed, false, `an order that is ${why} was offered as shippable`);
    assert.ok(verdict.reason.length > 10, `the refusal for ${why} says nothing useful`);
  }
  // A DECLINED request does not block - the predicate tests the
  // resolution for null, not for a particular value.
  assert.equal(canShip({
    ...paid,
    cancellation_requested_at: "2026-09-01T10:00:00Z",
    cancellation_request_resolution: "declined",
  }).allowed, true);
  assert.deepEqual([...SHIPPABLE_PAYMENT_STATUSES], ["paid", "partially_refunded"]);
});

test("4b: the carrier and tracking fields are validated, and control characters are refused", () => {
  const base = { orderNumber: "GLOA-2026-000123" };
  assert.equal(validateShipmentRequest({ ...base, carrier: "DHL" }).ok, true);
  assert.equal(validateShipmentRequest({ ...base, carrier: "Österreichische Post" }).ok, true);
  assert.equal(validateShipmentRequest({ ...base, trackingUrl: "https://example.com/t/1" }).ok, true);

  for (const [patch, why] of [
    [{ carrier: "DHL X" }, "a NUL in the carrier"],
    [{ carrier: "DHL\nX" }, "a newline in the carrier"],
    [{ carrier: "DHL[31m" }, "an ANSI escape in the carrier"],
    [{ trackingNumber: "003404" }, "a DEL in the tracking number"],
    [{ trackingUrl: "javascript:alert(1)" }, "a javascript: URL"],
    [{ trackingUrl: "data:text/html,x" }, "a data: URL"],
    [{ trackingUrl: "not a url" }, "a non-absolute URL"],
    [{ carrier: "x".repeat(101) }, "an over-long carrier"],
    [{ trackingNumber: "x".repeat(101) }, "an over-long tracking number"],
    [{ trackingUrl: `https://e.com/${"x".repeat(500)}` }, "an over-long tracking URL"],
    [{ shipped_at: "2026-01-01" }, "an unknown field"],
    [{ fulfillment_status: "shipped" }, "a lifecycle field"],
  ]) {
    assert.equal(validateShipmentRequest({ ...base, ...patch }).ok, false, `${why} was accepted`);
  }
  // Trimming still happens, and an empty string still means "absent".
  const ok = validateShipmentRequest({ ...base, carrier: "  DHL  ", trackingNumber: "   " });
  assert.equal(ok.ok, true);
  assert.equal(ok.request.carrier, "DHL");
  assert.equal(ok.request.trackingNumber, null);
});

test("4c: no tracking URL is ever invented from a tracking number", () => {
  // A guessed carrier URL is a link that 404s in a customer's inbox.
  for (const banned of ["nolp.dhl.de", "dhl.de/", "https://" + "www.dhl", "trackingUrl =", "buildTrackingUrl"]) {
    assert.ok(!uiCode.includes(banned), `the screen builds a tracking URL: ${banned}`);
    assert.ok(!actionsCode.includes(banned), `the action module builds a tracking URL: ${banned}`);
  }
  assert.match(ui, /nicht automatisch erzeugt/,
    "the screen does not tell the operator the link is not generated");
});

/* ══════════════════════════════════════════════════════════════
   5. REFUND - THE ONE THAT MOVES MONEY
   ══════════════════════════════════════════════════════════════ */

const PAID = {
  payment_status: "paid",
  total_gross_cents: 3998,
  refunded_total_cents: 0,
  stripe_payment_intent_id: "pi_test_123",
  currency: "EUR",
};

test("5: the refundable maximum is the order's, computed from the order", () => {
  assert.equal(maxRefundableCents(PAID), 3998);
  assert.equal(maxRefundableCents({ ...PAID, refunded_total_cents: 1000 }), 2998);
  assert.equal(maxRefundableCents({ ...PAID, refunded_total_cents: 3998 }), 0);
  // Never negative, whatever the columns say.
  assert.equal(maxRefundableCents({ ...PAID, refunded_total_cents: 99999 }), 0);
  assert.equal(maxRefundableCents({ ...PAID, total_gross_cents: null }), 0);
  assert.equal(maxRefundableCents({ ...PAID, total_gross_cents: 0 }), 0);
  assert.equal(maxRefundableCents({}), 0);
});

test("5b: a refund is offered only when it can actually be made", () => {
  assert.equal(canRefund(PAID).allowed, true);
  assert.equal(canRefund({ ...PAID, payment_status: "partially_refunded", refunded_total_cents: 1000 }).allowed, true);
  for (const [patch, why] of [
    [{ payment_status: "pending" }, "never paid"],
    [{ payment_status: "failed" }, "failed payment"],
    [{ payment_status: "refunded" }, "already refunded"],
    [{ payment_status: "refund_pending" }, "refund already in flight"],
    [{ stripe_payment_intent_id: null }, "no payment intent"],
    [{ stripe_payment_intent_id: "   " }, "a blank payment intent"],
    [{ refunded_total_cents: 3998 }, "nothing left to refund"],
  ]) {
    const verdict = canRefund({ ...PAID, ...patch });
    assert.equal(verdict.allowed, false, `a refund was offered for an order with ${why}`);
    assert.ok(verdict.reason.length > 10, `the refusal for ${why} says nothing useful`);
  }
  // 412 of the 458 production orders carry no payment intent, so this
  // refusal is the common case and has to say what to do instead.
  assert.match(canRefund({ ...PAID, stripe_payment_intent_id: null }).reason, /Stripe/);
  assert.deepEqual([...REFUNDABLE_PAYMENT_STATUSES], ["paid", "partially_refunded"]);
});

test("5c: the amount is integer cents and can never exceed the server's maximum", () => {
  assert.deepEqual(resolveRefundAmount(undefined, 3998), { ok: true, amountCents: 3998, full: true });
  assert.deepEqual(resolveRefundAmount(null, 3998), { ok: true, amountCents: 3998, full: true });
  assert.deepEqual(resolveRefundAmount(1000, 3998), { ok: true, amountCents: 1000, full: false });
  assert.deepEqual(resolveRefundAmount(3998, 3998), { ok: true, amountCents: 3998, full: true });

  for (const [value, code, why] of [
    [3999, "too_large", "more than the maximum"],
    [0, "too_small", "zero"],
    [-100, "too_small", "negative"],
    [10.5, "not_an_integer", "a fractional cent"],
    ["1000", "invalid_amount", "a string"],
    [Number.NaN, "invalid_amount", "NaN"],
    [Number.POSITIVE_INFINITY, "invalid_amount", "Infinity"],
    [{}, "invalid_amount", "an object"],
  ]) {
    const out = resolveRefundAmount(value, 3998);
    assert.equal(out.ok, false, `${why} was accepted as a refund amount`);
    assert.equal(out.code, code, `${why} produced the wrong code`);
  }
  // Nothing is refundable: even an omitted amount is refused.
  assert.equal(resolveRefundAmount(undefined, 0).ok, false);
  assert.equal(resolveRefundAmount(1, 0).ok, false);
});

test("5d: money never goes through a float", () => {
  assert.equal(parseEuroToCents("39,98"), 3998);
  assert.equal(parseEuroToCents("39.98"), 3998);
  assert.equal(parseEuroToCents("19,99"), 1999);   // 19.99*100 is 1998.9999999999998
  assert.equal(parseEuroToCents("0,01"), 1);
  assert.equal(parseEuroToCents(" 45,88 € "), 4588);
  assert.equal(parseEuroToCents("1.234,56"), 123456);
  assert.equal(parseEuroToCents("7"), 700);
  assert.equal(parseEuroToCents("7,5"), 750);
  for (const bad of ["", "   ", "abc", "-5", "1,234", "1,2,3", "1e3", "€", "12,,3"]) {
    assert.equal(parseEuroToCents(bad), null, `${JSON.stringify(bad)} parsed as money`);
  }
  // AND NO DECIMAL EVER GETS MULTIPLIED BY 100.
  //
  // The distinction matters: Number("39") * 100 is exact, because the
  // string has no fraction by the time it is multiplied - that is the
  // whole point of splitting on the separator first. What must not
  // appear is a parse of the WHOLE decimal followed by a multiply, which
  // is the operation that turns 19.99 into 1998.9999999999998.
  for (const [name, src] of [["rules", codeOnly(rules)], ["ui", uiCode], ["actions", actionsCode]]) {
    assert.ok(!src.includes("parseFloat"), `${name} parses money as a float`);
    assert.ok(!/Number\(normalized\)|Number\(text\)|Number\(raw\)/.test(src),
      `${name} converts a whole decimal amount to a number`);
    assert.ok(!/\d+\.\d+\s*\*\s*100/.test(src), `${name} multiplies a decimal literal by 100`);
  }
  // The conversion really is done on the two halves separately.
  assert.ok(rules.includes('normalized.split(".")'), "the euro parser stopped splitting on the separator");
});

test("5e: the client cannot name the Stripe object or raise its own ceiling", () => {
  const refundRoute = codeOnly(routeSources.refund);
  // The route reads exactly two things off the body.
  const bodyReads = [...refundRoute.matchAll(/body\.(\w+)/g)].map(m => m[1]).sort();
  assert.deepEqual([...new Set(bodyReads)], ["amountCents", "id"]);
  for (const banned of ["payment_intent", "paymentIntent", "maxCents", "currency", "refunded_total"]) {
    assert.ok(!refundRoute.includes(banned), `the refund route trusts the client for ${banned}`);
  }
  // The server loads the order and takes the intent from it.
  assert.ok(actionsCode.includes('.from("orders")'), "the refund never loads the order");
  assert.ok(flowCode.includes("order.stripe_payment_intent_id"),
    "the payment intent does not come from the loaded order");
  const loadAt = flowCode.indexOf("deps.loadOrder(");
  const guardAt = flowCode.indexOf("canRefund(order)");
  const amountAt = flowCode.indexOf("resolveRefundAmount(");
  const createAt = flowCode.indexOf("deps.createRefund(");
  assert.ok(loadAt < guardAt && guardAt < amountAt && amountAt < createAt,
    "the refund reaches Stripe before it has loaded, checked and bounded itself");
  // And exactly one place actually calls Stripe.
  const bothHalves = actionsCode + "\n" + flowCode;
  assert.equal([...bothHalves.matchAll(/refunds\.create\(/g)].length, 1,
    "more than one place creates a Stripe refund");
});

test("5f: a retry cannot become a second refund", () => {
  // Stable for the same intended operation...
  assert.equal(
    refundIdempotencyKey("abc", 0, 3998),
    refundIdempotencyKey("abc", 0, 3998)
  );
  // ...and different once a refund has actually landed, so a deliberate
  // second refund later is a new operation rather than a silent no-op.
  assert.notEqual(refundIdempotencyKey("abc", 0, 1000), refundIdempotencyKey("abc", 1000, 1000));
  assert.notEqual(refundIdempotencyKey("abc", 0, 1000), refundIdempotencyKey("abc", 0, 2000));
  assert.notEqual(refundIdempotencyKey("abc", 0, 1000), refundIdempotencyKey("xyz", 0, 1000));
  // It is actually passed to Stripe.
  assert.match(flowCode, /idempotencyKey: refundIdempotencyKey\(/);
  assert.match(actionsCode, /\{ idempotencyKey \}/, "the real Stripe call drops the key");
  // And the order's absolute total is what gets written, so even a
  // duplicate that slipped through cannot inflate the row.
  assert.ok(actionsCode.includes("syncOrderRefundStateFromStripe(stripe, paymentIntentId)"));
});

test("5g: the refund email is gated exactly as the webhook gates it", () => {
  const syncAt = flowCode.indexOf("deps.syncRefundState(");
  const gateAt = flowCode.indexOf("deps.isNewSettledFact(");
  const sendAt = flowCode.indexOf("deps.sendConfirmation(");
  assert.ok(syncAt > -1 && gateAt > -1 && sendAt > -1, "the refund lost a step");
  assert.ok(syncAt < gateAt && gateAt < sendAt,
    "the refund mails before the state is durable, or without the new-fact guard");
  // The gate really is the webhook's, not a local re-implementation.
  assert.ok(actionsCode.includes("isNewSettledFact: isNewSettledRefundFact"));
  // A sync that threw says so instead of claiming an email was weighed.
  assert.ok(flowCode.includes('syncResult: "sync_failed"'),
    "a refund whose sync failed claims an email was considered");
});

test("5h: a refund that succeeded is never reported as a failure", () => {
  // A sync that throws AFTER the money moved must report ok:true with
  // syncResult "sync_failed". Anything else reads as "try again", and
  // trying again after a settled refund is how a customer gets paid
  // twice.
  const catchAt = flowCode.indexOf("catch (cause)", flowCode.indexOf("deps.syncRefundState("));
  assert.notEqual(catchAt, -1, "the sync is no longer guarded");
  const handler = flowCode.slice(catchAt, flowCode.indexOf("};", catchAt));
  assert.ok(handler.includes("ok: true"), "a failed sync is reported as a failed refund");
  assert.ok(handler.includes('syncResult: "sync_failed"'));
  assert.ok(handler.includes('emailOutcome: "not-attempted"'));
  assert.ok(!handler.includes("ok: false"));
  assert.match(flow, /The money HAS moved/);
});

/* ══════════════════════════════════════════════════════════════
   6. CANCELLATION, WHICH IS NOT A REFUND
   ══════════════════════════════════════════════════════════════ */

test("6: the cancellation guards mirror migration 029", () => {
  const open = { status: "confirmed", payment_status: "paid", fulfillment_status: "unfulfilled" };
  assert.equal(canCancel(open).allowed, true);
  assert.equal(canCancel({ ...open, fulfillment_status: "processing" }).allowed, true);
  for (const [patch, why] of [
    [{ status: "cancelled" }, "already cancelled"],
    [{ fulfillment_status: "cancelled" }, "already cancelled fulfillment"],
    [{ status: "shipped" }, "shipped"],
    [{ fulfillment_status: "shipped" }, "shipped fulfillment"],
    [{ status: "delivered" }, "delivered"],
    [{ fulfillment_status: "delivered" }, "delivered fulfillment"],
  ]) {
    assert.equal(canCancel({ ...open, ...patch }).allowed, false, `a ${why} order was offered as cancellable`);
  }
  assert.deepEqual([...CANCELLABLE_FULFILLMENT_STATUSES], ["unfulfilled", "processing"]);
});

test("6b: cancelling creates no refund, anywhere in the path", () => {
  const cancelRoute = codeOnly(routeSources.cancel);
  for (const banned of ["stripe", "Stripe", "refund", "Refund"]) {
    assert.ok(!cancelRoute.includes(banned), `the cancel route knows about ${banned}`);
  }
  const at = actionsCode.indexOf("export async function adminCancelOrder");
  const body = actionsCode.slice(at, actionsCode.indexOf("\n}", at));
  for (const banned of ["stripe", "refund"]) {
    assert.ok(!body.toLowerCase().includes(banned), `the cancel action touches ${banned}`);
  }
});

test("6c: a cancelled, unrefunded order says so - it never implies the money went back", () => {
  const cancelledUnpaid = {
    status: "cancelled", cancelled_at: "2026-09-01T10:00:00Z",
    payment_status: "paid", total_gross_cents: 3998, refunded_total_cents: 0,
  };
  const state = cancellationRefundState(cancelledUnpaid);
  assert.equal(state.cancelled, true);
  assert.equal(state.refundedCents, 0);
  assert.equal(state.outstandingCents, 3998);
  assert.match(state.label, /noch nicht erfolgt/);

  const partly = cancellationRefundState({ ...cancelledUnpaid, refunded_total_cents: 1000 });
  assert.match(partly.label, /teilweise/);
  assert.equal(partly.outstandingCents, 2998);

  const fully = cancellationRefundState({ ...cancelledUnpaid, refunded_total_cents: 3998 });
  assert.match(fully.label, /vollständig/);
  assert.equal(fully.outstandingCents, 0);

  // An order that is not cancelled makes no claim either way.
  assert.equal(cancellationRefundState({ status: "confirmed" }).label, "—");

  // And the screen says it in words before the operator confirms.
  assert.match(ui, /KEINE Erstattung ausgelöst/);
  assert.ok(uiCode.includes("cancellationRefundState"), "the screen does not render the two facts separately");
});

test("6d: a cancellation request is answered with one of exactly two words", () => {
  // TWO VOCABULARIES, AND THE SCREEN MUST USE THE REQUEST ONE.
  //
  // The validator matches "approve"/"decline" case-sensitively; the RPC
  // result and the stored column read "approved"/"declined". Sending the
  // past tense is a clean 400 - which is how the first version of this
  // screen was caught, before any of it reached production.
  //
  // The allow-list is read out of the validator's SOURCE rather than
  // trusted from the copy in the rules leaf, so the two cannot drift.
  const validatorSource = read("lib/cancellationResolutionRules.ts");
  const at = validatorSource.indexOf("export const DECISIONS = [");
  assert.notEqual(at, -1, "the validator no longer declares its decisions");
  const allowed = [...validatorSource.slice(at, validatorSource.indexOf("]", at))
    .matchAll(/"(\w+)"/g)].map(m => m[1]);
  assert.deepEqual([...RESOLUTION_DECISIONS].sort(), allowed.sort(),
    "the rules leaf and the validator disagree about the decision words");

  const decisions = [...new Set([...ui.matchAll(/decision: "(\w+)"/g)].map(m => m[1]))].sort();
  assert.ok(decisions.length > 0, "the screen offers no decision at all");
  assert.deepEqual(decisions, allowed.sort(),
    "the screen sends a decision word the validator would refuse");
  // The OUTCOME it reads back is the other vocabulary, and that is right.
  assert.deepEqual([...RESOLUTION_OUTCOMES], ["approved", "declined"]);
  assert.ok(ui.includes('data.resolution === "approved"'),
    "the screen reads the result with the request vocabulary");
  // The two vocabularies really are different, which is the whole point.
  assert.notDeepEqual([...RESOLUTION_DECISIONS], [...RESOLUTION_OUTCOMES]);
  // And the stored column carries the outcome words - migration 031.
  const m031 = read("supabase/migrations/031_cancellation_request_resolution.sql");
  for (const word of RESOLUTION_OUTCOMES) {
    assert.ok(m031.includes(`'${word}'`), `migration 031 never stores ${word}`);
  }
  // The reported resolution comes from the RESULT, not from the request.
  assert.ok(actionsCode.includes("resolutionOutcome(result)"),
    "the resolution is echoed from the request instead of read from the result");

  const openReq = { cancellation_requested_at: "2026-09-01T10:00:00Z" };
  assert.equal(hasOpenCancellationRequest(openReq), true);
  assert.equal(canResolveRequest(openReq).allowed, true);
  assert.equal(canResolveRequest({}).allowed, false);
  assert.equal(canResolveRequest({ ...openReq, cancellation_request_resolution: "declined" }).allowed, false);
  assert.equal(hasOpenCancellationRequest({ ...openReq, cancellation_request_resolution: "approved" }), false);
});

/* ══════════════════════════════════════════════════════════════
   7. INVENTORY IS NOT TOUCHED, AND CANNOT BE
   ══════════════════════════════════════════════════════════════ */

test("7: no order action moves stock", () => {
  const INVENTORY = [
    "inventory", "stock", "stock_movement", "stockMovement", "lagerbestand",
    "warehouse", "bestand", "goods_receipt", "stocktake",
  ];
  for (const [name, src] of [
    ["actions", actionsCode], ["rules", codeOnly(rules)], ["ui", uiCode], ["gate", codeOnly(gate)],
    ...Object.entries(routeSources).map(([n, s]) => [n, codeOnly(s)]),
  ]) {
    for (const banned of INVENTORY) {
      assert.ok(!src.toLowerCase().includes(banned), `${name} touches inventory: ${banned}`);
    }
  }
  // And no such table exists to touch - the separation is structural,
  // not a matter of remembering.
  const tables = [...actionsCode.matchAll(/\.from\("(\w+)"\)/g)].map(m => m[1]);
  assert.deepEqual([...new Set(tables)], ["orders"]);
});

/* ══════════════════════════════════════════════════════════════
   8. THE SCREEN: TWO CLICKS, NO GUESSES
   ══════════════════════════════════════════════════════════════ */

test("8: every action needs a second, separate confirmation", () => {
  // Nothing calls run() straight from a first click: the first click
  // only ever sets the pending state.
  const firstClicks = [...uiCode.matchAll(/onClick=\{\(\) => setPending\(\{/g)];
  assert.ok(firstClicks.length >= 4, "not every action opens a confirmation first");
  assert.ok(uiCode.includes("onClick={() => void run(p)}"),
    "the confirmation does not run the action");
  // run() is reachable from exactly one place - the confirmed button.
  assert.equal([...uiCode.matchAll(/void run\(/g)].length, 1,
    "an action can be run from more than one control");
});

test("8b: the dangerous button is never the one the finger or Enter lands on", () => {
  // In every confirmation, Abbrechen comes first in the DOM.
  // Measured inside the RENDERED buttons, not the function signature -
  // finalLabel appears as a parameter name long before any markup.
  const buttonsAt = uiCode.indexOf('className="ops-confirm-buttons"');
  assert.notEqual(buttonsAt, -1, "the confirmation has no button row");
  const buttons = uiCode.slice(buttonsAt, uiCode.indexOf("</div>", buttonsAt));
  const cancelAt = buttons.indexOf("Abbrechen");
  const finalAt = buttons.indexOf("finalLabel");
  assert.ok(cancelAt > -1 && finalAt > -1, "the confirmation lost one of its two buttons");
  assert.ok(cancelAt < finalAt, "the destructive control precedes Abbrechen in the DOM");
  assert.ok(!/autoFocus/.test(uiCode), "a control is auto-focused in a confirmation");
  // And the red is spent only where money or a terminal state is at stake.
  const dangerUses = [...uiCode.matchAll(/ops-btn-danger/g)].length;
  assert.ok(dangerUses > 0 && dangerUses <= 4, `the danger style is used ${dangerUses} times`);
  assert.ok(css.includes(".ops-btn-danger{ border-color:var(--berry)"),
    "the danger style is not defined from the existing palette");
});

test("8c: a double click cannot send twice, and nothing is optimistic", () => {
  assert.ok(uiCode.includes("if (busy) return;"), "run() does not refuse a second entry");
  assert.ok(uiCode.includes("disabled={busy}"), "controls stay live during a request");
  // No local state ever claims a transition happened.
  for (const banned of [
    'setOrder(', 'order.fulfillment_status = ', 'order.status = ',
    'optimistic', 'assumeShipped',
  ]) {
    assert.ok(!uiCode.includes(banned), `the screen patches the order locally: ${banned}`);
  }
  // Success is what the server said, and the order is re-read afterwards.
  assert.ok(uiCode.includes("if (!res.ok) {"), "a failed response is not distinguished");
  assert.ok(uiCode.includes("await onDone()"), "the order is not re-read after an action");
  const okAt = uiCode.indexOf("if (!res.ok) {");
  const doneAt = uiCode.indexOf("await onDone()");
  assert.ok(okAt < doneAt, "the screen refreshes before it knows the action succeeded");
});

test("8d: a failure shows the server's sentence and no internals", () => {
  assert.ok(uiCode.includes('typeof data.error === "string" ? data.error'),
    "the screen does not show the server's message");
  for (const b of ["stack", "cause", "console.log"]) {
    assert.ok(!uiCode.includes(b), `the screen can expose ${b}`);
  }
  // And the server's own messages carry no infrastructure detail.
  //
  // NAMING STRIPE IS NOT A LEAK. "Die Erstattung konnte bei Stripe nicht
  // ausgelöst werden" tells the operator where to look next, which is
  // the whole job of that sentence. What must never appear is an
  // IDENTIFIER or an infrastructure name the operator cannot act on.
  for (const m of [...actions.matchAll(/error: "([^"]+)"/g)].map(m => m[1])) {
    for (const leak of ["pi_", "sk_", "pk_", "supabase", "PostgREST", "service_role", "rpc"]) {
      assert.ok(!m.toLowerCase().includes(leak.toLowerCase()), `an error message leaks ${leak}: ${m}`);
    }
    assert.ok(m.length < 160, `an error message is long enough to be a stack trace: ${m}`);
  }
});

test("8e: the operator sees the real email state, and no invented one", () => {
  const migrationText = readdirSync(path.join(ROOT, "supabase/migrations"))
    .filter(f => f.endsWith(".sql"))
    .map(f => read(`supabase/migrations/${f}`))
    .join("\n");
  for (const column of ORDER_EMAIL_STATE_COLUMNS) {
    assert.ok(migrationText.includes(column), `${column} exists in no migration`);
  }
  // Every status word the labels know is one a sender actually writes.
  const senderText = ["lib/shipmentConfirmationEmail.ts", "lib/refundConfirmationEmail.ts",
                      "lib/cancellationOutcomeEmail.ts", "lib/transactionalEmailRetry.ts"]
    .map(read).join("\n");
  for (const status of Object.keys(EMAIL_STATUS_LABEL)) {
    assert.ok(senderText.includes(`"${status}"`) || senderText.includes(`'${status}'`) || migrationText.includes(`'${status}'`),
      `no sender or migration ever writes the email status ${status}`);
  }
  // NULL is a dash, not a word - "never attempted" is not a status.
  assert.equal(emailStatusLabel(null), "—");
  assert.equal(emailStatusLabel(undefined), "—");
  assert.equal(emailStatusLabel(""), "—");
  assert.equal(emailStatusLabel("sent"), "Gesendet");
  // An unknown word is shown as itself rather than hidden.
  assert.equal(emailStatusLabel("something_new"), "something_new");
});

test("8f: the action panels work on a phone", () => {
  const mobile = css.slice(css.lastIndexOf("@media (max-width:760px){", css.indexOf("THE MOBILE DOCK")));
  assert.ok(mobile.includes(".ops-action-buttons"), "the action buttons are not adapted for mobile");
  assert.match(mobile, /flex-direction:column/);
  assert.match(mobile, /width:100%/);
  assert.ok(mobile.includes("min-width:0"),
    "a long button label can set the track width and push the card sideways");
  assert.ok(css.includes(".ops-action-fields label{ display:flex"), "the fields have no layout");
  assert.ok(css.includes("min-width:0"), "an input can overflow its container");
});

test("8g: the refund confirmation says it is real money and cannot be undone", () => {
  // Anchored on the amount label, not on `kind: "refund"` - that string
  // appears first in the Pending type declaration, far from any markup.
  const at = uiCode.indexOf("amountLabel: label,");
  assert.notEqual(at, -1, "the refund confirmation no longer carries an amount label");
  const summary = uiCode.slice(at, uiCode.indexOf("});", at));
  assert.match(summary, /echte Rückzahlung/, "the refund confirmation does not say the money is real");
  assert.match(summary, /nicht rückgängig/, "the refund confirmation does not say it is irreversible");
  assert.match(summary, /zurückgezahlt/, "the refund confirmation does not name an amount");
  // The final button carries the amount too, so the label alone is enough.
  assert.ok(uiCode.includes("${pending.amountLabel} endgültig erstatten"),
    "the final refund button does not name the amount");
  // A full refund sends NO amount: the server computes the maximum.
  assert.ok(uiCode.includes('{ id: order.id }'),
    "a full refund sends a client-computed amount instead of letting the server decide");
});

test("8h: the positions table becomes cards on a phone", () => {
  // Five columns do not fit in 390px minus the drawer's padding. The
  // table was 17px wider than the drawer holding it, so the operator had
  // to swipe sideways inside the panel to reach the line total.
  const mobile = css.slice(css.lastIndexOf("@media (max-width:760px){", css.indexOf("THE MOBILE DOCK")));
  assert.ok(mobile.includes(".ops-items thead"), "the positions header is not hidden on mobile");
  assert.match(mobile, /\.ops-items tbody td::before\{\s*content:attr\(data-label\)/,
    "the positions cells carry no label on mobile");
  // The cells that need the label actually have one in the markup.
  const itemsTable = list.slice(list.indexOf('className="ops-table ops-items"'));
  for (const label of ["Produkt", "SKU", "Menge", "Stückpreis", "Summe"]) {
    assert.ok(itemsTable.includes(`data-label="${label}"`), `no data-label for the ${label} cell`);
  }
});

/* ══════════════════════════════════════════════════════════════
   9. THE LEAF STAYS A LEAF
   ══════════════════════════════════════════════════════════════ */

test("9: the rules module imports nothing and reaches for nothing", () => {
  assert.equal((rules.match(/^import /gm) ?? []).length, 0,
    "lib/adminOrderActionRules.ts gained an import and can no longer be tested directly");
  // It names stripe_payment_intent_id, because deciding whether a refund
  // is possible means knowing whether that column is filled. What it must
  // not have is a CLIENT, a key, a network call or a clock.
  for (const banned of [
    "supabase", "getStripeClient", "new Stripe", "stripe.", "Stripe(",
    "process.env", "fetch(", "Date.now()", "new Date(",
  ]) {
    assert.ok(!codeOnly(rules).includes(banned), `the rules leaf reaches for ${banned}`);
  }
  assert.deepEqual([...ADMIN_ORDER_ACTIONS], ["ship", "cancel", "refund", "resolve-request"]);
  // One route per action, and no route without an action.
  assert.deepEqual(Object.keys(ACTION_ROUTES).sort(), [...ADMIN_ORDER_ACTIONS].sort());
});

test("9b: the payment vocabulary is migration 019's, including refund_pending", () => {
  const m019 = read("supabase/migrations/019_order_lifecycle_tracking.sql");
  const at = m019.indexOf("add constraint orders_payment_status_check");
  assert.notEqual(at, -1);
  const values = [...m019.slice(at, m019.indexOf("));", at)).matchAll(/'([a-z_]+)'/g)].map(m => m[1]);
  assert.deepEqual([...ACTION_PAYMENT_STATUSES].sort(), values.sort());
  assert.ok(values.includes("refund_pending"));
});
