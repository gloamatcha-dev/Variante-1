"use client";
import type { CartItem } from "./cart";

export type CheckoutQuoteItem = {
  productId: string;
  variantId: string;
  sku: string;
  label: string;
  sizeGrams: number;
  quantity: number;
  unitGrossCents: number; // AUTHORITATIVE price from server
  lineGrossCents: number;
};

export type CheckoutQuote = {
  currency: string;
  items: CheckoutQuoteItem[];
  subtotalGrossCents: number;
};

/**
 * Request an authoritative checkout quote from the server.
 *
 * IMPORTANT: This function sends ONLY variantId and quantity to the server.
 * The server determines all prices from the database.
 * Client-supplied prices (e.g., from cart.unitPriceCents) are NEVER trusted for checkout.
 */
export async function requestCheckoutQuote(
  cartItems: CartItem[]
): Promise<CheckoutQuote> {
  // Send only variant IDs and quantities - server determines prices
  const payload = {
    items: cartItems.map(item => ({
      variantId: item.variantId,
      quantity: item.quantity,
    })),
  };

  const response = await fetch("/api/checkout/quote", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: "Unbekannter Fehler" }));
    throw new Error(error.error || "Quote konnte nicht erstellt werden.");
  }

  return response.json();
}
