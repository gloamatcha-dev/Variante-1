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
 */
export async function createCheckoutSession(
  cartItems: CartItem[],
  requestId: string
): Promise<CheckoutSession> {
  const payload = {
    items: cartItems.map(item => ({
      variantId: item.variantId,
      quantity: item.quantity,
    })),
    requestId,
  };

  const response = await fetch("/api/checkout/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: "Unbekannter Fehler" }));
    throw new Error(error.error || "Checkout konnte nicht gestartet werden.");
  }

  return response.json();
}
