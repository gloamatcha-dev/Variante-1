import assert from "node:assert/strict";
import test from "node:test";
import { buildShipmentConfirmationEmail } from "../lib/email/shipmentConfirmation.ts";

// SAFE DEFAULT SUITE: pure template tests. Resend remains paused - this
// file builds strings only and never contacts an email provider.

const ADDRESS = {
  name: "Max Mustermann",
  company: null,
  line1: "Musterstraße 1",
  line2: null,
  city: "Berlin",
  postalCode: "10115",
  state: null,
  countryLabel: "Deutschland",
};

const build = (over = {}) =>
  buildShipmentConfirmationEmail({
    customerEmail: "max@example.com",
    order: {
      order_number: "GLOA-2026-000123",
      shippingAddress: ADDRESS,
      tracking: { carrier: "DHL", trackingNumber: "00340434161094042557", trackingUrl: "https://tracking.example.com/xyz" },
      accountOrderUrl: "https://gloamatcha.com/account/orders/abc",
      ...over,
    },
  });

test("shipment email: subject names the order and says it is on its way", () => {
  const { subject } = build();
  assert.equal(subject, "Deine GLOA Bestellung ist unterwegs – GLOA-2026-000123");
});

test("shipment email: renders order number, tracking and address", () => {
  const { html, text } = build();
  for (const output of [html, text]) {
    assert.ok(output.includes("GLOA-2026-000123"));
    assert.ok(output.includes("DHL"));
    assert.ok(output.includes("00340434161094042557"));
    assert.ok(output.includes("https://tracking.example.com/xyz"));
    assert.ok(output.includes("Musterstraße 1"));
    assert.ok(output.includes("info@gloamatcha.com"));
  }
});

test("shipment email: no tracking block at all when there is no tracking", () => {
  const { html, text } = build({ tracking: null });
  for (const output of [html, text]) {
    assert.ok(!output.includes("Sendungsnummer"));
    assert.ok(!output.includes("Versanddienst"));
    assert.ok(!output.includes("Sendung verfolgen"));
    // The core message still works without tracking.
    assert.ok(output.includes("GLOA-2026-000123"));
  }
});

test("shipment email: an unknown carrier is omitted, never guessed from the number", () => {
  const { html, text } = build({
    tracking: { carrier: null, trackingNumber: "00340434161094042557", trackingUrl: null },
  });
  for (const output of [html, text]) {
    assert.ok(output.includes("00340434161094042557"));
    assert.ok(!output.includes("Versanddienst"));
    for (const carrier of ["DHL", "UPS", "DPD", "Hermes", "GLS", "FedEx"]) {
      assert.ok(!output.includes(carrier), `invented carrier: ${carrier}`);
    }
  }
});

test("shipment email: no tracking URL is fabricated when none is stored", () => {
  const { html, text } = build({
    tracking: { carrier: "DHL", trackingNumber: "00340434161094042557", trackingUrl: null },
  });
  for (const output of [html, text]) {
    assert.ok(!output.includes("Sendung verfolgen"));
    assert.ok(!/https?:\/\/[^\s"]*dhl/i.test(output), "fabricated a carrier URL");
  }
  assert.ok(!html.includes('<a href="https://tracking'));
});

test("shipment email: the tracking link opens safely", () => {
  const { html } = build();
  assert.match(html, /rel="noopener noreferrer"/);
});

test("shipment email: no address block when the address is unknown", () => {
  const { html, text } = build({ shippingAddress: null });
  assert.ok(!html.includes("Lieferadresse"));
  assert.ok(!text.includes("Lieferadresse"));
});

test("shipment email: the account link is omitted for a guest order", () => {
  const { html, text } = build({ accountOrderUrl: null });
  assert.ok(!html.includes("Bestellung in deinem Konto ansehen"));
  assert.ok(!text.includes("Bestellung in deinem Konto ansehen"));
});

test("shipment email: hostile values are escaped, not injected", () => {
  const { html } = build({
    order_number: '"><script>alert(1)</script>',
    tracking: { carrier: '<img src=x onerror=alert(1)>', trackingNumber: "A&B", trackingUrl: 'https://x.example.com/"onmouseover="alert(1)' },
  });
  assert.ok(!html.includes("<script>"));
  assert.ok(!html.includes("<img src=x"));
  assert.ok(html.includes("&amp;"));
  assert.ok(!/href="[^"]*"onmouseover/.test(html));
});

test("shipment email: carries the GLOA brand colours and no gradients", () => {
  const { html } = build();
  assert.ok(html.includes("#1746D1"));
  assert.ok(html.includes("#F5EBE2"));
  assert.ok(html.includes("#4F3A5B"));
  assert.ok(!/gradient/i.test(html));
});

test("shipment email: never contains an internal identifier", () => {
  // The input type carries no ids at all, so the template has nothing to
  // leak. accountOrderUrl is omitted here because it is a caller-built
  // link the customer is meant to follow, not something this module
  // assembles from an id.
  const { html, text } = build({ accountOrderUrl: null });
  for (const output of [html, text]) {
    assert.ok(!/\bpi_[A-Za-z0-9]/.test(output));
    assert.ok(!/\bcs_(test|live)_/.test(output));
    assert.ok(!/\bevt_/.test(output));
    assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.test(output));
  }
});
