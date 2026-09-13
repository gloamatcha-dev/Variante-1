import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { createClient } from "@supabase/supabase-js";

/**
 * WHAT HAPPENS WHEN THE CATALOG READ FAILS TRANSIENTLY.
 *
 * Production answered one checkout request with 500 "Shop vorübergehend
 * nicht verfügbar." immediately after a deployment; four identical
 * requests that followed were answered correctly. The 500 comes from the
 * catalog read in lib/checkoutQuote.ts, which is the only thing in the
 * one-time checkout that can fail that way before the launch gate.
 *
 * The obvious response - wrap the read in a retry - would have been
 * wrong, and this suite is the reason we know that. It drives the REAL
 * supabase client against a proxy that fails on demand, and measures how
 * many upstream attempts one call actually makes. The answer is four:
 * @supabase/postgrest-js already retries three times with exponential
 * backoff. A retry added in application code would have stacked on top
 * of that, turning one customer request into eight upstream calls and
 * two backoffs.
 *
 * So what is locked in here is the POLICY, not a new mechanism:
 *
 *   transient failures absorbed   up to three
 *   methods retried               idempotent only (GET/HEAD/OPTIONS)
 *   statuses retried              503 and 520, plus transport errors
 *   statuses NEVER retried        every 4xx, and every business error
 *   writes retried                none - POST is excluded by method
 *
 * If a dependency upgrade ever changes any of that, these tests fail
 * rather than the behaviour drifting silently into production.
 *
 * SAFE: talks to a local proxy only. No Supabase project, no network,
 * no Stripe, no writes - the proxy answers every request itself.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const quote = readFileSync(path.join(ROOT, "lib/checkoutQuote.ts"), "utf8");

/** One row, shaped like the select in buildAuthoritativeQuote. */
const CATALOG_ROW = {
  id: "ca99d0f5-739e-4362-81bb-d508e37b42de",
  product_id: "8fc9e896-d07b-413a-b534-b5eb6129d4b3",
  sku: "GLOA-TEST-30G", label: "30 g", size_grams: 30,
  price_gross_cents: 1999, currency: "EUR", is_active: true,
  products: { is_active: true, name: "Test Matcha", slug: "matcha" },
};

let server, origin;
/** Every request the client made, in order. */
let log;
/** How many more requests to fail, and how. */
let failuresLeft = 0;
let failureMode = "status";
let failureStatus = 503;

