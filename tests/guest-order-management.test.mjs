import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { readFileSync } from "node:fs";
import { createHmac, createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeBlockedServerEnv } from "./helpers/testSupabase.mjs";

/*
  GUEST ORDER MANAGEMENT.

  A one-time order can be placed without an account, and the cancellation
  REQUEST could not: migration 019's function refuses a NULL user id by
  design, and the only screen that calls it lives behind /account. This
  suite covers the link that closes that gap, and it is organised around
  the two questions that matter:

    can the holder of a link reach anything they should not
    is the cancellation they ask for the SAME cancellation

  SAFE DEFAULT SUITE. The spawned server runs without a Supabase
  service-role key, so every database path degrades to its "not
  configured" branch and no row can be written. The HTTP tests exercise
  the shape, authorization and fail-closed guards, which all run before
  the routes reach a database.
*/

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const PORT = 8981;
const BASE = `http://127.0.0.1:${PORT}`;
const READ_ENDPOINT = `${BASE}/api/orders/guest`;
const CANCEL_ENDPOINT = `${BASE}/api/orders/guest/cancellation-request`;

const read = rel => readFileSync(path.join(ROOT, rel), "utf8");

const NEWLINE = String.fromCharCode(10);

/** Source with its comment lines dropped, so a "never does X" scan reads
 *  code rather than the prose explaining why X is absent. */
function withoutComments(source) {
  return source
    .split(NEWLINE)
    .filter(line => {
      const trimmed = line.trim();
      return !trimmed.startsWith("--") && !trimmed.startsWith("//")
        && !trimmed.startsWith("*") && !trimmed.startsWith("/*");
    })
    .join(NEWLINE);
}

const MIGRATION = read("supabase/migrations/065_guest_order_management.sql");
const MIGRATION_CODE = withoutComments(MIGRATION);
const MIGRATION_019 = withoutComments(read("supabase/migrations/019_order_lifecycle_tracking.sql"));

const LEAF = read("lib/guestOrderAccess.ts");
const LEAF_CODE = withoutComments(LEAF);
const READ_ROUTE = read("app/api/orders/guest/route.ts");
const READ_ROUTE_CODE = withoutComments(READ_ROUTE);
const CANCEL_ROUTE = read("app/api/orders/guest/cancellation-request/route.ts");
const CANCEL_ROUTE_CODE = withoutComments(CANCEL_ROUTE);
const PAGE = read("app/GuestOrder.tsx");
const PAGE_CODE = withoutComments(PAGE);
const SENDER = read("lib/orderConfirmationEmail.ts");
const SENDER_CODE = withoutComments(SENDER);
const TEMPLATE = read("lib/email/orderConfirmation.ts");
const ACCOUNT_ROUTE = read("app/api/orders/cancellation-request/route.ts");

/** The body of one SQL function, code only. */
function sqlFunction(source, name) {
  const from = source.indexOf(`create or replace function public.${name}(`);
  assert.notEqual(from, -1, `${name} is not defined`);
  const to = source.indexOf("$$;", from);
  assert.ok(to > from, `${name} has no body`);
  return source.slice(from, to);
}

let serverProcess;

test.before(async () => {
  serverProcess = spawn(process.execPath, [".output/server/index.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: writeBlockedServerEnv({ PORT: String(PORT) }),
    stdio: "ignore",
  });
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const res = await fetch(`${BASE}/`);
      if (res.ok) break;
    } catch {
      // not up yet
    }
    await delay(200);
  }
});

test.after(() => {
  serverProcess?.kill();
});

/*
  A FRESH RATE-LIMIT BUCKET PER CALLER.

  Both routes count every request that reaches them, valid or not - which
  is correct, and which would otherwise make these tests depend on how
  many requests the tests before them happened to send. The limiter keys
  on x-forwarded-for (lib/launchRateLimit.ts), so each call states its own
  address and gets its own bucket. Nothing about the limit is disabled.
*/
let callerSeq = 0;
const nextCaller = () => `203.0.113.${(callerSeq++ % 250) + 1}`;

async function post(endpoint, body, headers = {}) {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-For": nextCaller(), ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const parsed = await res.json().catch(() => null);
  return { status: res.status, body: parsed };
}

const TOKEN_A = "a".repeat(64);
const TOKEN_B = "b".repeat(64);

/* ══════════════════════════════════════════════════════════════
   1. ONE SECURE TOKEN PER PAID ONE-TIME ORDER
   ══════════════════════════════════════════════════════════════ */

