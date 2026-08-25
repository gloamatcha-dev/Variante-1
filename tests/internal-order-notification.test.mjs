import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildInternalOrderNotificationEmail } from "../lib/email/internalOrderNotification.ts";
import {
  GLOA_FROM_HELLO,
  GLOA_INTERNAL_ORDERS,
  GLOA_REPLY_TO_SUPPORT,
} from "../lib/emailSenders.ts";

// SAFE DEFAULT SUITE: pure template logic and source-level checks. No
// Resend client is constructed, no network call is made, no database is
// touched, and no email of any kind is sent.
//
// The rule this suite protects: the database is the source of truth. An
// email is a notification about an order that already exists, never a
// reason one exists, and never a reason one is lost.

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf-8");
const NEWLINE = String.fromCharCode(10);

const MIGRATIONS = path.join(ROOT, "supabase/migrations");
const sender = read("lib/internalOrderNotificationEmail.ts");
const template = read("lib/email/internalOrderNotification.ts");
const senders = read("lib/emailSenders.ts");
const customerSender = read("lib/orderConfirmationEmail.ts");
const webhook = read("app/api/stripe/webhook/route.ts");
const migration026 = read("supabase/migrations/026_internal_order_notification_state.sql");

const withoutComments = source => source
  .split(NEWLINE)
  .filter(line => {
    const t = line.trim();
    return !t.startsWith("--") && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
  })
  .join(NEWLINE);

const senderCode = withoutComments(sender);
const webhookCode = withoutComments(webhook);

const address = (overrides = {}) => ({
  name: "Test Kundin",
  company: null,
  line1: "Teststrasse 1",
  line2: null,
  city: "Berlin",
  postalCode: "10115",
  state: null,
  countryLabel: "Deutschland",
  ...overrides,
});

const order = (overrides = {}) => ({
  order_number: "GLOA-2026-000123",
  currency: "EUR",
  subtotal_gross_cents: 1999,
  shipping_gross_cents: 590,
  total_gross_cents: 2589,
  shippingAddress: address(),
  customerEmail: "kundin@example.test",
  customerName: "Test Kundin",
  source: "one_time",
  stripeInvoiceId: null,
  ...overrides,
});

const item = (overrides = {}) => ({
  productName: "GLOA Matcha",
  variantLabel: "30 g",
  quantity: 1,
  unitGrossCents: 1999,
  lineGrossCents: 1999,
  sku: "GLOA-MATCHA-30G",
  ...overrides,
});

/* ── Sender and recipient ───────────────────────────────────── */

test("addresses: the internal notification goes to orders@ from hello@", () => {
  assert.equal(GLOA_INTERNAL_ORDERS, "orders@gloamatcha.com");
  assert.equal(GLOA_FROM_HELLO, "GLOA <hello@gloamatcha.com>");
  assert.match(senderCode, /from: GLOA_FROM_HELLO/);
  assert.match(senderCode, /to: GLOA_INTERNAL_ORDERS/);
  // A customer address must never end up as the recipient of the internal
  // notification, so no request-supplied value is used for `to`.
  assert.ok(!/to: customerEmail|to: params\./.test(senderCode), "the internal mail could reach a customer");
});

test("addresses: the customer confirmation uses the canonical sender, not an env var", () => {
  assert.equal(GLOA_REPLY_TO_SUPPORT, "support@gloamatcha.com");
  const code = withoutComments(customerSender);
  assert.match(code, /from: GLOA_FROM_HELLO/);
  assert.match(code, /replyTo: GLOA_REPLY_TO_SUPPORT/);
  // RESEND_CONTACT_FROM used to gate this path: an unset value threw and
  // turned every paid-order webhook into a repeating 500.
  assert.ok(!/RESEND_CONTACT_FROM/.test(code), "the order email still depends on the contact-form variable");
});

test("addresses: the module is a pure leaf and holds no secret", () => {
  const code = withoutComments(senders);
  assert.deepEqual(code.split(NEWLINE).filter(l => l.trim().startsWith("import ")), []);
  for (const secret of ["RESEND_API_KEY", "process.env", "re_", "sk_", "SUPABASE"]) {
    assert.ok(!code.includes(secret), `the sender module mentions ${secret}`);
  }
});

/* ── The rendered email ─────────────────────────────────────── */

