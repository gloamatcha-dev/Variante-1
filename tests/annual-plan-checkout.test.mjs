import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ALLOWED_ANNUAL_REQUEST_FIELDS,
  ANNUAL_ALLOWED_COUNTRY,
  ANNUAL_CHECKOUT_VERSION,
  ANNUAL_FINGERPRINT_VERSION,
  ANNUAL_INTENT_FINGERPRINT_FIELDS,
  ANNUAL_PENDING_PLAN_CONFLICT_RESULTS,
  ANNUAL_REQUEST_FINGERPRINT_FIELDS,
  ANNUAL_SHIPPING_ZONE,
  PENDING_ANNUAL_PLAN_SUCCESS_RESULTS,
  annualAddressDigest,
  annualCheckoutIdempotencyKey,
  annualIntentFingerprint,
  annualPendingPlanFailureStatus,
  annualRequestFingerprint,
  attemptMatchesAnnualFingerprint,
  buildAnnualCheckoutLineItems,
  buildAnnualCustomerSnapshot,
  buildAnnualDeliveryItemsSnapshot,
  buildAnnualPaymentItemsSnapshot,
  buildAnnualSessionMetadata,
  buildAnnualShippingOptions,
  buildAnnualTaxableItems,
  buildDeliveryTaxableItems,
  interpretPendingAnnualPlanResult,
  parseAnnualCheckoutBody,
  requireAnnualDestination,
  verifyFrozenAnnualAttempt,
} from "../lib/annualPlanCheckoutRules.ts";
import { buildAnnualPricing } from "../lib/annualPlanRules.ts";
import { resolveAnnualLaunchPlan } from "../lib/annualPlans.ts";
import { resolveCheckoutTax } from "../lib/tax.ts";
import { resolveTaxJurisdiction } from "../lib/taxJurisdiction.ts";
import { SHIPPING_ZONES, getShippingZone, normalizeCountryCode } from "../lib/shipping.ts";
import { buildSubscriptionAddressSnapshot } from "../lib/subscriptionCheckoutRules.ts";

// SAFE DEFAULT SUITE: pure decisions plus source-level checks on the
// orchestration. No database is opened, no Supabase client is
// constructed, no Stripe API is called, no Checkout Session is created,
// no email is sent and no SQL is executed. Nothing here reads a clock.
//
// The split mirrors the subscription checkout's: everything worth
// EXECUTING lives in lib/annualPlanCheckoutRules.ts and is imported
// below, while lib/annualPlanCheckout.ts value-imports its neighbours and
// therefore cannot be loaded by the test runner - so its guarantees, all
// of which are about ORDER, are asserted against its source.
//
// What it protects: a customer paying once for thirteen boxes. The money,
// the destination and the correlation are frozen before Stripe is
// contacted, and migration 039 refuses the whole thing if they disagree.

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf-8");
const NEWLINE = String.fromCharCode(10);

/** Code only: the prose deliberately names what it refuses to do. */
const withoutComments = source => source
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split(NEWLINE)
  .filter(line => {
    const t = line.trim();
    return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
  })
  .join(NEWLINE);

const flowSource = read("lib/annualPlanCheckout.ts");
const flow = withoutComments(flowSource);
const rulesCode = withoutComments(read("lib/annualPlanCheckoutRules.ts"));
const depsCode = withoutComments(read("lib/annualPlanCheckoutDeps.ts"));
const routeCode = withoutComments(read("app/api/annual-plan/checkout/session/route.ts"));
const attemptsCode = withoutComments(read("lib/checkoutAttempts.ts"));

/** Where a call appears in the flow. Asserts it appears at all. */
const at = needle => {
  const i = flow.indexOf(needle);
  assert.notEqual(i, -1, `missing from the flow: ${needle}`);
  return i;
};

const UUID = "11111111-2222-3333-4444-555555555555";
const ADDRESS_ID = "22222222-3333-4444-5555-666666666666";
const REQUEST_ID = "33333333-4444-5555-6666-777777777777";
const PLAN_ID = "44444444-5555-6666-7777-888888888888";
const ATTEMPT_ID = "55555555-6666-7777-8888-999999999999";

const CATALOG = { "30g": 1999, "50g": 2999, "100g": 5499 };
const SKU = { "30g": "GLOA-MATCHA-30G", "50g": "GLOA-MATCHA-50G", "100g": "GLOA-MATCHA-100G" };
const GRAMS = { "30g": 30, "50g": 50, "100g": 100 };

/** A canonical quote line, in buildAuthoritativeQuote's own field names. */
const VARIANT_ID = {
  "30g": "11111111-2222-3333-4444-555555555530",
  "50g": UUID,
  "100g": "11111111-2222-3333-4444-555555555100",
};

const variantFor = (size, over = {}) => ({
  variantId: VARIANT_ID[size],
  sku: SKU[size],
  sizeGrams: GRAMS[size],
  unitGrossCents: CATALOG[size],
  currency: "EUR",
  ...over,
});

const planFor = size => {
  const r = resolveAnnualLaunchPlan(variantFor(size));
  assert.equal(r.ok, true, `plan resolution failed for ${size}`);
  return r.plan;
};

const pricingFor = size => {
  const plan = planFor(size);
  const r = buildAnnualPricing({ size: plan.size, catalogUnitGrossCents: plan.catalogUnitGrossCents });
  assert.equal(r.ok, true, `pricing failed for ${size}`);
  return r.pricing;
};

const CATALOG_FACTS = { productName: "GLOA Matcha", variantLabel: "50 g", sizeGrams: 50, currency: "EUR" };

/** A complete German saved address row, as public.addresses stores one. */
const addressRow = (over = {}) => ({
  id: ADDRESS_ID,
  user_id: UUID,
  first_name: "Mira",
  last_name: "Sato",
  company: null,
  street: "Kastanienallee",
  house_number: "12",
  zip: "10435",
  city: "Berlin",
  country: "DE",
  ...over,
});

const snapshotFor = row => {
  const result = buildSubscriptionAddressSnapshot(row, normalizeCountryCode(row?.country));
  return result;
};

/** A frozen payment attempt, as the annual writer stores one. */
/** The canonical intent, exactly as the flow composes it. */
const intentFor = (size, over = {}) => {
  const plan = planFor(size);
  const pricing = pricingFor(size);
  return {
    userId: UUID,
    variantId: plan.variantId,
    addressId: ADDRESS_ID,
    deliveryCount: pricing.deliveryCount,
    addressDigest: annualAddressDigest(snapshotFor(addressRow()).snapshot),
    sku: plan.sku,
    currency: "EUR",
    shippingCountry: "DE",
    catalogUnitGrossCents: pricing.catalogUnitGrossCents,
    discountPercentApplied: pricing.discountPercentApplied,
    annualUnitGrossCents: pricing.annualUnitGrossCents,
    shippingPerDeliveryGrossCents: pricing.shippingPerDeliveryGrossCents,
    shippingTotalGrossCents: pricing.shippingTotalGrossCents,
    totalGrossCents: pricing.totalGrossCents,
    taxCalculationVersion: "de-2026.1",
    taxTreatment: "de_domestic",
    taxTotalCents: 1234,
    ...over,
  };
};

const frozenAttempt = (size, over = {}) => {
  const pricing = pricingFor(size);
  const plan = planFor(size);
  return {
    id: ATTEMPT_ID,
    status: "created",
    user_id: UUID,
    currency: "EUR",
    expected_total_gross_cents: pricing.totalGrossCents,
    items_snapshot: buildAnnualPaymentItemsSnapshot({ plan, pricing, catalog: CATALOG_FACTS }),
    shipping_country: "DE",
    shipping_gross_cents: pricing.shippingTotalGrossCents,
    tax_snapshot: { totals: { totalGrossCents: pricing.totalGrossCents } },
    stripe_checkout_session_id: null,
    annual_plan_id: null,
    annual_delivery_number: null,
    subscription_id: null,
    annual_intent_fingerprint: annualIntentFingerprint(intentFor(size)),
    annual_request_fingerprint: annualRequestFingerprint(intentFor(size)),
    ...over,
  };
};

/** verifyFrozenAnnualAttempt with the matching intent supplied. */
const verifyRetry = (size, over = {}, intentOver = {}) => verifyFrozenAnnualAttempt({
  attempt: frozenAttempt(size, over),
  userId: UUID,
  plan: planFor(size),
  pricing: pricingFor(size),
  intentFingerprint: annualIntentFingerprint(intentFor(size, intentOver)),
});

/* ══════════════════════════════════════════════════════════════
   1-3. THE GATE, AND WHERE IT SITS
   ══════════════════════════════════════════════════════════════ */

test("1: the feature gate runs before any write, any RPC and any Stripe call", () => {
  const gate = at("if (!deps.isEnabled())");
  for (const later of [
    "await deps.verifyCaller(request)",
    "await deps.buildQuote(",
    "await deps.loadAddress(",
    "await deps.ensureAttempt(",
    "await deps.createPendingPlan(",
    "stripe.checkout.sessions.create(",
    "await deps.linkSession(",
  ]) {
    assert.ok(at(later) > gate, `the gate does not precede ${later}`);
  }
  // And it is the annual flag, closed by default, from Phase 4B2.
  assert.ok(depsCode.includes("isEnabled: () => isAnnualPlanCheckoutEnabled()"));
  assert.match(read(".env.example"), /^B2C_ANNUAL_PLAN_ENABLED=$/m);
  assert.ok(read("lib/annualPlans.ts")
    .includes('return env[ANNUAL_PLAN_FEATURE_FLAG] === "true";'));
});

