import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeBlockedServerEnv } from "./helpers/testSupabase.mjs";
import {
  CANCELLATION_NOTIFICATION_STATUSES,
  isLiveNotificationClaimable,
  isLiveNotificationOwed,
  isNotificationSweepEligible,
} from "../lib/cancellationRequestNotificationRules.ts";
import {
  buildCancellationRequestNotificationEmail,
  cancellationRequestNotificationIdempotencyKey,
} from "../lib/email/cancellationRequestNotification.ts";
import { internalOrderNotificationIdempotencyKey } from "../lib/email/internalOrderNotification.ts";
import { shipmentConfirmationIdempotencyKey } from "../lib/email/shipmentConfirmation.ts";
import { GLOA_FROM_HELLO, GLOA_INTERNAL_ORDERS } from "../lib/emailSenders.ts";

// SAFE DEFAULT SUITE: pure template and rule logic, source-level checks,
// and real spawned servers started WITHOUT a Supabase service-role key
// and WITHOUT a Resend key. No database is reachable, no production row
// can be read or written, no order is cancelled, no Stripe API is called
// and no email of any kind is sent. Nothing here executes SQL.
//
// The rule this suite protects: a customer's cancellation REQUEST becomes
// durable first and stays durable, GLOA is then told about it exactly
// once, the message never claims the order was cancelled, and a historical
// request can never be swept into somebody's inbox.

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf-8");
const NEWLINE = String.fromCharCode(10);

const MIGRATIONS = path.join(ROOT, "supabase/migrations");
const route = read("app/api/orders/cancellation-request/route.ts");
const sender = read("lib/cancellationRequestNotificationEmail.ts");
const rules = read("lib/cancellationRequestNotificationRules.ts");
const template = read("lib/email/cancellationRequestNotification.ts");
const migration030 = read("supabase/migrations/030_cancellation_request_notification_state.sql");

const withoutComments = source => source
  .split(NEWLINE)
  .filter(line => {
    const t = line.trim();
    return !t.startsWith("--") && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
  })
  .join(NEWLINE);

const routeCode = withoutComments(route);
/**
 * The handler body only, with imports and type aliases excluded.
 *
 * Ordering assertions have to run against this: `import { sendCancellation... }`
 * sits at position 0 and would make every "X happens after Y" check
 * trivially false for reasons that have nothing to do with runtime order.
 * It also keeps `type SuccessResponse = { message: string }` from being
 * read as a response payload.
 */
const routeBody = routeCode.slice(routeCode.indexOf("export async function POST"));
const senderCode = withoutComments(sender);
/** The exported entry point onward, past the private claim helpers. */
const senderEntry = senderCode.slice(
  senderCode.indexOf("export async function sendCancellationRequestNotificationIfNeeded")
);
const rulesCode = withoutComments(rules);
const templateCode = withoutComments(template);
const sql030 = withoutComments(migration030);

const ORDER_ID = "11111111-2222-3333-4444-555555555555";
const ORDER_NUMBER = "GLOA-2026-000451";

/** A complete notification order, for the template assertions. */
const emailOrder = (overrides = {}) => ({
  order_number: ORDER_NUMBER,
  requestedAt: "2026-08-24T09:30:00.000Z",
  requestNote: null,
  customerName: "Test Kundin",
  customerEmail: "kundin@example.com",
  currency: "EUR",
  total_gross_cents: 4990,
  payment_status: "paid",
  fulfillment_status: "unfulfilled",
  ...overrides,
});

const built = (overrides = {}) =>
  buildCancellationRequestNotificationEmail({ order: emailOrder(overrides) });

/* ══════════════════════════════════════════════════════════════
   MIGRATION 030: NUMBERING AND IMMUTABILITY
   ══════════════════════════════════════════════════════════════ */

test("030: it owns its number and 022-029 are untouched", () => {
  // 030 was the next free number when it was written. Phase 2D-B has
  // since added 031 (cancellation request resolution), so this asserts
  // ownership and immutability rather than "nothing later exists" - the
  // same correction each earlier suite already took. No later migration
  // may touch the notification state 030 put live.
  const files = readdirSync(MIGRATIONS).filter(f => f.endsWith(".sql")).sort();
  const numbers = files.map(f => f.slice(0, 3));
  assert.equal(new Set(numbers).size, numbers.length, "a migration number is used twice");
  assert.deepEqual(files.filter(f => f.startsWith("030")), ["030_cancellation_request_notification_state.sql"]);
  for (const name of files.filter(f => f > "030_cancellation_request_notification_state.sql")) {
    const later = withoutComments(readFileSync(path.join(MIGRATIONS, name), "utf-8"));
    assert.ok(!later.includes("cancellation_request_notification"),
      `${name} touches the request notification state`);
  }
  const upTo030 = files.filter(f => f < "031");
  assert.deepEqual(upTo030.slice(-9, -1), [
    "022_recurring_subscription_foundation.sql",
    "023_harden_stripe_customers_grants.sql",
    "024_seed_b2c_subscription_plans.sql",
    "025_grant_subscription_plans_service_role.sql",
    "026_internal_order_notification_state.sql",
    "027_shipment_confirmation_email_state.sql",
    "028_authorized_shipment_transition.sql",
    "029_authorized_order_cancellation.sql",
  ]);
});

test("030: migration 029 is not edited and still says exactly what it said", () => {
  const migration029 = read("supabase/migrations/029_authorized_order_cancellation.sql");
  for (const line of [
    "create or replace function public.cancel_order(",
    "security definer set search_path = ''",
    "add column if not exists cancelled_at timestamptz;",
    "status             = 'cancelled',",
    "fulfillment_status = 'cancelled',",
    "grant execute on function public.cancel_order(text) to service_role;",
  ]) {
    assert.ok(migration029.includes(line), `029 no longer contains: ${line}`);
  }
  assert.ok(!sql030.includes("cancel_order"), "030 touches the cancellation function");
});

test("030: it redefines nothing 019, 026, 027 or 028 own", () => {
  for (const owned of [
    "request_order_cancellation", "apply_order_refund_state", "mark_order_shipped",
    "internal_notification_status", "shipment_email_status", "confirmation_email_status",
  ]) {
    assert.ok(!sql030.includes(owned), `030 touches ${owned}`);
  }
});

/* ══════════════════════════════════════════════════════════════
   MIGRATION 030: THE COLUMNS
   ══════════════════════════════════════════════════════════════ */

test("030: both columns are nullable, have no default, and are the only ones added", () => {
  const adds = [...sql030.matchAll(/add column(?: if not exists)? (\w+)/g)].map(m => m[1]);
  assert.deepEqual(adds.sort(), [
    "cancellation_request_notification_sent_at",
    "cancellation_request_notification_status",
  ]);
  const alter = sql030.slice(sql030.indexOf("alter table public.orders"));
  const statement = alter.slice(0, alter.indexOf(";") + 1);
  assert.ok(!/default/i.test(statement), "a column has a default");
  assert.ok(!/not null/i.test(statement), "a column is NOT NULL");
  assert.ok(statement.includes("timestamptz"), "the sent_at column is not a timestamp");
});

