import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import {
  MAX_CHECKOUT_EMAIL_LEN,
  CHECKOUT_EMAIL_INVALID_MESSAGE,
  CHECKOUT_IDENTITY_CONFLICT_MESSAGE,
  normalizeCheckoutEmail,
  isValidCheckoutEmail,
  validateCheckoutEmail,
  classifyMappedStripeCustomer,
  verifyPaidSessionIdentity,
} from "../lib/checkoutIdentity.ts";
import {
  getOrCreateCheckoutCustomerByEmail,
  checkoutIdentityIdempotencyKey,
} from "../lib/checkoutCustomerIdentity.ts";

/**
 * 055 PHASE B - THE CHECKOUT KNOWS WHO IS BUYING.
 *
 * SAFE BY CONSTRUCTION. Not one test here constructs a Stripe client,
 * creates a Supabase client, reads an environment variable or opens a
 * socket. The identity flow is driven entirely through its injected
 * ports (lib/checkoutCustomerIdentity.ts), which is why every branch
 * below - the deleted Customer, the conflicting email, the lost race -
 * can be asserted without production gaining a single Stripe Customer
 * while the shop is still prelaunch.
 *
 * What this suite protects: the person who pays is the person the
 * attempt was created for, and neither half of that binding can be
 * chosen by a browser, changed by a retry, or quietly repaired.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf8");
const NEWLINE = String.fromCharCode(10);

/**
 * "Does this module TOUCH x?" is a question about code, not about prose.
 * Several of these modules explain in comments exactly which table they
 * must not reach and which field they must not read, so scanning the raw
 * source would make every well-documented refusal look like a violation.
 * The same helper the annual and refund suites use.
 */
const withoutComments = source => source
  .split(NEWLINE)
  .filter(line => {
    const t = line.trim();
    return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
  })
  .join(NEWLINE);
const readCode = rel => withoutComments(read(rel));

const sessionRoute = read("app/api/checkout/session/route.ts");
const sessionCode = withoutComments(sessionRoute);
const webhookRoute = read("app/api/stripe/webhook/route.ts");
const flow = read("lib/checkoutCustomerIdentity.ts");
const deps = read("lib/checkoutCustomerIdentityDeps.ts");
const depsCode = withoutComments(deps);
const rules = read("lib/checkoutIdentity.ts");
const attempts = read("lib/checkoutAttempts.ts");
const clientCall = read("app/createCheckoutSession.ts");
const site = read("app/GloaSite.tsx");

const EMAIL = "anna@example.com";
const CUSTOMER = "cus_TestIdentityAAAA";
const OTHER_CUSTOMER = "cus_TestIdentityBBBB";
const sha256 = value => createHash("sha256").update(value, "utf8").digest("hex");

/* ══════════════════════════════════════════════════════════════
   1. NORMALIZATION AND VALIDATION
   ══════════════════════════════════════════════════════════════ */

test("1: the canonical form is trim + lowercase, and nothing else", () => {
  assert.equal(normalizeCheckoutEmail("  Anna@Example.COM  "), EMAIL);
  assert.equal(normalizeCheckoutEmail("ANNA@EXAMPLE.COM"), EMAIL);
  assert.equal(normalizeCheckoutEmail(EMAIL), EMAIL);
  // Idempotent - normalizing a canonical value must not move it, or the
  // database CHECK (normalized_email = lower(btrim(...))) could reject a
  // value this module already accepted.
  assert.equal(normalizeCheckoutEmail(normalizeCheckoutEmail("  Anna@Example.COM ")), EMAIL);
});

test("1b: plus tags and dots are NOT folded - distinct addresses stay distinct", () => {
  // Merging these would merge people who consider themselves separate,
  // and an identity model that merges people is worse than one that
  // sometimes sees the same person twice.
  assert.notEqual(normalizeCheckoutEmail("anna+shop@example.com"), EMAIL);
  assert.notEqual(normalizeCheckoutEmail("an.na@example.com"), EMAIL);
});

test("1c: empty, malformed and over-long are all refused", () => {
  for (const bad of ["", "   ", "anna", "anna@", "@example.com", "anna@example", "a b@example.com"]) {
    assert.equal(isValidCheckoutEmail(normalizeCheckoutEmail(bad)), false, `accepted ${JSON.stringify(bad)}`);
  }
  assert.equal(MAX_CHECKOUT_EMAIL_LEN, 254);
  const atLimit = `${"a".repeat(254 - "@example.com".length)}@example.com`;
  assert.equal(atLimit.length, 254);
  assert.equal(isValidCheckoutEmail(atLimit), true);
  assert.equal(isValidCheckoutEmail(`a${atLimit}`), false, "255 characters must be refused");
});

test("1d: validateCheckoutEmail is the single boundary - it normalizes AND validates", () => {
  assert.deepEqual(validateCheckoutEmail("  Anna@Example.COM "), { ok: true, email: EMAIL });
  for (const bad of [undefined, null, 42, {}, [], "", "nope", `a${"b".repeat(260)}@example.com`]) {
    const result = validateCheckoutEmail(bad);
    assert.equal(result.ok, false, `accepted ${JSON.stringify(bad)}`);
    // One message for every refusal - which rule was broken is not
    // something an automated caller should be able to enumerate.
    assert.equal(result.error, CHECKOUT_EMAIL_INVALID_MESSAGE);
  }
});

