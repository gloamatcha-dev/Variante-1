import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import Stripe from "stripe";
import { pauseActions, receiver, start } from "./stripe-pause-loopback.mjs";

const accountId = "acct_1U6B3cDASU5R3UGE";
const endpointId = "we_1U6GTJDASU5R3UGE7b0tAd9l";
const endpointUrl = "https://variante-1-cyan.vercel.app/api/stripe/webhook";
const endpointEvents = [
  "checkout.session.completed", "charge.refunded", "charge.refund.updated",
  "refund.created", "refund.updated", "refund.failed",
].sort();
const forwardedEvents = [
  "customer.subscription.updated", "customer.subscription.paused", "customer.subscription.resumed",
].join(",");
const key = process.env.GLOA_TEST_STRIPE_KEY;
delete process.env.GLOA_TEST_STRIPE_KEY;
const uuid = randomUUID();
const result = { test: "BLOCKED", pause: false, resume: false, signed: false, localSync: false, webhookRestored: false };
let stage = "credentials";
let mustRestore = false;
let server;
let listener;
let interrupted = false;

const interrupt = () => { interrupted = true; };
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);
const requireFact = condition => { if (!condition) throw new Error("Unconfirmed test prerequisite"); };
const sameEndpoint = (endpoint, status) => endpoint.id === endpointId && endpoint.livemode === false &&
  endpoint.status === status && endpoint.url === endpointUrl && endpoint.api_version === "2026-07-29.dahlia" &&
  JSON.stringify([...endpoint.enabled_events].sort()) === JSON.stringify(endpointEvents);

async function waitFor(check, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    requireFact(!interrupted);
    const found = await check();
    if (found) return found;
    await sleep(750);
  }
  throw new Error("Test timeout");
}

