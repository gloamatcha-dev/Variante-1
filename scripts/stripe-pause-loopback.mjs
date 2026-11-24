import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import vm from "node:vm";
import Stripe from "stripe";
import ts from "typescript";

const accountId = "acct_1U6B3cDASU5R3UGE";
const path = "/api/stripe/webhook";
const lifecycle = new Set([
  "customer.subscription.updated", "customer.subscription.paused", "customer.subscription.resumed",
]);

function load(relativePath, deps, env = {}, errors = () => {}) {
  const module = { exports: {} };
  const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    module, exports: module.exports, Response, URL, Date, console: { error: errors },
    process: { env },
    require(name) { return deps[name.split("/").at(-1)] ?? {}; },
  });
  return module.exports;
}

function receiver({ stripe, secret, subscriptionId, retrieve }) {
  const errors = [];
  const events = new Set();
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
      assert.equal(args.p_stripe_subscription_id, subscriptionId);
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
          event.data.object.id !== subscriptionId || (event.account && event.account !== accountId)) {
        return response.writeHead(403).end();
      }
      if (!lifecycle.has(event.type)) return response.writeHead(422).end();
      const result = await route.POST(new Request("http://127.0.0.1" + path, {
        method: "POST", headers: { "stripe-signature": signature }, body: raw,
      }));
      response.writeHead(result.status).end();
    } catch {
      response.writeHead(500).end();
    }
  });
  return { server, events, periods, payments, errors };
}

async function start(server, port = 0) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return "http://127.0.0.1:" + server.address().port + path;
}

if (process.argv[2] === "--listen") {
  const { GLOA_TEST_STRIPE_KEY: key, GLOA_TEST_WEBHOOK_SECRET: secret, GLOA_TEST_SUBSCRIPTION_ID: subscriptionId } = process.env;
  if (!/^(?:sk|rk)_test_[a-zA-Z0-9_]+$/.test(key ?? "") || !/^whsec_[a-zA-Z0-9]+$/.test(secret ?? "") ||
      !/^sub_[a-zA-Z0-9_]+$/.test(subscriptionId ?? "")) throw new Error("Isolated test credentials and subscription required");
  const stripe = new Stripe(key, { maxNetworkRetries: 0, timeout: 8000 });
  const account = await stripe.accounts.retrieve();
  if (account.id !== accountId) throw new Error("Wrong Stripe sandbox");
  const retrieve = async id => {
    if (id !== subscriptionId) throw new Error("Unexpected subscription");
    const subscription = await stripe.subscriptions.retrieve(id);
    if (subscription.id !== subscriptionId || subscription.livemode !== false) throw new Error("Unexpected Stripe response");
    return subscription;
  };
  await retrieve(subscriptionId);
  const { server, events, periods, payments } = receiver({ stripe, secret, subscriptionId, retrieve });
  server.on("request", (_request, response) => response.on("finish", () => {
    console.log(JSON.stringify({ httpStatus: response.statusCode, events: events.size,
      periodSyncs: periods.length, paymentStatus: payments.at(-1)?.p_stripe_status ?? null }));
  }));
  console.log(await start(server, 4242));
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
