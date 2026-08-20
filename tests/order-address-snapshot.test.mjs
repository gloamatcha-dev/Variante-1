import assert from "node:assert/strict";
import test from "node:test";
import { buildShippingAddressSnapshot, buildBillingAddressSnapshot } from "../lib/orderAddressSnapshot.ts";

// Synthetic test data only - never a real person's address.
const SYNTHETIC_ADDRESS = {
  line1: "Musterstraße 1",
  line2: "Hinterhaus",
  city: "Berlin",
  postal_code: "10115",
  state: null,
  country: "DE",
};

function sessionWithShipping(shippingDetails) {
  return {
    collected_information: shippingDetails ? { shipping_details: shippingDetails } : null,
    customer_details: null,
  };
}

function sessionWithCustomerDetails(customerDetails) {
  return {
    collected_information: null,
    customer_details: customerDetails,
  };
}

test("buildShippingAddressSnapshot: maps a real Stripe shipping address without inventing fields", () => {
  const session = sessionWithShipping({ name: "Max Mustermann", address: SYNTHETIC_ADDRESS });
  const snapshot = buildShippingAddressSnapshot(session);
  assert.deepEqual(snapshot, {
    name: "Max Mustermann",
    company: null,
    line1: "Musterstraße 1",
    line2: "Hinterhaus",
    city: "Berlin",
    postalCode: "10115",
    state: null,
    country: "DE",
  });
});

test("buildShippingAddressSnapshot: never splits line1 into street + house number", () => {
  const session = sessionWithShipping({ name: "Max Mustermann", address: { ...SYNTHETIC_ADDRESS, line1: "Musterstraße 1a" } });
  const snapshot = buildShippingAddressSnapshot(session);
  assert.equal(snapshot.line1, "Musterstraße 1a");
  assert.ok(!("street" in snapshot));
  assert.ok(!("house_number" in snapshot));
  assert.ok(!("houseNumber" in snapshot));
});

test("buildShippingAddressSnapshot: no collected_information yields null (shipping collection not enabled/used)", () => {
  assert.equal(buildShippingAddressSnapshot(sessionWithShipping(null)), null);
});

test("buildShippingAddressSnapshot: collected_information present but shipping_details null yields null", () => {
  const session = { collected_information: { shipping_details: null }, customer_details: null };
  assert.equal(buildShippingAddressSnapshot(session), null);
});

test("buildShippingAddressSnapshot: shipping_details without an address yields null", () => {
  const session = { collected_information: { shipping_details: { name: "Max Mustermann", address: null } }, customer_details: null };
  assert.equal(buildShippingAddressSnapshot(session), null);
});

test("buildBillingAddressSnapshot: maps a real Stripe customer address including business_name as company", () => {
  const session = sessionWithCustomerDetails({
    name: "Erika Musterfrau",
    business_name: "Muster GmbH",
    email: "erika@example.invalid",
    address: SYNTHETIC_ADDRESS,
  });
  const snapshot = buildBillingAddressSnapshot(session);
  assert.deepEqual(snapshot, {
    name: "Erika Musterfrau",
    company: "Muster GmbH",
    line1: "Musterstraße 1",
    line2: "Hinterhaus",
    city: "Berlin",
    postalCode: "10115",
    state: null,
    country: "DE",
  });
});

test("buildBillingAddressSnapshot: no customer_details.address yields null - never fabricated", () => {
  assert.equal(buildBillingAddressSnapshot(sessionWithCustomerDetails({ name: "Erika Musterfrau", address: null })), null);
  assert.equal(buildBillingAddressSnapshot(sessionWithCustomerDetails(null)), null);
});