test("1e: the rules module is a pure leaf - no imports, no env, no clock, no I/O", () => {
  assert.ok(!/^import /m.test(rules), "the identity rules must import nothing");
  for (const banned of ["process.env", "import.meta", "Date.now", "fetch(", "createClient"]) {
    assert.ok(!rules.includes(banned), `the identity rules reach ${banned}`);
  }
});

/* ══════════════════════════════════════════════════════════════
   2. THE MAPPED CUSTOMER: REUSE, REPAIR, REFUSE
   ══════════════════════════════════════════════════════════════ */

test("2: a Customer already carrying the authoritative email is reused", () => {
  assert.deepEqual(classifyMappedStripeCustomer({ kind: "present", email: EMAIL }, EMAIL), { action: "reuse" });
  // Stripe echoes back whatever casing the address was stored with.
  assert.deepEqual(classifyMappedStripeCustomer({ kind: "present", email: "Anna@Example.COM" }, EMAIL), { action: "reuse" });
});

test("2b: a Customer with NO email has the authoritative one established", () => {
  // The weak case migration 055's header describes: without an email on
  // the Customer, Checkout writes whatever the buyer types onto it.
  for (const empty of [null, "", "   "]) {
    assert.deepEqual(classifyMappedStripeCustomer({ kind: "present", email: empty }, EMAIL),
      { action: "establish_email" }, `email ${JSON.stringify(empty)} was not treated as absent`);
  }
});

test("2c: a Customer carrying a DIFFERENT email is refused, never overwritten", () => {
  const decision = classifyMappedStripeCustomer({ kind: "present", email: "someone-else@example.com" }, EMAIL);
  assert.equal(decision.action, "refuse");
  assert.match(decision.reason, /different email/);
  // The reason is a log line. It must not carry either address.
  assert.ok(!decision.reason.includes("someone-else"), "the refusal reason leaked an email");
  assert.ok(!decision.reason.includes(EMAIL), "the refusal reason leaked an email");
});

test("2d: a missing or deleted Customer is refused - the mapping is never repointed", () => {
  // Migration 055 grants SELECT and INSERT and deliberately no UPDATE,
  // so "just point it somewhere else" is not an option the runtime has.
  for (const [kind, pattern] of [["missing", /does not exist/], ["deleted", /is deleted/]]) {
    const decision = classifyMappedStripeCustomer({ kind }, EMAIL);
    assert.equal(decision.action, "refuse", `${kind} was not refused`);
    assert.match(decision.reason, pattern);
  }
});

/* ══════════════════════════════════════════════════════════════
   3. THE RESOLVER - EVERY BRANCH, NO STRIPE, NO DATABASE
   ══════════════════════════════════════════════════════════════ */

/**
 * A complete stand-in for the identity ports, with an in-memory mapping
 * table that enforces BOTH of 055's uniqueness rules - the primary key
 * on normalized_email and the unique constraint on stripe_customer_id -
 * because the race behaviour below is only meaningful if the fake
 * refuses exactly what the real table refuses.
 */
function fakeDeps(over = {}) {
  const byEmail = new Map(Object.entries(over.mapping ?? {}));
  const customers = new Map(Object.entries(over.customers ?? {}));
  const calls = { created: [], retrieved: [], emailSet: [], inserted: [], keys: [] };

  const base = {
    calls,
    byEmail,
    customers,
    async findMapping(email) {
      return byEmail.get(email) ?? null;
    },
    async createCustomer(email, idempotencyKey) {
      calls.created.push(email);
      calls.keys.push(idempotencyKey);
      const id = over.createdId ?? CUSTOMER;
      customers.set(id, { kind: "present", email });
      return id;
    },
    async retrieveCustomer(id) {
      calls.retrieved.push(id);
      return customers.get(id) ?? { kind: "missing" };
    },
    async setCustomerEmail(id, email) {
      calls.emailSet.push([id, email]);
      customers.set(id, { kind: "present", email });
    },
    async insertMapping(email, id) {
      calls.inserted.push([email, id]);
      if (byEmail.has(email)) return { ok: false, conflict: true, message: "duplicate key value (normalized_email)" };
      for (const held of byEmail.values()) {
        if (held === id) return { ok: false, conflict: true, message: "duplicate key value (stripe_customer_id)" };
      }
      byEmail.set(email, id);
      return { ok: true };
    },
    hash: sha256,
  };
  return { ...base, ...(over.ports ?? {}) };
}

test("3: no mapping - a Customer is created WITH the email, and the mapping is written", async () => {
  const d = fakeDeps();
  const result = await getOrCreateCheckoutCustomerByEmail(d, EMAIL);
  assert.deepEqual(result, { ok: true, stripeCustomerId: CUSTOMER, created: true });
  // The email is on the Customer at creation time - not set afterwards,
  // which would leave a window in which Checkout could overwrite it.
  assert.deepEqual(d.calls.created, [EMAIL]);
  assert.deepEqual(d.calls.emailSet, []);
  assert.deepEqual(d.calls.inserted, [[EMAIL, CUSTOMER]]);
  assert.equal(d.byEmail.get(EMAIL), CUSTOMER);
});

