import { createHash, randomUUID } from "node:crypto";
import { getSupabaseAdmin } from "./supabaseAdmin";
import { createStripePauseScheduleLive, createStripePauseScheduleSandbox, GLOA_LIVE_PAUSE_ENDPOINT, type LocalPauseProof } from "./stripePauseScheduleSandbox.server";

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

export function livePauseTargetAllowed(stripeId: string, env = process.env): boolean {
  const ids = env.GLOA_LIVE_PAUSE_SUBSCRIPTIONS?.split(",") ?? [];
  return ids.length > 0 && ids.every(id => /^sub_[a-zA-Z0-9_]+$/.test(id)) && ids.includes(stripeId);
}

// The pin is recorded by the Owner after verifying the signing secret in Stripe.
export function livePauseKey(env = process.env): string | null {
  const { STRIPE_SECRET_KEY: key, STRIPE_WEBHOOK_SECRET: signing } = env;
  if (env.VERCEL_ENV !== "production" || env.GLOA_LIVE_PAUSE_SIGNING_ENDPOINT !== GLOA_LIVE_PAUSE_ENDPOINT ||
      !key || !/^(sk|rk)_live_[a-zA-Z0-9_]+$/.test(key) || !signing || !/^whsec_[a-zA-Z0-9_]+$/.test(signing) ||
      createHash("sha256").update(signing).digest("hex") !== env.GLOA_LIVE_PAUSE_SIGNING_SHA256) return null;
  return key;
}

export function livePauseActionsKey(stripeId: string): string | null {
  return process.env.GLOA_LIVE_PAUSE_ACTIONS === "true" && livePauseTargetAllowed(stripeId) ? livePauseKey() : null;
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
  const key = livePauseActionsKey(target.stripeId);
  if (!key) return { state: "blocked" as const, reason: "live_pause_disabled" };
  const { data, error } = await admin.from("stripe_customers").select("stripe_customer_id")
    .eq("user_id", callerId).maybeSingle();
  if (error || !data?.stripe_customer_id) return { state: "blocked" as const, reason: "customer_mapping_unconfirmed" };
  const adapter = createStripePauseScheduleLive(key);
  if (!await adapter.verifyContext()) return { state: "blocked" as const, reason: "unverified_live_context" };
  return changeSubscriptionPause(admin, { ...target, stripeCustomerId: data.stripe_customer_id }, action, adapter);
}

async function changeSubscriptionPause(
  admin: NonNullable<ReturnType<typeof getSupabaseAdmin>>,
  target: { localId: string; stripeId: string; stripeCustomerId?: string },
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
