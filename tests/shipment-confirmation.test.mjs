import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  IN_FLIGHT_STATUS,
  RETRY_ELIGIBLE_STATUS,
  SHIPMENT_EMAIL_STATUSES,
  SHIPPED_FULFILLMENT_STATUSES,
  isGenuinelyShipped,
  isShipmentConfirmationEligible,
  isShipmentEmailClaimable,
  isShipmentEmailSweepEligible,
  runShipmentConfirmation,
  selectShipmentTracking,
} from "../lib/shipmentConfirmationRules.ts";
import {
  buildShipmentConfirmationEmail,
  shipmentConfirmationIdempotencyKey,
} from "../lib/email/shipmentConfirmation.ts";
import { GLOA_FROM_HELLO, GLOA_REPLY_TO_SUPPORT, GLOA_INTERNAL_ORDERS } from "../lib/emailSenders.ts";

// SAFE DEFAULT SUITE: the pure state machine driven through an in-memory
// port, plus source-level checks. No Resend client is ever constructed,
// no network call is made, no database is touched, no production row is
// read or written, and no email of any kind is sent.
//
// The rule this suite protects: a customer may be told their parcel is on
// its way only after the durable order genuinely says it shipped. Payment
// is not shipment, and nothing a browser can reach may assert either.

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf-8");
const NEWLINE = String.fromCharCode(10);

const MIGRATIONS = path.join(ROOT, "supabase/migrations");
const rules = read("lib/shipmentConfirmationRules.ts");
const wiring = read("lib/shipmentConfirmationEmail.ts");
const template = read("lib/email/shipmentConfirmation.ts");
const migration027 = read("supabase/migrations/027_shipment_confirmation_email_state.sql");

const withoutComments = source => source
  .split(NEWLINE)
  .filter(line => {
    const t = line.trim();
    return !t.startsWith("--") && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
  })
  .join(NEWLINE);

const rulesCode = withoutComments(rules);
const wiringCode = withoutComments(wiring);

const ORDER_ID = "11111111-2222-3333-4444-555555555555";

/** Every `export async function name(params)` in the wiring module. */
const EXPORTED_FN = /export async function (\w+)\(([^)]*)\)/g;

const shippedRow = (overrides = {}) => ({
  id: ORDER_ID,
  order_number: "GLOA-2026-000123",
  user_id: null,
  fulfillment_status: "shipped",
  shipped_at: "2026-08-24T09:00:00.000Z",
  shipping_carrier: null,
  tracking_number: null,
  tracking_url: null,
  shipping_address_snapshot: null,
  customer_snapshot: { email: "kundin@example.com", name: "Test Kundin" },
  shipment_email_status: null,
  ...overrides,
});

/**
 * An in-memory stand-in for the order row plus the two external systems.
 *
 * `claim` models exactly what the SQL claim does: it refuses a row that
 * is not genuinely shipped, refuses one whose email status is neither
 * NULL nor 'failed', and otherwise moves the row to 'sending'. Because
 * the status lives on the shared object, a second call sees the first
 * call's write - which is what makes the concurrency test below a real
 * test of the transition and not of a mock.
 */
function makePort(row, { deliver } = {}) {
  const calls = { claims: 0, delivered: 0, sent: 0, failed: 0, logs: [] };
  const port = {
    claim: async () => {
      calls.claims += 1;
      if (!isGenuinelyShipped(row.fulfillment_status, row.shipped_at)) return "taken";
      if (!isShipmentEmailClaimable(row.shipment_email_status)) return "taken";
      row.shipment_email_status = IN_FLIGHT_STATUS;
      return "claimed";
    },
    deliver: async r => {
      calls.delivered += 1;
      if (deliver) await deliver(r);
    },
    markSent: async () => {
      calls.sent += 1;
      row.shipment_email_status = "sent";
      row.shipment_email_sent_at = "2026-08-24T09:05:00.000Z";
    },
    markFailed: async () => {
      calls.failed += 1;
      if (row.shipment_email_status === IN_FLIGHT_STATUS) row.shipment_email_status = "failed";
    },
    logFailure: (id, message) => calls.logs.push(`${id}:${message}`),
  };
  return { port, calls };
}

/* ── Eligibility: only a genuinely shipped order ───────────────── */

test("payment alone does not make a shipment confirmation eligible", async () => {
  // Everything a paid order looks like the instant Stripe settles: the
  // order exists, it is paid, and nothing has left the building.
  for (const fulfillment of ["unfulfilled", "processing"]) {
    const row = shippedRow({ fulfillment_status: fulfillment, shipped_at: null });
    const { port, calls } = makePort(row);
    assert.equal(await runShipmentConfirmation(port, row), "not-eligible");
    assert.equal(calls.claims, 0, "an unshipped order was claimed");
    assert.equal(calls.delivered, 0, "an unshipped order was mailed");
  }
});

