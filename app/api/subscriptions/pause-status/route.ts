import { verifyBearerUser } from "../../../../lib/verifyUser";
import { getStripeClient } from "../../../../lib/stripe";
import { getSupabaseAdmin } from "../../../../lib/supabaseAdmin";
import { readSubscriptionPauseStatus } from "../../../../lib/subscriptionPauseStatus.ts";

const response = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });

export async function POST(request: Request) {
  const caller = await verifyBearerUser(request);
  if (!caller) return response({ error: "Bitte melde dich an." }, 401);
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    return response({ error: "Ungültige Anfrage." }, 400);
  }
  // A fixed size read also works if no Content-Length was supplied.
  const reader = request.body?.getReader();
  if (!reader) return response({ error: "Ungültige Anfrage." }, 400);
  const bytes = new Uint8Array(256);
  let used = 0;
  let id: string;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (used + value.byteLength > bytes.length) {
        await reader.cancel();
        return response({ error: "Anfrage zu groß." }, 413);
      }
      bytes.set(value, used);
      used += value.byteLength;
    }
    const body = JSON.parse(new TextDecoder().decode(bytes.subarray(0, used)));
    if (!body || Object.keys(body).length !== 1 || typeof body.subscriptionId !== "string" ||
        !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(body.subscriptionId)) {
      return response({ error: "Ungültige Anfrage." }, 400);
    }
    id = body.subscriptionId;
  } catch {
    return response({ error: "Ungültige Anfrage." }, 400);
  } finally { reader.releaseLock(); }

  try {
    const admin = getSupabaseAdmin();
    if (!admin) return response({ error: "Abrechnungsstatus nicht bestätigt." }, 503);
    const { data, error } = await admin.from("subscriptions").select("id,stripe_subscription_id,status")
      .eq("id", id).eq("user_id", caller.userId).maybeSingle();
    if (error) return response({ error: "Abrechnungsstatus nicht bestätigt." }, 503);
    if (!data) return response({ error: "Abo nicht gefunden." }, 404);
    const stripe = getStripeClient();
    if (!stripe || !data.stripe_subscription_id || !["active", "paused", "past_due"].includes(data.status)) {
      return response({ error: "Abrechnungsstatus nicht bestätigt." }, 409);
    }
    const subscription = await stripe.subscriptions.retrieve(data.stripe_subscription_id, { expand: ["latest_invoice"] });
    return response(readSubscriptionPauseStatus(subscription, { localId: data.id, stripeId: data.stripe_subscription_id }));
  } catch {
    return response({ error: "Abrechnungsstatus nicht bestätigt. Bitte später erneut prüfen." }, 503);
  }
}