test("template: the subject carries the order number and the paid total", () => {
  const built = buildInternalOrderNotificationEmail({ order: order(), items: [item()] });
  assert.equal(built.subject, "Neue Bestellung GLOA-2026-000123 · 25,89 EUR");
});

test("template: persisted order data is rendered, in HTML and in plain text", () => {
  const built = buildInternalOrderNotificationEmail({ order: order(), items: [item()] });
  for (const output of [built.html, built.text]) {
    assert.ok(output.includes("GLOA-2026-000123"), "order number");
    assert.ok(output.includes("GLOA Matcha"), "product");
    assert.ok(output.includes("30 g"), "variant");
    assert.ok(output.includes("GLOA-MATCHA-30G"), "sku");
    assert.ok(output.includes("Teststrasse 1"), "address line");
    assert.ok(output.includes("10115 Berlin"), "postcode and city");
    assert.ok(output.includes("Deutschland"), "country name, not an ISO code");
    assert.ok(output.includes("kundin@example.test"), "customer email");
    assert.ok(output.includes("19,99"), "line total");
    assert.ok(output.includes("5,90"), "shipping");
    assert.ok(output.includes("25,89"), "paid total");
  }
  // German copy, and a real currency rather than a symbol guess.
  assert.match(built.html, /Neue Bestellung/);
  assert.match(built.html, /Lieferadresse/);
  assert.match(built.html, /Zu packen/);
});

test("template: multiple items all appear, each with its own line total", () => {
  const built = buildInternalOrderNotificationEmail({
    order: order({ subtotal_gross_cents: 8498, total_gross_cents: 8498, shipping_gross_cents: 0 }),
    items: [
      item(),
      item({ variantLabel: "50 g", sku: "GLOA-MATCHA-50G", unitGrossCents: 2999, lineGrossCents: 2999 }),
      item({ variantLabel: "100 g", sku: "GLOA-MATCHA-100G", quantity: 1, unitGrossCents: 5499, lineGrossCents: 5499 }),
    ],
  });
  for (const sku of ["GLOA-MATCHA-30G", "GLOA-MATCHA-50G", "GLOA-MATCHA-100G"]) {
    assert.ok(built.html.includes(sku), sku);
    assert.ok(built.text.includes(sku), sku);
  }
  assert.equal([...built.html.matchAll(/GLOA Matcha/g)].length, 3);
  // Known-zero shipping is a real price and says so.
  assert.ok(built.html.includes("Kostenlos"));
  assert.ok(built.text.includes("Versand: Kostenlos"));
});

test("template: an optional field that is missing is omitted, never invented", () => {
  const built = buildInternalOrderNotificationEmail({
    order: order({ customerName: null, stripeInvoiceId: null, shipping_gross_cents: null }),
    items: [item({ sku: null })],
  });
  assert.ok(!built.html.includes("Kundin/Kunde"), "a name row appeared without a name");
  assert.ok(!built.html.includes("Stripe-Rechnung"), "an invoice row appeared without an invoice");
  // Unknown shipping is genuinely unknown: no row, and above all no
  // fabricated zero.
  assert.ok(!built.html.includes("Versand"), "a shipping row appeared for an unknown amount");
  assert.ok(!built.html.includes("[null]") && !built.text.includes("null"), "a null leaked into the output");
  // A missing address is called out rather than silently rendered empty.
  const noAddress = buildInternalOrderNotificationEmail({
    order: order({ shippingAddress: null }),
    items: [item()],
  });
  assert.match(noAddress.html, /Keine Lieferadresse gespeichert/);
});

test("template: a subscription order is labelled as one and carries its invoice", () => {
  const built = buildInternalOrderNotificationEmail({
    order: order({ source: "subscription", stripeInvoiceId: "in_test_123" }),
    items: [item()],
  });
  assert.ok(built.html.includes("Abo-Lieferung (alle 4 Wochen)"), "the cycle must be named exactly");
  assert.ok(built.text.includes("in_test_123"), "the invoice id is needed for reconciliation");
  // Never described as monthly.
  assert.ok(!/monatlich|Monat/i.test(built.html), "the cadence was described as monthly");
  const oneTime = buildInternalOrderNotificationEmail({ order: order(), items: [item()] });
  assert.ok(oneTime.html.includes("Einzelbestellung"));
  assert.ok(!oneTime.html.includes("Abo-Lieferung"));
});

