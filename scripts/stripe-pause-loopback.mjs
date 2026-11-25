import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import vm from "node:vm";
import { pathToFileURL } from "node:url";
import Stripe from "stripe";
import ts from "typescript";

const accountId = "acct_1U6B3cDASU5R3UGE";
const path = "/api/stripe/webhook";
const sandboxWebhookId = "we_1U6GTJDASU5R3UGE7b0tAd9l";
const lifecycle = new Set([
  "customer.subscription.updated", "customer.subscription.paused", "customer.subscription.resumed",
]);

function load(relativePath, deps, env = {}, errors = () => {}) {
  const module = { exports: {} };
  const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
  vm.runInNewContext(ts.transpileModule(source.replaceAll("import.meta.env", "localBuildEnv"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    module, exports: module.exports, Response, Request, URL, URLSearchParams, Headers, AbortSignal, TextDecoder, Date, console: { error: errors },
    process: { env }, localBuildEnv: Object.freeze({ VITE_SUPABASE_URL: "http://127.0.0.1" }),
    require(name) { return deps[name.split("/").at(-1)] ?? {}; },
  });
  return module.exports;
}

export function receiver({ stripe, secret, subscriptionId, getSubscriptionId = () => subscriptionId, retrieve }) {
  const errors = [];
  const events = new Set();
  const verifiedTypes = new Set();
  const periods = [];
  const payments = [];
  const admin = {
    from(table) {
      assert.equal(table, "stripe_webhook_events");
      return {
        select() { return this; },
        eq(column, id) { assert.equal(column, "stripe_event_id"); this.id = id; return this; },
        async maybeSingle() { return { data: events.has(this.id) ? { stripe_event_id: this.id } : null }; },
        async insert(row) { events.add(row.stripe_event_id); return {}; },
      };
    },
    async rpc(name, args) {
      assert.equal(args.p_stripe_subscription_id, getSubscriptionId());
      if (name === "sync_subscription_from_stripe") periods.push(args);
      else if (name === "sync_subscription_payment_status") payments.push(args);
      else throw new Error("Unexpected RPC");
      return { data: { result: "unchanged" } };
    },
  };
  const persistence = { supabaseAdmin: { getSupabaseAdmin: () => admin } };
  const stripeClient = { webhooks: stripe.webhooks, subscriptions: { retrieve } };
  const route = load("../app/api/stripe/webhook/route.ts", {
    stripe: { getStripeClient: () => stripeClient },
    stripeRefunds: load("../lib/stripeRefunds.ts", {}),
    stripeWebhookEvents: load("../lib/stripeWebhookEvents.ts", persistence),
    "subscriptionPauseActions.server": { sandboxPauseKey: () => true },
    subscriptionCancellation: load("../lib/subscriptionCancellation.ts", persistence),
    subscriptionPaymentStatus: load("../lib/subscriptionPaymentStatus.ts", {
      ...persistence,
      subscriptionEmailDeliveryRules: load("../lib/subscriptionEmailDeliveryRules.ts", {}),
    }),
    b2bSubscriptionCancellation: { reconcileB2bCancelAt: async () => ({ kind: "ignored" }) },
  }, { STRIPE_WEBHOOK_SECRET: secret }, (...args) => errors.push(args));

  const server = createServer(async (request, response) => {
    try {
      if (request.method !== "POST" || request.url !== path) return response.writeHead(404).end();
      const parts = [];
      let size = 0;
      for await (const part of request) {
        size += part.length;
        if (size > 262144) return response.writeHead(413).end();
        parts.push(part);
      }
      const raw = Buffer.concat(parts);
      const signature = request.headers["stripe-signature"];
      let event;
      try { event = stripe.webhooks.constructEvent(raw, signature, secret); }
      catch { return response.writeHead(400).end(); }
      if (event.livemode !== false || event.data.object.livemode !== false ||
          !getSubscriptionId() || event.data.object.id !== getSubscriptionId() || (event.account && event.account !== accountId)) {
        return response.writeHead(403).end();
      }
      if (!lifecycle.has(event.type)) return response.writeHead(422).end();
      const result = await route.POST(new Request("http://127.0.0.1" + path, {
        method: "POST", headers: { "stripe-signature": signature }, body: raw,
      }));
      if (result.ok && events.has(event.id)) verifiedTypes.add(event.type);
      response.writeHead(result.status).end();
    } catch {
      response.writeHead(500).end();
    }
  });
  return { server, events, periods, payments, errors, verifiedTypes };
}


export function pauseActions({ key, localId, subscriptionId, transport, checkEndpoint, retrieve }) {
  const ownerToken = randomUUID();
  const ownerId = randomUUID();
  const subscription = { id: localId, user_id: ownerId, stripe_subscription_id: subscriptionId, status: "active" };
  const windows = new Map();
  let fence;
  const admin = {
    from(table) {
      if (table === "subscriptions") {
        const filters = [];
        return {
          select() { return this; },
          eq(column, value) { filters.push([column, value]); return this; },
          async maybeSingle() {
            return { data: filters.every(([column, value]) => subscription[column] === value) ? subscription : null };
          },
        };
      }
      if (table === "subscription_pause_write_fences") return {
        async insert(row) {
          assert.equal(row.subscription_id, localId);
          if (fence) return { error: { code: "23505" } };
          fence = row;
          return {};
        },
        delete() {
          const filters = {};
          return {
            eq(column, value) {
              filters[column] = value;
              if (column !== "operation_id") return this;
              assert.equal(filters.subscription_id, fence?.subscription_id);
              assert.equal(filters.operation_id, fence?.operation_id);
              fence = undefined;
              return Promise.resolve({});
            },
          };
        },
      };
      if (table === "subscription_pause_windows") return {
        select() { return this; },
        eq(column, value) { assert.equal(column, "subscription_id"); assert.equal(value, localId); return this; },
        is(column, value) { assert.equal(column, "resumed_at"); assert.equal(value, null); return this; },
        async maybeSingle() {
          return windows.size > 1 ? { error: true } : { data: windows.values().next().value ?? null };
        },
        async insert(row) {
          assert.equal(row.subscription_id, localId);
          if (windows.has(row.schedule_id)) return { error: { code: "23505" } };
          windows.set(row.schedule_id, row);
          return {};
        },
      };
      throw new Error("Unexpected action table");
    },
  };
  const persistence = { supabaseAdmin: { getSupabaseAdmin: () => admin } };
  const adapter = load("../lib/stripePauseScheduleSandbox.server.ts", {});
  const actions = load("../lib/subscriptionPauseActions.server.ts", {
    ...persistence,
    "node:crypto": { randomUUID },
    "stripePauseScheduleSandbox.server": {
      createStripePauseScheduleSandbox: secret => adapter.createStripePauseScheduleSandbox(secret, transport),
    },
  }, { VERCEL_ENV: process.env.VERCEL_ENV, GLOA_SANDBOX_PAUSE_ACTIONS: "true", STRIPE_SECRET_KEY: key });
  const route = load("../app/api/subscriptions/pause-status/route.ts", {
    ...persistence,
    "subscriptionPauseActions.server": actions,
    verifyUser: { verifyBearerUser: async request =>
      request.headers.get("authorization") === "Bearer " + ownerToken ? { userId: ownerId } : null },
  });
  return {
    windows,
    async request(action, id = localId, authorized = true) {
      if (action !== "pause" && action !== "resume") throw new Error("Unsupported action");
      if (authorized && id === localId) {
        // A sandbox identifier alone does not show that this subscription is disposable.
        await checkEndpoint();
        await retrieve(subscriptionId);
      }
      return route.POST(new Request("http://127.0.0.1/api/subscriptions/pause-status", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: authorized ? "Bearer " + ownerToken : "" },
        body: JSON.stringify({ subscriptionId: id, action }),
      }));
    },
  };
}

