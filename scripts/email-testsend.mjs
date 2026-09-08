/**
 * Sends the ten transactional templates to ONE explicitly named address.
 *
 * ── WHY THIS DOES NOT USE THE PRODUCTION SENDERS ──────────────
 *
 * lib/orderConfirmationEmail.ts and its siblings do more than send: they
 * claim a row in public.orders, write delivery state and hold an
 * idempotency key. Calling them to look at a layout would leave real
 * marks in a real database and could suppress a genuine later send that
 * shares the key.
 *
 * So this composes the mail the same way they do - the same pure
 * build*Email() function, the same From, the same Reply-To - and hands
 * it to Resend itself. Nothing here reads or writes a table, and no
 * order, refund, cancellation, withdrawal or subscription change is
 * created anywhere.
 *
 * ── SAFETY RAILS ─────────────────────────────────────────────
 *
 *   * The recipient must be given on the command line. There is no
 *     default, no fallback, and no address is ever read from the
 *     database - so this cannot reach a customer by accident.
 *   * Without --confirm-send it prints the plan and sends nothing.
 *   * One address, one mail per template, ten at most. No loop, no list.
 *
 *   node --env-file=.env.local scripts/email-testsend.mjs --to=you@example.com
 *   node --env-file=.env.local scripts/email-testsend.mjs --to=you@example.com --confirm-send
 *
 * ON THE ORIGIN, WHICH IS WHAT WENT WRONG THE FIRST TIME.
 *
 * A bare `node` does not read .env.local - that is the bundler's job -
 * and .env.local's SITE_URL is http://localhost:3000 anyway. Either way
 * the mails point at something no inbox can fetch. The first real test
 * send did exactly that and Gmail on iOS drew a broken image.
 *
 * A send now refuses unless the origin is one an inbox can load, and
 * --origin= supplies the production one without editing any env file:
 *
 *   node scripts/email-testsend.mjs --to=you@example.com --origin=https://gloamatcha.com
 *   node --env-file=.env.local scripts/email-testsend.mjs --to=you@example.com \
 *     --origin=https://gloamatcha.com --confirm-send
 *
 * (--env-file is still needed for RESEND_API_KEY.)
 *
 * The data is the synthetic set from scripts/email-preview.mjs. The
 * amounts are arithmetic fixtures and are NOT approved GLOA prices.
 */

import { getResendClient } from "../lib/resend.ts";
import { GLOA_FROM_HELLO, GLOA_REPLY_TO_SUPPORT } from "../lib/emailSenders.ts";
import { isMailableOrigin, logoUrl } from "../lib/email/brand.ts";
import { getSiteOrigin } from "../lib/siteUrl.ts";

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

const args = process.argv.slice(2);
const arg = (name) => {
  const hit = args.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const has = (name) => args.includes(`--${name}`);

const to = arg("to");
const confirmed = has("confirm-send");

if (!to) {
  console.error("Kein Empfaenger. Aufruf:\n  node --env-file=.env.local scripts/email-testsend.mjs --to=deine@adresse.de [--confirm-send]");
  process.exit(2);
}
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
  console.error(`Ungueltige Adresse: ${to}`);
  process.exit(2);
}

/**
 * The origin the mails will point at, and why it is checked here.
 *
 * The first real test send went out with SITE_URL from .env.local, which
 * is http://localhost:3000, so every mail carried
 * <img src="http://localhost:3000/gloa-logo-blue-600.png"> and Gmail on
 * iOS drew a broken image. The banner said "SITE_URL: gesetzt", which
 * was true and useless - it was set to something no inbox can reach.
 *
 * So this refuses rather than warns, and --origin= exists so a send can
 * use the production origin without anybody editing .env.local.
 */
const ORIGIN = arg("origin") ?? getSiteOrigin();
const NR = "GLOA-DEMO-000000";
const ACCOUNT = ORIGIN ? `${ORIGIN}/account/orders/demo` : null;
const SUBS = ORIGIN ? `${ORIGIN}/account/subscriptions` : null;

