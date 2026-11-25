import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Stripe from "stripe";
import { matchesCycleInvoice, reserveResumeWindow, restoreResumeWebhook } from "../scripts/stripe-resume-only-owner.mjs";
import { receiver, start } from "../scripts/stripe-pause-loopback.mjs";

test("resume preview requires a full new cycle, original prices and no adjustment", () => {
  const anchor = 1797984501;
  const subscription = { id: "sub_fixture", customer: "cus_fixture", items: { has_more: false,
    data: [590, 1999].map(amount => ({ quantity: 1, price: { id: "price_" + amount, currency: "eur",
      unit_amount: amount, recurring: { interval: "week", interval_count: 4, usage_type: "licensed" } } })),
  } };
  const invoice = { livemode: false, currency: "eur", customer: subscription.customer,
    parent: { subscription_details: { subscription: subscription.id } },
    subtotal: 2589, total: 2589, amount_due: 2589, starting_balance: 0,
    lines: { has_more: false, data: subscription.items.data.map(({ price }) => ({
      quantity: 1, amount: price.unit_amount, pricing: { price_details: { price: price.id } },
      parent: { subscription_item_details: { subscription: subscription.id, proration: false } },
      period: { start: anchor, end: anchor + 28 * 86400 },
    })) },
  };
  assert.equal(matchesCycleInvoice(invoice, subscription, anchor), true);
  for (const mutate of [
    value => value.lines.data[0].period.start--,
    value => { value.lines.data[0].parent.subscription_item_details.proration = true; },
    value => { value.starting_balance = 1; },
    value => { value.amount_due += 100; },
    value => { value.lines.has_more = true; },
    value => { value.lines.data.push(value.lines.data[0]); },
    value => { value.parent.subscription_details.subscription = "sub_other"; },
  ]) {
    const changed = structuredClone(invoice);
    mutate(changed);
    assert.equal(matchesCycleInvoice(changed, subscription, anchor), false);
  }
});

test("resume marker is exclusive and leaves the initial run marker intact", () => {
  const profile = mkdtempSync(join(tmpdir(), "gloa-resume-only-"));
  const original = join(profile, "gloa-pause-owner-window.started");
  try {
    writeFileSync(original, "first test untouched", { flag: "wx" });
    reserveResumeWindow(profile);
    assert.throws(() => reserveResumeWindow(profile), { code: "EEXIST" });
    assert.equal(readFileSync(original, "utf8"), "first test untouched");
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
});

test("restore changes only the known endpoint status and verifies its full readback", async () => {
  const id = "we_1U6GTJDASU5R3UGE7b0tAd9l";
  const endpoint = { id, livemode: false, status: "disabled", api_version: "2026-07-29.dahlia",
    url: "https://variante-1-cyan.vercel.app/api/stripe/webhook",
    enabled_events: ["checkout.session.completed", "charge.refunded", "charge.refund.updated",
      "refund.created", "refund.updated", "refund.failed"] };
  let changes = 0;
  const stripe = {
    accounts: { retrieve: async () => ({ id: "acct_1U6B3cDASU5R3UGE" }) },
    webhookEndpoints: {
      retrieve: async target => { assert.equal(target, id); return { ...endpoint }; },
      update: async (target, body) => {
        assert.equal(target, id);
        assert.deepEqual(body, { disabled: false });
        changes++;
        endpoint.status = "enabled";
      },
    },
  };
  assert.equal(await restoreResumeWebhook(stripe), true);
  assert.equal(await restoreResumeWebhook(stripe), true);
  assert.equal(changes, 1);
  endpoint.enabled_events = ["charge.refunded"];
  await assert.rejects(restoreResumeWebhook(stripe));
  assert.equal(changes, 1);
});

test("loopback reports a paid invoice only after signature, test mode and subscription match", async () => {
  const stripe = new Stripe("sk_test_fixture");
  const secret = "whsec_fixture";
  const subscriptionId = "sub_fixture";
  const received = [];
  const { server } = receiver({ stripe, secret, subscriptionId, onPaidInvoice: id => received.push(id),
    retrieve: async () => assert.fail("Invoice must stay isolated") });
  const url = await start(server);
  const body = JSON.stringify({ type: "invoice.paid", livemode: false, data: { object: {
    id: "in_fixture", livemode: false, parent: { subscription_details: { subscription: subscriptionId } },
  } } });
  const sign = payload => stripe.webhooks.generateTestHeaderString({ payload, secret });
  const send = (payload, signature) => fetch(url, { method: "POST", body: payload, headers: { "stripe-signature": signature } });
  try {
    assert.equal((await send(body + " ", sign(body))).status, 400);
    const foreign = body.replace("sub_fixture", "sub_other");
    assert.equal((await send(foreign, sign(foreign))).status, 403);
    assert.equal((await send(body, sign(body))).status, 200);
    assert.deepEqual(received, ["in_fixture"]);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