export async function start(server, port = 0) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return "http://127.0.0.1:" + server.address().port + path;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
if (process.argv[2] === "--listen") {
  if (process.env.VERCEL_ENV === "production") throw new Error("Production is not allowed");
  const { GLOA_TEST_STRIPE_KEY: key, GLOA_TEST_WEBHOOK_SECRET: secret,
    GLOA_TEST_SUBSCRIPTION_ID: subscriptionId, GLOA_TEST_LOCAL_SUBSCRIPTION_ID: localId } = process.env;
  if (!/^(?:sk|rk)_test_[a-zA-Z0-9_]+$/.test(key ?? "") || !/^whsec_[a-zA-Z0-9]+$/.test(secret ?? "") ||
      !/^sub_[a-zA-Z0-9_]+$/.test(subscriptionId ?? "") ||
      !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(localId ?? "")) throw new Error("Isolated test credentials and subscription required");
  const stripe = new Stripe(key, { maxNetworkRetries: 0, timeout: 8000 });
  const account = await stripe.accounts.retrieve();
  if (account.id !== accountId) throw new Error("Wrong Stripe sandbox");
  const retrieve = async id => {
    if (id !== subscriptionId) throw new Error("Unexpected subscription");
    const subscription = await stripe.subscriptions.retrieve(id);
    if (subscription.id !== subscriptionId || subscription.livemode !== false ||
        subscription.metadata?.gloa_subscription_id !== localId ||
        subscription.metadata?.gloa_test_fixture !== "pause-loopback") throw new Error("Unexpected Stripe test fixture");
    return subscription;
  };
  const checkEndpoint = async () => {
    const endpoint = await stripe.webhookEndpoints.retrieve(sandboxWebhookId);
    if (endpoint.id !== sandboxWebhookId || endpoint.livemode !== false || endpoint.status !== "disabled") {
      throw new Error("Sandbox endpoint must be disabled by the Owner");
    }
    const destinations = await stripe.webhookEndpoints.list({ limit: 100 });
    if (destinations.has_more || destinations.data.some(destination => destination.status !== "disabled")) {
      throw new Error("Sandbox webhook delivery is not isolated");
    }
  };
  const transport = async (url, options) => {
    if (new URL(url).origin !== "https://api.stripe.com") throw new Error("Unexpected Stripe host");
    if (options.method === "POST") {
      await checkEndpoint();
      await retrieve(subscriptionId);
    }
    return fetch(url, options);
  };
  await retrieve(subscriptionId);
  const actions = pauseActions({ key, localId, subscriptionId, transport, checkEndpoint, retrieve });
  const { server, events, periods, payments } = receiver({ stripe, secret, subscriptionId, retrieve });
  server.on("request", (_request, response) => response.on("finish", () => {
    console.log(JSON.stringify({ httpStatus: response.statusCode, events: events.size,
      periodSyncs: periods.length, paymentStatus: payments.at(-1)?.p_stripe_status ?? null }));
  }));
  console.log(await start(server, 4242));
  console.log("Local console commands: pause, resume, quit");
  const input = createInterface({ input: process.stdin });
  try {
    for await (const line of input) {
      const action = line.trim();
      if (action === "quit") break;
      if (action !== "pause" && action !== "resume") continue;
      try {
        const response = await actions.request(action);
        const result = await response.json();
        console.log(JSON.stringify({ action, httpStatus: response.status, state: result.state ?? "blocked",
          reason: result.reason ?? null, pauseWindows: actions.windows.size }));
      } catch {
        console.log(JSON.stringify({ action, state: "blocked", reason: "isolation_or_adapter_unconfirmed" }));
      }
    }
  } finally {
    input.close();
    await new Promise(resolve => server.close(resolve));
  }
} else if (process.argv[2] === "--check-actions") {
  await checkPauseActions();
} else {
  assert.equal(process.argv.length, 2);
  const stripe = new Stripe("sk_test_gloa_fixture");
  const secret = "whsec_gloa_fixture";
  const subscriptionId = "sub_gloa_fixture";
  let retrieved = 0;
  let stripeStatus = "paused";
  const { server, events, periods, payments, errors } = receiver({ stripe, secret, subscriptionId, async retrieve(id) {
    assert.equal(id, subscriptionId);
    retrieved++;
    return { id, livemode: false, status: stripeStatus, items: { data: [] } };
  } });
  const url = await start(server);
  try {
    const raw = JSON.stringify({ id: "evt_gloa_fixture", livemode: false, type: "customer.subscription.paused",
      data: { object: { id: subscriptionId, livemode: false } } });
    const signature = stripe.webhooks.generateTestHeaderString({ payload: raw, secret });
    const send = (body, header) => fetch(url, { method: "POST", headers: { "stripe-signature": header }, body });
    assert.equal((await send(raw + " ", signature)).status, 400);
    const live = raw.replace('"livemode":false', '"livemode":true');
    assert.equal((await send(live, stripe.webhooks.generateTestHeaderString({ payload: live, secret }))).status, 403);
    assert.equal((await send(raw, signature)).status, 200, JSON.stringify(errors));
    assert.equal((await send(raw, signature)).status, 200);
    assert.equal(retrieved, 1);
    assert.equal(events.size, 1);
    assert.equal(periods.length, 1);
    stripeStatus = "active";
    const resumed = raw.replace("evt_gloa_fixture", "evt_gloa_resume").replace("subscription.paused", "subscription.resumed");
    assert.equal((await send(resumed, stripe.webhooks.generateTestHeaderString({ payload: resumed, secret }))).status,
      200, JSON.stringify(errors));
    const delayed = raw.replace("evt_gloa_fixture", "evt_gloa_delayed");
    assert.equal((await send(delayed, stripe.webhooks.generateTestHeaderString({ payload: delayed, secret }))).status,
      200, JSON.stringify(errors));
    assert.deepEqual(payments.map(args => args.p_stripe_status), ["active", "active"]);
    assert.equal(events.size, 3);
    console.log("LOOPBACK_LIFECYCLE_PREFLIGHT_PASS");
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

}

async function checkPauseActions() {
  const localId = randomUUID();
  const subscriptionId = "sub_gloa_fixture";
  const scheduleId = "sub_sched_fixture";
  const periodEnd = Math.floor(Date.now() / 1000) + 3600;
  let status = "active";
  let schedule;
  let posts = 0;
  let canSend = false;
  let fail = false;
  let beforeWrite = async () => {};
  const subscription = () => ({
    id: subscriptionId, status, livemode: false, schedule: schedule ? scheduleId : null,
    collection_method: "charge_automatically", billing_mode: { type: "flexible" },
    metadata: { gloa_subscription_id: localId, gloa_test_fixture: "pause-loopback" },
    items: { has_more: false, data: [{ current_period_end: periodEnd,
      price: { recurring: { interval: "week", interval_count: 4, usage_type: "licensed" } } }] },
  });
  const checkEndpoint = async () => { if (!canSend) throw new Error("Endpoint active"); };
  const transport = async (url, options) => {
    const { pathname } = new URL(url);
    if (options.method === "POST") {
      posts++;
      await beforeWrite();
      if (fail) throw new Error("Unknown provider outcome");
      const pause = { pause_at: periodEnd, status: { type: status === "paused" ? "succeeded" : "scheduled" } };
      schedule = { id: scheduleId, subscription: subscriptionId, livemode: false, status: "active",
        billing_mode: { type: "flexible" }, pause_schedules: [{ key: "fixture", pause }] };
      if (status === "paused") schedule.pause_schedules[0].resume = { status: { type: "pending" } };
      return Response.json(schedule);
    }
    if (pathname === "/v1/account") return Response.json({ object: "account", id: accountId });
    if (pathname === "/v1/subscriptions/" + subscriptionId) return Response.json(subscription());
    if (pathname === "/v1/subscription_schedules/" + scheduleId) return Response.json(schedule);
    assert.equal(pathname, "/v1/invoices");
    return Response.json({ has_more: false, data: [] });
  };
  const actions = pauseActions({ key: "sk_test_fixture", localId, subscriptionId,
    transport, checkEndpoint, retrieve: async () => subscription() });
  assert.equal((await actions.request("pause", localId, false)).status, 401);
  assert.equal((await actions.request("pause", randomUUID())).status, 404);
  await assert.rejects(actions.request("pause"), /Endpoint active/);
  assert.equal(posts, 0);
  canSend = true;
  const scheduled = await actions.request("pause");
  assert.equal(scheduled.status, 202);
  assert.equal((await scheduled.json()).state, "scheduled");
  assert.equal(actions.windows.size, 1);
  assert.equal((await actions.request("pause")).status, 409);
  assert.equal(posts, 1);

  status = "paused";
  schedule.pause_schedules[0].pause.status.type = "succeeded";
  let unblock;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  beforeWrite = () => new Promise(resolve => { unblock = resolve; entered(); });
  const pending = actions.request("resume");
  await started;
  const concurrent = await actions.request("resume");
  assert.equal(concurrent.status, 409);
  assert.equal((await concurrent.json()).reason, "inspection_required");
  unblock();
  const resumed = await pending;
  assert.equal(resumed.status, 202);
  assert.equal((await resumed.json()).state, "resume_requested");
  assert.equal((await actions.request("resume")).status, 409);
  assert.equal(posts, 2);

  status = "active";
  schedule = undefined;
  beforeWrite = async () => {};
  fail = true;
  const unknown = await actions.request("pause");
  assert.equal(unknown.status, 503);
  assert.equal((await unknown.json()).state, "unconfirmed");
  assert.equal((await actions.request("pause")).status, 409);
  assert.equal(posts, 3);
  console.log("LOOPBACK_PAUSE_ACTIONS_PREFLIGHT_PASS");
}