test("030: the status constraint allows exactly sending, sent and failed", () => {
  assert.ok(sql030.includes(
    "check (cancellation_request_notification_status in ('sending', 'sent', 'failed'))"
  ));
  const check = sql030.slice(sql030.indexOf("check (cancellation_request_notification_status"));
  const values = [...check.slice(0, 120).matchAll(/'(\w+)'/g)].map(m => m[1]);
  assert.deepEqual(values, ["sending", "sent", "failed"]);
});

test("030: THE NULL RULE - there is no 'pending' anywhere", () => {
  // A 'pending' value or a default would make every historical
  // cancellation request look like queued work the first time anything
  // swept the table.
  assert.ok(!sql030.includes("'pending'"), "030 introduces a pending state");
  assert.ok(!/default\s+'/i.test(sql030), "030 gives a column a literal default");
  // And the same vocabulary the other three email-state migrations use.
  for (const rel of [
    "supabase/migrations/026_internal_order_notification_state.sql",
    "supabase/migrations/027_shipment_confirmation_email_state.sql",
  ]) {
    assert.ok(read(rel).includes("in ('sending', 'sent', 'failed')"), `${rel} vocabulary changed`);
  }
});

test("030: no backfill, no trigger, no function, no policy, no index", () => {
  for (const forbidden of [
    "insert into", "update public.orders", "delete from", "truncate",
    "create trigger", "create or replace function", "create policy", "create index",
    "drop column", "drop constraint", "drop table", "alter column",
    "notify", "http_post", "net.http", "resend", "smtp",
  ]) {
    assert.ok(!sql030.toLowerCase().includes(forbidden), `030 performs: ${forbidden}`);
  }
});

/* ══════════════════════════════════════════════════════════════
   MIGRATION 030: GRANTS
   ══════════════════════════════════════════════════════════════ */

test("030: service_role gets column-scoped UPDATE on exactly the two new columns", () => {
  const grants = sql030.split(NEWLINE + NEWLINE)
    .join(NEWLINE)
    .split(";")
    .filter(s => /^\s*grant/i.test(s));
  assert.equal(grants.length, 1, "more than one grant was issued");
  const grant = grants[0].replace(/\s+/g, " ").trim();
  assert.ok(grant.includes(
    "grant update (cancellation_request_notification_status, cancellation_request_notification_sent_at)"
  ), `unexpected grant: ${grant}`);
  assert.ok(grant.includes("on public.orders to service_role"));
});

test("030: no lifecycle, payment, refund, request or snapshot column is granted", () => {
  const grant = sql030.slice(sql030.indexOf("grant update"));
  const clause = grant.slice(0, grant.indexOf(";"));
  for (const forbidden of [
    "status,", " status)", "fulfillment_status", "cancelled_at", "payment_status",
    "refunded_total_cents", "refund_updated_at", "cancellation_requested_at",
    "cancellation_request_note", "_cents", "tax_", "snapshot", "tracking", "shipped_at",
  ]) {
    // The two granted names both END in _status / _sent_at, so a naive
    // substring check would hit them; compare against the clause with the
    // two legitimate names removed.
    const stripped = clause
      .split("cancellation_request_notification_status").join("")
      .split("cancellation_request_notification_sent_at").join("");
    assert.ok(!stripped.includes(forbidden), `030 grants ${forbidden}`);
  }
});

test("030: no table-level write grant and nothing for anon or authenticated", () => {
  assert.ok(!/grant[^;(]*update[^;(]*on\s+(table\s+)?public\.orders/i.test(sql030),
    "030 grants table-level UPDATE");
  assert.ok(!/to anon/i.test(sql030), "030 grants something to anon");
  assert.ok(!/to authenticated/i.test(sql030), "030 grants something to authenticated");
  assert.ok(!/grant\s+(select|insert|delete|all)/i.test(sql030), "030 grants a non-UPDATE privilege");
});

test("030: the OWNER verification queries cover A through L", () => {
  for (const marker of ["-- (A)", "-- (D)", "-- (E)", "-- (H)", "-- (I)", "-- (J)", "-- (K)", "-- (L)"]) {
    assert.ok(migration030.includes(marker), `verification ${marker} is missing`);
  }
  assert.ok(migration030.includes("column_privileges"), "no UPDATE-grant verification");
  assert.ok(migration030.includes("count(cancellation_request_notification_status)"), "no backfill verification");
  assert.ok(migration030.includes("pg_trigger"), "no trigger verification");
  assert.ok(migration030.includes("prosecdef"), "no 022-029 function verification");
  assert.ok(migration030.includes("sweep_eligible"), "no sweep-eligibility verification");
});

/* ══════════════════════════════════════════════════════════════
   THE CLAIM STATE MACHINE
   ══════════════════════════════════════════════════════════════ */

test("claim: the vocabulary is exactly sending, sent, failed", () => {
  assert.deepEqual([...CANCELLATION_NOTIFICATION_STATUSES], ["sending", "sent", "failed"]);
  assert.ok(!CANCELLATION_NOTIFICATION_STATUSES.includes("pending"));
});

test("claim: NULL is claimable by a live send", () => {
  assert.equal(isLiveNotificationClaimable(null), true);
  assert.equal(isLiveNotificationClaimable(undefined), true);
});

test("claim: failed is claimable, which is what makes a repeat a retry", () => {
  assert.equal(isLiveNotificationClaimable("failed"), true);
});

test("claim: sending cannot be claimed - no competing send", () => {
  assert.equal(isLiveNotificationClaimable("sending"), false);
});

test("claim: sent can never be claimed again", () => {
  assert.equal(isLiveNotificationClaimable("sent"), false);
});

test("claim: an unrecognised status is refused rather than claimed", () => {
  for (const bad of ["pending", "queued", "", "SENT", "Failed", "x"]) {
    assert.equal(isLiveNotificationClaimable(bad), false, bad);
  }
});

test("claim: THE SWEEP RULE is strictly narrower - failed and nothing else", () => {
  // The rule that stops a future cron from mailing the fulfillment inbox
  // about every cancellation request ever recorded before this feature
  // existed.
  assert.equal(isNotificationSweepEligible("failed"), true);
  for (const never of [null, undefined, "sending", "sent", "pending", ""]) {
    assert.equal(isNotificationSweepEligible(never), false, String(never));
  }
  // NULL is claimable LIVE but never by a sweep. That asymmetry is the
  // whole point of having two predicates.
  assert.equal(isLiveNotificationClaimable(null), true);
  assert.equal(isNotificationSweepEligible(null), false);
});

test("claim: eligibility requires an actual cancellation request", () => {
  assert.equal(isLiveNotificationOwed({
    cancellation_requested_at: null,
    cancellation_request_notification_status: null,
  }), false, "an order nobody asked to stop is eligible");

  assert.equal(isLiveNotificationOwed({
    cancellation_requested_at: "2026-08-24T09:30:00.000Z",
    cancellation_request_notification_status: null,
  }), true);

  assert.equal(isLiveNotificationOwed({
    cancellation_requested_at: "2026-08-24T09:30:00.000Z",
    cancellation_request_notification_status: "failed",
  }), true);

  for (const taken of ["sending", "sent"]) {
    assert.equal(isLiveNotificationOwed({
      cancellation_requested_at: "2026-08-24T09:30:00.000Z",
      cancellation_request_notification_status: taken,
    }), false, taken);
  }
});

test("claim: the SQL claim repeats both halves of the rule", () => {
  const claim = senderCode.slice(senderCode.indexOf("async function claimCancellationRequestNotification"));
  const body = claim.slice(0, claim.indexOf("return (data?.length"));
  assert.ok(body.includes('.update({ cancellation_request_notification_status: "sending" })'));
  assert.ok(body.includes('.eq("id", orderId)'));
  // Defence in depth: the request cannot vanish between the read and the
  // write and still produce an email.
  assert.ok(body.includes('.not("cancellation_requested_at", "is", null)'));
  assert.ok(body.includes("cancellation_request_notification_status.is.null"));
  assert.ok(body.includes("cancellation_request_notification_status.eq.failed"));
  // A single UPDATE, so concurrent callers serialise on the row lock and
  // the loser gets zero rows back.
  assert.equal([...body.matchAll(/\.update\(/g)].length, 1);
});

test("claim: mark-sent is unconditional, mark-failed is conditional on sending", () => {
  const markSent = senderCode.slice(senderCode.indexOf("async function markSent"));
  const sentBody = markSent.slice(0, markSent.indexOf("async function markFailed"));
  assert.ok(sentBody.includes('cancellation_request_notification_status: "sent"'));
  assert.ok(sentBody.includes("cancellation_request_notification_sent_at"));
  assert.ok(!sentBody.includes('.eq("cancellation_request_notification_status"'),
    "mark-sent is conditional, which invites a duplicate");

  const markFailed = senderCode.slice(senderCode.indexOf("async function markFailed"));
  const failedBody = markFailed.slice(0, markFailed.indexOf("function customerFromSnapshot"));
  assert.ok(failedBody.includes('cancellation_request_notification_status: "failed"'));
  // Never writes 'failed' over 'sent'.
  assert.ok(failedBody.includes('.eq("cancellation_request_notification_status", "sending")'));
  assert.ok(!failedBody.includes("sent_at"), "mark-failed stamps a sent timestamp");
});

test("claim: the sender writes only migration 030's two columns", () => {
  const updates = [...senderCode.matchAll(/\.update\(\{([\s\S]*?)\}\)/g)].map(m => m[1]);
  assert.ok(updates.length >= 3, "the state machine has fewer writes than expected");
  for (const payload of updates) {
    const keys = [...payload.matchAll(/(\w+):/g)].map(m => m[1]);
    for (const key of keys) {
      assert.ok(
        key === "cancellation_request_notification_status" ||
        key === "cancellation_request_notification_sent_at",
        `the sender writes ${key}`
      );
    }
  }
});

test("claim: the sender never writes lifecycle, refund or request columns", () => {
  // Against the UPDATE payloads, not the whole file: the sender must be
  // free to READ fulfillment_status and payment_status (the email reports
  // them so a human can judge the request) while never WRITING either.
  const updates = [...senderCode.matchAll(/\.update\(\{([\s\S]*?)\}\)/g)].map(m => m[1]).join(" ");
  for (const forbidden of [
    "status:", "fulfillment_status", "cancelled_at", "payment_status",
    "refunded_total_cents", "refund_updated_at",
    "cancellation_requested_at", "cancellation_request_note",
  ]) {
    const stripped = updates
      .split("cancellation_request_notification_status").join("")
      .split("cancellation_request_notification_sent_at").join("");
    assert.ok(!stripped.includes(forbidden), `the sender writes ${forbidden}`);
  }
  // And it reaches no other write surface at all.
  for (const forbidden of [".rpc(", ".insert(", ".delete(", ".upsert("]) {
    assert.ok(!senderCode.includes(forbidden), `the sender performs: ${forbidden}`);
  }
});

test("claim: the sender never throws for an ordinary outcome", () => {
  // Its caller is a signed-in customer's request. A mail provider outage
  // must not fail that request, because the cancellation request is
  // already durable.
  assert.ok(!senderCode.includes("throw"), "the sender throws");
  // Every value the public entry point and its delivery helper can return
  // is one of the four documented outcomes. (The private claim helper has
  // its own narrower vocabulary and is excluded by starting at the entry
  // point.)
  const outcomes = [...senderEntry.matchAll(/return "([a-z-]+)"/g)].map(m => m[1]);
  assert.ok(outcomes.length >= 4, "the entry point returns fewer outcomes than expected");
  for (const outcome of outcomes) {
    assert.ok(["sent", "already-sent", "not-eligible", "failed"].includes(outcome), outcome);
  }
});

/* ══════════════════════════════════════════════════════════════
   IDEMPOTENCY KEY
   ══════════════════════════════════════════════════════════════ */

test("idempotency: the key is deterministic and per order", () => {
  assert.equal(cancellationRequestNotificationIdempotencyKey(ORDER_ID), `gloa/cancellation-request/${ORDER_ID}`);
  // Same order, same key, on every attempt from every path.
  assert.equal(
    cancellationRequestNotificationIdempotencyKey(ORDER_ID),
    cancellationRequestNotificationIdempotencyKey(ORDER_ID)
  );
  const other = "99999999-8888-7777-6666-555555555555";
  assert.notEqual(
    cancellationRequestNotificationIdempotencyKey(ORDER_ID),
    cancellationRequestNotificationIdempotencyKey(other)
  );
});

test("idempotency: the key carries no PII and no volatile input", () => {
  const key = cancellationRequestNotificationIdempotencyKey(ORDER_ID);
  for (const forbidden of ["@", "kundin", "Test", "example.com", "paid", "4990", "2026-08"]) {
    assert.ok(!key.includes(forbidden), `the key contains ${forbidden}`);
  }
  // The order id is the whole input.
  const fn = templateCode.slice(templateCode.indexOf("export function cancellationRequestNotificationIdempotencyKey"));
  const body = fn.slice(0, fn.indexOf("}"));
  for (const volatile of ["Date", "now(", "random", "Math."]) {
    assert.ok(!body.includes(volatile), `the key uses ${volatile}`);
  }
});

test("idempotency: it cannot collide with the other GLOA messages about one order", () => {
  const keys = [
    cancellationRequestNotificationIdempotencyKey(ORDER_ID),
    internalOrderNotificationIdempotencyKey(ORDER_ID),
    shipmentConfirmationIdempotencyKey(ORDER_ID),
  ];
  assert.equal(new Set(keys).size, 3, "two GLOA messages share an idempotency key");
  // And it follows the established gloa/<namespace>/<order-id> shape.
  for (const key of keys) assert.match(key, /^gloa\/[a-z-]+\/[0-9a-f-]{36}$/);
});

test("idempotency: the sender uses the deterministic key on every send", () => {
  assert.ok(senderCode.includes("cancellationRequestNotificationIdempotencyKey(order.id)"));
  assert.ok(senderCode.includes("{ idempotencyKey }"));
  // Exactly one send call.
  assert.equal([...senderCode.matchAll(/resend\.emails\.send\(/g)].length, 1);
});

/* ══════════════════════════════════════════════════════════════
   THE EMAIL: RECIPIENT AND SENDER
   ══════════════════════════════════════════════════════════════ */

test("email: the recipient is the fixed internal inbox", () => {
  assert.equal(GLOA_INTERNAL_ORDERS, "orders@gloamatcha.com");
  assert.ok(senderCode.includes("to: GLOA_INTERNAL_ORDERS"));
  // Not a parameter, not an environment variable, not from the request.
  assert.ok(!senderCode.includes("to: customerEmail"));
  assert.ok(!senderCode.includes("to: recipient"));
  assert.ok(!/process\.env/.test(senderCode), "the sender reads an environment variable");
});

test("email: the customer's address is shown as a fact and never used as a recipient", () => {
  // It appears in the email BODY so fulfillment can reply, and nowhere
  // near the `to`.
  const html = built().html;
  assert.ok(html.includes("kundin@example.com"), "the customer email is not shown to fulfillment");
  const send = senderCode.slice(senderCode.indexOf("resend.emails.send("));
  const args = send.slice(0, send.indexOf("{ idempotencyKey }"));
  assert.ok(args.includes("to: GLOA_INTERNAL_ORDERS"));
  assert.equal([...args.matchAll(/\bto:/g)].length, 1, "more than one recipient field");
  assert.ok(!args.includes("customer.email"));
});

test("email: the sender is the established GLOA brand address", () => {
  assert.equal(GLOA_FROM_HELLO, "GLOA <hello@gloamatcha.com>");
  assert.ok(senderCode.includes("from: GLOA_FROM_HELLO"));
  // Matching the internal new-order notification exactly: no replyTo on
  // internal mail.
  assert.ok(!senderCode.includes("replyTo"), "internal mail carries a replyTo");
  const internal = withoutComments(read("lib/internalOrderNotificationEmail.ts"));
  assert.ok(internal.includes("from: GLOA_FROM_HELLO"));
  assert.ok(internal.includes("to: GLOA_INTERNAL_ORDERS"));
});

test("email: the caller cannot choose recipient, subject, sender or HTML", () => {
  // The entry point takes an order id and nothing else.
  const entry = senderCode.slice(senderCode.indexOf("export async function sendCancellationRequestNotificationIfNeeded"));
  const signature = entry.slice(0, entry.indexOf(")"));
  assert.ok(signature.includes("orderId: string"));
  for (const forbidden of ["recipient", "to:", "subject", "html", "text", "note", "email"]) {
    assert.ok(!signature.includes(forbidden), `the entry point accepts ${forbidden}`);
  }
  // Subject, html and text all come from the template, built from the row.
  assert.ok(senderCode.includes("buildCancellationRequestNotificationEmail({ order: emailOrder })"));
});

/* ══════════════════════════════════════════════════════════════
   THE EMAIL: IT IS A REQUEST, NOT A CANCELLATION
   ══════════════════════════════════════════════════════════════ */

test("email: the subject says Stornierungsanfrage and names the order", () => {
  const { subject } = built();
  assert.equal(subject, `Stornierungsanfrage ${ORDER_NUMBER}`);
  assert.ok(subject.includes("anfrage"), "the subject does not say it is a request");
});

test("email: NOTHING claims the order was cancelled", () => {
  const { subject, html, text } = built({ requestNote: "Bitte stoppen." });
  for (const surface of [subject, html, text]) {
    // "Storniert" as a completed fact must not appear. The only permitted
    // occurrence is inside the word "Stornierungsanfrage" and in the
    // explicit NICHT storniert warning.
    const stripped = surface
      .split("Stornierungsanfrage").join("")
      .split("NICHT storniert").join("");
    assert.ok(!stripped.includes("storniert"), `a surface claims the order is cancelled: ${surface.slice(0, 80)}`);
    assert.ok(!stripped.includes("Storniert"), `a surface claims the order is cancelled`);
  }
});

test("email: it states explicitly that the order is not cancelled", () => {
  const { html, text } = built();
  assert.ok(html.includes("noch NICHT storniert"), "the HTML does not warn that nothing is cancelled");
  assert.ok(text.includes("noch NICHT storniert"), "the text does not warn that nothing is cancelled");
});

test("email: it fabricates no refund, no cancellation success and no tracking", () => {
  const { subject, html, text } = built();
  for (const surface of [subject, html, text]) {
    for (const fabricated of [
      "erstattet", "Erstattung ", "zurücküberwiesen", "Gutschrift",
      "Sendungsnummer", "Tracking", "DHL", "unterwegs", "versendet",
    ]) {
      assert.ok(!surface.includes(fabricated), `a surface fabricates ${fabricated}`);
    }
  }
  // And the template's ORDER TYPE has no field for any of them. Checked
  // against the type rather than the whole file, because the payment
  // label map legitimately names refund_pending / partially_refunded /
  // refunded: reporting a PERSISTED payment status is honest, and only
  // inventing a refund figure is not. See the next test.
  const orderType = templateCode.slice(
    templateCode.indexOf("export type CancellationRequestNotificationOrder"),
    templateCode.indexOf("export type BuiltCancellationRequestNotification")
  );
  for (const field of [
    "refund", "tracking", "carrier", "shipped_at", "items", "Address",
    "amount", "cancelled_at", "user_id",
  ]) {
    assert.ok(!orderType.includes(field), `the template carries a ${field} field`);
  }
});

test("email: a refunded order's status label is still allowed to say so", () => {
  // The distinction the previous test protects: reporting the PERSISTED
  // payment status is honest; inventing a refund is not.
  const { html } = built({ payment_status: "refunded" });
  assert.ok(html.includes("Erstattet"), "the persisted payment status is not reported");
});

/* ══════════════════════════════════════════════════════════════
   THE EMAIL: EXACT CONTENT
   ══════════════════════════════════════════════════════════════ */

test("email: the order number is always present in every surface", () => {
  const { subject, html, text } = built();
  for (const surface of [subject, html, text]) {
    assert.ok(surface.includes(ORDER_NUMBER), "the order number is missing");
  }
});

test("email: the request timestamp is the persisted one, never now", () => {
  const { html, text } = built({ requestedAt: "2026-08-24T09:30:00.000Z" });
  assert.ok(html.includes("Angefragt am"));
  assert.ok(text.includes("Angefragt am"));
  // Rendered in Europe/Berlin: 09:30 UTC is 11:30 CEST on 24 August.
  assert.ok(html.includes("24.08.2026"), "the request date is not rendered");
  // No clock is read anywhere in the template.
  for (const volatile of ["Date.now", "new Date()", "Math.random"]) {
    assert.ok(!templateCode.includes(volatile), `the template reads ${volatile}`);
  }
});

test("email: a missing timestamp omits the row rather than inventing one", () => {
  const { html, text } = built({ requestedAt: null });
  assert.ok(!html.includes("Angefragt am"), "a null timestamp produced a row");
  assert.ok(!text.includes("Angefragt am"));
  // And an unparseable value is treated the same way.
  assert.ok(!built({ requestedAt: "not-a-date" }).html.includes("Angefragt am"));
});

test("email: the customer note appears verbatim, only when one exists", () => {
  const withNote = built({ requestNote: "Ich habe die falsche Größe bestellt." });
  assert.ok(withNote.html.includes("Ich habe die falsche Größe bestellt."));
  assert.ok(withNote.text.includes("Ich habe die falsche Größe bestellt."));

  const withoutNote = built({ requestNote: null });
  assert.ok(withoutNote.html.includes("Kein Grund angegeben."));
  assert.ok(withoutNote.text.includes("Kein Grund angegeben."));
  assert.ok(!withoutNote.html.includes("falsche"), "a note leaked into a note-less email");
});

test("email: the note is escaped, because it is free text read in a mail client", () => {
  const { html } = built({ requestNote: '<script>alert("x")</script> & <b>' });
  assert.ok(!html.includes("<script>"), "an unescaped script tag reached the HTML");
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(html.includes("&amp;"));
});

test("email: the customer name is escaped too", () => {
  const { html } = built({ customerName: '<img src=x onerror=1> "Kundin"' });
  assert.ok(!html.includes("<img"), "an unescaped tag reached the HTML");
  assert.ok(html.includes("&lt;img"));
  assert.ok(html.includes("&quot;"));
});

test("email: absent customer name or email omit their rows, never a placeholder", () => {
  const { html, text } = built({ customerName: null, customerEmail: null });
  assert.ok(!html.includes("Kundin/Kunde</td>"), "a null name produced a row");
  assert.ok(!text.includes("E-Mail:"), "a null email produced a row");
  for (const placeholder of ["null", "undefined", "unbekannt", "N/A"]) {
    assert.ok(!text.includes(placeholder), `a placeholder was printed: ${placeholder}`);
  }
});

test("email: it reports the lifecycle a human needs to judge the request", () => {
  const { html, text } = built({ payment_status: "paid", fulfillment_status: "processing" });
  assert.ok(html.includes("Bezahlt"));
  assert.ok(html.includes("In Vorbereitung"));
  assert.ok(text.includes("Zahlung: Bezahlt"));
  assert.ok(text.includes("Fulfillment: In Vorbereitung"));
});

test("email: an unmapped lifecycle value prints the raw column rather than a smoothing label", () => {
  // The opposite of what the CUSTOMER-facing lib/orderStatus.ts does, and
  // deliberately: an operator is better served by the truth.
  const { text } = built({ payment_status: "some_future_state" });
  assert.ok(text.includes("some_future_state"));
});

test("email: the order total is reported, formatted, with its currency", () => {
  const { html, text } = built({ total_gross_cents: 4990, currency: "EUR" });
  assert.ok(html.includes("49,90 EUR"));
  assert.ok(text.includes("Bestellwert: 49,90 EUR"));
});

test("email: it carries no card data, no secret and no raw database object", () => {
  const { subject, html, text } = built({ requestNote: "test" });
  for (const surface of [subject, html, text]) {
    for (const forbidden of [
      "sk_", "whsec_", "re_", "pi_", "cus_", "sub_", "in_",
      "card", "Karte", "IBAN", "CVC", "PAN", "last4",
      "SECRET", "api_key", "Bearer", "customer_snapshot", "user_id",
      ORDER_ID,
    ]) {
      assert.ok(!surface.includes(forbidden), `a surface contains ${forbidden}`);
    }
  }
});

test("email: it carries no address and no item list", () => {
  // Deliberate. Fulfillment already received both in the "Neue
  // Bestellung" email for this order number, and neither answers the
  // question this message asks.
  const { html, text } = built();
  for (const surface of [html, text]) {
    for (const forbidden of ["Lieferadresse", "Zu packen", "Teststrasse", "Zwischensumme", "Versand:"]) {
      assert.ok(!surface.includes(forbidden), `a surface contains ${forbidden}`);
    }
  }
});

test("email: the template is a pure leaf, like its siblings", () => {
  assert.ok(!/from "\.\//.test(templateCode), "the template has a relative import");
  assert.ok(!templateCode.includes("supabase"), "the template touches the database");
  assert.ok(!templateCode.includes("fetch("), "the template makes a network call");
  const templates = readdirSync(path.join(ROOT, "lib/email")).sort();
  assert.deepEqual(templates, [
    "cancellationOutcome.ts", "cancellationRequestNotification.ts",
    "internalOrderNotification.ts", "orderConfirmation.ts",
    "shipmentConfirmation.ts", "withdrawalConfirmation.ts",
  ]);
});

test("email: it uses the established GLOA transactional branding", () => {
  const { html } = built();
  const internalTemplate = read("lib/email/internalOrderNotification.ts");
  // Same brand tokens as the sibling internal email.
  for (const token of ["#1746D1", "#A61E59", "#F5EBE2", "#4F3A5B"]) {
    assert.ok(html.includes(token), `the email is missing brand token ${token}`);
    assert.ok(internalTemplate.includes(token));
  }
  assert.ok(html.includes(">GLOA<"));
  assert.ok(html.includes("Fulfillment"));
  assert.ok(html.includes('<html lang="de">'));
  // Operational mail carries no marketing and no unsubscribe link.
  assert.ok(!html.includes("unsubscribe"));
  assert.ok(!html.includes("Abmelden"));
});

/* ══════════════════════════════════════════════════════════════
   ROUTE INTEGRATION AND ORDERING
   ══════════════════════════════════════════════════════════════ */

test("route: the notification is sent strictly AFTER the RPC returns", () => {
  const rpcAt = routeBody.indexOf('admin.rpc("request_order_cancellation"');
  const sendAt = routeBody.indexOf("sendCancellationRequestNotificationIfNeeded(orderId)");
  assert.ok(rpcAt > -1 && sendAt > -1);
  assert.ok(rpcAt < sendAt, "the notification is attempted before the request is durable");
});

test("route: authentication and validation both precede the RPC", () => {
  const authAt = routeBody.indexOf("verifyUserId(request)");
  const rpcAt = routeBody.indexOf('admin.rpc("request_order_cancellation"');
  const sendAt = routeBody.indexOf("sendCancellationRequestNotificationIfNeeded");
  assert.ok(authAt > -1);
  assert.ok(authAt < rpcAt, "the RPC runs before authentication");
  assert.ok(authAt < sendAt, "the notification runs before authentication");
  assert.ok(routeBody.indexOf("UUID_RE.test(orderId)") < rpcAt, "the RPC runs before validation");
  // Nothing reaches the database before the caller is known.
  assert.ok(authAt < routeBody.indexOf("getSupabaseAdmin()"), "the database is reached before authentication");
});

test("route: only the durable results reach the sender", () => {
  const branch = routeBody.slice(routeBody.indexOf('if (data === "requested" || data === "already_requested")'));
  const block = branch.slice(0, branch.indexOf("console.error(\"Cancellation request: unexpected"));
  assert.ok(block.includes("sendCancellationRequestNotificationIfNeeded(orderId)"));
  // not_found and not_eligible return before this branch is reached.
  const sendAt = routeBody.indexOf("sendCancellationRequestNotificationIfNeeded(orderId)");
  assert.ok(routeBody.indexOf('data === "not_found"') < sendAt);
  assert.ok(routeBody.indexOf('data === "not_eligible"') < sendAt);
  // Exactly one send call in the whole handler.
  assert.equal([...routeBody.matchAll(/sendCancellationRequestNotificationIfNeeded\(/g)].length, 1);
});

test("route: a repeat request re-enters the sender, which is the interim retry", () => {
  // 'already_requested' deliberately reaches the send. The claim decides
  // whether anything is actually mailed.
  const branch = routeBody.slice(routeBody.indexOf('if (data === "requested" || data === "already_requested")'));
  assert.ok(branch.indexOf("sendCancellationRequestNotificationIfNeeded") < branch.indexOf("Response.json"));
});

test("route: the sender receives only the order id", () => {
  const call = routeBody.slice(routeBody.indexOf("sendCancellationRequestNotificationIfNeeded("));
  const args = call.slice(call.indexOf("(") + 1, call.indexOf(")"));
  assert.equal(args.trim(), "orderId");
});

test("route: an email failure never changes the customer's outcome", () => {
  const branch = routeBody.slice(routeBody.indexOf('if (data === "requested" || data === "already_requested")'));
  const block = branch.slice(0, branch.indexOf("console.error(\"Cancellation request: unexpected"));
  // The outcome is logged, never returned, never thrown, never branched
  // into a different status code.
  assert.ok(!block.includes("status: 500"), "an email failure fails the request");
  assert.ok(!block.includes("status: 503"));
  assert.ok(!block.includes("throw"));
  assert.ok(block.includes("status: 200"));
  // And there is exactly one response in this branch.
  assert.equal([...block.matchAll(/Response\.json\(/g)].length, 1);
});

test("route: the customer response is unchanged and still truthful", () => {
  assert.ok(routeCode.includes("{ ok: true, state: data, message: REVIEW_MESSAGE } satisfies SuccessResponse"));
  assert.ok(route.includes(
    'const REVIEW_MESSAGE = "Wir prüfen, ob die Bestellung noch gestoppt werden kann, und melden uns per E-Mail.";'
  ));
  // Every message the handler returns is the one shared constant - never
  // an ad-hoc string. routeBody, so the `message: string;` field of the
  // SuccessResponse type alias is not read as a response payload.
  const responses = [...routeBody.matchAll(/message: ([^,}]*)/g)].map(m => m[1]);
  assert.ok(responses.length > 0);
  for (const value of responses) assert.ok(value.includes("REVIEW_MESSAGE"), `an ad-hoc message: ${value}`);
  for (const forbidden of ["storniert", "erstattet", "Geld", "zurücküberwiesen", "Gutschrift"]) {
    assert.ok(!routeBody.includes(forbidden), `the route tells the customer ${forbidden}`);
  }
});

test("route: internal email state never leaks into the customer response", () => {
  // The success payload itself, not the surrounding handler.
  const at = routeBody.lastIndexOf("{ ok: true, state: data");
  const payload = routeBody.slice(at, routeBody.indexOf("satisfies SuccessResponse", at));
  for (const forbidden of ["notification", "emailOutcome", "sending", "sent", "failed"]) {
    assert.ok(!payload.includes(forbidden), `the response exposes ${forbidden}`);
  }
  // The response shape is exactly what it was before this task: three
  // fields, and none of them is about email.
  const fields = [...payload.matchAll(/(\w+):/g)].map(m => m[1]);
  assert.deepEqual(fields.sort(), ["message", "ok", "state"]);
  assert.ok(route.includes('state: "requested" | "already_requested";'));
});

test("route: the RPC and its arguments are unchanged", () => {
  const call = routeCode.slice(routeCode.indexOf('admin.rpc("request_order_cancellation"'));
  const args = call.slice(0, call.indexOf("});"));
  assert.ok(args.includes("p_order_id: orderId"));
  assert.ok(args.includes("p_user_id: userId"));
  assert.ok(args.includes("p_note: trimmedNote"));
  const params = [...args.matchAll(/(p_\w+):/g)].map(m => m[1]);
  assert.deepEqual(params, ["p_order_id", "p_user_id", "p_note"]);
});

test("route: it performs no table write of its own", () => {
  for (const forbidden of ['.from("orders")', ".update(", ".insert(", ".delete("]) {
    assert.ok(!routeCode.includes(forbidden), `the route writes directly: ${forbidden}`);
  }
  const rpcs = [...routeCode.matchAll(/\.rpc\("(\w+)"/g)].map(m => m[1]);
  assert.deepEqual(rpcs, ["request_order_cancellation"]);
});

/* ══════════════════════════════════════════════════════════════
   SECURITY
   ══════════════════════════════════════════════════════════════ */

test("security: ownership is still enforced in the database against the verified user", () => {
  const migration019 = read("supabase/migrations/019_order_lifecycle_tracking.sql");
  assert.ok(migration019.includes("where id = p_order_id"));
  assert.ok(migration019.includes("and user_id = p_user_id"));
  // A foreign order and a missing order are both 'not_found'.
  assert.ok(migration019.includes("return 'not_found';"));
  // And a 'not_found' returns before the sender is reachable, so a
  // foreign order can never produce an internal email.
  assert.ok(
    routeBody.indexOf('data === "not_found"') <
      routeBody.indexOf("sendCancellationRequestNotificationIfNeeded(orderId)")
  );
});

test("security: the sender is server-only and unreachable from a browser", () => {
  for (const rel of ["app/GloaSite.tsx", "app/AccountPortal.tsx", "app/Chrome.tsx", "app/createCheckoutSession.ts"]) {
    const source = read(rel);
    assert.ok(!source.includes("sendCancellationRequestNotificationIfNeeded"), `${rel} calls the sender`);
    assert.ok(!source.includes("cancellation_request_notification"), `${rel} reads the notification state`);
    assert.ok(!source.includes("GLOA_INTERNAL_ORDERS"), `${rel} names the internal inbox`);
    assert.ok(!source.includes("orders@gloamatcha.com"), `${rel} hardcodes the internal inbox`);
  }
});

test("security: only the one route can reach the sender", () => {
  const callers = [];
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      const source = withoutComments(readFileSync(full, "utf-8"));
      if (source.includes("sendCancellationRequestNotificationIfNeeded")) {
        callers.push(path.relative(ROOT, full).split(path.sep).join("/"));
      }
    }
  };
  walk(path.join(ROOT, "app"));
  walk(path.join(ROOT, "lib"));
  assert.deepEqual(callers.sort(), [
    "app/api/orders/cancellation-request/route.ts",
    "lib/cancellationRequestNotificationEmail.ts",
  ]);
});

test("security: no new public RPC and no new grant to a browser role", () => {
  assert.ok(!sql030.includes("create or replace function"), "030 creates a function");
  assert.ok(!/to (anon|authenticated|public)\b/i.test(sql030), "030 grants a browser role something");
});

test("security: no secret reaches the client bundle", () => {
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
      "sendCancellationRequestNotificationIfNeeded", "GLOA_INTERNAL_ORDERS",
      "orders@gloamatcha.com", "cancellation_request_notification_status",
      "RESEND_API_KEY", "CANCELLATION_ADMIN_SECRET",
    ]) {
      if (source.includes(needle)) leaks.push(`${path.relative(ROOT, file)}: ${needle}`);
    }
  }
  assert.deepEqual(leaks, [], `server-only material reached the client bundle: ${leaks.join(", ")}`);
});

test("logging: no PII and no customer note reaches a log line", () => {
  for (const source of [routeCode, senderCode]) {
    const logs = [...source.matchAll(/console\.\w+\(([\s\S]*?)\);/g)].map(m => m[1]);
    for (const line of logs) {
      for (const forbidden of [
        "note", "Note", "customer.", "customerEmail", "customerName",
        "snapshot", "address", "rawBody", "JSON.stringify", "emailOrder",
      ]) {
        assert.ok(!line.includes(forbidden), `a log line contains ${forbidden}: ${line}`);
      }
    }
  }
  // The order id is the one identifier logged by the sender.
  assert.ok(senderCode.includes("order ${orderId}") || senderCode.includes("order ${order.id}"));
});

/* ══════════════════════════════════════════════════════════════
   REGRESSIONS
   ══════════════════════════════════════════════════════════════ */

test("regression: POST /api/internal/orders/cancel is unchanged", () => {
  const cancelRoute = withoutComments(read("app/api/internal/orders/cancel/route.ts"));
  const rpcs = [...cancelRoute.matchAll(/\.rpc\("(\w+)"/g)].map(m => m[1]);
  assert.deepEqual(rpcs, ["cancel_order"]);
  assert.ok(cancelRoute.includes("process.env.CANCELLATION_ADMIN_SECRET"));
  assert.ok(!cancelRoute.includes("sendCancellationRequestNotificationIfNeeded"),
    "the operator cancel route now sends the request notification");
  assert.ok(!cancelRoute.includes("cancellation_request_notification"));
  // It still imports exactly three modules and no email sender.
  const imports = [...cancelRoute.matchAll(/^import[\s\S]*?from "([^"]+)";$/gm)].map(m => m[1]);
  assert.equal(imports.length, 3, "the cancel route gained an import");
});

test("regression: the operator secrets are unchanged and still separate", () => {
  const example = read(".env.example");
  for (const name of ["CANCELLATION_ADMIN_SECRET", "FULFILLMENT_ADMIN_SECRET", "CRON_SECRET"]) {
    assert.match(example, new RegExp(`^${name}=$`, "m"), `${name} gained a value or vanished`);
  }
  // Nothing in this task reads any of them.
  for (const source of [routeCode, senderCode, rulesCode, templateCode]) {
    for (const name of ["CANCELLATION_ADMIN_SECRET", "FULFILLMENT_ADMIN_SECRET", "CRON_SECRET"]) {
      assert.ok(!source.includes(name), `this feature reads ${name}`);
    }
  }
});

test("regression: the shipment endpoint and its RPC are unchanged", () => {
  const shipRoute = withoutComments(read("app/api/internal/orders/ship/route.ts"));
  const rpcs = [...shipRoute.matchAll(/\.rpc\("(\w+)"/g)].map(m => m[1]);
  assert.deepEqual(rpcs, ["mark_order_shipped"]);
  assert.ok(shipRoute.includes("sendShipmentConfirmationIfNeeded(orderId)"));
  assert.ok(!shipRoute.includes("cancellation"), "the ship route learned about cancellation");
});

test("regression: THE DOCUMENTED GAP - still no cancellation_requested_at shipment guard", () => {
  // Deliberate. There is still no declined/resolved state for a request,
  // so a request the owner decides not to grant would otherwise block
  // that order's shipment forever.
  const shipRoute = withoutComments(read("app/api/internal/orders/ship/route.ts"));
  const migration028 = withoutComments(read("supabase/migrations/028_authorized_shipment_transition.sql"));
  assert.ok(!shipRoute.includes("cancellation_requested_at"));
  assert.ok(!migration028.includes("cancellation_requested_at"));
  // And no resolution column was added by this task either.
  for (const column of ["cancellation_declined_at", "cancellation_resolved_at", "cancellation_request_state"]) {
    assert.ok(!sql030.includes(column), `030 added ${column}`);
  }
});

test("regression: the refund webhook flow is untouched", () => {
  const webhook = withoutComments(read("app/api/stripe/webhook/route.ts"));
  assert.ok(webhook.includes("isRefundEventType(event.type)"));
  assert.ok(webhook.includes("syncOrderRefundStateFromStripe(stripe, paymentIntentId)"));
  assert.ok(!webhook.includes("cancellation"), "the webhook learned about cancellation requests");
  const refunds = read("lib/stripeRefunds.ts");
  for (const event of [
    "charge.refunded", "charge.refund.updated", "refund.created", "refund.updated", "refund.failed",
  ]) {
    assert.ok(refunds.includes(`"${event}"`), `the refund event set lost ${event}`);
  }
  assert.ok(read("lib/orderRefunds.ts").includes('admin.rpc("apply_order_refund_state"'));
});

test("regression: no Stripe write API anywhere in the repository", () => {
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
  // And this feature imports no Stripe client at all.
  for (const source of [routeCode, senderCode, templateCode, rulesCode]) {
    assert.ok(!source.includes("stripe"), "this feature touches Stripe");
    assert.ok(!source.includes("Stripe"), "this feature touches Stripe");
  }
});

test("regression: the other four emails and their state columns are untouched", () => {
  for (const other of [
    "sendOrderConfirmationEmailIfNeeded", "confirmation_email_status",
    "sendInternalOrderNotificationIfNeeded", "internal_notification_status",
    "sendShipmentConfirmationIfNeeded", "shipment_email_status",
    "buildWithdrawalConfirmationEmail",
  ]) {
    assert.ok(!routeCode.includes(other), `the request route triggers ${other}`);
    assert.ok(!senderCode.includes(other), `the sender touches ${other}`);
    assert.ok(!sql030.includes(other), `030 touches ${other}`);
  }
  // The webhook still sends exactly the two it always sent.
  const webhook = withoutComments(read("app/api/stripe/webhook/route.ts"));
  assert.ok(webhook.includes("sendOrderConfirmationEmailIfNeeded("));
  assert.ok(webhook.includes("sendInternalOrderNotificationIfNeeded("));
});

test("regression: THIS message stays internal-only, separate from the outcome email", () => {
  // Phase 2D-B added cancellationOutcome.ts, the CUSTOMER's answer. It is
  // a different message with a different recipient, a different template
  // and a different idempotency namespace. This one must stay internal.
  const templates = readdirSync(path.join(ROOT, "lib/email")).sort();
  assert.equal(templates.length, 6, "an unexpected template was added");
  assert.ok(templates.includes("cancellationRequestNotification.ts"));
  assert.ok(templates.includes("cancellationOutcome.ts"));
  // The REQUEST notification still goes to the internal inbox and carries
  // no customer reply-to.
  assert.ok(!senderCode.includes("GLOA_REPLY_TO_SUPPORT"), "the internal mail carries a customer reply-to");
  assert.ok(senderCode.includes("to: GLOA_INTERNAL_ORDERS"));
  // And it never learned to send the customer's outcome mail.
  assert.ok(!senderCode.includes("sendCancellationOutcomeEmailIfNeeded"));
  assert.ok(!routeCode.includes("sendCancellationOutcomeEmailIfNeeded"),
    "the customer request route now mails an outcome");
});

test("regression: no new cron job was registered", () => {
  const vercel = JSON.parse(read("vercel.json"));
  assert.equal((vercel.crons ?? []).length, 1, "a cron job was added");
  assert.equal(vercel.crons[0].path, "/api/cron/retry-order-notifications");
  // And the existing retry sweep did not learn about this message.
  const cron = withoutComments(read("app/api/cron/retry-order-notifications/route.ts"));
  assert.ok(!cron.includes("cancellation"), "the cron now sweeps cancellation requests");
  assert.ok(!withoutComments(read("lib/internalOrderNotificationRetry.ts")).includes("cancellation_request"));
});

test("regression: the account UI is unchanged", () => {
  const portal = read("app/AccountPortal.tsx");
  assert.ok(portal.includes('fetch("/api/orders/cancellation-request"'));
  assert.ok(portal.includes("Stornierung anfragen"));
  // It still reads only body.message and body.error from the response.
  assert.ok(!portal.includes("notification"));
  assert.ok(!portal.includes("emailOutcome"));
});

test("regression: SHOP_STATUS and B2C_SUBSCRIPTIONS_ENABLED are unchanged", () => {
  assert.ok(read("app/content.ts").includes('export const SHOP_STATUS = "prelaunch" as const;'));
  assert.match(read(".env.example"), /^B2C_SUBSCRIPTIONS_ENABLED=$/m);
  for (const source of [routeCode, senderCode, templateCode, rulesCode]) {
    for (const forbidden of ["B2C_SUBSCRIPTIONS_ENABLED", "SHOP_STATUS", "subscription"]) {
      assert.ok(!source.includes(forbidden), `this feature touches ${forbidden}`);
    }
  }
  assert.ok(!sql030.toLowerCase().includes("subscription"), "030 touches subscriptions");
});

test("regression: pricing, tax and shipping are untouched", () => {
  for (const source of [routeCode, senderCode, sql030]) {
    for (const forbidden of [
      "price_gross_cents", "computeShippingGrossCents", "resolveCheckoutTax",
      "SHIPPING_ZONES", "tax_total_cents", "subtotal_gross_cents",
    ]) {
      assert.ok(!source.includes(forbidden), `this feature touches ${forbidden}`);
    }
  }
});

/* ══════════════════════════════════════════════════════════════
   THE HTTP BOUNDARY, ON A REAL SPAWNED SERVER
   ══════════════════════════════════════════════════════════════ */

const ENDPOINT_PATH = "/api/orders/cancellation-request";

/**
 * The server is started without SUPABASE_SECRET_KEY and without
 * RESEND_API_KEY, so no database is reachable and no Resend client can be
 * constructed. No cancellation request can be recorded and no email of
 * any kind can be sent by this suite.
 */
function serverEnv(extra) {
  const env = writeBlockedServerEnv({ ...extra });
  delete env.RESEND_API_KEY;
  delete env.RESEND_CONTACT_FROM;
  delete env.CANCELLATION_ADMIN_SECRET;
  delete env.FULFILLMENT_ADMIN_SECRET;
  return env;
}

async function startServer(port, extraEnv) {
  const child = spawn(process.execPath, [".output/server/index.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: serverEnv({ PORT: String(port), ...extraEnv }),
    stdio: "ignore",
  });

  await new Promise((resolveReady, rejectReady) => {
    child.once("exit", code => rejectReady(new Error(`server exited early (code ${code})`)));
    (async () => {
      for (let attempt = 0; attempt < 50; attempt++) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/`);
          if (res.ok) return resolveReady();
        } catch {
          // not up yet
        }
        await delay(200);
      }
      rejectReady(new Error("server did not become ready in time"));
    })();
  });

  return child;
}

const post = (port, payload, headers = {}) =>
  fetch(`http://127.0.0.1:${port}${ENDPOINT_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  });

const PORT = 8948;
let server;

test.before(async () => {
  server = await startServer(PORT, {});
});

test.after(() => {
  server?.kill();
});

test("http: an unauthenticated customer cannot request a cancellation", async () => {
  const res = await post(PORT, { orderId: ORDER_ID });
  assert.equal(res.status, 401);
  const parsed = await res.json();
  assert.equal(parsed.error, "Bitte melde dich an.");
  assert.equal(parsed.ok, undefined);
});

test("http: a malformed or absent bearer token is not authentication", async () => {
  for (const authorization of [
    "Bearer", "Bearer ", "Bearer nonsense", "Basic abc",
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyIn0.notarealsignature",
  ]) {
    const res = await post(PORT, { orderId: ORDER_ID }, { authorization });
    assert.equal(res.status, 401, authorization);
  }
});

test("http: authentication is checked before any order id is looked at", async () => {
  // An unauthenticated caller learns nothing about which orders exist.
  const valid = await post(PORT, { orderId: ORDER_ID });
  const malformedId = await post(PORT, { orderId: "not-a-uuid" });
  const noId = await post(PORT, {});
  for (const res of [valid, malformedId, noId]) assert.equal(res.status, 401);
});

test("http: a malformed body is refused as a generic bad request", async () => {
  // 400, not 401. The route shape-checks the envelope (content type, size,
  // parseability) before it authenticates, which is pre-existing and
  // unchanged by this task. It is safe because the refusal is generic and
  // says nothing about any order: an anonymous caller learns only that
  // their JSON was malformed, which they already knew.
  const res = await post(PORT, "{not json");
  assert.equal(res.status, 400);
  const parsed = await res.json();
  assert.equal(parsed.error, "Ungültige Anfrage.");
  assert.equal(parsed.ok, undefined);
});

test("http: nothing reaches the database or the mailer before authentication", async () => {
  // A well-formed body from an anonymous caller stops at 401 - before the
  // RPC, and therefore before any notification could be attempted.
  for (const payload of [{ orderId: ORDER_ID }, { orderId: ORDER_ID, note: "x" }, { orderId: null }]) {
    const res = await post(PORT, payload);
    assert.equal(res.status, 401, JSON.stringify(payload));
  }
});

test("http: a non-JSON content type is refused", async () => {
  const res = await fetch(`http://127.0.0.1:${PORT}${ENDPOINT_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: "orderId=x",
  });
  assert.equal(res.status, 400);
});

test("http: GET, PUT, PATCH and DELETE are not mutation surfaces", async () => {
  for (const method of ["GET", "PUT", "PATCH", "DELETE"]) {
    const res = await fetch(`http://127.0.0.1:${PORT}${ENDPOINT_PATH}`, { method });
    assert.ok(res.status === 404 || res.status === 405, `${method} answered ${res.status}`);
  }
});

test("http: no response ever claims a cancellation, a refund or a sent email", async () => {
  const responses = await Promise.all([
    post(PORT, { orderId: ORDER_ID }),
    post(PORT, { orderId: "not-a-uuid" }),
    post(PORT, {}),
  ]);
  for (const res of responses) {
    const text = await res.text();
    for (const forbidden of [
      "storniert", "erstattet", "orders@gloamatcha.com",
      "cancellation_request_notification", "sending", "RESEND",
    ]) {
      assert.ok(!text.includes(forbidden), `a response contained ${forbidden}`);
    }
  }
});

test("no real Resend request, no Stripe request and no production Supabase in this suite", () => {
  const suite = withoutComments(read("tests/cancellation-request-notification.test.mjs"));
  const forbidden = [
    ["create", "Client("], ["new ", "Resend("], ["new ", "Stripe("],
    ["supabase", ".co"], ["api.", "resend.com"], ["api.", "stripe.com"],
  ].map(parts => parts.join(""));
  for (const needle of forbidden) {
    assert.ok(!suite.includes(needle), `the suite performs: ${needle}`);
  }
  // Every spawned server is started through serverEnv, which strips the
  // service-role key and the Resend key.
  const spawns = [...suite.matchAll(/spawn\(process\.execPath[\s\S]*?\}\)/g)];
  assert.equal(spawns.length, 1, "a server is spawned outside the guarded helper");
  assert.ok(spawns[0][0].includes("serverEnv("));
});
