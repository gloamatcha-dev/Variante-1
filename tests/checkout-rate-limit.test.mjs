import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { writeBlockedServerEnv } from "./helpers/testSupabase.mjs";
import {
  consumeLocalCheckoutRateLimit,
  consumeSharedCheckoutRateLimit,
  CHECKOUT_QUOTE_RATE_LIMIT,
  CHECKOUT_SESSION_RATE_LIMIT,
  CHECKOUT_RATE_LIMITED_MESSAGE,
} from "../lib/checkoutRateLimit.ts";

/*
  ══════════════════════════════════════════════════════════════
  THE CHECKOUT ENDPOINTS COUNT NOW.

  The contact form, the B2B lead form and the waitlist all had a rate
  limit. The two endpoints that read the catalog and create Stripe
  CUSTOMERS had none at all - so /api/checkout/quote was an unmetered
  oracle that would answer "is this code worth anything", and
  /api/checkout/session could mint one Stripe Customer per address for
  as long as somebody cared to ask.

  Same primitives as the waitlist, not a second system: the in-process
  counter from lib/launchRateLimit.ts and the shared Postgres counter
  from lib/launchRateLimitStore.ts (migration 043). What is new is the
  policy - two sets of numbers, two bucket namespaces, and two different
  answers to "the shared counter cannot be reached".

  ── HOW THESE TESTS AVOID DOING ANY DAMAGE ───────────────────
  The layer-1 tests fire at a server started WITHOUT a service-role key
  and send bodies that fail validation, so not one request reaches a
  catalog read, a Stripe call or a database write - the limiter sits
  above the body checks and is what they actually exercise.

  The layer-2 tests use tests/helpers/mockSupabaseFetch.mjs, which
  replaces fetch inside the child process and answers the Supabase host
  locally. An unmatched Supabase request FAILS rather than passing
  through, so nothing can leave the machine.
  ══════════════════════════════════════════════════════════════
*/

const read = p => readFileSync(new URL(`../${p}`, import.meta.url), "utf-8");

/* ══════════════════════════════════════════════════════════════
   1. THE POLICY ITSELF
   ══════════════════════════════════════════════════════════════ */

const req = (ip = "203.0.113.7") => ({ headers: { get: name => (name === "x-forwarded-for" ? ip : null) } });
const NOW = Date.parse("2026-10-15T12:00:00+02:00");

test("policy: quote and session have separate bucket namespaces", () => {
  assert.notEqual(CHECKOUT_QUOTE_RATE_LIMIT.label, CHECKOUT_SESSION_RATE_LIMIT.label);
  // ...and neither shares the waitlist's, or a confirmed signup would
  // arrive at the checkout with part of its budget already spent.
  const launch = /export const LAUNCH_BUCKET_HMAC_LABEL = "([^"]+)"/.exec(read("lib/launchRateLimit.ts"));
  assert.ok(launch);
  assert.notEqual(CHECKOUT_QUOTE_RATE_LIMIT.label, launch[1]);
  assert.notEqual(CHECKOUT_SESSION_RATE_LIMIT.label, launch[1]);
});

test("policy: the expensive endpoint is the tighter one", () => {
  assert.ok(
    CHECKOUT_SESSION_RATE_LIMIT.max < CHECKOUT_QUOTE_RATE_LIMIT.max,
    "the endpoint that creates Stripe Customers must not be looser than the read-only one"
  );
  // Generous enough for a person: a checkout, a retry, and a shared
  // office NAT behind one address.
  assert.ok(CHECKOUT_SESSION_RATE_LIMIT.max >= 10);
  assert.ok(CHECKOUT_QUOTE_RATE_LIMIT.max >= 20);
  for (const p of [CHECKOUT_QUOTE_RATE_LIMIT, CHECKOUT_SESSION_RATE_LIMIT]) {
    assert.equal(p.windowMs, 10 * 60 * 1000);
    assert.equal(p.windowSeconds, 600);
  }
});

test("policy: the two answer differently when the shared counter is unreachable", () => {
  // A read that cannot be metered is still only a read.
  assert.equal(CHECKOUT_QUOTE_RATE_LIMIT.unavailable, "allow");
  // A Stripe Customer that cannot be metered is a durable object in
  // somebody else's system. Refusing is the recoverable direction.
  assert.equal(CHECKOUT_SESSION_RATE_LIMIT.unavailable, "refuse");
});

