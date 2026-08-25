import assert from "node:assert/strict";
import test from "node:test";
import { buildOrderConfirmationEmail } from "../lib/email/orderConfirmation.ts";

// Pure template tests - no DB, no network, no import.meta.env dependency
// anywhere in this module's chain (lib/shipping.ts and lib/siteUrl.ts are
// both plain process.env/no-env). Mirrors how tests/shipping.test.mjs
// tests lib/shipping.ts directly.

const BASE_ORDER = {
  order_number: "GLOA-2026-000123",
  subtotal_gross_cents: 1999,
  shipping_gross_cents: 590,
  total_gross_cents: 2589,
  shippingAddress: {
    name: "Max Mustermann",
    company: null,
    line1: "Musterstraße 1",
    line2: null,
    city: "Berlin",
    postalCode: "10115",
    state: null,
    countryLabel: "Deutschland",
  },
  accountOrderUrl: null,
};

const ITEMS = [
  { productName: "GLOA Matcha", variantLabel: "30 g", quantity: 1, unitGrossCents: 1999, lineGrossCents: 1999 },
];

test("order confirmation email: subject contains the order number", () => {
  const { subject } = buildOrderConfirmationEmail({ order: BASE_ORDER, items: ITEMS, customerEmail: "max@example.com" });
  assert.match(subject, /GLOA-2026-000123/);
  assert.match(subject, /bestätigt/i);
});

test("order confirmation email: items are rendered in both HTML and text", () => {
  const { html, text } = buildOrderConfirmationEmail({ order: BASE_ORDER, items: ITEMS, customerEmail: "max@example.com" });
  assert.match(html, /GLOA Matcha/);
  assert.match(html, /30 g/);
  assert.match(html, /19,99/);
  assert.match(text, /GLOA Matcha/);
  assert.match(text, /30 g/);
  assert.match(text, /19,99/);
});

test("order confirmation email: a real paid shipping amount is shown", () => {
  const { html, text } = buildOrderConfirmationEmail({ order: BASE_ORDER, items: ITEMS, customerEmail: "max@example.com" });
  assert.match(html, /5,90\s*€/);
  assert.match(text, /Versand: 5,90 €/);
  assert.match(html, /25,89/);
  assert.match(text, /Gesamt: 25,89 €/);
});

test("order confirmation email: free shipping (0) renders as 'Kostenlos', not hidden or faked", () => {
  const order = { ...BASE_ORDER, shipping_gross_cents: 0, total_gross_cents: 1999 };
  const { html, text } = buildOrderConfirmationEmail({ order, items: ITEMS, customerEmail: "max@example.com" });
  assert.match(html, /Kostenlos/);
  assert.match(text, /Versand: Kostenlos/);
  assert.doesNotMatch(html, />0,00\s*€</);
});

test("order confirmation email: an unknown (null) shipping amount is never faked as a value - the line is omitted", () => {
  const order = { ...BASE_ORDER, shipping_gross_cents: null };
  const { html, text } = buildOrderConfirmationEmail({ order, items: ITEMS, customerEmail: "max@example.com" });
  assert.doesNotMatch(html, />Versand</);
  assert.doesNotMatch(text, /Versand:/);
  // Subtotal/total must still render regardless.
  assert.match(html, /Zwischensumme/);
  assert.match(text, /Gesamt:/);
});

test("order confirmation email: no tax line is ever shown, and NULL tax is never displayed as a fake 0", () => {
  const { html, text } = buildOrderConfirmationEmail({ order: BASE_ORDER, items: ITEMS, customerEmail: "max@example.com" });
  assert.doesNotMatch(html, /MwSt|Steuer|VAT|tax/i);
  assert.doesNotMatch(text, /MwSt|Steuer|VAT|tax/i);
});

test("order confirmation email: shipping address is rendered with the customer-facing country label, not the raw ISO code", () => {
  const { html, text } = buildOrderConfirmationEmail({ order: BASE_ORDER, items: ITEMS, customerEmail: "max@example.com" });
  assert.match(html, /Deutschland/);
  assert.match(text, /Deutschland/);
  assert.doesNotMatch(html, />DE</);
});

test("order confirmation email: a missing shipping address renders no address section and does not crash", () => {
  const order = { ...BASE_ORDER, shippingAddress: null };
  const { html, text } = buildOrderConfirmationEmail({ order, items: ITEMS, customerEmail: "max@example.com" });
  assert.doesNotMatch(html, /Lieferadresse/);
  assert.doesNotMatch(text, /Lieferadresse/);
});

