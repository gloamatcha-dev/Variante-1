import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifySubscriptionEmailProviderError,
} from "../lib/subscriptionEmailDeliveryRules.ts";
import { subscriptionStartedIdempotencyKey } from "../lib/email/subscriptionStarted.ts";
import { cancellationConfirmationIdempotencyKey } from "../lib/email/cancellationConfirmation.ts";
import { subscriptionEndedIdempotencyKey } from "../lib/email/subscriptionEnded.ts";

// SAFE DEFAULT SUITE: a pure classifier plus source-level checks. No
// server is spawned, no database is reachable, no Supabase client is
// constructed, no Stripe API is called, no Resend request is made and no
// email of any kind is sent. Nothing here executes SQL and nothing here
// requires TEST_SUPABASE_*.
//
// THE INVARIANT THIS SUITE EXISTS TO PROTECT:
//
//   status = 'failed' means THE APPLICATION CAN PROVE THE PROVIDER DID
//   NOT ACCEPT THE EMAIL.
//
// Everything else that touches the provider and does not end in proven
// acceptance leaves the row at 'sending'. This matters because 'failed'
// is the only status a future retry sweep may act on, and this repository
// has already sent 25 duplicate order confirmations once, on 2026-08-21,
// by treating an ambiguous state as retryable.

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

/** The three senders, and the family constant each one logs with. */
const SENDERS = [
  {
    name: "subscription_started",
    file: "lib/subscriptionStartedEmail.ts",
    family: "SUBSCRIPTION_STARTED_FAMILY",
    entry: "sendSubscriptionStartedEmailIfNeeded",
    deliver: "deliverClaimedSubscriptionStarted",
  },
  {
    name: "cancellation_confirmation",
    file: "lib/cancellationConfirmationEmail.ts",
    family: "CANCELLATION_CONFIRMATION_FAMILY",
    entry: "sendCancellationConfirmationEmailIfNeeded",
    deliver: "deliverClaimedCancellationConfirmation",
  },
  {
    name: "subscription_ended",
    file: "lib/subscriptionEndedEmail.ts",
    family: "SUBSCRIPTION_ENDED_FAMILY",
    entry: "sendSubscriptionEndedEmailIfNeeded",
    deliver: "deliverClaimedSubscriptionEnded",
  },
];

for (const sender of SENDERS) sender.code = withoutComments(read(sender.file));

const rulesCode = withoutComments(read("lib/subscriptionEmailDeliveryRules.ts"));
const serviceCode = withoutComments(read("lib/subscriptionCancellation.ts"));
const webhookCode = withoutComments(read("app/api/stripe/webhook/route.ts"));
const cronCode = withoutComments(read("app/api/cron/retry-order-notifications/route.ts"));
const retryRulesCode = withoutComments(read("lib/transactionalEmailRetryRules.ts"));
const retryWiringCode = withoutComments(read("lib/transactionalEmailRetry.ts"));

/** The tail of one sender's deliver function, where the outcome is decided. */
const deliverTail = sender =>
  sender.code.slice(sender.code.indexOf(`async function ${sender.deliver}`));

/** One resend@6.21.0-shaped error. */
const providerError = (statusCode, message = "boom") => ({
  name: "application_error",
  statusCode,
  message,
});

/* ══════════════════════════════════════════════════════════════
   THE CLASSIFIER
   ══════════════════════════════════════════════════════════════ */

test("1-5, 11, 12: every 4xx EXCEPT 409 is a proven refusal", () => {
  // Each of these means Resend looked at THIS request and declined it, so
  // no message exists and none can appear later.
  for (const code of [400, 401, 403, 404, 405, 408, 422, 429, 451, 499]) {
    assert.equal(
      classifySubscriptionEmailProviderError(providerError(code)),
      "definite_failure",
      `HTTP ${code} must be a proven refusal`
    );
  }
  // 409 is deliberately absent from that list. See below.
  assert.notEqual(
    classifySubscriptionEmailProviderError(providerError(409)),
    "definite_failure",
    "409 must never be a proven refusal"
  );
});