test("layer 1: normal traffic is allowed and the window is counted", () => {
  const state = new Map();
  for (let i = 0; i < CHECKOUT_QUOTE_RATE_LIMIT.max; i++) {
    const d = consumeLocalCheckoutRateLimit({
      policy: CHECKOUT_QUOTE_RATE_LIMIT, state, request: req(), nowMs: NOW,
    });
    assert.equal(d.allow, true, `request ${i + 1} was refused`);
  }
  const over = consumeLocalCheckoutRateLimit({
    policy: CHECKOUT_QUOTE_RATE_LIMIT, state, request: req(), nowMs: NOW,
  });
  assert.equal(over.allow, false);
  assert.equal(over.status, 429);
  assert.ok(over.retryAfterSeconds > 0, "a refusal must never say 'try again immediately'");
  assert.ok(over.retryAfterSeconds <= 600);
});

test("layer 1: one caller's flood does not refuse another caller", () => {
  const state = new Map();
  for (let i = 0; i <= CHECKOUT_SESSION_RATE_LIMIT.max; i++) {
    consumeLocalCheckoutRateLimit({
      policy: CHECKOUT_SESSION_RATE_LIMIT, state, request: req("198.51.100.1"), nowMs: NOW,
    });
  }
  const other = consumeLocalCheckoutRateLimit({
    policy: CHECKOUT_SESSION_RATE_LIMIT, state, request: req("198.51.100.2"), nowMs: NOW,
  });
  assert.equal(other.allow, true);
});

test("layer 1: the window reopens", () => {
  const state = new Map();
  for (let i = 0; i <= CHECKOUT_SESSION_RATE_LIMIT.max; i++) {
    consumeLocalCheckoutRateLimit({
      policy: CHECKOUT_SESSION_RATE_LIMIT, state, request: req(), nowMs: NOW,
    });
  }
  const later = consumeLocalCheckoutRateLimit({
    policy: CHECKOUT_SESSION_RATE_LIMIT, state, request: req(), nowMs: NOW + 600_001,
  });
  assert.equal(later.allow, true);
});

test("layer 1 refuses only on the count - it has nothing that can be unavailable", () => {
  // The in-process layer takes no client and no secret, so there is no
  // configuration state in which it can answer 503. That separation is
  // what lets the session endpoint keep answering 400 to a malformed
  // request without a database round trip.
  const d = consumeLocalCheckoutRateLimit({
    policy: CHECKOUT_SESSION_RATE_LIMIT, state: new Map(), request: req(), nowMs: NOW,
  });
  assert.equal(d.allow, true);
});

/** A stand-in for the shared counter, recording exactly what was sent. */
function rpcClient(response) {
  const calls = [];
  return {
    calls,
    rpc(fn, args) {
      calls.push({ fn, args });
      return Promise.resolve(response);
    },
  };
}

test("layer 2: the shared counter's verdict is honoured, with its Retry-After", async () => {
  const client = rpcClient({ data: [{ allowed: false, retry_after_seconds: 137 }], error: null });
  const d = await consumeSharedCheckoutRateLimit({
    policy: CHECKOUT_SESSION_RATE_LIMIT, request: req(), client, secret: "test-secret-not-real",
  });
  assert.equal(d.allow, false);
  assert.equal(d.status, 429);
  assert.equal(d.retryAfterSeconds, 137);
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].fn, "consume_launch_rate_limit");
});

test("layer 2: what travels is a digest - never an address, never an email", async () => {
  const client = rpcClient({ data: [{ allowed: true }], error: null });
  await consumeSharedCheckoutRateLimit({
    policy: CHECKOUT_QUOTE_RATE_LIMIT, request: req("203.0.113.44"), client, secret: "test-secret-not-real",
  });
  const { p_bucket_key: key, p_max: max, p_window_seconds: win } = client.calls[0].args;
  assert.match(key, /^[0-9a-f]{64}$/, "the bucket key is not the digest shape migration 043 requires");
  assert.equal(key.includes("203.0.113.44"), false);
  assert.equal(JSON.stringify(client.calls[0].args).includes("@"), false, "an email reached the rate limiter");
  assert.equal(max, CHECKOUT_QUOTE_RATE_LIMIT.max);
  assert.equal(win, 600);
});

