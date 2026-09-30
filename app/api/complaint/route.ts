import { getSupabaseAdmin } from "../../../lib/supabaseAdmin";
import { getSiteOrigin } from "../../../lib/siteUrl";
import { getResendClient } from "../../../lib/resend";
import { buildComplaintReceivedEmail } from "../../../lib/email/complaintReceived";
import {
  COMPLAINT_REASONS,
  validateComplaintInput,
  openComplaint,
  type ComplaintReason,
} from "../../../lib/complaintRequest";
import {
  consumeRateLimit,
  rateLimitKeyFromRequest,
  type RateLimitState,
} from "../../../lib/launchRateLimit";

// REKLAMATION - the defect claim, BGB 437/439.
//
// A SEPARATE ROUTE FROM /api/withdrawal, DELIBERATELY. The two rights
// have opposite cost rules - on a defect BGB 439 Abs. 2 puts the
// transport on the seller - so sharing a route would be one refactor
// away from applying the wrong one. Nothing here imports the withdrawal
// modules, and no Wertersatz is ever proposed for a defect.
//
// It has the same public-endpoint defences as /api/withdrawal: honeypot,
// byte ceiling, rate limit, idempotency, and a response that is
// identical whether the order reference matched anything or not.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const MAX_NAME_LEN = 200;
const MAX_EMAIL_LEN = 254;
const MAX_ORDER_REFERENCE_LEN = 200;
const MAX_CUSTOMER_NOTE_LEN = 2000;
const MAX_IDEMPOTENCY_KEY_LEN = 200;
const MIN_IDEMPOTENCY_KEY_LEN = 8;
const MAX_BODY_BYTES = 20_000;

const rateLimitState: RateLimitState = new Map();

type ErrorResponse = { error: string };
type SuccessResponse = { ok: true; submittedAt: string; confirmationEmailSent: boolean };

function tooManyRequests(retryAfterSeconds: number): Response {
  return Response.json(
    { error: "Zu viele Anfragen. Bitte versuche es später erneut." } as ErrorResponse,
    { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } }
  );
}