/**
 * Reply-To per mail, matching production exactly.
 *
 * The order family answers to support@; the statutory withdrawal
 * receipt answers to hello@, the published contact address. Getting
 * this wrong in a test would review the wrong thing.
 */
const CASES = [
  ["01 Bestellbestaetigung", GLOA_REPLY_TO_SUPPORT, () => buildOrderConfirmationEmail({
    origin: ORIGIN ?? undefined, customerEmail: to,
    items: [
      { productName: "GLOA Matcha", variantLabel: "30 g", quantity: 1, unitGrossCents: 2900, lineGrossCents: 2900 },
      { productName: "GLOA Matcha", variantLabel: "50 g", quantity: 2, unitGrossCents: 2900, lineGrossCents: 5800 },
    ],
    order: {
      order_number: NR, subtotal_gross_cents: 8700, shipping_gross_cents: 590, total_gross_cents: 9290,
      shippingAddress: { name: "Beispiel Musterperson", company: null, line1: "Musterstraße 1", line2: null, postalCode: "10115", city: "Berlin", state: null, countryLabel: "Deutschland" },
      accountOrderUrl: ACCOUNT,
    },
  })],
  ["02 Versandbestaetigung", GLOA_REPLY_TO_SUPPORT, () => buildShipmentConfirmationEmail({
    origin: ORIGIN ?? undefined, customerEmail: to,
    order: {
      order_number: NR,
      shippingAddress: { name: "Beispiel Musterperson", company: null, city: "Berlin", postalCode: "10115", state: null, countryLabel: "Deutschland" },
      tracking: { carrier: "Demo-Versand", trackingNumber: "DEMO000000", trackingUrl: "https://example.invalid/track/DEMO000000" },
      accountOrderUrl: ACCOUNT,
    },
  })],
  ["03 Widerrufseingang", "hello@gloamatcha.com", () => buildWithdrawalConfirmationEmail({
    origin: ORIGIN ?? undefined, customerName: "Beispiel Musterperson", orderReference: NR,
    scope: "whole_order", scopeNote: null, customerNote: null,
    submittedAt: "2026-09-08T10:00:00.000Z",
  })],
  ["04 Erstattung", GLOA_REPLY_TO_SUPPORT, () => buildRefundConfirmationEmail({
    origin: ORIGIN ?? undefined,
    order: { order_number: NR, kind: "partial", refundedTotalCents: 2900, originalTotalGrossCents: 9290, currency: "EUR", accountOrderUrl: ACCOUNT },
  })],
  ["05 Stornobestaetigung", GLOA_REPLY_TO_SUPPORT, () => buildCancellationConfirmationEmail({
    origin: ORIGIN ?? undefined,
    cancellation: { requestedAtIso: "2026-09-08T10:00:00.000Z", effectiveAtIso: "2026-10-06T10:00:00.000Z", accountSubscriptionsUrl: SUBS },
  })],
  ["06 Storno-Ergebnis", GLOA_REPLY_TO_SUPPORT, () => buildCancellationOutcomeEmail({
    origin: ORIGIN ?? undefined,
    order: { order_number: NR, outcome: "approved", accountOrderUrl: ACCOUNT },
  })],
  ["07 Zahlungsproblem", GLOA_REPLY_TO_SUPPORT, () => buildPaymentProblemEmail({
    origin: ORIGIN ?? undefined, payment: { accountSubscriptionsUrl: SUBS },
  })],
  ["08 Abo gestartet", GLOA_REPLY_TO_SUPPORT, () => buildSubscriptionStartedEmail({
    origin: ORIGIN ?? undefined,
    subscription: { packageName: "GLOA Matcha 50 g", quantity: 1, cadenceWeeks: 4, accountSubscriptionsUrl: SUBS },
  })],
  ["09 Abo beendet", GLOA_REPLY_TO_SUPPORT, () => buildSubscriptionEndedEmail({
    origin: ORIGIN ?? undefined,
    subscription: { endedAtIso: "2026-10-06T10:00:00.000Z", accountUrl: SUBS },
  })],
  ["10 Jahresplan", GLOA_REPLY_TO_SUPPORT, () => buildAnnualPurchaseConfirmationEmail({
    origin: ORIGIN ?? undefined,
    plan: {
      productName: "GLOA Matcha", variantLabel: "50 g", deliveryCount: 13, cadenceWeeks: 4, currency: "EUR",
      annualUnitGrossCents: 2610, shippingPerDeliveryGrossCents: 590,
      merchandiseTotalGrossCents: 33930, shippingTotalGrossCents: 7670,
      totalGrossCents: 41600, discountPercentApplied: 10,
      planEndAt: "2027-09-07T10:00:00.000Z", nextScheduledFor: "2026-10-06T10:00:00.000Z",
      firstDeliveryStarted: true, accountOrdersUrl: ACCOUNT,
    },
  })],
];

