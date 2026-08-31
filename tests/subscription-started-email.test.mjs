import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SUBSCRIPTION_EMAIL_FAMILIES,
  SUBSCRIPTION_EMAIL_STATUSES,
  SUBSCRIPTION_STARTED_FAMILY,
  SUBSCRIPTION_START_BILLING_REASON,
  evaluateSubscriptionStartPreflight,
  isSubscriptionStartInvoice,
  recipientFromCustomerSnapshot,
  subscriptionStartedEventKey,
} from "../lib/subscriptionEmailDeliveryRules.ts";
import {
  buildSubscriptionStartedEmail,
  subscriptionStartedIdempotencyKey,
} from "../lib/email/subscriptionStarted.ts";
import { GLOA_FROM_HELLO, GLOA_REPLY_TO_SUPPORT } from "../lib/emailSenders.ts";
import {
  LAUNCH_SUBSCRIPTION_SKUS,
  SUBSCRIPTION_INTERVAL_COUNT,
  SUBSCRIPTION_INTERVAL_UNIT,
  SUBSCRIPTION_QUANTITY,
} from "../lib/subscriptionInvoiceRules.ts";

// SAFE DEFAULT SUITE: pure rule and template logic plus source-level
// checks. No server is spawned, no database is reachable, no Supabase
// client is constructed, no Stripe API is called, no subscription is
// created, no invoice is paid and no email of any kind is sent. Nothing
// here executes SQL and nothing here requires TEST_SUPABASE_*.
//
// The rules this suite protects: a customer hears "dein Abo ist aktiv"
// exactly once per subscription, only after the FIRST invoice is genuinely
// paid, never for a renewal, never twice because Stripe redelivered a
// webhook, never at an address a caller supplied, and never carrying a
// billing date that could have moved since the message was owed.

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf-8");
const NEWLINE = String.fromCharCode(10);

const MIGRATIONS_DIR = path.join(ROOT, "supabase/migrations");
const MIGRATION_035 = "035_subscription_email_deliveries.sql";

const withoutComments = source => source
  .split(NEWLINE)
  .filter(line => {
    const t = line.trim();
    return !t.startsWith("--") && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
  })
  .join(NEWLINE);

const webhook = read("app/api/stripe/webhook/route.ts");
const sender = read("lib/subscriptionStartedEmail.ts");
const rules = read("lib/subscriptionEmailDeliveryRules.ts");
const template = read("lib/email/subscriptionStarted.ts");
const fulfillment = read("lib/subscriptionInvoiceFulfillment.ts");
const migration035 = read(`supabase/migrations/${MIGRATION_035}`);

const webhookCode = withoutComments(webhook);
const senderCode = withoutComments(sender);
const rulesCode = withoutComments(rules);
const templateCode = withoutComments(template);
const fulfillmentCode = withoutComments(fulfillment);
const sql035 = withoutComments(migration035);

const SUBSCRIPTION_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

/**
 * One top-level `async function NAME(...)` body, whatever order the
 * handlers happen to sit in. Anchored on the next top-level declaration
 * rather than on file position, so moving a handler cannot silently turn
 * an assertion into a check against an empty string.
 */
const handlerBody = name => {
  const at = webhookCode.indexOf(`async function ${name}(`);
  assert.notEqual(at, -1, `${name} disappeared`);
  const next = webhookCode.indexOf(`${NEWLINE}async function `, at + 1);
  return webhookCode.slice(at, next === -1 ? webhookCode.length : next);
};

/** A complete, sendable subscription, for the preflight assertions. */
const subscription = (overrides = {}) => ({
  id: SUBSCRIPTION_ID,
  customer_type: "private",
  status: "active",
  customer_snapshot: { email: "kundin@example.com", name: "Mia" },
  plan_snapshot: {
    name: "GLOA Matcha 50 g · alle 4 Wochen",
    sku: "GLOA-MATCHA-50G",
    billingIntervalUnit: "week",
    billingIntervalCount: 4,
    deliveryIntervalUnit: "week",
    deliveryIntervalCount: 4,
    discountPercent: null,
    commitmentMonths: null,
  },
  ...overrides,
});

const items = (overrides = {}) => [{ sku: "GLOA-MATCHA-50G", quantity: 1, ...overrides }];

const preflight = (subOverrides = {}, itemList = items()) =>
  evaluateSubscriptionStartPreflight({
    subscription: subscription(subOverrides),
    items: itemList,
  });

const built = (facts = {}) =>
  buildSubscriptionStartedEmail({
    subscription: {
      packageName: "GLOA Matcha 50 g · alle 4 Wochen",
      quantity: 1,
      cadenceWeeks: 4,
      accountSubscriptionsUrl: "https://gloamatcha.com/account/subscriptions",
      ...facts,
    },
  });

/* ══════════════════════════════════════════════════════════════
   1-3. WHICH EVENT MAY SEND IT
   ══════════════════════════════════════════════════════════════ */

test("1: the start message fires for subscription_create and for nothing else", () => {
  assert.equal(SUBSCRIPTION_START_BILLING_REASON, "subscription_create");
  assert.equal(isSubscriptionStartInvoice("subscription_create"), true);
});

test("2: a renewal (subscription_cycle) does not fire it", () => {
  assert.equal(isSubscriptionStartInvoice("subscription_cycle"), false);
  // And every other reason Stripe can raise, plus the empty cases.
  for (const reason of [
    "manual", "subscription_update", "subscription_threshold", "upcoming",
    "quote_accept", "", null, undefined,
  ]) {
    assert.equal(isSubscriptionStartInvoice(reason), false, `${reason} must not start a subscription`);
  }
});