export async function POST(request: Request): Promise<Response> {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return Response.json({ error: "Ungültige Anfrage." } as ErrorResponse, { status: 400 });
  }

  const bucket = rateLimitKeyFromRequest(request);
  const limit = consumeRateLimit(rateLimitState, bucket, Date.now());
  if (!limit.allowed) return tooManyRequests(limit.retryAfterSeconds);

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

  const { name, email, orderReference, reason, customerNote, website, idempotencyKey } =
    body as Record<string, unknown>;

  if (typeof website === "string" && website.trim() !== "") {
    return Response.json(
      { ok: true, submittedAt: new Date().toISOString(), confirmationEmailSent: false } as SuccessResponse,
      { status: 200 }
    );
  }

  const trimmedName = typeof name === "string" ? name.trim() : "";
  const trimmedEmail = typeof email === "string" ? email.trim() : "";
  const trimmedRef = typeof orderReference === "string" ? orderReference.trim() : "";
  const trimmedNote = typeof customerNote === "string" && customerNote.trim() !== ""
    ? customerNote.trim() : null;

  if (!trimmedName || trimmedName.length > MAX_NAME_LEN) {
    return Response.json({ error: "Bitte gib deinen Namen an." } as ErrorResponse, { status: 400 });
  }
  if (!trimmedEmail || trimmedEmail.length > MAX_EMAIL_LEN || !EMAIL_RE.test(trimmedEmail)) {
    return Response.json({ error: "Bitte gib eine gültige E-Mail-Adresse für die Bestätigung an." } as ErrorResponse, { status: 400 });
  }
  if (!trimmedRef || trimmedRef.length > MAX_ORDER_REFERENCE_LEN) {
    return Response.json({ error: "Bitte gib deine Bestellnummer an." } as ErrorResponse, { status: 400 });
  }
  if (trimmedNote && trimmedNote.length > MAX_CUSTOMER_NOTE_LEN) {
    return Response.json({ error: "Deine Beschreibung ist zu lang." } as ErrorResponse, { status: 400 });
  }
  if (typeof reason !== "string" || !(COMPLAINT_REASONS as readonly string[]).includes(reason)) {
    return Response.json({ error: "Bitte wähle aus, was mit deiner Bestellung nicht stimmt." } as ErrorResponse, { status: 400 });
  }

  const validated = validateComplaintInput({
    customerName: trimmedName,
    contactEmail: trimmedEmail,
    orderReference: trimmedRef,
    reason: reason as ComplaintReason,
    customerNote: trimmedNote,
  });
  if (!validated.ok) {
    return Response.json({ error: validated.reason } as ErrorResponse, { status: 400 });
  }

  let key: string | null = null;
  if (typeof idempotencyKey === "string") {
    const k = idempotencyKey.trim();
    if (k.length >= MIN_IDEMPOTENCY_KEY_LEN && k.length <= MAX_IDEMPOTENCY_KEY_LEN) key = k;
  }

  const admin = getSupabaseAdmin();
  if (!admin) {
    console.error("Complaint error: Supabase admin client is not configured.");
    return Response.json({ error: "Reklamation kann gerade nicht gespeichert werden. Schreib uns direkt an hello@gloamatcha.com." } as ErrorResponse, { status: 503 });
  }

  // ONE CLAIM, HOWEVER MANY CLICKS.
  if (key) {
    const { data: existing } = await admin
      .from("complaint_requests")
      .select("id, submitted_at")
      .eq("idempotency_key", key)
      .maybeSingle();
    if (existing) {
      return Response.json(
        { ok: true, submittedAt: existing.submitted_at as string, confirmationEmailSent: false } as SuccessResponse,
        { status: 200 }
      );
    }
  }

  // Resolution happens server-side and never reaches the response.
  let resolvedOrderId: string | null = null;
  let resolvedUserId: string | null = null;
  try {
    const { data: order } = await admin
      .from("orders")
      .select("id, user_id, customer_snapshot")
      .eq("order_number", trimmedRef)
      .maybeSingle();
    if (order) {
      const snapshot = (order.customer_snapshot ?? {}) as Record<string, unknown>;
      const stored = typeof snapshot.email === "string" ? snapshot.email.trim().toLowerCase() : "";
      if (stored && stored === trimmedEmail.toLowerCase()) {
        resolvedOrderId = order.id as string;
        resolvedUserId = (order.user_id as string | null) ?? null;
      }
    }
  } catch {
    // A lookup failure must not lose the claim.
  }

  const outcome = openComplaint();

  const { data: inserted, error: insertError } = await admin
    .from("complaint_requests")
    .insert({
      customer_name: trimmedName,
      contact_email: trimmedEmail,
      order_reference: trimmedRef,
      resolved_order_id: resolvedOrderId,
      resolved_user_id: resolvedUserId,
      reason,
      customer_note: trimmedNote,
      case_state: outcome.caseState,
      seller_bears_transport_cost: outcome.sellerBearsTransportCost,
      idempotency_key: key,
    })
    .select("id, submitted_at")
    .single();

  if (insertError || !inserted) {
    console.error("Complaint error: could not persist complaint:", insertError?.message);
    return Response.json({ error: "Reklamation kann gerade nicht gespeichert werden. Schreib uns direkt an hello@gloamatcha.com." } as ErrorResponse, { status: 503 });
  }

  let confirmationEmailSent = false;
  const resend = getResendClient();
  const fromAddress = process.env.RESEND_CONTACT_FROM;
  if (resend && fromAddress) {
    const { subject, html, text } = buildComplaintReceivedEmail({
      origin: getSiteOrigin() ?? undefined,
      customerName: trimmedName,
      orderReference: trimmedRef,
      reason: reason as ComplaintReason,
      customerNote: trimmedNote,
      submittedAt: inserted.submitted_at as string,
    });
    try {
      const { error: sendError } = await resend.emails.send({
        from: fromAddress, to: trimmedEmail, replyTo: "hello@gloamatcha.com", subject, html, text,
      });
      confirmationEmailSent = !sendError;
      if (sendError) console.error(`Complaint confirmation email: send failed for ${inserted.id}:`, sendError.message);
    } catch (err) {
      console.error(`Complaint confirmation email: send failed for ${inserted.id}:`,
        err instanceof Error ? err.message : err);
    }
  } else {
    console.error("Complaint confirmation email: RESEND_API_KEY or RESEND_CONTACT_FROM is not configured.");
  }

  await admin
    .from("complaint_requests")
    .update({
      confirmation_status: confirmationEmailSent ? "sent" : "failed",
      confirmed_at: confirmationEmailSent ? new Date().toISOString() : null,
    })
    .eq("id", inserted.id);

  return Response.json(
    { ok: true, submittedAt: inserted.submitted_at as string, confirmationEmailSent } as SuccessResponse,
    { status: 200 }
  );
}
