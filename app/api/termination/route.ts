import { getSupabaseAdmin } from "../../../lib/supabaseAdmin";
import { getSiteOrigin } from "../../../lib/siteUrl";
import { getResendClient } from "../../../lib/resend";
import { buildTerminationReceivedEmail } from "../../../lib/email/terminationReceived";
import {
  validateTerminationInput,
  resolveTerminationOutcome,
  type TerminationKind,
  type TerminationContractKind,
} from "../../../lib/terminationRequest";
import {
  consumeRateLimit,
  rateLimitKeyFromRequest,
  type RateLimitState,
} from "../../../lib/launchRateLimit";

// THE KÜNDIGUNGSBUTTON - BGB 312k.
//
// Public, reachable without an account, and required for the annual plan
// as well as the subscription: BGH 22.05.2025 - I ZR 161/24 held that a
// one-off payment with a fixed term that ends automatically is still a
// Dauerschuldverhältnis, because what matters is the trader's continuing
// obligation to perform.
//
// ── WHAT THIS ROUTE MUST NEVER DO ────────────────────────────
//
// Refund anything, call Stripe, or stop a delivery. A termination ends a
// contract going forward; it reverses nothing. The decision layer
// (lib/terminationRequest.ts) returns triggersRefund: false and
// stopsDeliveries: false for every path, and this route carries no
// Stripe import at all.
//
// For an identified 4-WEEK SUBSCRIPTION the outcome says
// routeToSubscriptionCancellation, and the existing server-side
// cancellation logic is what applies it - it is not reimplemented here.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const MAX_NAME_LEN = 200;
const MAX_EMAIL_LEN = 254;
const MAX_REFERENCE_LEN = 200;
const MAX_REASON_LEN = 2000;
const MAX_IDEMPOTENCY_KEY_LEN = 200;
const MIN_IDEMPOTENCY_KEY_LEN = 8;
const MAX_BODY_BYTES = 20_000;

const rateLimitState: RateLimitState = new Map();

