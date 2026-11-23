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
  const accountUrl = new URL("/account/business", origin);
  if (accountUrl.protocol !== "https:") return "pending";

  const { data: customerId, error: claimError } = await admin.rpc("claim_b2b_offer_notification_v1", {
    p_draft: id, p_version: version,
  });
  if (claimError) return "unconfirmed";
  if (typeof customerId !== "string") return "already_claimed";

  try {
    const { data, error } = await admin.auth.admin.getUserById(customerId);
    const user = data?.user;
    if (error || !user?.email || !user.email_confirmed_at) return "unconfirmed";
    const response = await resend.emails.send({
      from: GLOA_FROM_HELLO, replyTo: GLOA_REPLY_TO_SUPPORT, to: user.email,
      subject: "Dein GLOA-Angebot ist im Kundenkonto verfuegbar",
      text: "Melde dich in deinem GLOA-Kundenkonto an, um das Angebot zu lesen: " + accountUrl.href,
    }, { idempotencyKey: "gloa-b2b-offer/" + id + "/" + version });
    if (response.error) return "unconfirmed";
    const { error: updateError } = await admin.from("b2b_offer_notifications")
      .update({ status: "sent" }).eq("draft_id", id).eq("version", version).eq("status", "sending");
    return updateError ? "unconfirmed" : "sent";
  } catch {
    // An uncertain delivery stays claimed. Never resend it automatically.
    return "unconfirmed";
  }
}
