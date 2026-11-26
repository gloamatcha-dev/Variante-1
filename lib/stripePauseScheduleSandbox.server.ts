// Documented Stripe contract used to qualify GLOA pause/resume in a sandbox.
// The sandbox customer action and paid-invoice reconciliation share this adapter.
const gloaSandboxAccountId = "acct_1U6B3cDASU5R3UGE";

export const GLOA_LIVE_PAUSE_ACCOUNT = "acct_1U6B3ODI76FH9qsq";
export const GLOA_LIVE_PAUSE_ENDPOINT = "we_1UHt57DI76FH9qsqbVplt42G";
const liveEvents = ["customer.subscription.paused", "customer.subscription.resumed", "invoice.paid"];

export const PAUSE_SCHEDULE_API_VERSION = "2026-09-30.endive";

type StripeSubscription = {
  id: string;
  livemode: boolean;
  status: string;
  collection_method: string;
  customer?: string;
  billing_mode?: { type?: string };
  metadata?: { gloa_subscription_id?: string };
  schedule: string | null;
  pause_collection: unknown;
  pending_update: unknown;
  latest_invoice?: string | null;
  status_details?: { paused?: { type?: string; transitioned_at?: number; subscription?: { type?: string } } };
  test_clock?: string | null;
  cancel_at: number | null;
  cancel_at_period_end: boolean;
  items: { has_more: boolean; data: {
    current_period_end: number;
    quantity?: number;
    price: { id?: string; product?: string; currency?: string; unit_amount?: number; recurring?: { interval: string; interval_count: number; usage_type: string } };
  }[] };
};

type StripeSchedule = {
  id: string;
  livemode: boolean;
  subscription: string | null;
  released_subscription?: string | null;
  released_at?: number | null;
  end_behavior?: string;
  status: string;
  billing_mode?: { type?: string };
  pause_schedules?: {
    key: string;
    pause?: { pause_at: number; status?: { type?: string } };
    resume?: { status?: { type?: string } } | null;
  }[];
};

export type LiveCyclePrice = { totalCents: number; shippingCents: number };

export type LocalPauseProof = { scheduleId: string; pauseAt: number };
type Target = { localId: string; stripeId: string; operationId: string; stripeCustomerId?: string; liveCyclePrice?: LiveCyclePrice; pauseProof?: LocalPauseProof };
type Result = { state: "blocked" | "unconfirmed" | "scheduled" | "resume_requested"; reason?: string;
  scheduleId?: string; pauseAt?: number; holdFence?: true; resumeInvoiceId?: string };

function checkId(value: string, pattern: RegExp) {
  return typeof value === "string" && pattern.test(value);
}

const uuid = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const blocked = (reason: string): Result => ({ state: "blocked", reason });

export function createStripePauseScheduleSandbox(
  secret: string,
  request: typeof fetch = fetch,
  now: () => number = Date.now,
) {
  if (!/^(sk|rk)_test_[a-zA-Z0-9_]+$/.test(secret)) throw new Error("stripe_pause_test_key_required");
  return createStripePauseSchedule(secret, false, request, now);
}

export function createStripePauseScheduleLive(secret: string, request: typeof fetch = fetch, now: () => number = Date.now) {
  if (!/^(sk|rk)_live_[a-zA-Z0-9_]+$/.test(secret)) throw new Error("stripe_pause_live_key_required");
  return createStripePauseSchedule(secret, true, request, now);
}