type ErrorResponse = { error: string };
type SuccessResponse = {
  ok: true;
  submittedAt: string;
  confirmationEmailSent: boolean;
  /** The substance of what happens next - the same text the mail carries. */
  message: string;
};

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

  const {
    name, email, contractReference, terminationKind, requestedEndAt,
    extraordinaryReason, website, idempotencyKey,
  } = body as Record<string, unknown>;

  if (typeof website === "string" && website.trim() !== "") {
    return Response.json(
      {
        ok: true, submittedAt: new Date().toISOString(),
        confirmationEmailSent: false,
        message: "Deine Kündigung ist bei uns eingegangen.",
      } as SuccessResponse,
      { status: 200 }
    );
  }

  const trimmedName = typeof name === "string" ? name.trim() : "";
  const trimmedEmail = typeof email === "string" ? email.trim() : "";
  const trimmedRef = typeof contractReference === "string" ? contractReference.trim() : "";
  const trimmedReason = typeof extraordinaryReason === "string" && extraordinaryReason.trim() !== ""
    ? extraordinaryReason.trim() : null;

  if (trimmedName.length > MAX_NAME_LEN || trimmedEmail.length > MAX_EMAIL_LEN
      || trimmedRef.length > MAX_REFERENCE_LEN
      || (trimmedReason !== null && trimmedReason.length > MAX_REASON_LEN)) {
    return Response.json({ error: "Deine Angaben sind zu lang." } as ErrorResponse, { status: 400 });
  }
  if (trimmedEmail && !EMAIL_RE.test(trimmedEmail)) {
    return Response.json({ error: "Bitte gib eine gültige E-Mail-Adresse für die Bestätigung an." } as ErrorResponse, { status: 400 });
  }

  const kind = terminationKind === "extraordinary" ? "extraordinary" : "ordinary";

  const validated = validateTerminationInput({
    terminationKind: kind as TerminationKind,
    customerName: trimmedName,
    contractReference: trimmedRef,
    contactEmail: trimmedEmail,
    requestedEndAt: typeof requestedEndAt === "string" ? requestedEndAt : null,
    extraordinaryReason: trimmedReason,
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
    console.error("Termination error: Supabase admin client is not configured.");
    return Response.json({ error: "Kündigung kann gerade nicht gespeichert werden. Schreib uns direkt an hello@gloamatcha.com." } as ErrorResponse, { status: 503 });
  }

  if (key) {
    const { data: existing } = await admin
      .from("termination_requests")
      .select("id, submitted_at, case_state")
      .eq("idempotency_key", key)
      .maybeSingle();
    if (existing) {
      return Response.json(
        {
          ok: true, submittedAt: existing.submitted_at as string,
          confirmationEmailSent: false,
          message: "Deine Kündigung ist bei uns eingegangen.",
        } as SuccessResponse,
        { status: 200 }
      );
    }
  }

  // ── WHICH CONTRACT, RESOLVED SERVER-SIDE ────────────────────
  let contractKind: TerminationContractKind = "unresolved";
  let resolvedUserId: string | null = null;
  let resolvedAnnualPlanId: string | null = null;
  let resolvedSubscriptionId: string | null = null;
  let planEndAt: string | null = null;

  try {
    const { data: order } = await admin
      .from("orders")
      .select("id, user_id, customer_snapshot")
      .eq("order_number", trimmedRef)
      .maybeSingle();

    let ownerId: string | null = null;
    if (order) {
      const snapshot = (order.customer_snapshot ?? {}) as Record<string, unknown>;
      const stored = typeof snapshot.email === "string" ? snapshot.email.trim().toLowerCase() : "";
      if (stored && stored === trimmedEmail.toLowerCase()) {
        ownerId = (order.user_id as string | null) ?? null;
        resolvedUserId = ownerId;
      }
      if (ownerId) {
        const { data: delivery } = await admin
          .from("annual_plan_deliveries")
          .select("annual_plan_id")
          .eq("order_id", order.id)
          .maybeSingle();
        if (delivery?.annual_plan_id) {
          const { data: plan } = await admin
            .from("annual_plans")
            .select("id, plan_end_at")
            .eq("id", delivery.annual_plan_id)
            .maybeSingle();
          if (plan) {
            contractKind = "annual_plan";
            resolvedAnnualPlanId = plan.id as string;
            planEndAt = (plan.plan_end_at as string | null) ?? null;
          }
        }
      }
    }

    // No annual plan resolved: try the customer's live 4-week subscription.
    if (contractKind === "unresolved" && resolvedUserId) {
      const { data: sub } = await admin
        .from("subscriptions")
        .select("id")
        .eq("user_id", resolvedUserId)
        .eq("status", "active")
        .maybeSingle();
      if (sub) {
        contractKind = "subscription_4w";
        resolvedSubscriptionId = sub.id as string;
      }
    }
  } catch {
    // An unresolved contract is still a received termination.
  }

  const outcome = resolveTerminationOutcome({
    terminationKind: kind as TerminationKind,
    contractKind,
    planEndAt,
  });

  const { data: inserted, error: insertError } = await admin
    .from("termination_requests")
    .insert({
      termination_kind: kind,
      customer_name: trimmedName,
      contract_reference: trimmedRef,
      contact_email: trimmedEmail,
      resolved_user_id: resolvedUserId,
      resolved_subscription_id: resolvedSubscriptionId,
      resolved_annual_plan_id: resolvedAnnualPlanId,
      contract_kind: contractKind,
      requested_end_at: typeof requestedEndAt === "string" ? requestedEndAt : null,
      extraordinary_reason: trimmedReason,
      case_state: outcome.caseState,
      idempotency_key: key,
    })
    .select("id, submitted_at")
    .single();

  if (insertError || !inserted) {
    console.error("Termination error: could not persist termination:", insertError?.message);
    return Response.json({ error: "Kündigung kann gerade nicht gespeichert werden. Schreib uns direkt an hello@gloamatcha.com." } as ErrorResponse, { status: 503 });
  }

  // THE 4-WEEK SUBSCRIPTION IS CANCELLED BY THE EXISTING LOGIC, not
  // here. The case is recorded as 'scheduled' and an administrator
  // drives lib/subscriptionCancellation.ts from the Consumer Rights
  // screen, which keeps the 14-day cutoff rules in exactly one place.

  let confirmationEmailSent = false;
  const resend = getResendClient();
  const fromAddress = process.env.RESEND_CONTACT_FROM;
  if (resend && fromAddress) {
    const { subject, html, text } = buildTerminationReceivedEmail({
      origin: getSiteOrigin() ?? undefined,
      customerName: trimmedName,
      contractReference: trimmedRef,
      terminationKind: kind as TerminationKind,
      submittedAt: inserted.submitted_at as string,
      outcomeMessage: outcome.message,
    });
    try {
      const { error: sendError } = await resend.emails.send({
        from: fromAddress, to: trimmedEmail, replyTo: "hello@gloamatcha.com", subject, html, text,
      });
      confirmationEmailSent = !sendError;
      if (sendError) console.error(`Termination confirmation email: send failed for ${inserted.id}:`, sendError.message);
    } catch (err) {
      console.error(`Termination confirmation email: send failed for ${inserted.id}:`,
        err instanceof Error ? err.message : err);
    }
  } else {
    console.error("Termination confirmation email: RESEND_API_KEY or RESEND_CONTACT_FROM is not configured.");
  }

  await admin
    .from("termination_requests")
    .update({
      confirmation_status: confirmationEmailSent ? "sent" : "failed",
      confirmed_at: confirmationEmailSent ? new Date().toISOString() : null,
    })
    .eq("id", inserted.id);

  return Response.json(
    {
      ok: true,
      submittedAt: inserted.submitted_at as string,
      confirmationEmailSent,
      message: outcome.message,
    } as SuccessResponse,
    { status: 200 }
  );
}
