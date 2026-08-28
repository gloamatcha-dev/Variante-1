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
  CANCELLATION_RESULTS,
  ORDER_NUMBER_RE,
  cancellationIsDurable,
  cancellationResultStatus,
  cancellationWasNewlyApplied,
  isCancellationResult,
  validateCancellationRequest,
} from "../lib/orderCancellationRules.ts";
import { ORDER_NUMBER_RE as SHIPMENT_ORDER_NUMBER_RE } from "../lib/shipmentTransitionRules.ts";
import { isBearerSecretAuthorized } from "../lib/serverSecretAuth.ts";
import {
  getCancellationView,
  getLifecycleSteps,
  getPrimaryStatusLabel,
  getRefundView,
  getStatusDetailText,
} from "../lib/orderStatus.ts";

// SAFE DEFAULT SUITE: pure request/result logic, source-level checks, and
// real spawned servers started WITHOUT a Supabase service-role key and
// WITHOUT a Resend key. No database is reachable, no production row can
// be read or written, no order is cancelled, no Stripe API is called, no
// refund is created and no email of any kind is sent. Nothing here
// executes SQL.
//
// The rule this suite protects: only an authorized operator can cancel an
// order, the database decides what cancelling means, cancelling is not
// refunding, and a cancellation can never move an order backwards out of
// shipped or delivered.

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf-8");
const NEWLINE = String.fromCharCode(10);

const MIGRATIONS = path.join(ROOT, "supabase/migrations");
const route = read("app/api/internal/orders/cancel/route.ts");
const rules = read("lib/orderCancellationRules.ts");
const shipRoute = read("app/api/internal/orders/ship/route.ts");
const requestRoute = read("app/api/orders/cancellation-request/route.ts");
const migration029 = read("supabase/migrations/029_authorized_order_cancellation.sql");

const withoutComments = source => source
  .split(NEWLINE)
  .filter(line => {
    const t = line.trim();
    return !t.startsWith("--") && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
  })
  .join(NEWLINE);

const routeCode = withoutComments(route);
const rulesCode = withoutComments(rules);
const sql029 = withoutComments(migration029);

/**
 * The handler body only, with imports excluded.
 *
 * Ordering assertions have to run against this rather than the whole
 * file: an `import { getSupabaseAdmin }` line sits at position 0 and
 * would make every "X happens after authorization" check trivially false
 * for reasons that have nothing to do with the runtime order.
 */
const routeBody = routeCode.slice(routeCode.indexOf("export async function POST"));

const ORDER_NUMBER = "GLOA-2026-000451";

const body = (overrides = {}) => ({ orderNumber: ORDER_NUMBER, ...overrides });

/** A complete OrderLifecycleFields row, for the account-UI assertions. */
const order = (overrides = {}) => ({
  status: "confirmed",
  payment_status: "paid",
  fulfillment_status: "unfulfilled",
  total_gross_cents: 4990,
  refunded_total_cents: null,
  shipping_carrier: null,
  tracking_number: null,
  tracking_url: null,
  shipped_at: null,
  cancellation_requested_at: null,
  ...overrides,
});

/* ══════════════════════════════════════════════════════════════
   INPUT VALIDATION
   ══════════════════════════════════════════════════════════════ */

test("input: a minimal valid request normalizes to one order number", () => {
  const result = validateCancellationRequest(body());
  assert.equal(result.ok, true);
  assert.deepEqual(result.request, { orderNumber: ORDER_NUMBER });
});

test("input: the allow-list is exactly one key", () => {
  assert.deepEqual([...ALLOWED_BODY_KEYS], ["orderNumber"]);
});

test("input: a non-object body is rejected", () => {
  for (const bad of [null, undefined, "string", 42, true, []]) {
    const result = validateCancellationRequest(bad);
    assert.equal(result.ok, false, JSON.stringify(bad));
    assert.equal(result.code, "invalid_body");
  }
});

test("input: a missing order number is rejected", () => {
  const result = validateCancellationRequest({});
  assert.equal(result.ok, false);
  assert.equal(result.code, "invalid_order_number");
});

test("input: a malformed order number is rejected", () => {
  for (const bad of [
    "", "   ", "GLOA-2026-12345", "GLOA-2026-1234567", "GLOA-26-000451",
    "gloa-2026", "000451", "GLOA-2026-00045A", "DROP TABLE orders",
    "GLOA-2026-000451 OR 1=1", "GLOA-2026-000451; delete from orders",
    42, null, {}, [], true,
  ]) {
    const result = validateCancellationRequest({ orderNumber: bad });
    assert.equal(result.ok, false, String(bad));
    assert.equal(result.code, "invalid_order_number", String(bad));
  }
});

test("input: the order number regex matches what generate_order_number builds", () => {
  // public.generate_order_number: 'GLOA-' || YYYY || '-' || lpad(seq, 6, '0')
  assert.ok(ORDER_NUMBER_RE.test("GLOA-2026-000001"));
  assert.ok(ORDER_NUMBER_RE.test("GLOA-2026-999999"));
  assert.ok(ORDER_NUMBER_RE.test("GLOA-2030-000451"));
  assert.ok(read("supabase/migrations/004_orders.sql")
    .includes("lpad(nextval('public.order_number_seq')::text, 6, '0')"));
});

test("input: the duplicated order-number regex has not drifted from the shipment module", () => {
  // lib/orderCancellationRules.ts is a leaf and duplicates the pattern
  // rather than importing it. This is the assertion that keeps the two
  // copies identical.
  assert.equal(ORDER_NUMBER_RE.source, SHIPMENT_ORDER_NUMBER_RE.source);
  assert.equal(ORDER_NUMBER_RE.flags, SHIPMENT_ORDER_NUMBER_RE.flags);
});

test("input: an order number is trimmed and upper-cased, never otherwise rewritten", () => {
  const result = validateCancellationRequest({ orderNumber: "  gloa-2026-000451  " });
  assert.equal(result.ok, true);
  assert.equal(result.request.orderNumber, ORDER_NUMBER);
});

test("input: an unknown field is refused, never ignored", () => {
  for (const key of ["reason", "note", "carrier", "trackingNumber", "force", "confirm"]) {
    const result = validateCancellationRequest(body({ [key]: "x" }));
    assert.equal(result.ok, false, key);
    assert.equal(result.code, "unknown_field", key);
  }
});

test("input: the caller cannot supply any lifecycle, payment or refund value", () => {
  // Each of these is either computed by the RPC or never written at all.
  // Sending one is a refusal, so an operator can never believe they set
  // something they did not.
  for (const key of [
    "status", "fulfillment_status", "payment_status", "cancelled_at", "cancelledAt",
    "refunded_total_cents", "refundAmount", "refund_amount", "refund_updated_at",
    "shipped_at", "tracking_url", "total_gross_cents", "currency",
  ]) {
    const result = validateCancellationRequest(body({ [key]: "cancelled" }));
    assert.equal(result.ok, false, key);
    assert.equal(result.code, "unknown_field", key);
  }
});

test("input: the caller cannot supply a customer identity or a recipient", () => {
  for (const key of [
    "userId", "user_id", "email", "customerEmail", "customer_snapshot",
    "recipient", "to", "subject", "html", "orderId", "id",
  ]) {
    const result = validateCancellationRequest(body({ [key]: "x" }));
    assert.equal(result.ok, false, key);
    assert.equal(result.code, "unknown_field", key);
  }
});