test("order creation does not make a shipment confirmation eligible", async () => {
  // A freshly created order carries migration 004's default.
  const row = shippedRow({ fulfillment_status: "unfulfilled", shipped_at: null, shipment_email_status: null });
  const { port, calls } = makePort(row);
  assert.equal(await runShipmentConfirmation(port, row), "not-eligible");
  assert.equal(calls.delivered, 0);
});

test("a cancelled order is never shipped, whatever else it says", async () => {
  const row = shippedRow({ fulfillment_status: "cancelled", shipped_at: "2026-08-24T09:00:00.000Z" });
  const { port, calls } = makePort(row);
  assert.equal(await runShipmentConfirmation(port, row), "not-eligible");
  assert.equal(calls.delivered, 0);
});

test("a shipped status with no shipped_at is a half-written row, not a shipment", () => {
  assert.equal(isGenuinelyShipped("shipped", null), false);
  assert.equal(isGenuinelyShipped("shipped", "   "), false);
  assert.equal(isGenuinelyShipped("shipped", "2026-08-24T09:00:00.000Z"), true);
});

test("a real shipped transition makes the confirmation eligible", async () => {
  const row = shippedRow();
  const { port, calls } = makePort(row);
  assert.equal(await runShipmentConfirmation(port, row), "sent");
  assert.equal(calls.delivered, 1);
});

test("delivered counts as shipped; nothing else in the vocabulary does", () => {
  assert.deepEqual([...SHIPPED_FULFILLMENT_STATUSES], ["shipped", "delivered"]);
  const at = "2026-08-24T09:00:00.000Z";
  assert.equal(isGenuinelyShipped("delivered", at), true);
  // Migration 004's complete fulfillment_status vocabulary, minus the two above.
  for (const status of ["unfulfilled", "processing", "cancelled", "", null, undefined, "paid", "confirmed"]) {
    assert.equal(isGenuinelyShipped(status, at), false, `${status} was treated as shipped`);
  }
});

test("an already sent confirmation is not eligible again", async () => {
  const row = shippedRow({ shipment_email_status: "sent" });
  const { port, calls } = makePort(row);
  assert.equal(await runShipmentConfirmation(port, row), "already-sent");
  assert.equal(calls.claims, 0);
  assert.equal(calls.delivered, 0);
});

test("a confirmation already in flight is not eligible", async () => {
  const row = shippedRow({ shipment_email_status: IN_FLIGHT_STATUS });
  const { port, calls } = makePort(row);
  assert.equal(await runShipmentConfirmation(port, row), "already-sent");
  assert.equal(calls.delivered, 0);
});

test("a failed confirmation can be retried", async () => {
  const row = shippedRow({ shipment_email_status: RETRY_ELIGIBLE_STATUS });
  const { port, calls } = makePort(row);
  assert.equal(await runShipmentConfirmation(port, row), "sent");
  assert.equal(calls.delivered, 1);
  assert.equal(row.shipment_email_status, "sent");
});

/* ── Concurrency ──────────────────────────────────────────────── */

test("two concurrent workers cannot both claim the same confirmation", async () => {
  const row = shippedRow();
  const { port, calls } = makePort(row);

  // Both snapshots are taken while the row still looks claimable, which
  // is the situation the claim exists for. Taking them inside the
  // Promise.all argument list would let the first worker's claim land
  // before the second's snapshot was even read, and the second would
  // then be refused by the in-code pre-check rather than by the claim -
  // testing the wrong guard.
  const workerA = { ...row };
  const workerB = { ...row };
  const [first, second] = await Promise.all([
    runShipmentConfirmation(port, workerA),
    runShipmentConfirmation(port, workerB),
  ]);

  // Both started from a row that looked claimable; exactly one won it.
  const outcomes = [first, second].sort();
  assert.deepEqual(outcomes, ["already-sent", "sent"]);
  assert.equal(calls.delivered, 1, "the same confirmation was sent twice");
  assert.equal(calls.claims, 2, "both workers should have attempted the claim");
});

test("a worker that loses the claim sends nothing and reports it as normal", async () => {
  const row = shippedRow({ shipment_email_status: IN_FLIGHT_STATUS });
  const { port, calls } = makePort(row);
  assert.equal(await runShipmentConfirmation(port, row), "already-sent");
  assert.equal(calls.failed, 0, "losing a claim must not mark anything failed");
});

