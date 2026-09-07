import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CONFIRMATION_TOKEN_TTL_DAYS,
  LAUNCH_AUDIENCE_TYPES,
  LAUNCH_CONSENT_TEXT,
  LAUNCH_CONSENT_TEXT_V1,
  LAUNCH_CONSENT_VERSION,
  LAUNCH_CONSENT_VERSIONS,
  LAUNCH_CONSENT_VERSION_V1,
  LAUNCH_PURPOSE,
  LAUNCH_SOURCES,
  PENDING_RETENTION_DAYS,
  createToken,
  hashToken,
  isConfirmationExpired,
  isValidEmail,
  isWellFormedToken,
  mayReceiveLaunchNotification,
  mayReceiveWelcomeEmail,
  normalizeEmail,
  normalizeFirstName,
  resolveAudienceType,
  resolveSource,
  tokenMatchesHash,
} from "../lib/launchWaitlist.ts";

import {
  LAUNCH_RATE_LIMIT_MAX,
  LAUNCH_RATE_LIMIT_WINDOW_MS,
  LAUNCH_RATE_LIMIT_WINDOW_SECONDS,
  consumeRateLimit,
  isBucketKey,
  pseudonymizeBucketKey,
  rateLimitKeyFromRequest,
} from "../lib/launchRateLimit.ts";

import { consumePersistentRateLimit } from "../lib/launchRateLimitStore.ts";

import {
  RETENTION_BATCH_LIMIT,
  RETENTION_PENDING_DAYS,
  RETENTION_SWEEPABLE_STATUS,
  emptyRetentionSummary,
  isSweepablePendingEntry,
  pendingRetentionCutoff,
  sweepExpiredPendingEntries,
} from "../lib/launchWaitlistRetention.ts";

import { buildLaunchConfirmationEmail } from "../lib/email/launchConfirmation.ts";
import { buildLaunchWelcomeEmail } from "../lib/email/launchWelcome.ts";

import {
  sendWelcomeEmail,
  welcomeIdempotencyKey,
} from "../lib/launchWelcomeSend.ts";

import {
  LAUNCH_DISCOUNT_FROM_LABEL,
  LAUNCH_DISCOUNT_UNTIL_LABEL,
} from "../lib/launchDiscount.ts";

// The launch announcement key, imported under a distinct name so test
// 109 can prove the two mails use different idempotency namespaces.
import { idempotencyKey as idempotencyKeyForLaunch } from "../lib/launchSend.ts";

import {
  isMissingFunctionError,
  legacyConfirm,
  legacySignup,
} from "../lib/launchSignupCompat.ts";

import {
  GLOA_BERRY,
  GLOA_BLUE,
  GLOA_CREAM,
  GLOA_NEAR_BLACK,
  GLOA_PLUM,
  LOGO_DISPLAY_HEIGHT,
  LOGO_DISPLAY_WIDTH,
} from "../lib/email/brand.ts";

/* ══════════════════════════════════════════════════════════════
   THE LAUNCH WAITLIST

   SAFE DEFAULT SUITE: pure functions driven with explicit inputs, plus
   source-level checks on the page, the routes, the migration and the
   privacy notice.

   Nothing here reads a wall clock - every expiry assertion passes its
   own `now` - and nothing renders a page, opens a socket, constructs a
   Supabase or Resend client, or touches a database.

   WHAT THIS SUITE IS ACTUALLY PROTECTING is one promise: that an email
   address given for a launch notification is used for the launch
   notification and for nothing else. Most of the assertions below exist
   to make that promise expensive to break by accident - which is the
   only way it would ever be broken.
   ══════════════════════════════════════════════════════════════ */

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf-8");

/**
 * COMMENTS ARE NOT CODE, AND THIS SUITE MUST NOT CONFUSE THE TWO.
 *
 * Several assertions below ban a word - "defaultChecked", "YOU'RE ON
 * THE LIST", "delete from public." - and the source files discuss those
 * exact words in comments precisely in order to forbid them. Matching
 * there is the opposite of a bug: it would mean a file is penalised for
 * explaining itself, and the honest fix would be to delete the
 * explanation. So the banned-word checks run against code with the
 * prose removed.
 *
 * Line comments are only stripped when the line STARTS with `//`, so a
 * `https://` inside a string is never mistaken for one.
 */
const stripJs = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const stripSql = (src) => src.replace(/^\s*--.*$/gm, "");

/**
 * WHERE THE SIGNUP ACTUALLY WRITES.
 *
 * It used to be an upsert in this route. Migration 046 moved the whole
 * decision into one locked statement, so the write is now a single RPC
 * call - and every ordering assertion below asks about THAT rather than
 * naming a Supabase method that no longer appears in the file.
 */
const SIGNUP_WRITE = 'supabase.rpc("submit_launch_signup"';

const launchPage = read("app/LaunchPage.tsx");
const signupRoute = read("app/api/launch/route.ts");
const confirmRoute = read("app/api/launch/confirm/route.ts");
const withdrawRoute = read("app/api/launch/withdraw/route.ts");
const migration = read("supabase/migrations/043_launch_waitlist.sql");
const retentionLib = read("lib/launchWaitlistRetention.ts");
const cronRoute = read("app/api/cron/retry-order-notifications/route.ts");
const gloaSite = read("app/GloaSite.tsx");
const emailTemplate = read("lib/email/launchConfirmation.ts");

/* ── 1. Email normalisation ─────────────────────────────────── */

test("1: the email is trimmed and lowercased, so one person cannot become two rows", () => {
  assert.equal(normalizeEmail("  Anna@Example.COM  "), "anna@example.com");
  assert.equal(normalizeEmail("anna@example.com"), "anna@example.com");
  assert.equal(normalizeEmail("\tANNA@EXAMPLE.COM\n"), "anna@example.com");
  // The three spellings above collapse to one value, which is what the
  // unique constraint in the migration is placed on.
  const spellings = ["Anna@Example.COM", " anna@example.com ", "ANNA@EXAMPLE.com"];
  assert.equal(new Set(spellings.map(normalizeEmail)).size, 1);
});

test("2: an invalid or oversized email is rejected", () => {
  for (const bad of ["", "   ", "anna", "anna@", "@example.com", "anna example.com", "anna@example"]) {
    assert.equal(isValidEmail(normalizeEmail(bad)), false, `accepted: ${JSON.stringify(bad)}`);
  }
  assert.equal(isValidEmail(normalizeEmail(`${"a".repeat(250)}@example.com`)), false, "accepted an over-long address");
  assert.equal(isValidEmail("anna@example.com"), true);
});

/* ── 2. Data minimisation ───────────────────────────────────── */

test("3: the first name is optional and never a reason to fail", () => {
  assert.equal(normalizeFirstName(undefined), null);
  assert.equal(normalizeFirstName(null), null);
  assert.equal(normalizeFirstName(""), null);
  assert.equal(normalizeFirstName("   "), null);
  assert.equal(normalizeFirstName(42), null);
  assert.equal(normalizeFirstName("  Anna  "), "Anna");
  assert.equal(normalizeFirstName("x".repeat(400)).length, 100, "an over-long name must be cut, not rejected");
});

test("4: the form asks for an email, a first name and an optional bracket - nothing else", () => {
  // The fields the page actually renders.
  assert.match(launchPage, /name="email"/);
  assert.match(launchPage, /name="firstName"/);
  assert.match(launchPage, /name="audienceType"/);
  assert.match(launchPage, /name="consent"/);
  assert.match(launchPage, /name="website"/); // honeypot

  // And the ones it must never grow.
  for (const forbidden of [
    'name="lastName"', 'name="surname"', 'name="phone"', 'name="tel"',
    'name="street"', 'name="address"', 'name="zip"', 'name="city"',
    'name="birthday"', 'name="dateOfBirth"', 'name="company"', 'name="gender"',
  ]) {
    assert.ok(!launchPage.includes(forbidden), `the launch form collects: ${forbidden}`);
  }

  // Only the email carries `required`. A required attribute on the name
  // or the bracket would quietly make an optional field mandatory.
  const emailField = launchPage.slice(launchPage.indexOf('id="launch-email"'));
  assert.match(emailField.slice(0, 400), /required/);
  const nameField = launchPage.slice(launchPage.indexOf('id="launch-first-name"'), launchPage.indexOf('id="launch-email"'));
  assert.ok(!nameField.includes("required"), "the first name must stay optional");
});

test("5: the audience bracket is optional, coarse, and not a sales pipeline", () => {
  assert.deepEqual([...LAUNCH_AUDIENCE_TYPES], ["private", "cafe", "studio", "business", "other"]);
  assert.equal(resolveAudienceType(undefined), null);
  assert.equal(resolveAudienceType(""), null);
  assert.equal(resolveAudienceType("vip"), null, "an unknown bracket must not be stored");
  assert.equal(resolveAudienceType("cafe"), "cafe");
  // The page offers a genuine "no answer" option, so somebody can leave
  // it blank without hunting for a way to.
  assert.match(launchPage, /<option value="">Keine Angabe<\/option>/);
});

/* ── 3. Consent ─────────────────────────────────────────────── */

test("6: the consent box is not pre-ticked, anywhere", () => {
  const code = stripJs(launchPage);
  const consentBlock = code.slice(code.indexOf('id="launch-consent"'));
  const input = consentBlock.slice(0, consentBlock.indexOf("/>") + 2);
  assert.match(input, /type="checkbox"/);
  assert.ok(!input.includes("defaultChecked"), "the consent box ships pre-ticked");
  assert.ok(!/\bchecked\b/.test(input), "the consent box ships pre-ticked");
  // And nothing else on the page is pre-ticked either.
  assert.ok(!code.includes("defaultChecked"), "something on this page is pre-ticked");
  assert.ok(!/\bchecked=/.test(code), "something on this page is pre-ticked");
});

test("7: the server refuses a submission that does not carry an explicit consent === true", () => {
  // Client validation is not consent. The route makes the decision.
  assert.match(signupRoute, /if \(consent !== true\)/);
  const guard = signupRoute.indexOf("consent !== true");
  const insert = signupRoute.indexOf(SIGNUP_WRITE);
  assert.ok(guard !== -1 && insert !== -1 && guard < insert, "the consent gate must precede the write");
});

test("8: the consent wording is stored with the row, and comes from the server", () => {
  // What has to be provable later is what THIS person agreed to.
  // The route hands the server's own constants to the RPC; the
  // timestamp is set by the database, not by the caller.
  assert.match(signupRoute, /p_consent_version: LAUNCH_CONSENT_VERSION/);
  assert.match(signupRoute, /p_consent_text: LAUNCH_CONSENT_TEXT/);
  assert.match(read("supabase/migrations/046_launch_signup_atomic.sql"), /consent_given_at\s*=\s*v_now/);
  // And it is not taken from the request body, where a caller could
  // have written any wording it liked.
  const destructured = signupRoute.slice(signupRoute.indexOf("const {"), signupRoute.indexOf("} = body"));
  for (const smuggled of ["consentText", "consent_text", "consentVersion", "purpose"]) {
    assert.ok(!destructured.includes(smuggled), `the route reads ${smuggled} from the request body`);
  }
});

test("9: the wording rendered to the person is the wording that gets stored", () => {
  // The page and the constant must not drift apart, or the stored
  // consent text stops describing what was actually on screen.
  // The CURRENT wording is version 2: it names both mails, because the
  // list now also sends the welcome mail with the discount code. The
  // version 1 sentence is asserted separately in test 80, where it
  // belongs - as history, not as the live text.
  assert.match(LAUNCH_CONSENT_TEXT, /ausschließlich für diese beiden E-Mails verwendet/);
  const collapse = (s) => s.replace(/\s+/g, " ").trim();
  assert.ok(
    collapse(launchPage).includes(collapse(LAUNCH_CONSENT_TEXT)),
    "the consent checkbox no longer renders LAUNCH_CONSENT_TEXT"
  );
  assert.match(LAUNCH_CONSENT_VERSION, /^\d{4}-\d{2}-\d{2}\./, "the consent version must be datable");
});

test("10: the privacy link is present and points at the real privacy page", () => {
  assert.match(launchPage, /<Link href="\/datenschutz">Datenschutzerklärung<\/Link>/);
  assert.match(launchPage, /jederzeit widerrufen/);
  // /datenschutz is a route this site actually serves.
  assert.match(gloaSite, /if\(route==="datenschutz"\)/);
});

/* ── 4. Purpose limitation - the whole point ────────────────── */

test("11: every row carries the launch purpose, and the database refuses any other", () => {
  assert.equal(LAUNCH_PURPOSE, "launch_notification");
  // The purpose is written by the RPC, from a literal, and pinned a
  // second time by 043's CHECK constraint.
  assert.match(read("supabase/migrations/046_launch_signup_atomic.sql"), /'launch_notification'/);
  assert.equal(LAUNCH_PURPOSE, "launch_notification");
  // Not merely a default: a CHECK constraint, so a row with another
  // purpose cannot physically exist in this table.
  assert.match(migration, /check \(purpose = 'launch_notification'\)/);
});

test("12: this list is not a newsletter, and nothing in it says otherwise", () => {
  const surfaces = { launchPage, signupRoute, emailTemplate };
  // Wording that would signal a different, broader consent than the one
  // actually obtained.
  // WHAT THIS GUARD IS FOR: wording that would signal a BROADER consent
  // than the one actually obtained. It is not a ban on the word
  // "Rabatt" - the launch discount is named in the consent text itself,
  // so the page and the mail may say it. What they may not do is imply
  // recurring marketing.
  const forbidden = [
    "Newsletter abonnieren", "Newsletter anmelden", "Newsletter erhalten",
    "Marketing Updates", "Marketing-Updates", "Angebote erhalten",
    "Promotions", "Produktneuheiten", "Gutschein", "exklusive Angebote",
    "Vorteile sichern",
  ];
  for (const [name, source] of Object.entries(surfaces)) {
    const copy = stripJs(source);
    for (const term of forbidden) {
      assert.ok(!copy.includes(term), `${name} uses newsletter/marketing wording: ${term}`);
    }
    // A discount figure, specifically. A bare "%" would false-positive
    // on the email's width="100%" table layout, which is not an offer.
    assert.ok(!/\d+\s*%/.test(copy.replace(/width="100%"/g, "")), `${name} advertises a percentage`);
  }
});

test("13: no row can be sent anything unless it is confirmed, unnotified and launch-purposed", () => {
  const base = { status: "confirmed", purpose: LAUNCH_PURPOSE, launch_notification_sent_at: null };
  assert.equal(mayReceiveLaunchNotification(base), true);

  assert.equal(mayReceiveLaunchNotification({ ...base, status: "pending" }), false, "pending is not consent");
  assert.equal(mayReceiveLaunchNotification({ ...base, status: "withdrawn" }), false, "withdrawn must never be mailed");
  assert.equal(mayReceiveLaunchNotification({ ...base, status: "notified" }), false, "the consent is used up");
  assert.equal(
    mayReceiveLaunchNotification({ ...base, launch_notification_sent_at: "2026-10-01T09:00:00.000Z" }),
    false,
    "a row that already got the launch mail must not get a second one"
  );
  assert.equal(
    mayReceiveLaunchNotification({ ...base, purpose: "newsletter" }),
    false,
    "a row repurposed as a newsletter entry must not be sendable"
  );
});

test("14: the launch send is not wired up yet - only the waitlist and the confirmation are", () => {
  // The task was to build the list, not to fire the launch announcement.
  // A send job existing here would mean the real launch mail could go
  // out by accident, to a list that is still filling.
  assert.ok(!signupRoute.includes("launch_notification_sent_at"),
    "the signup route writes the launch-sent marker");
  assert.ok(!confirmRoute.includes("launch_notification_sent_at"),
    "the confirm route writes the launch-sent marker");
  // The column and the gate exist, ready for it.
  assert.match(migration, /launch_notification_sent_at timestamptz/);
});

/* ── 5. Source whitelisting ─────────────────────────────────── */

test("15: only whitelisted sources are stored, so ?source= is not a free-text column", () => {
  assert.deepEqual([...LAUNCH_SOURCES], ["launch_page", "homepage", "qr_flyer", "event"]);
  assert.equal(resolveSource("qr_flyer"), "qr_flyer");
  assert.equal(resolveSource("event"), "event");
  assert.equal(resolveSource("utm_campaign_spring_sale"), "launch_page");
  assert.equal(resolveSource("<script>alert(1)</script>"), "launch_page");
  assert.equal(resolveSource(undefined), "launch_page");
  assert.equal(resolveSource(null), "launch_page");
  assert.equal(resolveSource(123), "launch_page");
  // And the database refuses anything else even if the route were bypassed.
  assert.match(migration, /check \(source in \('launch_page', 'homepage', 'qr_flyer', 'event'\)\)/);
});

/* ── 6. Tokens ──────────────────────────────────────────────── */

test("16: tokens are opaque, random and never stored in the clear", () => {
  const a = createToken();
  const b = createToken();
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, b, "two tokens must not collide");

  // Only the hash is written.
  // Hashed once into a local and handed to whichever path writes it, so
  // the clear token still never reaches the database.
  assert.ok(signupRoute.includes("const confirmationTokenHash = hashToken(confirmationToken)"));
  assert.ok(signupRoute.includes("const withdrawalTokenHash = hashToken(withdrawalToken)"));
  assert.ok(signupRoute.includes("p_confirmation_token_hash: confirmationTokenHash"));
  assert.ok(signupRoute.includes("p_withdrawal_token_hash: withdrawalTokenHash"));
  for (const source of [signupRoute, confirmRoute, withdrawRoute]) {
    assert.ok(!/token_hash:\s*token\b/.test(source), "a raw token is being written to the database");
  }
  // The migration pins the shape too, so a plaintext token cannot be
  // slipped into the hash column.
  assert.match(migration, /confirmation_token_hash is null or confirmation_token_hash ~ '\^\[0-9a-f\]\{64\}\$'/);
});

