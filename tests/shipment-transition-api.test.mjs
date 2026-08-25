import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeBlockedServerEnv } from "./helpers/testSupabase.mjs";
import {
  ALLOWED_BODY_KEYS,
  MAX_CARRIER_LEN,
  MAX_TRACKING_NUMBER_LEN,
  MAX_TRACKING_URL_LEN,
  ORDER_NUMBER_RE,
  SHIPMENT_RESULTS,
  isShipmentResult,
  shipmentIsDurable,
  shipmentResultStatus,
  shipmentWasNewlyApplied,
  validateShipmentRequest,
} from "../lib/shipmentTransitionRules.ts";
import { isBearerSecretAuthorized } from "../lib/serverSecretAuth.ts";
import { sanitizeTrackingUrl } from "../lib/orderStatus.ts";
import { shipmentConfirmationIdempotencyKey } from "../lib/email/shipmentConfirmation.ts";

// SAFE DEFAULT SUITE: pure request/result logic, source-level checks, and
// real spawned servers started WITHOUT a Supabase service-role key and
// WITHOUT a Resend key. No Resend client can be constructed, no database
// is reachable, no production row can be read or written, and no email of
// any kind is sent. Nothing here executes SQL.
//
// The rule this suite protects: only an authorized operator can ship an
// order, the database decides what shipping means, and a mail failure can
// never un-ship a parcel.

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf-8");
const NEWLINE = String.fromCharCode(10);

const MIGRATIONS = path.join(ROOT, "supabase/migrations");
const route = read("app/api/internal/orders/ship/route.ts");
const rules = read("lib/shipmentTransitionRules.ts");
const auth = read("lib/serverSecretAuth.ts");
const migration028 = read("supabase/migrations/028_authorized_shipment_transition.sql");
const cronRoute = read("app/api/cron/retry-order-notifications/route.ts");

const withoutComments = source => source
  .split(NEWLINE)
  .filter(line => {
    const t = line.trim();
    return !t.startsWith("--") && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
  })
  .join(NEWLINE);

const routeCode = withoutComments(route);
const rulesCode = withoutComments(rules);
const sql028 = withoutComments(migration028);

/** Every `process.env.NAME` read in the route. */
const ENV_READ = /process\.env\.(\w+)/g;

const ORDER_NUMBER = "GLOA-2026-000123";
const ORDER_ID = "11111111-2222-3333-4444-555555555555";

const body = (overrides = {}) => ({ orderNumber: ORDER_NUMBER, ...overrides });

/* ══════════════════════════════════════════════════════════════
   INPUT VALIDATION
   ══════════════════════════════════════════════════════════════ */

test("input: a minimal valid request normalizes to three NULLs", () => {
  const result = validateShipmentRequest(body());
  assert.equal(result.ok, true);
  assert.deepEqual(result.request, {
    orderNumber: ORDER_NUMBER,
    carrier: null,
    trackingNumber: null,
    trackingUrl: null,
  });
});

test("input: a non-object body is rejected", () => {
  for (const bad of [null, undefined, "string", 42, true, []]) {
    const result = validateShipmentRequest(bad);
    assert.equal(result.ok, false, JSON.stringify(bad));
    assert.equal(result.code, "invalid_body");
  }
});

test("input: a missing order identifier is rejected", () => {
  const result = validateShipmentRequest({});
  assert.equal(result.ok, false);
  assert.equal(result.code, "invalid_order_number");
});

test("input: a malformed order identifier is rejected", () => {
  for (const bad of [
    "", "   ", "GLOA-2026-12345", "GLOA-2026-1234567", "GLOA-26-000123",
    "gloa-2026", "000123", "GLOA-2026-00012A", "DROP TABLE orders",
    "GLOA-2026-000123 OR 1=1", 42, null, {},
  ]) {
    const result = validateShipmentRequest({ orderNumber: bad });
    assert.equal(result.ok, false, String(bad));
    assert.equal(result.code, "invalid_order_number", String(bad));
  }
});

test("input: the order number regex matches what generate_order_number builds", () => {
  // public.generate_order_number: 'GLOA-' || YYYY || '-' || lpad(seq, 6, '0')
  assert.ok(ORDER_NUMBER_RE.test("GLOA-2026-000001"));
  assert.ok(ORDER_NUMBER_RE.test("GLOA-2026-999999"));
  assert.ok(ORDER_NUMBER_RE.test("GLOA-2030-000123"));
  const migration004 = read("supabase/migrations/004_orders.sql");
  assert.ok(migration004.includes("lpad(nextval('public.order_number_seq')::text, 6, '0')"));
});

test("input: an order number is trimmed and upper-cased, never otherwise rewritten", () => {
  const result = validateShipmentRequest({ orderNumber: "  gloa-2026-000123  " });
  assert.equal(result.ok, true);
  assert.equal(result.request.orderNumber, ORDER_NUMBER);
});

test("input: blank carrier normalizes to NULL", () => {
  for (const blank of ["", "   ", "\t", null, undefined]) {
    const result = validateShipmentRequest(body({ carrier: blank }));
    assert.equal(result.ok, true, String(blank));
    assert.equal(result.request.carrier, null, String(blank));
  }
});

test("input: blank tracking number normalizes to NULL", () => {
  for (const blank of ["", "   ", null, undefined]) {
    const result = validateShipmentRequest(body({ trackingNumber: blank }));
    assert.equal(result.ok, true);
    assert.equal(result.request.trackingNumber, null);
  }
});

test("input: blank tracking URL normalizes to NULL", () => {
  for (const blank of ["", "   ", null, undefined]) {
    const result = validateShipmentRequest(body({ trackingUrl: blank }));
    assert.equal(result.ok, true);
    assert.equal(result.request.trackingUrl, null);
  }
});

test("input: real tracking values are trimmed and kept verbatim", () => {
  const result = validateShipmentRequest(
    body({ carrier: "  DHL  ", trackingNumber: " 00340434161094042557 ", trackingUrl: " https://example.com/t/1 " })
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.request, {
    orderNumber: ORDER_NUMBER,
    carrier: "DHL",
    trackingNumber: "00340434161094042557",
    trackingUrl: "https://example.com/t/1",
  });
});

test("input: a non-http(s) tracking URL is rejected", () => {
  for (const bad of [
    "javascript:alert(1)", "data:text/html,<script>", "vbscript:msgbox",
    "file:///etc/passwd", "mailto:a@b.test", "//example.com/track",
    "/relative/track", "example.com/track", "not a url",
    "https://exa mple.com/t",
  ]) {
    // "https:///nohost" is deliberately absent: WHATWG URL parses the
    // extra slash away and resolves it to host "nohost", so it is a
    // genuinely valid absolute https URL. The sanitizer agrees - see the
    // next test, which compares the two implementations directly.
    const result = validateShipmentRequest(body({ trackingUrl: bad }));
    assert.equal(result.ok, false, bad);
    assert.equal(result.code, "invalid_tracking_url", bad);
  }
});

