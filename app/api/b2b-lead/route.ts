import { getResendClient } from "../../../lib/resend";
import { getSupabaseAdmin } from "../../../lib/supabaseAdmin";
import {
  LAUNCH_RATE_LIMIT_WINDOW_SECONDS,
  pseudonymizeBucketKey,
  rateLimitKeyFromRequest,
} from "../../../lib/launchRateLimit";
import { consumePersistentRateLimit } from "../../../lib/launchRateLimitStore";
import {
  validateB2bLeadRequest,
  buildB2bLeadNotificationSubject,
  buildB2bLeadNotificationText,
} from "../../../lib/b2bLeadRequest.ts";

/**
 * POST /api/b2b-lead — the B2B enquiry from /for-cafes.
 *
 * ── WHAT THIS FIXES ──────────────────────────────────────────
 *
 * The form on /for-cafes has been live and has been discarding every
 * enquiry: it dispatched a browser CustomEvent that nothing listened
 * for, then showed "Danke. Wir melden uns." A visitor who asked GLOA
 * for wholesale conditions was told they would hear back, and nobody
 * ever could, because the enquiry never left their browser.
 *
 * ── DELIBERATELY THE SAME SHAPE AS THE OTHER PUBLIC FORMS ────
 *
 * Copied from /api/partnerships rather than reinvented, so the three
 * public forms cannot drift into having different defences:
 *   - JSON content type required
 *   - a byte ceiling on the body, checked before parsing
 *   - a honeypot field, answered with the success shape and no mail
 *   - the recipient is a server constant, never read from the client
 *   - plain text only, so nothing submitted is ever rendered as markup
 *
 * ── AND IT IS RATE LIMITED, SHARING /api/launch's COUNTER ────
 *
 * 4A.4a shipped without one on the reasoning that this form mails a
 * FIXED internal address and can therefore only ever spam GLOA's own
 * inbox - which is true, and is why /api/contact and /api/partnerships
 * have never had one either. It is also not much comfort at three in
 * the morning: a bot that gets past the honeypot can fill the inbox the
 * enquiries are supposed to arrive in, which is the same outcome as
 * losing them.
 *
 * So it uses the SHARED PERSISTENT counter from migration 043, the one
 * /api/launch already uses - not a new limiter, and not an in-process
 * one, which on a platform that hands out fresh instances under load is
 * a limit per instance rather than a limit.
 *
 * ── AND IT WRITES NO BUSINESS DATA ───────────────────────────
 *
 * The Supabase client below exists ONLY to reach that counter. There is
 * no table for enquiries, no migration behind them, and no admin
 * activity row - a public enquiry is not an administrative act and must
 * not appear in the audit trail as one.
 */

// Fixed, server-chosen recipient - never taken from the client.
const B2B_RECIPIENT = "hello@gloamatcha.com";

// Generous ceiling on the raw request body - well above any real
// submission, just to reject obviously oversized payloads before
// they're even parsed as JSON.
const MAX_BODY_BYTES = 20_000;

/**
 * Conservative, and sized for a human rather than for a campaign: a café
 * owner writes to GLOA once, maybe twice if they mistyped something. The
 * window is the shared one from migration 043.
 */
const ENQUIRIES_PER_WINDOW = 5;

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

  // Honeypot: a field a real visitor never sees or fills in. A bot that
  // autofills every input populates it. Discard silently with the same
  // success shape as a real submission - never send mail, never reveal
  // to the caller that detection happened.
  const { website } = body as Record<string, unknown>;
  if (typeof website === "string" && website.trim() !== "") {
    return Response.json({ ok: true } as SuccessResponse, { status: 200 });
  }

  const validated = validateB2bLeadRequest(body);
  if (!validated.ok) {
    return Response.json({ error: validated.error } as ErrorResponse, { status: 400 });
  }
  const lead = validated.value;

  // ── THE LIMIT, AFTER VALIDATION AND BEFORE THE MAIL ─────────
  //
  // After validation, so a caller posting rubbish does not get to spend
  // a database round trip - it was already refused for free. Before
  // Resend, which is the whole point: a refused caller must not be able
  // to make GLOA's sending domain deliver anything.
  //
  // The caller's address exists only as `callerBucket` inside this
  // handler. What reaches the database, and what could ever reach a
  // database log, is the digest below and nothing else - and neither is
  // ever written to a log line here.
  const supabase = getSupabaseAdmin();
  const bucketSecret = process.env.LAUNCH_RATE_LIMIT_SECRET || process.env.SUPABASE_SECRET_KEY;
  if (!supabase || !bucketSecret) {
    console.error("B2B lead form error: the shared rate limit is not configured - refusing.");
    return Response.json({ error: SEND_FAILED } as ErrorResponse, { status: 503 });
  }

  const callerBucket = rateLimitKeyFromRequest(request);
  const limit = await consumePersistentRateLimit(
    supabase,
    pseudonymizeBucketKey(`b2b-lead:${callerBucket}`, bucketSecret),
    ENQUIRIES_PER_WINDOW,
    LAUNCH_RATE_LIMIT_WINDOW_SECONDS
  );

  if (limit.kind === "limited") {
    return Response.json({ error: SEND_FAILED } as ErrorResponse, {
      status: 429,
      headers: { "Retry-After": String(Math.max(1, Math.ceil(limit.retryAfterSeconds))) },
    });
  }
  // FAILS CLOSED, for the same reason /api/launch does: what is left
  // when the shared counter cannot be reached is not a weaker limit, it
  // is no limit at all across instances. A database outage costing GLOA
  // a few enquiries is recoverable; an unbounded one is not.
  if (limit.kind === "unavailable") {
    console.error("B2B lead form error: shared rate limit unavailable - refusing:", limit.reason);
    return Response.json({ error: SEND_FAILED } as ErrorResponse, { status: 503 });
  }

  const resend = getResendClient();
  const fromAddress = process.env.RESEND_CONTACT_FROM;
  if (!resend || !fromAddress) {
    console.error("B2B lead form error: RESEND_API_KEY or RESEND_CONTACT_FROM is not configured.");
    return Response.json(
      { error: "B2B-Formular vorübergehend nicht verfügbar. Schreib uns direkt an hello@gloamatcha.com." } as ErrorResponse,
      { status: 503 }
    );
  }

  try {
    const { error } = await resend.emails.send({
      from: fromAddress,
      to: B2B_RECIPIENT,
      // Answering the enquiry is the whole point, so the reply goes
      // back to the address that asked - validated above, never raw.
      replyTo: lead.email,
      subject: buildB2bLeadNotificationSubject(lead),
      text: buildB2bLeadNotificationText(lead),
    });

    if (error) {
      // The provider's own message only. Never the enquiry: no name, no
      // address, no message body reaches a log line.
      console.error("B2B lead form error: Resend rejected the message:", error.message);
      return Response.json({ error: SEND_FAILED } as ErrorResponse, { status: 502 });
    }
  } catch (err) {
    console.error("B2B lead form error:", err instanceof Error ? err.message : err);
    return Response.json({ error: SEND_FAILED } as ErrorResponse, { status: 502 });
  }

  return Response.json({ ok: true } as SuccessResponse, { status: 200 });
}