test("6-10: HTTP 409 is AMBIGUOUS, whatever name it carries", () => {
  // 409 is the one 4xx that is about ANOTHER request rather than this
  // one. resend@6.21.0's own error vocabulary carries two of them, and a
  // same-event request may already have been accepted in both cases:
  //
  //   invalid_idempotent_request      the key was already used, with a
  //                                   different payload
  //   concurrent_idempotent_requests  another request with this key is in
  //                                   flight right now
  //
  // Marking either as 'failed' would hand it to the retry sweep, and the
  // sweep would send a message the customer may already have.
  for (const name of [
    "invalid_idempotent_request",
    "concurrent_idempotent_requests",
    // A name Resend has not shipped yet, and one with no name at all:
    // both must classify identically, because the STATUS is the contract.
    "some_future_idempotency_conflict",
    undefined,
  ]) {
    const error = { statusCode: 409, message: "conflict" };
    if (name !== undefined) error.name = name;
    assert.equal(
      classifySubscriptionEmailProviderError(error),
      "ambiguous",
      `409 must be ambiguous whatever its name (${String(name)})`
    );
  }
  // And it must not depend on message text either.
  for (const message of ["", "anything at all", "Idempotency key already used"]) {
    assert.equal(
      classifySubscriptionEmailProviderError({ statusCode: 409, message }),
      "ambiguous"
    );
  }
});

test("6b: invalid_idempotency_key is NOT swept in with the 409s", () => {
  // A malformed key we sent is an ordinary validation refusal: the
  // request was rejected outright and nothing was accepted. It must stay
  // retryable, or a fixable client bug would become a permanent
  // owner-action row.
  assert.equal(
    classifySubscriptionEmailProviderError({
      name: "invalid_idempotency_key",
      statusCode: 422,
      message: "idempotency key is too long",
    }),
    "definite_failure"
  );
});

test("7: statusCode null is NEVER a proven refusal", () => {
  // This is the resend@6.21.0 transport shape: the SDK catches its own
  // fetch failure and returns this, so a lost connection arrives on the
  // same code path as an HTTP rejection.
  const transport = {
    name: "application_error",
    statusCode: null,
    message: "Unable to fetch data. The request could not be resolved.",
  };
  assert.equal(classifySubscriptionEmailProviderError(transport), "ambiguous");
});

test("9-11: every 5xx is ambiguous, not a refusal", () => {
  for (const code of [500, 502, 503, 504, 507, 599]) {
    assert.equal(
      classifySubscriptionEmailProviderError(providerError(code)),
      "ambiguous",
      `HTTP ${code} says nothing about whether the message was enqueued`
    );
  }
});

test("12: it fails closed on every non-4xx and every unrecognised shape", () => {
  for (const weird of [
    providerError(undefined),
    providerError("429"),
    providerError(Number.NaN),
    providerError(Number.POSITIVE_INFINITY),
    providerError(409),
    providerError(399),
    providerError(300),
    providerError(200),
    providerError(0),
    providerError(-1),
    providerError(4.5),
    {},
    { message: "no status at all" },
    null,
    undefined,
  ]) {
    assert.equal(
      classifySubscriptionEmailProviderError(weird),
      "ambiguous",
      `unrecognised error shapes must fail closed: ${JSON.stringify(weird)}`
    );
  }
});

