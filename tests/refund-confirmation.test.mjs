import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  REFUND_EMAIL_STATUSES,
  SETTLED_REFUND_PAYMENT_STATUSES,
  hasSettledRefund,
  isNewSettledRefundFact,
  isNewerThanNotified,
  isRefundEmailClaimable,
  isRefundEmailOwed,
  isRefundEmailSweepEligible,
  refundKind,
} from "../lib/refundConfirmationRules.ts";
import {
  buildRefundConfirmationEmail,
  refundConfirmationIdempotencyKey,
} from "../lib/email/refundConfirmation.ts";
import { cancellationOutcomeIdempotencyKey } from "../lib/email/cancellationOutcome.ts";
import { cancellationRequestNotificationIdempotencyKey } from "../lib/email/cancellationRequestNotification.ts";
import { internalOrderNotificationIdempotencyKey } from "../lib/email/internalOrderNotification.ts";
import { shipmentConfirmationIdempotencyKey } from "../lib/email/shipmentConfirmation.ts";
import { GLOA_FROM_HELLO, GLOA_REPLY_TO_SUPPORT } from "../lib/emailSenders.ts";
import { summarizeStripeRefunds } from "../lib/stripeRefunds.ts";

// SAFE DEFAULT SUITE: pure rule and template logic plus source-level
// checks. No server is spawned, no database is reachable, no Stripe API
// is called, no refund is created, no order is touched and no email of
// any kind is sent. Nothing here executes SQL.
//
// The rules this suite protects: a customer hears about money going back
// exactly once per genuinely larger settled total, never about a refund
// that is only pending or that failed, never about a refund that settled
// before this feature existed, and never with an invented bank timing,
// destination or reason.

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf-8");
const NEWLINE = String.fromCharCode(10);

const MIGRATIONS = path.join(ROOT, "supabase/migrations");
const webhook = read("app/api/stripe/webhook/route.ts");
const sender = read("lib/refundConfirmationEmail.ts");
const rules = read("lib/refundConfirmationRules.ts");
const template = read("lib/email/refundConfirmation.ts");
const sync = read("lib/orderRefunds.ts");
const migration033 = read("supabase/migrations/033_refund_confirmation_email_state.sql");

const withoutComments = source => source
  .split(NEWLINE)
  .filter(line => {
    const t = line.trim();
    return !t.startsWith("--") && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
  })
  .join(NEWLINE);

const webhookCode = withoutComments(webhook);
const senderCode = withoutComments(sender);
const senderEntry = senderCode.slice(senderCode.indexOf("export async function sendRefundConfirmationIfNeeded"));
const rulesCode = withoutComments(rules);
const templateCode = withoutComments(template);
const syncCode = withoutComments(sync);
const sql033 = withoutComments(migration033);

const ORDER_ID = "11111111-2222-3333-4444-555555555555";
const ORDER_NUMBER = "GLOA-2026-000451";
const TOTAL = 4990;

/** A complete refund-email order state, for the rule assertions. */
const order = (overrides = {}) => ({
  payment_status: "partially_refunded",
  refunded_total_cents: 1000,
  refund_email_notified_total_cents: null,
  refund_email_status: null,
  ...overrides,
});

const built = (kind, overrides = {}) =>
  buildRefundConfirmationEmail({
    order: {
      order_number: ORDER_NUMBER,
      kind,
      refundedTotalCents: kind === "full" ? TOTAL : 1000,
      originalTotalGrossCents: TOTAL,
      currency: "EUR",
      accountOrderUrl: null,
      ...overrides,
    },
  });

/* ══════════════════════════════════════════════════════════════
   THE MULTIPLE REFUND MODEL - WHY A FLAG WOULD NOT DO
   ══════════════════════════════════════════════════════════════ */

test("model: Stripe genuinely allows several settled refunds on one order", () => {
  // The audit finding this whole design rests on. If this ever became
  // false, a simple sent/failed pair would be sufficient again.
  const two = summarizeStripeRefunds(
    [
      { amount: 1000, currency: "eur", status: "succeeded" },
      { amount: 1500, currency: "eur", status: "succeeded" },
    ],
    "EUR"
  );
  assert.equal(two.ok, true);
  assert.equal(two.refundedTotalCents, 2500, "settled refunds are not summed cumulatively");
  // And the total is ABSOLUTE, so re-reading the same list is stable.
  const again = summarizeStripeRefunds(
    [
      { amount: 1000, currency: "eur", status: "succeeded" },
      { amount: 1500, currency: "eur", status: "succeeded" },
    ],
    "EUR"
  );
  assert.equal(again.refundedTotalCents, two.refundedTotalCents);
});

test("model: the full lifecycle paid -> partial -> larger partial -> full is expressible", () => {
  const steps = [
    { refunded_total_cents: null, payment_status: "paid" },
    { refunded_total_cents: 1000, payment_status: "partially_refunded" },
    { refunded_total_cents: 2500, payment_status: "partially_refunded" },
    { refunded_total_cents: TOTAL, payment_status: "refunded" },
  ];
  // Walking the watermark forward yields exactly three emails: one per
  // genuinely larger settled total, and none for the paid step.
  let notified = null;
  const sent = [];
  for (const step of steps) {
    const row = order({ ...step, refund_email_notified_total_cents: notified, refund_email_status: notified === null ? null : "sent" });
    if (isRefundEmailOwed(row)) {
      sent.push(row.refunded_total_cents);
      notified = row.refunded_total_cents;
    }
  }
  assert.deepEqual(sent, [1000, 2500, TOTAL]);
});

/* ══════════════════════════════════════════════════════════════
   ELIGIBILITY: SETTLED MONEY ONLY
   ══════════════════════════════════════════════════════════════ */

test("eligibility: a plain paid order is never owed a refund email", () => {
  assert.equal(hasSettledRefund(order({ payment_status: "paid", refunded_total_cents: null })), false);
  assert.equal(isRefundEmailOwed(order({ payment_status: "paid", refunded_total_cents: null })), false);
  // Even with a stale zero total.
  assert.equal(isRefundEmailOwed(order({ payment_status: "paid", refunded_total_cents: 0 })), false);
});

test("eligibility: refund_pending never sends - nothing has settled", () => {
  // apply_order_refund_state writes refunded_total_cents = 0 for a
  // pending refund, deliberately. Telling a customer their money is back
  // at that point would be a lie a later failure would have to retract.
  assert.equal(hasSettledRefund(order({ payment_status: "refund_pending", refunded_total_cents: 0 })), false);
  assert.equal(isRefundEmailOwed(order({ payment_status: "refund_pending", refunded_total_cents: 0 })), false);
  // And not even if a total somehow accompanied it.
  assert.equal(isRefundEmailOwed(order({ payment_status: "refund_pending", refunded_total_cents: 1000 })), false);
});