test("17: a token matches only its own hash, and the comparison is constant-time", () => {
  const token = createToken();
  const other = createToken();
  assert.equal(tokenMatchesHash(token, hashToken(token)), true);
  assert.equal(tokenMatchesHash(other, hashToken(token)), false);
  assert.equal(tokenMatchesHash(token, "not-a-hash"), false, "a malformed hash must not throw");
  assert.match(read("lib/launchWaitlist.ts"), /timingSafeEqual/);
});

test("18: a malformed token is rejected before any database round-trip", () => {
  for (const bad of ["", "abc", "ZZZ", "../../etc/passwd", "a".repeat(63), "a".repeat(65), null, undefined, 42]) {
    assert.equal(isWellFormedToken(bad), false, `accepted: ${JSON.stringify(bad)}`);
  }
  assert.equal(isWellFormedToken(createToken()), true);
  // Both routes check the shape first. The confirm route now reaches the
  // database through an RPC and the withdraw route still queries the
  // table directly, so each is matched on how it actually talks to it -
  // what matters is that the check comes first in both.
  for (const [name, source, reach] of [
    ["confirmRoute", confirmRoute, '.rpc("confirm_launch_signup"'],
    ["withdrawRoute", withdrawRoute, '.from("launch_waitlist")'],
  ]) {
    const check = source.indexOf("isWellFormedToken");
    const query = source.indexOf(reach);
    assert.ok(check !== -1 && query !== -1 && check < query, `${name} queries before validating the token`);
  }
});

