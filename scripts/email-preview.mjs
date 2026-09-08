/**
 * Renders every customer transactional template to a file for review.
 *
 * SYNTHETIC DATA ONLY. Every name, address, order number and amount
 * below is invented for this harness; nothing is read from the database,
 * nothing is sent, and no provider is contacted. The identifiers are
 * deliberately obvious - GLOA-DEMO-000000, example.invalid - so a
 * preview can never be mistaken for a real order in a screenshot.
 *
 * The fixtures match each template's declared input type exactly. An
 * earlier version guessed at the shapes; four templates threw and three
 * more rendered with undefined values, which looked like passing.
 *
 *   node scripts/email-preview.mjs [outDir]
 */

import fs from "node:fs";
import path from "node:path";

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

const ORIGIN = "https://gloamatcha.com";
const NR = "GLOA-DEMO-000000";
const ACCOUNT = `${ORIGIN}/account/orders/demo`;
const SUBS = `${ORIGIN}/account/subscriptions`;

const CASES = [];
const add = (name, fn) => {
  try { CASES.push([name, fn(), null]); }
  catch (err) { CASES.push([name, null, err]); }
};

add("01-bestellbestaetigung", () =>
  buildOrderConfirmationEmail({
    origin: ORIGIN,
    customerEmail: "demo@example.invalid",
    items: [
      { productName: "GLOA Matcha", variantLabel: "30 g", quantity: 1, unitGrossCents: 2900, lineGrossCents: 2900 },
      { productName: "GLOA Matcha", variantLabel: "50 g", quantity: 1, unitGrossCents: 2900, lineGrossCents: 2900 },
    ],
    order: {
      order_number: NR,
      subtotal_gross_cents: 5800,
      shipping_gross_cents: 590,
      total_gross_cents: 6390,
      shippingAddress: { name: "Beispiel Musterperson", company: null, line1: "Musterstraße 1", line2: null, postalCode: "10115", city: "Berlin", state: null, countryLabel: "Deutschland" },
      accountOrderUrl: ACCOUNT,
    },
  }));

add("02-versandbestaetigung", () =>
  buildShipmentConfirmationEmail({
    origin: ORIGIN,
    customerEmail: "demo@example.invalid",
    order: {
      order_number: NR,
      shippingAddress: { name: "Beispiel Musterperson", company: null, city: "Berlin", postalCode: "10115", state: null, countryLabel: "Deutschland" },
      tracking: { carrier: "Demo-Versand", trackingNumber: "DEMO000000", trackingUrl: "https://example.invalid/track/DEMO000000" },
      accountOrderUrl: ACCOUNT,
    },
  }));

add("03-widerrufseingang", () =>
  buildWithdrawalConfirmationEmail({
    origin: ORIGIN,
    customerName: "Beispiel Musterperson",
    orderReference: NR,
    scope: "whole_order",
    scopeNote: null,
    customerNote: null,
    submittedAt: "2026-09-08T10:00:00.000Z",
  }));

add("04-erstattung", () =>
  buildRefundConfirmationEmail({
    origin: ORIGIN,
    order: { order_number: NR, kind: "full", refundedTotalCents: 6390, originalTotalGrossCents: 6390, currency: "EUR", accountOrderUrl: ACCOUNT },
  }));

add("05-stornobestaetigung", () =>
  buildCancellationConfirmationEmail({
    origin: ORIGIN,
    cancellation: { requestedAtIso: "2026-09-08T10:00:00.000Z", effectiveAtIso: "2026-10-06T10:00:00.000Z", accountSubscriptionsUrl: SUBS },
  }));

add("06-storno-ergebnis", () =>
  buildCancellationOutcomeEmail({
    origin: ORIGIN,
    order: { order_number: NR, outcome: "approved", accountOrderUrl: ACCOUNT },
  }));

add("07-zahlungsproblem", () =>
  buildPaymentProblemEmail({ origin: ORIGIN, payment: { accountSubscriptionsUrl: SUBS } }));

add("08-abo-gestartet", () =>
  buildSubscriptionStartedEmail({
    origin: ORIGIN,
    subscription: { packageName: "GLOA Matcha 50 g", quantity: 1, cadenceWeeks: 4, accountSubscriptionsUrl: SUBS },
  }));

add("09-abo-beendet", () =>
  buildSubscriptionEndedEmail({
    origin: ORIGIN,
    subscription: { endedAtIso: "2026-10-06T10:00:00.000Z", accountUrl: SUBS },
  }));

add("10-jahresplan", () =>
  buildAnnualPurchaseConfirmationEmail({
    origin: ORIGIN,
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
  }));

const outDir = process.argv[2] || "email-preview";
fs.mkdirSync(outDir, { recursive: true });

const index = [];
let failed = 0;
for (const [name, mail, err] of CASES) {
  if (err) {
    failed++;
    console.log(name.padEnd(28), "FEHLER:", String(err.message).slice(0, 70));
    continue;
  }
  fs.writeFileSync(path.join(outDir, `${name}.html`), mail.html);
  fs.writeFileSync(path.join(outDir, `${name}.txt`), mail.text);
  index.push(`<li><a href="${name}.html">${name}</a> &mdash; <code>${mail.subject}</code></li>`);
  console.log(name.padEnd(28), mail.subject.slice(0, 62));
}

fs.writeFileSync(
  path.join(outDir, "index.html"),
  `<!doctype html><meta charset="utf-8"><title>GLOA Mail-Vorschau</title>
<body style="font-family:Inter,Arial,sans-serif;max-width:760px;margin:40px auto;line-height:1.6;">
<h1>GLOA Mail-Vorschau</h1>
<p>Synthetische Testdaten. Nichts hiervon stammt aus der Datenbank, nichts wurde versendet.</p>
<ul>${index.join("")}</ul>`
);

console.log(`\n${CASES.length - failed}/${CASES.length} gerendert -> ${outDir}/index.html`);
if (failed) process.exitCode = 1;
