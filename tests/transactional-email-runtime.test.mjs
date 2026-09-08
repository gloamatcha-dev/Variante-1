import assert from "node:assert/strict";
import test from "node:test";

import { buildOrderConfirmationEmail } from "../lib/email/orderConfirmation.ts";
import { buildShipmentConfirmationEmail } from "../lib/email/shipmentConfirmation.ts";
import { buildWithdrawalConfirmationEmail } from "../lib/email/withdrawalConfirmation.ts";
import { buildRefundConfirmationEmail } from "../lib/email/refundConfirmation.ts";
import { buildCancellationConfirmationEmail } from "../lib/email/cancellationConfirmation.ts";
import { buildCancellationOutcomeEmail } from "../lib/email/cancellationOutcome.ts";
import { buildPaymentProblemEmail } from "../lib/email/paymentProblem.ts";
import { buildSubscriptionStartedEmail } from "../lib/email/subscriptionStarted.ts";
import { buildSubscriptionEndedEmail } from "../lib/email/subscriptionEnded.ts";
import { buildAnnualPurchaseConfirmationEmail } from "../lib/email/annualPurchaseConfirmation.ts";

/**
 * THESE TESTS ACTUALLY RUN THE TEMPLATES.
 *
 * The branding suite next door reads source and asks how the mails are
 * composed. It cannot see what happens when one is built, and that
 * matters here for a specific reason: the migration referenced `origin`
 * without declaring it, and TypeScript bound the name to the DOM's
 * window.origin. tsc was green. Every one of these mails would have
 * thrown ReferenceError the first time Node executed it.
 *
 * A source-level check would not have caught that. Calling the function
 * does, which is the whole point of this file.
 *
 * SYNTHETIC DATA ONLY. Reserved domains, obviously-fake identifiers, no
 * database, no provider, nothing sent. The amounts are arithmetic
 * fixtures and are NOT approved GLOA prices.
 */

const ORIGIN = "https://gloamatcha.com";
const NR = "GLOA-DEMO-000000";
const ACCOUNT = `${ORIGIN}/account/orders/demo`;
const SUBS = `${ORIGIN}/account/subscriptions`;

/** Every template, with inputs matching its declared type exactly. */
const build = (origin) => ({
  orderConfirmation: () => buildOrderConfirmationEmail({
    origin,
    customerEmail: "demo@example.invalid",
    items: [
      { productName: "GLOA Matcha", variantLabel: "30 g", quantity: 1, unitGrossCents: 2900, lineGrossCents: 2900 },
      { productName: "GLOA Matcha", variantLabel: "50 g", quantity: 2, unitGrossCents: 2900, lineGrossCents: 5800 },
    ],
    order: {
      order_number: NR,
      subtotal_gross_cents: 8700,
      shipping_gross_cents: 590,
      total_gross_cents: 9290,
      shippingAddress: { name: "Beispiel Musterperson", company: null, line1: "Musterstraße 1", line2: null, postalCode: "10115", city: "Berlin", state: null, countryLabel: "Deutschland" },
      accountOrderUrl: ACCOUNT,
    },
  }),
  shipmentConfirmation: () => buildShipmentConfirmationEmail({
    origin,
    customerEmail: "demo@example.invalid",
    order: {
      order_number: NR,
      shippingAddress: { name: "Beispiel Musterperson", company: null, city: "Berlin", postalCode: "10115", state: null, countryLabel: "Deutschland" },
      tracking: { carrier: "Demo-Versand", trackingNumber: "DEMO000000", trackingUrl: "https://example.invalid/track/DEMO000000" },
      accountOrderUrl: ACCOUNT,
    },
  }),
  withdrawalConfirmation: () => buildWithdrawalConfirmationEmail({
    origin,
    customerName: "Beispiel Musterperson",
    orderReference: NR,
    scope: "whole_order",
    scopeNote: null,
    customerNote: null,
    submittedAt: "2026-09-08T10:00:00.000Z",
  }),
  refundConfirmation: () => buildRefundConfirmationEmail({
    origin,
    order: { order_number: NR, kind: "partial", refundedTotalCents: 2900, originalTotalGrossCents: 9290, currency: "EUR", accountOrderUrl: ACCOUNT },
  }),
  cancellationConfirmation: () => buildCancellationConfirmationEmail({
    origin,
    cancellation: { requestedAtIso: "2026-09-08T10:00:00.000Z", effectiveAtIso: "2026-10-06T10:00:00.000Z", accountSubscriptionsUrl: SUBS },
  }),
  cancellationOutcome: () => buildCancellationOutcomeEmail({
    origin,
    order: { order_number: NR, outcome: "approved", accountOrderUrl: ACCOUNT },
  }),
  paymentProblem: () => buildPaymentProblemEmail({ origin, payment: { accountSubscriptionsUrl: SUBS } }),
  subscriptionStarted: () => buildSubscriptionStartedEmail({
    origin,
    subscription: { packageName: "GLOA Matcha 50 g", quantity: 1, cadenceWeeks: 4, accountSubscriptionsUrl: SUBS },
  }),
  subscriptionEnded: () => buildSubscriptionEndedEmail({
    origin,
    subscription: { endedAtIso: "2026-10-06T10:00:00.000Z", accountUrl: SUBS },
  }),
  annualPurchaseConfirmation: () => buildAnnualPurchaseConfirmationEmail({
    origin,
    plan: {
      productName: "GLOA Matcha", variantLabel: "50 g",
      deliveryCount: 13, cadenceWeeks: 4, currency: "EUR",
      annualUnitGrossCents: 2610, shippingPerDeliveryGrossCents: 590,
      merchandiseTotalGrossCents: 33930, shippingTotalGrossCents: 7670,
      totalGrossCents: 41600, discountPercentApplied: 10,
      planEndAt: "2027-09-07T10:00:00.000Z",
      nextScheduledFor: "2026-10-06T10:00:00.000Z",
      firstDeliveryStarted: true,
      accountOrdersUrl: ACCOUNT,
    },
  }),
});