test("3b: an existing mapping whose Customer matches is reused, and nothing is created", async () => {
  const d = fakeDeps({ mapping: { [EMAIL]: CUSTOMER }, customers: { [CUSTOMER]: { kind: "present", email: EMAIL } } });
  const result = await getOrCreateCheckoutCustomerByEmail(d, EMAIL);
  assert.deepEqual(result, { ok: true, stripeCustomerId: CUSTOMER, created: false });
  assert.deepEqual(d.calls.created, [], "a second Customer was created for a known address");
  assert.deepEqual(d.calls.inserted, [], "the immutable mapping was written twice");
  assert.deepEqual(d.calls.retrieved, [CUSTOMER], "the mapped Customer was used without verifying it");
});

test("3c: an existing mapping whose Customer has no email gets it established first", async () => {
  const d = fakeDeps({ mapping: { [EMAIL]: CUSTOMER }, customers: { [CUSTOMER]: { kind: "present", email: null } } });
  const result = await getOrCreateCheckoutCustomerByEmail(d, EMAIL);
  assert.deepEqual(result, { ok: true, stripeCustomerId: CUSTOMER, created: false });
  assert.deepEqual(d.calls.emailSet, [[CUSTOMER, EMAIL]]);
  // The mapping already existed and is not rewritten.
  assert.deepEqual(d.calls.inserted, []);
});

test("3d: an existing mapping whose Customer carries a different email FAILS - as a conflict", async () => {
  const d = fakeDeps({
    mapping: { [EMAIL]: CUSTOMER },
    customers: { [CUSTOMER]: { kind: "present", email: "someone-else@example.com" } },
  });
  const result = await getOrCreateCheckoutCustomerByEmail(d, EMAIL);
  assert.equal(result.ok, false);
  assert.equal(result.conflict, true, "an identity conflict must not read as a transient outage");
  assert.match(result.reason, /different email/);
  assert.deepEqual(d.calls.emailSet, [], "a conflicting Customer was overwritten");
});

test("3e: a mapping pointing at a missing or deleted Customer FAILS CLOSED", async () => {
  for (const state of [undefined, { kind: "deleted" }]) {
    const d = fakeDeps({ mapping: { [EMAIL]: CUSTOMER }, customers: state ? { [CUSTOMER]: state } : {} });
    const result = await getOrCreateCheckoutCustomerByEmail(d, EMAIL);
    assert.equal(result.ok, false);
    assert.equal(result.conflict, true);
    // The mapping is untouched: no new Customer, no second row.
    assert.deepEqual(d.calls.created, [], "a replacement Customer was minted for a broken mapping");
    assert.deepEqual(d.calls.inserted, [], "the immutable mapping was rewritten");
    assert.equal(d.byEmail.get(EMAIL), CUSTOMER);
  }
});

test("3f: a Stripe creation failure yields no session and no mapping", async () => {
  const d = fakeDeps({ ports: { async createCustomer() { throw new Error("card_declined-ish outage"); } } });
  const result = await getOrCreateCheckoutCustomerByEmail(d, EMAIL);
  assert.equal(result.ok, false);
  assert.equal(result.conflict, false, "an outage must be retryable, not a permanent conflict");
  assert.match(result.reason, /stripe customer creation failed/);
  assert.equal(d.byEmail.size, 0);
});

test("3g: an unexpected mapping-insert failure refuses - never sells against an unrecorded identity", async () => {
  const d = fakeDeps({
    ports: { async insertMapping() { return { ok: false, conflict: false, message: "57014 statement timeout" }; } },
  });
  const result = await getOrCreateCheckoutCustomerByEmail(d, EMAIL);
  assert.equal(result.ok, false);
  assert.equal(result.conflict, false);
  assert.match(result.reason, /identity mapping failed/);
});

test("3h: a lookup failure is an outage, not a conflict", async () => {
  const d = fakeDeps({ ports: { async findMapping() { throw new Error("connection reset"); } } });
  const result = await getOrCreateCheckoutCustomerByEmail(d, EMAIL);
  assert.equal(result.ok, false);
  assert.equal(result.conflict, false);
  assert.match(result.reason, /identity lookup failed/);
});

test("3i: an empty email is refused before any port is touched", async () => {
  const d = fakeDeps();
  const result = await getOrCreateCheckoutCustomerByEmail(d, "");
  assert.equal(result.ok, false);
  assert.deepEqual(d.calls.created, []);
  assert.deepEqual(d.calls.inserted, []);
});

/* ══════════════════════════════════════════════════════════════
   4. CONCURRENCY - TWO CHECKOUTS, ONE PERSON, ONE IDENTITY
   ══════════════════════════════════════════════════════════════ */

test("4: the idempotency key is deterministic, per-address, and carries no address", () => {
  const key = checkoutIdentityIdempotencyKey(EMAIL, sha256);
  assert.equal(key, checkoutIdentityIdempotencyKey(EMAIL, sha256), "the key is not deterministic");
  assert.notEqual(key, checkoutIdentityIdempotencyKey("bob@example.com", sha256));
  // A key is echoed in Stripe's own request logs, so it is not a place
  // for personal data - the same rule lib/stripeCustomers.ts states.
  assert.ok(!key.includes(EMAIL));
  assert.ok(!key.includes("anna"));
  assert.ok(!key.includes("@"));
  assert.match(key, /^gloa-checkout-identity-[0-9a-f]{64}$/);
  // Distinct from the subscription helper's namespace, so a user's
  // Customer and an address's Customer can never collide in Stripe.
  assert.ok(!key.startsWith("gloa-customer-"));
});