test("12b: the classifier is pure, deterministic and free of the SDK", () => {
  const err = providerError(422);
  assert.equal(
    classifySubscriptionEmailProviderError(err),
    classifySubscriptionEmailProviderError(err)
  );
  // It never sees success: it only ever classifies an error.
  assert.ok(rulesCode.includes("export function classifySubscriptionEmailProviderError("));
  assert.ok(!rulesCode.includes('from "resend"'), "the rules leaf must not import the SDK");
  assert.ok(!/from "\.\//.test(rulesCode), "the rules module has a relative import");
  assert.ok(!rulesCode.includes("fetch("));
  assert.ok(!rulesCode.includes("process.env"));
  // Exactly two outcomes.
  const outcomes = new Set(
    [400, 409, 499, 500, null, undefined, "x"].map(c => classifySubscriptionEmailProviderError(providerError(c)))
  );
  assert.deepEqual([...outcomes].sort(), ["ambiguous", "definite_failure"]);
});

/* ══════════════════════════════════════════════════════════════
   EVERY SENDER APPLIES IT THE SAME WAY
   ══════════════════════════════════════════════════════════════ */

for (const sender of SENDERS) {
  test(`${sender.name}: the classifier decides, and only 4xx may write failed`, () => {
    const tail = deliverTail(sender);
    assert.ok(tail.includes("outcome = classifySubscriptionEmailProviderError(sendError);"),
      "the sender must classify the provider error");
    // markFailed is reached from the proven-refusal branch and nowhere
    // else after the provider was contacted.
    const refusedAt = tail.indexOf('if (outcome === "definite_failure")');
    assert.notEqual(refusedAt, -1);
    const refusedBranch = tail.slice(refusedAt, tail.indexOf("// ── ACCEPTED", refusedAt) + 1
      || tail.length);
    assert.ok(refusedBranch.includes("await markFailed(deliveryId);"));
    assert.ok(refusedBranch.includes('return "failed";'));
  });

  test(`${sender.name}: 8, 14 - ambiguous returns without writing anything`, () => {
    const tail = deliverTail(sender);
    const ambiguousAt = tail.indexOf('if (outcome === "ambiguous")');
    const refusedAt = tail.indexOf('if (outcome === "definite_failure")');
    assert.ok(ambiguousAt !== -1 && refusedAt !== -1);
    assert.ok(ambiguousAt < refusedAt, "the ambiguous branch must be checked first");

    const branch = tail.slice(ambiguousAt, refusedAt);
    assert.ok(branch.includes('return "ambiguous";'));
    // THE WHOLE POINT: no state write at all, so the row stays 'sending'.
    assert.ok(!branch.includes("markFailed"), "an ambiguous outcome must never write 'failed'");
    assert.ok(!branch.includes("markSent"), "an ambiguous outcome must never write 'sent'");
    assert.ok(!branch.includes("markSuperseded"), "an ambiguous outcome must never supersede");
    assert.ok(!branch.includes(".update("), "an ambiguous outcome must write nothing");
  });

  test(`${sender.name}: 13 - a thrown provider exception is ambiguous`, () => {
    const tail = deliverTail(sender);
    const catchAt = tail.indexOf("} catch (err) {");
    assert.notEqual(catchAt, -1);
    const catchBlock = tail.slice(catchAt, tail.indexOf("}", tail.indexOf("sendErrorMessage = err")));
    assert.ok(catchBlock.includes('outcome = "ambiguous";'),
      "a throw around the provider call must not be treated as a refusal");
    assert.ok(!catchBlock.includes("markFailed"));
  });

  test(`${sender.name}: 15-17 - acceptance writes sent, and a lost write is ambiguous`, () => {
    const tail = deliverTail(sender);
    // markSent reports whether the durable write landed.
    assert.ok(sender.code.includes("async function markSent(deliveryId: string): Promise<boolean> {"));
    assert.ok(sender.code.includes("return true;"));
    // Acceptance path: attempt sent + sent_at.
    assert.ok(sender.code.includes('.update({ status: "sent", sent_at: new Date().toISOString() })'));
    // A failed durable write is ambiguous, NOT failed: the message is out.
    const acceptedAt = tail.indexOf("if (!(await markSent(deliveryId)))");
    assert.notEqual(acceptedAt, -1, "the sent write must be checked");
    const acceptedBranch = tail.slice(acceptedAt, tail.indexOf('return "sent";', acceptedAt));
    assert.ok(acceptedBranch.includes('return "ambiguous";'));
    assert.ok(!acceptedBranch.includes("markFailed"),
      "provider acceptance followed by a lost write must never become 'failed'");
  });

  test(`${sender.name}: 22 - failed is reachable only from proven non-acceptance`, () => {
    // Every markFailed call site in the whole module, classified.
    const calls = sender.code.match(/await markFailed\(deliveryId\);/g) ?? [];
    assert.ok(calls.length >= 1);
    const tail = deliverTail(sender);
    const providerAt = tail.indexOf("await resend.emails.send(");
    assert.notEqual(providerAt, -1);

    // Before the provider call: preflight and configuration refusals. The
    // provider was never contacted, so nothing can have been accepted.
    const beforeProvider = tail.slice(0, providerAt);
    assert.ok(beforeProvider.includes("await markFailed(deliveryId);"));

    // After it: exactly one, inside the definite_failure branch.
    const afterProvider = tail.slice(providerAt);
    assert.equal((afterProvider.match(/await markFailed\(deliveryId\);/g) ?? []).length, 1,
      "exactly one post-provider markFailed, and it must be the proven refusal");
    const refusedAt = afterProvider.indexOf('if (outcome === "definite_failure")');
    assert.ok(refusedAt !== -1 && refusedAt < afterProvider.indexOf("await markFailed(deliveryId);"));
  });

  test(`${sender.name}: 19-21 - superseded and sent stay exactly as they were`, () => {
    // No provider contact on superseded.
    const tail = deliverTail(sender);
    const supersededAt = tail.indexOf('if (preflight.kind === "superseded")');
    const providerAt = tail.indexOf("getResendClient()");
    assert.ok(supersededAt !== -1 && providerAt !== -1);
    assert.ok(supersededAt < providerAt, "superseded must precede the provider");
    // sent is never rewritten: markFailed and markSuperseded are guarded.
    assert.ok(sender.code.includes('.eq("status", "sending")'), "mark-failed must be guarded");
    assert.ok(sender.code.includes('.in("status", ["sending", "failed"])'),
      "mark-superseded must never admit a sent row");
  });

  test(`${sender.name}: 26-28 - recipient, logging and result vocabulary`, () => {
    // The one helper, reading snapshot.email.
    assert.ok(sender.code.includes("to: preflight.recipient,"));
    const entryAt = sender.code.indexOf(`export async function ${sender.entry}`);
    const signature = sender.code.slice(entryAt, sender.code.indexOf("): Promise<", entryAt));
    for (const f of ["email", "recipient", "address"]) {
      assert.ok(!signature.includes(f), `the entry point takes a recipient: ${f}`);
    }
    // No customer data in any log line.
    for (const line of sender.code.match(/console\.error\([^;]*\)/g) ?? []) {
      for (const forbidden of [
        "preflight.recipient", "customer_snapshot", "plan_snapshot",
        "packageName", "customer.name", "process.env",
      ]) {
        assert.ok(!line.includes(forbidden), `a log line leaks ${forbidden}`);
      }
      // Naming RESEND_API_KEY in a configuration message is the
      // established pattern and leaks nothing; interpolating one would.
      assert.ok(!/\$\{[^}]*(KEY|SECRET|TOKEN)[^}]*\}/.test(line),
        `a log line interpolates a secret: ${line}`);
    }
    // The ambiguous log names the delivery and the family, and nothing else.
    assert.ok(sender.code.includes(`AMBIGUOUS provider outcome for delivery \${deliveryId} (\${${sender.family}})`));
    // The result union carries the new value.
    assert.ok(sender.code.includes('| "ambiguous"'));
  });
}

