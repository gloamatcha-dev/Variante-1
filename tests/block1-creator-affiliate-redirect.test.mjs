import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Block 1 — 072 creator/affiliate lib wrappers and /r/[slug] route.
 *
 * Source-level structural tests. No database, no network, no email.
 */

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf-8");
const NEWLINE = String.fromCharCode(10);

const withoutComments = (source) =>
  source
    .split(NEWLINE)
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith("--") && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join(NEWLINE);

const affiliateSrc = read("lib/creatorAffiliate.ts");
const affiliateCode = withoutComments(affiliateSrc);
const redirectRouteSrc = read("app/r/[slug]/route.ts");
const redirectCode = withoutComments(redirectRouteSrc);
const affiliateApiSrc = read("app/api/affiliate/route.ts");
const affiliateApiCode = withoutComments(affiliateApiSrc);

/* ── Creator/affiliate lib ─────────────────────────────────────── */

test("affiliate: all seven RPC wrappers call the correct function", () => {
  const expected = [
    ["resolveAffiliateLink", "resolve_affiliate_link"],
    ["resolveAffiliateCode", "resolve_affiliate_code"],
    ["recordAffiliateClick", "record_affiliate_click"],
    ["attributeOrderToCreator", "attribute_order_to_creator"],
    ["reverseCreatorCommissionForRefund", "reverse_creator_commission_for_refund"],
    ["getCreatorCommissionBalance", "creator_commission_balance"],
  ];
  for (const [fn, rpc] of expected) {
    assert.match(affiliateCode, new RegExp(`admin\\.rpc\\("${rpc}"`),
      `${fn} must call admin.rpc("${rpc}")`);
  }
});

test("affiliate: attributeOrderToCreator never accepts a creator_id from the caller", () => {
  const fnStart = affiliateCode.indexOf("async function attributeOrderToCreator");
  const fnEnd = affiliateCode.indexOf("}", affiliateCode.indexOf("return", fnStart)) + 1;
  const fnBody = affiliateCode.slice(fnStart, fnEnd);
  assert.ok(!fnBody.includes("p_creator_id"),
    "attribution must not accept a creator id — the server resolves it");
});

test("affiliate: attributeOrderToCreator never accepts a commission amount", () => {
  const fnStart = affiliateCode.indexOf("async function attributeOrderToCreator");
  const fnEnd = affiliateCode.indexOf("}", affiliateCode.indexOf("return", fnStart)) + 1;
  const fnBody = affiliateCode.slice(fnStart, fnEnd);
  assert.ok(!fnBody.includes("commission_cents") && !fnBody.includes("commissionCents"),
    "attribution must not accept a commission amount — the database computes it");
});

test("affiliate: all wrappers return null on error, never throw", () => {
  assert.ok(!affiliateCode.includes("throw "),
    "affiliate wrappers must never throw");
});

test("affiliate: module uses getSupabaseAdmin only", () => {
  assert.match(affiliateCode, /getSupabaseAdmin\(\)/,
    "must use getSupabaseAdmin()");
  assert.ok(!affiliateCode.includes("createClient"),
    "must not create its own client");
});

/* ── /r/[slug] public redirect route ───────────────────────────── */

test("redirect: /r/[slug] route file exists", () => {
  assert.ok(existsSync(path.join(ROOT, "app/r/[slug]/route.ts")),
    "the /r/[slug] route file must exist");
});

test("redirect: the route is a GET handler, not POST", () => {
  assert.match(redirectCode, /export async function GET/,
    "the redirect must be a GET handler");
  assert.ok(!redirectCode.includes("export async function POST"),
    "the redirect must not have a POST handler");
});

test("redirect: the route redirects to the shop, not to an external URL", () => {
  assert.match(redirectCode, /NextResponse\.redirect/,
    "the route must issue a redirect");
  assert.ok(!redirectCode.includes("http://") && !redirectCode.includes("https://"),
    "the route must use a relative origin, never a hardcoded external URL");
});

test("redirect: an inactive link redirects without attribution", () => {
  // When resolved.result !== "active", the route must still redirect
  // (no error page, no 404) but WITHOUT any ref= parameter.
  assert.match(redirectCode, /resolved\.result !== "active"/,
    "the route must check for active status");
  // The fallback redirect has no ref param.
  const inactiveBlock = redirectCode.slice(
    redirectCode.indexOf('resolved.result !== "active"'),
    redirectCode.indexOf("resolved.affiliate_link_id")
  );
  assert.ok(!inactiveBlock.includes("ref"),
    "inactive links must not set a ref parameter");
});

test("redirect: an active link sets ref= and records a click", () => {
  assert.match(redirectCode, /searchParams\.set\("ref"/,
    "the route must set a ref= query parameter for active links");
  assert.match(redirectCode, /recordAffiliateClick/,
    "the route must record a click for active links");
});

test("redirect: the route never exposes creator_id or commission data", () => {
  assert.ok(!redirectCode.includes("creator_id"),
    "the route must never expose the creator_id");
  assert.ok(!redirectCode.includes("commission"),
    "the route must never expose commission data");
});

test("redirect: an empty slug redirects to shop without attribution", () => {
  // The route checks for an empty slug and redirects immediately.
  assert.match(redirectCode, /!trimmed/,
    "the route must handle empty slugs");
});

/* ── /api/affiliate public API route ───────────────────────────── */

test("affiliate API: the route is unauthenticated (no requireAdminIdentity)", () => {
  assert.ok(!affiliateApiCode.includes("requireAdminIdentity"),
    "the affiliate API must be public, not admin-gated");
});

test("affiliate API: resolve_link never returns creator_id or commission data", () => {
  const linkBlock = affiliateApiCode.slice(
    affiliateApiCode.indexOf('"resolve_link"'),
    affiliateApiCode.indexOf('"resolve_code"')
  );
  assert.ok(!linkBlock.includes("creator_id"),
    "resolve_link must not return creator_id");
  assert.ok(!linkBlock.includes("commission"),
    "resolve_link must not return commission data");
});

/* ── Migration 072: all affiliate functions exist ──────────────── */

test("migration 072 declares all creator/affiliate functions", () => {
  const migration = read("supabase/migrations/072_admin_core_connections.sql");
  const functions = [
    "resolve_affiliate_link",
    "resolve_affiliate_code",
    "record_affiliate_click",
    "order_commission_base_cents",
    "attribute_order_to_creator",
    "reverse_creator_commission_for_refund",
    "creator_commission_balance",
  ];
  for (const fn of functions) {
    assert.match(migration, new RegExp(`create or replace function public\\.${fn}`),
      `migration 072 must declare ${fn}`);
  }
});