try {
  requireFact(process.env.VERCEL_ENV !== "production" && /^(sk|rk)_test_[a-zA-Z0-9_]+$/.test(key ?? ""));
  requireFact(process.env.GLOA_TEST_QUIET_WINDOW === "YES" && process.env.XDG_CONFIG_HOME && process.env.GLOA_TEST_STRIPE_CLI);
  const stripe = new Stripe(key, { apiVersion: "2026-09-30.endive", timeout: 8000, maxNetworkRetries: 0 });
  const checkAccount = async () => requireFact((await stripe.accounts.retrieve()).id === accountId);
  const checkDestinations = async status => {
    const endpoints = await stripe.webhookEndpoints.list({ limit: 100 });
    requireFact(!endpoints.has_more &&
      endpoints.data.some(endpoint => sameEndpoint(endpoint, status)) &&
      endpoints.data.every(endpoint => endpoint.id === endpointId || endpoint.status === "disabled"));
  };
  const readEndpoint = () => stripe.webhookEndpoints.retrieve(endpointId);
  const verifyWrite = async () => {
    requireFact(!interrupted && listener?.exitCode === null && !listener?.signalCode && server?.listening);
    await checkAccount();
    await checkDestinations("disabled");
    requireFact(!interrupted && listener.exitCode === null && !listener.signalCode && server.listening);
  };
  let subscriptionId;
  const retrieve = async id => {
    requireFact(subscriptionId && id === subscriptionId);
    const subscription = await stripe.subscriptions.retrieve(id);
    requireFact(subscription.id === id && subscription.livemode === false &&
      subscription.metadata.gloa_test_fixture === "pause-loopback" && subscription.metadata.gloa_subscription_id === uuid);
    return subscription;
  };

  try {
    stage = "sandbox_account_and_webhook";
    await checkAccount();
    requireFact(sameEndpoint(await readEndpoint(), "enabled"));
    await checkDestinations("enabled");
    result.webhookRestored = true;

    stage = "existing_prices";
    const candidatePrices = await stripe.prices.list({ active: true, currency: "eur", type: "recurring", limit: 100 });
    requireFact(!candidatePrices.has_more);
    const prices = [1999, 590].map(amount => {
      const candidates = candidatePrices.data.filter(price => price.livemode === false && price.unit_amount === amount &&
        price.recurring?.interval === "week" && price.recurring?.interval_count === 4 && price.recurring?.usage_type === "licensed");
      requireFact(candidates.length === 1);
      return candidates[0];
    });

    stage = "listener_and_loopback";
    const env = { ...process.env, STRIPE_API_KEY: key };
    listener = spawn(process.env.GLOA_TEST_STRIPE_CLI, [
      "listen", "--events", forwardedEvents, "--forward-to", "http://127.0.0.1:4242/api/stripe/webhook",
    ], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let listenerError = false;
    let secret;
    let ready = false;
    listener.on("error", () => { listenerError = true; });
    for (const output of [listener.stdout, listener.stderr]) {
      let buffer = "";
      output.setEncoding("utf8");
      output.on("data", chunk => {
        if (ready && secret) return;
        buffer = (buffer + chunk).slice(-8192);
        if (/Ready!/i.test(buffer)) ready = true;
        secret ??= buffer.match(/\bwhsec_[A-Za-z0-9]+(?=[\s)])/u)?.[0];
        if (secret) buffer = "";
      });
    }
    await waitFor(() => {
      requireFact(!listenerError && listener.exitCode === null && !listener.signalCode);
      return ready && secret;
    }, 20000);
    const local = receiver({ stripe, secret, getSubscriptionId: () => subscriptionId, retrieve });
    server = local.server;
    const url = await start(server, 4242);
    const raw = '{"id":"evt_local_preflight","livemode":false,"data":{"object":{"id":"sub_never_bound","livemode":false}}}';
    const signature = stripe.webhooks.generateTestHeaderString({ payload: raw, secret });
    requireFact((await fetch(url, { method: "POST", body: raw, headers: { "stripe-signature": signature } })).status === 403);
    requireFact(local.events.size === 0 && local.periods.length === 0);

    stage = "disable_sandbox_webhook";
    requireFact(!interrupted && listener.exitCode === null && server.listening);
    await checkAccount();
    await checkDestinations("enabled");
    console.log("Before any interruption: in GLOA Matcha Sandbox, verify webhook " + endpointId +
      " is enabled and matches docs/stripe-pause-sandbox-window.md. Re-enable it manually if needed.");
    mustRestore = true;
    result.webhookRestored = false;
    requireFact(sameEndpoint(await stripe.webhookEndpoints.update(endpointId, { disabled: true }), "disabled"));
    result.test = "FAIL";

    stage = "create_one_synthetic_subscription";
    await verifyWrite();
    const clock = await stripe.testHelpers.testClocks.create({
      frozen_time: Math.floor(Date.now() / 1000), name: "GLOA pause-loopback",
    }, { idempotencyKey: uuid + "/clock" });
    requireFact(clock.livemode === false && clock.status === "ready");
    await verifyWrite();
    const customer = await stripe.customers.create({
      test_clock: clock.id, name: "GLOA synthetic pause-loopback", metadata: { gloa_test_fixture: "pause-loopback" },
    }, { idempotencyKey: uuid + "/customer" });
    requireFact(customer.livemode === false && customer.test_clock === clock.id);
    await verifyWrite();
    const paymentMethod = await stripe.paymentMethods.attach("pm_card_visa", { customer: customer.id },
      { idempotencyKey: uuid + "/payment-method" });
    requireFact(paymentMethod.livemode === false && paymentMethod.customer === customer.id);
    await verifyWrite();
    const created = await stripe.subscriptions.create({
      customer: customer.id, items: prices.map(price => ({ price: price.id })),
      billing_mode: { type: "flexible" }, default_payment_method: paymentMethod.id,
      payment_behavior: "error_if_incomplete",
      metadata: { gloa_test_fixture: "pause-loopback", gloa_subscription_id: uuid },
    }, { idempotencyKey: uuid + "/subscription" });
    requireFact(created.livemode === false && created.customer === customer.id && created.test_clock === clock.id &&
      created.status === "active" && created.billing_mode?.type === "flexible");
    subscriptionId = created.id;

    const actions = pauseActions({ key, localId: uuid, subscriptionId, checkEndpoint: verifyWrite, retrieve,
      transport: async (target, options) => {
        requireFact(new URL(target).origin === "https://api.stripe.com");
        if (options.method === "POST") { await verifyWrite(); await retrieve(subscriptionId); }
        return fetch(target, options);
      },
    });

    stage = "pause";
    const pauseResponse = await actions.request("pause");
    const pause = await pauseResponse.json();
    requireFact(pauseResponse.status === 202 && pause.state === "scheduled" &&
      Number.isSafeInteger(pause.pauseAt) && pause.pauseAt > clock.frozen_time && actions.windows.size === 1);
    await verifyWrite();
    await stripe.testHelpers.testClocks.advance(clock.id, { frozen_time: pause.pauseAt }, { idempotencyKey: uuid + "/advance" });
    await waitFor(async () => (await stripe.testHelpers.testClocks.retrieve(clock.id)).status === "ready");
    await waitFor(async () => (await retrieve(subscriptionId)).status === "paused");
    result.pause = true;
    await waitFor(() => local.verifiedTypes.has("customer.subscription.paused"));

    stage = "resume";
    const pausedPeriodWrites = local.periods.length;
    const resumeResponse = await actions.request("resume");
    requireFact(resumeResponse.status === 202 && (await resumeResponse.json()).state === "resume_requested");
    await waitFor(async () => (await retrieve(subscriptionId)).status === "active");
    result.resume = true;
    await waitFor(() => local.verifiedTypes.has("customer.subscription.resumed"));
    result.signed = true;
    const active = await retrieve(subscriptionId);
    const reconciled = local.periods.at(-1);
    result.localSync = local.periods.length > pausedPeriodWrites &&
      reconciled?.p_stripe_subscription_id === subscriptionId &&
      reconciled.p_current_period_end === new Date(active.items.data[0].current_period_end * 1000).toISOString() &&
      local.payments.at(-1)?.p_stripe_status === "active";
    requireFact(result.localSync);
    result.test = "PASS";
  } finally {
    if (mustRestore) {
      try {
        await checkAccount();
        const endpoint = await readEndpoint();
        requireFact(sameEndpoint(endpoint, "disabled") || sameEndpoint(endpoint, "enabled"));
        if (endpoint.status === "disabled") await stripe.webhookEndpoints.update(endpointId, { disabled: false });
        result.webhookRestored = sameEndpoint(await readEndpoint(), "enabled");
      } catch {
        result.webhookRestored = false;
      }
    }
  }
} catch {
  console.error("Test stopped at " + stage);
} finally {
  listener?.kill();
  if (server?.listening) await new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  });
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", interrupt);
}
if (!result.webhookRestored && mustRestore) {
  result.test = "FAIL";
  console.error("CRITICAL: In GLOA Matcha Sandbox, re-enable webhook " + endpointId +
    " and verify URL, API version and all six events against docs/stripe-pause-sandbox-window.md.");
}
console.log(JSON.stringify({ ...result, productionUnchanged: true }));
if (result.test !== "PASS") process.exitCode = 1;
