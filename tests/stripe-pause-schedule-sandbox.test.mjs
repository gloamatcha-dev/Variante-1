import assert from "node:assert/strict";
import test from "node:test";
import { createStripePauseScheduleSandbox, PAUSE_SCHEDULE_API_VERSION } from "../lib/stripePauseScheduleSandbox.server.ts";

const target = {
  stripeId: "sub_synthetic",
  localId: "40000000-0000-4000-8000-000000000001",
  operationId: "40000000-0000-4000-8000-000000000002",
};
const boundary = 1800000000;
const scheduleId = "sub_sched_synthetic";
const pause = status => ({ pause_at: boundary, status: { type: status } });
const entry = { key: "synthetic", pause: pause("succeeded") };
const sub = {
  id: target.stripeId, livemode: false, status: "active", collection_method: "charge_automatically",
  metadata: { gloa_subscription_id: target.localId }, schedule: null, billing_mode: { type: "flexible" },
  items: { has_more: false, data: [{ current_period_end: boundary, price: {
    recurring: { interval: "week", interval_count: 4, usage_type: "licensed" },
  } }] },
};
const schedule = { id: scheduleId, subscription: sub.id, livemode: false, status: "active",
  billing_mode: { type: "flexible" }, pause_schedules: [entry] };

function harness({ subscription = sub, openStatus, beforeWrite, oldSchedule = schedule, result = schedule } = {}) {
  const writes = [];
  const adapter = createStripePauseScheduleSandbox("sk_test_synthetic", async (url, options) => {
    assert.equal(new URL(url).origin, "https://api.stripe.com");
    assert.equal(options.headers.get("Stripe-Version"), PAUSE_SCHEDULE_API_VERSION);
    assert.equal(options.redirect, "error");
    const { pathname, searchParams } = new URL(url);
    if (options.method === "POST") {
      writes.push({ pathname, params: Object.fromEntries(options.body), key: options.headers.get("Idempotency-Key") });
      await beforeWrite?.();
      return Response.json(result);
    }
    if (pathname.includes("/invoices")) {
      assert.equal(searchParams.get("subscription"), target.stripeId);
      return Response.json({ has_more: false, data: searchParams.get("status") === openStatus ? [{}] : [] });
    }
    if (pathname.includes("/subscription_schedules/")) return Response.json(oldSchedule);
    return Response.json(subscription);
  }, () => boundary * 1000 - 100000);
  return { adapter, writes };
}

test("a flexible licensed four-week subscription is scheduled at its next unpaid boundary", async () => {
  const h = harness({ result: { ...schedule, pause_schedules: [{ ...entry, pause: pause("scheduled") }] } });
  assert.deepEqual(await h.adapter.change(target, "pause"), { state: "scheduled", scheduleId, pauseAt: boundary });
  assert.deepEqual(h.writes, [{ pathname: "/v1/subscription_schedules",
    params: { from_subscription: target.stripeId, "pause_schedules[0][pause][pause_at][type]": "timestamp",
      "pause_schedules[0][pause][pause_at][timestamp]": String(boundary) },
    key: "gloa-pause-sandbox:pause:" + target.operationId,
  }]);
  assert.equal((await h.adapter.change(target, "pause")).reason, "inspection_required");
});

test("unsupported billing, live objects, conflicting schedules and unresolved invoices block writes", async () => {
  assert.throws(() => createStripePauseScheduleSandbox("sk_live_example"), /test_key_required/);
  for (const [options, reason] of [
    [{ subscription: { ...sub, billing_mode: { type: "classic" } } }, "unsupported_billing_mode"],
    [{ subscription: { ...sub, livemode: true } }, "unverified_subscription"],
    [{ subscription: { ...sub, schedule: scheduleId } }, "conflicting_subscription_state"],
    [{ openStatus: "open" }, "unresolved_invoice"],
    [{ openStatus: "draft" }, "unresolved_invoice"],
  ]) {
    const h = harness(options);
    assert.deepEqual(await h.adapter.change(target, "pause"), { state: "blocked", reason });
    assert.equal(h.writes.length, 0);
  }
});

test("resume uses the confirmed pause key and waits for payment evidence before callers may grant service", async () => {
  const subscription = { ...sub, status: "paused", schedule: scheduleId };
  const h = harness({ subscription, result: { ...schedule,
    pause_schedules: [{ ...entry, resume: { status: { type: "pending" } } }] } });
  assert.deepEqual(await h.adapter.change(target, "resume"), { state: "resume_requested", scheduleId });
  assert.deepEqual(h.writes[0].params, {
    "pause_schedules[0][key]": entry.key,
    "pause_schedules[0][resume][resume_at][type]": "now",
    "pause_schedules[0][resume][settings][billing_cycle_anchor]": "resume_at",
    "pause_schedules[0][resume][settings][payment_behavior]": "resume_on_payment_success",
  });
  const pending = harness({ subscription, oldSchedule: { ...schedule,
    pause_schedules: [{ ...entry, resume: { status: { type: "pending" } } }] } });
  assert.equal((await pending.adapter.change(target, "resume")).reason, "unverified_pause_schedule");
  assert.equal(pending.writes.length, 0);
});

test("parallel requests and a lost write response cannot cause an automatic resubmission", async () => {
  let unblock;
  const stalled = new Promise(resolve => { unblock = resolve; });
  const h = harness({ beforeWrite: async () => { await stalled; throw new Error("synthetic timeout"); } });
  const first = h.adapter.change(target, "pause");
  assert.equal((await h.adapter.change(target, "pause")).reason, "operation_in_progress");
  unblock();
  assert.deepEqual(await first, { state: "unconfirmed" });
  assert.equal((await h.adapter.change(target, "pause")).reason, "inspection_required");
  assert.equal((await h.adapter.change({ ...target, operationId: target.localId }, "pause")).reason, "inspection_required");
  assert.equal(h.writes.length, 1);
});

test("resume proof uses current sandbox state and a completed matching schedule", async () => {
  const subscription = { ...sub, schedule: scheduleId };
  const resumedSchedule = { ...schedule,
    pause_schedules: [{ ...entry, resume: { status: { type: "succeeded" } } }] };
  const current = harness({ subscription, oldSchedule: resumedSchedule });
  assert.equal(await current.adapter.confirmedResume(target, scheduleId), true);
  for (const options of [
    { subscription: { ...subscription, status: "paused" }, oldSchedule: resumedSchedule },
    { subscription: { ...subscription, livemode: true }, oldSchedule: resumedSchedule },
    { subscription, oldSchedule: { ...resumedSchedule, subscription: "sub_other" } },
    { subscription, oldSchedule: schedule },
  ]) {
    const h = harness(options);
    assert.equal(await h.adapter.confirmedResume(target, scheduleId), false);
    assert.equal(h.writes.length, 0);
  }
  assert.equal(current.writes.length, 0);
});