test("input: an unknown field is refused even when the order number is also bad", () => {
  const result = validateCancellationRequest({ orderNumber: "nonsense", cancelled_at: "2026-01-01" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "unknown_field");
});

test("input: there is no reason parameter anywhere in this feature", () => {
  // The customer's own words live in migration 019's
  // cancellation_request_note. An operator-side reason has no reader, so
  // it is deliberately not accepted, not stored and not returned.
  assert.ok(!rulesCode.includes("reason"));
  assert.ok(!routeCode.includes("reason"));
  assert.ok(!sql029.includes("reason"));
  assert.ok(!sql029.includes("p_reason"));
});

/* ══════════════════════════════════════════════════════════════
   RESULT VOCABULARY
   ══════════════════════════════════════════════════════════════ */

test("results: the vocabulary is exactly the four the migration returns", () => {
  assert.deepEqual([...CANCELLATION_RESULTS].sort(), [
    "already_cancelled", "cancelled", "not_cancellable", "not_found",
  ]);
  for (const result of CANCELLATION_RESULTS) {
    assert.ok(sql029.includes(`'${result}'`), `029 never returns ${result}`);
  }
});

test("results: only cancelled and already_cancelled are durable", () => {
  assert.equal(cancellationIsDurable("cancelled"), true);
  assert.equal(cancellationIsDurable("already_cancelled"), true);
  assert.equal(cancellationIsDurable("not_cancellable"), false);
  assert.equal(cancellationIsDurable("not_found"), false);
});

test("results: only a first transition counts as newly applied", () => {
  assert.equal(cancellationWasNewlyApplied("cancelled"), true);
  assert.equal(cancellationWasNewlyApplied("already_cancelled"), false);
  assert.equal(cancellationWasNewlyApplied("not_cancellable"), false);
  assert.equal(cancellationWasNewlyApplied("not_found"), false);
});

test("results: each result maps to a sensible HTTP status", () => {
  assert.equal(cancellationResultStatus("cancelled"), 200);
  assert.equal(cancellationResultStatus("already_cancelled"), 200);
  assert.equal(cancellationResultStatus("not_found"), 404);
  assert.equal(cancellationResultStatus("not_cancellable"), 409);
});

test("results: an unrecognized RPC result is refused, never guessed at", () => {
  for (const bad of [
    "shipped", "conflict", "refunded", "", null, undefined, 42, {}, ["cancelled"],
  ]) {
    assert.equal(isCancellationResult(bad), false, JSON.stringify(bad));
  }
  for (const good of CANCELLATION_RESULTS) assert.equal(isCancellationResult(good), true);
});

test("results: the route refuses an unknown result rather than reporting success", () => {
  const guard = routeCode.indexOf("isCancellationResult(payload.result)");
  const durable = routeCode.indexOf("cancellationIsDurable(result)");
  assert.ok(guard > -1, "the route does not validate the RPC result");
  assert.ok(guard < durable, "the result is used before it is validated");
});

test("results: there is no conflict result, because a cancellation carries no data", () => {
  assert.ok(!CANCELLATION_RESULTS.includes("conflict"));
  assert.ok(!sql029.includes("'conflict'"));
});

/* ══════════════════════════════════════════════════════════════
   AUTHORIZATION
   ══════════════════════════════════════════════════════════════ */

const SECRET = "test-only-cancellation-secret-not-a-real-value";

const withHeader = value => new Request("https://gloamatcha.com/api/internal/orders/cancel", {
  method: "POST",
  headers: value === null ? {} : { authorization: value },
});

test("auth: an empty secret authorizes nobody, whatever the header says", () => {
  for (const header of [null, "", "Bearer ", "Bearer anything", `Bearer ${SECRET}`]) {
    assert.equal(isBearerSecretAuthorized(withHeader(header), ""), false, String(header));
  }
});

test("auth: a missing, wrong or malformed header is rejected", () => {
  for (const header of [
    null, "", "Bearer", "Bearer ", "Bearer wrong", `Bearer ${SECRET}x`,
    `Bearer ${SECRET.slice(0, -1)}`, `bearer ${SECRET}`, `Basic ${SECRET}`, SECRET,
    `Bearer  ${SECRET}`,
  ]) {
    assert.equal(isBearerSecretAuthorized(withHeader(header), SECRET), false, String(header));
  }
});

test("auth: exactly the right header is accepted", () => {
  assert.equal(isBearerSecretAuthorized(withHeader(`Bearer ${SECRET}`), SECRET), true);
});

test("auth: the route uses the existing shared timing-safe helper", () => {
  assert.ok(route.includes('from "../../../../../lib/serverSecretAuth"'));
  assert.ok(routeCode.includes("isBearerSecretAuthorized(request, secret)"));
  // And it does not roll its own comparison.
  for (const forbidden of ["===  secret", "=== secret", "timingSafeEqual", "createHash", "localeCompare"]) {
    assert.ok(!routeCode.includes(forbidden), `the route compares secrets itself: ${forbidden}`);
  }
  // The helper itself is genuinely timing safe and length-blind.
  const helper = read("lib/serverSecretAuth.ts");
  assert.ok(helper.includes("timingSafeEqual"));
  assert.ok(helper.includes("createHash(\"sha256\")"));
});

test("auth: the route fails closed when CANCELLATION_ADMIN_SECRET is unset", () => {
  assert.ok(routeCode.includes("const secret = process.env.CANCELLATION_ADMIN_SECRET;"));
  const guard = routeBody.slice(routeBody.indexOf("if (!secret)"));
  assert.ok(guard.slice(0, 400).includes("status: 503"), "an unset secret does not refuse the request");
  // The refusal comes before the authorization check and before any parse.
  assert.ok(routeBody.indexOf("if (!secret)") < routeBody.indexOf("isBearerSecretAuthorized"));
  assert.ok(routeBody.indexOf("if (!secret)") < routeBody.indexOf("request.text()"));
});

test("auth: this endpoint READS only its own secret", () => {
  // The authoritative check: which environment variables the route
  // actually reads. Exactly one, and it is this endpoint's own.
  const names = [...routeCode.matchAll(/process\.env\.(\w+)/g)].map(m => m[1]);
  assert.deepEqual([...new Set(names)].sort(), ["CANCELLATION_ADMIN_SECRET"]);
  // And it never so much as names another endpoint's authorization
  // secret, so no edit can quietly start accepting one. SUPABASE_SECRET_KEY
  // is deliberately not on this list: the route NAMES it in one
  // diagnostic line about the admin client being unconfigured, exactly as
  // the shipment route does, and it does not read it - getSupabaseAdmin
  // does.
  for (const other of [
    "FULFILLMENT_ADMIN_SECRET", "CRON_SECRET", "RESEND_API_KEY",
    "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "VITE_",
  ]) {
    assert.ok(!routeCode.includes(other), `the cancel route names ${other}`);
  }
  assert.ok(!routeCode.includes("process.env.SUPABASE_SECRET_KEY"), "the route reads the service-role key itself");
});

test("auth: the shipment endpoint's secret cannot authorize a cancellation", () => {
  // Two different variables, read by two different routes. Neither names
  // the other, so no deployment can accidentally make one value work for
  // both endpoints.
  const shipCode = withoutComments(shipRoute);
  assert.ok(shipCode.includes("process.env.FULFILLMENT_ADMIN_SECRET"));
  assert.ok(!shipCode.includes("CANCELLATION_ADMIN_SECRET"));
  assert.ok(!routeCode.includes("FULFILLMENT_ADMIN_SECRET"));
  // And the cron's secret is a third, separate value.
  const cronCode = withoutComments(read("app/api/cron/retry-order-notifications/route.ts"));
  assert.ok(cronCode.includes("process.env.CRON_SECRET"));
  assert.ok(!cronCode.includes("CANCELLATION_ADMIN_SECRET"));
});

test("auth: all three operator endpoints share the helper and share no secret", () => {
  const sources = {
    "app/api/internal/orders/cancel/route.ts": "CANCELLATION_ADMIN_SECRET",
    "app/api/internal/orders/ship/route.ts": "FULFILLMENT_ADMIN_SECRET",
    "app/api/cron/retry-order-notifications/route.ts": "CRON_SECRET",
  };
  for (const [rel, own] of Object.entries(sources)) {
    const source = withoutComments(read(rel));
    assert.ok(source.includes("isBearerSecretAuthorized"), `${rel} does not use the shared helper`);
    const names = new Set([...source.matchAll(/process\.env\.(\w+)/g)].map(m => m[1]));
    const secrets = [...names].filter(n => n.endsWith("_SECRET") || n.endsWith("_KEY"));
    assert.deepEqual(secrets, [own], `${rel} reads a secret that is not its own`);
  }
});

test("auth: customer authentication alone cannot authorize this route", () => {
  for (const forbidden of ["verifyUser", "verifyUserId", "getUser", "access_token", "supabase.auth"]) {
    assert.ok(!routeCode.includes(forbidden), `the route imports customer auth: ${forbidden}`);
  }
  // The customer request endpoint is the one that uses customer auth, and
  // it is a REQUEST, not a cancellation.
  assert.ok(withoutComments(requestRoute).includes("verifyUserId(request)"));
});

test("auth: the secret's VALUE is never logged, returned or echoed", () => {
  const logs = [...routeCode.matchAll(/console\.(error|warn|log|info)\(([\s\S]*?)\);/g)].map(m => m[2]);
  assert.ok(logs.length > 0);
  for (const line of logs) {
    // The VARIABLE NAME may appear - "CANCELLATION_ADMIN_SECRET is not
    // configured" is the fail-closed diagnostic and logging the absence
    // of a secret is the point of it. The VALUE may not, in any form.
    assert.ok(!line.includes("${secret}"), `a log line interpolates the secret: ${line}`);
    assert.ok(!/\bsecret\b/.test(line), `a log line references the secret variable: ${line}`);
    for (const forbidden of ["authorization", "rawBody", "parsed", "payload", "req.headers"]) {
      assert.ok(!line.toLowerCase().includes(forbidden), `a log line contains ${forbidden}: ${line}`);
    }
  }
  // The value is never interpolated anywhere in the file, log or not.
  assert.ok(!routeCode.includes("${secret}"));
  assert.equal(routeCode.includes("headers.get(\"authorization\")"), false, "the route reads the header itself");
});

test("auth: the secret is documented in .env.example with no value", () => {
  const example = read(".env.example");
  assert.match(example, /^CANCELLATION_ADMIN_SECRET=$/m, "the secret is missing or has a value");
  assert.ok(example.includes("/api/internal/orders/cancel"));
  // The two neighbours are still empty too.
  assert.match(example, /^FULFILLMENT_ADMIN_SECRET=$/m);
  assert.match(example, /^CRON_SECRET=$/m);
});

test("auth: the secret is not in .env.local and not in any tracked file with a value", () => {
  if (existsSync(path.join(ROOT, ".env.local"))) {
    const local = read(".env.local");
    assert.ok(!local.includes("CANCELLATION_ADMIN_SECRET"), ".env.local defines the operator secret");
  }
  for (const rel of [".env.example", "vercel.json", "package.json"]) {
    const source = read(rel);
    // Same-line only: `\s*` would happily cross the newline and match the
    // next line's first character, turning an empty declaration into a
    // false positive.
    const withValue = source.match(/CANCELLATION_ADMIN_SECRET[^\S\r\n]*[=:][^\S\r\n]*\S/);
    assert.equal(withValue, null, `${rel} carries a value for the secret`);
  }
});

/* ══════════════════════════════════════════════════════════════
   THE ENDPOINT
   ══════════════════════════════════════════════════════════════ */

test("endpoint: it is POST only - there is no GET mutation", () => {
  const handlers = [...route.matchAll(/export async function (\w+)\(/g)].map(m => m[1]);
  assert.deepEqual(handlers, ["POST"]);
});

test("endpoint: the order number never travels in a query parameter", () => {
  for (const forbidden of ["searchParams", "new URL(request.url)", "request.url"]) {
    assert.ok(!routeCode.includes(forbidden), `the route reads ${forbidden}`);
  }
});

test("endpoint: the body is size-bounded before it is parsed", () => {
  assert.ok(routeCode.includes("MAX_BODY_BYTES"));
  assert.ok(routeCode.indexOf("rawBody.length > MAX_BODY_BYTES") < routeCode.indexOf("JSON.parse"));
  assert.ok(routeCode.includes("status: 413"));
});

test("endpoint: authorization happens before anything else is read", () => {
  const authAt = routeBody.indexOf("isBearerSecretAuthorized");
  assert.ok(authAt > -1);
  for (const later of [
    "request.headers.get(\"content-type\")", "request.text()", "JSON.parse",
    "validateCancellationRequest", "getSupabaseAdmin()", ".rpc(",
  ]) {
    const at = routeBody.indexOf(later);
    assert.ok(at > -1, `${later} does not appear in the handler`);
    assert.ok(authAt < at, `${later} runs before authorization`);
  }
});

test("endpoint: the route performs no table write of its own", () => {
  // Every write is inside the SECURITY DEFINER function. The route cannot
  // write these columns even if it tried: service_role holds no UPDATE
  // grant on status or fulfillment_status.
  for (const forbidden of [".update(", ".insert(", ".upsert(", ".delete(", "from(\"orders\")"]) {
    assert.ok(!routeCode.includes(forbidden), `the route performs a direct write: ${forbidden}`);
  }
  const rpcs = [...routeCode.matchAll(/\.rpc\("(\w+)"/g)].map(m => m[1]);
  assert.deepEqual(rpcs, ["cancel_order"]);
});

test("endpoint: the RPC receives the order number and nothing else", () => {
  const call = routeCode.slice(routeCode.indexOf('.rpc("cancel_order"'));
  const args = call.slice(0, call.indexOf("});"));
  assert.ok(args.includes("p_order_number: orderNumber"));
  const params = [...args.matchAll(/(p_\w+):/g)].map(m => m[1]);
  assert.deepEqual(params, ["p_order_number"]);
});

test("endpoint: a non-durable result is refused with a generic message", () => {
  assert.ok(routeCode.includes("if (!cancellationIsDurable(result))"));
  assert.ok(routeCode.includes("REFUSAL_MESSAGES[result]"));
  const messages = routeCode.slice(routeCode.indexOf("const REFUSAL_MESSAGES"));
  const block = messages.slice(0, messages.indexOf("};"));
  assert.ok(block.includes("not_found:"));
  assert.ok(block.includes("not_cancellable:"));
  // Two refusals, matching the two non-durable results exactly.
  assert.equal([...block.matchAll(/^\s+\w+:/gm)].length, 2);
});

/* ══════════════════════════════════════════════════════════════
   MIGRATION 029: NUMBERING AND IMMUTABILITY
   ══════════════════════════════════════════════════════════════ */

test("029: it owns its number and 022-028 are untouched", () => {
  // 029 was the next free number when it was written. Phase 2D-A has
  // since added 030 (internal cancellation request notification state),
  // so this asserts ownership and immutability rather than "nothing later
  // exists" - the same correction 028's suite already took when 029
  // arrived. What must stay true is that 029 is the ONLY 029, that the
  // seven migrations it was written on top of are still exactly those
  // seven files, and that no later migration redefines cancel_order.
  const files = readdirSync(MIGRATIONS).filter(f => f.endsWith(".sql")).sort();
  const numbers = files.map(f => f.slice(0, 3));
  assert.equal(new Set(numbers).size, numbers.length, "a migration number is used twice");
  assert.deepEqual(files.filter(f => f.startsWith("029")), ["029_authorized_order_cancellation.sql"]);
  const upTo029 = files.filter(f => f < "030");
  assert.deepEqual(upTo029.slice(-8), [
    "022_recurring_subscription_foundation.sql",
    "023_harden_stripe_customers_grants.sql",
    "024_seed_b2c_subscription_plans.sql",
    "025_grant_subscription_plans_service_role.sql",
    "026_internal_order_notification_state.sql",
    "027_shipment_confirmation_email_state.sql",
    "028_authorized_shipment_transition.sql",
    "029_authorized_order_cancellation.sql",
  ]);
  // No later migration may REDEFINE what 029 put live, and none may write
  // its columns. Calling cancel_order is explicitly allowed and is the
  // point: 031's resolution RPC delegates approval to it precisely so the
  // shipped/delivered guard is never restated anywhere else.
  for (const name of files.filter(f => f > "029_authorized_order_cancellation.sql")) {
    const later = withoutComments(readFileSync(path.join(MIGRATIONS, name), "utf-8"));
    assert.ok(!later.includes("create or replace function public.cancel_order"),
      `${name} redefines the cancellation transition`);
    assert.ok(!later.includes("drop function public.cancel_order"), `${name} drops cancel_order`);
    // 029's CANCELLATION write stays 029's. Scoped to UPDATE SET clauses,
    // because a later migration may legitimately READ these columns -
    // 031's decline path compares fulfillment_status against 'cancelled'
    // to refuse a contradictory decline, and 032's guard reads them too.
    //
    // cancelled_at is 029's alone and may never be written elsewhere.
    // status and fulfillment_status are shared with 028's SHIPMENT
    // transition, so what is forbidden is writing 'cancelled' into them:
    // 032 replaces mark_order_shipped and therefore legitimately writes
    // status = 'shipped'.
    const setClauses = [...later.matchAll(/update public\.orders([\s\S]*?)where /g)].map(m => m[1]);
    for (const clause of setClauses) {
      const written = [...clause.matchAll(/^\s*(?:set\s+)?(\w+)\s*=\s*('?\w+'?)/gm)]
        .map(w => [w[1], w[2]]);
      for (const [column, value] of written) {
        assert.ok(column !== "cancelled_at", `${name} writes cancelled_at`);
        if (column === "status" || column === "fulfillment_status") {
          assert.notEqual(value, "'cancelled'", `${name} performs a cancellation write`);
        }
      }
    }
  }
});

test("029: migration 028 is not edited and still says exactly what it said", () => {
  const migration028 = read("supabase/migrations/028_authorized_shipment_transition.sql");
  // The load-bearing lines of the live shipment transition.
  for (const line of [
    "create or replace function public.mark_order_shipped(",
    "security definer set search_path = ''",
    "if v_order.payment_status not in ('paid', 'partially_refunded') then",
    "if v_order.fulfillment_status not in ('unfulfilled', 'processing') then",
    "grant execute on function public.mark_order_shipped(text, text, text, text) to service_role;",
    "fulfillment_status = 'shipped',",
    "shipped_at         = now(),",
  ]) {
    assert.ok(migration028.includes(line), `028 no longer contains: ${line}`);
  }
  // And 029 does not redefine anything 028 owns.
  assert.ok(!sql029.includes("mark_order_shipped"), "029 touches the shipment function");
});

test("029: it does not redefine anything 019 owns", () => {
  for (const owned of [
    "request_order_cancellation", "apply_order_refund_state",
    "orders_payment_status_check", "orders_refunded_total_cents_range_check",
  ]) {
    assert.ok(!sql029.includes(owned), `029 touches ${owned}`);
  }
  // 019 still says what it said.
  const migration019 = read("supabase/migrations/019_order_lifecycle_tracking.sql");
  assert.ok(migration019.includes("create or replace function public.request_order_cancellation("));
  assert.ok(migration019.includes("create or replace function public.apply_order_refund_state("));
  assert.ok(migration019.includes("'pending', 'paid', 'failed',"));
  assert.ok(migration019.includes("'refund_pending', 'partially_refunded', 'refunded'"));
});

/* ══════════════════════════════════════════════════════════════
   MIGRATION 029: THE COLUMN
   ══════════════════════════════════════════════════════════════ */

test("029: cancelled_at is nullable, has no default and is the only column added", () => {
  assert.ok(sql029.includes("add column if not exists cancelled_at timestamptz;"));
  const adds = [...sql029.matchAll(/add column(?: if not exists)? (\w+)/g)].map(m => m[1]);
  assert.deepEqual(adds, ["cancelled_at"], "029 adds more than cancelled_at");
  // No default, and not null-constrained.
  const alter = sql029.slice(sql029.indexOf("alter table public.orders"));
  const statement = alter.slice(0, alter.indexOf(";") + 1);
  assert.ok(!/default/i.test(statement), "cancelled_at has a default");
  assert.ok(!/not null/i.test(statement), "cancelled_at is NOT NULL");
});

test("029: no backfill, no data statement, no dropped object", () => {
  for (const forbidden of [
    "insert into", "delete from", "truncate", "drop table", "drop column",
    "drop constraint", "drop function", "alter column", "create policy", "create index",
  ]) {
    assert.ok(!sql029.toLowerCase().includes(forbidden), `029 performs: ${forbidden}`);
  }
  // The only UPDATE anywhere is inside the function body, keyed on one id.
  const updates = [...sql029.matchAll(/update public\.orders/g)];
  assert.equal(updates.length, 1, "more than one UPDATE statement exists");
  assert.ok(sql029.includes("where id = v_order.id"));
});

test("029: it adds no constraint that an existing row could violate", () => {
  assert.ok(!sql029.toLowerCase().includes("add constraint"));
  assert.ok(!sql029.toLowerCase().includes("check ("));
});

/* ══════════════════════════════════════════════════════════════
   MIGRATION 029: THE FUNCTION AND ITS SECURITY
   ══════════════════════════════════════════════════════════════ */

test("029: the function is SECURITY DEFINER with an empty search_path", () => {
  assert.ok(sql029.includes("security definer set search_path = ''"));
  const fn = sql029.slice(sql029.indexOf("create or replace function public.cancel_order"));
  assert.ok(fn.includes("language plpgsql"));
  assert.ok(fn.includes("volatile"));
  assert.ok(fn.includes("returns jsonb"));
});

test("029: every table reference is schema-qualified", () => {
  const statements = sql029
    .split(NEWLINE)
    .filter(line => !/^\s*(revoke|grant)\b/i.test(line))
    .join(NEWLINE);
  const bare = [...statements.matchAll(/\b(from|update|into|join)\s+(?!public\.|jsonb|v_|"|\()([a-z_]+)/g)]
    .map(m => `${m[1]} ${m[2]}`)
    .filter(hit => !/^into (v_|jsonb)/.test(hit));
  assert.deepEqual(bare, [], `unqualified references: ${bare.join(", ")}`);
});

test("029: execute is revoked from public, anon and authenticated", () => {
  const signature = "public.cancel_order(text)";
  for (const role of ["public", "anon", "authenticated"]) {
    assert.ok(
      sql029.includes(`revoke all on function ${signature} from ${role};`),
      `execute is not revoked from ${role}`
    );
  }
  // public is revoked FIRST, before the named roles inherit anything.
  assert.ok(
    sql029.indexOf("from public;") < sql029.indexOf("from anon;"),
    "public is not revoked before anon"
  );
});

test("029: execute is granted to service_role and to nobody else", () => {
  const grants = sql029.split(NEWLINE).filter(l => l.trim().toLowerCase().startsWith("grant"));
  assert.equal(grants.length, 1, "more than one grant was issued");
  assert.ok(grants[0].includes("to service_role;"));
  assert.ok(grants[0].includes("grant execute on function public.cancel_order(text)"));
  // And crucially: no table or column grant. service_role must still hold
  // no direct UPDATE on status or fulfillment_status.
  assert.ok(!/grant[^;]*on\s+(table\s+)?public\.orders/i.test(sql029), "029 grants a table privilege on orders");
  assert.ok(!/grant\s+update/i.test(sql029), "029 grants an UPDATE privilege");
});

test("029: the browser cannot reach the function under any role", () => {
  for (const role of ["anon", "authenticated"]) {
    assert.ok(sql029.includes(`from ${role};`), `${role} is not revoked`);
    assert.ok(!sql029.includes(`to ${role};`), `${role} is granted something`);
  }
});

/* ══════════════════════════════════════════════════════════════
   MIGRATION 029: WHAT THE CALLER CANNOT DECIDE
   ══════════════════════════════════════════════════════════════ */

test("029: the function takes exactly one parameter, the order number", () => {
  const signature = sql029.slice(
    sql029.indexOf("create or replace function public.cancel_order"),
    sql029.indexOf("returns jsonb")
  );
  const params = [...signature.matchAll(/(p_\w+)\s+\w+/g)].map(m => m[1]);
  assert.deepEqual(params, ["p_order_number"]);
  for (const forbidden of [
    "status", "fulfillment_status", "payment_status", "cancelled_at",
    "p_user", "p_reason", "email", "refund", "amount",
  ]) {
    assert.ok(!signature.includes(forbidden), `the function accepts ${forbidden} as a parameter`);
  }
});

test("029: the values it writes are its own, never the caller's", () => {
  assert.ok(sql029.includes("status             = 'cancelled'"));
  assert.ok(sql029.includes("fulfillment_status = 'cancelled'"));
  assert.ok(sql029.includes("cancelled_at       = now()"));
});

test("029: the transition writes exactly three columns", () => {
  const update = sql029.slice(sql029.indexOf("update public.orders"));
  const setClause = update.slice(0, update.indexOf("where id = v_order.id"));
  const written = [...setClause.matchAll(/^\s*(?:set\s+)?(\w+)\s*=/gm)].map(m => m[1]);
  assert.deepEqual(written.sort(), ["cancelled_at", "fulfillment_status", "status"]);
});

test("029: status and fulfillment_status move together in one statement", () => {
  const update = sql029.slice(sql029.indexOf("update public.orders"));
  const setClause = update.slice(0, update.indexOf("where id = v_order.id"));
  assert.ok(setClause.includes("status             = 'cancelled'"));
  assert.ok(setClause.includes("fulfillment_status = 'cancelled'"));
  // One UPDATE, so they cannot be applied separately or partially.
  assert.equal([...sql029.matchAll(/update public\.orders/g)].length, 1);
});

test("029: the transition writes no money, tax, snapshot, tracking or email column", () => {
  const update = sql029.slice(sql029.indexOf("update public.orders"));
  const setClause = update.slice(0, update.indexOf("where id = v_order.id"));
  for (const forbidden of [
    "_cents", "tax_", "customer_snapshot", "shipping_address_snapshot",
    "billing_address_snapshot", "payment_status", "currency", "user_id",
    "shipping_carrier", "tracking_number", "tracking_url", "shipped_at",
    "shipment_email", "confirmation_email", "internal_notification",
    "cancellation_requested_at", "cancellation_request_note",
    "refunded_total_cents", "refund_updated_at", "order_number",
  ]) {
    assert.ok(!setClause.includes(forbidden), `the transition writes ${forbidden}`);
  }
});

/* ══════════════════════════════════════════════════════════════
   MIGRATION 029: CANCELLABILITY
   ══════════════════════════════════════════════════════════════ */

test("029: shipped and delivered orders cannot be cancelled, from either column", () => {
  assert.ok(sql029.includes("if v_order.status in ('shipped', 'delivered')"));
  assert.ok(sql029.includes("or v_order.fulfillment_status in ('shipped', 'delivered')"));
  // The guard returns before ever reaching the UPDATE.
  const guard = sql029.indexOf("'not_cancellable'");
  assert.ok(guard > -1);
  assert.ok(guard < sql029.indexOf("update public.orders"), "the refusal comes after the write");
});

test("029: an order is never moved backwards out of shipped or delivered", () => {
  // Both terminal fulfillment states are named, and neither appears in
  // the UPDATE's SET clause.
  const update = sql029.slice(sql029.indexOf("update public.orders"));
  const setClause = update.slice(0, update.indexOf("where id = v_order.id"));
  for (const value of ["'shipped'", "'delivered'"]) {
    assert.ok(!setClause.includes(value), `the transition writes ${value}`);
  }
});

test("029: the lifecycle guard allows only unfulfilled and processing", () => {
  assert.ok(sql029.includes("if v_order.fulfillment_status not in ('unfulfilled', 'processing') then"));
  // Both are real values from migration 004's vocabulary, not invented.
  const migration004 = read("supabase/migrations/004_orders.sql");
  assert.ok(migration004.includes("'unfulfilled', 'processing',"));
});

test("029: every lifecycle value it names exists in the 004 vocabulary", () => {
  const migration004 = read("supabase/migrations/004_orders.sql");
  const statusVocab = migration004.slice(
    migration004.indexOf("check (status in ("),
    migration004.indexOf("payment_status")
  );
  const fulfillmentVocab = migration004.slice(migration004.indexOf("check (fulfillment_status in ("));
  for (const value of ["cancelled", "shipped", "delivered"]) {
    assert.ok(statusVocab.includes(`'${value}'`), `status vocabulary lacks ${value}`);
  }
  for (const value of ["cancelled", "shipped", "delivered", "unfulfilled", "processing"]) {
    assert.ok(fulfillmentVocab.slice(0, 300).includes(`'${value}'`), `fulfillment vocabulary lacks ${value}`);
  }
  // And 029 invents nothing outside those two vocabularies.
  const invented = [...sql029.matchAll(/'([a-z_]+)'/g)]
    .map(m => m[1])
    .filter(v => !["cancelled", "shipped", "delivered", "unfulfilled", "processing"].includes(v))
    .filter(v => !CANCELLATION_RESULTS.includes(v))
    .filter(v => !["result", "order_id", "order_number", "cancelled_at", "search_path"].includes(v));
  assert.deepEqual(invented, [], `029 names lifecycle values that do not exist: ${invented.join(", ")}`);
});

test("029: there is deliberately NO payment guard", () => {
  // Cancelling is the protective direction: it STOPS fulfillment.
  // Refusing to stop an order because of its payment state would be
  // refusing to apply the brake. Unlike 028, which fails closed on
  // payment_status because shipping gives goods away.
  assert.ok(!sql029.includes("v_order.payment_status"), "029 gates on payment_status");
  assert.ok(!sql029.includes("payment_status"), "029 mentions payment_status in live SQL");
  // 028 still has its payment guard, unchanged.
  const migration028 = read("supabase/migrations/028_authorized_shipment_transition.sql");
  assert.ok(migration028.includes("if v_order.payment_status not in ('paid', 'partially_refunded') then"));
});

test("029: a refund is never required first and never created", () => {
  for (const forbidden of [
    "refund", "stripe", "payment_intent", "charge", "refunded_total_cents", "refund_updated_at",
  ]) {
    assert.ok(!sql029.toLowerCase().includes(forbidden), `029 touches ${forbidden}`);
  }
});

/* ══════════════════════════════════════════════════════════════
   MIGRATION 029: IDEMPOTENCY
   ══════════════════════════════════════════════════════════════ */

test("029: an already-cancelled order returns already_cancelled, from either column", () => {
  assert.ok(sql029.includes("if v_order.status = 'cancelled' or v_order.fulfillment_status = 'cancelled' then"));
});

test("029: the already-cancelled check runs BEFORE the shipped guard", () => {
  // Otherwise a cancelled order could report not_cancellable, which would
  // make a safe retry look like a failure.
  assert.ok(sql029.indexOf("'already_cancelled'") < sql029.indexOf("'not_cancellable'"));
});

test("029: a repeat does not move cancelled_at and performs no write at all", () => {
  const branch = sql029.slice(
    sql029.indexOf("if v_order.status = 'cancelled'"),
    sql029.indexOf("if v_order.status in ('shipped', 'delivered')")
  );
  assert.ok(branch.includes("'cancelled_at', v_order.cancelled_at"), "the repeat does not report the stored timestamp");
  assert.ok(!branch.includes("update"), "the idempotent branch performs a write");
  assert.ok(!branch.includes("now()"), "the idempotent branch stamps a new timestamp");
});

test("029: the first transition stamps a server-side now(), never a caller value", () => {
  assert.ok(sql029.includes("cancelled_at       = now()"));
  assert.ok(!sql029.includes("p_cancelled_at"));
});

test("029: concurrent cancellations are serialized by a row lock", () => {
  const select = sql029.slice(sql029.indexOf("select * into v_order"));
  assert.ok(select.slice(0, 300).includes("for update"), "the target row is not locked");
  // The lock is taken before any guard is evaluated, so the second caller
  // reads post-commit state and takes the idempotent branch.
  assert.ok(sql029.indexOf("for update") < sql029.indexOf("if v_order.status = 'cancelled'"));
});

test("029: the lookup is normalized exactly as the shipment RPC normalizes it", () => {
  assert.ok(sql029.includes("where order_number = btrim(upper(p_order_number))"));
  const migration028 = read("supabase/migrations/028_authorized_shipment_transition.sql");
  assert.ok(migration028.includes("where order_number = btrim(upper(p_order_number))"));
});

/* ══════════════════════════════════════════════════════════════
   CUSTOMER REQUEST HISTORY IS PRESERVED
   ══════════════════════════════════════════════════════════════ */

test("029: the customer's cancellation request timestamp and note are never cleared", () => {
  assert.ok(!sql029.includes("cancellation_requested_at"), "029 writes the request timestamp");
  assert.ok(!sql029.includes("cancellation_request_note"), "029 writes the request note");
  // 019 still owns them, and they are still nullable columns on orders.
  const migration019 = read("supabase/migrations/019_order_lifecycle_tracking.sql");
  assert.ok(migration019.includes("add column if not exists cancellation_requested_at timestamptz"));
  assert.ok(migration019.includes("add column if not exists cancellation_request_note text"));
});

test("the customer request endpoint is completely unchanged by this task", () => {
  const requestCode = withoutComments(requestRoute);
  // It still only requests, and it still calls only the 019 RPC.
  const rpcs = [...requestCode.matchAll(/\.rpc\("(\w+)"/g)].map(m => m[1]);
  assert.deepEqual(rpcs, ["request_order_cancellation"]);
  assert.ok(!requestCode.includes("cancel_order"), "the customer endpoint can reach the cancellation RPC");
  assert.ok(!requestCode.includes("CANCELLATION_ADMIN_SECRET"));
  // And it still says "we are checking", never "cancelled".
  assert.ok(requestRoute.includes("Wir prüfen, ob die Bestellung noch gestoppt werden kann"));
  assert.ok(!requestCode.includes("storniert"));
});

test("only the one authorized route can reach the cancellation RPC", () => {
  const callers = [];
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      if (withoutComments(readFileSync(full, "utf-8")).includes("cancel_order")) {
        callers.push(path.relative(ROOT, full).split(path.sep).join("/"));
      }
    }
  };
  walk(path.join(ROOT, "app"));
  walk(path.join(ROOT, "lib"));
  assert.deepEqual(callers, ["app/api/internal/orders/cancel/route.ts"]);
});

/* ══════════════════════════════════════════════════════════════
   ACCOUNT UI COMPATIBILITY - NO UI CHANGE NEEDED
   ══════════════════════════════════════════════════════════════ */

test("account UI: a cancelled order already renders Storniert with no UI change", () => {
  const cancelled = order({ status: "cancelled", fulfillment_status: "cancelled" });
  assert.equal(getPrimaryStatusLabel(cancelled), "Storniert");
  assert.equal(getStatusDetailText(cancelled), "Diese Bestellung wurde storniert.");
  assert.deepEqual(getLifecycleSteps(cancelled), [], "a stopped order still shows a progress track");
  assert.equal(getCancellationView(cancelled).state, "unavailable");
});

test("account UI: it renders Storniert even if only one column moved", () => {
  // Defence in depth: the RPC moves both, but the UI must not depend on
  // that to tell the truth.
  assert.equal(getPrimaryStatusLabel(order({ status: "cancelled" })), "Storniert");
  assert.equal(getPrimaryStatusLabel(order({ fulfillment_status: "cancelled" })), "Storniert");
});

test("account UI: a cancelled-but-still-paid order says Storniert, not Erstattet", () => {
  // The expected temporary state: fulfillment stopped, money not back yet.
  const cancelled = order({ status: "cancelled", fulfillment_status: "cancelled", payment_status: "paid" });
  assert.equal(getPrimaryStatusLabel(cancelled), "Storniert");
  assert.equal(getRefundView(cancelled).kind, "none");
});

test("account UI: a cancelled order that is later refunded still says Storniert", () => {
  const refunded = order({
    status: "cancelled", fulfillment_status: "cancelled",
    payment_status: "refunded", refunded_total_cents: 4990,
  });
  // isCancelled is checked first, deliberately: the order stopped, and
  // that is the more important fact for the customer.
  assert.equal(getPrimaryStatusLabel(refunded), "Storniert");
  // The refund amount is still reported truthfully in its own row.
  assert.deepEqual(getRefundView(refunded), { kind: "full", amountCents: 4990 });
});

test("account UI: the original cancellation request survives the cancellation", () => {
  const cancelled = order({
    status: "cancelled", fulfillment_status: "cancelled",
    cancellation_requested_at: "2026-08-24T09:00:00.000Z",
  });
  assert.equal(cancelled.cancellation_requested_at, "2026-08-24T09:00:00.000Z");
  assert.equal(getPrimaryStatusLabel(cancelled), "Storniert");
  // And the customer is no longer told "we are checking" - the request is
  // resolved by the order being cancelled.
  assert.equal(getStatusDetailText(cancelled), "Diese Bestellung wurde storniert.");
});

test("account UI: no new customer button and no account file changed", () => {
  const portal = read("app/AccountPortal.tsx");
  assert.ok(!portal.includes("/api/internal/orders/cancel"), "the portal calls the operator endpoint");
  assert.ok(!portal.includes("CANCELLATION_ADMIN_SECRET"));
  assert.ok(!portal.includes("cancel_order"));
  // The one cancellation call it makes is still the customer REQUEST.
  assert.ok(portal.includes('fetch("/api/orders/cancellation-request"'));
  assert.ok(portal.includes("Stornierung anfragen"));
});

test("account UI: lib/orderStatus.ts still learns nothing about the cancel RPC", () => {
  // Against stripped code. Phase 2D-B added a comment to
  // getCancellationView explaining that approving cancels via
  // cancel_order, and prose naming a function is not the display layer
  // depending on it.
  const status = withoutComments(read("lib/orderStatus.ts"));
  assert.ok(!status.includes("cancelled_at"), "the display layer learned about cancelled_at");
  assert.ok(!status.includes("cancel_order"), "the display layer calls the cancellation RPC");
  assert.ok(!status.includes("supabase"), "the display layer reached for a database");
  // Its cancellation predicate still reads both columns.
  assert.ok(status.includes('const CANCELLED_VALUES = ["cancelled"];'));
});

/* ══════════════════════════════════════════════════════════════
   RESPONSE AND LOGGING
   ══════════════════════════════════════════════════════════════ */

test("response: it carries only the five operational fields", () => {
  const success = routeBody.slice(routeBody.lastIndexOf("Response.json("));
  // `orderNumber,` is shorthand, so it has no colon - both forms count.
  const fields = [...success.matchAll(/^\s+(\w+)[:,]/gm)].map(m => m[1]);
  assert.deepEqual(fields.sort(), [
    "cancellationApplied", "cancellationStatus", "cancelledAt", "ok", "orderNumber",
  ]);
});

test("response: it carries no customer PII, money or refund data", () => {
  const responses = [...routeBody.matchAll(/Response\.json\(\s*\{([\s\S]*?)\}\s*(?:as|satisfies|,)/g)].map(m => m[1]);
  assert.ok(responses.length > 0);
  for (const payload of responses) {
    for (const forbidden of [
      "email", "name", "address", "snapshot", "phone", "_cents", "customer",
      "payment", "refund", "secret", "user", "note", "order_id", "orderId",
    ]) {
      assert.ok(!payload.toLowerCase().includes(forbidden), `a response carries ${forbidden}`);
    }
  }
});

test("response: an error response never leaks an internal detail", () => {
  // routeBody, so the `type ErrorResponse = { error: string }` alias is
  // not mistaken for a response payload.
  const errors = [...routeBody.matchAll(/\{ error: ([^}]*) \}/g)].map(m => m[1]);
  assert.ok(errors.length > 0);
  for (const value of errors) {
    // Every error message is a literal or a lookup in REFUSAL_MESSAGES.
    const literal = /^"[^"]*"$/.test(value.trim());
    const lookup = value.includes("REFUSAL_MESSAGES[result]");
    const code = value.includes("validated.code");
    assert.ok(literal || lookup || code, `an error interpolates something: ${value}`);
    assert.ok(!value.includes("error.message"), "a Supabase error message reaches the caller");
  }
});

test("logging: no PII and no request body reaches a log line", () => {
  const logs = [...routeCode.matchAll(/console\.\w+\(([\s\S]*?)\);/g)].map(m => m[1]);
  assert.ok(logs.length >= 3, "the route logs nothing at all");
  for (const line of logs) {
    for (const forbidden of [
      "email", "customer", "snapshot", "address", "note", "rawBody", "parsed",
      "JSON.stringify", "data)", "payload)", "secret",
    ]) {
      assert.ok(!line.includes(forbidden), `a log line contains ${forbidden}: ${line}`);
    }
  }
  // The order number is the one identifier that may be logged.
  assert.ok(logs.some(l => l.includes("orderNumber")));
});

/* ══════════════════════════════════════════════════════════════
   REGRESSIONS: NOTHING ELSE MOVED
   ══════════════════════════════════════════════════════════════ */

test("regression: no Stripe write API anywhere in the repository", () => {
  // Assembled from parts so this suite does not itself contain the very
  // literals it forbids - the self-check at the bottom scans this file.
  const STRIPE_WRITES = [
    ["refunds", ".create"], ["refunds", ".cancel"], ["paymentIntents", ".cancel"],
  ].map(parts => parts.join(""));
  const offenders = [];
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      const source = withoutComments(readFileSync(full, "utf-8"));
      for (const forbidden of STRIPE_WRITES) {
        if (source.includes(forbidden)) offenders.push(`${entry.name}: ${forbidden}`);
      }
    }
  };
  walk(path.join(ROOT, "app"));
  walk(path.join(ROOT, "lib"));
  assert.deepEqual(offenders, [], `a Stripe write API appeared: ${offenders.join(", ")}`);
});

test("regression: the cancel route imports no Stripe client and no email sender", () => {
  for (const forbidden of [
    "stripe", "Stripe", "getStripeClient", "resend", "Resend",
    "sendShipmentConfirmationIfNeeded", "sendOrderConfirmationEmailIfNeeded",
    "sendInternalOrderNotificationIfNeeded", "emails.send",
  ]) {
    assert.ok(!routeCode.includes(forbidden), `the cancel route touches ${forbidden}`);
  }
  // Against routeCode and anchored to real import statements: the prose
  // header contains the words `from "..."` inside a sentence, and a bare
  // /from "([^"]+)"/ over the raw file happily matches that too.
  const imports = [...routeCode.matchAll(/^import[\s\S]*?from "([^"]+)";$/gm)].map(m => m[1]);
  assert.deepEqual(imports.sort(), [
    "../../../../../lib/orderCancellationRules",
    "../../../../../lib/serverSecretAuth",
    "../../../../../lib/supabaseAdmin",
  ]);
});

test("regression: the refund webhook flow is untouched", () => {
  const webhook = withoutComments(read("app/api/stripe/webhook/route.ts"));
  assert.ok(webhook.includes("isRefundEventType(event.type)"));
  assert.ok(webhook.includes("syncOrderRefundStateFromStripe(stripe, paymentIntentId)"));
  assert.ok(!webhook.includes("cancel_order"), "the webhook can cancel orders");
  assert.ok(!webhook.includes("CANCELLATION_ADMIN_SECRET"));
  // The handled refund event set is exactly what it was.
  const refunds = read("lib/stripeRefunds.ts");
  for (const event of [
    "charge.refunded", "charge.refund.updated", "refund.created", "refund.updated", "refund.failed",
  ]) {
    assert.ok(refunds.includes(`"${event}"`), `the refund event set lost ${event}`);
  }
  assert.ok(refunds.includes("apply_order_refund_state") === false);
  assert.ok(read("lib/orderRefunds.ts").includes('admin.rpc("apply_order_refund_state"'));
});

test("regression: the shipment route is behaviourally unchanged", () => {
  const shipCode = withoutComments(shipRoute);
  const rpcs = [...shipCode.matchAll(/\.rpc\("(\w+)"/g)].map(m => m[1]);
  assert.deepEqual(rpcs, ["mark_order_shipped"]);
  assert.ok(shipCode.includes("sendShipmentConfirmationIfNeeded(orderId)"));
  assert.ok(!shipCode.includes("cancel_order"), "the ship route can cancel orders");
  assert.ok(!shipCode.includes("cancelled_at"), "the ship route learned about cancelled_at");
  // And, deliberately, NO cancellation-request guard was added. See the
  // documented gap below.
  assert.ok(!shipCode.includes("cancellation_requested_at"), "a request guard was added prematurely");
});

test("regression: the DOCUMENTED GAP - a cancellation request does not block shipping", () => {
  // Deliberate for this task. There is no declined/resolved state for a
  // cancellation request yet, so a request the owner decides NOT to grant
  // would otherwise block that order's shipment forever. The guard
  // belongs with the request resolution flow, not here.
  const shipCode = withoutComments(shipRoute);
  const migration028 = read("supabase/migrations/028_authorized_shipment_transition.sql");
  assert.ok(!shipCode.includes("cancellation_requested_at"));
  assert.ok(!withoutComments(migration028).includes("cancellation_requested_at"));
  // 019 still has no resolution column, which is exactly why the guard is
  // withheld.
  const migration019 = read("supabase/migrations/019_order_lifecycle_tracking.sql");
  assert.ok(!migration019.includes("cancellation_declined_at"));
  assert.ok(!migration019.includes("cancellation_resolved_at"));
  assert.ok(!sql029.includes("cancellation_declined_at"));
});

test("regression: the OPERATOR cancel route still sends nothing at all", () => {
  // Phase 2D-A added cancellationRequestNotification.ts, which is an
  // INTERNAL message to orders@gloamatcha.com about a REQUEST. The
  // customer's own cancellation-outcome mail and any refund mail still do
  // not exist, which is what this assertion is really about.
  // Phase 2D-B added cancellationOutcome.ts, which IS the customer's
  // cancellation-outcome mail and is sent by the resolution endpoint, not
  // by this one. What remains true, and is what this assertion is really
  // about, is that NO REFUND customer email exists and that the operator
  // cancel route below still sends nothing at all.
  // Phase 2E-A added refundConfirmation.ts, the customer's refund mail.
  // It is sent by the Stripe refund webhook, never by this endpoint - and
  // that, not the absence of the template, is what this assertion is
  // about. Migration 029 still creates no refund and mails nobody.
  const templates = readdirSync(path.join(ROOT, "lib/email")).sort();
  assert.deepEqual(templates, [
    "cancellationConfirmation.ts", "cancellationOutcome.ts",
    "cancellationRequestNotification.ts",
    "internalOrderNotification.ts", "orderConfirmation.ts",
    "refundConfirmation.ts", "shipmentConfirmation.ts", "subscriptionStarted.ts",
    "withdrawalConfirmation.ts",
  ], "an unexpected email template was added");
  // Against stripped code: the template's header prose legitimately says
  // where the message goes, and a scan that read comments would call that
  // a hardcoded recipient.
  const cancellationTemplate = withoutComments(
    readFileSync(path.join(ROOT, "lib/email/cancellationRequestNotification.ts"), "utf-8")
  );
  assert.ok(!cancellationTemplate.includes("@gloamatcha.com"),
    "the template hardcodes a recipient instead of leaving it to emailSenders");
  assert.ok(withoutComments(readFileSync(path.join(ROOT, "lib/cancellationRequestNotificationEmail.ts"), "utf-8"))
    .includes("to: GLOA_INTERNAL_ORDERS"), "the cancellation request mail is not internal-only");
  // And the OPERATOR cancel route - this task's subject - still sends
  // nothing at all.
  for (const forbidden of [
    "cancellation_email", "cancellationEmail", "emailOutcome", "IdempotencyKey",
    "sendCancellationRequestNotificationIfNeeded", "sendCancellationOutcomeEmailIfNeeded",
    "sendRefundConfirmationIfNeeded", "resolve_order_cancellation_request",
  ]) {
    assert.ok(!routeCode.includes(forbidden), `the route touches ${forbidden}`);
    assert.ok(!sql029.includes(forbidden), `029 touches ${forbidden}`);
  }
});

test("regression: 029 sends no email and adds no trigger", () => {
  for (const forbidden of ["create trigger", "notify", "http_post", "net.http", "resend", "smtp", "mail"]) {
    assert.ok(!sql029.toLowerCase().includes(forbidden), `029 contains: ${forbidden}`);
  }
});

test("regression: the other order emails and their state columns are untouched", () => {
  for (const other of [
    "sendOrderConfirmationEmail", "confirmation_email_status",
    "sendInternalOrderNotificationIfNeeded", "internal_notification_status",
    "shipment_email_status",
  ]) {
    assert.ok(!routeCode.includes(other), `the cancel route triggers ${other}`);
    assert.ok(!sql029.includes(other), `029 touches ${other}`);
  }
});

test("regression: SHOP_STATUS and B2C_SUBSCRIPTIONS_ENABLED are unchanged", () => {
  assert.ok(read("app/content.ts").includes('export const SHOP_STATUS = "prelaunch" as const;'));
  const example = read(".env.example");
  assert.match(example, /^B2C_SUBSCRIPTIONS_ENABLED=$/m, "the subscription flag gained a value");
  for (const forbidden of ["B2C_SUBSCRIPTIONS_ENABLED", "SHOP_STATUS", "subscription"]) {
    assert.ok(!routeCode.includes(forbidden), `the route touches ${forbidden}`);
    assert.ok(!sql029.toLowerCase().includes(forbidden.toLowerCase()), `029 touches ${forbidden}`);
  }
});

test("regression: pricing, tax and shipping are untouched", () => {
  for (const forbidden of [
    "price_gross_cents", "computeShippingGrossCents", "resolveCheckoutTax",
    "SHIPPING_ZONES", "tax_total_cents", "total_gross_cents",
  ]) {
    assert.ok(!routeCode.includes(forbidden), `the route touches ${forbidden}`);
    assert.ok(!sql029.includes(forbidden), `029 touches ${forbidden}`);
  }
});

test("regression: no new cron job was registered", () => {
  const vercel = JSON.parse(read("vercel.json"));
  assert.equal((vercel.crons ?? []).length, 1, "a cron job was added");
  assert.equal(vercel.crons[0].path, "/api/cron/retry-order-notifications");
});

test("regression: no client bundle can see the secret or the endpoint", () => {
  for (const rel of ["app/GloaSite.tsx", "app/AccountPortal.tsx", "app/createCheckoutSession.ts", "app/Chrome.tsx"]) {
    const source = read(rel);
    assert.ok(!source.includes("CANCELLATION_ADMIN_SECRET"), `${rel} names the secret`);
    assert.ok(!source.includes("/api/internal/"), `${rel} calls an internal endpoint`);
  }
});

test("regression: the built client bundle contains no secret and no handler code", () => {
  // The route's PATH may appear in the framework's route manifest, which
  // is neither new nor a weakness - the endpoint is protected by a secret,
  // not by being hard to find. What must never ship to a browser is the
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
      "CANCELLATION_ADMIN_SECRET", "cancel_order", "isBearerSecretAuthorized",
      "validateCancellationRequest", "timingSafeEqual", SECRET,
    ]) {
      if (source.includes(needle)) leaks.push(`${path.relative(ROOT, file)}: ${needle}`);
    }
  }
  assert.deepEqual(leaks, [], `server-only material reached the client bundle: ${leaks.join(", ")}`);
});