test("19: no email address ever travels in a link", () => {
  // URLs end up in proxy logs, browser history and Referer headers.
  for (const [name, source] of Object.entries({ signupRoute, confirmRoute, withdrawRoute, emailTemplate })) {
    assert.ok(!/[?&]email=/.test(source), `${name} puts an address in a URL`);
    assert.ok(!/[?&]e=\$\{/.test(source), `${name} puts an address in a URL`);
  }
  assert.match(signupRoute, /confirmUrl: `\$\{origin\}\/api\/launch\/confirm\?token=\$\{confirmationToken\}`/);
  assert.match(signupRoute, /withdrawUrl: `\$\{origin\}\/api\/launch\/withdraw\?token=\$\{withdrawalToken\}`/);
});

/* ── 7. Confirmation expiry ─────────────────────────────────── */

test("20: a confirmation link expires, on an explicit clock", () => {
  const sent = "2026-09-06T12:00:00.000Z";
  const sentMs = Date.parse(sent);
  const day = 24 * 60 * 60 * 1000;

  assert.equal(isConfirmationExpired(sent, sentMs), false, "fresh");
  assert.equal(isConfirmationExpired(sent, sentMs + 13 * day), false, "day 13 is still valid");
  assert.equal(isConfirmationExpired(sent, sentMs + CONFIRMATION_TOKEN_TTL_DAYS * day + 1), true, "past the TTL");

  // Missing or unparseable timestamps expire closed, not open.
  assert.equal(isConfirmationExpired(null, sentMs), true);
  assert.equal(isConfirmationExpired("not-a-date", sentMs), true);
});

test("21: the confirmation TTL and the pending retention window are the same number", () => {
  // A link that no longer works must not leave a row behind that still
  // holds an address nobody can confirm.
  assert.equal(CONFIRMATION_TOKEN_TTL_DAYS, PENDING_RETENTION_DAYS);
  assert.equal(PENDING_RETENTION_DAYS, 14);
  // And the privacy notice tells people that number.
  assert.match(gloaSite, /löschen wir die Eintragung nach 14 Tagen/);
});

/* ── 8. Withdrawal ──────────────────────────────────────────── */

test("22: withdrawing takes one click, needs no login, and is final for this list", () => {
  assert.match(withdrawRoute, /status: "withdrawn"/);
  assert.match(withdrawRoute, /withdrawn_at: new Date\(\)\.toISOString\(\)/);
  // The confirmation link dies with the consent it belonged to.
  assert.match(withdrawRoute, /confirmation_token_hash: null/);
  // No auth, no session, no user lookup anywhere in the route.
  for (const gate of ["getUser", "requireAuth", "session", "Authorization"]) {
    assert.ok(!withdrawRoute.includes(gate), `withdrawal is gated behind ${gate}`);
  }
});

test("23: re-submitting a withdrawn address does not revive it or send mail", () => {
  // A withdrawal is not undone by somebody typing the address into a
  // form. The rule lives in submit_launch_signup (migration 046), where
  // it is decided under a row lock before anything is written - so it
  // is asserted against the SQL rather than against branching in the
  // route, which no longer has any.
  const sql = stripSql(read("supabase/migrations/046_launch_signup_atomic.sql"));

  // Either mark alone is enough: a row carrying one but not the other is
  // still a withdrawal.
  assert.match(sql, /if v_row\.status = 'withdrawn' or v_row\.withdrawn_at is not null then\s*return 'withdrawn';/);

  // And it is checked BEFORE the branch that would otherwise refresh the
  // row - so a withdrawn contact never gets new tokens.
  const fn = sql.slice(sql.indexOf("function public.submit_launch_signup"),
                       sql.indexOf("function public.confirm_launch_signup"));
  assert.ok(fn.indexOf("return 'withdrawn';") < fn.indexOf("return 'refreshed';"),
    "the withdrawn check does not precede the refresh");

  // The route sends nothing for that outcome.
  const code = stripJs(signupRoute);
  assert.match(code, /outcome !== "created" && outcome !== "refreshed"/);
  const decide = code.indexOf(SIGNUP_WRITE);
  const send = code.indexOf("resend.emails.send");
  assert.ok(decide > 0 && decide < send, "the route sends before it decides");
});

test("24: clicking a withdrawal link twice is a no-op, not an error", () => {
  assert.match(withdrawRoute, /if \(row\.status === "withdrawn"\) return redirect\("withdrawn"\)/);
});

/* ── 9. Duplicates and enumeration ──────────────────────────── */

test("25: duplicates are prevented by the database, not by application code", () => {
  // The unique constraint is still the guard, and the RPC still merges
  // on conflict rather than failing - so two concurrent submissions of
  // one address cannot produce two rows.
  assert.match(migration, /email\s+text not null unique/);
  const sql = stripSql(read("supabase/migrations/046_launch_signup_atomic.sql"));
  assert.match(sql, /on conflict \(email\) do nothing/);

  // The route no longer decides anything itself: one RPC call replaces
  // the read-then-upsert entirely.
  const code = stripJs(signupRoute);
  assert.ok(code.includes(SIGNUP_WRITE), "the route no longer writes through the RPC");
  assert.ok(!code.includes(".upsert("), "the route still upserts directly");
  assert.ok(!code.includes('.select("id, status'), "the route still reads the row first");
  assert.ok(!code.includes("decideResubmission"), "the decision is duplicated in the route");
});

test("26: the response never reveals whether an address is already on the list", () => {
  // Otherwise a public form becomes an oracle answering "does GLOA have
  // this address?" for any address anybody types.
  assert.match(signupRoute, /function neutralSuccess\(\)/);
  const code = stripJs(signupRoute);
  for (const leak of ["Du bist bereits auf der Liste", "bereits eingetragen", "already on the list", "already subscribed"]) {
    assert.ok(!code.includes(leak), `the route leaks list membership: ${leak}`);
  }
  // The page says the neutral thing too.
  assert.match(launchPage, /Wenn diese Adresse eingetragen werden kann/);
});

/* ── 10. Server-side validation and secrets ─────────────────── */

test("27: the route validates on the server and rejects a non-JSON or oversized body", () => {
  assert.match(signupRoute, /application\/json/);
  assert.match(signupRoute, /MAX_BODY_BYTES/);
  assert.match(signupRoute, /status: 413/);
  assert.match(signupRoute, /isValidEmail\(normalizedEmail\)/);
});

test("28: no secret and no admin client reaches the browser", () => {
  // LaunchPage.tsx is a "use client" component. It must talk to the API
  // and nothing else.
  assert.match(launchPage, /^"use client";/);
  for (const forbidden of [
    "SUPABASE_SECRET_KEY", "supabaseAdmin", "getSupabaseAdmin", "RESEND_API_KEY",
    "getResendClient", "service_role", "process.env",
  ]) {
    assert.ok(!launchPage.includes(forbidden), `the client bundle would carry: ${forbidden}`);
  }
  assert.match(launchPage, /fetch\("\/api\/launch"/);
});

test("29: the table is server-only - RLS on, no anon or authenticated grant", () => {
  assert.match(migration, /alter table public\.launch_waitlist enable row level security/);
  assert.match(migration, /grant select, insert, update, delete on public\.launch_waitlist to service_role/);
  // No policy and no grant for a browser-side role. An anonymous client
  // that could insert here could write a consent_text nobody was shown.
  assert.ok(!/create policy/i.test(migration), "the launch table must have no RLS policy");
  assert.ok(!/to anon\b/.test(migration), "the launch table must not be granted to anon");
  assert.ok(!/to authenticated\b/.test(migration), "the launch table must not be granted to authenticated");
});

/* ── 11. Logging ────────────────────────────────────────────── */

test("30: no address, token or secret is written to the logs", () => {
  for (const [name, source] of Object.entries({ signupRoute, confirmRoute, withdrawRoute })) {
    for (const line of source.split("\n").filter((l) => l.includes("console."))) {
      for (const leak of ["normalizedEmail", "rawEmail", "confirmationToken", "withdrawalToken", "token", "consent_text"]) {
        assert.ok(!line.includes(leak), `${name} logs ${leak}: ${line.trim()}`);
      }
    }
  }
});

/* ── 12. Rate limiting and the honeypot ─────────────────────── */

test("31: the signup is rate limited, and a refused attempt still counts", () => {
  const state = new Map();
  const t0 = 1_000_000;
  for (let i = 0; i < LAUNCH_RATE_LIMIT_MAX; i++) {
    assert.equal(consumeRateLimit(state, "1.2.3.4", t0 + i).allowed, true, `attempt ${i + 1} should pass`);
  }
  const refused = consumeRateLimit(state, "1.2.3.4", t0 + 10);
  assert.equal(refused.allowed, false, "the limit did not engage");
  assert.ok(refused.retryAfterSeconds > 0, "a refusal must say when to come back");

  // Being refused must not reset the caller's own window.
  assert.equal(consumeRateLimit(state, "1.2.3.4", t0 + 11).allowed, false);

  // A different bucket is unaffected.
  assert.equal(consumeRateLimit(state, "5.6.7.8", t0 + 12).allowed, true);

  // And the window really does reopen.
  assert.equal(consumeRateLimit(state, "1.2.3.4", t0 + LAUNCH_RATE_LIMIT_WINDOW_MS + 1).allowed, true);
});

test("32: a request with no forwarding header still lands in a bucket", () => {
  const headers = (map) => ({ headers: { get: (n) => map[n.toLowerCase()] ?? null } });
  assert.equal(rateLimitKeyFromRequest(headers({ "x-forwarded-for": "9.9.9.9, 10.0.0.1" })), "9.9.9.9");
  assert.equal(rateLimitKeyFromRequest(headers({ "x-real-ip": " 8.8.8.8 " })), "8.8.8.8");
  // Not "unlimited" - one shared bucket, which is the hole this closes.
  assert.equal(rateLimitKeyFromRequest(headers({})), "unknown");
});

test("33: the route rate limits before it reads the body, and returns Retry-After", () => {
  const limit = signupRoute.indexOf("consumeRateLimit(rateLimitState");
  const read = signupRoute.indexOf("await request.text()");
  assert.ok(limit !== -1 && read !== -1 && limit < read, "the body is read before the limit is checked");
  assert.match(signupRoute, /status: 429, headers: \{ "Retry-After"/);
});

test("33a: the body cap is enforced on the bytes that arrived, not on the header", () => {
  // content-length is a claim by the caller and a chunked request need
  // not send one at all, so the header check alone is not a cap.
  assert.match(signupRoute, /Buffer\.byteLength\(raw, "utf8"\) > MAX_BODY_BYTES/);
  const measured = signupRoute.indexOf("Buffer.byteLength(raw");
  const parsed = signupRoute.indexOf("JSON.parse(raw)");
  assert.ok(measured !== -1 && parsed !== -1 && measured < parsed, "the body is parsed before it is measured");
  // And the old header-trusting read is gone.
  assert.ok(!stripJs(signupRoute).includes("await request.json()"), "the route still trusts content-length alone");
});

test("34: the honeypot discards silently, with the same shape as a real success", () => {
  assert.match(signupRoute, /if \(typeof website === "string" && website\.trim\(\) !== ""\)/);
  const hp = signupRoute.indexOf('website.trim() !== ""');
  const send = signupRoute.indexOf("resend.emails.send");
  assert.ok(hp < send, "the honeypot must short-circuit before any mail is sent");
  // Hidden from people, not from bots.
  assert.match(launchPage, /tabIndex=\{-1\}/);
  assert.match(launchPage, /aria-hidden="true"/);
});

/* ── 13. The confirmation email ─────────────────────────────── */

test("35: the double opt-in mail asks one question and advertises nothing", () => {
  const mail = buildLaunchConfirmationEmail({
    firstName: "Anna",
    confirmUrl: "https://gloamatcha.com/api/launch/confirm?token=" + "a".repeat(64),
    withdrawUrl: "https://gloamatcha.com/api/launch/withdraw?token=" + "b".repeat(64),
  });

  assert.equal(mail.subject, "GLOA Launch List bestätigen");
  for (const part of [mail.html, mail.text]) {
    assert.match(part, /Fast geschafft/);
    assert.match(part, /Bestätige kurz, dass wir dir Bescheid geben dürfen/);
    assert.match(part, /keine regelmäßigen Newsletter/);
    assert.match(part, /ausschließlich für die Launch-Benachrichtigung verwendet/);
    assert.match(part, /Cara 2 GmbH/);
    // No marketing of any kind.
    for (const term of ["Shop", "kaufen", "Rabatt", "Angebot", "Produkt", "€", "Preis", "Event"]) {
      assert.ok(!part.includes(term), `the confirmation mail advertises: ${term}`);
    }
  }
  assert.match(mail.text, /EINTRAGUNG BESTÄTIGEN/);
  assert.match(mail.html, /Eintragung bestätigen<\/a>/);
});

test("36: the mail greets without a name when none was given, and escapes what it is given", () => {
  const anon = buildLaunchConfirmationEmail({ firstName: null, confirmUrl: "https://x/c", withdrawUrl: "https://x/w" });
  assert.match(anon.text, /^Hi,/);
  assert.ok(!anon.text.includes("Hi null"), "a missing name leaked into the greeting");

  const hostile = buildLaunchConfirmationEmail({
    firstName: '<script>alert("x")</script>',
    confirmUrl: "https://x/c",
    withdrawUrl: "https://x/w",
  });
  assert.ok(!hostile.html.includes("<script>"), "the name is not escaped in the HTML body");
  assert.match(hostile.html, /&lt;script&gt;/);
});

test("37: the mail carries a one-click way out", () => {
  const mail = buildLaunchConfirmationEmail({
    firstName: null,
    confirmUrl: "https://gloamatcha.com/api/launch/confirm?token=x",
    withdrawUrl: "https://gloamatcha.com/api/launch/withdraw?token=y",
  });
  assert.ok(mail.html.includes("https://gloamatcha.com/api/launch/withdraw?token=y"));
  assert.ok(mail.text.includes("https://gloamatcha.com/api/launch/withdraw?token=y"));
});

test("38: the mail is sent from the existing GLOA sender, not a new or invented one", () => {
  assert.match(signupRoute, /from: GLOA_FROM_HELLO/);
  assert.match(read("lib/emailSenders.ts"), /GLOA_FROM_HELLO = "GLOA <hello@gloamatcha\.com>"/);
  // No second mail provider was introduced for this feature.
  assert.match(signupRoute, /getResendClient/);
  for (const other of ["mailchimp", "klaviyo", "sendgrid", "brevo", "postmark", "nodemailer"]) {
    assert.ok(!signupRoute.toLowerCase().includes(other), `a second mail provider appeared: ${other}`);
  }
});

/* ── 14. Wiring ─────────────────────────────────────────────── */

test("39: the homepage teaser links to /launch and still captures nothing", () => {
  const prelaunch = gloaSite.slice(
    gloaSite.indexOf('<section className="prelaunch">'),
    gloaSite.indexOf('<section className="daily">')
  );
  assert.ok(prelaunch.length > 0, "the prelaunch section is missing");
  assert.match(prelaunch, /href="\/launch"/);
  for (const term of ["<input", "<form", 'type="email"', "checkbox"]) {
    assert.ok(!prelaunch.includes(term), `the homepage teaser collects data: ${term}`);
  }
});

test("40: /launch is a real route with its own metadata", () => {
  assert.match(gloaSite, /else if\(route==="launch"\)page=<LaunchPage\/>;/);
  const seo = read("app/[...slug]/page.tsx");
  assert.match(seo, /"launch":\["GLOA Launch List"/);
  assert.match(seo, /Trag dich ein und wir sagen dir Bescheid, sobald GLOA offiziell startet\./);
  // The shared canonical/openGraph builder covers it, so nothing extra
  // had to be invented for this page.
  assert.match(seo, /alternates:\{canonical:`\/\$\{path\}`\}/);
});

test("41: the hero uses the shared page-hero scale rather than inventing one", () => {
  assert.match(launchPage, /className="gloa-hero-primary"/);
  assert.match(launchPage, /className="gloa-hero-secondary"/);
  assert.match(launchPage, /gloa-hero-eyebrow/);
  assert.match(launchPage, /BE AMONG/);
  assert.match(launchPage, /THE FIRST\./);

  const css = read("app/globals.css");
  const block = css.slice(css.indexOf("/launch — THE LAUNCH LIST"));
  assert.ok(block.length > 0, "the launch css block is missing");
  assert.match(block, /\.launch-hero\{[\s\S]*?background:var\(--blue\)/);
  assert.match(block, /\.launch-form-band\{[\s\S]*?background:var\(--cream\)/);
  // No hero font-size is redeclared here - that is the shared block's job.
  const hero = block.slice(block.indexOf(".launch-hero-headline{"), block.indexOf(".launch-hero-lead{"));
  assert.ok(!hero.includes("font-size"), "the launch hero redeclares a font size");
  // AND NONE OF THE BANNED DECORATION. No glassmorphism, no glow, no
  // SaaS card, no pill, and no pure white - GLOA has none of those
  // anywhere in its visible styling and this page does not introduce
  // them.
  for (const term of ["backdrop-filter", "box-shadow", "filter:blur", "border-radius:999", "#fff", "#FFF", "#ffffff", ":white"]) {
    assert.ok(!block.includes(term), `the launch page uses ${term}`);
  }

  // Both bands are FLAT colour. The one `linear-gradient` in this block
  // is the two-triangle caret on the <select>, a decades-old way of
  // drawing an arrow without shipping an image - not a decorative
  // background. So the ban is on gradients where a band's colour is
  // set, which is what "no gradients" actually meant, rather than on
  // the string anywhere in the file.
  for (const band of [".launch-hero{", ".launch-form-band{", ".launch-page{"]) {
    const rule = block.slice(block.indexOf(band), block.indexOf("}", block.indexOf(band)));
    assert.ok(rule.length > 0, `missing rule: ${band}`);
    assert.ok(!rule.includes("gradient"), `${band} paints a gradient`);
  }
  const gradientLines = block.split(String.fromCharCode(10)).filter((l) => l.includes("gradient"));
  assert.equal(gradientLines.length, 1, `gradients outside the select caret: ${gradientLines.join(" | ")}`);
  assert.match(gradientLines[0].trim(), /^background-image:linear-gradient\(45deg/, "that is not the select caret");
});

test("42: the outcome states are rendered on /launch, not in the API route", () => {
  // Redirecting also drops the token out of the address bar.
  for (const [name, source] of Object.entries({ confirmRoute, withdrawRoute })) {
    assert.match(source, /status: 303/, `${name} does not redirect`);
    assert.match(source, /\/launch\?state=/, `${name} does not hand off to /launch`);
    assert.match(source, /"Cache-Control": "no-store"/, `${name} allows a per-person outcome to be cached`);
    assert.match(source, /"Referrer-Policy": "no-referrer"/, `${name} may leak the token in a Referer header`);
  }
  assert.match(launchPage, /YOU'RE ON/);
  assert.match(launchPage, /THE LIST\./);
});

test("43: the success state does not claim confirmation before it happened", () => {
  // Right after submitting, the entry is PENDING. Saying "you're on the
  // list" there would promise a message that will not be sent unless the
  // link in the mail is clicked.
  const code = stripJs(launchPage);
  const submitted = code.slice(code.indexOf('status === "submitted"'), code.indexOf("Keine Mail bekommen"));
  assert.ok(submitted.length > 0, "the pending state is missing");
  assert.ok(!submitted.includes("YOU'RE ON"), "the pending state claims the entry is confirmed");
  assert.match(submitted, /Check deine/);
  assert.match(submitted, /Bestätige darin/);
});

test("44: the instagram handle is the one the site already uses, not an invented URL", () => {
  assert.match(launchPage, /https:\/\/instagram\.com\/\$\{BRAND\.instagram\}/);
  assert.match(read("app/content.ts"), /instagram: "gloa\.matcha"/);
  assert.match(launchPage, /target="_blank" rel="noopener noreferrer"/);
});

/* ── 15. Accessibility ──────────────────────────────────────── */

test("45: every field has a real label bound by id, and none relies on a placeholder", () => {
  for (const id of ["launch-first-name", "launch-email", "launch-audience", "launch-consent"]) {
    assert.ok(launchPage.includes(`htmlFor="${id}"`), `no label bound to ${id}`);
    assert.ok(launchPage.includes(`id="${id}"`), `no field with id ${id}`);
  }
  // No placeholder is doing a label's job: a placeholder disappears the
  // moment somebody types, which is when they need it most.
  const form = launchPage.slice(launchPage.indexOf("<form className=\"launch-form\""));
  assert.ok(!form.includes("placeholder="), "a field uses a placeholder instead of a visible label");
});

test("46: submit, error and success states are announced, and the error is bound to the field", () => {
  assert.match(launchPage, /aria-live="polite"/);
  assert.match(launchPage, /role="status"/);
  assert.match(launchPage, /id="launch-error"/);
  assert.match(launchPage, /aria-describedby=\{status === "error" \? "launch-error" : undefined\}/);
});

test("47: focus is visible, and no state is communicated by colour alone", () => {
  const css = read("app/globals.css");
  const block = css.slice(css.indexOf("/launch — THE LAUNCH LIST"));
  assert.match(block, /:focus-visible\{[\s\S]*?outline:2px solid var\(--berry\)/);
  // The error is a bordered block with text, not a red field outline.
  assert.match(block, /\.launch-error\{[\s\S]*?border-left:2px solid var\(--berry\)/);
  // 16px on inputs stops iOS zooming the page on focus.
  assert.match(block, /\.launch-field input,[\s\S]*?font-size:16px/);
});

/* ── 16. Migrations ─────────────────────────────────────────── */

test("48: 043 is additive and touches nothing that already exists", () => {
  assert.match(migration, /create table public\.launch_waitlist/);
  // No edit to any existing object.
  for (const destructive of [
    "drop table", "drop column", "drop policy", "alter table public.orders",
    "alter table public.customer", "alter table public.checkout_attempts",
    "revoke all on table", "truncate", "delete from public.launch_waitlist",
  ]) {
    assert.ok(!stripSql(migration).toLowerCase().includes(destructive), `043 performs: ${destructive}`);
  }
  // The only objects it names are its own. The rate limit counter and
  // its writer joined this file in the production-hardening pass -
  // see tests 60 to 62 - and 001's trigger function is reused rather
  // than redefined. Nothing else may appear here.
  const tables = [...stripSql(migration).matchAll(/public\.(\w+)/g)].map((m) => m[1]);
  for (const t of tables) {
    assert.ok(
      ["launch_waitlist", "launch_rate_limit", "consume_launch_rate_limit", "set_updated_at"].includes(t),
      `043 touches another object: ${t}`
    );
  }
});

test("49: the retention rule is written down and indexed for, but not silently automated", () => {
  assert.match(migration, /idx_launch_waitlist_pending_created/);
  assert.match(migration, /RETENTION/);
  assert.match(migration, /14 days/);
  // Nothing may start deleting rows on a schedule nobody reviewed
  // against the real launch date.
  assert.ok(!/create .*trigger.*delete/i.test(migration), "043 automates deletion");
  assert.ok(!/pg_cron|cron\.schedule/i.test(migration), "043 schedules a job");
});

/* ── 17. The privacy notice ─────────────────────────────────── */

test("50: the privacy notice describes this list, accurately and without overclaiming", () => {
  const privacy = gloaSite.slice(
    gloaSite.indexOf('if(route==="datenschutz")'),
    gloaSite.indexOf('if(route==="agb")')
  );
  assert.ok(privacy.length > 0, "the privacy page is missing");

  assert.match(privacy, /Launch-Benachrichtigung/);
  assert.match(privacy, /Art\. 6 Abs\. 1 lit\. a DSGVO/, "the legal basis must be consent");
  assert.match(privacy, /Double-Opt-In/);
  assert.match(privacy, /jederzeit mit Wirkung für die Zukunft widerrufen/);
  assert.match(privacy, /Pflichtangabe ist ausschließlich die E-Mail-Adresse/);
  assert.match(privacy, /Ein Newsletter ist damit nicht verbunden/);
  assert.match(privacy, /gesonderte Einwilligung/);
  // Only providers actually used.
  assert.match(privacy, /Resend/);
  assert.match(privacy, /Supabase/);
  // The existing statement that GLOA runs no newsletter must survive.
  assert.match(privacy, /Einen Newsletter bieten wir nicht an/);
  // And no legal claim nobody verified.
  for (const term of ["100 % DSGVO-konform", "vollständig rechtskonform", "rechtssicher", "zertifiziert"]) {
    assert.ok(!privacy.includes(term), `the privacy notice overclaims: ${term}`);
  }
  // The responsible party is the one already named on the page - not a
  // second, invented one.
  assert.match(privacy, /Cara 2 GmbH/);
  assert.equal((privacy.match(/Cara 2 GmbH/g) || []).length >= 1, true);
});

test("51: the section numbering stayed sequential after the insert", () => {
  const privacy = gloaSite.slice(
    gloaSite.indexOf('if(route==="datenschutz")'),
    gloaSite.indexOf('if(route==="agb")')
  );
  const numbers = [...privacy.matchAll(/<h2>(\d+)\./g)].map((m) => Number(m[1]));
  assert.deepEqual(numbers, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], `privacy headings out of order: ${numbers}`);
});

/* ══════════════════════════════════════════════════════════════
   17. THE PERSISTENT RATE LIMIT

   The in-process limiter above is a speed bump per instance. On a
   serverless platform that is defeated by the platform itself: the
   process is per instance and is discarded without warning, so
   sustained load is exactly what produces fresh instances with empty
   counters.

   The limit that actually holds is therefore a shared counter in
   Postgres (sections 4 and 5 of migration 043). These tests hold two promises about it:

     1. it is REAL - one atomic statement, applied before a row is
        written and before any mail is sent, and it counts refusals;
     2. it costs nobody their IP address - what is stored is an HMAC
        digest, and a raw address cannot physically be written.
   ══════════════════════════════════════════════════════════════ */

const rateLimitModule = read("lib/launchRateLimit.ts");
const rateLimitStore = read("lib/launchRateLimitStore.ts");
// Sections 4 and 5 of 043. Not a 044: 043 has not been applied
// anywhere, and this repository's rule for that case is written into
// tests/one-time-refund-writer-concurrency.test.mjs - an unapplied
// migration is still the right place to fix itself, and a hardening
// pass must not become a second migration.
const rateLimitMigration = migration;

/**
 * Just the rate limit's own sections of 043.
 *
 * The assertions that say "this must not mention an email address" or
 * "this must not name another table" are about the counter, not about
 * the consent table it happens to share a file with - and the consent
 * table quite properly says "email" all over itself. Slicing here is
 * what keeps those assertions meaningful instead of vacuously false.
 */
const rateLimitSection = rateLimitMigration.slice(
  rateLimitMigration.indexOf("-- 4. THE RATE LIMIT COUNTER")
);

test("52: a bucket key is a keyed digest, and the address is not recoverable from it", () => {
  const a = pseudonymizeBucketKey("203.0.113.9", "secret-one");

  // The shape migration 043 pins.
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.ok(isBucketKey(a));

  // Stable for the same caller, or it would not be a bucket at all.
  assert.equal(pseudonymizeBucketKey("203.0.113.9", "secret-one"), a);

  // Different callers do not share a bucket.
  assert.notEqual(pseudonymizeBucketKey("203.0.113.10", "secret-one"), a);

  // KEYED, not merely hashed. The IPv4 space is small enough to
  // enumerate, so an unkeyed digest of an address is reversible by
  // brute force and would be personal data in everything but name.
  assert.notEqual(pseudonymizeBucketKey("203.0.113.9", "secret-two"), a);

  // The address does not survive into the value.
  assert.ok(!a.includes("203"), "the digest contains the address");
});

test("53: nothing on the persistent path can carry a raw address", () => {
  // The route turns the address into a digest immediately and passes
  // only the digest onward.
  assert.match(signupRoute, /const callerBucket = rateLimitKeyFromRequest\(request\);/);
  assert.match(signupRoute, /pseudonymizeBucketKey\(callerBucket, bucketSecret\)/);
  // Layer 2 is handed the digest, never the address.
  assert.match(signupRoute, /consumePersistentRateLimit\(\s*supabase,\s*bucketKey,/);
  assert.ok(!/consumePersistentRateLimit\([^)]*callerBucket/.test(signupRoute), "the address reaches the database");

  // The store refuses anything that is not already a digest rather
  // than putting it on the wire.
  assert.match(rateLimitStore, /if \(!isBucketKey\(bucketKey\)\)/);
  const guard = rateLimitStore.indexOf("isBucketKey(bucketKey)");
  const call = rateLimitStore.indexOf("client.rpc(");
  assert.ok(guard !== -1 && call !== -1 && guard < call, "the digest is sent before it is checked");

  // And the database refuses it a third time.
  assert.match(rateLimitMigration, /bucket_key\s+text primary key\s*\r?\n\s*check \(bucket_key ~ '\^\[0-9a-f\]\{64\}\$'\)/);
  assert.match(rateLimitMigration, /p_bucket_key !~ '\^\[0-9a-f\]\{64\}\$'/);

  // The three statements of the shape must be the same shape. The
  // store cannot import the module's copy - it has to stay a leaf so
  // this suite can load it - so the agreement is asserted instead of
  // assumed.
  assert.match(rateLimitModule, /\/\^\[0-9a-f\]\{64\}\$\/\.test\(value\)/);
  assert.match(rateLimitStore, /BUCKET_KEY_PATTERN = \/\^\[0-9a-f\]\{64\}\$\//);
  assert.equal(isBucketKey("2".repeat(64)), true);
  assert.equal(isBucketKey("2".repeat(63)), false);
  assert.equal(isBucketKey("203.0.113.9"), false);
  assert.equal(isBucketKey("A".repeat(64)), false);

  // No column that could hold one, and no email either.
  const strippedSection = stripSql(rateLimitSection);
  const columns = strippedSection.slice(
    strippedSection.indexOf("create table public.launch_rate_limit"),
    strippedSection.indexOf("create index idx_launch_rate_limit_window_started")
  );
  for (const banned of ["ip", "ip_address", "email", "user_agent", "first_name", "user_id"]) {
    assert.ok(!new RegExp(`\\b${banned}\\s`, "i").test(columns), `the counter stores a ${banned} column`);
  }
});

test("54: the shared counter is spent by one atomic statement that counts refusals", () => {
  // Read-modify-write from application code is two statements with a
  // gap, and two instances racing through that gap is the exact
  // situation a shared counter exists to fix.
  assert.match(rateLimitMigration, /insert into public\.launch_rate_limit as l[\s\S]*?on conflict \(bucket_key\) do update/);

  // Every attempt is counted, including one that is about to be
  // refused - otherwise a caller over the limit could hold its own
  // window open by continuing to knock.
  assert.match(rateLimitMigration, /else l\.attempt_count \+ 1/);
  const increment = rateLimitMigration.indexOf("l.attempt_count + 1");
  const verdict = rateLimitMigration.indexOf("if v_count > p_max then");
  assert.ok(increment < verdict, "the verdict is taken before the attempt is counted");

  // The window is not extended by the attempts inside it.
  assert.match(rateLimitMigration, /else l\.window_started_at\s*\r?\n?\s*end/);
});

test("55: the limit is 5 attempts per 10 minutes, in one place, in both units", () => {
  assert.match(rateLimitModule, /LAUNCH_RATE_LIMIT_MAX = 5\b/);
  assert.match(rateLimitModule, /LAUNCH_RATE_LIMIT_WINDOW_MS = 10 \* 60 \* 1000/);
  // Derived, not written twice, so the two layers cannot drift apart.
  assert.match(rateLimitModule, /LAUNCH_RATE_LIMIT_WINDOW_SECONDS = LAUNCH_RATE_LIMIT_WINDOW_MS \/ 1000/);
  assert.equal(LAUNCH_RATE_LIMIT_MAX, 5);
  assert.equal(LAUNCH_RATE_LIMIT_WINDOW_SECONDS, 600);
  assert.equal(LAUNCH_RATE_LIMIT_WINDOW_MS, LAUNCH_RATE_LIMIT_WINDOW_SECONDS * 1000);
});

test("56: the shared limit is applied before a row is written and before mail is sent", () => {
  const shared = signupRoute.indexOf("consumePersistentRateLimit");
  const upsert = signupRoute.indexOf(SIGNUP_WRITE);
  const send = signupRoute.indexOf("resend.emails.send");
  assert.ok(shared !== -1, "the route does not consult the shared limit");
  assert.ok(shared < upsert, "a refused caller can still write a row");
  assert.ok(shared < send, "a refused caller can still make GLOA send mail");
  assert.match(signupRoute, /if \(shared\.kind === "limited"\) return tooManyRequests\(/);
});

test("57: a refused caller is told to wait, and never told to retry immediately", async () => {
  const limited = await consumePersistentRateLimit(
    { rpc: async () => ({ data: [{ allowed: false, retry_after_seconds: 421 }], error: null }) },
    "a".repeat(64),
    5,
    600
  );
  assert.deepEqual(limited, { kind: "limited", retryAfterSeconds: 421 });

  // A refusal without a usable number still has to produce a header,
  // and "0" - try again now - is the one answer a limit must not give.
  for (const bad of [null, undefined, 0, -1, "nonsense"]) {
    const out = await consumePersistentRateLimit(
      { rpc: async () => ({ data: [{ allowed: false, retry_after_seconds: bad }], error: null }) },
      "a".repeat(64),
      5,
      600
    );
    assert.equal(out.kind, "limited");
    assert.equal(out.retryAfterSeconds, 600, `retry_after_seconds ${String(bad)} produced ${out.retryAfterSeconds}`);
  }

  const allowed = await consumePersistentRateLimit(
    { rpc: async () => ({ data: [{ allowed: true, retry_after_seconds: 0 }], error: null }) },
    "a".repeat(64),
    5,
    600
  );
  assert.deepEqual(allowed, { kind: "allowed" });
});

test("58: a database that cannot answer refuses the signup rather than waving it through", async () => {
  // The store reports `unavailable` and decides nothing; the POLICY for
  // that outcome belongs to the route, and the route's policy is to
  // refuse.
  //
  // The earlier version degraded to the in-process limiter instead. On
  // a serverless deployment that is not a weaker limit but an absent
  // one - fresh instances arrive with empty counters exactly under the
  // load the limit exists for - so the failure mode was confirmation
  // mail leaving GLOA's sending domain, at an address the caller chose,
  // at whatever rate the platform would scale to. Losing signups during
  // an outage is recoverable; that is not.
  const cases = [
    { rpc: async () => ({ data: null, error: { message: "function does not exist" } }) },
    { rpc: async () => ({ data: null, error: null }) },
    { rpc: async () => ({ data: [{}], error: null }) },
    { rpc: async () => { throw new Error("socket closed"); } },
  ];
  for (const client of cases) {
    const out = await consumePersistentRateLimit(client, "a".repeat(64), 5, 600);
    assert.equal(out.kind, "unavailable");
    assert.equal(typeof out.reason, "string");
  }

  // A non-digest never reaches the database at all.
  const refused = await consumePersistentRateLimit(
    { rpc: async () => { throw new Error("must not be called"); } },
    "203.0.113.9",
    5,
    600
  );
  assert.equal(refused.kind, "unavailable");

  // THE ROUTE REFUSES. Both ways the shared counter can be missing - it
  // answered `unavailable`, or there was no secret to build the digest
  // with - end in the same neutral refusal, and neither falls through.
  const code = stripJs(signupRoute);
  assert.match(code, /shared\.kind === "unavailable"[\s\S]{0,400}?return temporarilyUnavailable\(\)/);
  assert.match(code, /if \(!bucketKey\)[\s\S]{0,400}?return temporarilyUnavailable\(\)/);

  // And it is genuinely a refusal, not a log line before the old path:
  // nothing in this file falls back to the per-instance limiter.
  assert.ok(
    !/falling back to per-instance/.test(code),
    "the route still degrades to the per-instance limiter"
  );

  // The refusal happens BEFORE anything is written or sent. If the
  // upsert or the mail moved above the limit check this would catch it.
  const limitAt = code.indexOf("consumePersistentRateLimit");
  const upsertAt = code.indexOf(SIGNUP_WRITE);
  const sendAt = code.indexOf("emails.send");
  assert.ok(limitAt > 0 && upsertAt > limitAt, "the row is written before the shared limit is spent");
  assert.ok(sendAt > limitAt, "the mail is sent before the shared limit is spent");
});

test("58b: the refusal is the same neutral answer every other outage gives", () => {
  const code = stripJs(signupRoute);

  // One helper produces every temporary refusal, so a caller cannot tell
  // "the rate limiter is down" from "Resend is not configured" by
  // comparing responses - which would turn the endpoint into a probe for
  // which part of the deployment is unhealthy.
  assert.match(code, /function temporarilyUnavailable\(\)[\s\S]*?status: 503/);
  const refusals = [...code.matchAll(/status: 503/g)];
  assert.equal(refusals.length, 1, "503 is built in more than one place");

  // The reason is logged for the operator and never returned, and what
  // is logged is the store's reason string - built from driver messages,
  // never from the address or the digest. Test 59 pins that separately.
  assert.match(code, /console\.error\("Launch waitlist: shared rate limit unavailable[^"]*", shared\.reason\)/);
});

test("59: neither the address nor the bucket key is ever logged or stored", () => {
  const code = stripJs(signupRoute);
  // Nothing is logged that could carry the address. The reason string
  // from the store is the only value logged on the limit path, and the
  // store builds it from driver messages, never from its input.
  assert.ok(!/console\.\w+\([^)]*bucketKey/.test(code), "the route logs the bucket key");
  assert.ok(!/console\.\w+\([^)]*callerBucket/.test(code), "the route logs the client address");
  assert.ok(!/console\.\w+\([^)]*normalizedEmail/.test(code), "the route logs the email address");
  assert.ok(!/console\.\w+\([^)]*Token/.test(code), "the route logs a token");

  // The waitlist table has no column for either, and the rate limit
  // table has no column that outlives its window.
  assert.ok(!/ip_address|client_ip|remote_addr/i.test(stripSql(migration)), "043 stores an address");
  assert.match(rateLimitMigration, /window_started_at < v_now - v_window/);
});

test("60: the counter is locked to service_role, exactly as the list is", () => {
  assert.match(rateLimitSection, /create table public\.launch_rate_limit/);
  assert.match(rateLimitSection, /alter table public\.launch_rate_limit enable row level security/);
  assert.match(rateLimitSection, /grant select, insert, update, delete on public\.launch_rate_limit to service_role/);

  // No policy and no grant for anon or authenticated: a client that
  // could write here could zero its own counter, which is the whole
  // limit; a client that could read it could test whether a given
  // address digest has been seen recently.
  assert.ok(!/create policy/i.test(rateLimitSection), "the counter has an RLS policy");
  assert.ok(!/\bto anon\b/.test(rateLimitSection), "the counter is granted to anon");
  assert.ok(!/\bto authenticated\b/.test(rateLimitSection), "the counter is granted to authenticated");

  // Execute on the writer is revoked from everyone and re-granted to
  // one role, the same way 038 and 040 do it.
  for (const role of ["public", "anon", "authenticated"]) {
    assert.ok(
      rateLimitSection.includes(
        `revoke all on function public.consume_launch_rate_limit(text, integer, integer) from ${role};`
      ),
      `execute is not revoked from ${role}`
    );
  }
  assert.match(
    rateLimitSection,
    /grant execute on function public\.consume_launch_rate_limit\(text, integer, integer\) to service_role;/
  );

  // Two tables, a function and a trigger now. It applies as a whole or
  // not at all.
  assert.match(rateLimitMigration, /^begin;$/m);
  assert.match(rateLimitMigration, /^commit;$/m);
});

test("61: the rate limit went into 043 rather than into a 044, and 043 is still additive", () => {
  // WHAT THIS TEST ORIGINALLY HELD, AND WHY IT CHANGED.
  //
  // The rule from tests/one-time-refund-writer-concurrency.test.mjs is
  // that "a hardening pass must not become a second migration": while
  // 043 was unapplied, fixing 043 belonged in 043. This test enforced
  // that by asserting no 044 existed at all.
  //
  // 043 IS NOW APPLIED IN PRODUCTION, so that clause has done its job
  // and the opposite rule takes over: an applied migration may never be
  // edited again, and anything further has to be its own file. 044 is
  // that file, and it is a NEW FEATURE - the one-time launch send - not
  // a hardening pass on 043.
  //
  // So the assertion narrows rather than disappears. What still has to
  // be true is that the RATE LIMIT lives in 043 and that no later
  // migration reaches into it - which is the thing the original rule
  // was protecting.
  const files = readdirSync(path.join(ROOT, "supabase/migrations")).filter((f) => f.endsWith(".sql"));
  const later = files.filter((f) => Number(f.slice(0, 3)) > 43);
  assert.deepEqual(
    later,
    // 044: the one-time launch send, reviewed in tests/launch-send.test.mjs.
    // 045: the welcome mail with the discount code, reviewed in tests 84-87
    //      of this file. Both are additive and neither touches 043.
    // 046: atomic signup and the consent-history split, reviewed in
    // tests 91-100 of this file.
    ["044_launch_send.sql", "045_launch_welcome_email.sql", "046_launch_signup_atomic.sql"],
    "an unreviewed migration appeared after 043"
  );

  // The rate limit objects are in 043 and nowhere else. A later
  // migration that recreated, altered or dropped them would mean the
  // limiter's definition had two homes.
  for (const f of later) {
    const sql = stripSql(read(`supabase/migrations/${f}`));
    assert.ok(!sql.includes("launch_rate_limit"), `${f} touches the rate limit table`);
    assert.ok(!sql.includes("consume_launch_rate_limit"), `${f} touches the rate limit function`);
  }

  const sql = stripSql(migration);
  for (const destructive of [
    "drop table", "drop column", "drop policy", "revoke all on table", "truncate",
    "alter table public.orders", "alter table public.customer", "alter table public.checkout_attempts",
  ]) {
    assert.ok(!sql.toLowerCase().includes(destructive), `043 performs: ${destructive}`);
  }

  // The consent table is still never deleted from by this file. The one
  // deletion it now contains is the counter's own expiry sweep.
  const deletes = [...sql.matchAll(/delete from (\S+)/gi)].map((m) => m[1]);
  assert.deepEqual([...new Set(deletes)], ["public.launch_rate_limit"], `043 deletes from: ${deletes}`);
});

test("62: the counter is not a second purpose for the waitlist data", () => {
  // The two tables share no key, no column and no foreign key. A row in
  // the counter cannot be joined to a person, to a waitlist entry or to
  // an order - which is what keeps the launch consent single-purpose
  // even though a second table now shares its file.
  assert.ok(!/references /i.test(stripSql(rateLimitSection)), "the counter references another table");
  assert.ok(!/launch_waitlist/.test(stripSql(rateLimitSection)), "the counter names the waitlist table");

  for (const banned of ["email", "consent", "purpose", "marketing", "newsletter", "first_name"]) {
    assert.ok(
      !new RegExp(`\\b${banned}\\b`, "i").test(stripSql(rateLimitSection)),
      `the counter names waitlist data: ${banned}`
    );
  }
});

/* ── 12. Retention: the deletion the privacy notice promises ──
 *
 * The notice tells every person who signs up: "Bestätigst du sie nicht,
 * löschen wir die Eintragung nach 14 Tagen." Migration 043 wrote that
 * rule down and built the index for it, but deliberately implemented
 * nothing - it says the deletion is an operational job. Until
 * lib/launchWaitlistRetention.ts existed, that job did not exist either,
 * so the promise was a sentence rather than a behaviour.
 *
 * These tests drive the sweep with a fake client. Nothing here opens a
 * socket, builds a Supabase client or reads a clock: `now` is passed in,
 * so the fourteen-day boundary can be put anywhere without waiting.
 * ────────────────────────────────────────────────────────────── */

test("63: the retention period is the one the privacy notice states, not a second number", () => {
  // THE PERIOD LIVES IN THREE PLACES and this is what keeps them equal.
  //
  // The sweep is a leaf with no runtime imports, so the suite can load
  // it under plain Node - the same constraint lib/launchRateLimitStore.ts
  // records for its digest pattern. The price is that the number is
  // stated twice; this assertion is what makes that repetition checked
  // rather than trusted.
  //
  //   1. PENDING_RETENTION_DAYS      lib/launchWaitlist.ts
  //   2. RETENTION_PENDING_DAYS      lib/launchWaitlistRetention.ts
  //   3. the sentence a person reads app/GloaSite.tsx
  //
  // If any one of them moves, this fails.
  assert.equal(PENDING_RETENTION_DAYS, 14);
  assert.equal(RETENTION_PENDING_DAYS, PENDING_RETENTION_DAYS);

  // A link that no longer works must not leave a row behind that still
  // holds an address, so the token TTL is the same number.
  assert.equal(CONFIRMATION_TOKEN_TTL_DAYS, PENDING_RETENTION_DAYS);

  // The notice still says it, in these words, and says the SAME number.
  const promised = gloaSite.match(/löschen wir die Eintragung nach (\d+) Tagen/);
  assert.ok(promised, "the privacy notice no longer promises a deletion period");
  assert.equal(
    Number(promised[1]),
    RETENTION_PENDING_DAYS,
    "the notice promises a period the sweep does not implement"
  );

  const now = Date.parse("2026-09-20T12:00:00.000Z");
  assert.equal(pendingRetentionCutoff(now).toISOString(), "2026-09-06T12:00:00.000Z");
});

test("64: only unconfirmed entries are sweepable - confirmed, withdrawn and notified are out of reach", () => {
  const now = Date.parse("2026-09-20T12:00:00.000Z");
  const cutoff = pendingRetentionCutoff(now);
  const old = "2026-09-01T00:00:00.000Z";   // 19 days
  const fresh = "2026-09-19T00:00:00.000Z"; // 1 day

  assert.equal(RETENTION_SWEEPABLE_STATUS, "pending");
  assert.equal(isSweepablePendingEntry({ status: "pending", created_at: old }, cutoff), true);

  // A person who confirmed gave consent; a person who withdrew left
  // evidence that must outlive the entry; a notified row is the send
  // log. None of them may be deleted by a timer.
  for (const status of ["confirmed", "withdrawn", "notified"]) {
    assert.equal(
      isSweepablePendingEntry({ status, created_at: old }, cutoff),
      false,
      `a ${status} entry is sweepable`
    );
  }

  // Inside the period, and exactly on the boundary, the row stays.
  assert.equal(isSweepablePendingEntry({ status: "pending", created_at: fresh }, cutoff), false);
  assert.equal(
    isSweepablePendingEntry({ status: "pending", created_at: cutoff.toISOString() }, cutoff),
    false,
    "a row exactly at the cutoff is deleted a moment early"
  );

  // An unreadable or missing date is not evidence that fourteen days
  // have passed, so it is not a licence to delete.
  assert.equal(isSweepablePendingEntry({ status: "pending", created_at: null }, cutoff), false);
  assert.equal(isSweepablePendingEntry({ status: "pending", created_at: "soon" }, cutoff), false);
});

/** A fake Supabase surface that records what the sweep asked for. */
function fakeRetentionClient({ count = 0, rows = [], failOn = null } = {}) {
  const calls = { selects: [], deletes: [] };
  const err = (stage) => (failOn === stage ? { message: `${stage} failed` } : null);

  const client = {
    from(table) {
      calls.table = table;
      return {
        select(columns, options) {
          const spec = { columns, head: Boolean(options?.head), filters: [], limit: null };
          calls.selects.push(spec);
          const builder = {
            eq(column, value) { spec.filters.push(["eq", column, value]); return builder; },
            lt(column, value) { spec.filters.push(["lt", column, value]); return builder; },
            limit(n) {
              spec.limit = n;
              return Promise.resolve({ data: rows.slice(0, n), count: null, error: err("list") });
            },
            then(resolve, reject) {
              return Promise.resolve({ data: null, count, error: err("count") }).then(resolve, reject);
            },
          };
          return builder;
        },
        delete() {
          const spec = { filters: [], ids: null };
          calls.deletes.push(spec);
          const builder = {
            eq(column, value) { spec.filters.push(["eq", column, value]); return builder; },
            in(column, values) {
              spec.ids = { column, values };
              return Promise.resolve({ error: err("delete") });
            },
          };
          return builder;
        },
      };
    },
  };
  return { client, calls };
}

test("65: the sweep deletes expired pending entries and reports counts, not people", async () => {
  const now = Date.parse("2026-09-20T12:00:00.000Z");
  const { client, calls } = fakeRetentionClient({
    count: 3,
    rows: [{ id: "a" }, { id: "b" }, { id: "c" }],
  });

  const summary = await sweepExpiredPendingEntries(client, now);
  assert.deepEqual(summary, { due: 3, deleted: 3, remaining: 0, errored: false });

  assert.equal(calls.table, "launch_waitlist");

  // The count is head-only: no address is read into the process to
  // produce a number, and the id select asks for the id column alone.
  assert.equal(calls.selects[0].head, true);
  assert.equal(calls.selects[1].columns, "id");
  for (const spec of calls.selects) {
    assert.deepEqual(spec.filters[0], ["eq", "status", "pending"]);
    assert.equal(spec.filters[1][0], "lt");
    assert.equal(spec.filters[1][1], "created_at");
    assert.equal(spec.filters[1][2], "2026-09-06T12:00:00.000Z");
  }

  // THE DELETE IS NARROWED BY STATUS AGAIN, not only by the id list.
  // Between reading the ids and deleting them somebody may have clicked
  // their confirmation link, and the database - not a snapshot taken a
  // moment ago - is what decides whether the row is still pending.
  assert.equal(calls.deletes.length, 1);
  assert.deepEqual(calls.deletes[0].filters, [["eq", "status", "pending"]]);
  assert.deepEqual(calls.deletes[0].ids, { column: "id", values: ["a", "b", "c"] });

  // The summary is four scalars. No address, no id, no name.
  assert.deepEqual(Object.keys(summary).sort(), ["deleted", "due", "errored", "remaining"]);
});

test("66: nothing due means nothing is read and nothing is deleted", async () => {
  const { client, calls } = fakeRetentionClient({ count: 0 });
  const summary = await sweepExpiredPendingEntries(client, Date.now());

  assert.deepEqual(summary, { due: 0, deleted: 0, remaining: 0, errored: false });
  assert.equal(calls.selects.length, 1, "the sweep listed ids with nothing due");
  assert.equal(calls.deletes.length, 0, "the sweep issued a delete with nothing due");
});

test("67: the batch is bounded, and a capped run says so instead of looking complete", async () => {
  const now = Date.parse("2026-09-20T12:00:00.000Z");
  const rows = Array.from({ length: 5 }, (_, i) => ({ id: `id-${i}` }));
  const { client, calls } = fakeRetentionClient({ count: 900, rows });

  const summary = await sweepExpiredPendingEntries(client, now, 5);
  assert.deepEqual(summary, { due: 900, deleted: 5, remaining: 895, errored: false });
  assert.equal(calls.selects[1].limit, 5);

  // The default cap is a real number, and the job is idempotent, so a
  // backlog drains across consecutive daily runs rather than in one
  // statement that might time out halfway.
  assert.equal(typeof RETENTION_BATCH_LIMIT, "number");
  assert.ok(RETENTION_BATCH_LIMIT > 0 && RETENTION_BATCH_LIMIT <= 1000);
});

test("68: a failure at any stage is reported, and never deletes on a guess", async () => {
  const now = Date.parse("2026-09-20T12:00:00.000Z");

  const counting = fakeRetentionClient({ count: 3, rows: [{ id: "a" }], failOn: "count" });
  assert.deepEqual(await sweepExpiredPendingEntries(counting.client, now), emptyRetentionSummary(true));
  assert.equal(counting.calls.deletes.length, 0, "a failed count still deleted rows");

  const listing = fakeRetentionClient({ count: 3, rows: [{ id: "a" }], failOn: "list" });
  assert.deepEqual(await sweepExpiredPendingEntries(listing.client, now), {
    due: 3, deleted: 0, remaining: 3, errored: true,
  });
  assert.equal(listing.calls.deletes.length, 0, "a failed id read still deleted rows");

  const deleting = fakeRetentionClient({ count: 3, rows: [{ id: "a" }], failOn: "delete" });
  assert.deepEqual(await sweepExpiredPendingEntries(deleting.client, now), {
    due: 3, deleted: 0, remaining: 3, errored: true,
  });

  // A count that came back due but whose id read returned nothing is not
  // an error and not a licence to delete something else.
  const empty = fakeRetentionClient({ count: 3, rows: [] });
  assert.deepEqual(await sweepExpiredPendingEntries(empty.client, now), {
    due: 3, deleted: 0, remaining: 3, errored: false,
  });
  assert.equal(empty.calls.deletes.length, 0);
});

test("69: the sweep touches one table, and cannot reach an order or a customer", () => {
  const code = stripJs(retentionLib);

  // One table name, one constant, and it is the waitlist.
  const tables = [...code.matchAll(/\.from\((\w+)\)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(tables)], ["WAITLIST_TABLE"]);
  assert.match(code, /WAITLIST_TABLE = "launch_waitlist"/);

  for (const banned of ["orders", "customer", "checkout_attempts", "subscriptions", "launch_rate_limit"]) {
    assert.ok(!new RegExp(`"${banned}"`).test(code), `the sweep names another table: ${banned}`);
  }

  // Every delete this file performs is narrowed to pending.
  const deletes = [...code.matchAll(/\.delete\(\)([\s\S]{0,200})/g)];
  assert.equal(deletes.length, 1);
  assert.match(deletes[0][1], /\.eq\("status", RETENTION_SWEEPABLE_STATUS\)/);

  // It logs driver messages only - never a row, an address or an id.
  assert.ok(!/console\.\w+\([^)]*\bids\b/.test(code), "the sweep logs the ids it deleted");
  assert.ok(!/console\.\w+\([^)]*email/i.test(code), "the sweep logs an address");
});

test("70: the sweep actually runs - it is wired into the daily cron, last and guarded", () => {
  // A retention rule nothing invokes is a comment. This is the assertion
  // that the job is reachable in a deployment rather than merely present
  // in the repository.
  assert.match(cronRoute, /sweepExpiredPendingEntries[\s\S]{0,200}?from "\.\.\/\.\.\/\.\.\/\.\.\/lib\/launchWaitlistRetention"/);
  assert.match(cronRoute, /await sweepExpiredPendingEntries\(/);

  // vercel.json registers the schedule this endpoint runs on.
  const vercelJson = JSON.parse(read("vercel.json"));
  const cron = vercelJson.crons.find((c) => c.path === "/api/cron/retry-order-notifications");
  assert.ok(cron, "the cron endpoint is not registered in vercel.json");
  assert.equal(typeof cron.schedule, "string");

  // Its own try/catch, so a retention failure cannot stop the four jobs
  // above it - and cannot be silently swallowed either.
  assert.match(cronRoute, /launchRetention = emptyRetentionSummary\(true\)/);

  // It runs LAST: nothing that sends or creates may be blocked by a
  // deletion sweep going wrong.
  const sweepAt = cronRoute.indexOf("await sweepExpiredPendingEntries(");
  for (const earlier of [
    "runTransactionalEmailRetryCron(",
    "sweepDueDeferredCancellations(",
    "runSubscriptionEmailRetrySweep(",
    "runAnnualPlanMaintenanceJob(",
  ]) {
    assert.ok(cronRoute.indexOf(earlier) < sweepAt, `the sweep runs before ${earlier}`);
  }

  // The endpoint is still authenticated by CRON_SECRET and still fails
  // closed without one - this change adds a deletion to it, so that
  // matters more than it did.
  assert.match(cronRoute, /const secret = process\.env\.CRON_SECRET/);
  assert.match(cronRoute, /if \(!secret\)[\s\S]{0,300}?status: 503/);
});

/* ── 13. The mark, the mail branding and the launch moment ────
 *
 * The wordmark is a piece of approved artwork, not a font and not
 * something a build step may regenerate. These tests hold that: they
 * check the actual bytes of the SVG the site and the mails are drawn
 * from, and they check that every colour variant is the SAME geometry
 * with a different fill.
 * ────────────────────────────────────────────────────────────── */

const logoSvg = read("public/gloa-logo-schwarz.svg");
const logoBlueSvg = read("public/gloa-logo-blue.svg");
const logoCreamSvg = read("public/gloa-logo-cream.svg");
const brandModule = read("lib/email/brand.ts");
const layout = read("app/layout.tsx");

/** The `d` attribute of every path, in order. This IS the geometry. */
function pathData(svg) {
  return [...svg.matchAll(/d="([^"]+)"/g)].map((m) => m[1]);
}

test("71: the wordmark is drawn artwork, never a font and never regenerated", () => {
  // Four closed paths - G, L, O and A - and not one glyph reference.
  // A <text> element or a font-family here would mean the mark is being
  // set in a typeface rather than drawn, which is the one thing the
  // brand rules forbid outright: the O is a bespoke organic form that no
  // font contains.
  assert.equal(pathData(logoSvg).length, 4, "the wordmark is not four drawn paths");
  for (const forbidden of ["<text", "font-family", "font-weight", "@font-face", "textPath"]) {
    assert.ok(!logoSvg.includes(forbidden), `the wordmark is set in type: ${forbidden}`);
  }

  // The approved artboard. A changed viewBox would mean the geometry was
  // re-cropped or re-scaled rather than reused.
  assert.match(logoSvg, /viewBox="54 52\.7785 825\.444 248\.443"/);
  assert.match(logoSvg, /<title>GLOA Schwarz ohne_Slogan #000000<\/title>/);

  // No slogan is baked into the wordmark itself. The slogan lockup is a
  // separate asset with a separate job.
  assert.ok(!/MATCHA IS FOR/i.test(logoSvg), "the wordmark has the slogan baked in");
});

test("72: every colour variant is the same geometry with a different fill", () => {
  // THIS IS THE WHOLE POINT OF THE VARIANTS. They were derived by
  // replacing the fill and nothing else, so a variant cannot quietly
  // become a redrawn, re-traced or AI-regenerated mark. Byte-identical
  // path data is the proof, and it is checked rather than trusted.
  const source = pathData(logoSvg);
  assert.deepEqual(pathData(logoBlueSvg), source, "the blue variant has different geometry");
  assert.deepEqual(pathData(logoCreamSvg), source, "the cream variant has different geometry");

  // The approved palette, and only it.
  assert.match(logoBlueSvg, /fill="#1746D1"/);
  assert.match(logoCreamSvg, /fill="#F5EBE2"/);
  assert.ok(!logoBlueSvg.includes("#000000"), "the blue variant still carries black");

  // Same artboard, so the three are interchangeable at any size.
  for (const svg of [logoBlueSvg, logoCreamSvg]) {
    assert.match(svg, /viewBox="54 52\.7785 825\.444 248\.443"/);
  }
});

test("73: the mail branding uses the approved palette and no other colour", () => {
  assert.equal(GLOA_BLUE, "#1746D1");
  assert.equal(GLOA_BERRY, "#A61E59");
  assert.equal(GLOA_CREAM, "#F5EBE2");
  assert.equal(GLOA_PLUM, "#4F3A5B");
  assert.equal(GLOA_NEAR_BLACK, "#111111");

  // Every hex literal in the module is one of the five. A lavender
  // button, a grey border or a stray white would show up here.
  const master = new Set([GLOA_BLUE, GLOA_BERRY, GLOA_CREAM, GLOA_PLUM, GLOA_NEAR_BLACK]);
  for (const hex of brandModule.match(/#[0-9a-fA-F]{6}/g) ?? []) {
    assert.ok(master.has(hex.toUpperCase()), `the mail branding uses an off-palette colour: ${hex}`);
  }

  // And none of the decoration GLOA does not use anywhere.
  for (const banned of ["linear-gradient", "border-radius", "box-shadow", "backdrop-filter"]) {
    assert.ok(!brandModule.includes(banned), `the mail branding uses ${banned}`);
  }
});

test("74: the mail logo is an absolute HTTPS PNG, sized and never stretched", () => {
  const html = buildLaunchConfirmationEmail({
    firstName: "Valmira",
    confirmUrl: "https://gloamatcha.com/api/launch/confirm?token=" + "a".repeat(64),
    withdrawUrl: "https://gloamatcha.com/api/launch/withdraw?token=" + "b".repeat(64),
    origin: "https://gloamatcha.com",
  }).html;

  // ABSOLUTE, AND HTTPS. A relative src has nothing to resolve against
  // in an inbox, and http:// is blocked or downgraded by most clients.
  assert.match(html, /<img src="https:\/\/gloamatcha\.com\/gloa-logo-blue-600\.png"/);
  assert.ok(!/src="\//.test(html), "the mail carries a relative image path");
  assert.ok(!/src="http:\/\//.test(html), "the mail loads an image over http");

  // A PNG, not the SVG: Outlook's renderer does not draw SVG at all.
  assert.ok(!/\.svg/.test(html), "the mail references an SVG");

  // Width and height as ATTRIBUTES as well as CSS - Outlook ignores the
  // CSS and would otherwise draw the file at its intrinsic 600px.
  assert.match(html, /width="132" height="40"/);
  // And the pair matches the artwork's real aspect ratio, so the mark
  // cannot arrive squashed or stretched.
  assert.equal(LOGO_DISPLAY_HEIGHT, Math.round((LOGO_DISPLAY_WIDTH * 248.443) / 825.444));

  // Alt text is the brand name. The mark IS the word, so "GLOA logo"
  // would have a screen reader announce the word twice.
  assert.match(html, /alt="GLOA"/);

  // THE SOCIAL PREVIEW IS NOT A LOGO and must never be used as one: it
  // has its own baked-in cream background and its own lockup, so in a
  // cream mail it would draw a second rectangle around a shrunken mark.
  assert.ok(!html.includes("gloa-logo-slogan-link"), "the mail uses the social preview as its logo");
});

test("75: a mail built without an origin has no logo rather than a broken image", () => {
  const html = buildLaunchConfirmationEmail({
    firstName: null,
    confirmUrl: "https://gloamatcha.com/api/launch/confirm?token=" + "a".repeat(64),
    withdrawUrl: "https://gloamatcha.com/api/launch/withdraw?token=" + "b".repeat(64),
  }).html;
  assert.ok(!html.includes("<img"), "a mail with no origin still carries an image tag");
  // The message itself is unaffected - it is still a complete, sendable
  // consent mail, because a missing logo may not cost somebody their
  // confirmation link.
  assert.ok(html.includes("Eintragung bestätigen"));
  assert.ok(html.includes("Fast geschafft."));
});

test("76: the confirmation mail's wording and purpose are untouched by the rebrand", () => {
  const { subject, html, text } = buildLaunchConfirmationEmail({
    firstName: "Valmira",
    confirmUrl: "https://gloamatcha.com/api/launch/confirm?token=" + "a".repeat(64),
    withdrawUrl: "https://gloamatcha.com/api/launch/withdraw?token=" + "b".repeat(64),
    origin: "https://gloamatcha.com",
  });

  // A visual pass may not change what a consent mail says.
  assert.equal(subject, "GLOA Launch List bestätigen");
  assert.ok(html.includes("Du erhältst über diese Eintragung keine regelmäßigen Newsletter."));
  assert.ok(html.includes("ausschließlich für die Launch-Benachrichtigung verwendet"));
  assert.ok(html.includes("Cara 2 GmbH, Hardenbergstr. 4, 10623 Berlin"));
  assert.ok(text.includes("Du erhältst über diese Eintragung keine regelmäßigen Newsletter."));

  // Still exactly one action, and still no marketing of any kind.
  for (const banned of ["/shop", "Rabatt", "Gutschein", "% ", "Angebot", "jetzt kaufen", "Produkte"]) {
    assert.ok(!html.includes(banned), `the consent mail advertises: ${banned}`);
  }
});

test("77: the structured-data logo is the wordmark, not the social preview", () => {
  // schema.org/logo is cropped to a square or a small box by whatever
  // consumes it, which cuts the slogan off the lockup and shrinks the
  // mark inside its own baked-in margins.
  assert.match(layout, /"@type": "Organization"[\s\S]*?logo: "\/gloa-logo-blue-600\.png"/);
  // The Open Graph and Twitter cards keep the lockup - that IS what it
  // is for.
  assert.match(layout, /openGraph:[\s\S]*?gloa-logo-slogan-link\.png/);
});

test("78: the launch moment is one constant, and every surface derives from it", () => {
  // The date is printed on four surfaces. None of them types it.
  //
  // Comments are not code - the note at the top of this file. A file
  // that explains WHY it must not hard-code the date would otherwise be
  // failed for explaining itself, and the honest fix would be to delete
  // the explanation.
  const site = stripJs(read("app/GloaSite.tsx"));
  const page = stripJs(launchPage);
  assert.ok(!/01\.10\.2026/.test(site), "GloaSite hard-codes the launch date");
  assert.ok(!/01\.10\.2026/.test(page), "the launch page hard-codes the launch date");
  assert.ok(!/12:00 UHR/.test(site), "GloaSite hard-codes the launch time");

  // The homepage countdown, the shop strip, the shop hero and /launch
  // all read the same derived label.
  assert.equal((site.match(/GLOA_LAUNCH_FULL_LABEL/g) ?? []).length, 5,
    "a launch-date surface stopped using the shared constant");
  assert.match(launchPage, /\{GLOA_LAUNCH_FULL_LABEL\}/);
});

test("79: reaching the launch instant does not open the shop", () => {
  // THE THREE THINGS THAT MUST STAY APART. A client clock is not
  // evidence that anything is buyable, and this is the assertion that
  // keeps the countdown from becoming a release switch.
  const countdown = stripJs(read("lib/launchCountdown.ts"));
  const content = stripJs(read("app/content.ts"));

  // The shop release is its own constant, edited and deployed by a
  // person - not derived from a date.
  assert.match(read("app/content.ts"), /export const SHOP_STATUS = "prelaunch"/);
  assert.ok(!countdown.includes("SHOP_STATUS"), "the countdown knows about the shop release");
  assert.ok(!content.includes("GLOA_LAUNCH"), "the shop release is derived from the launch date");

  // And `launched` is never used to gate a purchase. The site may say
  // "GLOA is here"; it may not put anything in a cart because of it.
  const site = stripJs(read("app/GloaSite.tsx"));
  for (const gate of [
    /launched\s*[?&|]{1,2}[^;]{0,80}handleAdd/,
    /launched\s*[?&|]{1,2}[^;]{0,80}checkout/i,
    /SHOP_STATUS\s*=\s*[^;]{0,40}launched/,
  ]) {
    assert.ok(!gate.test(site), `the countdown gates a purchase: ${gate}`);
  }
});

/* ══════════════════════════════════════════════════════════════
   14. THE SECOND CONSENT, AND THE WELCOME MAIL IT PERMITS

   The list now sends a welcome mail carrying the launch discount code.
   That is a second message AND it carries an offer, so version 1 of the
   consent does not cover it - that wording said "ausschließlich für
   diese Launch-Benachrichtigung", and the privacy notice said the list
   sends no offers.

   These tests hold the one rule that follows: a row is judged by the
   wording ITS OWNER was shown, never by the wording the current build
   renders.
   ══════════════════════════════════════════════════════════════ */

const welcomeTemplate = read("lib/email/launchWelcome.ts");
const welcomeMigration = read("supabase/migrations/045_launch_welcome_email.sql");

test("80: version 1 is preserved verbatim and is no longer the current wording", () => {
  // The people who signed it still exist. Deleting the constant would
  // not delete the promise, only make it unreadable from the code that
  // has to keep it.
  assert.equal(LAUNCH_CONSENT_VERSION_V1, "2026-09-06.launch-notification.v1");
  assert.match(LAUNCH_CONSENT_TEXT_V1, /ausschließlich für diese Launch-Benachrichtigung verwendet/);
  assert.ok(!LAUNCH_CONSENT_TEXT_V1.includes("Rabatt"), "v1 was rewritten to mention the discount");

  // The current wording is a different one.
  assert.notEqual(LAUNCH_CONSENT_VERSION, LAUNCH_CONSENT_VERSION_V1);
  assert.equal(LAUNCH_CONSENT_VERSION, "2026-09-07.launch-notification-with-code.v2");
  assert.deepEqual([...LAUNCH_CONSENT_VERSIONS], [LAUNCH_CONSENT_VERSION, LAUNCH_CONSENT_VERSION_V1]);
});

test("81: the current wording names both mails and promises nothing else", () => {
  // It has to name the discount, because that is what changed, and it
  // has to bound the count, because "two" is the whole promise.
  assert.match(LAUNCH_CONSENT_TEXT, /Launch-Rabattcode/);
  assert.match(LAUNCH_CONSENT_TEXT, /beiden E-Mails/);
  assert.match(LAUNCH_CONSENT_TEXT, /ausschließlich/);

  // And it must not have become a newsletter opt-in on the way.
  for (const banned of ["Newsletter", "regelmäßig", "Angebote", "Partner", "Werbung"]) {
    assert.ok(!LAUNCH_CONSENT_TEXT.includes(banned), `the consent text now permits: ${banned}`);
  }

  // THE PAGE SHOWS EXACTLY WHAT THE SERVER STORES. If these drift, the
  // stored evidence is a record of a sentence nobody read.
  const collapse = (s) => s.replace(/\s+/g, " ").trim();
  assert.ok(
    collapse(launchPage).includes(collapse(LAUNCH_CONSENT_TEXT)),
    "the launch page no longer renders the stored consent text verbatim"
  );
});

test("82: only version 2 may receive the welcome mail - v1 never can", () => {
  const base = {
    status: "confirmed",
    purpose: LAUNCH_PURPOSE,
    consent_version: LAUNCH_CONSENT_VERSION,
    welcome_email_sent_at: null,
  };
  assert.equal(mayReceiveWelcomeEmail(base), true);

  // THE ASSERTION THIS WHOLE FEATURE TURNS ON. The two people already on
  // the list signed v1 and are promised one mail and no offers.
  assert.equal(
    mayReceiveWelcomeEmail({ ...base, consent_version: LAUNCH_CONSENT_VERSION_V1 }),
    false,
    "a version 1 row would receive the discount mail"
  );

  // An unknown version is not evidence of anything either.
  for (const version of ["", "v2", "2027-01-01.something.v3", "unknown"]) {
    assert.equal(mayReceiveWelcomeEmail({ ...base, consent_version: version }), false,
      `an unknown consent version was accepted: ${version}`);
  }

  // The other three gates mirror mayReceiveLaunchNotification.
  for (const status of ["pending", "withdrawn", "notified"]) {
    assert.equal(mayReceiveWelcomeEmail({ ...base, status }), false, `a ${status} row was accepted`);
  }
  assert.equal(mayReceiveWelcomeEmail({ ...base, purpose: "marketing" }), false);
  assert.equal(mayReceiveWelcomeEmail({ ...base, welcome_email_sent_at: "2026-10-01T00:00:00Z" }), false,
    "the welcome mail would be sent twice");
});

test("83: the launch notification gate is unchanged by any of this", () => {
  // The second consent must not have widened the first. A v1 row still
  // receives the launch notification exactly as promised.
  for (const version of [LAUNCH_CONSENT_VERSION, LAUNCH_CONSENT_VERSION_V1]) {
    assert.equal(
      mayReceiveLaunchNotification({
        status: "confirmed", purpose: LAUNCH_PURPOSE,
        launch_notification_sent_at: null, consent_version: version,
      }),
      true,
      `a ${version} row lost its launch notification`
    );
  }
  // And it still refuses everything it refused before.
  assert.equal(mayReceiveLaunchNotification({
    status: "pending", purpose: LAUNCH_PURPOSE, launch_notification_sent_at: null,
  }), false);
});

test("84: 045 checks the consent version in SQL, not only in the application", () => {
  const sql = stripSql(welcomeMigration);
  // THE GATE IS A LITERAL, NOT A PARAMETER. It used to be
  // `consent_version = p_consent_version`, which let the CALLER decide
  // which wording counts - so anything able to execute the function
  // could pass the version 1 string and claim a version 1 contact for a
  // mail carrying an offer they never agreed to. A gate whose key the
  // caller supplies is not a gate.
  assert.ok(!sql.includes("p_consent_version"),
    "the welcome claim still takes the consent version from its caller");
  assert.ok(sql.includes(`and consent_version = '${LAUNCH_CONSENT_VERSION}'`),
    "the welcome claim does not pin the consent version itself");
  // The literal in the SQL and the constant in the code must agree, and
  // the version 1 string must appear nowhere in this migration.
  assert.ok(!sql.includes(LAUNCH_CONSENT_VERSION_V1),
    "045 mentions the version 1 wording");
  assert.match(sql, /and status = 'confirmed'/);
  assert.match(sql, /and withdrawn_at is null/);
  assert.match(sql, /and welcome_email_sent_at is null/);

  // Additive only, and it does not reach into 043's or 044's objects.
  for (const destructive of ["drop table", "drop column", "delete from", "truncate", "alter column"]) {
    assert.ok(!sql.toLowerCase().includes(destructive), `045 performs: ${destructive}`);
  }
  assert.ok(!sql.includes("launch_rate_limit"), "045 touches the rate limiter");
  assert.ok(!sql.includes("launch_release"), "045 touches the launch release");
  assert.ok(!/update .*consent_version|set consent_version/i.test(sql),
    "045 rewrites a stored consent version");

  // Server-only, same posture as 043 and 044.
  assert.ok(!/to anon|to authenticated/.test(sql), "045 grants something to a browser role");
  for (const fn of ["claim_welcome_email", "mark_welcome_email_sent", "release_welcome_email_claim"]) {
    assert.match(sql, new RegExp(`grant execute on function public\\.${fn}[^;]*to service_role`));
  }
});

test("85: a double-clicked confirmation link cannot send two welcome mails", () => {
  // The mail is sent from the confirm route, so the concurrency here is
  // not two workers but one link opened twice - by the person and by a
  // mail client's link scanner.
  const sql = stripSql(welcomeMigration);
  const claim = sql.slice(sql.indexOf("function public.claim_welcome_email"),
                          sql.indexOf("function public.mark_welcome_email_sent"));
  // One conditional UPDATE: exactly one caller can move the row from
  // unclaimed to claimed.
  assert.match(claim, /update public\.launch_waitlist/);
  assert.match(claim, /welcome_email_claim_id is null/);
  assert.match(claim, /get diagnostics v_updated = row_count/);
  // The claim returns the recipient WITH the verdict, so winning it and
  // knowing who to write to is one round trip - and a caller that lost
  // gets no address at all.
  assert.match(claim, /if v_updated = 1 then\s*return query select true, v_email, v_first_name;/);
  assert.match(claim, /return query select false, null::text, null::text;/);
  // And an expired claim can be taken again, so a crash does not strand
  // somebody without their code.
  assert.match(claim, /welcome_email_claimed_at < now\(\) - make_interval/);
});

test("86: the welcome mail hands over the code and links to no shop", () => {
  const { subject, html, text } = buildLaunchWelcomeEmail({
    firstName: "Anna",
    origin: "https://gloamatcha.com",
    code: "GLOALAUNCH10",
    percentLabel: "10 %",
    validFromLabel: "01.10.2026, 12:00 Uhr",
    validUntilLabel: "31.10.2026, 23:59 Uhr",
  });

  assert.equal(subject, "Willkommen bei GLOA. Hier ist dein Launch-Code.");
  assert.ok(html.includes("GLOALAUNCH10"));
  assert.ok(html.includes("10 %"));
  assert.ok(html.includes("01.10.2026, 12:00 Uhr"));
  assert.ok(html.includes("31.10.2026, 23:59 Uhr"));
  assert.ok(text.includes("DEIN CODE: GLOALAUNCH10"));

  // NO SHOP LINK. The shop is in prelaunch and the cart routes to
  // /contact; a "shop now" button three weeks early is a shut door.
  assert.ok(!html.includes("/shop"), "the welcome mail links to the shop before it opens");
  assert.ok(!/GLOA ist live|THE WAIT/.test(html), "the welcome mail claims the launch happened");

  // It carries the mark and the brand palette, and nothing else.
  assert.ok(html.includes('<img src="https://gloamatcha.com/gloa-logo-blue-600.png"'));
  assert.ok(html.includes("keine regelmäßigen Newsletter"));
  assert.ok(html.includes("Cara 2 GmbH"));
  for (const banned of ["Newsletter anmelden", "weiterempfehlen", "Event", "B2B", "width=\"1\""]) {
    assert.ok(!html.includes(banned), `the welcome mail carries: ${banned}`);
  }
});

test("87: the welcome mail states no percentage or date of its own", () => {
  // Every number is passed in, so the mail cannot promise something
  // lib/launchDiscount.ts does not grant.
  const code = stripJs(welcomeTemplate);
  assert.ok(!/10\s*%/.test(code), "the template hard-codes a percentage");
  assert.ok(!/GLOALAUNCH/.test(code), "the template hard-codes the code");
  assert.ok(!/01\.10\.2026|31\.10\.2026/.test(code), "the template hard-codes a date");
  assert.ok(!/Date\.now|new Date/.test(code), "the template reads a clock");
});

test("88: a re-submission never demotes a confirmed contact, and never upgrades a consent", () => {
  // THE TWO DEFECTS THIS CLOSES, both seen in live data.
  //
  // 1. DEMOTION. The old upsert wrote status='pending' over a confirmed
  //    row while leaving confirmed_at set. The live list held exactly
  //    that: confirmed at 18:23, demoted at 19:32 by a second form
  //    submission, with consent_given_at LATER than confirmed_at as the
  //    fingerprint. That contact would have been skipped by the send and
  //    deleted by the retention sweep as "never confirmed".
  //
  // 2. SILENT CONSENT UPGRADE. The same upsert overwrote
  //    consent_version, so a person who agreed to version 1 and
  //    re-submitted would have version 2 stored against them without
  //    ever confirming that wording.
  //
  // Both are now decided inside submit_launch_signup under a row lock.
  // The detail is asserted in tests 92, 93 and 96; this test holds the
  // two headline properties and the route's part of the bargain.
  const sql = stripSql(read("supabase/migrations/046_launch_signup_atomic.sql"));
  const fn = sql.slice(sql.indexOf("function public.submit_launch_signup"),
                       sql.indexOf("function public.confirm_launch_signup"));

  // Confirmed or notified under this exact wording: nothing is written.
  assert.match(fn, /v_row\.status in \('confirmed', 'notified'\)\s*and v_row\.consent_version = p_consent_version then\s*return 'already_current';/);

  // The branch that refreshes a CONFIRMED row touches neither the status
  // nor the consent in force.
  const confirmedBranch = fn.slice(fn.indexOf("if v_row.status in ('confirmed', 'notified') then"),
                                   fn.indexOf("else"));
  assert.ok(!/\bstatus\s*=/.test(confirmedBranch), "a re-submission demotes a confirmed contact");
  assert.ok(!/(^|[^_])consent_version\s*=/m.test(confirmedBranch), "a re-submission upgrades the consent");

  // And a row written back to pending carries no confirmed_at.
  const pendingBranch = fn.slice(fn.indexOf("else"), fn.indexOf("return 'refreshed';"));
  assert.match(pendingBranch, /confirmed_at\s*=\s*null/);

  // The route sends a mail only for the two outcomes that need one.
  assert.match(stripJs(signupRoute), /outcome !== "created" && outcome !== "refreshed"/);
});

test("89: the privacy notice matches what is actually sent", () => {
  // It may no longer say "keine Angebote" - a discount code is an offer.
  assert.ok(!gloaSite.includes("keine Angebote und keine Event-Einladungen"),
    "the privacy notice still promises no offers");

  // It names the welcome mail, bounds the count, and protects the people
  // who signed the earlier wording.
  assert.match(gloaSite, /Willkommens-E-Mail mit deinem Launch-Rabattcode/);
  assert.match(gloaSite, /genau zwei E-Mails/);
  assert.match(gloaSite, /deuten bestehende Einwilligungen nicht nachträglich um/);

  // Still no newsletter, and still no transfer into other lists.
  assert.match(gloaSite, /keine regelmäßigen Marketing-E-Mails/);
  assert.match(gloaSite, /nicht in andere Marketing- oder Verteilerlisten/);

  // The retention promise is unchanged.
  assert.match(gloaSite, /löschen wir die Eintragung nach 14 Tagen/);
});

test("90: the discount is visible on the landing page, from the shared constant", () => {
  assert.match(launchPage, /\{LAUNCH_DISCOUNT_LABEL\}/);
  assert.match(launchPage, /from "\.\.\/lib\/launchDiscount"/);
  // The page never types a percentage of its own.
  assert.ok(!/10\s*%/.test(stripJs(launchPage)), "the launch page hard-codes a percentage");
  // And it is still not a newsletter signup.
  assert.match(launchPage, /NUR FÜR DEN LAUNCH\. KEIN NEWSLETTER\./);
});

/* ══════════════════════════════════════════════════════════════
   15. ATOMIC SIGNUP AND CONSENT THAT SURVIVES A RE-SUBMISSION

   Migration 046 moved the whole decision into one locked statement and
   split the consent into two: the one IN FORCE and a newer one merely
   PROPOSED. These tests hold both properties against the SQL itself,
   because that is now where the rule lives.
   ══════════════════════════════════════════════════════════════ */

const atomicMigration = read("supabase/migrations/046_launch_signup_atomic.sql");
const confirmRouteSrc = read("app/api/launch/confirm/route.ts");

const signupFn = () => {
  const sql = stripSql(atomicMigration);
  return sql.slice(sql.indexOf("function public.submit_launch_signup"),
                   sql.indexOf("function public.confirm_launch_signup"));
};
const confirmFn = () => {
  const sql = stripSql(atomicMigration);
  return sql.slice(sql.indexOf("function public.confirm_launch_signup"),
                   sql.indexOf("revoke all on function public.submit_launch_signup"));
};

test("91: the decision is taken under a row lock, not read-then-write", () => {
  // A confirmation click landing between a read and a write could
  // previously overwrite a confirmation somebody had just made.
  const fn = signupFn();
  assert.match(fn, /select \* into v_row[\s\S]*?where email = p_email[\s\S]*?for update/);
  assert.match(confirmFn(), /where confirmation_token_hash = p_token_hash[\s\S]*?for update/);

  // And the route no longer reads the row itself before writing.
  const code = stripJs(signupRoute);
  assert.match(code, /supabase\.rpc\("submit_launch_signup"/);
  assert.ok(!code.includes('.select("id, status, confirmed_at'),
    "the route still reads the row before writing");
  assert.ok(!code.includes(".upsert("), "the route still upserts directly");
});

test("92: a confirmed contact is never demoted, reopened or revived", () => {
  const fn = signupFn();

  // Withdrawn wins outright, on either mark.
  assert.match(fn, /if v_row\.status = 'withdrawn' or v_row\.withdrawn_at is not null then\s*return 'withdrawn';/);

  // Confirmed or notified under this exact wording: nothing is written.
  assert.match(fn, /if v_row\.status in \('confirmed', 'notified'\)\s*and v_row\.consent_version = p_consent_version then\s*return 'already_current';/);

  // And when a confirmed row DOES need to re-confirm a new wording, the
  // update for that branch must not touch `status` at all - that is what
  // stops the demotion.
  const confirmedBranch = fn.slice(
    fn.indexOf("if v_row.status in ('confirmed', 'notified') then"),
    fn.indexOf("else")
  );
  assert.ok(confirmedBranch.length > 0, "the confirmed branch could not be isolated");
  assert.ok(!/\bstatus\s*=/.test(confirmedBranch), "the confirmed branch rewrites status");
  assert.ok(!/confirmed_at\s*=/.test(confirmedBranch), "the confirmed branch clears confirmed_at");
});

test("93: a re-submission never destroys the consent that is in force", () => {
  // THE DEFECT THIS CLOSES. consent_version, consent_text and
  // consent_given_at are the record Article 7(1) requires. The upsert
  // used to overwrite all three with the current wording, so a contact
  // who confirmed version 1 and re-submitted lost the evidence that they
  // had confirmed anything - and would then have been skipped by the
  // send and deleted by the retention sweep as "never confirmed".
  const fn = signupFn();
  const confirmedBranch = fn.slice(
    fn.indexOf("if v_row.status in ('confirmed', 'notified') then"),
    fn.indexOf("else")
  );

  // The in-force columns are not assigned in that branch.
  for (const col of ["consent_version", "consent_text", "consent_given_at"]) {
    assert.ok(
      !new RegExp(`(^|[^_])${col}\\s*=`, "m").test(confirmedBranch),
      `a re-submission overwrites the in-force ${col}`
    );
  }
  // The proposed wording goes somewhere else entirely.
  assert.match(confirmedBranch, /pending_consent_version\s*=\s*p_consent_version/);
  assert.match(confirmedBranch, /pending_consent_text\s*=\s*p_consent_text/);
  assert.match(confirmedBranch, /pending_consent_given_at\s*=\s*v_now/);
});

test("94: a proposed consent carries no permission until it is confirmed", () => {
  // The pending columns are a proposal. Only confirm_launch_signup
  // promotes them, and only because somebody clicked a link sent to that
  // address.
  const fn = confirmFn();
  // The pending wording is resolved once into locals and then written,
  // so the same values reach the row AND the permanent history.
  assert.match(fn, /v_version := coalesce\(v_row\.pending_consent_version, v_row\.consent_version\)/);
  assert.match(fn, /v_text\s*:= coalesce\(v_row\.pending_consent_text, v_row\.consent_text\)/);
  assert.match(fn, /consent_version = v_version/);
  assert.match(fn, /consent_text = v_text/);
  assert.match(fn, /pending_consent_version = null/);
  // The token is spent in the same statement, so the link works once.
  assert.match(fn, /confirmation_token_hash = null/);

  // NOTHING ELSE promotes a pending consent. Not the signup, not an
  // admin route, not a sweep.
  const sql = stripSql(atomicMigration);
  const promotions = [...sql.matchAll(/v_version := coalesce\(/g)];
  assert.equal(promotions.length, 1, "a second place promotes a pending consent");
  for (const rel of ["app/api/launch/route.ts", "lib/launchSend.ts", "lib/launchWaitlist.ts"]) {
    assert.ok(!/pending_consent/.test(stripJs(read(rel))),
      `${rel} touches the proposed consent`);
  }
});

test("95: the welcome mail still turns on the consent IN FORCE, so v1 cannot reach it", () => {
  // mayReceiveWelcomeEmail reads consent_version - the in-force column -
  // which the signup can no longer write. So the only route to the
  // discount mail is confirming version 2.
  assert.equal(
    mayReceiveWelcomeEmail({
      status: "confirmed", purpose: LAUNCH_PURPOSE,
      consent_version: LAUNCH_CONSENT_VERSION_V1, welcome_email_sent_at: null,
    }),
    false
  );
  assert.equal(
    mayReceiveWelcomeEmail({
      status: "confirmed", purpose: LAUNCH_PURPOSE,
      consent_version: LAUNCH_CONSENT_VERSION, welcome_email_sent_at: null,
    }),
    true
  );

  // A v1 contact who re-submits but never confirms keeps status
  // 'confirmed' and version 1 in force - entitled to the launch mail,
  // not to the discount mail. That is the whole design, expressed as the
  // two assertions above plus the SQL in test 93.
});

test("96: pending and confirmed_at can no longer coexist", () => {
  // The inconsistency that started all of this: a row reading pending
  // with a confirmed_at from an hour earlier.
  const fn = signupFn();
  const pendingBranch = fn.slice(fn.indexOf("else"), fn.indexOf("return 'refreshed';"));
  assert.match(pendingBranch, /confirmed_at\s*=\s*null/);
  assert.match(pendingBranch, /status\s*=\s*'pending'/);
  // And the migration ships the query that proves it stays true.
  assert.match(atomicMigration, /where status = 'pending' and confirmed_at is not null/);
});

test("97: there is exactly one valid confirmation link, decided by lock order", () => {
  // Two parallel submissions used to leave two links of which only the
  // later worked, by chance. The lock serialises them, so the surviving
  // token is the one written last - deterministically - and every
  // earlier link is dead the moment it is replaced.
  const fn = signupFn();
  assert.match(fn, /for update/);
  const writes = [...fn.matchAll(/confirmation_token_hash\s*=\s*p_confirmation_token_hash/g)];
  assert.equal(writes.length, 2, "the token is written somewhere other than the two update branches");
  // A concurrent insert that beat the lock is absorbed rather than
  // duplicated, and reported honestly.
  assert.match(fn, /on conflict \(email\) do nothing/);
  assert.match(fn, /return 'already_current';/);
});

test("98: the public response cannot be used to test whether an address exists", () => {
  // Four different database outcomes, two response shapes, and the two
  // that mean "already known" are indistinguishable from a fresh signup.
  const code = stripJs(signupRoute);
  assert.match(code, /if \(outcome !== "created" && outcome !== "refreshed"\) \{\s*return neutralSuccess\(\);/);
  // Nothing about the outcome reaches the caller.
  assert.ok(!/Response\.json\([^)]*outcome/.test(code), "the route returns the outcome");
  assert.ok(!/console\.\w+\([^)]*outcome/.test(code), "the route logs the outcome");
});

test("99: 046 is additive, depends only on 043, and is server-only", () => {
  const sql = stripSql(atomicMigration);

  for (const destructive of ["drop table", "drop column", "drop policy", "truncate",
                             "delete from", "alter column", "drop constraint"]) {
    assert.ok(!sql.toLowerCase().includes(destructive), `046 performs: ${destructive}`);
  }
  // Every added column is nullable, so every existing row stays valid.
  assert.match(sql, /add column if not exists pending_consent_version text/);
  assert.ok(!/pending_consent\w* [a-z]+ not null/.test(sql), "046 adds a NOT NULL column");

  // It does not depend on 044 or 045, so it can be applied on its own.
  for (const later of ["launch_release", "launch_send_claim_id", "welcome_email_sent_at",
                       "claim_launch_notifications", "claim_welcome_email"]) {
    assert.ok(!sql.includes(later), `046 depends on a later migration: ${later}`);
  }
  // And it does not touch 043's rate limiter.
  assert.ok(!sql.includes("launch_rate_limit"), "046 touches the rate limiter");

  // Server-only, same posture as 043.
  assert.ok(!/to anon|to authenticated/.test(sql), "046 grants something to a browser role");
  for (const fn of ["submit_launch_signup", "confirm_launch_signup"]) {
    assert.match(sql, new RegExp(`revoke all on function public\\.${fn}[^;]*from anon`));
    assert.match(sql, new RegExp(`grant execute on function public\\.${fn}[^;]*to service_role`));
    assert.match(sql, new RegExp(`create or replace function public\\.${fn}[\\s\\S]{0,400}?security definer set search_path = ''`));
  }
});

test("100: the confirm route decides nothing itself any more", () => {
  const code = stripJs(confirmRouteSrc);
  assert.match(code, /supabase\.rpc\("confirm_launch_signup"/);
  // No status write, no expiry arithmetic, no consent handling in the route.
  assert.ok(!code.includes(".update("), "the confirm route writes directly");
  assert.ok(!code.includes("isConfirmationExpired"), "the confirm route re-implements the expiry");
  // It may READ which wording is now in force - that is how it knows
  // whether the welcome mail is owed. What it may not do is write a
  // consent column: promoting a pending wording is the RPC's job, and
  // only because somebody clicked a link.
  assert.ok(!/consent_versions*=|consent_texts*=|consent_given_ats*=/.test(code),
    "the confirm route writes a consent column");
  assert.ok(!code.includes("pending_consent"), "the confirm route touches the proposed consent");
  // The TTL still comes from the one shared constant.
  assert.match(code, /p_ttl_days: CONFIRMATION_TOKEN_TTL_DAYS/);
  // Every outcome maps to an existing page state, and an unknown one is
  // treated as invalid rather than as success.
  assert.match(code, /outcome !== "confirmed"\) return redirect\("invalid"\)/);
});

/* ══════════════════════════════════════════════════════════════
   16. SENDING THE WELCOME MAIL, ONCE

   The mail goes out from the confirm route, on the same request that
   spends the token. The concurrency here is not two workers but one
   link opened twice - by the person, by a mail client's link scanner,
   by a restored tab. These tests drive the whole flow, including that
   double click, with no socket and no key.
   ══════════════════════════════════════════════════════════════ */

const welcomeSendLib = read("lib/launchWelcomeSend.ts");

function fakeWelcomeDb(opts = {}) {
  const state = {
    sent: false,
    claim: null,
    needsReview: false,
    reason: null,
    consentVersion: opts.consentVersion ?? LAUNCH_CONSENT_VERSION,
  };
  const calls = { claims: 0, marks: 0, releases: 0 };
  return {
    state,
    calls,
    async claim(rowId, claimId) {
      calls.claims += 1;
      if (opts.claimThrows) throw new Error("relation does not exist");
      // The SQL checks the consent version against ITS OWN literal, the
      // watermark, the review flag and the existing claim. The fake
      // enforces the same rules - note the caller passes no version.
      if (state.consentVersion !== LAUNCH_CONSENT_VERSION) return { claimed: false };
      if (state.sent || state.needsReview || state.claim !== null) return { claimed: false };
      state.claim = claimId;
      return { claimed: true, email: "person@example.com", firstName: "Anna" };
    },
    async markSent(rowId, claimId) {
      calls.marks += 1;
      if (opts.markThrows) throw new Error("mark exploded");
      if (state.claim !== claimId || state.sent) return false;
      state.sent = true;
      state.claim = null;
      return true;
    },
    async release(rowId, claimId, reason, needsReview) {
      calls.releases += 1;
      if (state.claim !== claimId) return false;
      state.claim = null;
      state.reason = reason;
      state.needsReview = needsReview;
      return true;
    },
  };
}

let claimCounter = 0;
const nextClaimId = () => `claim-${++claimCounter}`;

const okMailer = (behaviour = () => ({ ok: true })) => {
  const seen = [];
  return { seen, async send(recipient, key) { seen.push({ ...recipient, key }); return behaviour(); } };
};

test("101: a confirmed v2 contact receives the welcome mail exactly once", async () => {
  const db = fakeWelcomeDb();
  const mailer = okMailer();

  const first = await sendWelcomeEmail(db, mailer, "row-1", nextClaimId);
  assert.deepEqual(first, { kind: "sent" });
  assert.equal(mailer.seen.length, 1);
  assert.equal(mailer.seen[0].email, "person@example.com");
  assert.equal(mailer.seen[0].firstName, "Anna");
  assert.equal(db.state.sent, true);

  // A SECOND CLICK SENDS NOTHING. The watermark is set, so the claim
  // refuses - which is the whole reason it exists.
  const second = await sendWelcomeEmail(db, mailer, "row-1", nextClaimId);
  assert.deepEqual(second, { kind: "not_claimed" });
  assert.equal(mailer.seen.length, 1, "the welcome mail was sent twice");
});

test("102: two simultaneous clicks produce exactly one mail", async () => {
  const db = fakeWelcomeDb();
  const mailer = okMailer();

  const [a, b] = await Promise.all([
    sendWelcomeEmail(db, mailer, "row-1", nextClaimId),
    sendWelcomeEmail(db, mailer, "row-1", nextClaimId),
  ]);

  const kinds = [a.kind, b.kind].sort();
  assert.deepEqual(kinds, ["not_claimed", "sent"], `got ${kinds}`);
  assert.equal(mailer.seen.length, 1, "a double click sent two welcome mails");
});

test("103: a version 1 contact can never be claimed for it", async () => {
  // The gate is in SQL, so the fake models it there: the claim compares
  // the consent version and refuses. This is what protects the two
  // contacts already on the live list.
  const db = fakeWelcomeDb({ consentVersion: LAUNCH_CONSENT_VERSION_V1 });
  const mailer = okMailer();

  const outcome = await sendWelcomeEmail(db, mailer, "row-1", nextClaimId);
  assert.deepEqual(outcome, { kind: "not_claimed" });
  assert.equal(mailer.seen.length, 0, "a version 1 contact was sent the discount mail");
});

test("104: an unknown provider outcome parks the row and is never retried", async () => {
  const db = fakeWelcomeDb();
  const mailer = okMailer(() => ({ ok: false, unclear: true, reason: "key already in flight" }));

  const outcome = await sendWelcomeEmail(db, mailer, "row-1", nextClaimId);
  assert.equal(outcome.kind, "needs_review");
  assert.equal(db.state.needsReview, true);

  // Parked rows are invisible to the claim, so nothing retries them.
  const again = await sendWelcomeEmail(db, mailer, "row-1", nextClaimId);
  assert.deepEqual(again, { kind: "not_claimed" });

  // A thrown request is treated the same way: a dead socket says nothing
  // about whether the provider took the message.
  const db2 = fakeWelcomeDb();
  const throwing = { seen: [], async send() { throw new Error("socket hang up"); } };
  const thrown = await sendWelcomeEmail(db2, throwing, "row-2", nextClaimId);
  assert.equal(thrown.kind, "needs_review");
  assert.equal(db2.state.needsReview, true);
});

test("105: a plain refusal gives the claim back so it can be retried", async () => {
  const db = fakeWelcomeDb();
  let attempt = 0;
  const mailer = okMailer(() => (++attempt === 1 ? { ok: false, reason: "mailbox full" } : { ok: true }));

  const first = await sendWelcomeEmail(db, mailer, "row-1", nextClaimId);
  assert.equal(first.kind, "failed");
  assert.equal(db.state.needsReview, false, "a plain refusal parked the row");
  assert.equal(db.state.claim, null, "the claim was not given back");

  const second = await sendWelcomeEmail(db, mailer, "row-1", nextClaimId);
  assert.deepEqual(second, { kind: "sent" });
});

test("106: a mark that fails after the provider accepted parks the row", async () => {
  // The provider has the message and the database will not record it -
  // the one path on which a duplicate can exist.
  const db = fakeWelcomeDb({ markThrows: true });
  const outcome = await sendWelcomeEmail(db, okMailer(), "row-1", nextClaimId);
  assert.equal(outcome.kind, "needs_review");
  assert.match(outcome.reason, /mark failed after send/);
  assert.equal(db.state.needsReview, true);
});

test("107: a missing migration 045 reports unavailable and sends nothing", async () => {
  // 045 is not applied yet. Confirming must still work.
  const db = fakeWelcomeDb({ claimThrows: true });
  const mailer = okMailer();
  const outcome = await sendWelcomeEmail(db, mailer, "row-1", nextClaimId);
  assert.equal(outcome.kind, "unavailable");
  assert.equal(mailer.seen.length, 0);
});

test("108: the welcome mail never fails a confirmation", () => {
  // The confirm route redirects to the confirmed page regardless of what
  // the welcome mail did. Losing your place on the list because a second
  // mail failed would be the worse bug by far.
  const code = stripJs(confirmRouteSrc);
  const sendAt = code.indexOf("sendWelcomeEmail");
  const redirectAt = code.lastIndexOf('redirect("confirmed")');
  assert.ok(sendAt > 0, "the confirm route does not send the welcome mail");
  assert.ok(redirectAt > sendAt, "the confirmation is not returned after the welcome attempt");
  // Its failures are logged, not thrown, and never reach the visitor.
  assert.ok(!/throw/.test(code.slice(sendAt)), "a welcome failure can throw out of the confirm route");
});

test("109: the welcome key is its own namespace, so the two mails never dedupe together", () => {
  // Same person, two different messages. If they shared a namespace the
  // provider could treat the launch announcement as a repeat of the
  // welcome mail and silently drop it.
  const w = welcomeIdempotencyKey("row-1");
  const l = idempotencyKeyForLaunch("row-1");
  assert.notEqual(w, l);
  assert.ok(w.startsWith("gloa-launch-welcome:"));
  assert.ok(!w.includes("@"), "the key carries an address");
  assert.equal(welcomeIdempotencyKey("abc"), welcomeIdempotencyKey("abc"));
  assert.ok(w.length <= 256, "the key exceeds the provider's limit");
});

test("110: the send module is a leaf that logs nothing and reaches nothing", () => {
  const code = stripJs(welcomeSendLib);
  assert.ok(!/console\./.test(code), "the welcome send logs");
  assert.ok(!/fetch\(/.test(code), "the welcome send makes its own network call");
  assert.ok(!/supabase/i.test(code), "the welcome send builds its own client");
  assert.ok(!/process\.env/.test(code), "the welcome send reads the environment");
  assert.ok(!/from "\.\//.test(code), "the welcome send is not a leaf");
});

test("111: the mail states no number of its own - every value is passed in", () => {
  const template = stripJs(read("lib/email/launchWelcome.ts"));
  assert.ok(!/GLOALAUNCH/.test(template), "the template hard-codes the code");
  assert.ok(!/10\s*%/.test(template), "the template hard-codes a percentage");
  assert.ok(!/01\.10\.2026|31\.10\.2026/.test(template), "the template hard-codes a date");

  // And the wiring takes them from the one module that owns them.
  const deps = read("lib/launchWelcomeDeps.ts");
  assert.match(deps, /code: LAUNCH_DISCOUNT_CODE/);
  assert.match(deps, /percentLabel: `\$\{LAUNCH_DISCOUNT_PERCENT\} %`/);
  assert.match(deps, /validFromLabel: LAUNCH_DISCOUNT_FROM_LABEL/);
  assert.match(deps, /validUntilLabel: LAUNCH_DISCOUNT_UNTIL_LABEL/);

  // The printed labels agree with the instants the checkout enforces.
  assert.equal(LAUNCH_DISCOUNT_FROM_LABEL, "01.10.2026, 12:00 Uhr");
  assert.equal(LAUNCH_DISCOUNT_UNTIL_LABEL, "31.10.2026, 23:59 Uhr");
});

/* ── The launch page's offer block ───────────────────────────── */

test("112: the discount is a block on the page, not a line lost in the blue", () => {
  // It was one small paragraph under the date and it disappeared. It is
  // now the only Cream surface above the fold.
  assert.match(launchPage, /className="launch-offer"/);
  assert.match(launchPage, /\{LAUNCH_DISCOUNT_PERCENT\}<\/span>/);
  assert.match(launchPage, /AUF DEINE ERSTE BESTELLUNG/);
  assert.match(launchPage, /Einlösbar bis \{LAUNCH_DISCOUNT_UNTIL_LABEL\}/);

  // The requested copy, and it says where the code comes from - the page
  // deliberately does not print the code itself.
  assert.match(launchPage, /sichere dir \{LAUNCH_DISCOUNT_PERCENT\} % auf deine erste/);
  assert.match(launchPage, /Deinen Code erhältst du nach der Bestätigung deiner E-Mail-Adresse/);
  assert.ok(!launchPage.includes("GLOALAUNCH10"), "the launch page prints the shared code");

  // The figure is decorative markup; the group carries the readable name.
  assert.match(launchPage, /role="group" aria-label=\{LAUNCH_DISCOUNT_LABEL\}/);
  assert.match(launchPage, /className="launch-offer-figure" aria-hidden="true"/);

  // The launch date is stated once, not repeated beside the offer.
  // Rendered once. The other two mentions are the import and the
  // comment explaining why the date is not typed anywhere.
  assert.equal((launchPage.match(/{GLOA_LAUNCH_FULL_LABEL}/g) ?? []).length, 1,
    "the launch date is printed more than once");
});

test("113: the offer block uses only the approved palette and no sale decoration", () => {
  const css = read("app/globals.css");
  const block = css.slice(css.indexOf("/* THE OFFER BLOCK."), css.indexOf("/* THE LAUNCH MOMENT."));
  assert.ok(block.length > 0, "the offer block css is missing");

  // Brand tokens only - no raw hex, no colour from outside the palette.
  assert.ok(!/#[0-9a-fA-F]{3,8}/.test(block), "the offer block hard-codes a colour");
  assert.match(block, /background:var\(--cream\)/);
  assert.match(block, /color:var\(--blue\)/);

  // None of the decoration GLOA does not use.
  for (const banned of ["border-radius", "box-shadow", "linear-gradient", "backdrop-filter",
                        "text-shadow", "rotate(", "animation"]) {
    assert.ok(!block.includes(banned), `the offer block uses ${banned}`);
  }

  // It stacks on narrow screens rather than shrinking the number into
  // illegibility or letting the row overflow.
  assert.match(block, /@media \(max-width:430px\)/);
  assert.match(block, /flex-direction:column/);
  // And the figure is fluid, so 320px never clips it.
  assert.match(block, /font-size:clamp\(56px,11vw,104px\)/);
});

/* ══════════════════════════════════════════════════════════════
   17. THE AUDIT FINDINGS

   Five defects found by reading the migrations before applying them.
   Each of these tests is the one that would have caught it.
   ══════════════════════════════════════════════════════════════ */

const sendMigration = read("supabase/migrations/044_launch_send.sql");

/* ── 1. notified is terminal ─────────────────────────────────── */

test("114: confirming a consent never rewinds a notified contact", () => {
  // THE DEFECT. confirm_launch_signup wrote status = 'confirmed'
  // unconditionally. A contact who had already received the launch
  // announcement, then re-submitted the form (getting a fresh token
  // while keeping status 'notified'), then clicked it, would have been
  // moved back to 'confirmed'.
  //
  // No second announcement could have followed - the claim in 044 and
  // mayReceiveLaunchNotification both test launch_notification_sent_at -
  // but mayReceiveWelcomeEmail reads the STATUS, so a spent contact
  // would have become eligible for the welcome mail and its discount
  // code weeks after the launch it was written for.
  const sql = stripSql(atomicMigration);
  const fn = sql.slice(sql.indexOf("function public.confirm_launch_signup"));

  assert.match(fn, /v_status := case when v_row\.status = 'notified' then 'notified' else 'confirmed' end/);
  assert.match(fn, /set status = v_status/);
  // And nowhere in that function is the status written as a bare literal.
  assert.ok(!/set status = 'confirmed'/.test(fn),
    "the confirm function still forces status to confirmed");

  // The lifecycle gate in the application agrees: a notified row is not
  // eligible for either mail.
  assert.equal(mayReceiveLaunchNotification({
    status: "notified", purpose: LAUNCH_PURPOSE, launch_notification_sent_at: "2026-10-01T10:00:00Z",
  }), false);
  assert.equal(mayReceiveWelcomeEmail({
    status: "notified", purpose: LAUNCH_PURPOSE,
    consent_version: LAUNCH_CONSENT_VERSION, welcome_email_sent_at: null,
  }), false);
});

/* ── 2. A permanent record of confirmed consents ─────────────── */

test("115: every confirmation is written to an append-only history", () => {
  const sql = stripSql(atomicMigration);

  assert.match(sql, /create table if not exists public\.launch_consent_history/);
  // The two facts that make a double opt-in provable, kept apart.
  assert.match(sql, /given_at\s+timestamptz not null/);
  assert.match(sql, /confirmed_at\s+timestamptz not null/);
  // recorded_at is distinct, so a backfill can never pass for a live
  // confirmation.
  assert.match(sql, /recorded_at\s+timestamptz not null default now\(\)/);

  // APPEND-ONLY, ENFORCED BY THE GRANT rather than by a comment.
  assert.match(sql, /grant select, insert on public\.launch_consent_history to service_role;/);
  assert.ok(!/grant[^;]*\b(update|delete)\b[^;]*launch_consent_history/i.test(sql),
    "the consent history can be edited");
  assert.match(sql, /alter table public\.launch_consent_history enable row level security/);
  assert.ok(!/launch_consent_history[^;]*to (anon|authenticated)/.test(sql),
    "a browser role can read the consent history");

  // Written by the confirmation and by nothing else.
  const inserts = [...sql.matchAll(/insert into public\.launch_consent_history/g)];
  assert.equal(inserts.length, 2, "unexpected number of writers to the consent history");
  const fn = sql.slice(sql.indexOf("function public.confirm_launch_signup"));
  assert.match(fn, /insert into public\.launch_consent_history/);
});

test("116: a v1 proof survives a later v2 confirmation", () => {
  // THE DEFECT. consent_version, consent_text and consent_given_at are
  // overwritten when a newer wording takes effect - correctly, because
  // the newer one now governs. What was lost was the proof of the
  // earlier one: that this person confirmed version 1, on that day, to
  // that exact text. Article 7(1) is in the past tense, and a column
  // holding only the current value cannot answer it.
  const sql = stripSql(atomicMigration);
  const fn = sql.slice(sql.indexOf("function public.confirm_launch_signup"));

  // The history row carries the wording that took effect AT THAT TIME,
  // stored in full rather than as a reference to a constant that will be
  // redeployed.
  assert.match(fn, /values\s*\(v_row\.id, v_version, v_text, v_given, v_now\)/);
  // So a second confirmation adds a second row rather than replacing the
  // first: nothing in the function updates or deletes history.
  assert.ok(!/update public\.launch_consent_history|delete from public\.launch_consent_history/.test(sql),
    "a confirmation rewrites earlier consent history");
});

test("117: a pending wording never reaches the history, and nothing is back-dated", () => {
  const sql = stripSql(atomicMigration);
  // Only the confirm function writes, so a signup - which only ever
  // writes pending_consent_* - cannot record a consent.
  const signup = sql.slice(sql.indexOf("function public.submit_launch_signup"),
                           sql.indexOf("function public.confirm_launch_signup"));
  assert.ok(!signup.includes("launch_consent_history"),
    "signing up writes to the consent history");

  // THE BACKFILL TAKES ONLY WHAT IS ALREADY THERE. Rows that carry a
  // confirmation, with their own recorded values, and nothing else.
  const backfill = sql.slice(sql.indexOf("insert into public.launch_consent_history\n  (waitlist_id"));
  assert.match(backfill, /where w\.confirmed_at is not null/);
  assert.match(backfill, /select w\.id, w\.consent_version, w\.consent_text,/);
  // recorded_at is left to its default of now() - a row written today
  // must not claim to have been written when the consent was given.
  assert.ok(!/recorded_at/.test(backfill.slice(0, backfill.indexOf(";"))),
    "the backfill sets its own recorded_at");
  // Re-running the migration cannot duplicate an entry.
  assert.match(backfill, /and not exists \(/);
});

/* ── 4. Claims, timeouts and recovery ────────────────────────── */

test("118: an expired claim is parked, never silently reissued", () => {
  // THE DEFECT, in both migrations. The stale window handed an abandoned
  // claim to the next caller. That is right for work that was never
  // started and wrong for work that may already have finished: a worker
  // that died AFTER the provider accepted leaves the same trace as one
  // that died before it.
  //
  // Resend keeps an idempotency key for 24 hours. A stale claim can be
  // older than that, so re-sending on the strength of one is a coin flip
  // between a missing mail and a duplicate.
  for (const [name, sql, prefix] of [
    ["044", stripSql(sendMigration), "launch_send"],
    ["045", stripSql(welcomeMigration), "welcome_email"],
  ]) {
    // Expired claims become review cases...
    assert.match(sql, new RegExp(`set ${prefix}_needs_review\\s*= true,\\s*${prefix}_failed_reason = 'claim expired with an unknown send outcome'`),
      `${name} does not park expired claims`);
    // ...and the claim itself only ever takes an UNCLAIMED row.
    assert.ok(!new RegExp(`or c?\\.?${prefix}_claimed_at < now\\(\\)`).test(sql),
      `${name} still takes over a stale claim`);
    // A parked row is invisible to the claim.
    assert.match(sql, new RegExp(`${prefix}_needs_review is not true`),
      `${name} claims rows that are under review`);
  }
});

test("119: the full chain - claim, provider, mark, failure, recovery", async () => {
  // Driven end to end against the fake, which mirrors the SQL.

  // (a) The happy path closes the row for good.
  let db = fakeWelcomeDb();
  assert.deepEqual(await sendWelcomeEmail(db, okMailer(), "r", nextClaimId), { kind: "sent" });
  assert.equal(db.state.sent, true);

  // (b) A provider TIMEOUT is unknown, so the row is parked and stays
  //     parked - no later call may pick it up.
  db = fakeWelcomeDb();
  const timeout = { seen: [], async send() { throw new Error("ETIMEDOUT"); } };
  const parked = await sendWelcomeEmail(db, timeout, "r", nextClaimId);
  assert.equal(parked.kind, "needs_review");
  assert.equal(db.state.needsReview, true);
  for (let i = 0; i < 5; i += 1) {
    assert.deepEqual(await sendWelcomeEmail(db, okMailer(), "r", nextClaimId), { kind: "not_claimed" });
  }
  assert.equal(db.state.sent, false, "a parked row was eventually sent anyway");

  // (c) A plain refusal is recoverable - the claim is given back and the
  //     row is NOT parked.
  db = fakeWelcomeDb();
  let n = 0;
  const flaky = okMailer(() => (++n === 1 ? { ok: false, reason: "mailbox full" } : { ok: true }));
  assert.equal((await sendWelcomeEmail(db, flaky, "r", nextClaimId)).kind, "failed");
  assert.equal(db.state.needsReview, false);
  assert.deepEqual(await sendWelcomeEmail(db, flaky, "r", nextClaimId), { kind: "sent" });

  // (d) The database being unreachable is neither sent nor parked - the
  //     row is untouched and the confirmation still succeeded.
  db = fakeWelcomeDb({ claimThrows: true });
  const down = await sendWelcomeEmail(db, okMailer(), "r", nextClaimId);
  assert.equal(down.kind, "unavailable");
  assert.equal(db.state.sent, false);
  assert.equal(db.state.needsReview, false);
});

test("120: a withdrawal outranks a pending confirmation in both directions", () => {
  const sql = stripSql(atomicMigration);
  const confirm = sql.slice(sql.indexOf("function public.confirm_launch_signup"));

  // Confirming a withdrawn row does nothing and says so.
  assert.match(confirm, /if v_row\.status = 'withdrawn' or v_row\.withdrawn_at is not null then\s*return query select 'withdrawn'/);
  // The check comes before the update, so no consent is recorded for it.
  assert.ok(confirm.indexOf("'withdrawn'") < confirm.indexOf("insert into public.launch_consent_history"),
    "a withdrawn row can still record a consent");

  // And the welcome claim excludes withdrawn rows outright.
  assert.match(stripSql(welcomeMigration), /and withdrawn_at is null/);
});

/* ══════════════════════════════════════════════════════════════
   18. THE DEPLOYMENT GAP

   The routes call RPCs that migration 046 creates. The code shipped
   before the migration was applied and the public list answered 503 to
   everybody for about an hour. These tests hold the bridge that keeps it
   working until the migration lands - and, just as importantly, hold
   that only a MISSING FUNCTION takes that path.
   ══════════════════════════════════════════════════════════════ */

const compatLib = read("lib/launchSignupCompat.ts");

test("121: only a missing function falls back - every other failure refuses", () => {
  // A timeout, a permission error or a dead connection must NOT be
  // treated as "the migration is pending". Getting this wrong would turn
  // a database outage into silent writes down a narrower path.
  assert.equal(isMissingFunctionError({ code: "PGRST202" }), true);
  assert.equal(isMissingFunctionError({ message: "Could not find the function public.submit_launch_signup" }), true);

  for (const other of [
    null, undefined, {}, "PGRST202",
    { code: "PGRST301" },
    { code: "42501", message: "permission denied for function submit_launch_signup" },
    { code: "57014", message: "canceling statement due to statement timeout" },
    { message: "fetch failed" },
    { message: "Could not find the table public.launch_waitlist" },
  ]) {
    assert.equal(isMissingFunctionError(other), false, `treated as missing: ${JSON.stringify(other)}`);
  }

  // The route branches on exactly that, and refuses otherwise.
  const code = stripJs(signupRoute);
  assert.match(code, /if \(!signupError\)/);
  assert.match(code, /} else if \(isMissingFunctionError\(signupError\)\) \{/);
  assert.match(code, /} else \{[\s\S]{0,300}?return temporarilyUnavailable\(\);/);
});

test("122: the legacy signup never demotes, revives or overwrites a consent", async () => {
  const calls = [];
  const db = (row) => ({
    async findByEmail() { return row; },
    async insertPending(i) { calls.push(["insert", i.email]); },
    async refreshPending(id) { calls.push(["refresh", id]); },
  });
  const input = {
    email: "a@example.com", firstName: null, audienceType: null, source: "launch_page",
    consentVersion: LAUNCH_CONSENT_VERSION, consentText: LAUNCH_CONSENT_TEXT,
    confirmationTokenHash: "a".repeat(64), withdrawalTokenHash: "b".repeat(64),
  };

  // New address: inserted.
  calls.length = 0;
  assert.equal(await legacySignup(db(null), input), "created");
  assert.deepEqual(calls, [["insert", "a@example.com"]]);

  // Pending: tokens refreshed, which is what makes "I never got the
  // mail" work.
  calls.length = 0;
  assert.equal(await legacySignup(db({
    id: "r1", status: "pending", confirmed_at: null, withdrawn_at: null,
    consent_version: LAUNCH_CONSENT_VERSION,
  }), input), "refreshed");
  assert.deepEqual(calls, [["refresh", "r1"]]);

  // Confirmed, notified, withdrawn: NOTHING IS WRITTEN in any of them.
  for (const [status, extra, expected] of [
    ["confirmed", { confirmed_at: "x" }, "already_current"],
    ["notified", { confirmed_at: "x" }, "already_current"],
    ["withdrawn", { withdrawn_at: "y" }, "withdrawn"],
  ]) {
    calls.length = 0;
    const outcome = await legacySignup(db({
      id: "r2", status, confirmed_at: null, withdrawn_at: null,
      consent_version: LAUNCH_CONSENT_VERSION, ...extra,
    }), input);
    assert.equal(outcome, expected, `${status} gave ${outcome}`);
    assert.deepEqual(calls, [], `${status} wrote to the database`);
  }

  // Explicitly: an older wording writes nothing.
  calls.length = 0;
  assert.equal(await legacySignup(db({
    id: "r3", status: "confirmed", confirmed_at: "x", withdrawn_at: null,
    consent_version: LAUNCH_CONSENT_VERSION_V1,
  }), input), "already_current");
  assert.deepEqual(calls, [], "the legacy path overwrote an older consent");
});

test("123: a legacy refresh clears confirmed_at, so the old inconsistency cannot recur", () => {
  // The live list holds one row reading pending with a confirmed_at.
  // Whatever path writes a pending row must clear it.
  assert.match(compatLib, /confirmed_at: null,/);
  const refresh = compatLib.slice(compatLib.indexOf("async refreshPending"));
  assert.match(refresh, /status: "pending"/);
  assert.match(refresh, /confirmed_at: null/);
});

test("124: the legacy confirmation honours withdrawal, expiry and a spent token", async () => {
  const row = (over = {}) => ({
    id: "r1", status: "pending",
    confirmation_sent_at: "2026-09-07T19:32:40.000Z",
    withdrawn_at: null, ...over,
  });
  const NOW = Date.parse("2026-09-10T00:00:00Z");
  const db = (r, won = true) => ({
    async findByToken() { return r; },
    async confirm() { return won; },
  });

  assert.equal(await legacyConfirm(db(row()), "a".repeat(64), NOW, 14), "confirmed");
  assert.equal(await legacyConfirm(db(null), "a".repeat(64), NOW, 14), "invalid");
  assert.equal(await legacyConfirm(db(row({ status: "withdrawn" })), "a".repeat(64), NOW, 14), "withdrawn");
  assert.equal(await legacyConfirm(db(row({ withdrawn_at: "z" })), "a".repeat(64), NOW, 14), "withdrawn");

  // Expiry, to the day.
  const late = Date.parse("2026-09-07T19:32:40.000Z") + 15 * 24 * 60 * 60 * 1000;
  assert.equal(await legacyConfirm(db(row()), "a".repeat(64), late, 14), "expired");
  assert.equal(await legacyConfirm(db(row({ confirmation_sent_at: null })), "a".repeat(64), NOW, 14), "expired");

  // A second click loses the compare-and-swap and is not reported as a
  // fresh confirmation.
  assert.equal(await legacyConfirm(db(row(), false), "a".repeat(64), NOW, 14), "invalid");
});

test("125: the bridge is temporary, self-contained and says so", () => {
  // One file, so it can be deleted in one move once 046 is applied.
  assert.match(compatLib, /IT IS TEMPORARY, AND IT SAYS SO/);
  assert.match(compatLib, /Delete it then/);

  // It writes only 043's columns - nothing from 044, 045 or 046.
  const code = stripJs(compatLib);
  for (const later of ["pending_consent", "welcome_email", "launch_send", "launch_release",
                       "launch_consent_history"]) {
    assert.ok(!code.includes(later), `the bridge touches a later migration's column: ${later}`);
  }
  // And it never sends anything itself.
  assert.ok(!/resend|emails\.send|fetch\(/i.test(code), "the bridge sends mail");
});

test("126: both routes prefer the RPC and only fall back on its absence", () => {
  for (const [name, source, rpc] of [
    ["signup", signupRoute, "submit_launch_signup"],
    ["confirm", confirmRouteSrc, "confirm_launch_signup"],
  ]) {
    const code = stripJs(source);
    // Measured on the CALL, not the import at the top of the file.
    const rpcAt = code.indexOf(rpc);
    const fallbackAt = code.indexOf("isMissingFunctionError(");
    assert.ok(rpcAt > 0, `${name} no longer calls the RPC`);
    assert.ok(fallbackAt > rpcAt, `${name} checks for the fallback before trying the RPC`);
  }

  // The confirm route does not attempt the welcome mail on the legacy
  // path - it needs 045, which is equally absent.
  const legacyBlock = stripJs(confirmRouteSrc);
  const legacyAt = legacyBlock.indexOf("legacyConfirm(");
  const welcomeAt = legacyBlock.indexOf("sendWelcomeEmail(");
  assert.ok(legacyAt > 0 && welcomeAt > legacyAt,
    "the legacy confirmation path tries to send the welcome mail");
});
