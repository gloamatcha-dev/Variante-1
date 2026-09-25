import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  B2B_INSTALMENT_COUNTS,
  B2B_SELF_SERVICE_MAX_PACKS,
  B2B_MIN_PACKS,
  PACK_NET_CENTS,
  allocateInstalments,
  annualProductNetCents,
} from "../lib/b2bPricingRules.ts";
import { addTaxToNet } from "../lib/tax.ts";
import {
  B2B_TAX_RATE_PERCENT,
  b2bFirstCharge,
  isB2bSelfServiceShippable,
  validateB2bCheckoutRequest,
} from "../lib/b2bCheckoutRules.ts";
import {
  B2B_SESSION_AGREEMENT_METADATA_KEY,
  B2B_SESSION_CHECKOUT_VERSION,
  acknowledgeB2bPaymentFailure,
  routeB2bSession,
  routeB2bSubscriptionInvoice,
} from "../lib/b2bWebhookRules.ts";
import {
  B2B_BILLING_INTERVAL,
  B2B_BILLING_INTERVAL_COUNT,
  b2bMonthlyPriceLookupKey,
} from "../lib/b2bRecurringPrice.ts";
import { handleB2bCheckout } from "../lib/b2bCheckout.ts";
import { settleB2bCheckoutSession, settleB2bPaidInvoice } from "../lib/b2bWebhook.ts";

/**
 * PACKAGES 5B + 5C — B2B CHECKOUT AND SETTLEMENT.
 *
 * ── WHAT THIS SUITE IS PROTECTING ─────────────────────────────
 *
 *   1. THE FLAG IS THE FIRST THING. A closed flag must cost one boolean
 *      and reach no database, no Stripe call and no body parse. Section 1
 *      proves it by giving the flow deps that THROW if touched.
 *
 *   2. THE CUSTOMER CANNOT NAME A PRICE. The request body has no amount
 *      field at all, and the frozen expected total is derived from
 *      Package 1 and lib/tax.ts. Section 3 derives the expected figures
 *      by CALLING those authorities, so a drift in either direction
 *      fails here.
 *
 *   3. expected_total_gross_cents MEANS THE FIRST CHARGE, and the Stripe
 *      amount equals it exactly. That is the Package 5A debt, closed.
 *
 *   4. B2B ROUTES BEFORE EVERY B2C BRANCH, and B2C routing is untouched.
 *      Section 5 reads the webhook source and proves the ordering
 *      positionally, then proves that non-B2B metadata still answers
 *      not_b2b.
 *
 *   5. MONTHLY DOES NOT ACTIVATE ON A SESSION. invoice.paid is the
 *      canonical event; a session that activated a monthly contract
 *      would activate it before a subscription id exists.
 *
 *   6. CONVERGENCE. Both event orders, both redeliveries, and two event
 *      ids for one invoice all produce one agreement, n payment rows and
 *      twelve deliveries.
 *
 * ── WHAT IT CANNOT PROVE ──────────────────────────────────────
 *
 * It never calls Stripe and never opens a database. The RPC bodies in
 * migration 062 are proved against a real PostgreSQL 17 cluster
 * separately; what is asserted here is everything that decides WHICH
 * writer is called, WITH WHAT, and IN WHAT ORDER.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS = path.join(ROOT, "supabase", "migrations");
const MIGRATION = "062_b2b_checkout_settlement.sql";
const NEWLINE = /\r?\n/;
const read = rel => readFileSync(path.join(ROOT, rel), "utf-8");
/**
 * The same file with every comment removed.
 *
 * Several assertions below forbid a WORD - "parcel", "automatic_tax",
 * "yes" - and the modules they scan deliberately NAME those words in
 * their comments in order to explain why the thing is absent. Scanning
 * the prose would therefore forbid the explanation rather than the
 * fabrication, so every such assertion reads code only.
 */
const readCode = rel =>
  read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const migration = read(`supabase/migrations/${MIGRATION}`);
const sql = migration.replace(/^\s*--.*$/gm, "");
const flat = sql.replace(/\s+/g, " ");
const webhookSource = read("app/api/stripe/webhook/route.ts");

const ANNUAL_WRITER = "activate_b2b_annual_from_payment";
const MONTHLY_WRITER = "settle_b2b_monthly_paid_invoice";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_ATTEMPT = "22222222-2222-4222-8222-222222222222";
const UUID_AGREEMENT = "33333333-3333-4333-8333-333333333333";
const UUID_ADDRESS = "44444444-4444-4444-8444-444444444444";

const BERLIN = {
  id: UUID_ADDRESS, user_id: UUID_A, first_name: "A", last_name: "B", company: "Test GmbH",
  street: "Str", house_number: "1", zip: "10115", city: "Berlin", country: "DE",
};
const MUNICH = { ...BERLIN, zip: "80331", city: "München" };
const PARIS = { ...BERLIN, zip: "75001", city: "Paris", country: "FR" };

/** Deps that scream if the flow reaches them. */
const forbidden = name => () => {
  throw new Error(`the flow reached ${name}, which must not happen`);
};

function stubDeps(overrides = {}) {
  const calls = [];
  const record = (name, value) => (...args) => {
    calls.push({ name, args });
    return typeof value === "function" ? value(...args) : value;
  };
  const deps = {
    calls,
    isEnabled: () => true,
    verifyCaller: record("verifyCaller", async () => ({
      userId: UUID_A, token: "tok", email: "biz@example.test",
    })),
    isBusinessAccount: record("isBusinessAccount", async () => true),
    loadOwnAddress: record("loadOwnAddress", async () => BERLIN),
    loadBusinessProfile: record("loadBusinessProfile", async () => ({
      company_name: "Test GmbH", legal_form: "GmbH", vat_id: "DE123", tax_number: "1",
    })),
    getStripe: record("getStripe", () => ({
      checkout: {
        sessions: {
          create: async params => {
            calls.push({ name: "sessions.create", args: [params] });
            return { id: "cs_test_1", url: "https://stripe.test/cs_test_1" };
          },
        },
      },
    })),
    getOrigin: () => "https://gloa.test",
    ensureStripeCustomer: record("ensureStripeCustomer", async () => ({
      ok: true, stripeCustomerId: "cus_1", created: false,
    })),
    ensureAttempt: record("ensureAttempt", async input => ({
      ok: true,
      attempt: {
        id: UUID_ATTEMPT,
        currency: "EUR",
        expected_total_gross_cents: input.expectedTotalGrossCents,
      },
    })),
    claimAgreement: record("claimAgreement", async () => ({
      ok: true, agreementId: UUID_AGREEMENT, result: "created",
    })),
    ensureMonthlyPrice: record("ensureMonthlyPrice", async () => ({
      ok: true, priceId: "price_1", lookupKey: "lk", created: false,
    })),
    linkSession: record("linkSession", async () => true),
  };
  return { ...deps, ...overrides, calls };
}

const req = (body = {}) =>
  new Request("https://gloa.test/api/b2b/supply/checkout/session", {
    method: "POST",
    headers: { authorization: "Bearer tok", "content-type": "application/json" },
    body: JSON.stringify({
      requestId: "55555555-5555-4555-8555-555555555555",
      addressId: UUID_ADDRESS,
      planType: "monthly",
      packs: 2,
      ...body,
    }),
  });

const sessionParams = deps => deps.calls.find(c => c.name === "sessions.create")?.args[0];

/* ══════════════════════════════════════════════════════════════
   1. THE FLAG, AND THE GATES BEFORE ANY SIDE EFFECT
   ══════════════════════════════════════════════════════════════ */