test("029: the OWNER verification queries cover A through S", () => {
  for (const marker of [
    "-- (A)", "-- (D)", "-- (G)", "-- (H)", "-- (M)", "-- (N)", "-- (O)", "-- (S)",
  ]) {
    assert.ok(migration029.includes(marker), `verification ${marker} is missing`);
  }
  assert.ok(migration029.includes("prosecdef"), "no SECURITY DEFINER verification");
  assert.ok(migration029.includes("proconfig"), "no search_path verification");
  assert.ok(migration029.includes("has_function_privilege"), "no execute-privilege verification");
  assert.ok(migration029.includes("column_privileges"), "no UPDATE-grant verification");
  assert.ok(migration029.includes("count(cancelled_at)"), "no backfill verification");
  assert.ok(migration029.includes("pg_trigger"), "no trigger verification");
});

/* ══════════════════════════════════════════════════════════════
   THE HTTP BOUNDARY, ON REAL SPAWNED SERVERS
   ══════════════════════════════════════════════════════════════ */

const ENDPOINT_PATH = "/api/internal/orders/cancel";

/**
 * Every server below is started without SUPABASE_SECRET_KEY and without
 * RESEND_API_KEY, so even a fully authorized request cannot reach a
 * database: it stops at the 503 the route returns when the admin client
 * is unconfigured, which is strictly before the RPC. No order can be
 * cancelled by this suite, and no Resend client can be constructed.
 */