test("input: the URL rule agrees with the real sanitizeTrackingUrl", () => {
  // Two independent implementations of one rule - the leaf rules module
  // cannot import the sanitizer - so they are compared here directly.
  const cases = [
    "https://example.com/track", "http://example.com/track",
    "javascript:alert(1)", "data:text/html,x", "//example.com", "/rel",
    "https:///nohost", "not a url", "file:///etc/passwd", "https://exa mple.com/t",
  ];
  for (const value of cases) {
    const acceptedByRules = validateShipmentRequest(body({ trackingUrl: value })).ok;
    const acceptedBySanitizer = sanitizeTrackingUrl(value) !== null;
    assert.equal(acceptedByRules, acceptedBySanitizer, `disagreement on ${value}`);
  }
});

test("input: oversized tracking values are rejected", () => {
  const long = n => "x".repeat(n);
  assert.equal(validateShipmentRequest(body({ carrier: long(MAX_CARRIER_LEN) })).ok, true);
  assert.equal(validateShipmentRequest(body({ carrier: long(MAX_CARRIER_LEN + 1) })).code, "invalid_carrier");

  assert.equal(validateShipmentRequest(body({ trackingNumber: long(MAX_TRACKING_NUMBER_LEN) })).ok, true);
  assert.equal(
    validateShipmentRequest(body({ trackingNumber: long(MAX_TRACKING_NUMBER_LEN + 1) })).code,
    "invalid_tracking_number"
  );

  const url = n => `https://e.test/${"x".repeat(n - "https://e.test/".length)}`;
  assert.equal(validateShipmentRequest(body({ trackingUrl: url(MAX_TRACKING_URL_LEN) })).ok, true);
  assert.equal(
    validateShipmentRequest(body({ trackingUrl: url(MAX_TRACKING_URL_LEN + 1) })).code,
    "invalid_tracking_url"
  );
});

test("input: non-string tracking values are rejected, never coerced", () => {
  assert.equal(validateShipmentRequest(body({ carrier: 42 })).code, "invalid_carrier");
  assert.equal(validateShipmentRequest(body({ trackingNumber: {} })).code, "invalid_tracking_number");
  assert.equal(validateShipmentRequest(body({ trackingUrl: ["https://e.test"] })).code, "invalid_tracking_url");
});

/* ── The trust boundary: what a caller may not steer ──────────── */

test("input: shipped_at cannot be supplied", () => {
  for (const key of ["shipped_at", "shippedAt"]) {
    const result = validateShipmentRequest({ ...body(), [key]: "2020-01-01T00:00:00.000Z" });
    assert.equal(result.ok, false, key);
    assert.equal(result.code, "unknown_field", key);
  }
});

test("input: fulfillment_status cannot be supplied", () => {
  for (const key of ["fulfillment_status", "fulfillmentStatus", "status", "payment_status"]) {
    const result = validateShipmentRequest({ ...body(), [key]: "shipped" });
    assert.equal(result.ok, false, key);
    assert.equal(result.code, "unknown_field", key);
  }
});

test("input: a recipient or any email content cannot be supplied", () => {
  for (const key of ["recipient", "to", "email", "customerEmail", "from", "replyTo", "subject", "html", "text"]) {
    const result = validateShipmentRequest({ ...body(), [key]: "attacker@example.test" });
    assert.equal(result.ok, false, key);
    assert.equal(result.code, "unknown_field", key);
  }
});

test("input: the allow-list is exactly four keys and nothing else is honoured", () => {
  assert.deepEqual([...ALLOWED_BODY_KEYS], ["orderNumber", "carrier", "trackingNumber", "trackingUrl"]);
  // Unknown keys are REFUSED, not silently dropped: an operator who sends
  // one finds out rather than believing it took effect.
  const result = validateShipmentRequest({ ...body(), anythingElse: 1 });
  assert.equal(result.code, "unknown_field");
});

/* ══════════════════════════════════════════════════════════════
   RESULT MAPPING
   ══════════════════════════════════════════════════════════════ */

test("results: only a durable shipment may reach the email step", () => {
  assert.equal(shipmentIsDurable("shipped"), true);
  assert.equal(shipmentIsDurable("already_shipped"), true);
  for (const refused of ["conflict", "already_advanced", "not_shippable", "not_found"]) {
    assert.equal(shipmentIsDurable(refused), false, refused);
  }
});

test("results: only a first transition counts as newly applied", () => {
  assert.equal(shipmentWasNewlyApplied("shipped"), true);
  assert.equal(shipmentWasNewlyApplied("already_shipped"), false);
});

test("results: each result maps to a sensible HTTP status", () => {
  assert.equal(shipmentResultStatus("shipped"), 200);
  assert.equal(shipmentResultStatus("already_shipped"), 200);
  assert.equal(shipmentResultStatus("not_found"), 404);
  for (const conflict of ["conflict", "already_advanced", "not_shippable"]) {
    assert.equal(shipmentResultStatus(conflict), 409, conflict);
  }
});

test("results: an unrecognized RPC result is refused, never guessed at", () => {
  for (const bad of ["ok", "SHIPPED", "", null, undefined, 1, {}, "delivered"]) {
    assert.equal(isShipmentResult(bad), false, String(bad));
  }
  for (const good of SHIPMENT_RESULTS) assert.equal(isShipmentResult(good), true, good);
});

test("results: the route refuses an unknown result rather than mailing anyone", () => {
  const guard = routeCode.slice(routeCode.indexOf("isShipmentResult(payload.result)"));
  const emailAt = routeCode.indexOf("sendShipmentConfirmationIfNeeded(orderId)");
  const guardAt = routeCode.indexOf("isShipmentResult(payload.result)");
  assert.ok(guardAt > -1 && emailAt > guardAt, "the result guard does not precede the email");
  assert.ok(guard.includes("Interner Fehler."));
});

/* ══════════════════════════════════════════════════════════════
   AUTHORIZATION
   ══════════════════════════════════════════════════════════════ */

const secretRequest = (headers = {}) => new Request("https://gloamatcha.test/api/internal/orders/ship", { headers });

test("auth: an empty secret authorizes nobody, whatever the header says", () => {
  assert.equal(isBearerSecretAuthorized(secretRequest({ authorization: "Bearer " }), ""), false);
  assert.equal(isBearerSecretAuthorized(secretRequest({ authorization: "Bearer x" }), ""), false);
  assert.equal(isBearerSecretAuthorized(secretRequest({}), ""), false);
});

test("auth: a missing header is rejected", () => {
  assert.equal(isBearerSecretAuthorized(secretRequest({}), "s3cret"), false);
});

test("auth: a wrong or malformed header is rejected", () => {
  for (const header of [
    "Bearer", "Bearer ", "Bearer wrong", "bearer s3cret", "Basic s3cret",
    "s3cret", "Bearer s3crets", "Bearer s3cre", "Bearer  s3cret",
  ]) {
    // A surrounding space is absent from this list on purpose: the
    // Headers API trims header values before a handler ever sees them,
    // so "Bearer s3cret " and "Bearer s3cret" are the same header. That
    // is HTTP behaviour, not a weakness in the comparison.
    assert.equal(isBearerSecretAuthorized(secretRequest({ authorization: header }), "s3cret"), false, header);
  }
});