test("layer 2: the same caller gets different buckets for quote and session", async () => {
  const keyFor = async policy => {
    const client = rpcClient({ data: [{ allowed: true }], error: null });
    await consumeSharedCheckoutRateLimit({
      policy, request: req("203.0.113.44"), client, secret: "test-secret-not-real",
    });
    return client.calls[0].args.p_bucket_key;
  };
  assert.notEqual(await keyFor(CHECKOUT_QUOTE_RATE_LIMIT), await keyFor(CHECKOUT_SESSION_RATE_LIMIT));
});

test("layer 2 unavailable: the quote lets it through, the session refuses", async () => {
  const broken = rpcClient({ data: null, error: { message: "connection reset" } });

  const quote = await consumeSharedCheckoutRateLimit({
    policy: CHECKOUT_QUOTE_RATE_LIMIT, request: req(), client: broken, secret: "test-secret-not-real",
  });
  assert.equal(quote.allow, true, "a database blip must not break a real customer's cart");

  const session = await consumeSharedCheckoutRateLimit({
    policy: CHECKOUT_SESSION_RATE_LIMIT, request: req(), client: broken, secret: "test-secret-not-real",
  });
  assert.equal(session.allow, false);
  assert.equal(session.status, 503);
  assert.equal(session.retryAfterSeconds, null);
});

test("layer 2 unconfigured: a missing secret or client is treated as unreachable", async () => {
  for (const [client, secret] of [[null, "s"], [rpcClient({ data: [{ allowed: true }], error: null }), null]]) {
    const session = await consumeSharedCheckoutRateLimit({
      policy: CHECKOUT_SESSION_RATE_LIMIT, request: req(), client, secret,
    });
    assert.equal(session.allow, false, "an unconfigured limiter must not silently switch itself off");
    assert.equal(session.status, 503);
  }
});

test("each layer is spent exactly once per request", async () => {
  // The route calls layer 1 at the top and layer 2 lower down. If one
  // function did both, every request would charge two slots against the
  // in-process counter and the effective local limit would be halved.
  const client = rpcClient({ data: [{ allowed: true }], error: null });
  const state = new Map();

  for (let i = 0; i < CHECKOUT_SESSION_RATE_LIMIT.max; i++) {
    const local = consumeLocalCheckoutRateLimit({
      policy: CHECKOUT_SESSION_RATE_LIMIT, state, request: req(), nowMs: NOW,
    });
    assert.equal(local.allow, true, `request ${i + 1} was refused early - a slot is being double-charged`);
    const shared = await consumeSharedCheckoutRateLimit({
      policy: CHECKOUT_SESSION_RATE_LIMIT, request: req(), client, secret: "test-secret-not-real",
    });
    assert.equal(shared.allow, true);
  }

  // Exactly one round trip per request, and the local counter is now
  // exactly full - not half-full and not double-spent.
  assert.equal(client.calls.length, CHECKOUT_SESSION_RATE_LIMIT.max);
  const over = consumeLocalCheckoutRateLimit({
    policy: CHECKOUT_SESSION_RATE_LIMIT, state, request: req(), nowMs: NOW,
  });
  assert.equal(over.allow, false);
});

/* ══════════════════════════════════════════════════════════════
   2. WHERE THE LIMIT SITS IN EACH ROUTE
   ══════════════════════════════════════════════════════════════ */

const indexOfAll = (source, needle) => {
  const i = source.indexOf(needle);
  assert.notEqual(i, -1, `missing: ${needle}`);
  return i;
};

test("quote route: the shared counter is spent above the catalog read it guards", () => {
  const route = read("app/api/checkout/quote/route.ts");
  const limit = indexOfAll(route, "client: getSupabaseAdmin(),");
  const catalogRead = indexOfAll(route, "await buildAuthoritativeQuote(validatedItems)");
  const pricing = indexOfAll(route, "buildQuoteDiscount(result.quote, discountCode)");
  assert.ok(limit < catalogRead, "the limit is below the Supabase read");
  assert.ok(limit < pricing, "the limit is below the discount pricing");
  // Layer 1 first, before the body is even parsed.
  assert.ok(indexOfAll(route, "const localLimit = consumeLocalCheckoutRateLimit(") < indexOfAll(route, "body = await request.json()"));
});

