import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PAYMENT_PROBLEM_BILLING_REASON,
  RECONCILABLE_STRIPE_STATUSES,
  PAYMENT_PROBLEM_FAMILY,
  SUBSCRIPTION_EMAIL_RETRY_FAMILIES,
  SUBSCRIPTION_RETRY_BATCH_LIMIT,
  classifyPaymentProblemInvoiceOwnership,
  classifyPaymentProblemInvoiceStatus,
  classifySubscriptionEmailProviderError,
  evaluatePaymentProblemPreflight,
  isPaymentProblemInvoice,
  isReconcilableStripeStatus,
  paymentProblemEventKey,
  recipientFromCustomerSnapshot,
} from "../lib/subscriptionEmailDeliveryRules.ts";
import {
  buildPaymentProblemEmail,
  paymentProblemIdempotencyKey,
} from "../lib/email/paymentProblem.ts";
import { GLOA_FROM_HELLO, GLOA_REPLY_TO_SUPPORT } from "../lib/emailSenders.ts";

// SAFE DEFAULT SUITE: pure rule and template logic plus source-level
// checks. No server is spawned, no database is reachable, no Supabase
// client is constructed, no Stripe API is called, no invoice is created
// or failed, no Resend request is made and no email of any kind is sent.
// Nothing here executes SQL and nothing here requires TEST_SUPABASE_*.
//
// THE RULES THIS SUITE PROTECTS: a failed invoice creates no business
// output at all; the customer is warned once per failed CYCLE rather
// than once per Stripe retry attempt; the warning is never sent for an
// invoice that has since been paid; and a Stripe read failure is NOT
// confused with a Resend acceptance ambiguity.

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf-8");
const NEWLINE = String.fromCharCode(10);

const MIGRATIONS_DIR = path.join(ROOT, "supabase/migrations");

const withoutComments = source => source
  .split(NEWLINE)
  .filter(line => {
    const t = line.trim();
    return !t.startsWith("--") && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
  })
  .join(NEWLINE);

const senderCode = withoutComments(read("lib/paymentProblemEmail.ts"));
const templateCode = withoutComments(read("lib/email/paymentProblem.ts"));
const rulesCode = withoutComments(read("lib/subscriptionEmailDeliveryRules.ts"));
const statusCode = withoutComments(read("lib/subscriptionPaymentStatus.ts"));
const webhookCode = withoutComments(read("app/api/stripe/webhook/route.ts"));
const retryCode = withoutComments(read("lib/subscriptionEmailRetry.ts"));
const cronCode = withoutComments(read("app/api/cron/retry-order-notifications/route.ts"));
const sql036 = withoutComments(read("supabase/migrations/036_subscription_payment_status.sql"));

const SUBSCRIPTION_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const INVOICE_ID = "in_1ABCdefGHIjklMNO";

/** One top-level `async function NAME` body from the webhook route. */
const handlerBody = name => {
  const at = webhookCode.indexOf(`async function ${name}(`);
  assert.notEqual(at, -1, `${name} disappeared`);
  const next = webhookCode.indexOf(`${NEWLINE}async function `, at + 1);
  return webhookCode.slice(at, next === -1 ? webhookCode.length : next);
};

const failedHandler = () => handlerBody("handleInvoicePaymentFailed");

/** A subscription with a live, warnable payment problem. */
const subscription = (overrides = {}) => ({
  id: SUBSCRIPTION_ID,
  customer_type: "private",
  status: "past_due",
  customer_snapshot: { email: "kundin@example.com", name: "Mia" },
  started_at: "2026-01-09T10:00:00.000Z",
  ...overrides,
});

const eligibility = (o = {}) =>
  evaluatePaymentProblemPreflight({ subscription: subscription(o), claimed: false });
const claimed = (o = {}) =>
  evaluatePaymentProblemPreflight({ subscription: subscription(o), claimed: true });

const built = (facts = {}) =>
  buildPaymentProblemEmail({
    payment: {
      accountSubscriptionsUrl: "https://gloamatcha.com/account/subscriptions",
      ...facts,
    },
  });

/* ══════════════════════════════════════════════════════════════
   1-9. THE WEBHOOK, AND WHAT IT REFUSES TO DO
   ══════════════════════════════════════════════════════════════ */

test("1: invoice.payment_failed is handled", () => {
  assert.ok(webhookCode.includes('} else if (event.type === "invoice.payment_failed") {'));
  assert.ok(webhookCode.includes("await handleInvoicePaymentFailed(stripe, event);"));
  assert.ok(failedHandler().includes("sendPaymentProblemEmailIfNeeded("));
});

test("2, 3: only a renewal may warn; a first invoice never does", () => {
  assert.equal(PAYMENT_PROBLEM_BILLING_REASON, "subscription_cycle");
  assert.equal(isPaymentProblemInvoice("subscription_cycle"), true);
  for (const reason of [
    "subscription_create", "manual", "subscription_update", "upcoming", "", null, undefined,
  ]) {
    assert.equal(isPaymentProblemInvoice(reason), false, String(reason));
  }
  // The gate lives in the SENDER, so a second caller cannot bypass it,
  // and it refuses before any database work.
  assert.ok(senderCode.includes('if (!isPaymentProblemInvoice(billingReason)) return "not-eligible";'));
  const gateAt = senderCode.indexOf("isPaymentProblemInvoice(billingReason)");
  const claimAt = senderCode.indexOf("await claimPaymentProblem(");
  assert.ok(gateAt !== -1 && gateAt < claimAt);
});

test("4-8: a failed invoice creates no business output whatsoever", () => {
  const handler = failedHandler();
  for (const forbidden of [
    "fulfillPaidSubscriptionInvoice", "createOrderFromPaidCheckoutAttempt", "createOrder",
    "sendInternalOrderNotificationIfNeeded", "sendOrderConfirmationEmailIfNeeded",
    "sendSubscriptionStartedEmailIfNeeded", "markAttemptPaid",
    "activate_subscription_from_invoice", "record_paid_subscription_period", "recordPaidPeriod",
    "applyDeferredCancellationFromRenewal", "shipment", "refund",
  ]) {
    assert.ok(!handler.includes(forbidden), `the failed-invoice handler reaches ${forbidden}`);
  }
  // And the sender cannot either.
  for (const forbidden of [
    "orders", "checkout_attempts", "fulfillment", "record_paid", "rpc(",
  ]) {
    assert.ok(!senderCode.includes(forbidden), `the sender reaches ${forbidden}`);
  }
  // Its only table is the delivery table plus a read of subscriptions.
  const tables = [...senderCode.matchAll(/\.from\("([a-z_]+)"\)/g)].map(m => m[1]);
  assert.deepEqual([...new Set(tables)].sort(), ["subscription_email_deliveries", "subscriptions"]);
});

