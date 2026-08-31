import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ANNUAL_DELIVERY_BATCH_LIMIT,
  ANNUAL_FULFILL_GUARDED_RESULTS,
  ANNUAL_FULFILL_SUCCESS_RESULTS,
  runAnnualDeliveryWorker,
} from "../lib/annualDeliveryWorker.ts";
import {
  emptyAnnualMaintenanceSummary,
  runAnnualPlanMaintenance,
} from "../lib/annualPlanMaintenance.ts";
import {
  ANNUAL_ORDER_NOTIFICATION_RECOVERY_LIMIT,
  isAnnualOrderNotificationRecoveryCandidate,
  runAnnualOrderNotificationRecovery,
} from "../lib/annualOrderNotificationRules.ts";
import {
  ANNUAL_PURCHASE_EMAIL_RETRY_LIMIT,
  ANNUAL_PURCHASE_EMAIL_STALE_AFTER_MS,
  isAnnualPurchaseEmailRetryCandidate,
  runAnnualPurchaseEmailRetrySweep,
} from "../lib/annualPurchaseConfirmationEmail.ts";
import { buildRetryNotificationParams } from "../lib/internalOrderNotificationRetryRules.ts";
import {
  buildInternalOrderNotificationEmail,
  internalOrderNotificationIdempotencyKey,
} from "../lib/email/internalOrderNotification.ts";
import { ANNUAL_DELIVERY_COUNT, ANNUAL_DELIVERY_INTERVAL_DAYS } from "../lib/annualPlanRules.ts";

/* ══════════════════════════════════════════════════════════════
   PHASE 4B6 - THE ANNUAL PLAN'S DAILY MAINTENANCE

   SAFE DEFAULT SUITE: pure decisions, the shared delivery worker and
   the three sweeps driven against an in-memory emulation of migration
   039's installed functions, and source-level checks on the wiring.

   NO Supabase client is constructed, no SQL runs, no RPC is invoked, no
   Stripe object exists, no Checkout Session is created, no webhook is
   delivered, no cron is called over HTTP and NO EMAIL IS SENT - the
   provider is an array. Nothing here reads a wall clock: every
   time-dependent assertion passes its own instant in.

   What it protects: a customer who prepaid a full year receives all
   THIRTEEN boxes, exactly once each, even when a cron run is missed, a
   worker dies mid-claim or a process crashes between the order and the
   message about it - and a plan that was fully refunded receives none.
   ══════════════════════════════════════════════════════════════ */

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf-8");
const NEWLINE = String.fromCharCode(10);

const withoutComments = source => source
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split(NEWLINE)
  .filter(line => {
    const t = line.trim();
    return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
  })
  .join(NEWLINE);

const MIGRATION_039 = "supabase/migrations/039_b2c_annual_plan_foundation.sql";
const m039 = read(MIGRATION_039);

const workerCode = withoutComments(read("lib/annualDeliveryWorker.ts"));
const maintenanceCode = withoutComments(read("lib/annualPlanMaintenance.ts"));
const maintenanceDeps = withoutComments(read("lib/annualPlanMaintenanceDeps.ts"));
const orderNotificationRules = withoutComments(read("lib/annualOrderNotificationRules.ts"));
const orderNotificationCode = withoutComments(read("lib/annualOrderNotification.ts"));
const webhookDeps = withoutComments(read("lib/annualPlanWebhookDeps.ts"));
const webhookFlow = withoutComments(read("lib/annualPlanWebhook.ts"));
const senderCode = withoutComments(read("lib/annualPurchaseConfirmationEmail.ts"));
const cronRoute = withoutComments(read("app/api/cron/retry-order-notifications/route.ts"));

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const NOW = Date.parse("2026-08-31T05:20:00.000Z");
const PURCHASED_AT = Date.parse("2025-09-01T09:30:00.000Z");
const PLAN_ID = "11111111-1111-1111-1111-111111111111";

/** console.error is noise here; every assertion is about state, not logs. */
const quiet = async fn => {
  const original = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = original;
  }
};

/* ══════════════════════════════════════════════════════════════
   AN IN-MEMORY EMULATION OF WHAT MIGRATION 039 INSTALLED

   Faithful to the SQL rather than to what is convenient: the same
   predicates in the claim, the same guard order in the fulfillment, the
   same six-hour lease, one synthetic attempt per delivery, an
   idempotent order creator and the delivery's own fulfilled state. The
   predicates are cross-checked against the migration source further
   down, so this emulation cannot quietly drift from the installed one.
   ══════════════════════════════════════════════════════════════ */

const scheduleFor = (over = {}) =>
  Array.from({ length: ANNUAL_DELIVERY_COUNT }, (unused, i) => ({
    id: `d${i + 1}`,
    annual_plan_id: PLAN_ID,
    delivery_number: i + 1,
    scheduled_for: PURCHASED_AT + i * ANNUAL_DELIVERY_INTERVAL_DAYS * DAY_MS,
    state: "scheduled",
    checkout_attempt_id: null,
    order_id: null,
    claimed_at: null,
    fulfilled_at: null,
    ...(over[i + 1] ?? {}),
  }));

const ITEMS = [
  {
    sku: "GLOA-MATCHA-50G",
    productName: "GLOA Matcha Ceremonial",
    variantLabel: "50 g",
    quantity: 1,
    unitGrossCents: 2699,
    lineGrossCents: 2699,
  },
];

/**
 * The world one maintenance run acts on: an annual plan, its thirteen
 * delivery rows, the orders they mint and the fulfilment inbox.
 */
