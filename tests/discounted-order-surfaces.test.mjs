import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { buildOrderConfirmationEmail } from "../lib/email/orderConfirmation.ts";
import { buildInternalOrderNotificationEmail } from "../lib/email/internalOrderNotification.ts";
import { buildLaunchWelcomeEmail } from "../lib/email/launchWelcome.ts";
import { LAUNCH_DISCOUNT_LABEL, LAUNCH_DISCOUNT_CODE, LAUNCH_DISCOUNT_PERCENT } from "../lib/launchDiscount.ts";
import { priceLaunchDiscountForCart } from "../lib/launchDiscountCart.ts";
import { computeShippingGrossCents, SHIPPING_PRICING } from "../lib/shipping.ts";

/*
  ══════════════════════════════════════════════════════════════
  EVERY PLACE A DISCOUNTED ORDER'S MONEY IS STATED.

  The launch-gate audit found GLOALAUNCH10 correct everywhere it was
  COMPUTED and absent from three places where it was DISPLAYED: the
  order success page, the customer's confirmation email and the internal
  fulfillment notice. All three printed

      Zwischensumme  22,99
      Versand         5,90
      Gesamt         26,59

  which is not arithmetic. The AGB call that email "zugleich die
  Bestaetigung des Vertrags auf einem dauerhaften Datentraeger", so
  those are the figures a customer keeps.

  It survived 3,795 green tests because not one of them mentioned a
  discount. That is what this file is for: these assertions check CENT
  VALUES and check that they RECONCILE, rather than checking that some
  string containing the word Rabatt appears somewhere.

  No database, no network, no clock. The email templates are pure
  functions and are called directly; the two client components are
  read as source, which is how this repository has always pinned
  browser-side wiring it cannot execute here.
  ══════════════════════════════════════════════════════════════
*/

const read = p => readFileSync(new URL(`../${p}`, import.meta.url), "utf-8");

/* ── A real discounted order, in real GLOA money ───────────────
   One 50 g tin at 22,99 EUR, GLOALAUNCH10, shipped to Germany.
     merchandise  2299
     discount      230   (10 % of 2299, half up: 229,9 -> 230)
     shipping      590   (2299 is under the 4900 free-shipping line)
     total        2659   = 2299 - 230 + 590
   Every number below is asserted against that identity rather than
   hardcoded twice, so a fixture that stops adding up fails here. */
const MERCH = 2299;
const DISCOUNT = 230;
const SHIPPING = 590;
const TOTAL = MERCH - DISCOUNT + SHIPPING;

test("fixture: the discounted order used below genuinely reconciles", () => {
  assert.equal(TOTAL, 2659);
  // And the discount is the one the engine actually produces for it.
  const priced = priceLaunchDiscountForCart({
    code: LAUNCH_DISCOUNT_CODE,
    nowMs: Date.parse("2026-10-15T12:00:00+02:00"),
    lines: [{ variantId: "v1", sku: "GLOA-MATCHA-50G", quantity: 1, unitGrossCents: MERCH, lineGrossCents: MERCH }],
  });
  assert.equal(priced.applies, true);
  assert.equal(priced.discountGrossCents, DISCOUNT);
});

/* ══════════════════════════════════════════════════════════════
   1. THE CUSTOMER'S CONFIRMATION EMAIL
   ══════════════════════════════════════════════════════════════ */

const ADDRESS = {
  name: "Max Mustermann", company: null, line1: "Musterstraße 1", line2: null,
  city: "Berlin", postalCode: "10115", state: null, countryLabel: "Deutschland",
};

const CONFIRMATION_ITEMS = [
  { productName: "GLOA Matcha", variantLabel: "50 g", quantity: 1, unitGrossCents: MERCH, lineGrossCents: MERCH },
];

const discountedConfirmation = (discount = DISCOUNT) => buildOrderConfirmationEmail({
  order: {
    order_number: "GLOA-2026-000777",
    subtotal_gross_cents: MERCH,
    discount_total_cents: discount,
    shipping_gross_cents: SHIPPING,
    total_gross_cents: MERCH - discount + SHIPPING,
    shippingAddress: ADDRESS,
    accountOrderUrl: null,
  },
  items: CONFIRMATION_ITEMS,
  customerEmail: "max@example.com",
});

test("confirmation email: a discounted order shows the Rabatt row in HTML", () => {
  const { html } = discountedConfirmation();
  assert.match(html, /Rabatt/);
  // The actual cent value, negative, not merely the word.
  assert.match(html, /-2,30\s*€/);
});

test("confirmation email: a discounted order shows the Rabatt line in plain text", () => {
  const { text } = discountedConfirmation();
  assert.match(text, /^Rabatt: -2,30 €$/m);
});