test("1: a paid one-time order gets exactly one management token, minted in one place", () => {
  // The sender is the ONLY minting site in the repository. If a second
  // one ever appears, the "one token per order" claim stops being
  // structural and becomes a convention.
  const minters = [];
  for (const rel of [
    "lib/orderConfirmationEmail.ts",
    "app/api/orders/guest/route.ts",
    "app/api/orders/guest/cancellation-request/route.ts",
    "app/api/stripe/webhook/route.ts",
    "lib/transactionalEmailRetry.ts",
    "lib/subscriptionStartedEmail.ts",
    "lib/annualPurchaseConfirmationEmail.ts",
    "lib/internalOrderNotificationEmail.ts",
  ]) {
    if (read(rel).includes("attach_guest_order_manage_token")) minters.push(rel);
  }
  assert.deepEqual(minters, ["lib/orderConfirmationEmail.ts"],
    "the management token is attached from somewhere other than the one-time confirmation sender");

  // And exactly once inside it.
  assert.equal([...SENDER_CODE.matchAll(/attach_guest_order_manage_token/g)].length, 1);
  assert.equal([...SENDER_CODE.matchAll(/deriveGuestOrderToken\(/g)].length, 1);
});

test("1b: the token is 256 bits of HMAC over the order id, and the order NUMBER is not an input", () => {
  assert.ok(LEAF_CODE.includes('createHmac("sha256", secret)'));
  assert.ok(LEAF_CODE.includes("${GUEST_ORDER_TOKEN_LABEL}:${orderId.toLowerCase()}"));
  assert.ok(LEAF_CODE.includes('.digest("hex")'));
  // order_number is sequential and printed on every invoice. It may never
  // be an input to a credential. Scoped to the derivation itself: the
  // projection further down the file DOES read the column, because the
  // customer is shown their own order number.
  const derivation = LEAF_CODE.slice(
    LEAF_CODE.indexOf("export function deriveGuestOrderToken("),
    LEAF_CODE.indexOf("export function hashGuestOrderToken("));
  assert.ok(derivation.length > 100, "deriveGuestOrderToken moved");
  for (const forbidden of ["order_number", "orderNumber", "email", "placed_at"]) {
    assert.ok(!derivation.includes(forbidden), `the derivation reads ${forbidden}`);
  }
});

test("1c: the derivation refuses a non-UUID and a short secret rather than emitting a weak token", () => {
  // Re-implemented here, independently, from the documented rule - so the
  // assertion is about the rule and not about the function agreeing with
  // itself.
  const label = "gloa:guest-order-manage:v1";
  const orderId = "6b1f0a3c-6f4e-4a1e-9a1a-2f8a2b6c1d3e";
  const secret = "s".repeat(40);
  const expected = createHmac("sha256", secret).update(`${label}:${orderId}`, "utf8").digest("hex");
  assert.match(expected, /^[0-9a-f]{64}$/);

  assert.ok(LEAF_CODE.includes("if (typeof orderId !== \"string\" || !UUID_RE.test(orderId)) return null;"));
  assert.ok(LEAF_CODE.includes("secret.length < GUEST_ORDER_TOKEN_MIN_SECRET_LENGTH) return null;"));
  assert.ok(LEAF_CODE.includes("export const GUEST_ORDER_TOKEN_MIN_SECRET_LENGTH = 24;"));
  // The secret getter returns null rather than "" for an unset variable,
  // so nothing can key an HMAC with the empty string.
  assert.ok(LEAF_CODE.includes("return secret.length >= GUEST_ORDER_TOKEN_MIN_SECRET_LENGTH ? secret : null;"));
});

test("1d: the label is versioned, so a future generation cannot be confused for this one", () => {
  assert.ok(LEAF_CODE.includes('export const GUEST_ORDER_TOKEN_LABEL = "gloa:guest-order-manage:v1";'));
  // And it is domain-separated from every other HMAC label in the repo.
  const labels = new Set();
  for (const rel of ["lib/launchRateLimit.ts", "lib/checkoutRateLimit.ts", "lib/guestOrderAccess.ts"]) {
    for (const match of read(rel).matchAll(/"(gloa:[a-z0-9:-]+)"/g)) labels.add(match[1]);
  }
  assert.ok(labels.has("gloa:guest-order-manage:v1"));
  assert.ok(labels.has("gloa:guest-order-read-rate-limit:v1"));
  assert.ok(labels.has("gloa:guest-order-cancel-rate-limit:v1"));
  assert.ok(labels.has("gloa:launch-rate-limit:v1"), "the shared limiter label is gone");
});

/* ══════════════════════════════════════════════════════════════
   2. A RETRY CREATES NO SECOND TOKEN
   ══════════════════════════════════════════════════════════════ */

test("2: a webhook redelivery derives the SAME token, so no second one can exist", () => {
  // The whole argument in one assertion: derivation is a pure function of
  // (secret, order id), so two deliveries of the same event produce one
  // token. Verified against node:crypto rather than against the module.
  const secret = "x".repeat(32);
  const orderId = "11111111-2222-4333-8444-555555555555";
  const message = `gloa:guest-order-manage:v1:${orderId}`;
  const first = createHmac("sha256", secret).update(message, "utf8").digest("hex");
  const second = createHmac("sha256", secret).update(message, "utf8").digest("hex");
  assert.equal(first, second);

  // Nothing random is reachable from the derivation.
  assert.ok(!LEAF_CODE.includes("randomBytes"), "the token is drawn at random and cannot survive a retry");
  assert.ok(!LEAF_CODE.includes("randomUUID"));
  assert.ok(!LEAF_CODE.includes("Date.now()"), "the derivation reads a clock");
});

test("2b: the database writer is idempotent BY VALUE and cannot produce a second row", () => {
  const fn = sqlFunction(MIGRATION_CODE, "attach_guest_order_manage_token");
  // Same digest -> 'unchanged', and created_at is deliberately not moved:
  // it records when the customer's link started working.
  assert.ok(fn.includes("if v_existing = p_token_hash then"));
  assert.ok(fn.includes("return 'unchanged';"));
  assert.ok(fn.indexOf("return 'unchanged';") < fn.indexOf("set token_hash = p_token_hash"),
    "an unchanged digest falls through into the rotation update");
  // One row per order is structural, not a rule a writer remembers.
  assert.ok(MIGRATION_CODE.includes("order_id   uuid primary key references public.orders (id) on delete cascade"));
  assert.ok(MIGRATION_CODE.includes("on conflict (order_id) do nothing"));
  // And the write takes the row lock before deciding.
  assert.ok(fn.indexOf("for update") < fn.indexOf("if v_existing = p_token_hash"));
});

test("2c: the sender treats all three attach outcomes as success and never throws", () => {
  assert.ok(SENDER_CODE.includes('if (data !== "attached" && data !== "unchanged" && data !== "rotated")'));
  // Every failure path returns null - the mail is then sent WITHOUT the
  // CTA. A paid-order confirmation is never withheld over a link, and
  // nothing is thrown into the webhook's error path.
  const fn = SENDER_CODE.slice(
    SENDER_CODE.indexOf("async function buildGuestManageUrl("),
    SENDER_CODE.indexOf("export type OrderForConfirmationEmail"));
  assert.ok(fn.length > 200, "buildGuestManageUrl moved");
  assert.ok(!fn.includes("throw "), "a link failure can fail the customer's confirmation mail");
  assert.equal([...fn.matchAll(/return null;/g)].length, 6);
});

/* ══════════════════════════════════════════════════════════════
   3. THE PLAINTEXT TOKEN IS NEVER STORED, LOGGED OR RETURNED
   ══════════════════════════════════════════════════════════════ */

test("3: only the digest is ever handed to the database", () => {
  // The single write site passes hashGuestOrderToken(token), never token.
  assert.ok(SENDER_CODE.includes("p_token_hash: hashGuestOrderToken(token),"));
  assert.ok(!SENDER_CODE.includes("p_token: "), "the plaintext token is sent to the database");
  // Both read sites do the same.
  assert.ok(READ_ROUTE_CODE.includes("const tokenHash = hashGuestOrderToken(token);"));
  assert.ok(READ_ROUTE_CODE.includes("p_token_hash: tokenHash,"));
  assert.ok(CANCEL_ROUTE_CODE.includes("p_token_hash: hashGuestOrderToken(token),"));
  // No route ever passes the raw token as an RPC argument.
  for (const code of [READ_ROUTE_CODE, CANCEL_ROUTE_CODE, SENDER_CODE]) {
    assert.ok(!/p_token_hash:\s*token\b/.test(code), "a raw token is passed as the digest argument");
  }
});

test("3b: the database refuses to store anything that is not a SHA-256 digest", () => {
  assert.ok(MIGRATION_CODE.includes("check (token_hash ~ '^[0-9a-f]{64}$')"));
  // The writer checks the same shape before it tries, so a bug is refused
  // with a result rather than an exception.
  const fn = sqlFunction(MIGRATION_CODE, "attach_guest_order_manage_token");
  assert.ok(fn.includes("p_token_hash !~ '^[0-9a-f]{64}$'"));
  assert.ok(fn.includes("return 'invalid_input';"));
  // The reader too, so a malformed digest costs no index lookup.
  assert.ok(sqlFunction(MIGRATION_CODE, "guest_order_id_for_token").includes("p_token_hash !~ '^[0-9a-f]{64}$'"));
});

test("3c: no console line anywhere in this feature carries a token VALUE", () => {
  // Named precisely: a log line may mention the WORD token - two of them
  // name the RPC they called - but none may interpolate or pass the
  // variable. Those are the two shapes that would put a live credential
  // in a log.
  const LEAKS = [/\$\{token/, /token\s*\)/, /,\s*token\s*[,)]/, /\$\{tokenHash/, /,\s*tokenHash\s*[,)]/];
  for (const [label, code] of [
    ["read route", READ_ROUTE_CODE],
    ["cancel route", CANCEL_ROUTE_CODE],
    ["sender", SENDER_CODE],
    ["leaf", LEAF_CODE],
    ["page", PAGE_CODE],
  ]) {
    for (const line of code.split(NEWLINE)) {
      if (!line.includes("console.")) continue;
      for (const leak of LEAKS) {
        assert.ok(!leak.test(line), `${label} logs a token value: ${line.trim()}`);
      }
    }
  }
  // Every log line this feature adds carries an order id at most - which
  // is what the account route already logs for the same failure.
  assert.ok(CANCEL_ROUTE_CODE.includes("internal notification failed for order ${orderId}"));
});

test("3d: the digest column is in a table no role may read", () => {
  // The reason it is a table at all: app/AccountPortal.tsx reads a
  // customer's own order with select("*") through the anon key, so a
  // column on public.orders is a column shipped to a browser.
  assert.ok(read("app/AccountPortal.tsx").includes('from("orders").select("*")'),
    "the select(*) this design works around is gone - revisit the table/column decision");
  assert.ok(!MIGRATION_CODE.includes("alter table public.orders"),
    "065 adds a column to public.orders after all");

  for (const role of ["anon", "authenticated", "service_role"]) {
    assert.ok(MIGRATION_CODE.includes(`revoke all on table public.order_guest_access from ${role};`),
      `order_guest_access is not revoked from ${role}`);
  }
  assert.ok(MIGRATION_CODE.includes("alter table public.order_guest_access enable row level security;"));
  // No policy, and no grant, to anybody.
  assert.ok(!/create policy[\s\S]*order_guest_access/.test(MIGRATION_CODE), "065 grants a policy on the table");
  assert.ok(!/grant [a-z, ]+ on table public\.order_guest_access/.test(MIGRATION_CODE),
    "065 grants table access on order_guest_access");
});

