import { getResendClient } from "../../../lib/resend";
import {
  validatePartnershipRequest,
  buildPartnershipNotificationSubject,
  buildPartnershipNotificationText,
} from "../../../lib/partnershipRequest";

/**
 * POST /api/partnerships — the short first partnership request.
 *
 * Deliberately the same shape as /api/contact, because it is the same
 * kind of thing: a public form that turns into ONE internal email and
 * writes nothing. No Supabase client, no table, no migration.
 *
 * The security posture is copied rather than reinvented, so the two
 * public forms cannot drift into having different defences:
 *   - JSON content type required
 *   - a byte ceiling on the body, checked before parsing
 *   - a honeypot field, answered with the success shape and no mail
 *   - the recipient is a server constant, never read from the client
 *   - plain text only, so nothing submitted is ever rendered as markup
 *
 * The validation itself lives in lib/partnershipRequest.ts, which the
 * browser form imports too - one list of partnership types, one set of
 * limits.
 */

// Fixed, server-chosen recipient - never taken from the client.
const PARTNERSHIP_RECIPIENT = "hello@gloamatcha.com";

// Generous ceiling on the raw request body - well above any real
// submission, just to reject obviously oversized payloads before
// they're even parsed as JSON.
const MAX_BODY_BYTES = 20_000;

const SEND_FAILED = "Anfrage konnte nicht gesendet werden. Schreib uns direkt an hello@gloamatcha.com.";

type ErrorResponse = { error: string };
type SuccessResponse = { ok: true };

export async function POST(request: Request): Promise<Response> {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return Response.json({ error: "Ungültige Anfrage." } as ErrorResponse, { status: 400 });
  }

  const contentLength = Number(request.headers.get("content-length") || "0");
  if (contentLength > MAX_BODY_BYTES) {
    return Response.json({ error: "Anfrage zu groß." } as ErrorResponse, { status: 413 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Ungültige Anfrage." } as ErrorResponse, { status: 400 });
  }

  if (!body || typeof body !== "object") {
    return Response.json({ error: "Ungültige Anfrage." } as ErrorResponse, { status: 400 });
  }

  // Honeypot: a field a real visitor never sees or fills in (hidden in
  // the UI). A bot that autofills every input populates it. Discard
  // silently with the same success shape as a real submission - never
  // send mail, never reveal to the caller that detection happened.
  const { website } = body as Record<string, unknown>;
  if (typeof website === "string" && website.trim() !== "") {
    return Response.json({ ok: true } as SuccessResponse, { status: 200 });
  }

  const validated = validatePartnershipRequest(body);
  if (!validated.ok) {
    return Response.json({ error: validated.error } as ErrorResponse, { status: 400 });
  }
  const partnership = validated.value;

  const resend = getResendClient();
  const fromAddress = process.env.RESEND_CONTACT_FROM;
  if (!resend || !fromAddress) {
    console.error("Partnership form error: RESEND_API_KEY or RESEND_CONTACT_FROM is not configured.");
    return Response.json(
      { error: "Partnership-Formular vorübergehend nicht verfügbar. Schreib uns direkt an hello@gloamatcha.com." } as ErrorResponse,
      { status: 503 }
    );
  }

  try {
    const { error } = await resend.emails.send({
      from: fromAddress,
      to: PARTNERSHIP_RECIPIENT,
      replyTo: partnership.email,
      subject: buildPartnershipNotificationSubject(partnership),
      text: buildPartnershipNotificationText(partnership),
    });

    if (error) {
      console.error("Partnership form error: Resend rejected the message:", error.message);
      return Response.json({ error: SEND_FAILED } as ErrorResponse, { status: 502 });
    }
  } catch (err) {
    console.error("Partnership form error:", err instanceof Error ? err.message : err);
    return Response.json({ error: SEND_FAILED } as ErrorResponse, { status: 502 });
  }

  return Response.json({ ok: true } as SuccessResponse, { status: 200 });
}