/* ── Outcomes ─────────────────────────────────────────────────── */

test("a successful send marks sent and stamps the timestamp", async () => {
  const row = shippedRow();
  const { port } = makePort(row);
  assert.equal(await runShipmentConfirmation(port, row), "sent");
  assert.equal(row.shipment_email_status, "sent");
  assert.ok(row.shipment_email_sent_at, "no sent timestamp was written");
});

test("a failed send marks failed and stays retryable", async () => {
  const row = shippedRow();
  const { port, calls } = makePort(row, {
    deliver: async () => { throw new Error("provider unavailable"); },
  });
  assert.equal(await runShipmentConfirmation(port, row), "failed");
  assert.equal(row.shipment_email_status, RETRY_ELIGIBLE_STATUS);
  assert.equal(calls.failed, 1);
  assert.equal(isShipmentEmailSweepEligible(row.shipment_email_status), true);
});

test("EMAIL FAILURE NEVER REVERTS THE SHIPPED ORDER", async () => {
  const row = shippedRow({
    fulfillment_status: "shipped",
    shipped_at: "2026-08-24T09:00:00.000Z",
    shipping_carrier: "DHL",
    tracking_number: "00340434161094042557",
    tracking_url: "https://example.com/track",
  });
  const { port } = makePort(row, {
    deliver: async () => { throw new Error("provider unavailable"); },
  });

  assert.equal(await runShipmentConfirmation(port, row), "failed");

  // The parcel is gone. Only the email state moved.
  assert.equal(row.fulfillment_status, "shipped");
  assert.equal(row.shipped_at, "2026-08-24T09:00:00.000Z");
  assert.equal(row.shipping_carrier, "DHL");
  assert.equal(row.tracking_number, "00340434161094042557");
  assert.equal(row.tracking_url, "https://example.com/track");
  assert.equal(row.shipment_email_status, "failed");
});

test("the state machine never throws, so it cannot roll back a shipment action", async () => {
  const row = shippedRow();
  const { port } = makePort(row, {
    deliver: async () => { throw new Error("provider unavailable"); },
  });
  // Would reject rather than resolve if the failure escaped.
  assert.equal(await runShipmentConfirmation(port, row), "failed");
});

test("a failure logs the order id and the provider message, never a customer fact", async () => {
  const row = shippedRow();
  const { port, calls } = makePort(row, {
    deliver: async () => { throw new Error("provider unavailable"); },
  });
  await runShipmentConfirmation(port, row);
  assert.equal(calls.logs.length, 1);
  assert.ok(calls.logs[0].startsWith(`${ORDER_ID}:`));
  for (const pii of ["kundin@example.com", "Test Kundin", "GLOA-2026-000123"]) {
    assert.ok(!calls.logs[0].includes(pii), `a customer fact reached the log: ${pii}`);
  }
});

/* ── The port cannot touch business state ─────────────────────── */

test("the port has no way to write shipment or money state", () => {
  const row = shippedRow();
  const { port } = makePort(row);
  assert.deepEqual(
    Object.keys(port).sort(),
    ["claim", "deliver", "logFailure", "markFailed", "markSent"]
  );
  // The rules module must not name a business-state writer at all.
  for (const forbidden of ["markShipped", "setFulfillmentStatus", "writeTracking", "refund"]) {
    assert.ok(!rulesCode.includes(forbidden), `the rules module can reach ${forbidden}`);
  }
});

test("mark-failed writes only the email column, conditionally on 'sending'", () => {
  const markFailed = wiringCode.slice(wiringCode.indexOf("async function markShipmentEmailFailed"));
  const body = markFailed.slice(0, markFailed.indexOf(NEWLINE + "}"));
  assert.ok(body.includes('shipment_email_status: "failed"'));
  assert.ok(
    body.includes('.eq("shipment_email_status", "sending")'),
    "mark-failed is not conditional on still holding the claim"
  );
  for (const column of ["fulfillment_status", "shipped_at", "tracking_", "shipping_carrier", "payment_status", "_cents"]) {
    assert.ok(!body.includes(column), `mark-failed can write ${column}`);
  }
});

test("no write anywhere in the wiring touches shipment or money columns", () => {
  // Every .update({...}) object in the module, collected.
  const updates = [...wiringCode.matchAll(/\.update\(\{([^}]*)\}\)/g)].map(m => m[1]);
  assert.ok(updates.length >= 3, "expected the claim, mark-sent and mark-failed writes");
  for (const payload of updates) {
    for (const column of [
      "fulfillment_status", "shipped_at", "shipping_carrier", "tracking_number",
      "tracking_url", "payment_status", "_cents", "confirmation_email", "internal_notification",
    ]) {
      assert.ok(!payload.includes(column), `a write reaches ${column}: ${payload}`);
    }
    assert.ok(payload.includes("shipment_email_"), `a write outside the email columns: ${payload}`);
  }
});