const NAMES = Object.keys(build(ORIGIN));

test("all ten templates build without throwing, with an origin", () => {
  const fns = build(ORIGIN);
  assert.equal(NAMES.length, 10, "the fixture set is not ten templates");
  for (const name of NAMES) {
    const mail = fns[name]();
    assert.ok(mail && typeof mail === "object", `${name} returned nothing`);
    for (const part of ["subject", "html", "text"]) {
      assert.equal(typeof mail[part], "string", `${name}.${part} is not a string`);
      assert.ok(mail[part].length > 0, `${name}.${part} is empty`);
    }
  }
});

test("all ten build without throwing when no origin is available", () => {
  // The ReferenceError this file exists for would fire here first: with
  // origin undefined, an undeclared name is read rather than a property.
  const fns = build(undefined);
  for (const name of NAMES) {
    const mail = fns[name]();
    assert.ok(mail.html.length > 0, `${name} produced no html without an origin`);
    assert.ok(!mail.html.includes("<img"), `${name} rendered an image without an origin to make it absolute`);
  }
});

test("nothing renders the string 'undefined', 'null' or 'NaN' to a reader", () => {
  const fns = build(ORIGIN);
  for (const name of NAMES) {
    const mail = fns[name]();
    for (const part of ["subject", "html", "text"]) {
      for (const leak of ["undefined", "NaN", "[object Object]"]) {
        assert.ok(!mail[part].includes(leak), `${name}.${part} leaks ${leak}`);
      }
    }
    // "null" would also be a leak, but only as a word on its own - the
    // markup legitimately contains "nullable"-ish substrings in URLs.
    assert.ok(!/>\s*null\s*</.test(mail.html), `${name}.html leaks a null`);
  }
});

