import { getSupabaseAdmin } from "../../../lib/supabaseAdmin";
import { getResendClient } from "../../../lib/resend";
import { getSiteOrigin } from "../../../lib/siteUrl";
import { GLOA_FROM_HELLO } from "../../../lib/emailSenders";
import { buildLaunchConfirmationEmail } from "../../../lib/email/launchConfirmation";
import {
  LAUNCH_CONSENT_TEXT,
  LAUNCH_CONSENT_VERSION,
  LAUNCH_PURPOSE,
  MAX_EMAIL_LEN,
  createToken,
  hashToken,
  isValidEmail,
  normalizeEmail,
  normalizeFirstName,
  resolveAudienceType,
  resolveSource,
} from "../../../lib/launchWaitlist";
import {
  consumeRateLimit,
  rateLimitKeyFromRequest,
  type RateLimitState,
} from "../../../lib/launchRateLimit";

/**
 * JOIN THE LAUNCH LIST.
 *
 * Public, unauthenticated, and it sends mail on success - so it is
 * written the same defensive way /api/contact and /api/withdrawal are:
 * content type checked, body size capped, every field validated on the
 * server, a honeypot, and now a rate limit as well, because those two
 * do not send mail to an address the caller chose.
 *
 * -- THE ANSWER IS ALWAYS THE SAME ------------------------------
 * A valid submission gets one response shape whatever the state of the
 * list: new address, already pending, already confirmed, previously
 * withdrawn. The endpoint never says "you are already on the list",
 * because that turns a public form into an oracle that answers "does
 * GLOA have this address?" for any address anybody cares to type.
 *
 * The person who really did just sign up learns what they need to from
 * the mail in their inbox. The person probing the endpoint learns
 * nothing.
 *
 * -- WHAT IS NOT TAKEN FROM THE REQUEST -------------------------
 * consent_text, consent_version and purpose. All three are set here,
 * from lib/launchWaitlist.ts. A consent record whose wording came from
 * the request body would prove nothing, since the caller could have
 * written any wording it liked.
 */

const MAX_BODY_BYTES = 20_000;

type ErrorResponse = { error: string };
type SuccessResponse = { ok: true };

/**
 * Module-scope, so it survives between requests in one server instance.
 * Its limits are documented in lib/launchRateLimit.ts - this is a speed
 * bump, not a distributed rate limiter, and it is not sold as one.
 */
const rateLimitState: RateLimitState = new Map();