/* ══════════════════════════════════════════════════════════════
   1, 23-25. LIFECYCLE ACTIONS ARE NEVER FAILED BY AN EMAIL
   ══════════════════════════════════════════════════════════════ */

test("1: the three lifecycle triggers are unchanged", () => {
  // started: invoice.paid with billing_reason subscription_create.
  assert.ok(webhookCode.includes("sendSubscriptionStartedEmailIfNeeded({"));
  assert.ok(webhookCode.includes("billingReason: result.billingReason,"));
  assert.ok(SENDERS[0].code.includes("if (!isSubscriptionStartInvoice(billingReason)) return \"not-eligible\";"));
  // cancellation: the three cancellation-pair writers.
  assert.equal((serviceCode.match(/sendCancellationConfirmationEmailIfNeeded\(/g) ?? []).length, 3);
  // ended: the terminal-state writer, on both terminal results.
  assert.ok(serviceCode.includes('(result === "cancelled" || result === "already_cancelled")'));
  assert.equal((serviceCode.match(/sendSubscriptionEndedEmailIfNeeded\(/g) ?? []).length, 1);
});

test("23-25: no sender throws, and no caller branches on the email outcome", () => {
  for (const sender of SENDERS) {
    assert.ok(!/\bthrow\b/.test(sender.code), `${sender.name} must never throw`);
  }
  // The cancellation and termination writers ignore the result entirely.
  for (const fn of [
    "cancelSubscriptionForUser",
    "applyDeferredCancellationFromRenewal",
    "syncSubscriptionFromStripe",
    "markSubscriptionCancelledFromStripe",
  ]) {
    const at = serviceCode.indexOf(`export async function ${fn}(`);
    assert.notEqual(at, -1, `${fn} disappeared`);
    const next = serviceCode.indexOf(`${NEWLINE}export `, at + 1);
    const body = serviceCode.slice(at, next === -1 ? serviceCode.length : next);
    assert.ok(!/const\s+\w+\s*=\s*await send(CancellationConfirmation|SubscriptionEnded)EmailIfNeeded/.test(body),
      `${fn} branches on the email outcome`);
  }
  // The start email's call site logs the outcome and rethrows nothing.
  const startBlock = webhookCode.slice(
    webhookCode.indexOf("const started = await sendSubscriptionStartedEmailIfNeeded("),
    webhookCode.indexOf("applyDeferredCancellationFromRenewal(")
  );
  assert.ok(startBlock.length > 0);
  assert.ok(!startBlock.includes("throw"));
  // And an ambiguous outcome is surfaced, because nothing else ever will.
  assert.ok(startBlock.includes('started === "ambiguous"'));
});

test("23-25b: the cancel route still answers from the cancellation, not the email", () => {
  const routeCode = withoutComments(read("app/api/subscriptions/cancel/route.ts"));
  for (const forbidden of ["cancellationConfirmationEmail", "ambiguous", "emails.send"]) {
    assert.ok(!routeCode.includes(forbidden), `the route learned about the email: ${forbidden}`);
  }
});

/* ══════════════════════════════════════════════════════════════
   29-33. NOTHING CUSTOMER-FACING MOVED
   ══════════════════════════════════════════════════════════════ */

test("29-31: the customer copy of all three templates is unchanged", () => {
  const started = read("lib/email/subscriptionStarted.ts");
  const confirmation = read("lib/email/cancellationConfirmation.ts");
  const ended = read("lib/email/subscriptionEnded.ts");
  assert.ok(started.includes('const SUBJECT = "Dein GLOA Abo ist aktiv";'));
  assert.ok(started.includes("Dein Matcha Abo ist gestartet."));
  assert.ok(confirmation.includes('const SUBJECT = "Wir haben deine Kündigung erhalten";'));
  assert.ok(confirmation.includes("Deine Kündigung ist bei uns eingegangen."));
  assert.ok(ended.includes('const SUBJECT = "Dein GLOA Abo ist beendet";'));
  assert.ok(ended.includes("Dein GLOA Abo ist jetzt beendet."));
  // No template learned about provider outcomes.
  for (const [name, source] of [["started", started], ["confirmation", confirmation], ["ended", ended]]) {
    assert.ok(!source.includes("statusCode"), `the ${name} template reads a provider status`);
    // The quoted result value, not the word: subscriptionStarted.ts has
    // said "unambiguous namespace" in its prose since Phase 3H.2.
    assert.ok(!source.includes('"ambiguous"'), `the ${name} template handles an outcome`);
    assert.ok(!source.includes("classifySubscriptionEmailProviderError"),
      `the ${name} template classifies a provider error`);
  }
});

test("32-33: event keys and provider idempotency keys are unchanged", () => {
  const SUB = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  assert.equal(subscriptionStartedIdempotencyKey(SUB), `gloa/subscription-started/${SUB}`);
  assert.equal(subscriptionEndedIdempotencyKey(SUB), `gloa/subscription-ended/${SUB}`);
  assert.equal(
    cancellationConfirmationIdempotencyKey(SUB, "A|B"),
    `gloa/cancellation-confirmation/${SUB}/A|B`
  );
  // The event key derivations are untouched.
  assert.ok(rulesCode.includes("export function subscriptionStartedEventKey("));
  assert.ok(rulesCode.includes("export function subscriptionEndedEventKey("));
  assert.ok(rulesCode.includes("export function cancellationConfirmationEventKey("));
  assert.ok(rulesCode.includes('return `${requested}|${effective}`;'));
  // And each sender still passes its key to the provider.
  for (const sender of SENDERS) {
    assert.ok(sender.code.includes("{ idempotencyKey }"), `${sender.name} lost its provider key`);
  }
});

/* ══════════════════════════════════════════════════════════════
   34-44. NOTHING ELSE MOVED
   ══════════════════════════════════════════════════════════════ */

test("34: the ORDER retry engine still knows nothing about these families", () => {
  // PHASE 3H.5B2 NARROWED THIS GUARD, DELIBERATELY. It used to assert
  // that no subscription retry existed anywhere, which was the correct
  // boundary while 'failed' could still mean an ambiguous outcome. The
  // sweep now exists, in its own module, and the property still worth
  // protecting is that it did NOT get there by generalising the proven
  // order retry engine or by joining AUTO_RETRY_FAMILY_KEYS.
  for (const [name, source] of [
    ["retry rules", retryRulesCode],
    ["retry wiring", retryWiringCode],
  ]) {
    for (const forbidden of [
      "subscription_email_deliveries", "subscription_started", "subscription_ended",
      "cancellation_confirmation", "subscriptionStartedEmail", "subscriptionEndedEmail",
      "cancellationConfirmationEmail", "subscriptionEmailRetry",
    ]) {
      assert.ok(!source.includes(forbidden), `the ${name} learned about this phase: ${forbidden}`);
    }
  }
  // The cron route reaches the sweep through ONE import and nothing else:
  // it never touches the delivery table or a sender itself.
  assert.ok(cronCode.includes("runSubscriptionEmailRetrySweep()"));
  for (const forbidden of [
    "subscription_email_deliveries", "subscriptionStartedEmail", "subscriptionEndedEmail",
    "cancellationConfirmationEmail", "AUTO_RETRY_FAMILY_KEYS",
  ]) {
    assert.ok(!cronCode.includes(forbidden), `the cron route reaches too far: ${forbidden}`);
  }
  // And no SENDER grew a sweep of its own: the retry lives beside them,
  // reusing their claimed-delivery path rather than duplicating it.
  for (const sender of SENDERS) {
    for (const forbidden of ["sweep", "Sweep", "stale", "Stale", "cutoff", "limit(25)"]) {
      assert.ok(!sender.code.includes(forbidden), `${sender.name} grew retry logic: ${forbidden}`);
    }
  }
});

test("17: no sender converts sending to failed because of age", () => {
  for (const sender of SENDERS) {
    for (const forbidden of ["updated_at", "STALE", "30 * 60", "24 * 60"]) {
      assert.ok(!sender.code.includes(forbidden), `${sender.name} added stale recovery: ${forbidden}`);
    }
  }
});

test("35-36: the cron route and vercel.json are untouched", () => {
  assert.ok(cronCode.includes("runTransactionalEmailRetryCron()"));
  assert.ok(cronCode.includes("sweepDueDeferredCancellations(stripe)"));
  const vercel = JSON.parse(read("vercel.json"));
  assert.deepEqual(vercel.crons, [
    { path: "/api/cron/retry-order-notifications", schedule: "20 5 * * *" },
  ], "the cron schedule changed");
  assert.equal(vercel.crons.length, 1, "a second cron appeared");
});

test("37-39: no migration was added, edited or required", () => {
  const files = readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith(".sql")).sort();
    // PHASE 3I.B1 ADDED MIGRATION 036 (payment_problem family plus the
  // payment-status RPC). It is reviewed in
  // tests/subscription-payment-status-migration.test.mjs. What this
  // guard still protects is that no UNREVIEWED migration appeared.
  // PHASE 3J.B1 THEN ADDED 037 (the invoice-keyed refund-state writer),
  // reviewed in tests/subscription-refund-correlation-migration.test.mjs.
  assert.equal(files.length, 38);
  assert.equal(files[files.length - 1], "038_one_time_refund_writer_concurrency.sql");
  assert.equal(files[files.length - 2], "037_subscription_refund_correlation.sql");
  assert.equal(files[files.length - 3], "036_subscription_payment_status.sql");
  assert.equal(files[files.length - 4], "035_subscription_email_deliveries.sql");
  assert.deepEqual(files.filter(f => f.startsWith("037")), ["037_subscription_refund_correlation.sql"]);
  assert.ok(!files.some(f => f.startsWith("039")), "an unreviewed migration appeared");
  const sql035 = withoutComments(read("supabase/migrations/035_subscription_email_deliveries.sql"));
  // The four statuses are unchanged: 'ambiguous' is an APPLICATION result,
  // never a database status.
  assert.ok(sql035.includes("check (status in ('sending', 'sent', 'failed', 'superseded'))"));
  assert.ok(!sql035.includes("ambiguous"), "'ambiguous' must never reach the schema");
  assert.ok(!sql035.includes("owner_action"), "no owner-action status was invented");
  // And the application writes only the two statuses the grant permits.
  for (const sender of SENDERS) {
    const updates = sender.code.match(/\.update\(\{[^}]*\}\)/g) ?? [];
    for (const stmt of updates) {
      assert.ok(!stmt.includes("ambiguous"), `${sender.name} writes 'ambiguous' to the database`);
      for (const forbidden of ["subscription_id", "family", "event_key", "created_at", "updated_at"]) {
        assert.ok(!stmt.includes(forbidden), `${sender.name} writes ${forbidden}`);
      }
    }
  }
});