const world = ({
  plan = {},
  deliveries = scheduleFor(),
  now = NOW,
  providerFails = false,
} = {}) => {
  const planRow = {
    id: PLAN_ID,
    status: "active",
    payment_status: "paid",
    delivery_count: ANNUAL_DELIVERY_COUNT,
    plan_end_at: PURCHASED_AT + 364 * DAY_MS,
    completed_at: null,
    customer_snapshot: { email: "kundin@example.com", name: "Kundin Beispiel" },
    ...plan,
  };

  const attempts = new Map();
  const orders = new Map();
  const inbox = [];
  const calls = [];
  let clock = now;
  let minted = 0;
  let failProvider = providerFails;

  /** public.claim_due_annual_plan_deliveries(p_limit). */
  const claimDue = async limit => {
    calls.push(["claim", limit]);
    const bounded = Math.min(Math.max(limit ?? 25, 1), 100);
    const due = deliveries
      .filter(d =>
        planRow.status === "active"
        && planRow.payment_status !== "refunded"
        && d.order_id === null
        && d.fulfilled_at === null
        && (
          (d.state === "scheduled" && d.scheduled_for <= clock)
          || (d.state === "claimed" && d.claimed_at !== null && d.claimed_at < clock - 6 * HOUR_MS)
        ))
      .sort((a, b) => a.scheduled_for - b.scheduled_for || a.delivery_number - b.delivery_number)
      .slice(0, bounded);

    return due.map(d => {
      const reclaimed = d.state === "claimed";
      d.state = "claimed";
      d.claimed_at = clock;
      return {
        delivery_id: d.id,
        annual_plan_id: d.annual_plan_id,
        delivery_number: d.delivery_number,
        scheduled_for: new Date(d.scheduled_for).toISOString(),
        reclaimed,
      };
    });
  };

  /** public.fulfill_annual_plan_delivery(p_delivery_id). */
  const fulfillDelivery = async deliveryId => {
    calls.push(["fulfill", deliveryId]);
    const d = deliveries.find(row => row.id === deliveryId);
    if (!d) return { result: "not_found" };

    // Already fulfilled is answered BEFORE the parent guards, exactly as
    // the installed function does: a shipped box is a historical fact.
    if (d.state === "fulfilled") {
      return {
        result: "already_fulfilled",
        delivery_id: d.id,
        delivery_number: d.delivery_number,
        checkout_attempt_id: d.checkout_attempt_id,
        order_id: d.order_id,
      };
    }
    if (planRow.status !== "active") return { result: "plan_not_active", status: planRow.status };
    if (planRow.payment_status === "refunded") return { result: "plan_refunded" };
    if (d.state !== "claimed") return { result: "delivery_not_claimed", state: d.state };

    // ONE synthetic attempt per delivery, carrying NO Stripe identity.
    let attempt = d.checkout_attempt_id ? attempts.get(d.checkout_attempt_id) : null;
    if (!attempt) {
      attempt = {
        id: `a${d.delivery_number}`,
        annual_plan_id: planRow.id,
        annual_delivery_number: d.delivery_number,
        subscription_id: null,
        stripe_invoice_id: null,
        stripe_payment_intent_id: null,
        stripe_checkout_session_id: null,
        items_snapshot: ITEMS,
      };
      attempts.set(attempt.id, attempt);
    }

    // create_order_from_paid_checkout is idempotent per attempt.
    let order = [...orders.values()].find(o => o.checkout_attempt_id === attempt.id);
    if (!order) {
      minted += 1;
      order = {
        id: `o${d.delivery_number}`,
        order_number: `GLOA-2026-${String(1000 + minted)}`,
        checkout_attempt_id: attempt.id,
        currency: "EUR",
        subtotal_gross_cents: 2699,
        shipping_gross_cents: 399,
        total_gross_cents: 3098,
        shipping_address_snapshot: {
          name: "Kundin Beispiel", company: null, line1: "Teststrasse 1", line2: null,
          city: "Berlin", postalCode: "10115", state: null, country: "DE",
        },
        customer_snapshot: planRow.customer_snapshot,
        // Migration 017's NOT NULL DEFAULT, and migration 026's nullable
        // column with no default. Both exactly as a fresh order carries
        // them.
        confirmation_email_status: "pending",
        internal_notification_status: null,
      };
      orders.set(order.id, order);
    }

    d.state = "fulfilled";
    d.checkout_attempt_id = attempt.id;
    d.order_id = order.id;
    d.fulfilled_at = clock;

    return {
      result: "fulfilled",
      delivery_id: d.id,
      delivery_number: d.delivery_number,
      checkout_attempt_id: attempt.id,
      order_id: order.id,
      order_number: order.order_number,
    };
  };

  /**
   * The ordinary internal order notification, claim and all.
   *
   * The claim is the real one: NULL-or-failed -> 'sending', atomic, and
   * anything else means somebody already has it.
   */
  const notifyOrder = async orderId => {
    calls.push(["notify", orderId]);
    const order = orders.get(orderId);
    if (!order) throw new Error("order not found");

    const claimable = order.internal_notification_status === null
      || order.internal_notification_status === "failed";
    if (!claimable) return;
    order.internal_notification_status = "sending";

    const attempt = attempts.get(order.checkout_attempt_id) ?? null;
    const params = buildRetryNotificationParams(order, attempt);
    const built = buildInternalOrderNotificationEmail({
      order: {
        order_number: params.order.order_number,
        currency: params.order.currency,
        subtotal_gross_cents: params.order.subtotal_gross_cents,
        shipping_gross_cents: params.order.shipping_gross_cents,
        total_gross_cents: params.order.total_gross_cents,
        shippingAddress: null,
        customerEmail: params.customerEmail,
        customerName: params.customerName,
        source: params.source,
        stripeInvoiceId: params.stripeInvoiceId,
      },
      items: params.items,
    });

    if (failProvider) {
      order.internal_notification_status = "failed";
      throw new Error("provider refused");
    }

    inbox.push({
      orderId: order.id,
      source: params.source,
      subject: built.subject,
      idempotencyKey: internalOrderNotificationIdempotencyKey(order.id),
    });
    order.internal_notification_status = "sent";
  };

  /** public.complete_due_annual_plans(p_limit), the whole rule. */
  const completeDuePlans = async limit => {
    calls.push(["complete", limit]);
    const bounded = Math.min(Math.max(limit ?? 25, 1), 100);
    if (bounded < 1) return { completed: 0 };
    if (planRow.status !== "active") return { completed: 0 };
    if (planRow.plan_end_at === null || planRow.plan_end_at > clock) return { completed: 0 };

    const total = deliveries.length;
    const done = deliveries.filter(d => d.state === "fulfilled" && d.order_id !== null).length;
    if (total !== planRow.delivery_count || done !== planRow.delivery_count) return { completed: 0 };

    planRow.status = "completed";
    planRow.completed_at = clock;
    return { completed: 1 };
  };

  return {
    plan: planRow,
    deliveries,
    attempts,
    orders,
    inbox,
    calls,
    setNow: value => { clock = value; },
    setProviderFails: value => { failProvider = value; },
    workerDeps: { claimDue, fulfillDelivery, notifyOrder: o => notifyOrder(o.orderId) },
    completeDuePlans,
    /** The crash window: an order that exists whose notification is NULL. */
    ordersMissingNotification: () =>
      [...orders.values()]
        .filter(o => o.internal_notification_status === null)
        .map(o => ({ id: o.id, internal_notification_status: o.internal_notification_status })),
  };
};

/** One full maintenance invocation over a world, wired as production is. */
const runMaintenance = (w, { purchaseEmails, completionLimit = 25 } = {}) =>
  quiet(() => runAnnualPlanMaintenance({
    runDeliveryPass: async () => {
      const s = await runAnnualDeliveryWorker(w.workerDeps);
      return {
        claimed: s.claimed, fulfilled: s.fulfilled, guarded: s.guarded, failed: s.failed,
        notified: s.notified, notifyFailed: s.notifyFailed, errors: s.errors,
      };
    },
    recoverOrderNotifications: () => runAnnualOrderNotificationRecovery({
      loadCandidates: async () => w.ordersMissingNotification(),
      notify: orderId => w.workerDeps.notifyOrder({ orderId }),
      logFailure: () => {},
    }),
    retryPurchaseEmails: async () => purchaseEmails ?? {
      found: 0, attempted: 0, skipped: 0, sent: 0, alreadySent: 0,
      inFlight: 0, notEligible: 0, ambiguous: 0, failed: 0, errors: [],
    },
    completeDuePlans: () => w.completeDuePlans(completionLimit),
    logFailure: () => {},
  }));

/* ══════════════════════════════════════════════════════════════
   1-4. DELIVERY 2, THE ORDINARY CASE
   ══════════════════════════════════════════════════════════════ */