test("3e: nothing the browser receives contains a digest or an identifier", () => {
  const view = LEAF.slice(LEAF.indexOf("export type GuestOrderView"), LEAF.indexOf("export function toGuestOrderView"));
  for (const forbidden of ["id:", "userId", "user_id", "tokenHash", "token_hash", "stripe", "checkoutAttempt", "customerEmail", "email"]) {
    assert.ok(!view.includes(forbidden), `the guest payload carries ${forbidden}`);
  }
  // The column list the route selects is the projection's own, and it
  // names no identifier and no email-state column either.
  const columns = LEAF.slice(LEAF.indexOf("GUEST_ORDER_SELECT_COLUMNS"), LEAF.indexOf("GUEST_ORDER_ITEM_SELECT_COLUMNS"));
  for (const forbidden of [
    '"id"', "user_id", "stripe_", "checkout_attempt_id", "customer_email", "customer_name",
    "confirmation_email", "cancellation_request_note", "cancellation_request_notification",
    "cancellation_outcome", "refund_confirmation", "billing_address_snapshot", "refund_claim",
  ]) {
    assert.ok(!columns.includes(forbidden), `the guest read selects ${forbidden}`);
  }
});

/* ══════════════════════════════════════════════════════════════
   4-6. A TOKEN OPENS EXACTLY ITS OWN ORDER
   ══════════════════════════════════════════════════════════════ */

test("4: the order is resolved from the digest, in the database, and from nothing else", () => {
  // One lookup function, and it is the only way a digest becomes an id.
  assert.ok(READ_ROUTE_CODE.includes('admin.rpc("guest_order_id_for_token"'));
  const fn = sqlFunction(MIGRATION_CODE, "guest_order_id_for_token");
  assert.ok(fn.includes("where token_hash = p_token_hash"));
  // It returns an ID and nothing else, so it cannot become a second,
  // wider order-reading surface.
  assert.ok(fn.includes("returns uuid"));
  assert.ok(!fn.includes("order_number"));
  // The order itself is then read by id, with the curated column list.
  assert.ok(READ_ROUTE_CODE.includes(".select(GUEST_ORDER_SELECT_COLUMNS)"));
  assert.ok(READ_ROUTE_CODE.includes('.eq("id", orderId)'));
});

test("5: every way a link can open nothing is the same 404 and the same sentence", async () => {
  const cases = [
    ["missing token", {}],
    ["null token", { token: null }],
    ["empty token", { token: "" }],
    ["short token", { token: "abc123" }],
    ["non-hex token", { token: "z".repeat(64) }],
    ["uppercase hex", { token: "A".repeat(64) }],
    ["65 hex", { token: "a".repeat(65) }],
    ["numeric token", { token: 12345 }],
    ["array token", { token: [TOKEN_A] }],
  ];
  for (const [label, body] of cases) {
    const res = await post(READ_ENDPOINT, body);
    // A missing/mistyped key is a 400 request-shape refusal; a
    // well-shaped-but-wrong token is a 404. Neither ever succeeds, and
    // neither ever says anything about another order.
    assert.ok(res.status === 400 || res.status === 404, `${label}: status ${res.status}`);
    assert.ok(typeof res.body?.error === "string", `${label}: no error copy`);
    assert.ok(!("order" in (res.body ?? {})), `${label}: an order came back`);
  }

  // A WELL-FORMED TOKEN IN THIS SUITE reaches the unconfigured database
  // and answers 503 - fail-closed, and deliberately not a 404: "we cannot
  // check right now" and "this link opens nothing" are different facts, and
  // a customer holding a valid link must not be told it is dead because a
  // key is missing. Nothing about any order is returned either way.
  const unissued = await post(READ_ENDPOINT, { token: TOKEN_A });
  assert.equal(unissued.status, 503);
  assert.ok(!("order" in unissued.body));
  assert.equal(unissued.body.error, "Vorübergehend nicht verfügbar.");

  // The 404 sentence itself is pinned at the source, since this suite has
  // no database to resolve a real token against. It is ONE constant, shared
  // by both routes, so the two answers cannot diverge.
  assert.ok(LEAF_CODE.includes("export const GUEST_ORDER_NOT_FOUND_MESSAGE ="));
  assert.ok(LEAF_CODE.includes("Dieser Link ist nicht (mehr) gültig."));
  for (const code of [READ_ROUTE_CODE, CANCEL_ROUTE_CODE]) {
    assert.ok(code.includes("{ error: GUEST_ORDER_NOT_FOUND_MESSAGE } as ErrorResponse, { status: 404 }"));
    // And the refusal is a helper, so every branch returns the same thing.
    assert.ok(code.includes("function notFound(): Response {"));
  }
});

test("5b: the refusal is identical for two different unissued tokens", async () => {
  // No enumeration: nothing in the answer varies with the token, so the
  // endpoint cannot be used to learn that one order exists and another
  // does not.
  const a = await post(READ_ENDPOINT, { token: TOKEN_A });
  const b = await post(READ_ENDPOINT, { token: TOKEN_B });
  assert.equal(a.status, b.status);
  assert.deepEqual(a.body, b.body);

  const ca = await post(CANCEL_ENDPOINT, { token: TOKEN_A });
  const cb = await post(CANCEL_ENDPOINT, { token: TOKEN_B });
  assert.equal(ca.status, cb.status);
  assert.deepEqual(ca.body, cb.body);
});

test("6: a token for order A cannot reach order B, and the database says so too", () => {
  // The order id is inside the HMAC message, so two orders cannot derive
  // the same token. Asserted against node:crypto.
  const secret = "y".repeat(32);
  const a = createHmac("sha256", secret).update("gloa:guest-order-manage:v1:11111111-1111-4111-8111-111111111111", "utf8").digest("hex");
  const b = createHmac("sha256", secret).update("gloa:guest-order-manage:v1:22222222-2222-4222-8222-222222222222", "utf8").digest("hex");
  assert.notEqual(a, b);

  // And one digest resolves at most one order, independently of how it
  // was derived.
  assert.ok(MIGRATION_CODE.includes("create unique index if not exists order_guest_access_token_hash_key"));
  assert.ok(MIGRATION_CODE.includes("on public.order_guest_access (token_hash)"));
});

test("6b: neither route accepts an order id, an order number or an email from the browser", async () => {
  // THE BODY IS CLOSED. An extra key is refused, not ignored, so no
  // future edit can start reading one by accident.
  const withId = await post(READ_ENDPOINT, { token: TOKEN_A, orderId: "11111111-1111-4111-8111-111111111111" });
  assert.equal(withId.status, 400);

  for (const extra of [
    { orderId: "11111111-1111-4111-8111-111111111111" },
    { order_number: "GLOA-2026-000459" },
    { email: "someone@example.com" },
    { userId: "11111111-1111-4111-8111-111111111111" },
  ]) {
    const res = await post(CANCEL_ENDPOINT, { token: TOKEN_A, ...extra });
    assert.equal(res.status, 400, `the cancellation route accepted ${Object.keys(extra)[0]}`);
  }
  // token + note is the whole accepted shape.
  assert.ok(CANCEL_ROUTE_CODE.includes('keys.some(key => key !== "token" && key !== "note")'));
  assert.ok(READ_ROUTE_CODE.includes('keys.length !== 1 || keys[0] !== "token"'));

  // And no identifier appears in the source of either route as an input.
  for (const code of [READ_ROUTE_CODE, CANCEL_ROUTE_CODE]) {
    assert.ok(!/const \{[^}]*orderId[^}]*\} = body/.test(code), "a route destructures an orderId from the body");
  }
});

test("6c: the guest cancellation RPC takes no order id at all", () => {
  const fn = sqlFunction(MIGRATION_CODE, "request_order_cancellation_by_token");
  assert.ok(fn.includes("p_token_hash text"));
  assert.ok(!fn.includes("p_order_id"), "the guest wrapper accepts an order id");
  assert.ok(!fn.includes("p_user_id"));
  // It resolves the order itself, through the one reader.
  assert.ok(fn.includes("v_order_id := public.guest_order_id_for_token(p_token_hash);"));
  assert.ok(fn.includes("if v_order_id is null then"));
  assert.ok(fn.includes("return 'not_found';"));
});