function serverEnv(extra) {
  const env = writeBlockedServerEnv({ ...extra });
  delete env.RESEND_API_KEY;
  delete env.RESEND_CONTACT_FROM;
  delete env.FULFILLMENT_ADMIN_SECRET;
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

const UNSET_PORT = 8946;
let unsetServer;

test.before(async () => {
  // CANCELLATION_ADMIN_SECRET deliberately unset, which is how the
  // endpoint ships until the owner creates it in Vercel.
  unsetServer = await startServer(UNSET_PORT, { CANCELLATION_ADMIN_SECRET: "" });
});

test.after(() => {
  unsetServer?.kill();
});

test("http: an unconfigured secret refuses every caller, including a correct-looking one", async () => {
  for (const headers of [
    {},
    { authorization: "Bearer " },
    { authorization: `Bearer ${SECRET}` },
    { authorization: "Bearer anything" },
  ]) {
    const res = await post(UNSET_PORT, { orderNumber: ORDER_NUMBER }, headers);
    assert.equal(res.status, 503, JSON.stringify(headers));
    const parsed = await res.json().catch(() => null);
    assert.equal(parsed?.ok, undefined);
  }
});

/* ── Configured: the authorization boundary ───────────────────── */

const SECURED_PORT = 8947;
let securedServer;

test.before(async () => {
  securedServer = await startServer(SECURED_PORT, { CANCELLATION_ADMIN_SECRET: SECRET });
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
    "Bearer", "Bearer ", "Bearer wrong-secret", `Bearer ${SECRET}x`,
    `Bearer ${SECRET.slice(0, -1)}`, `bearer ${SECRET}`,
    `Basic ${SECRET}`, SECRET,
  ]) {
    const res = await post(SECURED_PORT, { orderNumber: ORDER_NUMBER }, { authorization });
    assert.equal(res.status, 401, authorization);
  }
});