test("2: a disabled feature answers 503 and nothing else happens", () => {
  // The gate returns before the body is even parsed, so a disabled
  // deployment cannot be probed with a crafted body either.
  const gate = at("if (!deps.isEnabled())");
  assert.ok(gate < at("await request.json()"), "the body is read before the gate");
  const gateBlock = flow.slice(gate, gate + 120);
  assert.match(gateBlock, /return fail\(503, UNAVAILABLE\);/);
});

test("3: the route is thin and injects the real wiring", () => {
  assert.match(routeCode, /export async function POST\(request: Request\): Promise<Response> \{\s*return handleAnnualPlanCheckout\(request, defaultAnnualCheckoutDeps\);\s*\}/);
  // A dedicated endpoint: neither of the two live checkout routes is touched.
  assert.ok(!routeCode.includes("subscriptions"));
});

/* ══════════════════════════════════════════════════════════════
   4-6. THE REQUEST BODY
   ══════════════════════════════════════════════════════════════ */

test("4: exactly three safe fields are accepted", () => {
  assert.deepEqual([...ALLOWED_ANNUAL_REQUEST_FIELDS], ["variantId", "addressId", "requestId"]);
  const ok = parseAnnualCheckoutBody({ variantId: UUID, addressId: ADDRESS_ID, requestId: REQUEST_ID });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.request, { variantId: UUID, addressId: ADDRESS_ID, requestId: REQUEST_ID });
});

test("5: any commercial or identity field is REFUSED, not ignored", () => {
  const base = { variantId: UUID, addressId: ADDRESS_ID, requestId: REQUEST_ID };
  const forbidden = [
    "price", "unitGrossCents", "annualUnitGrossCents", "discount", "discountPercent",
    "shipping", "shippingGrossCents", "quantity", "deliveryCount", "subtotal", "total",
    "tax", "taxTotalCents", "currency", "userId", "email", "country", "annualPlanId",
    "paymentIntentId", "stripeCustomerId", "planId",
  ];
  for (const key of forbidden) {
    const r = parseAnnualCheckoutBody({ ...base, [key]: "x" });
    assert.equal(r.ok, false, `${key} was accepted`);
    assert.equal(r.error, "Ungültige Anfrage.");
  }
  // Not silently dropped either: the parser returns only the three.
  const accepted = parseAnnualCheckoutBody(base);
  assert.deepEqual(Object.keys(accepted.request).sort(), ["addressId", "requestId", "variantId"]);
});

test("6: every identifier must be a uuid, and the shape must be an object", () => {
  const base = { variantId: UUID, addressId: ADDRESS_ID, requestId: REQUEST_ID };
  for (const bad of [null, undefined, "", 5, [], [1, 2], "string"]) {
    assert.equal(parseAnnualCheckoutBody(bad).ok, false, String(bad));
  }
  for (const [key, error] of [
    ["requestId", "Ungültige Anfrage-ID."],
    ["variantId", "Ungültiges Produkt."],
    ["addressId", "Ungültige Adresse."],
  ]) {
    for (const bad of ["", "not-a-uuid", 42, null, `${UUID}x`]) {
      const r = parseAnnualCheckoutBody({ ...base, [key]: bad });
      assert.equal(r.ok, false, `${key}=${String(bad)}`);
      assert.equal(r.error, error);
    }
  }
});

/* ══════════════════════════════════════════════════════════════
   7-9. AUTH, ADDRESS OWNERSHIP AND GERMANY
   ══════════════════════════════════════════════════════════════ */

