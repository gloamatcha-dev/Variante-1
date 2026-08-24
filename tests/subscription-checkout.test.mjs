import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ALLOWED_REQUEST_FIELDS,
  FINGERPRINT_FIELDS,
  FINGERPRINT_VERSION,
  LAUNCH_SUBSCRIPTION_SKUS,
  PLAN_BILLING_INTERVAL_COUNT,
  PLAN_BILLING_INTERVAL_UNIT,
  SUBSCRIPTION_FEATURE_FLAG,
  SUBSCRIPTION_QUANTITY,
  attemptMatchesFingerprint,
  buildSubscriptionAddressSnapshot,
  buildSubscriptionLineItems,
  isSubscriptionCheckoutEnabled,
  parseSubscriptionCheckoutBody,
  subscriptionAddressDigest,
  subscriptionCheckoutIdempotencyKey,
  subscriptionRequestFingerprint,
  validateLaunchPlan,
} from "../lib/subscriptionCheckoutRules.ts";
import { computeShippingGrossCents, getShippingZone, normalizeCountryCode } from "../lib/shipping.ts";

// SAFE DEFAULT SUITE: pure logic and source-level checks only. Nothing
// here opens a socket, imports the Stripe SDK or touches a database, so
// no Stripe object and no production row can come out of running it.
//
// Task 29D-D builds the subscription checkout foundation. The things most
// worth protecting: the server-side feature gate stays shut, the browser
// cannot name a price, and the local subscription exists before Stripe
// does.

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf-8");
const NEWLINE = String.fromCharCode(10);

const MIGRATIONS = path.join(ROOT, "supabase/migrations");
const flow = read("lib/subscriptionCheckout.ts");
const deps = read("lib/subscriptionCheckoutDeps.ts");
const route = read("app/api/subscriptions/checkout/session/route.ts");
const plansLib = read("lib/subscriptionPlans.ts");
const subscriptionsLib = read("lib/subscriptions.ts");
const attemptsLib = read("lib/checkoutAttempts.ts");
const migration025 = read("supabase/migrations/025_grant_subscription_plans_service_role.sql");
const migration025Sql = migration025
  .split(NEWLINE)
  .filter(line => !line.trim().startsWith("--"))
  .join(NEWLINE);

const withoutComments = source => source
  .split(NEWLINE)
  .filter(line => {
    const t = line.trim();
    return !t.startsWith("--") && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
  })
  .join(NEWLINE);

const flowCode = withoutComments(flow);

const UUID = n => `${String(n).repeat(8)}-${String(n).repeat(4)}-${String(n).repeat(4)}-${String(n).repeat(4)}-${String(n).repeat(12)}`;
const PLAN_ID = UUID(1);
const VARIANT_ID = UUID(2);
const ADDRESS_ID = UUID(3);
const REQUEST_ID = UUID(4);
const USER_ID = UUID(5);

/** The 30 g launch plan exactly as migration 024 seeds it. */
const launchPlan = (overrides = {}) => ({
  id: PLAN_ID,
  slug: "matcha-30g-4w",
  name: "GLOA Matcha 30 g · alle 4 Wochen",
  description: "Lieferung alle 4 Wochen (28 Tage). Preis wie im Shop, kein Abo-Rabatt.",
  variant_id: VARIANT_ID,
  billing_interval_unit: "week",
  billing_interval_count: 4,
  delivery_interval_unit: "week",
  delivery_interval_count: 4,
  discount_percent: null,
  commitment_months: null,
  is_active: true,
  ...overrides,
});

const savedAddress = (overrides = {}) => ({
  id: ADDRESS_ID,
  user_id: USER_ID,
  first_name: "Test",
  last_name: "Kundin",
  company: null,
  street: "Teststraße",
  house_number: "1",
  zip: "10115",
  city: "Berlin",
  country: "Deutschland",
  ...overrides,
});

/** The delivery digest of the baseline address, and of a DIFFERENT Berlin one. */
const digestOf = address => subscriptionAddressDigest(
  buildSubscriptionAddressSnapshot(address, "DE").snapshot
);
const ADDRESS_DIGEST_A = digestOf(savedAddress());

/**
 * One exact checkout intent: 30 g at 19,99 to a Berlin address, German
 * shipping at 5,90, German VAT. Every fingerprint test varies exactly one
 * field of this.
 */
const baseIntent = () => ({
  userId: USER_ID,
  planId: PLAN_ID,
  addressId: ADDRESS_ID,
  addressDigest: ADDRESS_DIGEST_A,
  variantId: VARIANT_ID,
  quantity: 1,
  currency: "EUR",
  shippingCountry: "DE",
  shippingZone: "germany",
  shippingGrossCents: 590,
  subtotalGrossCents: 1999,
  totalGrossCents: 2589,
  taxCalculationVersion: "de-2026.1",
  taxTreatment: "de_domestic",
  taxTotalCents: 169,
});

/* ── A. The feature gate ────────────────────────────────────── */

test("gate: only the exact string \"true\" enables subscription checkout", () => {
  assert.equal(SUBSCRIPTION_FEATURE_FLAG, "B2C_SUBSCRIPTIONS_ENABLED");
  assert.equal(isSubscriptionCheckoutEnabled({ B2C_SUBSCRIPTIONS_ENABLED: "true" }), true);
  for (const value of [undefined, "", "false", "1", "TRUE", "True", "yes", " true ", "0"]) {
    assert.equal(
      isSubscriptionCheckoutEnabled({ B2C_SUBSCRIPTIONS_ENABLED: value }),
      false,
      `${JSON.stringify(value)} must not enable subscriptions`
    );
  }
  // Missing entirely is the production state today.
  assert.equal(isSubscriptionCheckoutEnabled({}), false);
});

