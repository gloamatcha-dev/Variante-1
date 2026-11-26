import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import Stripe from "stripe";
import ts from "typescript";

test("production rejects correctly signed sandbox events before persistence and accepts signed live events", async () => {
  const stripe = new Stripe("sk_test_local_fixture");
  const secret = "whsec_local_fixture";
  const lookups = [];
  const writes = [];
  let pauseKey = null;
  let context = false;
  let sync = "error";
  const deps = {
    stripe: { getStripeClient: () => ({
      webhooks: stripe.webhooks, subscriptions: { retrieve: async id => ({ id, livemode: true }) },
    }) },
    "subscriptionPauseActions.server": { livePauseKey: () => pauseKey, hasLivePauseHistory: id => id === "sub_fixture" },
    "stripePauseScheduleSandbox.server": {
      GLOA_LIVE_PAUSE_ACCOUNT: "acct_1U6B3ODI76FH9qsq",
      createStripePauseScheduleLive: () => ({ verifyContext: async () => context }),
    },
    subscriptionCancellation: { syncSubscriptionFromStripe: async () => sync },
    subscriptionPaymentStatus: { reconcileSubscriptionPaymentStatus: async () => "unchanged" },
    stripeRefunds: { isRefundEventType: () => false },
    stripeWebhookEvents: {
      async hasStripeWebhookEventBeenProcessed(id) { lookups.push(id); return false; },
      async recordStripeWebhookEvent(id) { writes.push(id); return { ok: true }; },
    },
  };
  const source = readFileSync(new URL("../app/api/stripe/webhook/route.ts", import.meta.url), "utf8");
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    module, exports: module.exports, Response, URL, console: { error() {} },
    process: { env: { STRIPE_WEBHOOK_SECRET: secret, VERCEL_ENV: "production" } },
    require(name) { return deps[name.split("/").at(-1)] ?? {}; },
  });

  const send = async (id, livemode, signingSecret = secret, type = "customer.created", account) => {
    const payload = JSON.stringify({ id, livemode, type, account, data: { object: { id: "sub_fixture", livemode } } });
    const signature = stripe.webhooks.generateTestHeaderString({ payload, secret: signingSecret });
    return module.exports.POST(new Request("http://127.0.0.1/api/stripe/webhook", {
      method: "POST", body: payload, headers: { "stripe-signature": signature },
    }));
  };

  assert.equal((await send("evt_test_fixture", false)).status, 403);
  assert.equal((await send("evt_wrong_secret", true, "whsec_wrong_fixture")).status, 400);
  assert.deepEqual(lookups, []);
  assert.deepEqual(writes, []);
  assert.equal((await send("evt_live_fixture", true)).status, 200);
  assert.deepEqual(lookups, ["evt_live_fixture"]);
  assert.deepEqual(writes, ["evt_live_fixture"]);

  const resumed = (id, account) => send(id, true, secret, "customer.subscription.resumed", account);
  assert.equal((await resumed("evt_foreign", "acct_other")).status, 403);
  assert.equal((await resumed("evt_unconfigured")).status, 503);
  pauseKey = "rk_live_fixture";
  assert.equal((await resumed("evt_context_missing")).status, 503);
  assert.deepEqual(lookups, ["evt_live_fixture"]);

  context = true;
  assert.equal((await resumed("evt_resume_retry")).status, 500);
  assert.deepEqual(writes, ["evt_live_fixture"]);
  sync = "synced";
  assert.equal((await resumed("evt_resume_retry")).status, 200);
  assert.deepEqual(writes, ["evt_live_fixture", "evt_resume_retry"]);
});