test("40-41: the three hardened senders stay out of billing, refunds untouched", () => {
  // PHASE 3I.B2 BUILT payment_problem, the fourth family. What still
  // holds for THIS family's sender and template is that they know
  // nothing about billing: they neither classify an invoice nor write a
  // payment status.
  for (const sender of SENDERS) {
    assert.ok(!sender.code.includes("payment_problem"), "a 3H sender learned about billing");
    assert.ok(!sender.code.includes("invoice.payment_failed"));
    assert.ok(!sender.code.includes("sync_subscription_payment_status"));
  }
  const refunds = withoutComments(read("lib/orderRefunds.ts"));
  assert.ok(!refunds.includes("subscription_email_deliveries"));
  assert.ok(!refunds.includes("classifySubscriptionEmailProviderError"));
});

test("42: B2C_SUBSCRIPTIONS_ENABLED is still closed unless exactly 'true'", () => {
  const checkoutRules = read("lib/subscriptionCheckoutRules.ts");
  assert.ok(checkoutRules.includes('export const SUBSCRIPTION_FEATURE_FLAG = "B2C_SUBSCRIPTIONS_ENABLED"'));
  assert.ok(checkoutRules.includes('env[SUBSCRIPTION_FEATURE_FLAG] === "true"'));
});

test("43: SHOP_STATUS is still prelaunch", () => {
  assert.ok(read("app/content.ts").includes('export const SHOP_STATUS = "prelaunch"'));
});