test("1: delivery 2 is claimed, fulfilled and notified when it comes due", async () => {
  const w = world({
    deliveries: scheduleFor({
      1: { state: "fulfilled", checkout_attempt_id: "a1", order_id: "o1", claimed_at: PURCHASED_AT, fulfilled_at: PURCHASED_AT },
    }),
    // Exactly one delivery is due: number 2, four weeks after purchase.
    now: PURCHASED_AT + (ANNUAL_DELIVERY_INTERVAL_DAYS + 1) * DAY_MS,
  });

  const summary = await runMaintenance(w);

  assert.equal(summary.deliveries.claimed, 1);
  assert.equal(summary.deliveries.fulfilled, 1);
  assert.equal(summary.deliveries.notified, 1);
  assert.equal(summary.deliveries.failed, 0);
  assert.equal(summary.deliveries.notifyFailed, 0);

  // ONE synthetic attempt, ONE order, ONE message.
  assert.equal(w.attempts.size, 1);
  assert.equal(w.orders.size, 1);
  assert.equal(w.inbox.length, 1);
  assert.equal(w.deliveries[1].state, "fulfilled");
  assert.equal(w.deliveries[1].order_id, "o2");
});

test("2: the schedule for deliveries 3 to 13 is not touched", async () => {
  const before = scheduleFor({
    1: { state: "fulfilled", checkout_attempt_id: "a1", order_id: "o1", claimed_at: PURCHASED_AT, fulfilled_at: PURCHASED_AT },
  });
  const frozen = before.map(d => d.scheduled_for);
  const w = world({ deliveries: before, now: PURCHASED_AT + (ANNUAL_DELIVERY_INTERVAL_DAYS + 1) * DAY_MS });

  await runMaintenance(w);

  assert.deepEqual(w.deliveries.map(d => d.scheduled_for), frozen,
    "a maintenance run moved a future delivery date");
  for (const d of w.deliveries.slice(2)) {
    assert.equal(d.state, "scheduled");
    assert.equal(d.order_id, null);
  }
});

test("3: the synthetic delivery attempt carries no Stripe identity", async () => {
  const w = world({ now: PURCHASED_AT + DAY_MS });
  await runMaintenance(w);

  for (const attempt of w.attempts.values()) {
    assert.equal(attempt.stripe_payment_intent_id, null);
    assert.equal(attempt.stripe_invoice_id, null);
    assert.equal(attempt.stripe_checkout_session_id, null);
    assert.equal(attempt.subscription_id, null);
    assert.equal(attempt.annual_plan_id, PLAN_ID);
  }
  // And the installed CHECK is what actually enforces it.
  assert.ok(m039.includes("checkout_attempts_annual_delivery_no_stripe_payment_check"));
});

test("4: nothing due means nothing happens", async () => {
  const w = world({ now: PURCHASED_AT - DAY_MS });
  const summary = await runMaintenance(w);

  assert.equal(summary.deliveries.claimed, 0);
  assert.equal(w.orders.size, 0);
  assert.equal(w.inbox.length, 0);
  assert.equal(summary.deliveries.errored, false);
});

/* ══════════════════════════════════════════════════════════════
   5-7. A MISSED CRON, AND DELIVERY 13
   ══════════════════════════════════════════════════════════════ */

test("5: an outage long enough to strand three deliveries fulfils all three", async () => {
  const fulfilled = n => ({
    state: "fulfilled",
    checkout_attempt_id: `a${n}`,
    order_id: `o${n}`,
    claimed_at: PURCHASED_AT,
    fulfilled_at: PURCHASED_AT,
  });
  const w = world({
    deliveries: scheduleFor({ 1: fulfilled(1), 2: fulfilled(2), 3: fulfilled(3) }),
    // Deliveries 4, 5 and 6 are all due; 7 is not.
    now: PURCHASED_AT + (5 * ANNUAL_DELIVERY_INTERVAL_DAYS + 1) * DAY_MS,
  });

  const summary = await runMaintenance(w);

  assert.equal(summary.deliveries.claimed, 3);
  assert.equal(summary.deliveries.fulfilled, 3);
  assert.equal(summary.deliveries.notified, 3);
  // Each produced exactly one attempt, one order and one message.
  assert.equal(w.attempts.size, 3);
  assert.equal(w.orders.size, 3);
  assert.equal(w.inbox.length, 3);
  assert.deepEqual([...new Set(w.inbox.map(m => m.orderId))].sort(), ["o4", "o5", "o6"]);
  // The schedule was NOT moved forward: 7 to 13 sit where activation put them.
  for (const d of w.deliveries.slice(6)) {
    assert.equal(d.state, "scheduled");
    assert.equal(d.scheduled_for, PURCHASED_AT + (d.delivery_number - 1) * ANNUAL_DELIVERY_INTERVAL_DAYS * DAY_MS);
  }
});

test("6: delivery 13 goes through the same worker, RPC and post-order path", async () => {
  const twelve = {};
  for (let n = 1; n <= 12; n++) {
    twelve[n] = {
      state: "fulfilled", checkout_attempt_id: `a${n}`, order_id: `o${n}`,
      claimed_at: PURCHASED_AT, fulfilled_at: PURCHASED_AT,
    };
  }
  const w = world({
    deliveries: scheduleFor(twelve),
    now: PURCHASED_AT + (12 * ANNUAL_DELIVERY_INTERVAL_DAYS + 1) * DAY_MS,
  });

  const summary = await runMaintenance(w);

  assert.equal(summary.deliveries.fulfilled, 1);
  assert.equal(summary.deliveries.notified, 1);
  assert.equal(w.deliveries[12].state, "fulfilled");
  assert.equal(w.inbox.length, 1);
  assert.equal(w.inbox[0].orderId, "o13");
});

test("7: there is no last-delivery branch, and no schedule arithmetic, in the runtime", () => {
  for (const [name, source] of [
    ["worker", workerCode],
    ["maintenance", maintenanceCode],
    ["maintenance deps", maintenanceDeps],
  ]) {
    for (const banned of [
      "delivery_number ===", "deliveryNumber ===", "=== 13", "13 -", "672", "364", "28 *",
      "getTime() +", "setDate(", "addDays",
    ]) {
      assert.ok(!source.includes(banned), `${name} branches on or computes a schedule: ${banned}`);
    }
  }
  // The dates are the database's, written once at activation.
  assert.ok(m039.includes("interval '672 hours'") || m039.includes("672 hours"),
    "039 no longer owns the delivery cadence");
});

/* ══════════════════════════════════════════════════════════════
   8-10. REPLAY, STALE CLAIMS AND THE REFUND GUARD
   ══════════════════════════════════════════════════════════════ */

test("8: running the whole maintenance job twice changes nothing the second time", async () => {
  const w = world({ now: PURCHASED_AT + DAY_MS });

  const first = await runMaintenance(w);
  const ordersAfterFirst = [...w.orders.keys()];
  const inboxAfterFirst = w.inbox.length;

  const second = await runMaintenance(w);

  assert.equal(first.deliveries.fulfilled, 1);
  // Nothing is claimable any more: the delivery is fulfilled, so the
  // queue does not return it and no second attempt is made.
  assert.equal(second.deliveries.claimed, 0);
  assert.equal(second.deliveries.fulfilled, 0);
  assert.deepEqual([...w.orders.keys()], ordersAfterFirst, "a replay minted a second order");
  assert.equal(w.attempts.size, 1, "a replay minted a second synthetic attempt");
  assert.equal(w.inbox.length, inboxAfterFirst, "a replay sent a second notification");
  // And the recovery found nothing to do, because nothing is owed.
  assert.equal(second.orderNotifications.found, 0);
});