test("4b: two concurrent first-time checkouts for one address converge on ONE Customer", async () => {
  // Stripe's idempotency key means both calls receive the same Customer;
  // the primary key on normalized_email decides who writes the row.
  const d = fakeDeps();
  const [a, b] = await Promise.all([
    getOrCreateCheckoutCustomerByEmail(d, EMAIL),
    getOrCreateCheckoutCustomerByEmail(d, EMAIL),
  ]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(a.stripeCustomerId, b.stripeCustomerId, "two checkouts produced two identities");
  assert.equal(d.byEmail.size, 1, "the address gained a second mapping row");
  assert.equal(d.calls.keys[0], d.calls.keys[1], "the two requests used different idempotency keys");
  // Exactly one of them reports having created it.
  assert.equal([a, b].filter(r => r.created).length, 1);
});

test("4c: the loser adopts the winner's row rather than competing with it", async () => {
  // The sequential shape of the same race: the mapping appears between
  // this request's read and its insert.
  let inserts = 0;
  const d = fakeDeps({
    ports: {
      async insertMapping(email, id) {
        inserts += 1;
        if (inserts === 1) {
          d.byEmail.set(email, id); // the winner's row lands first
          return { ok: false, conflict: true, message: "duplicate key value" };
        }
        return { ok: true };
      },
    },
  });
  const result = await getOrCreateCheckoutCustomerByEmail(d, EMAIL);
  assert.deepEqual(result, { ok: true, stripeCustomerId: CUSTOMER, created: false });
});

test("4d: a race that DIVERGED is refused - never sold against an unnamed identity", async () => {
  // Idempotency failed to converge and the winner recorded a different
  // Customer than this request holds. Continuing would create a session
  // against an identity the database does not name.
  const d = fakeDeps({
    ports: {
      async insertMapping(email) {
        d.byEmail.set(email, OTHER_CUSTOMER);
        return { ok: false, conflict: true, message: "duplicate key value" };
      },
    },
  });
  const result = await getOrCreateCheckoutCustomerByEmail(d, EMAIL);
  assert.equal(result.ok, false);
  assert.equal(result.conflict, true);
  assert.match(result.reason, /race diverged/);
  // The winner's row stands untouched.
  assert.equal(d.byEmail.get(EMAIL), OTHER_CUSTOMER);
});

test("4e: a 23505 from the stripe_customer_id side is refused, not reconciled", async () => {
  // Some OTHER address already owns this Customer. Two addresses behind
  // one Customer is exactly what 055's unique constraint forbids.
  const d = fakeDeps({
    ports: { async insertMapping() { return { ok: false, conflict: true, message: "duplicate key value (stripe_customer_id)" }; } },
  });
  const result = await getOrCreateCheckoutCustomerByEmail(d, EMAIL);
  assert.equal(result.ok, false);
  assert.equal(result.conflict, true);
  assert.match(result.reason, /no mapping exists for this email/);
});

test("4f: different addresses stay independent", async () => {
  const d = fakeDeps();
  const a = await getOrCreateCheckoutCustomerByEmail(d, EMAIL);
  const other = { ...d, createdId: undefined };
  // A second address must get its own Customer - the fake mints a fixed
  // id, so drive it through the real uniqueness rule instead.
  d.customers.set(OTHER_CUSTOMER, { kind: "present", email: "bob@example.com" });
  const saved = other.createCustomer;
  void saved;
  d.createCustomer = async (email, key) => {
    d.calls.created.push(email);
    d.calls.keys.push(key);
    d.customers.set(OTHER_CUSTOMER, { kind: "present", email });
    return OTHER_CUSTOMER;
  };
  const b = await getOrCreateCheckoutCustomerByEmail(d, "bob@example.com");
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.notEqual(a.stripeCustomerId, b.stripeCustomerId, "two people share one Stripe Customer");
  assert.equal(d.byEmail.size, 2);
});

/* ══════════════════════════════════════════════════════════════
   5. THE SESSION ROUTE - ORDERING, BINDING, AND WHAT IT REFUSES
   ══════════════════════════════════════════════════════════════ */

test("5: the browser may send an address and nothing derived from it", () => {
  assert.match(sessionRoute, /const \{ items, requestId, shippingCountry, email \} = body/);
  for (const forbidden of [
    "normalizedEmail", "customerKey", "stripeCustomerId:", "identityId",
    "trustedEmail", "eligibility", "discount",
    "body.email", "body.customer", "body.stripeCustomer",
  ]) {
    assert.ok(!sessionCode.includes(forbidden), `the session route reads ${forbidden} from the request`);
  }
  // The client sends the raw address only.
  assert.match(clientCall, /\n {4}email,\n/);
  for (const forbidden of ["normalizedEmail", "customerKey", "stripeCustomerId", "toLowerCase()"]) {
    assert.ok(!clientCall.includes(forbidden), `the client derives ${forbidden} itself`);
  }
});

test("5b: the address is validated by the shared rule, at the request boundary", () => {
  assert.match(sessionRoute, /validateCheckoutEmail\(email\)/);
  // And not by a second regex of its own.
  assert.ok(!/@\[\^\\s@\]|EMAIL_RE/.test(sessionRoute), "the route restates the email rule instead of sharing it");
  // The browser half uses the same function, so a typo is caught before
  // a request rather than by a 400 - but the server still decides.
  assert.match(site, /validateCheckoutEmail\(email\)/);
  assert.match(site, /import \{ validateCheckoutEmail \} from "\.\.\/lib\/checkoutIdentity"/);
});

test("5c: PRELAUNCH - the gate sits before every identity side effect", () => {
  const gateAt = sessionRoute.indexOf("checkoutRefusalFor(SHOP_STATUS)");
  assert.ok(gateAt > 0, "the launch gate vanished");
  // Nothing that creates a Stripe Customer, writes the identity map, or
  // creates a session may be reachable above it. A visitor to a closed
  // shop must not be able to mint an identity by POSTing at it.
  for (const sideEffect of [
    "checkoutIdentityDeps(stripe)",
    "getOrCreateCheckoutCustomerByEmail(",
    "findAttemptByRequestId(requestId)",
    "getOrCreateCheckoutAttempt(",
    "stripe.checkout.sessions.create(",
    "linkStripeSession(",
  ]) {
    const at = sessionRoute.indexOf(sideEffect);
    assert.ok(at > gateAt, `${sideEffect} can run before the launch gate`);
  }
  // Validation, by contrast, stays ABOVE it: a malformed request is told
  // it is malformed whether or not the shop is open.
  assert.ok(sessionRoute.indexOf("validateCheckoutEmail(email)") < gateAt,
    "email validation moved below the gate - a closed shop would stop answering 400s accurately");
});

test("5d: the Checkout Session is bound by `customer`, never by customer_email alone", () => {
  assert.match(sessionRoute, /customer: frozenStripeCustomerId,/);
  assert.ok(!/customer_email:/.test(sessionRoute),
    "customer_email only PREFILLS an editable field - it cannot be the identity lock");
  // The id handed to Stripe is read from the attempt's frozen column.
  assert.match(sessionRoute, /const frozenStripeCustomerId = attempt\.stripe_customer_id;/);
  const resolveAt = sessionRoute.indexOf("getOrCreateCheckoutCustomerByEmail(");
  const createAt = sessionRoute.indexOf("stripe.checkout.sessions.create(");
  assert.ok(resolveAt > 0 && resolveAt < createAt, "the Customer must be resolved before the session exists");
});

test("5e: the identity is resolved server-side and never borrowed from subscriptions", () => {
  // Section 15: a signed-in customer's one-time order is identified by
  // the checkout email like everyone else's. No hidden coupling.
  assert.ok(!sessionCode.includes("getOrCreateStripeCustomer"),
    "the one-time checkout reaches the subscription Customer helper");
  assert.ok(!sessionCode.includes("stripe_customers"),
    "the one-time checkout reads the subscription mapping table");
  // The bearer token still only ever decides which account an order is
  // LINKED to - it is not an identity source here.
  assert.match(sessionRoute, /const userId = await verifyUserId\(request\)/);
});

test("5f: an identity conflict is a 409 with a generic message; an outage is a 503", () => {
  assert.match(sessionRoute, /identity\.conflict\s*$/m);
  assert.match(sessionRoute, /status: identity\.conflict \? 409 : 503/);
  assert.match(sessionRoute, /CHECKOUT_IDENTITY_CONFLICT_MESSAGE/);
  // The customer-facing message says nothing about Stripe, mappings, or
  // another person's address.
  for (const leak of ["Stripe", "Customer", "cus_", "Mapping", "Datenbank"]) {
    assert.ok(!CHECKOUT_IDENTITY_CONFLICT_MESSAGE.includes(leak),
      `the customer-facing conflict message leaks "${leak}"`);
  }
  assert.match(CHECKOUT_IDENTITY_CONFLICT_MESSAGE, /support@gloamatcha\.com/);
});

test("5g: no raw address is ever logged", () => {
  // Every console.error in the route is inspected: none of them may
  // interpolate the email. The address already lives in four legitimate
  // places (section 25); a log line is not the fifth.
  const logs = sessionRoute.match(/console\.error\([^;]*\);/gs) ?? [];
  assert.ok(logs.length > 0, "the route stopped logging entirely");
  for (const line of logs) {
    assert.ok(!line.includes("customerEmail"), `a log line interpolates the address: ${line.slice(0, 90)}`);
    assert.ok(!line.includes("emailResult"), `a log line interpolates the address: ${line.slice(0, 90)}`);
  }
  // The identity helper's own reasons are logged, and they carry no
  // address either - asserted directly against the module.
  assert.ok(!/reason: `[^`]*\$\{normalizedEmail\}/.test(flow), "a refusal reason interpolates the address");
});

