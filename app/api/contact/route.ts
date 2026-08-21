import { getResendClient } from "../../../lib/resend";

// Fixed, server-chosen recipient - never taken from the client.
const CONTACT_RECIPIENT = "info@gloamatcha.com";

const ALLOWED_ANLIEGEN = ["Bestellung", "Produkt", "Abo", "Sonstiges"] as const;
type Anliegen = (typeof ALLOWED_ANLIEGEN)[number];

// Simple structural check - not a full RFC 5322 validator. Final
// deliverability is decided by the email provider, not this regex.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const MAX_NAME_LEN = 200;
const MAX_EMAIL_LEN = 254;
const MAX_ORDER_NUMBER_LEN = 100;
const MIN_MESSAGE_LEN = 10;
const MAX_MESSAGE_LEN = 5000;

// Generous ceiling on the raw request body - well above any real
// submission, just to reject obviously oversized payloads before
// they're even parsed as JSON.
const MAX_BODY_BYTES = 20_000;

type ErrorResponse = { error: string };
type SuccessResponse = { ok: true };

function isAllowedAnliegen(value: unknown): value is Anliegen {
  return typeof value === "string" && (ALLOWED_ANLIEGEN as readonly string[]).includes(value);
}

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

  const { name, email, anliegen, orderNumber, message, website } = body as Record<string, unknown>;

  // Honeypot: a field real customers never see or fill in (hidden in the
  // UI). A bot that autofills every input populates it. Discard silently
  // with the same success shape as a real submission - never send mail,
  // never reveal to the caller that detection happened.
  if (typeof website === "string" && website.trim() !== "") {
    return Response.json({ ok: true } as SuccessResponse, { status: 200 });
  }

  if (typeof name !== "string" || name.trim().length === 0 || name.trim().length > MAX_NAME_LEN) {
    return Response.json({ error: "Bitte gib deinen Namen an." } as ErrorResponse, { status: 400 });
  }
  const trimmedName = name.trim();

  const trimmedEmail = typeof email === "string" ? email.trim() : "";
  if (!trimmedEmail || trimmedEmail.length > MAX_EMAIL_LEN || !EMAIL_RE.test(trimmedEmail)) {
    return Response.json({ error: "Bitte gib eine gültige E-Mail-Adresse an." } as ErrorResponse, { status: 400 });
  }

  if (!isAllowedAnliegen(anliegen)) {
    return Response.json({ error: "Bitte wähle ein gültiges Anliegen." } as ErrorResponse, { status: 400 });
  }

  let trimmedOrderNumber: string | null = null;
  if (orderNumber !== undefined && orderNumber !== null && orderNumber !== "") {
    if (typeof orderNumber !== "string" || orderNumber.trim().length > MAX_ORDER_NUMBER_LEN) {
      return Response.json({ error: "Bestellnummer ist zu lang." } as ErrorResponse, { status: 400 });
    }
    trimmedOrderNumber = orderNumber.trim() || null;
  }

  const trimmedMessage = typeof message === "string" ? message.trim() : "";
  if (trimmedMessage.length < MIN_MESSAGE_LEN || trimmedMessage.length > MAX_MESSAGE_LEN) {
    return Response.json(
      { error: `Deine Nachricht sollte zwischen ${MIN_MESSAGE_LEN} und ${MAX_MESSAGE_LEN} Zeichen lang sein.` } as ErrorResponse,
      { status: 400 }
    );
  }

  const resend = getResendClient();
  const fromAddress = process.env.RESEND_CONTACT_FROM;
  if (!resend || !fromAddress) {
    console.error("Contact form error: RESEND_API_KEY or RESEND_CONTACT_FROM is not configured.");
    return Response.json({ error: "Kontaktformular vorübergehend nicht verfügbar. Schreib uns direkt an info@gloamatcha.com." } as ErrorResponse, { status: 503 });
  }

  // Plain text only - never renders any client-supplied string as HTML.
  const textBody = [
    `Name: ${trimmedName}`,
    `E-Mail: ${trimmedEmail}`,
    `Anliegen: ${anliegen}`,
    trimmedOrderNumber ? `Bestellnummer: ${trimmedOrderNumber}` : null,
    "",
    "Nachricht:",
    trimmedMessage,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

  try {
    const { error } = await resend.emails.send({
      from: fromAddress,
      to: CONTACT_RECIPIENT,
      replyTo: trimmedEmail,
      subject: `GLOA Kontaktanfrage: ${anliegen}`,
      text: textBody,
    });

    if (error) {
      console.error("Contact form error: Resend rejected the message:", error.message);
      return Response.json({ error: "Nachricht konnte nicht gesendet werden. Schreib uns direkt an info@gloamatcha.com." } as ErrorResponse, { status: 502 });
    }
  } catch (err) {
    console.error("Contact form error:", err instanceof Error ? err.message : err);
    return Response.json({ error: "Nachricht konnte nicht gesendet werden. Schreib uns direkt an info@gloamatcha.com." } as ErrorResponse, { status: 502 });
  }

  return Response.json({ ok: true } as SuccessResponse, { status: 200 });
}