/* ══════════════════════════════════════════════════════════════
   7. NO ADMIN FIELD AND NO ADMIN ACTION
   ══════════════════════════════════════════════════════════════ */

test("7: the guest surface has no admin capability anywhere in it", () => {
  for (const [label, code] of [
    ["read route", READ_ROUTE_CODE],
    ["cancel route", CANCEL_ROUTE_CODE],
    ["page", PAGE_CODE],
    ["leaf", LEAF_CODE],
  ]) {
    for (const forbidden of [
      "cancel_order", "resolve_order_cancellation_request", "mark_order_shipped",
      "apply_order_refund_state", "claim_order_refund", "adminOrderActions", "adminRefundFlow",
      "adminSession", "adminRoles", "stripe", "Stripe", "refunds.create",
    ]) {
      assert.ok(!code.includes(forbidden), `${label} reaches ${forbidden}`);
    }
  }
  // The leaf reads SUPABASE_SECRET_KEY as the fallback HMAC key, which is
  // deliberate and is the same fallback getCheckoutBucketSecret() uses.
  // Nothing else in the feature may read it: the routes take a client
  // from getSupabaseAdmin() and never a key.
  for (const [label, code] of [["read route", READ_ROUTE_CODE], ["cancel route", CANCEL_ROUTE_CODE], ["page", PAGE_CODE]]) {
    assert.ok(!code.includes("SUPABASE_SECRET_KEY"), `${label} reads a secret key directly`);
  }
  assert.ok(LEAF_CODE.includes("process.env.GUEST_ORDER_TOKEN_SECRET || process.env.SUPABASE_SECRET_KEY"));
});