test("the logo is an absolute https URL on the real domain, or absent", () => {
  const withOrigin = build(ORIGIN);
  for (const name of NAMES) {
    const { html } = withOrigin[name]();
    assert.ok(html.includes(`src="${ORIGIN}/gloa-logo-blue-600.png"`), `${name} does not carry the approved mark absolutely`);
    assert.ok(html.includes('alt="GLOA"'), `${name} has no alt text on the mark`);
    // No relative, protocol-relative or plaintext image source anywhere.
    assert.ok(!/src="\//.test(html), `${name} has a root-relative image src`);
    assert.ok(!/src="http:\/\//.test(html), `${name} has a plaintext http image src`);
    assert.ok(!/src="\/\//.test(html), `${name} has a protocol-relative image src`);
  }
});

test("a malformed origin cannot produce a localhost or preview link in the mark", () => {
  // getSiteOrigin() reads SITE_URL and returns null when unset, so the
  // guarded branch is what production hits without it. What must never
  // happen is a template inventing a fallback.
  for (const bad of ["", "   "]) {
    const fns = build(bad);
    for (const name of NAMES) {
      const { html } = fns[name]();
      assert.ok(!html.includes("localhost"), `${name} emitted a localhost link for origin ${JSON.stringify(bad)}`);
      assert.ok(!html.includes("vercel.app"), `${name} emitted a preview domain for origin ${JSON.stringify(bad)}`);
    }
  }
});

test("the plain-text part is real prose, not a stripped copy of the markup", () => {
  const fns = build(ORIGIN);
  for (const name of NAMES) {
    const { text } = fns[name]();
    assert.ok(!text.includes("<"), `${name}.text carries markup`);
    assert.ok(!text.includes("style="), `${name}.text carries styles`);
    assert.ok(text.split("\n").length >= 3, `${name}.text is a single line`);
    assert.ok(/GLOA/.test(text), `${name}.text does not identify the sender`);
  }
});

/* ── The facts each mail must still carry ────────────────────── */

test("order confirmation: every line, both totals and the address survive", () => {
  const { html, text } = build(ORIGIN).orderConfirmation();
  for (const surface of [html, text]) {
    assert.ok(surface.includes(NR), "the order number is missing");
    assert.ok(surface.includes("87,00"), "the subtotal is missing");
    assert.ok(surface.includes("5,90"), "the shipping is missing");
    assert.ok(surface.includes("92,90"), "the total is missing");
    assert.ok(surface.includes("Musterstraße 1"), "the delivery address is missing");
    assert.ok(surface.includes("29,00"), "a line price is missing");
    assert.ok(surface.includes("58,00"), "the second line's price is missing");
  }
});

test("shipment confirmation: the tracking reaches the reader", () => {
  const { html, text } = build(ORIGIN).shipmentConfirmation();
  for (const surface of [html, text]) {
    assert.ok(surface.includes("DEMO000000"), "the tracking number is missing");
    assert.ok(surface.includes("https://example.invalid/track/DEMO000000"), "the tracking link is missing");
  }
});

test("withdrawal receipt: content, date and time, and no claim of a refund", () => {
  const { html, text } = build(ORIGIN).withdrawalConfirmation();
  for (const surface of [html, text]) {
    assert.ok(surface.includes("Beispiel Musterperson"), "the declaring party is missing");
    assert.ok(surface.includes(NR), "the contract reference is missing");
    assert.ok(/8\.9\.2026|08\.09\.2026/.test(surface), "the date of receipt is missing");
    assert.ok(/\d{1,2}:\d{2}/.test(surface), "the time of receipt is missing");
    for (const claim of ["erstattet", "zurückgezahlt", "Erstattung erfolgt"]) {
      assert.ok(!surface.includes(claim), `the receipt claims a refund: ${claim}`);
    }
  }
});

test("refund confirmation: the kind and the settled amount, not the order total", () => {
  const { html, text } = build(ORIGIN).refundConfirmation();
  for (const surface of [html, text]) {
    assert.ok(surface.includes("29,00"), "the refunded amount is missing");
  }
  // A partial refund must not be described as a full one.
  const full = buildRefundConfirmationEmail({
    origin: ORIGIN,
    order: { order_number: NR, kind: "full", refundedTotalCents: 9290, originalTotalGrossCents: 9290, currency: "EUR", accountOrderUrl: null },
  });
  assert.notEqual(full.subject, build(ORIGIN).refundConfirmation().subject,
    "a full and a partial refund produce the same subject");
});

test("subscription mails: four weeks, and never the word monatlich", () => {
  const started = build(ORIGIN).subscriptionStarted();
  const ended = build(ORIGIN).subscriptionEnded();
  for (const surface of [started.html, started.text, ended.html, ended.text]) {
    assert.ok(!/monatlich/i.test(surface), "a 28-day cycle was called monthly");
  }
  for (const surface of [started.html, started.text]) {
    assert.ok(/4 Wochen|vier Wochen/.test(surface), "the cadence is missing");
  }
});

test("annual plan: one payment, thirteen deliveries, no renewal", () => {
  const { html, text } = build(ORIGIN).annualPurchaseConfirmation();
  for (const surface of [html, text]) {
    assert.ok(surface.includes("13"), "the delivery count is missing");
    assert.ok(surface.includes("416,00"), "the prepaid total is missing");
    assert.ok(!/monatlich/i.test(surface), "the plan was described as monthly");
    assert.ok(!/verlängert sich|automatisch verlängert/i.test(surface), "the plan was described as renewing");
  }
});

test("cancellation confirmation: the effective date, distinct from the request date", () => {
  const { html, text } = build(ORIGIN).cancellationConfirmation();
  for (const surface of [html, text]) {
    assert.ok(/6\.10\.2026|06\.10\.2026/.test(surface), "the effective date is missing");
  }
});
