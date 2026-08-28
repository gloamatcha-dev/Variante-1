import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SUBSCRIPTION_EMAIL_FAMILIES,
  SUBSCRIPTION_EMAIL_STATUSES,
  SUBSCRIPTION_ENDED_FAMILY,
  evaluateSubscriptionEndedPreflight,
  recipientFromCustomerSnapshot,
  subscriptionEndedEventKey,
} from "../lib/subscriptionEmailDeliveryRules.ts";
import {
  buildSubscriptionEndedEmail,
  subscriptionEndedIdempotencyKey,
} from "../lib/email/subscriptionEnded.ts";
import { subscriptionStartedIdempotencyKey } from "../lib/email/subscriptionStarted.ts";
import { cancellationConfirmationIdempotencyKey } from "../lib/email/cancellationConfirmation.ts";
import { GLOA_FROM_HELLO, GLOA_REPLY_TO_SUPPORT } from "../lib/emailSenders.ts";

// SAFE DEFAULT SUITE: pure rule and template logic plus source-level
// checks. No server is spawned, no database is reachable, no Supabase
// client is constructed, no Stripe API is called, no subscription is
// created or deleted and no email of any kind is sent. Nothing here
// executes SQL and nothing here requires TEST_SUPABASE_*.
//
// The rules this suite protects: a customer is told their subscription
// has ended exactly once, only after the local row is authoritatively and
// terminally cancelled, never with a reason this system cannot prove, and
// never in a way that a crash between the termination write and the email
// claim could silently swallow.

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

const sender = read("lib/subscriptionEndedEmail.ts");
const rules = read("lib/subscriptionEmailDeliveryRules.ts");
const template = read("lib/email/subscriptionEnded.ts");
const service = read("lib/subscriptionCancellation.ts");
const route = read("app/api/subscriptions/cancel/route.ts");
const webhook = read("app/api/stripe/webhook/route.ts");
const cron = read("app/api/cron/retry-order-notifications/route.ts");
const migration022 = read("supabase/migrations/022_recurring_subscription_foundation.sql");
const migration034 = read("supabase/migrations/034_subscription_cancellation.sql");
const migration035 = read(`supabase/migrations/${MIGRATION_035}`);

const senderCode = withoutComments(sender);
const rulesCode = withoutComments(rules);
const templateCode = withoutComments(template);
const serviceCode = withoutComments(service);
const routeCode = withoutComments(route);
const webhookCode = withoutComments(webhook);
const cronCode = withoutComments(cron);
const sql022 = withoutComments(migration022);
const sql034 = withoutComments(migration034);
const sql035 = withoutComments(migration035);

const SUBSCRIPTION_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const STARTED_AT = "2026-01-09T10:00:00.000Z";
const ENDED_AT = "2026-10-03T00:00:00.000Z";

/** A subscription in its authoritative final state. */
const subscription = (overrides = {}) => ({
  id: SUBSCRIPTION_ID,
  customer_type: "private",
  status: "cancelled",
  customer_snapshot: { email: "kundin@example.com", name: "Mia" },
  started_at: STARTED_AT,
  cancelled_at: ENDED_AT,
  ...overrides,
});

/** The question asked before any delivery row exists. */
const eligibility = (overrides = {}) =>
  evaluateSubscriptionEndedPreflight({ subscription: subscription(overrides), claimed: false });

/** The authoritative question, asked for a row already claimed. */
const claimed = (overrides = {}) =>
  evaluateSubscriptionEndedPreflight({ subscription: subscription(overrides), claimed: true });

const built = (facts = {}) =>
  buildSubscriptionEndedEmail({
    subscription: {
      endedAtIso: ENDED_AT,
      accountUrl: "https://gloamatcha.com/account/orders",
      ...facts,
    },
  });

/** One top-level `export async function NAME` body from the service. */
const serviceFn = name => {
  const at = serviceCode.indexOf(`export async function ${name}(`);
  assert.notEqual(at, -1, `${name} disappeared`);
  const next = serviceCode.indexOf(`${NEWLINE}export `, at + 1);
  return serviceCode.slice(at, next === -1 ? serviceCode.length : next);
};

/** One top-level `async function NAME` body from the webhook route. */
const handlerBody = name => {
  const at = webhookCode.indexOf(`async function ${name}(`);
  assert.notEqual(at, -1, `${name} disappeared`);
  const next = webhookCode.indexOf(`${NEWLINE}async function `, at + 1);
  return webhookCode.slice(at, next === -1 ? webhookCode.length : next);
};

/* ══════════════════════════════════════════════════════════════
   1-5. ONLY THE FINAL TERMINATION MAY SEND IT
   ══════════════════════════════════════════════════════════════ */