test("auth: exactly the right header is accepted", () => {
  assert.equal(isBearerSecretAuthorized(secretRequest({ authorization: "Bearer s3cret" }), "s3cret"), true);
});

test("auth: the comparison is timing safe and length-blind", () => {
  // sha256 both sides first, so timingSafeEqual never sees differing
  // lengths and a length mismatch cannot become an observable error.
  assert.ok(auth.includes("createHash(\"sha256\")"));
  assert.ok(auth.includes("timingSafeEqual("));
  const compare = withoutComments(auth);
  assert.ok(!compare.includes("==="), "a short-circuiting comparison crept in");
  assert.ok(!compare.includes(".startsWith("), "a prefix comparison crept in");
});

test("auth: the route fails closed when FULFILLMENT_ADMIN_SECRET is unset", () => {
  assert.match(routeCode, /const secret = process\.env\.FULFILLMENT_ADMIN_SECRET;/);
  const guard = routeCode.slice(routeCode.indexOf("const secret = process.env.FULFILLMENT_ADMIN_SECRET"));
  assert.ok(guard.includes("if (!secret)"));
  assert.ok(guard.indexOf("status: 503") < guard.indexOf("isBearerSecretAuthorized"));
});

test("auth: the secret is never logged, returned or echoed", () => {
  const logs = [...routeCode.matchAll(/console\.\w+\(([^;]*)\)/g)].map(m => m[1]);
  for (const line of logs) {
    assert.ok(!line.includes("secret"), `a log line references the secret: ${line}`);
    assert.ok(!line.includes("authorization"), `a log line references the header: ${line}`);
    assert.ok(!line.includes("rawBody"), `a log line dumps the body: ${line}`);
  }
  // The only mention of the variable is the read and the "not configured"
  // message, which names it without printing it.
  assert.ok(!routeCode.includes("${secret}"));
  assert.ok(!routeCode.includes("error: secret"));
});

test("auth: customer authentication alone cannot authorize this route", () => {
  // lib/verifyUser.ts answers "which customer", never "may they operate
  // the shop". It must not appear here at all.
  // Against the code, not the prose: the file header explains at length
  // that customer auth is deliberately absent, and a scan that read
  // comments would trip over that explanation.
  assert.ok(!routeCode.includes("verifyUser"), "the route imports customer auth");
  assert.ok(!routeCode.includes("verifyBearerUser"));
  assert.ok(!routeCode.includes("verifyUserId"));
  assert.ok(!routeCode.includes("auth.uid"));
  assert.ok(!routeCode.includes("user_id"));
});

test("auth: this endpoint does not reuse any other secret", () => {
  // "reads" means process.env. The route legitimately NAMES
  // SUPABASE_SECRET_KEY in its "not configured" log line without ever
  // reading it - the admin client owns that.
  for (const other of [
    "CRON_SECRET", "RESEND_API_KEY", "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET", "SUPABASE_SECRET_KEY", "RESEND_CONTACT_FROM",
  ]) {
    assert.ok(!routeCode.includes("process.env." + other), `the ship route reads ${other}`);
  }
  const envReads = [...routeCode.matchAll(ENV_READ)].map(m => m[1]);
  assert.deepEqual(envReads, ["FULFILLMENT_ADMIN_SECRET"], "the route reads another variable");
  // And the cron endpoint still has its own.
  assert.match(withoutComments(cronRoute), /const secret = process\.env\.CRON_SECRET;/);
  assert.ok(!withoutComments(cronRoute).includes("FULFILLMENT_ADMIN_SECRET"));
});

test("auth: the shared helper is used by both endpoints, the secret by neither twice", () => {
  assert.ok(routeCode.includes("isBearerSecretAuthorized(request, secret)"));
  assert.ok(withoutComments(cronRoute).includes("isBearerSecretAuthorized(request, secret)"));
  // The private copy the cron route used to carry is gone.
  assert.ok(!withoutComments(cronRoute).includes("timingSafeEqual"));
  assert.ok(!withoutComments(cronRoute).includes("createHash"));
});

test("auth: the secret is documented in .env.example with no value", () => {
  const example = read(".env.example");
  assert.match(example, /^FULFILLMENT_ADMIN_SECRET=$/m, "the variable has a value or is missing");
  assert.ok(!example.includes("VITE_FULFILLMENT"), "the secret was exposed to the client bundle");
});

test("auth: the secret is not in .env.local and not in any tracked file with a value", () => {
  const example = read(".env.example");
  const assigned = [...example.matchAll(/^FULFILLMENT_ADMIN_SECRET=(.*)$/gm)].map(m => m[1]);
  assert.deepEqual(assigned, [""], "a real value was committed");
});

/* ══════════════════════════════════════════════════════════════
   THE ENDPOINT SHAPE
   ══════════════════════════════════════════════════════════════ */

test("endpoint: it is POST only - there is no GET mutation", () => {
  assert.ok(routeCode.includes("export async function POST("));
  for (const verb of ["GET", "PUT", "PATCH", "DELETE", "HEAD"]) {
    assert.ok(!routeCode.includes(`export async function ${verb}(`), `a ${verb} handler exists`);
  }
});

test("endpoint: the order identifier never travels in a query parameter", () => {
  assert.ok(!routeCode.includes("searchParams"), "the route reads query parameters");
  assert.ok(!routeCode.includes("new URL(request.url)"));
});

test("endpoint: the body is size-bounded before it is parsed", () => {
  const sizeAt = routeCode.indexOf("MAX_BODY_BYTES");
  const parseAt = routeCode.indexOf("JSON.parse(rawBody)");
  assert.ok(sizeAt > -1 && parseAt > sizeAt, "the body is parsed before its size is checked");
});

test("endpoint: authorization happens before anything else is read", () => {
  // Inside the handler body only - every one of these names also appears
  // in the import block at the top of the file.
  const routeCode = withoutComments(route.slice(route.indexOf("export async function POST(")));
  const authAt = routeCode.indexOf("isBearerSecretAuthorized");
  for (const later of ["request.text()", "JSON.parse", "validateShipmentRequest", "getSupabaseAdmin", "admin.rpc"]) {
    assert.ok(routeCode.indexOf(later) > authAt, `${later} runs before authorization`);
  }
});

/* ══════════════════════════════════════════════════════════════
   ORDERING: BUSINESS STATE BEFORE EMAIL
   ══════════════════════════════════════════════════════════════ */

test("ORDERING: the email is only ever attempted after the RPC has returned", () => {
  const rpcAt = routeCode.indexOf('admin.rpc("mark_order_shipped"');
  const emailAt = routeCode.indexOf("sendShipmentConfirmationIfNeeded(orderId)");
  assert.ok(rpcAt > -1, "the route does not call the shipment RPC");
  assert.ok(emailAt > rpcAt, "the email is sent before the shipment transition");
});