test("9: a worker that dies holding a claim is recovered after the lease, with no duplicates", async () => {
  const claimTime = PURCHASED_AT;
  const w = world({
    // Worker A claimed delivery 1 and died before fulfilling it.
    deliveries: scheduleFor({ 1: { state: "claimed", claimed_at: claimTime } }),
    now: claimTime + HOUR_MS,
  });

  // Inside the six-hour lease the row belongs to worker A. Nobody else
  // may take it.
  const early = await runMaintenance(w);
  assert.equal(early.deliveries.claimed, 0);
  assert.equal(w.orders.size, 0);

  // After the lease, worker B may reclaim it.
  w.setNow(claimTime + 7 * HOUR_MS);
  const late = await runMaintenance(w);

  assert.equal(late.deliveries.claimed, 1);
  assert.equal(late.deliveries.fulfilled, 1);
  assert.equal(w.attempts.size, 1, "the reclaim minted a second attempt");
  assert.equal(w.orders.size, 1, "the reclaim minted a second order");
  assert.equal(w.inbox.length, 1, "the reclaim sent a second notification");

  // No application-side lease exists: the six hours are the database's,
  // and no runtime module writes a delivery's claim state.
  assert.ok(m039.includes("interval '6 hours'"));
  for (const source of [workerCode, maintenanceCode, maintenanceDeps, orderNotificationCode]) {
    assert.ok(!/6 \* 60 \* 60 \* 1000|SIX_HOUR/.test(source),
      "the runtime implements a delivery claim lease of its own");
    for (const banned of ['state: "claimed"', "claimed_at:", 'from("annual_plan_deliveries")']) {
      assert.ok(!source.includes(banned), `the runtime manages the queue itself: ${banned}`);
    }
  }
});

test("10: a full refund stops future deliveries, and that is not an error", async () => {
  // Refunded BEFORE the claim: the queue does not return the row at all.
  const before = world({ plan: { payment_status: "refunded" }, now: PURCHASED_AT + DAY_MS });
  const beforeSummary = await runMaintenance(before);
  assert.equal(beforeSummary.deliveries.claimed, 0);
  assert.equal(before.orders.size, 0);

  // Refunded AFTER the claim, before the fulfillment: the parent guard
  // refuses under its own lock. Nothing is created, and the worker
  // reports it as GUARDED rather than failed.
  const after = world({
    deliveries: scheduleFor({ 1: { state: "claimed", claimed_at: PURCHASED_AT - HOUR_MS } }),
    now: PURCHASED_AT + 7 * HOUR_MS,
  });
  const claimed = await after.workerDeps.claimDue(25);
  assert.equal(claimed.length, 1);
  after.plan.payment_status = "refunded";

  const summary = await quiet(() => runAnnualDeliveryWorker({
    claimDue: async () => claimed,
    fulfillDelivery: after.workerDeps.fulfillDelivery,
    notifyOrder: after.workerDeps.notifyOrder,
  }));

  assert.equal(summary.guarded, 1);
  assert.equal(summary.failed, 0);
  assert.equal(summary.fulfilled, 0);
  assert.equal(after.orders.size, 0, "a refunded plan produced an order");
  assert.equal(after.inbox.length, 0, "a refunded plan produced a notification");
  assert.ok(ANNUAL_FULFILL_GUARDED_RESULTS.includes("plan_refunded"));
});

/* ══════════════════════════════════════════════════════════════
   11-16. THE POST-ORDER PROCESSING AUDIT

   A synthetic annual delivery becomes an ORDINARY order. What an
   ordinary order is owed, it is owed too.
   ══════════════════════════════════════════════════════════════ */

test("11: an annual delivery order reaches the fulfilment inbox, labelled truthfully", async () => {
  const w = world({ now: PURCHASED_AT + DAY_MS });
  await runMaintenance(w);

  assert.equal(w.inbox.length, 1);
  assert.equal(w.inbox[0].source, "annual", "an annual delivery is described as a one-off purchase");
  // The label the template prints says the cadence AND that nothing is
  // owed for this box.
  const built = buildInternalOrderNotificationEmail({
    order: {
      order_number: "GLOA-2026-1001", currency: "EUR", subtotal_gross_cents: 2699,
      shipping_gross_cents: 399, total_gross_cents: 3098, shippingAddress: null,
      customerEmail: "kundin@example.com", customerName: "Kundin Beispiel",
      source: "annual", stripeInvoiceId: null,
    },
    items: ITEMS,
  });
  assert.ok(built.html.includes("Jahresplan-Lieferung"), "the annual label is missing");
  assert.ok(built.html.includes("vorausbezahlt"), "the internal mail does not say it is prepaid");
  assert.ok(!built.html.includes("Einzelbestellung"));
  assert.ok(!built.html.includes("Abo-Lieferung"));
});

test("12: the source label is derived from the attempt, and the other two are unchanged", () => {
  const row = {
    id: "o1", order_number: "GLOA-2026-1001", currency: "EUR", subtotal_gross_cents: 2699,
    shipping_gross_cents: 399, total_gross_cents: 3098, shipping_address_snapshot: null,
    customer_snapshot: { email: "kundin@example.com", name: "Kundin Beispiel" },
    checkout_attempt_id: "a1", internal_notification_status: "failed",
  };
  const base = { items_snapshot: ITEMS, subscription_id: null, stripe_invoice_id: null };

  assert.equal(buildRetryNotificationParams(row, { ...base }).source, "one_time");
  assert.equal(
    buildRetryNotificationParams(row, { ...base, subscription_id: "s1", stripe_invoice_id: "in_1" }).source,
    "subscription"
  );
  const annual = buildRetryNotificationParams(row, { ...base, annual_plan_id: PLAN_ID });
  assert.equal(annual.source, "annual");
  // A prepaid delivery raises no invoice, so none is reported.
  assert.equal(annual.stripeInvoiceId, null);
  // And a subscription order still carries its invoice, unchanged.
  assert.equal(
    buildRetryNotificationParams(row, { ...base, subscription_id: "s1", stripe_invoice_id: "in_1" }).stripeInvoiceId,
    "in_1"
  );
});

test("13: DELIVERY 1 IS COVERED BY THE SAME MECHANISM", () => {
  // The port is on the SHARED worker deps, which the payment webhook and
  // the maintenance job both hand to the same worker. A notification
  // wired into the cron route would have covered twelve of thirteen.
  assert.match(webhookDeps, /notifyOrder:/, "the shared worker deps lost the post-order port");
  assert.match(webhookDeps, /notifyAnnualDeliveryOrder\(order\.orderId\)/);
  assert.ok(webhookDeps.includes("export const annualDeliveryWorkerDeps"));
  // The webhook runs the shared worker with exactly those deps.
  assert.ok(webhookFlow.includes("runAnnualDeliveryWorker(deps.worker)"));
  assert.ok(webhookDeps.includes("worker: annualDeliveryWorkerDeps"));
  // And so does the maintenance job - the same const, imported, not rebuilt.
  assert.match(maintenanceDeps, /import \{ annualDeliveryWorkerDeps \} from "\.\/annualPlanWebhookDeps"/);
  assert.match(maintenanceDeps, /runAnnualDeliveryWorker\(annualDeliveryWorkerDeps\)/);
  // There is exactly ONE delivery worker in the repository.
  const workers = readdirSync(path.join(ROOT, "lib"))
    .filter(f => /Delivery.*Worker|delivery.*worker/.test(f));
  assert.deepEqual(workers, ["annualDeliveryWorker.ts"], "a second annual delivery worker appeared");
});