test.before(async () => {
  server = http.createServer((req, res) => {
    log.push({ method: req.method, retryHeader: req.headers["x-retry-count"] ?? null });
    if (failuresLeft > 0) {
      failuresLeft--;
      if (failureMode === "kill") { req.socket.destroy(); return; }
      // No Retry-After header, so postgrest-js uses its own backoff.
      res.writeHead(failureStatus, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "simulated transient failure" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify([CATALOG_ROW]));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => { server?.close(); });

test.beforeEach(() => { log = []; failuresLeft = 0; failureMode = "status"; failureStatus = 503; });

/** A fresh client per call, so no connection state carries between tests. */
function client() {
  return createClient(origin, "test-publishable-key-not-a-secret", {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** The exact read buildAuthoritativeQuote performs. */
function catalogRead(supabase) {
  return supabase
    .from("product_variants")
    .select("id, product_id, sku, label, size_grams, price_gross_cents, currency, is_active, products!inner(is_active, name, slug)")
    .in("id", [CATALOG_ROW.id]);
}

/* ══════════════════════════════════════════════════════════════
   1. A TRANSIENT FAILURE IS ABSORBED
   ══════════════════════════════════════════════════════════════ */

test("1: first read fails transiently, second succeeds, the request completes", async () => {
  failuresLeft = 1;
  const { data, error } = await catalogRead(client());
  assert.equal(error, null, "a single transient failure reached the caller");
  assert.equal(data.length, 1);
  assert.equal(data[0].price_gross_cents, 1999, "the retry returned different data");
  assert.equal(log.length, 2, `expected 2 upstream attempts, saw ${log.length}`);
  // The retry identifies itself, so an upstream can tell them apart.
  assert.equal(log[0].retryHeader, null);
  assert.equal(log[1].retryHeader, "1");
});

test("1b: a dropped connection is absorbed the same way", async () => {
  failuresLeft = 1;
  failureMode = "kill";
  const { data, error } = await catalogRead(client());
  assert.equal(error, null, "a dropped connection reached the caller");
  assert.equal(data[0].price_gross_cents, 1999);
});

test("1c: the retry is bounded - it does not loop", async () => {
  failuresLeft = Number.MAX_SAFE_INTEGER;
  const { data, error } = await catalogRead(client());
  assert.ok(error, "a permanently failing catalog reported success");
  assert.equal(data, null);
  // Four attempts: the original plus three retries. Bounded, and small.
  assert.equal(log.length, 4, `expected 4 bounded attempts, saw ${log.length}`);
  assert.ok(log.length <= 4, "the retry budget grew");
});

/* ══════════════════════════════════════════════════════════════
   2. WHAT MUST NEVER BE RETRIED
   ══════════════════════════════════════════════════════════════ */

test("2: a 4xx is never retried - a business answer is final", async () => {
  for (const status of [400, 401, 403, 404, 409, 422]) {
    log = []; failuresLeft = Number.MAX_SAFE_INTEGER; failureStatus = status;
    const { error } = await catalogRead(client());
    assert.ok(error, `${status} was not reported as an error`);
    assert.equal(log.length, 1, `${status} was retried (${log.length} attempts)`);
  }
});

test("2b: a plain 500 is not retried either - only 503 and 520 are transient", async () => {
  for (const status of [500, 501, 502]) {
    log = []; failuresLeft = Number.MAX_SAFE_INTEGER; failureStatus = status;
    await catalogRead(client());
    assert.equal(log.length, 1, `${status} was retried (${log.length} attempts)`);
  }
});

test("2c: only idempotent methods are retried, so no write is ever repeated", async () => {
  failuresLeft = Number.MAX_SAFE_INTEGER;
  const { error } = await client().from("product_variants").insert({ sku: "NEVER" });
  assert.ok(error, "the write reported success against a failing endpoint");
  assert.equal(log.length, 1, `a POST was retried ${log.length} times`);
  assert.equal(log[0].method, "POST");
});

/* ══════════════════════════════════════════════════════════════
   3. NO SECOND RETRY, AND NO SIDE EFFECT BEHIND ONE
   ══════════════════════════════════════════════════════════════ */

test("3: the application adds no retry of its own", () => {
  const code = quote.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\r\n]*/g, "");
  for (const banned of ["setTimeout", "for (let attempt", "while (", "retryCount", "maxAttempts", "sleep("]) {
    assert.ok(!code.includes(banned), `a second retry loop was added: ${banned}`);
  }
  // Exactly one catalog read in the whole module.
  assert.equal((code.match(/\.from\("product_variants"\)/g) || []).length, 1);
});

test("3b: the read is the FIRST thing, so a retry can never repeat a side effect", () => {
  const route = readFileSync(path.join(ROOT, "app/api/checkout/session/route.ts"), "utf8");
  const readAt = route.indexOf("buildAuthoritativeQuote(validatedItems)");
  assert.ok(readAt > 0);
  for (const sideEffect of ["getOrCreateCheckoutAttempt(", "stripe.checkout.sessions.create(", "linkStripeSession("]) {
    assert.ok(route.indexOf(sideEffect) > readAt,
      `${sideEffect} runs before the retried read, so a retry could repeat it`);
  }
  // The read itself writes nothing.
  assert.ok(!/\.(insert|update|upsert|delete)\(/.test(quote), "the quote builder writes");
});

test("3c: an exhausted catalog read is reported as unavailable, not as a fault", () => {
  // 503 tells a caller "temporary, this worked yesterday". A 500 says
  // the request was bad and pages somebody for a working system.
  assert.match(quote, /return fail\(503, "Shop vorübergehend nicht verfügbar\."\);/);
  assert.ok(!/return fail\(500, "Shop vorübergehend nicht verfügbar\."\);/.test(
    quote.slice(quote.indexOf("if (dbError)"))), "the catalog failure still reports 500");
  // Data that IS present but wrong stays a 500 - that is a real fault.
  assert.match(quote, /return fail\(500, "Ungültiger Preis für ein Produkt\."\);/);
});