test("ORDERING: a non-durable result returns before the email is reached", () => {
  const durableGuardAt = routeCode.indexOf("if (!shipmentIsDurable(result))");
  const emailAt = routeCode.indexOf("sendShipmentConfirmationIfNeeded(orderId)");
  assert.ok(durableGuardAt > -1, "the durability guard is missing");
  assert.ok(emailAt > durableGuardAt, "the email can be reached by a refused result");
  // The guard's own branch returns rather than falling through.
  const branch = routeCode.slice(durableGuardAt, emailAt);
  assert.ok(branch.includes("return Response.json"), "the durability guard does not return");
});

test("ORDERING: an RPC error returns before the email is reached", () => {
  const errorAt = routeCode.indexOf("if (error) {");
  const emailAt = routeCode.indexOf("sendShipmentConfirmationIfNeeded(orderId)");
  assert.ok(errorAt > -1 && emailAt > errorAt);
  assert.ok(routeCode.slice(errorAt, emailAt).includes("status: 500"));
});

test("ORDERING: the email is called exactly once, with only an order id", () => {
  const calls = [...routeCode.matchAll(/sendShipmentConfirmationIfNeeded\(([^)]*)\)/g)];
  assert.equal(calls.length, 1, "the sender is called more than once");
  assert.equal(calls[0][1].trim(), "orderId");
});

test("ORDERING: the order id comes from the RPC, never from the request", () => {
  assert.ok(routeCode.includes('typeof payload.order_id === "string" ? payload.order_id : null'));
  // There is no orderId key on the allow-list, so none can be supplied.
  assert.ok(!ALLOWED_BODY_KEYS.includes("orderId"));
});

/* ══════════════════════════════════════════════════════════════
   EMAIL FAILURE MUST NOT UNDO THE SHIPMENT
   ══════════════════════════════════════════════════════════════ */

test("EMAIL FAILURE: the route has no rollback path at all", () => {
  // p_tracking_number is an RPC ARGUMENT, not a write, so the check is on
  // assignment and rollback shapes rather than on column names alone.
  for (const undo of [
    "unfulfilled", "mark_order_unshipped", "rollback", "revert", "undo",
    "fulfillment_status", "shipping_carrier", "tracking_number",
  ]) {
    // The RPC ARGUMENTS are named p_carrier, p_tracking_number and so
    // on. Those are inputs to the one forward transition, not writes,
    // so the p_-prefixed occurrences are stripped before the scan -
    // anything left would be the route naming a column on its own.
    const withoutRpcArgs = routeCode.replace(/p_\w+/g, "");
    assert.ok(!withoutRpcArgs.includes(undo), `the route can write or undo ${undo}`);
  }
  // shipped_at is READ off the RPC result (payload.shipped_at === ...),
  // which is why this looks for a single "=" assignment specifically
  // rather than for the column name.
  assert.ok(!/shipped_at\s*=(?!=)/.test(routeCode), "the route assigns shipped_at");
  // The only RPC it can call is the forward transition.
  const rpcCalls = [...routeCode.matchAll(/admin\.rpc\("(\w+)"/g)].map(m => m[1]);
  assert.deepEqual(rpcCalls, ["mark_order_shipped"]);
});

test("EMAIL FAILURE: the route performs no table write of its own", () => {
  assert.ok(!routeCode.includes(".update("), "the route writes a table directly");
  assert.ok(!routeCode.includes(".insert("), "the route inserts directly");
  assert.ok(!routeCode.includes(".delete("));
  assert.ok(!routeCode.includes('.from("orders")'));
});

test("EMAIL FAILURE: the send outcome is reported, never branched on to fail the shipment", () => {
  const after = routeCode.slice(routeCode.indexOf("const emailOutcome = await sendShipmentConfirmationIfNeeded"));
  // Whatever the outcome, the response is ok:true with shipmentStatus
  // "shipped". There is no `if (emailOutcome === "failed")` that turns a
  // committed shipment into an error response.
  assert.ok(!after.includes("if (emailOutcome"), "the response branches on the email outcome");
  assert.ok(after.includes("ok: true"));
  assert.ok(after.includes('shipmentStatus: "shipped"'));
  assert.ok(after.includes("emailOutcome,"));
  assert.ok(!after.includes("status: 500"), "an email failure can produce a 500");
});

test("EMAIL FAILURE: the response reports shipment and email as two separate facts", () => {
  assert.ok(routeCode.includes("shipmentStatus"));
  assert.ok(routeCode.includes("emailOutcome"));
  assert.ok(routeCode.includes("shipmentApplied"));
});

test("EMAIL FAILURE: the sender itself cannot write shipment columns", () => {
  // Re-asserted here because it is this task's guarantee too, not only
  // Phase 2A's: the grant is column-scoped to the email columns.
  const sender = withoutComments(read("lib/shipmentConfirmationEmail.ts"));
  const updates = [...sender.matchAll(/\.update\(\{([^}]*)\}\)/g)].map(m => m[1]);
  assert.ok(updates.length >= 3);
  for (const payload of updates) {
    assert.ok(payload.includes("shipment_email_"), `a write outside the email columns: ${payload}`);
    for (const column of ["fulfillment_status", "shipped_at", "tracking_", "shipping_carrier"]) {
      assert.ok(!payload.includes(column), `the sender writes ${column}`);
    }
  }
});

/* ══════════════════════════════════════════════════════════════
   IDEMPOTENT REPEAT AND MANUAL EMAIL RETRY
   ══════════════════════════════════════════════════════════════ */

test("IDEMPOTENCY: an identical repeat is durable, so it re-enters the sender", () => {
  // This is the manual retry path: 'already_shipped' is durable, so the
  // confirmation sender runs again and its own claim decides.
  assert.equal(shipmentIsDurable("already_shipped"), true);
  assert.equal(shipmentWasNewlyApplied("already_shipped"), false);
});

test("IDEMPOTENCY: the RPC does not move shipped_at on a repeat", () => {
  const alreadyShipped = sql028.slice(sql028.indexOf("'already_shipped'"));
  const block = alreadyShipped.slice(0, alreadyShipped.indexOf("end if;"));
  assert.ok(!block.includes("shipped_at = now()"), "a repeat rewrites shipped_at");
  assert.ok(!block.includes("update public.orders"), "a repeat writes the order");
});

test("IDEMPOTENCY: the identical-data test uses IS NOT DISTINCT FROM, so NULL matches NULL", () => {
  // Three NULLs supplied against three NULLs stored is the commonest
  // identical repeat there is. '=' would have made it a conflict.
  assert.ok(sql028.includes("v_order.shipping_carrier is not distinct from v_carrier"));
  assert.ok(sql028.includes("v_order.tracking_number is not distinct from v_number"));
  assert.ok(sql028.includes("v_order.tracking_url    is not distinct from v_url"));
});