test("session route: layer 1 guards the whole endpoint, layer 2 guards what the gate guards", () => {
  const route = read("app/api/checkout/session/route.ts");
  const local = indexOfAll(route, "consumeLocalCheckoutRateLimit({");
  const shared = indexOfAll(route, "await consumeSharedCheckoutRateLimit({");
  const gate = indexOfAll(route, "const closed = checkoutRefusalFor(SHOP_STATUS);");
  const bodyRead = indexOfAll(route, "body = await request.json()");

  // LAYER 1 IS FIRST, before the body is even parsed, so a caller
  // posting rubbish in a loop is still counted.
  assert.ok(local < bodyRead, "layer 1 runs after the body is read");
  assert.ok(local < gate);

  // LAYER 2 SITS WITH THE THINGS IT PROTECTS - below the gate, not
  // above it. What makes this endpoint worth limiting is the Stripe
  // Customer, the attempt and the payable session underneath, and those
  // are exactly what the gate withholds. Putting the shared counter
  // above the gate would also mean a shut shop answered "temporarily
  // unavailable" instead of "not open yet", and paid a database round
  // trip to do it, for a request that could not have bought anything.
  //
  // The catalog read above the gate is left to layer 1 - see the route's
  // own note, and the quote endpoint, which carries the shared counter
  // ABOVE its read precisely because that is the one somebody would use
  // to mine the catalog.
  assert.ok(gate < shared, "the shared limit sits above the launch gate");
});

test("session route: the limit is spent before anything can be created", () => {
  const route = read("app/api/checkout/session/route.ts");
  const limit = indexOfAll(route, "client: getSupabaseAdmin(),");
  for (const sideEffect of [
    "getOrCreateCheckoutCustomerByEmail(",
    "getOrCreateCheckoutAttempt(",
    "stripe.checkout.sessions.create(",
    "linkStripeSession(",
  ]) {
    assert.ok(limit < indexOfAll(route, sideEffect), `${sideEffect} can run before the rate limit`);
  }
});

test("routes: neither endpoint buckets on an email address", () => {
  // A per-address limit would be a record of who tried to buy what and
  // when, kept in a table built to hold no personal data at all.
  for (const file of ["app/api/checkout/quote/route.ts", "app/api/checkout/session/route.ts"]) {
    const route = read(file);
    const block = route.slice(indexOfAll(route, "consumeSharedCheckoutRateLimit({"));
    const firstCallEnd = block.indexOf("});");
    const call = block.slice(0, firstCallEnd);
    for (const forbidden of ["email", "customerEmail", "Email"]) {
      assert.equal(call.includes(forbidden), false, `${file} passes ${forbidden} to the rate limiter`);
    }
  }
});

test("routes: each endpoint owns its own in-process map", () => {
  for (const file of ["app/api/checkout/quote/route.ts", "app/api/checkout/session/route.ts"]) {
    assert.match(read(file), /const rateLimitState: RateLimitState = new Map\(\);/);
  }
});

test("no second rate-limit system was invented", () => {
  const source = read("lib/checkoutRateLimit.ts");
  // The extension is the repo convention for a module node --test loads
  // directly (tsconfig: allowImportingTsExtensions), same as
  // lib/launchDiscountCart.ts.
  assert.match(source, /from "\.\/launchRateLimit\.ts"/);
  assert.match(source, /from "\.\/launchRateLimitStore\.ts"/);
  for (const f of ["redis", "upstash", "ioredis", "@vercel/kv"]) {
    assert.equal(source.toLowerCase().includes(f), false, `a second datastore (${f}) was introduced`);
  }
});

/* ══════════════════════════════════════════════════════════════
   3. THE LIVE ENDPOINTS

   Layer 1 only: the server runs without a service-role key, so the
   shared counter is unreachable and the quote policy lets that through
   while the session policy refuses it. Every request below carries a
   body that fails validation, so the limiter is the only thing being
   exercised - no catalog read, no Stripe call, no write.
   ══════════════════════════════════════════════════════════════ */

/**
 * Ports 8800-8804. Deliberately a block nothing else in tests/ touches:
 * node --test runs suites concurrently, so a port shared with another
 * file is not a flake but a guaranteed collision under the full suite.
 */