test("http: the shipment secret does not authorize a cancellation", async () => {
  // The real FULFILLMENT_ADMIN_SECRET value used by the shipment suite.
  const shipmentSecret = "test-only-fulfillment-secret-not-a-real-value";
  const res = await post(
    SECURED_PORT,
    { orderNumber: ORDER_NUMBER },
    { authorization: `Bearer ${shipmentSecret}` }
  );
  assert.equal(res.status, 401);
});

test("http: a cron-style secret does not authorize a cancellation", async () => {
  const res = await post(
    SECURED_PORT,
    { orderNumber: ORDER_NUMBER },
    { authorization: "Bearer test-only-cron-secret" }
  );
  assert.equal(res.status, 401);
});

test("http: a customer-style Supabase bearer token is not authorization", async () => {
  // A real-shaped JWT. It is not the cancellation secret, so it is refused
  // exactly like any other wrong value - customer auth has no path here.
  const jwtish = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyIn0.notarealsignature";
  const res = await post(SECURED_PORT, { orderNumber: ORDER_NUMBER }, { authorization: `Bearer ${jwtish}` });
  assert.equal(res.status, 401);
});

test("http: authorization is checked before the body is even looked at", async () => {
  const valid = await post(SECURED_PORT, { orderNumber: ORDER_NUMBER });
  const invalid = await post(SECURED_PORT, { orderNumber: "nonsense" });
  const malformed = await post(SECURED_PORT, "{not json");
  assert.equal(valid.status, 401);
  assert.equal(invalid.status, 401);
  assert.equal(malformed.status, 401);
});