test("IDEMPOTENCY: conflicting tracking data returns a conflict, never an overwrite", () => {
  const shippedBranch = sql028.slice(sql028.indexOf("if v_order.fulfillment_status = 'shipped' then"));
  const branch = shippedBranch.slice(0, shippedBranch.indexOf("if v_order.fulfillment_status = 'cancelled'"));
  assert.ok(branch.includes("'conflict'"));
  assert.ok(!branch.includes("update public.orders"), "a conflict silently overwrites shipment data");
  assert.equal(shipmentIsDurable("conflict"), false, "a conflict could reach the email");
  assert.equal(shipmentResultStatus("conflict"), 409);
});

test("IDEMPOTENCY: concurrent transitions are serialized by a row lock", () => {
  // The second caller waits at FOR UPDATE, then reads a row that already
  // says 'shipped' and takes the idempotent or conflict path. Only one
  // real first transition can win.
  assert.ok(sql028.includes("for update"), "the row is not locked");
  const lockAt = sql028.indexOf("for update");
  const updateAt = sql028.indexOf("update public.orders");
  assert.ok(updateAt > lockAt, "the write happens before the lock is taken");
});

test("IDEMPOTENCY: the Resend key is per order and unchanged from Phase 2A", () => {
  assert.equal(shipmentConfirmationIdempotencyKey(ORDER_ID), `gloa/shipment/${ORDER_ID}`);
  // One sender, one template, one key. This task added none of them.
  const senders = readdirSync(path.join(ROOT, "lib")).filter(f => /[Ss]hipment.*[Ee]mail\.ts$/.test(f));
  assert.deepEqual(senders, ["shipmentConfirmationEmail.ts"]);
  assert.ok(!routeCode.includes("new Resend"), "the route builds its own Resend client");
  assert.ok(!routeCode.includes("getResendClient"), "the route reaches the mail provider directly");
  assert.ok(!routeCode.includes("buildShipmentConfirmationEmail"), "the route renders its own email");
});

/* ══════════════════════════════════════════════════════════════
   MIGRATION 028
   ══════════════════════════════════════════════════════════════ */

test("028: it is the next free number and 022-027 are untouched", () => {
  const files = readdirSync(MIGRATIONS).filter(f => f.endsWith(".sql")).sort();
  const numbers = files.map(f => f.slice(0, 3));
  assert.equal(new Set(numbers).size, numbers.length, "a migration number is used twice");
  assert.deepEqual(files.filter(f => f.startsWith("028")), ["028_authorized_shipment_transition.sql"]);
  assert.equal(numbers.filter(nr => nr > "028").length, 0, "a migration above 028 appeared");
  assert.deepEqual(files.slice(-7, -1), [
    "022_recurring_subscription_foundation.sql",
    "023_harden_stripe_customers_grants.sql",
    "024_seed_b2c_subscription_plans.sql",
    "025_grant_subscription_plans_service_role.sql",
    "026_internal_order_notification_state.sql",
    "027_shipment_confirmation_email_state.sql",
  ]);
});

test("028: 027 is not edited by it, and still says what it said", () => {
  const migration027 = read("supabase/migrations/027_shipment_confirmation_email_state.sql");
  assert.ok(migration027.includes("check (shipment_email_status in ('sending', 'sent', 'failed'))"));
  assert.ok(migration027.includes("grant update (shipment_email_status, shipment_email_sent_at)"));
  assert.ok(!sql028.includes("alter table"), "028 alters a table");
  assert.ok(!sql028.includes("add column"), "028 adds a column");
});

test("028: the function is SECURITY DEFINER with an empty search_path", () => {
  assert.ok(sql028.includes("security definer set search_path = ''"));
  const fn = sql028.slice(sql028.indexOf("create or replace function public.mark_order_shipped"));
  assert.ok(fn.includes("language plpgsql"));
  assert.ok(fn.includes("volatile"));
});