/* ── Tracking: only what was really stored ────────────────────── */

test("no tracking stored means no fabricated tracking", () => {
  assert.equal(selectShipmentTracking(null, null, null), null);
  assert.equal(selectShipmentTracking("", "  ", ""), null);

  const built = buildShipmentConfirmationEmail({
    order: { order_number: "GLOA-2026-000123", shippingAddress: null, tracking: null, accountOrderUrl: null },
    customerEmail: "kundin@example.com",
  });
  for (const invented of ["DHL", "UPS", "Hermes", "DPD", "GLS", "Deutsche Post", "Sendungsnummer", "Versanddienst"]) {
    assert.ok(!built.html.includes(invented), `invented tracking fact: ${invented}`);
    assert.ok(!built.text.includes(invented), `invented tracking fact: ${invented}`);
  }
});

test("tracking present uses the persisted value verbatim", () => {
  const selected = selectShipmentTracking("DHL", "00340434161094042557", "https://example.com/track");
  assert.deepEqual(selected, {
    carrier: "DHL",
    trackingNumber: "00340434161094042557",
    trackingUrl: "https://example.com/track",
  });

  const built = buildShipmentConfirmationEmail({
    order: { order_number: "GLOA-2026-000123", shippingAddress: null, tracking: selected, accountOrderUrl: null },
    customerEmail: "kundin@example.com",
  });
  assert.ok(built.html.includes("00340434161094042557"));
  assert.ok(built.text.includes("00340434161094042557"));
});

test("carrier absent means the number stands alone, never a guessed carrier", () => {
  const selected = selectShipmentTracking(null, "00340434161094042557", null);
  assert.equal(selected.carrier, null);
  assert.equal(selected.trackingUrl, null);

  const built = buildShipmentConfirmationEmail({
    order: { order_number: "GLOA-2026-000123", shippingAddress: null, tracking: selected, accountOrderUrl: null },
    customerEmail: "kundin@example.com",
  });
  assert.ok(built.text.includes("00340434161094042557"));
  for (const invented of ["DHL", "UPS", "Hermes", "DPD", "GLS", "Deutsche Post", "Versanddienst"]) {
    assert.ok(!built.text.includes(invented), `carrier was invented: ${invented}`);
  }
  // And no link was assembled from the number.
  assert.ok(!built.html.includes("<a href=\"http"), "a tracking link was fabricated");
});

test("a blank stored value is not a tracking fact", () => {
  assert.deepEqual(selectShipmentTracking("  ", "X1", "  "), {
    carrier: null,
    trackingNumber: "X1",
    trackingUrl: null,
  });
});

test("the wiring sanitizes the stored tracking URL before it can reach an inbox", () => {
  assert.ok(
    wiringCode.includes("sanitizeTrackingUrl(order.tracking_url)"),
    "the stored tracking URL is passed through unsanitized"
  );
  // And no carrier lookup table was smuggled in anywhere.
  for (const carrier of ["dhl.de", "ups.com", "dpd.de", "gls-group", "hermesworld", "deutschepost"]) {
    assert.ok(!rulesCode.toLowerCase().includes(carrier), `a carrier URL appeared: ${carrier}`);
    assert.ok(!wiringCode.toLowerCase().includes(carrier), `a carrier URL appeared: ${carrier}`);
    assert.ok(!withoutComments(template).toLowerCase().includes(carrier), `a carrier URL appeared: ${carrier}`);
  }
});

test("no delivery date is promised", () => {
  const built = buildShipmentConfirmationEmail({
    order: {
      order_number: "GLOA-2026-000123",
      shippingAddress: null,
      tracking: selectShipmentTracking("DHL", "X1", null),
      accountOrderUrl: null,
    },
    customerEmail: "kundin@example.com",
  });
  for (const promise of ["kommt morgen", "ist morgen da", "Lieferung am", "Zustellung am", "voraussichtlich"]) {
    assert.ok(!built.html.includes(promise), `invented delivery promise: ${promise}`);
    assert.ok(!built.text.includes(promise), `invented delivery promise: ${promise}`);
  }
  assert.ok(built.text.includes("Deine Bestellung ist unterwegs."));
});

/* ── Idempotency key ──────────────────────────────────────────── */

