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
 */
export async function createCheckoutSession(
  cartItems: CartItem[],
  requestId: string,
  shippingCountry: string,
  accessToken?: string | null
): Promise<CheckoutSession> {
  const payload = {
    items: cartItems.map(item => ({
      variantId: item.variantId,
      quantity: item.quantity,
    })),
    requestId,
    shippingCountry,
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
