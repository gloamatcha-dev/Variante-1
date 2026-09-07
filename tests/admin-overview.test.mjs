import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ADMIN_SESSION_COOKIE,
  ADMIN_SESSION_SECRET_MIN_LENGTH,
  ADMIN_SESSION_TTL_MS,
  adminSessionCookie,
  clearedAdminSessionCookie,
  isAllowedAdmin,
  issueAdminSession,
  parseAdminAllowlist,
  readAdminSession,
  readCookie,
} from "../lib/adminSession.ts";

import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  WAITLIST_COLUMNS,
  WAITLIST_FILTERS,
  normalizeSearch,
  pageRange,
  resolvePage,
  resolvePageSize,
  resolveWaitlistFilter,
  resolveWaitlistQuery,
} from "../lib/adminWaitlistQuery.ts";

/* ══════════════════════════════════════════════════════════════
   THE PRIVATE OVERVIEW

   SAFE DEFAULT SUITE: the session is pure arithmetic over a token and
   is driven with explicit inputs; the routes and the component are
   checked at source level. Nothing here opens a socket, signs anybody
   in, or reads a row.

   WHAT THIS SUITE PROTECTS: that the only way to see the launch list is
   a signed session belonging to an address on the allowlist, and that
   the browser never holds a credential worth stealing.
   ══════════════════════════════════════════════════════════════ */

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf-8");
const stripJs = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const sessionLib = read("lib/adminSession.ts");
const sessionDeps = read("lib/adminSessionDeps.ts");
const sessionRoute = read("app/api/admin/session/route.ts");
const waitlistRoute = read("app/api/admin/waitlist/route.ts");
const overview = read("app/AdminOverview.tsx");
const pageFile = read("app/adminxyzuebersicht/page.tsx");

const SECRET = "s".repeat(48);
const OTHER_SECRET = "t".repeat(48);
const NOW = Date.parse("2026-09-08T10:00:00Z");

/* ── 1. The session token ────────────────────────────────────── */

test("1: a session round-trips, and only with the key that signed it", () => {
  const token = issueAdminSession("ops@gloamatcha.com", NOW, SECRET);
  const session = readAdminSession(token, NOW, SECRET);
  assert.deepEqual(session, {
    email: "ops@gloamatcha.com",
    expiresAtMs: NOW + ADMIN_SESSION_TTL_MS,
  });

  // A different key does not verify it. That is what makes the token
  // worthless if it is copied to another deployment.
  assert.equal(readAdminSession(token, NOW, OTHER_SECRET), null);
});

test("2: a forged, altered or malformed token is refused", () => {
  const token = issueAdminSession("ops@gloamatcha.com", NOW, SECRET);
  const [, payload, mac] = token.split(".");

  for (const bad of [
    null, undefined, "", "v1", "v1.a", "v1.a.b.c",
    `v2.${payload}.${mac}`,                         // wrong version
    `v1.${payload}.${"x".repeat(mac.length)}`,      // wrong signature
    `v1.${payload}.`,                               // no signature
    `v1..${mac}`,                                   // no payload
    // Payload edited to name somebody else, signature left alone.
    `v1.${Buffer.from(JSON.stringify({ e: "attacker@example.com", x: NOW + 1000 })).toString("base64url")}.${mac}`,
    // Not JSON at all.
    `v1.${Buffer.from("not json").toString("base64url")}.${mac}`,
  ]) {
    assert.equal(readAdminSession(bad, NOW, SECRET), null, `accepted: ${String(bad).slice(0, 40)}`);
  }
});

test("3: the expiry is enforced from the signed payload, not from the cookie", () => {
  const token = issueAdminSession("ops@gloamatcha.com", NOW, SECRET);

  assert.ok(readAdminSession(token, NOW + ADMIN_SESSION_TTL_MS - 1, SECRET));
  // At the expiry it is already gone.
  assert.equal(readAdminSession(token, NOW + ADMIN_SESSION_TTL_MS, SECRET), null);
  assert.equal(readAdminSession(token, NOW + ADMIN_SESSION_TTL_MS + 1, SECRET), null);

  // The lifetime is inside the payload, so a client extending the
  // cookie's Max-Age gains nothing.
  assert.match(sessionLib, /THE EXPIRY IS ENFORCED HERE, from the signed payload/);
  assert.equal(ADMIN_SESSION_TTL_MS, 8 * 60 * 60 * 1000);
});

