import { getSupabaseAdmin } from "../../../lib/supabaseAdmin";
import { buildWithdrawalSubmissionDeps } from "../../../lib/withdrawalSubmissionDeps";
import { submitWithdrawal } from "../../../lib/withdrawalSubmission";
import {
  consumeRateLimit,
  rateLimitKeyFromRequest,
  type RateLimitState,
} from "../../../lib/launchRateLimit";

// § 356a BGB electronic withdrawal function.
//
// ── WHAT CHANGED, AND WHAT DID NOT (migration 070) ───────────
//
// This route used to do one bare INSERT of the declaration. It now runs
// the whole case through lib/withdrawalSubmission.ts: the order is
// resolved, the receipt is read, the deadline is computed by
// lib/withdrawalDeadline.ts, and an annual plan's future deliveries are
// frozen where the case cannot safely be refused.
//
// WHAT DID NOT CHANGE IS THE THING THAT MATTERS MOST HERE: the response.
// It is byte-identical whether the reference matched a real order, a
// real order belonging to somebody else, or nothing at all - so this
// still cannot be used to enumerate or confirm order numbers. The
// resolution happens entirely server-side and is written to columns no
// browser can read.
//
// The route stays a parser: shapes, sizes and a rate limit. Every
// decision that has a legal consequence is made in the module beside it,
// where it can be tested without a network.

const ALLOWED_SCOPE = ["whole_order", "partial"] as const;
type Scope = (typeof ALLOWED_SCOPE)[number];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const MAX_NAME_LEN = 200;
const MAX_EMAIL_LEN = 254;
const MAX_ORDER_REFERENCE_LEN = 200;
const MAX_SCOPE_NOTE_LEN = 500;
const MAX_CUSTOMER_NOTE_LEN = 2000;
const MAX_IDEMPOTENCY_KEY_LEN = 200;
const MIN_IDEMPOTENCY_KEY_LEN = 8;

// Generous ceiling on the raw request body, rejecting obviously
// oversized payloads before they're even parsed as JSON.
const MAX_BODY_BYTES = 20_000;

/** In-process, per-caller. The same shape /api/launch uses. */
const rateLimitState: RateLimitState = new Map();

type ErrorResponse = { error: string };
type SuccessResponse = { ok: true; submittedAt: string; confirmationEmailSent: boolean };

function isScope(value: unknown): value is Scope {
  return typeof value === "string" && (ALLOWED_SCOPE as readonly string[]).includes(value);
}

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

  // Before the body is read: counts every request that gets this far.
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
    name, email, orderReference, scope, scopeNote, customerNote, website, idempotencyKey,
  } = body as Record<string, unknown>;

  // Honeypot: same silent-discard pattern as /api/contact.
  if (typeof website === "string" && website.trim() !== "") {
    return Response.json(
      { ok: true, submittedAt: new Date().toISOString(), confirmationEmailSent: false } as SuccessResponse,
      { status: 200 }
    );
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

  // The browser's own retry token. Out-of-range values are DROPPED
  // rather than refused: a bad key must not cost somebody their
  // declaration, it only costs them the duplicate protection.
  let key: string | null = null;
  if (typeof idempotencyKey === "string") {
    const k = idempotencyKey.trim();
    if (k.length >= MIN_IDEMPOTENCY_KEY_LEN && k.length <= MAX_IDEMPOTENCY_KEY_LEN) key = k;
  }

  const admin = getSupabaseAdmin();
  if (!admin) {
    console.error("Withdrawal error: Supabase admin client is not configured.");
    return Response.json({ error: "Widerruf kann gerade nicht gespeichert werden. Schreib uns direkt an hello@gloamatcha.com." } as ErrorResponse, { status: 503 });
  }

  try {
    const result = await submitWithdrawal(buildWithdrawalSubmissionDeps(admin), {
      customerName: trimmedName,
      contactEmail: trimmedEmail,
      orderReference: trimmedOrderReference,
      scope,
      scopeNote: trimmedScopeNote,
      customerNote: trimmedCustomerNote,
      idempotencyKey: key,
      // No session is read here: § 356a must work logged out, and an
      // authenticated caller gains nothing this route would expose.
      sessionUserId: null,
    });

    // THE SAME THREE FIELDS IN EVERY CASE. No case id, no timeliness, no
    // deadline, no resolution, and no hint that a duplicate was
    // recognised - a differing shape would be the leak.
    return Response.json(
      {
        ok: true,
        submittedAt: result.submittedAt,
        confirmationEmailSent: result.confirmationEmailSent,
      } as SuccessResponse,
      { status: 200 }
    );
  } catch (err) {
    console.error("Withdrawal error: could not persist withdrawal request:",
      err instanceof Error ? err.message : err);
    return Response.json({ error: "Widerruf kann gerade nicht gespeichert werden. Schreib uns direkt an hello@gloamatcha.com." } as ErrorResponse, { status: 503 });
  }
}