test("1: customer.subscription.deleted is the only canonical trigger", () => {
  // The dispatcher routes the deleted event to the termination handler,
  // and that handler drives the only writer of status = 'cancelled'.
  assert.ok(webhookCode.includes('} else if (event.type === "customer.subscription.deleted") {'));
  assert.ok(handlerBody("handleSubscriptionDeleted").includes("markSubscriptionCancelledFromStripe("));

  // The sender is reached from exactly one place in the whole codebase.
  const calls = serviceCode.match(/sendSubscriptionEndedEmailIfNeeded\(/g) ?? [];
  assert.equal(calls.length, 1, "the ending must have exactly one call site");
  assert.ok(serviceFn("markSubscriptionCancelledFromStripe").includes("sendSubscriptionEndedEmailIfNeeded("),
    "the ending must be sent by the termination writer");
});

test("2: a cancellation request does not send the ending", () => {
  // The customer's cancellation schedules an END DATE. The subscription
  // is still running and still shipping, so the ending must not fire.
  const fn = serviceFn("cancelSubscriptionForUser");
  assert.ok(fn.includes("sendCancellationConfirmationEmailIfNeeded("), "the confirmation still fires");
  assert.ok(!fn.includes("sendSubscriptionEndedEmailIfNeeded("), "the request must not end anything");
  assert.ok(!routeCode.includes("subscriptionEndedEmail"), "the cancel route must not send an ending");
  // Nor may the deferred apply or the safety sweep, which only move a date.
  for (const name of ["applyDeferredCancellationFromRenewal", "sweepDueDeferredCancellations"]) {
    assert.ok(!serviceFn(name).includes("sendSubscriptionEndedEmailIfNeeded("),
      `${name} must not send an ending`);
  }
  assert.ok(!cronCode.includes("subscriptionEndedEmail"));
});

test("3: customer.subscription.updated does not send the ending", () => {
  assert.ok(!handlerBody("handleSubscriptionUpdated").includes("sendSubscriptionEndedEmailIfNeeded"));
  // The reconciliation writer sends the CONFIRMATION when a date moves,
  // and never the ending: it writes no status at all.
  const fn = serviceFn("syncSubscriptionFromStripe");
  assert.ok(fn.includes("sendCancellationConfirmationEmailIfNeeded("));
  assert.ok(!fn.includes("sendSubscriptionEndedEmailIfNeeded("));
  // And that is structural, not a convention: sync_subscription_from_stripe
  // writes five columns and status is not one of them, so a reconciliation
  // can never produce the terminal state this email reports.
  const syncStart = sql034.indexOf("create or replace function public.sync_subscription_from_stripe");
  const syncBody = sql034.slice(syncStart, sql034.indexOf("$$;", syncStart));
  assert.ok(syncStart !== -1 && syncBody.includes("update public.subscriptions"));
  assert.ok(!/\bset[\s\S]*?\bstatus\s*=/.test(syncBody),
    "the Stripe reconciliation now writes subscriptions.status");
});

test("4-5: invoice.paid and checkout.session.completed do not send the ending", () => {
  for (const handler of [
    "handleInvoicePaid",
    "handleSubscriptionSessionCompleted",
    "handleCheckoutSessionCompleted",
    "handleRefundEvent",
  ]) {
    assert.ok(!handlerBody(handler).includes("sendSubscriptionEndedEmailIfNeeded"),
      `${handler} must not send the ending`);
  }
  // And the webhook route never reaches the sender directly at all: it
  // goes through the termination writer, like every other family.
  assert.ok(!webhookCode.includes("subscriptionEndedEmail"),
    "the webhook must reach the ending only through the termination writer");
});

/* ══════════════════════════════════════════════════════════════
   6-11. DURABLE STATE FIRST, AND THE CRASH WINDOW
   ══════════════════════════════════════════════════════════════ */

test("6: the local cancelled state is durable before the email is attempted", () => {
  const fn = serviceFn("markSubscriptionCancelledFromStripe");
  const rpcAt = fn.indexOf('admin.rpc("mark_subscription_cancelled"');
  const sendAt = fn.indexOf("sendSubscriptionEndedEmailIfNeeded(");
  assert.ok(rpcAt !== -1 && sendAt !== -1);
  assert.ok(rpcAt < sendAt, "the durable write must commit before the customer is told");
  // And the sender re-reads the row itself rather than trusting the call.
  assert.ok(senderCode.includes('.from("subscriptions")'));
  assert.ok(senderCode.includes("status, customer_snapshot, started_at, cancelled_at"));
});

test("7: the exact mark_subscription_cancelled vocabulary is pinned", () => {
  // Three results, and only three. A fourth added later must be reviewed
  // against the ending rather than silently ignored or silently trusted.
  for (const result of ["'not_found'", "'already_cancelled'", "'cancelled'"]) {
    assert.ok(sql034.includes(`'result', ${result}`), `034 no longer returns ${result}`);
  }
  const fnStart = sql034.indexOf("create or replace function public.mark_subscription_cancelled");
  const body = sql034.slice(fnStart, sql034.indexOf("$$;", fnStart));
  const results = [...body.matchAll(/'result', '([a-z_]+)'/g)].map(m => m[1]);
  assert.deepEqual([...new Set(results)].sort(), ["already_cancelled", "cancelled", "not_found"]);
  // Both terminal results carry the LOCAL id; not_found cannot.
  assert.equal((body.match(/'subscription_id', v_sub\.id/g) ?? []).length, 2);
});

test("8: the first-transition result reaches the sender", () => {
  const fn = serviceFn("markSubscriptionCancelledFromStripe");
  assert.ok(fn.includes('result === "cancelled"'), "'cancelled' must reach the sender");
});

test("9: the already-terminal result ALSO reaches the sender", () => {
  // This is the crash-window requirement, and it is the reason the gate
  // is not written as "only the first transition".
  const fn = serviceFn("markSubscriptionCancelledFromStripe");
  assert.ok(fn.includes('result === "already_cancelled"'),
    "'already_cancelled' must reach the sender or a crash loses the message");
  assert.ok(fn.includes('(result === "cancelled" || result === "already_cancelled")'),
    "both terminal results must gate the send together");
});

test("10: non-terminal, not-found and error outcomes never send", () => {
  const fn = serviceFn("markSubscriptionCancelledFromStripe");
  // The gate names the two terminal results and nothing else.
  for (const proves of ["not_found", "unknown"]) {
    assert.ok(!fn.includes(`result === "${proves}"`), `${proves} must not gate a send`);
  }
  // An RPC error returns before the gate is ever reached.
  const errorAt = fn.indexOf('return "error";');
  const sendAt = fn.indexOf("sendSubscriptionEndedEmailIfNeeded(");
  assert.ok(errorAt !== -1 && errorAt < sendAt);
  // The local id is required too, so a payload without one sends nothing.
  assert.ok(fn.includes('typeof payload.subscription_id === "string"'));
  // And the sender itself refuses a subscription that is not cancelled.
  for (const status of ["active", "pending", "past_due", "unpaid", "paused"]) {
    assert.equal(eligibility({ status }).kind, "not-eligible", status);
  }
});

test("11: a crash after the durable write is recoverable by redelivery", () => {
  // The whole chain, asserted as one property:
  //   the redelivery gets 'already_cancelled' ...
  const fn = serviceFn("markSubscriptionCancelledFromStripe");
  assert.ok(fn.includes('result === "already_cancelled"'));
  //   ... the row is still terminally cancelled, so the preflight sends ...
  assert.equal(eligibility().kind, "send");
  //   ... and the claim, not the result word, is what stops a duplicate.
  assert.ok(senderCode.includes("ignoreDuplicates: true"));
  assert.ok(senderCode.includes('if (claim.kind === "taken") return "already-claimed";'));
  //   ... and cancelled_at was NOT moved by the redelivery, so the date
  //   the customer finally sees is the original one.
  const markFn = sql034.slice(
    sql034.indexOf("create or replace function public.mark_subscription_cancelled"),
    sql034.indexOf("$$;", sql034.indexOf("create or replace function public.mark_subscription_cancelled"))
  );
  const alreadyAt = markFn.indexOf("'already_cancelled'");
  const updateAt = markFn.indexOf("update public.subscriptions");
  assert.ok(alreadyAt !== -1 && updateAt !== -1);
  assert.ok(alreadyAt < updateAt, "the idempotent return must precede the write");
});

/* ══════════════════════════════════════════════════════════════
   12-19. THE EVENT KEY AND THE CLAIM
   ══════════════════════════════════════════════════════════════ */

test("12: the event key is the subscription id, and terminality proves it safe", () => {
  assert.equal(subscriptionEndedEventKey(SUBSCRIPTION_ID), SUBSCRIPTION_ID);
  assert.equal(subscriptionEndedEventKey(SUBSCRIPTION_ID.toUpperCase()), SUBSCRIPTION_ID);
  assert.equal(subscriptionEndedEventKey(`  ${SUBSCRIPTION_ID} `), SUBSCRIPTION_ID);
  for (const blank of ["", "   ", null, undefined]) {
    assert.equal(subscriptionEndedEventKey(blank), null);
  }

  // THE PROOF, asserted against the live SQL rather than trusted.
  // 1. A cancelled row can never be activated again: 022 refuses every
  //    status outside the four it names, and RAISES.
  assert.ok(sql022.includes("if v_subscription.status not in ('pending', 'active', 'past_due', 'unpaid') then"),
    "022 no longer refuses to activate a cancelled subscription");
  assert.ok(!sql022.includes("'pending', 'active', 'past_due', 'unpaid', 'cancelled'"));
  // 2. It can never be bound to a replacement Stripe subscription.
  assert.ok(sql022.includes("coalesce(v_subscription.stripe_subscription_id, p_stripe_subscription_id)"));
  assert.ok(sql022.includes("is already bound to a different stripe subscription"));
  // 3. The termination itself is idempotent, so one row ends once.
  assert.ok(sql034.includes("if v_sub.status = 'cancelled' then"));
});

test("12b: exactly two statements in the whole schema write subscriptions.status", () => {
  // The claim the event key rests on. Counted across every migration so a
  // third writer added later fails here rather than in production.
  const writers = [];
  for (const name of readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith(".sql")).sort()) {
    const sql = withoutComments(readFileSync(path.join(MIGRATIONS_DIR, name), "utf-8"));
    // Only writes to public.subscriptions, never to public.orders.
    for (const m of sql.matchAll(/update public\.subscriptions[\s\S]{0,900}?;/g)) {
      if (/\bset[\s\S]*?\bstatus\s*=/.test(m[0])) writers.push(`${name}`);
    }
  }
  assert.deepEqual([...new Set(writers)].sort(), [
    "022_recurring_subscription_foundation.sql",
    "034_subscription_cancellation.sql",
  ], "a third writer of subscriptions.status appeared");
});