test("http: the correct secret is accepted and reaches validation", async () => {
  const authorization = `Bearer ${SECRET}`;

  // Malformed JSON now gets a 400 rather than a 401, which proves the
  // secret was accepted and the request moved past authorization.
  const malformed = await post(SECURED_PORT, "{not json", { authorization });
  assert.equal(malformed.status, 400);

  const badNumber = await post(SECURED_PORT, { orderNumber: "nonsense" }, { authorization });
  assert.equal(badNumber.status, 400);
  const parsed = await badNumber.json();
  assert.equal(parsed.error, "Ungültige Anfrage: invalid_order_number.");
});

test("http: a missing order number is refused with the correct secret", async () => {
  const res = await post(SECURED_PORT, {}, { authorization: `Bearer ${SECRET}` });
  assert.equal(res.status, 400);
  const parsed = await res.json();
  assert.equal(parsed.error, "Ungültige Anfrage: invalid_order_number.");
});

test("http: an unknown field is refused even with the correct secret", async () => {
  const authorization = `Bearer ${SECRET}`;
  for (const key of [
    "status", "fulfillment_status", "payment_status", "cancelled_at",
    "refundAmount", "reason", "recipient", "to", "subject", "html", "userId",
  ]) {
    const res = await post(SECURED_PORT, { orderNumber: ORDER_NUMBER, [key]: "x" }, { authorization });
    assert.equal(res.status, 400, key);
    const parsed = await res.json();
    assert.equal(parsed.error, "Ungültige Anfrage: unknown_field.", key);
  }
});