test("template: customer-supplied content is HTML escaped", () => {
  const hostile = '<script>alert("x")</script> & "quoted" \'single\'';
  const built = buildInternalOrderNotificationEmail({
    order: order({
      customerName: hostile,
      customerEmail: hostile,
      shippingAddress: address({ name: hostile, line1: hostile, city: hostile }),
    }),
    items: [item({ productName: hostile, variantLabel: hostile, sku: hostile })],
  });
  assert.ok(!built.html.includes("<script>"), "an unescaped script tag reached the HTML");
  assert.ok(built.html.includes("&lt;script&gt;"), "the tag must be escaped, not stripped");
  assert.ok(built.html.includes("&amp;"), "ampersands must be escaped");
  assert.ok(built.html.includes("&quot;") && built.html.includes("&#39;"), "quotes must be escaped");
  // The plain-text part is not HTML and is deliberately left as typed.
  assert.ok(built.text.includes("<script>"));
});

test("template: no tracking pixel, no script, no unsubscribe link", () => {
  const built = buildInternalOrderNotificationEmail({ order: order(), items: [item()] });
  assert.ok(!/<img/i.test(built.html), "an image was added, which is how a tracking pixel arrives");
  assert.ok(!/<script/i.test(built.html.replace(/&lt;script&gt;/g, "")), "javascript in an email");
  assert.ok(!/unsubscribe|abmelden|newsletter/i.test(built.html), "a transactional email must carry no unsubscribe link");
  assert.ok(!/linear-gradient|gradient/i.test(built.html), "no gradients");
  // Email-safe construction: table layout, inline styles, no web font.
  assert.match(built.html, /<table role="presentation"/);
  assert.match(built.html, /font-family:Arial,Helvetica,sans-serif/);
  assert.ok(!/@import|fonts\.googleapis|<link/i.test(built.html), "an external font or stylesheet was required");
  assert.match(built.html, /<meta name="viewport" content="width=device-width,initial-scale=1"\/>/);
});

test("template: brand tokens match the GLOA identity and it is a pure leaf", () => {
  const built = buildInternalOrderNotificationEmail({ order: order(), items: [item()] });
  for (const token of ["#1746D1", "#F5EBE2", "#111111", "#4F3A5B"]) {
    assert.ok(built.html.includes(token), `missing brand colour ${token}`);
  }
  assert.ok(built.html.includes(">GLOA<"), "the wordmark must be present");
  // Leaf by construction, which is what makes this suite possible at all.
  assert.deepEqual(template.split(NEWLINE).filter(l => l.trim().startsWith("import ")), []);
});

test("template: no secret, no internal id and no payment credential is rendered", () => {
  const built = buildInternalOrderNotificationEmail({
    order: order({ source: "subscription", stripeInvoiceId: "in_test_123" }),
    items: [item()],
  });
  for (const forbidden of ["sk_", "re_", "whsec_", "RESEND_API_KEY", "SUPABASE_SECRET_KEY", "pi_", "card", "iban"]) {
    assert.ok(!built.html.includes(forbidden), `the email renders ${forbidden}`);
  }
  // The input type carries no order id and no user id, so neither can
  // leak even by accident.
  assert.ok(!/\border\.id\b|user_id/.test(template));
});

/* ── Idempotency ────────────────────────────────────────────── */

test("idempotency: the send is claimed atomically before Resend is called", () => {
  // Same guard migration 017 established for the customer email: the
  // UPDATE matches only pending/failed, so a redelivered webhook or a
  // concurrent delivery finds the row already moved and sends nothing.
  assert.match(senderCode, /\.update\(\{ internal_notification_status: "sending" \}\)/);
  // NULL-or-failed, deliberately. A 'pending' default would have made
  // every historical order look claimable.
  assert.match(senderCode, /\.or\("internal_notification_status\.is\.null,internal_notification_status\.eq\.failed"\)/);
  assert.ok(!/"pending"/.test(senderCode), "a pending state survived");
  assert.match(senderCode, /if \(claim === "already-sent"\) return;/);
  // The claim happens BEFORE the provider is even constructed.
  assert.ok(
    senderCode.indexOf("claimInternalNotification(order.id)") < senderCode.indexOf("getResendClient()"),
    "the claim must precede the send"
  );
  assert.ok(
    senderCode.indexOf('if (claim === "already-sent") return;') < senderCode.indexOf("resend.emails.send"),
    "an already-sent order must not reach Resend"
  );
});

