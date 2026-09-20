"use client";
import type { CartItem } from "./cart";

export type CheckoutSession = {
  sessionId: string;
  url: string;
};

/**
 * Requests a Stripe Checkout Session from the server.
 *
 * IMPORTANT: This function sends ONLY variantId, quantity, and a client
 * generated requestId (idempotency key, not a price source). The server
 * builds an authoritative quote from Supabase and rejects any client-
 * supplied price data.
 *
 * accessToken (if the customer is signed in) lets the server link the
 * checkout attempt to the authenticated account after re-verifying it -
 * this function never sends a user id directly.
 *
 * shippingCountry is the customer's chosen delivery country (ISO code,
 * e.g. "DE"). The server independently validates it and computes the
 * shipping zone/price/free-shipping eligibility itself - this function
 * never sends a zone, price, or free-shipping flag.
 *
 * email is the address the customer typed, sent RAW. The server
 * normalizes it, validates it, and resolves it to a Stripe Customer
 * itself - so this function never sends a normalized form, a customer
 * key, a Stripe Customer id or anything else that would let a browser
 * nominate an identity. The same rule as prices: the client says what it
 * wants, the server decides what that means.
 *
 * discountCode is the same rule again, and the last place it could have
 * been broken. The browser sends the STRING the customer typed and
 * nothing else - no discount cents, no percent, no eligibility verdict,
 * no line allocation. The server normalizes the code, checks the
 * window, filters the basket to the eligible SKUs, computes the
 * discount and freezes it on the checkout attempt. A browser that could
 * send any of those could name its own price.
 */
export async function createCheckoutSession(
  cartItems: CartItem[],
  requestId: string,
  shippingCountry: string,
  email: string,
  accessToken?: string | null,
  discountCode?: string | null
): Promise<CheckoutSession> {
  const payload = {
    items: cartItems.map(item => ({
      variantId: item.variantId,
      quantity: item.quantity,
    })),
    requestId,
    shippingCountry,
    email,
    ...(discountCode ? { discountCode } : {}),
  };

  const response = await fetch("/api/checkout/session", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: "Unbekannter Fehler" }));
    throw new Error(error.error || "Checkout konnte nicht gestartet werden.");
  }

  return response.json();
}