test("the idempotency key is deterministic and stable", () => {
  assert.equal(shipmentConfirmationIdempotencyKey(ORDER_ID), `gloa/shipment/${ORDER_ID}`);
  assert.equal(
    shipmentConfirmationIdempotencyKey(ORDER_ID),
    shipmentConfirmationIdempotencyKey(ORDER_ID),
    "the key changed between calls"
  );
});

test("different orders produce different keys", () => {
  const other = "99999999-8888-7777-6666-555555555555";
  assert.notEqual(shipmentConfirmationIdempotencyKey(ORDER_ID), shipmentConfirmationIdempotencyKey(other));
});

test("the key never collides with the other messages about the same order", () => {
  const key = shipmentConfirmationIdempotencyKey(ORDER_ID);
  assert.ok(key.startsWith("gloa/shipment/"));
  assert.notEqual(key, `gloa/internal-order/${ORDER_ID}`);
});

test("the key contains no customer PII and nothing that varies per attempt", () => {
  const key = shipmentConfirmationIdempotencyKey(ORDER_ID);
  for (const pii of ["kundin@example.com", "Test Kundin", "Teststrasse", "10115", "GLOA-2026-000123", "00340434161094042557"]) {
    assert.ok(!key.includes(pii), `PII in the idempotency key: ${pii}`);
  }
  const keySource = withoutComments(template).slice(
    withoutComments(template).indexOf("export function shipmentConfirmationIdempotencyKey")
  );
  for (const varying of ["Date.now", "Math.random", "randomUUID", "toISOString"]) {
    assert.ok(!keySource.includes(varying), `the key varies per attempt via ${varying}`);
  }
});

test("the send passes the idempotency key to Resend", () => {
  assert.ok(wiringCode.includes("shipmentConfirmationIdempotencyKey(order.id)"));
  assert.ok(wiringCode.includes("{ idempotencyKey }"), "the key never reaches the provider call");
});

/* ── Recipient and content are the order's, not a caller's ────── */

test("the entry point takes an order id and nothing else", () => {
  const signature = wiringCode.match(/export async function sendShipmentConfirmationIfNeeded\(([^)]*)\)/);
  assert.ok(signature, "the entry point was renamed");
  assert.equal(signature[1].trim(), "orderId: string");
});

test("the recipient cannot be overridden by a caller", () => {
  // It is read from the order's own frozen snapshot at send time, and the
  // value that reaches Resend is that one and no other.
  assert.ok(wiringCode.includes("recipientFromSnapshot(order.customer_snapshot)"));
  assert.ok(wiringCode.includes("to: customerEmail"), "the send does not use the snapshot address");

  // The module's only two exported entry points take an order id and an
  // order row. Neither offers a recipient, a subject, a body or a force
  // flag, so there is no seam through which a caller could redirect or
  // rewrite the message.
  const exported = [...wiringCode.matchAll(EXPORTED_FN)];
  assert.equal(exported.length, 2, "the module's export surface changed");
  for (const [, name, params] of exported) {
    for (const forbidden of ["recipient", "email", "subject", "html", "text", "force", "override"]) {
      assert.ok(!params.includes(forbidden), name + " accepts a caller-supplied " + forbidden);
    }
  }
});

test("the payload is built from persisted order data, with no repricing", () => {
  for (const forbidden of [
    "buildAuthoritativeQuote", "product_variants", "price_gross_cents", "useCatalog",
    "stripe.checkout", "stripe.prices", "computeShippingGrossCents", "resolveCheckoutTax",
  ]) {
    assert.ok(!wiringCode.includes(forbidden), `the shipment email re-derives ${forbidden}`);
  }
  // No Stripe import at all: what shipped is not a question for Stripe.
  assert.ok(!wiring.includes('from "stripe"'), "the shipment email consults Stripe");
  assert.ok(!wiringCode.includes("getStripeClient"), "the shipment email consults Stripe");
});

test("the customer-facing sender convention is followed", () => {
  assert.ok(wiringCode.includes("from: GLOA_FROM_HELLO"));
  assert.ok(wiringCode.includes("replyTo: GLOA_REPLY_TO_SUPPORT"));
  assert.equal(GLOA_FROM_HELLO, "GLOA <hello@gloamatcha.com>");
  assert.equal(GLOA_REPLY_TO_SUPPORT, "support@gloamatcha.com");
  // The internal fulfillment inbox is never a sender or a recipient here.
  assert.ok(!wiringCode.includes("GLOA_INTERNAL_ORDERS"), "the customer mail touches the internal inbox");
  assert.ok(!wiringCode.includes(GLOA_INTERNAL_ORDERS));
  // RESEND_CONTACT_FROM gates the contact form and has no business here.
  assert.ok(!wiringCode.includes("RESEND_CONTACT_FROM"));
});