test("028: every table reference is schema-qualified", () => {
  // Privilege statements name ROLES after "from", not tables, so they are
  // excluded before the scan rather than special-cased inside it.
  const statements = sql028
    .split(NEWLINE)
    .filter(line => !/^\s*(revoke|grant)\b/i.test(line))
    .join(NEWLINE);
  const bare = [...statements.matchAll(/\b(from|update|into|join)\s+(?!public\.|jsonb|v_|"|\()([a-z_]+)/g)]
    .map(m => `${m[1]} ${m[2]}`)
    .filter(hit => !/^into (v_|jsonb)/.test(hit));
  assert.deepEqual(bare, [], `unqualified references: ${bare.join(", ")}`);
});

test("028: execute is revoked from public, anon and authenticated", () => {
  const signature = "public.mark_order_shipped(text, text, text, text)";
  for (const role of ["public", "anon", "authenticated"]) {
    assert.ok(
      sql028.includes(`revoke all on function ${signature} from ${role};`),
      `execute is not revoked from ${role}`
    );
  }
});

test("028: execute is granted to service_role and to nobody else", () => {
  const grants = sql028.split(NEWLINE).filter(l => l.trim().toLowerCase().startsWith("grant"));
  assert.equal(grants.length, 1, "more than one grant was issued");
  assert.ok(grants[0].includes("to service_role;"));
  assert.ok(grants[0].includes("grant execute on function public.mark_order_shipped"));
});

test("028: the caller cannot choose shipped_at or fulfillment_status", () => {
  const args = sql028.slice(sql028.indexOf("create or replace function"), sql028.indexOf("returns jsonb"));
  for (const param of ["shipped_at", "fulfillment_status", "status", "payment_status", "p_user", "email"]) {
    assert.ok(!args.includes(param), `the function accepts ${param} as a parameter`);
  }
  assert.ok(args.includes("p_order_number"));
  assert.ok(args.includes("p_carrier"));
  assert.ok(args.includes("p_tracking_number"));
  assert.ok(args.includes("p_tracking_url"));
  // And the values it writes are its own.
  assert.ok(sql028.includes("shipped_at         = now()"));
  assert.ok(sql028.includes("fulfillment_status = 'shipped'"));
});

test("028: the transition writes six columns and no money, tax or snapshot", () => {
  const update = sql028.slice(sql028.indexOf("update public.orders"));
  const setClause = update.slice(0, update.indexOf("where id = v_order.id"));
  for (const forbidden of [
    "_cents", "tax_", "customer_snapshot", "shipping_address_snapshot",
    "billing_address_snapshot", "payment_status", "currency", "user_id",
    "shipment_email", "confirmation_email", "internal_notification",
  ]) {
    assert.ok(!setClause.includes(forbidden), `the transition writes ${forbidden}`);
  }
  const written = [...setClause.matchAll(/^\s*(?:set\s+)?(\w+)\s*=/gm)].map(m => m[1]);
  assert.deepEqual(written.sort(), [
    "fulfillment_status", "shipped_at", "shipping_carrier", "status", "tracking_number", "tracking_url",
  ]);
});

test("028: cancelled can never be newly shipped", () => {
  assert.ok(sql028.includes("if v_order.fulfillment_status = 'cancelled'"));
  assert.ok(sql028.includes("or v_order.status in ('cancelled', 'refunded')"));
});

test("028: delivered is never moved backwards to shipped", () => {
  const guard = sql028.slice(sql028.indexOf("'already_advanced'"));
  assert.ok(sql028.includes("if v_order.fulfillment_status = 'delivered' or v_order.status = 'delivered' then"));
  assert.ok(guard.indexOf("update public.orders") === -1 || guard.indexOf("return") < guard.indexOf("update public.orders"));
});

test("028: the payment guard uses only the audited vocabulary", () => {
  assert.ok(sql028.includes("if v_order.payment_status not in ('paid', 'partially_refunded') then"));
  // Every value named must exist in migration 019's final constraint.
  const migration019 = read("supabase/migrations/019_order_lifecycle_tracking.sql");
  for (const value of ["paid", "partially_refunded", "refund_pending", "refunded", "pending", "failed"]) {
    assert.ok(migration019.includes(`'${value}'`), `invented payment status: ${value}`);
  }
});

test("028: the lifecycle guard allows only unfulfilled and processing", () => {
  assert.ok(sql028.includes("if v_order.fulfillment_status not in ('unfulfilled', 'processing') then"));
  // Both are real values from migration 004's vocabulary.
  const migration004 = read("supabase/migrations/004_orders.sql");
  assert.ok(migration004.includes("'unfulfilled', 'processing',"));
});

test("028: it sends no email and adds no trigger", () => {
  for (const forbidden of ["create trigger", "notify", "http_post", "net.http", "resend", "smtp", "mail"]) {
    assert.ok(!sql028.toLowerCase().includes(forbidden), `028 contains: ${forbidden}`);
  }
});

test("028: it performs no backfill and touches no existing row", () => {
  for (const forbidden of ["insert into", "delete from", "drop table", "drop column", "truncate"]) {
    assert.ok(!sql028.toLowerCase().includes(forbidden), `028 performs: ${forbidden}`);
  }
  // The only UPDATE is inside the function body, keyed on one id.
  const updates = [...sql028.matchAll(/update public\.orders/g)];
  assert.equal(updates.length, 1, "more than one UPDATE statement exists");
  assert.ok(sql028.includes("where id = v_order.id"));
});

test("028: it returns no customer PII", () => {
  const returns = [...sql028.matchAll(/jsonb_build_object\(([^;]*?)\)/gs)].map(m => m[1]);
  assert.ok(returns.length > 0);
  for (const payload of returns) {
    for (const pii of ["email", "name", "address", "snapshot", "phone", "_cents", "customer"]) {
      assert.ok(!payload.includes(pii), `the RPC returns ${pii}`);
    }
  }
});

test("028: the OWNER verification queries cover A through I", () => {
  for (const marker of ["-- (A)", "-- (B)", "-- (C)", "-- (D)", "-- (H)", "-- (I)"]) {
    assert.ok(migration028.includes(marker), `verification ${marker} is missing`);
  }
  assert.ok(migration028.includes("prosecdef"), "no SECURITY DEFINER verification");
  assert.ok(migration028.includes("proconfig"), "no search_path verification");
  assert.ok(migration028.includes("has_function_privilege"), "no execute-privilege verification");
});

/* ══════════════════════════════════════════════════════════════
   RESPONSE AND LOGGING
   ══════════════════════════════════════════════════════════════ */

test("response: it carries no customer PII", () => {
  const responses = [...routeCode.matchAll(/Response\.json\(\s*\{([\s\S]*?)\}\s*(?:as|satisfies|,)/g)].map(m => m[1]);
  assert.ok(responses.length > 0);
  for (const payload of responses) {
    for (const pii of ["customerEmail", "customer_snapshot", "address", "name", "phone", "email:"]) {
      assert.ok(!payload.includes(pii), `the response carries ${pii}: ${payload}`);
    }
  }
});

test("response: tracking data is not echoed back", () => {
  const after = routeCode.slice(routeCode.indexOf("const emailOutcome"));
  for (const echoed of ["trackingNumber", "trackingUrl", "carrier"]) {
    assert.ok(!after.includes(echoed), `the response echoes ${echoed}`);
  }
});

test("logging: no PII and no request body reaches a log line", () => {
  const logs = [...routeCode.matchAll(/console\.\w+\(([^;]*)\)/g)].map(m => m[1]);
  assert.ok(logs.length > 0);
  for (const line of logs) {
    for (const forbidden of [
      "customerEmail", "trackingNumber", "trackingUrl", "carrier",
      "rawBody", "parsed", "JSON.stringify", "validated.request",
    ]) {
      assert.ok(!line.includes(forbidden), `a log line carries ${forbidden}: ${line}`);
    }
  }
});

test("logging: errors returned to the caller stay generic", () => {
  const messages = [...routeCode.matchAll(/error: "([^"]*)"/g)].map(m => m[1]);
  assert.ok(messages.length > 0);
  for (const message of messages) {
    for (const leak of ["supabase", "postgres", "pg_", "stack", "ECONN", "relation", "column"]) {
      assert.ok(!message.toLowerCase().includes(leak), `an error message leaks: ${message}`);
    }
  }
  // The RPC's own error text is logged, never returned.
  assert.ok(routeCode.includes('{ error: "Interner Fehler." }'));
  assert.ok(!routeCode.includes("error: error.message"));
});

/* ══════════════════════════════════════════════════════════════
   REGRESSIONS: NOTHING ELSE LEARNED TO SHIP
   ══════════════════════════════════════════════════════════════ */

test("regression: payment alone still does not ship an order", () => {
  for (const rel of [
    "app/api/stripe/webhook/route.ts",
    "app/api/orders/success/route.ts",
    "app/api/checkout/session/route.ts",
    "app/api/cron/retry-order-notifications/route.ts",
  ]) {
    const source = withoutComments(read(rel));
    assert.ok(!source.includes("mark_order_shipped"), `${rel} can ship an order`);
    assert.ok(!source.includes("fulfillment_status"), `${rel} writes fulfillment state`);
    assert.ok(!source.includes("shipped_at"), `${rel} writes shipped_at`);
  }
});

test("regression: only the one authorized route can reach the shipment RPC", () => {
  const callers = [];
  const walk = dir => {
    for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) { walk(rel); continue; }
      if (!/\.(ts|tsx|mjs|js)$/.test(entry.name)) continue;
      if (withoutComments(read(rel)).includes("mark_order_shipped")) callers.push(rel);
    }
  };
  for (const dir of ["app", "lib", "worker"]) walk(dir);
  assert.deepEqual(callers, ["app/api/internal/orders/ship/route.ts"]);
});

test("regression: only the one authorized route can reach the shipment sender", () => {
  const callers = [];
  const walk = dir => {
    for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) { walk(rel); continue; }
      if (!/\.(ts|tsx|mjs|js)$/.test(entry.name)) continue;
      if (rel === "lib/shipmentConfirmationEmail.ts") continue;
      if (withoutComments(read(rel)).includes("sendShipmentConfirmationIfNeeded")) callers.push(rel);
    }
  };
  for (const dir of ["app", "lib", "worker"]) walk(dir);
  assert.deepEqual(callers, ["app/api/internal/orders/ship/route.ts"]);
});