test("eligibility: a FAILED or CANCELLED refund never sends", () => {
  // Both self-heal the order back to 'paid' with a zero total - see
  // lib/stripeRefunds.ts DEAD_STATUSES and migration 019.
  const healed = summarizeStripeRefunds(
    [
      { amount: 1000, currency: "eur", status: "failed" },
      { amount: 1000, currency: "eur", status: "canceled" },
    ],
    "EUR"
  );
  assert.equal(healed.ok, true);
  assert.equal(healed.refundedTotalCents, 0, "a dead refund counted toward the total");
  assert.equal(healed.hasPendingRefund, false);
  assert.equal(isRefundEmailOwed(order({ payment_status: "paid", refunded_total_cents: 0 })), false);
});

test("eligibility: only partially_refunded and refunded are settled states", () => {
  assert.deepEqual([...SETTLED_REFUND_PAYMENT_STATUSES], ["partially_refunded", "refunded"]);
  for (const never of ["paid", "pending", "failed", "refund_pending"]) {
    assert.equal(hasSettledRefund(order({ payment_status: never, refunded_total_cents: 1000 })), false, never);
  }
  // And every value named exists in migration 019's vocabulary.
  const migration019 = read("supabase/migrations/019_order_lifecycle_tracking.sql");
  for (const value of ["partially_refunded", "refunded", "refund_pending", "paid", "pending", "failed"]) {
    assert.ok(migration019.includes(`'${value}'`), `invented payment status: ${value}`);
  }
});

test("eligibility: a settled partial refund is owed", () => {
  assert.equal(isRefundEmailOwed(order({ payment_status: "partially_refunded", refunded_total_cents: 1000 })), true);
});

test("eligibility: a settled full refund is owed", () => {
  assert.equal(isRefundEmailOwed(order({ payment_status: "refunded", refunded_total_cents: TOTAL })), true);
});

test("eligibility: a zero or malformed total is never owed", () => {
  for (const bad of [0, -1, null, undefined, 1.5, NaN, "1000"]) {
    assert.equal(
      isRefundEmailOwed(order({ payment_status: "refunded", refunded_total_cents: bad })),
      false,
      String(bad)
    );
  }
});

/* ══════════════════════════════════════════════════════════════
   THE WATERMARK
   ══════════════════════════════════════════════════════════════ */

test("watermark: a duplicate of the same total sends nothing", () => {
  assert.equal(isNewerThanNotified(1000, 1000), false);
  assert.equal(isRefundEmailOwed(order({
    refunded_total_cents: 1000,
    refund_email_notified_total_cents: 1000,
    refund_email_status: "sent",
  })), false);
});

test("watermark: a genuinely larger total re-opens the order for one more email", () => {
  assert.equal(isNewerThanNotified(2500, 1000), true);
  assert.equal(isRefundEmailOwed(order({
    refunded_total_cents: 2500,
    refund_email_notified_total_cents: 1000,
    refund_email_status: "sent",
  })), true, "a second, larger refund was swallowed");
});

test("watermark: FULL AFTER PARTIAL sends the full-refund email", () => {
  assert.equal(isRefundEmailOwed(order({
    payment_status: "refunded",
    refunded_total_cents: TOTAL,
    refund_email_notified_total_cents: 2500,
    refund_email_status: "sent",
  })), true);
  assert.equal(refundKind(TOTAL, TOTAL), "full");
});

test("watermark: a first refund with no watermark is owed", () => {
  assert.equal(isNewerThanNotified(1000, null), true);
  assert.equal(isNewerThanNotified(1000, undefined), true);
  assert.equal(isNewerThanNotified(0, null), false, "a zero total is not something to announce");
});

test("watermark: a total that went DOWN is not announced", () => {
  // Settled refunds do not un-settle, so this means a reconciliation
  // oddity. Silence is the right answer, never an email retracting money.
  assert.equal(isNewerThanNotified(1000, 2500), false);
  assert.equal(isRefundEmailOwed(order({
    refunded_total_cents: 1000,
    refund_email_notified_total_cents: 2500,
    refund_email_status: "sent",
  })), false);
});

test("watermark: a failed send leaves the same total still owed", () => {
  assert.equal(isRefundEmailOwed(order({
    refunded_total_cents: 1000,
    refund_email_notified_total_cents: null,
    refund_email_status: "failed",
  })), true, "a failed send swallowed the fact");
});

/* ══════════════════════════════════════════════════════════════
   THE CLAIM
   ══════════════════════════════════════════════════════════════ */

test("claim: the vocabulary is exactly sending, sent, failed", () => {
  assert.deepEqual([...REFUND_EMAIL_STATUSES], ["sending", "sent", "failed"]);
  assert.ok(!REFUND_EMAIL_STATUSES.includes("pending"));
});

test("claim: 'sent' IS claimable here, unlike every other GLOA email", () => {
  // The watermark, not the status, is what stops a duplicate. This is the
  // one place in the codebase where a delivered message does not close
  // the order to further sends.
  assert.equal(isRefundEmailClaimable("sent"), true);
  assert.equal(isRefundEmailClaimable("failed"), true);
  assert.equal(isRefundEmailClaimable(null), true);
  assert.equal(isRefundEmailClaimable(undefined), true);
});

test("claim: 'sending' is never claimable - no competing send", () => {
  assert.equal(isRefundEmailClaimable("sending"), false);
  assert.equal(isRefundEmailOwed(order({ refund_email_status: "sending" })), false);
});

test("claim: an unrecognised status is refused", () => {
  for (const bad of ["pending", "queued", "", "SENT", "x"]) {
    assert.equal(isRefundEmailClaimable(bad), false, bad);
  }
});

test("claim: THE SWEEP RULE is strictly narrower - failed and nothing else", () => {
  assert.equal(isRefundEmailSweepEligible("failed"), true);
  for (const never of [null, undefined, "sending", "sent", "pending", ""]) {
    assert.equal(isRefundEmailSweepEligible(never), false, String(never));
  }
  // NULL and 'sent' are both claimable LIVE but never by a sweep. That
  // asymmetry is what keeps historical refunds out of a future cron.
  assert.equal(isRefundEmailClaimable(null), true);
  assert.equal(isRefundEmailSweepEligible(null), false);
  assert.equal(isRefundEmailClaimable("sent"), true);
  assert.equal(isRefundEmailSweepEligible("sent"), false);
});