test("http: a non-JSON content type is refused", async () => {
  const res = await fetch(`http://127.0.0.1:${SECURED_PORT}${ENDPOINT_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "text/plain", authorization: `Bearer ${SECRET}` },
    body: "orderNumber=GLOA-2026-000451",
  });
  assert.equal(res.status, 400);
});

test("http: an oversized body is refused", async () => {
  const res = await post(
    SECURED_PORT,
    JSON.stringify({ orderNumber: ORDER_NUMBER, padding: "x".repeat(5_000) }),
    { authorization: `Bearer ${SECRET}` }
  );
  assert.equal(res.status, 413);
});

test("http: a fully valid authorized request stops at the unconfigured database", async () => {
  // The last stop before the RPC. It proves the whole chain up to the
  // database is reachable with the right secret, and that no order can be
  // cancelled by this suite - there is no database here to cancel one in.
  const res = await post(
    SECURED_PORT,
    { orderNumber: ORDER_NUMBER },
    { authorization: `Bearer ${SECRET}` }
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
      headers: { authorization: `Bearer ${SECRET}` },
    });
    assert.ok(res.status === 404 || res.status === 405, `${method} answered ${res.status}`);
  }
});

test("http: no response body ever contains the secret", async () => {
  const responses = await Promise.all([
    post(SECURED_PORT, { orderNumber: ORDER_NUMBER }),
    post(SECURED_PORT, { orderNumber: "nonsense" }, { authorization: `Bearer ${SECRET}` }),
    post(SECURED_PORT, { orderNumber: ORDER_NUMBER }, { authorization: `Bearer ${SECRET}` }),
  ]);
  for (const res of responses) {
    const text = await res.text();
    assert.ok(!text.includes(SECRET), "a response echoed the secret");
    assert.ok(!text.includes("CANCELLATION_ADMIN_SECRET"), "a response named the secret variable");
  }
});

test("no real Stripe request, no Resend request and no production Supabase in this suite", () => {
  const suite = withoutComments(read("tests/order-cancellation-transition.test.mjs"));
  const forbidden = [
    ["create", "Client("], ["new ", "Resend("], ["new ", "Stripe("],
    ["supabase", ".co"], ["api.", "resend.com"], ["api.", "stripe.com"],
    ["refunds", ".create"],
  ].map(parts => parts.join(""));
  for (const needle of forbidden) {
    assert.ok(!suite.includes(needle), `the suite performs: ${needle}`);
  }
  // Every spawned server is started through serverEnv, which strips the
  // service-role key, the Resend key and the shipment secret.
  const spawns = [...suite.matchAll(/spawn\(process\.execPath[\s\S]*?\}\)/g)];
  assert.equal(spawns.length, 1, "a server is spawned outside the guarded helper");
  assert.ok(spawns[0][0].includes("serverEnv("));
});