async function startServer(port, env = {}, preload = false) {
  const args = preload
    ? ["--import", "./tests/helpers/mockSupabaseFetch.mjs", ".output/server/index.mjs"]
    : [".output/server/index.mjs"];
  const child = spawn(process.execPath, args, {
    cwd: new URL("..", import.meta.url),
    env: preload
      ? { ...process.env, PORT: String(port), SUPABASE_SECRET_KEY: "test-mock-service-key-not-real", LAUNCH_RATE_LIMIT_SECRET: "test-mock-bucket-secret-not-real", ...env }
      : writeBlockedServerEnv({ PORT: String(port), ...env }),
    stdio: "ignore",
  });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      if ((await fetch(base)).ok) return { base, stop: () => child.kill() };
    } catch { /* not up yet */ }
    await delay(200);
  }
  child.kill();
  throw new Error(`server on ${port} did not become ready`);
}

/** A body that is rejected by validation, so nothing downstream runs. */
const INVALID = { items: [], shippingCountry: "DE" };

/**
 * A body that PASSES the shape checks and therefore reaches the shared
 * counter. validateQuoteItems asks only for a UUID and a positive
 * integer, so no catalog read is involved in getting this far - and when
 * the counter refuses, none happens at all.
 */
const WELL_FORMED = {
  items: [{ variantId: "00000000-0000-0000-0000-000000000000", quantity: 1 }],
  shippingCountry: "DE",
};

const post = (base, path, body, ip) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(ip ? { "x-forwarded-for": ip } : {}) },
    body: JSON.stringify(body),
  });

test("live quote: ordinary use is never refused, and the limit then holds", async () => {
  const server = await startServer(8800);
  try {
    // A handful of calls is what a real visit looks like - the cart only
    // reaches this endpoint when somebody presses Einlösen.
    for (let i = 0; i < 5; i++) {
      const res = await post(server.base, "/api/checkout/quote", INVALID, "203.0.113.10");
      assert.equal(res.status, 400, "an ordinary request was refused by the limiter");
    }

    // Past the ceiling, from the same caller.
    let limited = null;
    for (let i = 0; i < CHECKOUT_QUOTE_RATE_LIMIT.max + 5; i++) {
      const res = await post(server.base, "/api/checkout/quote", INVALID, "203.0.113.10");
      if (res.status === 429) { limited = res; break; }
    }
    assert.ok(limited, "the quote endpoint never refused a flood");
    const retryAfter = Number(limited.headers.get("retry-after"));
    assert.ok(retryAfter > 0, "no usable Retry-After - 'try again immediately' is the one answer a limit must not give");
    assert.ok(retryAfter <= CHECKOUT_QUOTE_RATE_LIMIT.windowSeconds);
    assert.equal((await limited.json()).error, CHECKOUT_RATE_LIMITED_MESSAGE);

    // A different caller is untouched.
    const other = await post(server.base, "/api/checkout/quote", INVALID, "203.0.113.11");
    assert.equal(other.status, 400);
  } finally {
    server.stop();
  }
});

test("live session: layer 1 bounds the endpoint whatever the request would otherwise get", async () => {
  const server = await startServer(8801);
  try {
    const body = {
      items: [{ variantId: "00000000-0000-0000-0000-000000000000", quantity: 1 }],
      requestId: "11111111-1111-1111-1111-111111111111",
      shippingCountry: "DE",
      email: "rate-limit@example.com",
    };

    let limited = null;
    const before = [];
    for (let i = 0; i < CHECKOUT_SESSION_RATE_LIMIT.max + 5; i++) {
      const res = await post(server.base, "/api/checkout/session", body, "203.0.113.20");
      if (res.status === 429) { limited = res; break; }
      before.push(res.status);
    }
    assert.ok(limited, `the session endpoint never refused a flood (saw ${[...new Set(before)].join(", ")})`);
    assert.ok(Number(limited.headers.get("retry-after")) > 0);
    assert.equal((await limited.json()).error, CHECKOUT_RATE_LIMITED_MESSAGE);

    // Up to the ceiling every request gets the same ordinary answer -
    // here the unavailable-product refusal, because the variant id is a
    // well-formed UUID the catalog does not hold - and only then does
    // layer 1 take over. Layer 1 therefore bounds this endpoint whatever
    // the request would otherwise have been told, and in both shop
    // states, which is what it is for while layer 2 waits below the gate.
    assert.equal(new Set(before).size, 1, `the answer changed under the flood: ${[...new Set(before)].join(", ")}`);
    assert.notEqual(before[0], 429);
  } finally {
    server.stop();
  }
});