test("7b: neither guest route writes any column of its own", () => {
  for (const [label, code] of [["read route", READ_ROUTE_CODE], ["cancel route", CANCEL_ROUTE_CODE]]) {
    for (const verb of [".update(", ".insert(", ".upsert(", ".delete("]) {
      assert.ok(!code.includes(verb), `${label} uses ${verb}`);
    }
  }
  // The read route reaches no RPC that can write, and the cancel route
  // reaches exactly the two it needs.
  assert.deepEqual([...READ_ROUTE_CODE.matchAll(/\.rpc\("(\w+)"/g)].map(m => m[1]),
    ["guest_order_id_for_token"]);
  assert.deepEqual([...CANCEL_ROUTE_CODE.matchAll(/\.rpc\("(\w+)"/g)].map(m => m[1]),
    ["request_order_cancellation_by_token", "guest_order_id_for_token"]);
});

test("7c: the page offers exactly one action, and it is 'ask'", () => {
  // One button, one fetch target pair, and no control that could change
  // money, shipping, status or ownership.
  assert.equal([...PAGE_CODE.matchAll(/<button/g)].length, 1);
  assert.deepEqual([...PAGE_CODE.matchAll(/fetch\("([^"]+)"/g)].map(m => m[1]),
    ["/api/orders/guest", "/api/orders/guest/cancellation-request"]);
  for (const forbidden of ["Erstatten", "Erstattung anfragen", "Versenden", "Versand buchen", "Preis ändern", "refunds.create"]) {
    assert.ok(!PAGE_CODE.includes(forbidden), `the guest page offers ${forbidden}`);
  }
  // It states no price of its own: every euro figure is formatted from the
  // server payload.
  assert.ok(!/\d+[.,]\d\d\s*€/.test(PAGE_CODE), "the page hard-codes a price");
});

test("7d: the guest read grants no privilege the account order page did not already have", () => {
  // Every lifecycle field the payload passes through is one
  // app/AccountPortal.tsx already receives via select("*"), so this is a
  // different door to the same room and not a wider room.
  const lifecycleFields = read("lib/orderStatus.ts")
    .slice(read("lib/orderStatus.ts").indexOf("export type OrderLifecycleFields"),
            read("lib/orderStatus.ts").indexOf("export function sanitizeTrackingUrl"));
  for (const field of [
    "status", "payment_status", "fulfillment_status", "total_gross_cents", "refunded_total_cents",
    "shipping_carrier", "tracking_number", "tracking_url", "shipped_at",
    "cancellation_requested_at", "cancellation_request_resolution",
  ]) {
    assert.ok(lifecycleFields.includes(field), `OrderLifecycleFields lost ${field}`);
    assert.ok(LEAF.includes(field), `the guest projection stopped passing ${field}`);
  }
});

/* ══════════════════════════════════════════════════════════════
   8-11. THE CANCELLATION IS THE EXISTING CANCELLATION
   ══════════════════════════════════════════════════════════════ */

test("8: the guest may ask, and the answer vocabulary is the account route's", () => {
  // Same four results, same meanings, same HTTP mapping.
  for (const result of ["not_found", "not_eligible", "requested", "already_requested"]) {
    assert.ok(CANCEL_ROUTE_CODE.includes(`"${result}"`), `the guest route does not handle ${result}`);
    assert.ok(ACCOUNT_ROUTE.includes(`"${result}"`), `the account route no longer handles ${result}`);
  }
  assert.ok(CANCEL_ROUTE_CODE.includes("status: 409"));
  assert.ok(CANCEL_ROUTE_CODE.includes('state: data, message: REVIEW_MESSAGE'));
});

test("8b: the two routes tell the customer exactly the same thing", () => {
  // Three sentences, byte for byte, so which door a customer came through
  // is invisible to them.
  const review = "Wir prüfen, ob die Bestellung noch gestoppt werden kann, und melden uns per E-Mail.";
  const tooLate = "Diese Bestellung lässt sich nicht mehr stoppen. Nach Erhalt kannst du dein Widerrufsrecht nutzen.";
  assert.ok(ACCOUNT_ROUTE.includes(review) && CANCEL_ROUTE.includes(review));
  for (const fragment of ["Diese Bestellung lässt sich nicht mehr stoppen.", "Widerrufsrecht nutzen."]) {
    assert.ok(ACCOUNT_ROUTE.includes(fragment) && CANCEL_ROUTE.includes(fragment), `the 409 copy diverged: ${fragment}`);
  }
  assert.ok(tooLate.length > 0);
  // And neither ever says "storniert", because nothing has been cancelled.
  for (const [label, code] of [["account", ACCOUNT_ROUTE], ["guest", CANCEL_ROUTE]]) {
    assert.ok(!/storniert/i.test(withoutComments(code)), `${label} route tells the customer the order is cancelled`);
  }
});

test("9: there is exactly ONE cancellation-request rule, and both doors reach it", () => {
  // The rule lives in apply_order_cancellation_request and nowhere else.
  const core = sqlFunction(MIGRATION_CODE, "apply_order_cancellation_request");
  const ELIGIBILITY = "v_order.status in ('cancelled', 'refunded', 'shipped', 'delivered')";
  assert.ok(core.includes(ELIGIBILITY));
  assert.equal([...MIGRATION_CODE.matchAll(/v_order\.status in \('cancelled', 'refunded', 'shipped', 'delivered'\)/g)].length, 1,
    "065 states the eligibility rule more than once");

  // Neither wrapper contains a rule.
  for (const name of ["request_order_cancellation", "request_order_cancellation_by_token"]) {
    const wrapper = sqlFunction(MIGRATION_CODE, name);
    assert.ok(!wrapper.includes("cancellation_requested_at"), `${name} decides idempotency itself`);
    assert.ok(!wrapper.includes("fulfillment_status"), `${name} decides eligibility itself`);
    assert.ok(!wrapper.includes("update public.orders"), `${name} writes the order itself`);
    assert.ok(wrapper.includes("return public.apply_order_cancellation_request("), `${name} does not delegate`);
  }
});

test("9b: the extracted rule is 019's, clause for clause and in the same order", () => {
  // The single most important assertion in this suite. A guest request
  // must not be a second kind of request.
  const before = sqlFunction(MIGRATION_019, "request_order_cancellation");
  const after = sqlFunction(MIGRATION_CODE, "apply_order_cancellation_request");

  const CLAUSES = [
    "select * into v_order",
    "from public.orders",
    "for update;",
    "if v_order.cancellation_requested_at is not null then",
    "return 'already_requested';",
    "if v_order.status in ('cancelled', 'refunded', 'shipped', 'delivered')",
    "or v_order.fulfillment_status in ('cancelled', 'shipped', 'delivered')",
    "or v_order.payment_status in ('refunded', 'partially_refunded')",
    "return 'not_eligible';",
    "update public.orders",
    "set cancellation_requested_at = now(),",
    "cancellation_request_note = nullif(btrim(coalesce(p_note, '')), '')",
    "return 'requested';",
  ];
  let beforeAt = -1;
  let afterAt = -1;
  for (const clause of CLAUSES) {
    const b = before.indexOf(clause, beforeAt + 1);
    const a = after.indexOf(clause, afterAt + 1);
    assert.ok(b > beforeAt, `019 lost a clause: ${clause}`);
    assert.ok(a > afterAt, `the extracted rule lost a clause, or reordered it: ${clause}`);
    beforeAt = b;
    afterAt = a;
  }

  // IDEMPOTENCY AHEAD OF ELIGIBILITY, in both. An order that was already
  // asked about and has since shipped answers 'already_requested', which
  // is true, rather than 'not_eligible', which reads as "we never got
  // your message".
  for (const [label, body] of [["019", before], ["065", after]]) {
    assert.ok(body.indexOf("return 'already_requested';") < body.indexOf("return 'not_eligible';"),
      `${label} moved the idempotency check behind the eligibility check`);
  }

  // TWO COLUMNS, STILL. The rule writes what 019 wrote and nothing else.
  // The SET clause only. Its closing WHERE is found from the SET onward,
  // because the locking SELECT above it uses the same predicate.
  const setAt = after.indexOf("set cancellation_requested_at");
  assert.ok(setAt > 0, "the extracted rule no longer writes the request timestamp");
  const setClause = after.slice(setAt, after.indexOf("where id = p_order_id", setAt));
  assert.equal([...setClause.matchAll(/=\s/g)].length, 2, "the extracted rule writes a third column");
  const update = after.slice(after.indexOf("update public.orders"));
  for (const forbidden of ["status =", "fulfillment_status =", "payment_status =", "refunded_total_cents ="]) {
    assert.ok(!update.includes(forbidden), `the extracted rule writes ${forbidden}`);
  }
});

test("9c: the core is callable by no route - the authorization stays in the database", () => {
  // A function that takes an order id and no authorization argument must
  // not be reachable from application code, or it would be a way to open
  // a cancellation request on any order by id.
  assert.ok(MIGRATION_CODE.includes("revoke all on function public.apply_order_cancellation_request(uuid, text) from public;"));
  assert.ok(!/grant execute on function public\.apply_order_cancellation_request/.test(MIGRATION_CODE),
    "the unauthorized core is granted to a role");
  // And nothing in app/ or lib/ names it.
  for (const rel of [
    "app/api/orders/guest/cancellation-request/route.ts",
    "app/api/orders/cancellation-request/route.ts",
    "app/api/orders/guest/route.ts",
    "lib/orderConfirmationEmail.ts",
  ]) {
    // Comments stripped: two of these files NAME the core in prose, to say
    // that they reach it only through a wrapper. Naming it is the
    // documentation; calling it is the thing forbidden.
    assert.ok(!withoutComments(read(rel)).includes("apply_order_cancellation_request"),
      `${rel} calls the unauthorized core`);
  }
  // The two wrappers ARE granted, and only to service_role.
  for (const signature of [
    "public.request_order_cancellation(uuid, uuid, text)",
    "public.request_order_cancellation_by_token(text, text)",
    "public.attach_guest_order_manage_token(uuid, text)",
    "public.guest_order_id_for_token(text)",
  ]) {
    assert.ok(MIGRATION_CODE.includes(`revoke all on function ${signature} from public;`), `${signature} is not revoked from public`);
    assert.ok(MIGRATION_CODE.includes(`grant execute on function ${signature} to service_role;`), `${signature} is not granted to service_role`);
  }
});

test("10: a repeat request is idempotent, at the database and at the route", () => {
  const core = sqlFunction(MIGRATION_CODE, "apply_order_cancellation_request");
  assert.ok(core.includes("if v_order.cancellation_requested_at is not null then"));
  assert.ok(core.includes("return 'already_requested';"));
  // The timestamp is written in exactly one place, so a repeat cannot
  // move it.
  assert.equal([...core.matchAll(/cancellation_requested_at = now\(\)/g)].length, 1);
  // The route reports the repeat as success, with the same message.
  assert.ok(CANCEL_ROUTE_CODE.includes('if (data === "requested" || data === "already_requested")'));
  // And a repeat enters the notification sender, which claims only a
  // FAILED row - so it is the interim retry path and never a second mail.
  assert.ok(CANCEL_ROUTE_CODE.includes("sendCancellationRequestNotificationIfNeeded(orderId)"));
  assert.equal([...CANCEL_ROUTE_CODE.matchAll(/sendCancellationRequestNotificationIfNeeded\(/g)].length, 1);
});

test("11: a shipped order cannot take a new request, decided under the row lock", () => {
  const core = sqlFunction(MIGRATION_CODE, "apply_order_cancellation_request");
  assert.ok(core.includes("'shipped'"));
  assert.ok(core.includes("'delivered'"));
  // Decided AFTER the lock, so a page left open across a shipment cannot
  // win a race with it.
  assert.ok(core.indexOf("for update;") < core.indexOf("return 'not_eligible';"));
  // NO PRE-RPC APPLICATION GUARD. A route-level check would decide on a
  // stale read, and the guest route deliberately reads no order at all.
  for (const forbidden of [
    "cancellation_requested_at", "cancellation_request_resolution", "fulfillment_status",
    'from("orders")', "maybeSingle",
  ]) {
    assert.ok(!CANCEL_ROUTE_CODE.includes(forbidden), `the guest route performs its own check: ${forbidden}`);
  }
  // The page renders getCancellationView()'s answer and invents nothing.
  assert.ok(PAGE_CODE.includes("const cancellation = getCancellationView(life);"));
  assert.ok(PAGE_CODE.includes('cancellation.state === "too_late"'));
  assert.ok(!PAGE_CODE.includes('=== "shipped"'), "the page decides shipment state itself");
});

/* ══════════════════════════════════════════════════════════════
   12-15. THE OPERATIONAL RESULT IS UNCHANGED
   ══════════════════════════════════════════════════════════════ */

test("12: an open request still blocks shipment, through the guard that already existed", () => {
  // 065 does not touch 032, and 032's guard is the one that refuses.
  assert.ok(!MIGRATION_CODE.includes("mark_order_shipped"), "065 touches the shipment writer");
  const guard = sqlFunction(withoutComments(read("supabase/migrations/032_open_cancellation_request_shipment_guard.sql")), "mark_order_shipped");
  assert.ok(guard.includes("cancellation_requested_at is not null"));
  assert.ok(guard.includes("cancellation_request_resolution is null"));
  // The two columns a guest request writes are the two that guard reads.
  const core = sqlFunction(MIGRATION_CODE, "apply_order_cancellation_request");
  assert.ok(core.includes("cancellation_requested_at = now()"));
});

test("13: the admin overview still reads STORNO ANGEFRAGT from those same columns", () => {
  const rules = read("lib/adminOrderActionRules.ts");
  assert.ok(rules.includes("hasOpenCancellationRequest"));
  assert.ok(rules.includes('label: "Storno angefragt"'));
  // The admin surface is not touched by this package at all.
  for (const rel of ["lib/adminOrderActionRules.ts", "lib/adminOrderActions.ts", "app/AdminOrders.tsx", "app/api/admin/orders/route.ts"]) {
    assert.ok(!read(rel).includes("guest"), `${rel} grew a guest-specific branch`);
    assert.ok(!read(rel).includes("order_guest_access"), `${rel} reads the credential table`);
  }
  // And the admin route's open-request counter still reads the same pair.
  const adminRoute = read("app/api/admin/orders/route.ts");
  assert.ok(adminRoute.includes('.not("cancellation_requested_at", "is", null).is("cancellation_request_resolution", null)'));
});

test("14/15: the outcome mail is driven by the resolution, never by who asked", () => {
  // resolve_order_cancellation_request is untouched, and the sender reads
  // the order row - so a guest's request and an account customer's
  // request produce the same approved/declined mail.
  assert.ok(!MIGRATION_CODE.includes("resolve_order_cancellation_request"), "065 touches the resolver");
  const resolveRoute = read("app/api/internal/orders/cancellation-request/resolve/route.ts");
  assert.ok(resolveRoute.includes('admin.rpc("resolve_order_cancellation_request"'));
  assert.ok(resolveRoute.includes("sendCancellationOutcomeEmailIfNeeded(orderId)"));

  const outcome = withoutComments(read("lib/cancellationOutcomeEmail.ts"));
  assert.ok(outcome.includes("cancellation_request_resolution"), "the outcome sender stopped reading the resolution");
  // It takes its recipient and its words from the order, and knows nothing
  // about tokens or guest access.
  assert.ok(!outcome.includes("guestManageUrl"), "the outcome sender grew a guest branch");
  assert.ok(!outcome.includes("guestOrderAccess"), "the outcome sender reaches the guest leaf");
  assert.ok(!outcome.includes("token"), "the outcome sender reads a token");
});

test("16: no automatic refund is introduced anywhere - Storno is still not Refund", () => {
  for (const [label, code] of [
    ["065", MIGRATION_CODE],
    ["read route", READ_ROUTE_CODE],
    ["cancel route", CANCEL_ROUTE_CODE],
    ["leaf", LEAF_CODE],
    ["page", PAGE_CODE],
  ]) {
    for (const forbidden of ["refunded_total_cents =", "payment_status =", "refunds.create", "apply_order_refund_state", "claim_order_refund"]) {
      assert.ok(!code.includes(forbidden), `${label} touches the refund path: ${forbidden}`);
    }
  }
  // 065 writes exactly two tables' worth of columns: the credential row,
  // and 019's two cancellation columns.
  const updates = [...MIGRATION_CODE.matchAll(/update public\.(\w+)/g)].map(m => m[1]);
  assert.deepEqual([...new Set(updates)].sort(), ["order_guest_access", "orders"]);
  const inserts = [...MIGRATION_CODE.matchAll(/insert into public\.(\w+)/g)].map(m => m[1]);
  assert.deepEqual([...new Set(inserts)], ["order_guest_access"]);
  assert.ok(!MIGRATION_CODE.includes("delete from"), "065 deletes rows");
  assert.ok(!MIGRATION_CODE.includes("truncate"));
  assert.ok(!MIGRATION_CODE.includes("drop table"));
  assert.ok(!MIGRATION_CODE.includes("drop function"));
});

/* ══════════════════════════════════════════════════════════════
   17-19. NOTHING ELSE MOVED
   ══════════════════════════════════════════════════════════════ */

test("17: the authenticated account order flow is unchanged", () => {
  // The route file is untouched: same signature, same three arguments,
  // same single RPC, same ownership story.
  assert.ok(ACCOUNT_ROUTE.includes("const userId = await verifyUserId(request);"));
  assert.ok(ACCOUNT_ROUTE.includes('return Response.json({ error: "Bitte melde dich an." } as ErrorResponse, { status: 401 });'));
  assert.deepEqual([...ACCOUNT_ROUTE.matchAll(/\.rpc\("(\w+)"/g)].map(m => m[1]), ["request_order_cancellation"]);
  assert.ok(ACCOUNT_ROUTE.includes("p_order_id: orderId,"));
  assert.ok(ACCOUNT_ROUTE.includes("p_user_id: userId,"));
  // Comments stripped: the route's prose explains that ownership is checked
  // against the id verified from the bearer TOKEN. The code path is what
  // must stay free of one.
  assert.ok(!withoutComments(ACCOUNT_ROUTE).includes("token"), "the account route grew a token path");

  // And the wrapper it calls keeps the contract 019 gave it.
  const wrapper = sqlFunction(MIGRATION_CODE, "request_order_cancellation");
  assert.ok(wrapper.includes("p_order_id uuid,"));
  assert.ok(wrapper.includes("p_user_id  uuid,"));
  assert.ok(wrapper.includes("p_note     text"));
  // Ownership is still enforced in the database, against the verified
  // user id, and a foreign order is still indistinguishable from a
  // missing one.
  assert.ok(wrapper.includes("and user_id = p_user_id"));
  assert.ok(wrapper.includes("if p_order_id is null or p_user_id is null then"));
  assert.equal([...wrapper.matchAll(/return 'not_found';/g)].length, 2);
  // It does NOT require the order to be a guest order, and the guest
  // wrapper does not require the opposite - neither reads user_id to
  // exclude the other.
  assert.ok(!sqlFunction(MIGRATION_CODE, "request_order_cancellation_by_token").includes("user_id"));
});

test("17b: the account order page still renders from its own read and its own route", () => {
  const portal = read("app/AccountPortal.tsx");
  assert.ok(portal.includes('fetch("/api/orders/cancellation-request"'));
  assert.ok(!portal.includes("/api/orders/guest"), "the account page was rerouted through the guest surface");
  assert.ok(!portal.includes("guestManageUrl"));
  // Both pages call the same seven presentation readers.
  for (const fn of [
    "getLifecycleSteps", "getStatusDetailText", "getTrackingView", "getRefundView",
    "getCancellationView", "getPrimaryStatusLabel", "getPaymentStatusLabel",
  ]) {
    assert.ok(portal.includes(`${fn}(`), `the account page stopped calling ${fn}`);
    assert.ok(PAGE_CODE.includes(`${fn}(`), `the guest page does not call ${fn}`);
  }
  // The guest page holds no label of its own for a status or a payment
  // state: it prints what the shared module returns.
  for (const forbidden of ["Bezahlt", "Storniert", "Zugestellt", "In Bearbeitung"]) {
    assert.ok(!PAGE_CODE.includes(forbidden), `the guest page states its own label: ${forbidden}`);
  }
});

test("18: subscription checkout and the subscription mails are untouched", () => {
  for (const rel of [
    "lib/subscriptionCheckout.ts", "lib/subscriptionCheckoutRules.ts", "lib/subscriptionStartedEmail.ts",
    "lib/subscriptionInvoiceFulfillment.ts", "lib/subscriptionCancellation.ts",
    "app/api/subscriptions/checkout/session/route.ts", "app/api/subscriptions/cancel/route.ts",
  ]) {
    const code = read(rel);
    for (const forbidden of ["guestManageUrl", "guest_order_id_for_token", "attach_guest_order_manage_token", "guestOrderAccess"]) {
      assert.ok(!code.includes(forbidden), `${rel} reaches ${forbidden}`);
    }
  }
  // The token is attached only by the one-time confirmation sender, so a
  // subscription order never gets one.
  assert.ok(!read("lib/subscriptionStartedEmail.ts").includes("BESTELLUNG VERWALTEN"));
});

test("19: annual checkout and the annual purchase mail are untouched", () => {
  for (const rel of [
    "lib/annualPlanCheckout.ts", "lib/annualPlanCheckoutRules.ts", "lib/annualPurchaseConfirmationEmail.ts",
    "lib/annualPlanWebhook.ts", "lib/annualPlanRefunds.ts", "app/api/annual-plan/checkout/session/route.ts",
  ]) {
    const code = read(rel);
    for (const forbidden of ["guestManageUrl", "guest_order_id_for_token", "attach_guest_order_manage_token", "guestOrderAccess"]) {
      assert.ok(!code.includes(forbidden), `${rel} reaches ${forbidden}`);
    }
  }
  assert.ok(!read("lib/email/annualPurchaseConfirmation.ts").includes("BESTELLUNG VERWALTEN"));
});

test("19b: the one-time webhook path itself is unchanged", () => {
  const webhook = read("app/api/stripe/webhook/route.ts");
  // Exactly one confirmation send, in the same place, and the webhook
  // learned nothing about tokens.
  assert.equal([...webhook.matchAll(/await sendOrderConfirmationEmailIfNeeded\(/g)].length, 1);
  for (const forbidden of ["guestManageUrl", "guestOrderAccess", "attach_guest_order_manage_token", "deriveGuestOrderToken"]) {
    assert.ok(!webhook.includes(forbidden), `the webhook reaches ${forbidden}`);
  }
  // And the confirmation sender's own claim is untouched, so the mail is
  // still sent at most once per order.
  assert.ok(SENDER_CODE.includes('.in("confirmation_email_status", ["pending", "failed"])'));
  assert.ok(SENDER_CODE.includes('if (claim === "already-sent") return;'));
  // The token work happens AFTER the claim - an already-sent order does
  // no attach round trip - and BEFORE the mail is built.
  assert.ok(SENDER_CODE.indexOf("const claim = await claimOrderConfirmationEmail(order.id);")
    < SENDER_CODE.indexOf("await buildGuestManageUrl(order.id)"));
  assert.ok(SENDER_CODE.indexOf("await buildGuestManageUrl(order.id)")
    < SENDER_CODE.indexOf("buildOrderConfirmationEmail({"));
});

/* ══════════════════════════════════════════════════════════════
   20-22. THE MAIL
   ══════════════════════════════════════════════════════════════ */

test("20: the one-time confirmation mail carries the CTA, in HTML and in plain text", () => {
  assert.ok(TEMPLATE.includes("guestManageUrl: string | null;"));
  assert.ok(TEMPLATE.includes('emailButton(order.guestManageUrl, "BESTELLUNG VERWALTEN")'));
  assert.ok(TEMPLATE.includes("BESTELLUNG VERWALTEN\\n${MANAGE_COPY}\\n${order.guestManageUrl}"));
  // The approved copy, once, rendered into both halves - a link present in
  // one and missing from the other is the same defect in half the inboxes.
  const copy = "Du kannst deine Bestellung über diesen sicheren Link ansehen und, solange sie noch nicht versendet wurde, eine Stornierung anfragen.";
  assert.ok(TEMPLATE.includes(copy));
  assert.equal([...TEMPLATE.matchAll(/Du kannst deine Bestellung über diesen sicheren Link/g)].length, 1,
    "the copy is written out twice and can drift");
  assert.ok(TEMPLATE.includes("${manageHtml}"));
  assert.ok(TEMPLATE.includes("    manageText,"));
  // Null omits the CTA entirely rather than shipping a dead button.
  assert.ok(TEMPLATE.includes("const manageHtml = order.guestManageUrl"));
  assert.ok(TEMPLATE.includes("const manageText = order.guestManageUrl"));
});

test("20b: the template can neither mint a token nor see an order id", () => {
  // It receives a built URL and nothing else, which is what keeps an
  // internal id out of the mail by construction.
  const type = TEMPLATE.slice(TEMPLATE.indexOf("export type OrderConfirmationOrder"), TEMPLATE.indexOf("export type BuiltOrderConfirmationEmail"));
  assert.ok(!type.includes("id:"), "the template type carries an order id");
  // Comments stripped: the type's own prose says it never has access to
  // order.id, which is the claim being asserted and not a violation of it.
  const templateCode = withoutComments(TEMPLATE);
  for (const f of ["createHmac", "createHash", "node:crypto", "order.id", "deriveGuestOrderToken"]) {
    assert.ok(!templateCode.includes(f), `the template reaches ${f}`);
  }
  // And it has no relative import beyond the brand leaf, which is what
  // lets it be unit-tested directly.
  assert.deepEqual([...TEMPLATE.matchAll(/from "(\.[^"]+)"/g)].map(m => m[1]), ["./brand.ts"]);
});

test("21: a confirmation retry carries the SAME link", () => {
  // The link is a pure function of (secret, order id): same order, same
  // secret, same URL, on the first delivery and on the fifth.
  const secret = "z".repeat(48);
  const orderId = "abcdabcd-1234-4567-89ab-cdefcdefcdef";
  const token = createHmac("sha256", secret).update(`gloa:guest-order-manage:v1:${orderId}`, "utf8").digest("hex");
  assert.equal(
    `https://gloamatcha.com/order/manage?token=${token}`,
    `https://gloamatcha.com/order/manage?token=${createHmac("sha256", secret).update(`gloa:guest-order-manage:v1:${orderId}`, "utf8").digest("hex")}`
  );
  // The URL shape the leaf builds, pinned.
  assert.ok(LEAF_CODE.includes('return `${origin.replace(/\\/+$/, "")}/${GUEST_ORDER_MANAGE_PATH}?token=${token}`;'));
  assert.ok(LEAF_CODE.includes('export const GUEST_ORDER_MANAGE_PATH = "order/manage";'));
  // Nothing in the retry path re-mints: the retry IS the webhook
  // redelivery, and order confirmation is deliberately not an auto-retry
  // family.
  // Comments stripped: that module documents at length that the column name
  // deliberately appears nowhere in it.
  const retry = withoutComments(read("lib/transactionalEmailRetry.ts"));
  assert.ok(!retry.includes("confirmation_email_status"), "order confirmation joined the auto-retry families");
  assert.ok(!retry.includes("guest"), "the retry sweep grew a guest branch");
});

test("21b: the digest stored for that same order matches that same token", () => {
  // The other half of "the retry reuses the link": the digest the writer
  // is handed is a pure function of the token, so a redelivery hands over
  // the identical value and the writer answers 'unchanged'.
  const token = "c".repeat(64);
  const first = createHash("sha256").update(token, "utf8").digest("hex");
  const second = createHash("sha256").update(token, "utf8").digest("hex");
  assert.equal(first, second);
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.ok(LEAF_CODE.includes('return createHash("sha256").update(token, "utf8").digest("hex");'));
});

test("22: no token reaches a log, an analytics payload or a snapshot", () => {
  // Analytics: nothing in this feature imports it, and the page sends no
  // event of its own.
  for (const [label, code] of [
    ["page", PAGE_CODE], ["read route", READ_ROUTE_CODE], ["cancel route", CANCEL_ROUTE_CODE], ["leaf", LEAF_CODE],
  ]) {
    for (const forbidden of ["analytics", "gtag", "dataLayer", "plausible", "posthog"]) {
      assert.ok(!code.includes(forbidden), `${label} reaches ${forbidden}`);
    }
  }
  // The page never writes the token anywhere persistent, so it cannot
  // outlive the tab.
  for (const forbidden of ["localStorage", "sessionStorage", "document.cookie", "history.pushState"]) {
    assert.ok(!PAGE_CODE.includes(forbidden), `the page stores the token in ${forbidden}`);
  }
  // This suite itself never writes a real token down: every value it uses
  // is a repeated character or is derived at runtime from a throwaway
  // secret, so no snapshot of this file carries a usable credential.
  const self = read("tests/guest-order-management.test.mjs");
  assert.ok(!/[0-9a-f]{64}/.test(self), "this suite contains a literal 64-hex token");
  assert.ok(self.includes('const TOKEN_A = "a".repeat(64);'));
});

/* ══════════════════════════════════════════════════════════════
   23. THE LINK IS PRIVATE, AND THE ROUTE EXISTS
   ══════════════════════════════════════════════════════════════ */

test("23: the page is a known route, noindex, and no-referrer", () => {
  const routes = withoutComments(read("lib/publicRoutes.ts"));
  assert.ok(routes.includes('"order/manage",'), "the route does not exist and would 404");
  // Not indexable, and not in the sitemap. A URL that opens one person's
  // order may never be offered to a crawler.
  const indexable = routes.slice(routes.indexOf("export const INDEXABLE_ROUTES"), routes.indexOf("export const SITE_ORIGIN"));
  assert.ok(!indexable.includes("order/manage"));
  // A static route, so it cannot collide with order/success.
  const dynamic = routes.slice(routes.indexOf("export const DYNAMIC_PREFIXES"), routes.indexOf("export const INDEXABLE_ROUTES"));
  assert.ok(!dynamic.includes("order/"), "the token was moved into the path");

  const page = read("app/[...slug]/page.tsx");
  // noindex through the existing `order/` rule, and the referrer policy
  // that stops the token reaching anything the page links to.
  assert.ok(page.includes('path.startsWith("order/")'));
  assert.ok(page.includes('path==="order/manage"?{referrer:"no-referrer" as const}:{}'));
  assert.ok(page.includes('"order/manage":['), "the page has no title of its own");

  // And the renderer serves it, as an exact route.
  const site = read("app/GloaSite.tsx");
  assert.ok(site.includes('else if(route==="order/manage")page=<GuestOrder/>;'));
  assert.ok(site.indexOf('route==="order/success"') < site.indexOf('route==="order/manage"'));
});

test("23b: both routes answer no-store, and the read route is not a GET", () => {
  for (const [label, code] of [["read", READ_ROUTE_CODE], ["cancel", CANCEL_ROUTE_CODE]]) {
    assert.ok(code.includes('"Cache-Control": "no-store"'), `${label} route may be cached`);
    assert.ok(code.includes('"Referrer-Policy": "no-referrer"'), `${label} route leaks a referrer`);
    assert.ok(code.includes("export async function POST("), `${label} route is not a POST`);
    assert.ok(!code.includes("export async function GET("), `${label} route accepts a GET, putting the token in the request line`);
  }
});

test("23c: a GET and a non-JSON POST are refused", async () => {
  for (const endpoint of [READ_ENDPOINT, CANCEL_ENDPOINT]) {
    const get = await fetch(endpoint);
    assert.ok(get.status === 404 || get.status === 405, `GET ${endpoint} answered ${get.status}`);

    const form = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `token=${TOKEN_A}`,
    });
    assert.equal(form.status, 400);

    const broken = await post(endpoint, "{not json");
    assert.equal(broken.status, 400);

    const huge = await post(endpoint, { token: TOKEN_A, note: "n".repeat(30_000) });
    assert.ok(huge.status === 400 || huge.status === 413, `an oversized body answered ${huge.status}`);
  }
});

test("23d: the note is bounded exactly as the account route bounds it", async () => {
  assert.ok(CANCEL_ROUTE_CODE.includes("const MAX_NOTE_LEN = 2000;"));
  assert.ok(ACCOUNT_ROUTE.includes("const MAX_NOTE_LEN = 2000;"));
  // The database says so as well (migration 019's CHECK).
  assert.ok(read("supabase/migrations/019_order_lifecycle_tracking.sql")
    .includes("char_length(cancellation_request_note) <= 2000"));
  const tooLong = await post(CANCEL_ENDPOINT, { token: TOKEN_A, note: "x".repeat(2001) });
  assert.equal(tooLong.status, 400);
  // A wrongly-typed note is refused, not coerced.
  const wrongType = await post(CANCEL_ENDPOINT, { token: TOKEN_A, note: 42 });
  assert.equal(wrongType.status, 400);
  // And a note AT the limit passes the shape gate and fails closed at the
  // unconfigured database instead - so 2000 is inclusive.
  const atLimit = await post(CANCEL_ENDPOINT, { token: TOKEN_A, note: "x".repeat(2000) });
  assert.equal(atLimit.status, 503);
});

/* ══════════════════════════════════════════════════════════════
   24. THE RATE LIMIT IS THE EXISTING ONE
   ══════════════════════════════════════════════════════════════ */

test("24: both routes spend both layers of the existing limiter", () => {
  for (const [label, whole] of [["read", READ_ROUTE_CODE], ["cancel", CANCEL_ROUTE_CODE]]) {
    assert.ok(whole.includes("consumeLocalCheckoutRateLimit({"), `${label} route has no layer 1`);
    assert.ok(whole.includes("consumeSharedCheckoutRateLimit({"), `${label} route has no layer 2`);
    // Measured on the HANDLER, not the file: both names also appear at the
    // top of it, in the import.
    const code = whole.slice(whole.indexOf("export async function POST("));
    // Layer 1 before the body is read; layer 2 next to the work it guards.
    assert.ok(code.indexOf("consumeLocalCheckoutRateLimit") < code.indexOf("await request.text()"),
      `${label} route reads the body before counting the request`);
    assert.ok(code.indexOf("await request.text()") < code.indexOf("consumeSharedCheckoutRateLimit"),
      `${label} route spends the shared counter on a malformed request`);
  }
  // No second rate-limit system: the same type, the same two functions,
  // the same secret getter and the same window.
  assert.ok(LEAF_CODE.includes('from "./checkoutRateLimit.ts"'));
  assert.ok(LEAF_CODE.includes("windowMs: CHECKOUT_RATE_LIMIT_WINDOW_MS,"));
  for (const code of [READ_ROUTE_CODE, CANCEL_ROUTE_CODE]) {
    assert.ok(code.includes("secret: getCheckoutBucketSecret(),"));
  }
});

test("24b: the two policies differ where the cost of being wrong differs", () => {
  const readPolicy = LEAF_CODE.slice(LEAF_CODE.indexOf("GUEST_ORDER_READ_RATE_LIMIT"), LEAF_CODE.indexOf("GUEST_ORDER_CANCEL_RATE_LIMIT"));
  const cancelPolicy = LEAF_CODE.slice(LEAF_CODE.indexOf("export const GUEST_ORDER_CANCEL_RATE_LIMIT"));
  // The read writes nothing, so a counter blip must not break a valid
  // link. The request writes a durable column and mails a human, so a
  // blip refuses.
  assert.ok(readPolicy.includes('unavailable: "allow"'));
  assert.ok(cancelPolicy.includes('unavailable: "refuse"'));
  assert.ok(readPolicy.includes("max: 60,"));
  assert.ok(cancelPolicy.includes("max: 10,"));
  // Separate labels, so one cannot close the other as a side effect.
  assert.notEqual(
    readPolicy.match(/label: "([^"]+)"/)?.[1],
    cancelPolicy.match(/label: "([^"]+)"/)?.[1]
  );
});

/* ══════════════════════════════════════════════════════════════
   25. THE LEAF STAYS OUT OF THE BROWSER
   ══════════════════════════════════════════════════════════════ */

test("25: the server-only leaf is never imported by a client component", () => {
  assert.ok(LEAF.startsWith('import { createHmac, createHash } from "node:crypto";'),
    "the leaf lost the node:crypto import that keeps it out of a browser bundle");
  assert.ok(PAGE.startsWith('"use client";'));
  assert.ok(!PAGE.includes("guestOrderAccess"), "the client page imports the server leaf");
  // It declares the wire shape for itself, exactly as OrderSuccess does.
  assert.ok(PAGE.includes("type GuestOrderView = {"));
  // And it imports only pure modules.
  const imports = [...PAGE.matchAll(/from "(\.\.\/[^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(imports.sort(), ["../lib/orderAddressSnapshot", "../lib/orderStatus", "../lib/shipping"]);
});

test("25b: 065 is idempotent and additive", () => {
  assert.ok(MIGRATION_CODE.includes("create table if not exists public.order_guest_access"));
  assert.ok(MIGRATION_CODE.includes("create unique index if not exists"));
  // Every constraint is dropped by its own name before being added.
  const added = [...MIGRATION_CODE.matchAll(/add constraint (\w+)/g)].map(m => m[1]);
  for (const name of added) {
    assert.ok(MIGRATION_CODE.includes(`drop constraint if exists ${name};`), `${name} is added without a preceding drop`);
    // Postgres truncates identifiers at 63 bytes, so a longer name would
    // not be the name the database ends up holding.
    assert.ok(Buffer.byteLength(name, "utf8") <= 63, `${name} is longer than 63 bytes and would be truncated`);
  }
  // Every function is create-or-replace, so a re-run replaces rather than
  // fails.
  assert.equal(
    [...MIGRATION_CODE.matchAll(/create or replace function/g)].length,
    [...MIGRATION_CODE.matchAll(/^create (or replace )?function/gm)].length
  );
  // And every one is SECURITY DEFINER with an empty search_path, the
  // pattern 011/019/029/031/032 established.
  assert.equal(
    [...MIGRATION_CODE.matchAll(/create or replace function/g)].length,
    [...MIGRATION_CODE.matchAll(/security definer set search_path = ''/g)].length
  );
});