test("2b: the gate lives in the sender, so a second caller cannot bypass it", () => {
  assert.ok(senderCode.includes("if (!isSubscriptionStartInvoice(billingReason)) return \"not-eligible\";"),
    "the sender must refuse a non-start invoice itself");
  // And it refuses BEFORE any database work, so a renewal writes nothing.
  const gateAt = senderCode.indexOf("isSubscriptionStartInvoice(billingReason)");
  const claimAt = senderCode.indexOf("claimSubscriptionStartedDelivery(subscriptionId");
  assert.ok(gateAt !== -1 && claimAt !== -1);
  assert.ok(gateAt < claimAt, "a renewal must be refused before the claim is attempted");
});

test("3: checkout.session.completed cannot send it", () => {
  // The call exists exactly once, inside handleInvoicePaid.
  const calls = webhookCode.match(/sendSubscriptionStartedEmailIfNeeded\(/g) ?? [];
  assert.equal(calls.length, 1, "the start email must have exactly one call site");

  // The one call site is inside handleInvoicePaid, and inside nothing else.
  assert.ok(handlerBody("handleInvoicePaid").includes("sendSubscriptionStartedEmailIfNeeded("),
    "the start email must be sent from the paid-invoice handler");

  // Both checkout.session.completed branches are silent about it.
  for (const handler of ["handleSubscriptionSessionCompleted", "handleCheckoutSessionCompleted"]) {
    assert.ok(!handlerBody(handler).includes("sendSubscriptionStartedEmailIfNeeded"),
      `checkout.session.completed must not send the start message (${handler})`);
  }

  // And the dispatcher still routes a subscription session to the session
  // handler rather than to the invoice one, which is what keeps them apart.
  assert.ok(webhookCode.includes('if (session.mode === "subscription") {'));
  assert.ok(webhookCode.includes("await handleSubscriptionSessionCompleted(stripe, session);"));
});

test("3b: no other lifecycle event sends it either", () => {
  for (const handler of [
    "handleSubscriptionUpdated", "handleSubscriptionDeleted", "handleRefundEvent",
    "handleCheckoutSessionCompleted",
  ]) {
    assert.ok(!handlerBody(handler).includes("sendSubscriptionStartedEmailIfNeeded"),
      `${handler} must not send the start message`);
  }
  // Nothing in the account UI or any route reaches the sender.
  for (const rel of [
    "app/AccountPortal.tsx",
    "app/api/subscriptions/cancel/route.ts",
    "app/api/cron/retry-order-notifications/route.ts",
  ]) {
    assert.ok(!read(rel).includes("subscriptionStartedEmail"),
      `${rel} must not reach the start sender`);
  }
});

/* ══════════════════════════════════════════════════════════════
   4-5. WHERE IT SITS IN THE PAID-INVOICE LIFECYCLE
   ══════════════════════════════════════════════════════════════ */

test("4: the durable order exists before the start email is attempted", () => {
  const fulfilAt = webhookCode.indexOf("fulfillPaidSubscriptionInvoice(");
  const startAt = webhookCode.indexOf("sendSubscriptionStartedEmailIfNeeded(");
  assert.ok(fulfilAt !== -1 && startAt !== -1);
  assert.ok(fulfilAt < startAt, "the order must exist before the customer is told anything");

  // And the fulfillment itself still creates the order and records the
  // paid period before it returns the two facts the sender is given.
  const orderAt = fulfillmentCode.indexOf("deps.createOrder(");
  const paidAt = fulfillmentCode.indexOf("deps.recordPaidPeriod(");
  // Anchored on the fulfilled RETURN itself. subscriptionId is also
  // passed to activateFromInvoice earlier and the billing reason is also
  // read for evaluateSubscriptionInvoice earlier, so an indexOf on either
  // would find a step ahead of the order and prove nothing.
  const returnAt = fulfillmentCode.indexOf('kind: "fulfilled",');
  assert.ok(orderAt !== -1 && paidAt !== -1 && returnAt !== -1);
  assert.ok(orderAt < paidAt, "the order must exist before the paid period is recorded");
  assert.ok(paidAt < returnAt, "the payment evidence must be durable before the caller is told");
  // The two facts the sender is given both come from the fulfilled
  // return, after all three durable steps.
  const returned = fulfillmentCode.slice(returnAt);
  assert.ok(returned.includes("subscriptionId: subscription.id,"),
    "the local subscription id must come from the validated row");
  assert.ok(returned.includes("billingReason: invoice.billing_reason ?? null,"),
    "the billing reason must come from the re-read invoice");
});

test("5: internal notification first, start email second, deferred cancellation last", () => {
  const internalAt = webhookCode.indexOf("sendInternalOrderNotificationIfNeeded(");
  const startAt = webhookCode.indexOf("sendSubscriptionStartedEmailIfNeeded(");
  const deferredAt = webhookCode.indexOf("applyDeferredCancellationFromRenewal(");
  assert.ok(internalAt !== -1 && startAt !== -1 && deferredAt !== -1);

  // Fulfillment must never queue behind a customer mail provider.
  assert.ok(internalAt < startAt, "the internal notification must come first");
  // The deferred cancellation may throw by design; a throw must not be
  // able to skip the customer's message on a delivery that got this far.
  assert.ok(startAt < deferredAt, "the start email must precede the deferred cancellation");
});

test("5b: the start email cannot break any of the three steps around it", () => {
  // It never throws, so the mandatory post-payment work below it still
  // runs on this same delivery.
  assert.ok(!/throw/.test(senderCode), "the sender must not throw");
  // The call site does not rethrow either.
  const callBlock = webhookCode.slice(
    webhookCode.indexOf("const started = await sendSubscriptionStartedEmailIfNeeded("),
    webhookCode.indexOf("applyDeferredCancellationFromRenewal(")
  );
  assert.ok(callBlock.length > 0);
  assert.ok(!callBlock.includes("throw"), "a failed start email must not fail the webhook");

  // And the deferred cancellation still throws on error, unchanged.
  assert.ok(webhookCode.includes('if (deferred === "error") {'));
  assert.ok(webhookCode.includes("deferred cancellation for subscription ${result.stripeSubscriptionId} could not be applied"));
});

/* ══════════════════════════════════════════════════════════════
   6, 11-13. THE EVENT KEY AND WHAT IT MAKES IMPOSSIBLE
   ══════════════════════════════════════════════════════════════ */

test("6: the event key is the local subscription id", () => {
  assert.equal(subscriptionStartedEventKey(SUBSCRIPTION_ID), SUBSCRIPTION_ID);
  // Deterministic, and normalised so a differently-cased caller cannot
  // produce a second key for one subscription.
  assert.equal(subscriptionStartedEventKey(SUBSCRIPTION_ID.toUpperCase()), SUBSCRIPTION_ID);
  assert.equal(subscriptionStartedEventKey(`  ${SUBSCRIPTION_ID}  `), SUBSCRIPTION_ID);
});

test("6b: a key the database would refuse is never attempted", () => {
  // Migration 035 CHECKs length(btrim(event_key)) > 0.
  for (const blank of ["", "   ", null, undefined]) {
    assert.equal(subscriptionStartedEventKey(blank), null);
  }
  assert.ok(senderCode.includes("if (!eventKey) return \"not-eligible\";"));
});

test("11: the same subscription can never produce a second start delivery", () => {
  // One subscription, many attempts, one key - and the unique constraint
  // is on exactly that triple.
  const keys = new Set([
    subscriptionStartedEventKey(SUBSCRIPTION_ID),
    subscriptionStartedEventKey(SUBSCRIPTION_ID),
    subscriptionStartedEventKey(SUBSCRIPTION_ID.toUpperCase()),
  ]);
  assert.equal(keys.size, 1);
  assert.ok(sql035.includes("unique (subscription_id, family, event_key)"));
  assert.equal(SUBSCRIPTION_STARTED_FAMILY, "subscription_started");
});

test("12-13: no webhook event id reaches the key, the claim or the provider", () => {
  // A redelivery carries a NEW Stripe event id, and a different event
  // representing the same first paid fact carries another one again.
  // Neither can reach anything that decides whether to send.
  for (const source of [rulesCode, senderCode, templateCode]) {
    for (const forbidden of ["event.id", "eventId", "stripeEventId", "webhookEventId"]) {
      assert.ok(!source.includes(forbidden), `an event id reaches the send decision: ${forbidden}`);
    }
  }
  // The sender's whole input is a subscription id and a billing reason.
  assert.ok(senderCode.includes("subscriptionId: string;"));
  assert.ok(senderCode.includes("billingReason: string | null;"));
  // The call site passes exactly those two, both from the RE-READ invoice
  // rather than from the event payload.
  assert.ok(webhookCode.includes("subscriptionId: result.subscriptionId,"));
  assert.ok(webhookCode.includes("billingReason: result.billingReason,"));
  assert.ok(fulfillmentCode.includes("billingReason: invoice.billing_reason ?? null,"),
    "the billing reason must come from the re-read invoice");
});

test("12b: the provider key is keyed on the subscription, not on the delivery attempt", () => {
  assert.equal(
    subscriptionStartedIdempotencyKey(SUBSCRIPTION_ID),
    `gloa/subscription-started/${SUBSCRIPTION_ID}`
  );
  // Stable across attempts: the same input always gives the same key.
  assert.equal(
    subscriptionStartedIdempotencyKey(SUBSCRIPTION_ID),
    subscriptionStartedIdempotencyKey(SUBSCRIPTION_ID)
  );
});

/* ══════════════════════════════════════════════════════════════
   7-10. THE CLAIM IS THE DATABASE'S
   ══════════════════════════════════════════════════════════════ */

test("7: the first claim is one atomic statement against the unique constraint", () => {
  assert.ok(senderCode.includes('.from("subscription_email_deliveries")'));
  assert.ok(senderCode.includes(".upsert("), "the claim must be a single insert statement");
  assert.ok(senderCode.includes('onConflict: "subscription_id,family,event_key"'),
    "the conflict target must be migration 035's unique constraint");
});

test("8: the claim is ON CONFLICT DO NOTHING", () => {
  assert.ok(senderCode.includes("ignoreDuplicates: true"),
    "ignoreDuplicates: true is what PostgREST turns into ON CONFLICT DO NOTHING");
  // Zero rows back is the conflict signal, and it is read as a claim
  // outcome rather than as an error.
  assert.ok(senderCode.includes('return claimed ? { kind: "claimed", deliveryId: claimed } : { kind: "taken" };'));
});

test("9: there is no select-then-insert race guard", () => {
  const claimFn = senderCode.slice(
    senderCode.indexOf("async function claimSubscriptionStartedDelivery"),
    senderCode.indexOf("async function markSent")
  );
  assert.ok(claimFn.length > 0);
  // The only .select in the claim is the RETURNING clause on the insert.
  const selects = claimFn.match(/\.select\(/g) ?? [];
  assert.equal(selects.length, 1, "the claim must not read before it writes");
  assert.ok(claimFn.indexOf(".upsert(") < claimFn.indexOf(".select("),
    "the select must be the insert's RETURNING, not a prior read");
  assert.ok(!claimFn.includes(".maybeSingle()"), "the claim must not look the row up first");

  // And the claim happens before the subscription is ever read.
  const claimCallAt = senderCode.indexOf("await claimSubscriptionStartedDelivery(");
  const readAt = senderCode.indexOf('.from("subscriptions")');
  assert.ok(claimCallAt !== -1 && readAt !== -1);
  assert.ok(claimCallAt < readAt, "nothing may be read before the claim is won");
});

test("10: no upsert anywhere in this feature emits ON CONFLICT DO UPDATE", () => {
  assert.ok(!senderCode.includes("ignoreDuplicates: false"));
  // Every upsert in the sender carries ignoreDuplicates: true.
  const upserts = senderCode.match(/\.upsert\(/g) ?? [];
  const ignores = senderCode.match(/ignoreDuplicates: true/g) ?? [];
  assert.equal(upserts.length, ignores.length, "an upsert without ignoreDuplicates exists");
  assert.equal(upserts.length, 1, "there should be exactly one claim");
});

/* ══════════════════════════════════════════════════════════════
   14-16. WHO IT GOES TO AND WHAT IT SAYS
   ══════════════════════════════════════════════════════════════ */

test("14: the recipient comes from the subscription's frozen customer_snapshot", () => {
  assert.equal(recipientFromCustomerSnapshot({ email: "kundin@example.com" }), "kundin@example.com");
  assert.equal(recipientFromCustomerSnapshot({ email: "  kundin@example.com  " }), "kundin@example.com");
  const result = preflight();
  assert.equal(result.kind, "send");
  assert.equal(result.recipient, "kundin@example.com");
});

test("14b: a snapshot without a usable address fails safely and invents nothing", () => {
  for (const snapshot of [null, undefined, {}, { email: null }, { email: "" }, { email: "   " }, { email: 42 }]) {
    assert.equal(recipientFromCustomerSnapshot(snapshot), null);
  }
  const result = preflight({ customer_snapshot: {} });
  assert.equal(result.kind, "failed");
  assert.match(result.reason, /no customer email/);
});

test("15: there is no recipient parameter anywhere, so an arbitrary one is impossible", () => {
  const entry = senderCode.slice(senderCode.indexOf("export async function sendSubscriptionStartedEmailIfNeeded"));
  const signature = entry.slice(0, entry.indexOf("): Promise<"));
  for (const f of ["email", "recipient", "to:", "address"]) {
    assert.ok(!signature.includes(f), `the entry point takes a recipient: ${f}`);
  }
  // The only address the send can use is the one the preflight read back.
  assert.ok(senderCode.includes("to: preflight.recipient,"));
  // And no request body, query string or Stripe payload address exists here.
  for (const forbidden of ["request.", "searchParams", "req.body", "customer_details", "invoice.customer_email"]) {
    assert.ok(!senderCode.includes(forbidden), `the sender reads an outside address: ${forbidden}`);
  }
});

test("16: the plan facts come from the frozen plan_snapshot", () => {
  const result = preflight();
  assert.equal(result.kind, "send");
  assert.equal(result.content.packageName, "GLOA Matcha 50 g · alle 4 Wochen");
  // A renamed catalog entry is reflected; nothing is derived from a SKU
  // or from the webhook.
  const renamed = preflight({
    plan_snapshot: { ...subscription().plan_snapshot, name: "GLOA Matcha 100 g · alle 4 Wochen" },
  });
  assert.equal(renamed.content.packageName, "GLOA Matcha 100 g · alle 4 Wochen");
  // A missing name is omitted rather than faked: the other facts are
  // complete without it.
  const unnamed = preflight({
    plan_snapshot: { ...subscription().plan_snapshot, name: null },
  });
  assert.equal(unnamed.kind, "send");
  assert.equal(unnamed.content.packageName, null);
  assert.ok(!built({ packageName: null }).text.includes("null"));
});

test("16b: no package is ever hardcoded in the template or the rules", () => {
  for (const source of [templateCode, senderCode]) {
    for (const f of ["30 g", "50 g", "100 g", "GLOA-MATCHA-"]) {
      assert.ok(!source.includes(f), `a package is hardcoded: ${f}`);
    }
  }
});

/* ══════════════════════════════════════════════════════════════
   17-21. THE COPY
   ══════════════════════════════════════════════════════════════ */

test("17: the copy states the cadence as Alle 4 Wochen", () => {
  const { html, text } = built();
  assert.ok(html.includes("Alle 4 Wochen"), "the HTML must state the cadence");
  assert.ok(text.includes("Alle 4 Wochen"), "the plain text must state the cadence");
});

test("17b: the cadence is rendered from the proven plan, not from a constant", () => {
  // The number comes out of the frozen snapshot, so the template cannot
  // print a rhythm the subscription was not sold on.
  assert.ok(built({ cadenceWeeks: 2 }).text.includes("Alle 2 Wochen"));
  // And a plan that is not billed every four weeks never reaches it.
  const wrong = preflight({
    plan_snapshot: { ...subscription().plan_snapshot, billingIntervalCount: 1 },
  });
  assert.equal(wrong.kind, "failed");
  assert.match(wrong.reason, /every 4 weeks/);
  const monthly = preflight({
    plan_snapshot: { ...subscription().plan_snapshot, billingIntervalUnit: "month" },
  });
  assert.equal(monthly.kind, "failed");
});

test("18-19: the copy never says monatlich or monthly", () => {
  const { subject, html, text } = built();
  for (const surface of [subject, html, text, templateCode]) {
    for (const forbidden of ["monatlich", "Monatlich", "monthly", "Monthly", "pro Monat", "im Monat"]) {
      assert.ok(!surface.includes(forbidden), `a four-week cycle is described as monthly: ${forbidden}`);
    }
  }
});

test("20: the quantity is truthful, read from the frozen line", () => {
  assert.equal(preflight().content.quantity, 1);
  assert.ok(built({ quantity: 1 }).text.includes("1 Packung"));
  // Plural is handled rather than mis-stated, and the number is never
  // invented by the template.
  assert.ok(built({ quantity: 2 }).text.includes("2 Packungen"));
  // A line that is not one package fails closed rather than claiming one.
  const two = preflight({}, items({ quantity: 2 }));
  assert.equal(two.kind, "failed");
  const none = preflight({}, []);
  assert.equal(none.kind, "failed");
  const wrongSku = preflight({}, items({ sku: "GLOA-METAL-CASE" }));
  assert.equal(wrongSku.kind, "failed");
});

test("21: no next-billing date is rendered, and none can be", () => {
  const { subject, html, text } = built();
  for (const surface of [subject, html, text]) {
    for (const forbidden of ["Nächste Abrechnung", "Naechste Abrechnung", "Nächste Zahlung", "Nächste Lieferung"]) {
      assert.ok(!surface.includes(forbidden), `a moving date is announced: ${forbidden}`);
    }
  }
  // The template holds no date machinery at all, so one cannot be added by
  // accident: no clock, no formatter, no period column.
  for (const forbidden of [
    "Date.now", "new Date(", "toLocaleDateString", "Intl.DateTimeFormat",
    "current_period_end", "currentPeriodEnd", "next_delivery_at", "period",
  ]) {
    assert.ok(!templateCode.includes(forbidden), `the template can render a date: ${forbidden}`);
  }
  // And the sender never reads a period column to hand it one.
  for (const forbidden of ["current_period_end", "next_delivery_at", "last_paid_period_end"]) {
    assert.ok(!senderCode.includes(forbidden), `the sender reads a moving period: ${forbidden}`);
  }
});

test("21b: the account pointer is what replaces the date", () => {
  const { html, text } = built();
  assert.ok(html.includes("/account/subscriptions"));
  assert.ok(text.includes("/account/subscriptions"));
  // And it degrades to no link rather than to a broken one.
  const noOrigin = built({ accountSubscriptionsUrl: null });
  assert.ok(!noOrigin.html.includes("href=\"\""));
  assert.ok(!noOrigin.text.includes("undefined"));
  assert.ok(!noOrigin.text.includes("null"));
});

/* ══════════════════════════════════════════════════════════════
   22. THE PROVIDER
   ══════════════════════════════════════════════════════════════ */

test("22: a deterministic Resend idempotency key is used on the send", () => {
  assert.ok(senderCode.includes("const idempotencyKey = subscriptionStartedIdempotencyKey(subscriptionId);"));
  assert.ok(senderCode.includes("{ idempotencyKey }"), "the key must reach resend.emails.send");
  // Deterministic: no clock and no randomness anywhere near it.
  for (const forbidden of ["Math.random", "randomUUID", "Date.now"]) {
    assert.ok(!templateCode.includes(forbidden), `the key namespace is not deterministic: ${forbidden}`);
  }
});

test("22b: the namespace is new and collides with nothing", () => {
  const key = subscriptionStartedIdempotencyKey(SUBSCRIPTION_ID);
  assert.ok(key.startsWith("gloa/subscription-started/"));
  for (const existing of [
    "gloa/internal-order/", "gloa/shipment/", "gloa/cancellation-request/",
    "gloa/cancellation-outcome/", "gloa/refund/",
    // Stripe keys, not Resend ones, and still distinct.
    "gloa/subscription-cancel/", "gloa/subscription-defer/",
  ]) {
    assert.ok(!key.startsWith(existing), `the namespace collides with ${existing}`);
  }
});

test("22c: it uses the established customer sender convention", () => {
  assert.ok(senderCode.includes("from: GLOA_FROM_HELLO,"));
  assert.ok(senderCode.includes("replyTo: GLOA_REPLY_TO_SUPPORT,"));
  assert.equal(GLOA_FROM_HELLO, "GLOA <hello@gloamatcha.com>");
  assert.equal(GLOA_REPLY_TO_SUPPORT, "support@gloamatcha.com");
  // Never the internal fulfillment inbox.
  assert.ok(!senderCode.includes("GLOA_INTERNAL_ORDERS"));
});

/* ══════════════════════════════════════════════════════════════
   23-27. THE FOUR STATE TRANSITIONS
   ══════════════════════════════════════════════════════════════ */

test("23: provider acceptance records sent AND sent_at, unconditionally", () => {
  const markSent = senderCode.slice(
    senderCode.indexOf("async function markSent"),
    senderCode.indexOf("async function markFailed")
  );
  assert.ok(markSent.includes('.update({ status: "sent", sent_at: new Date().toISOString() })'));
  assert.ok(markSent.includes('.eq("id", deliveryId)'));
  // NOT conditional on the row still saying 'sending': acceptance is
  // already a fact, and suppressing the write would invite a duplicate.
  assert.ok(!markSent.includes('.eq("status", "sending")'),
    "recording 'sent' must not be conditional after provider acceptance");
  // And it happens only after the send genuinely succeeded: both the
  // ambiguous and the proven-refused branches return before it (3H.5B1).
  const ambiguousAt = senderCode.indexOf('if (outcome === "ambiguous")');
  const refusedAt = senderCode.indexOf('if (outcome === "definite_failure")');
  const sentAt = senderCode.indexOf("await markSent(deliveryId)");
  assert.ok(ambiguousAt !== -1 && refusedAt !== -1 && sentAt !== -1);
  assert.ok(ambiguousAt < sentAt && refusedAt < sentAt);
});

test("24: provider failure records failed only over sending", () => {
  const markFailed = senderCode.slice(
    senderCode.indexOf("async function markFailed"),
    senderCode.indexOf("async function markSuperseded")
  );
  assert.ok(markFailed.includes('.update({ status: "failed", sent_at: null })'));
  assert.ok(markFailed.includes('.eq("status", "sending")'),
    "'failed' must never be written over 'sent' or 'superseded'");
  // sent_at is cleared, or the biconditional CHECK would refuse the row.
  assert.ok(sql035.includes("(status <> 'sent' and sent_at is null)"));
});

test("25: no identity or generated column is ever written", () => {
  // Migration 035 grants UPDATE on status and sent_at alone. Nothing here
  // may attempt more, and nothing here does.
  const updates = senderCode.match(/\.update\(\{[^}]*\}\)/g) ?? [];
  assert.ok(updates.length >= 3, "the three result transitions must exist");
  for (const stmt of updates) {
    for (const forbidden of ["subscription_id", "family", "event_key", "created_at", "updated_at"]) {
      assert.ok(!stmt.includes(forbidden), `an update writes ${forbidden}: ${stmt}`);
    }
    // A bare `id:` key, which subscription_id: must not be mistaken for.
    assert.ok(!/\bid:/.test(stmt), `an update writes the primary key: ${stmt}`);
  }
  // The INSERT names exactly the four columns migration 035 grants.
  const claim = senderCode.slice(senderCode.indexOf(".upsert("), senderCode.indexOf("onConflict:"));
  for (const column of ["subscription_id", "family", "event_key", "status"]) {
    assert.ok(claim.includes(column), `the claim must supply ${column}`);
  }
  for (const forbidden of ["created_at", "updated_at", "sent_at"]) {
    assert.ok(!claim.includes(forbidden), `the claim supplies ${forbidden}, which it may not`);
  }
  assert.ok(!/\bid:/.test(claim), "the claim supplies a primary key, which it may not");
});

test("26: a terminally cancelled subscription becomes superseded, not failed", () => {
  const result = preflight({ status: "cancelled" });
  assert.equal(result.kind, "superseded");
  assert.match(result.reason, /terminally cancelled/);

  // And superseding is guarded so a sent message stays historical truth.
  const markSuperseded = senderCode.slice(senderCode.indexOf("async function markSuperseded"));
  assert.ok(markSuperseded.includes('.update({ status: "superseded", sent_at: null })'));
  assert.ok(markSuperseded.includes('.in("status", ["sending", "failed"])'),
    "sent -> superseded must be impossible");
});

test("26b: every other refusal stays owed as failed, never superseded", () => {
  // Superseding a recoverable condition would silently drop a message the
  // customer paid for and is entitled to.
  for (const [label, result] of [
    ["pending", preflight({ status: "pending" })],
    ["paused", preflight({ status: "paused" })],
    ["no recipient", preflight({ customer_snapshot: {} })],
    ["no plan", preflight({ plan_snapshot: null })],
    ["business", preflight({ customer_type: "business" })],
    ["missing row", evaluateSubscriptionStartPreflight({ subscription: null, items: [] })],
  ]) {
    assert.equal(result.kind, "failed", `${label} must stay owed, not be closed off`);
  }
});

test("27: a superseded delivery never contacts the provider", () => {
  const deliver = senderCode.slice(senderCode.indexOf("async function deliverClaimedSubscriptionStarted"));
  const supersededAt = deliver.indexOf('if (preflight.kind === "superseded")');
  const resendAt = deliver.indexOf("getResendClient()");
  assert.ok(supersededAt !== -1 && resendAt !== -1);
  assert.ok(supersededAt < resendAt, "the superseded branch must precede the provider");
  // It returns rather than falling through.
  const branch = deliver.slice(supersededAt, deliver.indexOf('if (preflight.kind === "failed")'));
  assert.ok(branch.includes('return "superseded";'));
  assert.ok(!branch.includes("resend"));
  // Same for the failed branch: neither reaches Resend.
  const failedBranch = deliver.slice(
    deliver.indexOf('if (preflight.kind === "failed")'),
    resendAt
  );
  assert.ok(failedBranch.includes('return "failed";'));
});

test("27b: a conflict is reported as claimed, never as sent", () => {
  // Three of migration 035's four statuses mean the customer has NOT been
  // written to, so a conflict must not be called "already sent".
  assert.ok(senderCode.includes('if (claim.kind === "taken") return "already-claimed";'));
  assert.ok(!senderCode.includes('"already-sent"'), "a conflict must not claim delivery");
  assert.ok(!/already.sent/i.test(senderCode.replace(/already-claimed/g, "")),
    "nothing may report a conflict as a delivery");
});

/* ══════════════════════════════════════════════════════════════
   28-31. WHAT THIS PHASE DID NOT TOUCH
   ══════════════════════════════════════════════════════════════ */

test("28: the recurring invoice path is unaffected", () => {
  // A cycle invoice still creates its order, still notifies fulfillment
  // and still reaches the deferred cancellation - the start email simply
  // returns not-eligible without writing anything.
  assert.ok(webhookCode.includes("sendInternalOrderNotificationIfNeeded("));
  assert.ok(webhookCode.includes('source: "subscription",'));
  assert.ok(webhookCode.includes("applyDeferredCancellationFromRenewal("));
  // And there is still no recurring payment-success email of any kind.
  for (const forbidden of ["Zahlung erfolgreich", "subscription_cycle_email", "renewalEmail"]) {
    assert.ok(!webhookCode.includes(forbidden), `a renewal email appeared: ${forbidden}`);
  }
});

test("29: the internal order notification is unchanged", () => {
  const internal = withoutComments(read("lib/internalOrderNotificationEmail.ts"));
  assert.ok(internal.includes("internalOrderNotificationIdempotencyKey"));
  assert.ok(!internal.includes("subscription_email_deliveries"),
    "the internal notification must not learn about the delivery table");
  assert.ok(!internal.includes("subscriptionStarted"));
});

test("30: the deferred cancellation flow never learned about THIS family", () => {
  // PHASE 3H.3 NARROWED THIS GUARD, DELIBERATELY. It used to assert that
  // lib/subscriptionCancellation.ts touched no email at all, which was
  // the right boundary while subscription_started was the only family.
  // 3H.3 has since wired the cancellation confirmation there, at the
  // three functions that write the cancellation pair. What still holds,
  // and is what this assertion is now about, is that the cancellation
  // service knows nothing about the START message, calls no provider
  // itself, and touches no delivery row directly.
  const cancellation = withoutComments(read("lib/subscriptionCancellation.ts"));
  for (const forbidden of [
    "subscription_email_deliveries", "subscriptionStarted", "subscription_started",
    "resend", "Resend", "emails.send",
  ]) {
    assert.ok(!cancellation.includes(forbidden), `the cancellation service changed: ${forbidden}`);
  }
  const cancelRoute = withoutComments(read("app/api/subscriptions/cancel/route.ts"));
  for (const forbidden of [
    "subscription_email_deliveries", "subscriptionStarted", "emails.send",
    // 3H.3 wired the confirmation into the SERVICE, not into the route.
    "cancellationConfirmationEmail",
  ]) {
    assert.ok(!cancelRoute.includes(forbidden), `the cancel route changed: ${forbidden}`);
  }
});

test("31: no automatic retry was wired", () => {
  const retryRules = withoutComments(read("lib/transactionalEmailRetryRules.ts"));
  const retry = withoutComments(read("lib/transactionalEmailRetry.ts"));
  const cron = withoutComments(read("app/api/cron/retry-order-notifications/route.ts"));
  for (const source of [retryRules, retry, cron]) {
    for (const forbidden of [
      "subscription_email_deliveries", "subscription_started",
      "subscriptionStarted", "subscriptionStartedEmail",
    ]) {
      assert.ok(!source.includes(forbidden), `the sweep learned about this phase: ${forbidden}`);
    }
  }
  // The sender exposes no sweep entry point of its own either.
  for (const forbidden of ["Sweep", "sweep", "cron", "batch", "limit(25)"]) {
    assert.ok(!senderCode.includes(forbidden), `the sender grew a sweep: ${forbidden}`);
  }
  // The 'failed' row it writes is the durable state such a sweep will
  // one day key on, which is the whole point of not building it now.
  assert.ok(senderCode.includes('.update({ status: "failed", sent_at: null })'));
});

/* ══════════════════════════════════════════════════════════════
   32-34. THE DATABASE WAS NOT TOUCHED
   ══════════════════════════════════════════════════════════════ */

test("32: migration 035 still declares exactly the contract this phase uses", () => {
  // This phase needed no schema change, so 035 must still say what it
  // said when it was applied - in particular the four INSERT columns and
  // the two UPDATE columns the sender depends on.
  assert.ok(sql035.includes("grant select on public.subscription_email_deliveries to service_role;"));
  assert.ok(sql035.includes("grant insert (subscription_id, family, event_key, status)"));
  assert.ok(sql035.includes("grant update (status, sent_at)"));
  assert.ok(sql035.includes("unique (subscription_id, family, event_key)"));
  assert.ok(sql035.includes("check (status in ('sending', 'sent', 'failed', 'superseded'))"));
  assert.ok(sql035.includes("'subscription_started'"));
  // Still no DELETE and still no payment_problem.
  assert.ok(!/grant[^;]*delete/i.test(sql035));
  assert.ok(!sql035.includes("payment_problem"));
});

test("32b: the code's vocabularies match the live migration exactly", () => {
  for (const family of SUBSCRIPTION_EMAIL_FAMILIES) {
    assert.ok(sql035.includes(`'${family}'`), `035 does not know the family ${family}`);
  }
  for (const status of SUBSCRIPTION_EMAIL_STATUSES) {
    assert.ok(sql035.includes(`'${status}'`), `035 does not know the status ${status}`);
  }
  assert.equal(SUBSCRIPTION_EMAIL_FAMILIES.length, 3);
  assert.equal(SUBSCRIPTION_EMAIL_STATUSES.length, 4);
  assert.ok(!SUBSCRIPTION_EMAIL_FAMILIES.includes("payment_problem"));
  assert.ok(!SUBSCRIPTION_EMAIL_STATUSES.includes("pending"));
});

test("33-34: 022 through 035 are all present and there is no 036", () => {
  const files = readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith(".sql")).sort();
    // PHASE 3I.B1 ADDED MIGRATION 036 (payment_problem family plus the
  // payment-status RPC). It is reviewed in
  // tests/subscription-payment-status-migration.test.mjs. What this
  // guard still protects is that no UNREVIEWED migration appeared.
  // PHASE 3J.B1 THEN ADDED 037 (the invoice-keyed refund-state writer),
  // reviewed in tests/subscription-refund-correlation-migration.test.mjs.
  assert.equal(files.length, 42, "a migration was added or removed");
  // Phase 4B1 added 039, the B2C prepaid annual plan foundation,
  // reviewed in tests/annual-plan-foundation-migration.test.mjs. The
  // guard is re-pinned, not deleted: it protects "no UNREVIEWED
  // migration appeared", never "the stack stopped growing".
  // PHASE 4B8.1 ADDED MIGRATION 041 (column-level privileges that
  // narrow the annual account read surface), reviewed in
  // tests/annual-account-privileges-migration.test.mjs. Re-pinned
  // rather than deleted: this guard protects "no UNREVIEWED migration
  // appeared", never "the stack stopped growing".
  // PHASE 4B8.2 ADDED MIGRATION 042: the ONE column privilege 041
  // was short of, so migration 039's delivery policy can still read
  // the parent's user_id while resolving ownership. Reviewed in
  // tests/annual-account-privileges-migration.test.mjs.
  assert.equal(files[files.length - 1], "042_annual_delivery_rls_parent_user_privilege.sql");
  assert.equal(files[files.length - 2], "041_annual_account_column_privileges.sql");
  assert.equal(files[files.length - 3], "040_annual_checkout_retry_fingerprints.sql");
  assert.equal(files[files.length - 4], "039_b2c_annual_plan_foundation.sql");
  assert.equal(files[files.length - 5], "038_one_time_refund_writer_concurrency.sql",
    "038 must be the highest, and 037 the one before it");
  assert.equal(files[files.length - 6], "037_subscription_refund_correlation.sql");
  assert.equal(files[files.length - 7], "036_subscription_payment_status.sql");
  assert.equal(files[files.length - 8], MIGRATION_035);
  assert.deepEqual(files.filter(f => f.startsWith("037")), ["037_subscription_refund_correlation.sql"]);
  assert.ok(!files.some(f => f.startsWith("043")), "an unreviewed migration appeared");
  for (let n = 22; n <= 34; n += 1) {
    const prefix = String(n).padStart(3, "0");
    assert.ok(files.some(f => f.startsWith(prefix)), `migration ${prefix} is missing`);
  }
  // And this phase's code creates no schema of its own.
  for (const source of [senderCode, rulesCode, templateCode]) {
    for (const forbidden of ["create table", "alter table", "create index", "create function"]) {
      assert.ok(!source.toLowerCase().includes(forbidden), `the application writes DDL: ${forbidden}`);
    }
  }
});

/* ══════════════════════════════════════════════════════════════
   35-37. THE LAUNCH GATES AND THIS SUITE ITSELF
   ══════════════════════════════════════════════════════════════ */

test("35: B2C_SUBSCRIPTIONS_ENABLED is still closed unless exactly 'true'", () => {
  const checkoutRules = read("lib/subscriptionCheckoutRules.ts");
  assert.ok(checkoutRules.includes('export const SUBSCRIPTION_FEATURE_FLAG = "B2C_SUBSCRIPTIONS_ENABLED"'));
  assert.ok(checkoutRules.includes('env[SUBSCRIPTION_FEATURE_FLAG] === "true"'),
    "the gate must stay closed-by-default and exact-match");
  // This phase neither reads nor moves the flag.
  for (const source of [senderCode, rulesCode, templateCode]) {
    assert.ok(!source.includes("B2C_SUBSCRIPTIONS_ENABLED"));
  }
});

test("36b: the mirrored launch constants have not drifted", () => {
  // lib/subscriptionEmailDeliveryRules.ts is a leaf and copies these four
  // rather than importing them, exactly as lib/subscriptionInvoiceRules.ts
  // copies them from lib/subscriptionCheckoutRules.ts. A copy that is not
  // pinned is a copy that drifts, so this is where it is pinned.
  assert.equal(SUBSCRIPTION_INTERVAL_UNIT, "week");
  assert.equal(SUBSCRIPTION_INTERVAL_COUNT, 4);
  assert.equal(SUBSCRIPTION_QUANTITY, 1);
  assert.deepEqual([...LAUNCH_SUBSCRIPTION_SKUS].sort(), [
    "GLOA-MATCHA-100G", "GLOA-MATCHA-30G", "GLOA-MATCHA-50G",
  ]);
  // The same four values, as the delivery rules module holds them.
  assert.ok(rulesCode.includes(`const SUBSCRIPTION_INTERVAL_UNIT = "${SUBSCRIPTION_INTERVAL_UNIT}"`));
  assert.ok(rulesCode.includes(`const SUBSCRIPTION_INTERVAL_COUNT = ${SUBSCRIPTION_INTERVAL_COUNT}`));
  assert.ok(rulesCode.includes(`const SUBSCRIPTION_QUANTITY = ${SUBSCRIPTION_QUANTITY}`));
  for (const sku of LAUNCH_SUBSCRIPTION_SKUS) {
    assert.ok(rulesCode.includes(`"${sku}"`), `the delivery rules lost ${sku}`);
  }
  // And the behaviour proves it: the cadence the preflight reports is the
  // interval count, and a launch SKU is accepted while another is not.
  assert.equal(preflight().content.cadenceWeeks, SUBSCRIPTION_INTERVAL_COUNT);
  for (const sku of LAUNCH_SUBSCRIPTION_SKUS) {
    assert.equal(
      preflight({ plan_snapshot: { ...subscription().plan_snapshot, sku } }, items({ sku })).kind,
      "send",
      `${sku} must be sendable`
    );
  }
});

test("36: SHOP_STATUS is still prelaunch", () => {
  assert.ok(read("app/content.ts").includes('export const SHOP_STATUS = "prelaunch"'));
});

test("37: nothing in this feature can reach a network or a database in a test", () => {
  // The template and the rules are pure leaves: no client, no fetch, no
  // clock, no environment read.
  for (const [name, source] of [["template", templateCode], ["rules", rulesCode]]) {
    assert.ok(!source.includes("supabase"), `the ${name} touches the database`);
    assert.ok(!source.includes("fetch("), `the ${name} makes a network call`);
    assert.ok(!source.includes("process.env"), `the ${name} reads the environment`);
    assert.ok(!source.includes("resend"), `the ${name} reaches the provider`);
  }
  assert.ok(!/from "\.\//.test(templateCode), "the template has a relative import");
  // Both are LEAVES, like every other rules module and template here.
  assert.ok(!/from "\.\//.test(rulesCode), "the rules module has a relative import");
  // And this suite itself imports only pure leaves and node builtins, so
  // running it can construct no client and open no connection. Checked on
  // the import specifiers rather than on a forbidden-word scan, which
  // would match the words in this very assertion.
  const self = readFileSync(fileURLToPath(import.meta.url), "utf-8");
  // Line-anchored, so the regex literals elsewhere in this file are not
  // mistaken for import specifiers.
  const specifiers = self
    .split(NEWLINE)
    .map(line => /^(?:import .*|\}) from "([^"]+)";$/.exec(line))
    .filter(Boolean)
    .map(m => m[1])
    .sort();
  assert.deepEqual([...new Set(specifiers)], [
    "../lib/email/subscriptionStarted.ts",
    "../lib/emailSenders.ts",
    "../lib/subscriptionEmailDeliveryRules.ts",
    "../lib/subscriptionInvoiceRules.ts",
    "node:assert/strict",
    "node:fs",
    "node:path",
    "node:test",
    "node:url",
  ], "this suite imports something that can reach a database or a network");
});