test("4: a short or missing signing key refuses everybody", () => {
  const short = "x".repeat(ADMIN_SESSION_SECRET_MIN_LENGTH - 1);
  const token = issueAdminSession("ops@gloamatcha.com", NOW, short);
  assert.equal(readAdminSession(token, NOW, short), null, "a short key was accepted");
  assert.equal(readAdminSession(token, NOW, null), null);
  assert.equal(readAdminSession(token, NOW, ""), null);
  assert.ok(ADMIN_SESSION_SECRET_MIN_LENGTH >= 32);
});

/* ── 2. The cookie ───────────────────────────────────────────── */

test("5: the cookie is HttpOnly, Secure and SameSite=Strict", () => {
  const c = adminSessionCookie("abc", 3600);
  // HttpOnly: no script can read it, so an injected script can ride the
  // session but never extract it.
  assert.match(c, /HttpOnly/);
  // Secure: never travels in clear.
  assert.match(c, /Secure/);
  // Strict: another origin cannot cause an authenticated request at all,
  // which removes the CSRF surface rather than mitigating it.
  assert.match(c, /SameSite=Strict/);
  assert.match(c, /Path=\//);
  assert.match(c, /Max-Age=3600/);

  // Clearing is the same cookie with no value and no lifetime.
  assert.match(clearedAdminSessionCookie(), /Max-Age=0/);
  assert.match(clearedAdminSessionCookie(), /HttpOnly/);

  // The name does not advertise what it is for.
  assert.equal(ADMIN_SESSION_COOKIE, "gloa_ops");
  assert.ok(!/admin/i.test(ADMIN_SESSION_COOKIE));
});

test("6: cookie parsing picks the right one and tolerates rubbish", () => {
  assert.equal(readCookie("gloa_ops=abc", "gloa_ops"), "abc");
  assert.equal(readCookie("a=1; gloa_ops=abc; b=2", "gloa_ops"), "abc");
  assert.equal(readCookie("  gloa_ops = abc ", "gloa_ops"), "abc");
  // A prefix match must not win.
  assert.equal(readCookie("not_gloa_ops=abc", "gloa_ops"), null);
  assert.equal(readCookie("gloa_ops_x=abc", "gloa_ops"), null);
  for (const bad of [null, "", "novalue", "=x", "; ;"]) {
    assert.equal(readCookie(bad, "gloa_ops"), null, `parsed: ${bad}`);
  }
});

/* ── 3. The allowlist ────────────────────────────────────────── */

test("7: an empty allowlist authorises nobody", () => {
  // An admin surface whose allowlist was forgotten must be shut, not
  // open. This is the assertion that keeps a missing env var from
  // becoming a public page.
  for (const raw of [undefined, null, "", "   ", ",,,", "not-an-email"]) {
    assert.deepEqual(parseAdminAllowlist(raw), [], `parsed something from ${JSON.stringify(raw)}`);
    assert.equal(isAllowedAdmin("ops@gloamatcha.com", parseAdminAllowlist(raw)), false);
  }
});

test("8: the allowlist is exact, case-insensitive and trimmed", () => {
  const list = parseAdminAllowlist(" Ops@GloaMatcha.com , second@example.com ");
  assert.deepEqual(list, ["ops@gloamatcha.com", "second@example.com"]);

  assert.equal(isAllowedAdmin("ops@gloamatcha.com", list), true);
  assert.equal(isAllowedAdmin("OPS@GLOAMATCHA.COM", list), true);
  assert.equal(isAllowedAdmin("  ops@gloamatcha.com  ", list), true);

  // No partial or lookalike match.
  for (const wrong of [
    "ops@gloamatcha.com.evil.com", "xops@gloamatcha.com", "ops@gloamatcha.co",
    "ops@gloamatcha", "@gloamatcha.com", "", null, undefined,
  ]) {
    assert.equal(isAllowedAdmin(wrong, list), false, `accepted: ${JSON.stringify(wrong)}`);
  }
});

test("9: the allowlist is re-checked on every request, not only at sign-in", () => {
  // Removing somebody from ADMIN_EMAILS and redeploying has to lock them
  // out immediately, not in eight hours when their token happens to lapse.
  assert.match(sessionDeps, /if \(!isAllowedAdmin\(session\.email, getAdminAllowlist\(\)\)\) return null;/);
  assert.match(sessionDeps, /both are re-checked on EVERY request/);
});

/* ── 4. What the browser is given ────────────────────────────── */

test("10: no secret of any kind reaches the browser", () => {
  const client = stripJs(overview);
  for (const forbidden of [
    "SUPABASE_SECRET_KEY", "LAUNCH_ADMIN_SECRET", "ADMIN_SESSION_SECRET",
    "SERVICE_ROLE", "service_role", "ADMIN_EMAILS", "process.env",
  ]) {
    assert.ok(!client.includes(forbidden), `the overview references ${forbidden}`);
  }
  // It does not even read its own cookie - it cannot, and does not try.
  assert.ok(!client.includes("document.cookie"), "the overview reads cookies");
  // And it holds no Supabase client at all.
  assert.ok(!/createClient|supabase/i.test(client), "the overview builds a Supabase client");
});

test("11: the Supabase token proves the password and is then discarded", () => {
  // The browser gets this application's own session, never a Supabase
  // credential - so nothing on the page can be replayed against the
  // database directly.
  assert.match(sessionDeps, /signInWithPassword/);
  assert.match(sessionDeps, /client\.auth\.signOut\(\)/);
  assert.match(sessionDeps, /The token is not returned and not stored/);
  const deps = stripJs(sessionDeps);
  assert.ok(!/return[^;]*data\.session/.test(deps), "the Supabase session is returned");
  assert.ok(!/access_token/.test(deps), "the Supabase access token is handled");
});

/* ── 5. The endpoints ────────────────────────────────────────── */

test("12: signing in is rate limited before the password is checked", () => {
  const code = stripJs(sessionRoute);
  // Measured on the CALLS, not the imports at the top of the file.
  const limitAt = code.indexOf("await consumePersistentRateLimit(");
  const checkAt = code.indexOf("await checkAdminPassword(");
  assert.ok(limitAt > 0 && checkAt > limitAt, "the password is checked before the attempt is counted");

  // The SHARED counter, so the limit holds across serverless instances.
  assert.match(code, /consumePersistentRateLimit\(\s*supabase/);
  // Fails closed.
  assert.match(code, /limit\.kind === "unavailable"[\s\S]{0,200}?return unauthorized\(\)/);
  // Its own bucket namespace, so admin attempts and public signups do
  // not exhaust each other's budget.
  assert.match(code, /`admin-login:\$\{rateLimitKeyFromRequest\(request\)\}`/);
  assert.match(code, /LOGIN_ATTEMPTS_PER_WINDOW = 5/);
});

test("13: every refusal looks the same from outside", () => {
  const code = stripJs(sessionRoute);
  // A wrong password, an unknown address, a correct password for an
  // account that is not on the allowlist, and a deployment with no
  // allowlist all return the same 401 body.
  const refusals = [...code.matchAll(/return unauthorized\(\)/g)];
  assert.ok(refusals.length >= 5, `expected several identical refusals, found ${refusals.length}`);
  assert.match(code, /function unauthorized\(\)[\s\S]{0,200}?status: 401/);
  // Only the log distinguishes them, and it never names the password.
  assert.ok(!/console\.\w+\([^)]*password/i.test(code), "the route logs a password");
});

test("14: an address not on the allowlist never reaches the password check", () => {
  const code = stripJs(sessionRoute);
  const allowAt = code.indexOf("isAllowedAdmin(email, allowlist)");
  const checkAt = code.indexOf("await checkAdminPassword(");
  assert.ok(allowAt > 0 && checkAt > allowAt, "the password is checked before the allowlist");
  // And the address Supabase confirmed is checked again afterwards -
  // the body's claim is never the one that authorises.
  assert.match(code, /isAllowedAdmin\(check\.email, allowlist\)/);
});

test("15: the data endpoint is session-gated, POST-only and read-only", () => {
  const code = stripJs(waitlistRoute);

  // The session check is the very first thing that happens.
  assert.match(code, /const session = verifyAdminRequest\(request\);\s*if \(!session\) return unauthorized\(\);/);

  // POST only - no GET handler exists.
  const handlers = [...waitlistRoute.matchAll(/export async function ([A-Z]+)\(/g)].map((m) => m[1]);
  assert.deepEqual(handlers, ["POST"]);

  // NOT ONE WRITE. Releasing and sending stay behind their own secret in
  // /api/admin/launch/*, so this screen cannot become a second way to
  // mail the list.
  for (const write of [".update(", ".insert(", ".upsert(", ".delete(", ".rpc(", "emails.send", "runLaunchSend"]) {
    assert.ok(!code.includes(write), `the overview endpoint performs a write: ${write}`);
  }

  // No caching: this is per-person data behind a session.
  assert.match(code, /"Cache-Control": "no-store"/);
});

test("16: the endpoint selects named columns and never a token or consent text", () => {
  // A screen that does not need a value should not be able to leak one.
  assert.ok(!WAITLIST_COLUMNS.includes("*"));
  for (const secret of ["token_hash", "consent_text", "claim_id"]) {
    assert.ok(!WAITLIST_COLUMNS.includes(secret), `the overview selects ${secret}`);
  }
  for (const needed of ["email", "first_name", "audience_type", "source", "status",
                        "consent_version", "created_at"]) {
    assert.ok(WAITLIST_COLUMNS.includes(needed), `the overview is missing ${needed}`);
  }
});

/* ── 6. Query hardening ──────────────────────────────────────── */

test("17: filters are a closed set and anything else falls back to all", () => {
  assert.deepEqual([...WAITLIST_FILTERS], ["all", "pending", "confirmed", "withdrawn", "notified"]);
  for (const f of WAITLIST_FILTERS) assert.equal(resolveWaitlistFilter(f), f);
  for (const bad of ["", "deleted", "PENDING", "'; drop table", null, 1, {}, []]) {
    assert.equal(resolveWaitlistFilter(bad), "all", `accepted: ${JSON.stringify(bad)}`);
  }
});

test("18: the search term cannot change the shape of the query", () => {
  // PostgREST gives meaning to commas and parentheses inside a filter
  // value, and % and _ are the LIKE wildcards. A search is a search, not
  // a pattern the caller composes.
  for (const [raw, expected] of [
    ["anna", "anna"],
    ["  anna  ", "anna"],
    ["an,na", "anna"],
    ["an(na)", "anna"],
    ["%anna%", "anna"],
    ["an_na", "anna"],
    ["an*na", "anna"],
    ['an"na', "anna"],
    ["an'na", "anna"],
    ["an\\na", "anna"],
    ["email.ilike.%,status.eq.confirmed", "email.ilike.status.eq.confirmed"],
    [null, ""],
    [42, ""],
  ]) {
    assert.equal(normalizeSearch(raw), expected, `normalised ${JSON.stringify(raw)} wrongly`);
  }
  // And it is length-capped, so a huge term cannot be used to hammer the
  // database.
  assert.equal(normalizeSearch("a".repeat(500)).length, 120);
});

test("19: pagination is bounded, so a page size cannot become a full export", () => {
  assert.equal(resolvePageSize(undefined), DEFAULT_PAGE_SIZE);
  assert.equal(resolvePageSize(0), DEFAULT_PAGE_SIZE);
  assert.equal(resolvePageSize(-5), DEFAULT_PAGE_SIZE);
  assert.equal(resolvePageSize("abc"), DEFAULT_PAGE_SIZE);
  assert.equal(resolvePageSize(10), 10);
  assert.equal(resolvePageSize(100000), MAX_PAGE_SIZE);
  assert.equal(resolvePageSize(Infinity), DEFAULT_PAGE_SIZE);
  assert.ok(MAX_PAGE_SIZE <= 100);

  assert.equal(resolvePage(undefined), 1);
  assert.equal(resolvePage(0), 1);
  assert.equal(resolvePage(-3), 1);
  assert.equal(resolvePage(7), 7);
  assert.equal(resolvePage(9e9), 10_000);

  assert.deepEqual(pageRange({ page: 1, pageSize: 25 }), { from: 0, to: 24 });
  assert.deepEqual(pageRange({ page: 3, pageSize: 25 }), { from: 50, to: 74 });
});

test("20: a hostile body resolves to a safe query", () => {
  const q = resolveWaitlistQuery({
    filter: "'; delete from launch_waitlist; --",
    search: "%,email.ilike.%",
    page: -1,
    pageSize: 99999,
  });
  assert.deepEqual(q, {
    filter: "all",
    search: "email.ilike.",
    page: 1,
    pageSize: MAX_PAGE_SIZE,
  });
  assert.deepEqual(resolveWaitlistQuery(null).filter, "all");
  assert.deepEqual(resolveWaitlistQuery("nonsense").pageSize, DEFAULT_PAGE_SIZE);
});

/* ── 7. The page itself ──────────────────────────────────────── */

test("21: the page is noindex and carries no shop chrome", () => {
  // An obscure path is not access control - the session is - but there
  // is no reason to help a crawler, and this page lists people.
  assert.match(pageFile, /robots: \{ index: false, follow: false, nocache: true \}/);

  // Its own route, so GloaSite's header, cart and footer never render.
  // Comments are not code: the page explains that it does NOT use
  // GloaSite, which is why the check runs on the stripped source.
  assert.ok(!stripJs(pageFile).includes("GloaSite"), "the admin page renders the public site shell");
  assert.ok(!stripJs(overview).includes("Chrome"), "the overview imports the shop chrome");
  for (const shop of ["Warenkorb", "/shop", "cartCount", "from \"./Chrome\"", "<Footer", "<Header"]) {
    assert.ok(!stripJs(overview).includes(shop), `the overview carries shop chrome: ${shop}`);
  }

  // And it is not linked from the public navigation.
  const chrome = read("app/Chrome.tsx");
  assert.ok(!chrome.includes("adminxyzuebersicht"), "the admin page is in the public navigation");
});

test("22: release and send are absent from this screen", () => {
  // The first version is read-only on purpose: no button here may be one
  // click away from mailing the whole list.
  const client = stripJs(overview);
  for (const action of ["/api/admin/launch/release", "/api/admin/launch/send",
                        "RELEASE GLOA LAUNCH", "SEND GLOA LAUNCH"]) {
    assert.ok(!client.includes(action), `the overview can trigger: ${action}`);
  }
  // And it says so to the operator rather than leaving them looking.
  assert.match(overview, /Freigabe und Versand sind in dieser Ansicht bewusst nicht möglich/);
});

test("23: exactly the two admin API routes were added, both POST-gated", () => {
  const dirs = readdirSync(path.join(ROOT, "app/api/admin"), { withFileTypes: true })
    .filter((e) => e.isDirectory()).map((e) => e.name).sort();
  assert.deepEqual(dirs, ["launch", "session", "waitlist"]);

  // The session route is the only one that may write anything, and what
  // it writes is a cookie.
  const sessionHandlers = [...sessionRoute.matchAll(/export async function ([A-Z]+)\(/g)].map((m) => m[1]);
  assert.deepEqual(sessionHandlers.sort(), ["DELETE", "POST"]);
  assert.ok(!sessionRoute.includes("launch_waitlist"), "the session route touches the waitlist");
});