test("no secret is read or echoed by this module", () => {
  assert.ok(!wiringCode.includes("RESEND_API_KEY"), "the API key is named outside getResendClient");
  assert.ok(!wiringCode.includes("process.env"), "the module reads the environment directly");
});

/* ── It sends only its own message ────────────────────────────── */

test("it never resends the order confirmation or the internal notification", () => {
  for (const other of [
    "buildOrderConfirmationEmail", "sendOrderConfirmationEmail",
    "buildInternalOrderNotificationEmail", "sendInternalOrderNotificationIfNeeded",
    "deliverClaimedInternalOrderNotification", "confirmation_email_status",
    "internal_notification_status",
  ]) {
    assert.ok(!wiringCode.includes(other), `the shipment path can trigger ${other}`);
  }
});

test("it sends no subscription lifecycle email", () => {
  for (const forbidden of [
    "Abo gestartet", "subscription_status", "cancelSubscription", "invoice.paid",
    "B2C_SUBSCRIPTIONS_ENABLED", "subscriptionCheckout",
  ]) {
    assert.ok(!wiringCode.includes(forbidden), `subscription lifecycle leaked in: ${forbidden}`);
    assert.ok(!rulesCode.includes(forbidden), `subscription lifecycle leaked in: ${forbidden}`);
  }
});

/* ── Unreachability: the CASE B guarantee ─────────────────────── */

test("ONLY the authorized shipment route calls the shipment sender", () => {
  // Phase 2A asserted this list was EMPTY, because there was no
  // authorized shipment transition to wire the sender to. Phase 2B built
  // that transition, so exactly one caller is now correct and expected.
  //
  // The rule this protects is unchanged, and if anything stricter: the
  // sender is reachable from the authorized operator route and from
  // nowhere else. A webhook, a cron, a customer route or a page appearing
  // in this list would mean a customer could be told their parcel had
  // shipped without an operator having shipped it.
  const callers = [];
  const walk = dir => {
    for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) { walk(rel); continue; }
      if (!/\.(ts|tsx|mjs|js)$/.test(entry.name)) continue;
      if (rel === "lib/shipmentConfirmationEmail.ts") continue;
      // Comments stripped: the rules module and the migration NAME this
      // file in prose, and prose is not a call site.
      const source = withoutComments(read(rel));
      if (source.includes("sendShipmentConfirmationIfNeeded") || source.includes('from "./shipmentConfirmationEmail"')) {
        callers.push(rel);
      }
    }
  };
  for (const dir of ["app", "lib", "worker"]) walk(dir);
  assert.deepEqual(callers, ["app/api/internal/orders/ship/route.ts"],
    `unexpected shipment sender callers: ${callers.join(", ")}`);
});

test("no route, webhook or cron can trigger a shipment confirmation", () => {
  const webhook = read("app/api/stripe/webhook/route.ts");
  const cron = read("app/api/cron/retry-order-notifications/route.ts");
  const success = read("app/api/orders/success/route.ts");
  for (const [name, source] of [["webhook", webhook], ["cron", cron], ["success page API", success]]) {
    assert.ok(!source.includes("Shipment"), `${name} references the shipment sender`);
    assert.ok(!source.includes("shipment_email"), `${name} writes shipment email state`);
  }
});

test("no route can mark an order shipped", () => {
  const routes = [];
  const walk = dir => {
    for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) { walk(rel); continue; }
      if (entry.name === "route.ts") routes.push(rel);
    }
  };
  walk("app/api");
  assert.ok(routes.length > 0, "no API routes were found to check");
  // Phase 2B added exactly one route that may. It reaches those columns
  // only through the SECURITY DEFINER RPC from migration 028 - it holds no
  // grant to write them itself - and it is covered in depth by
  // tests/shipment-transition-api.test.mjs.
  const AUTHORIZED = "app/api/internal/orders/ship/route.ts";
  assert.ok(routes.includes(AUTHORIZED), "the authorized shipment route is missing");
  for (const rel of routes) {
    if (rel === AUTHORIZED) continue;
    const source = withoutComments(read(rel));
    for (const write of [
      "fulfillment_status", "shipped_at", "tracking_number",
      "tracking_url", "shipping_carrier", "mark_order_shipped",
    ]) {
      assert.ok(!source.includes(write), `${rel} touches ${write}`);
    }
  }
  // And the authorized one still cannot write them directly.
  const authorized = withoutComments(read(AUTHORIZED));
  assert.ok(!authorized.includes(".update("), "the authorized route writes a table directly");
  assert.ok(!authorized.includes('.from("orders")'), "the authorized route reaches the orders table directly");
});

