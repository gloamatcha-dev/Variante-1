import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  INVOICE_REFUND_WRITER_RESULTS,
  REFUND_EVENT_TYPES,
  correlateInvoiceFromInvoicePayments,
  invoiceIdFromInvoicePayment,
  invoiceRefundWriterResolvedAnOrder,
  isRefundEventType,
  paymentIntentIdFromRefundEvent,
  summarizeStripeRefunds,
} from "../lib/stripeRefunds.ts";
import {
  hasSettledRefund,
  isNewSettledRefundFact,
  isNewerThanNotified,
} from "../lib/refundConfirmationRules.ts";
import { refundConfirmationIdempotencyKey } from "../lib/email/refundConfirmation.ts";

// SAFE DEFAULT SUITE (Phase 3J.B2). Pure correlation logic plus
// source-level checks. No Stripe client is constructed, no Supabase
// client is created, no SQL is executed, no refund is created, no email
// is sent and no environment is read. The only child process it starts
// is git, which is local.
//
// What this suite protects: a refund for one subscription cycle reaches
// that cycle's order and no other, or it reaches nothing at all.

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf-8");
const NEWLINE = String.fromCharCode(10);

const withoutComments = source => source
  .split(NEWLINE)
  .filter(line => {
    const t = line.trim();
    return !t.startsWith("--") && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
  })
  .join(NEWLINE);

const MIGRATIONS = path.join(ROOT, "supabase/migrations");
const syncSource = read("lib/orderRefunds.ts");
const syncCode = withoutComments(syncSource);
const pureCode = withoutComments(read("lib/stripeRefunds.ts"));
const webhookCode = withoutComments(read("app/api/stripe/webhook/route.ts"));

/**
 * The one-time half and the subscription half of lib/orderRefunds.ts,
 * separated so "the one-time path does X" can actually be asserted
 * about the one-time path rather than about the file.
 */
const FALLBACK_AT = syncCode.indexOf("async function syncSubscriptionOrderRefundState");
const primaryPath = syncCode.slice(
  syncCode.indexOf("export async function syncOrderRefundStateFromStripe"),
  FALLBACK_AT
);
const fallbackPath = syncCode.slice(FALLBACK_AT);

const PI = "pi_3QabcdefGHIJKL";
const INVOICE_A = "in_1AaaaaaaaaaaaaA";
const INVOICE_B = "in_1BbbbbbbbbbbbbB";

/** A well-formed InvoicePayment naming invoice A, paid by PI. */
const entry = (over = {}) => ({
  invoice: INVOICE_A,
  payment: { type: "payment_intent", payment_intent: PI },
  ...over,
});

const correlate = (entries, hasMore = false, expected = PI) =>
  correlateInvoiceFromInvoicePayments(entries, hasMore, expected);

/* ══════════════════════════════════════════════════════════════
   1-3. THE ONE-TIME PATH IS UNTOUCHED, AND IS STILL FIRST
   ══════════════════════════════════════════════════════════════ */

test("1: a one-time refund still resolves through orders.stripe_payment_intent_id", () => {
  assert.ok(primaryPath.includes('.from("orders")'));
  assert.ok(primaryPath.includes('.select("id, currency")'));
  assert.ok(primaryPath.includes('.eq("stripe_payment_intent_id", trimmedId)'));
  // And it still writes through migration 019's function, unchanged.
  assert.ok(primaryPath.includes('admin.rpc("apply_order_refund_state", {'));
  assert.ok(primaryPath.includes("p_payment_intent_id: trimmedId,"));
  // The ambiguity refusal is still the ambiguity refusal.
  assert.ok(primaryPath.includes('return { result: "ambiguous_payment_intent"'));
});

