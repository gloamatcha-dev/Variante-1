import { getResendClient } from "./resend";
import { getSiteOrigin } from "./siteUrl";
import { GLOA_FROM_HELLO, GLOA_REPLY_TO_SUPPORT } from "./emailSenders";
import type { getSupabaseAdmin } from "./supabaseAdmin";

type Admin = NonNullable<ReturnType<typeof getSupabaseAdmin>>;

export async function notifyB2bOffer(admin: Admin, id: string, version: number) {
  if (process.env.B2B_OFFER_EMAIL_ENABLED !== "true") return "pending";
  const resend = getResendClient();
  const origin = getSiteOrigin();
  if (!resend || !origin) return "pending";
  try {
    const accountUrl = new URL("/account/business#b2b-offers", origin);
    if (accountUrl.protocol !== "https:") return "pending";
    const draft = await admin.from("b2b_offer_drafts").select("customer_id").eq("id", id).maybeSingle();
    if (draft.error) return "pending";
    const recipientId = draft.data?.customer_id;
    if (typeof recipientId !== "string") return "pending";
    const { data, error } = await admin.auth.admin.getUserById(recipientId);
    const user = data?.user;
    if (error || user?.id !== recipientId || !user.email || !user.email_confirmed_at || user.is_anonymous ||
        (user.banned_until && !(Date.parse(user.banned_until) <= Date.now()))) return "pending";

    const { data: customerId, error: claimError } = await admin.rpc("claim_b2b_offer_notification_v1", {
      p_draft: id, p_version: version,
    });
    if (claimError) return "unconfirmed";
    if (typeof customerId !== "string") return "already_claimed";
    if (customerId !== recipientId) return "unconfirmed";

    // The RPC claims only the published, unexpired version. Check again close
    // to provider submission because publication and delivery are separate systems.
    const offer = await admin.from("b2b_offer_versions").select("state,expires_at")
      .eq("draft_id", id).eq("version", version).maybeSingle();
    if (offer.error) return "unconfirmed";
    const expiry = Date.parse(offer.data?.expires_at ?? "");
    if (offer.data?.state !== "published" || !(expiry > Date.now())) return "unavailable";
    const validUntil = new Intl.DateTimeFormat("de-DE", {
      dateStyle: "long", timeStyle: "short", timeZone: "Europe/Berlin",
    }).format(expiry);
    const response = await resend.emails.send({
      from: GLOA_FROM_HELLO, replyTo: GLOA_REPLY_TO_SUPPORT, to: user.email,
      subject: "Dein GLOA-Angebot im Kundenkonto",
      text: [
        "Für das GLOA-Geschäftskonto " + user.email,
        "Angebotsreferenz: " + id,
        "Version: " + version,
        "Gültig bis: " + validUntil + " (Europe/Berlin)",
        "Melde dich an, um den aktuellen Angebotsstatus zu prüfen: " + accountUrl.href,
      ].join("\n"),
    }, { idempotencyKey: "gloa-b2b-offer/" + id + "/" + version });
    if (response.error || typeof response.data?.id !== "string" || !response.data.id.trim()) return "unconfirmed";
    const { data: recorded, error: updateError } = await admin.from("b2b_offer_notifications")
      .update({ status: "sent" }).eq("draft_id", id).eq("version", version).eq("status", "sending")
      .select("status").maybeSingle();
    return updateError || recorded?.status !== "sent" ? "unconfirmed" : "sent";
  } catch {
    // An uncertain delivery stays claimed. Never resend it automatically.
    return "unconfirmed";
  }
}