test("14: the crash window - order created, notification never attempted - is recoverable", async () => {
  const w = world({ now: PURCHASED_AT + DAY_MS });

  // The pass mints the order and dies before the notification is claimed.
  const crashed = await quiet(() => runAnnualDeliveryWorker({
    claimDue: w.workerDeps.claimDue,
    fulfillDelivery: w.workerDeps.fulfillDelivery,
    notifyOrder: async () => { throw new Error("process died"); },
  }));
  assert.equal(crashed.fulfilled, 1);
  assert.equal(crashed.notifyFailed, 1);
  // The order exists, the delivery is fulfilled, and the status is NULL -
  // which the generic failed-only sweep can never see.
  assert.equal(w.orders.size, 1);
  assert.equal(w.orders.get("o1").internal_notification_status, null);
  assert.equal(w.inbox.length, 0);

  // The delivery is NOT claimable again - the lease cannot help here.
  assert.deepEqual(await w.workerDeps.claimDue(25), []);

  // The next maintenance run recovers it, through the annual correlation.
  const summary = await runMaintenance(w);
  assert.equal(summary.orderNotifications.found, 1);
  assert.equal(summary.orderNotifications.notified, 1);
  assert.equal(w.inbox.length, 1);
  assert.equal(w.inbox[0].orderId, "o1");

  // And it does not send a second time on the run after that.
  const again = await runMaintenance(w);
  assert.equal(again.orderNotifications.found, 0);
  assert.equal(w.inbox.length, 1);
});

test("15: the recovery may act on NULL and on nothing else", async () => {
  assert.equal(isAnnualOrderNotificationRecoveryCandidate(null), true);
  assert.equal(isAnnualOrderNotificationRecoveryCandidate(undefined), true);
  // 'failed' belongs to the generic daily sweep, which already runs on
  // this same cron. Two claimants for one row would be two answers.
  assert.equal(isAnnualOrderNotificationRecoveryCandidate("failed"), false);
  assert.equal(isAnnualOrderNotificationRecoveryCandidate("sending"), false);
  assert.equal(isAnnualOrderNotificationRecoveryCandidate("sent"), false);

  // A row that stopped being NULL between the query and the loop is
  // refused in code as well.
  const sent = [];
  const summary = await runAnnualOrderNotificationRecovery({
    loadCandidates: async () => [
      { id: "o1", internal_notification_status: null },
      { id: "o2", internal_notification_status: "sending" },
      { id: "o3", internal_notification_status: "sent" },
      { id: "o4", internal_notification_status: "failed" },
    ],
    notify: async orderId => { sent.push(orderId); },
    logFailure: () => {},
  });
  assert.deepEqual(sent, ["o1"]);
  assert.equal(summary.found, 4);
  assert.equal(summary.notified, 1);
  assert.equal(summary.skipped, 3);
});

test("16: the recovery is scoped by the ANNUAL CORRELATION, never by a global NULL scan", () => {
  const query = orderNotificationCode.slice(
    orderNotificationCode.indexOf("async function loadAnnualOrdersMissingNotification")
  );
  // The inner join to the delivery table is what makes a historical
  // order impossible to return - it has no delivery row behind it.
  assert.match(query, /annual_plan_deliveries!inner/);
  assert.match(query, /\.is\("internal_notification_status", null\)/);
  assert.match(query, /\.limit\(limit\)/);
  // No other module in lib may pair a NULL notification filter with the
  // orders table.
  const globalNullSweeps = readdirSync(path.join(ROOT, "lib"))
    .filter(f => f.endsWith(".ts"))
    .filter(f => {
      const source = withoutComments(read(path.join("lib", f)));
      return source.includes('.is("internal_notification_status", null)');
    });
  assert.deepEqual(globalNullSweeps, ["annualOrderNotification.ts"]);
  // The generic sweep still selects 'failed' and nothing else.
  const retryRules = withoutComments(read("lib/internalOrderNotificationRetryRules.ts"));
  assert.match(retryRules, /export const RETRY_ELIGIBLE_STATUS = "failed";/);
});

test("17: a failed notification is left to the state machine that already retries it", async () => {
  const w = world({ now: PURCHASED_AT + DAY_MS, providerFails: true });
  const summary = await runMaintenance(w);

  // The order exists; the message did not go out.
  assert.equal(summary.deliveries.fulfilled, 1);
  assert.equal(summary.deliveries.notifyFailed, 1);
  assert.equal(summary.deliveries.notified, 0);
  assert.equal(w.orders.get("o1").internal_notification_status, "failed");
  // 'failed' is exactly the generic daily sweep's work list, so the
  // annual recovery deliberately leaves it alone.
  assert.equal(summary.orderNotifications.found, 0);
  // A post-order failure is NOT counted as a delivery failure: the order
  // is durable and re-running the delivery would achieve nothing.
  assert.equal(summary.deliveries.failed, 0);
  assert.ok(summary.deliveries.errors.some(e => e.includes("post-order processing failed")));

  // Once the provider recovers, the existing send path delivers it once.
  w.setProviderFails(false);
  await w.workerDeps.notifyOrder({ orderId: "o1" });
  assert.equal(w.inbox.length, 1);
});

test("18: no customer order confirmation, and no shipment confirmation, is invented here", async () => {
  const w = world({ now: PURCHASED_AT + DAY_MS });
  await runMaintenance(w);

  // A prepaid delivery is not a payment. The order's customer-facing
  // confirmation column stays at its 'pending' default, exactly as a
  // subscription cycle order's does - and 'pending' is invisible to every
  // sweep in the system, all of which select 'failed'.
  assert.equal(w.orders.get("o1").confirmation_email_status, "pending");

  for (const [name, source] of [
    ["annual order notification", orderNotificationCode],
    ["maintenance", maintenanceCode],
    ["maintenance deps", maintenanceDeps],
    ["worker", workerCode],
  ]) {
    for (const banned of [
      "sendOrderConfirmationEmailIfNeeded", "orderConfirmationEmail",
      "sendShipmentConfirmation", "shipmentConfirmation",
      "fulfillment_status", "shipped",
    ]) {
      assert.ok(!source.includes(banned), `${name} reaches into ${banned}`);
    }
  }
});

/* ══════════════════════════════════════════════════════════════
   19-24. THE PURCHASE CONFIRMATION RETRY

   'failed' and stale 'sending'. NEVER NULL.
   ══════════════════════════════════════════════════════════════ */

const purchaseRow = (over = {}) => ({
  id: PLAN_ID,
  purchase_confirmation_email_status: "failed",
  purchase_confirmation_email_claimed_at: new Date(NOW - HOUR_MS).toISOString(),
  ...over,
});

/** A sender port that records which plan ids it was asked about. */
const sweepPort = (rows, answers = {}) => {
  const asked = [];
  return {
    asked,
    port: {
      loadCandidates: async () => rows,
      now: new Date(NOW),
      emailDeps: {
        // The sweep never bypasses the claim: this is the port the real
        // sender calls FIRST, and what it answers decides everything.
        claim: async annualPlanId => {
          asked.push(annualPlanId);
          return answers[annualPlanId] ?? { result: "claimed", annual_plan_id: annualPlanId, claim_token: "22222222-2222-2222-2222-222222222222" };
        },
        loadPlan: async () => null,
        loadDeliveries: async () => [],
        sendEmail: async () => ({ kind: "accepted" }),
        recordResult: async () => ({ result: "recorded" }),
      },
    },
  };
};

