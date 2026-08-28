import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CANCELLATION_CONFIRMATION_FAMILY,
  SUBSCRIPTION_EMAIL_FAMILIES,
  SUBSCRIPTION_EMAIL_STATUSES,
  canonicalEventInstant,
  cancellationConfirmationEventKey,
  evaluateCancellationConfirmationPreflight,
  recipientFromCustomerSnapshot,
} from "../lib/subscriptionEmailDeliveryRules.ts";
import {
  buildCancellationConfirmationEmail,
  cancellationConfirmationIdempotencyKey,
} from "../lib/email/cancellationConfirmation.ts";
import { subscriptionStartedIdempotencyKey } from "../lib/email/subscriptionStarted.ts";
import { GLOA_FROM_HELLO, GLOA_REPLY_TO_SUPPORT } from "../lib/emailSenders.ts";

// SAFE DEFAULT SUITE: pure rule and template logic plus source-level
// checks. No server is spawned, no database is reachable, no Supabase
// client is constructed, no Stripe API is called, no subscription is
// cancelled and no email of any kind is sent. Nothing here executes SQL
// and nothing here requires TEST_SUPABASE_*.
//
// The rules this suite protects: a customer is told their cancellation is
// recorded exactly once per persisted (requested_at, effective_at) pair;
// a moved end date produces a NEW message rather than silence; an
// unscheduling produces none at all and closes the old one; a message
// that was genuinely delivered is never rewritten; and no mail provider
// failure can ever turn a successful cancellation into a failed one.

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

const sender = read("lib/cancellationConfirmationEmail.ts");
const rules = read("lib/subscriptionEmailDeliveryRules.ts");
const template = read("lib/email/cancellationConfirmation.ts");
const service = read("lib/subscriptionCancellation.ts");
const route = read("app/api/subscriptions/cancel/route.ts");
const webhook = read("app/api/stripe/webhook/route.ts");
const cron = read("app/api/cron/retry-order-notifications/route.ts");
const migration034 = read("supabase/migrations/034_subscription_cancellation.sql");
const migration035 = read(`supabase/migrations/${MIGRATION_035}`);

const senderCode = withoutComments(sender);
const rulesCode = withoutComments(rules);
const templateCode = withoutComments(template);
const serviceCode = withoutComments(service);
const routeCode = withoutComments(route);
const webhookCode = withoutComments(webhook);
const cronCode = withoutComments(cron);
const sql034 = withoutComments(migration034);
const sql035 = withoutComments(migration035);

const SUBSCRIPTION_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const REQUESTED_A = "2026-09-05T09:14:22.000Z";
const EFFECTIVE_A = "2026-10-03T00:00:00.000Z";
const EFFECTIVE_B = "2026-10-31T00:00:00.000Z";
const REQUESTED_B = "2026-11-20T11:02:03.000Z";

const KEY_A = `${REQUESTED_A}|${EFFECTIVE_A}`;

/** A subscription with a live, current cancellation. */
const subscription = (overrides = {}) => ({
  id: SUBSCRIPTION_ID,
  customer_type: "private",
  status: "active",
  customer_snapshot: { email: "kundin@example.com", name: "Mia" },
  cancellation_requested_at: REQUESTED_A,
  cancellation_effective_at: EFFECTIVE_A,
  ...overrides,
});

/** The eligibility question, asked before any row exists. */
const eligibility = (overrides = {}) =>
  evaluateCancellationConfirmationPreflight({
    subscription: subscription(overrides),
    expectedEventKey: null,
  });

/** The authoritative question, asked for a delivery already claimed. */
const claimed = (overrides = {}, expectedEventKey = KEY_A) =>
  evaluateCancellationConfirmationPreflight({
    subscription: subscription(overrides),
    expectedEventKey,
  });