test("2: the one-time path issues no InvoicePayment request at all", () => {
  assert.ok(!primaryPath.includes("invoicePayments"),
    "every refund would now pay for a reverse lookup it does not need");
  assert.ok(!primaryPath.includes("correlateInvoiceFromInvoicePayments"));
  assert.ok(!primaryPath.includes("apply_order_refund_state_by_invoice"));
  // The InvoicePayment read exists exactly once in the whole module.
  assert.equal([...syncCode.matchAll(/invoicePayments\.list\(/g)].length, 1);
});

test("3: the subscription fallback is entered ONLY after a zero-row primary lookup", () => {
  const zeroRowGuard = primaryPath.indexOf("if (!order || order.length === 0) {");
  const call = primaryPath.indexOf("return await syncSubscriptionOrderRefundState(");
  assert.ok(zeroRowGuard > -1, "the zero-row guard moved");
  assert.ok(call > zeroRowGuard, "the fallback is reachable before the primary lookup answers");
  // Exactly one call site, and it is that one.
  assert.equal([...syncCode.matchAll(/syncSubscriptionOrderRefundState\(/g)].length, 2,
    "declaration plus exactly one call site");
  // A CONTESTED correlation is still refused rather than retried by
  // another route: the ambiguity check runs before the zero-row branch.
  assert.ok(primaryPath.indexOf("if (order && order.length > 1) {") < zeroRowGuard);
});

/* ══════════════════════════════════════════════════════════════
   4-8. THE REQUEST, AND THE ONE-PAGE RULE
   ══════════════════════════════════════════════════════════════ */

test("4: the fallback filters by the exact payment intent", () => {
  assert.ok(fallbackPath.includes("stripe.invoicePayments.list({"));
  assert.ok(fallbackPath.includes("payment: {"));
  assert.ok(fallbackPath.includes('type: "payment_intent",'));
  assert.ok(fallbackPath.includes("payment_intent: trimmedId,"));
  // Never a charge, a customer, a subscription or a date filter.
  for (const forbidden of ["charge:", "customer:", "subscription:", "created:", "status:"]) {
    assert.ok(!fallbackPath.includes(forbidden), `the request filters by ${forbidden}`);
  }
});

test("5: the fallback asks for limit 100", () => {
  const call = fallbackPath.slice(
    fallbackPath.indexOf("stripe.invoicePayments.list({"),
    fallbackPath.indexOf("const correlation =")
  );
  assert.ok(call.includes("limit: 100,"));
});

test("6-7: autoPagingToArray and autoPagingEach appear nowhere in the server code", () => {
  const banned = ["autoPaging" + "ToArray", "autoPaging" + "Each"];
  const offenders = [];
  const walk = dir => {
    for (const item of readdirSync(dir)) {
      const full = path.join(dir, item);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (!/\.(ts|tsx|mjs|js)$/.test(item)) continue;
      const source = readFileSync(full, "utf-8");
      for (const needle of banned) {
        if (source.includes(needle)) offenders.push(`${path.relative(ROOT, full)}: ${needle}`);
      }
    }
  };
  walk(path.join(ROOT, "lib"));
  walk(path.join(ROOT, "app"));
  assert.deepEqual(offenders, []);
});

test("8: page two is never fetched", () => {
  for (const forbidden of ["starting_after", "ending_before", "for await", ".next("]) {
    assert.ok(!syncCode.includes(forbidden), `the correlation paginates: ${forbidden}`);
  }
  // has_more is read, and it is only ever read as evidence.
  assert.ok(fallbackPath.includes("invoicePayments.has_more"));
});

/* ══════════════════════════════════════════════════════════════
   9-14. HAS_MORE AND DISTINCT INVOICE IDS
   ══════════════════════════════════════════════════════════════ */

test("9: one invoice on a complete page resolves", () => {
  assert.deepEqual(correlate([entry()], false), { ok: true, invoiceId: INVOICE_A });
});

test("10: several rows naming the SAME invoice are one invoice", () => {
  const page = [entry(), entry(), entry()];
  assert.deepEqual(correlate(page, false), { ok: true, invoiceId: INVOICE_A });
  // And the expanded form of the same invoice is still the same invoice.
  const mixed = [entry(), entry({ invoice: { id: INVOICE_A, object: "invoice" } })];
  assert.deepEqual(correlate(mixed, false), { ok: true, invoiceId: INVOICE_A });
});

test("11: two distinct invoices fail closed", () => {
  const page = [entry(), entry({ invoice: INVOICE_B })];
  assert.deepEqual(correlate(page, false), { ok: false, reason: "ambiguous_invoice_payment" });
  // Order of the rows cannot change the answer.
  assert.deepEqual(correlate([...page].reverse(), false),
    { ok: false, reason: "ambiguous_invoice_payment" });
});

test("12: one invoice plus has_more true is unproven, not resolved", () => {
  assert.deepEqual(correlate([entry()], true),
    { ok: false, reason: "unproven_invoice_uniqueness" });
  // Anything that is not an explicit false is unproven. Called through
  // the real function rather than the correlate() helper on purpose: the
  // helper defaults has_more to false, so passing undefined through it
  // would quietly test the proven case and assert nothing.
  for (const value of [true, undefined, null, 1, "false"]) {
    assert.equal(
      correlateInvoiceFromInvoicePayments([entry()], value, PI).ok,
      false,
      `has_more ${String(value)} resolved`
    );
  }
});

test("13: zero invoices plus has_more true is unproven, not order_not_found", () => {
  assert.deepEqual(correlate([], true), { ok: false, reason: "unproven_invoice_uniqueness" });
});

test("14: zero invoices on a complete page is order_not_found", () => {
  assert.deepEqual(correlate([], false), { ok: false, reason: "order_not_found" });
});

test("14b: ambiguity outranks has_more - two invoices are never 'merely unproven'", () => {
  assert.deepEqual(correlate([entry(), entry({ invoice: INVOICE_B })], true),
    { ok: false, reason: "ambiguous_invoice_payment" });
});

/* ══════════════════════════════════════════════════════════════
   15-18. EVERY ENTRY IS RE-VALIDATED
   ══════════════════════════════════════════════════════════════ */

test("15: an inconsistent payment.type fails closed", () => {
  for (const type of ["charge", "payment_record", "", null, undefined, 7, "PAYMENT_INTENT"]) {
    assert.deepEqual(
      correlate([entry({ payment: { type, payment_intent: PI } })], false),
      { ok: false, reason: "inconsistent_invoice_payment" },
      `type ${String(type)} was accepted`
    );
  }
  // A missing payment object at all.
  assert.deepEqual(correlate([{ invoice: INVOICE_A }], false),
    { ok: false, reason: "inconsistent_invoice_payment" });
});

test("16: a payment_record relationship fails closed", () => {
  assert.deepEqual(
    correlate([entry({ payment: { type: "payment_record", payment_record: "py_rec_1" } })], false),
    { ok: false, reason: "inconsistent_invoice_payment" }
  );
  // Even when it also claims the expected payment intent.
  assert.deepEqual(
    correlate([entry({
      payment: { type: "payment_intent", payment_intent: PI, payment_record: "py_rec_1" },
    })], false),
    { ok: false, reason: "inconsistent_invoice_payment" }
  );
});

test("17: a charge-typed InvoicePayment fails closed", () => {
  assert.deepEqual(
    correlate([entry({ payment: { type: "charge", charge: "ch_1" } })], false),
    { ok: false, reason: "inconsistent_invoice_payment" }
  );
  assert.deepEqual(
    correlate([entry({ payment: { type: "payment_intent", payment_intent: PI, charge: "ch_1" } })], false),
    { ok: false, reason: "inconsistent_invoice_payment" }
  );
});

test("18: an entry naming a DIFFERENT payment intent fails closed", () => {
  assert.deepEqual(
    correlate([entry({ payment: { type: "payment_intent", payment_intent: "pi_other" } })], false),
    { ok: false, reason: "inconsistent_invoice_payment" }
  );
  // And it is refused rather than DISCARDED. Filtering the stranger out
  // would leave one invoice behind and manufacture false uniqueness.
  assert.deepEqual(
    correlate([
      entry(),
      entry({ invoice: INVOICE_B, payment: { type: "payment_intent", payment_intent: "pi_other" } }),
    ], false),
    { ok: false, reason: "inconsistent_invoice_payment" },
    "an inconsistent row was silently dropped"
  );
  // A blank or missing payment intent is not a match either.
  for (const value of [null, undefined, "", "   ", { id: "" }]) {
    assert.deepEqual(
      correlate([entry({ payment: { type: "payment_intent", payment_intent: value } })], false),
      { ok: false, reason: "inconsistent_invoice_payment" }
    );
  }
  // The expanded form of the RIGHT payment intent is accepted.
  assert.deepEqual(
    correlate([entry({ payment: { type: "payment_intent", payment_intent: { id: PI } } })], false),
    { ok: true, invoiceId: INVOICE_A }
  );
});

test("18b: an entry with no usable invoice id fails closed", () => {
  for (const invoice of [null, undefined, "", "  ", {}, { id: null }, 42]) {
    assert.deepEqual(correlate([entry({ invoice })], false),
      { ok: false, reason: "inconsistent_invoice_payment" }, `invoice ${String(invoice)} was accepted`);
  }
  assert.equal(invoiceIdFromInvoicePayment(INVOICE_A), INVOICE_A);
  assert.equal(invoiceIdFromInvoicePayment({ id: INVOICE_A, deleted: true }), INVOICE_A);
  assert.equal(invoiceIdFromInvoicePayment(""), null);
});

test("18c: a caller with no payment intent, or a non-list answer, fails closed", () => {
  assert.deepEqual(correlate([entry()], false, ""),
    { ok: false, reason: "inconsistent_invoice_payment" });
  assert.deepEqual(correlate([entry()], false, "   "),
    { ok: false, reason: "inconsistent_invoice_payment" });
  assert.deepEqual(correlate(null, false),
    { ok: false, reason: "inconsistent_invoice_payment" });
});

/* ══════════════════════════════════════════════════════════════
   19-20. A REFUND WITH NO PAYMENT INTENT
   ══════════════════════════════════════════════════════════════ */

test("19: a refund event with no payment intent yields no id to correlate on", () => {
  for (const object of [
    {},
    { payment_intent: null },
    { payment_intent: "" },
    { payment_intent: "   " },
    { payment_intent: {} },
    { charge: "ch_1" },
  ]) {
    assert.equal(paymentIntentIdFromRefundEvent(object), null);
  }
});

test("20: the webhook stops before the sync when there is no payment intent", () => {
  const handler = webhookCode.slice(
    webhookCode.indexOf("async function handleRefundEvent"),
    webhookCode.indexOf("async function handleCheckoutSessionCompleted")
  );
  const guard = handler.indexOf("if (!paymentIntentId) {");
  const sync = handler.indexOf("syncOrderRefundStateFromStripe(");
  assert.ok(guard > -1 && sync > guard, "the guard no longer precedes the sync");
  const guarded = handler.slice(guard, sync);
  assert.ok(guarded.includes("return;"), "the no-payment-intent branch does not return");
  assert.ok(!guarded.includes("sendRefundConfirmationIfNeeded"));
  // It acknowledges rather than throwing, so Stripe does not redeliver a
  // permanently unsupported relationship forever.
  assert.ok(!guarded.includes("throw"));
});

/* ══════════════════════════════════════════════════════════════
   21-25. NOTHING ELSE MAY SELECT THE ORDER
   ══════════════════════════════════════════════════════════════ */

test("21-25: no customer, email, amount, subscription-id or metadata correlation", () => {
  for (const forbidden of [
    "customer", "email", "amount", "subscription", "metadata", "receipt", "name", "created",
  ]) {
    assert.ok(!fallbackPath.includes(forbidden),
      `the subscription correlation reads ${forbidden}`);
  }
  // The pure interpreter cannot see them either: they are not read even
  // when the entry carries them.
  const noisy = entry({
    amount_paid: 2589,
    currency: "eur",
    customer: "cus_1",
    customer_email: "someone@example.com",
    subscription: "sub_1",
    metadata: { gloa_order_id: "not-this-one" },
    created: 1,
  });
  assert.deepEqual(correlate([noisy], false), { ok: true, invoiceId: INVOICE_A });
  // Two invoices stay ambiguous no matter how tempting a tie-break looks.
  const bigger = entry({ invoice: INVOICE_B, amount_paid: 99999, created: 2 });
  assert.deepEqual(correlate([noisy, bigger], false),
    { ok: false, reason: "ambiguous_invoice_payment" });
});

/* ══════════════════════════════════════════════════════════════
   26-29. THE DATABASE HOPS
   ══════════════════════════════════════════════════════════════ */

test("26: the checkout attempt is resolved by exact stripe_invoice_id", () => {
  assert.ok(fallbackPath.includes('.from("checkout_attempts")'));
  assert.ok(fallbackPath.includes('.select("id")'));
  assert.ok(fallbackPath.includes('.eq("stripe_invoice_id", correlation.invoiceId)'));
  // Zero and more-than-one both refuse.
  assert.ok(fallbackPath.includes("if (!attempts || attempts.length === 0) {"));
  assert.ok(fallbackPath.includes("if (attempts.length > 1) {"));
  // A Supabase failure is never flattened into "no such attempt".
  assert.ok(fallbackPath.includes("if (attemptError) {"));
  assert.ok(fallbackPath.includes("throw new Error(`refund sync: checkout attempt lookup failed:"));
  // And the attempt is only ever read.
  for (const forbidden of [".update(", ".insert(", ".upsert(", ".delete("]) {
    assert.ok(!syncCode.includes(forbidden), `the correlation writes: ${forbidden}`);
  }
});

test("27: the order is resolved by exact checkout_attempt_id", () => {
  assert.ok(fallbackPath.includes('.eq("checkout_attempt_id", attempts[0].id)'));
  assert.ok(fallbackPath.includes('.select("id, currency")'));
  assert.ok(fallbackPath.includes("if (!order || order.length === 0) {"));
  assert.ok(fallbackPath.includes("if (order.length > 1) {"));
  assert.ok(fallbackPath.includes("if (orderError) {"));
});

test("28: the database writer receives the INVOICE id, never an order id", () => {
  const rpc = fallbackPath.slice(
    fallbackPath.indexOf('admin.rpc("apply_order_refund_state_by_invoice"'),
    fallbackPath.indexOf("if (error) {")
  );
  assert.ok(rpc.includes("p_stripe_invoice_id: correlation.invoiceId,"));
  assert.ok(rpc.includes("p_refunded_total_cents: summary.refundedTotalCents,"));
  assert.ok(rpc.includes("p_has_pending_refund: summary.hasPendingRefund,"));
  // Three arguments and no fourth.
  assert.equal([...rpc.matchAll(/p_\w+:/g)].length, 3);
  for (const forbidden of ["order[0].id", "p_order_id", "orderId", "attempts[0].id", "trimmedId"]) {
    assert.ok(!rpc.includes(forbidden), `the writer was handed ${forbidden}`);
  }
});

test("29: the new RPC is named exactly, and it is the only new one", () => {
  assert.deepEqual(
    [...syncCode.matchAll(/admin\.rpc\("(\w+)"/g)].map(m => m[1]),
    ["apply_order_refund_state", "apply_order_refund_state_by_invoice"]
  );
  const sql = read("supabase/migrations/037_subscription_refund_correlation.sql");
  assert.ok(sql.includes("create or replace function public.apply_order_refund_state_by_invoice("),
    "the runtime calls a function migration 037 does not define");
  for (const argument of ["p_stripe_invoice_id", "p_refunded_total_cents", "p_has_pending_refund"]) {
    assert.ok(sql.includes(argument), `037 has no ${argument}`);
  }
});

/* ══════════════════════════════════════════════════════════════
   30-37. EVERY RPC RESULT IS HANDLED DELIBERATELY
   ══════════════════════════════════════════════════════════════ */

test("30-31: applied and unchanged carry the order id forward, with 019's meaning", () => {
  assert.equal(invoiceRefundWriterResolvedAnOrder("applied"), true);
  assert.equal(invoiceRefundWriterResolvedAnOrder("unchanged"), true);
  // Only 'applied' is a new durable fact, exactly as on the one-time path.
  assert.equal(isNewSettledRefundFact("applied"), true);
  assert.equal(isNewSettledRefundFact("unchanged"), false);
});

test("32-33: invalid_amount and not_applicable are refusals, and send nothing", () => {
  for (const result of ["invalid_amount", "not_applicable"]) {
    // The database DID find the order, so the ids agree...
    assert.equal(invoiceRefundWriterResolvedAnOrder(result), true);
    // ...but it wrote nothing, so no customer hears about it.
    assert.equal(isNewSettledRefundFact(result), false);
  }
});

test("34-36: every correlation failure withholds the order id and sends nothing", () => {
  for (const result of [
    "order_not_found", "order_missing_for_attempt", "ambiguous_invoice_correlation", "invalid_input",
  ]) {
    assert.equal(invoiceRefundWriterResolvedAnOrder(result), false, `${result} was trusted`);
    assert.equal(isNewSettledRefundFact(result), false);
  }
  // The vocabulary is written down in full, so nothing is handled by
  // accident.
  assert.deepEqual([...INVOICE_REFUND_WRITER_RESULTS].sort(), [
    "ambiguous_invoice_correlation", "applied", "invalid_amount", "invalid_input",
    "not_applicable", "order_missing_for_attempt", "order_not_found", "unchanged",
  ]);
});

test("37: an unrecognised word is a disagreement, never an invented success", () => {
  for (const result of ["unknown", "", "ok", "APPLIED", "applied ", "success"]) {
    assert.equal(invoiceRefundWriterResolvedAnOrder(result), false, `${result} was trusted`);
  }
  // And the code withholds the id on exactly that predicate.
  assert.ok(fallbackPath.includes("orderId: invoiceRefundWriterResolvedAnOrder(result) && typeof order[0].id === \"string\""));
  assert.ok(fallbackPath.includes('const result = typeof data === "string" ? data : "unknown";'));
  // The webhook's send is gated on BOTH the result word and the id.
  assert.ok(webhookCode.includes("!isNewSettledRefundFact(outcome.result) || !outcome.orderId) return"));
});

/* ══════════════════════════════════════════════════════════════
   38-40. TRANSIENT FAILURE
   ══════════════════════════════════════════════════════════════ */

test("38: a failing InvoicePayment read propagates rather than being swallowed", () => {
  const call = fallbackPath.slice(0, fallbackPath.indexOf("const correlation ="));
  assert.ok(!call.includes("try"), "the Stripe read is wrapped in a try");
  assert.ok(!call.includes("catch"));
  assert.ok(!fallbackPath.includes("catch"), "a correlation failure is caught and flattened");
  assert.ok(!syncCode.includes("catch"));
});

test("39: a thrown correlation failure leaves the webhook event unrecorded", () => {
  // The record happens after the try/catch, and the catch returns 500
  // instead of falling through to it.
  const catchAt = webhookCode.indexOf("} catch (err) {");
  const recordAt = webhookCode.indexOf("const recorded = await recordStripeWebhookEvent(");
  assert.ok(catchAt > -1 && recordAt > catchAt);
  const handler = webhookCode.slice(catchAt, recordAt);
  assert.ok(handler.includes("{ status: 500 }"));
  assert.ok(handler.includes("return Response.json("),
    "the 500 branch falls through to recordStripeWebhookEvent");
});

test("40: the refunds.list read and its arithmetic are unchanged on both paths", () => {
  assert.equal(
    [...syncCode.matchAll(/stripe\.refunds\.list\(\{ payment_intent: trimmedId, limit: 100 \}\)/g)].length,
    2,
    "the refund re-read changed shape"
  );
  assert.equal([...syncCode.matchAll(/summarizeStripeRefunds\(refunds\.data, order\[0\]\.currency\)/g)].length, 2);
  // A summary refusal still throws on both paths rather than writing a
  // half-understood state.
  assert.equal([...syncCode.matchAll(/throw new Error\(`refund sync: \$\{summary\.reason\}`\)/g)].length, 2);
  // And the pre-existing has_more TODO on refunds.list is NOT solved
  // here: this phase is correlation only.
  assert.ok(!syncCode.includes("refunds.has_more"));
});

/* ══════════════════════════════════════════════════════════════
   41-46. REFUND SEMANTICS ARE UNCHANGED
   ══════════════════════════════════════════════════════════════ */

const settled = (...amounts) =>
  summarizeStripeRefunds(amounts.map(amount => ({ amount, currency: "eur", status: "succeeded" })), "EUR");

test("41: the first partial refund is an absolute total, not an increment", () => {
  assert.deepEqual(settled(1000), { ok: true, refundedTotalCents: 1000, hasPendingRefund: false });
});

test("42: the second partial refund is the cumulative absolute total", () => {
  assert.deepEqual(settled(1000, 1500), { ok: true, refundedTotalCents: 2500, hasPendingRefund: false });
  // Re-reading the same list is stable, which is what makes a redelivery
  // converge instead of double counting.
  assert.equal(settled(1000, 1500).refundedTotalCents, settled(1000, 1500).refundedTotalCents);
});

test("43: a full refund after a partial one reaches the charged total once", () => {
  assert.equal(settled(1000, 1500, 2490).refundedTotalCents, 4990);
  assert.equal(hasSettledRefund({
    payment_status: "refunded",
    refunded_total_cents: 4990,
    refund_email_notified_total_cents: 2500,
    refund_email_status: "sent",
  }), true);
  assert.equal(isNewerThanNotified(4990, 2500), true);
});

test("44: a duplicate delivery of the same event tells nobody twice", () => {
  // The database answers 'unchanged' for an identical absolute total...
  assert.equal(isNewSettledRefundFact("unchanged"), false);
  // ...and the watermark refuses the same total a second time anyway.
  assert.equal(isNewerThanNotified(2500, 2500), false);
});

test("45: different event types reporting the same settled total send one email", () => {
  assert.deepEqual([...REFUND_EVENT_TYPES], [
    "charge.refunded", "charge.refund.updated", "refund.created", "refund.updated", "refund.failed",
  ]);
  for (const type of REFUND_EVENT_TYPES) assert.equal(isRefundEventType(type), true);
  // Whichever arrives second re-reads the same absolute list, so the
  // writer answers 'unchanged' and the watermark blocks the repeat.
  assert.equal(settled(2500).refundedTotalCents, settled(2500).refundedTotalCents);
  assert.equal(isNewerThanNotified(2500, 2500), false);
});

test("46: a failed refund produces no confirmation", () => {
  const failed = summarizeStripeRefunds(
    [{ amount: 2500, currency: "eur", status: "failed" }], "EUR");
  assert.deepEqual(failed, { ok: true, refundedTotalCents: 0, hasPendingRefund: false });
  // Which self-heals the order to 'paid', a state that is never settled.
  assert.equal(hasSettledRefund({
    payment_status: "paid",
    refunded_total_cents: 0,
    refund_email_notified_total_cents: null,
    refund_email_status: null,
  }), false);
});

/* ══════════════════════════════════════════════════════════════
   47-48. THE EMAIL CONTRACT IS UNTOUCHED
   ══════════════════════════════════════════════════════════════ */

test("47: the provider idempotency key is unchanged", () => {
  assert.equal(refundConfirmationIdempotencyKey("order-1", 2500), "gloa/refund/order-1/2500");
  const template = read("lib/email/refundConfirmation.ts");
  assert.ok(template.includes("`gloa/refund/${orderId}/${refundedTotalCents}`"));
  // No invoice id and no Stripe event id crept into it.
  for (const forbidden of ["invoice", "event.id", "stripe_invoice"]) {
    assert.ok(!template.includes(`gloa/refund/\${${forbidden}`), `the key now includes ${forbidden}`);
  }
});

test("48: the recipient still comes from the durable order snapshot", () => {
  const sender = withoutComments(read("lib/refundConfirmationEmail.ts"));
  assert.ok(sender.includes("recipientFromSnapshot(order.customer_snapshot)"));
  for (const forbidden of [
    "customer_details", "receipt_email", "billing_details", "invoice", "stripe.",
  ]) {
    assert.ok(!sender.includes(forbidden), `the sender reads ${forbidden}`);
  }
  // The webhook still hands over an order id and nothing else.
  const call = webhookCode.slice(webhookCode.indexOf("sendRefundConfirmationIfNeeded("));
  assert.equal(call.slice(call.indexOf("(") + 1, call.indexOf(")")).trim(), "outcome.orderId");
});

/* ══════════════════════════════════════════════════════════════
   49-53. NOTHING ELSE IN THE LIFECYCLE IS TOUCHED
   ══════════════════════════════════════════════════════════════ */

test("49-51: subscription state, the payment problem email and shipping are untouched", () => {
  for (const forbidden of [
    "sync_subscription_payment_status", "subscription_email_deliveries", "payment_problem",
    "past_due", "unpaid", "cancel_at", "cancelled_at", "public.subscriptions",
    "fulfillment_status", "shipped_at", "tracking", "carrier", "shipment",
    "activate_subscription", "subscription_status",
  ]) {
    assert.ok(!syncCode.includes(forbidden), `lib/orderRefunds.ts reaches into ${forbidden}`);
    assert.ok(!pureCode.includes(forbidden), `lib/stripeRefunds.ts reaches into ${forbidden}`);
  }
  // The only columns anything here can move are migration 019's three,
  // and they move in SQL, not in TypeScript.
  const sql = read("supabase/migrations/037_subscription_refund_correlation.sql");
  const update = sql.slice(sql.indexOf("update public.orders"), sql.indexOf("return 'applied';"));
  assert.deepEqual([...update.matchAll(/^\s+(?:set )?(\w+)\s+=/gm)].map(m => m[1]),
    ["payment_status", "refunded_total_cents", "refund_updated_at"]);
});

test("52-53: a historical order is refundable after its subscription ended", () => {
  // Nothing in the correlation reads a subscription status, an end date
  // or a Stripe subscription object, so an ended - or deleted -
  // subscription cannot block a refund for a cycle that was paid.
  assert.ok(!fallbackPath.includes("subscriptions"));
  assert.ok(!fallbackPath.includes("status"));
  assert.ok(!fallbackPath.includes("stripe.subscriptions"));
  // The whole chain is invoice -> attempt -> order, and it holds for two
  // cycles of ONE subscription: the invoice picks the cycle, not the
  // subscription id.
  const cycleA = correlate([entry({ invoice: INVOICE_A })], false);
  const cycleB = correlate([entry({ invoice: INVOICE_B })], false);
  assert.deepEqual(cycleA, { ok: true, invoiceId: INVOICE_A });
  assert.deepEqual(cycleB, { ok: true, invoiceId: INVOICE_B });
  assert.notEqual(cycleA.invoiceId, cycleB.invoiceId);
});

/* ══════════════════════════════════════════════════════════════
   54-59. THE PHASE BOUNDARY
   ══════════════════════════════════════════════════════════════ */

test("54: migrations 019 and 022-037 are unmodified", () => {
  const changed = execFileSync("git", ["diff", "--name-only", "HEAD"], { cwd: ROOT, encoding: "utf-8" })
    .trim();
  const touched = changed ? changed.split(NEWLINE) : [];
  // 038 is still UNAPPLIED, so it may be edited in place until the owner
  // applies it. Every migration below it is live and may not.
  // 039, the annual plan foundation, is UNAPPLIED and may likewise be
  // edited in place until the owner applies it.
  const migrations = touched
    .filter(rel => rel.startsWith("supabase/migrations/"))
    .filter(rel => !rel.endsWith("038_one_time_refund_writer_concurrency.sql"))
    .filter(rel => !rel.endsWith("039_b2c_annual_plan_foundation.sql"));
  assert.deepEqual(migrations, [], "a live, immutable migration was edited");
  // And the two functions this phase depends on still read the way they
  // were applied to production.
  assert.ok(read("supabase/migrations/019_order_lifecycle_tracking.sql")
    .includes("create or replace function public.apply_order_refund_state("));
  assert.ok(read("supabase/migrations/037_subscription_refund_correlation.sql")
    .includes("security definer set search_path = ''"));
});

test("55: this phase added no migration, and the only ones after it are 038 and 039", () => {
  // Written when 037 was the highest, as "no 038 was created": THIS phase
  // is runtime only and still adds nothing. Phase 3K.B then added 038 on
  // purpose, for the ONE-TIME writer's concurrency. So the guard is kept
  // and re-pinned rather than deleted, and it now also proves 038 stayed
  // out of the subscription writer this phase depends on.
  // Phase 4B1 then added 039, the B2C prepaid annual plan foundation,
  // reviewed in tests/annual-plan-foundation-migration.test.mjs.
  const beyond = readdirSync(MIGRATIONS).filter(name => Number(name.slice(0, 3)) > 37).sort();
  assert.deepEqual(beyond, ["038_one_time_refund_writer_concurrency.sql",
                            "039_b2c_annual_plan_foundation.sql"],
    "an unreviewed migration appeared after 037");
  const sql039 = withoutComments(read("supabase/migrations/039_b2c_annual_plan_foundation.sql"));
  assert.ok(!sql039.includes("apply_order_refund_state_by_invoice"),
    "039 reached into the subscription refund writer");
  assert.ok(existsSync(path.join(MIGRATIONS, "037_subscription_refund_correlation.sql")));
  const sql038 = withoutComments(read("supabase/migrations/038_one_time_refund_writer_concurrency.sql"));
  assert.ok(!sql038.includes("apply_order_refund_state_by_invoice"),
    "038 reached into the subscription refund writer");
});

test("56: the webhook route was not modified", () => {
  const changed = execFileSync("git", ["diff", "--name-only", "HEAD"], { cwd: ROOT, encoding: "utf-8" })
    .trim();
  const touched = changed ? changed.split(NEWLINE) : [];
  assert.ok(!touched.includes("app/api/stripe/webhook/route.ts"),
    "the route changed without a stated reason");
  // Because the extended outcome fits the contract it already consumed.
  assert.ok(webhookCode.includes("syncOrderRefundStateFromStripe(stripe, paymentIntentId)"));
  assert.ok(!webhookCode.includes("invoicePayments"));
  assert.ok(!webhookCode.includes("apply_order_refund_state_by_invoice"));
});

test("57: the pre-existing refunds.list pagination TODO is recorded, not solved", () => {
  // Scope discipline: 3J.B2 is correlation only. The 100-refund page on
  // stripe.refunds.list predates this phase and is deliberately left
  // exactly as it was.
  assert.ok(syncCode.includes("stripe.refunds.list({ payment_intent: trimmedId, limit: 100 })"));
  assert.ok(!syncCode.includes("refunds.has_more"));
  // Left open, but not left silent. Asserted against the raw source
  // because syncCode has the comments stripped out of it.
  assert.ok(syncSource.includes("KNOWN GAP, PRE-DATING THIS PHASE AND DELIBERATELY LEFT OPEN"),
    "the pre-existing pagination gap is not written down anywhere");
  assert.ok(syncSource.includes("stripe.refunds.list is read with limit 100 and its has_more is not"));
});

test("58: B2C_SUBSCRIPTIONS_ENABLED is unchanged and still closed by default", () => {
  const rules = read("lib/subscriptionCheckoutRules.ts");
  assert.ok(rules.includes('export const SUBSCRIPTION_FEATURE_FLAG = "B2C_SUBSCRIPTIONS_ENABLED";'));
  assert.ok(rules.includes('return env[SUBSCRIPTION_FEATURE_FLAG] === "true";'));
  assert.ok(!syncCode.includes("B2C_SUBSCRIPTIONS_ENABLED"),
    "a refund now depends on a feature flag");
  // A refund on a historical subscription order must work even with the
  // flag closed, so nothing here may read it.
  assert.ok(!syncCode.includes("process" + ".env"));
});

test("59: SHOP_STATUS is unchanged", () => {
  assert.ok(read("app/content.ts").includes('export const SHOP_STATUS = "prelaunch" as const;'));
});

test("this suite opens no database, calls nothing, and stages no secret", () => {
  const self = read("tests/subscription-refund-correlation-runtime.test.mjs");
  const imports = [...self.matchAll(/^\s*\} from "([^"]+)";$/gm), ...self.matchAll(/^import \w.*? from "([^"]+)";$/gm)]
    .map(m => m[1]);
  assert.ok(imports.length > 0, "the import scan found nothing");
  for (const specifier of imports) {
    assert.ok(specifier.startsWith("node:") || specifier.startsWith("../lib/"),
      `this suite imports something unexpected: ${specifier}`);
  }
  const spawned = [...self.matchAll(/execFileSync\("([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual([...new Set(spawned)], ["git"], "this suite spawns something other than git");
  assert.ok(!self.includes("process" + ".env"), "this suite reads the environment");
  const tracked = execFileSync("git", ["ls-files", "stripe_backup_code.txt"], {
    cwd: ROOT,
    encoding: "utf-8",
  }).trim();
  assert.equal(tracked, "", "stripe_backup_code.txt is tracked");
});
