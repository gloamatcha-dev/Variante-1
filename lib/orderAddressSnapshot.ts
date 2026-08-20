import type Stripe from "stripe";

export type AddressSnapshot = {
  name: string | null;
  company: string | null;
  line1: string | null;
  line2: string | null;
  city: string | null;
  postalCode: string | null;
  state: string | null;
  country: string | null;
};

function fromStripeAddress(address: Stripe.Address | null | undefined) {
  return {
    line1: address?.line1 ?? null,
    line2: address?.line2 ?? null,
    city: address?.city ?? null,
    postalCode: address?.postal_code ?? null,
    state: address?.state ?? null,
    country: address?.country ?? null,
  };
}

/**
 * Builds the shipping address snapshot from a verified Stripe Checkout
 * Session - null if the customer didn't provide one (shipping address
 * collection is not enabled yet, or was skipped). Stores Stripe's address
 * shape as-is: line1 is never parsed/guessed into street + house number,
 * since that split isn't reliably derivable from a single address line.
 */
export function buildShippingAddressSnapshot(session: Stripe.Checkout.Session): AddressSnapshot | null {
  const details = session.collected_information?.shipping_details;
  if (!details?.address) return null;

  return {
    name: details.name ?? null,
    company: null,
    ...fromStripeAddress(details.address),
  };
}

/**
 * Builds the billing address snapshot from a verified Stripe Checkout
 * Session - null if Stripe didn't collect/return a billing address for
 * this session (never forced; only used when actually present).
 */
export function buildBillingAddressSnapshot(session: Stripe.Checkout.Session): AddressSnapshot | null {
  const details = session.customer_details;
  if (!details?.address) return null;

  return {
    name: details.name ?? null,
    company: details.business_name ?? null,
    ...fromStripeAddress(details.address),
  };
}