test("live: a refused request reaches no Stripe call and writes nothing", async () => {
  // STRIPE_SECRET_KEY is unset on this server, so a request that got as
  // far as Stripe would answer 503 with the payment message. A 429 that
  // never becomes a 503 is the proof that it stopped earlier.
  const server = await startServer(8802);
  try {
    const body = {
      items: [{ variantId: "00000000-0000-0000-0000-000000000000", quantity: 1 }],
      requestId: "22222222-2222-2222-2222-222222222222",
      shippingCountry: "DE",
      email: "rate-limit@example.com",
    };
    const seen = new Set();
    for (let i = 0; i < CHECKOUT_SESSION_RATE_LIMIT.max + 3; i++) {
      const res = await post(server.base, "/api/checkout/session", body, "203.0.113.30");
      seen.add(res.status);
      const payload = await res.json();
      if (res.status === 429) {
        assert.equal(payload.error, CHECKOUT_RATE_LIMITED_MESSAGE);
        assert.equal(JSON.stringify(payload).includes("sessionId"), false);
        assert.equal(JSON.stringify(payload).includes("stripe"), false);
      }
    }
    assert.ok(seen.has(429), "the flood was never refused");
  } finally {
    server.stop();
  }
});

test("live quote: the shared counter's own refusal is passed through with its Retry-After", async () => {
  // THE QUOTE ENDPOINT, because it is the one whose shared counter is
  // reachable over HTTP today: the session endpoint's sits below the
  // launch gate, and the shop is prelaunch, so the gate answers first.
  // The session policy is proved by the unit tests above and by the
  // ordering assertions; this proves the wiring end to end - a verdict
  // from Postgres becomes a 429 with the seconds Postgres named.
  const server = await startServer(8803, {
    MOCK_SUPABASE_RPC: JSON.stringify([{ allowed: false, retry_after_seconds: 222 }]),
  }, true);
  try {
    const res = await post(server.base, "/api/checkout/quote", WELL_FORMED, "203.0.113.50");
    assert.equal(res.status, 429);
    assert.equal(res.headers.get("retry-after"), "222");
    assert.equal((await res.json()).error, CHECKOUT_RATE_LIMITED_MESSAGE);
  } finally {
    server.stop();
  }
});

// THAT A SHUT SHOP STILL ANSWERS 409 rather than the limiter's 503 is
// asserted where it belongs, against a server with Stripe configured:
// tests/shop-launch-gate.test.mjs, "3b: a fully valid checkout request
// is refused - with Stripe configured". It is the reason the shared
// counter sits below the gate rather than above it, and duplicating it
// here would mean two tests that have to be changed together.

test("live quote: an unreachable shared counter does NOT break the cart", async () => {
  const server = await startServer(8804, { MOCK_SUPABASE_RPC: "[]", MOCK_SUPABASE_STATUS: "500" }, true);
  try {
    // Same conditions that make the session policy answer 503. The quote
    // policy must get past the limiter instead and fail - or succeed -
    // on its own terms further down.
    const res = await post(server.base, "/api/checkout/quote", WELL_FORMED, "203.0.113.60");
    assert.notEqual(res.status, 429, "an unreachable counter refused a request");
    // The request DOES fail here - the mock answers only the rate-limit
    // rpc, so the catalog read below reports itself unavailable - and
    // that is the point: it got PAST the limiter and failed further
    // down, on its own terms. Distinguished by the sentence rather than
    // by the status, because both are 503 and only one of them is the
    // limiter refusing to let a customer price a code.
    assert.notEqual((await res.json()).error, CHECKOUT_RATE_LIMITED_MESSAGE,
      "an unreachable counter broke the cart");

    // And the malformed case is still answered as malformed rather than
    // as a rate limit, because validation runs above the shared counter.
    const bad = await post(server.base, "/api/checkout/quote", INVALID, "203.0.113.61");
    assert.equal(bad.status, 400);
  } finally {
    server.stop();
  }
});