const built = (facts = {}) =>
  buildCancellationConfirmationEmail({
    cancellation: {
      requestedAtIso: REQUESTED_A,
      effectiveAtIso: EFFECTIVE_A,
      accountSubscriptionsUrl: "https://gloamatcha.com/account/subscriptions",
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

/* ══════════════════════════════════════════════════════════════
   1-2. WHO MAY PRODUCE THIS MESSAGE
   ══════════════════════════════════════════════════════════════ */

test("1: only a private B2C subscription can produce this email", () => {
  assert.equal(eligibility().kind, "send");
  // A non-private subscription is refused. Migration 022 CHECKs the column
  // to 'private', so this is the lock that would still hold if that CHECK
  // were ever widened.
  assert.equal(eligibility({ customer_type: "business" }).kind, "not-eligible");
  assert.equal(eligibility({ customer_type: null }).kind, "not-eligible");
  // Once a row exists the same condition is 'failed', because the
  // confirmation is still owed rather than obsolete.
  assert.equal(claimed({ customer_type: "business" }).kind, "failed");
  // And the migration still restricts the column.
  assert.ok(sql034.includes("customer_type is distinct from 'private'"),
    "034 no longer refuses a non-private cancellation");
});

test("2: a successful cancellation POST triggers the sender", () => {
  // The route calls the service, and the service sends after the RPC has
  // durably written the pair.
  assert.ok(routeCode.includes("cancelSubscriptionForUser("));
  const fn = serviceFn("cancelSubscriptionForUser");
  assert.ok(fn.includes("sendCancellationConfirmationEmailIfNeeded(subscription.id)"),
    "a successful cancellation must confirm itself to the customer");
  // BOTH successful results, because 034's CASE C answers
  // 'already_scheduled' after writing a genuinely new requested_at.
  const sendAt = fn.indexOf("sendCancellationConfirmationEmailIfNeeded");
  const gateAt = fn.indexOf('if (result === "scheduled" || result === "already_scheduled")');
  assert.ok(gateAt !== -1, "the success gate changed shape");
  assert.ok(gateAt < sendAt, "the send must sit inside the success branch");
  // Strictly AFTER the RPC returned, never before it.
  assert.ok(fn.indexOf('admin.rpc("schedule_subscription_cancellation"') < sendAt);
});

test("2b: CASE C really is a new pair, which is why 'already_scheduled' sends", () => {
  // 034 writes cancellation_requested_at alone onto an effective date
  // Stripe already had, and still answers 'already_scheduled'.
  assert.ok(sql034.includes("set cancellation_requested_at = p_requested_at"),
    "034 no longer has the request-only write");
  assert.ok(sql034.includes("'request_recorded', true"),
    "034 no longer flags the request-only write");
  // A pair that gains a requested_at where there was none is a new key.
  const before = cancellationConfirmationEventKey({
    cancellationRequestedAt: null,
    cancellationEffectiveAt: EFFECTIVE_A,
  });
  const after = cancellationConfirmationEventKey({
    cancellationRequestedAt: REQUESTED_A,
    cancellationEffectiveAt: EFFECTIVE_A,
  });
  assert.equal(before, null, "an incomplete pair is not an event");
  assert.equal(after, KEY_A);
});

/* ══════════════════════════════════════════════════════════════
   3-6. THE EVENT KEY
   ══════════════════════════════════════════════════════════════ */

test("3: the sender reads the persisted timestamps AFTER the cancellation write", () => {
  // It takes a subscription id and nothing else, and reads the row itself.
  assert.ok(senderCode.includes("export async function sendCancellationConfirmationEmailIfNeeded(\n  subscriptionId: string\n): Promise<CancellationConfirmationEmailResult>")
    || senderCode.includes("sendCancellationConfirmationEmailIfNeeded(\n  subscriptionId: string\n)"),
    "the entry point must take only a subscription id");
  assert.ok(senderCode.includes('.from("subscriptions")'));
  assert.ok(senderCode.includes("cancellation_requested_at, cancellation_effective_at"));
  // The key is derived from the loaded row, not from anything passed in.
  const readAt = senderCode.indexOf("const first = await loadSubscription(subscriptionId);");
  const keyAt = senderCode.indexOf("const eventKey = eligibility.eventKey;");
  const claimAt = senderCode.indexOf("await claimCancellationConfirmation(");
  assert.ok(readAt !== -1 && keyAt !== -1 && claimAt !== -1);
  assert.ok(readAt < keyAt && keyAt < claimAt, "read, then derive the key, then claim");
});

test("4: the sender never trusts the route-calculated effective date", () => {
  // `schedule` is what the request computed BEFORE the RPC ran, and 034
  // has four outcomes that write different things. It is not passed.
  for (const forbidden of [
    "schedule", "effectiveCancelAt", "resolveCancellationSchedule",
    "cancelAt", "p_effective_at", "current_period_end",
  ]) {
    assert.ok(!senderCode.includes(forbidden), `the sender trusts a pre-RPC value: ${forbidden}`);
  }
  // And the service hands it nothing but the id.
  assert.ok(serviceCode.includes("sendCancellationConfirmationEmailIfNeeded(subscription.id)"));
  assert.ok(!serviceCode.includes("sendCancellationConfirmationEmailIfNeeded(subscription.id,"));
});

test("5: no browser or request timestamp can reach the event", () => {
  for (const source of [senderCode, rulesCode, templateCode]) {
    for (const forbidden of [
      "request.", "searchParams", "req.body", "Date.now(", "deps.now", "event.id",
    ]) {
      assert.ok(!source.includes(forbidden), `an outside value reaches the event: ${forbidden}`);
    }
  }
  // The two pure leaves hold no clock at all, so neither the key nor the
  // copy can be built from the moment a send happened to be attempted.
  for (const source of [rulesCode, templateCode]) {
    assert.ok(!source.includes("new Date()"), "a pure leaf reads the clock");
  }
  // The only clock in the sender is the sent_at stamp, which is not part
  // of any key.
  const clocks = senderCode.match(/new Date\(\)\.toISOString\(\)/g) ?? [];
  assert.equal(clocks.length, 1, "the sender reads the clock more than once");
  assert.ok(senderCode.includes('status: "sent", sent_at: new Date().toISOString()'));
});

test("6: the event key is BOTH persisted timestamps", () => {
  assert.equal(cancellationConfirmationEventKey({
    cancellationRequestedAt: REQUESTED_A,
    cancellationEffectiveAt: EFFECTIVE_A,
  }), `${REQUESTED_A}|${EFFECTIVE_A}`);

  // Neither half alone is enough.
  for (const half of [
    { cancellationRequestedAt: REQUESTED_A, cancellationEffectiveAt: null },
    { cancellationRequestedAt: null, cancellationEffectiveAt: EFFECTIVE_A },
    { cancellationRequestedAt: null, cancellationEffectiveAt: null },
    { cancellationRequestedAt: "", cancellationEffectiveAt: EFFECTIVE_A },
    { cancellationRequestedAt: REQUESTED_A, cancellationEffectiveAt: "   " },
    { cancellationRequestedAt: REQUESTED_A, cancellationEffectiveAt: "not a date" },
  ]) {
    assert.equal(cancellationConfirmationEventKey(half), null, JSON.stringify(half));
  }
});

test("6b: the canonical instant is deterministic and locale-free", () => {
  // One instant, one string, however it was spelled on the way in.
  const forms = [
    "2026-10-03T00:00:00.000Z",
    "2026-10-03T00:00:00+00:00",
    "2026-10-03T02:00:00+02:00",
    "2026-10-03T00:00:00.000000Z",
  ];
  for (const form of forms) {
    assert.equal(canonicalEventInstant(form), EFFECTIVE_A, form);
  }
  // Always UTC, always the same shape.
  assert.match(canonicalEventInstant(REQUESTED_A), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  for (const junk of [null, undefined, "", "   ", "gestern", 42]) {
    assert.equal(canonicalEventInstant(junk), null, String(junk));
  }
  // And it is the same representation the cancellation write already uses.
  assert.ok(serviceCode.includes("p_requested_at: requestAt.toISOString()"),
    "the cancellation write no longer persists a canonical ISO instant");
});

/* ══════════════════════════════════════════════════════════════
   7-9. ONE FACT, ONE MESSAGE
   ══════════════════════════════════════════════════════════════ */

test("7: the same persisted pair cannot create two delivery rows", () => {
  const keys = new Set([
    cancellationConfirmationEventKey({ cancellationRequestedAt: REQUESTED_A, cancellationEffectiveAt: EFFECTIVE_A }),
    cancellationConfirmationEventKey({ cancellationRequestedAt: REQUESTED_A, cancellationEffectiveAt: EFFECTIVE_A }),
    // Same instants, different spellings on the wire.
    cancellationConfirmationEventKey({
      cancellationRequestedAt: "2026-09-05T09:14:22+00:00",
      cancellationEffectiveAt: "2026-10-03T02:00:00+02:00",
    }),
  ]);
  assert.equal(keys.size, 1, "one cancellation fact must produce one key");
  assert.ok(sql035.includes("unique (subscription_id, family, event_key)"));
  assert.equal(CANCELLATION_CONFIRMATION_FAMILY, "cancellation_confirmation");
});

test("8: a duplicate POST does not duplicate the provider send", () => {
  // 034 answers an idempotent repeat 'already_scheduled' with ZERO writes,
  // so the pair is unchanged, the key is the same, and the claim loses.
  assert.ok(sql034.includes("'result', 'already_scheduled'"));
  assert.ok(senderCode.includes('if (claim.kind === "taken") return "already-claimed";'));
  // And a conflict is never reported as a delivery.
  assert.ok(!senderCode.includes('"already-sent"'));
});

test("9: another process representing the same fact also cannot duplicate it", () => {
  // The key is the persisted pair, not the caller and not a Stripe event,
  // so all three writers converge on one row for one fact.
  for (const source of [senderCode, rulesCode, templateCode]) {
    for (const forbidden of ["event.id", "eventId", "stripeEventId", "webhookEventId", "invoice.id"]) {
      assert.ok(!source.includes(forbidden), `an event id reaches the key: ${forbidden}`);
    }
  }
  // All three service call sites pass only a subscription id.
  const calls = serviceCode.match(/sendCancellationConfirmationEmailIfNeeded\([^)]*\)/g) ?? [];
  assert.equal(calls.length, 3, "the three cancellation writers must each confirm");
  assert.deepEqual([...new Set(calls)].sort(), [
    "sendCancellationConfirmationEmailIfNeeded(payload.subscription_id)",
    "sendCancellationConfirmationEmailIfNeeded(row.id)",
    "sendCancellationConfirmationEmailIfNeeded(subscription.id)",
  ]);
});

/* ══════════════════════════════════════════════════════════════
   10-15. THE FACT MOVES, OR GOES AWAY
   ══════════════════════════════════════════════════════════════ */

test("10: an unscheduling produces no cancellation confirmation", () => {
  // sync_subscription_from_stripe nulls BOTH columns on a genuine
  // unscheduling. With no pair there is no event and nothing is claimed.
  assert.ok(sql034.includes("v_unscheduled := v_sub.cancel_at is not null and p_cancel_at is null"),
    "034 no longer detects an unscheduling");
  const cleared = eligibility({
    cancellation_requested_at: null,
    cancellation_effective_at: null,
  });
  assert.equal(cleared.kind, "not-eligible");
  assert.match(cleared.reason, /no persisted cancellation pair/);
});

test("11: an unscheduling supersedes an old claimed delivery", () => {
  const gone = claimed({
    cancellation_requested_at: null,
    cancellation_effective_at: null,
  });
  assert.equal(gone.kind, "superseded");
  assert.match(gone.reason, /unscheduled/);
});

test("12: a changed effective date supersedes the old claimed delivery", () => {
  const moved = claimed({ cancellation_effective_at: EFFECTIVE_B });
  assert.equal(moved.kind, "superseded");
  assert.match(moved.reason, /changed after this delivery was claimed/);
  // The subscription having ended is also terminal for this message.
  assert.equal(claimed({ status: "cancelled" }).kind, "superseded");
});

test("13: a changed effective date creates a NEW event key", () => {
  const a = cancellationConfirmationEventKey({
    cancellationRequestedAt: REQUESTED_A, cancellationEffectiveAt: EFFECTIVE_A,
  });
  const b = cancellationConfirmationEventKey({
    cancellationRequestedAt: REQUESTED_A, cancellationEffectiveAt: EFFECTIVE_B,
  });
  assert.notEqual(a, b, "a moved end date must be a different event");
  // And the moved pair is sendable in its own right.
  const next = eligibility({ cancellation_effective_at: EFFECTIVE_B });
  assert.equal(next.kind, "send");
  assert.equal(next.eventKey, `${REQUESTED_A}|${EFFECTIVE_B}`);
  // Which is exactly what apply_deferred_subscription_cancellation does.
  assert.ok(sql034.includes("cancellation_effective_at = p_cancel_at"),
    "034 no longer moves the effective date on a deferred apply");
});

test("14: a re-request after unscheduling is a new event even on the same date", () => {
  // An unscheduling nulls both columns; the customer cancels again and the
  // new request happens to land on the SAME effective date. A key made of
  // the date alone would be already-claimed and the second confirmation
  // silently suppressed. The pair catches it.
  const first = cancellationConfirmationEventKey({
    cancellationRequestedAt: REQUESTED_A, cancellationEffectiveAt: EFFECTIVE_A,
  });
  const second = cancellationConfirmationEventKey({
    cancellationRequestedAt: REQUESTED_B, cancellationEffectiveAt: EFFECTIVE_A,
  });
  assert.notEqual(first, second, "a genuine second cancellation must be a new event");
  assert.equal(eligibility({ cancellation_requested_at: REQUESTED_B }).kind, "send");
  // And the old delivery, if it was never sent, is superseded rather than
  // left announcing a request that is no longer the current one.
  assert.equal(claimed({ cancellation_requested_at: REQUESTED_B }).kind, "superseded");
});

test("15: a sent delivery is never rewritten to superseded", () => {
  const supersede = senderCode.slice(senderCode.indexOf("async function markSuperseded"));
  assert.ok(supersede.includes('.update({ status: "superseded", sent_at: null })'));
  assert.ok(supersede.includes('.in("status", ["sending", "failed"])'),
    "sent -> superseded must be impossible");
  assert.ok(!supersede.includes('"sent"]'), "the guard must not admit a sent row");
  // Migration 035 says the same thing about this exact transition, and
  // the guard above is what enforces its wording.
  assert.ok(migration035.includes("'superseded'  never sent, and must never be sent. Terminal."),
    "035 no longer documents 'superseded' as never-sent and terminal");
});

/* ══════════════════════════════════════════════════════════════
   16-19. RECIPIENT AND PROVIDER IDENTITY
   ══════════════════════════════════════════════════════════════ */

test("16: the recipient comes only from the frozen customer_snapshot", () => {
  assert.equal(eligibility().recipient, "kundin@example.com");
  assert.equal(recipientFromCustomerSnapshot({ email: " a@b.de " }), "a@b.de");
  for (const snapshot of [null, {}, { email: "" }, { email: 7 }]) {
    assert.equal(recipientFromCustomerSnapshot(snapshot), null);
  }
  assert.equal(eligibility({ customer_snapshot: {} }).kind, "not-eligible");
  assert.equal(claimed({ customer_snapshot: {} }).kind, "failed");
  assert.ok(senderCode.includes("to: preflight.recipient,"));
});

test("17: there is no arbitrary recipient parameter anywhere", () => {
  const entry = senderCode.slice(senderCode.indexOf("export async function sendCancellationConfirmationEmailIfNeeded"));
  const signature = entry.slice(0, entry.indexOf("): Promise<"));
  for (const f of ["email", "recipient", "to:", "address"]) {
    assert.ok(!signature.includes(f), `the entry point takes a recipient: ${f}`);
  }
  for (const forbidden of ["customer_details", "invoice.customer_email", "stripe.customers"]) {
    assert.ok(!senderCode.includes(forbidden), `an outside address source: ${forbidden}`);
  }
});

test("18: the provider key changes when the event key changes", () => {
  const a = cancellationConfirmationIdempotencyKey(SUBSCRIPTION_ID, KEY_A);
  const b = cancellationConfirmationIdempotencyKey(SUBSCRIPTION_ID, `${REQUESTED_A}|${EFFECTIVE_B}`);
  const c = cancellationConfirmationIdempotencyKey(SUBSCRIPTION_ID, `${REQUESTED_B}|${EFFECTIVE_A}`);
  assert.equal(new Set([a, b, c]).size, 3, "one subscription may owe several confirmations");
  // The subscription id alone is NOT the key, unlike the start message.
  assert.notEqual(a, `gloa/cancellation-confirmation/${SUBSCRIPTION_ID}`);
  assert.ok(a.includes(KEY_A), "the key must carry the event");
});

test("19: the provider key is stable for the same event, and collides with nothing", () => {
  assert.equal(
    cancellationConfirmationIdempotencyKey(SUBSCRIPTION_ID, KEY_A),
    cancellationConfirmationIdempotencyKey(SUBSCRIPTION_ID, KEY_A)
  );
  const key = cancellationConfirmationIdempotencyKey(SUBSCRIPTION_ID, KEY_A);
  assert.ok(key.startsWith("gloa/cancellation-confirmation/"));
  for (const existing of [
    "gloa/internal-order/", "gloa/shipment/", "gloa/cancellation-request/",
    "gloa/cancellation-outcome/", "gloa/refund/", "gloa/subscription-started/",
    "gloa/subscription-cancel/", "gloa/subscription-defer/",
  ]) {
    assert.ok(!key.startsWith(existing), `the namespace collides with ${existing}`);
  }
  // And it is genuinely a different namespace from its sibling family.
  assert.notEqual(key, subscriptionStartedIdempotencyKey(SUBSCRIPTION_ID));
  assert.ok(senderCode.includes("cancellationConfirmationIdempotencyKey(subscriptionId, eventKey)"));
  assert.ok(senderCode.includes("{ idempotencyKey }"));
});

/* ══════════════════════════════════════════════════════════════
   20-25. THE COPY
   ══════════════════════════════════════════════════════════════ */

test("20: the email carries the authoritative end date", () => {
  const { html, text } = built();
  // 03.10.2026, formatted server-side in Europe/Berlin.
  assert.ok(html.includes("03.10.2026"), "the HTML must name the end date");
  assert.ok(text.includes("03.10.2026"), "the plain text must name the end date");
  assert.ok(text.includes("Dein GLOA Abo endet am"));
  // A different event renders a different date - the content follows the
  // event rather than the clock.
  assert.ok(built({ effectiveAtIso: EFFECTIVE_B }).text.includes("31.10.2026"));
});

test("20b: the date is server-formatted and never browser-local", () => {
  assert.ok(templateCode.includes('timeZone: "Europe/Berlin"'),
    "the template must pin the timezone");
  assert.ok(templateCode.includes('toLocaleDateString("de-DE"'));
  // No date is calculated here: no arithmetic on the instants at all.
  for (const forbidden of ["setDate(", "getTime() +", "getTime() -", "86400", "* 1000 *"]) {
    assert.ok(!templateCode.includes(forbidden), `the template calculates a date: ${forbidden}`);
  }
});

test("21: no raw ISO reaches the customer", () => {
  const { subject, html, text } = built();
  for (const surface of [subject, html, text]) {
    assert.ok(!surface.includes(EFFECTIVE_A), "a raw ISO instant is shown to the customer");
    assert.ok(!surface.includes(REQUESTED_A), "a raw ISO instant is shown to the customer");
    assert.ok(!/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(surface), "an ISO timestamp leaked into the copy");
  }
});

test("22: it does not say Abo beendet, and does not understate the cancellation", () => {
  const { subject, html, text } = built();
  for (const surface of [subject, html, text, templateCode]) {
    for (const forbidden of ["Abo beendet", "Abo ist beendet", "wurde beendet", "Abo gekündigt und beendet"]) {
      assert.ok(!surface.includes(forbidden), `it claims the subscription already ended: ${forbidden}`);
    }
  }
  // It is a confirmation of a scheduled cancellation, not a pending request.
  assert.ok(!built().text.includes("Kündigung angefragt"));
  assert.ok(built().text.includes("Deine Kündigung ist bei uns eingegangen."));
  assert.ok(built().text.includes("läuft dein Abo wie vorgesehen weiter"));
});

test("22b: no early-versus-late claim is made, because none is retry-stable", () => {
  const { html, text } = built();
  for (const surface of [html, text, templateCode]) {
    for (const forbidden of [
      "genau eine Lieferung", "noch eine Lieferung", "letzte Lieferung",
      "keine weitere Lieferung", "current_period_end", "currentPeriodEnd",
    ]) {
      assert.ok(!surface.includes(forbidden), `an unprovable delivery claim: ${forbidden}`);
    }
  }
});

test("23: no Stripe, Supabase or internal id is exposed", () => {
  const { subject, html, text } = built();
  for (const surface of [subject, html, text]) {
    for (const forbidden of [
      "Stripe", "stripe", "Supabase", "supabase", "sub_", "in_", "cus_",
      SUBSCRIPTION_ID, "event_key", "delivery", "webhook", "RPC",
      "last_paid_period_end", "cancel_at",
    ]) {
      assert.ok(!surface.includes(forbidden), `an internal detail reached the customer: ${forbidden}`);
    }
  }
});

test("24-25: the copy never says monatlich or monthly", () => {
  const { subject, html, text } = built();
  for (const surface of [subject, html, text, templateCode]) {
    for (const forbidden of ["monatlich", "Monatlich", "monthly", "Monthly", "pro Monat", "im Monat"]) {
      assert.ok(!surface.includes(forbidden), `a four-week cycle described as monthly: ${forbidden}`);
    }
  }
  assert.ok(built().text.includes("alle 4 Wochen"));
});

/* ══════════════════════════════════════════════════════════════
   26-27. THE CANCELLATION IS NEVER FAILED BY AN EMAIL
   ══════════════════════════════════════════════════════════════ */

test("26: a failed email cannot fail a successful cancellation", () => {
  // The sender never throws, at all.
  assert.ok(!/\bthrow\b/.test(senderCode), "the sender must never throw");
  // And no call site inspects or propagates its result.
  for (const fn of [
    "cancelSubscriptionForUser",
    "applyDeferredCancellationFromRenewal",
    "syncSubscriptionFromStripe",
  ]) {
    const body = serviceFn(fn);
    assert.ok(body.includes("sendCancellationConfirmationEmailIfNeeded("), `${fn} does not confirm`);
    assert.ok(!/const\s+\w+\s*=\s*await sendCancellationConfirmationEmailIfNeeded/.test(body),
      `${fn} branches on the email outcome`);
  }
  // The successful cancellation is still returned truthfully.
  assert.ok(serviceFn("cancelSubscriptionForUser").includes("return { ok: true, result, schedule };"));
});

test("27: no provider error can reach the customer's HTTP response", () => {
  // The sender returns a fixed vocabulary, never a provider message.
  assert.ok(senderCode.includes('| "sent"'));
  assert.ok(senderCode.includes('| "failed"'));
  assert.ok(!senderCode.includes("return sendErrorMessage"));
  // The provider message is logged where it happens and nowhere else.
  const logs = senderCode.match(/console\.error\([^;]*\)/g) ?? [];
  for (const line of logs) {
    assert.ok(!line.includes("preflight.recipient"), `a recipient is logged: ${line}`);
    assert.ok(!line.includes("customer_snapshot"), `a snapshot is logged: ${line}`);
  }
  // The route answers from the cancellation outcome only.
  assert.ok(!routeCode.includes("cancellationConfirmation"),
    "the route must not learn about the email at all");
});

/* ══════════════════════════════════════════════════════════════
   28-31. THE STATE TRANSITIONS
   ══════════════════════════════════════════════════════════════ */

test("28: provider acceptance records sent AND sent_at, unconditionally", () => {
  const markSent = senderCode.slice(
    senderCode.indexOf("async function markSent"),
    senderCode.indexOf("async function markFailed")
  );
  assert.ok(markSent.includes('.update({ status: "sent", sent_at: new Date().toISOString() })'));
  assert.ok(!markSent.includes('.eq("status", "sending")'),
    "recording 'sent' must not be conditional after provider acceptance");
});

test("29: provider failure records failed only over sending", () => {
  const markFailed = senderCode.slice(
    senderCode.indexOf("async function markFailed"),
    senderCode.indexOf("async function markSuperseded")
  );
  assert.ok(markFailed.includes('.update({ status: "failed", sent_at: null })'));
  assert.ok(markFailed.includes('.eq("status", "sending")'));
});

test("30: a superseded delivery never contacts the provider", () => {
  const deliver = senderCode.slice(senderCode.indexOf("async function deliverClaimedCancellationConfirmation"));
  const supersededAt = deliver.indexOf('if (preflight.kind === "superseded")');
  const resendAt = deliver.indexOf("getResendClient()");
  assert.ok(supersededAt !== -1 && resendAt !== -1);
  assert.ok(supersededAt < resendAt, "the superseded branch must precede the provider");
  const branch = deliver.slice(supersededAt, deliver.indexOf('if (preflight.kind === "not-eligible"'));
  assert.ok(branch.includes('return "superseded";'));
  assert.ok(!branch.includes("resend"));
});

test("31: no identity or generated column is ever written", () => {
  const updates = senderCode.match(/\.update\(\{[^}]*\}\)/g) ?? [];
  assert.equal(updates.length, 3, "exactly three result transitions");
  for (const stmt of updates) {
    for (const forbidden of ["subscription_id", "family", "event_key", "created_at", "updated_at"]) {
      assert.ok(!stmt.includes(forbidden), `an update writes ${forbidden}: ${stmt}`);
    }
    assert.ok(!/\bid:/.test(stmt), `an update writes the primary key: ${stmt}`);
  }
  // The claim names exactly the four columns migration 035 grants INSERT on.
  const claim = senderCode.slice(senderCode.indexOf(".upsert("), senderCode.indexOf("onConflict:"));
  for (const column of ["subscription_id", "family", "event_key", "status"]) {
    assert.ok(claim.includes(column), `the claim must supply ${column}`);
  }
  for (const forbidden of ["created_at", "updated_at", "sent_at"]) {
    assert.ok(!claim.includes(forbidden), `the claim supplies ${forbidden}`);
  }
  assert.ok(!/\bid:/.test(claim));
  // ON CONFLICT DO NOTHING, never DO UPDATE, and no select-then-insert.
  assert.ok(senderCode.includes('onConflict: "subscription_id,family,event_key"'));
  assert.ok(senderCode.includes("ignoreDuplicates: true"));
  assert.ok(!senderCode.includes("ignoreDuplicates: false"));
  const claimFn = senderCode.slice(
    senderCode.indexOf("async function claimCancellationConfirmation"),
    senderCode.indexOf("async function markSent")
  );
  assert.equal((claimFn.match(/\.select\(/g) ?? []).length, 1, "the claim reads before it writes");
  assert.ok(claimFn.indexOf(".upsert(") < claimFn.indexOf(".select("));
});

/* ══════════════════════════════════════════════════════════════
   32-36. WHAT THIS PHASE DID NOT TOUCH
   ══════════════════════════════════════════════════════════════ */

test("32: subscription_started is unchanged", () => {
  const started = withoutComments(read("lib/subscriptionStartedEmail.ts"));
  assert.ok(started.includes("subscriptionStartedIdempotencyKey(subscriptionId)"));
  assert.ok(started.includes('onConflict: "subscription_id,family,event_key"'));
  // It never learned about the cancellation family.
  for (const forbidden of ["cancellation_confirmation", "cancellationConfirmation", "cancellation_effective_at"]) {
    assert.ok(!started.includes(forbidden), `the start sender changed: ${forbidden}`);
  }
  assert.equal(subscriptionStartedIdempotencyKey(SUBSCRIPTION_ID), `gloa/subscription-started/${SUBSCRIPTION_ID}`);
});

test("33: the recurring invoice path is unchanged", () => {
  // subscription_cycle still creates its order and notifies fulfillment,
  // and still produces no customer payment email.
  assert.ok(webhookCode.includes("sendInternalOrderNotificationIfNeeded("));
  assert.ok(webhookCode.includes("sendSubscriptionStartedEmailIfNeeded("));
  assert.ok(webhookCode.includes("applyDeferredCancellationFromRenewal("));
  for (const forbidden of ["Zahlung erfolgreich", "renewalEmail"]) {
    assert.ok(!webhookCode.includes(forbidden), `a renewal email appeared: ${forbidden}`);
  }
  // The webhook route itself needed no change for this phase.
  assert.ok(!webhookCode.includes("cancellationConfirmationEmail"),
    "the webhook must reach this family only through the cancellation service");
});

test("34-35: no payment_problem sender appears, and the ending stays separate", () => {
  // PHASE 3H.4 NARROWED THIS GUARD, DELIBERATELY. subscriptionEnded now
  // exists as its own family, sent from customer.subscription.deleted.
  // What still holds is that payment_problem has no implementation
  // anywhere, and - the part this suite really owns - that the
  // CANCELLATION CONFIRMATION never becomes an ending message.
  // PHASE 3I.B2 BUILT payment_problem, so it is no longer absent. What
  // still holds is that THIS family's sender and template know nothing
  // about it.
  const libFiles = readdirSync(path.join(ROOT, "lib"));
  const emailFiles = readdirSync(path.join(ROOT, "lib/email"));
  assert.ok(libFiles.includes("paymentProblemEmail.ts"), "the 3I.B2 sender is missing");
  assert.ok(emailFiles.includes("paymentProblem.ts"), "the 3I.B2 template is missing");
  for (const source of [senderCode, templateCode]) {
    assert.ok(!source.includes("payment_problem"), "the confirmation learned about billing");
  }
  // THIS family's sender and template know nothing about the ending.
  for (const source of [senderCode, templateCode]) {
    assert.ok(!source.includes("subscription_ended"), "the confirmation must not send the ending");
    assert.ok(!source.includes("subscriptionEnded"), "the confirmation must not reach the ending");
  }
  // And the cancellation REQUEST paths still send no ending message: the
  // route, the cron and the webhook route itself never name it.
  for (const source of [routeCode, cronCode, webhookCode]) {
    assert.ok(!source.includes("subscriptionEndedEmail"),
      "an ending is sent from a non-terminal path");
  }
  assert.ok(!templateCode.includes("Abo beendet"), "the confirmation claims the abo ended");
});

test("36: no automatic retry was wired", () => {
  for (const [name, source] of [
    ["retry rules", withoutComments(read("lib/transactionalEmailRetryRules.ts"))],
    ["retry wiring", withoutComments(read("lib/transactionalEmailRetry.ts"))],
    ["cron route", cronCode],
  ]) {
    for (const forbidden of [
      "subscription_email_deliveries", "cancellation_confirmation",
      "cancellationConfirmationEmail", "subscription_started",
    ]) {
      assert.ok(!source.includes(forbidden), `the ${name} learned about this phase: ${forbidden}`);
    }
  }
  // The sender grows no sweep of its own.
  for (const forbidden of ["Sweep", "sweep", "batch", "limit(25)"]) {
    assert.ok(!senderCode.includes(forbidden), `the sender grew a sweep: ${forbidden}`);
  }
  // The 'failed' row it writes is the durable state such a sweep will use.
  assert.ok(senderCode.includes('.update({ status: "failed", sent_at: null })'));
});

/* ══════════════════════════════════════════════════════════════
   37-42. THE DATABASE AND THE LAUNCH GATES
   ══════════════════════════════════════════════════════════════ */

test("37: migration 035 still declares exactly the contract this phase uses", () => {
  assert.ok(sql035.includes("grant select on public.subscription_email_deliveries to service_role;"));
  assert.ok(sql035.includes("grant insert (subscription_id, family, event_key, status)"));
  assert.ok(sql035.includes("grant update (status, sent_at)"));
  assert.ok(sql035.includes("unique (subscription_id, family, event_key)"));
  assert.ok(sql035.includes("check (status in ('sending', 'sent', 'failed', 'superseded'))"));
  assert.ok(sql035.includes("'cancellation_confirmation'"));
  assert.ok(!/grant[^;]*delete/i.test(sql035));
  assert.ok(!sql035.includes("payment_problem"));
  // The code's vocabularies still match the live migration.
  for (const family of SUBSCRIPTION_EMAIL_FAMILIES) assert.ok(sql035.includes(`'${family}'`));
  for (const status of SUBSCRIPTION_EMAIL_STATUSES) assert.ok(sql035.includes(`'${status}'`));
});

test("38-39: 022 through 035 are all present and there is no 036", () => {
  const files = readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith(".sql")).sort();
    // PHASE 3I.B1 ADDED MIGRATION 036 (payment_problem family plus the
  // payment-status RPC). It is reviewed in
  // tests/subscription-payment-status-migration.test.mjs. What this
  // guard still protects is that no UNREVIEWED migration appeared.
  assert.equal(files.length, 36, "a migration was added or removed");
  assert.equal(files[files.length - 1], "036_subscription_payment_status.sql",
    "036 must be the highest, and 035 the one before it");
  assert.equal(files[files.length - 2], MIGRATION_035);
  assert.ok(!files.some(f => f.startsWith("037")), "an unreviewed migration appeared");
  for (let n = 22; n <= 35; n += 1) {
    const prefix = String(n).padStart(3, "0");
    assert.ok(files.some(f => f.startsWith(prefix)), `migration ${prefix} is missing`);
  }
  // And this phase's code writes no DDL of its own.
  for (const source of [senderCode, rulesCode, templateCode]) {
    for (const forbidden of ["create table", "alter table", "create index", "create function"]) {
      assert.ok(!source.toLowerCase().includes(forbidden), `the application writes DDL: ${forbidden}`);
    }
  }
});

test("40: B2C_SUBSCRIPTIONS_ENABLED is still closed unless exactly 'true'", () => {
  const checkoutRules = read("lib/subscriptionCheckoutRules.ts");
  assert.ok(checkoutRules.includes('export const SUBSCRIPTION_FEATURE_FLAG = "B2C_SUBSCRIPTIONS_ENABLED"'));
  assert.ok(checkoutRules.includes('env[SUBSCRIPTION_FEATURE_FLAG] === "true"'));
  for (const source of [senderCode, rulesCode, templateCode]) {
    assert.ok(!source.includes("B2C_SUBSCRIPTIONS_ENABLED"));
  }
});

test("41: SHOP_STATUS is still prelaunch", () => {
  assert.ok(read("app/content.ts").includes('export const SHOP_STATUS = "prelaunch"'));
});

test("42: nothing in this feature can reach a network or a database in a test", () => {
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
    "../lib/email/cancellationConfirmation.ts",
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

test("42b: it uses the established customer sender convention", () => {
  assert.ok(senderCode.includes("from: GLOA_FROM_HELLO,"));
  assert.ok(senderCode.includes("replyTo: GLOA_REPLY_TO_SUPPORT,"));
  assert.equal(GLOA_FROM_HELLO, "GLOA <hello@gloamatcha.com>");
  assert.equal(GLOA_REPLY_TO_SUPPORT, "support@gloamatcha.com");
  assert.ok(!senderCode.includes("GLOA_INTERNAL_ORDERS"));
});

/* ══════════════════════════════════════════════════════════════
   EVERY WRITER OF THE CANCELLATION PAIR
   ══════════════════════════════════════════════════════════════ */

test("writers: migration 034 has exactly three functions that write the pair", () => {
  // The audit this phase's architecture rests on. A fourth writer added
  // later must be reviewed against the confirmation, not discovered by a
  // customer holding a stale date.
  const writers = [
    "schedule_subscription_cancellation",
    "apply_deferred_subscription_cancellation",
    "sync_subscription_from_stripe",
  ];
  for (const fn of writers) {
    assert.ok(sql034.includes(`create or replace function public.${fn}(`), `${fn} disappeared`);
  }
  // The other three functions in 034 touch neither column.
  for (const fn of ["mark_subscription_cancelled", "record_paid_subscription_period"]) {
    const at = sql034.indexOf(`create or replace function public.${fn}(`);
    assert.notEqual(at, -1, `${fn} disappeared`);
    const body = sql034.slice(at, sql034.indexOf("$$;", at));
    assert.ok(!body.includes("cancellation_requested_at ="), `${fn} now writes requested_at`);
    assert.ok(!body.includes("cancellation_effective_at ="), `${fn} now writes effective_at`);
  }
});

test("writers: all three are reachable from exactly one module, which confirms them", () => {
  // Every application caller of the three RPCs lives in the cancellation
  // service, which is why one wiring point covers all four trigger paths.
  for (const rpc of [
    "schedule_subscription_cancellation",
    "apply_deferred_subscription_cancellation",
    "sync_subscription_from_stripe",
  ]) {
    assert.ok(serviceCode.includes(rpc), `${rpc} is no longer called from the service`);
    assert.ok(!routeCode.includes(rpc), `the route calls ${rpc} directly`);
    assert.ok(!webhookCode.includes(rpc), `the webhook calls ${rpc} directly`);
    assert.ok(!cronCode.includes(rpc), `the cron calls ${rpc} directly`);
  }
});

test("writers: the deferred apply confirms, covering BOTH the renewal and the sweep", () => {
  const fn = serviceFn("applyDeferredCancellationFromRenewal");
  assert.ok(fn.includes('if (applied === "applied")'), "only a real apply is a new fact");
  assert.ok(fn.includes("sendCancellationConfirmationEmailIfNeeded(row.id)"));
  // The sweep reaches the RPC through this same function, so the cron
  // route needs no knowledge of the email.
  const sweep = serviceFn("sweepDueDeferredCancellations");
  assert.ok(sweep.includes("applyDeferredCancellationFromRenewal("),
    "the sweep no longer routes through the shared apply");
  assert.ok(!sweep.includes("sendCancellationConfirmationEmailIfNeeded"),
    "the sweep must not send a second time");
  assert.ok(cronCode.includes("sweepDueDeferredCancellations("));
  assert.ok(!cronCode.includes("cancellationConfirmation"), "the cron route was extended");
});

test("writers: the Stripe reconciliation confirms only a genuine change", () => {
  const fn = serviceFn("syncSubscriptionFromStripe");
  assert.ok(fn.includes('if (result === "synced"'), "'unchanged' wrote nothing and must not send");
  assert.ok(fn.includes("sendCancellationConfirmationEmailIfNeeded(payload.subscription_id)"));
  // The local id comes from the RPC payload, which 034 returns.
  assert.ok(sql034.includes("'result', 'synced'"));
  assert.ok(sql034.includes("'subscription_id', v_sub.id"));
  // The webhook handler is untouched and still just reports the result.
  assert.ok(webhookCode.includes("const result = await syncSubscriptionFromStripe(subscription);"));
});

test("writers: customer.subscription.deleted still sends nothing", () => {
  // The termination is subscription_ended's fact, and that family is a
  // later phase. This handler must not borrow the confirmation.
  const at = webhookCode.indexOf("async function handleSubscriptionDeleted(");
  assert.notEqual(at, -1);
  const next = webhookCode.indexOf(`${NEWLINE}async function `, at + 1);
  const body = webhookCode.slice(at, next === -1 ? webhookCode.length : next);
  assert.ok(!body.includes("sendCancellationConfirmationEmailIfNeeded"));
  assert.ok(body.includes("markSubscriptionCancelledFromStripe("));
  // And the termination writer itself confirms nothing.
  assert.ok(!serviceFn("markSubscriptionCancelledFromStripe").includes("sendCancellationConfirmationEmailIfNeeded"));
});