test("19: the retry rule admits 'failed' and stale 'sending', and NEVER NULL", () => {
  const now = NOW;
  const stale = new Date(now - ANNUAL_PURCHASE_EMAIL_STALE_AFTER_MS - 1).toISOString();
  const exactly = new Date(now - ANNUAL_PURCHASE_EMAIL_STALE_AFTER_MS).toISOString();
  const live = new Date(now - ANNUAL_PURCHASE_EMAIL_STALE_AFTER_MS + 1).toISOString();

  assert.equal(isAnnualPurchaseEmailRetryCandidate({ status: "failed", claimedAt: live, now }), true);
  assert.equal(isAnnualPurchaseEmailRetryCandidate({ status: "sending", claimedAt: stale, now }), true);
  // Exactly the threshold counts as stale, matching the other families.
  assert.equal(isAnnualPurchaseEmailRetryCandidate({ status: "sending", claimedAt: exactly, now }), true);
  // 29 minutes 59 seconds is a LIVE claim and belongs to its holder.
  assert.equal(isAnnualPurchaseEmailRetryCandidate({ status: "sending", claimedAt: live, now }), false);
  assert.equal(isAnnualPurchaseEmailRetryCandidate({ status: "sent", claimedAt: stale, now }), false);
  // An unusable claimed_at fails SAFE: not a candidate.
  assert.equal(isAnnualPurchaseEmailRetryCandidate({ status: "sending", claimedAt: "not a date", now }), false);
  assert.equal(isAnnualPurchaseEmailRetryCandidate({ status: "sending", claimedAt: null, now }), false);
  // And NULL, in every shape.
  assert.equal(isAnnualPurchaseEmailRetryCandidate({ status: null, claimedAt: null, now }), false);
  assert.equal(isAnnualPurchaseEmailRetryCandidate({ status: undefined, claimedAt: stale, now }), false);
});

test("20: TEN THOUSAND plans that never entered the flow produce ZERO candidates", async () => {
  const nulls = Array.from({ length: 10_000 }, (unused, i) => ({
    id: `plan-${i}`,
    purchase_confirmation_email_status: null,
    purchase_confirmation_email_claimed_at: null,
  }));

  // The rule refuses every one of them.
  assert.equal(
    nulls.filter(r => isAnnualPurchaseEmailRetryCandidate({
      status: r.purchase_confirmation_email_status,
      claimedAt: r.purchase_confirmation_email_claimed_at,
      now: NOW,
    })).length,
    0
  );

  // And so does the sweep, even if such a row somehow reached its loop:
  // the claim RPC is never called, so no provider can be contacted.
  const { asked, port } = sweepPort(nulls);
  const summary = await quiet(() => runAnnualPurchaseEmailRetrySweep(port));
  assert.equal(summary.found, 10_000);
  assert.equal(summary.attempted, 0);
  assert.equal(summary.skipped, 10_000);
  assert.equal(summary.sent, 0);
  assert.deepEqual(asked, [], "a NULL plan reached the claim function");
});

test("21: a failed and a stale sending row are both retried through the SAME sender", async () => {
  const rows = [
    purchaseRow({ id: "plan-failed" }),
    purchaseRow({
      id: "plan-stale",
      purchase_confirmation_email_status: "sending",
      purchase_confirmation_email_claimed_at: new Date(NOW - ANNUAL_PURCHASE_EMAIL_STALE_AFTER_MS - 1000).toISOString(),
    }),
    purchaseRow({
      id: "plan-live",
      purchase_confirmation_email_status: "sending",
      purchase_confirmation_email_claimed_at: new Date(NOW - 60_000).toISOString(),
    }),
    purchaseRow({ id: "plan-sent", purchase_confirmation_email_status: "sent" }),
    purchaseRow({ id: "plan-null", purchase_confirmation_email_status: null, purchase_confirmation_email_claimed_at: null }),
  ];
  const { asked, port } = sweepPort(rows, {
    "plan-failed": { result: "not_purchased", status: "pending" },
    "plan-stale": { result: "already_sent", annual_plan_id: "plan-stale", sent_at: new Date(NOW).toISOString() },
  });

  const summary = await quiet(() => runAnnualPurchaseEmailRetrySweep(port));

  // Only the two genuine candidates were asked about, and each was asked
  // by RE-ENTERING migration 039's claim - not by a private send path.
  assert.deepEqual(asked, ["plan-failed", "plan-stale"]);
  assert.equal(summary.found, 5);
  assert.equal(summary.attempted, 2);
  assert.equal(summary.skipped, 3);
  assert.equal(summary.notEligible, 1);
  assert.equal(summary.alreadySent, 1);
});