function createStripePauseSchedule(secret: string, live: boolean, request: typeof fetch, now: () => number) {
  const inFlight = new Set<string>();
  const submitted = new Set<string>();
  const requiresInspection = new Set<string>();

  async function call<T>(path: string, body?: URLSearchParams, idempotencyKey?: string): Promise<T> {
    const headers = new Headers({
      Authorization: "Bearer " + secret,
      "Stripe-Version": PAUSE_SCHEDULE_API_VERSION,
    });
    if (idempotencyKey) headers.set("Idempotency-Key", idempotencyKey);
    const result = await request("https://api.stripe.com/v1/" + path, {
      method: body ? "POST" : "GET", body, headers, redirect: "error",
      cache: "no-store", signal: AbortSignal.timeout(8000),
    });
    if (!result.ok) throw new Error("stripe_pause_response_unconfirmed");
    return await result.json() as T;
  }

  async function verifyContext() {
    const account = await call<{ id: string; object: string }>("account");
    if (account.object !== "account" || account.id !== (live ? GLOA_LIVE_PAUSE_ACCOUNT : gloaSandboxAccountId)) return false;
    if (!live) return true;
    const endpoint = await call<{ id: string; livemode: boolean; status: string; url: string; enabled_events: string[] }>(
      "webhook_endpoints/" + GLOA_LIVE_PAUSE_ENDPOINT,
    );
    return endpoint.id === GLOA_LIVE_PAUSE_ENDPOINT && endpoint.livemode === true && endpoint.status === "enabled" &&
      endpoint.url === "https://gloamatcha.com/api/stripe/webhook" && Array.isArray(endpoint.enabled_events) &&
      liveEvents.every(event => endpoint.enabled_events.includes(event));
  }

  async function verifyResumePreview(sub: StripeSubscription, totalCents: number) {
    const preview = await call<{
      livemode: boolean; currency: string; customer: string; total: number; subtotal: number; amount_due: number;
      starting_balance: number; ending_balance: number | null;
      parent?: { subscription_details?: { subscription?: string } };
      lines?: { has_more: boolean; data: {
        amount: number; quantity: number; period?: { start: number; end: number };
        pricing?: { price_details?: { price?: string } };
        parent?: { subscription_item_details?: { subscription?: string; proration?: boolean } };
      }[] };
    }>("invoices/create_preview", new URLSearchParams({
      subscription: sub.id, "subscription_details[resume_at]": "now",
      "subscription_details[billing_cycle_anchor][type]": "now", "subscription_details[proration_behavior]": "none",
    }));
    const lines = preview.lines?.data;
    const anchor = lines?.[0]?.period?.start;
    return preview.livemode === true && preview.customer === sub.customer &&
      preview.parent?.subscription_details?.subscription === sub.id && preview.currency === "eur" &&
      preview.subtotal === totalCents && preview.total === totalCents && preview.amount_due === totalCents &&
      preview.starting_balance === 0 && (preview.ending_balance == null || preview.ending_balance === 0) &&
      preview.lines?.has_more === false && lines?.length === sub.items.data.length && typeof anchor === "number" &&
      Number.isSafeInteger(anchor) && Math.abs(Math.floor(now() / 1000) - anchor) <= 30 &&
      sub.items.data.every(item => lines.filter(line => line.pricing?.price_details?.price === item.price.id &&
        line.parent?.subscription_item_details?.subscription === sub.id &&
        line.parent.subscription_item_details.proration === false && line.quantity === 1 &&
        line.amount === item.price.unit_amount && line.period?.start === anchor &&
        line.period.end === anchor + 28 * 86400).length === 1);
  }

  async function change(target: Target, action: "pause" | "resume"): Promise<Result> {
    if (!checkId(target.stripeId, /^sub_[a-zA-Z0-9_]+$/) || !checkId(target.localId, uuid) ||
        !checkId(target.operationId, uuid)) return blocked("invalid_target");
    if (inFlight.has(target.stripeId)) return blocked("operation_in_progress");
    const writeKey = (live ? "gloa-pause-live:" : "gloa-pause-sandbox:") + action + ":" + target.operationId.toLowerCase();
    if (submitted.has(writeKey) || requiresInspection.has(target.stripeId)) return blocked("inspection_required");
    inFlight.add(target.stripeId);
    try {
      if (!await verifyContext()) return blocked(live ? "unverified_live_context" : "unverified_sandbox_account");
      const sub = await call<StripeSubscription>("subscriptions/" + target.stripeId);
      if (sub.id !== target.stripeId || sub.livemode !== live ||
          sub.metadata?.gloa_subscription_id !== target.localId ||
          (live && (!checkId(target.stripeCustomerId ?? "", /^cus_[a-zA-Z0-9_]+$/) || sub.customer !== target.stripeCustomerId))) {
        return blocked("unverified_subscription");
      }
      if (sub.billing_mode?.type !== "flexible" || sub.collection_method !== "charge_automatically") {
        return blocked("unsupported_billing_mode");
      }
      if (sub.pause_collection || sub.pending_update || sub.cancel_at != null || sub.cancel_at_period_end) {
        return blocked("conflicting_update");
      }
      if (action === "pause" ? sub.status !== "active" || sub.schedule !== null : sub.status !== "paused") {
        return blocked("conflicting_subscription_state");
      }
      const items = sub.items?.data;
      if (sub.items?.has_more !== false || !Array.isArray(items) || !items.length || items.some(item =>
        item.price?.recurring?.interval !== "week" || item.price.recurring.interval_count !== 4 ||
        item.price.recurring.usage_type !== "licensed" || item.current_period_end !== items[0].current_period_end)) {
        return blocked("unsupported_billing_cycle");
      }
      const contract = target.liveCyclePrice;
      if (live && (sub.test_clock != null || items.length !== 2 || !contract ||
          !Number.isSafeInteger(contract.totalCents) || !Number.isSafeInteger(contract.shippingCents) ||
          contract.shippingCents <= 0 || contract.totalCents <= contract.shippingCents ||
          items.some(item => item.quantity !== 1 || item.price.currency !== "eur" || !item.price.id) ||
          !items.some(item => item.price.product === "prod_VJXyucGJG3m2Vf" &&
            item.price.unit_amount === contract.totalCents - contract.shippingCents) ||
          !items.some(item => item.price.product === "prod_VAFbv5UQXUbTt7" &&
            item.price.unit_amount === contract.shippingCents))) {
        return blocked("unverified_live_plan");
      }
      const pauseAt = items[0].current_period_end;
      if (live && action === "pause") {
        if (!checkId(sub.latest_invoice ?? "", /^in_[a-zA-Z0-9_]+$/)) return blocked("unverified_paid_invoice");
        const latest = await call<{ id: string; livemode: boolean; status: string; customer: string; currency: string; total: number }>(
          "invoices/" + sub.latest_invoice,
        );
        if (latest.id !== sub.latest_invoice || latest.livemode !== true || latest.status !== "paid" ||
            latest.customer !== sub.customer || latest.currency !== "eur" || latest.total !== contract!.totalCents) {
          return blocked("unverified_paid_invoice");
        }
      }
      let existing: StripeSchedule | undefined;
      const detached = action === "resume" && sub.schedule === null;
      if (detached) {
        const proof = target.pauseProof;
        const paused = sub.status_details?.paused;
        if (!proof || !checkId(proof.scheduleId, /^sub_sched_[a-zA-Z0-9_]+$/) ||
            !Number.isSafeInteger(proof.pauseAt) || proof.pauseAt <= 0 || paused?.type !== "subscription" ||
            paused.subscription?.type !== "pause_requested" || paused.transitioned_at !== proof.pauseAt) {
          return blocked("unverified_pause_origin");
        }
        const released = await call<StripeSchedule>("subscription_schedules/" + proof.scheduleId);
        const entry = released.pause_schedules?.[0];
        if (released.id !== proof.scheduleId || released.livemode !== live || released.status !== "released" ||
            released.subscription !== null || released.released_subscription !== sub.id ||
            released.end_behavior !== "release" || released.released_at !== proof.pauseAt ||
            released.billing_mode?.type !== "flexible" || released.pause_schedules?.length !== 1 ||
            !checkId(entry?.key ?? "", /^pause_schedule_[a-zA-Z0-9_]+$/) ||
            entry?.pause?.pause_at !== proof.pauseAt || entry.pause.status?.type !== "succeeded" || entry.resume != null) {
          return blocked("unverified_released_schedule");
        }
      } else if (action === "resume") {
        if (live) return blocked("live_attached_resume_unqualified");
        if (!sub.schedule || !checkId(sub.schedule, /^sub_sched_[a-zA-Z0-9_]+$/)) {
          return blocked("missing_pause_schedule");
        }
        existing = await call<StripeSchedule>("subscription_schedules/" + sub.schedule);
        const entry = existing.pause_schedules?.[0];
        if (existing.id !== sub.schedule || existing.subscription !== sub.id || existing.livemode !== live ||
            existing.status !== "active" || existing.billing_mode?.type !== "flexible" ||
            existing.pause_schedules?.length !== 1 || entry?.pause?.status?.type !== "succeeded" ||
            typeof entry.key !== "string" || !entry.key || entry.resume != null) return blocked("unverified_pause_schedule");
      }

      for (const status of ["draft", "open", "uncollectible"]) {
        const params = new URLSearchParams({ subscription: sub.id, status, limit: "1" });
        const invoices = await call<{ data: unknown[]; has_more: boolean }>("invoices?" + params);
        if (!Array.isArray(invoices.data) || invoices.has_more !== false || invoices.data.length) {
          return blocked("unresolved_invoice");
        }
      }
      let stripeTime = now() / 1000;
      if (sub.test_clock != null) {
        if (!checkId(sub.test_clock, /^clock_[a-zA-Z0-9_]+$/)) return blocked("unverified_test_clock");
        const clock = await call<{ id: string; object: string; livemode: boolean; status: string; frozen_time: number }>(
          "test_helpers/test_clocks/" + sub.test_clock,
        );
        if (clock.id !== sub.test_clock || clock.object !== "test_helpers.test_clock" ||
            clock.livemode !== live || clock.status !== "ready" ||
            !Number.isSafeInteger(clock.frozen_time) || clock.frozen_time <= 0) return blocked("unverified_test_clock");
        stripeTime = clock.frozen_time;
      }
      if (action === "pause" && (!Number.isSafeInteger(pauseAt) || pauseAt <= stripeTime)) {
        return blocked("cycle_boundary_passed");
      }
      const body = new URLSearchParams();
      let path = "subscription_schedules";
      if (action === "pause") {
        body.set("from_subscription", sub.id);
        body.set("pause_schedules[0][pause][pause_at][type]", "timestamp");
        body.set("pause_schedules[0][pause][pause_at][timestamp]", String(pauseAt));
      } else if (detached) {
        if (stripeTime <= target.pauseProof!.pauseAt) return blocked("resume_boundary_not_advanced");
        path = "subscriptions/" + sub.id + "/resume";
        body.set("billing_cycle_anchor[type]", "now");
        body.set("proration_behavior", "none");
        body.set("payment_behavior", "resume_on_payment_success");
      } else {
        path += "/" + existing!.id;
        body.set("pause_schedules[0][key]", existing!.pause_schedules![0].key);
        body.set("pause_schedules[0][resume][resume_at][type]", "now");
        body.set("pause_schedules[0][resume][settings][billing_cycle_anchor]", "resume_at");
        body.set("pause_schedules[0][resume][settings][payment_behavior]", "resume_on_payment_success");
      }
      if (live && detached && !await verifyResumePreview(sub, contract!.totalCents)) return blocked("unverified_resume_preview");
      if (live && action === "pause" && pauseAt <= now() / 1000 + 60) return blocked("cycle_boundary_too_close");
      submitted.add(writeKey);
      requiresInspection.add(target.stripeId);
      if (detached) {
        const resumed = await call<StripeSubscription>(path, body, writeKey);
        const pendingInvoice = checkId(resumed.latest_invoice ?? "", /^in_[a-zA-Z0-9_]+$/) &&
          resumed.latest_invoice !== sub.latest_invoice;
        if (resumed.id !== sub.id || resumed.livemode !== live || resumed.schedule !== null ||
            resumed.metadata?.gloa_subscription_id !== target.localId || resumed.billing_mode?.type !== "flexible" ||
            (live && resumed.customer !== sub.customer) ||
            !pendingInvoice || (resumed.status !== "active" && resumed.status !== "paused")) {
          return { state: "unconfirmed" };
        }
        // The direct resume invoice has not yet been qualified by the fulfillment path.
        // Keep the durable fence for both an active response and an outstanding payment.
        return { state: "resume_requested", scheduleId: target.pauseProof!.scheduleId, holdFence: true,
          resumeInvoiceId: resumed.latest_invoice! };
      }
      const schedule = await call<StripeSchedule>(path, body, writeKey);
      const entry = schedule.pause_schedules?.[0];
      if (schedule.livemode !== live || schedule.subscription !== sub.id ||
          !checkId(schedule.id, /^sub_sched_[a-zA-Z0-9_]+$/) || schedule.status !== "active" ||
          schedule.billing_mode?.type !== "flexible" || schedule.pause_schedules?.length !== 1 || !entry?.key) {
        return { state: "unconfirmed" };
      }
      if (action === "pause" && entry.pause?.pause_at === pauseAt && entry.pause.status?.type === "scheduled") {
        requiresInspection.delete(target.stripeId);
        return { state: "scheduled", scheduleId: schedule.id, pauseAt };
      }
      if (existing && schedule.id === existing.id && entry.key === existing.pause_schedules![0].key &&
          ["pending", "requires_action", "succeeded"].includes(entry.resume?.status?.type ?? "")) {
        requiresInspection.delete(target.stripeId);
        return { state: "resume_requested", scheduleId: schedule.id };
      }
      return { state: "unconfirmed" };
    } catch {
      // A request may already have reached Stripe. The caller must inspect
      // Stripe before deciding what happened. No automatic write retry.
      return { state: "unconfirmed" };
    } finally {
      inFlight.delete(target.stripeId);
    }
  }

  async function confirmedResume(target: { localId: string; stripeId: string }, scheduleId: string) {
    if (!checkId(target.stripeId, /^sub_[a-zA-Z0-9_]+$/) || !checkId(target.localId, uuid) ||
        !checkId(scheduleId, /^sub_sched_[a-zA-Z0-9_]+$/) || !await verifyContext()) return false;
    const subscription = await call<StripeSubscription>("subscriptions/" + target.stripeId);
    if (subscription.id !== target.stripeId || subscription.livemode !== live ||
        subscription.metadata?.gloa_subscription_id !== target.localId ||
        subscription.billing_mode?.type !== "flexible" || subscription.status !== "active" ||
        subscription.schedule !== scheduleId) return false;
    const schedule = await call<StripeSchedule>("subscription_schedules/" + scheduleId);
    const entry = schedule.pause_schedules?.[0];
    return schedule.id === scheduleId && schedule.subscription === target.stripeId &&
      schedule.livemode === live && schedule.billing_mode?.type === "flexible" &&
      schedule.pause_schedules?.length === 1 && entry?.pause?.status?.type === "succeeded" &&
      entry.resume?.status?.type === "succeeded";
  }

  return { change, confirmedResume, verifyContext };
}