test("claim: the SQL claim repeats every half of the rule", () => {
  const claim = senderCode.slice(senderCode.indexOf("async function claimRefundEmail"));
  const body = claim.slice(0, claim.indexOf("return (data?.length"));
  assert.ok(body.includes('.update({ refund_email_status: "sending" })'));
  assert.ok(body.includes('.eq("id", orderId)'));
  // Settled money only.
  assert.ok(body.includes('.in("payment_status", ["partially_refunded", "refunded"])'));
  // Pinned to the exact total being announced, so a concurrently updated
  // total can never be described by a stale message.
  assert.ok(body.includes('.eq("refunded_total_cents", refundedTotalCents)'));
  // 'sending' excluded; null / sent / failed allowed.
  assert.ok(body.includes("refund_email_status.is.null"));
  assert.ok(body.includes("refund_email_status.eq.sent"));
  assert.ok(body.includes("refund_email_status.eq.failed"));
  assert.ok(!body.includes("refund_email_status.eq.sending"));
  assert.equal([...body.matchAll(/\.update\(/g)].length, 1);
});

test("claim: mark-sent advances the watermark in the SAME statement", () => {
  // A 'sent' row with a stale watermark would be instantly eligible again
  // and would duplicate the email, so the two writes must be atomic.
  const markSent = senderCode.slice(senderCode.indexOf("async function markSent"));
  const body = markSent.slice(0, markSent.indexOf("async function markFailed"));
  const updates = [...body.matchAll(/\.update\(\{([\s\S]*?)\}\)/g)].map(m => m[1]);
  assert.equal(updates.length, 1, "mark-sent performs more than one write");
  const keys = [...updates[0].matchAll(/(\w+):/g)].map(m => m[1]);
  assert.deepEqual(keys.sort(), [
    "refund_email_notified_total_cents", "refund_email_sent_at", "refund_email_status",
  ]);
  assert.ok(!body.includes('.eq("refund_email_status"'), "mark-sent is conditional");
});

test("claim: mark-failed does NOT touch the watermark and is conditional", () => {
  const markFailed = senderCode.slice(senderCode.indexOf("async function markFailed"));
  const body = markFailed.slice(0, markFailed.indexOf("function recipientFromSnapshot"));
  assert.ok(body.includes('refund_email_status: "failed"'));
  assert.ok(!body.includes("notified_total_cents"), "mark-failed moved the watermark");
  assert.ok(!body.includes("sent_at"), "mark-failed stamped a sent timestamp");
  assert.ok(body.includes('.eq("refund_email_status", "sending")'));
});

test("claim: the sender writes only migration 033's three columns", () => {
  const updates = [...senderCode.matchAll(/\.update\(\{([\s\S]*?)\}\)/g)].map(m => m[1]);
  assert.ok(updates.length >= 3);
  for (const payload of updates) {
    for (const key of [...payload.matchAll(/(\w+):/g)].map(m => m[1])) {
      assert.ok(
        ["refund_email_status", "refund_email_sent_at", "refund_email_notified_total_cents"].includes(key),
        `the sender writes ${key}`
      );
    }
  }
});

test("claim: THE SENDER NEVER WRITES REFUND OR LIFECYCLE STATE", () => {
  const updates = [...senderCode.matchAll(/\.update\(\{([\s\S]*?)\}\)/g)].map(m => m[1]).join(" ");
  const stripped = updates
    .split("refund_email_notified_total_cents").join("")
    .split("refund_email_sent_at").join("")
    .split("refund_email_status").join("");
  for (const forbidden of [
    "payment_status", "refunded_total_cents", "refund_updated_at",
    "status", "fulfillment_status", "cancelled_at", "shipped_at",
  ]) {
    assert.ok(!stripped.includes(forbidden), `the sender writes ${forbidden}`);
  }
  for (const forbidden of [".rpc(", ".insert(", ".delete(", ".upsert("]) {
    assert.ok(!senderCode.includes(forbidden), `the sender performs: ${forbidden}`);
  }
});

test("claim: the sender never throws for an ordinary outcome", () => {
  assert.ok(!senderCode.includes("throw"), "the sender throws");
  const outcomes = [...senderEntry.matchAll(/return "([a-z-]+)"/g)].map(m => m[1]);
  assert.ok(outcomes.length >= 3);
  for (const outcome of outcomes) {
    assert.ok(["sent", "already-sent", "not-eligible", "failed"].includes(outcome), outcome);
  }
});

/* ══════════════════════════════════════════════════════════════
   HISTORICAL REFUND SAFETY
   ══════════════════════════════════════════════════════════════ */

test("historical: only an 'applied' sync result may lead to an email", () => {
  assert.equal(isNewSettledRefundFact("applied"), true);
  for (const never of [
    "unchanged", "not_applicable", "order_not_found", "ambiguous_payment_intent",
    "invalid_amount", "invalid_input", "unknown", "", "APPLIED",
  ]) {
    assert.equal(isNewSettledRefundFact(never), false, never);
  }
  // Both values genuinely come from migration 019.
  const migration019 = read("supabase/migrations/019_order_lifecycle_tracking.sql");
  assert.ok(migration019.includes("return 'applied';"));
  assert.ok(migration019.includes("return 'unchanged';"));
});

test("historical: the webhook gates the send on that result", () => {
  assert.ok(webhookCode.includes("isNewSettledRefundFact(outcome.result)"));
  const guard = webhookCode.indexOf("isNewSettledRefundFact(outcome.result)");
  const send = webhookCode.indexOf("sendRefundConfirmationIfNeeded(outcome.orderId)");
  assert.ok(guard > -1 && send > -1);
  assert.ok(guard < send, "the send is reached without the new-fact guard");
  assert.ok(webhookCode.includes("!isNewSettledRefundFact(outcome.result) || !outcome.orderId) return"));
});

test("historical: nothing enumerates orders - there is no sweep and no cron", () => {
  const vercel = JSON.parse(read("vercel.json"));
  assert.equal((vercel.crons ?? []).length, 1, "a cron job was added");
  assert.equal(vercel.crons[0].path, "/api/cron/retry-order-notifications");
  const cron = withoutComments(read("app/api/cron/retry-order-notifications/route.ts"));
  assert.ok(!cron.includes("refund"), "the cron now sweeps refunds");
  assert.ok(!withoutComments(read("lib/internalOrderNotificationRetry.ts")).includes("refund_email"));
  // And the sender is only reachable from one place.
  const callers = [];
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      if (withoutComments(readFileSync(full, "utf-8")).includes("sendRefundConfirmationIfNeeded")) {
        callers.push(path.relative(ROOT, full).split(path.sep).join("/"));
      }
    }
  };
  walk(path.join(ROOT, "app"));
  walk(path.join(ROOT, "lib"));
  assert.deepEqual(callers.sort(), [
    "app/api/stripe/webhook/route.ts",
    "lib/refundConfirmationEmail.ts",
  ]);
});