test("the customer UI can read shipment state but never write it", () => {
  const portal = withoutComments(read("app/AccountPortal.tsx"));
  // It declares the columns as read types - that is the point of the
  // page. What it must never contain is a write of any of them.
  assert.ok(portal.includes("shipped_at: string | null;"), "the portal no longer reads shipment state");
  // It does write one thing - the customer's own profile - so the check
  // is on WHAT it writes, not on whether it writes at all.
  const writes = [...portal.matchAll(/from\("(\w+)"\)\s*\.update\(\{([^}]*)/g)];
  for (const [, table, payload] of writes) {
    assert.notEqual(table, "orders", "the account portal updates the orders table");
    for (const column of ["fulfillment_status", "shipped_at", "tracking_", "shipping_carrier", "shipment_email"]) {
      assert.ok(!payload.includes(column), `the account portal writes ${column}`);
    }
  }
  // And no RPC or route by which a customer could assert a shipment.
  // fulfillment_status is deliberately NOT on this list: the portal
  // declares it as a read type, which is exactly what it should do.
  for (const forbidden of ["shipment_email", "mark_order_shipped", "shipped: true"]) {
    assert.ok(!portal.includes(forbidden), `the account portal touches shipment state: ${forbidden}`);
  }
});

/* ── Historical order safety ──────────────────────────────────── */

test("a NULL email status is never sweep eligible", () => {
  // The trap this whole design is built around: production already holds
  // orders the owner shipped by hand, and their new column is NULL.
  assert.equal(isShipmentEmailSweepEligible(null), false);
  assert.equal(isShipmentEmailSweepEligible(undefined), false);
  assert.equal(isShipmentEmailSweepEligible("sent"), false);
  assert.equal(isShipmentEmailSweepEligible(IN_FLIGHT_STATUS), false);
  assert.equal(isShipmentEmailSweepEligible(RETRY_ELIGIBLE_STATUS), true);
});

test("an already-shipped historical order is invisible to any sweep", () => {
  // Shipped long ago, never part of the email flow.
  const historical = shippedRow({
    shipped_at: "2026-07-01T09:00:00.000Z",
    shipment_email_status: null,
  });
  assert.equal(isShipmentEmailSweepEligible(historical.shipment_email_status), false);
  // It IS claimable by a direct caller - which is correct, and is exactly
  // why no unattended sweep may use the direct-caller predicate.
  assert.equal(isShipmentConfirmationEligible(historical), true);
  assert.notEqual(isShipmentEmailClaimable(null), isShipmentEmailSweepEligible(null));
});

test("no sweep over shipment email state exists anywhere", () => {
  for (const rel of ["lib/internalOrderNotificationRetry.ts", "lib/internalOrderNotificationRetryRules.ts", "app/api/cron/retry-order-notifications/route.ts"]) {
    assert.ok(!read(rel).includes("shipment_email"), `${rel} sweeps shipment email state`);
  }
  assert.ok(!wiringCode.includes(".is(\"shipment_email_status\", null)"), "a NULL sweep exists");
  assert.ok(!wiringCode.includes("loadFailedOrders"), "a shipment sweep exists");
});

test("no new cron job was registered", () => {
  const vercel = JSON.parse(read("vercel.json"));
  const crons = vercel.crons ?? [];
  assert.equal(crons.length, 1, "a cron job was added or removed");
  assert.equal(crons[0].path, "/api/cron/retry-order-notifications");
});

/* ── Migration 027 ────────────────────────────────────────────── */

test("027 owns its number and 022-026 are untouched", () => {
  const files = readdirSync(MIGRATIONS).filter(f => f.endsWith(".sql")).sort();
  const numbers = files.map(f => f.slice(0, 3));
  assert.equal(new Set(numbers).size, numbers.length, "a migration number is used twice");
  const twentySevens = files.filter(f => f.startsWith("027"));
  assert.equal(twentySevens.length, 1, "027 is not exactly one file");
  assert.equal(twentySevens[0], "027_shipment_confirmation_email_state.sql");
  // 027 was the next free number when it was written. 028 has since been
  // taken by the authorized shipment transition (Phase 2B), which is a
  // different migration and must not reach into 027's columns.
  const sql028 = withoutComments(
    readFileSync(path.join(MIGRATIONS, "028_authorized_shipment_transition.sql"), "utf-8")
  );
  assert.ok(!sql028.includes("shipment_email"), "028 writes 027's email state");
  assert.ok(!sql028.includes("alter table"), "028 alters a table");
});

test("027 adds nullable columns with no default, so no historical row is queued", () => {
  assert.ok(/add column shipment_email_status text\s*$/m.test(migration027.split(NEWLINE).map(l => l.trimEnd()).join(NEWLINE)));
  assert.ok(!/shipment_email_status[^;]*not null/i.test(migration027), "the status column is NOT NULL");
  assert.ok(!/shipment_email_status[^;]*default/i.test(migration027), "the status column has a default");
  assert.ok(!migration027.includes("'pending'") || migration027.includes("No 'pending'"),
    "'pending' appears outside the explanatory verification note");
});

test("027 constrains the status to exactly the three attempted states", () => {
  assert.ok(migration027.includes("check (shipment_email_status in ('sending', 'sent', 'failed'))"));
  assert.deepEqual([...SHIPMENT_EMAIL_STATUSES], ["sending", "sent", "failed"]);
});

test("027 grants only the two email columns, never shipment or money columns", () => {
  // Against the SQL only. The verification notes deliberately NAME the
  // columns that must not appear in a grant, and a check that read the
  // comments would trip over its own documentation.
  const sql = withoutComments(migration027);
  const grants = sql.split(NEWLINE).filter(l => l.trim().toLowerCase().startsWith("grant"));
  assert.equal(grants.length, 1, "more than one grant was issued");
  assert.ok(migration027.includes("grant update (shipment_email_status, shipment_email_sent_at)"));
  assert.ok(migration027.includes("on public.orders to service_role;"));
  for (const column of ["fulfillment_status", "shipped_at", "tracking_number", "tracking_url", "shipping_carrier", "payment_status", "total_gross_cents"]) {
    assert.ok(
      !new RegExp(`grant[^;]*${column}`, "i").test(sql),
      `027 grants write access to ${column}`
    );
  }
  for (const role of ["anon", "authenticated"]) {
    assert.ok(
      !new RegExp(`grant[^;]*to ${role}`, "i").test(sql),
      `027 grants ${role} something`
    );
  }
});

test("027 performs no backfill, no send and no DDL beyond the two columns", () => {
  const sql = migration027
    .split(NEWLINE)
    .filter(line => !line.trim().startsWith("--"))
    .join(NEWLINE);
  for (const forbidden of ["update public.orders", "insert into", "delete from", "create function", "create trigger", "create policy", "drop "]) {
    assert.ok(!sql.toLowerCase().includes(forbidden), `027 performs: ${forbidden}`);
  }
});

test("027 does not edit any live migration", () => {
  // The immutable set, by content: each still opens with its own header.
  const immutable = {
    "022_recurring_subscription_foundation.sql": "022",
    "023_harden_stripe_customers_grants.sql": "023",
    "024_seed_b2c_subscription_plans.sql": "024",
    "025_grant_subscription_plans_service_role.sql": "025",
    "026_internal_order_notification_state.sql": "026",
  };
  for (const [file, prefix] of Object.entries(immutable)) {
    const source = readFileSync(path.join(MIGRATIONS, file), "utf-8");
    assert.ok(source.length > 0, `${file} is empty`);
    assert.ok(!source.includes("shipment_email"), `${prefix} was edited to add shipment state`);
  }
});

/* ── The template still says nothing it cannot back up ────────── */

test("the shipment email carries the order number and the support contact", () => {
  const built = buildShipmentConfirmationEmail({
    order: {
      order_number: "GLOA-2026-000123",
      shippingAddress: null,
      tracking: null,
      accountOrderUrl: null,
    },
    customerEmail: "kundin@example.com",
  });
  assert.ok(built.subject.includes("GLOA-2026-000123"));
  assert.ok(built.html.includes("GLOA-2026-000123"));
  assert.ok(built.html.includes("Versendet"));
  assert.ok(built.text.includes("info@gloamatcha.com"), "no support contact in the plain text part");
});

test("no real Resend request and no production Supabase in this suite", () => {
  // Everything above drives the pure state machine through an in-memory
  // port or reads a file. Nothing here constructs a provider client,
  // opens a socket, or names a database host.
  const suite = withoutComments(read("tests/shipment-confirmation.test.mjs"));
  // Assembled at runtime so this list cannot match itself in the source
  // it is scanning.
  const forbidden = [
    ["create", "Client("], ["new ", "Resend("], ["fet", "ch("],
    ["supabase", ".co"], ["api.", "resend.com"],
  ].map(parts => parts.join(""));
  for (const needle of forbidden) {
    assert.ok(!suite.includes(needle), "the suite performs: " + needle);
  }
});