test("1: a closed flag stops before the body, the database and Stripe", async () => {
  const deps = stubDeps({
    isEnabled: () => false,
    verifyCaller: forbidden("verifyCaller"),
    isBusinessAccount: forbidden("isBusinessAccount"),
    loadOwnAddress: forbidden("loadOwnAddress"),
    ensureAttempt: forbidden("ensureAttempt"),
    claimAgreement: forbidden("claimAgreement"),
    ensureStripeCustomer: forbidden("ensureStripeCustomer"),
    ensureMonthlyPrice: forbidden("ensureMonthlyPrice"),
    getStripe: forbidden("getStripe"),
  });
  const res = await handleB2bCheckout(req(), deps);
  assert.equal(res.status, 404, "a closed flag must not advertise the endpoint");
  assert.equal(deps.calls.length, 0, "a closed flag reached a dependency");
});

test("1b: the flag is server-side, closed by default, and exact-match only", () => {
  const flag = read("lib/b2bFeatureFlag.ts");
  // Code only: the comment deliberately explains why the name is NOT
  // VITE_-prefixed, and a scan of the prose would make that unwritable.
  const flagCode = readCode("lib/b2bFeatureFlag.ts");
  assert.ok(!flagCode.includes("VITE_"), "the flag is bundled into the browser");
  assert.ok(!flagCode.includes("import.meta.env"), "the flag is read from the client bundle");
  assert.match(flag, /process\.env\[B2B_SELF_SERVICE_FLAG\] === "true"/);
  // Any other value is closed. A flag that opens on a typo is not a flag.
  assert.ok(!/!==|toLowerCase|trim\(|Boolean\(|== "1"|"yes"/.test(flagCode),
    "the flag admits something other than the exact string true");
  assert.ok(read("app/api/b2b/supply/checkout/session/route.ts").includes("b2bCheckoutDeps"));
});

test("2: a non-business account is refused before any write", async () => {
  const deps = stubDeps({
    isBusinessAccount: async () => false,
    loadOwnAddress: forbidden("loadOwnAddress"),
    ensureAttempt: forbidden("ensureAttempt"),
    claimAgreement: forbidden("claimAgreement"),
  });
  const res = await handleB2bCheckout(req(), deps);
  assert.equal(res.status, 403);
});

test("2b: an unauthenticated caller is refused before any write", async () => {
  const deps = stubDeps({
    verifyCaller: async () => null,
    isBusinessAccount: forbidden("isBusinessAccount"),
    ensureAttempt: forbidden("ensureAttempt"),
  });
  assert.equal((await handleB2bCheckout(req(), deps)).status, 401);
});

test("3: an invalid quantity or instalment count never reaches the database", async () => {
  for (const [body, label] of [
    [{ packs: 0 }, "zero packs"],
    [{ packs: 11 }, "eleven packs"],
    [{ packs: 2.5 }, "fractional packs"],
    [{ planType: "weekly" }, "an unknown plan"],
    [{ planType: "annual", instalmentCount: 3 }, "three instalments"],
    [{ planType: "annual" }, "annual with no instalment count"],
    [{ planType: "monthly", instalmentCount: 4 }, "monthly with instalments"],
  ]) {
    const deps = stubDeps({
      ensureAttempt: forbidden("ensureAttempt"),
      claimAgreement: forbidden("claimAgreement"),
      getStripe: forbidden("getStripe"),
    });
    const res = await handleB2bCheckout(req(body), deps);
    assert.equal(res.status, 400, `${label} was accepted`);
  }
});

test("4: a non-German address is refused, and it is a different answer", async () => {
  const deps = stubDeps({ loadOwnAddress: async () => PARIS, ensureAttempt: forbidden("ensureAttempt") });
  const res = await handleB2bCheckout(req(), deps);
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /Deutschland/);
});

/* ══════════════════════════════════════════════════════════════
   2. THE TEMPORARY BERLIN-ONLY GATE (Package 5B, removed by 5E)
   ══════════════════════════════════════════════════════════════ */

test("5: a German non-Berlin address is refused by the TEMPORARY gate, not by validation", async () => {
  // THE DISTINCTION MATTERS. The permanent rule says Germany only and
  // Berlin is a route rather than a gate, and validation still says so -
  // a Munich address VALIDATES. What refuses it is the separate 5B gate,
  // which exists only because no DHL measurement and no approved B2B
  // customer shipping charge exist yet.
  const munichQuote = validateB2bCheckoutRequest({
    planType: "monthly", packs: 2, deliveryAddress: { country: "DE", postcode: "80331" },
  });
  assert.equal(munichQuote.ok, true, "the permanent rule wrongly rejects Munich");
  assert.equal(isB2bSelfServiceShippable(munichQuote.quote), false);

  const deps = stubDeps({
    loadOwnAddress: async () => MUNICH,
    ensureAttempt: forbidden("ensureAttempt"),
    claimAgreement: forbidden("claimAgreement"),
    getStripe: forbidden("getStripe"),
  });
  const res = await handleB2bCheckout(req(), deps);
  assert.equal(res.status, 409, "the temporary gate must be its own status");
  assert.match((await res.json()).error, /Berlin/);
  // AND NOTHING WAS CREATED. The gate is before the first write.
  assert.equal(deps.calls.filter(c => c.name === "ensureAttempt").length, 0);
});

test("5b: Berlin is accepted, at both ends of the postcode range", async () => {
  for (const zip of ["10115", "14199", "12047"]) {
    const deps = stubDeps({ loadOwnAddress: async () => ({ ...BERLIN, zip }) });
    const res = await handleB2bCheckout(req(), deps);
    assert.equal(res.status, 200, `Berlin ${zip} was refused`);
  }
  // Just outside is not Berlin.
  for (const zip of ["10114", "14200"]) {
    const q = validateB2bCheckoutRequest({
      planType: "monthly", packs: 2, deliveryAddress: { country: "DE", postcode: zip },
    });
    assert.equal(isB2bSelfServiceShippable(q.quote), false, `${zip} counted as Berlin`);
  }
});

test("5c: the gate is ONE function and ONE call site, so 5E deletes two lines", () => {
  const rules = read("lib/b2bCheckoutRules.ts");
  const flow = read("lib/b2bCheckout.ts");
  assert.equal((rules.match(/export function isB2bSelfServiceShippable/g) ?? []).length, 1);
  assert.equal((flow.match(/isB2bSelfServiceShippable\(/g) ?? []).length, 1,
    "the temporary gate has more than one call site");
  // And it is labelled as temporary in both places, so it cannot be
  // mistaken for the permanent rule.
  assert.ok(/TEMPORARY/.test(rules) && /TEMPORARY/.test(flow));
  // No fabricated shipping fact anywhere in the 5B surface.
  // Code only. The comments deliberately NAME the missing facts in order
  // to explain the gate, so scanning the prose would forbid the
  // explanation rather than the fabrication.
  for (const f of ["lib/b2bCheckout.ts", "lib/b2bCheckoutRules.ts", "lib/b2bCheckoutDeps.ts"]) {
    const src = readCode(f);
    for (const forbiddenWord of [/weightGrams/i, /parcel/i, /dimension/i, /girth/i, /tare/i,
                                 /dhl/i, /carrierRetail/i]) {
      assert.ok(!forbiddenWord.test(src), `${f} invents a shipping fact: ${forbiddenWord}`);
    }
  }
});

/* ══════════════════════════════════════════════════════════════
   3. THE FIRST CHARGE  (the Package 5A debt, closed)
   ══════════════════════════════════════════════════════════════ */

const quoteFor = (planType, packs, instalmentCount) =>
  validateB2bCheckoutRequest({
    planType, packs, instalmentCount,
    deliveryAddress: { country: "DE", postcode: "10115" },
  }).quote;

test("6: MONTHLY expected_total_gross_cents is the first monthly product gross, exactly", () => {
  for (let packs = B2B_MIN_PACKS; packs <= B2B_SELF_SERVICE_MAX_PACKS; packs += 1) {
    const charge = b2bFirstCharge(quoteFor("monthly", packs));
    const net = packs * PACK_NET_CENTS;
    const expected = addTaxToNet(net, B2B_TAX_RATE_PERCENT);
    assert.equal(charge.netCents, net);
    assert.equal(charge.grossCents, expected.grossCents, `${packs} packs`);
    assert.equal(charge.taxCents, expected.taxCents);
    assert.equal(charge.netCents + charge.taxCents, charge.grossCents, "net + tax must be exact");
    // Berlin shipping is zero, and it is the only address the gate admits.
    assert.equal(charge.shippingGrossCents, 0);
    assert.equal(charge.taxRatePercent, 7);
    assert.equal(charge.calculationVersion, "de-net-2026.1");
    assert.equal(charge.priceOrigin, "net");
  }
});

test("7: ANNUAL expected_total_gross_cents is INSTALMENT 1 ONLY", () => {
  for (let packs = B2B_MIN_PACKS; packs <= B2B_SELF_SERVICE_MAX_PACKS; packs += 1) {
    const contract = annualProductNetCents(packs);
    for (const n of B2B_INSTALMENT_COUNTS) {
      const charge = b2bFirstCharge(quoteFor("annual", packs, n));
      const instalments = allocateInstalments(contract, n);
      assert.equal(charge.netCents, instalments[0], `${packs} packs / ${n} instalments`);
      assert.equal(charge.grossCents, addTaxToNet(instalments[0], 7).grossCents);

      // AND IT IS NOT THE WHOLE CONTRACT when n > 1. This is the exact
      // mistake the 5A deferral existed to prevent.
      if (n > 1) {
        assert.notEqual(charge.netCents, contract,
          `${n} instalments charged the whole contract up front`);
        assert.ok(charge.netCents < contract);
      } else {
        assert.equal(charge.netCents, contract, "a single instalment IS the contract");
      }
    }
  }
});

test("7b: the approved worked example, charged to the cent", () => {
  // 1 pack, annual, 4 instalments: 53550 net split 13387/13387/13387/13389.
  // The FIRST charge is 13387 net -> 14324 gross at 7 %.
  const charge = b2bFirstCharge(quoteFor("annual", 1, 4));
  assert.equal(charge.netCents, 13387);
  assert.equal(charge.taxCents, 937);
  assert.equal(charge.grossCents, 14324);
  assert.equal(addTaxToNet(13387, 7).grossCents, 14324);
});

test("8: the Stripe charge equals the frozen attempt total, exactly", async () => {
  // ANNUAL: the session's own unit_amount is the number.
  const deps = stubDeps();
  await handleB2bCheckout(req({ planType: "annual", packs: 3, instalmentCount: 2 }), deps);
  const frozen = deps.calls.find(c => c.name === "ensureAttempt").args[0].expectedTotalGrossCents;
  const params = sessionParams(deps);
  assert.equal(params.mode, "payment");
  assert.equal(params.line_items[0].price_data.unit_amount, frozen);
  assert.equal(frozen, b2bFirstCharge(quoteFor("annual", 3, 2)).grossCents);

  // MONTHLY: the recurring Price carries it.
  const m = stubDeps();
  await handleB2bCheckout(req({ planType: "monthly", packs: 3 }), m);
  const mFrozen = m.calls.find(c => c.name === "ensureAttempt").args[0].expectedTotalGrossCents;
  const priceArgs = m.calls.find(c => c.name === "ensureMonthlyPrice").args[1];
  assert.equal(priceArgs.unitAmountCents, mFrozen);
  assert.equal(mFrozen, b2bFirstCharge(quoteFor("monthly", 3)).grossCents);
});

test("9: the request body carries no amount, and the flow reads none", async () => {
  // A client that sends amounts must be ignored entirely.
  const deps = stubDeps();
  const hostile = new Request("https://gloa.test/x", {
    method: "POST",
    headers: { authorization: "Bearer tok", "content-type": "application/json" },
    body: JSON.stringify({
      requestId: "55555555-5555-4555-8555-555555555555",
      addressId: UUID_ADDRESS, planType: "monthly", packs: 2,
      expectedTotalGrossCents: 1, unitAmount: 1, price: 1, amount: 1, grossCents: 1,
    }),
  });
  await handleB2bCheckout(hostile, deps);
  const frozen = deps.calls.find(c => c.name === "ensureAttempt").args[0].expectedTotalGrossCents;
  assert.equal(frozen, b2bFirstCharge(quoteFor("monthly", 2)).grossCents);
  assert.notEqual(frozen, 1, "a client-supplied amount was used");

  const flow = read("lib/b2bCheckout.ts");
  for (const field of ["body.amount", "body.price", "body.total", "body.expectedTotal", "body.grossCents"]) {
    assert.ok(!flow.includes(field), `the flow reads ${field} from the body`);
  }
});

/* ══════════════════════════════════════════════════════════════
   4. ORDERING, METADATA AND THE STRIPE SHAPES
   ══════════════════════════════════════════════════════════════ */

test("10: the agreement is created BEFORE the Stripe session", async () => {
  const deps = stubDeps();
  await handleB2bCheckout(req(), deps);
  const names = deps.calls.map(c => c.name);
  assert.ok(names.indexOf("ensureAttempt") < names.indexOf("claimAgreement"),
    "the agreement was claimed before the attempt existed");
  assert.ok(names.indexOf("claimAgreement") < names.indexOf("sessions.create"),
    "the Stripe session was created before the agreement id existed");
  assert.ok(names.indexOf("sessions.create") < names.indexOf("linkSession"));
});

test("11: the session metadata is exactly the four correlation keys", async () => {
  const deps = stubDeps();
  await handleB2bCheckout(req(), deps);
  const meta = sessionParams(deps).metadata;
  assert.deepEqual(Object.keys(meta).sort(),
    ["checkout_attempt_id", "checkout_version", "gloa_b2b_agreement_id", "request_id"]);
  assert.equal(meta.gloa_b2b_agreement_id, UUID_AGREEMENT);
  assert.equal(meta.checkout_version, B2B_SESSION_CHECKOUT_VERSION);
  // No money, no identity, no product.
  const serialized = JSON.stringify(meta);
  for (const forbiddenWord of ["cents", "packs", "plan", "amount", "@", "GmbH"]) {
    assert.ok(!serialized.includes(forbiddenWord), `metadata carries ${forbiddenWord}`);
  }
});

test("12: MONTHLY propagates the agreement id onto the SUBSCRIPTION", async () => {
  const deps = stubDeps();
  await handleB2bCheckout(req({ planType: "monthly", packs: 2 }), deps);
  const params = sessionParams(deps);
  assert.equal(params.mode, "subscription");
  // MANDATORY: invoice.paid can arrive before checkout.session.completed,
  // and at that moment the agreement row has no stripe_subscription_id -
  // so the subscription's own metadata is the only way to find it.
  assert.deepEqual(params.subscription_data.metadata,
    { gloa_b2b_agreement_id: UUID_AGREEMENT });
  assert.ok(!("gloa_subscription_id" in params.subscription_data.metadata),
    "a B2B subscription carries the consumer routing key");
});

test("13: MONTHLY bills a TRUE calendar month, never the B2C four-week cadence", async () => {
  assert.equal(B2B_BILLING_INTERVAL, "month");
  assert.equal(B2B_BILLING_INTERVAL_COUNT, 1);
  // The B2C module is unchanged and still four-weekly - proof that the
  // B2B cadence was added rather than taken from it.
  const b2c = read("lib/stripeRecurringPrice.ts");
  assert.match(b2c, /export const SUBSCRIPTION_INTERVAL[^=]*=\s*"week";/,
    "the B2C cadence changed - B2B must not have taken it");
  assert.match(b2c, /export const SUBSCRIPTION_INTERVAL_COUNT = 4;/);
  // And the two lookup-key namespaces cannot collide even at one amount.
  assert.match(b2bMonthlyPriceLookupKey(2, 11235), /^gloa-b2b-supply-2p-11235-m1$/);
  assert.ok(!b2bMonthlyPriceLookupKey(2, 11235).includes("-w4"));
  // The B2B price builder never asks Stripe to compute tax: B2B is
  // net-origin and the gross is already final.
  assert.ok(!/automatic_tax|tax_behavior/.test(readCode("lib/b2bRecurringPrice.ts")),
    "the B2B price asks Stripe to compute tax - B2B is net-origin and the gross is final");
});

test("14: ANNUAL saves the payment method ONLY when later instalments exist", async () => {
  // n > 1: instalments 2..n are charged in Package 5D by Stripe Invoices
  // with collection_method charge_automatically, which needs a stored,
  // off-session-usable payment method. setup_future_usage is the typed
  // Checkout field that takes that mandate while the customer is present.
  for (const n of [2, 4]) {
    const deps = stubDeps();
    await handleB2bCheckout(req({ planType: "annual", packs: 2, instalmentCount: n }), deps);
    const params = sessionParams(deps);
    assert.equal(params.mode, "payment");
    assert.equal(params.payment_intent_data.setup_future_usage, "off_session",
      `${n} instalments took no future-payment mandate`);
  }
  // n = 1: there is nothing to charge later, so asking the customer to
  // authorise future payments would be asking for something untrue.
  const one = stubDeps();
  await handleB2bCheckout(req({ planType: "annual", packs: 2, instalmentCount: 1 }), one);
  const params = sessionParams(one);
  assert.ok(!("setup_future_usage" in params.payment_intent_data),
    "a single-instalment annual checkout took an unnecessary future-payment mandate");
  // And no annual session is ever a subscription: 059 forbids an annual
  // agreement from carrying a subscription id at all.
  assert.equal(params.mode, "payment");
  assert.ok(!("subscription_data" in params));
});

test("15: ANNUAL propagates the correlation onto the PaymentIntent too", async () => {
  const deps = stubDeps();
  await handleB2bCheckout(req({ planType: "annual", packs: 2, instalmentCount: 2 }), deps);
  assert.deepEqual(sessionParams(deps).payment_intent_data.metadata,
    { gloa_b2b_agreement_id: UUID_AGREEMENT });
});

test("16: a repeated request converges, and a repriced retry is refused", async () => {
  // The attempt writer returns the ORIGINAL frozen total on a retry.
  const deps = stubDeps();
  const a = await handleB2bCheckout(req(), deps);
  const b = await handleB2bCheckout(req(), deps);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal((await a.json()).agreementId, (await b.json()).agreementId);

  // If the frozen total disagrees with what this request computed, the
  // customer is looking at a different offer - refuse rather than charge
  // either number.
  // getStripe is a lazy CLIENT FACTORY and makes no API call, so the flow
  // may resolve it before the attempt; what must not happen is a session.
  const stale = stubDeps({
    ensureAttempt: async () => ({
      ok: true,
      attempt: { id: UUID_ATTEMPT, currency: "EUR", expected_total_gross_cents: 999 },
    }),
    claimAgreement: forbidden("claimAgreement"),
    getStripe: () => ({ checkout: { sessions: { create: forbidden("sessions.create") } } }),
  });
  assert.equal((await handleB2bCheckout(req(), stale)).status, 409);
});

test("17: a conflicting agreement replay is refused, and Stripe is never reached", async () => {
  const deps = stubDeps({
    claimAgreement: async () => ({
      ok: false, result: "conflicting_agreement", reason: "different configuration",
    }),
    ensureStripeCustomer: forbidden("ensureStripeCustomer"),
    getStripe: () => ({ checkout: { sessions: { create: forbidden("sessions.create") } } }),
  });
  const res = await handleB2bCheckout(req(), deps);
  assert.equal(res.status, 409);
});

test("18: a Stripe session failure produces no entitlement and stays retryable", async () => {
  const deps = stubDeps({
    getStripe: () => ({
      checkout: { sessions: { create: async () => { throw new Error("stripe down"); } } },
    }),
  });
  const res = await handleB2bCheckout(req(), deps);
  assert.equal(res.status, 502);
  // The agreement was claimed (it must exist before Stripe) but nothing
  // activated it, and no session was linked.
  assert.equal(deps.calls.filter(c => c.name === "claimAgreement").length, 1);
  assert.equal(deps.calls.filter(c => c.name === "linkSession").length, 0);
});

/* ══════════════════════════════════════════════════════════════
   5. WEBHOOK ROUTING: B2B FIRST, B2C UNTOUCHED
   ══════════════════════════════════════════════════════════════ */

test("19: the B2B branch is evaluated BEFORE every B2C branch, in all three session events", () => {
  // Positional proof against the real source. routeB2bSession must be
  // called before routeAnnualSession, before the mode test and before
  // the one-time fallback, in each of the three checkout.session.* arms.
  const arms = webhookSource.split(/} else if \(event\.type === /);
  const sessionArms = arms.filter(a => a.includes("routeB2bSession("));
  assert.equal(sessionArms.length, 3,
    "the B2B router is not present in all three checkout.session.* arms");
  for (const arm of sessionArms) {
    const iB2b = arm.indexOf("routeB2bSession(");
    const iAnnual = arm.indexOf("routeAnnualSession(");
    const iMode = arm.indexOf('session.mode === "subscription"');
    assert.ok(iB2b >= 0 && iAnnual >= 0 && iB2b < iAnnual,
      "routeB2bSession does not precede routeAnnualSession");
    if (iMode >= 0) assert.ok(iB2b < iMode, "routeB2bSession does not precede the mode test");
  }
  // And the settlement is only reached from the b2b branch.
  assert.ok(webhookSource.includes('if (b2b.kind === "b2b") {'));
  assert.ok(webhookSource.includes('if (b2b.kind === "malformed") {'));
});

test("20: malformed B2B metadata THROWS rather than falling through", () => {
  const good = {
    checkout_version: "1",
    request_id: UUID_A,
    checkout_attempt_id: UUID_ATTEMPT,
    gloa_b2b_agreement_id: UUID_AGREEMENT,
  };
  assert.equal(routeB2bSession(good).kind, "b2b");
  for (const bad of [
    { ...good, gloa_b2b_agreement_id: "nope" },
    { ...good, checkout_version: "2" },
    { ...good, request_id: undefined },
    { ...good, checkout_attempt_id: "x" },
    { ...good, gloa_annual_plan_id: UUID_A },
    { ...good, gloa_subscription_id: "sub_1" },
  ]) {
    assert.equal(routeB2bSession(bad).kind, "malformed", JSON.stringify(bad));
  }
  // The route turns every one of those into a throw.
  assert.equal((webhookSource.match(/has unusable metadata: \$\{b2b\.reason\}/g) ?? []).length, 3);
});

test("21: EVERY B2C session shape still answers not_b2b", () => {
  for (const meta of [
    null, undefined, {},
    { checkout_version: "1", request_id: UUID_A, checkout_attempt_id: UUID_ATTEMPT },
    { checkout_version: "1", request_id: UUID_A, checkout_attempt_id: UUID_ATTEMPT, discount_code: "X" },
    { gloa_annual_plan_id: UUID_AGREEMENT, checkout_version: "1", request_id: UUID_A, checkout_attempt_id: UUID_ATTEMPT },
    { gloa_subscription_id: "sub_1", checkout_version: "1", request_id: UUID_A, checkout_attempt_id: UUID_ATTEMPT },
  ]) {
    assert.equal(routeB2bSession(meta).kind, "not_b2b", JSON.stringify(meta));
  }
  // The two routing key constants agree across the two leaves.
  const rules = read("lib/b2bCheckoutRules.ts");
  assert.ok(rules.includes(`B2B_SESSION_AGREEMENT_METADATA_KEY = "${B2B_SESSION_AGREEMENT_METADATA_KEY}"`));
});

test("22: the three existing B2C branches are byte-identical to HEAD", () => {
  // THE STRONGEST AVAILABLE PROOF THAT 5C IS ADDITIVE. Each B2C call is
  // still present, unchanged, exactly once.
  for (const call of [
    "await settleAnnualCheckoutSession(session.id, annual.metadata, annualWebhookDeps(stripe));",
    "await handleSubscriptionSessionCompleted(stripe, session);",
    "await handleCheckoutSessionCompleted(stripe, session);",
    "await handleInvoicePaid(stripe, event);",
    "await handleInvoicePaymentFailed(stripe, event);",
    "await handleRefundEvent(stripe, event);",
    "await handleSubscriptionUpdated(stripe, event);",
    "await handleSubscriptionDeleted(event);",
  ]) {
    assert.ok(webhookSource.includes(call), `a B2C call disappeared: ${call}`);
  }
  // The annual malformed guard still throws, and the event dedup is still
  // recorded after processing rather than before.
  assert.ok(webhookSource.includes("annual checkout session ${session.id} has unusable metadata"));
  const iRecord = webhookSource.indexOf("const recorded = await recordStripeWebhookEvent");
  const iCatch = webhookSource.indexOf("Stripe webhook processing failed for event");
  assert.ok(iCatch >= 0 && iCatch < iRecord, "the event is recorded before processing succeeded");
});

/* ══════════════════════════════════════════════════════════════
   6. SETTLEMENT AND CONVERGENCE
   ══════════════════════════════════════════════════════════════ */

const META = {
  checkoutVersion: "1", requestId: UUID_A,
  checkoutAttemptId: UUID_ATTEMPT, agreementId: UUID_AGREEMENT,
};

function webhookStubs(overrides = {}) {
  const state = { activations: 0, settlements: [], markedPaid: 0, active: false };
  const deps = {
    state,
    retrieveSession: async () => ({
      id: "cs_1", mode: "payment", payment_status: "paid",
      currency: "eur", amount_total: 11235, payment_intent: "pi_1",
    }),
    retrieveInvoice: async id => ({ id, status: "paid", subscription: "sub_1" }),
    retrieveSubscription: async id => ({ id, metadata: { gloa_b2b_agreement_id: UUID_AGREEMENT } }),
    findAttemptById: async () => ({
      id: UUID_ATTEMPT, currency: "EUR", expected_total_gross_cents: 11235,
      status: "created", stripe_checkout_session_id: "cs_1",
    }),
    evaluatePayment: (s, a) =>
      s.payment_status === "paid" && s.amount_total === a.expected_total_gross_cents
        ? { shouldMarkPaid: true }
        : { shouldMarkPaid: false, reason: "mismatch" },
    linkSession: async () => true,
    markAttemptPaid: async () => { state.markedPaid += 1; return true; },
    activateAnnual: async () => {
      if (state.active) return { result: "already_active" };
      state.active = true; state.activations += 1;
      return { result: "activated" };
    },
    settleMonthlyInvoice: async input => {
      if (state.settlements.some(s => s.stripeInvoiceId === input.stripeInvoiceId)) {
        return { result: "already_settled" };
      }
      state.settlements.push(input);
      const first = state.settlements.length === 1;
      return {
        result: first ? "activated" : "settled",
        delivery_number: state.settlements.length,
        deliveryNumber: state.settlements.length,
      };
    },
    ...overrides,
  };
  return deps;
}

test("23: an annual session that is NOT paid activates nothing", async () => {
  const deps = webhookStubs({
    retrieveSession: async () => ({
      id: "cs_1", mode: "payment", payment_status: "unpaid", currency: "eur", amount_total: 11235,
    }),
  });
  const outcome = await settleB2bCheckoutSession("cs_1", META, deps);
  assert.equal(outcome.kind, "not_paid");
  assert.equal(deps.state.activations, 0, "an unpaid session activated a contract");
  assert.equal(deps.state.markedPaid, 0);
});

test("23b: an amount that does not match the frozen total activates nothing", async () => {
  const deps = webhookStubs({
    retrieveSession: async () => ({
      id: "cs_1", mode: "payment", payment_status: "paid", currency: "eur", amount_total: 999,
    }),
  });
  assert.equal((await settleB2bCheckoutSession("cs_1", META, deps)).kind, "not_paid");
  assert.equal(deps.state.activations, 0);
});

test("24: ANNUAL converges in all four delivery orders", async () => {
  for (const order of [
    ["completed", "completed"],
    ["async_payment_succeeded", "async_payment_succeeded"],
    ["completed", "async_payment_succeeded"],
    ["async_payment_succeeded", "completed"],
  ]) {
    const deps = webhookStubs();
    const first = await settleB2bCheckoutSession("cs_1", META, deps, order[0]);
    const second = await settleB2bCheckoutSession("cs_1", META, deps, order[1]);
    assert.equal(first.kind, "activated", order.join(" then "));
    assert.equal(second.kind, "already_active", order.join(" then "));
    assert.equal(deps.state.activations, 1,
      `${order.join(" then ")} activated ${deps.state.activations} times`);
  }
});

test("25: a MONTHLY session does not activate - it waits for invoice.paid", async () => {
  const deps = webhookStubs({
    retrieveSession: async () => ({ id: "cs_1", mode: "subscription", payment_status: "paid" }),
    findAttemptById: forbidden("findAttemptById"),
    activateAnnual: forbidden("activateAnnual"),
    markAttemptPaid: forbidden("markAttemptPaid"),
  });
  const outcome = await settleB2bCheckoutSession("cs_1", META, deps);
  assert.equal(outcome.kind, "awaiting_invoice");
  assert.equal(deps.state.activations, 0);
});

test("26: invoice.paid activates a monthly agreement once and rolls deliveries", async () => {
  const deps = webhookStubs();
  const route = (meta, id) => routeB2bSubscriptionInvoice(meta, id);

  const first = await settleB2bPaidInvoice("in_1", deps, route);
  assert.equal(first.kind, "activated");
  assert.equal(first.deliveryNumber, 1);

  // A REDELIVERY of the same invoice creates nothing.
  const replay = await settleB2bPaidInvoice("in_1", deps, route);
  assert.equal(replay.kind, "already_settled");

  // The NEXT invoice creates exactly one next delivery.
  const second = await settleB2bPaidInvoice("in_2", deps, route);
  assert.equal(second.kind, "settled");
  assert.equal(second.deliveryNumber, 2);

  const secondReplay = await settleB2bPaidInvoice("in_2", deps, route);
  assert.equal(secondReplay.kind, "already_settled");

  assert.equal(deps.state.settlements.length, 2, "a replay created a third settlement");
  // Never a payment schedule row: the settlement writer has no argument
  // for one and the RPC does not write the table.
  assert.ok(!flat.includes("insert into public.b2b_payment_schedule")
    || sql.slice(sql.indexOf(`create function public.${MONTHLY_WRITER}`))
         .indexOf("b2b_payment_schedule") === -1,
    "the monthly writer touches the payment schedule");
});

test("27: a consumer invoice is NOT B2B and reaches the existing handler", async () => {
  const deps = webhookStubs({
    retrieveSubscription: async id => ({ id, metadata: { gloa_subscription_id: "sub-local" } }),
    settleMonthlyInvoice: forbidden("settleMonthlyInvoice"),
  });
  const outcome = await settleB2bPaidInvoice("in_1", deps, routeB2bSubscriptionInvoice);
  assert.equal(outcome.kind, "not_b2b");
  // A one-off invoice with no subscription is also not B2B.
  const oneOff = webhookStubs({
    retrieveInvoice: async id => ({ id, status: "paid" }),
    retrieveSubscription: forbidden("retrieveSubscription"),
    settleMonthlyInvoice: forbidden("settleMonthlyInvoice"),
  });
  assert.equal((await settleB2bPaidInvoice("in_9", oneOff, routeB2bSubscriptionInvoice)).kind, "not_b2b");
});

test("28: an unpaid invoice settles nothing", async () => {
  const deps = webhookStubs({
    retrieveInvoice: async id => ({ id, status: "open", subscription: "sub_1" }),
    settleMonthlyInvoice: forbidden("settleMonthlyInvoice"),
  });
  assert.equal((await settleB2bPaidInvoice("in_1", deps, routeB2bSubscriptionInvoice)).kind, "refused");
});

test("29: a B2B payment FAILURE mutates nothing and never enters the B2C path", () => {
  const ack = acknowledgeB2bPaymentFailure(UUID_AGREEMENT, "in_1");
  assert.equal(ack.action, "none");
  assert.match(ack.message, /Package 5F/);
  // The rules leaf has no writer to call even by mistake.
  const rules = read("lib/b2bWebhookRules.ts");
  for (const forbiddenWord of [/supabase/i, /\.rpc\(/, /insert/i, /update /i, /sendPayment/i, /Email/]) {
    assert.ok(!forbiddenWord.test(rules), `the failure leaf can reach ${forbiddenWord}`);
  }
  // And the route's B2B failure path returns before the consumer handler.
  const failedArm = webhookSource.slice(webhookSource.indexOf('event.type === "invoice.payment_failed"'));
  const iB2b = failedArm.indexOf("handleB2bInvoiceFailed");
  const iB2c = failedArm.indexOf("await handleInvoicePaymentFailed(stripe, event);");
  assert.ok(iB2b >= 0 && iB2b < iB2c, "the B2B failure classification runs after the B2C handler");
  assert.ok(failedArm.includes("if (!b2bFailure.handled) {"),
    "a B2B failure does not prevent the consumer handler from being skipped");
});

/* ══════════════════════════════════════════════════════════════
   7. MIGRATION 062
   ══════════════════════════════════════════════════════════════ */

test("30: 062 is the highest migration and 063 does not exist", () => {
  const files = readdirSync(MIGRATIONS).filter(f => f.endsWith(".sql")).sort();
  assert.equal(files[files.length - 1], MIGRATION);
  assert.equal(files[files.length - 2], "061_b2b_pending_agreement_writer.sql");
  assert.equal(files.length, 62);
  assert.deepEqual(files.filter(f => Number(f.slice(0, 3)) > 62), []);
  const numbers = files.map(f => f.slice(0, 3));
  assert.equal(new Set(numbers).size, numbers.length);
});

test("31: migrations 001 through 061 are unmodified in the working tree", () => {
  const changed = execFileSync("git",
    ["diff", "--name-only", "--diff-filter=MD", "HEAD", "--", "supabase/migrations/"],
    { cwd: ROOT, encoding: "utf-8" }).trim();
  const touched = changed ? changed.split(NEWLINE) : [];
  assert.deepEqual(touched.filter(rel => !rel.endsWith(MIGRATION)), [],
    "a live, immutable migration was edited");
});

test("32: 062 is additive only - no table, policy, RLS, DROP or privilege change", () => {
  for (const forbiddenWord of [
    /create\s+table/i, /alter\s+table/i, /add\s+column/i, /add\s+constraint/i,
    /create\s+(unique\s+)?index/i, /create\s+(constraint\s+)?trigger/i,
    /create\s+policy/i, /alter\s+policy/i, /drop\s+policy/i,
    /row\s+level\s+security/i, /\bdrop\s+/i, /\btruncate\b/i,
    /alter default privileges/i, /create\s+role/i, /alter\s+role/i,
    /create\s+or\s+replace\s+function/i, /alter\s+function/i,
  ]) {
    assert.ok(!forbiddenWord.test(sql), `062 contains ${forbiddenWord}`);
  }
  // NO table privilege, in either direction.
  assert.ok(!/\bon\s+table\b/i.test(sql), "062 names a table in a privilege statement");
  for (const verb of ["insert", "update", "delete", "truncate", "references", "trigger"]) {
    assert.ok(!new RegExp(`grant[^;]*\\b${verb}\\b[^;]*\\bto\\b`, "i").test(sql),
      `062 grants ${verb.toUpperCase()}`);
  }
  assert.match(sql, /^\s*begin;/m);
  assert.match(sql, /^\s*commit;\s*$/m);
});

test("33: exactly two writers, both definer, both with a pinned empty search_path", () => {
  const defined = [...sql.matchAll(/create\s+function\s+public\.([a-z0-9_]+)/gi)].map(m => m[1]);
  assert.deepEqual(defined.sort(), [ANNUAL_WRITER, MONTHLY_WRITER].sort());
  assert.equal((sql.match(/security\s+definer/gi) ?? []).length, 2);
  assert.equal((sql.match(/set search_path = ''/g) ?? []).length, 2);
  // Fully schema-qualified: with an empty search_path nothing else resolves.
  for (const table of ["b2b_supply_agreements", "b2b_payment_schedule", "b2b_deliveries", "checkout_attempts"]) {
    assert.ok(!new RegExp(`(from|into|join|update)\\s+${table}\\b`, "i").test(sql),
      `${table} is referenced without its schema`);
  }
});

test("34: service_role is the only grantee, and only EXECUTE", () => {
  const grants = [...flat.matchAll(/grant\s+([a-z ,]+?)\s+on\s+(function|table)\s+([a-z0-9_.]+)[^;]*?\s+to\s+([a-z0-9_]+);/gi)]
    .map(m => ({ privilege: m[1].trim(), kind: m[2], object: m[3], grantee: m[4] }));
  assert.equal(grants.length, 2, `062 issues ${grants.length} grants, expected 2`);
  for (const g of grants) {
    assert.equal(g.privilege, "execute");
    assert.equal(g.kind, "function");
    assert.equal(g.grantee, "service_role");
  }
  for (const role of ["public", "anon", "authenticated"]) {
    assert.equal((flat.match(new RegExp(`from ${role};`, "gi")) ?? []).length, 2,
      `EXECUTE is not revoked from ${role} on both writers`);
  }
  const iPublic = flat.search(/revoke all on function[^;]*from public;/i);
  const iGrant = flat.search(/grant execute on function/i);
  assert.ok(iPublic >= 0 && iPublic < iGrant, "the PUBLIC revoke does not precede the grant");
});

test("35: the annual writer derives every amount and never takes one", () => {
  const header = sql.slice(sql.indexOf(`create function public.${ANNUAL_WRITER}`),
                           sql.indexOf("returns jsonb"));
  for (const word of ["cents", "amount", "total", "price", "net", "gross", "tax"]) {
    assert.ok(!header.toLowerCase().includes(word), `the annual writer takes a money parameter: ${word}`);
  }
  const body = sql.slice(sql.indexOf(`create function public.${ANNUAL_WRITER}`),
                         sql.indexOf(`create function public.${MONTHLY_WRITER}`));
  // The canonical allocation, and the canonical net-origin tax.
  assert.ok(body.includes("v_base    := v_total::bigint / v_n::bigint")
    || body.includes("v_base := v_total::bigint / v_n::bigint"));
  assert.ok(body.includes("v_total::bigint - v_base * (v_n::bigint - 1)"),
    "the remainder does not land on the last instalment");
  assert.ok(body.includes("(2 * (v_net * 107) + 100) / 200"),
    "the tax is not the canonical half-up net-origin gross");
  assert.ok(body.includes("v_tax   := v_gross - v_net") || body.includes("v_tax := v_gross - v_net"),
    "the tax is not the remainder of one rounding");
  // Instalment 1 carries the complete tax facts; 2..n carry none.
  assert.ok(body.includes("'de-net-2026.1', 'net'"));
  assert.ok(body.includes("'scheduled', v_net::integer"));
  // Twelve deliveries, unresolved.
  assert.ok(body.includes("for v_i in 1 .. 12 loop"));
  for (const frozenColumn of ["resolved_at", "shipping_class", "shipping_snapshot",
                              "berlin_eligibility_snapshot", "delivery_address_snapshot",
                              "customer_shipping_net_cents", "order_id", "tracking_number"]) {
    assert.ok(!body.includes(frozenColumn), `the annual writer resolves ${frozenColumn} in 5C`);
  }
  // No subscription id on an annual agreement, ever.
  assert.ok(!body.includes("stripe_subscription_id"), "an annual agreement was given a subscription id");
});

test("36: the annual writer proves payment from the attempt, not from its arguments", () => {
  const body = sql.slice(sql.indexOf(`create function public.${ANNUAL_WRITER}`),
                         sql.indexOf(`create function public.${MONTHLY_WRITER}`));
  assert.ok(body.includes("v_attempt.status <> 'paid'"), "payment proof is not the attempt's status");
  assert.ok(body.includes("for update"), "the agreement is not locked");
  assert.ok(body.includes("'already_active'"), "there is no idempotent answer");
  assert.ok(body.includes("attempt_mismatch"), "the attempt correlation is not proved");
  assert.ok(body.includes("agreement_not_pending"));
});

test("37: the monthly writer is idempotent on the invoice and writes no payment row", () => {
  const body = sql.slice(sql.indexOf(`create function public.${MONTHLY_WRITER}`));
  assert.ok(body.includes("where stripe_invoice_id = v_invoice"),
    "the monthly writer is not keyed on the Stripe invoice");
  assert.ok(body.includes("'already_settled'"));
  assert.ok(body.includes("subscription_mismatch"), "a foreign subscription is not refused");
  assert.ok(!body.includes("b2b_payment_schedule"),
    "the monthly writer touches the payment schedule");
  assert.ok(body.includes("max(delivery_number), 0) + 1"), "deliveries are not contiguous");
  // It never ends a contract.
  for (const word of ["'cancelled'", "'completed'", "ended_at", "termination_reason"]) {
    assert.ok(!body.includes(`set ${word}`), `the monthly writer writes ${word}`);
  }
  // And it takes no money parameter either.
  const header = sql.slice(sql.indexOf(`create function public.${MONTHLY_WRITER}`),
                           sql.indexOf("returns jsonb", sql.indexOf(`create function public.${MONTHLY_WRITER}`)));
  for (const word of ["cents", "amount", "quantity"]) {
    assert.ok(!header.toLowerCase().includes(word), `the monthly writer takes ${word}`);
  }
});

test("38: no identifier in 062 exceeds 63 UTF-8 bytes, and none collides", () => {
  const names = [
    ...[...migration.matchAll(/create\s+function\s+public\.([a-z0-9_]+)/gi)].map(m => m[1]),
    ...[...migration.matchAll(/\b(v_[a-z0-9_]+|p_[a-z0-9_]+)\b/gi)].map(m => m[1]),
  ];
  assert.ok(names.length > 10);
  const truncated = new Map();
  for (const name of names) {
    const bytes = Buffer.byteLength(name, "utf8");
    assert.ok(bytes <= 63, `"${name}" is ${bytes} bytes - PostgreSQL would truncate it`);
    const key = Buffer.from(name, "utf8").subarray(0, 63).toString("utf8");
    const prior = truncated.get(key);
    assert.ok(prior === undefined || prior === name, `"${name}" and "${prior}" collide at 63 bytes`);
    truncated.set(key, name);
  }
});

test("39: 062 contains no Stripe logic, no hold state and no 5D/5E surface", () => {
  for (const forbiddenWord of [/stripe\.[a-z]/i, /checkout\.session/i, /'held'/, /hold_reason/,
                               /'payment_failed'/, /'action_required'/, /resolved_at/,
                               /shipping_snapshot/, /dispatch/i, /tracking/i, /\border_id\b/]) {
    assert.ok(!forbiddenWord.test(sql), `062 contains ${forbiddenWord}`);
  }
  // The later-package writers are deliberately absent.
  for (const later of ["resolve_b2b_delivery", "claim_due_b2b_deliveries",
                       "hold_b2b_deliveries", "apply_b2b_quantity_change",
                       "record_b2b_instalment"]) {
    assert.ok(!sql.includes(later), `062 defines ${later}, which belongs to a later package`);
  }
});

test("40: the settlement surface writes only through RPCs", () => {
  const deps = read("lib/b2bWebhookDeps.ts");
  assert.ok(deps.includes('admin.rpc("activate_b2b_annual_from_payment"'));
  assert.ok(deps.includes('admin.rpc("settle_b2b_monthly_paid_invoice"'));
  // No direct table write anywhere in the B2B surface.
  for (const f of ["lib/b2bWebhookDeps.ts", "lib/b2bCheckoutDeps.ts", "lib/b2bWebhook.ts"]) {
    const src = read(f);
    for (const table of ["b2b_supply_agreements", "b2b_supply_items",
                         "b2b_payment_schedule", "b2b_deliveries"]) {
      assert.ok(!new RegExp(`from\\("${table}"\\)`).test(src),
        `${f} reaches ${table} directly instead of through an RPC`);
    }
  }
  assert.ok(read("lib/b2bCheckoutDeps.ts").includes('admin.rpc("create_pending_b2b_agreement_for_attempt"'));
});

/* ══════════════════════════════════════════════════════════════
   8. CALENDAR-MONTH DATE SEMANTICS
   ══════════════════════════════════════════════════════════════

   The approved contract is TWELVE CALENDAR MONTHS with a calendar
   -monthly delivery rhythm and instalments every 12/n months. Day-count
   approximations are forbidden: 365 days is not twelve months, 30 days
   is not a month, and 365/n is not the instalment cadence. 059 already
   says so in billing_interval_unit = 'month' with interval_count 12, 6
   or 3; these assertions hold the runtime to it.

   The month-end behaviour PostgreSQL actually produces - and the
   timezone pinning that makes it deterministic - are proved against a
   real cluster, because no text assertion can evaluate an interval. What
   is asserted here is that the file still contains the expressions that
   were proved there, and no day-count anywhere near them. */

const annualWriterBody = sql.slice(sql.indexOf(`create function public.${ANNUAL_WRITER}`),
                                   sql.indexOf(`create function public.${MONTHLY_WRITER}`));

test("42: no executable 062 code approximates a month with days", () => {
  // Scanned on the CODE, because the comments deliberately name the
  // forbidden quantities in order to explain why they are absent.
  for (const forbidden of [
    /\b365\b/, /\b364\b/, /\b30 days\b/i, /\b31 days\b/i, /\b91\b/, /\b182\b/, /\b273\b/,
    /interval\s*'\s*\d+\s*days?\s*'/i,
    /make_interval\s*\(\s*days\s*=>/i,
    /make_interval\s*\(\s*hours\s*=>/i,
    /make_interval\s*\(\s*weeks\s*=>/i,
    /\b86400\b/, /\b2592000\b/, /\b31536000\b/,
  ]) {
    assert.ok(!forbidden.test(sql), `062 approximates a month with days: ${forbidden}`);
  }
  // And the only interval unit it ever names is the month.
  const units = [...sql.matchAll(/make_interval\s*\(\s*(\w+)\s*=>/g)].map(m => m[1]);
  assert.ok(units.length >= 3, `expected the month intervals to be found, got ${units.length}`);
  assert.deepEqual([...new Set(units)], ["months"],
    "062 builds an interval out of something other than months");
});

test("43: the annual commitment end is start + 12 CALENDAR months", () => {
  assert.ok(annualWriterBody.includes(
    "commitment_end_at = (v_start + make_interval(months => 12)) at time zone v_zone"),
    "the contract horizon is not twelve calendar months from the pinned start");
  assert.ok(!/interval\s*'1 year'/i.test(sql), "062 uses a year interval");
});

test("44: instalment due dates are (j - 1) x (12 / n) calendar months", () => {
  assert.ok(annualWriterBody.includes(
    "(v_start + make_interval(months => (v_i - 1) * v_spacing)) at time zone v_zone"),
    "the instalment cadence is not derived in calendar months from the start");
  assert.ok(annualWriterBody.includes("v_spacing := 12 / v_n;"),
    "the spacing is not 12 / instalment_count");
  // The three approved schedules, as month offsets. Derived here rather
  // than copied, so a change to the admitted counts fails this too.
  const offsets = n => Array.from({ length: n }, (_, j) => j * (12 / n));
  assert.deepEqual(offsets(1), [0]);
  assert.deepEqual(offsets(2), [0, 6]);
  assert.deepEqual(offsets(4), [0, 3, 6, 9]);
  for (const n of B2B_INSTALMENT_COUNTS) {
    assert.equal(12 % n, 0, `12 / ${n} is not exact`);
    assert.ok(offsets(n).every(Number.isInteger), `${n} instalments give a fractional month`);
    // The last instalment always falls INSIDE the twelve-month term.
    assert.ok(offsets(n)[n - 1] < 12, `${n} instalments run past the contract end`);
  }
});

test("45: all twelve delivery slots are one calendar month apart", () => {
  assert.ok(annualWriterBody.includes(
    "(v_start + make_interval(months => v_i - 1)) at time zone v_zone"),
    "the delivery cadence is not one calendar month from the pinned start");
  assert.ok(annualWriterBody.includes("for v_i in 1 .. 12 loop"),
    "there are not exactly twelve delivery slots");
  // EVERY date is computed from the ORIGINAL start, never from its
  // predecessor - which is what stops a month-end clamp accumulating.
  assert.ok(!/v_prev|previous_|last_scheduled/.test(annualWriterBody),
    "a delivery date is derived from its predecessor, so a clamp would drift");
});

test("46: the calendar is PINNED, so the dates do not depend on the session", () => {
  // THE SUBTLE HALF, and the one a text assertion can still reach.
  //
  // timestamptz + interval 'N months' is calendar arithmetic performed
  // in the SESSION's TimeZone. Proved against a real PostgreSQL 17
  // cluster: the same expression on the same input produced
  //   UTC        2026-04-28 23:30:00Z
  //   Berlin     2026-04-28 22:30:00Z
  //   Kiritimati 2026-04-28 23:30:00Z
  // - three sessions, two different instants. The pinned form produced
  // 22:30:00Z in all three.
  assert.ok(annualWriterBody.includes("v_zone      constant text := 'Europe/Berlin';"),
    "the calendar timezone is not pinned to a named constant");
  assert.ok(annualWriterBody.includes("v_start   := v_now at time zone v_zone;"),
    "the month arithmetic does not start from a pinned wall-clock value");
  // Line-wise rather than by one regex: the instalment expression nests
  // parentheses - make_interval(months => (v_i - 1) * v_spacing) - which
  // no [^)]* pattern can span.
  const monthLines = annualWriterBody.split(/\r?\n/)
    .filter(line => line.includes("make_interval(months =>"));
  assert.equal(monthLines.length, 3,
    `expected three month expressions, got ${monthLines.length}:\n${monthLines.join("\n")}`);
  for (const line of monthLines) {
    assert.match(line, /at time zone v_zone/,
      `a month expression is not converted back through the pinned zone: ${line.trim()}`);
  }
  assert.ok(!/at time zone '(?!Europe\/Berlin)/.test(annualWriterBody),
    "a second, unnamed timezone appears in the annual writer");
  assert.ok(!/v_now \+ (make_interval\(months|interval '\d+ month)/.test(annualWriterBody),
    "an unpinned timestamptz + month interval is still present");
});

test("47: the four schedule columns are all timestamptz, as 006 and 060 declared", () => {
  // The pinning is only correct if these are instants. If one were a
  // plain date or a timestamp, `at time zone` would mean the opposite
  // thing and the round trip would be wrong.
  const m006 = read("supabase/migrations/006_b2b_supply.sql");
  const m060 = read("supabase/migrations/060_b2b_payment_delivery_foundation.sql");
  assert.match(m006, /started_at\s+timestamptz/, "started_at is not timestamptz");
  assert.match(m006, /commitment_end_at\s+timestamptz/, "commitment_end_at is not timestamptz");
  assert.match(m060, /due_at\s+timestamptz not null/, "due_at is not timestamptz");
  assert.match(m060, /scheduled_for\s+timestamptz not null/, "scheduled_for is not timestamptz");
});

test("48: the month-end behaviour this migration relies on is written down", () => {
  // PostgreSQL CLAMPS: 31 Jan + 1 month is 28 Feb. Because every date is
  // computed from the original start, the clamp never accumulates - 31
  // Jan + 12 months is 31 Jan again. Measured on PostgreSQL 17.10:
  //
  //   start       +1m     +3m     +6m     +9m     +12m
  //   2026-01-31  02-28   04-30   07-31   10-31   2027-01-31
  //   2026-02-28  03-28   05-28   08-28   11-28   2027-02-28
  //   2026-03-31  04-30   06-30   09-30   12-31   2027-03-31
  //   2026-08-31  09-30   11-30   02-28   05-31   2027-08-31
  //
  // The migration must SAY this, because the behaviour is PostgreSQL's
  // rather than ours and the next reader needs to know it was chosen.
  assert.match(migration, /CLAMPS?\b/i, "the month-end clamp is not documented");
  assert.match(migration, /never accumulates/i,
    "the non-accumulating property is not documented");
  assert.match(migration, /Europe\/Berlin/, "the pinned calendar is not documented");
});

test("49: 059, 060 and 061 are byte-identical, and no 063 was created", () => {
  const changed = execFileSync("git",
    ["diff", "--name-only", "--diff-filter=MD", "HEAD", "--", "supabase/migrations/"],
    { cwd: ROOT, encoding: "utf-8" }).trim();
  const touched = changed ? changed.split(NEWLINE) : [];
  for (const live of ["059_b2b_supply_commerce_foundation.sql",
                      "060_b2b_payment_delivery_foundation.sql",
                      "061_b2b_pending_agreement_writer.sql"]) {
    assert.ok(!touched.some(rel => rel.endsWith(live)),
      `${live} was edited - it is applied in production and may not move`);
  }
  // 062 is the ONLY migration this correction may touch, and there is no
  // 063: the fix belongs in 062 because it has not been applied anywhere.
  assert.deepEqual(touched.filter(rel => !rel.endsWith(MIGRATION)), []);
  const files = readdirSync(MIGRATIONS).filter(f => f.endsWith(".sql"));
  assert.deepEqual(files.filter(f => Number(f.slice(0, 3)) > 62), [],
    "a migration 063 was created for a correction that belongs in 062");
});

test("41: every new suite is registered in the npm test script", () => {
  const pkg = JSON.parse(read("package.json"));
  for (const suite of [
    "tests/b2b-checkout-settlement.test.mjs",
    "tests/b2b-pending-agreement-writer.test.mjs",
    "tests/b2b-supply-commerce-foundation.test.mjs",
    "tests/b2b-payment-delivery-foundation.test.mjs",
  ]) {
    assert.ok(pkg.scripts.test.includes(suite), `${suite} does not run in the gate`);
  }
});