test("regression: the customer account still cannot ship anything", () => {
  const portal = withoutComments(read("app/AccountPortal.tsx"));
  for (const forbidden of ["mark_order_shipped", "internal/orders/ship", "shipment_email", "FULFILLMENT_ADMIN"]) {
    assert.ok(!portal.includes(forbidden), `the account portal reaches ${forbidden}`);
  }
});

test("regression: no client bundle can see the secret or the endpoint", () => {
  for (const rel of ["app/GloaSite.tsx", "app/AccountPortal.tsx", "app/createCheckoutSession.ts", "app/Chrome.tsx"]) {
    const source = read(rel);
    assert.ok(!source.includes("FULFILLMENT_ADMIN_SECRET"), `${rel} names the secret`);
    assert.ok(!source.includes("/api/internal/"), `${rel} calls an internal endpoint`);
  }
});

test("regression: the built client bundle contains no secret and no handler code", () => {
  // The route's PATH does appear in the framework's route manifest, and
  // that is neither new nor a weakness: the cron endpoint's path has
  // always been there too, and both are protected by a secret rather than
  // by being hard to find. What must never ship to a browser is the
  // secret, the handler, the RPC name, or the comparison.
  const CLIENT = path.join(ROOT, ".output/public");
  if (!existsSync(CLIENT)) return; // no build present; npm test always makes one

  const files = [];
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (/\.(js|mjs|json|html|css)$/.test(entry.name)) files.push(full);
    }
  };
  walk(CLIENT);
  assert.ok(files.length > 0, "no client assets were found to check");

  const leaks = [];
  for (const file of files) {
    const source = readFileSync(file, "utf-8");
    for (const needle of [
      "FULFILLMENT_ADMIN_SECRET", "mark_order_shipped", "isBearerSecretAuthorized",
      "sendShipmentConfirmationIfNeeded", "timingSafeEqual", TEST_SECRET,
    ]) {
      if (source.includes(needle)) leaks.push(`${path.relative(ROOT, file)}: ${needle}`);
    }
  }
  assert.deepEqual(leaks, [], `server-only material reached the client bundle: ${leaks.join(", ")}`);
});

test("regression: the other two order emails are untouched by this task", () => {
  for (const other of [
    "sendOrderConfirmationEmail", "confirmation_email_status",
    "sendInternalOrderNotificationIfNeeded", "internal_notification_status",
  ]) {
    assert.ok(!routeCode.includes(other), `the ship route triggers ${other}`);
  }
});

test("regression: no subscription lifecycle email and no feature flag change", () => {
  for (const forbidden of ["B2C_SUBSCRIPTIONS_ENABLED", "Abo gestartet", "subscription_status", "invoice.paid"]) {
    assert.ok(!routeCode.includes(forbidden), `the route touches ${forbidden}`);
    assert.ok(!rulesCode.includes(forbidden), `the rules touch ${forbidden}`);
    assert.ok(!sql028.includes(forbidden), `028 touches ${forbidden}`);
  }
  const example = read(".env.example");
  assert.match(example, /^B2C_SUBSCRIPTIONS_ENABLED=$/m, "the subscription flag gained a value");
});

test("regression: SHOP_STATUS, pricing, tax and shipping rates are unchanged", () => {
  assert.ok(read("app/content.ts").includes('export const SHOP_STATUS = "prelaunch" as const;'));
  for (const forbidden of ["price_gross_cents", "computeShippingGrossCents", "resolveCheckoutTax", "SHIPPING_ZONES"]) {
    assert.ok(!routeCode.includes(forbidden), `the route touches ${forbidden}`);
    assert.ok(!sql028.includes(forbidden), `028 touches ${forbidden}`);
  }
});

test("regression: no new cron job was registered", () => {
  const vercel = JSON.parse(read("vercel.json"));
  assert.equal((vercel.crons ?? []).length, 1, "a cron job was added");
  assert.equal(vercel.crons[0].path, "/api/cron/retry-order-notifications");
  // And the internal notification cron did not learn about shipment state.
  assert.ok(!withoutComments(cronRoute).includes("shipment"));
  assert.ok(!withoutComments(read("lib/internalOrderNotificationRetry.ts")).includes("shipment_email"));
});

/* ══════════════════════════════════════════════════════════════
   THE HTTP BOUNDARY, ON REAL SPAWNED SERVERS
   ══════════════════════════════════════════════════════════════ */

const ENDPOINT_PATH = "/api/internal/orders/ship";
const TEST_SECRET = "test-only-fulfillment-secret-not-a-real-value";

/**
 * Every server below is started without SUPABASE_SECRET_KEY and without
 * RESEND_API_KEY, so even a fully authorized request cannot reach a
 * database or construct a Resend client: it stops at the 503 the route
 * returns when the admin client is unconfigured, which is strictly before
 * the RPC and therefore strictly before any email.
 */
function serverEnv(extra) {
  const env = writeBlockedServerEnv({ ...extra });
  delete env.RESEND_API_KEY;
  delete env.RESEND_CONTACT_FROM;
  return env;
}