test("13: the same subscription cannot create a duplicate ended delivery", () => {
  const keys = new Set([
    subscriptionEndedEventKey(SUBSCRIPTION_ID),
    subscriptionEndedEventKey(SUBSCRIPTION_ID),
    subscriptionEndedEventKey(SUBSCRIPTION_ID.toUpperCase()),
  ]);
  assert.equal(keys.size, 1);
  assert.ok(sql035.includes("unique (subscription_id, family, event_key)"));
  assert.equal(SUBSCRIPTION_ENDED_FAMILY, "subscription_ended");
});

test("14-15: no Stripe event id reaches the key, the claim or the provider", () => {
  // A redelivery carries a new event id; so does an operator resending
  // the deletion from the Dashboard. Neither may reach a send decision.
  for (const source of [senderCode, rulesCode, templateCode]) {
    for (const forbidden of ["event.id", "eventId", "stripeEventId", "webhookEventId"]) {
      assert.ok(!source.includes(forbidden), `an event id reaches the send decision: ${forbidden}`);
    }
  }
  // The sender's whole input is a subscription id.
  assert.ok(senderCode.includes("sendSubscriptionEndedEmailIfNeeded(\n  subscriptionId: string\n)"));
  // And the local id comes from the RPC payload, not from Stripe.
  assert.ok(serviceCode.includes("sendSubscriptionEndedEmailIfNeeded(payload.subscription_id)"));
  assert.ok(!serviceCode.includes("sendSubscriptionEndedEmailIfNeeded(subscription.id)"));
});

