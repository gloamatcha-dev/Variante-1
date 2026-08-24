import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AUTH_CONFIRM_PATH,
  PASSWORD_RESET_PATH,
  authRedirectUrl,
  browserAuthRedirectUrl,
} from "../lib/authRedirect.ts";

// SAFE DEFAULT SUITE: pure logic and source-level checks. No network, no
// Supabase client, no auth call.
//
// The defect these protect against is silent. Supabase does not reject a
// missing or non-allow-listed redirectTo, it falls back to the project's
// Site URL - so the only symptom is a customer landing on the homepage
// with a bare "#" and no way to finish resetting their password.

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf-8");
const NEWLINE = String.fromCharCode(10);

const site = read("app/GloaSite.tsx");
const portal = read("app/AccountPortal.tsx");
const helper = read("lib/authRedirect.ts");

const withoutComments = source => source
  .split(NEWLINE)
  .filter(line => {
    const t = line.trim();
    return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
  })
  .join(NEWLINE);

const helperCode = withoutComments(helper);

const PRODUCTION_ORIGIN = "https://gloamatcha.com";

/* ── The paths themselves ───────────────────────────────────── */

test("paths: the two auth landing pages are the ones the app actually routes", () => {
  assert.equal(PASSWORD_RESET_PATH, "/account/reset-password");
  assert.equal(AUTH_CONFIRM_PATH, "/auth/confirm");
  // Both must be real routes, or the customer lands on a page that does
  // not exist and the token is lost either way.
  assert.match(site, /route==="account\/reset-password"\)page=<ResetPassword\/>/);
  assert.match(site, /route==="auth\/confirm"\)page=<AuthConfirm\/>/);
});

test("paths: the production redirect targets are exactly the allow-listed URLs", () => {
  assert.equal(authRedirectUrl(PRODUCTION_ORIGIN, PASSWORD_RESET_PATH), "https://gloamatcha.com/account/reset-password");
  assert.equal(authRedirectUrl(PRODUCTION_ORIGIN, AUTH_CONFIRM_PATH), "https://gloamatcha.com/auth/confirm");
  // A trailing slash on the origin must not produce a double slash, which
  // would not match the allow list.
  assert.equal(authRedirectUrl("https://gloamatcha.com/", PASSWORD_RESET_PATH), "https://gloamatcha.com/account/reset-password");
  assert.equal(authRedirectUrl("https://gloamatcha.com///", PASSWORD_RESET_PATH), "https://gloamatcha.com/account/reset-password");
});

test("paths: no old or wrong host is baked in as a redirect target", () => {
  // The cutover moved production to gloamatcha.com. Nothing may pin a
  // redirect to the old deployment host, a www variant, or localhost.
  for (const source of [helper, site, portal]) {
    for (const wrong of ["variante-1-cyan.vercel.app", "www.gloamatcha.com", "localhost:", "127.0.0.1"]) {
      assert.ok(!source.includes(wrong), `a redirect target mentions ${wrong}`);
    }
  }
  // The helper derives the origin rather than hardcoding one, so there is
  // no second source of truth to drift from Supabase's allow list.
  assert.match(helperCode, /window\.location\.origin/);
  // Comment-stripped: the file is allowed to NAME the production domain
  // when explaining what it returns there, just not to hardcode it.
  assert.ok(!/https:\/\/gloamatcha\.com/.test(helperCode), "the helper hardcodes a production domain");
});

test("helper: off the browser it returns undefined, never an empty string", () => {
  // "" and undefined are the same thing to Supabase - both mean no
  // redirect and both fall back to the Site URL - but "" reads like a
  // value and would hide the problem at the call site.
  assert.equal(typeof window, "undefined");
  assert.equal(browserAuthRedirectUrl(PASSWORD_RESET_PATH), undefined);
  assert.ok(!/return ""/.test(helper), "the helper returns an empty redirect");
});

/* ── The two request paths ──────────────────────────────────── */

test("request: the public forgot form sends the reset page as redirectTo", () => {
  assert.match(site, /resetPasswordForEmail\(String\(f\.get\("email"\)\),\{redirectTo:resetUrl\}\)/);
  assert.match(site, /const resetUrl=browserAuthRedirectUrl\(PASSWORD_RESET_PATH\)/);
});

test("request: the account page sends it too - this was the actual defect", () => {
  // It previously called resetPasswordForEmail(user.email) with no second
  // argument at all, so Supabase fell back to the Site URL and the
  // customer landed on https://gloamatcha.com/# with the homepage.
  const handler = portal.slice(
    portal.indexOf("const handlePasswordReset"),
    portal.indexOf("const handlePasswordReset") + 1200
  );
  assert.match(handler, /resetPasswordForEmail\(user\.email, \{\s*redirectTo: browserAuthRedirectUrl\(PASSWORD_RESET_PATH\),\s*\}\)/);
});