test("7: annual checkout is authenticated-only, with no guest fallback", () => {
  const auth = at("const caller = await deps.verifyCaller(request);");
  assert.match(flow.slice(auth, auth + 200), /if \(!caller\) \{[\s\S]*?return fail\(401,/);
  // Identity is the verified token's user, everywhere it is used.
  assert.ok(flow.includes("userId: caller.userId"));
  assert.ok(flow.includes("email: caller.email"));
  // No body-supplied identity exists to fall back to, and the real
  // verifier is the one the subscription flow already uses.
  assert.ok(!flow.includes("body.userId") && !flow.includes("body.email"));
  assert.ok(depsCode.includes("verifyCaller: verifyBearerUser"));
  // The one-time guest path is untouched.
  assert.ok(read("app/api/checkout/session/route.ts").includes("const userId = await verifyUserId(request);"),
    "the one-time flow's guest checkout changed");
});

test("8: the address is re-read as the customer, and failures are neutral", () => {
  // Ownership twice: RLS through a session-scoped client, and an explicit
  // user_id filter that says the same thing again.
  assert.ok(depsCode.includes("getSupabaseAsUser(token)"));
  assert.ok(depsCode.includes('.eq("id", addressId)'));
  assert.ok(depsCode.includes('.eq("user_id", userId)'));
  // Never the service role for somebody's street.
  const loadFn = depsCode.slice(depsCode.indexOf("async function loadOwnAddress"), depsCode.indexOf("async function createPendingAnnualPlan"));
  assert.ok(!loadFn.includes("getSupabaseAdmin"), "the address is read with the service role");

  // ONE answer for missing, someone else's, and incomplete.
  const rejection = flow.slice(at("if (!addressResult.ok)"), at("if (!addressResult.ok)") + 300);
  assert.match(rejection, /return fail\(404, "Adresse nicht gefunden oder unvollständig\."\);/);

  // The existing snapshot builder decides completeness, unchanged.
  assert.equal(snapshotFor(null).ok, false);
  assert.equal(snapshotFor(addressRow({ street: "" })).ok, false);
  assert.equal(snapshotFor(addressRow({ house_number: "" })).ok, false);
  assert.equal(snapshotFor(addressRow({ zip: "" })).ok, false);
  assert.equal(snapshotFor(addressRow({ city: "" })).ok, false);
  assert.equal(snapshotFor(addressRow({ first_name: "", last_name: "" })).ok, false);
  const good = snapshotFor(addressRow());
  assert.equal(good.ok, true);
  assert.equal(good.snapshot.country, "DE");
  assert.equal(good.snapshot.line1, "Kastanienallee 12");
});

test("9: Germany only, enforced on the frozen snapshot", () => {
  assert.equal(ANNUAL_ALLOWED_COUNTRY, "DE");
  assert.equal(requireAnnualDestination(snapshotFor(addressRow()).snapshot).ok, true);

  // Austria is a real shop destination and still not an annual one.
  const at_ = snapshotFor(addressRow({ country: "AT" }));
  assert.equal(at_.ok, true, "AT is a supported shop destination");
  assert.equal(requireAnnualDestination(at_.snapshot).ok, false);
  for (const country of ["AT", "FR", "CH", "GB", "NL", "US", null, "", "Frankreich"]) {
    const built = snapshotFor(addressRow({ country }));
    const snapshot = built.ok ? built.snapshot : { country: normalizeCountryCode(country) };
    assert.equal(requireAnnualDestination(snapshot).ok, false, String(country));
  }
  // "Deutschland" is a legacy German row and normalises to DE.
  const legacy = snapshotFor(addressRow({ country: "Deutschland" }));
  assert.equal(legacy.ok, true);
  assert.equal(requireAnnualDestination(legacy.snapshot).ok, true);
  // An unknown country never becomes Germany.
  assert.equal(normalizeCountryCode("Freedonia"), null);
  // The zone constant agrees with lib/shipping.ts.
  assert.equal(ANNUAL_SHIPPING_ZONE, getShippingZone("DE"));
  assert.ok(SHIPPING_ZONES[ANNUAL_SHIPPING_ZONE]);
  // And the flow checks the destination before any write.
  assert.ok(at("requireAnnualDestination(addressSnapshot)") < at("await deps.ensureAttempt("));
});

/* ══════════════════════════════════════════════════════════════
   10-12. CANONICAL PRODUCT AND ANNUAL MONEY
   ══════════════════════════════════════════════════════════════ */

test("10: the catalog is re-read server-side and no price is hardcoded in the flow", () => {
  // The browser names a variant; buildAuthoritativeQuote prices it.
  assert.ok(flow.includes("await deps.buildQuote([{ variantId, quantity: 1 }])"),
    "the flow does not re-read the canonical catalog");
  assert.ok(depsCode.includes("buildQuote: buildAuthoritativeQuote"));
  // Exactly one variant. No cart, no client quantity.
  assert.ok(flow.includes("quote.items.length !== 1"));
  assert.ok(!flow.includes("quantity: quantity"));
  for (const cents of [1999, 2999, 5499, 1799, 2699, 4949, 31057, 35087, 64337, 7670]) {
    assert.ok(!flow.includes(String(cents)), `the flow hardcodes ${cents}`);
    assert.ok(!rulesCode.includes(String(cents)), `the rules hardcode ${cents}`);
  }
});

test("11: the three launch sizes are accepted and everything else fails closed", () => {
  for (const size of ["30g", "50g", "100g"]) {
    assert.equal(resolveAnnualLaunchPlan(variantFor(size)).ok, true, size);
  }
  const refused = [
    variantFor("50g", { sku: "GLOA-CASE-01" }),
    variantFor("50g", { sku: "GLOA-MATCHA-200G" }),
    variantFor("50g", { sizeGrams: 30 }),
    variantFor("50g", { sizeGrams: null }),
    variantFor("50g", { currency: "USD" }),
    variantFor("50g", { unitGrossCents: 0 }),
  ];
  for (const v of refused) {
    assert.equal(resolveAnnualLaunchPlan(v).ok, false, JSON.stringify(v));
  }
  // An inactive product or variant never reaches here: the quote refuses
  // it first, and the flow returns on that.
  assert.ok(read("lib/checkoutQuote.ts").includes("if (!variant.is_active)"));
  assert.ok(flow.includes("if (!quoteResult.ok)"));
});

test("12: the money comes from Phase 4B2 and is never recomputed in the flow", () => {
  assert.ok(flow.includes("buildAnnualPricing({"), "the flow does not use the pure pricing rules");
  // No arithmetic of its own: no discount, no multiplication by thirteen.
  for (const b of ["* 13", "* 0.9", "0.9 *", "/ 100", "Math.round", "Math.floor"]) {
    assert.ok(!flow.includes(b), `the flow does its own money arithmetic: ${b}`);
  }
  // The derived totals, for the record.
  assert.equal(pricingFor("30g").totalGrossCents, 31057);
  assert.equal(pricingFor("50g").totalGrossCents, 35087);
  assert.equal(pricingFor("100g").totalGrossCents, 64337);
  assert.equal(pricingFor("30g").shippingTotalGrossCents, 7670);
  assert.equal(pricingFor("50g").shippingTotalGrossCents, 0);
  assert.equal(pricingFor("100g").shippingTotalGrossCents, 0);
});

/* ══════════════════════════════════════════════════════════════
   13-16. THE FROZEN SNAPSHOTS
   ══════════════════════════════════════════════════════════════ */

test("13: the payment items snapshot is the WHOLE prepayment", () => {
  for (const size of ["30g", "50g", "100g"]) {
    const plan = planFor(size);
    const pricing = pricingFor(size);
    const items = buildAnnualPaymentItemsSnapshot({ plan, pricing, catalog: CATALOG_FACTS });
    assert.equal(items.length, 1);
    assert.equal(items[0].quantity, 13, `${size} payment quantity`);
    assert.equal(items[0].unitGrossCents, pricing.annualUnitGrossCents);
    assert.equal(items[0].lineGrossCents, pricing.merchandiseTotalGrossCents);
    assert.equal(items[0].variantId, plan.variantId);
    assert.equal(items[0].sku, plan.sku);
    assert.equal(items[0].currency, "EUR");
  }
});

test("14: the delivery items snapshot is exactly ONE delivery", () => {
  for (const size of ["30g", "50g", "100g"]) {
    const plan = planFor(size);
    const pricing = pricingFor(size);
    const items = buildAnnualDeliveryItemsSnapshot({ plan, pricing, catalog: CATALOG_FACTS });
    assert.equal(items.length, 1);
    // Thirteen here would make every delivery order claim a year of
    // Matcha, and 039's delivery-item quantity CHECK refuses the row.
    assert.equal(items[0].quantity, 1, `${size} delivery quantity`);
    assert.equal(items[0].unitGrossCents, pricing.annualUnitGrossCents);
    assert.equal(items[0].lineGrossCents, pricing.annualUnitGrossCents);
  }
  // The migration really does require it.
  const migration = read("supabase/migrations/039_b2c_annual_plan_foundation.sql");
  assert.ok(migration.includes("annual_plans_delivery_item_quantity_check"));
});

test("15: the two tax snapshots describe the two different amounts", () => {
  const jurisdiction = resolveTaxJurisdiction("DE");
  for (const size of ["30g", "50g", "100g"]) {
    const plan = planFor(size);
    const pricing = pricingFor(size);
    const productSlug = "matcha";

    const annual = resolveCheckoutTax({
      jurisdictionResult: jurisdiction,
      items: buildAnnualTaxableItems({ plan, pricing, productSlug }),
      shippingGrossCents: pricing.shippingTotalGrossCents,
    });
    const delivery = resolveCheckoutTax({
      jurisdictionResult: jurisdiction,
      items: buildDeliveryTaxableItems({ plan, pricing, productSlug }),
      shippingGrossCents: pricing.shippingPerDeliveryGrossCents,
    });
    assert.equal(annual.kind, "calculated", size);
    assert.equal(delivery.kind, "calculated", size);

    // EXACTLY what migration 039's three CHECK constraints compare.
    assert.equal(annual.snapshot.totals.totalGrossCents, pricing.totalGrossCents);
    assert.equal(annual.snapshot.totals.shippingGrossCents, pricing.shippingTotalGrossCents);
    assert.equal(delivery.snapshot.totals.totalGrossCents,
      pricing.annualUnitGrossCents + pricing.shippingPerDeliveryGrossCents);
    assert.equal(delivery.snapshot.totals.shippingGrossCents, pricing.shippingPerDeliveryGrossCents);

    // Thirteen deliveries' worth of tax is the annual tax. Same engine,
    // same 7 percent, no invented rate anywhere.
    assert.equal(annual.snapshot.treatment, "de_domestic");
    assert.equal(delivery.snapshot.treatment, "de_domestic");
    assert.equal(annual.snapshot.items[0].taxRatePercent, 7);
  }
  // Both are required, and the flow refuses unless both calculated.
  assert.ok(flow.includes('if (annualTax.kind !== "calculated" || deliveryTax.kind !== "calculated")'));
  // lib/tax.ts is used, not modified.
  assert.equal(
    readdirSync(path.join(ROOT, "lib")).includes("tax.ts"), true);
});

test("16: the customer snapshot is server-derived and carries no secret", () => {
  const snap = buildAnnualCustomerSnapshot({ email: "mira@example.com", recipientName: "Mira Sato" });
  assert.deepEqual(snap, { email: "mira@example.com", name: "Mira Sato" });
  assert.deepEqual(Object.keys(snap).sort(), ["email", "name"]);
  assert.deepEqual(buildAnnualCustomerSnapshot({ email: null, recipientName: "" }),
    { email: null, name: null });
  // Built from the verified token and the customer's own address row.
  assert.ok(flow.includes("buildAnnualCustomerSnapshot({ email: caller.email, recipientName })"));
  for (const banned of ["token", "accessToken", "service_role", "secret", "apiKey"]) {
    assert.ok(!rulesCode.includes(`${banned}:`), `the customer snapshot could carry ${banned}`);
  }
  // Ownership is the user id, never a matching email.
  assert.ok(flow.includes("userId: caller.userId"));
  assert.ok(!flow.includes("email ==="), "ownership is derived from an email");
});

/* ══════════════════════════════════════════════════════════════
   17-19. THE PAYMENT ATTEMPT
   ══════════════════════════════════════════════════════════════ */

test("17: the payment attempt freezes the annual total and the annual shipping TOTAL", () => {
  const call = flow.slice(at("await deps.ensureAttempt({"), at("if (!attemptResult.ok)"));
  assert.ok(call.includes("expectedTotalGrossCents: pricing.totalGrossCents"));
  // The whole year's shipping, not one delivery's: the customer pays once.
  assert.ok(call.includes("grossCents: pricing.shippingTotalGrossCents"),
    "the attempt freezes per-delivery shipping instead of the annual total");
  assert.ok(!call.includes("shippingPerDeliveryGrossCents"));
  assert.ok(call.includes("country: destination.country"));
  assert.ok(call.includes("zone: ANNUAL_SHIPPING_ZONE"));
  assert.ok(call.includes("taxSnapshot: annualTax.snapshot"),
    "the attempt freezes the per-delivery tax instead of the annual one");
  assert.ok(call.includes("items: buildAnnualPaymentItemsSnapshot("));
  assert.ok(call.includes("userId: caller.userId"));
  // Phase 4B3.2: both digests are written with the attempt, once.
  assert.ok(call.includes("intentFingerprint,"));
  assert.ok(call.includes("requestFingerprint,"));
});

test("18: the payment attempt carries no annual binding and no Stripe identity", () => {
  const writer = attemptsCode.slice(attemptsCode.indexOf("export async function getOrCreateAnnualCheckoutAttempt"));
  const upsert = writer.slice(writer.indexOf(".upsert("), writer.indexOf("ignoreDuplicates"));
  for (const forbidden of [
    "annual_plan_id:", "annual_delivery_number", "subscription_id", "stripe_invoice_id",
    "stripe_checkout_session_id", "stripe_payment_intent_id", "paid_at", "status:",
    "subscription_request_fingerprint", "subscription_intent_fingerprint",
  ]) {
    assert.ok(!upsert.includes(forbidden), `the annual payment attempt writes ${forbidden}`);
  }
  // It DOES write its own two, and only on the first insert.
  assert.ok(upsert.includes("annual_intent_fingerprint: input.intentFingerprint"));
  assert.ok(upsert.includes("annual_request_fingerprint: input.requestFingerprint"));
  // ignoreDuplicates: a retry returns the ORIGINAL frozen snapshot.
  assert.ok(writer.includes("ignoreDuplicates: true"));
  assert.ok(writer.includes('onConflict: "request_id"'));
  // The two live writers are untouched.
  assert.ok(attemptsCode.includes("export async function getOrCreateCheckoutAttempt("));
  assert.ok(attemptsCode.includes("export async function getOrCreateSubscriptionCheckoutAttempt("));
});

test("19: a retry is verified against the attempt's own frozen columns", () => {
  const plan = planFor("50g");
  const pricing = pricingFor("50g");
  const ok = verifyRetry("50g");
  assert.equal(ok.ok, true);

  const refusals = [
    [{ user_id: "99999999-8888-7777-6666-555555555555" }, /another customer/],
    [{ subscription_id: PLAN_ID }, /not an annual payment attempt/],
    [{ annual_plan_id: PLAN_ID }, /not an annual payment attempt/],
    [{ annual_delivery_number: 3 }, /not an annual payment attempt/],
    [{ currency: "USD" }, /not priced in EUR/],
    [{ items_snapshot: [] }, /no usable annual item snapshot/],
    [{ items_snapshot: null }, /no usable annual item snapshot/],
    [{ expected_total_gross_cents: 35088 }, /different total/],
    [{ shipping_gross_cents: 590 }, /different shipping total/],
    [{ shipping_country: "AT" }, /different destination/],
    [{ tax_snapshot: null }, /no frozen tax snapshot/],
  ];
  for (const [over, reason] of refusals) {
    const r = verifyRetry("50g", over);
    assert.equal(r.ok, false, JSON.stringify(over));
    assert.match(r.reason, reason);
  }
  // Same request id, different product: a 30 g attempt cannot become a
  // 50 g purchase.
  const crossed = verifyFrozenAnnualAttempt({
    attempt: frozenAttempt("30g"), userId: UUID, plan, pricing,
    intentFingerprint: annualIntentFingerprint(intentFor("50g")),
  });
  assert.equal(crossed.ok, false);

  // And an already-paid attempt is a conflict, not a second session.
  assert.ok(flow.includes('if (attempt.status === "paid")'));
  assert.ok(flow.includes('return fail(409, "Diese Anfrage wurde bereits bezahlt.");'));
});

/* ══════════════════════════════════════════════════════════════
   20-22. THE MANDATORY ORDER, AND THE RPC
   ══════════════════════════════════════════════════════════════ */

test("20: attempt, THEN pending plan, THEN Stripe - in that order", () => {
  const attempt = at("await deps.ensureAttempt(");
  const verify = at("verifyFrozenAnnualAttempt({");
  const rpc = at("await deps.createPendingPlan({");
  const stripe = at("stripe.checkout.sessions.create(");
  const link = at("await deps.linkSession(");

  assert.ok(attempt < verify, "the attempt is verified before it exists");
  assert.ok(verify < rpc, "the pending plan is claimed before the attempt is verified");
  assert.ok(rpc < stripe, "Stripe is contacted before the pending plan exists");
  assert.ok(stripe < link, "the session is linked before it is created");

  // Nothing reaches Stripe before the plan id exists, because the id is
  // what travels as metadata.
  assert.ok(at("const annualPlanId = pending.annualPlanId;") < stripe);
  assert.ok(flow.indexOf("getStripe()") > rpc, "the Stripe client is fetched before the plan exists");
});

test("21: the RPC gets the thirteen reviewed arguments and no totals", () => {
  const rpcAt = depsCode.indexOf('admin.rpc("create_pending_annual_plan_for_attempt"');
  assert.ok(rpcAt > 0, "the RPC call was not found");
  const call = depsCode.slice(rpcAt, depsCode.indexOf("if (error) {", rpcAt));
  const expected = [
    "p_checkout_attempt_id", "p_user_id", "p_variant_id", "p_catalog_unit_gross_cents",
    "p_annual_unit_gross_cents", "p_shipping_per_delivery_gross_cents",
    "p_discount_percent_applied", "p_customer_snapshot", "p_shipping_address_snapshot",
    "p_billing_address_snapshot", "p_tax_snapshot", "p_delivery_items_snapshot",
    "p_delivery_tax_snapshot",
    "p_expected_annual_intent_fingerprint", "p_expected_annual_request_fingerprint",
  ];
  for (const arg of expected) assert.ok(call.includes(`${arg}:`), `missing RPC argument ${arg}`);
  assert.equal((call.match(/p_[a-z_]+:/g) || []).length, 15, "the RPC call does not pass exactly 15 arguments");
  // 039 computes the totals itself; passing them would be a second place
  // for the money to be wrong.
  for (const forbidden of ["p_total", "p_merchandise", "p_shipping_total", "p_delivery_count"]) {
    assert.ok(!call.includes(forbidden), `the RPC call passes ${forbidden}`);
  }
  // The signature the migration actually installed.
  const m039 = read("supabase/migrations/039_b2c_annual_plan_foundation.sql");
  const m040 = read("supabase/migrations/040_annual_checkout_retry_fingerprints.sql");
  for (const arg of expected) {
    assert.ok(m040.includes(arg), `040's hardened signature has no argument ${arg}`);
  }
  // The first thirteen are 039's, unchanged; the last two are 040's.
  for (const arg of expected.slice(0, 13)) {
    assert.ok(m039.includes(arg), `039 has no argument ${arg}`);
  }
  for (const arg of expected.slice(13)) {
    assert.ok(!m039.includes(arg), `039 already had ${arg}, so 040 changed nothing`);
  }
  // Billing reuses the one saved address, exactly as the subscription
  // checkout does. No new request field, no second address UI.
  assert.ok(flow.includes("billingAddressSnapshot: addressSnapshot"));
  assert.ok(withoutComments(read("lib/subscriptionCheckout.ts")).includes("billingAddressSnapshot: addressSnapshot"),
    "the subscription convention this mirrors changed");
});

test("22: only 'created' and 'existing' are success; everything else fails closed", () => {
  assert.deepEqual([...PENDING_ANNUAL_PLAN_SUCCESS_RESULTS], ["created", "existing"]);
  for (const result of ["created", "existing"]) {
    const r = interpretPendingAnnualPlanResult({ result, annual_plan_id: PLAN_ID });
    assert.equal(r.ok, true, result);
    assert.equal(r.annualPlanId, PLAN_ID);
    assert.equal(r.created, result === "created");
  }
  // Every refusal 039 can answer with, plus a word nobody has seen.
  for (const result of [
    "attempt_not_owned", "attempt_not_pre_stripe", "total_mismatch", "invalid_input",
    "attempt_not_found", "attempt_already_paid", "attempt_not_a_payment_attempt",
    "some_future_word", "", "ok", "success",
  ]) {
    const r = interpretPendingAnnualPlanResult({ result, annual_plan_id: PLAN_ID });
    assert.equal(r.ok, false, result);
  }
  // A success word with no usable id is still a refusal.
  for (const bad of [undefined, null, "", "not-a-uuid", 5]) {
    assert.equal(interpretPendingAnnualPlanResult({ result: "created", annual_plan_id: bad }).ok, false);
  }
  for (const bad of [null, undefined, "created", [], 5]) {
    assert.equal(interpretPendingAnnualPlanResult(bad).ok, false, String(bad));
  }
  // An existing plan is adopted, never rebuilt: the flow reads the id and
  // does not write the plan anywhere.
  assert.ok(!flow.includes("annual_plans"), "the flow writes the annual plan table directly");
  assert.ok(!flow.includes("update"), "the flow updates a row outside the RPC");
});

/* ══════════════════════════════════════════════════════════════
   23-26. STRIPE
   ══════════════════════════════════════════════════════════════ */

test("23: mode is payment, and nothing recurring exists anywhere", () => {
  assert.ok(flow.includes('mode: "payment"'));
  for (const banned of [
    '"subscription"', "subscription_data", "ensureRecurringPrice", "recurring",
    "interval", "SubscriptionSchedule", "billing_cycle",
  ]) {
    assert.ok(!flow.includes(banned), `the annual flow contains ${banned}`);
    assert.ok(!rulesCode.includes(banned), `the annual rules contain ${banned}`);
  }
  assert.ok(!depsCode.includes("RecurringPrice"), "the wiring reaches for a recurring price");
});

test("24: one product line of thirteen at the annual unit price, from the FROZEN attempt", () => {
  for (const size of ["30g", "50g", "100g"]) {
    const pricing = pricingFor(size);
    const lines = buildAnnualCheckoutLineItems({
      pricing, productName: "GLOA Matcha", variantLabel: "50 g", currency: "EUR",
    });
    assert.equal(lines.length, 1);
    assert.equal(lines[0].quantity, 13, size);
    assert.equal(lines[0].price_data.unit_amount, pricing.annualUnitGrossCents, size);
    assert.equal(lines[0].price_data.currency, "eur");
    assert.ok(!("price" in lines[0]), "a Stripe Price object is referenced");
    assert.ok(!("recurring" in lines[0].price_data));
  }
  // Amounts are read off the attempt, so a catalog edit between the first
  // request and a retry cannot change what Stripe collects.
  assert.ok(flow.includes("annualUnitGrossCents: frozenItem.unitGrossCents"));
  assert.ok(flow.includes("deliveryCount: frozenItem.quantity"));
  assert.ok(flow.includes("shippingTotalGrossCents: frozenShippingTotal"));
  assert.ok(flow.includes("const frozenShippingTotal = attempt.shipping_gross_cents ?? 0;"));
});

test("25: shipping is the annual TOTAL, and Germany is the only allowed country", () => {
  const cases = [["30g", 7670, "Versand · 13 Lieferungen"], ["50g", 0, "Kostenloser Versand"], ["100g", 0, "Kostenloser Versand"]];
  for (const [size, expected, label] of cases) {
    const pricing = pricingFor(size);
    assert.equal(pricing.shippingTotalGrossCents, expected, size);
    const options = buildAnnualShippingOptions({
      shippingTotalGrossCents: pricing.shippingTotalGrossCents,
      currency: "EUR",
      minBusinessDays: 2,
      maxBusinessDays: 4,
    });
    assert.equal(options.length, 1);
    assert.equal(options[0].shipping_rate_data.fixed_amount.amount, expected, size);
    assert.equal(options[0].shipping_rate_data.fixed_amount.currency, "eur");
    assert.equal(options[0].shipping_rate_data.display_name, label);
    assert.equal(options[0].shipping_rate_data.type, "fixed_amount");
  }
  // 30 g: thirteen charges, not one.
  assert.equal(7670, 590 * 13);
  // Germany only at Stripe, so a customer cannot pay a German annual
  // contract and then pick another destination.
  assert.ok(flow.includes("shipping_address_collection: { allowed_countries: [ANNUAL_ALLOWED_COUNTRY] }"));
  assert.ok(!flow.includes("ALLOWED_SHIPPING_COUNTRIES"), "the annual session offers every shop country");
});

test("26: metadata is correlation only", () => {
  const meta = buildAnnualSessionMetadata({
    requestId: REQUEST_ID, checkoutAttemptId: ATTEMPT_ID, annualPlanId: PLAN_ID,
  });
  assert.deepEqual(Object.keys(meta).sort(),
    ["checkout_attempt_id", "checkout_version", "gloa_annual_plan_id", "request_id"]);
  assert.equal(meta.checkout_version, ANNUAL_CHECKOUT_VERSION);
  assert.equal(meta.request_id, REQUEST_ID);
  assert.equal(meta.checkout_attempt_id, ATTEMPT_ID);
  assert.equal(meta.gloa_annual_plan_id, PLAN_ID);
  // Nothing else may ever appear in it.
  const serialised = JSON.stringify(meta);
  for (const value of ["35087", "2699", "7670", "13", "Berlin", "mira", "@", "Mira", "10435", "DE"]) {
    assert.ok(!serialised.includes(value), `metadata carries ${value}`);
  }
  const builder = rulesCode.slice(rulesCode.indexOf("export function buildAnnualSessionMetadata"));
  for (const banned of ["email", "name", "address", "amount", "total", "discount", "token", "tax", "country"]) {
    assert.ok(!builder.slice(0, builder.indexOf("}")).includes(banned), `the metadata builder can carry ${banned}`);
  }
});

/* ══════════════════════════════════════════════════════════════
   27-29. IDEMPOTENCY, FAILURE AND NON-ACTIVATION
   ══════════════════════════════════════════════════════════════ */

test("27: the Stripe idempotency key is deterministic and derived from the attempt", () => {
  assert.equal(annualCheckoutIdempotencyKey(ATTEMPT_ID), `gloa-annual-checkout-${ATTEMPT_ID}`);
  assert.equal(annualCheckoutIdempotencyKey(ATTEMPT_ID), annualCheckoutIdempotencyKey(ATTEMPT_ID));
  assert.notEqual(annualCheckoutIdempotencyKey(ATTEMPT_ID), annualCheckoutIdempotencyKey(PLAN_ID));
  // Distinct from the subscription flow's namespace.
  assert.ok(!annualCheckoutIdempotencyKey(ATTEMPT_ID).startsWith("gloa-sub-"));
  // No clock, no randomness, nothing personal.
  const fn = rulesCode.slice(rulesCode.indexOf("export function annualCheckoutIdempotencyKey"));
  const body = fn.slice(0, fn.indexOf("}"));
  for (const banned of ["Date", "random", "now", "email", "userId"]) {
    assert.ok(!body.includes(banned), `the idempotency key uses ${banned}`);
  }
  assert.ok(flow.includes("idempotencyKey: annualCheckoutIdempotencyKey(attempt.id)"));
});

test("28: nothing durable is deleted on a partial failure", () => {
  for (const banned of ["delete", "remove", "rollback", "destroy"]) {
    assert.ok(!flow.toLowerCase().includes(`.${banned}(`), `the flow calls ${banned}`);
  }
  // A failed link keeps the attempt, the plan and the session, and
  // answers retryably so the retry converges through the same key.
  const linkBlock = flow.slice(at("const linked = await deps.linkSession("), at("return Response.json({ sessionId"));
  assert.match(linkBlock, /if \(!linked\)/);
  assert.match(linkBlock, /return fail\(503, UNAVAILABLE\);/);
  // A refused RPC leaves the attempt for the retry, whichever status it
  // answers with.
  const rpcBlock = flow.slice(at("if (!pending.ok)"), at("const annualPlanId"));
  assert.match(rpcBlock, /return status === 409/);
  assert.match(rpcBlock, /fail\(503, UNAVAILABLE\)/);
  assert.ok(!rpcBlock.includes("delete"));
});

test("29: a successful response activates nothing and creates nothing", () => {
  for (const banned of [
    "activate_annual_plan_from_payment", "claim_due_annual_plan_deliveries",
    "fulfill_annual_plan_delivery", "complete_due_annual_plans",
    "create_order_from_paid_checkout", "apply_annual_plan_refund_state",
    "claim_annual_plan_purchase_email", "record_annual_plan_purchase_email_result",
    "sendOrderConfirmation", "resend", "Resend", "markAttemptPaid",
  ]) {
    assert.ok(!flow.includes(banned), `the checkout flow calls ${banned}`);
    assert.ok(!depsCode.includes(banned), `the wiring reaches for ${banned}`);
  }
  // The response says a session exists, and nothing more.
  assert.ok(flow.includes("return Response.json({ sessionId: session.id, url: session.url }, { status: 200 });"));
  // The success URL grants nothing and assumes no order.
  assert.ok(flow.includes("success_url: `${origin}/account?annual=processing`"));
  assert.ok(flow.includes("cancel_url: `${origin}/account?annual=cancelled`"));
});

/* ══════════════════════════════════════════════════════════════
   30-32. NO COLLATERAL DAMAGE
   ══════════════════════════════════════════════════════════════ */

test("30: the rules module is a leaf and the flow is the only place with side effects", () => {
  // Type-only relative imports, so the test runner can load the rules.
  const ruleImports = read("lib/annualPlanCheckoutRules.ts")
    .split(NEWLINE).filter(l => /^import /.test(l));
  for (const line of ruleImports) {
    // Type-only relative imports are erased; a BARE specifier such as
    // node:crypto resolves fine. What must never appear is a value
    // import of an extension-less relative path, which is what stops the
    // test runner loading the module. lib/subscriptionCheckoutRules.ts
    // has exactly this shape and for exactly this reason.
    const ok = /^import type /.test(line) || /from "node:[a-z]+";$/.test(line);
    assert.ok(ok, `a relative value import reached the rules leaf: ${line}`);
  }
  for (const banned of ["supabase", "Supabase", "getStripeClient", "process.env", "fetch("]) {
    assert.ok(!rulesCode.includes(banned), `the rules leaf reaches for ${banned}`);
  }
  // The flow injects every side effect, so it can be driven with stubs.
  assert.ok(flow.includes("export type AnnualCheckoutDeps = {"));
  for (const dep of [
    "isEnabled", "verifyCaller", "buildQuote", "loadAddress", "getStripe",
    "getOrigin", "ensureAttempt", "createPendingPlan", "linkSession",
  ]) {
    assert.ok(flow.includes(`deps.${dep}`), `the flow does not inject ${dep}`);
  }
});

test("31: the live checkout flows and the webhook are untouched", () => {
  const changed = readdirSync(path.join(ROOT, "app/api"));
  assert.ok(changed.includes("annual-plan"), "the annual route is missing");
  // One-time and subscription routes still say what they said.
  assert.ok(read("app/api/checkout/session/route.ts").includes('mode: "payment"'));
  assert.ok(withoutComments(read("lib/subscriptionCheckout.ts")).includes('mode: "subscription"'));
  // The webhook has no annual branch yet: that is the next phase.
  const webhook = withoutComments(read("app/api/stripe/webhook/route.ts"));
  assert.ok(!webhook.includes("annual"), "the webhook already handles annual plans");
  // And nothing in this phase touched the cron, emails or the portal.
  assert.ok(!read("app/api/cron/retry-order-notifications/route.ts").includes("annual"));
});

test("32: 040 is the only new migration, and 001-039 are untouched", () => {
  const migrations = readdirSync(path.join(ROOT, "supabase/migrations"))
    .filter(f => f.endsWith(".sql")).sort();
  assert.equal(migrations.length, 40);
  assert.equal(migrations[migrations.length - 1], "040_annual_checkout_retry_fingerprints.sql");
  assert.equal(migrations[migrations.length - 2], "039_b2c_annual_plan_foundation.sql");
  assert.deepEqual(migrations.filter(f => Number(f.slice(0, 3)) > 40), [],
    "a migration 041 or beyond appeared");
  // 040 is NOT APPLIED yet, so it may still be edited in place - that is
  // the whole reason it is a file under review rather than a 041. Every
  // migration below it is live and may not be touched, which is what
  // this guard is for. (The diff sees modified TRACKED files only; a
  // brand-new migration is caught by the count and the ordering above.)
  const changed = execFileSync("git", ["diff", "--name-only", "HEAD", "--", "supabase/migrations/"],
    { cwd: ROOT, encoding: "utf-8" }).trim();
  const touched = changed ? changed.split(NEWLINE) : [];
  const live = touched.filter(rel => !rel.endsWith("040_annual_checkout_retry_fingerprints.sql"));
  assert.deepEqual(live, [], "a live, immutable migration was edited");
});

/* ══════════════════════════════════════════════════════════════
   33-38. MIGRATION 040 AND THE TWO FINGERPRINTS

   Phase 4B3.1 reproduced the gap these close: an annual checkout could
   be retried with the same request_id after the customer edited their
   saved address, and nothing noticed - because annual shipping is
   decided by product SIZE, so a street, postcode, city, recipient or
   company edit leaves the money, the country and the tax identical.
   ══════════════════════════════════════════════════════════════ */

/**
 * SQL code only. withoutComments above strips // and block comments,
 * which is right for TypeScript and wrong here: a migration's prose uses
 * -- and deliberately NAMES what it refuses to do ("no default", "no
 * index", "no backfill"), so a scan that read it would report every
 * deliberate avoidance as a violation of itself.
 */
const withoutSqlComments = source => source
  .split(NEWLINE)
  .filter(line => !line.trim().startsWith("--"))
  .join(NEWLINE);

const m040 = read("supabase/migrations/040_annual_checkout_retry_fingerprints.sql");
const m040Code = withoutSqlComments(m040);
const OLD_RPC_ARGS = "uuid, uuid, uuid, integer, integer, integer, numeric, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb";
const NEW_RPC_ARGS = `${OLD_RPC_ARGS}, text, text`;

test("33: 040 adds exactly two nullable annual columns, and nothing else", () => {
  assert.ok(m040Code.includes("add column annual_intent_fingerprint  text,"));
  assert.ok(m040Code.includes("add column annual_request_fingerprint text;"));
  // Exactly one ALTER TABLE, and it is on checkout_attempts.
  const altered = [...m040Code.matchAll(/alter table public\.(\w+)/g)].map(m => m[1]);
  assert.deepEqual(altered, ["checkout_attempts"]);
  assert.equal((m040Code.match(/add column/g) || []).length, 2);
  // The ALTER itself carries no default, no NOT NULL and no constraint.
  const alter = m040Code.slice(m040Code.indexOf("alter table public.checkout_attempts"),
    m040Code.indexOf(";", m040Code.indexOf("alter table public.checkout_attempts")));
  for (const forbidden of ["default", "not null", "constraint", "references", "check ("]) {
    assert.ok(!alter.toLowerCase().includes(forbidden),
      `the annual columns are not plain nullable text: ${forbidden}`);
  }
  // And the migration as a whole creates no index, no policy, no
  // constraint, changes no table privilege and writes no row.
  for (const forbidden of [
    "create index", "create unique index", "create policy", "row level security",
    "grant select", "grant insert", "grant update on", "grant delete",
    "add constraint", "update public.checkout_attempts", "insert into public.checkout_attempts",
    "delete from", "truncate", "alter default privileges",
  ]) {
    assert.ok(!m040Code.toLowerCase().includes(forbidden),
      `040 does something it must not: ${forbidden}`);
  }
});

test("33b: 040 is explicitly transactional, and the whole migration is inside it", () => {
  // Section 3 DROPS the pending-plan function and then creates its
  // replacement. Between those two statements the annual checkout has no
  // pending-plan function at all, so a failure in between would leave
  // the schema in exactly that state. The file wraps itself rather than
  // relying on whichever client happens to run it.
  const lines = m040.split(NEWLINE);
  const lineOf = predicate => {
    const i = lines.findIndex(predicate);
    assert.ok(i > -1, "statement not found");
    return i;
  };

  // Anchored at the start of a line, so the PL/pgSQL block's own
  // `begin` / `end;` inside the function body cannot be mistaken for the
  // transaction's.
  const begins = lines.filter(l => l.trimEnd() === "begin;");
  const commits = lines.filter(l => l.trimEnd() === "commit;");
  assert.equal(begins.length, 1, "there must be exactly one begin;");
  assert.equal(commits.length, 1, "there must be exactly one commit;");
  assert.ok(!m040.includes("rollback"), "the migration rolls itself back");

  const begin = lineOf(l => l.trimEnd() === "begin;");
  const alter = lineOf(l => l.startsWith("alter table public.checkout_attempts"));
  const drop = lineOf(l => l.startsWith("drop function public.create_pending_annual_plan_for_attempt("));
  const create = lineOf(l => l.startsWith("create or replace function public.create_pending_annual_plan_for_attempt("));
  const grant = lineOf(l => l.startsWith("grant execute on function public.create_pending_annual_plan_for_attempt("));
  const commit = lineOf(l => l.trimEnd() === "commit;");
  const verify = lineOf(l => l.includes("VERIFY AFTER APPLYING"));

  // BEGIN comes first, COMMIT last, and every executable statement is
  // between them - including the drop and the create that must not be
  // separable.
  assert.ok(begin < alter, "the ALTER runs before BEGIN");
  assert.ok(alter < drop, "the DROP runs before the ALTER");
  assert.ok(drop < create, "the CREATE runs before the DROP");
  assert.ok(create < grant, "the GRANT runs before the CREATE");
  assert.ok(grant < commit, "COMMIT comes before the GRANT");
  assert.ok(commit < verify, "the VERIFY block is inside the transaction");

  // Nothing executable survives after the commit: the verify block is
  // read-only and stays commented out.
  const afterCommit = lines.slice(commit + 1);
  for (const line of afterCommit) {
    const t = line.trim();
    assert.ok(t === "" || t.startsWith("--"),
      `an executable statement follows the commit: ${t}`);
  }
});

test("34: 040 drops the old 13-argument signature and leaves exactly one", () => {
  // An overload would leave the unsafe version callable by anything that
  // simply omitted the two new arguments.
  assert.ok(m040Code.includes("drop function public.create_pending_annual_plan_for_attempt("),
    "040 does not drop the old signature");
  const drop = m040Code.slice(m040Code.indexOf("drop function"), m040Code.indexOf(");", m040Code.indexOf("drop function")));
  assert.ok(!drop.includes("if exists"), "the drop is conditional and would hide schema drift");
  assert.ok(!drop.includes("cascade"), "the drop cascades");
  assert.ok(drop.includes("text") === false, "the drop names the NEW signature, not the old one");

  // Exactly one create, and it carries both new parameters.
  assert.equal((m040Code.match(/create or replace function public\.create_pending_annual_plan_for_attempt\(/g) || []).length, 1);
  assert.ok(m040Code.includes("p_expected_annual_intent_fingerprint  text,"));
  assert.ok(m040Code.includes("p_expected_annual_request_fingerprint text"));

  // And the grants name the fifteen-argument signature only.
  for (const role of ["public", "anon", "authenticated"]) {
    assert.ok(m040Code.includes(`revoke all on function public.create_pending_annual_plan_for_attempt(${NEW_RPC_ARGS}) from ${role};`),
      `040 does not revoke the new signature from ${role}`);
  }
  assert.ok(m040Code.includes(`grant execute on function public.create_pending_annual_plan_for_attempt(${NEW_RPC_ARGS}) to service_role;`));
  // The verify block checks the resulting privileges two independent
  // ways: the raw ACL, and the effective answer has_function_privilege
  // gives - which resolves inheritance and is what actually decides a
  // call.
  assert.ok(m040.includes("has_function_privilege("));
  for (const role of ["public", "anon", "authenticated", "service_role"]) {
    assert.ok(m040.includes(`('${role}')`), `the privilege verify omits ${role}`);
  }
  assert.ok(m040.includes("coalesce(array_to_string(proacl"), "the raw ACL check was removed");
  assert.ok(!m040Code.includes(`grant execute on function public.create_pending_annual_plan_for_attempt(${OLD_RPC_ARGS}) to`),
    "040 grants the old signature");
});

test("35: the hardened RPC is still SECURITY DEFINER with an empty search_path", () => {
  const fn = m040Code.slice(
    m040Code.indexOf("create or replace function public.create_pending_annual_plan_for_attempt("),
    m040Code.indexOf("$$;"));
  assert.ok(fn.includes("security definer set search_path = ''"));
  assert.ok(!/execute\s+format\s*\(/i.test(fn), "the hardened RPC uses dynamic SQL");
  // Fully qualified relations throughout.
  assert.ok(fn.includes("from public.checkout_attempts"));
  assert.ok(fn.includes("from public.annual_plans"));
  assert.ok(fn.includes("insert into public.annual_plans"));
  assert.ok(!fn.includes(" from checkout_attempts"), "an unqualified relation appears");
});

test("36: the gate ORDER inside the RPC is the whole point", () => {
  const fn = m040Code.slice(
    m040Code.indexOf("create or replace function public.create_pending_annual_plan_for_attempt("),
    m040Code.indexOf("$$;"));
  const lock = fn.indexOf("where id = p_checkout_attempt_id\n  for update;");
  const owner = fn.indexOf("if v_attempt.user_id is distinct from p_user_id then");
  const intentGate = fn.indexOf("v_attempt.annual_intent_fingerprint is null");
  const existing = fn.indexOf("where payment_checkout_attempt_id = p_checkout_attempt_id;");
  const termsGate = fn.indexOf("v_attempt.annual_request_fingerprint is null");
  const preStripe = fn.indexOf("if v_attempt.status <> 'created'");
  const insert = fn.indexOf("insert into public.annual_plans");

  for (const [name, i] of Object.entries({ lock, owner, intentGate, existing, termsGate, preStripe, insert })) {
    assert.ok(i > 0, `missing from the hardened RPC: ${name}`);
  }
  // Everything happens under the lock.
  assert.ok(lock < owner, "ownership is decided before the row is locked");
  assert.ok(owner < intentGate, "the intent gate runs before ownership");
  // THE IDENTITY GATE RUNS BEFORE THE EXISTING-PLAN LOOKUP, so it is
  // checked even when a plan already exists.
  assert.ok(intentGate < existing, "the intent gate can be skipped by an existing plan");
  // AND THE TERMS GATE RUNS AFTER IT, so an address edited after the
  // contract was frozen cannot lock the customer out of it.
  assert.ok(existing < termsGate, "the terms gate would refuse a retry for an existing plan");
  assert.ok(termsGate < preStripe, "the terms gate runs after the pre-Stripe test");
  assert.ok(preStripe < insert, "a plan is created before the pre-Stripe test");

  // Both gates compare the STORED column against the expected argument,
  // and both fail closed on NULL.
  assert.ok(fn.includes("v_attempt.annual_intent_fingerprint is distinct from p_expected_annual_intent_fingerprint"));
  assert.ok(fn.includes("v_attempt.annual_request_fingerprint is distinct from p_expected_annual_request_fingerprint"));
  assert.ok(fn.includes("v_attempt.annual_intent_fingerprint is null"));
  assert.ok(fn.includes("v_attempt.annual_request_fingerprint is null"));
  assert.ok(fn.includes("'attempt_intent_mismatch'"));
  assert.ok(fn.includes("'attempt_request_mismatch'"));
  // Nothing is echoed: no digest leaves the function.
  assert.ok(!fn.includes("'stored'"));
  assert.ok(!fn.includes("p_expected_annual_intent_fingerprint,\n"));
});

test("37: every 039 invariant survives in the hardened RPC, verbatim", () => {
  const m039 = read("supabase/migrations/039_b2c_annual_plan_foundation.sql");
  const body039 = withoutComments(m039).slice(
    withoutComments(m039).indexOf("create or replace function public.create_pending_annual_plan_for_attempt("),
    withoutComments(m039).indexOf("$$;"));
  const fn = m040Code.slice(
    m040Code.indexOf("create or replace function public.create_pending_annual_plan_for_attempt("),
    m040Code.indexOf("$$;"));
  for (const invariant of [
    "return pg_catalog.jsonb_build_object('result', 'attempt_not_found');",
    "return pg_catalog.jsonb_build_object('result', 'attempt_not_owned');",
    "'result', 'attempt_not_pre_stripe',",
    "'result', 'total_mismatch',",
    "v_merch := p_annual_unit_gross_cents * v_count;",
    "v_ship  := p_shipping_per_delivery_gross_cents * v_count;",
    "v_total := v_merch + v_ship;",
    "if v_attempt.expected_total_gross_cents is distinct from v_total then",
    "when unique_violation then",
    "'result', 'created',",
    "'result', 'existing',",
  ]) {
    assert.ok(body039.includes(invariant), `039 no longer has: ${invariant}`);
    assert.ok(fn.includes(invariant), `040 dropped a 039 invariant: ${invariant}`);
  }
  // The totals are still computed, never accepted.
  assert.ok(!fn.includes("p_total_gross_cents"));
  assert.ok(!fn.includes("p_merchandise_total"));
});

test("38: 039's file is byte-identical and the other seven functions are untouched", () => {
  const m039 = read("supabase/migrations/039_b2c_annual_plan_foundation.sql");
  // 040 redefines exactly one function, and it is the pending-plan one.
  const redefined = [...m040Code.matchAll(/create or replace function public\.(\w+)\(/g)].map(m => m[1]);
  assert.deepEqual(redefined, ["create_pending_annual_plan_for_attempt"]);
  for (const untouched of [
    "activate_annual_plan_from_payment", "claim_due_annual_plan_deliveries",
    "fulfill_annual_plan_delivery", "apply_annual_plan_refund_state",
    "claim_annual_plan_purchase_email", "record_annual_plan_purchase_email_result",
    "complete_due_annual_plans", "create_order_from_paid_checkout",
    "apply_order_refund_state", "claim_pending_subscription_for_attempt",
  ]) {
    assert.ok(!m040Code.includes(`function public.${untouched}(`), `040 touches ${untouched}`);
  }
  // 039 still defines its own seven, which 040 leaves alone.
  for (const own of [
    "activate_annual_plan_from_payment", "claim_due_annual_plan_deliveries",
    "fulfill_annual_plan_delivery", "apply_annual_plan_refund_state",
    "claim_annual_plan_purchase_email", "record_annual_plan_purchase_email_result",
    "complete_due_annual_plans",
  ]) {
    assert.ok(m039.includes(`create or replace function public.${own}(`), `039 lost ${own}`);
  }
  // And 040 does not write into the subscription fingerprint columns.
  assert.ok(!m040Code.includes("subscription_request_fingerprint"));
  assert.ok(!m040Code.includes("subscription_intent_fingerprint"));
});

/* ══════════════════════════════════════════════════════════════
   39-42. THE FINGERPRINTS THEMSELVES
   ══════════════════════════════════════════════════════════════ */

test("39: the annual fingerprint domain is its own, and separated from the subscription one", () => {
  assert.equal(ANNUAL_FINGERPRINT_VERSION, "gloa-annual-fp-1");
  const subs = read("lib/subscriptionCheckoutRules.ts");
  assert.ok(subs.includes('export const FINGERPRINT_VERSION = "gloa-sub-fp-1";'),
    "the subscription fingerprint version changed");
  assert.notEqual(ANNUAL_FINGERPRINT_VERSION, "gloa-sub-fp-1");
  // The annual rules do not import the subscription constants and pretend
  // the domains are the same.
  assert.ok(!rulesCode.includes("gloa-sub-fp"));
  assert.ok(!rulesCode.includes("subscriptionRequestFingerprint"));
  // Every digest is 64 hex characters of SHA-256.
  const d = annualIntentFingerprint(intentFor("50g"));
  assert.match(d, /^[0-9a-f]{64}$/);
  assert.match(annualRequestFingerprint(intentFor("50g")), /^[0-9a-f]{64}$/);
  assert.match(annualAddressDigest(snapshotFor(addressRow()).snapshot), /^[0-9a-f]{64}$/);
  // The two halves of one intent are never equal.
  assert.notEqual(annualIntentFingerprint(intentFor("50g")), annualRequestFingerprint(intentFor("50g")));
});

test("40: the field lists are the contract, and they bind what they must", () => {
  assert.deepEqual([...ANNUAL_INTENT_FINGERPRINT_FIELDS],
    ["userId", "variantId", "addressId", "deliveryCount"]);
  assert.deepEqual([...ANNUAL_REQUEST_FINGERPRINT_FIELDS], [
    "userId", "variantId", "addressId", "deliveryCount", "addressDigest", "sku",
    "currency", "shippingCountry", "catalogUnitGrossCents", "discountPercentApplied",
    "annualUnitGrossCents", "shippingPerDeliveryGrossCents", "shippingTotalGrossCents",
    "totalGrossCents", "taxCalculationVersion", "taxTreatment", "taxTotalCents",
  ]);
  // The identity half carries NO priced value: it is compared even after
  // a plan exists, when the price is already frozen.
  for (const priced of ["Cents", "discount", "tax", "addressDigest"]) {
    assert.ok(!ANNUAL_INTENT_FINGERPRINT_FIELDS.some(f => f.includes(priced)),
      `the identity half carries a priced field: ${priced}`);
  }
  // Every terms field genuinely moves the digest.
  const base = annualRequestFingerprint(intentFor("50g"));
  for (const [field, value] of [
    ["userId", "99999999-8888-7777-6666-555555555555"],
    ["variantId", "88888888-7777-6666-5555-444444444444"],
    ["addressId", "77777777-6666-5555-4444-333333333333"],
    ["deliveryCount", 12],
    ["addressDigest", "deadbeef"],
    ["sku", "GLOA-MATCHA-30G"],
    ["currency", "CHF"],
    ["shippingCountry", "AT"],
    ["catalogUnitGrossCents", 3099],
    ["discountPercentApplied", 15],
    ["annualUnitGrossCents", 2700],
    ["shippingPerDeliveryGrossCents", 590],
    ["shippingTotalGrossCents", 7670],
    ["totalGrossCents", 35088],
    ["taxCalculationVersion", "de-2027.1"],
    ["taxTreatment", "de_origin_intra_eu"],
    ["taxTotalCents", 4321],
  ]) {
    assert.notEqual(annualRequestFingerprint(intentFor("50g", { [field]: value })), base,
      `changing ${field} did not change the terms digest`);
  }
});

test("41: the address digest binds every canonical field and stores no PII", () => {
  const base = annualAddressDigest(snapshotFor(addressRow()).snapshot);
  // The six edits Phase 4B3.1 proved were invisible.
  for (const [label, edit] of [
    ["street", { street: "Torstrasse" }],
    ["house number", { house_number: "99" }],
    ["postcode", { zip: "10115" }],
    ["city", { city: "Potsdam" }],
    ["recipient", { first_name: "Jonas", last_name: "Weber" }],
    ["company", { company: "GLOA GmbH" }],
  ]) {
    const edited = annualAddressDigest(snapshotFor(addressRow(edit)).snapshot);
    assert.notEqual(edited, base, `an edited ${label} produced the same digest`);
  }
  // Identical contents produce an identical digest, so an unchanged
  // retry converges.
  assert.equal(annualAddressDigest(snapshotFor(addressRow()).snapshot), base);
  // It is a digest, not the address: no readable field survives in it.
  for (const value of ["Kastanienallee", "Berlin", "10435", "Mira", "Sato", "GLOA"]) {
    assert.ok(!base.includes(value), `the address digest leaks ${value}`);
  }
  // And no address text is written into either fingerprint column.
  const writer = attemptsCode.slice(attemptsCode.indexOf("export async function getOrCreateAnnualCheckoutAttempt"));
  for (const banned of ["street", "house_number", "zip", "city", "first_name", "company"]) {
    assert.ok(!writer.includes(banned), `the annual writer stores ${banned}`);
  }
});

test("42: a stored NULL fingerprint fails closed and is never adopted", () => {
  assert.equal(attemptMatchesAnnualFingerprint(null, "x"), false);
  assert.equal(attemptMatchesAnnualFingerprint(undefined, "x"), false);
  assert.equal(attemptMatchesAnnualFingerprint("", "x"), false);
  assert.equal(attemptMatchesAnnualFingerprint("x", "x"), true);
  assert.equal(attemptMatchesAnnualFingerprint("x", "y"), false);
  // An attempt from the one-time or subscription flow, or one written
  // before 040, has NULL here and is refused rather than adopted.
  const r = verifyRetry("50g", { annual_intent_fingerprint: null });
  assert.equal(r.ok, false);
  assert.match(r.reason, /different annual checkout/);
  // The database says so too.
  assert.ok(m040Code.includes("v_attempt.annual_intent_fingerprint is null"));
});

/* ══════════════════════════════════════════════════════════════
   43-48. THE FIVE CASES
   ══════════════════════════════════════════════════════════════ */

test("43: CASE A - plan already exists, address edited afterwards, plan reused", () => {
  // The identity is unchanged by an address CONTENT edit: same customer,
  // same product, same selected address id.
  const editedAddressIntent = intentFor("50g", {
    addressDigest: annualAddressDigest(snapshotFor(addressRow({ street: "Torstrasse" })).snapshot),
  });
  assert.equal(
    annualIntentFingerprint(editedAddressIntent),
    annualIntentFingerprint(intentFor("50g")),
    "an address content edit changed the IDENTITY digest, which would break CASE A");
  // ...while the terms digest differs, which is what CASE B relies on.
  assert.notEqual(
    annualRequestFingerprint(editedAddressIntent),
    annualRequestFingerprint(intentFor("50g")));

  // So the RPC returns 'existing' before ever reaching the terms gate.
  const fn = m040Code.slice(
    m040Code.indexOf("create or replace function public.create_pending_annual_plan_for_attempt("),
    m040Code.indexOf("$$;"));
  assert.ok(fn.indexOf("'result', 'existing',") < fn.indexOf("v_attempt.annual_request_fingerprint is null"),
    "the existing-plan answer comes after the terms gate");
  // And the application adopts it without rebuilding anything.
  assert.deepEqual([...PENDING_ANNUAL_PLAN_SUCCESS_RESULTS], ["created", "existing"]);
  assert.equal(interpretPendingAnnualPlanResult({ result: "existing", annual_plan_id: PLAN_ID }).ok, true);
  for (const banned of ["update public.annual_plans", "annual_plans"]) {
    assert.ok(!flow.includes(banned), `the flow writes the plan: ${banned}`);
  }

  // A CATALOG CHANGE after the plan exists is equally harmless: Stripe is
  // built from the FROZEN attempt, not from a fresh price.
  assert.ok(flow.includes("annualUnitGrossCents: frozenItem.unitGrossCents"));
  assert.ok(flow.includes("shippingTotalGrossCents: frozenShippingTotal"));
});

test("44: CASE B - no plan yet, same addressId, contents changed, refused", () => {
  const base = annualRequestFingerprint(intentFor("50g"));
  for (const [label, edit] of [
    ["street", { street: "Torstrasse" }],
    ["house number", { house_number: "99" }],
    ["postcode", { zip: "10115" }],
    ["city", { city: "Potsdam" }],
    ["recipient name", { first_name: "Jonas", last_name: "Weber" }],
    ["company", { company: "GLOA GmbH" }],
  ]) {
    const digest = annualAddressDigest(snapshotFor(addressRow(edit)).snapshot);
    assert.notEqual(annualRequestFingerprint(intentFor("50g", { addressDigest: digest })), base,
      `an edited ${label} did not change the terms digest`);
  }
  // The database refuses it, under the lock, with its own word.
  assert.ok(m040Code.includes("'result', 'attempt_request_mismatch',"));
  // And the route answers 409, not 503: retrying will never fix it. The
  // conflict family is the set of refusals that are statements about the
  // REQUEST rather than about the server.
  assert.deepEqual([...ANNUAL_PENDING_PLAN_CONFLICT_RESULTS], [
    "attempt_intent_mismatch", "attempt_request_mismatch", "attempt_not_owned",
    "attempt_not_pre_stripe", "total_mismatch",
  ]);
  for (const conflict of ANNUAL_PENDING_PLAN_CONFLICT_RESULTS) {
    assert.equal(annualPendingPlanFailureStatus(conflict), 409, conflict);
  }
  // Anything else, including a word nobody has seen, stays retryable.
  for (const retryable of ["attempt_not_found", "invalid_input", "unknown", ""]) {
    assert.equal(annualPendingPlanFailureStatus(retryable), 503, retryable);
  }
  assert.equal(annualPendingPlanFailureStatus("attempt_request_mismatch"), 409);
  assert.ok(flow.includes('fail(409, "Diese Anfrage-ID gehört zu einem anderen Vorgang.")'));
  // No digest reaches the customer.
  const block = flow.slice(at("const status = annualPendingPlanFailureStatus("), at("const annualPlanId"));
  assert.ok(!block.includes("pending.reason)") || block.includes("console.error"),
    "the refusal reason is returned rather than logged");
  assert.ok(!block.includes("fingerprint"), "a fingerprint value reaches the response");
});

test("45: CASE C - no plan yet, a different addressId, refused", () => {
  const other = "66666666-5555-4444-3333-222222222222";
  // Identical contents and identical pricing, different selected address.
  const changed = intentFor("50g", { addressId: other });
  assert.notEqual(annualIntentFingerprint(changed), annualIntentFingerprint(intentFor("50g")),
    "a different addressId did not change the IDENTITY digest");
  assert.notEqual(annualRequestFingerprint(changed), annualRequestFingerprint(intentFor("50g")));
  // The identity gate catches it, so it is refused even if a plan exists.
  const r = verifyRetry("50g", {}, { addressId: other });
  assert.equal(r.ok, false);
  assert.match(r.reason, /different annual checkout/);
  assert.equal(annualPendingPlanFailureStatus("attempt_intent_mismatch"), 409);
});

test("46: CASE D - no plan yet, identical request, accepted", () => {
  const r = verifyRetry("50g");
  assert.equal(r.ok, true);
  // Both digests are stable across repeated computation, so a retry
  // converges rather than drifting.
  assert.equal(annualIntentFingerprint(intentFor("50g")), annualIntentFingerprint(intentFor("50g")));
  assert.equal(annualRequestFingerprint(intentFor("50g")), annualRequestFingerprint(intentFor("50g")));
  // And the RPC's success words are the only ones accepted.
  assert.equal(interpretPendingAnnualPlanResult({ result: "created", annual_plan_id: PLAN_ID }).ok, true);
});

test("47: CASE E - a different user or a different variant is refused", () => {
  const otherUser = "99999999-8888-7777-6666-555555555555";
  assert.notEqual(annualIntentFingerprint(intentFor("50g", { userId: otherUser })),
    annualIntentFingerprint(intentFor("50g")));
  // Two independent refusals: the stored user_id and the identity digest.
  const byUser = verifyRetry("50g", { user_id: otherUser });
  assert.equal(byUser.ok, false);
  assert.match(byUser.reason, /another customer/);
  const byIntent = verifyRetry("50g", {}, { userId: otherUser });
  assert.equal(byIntent.ok, false);
  // A third, in the database, under the lock.
  assert.ok(m040Code.includes("if v_attempt.user_id is distinct from p_user_id then"));

  // A different variant changes both digests and the frozen item.
  assert.notEqual(annualIntentFingerprint(intentFor("30g")), annualIntentFingerprint(intentFor("50g")));
  const byVariant = verifyFrozenAnnualAttempt({
    attempt: frozenAttempt("50g"), userId: UUID, plan: planFor("30g"), pricing: pricingFor("30g"),
    intentFingerprint: annualIntentFingerprint(intentFor("30g")),
  });
  assert.equal(byVariant.ok, false);
});

test("48: the four attempt populations stay structurally distinguishable", () => {
  // Migration 025 reads the non-NULL-ness of its two columns as the
  // DEFINITION of "this attempt is a subscription checkout". The annual
  // flow therefore got its own two rather than borrowing those.
  const m025 = read("supabase/migrations/025_grant_subscription_plans_service_role.sql");
  assert.ok(m025.includes("is not a subscription checkout"),
    "migration 025's definition changed, so this reasoning is stale");

  const annualWriter = attemptsCode.slice(attemptsCode.indexOf("export async function getOrCreateAnnualCheckoutAttempt"));
  const subWriter = attemptsCode.slice(
    attemptsCode.indexOf("export async function getOrCreateSubscriptionCheckoutAttempt"),
    attemptsCode.indexOf("export async function findAttemptByStripeSessionId"));
  const oneTimeWriter = attemptsCode.slice(
    attemptsCode.indexOf("export async function getOrCreateCheckoutAttempt"),
    attemptsCode.indexOf("export async function linkStripeSession"));

  // annual writes annual only
  assert.ok(annualWriter.includes("annual_intent_fingerprint:"));
  assert.ok(!annualWriter.includes("subscription_request_fingerprint"));
  // subscription writes subscription only
  assert.ok(subWriter.includes("subscription_request_fingerprint: input.fingerprint"));
  assert.ok(!subWriter.includes("annual_intent_fingerprint"));
  // one-time writes neither
  assert.ok(!oneTimeWriter.includes("fingerprint"));
  // and the synthetic delivery attempt, which 039 mints in SQL, writes
  // neither family either.
  const m039 = read("supabase/migrations/039_b2c_annual_plan_foundation.sql");
  const prepare = m039.slice(m039.indexOf("insert into public.checkout_attempts"));
  const insertCols = prepare.slice(0, prepare.indexOf(") values"));
  for (const banned of ["fingerprint"]) {
    assert.ok(!insertCols.includes(banned), `039's delivery attempt writes ${banned}`);
  }
});

test("49: this phase still activates nothing and touches no other runtime", () => {
  for (const banned of [
    "activate_annual_plan_from_payment", "fulfill_annual_plan_delivery",
    "create_order_from_paid_checkout", "markAttemptPaid", "Resend",
  ]) {
    assert.ok(!flow.includes(banned), `the checkout flow calls ${banned}`);
    assert.ok(!depsCode.includes(banned), `the wiring reaches for ${banned}`);
  }
  // The webhook still has no annual branch.
  assert.ok(!withoutComments(read("app/api/stripe/webhook/route.ts")).includes("annual"));
  // The cron is untouched.
  assert.ok(!read("app/api/cron/retry-order-notifications/route.ts").includes("annual"));
  // The flag is still closed by default.
  assert.match(read(".env.example"), /^B2C_ANNUAL_PLAN_ENABLED=$/m);
  assert.ok(read("lib/annualPlans.ts").includes('return env[ANNUAL_PLAN_FEATURE_FLAG] === "true";'));
});