test("44: this suite reaches no network and no database", () => {
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
    "../lib/subscriptionEmailDeliveryRules.ts",
    "node:assert/strict",
    "node:fs",
    "node:path",
    "node:test",
    "node:url",
  ], "this suite imports something that can reach a database or a network");
});

/* ══════════════════════════════════════════════════════════════
   MUTATION PROOF
   ══════════════════════════════════════════════════════════════ */

test("mutation: treating statusCode null as failed would break this suite", () => {
  // The classifier is the single decision point, so a mutation of its
  // rule is simulated exactly by re-implementing that rule wrongly. If
  // the real classifier ever agreed with this, tests 7 and 12 above would
  // both fail - this asserts the two genuinely disagree today.
  const mutated = error => {
    const statusCode = error?.statusCode;
    // THE MUTATION: anything that is not a 5xx is treated as a refusal,
    // which is how a transport failure becomes a duplicate email.
    if (typeof statusCode === "number" && statusCode >= 500) return "ambiguous";
    return "definite_failure";
  };

  const transport = {
    name: "application_error",
    statusCode: null,
    message: "Unable to fetch data. The request could not be resolved.",
  };
  assert.equal(mutated(transport), "definite_failure", "the mutation must be wrong");
  assert.equal(
    classifySubscriptionEmailProviderError(transport),
    "ambiguous",
    "the real classifier must NOT agree with the mutation"
  );
  assert.notEqual(classifySubscriptionEmailProviderError(transport), mutated(transport));

  // And the same for a thrown exception and an unknown shape.
  for (const ambiguousInput of [{}, null, providerError(undefined), providerError("500")]) {
    assert.equal(classifySubscriptionEmailProviderError(ambiguousInput), "ambiguous");
    assert.equal(mutated(ambiguousInput), "definite_failure");
  }

  // The two only agree where agreement is correct: a real 4xx.
  assert.equal(classifySubscriptionEmailProviderError(providerError(422)), "definite_failure");
  assert.equal(mutated(providerError(422)), "definite_failure");
});

