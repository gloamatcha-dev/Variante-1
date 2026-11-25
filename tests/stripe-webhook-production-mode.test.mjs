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
  const deps = {
    stripe: { getStripeClient: () => stripe },
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

  const send = async (id, livemode, signingSecret = secret) => {
    const payload = JSON.stringify({ id, livemode, type: "customer.created", data: { object: {} } });
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
});