test("9: invoice.payment_failed writes no subscription status", () => {
  const handler = failedHandler();
  for (const forbidden of [
    "sync_subscription_payment_status", "reconcileSubscriptionPaymentStatus",
    "past_due", "unpaid", "status:",
  ]) {
    assert.ok(!handler.includes(forbidden), `the failed-invoice handler writes status: ${forbidden}`);
  }
  assert.ok(!senderCode.includes("sync_subscription_payment_status"));
  // The sender never updates public.subscriptions at all.
  assert.ok(!/from\("subscriptions"\)[\s\S]{0,160}\.update\(/.test(senderCode),
    "the sender writes to public.subscriptions");
});

/* ══════════════════════════════════════════════════════════════
   10-18. STATUS AUTHORITY
   ══════════════════════════════════════════════════════════════ */

test("10, 34: the status handler reconciles from a FRESH Stripe read", () => {
  const handler = handlerBody("handleSubscriptionUpdated");
  const retrieveAt = handler.indexOf("await stripe.subscriptions.retrieve(subscriptionId)");
  const reconcileAt = handler.indexOf("reconcileSubscriptionPaymentStatus(subscription)");
  assert.ok(retrieveAt !== -1, "the fresh Stripe read disappeared");
  assert.ok(reconcileAt !== -1, "status reconciliation is missing");
  assert.ok(retrieveAt < reconcileAt, "the status must be re-read before it is mirrored");
  // The payload's own status is never passed through.
  assert.ok(!handler.includes("event.data.object as Stripe.Subscription).status"));
});

test("11: reconciliation goes through migration 036's RPC and nothing else", () => {
  assert.ok(statusCode.includes('admin.rpc("sync_subscription_payment_status"'));
  assert.ok(statusCode.includes("p_stripe_subscription_id: subscription.id"));
  assert.ok(statusCode.includes("p_stripe_status: stripeStatus"));
  // No direct write to the table anywhere.
  assert.ok(!statusCode.includes('.from("subscriptions")'),
    "status must not be written outside the RPC");
  assert.ok(!statusCode.includes(".update("));
});

test("12: pending_no_payment_proof is a guard, not an error", () => {
  // It is in the expected-result list and does not throw.
  assert.ok(statusCode.includes('"pending_no_payment_proof"'));
  const expected = statusCode.slice(
    statusCode.indexOf("const EXPECTED_RESULTS"),
    statusCode.indexOf("]);", statusCode.indexOf("const EXPECTED_RESULTS"))
  );
  for (const ok of [
    "updated", "unchanged", "pending_no_payment_proof", "terminal",
    "ignored_local_status", "ignored_status", "not_found",
  ]) {
    assert.ok(expected.includes(`"${ok}"`), `${ok} is not treated as expected`);
  }
  assert.ok(!/\bthrow\b/.test(statusCode), "reconciliation must never throw");
  // The webhook does not treat it specially either.
  assert.ok(!handlerBody("handleSubscriptionUpdated").includes("throw"));
});

test("13-16: the full matrix among the three live states is reachable", () => {
  // The application allows exactly the three; the RPC enforces the
  // transitions and permits every pairing among them.
  assert.deepEqual([...RECONCILABLE_STRIPE_STATUSES], ["active", "past_due", "unpaid"]);
  for (const s of ["active", "past_due", "unpaid"]) {
    assert.equal(isReconcilableStripeStatus(s), true, s);
  }
  assert.ok(sql036.includes("if v_target not in ('active', 'past_due', 'unpaid') then"));
  assert.ok(sql036.includes("if v_sub.status not in ('active', 'past_due', 'unpaid') then"));
  assert.ok(sql036.includes("set status = v_target"),
    "the RPC must mirror the target rather than hardcode a sequence");
  // No dunning order is assumed, so past_due -> active and unpaid ->
  // active recovery are as reachable as the forward moves.
  for (const forbidden of ["attempt_count", "next_payment_attempt"]) {
    assert.ok(!sql036.includes(forbidden), `036 assumes a retry schedule: ${forbidden}`);
  }
});

test("17: a cancelled subscription can never recover to active", () => {
  assert.ok(sql036.includes("if v_sub.status = 'cancelled' then"));
  assert.ok(sql036.includes("'result', 'terminal'"));
  const guardAt = sql036.indexOf("if v_sub.status = 'cancelled' then");
  assert.ok(guardAt < sql036.indexOf("update public.subscriptions"));
});

test("18: unsupported Stripe statuses never reconcile", () => {
  for (const s of [
    "canceled", "incomplete", "incomplete_expired", "trialing", "paused",
    "", null, undefined, "ACTIVE", "something_new",
  ]) {
    assert.equal(isReconcilableStripeStatus(s), false, String(s));
  }
  assert.ok(statusCode.includes('if (!isReconcilableStripeStatus(stripeStatus)) return "ignored_status";'));
  // Refused before the RPC is even called.
  const gateAt = statusCode.indexOf("isReconcilableStripeStatus(stripeStatus)");
  const rpcAt = statusCode.indexOf('admin.rpc("sync_subscription_payment_status"');
  assert.ok(gateAt !== -1 && gateAt < rpcAt);
});

/* ══════════════════════════════════════════════════════════════
   19-26. EVENT IDENTITY AND THE CLAIM
   ══════════════════════════════════════════════════════════════ */

test("19, 20: the family and the event key are exact", () => {
  assert.equal(PAYMENT_PROBLEM_FAMILY, "payment_problem");
  assert.equal(paymentProblemEventKey(INVOICE_ID), INVOICE_ID);
  assert.equal(paymentProblemEventKey(`  ${INVOICE_ID} `), INVOICE_ID);
  for (const blank of ["", "   ", null, undefined]) {
    assert.equal(paymentProblemEventKey(blank), null);
  }
  // Migration 036 permits the family.
  assert.ok(sql036.includes("'payment_problem'"));
});

test("21, 22, 23: one delivery per invoice, whatever the event or attempt", () => {
  // Same invoice, any number of Stripe events or retry attempts -> one key.
  assert.equal(
    new Set([
      paymentProblemEventKey(INVOICE_ID),
      paymentProblemEventKey(INVOICE_ID),
      paymentProblemEventKey(` ${INVOICE_ID}`),
    ]).size,
    1
  );
  // A different cycle is a different invoice, so a new key.
  assert.notEqual(paymentProblemEventKey(INVOICE_ID), paymentProblemEventKey("in_OTHER"));
  // No event id, attempt count or clock reaches the key or the send.
  for (const source of [senderCode, rulesCode, templateCode]) {
    for (const forbidden of ["event.id", "eventId", "attempt_count", "attemptCount"]) {
      assert.ok(!source.includes(forbidden), `${forbidden} reaches the send decision`);
    }
  }
  // And the webhook passes the RE-READ invoice's id and billing reason.
  const handler = failedHandler();
  assert.ok(handler.includes("const invoice = await stripe.invoices.retrieve(eventInvoice.id);"));
  assert.ok(handler.includes("invoiceId: invoice.id as string,"));
  assert.ok(handler.includes("billingReason: invoice.billing_reason ?? null,"));
});

test("24, 25, 26: the first claim is atomic insert-ignore", () => {
  const claim = senderCode.slice(
    senderCode.indexOf("async function claimPaymentProblem"),
    senderCode.indexOf("async function markSent")
  );
  assert.ok(claim.includes('.from("subscription_email_deliveries")'));
  assert.ok(claim.includes(".upsert("));
  assert.ok(claim.includes('onConflict: "subscription_id,family,event_key"'));
  assert.ok(claim.includes("ignoreDuplicates: true"), "must be ON CONFLICT DO NOTHING");
  assert.ok(!claim.includes("ignoreDuplicates: false"), "never DO UPDATE");
  // The only .select is the RETURNING clause: no read-then-write.
  assert.equal((claim.match(/\.select\(/g) ?? []).length, 1);
  assert.ok(claim.indexOf(".upsert(") < claim.indexOf(".select("));
  assert.ok(!claim.includes(".maybeSingle()"));
  // A conflict is never reported as a delivery.
  assert.ok(senderCode.includes('if (claim.kind === "taken") return "already-claimed";'));
  assert.ok(!senderCode.includes('"already-sent"'));
});

/* ══════════════════════════════════════════════════════════════
   27-28. RECIPIENT
   ══════════════════════════════════════════════════════════════ */

test("27, 28: the recipient comes only from customer_snapshot.email", () => {
  assert.equal(eligibility().recipient, "kundin@example.com");
  assert.equal(recipientFromCustomerSnapshot({ email: " a@b.de " }), "a@b.de");
  assert.equal(eligibility({ customer_snapshot: {} }).kind, "not-eligible");
  assert.equal(claimed({ customer_snapshot: {} }).kind, "failed");
  assert.ok(senderCode.includes("to: preflight.recipient,"));
  // No recipient parameter anywhere in the entry point.
  const entry = senderCode.slice(senderCode.indexOf("export async function sendPaymentProblemEmailIfNeeded"));
  const signature = entry.slice(0, entry.indexOf("): Promise<"));
  for (const f of ["email", "recipient", "to:", "address"]) {
    assert.ok(!signature.includes(f), `the entry point takes a recipient: ${f}`);
  }
  // Never a Stripe or browser address.
  for (const forbidden of ["customer_email", "customer_details", "stripe.customers", "searchParams", "req.body"]) {
    assert.ok(!senderCode.includes(forbidden), `an outside address source: ${forbidden}`);
  }
  // Only a private B2C subscription qualifies.
  assert.equal(eligibility({ customer_type: "business" }).kind, "not-eligible");
  assert.equal(claimed({ customer_type: "business" }).kind, "failed");
});

/* ══════════════════════════════════════════════════════════════
   29-40. THE LIVE INVOICE RE-READ
   ══════════════════════════════════════════════════════════════ */

test("29: the invoice is re-read live, immediately before Resend", () => {
  const deliver = senderCode.slice(senderCode.indexOf("export async function deliverClaimedPaymentProblem"));
  const readAt = deliver.indexOf("await retrieveInvoice(invoiceId)");
  const resendAt = deliver.indexOf("getResendClient()");
  assert.ok(readAt !== -1, "the live invoice read is missing");
  assert.ok(resendAt !== -1);
  assert.ok(readAt < resendAt, "the invoice must be re-read before the provider");
  // The sender pulls no Stripe CLIENT at runtime: the read is injected.
  // Its only "stripe" import is type-only, which TypeScript erases, so
  // no SDK reaches the bundle from here.
  const stripeImports = senderCode
    .split(NEWLINE)
    .filter(l => l.includes('from "stripe"'));
  assert.deepEqual(stripeImports, ['import type Stripe from "stripe";'],
    "the sender gained a runtime Stripe import");
  assert.ok(!senderCode.includes("getStripeClient"), "the sender constructs a Stripe client");
  assert.ok(!senderCode.includes("stripe.invoices"), "the sender calls Stripe directly");
  assert.ok(senderCode.includes("retrieveInvoice: RetrieveInvoice"));
  // Both entry points require it - the canonical send and the retry.
  assert.ok(senderCode.includes("retrieveInvoice: RetrieveInvoice;"));
  assert.ok(senderCode.includes("retrieveInvoice: RetrieveInvoice\n)"));
});

test("30-35: every live invoice status has an explicit, safe meaning", () => {
  assert.deepEqual(classifyPaymentProblemInvoiceStatus("open"), { kind: "current" });
  for (const status of ["paid", "void", "draft", "uncollectible"]) {
    const outcome = classifyPaymentProblemInvoiceStatus(status);
    assert.equal(outcome.kind, "superseded", `${status} must supersede`);
    assert.ok(outcome.reason.length > 0);
  }
  // Anything else fails closed: never "current".
  for (const status of ["", null, undefined, "OPEN", "posted", "something_new", 7]) {
    assert.equal(classifyPaymentProblemInvoiceStatus(status).kind, "unknown", String(status));
  }
  // And the sender maps them to the right database state.
  const deliver = senderCode.slice(senderCode.indexOf("export async function deliverClaimedPaymentProblem"));
  assert.ok(deliver.includes('if (live.kind === "superseded")'));
  assert.ok(deliver.includes("await markSuperseded(deliveryId);"));
  assert.ok(deliver.includes('if (live.kind === "unknown")'));
});

test("36, 37: a terminal cancellation supersedes; a scheduled one does not", () => {
  // Final cancelled is the terminal blocker.
  assert.equal(claimed({ status: "cancelled" }).kind, "superseded");
  assert.equal(eligibility({ status: "cancelled" }).kind, "not-eligible");
  // A scheduled cancellation is NOT even visible to this preflight: the
  // cancellation columns are not read, so they cannot suppress a warning
  // about money that is genuinely still owed.
  for (const forbidden of ["cancellation_requested_at", "cancellation_effective_at", "cancel_at"]) {
    assert.ok(!senderCode.includes(forbidden), `the sender reads ${forbidden}`);
    assert.ok(!rulesCode.slice(rulesCode.indexOf("export function evaluatePaymentProblemPreflight"))
      .includes(forbidden), `the preflight reads ${forbidden}`);
  }
  // Every live payment state may warn: the two webhooks have no ordering
  // guarantee, so past_due is not required.
  for (const status of ["active", "past_due", "unpaid"]) {
    assert.equal(eligibility({ status }).kind, "send", status);
  }
  // A subscription that never started cannot have a failed renewal.
  assert.equal(eligibility({ started_at: null }).kind, "not-eligible");
  assert.equal(claimed({ started_at: null }).kind, "superseded");
});

test("38, 39, 40: a Stripe read failure is 'failed', NOT ambiguous", () => {
  // THE DISTINCTION THIS PHASE TURNS ON. A Stripe read fails BEFORE
  // Resend is contacted, so provider acceptance is impossible and the
  // row is safely retryable. That is the opposite of a Resend transport
  // failure, where the request may have landed.
  const deliver = senderCode.slice(senderCode.indexOf("export async function deliverClaimedPaymentProblem"));
  const catchAt = deliver.indexOf("} catch (err) {");
  const resendAt = deliver.indexOf("getResendClient()");
  assert.ok(catchAt !== -1 && catchAt < resendAt,
    "the invoice read's catch must sit before the provider");
  const readCatch = deliver.slice(catchAt, resendAt);
  assert.ok(readCatch.includes("await markFailed(deliveryId);"));
  assert.ok(readCatch.includes('return "failed";'));
  assert.ok(!readCatch.includes('return "ambiguous";'),
    "a Stripe read failure must not be recorded as provider ambiguity");
  // A null invoice is treated the same way.
  assert.ok(deliver.includes("if (!invoice) {"));
  // And no Resend call can be reached from either path.
  assert.ok(deliver.indexOf('return "failed";') < resendAt);
});

/* ══════════════════════════════════════════════════════════════
   41-49. THE COPY AND THE PROVIDER KEY
   ══════════════════════════════════════════════════════════════ */

test("41: the copy states the problem truthfully", () => {
  const { subject, text } = built();
  assert.equal(subject, "Deine Abo-Zahlung konnte nicht abgeschlossen werden");
  assert.ok(text.includes("Die Zahlung für dein Abo hat nicht geklappt."));
  assert.ok(text.includes("nicht abgeschlossen werden"));
  assert.ok(text.includes("noch nichts versendet"));
  assert.ok(text.includes("Melde dich einfach bei uns"));
});

test("42, 43: it promises no repair flow this product does not have", () => {
  const { subject, html, text } = built();
  for (const surface of [subject, html, text, templateCode]) {
    for (const forbidden of [
      "Zahlungsmethode aktualisieren", "Zahlungsmethode ändern", "Billing Portal",
      "billing_portal", "Jetzt bezahlen", "Jetzt erneut bezahlen", "Erneut versuchen",
      "Zahlung wiederholen", "Karte aktualisieren",
    ]) {
      assert.ok(!surface.includes(forbidden), `it promises a flow that does not exist: ${forbidden}`);
    }
  }
  // And the repository genuinely has none, which is why.
  for (const rel of ["app/AccountPortal.tsx", "lib/subscriptionCancellation.ts"]) {
    assert.ok(!read(rel).includes("billingPortal"), `${rel} gained a billing portal`);
  }
});

test("44, 45: it claims no order, no shipment and no successful payment", () => {
  const { subject, html, text } = built();
  for (const surface of [subject, html, text, templateCode]) {
    for (const forbidden of [
      "Bestellung", "versendet wurde", "unterwegs", "Sendung", "Tracking",
      "Zahlung erfolgreich", "Zahlung eingegangen", "erfolgreich bezahlt", "Danke für deine Zahlung",
    ]) {
      assert.ok(!surface.includes(forbidden), `it claims something untrue: ${forbidden}`);
    }
  }
});

test("46, 47: no monthly language, and no moving values at all", () => {
  const { subject, html, text } = built();
  for (const surface of [subject, html, text, templateCode]) {
    for (const forbidden of ["monatlich", "Monatlich", "monthly", "Monthly", "pro Monat"]) {
      assert.ok(!surface.includes(forbidden), `a four-week cycle described as monthly: ${forbidden}`);
    }
  }
  // Retry-stable by construction: no clock and no formatter anywhere in
  // the template, so nothing it prints can have moved since the claim.
  for (const forbidden of [
    "Date.now", "new Date(", "toLocaleDateString", "toLocaleString", "Intl.",
    "amount", "cents", "EUR",
  ]) {
    assert.ok(!templateCode.includes(forbidden), `the template renders a moving value: ${forbidden}`);
  }
  // The invoice id reaches the provider KEY, which is correct, and never
  // the rendered message.
  for (const surface of [subject, html, text]) {
    assert.ok(!surface.includes(INVOICE_ID), "the invoice id reached the customer");
    assert.ok(!surface.includes("in_"), "a Stripe id reached the customer");
    assert.ok(!/\d+,\d{2}/.test(surface), "an amount reached the customer");
  }
  // The build function is handed exactly one field, and it is the URL.
  const buildFn = templateCode.slice(templateCode.indexOf("export function buildPaymentProblemEmail"));
  for (const forbidden of ["invoiceId", "invoice.", "subscriptionId"]) {
    assert.ok(!buildFn.includes(forbidden), `the renderer receives ${forbidden}`);
  }
});

test("48, 49: the provider key is deterministic and invoice-specific", () => {
  const key = paymentProblemIdempotencyKey(SUBSCRIPTION_ID, INVOICE_ID);
  assert.equal(key, `gloa/payment-problem/${SUBSCRIPTION_ID}/${INVOICE_ID}`);
  assert.equal(key, paymentProblemIdempotencyKey(SUBSCRIPTION_ID, INVOICE_ID));
  // A different cycle earns a different key, so a second failure is not
  // swallowed by the provider.
  assert.notEqual(key, paymentProblemIdempotencyKey(SUBSCRIPTION_ID, "in_OTHER"));
  // Distinct from every existing namespace.
  for (const existing of [
    "gloa/internal-order/", "gloa/shipment/", "gloa/cancellation-request/",
    "gloa/cancellation-outcome/", "gloa/refund/", "gloa/subscription-started/",
    "gloa/cancellation-confirmation/", "gloa/subscription-ended/",
    "gloa/subscription-cancel/", "gloa/subscription-defer/",
  ]) {
    assert.ok(!key.startsWith(existing), `the namespace collides with ${existing}`);
  }
  assert.ok(senderCode.includes("paymentProblemIdempotencyKey(subscriptionId, invoiceId)"));
  assert.ok(senderCode.includes("{ idempotencyKey }"));
});

/* ══════════════════════════════════════════════════════════════
   50-57. THE PROVIDER OUTCOME
   ══════════════════════════════════════════════════════════════ */

test("50-55: the shared hardened classifier is reused, not reinvented", () => {
  assert.ok(senderCode.includes("outcome = classifySubscriptionEmailProviderError(sendError);"));
  // The sender never judges a status code itself.
  assert.ok(!senderCode.includes("statusCode"), "the sender reads the status itself");
  assert.ok(!senderCode.includes("409"));
  // The contract, proven against the one classifier.
  for (const code of [400, 401, 403, 404, 422, 429]) {
    assert.equal(
      classifySubscriptionEmailProviderError({ statusCode: code, message: "x" }),
      "definite_failure",
      `HTTP ${code}`
    );
  }
  for (const err of [
    { statusCode: 409, message: "conflict" },
    { statusCode: 500, message: "x" },
    { statusCode: 502, message: "x" },
    { statusCode: null, message: "Unable to fetch data. The request could not be resolved." },
    {},
    null,
  ]) {
    assert.equal(classifySubscriptionEmailProviderError(err), "ambiguous", JSON.stringify(err));
  }
  // And the sender maps them to the right state.
  const deliver = senderCode.slice(senderCode.indexOf("export async function deliverClaimedPaymentProblem"));
  const ambiguousAt = deliver.indexOf('if (outcome === "ambiguous")');
  const refusedAt = deliver.indexOf('if (outcome === "definite_failure")');
  assert.ok(ambiguousAt !== -1 && ambiguousAt < refusedAt);
  const branch = deliver.slice(ambiguousAt, refusedAt);
  assert.ok(branch.includes('return "ambiguous";'));
  for (const forbidden of ["markFailed", "markSent", "markSuperseded", ".update("]) {
    assert.ok(!branch.includes(forbidden), `an ambiguous provider outcome writes ${forbidden}`);
  }
  // A thrown Resend exception is ambiguous too.
  assert.ok(deliver.includes('outcome = "ambiguous";'));
});

test("56, 57: acceptance records sent, and a lost write stays sending", () => {
  assert.ok(senderCode.includes("async function markSent(deliveryId: string): Promise<boolean> {"));
  assert.ok(senderCode.includes('.update({ status: "sent", sent_at: new Date().toISOString() })'));
  const markSent = senderCode.slice(
    senderCode.indexOf("async function markSent"),
    senderCode.indexOf("async function markFailed")
  );
  assert.ok(!markSent.includes('.eq("status", "sending")'),
    "recording 'sent' must not be conditional after acceptance");
  const deliver = senderCode.slice(senderCode.indexOf("export async function deliverClaimedPaymentProblem"));
  const acceptedAt = deliver.indexOf("if (!(await markSent(deliveryId)))");
  assert.notEqual(acceptedAt, -1);
  const branch = deliver.slice(acceptedAt, deliver.indexOf('return "sent";', acceptedAt));
  assert.ok(branch.includes('return "ambiguous";'));
  assert.ok(!branch.includes("markFailed"));
  // mark-failed and mark-superseded keep their guards.
  assert.ok(senderCode.includes('.eq("status", "sending")'));
  assert.ok(senderCode.includes('.in("status", ["sending", "failed"])'));
});

/* ══════════════════════════════════════════════════════════════
   58-70. RETRY AND CRON
   ══════════════════════════════════════════════════════════════ */

test("58, 61, 62: payment_problem is the fourth family, with its own bucket", () => {
  assert.deepEqual([...SUBSCRIPTION_EMAIL_RETRY_FAMILIES], [
    "subscription_started", "cancellation_confirmation", "subscription_ended", "payment_problem",
  ]);
  assert.equal(SUBSCRIPTION_RETRY_BATCH_LIMIT, 25);
  assert.ok(retryCode.includes("case PAYMENT_PROBLEM_FAMILY:"));
  assert.ok(retryCode.includes("deliverClaimedPaymentProblem("));
  // The delivery row's event_key IS the invoice id the retry re-reads.
  assert.ok(retryCode.includes("row.event_key"));
  // With no Stripe client it refuses rather than sending blind.
  assert.ok(retryCode.includes('throw new Error("STRIPE_SECRET_KEY is not configured")'));
});

test("59, 60: the generic order retry engine is untouched", () => {
  const retryRules = withoutComments(read("lib/transactionalEmailRetryRules.ts"));
  const retryWiring = withoutComments(read("lib/transactionalEmailRetry.ts"));
  for (const source of [retryRules, retryWiring]) {
    for (const forbidden of [
      "payment_problem", "paymentProblem", "subscription_email_deliveries",
      "sync_subscription_payment_status",
    ]) {
      assert.ok(!source.includes(forbidden), `the order engine learned about this phase: ${forbidden}`);
    }
  }
  assert.ok(retryRules.includes("RETRY_DISABLED_FAMILIES"));
  assert.ok(retryRules.slice(retryRules.indexOf("RETRY_DISABLED_FAMILIES")).includes("orderConfirmation"),
    "orderConfirmation retry was re-enabled");
});

test("63-66: failed only; sending, sent and superseded are never selected", () => {
  const load = retryCode.slice(
    retryCode.indexOf("loadFailed: async (family, limit) =>"),
    retryCode.indexOf("claimFailed: async deliveryId =>")
  );
  assert.ok(load.includes('.eq("status", "failed")'));
  for (const forbidden of ['"sending"', '"sent"', '"superseded"', '.in("status"', ".or("]) {
    assert.ok(!load.includes(forbidden), `the work list was widened: ${forbidden}`);
  }
});

test("67, 68: stale sending stays diagnostic only for this family too", () => {
  const body = rulesCode.slice(
    rulesCode.indexOf("export async function inspectStaleSubscriptionEmailDeliveries"),
    rulesCode.indexOf("export const PAYMENT_PROBLEM_FAMILY")
  );
  assert.ok(body.length > 0);
  for (const forbidden of ["update", "upsert", "insert", "delete", "rpc"]) {
    assert.ok(!body.includes(forbidden), `the stale inspection can write: ${forbidden}`);
  }
  // The sender adds no age-based recovery either.
  for (const forbidden of ["updated_at", "STALE", "cutoff", "30 * 60"]) {
    assert.ok(!senderCode.includes(forbidden), `the sender added stale recovery: ${forbidden}`);
  }
});

test("69, 70: exactly one cron, on the unchanged schedule", () => {
  const vercel = JSON.parse(read("vercel.json"));
  assert.equal(vercel.crons.length, 1);
  assert.deepEqual(vercel.crons, [
    { path: "/api/cron/retry-order-notifications", schedule: "20 5 * * *" },
  ]);
  assert.deepEqual(readdirSync(path.join(ROOT, "app/api/cron")), ["retry-order-notifications"]);
  assert.ok(cronCode.includes("runSubscriptionEmailRetrySweep()"));
  // The cron never reaches this family's sender directly.
  assert.ok(!cronCode.includes("paymentProblemEmail"));
});

/* ══════════════════════════════════════════════════════════════
   71-78. NOTHING ELSE MOVED
   ══════════════════════════════════════════════════════════════ */

test("71: the three existing lifecycle emails are unchanged", () => {
  for (const [file, marker] of [
    ["lib/subscriptionStartedEmail.ts", "subscriptionStartedIdempotencyKey(subscriptionId)"],
    ["lib/cancellationConfirmationEmail.ts", "cancellationConfirmationIdempotencyKey(subscriptionId, eventKey)"],
    ["lib/subscriptionEndedEmail.ts", "subscriptionEndedIdempotencyKey(subscriptionId)"],
  ]) {
    const source = withoutComments(read(file));
    assert.ok(source.includes(marker), `${file} lost its provider key`);
    // None of them learned about billing.
    for (const forbidden of ["payment_problem", "invoice.payment_failed", "retrieveInvoice"]) {
      assert.ok(!source.includes(forbidden), `${file} learned about billing: ${forbidden}`);
    }
  }
});

test("72-74: no migration was added, edited or required", () => {
  const files = readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith(".sql")).sort();
  // PHASE 3J.B1 ADDED MIGRATION 037 (the invoice-keyed refund-state
  // writer), reviewed in
  // tests/subscription-refund-correlation-migration.test.mjs. THIS phase
  // still needed no migration, which is what the guard protects.
  assert.equal(files.length, 41);
  // Phase 4B1 added 039, the B2C prepaid annual plan foundation,
  // reviewed in tests/annual-plan-foundation-migration.test.mjs. The
  // guard is re-pinned, not deleted: it protects "no UNREVIEWED
  // migration appeared", never "the stack stopped growing".
  // PHASE 4B8.1 ADDED MIGRATION 041 (column-level privileges that
  // narrow the annual account read surface), reviewed in
  // tests/annual-account-privileges-migration.test.mjs. Re-pinned
  // rather than deleted: this guard protects "no UNREVIEWED migration
  // appeared", never "the stack stopped growing".
  assert.equal(files[files.length - 1], "041_annual_account_column_privileges.sql");
  assert.equal(files[files.length - 2], "040_annual_checkout_retry_fingerprints.sql");
  assert.equal(files[files.length - 3], "039_b2c_annual_plan_foundation.sql");
  assert.equal(files[files.length - 4], "038_one_time_refund_writer_concurrency.sql");
  assert.equal(files[files.length - 5], "037_subscription_refund_correlation.sql");
  assert.equal(files[files.length - 6], "036_subscription_payment_status.sql");
  assert.ok(!files.some(f => f.startsWith("042")), "an unreviewed migration appeared");
  // Everything this phase needed, 036 already grants.
  assert.ok(sql036.includes("'payment_problem'"));
  assert.ok(sql036.includes("grant execute on function public.sync_subscription_payment_status(text, text) to service_role;"));
  // The application writes no DDL.
  for (const source of [senderCode, templateCode, statusCode, rulesCode]) {
    for (const forbidden of ["create table", "alter table", "create function", "create index"]) {
      assert.ok(!source.toLowerCase().includes(forbidden), `DDL in application code: ${forbidden}`);
    }
  }
});

test("75: the refund correlation defect is untouched", () => {
  const refunds = withoutComments(read("lib/orderRefunds.ts"));
  for (const forbidden of ["payment_problem", "sync_subscription_payment_status", "subscription_email_deliveries"]) {
    assert.ok(!refunds.includes(forbidden), `refund correlation changed: ${forbidden}`);
  }
});

test("76, 77: the launch gates are unchanged", () => {
  const checkoutRules = read("lib/subscriptionCheckoutRules.ts");
  assert.ok(checkoutRules.includes('export const SUBSCRIPTION_FEATURE_FLAG = "B2C_SUBSCRIPTIONS_ENABLED"'));
  assert.ok(checkoutRules.includes('env[SUBSCRIPTION_FEATURE_FLAG] === "true"'));
  assert.ok(read("app/content.ts").includes('export const SHOP_STATUS = "prelaunch"'));
  for (const source of [senderCode, templateCode, statusCode]) {
    assert.ok(!source.includes("B2C_SUBSCRIPTIONS_ENABLED"));
  }
  // The account UI keeps its existing honest labels and gains no button.
  const rules = read("lib/subscriptionCancellationRules.ts");
  assert.ok(rules.includes('case "past_due": return "Zahlung ausstehend";'));
  assert.ok(rules.includes('case "unpaid": return "Zahlung offen";'));
});

test("78: nothing in this feature reaches a network or database in a test", () => {
  for (const [name, source] of [["template", templateCode], ["rules", rulesCode]]) {
    assert.ok(!source.includes("supabase"), `the ${name} touches the database`);
    assert.ok(!source.includes("fetch("), `the ${name} makes a network call`);
    assert.ok(!source.includes("process.env"), `the ${name} reads the environment`);
    assert.ok(!source.includes("resend"), `the ${name} reaches the provider`);
  }
  assert.ok(!/from "\.\//.test(templateCode), "the template has a relative import");
  assert.ok(!/from "\.\//.test(rulesCode), "the rules module has a relative import");

  const self = readFileSync(fileURLToPath(import.meta.url), "utf-8");
  const specifiers = self
    .split(NEWLINE)
    .map(line => /^(?:import .*|\}) from "([^"]+)";$/.exec(line))
    .filter(Boolean)
    .map(m => m[1])
    .sort();
  assert.deepEqual([...new Set(specifiers)], [
    "../lib/email/paymentProblem.ts",
    "../lib/emailSenders.ts",
    "../lib/subscriptionEmailDeliveryRules.ts",
    "node:assert/strict",
    "node:fs",
    "node:path",
    "node:test",
    "node:url",
  ], "this suite imports something that can reach a database or a network");
});

test("78b: it uses the established customer sender convention", () => {
  assert.ok(senderCode.includes("from: GLOA_FROM_HELLO,"));
  assert.ok(senderCode.includes("replyTo: GLOA_REPLY_TO_SUPPORT,"));
  assert.equal(GLOA_FROM_HELLO, "GLOA <hello@gloamatcha.com>");
  assert.equal(GLOA_REPLY_TO_SUPPORT, "support@gloamatcha.com");
  assert.ok(!senderCode.includes("GLOA_INTERNAL_ORDERS"));
  // And it never throws, so no lifecycle action can be failed by it.
  assert.ok(!/\bthrow\b/.test(senderCode), "the sender must never throw");
  assert.ok(!failedHandler().includes("throw"), "the handler must never throw");
});

/* ══════════════════════════════════════════════════════════════
   OWNERSHIP: THE LIVE INVOICE MUST BE THIS SUBSCRIPTION'S
   ══════════════════════════════════════════════════════════════

   payment_problem is the only family whose delivery row pairs a local
   subscription id with an identifier from ANOTHER system. Nothing in the
   database forces those two to belong together, and a retry starts from
   the stored pair rather than re-deriving it - so the relationship is
   re-proven from the live invoice on every send.
   ══════════════════════════════════════════════════════════════ */

const SUB_A = "sub_AAAAAAAAAAAAAA";
const SUB_B = "sub_BBBBBBBBBBBBBB";

test("3: an invoice naming exactly this subscription is owned", () => {
  assert.equal(classifyPaymentProblemInvoiceOwnership(SUB_A, SUB_A), "owned");
  // Whitespace on either side does not change identity.
  assert.equal(classifyPaymentProblemInvoiceOwnership(` ${SUB_A}`, `${SUB_A} `), "owned");
});

test("4: a DIFFERENT Stripe subscription is a mismatch", () => {
  assert.equal(classifyPaymentProblemInvoiceOwnership(SUB_A, SUB_B), "mismatch");
  assert.equal(classifyPaymentProblemInvoiceOwnership(SUB_B, SUB_A), "mismatch");
  // Case is not identity either: Stripe ids are exact.
  assert.equal(classifyPaymentProblemInvoiceOwnership(SUB_A, SUB_A.toUpperCase()), "mismatch");
});

test("5: an invoice with no subscription relationship is unrelated", () => {
  for (const none of [null, undefined, "", "   "]) {
    assert.equal(classifyPaymentProblemInvoiceOwnership(SUB_A, none), "unrelated", String(none));
  }
});

test("5b: a local row with no Stripe id can own nothing", () => {
  // Structurally unreachable - migration 022 binds the id in the same
  // statement that sets started_at, which the preflight requires - but an
  // unprovable claim must never become a send.
  for (const none of [null, undefined, "", "  "]) {
    assert.equal(classifyPaymentProblemInvoiceOwnership(none, SUB_A), "mismatch", String(none));
  }
  // And the sender reads the column, so it has a real value to compare.
  assert.ok(senderCode.includes("stripe_subscription_id"),
    "the sender must read the local Stripe subscription id");
  assert.ok(rulesCode.includes("stripe_subscription_id: string | null;"),
    "the facts type must carry it");
});

test("1, 2: BOTH paths prove ownership, from the live invoice", () => {
  const deliver = senderCode.slice(senderCode.indexOf("export async function deliverClaimedPaymentProblem"));
  // One shared path: the canonical send and the retry both end here, so
  // the check cannot exist on one and be missing on the other.
  assert.ok(senderCode.includes("return deliverClaimedPaymentProblem(subscriptionId, eventKey, claim.deliveryId, retrieveInvoice);"),
    "the canonical send must funnel into the claimed path");
  assert.ok(retryCode.includes("deliverClaimedPaymentProblem("),
    "the retry must funnel into the same claimed path");

  assert.ok(deliver.includes("classifyPaymentProblemInvoiceOwnership("));
  // Both sides come from server state, not from a caller.
  assert.ok(deliver.includes("subscriptionRow?.stripe_subscription_id ?? null"),
    "the local side must come from the durable row");
  assert.ok(deliver.includes("resolveInvoiceSubscriptionId(liveInvoice)"),
    "the invoice side must come from the LIVE invoice");
  // The proven resolver is reused rather than a second reading of
  // Stripe's invoice parent shape.
  assert.ok(senderCode.includes('import { resolveInvoiceSubscriptionId } from "./subscriptionInvoiceRules";'));
});

test("6, 7, 13, 14: a mismatch or missing relationship is TERMINAL", () => {
  const deliver = senderCode.slice(senderCode.indexOf("export async function deliverClaimedPaymentProblem"));
  const at = deliver.indexOf('if (ownership !== "owned")');
  assert.notEqual(at, -1, "the ownership guard is missing");
  const branch = deliver.slice(at, deliver.indexOf("const live = classifyPaymentProblemInvoiceStatus"));
  assert.ok(branch.includes("await markSuperseded(deliveryId);"));
  assert.ok(branch.includes('return "superseded";'));
  // NOT failed: a failed row is automatically retried, and retrying an
  // invalid pair would only re-approach the same wrong customer.
  assert.ok(!branch.includes("markFailed"), "an ownership mismatch must not become retryable");
  assert.ok(!branch.includes('return "failed";'));
  // And superseded is never selected by the sweep.
  assert.ok(retryCode.includes('.eq("status", "failed")'));
});

test("8: a sent delivery is never rewritten by the ownership guard", () => {
  const supersede = senderCode.slice(senderCode.indexOf("async function markSuperseded"));
  assert.ok(supersede.includes('.in("status", ["sending", "failed"])'),
    "sent -> superseded must remain impossible");
});

test("9, 10: no recipient can come from the mismatching invoice", () => {
  const deliver = senderCode.slice(senderCode.indexOf("export async function deliverClaimedPaymentProblem"));
  // The guard runs strictly before the provider is even constructed.
  const ownershipAt = deliver.indexOf("classifyPaymentProblemInvoiceOwnership(");
  const resendAt = deliver.indexOf("getResendClient()");
  const sendAt = deliver.indexOf("resend.emails.send(");
  assert.ok(ownershipAt !== -1 && ownershipAt < resendAt && resendAt < sendAt,
    "ownership must be proven before the provider is reached");
  // The recipient still comes only from the LOCAL frozen snapshot, so
  // even a mismatching invoice could not redirect a message.
  assert.ok(senderCode.includes("to: preflight.recipient,"));
  for (const forbidden of [
    "liveInvoice.customer_email", "invoice.customer_email", "liveInvoice.customer",
    "customer_email", "customer_details",
  ]) {
    assert.ok(!senderCode.includes(forbidden), `an address from the invoice: ${forbidden}`);
  }
  // The mismatch log names neither subscription and no customer fact.
  const branch = deliver.slice(deliver.indexOf('if (ownership !== "owned")'),
    deliver.indexOf("const live = classifyPaymentProblemInvoiceStatus"));
  for (const forbidden of ["subscriptionId", "stripe_subscription_id", "recipient", "customer"]) {
    assert.ok(!branch.includes(forbidden), `the mismatch log leaks ${forbidden}`);
  }
});

test("11, 12: a Stripe READ failure is still failed, and still retryable", () => {
  // Unchanged by this phase, and deliberately different from a mismatch:
  // the read failing means Resend was never contacted, so nothing can
  // have been accepted and a later attempt is safe.
  const deliver = senderCode.slice(senderCode.indexOf("export async function deliverClaimedPaymentProblem"));
  const catchAt = deliver.indexOf("} catch (err) {");
  const ownershipAt = deliver.indexOf("classifyPaymentProblemInvoiceOwnership(");
  assert.ok(catchAt !== -1 && catchAt < ownershipAt,
    "the read's catch must precede the ownership check");
  const readCatch = deliver.slice(catchAt, ownershipAt);
  assert.ok(readCatch.includes("await markFailed(deliveryId);"));
  assert.ok(readCatch.includes('return "failed";'));
  assert.ok(!readCatch.includes("markSuperseded"),
    "a read failure must not be confused with an invalid relationship");
});

test("15, 16, 17: the event key, provider key and copy are unchanged", () => {
  assert.equal(paymentProblemEventKey(INVOICE_ID), INVOICE_ID);
  assert.equal(
    paymentProblemIdempotencyKey(SUBSCRIPTION_ID, INVOICE_ID),
    `gloa/payment-problem/${SUBSCRIPTION_ID}/${INVOICE_ID}`
  );
  assert.equal(built().subject, "Deine Abo-Zahlung konnte nicht abgeschlossen werden");
  // The template learned nothing about ownership.
  for (const forbidden of ["ownership", "stripe_subscription_id", "mismatch"]) {
    assert.ok(!templateCode.includes(forbidden), `the template changed: ${forbidden}`);
  }
});

test("18, 19, 20: retry selection, family fairness and 3H families unchanged", () => {
  const load = retryCode.slice(
    retryCode.indexOf("loadFailed: async (family, limit) =>"),
    retryCode.indexOf("claimFailed: async deliveryId =>")
  );
  assert.ok(load.includes('.eq("status", "failed")'));
  for (const forbidden of ['"sending"', '.in("status"']) {
    assert.ok(!load.includes(forbidden), `the work list was widened: ${forbidden}`);
  }
  assert.equal(SUBSCRIPTION_EMAIL_RETRY_FAMILIES.length, 4);
  assert.equal(SUBSCRIPTION_RETRY_BATCH_LIMIT, 25);
  // The three Phase 3H senders gained nothing from this phase.
  for (const file of [
    "lib/subscriptionStartedEmail.ts",
    "lib/cancellationConfirmationEmail.ts",
    "lib/subscriptionEndedEmail.ts",
  ]) {
    const source = withoutComments(read(file));
    for (const forbidden of [
      "classifyPaymentProblemInvoiceOwnership", "resolveInvoiceSubscriptionId", "retrieveInvoice",
    ]) {
      assert.ok(!source.includes(forbidden), `${file} changed: ${forbidden}`);
    }
  }
});

test("21, 22, 23: no migration was added, edited or required", () => {
  const files = readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith(".sql")).sort();
  // PHASE 3J.B1 ADDED MIGRATION 037 (the invoice-keyed refund-state
  // writer), reviewed in
  // tests/subscription-refund-correlation-migration.test.mjs. THIS phase
  // still needed no migration, which is what the guard protects.
  assert.equal(files.length, 41);
  // Phase 4B1 added 039, the B2C prepaid annual plan foundation,
  // reviewed in tests/annual-plan-foundation-migration.test.mjs. The
  // guard is re-pinned, not deleted: it protects "no UNREVIEWED
  // migration appeared", never "the stack stopped growing".
  assert.equal(files[files.length - 1], "041_annual_account_column_privileges.sql");
  assert.equal(files[files.length - 2], "040_annual_checkout_retry_fingerprints.sql");
  assert.equal(files[files.length - 3], "039_b2c_annual_plan_foundation.sql");
  assert.equal(files[files.length - 4], "038_one_time_refund_writer_concurrency.sql");
  assert.equal(files[files.length - 5], "037_subscription_refund_correlation.sql");
  assert.equal(files[files.length - 6], "036_subscription_payment_status.sql");
  assert.ok(!files.some(f => f.startsWith("042")), "an unreviewed migration appeared");
  // The guard needs no schema: stripe_subscription_id is migration 022's
  // column, and 022 is the single statement that binds it - which is why
  // it is the authoritative side of the ownership comparison.
  const sql022 = read("supabase/migrations/022_recurring_subscription_foundation.sql");
  assert.ok(sql022.includes("stripe_subscription_id"),
    "the column the guard reads must predate this phase");
  assert.ok(sql022.includes("coalesce(v_subscription.stripe_subscription_id, p_stripe_subscription_id)"),
    "022 must still bind the Stripe id exactly once");
});
