// Documented Stripe contract used to qualify GLOA pause/resume in a sandbox.
// The sandbox customer action and paid-invoice reconciliation share this adapter.
const gloaSandboxAccountId = "acct_1U6B3cDASU5R3UGE";

export const PAUSE_SCHEDULE_API_VERSION = "2026-09-30.endive";

type StripeSubscription = {
  id: string;
  livemode: boolean;
  status: string;
  collection_method: string;
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
    price: { recurring?: { interval: string; interval_count: number; usage_type: string } };
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

export type LocalPauseProof = { scheduleId: string; pauseAt: number };
type Target = { localId: string; stripeId: string; operationId: string; pauseProof?: LocalPauseProof };
type Result = { state: "blocked" | "unconfirmed" | "scheduled" | "resume_requested"; reason?: string;
  scheduleId?: string; pauseAt?: number; holdFence?: true };

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

  async function verifiedSandboxAccount() {
    const account = await call<{ id: string; object: string }>("account");
    return account.object === "account" && account.id === gloaSandboxAccountId;
  }

  async function change(target: Target, action: "pause" | "resume"): Promise<Result> {
    if (!checkId(target.stripeId, /^sub_[a-zA-Z0-9_]+$/) || !checkId(target.localId, uuid) ||
        !checkId(target.operationId, uuid)) return blocked("invalid_target");
    if (inFlight.has(target.stripeId)) return blocked("operation_in_progress");
    const writeKey = "gloa-pause-sandbox:" + action + ":" + target.operationId.toLowerCase();
    if (submitted.has(writeKey) || requiresInspection.has(target.stripeId)) return blocked("inspection_required");
    inFlight.add(target.stripeId);
    try {
      if (!await verifiedSandboxAccount()) return blocked("unverified_sandbox_account");
      const sub = await call<StripeSubscription>("subscriptions/" + target.stripeId);
      if (sub.id !== target.stripeId || sub.livemode !== false ||
          sub.metadata?.gloa_subscription_id !== target.localId) return blocked("unverified_subscription");
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
      const pauseAt = items[0].current_period_end;
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
        if (released.id !== proof.scheduleId || released.livemode !== false || released.status !== "released" ||
            released.subscription !== null || released.released_subscription !== sub.id ||
            released.end_behavior !== "release" || released.released_at !== proof.pauseAt ||
            released.billing_mode?.type !== "flexible" || released.pause_schedules?.length !== 1 ||
            !checkId(entry?.key ?? "", /^pause_schedule_[a-zA-Z0-9_]+$/) ||
            entry?.pause?.pause_at !== proof.pauseAt || entry.pause.status?.type !== "succeeded" || entry.resume != null) {
          return blocked("unverified_released_schedule");
        }
      } else if (action === "resume") {
        if (!sub.schedule || !checkId(sub.schedule, /^sub_sched_[a-zA-Z0-9_]+$/)) {
          return blocked("missing_pause_schedule");
        }
        existing = await call<StripeSchedule>("subscription_schedules/" + sub.schedule);
        const entry = existing.pause_schedules?.[0];
        if (existing.id !== sub.schedule || existing.subscription !== sub.id || existing.livemode !== false ||
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
            clock.livemode !== false || clock.status !== "ready" ||
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
      submitted.add(writeKey);
      requiresInspection.add(target.stripeId);
      if (detached) {
        const resumed = await call<StripeSubscription>(path, body, writeKey);
        const pendingInvoice = checkId(resumed.latest_invoice ?? "", /^in_[a-zA-Z0-9_]+$/) &&
          resumed.latest_invoice !== sub.latest_invoice;
        if (resumed.id !== sub.id || resumed.livemode !== false || resumed.schedule !== null ||
            resumed.metadata?.gloa_subscription_id !== target.localId || resumed.billing_mode?.type !== "flexible" ||
            (resumed.status !== "active" && !(resumed.status === "paused" && pendingInvoice))) {
          return { state: "unconfirmed" };
        }
        // The direct resume invoice has not yet been qualified by the fulfillment path.
        // Keep the durable fence for both an active response and an outstanding payment.
        return { state: "resume_requested", scheduleId: target.pauseProof!.scheduleId, holdFence: true };
      }
      const schedule = await call<StripeSchedule>(path, body, writeKey);
      const entry = schedule.pause_schedules?.[0];
      if (schedule.livemode !== false || schedule.subscription !== sub.id ||
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
        !checkId(scheduleId, /^sub_sched_[a-zA-Z0-9_]+$/) || !await verifiedSandboxAccount()) return false;
    const subscription = await call<StripeSubscription>("subscriptions/" + target.stripeId);
    if (subscription.id !== target.stripeId || subscription.livemode !== false ||
        subscription.metadata?.gloa_subscription_id !== target.localId ||
        subscription.billing_mode?.type !== "flexible" || subscription.status !== "active" ||
        subscription.schedule !== scheduleId) return false;
    const schedule = await call<StripeSchedule>("subscription_schedules/" + scheduleId);
    const entry = schedule.pause_schedules?.[0];
    return schedule.id === scheduleId && schedule.subscription === target.stripeId &&
      schedule.livemode === false && schedule.billing_mode?.type === "flexible" &&
      schedule.pause_schedules?.length === 1 && entry?.pause?.status?.type === "succeeded" &&
      entry.resume?.status?.type === "succeeded";
  }

  return { change, confirmedResume };
}