test("22: there is exactly one purchase-email sender, and the sweep calls it", () => {
  assert.match(senderCode, /result = await sendAnnualPurchaseConfirmationEmail\(row\.id, port\.emailDeps\);/);
  // No second sender anywhere in the repository.
  const senders = readdirSync(path.join(ROOT, "lib"))
    .filter(f => f.endsWith(".ts"))
    .filter(f => /function (retryAnnualPurchaseEmail|sendAnnualPurchaseConfirmationEmailDirect)/
      .test(withoutComments(read(path.join("lib", f)))));
  assert.deepEqual(senders, []);
  // One definition of the sender, and one only.
  const definitions = readdirSync(path.join(ROOT, "lib"))
    .filter(f => f.endsWith(".ts"))
    .filter(f => /export async function sendAnnualPurchaseConfirmationEmail\(/
      .test(read(path.join("lib", f))));
  assert.deepEqual(definitions, ["annualPurchaseConfirmationEmail.ts"]);
  // The sweep writes no status itself: the claim and the outcome writer
  // are migration 039's, called through the same ports the webhook uses.
  assert.ok(!/\.update\(|\.insert\(/.test(senderCode));
  assert.match(maintenanceDeps, /emailDeps: annualPurchaseEmailDeps/);
});

test("23: an ambiguous or thrown provider outcome is reported, not hidden", async () => {
  const rows = [purchaseRow({ id: "plan-a" }), purchaseRow({ id: "plan-b" })];
  const { port } = sweepPort(rows, {
    "plan-a": { result: "unrecognised_word" },
  });
  port.emailDeps.claim = (annualPlanId => {
    if (annualPlanId === "plan-b") return Promise.reject(new Error("connection reset"));
    return Promise.resolve({ result: "unrecognised_word" });
  });

  const summary = await quiet(() => runAnnualPurchaseEmailRetrySweep(port));
  // Both are failures, both counted, neither escalated into an exception
  // that would strand the rest of the batch.
  assert.equal(summary.attempted, 2);
  assert.equal(summary.failed, 2);
});

test("24: every sweep is bounded, and none loops until empty", () => {
  for (const limit of [
    ANNUAL_DELIVERY_BATCH_LIMIT,
    ANNUAL_ORDER_NOTIFICATION_RECOVERY_LIMIT,
    ANNUAL_PURCHASE_EMAIL_RETRY_LIMIT,
  ]) {
    assert.ok(Number.isInteger(limit) && limit > 0 && limit <= 50, `unreasonable batch limit: ${limit}`);
  }
  assert.match(maintenanceDeps, /export const ANNUAL_COMPLETION_BATCH_LIMIT = \d+;/);
  // The database clamps the two it owns regardless of what is passed.
  assert.equal((m039.match(/least\(greatest\(coalesce\(p_limit, 25\), 1\), 100\)/g) ?? []).length, 2);
  // No unbounded loop anywhere in the runtime.
  for (const [name, source] of [
    ["worker", workerCode], ["maintenance", maintenanceCode],
    ["maintenance deps", maintenanceDeps], ["recovery", orderNotificationRules],
  ]) {
    assert.ok(!/while \(true\)|for \(;;\)|do \{/.test(source), `${name} contains an unbounded loop`);
  }
});

/* ══════════════════════════════════════════════════════════════
   25-27. COMPLETION
   ══════════════════════════════════════════════════════════════ */

const completionWorld = (over, deliveryOver) =>
  world({ plan: over, deliveries: deliveryOver, now: NOW });

const allFulfilled = (count = ANNUAL_DELIVERY_COUNT, missingOrder = false) => {
  const over = {};
  for (let n = 1; n <= count; n++) {
    over[n] = {
      state: "fulfilled",
      checkout_attempt_id: `a${n}`,
      order_id: missingOrder && n === count ? null : `o${n}`,
      claimed_at: PURCHASED_AT,
      fulfilled_at: PURCHASED_AT,
    };
  }
  return scheduleFor(over);
};

test("25: a plan completes only when the term ended AND all thirteen boxes exist", async () => {
  // Term not ended, thirteen fulfilled -> NOT completed.
  const early = completionWorld({ plan_end_at: NOW + DAY_MS }, allFulfilled());
  assert.deepEqual(await early.completeDuePlans(25), { completed: 0 });
  assert.equal(early.plan.status, "active");

  // Term ended, twelve fulfilled -> NOT completed.
  const short = completionWorld({ plan_end_at: NOW - DAY_MS }, allFulfilled(12));
  assert.deepEqual(await short.completeDuePlans(25), { completed: 0 });
  assert.equal(short.plan.status, "active");

  // Term ended, thirteen fulfilled but one without an order -> NOT completed.
  const orderless = completionWorld({ plan_end_at: NOW - DAY_MS }, allFulfilled(13, true));
  assert.deepEqual(await orderless.completeDuePlans(25), { completed: 0 });
  assert.equal(orderless.plan.status, "active");

  // Term ended, thirteen fulfilled with thirteen orders -> completed.
  const done = completionWorld({ plan_end_at: NOW - DAY_MS }, allFulfilled());
  assert.deepEqual(await done.completeDuePlans(25), { completed: 1 });
  assert.equal(done.plan.status, "completed");
  assert.equal(done.plan.completed_at, NOW);
});

test("26: those four conditions live in the DATABASE, and the runtime only invokes them", () => {
  const fn = m039.slice(
    m039.indexOf("create or replace function public.complete_due_annual_plans"),
    m039.indexOf("-- 14. THE FULL-REFUND CONTRACT")
  );
  assert.ok(fn.length > 0, "the completion function moved");
  assert.match(fn, /p\.status = 'active'/);
  assert.match(fn, /p\.plan_end_at <= pg_catalog\.now\(\)/);
  assert.match(fn, /d\.state = 'fulfilled' and d\.order_id is not null/);
  assert.match(fn, /v_total <> v_plan\.delivery_count or v_done <> v_plan\.delivery_count/);
  assert.match(fn, /status\s+= 'completed'/);

  // The runtime passes a bound, counts rows, and decides nothing.
  const wrapper = maintenanceDeps.slice(
    maintenanceDeps.indexOf("async function completeDueAnnualPlans"),
    maintenanceDeps.indexOf("export async function runAnnualPlanMaintenanceJob")
  );
  assert.ok(wrapper.length > 0, "the completion wrapper moved");
  assert.match(wrapper, /admin\.rpc\("complete_due_annual_plans", \{ p_limit: limit \}\)/);
  assert.match(wrapper, /Array\.isArray\(data\) \? data\.length : 0/);
  for (const banned of ["plan_end_at", "delivery_count", "status", "completed_at", "fulfilled"]) {
    assert.ok(!wrapper.includes(banned), `the runtime re-implements the completion rule: ${banned}`);
  }
  // No cancellation logic rode along, and no refund coupling was invented.
  for (const banned of ["cancelled", "payment_status", "refund"]) {
    assert.ok(!maintenanceDeps.includes(banned), `completion was coupled to ${banned}`);
    assert.ok(!maintenanceCode.includes(banned), `completion was coupled to ${banned}`);
  }
});

test("27: the final delivery and the completion happen in the SAME invocation", async () => {
  const twelve = {};
  for (let n = 1; n <= 12; n++) {
    twelve[n] = {
      state: "fulfilled", checkout_attempt_id: `a${n}`, order_id: `o${n}`,
      claimed_at: PURCHASED_AT, fulfilled_at: PURCHASED_AT,
    };
  }
  const w = world({
    plan: { plan_end_at: PURCHASED_AT + 364 * DAY_MS },
    deliveries: scheduleFor(twelve),
    // The term has ended and delivery 13 is due.
    now: PURCHASED_AT + 365 * DAY_MS,
  });

  const summary = await runMaintenance(w);

  assert.equal(summary.deliveries.fulfilled, 1, "delivery 13 was not fulfilled");
  assert.equal(summary.completions.completed, 1, "the plan waited another day to complete");
  assert.equal(w.plan.status, "completed");
  // Which is only possible because completion runs LAST.
  const order = ["runDeliveryPass", "recoverOrderNotifications", "retryPurchaseEmails", "completeDuePlans"];
  const positions = order.map(step => maintenanceCode.indexOf("ports." + step));
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, "the maintenance steps were reordered");
  assert.ok(positions.every(i => i > 0));
});

/* ══════════════════════════════════════════════════════════════
   28-30. FAILURE SEMANTICS AND THE SHAPE OF THE ANSWER
   ══════════════════════════════════════════════════════════════ */

test("28: one broken step does not cancel the other three, and it is reported", async () => {
  const logged = [];
  const summary = await runAnnualPlanMaintenance({
    runDeliveryPass: async () => { throw new Error("queue unreachable"); },
    recoverOrderNotifications: async () => ({ found: 1, notified: 1, skipped: 0, failed: 0, errors: [] }),
    retryPurchaseEmails: async () => ({
      found: 2, attempted: 2, skipped: 0, sent: 2, alreadySent: 0,
      inFlight: 0, notEligible: 0, ambiguous: 0, failed: 0, errors: [],
    }),
    completeDuePlans: async () => ({ completed: 3 }),
    logFailure: (step, message) => logged.push([step, message]),
  });

  assert.equal(summary.deliveries.errored, true);
  assert.equal(summary.deliveries.claimed, 0);
  assert.equal(summary.deliveries.fulfilled, 0);
  // The other three still ran, and none of them is marked errored.
  assert.equal(summary.orderNotifications.notified, 1);
  assert.equal(summary.orderNotifications.errored, false);
  assert.equal(summary.purchaseEmails.sent, 2);
  assert.equal(summary.completions.completed, 3);
  assert.equal(summary.completions.errored, false);
  assert.deepEqual(logged.map(entry => entry[0]), ["deliveries"]);
});

test("29: a run that could not start at all answers with errored, never with a clean zero", () => {
  const empty = emptyAnnualMaintenanceSummary(true);
  for (const block of Object.values(empty)) {
    assert.equal(block.errored, true, "an all-zero answer claimed success");
  }
  assert.equal(empty.deliveries.fulfilled, 0);
  assert.equal(empty.completions.completed, 0);
  // And the route uses it ONLY for a failure.
  assert.match(cronRoute, /annual = emptyAnnualMaintenanceSummary\(true\);/);
  assert.ok(!cronRoute.includes("emptyAnnualMaintenanceSummary(false)"));
});

test("30: business guards are counted, infrastructure failures are surfaced", async () => {
  // A guarded refusal is not an error and must not become one.
  assert.deepEqual([...ANNUAL_FULFILL_GUARDED_RESULTS],
    ["plan_not_active", "plan_refunded", "delivery_not_claimed"]);
  assert.deepEqual([...ANNUAL_FULFILL_SUCCESS_RESULTS], ["fulfilled", "already_fulfilled"]);

  // A word nobody recognises FAILS CLOSED rather than counting as done.
  const summary = await quiet(() => runAnnualDeliveryWorker({
    claimDue: async () => [
      { delivery_id: "d1", annual_plan_id: PLAN_ID, delivery_number: 1, scheduled_for: "x", reclaimed: false },
    ],
    fulfillDelivery: async () => ({ result: "something_new" }),
    notifyOrder: async () => { throw new Error("must not be reached"); },
  }));
  assert.equal(summary.failed, 1);
  assert.equal(summary.fulfilled, 0);
  assert.equal(summary.notified, 0);
});

/* ══════════════════════════════════════════════════════════════
   31-34. THE CRON, THE FLAG AND THE PHASE BOUNDARY
   ══════════════════════════════════════════════════════════════ */

test("31: ONE cron schedule, unchanged, and the annual job runs inside it", () => {
  const vercel = JSON.parse(read("vercel.json"));
  assert.equal(vercel.crons.length, 1, "a second Vercel cron schedule appeared");
  assert.equal(vercel.crons[0].path, "/api/cron/retry-order-notifications");
  assert.equal(vercel.crons[0].schedule, "20 5 * * *");
  // Exactly one cron route exists in the app.
  const cronRoutes = readdirSync(path.join(ROOT, "app/api/cron"), { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name);
  assert.deepEqual(cronRoutes, ["retry-order-notifications"]);
  // And the annual maintenance is reached from it.
  assert.match(cronRoute, /runAnnualPlanMaintenanceJob\(\)/);
  assert.match(cronRoute, /\{ \.\.\.summary, deferredCancellations, subscriptionEmails, annual \}/);
});

test("32: the annual job is behind the SAME authentication, and takes no input", () => {
  const handler = cronRoute.slice(cronRoute.indexOf("export async function GET"));
  const secret = handler.indexOf("if (!secret)");
  const annual = handler.indexOf("runAnnualPlanMaintenanceJob(");
  assert.ok(secret > 0 && annual > secret, "annual work happens before the secret check");
  assert.ok(handler.indexOf("isBearerSecretAuthorized(request, secret)") < annual);
  assert.ok(handler.indexOf("getSupabaseAdmin()") < annual);
  // GET only, and nothing is read from the request.
  assert.deepEqual([...cronRoute.matchAll(/export async function ([A-Z]+)\(/g)].map(m => m[1]), ["GET"]);
  for (const forbidden of ["searchParams", "new URL(", "request.json()", "annualPlanId", "orderId", "p_limit"]) {
    assert.ok(!cronRoute.includes(forbidden), `the endpoint accepts ${forbidden}`);
  }
  // No browser-visible variable and no second secret.
  assert.ok(!/VITE_/.test(cronRoute));
  assert.ok(!cronRoute.includes("FULFILLMENT_ADMIN_SECRET"));
  // The maintenance itself is not reachable from any page or component.
  const libNaming = readdirSync(path.join(ROOT, "lib"))
    .filter(f => f.endsWith(".ts"))
    .filter(f => read(path.join("lib", f)).includes("runAnnualPlanMaintenanceJob"));
  assert.deepEqual(libNaming, ["annualPlanMaintenanceDeps.ts"], "a second module runs the maintenance");
  // No page, layout or component can reach it: the only app/ file that
  // names it is the authenticated cron route.
  const appFiles = [];
  const walk = dir => {
    for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = dir + "/" + entry.name;
      if (entry.isDirectory()) walk(rel);
      else if (/\.(ts|tsx)$/.test(entry.name)) appFiles.push(rel);
    }
  };
  walk("app");
  const appNaming = appFiles.filter(rel => read(rel).includes("runAnnualPlanMaintenanceJob"));
  assert.deepEqual(appNaming, ["app/api/cron/retry-order-notifications/route.ts"]);
});

test("33: B2C_ANNUAL_PLAN_ENABLED cannot stop an existing contract", () => {
  for (const [name, source] of [
    ["maintenance", maintenanceCode],
    ["maintenance deps", maintenanceDeps],
    ["worker", workerCode],
    ["annual order notification", orderNotificationCode],
    ["recovery rules", orderNotificationRules],
    ["cron route", cronRoute],
  ]) {
    assert.ok(!source.includes("B2C_ANNUAL_PLAN_ENABLED"), `${name} gates maintenance on the sales flag`);
    assert.ok(!/process\.env\.[A-Z_]*ANNUAL/.test(source), `${name} reads an annual feature flag`);
  }
  // The flag still exists where it belongs: the checkout path.
  assert.ok(read("lib/annualPlanCheckoutRules.ts").includes("B2C_ANNUAL_PLAN_ENABLED")
    || read("lib/annualPlanCheckout.ts").includes("B2C_ANNUAL_PLAN_ENABLED"),
    "the sales flag disappeared from the checkout path");
});

test("34: this phase adds no migration and edits none", () => {
  const migrations = readdirSync(path.join(ROOT, "supabase/migrations"))
    .filter(f => f.endsWith(".sql")).sort();
  assert.equal(migrations.length, 40);
  assert.equal(migrations[migrations.length - 1], "040_annual_checkout_retry_fingerprints.sql");
  assert.deepEqual(migrations.filter(f => Number(f.slice(0, 3)) > 40), [], "a 041 appeared");
  const changed = execFileSync("git", ["diff", "--name-only", "HEAD", "--", "supabase/migrations/"],
    { cwd: ROOT, encoding: "utf-8" }).trim();
  assert.equal(changed, "", "a live, immutable migration was edited");

  // The maintenance calls exactly the four installed functions it may,
  // and creates nothing itself.
  for (const rpc of [
    "claim_due_annual_plan_deliveries", "fulfill_annual_plan_delivery",
    "claim_annual_plan_purchase_email", "record_annual_plan_purchase_email_result",
    "complete_due_annual_plans",
  ]) {
    assert.ok(m039.includes(`function public.${rpc}(`), `039 lost ${rpc}`);
  }
  for (const banned of [
    "create_order_from_paid_checkout", "createOrderFromPaidCheckoutAttempt",
    "apply_annual_plan_refund_state", "activate_annual_plan_from_payment",
  ]) {
    assert.ok(!maintenanceDeps.includes(banned), `the maintenance calls ${banned}`);
    assert.ok(!maintenanceCode.includes(banned), `the maintenance calls ${banned}`);
  }
});

test("35: the leaves stay leaves, so this suite can execute them at all", () => {
  for (const rel of [
    "lib/annualDeliveryWorker.ts",
    "lib/annualPlanMaintenance.ts",
    "lib/annualOrderNotificationRules.ts",
  ]) {
    assert.ok(!/^import /m.test(read(rel)), `${rel} gained an import`);
  }
  // And the wiring is where every effect lives.
  assert.match(read("lib/annualPlanMaintenanceDeps.ts"), /^import /m);
  assert.match(read("lib/annualOrderNotification.ts"), /^import /m);
});