test("16-19: the claim is one atomic insert-ignore, with no read-then-write", () => {
  assert.ok(senderCode.includes('.from("subscription_email_deliveries")'));
  assert.ok(senderCode.includes(".upsert("));
  assert.ok(senderCode.includes('onConflict: "subscription_id,family,event_key"'));
  assert.ok(senderCode.includes("ignoreDuplicates: true"), "must be ON CONFLICT DO NOTHING");
  assert.ok(!senderCode.includes("ignoreDuplicates: false"), "never DO UPDATE");

  const claimFn = senderCode.slice(
    senderCode.indexOf("async function claimSubscriptionEnded"),
    senderCode.indexOf("async function markSent")
  );
  assert.equal((claimFn.match(/\.select\(/g) ?? []).length, 1, "the claim must not read before it writes");
  assert.ok(claimFn.indexOf(".upsert(") < claimFn.indexOf(".select("));
  assert.ok(!claimFn.includes(".maybeSingle()"));
  // Zero rows back is a claim outcome, never an error and never a delivery.
  assert.ok(senderCode.includes('return claimed ? { kind: "claimed", deliveryId: claimed } : { kind: "taken" };'));
  assert.ok(!senderCode.includes('"already-sent"'));
});

/* ══════════════════════════════════════════════════════════════
   20-23. RECIPIENT AND PREFLIGHT
   ══════════════════════════════════════════════════════════════ */

test("20: the recipient comes only from the frozen customer_snapshot", () => {
  assert.equal(eligibility().recipient, "kundin@example.com");
  assert.equal(recipientFromCustomerSnapshot({ email: " a@b.de " }), "a@b.de");
  for (const snapshot of [null, {}, { email: "" }, { email: 9 }]) {
    assert.equal(recipientFromCustomerSnapshot(snapshot), null);
  }
  assert.equal(eligibility({ customer_snapshot: {} }).kind, "not-eligible");
  assert.equal(claimed({ customer_snapshot: {} }).kind, "failed");
  assert.ok(senderCode.includes("to: preflight.recipient,"));
});

test("21: there is no arbitrary recipient parameter anywhere", () => {
  const entry = senderCode.slice(senderCode.indexOf("export async function sendSubscriptionEndedEmailIfNeeded"));
  const signature = entry.slice(0, entry.indexOf("): Promise<"));
  for (const f of ["email", "recipient", "to:", "address"]) {
    assert.ok(!signature.includes(f), `the entry point takes a recipient: ${f}`);
  }
  // Never the Stripe customer object, the payload, a query string or a body.
  for (const forbidden of [
    "customer_details", "customer_email", "stripe.customers", "request.",
    "searchParams", "req.body",
  ]) {
    assert.ok(!senderCode.includes(forbidden), `an outside address source: ${forbidden}`);
  }
});

test("22: only a private B2C subscription can receive this email", () => {
  assert.equal(eligibility().kind, "send");
  assert.equal(eligibility({ customer_type: "business" }).kind, "not-eligible");
  assert.equal(eligibility({ customer_type: null }).kind, "not-eligible");
  assert.equal(claimed({ customer_type: "business" }).kind, "failed");
});

test("23: the preflight requires the authoritative terminal state", () => {
  // Cancelled, and genuinely started.
  assert.equal(eligibility({ status: "active" }).kind, "not-eligible");
  assert.equal(eligibility({ started_at: null }).kind, "not-eligible");
  // A missing subscription is never a delivery.
  assert.equal(
    evaluateSubscriptionEndedPreflight({ subscription: null, claimed: false }).kind,
    "not-eligible"
  );
  assert.equal(
    evaluateSubscriptionEndedPreflight({ subscription: null, claimed: true }).kind,
    "failed"
  );
  // The sender preflights TWICE - once to decide, once after the claim.
  assert.equal((senderCode.match(/evaluateSubscriptionEndedPreflight\(/g) ?? []).length, 2);
  assert.ok(senderCode.includes("claimed: false"));
  assert.ok(senderCode.includes("claimed: true"));
});

test("23b: started_at is a real durable proof, written once and never moved", () => {
  assert.ok(sql022.includes("started_at             = coalesce(v_subscription.started_at, now())"),
    "022 no longer records the activation instant immutably");
  // And it is written in the SAME statement that binds the Stripe id, so a
  // row the termination RPC can find is a row that genuinely started.
  const activation = sql022.slice(sql022.indexOf("update public.subscriptions"));
  const block = activation.slice(0, activation.indexOf(";"));
  assert.ok(block.includes("stripe_subscription_id ="));
  assert.ok(block.includes("status                 = 'active'"));
  assert.ok(block.includes("started_at             ="));
});

/* ══════════════════════════════════════════════════════════════
   24-32. THE COPY AND THE DATE
   ══════════════════════════════════════════════════════════════ */

test("24: the copy is reason-neutral", () => {
  const { subject, html, text } = built();
  for (const surface of [subject, html, text, templateCode]) {
    for (const forbidden of [
      "wie von dir gewünscht", "Wie von dir gewünscht", "auf deinen Wunsch",
      "Auf deinen Wunsch", "Deine Kündigung wurde ausgeführt", "wie gewünscht",
      "du hast gekündigt", "deine Kündigung",
    ]) {
      assert.ok(!surface.includes(forbidden), `it claims a reason it cannot prove: ${forbidden}`);
    }
  }
});

test("25: the copy says plainly that the subscription is over", () => {
  const { subject, text } = built();
  assert.equal(subject, "Dein GLOA Abo ist beendet");
  assert.ok(text.includes("Dein GLOA Abo ist jetzt beendet."));
  assert.ok(text.includes("keine weiteren Lieferungen"));
  assert.ok(text.includes("bisherigen Bestellungen bleiben"));
});

test("26: the copy never says the cancellation is merely scheduled", () => {
  const { subject, html, text } = built();
  for (const surface of [subject, html, text, templateCode]) {
    for (const forbidden of [
      "Kündigung vorgemerkt", "vorgemerkt", "Wir haben deine Kündigung erhalten",
      "Dein GLOA Abo endet am", "Abo endet am", "wird beendet",
      "läuft dein Abo wie vorgesehen weiter", "bis dahin", "Bis dahin",
    ]) {
      assert.ok(!surface.includes(forbidden), `forward-looking cancellation copy: ${forbidden}`);
    }
  }
});

test("27-28: the copy never says monthly or monatlich", () => {
  const { subject, html, text } = built();
  for (const surface of [subject, html, text, templateCode]) {
    for (const forbidden of ["monatlich", "Monatlich", "monthly", "Monthly", "pro Monat", "im Monat"]) {
      assert.ok(!surface.includes(forbidden), `a four-week cycle described as monthly: ${forbidden}`);
    }
  }
});

test("29-30: no internal id and no Stripe or Supabase terminology reaches the customer", () => {
  const { subject, html, text } = built();
  for (const surface of [subject, html, text]) {
    for (const forbidden of [
      SUBSCRIPTION_ID, "Stripe", "stripe", "Supabase", "supabase",
      "sub_", "in_", "cus_", "event_key", "delivery", "webhook", "RPC",
      "cancelled_at", "started_at", "status",
    ]) {
      assert.ok(!surface.includes(forbidden), `an internal detail reached the customer: ${forbidden}`);
    }
  }
});

test("31-32: the final date IS shown, and its durable source is proven stable", () => {
  const { html, text } = built();
  assert.ok(text.includes("Beendet am: 03.10.2026"));
  assert.ok(html.includes("03.10.2026"));

  // WHY IT MAY BE SHOWN. cancelled_at has exactly one writer in the whole
  // schema, and that writer refuses to move it on a redelivery.
  const writers = [];
  for (const name of readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith(".sql")).sort()) {
    const sql = withoutComments(readFileSync(path.join(MIGRATIONS_DIR, name), "utf-8"));
    for (const m of sql.matchAll(/update public\.subscriptions[\s\S]{0,900}?;/g)) {
      if (/cancelled_at\s*=/.test(m[0])) writers.push(name);
    }
  }
  assert.deepEqual([...new Set(writers)], ["034_subscription_cancellation.sql"],
    "a second writer of subscriptions.cancelled_at appeared - the date is no longer stable");
  assert.ok(sql034.includes("cancelled_at = coalesce(p_cancelled_at, now())"));

  // And cancellation_effective_at - a promise rewritten by two other
  // functions - is deliberately NOT the source.
  assert.ok(!senderCode.includes("cancellation_effective_at"));
  assert.ok(!templateCode.includes("cancellation_effective_at"));

  // A row without the instant loses the line, not the message.
  const undated = built({ endedAtIso: null });
  assert.ok(!undated.text.includes("Beendet am"));
  assert.ok(!undated.text.includes("null"));
  assert.ok(undated.text.includes("Dein GLOA Abo ist jetzt beendet."));

  // Server-formatted, timezone-pinned, and no date is calculated.
  assert.ok(templateCode.includes('timeZone: "Europe/Berlin"'));
  assert.ok(templateCode.includes('toLocaleDateString("de-DE"'));
  for (const forbidden of ["setDate(", "getTime() +", "getTime() -", "86400", "Date.now("]) {
    assert.ok(!templateCode.includes(forbidden), `the template calculates a date: ${forbidden}`);
  }
  // No raw ISO in front of a customer.
  for (const surface of [built().subject, html, text]) {
    assert.ok(!/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(surface), "an ISO timestamp leaked into the copy");
  }
});

test("32b: no moving column is read for customer-facing content", () => {
  for (const forbidden of [
    "current_period_end", "next_delivery_at", "currentPeriodEnd",
    "last_paid_period_end", "plan_snapshot", "cancel_at",
  ]) {
    assert.ok(!senderCode.includes(forbidden), `the sender reads a moving value: ${forbidden}`);
    assert.ok(!templateCode.includes(forbidden), `the template reads a moving value: ${forbidden}`);
  }
});

/* ══════════════════════════════════════════════════════════════
   33-39. PROVIDER AND STATE TRANSITIONS
   ══════════════════════════════════════════════════════════════ */

test("33: the provider key is deterministic and collides with nothing", () => {
  const key = subscriptionEndedIdempotencyKey(SUBSCRIPTION_ID);
  assert.equal(key, `gloa/subscription-ended/${SUBSCRIPTION_ID}`);
  assert.equal(key, subscriptionEndedIdempotencyKey(SUBSCRIPTION_ID));
  // Distinct from both sibling families for the SAME subscription.
  assert.notEqual(key, subscriptionStartedIdempotencyKey(SUBSCRIPTION_ID));
  assert.notEqual(key, cancellationConfirmationIdempotencyKey(SUBSCRIPTION_ID, "a|b"));
  for (const existing of [
    "gloa/internal-order/", "gloa/shipment/", "gloa/cancellation-request/",
    "gloa/cancellation-outcome/", "gloa/refund/", "gloa/subscription-started/",
    "gloa/cancellation-confirmation/", "gloa/subscription-cancel/", "gloa/subscription-defer/",
  ]) {
    assert.ok(!key.startsWith(existing), `the namespace collides with ${existing}`);
  }
  assert.ok(senderCode.includes("subscriptionEndedIdempotencyKey(subscriptionId)"));
  assert.ok(senderCode.includes("{ idempotencyKey }"));
});

test("34: provider acceptance records sent AND sent_at, unconditionally", () => {
  const markSent = senderCode.slice(
    senderCode.indexOf("async function markSent"),
    senderCode.indexOf("async function markFailed")
  );
  assert.ok(markSent.includes('.update({ status: "sent", sent_at: new Date().toISOString() })'));
  assert.ok(!markSent.includes('.eq("status", "sending")'),
    "recording 'sent' must not be conditional after provider acceptance");
});

test("35: provider failure records failed only over sending", () => {
  const markFailed = senderCode.slice(
    senderCode.indexOf("async function markFailed"),
    senderCode.indexOf("async function markSuperseded")
  );
  assert.ok(markFailed.includes('.update({ status: "failed", sent_at: null })'));
  assert.ok(markFailed.includes('.eq("status", "sending")'));
});

test("36: no identity or generated column is ever written", () => {
  const updates = senderCode.match(/\.update\(\{[^}]*\}\)/g) ?? [];
  assert.equal(updates.length, 3, "exactly three result transitions");
  for (const stmt of updates) {
    for (const forbidden of ["subscription_id", "family", "event_key", "created_at", "updated_at"]) {
      assert.ok(!stmt.includes(forbidden), `an update writes ${forbidden}: ${stmt}`);
    }
    assert.ok(!/\bid:/.test(stmt), `an update writes the primary key: ${stmt}`);
  }
  const claim = senderCode.slice(senderCode.indexOf(".upsert("), senderCode.indexOf("onConflict:"));
  for (const column of ["subscription_id", "family", "event_key", "status"]) {
    assert.ok(claim.includes(column), `the claim must supply ${column}`);
  }
  for (const forbidden of ["created_at", "updated_at", "sent_at"]) {
    assert.ok(!claim.includes(forbidden), `the claim supplies ${forbidden}`);
  }
  assert.ok(!/\bid:/.test(claim));
});

