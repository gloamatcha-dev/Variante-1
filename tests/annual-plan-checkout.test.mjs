import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ALLOWED_ANNUAL_REQUEST_FIELDS,
  ANNUAL_ALLOWED_COUNTRY,
  ANNUAL_CHECKOUT_VERSION,
  ANNUAL_SHIPPING_ZONE,
  PENDING_ANNUAL_PLAN_SUCCESS_RESULTS,
  annualCheckoutIdempotencyKey,
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
const variantFor = (size, over = {}) => ({
  variantId: UUID,
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
    ...over,
  };
};

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
});

test("18: the payment attempt carries no annual binding and no Stripe identity", () => {
  const writer = attemptsCode.slice(attemptsCode.indexOf("export async function getOrCreateAnnualCheckoutAttempt"));
  const upsert = writer.slice(writer.indexOf(".upsert("), writer.indexOf("ignoreDuplicates"));
  for (const forbidden of [
    "annual_plan_id", "annual_delivery_number", "subscription_id", "stripe_invoice_id",
    "stripe_checkout_session_id", "stripe_payment_intent_id", "paid_at", "status:",
    "subscription_request_fingerprint", "subscription_intent_fingerprint",
  ]) {
    assert.ok(!upsert.includes(forbidden), `the annual payment attempt writes ${forbidden}`);
  }
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
  const ok = verifyFrozenAnnualAttempt({ attempt: frozenAttempt("50g"), userId: UUID, plan, pricing });
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
    const r = verifyFrozenAnnualAttempt({ attempt: frozenAttempt("50g", over), userId: UUID, plan, pricing });
    assert.equal(r.ok, false, JSON.stringify(over));
    assert.match(r.reason, reason);
  }
  // Same request id, different product: a 30 g attempt cannot become a
  // 50 g purchase.
  const crossed = verifyFrozenAnnualAttempt({
    attempt: frozenAttempt("30g"), userId: UUID, plan, pricing,
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
  ];
  for (const arg of expected) assert.ok(call.includes(`${arg}:`), `missing RPC argument ${arg}`);
  assert.equal((call.match(/p_[a-z_]+:/g) || []).length, 13, "the RPC call does not pass exactly 13 arguments");
  // 039 computes the totals itself; passing them would be a second place
  // for the money to be wrong.
  for (const forbidden of ["p_total", "p_merchandise", "p_shipping_total", "p_delivery_count"]) {
    assert.ok(!call.includes(forbidden), `the RPC call passes ${forbidden}`);
  }
  // The signature the migration actually installed.
  const migration = read("supabase/migrations/039_b2c_annual_plan_foundation.sql");
  for (const arg of expected) {
    assert.ok(migration.includes(arg), `039 has no argument ${arg}`);
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
  // A refused RPC leaves the attempt for the retry.
  const rpcBlock = flow.slice(at("if (!pending.ok)"), at("const annualPlanId"));
  assert.match(rpcBlock, /return fail\(503, UNAVAILABLE\);/);
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
    assert.match(line, /^import type /, `a value import reached the rules leaf: ${line}`);
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

test("32: migrations 001-039 are untouched and no 040 exists", () => {
  const migrations = readdirSync(path.join(ROOT, "supabase/migrations"))
    .filter(f => f.endsWith(".sql")).sort();
  assert.equal(migrations.length, 39);
  assert.equal(migrations[migrations.length - 1], "039_b2c_annual_plan_foundation.sql");
  assert.deepEqual(migrations.filter(f => Number(f.slice(0, 3)) > 39), []);
});
