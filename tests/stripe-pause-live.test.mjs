import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { load } from "../scripts/stripe-pause-loopback.mjs";
import { createStripePauseScheduleLive, GLOA_LIVE_PAUSE_ACCOUNT, GLOA_LIVE_PAUSE_ENDPOINT } from
  "../lib/stripePauseScheduleSandbox.server.ts";

const key = "rk_live_fixture";
const localId = "40000000-0000-4000-8000-000000000001";
const stripeId = "sub_live_fixture";
const scheduleId = "sub_sched_fixture";
const now = 1800000000;
const pauseAt = now - 86400;
const target = { stripeId, localId, operationId: randomUUID(), stripeCustomerId: "cus_owner",
  liveCyclePrice: { totalCents: 2089, shippingCents: 590 }, pauseProof: { scheduleId, pauseAt } };
const items = [1499, 590].map(unit_amount => ({ quantity: 1, current_period_end: pauseAt,
  price: { id: "price_" + unit_amount, currency: "eur", unit_amount,
    product: unit_amount === 1499 ? "prod_VJXyucGJG3m2Vf" : "prod_VAFbv5UQXUbTt7",
    recurring: { interval: "week", interval_count: 4, usage_type: "licensed" } } }));
const subscription = { id: stripeId, livemode: true, schedule: null, status: "paused", customer: "cus_owner",
  collection_method: "charge_automatically", billing_mode: { type: "flexible" }, metadata: { gloa_subscription_id: localId },
  items: { has_more: false, data: items }, status_details: { paused: {
    type: "subscription", transitioned_at: pauseAt, subscription: { type: "pause_requested" },
  } } };
const neededEvents = ["invoice.paid", "customer.subscription.paused", "customer.subscription.resumed"];

function fixture({ account = GLOA_LIVE_PAUSE_ACCOUNT, events = neededEvents, sub = subscription, due = 2089, pending = false } = {}) {
  const requests = [];
  const adapter = createStripePauseScheduleLive(key, async (url, options) => {
    const { pathname } = new URL(url);
    requests.push({ pathname, method: options.method, body: options.body && Object.fromEntries(options.body) });
    if (pathname === "/v1/account") return Response.json({ object: "account", id: account });
    if (pathname === "/v1/webhook_endpoints/" + GLOA_LIVE_PAUSE_ENDPOINT) {
      return Response.json({ id: GLOA_LIVE_PAUSE_ENDPOINT, livemode: true, status: "enabled",
        url: "https://gloamatcha.com/api/stripe/webhook", enabled_events: events });
    }
    if (pathname === "/v1/subscriptions/" + stripeId) return Response.json(sub);
    if (pathname === "/v1/subscription_schedules/" + scheduleId) {
      return Response.json({ id: scheduleId, livemode: true, status: "released", subscription: null,
        released_subscription: stripeId, released_at: pauseAt, end_behavior: "release", billing_mode: { type: "flexible" },
        pause_schedules: [{ key: "pause_schedule_fixture", pause: { pause_at: pauseAt, status: { type: "succeeded" } } }],
      });
    }
    if (pathname === "/v1/invoices") return Response.json({ has_more: false, data: [] });
    if (pathname === "/v1/invoices/create_preview") return Response.json({
      livemode: true, currency: "eur", customer: "cus_owner", subtotal: 2089, total: 2089, amount_due: due,
      starting_balance: 0, ending_balance: 0, parent: { subscription_details: { subscription: stripeId } },
      lines: { has_more: false, data: items.map(item => ({ amount: item.price.unit_amount, quantity: 1,
        parent: { subscription_item_details: { subscription: stripeId, proration: false } },
        pricing: { price_details: { price: item.price.id } }, period: { start: now, end: now + 28 * 86400 },
      })) },
    });
    assert.equal(pathname, "/v1/subscriptions/" + stripeId + "/resume");
    return Response.json({ ...subscription, status: pending ? "paused" : "active", latest_invoice: "in_resume_live_fixture" });
  }, () => now * 1000);
  return { adapter, requests };
}

test("LIVE uses the shared adapter and requires the right account, mode, owner and webhook events", async () => {
  assert.throws(() => createStripePauseScheduleLive("sk_test_fixture"), /live_key_required/);
  for (const options of [
    { account: "acct_foreign" },
    { events: neededEvents.slice(0, 2) },
    { sub: { ...subscription, livemode: false } },
    { sub: { ...subscription, customer: "cus_other" } },
    { sub: { ...subscription, items: { has_more: false, data: items.map(item => ({
      ...item, price: { ...item.price, product: "prod_unverified" },
    })) } } },
    { sub: { ...subscription, items: { has_more: false, data: items.map(item => ({
      ...item, price: { ...item.price, recurring: { interval: "year", interval_count: 1, usage_type: "licensed" } },
    })) } } },
  ]) {
    const { adapter, requests } = fixture(options);
    assert.equal((await adapter.change(target, "resume")).state, "blocked");
    assert.equal(requests.filter(request => request.method === "POST").length, 0);
  }
});