test("37: an email failure cannot undo or fail the durable termination", () => {
  assert.ok(!/\bthrow\b/.test(senderCode), "the sender must never throw");
  const fn = serviceFn("markSubscriptionCancelledFromStripe");
  assert.ok(!/const\s+\w+\s*=\s*await sendSubscriptionEndedEmailIfNeeded/.test(fn),
    "the termination writer branches on the email outcome");
  // The termination result is still returned truthfully.
  assert.ok(fn.includes("return result;"));
  // The handler never throws either, so the deleted event is still recorded.
  assert.ok(!handlerBody("handleSubscriptionDeleted").includes("throw"));
  // And the sender touches no subscription lifecycle column, ever.
  for (const forbidden of ['.from("subscriptions")\n    .update', "mark_subscription_cancelled", "rpc("]) {
    assert.ok(!senderCode.includes(forbidden), `the sender mutates lifecycle state: ${forbidden}`);
  }
  const subUpdates = senderCode.match(/from\("subscriptions"\)[\s\S]{0,120}?\.update\(/g) ?? [];
  assert.equal(subUpdates.length, 0, "the sender writes to public.subscriptions");
});

test("38: the crash-before-claim path stays recoverable, and stays single-send", () => {
  // Recoverable: see test 9 and 11. Single-send: the redelivery that
  // recovers it cannot ALSO duplicate, because the claim decides.
  assert.ok(senderCode.includes('if (claim.kind === "taken") return "already-claimed";'));
  const entry = senderCode.slice(senderCode.indexOf("export async function sendSubscriptionEndedEmailIfNeeded"));
  const claimAt = entry.indexOf("await claimSubscriptionEnded(");
  const deliverAt = entry.indexOf("deliverClaimedSubscriptionEnded(");
  assert.ok(claimAt !== -1 && claimAt < deliverAt, "nothing may be sent before the claim is won");
});

test("39: a sent delivery never becomes superseded", () => {
  const supersede = senderCode.slice(senderCode.indexOf("async function markSuperseded"));
  assert.ok(supersede.includes('.update({ status: "superseded", sent_at: null })'));
  assert.ok(supersede.includes('.in("status", ["sending", "failed"])'));
  assert.ok(!supersede.includes('"sent"]'));
  // Supersession is unreachable today - 'cancelled' is terminal - and the
  // branch exists only for a future lifecycle that could reactivate.
  assert.equal(claimed({ status: "active" }).kind, "superseded");
  assert.equal(claimed({ started_at: null }).kind, "superseded");
  // And a superseded delivery never contacts the provider.
  const deliver = senderCode.slice(senderCode.indexOf("async function deliverClaimedSubscriptionEnded"));
  const supersededAt = deliver.indexOf('if (preflight.kind === "superseded")');
  const resendAt = deliver.indexOf("getResendClient()");
  assert.ok(supersededAt !== -1 && supersededAt < resendAt);
});

/* ══════════════════════════════════════════════════════════════
   40-50. WHAT THIS PHASE DID NOT TOUCH
   ══════════════════════════════════════════════════════════════ */

test("40: subscription_started is unchanged", () => {
  const started = withoutComments(read("lib/subscriptionStartedEmail.ts"));
  assert.ok(started.includes("subscriptionStartedIdempotencyKey(subscriptionId)"));
  assert.ok(started.includes("isSubscriptionStartInvoice(billingReason)"));
  for (const forbidden of ["subscription_ended", "subscriptionEnded", "cancelled_at"]) {
    assert.ok(!started.includes(forbidden), `the start sender changed: ${forbidden}`);
  }
});

test("41: cancellation_confirmation is unchanged", () => {
  const confirmation = withoutComments(read("lib/cancellationConfirmationEmail.ts"));
  assert.ok(confirmation.includes("cancellationConfirmationIdempotencyKey(subscriptionId, eventKey)"));
  assert.ok(confirmation.includes("evaluateCancellationConfirmationPreflight("));
  for (const forbidden of ["subscription_ended", "subscriptionEnded", "started_at"]) {
    assert.ok(!confirmation.includes(forbidden), `the confirmation sender changed: ${forbidden}`);
  }
  // The three families remain three distinct templates.
  const templates = readdirSync(path.join(ROOT, "lib/email"));
  for (const t of ["subscriptionStarted.ts", "cancellationConfirmation.ts", "subscriptionEnded.ts"]) {
    assert.ok(templates.includes(t), `${t} is missing`);
  }
});

test("42-43: payment_problem and the refund correlation are untouched", () => {
  for (const source of [senderCode, rulesCode, templateCode, serviceCode]) {
    assert.ok(!source.includes("payment_problem"), "payment_problem must stay absent");
    assert.ok(!source.includes("invoice.payment_failed"), "payment failure must stay deferred");
  }
  const refunds = withoutComments(read("lib/orderRefunds.ts"));
  for (const forbidden of ["subscription_email_deliveries", "subscriptionEnded", "subscription_ended"]) {
    assert.ok(!refunds.includes(forbidden), `refund correlation changed: ${forbidden}`);
  }
  // The known defect is still open: subscription orders still pass no
  // payment intent, which is the correlation bug's cause and not this
  // phase's to fix.
  const fulfillment = withoutComments(read("lib/subscriptionInvoiceFulfillment.ts"));
  assert.ok(fulfillment.includes("createOrderFromPaidCheckoutAttempt("));
});

test("44: no automatic retry was wired", () => {
  for (const [name, source] of [
    ["retry rules", withoutComments(read("lib/transactionalEmailRetryRules.ts"))],
    ["retry wiring", withoutComments(read("lib/transactionalEmailRetry.ts"))],
    ["cron route", cronCode],
  ]) {
    for (const forbidden of [
      "subscription_email_deliveries", "subscription_ended", "subscriptionEnded",
      "cancellation_confirmation", "subscription_started",
    ]) {
      assert.ok(!source.includes(forbidden), `the ${name} learned about this phase: ${forbidden}`);
    }
  }
  for (const forbidden of ["Sweep", "sweep", "batch", "limit(25)"]) {
    assert.ok(!senderCode.includes(forbidden), `the sender grew a sweep: ${forbidden}`);
  }
  assert.ok(senderCode.includes('.update({ status: "failed", sent_at: null })'),
    "the durable retry state the next phase will use must exist");
});

test("45: migration 035 still declares exactly the contract this phase uses", () => {
  assert.ok(sql035.includes("grant select on public.subscription_email_deliveries to service_role;"));
  assert.ok(sql035.includes("grant insert (subscription_id, family, event_key, status)"));
  assert.ok(sql035.includes("grant update (status, sent_at)"));
  assert.ok(sql035.includes("unique (subscription_id, family, event_key)"));
  assert.ok(sql035.includes("'subscription_ended'"));
  assert.ok(!/grant[^;]*delete/i.test(sql035));
  for (const family of SUBSCRIPTION_EMAIL_FAMILIES) assert.ok(sql035.includes(`'${family}'`));
  for (const status of SUBSCRIPTION_EMAIL_STATUSES) assert.ok(sql035.includes(`'${status}'`));
  // All three families are now implemented, and the vocabulary is closed.
  assert.equal(SUBSCRIPTION_EMAIL_FAMILIES.length, 3);
});

test("46-47: 022 through 035 are all present and there is no 036", () => {
  const files = readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith(".sql")).sort();
  assert.equal(files.length, 35, "a migration was added or removed");
  assert.equal(files[files.length - 1], MIGRATION_035, "035 must remain the highest");
  assert.ok(!files.some(f => f.startsWith("036")), "this phase must need no migration");
  for (let n = 22; n <= 35; n += 1) {
    const prefix = String(n).padStart(3, "0");
    assert.ok(files.some(f => f.startsWith(prefix)), `migration ${prefix} is missing`);
  }
  for (const source of [senderCode, rulesCode, templateCode]) {
    for (const forbidden of ["create table", "alter table", "create index", "create function"]) {
      assert.ok(!source.toLowerCase().includes(forbidden), `the application writes DDL: ${forbidden}`);
    }
  }
});