test("confirmation email: the four totals reconcile to the cent, in both renderings", () => {
  const { html, text } = discountedConfirmation();

  // Plain text is exact enough to parse, so the arithmetic is read back
  // out of the message the customer receives rather than assumed.
  const cents = label => {
    const m = new RegExp(`^${label}: (-?)(\\d+),(\\d{2}) €$`, "m").exec(text);
    assert.ok(m, `no ${label} line in the plain-text mail`);
    return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 100 + Number(m[3]));
  };

  const zwischensumme = cents("Zwischensumme");
  const rabatt = cents("Rabatt");
  const versand = cents("Versand");
  const gesamt = cents("Gesamt");

  assert.equal(zwischensumme, MERCH);
  assert.equal(rabatt, -DISCOUNT);
  assert.equal(versand, SHIPPING);
  assert.equal(gesamt, TOTAL);
  // THE POINT OF THE WHOLE PACKAGE:
  assert.equal(zwischensumme + rabatt + versand, gesamt);

  // And the HTML carries the same four figures.
  for (const value of ["22,99", "2,30", "5,90", "26,59"]) {
    assert.ok(html.includes(value), `HTML is missing ${value}`);
  }
});

test("confirmation email: an UNDISCOUNTED order gains no empty Rabatt row", () => {
  const { html, text } = discountedConfirmation(0);
  assert.equal(/Rabatt/.test(html), false, "a 0-cent discount rendered a row in the HTML");
  assert.equal(/Rabatt/.test(text), false, "a 0-cent discount rendered a line in the text");
  // Still the ordinary, unchanged mail.
  assert.match(text, /^Zwischensumme: 22,99 €$/m);
  assert.match(text, /^Versand: 5,90 €$/m);
  assert.match(text, /^Gesamt: 28,89 €$/m);
});

test("confirmation email: free shipping and a discount together still reconcile", () => {
  // 2 x 100 g = 7998, over the 4900 line, so shipping is a real zero.
  const merch = 7998;
  const discount = 800;
  const { text } = buildOrderConfirmationEmail({
    order: {
      order_number: "GLOA-2026-000778",
      subtotal_gross_cents: merch,
      discount_total_cents: discount,
      shipping_gross_cents: 0,
      total_gross_cents: merch - discount,
      shippingAddress: ADDRESS,
      accountOrderUrl: null,
    },
    items: [{ productName: "GLOA Matcha", variantLabel: "100 g", quantity: 2, unitGrossCents: 3999, lineGrossCents: merch }],
    customerEmail: "max@example.com",
  });
  assert.match(text, /^Zwischensumme: 79,98 €$/m);
  assert.match(text, /^Rabatt: -8,00 €$/m);
  assert.match(text, /^Versand: Kostenlos$/m);
  assert.match(text, /^Gesamt: 71,98 €$/m);
  assert.equal(7998 - 800 + 0, 7198);
});

/* ══════════════════════════════════════════════════════════════
   2. THE INTERNAL FULFILLMENT NOTICE
   ══════════════════════════════════════════════════════════════ */

const internalNotice = (discount = DISCOUNT) => buildInternalOrderNotificationEmail({
  order: {
    order_number: "GLOA-2026-000777",
    currency: "EUR",
    subtotal_gross_cents: MERCH,
    discount_total_cents: discount,
    shipping_gross_cents: SHIPPING,
    total_gross_cents: MERCH - discount + SHIPPING,
    shippingAddress: ADDRESS,
    customerEmail: "max@example.com",
    customerName: "Max Mustermann",
    source: "one_time",
    stripeInvoiceId: null,
  },
  items: [{ productName: "GLOA Matcha", variantLabel: "50 g", sku: "GLOA-MATCHA-50G", quantity: 1, unitGrossCents: MERCH, lineGrossCents: MERCH }],
});

test("internal notification: a discounted order shows Rabatt in HTML and text", () => {
  const { html, text } = internalNotice();
  assert.match(html, /Rabatt/);
  assert.match(html, /-2,30\s*€/);
  assert.match(text, /^Rabatt: -2,30 €$/m);
});

test("internal notification: Zwischensumme - Rabatt + Versand = Bezahlt", () => {
  const { text } = internalNotice();
  const cents = (label, suffix = "€") => {
    const m = new RegExp(`^${label}: (-?)(\\d+),(\\d{2}) ${suffix}$`, "m").exec(text);
    assert.ok(m, `no ${label} line`);
    return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 100 + Number(m[3]));
  };
  const zwischensumme = cents("Zwischensumme");
  const rabatt = cents("Rabatt");
  const versand = cents("Versand");
  const bezahlt = cents("Bezahlt", "EUR");

  assert.equal(zwischensumme, MERCH);
  assert.equal(rabatt, -DISCOUNT);
  assert.equal(versand, SHIPPING);
  assert.equal(bezahlt, TOTAL);
  assert.equal(zwischensumme + rabatt + versand, bezahlt);
});

