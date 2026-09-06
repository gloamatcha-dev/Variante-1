import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * THE LAUNCH WAITLIST'S RULES, AS A PURE LEAF.
 *
 * Everything in this module is a function of its arguments: no clock, no
 * network, no database, no environment. That is deliberate and matches
 * lib/annualPlanRules.ts and lib/shipmentTransitionRules.ts - the route
 * handlers do the I/O, and every decision that can be gotten wrong is
 * decided here, where a unit test can drive it with explicit inputs.
 *
 * -- WHAT THIS LIST IS, AND WHAT IT IS NOT --------------------
 * It is a one-time launch notification. A person hands over an email
 * address so GLOA may tell them, once, that the shop is open.
 *
 * It is NOT a newsletter, and the privacy notice says in as many words
 * that GLOA does not run one. Nothing in this module - and nothing that
 * reads it - may turn a row here into recurring marketing: no offers, no
 * product news, no events, no partner mail, no export into a marketing
 * list. A later marketing programme needs its own, separately obtained
 * consent, and this consent record cannot be reused as that one.
 *
 * PURPOSE is written to every row for exactly that reason. It is a single
 * literal, constrained again by a CHECK constraint in the migration, so a
 * row whose purpose is something other than a launch notification cannot
 * physically exist in the table.
 */

/** The one purpose any row on this list may ever carry. */
export const LAUNCH_PURPOSE = "launch_notification" as const;
export type LaunchPurpose = typeof LAUNCH_PURPOSE;

/**
 * The consent wording, verbatim, and the version it belongs to.
 *
 * Stored ON the row rather than only rendered in the form, because what
 * has to be provable later is what THIS person agreed to, not what the
 * current build happens to render. Change the wording, bump the version;
 * older rows keep the text they were actually given.
 */
export const LAUNCH_CONSENT_VERSION = "2026-09-06.launch-notification.v1";
export const LAUNCH_CONSENT_TEXT =
  "Ich möchte per E-Mail benachrichtigt werden, sobald GLOA startet. " +
  "Meine E-Mail-Adresse wird ausschließlich für diese Launch-Benachrichtigung verwendet.";

/** Lifecycle of one entry. `notified` is terminal for this flow. */
export const LAUNCH_STATUSES = ["pending", "confirmed", "withdrawn", "notified"] as const;
export type LaunchStatus = (typeof LAUNCH_STATUSES)[number];

/**
 * Where the entry came in from. A closed set, checked server-side, so a
 * QR code on a flyer can be told apart from the website without turning
 * `?source=` into a free-text field an arbitrary caller can write into
 * the database.
 */
export const LAUNCH_SOURCES = ["launch_page", "homepage", "qr_flyer", "event"] as const;
export type LaunchSource = (typeof LAUNCH_SOURCES)[number];
export const DEFAULT_LAUNCH_SOURCE: LaunchSource = "launch_page";

/**
 * The optional self-selection. Optional in the form, optional here, and
 * deliberately coarse: it exists so GLOA knows roughly who is waiting,
 * not so anyone can be profiled or moved into a B2B pipeline. Choosing
 * "Café / Gastronomie" is not a business enquiry and must never be
 * treated as one.
 */
export const LAUNCH_AUDIENCE_TYPES = ["private", "cafe", "studio", "business", "other"] as const;
export type LaunchAudienceType = (typeof LAUNCH_AUDIENCE_TYPES)[number];

export const MAX_EMAIL_LEN = 254;
export const MAX_FIRST_NAME_LEN = 100;

/**
 * Structural check only - the same one /api/contact uses. Deliverability
 * is the mail provider's answer to give, not a regex's.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Trim and lowercase. The unique constraint in the database is on the
 * value this returns, so "Anna@Example.COM " and "anna@example.com" are
 * one person and cannot become two rows.
 */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export function isValidEmail(normalized: string): boolean {
  return normalized.length > 0 && normalized.length <= MAX_EMAIL_LEN && EMAIL_RE.test(normalized);
}

/**
 * The optional first name. Empty, whitespace-only and over-long values
 * all collapse to null or a cut string rather than failing the request -
 * a name is a courtesy field, and nobody should be kept off the launch
 * list over one.
 */
export function normalizeFirstName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, MAX_FIRST_NAME_LEN);
}

export function isLaunchSource(value: unknown): value is LaunchSource {
  return typeof value === "string" && (LAUNCH_SOURCES as readonly string[]).includes(value);
}

/** Unknown, absent or hostile `?source=` values fall back, never store. */
export function resolveSource(value: unknown): LaunchSource {
  return isLaunchSource(value) ? value : DEFAULT_LAUNCH_SOURCE;
}

export function isLaunchAudienceType(value: unknown): value is LaunchAudienceType {
  return typeof value === "string" && (LAUNCH_AUDIENCE_TYPES as readonly string[]).includes(value);
}

/** Optional means optional: anything not on the list becomes null. */
export function resolveAudienceType(value: unknown): LaunchAudienceType | null {
  return isLaunchAudienceType(value) ? value : null;
}

/* ==============================================================
   TOKENS

   Two per row: one to confirm the entry, one to withdraw it. Both are
   opaque random values handed out only in the email, and only their
   SHA-256 hash is ever written to the database - so a copy of the table
   does not let anyone confirm or cancel somebody else's entry.

   The email address itself never travels in a link. A URL is logged by
   proxies, kept in browser history and leaked in Referer headers; an
   address in a query string is an address published to every one of
   those. The token identifies the row instead.
   ============================================================== */

/** 32 bytes, hex. Never stored - only its hash is. */
export function createToken(): string {
  return randomBytes(32).toString("hex");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** A token is only ever compared as a hash, in constant time. */
export function tokenMatchesHash(token: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashToken(token), "utf8");
  const expected = Buffer.from(expectedHash, "utf8");
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

/** Rejects the obviously-wrong shape before any database round-trip. */
export function isWellFormedToken(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

/**
 * A pending entry that is never confirmed is not consent, so it may not
 * be kept. Fourteen days is long enough for someone to find the mail in
 * a spam folder and short enough that unconfirmed addresses do not
 * accumulate. The deletion itself is an operational job - this constant
 * is the rule it implements, and the migration documents it.
 */
export const PENDING_RETENTION_DAYS = 14;

/** Confirmation links expire on the same clock. */
export const CONFIRMATION_TOKEN_TTL_DAYS = 14;

export function isConfirmationExpired(sentAtIso: string | null, nowMs: number): boolean {
  if (!sentAtIso) return true;
  const sentMs = Date.parse(sentAtIso);
  if (Number.isNaN(sentMs)) return true;
  return nowMs - sentMs > CONFIRMATION_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000;
}

/**
 * MAY GLOA STILL SEND THIS PERSON THE LAUNCH MAIL?
 *
 * The single gate every future launch send has to pass, expressed once
 * so no caller can invent a looser rule of its own.
 *
 *   pending    no - the address was never confirmed
 *   withdrawn  no - consent was taken back, and that is permanent here
 *   notified   no - the one message this consent covers has been sent
 *   confirmed  yes, exactly once
 *
 * Note what is NOT here: there is no state in which this row permits any
 * message other than the launch notification.
 */
export function mayReceiveLaunchNotification(row: {
  status: LaunchStatus;
  purpose: string;
  launch_notification_sent_at: string | null;
}): boolean {
  if (row.purpose !== LAUNCH_PURPOSE) return false;
  if (row.status !== "confirmed") return false;
  return row.launch_notification_sent_at === null;
}