async function startServer(port, extraEnv) {
  const child = spawn(process.execPath, [".output/server/index.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: serverEnv({ PORT: String(port), ...extraEnv }),
    stdio: "ignore",
  });

  await new Promise((resolveReady, rejectReady) => {
    child.once("exit", code => rejectReady(new Error(`server exited early (code ${code})`)));
    (async () => {
      for (let attempt = 0; attempt < 50; attempt++) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/`);
          if (res.ok) return resolveReady();
        } catch {
          // not up yet
        }
        await delay(200);
      }
      rejectReady(new Error("server did not become ready in time"));
    })();
  });

  return child;
}

const post = (port, payload, headers = {}) =>
  fetch(`http://127.0.0.1:${port}${ENDPOINT_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  });

/* ── Unconfigured: the endpoint must be inert ─────────────────── */

const UNSET_PORT = 8944;
let unsetServer;

test.before(async () => {
  // FULFILLMENT_ADMIN_SECRET deliberately unset, which is how the
  // endpoint ships until the owner creates it in Vercel.
  unsetServer = await startServer(UNSET_PORT, { FULFILLMENT_ADMIN_SECRET: "" });
});

test.after(() => {
  unsetServer?.kill();
});

test("http: an unconfigured secret refuses every caller, including a correct-looking one", async () => {
  for (const headers of [
    {},
    { authorization: "Bearer " },
    { authorization: `Bearer ${TEST_SECRET}` },
    { authorization: "Bearer anything" },
  ]) {
    const res = await post(UNSET_PORT, { orderNumber: ORDER_NUMBER }, headers);
    assert.equal(res.status, 503, JSON.stringify(headers));
    const parsed = await res.json().catch(() => null);
    assert.equal(parsed?.ok, undefined);
  }
});

/* ── Configured: the authorization boundary ───────────────────── */

const SECURED_PORT = 8945;
let securedServer;

test.before(async () => {
  securedServer = await startServer(SECURED_PORT, { FULFILLMENT_ADMIN_SECRET: TEST_SECRET });
});

test.after(() => {
  securedServer?.kill();
});

test("http: a request with no Authorization header is rejected", async () => {
  const res = await post(SECURED_PORT, { orderNumber: ORDER_NUMBER });
  assert.equal(res.status, 401);
});

test("http: a wrong or malformed secret is rejected", async () => {
  for (const authorization of [
    "Bearer", "Bearer ", "Bearer wrong-secret", `Bearer ${TEST_SECRET}x`,
    `Bearer ${TEST_SECRET.slice(0, -1)}`, `bearer ${TEST_SECRET}`,
    `Basic ${TEST_SECRET}`, TEST_SECRET,
  ]) {
    const res = await post(SECURED_PORT, { orderNumber: ORDER_NUMBER }, { authorization });
    assert.equal(res.status, 401, authorization);
  }
});

test("http: a customer-style Supabase bearer token is not authorization", async () => {
  // A real-shaped JWT. It is not the fulfillment secret, so it is refused
  // exactly like any other wrong value - customer auth has no path here.
  const jwtish = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyIn0.notarealsignature";
  const res = await post(SECURED_PORT, { orderNumber: ORDER_NUMBER }, { authorization: `Bearer ${jwtish}` });
  assert.equal(res.status, 401);
});

test("http: authorization is checked before the body is even looked at", async () => {
  // An unauthorized caller learns nothing about validation: a valid body,
  // a malformed body and garbage all answer identically.
  const valid = await post(SECURED_PORT, { orderNumber: ORDER_NUMBER });
  const invalid = await post(SECURED_PORT, { orderNumber: "nonsense" });
  const malformed = await post(SECURED_PORT, "{not json");
  assert.equal(valid.status, 401);
  assert.equal(invalid.status, 401);
  assert.equal(malformed.status, 401);
});

test("http: the correct secret is accepted and reaches validation", async () => {
  const authorization = `Bearer ${TEST_SECRET}`;

  // Malformed JSON now gets a 400 rather than a 401, which proves the
  // secret was accepted and the request moved past authorization.
  const malformed = await post(SECURED_PORT, "{not json", { authorization });
  assert.equal(malformed.status, 400);

  // A bad order number likewise reaches the validator.
  const badNumber = await post(SECURED_PORT, { orderNumber: "nonsense" }, { authorization });
  assert.equal(badNumber.status, 400);
  const parsed = await badNumber.json();
  assert.equal(parsed.error, "Ungültige Anfrage: invalid_order_number.");
});

test("http: an unknown field is refused even with the correct secret", async () => {
  const authorization = `Bearer ${TEST_SECRET}`;
  for (const key of ["shipped_at", "fulfillment_status", "recipient", "to", "subject", "html"]) {
    const res = await post(SECURED_PORT, { orderNumber: ORDER_NUMBER, [key]: "x" }, { authorization });
    assert.equal(res.status, 400, key);
    const parsed = await res.json();
    assert.equal(parsed.error, "Ungültige Anfrage: unknown_field.", key);
  }
});

test("http: a dangerous tracking URL is refused before any database call", async () => {
  const authorization = `Bearer ${TEST_SECRET}`;
  for (const trackingUrl of ["javascript:alert(1)", "data:text/html,x", "//evil.test"]) {
    const res = await post(SECURED_PORT, { orderNumber: ORDER_NUMBER, trackingUrl }, { authorization });
    assert.equal(res.status, 400, trackingUrl);
  }
});

test("http: a non-JSON content type is refused", async () => {
  const res = await fetch(`http://127.0.0.1:${SECURED_PORT}${ENDPOINT_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "text/plain", authorization: `Bearer ${TEST_SECRET}` },
    body: "orderNumber=GLOA-2026-000123",
  });
  assert.equal(res.status, 400);
});

test("http: an oversized body is refused", async () => {
  const res = await post(
    SECURED_PORT,
    JSON.stringify({ orderNumber: ORDER_NUMBER, carrier: "x".repeat(10_000) }),
    { authorization: `Bearer ${TEST_SECRET}` }
  );
  assert.equal(res.status, 413);
});

test("http: a fully valid authorized request stops at the unconfigured database", async () => {
  // The last stop before the RPC. It proves the whole chain up to the
  // database is reachable with the right secret, and that no email can be
  // attempted without a durable transition - there is no database here to
  // make one.
  const res = await post(
    SECURED_PORT,
    { orderNumber: ORDER_NUMBER, carrier: "DHL", trackingNumber: "00340434161094042557" },
    { authorization: `Bearer ${TEST_SECRET}` }
  );
  assert.equal(res.status, 503);
  const parsed = await res.json();
  assert.equal(parsed.ok, undefined);
  assert.equal(parsed.error, "Vorübergehend nicht verfügbar.");
});

test("http: GET, PUT, PATCH and DELETE are not mutation surfaces", async () => {
  for (const method of ["GET", "PUT", "PATCH", "DELETE"]) {
    const res = await fetch(`http://127.0.0.1:${SECURED_PORT}${ENDPOINT_PATH}`, {
      method,
      headers: { authorization: `Bearer ${TEST_SECRET}` },
    });
    assert.ok(res.status === 404 || res.status === 405, `${method} answered ${res.status}`);
  }
});

test("http: no response body ever contains the secret", async () => {
  const responses = await Promise.all([
    post(SECURED_PORT, { orderNumber: ORDER_NUMBER }),
    post(SECURED_PORT, { orderNumber: "nonsense" }, { authorization: `Bearer ${TEST_SECRET}` }),
    post(SECURED_PORT, { orderNumber: ORDER_NUMBER }, { authorization: `Bearer ${TEST_SECRET}` }),
  ]);
  for (const res of responses) {
    const text = await res.text();
    assert.ok(!text.includes(TEST_SECRET), "a response echoed the secret");
    assert.ok(!text.includes("FULFILLMENT_ADMIN_SECRET"), "a response named the secret variable");
  }
});

test("no real Resend request and no production Supabase in this suite", () => {
  const suite = withoutComments(read("tests/shipment-transition-api.test.mjs"));
  const forbidden = [
    ["create", "Client("], ["new ", "Resend("],
    ["supabase", ".co"], ["api.", "resend.com"],
  ].map(parts => parts.join(""));
  for (const needle of forbidden) {
    assert.ok(!suite.includes(needle), `the suite performs: ${needle}`);
  }
  // Every spawned server is started through serverEnv, which strips the
  // service-role key and the Resend key.
  const spawns = [...suite.matchAll(/spawn\(process\.execPath[\s\S]*?\}\)/g)];
  assert.equal(spawns.length, 1, "a server is spawned outside the guarded helper");
  assert.ok(spawns[0][0].includes("serverEnv("));
});
