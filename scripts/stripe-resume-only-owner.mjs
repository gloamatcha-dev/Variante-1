import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import Stripe from "stripe";
import { load, pauseActions, receiver, start } from "./stripe-pause-loopback.mjs";

const accountId = "acct_1U6B3cDASU5R3UGE";
const subscriptionId = "sub_1UfTk9DASU5R3UGEJW1VR8Ui";
const scheduleId = "sub_sched_1UfTkFDASU5R3UGEgGPbzpx8";
const clockId = "clock_1UfTk6DASU5R3UGE68Mq7u6s";
const endpointId = "we_1U6GTJDASU5R3UGE7b0tAd9l";
const endpointEvents = ["checkout.session.completed", "charge.refunded", "charge.refund.updated",
  "refund.created", "refund.updated", "refund.failed"].sort();
const boundary = 1797984441;
const cycleSeconds = 28 * 86400;
const nextAnchor = boundary + 60;
const endpointUrl = "https://variante-1-cyan.vercel.app/api/stripe/webhook";
const marker = "gloa-pause-resume-only.started";
const pricesTotal = 2589;
const originalPriceAmount = [590, 1999];
const ref = value => typeof value === "string" ? value : value?.id;
const requireFact = condition => { if (!condition) throw new Error("Unconfirmed resume prerequisite"); };

export function matchesCycleInvoice(invoice, subscription, anchor) {
  const items = subscription.items;
  if (items?.has_more !== false || items.data?.length !== 2 ||
      invoice.livemode !== false || invoice.currency !== "eur" ||
      ref(invoice.customer) !== ref(subscription.customer) ||
      ref(invoice.parent?.subscription_details?.subscription) !== subscription.id ||
      invoice.subtotal !== pricesTotal || invoice.total !== pricesTotal || invoice.amount_due !== pricesTotal ||
      invoice.starting_balance !== 0 || (invoice.ending_balance != null && invoice.ending_balance !== 0) ||
      invoice.lines?.has_more !== false || invoice.lines.data?.length !== 2) return false;
  const amounts = items.data.map(item => item.price?.unit_amount).sort((a,b) => a-b);
  if (amounts.some((amount, index) => amount !== originalPriceAmount[index])) return false;
  return items.data.every(item => item.quantity === 1 && item.price?.currency === "eur" &&
    item.price.recurring?.interval === "week" && item.price.recurring?.interval_count === 4 &&
    item.price.recurring?.usage_type === "licensed" &&
    invoice.lines.data.filter(line => ref(line.pricing?.price_details?.price) === item.price.id &&
      ref(line.parent?.subscription_item_details?.subscription) === subscription.id &&
      line.parent?.subscription_item_details?.proration === false &&
      line.quantity === 1 && line.amount === item.price.unit_amount &&
      line.period?.start === anchor && line.period?.end === anchor + cycleSeconds).length === 1);
}

export function reserveResumeWindow(profile) {
  mkdirSync(profile, { recursive: true });
  writeFileSync(join(profile, marker), "GLOA resume-only window started\n", { flag: "wx" });
}

const sameEndpoint = (endpoint, status) => endpoint.id === endpointId && endpoint.livemode === false &&
    endpoint.status === status && endpoint.url === endpointUrl && endpoint.api_version === "2026-07-29.dahlia" &&
    JSON.stringify([...endpoint.enabled_events].sort()) === JSON.stringify(endpointEvents);

export async function restoreResumeWebhook(stripe) {
  const account = await stripe.accounts.retrieve();
  requireFact(account.id === accountId);
  const current = await stripe.webhookEndpoints.retrieve(endpointId);
  requireFact(sameEndpoint(current, "disabled") || sameEndpoint(current, "enabled"));
  if (current.status === "disabled") await stripe.webhookEndpoints.update(endpointId, { disabled: false });
  return sameEndpoint(await stripe.webhookEndpoints.retrieve(endpointId), "enabled");
}