test("order confirmation email: line1 is rendered as-is, never split into street/house number", () => {
  const { html } = buildOrderConfirmationEmail({ order: BASE_ORDER, items: ITEMS, customerEmail: "max@example.com" });
  assert.match(html, /Musterstraße 1/);
});

test("order confirmation email: contains no internal IDs (checkout attempt, Stripe ids) - the order type itself never carries order.id/user_id", () => {
  const { html, text } = buildOrderConfirmationEmail({ order: BASE_ORDER, items: ITEMS, customerEmail: "max@example.com" });
  for (const output of [html, text]) {
    assert.doesNotMatch(output, /cs_[a-zA-Z0-9]/, "no Stripe checkout session id");
    assert.doesNotMatch(output, /pi_[a-zA-Z0-9]/, "no Stripe payment intent id");
    assert.doesNotMatch(output, /checkout_attempt/i);
    assert.doesNotMatch(output, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, "no stray UUID");
  }
});

test("order confirmation email: an account link is rendered exactly when the caller provides accountOrderUrl (guest orders get none)", () => {
  const guestOrder = { ...BASE_ORDER, accountOrderUrl: null };
  const guestEmail = buildOrderConfirmationEmail({ order: guestOrder, items: ITEMS, customerEmail: "max@example.com" });
  assert.doesNotMatch(guestEmail.html, /Konto/);
  assert.doesNotMatch(guestEmail.text, /Konto/);

  const authOrder = { ...BASE_ORDER, accountOrderUrl: "https://gloamatcha.com/account/orders/33333333-3333-3333-3333-333333333333" };
  const authEmail = buildOrderConfirmationEmail({ order: authOrder, items: ITEMS, customerEmail: "max@example.com" });
  assert.match(authEmail.html, /gloamatcha\.com\/account\/orders\/33333333-3333-3333-3333-333333333333/);
  assert.match(authEmail.text, /gloamatcha\.com\/account\/orders\/33333333-3333-3333-3333-333333333333/);
});

test("order confirmation email: HTML-unsafe content in the address is escaped, never injected as markup", () => {
  const order = {
    ...BASE_ORDER,
    shippingAddress: { ...BASE_ORDER.shippingAddress, name: "<script>alert(1)</script>" },
  };
  const { html, text } = buildOrderConfirmationEmail({ order, items: ITEMS, customerEmail: "max@example.com" });
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /&lt;script&gt;/);
  // Plain text has no escaping concept - literal text is fine and expected.
  assert.match(text, /<script>alert\(1\)<\/script>/);
});

test("order confirmation email: plain text version contains all essential order information", () => {
  const { text } = buildOrderConfirmationEmail({ order: BASE_ORDER, items: ITEMS, customerEmail: "max@example.com" });
  assert.match(text, /GLOA-2026-000123/);
  assert.match(text, /GLOA Matcha/);
  assert.match(text, /30 g/);
  assert.match(text, /Zwischensumme: 19,99 €/);
  assert.match(text, /Versand: 5,90 €/);
  assert.match(text, /Gesamt: 25,89 €/);
  assert.match(text, /Deutschland/);
  // support@, matching the Reply-To the sender sets. Inside one
  // transactional email, telling the customer to write to one mailbox
  // while their reply goes to another contradicts itself. The site's
  // published info@ address is a separate, later cleanup.
  assert.match(text, /support@gloamatcha\.com/);
  assert.ok(!/info@gloamatcha\.com/.test(text), "the footer disagrees with Reply-To");
});

test("order confirmation email: multiple items are all rendered", () => {
  const items = [
    { productName: "GLOA Matcha", variantLabel: "30 g", quantity: 1, unitGrossCents: 1999, lineGrossCents: 1999 },
    { productName: "GLOA Matcha", variantLabel: "50 g", quantity: 2, unitGrossCents: 2999, lineGrossCents: 5998 },
  ];
  const order = { ...BASE_ORDER, subtotal_gross_cents: 7997, total_gross_cents: 8587 };
  const { html, text } = buildOrderConfirmationEmail({ order, items, customerEmail: "max@example.com" });
  assert.match(html, /30 g/);
  assert.match(html, /50 g/);
  assert.match(text, /30 g/);
  assert.match(text, /50 g/);
});