/* ══════════════════════════════════════════════════════════════
   19-29. A 409 LEAVES THE ROW 'sending', EVERYWHERE
   ══════════════════════════════════════════════════════════════ */

for (const sender of SENDERS) {
  test(`${sender.name}: 19-21, 25-27 - a 409 writes nothing at all`, () => {
    // The senders route EVERY provider error through the one classifier,
    // so 409 lands in the ambiguous branch by construction rather than by
    // a second rule that could drift. This asserts the wiring that makes
    // the classifier fix reach all three without touching them.
    const tail = deliverTail(sender);
    assert.ok(tail.includes("outcome = classifySubscriptionEmailProviderError(sendError);"),
      "the sender must classify rather than judge the status itself");
    // No sender inspects a status code on its own.
    assert.ok(!sender.code.includes("statusCode"),
      "a sender reads the status itself and could disagree with the classifier");
    assert.ok(!sender.code.includes("409"), "a sender hardcodes a status");

    // The ambiguous branch runs first and writes nothing.
    const ambiguousAt = tail.indexOf('if (outcome === "ambiguous")');
    const refusedAt = tail.indexOf('if (outcome === "definite_failure")');
    assert.ok(ambiguousAt !== -1 && ambiguousAt < refusedAt);
    const branch = tail.slice(ambiguousAt, refusedAt);
    assert.ok(branch.includes('return "ambiguous";'));
    for (const forbidden of ["markFailed", "markSent", "markSuperseded", ".update("]) {
      assert.ok(!branch.includes(forbidden), `a 409 would write ${forbidden}`);
    }
  });
}