test("gate: the flag is checked before any read, write or external call", () => {
  const gate = flowCode.indexOf("if (!deps.isEnabled())");
  assert.ok(gate > 0, "the handler must start with the gate");

  // Every side effect in the flow, and every one of them comes later.
  for (const effect of [
    "request.json()",
    "deps.verifyCaller(",
    "deps.resolvePlan(",
    "deps.buildQuote(",
    "deps.loadAddress(",
    "deps.ensureAttempt(",
    "deps.claimSubscription(",
    "deps.ensureStripeCustomer(",
    "deps.ensureRecurringPrice(",
    "stripe.checkout.sessions.create(",
    "deps.linkSession(",
  ]) {
    const at = flowCode.indexOf(effect);
    assert.ok(at > gate, `${effect} must not run before the feature gate`);
  }

  // And it is a server-side gate, not a hidden button: the flag is read
  // from process.env and never from anything the request carries.
  assert.match(withoutComments(read("lib/subscriptionCheckoutRules.ts")), /env\[SUBSCRIPTION_FEATURE_FLAG\] === "true"/);
  assert.ok(!/import\.meta\.env\[?["'`]?B2C_SUBSCRIPTIONS/.test(flow + deps), "the gate must not be a client-visible flag");
});

test("gate: the flag is documented as closed-by-default and not enabled anywhere", () => {
  const example = read(".env.example");
  assert.match(example, /B2C_SUBSCRIPTIONS_ENABLED=\s*$/m, "the example must leave it empty");
  assert.ok(!/B2C_SUBSCRIPTIONS_ENABLED=true/.test(example), "the example must not enable it");
});

/* ── B, C, D, E, F. What the browser may send ───────────────── */

test("request: exactly three non-commercial fields are accepted", () => {
  assert.deepEqual([...ALLOWED_REQUEST_FIELDS].sort(), ["addressId", "planId", "requestId"]);

  const ok = parseSubscriptionCheckoutBody({ planId: PLAN_ID, addressId: ADDRESS_ID, requestId: REQUEST_ID });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.request, { planId: PLAN_ID, addressId: ADDRESS_ID, requestId: REQUEST_ID });
});

test("request: a commercial or identity field is REFUSED, not ignored", () => {
  // Ignoring would be safe today and one careless destructure away from
  // unsafe tomorrow, so the body is rejected outright.
  const injections = [
    { unitAmount: 1 },
    { unitAmountCents: 1 },
    { price: 100 },
    { priceId: "price_evil" },
    { shippingGrossCents: 0 },
    { shippingAmount: 0 },
    { taxAmount: 0 },
    { quantity: 99 },
    { userId: USER_ID },
    { user_id: USER_ID },
    { stripeCustomerId: "cus_evil" },
    { customer: "cus_evil" },
    { stripeSubscriptionId: "sub_evil" },
    { status: "active" },
    { nextBillingDate: "2026-01-01" },
    { sku: "GLOA-CASE-01" },
    { variantId: VARIANT_ID },
  ];
  for (const extra of injections) {
    const result = parseSubscriptionCheckoutBody({
      planId: PLAN_ID, addressId: ADDRESS_ID, requestId: REQUEST_ID, ...extra,
    });
    assert.equal(result.ok, false, `${Object.keys(extra)[0]} was accepted`);
  }
});

test("request: malformed shapes and ids are rejected", () => {
  for (const body of [null, undefined, "string", 42, [], [{ planId: PLAN_ID }]]) {
    assert.equal(parseSubscriptionCheckoutBody(body).ok, false);
  }
  for (const field of ["planId", "addressId", "requestId"]) {
    const body = { planId: PLAN_ID, addressId: ADDRESS_ID, requestId: REQUEST_ID, [field]: "not-a-uuid" };
    assert.equal(parseSubscriptionCheckoutBody(body).ok, false, `${field} accepted a non-uuid`);
    const missing = { planId: PLAN_ID, addressId: ADDRESS_ID, requestId: REQUEST_ID };
    delete missing[field];
    assert.equal(parseSubscriptionCheckoutBody(missing).ok, false, `${field} may not be omitted`);
  }
});

test("auth: the user id comes from the verified token and nothing else", () => {
  // 401 for an unauthenticated caller: a subscription belongs to a
  // person, so there is no guest path here.
  assert.match(flowCode, /const caller = await deps\.verifyCaller\(request\);/);
  assert.match(flowCode, /if \(!caller\) \{\s*return fail\(401,/);
  // The user id is only ever read off the verified caller.
  assert.ok(!/body\.userId|parsed\.request\.userId|body as .*userId/.test(flowCode), "a user id is read from the body");
  // Every userId VALUE in the flow is caller.userId. The only other
  // matches are the type annotations in the dependency signatures.
  const userIdUses = [...flowCode.matchAll(/userId: ([A-Za-z.]+)/g)].map(m => m[1]);
  assert.ok(userIdUses.length > 0);
  for (const use of userIdUses) {
    assert.ok(use === "caller.userId" || use === "string", `userId came from ${use}`);
  }
  assert.ok(userIdUses.includes("caller.userId"));
  // The email is snapshot data, never an identifier.
  assert.match(flowCode, /customerSnapshot: \{ email: caller\.email/);
  assert.ok(!/\.eq\("email"|by email|email as identity/i.test(flowCode));
});

/* ── G, H. The plan ─────────────────────────────────────────── */

test("plan: the launch cadence is week / 4 on both billing and delivery", () => {
  assert.equal(PLAN_BILLING_INTERVAL_UNIT, "week");
  assert.equal(PLAN_BILLING_INTERVAL_COUNT, 4);
  assert.equal(validateLaunchPlan(launchPlan()).ok, true);
});

test("plan: any other cadence fails closed instead of being converted", () => {
  const rejected = [
    { billing_interval_unit: "month", billing_interval_count: 1 },
    { billing_interval_count: 1 },
    { billing_interval_count: 2 },
    { billing_interval_unit: null, billing_interval_count: null },
    { delivery_interval_unit: "month", delivery_interval_count: 1 },
    { delivery_interval_count: 2 },
    { delivery_interval_unit: null, delivery_interval_count: null },
  ];
  for (const overrides of rejected) {
    const result = validateLaunchPlan(launchPlan(overrides));
    assert.equal(result.ok, false, `${JSON.stringify(overrides)} was accepted`);
  }
  // No branch anywhere turns a month into four weeks: the only cadence
  // string literal in the rules is "week".
  const rulesCode = withoutComments(read("lib/subscriptionCheckoutRules.ts"));
  const cadenceLiterals = [...rulesCode.matchAll(/"(day|week|month|year)"/g)].map(m => m[1]);
  assert.deepEqual([...new Set(cadenceLiterals)], ["week"], "a second cadence appeared");
});

test("plan: inactive, unlinked, discounted or committed plans are refused", () => {
  assert.equal(validateLaunchPlan(null).ok, false);
  assert.equal(validateLaunchPlan(launchPlan({ is_active: false })).ok, false);
  assert.equal(validateLaunchPlan(launchPlan({ variant_id: null })).ok, false);
  // NULL means "not applicable". A number means somebody configured a
  // commercial condition this flow cannot honour.
  assert.equal(validateLaunchPlan(launchPlan({ discount_percent: 0 })).ok, false);
  assert.equal(validateLaunchPlan(launchPlan({ discount_percent: 10 })).ok, false);
  assert.equal(validateLaunchPlan(launchPlan({ commitment_months: 12 })).ok, false);
});

/* ── I, J, K, L. The product ────────────────────────────────── */

test("product: only the three Matcha launch SKUs may be subscribed", () => {
  assert.deepEqual([...LAUNCH_SUBSCRIPTION_SKUS], ["GLOA-MATCHA-30G", "GLOA-MATCHA-50G", "GLOA-MATCHA-100G"]);
  // An allowlist, not a "not the Metal Case" check: a fourth SKU must
  // fail closed rather than become subscribable by omission.
  assert.ok(!LAUNCH_SUBSCRIPTION_SKUS.includes("GLOA-CASE-01"), "the Metal Case must never be subscribable");
  assert.match(flowCode, /if \(!LAUNCH_SUBSCRIPTION_SKUS\.includes\(item\.sku\)\)/);
});

test("product: the variant comes from the PLAN, is re-priced server-side and must be EUR", () => {
  // The quote is built from plan.variant_id, never from a body field.
  assert.match(flowCode, /deps\.buildQuote\(\[\s*\{ variantId: plan\.variant_id as string, quantity: SUBSCRIPTION_QUANTITY \},?\s*\]\)/);
  // The same authoritative builder the one-time checkout uses, so an
  // inactive variant or an inactive product is already refused there.
  assert.match(deps, /buildQuote: buildAuthoritativeQuote/);
  assert.match(flowCode, /if \(quote\.currency !== "EUR"\)/);
  // Exactly one line: a subscription is one variant at launch.
  assert.match(flowCode, /if \(!item \|\| quote\.items\.length !== 1\)/);
});

test("quantity: fixed at 1 and never taken from the request", () => {
  assert.equal(SUBSCRIPTION_QUANTITY, 1);
  assert.ok(!ALLOWED_REQUEST_FIELDS.includes("quantity"));
  const lines = buildSubscriptionLineItems({ productPriceId: "price_p", shippingPriceId: null });
  assert.equal(lines[0].quantity, 1);
  // Quantity is part of the request fingerprint, so a retry claiming a
  // different one is a different intent rather than the same one.
  assert.notEqual(
    subscriptionRequestFingerprint(baseIntent()),
    subscriptionRequestFingerprint({ ...baseIntent(), quantity: 2 })
  );
  // And the flow refuses a frozen snapshot that does not say 1.
  assert.match(flowCode, /frozenItems\[0\]\.quantity !== SUBSCRIPTION_QUANTITY/);
});

/* ── M, N. The saved address ────────────────────────────────── */

test("address: only the id is trusted, and ownership is checked twice", () => {
  // The row is re-read; street, zip, city and country come from it.
  assert.match(flowCode, /deps\.loadAddress\(caller\.token, caller\.userId, addressId\)/);
  // RLS on a session-scoped client AND an explicit user_id filter.
  assert.match(deps, /getSupabaseAsUser\(token\)/);
  assert.match(deps, /\.eq\("id", addressId\)\s*\.eq\("user_id", userId\)/);
  assert.match(plansLib, /Authorization: `Bearer \$\{accessToken\}`/);
  // A neutral answer, so the response cannot probe for another
  // customer's address ids.
  assert.match(flowCode, /return fail\(404, "Adresse nicht gefunden oder unvollständig\."\)/);
  // No street, zip, city or country is ever read out of the request.
  for (const field of ["street", "house_number", "zip", "city", "shippingCountry"]) {
    assert.ok(!ALLOWED_REQUEST_FIELDS.includes(field));
  }
});

test("address: legacy German country NAMES still normalise, unknown ones stop the checkout", () => {
  // Migration 001 defaults addresses.country to 'Deutschland', so rows
  // written before Task 29D-B still hold names rather than codes.
  assert.equal(normalizeCountryCode("Deutschland"), "DE");
  assert.equal(normalizeCountryCode("Österreich"), "AT");
  assert.equal(normalizeCountryCode("DE"), "DE");
  // Unsupported or unparseable is null, and null must never become DE.
  assert.equal(normalizeCountryCode("US"), null);
  assert.equal(normalizeCountryCode("Atlantis"), null);
  assert.equal(normalizeCountryCode(""), null);

  const legacy = buildSubscriptionAddressSnapshot(savedAddress(), normalizeCountryCode("Deutschland"));
  assert.equal(legacy.ok, true);
  assert.equal(legacy.snapshot.country, "DE");

  const unknown = buildSubscriptionAddressSnapshot(savedAddress({ country: "Atlantis" }), normalizeCountryCode("Atlantis"));
  assert.equal(unknown.ok, false);
});

test("address: an incomplete saved address is refused rather than shipped to forever", () => {
  assert.equal(buildSubscriptionAddressSnapshot(null, "DE").ok, false);
  for (const blank of ["street", "house_number", "zip", "city"]) {
    const result = buildSubscriptionAddressSnapshot(savedAddress({ [blank]: "" }), "DE");
    assert.equal(result.ok, false, `an empty ${blank} was accepted`);
  }
  // Migration 001 defaults every one of these to an empty string, so this
  // is an ordinary row to encounter, not a corrupted one.
  assert.equal(buildSubscriptionAddressSnapshot(savedAddress({ first_name: "", last_name: "" }), "DE").ok, false);
});

test("address: the frozen snapshot has the same shape an order snapshot has", () => {
  const result = buildSubscriptionAddressSnapshot(savedAddress(), "DE");
  assert.deepEqual(result.snapshot, {
    name: "Test Kundin",
    company: null,
    line1: "Teststraße 1",
    line2: null,
    city: "Berlin",
    postalCode: "10115",
    state: null,
    country: "DE",
  });
  assert.equal(result.recipientName, "Test Kundin");
});

/* ── O, P, Q, R. Shipping ───────────────────────────────────── */

test("shipping: the amount comes from the existing rules, not from a new one", () => {
  // No zone table, no threshold and no price is redefined for
  // subscriptions - the flow calls the same functions the shop uses.
  assert.match(flowCode, /computeShippingGrossCents\(shippingZone, quote\.subtotalGrossCents\)/);
  assert.match(flowCode, /getShippingZone\(destinationCountry\)/);
  assert.ok(!/590|1290|1790|1990|4900|7900/.test(flowCode), "a shipping amount was hardcoded into the flow");
  // No subscription-only reduction: the computed amount is used as it is
  // and never scaled, discounted or zeroed on its way to Stripe.
  assert.ok(!/shippingGrossCents\s*[*/]|shippingGrossCents\s*-\s*\d/.test(flowCode), "the shipping amount was modified");
  assert.ok(!/discount|rabatt/i.test(flowCode), "a subscription shipping discount appeared");
});

test("shipping: the free-shipping threshold behaves exactly as the one-time rules", () => {
  // 30 g at 19,99 is below the German 49,00 threshold, so shipping is
  // charged; 100 g at 54,99 is above it, so it is free. Same numbers the
  // one-time checkout produces for the same cart.
  assert.equal(getShippingZone("DE"), "germany");
  assert.equal(computeShippingGrossCents("germany", 1999), 590);
  assert.equal(computeShippingGrossCents("germany", 2999), 590);
  assert.equal(computeShippingGrossCents("germany", 4900), 0);
  assert.equal(computeShippingGrossCents("germany", 5499), 0);
  // EU threshold is 79,00, so no single Matcha package reaches it.
  assert.equal(computeShippingGrossCents("eu", 5499), 1290);
  // Zones with no threshold always charge.
  assert.equal(computeShippingGrossCents("nonEuCore", 5499), 1790);
  assert.equal(computeShippingGrossCents("restOfEurope", 5499), 1990);
});

test("shipping: a chargeable line is a RECURRING price on the same week/4 cadence", () => {
  // Not a one-time charge and not a Stripe shipping_rate: a subscription
  // that collects shipping once would give the delivery away from the
  // second cycle onwards.
  assert.match(flowCode, /if \(frozenShippingGrossCents > 0\) \{/);
  assert.match(flowCode, /kind: "shipping",\s*identifier: frozenZone,/);
  assert.ok(!/shipping_options|shipping_rate_data|shipping_rate:/.test(flowCode), "a one-time shipping rate was used");
  // The zone KEY is the identifier, so a renamed customer-facing label
  // cannot mint a second Stripe Price for the same zone.
  assert.ok(!/identifier: shippingProductName|identifier: getCountryLabel/.test(flowCode));
  // The zone comes off the FROZEN attempt, so a retry cannot be shipped
  // into a different zone than the one the request was priced for.
  assert.match(flowCode, /const frozenZone = attempt\.shipping_zone;/);
  // Both lines go through the same helper, which is week/4 by construction.
  assert.match(deps, /ensureRecurringPrice: getOrCreateRecurringPrice/);
  const priceHelper = read("lib/stripeRecurringPrice.ts");
  assert.match(priceHelper, /SUBSCRIPTION_INTERVAL[^=]*= "week"/);
  assert.match(priceHelper, /SUBSCRIPTION_INTERVAL_COUNT = 4/);
});

test("shipping: free shipping creates no line at all, not a zero-value charge", () => {
  const free = buildSubscriptionLineItems({ productPriceId: "price_p", shippingPriceId: null });
  assert.equal(free.length, 1);
  assert.deepEqual(free, [{ price: "price_p", quantity: 1 }]);

  const charged = buildSubscriptionLineItems({ productPriceId: "price_p", shippingPriceId: "price_s" });
  assert.equal(charged.length, 2);
  assert.deepEqual(charged, [{ price: "price_p", quantity: 1 }, { price: "price_s", quantity: 1 }]);
});

/* ── S, T, U. Price and customer ────────────────────────────── */

test("price: the amount is the catalog amount, passed straight through", () => {
  assert.match(flowCode, /unitAmountCents: frozenItem\.unitGrossCents/);
  // Nothing multiplies, discounts or rounds it on the way to Stripe.
  assert.ok(!/unitGrossCents\s*[*+\-/]/.test(flowCode), "the catalog amount was modified");
  assert.ok(!/1999|2999|5499/.test(flowCode), "a catalog price was hardcoded");
  // And the quote itself reads product_variants.price_gross_cents.
  assert.match(read("lib/checkoutQuote.ts"), /unitGrossCents: variant\.price_gross_cents/);
});

test("customer: the Stripe Customer is resolved server-side from the user id", () => {
  assert.match(flowCode, /deps\.ensureStripeCustomer\(stripe, caller\.userId\)/);
  assert.match(deps, /ensureStripeCustomer: getOrCreateStripeCustomer/);
  assert.match(flowCode, /customer: customerResult\.stripeCustomerId/);
  assert.ok(!/customer: body|customer: parsed/.test(flowCode), "a customer id came from the request");
});

/* ── V, W, X, Y. Local subscription and correlation ─────────── */

test("subscription: the local row is created pending BEFORE the Stripe session", () => {
  const created = flowCode.indexOf("deps.claimSubscription(");
  const session = flowCode.indexOf("stripe.checkout.sessions.create(");
  assert.ok(created > 0 && session > 0);
  assert.ok(created < session, "the local subscription must exist before Stripe is asked for a session");

  // The RPC writes it as 'pending' and nothing in this task moves it.
  assert.match(read("supabase/migrations/022_recurring_subscription_foundation.sql"), /'pending',\s*$/m);
  assert.ok(!/status: "active"|'active'|activate_subscription_from_invoice/.test(flowCode + deps + route),
    "this task must not activate a subscription");
});

test("subscription: the local id is in subscription_data.metadata for invoice-first delivery", () => {
  assert.match(flowCode, /subscription_data: \{\s*metadata: \{[\s\S]*?gloa_subscription_id: subscriptionId,/);
  // Also on the session, for the checkout.session.completed path later.
  assert.match(flowCode, /metadata: \{\s*checkout_version: "1",[\s\S]*?gloa_subscription_id: subscriptionId,/);
  // Correlation only. Nothing sensitive goes into metadata.
  const metadataBlock = flowCode.slice(flowCode.indexOf("subscription_data:"), flowCode.indexOf("success_url"));
  for (const leak of ["email", "line1", "postalCode", "token", "secret", "unitAmount", "price_gross"]) {
    assert.ok(!metadataBlock.includes(leak), `metadata carries ${leak}`);
  }
});

test("subscription: invoice-first correlation does not depend on the session event", () => {
  // The whole reason the local row is pre-created and the id travels in
  // subscription_data.metadata: Stripe promises no ordering between
  // invoice.paid and checkout.session.completed.
  const link = flowCode.indexOf("deps.linkSession(");
  const metadata = flowCode.indexOf("gloa_subscription_id: subscriptionId");
  assert.ok(metadata < link, "the correlation must be set on Stripe before the local session link");
  // linkSession is best effort and its failure does not fail the request,
  // so a missing session link cannot strand a payment.
  assert.match(flowCode, /await deps\.linkSession\(attempt\.id, session\.id\);/);
  assert.ok(!/if \(!await deps\.linkSession|linked = await deps\.linkSession[\s\S]{0,80}return fail/.test(flowCode));
});

test("attempt: the checkout attempt carries the exact subscription_id", () => {
  // Migration 022's column, and the exact correlation the previous task
  // hardened. Not a second idempotency table.
  assert.match(attemptsLib, /subscription_id: string \| null;/);
  assert.match(flowCode, /checkoutAttemptId: attempt\.id,/);
  assert.ok(!/create table|insert into/i.test(withoutComments(attemptsLib)), "a second idempotency table appeared");
  // The subscription_id link is written by the database function, so no
  // application code updates that column any more.
  assert.ok(!/subscription_id: subscriptionId/.test(withoutComments(attemptsLib)),
    "an application-level link survived");
  assert.match(migration025Sql, /set subscription_id = v_subscription_id/);
});

/* ── 17. The claim is atomic in PostgreSQL ──────────────────── */

test("atomic claim: the race-prone application-level link is gone", () => {
  // The previous shape was read subscription_id, create, then link, with
  // a window in which two concurrent requests both read NULL. It is not
  // narrowed here, it is removed.
  for (const [name, source] of [["attempts", attemptsLib], ["deps", deps], ["flow", flow], ["subscriptions", subscriptionsLib]]) {
    assert.ok(!/attachSubscriptionToAttempt/.test(source), `${name} still references the removed linker`);
  }
  assert.ok(!/createPendingSubscription/.test(withoutComments(deps)), "the deps still call the unguarded creator");
  // And no JavaScript workaround took its place.
  assert.ok(!/setTimeout|sleep|Mutex|mutex|retryLoop|while \(true\)/.test(flowCode + withoutComments(deps)),
    "a process-local workaround appeared instead of a database guarantee");
  // Exactly one call decides it.
  assert.equal([...flowCode.matchAll(/deps\.claimSubscription\(/g)].length, 1);
});

test("atomic claim: the RPC locks the attempt row before it decides anything", () => {
  const fn = migration025Sql.slice(
    migration025Sql.indexOf("create or replace function public.claim_pending_subscription_for_attempt"),
    migration025Sql.indexOf("revoke all on function")
  );
  assert.ok(fn.length > 0, "the claim function must exist in migration 025");

  const lock = fn.indexOf("for update");
  const earlyReturn = fn.indexOf("return v_attempt.subscription_id;");
  const create = fn.indexOf("public.create_pending_subscription(");
  const link = fn.indexOf("set subscription_id = v_subscription_id");

  assert.ok(lock > 0, "the attempt row must be locked");
  assert.match(fn, /where id = p_checkout_attempt_id\s*for update;/);
  // The order IS the guarantee: lock, then look, then create only if the
  // look found nothing, then link - all inside one function call and
  // therefore one transaction.
  assert.ok(lock < earlyReturn, "the lock must precede the already-claimed check");
  assert.ok(earlyReturn < create, "an already-claimed attempt must return before anything is created");
  assert.ok(create < link, "the link must follow the creation it links");
  assert.match(fn, /if v_attempt\.subscription_id is not null then/);

  // It calls the approved creator rather than copying subscription
  // creation, so 022's atomicity and tax rules still apply unchanged.
  assert.match(fn, /v_subscription_id := public\.create_pending_subscription\(/);
  assert.ok(!/insert into public\.subscriptions|insert into public\.subscription_items/.test(fn),
    "the claim must not reimplement subscription creation");
});

test("atomic claim: the RPC refuses another user's attempt and a one-time attempt", () => {
  const fn = migration025Sql.slice(
    migration025Sql.indexOf("create or replace function public.claim_pending_subscription_for_attempt"),
    migration025Sql.indexOf("revoke all on function")
  );
  // A subscription created against somebody else's attempt would be
  // billed to the wrong person.
  assert.match(fn, /if v_attempt\.user_id is distinct from p_user_id then/);
  assert.match(fn, /does not belong to this user/);
  // A NULL fingerprint means the attempt came from the one-time payment
  // flow, which was never priced as a subscription.
  assert.match(fn, /if v_attempt\.subscription_request_fingerprint is null then/);
  assert.match(fn, /is not a subscription checkout/);
  assert.match(fn, /if v_attempt\.status = 'paid' then/);
  assert.match(fn, /raise exception 'checkout attempt % not found'/);
});

test("atomic claim: the claim contract yields one subscription for two concurrent callers", () => {
  // An executable model of the SQL above: a lock that serialises, a
  // check, and a create only when the check found nothing. This proves
  // the CONTRACT the function encodes; it does not execute PostgreSQL.
  // See the honesty note in the final report - no database was available
  // to run the real thing.
  let row = { subscription_id: null };
  let created = 0;
  const claim = () => {
    // select ... for update: callers are serialised on this row, and the
    // second one reads the version the first one committed.
    if (row.subscription_id !== null) return row.subscription_id;
    created += 1;
    row = { subscription_id: `sub_${created}` };
    return row.subscription_id;
  };

  const first = claim();
  const second = claim();

  assert.equal(created, 1, "two concurrent callers created two subscriptions");
  assert.equal(first, second, "the callers must receive the same subscription id");
  assert.equal(row.subscription_id, first, "the attempt must own the one that was returned");
});

/* ── Z, AA. Idempotency ─────────────────────────────────────── */

test("idempotency: an identical retry converges instead of creating a second of anything", () => {
  // The attempt is the anchor and is upserted with ignoreDuplicates, so a
  // retry gets the ORIGINAL frozen snapshot back rather than a repriced one.
  assert.match(attemptsLib, /onConflict: "request_id", ignoreDuplicates: true/);
  // The subscription decision is ONE database call, not a read followed
  // by a write with a window between them.
  assert.match(flowCode, /const claimed = await deps\.claimSubscription\(/);
  // And the Stripe session uses one deterministic key per attempt.
  assert.equal(subscriptionCheckoutIdempotencyKey("abc"), "gloa-sub-checkout-abc");
  assert.equal(
    subscriptionCheckoutIdempotencyKey(REQUEST_ID),
    subscriptionCheckoutIdempotencyKey(REQUEST_ID),
    "the key must be deterministic"
  );
  assert.notEqual(subscriptionCheckoutIdempotencyKey("a"), subscriptionCheckoutIdempotencyKey("b"));
  // Derived from an internal id only: no email, name, address or user id.
  for (const leak of ["@", "email", "Test", "Kundin", "Berlin", USER_ID]) {
    assert.ok(!subscriptionCheckoutIdempotencyKey(REQUEST_ID).includes(leak), `the key leaks ${leak}`);
  }
});

test("idempotency: the Checkout Session creation receives the deterministic key", () => {
  assert.match(flowCode, /\{ idempotencyKey: subscriptionCheckoutIdempotencyKey\(attempt\.id\) \}/);
  // Tied to the attempt, which is server-generated and stable across
  // retries of one request_id.
  assert.ok(!/idempotencyKey: `?\$\{?requestId/.test(flowCode));
});

/* -- 18. Exact retry identity -------------------------------- */

test("fingerprint: the same exact request produces the same digest", () => {
  const a = subscriptionRequestFingerprint(baseIntent());
  const b = subscriptionRequestFingerprint(baseIntent());
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/, "a sha-256 hex digest");
  assert.equal(attemptMatchesFingerprint(a, b), true);
  assert.match(flowCode, /if \(!attemptMatchesFingerprint\(attempt\.subscription_request_fingerprint, fingerprint\)\)/);
  assert.match(flowCode, /return fail\(409, "Diese Anfrage-ID gehört zu einem anderen Vorgang\."\)/);
});

test("fingerprint: a NULL or empty stored fingerprint is refused, not waved through", () => {
  const fp = subscriptionRequestFingerprint(baseIntent());
  // A one-time payment attempt has no subscription intent, and reaching
  // one is as easy as sending a request_id that already exists.
  assert.equal(attemptMatchesFingerprint(null, fp), false);
  assert.equal(attemptMatchesFingerprint(undefined, fp), false);
  assert.equal(attemptMatchesFingerprint("", fp), false);
  assert.equal(attemptMatchesFingerprint("something-else", fp), false);
  // The database refuses it too, so the guarantee does not rest on the
  // application remembering to check.
  assert.match(migration025Sql, /if v_attempt\.subscription_request_fingerprint is null then/);
});

test("fingerprint: a different user, plan or address cannot share one request id", () => {
  const base = subscriptionRequestFingerprint(baseIntent());
  assert.notEqual(base, subscriptionRequestFingerprint({ ...baseIntent(), userId: UUID(9) }), "another user");
  assert.notEqual(base, subscriptionRequestFingerprint({ ...baseIntent(), planId: UUID(9) }), "another plan");
  assert.notEqual(base, subscriptionRequestFingerprint({ ...baseIntent(), addressId: UUID(9) }), "another address");
});

test("fingerprint: two different addresses in the SAME country are different intents", () => {
  // The previous check compared only the destination country. Two Berlin
  // addresses are both DE and are two different delivery intents.
  const otherBerlin = savedAddress({ street: "Andere Strasse", house_number: "5", zip: "10999" });
  const sameCountryOtherAddress = {
    ...baseIntent(),
    addressId: UUID(9),
    addressDigest: digestOf(otherBerlin),
  };
  assert.equal(sameCountryOtherAddress.shippingCountry, baseIntent().shippingCountry, "both must be DE");
  assert.notEqual(
    subscriptionRequestFingerprint(baseIntent()),
    subscriptionRequestFingerprint(sameCountryOtherAddress),
    "two Berlin addresses shared one request id"
  );
});

test("fingerprint: editing the CONTENTS of the same saved address is a different intent", () => {
  // addressId is unchanged; the street is not. Binding only the id would
  // let one request id cover two different streets, and the retry would
  // create a subscription delivered somewhere the first request never
  // described.
  const edited = savedAddress({ street: "Umgezogen", house_number: "7", zip: "20095", city: "Hamburg" });
  const afterEdit = { ...baseIntent(), addressDigest: digestOf(edited) };
  assert.equal(afterEdit.addressId, baseIntent().addressId, "the address id is deliberately unchanged");
  assert.notEqual(
    subscriptionRequestFingerprint(baseIntent()),
    subscriptionRequestFingerprint(afterEdit),
    "an edited address was treated as the same delivery intent"
  );
  // A recipient rename counts too: the name is frozen onto the shipping
  // snapshot, so changing it changes what would have been frozen.
  assert.notEqual(ADDRESS_DIGEST_A, digestOf(savedAddress({ last_name: "Andere" })));
  assert.notEqual(ADDRESS_DIGEST_A, digestOf(savedAddress({ company: "Firma" })));
});

test("fingerprint: a different product, amount or shipping is a different intent", () => {
  const base = subscriptionRequestFingerprint(baseIntent());
  const varied = [
    ["another variant", { variantId: UUID(9) }],
    ["another price", { subtotalGrossCents: 2199, totalGrossCents: 2789 }],
    ["another shipping amount", { shippingGrossCents: 0, totalGrossCents: 1999 }],
    ["another zone", { shippingZone: "eu" }],
    ["another country", { shippingCountry: "AT" }],
    ["another currency", { currency: "CHF" }],
    ["another tax total", { taxTotalCents: 200 }],
    ["another tax version", { taxCalculationVersion: "de-2027.1" }],
    ["another treatment", { taxTreatment: "de_origin_intra_eu" }],
  ];
  for (const [label, overrides] of varied) {
    assert.notEqual(base, subscriptionRequestFingerprint({ ...baseIntent(), ...overrides }), label);
  }
});

test("fingerprint: EVERY declared field actually changes the digest", () => {
  // Guards against a field being listed in the contract but silently
  // dropped from the serialisation.
  const base = subscriptionRequestFingerprint(baseIntent());
  for (const field of FINGERPRINT_FIELDS) {
    const mutated = { ...baseIntent() };
    mutated[field] = typeof mutated[field] === "number" ? mutated[field] + 1 : `${mutated[field]}-changed`;
    assert.notEqual(subscriptionRequestFingerprint(mutated), base, `${field} does not affect the fingerprint`);
  }
  assert.equal(FINGERPRINT_FIELDS.length, Object.keys(baseIntent()).length, "the contract and the intent disagree");
});

test("fingerprint: the canonical order is the declared array, not JS key order", () => {
  const forward = baseIntent();
  const reversed = {};
  for (const key of Object.keys(forward).reverse()) reversed[key] = forward[key];
  assert.notDeepEqual(Object.keys(forward), Object.keys(reversed), "the two objects must differ in key order");
  assert.equal(
    subscriptionRequestFingerprint(forward),
    subscriptionRequestFingerprint(reversed),
    "the digest depends on JavaScript property order"
  );
  assert.equal(FINGERPRINT_VERSION, "gloa-sub-fp-1");
});

test("fingerprint: nothing personal survives into the stored value", () => {
  const fp = subscriptionRequestFingerprint(baseIntent());
  for (const leak of ["Teststra", "Berlin", "10115", "Test", "Kundin", "@", "Deutschland"]) {
    assert.ok(!fp.includes(leak), `the fingerprint leaks ${leak}`);
  }
  assert.match(ADDRESS_DIGEST_A, /^[0-9a-f]{64}$/);
  // The flow hashes the address before building the fingerprint, so no
  // raw address value is ever an input to the stored column.
  assert.match(flowCode, /addressDigest: subscriptionAddressDigest\(addressSnapshot\)/);
  assert.match(withoutComments(read("lib/subscriptionCheckoutRules.ts")), /createHash\("sha256"\)/);
  // And the value itself is never logged.
  assert.ok(!/console\.error\([^)]*\$\{fingerprint\}/.test(flowCode), "the fingerprint value reaches a log line");
});

/* -- 14. A retry never re-freezes an existing subscription ---- */

test("retry: an existing subscription is reused untouched, not rebuilt from current data", () => {
  // The RPC returns early on an already-claimed attempt, so nothing is
  // recomputed into it: not the catalog price, not shipping, not tax and
  // not the address.
  const fn = migration025Sql.slice(
    migration025Sql.indexOf("create or replace function public.claim_pending_subscription_for_attempt"),
    migration025Sql.indexOf("revoke all on function")
  );
  assert.match(fn, /if v_attempt\.subscription_id is not null then\s*return v_attempt\.subscription_id;/);
  assert.ok(!/update public\.subscriptions|update public\.subscription_items/.test(fn),
    "the claim mutates an existing subscription");

  // And once the attempt exists, the flow prices from the FROZEN
  // snapshot rather than from this request's fresh quote, so a
  // display-only catalog edit between a request and its retry cannot
  // change what gets frozen either.
  assert.match(flowCode, /identifier: frozenItem\.sku/);
  assert.match(flowCode, /unitAmountCents: frozenItem\.unitGrossCents/);
  assert.match(flowCode, /unitAmountCents: frozenShippingGrossCents/);
  assert.match(flowCode, /taxSnapshot: frozenTaxSnapshot/);
  assert.match(flowCode, /items: frozenItems/);
});

/* ── AB, AC, AD, AE, AG, AH. The Stripe session ─────────────── */

test("session: mode is subscription and both lines are recurring Prices", () => {
  assert.match(flowCode, /mode: "subscription"/);
  assert.ok(!/mode: "payment"/.test(flowCode), "the subscription flow must not run in payment mode");
  // Reusable Price ids, never inline price_data: an inline price mints a
  // fresh Price object for every abandoned checkout.
  assert.match(flowCode, /line_items: buildSubscriptionLineItems\(/);
  assert.ok(!/price_data/.test(flowCode), "an inline price was used");
  const lines = buildSubscriptionLineItems({ productPriceId: "price_p", shippingPriceId: "price_s" });
  for (const line of lines) {
    assert.ok(typeof line.price === "string" && line.price.length > 0);
    assert.equal(line.quantity, SUBSCRIPTION_QUANTITY);
  }
});

test("session: the return URLs go to the account area and promise nothing", () => {
  assert.match(flowCode, /success_url: `\$\{origin\}\/account\/subscriptions\?subscription=processing`/);
  assert.match(flowCode, /cancel_url: `\$\{origin\}\/account\/subscriptions\?subscription=cancelled`/);
  // The origin is the configured one, never a request header.
  assert.match(deps, /getOrigin: getSiteOrigin/);
  assert.ok(!/x-forwarded-host|request\.headers\.get\("host"\)|"origin"\)/i.test(flowCode + deps));
  // A return from Stripe is not payment proof, so no success wording.
  assert.ok(!/aktiv|bezahlt|erfolgreich/i.test(flowCode.match(/success_url[^`]*`[^`]*`/)?.[0] ?? ""));
});

test("session: the created session id is persisted through the existing helper", () => {
  assert.match(flowCode, /deps\.linkSession\(attempt\.id, session\.id\)/);
  assert.match(deps, /linkSession: linkStripeSession/);
  // Never a fabricated Stripe Subscription id: at session creation time
  // the Stripe subscription does not exist yet.
  assert.ok(!/stripe_subscription_id/.test(flowCode + deps), "a stripe subscription id was written too early");
});

test("session: a cancel return does not delete or cancel the local pending row", () => {
  assert.ok(!/delete|\.remove\(|cancel_at_period_end|subscriptions\.cancel/i.test(
    flowCode.replace(/cancel_url[^,]*,/g, "").replace(/cancelled/g, "")
  ), "the cancel path destroys local state");
});

/* ── AI, AJ, AK, AL, AM. Boundaries ─────────────────────────── */

test("boundary: no order is created anywhere in this task", () => {
  // Comment-stripped: these files are allowed to EXPLAIN that order
  // creation belongs to invoice.paid in Task 29D-E, just not to do it.
  for (const [name, source] of [["flow", flowCode], ["deps", withoutComments(deps)], ["route", withoutComments(route)], ["subscriptions", withoutComments(subscriptionsLib)]]) {
    assert.ok(!/create_order_from_paid_checkout|createOrderFromPaidCheckoutAttempt/.test(source), `${name} creates an order`);
    assert.ok(!/from\("orders"\)|from\("order_items"\)/.test(source), `${name} writes an order row`);
  }
});

test("boundary: no webhook handling and no fulfillment email is added", () => {
  const webhook = read("app/api/stripe/webhook/route.ts");
  for (const event of ["invoice.paid", "invoice.payment_failed", "customer.subscription.updated", "customer.subscription.deleted"]) {
    assert.ok(!webhook.includes(event), `the webhook now handles ${event}`);
  }
  // Comment-stripped for the same reason: naming the event that will
  // activate a subscription later is documentation, not a handler.
  const newCode = flowCode + withoutComments(deps) + withoutComments(route);
  assert.ok(!/invoice\.paid|invoice_paid/.test(newCode), "an invoice.paid handler was added");
  for (const [name, source] of [["flow", flowCode], ["deps", withoutComments(deps)], ["route", withoutComments(route)]]) {
    assert.ok(!/sendOrderConfirmation|resend|Resend|orderFulfillment/.test(source), `${name} sends an email`);
  }
});

test("boundary: no cancellation, pause or resume is implemented", () => {
  for (const [name, source] of [["flow", flowCode], ["deps", withoutComments(deps)], ["subscriptions", withoutComments(subscriptionsLib)]]) {
    for (const later of ["pause", "resume", "cancel_at_period_end", "subscriptions.cancel", "subscriptions.update"]) {
      assert.ok(!source.includes(later), `${name} implements ${later}`);
    }
  }
});

test("boundary: B2B is untouched and the one-time checkout still runs mode payment", () => {
  const oneTime = read("app/api/checkout/session/route.ts");
  assert.match(oneTime, /mode: "payment"/);
  assert.ok(!/mode: "subscription"/.test(oneTime), "the one-time route changed mode");
  assert.ok(!/getOrCreateStripeCustomer|handleSubscriptionCheckout|subscription_data/.test(oneTime),
    "the one-time route was overloaded with subscription logic");
  // B2B pricing and supply are not referenced by any new file.
  for (const source of [flow, deps, route, plansLib, subscriptionsLib]) {
    assert.ok(!/b2b|business_profiles|b2b_supply|b2bCalculator/i.test(source), "a new file touches B2B");
  }
});

/* ── AN, AO. Migrations ─────────────────────────────────────── */

test("migrations: 025 is the only new one and 022-024 are untouched", () => {
  const files = readdirSync(MIGRATIONS).filter(n => n.endsWith(".sql")).sort();
  assert.equal(files[files.length - 1], "025_grant_subscription_plans_service_role.sql");
  assert.equal(files.filter(n => n.startsWith("026")).length, 0);

  // 024 is live: its two privilege statements and its seed must be exactly
  // as applied.
  const m024 = read("supabase/migrations/024_seed_b2c_subscription_plans.sql");
  assert.match(m024, /revoke all privileges on table public\.b2c_subscription_plans\s+from anon, authenticated, service_role;/);
  assert.match(m024, /grant select on table public\.b2c_subscription_plans to authenticated;/);
  assert.match(m024, /create unique index b2c_plans_active_variant_cadence_key/);
  assert.match(m024, /existing B2C subscription plan data requires manual review/);
  const m023 = read("supabase/migrations/023_harden_stripe_customers_grants.sql");
  assert.match(m023, /revoke all privileges on table public\.stripe_customers/);
  assert.match(read("supabase/migrations/022_recurring_subscription_foundation.sql"), /create table public\.stripe_customers \(/);
});

test("migrations: 025 grants exactly the audited minimum and widens nothing", () => {
  const statements = migration025Sql.split(";").map(x => x.trim()).filter(Boolean);

  // The plan grant migration 024 promised, unchanged.
  assert.ok(
    statements.some(x => x === "grant select on table public.b2c_subscription_plans to service_role"),
    "the plan grant must survive the 29D-D.1 expansion"
  );

  // Nothing widened, nothing else touched.
  assert.ok(!/to anon/.test(migration025Sql), "anon was granted something");
  assert.ok(!/alter default privileges/i.test(migration025Sql), "025 changes schema-wide default privileges");
  assert.ok(!/create policy|drop policy|alter policy|row level security/i.test(migration025Sql),
    "025 changes the RLS model");
  assert.ok(!/owner to|to postgres/i.test(migration025Sql), "025 touches owner privileges");
  // No table grant beyond the one plan SELECT, and in particular no
  // blanket server read over personal data.
  const tableGrants = [...migration025Sql.matchAll(/grant\s+([a-z, ]+?)\s+on table (\S+) to ([^;]+)/gi)];
  assert.equal(tableGrants.length, 1, "025 must grant on exactly one table");
  assert.equal(tableGrants[0][1].trim(), "select");
  assert.equal(tableGrants[0][2], "public.b2c_subscription_plans");
  assert.equal(tableGrants[0][3].trim(), "service_role");
  assert.ok(!/public\.addresses|public\.profiles/.test(migration025Sql), "025 grants access to personal data");

  // The only schema change is the fingerprint column: nullable, no
  // default, so every historical one-time attempt stays valid.
  const alters = [...migration025Sql.matchAll(/alter table (\S+)\s+add column (\S+) (\S+)/gi)];
  assert.equal(alters.length, 1, "025 must add exactly one column");
  assert.deepEqual(
    [alters[0][1], alters[0][2], alters[0][3].replace(";", "")],
    ["public.checkout_attempts", "subscription_request_fingerprint", "text"]
  );
  assert.ok(!/subscription_request_fingerprint text[^;]*(not null|default)/i.test(migration025Sql),
    "the new column must be nullable with no default");
  assert.ok(!/update public\.checkout_attempts\s+set subscription_request_fingerprint/i.test(migration025Sql),
    "025 must not backfill historical attempts");
});

test("migrations: the new RPC is server-only, definer-scoped and search-path pinned", () => {
  assert.match(migration025Sql, /create or replace function public\.claim_pending_subscription_for_attempt\(/);
  assert.match(migration025Sql, /security definer set search_path = ''/);
  assert.match(migration025Sql, /language plpgsql/);

  // Revoked from PUBLIC first: a function is executable by PUBLIC by
  // default, so granting service_role alone would leave the browser roles
  // able to create subscriptions.
  assert.match(migration025Sql, /revoke all on function public\.claim_pending_subscription_for_attempt\([\s\S]*?\) from public, anon, authenticated;/);
  assert.match(migration025Sql, /grant execute on function public\.claim_pending_subscription_for_attempt\([\s\S]*?\) to service_role;/);
  assert.ok(
    migration025Sql.indexOf("revoke all on function") < migration025Sql.indexOf("grant execute on function"),
    "the revoke must precede the grant"
  );
  // The same shape migration 022 uses for its two RPCs.
  const m022 = read("supabase/migrations/022_recurring_subscription_foundation.sql");
  assert.match(m022, /security definer set search_path = ''/);

  // Only the service role is ever named as a grantee for it.
  const executeGrants = [...migration025Sql.matchAll(/grant execute on function[\s\S]*?to (\w+);/g)].map(m => m[1]);
  assert.deepEqual(executeGrants, ["service_role"]);
});

test("migrations: 026 was not created and 022-024 are untouched", () => {
  const files = readdirSync(MIGRATIONS).filter(n => n.endsWith(".sql")).sort();
  assert.equal(files.filter(n => n.startsWith("026")).length, 0, "migration 026 must not exist");
  assert.deepEqual(files.filter(n => n.startsWith("025")), ["025_grant_subscription_plans_service_role.sql"]);

  const m024 = read("supabase/migrations/024_seed_b2c_subscription_plans.sql");
  assert.match(m024, /revoke all privileges on table public\.b2c_subscription_plans\s+from anon, authenticated, service_role;/);
  assert.match(m024, /grant select on table public\.b2c_subscription_plans to authenticated;/);
  assert.match(m024, /existing B2C subscription plan data requires manual review/);
  const m022 = read("supabase/migrations/022_recurring_subscription_foundation.sql");
  assert.match(m022, /create or replace function public\.create_pending_subscription\(/);
  assert.match(m022, /create table public\.stripe_customers \(/);
  const m023 = read("supabase/migrations/023_harden_stripe_customers_grants.sql");
  assert.match(m023, /grant select, insert, update on table public\.checkout_attempts to service_role;/);
  // 025 does not re-grant anything on checkout_attempts: 023 owns that.
  assert.ok(!/grant[^;]*on table public\.checkout_attempts/i.test(migration025Sql),
    "025 changes the checkout_attempts privilege model");
});

/* ── AP, AQ. The tests themselves ───────────────────────────── */

test("safety: this suite makes no Stripe call and no database write", () => {
  const self = read("tests/subscription-checkout.test.mjs");
  for (const line of self.split(NEWLINE).filter(l => l.trim().startsWith("import "))) {
    assert.ok(!/["']stripe["']/.test(line), `the tests must not import the Stripe SDK: ${line}`);
    assert.ok(!/supabaseAdmin|@supabase\/supabase-js/.test(line), `the tests must not import a database client: ${line}`);
  }
  // Only a pure leaf and lib/shipping.ts are imported; both are free of
  // network, database and import.meta.env by construction.
  assert.ok(!/fetch\(|spawn\(|createClient\(/.test(self), "the tests must not open a connection");
});