async function run() {
  const key = process.env.GLOA_TEST_STRIPE_KEY;
  delete process.env.GLOA_TEST_STRIPE_KEY;
  const profile = join(process.env.LOCALAPPDATA ?? "", "GLOA-Stripe-CLI-Sandbox");
  const result = { test: "BLOCKED", preview: false, resumed: false, signed: false, paidCycle: false, webhookRestored: false };
  let listener, server, mustRestore = false, interrupted = false, stage = "credentials";
  const stop = () => { interrupted = true; };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  async function waitFor(check, ms = 60000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      requireFact(!interrupted);
      const value = await check();
      if (value) return value;
      await sleep(750);
    }
    throw new Error("Resume test timeout");
  }
  try {
    requireFact(/^(?:sk|rk)_test_[a-zA-Z0-9_]+$/.test(key ?? "") && process.env.VERCEL_ENV !== "production" &&
      process.env.GLOA_TEST_QUIET_WINDOW === "YES" && process.env.GLOA_TEST_STRIPE_CLI && isAbsolute(process.env.LOCALAPPDATA ?? ""));
    const stripe = new Stripe(key, { apiVersion: "2026-09-30.endive", timeout: 8000, maxNetworkRetries: 0 });
    const checkAccount = async () => requireFact((await stripe.accounts.retrieve()).id === accountId);
    const endpoint = () => stripe.webhookEndpoints.retrieve(endpointId);
    const checkDestinations = async status => {
      const endpoints = await stripe.webhookEndpoints.list({ limit: 100 });
      requireFact(!endpoints.has_more && endpoints.data.some(item => sameEndpoint(item, status)) &&
        endpoints.data.every(item => item.id === endpointId || item.status === "disabled"));
    };
    const healthy = () => !interrupted && listener?.exitCode === null && !listener.signalCode && server?.listening;
    const checkWrite = async () => {
      requireFact(healthy());
      await checkAccount();
      await checkDestinations("disabled");
      requireFact(healthy());
    };

    try {
      stage = "prove_existing_pause";
      await checkAccount();
      requireFact(sameEndpoint(await endpoint(), "enabled"));
      await checkDestinations("enabled");
      result.webhookRestored = true;
      const initial = await stripe.subscriptions.retrieve(subscriptionId);
      const localId = initial.metadata?.gloa_subscription_id;
      const retrieve = async id => {
        requireFact(id === subscriptionId);
        const sub = await stripe.subscriptions.retrieve(id);
        requireFact(sub.id === subscriptionId && sub.livemode === false && sub.metadata?.gloa_test_fixture === "pause-loopback" &&
          sub.metadata?.gloa_subscription_id === localId && ref(sub.test_clock) === clockId &&
          ref(sub.customer) === ref(initial.customer));
        return sub;
      };
      const verifyPause = sub => requireFact(sub.status === "paused" && sub.schedule === null &&
        sub.status_details?.paused?.transitioned_at === boundary &&
        sub.status_details?.paused?.subscription?.type === "pause_requested" && !sub.pending_update);
      requireFact(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(localId ?? ""));
      verifyPause(await retrieve(subscriptionId));
      const [scheduledEvent, pausedEvent, released, clock] = await Promise.all([
        stripe.events.retrieve("evt_1UfTkFDASU5R3UGEF8zuuKkh"), stripe.events.retrieve("evt_1UfTkKDASU5R3UGE5kq567UH"),
        stripe.subscriptionSchedules.retrieve(scheduleId), stripe.testHelpers.testClocks.retrieve(clockId),
      ]);
      requireFact(scheduledEvent.livemode === false && scheduledEvent.type === "subscription_schedule.created" &&
        scheduledEvent.data.object.id === scheduleId && ref(scheduledEvent.data.object.subscription) === subscriptionId &&
        ref(scheduledEvent.data.object.test_clock) === clockId &&
        /^gloa-pause-sandbox:pause:[0-9a-f-]{36}$/.test(scheduledEvent.request?.idempotency_key ?? "") &&
        pausedEvent.livemode === false && pausedEvent.type === "customer.subscription.paused" &&
        pausedEvent.data.object.id === subscriptionId && pausedEvent.data.object.status_details?.paused?.transitioned_at === boundary &&
        released.livemode === false && released.status === "released" && released.released_at === boundary &&
        released.released_subscription === subscriptionId && released.subscription === null &&
        released.pause_schedules?.length === 1 && released.pause_schedules[0].pause?.status?.type === "succeeded" &&
        released.pause_schedules[0].pause?.pause_at === boundary && !released.pause_schedules[0].resume &&
        clock.livemode === false && clock.status === "ready" && clock.frozen_time === boundary);
      const recoveredPause = { schedule_id: scheduleId, pause_at: new Date(boundary * 1000).toISOString() };

      stage = "listener_and_loopback";
      listener = spawn(process.env.GLOA_TEST_STRIPE_CLI, ["listen", "--events",
        "customer.subscription.updated,customer.subscription.paused,customer.subscription.resumed,invoice.paid",
        "--forward-to", "http://127.0.0.1:4242/api/stripe/webhook"], {
        env: { ...process.env, XDG_CONFIG_HOME: profile, STRIPE_API_KEY: key },
        windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      });
      let secret, ready = false, failed = false;
      listener.on("error", () => { failed = true; });
      for (const pipe of [listener.stdout, listener.stderr]) {
        let output = "";
        pipe.setEncoding("utf8").on("data", chunk => {
          if (ready && secret) return;
          output = (output + chunk).slice(-8192);
          ready ||= /Ready!/i.test(output);
          secret ??= output.match(/\bwhsec_[A-Za-z0-9]+(?=[\s)])/u)?.[0];
        });
      }
      await waitFor(() => {
        requireFact(!failed && listener.exitCode === null && !listener.signalCode);
        return secret && ready;
      }, 20000);
      const paidEvents = new Set();
      const local = receiver({ stripe, secret, subscriptionId, retrieve, onPaidInvoice: id => paidEvents.add(id) });
      server = local.server;
      await start(server, 4242);

      stage = "isolate_and_advance_clock";
      await checkAccount();
      await checkDestinations("enabled");
      requireFact(healthy());
      reserveResumeWindow(profile);
      console.log("If interrupted, verify and restore sandbox webhook " + endpointId + " using docs/stripe-pause-sandbox-window.md.");
      mustRestore = true;
      result.webhookRestored = false;
      requireFact(sameEndpoint(await stripe.webhookEndpoints.update(endpointId, { disabled: true }), "disabled"));
      result.test = "FAIL";
      await checkWrite();
      const advancing = await stripe.testHelpers.testClocks.advance(clockId, { frozen_time: nextAnchor },
        { idempotencyKey: "gloa-resume-only-clock-" + subscriptionId });
      requireFact(advancing.id === clockId && advancing.livemode === false);
      await waitFor(async () => {
        const updated = await stripe.testHelpers.testClocks.retrieve(clockId);
        requireFact(updated.id === clockId && updated.livemode === false && updated.status !== "internal_failure");
        return updated.status === "ready" && updated.frozen_time === nextAnchor;
      });

      stage = "preview_and_resume";
      const actions = pauseActions({ key, localId, subscriptionId, recoveredPause, checkEndpoint: checkWrite, retrieve,
        transport: async (target, options) => {
          if (options.method !== "POST") return fetch(target, options);
          requireFact(target === "https://api.stripe.com/v1/subscriptions/" + subscriptionId + "/resume" &&
            options.body.get("billing_cycle_anchor[type]") === "now" && options.body.get("proration_behavior") === "none" &&
            options.body.get("payment_behavior") === "resume_on_payment_success");
          await checkWrite();
          const sub = await retrieve(subscriptionId);
          verifyPause(sub);
          const preview = await stripe.invoices.createPreview({ subscription: subscriptionId, subscription_details: {
            resume_at: "now", billing_cycle_anchor: { type: "now" }, proration_behavior: "none",
          } });
          requireFact(matchesCycleInvoice(preview, sub, nextAnchor) && healthy());
          result.preview = true;
          return fetch(target, options);
        },
      });
      const response = await actions.request("resume");
      requireFact(response.status === 202 && (await response.json()).state === "resume_requested");
      const invoiceId = actions.resumeInvoiceId;
      requireFact(typeof invoiceId === "string");
      const active = await waitFor(async () => {
        const sub = await retrieve(subscriptionId);
        return sub.status === "active" && sub.billing_cycle_anchor === nextAnchor && sub;
      });
      result.resumed = true;
      await waitFor(() => local.verifiedTypes.has("customer.subscription.resumed") && paidEvents.has(invoiceId));
      result.signed = true;
      const invoice = await stripe.invoices.retrieve(invoiceId);
      const rules = load("../lib/subscriptionInvoiceRules.ts", {});
      const period = rules.resolvePaidInvoiceSubscriptionPeriod(invoice, subscriptionId);
      const decision = rules.evaluateSubscriptionInvoice({
        id: invoice.id, currency: invoice.currency, status: invoice.status, billingReason: invoice.billing_reason,
        total: invoice.total, customerId: ref(invoice.customer), stripeSubscriptionId: subscriptionId,
      }, { currency: "EUR", totalGrossCents: pricesTotal });
      requireFact(invoice.id === invoiceId && invoice.amount_paid === pricesTotal && invoice.amount_remaining === 0 &&
        decision.kind !== "fail" && decision.kind !== "ignore" && period.ok && Date.parse(period.start) === nextAnchor * 1000 &&
        matchesCycleInvoice(invoice, active, nextAnchor) && local.payments.at(-1)?.p_stripe_status === "active");
      result.paidCycle = true;
      result.test = "PASS";
    } finally {
      if (mustRestore) {
        try {
          result.webhookRestored = await restoreResumeWebhook(stripe);
        } catch { result.webhookRestored = false; }
      }
    }
  } catch {
    console.error("Stopped at " + stage);
  } finally {
    listener?.kill();
    if (server?.listening) await new Promise(resolve => {
      server.close(resolve);
      server.closeAllConnections();
    });
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
  if (mustRestore && !result.webhookRestored) {
    result.test = "FAIL";
    console.error("CRITICAL: Restore sandbox endpoint " + endpointId + " using docs/stripe-pause-sandbox-window.md.");
  }
  console.log(JSON.stringify(result));
  if (result.test !== "PASS") process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await run();