test("internal notification: an undiscounted order is unchanged", () => {
  const { html, text } = internalNotice(0);
  assert.equal(/Rabatt/.test(html), false);
  assert.equal(/Rabatt/.test(text), false);
  assert.match(text, /^Bezahlt: 28,89 EUR$/m);
});

/* ══════════════════════════════════════════════════════════════
   3. THE ORDER SUCCESS PAGE

   Client-rendered from a JSON response, so the two halves are pinned
   where they live: the route must SELECT and RETURN the stored cents,
   and the component must render them between the merchandise and the
   shipping.
   ══════════════════════════════════════════════════════════════ */

test("order success API: the stored discount is selected and returned, never recomputed", () => {
  const route = read("app/api/orders/success/route.ts");

  // Selected from the orders row...
  const select = /\.select\("([^"]*order_number[^"]*)"\)/.exec(route);
  assert.ok(select, "no orders select found");
  assert.ok(select[1].includes("discount_total_cents"), "discount_total_cents is not selected");

  // ...and handed to the browser.
  assert.match(route, /discountGrossCents: order\.discount_total_cents \?\? 0/);
  assert.match(route, /discountGrossCents: number/);

  // NOT recomputed. This route must never import the discount engine:
  // the code, the window and the basket are gone by now, and a second
  // opinion about money already charged is exactly the wrong thing.
  for (const forbidden of ["launchDiscount", "launchDiscountCart", "priceLaunchDiscountForCart", "LAUNCH_DISCOUNT_PERCENT"]) {
    assert.equal(route.includes(forbidden), false, `${forbidden} must not reach the order success route`);
  }
});

test("order success page: the Rabatt row sits between Zwischensumme and Versand", () => {
  const page = read("app/OrderSuccess.tsx");

  assert.match(page, /discountGrossCents: number;/);
  assert.match(page, /order\.discountGrossCents > 0 && \(/);
  assert.match(page, /<span>Rabatt<\/span><strong>&minus;\{fmtCents\(order\.discountGrossCents\)\}/);

  // ORDER MATTERS: the four rows have to read as the arithmetic.
  const at = needle => {
    const i = page.indexOf(needle);
    assert.notEqual(i, -1, `missing: ${needle}`);
    return i;
  };
  const zwischensumme = at("<span>Zwischensumme</span>");
  const rabatt = at("<span>Rabatt</span>");
  const versand = at("<span>Versand</span>");
  const gesamt = at("<span>Gesamt</span>");
  assert.ok(zwischensumme < rabatt, "Rabatt is rendered above Zwischensumme");
  assert.ok(rabatt < versand, "Rabatt is rendered below Versand");
  assert.ok(versand < gesamt, "Versand is rendered below Gesamt");
});

test("order success page: a zero discount renders no row", () => {
  // The guard is `> 0`, not a truthiness check and not unconditional -
  // an "Rabatt 0,00 €" line on every ordinary order reads like a code
  // that failed.
  const page = read("app/OrderSuccess.tsx");
  assert.match(page, /\{order\.discountGrossCents > 0 && \(/);
  assert.equal(/\{fmtCents\(order\.discountGrossCents\)\} €<\/strong><\/div>\s*<div className="portal-profile-row"><span>Zwischensumme/.test(page), false);
});

/* ══════════════════════════════════════════════════════════════
   4. THE DISCOUNT IS CARRIED, NOT RE-DERIVED

   Every mail is built from the durable order record. If the column
   stopped travelling from the RPC to the template, the templates above
   would silently go back to printing figures that do not add up.
   ══════════════════════════════════════════════════════════════ */

test("the frozen discount travels from the order row to every message", () => {
  // The RPC returns the whole orders row; the type has to admit it.
  assert.match(read("lib/orderFulfillment.ts"), /discount_total_cents: number;/);

  // Customer confirmation: type + pass-through.
  const confirm = read("lib/orderConfirmationEmail.ts");
  assert.match(confirm, /discount_total_cents: number;/);
  assert.match(confirm, /discount_total_cents: order\.discount_total_cents,/);

  // Internal notice: type + pass-through.
  const internal = read("lib/internalOrderNotificationEmail.ts");
  assert.match(internal, /discount_total_cents: number;/);
  assert.match(internal, /discount_total_cents: order\.discount_total_cents,/);

  // The REBUILD path, which redelivers a failed notification days later
  // and must describe the same order the first attempt described.
  const retry = read("lib/internalOrderNotificationRetry.ts");
  const columns = /export const ORDER_COLUMNS =\s*"([^"]+)"/.exec(retry);
  assert.ok(columns, "ORDER_COLUMNS not found");
  assert.ok(columns[1].includes("discount_total_cents"), "the rebuild does not read the discount");
  assert.match(read("lib/internalOrderNotificationRetryRules.ts"), /discount_total_cents: row\.discount_total_cents,/);
});

/* ══════════════════════════════════════════════════════════════
   5. NO SURFACE PROMISES A FIRST-ORDER RESTRICTION

   Migration 057 removed the claim ledger, the first-order query and the
   per-email lock, and decideLaunchDiscount takes no identity at all.
   The copy was the last place still promising a rule nothing enforces.
   ══════════════════════════════════════════════════════════════ */

/** Source with comments removed, so a note ABOUT the old rule is not mistaken for the old rule. */
function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter(line => !/^\s*(\/\/|\*)/.test(line))
    .join("\n");
}