console.log(`Empfaenger : ${to}`);
console.log(`Absender   : ${GLOA_FROM_HELLO}`);
console.log(`Origin     : ${ORIGIN ?? "(keiner)"}`);
console.log(`Logo       : ${isMailableOrigin(ORIGIN) ? `${logoUrl(ORIGIN)} - laedt im Postfach` : "WIRD NICHT MITGESENDET"}`);
console.log(`Mails      : ${CASES.length}`);
console.log("");

let built;
try {
  built = CASES.map(([name, replyTo, fn]) => [name, replyTo, fn()]);
} catch (err) {
  console.error("Abbruch: eine Vorlage liess sich nicht bauen -", err && err.message);
  process.exit(1);
}

for (const [name, replyTo, mail] of built) {
  console.log(`${name.padEnd(26)} reply-to ${replyTo.padEnd(24)} ${mail.subject}`);
}

if (!confirmed) {
  console.log("\nTROCKENLAUF. Es wurde nichts gesendet.");
  console.log("Zum tatsaechlichen Versand dieselbe Zeile mit --confirm-send wiederholen.");
  process.exit(0);
}

// A send that carries no logo, or the wrong one, reviews nothing. This
// is the one thing the harness refuses outright rather than warning
// about, because the warning is exactly what got ignored last time.
if (!isMailableOrigin(ORIGIN)) {
  console.error(`\nAbbruch: ${ORIGIN ? `"${ORIGIN}" ist keine Adresse, die ein Postfach laden kann.` : "Es gibt keinen Origin."}`);
  console.error("Die Mails gingen ohne Logo und ohne funktionierende Kontolinks raus.");
  console.error("\nMit der Produktionsadresse senden:");
  console.error(`  node --env-file=.env.local scripts/email-testsend.mjs --to=${to} --origin=https://gloamatcha.com --confirm-send`);
  process.exit(1);
}

const resend = getResendClient();
if (!resend) {
  console.error("\nRESEND_API_KEY ist nicht gesetzt - kein Versand moeglich.");
  process.exit(1);
}

console.log("\nVersand laeuft ...\n");
let failed = 0;
for (const [name, replyTo, mail] of built) {
  try {
    const { data, error } = await resend.emails.send({
      from: GLOA_FROM_HELLO,
      to,
      replyTo,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
    });
    if (error) { failed++; console.log(`${name.padEnd(26)} FEHLER ${error.message || JSON.stringify(error)}`); }
    else console.log(`${name.padEnd(26)} gesendet  id=${data?.id ?? "?"}`);
  } catch (err) {
    failed++;
    console.log(`${name.padEnd(26)} FEHLER ${err && err.message}`);
  }
}

console.log(`\n${built.length - failed}/${built.length} angenommen.`);
if (failed) process.exitCode = 1;