test("request: EVERY resetPasswordForEmail call in the app passes a redirect", () => {
  // The guard that matters most: a fourth call site must not be able to
  // reintroduce the same silent failure.
  const combined = withoutComments(site) + NEWLINE + withoutComments(portal);
  const calls = [...combined.matchAll(/resetPasswordForEmail\(/g)];
  assert.equal(calls.length, 2, "the number of reset entry points changed");

  for (const call of calls) {
    // Everything up to the end of that call's argument list.
    const window = combined.slice(call.index, call.index + 260);
    assert.ok(/redirectTo/.test(window), `a resetPasswordForEmail call has no redirectTo: ${window.slice(0, 100)}`);
  }

  // And both go through the shared helper rather than building a URL by
  // hand, so the path cannot drift from the allow list in one place only.
  const helperUses = combined.match(/browserAuthRedirectUrl\(PASSWORD_RESET_PATH\)/g) ?? [];
  assert.equal(helperUses.length, 2, "a reset entry point builds its redirect by hand");
});

/* ── Signup confirmation must not regress ───────────────────── */

test("signup: both registration flows still confirm to /auth/confirm", () => {
  // Private and business signup both pass emailRedirectTo, and both use
  // the same helper.
  const signupCalls = [...site.matchAll(/emailRedirectTo:(\w+)/g)].map(m => m[1]);
  assert.deepEqual(signupCalls, ["confirmUrl", "confirmUrl"], "a signup flow lost its confirmation redirect");
  assert.match(site, /const confirmUrl=browserAuthRedirectUrl\(AUTH_CONFIRM_PATH\)/);
  // The confirmation page itself is untouched and still lands people on
  // the dashboard after a successful verification.
  assert.match(site, /function AuthConfirm\(\)/);
  assert.match(site, /setStatus\("success"\);\s*setTimeout\(\(\)=>\{window\.location\.href="\/account\/dashboard"\},1500\)/);
});

/* ── The recovery landing page ──────────────────────────────── */

test("recovery: the reset page waits for the session before judging the link", () => {
  const page = site.slice(site.indexOf("function ResetPassword()"), site.indexOf("function ResetPassword()") + 3000);
  // The recovery session arrives asynchronously. Rendering "Link
  // ungültig" while AuthProvider is still hydrating would tell somebody
  // holding a valid link that it is broken.
  assert.match(page, /const\{user,loading:authLoading\}=useAuth\(\);/);
  assert.match(page, /if\(authLoading\)return/);
  assert.ok(
    page.indexOf("if(authLoading)return") < page.indexOf("if(!user)return"),
    "the loading branch must come before the invalid-link branch"
  );
});

test("recovery: a recovery session is never redirected away from the reset page", () => {
  const page = site.slice(site.indexOf("function ResetPassword()"), site.indexOf("function ResetPassword()") + 3000);
  // The only navigation is AFTER the password has actually been changed.
  const navigations = [...page.matchAll(/window\.location\.href="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(navigations, ["/account/dashboard"], "the reset page navigates unexpectedly");
  assert.ok(
    page.indexOf("setDone(true)") < page.indexOf('window.location.href="/account/dashboard"'),
    "the reset page must only navigate after a successful update"
  );
  // The "logged in, go to the dashboard" effect belongs to /account and
  // must not apply here - a recovery session IS a session, and that
  // effect would bounce the customer off this page immediately.
  const account = site.slice(site.indexOf("function Account()"), site.indexOf("function Account()") + 1500);
  assert.match(account, /useEffect\(\(\)=>\{if\(!authLoading&&user\)window\.location\.href="\/account\/dashboard"\}/);
  assert.ok(!/if\(!authLoading&&user\)window\.location\.href/.test(page), "the reset page redirects a recovery session away");
});

test("recovery: PASSWORD_RECOVERY is observed and the form is what a valid link shows", () => {
  const page = site.slice(site.indexOf("function ResetPassword()"), site.indexOf("function ResetPassword()") + 3000);
  assert.match(page, /onAuthStateChange\(\(event\)=>\{\s*if\(event==="PASSWORD_RECOVERY"\)/);
  // A valid recovery session reaches the form, not an error.
  assert.match(page, /name="password"/);
  assert.match(page, /name="password_confirm"/);
  assert.match(page, /supabase\.auth\.updateUser\(\{password:pw\}\)/);
  assert.match(page, /setDone\(true\)/);
  // The subscription is cleaned up, so a re-render cannot stack listeners.
  assert.match(page, /return\(\)=>subscription\.unsubscribe\(\)/);
});

test("recovery: the new password is validated before it is sent", () => {
  const page = site.slice(site.indexOf("function ResetPassword()"), site.indexOf("function ResetPassword()") + 3000);
  assert.match(page, /if\(pw\.length<8\)/);
  assert.match(page, /if\(pw!==pw2\)/);
  // Validation precedes the update call.
  assert.ok(page.indexOf("if(pw.length<8)") < page.indexOf("updateUser"));
});

/* ── Scope ──────────────────────────────────────────────────── */

test("scope: nothing outside the auth redirect was touched", () => {
  // No Stripe, subscription, order, shipping, tax or migration concern
  // appears in the helper this fix introduced.
  // Comment-stripped, because the prose legitimately explains Supabase's
  // fallback behaviour - that is the whole reason this file exists.
  for (const forbidden of ["stripe", "Stripe", "subscription", "order_", "shipping", "tax", "createClient", "supabase."]) {
    assert.ok(!helperCode.includes(forbidden), `the auth redirect helper mentions ${forbidden}`);
  }
  // And it is a genuine leaf: no imports at all.
  const imports = helper.split(NEWLINE).filter(l => l.trim().startsWith("import "));
  assert.deepEqual(imports, [], "the helper must stay import-free and directly testable");
});