test("public copy: no runtime surface claims the code is for a first order", () => {
  const FORBIDDEN = [/erste\s+Bestellung/i, /ersten\s+Bestellung/i, /first\s+order/i];
  const SURFACES = [
    "app/LaunchPage.tsx",
    "app/GloaSite.tsx",
    "lib/launchDiscount.ts",
    "lib/launchDiscountCart.ts",
    "lib/email/launchWelcome.ts",
    "lib/email/launchConfirmation.ts",
    "lib/email/launchDay.ts",
    "lib/launchWaitlist.ts",
    "lib/launchWelcomeDeps.ts",
  ];
  for (const file of SURFACES) {
    const body = withoutComments(read(file));
    for (const pattern of FORBIDDEN) {
      assert.equal(pattern.test(body), false, `${file} still promises a first-order-only discount (${pattern})`);
    }
  }
});

test("public copy: nor does any one-use claim survive", () => {
  const FORBIDDEN = [/einmalig einl/i, /nur einmal einl/i, /einmal pro/i, /one use/i];
  for (const file of ["app/LaunchPage.tsx", "lib/launchDiscount.ts", "lib/email/launchWelcome.ts"]) {
    const body = withoutComments(read(file));
    for (const pattern of FORBIDDEN) {
      assert.equal(pattern.test(body), false, `${file} claims a one-use restriction (${pattern})`);
    }
  }
});

test("public copy: the label is built from the engine, so it cannot drift", () => {
  assert.equal(LAUNCH_DISCOUNT_LABEL, `${LAUNCH_DISCOUNT_PERCENT} % Rabatt mit ${LAUNCH_DISCOUNT_CODE}`);
  assert.equal(LAUNCH_DISCOUNT_LABEL, "10 % Rabatt mit GLOALAUNCH10");
  assert.equal(/erste/i.test(LAUNCH_DISCOUNT_LABEL), false);
});

test("welcome mail: the message actually sent carries no first-order promise", () => {
  // The strongest form of the assertion above: build the mail and read
  // it, rather than trusting a grep of the file that builds it.
  const { html, text, subject } = buildLaunchWelcomeEmail({
    firstName: "Max",
    origin: "https://gloamatcha.com",
    code: LAUNCH_DISCOUNT_CODE,
    percentLabel: `${LAUNCH_DISCOUNT_PERCENT} %`,
    validFromLabel: "01.10.2026, 12:00 Uhr",
    validUntilLabel: "31.10.2026, 23:59 Uhr",
  });
  for (const body of [html, text, subject]) {
    assert.equal(/erste[n]?\s+Bestellung/i.test(body), false, "the welcome mail still says 'erste Bestellung'");
  }
  // It still carries the things it is for.
  assert.match(text, /GLOALAUNCH10/);
  assert.match(text, /10 %/);
  assert.match(text, /31\.10\.2026/);
});

/* ══════════════════════════════════════════════════════════════
   6. THE CART'S FINAL TOTAL

   SUMME was the merchandise minus the discount and EXCLUDED shipping,
   so a 22,99 EUR German basket showed SUMME 22,99 EUR directly above a
   button leading to a 28,89 EUR payment.

   The arithmetic is checked against the same shared modules the cart
   calls; the wiring is checked in the source, because the drawer is a
   client component this harness cannot mount.
   ══════════════════════════════════════════════════════════════ */

