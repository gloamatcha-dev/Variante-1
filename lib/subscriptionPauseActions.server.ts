import { createHash, randomUUID } from "node:crypto";
import { getSupabaseAdmin } from "./supabaseAdmin";
import { createStripePauseScheduleLive, createStripePauseScheduleSandbox, GLOA_LIVE_PAUSE_ENDPOINT, type LiveCyclePrice, type LocalPauseProof } from "./stripePauseScheduleSandbox.server";

type Action = "pause" | "resume";

export function sandboxPauseKey() {
  if (process.env.VERCEL_ENV === "production" || process.env.GLOA_SANDBOX_PAUSE_ACTIONS !== "true") return null;
  const key = process.env.STRIPE_SECRET_KEY;
  const url = import.meta.env.VITE_SUPABASE_URL;
  if (!key || !/^(sk|rk)_test_[a-zA-Z0-9_]+$/.test(key) || !url) return null;
  try {
    const target = new URL(url);
    return ["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) &&
      ["http:", "https:"].includes(target.protocol) ? key : null;
  } catch {
    return null;
  }
}

type Admin = NonNullable<ReturnType<typeof getSupabaseAdmin>>;

// Only subscriptions with a GLOA pause operation use the guarded invoice path.
// Keep using it after resume so late invoices cannot reopen a paused cycle.
export async function hasLivePauseHistory(stripeId: string, localId?: string): Promise<boolean> {
  if (!/^sub_[a-zA-Z0-9_]+$/.test(stripeId)) return false;
  const admin = getSupabaseAdmin();
  if (!admin) throw new Error("Pause history unavailable");
  if (!localId) {
    const { data, error } = await admin.from("subscriptions").select("id")
      .eq("stripe_subscription_id", stripeId).maybeSingle();
    if (error) throw new Error("Pause subscription mapping unavailable");
    if (!data) return false;
    localId = data.id;
  }
  const [windows, fences] = await Promise.all([
    admin.from("subscription_pause_windows").select("schedule_id").eq("subscription_id", localId).limit(1),
    admin.from("subscription_pause_write_fences").select("operation_id").eq("subscription_id", localId).limit(1),
  ]);
  if (windows.error || fences.error || !windows.data || !fences.data) throw new Error("Pause history unavailable");
  return windows.data.length > 0 || fences.data.length > 0;
}

// The pin is recorded by the Owner after verifying the signing secret in Stripe.
export function livePauseKey(env = process.env): string | null {
  const { STRIPE_SECRET_KEY: key, STRIPE_WEBHOOK_SECRET: signing } = env;
  if (env.VERCEL_ENV !== "production" || env.GLOA_LIVE_PAUSE_SIGNING_ENDPOINT !== GLOA_LIVE_PAUSE_ENDPOINT ||
      !key || !/^(sk|rk)_live_[a-zA-Z0-9_]+$/.test(key) || !signing || !/^whsec_[a-zA-Z0-9_]+$/.test(signing) ||
      createHash("sha256").update(signing).digest("hex") !== env.GLOA_LIVE_PAUSE_SIGNING_SHA256) return null;
  return key;
}

export function livePauseActionsKey(): string | null {
  return process.env.GLOA_LIVE_PAUSE_ACTIONS === "true" ? livePauseKey() : null;
}

export async function loadLivePauseTarget(
  admin: Admin,
  target: { localId: string; stripeId: string },
  callerId: string,
  action: Action,
) {
  const [customer, subscription] = await Promise.all([
    admin.from("stripe_customers").select("stripe_customer_id").eq("user_id", callerId).maybeSingle(),
    admin.from("subscriptions").select("status,cancelled_at,last_paid_period_end,currency,total_gross_cents,shipping_gross_cents")
      .eq("id", target.localId).eq("user_id", callerId).eq("stripe_subscription_id", target.stripeId).maybeSingle(),
  ]);
  const row = subscription.data;
  const stripeCustomerId = customer.data?.stripe_customer_id;
  if (customer.error || subscription.error || !stripeCustomerId || !/^cus_[a-zA-Z0-9_]+$/.test(stripeCustomerId) ||
      !row || row.currency !== "EUR" || row.cancelled_at !== null ||
      (action === "pause" ? row.status !== "active" : !["active", "paused"].includes(row.status)) ||
      !row.last_paid_period_end || !Number.isFinite(Date.parse(row.last_paid_period_end))) return null;
  return { stripeCustomerId, liveCyclePrice: { totalCents: row.total_gross_cents, shippingCents: row.shipping_gross_cents } };
}

export async function changeSandboxSubscriptionPause(
  admin: NonNullable<ReturnType<typeof getSupabaseAdmin>>,
  target: { localId: string; stripeId: string },
  action: Action,
  key: string,
) {
  return changeSubscriptionPause(admin, target, action, createStripePauseScheduleSandbox(key));
}

export async function changeLiveSubscriptionPause(
  admin: NonNullable<ReturnType<typeof getSupabaseAdmin>>,
  target: { localId: string; stripeId: string },
  action: Action,
  callerId: string,
) {
  const key = livePauseActionsKey();
  if (!key) return { state: "blocked" as const, reason: "live_pause_disabled" };
  const verified = await loadLivePauseTarget(admin, target, callerId, action);
  if (!verified) return { state: "blocked" as const, reason: "live_contract_unconfirmed" };
  return changeSubscriptionPause(admin, { ...target, ...verified }, action, createStripePauseScheduleLive(key));
}

async function changeSubscriptionPause(
  admin: NonNullable<ReturnType<typeof getSupabaseAdmin>>,
  target: { localId: string; stripeId: string; stripeCustomerId?: string; liveCyclePrice?: LiveCyclePrice },
  action: Action,
  adapter: ReturnType<typeof createStripePauseScheduleSandbox>,
) {
  const operationId = randomUUID();
  const { error } = await admin.from("subscription_pause_write_fences").insert({
    subscription_id: target.localId,
    operation_id: operationId,
    action,
  });
  if (error) return { state: "blocked" as const, reason: error.code === "23505" ? "inspection_required" : "fence_unavailable" };

  let pauseProof: LocalPauseProof | undefined;
  if (action === "resume") {
    const window = await admin.from("subscription_pause_windows").select("schedule_id,pause_at")
      .eq("subscription_id", target.localId).is("resumed_at", null).maybeSingle();
    if (window.error) return { state: "unconfirmed" as const };
    if (window.data) pauseProof = { scheduleId: window.data.schedule_id, pauseAt: Date.parse(window.data.pause_at) / 1000 };
  }
  const result = await adapter.change({ ...target, operationId, pauseProof }, action);
  if (result.state === "scheduled") {
    if (!result.scheduleId || !result.pauseAt) return { state: "unconfirmed" as const };
    const { error: windowError } = await admin.from("subscription_pause_windows").insert({
      subscription_id: target.localId,
      schedule_id: result.scheduleId,
      pause_at: new Date(result.pauseAt * 1000).toISOString(),
    });
    if (windowError) return { state: "unconfirmed" as const };
  }
  if (result.resumeInvoiceId && result.scheduleId) {
    const recorded = await admin.from("subscription_pause_write_fences")
      .update({ resume_invoice_id: result.resumeInvoiceId, resume_schedule_id: result.scheduleId })
      .eq("subscription_id", target.localId).eq("operation_id", operationId).select("operation_id").maybeSingle();
    if (recorded.error || !recorded.data) return { state: "unconfirmed" as const };
  }
  if (result.state !== "unconfirmed" && !result.holdFence) {
    const { error: releaseError } = await admin.from("subscription_pause_write_fences").delete()
      .eq("subscription_id", target.localId).eq("operation_id", operationId);
    if (releaseError) return { state: "unconfirmed" as const };
  }
  return result;
}