test("historical: NULL is never used as a sweep criterion in 033", () => {
  assert.ok(!sql033.includes("'pending'"), "033 introduces a pending state");
  assert.ok(!/default\s+'/i.test(sql033), "033 gives a column a literal default");
  assert.ok(!/default\s+\d/i.test(sql033), "033 gives a column a numeric default");
});

/* ══════════════════════════════════════════════════════════════
   MIGRATION 033
   ══════════════════════════════════════════════════════════════ */

test("033: it is the next free number and 022-032 are untouched", () => {
  const files = readdirSync(MIGRATIONS).filter(f => f.endsWith(".sql")).sort();
  const numbers = files.map(f => f.slice(0, 3));
  assert.equal(new Set(numbers).size, numbers.length, "a migration number is used twice");
  assert.deepEqual(files.filter(f => f.startsWith("033")), ["033_refund_confirmation_email_state.sql"]);
  assert.equal(numbers.filter(nr => nr > "033").length, 0, "a migration above 033 appeared");
  assert.deepEqual(files.slice(-12, -1), [
    "022_recurring_subscription_foundation.sql",
    "023_harden_stripe_customers_grants.sql",
    "024_seed_b2c_subscription_plans.sql",
    "025_grant_subscription_plans_service_role.sql",
    "026_internal_order_notification_state.sql",
    "027_shipment_confirmation_email_state.sql",
    "028_authorized_shipment_transition.sql",
    "029_authorized_order_cancellation.sql",
    "030_cancellation_request_notification_state.sql",
    "031_cancellation_request_resolution.sql",
    "032_open_cancellation_request_shipment_guard.sql",
  ]);
});

test("033: migration 019's refund model is not redefined", () => {
  for (const owned of [
    "apply_order_refund_state", "orders_payment_status_check",
    "orders_refunded_total_cents_range_check", "refunded_total_cents integer",
  ]) {
    assert.ok(!sql033.includes(owned), `033 touches ${owned}`);
  }
  const migration019 = read("supabase/migrations/019_order_lifecycle_tracking.sql");
  assert.ok(migration019.includes("create or replace function public.apply_order_refund_state("));
  assert.ok(migration019.includes("'refund_pending', 'partially_refunded', 'refunded'"));
});

test("033: it redefines no function from 028 through 032", () => {
  for (const owned of [
    "create or replace function public.mark_order_shipped",
    "create or replace function public.cancel_order",
    "create or replace function public.resolve_order_cancellation_request",
    "cancellation_request_open",
  ]) {
    assert.ok(!sql033.includes(owned), `033 touches ${owned}`);
  }
  const m032 = read("supabase/migrations/032_open_cancellation_request_shipment_guard.sql");
  assert.ok(m032.includes("'result', 'cancellation_request_open',"));
});

test("033: exactly three columns, all nullable, none with a default", () => {
  const adds = [...sql033.matchAll(/add column(?: if not exists)? (\w+)/g)].map(m => m[1]);
  assert.deepEqual(adds.sort(), [
    "refund_email_notified_total_cents", "refund_email_sent_at", "refund_email_status",
  ]);
  const alters = [...sql033.matchAll(/alter table public\.orders\n([\s\S]*?);/g)].map(m => m[1]);
  for (const statement of alters.filter(s => s.includes("add column"))) {
    assert.ok(!/\bdefault\b/i.test(statement), "a column has a default");
    assert.ok(!/not null/i.test(statement), "a column is NOT NULL");
  }
  assert.ok(sql033.includes("refund_email_notified_total_cents integer"), "the watermark is not an integer");
});

test("033: the status constraint allows exactly sending, sent, failed", () => {
  assert.ok(sql033.includes("check (refund_email_status in ('sending', 'sent', 'failed'))"));
  const check = sql033.slice(sql033.indexOf("check (refund_email_status"));
  const values = [...check.slice(0, 90).matchAll(/'(\w+)'/g)].map(m => m[1]);
  assert.deepEqual(values, ["sending", "sent", "failed"]);
});

test("033: the watermark is bounded, mirroring 019's refund range check", () => {
  assert.ok(sql033.includes("orders_refund_email_notified_total_range_check"));
  assert.ok(sql033.includes("refund_email_notified_total_cents >= 0"));
  assert.ok(sql033.includes("refund_email_notified_total_cents <= total_gross_cents"));
  assert.ok(sql033.includes("drop constraint if exists orders_refund_email_notified_total_range_check"));
});

test("033: only the three email columns get a column-scoped UPDATE grant", () => {
  const grants = sql033.split(NEWLINE).filter(l => l.trim().toLowerCase().startsWith("grant"));
  assert.equal(grants.length, 1, "more than one grant was issued");
  const grant = sql033.slice(sql033.indexOf("grant update"));
  const clause = grant.slice(0, grant.indexOf(";")).replace(/\s+/g, " ");
  assert.ok(clause.includes(
    "grant update (refund_email_status, refund_email_sent_at, refund_email_notified_total_cents)"
  ), `unexpected grant: ${clause}`);
  assert.ok(clause.includes("on public.orders to service_role"));
  // The refund money columns are NOT granted. That is the property that
  // matters most for this feature.
  const stripped = clause
    .split("refund_email_notified_total_cents").join("")
    .split("refund_email_sent_at").join("")
    .split("refund_email_status").join("");
  for (const forbidden of [
    "payment_status", "refunded_total_cents", "refund_updated_at",
    "fulfillment_status", "cancelled_at", "snapshot", "tracking",
  ]) {
    assert.ok(!stripped.includes(forbidden), `033 grants ${forbidden}`);
  }
  assert.ok(!/grant[^;(]*update[^;(]*on\s+(table\s+)?public\.orders/i.test(sql033),
    "033 grants table-level UPDATE");
  assert.ok(!/to (anon|authenticated|public)\b/i.test(sql033), "033 grants a browser role something");
});

test("033: no function, trigger, policy, index, backfill or database mail", () => {
  for (const forbidden of [
    "create or replace function", "create trigger", "create policy", "create index",
    "insert into", "update public.orders", "delete from", "truncate",
    "drop table", "drop column", "alter column",
    "notify", "http_post", "net.http", "resend", "smtp", "stripe",
  ]) {
    assert.ok(!sql033.toLowerCase().includes(forbidden), `033 performs: ${forbidden}`);
  }
});

test("033: the OWNER verification queries cover A through K", () => {
  for (const marker of [
    "-- (A)", "-- (D)", "-- (E)", "-- (F)", "-- (G)", "-- (H)", "-- (I)", "-- (J)", "-- (K)",
  ]) {
    assert.ok(migration033.includes(marker), `verification ${marker} is missing`);
  }
  assert.ok(migration033.includes("column_privileges"), "no UPDATE-grant verification");
  assert.ok(migration033.includes("pg_trigger"), "no trigger verification");
  assert.ok(migration033.includes("settled_refunds"), "no historical-refund count");
  assert.ok(migration033.includes("sweep_eligible"), "no sweep verification");
  assert.ok(migration033.includes("broken_watermarks"), "no watermark invariant verification");
  assert.ok(migration033.includes("shipment_guard_present"), "no 032 verification");
});

/* ══════════════════════════════════════════════════════════════
   IDEMPOTENCY KEY
   ══════════════════════════════════════════════════════════════ */

test("idempotency: the key carries the order AND the cumulative total", () => {
  assert.equal(refundConfirmationIdempotencyKey(ORDER_ID, 1000), `gloa/refund/${ORDER_ID}/1000`);
  // Same fact, same key - so a retry cannot become a second email.
  assert.equal(
    refundConfirmationIdempotencyKey(ORDER_ID, 1000),
    refundConfirmationIdempotencyKey(ORDER_ID, 1000)
  );
  // Materially different fact, different key - so a larger refund is
  // genuinely a new message rather than one Resend swallows.
  assert.notEqual(
    refundConfirmationIdempotencyKey(ORDER_ID, 1000),
    refundConfirmationIdempotencyKey(ORDER_ID, 2500)
  );
  assert.notEqual(
    refundConfirmationIdempotencyKey(ORDER_ID, 1000),
    refundConfirmationIdempotencyKey("99999999-8888-7777-6666-555555555555", 1000)
  );
});

test("idempotency: an order-id-only key would have been insufficient", () => {
  // The assertion that documents why this key differs from the other
  // four. Three distinct facts, three distinct keys.
  const keys = [1000, 2500, TOTAL].map(cents => refundConfirmationIdempotencyKey(ORDER_ID, cents));
  assert.equal(new Set(keys).size, 3, "two distinct refund totals share a key");
});

test("idempotency: the key carries no PII and no volatile input", () => {
  const key = refundConfirmationIdempotencyKey(ORDER_ID, 1000);
  for (const forbidden of ["@", "kundin", "example.com", "GLOA-2026", "2026-08"]) {
    assert.ok(!key.includes(forbidden), `the key contains ${forbidden}`);
  }
  const fn = templateCode.slice(templateCode.indexOf("export function refundConfirmationIdempotencyKey"));
  const signature = fn.slice(0, fn.indexOf("{"));
  assert.ok(signature.includes("orderId: string"));
  assert.ok(signature.includes("refundedTotalCents: number"));
  assert.equal([...signature.matchAll(/\w+:\s*(string|number)/g)].length, 2, "the key takes extra inputs");
  const body = fn.slice(fn.indexOf("{"), fn.indexOf("\n}"));
  for (const volatile of ["Date", "random", "Math.", "email", "name"]) {
    assert.ok(!body.includes(volatile), `the key uses ${volatile}`);
  }
});

test("idempotency: it cannot collide with any other GLOA message", () => {
  const keys = [
    refundConfirmationIdempotencyKey(ORDER_ID, 1000),
    cancellationOutcomeIdempotencyKey(ORDER_ID),
    cancellationRequestNotificationIdempotencyKey(ORDER_ID),
    internalOrderNotificationIdempotencyKey(ORDER_ID),
    shipmentConfirmationIdempotencyKey(ORDER_ID),
  ];
  assert.equal(new Set(keys).size, 5, "two GLOA messages share an idempotency key");
  assert.match(keys[0], /^gloa\/refund\/[0-9a-f-]{36}\/\d+$/);
});

test("idempotency: the sender uses it on its single send", () => {
  assert.ok(senderCode.includes("refundConfirmationIdempotencyKey(order.id, refundedTotalCents)"));
  assert.ok(senderCode.includes("{ idempotencyKey }"));
  assert.equal([...senderCode.matchAll(/resend\.emails\.send\(/g)].length, 1);
});

/* ══════════════════════════════════════════════════════════════
   THE EMAIL
   ══════════════════════════════════════════════════════════════ */

test("email: partial and full are decided by the persisted amounts", () => {
  assert.equal(refundKind(1000, TOTAL), "partial");
  assert.equal(refundKind(TOTAL - 1, TOTAL), "partial");
  assert.equal(refundKind(TOTAL, TOTAL), "full");
  assert.equal(refundKind(TOTAL + 1, TOTAL), "full");
  // The same comparison migration 019 uses, so the email and the account
  // page can never disagree.
  const migration019 = read("supabase/migrations/019_order_lifecycle_tracking.sql");
  assert.ok(migration019.includes("p_refunded_total_cents >= v_order.total_gross_cents"));
});

test("email: the partial subject says Teilerstattung and names the order", () => {
  const { subject } = built("partial");
  assert.ok(subject.includes("Teilerstattung"));
  assert.ok(subject.includes(ORDER_NUMBER));
  // It must not read as a full refund.
  assert.ok(!subject.includes("vollständig"));
});

test("email: the full subject says the order was refunded and names it", () => {
  const { subject } = built("full");
  assert.ok(subject.includes("erstattet"));
  assert.ok(subject.includes(ORDER_NUMBER));
  assert.ok(!subject.includes("Teil"), "the full subject reads as partial");
});

test("email: the partial email states the amount and the order value", () => {
  const { html, text } = built("partial");
  assert.ok(html.includes("Ein Teil deiner Zahlung wurde erstattet."));
  assert.ok(html.includes("10,00 EUR"), "the refunded amount is not rendered");
  assert.ok(html.includes("49,90 EUR"), "the order value is not shown for context");
  assert.ok(text.includes("Erstatteter Betrag: 10,00 EUR"));
  assert.ok(text.includes("Bestellwert: 49,90 EUR"));
  for (const surface of [html, text]) assert.ok(surface.includes(ORDER_NUMBER));
});

test("email: the full email states the full refund and does not repeat the total", () => {
  const { html, text } = built("full");
  assert.ok(html.includes("Deine Zahlung wurde vollständig erstattet."));
  assert.ok(html.includes("49,90 EUR"));
  assert.ok(!text.includes("Bestellwert:"), "the full email repeats the same number twice");
  for (const surface of [html, text]) assert.ok(surface.includes(ORDER_NUMBER));
});

test("email: the amount comes from the order's own currency, never a hardcoded EUR", () => {
  const { html, text } = built("full", { currency: "CHF" });
  assert.ok(html.includes("49,90 CHF"));
  assert.ok(text.includes("49,90 CHF"));
  assert.ok(!templateCode.includes('"EUR"'), "the template hardcodes a currency");
  assert.ok(senderCode.includes("currency: order.currency"));
});

test("email: IT INVENTS NO BANK TIMING", () => {
  for (const kind of ["partial", "full"]) {
    const { subject, html, text } = built(kind);
    for (const surface of [subject, html, text]) {
      for (const forbidden of [
        "Werktage", "Bankarbeitstage", "Arbeitstage", "Tagen", "3-5", "5-10",
        "innerhalb von", "dauert", "in Kürze auf deinem Konto",
      ]) {
        assert.ok(!surface.includes(forbidden), `${kind} invents timing: ${forbidden}`);
      }
    }
  }
});

test("email: IT INVENTS NO PAYMENT DESTINATION", () => {
  for (const kind of ["partial", "full"]) {
    const { subject, html, text } = built(kind);
    for (const surface of [subject, html, text]) {
      for (const forbidden of [
        "Kreditkarte", "Karte", "IBAN", "PayPal", "Bankkonto", "Konto endend",
        "last4", "Visa", "Mastercard", "SEPA", "Lastschrift",
      ]) {
        assert.ok(!surface.includes(forbidden), `${kind} invents a destination: ${forbidden}`);
      }
    }
  }
  // The one sentence it does say describes how refunds work, not where.
  assert.ok(built("full").html.includes("auf dem Weg zurück, den du bezahlt hast"));
});

test("email: IT INVENTS NO REASON AND PROMISES NO FURTHER MONEY", () => {
  for (const kind of ["partial", "full"]) {
    const { html, text } = built(kind);
    for (const surface of [html, text]) {
      for (const forbidden of [
        "weil", "Grund", "aufgrund", "da die", "storniert",
        "der Rest", "restliche", "folgt in Kürze", "weitere Erstattung",
      ]) {
        assert.ok(!surface.includes(forbidden), `${kind} invents: ${forbidden}`);
      }
    }
  }
  // The template has no field for any of it.
  const orderType = templateCode.slice(
    templateCode.indexOf("export type RefundConfirmationOrder"),
    templateCode.indexOf("export type BuiltRefundConfirmationEmail")
  );
  for (const field of ["reason", "Reason", "days", "card", "iban", "method", "remaining", "eta"]) {
    assert.ok(!orderType.includes(field), `the template carries a ${field} field`);
  }
});

test("email: it carries no card data, no secret and no internal identifier", () => {
  for (const kind of ["partial", "full"]) {
    const { subject, html, text } = built(kind);
    for (const surface of [subject, html, text]) {
      for (const forbidden of [
        "sk_", "whsec_", "re_", "pi_", "ch_", "re_1", "cus_", "sub_",
        "CVC", "PAN", "SECRET", "api_key", "Bearer",
        "customer_snapshot", "user_id", "payment_intent", ORDER_ID,
      ]) {
        assert.ok(!surface.includes(forbidden), `${kind} contains ${forbidden}`);
      }
    }
  }
});

test("email: customer-controlled text reaching the markup is escaped", () => {
  const { html } = buildRefundConfirmationEmail({
    order: {
      order_number: '<script>alert(1)</script>&"',
      kind: "partial",
      refundedTotalCents: 1000,
      originalTotalGrossCents: TOTAL,
      currency: "EUR",
      accountOrderUrl: 'https://x.test/"><script>',
    },
  });
  assert.ok(!html.includes("<script>"), "an unescaped script tag reached the HTML");
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(html.includes("&amp;"));
  assert.ok(html.includes("&quot;"));
});

test("email: the account link is omitted when absent", () => {
  assert.ok(!built("full").html.includes("Konto ansehen"));
  const withLink = built("full", { accountOrderUrl: "https://gloamatcha.com/account/orders/x" });
  assert.ok(withLink.html.includes("https://gloamatcha.com/account/orders/x"));
  assert.ok(withLink.text.includes("https://gloamatcha.com/account/orders/x"));
});

test("email: it uses the established GLOA transactional branding", () => {
  const { html } = built("full");
  for (const token of ["#1746D1", "#A61E59", "#F5EBE2", "#4F3A5B"]) {
    assert.ok(html.includes(token), `missing brand token ${token}`);
  }
  assert.ok(html.includes(">GLOA<"));
  assert.ok(html.includes('<html lang="de">'));
  assert.ok(html.includes("support@gloamatcha.com"));
  for (const forbidden of ["unsubscribe", "Abmelden", "Newsletter", "entdecke", "jetzt kaufen"]) {
    assert.ok(!html.includes(forbidden), `the email carries marketing: ${forbidden}`);
  }
});

test("email: it makes no health or product claim", () => {
  for (const kind of ["partial", "full"]) {
    const { html, text } = built(kind);
    for (const surface of [html, text]) {
      for (const forbidden of ["gesund", "Antioxid", "Koffein", "Vitamin", "Wirkung", "heilt"]) {
        assert.ok(!surface.includes(forbidden), `${kind} makes a claim: ${forbidden}`);
      }
    }
  }
});

test("email: the template is a pure leaf, like the other six", () => {
  assert.ok(!/from "\.\//.test(templateCode), "the template has a relative import");
  assert.ok(!templateCode.includes("supabase"), "the template touches the database");
  assert.ok(!templateCode.includes("fetch("), "the template makes a network call");
  for (const volatile of ["Date.now", "new Date()", "Math.random"]) {
    assert.ok(!templateCode.includes(volatile), `the template reads ${volatile}`);
  }
  const templates = readdirSync(path.join(ROOT, "lib/email")).sort();
  assert.deepEqual(templates, [
    "cancellationOutcome.ts", "cancellationRequestNotification.ts",
    "internalOrderNotification.ts", "orderConfirmation.ts",
    "refundConfirmation.ts", "shipmentConfirmation.ts", "withdrawalConfirmation.ts",
  ]);
});

/* ══════════════════════════════════════════════════════════════
   RECIPIENT, SENDER, REPLY-TO
   ══════════════════════════════════════════════════════════════ */

test("recipient: it comes only from the durable customer_snapshot", () => {
  assert.ok(senderCode.includes("recipientFromSnapshot(order.customer_snapshot)"));
  assert.ok(senderCode.includes("to: customerEmail"));
  const entry = senderCode.slice(senderCode.indexOf("export async function sendRefundConfirmationIfNeeded"));
  const signature = entry.slice(0, entry.indexOf(")"));
  assert.ok(signature.includes("orderId: string"));
  for (const forbidden of ["recipient", "email", "to:", "subject", "html", "amount", "cents"]) {
    assert.ok(!signature.includes(forbidden), `the entry point accepts ${forbidden}`);
  }
});

test("recipient: THE STRIPE PAYLOAD EMAIL IS NEVER USED", () => {
  // The snapshot is canonical everywhere in this repository. A Stripe
  // customer email can diverge from the order's own record.
  for (const forbidden of [
    "customer_details", "receipt_email", "billing_details", "charge.", "event.data",
  ]) {
    assert.ok(!senderCode.includes(forbidden), `the sender reads Stripe: ${forbidden}`);
  }
  // The webhook hands over an order id and nothing else.
  const call = webhookCode.slice(webhookCode.indexOf("sendRefundConfirmationIfNeeded("));
  const args = call.slice(call.indexOf("(") + 1, call.indexOf(")"));
  assert.equal(args.trim(), "outcome.orderId");
});

test("recipient: an order with no usable address fails rather than inventing one", () => {
  const guard = senderCode.slice(senderCode.indexOf("const customerEmail = recipientFromSnapshot"));
  assert.ok(guard.slice(0, 600).includes("if (!customerEmail)"));
  assert.ok(guard.slice(0, 600).includes("markFailed(order.id)"));
  assert.ok(!senderCode.includes("@gloamatcha.com"), "the sender hardcodes an address");
  assert.ok(!senderCode.includes("GLOA_INTERNAL_ORDERS"), "a customer email would go to the internal inbox");
});

test("sender and reply-to match the other customer order emails", () => {
  assert.equal(GLOA_FROM_HELLO, "GLOA <hello@gloamatcha.com>");
  assert.equal(GLOA_REPLY_TO_SUPPORT, "support@gloamatcha.com");
  assert.ok(senderCode.includes("from: GLOA_FROM_HELLO"));
  assert.ok(senderCode.includes("replyTo: GLOA_REPLY_TO_SUPPORT"));
  const shipment = withoutComments(read("lib/shipmentConfirmationEmail.ts"));
  assert.ok(shipment.includes("from: GLOA_FROM_HELLO"));
  assert.ok(shipment.includes("replyTo: GLOA_REPLY_TO_SUPPORT"));
});

/* ══════════════════════════════════════════════════════════════
   THE WEBHOOK
   ══════════════════════════════════════════════════════════════ */

test("webhook: the email happens strictly AFTER the durable sync", () => {
  const handler = webhookCode.slice(webhookCode.indexOf("async function handleRefundEvent"));
  const body = handler.slice(0, handler.indexOf("async function handleCheckoutSessionCompleted"));
  const syncAt = body.indexOf("syncOrderRefundStateFromStripe(stripe, paymentIntentId)");
  const sendAt = body.indexOf("sendRefundConfirmationIfNeeded(outcome.orderId)");
  assert.ok(syncAt > -1 && sendAt > -1);
  assert.ok(syncAt < sendAt, "the email is attempted before the refund state is durable");
  assert.equal([...body.matchAll(/sendRefundConfirmationIfNeeded\(/g)].length, 1);
});

test("webhook: the ABSOLUTE PaymentIntent re-read is intact", () => {
  const refunds = withoutComments(read("lib/orderRefunds.ts"));
  assert.ok(refunds.includes("stripe.refunds.list({ payment_intent: trimmedId, limit: 100 })"));
  assert.ok(refunds.includes("summarizeStripeRefunds(refunds.data, order[0].currency)"));
  assert.ok(refunds.includes('admin.rpc("apply_order_refund_state"'));
  // Nothing from the payload is trusted except the payment intent id.
  const stripeRefunds = read("lib/stripeRefunds.ts");
  assert.ok(stripeRefunds.includes("export function paymentIntentIdFromRefundEvent"));
});

test("webhook: the existing Stripe event idempotency is intact", () => {
  assert.ok(webhookCode.includes("hasStripeWebhookEventBeenProcessed(event.id)"));
  assert.ok(webhookCode.includes("recordStripeWebhookEvent(event.id, event.type, checkoutSessionId)"));
  // The dedupe still runs before any handler.
  assert.ok(webhookCode.indexOf("hasStripeWebhookEventBeenProcessed")
    < webhookCode.indexOf("isRefundEventType(event.type)"));
});

test("webhook: a duplicate delivery cannot duplicate the email", () => {
  // Three independent guards, and any one of them is sufficient.
  // 1. the event-id dedupe above returns 200 without entering the handler
  assert.ok(webhookCode.includes("if (alreadyProcessed) {"));
  // 2. a re-run sync returns 'unchanged', which the new-fact guard rejects
  assert.equal(isNewSettledRefundFact("unchanged"), false);
  // 3. the watermark equals the total, so the claim finds nothing owed
  assert.equal(isRefundEmailOwed(order({
    refunded_total_cents: 1000,
    refund_email_notified_total_cents: 1000,
    refund_email_status: "sent",
  })), false);
});

test("webhook: a failed email does not reverse the refund state", () => {
  const handler = webhookCode.slice(webhookCode.indexOf("async function handleRefundEvent"));
  const body = handler.slice(0, handler.indexOf("async function handleCheckoutSessionCompleted"));
  // The outcome is logged, never thrown and never acted on.
  assert.ok(!body.includes("throw"), "a mail failure throws out of the refund handler");
  assert.ok(body.includes('emailOutcome === "failed"'));
  // And the handler writes no refund state of its own.
  for (const forbidden of ["payment_status", "refunded_total_cents", "refund_updated_at", ".update("]) {
    assert.ok(!body.includes(forbidden), `the handler writes ${forbidden}`);
  }
});

test("webhook: the sync now returns the durable order id, from its own lookup", () => {
  assert.ok(syncCode.includes('.select("id, currency")'));
  assert.ok(syncCode.includes("orderId: string | null;"));
  assert.ok(syncCode.includes("orderId: typeof order[0].id === \"string\" ? order[0].id : null,"));
  // Every early return still satisfies the type.
  const returns = [...syncCode.matchAll(/return \{ result: "[a-z_]+"[^}]*\}/g)].map(m => m[0]);
  assert.ok(returns.length >= 3);
  for (const r of returns) assert.ok(r.includes("orderId"), `an early return lacks orderId: ${r}`);
  // The ambiguity refusal is intact: an id is only returned for exactly
  // one matching order.
  assert.ok(syncCode.includes('return { result: "ambiguous_payment_intent"'));
});

/* ══════════════════════════════════════════════════════════════
   NO REFUND CREATION
   ══════════════════════════════════════════════════════════════ */

test("refunds: no Stripe write API anywhere in the repository", () => {
  const STRIPE_WRITES = [
    ["refunds", ".create"], ["refunds", ".cancel"], ["paymentIntents", ".cancel"],
  ].map(parts => parts.join(""));
  const offenders = [];
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      const source = withoutComments(readFileSync(full, "utf-8"));
      for (const forbidden of STRIPE_WRITES) {
        if (source.includes(forbidden)) offenders.push(`${entry.name}: ${forbidden}`);
      }
    }
  };
  walk(path.join(ROOT, "app"));
  walk(path.join(ROOT, "lib"));
  assert.deepEqual(offenders, [], `a Stripe write API appeared: ${offenders.join(", ")}`);
});

test("refunds: this feature imports no Stripe client at all", () => {
  for (const source of [senderCode, templateCode, rulesCode]) {
    for (const forbidden of ["stripe", "Stripe"]) {
      assert.ok(!source.includes(forbidden), `this feature touches ${forbidden}`);
    }
  }
  // And no new endpoint was created.
  const apiFiles = [];
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (entry.name === "route.ts") apiFiles.push(path.relative(ROOT, full).split(path.sep).join("/"));
    }
  };
  walk(path.join(ROOT, "app/api"));
  assert.ok(!apiFiles.some(f => f.includes("refund")), "a refund endpoint was created");
});

/* ══════════════════════════════════════════════════════════════
   REGRESSIONS
   ══════════════════════════════════════════════════════════════ */

test("regression: the cancellation flow is entirely unchanged", () => {
  const requestRoute = withoutComments(read("app/api/orders/cancellation-request/route.ts"));
  assert.deepEqual([...requestRoute.matchAll(/\.rpc\("(\w+)"/g)].map(m => m[1]), ["request_order_cancellation"]);
  const cancelRoute = withoutComments(read("app/api/internal/orders/cancel/route.ts"));
  assert.deepEqual([...cancelRoute.matchAll(/\.rpc\("(\w+)"/g)].map(m => m[1]), ["cancel_order"]);
  const resolveRoute = withoutComments(read("app/api/internal/orders/cancellation-request/resolve/route.ts"));
  assert.deepEqual([...resolveRoute.matchAll(/\.rpc\("(\w+)"/g)].map(m => m[1]),
    ["resolve_order_cancellation_request"]);
  assert.ok(resolveRoute.includes("sendCancellationOutcomeEmailIfNeeded(orderId)"));
  for (const source of [requestRoute, cancelRoute, resolveRoute]) {
    assert.ok(!source.includes("refund"), "a cancellation route learned about refunds");
  }
});

test("regression: the shipment flow and its guard are unchanged", () => {
  const shipRoute = withoutComments(read("app/api/internal/orders/ship/route.ts"));
  assert.deepEqual([...shipRoute.matchAll(/\.rpc\("(\w+)"/g)].map(m => m[1]), ["mark_order_shipped"]);
  assert.ok(shipRoute.includes("sendShipmentConfirmationIfNeeded(orderId)"));
  assert.ok(shipRoute.includes("cancellation_request_open"));
  const m032 = withoutComments(read("supabase/migrations/032_open_cancellation_request_shipment_guard.sql"));
  assert.ok(m032.includes("cancellation_requested_at is not null"));
  assert.ok(m032.includes("cancellation_request_resolution is null"));
});

test("regression: the other five emails are untouched", () => {
  for (const other of [
    "sendOrderConfirmationEmailIfNeeded", "sendInternalOrderNotificationIfNeeded",
    "sendShipmentConfirmationIfNeeded", "sendCancellationRequestNotificationIfNeeded",
    "sendCancellationOutcomeEmailIfNeeded",
  ]) {
    assert.ok(!senderCode.includes(other), `the refund sender triggers ${other}`);
    assert.ok(!sql033.includes(other), `033 touches ${other}`);
  }
  // The webhook still sends exactly the two it always sent at checkout.
  assert.ok(webhookCode.includes("sendOrderConfirmationEmailIfNeeded("));
  assert.ok(webhookCode.includes("sendInternalOrderNotificationIfNeeded("));
  // Those two still THROW, so their Stripe-retry contract is intact.
  const confirmation = withoutComments(read("lib/orderConfirmationEmail.ts"));
  const internal = withoutComments(read("lib/internalOrderNotificationEmail.ts"));
  assert.ok(confirmation.includes("throw"), "the order confirmation stopped throwing");
  assert.ok(internal.includes("throw"), "the internal notification stopped throwing");
});

test("regression: the account UI is untouched and still renders refunds truthfully", () => {
  const portal = read("app/AccountPortal.tsx");
  for (const forbidden of ["refund_email", "sendRefundConfirmationIfNeeded", "/api/internal/"]) {
    assert.ok(!portal.includes(forbidden), `the portal exposes ${forbidden}`);
  }
  const status = withoutComments(read("lib/orderStatus.ts"));
  assert.ok(status.includes("export function getRefundView"));
  assert.ok(!status.includes("refund_email"), "the display layer learned about email state");
});

test("regression: SHOP_STATUS, the subscription flag, pricing and tax are unchanged", () => {
  assert.ok(read("app/content.ts").includes('export const SHOP_STATUS = "prelaunch" as const;'));
  assert.match(read(".env.example"), /^B2C_SUBSCRIPTIONS_ENABLED=$/m);
  for (const source of [senderCode, templateCode, rulesCode, sql033]) {
    for (const forbidden of [
      "B2C_SUBSCRIPTIONS_ENABLED", "SHOP_STATUS", "price_gross_cents",
      "computeShippingGrossCents", "resolveCheckoutTax", "SHIPPING_ZONES", "tax_total_cents",
    ]) {
      assert.ok(!source.includes(forbidden), `this task touches ${forbidden}`);
    }
  }
});

test("regression: no new secret and no new environment variable", () => {
  const example = read(".env.example");
  for (const name of ["FULFILLMENT_ADMIN_SECRET", "CANCELLATION_ADMIN_SECRET", "CRON_SECRET", "RESEND_API_KEY"]) {
    assert.match(example, new RegExp(`^${name}=$`, "m"), `${name} gained a value or vanished`);
  }
  for (const source of [senderCode, templateCode, rulesCode]) {
    assert.ok(!/process\.env/.test(source), "this feature reads an environment variable directly");
  }
});

test("regression: no server-only material reaches the client bundle", () => {
  const CLIENT = path.join(ROOT, ".output/public");
  if (!existsSync(CLIENT)) return; // no build present; npm test always makes one

  const files = [];
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (/\.(js|mjs|json|html|css)$/.test(entry.name)) files.push(full);
    }
  };
  walk(CLIENT);
  assert.ok(files.length > 0, "no client assets were found to check");

  const leaks = [];
  for (const file of files) {
    const source = readFileSync(file, "utf-8");
    for (const needle of [
      "sendRefundConfirmationIfNeeded", "refundConfirmationIdempotencyKey",
      "refund_email_notified_total_cents", "apply_order_refund_state",
      "RESEND_API_KEY", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET",
    ]) {
      if (source.includes(needle)) leaks.push(`${path.relative(ROOT, file)}: ${needle}`);
    }
  }
  assert.deepEqual(leaks, [], `server-only material reached the client bundle: ${leaks.join(", ")}`);
});

test("logging: no PII and no amount reaches a log line", () => {
  // The refund handler only, not the whole webhook: the pre-existing
  // checkout path logs a "missing shipping snapshot" diagnostic that
  // predates this feature and is not this task's to police.
  const refundHandler = webhookCode.slice(
    webhookCode.indexOf("async function handleRefundEvent"),
    webhookCode.indexOf("async function handleCheckoutSessionCompleted")
  );
  for (const source of [senderCode, refundHandler]) {
    const logs = [...source.matchAll(/console\.\w+\(([\s\S]*?)\);/g)].map(m => m[1]);
    for (const line of logs) {
      for (const forbidden of [
        "customerEmail", "customer_snapshot", "snapshot", "address",
        "refundedTotalCents", "notifiedTotal", "JSON.stringify", "order)",
      ]) {
        assert.ok(!line.includes(forbidden), `a log line contains ${forbidden}: ${line}`);
      }
    }
  }
});

test("no real Resend request, no Stripe request and no production Supabase in this suite", () => {
  const suite = withoutComments(read("tests/refund-confirmation.test.mjs"));
  const forbidden = [
    ["create", "Client("], ["new ", "Resend("], ["new ", "Stripe("],
    ["supabase", ".co"], ["api.", "resend.com"], ["api.", "stripe.com"],
    ["spawn", "("],
  ].map(parts => parts.join(""));
  for (const needle of forbidden) {
    assert.ok(!suite.includes(needle), `the suite performs: ${needle}`);
  }
});
