"use client";
import type { CartItem } from "./cart";

export type CheckoutQuoteItem = {
  productId: string;
  productName: string;
  productSlug: string;
  variantId: string;
  sku: string;
  label: string;
  /** Net weight in grams, or null for a product not sold by weight. */
  sizeGrams: number | null;
  quantity: number;
  unitGrossCents: number; // AUTHORITATIVE price from server
  lineGrossCents: number;
};

/**
 * What GLOALAUNCH10 is worth on THIS basket, as the server worked it
 * out. The browser sends the code string and is told cents; it computes
 * no money of its own, and the checkout re-derives every figure from
 * the frozen attempt anyway.
 */
export type CheckoutQuoteDiscount =
  | {
      applied: true;
      code: string;
      percent: number;
      eligibleSubtotalGrossCents: number;
      discountGrossCents: number;
      discountedSubtotalGrossCents: number;
    }
  | { applied: false; message: string };

export type CheckoutQuote = {
  currency: string;
  items: CheckoutQuoteItem[];
  subtotalGrossCents: number;
  /** Present only when a code was sent with the request. */
  discount?: CheckoutQuoteDiscount;
};

/**
 * Request an authoritative checkout quote from the server.
 *
 * IMPORTANT: This function sends ONLY variantId and quantity to the server.
 * The server determines all prices from the database.
 * Client-supplied prices (e.g., from cart.unitPriceCents) are NEVER trusted for checkout.
 */
export async function requestCheckoutQuote(
  cartItems: CartItem[],
  options?: { discountCode?: string }
): Promise<CheckoutQuote> {
  // Send only variant IDs, quantities and - when the customer typed one
  // - the raw code STRING. Never an amount, a percent, an eligibility
  // flag or a line allocation: the server decides all of those and
  // reads none of them from here.
  const payload = {
    items: cartItems.map(item => ({
      variantId: item.variantId,
      quantity: item.quantity,
    })),
    ...(options?.discountCode ? { discountCode: options.discountCode } : {}),
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