test("48: B2C_SUBSCRIPTIONS_ENABLED is still closed unless exactly 'true'", () => {
  const checkoutRules = read("lib/subscriptionCheckoutRules.ts");
  assert.ok(checkoutRules.includes('export const SUBSCRIPTION_FEATURE_FLAG = "B2C_SUBSCRIPTIONS_ENABLED"'));
  assert.ok(checkoutRules.includes('env[SUBSCRIPTION_FEATURE_FLAG] === "true"'));
  for (const source of [senderCode, rulesCode, templateCode]) {
    assert.ok(!source.includes("B2C_SUBSCRIPTIONS_ENABLED"));
  }
});

test("49: SHOP_STATUS is still prelaunch", () => {
  assert.ok(read("app/content.ts").includes('export const SHOP_STATUS = "prelaunch"'));
});

test("50: nothing in this feature can reach a network or a database in a test", () => {
  for (const [name, source] of [["template", templateCode], ["rules", rulesCode]]) {
    assert.ok(!source.includes("supabase"), `the ${name} touches the database`);
    assert.ok(!source.includes("fetch("), `the ${name} makes a network call`);
    assert.ok(!source.includes("process.env"), `the ${name} reads the environment`);
    assert.ok(!source.includes("resend"), `the ${name} reaches the provider`);
  }
  assert.ok(!/from "\.\//.test(templateCode), "the template has a relative import");
  assert.ok(!/from "\.\//.test(rulesCode), "the rules module has a relative import");
  // The only clock in the sender is the sent_at stamp.
  assert.equal((senderCode.match(/new Date\(\)\.toISOString\(\)/g) ?? []).length, 1);
  assert.ok(!templateCode.includes("new Date()"), "the template reads the clock");

  const self = readFileSync(fileURLToPath(import.meta.url), "utf-8");
  const specifiers = self
    .split(NEWLINE)
    .map(line => /^(?:import .*|\}) from "([^"]+)";$/.exec(line))
    .filter(Boolean)
    .map(m => m[1])
    .sort();
  assert.deepEqual([...new Set(specifiers)], [
    "../lib/email/cancellationConfirmation.ts",
    "../lib/email/subscriptionEnded.ts",
    "../lib/email/subscriptionStarted.ts",
    "../lib/emailSenders.ts",
    "../lib/subscriptionEmailDeliveryRules.ts",
    "node:assert/strict",
    "node:fs",
    "node:path",
    "node:test",
    "node:url",
  ], "this suite imports something that can reach a database or a network");
});

test("50b: it uses the established customer sender convention", () => {
  assert.ok(senderCode.includes("from: GLOA_FROM_HELLO,"));
  assert.ok(senderCode.includes("replyTo: GLOA_REPLY_TO_SUPPORT,"));
  assert.equal(GLOA_FROM_HELLO, "GLOA <hello@gloamatcha.com>");
  assert.equal(GLOA_REPLY_TO_SUPPORT, "support@gloamatcha.com");
  assert.ok(!senderCode.includes("GLOA_INTERNAL_ORDERS"));
});