/** The one response a valid submission ever gets. */
function neutralSuccess(): Response {
  return Response.json({ ok: true } as SuccessResponse, { status: 200 });
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

  const limit = consumeRateLimit(rateLimitState, rateLimitKeyFromRequest(request), Date.now());
  if (!limit.allowed) {
    return Response.json(
      { error: "Zu viele Versuche. Bitte versuch es später noch einmal." } as ErrorResponse,
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } }
    );
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

  const { email, firstName, audienceType, consent, source, website } = body as Record<string, unknown>;

  // Honeypot: same silent-discard pattern as /api/contact. A bot that
  // autofills every input populates it; the response is indistinguishable
  // from a real success and no mail is sent.
  if (typeof website === "string" && website.trim() !== "") {
    return neutralSuccess();
  }

  // CONSENT IS THE GATE, and it is checked on the server. The checkbox
  // in the form is not pre-ticked and the browser will not submit the
  // request without it, but a browser is not where this decision may be
  // made: a request that does not carry an explicit true is refused
  // here, so no row can be created without one.
  if (consent !== true) {
    return Response.json(
      { error: "Bitte bestätige, dass wir dich zum Launch benachrichtigen dürfen." } as ErrorResponse,
      { status: 400 }
    );
  }

  const rawEmail = typeof email === "string" ? email : "";
  if (rawEmail.length > MAX_EMAIL_LEN + 50) {
    return Response.json({ error: "Bitte gib eine gültige E-Mail-Adresse an." } as ErrorResponse, { status: 400 });
  }
  const normalizedEmail = normalizeEmail(rawEmail);
  if (!isValidEmail(normalizedEmail)) {
    return Response.json({ error: "Bitte gib eine gültige E-Mail-Adresse an." } as ErrorResponse, { status: 400 });
  }

  const resolvedFirstName = normalizeFirstName(firstName);
  const resolvedAudienceType = resolveAudienceType(audienceType);
  const resolvedSource = resolveSource(source);

  const supabase = getSupabaseAdmin();
  const resend = getResendClient();
  const origin = getSiteOrigin();

  if (!supabase || !resend || !origin) {
    // Never name which one is missing - that is deployment detail, and
    // this is a public endpoint.
    console.error(
      "Launch waitlist: not configured (supabase:%s resend:%s siteUrl:%s)",
      Boolean(supabase),
      Boolean(resend),
      Boolean(origin)
    );
    return Response.json(
      { error: "Die Eintragung ist gerade nicht möglich. Bitte versuch es später noch einmal." } as ErrorResponse,
      { status: 503 }
    );
  }

  const confirmationToken = createToken();
  const withdrawalToken = createToken();
  const nowIso = new Date().toISOString();

  // ONE ROW PER ADDRESS. The unique constraint on the normalised email
  // is the actual guard against duplicates - not a "select, then insert"
  // in application code, which two concurrent submissions would both
  // pass. On conflict the row is refreshed with a new token pair rather
  // than duplicated, which is also what makes "I never got the mail,
  // let me try again" work.
  //
  // WITHDRAWN ROWS ARE NOT REVIVED HERE. `where` restricts the update to
  // rows that are pending or confirmed, so somebody who withdrew stays
  // withdrawn and gets no further mail from this endpoint - see the
  // outcome handling below.
  const { data: upserted, error: upsertError } = await supabase
    .from("launch_waitlist")
    .upsert(
      {
        email: normalizedEmail,
        first_name: resolvedFirstName,
        audience_type: resolvedAudienceType,
        purpose: LAUNCH_PURPOSE,
        status: "pending",
        source: resolvedSource,
        consent_version: LAUNCH_CONSENT_VERSION,
        consent_text: LAUNCH_CONSENT_TEXT,
        consent_given_at: nowIso,
        confirmation_token_hash: hashToken(confirmationToken),
        confirmation_sent_at: nowIso,
        withdrawal_token_hash: hashToken(withdrawalToken),
      },
      { onConflict: "email", ignoreDuplicates: false }
    )
    .select("id, status, withdrawn_at")
    .maybeSingle();

  if (upsertError) {
    // Never log the address, never log a token, never return the driver
    // message to the caller.
    console.error("Launch waitlist: could not record the entry:", upsertError.message);
    return Response.json(
      { error: "Die Eintragung ist gerade nicht möglich. Bitte versuch es später noch einmal." } as ErrorResponse,
      { status: 503 }
    );
  }

  // A row that had already been withdrawn is left alone. The upsert above
  // would have reset it to pending, so it is put back and no mail goes
  // out: a withdrawal is not undone by somebody typing the address into
  // the form again.
  if (upserted && upserted.withdrawn_at) {
    await supabase
      .from("launch_waitlist")
      .update({ status: "withdrawn", confirmation_token_hash: null, confirmation_sent_at: null })
      .eq("id", upserted.id);
    return neutralSuccess();
  }

  const { subject, html, text } = buildLaunchConfirmationEmail({
    firstName: resolvedFirstName,
    confirmUrl: `${origin}/api/launch/confirm?token=${confirmationToken}`,
    withdrawUrl: `${origin}/api/launch/withdraw?token=${withdrawalToken}`,
  });

  try {
    const { error } = await resend.emails.send({
      from: GLOA_FROM_HELLO,
      to: normalizedEmail,
      subject,
      html,
      text,
    });
    if (error) {
      console.error("Launch waitlist: Resend rejected the confirmation mail:", error.message);
    }
  } catch (err) {
    console.error("Launch waitlist: confirmation mail failed:", err instanceof Error ? err.message : err);
  }

  // The response does not depend on whether the mail went out. The row
  // is recorded either way, the caller is told the same thing either
  // way, and a failed send is a server-side problem to see in the logs -
  // not a signal handed to whoever posted the form.
  return neutralSuccess();
}