test("LIVE requires a matching preview before mutating and a pending response keeps the payment fence", async () => {
  const wrongContract = fixture();
  assert.equal((await wrongContract.adapter.change({ ...target,
    liveCyclePrice: { totalCents: 2589, shippingCents: 590 },
  }, "resume")).reason, "unverified_live_plan");
  assert.equal(wrongContract.requests.some(request => request.method === "POST"), false);
  const rejected = fixture({ due: 2589 });
  assert.equal((await rejected.adapter.change(target, "resume")).reason, "unverified_resume_preview");
  assert.deepEqual(rejected.requests.filter(x => x.method === "POST").map(x => x.pathname),
    ["/v1/invoices/create_preview"]);
  const { adapter, requests } = fixture({ pending: true });
  const result = await adapter.change(target, "resume");
  assert.equal(result.state, "resume_requested");
  assert.equal(result.holdFence, true);
  assert.equal(result.resumeInvoiceId, "in_resume_live_fixture");
  assert.deepEqual(requests.filter(x => x.method === "POST").map(({ pathname, body }) => ({ pathname, body })), [
    { pathname: "/v1/invoices/create_preview", body: { subscription: stripeId,
      "subscription_details[resume_at]": "now", "subscription_details[billing_cycle_anchor][type]": "now",
      "subscription_details[proration_behavior]": "none" } },
    { pathname: "/v1/subscriptions/" + stripeId + "/resume",
      body: { "billing_cycle_anchor[type]": "now", proration_behavior: "none", payment_behavior: "resume_on_payment_success" } },
  ]);
});

test("LIVE customer actions default closed and require an endpoint pin, matching digest and allowlist", () => {
  const signing = "whsec_fixture";
  const env = { VERCEL_ENV: "production", STRIPE_SECRET_KEY: key, STRIPE_WEBHOOK_SECRET: signing,
    GLOA_LIVE_PAUSE_SIGNING_ENDPOINT: GLOA_LIVE_PAUSE_ENDPOINT,
    GLOA_LIVE_PAUSE_SIGNING_SHA256: createHash("sha256").update(signing).digest("hex"),
    GLOA_LIVE_PAUSE_SUBSCRIPTIONS: stripeId };
  const actions = load("../lib/subscriptionPauseActions.server.ts", {
    "node:crypto": { createHash, randomUUID },
    "stripePauseScheduleSandbox.server": { GLOA_LIVE_PAUSE_ENDPOINT },
  }, env);
  assert.equal(actions.livePauseActionsKey(stripeId), null);
  env.GLOA_LIVE_PAUSE_ACTIONS = "true";
  assert.equal(actions.livePauseActionsKey(stripeId), key);
  assert.equal(actions.livePauseActionsKey("sub_foreign"), null);
  assert.equal(actions.sandboxPauseKey(), null);
  env.STRIPE_WEBHOOK_SECRET = "whsec_different";
  assert.equal(actions.livePauseActionsKey(stripeId), null);
});

test("customer route does not dispatch LIVE actions for a foreign subscription owner", async () => {
  let caller = "foreign";
  const handedOff = [];
  const route = load("../app/api/subscriptions/pause-status/route.ts", {
    verifyUser: { verifyBearerUser: async () => caller ? { userId: caller } : null },
    supabaseAdmin: { getSupabaseAdmin: () => ({ from: () => ({
      select() { return this; }, eq(column, value) { this[column] = value; return this; },
      async maybeSingle() { return { data: this.user_id === "owner" && this.id === localId ?
        { id: localId, stripe_subscription_id: stripeId, status: "active" } : null }; },
    }) }) },
    "subscriptionPauseActions.server": {
      sandboxPauseKey: () => null, livePauseActionsKey: id => id === stripeId ? key : null,
      changeLiveSubscriptionPause: async (_admin, target, action, userId) => {
        handedOff.push({ ...target, action, userId });
        return { state: "resume_requested" };
      },
    },
  });
  const send = () => route.POST(new Request("http://127.0.0.1/api/subscriptions/pause-status", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ subscriptionId: localId, action: "resume" }),
  }));
  assert.equal((await send()).status, 404);
  assert.deepEqual(handedOff, []);
  caller = "owner";
  assert.equal((await send()).status, 202);
  assert.equal(handedOff.length, 1);
  assert.equal(handedOff[0].userId, "owner");
});

test("LIVE paid invoice dependency keeps the detached cycle guarded and leaves unrelated subscriptions outside the new path", async () => {
  let context = true;
  let configure = true;
  const app = load("../lib/subscriptionInvoiceFulfillment.ts", {
    "subscriptionPauseActions.server": {
      livePauseKey: () => configure ? key : null, livePauseTargetAllowed: value => value === stripeId, sandboxPauseKey: () => null,
    },
    "stripePauseScheduleSandbox.server": { createStripePauseScheduleLive: () => ({ verifyContext: async () => context }) },
    subscriptionInvoiceRules: { idOf: id => id },
  });
  const deps = app.subscriptionInvoiceDeps({}, true);
  assert.equal(deps.pauseCycleApplies("sub_unrelated"), false);
  const active = { ...subscription, status: "active", billing_cycle_anchor: now };
  const paid = { start: new Date(now * 1000).toISOString(), end: new Date((now + 28 * 86400) * 1000).toISOString() };
  assert.equal((await deps.prepareSandboxCycle(active, localId, paid)).resumedAt, paid.start);
  assert.equal((await deps.prepareSandboxCycle({ ...active, status: "paused" }, localId, paid)).resumedAt, null);
  await assert.rejects(deps.prepareSandboxCycle({ ...active, livemode: false }, localId, paid), /mode mismatch/);
  context = false;
  await assert.rejects(deps.prepareSandboxCycle(active, localId, paid), /context unconfirmed/);
  configure = false;
  assert.equal(app.subscriptionInvoiceDeps({}, true).prepareSandboxCycle, undefined);
});
