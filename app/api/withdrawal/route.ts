import { getSupabaseAdmin } from "../../../lib/supabaseAdmin";
import { getResendClient } from "../../../lib/resend";
import { buildWithdrawalConfirmationEmail } from "../../../lib/email/withdrawalConfirmation";

// § 356a BGB electronic withdrawal function. This endpoint records a
// customer's withdrawal declaration durably and, best-effort, sends the
// required § 356a Abs. 4 confirmation. It is deliberately NOT an order
// lookup API: it never reads public.orders, never validates
// order_reference against real order data, and never echoes back
// anything beyond a neutral acknowledgement - the same response shape
// regardless of whether order_reference happens to match a real order,
// so this can never be used to enumerate or confirm order numbers.

const ALLOWED_SCOPE = ["whole_order", "partial"] as const;
type Scope = (typeof ALLOWED_SCOPE)[number];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const MAX_NAME_LEN = 200;
const MAX_EMAIL_LEN = 254;
const MAX_ORDER_REFERENCE_LEN = 200;
const MAX_SCOPE_NOTE_LEN = 500;
const MAX_CUSTOMER_NOTE_LEN = 2000;

// Generous ceiling on the raw request body, rejecting obviously
// oversized payloads before they're even parsed as JSON.
const MAX_BODY_BYTES = 20_000;

type ErrorResponse = { error: string };
type SuccessResponse = { ok: true; submittedAt: string; confirmationEmailSent: boolean };

function isScope(value: unknown): value is Scope {
  return typeof value === "string" && (ALLOWED_SCOPE as readonly string[]).includes(value);
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

  const { name, email, orderReference, scope, scopeNote, customerNote, website } = body as Record<string, unknown>;

  // Honeypot: same silent-discard pattern as /api/contact.
  if (typeof website === "string" && website.trim() !== "") {
    return Response.json({ ok: true, submittedAt: new Date().toISOString(), confirmationEmailSent: false } as SuccessResponse, { status: 200 });
  }

  if (typeof name !== "string" || name.trim().length === 0 || name.trim().length > MAX_NAME_LEN) {
    return Response.json({ error: "Bitte gib deinen Namen an." } as ErrorResponse, { status: 400 });
  }
  const trimmedName = name.trim();

  const trimmedEmail = typeof email === "string" ? email.trim() : "";
  if (!trimmedEmail || trimmedEmail.length > MAX_EMAIL_LEN || !EMAIL_RE.test(trimmedEmail)) {
    return Response.json({ error: "Bitte gib eine gültige E-Mail-Adresse für die Bestätigung an." } as ErrorResponse, { status: 400 });
  }

  const trimmedOrderReference = typeof orderReference === "string" ? orderReference.trim() : "";
  if (!trimmedOrderReference || trimmedOrderReference.length > MAX_ORDER_REFERENCE_LEN) {
    return Response.json({ error: "Bitte gib deine Bestellnummer oder eine andere Vertragsreferenz an." } as ErrorResponse, { status: 400 });
  }

  if (!isScope(scope)) {
    return Response.json({ error: "Bitte gib an, ob die gesamte Bestellung oder nur ein Teil widerrufen wird." } as ErrorResponse, { status: 400 });
  }

  let trimmedScopeNote: string | null = null;
  if (scopeNote !== undefined && scopeNote !== null && scopeNote !== "") {
    if (typeof scopeNote !== "string" || scopeNote.trim().length > MAX_SCOPE_NOTE_LEN) {
      return Response.json({ error: "Die Angabe zum betroffenen Teil ist zu lang." } as ErrorResponse, { status: 400 });
    }
    trimmedScopeNote = scopeNote.trim() || null;
  }
  if (scope === "partial" && !trimmedScopeNote) {
    return Response.json({ error: "Bitte gib an, welcher Teil der Bestellung widerrufen wird." } as ErrorResponse, { status: 400 });
  }

  let trimmedCustomerNote: string | null = null;
  if (customerNote !== undefined && customerNote !== null && customerNote !== "") {
    if (typeof customerNote !== "string" || customerNote.trim().length > MAX_CUSTOMER_NOTE_LEN) {
      return Response.json({ error: "Deine Anmerkung ist zu lang." } as ErrorResponse, { status: 400 });
    }
    trimmedCustomerNote = customerNote.trim() || null;
  }

  const admin = getSupabaseAdmin();
  if (!admin) {
    console.error("Withdrawal error: Supabase admin client is not configured.");
    return Response.json({ error: "Widerruf kann gerade nicht gespeichert werden. Schreib uns direkt an info@gloamatcha.com." } as ErrorResponse, { status: 503 });
  }

  const { data: inserted, error: insertError } = await admin
    .from("withdrawal_requests")
    .insert({
      customer_name: trimmedName,
      contact_email: trimmedEmail,
      order_reference: trimmedOrderReference,
      scope,
      scope_note: trimmedScopeNote,
      customer_note: trimmedCustomerNote,
    })
    .select("id, submitted_at")
    .single();

  if (insertError || !inserted) {
    console.error("Withdrawal error: could not persist withdrawal request:", insertError?.message);
    return Response.json({ error: "Widerruf kann gerade nicht gespeichert werden. Schreib uns direkt an info@gloamatcha.com." } as ErrorResponse, { status: 503 });
  }

  // The durable record above is the legally required part and has
  // already succeeded at this point. The confirmation email is
  // best-effort: Resend production is currently paused (Task 25A), so
  // this honestly reports whether it was actually sent rather than
  // claiming delivery.
  let confirmationEmailSent = false;
  const resend = getResendClient();
  const fromAddress = process.env.RESEND_CONTACT_FROM;
  if (resend && fromAddress) {
    const { subject, html, text } = buildWithdrawalConfirmationEmail({
      customerName: trimmedName,
      orderReference: trimmedOrderReference,
      scope,
      scopeNote: trimmedScopeNote,
      customerNote: trimmedCustomerNote,
      submittedAt: inserted.submitted_at,
    });
    try {
      const { error: sendError } = await resend.emails.send({
        from: fromAddress,
        to: trimmedEmail,
        replyTo: "info@gloamatcha.com",
        subject,
        html,
        text,
      });
      confirmationEmailSent = !sendError;
      if (sendError) console.error(`Withdrawal confirmation email: send failed for ${inserted.id}:`, sendError.message);
    } catch (err) {
      console.error(`Withdrawal confirmation email: send failed for ${inserted.id}:`, err instanceof Error ? err.message : err);
    }
  } else {
    console.error("Withdrawal confirmation email: RESEND_API_KEY or RESEND_CONTACT_FROM is not configured.");
  }

  const { error: statusError } = await admin
    .from("withdrawal_requests")
    .update({
      confirmation_status: confirmationEmailSent ? "sent" : "failed",
      confirmed_at: confirmationEmailSent ? new Date().toISOString() : null,
    })
    .eq("id", inserted.id);
  if (statusError) console.error(`Withdrawal error: could not update confirmation status for ${inserted.id}:`, statusError.message);

  return Response.json(
    { ok: true, submittedAt: inserted.submitted_at, confirmationEmailSent } as SuccessResponse,
    { status: 200 }
  );
}