test("22-24, 28: a retried 409 stays sending and is never re-selected", () => {
  const retryCode = withoutComments(read("lib/subscriptionEmailRetry.ts"));
  // The retry reuses the same three deliverClaimed* paths, so a 409 there
  // takes the same ambiguous branch proven above.
  for (const fn of [
    "deliverClaimedSubscriptionStarted",
    "deliverClaimedCancellationConfirmation",
    "deliverClaimedSubscriptionEnded",
  ]) {
    assert.ok(retryCode.includes(fn), `the retry does not reuse ${fn}`);
  }
  // The retry never classifies a provider error itself.
  assert.ok(!retryCode.includes("statusCode"));
  assert.ok(!retryCode.includes("classifySubscriptionEmailProviderError"));
  // 'ambiguous' is the sweep's catch-all and writes no status.
  assert.ok(retryCode.includes('if (result === "sent" || result === "failed" || result === "superseded") return result;')
    || retryCode.includes('return "ambiguous";'));
  // 29: candidate selection is still failed-only, so a row left at
  // 'sending' by a 409 can never be picked up again automatically.
  const load = retryCode.slice(
    retryCode.indexOf("loadFailed: async (family, limit) =>"),
    retryCode.indexOf("claimFailed: async deliveryId =>")
  );
  assert.ok(load.includes('.eq("status", "failed")'));
  for (const forbidden of ['"sending"', '.in("status"', ".or("]) {
    assert.ok(!load.includes(forbidden), `the work list was widened: ${forbidden}`);
  }
});

test("30: stale sending is still diagnostic only after this hotfix", () => {
  // A 409 row becomes a stale 'sending' row after 30 minutes. It must be
  // REPORTED and never resent - otherwise the fix would just move the
  // duplicate risk one step later.
  const rules = withoutComments(read("lib/subscriptionEmailDeliveryRules.ts"));
  const body = rules.slice(
    rules.indexOf("export async function inspectStaleSubscriptionEmailDeliveries"),
    rules.indexOf("export const PAYMENT_PROBLEM_FAMILY")
  );
  for (const forbidden of ["update", "upsert", "insert", "delete", "rpc", "claim"]) {
    assert.ok(!body.includes(forbidden), `the stale inspection can write: ${forbidden}`);
  }
});