/** Exactly the expression app/GloaSite.tsx now computes. */
const cartSumme = (subtotal, discount, shipping) => Math.max(0, subtotal - discount) + (shipping ?? 0);

test("cart total: Germany, paid shipping - subtotal - discount + 590 = SUMME", () => {
  const shipping = computeShippingGrossCents("germany", MERCH);
  assert.equal(shipping, 590);
  assert.equal(cartSumme(MERCH, DISCOUNT, shipping), 2659);
});

test("cart total: Germany, free shipping - the threshold is judged BEFORE the discount", () => {
  // 1 x 50 g + 2 x 30 g = 5297: over the 4900 line before the code, and
  // 4767 after it. Free shipping is measured on the first figure, so it
  // survives - a discount must never be able to make a total go UP.
  const merch = 2299 + 2 * 1499;
  assert.equal(merch, 5297);
  assert.ok(merch >= SHIPPING_PRICING.germany.freeShippingThresholdGrossCents);

  const priced = priceLaunchDiscountForCart({
    code: LAUNCH_DISCOUNT_CODE,
    nowMs: Date.parse("2026-10-15T12:00:00+02:00"),
    lines: [
      { variantId: "a", sku: "GLOA-MATCHA-50G", quantity: 1, unitGrossCents: 2299, lineGrossCents: 2299 },
      { variantId: "b", sku: "GLOA-MATCHA-30G", quantity: 2, unitGrossCents: 1499, lineGrossCents: 2998 },
    ],
  });
  assert.equal(priced.applies, true);
  assert.equal(priced.discountGrossCents, 530);
  assert.ok(merch - priced.discountGrossCents < 4900, "the fixture no longer crosses back under the line");

  // Shipping is computed from the PRE-discount merchandise, as the cart does.
  const shipping = computeShippingGrossCents("germany", merch);
  assert.equal(shipping, 0, "the discount took away free shipping");
  assert.equal(cartSumme(merch, priced.discountGrossCents, shipping), 4767);
});

test("cart total: no discount - subtotal + shipping = SUMME", () => {
  assert.equal(cartSumme(MERCH, 0, computeShippingGrossCents("germany", MERCH)), 2889);
  assert.equal(cartSumme(7998, 0, computeShippingGrossCents("germany", 7998)), 7998);
});

test("cart total: every zone's shipping lands in the sum", () => {
  for (const [zone, expected] of [["germany", 590], ["eu", 1290], ["nonEuCore", 1790], ["restOfEurope", 1990]]) {
    const shipping = computeShippingGrossCents(zone, MERCH);
    assert.equal(shipping, expected, `${zone} shipping changed`);
    assert.equal(cartSumme(MERCH, DISCOUNT, shipping), MERCH - DISCOUNT + expected);
  }
});

test("cart: SUMME is computed from the merchandise, the discount AND the shipping", () => {
  const site = read("app/GloaSite.tsx");

  // The expression itself, verbatim.
  assert.match(
    site,
    /const payableCents=Math\.max\(0,cart\.totalCents-discountCents\)\+\(shippingCents\?\?0\);/,
    "the cart's payable total no longer adds the shipping"
  );

  // The shipping it adds is still priced on the PRE-discount subtotal.
  assert.match(site, /const shippingCents=zone\?computeShippingGrossCents\(zone,cart\.totalCents\):null;/);
  assert.match(site, /const remainingForFreeShipping=threshold!==null\?Math\.max\(0,threshold-cart\.totalCents\):null;/);

  // And the breakdown that explains it.
  assert.match(site, /<span>ZWISCHENSUMME<\/span>/);
  assert.match(site, /<span>RABATT<\/span>/);
  assert.match(site, /<span>VERSAND<\/span>/);
  assert.match(site, /<span>SUMME<\/span>/);

  const at = needle => {
    const i = site.indexOf(needle);
    assert.notEqual(i, -1, `missing: ${needle}`);
    return i;
  };
  assert.ok(at("<span>ZWISCHENSUMME</span>") < at("<span>RABATT</span>"));
  assert.ok(at("<span>RABATT</span>") < at("<span>VERSAND</span>"));
  assert.ok(at("<span>VERSAND</span>") < at("<span>SUMME</span>"));
});

test("cart: the breakdown appears for an undiscounted basket too", () => {
  // Otherwise a customer with no code sees a SUMME larger than their
  // basket with nothing on screen accounting for the difference.
  const site = read("app/GloaSite.tsx");
  assert.match(site, /\{\(discount\|\|shippingCents!==null\)&&<>/);
  // ...and the Rabatt row inside it is still conditional on a discount.
  assert.match(site, /\{discount&&<div className="cart-total cart-total-line cart-total-discount">/);
});