test("idempotency: a failure is recorded as retryable, and never touches the order", () => {
  assert.match(senderCode, /internal_notification_status: "failed"/);
  assert.match(senderCode, /internal_notification_status: "sent", internal_notification_sent_at/);
  // Email state and order state are separate. Only what is written
  // matters here - the sender legitimately READS the order's totals to
  // render them - so this inspects the update payloads themselves.
  const updates = [...senderCode.matchAll(/\.update\(\{([^}]*)\}\)/g)].map(m => m[1]);
  assert.equal(updates.length, 3, "expected exactly the claim, the sent and the failed update");
  for (const payload of updates) {
    for (const forbidden of ["payment_status", "total_gross_cents", "fulfillment_status", "placed_at", "confirmation_email"]) {
      assert.ok(!payload.includes(forbidden), `the notification writes ${forbidden}`);
    }
    assert.match(payload, /internal_notification_/, "an update touched something other than notification state");
  }
  assert.ok(!/\.delete\(|\.insert\(/.test(senderCode), "the notification creates or removes rows");
});

test("retry: a failed internal notification is genuinely retried, not just marked", () => {
  // The first version did not throw, so the handler reached
  // recordStripeWebhookEvent, the event became terminally processed, and
  // nothing ever looked at the row again. The column said "retryable";
  // the system had no retry.
  assert.match(senderCode, /throw new Error\(`internal order notification send failed for order/);
  assert.match(senderCode, /throw new Error\("email provider not configured"\)/);
  assert.match(senderCode, /throw new Error\(`could not claim internal notification state/);
  // "Already sent" is success and must never throw.
  assert.match(senderCode, /if \(claim === "already-sent"\) return;/);

  // The throw only helps because the webhook turns it into a 500 BEFORE
  // the event is recorded.
  const catchAt = webhookCode.indexOf("} catch (err) {", webhookCode.indexOf("export async function POST"));
  const recordAt = webhookCode.indexOf("const recorded = await recordStripeWebhookEvent");
  assert.ok(catchAt > 0 && recordAt > catchAt, "a throw must return 500 before the event is recorded");

  // And the customer email throws for the same reason, so both share one
  // retry mechanism rather than inventing a second.
  assert.match(withoutComments(customerSender), /throw new Error\(`order confirmation email send failed/);
});

test("retry: every step a Stripe redelivery repeats is idempotent", () => {
  // Throwing is only safe because a retry cannot duplicate a business
  // effect. Each of these is the guard that makes that true.
  const attempts = read("lib/checkoutAttempts.ts");
  assert.match(attempts, /onConflict: "request_id", ignoreDuplicates: true/);
  assert.match(read("supabase/migrations/011_orders_from_paid_checkout.sql"),
    /create unique index orders_checkout_attempt_id_key/);
  assert.match(read("supabase/migrations/022_recurring_subscription_foundation.sql"),
    /create unique index checkout_attempts_stripe_invoice_id_key/);
  // Both email claims skip an already-sent order rather than resending.
  assert.match(senderCode, /if \(claim === "already-sent"\) return;/);
  assert.match(withoutComments(customerSender), /if \(claim === "already-sent"\) return;/);
});

test("idempotency: no secret reaches a log line", () => {
  const logs = [...senderCode.matchAll(/console\.error\(([^;]*)\)/g)].map(m => m[1]);
  assert.ok(logs.length > 0);
  for (const line of logs) {
    // Naming a missing variable is fine and useful; interpolating a value
    // is not. Only interpolations are inspected.
    const interpolated = [...line.matchAll(/\$\{([^}]*)\}/g)].map(m => m[1]);
    for (const value of interpolated) {
      for (const leak of ["customerEmail", "shippingAddress", "apiKey", "html", "address", "params.", "emailOrder"]) {
        assert.ok(!value.includes(leak), `a log line interpolates ${leak}: ${value}`);
      }
    }
  }
  // The key itself is never interpolated anywhere, only named.
  assert.ok(!/\$\{[^}]*RESEND_API_KEY[^}]*\}/.test(senderCode), "the api key is interpolated somewhere");
});

/* ── Wiring: the order comes first, always ──────────────────── */

test("wiring: both order flows notify only AFTER a durable order exists", () => {
  // One-time flow.
  const oneTimeOrder = webhookCode.indexOf("const order = await createOrderFromPaidCheckoutAttempt");
  const oneTimeInternal = webhookCode.indexOf("await sendInternalOrderNotificationIfNeeded");
  assert.ok(oneTimeOrder > 0 && oneTimeInternal > oneTimeOrder, "the one-time email runs before the order exists");

  // Subscription flow: the fulfillment call returns only after both live
  // RPCs have created the order.
  const subscriptionFulfill = webhookCode.indexOf("await fulfillPaidSubscriptionInvoice");
  const subscriptionEmails = webhookCode.indexOf("order: result.order");
  assert.ok(subscriptionFulfill > 0 && subscriptionEmails > subscriptionFulfill);

  // And no email path can create an order.
  const sendModules = senderCode + withoutComments(customerSender);
  assert.ok(!/create_order_from_paid_checkout|createOrderFromPaidCheckoutAttempt/.test(sendModules),
    "an email module creates an order");
});

test("wiring: the customer confirmation precedes the internal notification", () => {
  // Both now throw, so whichever runs first gets the first attempt - and
  // the customer's confirmation is the one they are owed.
  // Call sites only - the import block lists them in the other order.
  const body = webhookCode.slice(webhookCode.indexOf("export async function POST"));
  const customer = body.indexOf("await sendOrderConfirmationEmailIfNeeded");
  const internal = body.indexOf("await sendInternalOrderNotificationIfNeeded");
  assert.ok(customer > 0, "the customer confirmation is never called");
  assert.ok(internal > customer, "the customer email must go first");

  // Fulfillment is told about EVERY paid order, one-off and subscription
  // cycle alike. The generic customer confirmation is one-time only.
  assert.equal([...body.matchAll(/await sendInternalOrderNotificationIfNeeded\(/g)].length, 2,
    "both order flows must notify fulfillment");
  assert.equal([...body.matchAll(/await sendOrderConfirmationEmailIfNeeded\(/g)].length, 1,
    "the generic confirmation belongs to the one-time flow only");
});

test("wiring: the subscription email uses the frozen snapshot, not current data", () => {
  const fulfillment = withoutComments(read("lib/subscriptionInvoiceFulfillment.ts"));
  // The lines come off the checkout attempt the order was built from.
  assert.match(fulfillment, /const frozenItems = await deps\.loadAttemptItems\(checkoutAttemptId\);/);
  assert.match(fulfillment, /items: frozenItems,/);
  // The recipient comes from the frozen customer snapshot, not from
  // Stripe's billing details.
  assert.match(fulfillment, /subscription\.customer_snapshot \?\? \{\}/);
  assert.ok(!/customer_details/.test(fulfillment), "Stripe billing details became the fulfillment source");
});

test("wiring: the source label is derived, never guessed", () => {
  assert.match(webhookCode, /source: "one_time"/);
  assert.match(webhookCode, /source: "subscription"/);
  // A subscription order carries its invoice; a one-off has none to give.
  assert.match(webhookCode, /stripeInvoiceId: result\.stripeInvoiceId/);
  const oneTimeBlock = webhookCode.slice(
    webhookCode.indexOf('source: "one_time"') - 600,
    webhookCode.indexOf('source: "one_time"') + 60
  );
  assert.ok(!/stripeInvoiceId/.test(oneTimeBlock), "a one-off order was given an invoice id");
});

/* ── Migration 026 ──────────────────────────────────────────── */

test("migration: 026 owns its number and adds only the two state columns", () => {
  const files = readdirSync(MIGRATIONS).filter(n => n.endsWith(".sql")).sort();
  // 026 was the next free number when it was written. 027 has since been
  // taken by the shipment confirmation email state, which is a different
  // message on its own pair of columns - so what matters here is that
  // exactly one file owns 026 and that it is still this one.
  assert.deepEqual(files.filter(n => n.startsWith("026")), ["026_internal_order_notification_state.sql"]);
  assert.equal(files.filter(n => n.startsWith("027")).length, 1);

  const sql = withoutComments(migration026);
  const columns = [...sql.matchAll(/add column (\S+) (text|timestamptz)/g)].map(m => [m[1], m[2]]);
  assert.deepEqual(columns, [
    ["internal_notification_status", "text"],
    ["internal_notification_sent_at", "timestamptz"],
  ]);
  // THE HISTORICAL-ORDER GUARD. Nullable and with NO default, so applying
  // 026 cannot write a state into every order that already exists. A NOT
  // NULL DEFAULT 'pending' - the shape 017 uses - would have made the
  // entire order history look like it was queued and owed a notification.
  assert.ok(!/not null/i.test(sql), "the column is NOT NULL and would be written into every historical row");
  assert.ok(!/default/i.test(sql), "a default would be written into every historical row");
  assert.ok(!/'pending'/.test(sql), "'pending' is a state no historical order may silently acquire");
  // Only states a real attempt can produce.
  assert.match(sql, /check \(internal_notification_status in \('sending', 'sent', 'failed'\)\)/);
  // Historical orders are not rewritten.
  assert.ok(!/update public\.orders/i.test(sql), "026 backfills historical orders");
  assert.ok(!/delete from|drop column|drop index/i.test(sql));
});

test("migration: the grant is column-scoped and nothing else is widened", () => {
  const sql = withoutComments(migration026);
  assert.match(sql, /grant update \(internal_notification_status, internal_notification_sent_at\)\s*on public\.orders to service_role;/);
  // Exactly one grant, and no blanket table UPDATE that could reach a
  // money column.
  const grants = [...sql.matchAll(/^grant[^;]*;/gim)];
  assert.equal(grants.length, 1, "026 issues more than one grant");
  assert.ok(!/grant update on public\.orders/i.test(sql), "a blanket table update was granted");
  assert.ok(!/to anon|to authenticated|to public/i.test(sql), "a browser role was granted something");
  assert.ok(!/alter default privileges|create policy|row level security/i.test(sql), "026 changes the RLS or privilege model");
});

test("migration: 022 through 025 are untouched and still live", () => {
  for (const [file, marker] of [
    ["022_recurring_subscription_foundation.sql", /create or replace function public\.activate_subscription_from_invoice\(/],
    ["023_harden_stripe_customers_grants.sql", /grant select, insert, update on table public\.checkout_attempts to service_role;/],
    ["024_seed_b2c_subscription_plans.sql", /grant select on table public\.b2c_subscription_plans to authenticated;/],
    ["025_grant_subscription_plans_service_role.sql", /grant select on table public\.b2c_subscription_plans to service_role;/],
  ]) {
    assert.match(read(`supabase/migrations/${file}`), marker, `${file} changed`);
  }
  // 017 established this pattern and is unchanged.
  assert.match(read("supabase/migrations/017_order_confirmation_email_state.sql"),
    /grant update \(confirmation_email_status, confirmation_email_sent_at\) on public\.orders to service_role;/);
});

/* ── Scope and safety ───────────────────────────────────────── */

test("scope: nothing out of phase was implemented", () => {
  const newCode = senderCode + withoutComments(template) + withoutComments(senders);
  for (const later of [
    "shipment", "tracking_number", "carrier", "cancel", "pause", "resume",
    "newsletter", "broadcast", "campaign", "abandoned", "b2b", "B2B",
  ]) {
    assert.ok(!newCode.includes(later), `phase 1 implemented ${later}`);
  }
  // The subscription feature flag is untouched and still closed.
  assert.match(read(".env.example"), /B2C_SUBSCRIPTIONS_ENABLED=\s*$/m);
  assert.ok(!newCode.includes("B2C_SUBSCRIPTIONS_ENABLED"), "the email layer reads the feature flag");
});

test("safety: this suite sends no email and constructs no client", () => {
  const self = read("tests/internal-order-notification.test.mjs");
  for (const line of self.split(NEWLINE).filter(l => l.trim().startsWith("import "))) {
    assert.ok(!/["']resend["']/.test(line), `the tests must not import the Resend SDK: ${line}`);
    assert.ok(!/supabaseAdmin|@supabase\/supabase-js/.test(line), `the tests must not import a database client: ${line}`);
  }
  // Assertion strings that NAME a call are not calls, so this looks at
  // the suite with its own string literals removed.
  const executable = self.replace(/"[^"]*"/g, '""').replace(/`[^`]*`/g, "``");
  assert.ok(!/fetch\(|emails\.send\(|createClient\(/.test(executable), "the tests must not open a connection");
});