/* ══════════════════════════════════════════════════════════════
   6. THE ATTEMPT - FROZEN, AND UNCHANGEABLE BY A RETRY
   ══════════════════════════════════════════════════════════════ */

test("6: a new attempt freezes both halves of the identity", () => {
  assert.match(attempts, /customer_email: identity\?\.email \?\? null,/);
  assert.match(attempts, /stripe_customer_id: identity\?\.stripeCustomerId \?\? null,/);
  // Both columns are selected back, so the caller can verify what was
  // actually frozen rather than assume its own values were written.
  assert.match(attempts, /const ATTEMPT_COLUMNS =\s*\n?\s*"[^"]*customer_email, stripe_customer_id"/);
  assert.match(sessionRoute, /\{ email: customerEmail, stripeCustomerId \}/);
});

test("6b: the freeze is immutable - the upsert still ignores duplicates", () => {
  // This is what makes a retry keep the ORIGINAL identity, exactly as it
  // keeps the original prices, shipping zone and tax.
  assert.match(attempts, /\{ onConflict: "request_id", ignoreDuplicates: true \}/);
  assert.ok(!/\.update\(\{[^}]*customer_email/s.test(attempts),
    "something updates a frozen identity column");
  assert.ok(!/\.update\(\{[^}]*stripe_customer_id/s.test(attempts),
    "something updates a frozen identity column");
});

test("6c: a retry that arrives with a DIFFERENT address is refused, both ways round", () => {
  // Cheap path: the attempt is read before any Stripe write, so an
  // ordinary retry-with-a-new-address leaves no stray Customer behind.
  assert.match(sessionRoute, /const existingAttempt = await findAttemptByRequestId\(requestId\)/);
  assert.match(sessionRoute, /existingAttempt\.customer_email !== customerEmail/);
  // Authoritative path: whatever the upsert actually returns is compared
  // against what this request resolved, and divergence withholds the
  // session rather than settling against the frozen identity.
  assert.match(sessionRoute, /attempt\.customer_email !== customerEmail/);
  assert.match(sessionRoute, /attempt\.stripe_customer_id !== stripeCustomerId/);
  const compareAt = sessionRoute.indexOf("attempt.customer_email !== customerEmail");
  const createAt = sessionRoute.indexOf("stripe.checkout.sessions.create(");
  assert.ok(compareAt > 0 && compareAt < createAt, "the identity is compared after the session is created");
});

test("6d: an attempt with no identity at all cannot reach Stripe after Phase B", () => {
  // A new attempt that somehow came back without a Customer id is not
  // "a legacy row" - it is evidence of a bad write, and it stops here.
  assert.match(sessionRoute, /attempt\.stripe_customer_id === null \|\|/);
});

/* ══════════════════════════════════════════════════════════════
   7. THE WEBHOOK - BOTH BINDINGS, OR NOTHING
   ══════════════════════════════════════════════════════════════ */

const paid = (over = {}) => ({ customerEmail: EMAIL, customerId: CUSTOMER, ...over });
const frozen = (over = {}) => ({ customer_email: EMAIL, stripe_customer_id: CUSTOMER, ...over });

test("7: expected A / actual A, and the same Customer - verified", () => {
  assert.deepEqual(verifyPaidSessionIdentity(paid(), frozen()), { ok: true, kind: "verified" });
});

test("7b: casing and whitespace are the same identity", () => {
  assert.deepEqual(
    verifyPaidSessionIdentity(paid({ customerEmail: "  Anna@Example.com " }), frozen()),
    { ok: true, kind: "verified" }
  );
});

test("7c: expected A / actual B is REFUSED - and neither address is named", () => {
  const result = verifyPaidSessionIdentity(paid({ customerEmail: "bob@example.com" }), frozen());
  assert.equal(result.ok, false);
  assert.match(result.reason, /does not match/);
  assert.ok(!result.reason.includes("bob@example.com"), "the refusal reason leaked an address");
  assert.ok(!result.reason.includes(EMAIL), "the refusal reason leaked an address");
});

test("7d: the right email with the WRONG Customer is still refused", () => {
  // Section 23: both bindings matter. "The email happens to agree" is
  // not a reason to accept a session this attempt did not create.
  const result = verifyPaidSessionIdentity(paid({ customerId: OTHER_CUSTOMER }), frozen());
  assert.equal(result.ok, false);
  assert.match(result.reason, /stripe customer mismatch/);
  // Customer ids are opaque handles, not personal data - and naming them
  // is what makes the mismatch investigable.
  assert.ok(result.reason.includes(OTHER_CUSTOMER) && result.reason.includes(CUSTOMER));
});

test("7e: a paid session that reports no identity at all is refused", () => {
  for (const missing of [{ customerEmail: null }, { customerEmail: "" }, { customerId: null }]) {
    const result = verifyPaidSessionIdentity(paid(missing), frozen());
    assert.equal(result.ok, false, `accepted ${JSON.stringify(missing)}`);
  }
});

test("7f: LEGACY - a pre-055 attempt carries no identity and keeps the old path", () => {
  // 729 attempts and 458 orders were created before the columns existed.
  // Refusing them now would break fulfilment to punish a row for when it
  // was written.
  assert.deepEqual(
    verifyPaidSessionIdentity(paid(), frozen({ customer_email: null, stripe_customer_id: null })),
    { ok: true, kind: "legacy" }
  );
  // Even with no identity on the session either.
  assert.deepEqual(
    verifyPaidSessionIdentity({ customerEmail: null, customerId: null }, { customer_email: null, stripe_customer_id: null }),
    { ok: true, kind: "legacy" }
  );
});

test("7g: a HALF-written identity is a failure, not a legacy row", () => {
  for (const half of [{ customer_email: null }, { stripe_customer_id: null }]) {
    const result = verifyPaidSessionIdentity(paid(), frozen(half));
    assert.equal(result.ok, false, `accepted ${JSON.stringify(half)}`);
    assert.match(result.reason, /half-written/);
  }
});

test("7h: the webhook verifies before creating an order, and withholds only the order", () => {
  assert.match(webhookRoute, /verifyPaidSessionIdentity\(/);
  const verifyAt = webhookRoute.indexOf("verifyPaidSessionIdentity(");
  const orderAt = webhookRoute.indexOf("createOrderFromPaidCheckoutAttempt(");
  const paidAt = webhookRoute.indexOf("markAttemptPaid(attempt.id");
  assert.ok(verifyAt > 0 && verifyAt < orderAt, "an order can be created before the identity is verified");
  // The payment is still marked paid: it genuinely was paid, and that
  // fact must stay recorded. Only fulfilment is withheld - the same
  // convention the shipping-country mismatch already follows.
  assert.ok(paidAt > 0 && paidAt < verifyAt);
  assert.match(webhookRoute, /identity verification failed[^"]*fulfillment withheld/);
  // Nothing rewrites the frozen values to agree with Stripe.
  assert.ok(!/customer_email:\s*session\./.test(webhookRoute), "the webhook rewrites the frozen address");
});

test("7i: the session's Customer is read as an id whether or not Stripe expanded it", () => {
  assert.match(webhookRoute, /typeof session\.customer === "string" \? session\.customer : session\.customer\?\.id \?\? null/);
});

test("7j: the order snapshot still records the address Stripe settled", () => {
  // Section 24: unchanged. Verification guarantees it already equals the
  // frozen one, so the snapshot needs no new source.
  assert.match(webhookRoute, /const customerEmail = session\.customer_details\?\.email \?\? null;/);
});

/* ══════════════════════════════════════════════════════════════
   8. BOUNDARIES - WHAT PHASE B DID NOT TOUCH
   ══════════════════════════════════════════════════════════════ */

test("8: the identity map is reachable from the service-role adapter alone", () => {
  assert.ok(depsCode.includes("checkout_customer_identities"));
  for (const rel of ["app/api/checkout/session/route.ts", "app/GloaSite.tsx", "app/createCheckoutSession.ts",
                     "lib/checkoutIdentity.ts", "lib/checkoutCustomerIdentity.ts", "lib/checkoutAttempts.ts"]) {
    assert.ok(!readCode(rel).includes("checkout_customer_identities"),
      `${rel} reaches the identity map directly`);
  }
  // And it reaches the table with no verb migration 055 withheld. The
  // grant is SELECT and INSERT only, so an .update() on this table would
  // be a 42501 in production rather than a failing test - which is why
  // this asks about the TABLE's own chains, not about the file (the
  // adapter legitimately calls stripe.customers.update elsewhere).
  const tableVerbs = [...depsCode.matchAll(/\.from\("checkout_customer_identities"\)\s*\n?\s*\.(\w+)\(/g)]
    .map(m => m[1])
    .sort();
  assert.deepEqual(tableVerbs, ["insert", "select"],
    `the identity map is reached with ${tableVerbs.join(", ")} - 055 grants only select and insert`);
});

test("8b: the flow module is driven entirely by ports - no Stripe, no Supabase", () => {
  assert.ok(!flow.includes("getSupabaseAdmin"), "the flow reaches Supabase directly");
  assert.ok(!flow.includes('from "stripe"'), "the flow reaches Stripe directly");
  assert.ok(!flow.includes("process.env"));
  assert.match(flow, /deps: CheckoutIdentityDeps/);
});

test("8c: no PII is added to Stripe metadata", () => {
  // Section 25: the address lives in four places by design. Metadata is
  // not one of them, in either module.
  assert.ok(!/metadata:\s*\{[^}]*email/is.test(depsCode), "the adapter puts an address in Stripe metadata");
  const sessionMetadata = sessionCode.slice(sessionCode.indexOf("metadata: {"), sessionCode.indexOf("checkout_attempt_id"));
  assert.ok(!/email/i.test(sessionMetadata), "the Checkout Session metadata carries an address");
  // The Customer is created with the email and nothing else.
  assert.match(deps, /\{ email: normalizedEmail \},\s*\{ idempotencyKey \}/);
});

test("8d: the subscription Customer helper is untouched", () => {
  const helper = read("lib/stripeCustomers.ts");
  assert.match(helper, /export async function getOrCreateStripeCustomer\(\s*stripe: Stripe,\s*userId: string\s*\)/);
  assert.match(helper, /\.from\("stripe_customers"\)/);
  assert.match(helper, /metadata: \{ gloa_user_id: userId \}/);
  assert.match(helper, /inserted\.error\.code !== "23505"/);
  // It never learned about the checkout identity, and vice versa.
  assert.ok(!helper.includes("checkout_customer_identities"));
  assert.ok(!helper.includes("normalizeCheckoutEmail"));
});

test("8e: subscription and annual attempts still freeze no identity", () => {
  // They pass no identity, so both columns stay null - which the webhook
  // reads as "nothing to verify" for their own, separate handlers.
  const subscription = attempts.slice(attempts.indexOf("getOrCreateSubscriptionCheckoutAttempt"),
                                      attempts.indexOf("findAttemptByStripeSessionId"));
  assert.ok(!subscription.includes("customer_email:"), "the subscription writer now freezes an identity");
  const annual = attempts.slice(attempts.indexOf("getOrCreateAnnualCheckoutAttempt"),
                                attempts.indexOf("ANNUAL_PAYMENT_ATTEMPT_COLUMNS"));
  assert.ok(!annual.includes("customer_email:"), "the annual writer now freezes an identity");
});

test("8f: no launch code, no discount, no eligibility - 055 is identity only", () => {
  for (const rel of ["lib/checkoutIdentity.ts", "lib/checkoutCustomerIdentity.ts",
                     "lib/checkoutCustomerIdentityDeps.ts", "app/api/checkout/session/route.ts"]) {
    const src = readCode(rel);
    for (const banned of ["GLOALAUNCH10", "discountCode", "redemption", "first_order", "firstOrder", "coupon", "promotion_code"]) {
      assert.ok(!src.includes(banned), `${rel} mentions ${banned} - that is package 056`);
    }
  }
});

test("8g: commercial values, shipping, tax and the prelaunch flag are unchanged", () => {
  const shipping = read("lib/shipping.ts");
  assert.match(shipping, /germany: \{ shippingGrossCents: 590, freeShippingThresholdGrossCents: 4900 \}/);
  assert.match(shipping, /eu: \{ shippingGrossCents: 1290, freeShippingThresholdGrossCents: 7900 \}/);
  assert.match(read("lib/tax.ts"), /export const EU_B2C_TAX_MODE: EuB2cTaxMode = "german_origin";/);
  assert.match(read("app/content.ts"), /export const SHOP_STATUS = "prelaunch" as const;/);
  // The session still prices, ships and taxes exactly as before.
  for (const kept of ["validateQuoteItems(items)", "buildAuthoritativeQuote(validatedItems)",
                      "ALLOWED_SHIPPING_COUNTRIES.includes", "computeShippingGrossCents(",
                      "resolveCheckoutTax(", "idempotencyKey", 'mode: "payment"',
                      "success_url", "cancel_url", "request_id: requestId"]) {
    assert.ok(sessionRoute.includes(kept), `Phase B removed ${kept}`);
  }
});

/* ══════════════════════════════════════════════════════════════
   9. THE FIELD ITSELF
   ══════════════════════════════════════════════════════════════ */

test("9: the cart's email field is required, typed, and labelled", () => {
  const field = site.slice(site.indexOf('<div className="cart-email">'), site.indexOf('<div className="cart-shipping">'));
  assert.ok(field.length > 0, "the email field is not in the cart");
  assert.match(field, /<label className="cart-email-label" htmlFor="cart-email">E-MAIL<\/label>/);
  assert.match(field, /id="cart-email"/);
  assert.match(field, /type="email"/);
  assert.match(field, /autoComplete="email"/);
  assert.match(field, /inputMode="email"/);
  assert.match(field, /required/);
  assert.match(field, /maxLength=\{254\}/);
  // The error is announced, and the field points at whichever of the two
  // descriptions is currently rendered.
  assert.match(field, /aria-invalid=\{emailError\?"true":undefined\}/);
  assert.match(field, /aria-describedby=\{emailError\?"cart-email-error":"cart-email-note"\}/);
  assert.match(field, /role="alert"/);
});

test("9b: it is a checkout field, not an account prompt", () => {
  const field = site.slice(site.indexOf('<div className="cart-email">'), site.indexOf('<div className="cart-shipping">'));
  for (const banned of ["Passwort", "password", "Anmelden", "Konto erstellen", "Registrieren", "type=\"password\""]) {
    assert.ok(!field.includes(banned), `the checkout email field shows ${banned} - guests need no account`);
  }
});

test("9c: a signed-in address is a prefill, never an authority", () => {
  // Derived, not synced: the field shows the customer's own verified
  // address until they type over it, and a null `typedEmail` is what
  // distinguishes "has not typed" from "deliberately cleared it".
  assert.match(site, /const \[typedEmail,setTypedEmail\]=useState<string\|null>\(null\);/);
  assert.match(site, /const email=typedEmail\?\?user\?\.email\?\?"";/);
  // No effect writes this state - a prefill that fights the customer's
  // typing is worse than no prefill at all.
  assert.ok(!/useEffect\([^)]*setEmail/s.test(site), "the prefill syncs state from an effect");
  // The server validates whatever finally arrives regardless - asserted
  // where it counts, in the route.
  assert.match(sessionRoute, /validateCheckoutEmail\(email\)/);
});

test("9d: it uses the cart's own visual language, and no new colours", () => {
  const css = read("app/globals.css");
  // The field reuses the shipping select's rules rather than restating
  // them, so the two controls cannot drift apart.
  assert.match(css, /\.cart-shipping,\.cart-email\{/);
  assert.match(css, /\.cart-shipping-label,\.cart-email-label\{/);
  assert.match(css, /\.cart-shipping select,\.cart-email input\{width:100%/);
  // Errors use the same berry the cart's existing error uses.
  assert.match(css, /\.cart-email-error\{[^}]*color:var\(--berry\)\}/);
  // Width is relative, so the drawer stays mobile-safe.
  assert.ok(!/\.cart-email input\{[^}]*width:\d+px/.test(css));
});

test("9e: while the shop is prelaunch the field is not rendered at all", () => {
  // The prelaunch cart's CTA is "FRAGEN ZUM LAUNCH" and routes to
  // /contact - there is no checkout to collect an address for, and a
  // required field above a button that does not buy anything would both
  // confuse and collect for nothing. Gated on the SAME flag as the
  // legal note, so it returns with the checkout in one step.
  assert.match(site, /\{SHOP_STATUS!=="prelaunch"&&<div className="cart-email">/);
  assert.match(site, /SHOP_STATUS!=="prelaunch"&&<p className="cart-legal-note"/);
});
