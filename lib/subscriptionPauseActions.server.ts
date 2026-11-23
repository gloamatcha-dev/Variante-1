import { randomUUID } from "node:crypto";
import { getSupabaseAdmin } from "./supabaseAdmin";
import { createStripePauseScheduleSandbox } from "./stripePauseScheduleSandbox.server";

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

export async function changeSandboxSubscriptionPause(
  admin: NonNullable<ReturnType<typeof getSupabaseAdmin>>,
  target: { localId: string; stripeId: string },
  action: Action,
  key: string,
) {
  const operationId = randomUUID();
  const { error } = await admin.from("subscription_pause_write_fences").insert({
    subscription_id: target.localId,
    operation_id: operationId,
    action,
  });
  if (error) return { state: "blocked" as const, reason: error.code === "23505" ? "inspection_required" : "fence_unavailable" };

  const result = await createStripePauseScheduleSandbox(key).change({ ...target, operationId }, action);
  if (result.state === "scheduled") {
    if (!result.scheduleId || !result.pauseAt) return { state: "unconfirmed" as const };
    const { error: windowError } = await admin.from("subscription_pause_windows").insert({
      subscription_id: target.localId,
      schedule_id: result.scheduleId,
      pause_at: new Date(result.pauseAt * 1000).toISOString(),
    });
    if (windowError) return { state: "unconfirmed" as const };
  }
  if (result.state !== "unconfirmed") {
    const { error: releaseError } = await admin.from("subscription_pause_write_fences").delete()
      .eq("subscription_id", target.localId).eq("operation_id", operationId);
    if (releaseError) return { state: "unconfirmed" as const };
  }
  return result;
}
